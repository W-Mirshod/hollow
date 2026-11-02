const {test,expect}=require('@playwright/test');

// Renderer contract: WebGPURenderer prefers WebGPU and falls back to its WebGL2 backend on request (?renderer=webgl)
// or when the browser has no WebGPU adapter. Every path must present real frames without console errors.
test.setTimeout(180000);
const GPU_VALIDATION=/GL_INVALID_(?:OPERATION|VALUE|ENUM|FRAMEBUFFER)| - While (?:calling|validating|encoding|finishing|creating)|\[Invalid [A-Z]/;
// The launch arguments from before WebGPU: no --enable-unsafe-webgpu, so the browser exposes no adapter.
const PLAIN_ARGS=['--no-sandbox','--enable-unsafe-swiftshader'];

function watch(page){
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{const text=message.text();if(message.type()==='error'||GPU_VALIDATION.test(text))errors.push(text);});
  return errors;
}
async function boot(page,url){
  await page.addInitScript(()=>{
    localStorage.setItem('hollow.playerName','Renderer QA');
    localStorage.setItem('hollow.settings',JSON.stringify({quality:'low',motion:false,sensitivity:1,volume:0,effects:true}));
  });
  await page.goto(url);
  await page.waitForFunction(()=>!!window.HollowTest&&!!window.HollowGame);
  await expect(page.locator('#menu')).toBeVisible();
}
async function snapshot(page){return page.evaluate(()=>HollowGame.snapshot());}
async function backend(page){
  return page.evaluate(()=>({global:window.HollowBackend,snapshot:HollowGame.snapshot().performance.backend,webgpu:HollowRenderer.backend.isWebGPUBackend===true}));
}
async function renderedFrames(page,count=3){
  const from=(await snapshot(page)).performance.frames;
  await expect.poll(async()=>(await snapshot(page)).performance.frames-from,{intervals:[100,250]}).toBeGreaterThanOrEqual(count);
}
async function play(page){
  await page.locator('#startDarkBtn').click();
  await expect.poll(async()=>(await snapshot(page)).state).toBe('play');
  await page.evaluate(()=>HollowTest.silence());
  await renderedFrames(page);
}
// Composited pixels prove the canvas is presented: a failed swap chain or lost context leaves it flat.
async function canvasDetail(page){
  const hide=await page.addStyleTag({content:'body > :not(#game){visibility:hidden !important}'});
  const png=await page.locator('#game').screenshot();
  await hide.evaluate(tag=>tag.remove());
  return page.evaluate(async source=>{
    const image=new Image();image.src=source;await image.decode();
    const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
    const context=canvas.getContext('2d');context.drawImage(image,0,0);
    const data=context.getImageData(0,0,canvas.width,canvas.height).data;let sum=0,squares=0,count=0;
    for(let i=0;i<data.length;i+=16){const luma=data[i]*.2126+data[i+1]*.7152+data[i+2]*.0722;sum+=luma;squares+=luma*luma;count++;}
    const mean=sum/count;return {mean:Math.round(mean*10)/10,deviation:Math.round(Math.sqrt(Math.max(0,squares/count-mean*mean))*10)/10};
  },'data:image/png;base64,'+png.toString('base64'));
}
async function walks(page){
  const from=(await snapshot(page)).position;
  await page.keyboard.down('w');
  try{await expect.poll(async()=>{const p=(await snapshot(page)).position;return Math.hypot(p.x-from.x,p.z-from.z);}).toBeGreaterThan(.3);}
  finally{await page.keyboard.up('w');}
}

test('default boot selects WebGPU and presents gameplay frames without console errors',async({page})=>{
  const errors=watch(page);
  await boot(page,'/?qa=1');
  expect(await backend(page)).toEqual({global:'webgpu',snapshot:'webgpu',webgpu:true});
  await play(page);
  const s=await snapshot(page);
  expect(s.performance.drawCalls).toBeGreaterThan(10);expect(s.performance.triangles).toBeGreaterThan(1000);
  const detail=await canvasDetail(page);
  expect(detail.deviation).toBeGreaterThan(6);
  expect(errors).toEqual([]);
  console.log('WebGPU frame:',detail,'draw calls',s.performance.drawCalls);
});

test('?renderer=webgl forces the WebGL2 backend and the game plays cleanly',async({page})=>{
  const errors=watch(page);
  await boot(page,'/?qa=1&renderer=webgl');
  expect(await backend(page)).toEqual({global:'webgl2',snapshot:'webgl2',webgpu:false});
  await play(page);await walks(page);await renderedFrames(page);
  const detail=await canvasDetail(page);
  expect(detail.deviation).toBeGreaterThan(6);
  expect(errors).toEqual([]);
  console.log('Forced WebGL2 frame:',detail);
});

test('a browser without WebGPU falls back to WebGL2 cleanly',async({playwright,baseURL,launchOptions})=>{
  const browser=await playwright.chromium.launch({executablePath:launchOptions.executablePath,args:PLAIN_ARGS});
  try{
    const page=await browser.newPage({baseURL,viewport:{width:1000,height:650}});
    const errors=watch(page);
    await boot(page,'/?qa=1');
    expect(await page.evaluate(async()=>!navigator.gpu||!(await navigator.gpu.requestAdapter()))).toBe(true);
    expect(await backend(page)).toEqual({global:'webgl2',snapshot:'webgl2',webgpu:false});
    await play(page);
    const detail=await canvasDetail(page);
    expect(detail.deviation).toBeGreaterThan(6);
    expect(errors).toEqual([]);
    console.log('Fallback WebGL2 frame:',detail);
  }finally{await browser.close();}
});

test('a lost WebGL context pauses play and a rebuilt renderer resumes after restore',async({page})=>{
  const errors=watch(page);
  await boot(page,'/?qa=1&renderer=webgl');await play(page);
  await page.evaluate(()=>{window.__first=HollowRenderer;window.__lose=HollowRenderer.backend.gl.getExtension('WEBGL_lose_context');window.__lose.loseContext();});
  await expect.poll(async()=>(await snapshot(page)).state).toBe('pause');
  await expect(page.locator('#msg')).toContainText('Graphics paused');
  await page.evaluate(()=>window.__lose.restoreContext());
  await expect.poll(()=>page.evaluate(()=>window.HollowRenderer!==window.__first)).toBe(true);
  await expect(page.locator('#msg')).toContainText('Display restored');
  expect(await backend(page)).toEqual({global:'webgl2',snapshot:'webgl2',webgpu:false});
  await page.locator('#resumeBtn').click();
  await expect.poll(async()=>(await snapshot(page)).state).toBe('play');
  await renderedFrames(page);
  expect((await canvasDetail(page)).deviation).toBeGreaterThan(6);
  expect(errors).toEqual([]);
});

test('a lost WebGPU device pauses play and resumes on a new device',async({page})=>{
  const errors=watch(page);
  await boot(page,'/?qa=1');await play(page);
  // Browsers report a real loss through device.lost; the renderer forwards it exactly like this.
  await page.evaluate(()=>{window.__first=HollowRenderer;HollowRenderer.backend.device.destroy();HollowRenderer.onDeviceLost({api:'WebGPU',message:'QA device loss',reason:'unknown'});});
  await expect.poll(async()=>(await snapshot(page)).state).toBe('pause');
  await expect.poll(()=>page.evaluate(()=>window.HollowRenderer!==window.__first&&window.HollowRenderer.backend.device!==window.__first.backend.device)).toBe(true);
  await expect(page.locator('#msg')).toContainText('Display restored');
  expect(await backend(page)).toEqual({global:'webgpu',snapshot:'webgpu',webgpu:true});
  await page.locator('#resumeBtn').click();
  await expect.poll(async()=>(await snapshot(page)).state).toBe('play');
  await renderedFrames(page);
  expect((await canvasDetail(page)).deviation).toBeGreaterThan(6);
  expect(errors).toEqual([]);
});
