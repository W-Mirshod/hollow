const {test,expect}=require('@playwright/test');

// Every finished run reaches the shared scoreboard on the main screen: solo and co-op, escaped or fallen, with its score.
test.setTimeout(300000);

let diagnosticPages=[];
test.beforeEach(()=>{diagnosticPages=[];});
test.afterEach(()=>{expect(diagnosticPages.flatMap(page=>page.hollowErrors),'No game errors and no rejected scores').toEqual([]);});

// Fresh identities, so a reused QA server never holds an older best for these players.
const run=Date.now().toString(36);

async function ready(page,name,uid){
  page.hollowErrors=[];diagnosticPages.push(page);
  page.on('pageerror',error=>page.hollowErrors.push(error.message));
  page.on('console',message=>{const text=message.text();if((message.type()==='error'&&/WebGL|WebGPU|WGSL|shader|GL_INVALID|Startup failed/.test(text))||/ - While (?:calling|validating|encoding|finishing|creating)|\[Invalid [A-Z]/.test(text))page.hollowErrors.push(text);});
  page.on('response',response=>{if(response.request().method()==='POST'&&/\/api\/scores$/.test(response.url())&&!response.ok())page.hollowErrors.push('score rejected: '+response.status());});
  await page.addInitScript(({name,uid})=>{
    localStorage.setItem('hollow.playerName',name);localStorage.setItem('hollow.uid',uid);
    localStorage.setItem('hollow.settings',JSON.stringify({quality:'low',motion:false,sensitivity:1,volume:0}));
  },{name,uid});
  await page.goto('/?qa=1');await page.waitForFunction(()=>!!window.HollowTest);
}
const state=async page=>(await page.evaluate(()=>HollowGame.snapshot())).state;
async function until(check,timeout){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return true;await new Promise(done=>setTimeout(done,250));}return false;}
async function scores(page){const response=await page.request.get('/api/scores');expect(response.ok()).toBe(true);return response.json();}

// The board's formatting (public/game.js fmtTime, fmtScore, runSummary and the row tag).
const fmtTime=sec=>{const m=Math.floor(sec/60),s=sec-m*60;return m+':'+(s<10?'0':'')+s.toFixed(1);};
const fmtScore=n=>String(n).replace(/\B(?=(\d{3})+(?!\d))/g,',');
const tag=r=>[r.mode==='coop'?'co-op':'',r.escaped?'':'fell'].filter(Boolean).join(' · ');
const summary=r=>[(r.escaped?'escaped in ':'lasted ')+fmtTime(r.time),r.score?fmtScore(r.score)+' pts':'',r.mode==='coop'?'co-op'+(r.partner?' with '+r.partner:''):''].filter(Boolean).join(' · ');

// A board lists what the server ranks: the top ten, then the player's own best runs below a gap.
async function expectBoard(board,api,uid){
  const ranked=api.map((r,i)=>({...r,rank:i+1})),mine=ranked.filter(r=>r.uid===uid);
  const listed=[...ranked.slice(0,10),...mine.filter(r=>r.rank>10)],rows=board.locator('.boardList li:not(.gap)');
  await expect(board.locator('.boardScope')).toHaveText('All players');
  await expect(rows.locator('.rk')).toHaveText(listed.map(r=>String(r.rank)));
  await expect(rows.locator('.nm')).toHaveText(listed.map(r=>r.name));
  await expect(rows.locator('.tg')).toHaveText(listed.map(tag));
  await expect(rows.locator('.sc')).toHaveText(listed.map(r=>fmtScore(r.score)));
  await expect(rows.locator('.tm')).toHaveText(listed.map(r=>fmtTime(r.time)));
  await expect(board.locator('.boardList .gap')).toHaveCount(listed.length>10?1:0);
  await expect(board.locator('.boardList .me .nm')).toHaveText(mine.map(r=>r.name));
  await expect(board.locator('.boardMine')).toHaveText(`Your best: #${mine[0].rank} of ${api.length} · ${summary(mine[0])}`);
}

// A stalker bites the solo survivor on one health point; the caught sequence then plays out on real frames.
async function soloDeath(page){
  expect(await page.evaluate(()=>{
    HollowTest.health(1);HollowTest.pose({x:45,z:55,yaw:Math.PI});HollowTest.enemy(1,{x:45,z:54,state:'chase',yaw:0});
    HollowTest.advance(.2);return HollowGame.snapshot().state;
  })).toBe('caught');
  await expect.poll(()=>state(page),{timeout:90000}).toBe('dead');
}

test('a solo run that ends in the ward goes on the main-screen scoreboard with its score, and only a better run replaces it',async({page})=>{
  const name='Solo Scorer',uid='scores_solo_'+run;
  await ready(page,name,uid);
  await page.locator('#startDarkBtn').click();await expect.poll(()=>state(page)).toBe('play');
  // A shotgun headshot on a crawler 3.5 m down the central hall (tests/dopamine.spec.js) earns points.
  const kill=await page.evaluate(()=>{
    const T=HollowTest,G=HollowGame,x=45,z=55,crawlerZ=51.5;
    // A run starts with the sidearm alone: hand over the full kit, carbine drawn, then switch to the shotgun.
    T.silence();T.torch(false);T.arm();
    T.action('weapon',true);T.action('weapon',true);T.action('aim',true);T.advance(.3);
    T.pose({x,z,yaw:0,pitch:0});const eye=G.snapshot().position.y+1.6;
    T.pose({x,z,yaw:0,pitch:Math.atan((.72-eye)/(z-crawlerZ-.43))});
    T.enemy(2,{x,z:crawlerZ,state:'wander',yaw:0});
    T.action('fire',true);T.advance(.05);T.action('fire',false);T.action('aim',false);T.silence();
    const s=G.snapshot();return {weapon:s.weapon,dead:s.enemies[2].dead,points:s.streak.points,kills:s.streak.kills};
  });
  expect(kill).toMatchObject({weapon:'shotgun',dead:true,kills:1});expect(kill.points).toBeGreaterThan(0);

  await soloDeath(page);
  await expect(page.locator('#dead')).toBeVisible();
  await expect(page.locator('#deadRank')).toHaveText(`Score ${fmtScore(kill.points)}. New personal best, posted to the board.`);
  const api=await scores(page),best=api.find(r=>r.uid===uid);
  expect(best).toMatchObject({name,mode:'solo',partner:'',escaped:false,score:kill.points,kills:1});
  expect(best.time).toBeGreaterThan(0);
  await expectBoard(page.locator('#dead .board'),api,uid);
  await page.locator('#deadMenuBtn').click();await expect(page.locator('#menu')).toBeVisible();
  await expectBoard(page.locator('#menu .scores-detail .board'),api,uid);

  // A run without points leaves the board alone, and the result screen names the best run that still stands.
  await page.locator('#startDarkBtn').click();await expect.poll(()=>state(page)).toBe('play');
  await page.evaluate(()=>HollowTest.silence());
  await soloDeath(page);
  await expect(page.locator('#deadRank')).toHaveText(`Score 0. Your best run is still: ${summary(best)}.`);
  const after=await scores(page);
  expect(after.find(r=>r.uid===uid)).toEqual(best);
  await expectBoard(page.locator('#dead .board'),after,uid);
});

test('both co-op partners’ runs go on the scoreboard, marked co-op with each other’s names, on the end screen and the main screen',async({browser})=>{
  test.setTimeout(600000);
  const host={name:'Coop Host',uid:'scores_host_'+run},guest={name:'Coop Guest',uid:'scores_guest_'+run};
  const hostContext=await browser.newContext({viewport:{width:900,height:600}}),guestContext=await browser.newContext({viewport:{width:900,height:600}});
  const hostPage=await hostContext.newPage(),guestPage=await guestContext.newPage();
  try{
    await ready(hostPage,host.name,host.uid);await ready(guestPage,guest.name,guest.uid);
    await hostPage.locator('#coopBtn').click();await hostPage.locator('#coopCreate').click();await expect(hostPage.locator('#coopLobby')).toBeVisible();
    const code=await hostPage.locator('#coopCode').textContent();
    await guestPage.locator('#coopBtn').click();await guestPage.locator('#coopCodeIn').fill(code);await guestPage.locator('#coopJoinForm button').click();
    await expect(hostPage.locator('#coopStart')).toBeEnabled();await hostPage.locator('#coopStart').click();
    await expect.poll(()=>state(guestPage)).toBe('play');

    // The host scores the same crawler headshot. Co-op rounds only run on real frames, so the monsters hold still meanwhile.
    await hostPage.evaluate(()=>{
      const T=HollowTest,G=HollowGame,x=45,z=55,crawlerZ=51.5;
      T.silence();T.freezeAI(true);T.torch(false);T.arm();
      T.action('weapon',true);T.action('weapon',true);T.action('aim',true);
      T.pose({x,z,yaw:0,pitch:0});const eye=G.snapshot().position.y+1.6;
      T.pose({x,z,yaw:0,pitch:Math.atan((.72-eye)/(z-crawlerZ-.43))});
      T.enemy(2,{x,z:crawlerZ,state:'wander',yaw:0});
      T.action('fire',true);T.action('fire',false);
    });
    await expect.poll(()=>hostPage.evaluate(()=>HollowGame.snapshot().enemies[2].dead),{timeout:90000}).toBe(true);
    const streak=await hostPage.evaluate(()=>{HollowTest.action('aim',false);return HollowGame.snapshot().streak;});
    expect(streak.kills).toBe(1);expect(streak.points).toBeGreaterThan(0);

    // The guest, on one health point, falls to the host's rifle and watches through the host's eyes.
    await hostPage.evaluate(()=>{HollowTest.action('weapon',true);HollowTest.pose({x:45,z:55,yaw:Math.PI});});
    await guestPage.evaluate(()=>{HollowTest.pose({x:45,z:56.6,yaw:0});HollowTest.health(1);});
    let shots=0;
    while(await state(guestPage)!=='spect'){
      expect(shots++,'the host’s rifle reaches the guest within a few shots').toBeLessThan(5);
      // The guest's new position reaches the host over the room first.
      await hostPage.waitForTimeout(800);
      await hostPage.evaluate(()=>{HollowTest.action('fire',true);HollowTest.action('fire',false);});
      await until(async()=>await state(guestPage)==='spect',15000);
    }

    // Then a stalker gets the host: the round is over for both.
    await hostPage.evaluate(()=>{
      HollowTest.health(1);HollowTest.pose({x:45,z:55,yaw:Math.PI});HollowTest.enemy(1,{x:45,z:54,state:'chase',yaw:0});HollowTest.freezeAI(false);
    });
    await expect.poll(()=>state(hostPage),{timeout:120000}).toBe('coopEnd');
    await expect.poll(()=>state(guestPage),{timeout:60000}).toBe('coopEnd');
    for(const [page,score] of [[hostPage,streak.points],[guestPage,0]]){
      await expect(page.locator('#ceTitle')).toHaveText('It found you both');
      await expect(page.locator('#ceRank')).toHaveText(`Score ${fmtScore(score)}. New personal best, posted to the board.`);
    }
    const api=await scores(hostPage);
    expect(api.find(r=>r.uid===host.uid)).toMatchObject({name:host.name,mode:'coop',partner:guest.name,escaped:false,score:streak.points,kills:1});
    expect(api.find(r=>r.uid===guest.uid)).toMatchObject({name:guest.name,mode:'coop',partner:host.name,escaped:false,score:0,kills:0});
    for(const [page,player] of [[hostPage,host],[guestPage,guest]]){
      await expectBoard(page.locator('#coopEnd .board'),api,player.uid);
      await page.locator('#ceLeave').click();await expect(page.locator('#menu')).toBeVisible();
      await expectBoard(page.locator('#menu .scores-detail .board'),api,player.uid);
    }
  }finally{await hostContext.close();await guestContext.close();}
});
