const {test,expect}=require('@playwright/test');

// Above ground: B3's floodgate opens on S1, the Overgrown Garden, whose gate leads into S2, Blackwater Graveyard. S2's
// cemetery gate is chained to a bell: using it raises the Gravekeeper, which holds the gate until it dies. Both floors
// are checkpoints. Screenshots go to artifacts/levels-*.png.
test.setTimeout(420000);
test.use({viewport:{width:1000,height:650}});

let pages=[];
test.beforeEach(()=>{pages=[];});
test.afterEach(()=>expect(pages.flatMap(page=>page.hollowErrors),'No uncaught game or shader errors').toEqual([]));

async function ready(page,quality='low'){
  page.hollowErrors=[];pages.push(page);
  page.on('pageerror',error=>page.hollowErrors.push(error.message));
  page.on('console',message=>{const text=message.text();if((message.type()==='error'&&/WebGL|WebGPU|WGSL|shader|GL_INVALID|Startup failed/i.test(text))||/ - While (?:calling|validating|encoding|finishing|creating)|\[Invalid [A-Z]/.test(text))page.hollowErrors.push(text);});
  await page.addInitScript(quality=>{
    localStorage.setItem('hollow.playerName','Above Ground QA');
    localStorage.setItem('hollow.settings',JSON.stringify({quality,motion:false,effects:true,sensitivity:1,volume:0}));
  },quality);
  await page.goto('/?qa=1');
  await page.waitForFunction(()=>!!window.HollowGame&&typeof window.HollowTest?.advance==='function');
}
const snapshot=page=>page.evaluate(()=>HollowGame.snapshot());
// Starts a run and jumps to floor `index` (3 = S1, 4 = S2) with every gun, every creature removed.
async function onFloor(page,index,seed){
  await page.locator('#startDarkBtn').click();
  await expect.poll(async()=>(await snapshot(page)).state).toBe('play');
  return page.evaluate(({index,seed})=>{HollowTest.arm(['rifle','pistol','shotgun'],'rifle');HollowTest.floor(index,seed);HollowTest.silence();
    HollowTest.advance(.6);return HollowGame.snapshot();},{index,seed});
}
// A spot 1.2 m from a pickup with a clear walk to it, facing it, and clear of anything collected by walking over it.
async function approach(page,item){
  const spot=await page.evaluate(item=>{
    const s=HollowGame.snapshot(),auto=[...s.ammoPickups,...s.loot.filter(l=>l.type==='ammo'||l.type==='supplies'||l.type==='medical')].filter(p=>!p.taken);
    for(const r of [1.2,1,1.6])for(let k=0;k<8;k++){const dx=Math.sin(k*Math.PI/4),dz=Math.cos(k*Math.PI/4),x=item.x+dx*r,z=item.z+dz*r;
      if(HollowTest.navClear(x,z,item.x,item.z,.32)&&auto.every(p=>Math.hypot(p.x-x,p.z-z)>1.4))return {x,z,yaw:Math.atan2(dx,dz)};}
    return null;
  },item);
  expect(spot,`${item.id} has a clear approach`).toBeTruthy();return spot;
}
const pose=(page,at)=>page.evaluate(at=>HollowTest.pose(at),at);
async function frames(page,count=3,timeout=45000){
  const from=(await snapshot(page)).performance.frames;
  await expect.poll(async()=>(await snapshot(page)).performance.frames-from,{intervals:[100,250,500],timeout}).toBeGreaterThanOrEqual(count);
}
async function takeKeys(page,word){
  for(const key of (await snapshot(page)).loot.filter(l=>l.type==='fuse')){
    await pose(page,await approach(page,key));
    await expect(page.locator('#interactionPrompt')).toContainText(word);
    await page.keyboard.press('e');
    await expect.poll(async()=>(await snapshot(page)).loot.find(l=>l.id===key.id).taken).toBe(true);
  }
}
const GATE={x:100.5,z:100.5,yaw:-Math.PI/2};
// Steps the simulation `seconds` in 50 ms ticks with the survivor kept alive, and reports what the Gravekeeper did. Its
// AI is held still again afterwards, so it does not fight on in the real frames between steps.
const FIGHT=seconds=>{
  const T=HollowTest,G=HollowGame,acts=new Set();let hurt=0,minRelease=Infinity;T.freezeAI(false);
  for(let i=0;i<seconds*20;i++){T.health(100);T.advance(.05);const s=G.snapshot();acts.add(s.boss.act);hurt=Math.max(hurt,100-s.health);minRelease=Math.min(minRelease,s.exitRelease);}
  T.health(100);T.freezeAI(true);return {acts:[...acts],hurt,minRelease,snapshot:G.snapshot()};
};

test('S1, the Overgrown Garden: a checkpoint under the moon with its own keys and rooms; death retries S1; its gate leads into the Graveyard',async({page})=>{
  await ready(page);
  const s1=await onFloor(page,3);
  expect(s1).toMatchObject({floorCode:'S1',savedFloor:3,fuses:0,exitOpen:false,boss:null});
  expect(s1.hud.banner,'arriving on S1 says it is a checkpoint').toBe('CHECKPOINT REACHED');
  expect(s1.rooms).toHaveLength(12);expect(s1.loot.filter(l=>l.type==='fuse')).toHaveLength(3);
  expect(s1.loot.filter(l=>l.type==='weapon').map(l=>l.id)).toEqual(['g-potting:rifle']);
  expect(s1.enemies.length,'the whole 20-body pool: nine awake and eleven asleep').toBe(20);
  await expect(page.locator('#floorText')).toHaveText('S1 · THE OVERGROWN GARDEN');
  await expect(page.locator('#wingText')).toHaveText('BW / THE OLD GARDEN');
  await expect(page.locator('body')).toHaveAttribute('data-floor','S1');
  await expect(page.locator('#bossBar')).toBeHidden();
  // Dying in the garden goes back to the start of the garden with the kit carried up.
  expect(await page.evaluate(()=>{
    HollowTest.health(1);HollowTest.pose({x:13,z:7.5,yaw:Math.PI/2});HollowTest.enemy(1,{x:12,z:7.5,state:'chase',yaw:-Math.PI/2});
    HollowTest.advance(.2);return HollowGame.snapshot().state;
  })).toBe('caught');
  await expect.poll(async()=>(await snapshot(page)).state,{timeout:180000}).toBe('dead');
  await expect(page.locator('#retryDark')).toHaveText('Retry S1 · The Overgrown Garden');
  await expect(page.locator('#deadText')).toContainText('S1 · The Overgrown Garden');
  await page.locator('#retryDark').click();
  await expect.poll(async()=>{const s=await snapshot(page);return s.state==='play'&&s.floor===3&&s.seed!==s1.seed;},{timeout:60000}).toBe(true);
  const retry=await page.evaluate(()=>{HollowTest.silence();return HollowGame.snapshot();});
  expect(retry).toMatchObject({floorCode:'S1',owned:['rifle','pistol','shotgun'],fuses:0,savedFloor:3});
  expect(retry.checkpoint).toMatchObject({floor:3,owned:['rifle','pistol','shotgun']});
  // Three gate keys wind the garden gate open: the alarm, thirty seconds, then on into the churchyard.
  await pose(page,GATE);
  await expect(page.locator('#interactionPrompt')).toContainText('The garden gate needs 3 more keys');
  await takeKeys(page,'gate key');
  await expect(page.locator('#objectiveText')).toHaveText('3 / 3 KEYS · open the garden gate');
  await pose(page,GATE);
  await expect(page.locator('#interactionPrompt')).toContainText('Wind the garden gate open · alarm will sound');
  await page.keyboard.press('e');
  await expect.poll(async()=>(await snapshot(page)).exitPowered).toBe(true);
  const open=await page.evaluate(GATE=>{HollowTest.silence();for(let i=0;i<4;i++)HollowTest.advance(8);HollowTest.pose(GATE);return HollowGame.snapshot();},GATE);
  expect(open.exitOpen).toBe(true);expect(open.boss).toBeNull();
  await page.keyboard.down('w');
  try{await expect(page.locator('#descend')).toBeVisible({timeout:90000});}finally{await page.keyboard.up('w');}
  await expect(page.locator('#descendWay')).toHaveText('Above ground');
  await expect(page.locator('#descendCode')).toHaveText('S2');
  await expect(page.locator('#descendName')).toHaveText('Blackwater Graveyard');
  await expect(page.locator('#descendNote')).toContainText('Through the garden gate, into the churchyard.');
  await expect.poll(async()=>{const s=await snapshot(page);return s.state==='play'&&s.floor===4;},{timeout:60000}).toBe(true);
  await expect.poll(async()=>(await snapshot(page)).hud.banner,{intervals:[100,250]}).toBe('CHECKPOINT REACHED');
  const s2=await snapshot(page);
  expect(s2).toMatchObject({floorCode:'S2',savedFloor:4,fuses:0,exitPowered:false,exitOpen:false,owned:['rifle','pistol','shotgun']});
  expect(s2.boss).toMatchObject({kind:'gravekeeper',act:'grave',hp:90,maxHp:90,phase:1,dead:true,visible:false,holding:false});
  expect(s2.rooms).toHaveLength(13);
  expect(s2.enemies.length,'the Gravekeeper walks outside the pool: eight awake, nine asleep, three graves free').toBe(17);
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('hollow.campaign')).floor)).toBe(4);
  await expect(page.locator('#floorText')).toHaveText('S2 · BLACKWATER GRAVEYARD');
  await expect(page.locator('body')).toHaveAttribute('data-floor','S2');
});

test('S2: the cemetery gate tolls the bell and raises the Gravekeeper, which holds the gate and enrages; its death opens the gate and the way out wins the run',async({page})=>{
  await ready(page);
  const s2=await onFloor(page,4);
  expect(s2.boss).toMatchObject({act:'grave',visible:false});expect(s2.hud.banner).toBe('CHECKPOINT REACHED');
  // Supplies lie around the edges of the gate plot.
  expect(s2.loot.filter(l=>l.id.startsWith('arena-')).map(l=>l.type).sort()).toEqual(['medical','medical','supplies','supplies']);
  await takeKeys(page,'crypt key');
  await expect(page.locator('#objectiveText')).toHaveText('3 / 3 KEYS · unchain the cemetery gate');
  await pose(page,GATE);
  await expect(page.locator('#interactionPrompt')).toContainText('Unchain the cemetery gate · the bell will toll');
  const before=(await snapshot(page)).audioLog.at(-1)?.n||0;
  await page.keyboard.press('e');
  await expect.poll(async()=>(await snapshot(page)).exitPowered).toBe(true);
  // (The QA wake ends the grace silence() granted, so its blows land; the gate has already called it.)
  const toll=await page.evaluate(()=>HollowTest.boss('wake'));
  expect(toll).toMatchObject({act:'toll',holding:true,visible:false});
  await expect(page.locator('#objectiveText')).toHaveText('KILL THE GRAVEKEEPER · then run for the gate');
  // The bell tolls, and the Gravekeeper climbs out of its grave before the gate.
  const rise=await page.evaluate(()=>{HollowTest.advance(1.6);HollowTest.freezeAI(true);const s=HollowGame.snapshot();return {boss:s.boss,banner:s.hud.banner,state:s.state};});
  expect(rise.boss).toMatchObject({act:'rise',visible:true,dead:false,hp:90});expect(rise.boss.sink).toBeLessThan(-1);
  expect(rise.banner).toBe('THE GRAVEKEEPER');
  await expect.poll(async()=>{const log=(await snapshot(page)).audioLog.filter(e=>e.n>before&&e.src==='world').map(e=>e.cue);return log.includes('bell')&&log.includes('rumble');}).toBe(true);
  const up=await page.evaluate(()=>{HollowTest.freezeAI(false);HollowTest.advance(3);HollowTest.health(100);HollowTest.freezeAI(true);return HollowGame.snapshot();});
  expect(up.boss).toMatchObject({act:'hunt',sink:0,holding:true});
  await expect(page.locator('#bossBar')).toBeVisible();
  await expect(page.locator('#escapeStatus')).toHaveText('THE GRAVEKEEPER HOLDS THE GATE');
  // While it walks the gate stays chained, however long the survivor holds out; it chases, charges and slams.
  const held=await page.evaluate(FIGHT,40);
  expect(held.snapshot.exitOpen).toBe(false);expect(held.minRelease,'the release does not run down').toBe(35);
  expect(held.hurt,'its blows land').toBeGreaterThan(30);
  expect(held.acts.some(a=>a==='windup'||a==='slamUp'),`it telegraphs its attacks (${held.acts})`).toBe(true);
  console.log('Gravekeeper, 40 s:',JSON.stringify({acts:held.acts,hurt:held.hurt}));
  // Half its health gone: it screams, comes on faster and calls three bodies up out of the graves around the gate.
  const rage=await page.evaluate(()=>{const T=HollowTest;T.freezeAI(false);T.health(100);T.boss('hit',46);T.advance(.1);const a=HollowGame.snapshot();T.health(100);T.advance(1);T.health(100);T.freezeAI(true);const b=HollowGame.snapshot();
    return {act:a.boss.act,phase:a.boss.phase,banner:a.hud.banner,summoned:b.boss.summoned,risen:b.enemies.filter(e=>e.index>=17&&!e.dead&&!e.dormant).map(e=>e.index)};});
  expect(rage).toMatchObject({act:'enrage',phase:2,banner:'THE GRAVEKEEPER IS ENRAGED',summoned:3,risen:[17,18,19]});
  await expect(page.locator('#bossBar')).toHaveClass(/enraged/);
  const points=(await snapshot(page)).score.points;
  const down=await page.evaluate(()=>{const T=HollowTest;T.freezeAI(false);T.health(100);T.boss('hit',100);T.advance(.1);T.health(100);T.freezeAI(true);const s=HollowGame.snapshot();return {boss:s.boss,banner:s.hud.banner,release:s.exitRelease,open:s.exitOpen,score:s.score};});
  expect(down.boss).toMatchObject({act:'dead',dead:true,holding:false});expect(down.banner).toBe('THE GRAVEKEEPER FALLS');
  expect(down.open).toBe(false);expect(down.release).toBeLessThanOrEqual(3.5);expect(down.score.points).toBeGreaterThanOrEqual(points+2500);
  await expect(page.locator('#bossBar')).toBeHidden();
  const open=await page.evaluate(GATE=>{HollowTest.freezeAI(false);HollowTest.silence();HollowTest.advance(4);HollowTest.pose(GATE);const s=HollowGame.snapshot();return {open:s.exitOpen,banner:s.hud.banner};},GATE);
  expect(open).toEqual({open:true,banner:'CEMETERY GATE OPEN · RUN'});
  await expect(page.locator('#objectiveText')).toHaveText('RUN · the cemetery gate');
  // Out of the cemetery gate: the run is won and the saved checkpoint cleared.
  await page.keyboard.down('w');
  try{await expect.poll(async()=>(await snapshot(page)).state,{timeout:90000}).toBe('win');}finally{await page.keyboard.up('w');}
  await expect(page.locator('#win')).toBeVisible();
  await expect(page.locator('#winText')).toContainText('The Gravekeeper lies in its own grave');
  expect((await snapshot(page)).savedFloor).toBe(0);
  expect(await page.evaluate(()=>localStorage.getItem('hollow.campaign'))).toBeNull();
  await page.screenshot({path:'artifacts/levels-win.png'});
  await page.locator('#menuBtn').click();await expect(page.locator('#menu')).toBeVisible();
  await expect(page.locator('#continueBtn')).toBeHidden();
});

test('death in the Gravekeeper\'s fight retries S2 from the start, and Continue resumes S2 after a reload',async({page})=>{
  await ready(page);
  const s2=await onFloor(page,4);
  const caught=await page.evaluate(()=>{
    const T=HollowTest;T.boss('wake',true);const b=T.boss();T.health(1);T.pose({x:b.x-1.6,z:b.z-1.6,yaw:Math.atan2(-1,-1)});
    for(let i=0;i<40&&HollowGame.snapshot().state==='play';i++)T.advance(.05);
    return HollowGame.snapshot().state;
  });
  expect(caught).toBe('caught');
  await expect.poll(async()=>(await snapshot(page)).state,{timeout:180000}).toBe('dead');
  await expect(page.locator('#retryDark')).toHaveText('Retry S2 · Blackwater Graveyard');
  await expect(page.locator('#bossBar')).toBeHidden();
  await page.locator('#retryDark').click();
  await expect.poll(async()=>{const s=await snapshot(page);return s.state==='play'&&s.floor===4&&s.seed!==s2.seed;},{timeout:60000}).toBe(true);
  const retry=await snapshot(page);
  expect(retry).toMatchObject({floorCode:'S2',fuses:0,exitPowered:false,exitOpen:false,owned:['rifle','pistol','shotgun'],savedFloor:4});
  expect(retry.boss).toMatchObject({act:'grave',hp:90,phase:1,visible:false});
  await page.reload();await page.waitForFunction(()=>!!window.HollowTest);
  await expect(page.locator('#continueBtn')).toHaveText('Continue · S2 Blackwater Graveyard');
  await page.locator('#continueBtn').click();
  await expect.poll(async()=>{const s=await snapshot(page);return s.state==='play'&&s.floor===4;},{timeout:60000}).toBe(true);
  const resumed=await snapshot(page);
  expect(resumed).toMatchObject({floorCode:'S2',owned:['rifle','pistol','shotgun'],savedFloor:4});
  expect(resumed.boss).toMatchObject({act:'grave',hp:90});
});

test('moonlit screenshots: the garden, the graveyard, the Gravekeeper rising and fighting, within B3\'s draw budget',async({page})=>{
  test.setTimeout(600000);
  await page.setViewportSize({width:1280,height:720});
  await ready(page,'high');
  const b3=await onFloor(page,2,777);
  await frames(page,4,180000);const budget=(await snapshot(page)).performance;
  // Transient messages off: the pictures are of the place.
  await page.addStyleTag({content:'#msg,#interactionPrompt,#horrorCaption{visibility:hidden !important}'});
  const look=async(view,path)=>{await page.evaluate(view=>{HollowTest.pose(view);HollowTest.torch(false);},view);await frames(page,4,180000);if(path)await page.screenshot({path});return (await snapshot(page)).performance;};
  await page.evaluate(()=>{HollowTest.floor(3,1234);HollowTest.silence();HollowTest.advance(1);});
  const garden=await look({x:52.5,z:46.5,yaw:Math.PI,pitch:.04},'artifacts/levels-garden.png');
  await page.evaluate(()=>{HollowTest.floor(4,4321);HollowTest.silence();HollowTest.advance(1);});
  const graveyard=await look({x:76.5,z:76.5,yaw:-Math.PI*.75,pitch:.06},'artifacts/levels-graveyard.png');
  for(const [name,p] of [['S1',garden],['S2',graveyard]]){
    console.log(`${name} vs B3:`,JSON.stringify({drawCalls:[p.drawCalls,budget.drawCalls],triangles:[p.triangles,budget.triangles]}));
    expect(p.drawCalls,`${name} draw calls`).toBeLessThanOrEqual(budget.drawCalls*1.25);
    expect(p.triangles,`${name} triangles`).toBeLessThanOrEqual(budget.triangles*1.25);
  }
  // Half out of its grave, then upright and coming, with the AI held still for each picture.
  await page.evaluate(()=>{HollowTest.pose({x:85,z:85,yaw:Math.atan2(85-88.5,85-91.5),pitch:.02});HollowTest.boss('wake');HollowTest.advance(1.6);HollowTest.advance(1.6);HollowTest.freezeAI(true);});
  try{
    await frames(page,4,180000);await page.screenshot({path:'artifacts/levels-boss-rise.png'});
    await page.evaluate(()=>{HollowTest.freezeAI(false);HollowTest.advance(2);const b=HollowTest.boss();HollowTest.pose({x:b.x-5,z:b.z-6,yaw:Math.atan2(-5,-6),pitch:.18});
      HollowTest.health(100);HollowTest.advance(.5);HollowTest.health(100);HollowTest.freezeAI(true);});
    await frames(page,4,180000);await page.screenshot({path:'artifacts/levels-boss-fight.png'});
  }finally{await page.evaluate(()=>HollowTest.freezeAI(false));}
  expect(b3.floorCode).toBe('B3');
});
