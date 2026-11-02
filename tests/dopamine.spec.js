const {test,expect}=require('@playwright/test');
const {CELL}=require('../public/systems');

test.setTimeout(180000);
test.use({screenshot:'off',trace:'off'});

let errors=[];
test.beforeEach(({page})=>{
  errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
});
test.afterEach(()=>expect(errors,'No console errors').toEqual([]));

async function ready(page,settings){
  await page.addInitScript(settings=>{
    localStorage.setItem('hollow.playerName','Dopamine QA');
    localStorage.setItem('hollow.settings',JSON.stringify(settings));
  },{quality:'low',motion:true,sensitivity:1,volume:0,effects:true,...settings});
  await page.goto('/?qa=1');
  await page.waitForFunction(()=>!!window.HollowTest&&!!window.HollowGame);
  await page.locator('#startDarkBtn').click();
  await expect.poll(()=>page.evaluate(()=>HollowGame.snapshot().state)).toBe('play');
  await page.evaluate(()=>HollowTest.silence());
}

// Runs a whole seeded chase inside one evaluate, so real frames cannot interleave with the director.
async function chase(page){
  return page.evaluate(cell=>{
    const T=HollowTest,G=HollowGame;
    T.build(4242);T.silence();T.torch(false);
    const room=G.snapshot().rooms.filter(r=>!r.shelter).sort((a,b)=>b.w*b.d-a.w*a.d)[0];
    const x=(room.x+room.w/2)*cell,z=(room.z+room.d/2)*cell;
    T.pose({x,z,yaw:0});T.advance(.3);
    T.enemy(1,{x,z:z-4.5,state:'chase',yaw:0});
    const samples=[],banners=new Set();
    for(let i=0;i<70;i++){
      T.health(100);T.advance(.1);
      const s=G.snapshot();
      samples.push({lights:s.chaosLights,visible:s.lighting.map(l=>l.visible),chasing:s.chaos.chasing,emergency:s.dopamine.emergency,live:s.dopamine.liveEmissive});
      if(s.hud.banner)banners.add(s.hud.banner);
    }
    const end=G.snapshot();T.silence();
    return {room:room.id,samples,banners:[...banners],chaos:end.chaos,intensity:end.chaosIntensity,beacons:end.beacons,liveBase:end.dopamine.liveBase,state:end.state};
  },CELL);
}

test('chases make the practical lights stutter within bounds, without visibility toggles, and announce the threat',async({page})=>{
  await ready(page,{effects:true});
  const run=await chase(page);
  expect(run.state).toBe('play');
  expect(run.chaos.chases,'a chase was observed').toBeGreaterThanOrEqual(1);
  expect(run.samples.some(s=>s.chasing)).toBe(true);
  expect(run.banners).toContain('IT SEES YOU');
  const visibility=JSON.stringify(run.samples[0].visible);
  for(const s of run.samples)expect(JSON.stringify(s.visible),'lights never toggle visibility').toBe(visibility);
  const lit=run.samples.flatMap(s=>s.lights.filter(l=>l.visible&&l.base>0));
  expect(lit.length).toBeGreaterThan(0);
  for(const l of lit){expect(l.level).toBeGreaterThanOrEqual(0);expect(l.level).toBeLessThanOrEqual(1.25*l.base+1e-9);}
  const levels=run.samples.map(s=>s.lights[0]).filter(l=>l.visible&&l.base>0&&!l.shelter).map(l=>l.level/l.base);
  expect(levels.length).toBeGreaterThan(30);
  expect(Math.max(...levels)-Math.min(...levels),'the nearest practical light varies').toBeGreaterThan(.01);
  expect(Math.max(...run.samples.map(s=>s.emergency)),'emergency mood builds in a chase').toBeGreaterThan(.3);
  const live=run.samples.map(s=>s.live);
  expect(Math.max(...live)-Math.min(...live),'the ward strips flicker with the lights').toBeGreaterThan(0);
  expect(run.beacons).toHaveLength(2);
  expect(run.beacons[0].on).toBe(true);
  console.log('chase room',run.room,'events',JSON.stringify({surges:run.chaos.surges,blackouts:run.chaos.blackouts,sparks:run.chaos.sparks}),
    'stutters',levels.filter(k=>k<.5).length,'of',levels.length,'range',Math.min(...levels).toFixed(3),Math.max(...levels).toFixed(3));
});

test('with effects off the lights hold their exact base level, nothing blacks out and banners stay calm',async({page})=>{
  await ready(page,{effects:false});
  const run=await chase(page);
  expect(run.chaos.chases).toBeGreaterThanOrEqual(1);
  expect(run.banners).toContain('IT SEES YOU');
  for(const s of run.samples){
    for(const l of s.lights)if(l.base!==null)expect(l.level).toBe(l.base);
    expect(s.emergency).toBe(0);
    expect(s.live).toBe(run.liveBase);
  }
  expect(run.chaos.blackouts).toBe(0);
  expect(run.chaos.blackoutLevel).toBe(0);
  expect(run.beacons[0].intensity).toBeLessThanOrEqual(.35+1e-6);
  const banner=await page.evaluate(()=>{
    const T=HollowTest,fuse=HollowGame.snapshot().loot.find(l=>l.type==='fuse');
    T.pose({x:fuse.x,z:fuse.z+1,yaw:0});T.advance(.15);T.action('interact',true);T.advance(.05);
    const s=HollowGame.snapshot();return {fuses:s.fuses,banner:s.hud.banner,calm:document.querySelector('#hud .hfx-layer').classList.contains('hfx-calm')};
  });
  expect(banner).toEqual({fuses:1,banner:'FUSE 1/3',calm:true});
});

test('a real shotgun headshot kills a crawler with HEADSHOT, points, score and solo hitstop; a second kill is a DOUBLE KILL',async({page})=>{
  await ready(page,{effects:true});
  const shots=await page.evaluate(()=>{
    const T=HollowTest,G=HollowGame,x=45,z=55,crawlerZ=51.5;
    T.silence();T.torch(false);
    T.action('weapon',true);T.action('weapon',true);T.action('aim',true);T.advance(.3);
    const shoot=index=>{
      // Aim at y=.72, inside the crawler's head band (.55 to .9), where the ray meets its .43 m radius.
      T.pose({x,z,yaw:0,pitch:0});const eye=G.snapshot().position.y+1.6;
      T.pose({x,z,yaw:0,pitch:Math.atan((.72-eye)/(z-crawlerZ-.43))});
      T.enemy(index,{x,z:crawlerZ,state:'wander',yaw:0});
      T.action('fire',true);T.advance(.05);T.action('fire',false);
      const s=G.snapshot();
      return {weapon:s.weapon,dead:s.enemies[index].dead,streak:s.streak,label:s.hud.label,score:s.hud.score,pops:s.hud.active.pops,
        markers:s.hud.active.markers,hitstop:s.hitstop,dopamine:s.dopamine,message:document.getElementById('msg').textContent};
    };
    const first=shoot(2);T.advance(.9);const second=shoot(5);T.action('aim',false);T.silence();
    return {first,second};
  });
  const {first,second}=shots;
  expect(first.weapon).toBe('shotgun');
  expect(first.dead).toBe(true);
  expect(first.streak.count).toBe(1);
  expect(first.label).toBe('HEADSHOT');
  expect(first.pops).toBe(1);
  expect(first.dopamine.lastKill).toMatchObject({kind:'crawler',headshot:true,label:'HEADSHOT',count:1});
  expect(first.score).toBeGreaterThan(0);
  expect(first.markers).toBe(1);
  expect(first.hitstop,'solo kills freeze the simulation briefly').toBeGreaterThan(0);
  expect(first.dopamine.lastHitstop).toBeGreaterThanOrEqual(.045);
  // The kill message is unchanged (every other monster is silenced, so none remain).
  expect(first.message).toMatch(/^(Crawler down · \d+ threats remain\.|The corridors are silent\. Restore the exit power\.)$/);
  expect(second.dead).toBe(true);
  expect(second.streak.count).toBe(2);
  expect(second.label).toBe('DOUBLE KILL');
  expect(second.score).toBeGreaterThan(first.score);
  expect(second.streak.points).toBe(second.score);
  await expect.poll(()=>page.evaluate(()=>HollowGame.snapshot().hitstop),{message:'real frames consume the hitstop'}).toBe(0);
});

test('a hit from behind draws a damage arc at the back of the screen',async({page})=>{
  await ready(page,{effects:true});
  const hurt=await page.evaluate(()=>{
    const T=HollowTest;T.silence();T.health(100);
    T.pose({x:45,z:55,yaw:Math.PI});
    T.enemy(1,{x:45,z:54,state:'chase',yaw:0});
    try{
      T.advance(.2);
      const layer=document.querySelector('#hud .hfx-layer');
      return {snapshot:HollowGame.snapshot(),arcs:layer.querySelectorAll('.hfx-dmg:not([hidden])').length,
        inHud:!!layer&&layer.parentElement===document.getElementById('hud'),pointer:getComputedStyle(layer).pointerEvents,
        legacy:!!document.getElementById('reticleHit')};
    }finally{T.silence();}
  });
  expect(hurt.snapshot.health).toBe(68);
  expect(Math.abs(hurt.snapshot.dopamine.damage.bearing)).toBeCloseTo(Math.PI,1);
  expect(hurt.snapshot.dopamine.damage.amount).toBeCloseTo(.64,5);
  expect(hurt.snapshot.hud.active.damage).toBeGreaterThanOrEqual(1);
  expect(hurt.arcs).toBeGreaterThanOrEqual(1);
  expect(hurt).toMatchObject({inHud:true,pointer:'none',legacy:true});
});
