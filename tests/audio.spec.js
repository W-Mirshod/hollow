const {test,expect}=require('@playwright/test');

// Deterministic audio integration checks: HollowTest drives the simulation, HollowGame.snapshot() exposes the three
// engines and audioLog (every cue that actually started, numbered by `n`). Volume 0 still runs every audio graph.
test.setTimeout(180000);
test.use({viewport:{width:800,height:520},screenshot:'off',trace:'off'});

let pages=[];
test.beforeEach(()=>{pages=[];});
test.afterEach(()=>expect(pages.flatMap(page=>page.audioErrors),'No console errors, page errors or audio failures').toEqual([]));

async function ready(page,settings={}){
  page.audioErrors=[];pages.push(page);
  page.on('pageerror',error=>page.audioErrors.push(error.message));
  page.on('console',message=>{if(message.type()==='error'||/\[The Hollow\] Audio/.test(message.text()))page.audioErrors.push(message.text());});
  await page.addInitScript(settings=>{
    localStorage.setItem('hollow.playerName','Audio QA');
    localStorage.setItem('hollow.settings',JSON.stringify({quality:'low',motion:false,effects:true,sensitivity:1,volume:0,...settings}));
  },settings);
  await page.goto('/?qa=1');
  await page.waitForFunction(()=>!!window.HollowGame&&typeof window.HollowTest?.advance==='function');
}
async function snapshot(page){return page.evaluate(()=>HollowGame.snapshot());}
async function start(page){
  await page.locator('#startDarkBtn').click();
  await expect.poll(async()=>(await snapshot(page)).state).toBe('play');
  await page.evaluate(()=>HollowTest.silence());
}
const cues=(entries,src,cue,kind)=>entries.filter(e=>e.src===src&&e.cue===cue&&(kind===undefined||e.kind===kind));

test('the engines start on the first click; shots, hits, impacts, kills, equips and reloads are heard',async({page})=>{
  await ready(page);
  const idle=await snapshot(page);
  expect([idle.audio,idle.playerAudio,idle.weaponAudio],'No audio graph exists before a user gesture').toEqual([null,null,null]);
  await start(page);
  const live=await snapshot(page);
  expect(live.audio,'Creature voices are initialized').not.toBeNull();
  expect(live.playerAudio,'Player body audio is initialized').not.toBeNull();
  expect(live.weaponAudio,'Weapon audio is initialized').not.toBeNull();

  const hit=await page.evaluate(()=>{
    // The weapon is raised .3 s after a new game: slow frames may not have got there yet.
    HollowTest.pose({x:45,z:55,yaw:0});HollowTest.torch(true);HollowTest.advance(.35);
    const n0=HollowGame.snapshot().audioLog.at(-1)?.n||0;
    HollowTest.enemy(1,{x:45,z:50.5,yaw:0});
    HollowTest.action('fire',true);HollowTest.advance(.05);HollowTest.action('fire',false);
    const s=HollowGame.snapshot();HollowTest.silence();
    return {s,log:s.audioLog.filter(e=>e.n>n0)};
  });
  expect(hit.s.mag).toBe(29);
  expect(hit.s.enemies[1].hp).toBeLessThan(7);
  expect(hit.s.weaponAudio.voices.map(v=>v.kind)).toEqual(expect.arrayContaining(['shot','hitMarker']));
  expect(cues(hit.log,'weapon','shot','rifle')).toHaveLength(1);
  expect(cues(hit.log,'weapon','hitMarker','body')).toHaveLength(1);
  expect(cues(hit.log,'weapon','impact','flesh')).toHaveLength(1);
  expect(cues(hit.log,'creature','growl','stalker'),'A wounded Stalker snarls').toHaveLength(1);

  const kill=await page.evaluate(()=>{
    HollowTest.action('weapon',true);HollowTest.action('weapon',true);
    const equip=HollowGame.snapshot().weaponAudio.voices.map(v=>v.kind);
    HollowTest.advance(.3);
    const n0=HollowGame.snapshot().audioLog.at(-1)?.n||0;
    HollowTest.pose({x:45,z:55,yaw:0,pitch:-.38});HollowTest.enemy(2,{x:45,z:52,yaw:0});
    HollowTest.action('fire',true);HollowTest.advance(.05);HollowTest.action('fire',false);
    HollowTest.action('reload',true);
    const s=HollowGame.snapshot();HollowTest.silence();
    return {equip,s,log:s.audioLog.filter(e=>e.n>n0)};
  });
  expect(kill.equip,'Switching weapons plays equip foley').toContain('equip');
  expect(kill.s.weapon).toBe('shotgun');expect(kill.s.enemies[2].dead).toBe(true);
  expect(cues(kill.log,'weapon','shot','shotgun')).toHaveLength(1);
  expect(cues(kill.log,'weapon','impact','flesh').length,'Pellet impacts are thinned').toBeLessThanOrEqual(2);
  expect(cues(kill.log,'weapon','hitMarker')).toHaveLength(1);
  expect(cues(kill.log,'creature','death','crawler')).toHaveLength(1);
  expect(cues(kill.log,'player','kill').length+cues(kill.log,'player','headshot').length,'One kill stinger per kill').toBe(1);
  expect(cues(kill.log,'weapon','reload','shotgun')).toHaveLength(1);
  expect(kill.s.weaponAudio.reloading).toBe(true);

  const wall=await page.evaluate(()=>{
    const n0=HollowGame.snapshot().audioLog.at(-1)?.n||0;
    HollowTest.action('weapon',true);HollowTest.advance(.3);
    HollowTest.pose({x:45,z:55,yaw:0,pitch:-1.3});
    HollowTest.action('fire',true);HollowTest.advance(.05);HollowTest.action('fire',false);
    return HollowGame.snapshot().audioLog.filter(e=>e.n>n0);
  });
  expect(cues(wall,'weapon','shot','rifle')).toHaveLength(1);
  expect(cues(wall,'weapon','impact','concrete'),'A shot into the floor chips concrete').toHaveLength(1);
  expect(cues(wall,'weapon','hitMarker')).toEqual([]);
});

test('sprinting into exhaustion gasps, then breathes hard and ragged',async({page})=>{
  await ready(page);await start(page);
  const calm=await snapshot(page);
  expect(calm.playerAudio.breathing.exhausted).toBe(false);
  await page.evaluate(()=>HollowTest.pose({x:45,z:30,yaw:Math.PI}));
  await page.keyboard.down('KeyW');await page.keyboard.down('ShiftLeft');
  try{
    // The gasp belongs to the simulation step that empties the bar (onExhausted), not to a rendered frame.
    const spent=await page.evaluate(()=>{
      for(let i=0;i<240&&!HollowGame.snapshot().player.exhausted;i++)HollowTest.advance(.05);
      return HollowGame.snapshot();
    });
    expect(spent.player.exhausted).toBe(true);
    expect(spent.stamina,'Sprinting empties the stamina bar').toBe(0);
    expect(cues(spent.audioLog,'player','gasp','exhausted'),'The exhaustion step gasps').toHaveLength(1);
    let heard;
    await expect.poll(async()=>{heard=await snapshot(page);const b=heard.playerAudio.breathing;return b.exhausted&&b.rate>35;},{intervals:[50,100,250]}).toBe(true);
    expect(heard.playerAudio.breathing.level,'Exhausted breathing is audible').toBeGreaterThan(0);
    expect(cues(heard.audioLog,'player','gasp','exhausted'),'Exhaustion starts with one gasp').toHaveLength(1);
  }finally{await page.keyboard.up('ShiftLeft');await page.keyboard.up('KeyW');}
});

test('an unseen Stalker whispers within six metres, then laughs once when stared at',async({page})=>{
  await ready(page);await start(page);
  const result=await page.evaluate(()=>{
    const n0=HollowGame.snapshot().audioLog.at(-1)?.n||0;
    const said=cue=>HollowGame.snapshot().audioLog.filter(e=>e.n>n0&&e.src==='creature'&&e.kind==='stalker'&&e.cue===cue);
    HollowTest.pose({x:45,z:36,yaw:Math.PI});HollowTest.torch(true);HollowTest.enemy(1,{x:45,z:30,yaw:0});
    try{
      // Keep six metres ahead of it along the open spine, back turned, like survival.spec's timeout fixture.
      let steps=0;
      for(;steps<80&&!said('whisper').length;steps++){const m=HollowGame.snapshot().enemies[1];HollowTest.pose({x:45,z:m.z+6,yaw:Math.PI});HollowTest.advance(.1);}
      const whispering=HollowGame.snapshot().enemies[1];
      const m=whispering;HollowTest.pose({x:45,z:m.z+5,yaw:0});
      for(let i=0;i<20;i++)HollowTest.advance(.05);
      const stared=HollowGame.snapshot().enemies[1];
      for(let i=0;i<6;i++)HollowTest.advance(.05);
      return {steps,whispering,stared,whispers:said('whisper').length,laughs:said('laugh').length,notices:said('notice').length};
    }finally{HollowTest.silence();}
  });
  expect(result.whispering.state).toBe('stalk');
  expect(result.whispers,'It whispers behind the player within eight seconds').toBe(1);
  expect(result.stared.state).toBe('stalk');expect(result.stared.watchTime).toBeGreaterThan(.5);
  expect(result.laughs,'It laughs once at the stare').toBe(1);
});

test('chases growl, a Shrieker alert screams, and a crowded mix never steals the rush notice',async({page})=>{
  await ready(page);await start(page);
  const result=await page.evaluate(()=>{
    const mark=()=>HollowGame.snapshot().audioLog.at(-1)?.n||0;
    const since=n=>HollowGame.snapshot().audioLog.filter(e=>e.n>n);
    try{
      // A Warden charging from 26 m growls on its chase timer.
      HollowTest.pose({x:45,z:58,yaw:Math.PI});HollowTest.torch(true);
      let n=mark();HollowTest.enemy(0,{x:45,z:32,yaw:0,state:'chase'});
      for(let i=0;i<18;i++)HollowTest.advance(.25);
      const warden=since(n),wardenState=HollowGame.snapshot().enemies[0].state;HollowTest.silence();
      // A Shrieker that already hunts and then sees the player calls the others with a scream.
      HollowTest.pose({x:45,z:58,yaw:Math.PI});
      n=mark();HollowTest.enemy(3,{x:45,z:48,yaw:0,state:'chase'});HollowTest.advance(.1);
      const shrieker=since(n);HollowTest.silence();
      // A Stalker rush (notice), then a flood of screams: the full mix refuses to give up the notice.
      HollowTest.pose({x:45,z:55,yaw:Math.PI});HollowTest.enemy(1,{x:45,z:51.7,yaw:0});HollowTest.advance(.05);
      const m=HollowGame.snapshot().enemies[1];HollowTest.pose({x:m.x,z:m.z+2.9,yaw:Math.PI});HollowTest.advance(.1);
      const rush=HollowGame.snapshot();
      for(let i=0;i<10;i++)HollowTest.chaosAudio({type:'scream',bearing:i*.6,distance:6});
      return {warden,wardenState,shrieker,rush,crowded:HollowGame.snapshot().audio};
    }finally{HollowTest.silence();}
  });
  expect(result.wardenState).toBe('chase');
  expect(cues(result.warden,'creature','growl','warden').length,'A chasing Warden growls').toBeGreaterThanOrEqual(1);
  expect(cues(result.shrieker,'creature','scream','shrieker'),'The Shrieker alert is a scream').toHaveLength(1);
  expect(cues(result.shrieker,'creature','notice')).toEqual([]);
  expect(result.rush.enemies[1].state).toBe('chase');
  expect(result.rush.audio.voices.some(v=>v.kind==='stalker'&&v.cue==='notice')).toBe(true);
  expect(result.crowded.activeVoices).toBe(result.crowded.maxVoices);
  expect(result.crowded.voices.some(v=>v.kind==='stalker'&&v.cue==='notice'),'Screams never steal the rush notice').toBe(true);
});

test('with effects off, screams and laughs become quiet breaths',async({page})=>{
  await ready(page,{effects:false});await start(page);
  const log=await page.evaluate(()=>{
    const n0=HollowGame.snapshot().audioLog.at(-1)?.n||0;
    try{
      HollowTest.pose({x:45,z:58,yaw:Math.PI});HollowTest.torch(true);
      HollowTest.chaosAudio({type:'scream',bearing:0,distance:12});
      HollowTest.chaosAudio({type:'laugh',bearing:Math.PI,distance:8});
      HollowTest.enemy(3,{x:45,z:48,yaw:0,state:'chase'});HollowTest.advance(.1);
      return HollowGame.snapshot().audioLog.filter(e=>e.n>n0);
    }finally{HollowTest.silence();}
  });
  const creature=log.filter(e=>e.src==='creature');
  expect(creature.filter(e=>e.cue==='scream'||e.cue==='laugh')).toEqual([]);
  expect(cues(creature,'creature','breath','shrieker').length,'The chaos scream and the alert fall back to breaths').toBe(2);
  expect(cues(creature,'creature','breath','stalker'),'The chaos laugh falls back to a breath').toHaveLength(1);
});

test('pausing stops every engine; resuming picks the reload foley back up',async({page})=>{
  await ready(page);await start(page);
  const busy=await page.evaluate(()=>{
    HollowTest.pose({x:45,z:55,yaw:0,pitch:-1.2});HollowTest.advance(.35);
    HollowTest.action('fire',true);HollowTest.advance(.05);HollowTest.action('fire',false);
    HollowTest.action('reload',true);
    HollowTest.chaosAudio({type:'scream',bearing:0,distance:10});
    return HollowGame.snapshot();
  });
  expect(busy.audio.activeVoices).toBeGreaterThan(0);
  expect(busy.playerAudio.activeVoices).toBeGreaterThan(0);
  expect(busy.weaponAudio.activeVoices).toBeGreaterThan(0);expect(busy.weaponAudio.reloading).toBe(true);
  await page.keyboard.press('Escape');await expect(page.locator('#pause')).toBeVisible();
  const paused=await snapshot(page);
  expect(paused.state).toBe('pause');expect(paused.reloadT).toBeGreaterThan(0);
  expect(paused.audio.activeVoices,'Creature voices stop').toBe(0);
  expect(paused.playerAudio.activeVoices,'Player body audio stops').toBe(0);
  expect(paused.playerAudio.music.level).toBe(0);expect(paused.playerAudio.breathing.level).toBe(0);
  expect(paused.weaponAudio.activeVoices,'Weapon audio stops').toBe(0);expect(paused.weaponAudio.reloading).toBe(false);
  await page.locator('#resumeBtn').click();
  await expect.poll(async()=>(await snapshot(page)).state).toBe('play');
  const resumed=await snapshot(page);
  if(resumed.reloadT>.6)expect(resumed.weaponAudio.reloading,'The rest of the reload foley resumes').toBe(true);
  await expect.poll(async()=>(await snapshot(page)).mag).toBe(30);
});
