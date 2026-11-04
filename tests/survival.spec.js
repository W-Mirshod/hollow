const {test,expect}=require('@playwright/test');

test.setTimeout(120000);
test.use({viewport:{width:800,height:520}});

const weaponKeys=[['1','rifle'],['2','pistol'],['3','shotgun']];
const rewards={ammo:{rifle:20,pistol:6,shotgun:3},supplies:{rifle:30,pistol:12,shotgun:6}};
let diagnosticPages=[];
test.beforeEach(()=>{diagnosticPages=[];});
test.afterEach(()=>expect(diagnosticPages.flatMap(page=>page.hollowErrors),'No uncaught gameplay or WebGL/shader errors').toEqual([]));

async function ready(page,name='Survival QA'){
  page.hollowErrors=[];diagnosticPages.push(page);
  page.on('pageerror',error=>page.hollowErrors.push(error.message));
  page.on('console',message=>{
    const text=message.text();
    if((message.type()==='error'&&/WebGL|WebGPU|WGSL|shader|GL_INVALID|Startup failed/i.test(text))||/GL_INVALID_(?:OPERATION|VALUE|ENUM|FRAMEBUFFER)| - While (?:calling|validating|encoding|finishing|creating)|\[Invalid [A-Z]/.test(text))page.hollowErrors.push(text);
  });
  await page.addInitScript(name=>{
    localStorage.setItem('hollow.playerName',name);
    localStorage.setItem('hollow.settings',JSON.stringify({quality:'low',motion:false,effects:true,sensitivity:1,volume:0}));
  },name);
  await page.goto('/?qa=1');
  await page.waitForFunction(()=>!!window.HollowGame&&typeof window.HollowTest?.advance==='function');
}
async function snapshot(page){return page.evaluate(()=>HollowGame.snapshot());}
async function pose(page,position){await page.evaluate(position=>HollowTest.pose(position),position);}
async function advance(page,seconds){
  return page.evaluate(seconds=>{
    if(HollowGame.snapshot().network.inGame)throw new Error('Co-op must use real frames, not HollowTest.advance');
    HollowTest.advance(seconds);return HollowGame.snapshot();
  },seconds);
}
// A run starts with the sidearm alone; these checks cover the full kit, so the survivor is handed all three guns.
async function start(page){
  await ready(page);await page.locator('#startDarkBtn').click();
  await expect.poll(async()=>(await snapshot(page)).state).toBe('play');
  await page.evaluate(()=>{HollowTest.silence();HollowTest.arm();});
}
async function renderedFrames(page,count=2){
  const from=(await snapshot(page)).performance.frames;
  await expect.poll(async()=>(await snapshot(page)).performance.frames-from,{intervals:[100,250,500]}).toBeGreaterThanOrEqual(count);
}
function expectViewmodel(s,weapon){
  expect(s.weapon).toBe(weapon);
  expect(s.viewmodel).toEqual({weapons:[weapon],torch:false});
}
function pickup(s,item){return (typeof item.id==='number'?s.ammoPickups:s.loot).find(candidate=>candidate.id===item.id);}
async function inventory(page){
  // A full production-action cycle reads all reserves atomically and restores the selected weapon.
  const result=await page.evaluate(()=>{
    const inventory={};
    for(let i=0;i<3;i++){
      const s=HollowGame.snapshot();inventory[s.weapon]={mag:s.mag,reserve:s.reserve};
      HollowTest.action('weapon',true);
    }
    return inventory;
  });
  expect(Object.keys(result).sort()).toEqual(weaponKeys.map(([,id])=>id).sort());return result;
}
function expectReward(after,before,type){
  for(const [,id] of weaponKeys){
    expect(after[id].mag,`${id} magazine is not a pickup reward`).toBe(before[id].mag);
    expect(after[id].reserve,`${type} grants ${id} reserve once`).toBe(before[id].reserve+rewards[type][id]);
  }
}
async function pickupRoute(page,type){
  const route=await page.evaluate(type=>{
    const s=HollowGame.snapshot(),items=type==='ammo'?s.ammoPickups:s.loot.filter(item=>item.type===type);
    for(const item of items.filter(item=>!item.taken)){
      for(const [dx,dz] of [[0,1],[0,-1],[1,0],[-1,0]]){
        const approach={x:item.x+dx*1.45,z:item.z+dz*1.45,yaw:Math.atan2(dx,dz)};
        if(HollowTest.navClear(approach.x,approach.z,item.x,item.z,.32))return {item,approach};
      }
    }
    return null;
  },type);
  expect(route,`An untaken ${type} pickup has a clear, grounded approach`).toBeTruthy();return route;
}
async function healthCorner(page,s){
  const target=Number((s.injury*.98).toFixed(3));let visual;
  // The production overlay has a .2s CSS transition, independent of simulation time.
  await expect.poll(async()=>{
    visual=await page.evaluate(()=>{
      const css=getComputedStyle(document.getElementById('healthVignette'));
      return {opacity:Number(css.opacity),clear:parseFloat(css.getPropertyValue('--injury-clear')),visibility:css.visibility,display:css.display,background:css.backgroundImage,pointerEvents:css.pointerEvents};
    });
    return visual.opacity;
  },{intervals:[50,100,250]}).toBeCloseTo(target,3);
  expect(visual.visibility).toBe('visible');expect(visual.display).not.toBe('none');
  expect(visual.pointerEvents).toBe('none');
  expect(visual.clear).toBeCloseTo(65-s.injury*33,1);
  expect(visual.clear,'The aiming area stays clear').toBeGreaterThan(0);
  expect(visual.background).toContain('radial-gradient');
  expect(visual.background).toContain('rgba(166, 0, 16, 0.96)');
  return visual;
}

// Only transport delivery is delayed: both peers keep running production frames.
async function gateHostUpdates(guest){
  const gate={holding:false,held:[],requests:[],latest:null,socket:null};
  await guest.routeWebSocket('**/ws',socket=>{
    gate.socket=socket;const server=socket.connectToServer();
    socket.onMessage(message=>{
      const packet=JSON.parse(message.toString());
      if(packet.t==='presence'&&Array.isArray(packet.pr?.actions)){
        for(const action of packet.pr.actions)if(!gate.requests.some(previous=>previous.n===action.n))gate.requests.push(action);
      }
      server.send(message);
    });
    server.onMessage(message=>{
      const packet=JSON.parse(message.toString());
      if(packet.t==='peer'&&packet.pr?.role==='host'){
        gate.latest=packet.pr;
        if(gate.holding){gate.held.push(message);return;}
      }
      socket.send(message);
    });
  });
  return gate;
}
function releaseHostUpdates(gate){
  const messages=gate.held.splice(0);gate.holding=false;
  for(const message of messages)gate.socket.send(message);
  return messages;
}

test('keyboard switching, aiming, firing and reloading show only the selected weapon, never an offhand torch',async({page})=>{
  await start(page);expectViewmodel(await advance(page,.35),'rifle');
  for(const [key,id] of [['2','pistol'],['3','shotgun'],['1','rifle'],['q','pistol'],['q','shotgun'],['q','rifle']]){
    await page.keyboard.press(key);expectViewmodel(await advance(page,.3),id);
    await renderedFrames(page,1);
  }
  for(const on of [false,true]){
    await page.keyboard.press('f');const s=await advance(page,.05);
    expect(s.torchOn).toBe(on);expectViewmodel(s,'rifle');
  }
  await page.keyboard.press('2');const loaded=await advance(page,.3);
  await page.mouse.down({button:'right'});
  try{
    const aimed=await advance(page,.05);expect(aimed.aiming).toBe(true);expectViewmodel(aimed,'pistol');
    await page.mouse.down();await page.mouse.up();const fired=await advance(page,.1);
    expect(fired.mag).toBe(loaded.mag-1);expectViewmodel(fired,'pistol');
  }finally{await page.mouse.up({button:'right'});await page.mouse.up();}
  await page.keyboard.press('r');const reloading=await advance(page,.2);
  expect(reloading.reloadT).toBeGreaterThan(0);expectViewmodel(reloading,'pistol');
  const reloaded=await advance(page,3);
  expect(reloaded.mag).toBe(loaded.mag);expect(reloaded.reserve).toBe(loaded.reserve-1);expectViewmodel(reloaded,'pistol');
  await page.keyboard.press('Escape');await expect(page.locator('#pause')).toBeVisible();
  expectViewmodel(await snapshot(page),'pistol');
  await page.locator('#resumeBtn').click();await renderedFrames(page);
  expectViewmodel(await snapshot(page),'pistol');
});

test.describe('touch viewmodel',()=>{
  test.use({viewport:{width:844,height:390},deviceScaleFactor:1,isMobile:true,hasTouch:true});
  test('real weapon and torch taps keep exactly one weapon visible',async({page})=>{
    await ready(page);await page.locator('#startDarkBtn').tap();
    await expect.poll(async()=>(await snapshot(page)).state).toBe('play');
    await page.evaluate(()=>{HollowTest.silence();HollowTest.arm();});
    await expect(page.locator('#touchControls')).toBeVisible();
    expectViewmodel(await advance(page,.35),'rifle');
    for(const id of ['pistol','shotgun','rifle']){
      await page.locator('.touch-weapon').tap();expectViewmodel(await advance(page,.3),id);
      for(const on of [false,true]){
        await page.locator('.touch-torch').tap();const s=await advance(page,.05);
        expect(s.torchOn).toBe(on);expectViewmodel(s,id);
      }
      await renderedFrames(page,1);
    }
    const loaded=await snapshot(page);await page.locator('.touch-fire').tap();
    const fired=await advance(page,.15);expect(fired.mag).toBeLessThan(loaded.mag);expectViewmodel(fired,'rifle');
    await page.locator('.touch-reload').tap();const reloading=await advance(page,.2);
    expect(reloading.reloadT).toBeGreaterThan(0);expectViewmodel(reloading,'rifle');
    expectViewmodel(await advance(page,3),'rifle');
  });
});

test('walking over ammo and supplies grants exact rewards once, but nearby or airborne contact does not',async({page})=>{
  await start(page);
  for(const type of ['ammo','supplies']){
    const route=await pickupRoute(page,type),item=route.item;
    if(type==='supplies')await advance(page,10);
    const beforeInventory=await inventory(page),before=await snapshot(page);
    if(type==='supplies')expect(before.battery).toBeLessThan(.98);
    await pose(page,route.approach);const nearby=await advance(page,.3);
    expect(Math.hypot(nearby.position.x-item.x,nearby.position.z-item.z)).toBeGreaterThan(1.15);
    expect(pickup(nearby,item)).toMatchObject({taken:false,pending:false});

    await page.keyboard.press('Space');
    const airborne=await page.evaluate(({item,approach})=>{
      HollowTest.advance(.2);const jumped=HollowGame.snapshot();
      HollowTest.pose({x:item.x,z:item.z,y:jumped.position.y,yaw:approach.yaw});
      HollowTest.advance(.05);const over=HollowGame.snapshot();
      // Return to safety in this same task, before a real frame can land on the box.
      HollowTest.pose(approach);return {jumped,over};
    },route);
    expect(airborne.jumped.onGround).toBe(false);expect(airborne.jumped.position.y).toBeGreaterThan(.65);
    expect(airborne.over.onGround).toBe(false);expect(airborne.over.position.y).toBeGreaterThan(.65);
    expect(Math.hypot(airborne.over.position.x-item.x,airborne.over.position.z-item.z)).toBeLessThan(1.15);
    expect(pickup(airborne.over,item)).toMatchObject({taken:false,pending:false});
    expect(airborne.over.reserve).toBe(beforeInventory.rifle.reserve);expect(airborne.over.decoys).toBe(before.decoys);

    let collected;await page.keyboard.down('w');
    try{collected=await advance(page,.35);}finally{await page.keyboard.up('w');}
    expect(collected.onGround).toBe(true);expect(pickup(collected,item)).toMatchObject({taken:true,pending:false});
    expect(collected.decoys).toBe(before.decoys+(type==='supplies'?1:0));
    if(type==='supplies')expect(collected.battery).toBeGreaterThan(.99);
    else expect(collected.battery).toBeLessThanOrEqual(before.battery);
    const afterInventory=await inventory(page);expectReward(afterInventory,beforeInventory,type);
    await pose(page,route.approach);await advance(page,.1);
    await pose(page,{x:item.x,z:item.z});const revisited=await advance(page,2);
    expect(pickup(revisited,item)).toMatchObject({taken:true,pending:false});
    expect(revisited.decoys).toBe(collected.decoys);expect(await inventory(page)).toEqual(afterInventory);
  }
});

test('medical kits and fuses still require E, and a full-health kit is not consumed',async({page})=>{
  await start(page);
  const initial=await snapshot(page),medical=initial.loot.find(item=>item.id==='infirmary:medical'),fuse=initial.loot.find(item=>item.type==='fuse');
  expect(medical).toBeTruthy();expect(fuse).toBeTruthy();
  await page.evaluate(()=>HollowTest.health(50));
  for(const item of [medical,fuse]){
    await pose(page,{x:item.x,z:item.z});const contact=await advance(page,.4);
    expect(contact.onGround).toBe(true);expect(contact.position.y).toBeLessThan(.65);
    expect(Math.hypot(contact.position.x-item.x,contact.position.z-item.z)).toBeLessThan(1.15);
    expect(pickup(contact,item)).toMatchObject({taken:false,pending:false});
    expect(contact.health).toBe(item===medical?50:95);expect(contact.fuses).toBe(0);
    await page.keyboard.press('e');const used=await advance(page,.05);
    expect(pickup(used,item).taken).toBe(true);
    expect(used.health).toBe(95);expect(used.fuses).toBe(item===fuse?1:0);
    await page.keyboard.press('e');const repeated=await advance(page,.1);
    expect(repeated.health).toBe(used.health);expect(repeated.fuses).toBe(used.fuses);
  }
  const spare=initial.loot.find(item=>item.type==='medical'&&item.id!==medical.id);
  expect(spare).toBeTruthy();await page.evaluate(()=>HollowTest.health(100));
  await pose(page,{x:spare.x,z:spare.z});await advance(page,.2);await page.keyboard.press('e');
  expect(pickup(await snapshot(page),spare)).toMatchObject({taken:false,pending:false});
  await expect(page.locator('#msg')).toHaveText('Health is full. Save this kit for later.');
});

test('Warden damage and contact cannot shove a stationary player through an outer wall or corner',async({page})=>{
  await start(page);
  for(const fixture of [
    {name:'outer wall',player:{x:3.32,z:25.5},enemy:{x:4.48,z:25.5,state:'chase'}},
    {name:'outer corner',player:{x:3.32,z:3.32},enemy:{x:4.14,z:4.14,state:'chase'}}
  ]){
    const result=await page.evaluate(({player,enemy})=>{
      HollowTest.silence();HollowTest.health(100);HollowTest.pose(player);
      const before=HollowGame.snapshot();HollowTest.enemy(0,enemy);
      try{
        HollowTest.advance(.2);const after=HollowGame.snapshot();
        return {before,after,resolved:HollowTest.collide(after.position,.32)};
      }finally{HollowTest.silence();}
    },fixture);
    expect(result.after.state,fixture.name).toBe('play');expect(result.after.health,fixture.name).toBe(32);
    expect(result.after.position,`${fixture.name}: damage/contact is not a displacement force`).toEqual(result.before.position);
    expect(result.after.position.x).toBeGreaterThanOrEqual(3.32);
    expect(result.after.position.z).toBeGreaterThanOrEqual(3.32);
    expect(result.resolved,'The full .32m player circle remains outside world solids').toEqual(result.after.position);
  }
});

test('Warden contact damage cannot push a player across an E-closed isolation door',async({page})=>{
  await start(page);const door=(await snapshot(page)).doors[0];expect(door.open).toBe(true);
  const tangent={x:door.x,z:door.z-.46,yaw:Math.PI};
  await pose(page,tangent);await page.keyboard.press('e');
  await expect.poll(async()=>(await snapshot(page)).doors.find(item=>item.id===door.id).open).toBe(false);
  const result=await page.evaluate(({tangent,z})=>{
    HollowTest.silence();HollowTest.health(100);HollowTest.pose(tangent);
    const before=HollowGame.snapshot();HollowTest.enemy(0,{x:tangent.x,z,state:'chase',yaw:0});
    try{
      HollowTest.advance(.2);const after=HollowGame.snapshot();
      return {before,after,resolved:HollowTest.collide(after.position,.32)};
    }finally{HollowTest.silence();}
  },{tangent,z:door.z-1.55});
  expect(result.after.health).toBe(32);expect(result.after.state).toBe('play');
  expect(result.after.position,'Taking damage at the inside tangent cannot cross the door').toEqual(result.before.position);
  expect(result.after.position.z).toBeLessThanOrEqual(door.z-.445);
  expect(result.resolved).toEqual(result.after.position);
  const closed=result.after.doors.find(item=>item.id===door.id);
  expect(closed.open).toBe(false);expect(closed.health).toBeGreaterThan(0);
});

test('door closure corrects an embedded player before monster rollback and blocks forward walking',async({page})=>{
  await start(page);
  const result=await page.evaluate(()=>{
    HollowTest.silence();const door=HollowGame.snapshot().doors[0];
    HollowTest.pose({x:door.x,z:door.z+.05,yaw:0});HollowTest.action('interact',true);
    // The nearest world correction points toward the attacker, exercising rollback rather than a free escape.
    HollowTest.enemy(0,{x:door.x,z:door.z+.75,state:'chase',yaw:Math.PI});
    try{
      HollowTest.advance(.1);const after=HollowGame.snapshot();
      return {door,after,resolved:HollowTest.collide(after.position)};
    }finally{HollowTest.silence();}
  });
  const clearance=.125+.32,epsilon=1e-6;
  expect(result.door.open).toBe(true);expect(result.after.state).toBe('play');
  expect(result.after.enemies[0]).toMatchObject({kind:'warden',dead:false});
  expect(result.after.enemies[0].z).toBeGreaterThan(result.door.z);
  expect(result.after.doors.find(door=>door.id===result.door.id).open).toBe(false);
  expect(result.after.position.x).toBeCloseTo(result.door.x,6);
  expect(result.after.position.z-result.door.z,'Rollback must retain a world-valid point on the nearest side').toBeGreaterThanOrEqual(clearance-epsilon);
  expect(result.resolved,'Resolving the corrected player again must be a no-op').toEqual(result.after.position);

  let walking;await page.keyboard.down('w');
  try{
    walking=await page.evaluate(()=>{
      const from=HollowGame.snapshot().simulationTime;HollowTest.advance(.8);const after=HollowGame.snapshot();
      return {from,after,resolved:HollowTest.collide(after.position)};
    });
  }finally{await page.keyboard.up('w');}
  expect(walking.after.simulationTime-walking.from).toBeGreaterThanOrEqual(.8-epsilon);
  expect(walking.after.position.x).toBeCloseTo(result.door.x,6);
  expect(walking.after.position.z-result.door.z,'Forward walking cannot cross the closed panel').toBeGreaterThanOrEqual(clearance-epsilon);
  expect(walking.resolved).toEqual(walking.after.position);
  const closed=walking.after.doors.find(door=>door.id===result.door.id);
  expect(closed.open).toBe(false);expect(closed.health).toBeGreaterThan(0);
});

test('pickup reach cannot skip a thin closed door at local or host tolerance',async({page})=>{
  await start(page);
  const fixture=await page.evaluate(()=>{
    const door=HollowGame.snapshot().doors[0];
    const item={x:door.x,z:door.z-.43},player={x:door.x,z:door.z+.71,y:0};
    HollowTest.pose({...player,yaw:0});
    return {door,item,player,local:HollowTest.pickupReach(item,player),host:HollowTest.pickupReach(item,player,1.6)};
  });
  expect(fixture.door.open).toBe(true);
  const distance=Math.hypot(fixture.item.x-fixture.player.x,fixture.item.z-fixture.player.z);
  expect(distance).toBeCloseTo(1.14,6);expect(distance).toBeLessThan(1.15);
  expect([fixture.local,fixture.host],'The open doorway is reachable at both pickup radii').toEqual([true,true]);
  await page.keyboard.press('e');
  const blocked=await page.evaluate(({door,item,player})=>({
    door:HollowGame.snapshot().doors.find(candidate=>candidate.id===door.id),
    local:HollowTest.pickupReach(item,player),host:HollowTest.pickupReach(item,player,1.6)
  }),fixture);
  expect(blocked.door.open).toBe(false);expect(blocked.door.health).toBeGreaterThan(0);
  expect([blocked.local,blocked.host],'The 1.14m segment must not skip the .25m panel, even with host tolerance').toEqual([false,false]);
});

test('red health corners intensify with damage, persist without danger, survive reduced effects/motion, and heal/reset',async({page})=>{
  await start(page);let current=await advance(page,.05),previous=await healthCorner(page,current);
  expect(current.health).toBe(100);expect(current.injury).toBe(0);expect(previous.opacity).toBe(0);
  for(const health of [68,36,4]){
    current=await page.evaluate(()=>{
      HollowTest.silence();HollowTest.advance(1.2);HollowTest.pose({x:45,z:55,yaw:Math.PI});
      HollowTest.enemy(1,{x:45,z:54,state:'chase',yaw:0});
      try{HollowTest.advance(.2);return HollowGame.snapshot();}finally{HollowTest.silence();}
    });
    expect(current.health).toBe(health);expect(current.state).toBe('play');
    const visual=await healthCorner(page,current);
    expect(visual.opacity).toBeGreaterThan(previous.opacity);expect(visual.clear).toBeLessThan(previous.clear);previous=visual;
  }
  const persistent=await advance(page,8);await renderedFrames(page);
  expect(persistent.health).toBe(4);expect(persistent.injury).toBe(current.injury);
  expect((await healthCorner(page,persistent)).opacity).toBe(previous.opacity);
  await expect.poll(()=>page.locator('#danger').evaluate(node=>Number(getComputedStyle(node).opacity))).toBeLessThan(.01);
  await expect(page.locator('#flash')).toHaveCSS('opacity','0');

  await page.keyboard.press('Escape');await page.locator('#settingsEffects').uncheck();await page.locator('#resumeBtn').click();
  expect((await snapshot(page)).horror.effects).toBe(false);await healthCorner(page,persistent);
  for(const selector of ['#danger','#flash'])await expect(page.locator(selector)).toHaveCSS('visibility','hidden');
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.keyboard.press('Escape');await page.locator('#settingsEffects').check();await page.locator('#resumeBtn').click();
  expect((await snapshot(page)).horror.effects).toBe(true);
  expect(await page.evaluate(()=>matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
  await healthCorner(page,persistent);await expect(page.locator('#healthVignette')).toHaveCSS('transition-duration','0s');
  for(const selector of ['#danger','#flash'])await expect(page.locator(selector)).toHaveCSS('visibility','hidden');

  const kits=(await snapshot(page)).loot.filter(item=>item.type==='medical').slice(0,3);
  expect(kits).toHaveLength(3);
  for(const kit of kits){
    const contact=await page.evaluate(kit=>{
      HollowTest.pose({x:kit.x,z:kit.z+1});HollowTest.advance(.2);return HollowGame.snapshot();
    },kit);
    expect(pickup(contact,kit).taken).toBe(false);expect(contact.health).toBe(current.health);
    await page.keyboard.press('e');current=await advance(page,.05);
    expect(current.health).toBe(Math.min(100,contact.health+45));expect(pickup(current,kit).taken).toBe(true);
    const healed=await healthCorner(page,current);expect(healed.opacity).toBeLessThan(previous.opacity);previous=healed;
  }
  expect(current.health).toBe(100);expect(current.injury).toBe(0);expect(previous.opacity).toBe(0);expect(previous.clear).toBe(65);
  const dirty=await page.evaluate(()=>{HollowTest.health(20);HollowTest.advance(.05);return HollowGame.snapshot();});
  expect((await healthCorner(page,dirty)).opacity).toBeGreaterThan(0);
  await page.keyboard.press('Escape');await page.locator('#pauseMenuBtn').click();
  await expect(page.locator('#menu')).toBeVisible();await expect(page.locator('#healthVignette')).toHaveCSS('opacity','0');
  await page.locator('#startDarkBtn').click();await page.evaluate(()=>HollowTest.silence());
  const reset=await advance(page,.05);expect(reset.state).toBe('play');expect(reset.health).toBe(100);expect(reset.injury).toBe(0);
  expect((await healthCorner(page,reset)).opacity).toBe(0);
});

test('an unseen Stalker approaches quietly, pauses when watched, then rushes instead of freezing forever',async({page})=>{
  await start(page);
  const result=await page.evaluate(()=>{
    HollowTest.silence();HollowTest.pose({x:45,z:55,yaw:Math.PI});HollowTest.torch(true);
    HollowTest.enemy(1,{x:45,z:49,yaw:0});
    // Sample speed after full ticks, not a floating-point remainder at the end of a duration.
    const step=count=>{for(let i=0;i<count;i++)HollowTest.advance(.05);};
    try{
      step(4);const unseen=HollowGame.snapshot();
      step(12);const approaching=HollowGame.snapshot();
      HollowTest.pose({x:45,z:55,yaw:0});
      step(5);const watched=HollowGame.snapshot();
      step(17);const waiting=HollowGame.snapshot();
      step(8);const rushing=HollowGame.snapshot();
      return {unseen,approaching,watched,waiting,rushing};
    }finally{HollowTest.silence();}
  });
  for(const s of [result.unseen,result.approaching,result.watched,result.waiting]){
    expect(s.enemies[1].kind).toBe('stalker');expect(s.enemies[1].state).toBe('stalk');expect(s.health).toBe(100);
    expect(s.audio,'The real audio engine is initialized').not.toBeNull();
    expect(s.audio.voices.filter(voice=>voice.kind==='stalker'&&voice.cue==='notice')).toEqual([]);
  }
  const unseen=result.unseen.enemies[1],approaching=result.approaching.enemies[1],watched=result.watched.enemies[1],waiting=result.waiting.enemies[1],rushing=result.rushing.enemies[1];
  expect(approaching.watchTime).toBe(0);expect(approaching.stalkTime).toBeGreaterThan(unseen.stalkTime);
  expect(approaching.z).toBeGreaterThan(unseen.z);expect(approaching.moveSpeed).toBeCloseTo(1.7,4);
  expect(watched.watchTime).toBeGreaterThan(0);expect(waiting.watchTime).toBeLessThan(1.35);
  for(const m of [watched,waiting]){
    expect(m.x).toBeCloseTo(approaching.x,6);expect(m.z).toBeCloseTo(approaching.z,6);expect(m.moveSpeed).toBe(0);
  }
  expect(rushing.state).toBe('chase');expect(rushing.watchTime).toBeGreaterThanOrEqual(1.35-1e-6);
  expect(rushing.moveSpeed).toBeGreaterThan(approaching.moveSpeed);expect(rushing.z).toBeGreaterThan(waiting.z);
  expect(result.rushing.audio.voices.some(voice=>voice.kind==='stalker'&&voice.cue==='notice')).toBe(true);
  expect(result.rushing.health).toBe(100);
});

test('Stalkers and Crawlers save the notice cue for close-range commitment, with a slower Crawler stalk',async({page})=>{
  await start(page);
  for(const fixture of [{index:1,kind:'stalker',range:3.1,speed:1.7},{index:2,kind:'crawler',range:2.6,speed:.9}]){
    const result=await page.evaluate(({index,range})=>{
      HollowTest.silence();HollowTest.pose({x:45,z:55,yaw:Math.PI});HollowTest.torch(true);
      HollowTest.enemy(index,{x:45,z:55-range-.2,yaw:0});
      try{
        HollowTest.advance(.05);const stalking=HollowGame.snapshot(),m=stalking.enemies[index];
        HollowTest.pose({x:m.x,z:m.z+range-.2,yaw:Math.PI});
        HollowTest.advance(.1);return {stalking,rushing:HollowGame.snapshot()};
      }finally{HollowTest.silence();}
    },fixture);
    const quiet=result.stalking.enemies[fixture.index],loud=result.rushing.enemies[fixture.index];
    expect(quiet.kind).toBe(fixture.kind);expect(quiet.state).toBe('stalk');expect(quiet.watchTime).toBe(0);
    expect(quiet.moveSpeed).toBeCloseTo(fixture.speed,4);
    expect(result.stalking.audio).not.toBeNull();expect(result.rushing.audio).not.toBeNull();
    expect(result.stalking.audio.voices.some(voice=>voice.kind===fixture.kind&&voice.cue==='notice')).toBe(false);
    expect(loud.state).toBe('chase');expect(loud.moveSpeed).toBeGreaterThan(quiet.moveSpeed);
    expect(result.rushing.audio.voices.some(voice=>voice.kind===fixture.kind&&voice.cue==='notice')).toBe(true);
    expect(result.rushing.health).toBe(100);
  }
});

test('an unwatched Stalker eventually abandons stalking even when kept outside its rush radius',async({page})=>{
  await start(page);
  const result=await page.evaluate(()=>{
    HollowTest.silence();HollowTest.pose({x:45,z:36,yaw:Math.PI});HollowTest.torch(true);
    const clear=HollowTest.navClear(45,30,45,60,.34);HollowTest.enemy(1,{x:45,z:30,yaw:0});
    try{
      // Follow the open central spine six metres ahead; never reset the enemy's AI timers.
      const retreat=()=>{const m=HollowGame.snapshot().enemies[1];HollowTest.pose({x:45,z:m.z+6,yaw:Math.PI});HollowTest.advance(.1);};
      for(let i=0;i<119;i++)retreat();const waiting=HollowGame.snapshot();
      for(let i=0;i<4;i++)retreat();return {clear,waiting,rushing:HollowGame.snapshot()};
    }finally{HollowTest.silence();}
  });
  expect(result.clear,'The timeout fixture stays in a traversable central corridor').toBe(true);
  const waiting=result.waiting.enemies[1],rushing=result.rushing.enemies[1];
  expect(waiting.state).toBe('stalk');expect(waiting.stalkTime).toBeCloseTo(11.9,3);expect(waiting.watchTime).toBe(0);
  expect(result.waiting.audio).not.toBeNull();expect(result.waiting.audio.voices.some(voice=>voice.cue==='notice')).toBe(false);
  expect(rushing.state).toBe('chase');expect(rushing.stalkTime).toBeGreaterThanOrEqual(12);
  expect(rushing.watchTime).toBe(0);expect(rushing.moveSpeed).toBeGreaterThan(waiting.moveSpeed);
  expect(Math.hypot(result.rushing.position.x-rushing.x,result.rushing.position.z-rushing.z)).toBeGreaterThan(3.1);
  expect(result.rushing.audio.voices.some(voice=>voice.kind==='stalker'&&voice.cue==='notice')).toBe(true);
  expect(result.rushing.health).toBe(100);
});

test('two real peers receive automatic pickups only after host confirmation, once, and never share a stale claim',async({browser})=>{
  test.setTimeout(240000);
  const contexts=await Promise.all([browser.newContext({viewport:{width:800,height:520}}),browser.newContext({viewport:{width:800,height:520}})]);
  const [host,guest]=await Promise.all(contexts.map(context=>context.newPage()));
  try{
    const gate=await gateHostUpdates(guest);
    await Promise.all([ready(host,'Survival host'),ready(guest,'Survival guest')]);
    await host.locator('#coopBtn').click();await host.locator('#coopCreate').click();await expect(host.locator('#coopLobby')).toBeVisible();
    const code=await host.locator('#coopCode').textContent();
    await guest.locator('#coopBtn').click();await guest.locator('#coopCodeIn').fill(code);await guest.locator('#coopJoinForm button').click();
    await expect(host.locator('#coopStart')).toBeEnabled();await host.locator('#coopStart').click();
    await Promise.all([host,guest].map(page=>expect.poll(async()=>(await snapshot(page)).state).toBe('play')));
    const initialHost=await snapshot(host),initialGuest=await snapshot(guest);
    expect(initialHost.network).toMatchObject({role:'host',inGame:true,partner:true});
    expect(initialGuest.network).toMatchObject({role:'guest',inGame:true,partner:true});expect(initialGuest.seed).toBe(initialHost.seed);
    expect(initialGuest.ammoPickups).toEqual(initialHost.ammoPickups);
    await host.evaluate(()=>{HollowTest.silence();HollowTest.torch(false);HollowTest.arm();});
    await guest.evaluate(()=>{HollowTest.torch(false);HollowTest.arm();});
    await expect.poll(async()=>(await snapshot(guest)).enemies.every(enemy=>enemy.dead)).toBe(true);
    let hostInventory=await inventory(host),guestInventory=await inventory(guest);
    const collected=[];

    for(const type of ['ammo','supplies']){
      const {item}=await pickupRoute(host,type),grantId=type==='ammo'?'ammo:'+item.id:item.id;
      const beforeHost=await snapshot(host),beforeGuest=await snapshot(guest);
      gate.holding=true;gate.held.length=0;
      await pose(guest,{x:item.x,z:item.z});
      await expect.poll(async()=>pickup(await snapshot(guest),item).pending).toBe(true);
      await expect.poll(async()=>pickup(await snapshot(host),item).taken).toBe(true);
      await expect.poll(()=>!!gate.latest?.grants?.some(grant=>grant.id===grantId)).toBe(true);
      await renderedFrames(guest,2);
      const pending=await snapshot(guest);
      expect(pickup(pending,item),'The guest has not optimistically consumed the pickup').toMatchObject({taken:false,pending:true});
      expect(await inventory(guest),'No reserve reward before host confirmation').toEqual(guestInventory);
      expect(pending.decoys).toBe(beforeGuest.decoys);
      const actionType=type==='ammo'?'ammo':'loot';
      expect(gate.requests.filter(action=>action.type===actionType&&action.id===item.id),'One automatic request remains pending').toHaveLength(1);
      const confirmation=gate.held[gate.held.length-1];expect(confirmation).toBeDefined();
      releaseHostUpdates(gate);
      await expect.poll(async()=>{const p=pickup(await snapshot(guest),item);return p.taken&&!p.pending;}).toBe(true);
      const awarded=await inventory(guest);expectReward(awarded,guestInventory,type);
      expect(await inventory(host),'The host does not also receive the guest reward').toEqual(hostInventory);
      const afterGuest=await snapshot(guest);
      expect(afterGuest.decoys).toBe(beforeGuest.decoys+(type==='supplies'?1:0));expect((await snapshot(host)).decoys).toBe(beforeHost.decoys);
      // Replay an actual authoritative presence packet, including the same grant id.
      for(let i=0;i<3;i++)gate.socket.send(confirmation);
      await renderedFrames(guest,3);
      expect(await inventory(guest),'Repeated host grants must be idempotent').toEqual(awarded);
      expect((await snapshot(guest)).decoys).toBe(afterGuest.decoys);
      guestInventory=awarded;collected.push(item);
    }

    const {item}=await pickupRoute(host,'supplies'),beforeHost=await snapshot(host),beforeGuest=await snapshot(guest);
    gate.holding=true;gate.held.length=0;
    await pose(host,{x:item.x,z:item.z});await expect.poll(async()=>pickup(await snapshot(host),item).taken).toBe(true);
    expect(pickup(await snapshot(guest),item).taken,'The competing guest still sees the old world state').toBe(false);
    await pose(guest,{x:item.x,z:item.z});await expect.poll(async()=>pickup(await snapshot(guest),item).pending).toBe(true);
    await expect.poll(()=>gate.requests.some(action=>action.type==='loot'&&action.id===item.id)).toBe(true);
    const claim=gate.requests.find(action=>action.type==='loot'&&action.id===item.id);
    await expect.poll(()=>gate.latest?.ack||0).toBeGreaterThanOrEqual(claim.n);
    expect(gate.latest.grants.some(grant=>grant.id===item.id),'A host-owned pickup produces no guest grant').toBe(false);
    expect(await inventory(guest)).toEqual(guestInventory);expect((await snapshot(guest)).decoys).toBe(beforeGuest.decoys);
    releaseHostUpdates(gate);
    await expect.poll(async()=>{const p=pickup(await snapshot(guest),item);return p.taken&&!p.pending;}).toBe(true);
    const awardedHost=await inventory(host);expectReward(awardedHost,hostInventory,'supplies');hostInventory=awardedHost;
    expect((await snapshot(host)).decoys).toBe(beforeHost.decoys+1);expect(await inventory(guest)).toEqual(guestInventory);
    collected.push(item);
    for(const item of collected){
      await Promise.all([host,guest].map(page=>pose(page,{x:item.x,z:item.z})));
      await Promise.all([host,guest].map(page=>renderedFrames(page,2)));
      for(const page of [host,guest])expect(pickup(await snapshot(page),item)).toMatchObject({taken:true,pending:false});
    }
    expect(await inventory(host)).toEqual(hostInventory);expect(await inventory(guest)).toEqual(guestInventory);
    expect((await snapshot(host)).decoys).toBe(beforeHost.decoys+1);expect((await snapshot(guest)).decoys).toBe(beforeGuest.decoys);
    for(const [page,initial] of [[host,initialHost],[guest,initialGuest]]){
      const final=await snapshot(page);expect(final.health).toBe(100);expect(final.state).toBe('play');
      expect(final.performance.frames).toBeGreaterThan(initial.performance.frames);expect(final.simulationTime).toBeGreaterThan(initial.simulationTime);
    }
  }finally{await Promise.all(contexts.map(context=>context.close()));}
});
