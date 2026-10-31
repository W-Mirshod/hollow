#!/usr/bin/env node
'use strict';

// Read-only post-deployment observation. Never restarts containers or writes scores.
const fs=require('node:fs');
const {spawnSync}=require('node:child_process');

const base=(process.env.HOLLOW_MONITOR_URL||'https://horror.wmirshod.uz').replace(/\/$/,'');
const expectedImage=process.env.HOLLOW_EXPECTED_IMAGE;
const output=process.env.HOLLOW_MONITOR_REPORT;
if(!/^sha256:[a-f0-9]{64}$/.test(expectedImage||''))throw new Error('HOLLOW_EXPECTED_IMAGE must identify the deployed immutable image');
if(!/^https:\/\//.test(base))throw new Error('Public monitoring requires HTTPS');
const began=new Date(),duration=300000,interval=15000,samples=[];
const stateFormat='{"id":"{{.Id}}","image":"{{.Image}}","running":{{.State.Running}},"restarts":{{.RestartCount}},"oom":{{.State.OOMKilled}},"health":"{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}"}';

function docker(args){
  const result=spawnSync('docker',args,{encoding:'utf8',timeout:8000,stdio:['ignore','pipe','pipe']});
  if(result.error||result.status!==0)throw new Error('Docker observation failed: '+(result.error?.message||result.stderr.trim()));
  return {out:result.stdout,err:result.stderr};
}
function save(status,error){
  const report={status,url:base,expectedImage,startedAt:began.toISOString(),finishedAt:new Date().toISOString(),durationSeconds:(Date.now()-began.getTime())/1000,samples,...(error?{error}: {})};
  if(output)fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});
  return report;
}
async function sample(){
  const start=performance.now();
  const response=await fetch(base+'/health',{cache:'no-store',signal:AbortSignal.timeout(8000)});
  const text=await response.text();
  if(response.status!==200||text!=='ok')throw new Error('Public health check failed: HTTP '+response.status);
  const state=JSON.parse(docker(['inspect','hollow','--format',stateFormat]).out);
  if(!state.running||state.restarts!==0||state.oom||state.health!=='healthy'||state.image!==expectedImage)throw new Error('Unexpected application state: '+JSON.stringify(state));
  const logs=docker(['logs','--since',began.toISOString(),'--tail','300','hollow']);
  const errors=(logs.out+'\n'+logs.err).split('\n').filter(line=>/\[hollow\]|\b(?:Error|Unhandled|FATAL|EADDRINUSE|EACCES|ENOENT)\b/.test(line));
  if(errors.length)throw new Error('Application error output detected during monitoring ('+errors.length+' lines)');
  const result={at:new Date().toISOString(),elapsedSeconds:Math.round((Date.now()-began.getTime())/1000),httpStatus:response.status,latencyMs:Math.round(performance.now()-start),health:state.health,restarts:state.restarts,applicationErrors:0};
  samples.push(result);console.log(JSON.stringify(result));
}
(async()=>{
  console.log(JSON.stringify({monitor:'started',url:base,durationSeconds:duration/1000,expectedImage}));
  while(true){
    await sample();const elapsed=Date.now()-began.getTime();if(elapsed>=duration)break;
    await new Promise(resolve=>setTimeout(resolve,Math.min(interval,duration-elapsed)));
  }
  const report=save('passed');console.log(JSON.stringify({monitor:'passed',samples:samples.length,durationSeconds:Math.round(report.durationSeconds),report:output||null}));
})().catch(error=>{save('failed',error.message);console.error(JSON.stringify({monitor:'failed',error:error.message}));process.exitCode=1;});
