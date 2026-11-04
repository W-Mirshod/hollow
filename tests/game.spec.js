const {test,expect}=require('@playwright/test');
let diagnosticPages=[];
test.beforeEach(()=>{diagnosticPages=[];});
test.afterEach(()=>{expect(diagnosticPages.flatMap(page=>page.hollowErrors||[]),'No uncaught game or shader errors').toEqual([]);});

async function ready(page,name='QA Explorer'){
  page.hollowErrors=[];diagnosticPages.push(page);
  page.on('pageerror',error=>page.hollowErrors.push(error.message));
  page.on('console',message=>{const text=message.text();if((message.type()==='error'&&/WebGL|WebGPU|WGSL|shader|GL_INVALID|Startup failed/.test(text))||/ - While (?:calling|validating|encoding|finishing|creating)|\[Invalid [A-Z]/.test(text))page.hollowErrors.push(text);});
  await page.addInitScript(name=>{
    localStorage.setItem('hollow.playerName',name);
    localStorage.setItem('hollow.settings',JSON.stringify({quality:'low',motion:false,sensitivity:1,volume:0}));
  },name);
  await page.goto('/?qa=1');await page.waitForFunction(()=>!!window.HollowTest);
}
// A run starts with the sidearm alone; these checks cover the whole kit, so the survivor is handed all three guns.
async function start(page){await ready(page);await page.locator('#startDarkBtn').click();await expect.poll(()=>page.evaluate(()=>HollowGame.snapshot().state)).toBe('play');await page.evaluate(()=>{HollowTest.silence();HollowTest.arm();});}
async function state(page){return page.evaluate(()=>HollowGame.snapshot());}
async function pose(page,position){await page.evaluate(position=>HollowTest.pose(position),position);}
async function key(page,name,ms=150){await page.keyboard.down(name);await page.waitForTimeout(ms);await page.keyboard.up(name);}

test('offline-local boot, menus, settings, assets and restart are error-free',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const external=[];page.on('request',r=>{if(!r.url().startsWith('http://127.0.0.1:'+(Number(process.env.HOLLOW_TEST_PORT)||3099))&&!r.url().startsWith('data:'))external.push(r.url());});
  await ready(page);
  await expect(page.locator('#menu')).toBeVisible();await expect(page.locator('#startDarkBtn')).toBeVisible();
  await page.locator('#startDarkBtn').click();await expect(page.locator('#hud')).toBeVisible();
  const initial=await state(page);expect(initial.rooms).toHaveLength(10);
  // B1: eight creatures hunt from the start and up to five more lie asleep on the floor. The run starts with the sidearm.
  const awake=initial.enemies.filter(x=>!x.dormant),asleep=initial.enemies.filter(x=>x.dormant);
  expect(awake).toHaveLength(8);expect(new Set(awake.map(x=>x.kind)).size).toBe(4);
  expect(asleep.length).toBeGreaterThan(0);expect(asleep.length).toBeLessThanOrEqual(5);
  expect(initial).toMatchObject({floor:0,floorCode:'B1',owned:['pistol'],weapon:'pistol',mag:12});
  await page.evaluate(()=>HollowTest.pause());await expect(page.locator('#pause')).toBeVisible();
  for(const quality of ['high','medium']){const frames=(await state(page)).performance.frames;await page.locator('#settingsQuality').selectOption(quality);await expect.poll(async()=>(await state(page)).performance.frames).toBeGreaterThan(frames);}
  await page.locator('#settingsMotion').check();
  expect((await state(page)).state).toBe('pause');
  await page.locator('#settingsQuality').selectOption('low');await page.locator('#resumeBtn').click();
  await page.evaluate(()=>HollowTest.build(421));await page.evaluate(()=>HollowTest.build(422));
  expect((await state(page)).performance.geometries).toBeLessThan(400);
  expect(errors).toEqual([]);expect(external).toEqual([]);
  await page.screenshot({path:'artifacts/game-desktop.png'});
});

test('inertial movement, jump, crouch, slide, aiming and all three weapons work',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await start(page);
  await pose(page,{x:13,z:7.5,yaw:Math.PI/2});
  // The first frames after Play can take over a second on software renderers (SwiftShader), so hold W until it has moved
  // the player instead of for a fixed 600 ms: this checks movement, not startup latency.
  await page.keyboard.down('w');
  try{await expect.poll(async()=>(await state(page)).position.x,{message:'W moves the player forward',timeout:10000}).toBeLessThan(12.7);}finally{await page.keyboard.up('w');}
  await page.keyboard.down('Space');await expect.poll(async()=>(await state(page)).position.y).toBeGreaterThan(.12);await page.keyboard.up('Space');
  await expect.poll(async()=>(await state(page)).onGround).toBe(true);
  await page.keyboard.down('c');await expect.poll(async()=>(await state(page)).crouching).toBe(true);await page.keyboard.up('c');
  await pose(page,{x:13,z:7.5,yaw:Math.PI/2});await page.keyboard.down('w');await page.keyboard.down('Shift');
  await expect.poll(async()=>(await state(page)).running,{message:'Shift+W sprints'}).toBe(true);await page.keyboard.down('c');await expect.poll(()=>page.locator('#stanceText').textContent()).toBe('SLIDING');await page.keyboard.up('c');await page.keyboard.up('w');await page.keyboard.up('Shift');
  await page.keyboard.press('2');await expect.poll(async()=>(await state(page)).weapon).toBe('pistol');
  await page.mouse.down({button:'right'});await expect.poll(async()=>(await state(page)).aiming).toBe(true);await page.mouse.up({button:'right'});
  await page.mouse.down();await page.waitForTimeout(650);await page.mouse.up();await expect.poll(async()=>(await state(page)).mag,{message:'the queued pistol click fires once on the next frame'}).toBe(11);
  await page.keyboard.press('r');await expect.poll(async()=>(await state(page)).mag).toBe(12);expect((await state(page)).reserve).toBe(11);
  await page.keyboard.press('3');await page.waitForTimeout(350);await page.mouse.down();await page.waitForTimeout(250);await page.mouse.up();await expect.poll(async()=>(await state(page)).mag).toBe(5);
  await page.keyboard.press('1');await expect.poll(async()=>(await state(page)).weapon).toBe('rifle');await page.mouse.down();
    try{await expect.poll(async()=>(await state(page)).mag).toBeLessThan(28);}finally{await page.mouse.up();}
  await page.keyboard.press('v');expect((await state(page)).decoys).toBe(2);
  expect(errors).toEqual([]);
});

test('shelter doors physically block, lock, conceal and let the Warden lose its target',async({page})=>{
  await start(page);const s=await state(page),d=s.doors[0];
  await pose(page,{x:d.x,z:d.z-2,yaw:Math.PI});
  await page.keyboard.press('e');await expect.poll(async()=>(await state(page)).doors[0].open).toBe(false);
  await page.keyboard.press('e');await expect.poll(async()=>(await state(page)).doors[0].locked).toBe(true);
  await page.keyboard.down('w');await page.waitForTimeout(1300);await page.keyboard.up('w');
  expect((await state(page)).position.z).toBeLessThan(d.z-.3);
  await pose(page,{x:d.x,z:d.z-2,yaw:Math.PI});
  await page.evaluate(({x,z})=>{HollowTest.enemy(0,{x,z:z+2,state:'chase',yaw:Math.PI});},d);
  await page.keyboard.press('f');await page.keyboard.down('c');
  await expect.poll(async()=>(await state(page)).hidden,{timeout:45000}).toBe(true);
  await expect.poll(async()=>(await state(page)).enemies[0].state,{timeout:90000}).not.toBe('chase');
  const hidden=await state(page);expect(hidden.health).toBe(100);expect(hidden.doors[0].health).toBeGreaterThan(0);expect(hidden.enemies[0].hp).toBe(28);
  await page.screenshot({path:'artifacts/game-shelter.png'});await page.keyboard.up('c');
  await page.keyboard.press('e');await expect.poll(async()=>(await state(page)).doors[0].open).toBe(true);
});

// An approach 1.2 m from a pickup with a clear walk to it (lower-floor rooms are furnished differently from B1's).
async function approach(page,item){
  const spot=await page.evaluate(item=>{
    for(const [dx,dz] of [[0,1],[0,-1],[1,0],[-1,0]]){const x=item.x+dx*1.2,z=item.z+dz*1.2;
      if(HollowTest.navClear(x,z,item.x,item.z,.32))return {x,z,yaw:Math.atan2(dx,dz)};}
    return null;
  },item);
  expect(spot,`${item.id} has a clear approach`).toBeTruthy();return spot;
}

test('different enemy damage, armor, medical aid, the fuse-powered descent and the B3 floodgate escape work',async({page})=>{
  await start(page);await pose(page,{x:13,z:7.5,yaw:Math.PI/2});
  await page.evaluate(()=>{HollowTest.enemy(0,{x:12,z:7.5,state:'chase'});});
  await expect.poll(async()=>(await state(page)).health).toBe(32);
  await page.evaluate(()=>{HollowTest.silence();HollowTest.enemy(0,{x:14,z:7.5});for(let i=0;i<20;i++)HollowTest.hit(0,1);});
  expect((await state(page)).enemies[0].dead).toBe(false);expect((await state(page)).enemies[0].hp).toBe(8);
  await page.evaluate(()=>HollowTest.hit(0,8));expect((await state(page)).enemies[0].dead).toBe(true);await page.evaluate(()=>HollowTest.silence());
  const med=(await state(page)).loot.find(l=>l.id==='infirmary:medical');await pose(page,{x:med.x,z:med.z+1,yaw:0});await page.keyboard.press('e');await expect.poll(async()=>(await state(page)).health).toBe(77);
  const fuses=(await state(page)).loot.filter(l=>l.type==='fuse');
  for(const fuse of fuses){await pose(page,{x:fuse.x,z:fuse.z+1,yaw:0});await page.keyboard.press('e');await expect.poll(async()=>(await state(page)).loot.find(l=>l.id===fuse.id).taken).toBe(true);}
  expect((await state(page)).fuses).toBe(3);expect((await state(page)).exitPowered).toBe(false);
  await pose(page,{x:100.5,z:100.5,yaw:-Math.PI/2});await page.keyboard.press('e');await expect.poll(async()=>(await state(page)).exitPowered).toBe(true);
  const powered=await state(page);expect(powered.exitOpen).toBe(false);expect(powered.exitRelease).toBeGreaterThan(0);
  const blocked=await page.evaluate(()=>HollowTest.collide({x:102.1,y:0,z:100.5}));expect(blocked.x).toBeLessThan(102);
  // Software rendering may need far more than 60 wall seconds for the ten-second simulation countdown.
  await expect.poll(async()=>(await state(page)).exitOpen,{timeout:180000}).toBe(true);
  const opened=await state(page);expect(opened.exitRelease).toBe(0);expect(opened.simulationTime-powered.simulationTime).toBeGreaterThanOrEqual(powered.exitRelease-.05);
  // B1's shutter leads down to B2: a new floor, with the health, guns and score carried and a checkpoint saved.
  await page.keyboard.down('w');
  try{await expect.poll(async()=>(await state(page)).floor,{timeout:60000}).toBe(1);}finally{await page.keyboard.up('w');}
  await expect.poll(async()=>(await state(page)).state).toBe('play');
  const b2=await state(page);
  expect(b2).toMatchObject({floorCode:'B2',fuses:0,exitPowered:false,exitOpen:false,health:opened.health,owned:['rifle','pistol','shotgun'],savedFloor:1});
  expect(b2.checkpoint).toMatchObject({floor:1,owned:['rifle','pistol','shotgun']});expect(b2.score).toEqual(opened.score);
  expect(b2.seed).not.toBe(opened.seed);expect(b2.rooms).toHaveLength(12);
  await expect(page.locator('#floorText')).toHaveText('B2 · RECORDS & MORGUE');
  // B3's surface floodgate is the way out: three keys, a 25-second release, then the open air.
  await page.evaluate(()=>{HollowTest.floor(2);HollowTest.silence();});
  const b3=await state(page);expect(b3).toMatchObject({floor:2,floorCode:'B3',fuses:0,savedFloor:2});
  await expect(page.locator('#floorText')).toHaveText('B3 · THE HOLLOW');
  for(const key of b3.loot.filter(l=>l.type==='fuse')){
    await pose(page,await approach(page,key));await page.keyboard.press('e');
    await expect.poll(async()=>(await state(page)).loot.find(l=>l.id===key.id).taken).toBe(true);
  }
  expect((await state(page)).fuses).toBe(3);
  await pose(page,{x:100.5,z:100.5,yaw:-Math.PI/2});await page.keyboard.press('e');await expect.poll(async()=>(await state(page)).exitPowered).toBe(true);
  const gate=await state(page);expect(gate.exitRelease).toBeGreaterThan(20);expect(gate.exitRelease).toBeLessThanOrEqual(25);expect(gate.exitOpen).toBe(false);
  await page.evaluate(()=>{for(let i=0;i<3;i++)HollowTest.advance(10);});
  expect((await state(page)).exitOpen).toBe(true);
  await pose(page,{x:100.5,z:100.5,yaw:-Math.PI/2});await page.keyboard.down('w');
  try{await expect.poll(async()=>(await state(page)).state,{timeout:60000}).toBe('win');}finally{await page.keyboard.up('w');}
  await expect(page.locator('#win')).toBeVisible();
  await expect(page.locator('#winRank')).toHaveText(/^Score [\d,]+\. New personal best, posted to the board\.$/);
  expect((await state(page)).savedFloor,'Getting out clears the saved checkpoint').toBe(0);
});

test('two real browser peers synchronize map, monsters, fuses, doors, jumping and final exit',async({browser})=>{
  test.setTimeout(600000);
  const hostContext=await browser.newContext({viewport:{width:900,height:600}}),guestContext=await browser.newContext({viewport:{width:900,height:600}});
  const host=await hostContext.newPage(),guest=await guestContext.newPage();
  try{
    await ready(host,'Host');await ready(guest,'Partner');
    await host.locator('#coopBtn').click();await host.locator('#coopCreate').click();await expect(host.locator('#coopLobby')).toBeVisible();
    const code=await host.locator('#coopCode').textContent();await guest.locator('#coopBtn').click();await guest.locator('#coopCodeIn').fill(code);await guest.locator('#coopJoinForm button').click();
    await expect(host.locator('#coopStart')).toBeEnabled();await host.locator('#coopStart').click();
    await expect.poll(async()=>(await state(guest)).state).toBe('play');
    // Two-player co-op plays B1 with twelve creatures awake and B1's sleepers on the floor; the guest mirrors every slot.
    expect((await state(host)).seed).toBe((await state(guest)).seed);
    const hostEnemies=(await state(host)).enemies;expect(hostEnemies.filter(x=>!x.dormant)).toHaveLength(12);
    await expect.poll(async()=>(await state(guest)).enemies.length).toBe(hostEnemies.length);
    await host.evaluate(()=>HollowTest.silence());
    await guest.evaluate(()=>HollowTest.action('jump',true));await expect.poll(async()=>(await state(host)).network.partnerY).toBeGreaterThan(.1);
    await guest.evaluate(()=>HollowTest.action('crouch',true));await expect.poll(async()=>(await state(host)).network.partnerCrouching).toBe(true);await guest.evaluate(()=>HollowTest.action('crouch',false));
    // Friendly fire: the host shoots the guest standing 1.6 m in front; the guest loses health and survives.
    {const at=(await state(host)).position;await pose(host,{x:at.x,z:at.z,yaw:Math.PI});await pose(guest,{x:at.x,z:at.z+1.6,yaw:0});
     await expect.poll(async()=>{const p=await host.evaluate(()=>HollowTest.snapshot().network);return p.partnerY===0&&!p.partnerCrouching;}).toBe(true);
     await host.waitForTimeout(400);await host.evaluate(()=>{HollowTest.action('fire',true);HollowTest.action('fire',false);});
     await expect.poll(async()=>(await state(guest)).health).toBeLessThan(100);expect((await state(guest)).health).toBeGreaterThan(50);expect((await state(guest)).state).toBe('play');
     await guest.evaluate(()=>HollowTest.health(100));}
    const d=(await state(guest)).doors[0];await pose(guest,{x:d.x,z:d.z-2,yaw:Math.PI});await guest.evaluate(()=>HollowTest.action('interact',true));
    await expect.poll(async()=>(await state(host)).doors[0].open).toBe(false);await expect.poll(async()=>(await state(guest)).doors[0].open).toBe(false);
    await guest.evaluate(()=>HollowTest.action('interact',true));await expect.poll(async()=>(await state(host)).doors[0].locked).toBe(true);
    const fuse=(await state(guest)).loot.find(l=>l.type==='fuse');await pose(guest,{x:fuse.x,z:fuse.z+1,yaw:0});await guest.evaluate(()=>HollowTest.action('interact',true));
    await expect.poll(async()=>(await state(host)).fuses).toBe(1);await expect.poll(async()=>(await state(guest)).fuses).toBe(1);
        for(const remaining of (await state(guest)).loot.filter(l=>l.type==='fuse'&&!l.taken)){
          await pose(guest,{x:remaining.x,z:remaining.z+1,yaw:0});await guest.evaluate(()=>HollowTest.action('interact',true));
          await expect.poll(async()=>(await state(host)).loot.find(l=>l.id===remaining.id).taken).toBe(true);
          await expect.poll(async()=>(await state(guest)).loot.find(l=>l.id===remaining.id).taken).toBe(true);
        }
        await expect.poll(async()=>(await state(host)).fuses).toBe(3);await expect.poll(async()=>(await state(guest)).fuses).toBe(3);
        await pose(guest,{x:100.5,z:100.5,yaw:-Math.PI/2});await guest.evaluate(()=>HollowTest.action('interact',true));
        await expect.poll(async()=>(await state(host)).exitPowered).toBe(true);await expect.poll(async()=>(await state(guest)).exitPowered).toBe(true);
        for(const peer of [host,guest]){
          expect((await state(peer)).exitOpen).toBe(false);
          const blocked=await peer.evaluate(()=>HollowTest.collide({x:102.1,y:0,z:100.5}));expect(blocked.x).toBeLessThan(102);
        }
        // The shutter opens after HollowHorror.RELEASE_SECONDS (10 s) of simulation, and a frame advances at most .05 s, so the
        // host needs ~200 frames. Two software-rendered peers can run near 1 FPS here, so allow up to 5 minutes of wall time.
        await expect.poll(async()=>(await state(host)).exitOpen,{timeout:300000}).toBe(true);
        await expect.poll(async()=>(await state(guest)).exitOpen).toBe(true);
        await guest.bringToFront();await guest.keyboard.down('w');
        try{await expect.poll(async()=>(await state(guest)).state,{timeout:60000}).toBe('spect');}finally{await guest.keyboard.up('w');}
        await host.bringToFront();await pose(host,{x:100.5,z:100.5,yaw:-Math.PI/2});await host.keyboard.down('w');
        try{
          await expect.poll(async()=>(await state(host)).state,{timeout:60000}).toBe('coopEnd');
          await expect.poll(async()=>(await state(guest)).state).toBe('coopEnd');
        }finally{await host.keyboard.up('w');}
        for(const peer of [host,guest]){await expect(peer.locator('#ceTitle')).toHaveText('Outside');await expect(peer.locator('#ceText')).toContainText('You both made it out');
          await expect(peer.locator('#ceRank')).toHaveText(/^Score [\d,]+\. New personal best, posted to the board\.$/);}
  }finally{await hostContext.close();await guestContext.close();}
});

test('phone supports simultaneous real move/look/fire touches and portrait/landscape layout',async({browser})=>{
  const context=await browser.newContext({viewport:{width:844,height:390},deviceScaleFactor:1,isMobile:true,hasTouch:true});const page=await context.newPage();
  try{
    await start(page);await expect(page.locator('#touchControls')).toBeVisible();await pose(page,{x:13,z:7.5,yaw:Math.PI/2});
    const cdp=await context.newCDPSession(page);
    const center=async selector=>{const r=await page.locator(selector).boundingBox();return{x:r.x+r.width/2,y:r.y+r.height/2};};
    const stick=await center('#touchMove'),fire=await center('.touch-fire');
    const t=(id,x,y)=>({id,x,y,radiusX:4,radiusY:4,force:1});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[t(1,stick.x,stick.y),t(2,500,160),t(3,fire.x,fire.y)]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[t(1,stick.x,stick.y-40),t(2,529,149),t(3,fire.x,fire.y)]});
    await expect.poll(async()=>(await state(page)).input.touchY).toBeGreaterThan(.5);
    await expect.poll(async()=>(await state(page)).mag).toBeLessThan(30);expect((await state(page)).pitch).toBeGreaterThan(0);
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await expect.poll(async()=>(await state(page)).input.mouseDown).toBe(false);expect((await state(page)).input.touchY).toBe(0);
    await page.locator('.touch-pause').tap();await expect(page.locator('#pause')).toBeVisible();await page.locator('#resumeBtn').tap();
    await page.screenshot({path:'artifacts/game-phone-landscape.png'});
    await page.setViewportSize({width:390,height:844});
    const bounds=await page.locator('.touch-button').evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom};}));
    for(const r of bounds){expect(r.x).toBeGreaterThanOrEqual(0);expect(r.y).toBeGreaterThanOrEqual(0);expect(r.right).toBeLessThanOrEqual(391);expect(r.bottom).toBeLessThanOrEqual(845);}
    await page.screenshot({path:'artifacts/game-phone-portrait.png'});
  }finally{await context.close();}
});
