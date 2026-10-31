const {test,expect}=require('@playwright/test');

let errors=[];
test.beforeEach(({page})=>{
  errors=[];page.on('pageerror',error=>errors.push(error.message));
});
test.afterEach(()=>expect(errors,'No opening-screen runtime errors').toEqual([]));

const viewports=[{width:1280,height:800},{width:390,height:844},{width:320,height:568},{width:844,height:390}];

async function ready(page,name,scores){
  await page.addInitScript(({name,scores})=>{
    if(name)localStorage.setItem('hollow.playerName',name);
    if(scores)localStorage.setItem('hollow.scores',JSON.stringify(scores));
    localStorage.setItem('hollow.settings',JSON.stringify({quality:'low',motion:false,effects:false,volume:0,sensitivity:1}));
  },{name,scores});
  await page.goto('/');await page.waitForFunction(()=>!!window.HollowGame);
}

async function expectMenuLayout(page,viewport){
  await page.setViewportSize(viewport);
  const menu=page.locator('#menu'),board=menu.locator('.scores-detail .board');
  await menu.evaluate(node=>node.scrollTop=0);
  await expect(menu.locator('aside.scores-detail')).toBeVisible();
  // Visibility must not depend on expanding anything; mobile boards may be below the fold.
  await expect(board).toBeVisible();
  await expect(menu.locator('.menu-topbar .who #whoName')).toBeVisible();
  await expect(menu.locator('.menu-topbar .who #changeName')).toHaveAccessibleName('Change player name');
  await expect(menu.locator('.start-actions button')).toHaveCount(2);
    await expect(menu.getByRole('button',{name:'Story',exact:true})).toHaveCount(0);
    for(const [id,name] of [['startDarkBtn','Play'],['coopBtn','Multiplay']]){
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
    await expect.poll(async()=>{
      const topbar=await menu.locator('.menu-topbar').boundingBox(),title=await menu.locator('#menuTitle').boundingBox();
      return !!topbar&&!!title&&topbar.y+topbar.height<=title.y+1;
    },{message:'Player topbar sits above the desktop title'}).toBe(true);
    await expect.poll(async()=>{
      const box=await board.boundingBox(),title=await menu.locator('#menuTitle').boundingBox();
      return !!box&&!!title&&box.x>=viewport.width/2&&box.x>title.x&&box.x+box.width<=viewport.width+1&&box.y>=0&&box.y<viewport.height/2;
    },{message:'Desktop leaderboard sits in the upper-right'}).toBe(true);
  }
}

test('menu keeps actions in view, leaderboard visible and help collapsible across viewports',async({page})=>{
  await page.route('**/api/scores',route=>route.fulfill({json:[]}));
  await ready(page,'Menu QA');
  const help=page.locator('#menu .controls-details'),board=page.locator('#menu .scores-detail .board');
  await expect(board.locator('.boardScope')).toHaveText('All players');
  await expect(board.locator('.empty')).toContainText('Nobody has escaped yet');
  for(const viewport of viewports){
    await expectMenuLayout(page,viewport);
    await expect(help).not.toHaveAttribute('open');
    await expect(page.locator('#menu .keys')).toBeHidden();
    if(viewport.width===1280)await page.screenshot({path:'artifacts/red-menu-desktop.png'});
    if(viewport.width===390)await page.screenshot({path:'artifacts/red-menu-phone.png'});
  }
  await help.locator('summary').focus();await page.keyboard.press('Enter');
  await expect(help).toHaveAttribute('open');
  await expect(page.locator('#menu .keys')).toBeVisible();await expect(help.locator('.rules')).toContainText('three fuses');
  await expect(board).toBeVisible();
  await page.keyboard.press('Enter');await expect(page.locator('#menu .keys')).toBeHidden();
  await expect(help).not.toHaveAttribute('open');await expect(board).toBeVisible();
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
    await expect(board.locator('.boardMine')).toHaveText('Your best: #12 of 12 · 2:50.0');
    if(source==='local fallback'){
      await expect(board.locator('.boardFoot')).toHaveText('Times are saved on this browser.');
      await expect(page.locator('#menuShare')).toBeVisible();
      await expect(page.locator('#menuCode')).toHaveText(/^HOLLOW-/);
    }
    for(const viewport of viewports)await expectMenuLayout(page,viewport);
  });
}

test('short name entry, name changes, co-op and immediate entry preserve navigation',async({page})=>{
  await page.setViewportSize({width:390,height:844});await ready(page,null);
  await expect(page.locator('#name')).toBeVisible();await expect(page.locator('#name .board')).toBeHidden();
  await expect(page.locator('#nameSave')).toBeInViewport();
  await page.locator('#nameSave').click();await expect(page.locator('#nameErr')).toContainText('at least 2');
  await page.getByLabel('Your name',{exact:true}).fill('New guest');await page.locator('#nameSave').click();
  await expect(page.locator('#menu')).toBeVisible();await expect(page.locator('#whoName')).toHaveText('New guest');
  await page.getByRole('button',{name:'Change player name'}).click();await expect(page.locator('#playerName')).toHaveValue('New guest');
  await page.locator('#nameSave').click();await page.locator('#coopBtn').click();await expect(page.locator('#coop')).toBeVisible();
  await page.locator('#coopBack').click();await expect(page.locator('#menu')).toBeVisible();
  await page.getByRole('button',{name:'Play',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>HollowGame.snapshot().state)).toBe('play');await expect(page.locator('#hud')).toBeVisible();
});
