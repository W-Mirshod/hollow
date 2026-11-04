const {test,expect}=require('@playwright/test');

let errors=[];
test.beforeEach(({page})=>{
  errors=[];page.on('pageerror',error=>errors.push(error.message));
});
test.afterEach(()=>expect(errors,'No opening-screen runtime errors').toEqual([]));

const viewports=[{width:1280,height:800},{width:390,height:844},{width:320,height:568},{width:844,height:390}];

async function ready(page,name,scores,settings){
  await page.addInitScript(({name,scores,settings})=>{
    if(name)localStorage.setItem('hollow.playerName',name);
    if(scores)localStorage.setItem('hollow.scores',JSON.stringify(scores));
    localStorage.setItem('hollow.settings',JSON.stringify({quality:'low',motion:false,effects:false,volume:0,sensitivity:1,...settings}));
  },{name,scores,settings});
  await page.goto('/');await page.waitForFunction(()=>!!window.HollowGame);
}

async function expectMenuLayout(page,viewport){
  await page.setViewportSize(viewport);
  const menu=page.locator('#menu'),board=menu.locator('.scores-detail .board');
  await menu.evaluate(node=>node.scrollTop=0);
  await expect(menu.locator('aside.scores-detail')).toBeVisible();
  // Visibility must not depend on expanding anything; mobile boards may be below the fold.
  await expect(board).toBeVisible();
  await expect(menu.locator('.menu-foot .who #whoName')).toBeVisible();
  await expect(menu.locator('.menu-foot .who #changeName')).toHaveAccessibleName('Change player name');
  await expect(menu.locator('.menu-list button')).toHaveText(['Play','Multiplay','How to play']);
  await expect(menu.getByRole('button',{name:'Story',exact:true})).toHaveCount(0);
  for(const [id,name] of [['startDarkBtn','Play'],['coopBtn','Multiplay'],['howToBtn','How to play']]){
    const action=menu.getByRole('button',{name,exact:true});
    await expect(action).toHaveAttribute('id',id);
    await expect(action).toBeInViewport({ratio:1});
  }
  await expect.poll(()=>menu.evaluate(node=>node.scrollWidth<=node.clientWidth+1),
    {message:'No horizontal menu overflow at '+viewport.width+'x'+viewport.height}).toBe(true);
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),
    {message:'No horizontal page overflow at '+viewport.width+'x'+viewport.height}).toBe(true);
  if(viewport.width===1280){
    await expect(board).toBeInViewport();
    await expect(menu.locator('.menu-foot')).toBeInViewport({ratio:1});
    await expect.poll(async()=>{
      const foot=await menu.locator('.menu-foot').boundingBox(),actions=await menu.locator('.menu-list').boundingBox();
      return !!foot&&!!actions&&foot.y>=actions.y+actions.height;
    },{message:'Player line sits below the desktop actions'}).toBe(true);
    await expect.poll(async()=>{
      const box=await board.boundingBox(),title=await menu.locator('#menuTitle').boundingBox();
      return !!box&&!!title&&box.x>=viewport.width/2&&box.x>title.x&&box.x+box.width<=viewport.width+1&&box.y>=0&&box.y<viewport.height/2;
    },{message:'Desktop leaderboard sits in the upper-right'}).toBe(true);
  }
}

test('menu keeps actions in view, leaderboard visible and help in a dialog across viewports',async({page})=>{
  await page.route('**/api/scores',route=>route.fulfill({json:[]}));
  await ready(page,'Menu QA');
  const help=page.locator('#howTo'),opener=page.locator('#howToBtn'),board=page.locator('#menu .scores-detail .board');
  await expect(board.locator('.boardScope')).toHaveText('All players');
  await expect(board.locator('h2')).toHaveText('Scoreboard');
  await expect(board.locator('.empty')).toContainText('No scores yet');
  for(const viewport of viewports){
    await expectMenuLayout(page,viewport);
    await expect(help).toBeHidden();
    await expect(page.locator('#menu .keys')).toBeHidden();
    if(viewport.width===1280)await page.screenshot({path:'artifacts/opening-menu-desktop.png'});
    if(viewport.width===390)await page.screenshot({path:'artifacts/opening-menu-phone.png'});
  }
  await page.setViewportSize({width:1280,height:800});
  await opener.focus();await page.keyboard.press('Enter');
  await expect(help).toBeVisible();await expect(help).toHaveJSProperty('open',true);
  await expect(help.locator('.keys')).toBeVisible();await expect(help.locator('.rules')).toContainText('three fuses');
  await page.keyboard.press('Escape');await expect(help).toBeHidden();await expect(opener).toBeFocused();
  await opener.click();await expect(help).toBeVisible();
  await page.mouse.click(8,8);await expect(help).toBeHidden();
  await opener.click();await expect(help).toBeVisible();
  await help.getByRole('button',{name:'Close',exact:true}).click();await expect(help).toBeHidden();
  await expect(board).toBeVisible();
});

// Alpha of the torch's darkness layer at a viewport point: low inside the beam, near-opaque outside.
const shade=(canvas,x,y)=>canvas.evaluate((node,[x,y])=>node.getContext('2d').getImageData(
  Math.min(node.width-1,Math.floor(x*node.width/innerWidth)),Math.min(node.height-1,Math.floor(y*node.height/innerHeight)),1,1).data[3],[x,y]);

test('torch follows the pointer and shows the watcher',async({page})=>{
  await page.route('**/api/scores',route=>route.fulfill({json:[]}));
  await page.setViewportSize({width:1280,height:800});
  await ready(page,'Torch QA',null,{motion:true,effects:true});
  const canvas=page.locator('#menu .torchlight.live canvas');
  await expect(canvas).toHaveCount(1);
  await expect(page.locator('html')).not.toHaveClass(/calm-entry/);
  await expect(page.locator('#menu .watcher')).toBeVisible();
  await page.mouse.move(980,560,{steps:4});
  await expect.poll(()=>shade(canvas,980,560),{message:'The torch follows the pointer'}).toBeLessThan(60);
  expect(await shade(canvas,40,40)).toBeGreaterThan(150);
  await page.mouse.move(240,200,{steps:4});
  await expect.poll(()=>shade(canvas,240,200)).toBeLessThan(60);
  await expect.poll(()=>shade(canvas,980,560)).toBeGreaterThan(150);
});

test('calm settings keep the torch steady and hide the watcher',async({page})=>{
  await page.route('**/api/scores',route=>route.fulfill({json:[]}));
  await page.setViewportSize({width:1280,height:800});
  await ready(page,'Calm QA');
  const canvas=page.locator('#menu .torchlight.live canvas');
  await expect(page.locator('html')).toHaveClass(/calm-entry/);
  await expect(page.locator('#menu .watcher')).toBeHidden();
  await expect(canvas).toHaveCount(1);
  const title=await page.locator('#menuTitle').boundingBox();
  await expect.poll(()=>shade(canvas,title.x+title.width*.4,title.y+title.height*.4),{message:'The resting light sits on the title'}).toBeLessThan(60);
});

for(const source of ['shared','local fallback']){
  test('populated '+source+' leaderboard and long player name stay responsive',async({page})=>{
    const name='WWWWWWWWWWWWWWWWWW',uid='menu_qa_player';
    const scores=Array.from({length:12},(_,i)=>({
      name:i===11?name:'Runner '+(i+1),time:60+i*10,kills:i%13,at:1700000000000+i,
      uid:i===11?uid:'menu_runner_'+i
    }));
    await page.addInitScript(uid=>localStorage.setItem('hollow.uid',uid),uid);
    await page.route('**/api/scores',route=>source==='shared'
      ?route.fulfill({json:scores.slice().reverse()})
      :route.fulfill({status:503,json:{error:'Scoreboard unavailable'}}));
    await ready(page,name,source==='local fallback'?scores.slice().reverse():[]);
    const board=page.locator('#menu .scores-detail .board'),rows=board.locator('.boardList li:not(.gap)');
    await expect(board.locator('.boardScope')).toHaveText(source==='shared'?'All players':'This browser');
    await expect(page.locator('#whoName')).toHaveText(name);
    await expect(rows).toHaveCount(11);
    await expect(rows.locator('.rk')).toHaveText(['1','2','3','4','5','6','7','8','9','10','12']);
    await expect(rows.first().locator('.nm')).toHaveText('Runner 1');
    await expect(rows.first().locator('.tm')).toHaveText('1:00.0');
    await expect(board.locator('.boardList .gap')).toHaveCount(1);
    await expect(board.locator('.boardList .me .nm')).toHaveText(name);
    await expect(board.locator('.boardList .me .tm')).toHaveText('2:50.0');
    await expect(board.locator('.boardMine')).toHaveText('Your best: #12 of 12 · escaped in 2:50.0');
    if(source==='local fallback'){
      await expect(board.locator('.boardFoot')).toHaveText('Scores are saved on this browser.');
      await expect(page.locator('#menuShare')).toBeVisible();
      await expect(page.locator('#menuCode')).toHaveText(/^HOLLOW-/);
    }
    for(const viewport of viewports)await expectMenuLayout(page,viewport);
  });
}

test('co-op and fallen runs show on the main screen with scores, and both of the player\u2019s bests stay listed',async({page})=>{
  const name='Board QA',uid='menu_board_qa';
  const run=(i,fields)=>({uid:'menu_other_'+i,name:'Player '+i,mode:'solo',partner:'',escaped:false,time:300,kills:0,score:900-(i-3)*50,at:i,...fields});
  const served=[
    run(1,{name:'Alice',mode:'coop',partner:'Bob',escaped:true,time:252.3,kills:6,score:1250}),
    run(2,{name:'Bob',mode:'coop',partner:'Alice',escaped:true,time:252.3,kills:4,score:900}),
    ...Array.from({length:9},(_,i)=>run(3+i,{})),
    {uid,name,mode:'coop',partner:'Alice',escaped:false,time:61.5,kills:1,score:120,at:20},
    {uid,name,mode:'solo',partner:'',escaped:false,time:45,kills:0,score:40,at:21},
    // Another player on this browser is not this player.
    {uid,name:'Sibling',mode:'solo',partner:'',escaped:false,time:20,kills:0,score:10,at:22}
  ];
  await page.addInitScript(uid=>localStorage.setItem('hollow.uid',uid),uid);
  await page.route('**/api/scores',route=>route.fulfill({json:served.slice().reverse()}));
  await ready(page,name);
  const board=page.locator('#menu .scores-detail .board'),rows=board.locator('.boardList li:not(.gap)');
  await expect(board.locator('.boardScope')).toHaveText('All players');
  await expect(rows.locator('.rk')).toHaveText(['1','2','3','4','5','6','7','8','9','10','12','13']);
  await expect(rows.locator('.nm')).toHaveText(['Alice','Bob',...Array.from({length:8},(_,i)=>'Player '+(3+i)),name,name]);
  await expect(rows.locator('.tg')).toHaveText(['co-op','co-op',...Array(8).fill('fell'),'co-op · fell','fell']);
  await expect(rows.locator('.sc')).toHaveText(['1,250','900','900','850','800','750','700','650','600','550','120','40']);
  await expect(rows.first().locator('.tm')).toHaveText('4:12.3');
  await expect(rows.first()).toHaveAttribute('title','Alice: escaped in 4:12.3 · 1,250 pts · co-op with Bob');
  await expect(board.locator('.boardList .gap')).toHaveCount(1);
  await expect(board.locator('.boardList .me .nm')).toHaveText([name,name]);
  await expect(board.locator('.boardMine')).toHaveText('Your best: #12 of 14 · lasted 1:01.5 · 120 pts · co-op with Alice');
  await expect(board.locator('.boardFoot')).toContainText('best solo and a best co-op run');
  for(const viewport of viewports)await expectMenuLayout(page,viewport);
});

test('short name entry, name changes, co-op and immediate entry preserve navigation',async({page})=>{
  await page.setViewportSize({width:390,height:844});await ready(page,null);
  await expect(page.locator('#name')).toBeVisible();await expect(page.locator('#name .board')).toHaveCount(0);
  await expect(page.locator('#nameSave')).toBeInViewport();
  await page.locator('#nameSave').click();await expect(page.locator('#nameErr')).toContainText('at least 2');
  await page.getByLabel('Your name',{exact:true}).fill('New guest');await page.locator('#nameSave').click();
  await expect(page.locator('#menu')).toBeVisible();await expect(page.locator('#whoName')).toHaveText('New guest');
  await page.getByRole('button',{name:'Change player name'}).click();await expect(page.locator('#playerName')).toHaveValue('New guest');
  await page.locator('#nameSave').click();await page.locator('#coopBtn').click();await expect(page.locator('#coop')).toBeVisible();
  await expect(page.locator('#coopCreate')).toBeInViewport({ratio:1});await expect(page.locator('#coopCodeIn')).toBeInViewport({ratio:1});
  await page.locator('#coopBack').click();await expect(page.locator('#menu')).toBeVisible();
  await page.getByRole('button',{name:'Play',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>HollowGame.snapshot().state)).toBe('play');await expect(page.locator('#hud')).toBeVisible();
});
