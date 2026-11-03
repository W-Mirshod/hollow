const {test,expect}=require('@playwright/test');

test.setTimeout(240000);
test.use({screenshot:'off',trace:'off'});

let errors=[];
test.beforeEach(({page})=>{
  errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
});
test.afterEach(()=>expect(errors,'No console errors').toEqual([]));

async function play(page){
  await page.goto('/?qa=1');
  await page.waitForFunction(()=>!!window.HollowTest&&!!window.HollowGame);
  await page.locator('#startDarkBtn').click();
  await expect.poll(()=>page.evaluate(()=>HollowGame.snapshot().state)).toBe('play');
  await page.evaluate(()=>HollowTest.silence());
}
const perf=page=>page.evaluate(()=>{const p=HollowGame.snapshot().performance;return {quality:p.quality,renderScale:p.renderScale,wardDetail:p.wardDetail,frames:p.frames};});

test('auto quality steps down under load, back up with headroom, and remembers where it settled',async({page})=>{
  await page.addInitScript(()=>{
    localStorage.setItem('hollow.playerName','Quality QA');
    if(!sessionStorage.getItem('qualityQaBooted')){
      sessionStorage.setItem('qualityQaBooted','1');
      localStorage.setItem('hollow.settings',JSON.stringify({quality:'auto',motion:false,sensitivity:1,volume:0,effects:true}));
      localStorage.removeItem('hollow.autoRung');
    }
  });
  await play(page);
  const start=await perf(page);
  expect(start,'desktop auto starts on the high tier').toMatchObject({quality:'high',renderScale:1.25,wardDetail:2});

  // Each call is one 2 s window (40 x 50 ms, 250 x 8 ms) fed inside one evaluate, so real frames cannot interleave.
  const slow=await page.evaluate(()=>HollowTest.autoQualityFrames(50,40));
  // 50 ms frames (20 FPS) are far over budget: two rungs at once. At DPR 1 high at 125% and 100% look the same, so
  // the first rung that differs is medium at 100%, then medium at 85%. The ward drops its per-cell variation live.
  expect(slow).toMatchObject({quality:'medium',renderScale:.85,wardDetail:1,autoBest:2});
  await expect.poll(()=>page.evaluate(()=>document.getElementById('fpsText').textContent),{message:'the HUD shows the stepped-down tier and scale'}).toMatch(/MEDIUM 85%$/);
  expect(await page.evaluate(()=>localStorage.getItem('hollow.autoRung'))).toBe('3');

  const fast=await page.evaluate(()=>[HollowTest.autoQualityFrames(8,250),HollowTest.autoQualityFrames(8,250)]);
  expect(fast[0],'8 ms frames step back up one rung').toMatchObject({quality:'medium',renderScale:1});
  expect(fast[1],'but never onto the high rung that was too slow').toMatchObject({quality:'medium',renderScale:1,autoBest:2});

  const frames=(await perf(page)).frames;
  await expect.poll(async()=>(await perf(page)).frames,{message:'the stepped-down ward keeps rendering'}).toBeGreaterThan(frames+2);

  // A new visit starts one rung better than where auto settled (medium 100% is rung 2, so high at 100%).
  await page.reload();
  await page.waitForFunction(()=>!!window.HollowTest&&!!window.HollowGame);
  expect(await perf(page)).toMatchObject({quality:'high',renderScale:1,wardDetail:2});

  // Picking a quality by hand forgets the remembered rung.
  await page.evaluate(()=>{const el=document.getElementById('settingsQuality');el.value='low';el.dispatchEvent(new Event('input'));});
  expect(await perf(page)).toMatchObject({quality:'low',renderScale:.8,wardDetail:0});
  expect(await page.evaluate(()=>localStorage.getItem('hollow.autoRung'))).toBeNull();
});
