const {test,expect}=require('@playwright/test');

test.setTimeout(240000);

let runtimeErrors=[];
test.beforeEach(({page})=>{
  runtimeErrors=[];
  page.on('pageerror',error=>runtimeErrors.push(error.message));
  page.on('console',message=>{
    const text=message.text();
    if((message.type()==='error'&&/WebGL|shader|GL_INVALID|Startup failed/i.test(text))||/GL_INVALID_(?:OPERATION|VALUE|ENUM|FRAMEBUFFER)/.test(text))runtimeErrors.push(text);
  });
});
test.afterEach(()=>expect(runtimeErrors,'No uncaught gameplay or shader errors').toEqual([]));

async function ready(page){
  await page.addInitScript(()=>{
    localStorage.setItem('hollow.playerName','Edge-case QA');
    localStorage.setItem('hollow.settings',JSON.stringify({quality:'low',motion:false,sensitivity:1,volume:0}));
  });
  await page.goto('/?qa=1');
  await page.waitForFunction(()=>!!window.HollowTest&&!!window.HollowGame);
}

async function start(page){
  await ready(page);await page.locator('#startDarkBtn').click();
  await expect.poll(async()=>(await snapshot(page)).state).toBe('play');
  await page.evaluate(()=>HollowTest.silence());
}

async function snapshot(page){return page.evaluate(()=>HollowGame.snapshot());}
async function pose(page,position){await page.evaluate(position=>HollowTest.pose(position),position);}

// Wait for the game to have simulation opportunities, not a guessed wall-clock sleep.
async function simulationPasses(page,from,seconds){
  await expect.poll(async()=>(await snapshot(page)).simulationTime-from,{timeout:90000,intervals:[100,250,500]}).toBeGreaterThan(seconds);
}

async function animationFrames(page,count){
  await page.evaluate(count=>new Promise(resolve=>{
    const tick=()=>{if(--count<=0)resolve();else requestAnimationFrame(tick);};requestAnimationFrame(tick);
  }),count);
}

async function center(page,selector){
  const r=await page.locator(selector).boundingBox();
  return {x:r.x+r.width/2,y:r.y+r.height/2};
}

async function touch(cdp,type,points=[]){
  await cdp.send('Input.dispatchTouchEvent',{type,touchPoints:points.map(p=>({...p,radiusX:4,radiusY:4,force:1}))});
}

test('solid infirmary furniture blocks walking, but a real jump lands on its top',async({page})=>{
  await start(page);
  await page.waitForFunction(()=>typeof HollowTest.colliders==='function');
  const bed=await page.evaluate(()=>HollowTest.colliders().find(p=>p.room==='infirmary'&&p.h>.5&&p.h<1.1&&p.d>1.8&&p.w<1.3));
  expect(bed,'An infirmary bed exposes its actual solid collision dimensions').toBeTruthy();
  const rightEdge=bed.x+bed.w/2;
  const approach={x:rightEdge+.92,z:bed.z,y:0,yaw:Math.PI/2,pitch:.12};
  await pose(page,approach);
  const before=await snapshot(page);
  let blocked,landed;
  try{
    await page.keyboard.down('w');
    await expect.poll(async()=>(await snapshot(page)).position.x,{timeout:90000}).toBeLessThan(approach.x-.2);
    // Unobstructed walking covers farther than the whole bed in this interval.
    await simulationPasses(page,before.simulationTime,.95);
    blocked=await snapshot(page);
    expect(blocked.position.x,'Walking cannot enter the bed footprint').toBeGreaterThan(rightEdge+.15);
    expect(blocked.position.y).toBeCloseTo(0,4);expect(blocked.onGround).toBe(true);
    await page.keyboard.down('Space');
    await expect.poll(async()=>(await snapshot(page)).position.y,{timeout:90000}).toBeGreaterThan(.12);
    await page.keyboard.up('Space');
    await expect.poll(async()=>{
      const s=await snapshot(page);return s.position.x<rightEdge-.03&&s.position.y>bed.h-.2;
    },{timeout:90000,intervals:[50,100,250]}).toBe(true);
    await page.keyboard.up('w');
    await expect.poll(async()=>{
      const s=await snapshot(page);return s.onGround&&Math.abs(s.position.y-bed.h)<.025;
    },{timeout:90000}).toBe(true);
    landed=await snapshot(page);
    expect(landed.position.x).toBeGreaterThan(bed.x-bed.w/2-.05);
    expect(landed.position.x).toBeLessThan(rightEdge+.05);
    expect(Math.abs(landed.position.z-bed.z)).toBeLessThan(bed.d/2);
    await simulationPasses(page,landed.simulationTime,.25);
    const stable=await snapshot(page);
    expect(stable.onGround).toBe(true);expect(stable.position.y).toBeCloseTo(bed.h,3);
    await test.info().attach('furniture-landing',{body:JSON.stringify({bed,approach,blocked:blocked.position,landed:landed.position,stable:stable.position},null,2),contentType:'application/json'});
  }finally{
    await page.keyboard.up('w');await page.keyboard.up('Space');
  }
});

test('pausing freezes movement and an in-flight reload while settings remain usable',async({page})=>{
  await start(page);await pose(page,{x:13,z:7.5,yaw:Math.PI/2,pitch:0});
  const full=await snapshot(page);
  await page.mouse.down();
  await expect.poll(async()=>(await snapshot(page)).mag,{timeout:90000}).toBeLessThan(full.mag);
  await page.mouse.up();
  await page.keyboard.down('w');
  await expect.poll(async()=>(await snapshot(page)).position.x,{timeout:90000}).toBeLessThan(12.85);
  await page.keyboard.press('r');
  await expect.poll(async()=>(await snapshot(page)).reloadT).toBeGreaterThan(0);
  await page.keyboard.press('Escape');await expect(page.locator('#pause')).toBeVisible();
  const paused=await snapshot(page);
  expect(paused.state).toBe('pause');expect(paused.reloadT).toBeGreaterThan(0);expect(paused.input.mouseDown).toBe(false);
  // Held keyboard input cannot advance a paused player, even during settings changes.
  await page.keyboard.up('w');await page.keyboard.down('w');
  await page.locator('#settingsQuality').selectOption('low');
  await page.locator('#settingsMotion').check();
  await page.locator('#settingsSensitivity').focus();await page.keyboard.press('End');
  await animationFrames(page,24);
  const frozen=await snapshot(page);
  expect(frozen.state).toBe('pause');expect(frozen.position).toEqual(paused.position);
  expect(frozen.elapsed).toBe(paused.elapsed);expect(frozen.simulationTime).toBe(paused.simulationTime);expect(frozen.reloadT).toBe(paused.reloadT);expect(frozen.mag).toBe(paused.mag);
  const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('hollow.settings')));
  expect(saved.quality).toBe('low');expect(saved.motion).toBe(true);expect(saved.sensitivity).toBe(2.5);
  await page.keyboard.up('w');await page.locator('#resumeBtn').click();
  await expect.poll(async()=>(await snapshot(page)).state).toBe('play');
  await expect.poll(async()=>{
    const s=await snapshot(page);return s.reloadT===0&&s.mag===full.mag;
  },{timeout:90000}).toBe(true);
  const reloaded=await snapshot(page);
  expect(reloaded.reserve).toBeLessThan(full.reserve);
  await page.keyboard.down('w');
  try{
    await expect.poll(async()=>(await snapshot(page)).position.x,{timeout:90000}).toBeLessThan(reloaded.position.x-.15);
  }finally{await page.keyboard.up('w');}
  await test.info().attach('pause-reload',{body:JSON.stringify({paused:{position:paused.position,reloadT:paused.reloadT,elapsed:paused.elapsed},frozen:{position:frozen.position,reloadT:frozen.reloadT,elapsed:frozen.elapsed},saved,reloaded:{mag:reloaded.mag,reserve:reloaded.reserve,reloadT:reloaded.reloadT}},null,2),contentType:'application/json'});
});

test.describe('mobile story transition',()=>{
  test.use({viewport:{width:390,height:844},deviceScaleFactor:1,isMobile:true,hasTouch:true});

  test('Skip scene enters interactive play and portrait gestures clear on rotation',async({page,context,browserName})=>{
    test.skip(browserName!=='chromium','Real multi-touch injection uses Chromium CDP.');
    await ready(page);
        // The outdoor opening remains available through the result-screen replay action.
        await page.evaluate(()=>document.getElementById('retryFull').click());
    await expect.poll(async()=>(await snapshot(page)).state).toBe('outside');
    await expect(page.locator('#touchMove')).toBeVisible();
    await pose(page,{x:-3.55,z:7.5,yaw:-Math.PI/2,pitch:0});
    const cdp=await context.newCDPSession(page),outsideStick=await center(page,'#touchMove');
    await touch(cdp,'touchStart',[{id:1,x:outsideStick.x,y:outsideStick.y-38}]);
    await expect.poll(async()=>(await snapshot(page)).state,{timeout:90000}).toBe('cutscene');
    await expect(page.getByRole('button',{name:'Skip cinematic'})).toBeVisible();
    await expect(page.locator('#touchMove')).toBeHidden();
    expect((await snapshot(page)).input.touchY).toBe(0);
    await touch(cdp,'touchEnd');
    await page.getByRole('button',{name:'Skip cinematic'}).tap();
    await expect.poll(async()=>(await snapshot(page)).state,{timeout:90000}).toBe('play');
    await page.evaluate(()=>HollowTest.silence());
    await expect(page.locator('#touchMove')).toBeVisible();
    await expect(page.locator('.touch-fire')).toBeVisible();
    await expect(page.locator('body')).not.toHaveClass(/bars-on/);
    await expect(page.locator('.touch-jump')).toHaveAccessibleName('Jump');
    await pose(page,{x:13,z:7.5,yaw:Math.PI/2,pitch:0});
    const before=await snapshot(page),stick=await center(page,'#touchMove'),fire=await center(page,'.touch-fire'),aim=await center(page,'.touch-aim');
    const points=[{id:1,x:stick.x,y:stick.y-38},{id:2,x:280,y:350},{id:3,...fire},{id:4,...aim}];
    await touch(cdp,'touchStart',points);
    points[1].x+=25;points[1].y-=14;await touch(cdp,'touchMove',points);
    await expect.poll(async()=>{
      const s=await snapshot(page);return s.mag<before.mag&&s.aiming&&s.input.mouseDown&&s.input.touchY>.5&&s.position.x<before.position.x-.15;
    },{timeout:90000}).toBe(true);
    const held=await snapshot(page);
    expect(held.pitch).toBeGreaterThan(.01);expect(held.yaw).not.toBe(before.yaw);
    // Rotate without releasing fingers: no gesture may stay stuck across layout changes.
    await page.setViewportSize({width:844,height:390});
    await expect.poll(async()=>{
      const s=await snapshot(page);return !s.aiming&&!s.input.mouseDown&&s.input.touchX===0&&s.input.touchY===0;
    }).toBe(true);
    await touch(cdp,'touchEnd');
    await page.setViewportSize({width:390,height:844});
    await page.locator('.touch-pause').tap();await expect(page.locator('#pause')).toBeVisible();
    await expect(page.locator('#touchControls')).toBeHidden();
    await page.locator('#resumeBtn').tap();
    await expect.poll(async()=>(await snapshot(page)).state).toBe('play');
    const cleared=await snapshot(page);
    expect(cleared.input).toMatchObject({mouseDown:false,touchX:0,touchY:0});expect(cleared.aiming).toBe(false);
    await test.info().attach('portrait-story-gestures',{body:JSON.stringify({held:{position:held.position,mag:held.mag,aiming:held.aiming,input:held.input},cleared:{state:cleared.state,aiming:cleared.aiming,input:cleared.input}},null,2),contentType:'application/json'});
  });
});
