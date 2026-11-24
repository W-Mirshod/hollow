const {test,expect}=require('@playwright/test');

// The four guns found below the start: each is picked up where it lies, drawn with its number key, fired into a body and
// reloaded; the floor plan marks every gun still lying on the floor with its own silhouette, from the first frame.
// Screenshots go to artifacts/guns-<id>.png and artifacts/guns-map.png.
test.setTimeout(300000);
test.use({viewport:{width:1000,height:650}});

let pages=[];
test.beforeEach(()=>{pages=[];});
test.afterEach(()=>expect(pages.flatMap(page=>page.hollowErrors),'No uncaught game or shader errors').toEqual([]));

async function ready(page,name='Guns QA'){
  page.hollowErrors=[];pages.push(page);
  page.on('pageerror',error=>page.hollowErrors.push(error.message));
  page.on('console',message=>{const text=message.text();if((message.type()==='error'&&/WebGL|WebGPU|WGSL|shader|GL_INVALID|Startup failed/i.test(text))||/ - While (?:calling|validating|encoding|finishing|creating)|\[Invalid [A-Z]/.test(text))page.hollowErrors.push(text);});
  await page.addInitScript(name=>{
    localStorage.setItem('hollow.playerName',name);
    localStorage.setItem('hollow.settings',JSON.stringify({quality:'low',motion:false,effects:true,sensitivity:1,volume:0}));
  },name);
  await page.goto('/?qa=1');
  await page.waitForFunction(()=>!!window.HollowGame&&typeof window.HollowTest?.advance==='function');
}
const snapshot=page=>page.evaluate(()=>HollowGame.snapshot());
async function start(page){
  await page.locator('#startDarkBtn').click();
  await expect.poll(async()=>(await snapshot(page)).state).toBe('play');
  await page.evaluate(()=>HollowTest.silence());
}
// A spot 1.2 m from a pickup with a clear walk to it, facing it, and clear of anything collected by walking over it.
async function approach(page,item){
  const spot=await page.evaluate(item=>{
    const s=HollowGame.snapshot(),auto=[...s.ammoPickups,...s.loot.filter(l=>l.type==='ammo'||l.type==='supplies')].filter(p=>!p.taken);
    for(const r of [1.2,1,1.6])for(let k=0;k<8;k++){const dx=Math.sin(k*Math.PI/4),dz=Math.cos(k*Math.PI/4),x=item.x+dx*r,z=item.z+dz*r;
      if(HollowTest.navClear(x,z,item.x,item.z,.32)&&auto.every(p=>Math.hypot(p.x-x,p.z-z)>1.4))return {x,z,yaw:Math.atan2(dx,dz)};}
    return null;
  },item);
  expect(spot,`${item.id} has a clear approach`).toBeTruthy();return spot;
}
async function frames(page,count=3){
  const from=(await snapshot(page)).performance.frames;
  await expect.poll(async()=>(await snapshot(page)).performance.frames-from,{intervals:[100,250,500]}).toBeGreaterThanOrEqual(count);
}
// The plan's guns as drawn (CSS px from the map's top-left), with where each loot lies scaled onto the shown map, and
// whether the backing store holds a bright icon pixel round each centre.
const plan=page=>page.evaluate(()=>{
  const s=HollowGame.snapshot(),map=document.getElementById('map'),css=map.clientWidth,k=map.width/css,world=HollowSystems.SIZE*HollowSystems.CELL;
  const pixels=map.getContext('2d').getImageData(0,0,map.width,map.height).data;
  const lit=g=>{let best=0;for(let z=Math.floor((g.z-g.h/2)*k);z<=(g.z+g.h/2)*k;z++)for(let x=Math.floor((g.x-g.w/2)*k);x<=(g.x+g.w/2)*k;x++){
    if(x<0||z<0||x>=map.width||z>=map.height)continue;const i=(z*map.width+x)*4;best=Math.max(best,Math.min(pixels[i],pixels[i+1],pixels[i+2],pixels[i+3]));}return best;};
  const box=map.getBoundingClientRect();
  return {css,backing:map.width,dpr:devicePixelRatio,clip:{x:box.x-8,y:box.y-8,width:box.width+16,height:box.height+16},
    lying:s.loot.filter(l=>l.type==='weapon'&&l.visible&&!l.taken).map(l=>({id:l.id,kind:l.weapon,x:l.x/world*css,z:l.z/world*css})),
    guns:s.mapGuns.map(g=>({...g,lit:lit(g)}))};
});
function expectPlan(p){
  expect(p.backing,'the plan is painted at the screen\'s pixel density').toBe(Math.max(64,Math.round(p.css*Math.min(2,Math.max(1,p.dpr)))));
  expect(p.guns.map(g=>g.id).sort()).toEqual(p.lying.map(l=>l.id).sort());
  for(const l of p.lying){
    const g=p.guns.find(g=>g.id===l.id);
    expect(g.kind,`${l.id} is drawn as its own gun`).toBe(l.kind);
    expect(Math.abs(g.x-l.x),`${l.id} x`).toBeLessThan(.01);expect(Math.abs(g.z-l.z),`${l.id} z`).toBeLessThan(.01);
    expect(g.w).toBeGreaterThan(g.h*1.3);
    expect(g.lit,`${l.id} has a bright silhouette on the plan`).toBeGreaterThan(200);
  }
}

const GUNS=[{id:'smg',floor:0,key:'4',tag:'SMG',title:'KV-9'},{id:'magnum',floor:1,key:'5',tag:'.44',title:'.44'},
  {id:'marksman',floor:2,key:'6',tag:'DMR',title:'M24'},{id:'lmg',floor:2,key:'7',tag:'LMG',title:'M249'}];

for(const gun of GUNS){
  test(`the ${gun.title} is taken where it lies, drawn with ${gun.key}, fired into a body and reloaded`,async({page})=>{
    await ready(page);await start(page);
    if(gun.floor)await page.evaluate(i=>{HollowTest.floor(i);HollowTest.silence();},gun.floor);
    const def=await page.evaluate(id=>HollowSystems.WEAPONS.find(w=>w.id===id),gun.id);
    const s=await snapshot(page);
    expect(s).toMatchObject({floor:gun.floor,owned:['pistol'],weapon:'pistol'});
    const loot=s.loot.find(l=>l.type==='weapon'&&l.weapon===gun.id);
    expect(loot).toMatchObject({weapon:gun.id,taken:false,visible:true});
    // On the plan from the start, as its own silhouette, until it is taken.
    await expect.poll(async()=>(await snapshot(page)).mapGuns.find(g=>g.id===loot.id)?.kind).toBe(gun.id);
    expectPlan(await plan(page));
    await page.keyboard.press(gun.key);await expect(page.locator('#msg')).toContainText(`No ${def.name}`);
    await page.evaluate(at=>HollowTest.pose(at),await approach(page,loot));
    await expect(page.locator('#interactionPrompt')).toContainText(`Take the ${def.name}`);
    await page.evaluate(()=>{const s=HollowGame.snapshot();HollowTest.torch(true);HollowTest.pose({x:s.position.x,z:s.position.z,yaw:s.yaw,pitch:-.55});});
    await frames(page,3);
    await page.screenshot({path:`artifacts/guns-${gun.id}-found.png`,style:'#msg,#interactionPrompt{visibility:hidden!important}'});
    await page.keyboard.press('e');
    await expect.poll(async()=>(await snapshot(page)).weapon).toBe(gun.id);
    const taken=await snapshot(page);
    expect(taken).toMatchObject({owned:['pistol',gun.id],mag:def.capacity,reserve:def.reserve});
    expect(taken.loot.find(l=>l.id===loot.id)).toMatchObject({taken:true,visible:false});
    await expect.poll(async()=>(await snapshot(page)).mapGuns.some(g=>g.id===loot.id),'its icon leaves the plan').toBe(false);
    await expect(page.locator('#weaponSlots span')).toHaveCount(7);
    await expect(page.locator('#weaponSlots span.locked')).toHaveCount(5);
    // Its number key draws it again after the sidearm; Q cycles between the two.
    await page.keyboard.press('2');await expect.poll(async()=>(await snapshot(page)).weapon).toBe('pistol');
    await page.keyboard.press(gun.key);await expect.poll(async()=>(await snapshot(page)).weapon).toBe(gun.id);
    await expect(page.locator('#weaponSlots span.selected')).toHaveText(`${gun.key} ${gun.tag}`);
    await expect(page.locator('#weaponName')).toHaveText(def.name);
    await page.keyboard.press('q');await expect.poll(async()=>(await snapshot(page)).weapon).toBe('pistol');
    await page.keyboard.press('q');await expect.poll(async()=>(await snapshot(page)).weapon).toBe(gun.id);
    // Down the longest clear line from here: the first-person shots (with and without the HUD), then a body to hit.
    const line=await page.evaluate(()=>{
      const T=HollowTest,s=HollowGame.snapshot(),{x,z}=s.position;let best=null;
      for(let k=0;k<16;k++){const yaw=k*Math.PI/8,dx=-Math.sin(yaw),dz=-Math.cos(yaw);let reach=0;
        for(let d=1;d<=12&&T.navClear(x,z,x+dx*d,z+dz*d,.45);d++)reach=d;
        if(reach>=5&&(!best||reach>best.reach))best={x,z,yaw,dx,dz,reach};}
      if(best){T.torch(true);T.pose({x,z,yaw:best.yaw,pitch:-.06});T.advance(.6);}
      return best;
    });
    expect(line,'a clear line of fire near the gun').toBeTruthy();
    await frames(page,3);
    const quiet='#msg,#interactionPrompt,#horrorCaption{visibility:hidden!important}';
    await page.screenshot({path:`artifacts/guns-${gun.id}-hud.png`,style:quiet});
    await page.screenshot({path:`artifacts/guns-${gun.id}.png`,style:quiet+'#hud,#ammo,#controlsHint{visibility:hidden!important}'});

    // One aimed shot into a body four metres down the line.
    const shot=await page.evaluate(line=>{
      const T=HollowTest,G=HollowGame,s=G.snapshot(),eye=s.position.y+1.6;
      const index=['stalker','shrieker','warden'].map(kind=>s.enemies.findIndex(e=>e.kind===kind)).find(i=>i>=0);
      const torso={stalker:1.45,shrieker:1.3,warden:1.7}[s.enemies[index].kind];
      T.freezeAI(true);T.action('aim',true);T.advance(.4);
      T.pose({x:line.x,z:line.z,yaw:line.yaw,pitch:Math.atan((torso-eye)/4)});
      T.enemy(index,{x:line.x+line.dx*4,z:line.z+line.dz*4,state:'wander',yaw:line.yaw});
      const before=G.snapshot();
      T.action('fire',true);T.advance(.05);T.action('fire',false);T.action('aim',false);
      const after=G.snapshot();T.freezeAI(false);T.silence();
      return {kind:before.enemies[index].kind,hp:before.enemies[index].hp,after:after.enemies[index],mag:after.mag,before:before.mag};
    },line);
    expect(shot.mag).toBeLessThan(shot.before);
    expect(shot.after.dead||shot.after.hp<shot.hp,`the ${gun.id} hits the ${shot.kind} (${shot.hp} -> ${shot.after.hp})`).toBe(true);

    // R reloads to a full magazine from the reserve.
    const fired=await snapshot(page);
    await page.keyboard.press('r');
    await expect.poll(async()=>(await snapshot(page)).reloadT).toBeGreaterThan(0);
    const done=await page.evaluate(seconds=>{HollowTest.advance(seconds);return HollowGame.snapshot();},def.reload+.3);
    expect(done).toMatchObject({weapon:gun.id,mag:def.capacity,reloadT:0});
    expect(done.reserve).toBe(fired.reserve-(def.capacity-fired.mag));
  });
}

test('the floor plan marks every gun still lying with its silhouette, crisp on the minimap and the M plan',async({page})=>{
  await ready(page);await start(page);
  // B1 from the first frame: the carbine in the armory and the KV-9 in the stores.
  await expect.poll(async()=>(await snapshot(page)).mapGuns.map(g=>g.id).sort()).toEqual(['armory:rifle','stores:smg']);
  const b1=await plan(page);expectPlan(b1);
  expect(b1.css).toBe(112);
  for(const g of b1.guns){expect(g.w).toBeGreaterThanOrEqual(10);expect(g.w).toBeLessThan(26);}
  // B3 with the sidearm alone: six guns lie on the floor.
  await page.evaluate(()=>{HollowTest.floor(2);HollowTest.silence();});
  await expect.poll(async()=>(await snapshot(page)).mapGuns.map(g=>g.kind).sort()).toEqual(['lmg','magnum','marksman','rifle','shotgun','smg']);
  const small=await plan(page);expectPlan(small);
  await page.screenshot({path:'artifacts/guns-minimap.png',clip:small.clip});
  await page.keyboard.press('m');
  await expect.poll(async()=>(await plan(page)).css).toBeGreaterThan(400);
  await expect.poll(async()=>Math.max(0,...(await plan(page)).guns.map(g=>g.w))).toBeGreaterThan(30);
  await frames(page,2);
  const large=await plan(page);expectPlan(large);
  // The same guns, at the same places, scaled with the plan, and drawn larger.
  for(const g of large.guns){
    const s=small.guns.find(o=>o.id===g.id),ratio=large.css/small.css;
    expect(Math.abs(g.x-s.x*ratio)).toBeLessThan(.05);expect(Math.abs(g.z-s.z*ratio)).toBeLessThan(.05);
    expect(g.w).toBeGreaterThan(s.w*1.8);
  }
  await page.screenshot({path:'artifacts/guns-map.png',style:'#msg,#interactionPrompt,#horrorCaption{visibility:hidden!important}'});
  await page.keyboard.press('m');
  await expect.poll(async()=>(await plan(page)).css).toBe(112);
});

test.describe('on a 2x screen',()=>{
  test.use({deviceScaleFactor:2});
  test('the plan and its gun icons are painted at device resolution',async({page})=>{
    await ready(page);await start(page);
    await expect.poll(async()=>(await snapshot(page)).mapGuns.length).toBe(2);
    const p=await plan(page);
    expect(p.dpr).toBe(2);expect(p.backing).toBe(224);
    expectPlan(p);
    await page.screenshot({path:'artifacts/guns-minimap-2x.png',clip:p.clip});
  });
});
