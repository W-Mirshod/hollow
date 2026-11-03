const {test,expect}=require('@playwright/test');

// FEEL: HollowLocomotion (sprint ramp, stamina, exhaustion) and the HollowCameraFX rig, driven deterministically
// through HollowTest.advance with keys held down. Design numbers: RULES.PLAYER (walk 3, run 6.8, crouch 1.5, aim 2.1).
test.setTimeout(120000);
test.use({viewport:{width:640,height:400}});

let pages=[];
test.beforeEach(()=>{pages=[];});
test.afterEach(()=>expect(pages.flatMap(page=>page.hollowErrors),'No uncaught errors or console errors').toEqual([]));

async function start(page,motion=true){
  page.hollowErrors=[];pages.push(page);
  page.on('pageerror',error=>page.hollowErrors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')page.hollowErrors.push(message.text());});
  await page.addInitScript(motion=>{
    localStorage.setItem('hollow.playerName','Feel QA');
    localStorage.setItem('hollow.settings',JSON.stringify({quality:'low',motion,effects:true,sensitivity:1,volume:0}));
  },motion);
  await page.goto('/?qa=1');
  await page.waitForFunction(()=>!!window.HollowGame&&typeof window.HollowTest?.advance==='function');
  await page.locator('#startDarkBtn').click();
  await expect.poll(()=>page.evaluate(()=>HollowGame.snapshot().state)).toBe('play');
  await page.evaluate(()=>{HollowTest.silence();HollowTest.pose({x:45,z:55,yaw:0});});
}
// Re-poses into the clear corridor between chunks so long runs never meet a wall; locomotion state is kept.
const advance=(page,seconds)=>page.evaluate(seconds=>{HollowTest.advance(seconds);return HollowGame.snapshot();},seconds);
const repose=page=>page.evaluate(()=>{const s=HollowGame.snapshot();HollowTest.pose({x:45,z:55,yaw:0});return s;});

test('walk 3.0 m/s, sprint ramps to 6.8 m/s, exhaustion after ~7 s slows to 2.55 until stamina recovers',async({page})=>{
  await start(page);
  await page.keyboard.down('w');
  const walk=await advance(page,1);
  expect(walk.player.speed,'walking speed is RULES.PLAYER.walk').toBeCloseTo(3,1);
  expect(walk.running).toBe(false);
  await page.keyboard.down('Shift');
  const ramp=await advance(page,.2);
  expect(ramp.running,'sprint starts immediately').toBe(true);
  expect(ramp.player.speed,'sprint eases in over .45 s, not instantly').toBeLessThan(6.6);
  const sprint=await advance(page,.6);
  expect(sprint.player.speed,'full sprint is RULES.PLAYER.run').toBeCloseTo(6.8,1);
  expect(sprint.player.sprint).toBeGreaterThan(.99);
  let s=sprint;
  for(let i=0;i<5;i++){await repose(page);s=await advance(page,1);}
  expect(s.player.exhausted,'still sprinting at ~6 s').toBe(false);
  expect(s.stamina).toBeLessThan(.25);
  await repose(page);s=await advance(page,2);
  expect(s.player.exhausted,'a full stamina bar lasts ~7 s of sprint').toBe(true);
  expect(s.running).toBe(false);
  expect(s.player.speed,'exhausted walk is walk x .85').toBeCloseTo(2.55,1);
  await page.keyboard.up('Shift');
  await repose(page);s=await advance(page,2);
  expect(s.player.exhausted,'recovery needs stamina >= .35 (after a .6 s delay, 1/8 per s while moving)').toBe(true);
  await repose(page);s=await advance(page,1.6);
  expect(s.player.exhausted,'recovered once stamina reaches .35').toBe(false);
  expect(s.player.speed).toBeCloseTo(3,1);
  await page.keyboard.up('w');
});

test('crouch moves at 1.5 m/s and aiming at 2.1 m/s',async({page})=>{
  await start(page);
  await page.keyboard.down('w');await page.keyboard.down('c');
  const crouch=await advance(page,1);
  expect(crouch.crouching).toBe(true);expect(crouch.player.speed).toBeCloseTo(1.5,1);
  await page.keyboard.up('c');
  await page.evaluate(()=>HollowTest.action('aim',true));
  const aim=await advance(page,1);
  expect(aim.aiming).toBe(true);expect(aim.player.speed).toBeCloseTo(2.1,1);
  await page.evaluate(()=>HollowTest.action('aim',false));await page.keyboard.up('w');
});

async function bobRange(page){
  return page.evaluate(()=>{let lo=1,hi=-1,roll=0,steps=HollowGame.snapshot().camera.steps,fov=0;
    for(let i=0;i<40;i++){HollowTest.advance(.05);const c=HollowGame.snapshot().camera;lo=Math.min(lo,c.y);hi=Math.max(hi,c.y);roll=Math.max(roll,Math.abs(c.roll));fov=Math.max(fov,c.fovAdd);}
    const c=HollowGame.snapshot().camera;return {range:hi-lo,lo,hi,roll,fov,steps:c.steps-steps};});
}

test('camera rig bobs while walking and sprinting with motion on; recoil kicks the view',async({page})=>{
  await start(page,true);
  const still=await bobRange(page);
  expect(still.range,'standing still barely moves').toBeLessThan(.005);
  expect(still.steps).toBe(0);
  await page.keyboard.down('w');
  const walk=await bobRange(page);
  expect(walk.range,'walking bob ~2.5 cm').toBeGreaterThan(.01);
  expect(walk.steps,'footsteps plant while walking').toBeGreaterThanOrEqual(2);
  await page.keyboard.down('Shift');await repose(page);
  const run=await bobRange(page);
  expect(run.range,'sprint bob is larger than walk bob').toBeGreaterThan(walk.range);
  expect(run.fov,'sprint widens the FOV').toBeGreaterThan(4);
  await page.keyboard.up('Shift');await page.keyboard.up('w');
  await page.evaluate(()=>HollowTest.advance(1));
  const before=await page.evaluate(()=>HollowGame.snapshot().mag);
  const kicked=await page.evaluate(()=>{HollowTest.action('fire',true);HollowTest.advance(.1);HollowTest.action('fire',false);return HollowGame.snapshot();});
  expect(kicked.mag,'one shot fired').toBeLessThan(before);
  expect(kicked.camera.kickPitch,'recoil kicks the camera up').toBeGreaterThan(.004);
  expect(kicked.camera.weaponZ,'the weapon recoils back toward the camera').toBeGreaterThan(.005);
  const position=kicked.position;
  const settled=await advance(page,.5);
  expect(settled.camera.kickPitch,'kick recovers').toBeLessThan(.002);
  expect(settled.position.x,'the rig never moves the player').toBeCloseTo(position.x,5);
});

test('with motion off the camera is static but footsteps still plant',async({page})=>{
  await start(page,false);
  await page.keyboard.down('w');await page.keyboard.down('Shift');
  const run=await bobRange(page);
  await page.keyboard.up('Shift');await page.keyboard.up('w');
  expect(run.range).toBe(0);expect(run.roll).toBe(0);expect(run.fov).toBe(0);
  expect(run.steps,'footstep events still occur').toBeGreaterThanOrEqual(2);
});

test('a Stalker in chase with a clear line at 3.5 m lunges faster than its chase speed, without first-frame damage',async({page})=>{
  await start(page);
  const s=await page.evaluate(()=>{
    HollowTest.torch(true);HollowTest.pose({x:45,z:55,yaw:0});
    const index=HollowGame.snapshot().enemies.find(e=>e.kind==='stalker').index;
    HollowTest.enemy(index,{x:45,z:51.5,yaw:0,state:'chase'});
    HollowTest.advance(.05);const s=HollowGame.snapshot();return {s,index};
  });
  const enemy=s.s.enemies.find(e=>e.index===s.index);
  expect(enemy.state).toBe('chase');
  expect(enemy.lunge,'a clear 3.5 m line inside lungeRange (4.4 m) starts a lunge').toBe(true);
  expect(enemy.lungeCooldown,'the lunge arms its cooldown').toBeGreaterThan(2.5);
  expect(enemy.moveSpeed,'lunge speed is chase x lungeSpeed (5.5 x 1.5)').toBeGreaterThan(enemy.speed*1.2);
  expect(s.s.health,'the lunge itself does no damage on its first frame').toBe(100);
  expect(s.s.camera.trauma,'a lunge within 4 m shakes the camera').toBeGreaterThan(.2);
  await page.evaluate(()=>HollowTest.silence());
});

test('a killed Stalker falls and lies on the floor',async({page})=>{
  await start(page);
  const r=await page.evaluate(()=>{
    HollowTest.pose({x:45,z:55,yaw:0});
    const index=HollowGame.snapshot().enemies.find(e=>e.kind==='stalker').index;
    HollowTest.freezeAI(true);HollowTest.enemy(index,{x:45,z:50,yaw:0,state:'wander'});
    HollowTest.advance(.1);HollowTest.hit(index,100);HollowTest.advance(.3);
    const falling=HollowGame.snapshot().enemies.find(e=>e.index===index);
    HollowTest.advance(4);HollowTest.freezeAI(false);
    return {falling,lying:HollowGame.snapshot().enemies.find(e=>e.index===index)};
  });
  expect(r.falling.dead).toBe(true);expect(r.falling.anim.dying,'the death animation is playing').toBe(1);
  const e=r.lying;
  expect(e.anim.settled,'the body has come to rest').toBe(1);
  expect(Math.max(Math.abs(e.anim.pitch),Math.abs(e.anim.roll)),'the body is lying down, not standing').toBeGreaterThan(1);
  expect(Math.abs(e.anim.lowest),'the body rests on the floor (within 12 cm)').toBeLessThan(.12);
});
