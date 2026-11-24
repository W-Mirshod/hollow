const {test,expect}=require('@playwright/test');

// The campaign: a run starts with the sidearm alone, finds the other guns on the way, wakes sleeping bodies with light,
// footsteps and gunfire, and goes down three floors with what it carries. Screenshots go to artifacts/campaign-*.png.
test.setTimeout(300000);
test.use({viewport:{width:1000,height:650}});

let pages=[];
test.beforeEach(()=>{pages=[];});
test.afterEach(()=>expect(pages.flatMap(page=>page.hollowErrors),'No uncaught game or shader errors').toEqual([]));

async function ready(page,name='Campaign QA'){
  page.hollowErrors=[];pages.push(page);
  page.on('pageerror',error=>page.hollowErrors.push(error.message));
  page.on('console',message=>{const text=message.text();if((message.type()==='error'&&/WebGL|WebGPU|WGSL|shader|GL_INVALID|Startup failed/i.test(text))||/ - While (?:calling|validating|encoding|finishing|creating)|\[Invalid [A-Z]/.test(text))page.hollowErrors.push(text);});
  await page.addInitScript(name=>{
    localStorage.setItem('hollow.playerName',name);
    localStorage.setItem('hollow.settings',JSON.stringify({quality:'low',motion:false,effects:true,sensitivity:1,volume:0}));
  },name);
  await page.goto('/?qa=1');
  await page.waitForFunction(()=>!!window.HollowGame&&typeof window.HollowTest?.advance==='function');
}
const snapshot=page=>page.evaluate(()=>HollowGame.snapshot());
async function start(page){
  await page.locator('#startDarkBtn').click();
  await expect.poll(async()=>(await snapshot(page)).state).toBe('play');
  await page.evaluate(()=>HollowTest.silence());
}
// A spot 1.2 m from a pickup with a clear walk to it, facing it, and clear of anything collected by walking over it.
async function approach(page,item){
  const spot=await page.evaluate(item=>{
    const s=HollowGame.snapshot(),auto=[...s.ammoPickups,...s.loot.filter(l=>l.type==='ammo'||l.type==='supplies')].filter(p=>!p.taken);
    for(const r of [1.2,1,1.6])for(let k=0;k<8;k++){const dx=Math.sin(k*Math.PI/4),dz=Math.cos(k*Math.PI/4),x=item.x+dx*r,z=item.z+dz*r;
      if(HollowTest.navClear(x,z,item.x,item.z,.32)&&auto.every(p=>Math.hypot(p.x-x,p.z-z)>1.4))return {x,z,yaw:Math.atan2(dx,dz)};}
    return null;
  },item);
  expect(spot,`${item.id} has a clear approach`).toBeTruthy();return spot;
}
const pose=(page,at)=>page.evaluate(at=>HollowTest.pose(at),at);
async function frames(page,count=3){
  const from=(await snapshot(page)).performance.frames;
  await expect.poll(async()=>(await snapshot(page)).performance.frames-from,{intervals:[100,250,500]}).toBeGreaterThanOrEqual(count);
}
// Slot 9, a Stalker, lies along the west wall of the open central spine (x 42-51 on every B1 seed).
const BODY={x:43.1,z:40,yaw:0};
// Lays slot 9 down, then holds `keys` for up to `seconds` of 50 ms steps from `side` metres east of the body (all in one
// task, so no real frame interleaves). Reports when, and how far from the survivor, it stopped sleeping, if it did.
async function sweep(page,{side,z,yaw,keys=[],crouch=false,torch=false,seconds}){
  for(const key of keys)await page.keyboard.down(key);
  try{
    return await page.evaluate(({BODY,side,z,yaw,crouch,torch,seconds})=>{
      const T=HollowTest,G=HollowGame;T.silence();
      const body=T.sleeper(9,BODY),x=Math.max(body[0],body[2],body[4])+side;
      const near=p=>Math.min(Math.hypot(body[0]-p.x,body[1]-p.z),Math.hypot(body[2]-p.x,body[3]-p.z),Math.hypot(body[4]-p.x,body[5]-p.z));
      T.torch(torch);T.action('crouch',crouch);T.pose({x,z,yaw});
      let closest=Infinity,last=G.snapshot().audioLog.at(-1)?.n||0;const cues=[];
      for(let i=1;i<=seconds*20;i++){
        T.advance(.05);const s=G.snapshot(),d=near(s.position);closest=Math.min(closest,d);
        for(const e of s.audioLog)if(e.n>last){if(e.src==='creature')cues.push(e.cue);last=e.n;}
        if(!s.enemies[9].dormant)return {woke:true,after:i/20,distance:d,closest,running:s.running,crouching:s.crouching,enemy:s.enemies[9],cues};
      }
      const s=G.snapshot();
      return {woke:false,closest,crouching:s.crouching,travelled:Math.abs(s.position.z-z),enemy:s.enemies[9],cues};
    },{BODY,side,z,yaw,crouch,torch,seconds});
  }finally{
    for(const key of keys)await page.keyboard.up(key);
    await page.evaluate(()=>{HollowTest.action('crouch',false);HollowTest.silence();});
  }
}

test('a run starts with the sidearm alone; the carbine lies in the B1 armory and is taken with E',async({page})=>{
  await ready(page);await start(page);
  const s=await snapshot(page);
  expect(s).toMatchObject({floorCode:'B1',owned:['pistol'],weapon:'pistol',mag:12,reserve:12});
  await expect(page.locator("#resTxt")).toHaveText("/ ∞");
  expect(s.ammoPickups,'B1 stocks sixteen ammunition boxes (it had twelve)').toHaveLength(16);
  await expect(page.locator('#weaponSlots span.locked')).toHaveCount(2);
  await expect(page.locator('body')).toHaveAttribute('data-floor','B1');
  await expect(page.locator('#floorTint')).toHaveCSS('opacity','0');
  await expect(page.locator('#weaponSlots span.selected')).toHaveText('2');
  // A gun not found yet cannot be drawn: its key says so, and Q stays on the sidearm.
  await page.keyboard.press('1');await expect(page.locator('#msg')).toContainText('No AR-27');
  await page.keyboard.press('q');expect((await snapshot(page)).weapon).toBe('pistol');
  const rifle=s.loot.find(l=>l.type==='weapon');
  expect(rifle).toMatchObject({id:'armory:rifle',weapon:'rifle',taken:false,visible:true});
  expect(s.loot.filter(l=>l.type==='weapon'),'B1 hides the carbine only').toHaveLength(1);
  await pose(page,await approach(page,rifle));
  await expect(page.locator('#interactionPrompt')).toContainText('Take the AR-27');
  await page.screenshot({path:'artifacts/campaign-rifle-found.png'});
  await page.keyboard.press('e');
  await expect.poll(async()=>(await snapshot(page)).weapon).toBe('rifle');
  const armed=await snapshot(page);
  expect(armed).toMatchObject({weapon:'rifle',owned:['rifle','pistol'],mag:30});
  expect(armed.reserve).toBeGreaterThanOrEqual(15);
  expect(armed.hud.banner).toBe('NEW WEAPON');
  expect(armed.loot.find(l=>l.id==='armory:rifle')).toMatchObject({taken:true,visible:false});
  await expect(page.locator('#weaponSlots span.locked')).toHaveCount(1);
  await expect(page.locator('#msg')).toContainText('AR-27 · Carbine · 30 loaded');
  await page.screenshot({path:'artifacts/campaign-new-weapon.png'});
  // Q now cycles through the two guns carried and never onto the shotgun, which waits on B2.
  await page.keyboard.press('q');await expect.poll(async()=>(await snapshot(page)).weapon).toBe('pistol');
  await page.keyboard.press('q');await expect.poll(async()=>(await snapshot(page)).weapon).toBe('rifle');
  await page.keyboard.press('3');await expect(page.locator('#msg')).toContainText('No SG-8');
  expect((await snapshot(page)).weapon).toBe('rifle');
});

test('a sleeping body wakes in seconds to footsteps, a sprint or a torch beam, but a crouch past in the dark leaves it',async({page})=>{
  await ready(page);await start(page);
  // Torch off and crouched, 2.5 m to the side: the survivor slips past and the body never stirs.
  const sneak=await sweep(page,{side:2.5,z:32,yaw:Math.PI,keys:['KeyW'],crouch:true,seconds:12});
  expect(sneak).toMatchObject({woke:false,crouching:true});expect(sneak.travelled).toBeGreaterThan(12);expect(sneak.closest).toBeLessThan(2.7);
  // The same line at a walk wakes it before the survivor is past.
  const walk=await sweep(page,{side:2.5,z:32,yaw:Math.PI,keys:['KeyW'],seconds:8});
  expect(walk.woke,'walking past').toBe(true);expect(walk.after).toBeLessThan(5);expect(walk.enemy.state).toBe('chase');
  // A sprint six metres away.
  const sprint=await sweep(page,{side:6,z:28,yaw:Math.PI,keys:['KeyW','ShiftLeft'],seconds:5});
  expect(sprint.woke,'sprinting past').toBe(true);expect(sprint.running).toBe(true);expect(sprint.distance).toBeGreaterThan(4);
  // Standing still ten metres off: in the dark it sleeps on; with the beam on it, it is up within about a second.
  const dark=await sweep(page,{side:1,z:29,yaw:Math.PI,seconds:4});
  expect(dark.woke,'torch off, standing still').toBe(false);
  const beam=await sweep(page,{side:1,z:29,yaw:Math.PI,torch:true,seconds:3});
  expect(beam.woke,'torch on the body').toBe(true);expect(beam.after).toBeLessThan(1.3);expect(beam.distance).toBeGreaterThan(8);
  // Crouching right past it: its teeth chatter first, a warning, then it wakes roaring and gets up off the floor.
  const close=await sweep(page,{side:1.2,z:34,yaw:Math.PI,keys:['KeyW'],crouch:true,seconds:8});
  expect(close.woke).toBe(true);expect(close.cues).toContain('chatter');expect(close.cues).toContain('wake');
  expect(close.cues.indexOf('chatter')).toBeLessThan(close.cues.indexOf('wake'));
  expect(close.enemy).toMatchObject({dormant:false,rising:true,state:'chase'});expect(close.enemy.anim.rising).toBe(1);
  console.log('Sleepers:',JSON.stringify({walk:walk.after,sprint:[sprint.after,+sprint.distance.toFixed(1)],beam:[beam.after,+beam.distance.toFixed(1)],close:close.after}));
  // On real frames, with the AI held still: the body lies in the torch beam, then gets up off the floor once woken.
  await page.evaluate(BODY=>{
    const T=HollowTest;T.silence();T.freezeAI(true);T.advance(5.5);T.sleeper(9,BODY);T.torch(true);
    T.pose({x:46.5,z:BODY.z+5,yaw:Math.atan2(46.5-BODY.x,5),pitch:-.25});
  },BODY);
  try{
    await frames(page,4);
    expect((await snapshot(page)).enemies[9]).toMatchObject({dormant:true,visible:true,state:'sleep'});
    await page.screenshot({path:'artifacts/campaign-sleeper.png'});
    // Read in the same task as the wake: the banner ages in real time, and a software-rendered screenshot is slow.
    const up=await page.evaluate(()=>{HollowTest.wake(9);HollowTest.advance(.3);const s=HollowGame.snapshot();return {enemy:s.enemies[9],banner:s.hud.banner};});
    expect(up.enemy).toMatchObject({dormant:false,state:'chase',rising:true});expect(up.banner).toBe('IT\'S AWAKE');
    await expect.poll(async()=>(await snapshot(page)).enemies[9].anim.rise).toBeGreaterThan(.35);
    await page.screenshot({path:'artifacts/campaign-rising.png'});
  }finally{await page.evaluate(()=>{HollowTest.freezeAI(false);HollowTest.silence();});}
});

test('a gunshot wakes the sleepers in earshot nearest first, a louder gun reaches further, and a waking body rouses its neighbours',async({page})=>{
  await ready(page);await start(page);
  const shot=await page.evaluate(()=>{
    const T=HollowTest,G=HollowGame;T.silence();T.torch(false);T.advance(.4);
    // Three bodies along the spine's west wall, roughly 4, 9 and 25 m away; the survivor fires into the ceiling.
    T.pose({x:46.5,z:30,yaw:0,pitch:1.2});
    T.sleeper(9,{x:43.1,z:32.5,yaw:0});T.sleeper(10,{x:43.1,z:39,yaw:0});T.sleeper(11,{x:43.1,z:56,yaw:0});
    const woke={},before=G.snapshot().mag;
    T.action('fire',true);T.advance(.05);T.action('fire',false);
    for(let i=1;i<=50;i++){T.advance(.05);const s=G.snapshot();for(const k of [9,10,11])if(woke[k]===undefined&&!s.enemies[k].dormant)woke[k]=+(i*.05).toFixed(2);}
    const pistol=G.snapshot();
    // The shotgun carries much further.
    T.arm(['pistol','shotgun'],'shotgun');T.advance(.4);
    T.action('fire',true);T.advance(.05);T.action('fire',false);
    let far;for(let i=1;i<=40&&far===undefined;i++){T.advance(.05);if(!G.snapshot().enemies[11].dormant)far=+(i*.05).toFixed(2);}
    return {mags:[before,pistol.mag],weapon:pistol.weapon,woke,farAsleep:pistol.enemies[11].dormant,far};
  });
  expect(shot.weapon).toBe('pistol');expect(shot.mags).toEqual([12,11]);
  expect(shot.woke[9],'the nearest body is up first').toBeLessThan(shot.woke[10]);
  expect(shot.woke[9]).toBeLessThan(.8);expect(shot.woke[10]).toBeLessThan(1.15);
  expect(shot.woke[11],'the sidearm does not carry 25 m').toBeUndefined();expect(shot.farAsleep).toBe(true);
  expect(shot.far,'the shotgun does').toBeLessThan(1.15);
  const chain=await page.evaluate(()=>{
    // Past the five-second cooldown of the banner the gunfire's wakes raised.
    const T=HollowTest,G=HollowGame;T.silence();T.torch(false);T.pose({x:46.5,z:20,yaw:Math.PI});T.advance(5.5);
    // A cluster of three bodies, and a fourth well clear of all of them.
    T.sleeper(12,{x:43.1,z:52,yaw:0});T.sleeper(13,{x:49.5,z:55,yaw:0});T.sleeper(14,{x:43.1,z:60,yaw:0});T.sleeper(15,{x:49.5,z:80,yaw:0});
    T.wake(12);const first=G.snapshot(),woke={};
    for(let i=1;i<=40;i++){T.advance(.05);const s=G.snapshot();for(const k of [13,14,15])if(woke[k]===undefined&&!s.enemies[k].dormant)woke[k]=+(i*.05).toFixed(2);}
    return {banner:first.hud.banner,roused:first.enemies.filter(e=>e.dormant&&e.wakeIn>=0).map(e=>e.index),woke};
  });
  expect(chain.banner).toBe('THEY\'RE WAKING UP');expect(chain.roused.sort()).toEqual([13,14]);
  for(const k of [13,14]){expect(chain.woke[k]).toBeGreaterThanOrEqual(.35);expect(chain.woke[k]).toBeLessThan(1.7);}
  expect(chain.woke[15],'a body more than 11 m from every waking one sleeps on').toBeUndefined();
  console.log('Gunfire and chain:',JSON.stringify({pistol:shot.woke,shotgun25m:shot.far,chain:chain.woke}));
});

test('the B1 shutter leads down to B2 with everything carried; death there retries the floor; Continue resumes it after a reload',async({page})=>{
  test.setTimeout(420000);
  await ready(page);await start(page);
  await page.evaluate(()=>{HollowTest.arm(['rifle','pistol'],'rifle');HollowTest.health(60);});
  for(const fuse of (await snapshot(page)).loot.filter(l=>l.type==='fuse')){
    await pose(page,await approach(page,fuse));await page.keyboard.press('e');
    await expect.poll(async()=>(await snapshot(page)).loot.find(l=>l.id===fuse.id).taken).toBe(true);
  }
  await pose(page,{x:100.5,z:100.5,yaw:-Math.PI/2});await page.keyboard.press('e');
  await expect.poll(async()=>(await snapshot(page)).exitPowered).toBe(true);
  // The ten-second release runs down in simulation; the walk out and the descent happen on real frames.
  const out=await page.evaluate(()=>{HollowTest.silence();HollowTest.advance(10);HollowTest.advance(.5);HollowTest.pose({x:100.5,z:100.5,yaw:-Math.PI/2});return HollowGame.snapshot();});
  expect(out.exitOpen).toBe(true);
  await page.keyboard.down('w');
  try{await expect(page.locator('#descend')).toBeVisible({timeout:90000});}finally{await page.keyboard.up('w');}
  await expect(page.locator('#descendCode')).toHaveText('B2');
  await expect(page.locator('#descendName')).toHaveText('Records & Morgue');
  await expect(page.locator('#descendNote')).toContainText('east loading shutter');
  await page.screenshot({path:'artifacts/campaign-descend-card.png'});
  await expect.poll(async()=>{const s=await snapshot(page);return s.state==='play'&&s.floor===1;},{timeout:60000}).toBe(true);
  await expect(page.locator('#descend')).toBeHidden();
  const b2=await snapshot(page);
  expect(b2).toMatchObject({floorCode:'B2',weapon:'rifle',owned:['rifle','pistol'],health:60,mag:out.mag,fuses:0,exitOpen:false,savedFloor:1});
  expect(b2.reserve).toBeGreaterThanOrEqual(out.reserve);expect(b2.seed).not.toBe(out.seed);expect(b2.rooms).toHaveLength(12);
  expect(b2.enemies.filter(e=>!e.dormant)).toHaveLength(6);expect(b2.ammoPickups).toHaveLength(18);
  const asleep=b2.enemies.filter(e=>e.dormant).length;expect(asleep).toBeGreaterThan(6);expect(asleep).toBeLessThanOrEqual(12);
  expect(b2.loot.filter(l=>l.type==='weapon').map(l=>[l.id,l.visible])).toEqual([['m-security:shotgun',true],['m-intake:rifle',false]]);
  const save=await page.evaluate(()=>JSON.parse(localStorage.getItem('hollow.campaign')));
  expect(save).toMatchObject({v:1,floor:1,kit:{health:60,owned:[true,true,false],weapon:0}});
  await page.evaluate(()=>HollowTest.silence());
  await expect(page.locator('#floorText')).toHaveText('B2 · RECORDS & MORGUE');
  await expect(page.locator('#wingText')).toHaveText('BW / MORGUE LEVEL');
  await expect(page.locator('body')).toHaveAttribute('data-floor','B2');
  await expect(page.locator('#floorTint')).toHaveCSS('opacity','1');
  await expect(page.locator('#objectiveText')).toContainText('KEYCARDS');
  await page.screenshot({path:'artifacts/campaign-b2.png'});
  // The shotgun waits in Security; with it every slot is open.
  await pose(page,await approach(page,b2.loot.find(l=>l.id==='m-security:shotgun')));await page.keyboard.press('e');
  await expect.poll(async()=>(await snapshot(page)).weapon).toBe('shotgun');
  const full=await snapshot(page);
  expect(full).toMatchObject({weapon:'shotgun',owned:['rifle','pistol','shotgun'],mag:6});expect(full.hud.banner).toBe('NEW WEAPON');
  await expect(page.locator('#weaponSlots span.locked')).toHaveCount(0);
  // Death below B1 restarts the floor with the kit carried down, so the shotgun is back in Security.
  expect(await page.evaluate(()=>{
    HollowTest.health(1);HollowTest.pose({x:51,z:55,yaw:Math.PI});HollowTest.enemy(1,{x:51,z:54,state:'chase',yaw:0});
    HollowTest.advance(.2);return HollowGame.snapshot().state;
  })).toBe('caught');
  await expect.poll(async()=>(await snapshot(page)).state,{timeout:90000}).toBe('dead');
  await expect(page.locator('#retryDark')).toHaveText('Retry B2 · Records & Morgue');
  await expect(page.locator('#deadText')).toContainText('down to B2 · Records & Morgue');
  await page.screenshot({path:'artifacts/campaign-retry.png'});
  await page.locator('#retryDark').click();
  await expect(page.locator('#descendNote')).toHaveText('Back to the start of the floor, with what you carried down.');
  await expect.poll(async()=>{const s=await snapshot(page);return s.state==='play'&&s.seed!==b2.seed;},{timeout:60000}).toBe(true);
  const retry=await snapshot(page);
  expect(retry).toMatchObject({floor:1,owned:['rifle','pistol'],weapon:'rifle',health:60,mag:30,fuses:0,score:b2.score});
  expect(retry.checkpoint).toEqual({floor:1,elapsed:b2.checkpoint.elapsed,owned:['rifle','pistol']});
  expect(retry.loot.find(l=>l.id==='m-security:shotgun')).toMatchObject({taken:false,visible:true});
  // The checkpoint outlives the page: after a reload, Continue on the main menu resumes B2 with the same kit.
  await page.reload();await page.waitForFunction(()=>!!window.HollowTest);
  await expect(page.locator('#continueBtn')).toBeVisible();
  await expect(page.locator('#continueBtn')).toHaveText('Continue · B2 Records & Morgue');
  await page.screenshot({path:'artifacts/campaign-continue.png'});
  await page.locator('#continueBtn').click();
  await expect.poll(async()=>{const s=await snapshot(page);return s.state==='play'&&s.floor===1;},{timeout:60000}).toBe(true);
  expect(await snapshot(page)).toMatchObject({floorCode:'B2',owned:['rifle','pistol'],weapon:'rifle',health:60,mag:30});
});

test('kills bank across floors, and B3\'s surface floodgate leads up into the S1 garden with the run and a new checkpoint',async({page})=>{
  await ready(page);await start(page);
  // A shotgun headshot on a crawler down B1's central spine (tests/dopamine.spec.js) scores before the descent.
  const kill=await page.evaluate(()=>{
    const T=HollowTest,G=HollowGame,x=45,z=55,crawlerZ=51.5;
    T.silence();T.torch(false);T.arm(['rifle','pistol','shotgun'],'shotgun');T.action('aim',true);T.advance(.3);
    T.pose({x,z,yaw:0,pitch:0});const eye=G.snapshot().position.y+1.6;
    T.pose({x,z,yaw:0,pitch:Math.atan((.72-eye)/(z-crawlerZ-.43))});
    T.enemy(2,{x,z:crawlerZ,state:'wander',yaw:0});
    T.action('fire',true);T.advance(.05);T.action('fire',false);T.action('aim',false);T.silence();
    return G.snapshot().score;
  });
  expect(kill.kills).toBe(1);expect(kill.points).toBeGreaterThan(0);
  const b2=await page.evaluate(()=>{HollowTest.floor(1);HollowTest.silence();return HollowGame.snapshot();});
  expect(b2.score,'the B1 kill is banked on B2').toEqual(kill);expect(b2.streak.points).toBe(0);expect(b2.hud.score).toBe(kill.points);
  const b3=await page.evaluate(()=>{HollowTest.floor(2);HollowTest.silence();return HollowGame.snapshot();});
  expect(b3).toMatchObject({floorCode:'B3',score:kill,savedFloor:2,owned:['rifle','pistol','shotgun']});
  expect(b3.rooms).toHaveLength(13);expect(b3.ammoPickups).toHaveLength(20);
  expect(b3.loot.filter(l=>l.type==='weapon').every(l=>!l.visible),'guns already carried are not lying on B3').toBe(true);
  await expect(page.locator('#floorText')).toHaveText('B3 · THE HOLLOW');
  await expect(page.locator('#wingText')).toHaveText('BW / CISTERN LEVEL');
  await expect(page.locator('body')).toHaveAttribute('data-floor','B3');
  await page.screenshot({path:'artifacts/campaign-b3.png'});
  for(const key of b3.loot.filter(l=>l.type==='fuse')){
    await pose(page,await approach(page,key));
    await expect(page.locator('#interactionPrompt')).toContainText('floodgate key');
    await page.keyboard.press('e');
    await expect.poll(async()=>(await snapshot(page)).loot.find(l=>l.id===key.id).taken).toBe(true);
  }
  await expect(page.locator('#objectiveText')).toHaveText('3 / 3 KEYS · open the surface floodgate');
  await pose(page,{x:100.5,z:100.5,yaw:-Math.PI/2});await page.keyboard.press('e');
  await expect.poll(async()=>(await snapshot(page)).exitPowered).toBe(true);
  const open=await page.evaluate(()=>{for(let i=0;i<3;i++)HollowTest.advance(10);HollowTest.pose({x:100.5,z:100.5,yaw:-Math.PI/2});return HollowGame.snapshot();});
  expect(open.exitOpen).toBe(true);expect(open.hud.banner).toBe('FLOODGATE OPEN · RUN');
  // B3 is no longer the way out: the floodgate opens on the night air, and the run goes on above ground
  // (tests/above-ground.spec.js plays S1 and S2 through to the win).
  await page.keyboard.down('w');
  try{await expect(page.locator('#descend')).toBeVisible({timeout:90000});}finally{await page.keyboard.up('w');}
  await expect(page.locator('#descendWay')).toHaveText('Above ground');
  await expect(page.locator('#descendCode')).toHaveText('S1');
  await expect(page.locator('#descendName')).toHaveText('The Overgrown Garden');
  await expect(page.locator('#descendNote')).toContainText('Up through the surface floodgate, into the open air.');
  await expect.poll(async()=>{const s=await snapshot(page);return s.state==='play'&&s.floor===3;},{timeout:60000}).toBe(true);
  // The garden is a checkpoint, and says so as the card lifts.
  await expect.poll(async()=>(await snapshot(page)).hud.banner,{intervals:[100,250]}).toBe('CHECKPOINT REACHED');
  const s1=await snapshot(page);
  expect(s1).toMatchObject({floorCode:'S1',score:kill,savedFloor:3,owned:['rifle','pistol','shotgun'],fuses:0,exitOpen:false,boss:null});
  expect(s1.checkpoint).toMatchObject({floor:3,owned:['rifle','pistol','shotgun']});
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('hollow.campaign')).floor)).toBe(3);
  await expect(page.locator('#floorText')).toHaveText('S1 · THE OVERGROWN GARDEN');
  await expect(page.locator('body')).toHaveAttribute('data-floor','S1');
  await page.screenshot({path:'artifacts/campaign-s1.png'});
});

test('a hunter snarls at arm\'s length and howls across the floor when it loses the trail',async({page})=>{
  await ready(page);await start(page);
  const close=await page.evaluate(()=>{
    const T=HollowTest,G=HollowGame;T.silence();T.torch(true);T.pose({x:45,z:55,yaw:Math.PI});
    let last=G.snapshot().audioLog.at(-1)?.n||0;const cues=[];
    T.enemy(1,{x:45,z:47,state:'chase',yaw:0});
    for(let i=0;i<120;i++){T.health(100);T.advance(.05);
      for(const e of G.snapshot().audioLog)if(e.n>last){if(e.src==='creature'&&e.kind==='stalker')cues.push(e.cue);last=e.n;}}
    T.silence();return cues;
  });
  expect(close,'a Stalker on top of the survivor snarls').toContain('snarl');
  // A Warden sent after a spot the survivor has left gives up the chase after eight seconds and howls.
  const from=(await snapshot(page)).audioLog.at(-1)?.n||0;
  const lost=await page.evaluate(()=>{
    const T=HollowTest,G=HollowGame;T.torch(false);
    T.pose({x:45,z:30,yaw:0});T.enemy(0,{x:45,z:60,state:'chase',yaw:Math.PI});T.pose({x:4.5,z:55.5,yaw:0});
    for(let i=0;i<240&&G.snapshot().enemies[0].state==='chase';i++)T.advance(.05);
    return G.snapshot().enemies[0];
  });
  expect(lost.state).toBe('search');
  // The howl follows a beat later, on the audio clock (real frames).
  await expect.poll(async()=>(await snapshot(page)).audioLog.some(e=>e.n>from&&e.src==='creature'&&e.kind==='warden'&&e.cue==='howl'),
    {timeout:30000}).toBe(true);
  await page.evaluate(()=>HollowTest.silence());
});

test('a charging creature cannot pass through a closed door, and an unlatched door holds for several seconds',async({page})=>{
  await ready(page);await start(page);
  const r=await page.evaluate(()=>{
    const T=HollowTest,G=HollowGame;T.silence();T.torch(false);
    const door=G.snapshot().doors[0];T.door?.(0,'close');
    return door;
  });
  // Close the first room's door through the game's own interaction, from outside.
  const d=(await snapshot(page)).doors[0];
  await pose(page,{x:d.x,z:d.z+1.3,yaw:0});
  if((await snapshot(page)).doors[0].open){await page.keyboard.press('e');await expect.poll(async()=>(await snapshot(page)).doors[0].open).toBe(false);}
  const out=await page.evaluate(d=>{
    const T=HollowTest,G=HollowGame,side=[];
    // The survivor stands just inside, a Stalker charges from 6 m outside, straight at the door, at lunge speed.
    for(const k of [1,2]){T.pose({x:d.x,z:d.z-1.3,yaw:Math.PI});T.enemy(k,{x:d.x,z:d.z+6,state:'chase',yaw:Math.PI});}
    let crossed=false;
    for(let i=0;i<80;i++){T.health(100);T.advance(.05);const s=G.snapshot();for(const k of [1,2])if(s.enemies[k].z<d.z-.05&&!s.doors[0].open)crossed=true;}
    const s=G.snapshot();return {crossed,open:s.doors[0].open,health:s.doors[0].health};
  },d);
  expect(out.crossed,'no creature is inside while the door is shut').toBe(false);
  expect(out.open,'the door holds for 4 s of bashing').toBe(false);
  console.log('Door:',JSON.stringify(out));
});
