const {defineConfig}=require('@playwright/test');
const {existsSync}=require('node:fs');
module.exports=defineConfig({
  testDir:'./tests',testMatch:'**/*.spec.js',fullyParallel:false,workers:1,
  timeout:240000,expect:{timeout:45000},retries:0,
  reporter:[['list'],['html',{outputFolder:'playwright-report',open:'never'}]],
  use:{baseURL:'http://127.0.0.1:3099',viewport:{width:1000,height:650},
    launchOptions:{executablePath:process.env.CHROME_PATH||(existsSync('/usr/bin/google-chrome')?'/usr/bin/google-chrome':undefined),args:['--no-sandbox','--enable-unsafe-swiftshader']},
    screenshot:'only-on-failure',trace:{mode:'retain-on-failure',screenshots:false,snapshots:true}},
  webServer:{command:'node scripts/qa-server.js',url:'http://127.0.0.1:3099/health',reuseExistingServer:false,timeout:15000}
});
