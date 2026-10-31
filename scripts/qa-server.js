'use strict';
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createGameServer}=require('../server');
const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'hollow-browser-'));
const app=createGameServer({dataDir,scoreCooldownMs:0});
app.listen(Number(process.env.HOLLOW_TEST_PORT)||3099,'127.0.0.1').then(()=>console.log('Isolated Hollow QA server ready'));
async function shutdown(){await app.close();fs.rmSync(dataDir,{recursive:true,force:true});}
process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
