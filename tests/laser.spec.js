const {test,expect}=require('@playwright/test');
const fs=require('node:fs');
const path=require('node:path');
const {CELL,LASER,FLOORS}=require('../public/systems');

test.setTimeout(600000);
test.use({screenshot:'off',trace:'off',viewport:{width:900,height:560}});

const SHOTS=path.join(__dirname,'..','artifacts');
let pages=[];
test.beforeEach(()=>{pages=[];fs.mkdirSync(SHOTS,{recursive:true});});
test.afterEach(()=>expect(pages.flatMap(page=>page.hollowErrors),'No page errors').toEqual([]));

async function boot(page,name='Laser QA'){
  page.hollowErrors=[];pages.push(page);
  page.on('pageerror',error=>page.hollowErrors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')page.hollowErrors.push(message.text());});
  await page.addInitScript(name=>{
    localStorage.setItem('hollow.playerName',name);
    localStorage.setItem('hollow.settings',JSON.stringify({quality:'low',motion:true,sensitivity:1,volume:0,effects:true}));
  },name);
  await page.goto('/?qa=1');
  await page.waitForFunction(()=>!!window.HollowGame&&typeof window.HollowTest?.advance==='function');
}
async function ready(page){
  await boot(page);
  await page.locator('#startDarkBtn').click();
  await expect.poll(()=>page.evaluate(()=>HollowGame.snapshot().state)).toBe('play');
  await page.evaluate(()=>{const T=HollowTest;T.silence();T.freezeAI(true);T.torch(false);});
}
const snapshot=page=>page.evaluate(()=>HollowGame.snapshot());
async function frames(page,count=2){
  const from=(await snapshot(page)).performance.frames;
  await expect.poll(async()=>(await snapshot(page)).performance.frames-from,{intervals:[100,250,500],timeout:90000}).toBeGreaterThanOrEqual(count);
}
// A corridor crossing on the current floor, clear of the charges lying there: open for 7.5 m in at least three of the
// four directions, with a cell 4-7 m off behind a wall and one 11-15 m off.
const ARENA=cell=>{
  const T=HollowTest,s=HollowGame.snapshot(),grid=T.maze(),n=grid.length;
  const wall=(x,z)=>{const r=grid[Math.floor(z/cell)];return !r||r[Math.floor(x/cell)]!==0;};
  const free=(cx,cz)=>cx>0&&cz>0&&cx<n-1&&cz<n-1&&grid[cz][cx]===0&&T.navClear((cx+.5)*cell,(cz+.5)*cell,(cx+.5)*cell,(cz+.5)*cell,.6);
  const ring=(cx,cz,lo,hi,ok)=>{for(let qz=cz-6;qz<=cz+6;qz++)for(let qx=cx-6;qx<=cx+6;qx++){const d=Math.hypot(qx-cx,qz-cz)*cell;
    if(d>=lo&&d<=hi&&free(qx,qz)&&ok(qx,qz))return {x:(qx+.5)*cell,z:(qz+.5)*cell,d};}return null;};
  for(let cz=1;cz<n-1;cz++)for(let cx=1;cx<n-1;cx++){
    const x=(cx+.5)*cell,z=(cz+.5)*cell;
    if(!free(cx,cz)||cx<=6&&cz<=4||[...s.laserPickups,...s.ammoPickups].some(p=>Math.hypot(p.x-x,p.z-z)<4))continue;
    const dirs=[[1,0],[0,1],[-1,0],[0,-1]].filter(([dx,dz])=>T.navClear(x,z,x+dx*7.5,z+dz*7.5,.6));if(dirs.length<3)continue;
    const hidden=ring(cx,cz,4,7,(qx,qz)=>{const hx=(qx+.5)*cell,hz=(qz+.5)*cell;for(let k=.05;k<.95;k+=.02)if(wall(x+(hx-x)*k,z+(hz-z)*k))return true;return false;});
    const far=ring(cx,cz,11,15,()=>true);
    if(hidden&&far)return {x,z,dirs,hidden,far};
  }
  return null;
};

test('G sends beams out on every side: everything in reach dies headless, a body on the floor too; a wall or the range spares the rest',async({page})=>{
  await ready(page);
  const a=await page.evaluate(ARENA,CELL);
  expect(a,'an open crossing').toBeTruthy();
  const before=await page.evaluate(a=>{
    const T=HollowTest,[d0,d1,d2]=a.dirs;
    T.pose({x:a.x,z:a.z,yaw:Math.atan2(-d0[0],-d0[1]),pitch:-.05});
    // Three creatures round the survivor in the open, one behind a wall, one out of reach, and a body lying beyond the first.
    T.enemy(0,{x:a.x+d0[0]*3.2,z:a.z+d0[1]*3.2,yaw:Math.atan2(-d0[0],-d0[1])});
    T.enemy(1,{x:a.x+d1[0]*4.6,z:a.z+d1[1]*4.6,yaw:Math.atan2(-d1[0],-d1[1])});
    T.enemy(2,{x:a.x+d2[0]*6,z:a.z+d2[1]*6,yaw:Math.atan2(-d2[0],-d2[1])});
    T.enemy(3,{x:a.hidden.x,z:a.hidden.z});T.enemy(4,{x:a.far.x,z:a.far.z});
    const body=T.sleeper(5,{x:a.x+d0[0]*6.8,z:a.z+d0[1]*6.8,yaw:Math.atan2(d0[0],d0[1])});
    T.freezeAI(true);T.advance(.1);
    const s=HollowGame.snapshot();
    return {s,body,hud:document.getElementById('laserTxt').textContent,cues:s.audioLog.filter(c=>c.cue==='laser').length};
  },a);
  expect(before.s.lasers,'one charge to start a run').toBe(LASER.start);
  expect(before.hud).toBe('LASER ×1 · G');
  expect(before.s.enemies.slice(0,6).map(e=>e.dead)).toEqual([false,false,false,false,false,false]);
  expect(before.s.enemies[5].dormant).toBe(true);
  await frames(page,2);
  await page.screenshot({path:path.join(SHOTS,'laser-before.png')});
  await page.keyboard.press('g');
  await frames(page,1);
  await page.screenshot({path:path.join(SHOTS,'laser-burst.png')});
  const after=await page.evaluate(()=>{HollowTest.advance(1.2);const s=HollowGame.snapshot();
    return {s,msg:document.getElementById('msg').textContent,hud:document.getElementById('laserTxt').textContent,empty:document.getElementById('laserTxt').classList.contains('empty')};});
  const e=after.s.enemies;
  expect(after.s.lasers).toBe(0);
  for(const i of [0,1,2,5]){
    expect(e[i].dead,`creature ${i} in the open is cut down`).toBe(true);
    expect(e[i].hits.gibbed,`creature ${i} loses its head`).toBe(true);
  }
  expect(e[5].dormant,'the body on the floor dies where it lies').toBe(false);
  expect(e[3].dead,'the wall shields the one behind it').toBe(false);
  expect(e[4].dead,'out of reach').toBe(false);
  expect(e[3].hp,'untouched').toBe(before.s.enemies[3].hp);
  expect(e.slice(0,6).filter(x=>x.hits.severed.length).length,'the first two lose an arm too').toBe(2);
  expect(after.s.laser.last).toMatchObject({mine:true,kills:4});
  expect(after.s.laser.last.hit.sort()).toEqual([0,1,2,5]);
  expect(after.s.score.kills-before.s.score.kills).toBe(4);
  expect(after.s.score.points).toBeGreaterThan(before.s.score.points);
  expect(after.s.audioLog.filter(c=>c.cue==='laser'&&c.kind==='own').length).toBe(before.cues+1);
  expect(after.msg).toBe('Laser burst · 4 cut down · no charges left.');
  expect(after.hud).toBe('LASER ×0 · G');expect(after.empty).toBe(true);
  expect(after.s.gore.chunks+after.s.gore.pools).toBeGreaterThan(0);
  // The noise brings the survivors of it running.
  expect(e[3].state).toBe('chase');
  await page.screenshot({path:path.join(SHOTS,'laser-after.png')});
  // Out of charges: G does nothing but say where more lie.
  const cues=after.s.audioLog.filter(c=>c.cue==='laser').length;
  await page.evaluate(()=>HollowTest.advance(1.5));
  await page.keyboard.press('g');
  await expect(page.locator('#msg')).toContainText('No laser charges');
  const spent=await page.evaluate(()=>{HollowTest.advance(.5);return HollowGame.snapshot();});
  expect(spent.lasers).toBe(0);expect(spent.laser.cutting).toBe(0);
  expect(spent.audioLog.filter(c=>c.cue==='laser').length).toBe(cues);
  expect(spent.enemies[3].dead).toBe(false);
});

test('charges lie along the corridors, the same for a seed; walking over one takes it, up to the most a survivor carries',async({page})=>{
  await ready(page);
  const s=await snapshot(page);
  expect(s.laserPickups).toHaveLength(FLOORS[0].lasers);
  for(const l of s.laserPickups){
    expect(l).toMatchObject({taken:false,pending:false,visible:true});
    const cx=Math.floor(l.x/CELL),cz=Math.floor(l.z/CELL);
    expect(cx<=6&&cz<=4,'never in the lobby').toBe(false);
    expect(s.rooms.some(r=>cx>=r.x&&cx<r.x+r.w&&cz>=r.z&&cz<r.z+r.d),'out in the corridors').toBe(false);
    expect(s.ammoPickups.every(b=>Math.hypot(b.x-l.x,b.z-l.z)>=2.4)).toBe(true);
  }
  const far=s.laserPickups.map(l=>Math.hypot(l.x-s.position.x,l.z-s.position.z));
  expect(Math.max(...far)-Math.min(...far),'one nearer the start, one further along').toBeGreaterThan(9);
  // The seed places them: rebuilt with it they lie where they did, and the rest of the floor is untouched.
  const again=await page.evaluate(seed=>{HollowTest.build(seed);HollowTest.silence();return HollowGame.snapshot();},s.seed);
  expect(again.laserPickups).toEqual(s.laserPickups);
  expect(again.ammoPickups).toEqual(s.ammoPickups);expect(again.loot.map(l=>[l.id,l.x,l.z])).toEqual(s.loot.map(l=>[l.id,l.x,l.z]));
  const other=await page.evaluate(seed=>{HollowTest.build(seed);HollowTest.silence();return HollowGame.snapshot().laserPickups;},s.seed+7);
  expect(other).not.toEqual(s.laserPickups);
  await page.evaluate(seed=>{HollowTest.build(seed);HollowTest.silence();HollowTest.freezeAI(true);},s.seed);
  // The floor plan marks them; close by, the prompt says what it is.
  await page.keyboard.press('m');
  await expect(page.locator('#interactionPrompt')).toContainText('red stars = laser charges');
  await frames(page,2);
  await page.screenshot({path:path.join(SHOTS,'laser-map.png')});
  await page.keyboard.press('m');
  const [first,second]=s.laserPickups;
  const spot=await page.evaluate(l=>{for(let k=0;k<8;k++){const dx=Math.sin(k*Math.PI/4),dz=Math.cos(k*Math.PI/4),x=l.x+dx*1.8,z=l.z+dz*1.8;
    if(HollowTest.navClear(x,z,l.x,l.z,.32))return {x,z,yaw:Math.atan2(dx,dz),pitch:-.35};}return null;},first);
  expect(spot).toBeTruthy();
  await page.evaluate(spot=>{HollowTest.pose(spot);HollowTest.advance(.1);},spot);
  await expect(page.locator('#interactionPrompt')).toContainText('WALK OVER · laser burst charge');
  await frames(page,2);
  await page.screenshot({path:path.join(SHOTS,'laser-pickup.png')});
  const took=await page.evaluate(l=>{HollowTest.pose({x:l.x,z:l.z});HollowTest.advance(.2);return {s:HollowGame.snapshot(),msg:document.getElementById('msg').textContent,hud:document.getElementById('laserTxt').textContent};},first);
  expect(took.s.lasers).toBe(2);
  expect(took.s.laserPickups[0]).toMatchObject({taken:true,visible:false});
  expect(took.msg).toContain('Laser burst charge · 2 carried');expect(took.hud).toBe('LASER ×2 · G');
  // Taken once: standing there again gives nothing more.
  expect(await page.evaluate(()=>{HollowTest.advance(.3);return HollowGame.snapshot().lasers;})).toBe(2);
  // Full: the charge stays where it is until there is room for it.
  const full=await page.evaluate(l=>{HollowTest.lasers(5);HollowTest.pose({x:l.x,z:l.z});HollowTest.advance(.2);return {s:HollowGame.snapshot(),msg:document.getElementById('msg').textContent};},second);
  expect(full.s.lasers).toBe(LASER.max);expect(full.s.laserPickups[1]).toMatchObject({taken:false,visible:true});
  expect(full.msg).toContain('Laser charges full');
  const room=await page.evaluate(()=>{HollowTest.lasers(4);HollowTest.advance(.2);return HollowGame.snapshot();});
  expect(room.lasers).toBe(LASER.max);expect(room.laserPickups[1]).toMatchObject({taken:true,visible:false});
});

test('the charges carried go down to the next floor, and a retry starts the floor with what was carried down',async({page})=>{
  await ready(page);
  const b2=await page.evaluate(()=>{const T=HollowTest;T.lasers(3);T.floor(1);T.silence();T.freezeAI(true);T.advance(.3);return HollowGame.snapshot();});
  expect(b2).toMatchObject({floorCode:'B2',lasers:3});
  expect(b2.laserPickups).toHaveLength(FLOORS[1].lasers);
  expect(JSON.parse(await page.evaluate(()=>localStorage.getItem('hollow.campaign'))).kit.lasers).toBe(3);
  const used=await page.evaluate(()=>{HollowTest.action('laser',true);HollowTest.action('laser',false);HollowTest.advance(1.4);HollowTest.action('laser',true);HollowTest.action('laser',false);HollowTest.advance(1);return HollowGame.snapshot();});
  expect(used.lasers).toBe(1);
  expect(used.laser.last).toMatchObject({mine:true,kills:0});
  expect(await page.locator('#msg').textContent()).toBe('Laser burst · nothing in reach · 1 charge left.');
  expect(await page.evaluate(()=>{
    const p=HollowGame.snapshot().position;HollowTest.health(1);HollowTest.enemy(1,{x:p.x+.9,z:p.z,state:'chase',yaw:-Math.PI/2});HollowTest.freezeAI(false);
    for(let i=0;i<40&&HollowGame.snapshot().state==='play';i++)HollowTest.advance(.05);return HollowGame.snapshot().state;
  })).toBe('caught');
  await expect.poll(async()=>(await snapshot(page)).state,{timeout:180000}).toBe('dead');
  await expect(page.locator('#retryDark')).toHaveText('Retry B2 · Records & Morgue');
  await page.locator('#retryDark').click();
  await expect.poll(async()=>{const s=await snapshot(page);return s.state==='play'&&s.seed!==b2.seed;},{timeout:90000}).toBe(true);
  const retry=await snapshot(page);
  expect(retry).toMatchObject({floorCode:'B2',lasers:3});
  expect(retry.laserPickups.every(l=>!l.taken&&l.visible)).toBe(true);
});

test('the Gravekeeper takes one burst and keeps coming; the one that finishes it takes its head',async({page})=>{
  await ready(page);
  const up=await page.evaluate(()=>{const T=HollowTest;T.floor(4);T.silence();T.boss('wake',true);T.freezeAI(false);T.advance(3);T.health(100);T.freezeAI(true);return T.boss();});
  expect(up).toMatchObject({dead:false,hp:90,sink:0,visible:true});
  // The Gravekeeper in the open, the survivor 5 m off.
  const spot=await page.evaluate(()=>{
    const T=HollowTest;
    for(let x=10.5;x<100;x+=3)for(let z=10.5;z<100;z+=3){if(!T.navClear(x,z,x,z,1))continue;
      for(const [dx,dz] of [[1,0],[0,1],[-1,0],[0,-1]])if(T.navClear(x,z,x+dx*5,z+dz*5,.9))return {x,z,px:x+dx*5,pz:z+dz*5};}
    return null;
  });
  expect(spot).toBeTruthy();
  const first=await page.evaluate(s=>{const T=HollowTest;T.boss('pose',{x:s.x,z:s.z});T.pose({x:s.px,z:s.pz,yaw:Math.atan2(s.x-s.px,s.z-s.pz)});T.health(100);T.lasers(1);
    T.action('laser',true);T.action('laser',false);T.advance(1);T.health(100);return {boss:T.boss(),last:HollowGame.snapshot().laser.last,msg:document.getElementById('msg').textContent};},spot);
  expect(first.boss).toMatchObject({dead:false,hp:90-LASER.boss});
  expect(first.boss.hits.gibbed).toBe(false);
  expect(first.last).toMatchObject({boss:LASER.boss,kills:0});
  expect(first.msg).toContain(`the Gravekeeper burned (−${LASER.boss})`);
  const second=await page.evaluate(s=>{const T=HollowTest;T.boss('hit',40);T.boss('pose',{x:s.x,z:s.z});T.pose({x:s.px,z:s.pz,yaw:Math.atan2(s.x-s.px,s.z-s.pz)});T.health(100);const hp=T.boss().hp;
    T.lasers(1);T.action('laser',true);T.action('laser',false);T.advance(1);T.health(100);
    // (Its fall is its own AI's to play: the QA freeze holds that back, as in tests/above-ground.spec.js.)
    T.freezeAI(false);T.advance(.1);T.health(100);T.freezeAI(true);return {hp,boss:T.boss(),last:HollowGame.snapshot().laser.last,banner:HollowGame.snapshot().hud.banner};},spot);
  expect(second.hp).toBeLessThanOrEqual(LASER.boss);
  expect(second.boss).toMatchObject({dead:true,act:'dead'});
  expect(second.boss.hits.gibbed).toBe(true);expect(second.banner).toBe('THE GRAVEKEEPER FALLS');
  expect(second.last.kills).toBeGreaterThanOrEqual(1);
  await frames(page,2);
  await page.screenshot({path:path.join(SHOTS,'laser-gravekeeper.png')});
});

test('co-op: a guest\'s burst is played on both screens, the host cuts the creatures down and the guest scores them; a charge a guest walks over is the host\'s to grant',async({browser})=>{
  const contexts=await Promise.all([0,1].map(()=>browser.newContext({viewport:{width:800,height:520}})));
  const [host,guest]=await Promise.all(contexts.map(c=>c.newPage()));
  try{
    await Promise.all([boot(host,'Laser host'),boot(guest,'Laser guest')]);
    await host.locator('#coopBtn').click();await host.locator('#coopCreate').click();await expect(host.locator('#coopLobby')).toBeVisible();
    const code=await host.locator('#coopCode').textContent();
    await guest.locator('#coopBtn').click();await guest.locator('#coopCodeIn').fill(code);await guest.locator('#coopJoinForm button').click();
    await expect(host.locator('#coopStart')).toBeEnabled();await host.locator('#coopStart').click();
    await Promise.all([host,guest].map(page=>expect.poll(async()=>(await snapshot(page)).state,{timeout:90000}).toBe('play')));
    const h0=await snapshot(host),g0=await snapshot(guest);
    expect(g0.laserPickups,'both see the charges in the same places').toEqual(h0.laserPickups);
    expect([h0.lasers,g0.lasers]).toEqual([LASER.start,LASER.start]);
    await host.evaluate(()=>{HollowTest.silence();HollowTest.freezeAI(true);HollowTest.torch(false);});
    await expect.poll(async()=>(await snapshot(guest)).enemies.every(e=>e.dead),{timeout:60000}).toBe(true);
    // The guest at a crossing, two creatures (the host's) in the open beside them.
    const a=await host.evaluate(ARENA,CELL);expect(a).toBeTruthy();
    await guest.evaluate(a=>HollowTest.pose({x:a.x,z:a.z,yaw:0}),a);
    await host.evaluate(a=>{const T=HollowTest,[d0,d1]=a.dirs;T.pose({x:a.far.x,z:a.far.z});
      T.enemy(0,{x:a.x+d0[0]*3.5,z:a.z+d0[1]*3.5});T.enemy(1,{x:a.x+d1[0]*5,z:a.z+d1[1]*5});T.freezeAI(true);},a);
    await expect.poll(async()=>{const e=(await snapshot(guest)).enemies;return !e[0].dead&&!e[1].dead&&Math.hypot(e[0].x-a.x,e[0].z-a.z)<4.5&&Math.hypot(e[1].x-a.x,e[1].z-a.z)<6;},{timeout:60000}).toBe(true);
    const kills0=(await snapshot(guest)).score.kills;
    await guest.evaluate(()=>{HollowTest.action('laser',true);HollowTest.action('laser',false);});
    await expect.poll(async()=>{const e=(await snapshot(host)).enemies;return e[0].dead&&e[1].dead;},{timeout:60000}).toBe(true);
    await expect.poll(async()=>(await snapshot(guest)).score.kills-kills0,{timeout:60000}).toBe(2);
    const g1=await snapshot(guest),h1=await snapshot(host);
    expect(g1.lasers).toBe(0);expect(h1.lasers,'the host\'s own charge is untouched').toBe(LASER.start);
    expect(g1.audioLog.some(c=>c.cue==='laser'&&c.kind==='own')).toBe(true);
    expect(h1.audioLog.some(c=>c.cue==='laser'&&c.kind==='partner'),'the host hears and sees it').toBe(true);
    expect(h1.score.kills,'the host does not score the guest\'s kills').toBe(h0.score.kills);
    await expect.poll(async()=>{const e=(await snapshot(guest)).enemies;return e[0].dead&&e[1].dead&&e[0].hits.gibbed&&e[1].hits.gibbed;},{timeout:30000}).toBe(true);
    await guest.screenshot({path:path.join(SHOTS,'laser-coop-guest.png')});
    // A charge the guest walks over: pending until the host grants it, then the guest's, taken on both screens.
    const item=h1.laserPickups[0];
    await guest.evaluate(l=>HollowTest.pose({x:l.x,z:l.z}),item);
    await expect.poll(async()=>(await snapshot(guest)).lasers,{timeout:60000}).toBe(1);
    await expect.poll(async()=>(await snapshot(host)).laserPickups[0].taken,{timeout:30000}).toBe(true);
    await expect.poll(async()=>{const l=(await snapshot(guest)).laserPickups[0];return l.taken&&!l.pending&&!l.visible;},{timeout:30000}).toBe(true);
    expect((await snapshot(host)).lasers).toBe(LASER.start);
    await frames(guest,3);
    expect((await snapshot(guest)).lasers,'granted once').toBe(1);
  }finally{await Promise.all(contexts.map(c=>c.close()));}
});
