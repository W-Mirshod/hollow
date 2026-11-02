const {defineConfig}=require('@playwright/test');
const {existsSync}=require('node:fs');
// Headless Chrome exposes WebGPU (SwiftShader adapter) only behind --enable-unsafe-webgpu, and can present a WebGPU
// canvas only with Vulkan compositing; ANGLE on Vulkan keeps the WebGL2 fallback on the same device path.
// Chrome honours only the last --enable-features switch, so Playwright's own screenshot feature is repeated here.
const webgpuArgs=['--enable-unsafe-webgpu','--use-angle=vulkan','--use-vulkan=swiftshader',
  '--enable-features=Vulkan'+(process.env.PLAYWRIGHT_LEGACY_SCREENSHOT?'':',CDPScreenshotNewSurface')];
module.exports=defineConfig({
  testDir:'./tests',testMatch:'**/*.spec.js',fullyParallel:false,workers:1,
  timeout:240000,expect:{timeout:45000},retries:0,
  reporter:[['list'],['html',{outputFolder:'playwright-report',open:'never'}]],
  use:{baseURL:'http://127.0.0.1:3099',viewport:{width:1000,height:650},
    launchOptions:{executablePath:process.env.CHROME_PATH||(existsSync('/usr/bin/google-chrome')?'/usr/bin/google-chrome':undefined),args:['--no-sandbox','--enable-unsafe-swiftshader',...webgpuArgs]},
    screenshot:'only-on-failure',trace:{mode:'retain-on-failure',screenshots:false,snapshots:true}},
  webServer:{command:'node scripts/qa-server.js',url:'http://127.0.0.1:3099/health',reuseExistingServer:false,timeout:15000}
});
