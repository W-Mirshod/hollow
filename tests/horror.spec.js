const {test,expect}=require('@playwright/test');
const {RECORDS}=require('../public/horror');
const {CELL}=require('../public/systems');

test.setTimeout(180000);
// Explicit captures below are the only new screenshot/attachment names.
test.use({screenshot:'off',trace:'off'});

let runtimeErrors=[];
test.beforeEach(({page})=>{
  runtimeErrors=[];
  page.on('pageerror',error=>runtimeErrors.push(error.message));
  page.on('console',message=>{
    const text=message.text();
    if((message.type()==='error'&&/WebGL|WebGPU|WGSL|shader|GL_INVALID|Startup failed/i.test(text))||/GL_INVALID_(?:OPERATION|VALUE|ENUM|FRAMEBUFFER)| - While (?:calling|validating|encoding|finishing|creating)|\[Invalid [A-Z]/.test(text))runtimeErrors.push(text);
  });
});
test.afterEach(()=>expect(runtimeErrors,'No uncaught gameplay or scene shader errors').toEqual([]));

async function ready(page){
  await page.addInitScript(()=>{
    localStorage.setItem('hollow.playerName','Blackwater QA');
    // Do not overwrite saved settings on reload: persistence is part of the test.
    if(!localStorage.getItem('hollow.settings'))localStorage.setItem('hollow.settings',JSON.stringify({quality:'low',motion:false,sensitivity:1,volume:0,effects:true}));
  });
  await page.goto('/?qa=1');
  await page.waitForFunction(()=>!!window.HollowTest&&!!window.HollowGame);
  await expect(page.locator('#menu')).toBeVisible();
}
async function snapshot(page){return page.evaluate(()=>HollowGame.snapshot());}
async function start(page){
  await page.locator('#startDarkBtn').click();
  await expect.poll(async()=>(await snapshot(page)).state).toBe('play');
  await page.evaluate(()=>HollowTest.silence());
}
async function pose(page,position){await page.evaluate(position=>HollowTest.pose(position),position);}
async function simulationPasses(page,from,seconds){
  await expect.poll(async()=>(await snapshot(page)).simulationTime-from,{timeout:90000,intervals:[100,250,500]}).toBeGreaterThan(seconds);
}
async function renderedFrames(page,count=3){
  const from=(await snapshot(page)).performance.frames;
  await expect.poll(async()=>(await snapshot(page)).performance.frames-from,{intervals:[100,250]}).toBeGreaterThanOrEqual(count);
}
async function pause(page){
  await page.keyboard.press('Escape');
  await expect(page.locator('#pause')).toBeVisible();
}
async function resume(page){
  await page.locator('#resumeBtn').click();
  await expect.poll(async()=>(await snapshot(page)).state).toBe('play');
}
async function collectFuse(page,fuse){
  await pose(page,{x:fuse.x,z:fuse.z+1,yaw:0});
  await expect(page.locator('#interactionPrompt')).toContainText('fuse');
  await page.keyboard.press('e');
  await expect.poll(async()=>(await snapshot(page)).loot.find(item=>item.id===fuse.id).taken).toBe(true);
  await expect.poll(async()=>{const s=await snapshot(page);return s.horror.fuses===s.fuses;}).toBe(true);
}
async function readRecord(page,record){
  await pose(page,{x:record.x,z:record.z+1,yaw:0});
  // A displayed record suppresses the prompt, but E remains a live interaction.
  const current=(await snapshot(page)).notes;
  if(!current||current.startsWith('['))await expect(page.locator('#interactionPrompt')).toContainText('Read');
  await page.keyboard.press('e');
  await expect(page.locator('#horrorCaption')).toHaveText(record.title+' — '+RECORDS[record.id].text);
}
async function capture(page,name){
  await page.screenshot({path:'artifacts/'+name});
  await test.info().attach(name,{path:'artifacts/'+name,contentType:'image/png'});
}

test('effects persist through reload, real fuse relays dim practical lights, and disabled effects stay steady',async({page})=>{
  await ready(page);await start(page);await pause(page);
  await expect(page.getByRole('checkbox',{name:'Disturbing effects',exact:true})).toBeChecked();
  await page.locator('#settingsEffects').uncheck();
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('hollow.settings')).effects)).toBe(false);
  await page.reload();await page.waitForFunction(()=>!!window.HollowTest);
  expect((await snapshot(page)).horror.effects).toBe(false);
  await start(page);await pause(page);await expect(page.locator('#settingsEffects')).not.toBeChecked();await resume(page);

  const fuse=(await snapshot(page)).loot.find(item=>item.type==='fuse');
  await collectFuse(page,fuse);
  await expect(page.locator('#horrorCaption')).toHaveText('[A relay snaps. The ventilation winds down.]');
  const steady=await snapshot(page);
  expect(steady.fuses).toBe(1);
  expect(steady.horror).toMatchObject({effects:false,fuses:1,dip:0,lighting:1});
  await expect.poll(async()=>(await snapshot(page)).lighting.filter(light=>light.visible&&light.intensity===1.75).length).toBeGreaterThan(0);
  const from=(await snapshot(page)).simulationTime;
  // Sample several actual simulation updates, rather than only the trigger frame.
  for(const seconds of [.2,.4,.6]){
    await simulationPasses(page,from,seconds);
    const s=await snapshot(page);
    expect(s.horror).toMatchObject({dip:0,lighting:1});
    expect(s.lighting.filter(light=>light.visible).map(light=>light.intensity)).toEqual([1.75]);
  }
  for(const selector of ['#grain','#flash','#danger'])await expect(page.locator(selector)).toHaveCSS('visibility','hidden');
    const loaded=(await snapshot(page)).mag;await page.mouse.down();
    try{
      await expect.poll(async()=>(await snapshot(page)).mag).toBeLessThan(loaded);
      for(let i=0;i<5;i++){await renderedFrames(page,1);expect((await snapshot(page)).flashes).toEqual({muzzle:false,world:0,weapon:0,partner:0});}
    }finally{await page.mouse.up();}

  await pause(page);await page.locator('#settingsEffects').check();
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('hollow.settings')).effects)).toBe(true);
  await page.reload();await page.waitForFunction(()=>!!window.HollowTest);
  expect((await snapshot(page)).horror.effects).toBe(true);
  await start(page);await pause(page);await expect(page.locator('#settingsEffects')).toBeChecked();await resume(page);
  await collectFuse(page,(await snapshot(page)).loot.find(item=>item.type==='fuse'));
  await expect(page.locator('#horrorCaption')).toHaveText('[A relay snaps. The ventilation winds down.]');
  await expect.poll(async()=>{
    const s=await snapshot(page);
    return s.horror.dip>0&&s.horror.lighting<.9&&s.lighting.some(light=>light.visible&&light.intensity>0&&light.intensity<1.6);
  },{intervals:[100,250]}).toBe(true);
  const dimmed=await snapshot(page);
  expect(dimmed.horror.lighting).toBeGreaterThanOrEqual(.35-1e-9);
  expect(dimmed.horror.dip).toBeLessThanOrEqual(6);
  await pause(page);await page.locator('#settingsEffects').uncheck();await resume(page);
  await expect.poll(async()=>{
    const s=await snapshot(page);return s.horror.dip===0&&s.horror.lighting===1&&s.lighting.some(light=>light.visible&&light.intensity===1.75);
  }).toBe(true);
  console.log('Blackwater relay: enabled lighting',dimmed.horror.lighting,'practicals',dimmed.lighting,'; disabled lighting stayed at 1.');
});

test('case notes preserve live gameplay and unique read count; restart clears director, notes and exit status',async({page})=>{
  test.setTimeout(240000);
  await ready(page);await start(page);
  const initial=await snapshot(page);
  expect(initial.records.map(record=>record.id).sort()).toEqual(Object.keys(RECORDS).sort());
  for(const record of initial.records){
    const room=initial.rooms.find(room=>room.id===record.id);
    expect(record.title).toBe(RECORDS[record.id].title);
    expect(record.x).toBe((room.x+room.w/2)*CELL);
    expect(record.z).toBeCloseTo(room.z*CELL+.055,6);
  }
  const record=initial.records.find(record=>record.id==='infirmary');
  await readRecord(page,record);
  const reading=await snapshot(page);
  expect(reading.state).toBe('play');expect(reading.horror.notesRead).toBe(1);
  expect(reading.health).toBe(initial.health);expect(reading.mag).toBe(initial.mag);
    // Gameplay notices must stay visible even when a case note is on screen.
    const kit=initial.loot.find(item=>item.id==='infirmary:medical');
    await pose(page,{x:kit.x,z:kit.z+1,yaw:0});await page.keyboard.press('e');
    await expect(page.locator('#msg')).toHaveText('Health is full. Save this kit for later.');
    await expect(page.locator('#msg')).toBeVisible();
    await pose(page,{x:record.x,z:record.z+1,yaw:0});
  await expect(page.locator('body')).toHaveClass(/reading-record/);
  await expect(page.locator('#hud')).toBeVisible();await expect(page.locator('#pause')).toBeHidden();
  await page.keyboard.down('s');
  try{await expect.poll(async()=>(await snapshot(page)).position.z).toBeGreaterThan(reading.position.z+.25);}
  finally{await page.keyboard.up('s');}
  await page.keyboard.press('2');await expect.poll(async()=>(await snapshot(page)).weapon).toBe('pistol');
  await page.keyboard.press('f');await expect.poll(async()=>(await snapshot(page)).torchOn).toBe(!reading.torchOn);
  const moving=await snapshot(page);
  expect(moving.simulationTime).toBeGreaterThan(reading.simulationTime);
  expect(moving.horror.age).toBeGreaterThan(reading.horror.age);
  expect(moving.notes).toBe(reading.notes);expect(moving.horror.notesRead).toBe(1);
  await readRecord(page,record);expect((await snapshot(page)).horror.notesRead).toBe(1);
  await pause(page);await resume(page);
  expect((await snapshot(page)).horror.notesRead).toBe(1);
  await readRecord(page,initial.records.find(record=>record.id==='archive'));
  expect((await snapshot(page)).horror.notesRead).toBe(2);
  for(const fuse of initial.loot.filter(item=>item.type==='fuse'))await collectFuse(page,fuse);
  const collected=await snapshot(page);
  expect(collected.fuses).toBe(3);expect(collected.horror.fuses).toBe(3);
  expect(collected.horror.notesRead).toBe(2);
  expect(collected.notes).toContain(RECORDS.archive.title);
  await pose(page,{x:100.5,z:100.5,yaw:-Math.PI/2});await page.keyboard.press('e');
  await expect.poll(async()=>(await snapshot(page)).exitPowered).toBe(true);
  const releasing=await snapshot(page);
  expect(releasing.exitOpen).toBe(false);expect(releasing.exitRelease).toBeGreaterThan(0);
  await expect(page.locator('#escapeStatus')).toContainText('RELEASING SHUTTER');
  await expect.poll(async()=>(await snapshot(page)).exitOpen,{timeout:150000,intervals:[250,500,1000]}).toBe(true);
  const opened=await snapshot(page);
  expect(opened.exitRelease).toBe(0);
  expect(opened.simulationTime-releasing.simulationTime).toBeGreaterThanOrEqual(releasing.exitRelease-.05);
  await expect(page.locator('#escapeStatus')).toHaveText('RELEASE COMPLETE · RUN');
  // Leave a visible note dirty immediately before restarting, even if its earlier caption expired.
  await readRecord(page,record);
  await pause(page);await page.locator('#pauseMenuBtn').click();await start(page);
  const restarted=await snapshot(page);
  expect(restarted).toMatchObject({state:'play',fuses:0,exitPowered:false,exitRelease:0,exitOpen:false,notes:''});
  expect(restarted.horror).toMatchObject({events:0,fuses:0,dip:0,lighting:1,notesRead:0});
  expect(restarted.horror.age).toBeLessThan(opened.horror.age);
  expect(restarted.horror.cooldown).toBeGreaterThan(0);
  expect(restarted.records).toEqual(initial.records);
  expect(restarted.loot.filter(item=>item.type==='fuse').every(item=>!item.taken)).toBe(true);
  await expect(page.locator('#escapeStatus')).toBeEmpty();await expect(page.locator('#horrorCaption')).toBeEmpty();
  await expect(page.locator('body')).not.toHaveClass(/reading-record/);
  console.log('Blackwater notes: movement, torch and weapon switching remained live; two unique reads survived pause and fuses. Exit released after',opened.simulationTime-releasing.simulationTime,'simulation seconds; restart cleared round state.');
});

test('Blackwater menu, infirmary, central corridor and safe visible Warden render without shader errors',async({page})=>{
  const viewport=page.viewportSize();
  await page.setViewportSize({width:1280,height:900});
  await ready(page);await expect(page.locator('#startDarkBtn')).toBeInViewport();
  await capture(page,'blackwater-menu.png');
  await page.setViewportSize(viewport);await start(page);
  const room=(await snapshot(page)).rooms.find(room=>room.id==='infirmary');
  const beds=await page.evaluate(()=>HollowTest.colliders().filter(p=>p.room==='infirmary'&&p.d>1.8&&p.w<1.3&&p.h<1.3));
  expect(beds).toHaveLength(2);
  const entrance={x:(room.x+.5)*CELL+.7,z:(room.z+room.d)*CELL-.4,y:0};
  const target={x:beds[0].x+.9,z:beds[0].z+1};
  await pose(page,{...entrance,yaw:Math.atan2(entrance.x-target.x,entrance.z-target.z),pitch:-.08});
  await renderedFrames(page);
  await expect(page.locator('#locationText')).toContainText('Infirmary');
  await expect(page.locator('#menu')).toBeHidden();await expect(page.locator('#pause')).toBeHidden();
  expect((await snapshot(page)).position.x).toBeCloseTo(entrance.x,3);
  expect((await snapshot(page)).position.z).toBeCloseTo(entrance.z,3);
  await capture(page,'blackwater-ward.png');

  await pose(page,{x:45,z:55,yaw:0,pitch:0});await renderedFrames(page);
  expect(await page.evaluate(()=>HollowTest.navClear(45,55,45,25,.3))).toBe(true);
  await capture(page,'blackwater-corridor.png');
  const warden=(await snapshot(page)).enemies.find(enemy=>enemy.kind==='warden');
  expect(warden).toBeTruthy();
  // The Warden now chases at 3.2 m/s: hold the AI still so this render fixture stays 4-6 m away at any frame rate.
  await page.evaluate(index=>{HollowTest.torch(true);HollowTest.freezeAI(true);HollowTest.enemy(index,{x:45,z:50,yaw:Math.PI,state:'wander'});},warden.index);
  await renderedFrames(page);
  const visible=await snapshot(page),enemy=visible.enemies.find(enemy=>enemy.index===warden.index);
  const distance=Math.hypot(enemy.x-visible.position.x,enemy.z-visible.position.z);
  expect(distance,'frozen Warden stays where it was placed (5 m)').toBeGreaterThanOrEqual(4);expect(distance).toBeLessThanOrEqual(6);
  expect(enemy.dead).toBe(false);expect(visible.health).toBe(100);expect(visible.state).toBe('play');
  expect(await page.evaluate(({x,z})=>HollowTest.navClear(45,55,x,z,.3),enemy)).toBe(true);
  await capture(page,'blackwater-creature.png');
  expect((await snapshot(page)).health).toBe(100);
  await page.evaluate(()=>{HollowTest.freezeAI(false);HollowTest.silence();});
  console.log('Blackwater captures: infirmary entrance',entrance,'looking toward',target,'; Warden distance',distance,'metres; corridor at x45 z55 facing north.');
});
