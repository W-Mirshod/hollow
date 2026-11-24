const {test,expect}=require('@playwright/test');

// The kill sequences: each creature kills the survivor its own way (camera, body, blood, sound), then the dead screen
// names the killer. The kill clock is held and stepped exactly for the screenshots (artifacts/kill-<kind>-<n>.png),
// then let go to run out on real frames.
test.setTimeout(420000);
test.use({viewport:{width:1000,height:650}});

let pages=[];
test.beforeEach(()=>{pages=[];});
test.afterEach(()=>expect(pages.flatMap(page=>page.hollowErrors),'No uncaught game or shader errors').toEqual([]));

async function ready(page,settings={}){
  page.hollowErrors=[];pages.push(page);
  page.on('pageerror',error=>page.hollowErrors.push(error.message));
  page.on('console',message=>{const text=message.text();if((message.type()==='error'&&/WebGL|WebGPU|WGSL|shader|GL_INVALID|Startup failed/i.test(text))||/ - While (?:calling|validating|encoding|finishing|creating)|\[Invalid [A-Z]/.test(text))page.hollowErrors.push(text);});
  await page.addInitScript(settings=>{
    localStorage.setItem('hollow.playerName','Kill QA');
    localStorage.setItem('hollow.settings',JSON.stringify({quality:'low',motion:true,effects:true,sensitivity:1,volume:0,...settings}));
  },settings);
  await page.goto('/?qa=1');
  await page.waitForFunction(()=>!!window.HollowGame&&typeof window.HollowTest?.kill==='function');
  await page.locator('#startDarkBtn').click();
  await expect.poll(()=>page.evaluate(()=>HollowGame.snapshot().state)).toBe('play');
}
const snapshot=page=>page.evaluate(()=>HollowGame.snapshot());
async function frames(page,count=2){
  const from=(await snapshot(page)).performance.frames;
  await expect.poll(async()=>(await snapshot(page)).performance.frames-from,{intervals:[50,100,250]}).toBeGreaterThanOrEqual(count);
}
// slot: the monster slot that does it (0 warden, 1 stalker, 2 crawler, 3 shrieker); kind: the track it plays.
const KILLS=[
  {kind:'warden',slot:0,at:[.24,.9,1.32,1.56,2.05,2.38,2.66]},
  {kind:'stalker',slot:1,at:[.14,.4,.75,1.12,1.74,2.32,2.5]},
  {kind:'crawler',slot:2,at:[.22,.36,.62,.95,1.44,2.1,2.5]},
  {kind:'shrieker',slot:3,at:[.3,.8,1.2,1.7,2.15,2.24,2.85]},
  {kind:'gravekeeper',slot:1,at:[.2,.4,1.0,1.4,1.7,2.2,2.6,3.0]},
  {kind:'maul',slot:4,at:[.3,.9,1.15,1.9,2.05]}
];

for(const {kind,slot,at} of KILLS){
  test(`the ${kind} kill plays in first person, paints the screen and ends on the dead screen`,async({page})=>{
    await ready(page);
    const start=await page.evaluate(({slot,kind})=>{
      const T=HollowTest;T.silence();T.pose({x:45,z:55,yaw:Math.PI,pitch:-.1});
      return T.kill(slot,{x:45,z:56.1,kind,hold:true});
    },{slot,kind});
    expect(start).toBe('caught');
    let s=(await snapshot(page)).kill;
    expect(s).toMatchObject({active:true,on:true,track:kind,t:0});
    const seen=[];let clock=0;
    for(let i=0;i<at.length;i++){
      s=await page.evaluate(dt=>HollowTest.advanceCaught(dt),at[i]-clock);clock=at[i];
      await frames(page,2);
      await page.screenshot({path:`artifacts/kill-${kind}-${i+1}.png`});
      seen.push(s);
      for(const v of [s.camera.x,s.camera.y,s.camera.f,s.camera.pitch,s.camera.yaw,s.camera.roll,s.camera.fov])expect(Number.isFinite(v)).toBe(true);
      expect(s.body.visible).toBe(true);
    }
    // Blood reached the lens and the camera went down to the floor (or up in the air) somewhere along the way.
    const last=seen[seen.length-1];
    expect(last.overlay.splats+last.overlay.dirt).toBeGreaterThan(0);
    expect(Math.min(...seen.map(q=>q.camera.y))<.5||Math.max(...seen.map(q=>q.camera.y))>2).toBe(true);
    const line=last.line;expect(line.length).toBeGreaterThan(10);
    // Let it run out on real frames.
    await page.evaluate(()=>HollowTest.killHold(false));
    await expect.poll(async()=>(await snapshot(page)).state,{timeout:120000}).toBe('dead');
    await expect(page.locator('#deadText')).toContainText(line);
    await page.screenshot({path:`artifacts/kill-${kind}-dead.png`});
    const after=await snapshot(page);
    expect(after.kill.done).toBe(true);
    // Retrying clears the lens.
    await page.locator('#retryDark').click();
    await expect.poll(async()=>(await snapshot(page)).state,{timeout:60000}).toBe('play');
    await expect.poll(async()=>(await snapshot(page)).kill.overlay.active).toBe(false);
    await expect(page.locator('#killfx')).toBeHidden();
  });
}

test('a kill can be cut short after its first blows, and reduced motion keeps the framing without the shake',async({page})=>{
  await ready(page,{motion:false,effects:false});
  await page.evaluate(()=>{const T=HollowTest;T.silence();T.pose({x:45,z:55,yaw:Math.PI});T.kill(1,{x:45,z:56.1,hold:true});});
  let s=await page.evaluate(()=>HollowTest.advanceCaught(.6));
  expect(await page.evaluate(()=>{HollowTest.killSkip();return HollowGame.snapshot().kill.skipped;})).toBe(false);
  s=await page.evaluate(()=>HollowTest.advanceCaught(1));
  expect(s.t).toBeGreaterThan(1.5);
  s=await page.evaluate(()=>{HollowTest.killSkip();return HollowGame.snapshot().kill;});
  expect(s.skipped).toBe(true);expect(s.t).toBeGreaterThan(2.5);
  await page.evaluate(()=>HollowTest.killHold(false));
  await expect.poll(async()=>(await snapshot(page)).state,{timeout:60000}).toBe('dead');
});
