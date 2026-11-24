const {test,expect}=require('@playwright/test');
const fs=require('node:fs');
const path=require('node:path');
const {CELL}=require('../public/systems');

test.setTimeout(600000);
test.use({screenshot:'off',trace:'off'});

const SHOTS=path.join(__dirname,'..','artifacts');
const KINDS=[[0,'warden'],[1,'stalker'],[2,'crawler'],[3,'shrieker']];
const ZONE={head:'head',neck:'neck',chest:'torso',gut:'torso',armL:'arm',armR:'arm',legL:'leg',legR:'leg'};
let errors=[];
test.beforeEach(({page})=>{
  errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
});
test.afterEach(()=>expect(errors,'No page errors').toEqual([]));

async function ready(page,settings){
  await page.addInitScript(settings=>{
    localStorage.setItem('hollow.playerName','Hits QA');
    localStorage.setItem('hollow.settings',JSON.stringify(settings));
  },{quality:'low',motion:true,sensitivity:1,volume:0,effects:true,...settings});
  await page.goto('/?qa=1');
  await page.waitForFunction(()=>!!window.HollowTest&&!!window.HollowGame);
  await page.locator('#startDarkBtn').click();
  await expect.poll(()=>page.evaluate(()=>HollowGame.snapshot().state)).toBe('play');
  // The biggest ordinary room: creatures stand 1.3 m off its far wall, the survivor 3.2 m from them.
  return page.evaluate(cell=>{
    const T=HollowTest,G=HollowGame;
    T.silence();T.freezeAI(true);T.torch(true);T.arm(HollowSystems.WEAPONS.map(w=>w.id),'rifle');
    const room=G.snapshot().rooms.filter(r=>!r.shelter).sort((a,b)=>b.w*b.d-a.w*a.d)[0];
    const x=(room.x+room.w/2)*cell,ez=room.z*cell+1.3;
    T.pose({x,z:ez+3.2,yaw:0});T.advance(.2);
    return {x,z:ez+3.2,ex:x,ez,room};
  },CELL);
}
// One shot from the survivor's spot at creature `index`'s `part`. reset: a fresh creature first; hp: its health
// before the shot; after: seconds simulated after it.
async function shoot(page,spot,o){
  return page.evaluate(({spot,o})=>{
    const T=HollowTest,G=HollowGame;
    if(o.reset){T.silence();T.enemy(o.index,{x:spot.ex+(o.dx||0),z:spot.ez+(o.dz||0),state:'wander',yaw:o.yaw||0});}
    if(o.hp!==undefined){const e=G.snapshot().enemies[o.index];if(e.hp>o.hp)T.hit(o.index,e.hp-o.hp);}
    T.arm(HollowSystems.WEAPONS.map(w=>w.id),o.weapon);T.action('aim',o.aim!==false);
    T.pose({x:spot.x+(o.px||0),z:spot.z+(o.pz||0),yaw:0});T.advance(.35);
    const before=G.snapshot(),aim=T.aim(o.index,o.part);
    T.action('fire',true);T.advance(.05);T.action('fire',false);
    const now=G.snapshot();
    if(o.after)T.advance(o.after);
    const s=G.snapshot(),e=s.enemies[o.index];
    return {aim,shot:now.shot,fresh:now.shot&&now.shot!==before.shot&&JSON.stringify(now.shot)!==JSON.stringify(before.shot),enemy:e,hits:e.hits,
      gore:s.gore,hitMarker:s.audioLog.filter(l=>l.cue==='hitMarker').length,hitstop:now.hitstop,mag:now.mag};
  },{spot,o});
}
// Frames creature `index` for a screenshot from (dx, dz) metres beside the survivor's spot, hip-fire view.
async function frame(page,spot,index,{dx=0,dz=0,y=1}={}){
  await page.evaluate(({spot,index,dx,dz,y})=>{
    const T=HollowTest,e=HollowGame.snapshot().enemies[index];T.action('aim',false);
    const x=spot.x+dx,z=spot.z+dz,eye=HollowGame.snapshot().position.y+1.6,h=Math.hypot(e.x-x,e.z-z);
    T.pose({x,z,yaw:Math.atan2(-(e.x-x),-(e.z-z)),pitch:Math.atan2(y-eye,h)});
  },{spot,index,dx,dz,y});
  await settle(page);
}
// Lets a few real frames render (software rendering runs at a few frames a second) so motion blur and the turn settle.
async function settle(page,frames=6){
  await page.evaluate(n=>new Promise(done=>{let k=0;const tick=()=>{if(++k>=n)done();else requestAnimationFrame(tick);};requestAnimationFrame(tick);}),frames);
}
async function snap(page,name){
  fs.mkdirSync(SHOTS,{recursive:true});
  await page.addStyleTag({content:'#msg,.field-guidance,#keys{visibility:hidden!important}'});
  await page.screenshot({path:path.join(SHOTS,`hits-${name}.png`)});
}

test('every creature and every gun: head, torso and leg hits land in their region, react there and leave wounds',async({page})=>{
  const spot=await ready(page);
  const weapons=await page.evaluate(()=>HollowSystems.WEAPONS.map(w=>({id:w.id,pellets:w.pellets||1})));
  const knock={},misses=[];
  for(const [index,kind] of KINDS){
    const dealt={};
    for(const w of weapons)for(const part of ['head','torso','leg']){
      const r=await shoot(page,spot,{index,weapon:w.id,part,reset:true,after:.1});
      const tag=`${kind} ${w.id} ${part}`,t=r.shot&&r.shot.targets[0];
      expect(r.aim,`${tag}: a visible point of the part to aim at`).not.toBeNull();
      expect(ZONE[r.aim.region],tag).toBe(part);
      expect(r.fresh,`${tag}: the shot struck`).toBe(true);
      expect(r.shot.weapon).toBe(w.id);expect(r.shot.pellets).toBe(w.pellets);
      expect(r.shot.hits.length).toBeGreaterThan(0);expect(r.shot.hits.length).toBeLessThanOrEqual(w.pellets);
      // A round can slip between a Warden's legs inside its hit cylinder: it still lands (on the region the classifier
      // gives), only without a wound decal.
      expect(r.shot.hits.every(h=>h.index===index)).toBe(true);
      const meshes=r.shot.hits.filter(h=>h.mesh).length;
      if(w.pellets>1)expect(meshes,`${tag}: pellets found the creature's mesh`).toBeGreaterThan(0);
      if(w.pellets===1)expect(ZONE[r.shot.hits[0].region],`${tag}: the round's region`).toBe(part);
      else expect(r.shot.hits.some(h=>ZONE[h.region]===part),`${tag}: some pellets in the part`).toBe(true);
      expect(t.index).toBe(index);expect(t.kind).toBe(kind);expect(t.damage).toBeGreaterThan(0);
      expect(r.hits.last.region,`${tag}: snapshot region`).toBe(r.hits.region);
      if(w.pellets===1)expect(r.hits.region).toBe(r.shot.hits[0].region);
      if(meshes){expect(r.hits.wounds>0||r.hits.gibbed,`${tag}: wounds on the body`).toBe(true);expect(r.gore.wounds).toBeGreaterThan(0);}
      else misses.push(tag);
      if(r.enemy.dead){
        expect(t.killed).toBe(true);expect(r.hits.anim.deathForce,`${tag}: the killing blow's momentum`).toBeGreaterThan(0);
        if(ZONE[t.region]==='head'&&t.gib)expect(r.hits.gibbed).toBe(true);
      }else{
        expect(t.killed).toBe(false);expect(r.hits.anim.heat,`${tag}: a flinch`).toBeGreaterThan(0);
        if(ZONE[r.hits.region]==='leg')expect(r.hits.anim.limpL+r.hits.anim.limpR,`${tag}: a limp`).toBeGreaterThan(0);
        if(r.hits.region==='gut')expect(r.hits.anim.fold,`${tag}: doubled over`).toBeGreaterThan(0);
      }
      if(w.pellets===1){
        dealt[`${w.id} ${part}`]=t.damage;
        // Rounds of .9 damage or more go through the torso and out of the back; a light one (an SMG round) stays in.
        if(part==='torso')expect(r.shot.hits[0].exit,`${tag}: an exit wound for a ${t.damage.toFixed(2)} round`).toBe(t.damage>=.9);
        if(part==='torso'&&w.id==='rifle')knock[kind]=t.knock;
      }
    }
    for(const w of weapons.filter(w=>w.pellets===1)){
      expect(dealt[`${w.id} head`],`${kind} ${w.id}: head beats torso`).toBeGreaterThan(dealt[`${w.id} torso`]);
      expect(dealt[`${w.id} torso`],`${kind} ${w.id}: torso beats leg`).toBeGreaterThan(dealt[`${w.id} leg`]);
    }
  }
  expect(knock.warden,'the Warden shrugs off the shove that moves a stalker').toBeLessThan(knock.stalker*.5);
  console.log('knock',JSON.stringify(knock),'cylinder-only',JSON.stringify(misses));
  expect(misses.length,'nearly every round finds the body itself').toBeLessThanOrEqual(3);
});

test('kills: headshots take the head off, close blasts tear an arm away, corpses keep their wounds and bleed out',async({page})=>{
  const spot=await ready(page);
  // A rifle round to a wounded stalker's head: the head comes apart, the neck pumps, chunks fly, the moment freezes.
  let r=await shoot(page,spot,{index:1,weapon:'rifle',part:'head',reset:true,hp:1,after:.1});
  let t=r.shot.targets[0];
  expect(t).toMatchObject({kind:'stalker',killed:true,gib:true,head:true});
  expect(r.hits.gibbed).toBe(true);expect(r.hits.anim.gib).toBe(1);
  expect(r.gore.fountains).toBeGreaterThan(0);expect(r.gore.chunks).toBeGreaterThan(0);expect(r.gore.stumps).toBeGreaterThan(0);
  const stop=await page.evaluate(()=>HollowGame.snapshot().dopamine.lastHitstop);
  expect(stop).toBeGreaterThanOrEqual(.045);
  const wounds=r.hits.wounds;
  r=await page.evaluate(()=>{HollowTest.advance(3);const s=HollowGame.snapshot();return {e:s.enemies[1],gore:s.gore};});
  expect(r.e.dead).toBe(true);expect(r.e.hits.wounds,'the corpse keeps its wounds').toBe(wounds);
  expect(r.gore.pools,'blood pools under the body').toBeGreaterThan(0);expect(r.gore.splats).toBeGreaterThan(0);
  // A point-blank blast into a wounded stalker's body: an arm comes off and lies on the floor.
  r=await shoot(page,spot,{index:1,weapon:'shotgun',part:'torso',reset:true,hp:5,pz:-1.7,after:2.5});
  t=r.shot.targets[0];
  console.log('blast',JSON.stringify(t),JSON.stringify(r.hits));
  expect(t.killed).toBe(true);
  expect(t.sever||t.gib?'torn':'whole').toBe('torn');
  if(t.sever){expect(r.hits.severed).toContain(t.sever);expect(r.gore.limbs).toBeGreaterThan(0);}
  expect(r.hits.anim.deathForce).toBeGreaterThan(1);
  // A Warden dropped by a head shot still falls with the round's momentum.
  r=await shoot(page,spot,{index:0,weapon:'rifle',part:'head',reset:true,hp:1,after:.1});
  expect(r.enemy.dead).toBe(true);expect(r.shot.targets[0].head).toBe(true);expect(r.hits.anim.deathForce).toBeGreaterThan(0);
  // A fresh creature in the same slot has none of it.
  r=await page.evaluate(()=>{HollowTest.enemy(1,{x:0,z:0,state:'wander'});return HollowGame.snapshot().enemies[1].hits;});
  expect(r).toMatchObject({wounds:0,gibbed:false,severed:[],kneeling:false});
});

test('a shotgun blast to the legs drops a stalker to one knee where it stands; a Warden only limps',async({page})=>{
  const spot=await ready(page);
  const r=await shoot(page,spot,{index:1,weapon:'shotgun',part:'leg',reset:true,pz:-1.2});
  console.log('kneel',JSON.stringify(r.shot.targets[0]),JSON.stringify(r.hits));
  expect(r.enemy.dead).toBe(false);expect(r.shot.targets[0].kneel).toBe(true);
  expect(r.hits.kneeling).toBe(true);
  // The blast shoves it back along the shot as it drops; then it stays down where it landed, though it is hunting.
  const held=await page.evaluate(()=>{
    const T=HollowTest,G=HollowGame,o=G.snapshot().enemies[1];T.freezeAI(false);T.advance(.3);
    const a=G.snapshot().enemies[1];T.advance(.6);const b=G.snapshot().enemies[1];T.freezeAI(true);
    return {o:{x:o.x,z:o.z},a:{x:a.x,z:a.z},b:{x:b.x,z:b.z,kneeling:b.hits.kneeling,kneel:b.hits.anim.kneel}};
  });
  expect(held.a.z,'shoved away from the gun').toBeLessThan(held.o.z-.05);
  expect(Math.hypot(held.b.x-held.a.x,held.b.z-held.a.z),'pinned while down').toBeLessThan(.06);
  expect(held.b.kneeling).toBe(true);expect(held.b.kneel).toBeGreaterThan(0);
  const w=await shoot(page,spot,{index:0,weapon:'shotgun',part:'leg',reset:true,pz:-1.2,after:.2});
  expect(w.shot.targets[0].kneel).toBe(false);expect(w.hits.kneeling).toBe(false);
  if(ZONE[w.hits.region]==='leg')expect(w.hits.anim.limpL+w.hits.anim.limpR).toBeGreaterThan(0);
});

test('a blow that leaves the survivor standing jolts the view, drags the legs, bloodies the screen and dulls the ears',async({page})=>{
  await ready(page,{volume:.6});
  for(const [index,kind] of KINDS){
    const r=await page.evaluate(({index})=>{
      const T=HollowTest,G=HollowGame,p=G.snapshot().position;
      T.silence();T.health(100);T.pose({x:p.x,z:p.z,yaw:0});
      const before=G.snapshot(),seen=before.audioLog.at(-1)?.n||0;T.enemy(index,{x:p.x,z:p.z-1,state:'chase',yaw:0});T.freezeAI(false);
      let after=null;
      for(let i=0;i<60;i++){T.advance(.05);after=G.snapshot();if(after.health<100)break;}
      T.freezeAI(true);T.silence();
      return {before:before.position,after:after.position,health:after.health,state:after.state,hurt:after.hurt,dopamine:after.dopamine.damage,
        cues:after.audioLog.filter(l=>l.n>seen&&l.src==='player').map(l=>l.cue)};
    },{index});
    console.log(kind,JSON.stringify({health:r.health,hurt:r.hurt.last,slow:r.hurt.slow,fx:r.hurt.fx.active,cues:r.cues}));
    expect(r.state,kind).toBe('play');expect(r.health,kind).toBeLessThan(100);expect(r.health,kind).toBeGreaterThan(0);
    expect(r.hurt.last.kind).toBe(kind);
    expect(r.hurt.last.style).toBe(kind==='warden'?'blunt':kind==='crawler'?'bite':'claw');
    expect(r.hurt.slow,`${kind}: the legs drag`).toBeLessThan(1);
    expect(r.hurt.fx.active.splats,`${kind}: blood on the screen`).toBeGreaterThan(0);
    if(kind==='crawler')expect(r.hurt.fx.active.bites).toBeGreaterThan(0);
    if(kind==='stalker'||kind==='shrieker')expect(r.hurt.fx.active.claws).toBeGreaterThan(0);
    expect(r.hurt.pulse).toBeGreaterThan(.7);
    expect(r.cues,`${kind}: the world goes dull`).toContain('muffle');
    if(kind==='warden'){expect(r.cues,'a heavy blow rings').toContain('ring');expect(r.hurt.last.heavy).toBe(true);}
    expect(r.after,`${kind}: a blow is not a displacement`).toEqual(r.before);
  }
  // The slowdown wears off.
  const slow=await page.evaluate(()=>{HollowTest.advance(2.5);return HollowGame.snapshot().hurt.slow;});
  expect(slow).toBe(1);
});

test('the Gravekeeper flinches heavily but is never shoved or dropped to a knee, its spade hits hardest, and a killing head shot takes the head before its grave takes the body',async({page})=>{
  await ready(page,{quality:'high',volume:.6});
  // S2, its boss awake before the gate, the survivor 5.5 m from it with a clear line.
  const at=await page.evaluate(()=>{
    const T=HollowTest,G=HollowGame;T.floor(4,4242);T.silence();T.advance(.6);T.boss('wake',true);T.freezeAI(true);T.advance(.1);
    const b=G.snapshot().boss;
    for(const r of [5.5,4.5])for(let k=0;k<8;k++){const dx=Math.sin(k*Math.PI/4),dz=Math.cos(k*Math.PI/4),x=b.x+dx*r,z=b.z+dz*r,yaw=Math.atan2(dx,dz);
      if(!T.navClear(x,z,b.x,b.z,.32)||!T.navClear(x-dx*3,z-dz*3,b.x,b.z,.32))continue;
      T.pose({x,z,yaw});if(['head','torso','leg','arm'].every(part=>T.aim(20,part)))return {x,z,yaw,boss:b};}
    return {boss:b};
  });
  expect(at.boss).toMatchObject({kind:'gravekeeper',act:'hunt',dead:false,sink:0});
  expect(at.x,'a clear spot facing the Gravekeeper').toBeDefined();
  const fire=(weapon,part,o={})=>page.evaluate(({at,weapon,part,o})=>{
    const T=HollowTest,G=HollowGame,B=20;
    T.arm(HollowSystems.WEAPONS.map(w=>w.id),weapon);T.action('aim',true);T.health(100);
    const d=o.close||0;T.pose({x:at.x-Math.sin(at.yaw)*d,z:at.z-Math.cos(at.yaw)*d,yaw:at.yaw});T.advance(.35);
    const aim=T.aim(B,part);T.action('fire',true);T.advance(.05);T.action('fire',false);
    const now=G.snapshot();if(o.after)T.advance(o.after);
    const s=G.snapshot();return {aim,shot:now.shot,boss:s.boss,gore:s.gore};
  },{at,weapon,part,o});
  let r;
  for(const [weapon,part] of [['rifle','torso'],['rifle','torso'],['pistol','leg'],['rifle','arm']]){
    r=await fire(weapon,part);
    const t=r.shot.targets[0];
    expect(r.aim,`${weapon} ${part}: a visible point to aim at`).not.toBeNull();
    expect(t).toMatchObject({index:20,kind:'gravekeeper',killed:false,kneel:false,knock:0});
    expect(r.boss.hits.anim.heat,'it flinches').toBeGreaterThan(0);
  }
  expect(r.boss.hits.wounds,'its wounds stay on it').toBeGreaterThanOrEqual(4);
  expect(Math.hypot(r.boss.x-at.boss.x,r.boss.z-at.boss.z),'and it stands where it stood').toBeLessThan(1e-6);
  // A point-blank blast into its legs: a stalker would go down on one knee; the Gravekeeper only flinches.
  r=await fire('shotgun','leg',{close:3,after:.3});
  expect(r.shot.targets[0]).toMatchObject({kind:'gravekeeper',kneel:false,knock:0});
  expect(r.boss.hits.kneeling).toBe(false);expect(r.boss.hits.anim.kneeling).toBe(0);
  expect(Math.hypot(r.boss.x-at.boss.x,r.boss.z-at.boss.z)).toBeLessThan(1e-6);
  const wounded=r.boss.hits.wounds;
  await page.evaluate(({at})=>{const T=HollowTest,b=HollowGame.snapshot().boss,eye=HollowGame.snapshot().position.y+1.6;
    T.action('aim',false);T.pose({x:at.x,z:at.z,yaw:at.yaw,pitch:Math.atan2(1.6-eye,Math.hypot(b.x-at.x,b.z-at.z))});},{at});
  await settle(page,10);await snap(page,'gravekeeper-wounds');
  // Its blow: the heaviest there is, rung ears and dragging legs, but no displacement.
  const blow=await page.evaluate(({at})=>{
    const T=HollowTest,G=HollowGame;T.health(100);T.pose({x:at.x,z:at.z,yaw:at.yaw});
    const seen=G.snapshot().audioLog.at(-1)?.n||0,before=G.snapshot().position;T.freezeAI(false);
    let s=G.snapshot();for(let i=0;i<200&&s.health>=100;i++){T.advance(.05);s=G.snapshot();}
    T.freezeAI(true);
    return {health:s.health,hurt:s.hurt,state:s.state,cues:s.audioLog.filter(l=>l.n>seen&&l.src==='player').map(l=>l.cue)};
  },{at});
  console.log('gravekeeper blow',JSON.stringify({health:blow.health,last:blow.hurt.last,slow:blow.hurt.slow,cues:blow.cues}));
  expect(blow.state).toBe('play');expect(blow.health).toBeLessThan(100);
  expect(blow.hurt.last).toMatchObject({kind:'gravekeeper',style:'blunt'});
  expect(blow.hurt.slow,'the legs drag').toBeLessThan(.7);
  expect(blow.cues).toContain('muffle');expect(blow.cues).toContain('ring');
  // Down to its last hit point, a magnum round through the head: the head comes apart and the neck pumps.
  r=await page.evaluate(({at})=>{
    const T=HollowTest,G=HollowGame,B=20;T.health(100);T.boss('pose',{x:at.boss.x,z:at.boss.z});T.boss('hit',G.snapshot().boss.hp-1);
    T.arm(HollowSystems.WEAPONS.map(w=>w.id),'magnum');T.action('aim',true);T.pose({x:at.x,z:at.z,yaw:at.yaw});T.advance(.35);
    const aim=T.aim(B,'head');T.action('fire',true);T.advance(.05);T.action('fire',false);
    const now=G.snapshot();T.freezeAI(false);T.health(100);T.advance(.1);T.freezeAI(true);
    const s=G.snapshot();return {aim,shot:now.shot,boss:s.boss,gore:s.gore,banner:s.hud.banner};
  },{at});
  expect(r.aim).not.toBeNull();
  expect(r.shot.targets[0]).toMatchObject({kind:'gravekeeper',killed:true,gib:true,head:true});
  expect(r.boss).toMatchObject({act:'dead',dead:true});expect(r.banner).toBe('THE GRAVEKEEPER FALLS');
  expect(r.boss.hits.gibbed).toBe(true);expect(r.boss.hits.anim.gib).toBe(1);expect(r.boss.hits.wounds).toBeGreaterThanOrEqual(wounded);
  expect(r.gore.fountains).toBeGreaterThan(0);expect(r.gore.stumps).toBeGreaterThan(0);expect(r.gore.chunks,'skull and flesh fly').toBeGreaterThan(0);
  const down=await page.evaluate(()=>{const T=HollowTest;T.freezeAI(false);T.health(100);T.advance(2.4);T.freezeAI(true);T.action('aim',false);return HollowGame.snapshot();});
  expect(down.boss.sink).toBe(0);expect(down.gore.pools,'it bleeds out where it fell').toBeGreaterThan(0);
  await page.evaluate(({at,b})=>{const T=HollowTest,eye=HollowGame.snapshot().position.y+1.6,x=at.x-Math.sin(at.yaw)*2.5+Math.cos(at.yaw)*1.2,z=at.z-Math.cos(at.yaw)*2.5-Math.sin(at.yaw)*1.2;
    T.pose({x,z,yaw:Math.atan2(-(b.x-x),-(b.z-z)),pitch:Math.atan2(.4-eye,Math.hypot(b.x-x,b.z-z))});},{at,b:down.boss});
  await settle(page,10);await snap(page,'gravekeeper-down');
  // Then the earth takes the body: it sinks out of sight, and nothing bleeds up through the ground.
  const gone=await page.evaluate(()=>{const T=HollowTest,G=HollowGame;T.freezeAI(false);let low=0;
    for(let i=0;i<24;i++){T.health(100);T.advance(.5);low=Math.min(low,G.snapshot().boss.sink);}
    T.freezeAI(true);return {s:G.snapshot(),low};});
  expect(gone.low).toBeLessThan(-3.5);expect(gone.s.boss).toMatchObject({act:'dead',visible:false});
  expect(gone.s.gore.drops).toBe(0);expect(gone.s.gore.fountains).toBe(0);
});

test('low quality and effects off keep less gore; a full rifle magazine into a group stays within budget',async({page})=>{
  const spot=await ready(page,{quality:'high'});
  const measure=()=>page.evaluate(()=>new Promise(done=>{
    // Real frames: the renderer's counts and the frame time of what is on screen.
    const start=performance.now(),n0=HollowGame.snapshot().performance.frames;let k=0;
    const tick=()=>{if(++k<8){requestAnimationFrame(tick);return;}const s=HollowGame.snapshot();
      done({atm:s.atmosphere?s.atmosphere.drawCalls:0,drawCalls:s.performance.drawCalls,triangles:s.performance.triangles,frameMs:(performance.now()-start)/Math.max(1,s.performance.frames-n0),gore:s.gore});};
    requestAnimationFrame(tick);
  }));
  await page.evaluate(({spot})=>{
    const T=HollowTest;T.silence();
    [[0,0],[1,-.9],[3,.9]].forEach(([i,dx])=>T.enemy(i,{x:spot.ex+dx,z:spot.ez,state:'wander',yaw:0}));
    T.arm(HollowSystems.WEAPONS.map(w=>w.id),'rifle');T.action('aim',true);
    T.pose({x:spot.x,z:spot.z,yaw:0,pitch:-.12});T.advance(.35);
  },{spot});
  const before=await measure();
  const fired=await page.evaluate(()=>{
    const T=HollowTest,G=HollowGame,mag=G.snapshot().mag;
    T.action('fire',true);
    for(let i=0;i<120&&G.snapshot().mag>0;i++){T.pose({...G.snapshot().position,yaw:Math.sin(i*.45)*.3,pitch:-.12+.05*Math.cos(i*.7)});T.advance(.05);}
    T.action('fire',false);T.advance(.5);
    return {mag,left:G.snapshot().mag,dead:G.snapshot().enemies.filter((e,i)=>[0,1,3].includes(i)&&e.dead).length};
  });
  const after=await measure();
  console.log('perf',JSON.stringify({fired,atmosphere:[before.atm,after.atm],before:{drawCalls:before.drawCalls,triangles:before.triangles,frameMs:+before.frameMs.toFixed(1)},
    after:{drawCalls:after.drawCalls,triangles:after.triangles,frameMs:+after.frameMs.toFixed(1)},gore:after.gore}));
  expect(fired.left).toBe(0);
  expect(after.gore.drawCalls).toBeLessThanOrEqual(10);
  // The atmosphere's own layers (the guns' tracers and bullet holes, and the blood mist) keep their own budget.
  expect(after.drawCalls-before.drawCalls-(after.atm-before.atm)).toBeLessThanOrEqual(12);
  expect(after.gore.wounds).toBeLessThanOrEqual(after.gore.caps.wounds);
  expect(after.gore.splats).toBeLessThanOrEqual(after.gore.caps.splats);
  // Low quality with effects off keeps a smaller pool of everything.
  const high=after.gore.caps,other=await page.context().newPage();
  other.on('pageerror',error=>errors.push(error.message));
  await ready(other,{quality:'low',effects:false});
  const low=await other.evaluate(()=>HollowGame.snapshot().gore);
  await other.close();
  expect(low.quality).toBe('low');expect(low.effects).toBe(false);
  for(const k of ['wounds','splats','walls','chunks','drops','pools'])expect(low.caps[k],k).toBeLessThan(high[k]);
});

test('screenshots: a head coming apart, a blowout on the wall, a wounded Warden, an arm torn off, the hurt survivor',async({page})=>{
  const spot=await ready(page,{quality:'high'});
  let r=await shoot(page,spot,{index:1,weapon:'shotgun',part:'head',reset:true,after:.12});
  expect(r.hits.gibbed).toBe(true);
  await frame(page,spot,1,{dx:-.8,dz:-1.2,y:1.2});await snap(page,'gib');
  for(let i=0;i<4;i++)r=await shoot(page,spot,{index:3,weapon:'rifle',part:i%2?'torso':'leg',reset:i===0,after:.25});
  expect(r.gore.walls).toBeGreaterThan(0);
  await page.evaluate(({spot})=>{HollowTest.silence();HollowTest.action('aim',false);HollowTest.pose({x:spot.ex+.6,z:spot.ez+.2,yaw:Math.atan2(.7,1.5),pitch:-.4});},{spot});
  await settle(page,10);await snap(page,'wall');
  for(const [i,part] of ['torso','torso','leg','torso','leg','torso'].entries())r=await shoot(page,spot,{index:0,weapon:i%2?'pistol':'rifle',part,reset:i===0,after:.1});
  expect(r.hits.wounds).toBeGreaterThan(4);
  await page.evaluate(()=>HollowTest.advance(1.5));
  await frame(page,spot,0,{dx:-.3,dz:-1.7,y:1.4});await settle(page,12);await snap(page,'warden');
  r=await shoot(page,spot,{index:1,weapon:'shotgun',part:'torso',reset:true,hp:5,pz:-1.7,after:2.5});
  await frame(page,spot,1,{dx:-1.4,dz:-1.5,y:.3});await snap(page,'aftermath');
  // A blow from each style of creature. Headless software rendering never lets the compositor start the overlay's
  // Web Animations, so the capture holds the running ones at a moment early in their life.
  for(const [index,name] of [[0,'warden'],[1,'stalker'],[2,'crawler']]){
    const hurt=await page.evaluate(({index})=>{
      const T=HollowTest,G=HollowGame,p=G.snapshot().position;T.silence();T.health(100);T.pose({x:p.x,z:p.z,yaw:0,pitch:0});
      T.enemy(index,{x:p.x+.5,z:p.z-1,state:'chase',yaw:0});T.freezeAI(false);
      for(let i=0;i<60&&G.snapshot().health>=100;i++)T.advance(.05);
      T.freezeAI(true);return G.snapshot().hurt;
    },{index});
    expect(hurt.last.kind).toBe(name);
    await page.evaluate(()=>{for(const n of document.getElementById('hud').children[0].children)for(const a of n.getAnimations())if(a.playState==='running'){a.pause();a.currentTime=700;}});
    await settle(page,1);await snap(page,'hurt-'+name);
  }

});
