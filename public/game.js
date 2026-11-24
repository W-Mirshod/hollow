(function(){
'use strict';
try {
if(!window.THREE||!window.TSL||!window.HollowRenderer||!window.HollowSystems||!window.HollowLocomotion||!window.HollowCameraFX||!window.HollowMonsterAnim||!window.HollowVisuals||!window.HollowNavigation||!window.HollowHorror||!window.HollowAudio||!window.HollowChaos||!window.HollowHUDFX)throw new Error('A local game asset could not be loaded.');
const $=id=>document.getElementById(id);
const clamp01=v=>v<0?0:v>1?1:v;
const lerp=(a,b,k)=>a+(b-a)*k;
const ease=(a,b,t)=>{const k=clamp01((t-a)/(b-a));return k*k*(3-2*k);};
const rnd=(a,b)=>a+Math.random()*(b-a);

/* ---------- constants ---------- */
const RULES=window.HollowSystems;
const S=RULES.CELL, H=3.2, W=RULES.SIZE, N=(W-1)/2, HF=H+2.4;
const ENT_Z=2, DZ0=ENT_Z*S, DZ1=DZ0+S, DZC=DZ0+S/2;      // door spans z 6..9
const PED={x:16.5,z:DZC}, CHAN={x:10.5,z:DZC};
const LOCO=window.HollowLocomotion.create(RULES.PLAYER),PL=LOCO.constants;
const EYE=1.6, PR=0.32, MR=0.38;
const IS_TOUCH=matchMedia('(pointer:coarse)').matches||navigator.maxTouchPoints>1;
let preferences={quality:'auto',sensitivity:1,volume:.7,motion:!matchMedia('(prefers-reduced-motion: reduce)').matches,effects:!matchMedia('(prefers-reduced-motion: reduce)').matches};
try{preferences=Object.assign(preferences,JSON.parse(localStorage.getItem('hollow.settings')||'{}'));}catch(e){}
const finiteNumber=(value,fallback,min=-1e6,max=1e6)=>{const n=Number(value);return Number.isFinite(n)?Math.max(min,Math.min(max,n)):fallback;};
preferences.quality=['auto','low','medium','high'].includes(preferences.quality)?preferences.quality:'auto';
preferences.sensitivity=finiteNumber(preferences.sensitivity,1,.4,2.5);preferences.volume=finiteNumber(preferences.volume,.7,0,1);preferences.motion=preferences.motion!==false;preferences.effects=preferences.effects!==false;
const qualityProfiles={low:{ratio:.8,shadows:false,shadowSize:512},medium:{ratio:1,shadows:true,shadowSize:512},high:{ratio:1.25,shadows:true,shadowSize:1024}};
let qualityLevel=preferences.quality==='auto'?(IS_TOUCH?'low':'high'):preferences.quality;
if(!qualityProfiles[qualityLevel])qualityLevel='medium';
let renderScale=qualityProfiles[qualityLevel].ratio,frameAverage=16.7,renderCalls=0,renderedFrames=0,renderRequested=true,lastRenderedState='';
// Auto quality walks these rungs (tier, render scale), best first. Each tier's default ratio is one of them.
const AUTO_RUNGS=[['high',1.25],['high',1],['medium',1],['medium',.85],['medium',.75],['low',.8],['low',.7],['low',.6],['low',.55]];
let autoBest=0,autoMs=0,autoFrames=0,autoSettle=3;
// Auto starts one rung better than where it last settled on this device, so a slow machine skips most of the climb down.
const autoStart=(()=>{if(preferences.quality!=='auto')return null;const top=AUTO_RUNGS.findIndex(r=>r[0]===qualityLevel);
  let saved=NaN;try{saved=parseInt(localStorage.getItem('hollow.autoRung'),10);}catch(e){}
  return Number.isFinite(saved)&&saved>top+1?AUTO_RUNGS[Math.min(AUTO_RUNGS.length,saved)-1]:null;})();
if(autoStart){qualityLevel=autoStart[0];renderScale=autoStart[1];}

/* ---------- renderer ---------- */
const canvas=$('game');
// boot.mjs creates and initialises the WebGPURenderer (WebGPU, or its WebGL2 backend) before this script runs.
let renderer=window.HollowRenderer;
function configureRenderer(){
  renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,renderScale));
  renderer.setSize(innerWidth,innerHeight);
  renderer.toneMapping=THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure=1.12;
  renderer.shadowMap.enabled=qualityProfiles[qualityLevel].shadows;
  renderer.shadowMap.type=THREE.PCFShadowMap;
  renderer.info.autoReset=false;
}
configureRenderer();
const {uniform,texture,property,positionWorld,positionLocal,vec2,vec3,vec4,float,mix,step,smoothstep,select,If,Fn}=TSL;
// r187 lighting is physical. Game code keeps the r128 light levels: physical() reads authored colours as linear
// (as r128 did) and converts levels with a per-light factor (hemisphere/directional x pi, point/spot candela).
const lin=hex=>new THREE.Color().setHex(hex,THREE.LinearSRGBColorSpace);
// r128 drew the sky and mixed fog after tone mapping: untone() is the linear colour that ACES + sRGB output shows as hex
const ACES_IN=new THREE.Matrix3().set(0.59719,0.35458,0.04823,0.076,0.90834,0.01566,0.0284,0.13383,0.83777).invert();
const ACES_OUT=new THREE.Matrix3().set(1.60475,-0.53108,-0.07367,-0.10208,1.10813,-0.00605,-0.00327,-0.07276,1.07602).invert();
function untone(hex){
  const c=new THREE.Color(hex),v=new THREE.Vector3(c.r,c.g,c.b).applyMatrix3(ACES_OUT);
  const fit=y=>{y=Math.min(y,1);const a=0.983729*y-1,b=0.432951*y-0.0245786,k=0.238081*y+0.000090537;return(-b-Math.sqrt(b*b-4*a*k))/(2*a);};
  v.set(fit(v.x),fit(v.y),fit(v.z)).applyMatrix3(ACES_IN).multiplyScalar(0.6/renderer.toneMappingExposure);
  return hex?c.setRGB(Math.max(v.x,0),Math.max(v.y,0),Math.max(v.z,0),THREE.LinearSRGBColorSpace):c;
}
function setLight(light,level){light.userData.level=level;light.intensity=level*light.userData.scale;}
function physical(light,scale,decay){
  light.color.setHex(light.color.getHex(),THREE.LinearSRGBColorSpace);
  if(light.groundColor)light.groundColor.setHex(light.groundColor.getHex(),THREE.LinearSRGBColorSpace);
  if(decay!==undefined)light.decay=decay;
  light.userData.scale=scale;setLight(light,light.intensity);return light;
}

const scene=new THREE.Scene();
scene.matrixAutoUpdate=false;
scene.fog=new THREE.FogExp2(untone(0xcfe2ee),0.0045);
const camera=new THREE.PerspectiveCamera(70,innerWidth/innerHeight,0.04,700);
camera.rotation.order='YXZ';
scene.add(camera);

const hemi=physical(new THREE.HemisphereLight(0xbfe3ff,0x5a7a3a,0.75),Math.PI);scene.add(hemi);

// torch: a gentle decay keeps the old long, even beam (lit corridor ~10-20 m) instead of a blown-out hotspot
const spot=physical(new THREE.SpotLight(0xfff1d6,0,24,0.42,0.55),5,0.5);
spot.position.set(-0.22,-0.18,0.05);
spot.castShadow=true;spot.shadow.mapSize.set(qualityProfiles[qualityLevel].shadowSize,qualityProfiles[qualityLevel].shadowSize);
spot.shadow.camera.near=0.2;spot.shadow.camera.far=26;spot.shadow.bias=-0.0006;spot.shadow.radius=2;
camera.add(spot);
const spotTarget=new THREE.Object3D();spotTarget.position.set(0,-0.25,-6);camera.add(spotTarget);spot.target=spotTarget;
const bounce=physical(new THREE.PointLight(0xffe7c4,0,4.5),2,1);camera.add(bounce);
const muzzleLight=physical(new THREE.PointLight(0xffb060,0,12),5,1);muzzleLight.position.set(0.18,-0.1,-1.0);camera.add(muzzleLight);
// Atmosphere (light shafts, dust, torch beam, beacons, tracers, blood, sparks): optional, the game runs without it.
const _atmDir=new THREE.Vector3(),_atmMz=new THREE.Vector3(),_atmNd=new THREE.Vector3(),_atmIn={cameraPosition:camera.position,cameraDirection:_atmDir,torchOn:false,danger:0,flicker:1};
let atm=null,atmBeam=null,atmBeacons=[];
try{atm=window.HollowAtmosphere?.create({THREE,TSL:window.TSL,scene,camera,quality:qualityLevel,effects:preferences.effects})||null;if(atm)atmBeam=atm.torchBeam(camera);}
catch(e){console.warn('[The Hollow] atmosphere disabled:',e);atm=null;}

/* ---------- environments ---------- */
const ENV={
  hell:{sky:lin(0x889796),gnd:lin(0x24221f),hi:0.23,fog:untone(0x0b100f),fd:0.024},
  // B2 runs cold and blue, B3 bleeds red; both sit a little darker in thicker fog.
  morgue:{sky:lin(0x7c95ad),gnd:lin(0x1a2129),hi:0.2,fog:untone(0x081019),fd:0.028},
  hollow:{sky:lin(0xa07a70),gnd:lin(0x2b1915),hi:0.19,fog:untone(0x150706),fd:0.03},
  // Above ground: S1 under a low moon in a thin blue mist, S2 in a colder, heavier churchyard fog. moon: moonlight level.
  garden:{sky:lin(0x7f97c4),gnd:lin(0x1b2618),hi:0.38,fog:untone(0x0b1320),fd:0.021,moon:.5},
  graveyard:{sky:lin(0x86a0ae),gnd:lin(0x1a1d1b),hi:0.27,fog:untone(0x0c1314),fd:0.025,moon:.42}
};
function applyEnv(e){
  hemi.color.copy(e.sky);hemi.groundColor.copy(e.gnd);setLight(hemi,e.hi);
  scene.fog.color.copy(e.fog);scene.fog.density=e.fd;
}

/* ---------- textures ---------- */
function noiseFill(ctx,w,h,amt){
  const img=ctx.getImageData(0,0,w,h),d=img.data;
  for(let i=0;i<d.length;i+=4){const n=(Math.random()-.5)*amt;d[i]+=n;d[i+1]+=n;d[i+2]+=n;}
  ctx.putImageData(img,0,0);
}
// noiseFill and deriveMaps read these canvases back: keep them in CPU memory instead of stalling on GPU readbacks.
function cv(w,h){const c=document.createElement('canvas');c.width=w;c.height=h;return [c,c.getContext('2d',{willReadFrequently:true})];}
function blot(x,cx,cy,r,col){const g=x.createRadialGradient(cx,cy,0,cx,cy,r);g.addColorStop(0,col);g.addColorStop(1,'rgba(0,0,0,0)');x.fillStyle=g;x.fillRect(cx-r,cy-r,r*2,r*2);}
function tex(c,rep,srgb){
  const t=new THREE.CanvasTexture(c);t.wrapS=t.wrapT=THREE.RepeatWrapping;
  if(rep)t.repeat.set(rep[0],rep[1]);
  if(srgb!==false)t.colorSpace=THREE.SRGBColorSpace;
  t.anisotropy=qualityLevel==='low'?1:Math.min(4,renderer.getMaxAnisotropy());
  return t;
}
// The Blackwater ward is a set of coherent procedural PBR surfaces from visuals.js (albedo + height-derived normal +
// roughness: grout, cracks, peeling paint and puddles light correctly under the torch). Sizes follow the boot quality.
HollowVisuals.configure({quality:qualityLevel});
// The shell's maps are the largest: prepaint.js's workers may still be painting them, so these can be blank placeholders
// that fill in place (wardMat refreshes its textures then). Nothing draws them before settleSurfaces() (see loop).
const wardWallS=HollowVisuals.surface('ward-wall',{pending:true}),wardFloorS=HollowVisuals.surface('ward-floor',{pending:true}),wardCeilS=HollowVisuals.surface('ward-ceiling',{pending:true});
function hellPedC(){const [c,x]=cv(256,256);x.fillStyle='#22150f';x.fillRect(0,0,256,256);for(let i=0;i<24;i++)blot(x,rnd(0,256),rnd(0,256),rnd(10,70),'rgba(0,0,0,.55)');noiseFill(x,256,256,26);return c;}
function hellRunnerC(){const [c,x]=cv(256,128);x.fillStyle='#2a0a08';x.fillRect(0,0,256,128);for(let i=0;i<16;i++)blot(x,rnd(0,256),rnd(0,128),rnd(10,40),Math.random()<.5?'rgba(0,0,0,.7)':'rgba(90,10,6,.6)');noiseFill(x,256,128,30);return c;}
function hellDoorC(){
  const [c,x]=cv(256,512);x.fillStyle='#3a2a22';x.fillRect(0,0,256,512);
  for(let i=0;i<30;i++)blot(x,rnd(0,256),rnd(0,512),rnd(10,70),Math.random()<.5?'rgba(110,50,25,.45)':'rgba(10,6,4,.5)');
  x.strokeStyle='rgba(10,6,4,.8)';x.lineWidth=6;x.strokeRect(14,14,228,484);
  for(let y=80;y<512;y+=140){x.fillStyle='rgba(15,10,8,.7)';x.fillRect(14,y,228,8);}
  x.strokeStyle='rgba(200,180,160,.35)';x.lineWidth=1.5;
  for(let s=0;s<3;s++){const bx=rnd(60,150),by=rnd(180,300);for(let k=0;k<4;k++){x.beginPath();x.moveTo(bx+k*9,by);x.lineTo(bx+k*9+rnd(-12,12),by+rnd(70,130));x.stroke();}}
  noiseFill(x,256,512,30);return c;
}
function writingC(text){
  const [c,x]=cv(512,256);x.font='64px "Special Elite","Courier New",monospace';x.textAlign='center';x.textBaseline='middle';
  const words=text.split(' ');let lines=[],line='';
  for(const w of words){const t=line?line+' '+w:w;if(x.measureText(t).width>460&&line){lines.push(line);line=w;}else line=t;}lines.push(line);
  const lh=70,y0=128-(lines.length-1)*lh/2;
  lines.forEach((l,i)=>{x.save();x.translate(256,y0+i*lh);x.rotate(rnd(-.06,.06));x.fillStyle='rgba(110,8,8,.92)';x.fillText(l,0,0);
    const w=x.measureText(l).width;for(let k=0;k<6;k++){x.fillStyle='rgba(95,6,6,.7)';x.fillRect(rnd(-w/2,w/2),18,rnd(2,4),rnd(10,60));}x.restore();});
  return c;
}
function plaqueC(){
  const [c,x]=cv(256,112);
  x.fillStyle='#2a1810';x.fillRect(0,0,256,112);noiseFill(x,256,112,40);x.fillStyle='#8a0a0a';x.textAlign='center';x.font='32px "Special Elite",monospace';x.fillText('YOU WERE',128,48);x.fillText('WARNED',128,86);
  return c;
}
function paintingC(){
  const [c,x]=cv(256,192);
  const g=x.createLinearGradient(0,0,0,192);g.addColorStop(0,'#0c0202');g.addColorStop(.55,'#5a0808');g.addColorStop(1,'#120404');
  x.fillStyle=g;x.fillRect(0,0,256,192);
  x.fillStyle='#070202';x.beginPath();x.moveTo(0,150);for(let i=0;i<=256;i+=16)x.lineTo(i,130+Math.sin(i*.05)*14);x.lineTo(256,192);x.lineTo(0,192);x.fill();
  x.fillStyle='#000';x.beginPath();x.ellipse(128,92,10,14,0,0,7);x.fill();x.fillRect(122,104,12,44);x.fillRect(112,108,4,46);x.fillRect(140,108,4,46);
  x.strokeStyle='rgba(200,180,160,.4)';for(let k=0;k<6;k++){x.beginPath();x.moveTo(rnd(0,256),rnd(0,192));x.lineTo(rnd(0,256),rnd(0,192));x.stroke();}
  noiseFill(x,256,192,20);return c;
}

/* ---------- ward surface material ---------- */
// The colour graph writes the tangent-space normal (surfN) and the roughness (surfR) into properties that the normal
// and roughness graphs of the same fragment read.
const surfN=property('vec3','surfN'),surfR=property('float','surfR');
const {uv:uvAttr,dFdx,dFdy,dot,fract,normalMap,normalWorldGeometry}=TSL;
// Medium/high: a world-space layer of standing water, grime and gloss, so wear never repeats with the 3 m maps.
const macroTex=qualityLevel==='low'?null:tex(HollowVisuals.surface('ward-macro').map,null,false);
const hash12=Fn(([p])=>{const q=fract(p.xyx.mul(.1031)).toVar();q.addAssign(dot(q,q.yzx.add(33.33)));return fract(q.x.add(q.y).mul(q.z));});
// Ward maps vary per cell with a mirror and a tile-aligned shift (grout stays on the grid, the floor keeps its checker
// parity), so corridors never repeat in lockstep. Gradients come from the continuous UV: no mip seams at cell edges.
function cellUV(kind){
  if(kind==='wall'){
    // One box face per cell; a mirror keeps the bracket rust runs (0.18 / 0.82) under their brackets.
    const p=uvAttr(),nw=normalWorldGeometry.xz,cell=positionWorld.xz.sub(nw.mul(.5)).div(S).floor().add(nw.mul(3.7));
    const mx=step(.5,hash12(cell)),s=vec2(mx.mul(-2).add(1),1);
    return {uv:vec2(mix(p.x,p.x.oneMinus(),mx),p.y),gx:dFdx(p).mul(s),gy:dFdy(p).mul(s),s};
  }
  const p=uvAttr().mul(W),cell=p.floor(),f=p.sub(cell),tiles=kind==='floor'?8:5;
  const h=vec2(hash12(cell),hash12(cell.add(vec2(7.31,3.17))));
  const mir=vec2(step(.5,fract(h.x.mul(8.13))),step(.5,fract(h.y.mul(8.13)))),s=mir.mul(-2).add(1);
  const shift=kind==='floor'?h.mul(4).floor().mul(2).add(mir):h.mul(tiles).floor();
  return {uv:mix(f,f.oneMinus(),mir).add(shift.div(tiles)),gx:dFdx(p).mul(s),gy:dFdy(p).mul(s),s};
}
// Specular anti-aliasing (Toksvig): mips of a busy normal map shorten the averaged normal; widen the lobe to match.
// Low (the test tier) stays nearly as cheap as flat albedo: roughness maps only, no relief, per-cell variation or this.
const wardLow=qualityLevel==='low';
// Runtime ward detail for materials built at medium/high, so auto quality can cheapen them without a rebuild:
// 2 = per-cell variation (high), 1 = macro wear and grid contact shadows (medium), 0 = plain maps (low).
const wardDetail=uniform(qualityLevel==='high'?2:qualityLevel==='medium'?1:0);
function specAA(r,n){if(wardLow)return r;const len=n.mul(2).sub(1).length().max(.25),v=len.oneMinus().sub(.012).max(0).div(len).mul(2);return r.mul(r).mul(r.mul(r)).add(v).sqrt().sqrt().min(1);}
// World-space wear on the ward (medium/high): broad puddles that mirror the torch, grime and gloss drift.
function wardMacro(kind,color){
  const p=positionWorld;
  if(kind==='floor'){
    const mc=texture(macroTex,p.xz.div(9)),wet=smoothstep(.6,.68,mc.r),damp=smoothstep(.5,.6,mc.r).mul(wet.oneMinus());
    color.assign(vec4(color.rgb.mul(mc.g.mul(.3).add(.85)).mul(wet.mul(-.45).sub(damp.mul(.15)).add(1)),color.a));
    surfR.assign(mix(surfR.mul(damp.mul(-.35).add(1)).mul(mc.b.mul(.25).add(.9)),.045,wet));
    surfN.assign(mix(surfN,vec3(.5,.5,1),wet.mul(.85)));
  }else if(kind==='wall'){
    const mc=texture(macroTex,vec2(p.x.add(p.z),p.y.mul(1.4)).div(11));
    color.assign(vec4(color.rgb.mul(mc.g.mul(.3).add(.84)),color.a));surfR.assign(surfR.mul(mc.b.mul(.3).add(.85)).min(1));
  }else{
    const mc=texture(macroTex,p.xz.div(13));color.assign(vec4(color.rgb.mul(mc.g.mul(.42).add(.72)),color.a));
  }
}
// Medium/high: contact shadow from the maze grid itself (one texel per cell, re-uploaded when a new maze replaces `grid`).
// Floors and ceilings darken toward walls and into corners; walls darken toward the floor, the ceiling and inner corners.
const aoTex=qualityLevel==='low'?null:new THREE.DataTexture(new Uint8Array(W*W*4),W,W);
let aoGrid=null;
if(aoTex){aoTex.magFilter=aoTex.minFilter=THREE.NearestFilter;aoTex.generateMipmaps=false;aoTex.wrapS=aoTex.wrapT=THREE.ClampToEdgeWrapping;aoTex.needsUpdate=true;}
const aoSync=uniform(0).onFrameUpdate(()=>{
  if(!aoTex||aoGrid===grid||grid.length!==W)return;
  aoGrid=grid;const d=aoTex.image.data;
  for(let z=0;z<W;z++)for(let x=0;x<W;x++){const v=grid[z][x]===1?255:0,i=(z*W+x)*4;d[i]=d[i+1]=d[i+2]=v;d[i+3]=255;}
  aoTex.needsUpdate=true;
});
const aoFall=d=>d.div(.7).clamp(0,1).oneMinus().pow(2);
// open: no ceiling (the floors above ground), so walls do not darken toward the top.
function gridAO(kind,open){
  const p=positionWorld,solid=c=>texture(aoTex,c.add(.5).div(W)).level(0).r;
  if(kind==='wall'){
    // The open cell in front of the face, the face tangent, and the inner corners at either end of it.
    const n=normalWorldGeometry.xz,o=p.xz.add(n.mul(S*.5)).div(S).floor(),t=vec2(n.y.negate(),n.x);
    const u=dot(p.xz.div(S).sub(o).sub(.5),t);
    const side=solid(o.add(t)).mul(aoFall(u.oneMinus().sub(.5).mul(S))).max(solid(o.sub(t)).mul(aoFall(u.add(.5).mul(S))));
    if(open)return side.max(aoFall(p.y)).mul(.45).add(aoSync).oneMinus();
    return side.max(aoFall(p.y)).max(aoFall(float(H).sub(p.y)).mul(.7)).mul(.45).add(aoSync).oneMinus();
  }
  const c=p.xz.div(S),cell=c.floor(),f=c.sub(cell),dE=f.x.oneMinus().mul(S),dW=f.x.mul(S),dN=f.y.mul(S),dS=f.y.oneMinus().mul(S);
  const at=(x,z)=>solid(cell.add(vec2(x,z)));
  const occ=at(1,0).mul(aoFall(dE)).max(at(-1,0).mul(aoFall(dW))).max(at(0,-1).mul(aoFall(dN))).max(at(0,1).mul(aoFall(dS)))
    .max(at(1,-1).mul(aoFall(vec2(dE,dN).length()))).max(at(-1,-1).mul(aoFall(vec2(dW,dN).length())))
    .max(at(1,1).mul(aoFall(vec2(dE,dS).length()))).max(at(-1,1).mul(aoFall(vec2(dW,dS).length())));
  return occ.mul(kind==='floor'?.5:.4).add(aoSync).oneMinus();
}
// set: {albedo,normal,roughness} canvases; opts.cells/macro ('wall'|'floor'|'ceiling') add per-cell variation and wear.
// opts.ao: the grid contact shadows alone (without the per-cell maps); opts.open: no ceiling above them.
// Every material carries real roughness maps, and on medium/high normal maps.
function wardMat(set,rep,params,opts){
  const o=opts||{},b=tex(set.albedo,rep),hn=tex(set.normal,rep,false),hr=tex(set.roughness,rep,false),ao=o.ao||o.cells;
  HollowVisuals.whenPainted(set,()=>{b.needsUpdate=true;hn.needsUpdate=true;hr.needsUpdate=true;});
  const m=new THREE.MeshStandardNodeMaterial(Object.assign({map:b,normalMap:wardLow?null:hn,roughnessMap:hr,roughness:1,metalness:0},params||{}));
  m.userData.hollowSurface='ward';
  const flat=vec3(.5,.5,1);
  const plain=()=>{const n=wardLow?flat:texture(hn).xyz;return {c:texture(b),n,r:specAA(texture(hr).g,n)};};
  const surface=()=>{
    if(!o.cells||wardLow)return plain();
    const c=vec4(0).toVar(),n=vec3(0).toVar(),r=float(0).toVar();
    If(wardDetail.greaterThan(1.5),()=>{
      const v=cellUV(o.cells),cn=texture(hn,v.uv).grad(v.gx,v.gy).xyz;
      c.assign(texture(b,v.uv).grad(v.gx,v.gy));n.assign(vec3(cn.xy.sub(.5).mul(v.s).add(.5),cn.z));r.assign(specAA(texture(hr,v.uv).grad(v.gx,v.gy).g,cn));
    }).Else(()=>{const p=plain();c.assign(p.c);n.assign(p.n);r.assign(p.r);});
    return {c,n,r};
  };
  m.colorNode=Fn(()=>{
    const color=vec4(0).toVar(),h=surface();color.assign(h.c);surfN.assign(h.n);surfR.assign(h.r);
    if((macroTex&&o.macro)||(aoTex&&ao))If(wardDetail.greaterThan(.5),()=>{
      if(macroTex&&o.macro)wardMacro(o.macro,color);
      if(aoTex&&ao)color.assign(vec4(color.rgb.mul(gridAO(ao,o.open)),color.a));
    });
    return color;
  })();
  m.roughnessNode=surfR;
  if(!wardLow)m.normalNode=normalMap(surfN);
  return m;
}
// Painted canvases get relief from luminance and roughness from their paint.
function painted(c,rough,depth){return Object.assign({albedo:c},HollowVisuals.deriveMaps(c,{roughness:rough,depth}));}
const hellRunner=painted(hellRunnerC(),()=>.9,2),hellDoor=painted(hellDoorC(),(r,g,b,l)=>.82-l*.3,3),hellPed=painted(hellPedC(),()=>.8,2);
const wallMat=wardMat(wardWallS,null,{},{cells:'wall',macro:'wall'});
const floorMat=wardMat(wardFloorS,[W,W],{},{cells:'floor',macro:'floor'});
const ceilMat=wardMat(wardCeilS,[W,W],{},{cells:'ceiling',macro:'ceiling'});
const runnerMat=wardMat(hellRunner,[7,1]);
const doorMat=wardMat(hellDoor,null,{metalness:0.1});
const pedMat=wardMat(hellPed);
if(window.HollowVisuals){
  scene.environment=HollowVisuals.createEnvironment(THREE,renderer);
}

/* ---------- maze ---------- */
let grid=[],specialRooms=[],roomDoors=[],roomProps=[],roomLoot=[],fuses=0,decoys=3,decoyEvents=[],exitPowered=false,mazeNavigator=null;
let interaction=null,interactionT=0,hideTime=0,hitMarkerT=0,damageT=0,noticeT=0,worldSeed=0;
let horror=HollowHorror.create(0),caseNotes=[],readNotes=new Set(),captionText='',captionT=0,exitRelease=0,exitOpen=false,alarmT=0,simulationTime=0;
// The campaign: floor indexes RULES.FLOORS. owned[i]: the survivor carries weaponDefs[i]. checkpoint: the kit, time and
// banked score carried onto this floor (retry and Continue start from it). scoreBase: kills and points from floors
// already cleared (the streak restarts on every floor).
let floor=0,checkpoint=null,scoreBase={points:0,kills:0},owned=[],sleepHint=false,wakeBannerT=-99,wakeStingT=-99,howlAt=-99;
const FLOOR=()=>RULES.FLOORS[floor]||RULES.FLOORS[0];
// Each floor's objective wording. B1's lines are the ward's original ones.
const FLOOR_TEXT=[
  {tag:'FUSE',tags:'FUSES',one:'fuse',many:'fuses',need:n=>`Exit needs ${n} more power ${n===1?'fuse':'fuses'}`,label:'POWER FUSE',sign:'POWER OFFLINE / 3 FUSES',take:'Recover power fuse',start:'Start emergency release',locked:'Power is offline.',
    all:'All fuses secured. Reach the exit to restore power.',allKick:'All fuses · reach the exit',kick:'Power fuse',
    power:'POWER RESTORED',powerKick:'Shutter releasing',powered:'Power restored. The shutter is releasing. Keep moving — they can hear it.',
    open:'SHUTTER OPEN · RUN',opened:'SHUTTER OPEN. Leave the ward.',releasing:'RELEASING SHUTTER',released:'RELEASE COMPLETE · RUN',
    go:'EVACUATE · east loading exit',ready:'3 / 3 FUSES · power the east loading shutter',
    areas:['BLACKWATER / ADMISSIONS','BLACKWATER / SERVICE WING','BLACKWATER / LOWER TREATMENT'],wing:'BW / LOWER WING',
    guide:'BLACKWATER / ISOLATION ROOMS →',
    intro:'B1 · BLACKWATER WARD · Recover three fuses. The east loading shutter leads deeper. Some bodies here are only sleeping.'},
  {tag:'KEYCARD',tags:'KEYCARDS',one:'keycard',many:'keycards',need:n=>`The lift needs ${n} more ${n===1?'keycard':'keycards'}`,label:'LIFT KEYCARD',sign:'LIFT LOCKED / 3 KEYCARDS',take:'Take lift keycard',start:'Call the freight lift',locked:'The freight lift is locked out.',
    all:'All keycards found. Call the freight lift.',allKick:'All keycards · reach the lift',kick:'Lift keycard',
    power:'LIFT CALLED',powerKick:'The lift is coming down',powered:'Keycards accepted. The freight lift is coming down, loudly. Everything heard it.',
    open:'THE LIFT IS HERE · RUN',opened:'THE LIFT IS HERE. Get in.',releasing:'LIFT DESCENDING',released:'LIFT ARRIVED · RUN',
    go:'GET IN · east freight lift',ready:'3 / 3 KEYCARDS · call the freight lift',
    areas:['B2 / RECORDS','B2 / COLD STORAGE','B2 / CREMATORIUM WING'],wing:'BW / MORGUE LEVEL',
    guide:'B2 / COLD VAULTS LOCK FROM INSIDE',
    intro:'B2 · RECORDS & MORGUE · The bodies here are only sleeping. Three lift keycards. Don\'t wake them.'},
  {tag:'KEY',tags:'KEYS',one:'key',many:'keys',need:n=>`The floodgate needs ${n} more ${n===1?'key':'keys'}`,label:'FLOODGATE KEY',sign:'FLOODGATE SEALED / 3 KEYS',take:'Take floodgate key',start:'Open the surface floodgate',locked:'The floodgate is sealed.',
    all:'All keys found. Open the floodgate.',allKick:'All keys · reach the floodgate',kick:'Floodgate key',
    power:'FLOODGATE UNSEALED',powerKick:'The gate is grinding open',powered:'Keys turned. The floodgate is grinding open and the whole Hollow heard it.',
    open:'FLOODGATE OPEN · RUN',opened:'FLOODGATE OPEN. Get out.',releasing:'FLOODGATE OPENING',released:'FLOODGATE OPEN · RUN',
    go:'GET OUT · surface floodgate',ready:'3 / 3 KEYS · open the surface floodgate',
    areas:['B3 / PUMP GALLERY','B3 / THE WELL','B3 / CISTERNS'],wing:'BW / CISTERN LEVEL',
    guide:'B3 / BULKHEADS LOCK FROM INSIDE',
    intro:'B3 · THE HOLLOW · Three floodgate keys. The surface floodgate is the only way out.'},
  {tag:'KEY',tags:'KEYS',one:'gate key',many:'gate keys',need:n=>`The garden gate needs ${n} more ${n===1?'key':'keys'}`,label:'GATE KEY',sign:'GARDEN GATE / 3 KEYS',take:'Take gate key',start:'Wind the garden gate open',locked:'The garden gate is chained shut.',
    all:'All gate keys found. Open the garden gate.',allKick:'All keys · reach the garden gate',kick:'Gate key',
    power:'THE GATE IS WINDING',powerKick:'The chain is rattling loose',powered:'The keys turn. The garden gate winds open on a rattling chain, and the whole garden heard it.',
    open:'GARDEN GATE OPEN · RUN',opened:'THE GARDEN GATE IS OPEN. Run.',releasing:'GATE WINDING OPEN',released:'GATE OPEN · RUN',
    go:'RUN · the garden gate',ready:'3 / 3 KEYS · open the garden gate',
    areas:['S1 / THE TERRACE','S1 / THE WALLED GARDEN','S1 / THE WILD BORDERS'],wing:'BW / THE OLD GARDEN',
    guide:'S1 / GARDEN SHEDS BOLT FROM INSIDE',
    intro:'S1 · THE OVERGROWN GARDEN · Out of the Hollow, under the moon. Three gate keys. Things are sleeping in the borders.'},
  {tag:'KEY',tags:'KEYS',one:'crypt key',many:'crypt keys',need:n=>`The cemetery gate needs ${n} more ${n===1?'crypt key':'crypt keys'}`,label:'CRYPT KEY',sign:'CEMETERY GATE / 3 KEYS',take:'Take crypt key',start:'Unchain the cemetery gate',locked:'The cemetery gate is chained to the old bell.',
    all:'All crypt keys found. Unchain the cemetery gate.',allKick:'All keys · reach the cemetery gate',kick:'Crypt key',
    power:'THE BELL TOLLS',powerKick:'Something answers it',powered:'The chain runs up to the bell, and the bell begins to toll. The ground in front of the gate is moving.',
    open:'CEMETERY GATE OPEN · RUN',opened:'THE CEMETERY GATE IS OPEN. Run.',releasing:'GATE UNCHAINING',released:'GATE OPEN · RUN',
    go:'RUN · the cemetery gate',ready:'3 / 3 KEYS · unchain the cemetery gate',
    areas:['S2 / THE NORTH WALKS','S2 / THE OLD GRAVES','S2 / THE GATE PLOT'],wing:'BW / BLACKWATER CEMETERY',
    guide:'S2 / CRYPTS BOLT FROM INSIDE',
    intro:'S2 · BLACKWATER GRAVEYARD · Three crypt keys unchain the cemetery gate. The gate is chained to the old bell.'}
];
const TEXT=()=>FLOOR_TEXT[floor]||FLOOR_TEXT[0];
const more=n=>`${n} more ${n===1?TEXT().one:TEXT().many}`;
const dynamicWorld=new THREE.Group();scene.add(dynamicWorld);
dynamicWorld.matrixAutoUpdate=false;
const roomLights=[];
// Lamp colour per floor: B1 keeps its fixtures, B2's run cold blue, B3's burn red, S1's lanterns warm amber, S2's
// a pale grave-light. Shelter lamps keep their green.
const FLOOR_LAMPS=[null,{tint:lin(0x8fb8e8),mix:.6},{tint:lin(0xd2503a),mix:.6},{tint:lin(0xe0a060),mix:.45},{tint:lin(0xa9c2b0),mix:.5}],lampMix=new THREE.Color();
function floorLamp(hex,shelter){const f=FLOOR_LAMPS[floor];if(!f||shelter)return hex;
  return lampMix.setHex(hex,THREE.LinearSRGBColorSpace).lerp(f.tint,f.mix).getHex(THREE.LinearSRGBColorSpace);}
function genMaze(){
  const layout=RULES.generateFloor(floor,Math.random);specialRooms=layout.rooms;return layout.grid;
}
function cellWall(cx,cz){if(cx<0||cz<0||cx>=W||cz>=W)return false;return grid[cz][cx]===1;}
function wallAt(x,z){return cellWall(Math.floor(x/S),Math.floor(z/S));}
function openCell(cx,cz){return cx>=0&&cz>=0&&cx<W&&cz<W&&grid[cz][cx]===0&&!(cx===0&&cz===ENT_Z);}
function doorAtCell(cx,cz){return roomDoors.find(d=>d.room.door.x===cx&&d.room.door.z===cz&&!d.open);}
function center(cx,cz){return [cx*S+S/2,cz*S+S/2];}
const obstacles=[];   // {x,z,r}
function resolve(p,r){
  const circ=o=>{const dx=p.x-o.x,dz=p.z-o.z,d=Math.hypot(dx,dz),limit=o.r+r;if(d<limit&&d>1e-6){p.x=o.x+dx/d*limit;p.z=o.z+dz/d*limit;}};
  // Recheck world solids after furniture/door corrections. Living actors are
  // handled as movement constraints, never as forces on the player's position.
  for(let it=0;it<3;it++){
    for(const o of obstacles)circ(o);
    for(const o of roomProps)if((p.y||0)<o.h-.05)RULES.circleBox(p,r,o);
    for(const d of roomDoors)if(!d.open)RULES.circleBox(p,r,d.box);
    const gx=Math.floor(p.x/S),gz=Math.floor(p.z/S);
    for(let dz=-1;dz<=1;dz++)for(let dx=-1;dx<=1;dx++){
      const cx=gx+dx,cz=gz+dz;if(!cellWall(cx,cz))continue;
      RULES.circleBox(p,r,{x:(cx+.5)*S,z:(cz+.5)*S,w:S,d:S});
    }
    if(p.z>DZ0-.3&&p.z<DZ1+.3){if(p.x>-.06&&p.x<.14+r)p.x=.14+r;else if(p.x<=-.06&&p.x>-.14-r)p.x=-.14-r;}
    if(localInDanger()&&!exitOpen&&p.x>(W-1)*S-.3&&p.z>(W-3)*S)p.x=(W-1)*S-.3;
  }
  p.x=Math.max(-110,Math.min(W*S+60,p.x));p.z=Math.max(-70,Math.min(W*S+70,p.z));
}
function movePlayer(dx,dz){
  // A door may have closed around us since the last movement step. Keep the
  // rollback point world-valid even when a creature blocks that correction.
  resolve(P.pos,PR);
  const from={x:P.pos.x,z:P.pos.z};
  const blocked=()=>state==='play'&&monsters.some(m=>!m.dead&&!m.dormant&&P.pos.y<m.stats.height&&
    RULES.blocksCircleMove(from,P.pos,PR,{x:m.pos.x,z:m.pos.z,r:m.stats.radius}));
  P.pos.x=from.x+dx;P.pos.z=from.z+dz;resolve(P.pos,PR);
  if(!blocked())return;
  // Try sliding along either axis instead of depenetrating through a wall.
  P.pos.x=from.x+dx;P.pos.z=from.z;resolve(P.pos,PR);
  if(!blocked())return;
  P.pos.x=from.x;P.pos.z=from.z+dz;resolve(P.pos,PR);
  if(!blocked())return;
  P.pos.x=from.x;P.pos.z=from.z;
}
// Above ground there is sky over the hedges and walls (they stand a little over H): a shot or a glance can pass over.
let outdoorNow=false;
function blocksRay(x,y,z){
  if(outdoorNow){if(y<0||y<H+.4&&wallAt(x,z))return true;}
  else if(y<0||y>H||wallAt(x,z))return true;
    if(!exitOpen&&Math.abs(x-((W-1)*S-.02))<.12&&Math.abs(z-((W-2)*S+S/2))<S/2)return true;
  for(const d of roomDoors)if(!d.open&&Math.abs(x-d.box.x)<d.box.w/2&&Math.abs(z-d.box.z)<d.box.d/2)return true;
  for(const p of roomProps)if(y<p.h&&Math.abs(x-p.x)<p.w/2&&Math.abs(z-p.z)<p.d/2)return true;
  return false;
}
function los(ax,az,bx,bz){const dx=bx-ax,dz=bz-az,d=Math.hypot(dx,dz),steps=Math.ceil(d/.32);for(let i=1;i<steps;i++)if(blocksRay(ax+dx*i/steps,1.2,az+dz*i/steps))return false;return true;}
function sightLine(ax,ay,az,bx,by,bz){const steps=Math.max(1,Math.ceil(Math.hypot(bx-ax,bz-az)/.3));for(let i=1;i<steps;i++){const k=i/steps;if(blocksRay(lerp(ax,bx,k),lerp(ay,by,k),lerp(az,bz,k)))return false;}return true;}
function movementClear(ax,az,bx,bz,r){return !!mazeNavigator&&mazeNavigator.clear(ax,az,bx,bz,r);}
function distField(sx,sz){
  const d=new Int32Array(W*W).fill(-1),q=[sz*W+sx];d[q[0]]=0;let h=0;
  while(h<q.length){const c=q[h++];const cx=c%W,cz=(c/W)|0;
    for(const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]]){const nx=cx+dx,nz=cz+dz;if(!openCell(nx,nz))continue;const ni=nz*W+nx;if(d[ni]>=0)continue;d[ni]=d[c]+1;q.push(ni);}}
  return d;
}

/* ---------- static world: hall shell + props ---------- */
const skyU={top:uniform(untone(0x050203)),hor:uniform(untone(0x1a0505)),bot:uniform(new THREE.Color(0))};
const skyMat=new THREE.MeshBasicNodeMaterial({side:THREE.BackSide,depthWrite:false,fog:false});
{const h=positionLocal.normalize().y;skyMat.colorNode=select(h.greaterThan(0),mix(skyU.hor,skyU.top,h.max(0).pow(.55)),mix(skyU.hor,skyU.bot,h.negate().mul(5).clamp(0,1)));}
// Above ground the sky is skyNightMat (setOutdoor): the same gradient with a moon, its halo and a field of stars.
// MOON_DIR is where the moonlight comes from.
const MOON_DIR=new THREE.Vector3(.6,.45,.65).normalize(),skyNightMat=new THREE.MeshBasicNodeMaterial({side:THREE.BackSide,depthWrite:false,fog:false});
{const d=positionLocal.normalize(),h=d.y,base=select(h.greaterThan(0),mix(skyU.hor,skyU.top,h.max(0).pow(.55)),mix(skyU.hor,skyU.bot,h.negate().mul(5).clamp(0,1)));
  const md=dot(d,vec3(MOON_DIR.x,MOON_DIR.y,MOON_DIR.z)),disc=smoothstep(.99955,.9997,md),halo=smoothstep(.96,1,md).pow(10).mul(.22).add(smoothstep(.6,1,md).pow(4).mul(.04));
  const cell=d.mul(480).floor(),star=step(.9992,hash12(cell.xy.add(cell.z.mul(37.17)))).mul(hash12(cell.xz.add(11.3)).mul(.8).add(.2)).mul(smoothstep(.04,.3,h));
  skyNightMat.colorNode=base.add(vec3(.93,.95,1).mul(disc.mul(2.2).add(halo))).add(vec3(.75,.8,.9).mul(star));}
const sky=new THREE.Mesh(new THREE.SphereGeometry(500,32,16),skyMat);
sky.renderOrder=-10;scene.add(sky);
// Moonlight on the floors above ground (left out of the lighting below, where it would only light the ceiling). No
// shadows: the torch keeps them.
const moon=physical(new THREE.DirectionalLight(0xb4c4f0,0),Math.PI);moon.position.copy(MOON_DIR).multiplyScalar(60);moon.visible=false;scene.add(moon);scene.add(moon.target);
function glowTex(inner,outer){const [c,x]=cv(128,128);const g=x.createRadialGradient(64,64,0,64,64,64);g.addColorStop(0,inner);g.addColorStop(.18,inner);g.addColorStop(.35,outer);g.addColorStop(1,'rgba(0,0,0,0)');x.fillStyle=g;x.fillRect(0,0,128,128);return new THREE.CanvasTexture(c);}

const maze=new THREE.Group();scene.add(maze);
const hall=new THREE.Group();scene.add(hall);
let doorL,doorR,chandelier,button,plaque,bulbMat;
// The ward's ceiling, carpet, fittings and red exit lamp: hidden above ground (setOutdoor), where the floor is lawn or soil.
const hallIndoor=[];let hallRed=null;
function buildStatic(){
  const L=W*S;
  const floor=new THREE.Mesh(new THREE.PlaneGeometry(L,L),floorMat);floor.rotation.x=-Math.PI/2;floor.position.set(L/2,0,L/2);floor.receiveShadow=true;hall.add(floor);
  const ceil=new THREE.Mesh(new THREE.PlaneGeometry(L,L),ceilMat);ceil.rotation.x=Math.PI/2;ceil.position.set(L/2,H,L/2);ceil.receiveShadow=true;hall.add(ceil);
  // runner carpet from door to pedestal
  const run=new THREE.Mesh(new THREE.PlaneGeometry(15.8,1.9),runnerMat);run.rotation.x=-Math.PI/2;run.position.set(8.05,0.006,DZC);run.receiveShadow=true;hall.add(run);
  // door leaves
  const leafGeo=new THREE.BoxGeometry(0.1,2.95,1.5);
  doorL=new THREE.Group();doorL.position.set(0.07,0,DZ0);const lm=new THREE.Mesh(leafGeo,doorMat);lm.position.set(0,1.475,0.75);lm.castShadow=lm.receiveShadow=true;doorL.add(lm);hall.add(doorL);
  doorR=new THREE.Group();doorR.position.set(0.07,0,DZ1);const rm=new THREE.Mesh(leafGeo,doorMat);rm.position.set(0,1.475,-0.75);rm.castShadow=rm.receiveShadow=true;doorR.add(rm);hall.add(doorR);
  // pedestal + button + plaque
  const pedestal=new THREE.Mesh(new THREE.CylinderGeometry(0.28,0.34,1.0,24),pedMat);pedestal.position.set(PED.x,0.5,PED.z);pedestal.castShadow=pedestal.receiveShadow=true;hall.add(pedestal);
  const gold=new THREE.MeshStandardMaterial({color:lin(0xc9a04e),metalness:0.85,roughness:0.3});
  const top=new THREE.Mesh(new THREE.CylinderGeometry(0.36,0.36,0.05,24),gold);top.position.set(PED.x,1.025,PED.z);top.castShadow=true;hall.add(top);
  button=new THREE.Mesh(new THREE.SphereGeometry(0.075,20,10,0,Math.PI*2,0,Math.PI/2),new THREE.MeshStandardMaterial({color:lin(0x8a0b0b),roughness:0.25}));
  button.position.set(PED.x,1.05,PED.z);hall.add(button);
  const plaqueTex=new THREE.CanvasTexture(plaqueC());plaqueTex.colorSpace=THREE.SRGBColorSpace;
  plaque=new THREE.Mesh(new THREE.PlaneGeometry(0.5,0.22),new THREE.MeshStandardMaterial({map:plaqueTex,metalness:0.5,roughness:0.4}));
  plaque.position.set(PED.x-0.345,0.8,PED.z);plaque.rotation.set(0,-Math.PI/2,0);plaque.rotateX(-0.12);hall.add(plaque);
  obstacles.push({x:PED.x,z:PED.z,r:0.42});
  // chandelier, lying where it fell
  chandelier=new THREE.Group();hall.add(chandelier);
  const ring=new THREE.Mesh(new THREE.TorusGeometry(0.55,0.03,8,32),gold);ring.rotation.x=Math.PI/2;ring.position.y=-0.78;chandelier.add(ring);
  const hub=new THREE.Mesh(new THREE.SphereGeometry(0.12,12,10),gold);hub.position.y=-0.7;chandelier.add(hub);
  bulbMat=new THREE.MeshBasicMaterial({color:lin(0x0a0604)});
  const crystal=new THREE.MeshStandardMaterial({color:lin(0xffffff),metalness:0.1,roughness:0.05,emissive:lin(0x332211)});
  for(let k=0;k<10;k++){const a=k/10*Math.PI*2,cx=Math.cos(a)*0.55,cz=Math.sin(a)*0.55;
    const cand=new THREE.Mesh(new THREE.CylinderGeometry(0.018,0.018,0.12,6),new THREE.MeshStandardMaterial({color:lin(0xf6f0e0)}));cand.position.set(cx,-0.71,cz);chandelier.add(cand);
    const b=new THREE.Mesh(new THREE.SphereGeometry(0.03,8,6),bulbMat);b.scale.y=1.5;b.position.set(cx,-0.62,cz);chandelier.add(b);
    const cr=new THREE.Mesh(new THREE.OctahedronGeometry(0.04),crystal);cr.scale.y=2;cr.position.set(Math.cos(a+.3)*0.45,-0.95,Math.sin(a+.3)*0.45);chandelier.add(cr);}
  chandelier.traverse(o=>{if(o.isMesh)o.castShadow=true;});
  chandelier.position.set(CHAN.x,0.9,CHAN.z);chandelier.rotation.set(0.05,0.4,0.22);
  obstacles.push({x:CHAN.x,z:CHAN.z,r:0.75,chan:true});
  // paintings on the hall's north wall
  for(const px of [6,10.5,15]){
    const frame=new THREE.Mesh(new THREE.BoxGeometry(1.5,1.12,0.06),gold);frame.position.set(px,1.9,3.03);hall.add(frame);
    const pt=new THREE.CanvasTexture(paintingC());pt.colorSpace=THREE.SRGBColorSpace;
    const pm=new THREE.Mesh(new THREE.PlaneGeometry(1.32,0.96),new THREE.MeshStandardMaterial({map:pt,roughness:0.8}));pm.position.set(px,1.9,3.065);hall.add(pm);
    hallIndoor.push(frame,pm);
  }
  // exit sign + lights
  const ex=(W-1)*S,ez=(W-2)*S+S/2;
  const [scv,sx]=cv(256,96);sx.fillStyle='#120202';sx.fillRect(0,0,256,96);sx.fillStyle='#ff2a1c';sx.font='bold 64px "IBM Plex Mono",monospace';sx.textAlign='center';sx.textBaseline='middle';sx.fillText('EXIT',128,50);
  const stex=new THREE.CanvasTexture(scv);stex.colorSpace=THREE.SRGBColorSpace;
  const sign=new THREE.Mesh(new THREE.PlaneGeometry(0.9,0.34),new THREE.MeshBasicMaterial({map:stex}));sign.rotation.y=-Math.PI/2;sign.position.set(ex+0.02,H-0.35,ez);hall.add(sign);
  const red=physical(new THREE.PointLight(0xff2010,1.3,9),4,1);red.position.set(ex-0.5,H-0.5,ez);hall.add(red);
  hallIndoor.push(floor,ceil,run,top,button,plaque,chandelier,sign);hallRed=red;
}
const boxGeo=new THREE.BoxGeometry(0.56,0.3,0.32),lidGeo=new THREE.PlaneGeometry(0.4,0.14);
const boxMat=new THREE.MeshStandardMaterial({color:lin(0x4b5230),roughness:0.75,metalness:0.2});
const boxLabelMat=(()=>{const [c,x]=cv(256,96);x.fillStyle='#4b5230';x.fillRect(0,0,256,96);x.fillStyle='#d8c35a';x.font='bold 40px "IBM Plex Mono",monospace';x.textAlign='center';x.textBaseline='middle';x.fillText('7.62x39',128,38);x.font='22px "IBM Plex Mono",monospace';x.fillText('30 RDS',128,76);const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;return new THREE.MeshStandardMaterial({map:t,roughness:0.8,emissive:lin(0x111108)});})();
const MESSAGES=['IT HEARS YOU RUN','LOCK THE DOOR','LIGHTS OFF','THE WARDEN DOES NOT HURRY','THREE FUSES. ONE EXIT.','CROUCH. BREATHE. WAIT.','A SHOT IS AN INVITATION','ISOLATION SAVES LIVES'];
// B1 keeps its writing (the seeded draws depend on it). The first entry of a lower floor is painted in the hall.
const FLOOR_MESSAGES=[MESSAGES,
  ['DON\'T WAKE THEM','LIGHTS WAKE THEM','THEY ARE NOT DEAD','COUNT THE BODIES','ONE OF THEM MOVED','THREE CARDS CALL THE LIFT','DO NOT RUN PAST THEM','THE LIFT IS LOUD'],
  ['DON\'T WAKE THEM','IT CAME UP THE WELL','LIGHTS WAKE THEM','THREE KEYS. ONE GATE.','THE WATER HEARS YOU','NO ONE LEFT','THE GATE WAKES EVERYTHING','KEEP YOUR LIGHT LOW'],
  ['THEY SLEEP IN THE BORDERS','STAY ON THE PATHS','LIGHTS WAKE THEM','THREE KEYS. ONE GATE.','NOT FOXES','THE GATE IS LOUD','KEEP LOW','DON\'T WAKE THEM'],
  ['DO NOT RING THE BELL','HE KEEPS THE GATE','THEY ARE NOT DEAD','THREE KEYS. ONE BELL.','STAY OFF THE GRAVES','IT DIGS ITSELF OUT','KEEP YOUR LIGHT LOW','RUN WHEN IT FALLS']];
/* ---------- above ground: S1's garden and S2's graveyard ---------- */
// Made the first time a floor above ground is built: their surfaces are painted last (visuals.js LATE_SURFACES), so
// nothing here holds up the ward. The walls are one instanced mesh of clipped hedge or churchyard wall, the ground one plane.
const ABOVE={},SKY_WARD={top:skyU.top.value.clone(),hor:skyU.hor.value.clone()};
const SKY_NIGHT={garden:{top:untone(0x03060d),hor:untone(0x1a2536)},graveyard:{top:untone(0x030606),hor:untone(0x182221)}};
let aboveGroundPlane=null;
function aboveGround(kind){
  if(ABOVE[kind])return ABOVE[kind];
  const garden=kind==='garden',walls=HollowVisuals.surface(garden?'garden-hedge':'grave-wall',{pending:true}),ground=HollowVisuals.surface(garden?'garden-lawn':'grave-soil',{pending:true});
  return ABOVE[kind]={wall:wardMat(walls,null,{},{ao:'wall',open:true,macro:'wall'}),ground:wardMat(ground,null,{},{ao:'floor',macro:'ground'})};
}
// The garden's hedges, one merged mesh of clipped box hedge (S x H cells on y 0) with only the faces open to a path or
// a room: each a 4 x 4 grid pushed in (never out into the walk) by leafy lumps that fade out toward every edge, so
// neighbouring cells meet flush, under a gently domed top. They rise and fall a little from cell to cell (a smooth
// function of the cell: no random draws); where a hedge stands over a lower neighbour, a strip closes the step.
function hedgeWalls(solid){
  const pos=[],uv=[],index=[],N=4,T=2,height=(x,z)=>H*(1+.06*(1+Math.sin(x*.9+z*.4)*Math.cos(z*.7-x*.3)));
  const lump=(a,b,f)=>.5+.28*Math.sin(a*7.1+f)+.22*Math.sin(b*5.3+f*1.7)*Math.cos(a*3.7-f);
  const quads=(base,n)=>{for(let j=0;j<n;j++)for(let i=0;i<n;i++){const a=base+j*(n+1)+i,c=a+n+1;index.push(a,c,a+1,a+1,c,c+1);}};
  for(let z=0;z<W;z++)for(let x=0;x<W;x++){
    if(grid[z][x]!==1)continue;
    const cx=x*S+S/2,cz=z*S+S/2,h=height(x,z);let open=false;
    [[1,0],[-1,0],[0,1],[0,-1]].forEach(([nx,nz],face)=>{
      const ox=x+nx,oz=z+nz,base=pos.length/3,tx=-nz,tz=nx,edge=(u,y,dent)=>pos.push(cx+nx*(S/2-dent)+tx*(u-.5)*S,y,cz+nz*(S/2-dent)+tz*(u-.5)*S);
      if(solid(ox,oz)){
        const below=ox>=0&&oz>=0&&ox<W&&oz<W?height(ox,oz):h;if(below>=h-.01)return;
        edge(0,below,0);edge(1,below,0);edge(0,h,0);edge(1,h,0);uv.push(0,below/h,1,below/h,0,1,1,1);quads(base,1);return;
      }
      open=true;
      for(let j=0;j<=N;j++)for(let i=0;i<=N;i++){const u=i/N,v=j/N;edge(u,v*h,.22*Math.sin(Math.PI*u)*Math.min(1,v*3,(1-v)*3)*lump(u*3,v*3,face*1.9+x*.7+z*1.3));uv.push(u,v);}
      quads(base,N);
    });
    if(!open&&solid(x+1,z)&&solid(x-1,z)&&solid(x,z+1)&&solid(x,z-1)&&[[1,0],[-1,0],[0,1],[0,-1]].every(([nx,nz])=>{const ox=x+nx,oz=z+nz;return ox<0||oz<0||ox>=W||oz>=W||height(ox,oz)>=h-.01;}))continue;
    const top=pos.length/3;
    for(let j=0;j<=T;j++)for(let i=0;i<=T;i++){const u=i/T,w=j/T;pos.push(cx+(u-.5)*S,h+.16*Math.sin(Math.PI*u)*Math.sin(Math.PI*w),cz+(w-.5)*S);uv.push(u,w);}
    quads(top,T);
  }
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
  g.setIndex(index);g.computeVertexNormals();g.computeBoundingSphere();return g;
}
// The walls of an outdoor floor: S1's hedges, or S2's churchyard walls (one instanced mesh; a cell walled in on all
// four sides is never seen and is left out).
function outdoorWalls(){
  const garden=!FLOOR().boss,solid=(x,z)=>x<0||z<0||x>=W||z>=W||grid[z][x]===1,mat=aboveGround(garden?'garden':'graveyard').wall;
  if(garden){const hedges=new THREE.Mesh(hedgeWalls(solid),mat);hedges.castShadow=hedges.receiveShadow=true;return hedges;}
  const cells=[];
  for(let z=0;z<W;z++)for(let x=0;x<W;x++)if(grid[z][x]===1&&!(solid(x+1,z)&&solid(x-1,z)&&solid(x,z+1)&&solid(x,z-1)))cells.push([x,z]);
  const walls=new THREE.InstancedMesh(new THREE.BoxGeometry(S,H,S).translate(0,H/2,0),mat,cells.length),m=new THREE.Matrix4();
  cells.forEach(([x,z],i)=>{m.makeScale(1,1+.02*(1+Math.sin(x*1.3-z*.8)),1).setPosition(x*S+S/2,0,z*S+S/2);walls.setMatrixAt(i,m);});
  walls.instanceMatrix.needsUpdate=true;walls.castShadow=walls.receiveShadow=true;return walls;
}
// Above ground: the night sky, the moon, the lawn or soil underfoot and none of the ward's hall fittings.
function setOutdoor(on){
  const kind=FLOOR().boss?'graveyard':'garden';
  for(const o of hallIndoor)o.visible=!on;
  if(hallRed)setLight(hallRed,on?0:1.3);
  if(on){
    if(!aboveGroundPlane){const L=W*S,size=L+240,g=new THREE.PlaneGeometry(size,size),uv=g.attributes.uv;
      for(let i=0;i<uv.count;i++)uv.setXY(i,uv.getX(i)*size/S,uv.getY(i)*size/S);
      aboveGroundPlane=new THREE.Mesh(g,aboveGround(kind).ground);aboveGroundPlane.rotation.x=-Math.PI/2;aboveGroundPlane.position.set(L/2,0,L/2);aboveGroundPlane.receiveShadow=true;scene.add(aboveGroundPlane);}
    aboveGroundPlane.material=aboveGround(kind).ground;
  }
  if(aboveGroundPlane)aboveGroundPlane.visible=on;
  const tone=on?SKY_NIGHT[kind]:SKY_WARD;skyU.top.value.copy(tone.top);skyU.hor.value.copy(tone.hor);sky.material=on?skyNightMat:skyMat;
  setLight(moon,on?ENV[kind].moon:0);moon.visible=on;
}
function buildMaze(){
  maze.traverse(o=>{if(o.isInstancedMesh&&o.dispose)o.dispose();if(o.geometry&&o.geometry!==boxGeo&&o.geometry!==lidGeo)o.geometry.dispose();if(o.material&&o.userData.own){if(o.material.map)o.material.map.dispose();o.material.dispose();}});
  scene.remove(maze);maze.clear();scene.add(maze);
  grid=genMaze();outdoorNow=!!FLOOR().outdoor;
  if(outdoorNow)maze.add(outdoorWalls());else{
  let count=0;for(let z=0;z<W;z++)for(let x=0;x<W;x++)if(grid[z][x]===1)count++;
  const walls=new THREE.InstancedMesh(new THREE.BoxGeometry(S,H,S),wallMat,count);
  const m=new THREE.Matrix4();let i=0;
  for(let z=0;z<W;z++)for(let x=0;x<W;x++)if(grid[z][x]===1){m.makeTranslation(x*S+S/2,H/2,z*S+S/2);walls.setMatrixAt(i++,m);}
  walls.instanceMatrix.needsUpdate=true;walls.castShadow=walls.receiveShadow=true;maze.add(walls);
  }
  // The removed manor sconces drew from the seeded random stream here; the same draws keep seeded wards unchanged.
  for(let z=0;z<W;z++)for(let x=0;x<W;x++){if(!openCell(x,z)||Math.random()<.45)continue;
    const sides=(cellWall(x+1,z)?1:0)+(cellWall(x-1,z)?1:0)+(cellWall(x,z+1)?1:0)+(cellWall(x,z-1)?1:0);
    if(sides)Math.random();}
  // writings on the walls
  const used=new Set();let placed=0,tries=0;
  // S1's hedges take no writing.
  while(placed<(outdoorNow&&!FLOOR().boss?0:9)&&tries<600){tries++;
    const cx=1+Math.floor(Math.random()*(W-2)),cz=1+Math.floor(Math.random()*(W-2));
    if(!openCell(cx,cz)||used.has(cz*W+cx))continue;
    const inHall=cx<=5&&cz<=3;if(inHall&&placed>0)continue;
    const sides=[];if(cellWall(cx+1,cz))sides.push('px');if(cellWall(cx-1,cz))sides.push('nx');if(cellWall(cx,cz+1))sides.push('pz');if(cellWall(cx,cz-1)&&!inHall)sides.push('nz');
    if(!sides.length)continue;used.add(cz*W+cx);
    const side=sides[Math.floor(Math.random()*sides.length)];
    const lines=FLOOR_MESSAGES[floor]||MESSAGES;
    const t=new THREE.CanvasTexture(writingC(placed===0&&!floor?'YOU TOUCHED IT':lines[placed%lines.length]));t.colorSpace=THREE.SRGBColorSpace;
    const mat=new THREE.MeshStandardMaterial({map:t,transparent:true,depthWrite:false,roughness:0.6,polygonOffset:true,polygonOffsetFactor:-2});
    const pl=new THREE.Mesh(new THREE.PlaneGeometry(2.2,1.1),mat);pl.userData.own=true;
    const [wx,wz]=center(cx,cz),y=rnd(1.3,1.9);
    if(side==='px'){pl.position.set((cx+1)*S-0.01,y,wz);pl.rotation.y=-Math.PI/2;}
    if(side==='nx'){pl.position.set(cx*S+0.01,y,wz);pl.rotation.y=Math.PI/2;}
    if(side==='pz'){pl.position.set(wx,y,(cz+1)*S-0.01);pl.rotation.y=Math.PI;}
    if(side==='nz'){pl.position.set(wx,y,cz*S+0.01);}
    maze.add(pl);placed++;
  }
  // ammo boxes, mostly in dead ends
  ammoBoxes=[];
  const ends=[],any=[];
  for(let z=0;z<W;z++)for(let x=0;x<W;x++){if(!openCell(x,z)||(x<=6&&z<=4)||x===W-1)continue;
    let nb=0;for(const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]])if(openCell(x+dx,z+dz))nb++;
    if(specialRooms.some(r=>RULES.insideRoom(r,x*S+S/2,z*S+S/2)))continue;
    (nb===1?ends:any).push([x,z]);}
  const shuf=a=>{for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;};
  const picks=[];
  for(const c of shuf(ends).concat(shuf(any))){if(picks.every(o=>Math.abs(o[0]-c[0])+Math.abs(o[1]-c[1])>5))picks.push(c);if(picks.length===FLOOR().ammo)break;}
  for(const [cx,cz] of picks){const [wx,wz]=center(cx,cz);const g=new THREE.Group();
    const b=new THREE.Mesh(boxGeo,boxMat);b.position.y=0.15;b.castShadow=true;b.receiveShadow=true;g.add(b);
    const lid=new THREE.Mesh(lidGeo,boxLabelMat);lid.position.set(0,0.152,0.1601);g.add(lid);
    g.position.set(wx+rnd(-0.5,0.5),0,wz+rnd(-0.5,0.5));g.rotation.y=rnd(0,6.28);maze.add(g);
    ammoBoxes.push({g,x:g.position.x,z:g.position.z,taken:false});}
  buildRooms();
  maze.updateMatrix();maze.matrixAutoUpdate=false;
  maze.traverse(o=>{if(o.isMesh){o.updateMatrix();o.matrixAutoUpdate=false;}});
}

/* ---------- rooms, supplies, powered exit and real lockable doors ---------- */
function worldLabel(text,color,width){
  const [c,x]=cv(512,128);x.fillStyle='#111b21';x.fillRect(0,0,512,128);
  x.strokeStyle=color||'#87b7ae';x.lineWidth=3;x.strokeRect(6,6,500,116);
  x.fillStyle=color||'#a4d6c9';x.font='bold 30px monospace';x.textAlign='center';x.textBaseline='middle';x.fillText(text,256,65,476);
  const texture=new THREE.CanvasTexture(c);texture.colorSpace=THREE.SRGBColorSpace;
  const mesh=new THREE.Mesh(new THREE.PlaneGeometry(width||2,.5),new THREE.MeshBasicMaterial({map:texture}));mesh.userData.own=true;return mesh;
}
// One painted panel and its relief/roughness maps per session; buildRooms disposes each door's own albedo texture.
let isolationDoorMaps=null;
function isolationDoorMaterial(){
  if(!isolationDoorMaps){
    const [surface,c]=cv(512,512);c.fillStyle='#496267';c.fillRect(0,0,512,512);
    for(let i=0;i<30;i++)blot(c,rnd(0,512),rnd(0,512),rnd(12,95),i%3?'rgba(10,18,18,.16)':'rgba(133,88,45,.2)');
    c.strokeStyle='#1a292d';c.lineWidth=5;c.strokeRect(18,18,476,476);c.lineWidth=2;c.strokeRect(32,32,448,448);
    c.fillStyle='#1a252b';c.fillRect(62,100,388,95);c.strokeStyle='#617277';c.lineWidth=3;
    for(let y=112;y<190;y+=15){c.beginPath();c.moveTo(75,y);c.lineTo(437,y);c.stroke();}
    for(const x of [27,485])for(const y of [28,120,390,484]){c.fillStyle='#9ca6a0';c.beginPath();c.arc(x,y,4,0,Math.PI*2);c.fill();c.strokeStyle='#283330';c.lineWidth=1;c.beginPath();c.moveTo(x-3,y+1);c.lineTo(x+3,y-1);c.stroke();}
    c.save();c.beginPath();c.rect(36,450,440,28);c.clip();c.fillStyle='#242a29';c.fillRect(36,450,440,28);c.fillStyle='#b1a05c';for(let x=0;x<560;x+=52){c.beginPath();c.moveTo(x,445);c.lineTo(x+25,445);c.lineTo(x-9,485);c.lineTo(x-34,485);c.fill();}c.restore();
    noiseFill(c,512,512,12);
    const maps=HollowVisuals.deriveMaps(surface,{depth:2.6,roughness:(r,g,b,l)=>r>g*1.12&&r>b*1.35&&l<.4?.82:l>.5?.34:l<.15?.72:.52});
    isolationDoorMaps={surface,normal:tex(maps.normal,null,false),roughness:tex(maps.roughness,null,false)};
  }
  return new THREE.MeshStandardMaterial({map:tex(isolationDoorMaps.surface),normalMap:isolationDoorMaps.normal,roughnessMap:isolationDoorMaps.roughness,metalness:.2,roughness:1});
}
function buildRooms(){
  const oldDecorations=[];dynamicWorld.traverse(o=>{if(o.userData.decoration)oldDecorations.push(o);});
  if(window.HollowVisuals)oldDecorations.forEach(o=>HollowVisuals.disposeGroup(o));
  dynamicWorld.traverse(o=>{if(o.userData.own){if(o.geometry)o.geometry.dispose();if(o.material){if(o.material.map)o.material.map.dispose();o.material.dispose();}}});
  dynamicWorld.clear();roomDoors=[];roomProps=[];roomLoot=[];roomLights.length=0;fuses=0;exitPowered=false;exitRelease=0;exitOpen=false;alarmT=0;decoys=3;decoyEvents=[];hideTime=0;
    horror=HollowHorror.create(worldSeed);caseNotes=[];readNotes=new Set();captionText='';captionT=0;simulationTime=0;wakeBannerT=wakeStingT=-99;
    const ward=outdoorNow?HollowVisuals.decorateGrounds(THREE,groundsOptions()):HollowVisuals.decorateWard(THREE,{grid,cellSize:S,height:H,rooms:specialRooms,seed:worldSeed});
    dynamicWorld.add(ward);roomLights.push(...ward.userData.practicals.map(p=>({...p,color:floorLamp(p.color)})));
    chaosWorldBuilt(ward);
    if(outdoorNow)buildGrounds(ward);
  const own=o=>{o.userData.own=true;return o;};
  for(const r of specialRooms){
    const cx=(r.x+r.w/2)*S,cz=(r.z+r.d/2)*S;
    const group=new THREE.Group();group.position.set(cx,0,cz);dynamicWorld.add(group);r.group=group;
    if(window.HollowVisuals){
      const decoration=r.look?HollowVisuals.decorateOutdoorRoom(THREE,{width:r.w*S,depth:r.d*S,look:r.look}):HollowVisuals.decorateRoom(THREE,{width:r.w*S,depth:r.d*S,type:r.type});decoration.userData.decoration=true;group.add(decoration);
      for(const p of decoration.userData.colliders||[])roomProps.push({...p,x:p.x+cx,z:p.z+cz,room:r.id});
      decoration.traverse(o=>{o.updateMatrix();o.matrixAutoUpdate=false;});
    }
    const sign=worldLabel(r.name.toUpperCase(),r.shelter?'#8cdcc8':r.fuse?'#e7b878':'#a5bdca',2.9);
    sign.position.set(cx,2.7,r.z*S+(outdoorNow?.1:.025));dynamicWorld.add(sign);
    const strip=own(new THREE.Mesh(new THREE.BoxGeometry(2.4,.035,.12),new THREE.MeshBasicMaterial({color:lin(r.shelter?0x83d4c2:r.fuse?0xffc282:0xa6c4dd)})));
    strip.position.set(cx,H-.07,cz);group.add(strip);strip.position.x=0;strip.position.z=0;strip.visible=!outdoorNow;
    // Only the three nearest practical lights are active. Emissive fixtures stay visible.
    roomLights.push({x:cx,z:cz,color:floorLamp(r.shelter?0xbac3a7:r.fuse?0xcdb48b:0x9caeaa,r.shelter),shelter:!!r.shelter,box:{minX:r.x*S,maxX:(r.x+r.w)*S,minZ:r.z*S,maxZ:(r.z+r.d)*S}});
        const record=HollowHorror.RECORDS[r.id]||HollowHorror.FLOOR_RECORDS?.[r.id];
        if(record){
          const [paper,ink]=cv(512,512);ink.fillStyle='#b6ae95';ink.fillRect(0,0,512,512);
          ink.fillStyle='#393a31';ink.font='bold 24px monospace';ink.fillText('BLACKWATER / INTERNAL',28,52);
          ink.fillStyle='#723f30';ink.font='bold 18px monospace';ink.fillText(record.title,28,94,450);
          ink.fillStyle='#45443a';ink.font='19px monospace';let line='',y=150;
          for(const word of record.text.split(' ')){if(ink.measureText(line+word).width>445){ink.fillText(line,28,y);y+=29;line='';}line+=word+' ';}ink.fillText(line,28,y);
          ink.fillStyle='#6b6758';ink.fillRect(204,0,104,18);noiseFill(ink,512,512,9);
          const note=own(new THREE.Mesh(new THREE.PlaneGeometry(.62,.62),new THREE.MeshStandardMaterial({map:tex(paper),roughness:1})));
          const noteZ=r.z*S+(outdoorNow?.11:.055);note.position.set(cx,1.45,noteZ);dynamicWorld.add(note);
          caseNotes.push({id:r.id,x:cx,z:noteZ,...record});
        }
    if(r.shelter){
      const [dx,dz]=center(r.door.x,r.door.z),hinge=new THREE.Group();hinge.position.set(dx-S/2,0,dz);dynamicWorld.add(hinge);
      const panel=own(new THREE.Mesh(new THREE.BoxGeometry(S-.08,H-.15,.16),outdoorNow?new THREE.MeshStandardMaterial({color:lin(0x3a2b1e),roughness:.86}):isolationDoorMaterial()));
      panel.position.set(S/2,(H-.15)/2,0);panel.castShadow=panel.receiveShadow=true;hinge.add(panel);
      const sign=worldLabel(outdoorNow?'BOLT FROM INSIDE':'ISOLATION / MANUAL LOCK','#94d4bd',2.4);sign.position.set(S/2,2,.095);hinge.add(sign);
      const insideSign=worldLabel(outdoorNow?'DRAW THE BOLT':'MANUAL OVERRIDE','#94d4bd',1.3);insideSign.position.set(S/2,1.45,-.095);insideSign.rotation.y=Math.PI;hinge.add(insideSign);
      const handle=own(new THREE.Mesh(new THREE.BoxGeometry(.4,.075,.16),new THREE.MeshStandardMaterial({color:lin(0xb5b7a3),metalness:.8,roughness:.25})));
      handle.position.set(S-.5,1.1,.16);hinge.add(handle);
      const insideHandle=new THREE.Mesh(handle.geometry,handle.material);insideHandle.position.set(S-.5,1.1,-.16);hinge.add(insideHandle);
      roomDoors.push({id:r.id,room:r,hinge,open:true,locked:false,health:100,angle:-Math.PI/2,box:{x:dx,z:dz,w:S,d:.25,h:H},revision:0});hinge.rotation.y=-Math.PI/2;
      const loot=makeLoot('medical',cx-1,cz-1.2,r);roomLoot.push(loot);
    }
    if(r.fuse)roomLoot.push(makeLoot('fuse',cx,cz,r));
    if(r.type==='infirmary')roomLoot.push(makeLoot('medical',cx,cz,r));
    if(r.type==='armory'||r.type==='lounge')roomLoot.push(makeLoot('supplies',cx,cz,r));
    group.updateMatrix();group.matrixAutoUpdate=false;
  }
  // A nearby refuge is deliberately introduced with signage rather than a surprise mechanic.
  const guide=worldLabel(TEXT().guide,'#b8bea3',3.3);guide.position.set(7.5,2.3,3.06);dynamicWorld.add(guide);
  const exitSign=worldLabel(TEXT().sign,'#e7b878',2.3);exitSign.position.set((W-1)*S-.04,1.9,(W-2)*S+S/2);exitSign.rotation.y=-Math.PI/2;dynamicWorld.add(exitSign);
  const gate=outdoorNow?ironGate():own(new THREE.Mesh(new THREE.BoxGeometry(.14,H,S),isolationDoorMaterial()));
  gate.position.set((W-1)*S-.02,H/2,(W-2)*S+S/2);gate.castShadow=true;dynamicWorld.add(gate);dynamicWorld.userData.gate=gate;dynamicWorld.userData.exitSign=exitSign;
  mazeNavigator=HollowNavigation.create({grid,cellSize:S,props:roomProps,circles:obstacles,doors:()=>roomDoors.map(d=>({...d.box,open:d.open}))});
  if(outdoorNow)settleGrounds();
  placeWeapons();
  if(atm)addAtmosphereFixtures();
}
// The options decorateGrounds gets (tests/helpers/visuals-fixture.js mirrors them): the lobby pedestal and the fallen
// chandelier as landmarks, the gate approach and, on the boss floor, its graves kept clear.
function groundsOptions(){
  const f=FLOOR(),avoid=[{x:(W-2+.5)*S,z:(W-2+.5)*S,r:4}];
  if(f.boss)avoid.push({x:(f.boss.grave[0]+.5)*S,z:(f.boss.grave[1]+.5)*S,r:2.6},...f.boss.summons.map(([x,z])=>({x:(x+.5)*S,z:(z+.5)*S,r:2})));
  return {grid,cellSize:S,height:H,rooms:specialRooms,seed:worldSeed,kind:f.boss?'graveyard':'garden',avoid,
    centre:f.fountain?[(f.fountain[0]+.5)*S,(f.fountain[1]+.5)*S]:null,boss:f.boss||null,gate:[W-1,W-2],landmarks:{ped:{x:PED.x,z:PED.z},chan:{x:CHAN.x,z:CHAN.z}}};
}
// The grounds' furniture blocks like a room's; the tree line beyond the walls is scenery.
function buildGrounds(ward){
  for(const c of ward.userData.colliders)roomProps.push({...c,room:'grounds'});
  bossBell=ward.userData.bell||null;bellSwing=0;
  dynamicWorld.add(HollowVisuals.decorateHorizon(THREE,{kind:FLOOR().boss?'graveyard':'garden',seed:worldSeed,size:W*S}));
}
// The nearest spot to (x, z) within `reach` m where a body of radius r stands clear of walls and furniture, or null.
function clearSpotNear(x,z,r,reach,avoid=[]){
  let best=null,bd=Infinity;
  for(let i=-reach;i<=reach+1e-6;i+=.25)for(let j=-reach;j<=reach+1e-6;j+=.25){const px=x+i,pz=z+j,d=Math.hypot(i,j);
    if(d<bd&&d<=reach&&!wallAt(px,pz)&&movementClear(px,pz,px,pz,r)&&avoid.every(o=>Math.hypot(o.x-px,o.z-pz)>1.6)){best={x:px,z:pz};bd=d;}}
  return best;
}
// Once the grounds stand: an ammunition box that landed in their furniture moves to a clear spot nearby, and the boss
// floor lays out supplies and dressings around the edges of its arena.
function settleGrounds(){
  for(const b of ammoBoxes){if(movementClear(b.x,b.z,b.x,b.z,.45))continue;const p=clearSpotNear(b.x,b.z,.45,1.5);if(p){b.x=p.x;b.z=p.z;b.g.position.x=p.x;b.g.position.z=p.z;}}
  const f=FLOOR().boss;if(!f)return;
  const [x0,z0,x1,z1]=f.arena,mx=(x0+x1)>>1,mz=(z0+z1)>>1;
  for(const [cx,cz,type,id] of [[mx,z0,'supplies','n'],[x0,mz,'medical','w'],[mx,z1,'supplies','s'],[x1,mz-2,'medical','e']]){
    const p=clearSpotNear((cx+.5)*S,(cz+.5)*S,.5,2.5,roomLoot);
    if(p)roomLoot.push(makeLoot(type,p.x,p.z,{id:'arena-'+id,name:'The gate plot'}));
  }
}
// The gate out of a floor above ground: wrought-iron bars (one instanced mesh) that lift away like the shutter below.
function ironGate(){
  const group=new THREE.Group(),bars=17,mesh=new THREE.InstancedMesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshStandardMaterial({color:lin(0x1c1e1f),metalness:.8,roughness:.45}),bars+3),m=new THREE.Matrix4();
  mesh.userData.own=true;mesh.castShadow=true;
  for(let i=0;i<bars;i++){m.makeScale(.045,H+.3,.045).setPosition(0,.15,-S/2+.1+i*(S-.2)/(bars-1));mesh.setMatrixAt(i,m);}
  [-H/2+.3,H/2-.3,0].forEach((y,k)=>{m.makeScale(.08,.08,S-.06).setPosition(0,y,0);mesh.setMatrixAt(bars+k,m);});
  mesh.instanceMatrix.needsUpdate=true;group.add(mesh);return group;
}
// Beacon mount beside open cell (cx,cz): on the first wall found (W, E, N, S), 0.2 m off it.
function beaconMount(cx,cz){for(const [dx,dz] of [[-1,0],[1,0],[0,-1],[0,1]])if(grid[cz+dz]?.[cx+dx]===1)return{x:cx*S+S/2+dx*(S/2-.2),z:cz*S+S/2+dz*(S/2-.2)};return{x:cx*S+S/2,z:cz*S+S/2};}
// xz box of the straight open run through (cx,cz), at most 2 cells each way: beacon blades stop at the walls.
function runBox(cx,cz){const open=(x,z)=>grid[z]?.[x]===0;let a=0,b=0;
  if(open(cx-1,cz)||open(cx+1,cz)){while(a<2&&open(cx-a-1,cz))a++;while(b<2&&open(cx+b+1,cz))b++;return{minX:(cx-a)*S,maxX:(cx+b+1)*S,minZ:cz*S,maxZ:(cz+1)*S};}
  while(a<2&&open(cx,cz-a-1))a++;while(b<2&&open(cx,cz+b+1))b++;return{minX:cx*S,maxX:(cx+1)*S,minZ:(cz-a)*S,maxZ:(cz+b+1)*S};}
// One light cone per fixture (all at 0; the lit ones follow their PointLight every frame) and the beacons.
function addAtmosphereFixtures(){
  atm.clear({fixtures:true});
  for(const l of roomLights){const ward=!l.box;
    l.cone=atm.addLightCone({x:l.x,z:l.z,y:ward?H-.23:H-.09,radius:ward?1.35:1.4,color:l.color,intensity:0,
      bounds:ward?{minX:l.x-S/2,maxX:l.x+S/2,minZ:l.z-S/2,maxZ:l.z+S/2}:l.box});}
  const cells=[[W-2,W-2],...specialRooms.filter(r=>r.fuse).map(r=>[r.door.x,r.door.z])];
  atmBeacons=cells.map(([cx,cz],i)=>{const p=beaconMount(cx,cz),box=runBox(cx,cz);if(i===0)box.maxX=Math.min(box.maxX,(W-1)*S);
    return atm.addBeacon({x:p.x,y:2.6,z:p.z,bounds:box});});
  atm.prewarm();
}
// Closed isolation doors and the exit gate are metal (blocksRay's boxes plus 10 cm: a hit can sit just in front).
function metalAt(x,z){
  if(!exitOpen&&Math.abs(x-((W-1)*S-.02))<.22&&Math.abs(z-((W-2)*S+S/2))<S/2)return true;
  for(const d of roomDoors)if(!d.open&&Math.abs(x-d.box.x)<d.box.w/2+.1&&Math.abs(z-d.box.z)<d.box.d/2+.1)return true;
  return false;
}
function makeLoot(type,x,z,room){
  // The objective item keeps the loot type 'fuse' on every floor: a fuse on B1, a lift keycard on B2, a key on B3, S1
  // and S2 (S2's crypt keys heavier).
  const shape=type!=='fuse'?[.5,.26,.26,.15,.15]:floor===1?[.38,.05,.25,.05,.45]:floor===2||floor===3?[.54,.09,.13,.06,.45]:floor===4?[.62,.11,.17,.07,.5]:[.24,.55,.26,.3,.15];
  const group=new THREE.Group();group.position.set(x,shape[3],z);dynamicWorld.add(group);
  const color=type==='fuse'?0xe9bd79:type==='medical'?0x81cbb3:0x879dae;
  const box=new THREE.Mesh(new THREE.BoxGeometry(shape[0],shape[1],shape[2]),new THREE.MeshStandardMaterial({color:lin(color),metalness:.45,roughness:.35,emissive:lin(color),emissiveIntensity:shape[4]}));box.userData.own=true;group.add(box);
  const label=worldLabel(type==='fuse'?TEXT().label:type==='medical'?'FIELD DRESSING':'AMMO / WALK OVER','#b5dad0',.9);label.scale.y=.4;label.position.set(0,.6,0);group.add(label);group.userData.label=label;
  return {id:room.id+':'+type,type,x,z,g:group,taken:false,room};
}
// A gun lying on its case where someone dropped it, taken with E. weapon: its index in weaponDefs.
// How each gun lies on its case: [shift along the case, height, case length].
const WEAPON_LIE={pistol:[.05,.2,1.05],smg:[.03,.2,1.05],magnum:[.07,.185,1.05],marksman:[.24,.19,1.35],lmg:[.19,.215,1.3]};
function makeWeaponLoot(index,x,z,room){
  const w=weaponDefs[index],group=new THREE.Group();group.position.set(x,0,z);dynamicWorld.add(group);
  const [shift,lift,length]=WEAPON_LIE[w.id]||[.22,.2,1.05];
  const crate=new THREE.Mesh(new THREE.BoxGeometry(.42,.16,length),new THREE.MeshStandardMaterial({color:lin(0x2d3429),roughness:.72,metalness:.3}));crate.position.y=.08;crate.userData.own=true;group.add(crate);
  const model=HollowVisuals.makeWeapon(THREE,w.id,{world:true});model.userData.decoration=true;
  model.rotation.set(0,0,Math.PI/2);model.position.set(-.04,lift,shift);group.add(model);
  const label=worldLabel(w.name.toUpperCase()+' · [E]','#e7d9a2',1.2);label.scale.y=.4;label.position.set(0,.75,0);group.add(label);group.userData.label=label;
  return {id:room.id+':'+w.id,type:'weapon',weapon:index,x,z,g:group,taken:false,room};
}
// Each floor's guns lie in their rooms, on a clear spot reachable from the door and away from the other pickups.
function placeWeapons(){
  for(const [kind,id] of Object.entries(FLOOR().weapons)){
    const index=weaponDefs.findIndex(w=>w.id===kind),r=specialRooms.find(v=>v.id===id);if(index<0||!r)continue;
    const cx=(r.x+r.w/2)*S,cz=(r.z+r.d/2)*S,[ex,ez]=center(r.door.x,r.door.z),cand=[];let spot=null;
    // Prefer a spot beside the room's centre, toward the back wall; scan the whole floor of the room if furniture is there.
    for(let x=r.x*S+1;x<=(r.x+r.w)*S-1;x+=.5)for(let z=r.z*S+1;z<=(r.z+r.d)*S-1;z+=.5)cand.push([x,z,Math.hypot(x-cx-1.5,z-cz+1)]);
    cand.sort((a,b)=>a[2]-b[2]);
    for(const [x,z] of cand){
      if(!movementClear(x,z,x,z,.6)||roomLoot.some(l=>Math.hypot(l.x-x,l.z-z)<1.4))continue;
      if(mazeNavigator.path(ex,ez,x,z,PR).length){spot={x,z};break;}
    }
    if(spot)roomLoot.push(makeWeaponLoot(index,spot.x,spot.z,r));
  }
}
// Linear decay follows r128's (1-d/13)^2 pools within ~15% from 2 to 10 m without blowing out the ceiling.
const practicalLights=Array.from({length:3},()=>{const l=physical(new THREE.PointLight(0xb4cadd,0,13),4.7,1);dynamicWorld.add(l);scene.add(l);return l;});
const exitTint=lin(0xd09b62);
function refreshRoomLights(){
  const viewer=state==='spect'||state==='pause'&&prevState==='spect'?watched().pos:P.pos;
    const nearest=roomLights.map(l=>({...l,d:Math.hypot(l.x-viewer.x,l.z-viewer.z)})).sort((a,b)=>a.d-b.d);
  for(const f of roomLights)if(f.cone)f.cone.setIntensity(0);
  practicalLights.forEach((l,i)=>{l.userData.cone=null;l.visible=qualityLevel!=='low'||i===0;const info=nearest[i];if(!info||info.d>24||state==='menu'){setLight(l,0);return;}l.color.setHex(info.color,THREE.LinearSRGBColorSpace);l.position.set(info.x,2.85,info.z);setLight(l,(info.shelter?1.45:1.75)*(info.shelter?1:horror.snapshot().lighting));l.userData.cone=info.cone||null;
      if(exitPowered&&!exitOpen&&!info.shelter)l.color.lerp(exitTint,.35);});
  chaosLightsRefreshed(nearest);
}
function currentShelter(){return specialRooms.find(r=>r.shelter&&RULES.insideRoom(r,P.pos.x,P.pos.z));}
function doorAction(d,action){
  if(d.health<=0){showMsg('The lock is destroyed. Find another shelter.',2.5);return;}
  const inside=RULES.insideRoom(d.room,P.pos.x,P.pos.z);
  if(action==='open'){d.open=true;d.locked=false;}
  else if(action==='close'){d.open=false;d.locked=false;}
  else if(action==='lock'){d.open=false;d.locked=true;}
  else if(d.open){d.open=false;d.locked=false;}
  else if(inside&&!d.locked){d.locked=true;}
  else if(d.locked&&inside){d.locked=false;d.open=true;}
  else if(!d.locked){d.open=true;}
  else {showMsg('Locked from inside.',1.7);return;}
  d.revision++;sMetal(0,d.locked?290:420,.16);
  for(const m of monsters)m.repath=0;
  showMsg(d.locked?'Door locked. Crouch and turn your torch off.':d.open?'Door open. Listen before leaving.':'Door closed. Use again from inside to lock.',2.8);
}
function findInteraction(){
  let found=null,best=3.1;
  for(const d of roomDoors){const distance=Math.hypot(P.pos.x-d.box.x,P.pos.z-d.box.z);if(distance<best&&d.health>0){best=distance;found={type:'door',item:d};}}
  for(const l of roomLoot){const distance=Math.hypot(P.pos.x-l.x,P.pos.z-l.z);if(!l.taken&&!automaticLoot(l.type)&&distance<2.2&&distance<best&&los(P.pos.x,P.pos.z,l.x,l.z)){best=distance;found={type:'loot',item:l};}}
  for(const note of caseNotes){const distance=Math.hypot(P.pos.x-note.x,P.pos.z-note.z);if(distance<2.1&&distance<best&&los(P.pos.x,P.pos.z,note.x,note.z)){best=distance;found={type:'record',item:note};}}
    if(Math.hypot(P.pos.x-(W-1)*S,P.pos.z-((W-2)*S+S/2))<3&&!exitPowered)found={type:'exit'};
  return found;
}
function automaticLoot(type){return type==='ammo'||type==='supplies';}
function pickupReach(item,player,radius=1.15){
  return (player.y||0)<.65&&Math.hypot(player.x-item.x,player.z-item.z)<radius&&
    movementClear(player.x,player.z,item.x,item.z,.01);
}
function requestLoot(l){
  if(l.taken||l.pending)return;
  // Guns are each survivor's own find: co-op partners each pick up their own copy, without asking the host.
  if(l.type==='weapon'){collectLoot(l);return;}
  if(NET.inGame&&NET.role==='guest'){if(queueAction({type:'loot',id:l.id}))l.pending=NET.actionSeq;}
  else collectLoot(l);
}
function collectLoot(l){
  if(l.taken)return;
  if(l.type==='fuse'&&(!NET.inGame||NET.role==='host'))alertMonsters(24,l.x,l.z,5);
  if(l.type==='medical'&&P.health>=100){showMsg('Health is full. Save this kit for later.',2);return;}
  if(l.type==='weapon'){l.taken=true;l.g.visible=false;takeWeapon(l.weapon);return;}
  l.taken=true;l.g.visible=false;sPickup(l.type);
  rewardLoot(l.type);
}
function rewardLoot(type){
  if(type==='fuse'){fuses=roomLoot.filter(v=>v.type==='fuse'&&v.taken).length;showMsg(fuses===3?TEXT().all:`${TEXT().kick} recovered · ${fuses}/3.`,3.5);}
  else if(type==='medical'){P.health=Math.min(100,P.health+45);showMsg('Field dressing · +45 health.',2);}
  else if(type==='ammo'){const drop=RULES.AMMO_DROPS.ammo;weaponDefs.forEach((w,i)=>weapons[i].reserve+=drop[w.id]||0);reserve=weapons[weaponIndex].reserve;showMsg(ammoText(drop),3);}
  else {const drop=RULES.AMMO_DROPS.supplies;weaponDefs.forEach((w,i)=>weapons[i].reserve+=drop[w.id]||0);reserve=weapons[weaponIndex].reserve;decoys=Math.min(5,decoys+1);battery=1;showMsg('Supplies secured · ammunition, battery and a decoy.',3);}
  if(automaticLoot(type)&&mag===0&&reserve>0)startReload();
}
// Rounds for a gun not found yet are kept for it: they are in its reserve when it turns up. amounts: by gun id.
function ammoText(amounts){
  const got=weaponDefs.map((w,i)=>owned[i]&&amounts[w.id]?`+${amounts[w.id]} ${WEAPON_ROUNDS[w.id]||w.id}`:'').filter(Boolean).join(' / ');
  return `Ammunition · ${got}.`+(owned.every(Boolean)?'':' Spare rounds packed for guns not found yet.');
}
function queueAction(action){
  if(NET.actions.length>=32){showMsg('Waiting for the host to confirm your actions.',2);return false;}
  NET.actions.push({...action,n:++NET.actionSeq});return true;
}
function interact(){
  if(state!=='play')return;interaction=findInteraction();if(!interaction)return;
  if(interaction.type==='door'){
    const d=interaction.item;
    if(NET.inGame&&NET.role==='guest'){queueAction({type:'door',id:d.id,action:d.open?'close':RULES.insideRoom(d.room,P.pos.x,P.pos.z)&&!d.locked?'lock':'open'});return;}
    doorAction(d);
  }else if(interaction.type==='loot'){
    const l=interaction.item;
    if(l.type==='medical'&&P.health>=100){showMsg('Health is full. Save this kit for later.',2);return;}
    requestLoot(l);
  }else if(interaction.type==='record'){
      const note=interaction.item;readNotes.add(note.id);captionText=note.title+' — '+note.text;captionT=18;sMetal(0,680,.035);
    }else if(fuses<3)showMsg(`${TEXT().locked} Recover ${more(3-fuses)} from marked rooms.`,3);
  else if(NET.inGame&&NET.role==='guest')queueAction({type:'exit'});
  else powerExit();
}
function powerExit(){
  if(fuses<3||exitPowered)return;
  exitPowered=true;exitRelease=FLOOR().release;alarmT=0;sMetal(0,90,.22);
  showMsg(TEXT().powered,5);
  // The cemetery gate is chained to the bell: it calls the Gravekeeper, not the floor.
  if(FLOOR().boss){bossAwaken();return;}
  // The lift and the floodgate below are loud enough to wake most of a floor.
  if(!NET.inGame||NET.role==='host')alertMonsters(100,(W-2)*S+S/2,(W-2)*S+S/2,floor?45:18);
}
function throwDecoy(){
  if(state!=='play'||!decoys)return;decoys--;
  const fx=-Math.sin(P.yaw),fz=-Math.cos(P.yaw);let dist=1;
  for(let d=1;d<11;d+=.25){if(blocksRay(P.pos.x+fx*d,1,P.pos.z+fz*d))break;dist=d;}
  const x=P.pos.x+fx*dist,z=P.pos.z+fz*dist;decoyEvents.push({x,z,remaining:5,pulse:0});
  if(NET.inGame&&NET.role==='guest')queueAction({type:'decoy',x:r2(x),z:r2(z)});
  showMsg(`Noise decoy thrown · ${decoys} remaining. Move away quietly.`,2.5);
}
function updateRooms(dt){
  damageT=Math.max(0,damageT-dt);hitMarkerT=Math.max(0,hitMarkerT-dt);noticeT=Math.max(0,noticeT-dt);
  for(const d of roomDoors){d.angle=lerp(d.angle,d.open?-Math.PI/2:0,1-Math.exp(-dt*10));d.hinge.rotation.y=d.angle;}
  if(exitPowered&&!exitOpen&&!bossHolds()){
    if(!NET.inGame||NET.role==='host'){exitRelease=Math.max(0,exitRelease-dt);if(exitRelease===0){exitOpen=true;showMsg(TEXT().opened,4);}}
    alarmT-=dt;if(alarmT<=0){alarmT=3.2;sWardSound('alarm',(W-2)*S+S/2,(W-2)*S+S/2);if(!NET.inGame||NET.role==='host')alertMonsters(100,(W-2)*S+S/2,(W-2)*S+S/2);}
  }
  const gate=dynamicWorld.userData.gate;if(gate)gate.position.y=lerp(gate.position.y,exitOpen?H*1.5:exitPowered?H/2+.16:H/2,Math.min(1,dt*2));
  if(dynamicWorld.userData.exitSign)dynamicWorld.userData.exitSign.visible=!exitOpen;
  const shelter=currentShelter(),door=shelter&&roomDoors.find(d=>d.room===shelter);
  const concealed=door&&!door.open&&door.locked&&P.crouching&&!torchOn&&!P.running&&!mouseDown;
  hideTime=concealed?hideTime+dt:0;P.hidden=hideTime>1.25;
  for(const l of roomLoot)if(!l.taken){l.g.userData.label.visible=Math.hypot(P.pos.x-l.x,P.pos.z-l.z)<3.2;l.g.userData.label.rotation.y=P.yaw;}
  for(const d of decoyEvents){d.remaining-=dt;d.pulse-=dt;if(d.pulse<=0){d.pulse=1.2;sThud(d.x,.1,d.z,.6,680);if(!NET.inGame||NET.role==='host')alertMonsters(23,d.x,d.z,6);}}
  decoyEvents=decoyEvents.filter(d=>d.remaining>0);
  interactionT-=dt;if(interactionT<=0){interactionT=.1;interaction=findInteraction();refreshRoomLights();}
}

/* ---------- first-person layer: torch, rifle ---------- */
const fpScene=new THREE.Scene();
fpScene.matrixAutoUpdate=false;
const fpRig=new THREE.Group();fpScene.add(fpRig);
const fpHemi=physical(new THREE.HemisphereLight(0xffffff,0x000000,0.5),Math.PI);fpScene.add(fpHemi);
const fpKey=physical(new THREE.DirectionalLight(0xbad1dc,.5),Math.PI);fpKey.position.set(-1,2,1);fpRig.add(fpKey);fpRig.add(fpKey.target);
const fpTorchLight=physical(new THREE.PointLight(0xffe7c4,0,2.5),1,1);fpTorchLight.position.set(-0.1,0.15,0.1);fpRig.add(fpTorchLight);
const fpFlash=physical(new THREE.PointLight(0xffa850,0,2.5),1,1);fpFlash.position.set(0.18,-0.12,-0.75);fpRig.add(fpFlash);
const torch=HollowVisuals.makeFlashlight(THREE);
const lensMat=torch.userData.lensMaterial;
torch.position.set(-0.25,-0.27,-0.44);torch.rotation.set(0.06,-0.07,0);torch.visible=false;fpRig.add(torch);

// Seven distinct, fully modeled weapons share the same first-person rig.
const weaponDefs=RULES.WEAPONS;
// HUD slot labels, the action shown over the rounds, and what an ammunition pickup calls each gun's rounds.
const WEAPON_TAG={rifle:'AR',pistol:'M9',shotgun:'SG',smg:'SMG',magnum:'.44',marksman:'DMR',lmg:'LMG'};
const WEAPON_ACTION={rifle:'AUTOMATIC',pistol:'SEMI-AUTOMATIC',shotgun:'PUMP ACTION',smg:'AUTOMATIC',magnum:'REVOLVER',marksman:'BOLT ACTION',lmg:'BELT FED'};
const WEAPON_ROUNDS={rifle:'carbine',pistol:'sidearm',shotgun:'shells',smg:'SMG',magnum:'.44',marksman:'.308',lmg:'belt'};
const weaponModels=weaponDefs.map(w=>HollowVisuals.makeWeapon(THREE,w.id));
let weaponIndex=0,weapons=weaponDefs.map(w=>({mag:w.capacity,reserve:w.reserve}));
let gun=weaponModels[0],gunMag=gun.userData.magazine,muzzleFlash=gun.userData.muzzleFlash;
const GUN_BASE=new THREE.Vector3(.22,-.24,-.38);
weaponModels.forEach(model=>{model.position.copy(GUN_BASE);model.visible=false;fpRig.add(model);});
fpScene.environment=scene.environment;
// Post-processing (bloom, filmic grade, damage/danger): optional; low quality is the direct render.
let fx=null,fxKill=0,fxFlash=0;
function createPostFX(){
  try{fx=window.HollowPostFX?.create({THREE,TSL:window.TSL,renderer,scene,fpScene,camera,quality:qualityLevel,effects:preferences.effects,motion:preferences.motion})||null;}
  catch(e){console.warn('[The Hollow] post-processing disabled:',e);fx=null;}
}
createPostFX();
// step (Q): walk that way to the next gun carried. Without it the index is taken as given and must be carried.
function selectWeapon(index,step){
  const n=weaponDefs.length;index=(index+n)%n;
  if(step)for(let k=0;k<n&&!owned[index];k++)index=(index+step+n)%n;
  if(!owned[index]||index===weaponIndex)return;
  weapons[weaponIndex].mag=mag;weapons[weaponIndex].reserve=reserve;
  gun.visible=false;weaponIndex=index;gun=weaponModels[index];gunMag=gun.userData.magazine;muzzleFlash=gun.userData.muzzleFlash;
  mag=weapons[index].mag;reserve=weapons[index].reserve;reloadT=0;fireT=.24;gunKick=0;flashT=0;semiFired=false;shotT=9;weaponAudio?.equip(weaponDefs[index].id);
}

/* ---------- impacts ---------- */
const sparkTex=glowTex('rgba(255,240,200,1)','rgba(255,150,40,.6)');
const bloodTex=(()=>{const [c,x]=cv(64,64);for(let i=0;i<14;i++)blot(x,rnd(16,48),rnd(16,48),rnd(6,16),'rgba(90,0,0,.9)');return new THREE.CanvasTexture(c);})();
const puffs=[];
for(let i=0;i<20;i++){const blood=i%2===1;const sp=new THREE.Sprite(new THREE.SpriteMaterial({map:blood?bloodTex:sparkTex,transparent:true,depthWrite:false,blending:blood?THREE.NormalBlending:THREE.AdditiveBlending}));
  sp.visible=false;sp.userData={blood,life:0};scene.add(sp);puffs.push(sp);}
function puff(p,blood){const sp=puffs.find(s=>!s.visible&&s.userData.blood===blood);if(!sp)return;sp.position.copy(p);sp.visible=true;sp.userData.life=blood?0.4:0.09;sp.userData.max=sp.userData.life;sp.scale.setScalar(blood?0.25:0.18);sp.material.opacity=1;}
// dt: real frame time; sdt: hitstop-scaled simulation time (blood hangs in the air with everything else).
function updatePuffs(dt,sdt=dt){for(const sp of puffs){if(!sp.visible)continue;sp.userData.life-=dt;if(sp.userData.life<=0){sp.visible=false;continue;}const k=sp.userData.life/sp.userData.max;sp.material.opacity=k;if(sp.userData.blood){sp.scale.setScalar(0.25+(1-k)*0.35);sp.position.y-=dt*0.3;}}
  gore.setQuality(qualityLevel);gore.setEffects(preferences.effects);
  // Wounds ride their joints: wounded creatures get this frame's pose before the gore follows it.
  for(const m of monsters)if(m.gored&&m.g.visible)m.g.updateMatrixWorld(true);
  gore.update(sdt);
  hurtFX.update(dt);
}

/* ---------- hits: regions, gore, getting hurt ---------- */
// Where a round lands (hitzones.js), what it leaves on the creature and the floor (gore.js: wounds ride the joint group
// they were shot into, everything else lives in world space), and what a creature's blow does to the survivor
// (hurtfx.js: the camera, the legs, the ears and the blood on the screen). Every number comes from the gun's stats.
const HZ=window.HollowHitZones;
const gore=window.HollowGore.create({THREE,scene,quality:qualityLevel,effects:preferences.effects,blocks:blocksRay,floorY:0,ceiling:H});
const hurtFX=window.HollowHurtFX.create({root:$('hud'),document,effects:preferences.effects,motion:preferences.motion});
const _hitRay=new THREE.Raycaster(),_hitList=[],_hitV=new THREE.Vector3(),_hitBack=new THREE.Vector3();
const _meshHit={object:null,point:new THREE.Vector3(),normal:new THREE.Vector3(),distance:0},_hzc={};
let shotStamp=0,lastShot=null,hurtSlowT=0,hurtSlowDur=1,hurtSlowF=1,hurtPulse=1,hurtSeed=0,hurtLast=null;
function shownIn(o,top){for(let p=o;p;p=p.parent){if(!p.visible)return false;if(p===top)return true;}return true;}
// The first visible mesh of creature m along the ray (o, d) within `far`: object, point and outward face normal.
function meshHit(m,o,d,far,out){
  _hitRay.set(o,d);_hitRay.near=0;_hitRay.far=far;_hitRay.camera=camera;_hitList.length=0;
  _hitRay.intersectObject(m.g,true,_hitList);
  for(const h of _hitList){
    if(!h.object.isMesh||!shownIn(h.object,m.g))continue;
    out.object=h.object;out.point.copy(h.point);out.distance=h.distance;
    if(h.face)out.normal.copy(h.face.normal).transformDirection(h.object.matrixWorld);else out.normal.copy(d).negate();
    if(out.normal.dot(d)>0)out.normal.negate();
    _hitList.length=0;return true;
  }
  _hitList.length=0;return false;
}
// The region of a mesh hit: the nearest named joint above it, else the torso split by height in the model's frame.
function meshRegion(m,object,point){
  for(let p=object;p&&p!==m.g;p=p.parent){const r=HZ.jointRegion(p.name);if(r)return r;}
  _hitV.copy(point);m.g.worldToLocal(_hitV);
  return HZ.torsoRegion(m.kind,m.stats,_hitV.y,_hitV.z);
}
// Phase 1 of fire() for one pellet on creature m (cylinder entry `distance`): region, damage, entry and exit points, and
// the creature's running tally for this shot (its simulated health lets later pellets pass through a body this shot
// already killed).
function tracePellet(m,best,distance,wallDistance,w){
  if(m.hitStamp!==shotStamp){
    m.hitStamp=shotStamp;m.g.updateMatrixWorld(true);
    m.shot={hp:m.hp,damage:0,force:0,strength:0,knockX:0,knockZ:0,stagger:0,maxPellet:0,head:false,heavyHead:false,distance,
      tally:{head:0,neck:0,chest:0,gut:0,armL:0,armR:0,legL:0,legR:0},side:0,kill:null,top:null,pellets:0};
  }
  const s=m.shot,rec={m,dir:_d.clone(),origin:_o.clone(),point:_o.clone().addScaledVector(_d,Math.max(0,distance-.04)),normal:_d.clone().negate(),object:null,
    region:'chest',headshot:false,distance,wallDistance,damage:0,exit:null,imp:null,y:best.y};
  if(meshHit(m,_o,_d,wallDistance,_meshHit)){
    rec.object=_meshHit.object;rec.point.copy(_meshHit.point);rec.normal.copy(_meshHit.normal);rec.distance=_meshHit.distance;
    rec.region=meshRegion(m,_meshHit.object,_meshHit.point);
  }else if(m.dormant)rec.region=HZ.layRegion(m.kind,best.lay,(_d.x*Math.cos(m.yaw)-_d.z*Math.sin(m.yaw))<0?-1:1);
  else{
    const g=m.g;
    rec.region=HZ.classify({kind:m.kind,stats:m.stats,x:m.pos.x,z:m.pos.z,yaw:m.yaw,ox:_o.x,oy:_o.y,oz:_o.z,dx:_d.x,dy:_d.y,dz:_d.z,
      pose:{x:g.position.x,y:g.position.y,z:g.position.z,pitch:g.rotation.x,yaw:g.rotation.y,roll:g.rotation.z}},_hzc);
  }
  // A body on the floor is never a headshot (the old rule for sleepers).
  if(m.dormant&&(rec.region==='head'||rec.region==='neck'))rec.region='chest';
  rec.headshot=rec.region==='head';
  rec.damage=HZ.damage(w,rec.region,distance,m.kind,m.stats);
  rec.imp=HZ.impact(w,{region:rec.region,dealt:rec.damage,distance,kind:m.kind,stats:m.stats},{});
  // Exit wound: back along the shot from beyond the body, the last surface the round leaves through.
  if(rec.imp.exit>0&&rec.object){
    const span=m.stats.radius*2+1.4;_hitV.copy(rec.point).addScaledVector(_d,span);_hitBack.copy(_d).negate();
    if(meshHit(m,_hitV,_hitBack,span,_meshHit)&&span-_meshHit.distance>.03)rec.exit={point:_meshHit.point.clone(),normal:_meshHit.normal.clone(),object:_meshHit.object};
  }
  s.hp-=rec.damage;s.damage+=rec.damage;s.tally[rec.region]+=rec.damage;s.force+=rec.imp.force;s.strength+=rec.imp.strength;s.pellets++;
  const h=Math.hypot(_d.x,_d.z)||1;s.knockX+=_d.x/h*rec.imp.knock;s.knockZ+=_d.z/h*rec.imp.knock;
  s.stagger=Math.max(s.stagger,rec.imp.stagger);s.maxPellet=Math.max(s.maxPellet,rec.damage);s.distance=Math.min(s.distance,distance);
  if(rec.headshot){s.head=true;if(rec.damage>=1.5)s.heavyHead=true;}
  s.side+=(rec.region==='armL'||rec.region==='legL'?-1:rec.region==='armR'||rec.region==='legR'?1:0);
  if(!s.top||rec.damage>s.top.damage)s.top=rec;
  if(s.hp<=0&&!s.kill)s.kill=rec;
  return rec;
}
// Phase 2 for one pellet: the wound, its exit and spray, back-spatter, the bleed it adds, the flesh sound.
// k: the pellet's place in the shot (a blast's pellets share their mist).
function playPellet(rec,w,k){
  const m=rec.m,imp=rec.imp,d=rec.dir,p=rec.point,spread=w.pellets>1;
  if(!atm)puff(p,true);else if(!spread||k%2===0)atm.blood(p.x,p.y,p.z,{dir:d,amount:spread?.45:Math.min(1.5,.6+.35*imp.blood)});
  if(rec.object){gore.wound(m,{root:m.g,object:rec.object,point:p,normal:rec.normal,size:imp.wound});m.gored=true;}
  // Back-spatter toward the shooter (a blast's pellets share it).
  if(!spread||k%3===0)gore.spray(p.x,p.y,p.z,-d.x,.25-d.y*.3,-d.z,{amount:.1+.1*imp.blood,reach:.45+.15*imp.force,cone:.55});
  if(imp.exit>0){
    const e=rec.exit,q=e?e.point:p;
    if(e){gore.wound(m,{root:m.g,object:e.object,point:q,normal:e.normal,kind:'exit',size:imp.exit});m.gored=true;}
    gore.spray(q.x,q.y,q.z,d.x,d.y+.05,d.z,{amount:Math.min(4,.6+imp.blood*1.2),reach:imp.reach,cone:.2});
    // Where the round's path meets the wall within the spray's reach: the blowout stain, bigger and darker close up.
    const gap=rec.wallDistance-rec.distance;
    if(rec.wallDistance<48&&gap<imp.reach+.4){
      const at=rec.wallDistance-.03,x=rec.origin.x+d.x*at,y=rec.origin.y+d.y*at,z=rec.origin.z+d.z*at;
      if(y>.08&&y<H-.08){
        const alongX=blocksRay(x+Math.sign(d.x)*.1,y,z),alongZ=blocksRay(x,y,z+Math.sign(d.z)*.1);
        const nx=alongX&&(!alongZ||Math.abs(d.x)>=Math.abs(d.z))?-Math.sign(d.x):0,nz=nx?0:-Math.sign(d.z)||1;
        const size=(.3+.14*Math.min(3,imp.blood))*Math.max(.5,Math.min(1.25,1.25-.6*gap/imp.reach));
        gore.wallSplat(x+nx*.025,y,z+nz*.025,nx,nz,size);
      }
    }
  }
  gore.bleed(m,m.g,Math.min(.7,.08+imp.blood*.14));
  dopaShotHit(m,rec.headshot,rec.distance);
  audioBullet(rec.point,rec,rec.distance,rec.wallDistance,imp);
}
// What a shot did to one creature as a whole: hitMonster with the region detail, then the kill's gore.
function strikeMonster(m,w,guest){
  const s=m.shot,lead=s.kill||s.top,d=lead.dir,killed=s.hp<=0;
  // Anything animated as another kind (a boss on a Warden's rig) resists flinching by its own mass.
  const resist=m.anim.kind===m.kind?1:Math.min(1,HZ.mass(m.kind,m.stats)/HZ.mass(m.anim.kind));
  const tally={...s.tally,force:s.force,distance:s.distance,killed,kind:m.kind,stats:m.stats,maxPellet:s.maxPellet,side:s.side};
  let v=HZ.verdict(w,tally,{});
  // The body reacts where the shot did the most harm (a blast to the legs buckles them even if one pellet strays higher);
  // the direction is the killing or heaviest pellet's.
  const legs=s.tally.legL+s.tally.legR,kneel=v.kneel&&!m.dormant,region=v.region;
  const info={region,side:s.side<0?-1:1,dirX:d.x,dirZ:d.z,stagger:s.stagger,knockX:s.knockX,knockZ:s.knockZ,
    kneel,kneelSide:v.kneelSide,kneelTime:Math.min(2.4,1+.4*legs),deathForce:v.deathForce,gib:v.gib};
  const strength=Math.min(2,s.strength)*resist;
  m.hitRegion=region;m.lastHit={damage:s.damage,region,pellets:s.pellets,strength};
  if(guest){
    const k=monsters.indexOf(m);NET.dm[k]=(NET.dm[k]||0)+s.damage;m.stagger=Math.max(.2,s.stagger);
    m.anim.hit({dirX:d.x,dirZ:d.z,yaw:m.yaw,headshot:s.head,region,strength,side:info.side,kneel,kneelSide:v.kneelSide,kneelTime:info.kneelTime});
    return {v,killed:false};
  }
  hitMonster(m,s.damage,null,s.head,strength,info);
  if(m.dead!==killed){tally.killed=m.dead;v=HZ.verdict(w,tally,{});}
  if(m.dead)goreKill(m,v,lead);
  return {v,killed:m.dead};
}
function goreKill(m,v,lead){
  const u=m.g.userData,d=lead.dir,p=lead.point,f=v.deathForce,prof=HZ.profile(m.kind,m.stats);
  m.gored=true;
  if(v.gib&&u.head)gore.decapitate(m,m.g,u.head,{dir:d,force:1+f*.6,chunks:Math.max(6,v.chunks)});
  else if(v.jaw&&u.jaw)gore.sever(m,m.g,u.jaw,{dir:d,force:.5+f*.4});
  if(v.sever&&u[v.sever])gore.sever(m,m.g,u[v.sever],{dir:d,force:1+f});
  if(v.chunks>0&&!v.gib)gore.chunks(p.x,p.y,p.z,d.x,d.y+.25,d.z,{count:v.chunks,speed:1.6+f,bone:.15});
  gore.bleed(m,m.g,1.2);
  gore.pool(m,m.g,{local:{x:0,y:prof.quad?prof.hip*.8:prof.hip,z:0},size:Math.min(1.4,.55+prof.radius*1.1),delay:m.dormant?.2:1.1,grow:6+3*Math.min(1,f)});
}
// Knockback and kneeling between frames (host and solo: guests take positions from the host).
function hitsStep(dt){
  if(NET.inGame&&NET.role!=='host')return;
  for(const m of monsters){
    if(m.dead||m.dormant){m.knockVX=m.knockVZ=0;m.kneelT=0;continue;}
    m.hitHeat=Math.max(0,(m.hitHeat||0)-dt*1.5);
    if(m.kneelT>0){
      // Down on one knee: it stays where it dropped, cannot strike or lunge until it is up.
      m.kneelT=Math.max(0,m.kneelT-dt);m.pos.x=m.kneelX;m.pos.z=m.kneelZ;m.g.userData.speed=0;
      m.lungeBoost=0;m.attackT=Math.max(m.attackT,.15);m.stagger=Math.max(m.stagger,.1);
    }
    const vx=m.knockVX||0,vz=m.knockVZ||0;
    if(vx*vx+vz*vz<1e-4){m.knockVX=m.knockVZ=0;continue;}
    m.pos.x+=vx*dt;m.pos.z+=vz*dt;resolve(m.pos,m.stats.radius);
    if(m.kneelT>0){m.kneelX=m.pos.x;m.kneelZ=m.pos.z;}
    const k=Math.exp(-dt*5);m.knockVX=vx*k;m.knockVZ=vz*k;
  }
}
function clearHits(m){gore.clear(m);m.gored=false;m.knockVX=m.knockVZ=0;m.kneelT=0;m.hitHeat=0;m.hitRegion=null;m.lastHit=null;}
// A new run, floor or co-op round: every creature's gore and the floors' blood go, and the survivor's hurt wears off.
function hitsReset(){gore.clear();for(const m of monsters)clearHits(m);hurtFX.clear();hurtSlowT=0;hurtPulse=1;hurtLast=null;lastShot=null;}
function hitsSummary(m){const a=m.anim.snapshot();return {region:m.hitRegion||null,heat:m.hitHeat||0,kneeling:(m.kneelT||0)>0,knock:Math.hypot(m.knockVX||0,m.knockVZ||0),
  last:m.lastHit||null,wounds:gore.woundsOf(m),gibbed:gore.headless(m),severed:gore.severed(m),
  anim:{heat:a.heat,kneeling:a.kneeling,kneel:a.kneel,limpL:a.limpL,limpR:a.limpR,fold:a.fold,deathForce:a.deathForce,gib:a.gib,region:a.region}};}
// QA: turns the survivor (where they stand) toward a visible point of creature m's `part` (a hitzones.js region, or
// 'torso' / 'leg' / 'arm' for either), one the shot's own tests would score as that part. Returns the point or null.
function aimAtPart(m,part){
  const u=m.g.userData,zone=r=>part==='torso'?r==='chest'||r==='gut':part==='leg'?r==='legL'||r==='legR':part==='arm'?r==='armL'||r==='armR':r===part;
  m.g.updateMatrixWorld(true);
  const eye=new THREE.Vector3(P.pos.x,P.pos.y+P.eye,P.pos.z),pts=[],dir=new THREE.Vector3(),v=new THREE.Vector3();
  const joints=part==='head'?[u.head]:part==='neck'?[u.neck]:part==='leg'?[u.legL,u.legR]:part==='arm'?[u.armL,u.armR]:u[part]&&part!=='torso'?[u[part]]:[m.g];
  for(const j of joints)if(j)j.traverse(o=>{if(!o.isMesh||!shownIn(o,m.g)||!o.geometry.attributes.position)return;const pos=o.geometry.attributes.position,step=Math.max(1,Math.floor(pos.count/60));
    for(let i=0;i<pos.count;i+=step){v.fromBufferAttribute(pos,i).applyMatrix4(o.matrixWorld);pts.push(v.clone());}});
  if(!pts.length)return null;
  const c=pts.reduce((a,b)=>a.add(b),new THREE.Vector3()).multiplyScalar(1/pts.length);
  // Central points first, nudged toward the middle of the part so the round lands inside it rather than grazing it.
  pts.sort((a,b)=>a.distanceToSquared(c)-b.distanceToSquared(c));
  for(const q of pts){
    const target=q.clone().lerp(c,.35);dir.copy(target).sub(eye).normalize();
    const ox=eye.x-m.pos.x,oz=eye.z-m.pos.z,a=dir.x*dir.x+dir.z*dir.z,b=2*(ox*dir.x+oz*dir.z),cc=ox*ox+oz*oz-m.stats.radius*m.stats.radius,disc=b*b-4*a*cc;
    if(a<1e-5||disc<0)continue;
    const at=(-b-Math.sqrt(disc))/(2*a),y=eye.y+dir.y*at;
    if(at<0||y<.06||y>m.stats.height)continue;
    if(!meshHit(m,eye,dir,60,_meshHit)||!zone(meshRegion(m,_meshHit.object,_meshHit.point)))continue;
    P.yaw=Math.atan2(-dir.x,-dir.z);P.pitch=Math.asin(Math.max(-1,Math.min(1,dir.y)));
    return {x:_meshHit.point.x,y:_meshHit.point.y,z:_meshHit.point.z,region:meshRegion(m,_meshHit.object,_meshHit.point)};
  }
  return null;
}

// A creature's blow that leaves the survivor standing: the view punched away from it and dropping as the legs buckle,
// the legs dragging, the ears ringing and dulled, blood thrown across the screen.
function hurtHit(m){
  const bearing=HollowHUDFX.bearing(P.pos.x,P.pos.z,P.yaw,m.pos.x,m.pos.z);
  const p=HollowHurtFX.plan({damage:m.stats.damage,health:P.health,max:100,bearing,kind:m.kind,effects:preferences.effects,motion:preferences.motion,seed:++hurtSeed});
  camFX.punch(p.jolt.x,p.jolt.y);camFX.addTrauma(p.jolt.trauma);camFX.land(p.jolt.stagger);
  hurtSlowT=hurtSlowDur=p.slow.time;hurtSlowF=p.slow.factor;hurtPulse=.7+.45*p.severity;
  hurtFX.setOptions({effects:preferences.effects,motion:preferences.motion});hurtFX.hit(p);
  audioHurt(p);
  hurtLast={kind:m.kind,style:p.style,severity:p.severity,heavy:p.heavy,jolt:p.jolt,slow:p.slow,ring:p.ring,muffle:p.muffle,splats:p.blood.splats.length,at:simulationTime};
}
// The survivor's speed multiplier while a blow still drags at the legs (held at its worst, then easing back).
function hurtSlow(dt){
  if(hurtSlowT<=0)return 1;
  hurtSlowT=Math.max(0,hurtSlowT-dt);
  return 1-(1-hurtSlowF)*Math.min(1,hurtSlowT/hurtSlowDur*1.5);
}

/* ---------- monster ---------- */
function makeMonster(kind){return HollowVisuals.makeMonster(THREE,kind);}
// Slots [0, active) of a floor hunt from the start; the next `sleepers` slots lie on the floor until disturbed.
const MAX_MON=20;let monCount=8;
const MONSTER_ORDER=['warden','stalker','crawler','shrieker','stalker','crawler','warden','shrieker','crawler','stalker','warden','shrieker',
  'crawler','stalker','crawler','stalker','shrieker','crawler','stalker','crawler'];
const monsters=[];
for(let i=0;i<MAX_MON;i++){const kind=MONSTER_ORDER[i],g=makeMonster(kind);g.visible=false;scene.add(g);
  monsters.push({g,kind,stats:RULES.MONSTERS[kind],pos:new THREE.Vector3(),yaw:0,state:'wander',path:[],repath:0,lastSeen:new THREE.Vector3(),lost:0,searchT:0,stepT:rnd(0,0.6),spotCD:0,hp:RULES.MONSTERS[kind].hp,dead:true,deadT:0,stagger:0,voiceT:rnd(2,6),stalkT:0,watchT:0,flank:i%2?1:-1,lungeT:0,lungeCD:0,lungeBoost:0,attackT:0,screamT:0,senseT:0,seenTarget:null,anim:HollowMonsterAnim.create(kind,{seed:i}),animYaw:0,watched:false,
    dormant:false,sleep:0,rate:0,rouser:null,wakeIn:-1,riseT:0,stirred:false,lay:[0,0,0,0,0,0],layR:.36});}

/* ---------- state ---------- */
const keys={};
const P={pos:new THREE.Vector3(),vel:new THREE.Vector3(),velY:0,onGround:true,yaw:-Math.PI/2,pitch:0,stamina:1,exhausted:false,running:false,sprint:0,strafe:0,moving:false,health:100,crouching:false,eye:EYE,hidden:false,noise:0,groundY:0,jumpBuffer:0,coyote:0,slide:0};
let aiming=false,semiFired=false,fireQueued=false,crouchHeld=false,sprintHeld=false,slideT=0,mapExpanded=false;
// CoD-style camera rig: pose is visual only (never moves P.pos). camIn is reused every frame.
const camFX=window.HollowCameraFX.create({seed:1337});
const camIn={speed:0,walkSpeed:PL.walk,runSpeed:PL.run,running:false,crouching:false,aiming:false,onGround:true,sliding:false,strafe:0,lookDX:0,lookDY:0,stamina:1,exhausted:false,danger:0,health:100,motion:true};
let camPrevYaw=0,camPrevPitch=0;
const touchMove={x:0,y:0};
let state='menu',prevState='menu',torchOn=false,battery=1,elapsed=0,t=0,grace=0,danger=0,caughtT=0,ambientT=12,msgTimer=0;
let aiFrozen=false;   // QA only (HollowTest.freezeAI): monsters hold still for deterministic fixtures
const MAG=30;let mag=MAG,reserve=weaponDefs[0].reserve,fireT=0,reloadT=0,mouseDown=false,gunKick=0,flashT=0,gunOut=false,nearestD=99,caughtBy=null,stingerCD=0,mapT=0;
let visited=new Uint8Array(W*W),ammoBoxes=[];

// The ward's look: the dark hemisphere/fog, the torch on and the rifle out.
function setHell(){
  dynamicWorld.visible=true;
  applyEnv([ENV.hell,ENV.morgue,ENV.hollow,ENV.garden,ENV.graveyard][floor]||ENV.hell);document.body.dataset.floor=FLOOR().code;setOutdoor(!!FLOOR().outdoor);
  canvas.style.filter='none';$('grain').style.opacity=preferences.effects?.027:0;$('vignette').style.opacity=.6;
  torchOn=true;torch.visible=false;gunOut=true;gun.visible=true;
}
// count: creatures awake on arrival (slots [0,count)); sleepers: bodies on the floor in the slots after them.
function spawnMonsters(count,sleepers=0){
  count=Math.min(MAX_MON,count||8);
  const df=distField(3,2);let max=0;for(const v of df)if(v>max)max=v;
  const cand=[];for(let z=0;z<W;z++)for(let x=0;x<W;x++){const v=df[z*W+x];if(v>Math.min(22,max*.3)&&x<W-1&&!specialRooms.some(r=>r.shelter&&RULES.insideRoom(r,x*S+S/2,z*S+S/2)))cand.push([x,z]);}
  for(let i=cand.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[cand[i],cand[j]]=[cand[j],cand[i]];}
  const chosen=[];
  for(const c of cand){if(chosen.every(o=>Math.abs(o[0]-c[0])+Math.abs(o[1]-c[1])>7))chosen.push(c);if(chosen.length===count)break;}
  while(chosen.length<count)chosen.push(cand[Math.floor(Math.random()*cand.length)]);
  monsters.forEach((m,i)=>{if(i>=count){m.dead=true;m.spawned=false;m.dormant=false;m.g.visible=false;return;}const [wx,wz]=center(chosen[i][0],chosen[i][1]);resetMonster(m,wx,wz,Math.random()*Math.PI*2);});
  monCount=count+layBodies(count,Math.min(MAX_MON-count,sleepers),df);
}
function resetMonster(m,x,z,yaw){
  m.spawned=true;m.pos.set(x,0,z);m.yaw=yaw;m.state='wander';m.path=[];m.repath=0;m.lost=0;m.spotCD=0;m.hp=m.stats.hp;m.dead=false;m.deadT=0;m.stagger=0;m.attackT=0;m.screamT=0;m.senseT=0;m.seenTarget=null;m.heardTarget=null;
  m.voiceT=rnd(2,6);m.stepT=rnd(.2,.8);m.stalkT=0;m.watchT=0;m.lungeT=0;m.lungeCD=0;m.lungeBoost=0;m.watched=false;m.anim.reset();m.animYaw=m.yaw;
  m.dormant=false;m.sleep=0;m.rate=0;m.rouser=null;m.wakeIn=-1;m.riseT=0;m.shotDmg=0;clearHits(m);
  m.g.position.copy(m.pos);m.g.rotation.set(0,m.yaw,0);m.g.visible=true;m.g.userData.speed=0;m.g.userData.eyeMat.color.setHex(m.g.userData.eyeColor||0xff2a14);
}
// Sleepers lie along corridor walls and between the furniture, mostly well away from the lobby, never in a refuge and
// never on top of a pickup; morgue rooms take a few more. Returns how many bodies found a place, in slots from `first`.
function layBodies(first,n,df){
  if(n<=0)return 0;
  const cells=[];
  for(let z=1;z<W-1;z++)for(let x=1;x<W-2;x++){
    if(!openCell(x,z)||df[z*W+x]<=7)continue;
    const [wx,wz]=center(x,z);if(Math.hypot(wx-PED.x,wz-PED.z)<18)continue;
    const room=specialRooms.find(r=>RULES.insideRoom(r,wx,wz))||null;if(room&&room.shelter)continue;
    cells.push({x,z,wx,wz,room,rank:room&&room.type==='morgue'?0:1,r:Math.random()});
  }
  cells.sort((a,b)=>a.rank-b.rank||a.r-b.r);
  const used=[],near=(x,z)=>roomLoot.some(l=>Math.hypot(l.x-x,l.z-z)<3)||ammoBoxes.some(b=>Math.hypot(b.x-x,b.z-z)<2.4);
  let ci=0,placed=0;
  for(let i=first;i<first+n;i++){
    const m=monsters[i];let ok=false;
    while(!ok&&ci<cells.length){
      const c=cells[ci++];
      if(used.some(o=>Math.abs(o.x-c.x)+Math.abs(o.z-c.z)<(c.room&&o.room===c.room?2:3)))continue;
      if(c.room&&used.filter(o=>o.room===c.room).length>=(c.room.type==='morgue'?4:2))continue;
      const walls=[[1,0],[-1,0],[0,1],[0,-1]].filter(([dx,dz])=>cellWall(c.x+dx,c.z+dz));
      let x=c.wx+rnd(-.6,.6),z=c.wz+rnd(-.6,.6),yaw=Math.random()*Math.PI*2;
      if(walls.length){const [dx,dz]=walls[Math.floor(Math.random()*walls.length)];x=c.wx+dx*.8;z=c.wz+dz*.8;yaw=(dx?0:Math.PI/2)+rnd(-.2,.2);}
      if(near(x,z)||!movementClear(x,z,x,z,m.stats.radius))continue;
      for(const turn of [0,Math.PI]){
        resetMonster(m,x,z,yaw+turn);layDown(m,i);
        if([0,2,4].every(k=>movementClear(m.lay[k],m.lay[k+1],m.lay[k],m.lay[k+1],.18))){ok=true;break;}
      }
    }
    if(!ok){m.dead=true;m.spawned=false;m.dormant=false;m.g.visible=false;break;}
    used.push(cells[ci-1]);placed++;
  }
  for(let i=first+placed;i<MAX_MON;i++){const m=monsters[i];m.dead=true;m.spawned=false;m.dormant=false;m.g.visible=false;}
  return placed;
}
const LAY_IN={speed:0,state:'wander',lunge:0,stagger:0,turn:0,watched:false,effects:false,dead:true};
// Puts a creature on the floor as if it had died there (falling forward or back by slot, so co-op peers agree), eyes
// dark. lay: three points along the body, for shots, contact and the torch.
function layDown(m,slot){
  m.dormant=true;m.state='sleep';m.sleep=0;m.rate=0;m.rouser=null;m.wakeIn=-1;m.riseT=0;m.stirred=false;m.senseT=Math.random()*.1;m.voiceT=rnd(3,10);
  m.g.userData.eyeMat.color.set(0x120000);m.g.userData.speed=0;
  const f=slot%2?1:-1;
  m.anim.reset();m.anim.die({dirX:Math.sin(m.yaw)*f,dirZ:Math.cos(m.yaw)*f,yaw:m.yaw});
  for(let k=0;k<45;k++)m.anim.update(.1,LAY_IN);
  HollowMonsterAnim.apply(m.g,m.anim.pose,m.pos.x,m.pos.z,m.yaw);
  const g=m.g,sx=Math.sin(g.rotation.y),sz=Math.cos(g.rotation.y),quad=m.kind==='crawler';
  const dir=quad?1:Math.sin(g.rotation.x)<0?-1:1,h=m.stats.height;
  m.lay=(quad?[-.4,0,.4]:[.18*h,.45*h,.72*h]).flatMap(a=>[g.position.x+sx*a*dir,g.position.z+sz*a*dir]);
  m.layR=quad?.45:.36;
}
function layDistance(m,x,z){const l=m.lay;return Math.min(Math.hypot(l[0]-x,l[1]-z),Math.hypot(l[2]-x,l[3]-z),Math.hypot(l[4]-x,l[5]-z));}
function hideMonsters(){monsters.forEach(m=>{m.g.visible=false;m.spawned=false;m.dead=true;m.dormant=false;m.riseT=0;m.wakeIn=-1;});stopAudio(state==='dead');}
// A kit is everything the survivor carries between floors: health, the guns found so far and their rounds, decoys and
// the torch battery. A new run gets the starting kit: full health and the sidearm alone.
// The M9 sidearm never runs dry: reloads always refill it and its reserve is never spent.
const infiniteAmmo=()=>weaponDefs[weaponIndex].id==='pistol';
function freshKit(){
  const has=weaponDefs.map(w=>RULES.STARTING_WEAPONS.includes(w.id));
  return {health:100,owned:has,weapons:weaponDefs.map((w,i)=>has[i]?{mag:w.capacity,reserve:w.reserve}:{mag:0,reserve:0}),weapon:Math.max(0,has.indexOf(true)),decoys:3,battery:1};
}
function currentKit(){
  weapons[weaponIndex]={mag,reserve};
  return {health:Math.max(1,P.health),owned:owned.slice(),weapons:weapons.map(w=>({mag:w.mag,reserve:w.reserve})),weapon:weaponIndex,decoys,battery};
}
function resetSurvivor(kit){
  kit=kit||freshKit();
  stopAudio();
  P.health=kit.health;P.crouching=false;P.eye=EYE;P.hidden=false;P.noise=0;P.groundY=0;P.jumpBuffer=0;P.coyote=0;slideT=0;LOCO.reset();P.sprint=0;P.strafe=0;if(atm)atm.clear();fxKill=fxFlash=0;damageT=0;stingerCD=0;aiming=false;semiFired=false;crouchHeld=false;sprintHeld=false;touchMove.x=touchMove.y=0;
  for(const k in keys)keys[k]=false;
  weaponModels.forEach(g=>g.visible=false);owned=kit.owned.slice();weapons=kit.weapons.map(w=>({mag:w.mag,reserve:w.reserve}));weaponIndex=owned[kit.weapon]?kit.weapon:Math.max(0,owned.indexOf(true));
  gun=weaponModels[weaponIndex];gunMag=gun.userData.magazine;muzzleFlash=gun.userData.muzzleFlash;decoys=kit.decoys;battery=kit.battery;
  mag=weapons[weaponIndex].mag;reserve=weapons[weaponIndex].reserve;reloadT=0;fireT=.3;gunKick=0;mouseDown=false;fireQueued=false;flashT=0;hitMarkerT=0;setLight(muzzleLight,0);setLight(fpFlash,0);
  stowOwnedWeapons();
}
// A gun the survivor already carries is not lying on this floor (one not found yet stays until it is).
function stowOwnedWeapons(){for(const l of roomLoot)if(l.type==='weapon'){const has=!!owned[l.weapon];l.taken=has;l.g.visible=!has;}}
function takeWeapon(index){
  const w=weaponDefs[index];if(!w)return;
  weapons[weaponIndex]={mag,reserve};owned[index]=true;
  weapons[index]={mag:w.capacity,reserve:weapons[index].reserve+w.reserve};
  if(index!==weaponIndex)selectWeapon(index);else{mag=weapons[index].mag;reserve=weapons[index].reserve;}
  playStinger('pickup','weapon');
  hud.banner('NEW WEAPON',{tone:'objective',kicker:w.name,duration:2.6});
  showMsg(`${w.name} · ${weapons[index].mag} loaded, ${weapons[index].reserve} spare. ${index+1} or Q switches weapons.`,3.4);
}
function newGame(){
  if(NET.g)leaveRoom();NET.inGame=false;rigLights(false);runToken++;
  // A dark run started from the title reuses the world the menu prebuilt and warmed (warmPlayPipelines): always B1.
  floor=0;scoreBase={points:0,kills:0};elapsed=0;
  if(!prebuiltSeed){worldSeed=1+Math.floor(Math.random()*2e9);buildMazeSeeded(worldSeed);}
  prebuiltSeed=0;startFloor(freshKit());
  if(droneGain)droneGain.gain.value=0.07;
}
// Everything after a floor's world is built: the kit, the survivor at the lobby pedestal, the creatures, a checkpoint.
function startFloor(kit){
  resetSurvivor(kit);
  P.vel.set(0,0,0);P.velY=0;P.onGround=true;P.stamina=1;P.exhausted=false;camFX.reset();hitsReset();
  danger=0;ambientT=14;$('flash').style.opacity=0;sleepHint=false;wakeBannerT=wakeStingT=howlAt=-99;
  visited=new Uint8Array(W*W);
  setHell();P.pos.set(PED.x-.85,0,PED.z);P.yaw=Math.PI/2;P.pitch=0;spawnMonsters(FLOOR().active,FLOOR().sleepers);grace=10;state='play';
  setupBoss();checkpointBanner=!!FLOOR().outdoor;
  checkpoint={floor,kit:copyKit(kit),elapsed,score:{...scoreBase}};
  if(floor>0)saveCampaign();
  if(scoreBase.points>0)hud.score(scoreBase.points);
  showMsg(TEXT().intro,floor?7:6);
}
// Builds floor `index` with a new layout and carries `kit` onto it (descending, a retry, Continue, QA).
function enterFloor(index,kit,seed){
  floor=Math.max(0,Math.min(RULES.FLOORS.length-1,index|0));
  worldSeed=seed||1+Math.floor(Math.random()*2e9);buildMazeSeeded(worldSeed);
  startFloor(kit);
}
function copyKit(k){return {health:k.health,owned:k.owned.slice(),weapons:k.weapons.map(w=>({mag:w.mag,reserve:w.reserve})),weapon:k.weapon,decoys:k.decoys,battery:k.battery};}
// The score of the whole run: floors already cleared plus this floor's streak.
function runScore(){const own=streak.snapshot();return {kills:scoreBase.kills+own.kills,points:scoreBase.points+own.points};}
// Between floors: a black title card. It paints before the build holds the main thread, then stays up long enough to
// read (CARD_MS in all, and CARD_AFTER_MS past the build, while the new floor's first frames render behind it).
const CARD_MS=1600,CARD_AFTER_MS=700;
function transition(code,name,note,build){
  state='descend';releaseInput();stopAudio();
  $('descendCode').textContent=code;$('descendName').textContent=name;$('descendNote').textContent=note;
  $('descendWay').textContent=RULES.FLOORS.find(f=>f.code===code)?.outdoor?'Above ground':'Going down';
  showScreen('descend');const shown=performance.now();
  const run=()=>{
    if(state!=='descend')return;
    // A menu warm-up still compiling the old world (Continue right after loading) stops at its next step: wait for it.
    if(warming){setTimeout(run,50);return;}
    try{build();}catch(e){console.error('[The Hollow] Floor build failed:',e);openMenu();return;}
    state='descend';
    setTimeout(()=>{if(state!=='descend')return;state='play';if(document.hidden){pause();return;}showScreen(null);if(document.pointerLockElement!==canvas)lock();},
      Math.max(CARD_AFTER_MS,CARD_MS-(performance.now()-shown)));
  };
  setTimeout(run,90);
}
function descend(){
  if(state!=='play'||NET.inGame||floor>=RULES.FLOORS.length-1)return;
  scoreBase=runScore();const kit=currentKit(),next=RULES.FLOORS[floor+1],from=FLOOR().exit;
  sThud(P.pos.x,1,P.pos.z,.7,50);
  const way=!next.outdoor?`Down through the ${from}.`:FLOOR().outdoor?`Through the ${from}, into the churchyard.`:`Up through the ${from}, into the open air.`;
  transition(next.code,next.name,`${way} Everything you carry comes with you.`,()=>enterFloor(floor+1,kit));
}
// Death below B1 goes back to the start of the floor with what the survivor carried down.
function retryFloor(c){
  if(NET.g)leaveRoom();NET.inGame=false;rigLights(false);runToken++;
  floor=c.floor;scoreBase={...c.score};elapsed=c.elapsed;const f=FLOOR();
  transition(f.code,f.name,'Back to the start of the floor, with what you carried down.',()=>enterFloor(c.floor,copyKit(c.kit)));
}
const LS_CAMPAIGN='hollow.campaign';
function saveCampaign(){
  if(!checkpoint||!checkpoint.floor)return;
  try{localStorage.setItem(LS_CAMPAIGN,JSON.stringify({v:1,floor:checkpoint.floor,kit:checkpoint.kit,elapsed:checkpoint.elapsed,score:checkpoint.score,at:Date.now()}));}catch(e){}
}
function clearCampaign(){try{localStorage.removeItem(LS_CAMPAIGN);}catch(e){}checkpoint=null;}
// The saved checkpoint, checked field by field: it comes back from storage.
function savedCampaign(){
  let s=null;try{s=JSON.parse(localStorage.getItem(LS_CAMPAIGN)||'null');}catch(e){return null;}
  if(!s||typeof s!=='object'||!s.kit||typeof s.kit!=='object')return null;
  const fl=Math.floor(finiteNumber(s.floor,0,0,RULES.FLOORS.length-1));if(!fl)return null;
  const k=s.kit,has=weaponDefs.map((w,i)=>!!(Array.isArray(k.owned)&&k.owned[i])||RULES.STARTING_WEAPONS.includes(w.id));
  const kit={health:finiteNumber(k.health,100,1,100),owned:has,
    weapons:weaponDefs.map((w,i)=>{const v=Array.isArray(k.weapons)&&k.weapons[i]||{};return {mag:Math.floor(finiteNumber(v.mag,0,0,w.capacity)),reserve:Math.floor(finiteNumber(v.reserve,0,0,999))};}),
    weapon:Math.floor(finiteNumber(k.weapon,1,0,weaponDefs.length-1)),decoys:Math.floor(finiteNumber(k.decoys,3,0,5)),battery:finiteNumber(k.battery,1,0,1)};
  const score=s.score&&typeof s.score==='object'?s.score:{};
  return {floor:fl,kit,elapsed:finiteNumber(s.elapsed,0,0,7200),score:{points:Math.floor(finiteNumber(score.points,0,0,1e6)),kills:Math.floor(finiteNumber(score.kills,0,0,999))}};
}
function updateContinue(){
  const b=$('continueBtn'),s=savedCampaign();if(!b)return;
  b.hidden=!s;if(s)b.textContent=`Continue · ${RULES.FLOORS[s.floor].code} ${RULES.FLOORS[s.floor].name}`;
}

/* ---------- audio ---------- */
let AC=null,master,hurtLP=null,hurtOut=null,noiseBuf,creatureAudio=null,playerAudio=null,weaponAudio=null,droneFilter,droneGain=null;
function initAudio(){
  if(AC){if(AC.state==='suspended')AC.resume();return;}
  try{AC=new (window.AudioContext||window.webkitAudioContext)();}catch(e){AC=null;return;}
  master=AC.createGain();master.gain.value=preferences.volume;hurtOut=masterOut();hurtLP=AC.createBiquadFilter();hurtLP.type='lowpass';hurtLP.frequency.value=22000;hurtLP.Q.value=.5;master.connect(hurtLP);hurtLP.connect(hurtOut);
  noiseBuf=AC.createBuffer(1,AC.sampleRate*2,AC.sampleRate);const d=noiseBuf.getChannelData(0);for(let i=0;i<d.length;i++)d[i]=Math.random()*2-1;
  // horror drone
  droneFilter=AC.createBiquadFilter();droneFilter.type='lowpass';droneFilter.frequency.value=110;
  droneGain=AC.createGain();droneGain.gain.value=0;droneFilter.connect(droneGain);droneGain.connect(master);
  [36.7,37.1,55.2].forEach(f=>{const o=AC.createOscillator();o.type='sawtooth';o.frequency.value=f;o.connect(droneFilter);o.start();});
  const air=noiseSrc(true),af=AC.createBiquadFilter();af.type='bandpass';af.frequency.value=260;af.Q.value=0.7;
  const ag=AC.createGain();ag.gain.value=0.25;air.connect(af);af.connect(ag);ag.connect(droneGain);air.start();
  creatureAudio=HollowAudio.create({context:AC,output:master,noiseBuffer:noiseBuf});
  playerAudio=HollowPlayerAudio.create({context:AC,output:bodyOut(),noiseBuffer:noiseBuf});
  weaponAudio=HollowWeaponAudio.create({context:AC,output:master,noiseBuffer:noiseBuf});
}
function noiseSrc(loop){const s=AC.createBufferSource();s.buffer=noiseBuf;s.loop=!!loop;return s;}
function makePanner(ref,roll){const p=AC.createPanner();p.panningModel='HRTF';p.distanceModel='exponential';p.refDistance=ref||2;p.rolloffFactor=roll||1.3;p.maxDistance=60;p.connect(master);return p;}
function setPos(p,x,y,z){if(p.positionX){p.positionX.value=x;p.positionY.value=y;p.positionZ.value=z;}else p.setPosition(x,y,z);}
const _fw=new THREE.Vector3();
function updateListener(){
  if(!AC)return;const L=AC.listener;camera.getWorldDirection(_fw);const c=camera.position;
  if(L.positionX){L.positionX.value=c.x;L.positionY.value=c.y;L.positionZ.value=c.z;L.forwardX.value=_fw.x;L.forwardY.value=_fw.y;L.forwardZ.value=_fw.z;L.upX.value=0;L.upY.value=1;L.upZ.value=0;}
  else{L.setPosition(c.x,c.y,c.z);L.setOrientation(_fw.x,_fw.y,_fw.z,0,1,0);}
}
function env(g,now,a,peak,dec){g.gain.setValueAtTime(0.0001,now);g.gain.exponentialRampToValueAtTime(peak,now+a);g.gain.exponentialRampToValueAtTime(0.0001,now+a+dec);}
function fadeTo(g,v,time){if(!AC)return;const n=AC.currentTime;g.gain.cancelScheduledValues(n);g.gain.setValueAtTime(g.gain.value,n);g.gain.linearRampToValueAtTime(v,n+time);}
function sStep(vol,kind){
  if(!AC)return;const n=AC.currentTime,s=noiseSrc(),f=AC.createBiquadFilter(),g=AC.createGain();
  f.type='lowpass';f.frequency.value=kind==='carpet'||kind==='grass'?rnd(250,380):rnd(380,700);
  s.connect(f);f.connect(g);g.connect(master);env(g,n,0.006,vol,0.13);s.start(n,Math.random());s.stop(n+0.2);
  if(kind==='metal'&&Math.random()<0.5){const o=AC.createOscillator(),og=AC.createGain();o.type='triangle';o.frequency.value=rnd(380,520);o.connect(og);og.connect(master);env(og,n,0.002,vol*0.08,0.25);o.start(n);o.stop(n+0.3);}
}
function sThud(x,y,z,vol,freq){
  if(!AC)return;const n=AC.currentTime,p=makePanner(2.2,1.2);setPos(p,x,y,z);
  const s=noiseSrc(),f=AC.createBiquadFilter(),g=AC.createGain();f.type='lowpass';f.frequency.value=freq||200;s.connect(f);f.connect(g);g.connect(p);env(g,n,0.01,vol,0.28);s.start(n,Math.random());s.stop(n+0.4);
  const o=AC.createOscillator(),og=AC.createGain();o.frequency.setValueAtTime(70,n);o.frequency.exponentialRampToValueAtTime(35,n+0.25);o.connect(og);og.connect(p);env(og,n,0.01,vol*0.8,0.3);o.start(n);o.stop(n+0.4);
}
function sCreature(m,cue,volume=1){
  const kind=m.voiceKind||m.kind,id=sVoice(kind,cue,m.pos.x,cue==='step'?.15:m.stats.head,m.pos.z,cue==='step'?volume*(STEP_LEVEL[kind]||1):volume);
  if(id!=null)vox(m).said[cue]=t;
  return id;
}
function updateMonsterAudio(m,dt,moved){
  m.voiceT-=dt;
  monsterVoice(m,dt);
}
// Creature footsteps, driven by the monster animation's foot plants (pose.footstep / pose.stepIntensity).
// sCreature applies I2's per-kind step weighting (STEP_LEVEL). I2: may refine the step volumes here.
function onMonsterFootstep(m,intensity){
  sCreature(m,'step',(m.state==='stalk'?.3:1)*(.45+.55*intensity));
  if((m.kind==='warden'||m.boss)&&state==='play'){const d=Math.hypot(P.pos.x-m.pos.x,P.pos.z-m.pos.z),r=m.boss?16:9;if(d<r)camFX.addTrauma((m.boss?.2:.12)*(1-d/r));}
}
function sClick(){if(!AC)return;const n=AC.currentTime,o=AC.createOscillator(),g=AC.createGain();o.type='square';o.frequency.value=2400;o.connect(g);g.connect(master);env(g,n,0.002,0.06,0.03);o.start(n);o.stop(n+0.05);}
function sMetal(at,f,v){if(!AC)return;const n=AC.currentTime+at,o=AC.createOscillator(),g=AC.createGain();o.type='triangle';o.frequency.value=f;o.connect(g);g.connect(master);env(g,n,0.002,v,0.09);o.start(n);o.stop(n+0.15);
  const s=noiseSrc(),hf=AC.createBiquadFilter(),hg=AC.createGain();hf.type='highpass';hf.frequency.value=2500;s.connect(hf);hf.connect(hg);hg.connect(master);env(hg,n,0.001,v*0.8,0.04);s.start(n,Math.random());s.stop(n+0.08);}

function sWardSound(kind,x,z){
  if(!AC||preferences.volume===0)return;
  const now=AC.currentTime,p=makePanner(kind==='alarm'?5:3,.85);setPos(p,x,kind==='breath'?2.8:.8,z);
  const sources=[],nodes=[p],muffled=!los(P.pos.x,P.pos.z,x,z);
  const voice=(offset,frequency,duration,volume,noise)=>{
    const source=noise?noiseSrc(true):AC.createOscillator(),filter=AC.createBiquadFilter(),gain=AC.createGain();
    filter.type=noise?'bandpass':'lowpass';filter.frequency.value=muffled?Math.min(650,frequency):frequency;filter.Q.value=noise?1.7:.7;
    if(!noise){source.type='sine';source.frequency.setValueAtTime(frequency,now+offset);source.frequency.exponentialRampToValueAtTime(Math.max(30,frequency*.68),now+offset+duration);}
    source.connect(filter);filter.connect(gain);gain.connect(p);env(gain,now+offset,kind==='breath'?.45:.015,volume,duration);
    source.start(now+offset);source.stop(now+offset+duration+.5);sources.push(source);nodes.push(source,filter,gain);
  };
  if(kind==='steps'){for(let i=0;i<4;i++)voice(i*.68,130-i*9,.21,.26,true);}
  else if(kind==='pipe'||kind==='relay'){for(let i=0;i<(kind==='relay'?1:3);i++)voice(i*.41,kind==='relay'?180:410+i*39,.55,.16,false);}
  else if(kind==='alarm'){voice(0,510,.48,.19,false);voice(.65,390,.55,.16,false);}
  else if(kind==='scrape'){voice(0,1200,1.8,.14,true);voice(.18,172,1.3,.04,false);}
  else voice(0,830,2.2,preferences.effects?.13:.04,true);
  // Disconnect the whole transient graph when its final scheduled source ends.
  sources[sources.length-1].onended=()=>nodes.forEach(node=>node.disconnect());
}
// The ward's unseen noises, as they carry above ground (S1, S2).
const OUTDOOR_CAPTIONS=[
  {steps:'[Footsteps on the gravel, beyond the hedge.]',scrape:'[Something drags itself through the borders.]',pipe:'[A gate creaks somewhere in the dark.]',breath:'[Breathing, on the other side of the hedge.]',relay:'[A key turns. Something in the borders stirs.]'},
  {steps:'[Footsteps between the graves.]',scrape:'[Stone scrapes on stone, somewhere behind the wall.]',pipe:'[The bell rope creaks.]',breath:'[Breathing, under the ground.]',relay:'[A key turns. Something under the graves stirs.]'}];
function updateHorror(dt){
  captionT=Math.max(0,captionT-dt);if(captionT===0)captionText='';
  const events=horror.update(dt,{active:state==='play',threat:danger,sheltered:!!currentShelter(),fuses,powered:exitPowered,effects:preferences.effects});
  for(const event of events){
    const x=P.pos.x+Math.cos(event.bearing||P.yaw)*(event.distance||3),z=P.pos.z+Math.sin(event.bearing||P.yaw)*(event.distance||3);
    sWardSound(event.kind,x,z);
    if(captionT<=0){captionText=outdoorNow&&OUTDOOR_CAPTIONS[FLOOR().boss?1:0][event.kind]||event.caption;captionT=5;}
  }
}
function sAmbient(){
  if(!AC)return;const n=AC.currentTime,a=Math.random()*Math.PI*2,r=rnd(8,18);
  const x=P.pos.x+Math.cos(a)*r,z=P.pos.z+Math.sin(a)*r,kind=Math.random();
  if(kind<0.35){for(let k=0;k<3;k++)setTimeout(()=>sThud(x,1.5,z,0.35,500),k*rnd(260,420));}
  else if(kind<0.7){const p=makePanner(3,1);setPos(p,x,2,z);const o=AC.createOscillator(),f=AC.createBiquadFilter(),g=AC.createGain();
    o.type='sawtooth';o.frequency.setValueAtTime(rnd(90,140),n);o.frequency.linearRampToValueAtTime(rnd(60,110),n+2.5);f.type='bandpass';f.frequency.value=700;f.Q.value=6;
    o.connect(f);f.connect(g);g.connect(p);g.gain.setValueAtTime(0.0001,n);g.gain.exponentialRampToValueAtTime(0.25,n+0.8);g.gain.exponentialRampToValueAtTime(0.0001,n+2.6);o.start(n);o.stop(n+2.7);}
  else{const p=makePanner(1.5,1.2);setPos(p,x,1.6,z);const s=noiseSrc(),f=AC.createBiquadFilter(),g=AC.createGain();f.type='bandpass';f.frequency.value=2800;f.Q.value=5;
    s.connect(f);f.connect(g);g.connect(p);g.gain.setValueAtTime(0.0001,n);for(let k=0;k<10;k++)g.gain.linearRampToValueAtTime(rnd(0.02,0.14),n+0.12+k*0.14);g.gain.linearRampToValueAtTime(0.0001,n+1.7);s.start(n);s.stop(n+1.8);}
}

/* ---------- input ---------- */
addEventListener('keydown',e=>{
  if(e.target&&['INPUT','TEXTAREA','SELECT','BUTTON'].includes(e.target.tagName))return;
  if(state==='play'&&['AltLeft','AltRight','Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','ControlLeft','ControlRight'].includes(e.code))e.preventDefault();
  keys[e.code]=true;
  if(!e.repeat){
    const actions={KeyF:'torch',KeyR:'reload',KeyE:'interact',KeyQ:'weapon',KeyV:'decoy',KeyM:'map',Space:'jump',Escape:'pause'};
    if(actions[e.code])inputAction(actions[e.code],true);
    if(state==='play'&&/^Digit[1-9]$/.test(e.code)&&Number(e.code.slice(-1))<=weaponDefs.length){const i=Number(e.code.slice(-1))-1;if(owned[i])selectWeapon(i);else showMsg(`No ${weaponDefs[i].name} yet. Guns lie where their owners fell.`,2.2);}
    if(['KeyC','ControlLeft','ControlRight'].includes(e.code))inputAction('crouch',true);
    if(state==='spect'&&(e.code==='Space'||e.code==='Tab')){e.preventDefault();cycleSpect();}
  }
},{passive:false});
addEventListener('keyup',e=>{if(e.code==='AltLeft'||e.code==='AltRight')e.preventDefault();keys[e.code]=false;if(['KeyC','ControlLeft','ControlRight'].includes(e.code))inputAction('crouch',false);},{passive:false});
function look(dx,dy){if(state!=='play')return;const touch=controls?controls.touch:IS_TOUCH;const sensitivity=(touch?3.4/Math.max(320,innerWidth):.0022)*preferences.sensitivity*(aiming?.62:1);P.yaw-=dx*sensitivity;P.pitch=Math.max(-1.35,Math.min(1.35,P.pitch-dy*sensitivity));}
addEventListener('mousemove',e=>{
  if(state!=='play'||document.pointerLockElement!==canvas)return;
  look(e.movementX,e.movementY);
});
addEventListener('mousedown',e=>{if(state==='play'&&document.pointerLockElement===canvas){if(e.button===0)inputAction('fire',true);if(e.button===2)inputAction('aim',true);}});
addEventListener('mouseup',e=>{if(e.button===0)inputAction('fire',false);if(e.button===2)inputAction('aim',false);});
canvas.addEventListener('contextmenu',e=>e.preventDefault());
function inputAction(action,pressed){
  if(action==='pause'&&pressed){if(state==='pause')resume();else if(['play','spect'].includes(state)){pause();try{document.exitPointerLock();}catch(e){}}return;}
  if(state!=='play'&&pressed)return;
  if(action==='fire'){mouseDown=pressed;if(pressed){semiFired=false;fireQueued=true;}}
  if(action==='aim')aiming=pressed;
  if(action==='sprint')sprintHeld=pressed;
  if(action==='crouch'){if(pressed&&P.onGround&&LOCO.slide()){slideT=LOCO.state.slideT;P.crouching=true;P.stamina=LOCO.state.stamina;}crouchHeld=pressed;}
  if(!pressed)return;
  if(action==='jump')P.jumpBuffer=.16;
  if(action==='torch'&&state==='play'){if(battery>.01){torchOn=!torchOn;sClick();}else showMsg('Battery depleted. Leave the torch off to recharge.',2);}
  if(action==='reload'&&state==='play')startReload();
  if(action==='weapon'&&state==='play')selectWeapon(weaponIndex+1,1);
  if(action==='interact')interact();
  if(action==='decoy')throwDecoy();
  if(action==='map'){mapExpanded=!mapExpanded;$('map').classList.toggle('expanded',mapExpanded);mapT=0;}
}
const controls=window.HollowControls?HollowControls.create({canvas,onAction:inputAction,onLook:look,onMove:(x,y)=>{touchMove.x=x;touchMove.y=y;}}):null;
function lock(){if(controls?controls.touch:IS_TOUCH)return;try{const r=canvas.requestPointerLock();if(r&&r.catch)r.catch(()=>showMsg('Click the game to capture the mouse.',2));}catch(e){}}
function showScreen(id){renderRequested=true;['name','menu','pause','dead','win','coop','coopEnd','descend'].forEach(s=>$(s).hidden=s!==id);$('hud').hidden=!(id===null&&state==='play');
  // A button that closed its own screen keeps focus until the browser's next focus fix-up (a whole frame on slow GPUs),
  // and the key handler ignores buttons: release it now so the next key reaches the game.
  const f=document.activeElement;if(f&&f!==document.body&&f.closest('[hidden]')&&f.blur)f.blur();}
function resume(){initAudio();state=prevState;showScreen(null);lock();resumeAudio();}

$('startDarkBtn')?.addEventListener('click',()=>{initAudio();newGame();showScreen(null);lock();});
$('changeName').addEventListener('click',()=>openNameScreen());
$('winCopy').addEventListener('click',()=>copyCode($('winCode'),$('winCopy')));
$('menuCopy').addEventListener('click',()=>copyCode($('menuCode'),$('menuCopy')));
$('importForm').addEventListener('submit',async e=>{e.preventDefault();
  const msg=$('importMsg'),r=decodeResult($('importCode').value);
  if(!r){msg.textContent='That code isn’t valid. Ask the player to copy it again, all of it.';return;}
  const id='n_'+fnv(r.name.toLowerCase())+(r.mode==='coop'?'_coop':'');
  const cur=sharedRows&&sharedRows.find(x=>x.uid===id&&x.mode===r.mode);
  if(cur&&compareRuns(cur,r)<=0){msg.textContent=`${r.name} already has a better run on the board (${runSummary(cur)}).`;return;}
  try{await scoresCol.doc(id).set({name:r.name,time:r.time,kills:r.kills,score:r.score,mode:r.mode,partner:r.partner,escaped:r.escaped,at:r.at,uid:id,imported:true});
    msg.textContent=`Added ${r.name} — ${runSummary(r)}.`;$('importCode').value='';}
  catch(err){msg.textContent='The board didn’t accept it. Try again in a moment.';}});
$('nameForm').addEventListener('submit',e=>{e.preventDefault();
  const v=$('playerName').value.replace(/\s+/g,' ').trim();
  if(v.length<2){$('nameErr').textContent='Use at least 2 characters.';$('playerName').focus();return;}
  setName(v.slice(0,18));$('nameErr').textContent='';openMenu();});
$('resumeBtn')?.addEventListener('click',resume);
$('pauseMenuBtn')?.addEventListener('click',async()=>{if(NET.g)await leaveRoom();hideMonsters();gunOut=false;weaponModels.forEach(g=>g.visible=false);torch.visible=false;openMenu();});
$('retryDark').addEventListener('click',e=>{e.stopPropagation();initAudio();if(checkpoint&&checkpoint.floor){retryFloor(checkpoint);lock();return;}newGame();showScreen(null);lock();});
$('continueBtn').addEventListener('click',()=>{
  const s=savedCampaign();if(!s){updateContinue();return;}
  initAudio();retryFloor({floor:s.floor,kit:s.kit,elapsed:s.elapsed,score:s.score});lock();
});
$('deadMenuBtn').addEventListener('click',async e=>{e.stopPropagation();if(NET.g)await leaveRoom();hideMonsters();gunOut=false;weaponModels.forEach(g=>g.visible=false);torch.visible=false;openMenu();});
$('againBtn').addEventListener('click',()=>{initAudio();newGame();showScreen(null);lock();});
$('menuBtn').addEventListener('click',()=>openMenu());
canvas.addEventListener('click',()=>{if(state==='play'&&document.pointerLockElement!==canvas)lock();});
document.addEventListener('pointerlockchange',()=>{if(!(controls?controls.touch:IS_TOUCH)&&document.pointerLockElement!==canvas&&state==='play')pause();});
function releaseInput(){for(const k in keys)keys[k]=false;mouseDown=false;fireQueued=false;aiming=false;crouchHeld=false;sprintHeld=false;touchMove.x=touchMove.y=0;P.jumpBuffer=0;P.running=false;}
addEventListener('blur',()=>{if(state==='play')pause();releaseInput();});
document.addEventListener('visibilitychange',()=>{if(document.hidden){if(state==='play')pause();releaseInput();}});
function pause(){if(state==='pause')return;audioPause();prevState=state;state='pause';releaseInput();$('pauseLede').textContent=NET.inGame?(partners().length>1?'Your partners’ game continues. Shelter before pausing.':'Your partner’s game continues. Shelter before pausing.'):'Take a breath. The world is paused.';showScreen('pause');if(document.pointerLockElement)try{document.exitPointerLock();}catch(e){}}
addEventListener('resize',()=>{renderRequested=true;renderer.setSize(innerWidth,innerHeight);camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();});
// A lost GPU device (WebGPU) or WebGL context pauses play; the renderer is rebuilt on the same canvas once the
// device is back, because WebGPURenderer cannot restore a lost backend itself.
let graphicsDown=false;
function graphicsLost(){if(graphicsDown)return;graphicsDown=true;if(['play','spect'].includes(state))pause();showMsg('Graphics paused. Waiting for your device to restore the display.',6);}
// Replaces three's default handler (a console error, then no more renders): the game pauses and recovers instead.
function watchDevice(r){r.onDeviceLost=info=>{r._isDeviceLost=true;if(r!==renderer)return;console.warn('[The Hollow] Graphics device lost:',info&&info.message);graphicsLost();if(info&&info.api==='WebGPU')restoreGraphics();};}
async function restoreGraphics(){
  if(!graphicsDown||typeof window.HollowCreateRenderer!=='function')return;
  const old=renderer;
  try{
    const next=await window.HollowCreateRenderer({forceWebGL:!old.backend.isWebGPUBackend});
    renderer=window.HollowRenderer=next;window.HollowBackend=next.backend.isWebGPUBackend?'webgpu':'webgl2';
    configureRenderer();watchDevice(next);graphicsDown=false;renderRequested=true;
    if(fx){try{fx.dispose();}catch(e){}createPostFX();}if(atm)atm.prewarm();
    // A restored WebGL context is shared with the new renderer and the old objects died with it: only a lost
    // WebGPU device is released explicitly.
    old.setAnimationLoop(null);if(old.backend.isWebGPUBackend)old.dispose().catch(()=>{});
    showMsg('Display restored. Resume when ready.',4);
  }catch(error){console.warn('[The Hollow] Graphics could not be restored:',error);showMsg('The display could not be restored. Reload the page to continue.',8);}
}
watchDevice(renderer);
canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();graphicsLost();});
canvas.addEventListener('webglcontextrestored',()=>{restoreGraphics();});
// scale: an auto-quality render scale; without it (a settings change, or startup) auto starts again from the top rung.
function applyQuality(level,scale){
  if(!Object.prototype.hasOwnProperty.call(qualityProfiles,level))return;renderRequested=true;const profile=qualityProfiles[level];renderScale=scale||profile.ratio;
  renderer.setPixelRatio(Math.min(devicePixelRatio||1,renderScale));
  if(!scale)autoBest=0;autoMs=autoFrames=0;autoSettle=1.5;
  if(scale&&level===qualityLevel)return;
  qualityLevel=level;wardDetail.value=level==='high'?2:level==='medium'?1:0;
  // Shadow settings are part of the renderer's pipeline cache key: materials need no manual rebuild.
  renderer.shadowMap.enabled=profile.shadows;
  if(atm)atm.setQuality(level);
  if(fx){fx.setQuality(level);if(!fx.enabled){$('grain').style.opacity=preferences.effects?.027:0;$('vignette').style.opacity=.6;}}
  muzzleLight.visible=level!=='low';practicalLights.forEach((light,i)=>light.visible=level!=='low'||i===0);
  spot.shadow.mapSize.set(profile.shadowSize,profile.shadowSize);
  for(const world of [scene,fpScene])world.traverse(o=>{if(o.isMesh){const mats=Array.isArray(o.material)?o.material:[o.material];mats.forEach(m=>{for(const map of [m.map,m.normalMap,m.roughnessMap,m.userData?.transitionMap])if(map){const aniso=level==='low'?1:4;if(map.anisotropy!==aniso){map.anisotropy=aniso;map.needsUpdate=true;}}});}});
}
// Auto quality: average the real frame time over ~2 s of play (hitches capped at 100 ms; the start of play and each
// change are skipped while pipelines compile). Over 21 ms (under ~48 FPS) step down a rung, two when under 25 FPS,
// skipping rungs that look the same on this display; under 12 ms step back up, never onto a rung that was too slow.
function autoQuality(rawDt){
  if(preferences.quality!=='auto'||state!=='play'||document.hidden||!(rawDt>0)){autoMs=autoFrames=0;autoSettle=3;return;}
  if(autoSettle>0){autoSettle-=Math.min(rawDt,.1);return;}
  autoMs+=Math.min(rawDt*1000,100);autoFrames++;
  if(autoMs<2000||autoFrames<10)return;
  const avg=autoMs/autoFrames;autoMs=autoFrames=0;
  const at=AUTO_RUNGS.findIndex(r=>r[0]===qualityLevel&&r[1]===renderScale);if(at<0)return;
  const dpr=devicePixelRatio||1,looks=i=>AUTO_RUNGS[i][0]+Math.min(dpr,AUTO_RUNGS[i][1]);
  const next=(i,d)=>{let j=i+d;while(j>=0&&j<AUTO_RUNGS.length&&looks(j)===looks(i))j+=d;return j>=0&&j<AUTO_RUNGS.length?j:i;};
  let to=at;
  if(avg>21){autoBest=Math.max(autoBest,next(at,1));to=next(at,1);if(avg>40)to=next(to,1);}
  else if(avg<12){const up=next(at,-1);if(up>=autoBest)to=up;}
  if(to===at)return;
  applyQuality(AUTO_RUNGS[to][0],AUTO_RUNGS[to][1]);try{localStorage.setItem('hollow.autoRung',String(to));}catch(e){}
}
for(const [id,key] of [['settingsQuality','quality'],['settingsSensitivity','sensitivity'],['settingsVolume','volume'],['settingsMotion','motion'],['settingsEffects','effects']]){
  const el=$(id);if(!el)continue;if(el.type==='checkbox')el.checked=preferences[key];else el.value=preferences[key];
  el.addEventListener('input',()=>{preferences[key]=el.type==='checkbox'?el.checked:key==='quality'?el.value:Number(el.value);try{localStorage.setItem('hollow.settings',JSON.stringify(preferences));}catch(e){}
    if(key==='quality'){try{localStorage.removeItem('hollow.autoRung');}catch(e){}applyQuality(preferences.quality==='auto'?(IS_TOUCH?'low':'high'):preferences.quality);}
    if(key==='volume'&&master)master.gain.value=preferences.volume;
    if((key==='effects'||key==='motion')&&fx)fx.setOptions({effects:preferences.effects,motion:preferences.motion});
    if(key==='effects'&&atm)atm.setPreferences({effects:preferences.effects});
        if(key==='effects'){renderRequested=true;$('grain').style.opacity=preferences.effects?.027:0;if(!preferences.effects){if(creatureAudio)creatureAudio.stop();$('flash').style.opacity=0;setLight(spot,torchOn?3.6:0);weaponModels.forEach(g=>g.userData.muzzleFlash.visible=false);setLight(muzzleLight,0);setLight(fpFlash,0);RIGS.forEach(o=>setLight(o.flash,0));}refreshRoomLights();}
  });
}
function showMsg(text,dur){const m=$('msg');m.textContent=text;m.style.opacity=1;msgTimer=dur||3.2;}
function flashDanger(){danger=Math.max(danger,.6);}

/* ---------- player ---------- */
function groundHeight(x,z,y){
  let ground=0;
  for(const p of roomProps)if(Math.abs(x-p.x)<p.w/2+PR*.45&&Math.abs(z-p.z)<p.d/2+PR*.45&&y>=p.h-.2)ground=Math.max(ground,p.h);
  return ground;
}
function updatePlayer(dt){
  if(keys.ArrowLeft)P.yaw+=1.9*dt;if(keys.ArrowRight)P.yaw-=1.9*dt;
  if(keys.ArrowUp)P.pitch=Math.min(1.35,P.pitch+1.2*dt);if(keys.ArrowDown)P.pitch=Math.max(-1.35,P.pitch-1.2*dt);
  let ix=(keys.KeyD?1:0)-(keys.KeyA?1:0)+touchMove.x,iz=(keys.KeyW?1:0)-(keys.KeyS?1:0)+touchMove.y;
  const inputLength=Math.hypot(ix,iz);if(inputLength>1){ix/=inputLength;iz/=inputLength;}
  const mv=LOCO.update(dt,{forward:iz,strafe:ix,sprint:sprintHeld||keys.AltLeft||keys.AltRight||keys.ShiftLeft||keys.ShiftRight,crouch:crouchHeld,aiming,onGround:P.onGround});
  slideT=mv.slideT;P.crouching=mv.crouching;P.running=mv.running;P.stamina=mv.stamina;P.exhausted=mv.exhausted;P.sprint=mv.sprint;P.strafe=ix;
  P.eye=lerp(P.eye,P.crouching?1.0:EYE,1-Math.exp(-dt*12));
  P.moving=Math.hypot(ix,iz)>.08||slideT>0;
  P.jumpBuffer=Math.max(0,P.jumpBuffer-dt);
  P.coyote=P.onGround?.1:Math.max(0,P.coyote-dt);
  if(P.jumpBuffer>0&&P.coyote>0&&LOCO.jump()){
    // A small vault assist clears waist-high furniture without raising every jump.
        const vault=roomProps.some(p=>p.h>.8&&p.h<=1.1&&Math.abs(P.pos.x-p.x)<p.w/2+PR+.18&&Math.abs(P.pos.z-p.z)<p.d/2+PR+.18);
        P.velY=vault?5.65:5.15;P.onGround=false;P.coyote=0;P.jumpBuffer=0;P.stamina=mv.stamina;sStep(.1,stepKind());
  }
  const speed=mv.speed*(weaponDefs[weaponIndex].move||1)*hurtSlow(dt);
  const fx=-Math.sin(P.yaw),fz=-Math.cos(P.yaw),rx=Math.cos(P.yaw),rz=-Math.sin(P.yaw);
  if(slideT>0&&inputLength<.1)iz=1;
  const tx=(fx*iz+rx*ix)*speed,tz=(fz*iz+rz*ix)*speed;
  const k=1-Math.exp(-(P.onGround?(P.moving?13:18):2.5)*dt);
  P.vel.x=lerp(P.vel.x,tx,k);P.vel.z=lerp(P.vel.z,tz,k);
  const substeps=Math.max(1,Math.ceil(dt/.012)),h=dt/substeps;
  for(let i=0;i<substeps;i++){
    const oldY=P.pos.y;P.velY-=14*h;P.pos.y+=P.velY*h;
    movePlayer(P.vel.x*h,P.vel.z*h);
    const ground=groundHeight(P.pos.x,P.pos.z,Math.max(P.pos.y,oldY));
    if(P.pos.y<=ground&&!P.onGround&&P.velY<-6)playerAudio?.land(Math.min(1,(-P.velY-5)/6));
    if(P.pos.y<=ground){
      if(!P.onGround&&P.velY<-1){camFX.land(-P.velY);sStep(Math.min(.4,-P.velY*.035),stepKind());}
      P.pos.y=ground;P.groundY=ground;P.velY=0;P.onGround=true;
    }else P.onGround=false;
    if(P.pos.x>0&&P.pos.x<W*S&&P.pos.z>0&&P.pos.z<W*S&&P.pos.y+P.eye+.16>H){
      P.pos.y=H-P.eye-.16;P.velY=Math.min(0,P.velY);
    }
  }
  P.noise=mouseDown&&mag>0?1:mv.noise;
}
function stepKind(){if(outdoorNow)return specialRooms.some(r=>HollowVisuals.OUTDOOR_LOOKS?.[r.look]?.clad&&RULES.insideRoom(r,P.pos.x,P.pos.z))?'wood':'grass';return specialRooms.some(r=>r.type==='lounge'&&RULES.insideRoom(r,P.pos.x,P.pos.z))?'carpet':'metal';}
// One camera-rig step per frame (loop and HollowTest.advance). Footsteps follow the rig's plant events.
function updateCameraRig(dt){
  let dy=P.yaw-camPrevYaw;dy-=Math.round(dy/(2*Math.PI))*2*Math.PI;
  const dp=P.pitch-camPrevPitch;camPrevYaw=P.yaw;camPrevPitch=P.pitch;
  const live=state==='play';
  camIn.speed=Math.hypot(P.vel.x,P.vel.z);camIn.running=live&&P.running;camIn.crouching=P.crouching;
  camIn.aiming=aiming&&!reloadT;camIn.onGround=P.onGround;camIn.sliding=live&&slideT>0;camIn.strafe=live?P.strafe:0;
  camIn.lookDX=dy;camIn.lookDY=dp;camIn.stamina=P.stamina;camIn.exhausted=P.exhausted;
  camIn.danger=state==='play'?danger:0;camIn.health=state==='play'||state==='caught'?P.health:100;camIn.motion=preferences.motion;
  const pose=camFX.update(dt,camIn);
  if(pose.footstep&&live)sStep(.01+.29*pose.stepIntensity,stepKind());
  return pose;
}

function angLerp(a,b,k){if(!Number.isFinite(a))a=0;if(!Number.isFinite(b))return a;const tau=Math.PI*2,d=((b-a+Math.PI)%tau+tau)%tau-Math.PI;return a+d*k;}

/* ---------- monster AI (several of them) ---------- */
function monsterSees(m,tg){
  if(grace>0||tg.hidden)return false;
  const dx=tg.x-m.pos.x,dz=tg.z-m.pos.z,d=Math.hypot(dx,dz);
  if(d>27)return false;
  if(!sightLine(m.pos.x,m.stats.height*.82,m.pos.z,tg.x,(tg.y||0)+(tg.crouching?1:EYE),tg.z))return false;
  if(d<(tg.crouching?1.15:1.9))return true;
  const front=(Math.sin(m.yaw)*dx+Math.cos(m.yaw)*dz)/d;
  const range=tg.torch?24:m.stats.vision*(tg.crouching?.48:1);
  if(front>Math.cos(m.kind==='shrieker'?1.35:1.05)&&d<range)return true;
  if(tg.torch&&d<19){const cfx=-Math.sin(tg.yaw),cfz=-Math.cos(tg.yaw);if((cfx*-dx+cfz*-dz)/d>Math.cos(.42))return true;}
  return false;
}
function localInDanger(){return state==='play'||(NET.inGame&&state==='pause'&&prevState==='play');}
function targets(){
  const out=[];
  if(localInDanger())out.push({x:P.pos.x,z:P.pos.z,y:P.pos.y,yaw:P.yaw,pitch:P.pitch,torch:torchOn,running:P.running,crouching:P.crouching,moving:P.moving,hidden:P.hidden,local:true});
  if(NET.inGame&&NET.role==='host')for(const R of REMOTES.values())if(liveRemote(R))out.push({x:R.raw.x,z:R.raw.z,y:R.raw.y||0,yaw:R.raw.yaw,pitch:R.raw.pitch,torch:R.raw.torch,running:R.raw.run,crouching:R.raw.crouch,moving:Math.hypot(R.vx,R.vz)>.5,hidden:R.raw.hidden,local:false});
  return out;
}
function setPathTo(m,x,z){m.path=mazeNavigator?mazeNavigator.path(m.pos.x,m.pos.z,Math.max(S+.65,Math.min((W-1)*S-.65,x)),Math.max(S+.65,Math.min((W-1)*S-.65,z)),m.stats.radius):[];}
function moveToward(m,x,z,sp,dt){
  const dx=x-m.pos.x,dz=z-m.pos.z,d=Math.hypot(dx,dz);if(d<.001)return d;
  const step=Math.min(d,sp*dt),ox=m.pos.x,oz=m.pos.z;m.pos.x+=dx/d*step;m.pos.z+=dz/d*step;
  // A fast step must not tunnel through a closed door (0.25 m thick): stop on the side it came from.
  const r=m.stats.radius;
  for(const door of roomDoors){if(door.open)continue;const b=door.box,half=b.d/2+r;
    if(Math.abs(m.pos.x-b.x)>b.w/2+r&&Math.abs(ox-b.x)>b.w/2+r)continue;
    const before=oz-b.z,after=m.pos.z-b.z;
    if(Math.sign(before)!==Math.sign(after)||Math.abs(after)<half){const side=Math.sign(before)||1;if(Math.abs(before)>=half-.02||Math.sign(before)!==Math.sign(after))m.pos.z=b.z+side*half;}}
  m.yaw=angLerp(m.yaw,Math.atan2(dx,dz),Math.min(1,dt*(m.kind==='warden'?2.5:7)));return d;
}
function followPath(m,sp,dt){
  if(!m.path.length)return true;const [wx,wz]=m.path[0];
  if(!movementClear(m.pos.x,m.pos.z,wx,wz,m.stats.radius)){m.path=[];m.repath=0;return true;}
  moveToward(m,wx,wz,sp,dt);if(Math.hypot(m.pos.x-wx,m.pos.z-wz)<.035)m.path.shift();return m.path.length===0;
}
function pickWander(m){
  for(let tries=0;tries<30;tries++){
    let cx=1+Math.floor(Math.random()*(W-2)),cz=1+Math.floor(Math.random()*(W-2));
    if(Math.random()<.4){cx=Math.floor(m.pos.x/S)+Math.floor(rnd(-6,7));cz=Math.floor(m.pos.z/S)+Math.floor(rnd(-6,7));}
    if(openCell(cx,cz)&&!specialRooms.some(r=>r.shelter&&RULES.insideRoom(r,cx*S+S/2,cz*S+S/2))){
      const [wx,wz]=center(cx,cz);setPathTo(m,wx,wz);if(m.path.length)return;
    }
  }
}
// sleepers: the radius within which a noise also wakes sleeping bodies (each within a second, nearest first).
function alertMonsters(radius,x,z,sleepers=Math.min(radius,18)){
  if(x==null){x=P.pos.x;z=P.pos.z;}
  for(const m of monsters){if(m.dead)continue;const d=Math.hypot(x-m.pos.x,z-m.pos.z);
    if(m.dormant){if(d<sleepers)rouse(m,.15+.8*d/sleepers,x,z);continue;}
    if(d<radius){m.state='chase';m.lastSeen.set(x,0,z);m.lost=0;m.repath=0;}}
}
// A gunshot wakes the sleepers in earshot: the nearest at once, the furthest about a second later.
function rouseByShot(x,z,noise){
  for(const m of monsters)if(m.dormant&&!m.dead){const delay=RULES.shotWakeDelay(layDistance(m,x,z),noise);if(delay>=0)rouse(m,delay,x,z);}
}
// Schedules a sleeper to wake in `delay` seconds (an earlier schedule wins), heading for (x, z) once up.
function rouse(m,delay,x,z){
  if(!m.dormant||m.dead||m.wakeIn>=0&&m.wakeIn<=delay)return;
  m.wakeIn=Math.max(0,delay);m.rouser={x,z};
}
// A sleeper's disturbance, every frame (host and solo only): torch beams, footsteps, sprints and contact from every
// survivor add up toward SLEEP.wake; left alone it settles back down.
function updateSleeper(m,dt){
  if(m.wakeIn>=0){m.wakeIn-=dt;if(m.wakeIn<0)wakeMonster(m,m.rouser);return;}
  m.senseT-=dt;
  if(m.senseT<=0){
    m.senseT=.1;m.rate=0;let top=0;
    for(const c of targets()){
      if(c.hidden)continue;
      const d=layDistance(m,c.x,c.z);if(d>RULES.SLEEP.torch&&d>RULES.SLEEP.run)continue;
      const r=RULES.sleepDisturbance(d,{torch:c.torch&&d<RULES.SLEEP.torch&&beamOnBody(m,c),moving:c.moving,running:c.running,crouching:c.crouching});
      m.rate+=r;if(r>top){top=r;m.rouser={x:c.x,z:c.z};}
    }
  }
  if(m.rate===Infinity){wakeMonster(m,m.rouser);return;}
  m.sleep=m.rate>0?m.sleep+m.rate*dt:Math.max(0,m.sleep-RULES.SLEEP.decay*dt);
  if(m.sleep>=RULES.SLEEP.wake){wakeMonster(m,m.rouser);return;}
  sleeperVoice(m,dt);
}
// The torch beam lies on the body: one of its points sits within SLEEP.cone of the beam's axis, in plain sight.
function beamOnBody(m,c){
  const eye=(c.y||0)+(c.crouching?1:EYE),cp=Math.cos(c.pitch||0),fx=-Math.sin(c.yaw)*cp,fy=Math.sin(c.pitch||0),fz=-Math.cos(c.yaw)*cp,l=m.lay;
  for(let k=0;k<6;k+=2){
    const dx=l[k]-c.x,dy=.3-eye,dz=l[k+1]-c.z,d=Math.hypot(dx,dy,dz);
    if(d>.01&&(dx*fx+dy*fy+dz*fz)/d>Math.cos(RULES.SLEEP.cone)&&sightLine(c.x,eye,c.z,l[k],.35,l[k+1]))return true;
  }
  return false;
}
// A sleeper gets up roaring and hunts toward whatever woke it; the roar rouses the others nearby a moment later.
function wakeMonster(m,from){
  if(!m.dormant||m.dead)return;
  const x=from?from.x:P.pos.x,z=from?from.z:P.pos.z;
  m.state='chase';m.lastSeen.set(x,0,z);m.lost=0;m.repath=0;m.path=[];m.senseT=0;m.dormant=false;
  for(const o of monsters)if(o!==m&&o.dormant&&!o.dead&&Math.hypot(o.pos.x-m.pos.x,o.pos.z-m.pos.z)<RULES.SLEEP.chain)rouse(o,rnd(.4,1.6),x,z);
  wakeEffects(m);
}
// What everyone sees and hears when a body wakes (the co-op guest runs only this part).
function wakeEffects(m){
  m.dormant=false;m.wakeIn=-1;m.sleep=0;m.rate=0;m.stirred=false;m.riseT=RULES.SLEEP.rise;m.spotCD=6;
  m.anim.rise(RULES.SLEEP.rise);m.anim.scream(1.5);
  m.g.userData.eyeMat.color.setHex(m.g.userData.eyeColor||0xff2a14);
  const v=vox(m);v.state='chase';v.chargeT=5;m.voiceT=rnd(2.2,3.2);
  if(sVoice(m.kind,'wake',m.pos.x,.6,m.pos.z)!=null)v.said.wake=t;
  if(!localInDanger())return;
  const d=Math.hypot(P.pos.x-m.pos.x,P.pos.z-m.pos.z);
  if(d<16&&simulationTime-wakeStingT>2.5){wakeStingT=simulationTime;playStinger('scare','wake');flashDanger();camFX.addTrauma(.15+.3*(1-d/16));}
  if(d<40&&simulationTime-wakeBannerT>5){wakeBannerT=simulationTime;
    hud.banner(monsters.filter(o=>o.riseT>0||o.wakeIn>=0).length>1?'THEY\'RE WAKING UP':'IT\'S AWAKE',{tone:'danger',duration:1.9});}
  if(!sleepHint){sleepHint=true;showMsg('Something you passed was only sleeping. Light, footsteps and gunfire wake them. Crouch past with the torch off.',4.5);}
}
// Sleepers breathe and murmur; one that is close to waking chatters its teeth, a warning to back off.
function sleeperVoice(m,dt){
  if(!m.stirred&&m.sleep>.45){m.stirred=true;sleepSound(m,'chatter',.75);return;}
  if(m.stirred&&m.sleep<.15)m.stirred=false;
  m.voiceT-=dt;if(m.voiceT>0)return;
  m.voiceT=rnd(6,12);
  if(Math.hypot(P.pos.x-m.pos.x,P.pos.z-m.pos.z)<12)sleepSound(m,Math.random()<.25?'moan':'breath',.35);
}
function sleepSound(m,cue,volume){if(sVoice(m.kind,cue,m.pos.x,.35,m.pos.z,volume)!=null)vox(m).said[cue]=t;}
function damagePlayer(m){
  if(!localInDanger()||damageT>0||grace>0||P.hidden)return;
  P.health=Math.max(0,P.health-m.stats.damage);damageT=1.05;m.lungeT=.3;m.anim.attack();
  if(P.health>0)hurtHit(m);
  else{const dx=m.pos.x-P.pos.x,dz=m.pos.z-P.pos.z,dist=Math.max(.01,Math.hypot(dx,dz));camFX.punch((dx*Math.cos(P.yaw)-dz*Math.sin(P.yaw))/dist,.5);camFX.addTrauma(.45);}
  sCreature(m,'attack');sThud(P.pos.x,1,P.pos.z,.16,90);
  dopaHurt(m);
  if(P.health<=0){caught(m);return;}
  showMsg(m.kind==='warden'?'The Warden hits hard. Run, lock a door, hide.':`${m.stats.name} attack · find cover or a medical kit.`,2.5);
  playerAudio?.hurt(m.stats.damage);
}
function watchingMonster(m,tg){
  const dx=m.pos.x-tg.x,dz=m.pos.z-tg.z,d=Math.hypot(dx,dz);
  return d<(tg.torch?21:7)&&(-Math.sin(tg.yaw)*dx-Math.cos(tg.yaw)*dz)/Math.max(.01,d)>.68;
}
function stalkRoute(m,tg){
  if(!tg){setPathTo(m,m.lastSeen.x,m.lastSeen.z);return;}
  const backX=Math.sin(tg.yaw),backZ=Math.cos(tg.yaw),sideX=Math.cos(tg.yaw)*m.flank,sideZ=-Math.sin(tg.yaw)*m.flank;
  const reach=m.kind==='crawler'?2:2.5;
  for(const [back,side] of [[reach,1.2],[0,3.5],[reach,-1.2]]){
    const x=tg.x+backX*back+sideX*side,z=tg.z+backZ*back+sideZ*side;
    if(specialRooms.some(r=>r.shelter&&RULES.insideRoom(r,x,z))||!movementClear(x,z,x,z,m.stats.radius))continue;
    setPathTo(m,x,z);if(m.path.length)return;
  }
  setPathTo(m,m.lastSeen.x,m.lastSeen.z);
}
function chargeCue(m,local){
  if(m.spotCD>0)return;
  m.spotCD=10;sCreature(m,'notice');m.anim.scream(.9);
  if(local&&stingerCD<=0&&Math.hypot(P.pos.x-m.pos.x,P.pos.z-m.pos.z)<9){stingerCD=8;flashDanger();}
}
function updateMonster(m,dt){
  if(m.boss){updateBoss(m,dt);return;}
  if(m.dead){if(m.g.visible){m.deadT+=dt;if(m.deadT>18)m.g.visible=false;}return;}
  if(m.dormant){updateSleeper(m,dt);return;}
  // Getting up off the floor: it cannot move or strike until it stands.
  if(m.riseT>0){m.riseT=Math.max(0,m.riseT-dt);m.g.userData.speed=0;m.lungeT=Math.max(0,m.lungeT-dt);updateMonsterAudio(m,dt,0);return;}
  resolve(m.pos,m.stats.radius);
  const previousState=m.state,sneaky=m.kind==='stalker'||m.kind==='crawler';
  m.spotCD=Math.max(0,m.spotCD-dt);m.stagger=Math.max(0,m.stagger-dt);m.attackT=Math.max(0,m.attackT-dt);m.screamT=Math.max(0,m.screamT-dt);m.lungeT=Math.max(0,m.lungeT-dt);
  m.lungeCD=Math.max(0,m.lungeCD-dt);m.lungeBoost=Math.max(0,m.lungeBoost-dt);m.watched=false;
  const tgs=targets();m.senseT-=dt;
  if(m.senseT<=0){
    m.senseT=.12+Math.random()*.06;let nearest=1e9;m.seenTarget=null;m.heardTarget=null;
    for(const c of tgs){const d=Math.hypot(c.x-m.pos.x,c.z-m.pos.z);
      if(d<nearest&&monsterSees(m,c)){m.seenTarget=c;nearest=d;m.canWalkStraight=movementClear(m.pos.x,m.pos.z,c.x,c.z,m.stats.radius);}
      if(!c.hidden&&grace<=0&&c.running&&d<m.stats.hearing)m.heardTarget=c;
    }
  }
  const tg=m.seenTarget&&tgs.find(c=>c.local===m.seenTarget.local&&!c.hidden);
  const heard=m.heardTarget&&tgs.find(c=>c.local===m.heardTarget.local&&!c.hidden),sees=!!tg;
  if(sees){
    const distance=Math.hypot(tg.x-m.pos.x,tg.z-m.pos.z);
    if(sneaky&&m.state!=='chase'&&distance>(m.kind==='crawler'?2.6:3.1)){
      if(m.state!=='stalk'){m.stalkT=0;m.watchT=0;m.repath=0;m.path=[];}
      m.state='stalk';
    }else m.state='chase';
    m.lost=0;m.lastSeen.set(tg.x,0,tg.z);
  }else if(heard&&m.state!=='chase'){
    if(m.state!=='stalk'){m.stalkT=0;m.watchT=0;m.repath=0;}
    m.state=sneaky?'stalk':'chase';m.lastSeen.set(heard.x,0,heard.z);m.lost=0;
  }
  const oldX=m.pos.x,oldZ=m.pos.z;let speed=m.stats.walk;
  if(m.state==='stalk'){
    m.stalkT+=dt;if(!sees&&!heard)m.lost+=dt;
    const watched=sees&&watchingMonster(m,tg);m.watched=watched;
    m.watchT=watched?m.watchT+dt:Math.max(0,m.watchT-dt*2);
    // A brief, crooked stare is a warning, not an indefinitely frozen enemy.
    if(m.watchT>1.35||m.stalkT>(m.kind==='crawler'?8:12)){m.state='chase';m.repath=0;}
    else if(m.lost>4){m.state='search';m.searchT=5;m.path=[];}
    else if(watched&&m.kind==='stalker'){
      m.yaw=angLerp(m.yaw,Math.atan2(tg.x-m.pos.x,tg.z-m.pos.z),Math.min(1,dt*3));
    }else{
      speed=m.kind==='crawler'?.9:1.7;m.repath-=dt;
      if(m.repath<=0){stalkRoute(m,sees?tg:null);m.repath=1.1;}
      followPath(m,speed,dt);
    }
  }
  if(m.state==='chase'){
    if(previousState!=='chase')chargeCue(m,!!tg?.local);
    if(sees&&m.kind==='shrieker'&&m.screamT<=0){
      m.screamT=16;if(previousState==='chase')sCreature(m,'scream');m.anim.scream(1.6);
      alertMonsters(28,m.pos.x,m.pos.z);m.lastSeen.set(tg.x,0,tg.z);
      if(tg.local)showMsg('A Shrieker called the others. Change direction.',2.8);
    }
    speed=m.stats.chase*(m.stagger>0?(m.kind==='warden'?.85:.35):1);
    if(m.kind==='crawler')speed*=Math.sin(t*8+m.g.userData.phase*.2)>.15?1.12:.62;
    // Lunge: a short committed burst at close range in a clear straight line (never through doors, never from stalk).
    const st=m.stats,ld=tg?Math.hypot(tg.x-m.pos.x,tg.z-m.pos.z):1e9;
    if(sees&&m.canWalkStraight&&m.stagger<=0&&m.lungeCD<=0&&ld<=st.lungeRange&&ld>st.radius+PR+.35){
      m.lungeBoost=st.lungeTime;m.lungeCD=st.lungeTime+st.lungeCooldown;m.lungeT=.3;
      if(tg.local&&ld<4)camFX.addTrauma(.3);
    }
    if(m.lungeBoost>0)speed=st.chase*st.lungeSpeed*(m.stagger>0?.35:1);
    const locked=roomDoors.find(d=>!d.open&&RULES.insideRoom(d.room,m.lastSeen.x,m.lastSeen.z));
    if(!sees)m.lost+=dt;
    if(locked){
      const d=Math.hypot(m.pos.x-locked.box.x,m.pos.z-locked.box.z);
      if(d<2.4){
        m.yaw=angLerp(m.yaw,Math.atan2(locked.box.x-m.pos.x,locked.box.z-m.pos.z),Math.min(1,dt*4));
        if(tgs.some(c=>c.torch&&RULES.insideRoom(locked.room,c.x,c.z)))m.lost=0;
        locked.health-=dt*(locked.locked?(m.kind==='warden'?6:2):(m.kind==='warden'?10:6));
        if(m.attackT<=0){m.attackT=1.3;m.lungeT=.3;m.anim.attack();sThud(locked.box.x,1,locked.box.z,.35,m.kind==='warden'?75:150);}
        if(locked.health<=0){locked.open=true;locked.locked=false;locked.revision++;m.repath=0;showMsg('An isolation lock broke. Find another shelter.',3);}
      }else{m.repath-=dt;if(m.repath<=0){setPathTo(m,locked.box.x,locked.box.z+S);m.repath=.8;}followPath(m,speed,dt);}
    }else if(sees&&m.canWalkStraight){moveToward(m,tg.x,tg.z,speed,dt);m.path=[];}
    else if(sees){m.repath-=dt;if(m.repath<=0){setPathTo(m,tg.x,tg.z);m.repath=.5;}followPath(m,speed,dt);}
    else {m.repath-=dt;if(m.repath<=0){setPathTo(m,m.lastSeen.x,m.lastSeen.z);m.repath=.75;}followPath(m,speed,dt);}
    if(!sees&&m.lost>(locked?5.2:8)){m.state='search';m.searchT=5;m.path=[];m.seenTarget=null;m.heardTarget=null;}
  }else if(m.state==='search'){
    speed=m.stats.search;m.searchT-=dt;
    if(!m.path.length)pickWander(m);followPath(m,speed,dt);
    if(m.searchT<=0){m.state='wander';m.path=[];}
  }else if(m.state==='wander'){if(!m.path.length)pickWander(m);followPath(m,speed,dt);}
  m.pos.y=0;resolve(m.pos,m.stats.radius);
  for(const other of monsters){if(other===m||other.dead||other.dormant)continue;const dx=m.pos.x-other.pos.x,dz=m.pos.z-other.pos.z,d=Math.hypot(dx,dz),gap=m.stats.radius+other.stats.radius;
    if(d<gap&&d>.0001){m.pos.x+=dx/d*(gap-d)*.35;m.pos.z+=dz/d*(gap-d)*.35;}
  }
  resolve(m.pos,m.stats.radius);
  if(tgs.some(c=>(c.y||0)<m.stats.height&&RULES.blocksCircleMove({x:oldX,z:oldZ},m.pos,m.stats.radius,{x:c.x,z:c.z,r:PR}))){m.pos.x=oldX;m.pos.z=oldZ;}
  m.g.position.copy(m.pos);m.g.rotation.y=m.yaw;
  const moved=Math.hypot(m.pos.x-oldX,m.pos.z-oldZ);m.g.userData.speed=moved/Math.max(dt,.001);m.g.userData.chasing=m.state==='chase';
  updateMonsterAudio(m,dt,moved);
  const d=Math.hypot(P.pos.x-m.pos.x,P.pos.z-m.pos.z);
  if(localInDanger()&&m.attackT<=0&&d<m.stats.radius+PR+.35&&P.pos.y<(m.kind==='crawler'?.6:1.3)&&los(m.pos.x,m.pos.z,P.pos.x,P.pos.z)){
    m.attackT=m.kind==='warden'?1.7:1.1;damagePlayer(m);
  }
}
function updateThreats(dt){
  grace=Math.max(0,grace-dt);stingerCD=Math.max(0,stingerCD-dt);
  if(!NET.inGame||NET.role==='host')updateMonsters(dt);else guestMonsters(dt);
}
function updateMonsters(dt){
  let target=0;nearestD=99;
  const st0=state;
  for(const m of monsters){
    if(!aiFrozen){
      // Sub-step fast movers (lunging crawlers reach ~10 m/s) so no step skips collision or attack checks.
      const top=m.dead||m.state!=='chase'?m.stats.search:m.stats.chase*(m.lungeBoost>0?m.stats.lungeSpeed:1.12);
      const n=Math.max(1,Math.ceil(top*dt/.25));
      for(let k=0;k<n&&state===st0;k++)updateMonster(m,dt/n);
      if(state!==st0)return;
    }
    if(m.dead||m.dormant)continue;const d=Math.hypot(P.pos.x-m.pos.x,P.pos.z-m.pos.z);nearestD=Math.min(nearestD,d);
    target=Math.max(target,m.state==='chase'?Math.max(0,1-d/32):m.state==='stalk'?Math.max(0,1-d/6)*.18:Math.max(0,1-d/14)*.35);
  }
  danger+=(target-danger)*Math.min(1,dt*2);
}
// Procedural run/stalk/lunge/hit/death animation (HollowMonsterAnim). One input object is reused (zero allocation).
const animIn={speed:0,state:'wander',lunge:0,stagger:0,turn:0,watched:false,time:0,effects:true,dead:false};
function animateMonster(m,dt){
  const u=m.g.userData;if(m.dead)u.glow.intensity=0;if(!m.g.visible)return;
  const sp=u.speed||0,close=state==='caught'&&m===caughtBy;
  u.phase+=dt*sp*4.8; // the crawler speed burst in updateMonster still reads it
  let dy=m.yaw-m.animYaw;dy-=Math.round(dy/(2*Math.PI))*2*Math.PI;m.animYaw=m.yaw;
  animIn.speed=state==='caught'?0:sp;animIn.state=close?'chase':m.state;
  animIn.lunge=m.lungeBoost>0?1:(m.lungeT||0);animIn.stagger=m.stagger||0;animIn.turn=dt>0?dy/dt:0;
  animIn.watched=m.watched===true;animIn.time=t;animIn.effects=preferences.effects===true;animIn.dead=m.dead===true||m.dormant===true;
  const pose=m.anim.update(dt,animIn);
  if(close&&kill.on)killJoints(pose);
  HollowMonsterAnim.apply(m.g,pose,m.pos.x,m.pos.z,m.yaw,close);
  if(m.boss)bossPose(m,dt,close);
  if(close&&kill.on)killPlace(m);
  if(pose.footstep&&!m.dead)onMonsterFootstep(m,pose.stepIntensity);
}

/* ---------- rifle ---------- */
function startReload(){
  const w=weaponDefs[weaponIndex];
  if(state!=='play'||reloadT>0||mag>=w.capacity)return;
  if(reserve<=0&&!infiniteAmmo()){showMsg('No spare ammunition. Search rooms and dead ends.',2);return;}
  reloadT=w.reload;aiming=false;sReload();
}
const _o=new THREE.Vector3(),_d=new THREE.Vector3(),_shotDir=new THREE.Vector3(),_shotQuat=new THREE.Quaternion(),_shotEuler=new THREE.Euler(0,0,0,'YXZ');
// During fire(): [body, shooter position] for each sleeping body a pellet hit without killing it.
let shotWakes=null;
// Distance along the current pellet ray (_o, _d) to an upright cylinder of radius r at (x, z), or -1 when it misses.
function rayCircle(x,z,r){
  const ox=_o.x-x,oz=_o.z-z,a=_d.x*_d.x+_d.z*_d.z;if(a<.00001)return -1;
  const b=2*(ox*_d.x+oz*_d.z),c=ox*ox+oz*oz-r*r,disc=b*b-4*a*c;if(disc<0)return -1;
  const sq=Math.sqrt(disc);let at=(-b-sq)/(2*a);if(at<0)at=(-b+sq)/(2*a);return at;
}
function fire(){
  if(reloadT>0||P.hidden)return;
  fireQueued=false;
  const w=weaponDefs[weaponIndex];
  if(mag<=0){sDry();fireT=.3;semiFired=true;if(reserve>0||infiniteAmmo())startReload();else showMsg('Weapon empty. Switch weapons or find supplies.',2);return;}
  mag--;weapons[weaponIndex].mag=mag;fireT=w.interval;gunKick=1;flashT=.045;semiFired=true;sShot();NET.shots++;
  if(!NET.inGame||NET.role==='host'){alertMonsters(w.noise,P.pos.x,P.pos.z,0);rouseByShot(P.pos.x,P.pos.z,w.noise);}
  _o.set(P.pos.x,P.pos.y+P.eye,P.pos.z);
  _shotQuat.setFromEuler(_shotEuler.set(P.pitch,P.yaw,0,'YXZ'));_shotDir.set(0,0,-1).applyQuaternion(_shotQuat);
  const spread=w.spread*(aiming?.4:1)*(P.crouching?.65:1)+(P.moving?.008:0);
  dopaShotBegin();shotWakes=[];shotStamp++;
  let didHit=false,hitPartner=false;
  // Phase 1 traces every pellet (regions, damage, a running tally per creature); phase 2 plays what they did.
  const struck=[],targets=[];
  if(atm&&gun.userData.muzzlePosition)_atmMz.copy(gun.userData.muzzlePosition).applyEuler(gun.rotation).add(gun.position);
  if(w.pellets>1)fxFlash=.55;
  for(let pellet=0;pellet<w.pellets;pellet++){
    _d.copy(_shotDir);_d.x+=rnd(-spread,spread);_d.y+=rnd(-spread,spread);_d.z+=rnd(-spread,spread);_d.normalize();
    let wallDistance=48;
    for(let st=.1;st<48;st+=.13){if(blocksRay(_o.x+_d.x*st,_o.y+_d.y*st,_o.z+_d.z*st)){wallDistance=st;break;}}
    let best=null,distance=wallDistance;
    for(const m of monsters){if(m.dead||m.hitStamp===shotStamp&&m.shot.hp<=0)continue;
      // A body on the floor is three low cylinders along it; a hit there is never a headshot.
      if(m.dormant){for(let k=0;k<6;k+=2){const at=rayCircle(m.lay[k],m.lay[k+1],m.layR);if(at<0||at>=distance)continue;const y=_o.y+_d.y*at;if(y<.02||y>.6)continue;distance=at;best={m,y:Math.min(y,m.stats.head-.01),lay:k/2};}continue;}
      const ox=_o.x-m.pos.x,oz=_o.z-m.pos.z,a=_d.x*_d.x+_d.z*_d.z;if(a<.00001)continue;
      const radius=m.stats.radius,b=2*(ox*_d.x+oz*_d.z),c=ox*ox+oz*oz-radius*radius,disc=b*b-4*a*c;if(disc<0)continue;
      const sq=Math.sqrt(disc);let at=(-b-sq)/(2*a);if(at<0)at=(-b+sq)/(2*a);if(at<0||at>=distance)continue;
      const y=_o.y+_d.y*at;if(y<.06||y>m.stats.height)continue;distance=at;best={m,y};
    }
    // Friendly fire: the partner is a 0.3 m upright cylinder (lower when crouched); a locker hides them.
    if(NET.inGame)for(const R of REMOTES.values()){if(!liveRemote(R)||R.raw.hidden||!R.rig||!R.rig.avatar.visible)continue;
      const ox=_o.x-R.pos.x,oz=_o.z-R.pos.z,a=_d.x*_d.x+_d.z*_d.z,b=2*(ox*_d.x+oz*_d.z),c=ox*ox+oz*oz-.09,disc=b*b-4*a*c;
      if(a>.00001&&c>0&&disc>=0){const at=(-b-Math.sqrt(disc))/(2*a),y=_o.y+_d.y*at-(R.raw.y||0),top=R.raw.crouch?1.2:1.8;
        if(at>0&&at<distance&&y>.06&&y<top){distance=at;best={mate:R,y,head:y>top-.26};}}
    }
    const hit=_o.clone().addScaledVector(_d,Math.max(0,distance-.04));
    const streak=w.pellets===1||pellet%3===0;
    if(atm&&streak)atm.tracer(_o.x,_o.y,_o.z,hit.x,hit.y,hit.z,gun.userData.muzzlePosition?{muzzle:_atmMz}:undefined);
    if(best&&best.mate){
      didHit=true;if(atm)atm.blood(hit.x,hit.y,hit.z,{dir:_d,amount:w.pellets>1?.4:1});else puff(hit,true);
      const R=best.mate;NET.ff[R.peer]=(NET.ff[R.peer]||0)+RULES.weaponDamage(w.id,best.head,distance,'partner')*FRIENDLY_FIRE;
      R.rig.avatar.userData.flinch(_d.x*Math.cos(R.yaw)-_d.z*Math.sin(R.yaw));
      if(!hitPartner)showMsg(`You hit ${R.nm}! Friendly fire is on.`,1.6);hitPartner=true;
    }else if(best){
      didHit=true;
      if(best.m.hitStamp!==shotStamp)targets.push(best.m);
      struck.push(tracePellet(best.m,best,distance,wallDistance,w));
      continue;
    }else if(wallDistance<48&&atm){
      if(streak){const k=.12;_atmNd.copy(_d).negate();
        if(metalAt(hit.x,hit.z))atm.sparks(hit.x-_d.x*k,hit.y-_d.y*k,hit.z-_d.z*k,{dir:_atmNd,count:16});
        else atm.debris(hit.x-_d.x*k,hit.y-_d.y*k,hit.z-_d.z*k,{dir:_atmNd});}
    }else if(wallDistance<48)puff(hit,false);
    audioBullet(hit,best,distance,wallDistance);
  }
  // Phase 2: each pellet's wound and spray, then each creature takes the whole shot at once.
  const guest=NET.inGame&&NET.role==='guest';
  let gib=false,heavy=false,killedAny=false,heavyHead=false;
  const shotLog={weapon:w.id,pellets:w.pellets,hits:[],targets:[]};
  for(let k=0;k<struck.length;k++){const rec=struck[k];playPellet(rec,w,k);if(shotLog.hits.length<16)shotLog.hits.push({index:monsters.indexOf(rec.m),region:rec.region,damage:rec.damage,mesh:!!rec.object,exit:!!rec.exit});}
  for(const m of targets){
    const s=m.shot,r=strikeMonster(m,w,guest),v=r.v;
    gib=gib||(r.killed&&v.gib);killedAny=killedAny||r.killed;heavyHead=heavyHead||s.heavyHead;
    heavy=heavy||s.maxPellet>=2||s.damage>=3.5||(r.killed&&(v.gib||!!v.sever));
    shotLog.targets.push({index:monsters.indexOf(m),kind:m.kind,damage:s.damage,pellets:s.pellets,region:v.region,head:s.head,killed:r.killed,
      gib:r.killed&&v.gib,jaw:r.killed&&v.jaw,sever:r.killed?v.sever:'',chunks:v.chunks,kneel:!r.killed&&v.kneel&&!m.dormant,deathForce:v.deathForce,
      knock:Math.hypot(s.knockX,s.knockZ),strength:Math.min(2,s.strength)});
  }
  if(struck.length)lastShot=shotLog;
  shotHit.heavy=heavy;
  const woken=shotWakes;shotWakes=null;
  for(const [m,src] of woken)if(!m.dead&&m.dormant)wakeMonster(m,src);
  dopaShotEnd();
  // A head coming apart freezes the moment a little longer; so does a heavy round to the head that does not kill.
  if(gib&&hitstopT<.07)dopaHitstop(.07);else if(heavyHead&&!killedAny&&hitstopT<.03)dopaHitstop(.03);
  if(didHit){hitMarkerT=.16;audioHitTick();}
  if(hitPartner)sendNet(true);
  const recoil=w.recoil*(aiming?.65:1);camFX.kick(recoil,rnd(-1,1)*w.recoil*.25);
  P.pitch=Math.min(1.35,P.pitch+recoil*.35);P.yaw+=rnd(-.001,.001);
  if(w.id==='shotgun')camFX.addTrauma(.2);
}
// info (fire(), hitzones.js): { region, side, dirX, dirZ (the shot's direction), stagger, knockX, knockZ (m/s),
// kneel, kneelSide, kneelTime, deathForce, gib }. Without it a hit reacts as it always has.
function hitMonster(m,dmg,from,headshot,strength,info){
  if(m.dead)return;
  const src=from||P.pos,shot={dirX:m.pos.x-src.x,dirZ:m.pos.z-src.z,yaw:m.yaw,headshot:!!headshot,strength:strength??1};
  if(info){
    shot.dirX=info.dirX;shot.dirZ=info.dirZ;shot.region=info.region;shot.side=info.side;
    if(info.kneel){shot.kneel=true;shot.kneelSide=info.kneelSide;shot.kneelTime=info.kneelTime;}
  }
  // A shot that does not finish a sleeper wakes it at once (a killing shot leaves it where it lies). Inside fire() the
  // wake waits for the last pellet, so a blast that kills it does not get it up roaring first.
  if(m.dormant&&m.hp-dmg>0){if(shotWakes)shotWakes.push([m,{x:src.x,z:src.z}]);else wakeMonster(m,src);}
  m.hp-=dmg;m.stagger=info?Math.max(m.stagger,info.stagger):m.kind==='warden'?.07:.25;m.state='chase';
  if(info&&m.hp>0&&!m.dormant){
    m.knockVX=(m.knockVX||0)+info.knockX;m.knockVZ=(m.knockVZ||0)+info.knockZ;m.hitHeat=Math.min(6,(m.hitHeat||0)+shot.strength);
    if(info.kneel){if(!(m.kneelT>0)){m.kneelX=m.pos.x;m.kneelZ=m.pos.z;}m.kneelT=Math.max(m.kneelT||0,info.kneelTime);}
  }
  if(info&&m.hp<=0){shot.force=info.deathForce;shot.region=info.region;shot.gib=!!info.gib;}
  if(m.hp>0)m.anim.hit(shot);
  if(from)m.lastSeen.set(from.x,0,from.z);else m.lastSeen.copy(P.pos);m.lost=0;
  if(m.boss)bossHit(m,dmg,headshot);
  if(m.hp<=0){
    m.dead=true;m.dormant=false;m.wakeIn=-1;m.riseT=0;m.deadT=0;m.g.userData.eyeMat.color.set(0x120000);m.g.userData.glow.intensity=0;sCreature(m,'death');
    m.anim.die(shot);fxKill=1;
    const left=monsters.filter((o,i)=>i<monCount&&!o.dead).length;
    showMsg(left?`${m.stats.name} down · ${left} threats remain.`:'The corridors are silent. Restore the exit power.',2.5);
  }else if(m.kind==='warden'&&noticeT<=0){noticeT=12;showMsg('It barely flinched. Save ammunition: break sight, lock a room, hide.',3.2);}
}
/* ---------- the Gravekeeper (S2's boss) ---------- */
// It walks outside the 20-body pool, and so outside co-op (which never leaves B1): monsters[MAX_MON], added the first
// time a boss floor starts. In its grave it counts as dead and unspawned, like an empty slot. act: grave, toll (the
// bell), rise, then hunt and its attacks (windup > charge > recover, slamUp > recover, enrage at half health), dead.
// It paths, slides along walls and squeezes between graves at the Warden's radius; its own 0.8 m body takes the
// bullets and blocks the survivor.
const BOSS_NAV=.58,BOSS_UP=new THREE.Vector3(0,1,0);
let boss=null,bossBell=null,bellSwing=0,bellT=0,bellNext=0,checkpointBanner=false;
function bossBody(){
  if(boss)return boss;
  const kind='gravekeeper',stats=RULES.MONSTERS[kind],voiceKind=kind,g=HollowVisuals.makeMonster(THREE,kind),anim=HollowMonsterAnim.create(kind,{seed:MAX_MON});
  g.visible=false;scene.add(g);
  boss={g,kind,stats,boss:true,voiceKind,pos:new THREE.Vector3(),yaw:0,state:'wander',path:[],repath:0,lastSeen:new THREE.Vector3(),lost:0,searchT:0,stepT:0,spotCD:0,hp:stats.hp,dead:true,deadT:0,stagger:0,voiceT:3,stalkT:0,watchT:0,flank:1,
    lungeT:0,lungeCD:0,lungeBoost:0,attackT:0,screamT:0,senseT:0,seenTarget:null,heardTarget:null,anim,animYaw:0,watched:false,spawned:false,dormant:false,sleep:0,rate:0,rouser:null,wakeIn:-1,riseT:0,stirred:false,lay:[0,0,0,0,0,0],layR:.5,
    act:'gone',actT:0,phase:1,sink:0,chargeCD:0,slamCD:0,dirX:0,dirZ:0,chargeLeft:0,enrage:false,summoned:0,downT:0,bashT:0,pose:{up:0,rear:0,low:0}};
  monsters.push(boss);
  return boss;
}
// Every start of a floor: on the boss floor the Gravekeeper lies in its grave before the gate; anywhere else it is gone.
function setupBoss(){
  const f=FLOOR().boss;
  if(!f){if(boss){boss.act='gone';boss.g.visible=false;}return;}
  const b=bossBody(),[gx,gz]=f.grave;
  b.pos.set((gx+.5)*S,0,(gz+.5)*S);b.yaw=Math.PI;b.g.position.copy(b.pos);
  b.dead=true;b.spawned=false;b.dormant=false;b.g.visible=false;b.hp=b.stats.hp;b.phase=1;b.act='grave';b.actT=0;b.sink=-b.stats.height-.4;b.state='wander';b.path=[];b.repath=0;
  b.chargeCD=3;b.slamCD=2;b.attackT=0;b.stagger=0;b.enrage=false;b.summoned=0;b.deadT=0;b.downT=0;b.bashT=0;b.pose.up=b.pose.rear=b.pose.low=0;
  b.anim.reset();b.g.userData.eyeMat.color.setHex(b.g.userData.eyeColor||0xff2a14);bellSwing=0;bellT=0;bellNext=0;
}
// While it is up (from the first toll until it falls) the gate stays chained and the bell is the only alarm.
const BOSS_UP_ACTS=new Set(['toll','rise','hunt','windup','charge','slamUp','recover','enrage']);
function bossHolds(){return !!(boss&&FLOOR().boss&&exitPowered&&!exitOpen&&boss.hp>0&&BOSS_UP_ACTS.has(boss.act));}
// The cemetery gate is used: the bell tolls, and a moment later the Gravekeeper climbs out of its grave before the gate.
function bossAwaken(){
  const b=boss;if(!b||b.act!=='grave')return;
  b.act='toll';b.actT=1.5;bellSwing=1;bellT=0;bellNext=0;
}
function bossRise(m){
  const rise=2.6;
  m.act='rise';m.actT=rise;m.dead=false;m.spawned=true;m.g.visible=true;m.state='search';m.hp=m.stats.hp;m.deadT=0;
  m.yaw=Math.atan2(P.pos.x-m.pos.x,P.pos.z-m.pos.z);m.animYaw=m.yaw;m.g.position.copy(m.pos);m.g.rotation.set(0,m.yaw,0);
  m.anim.reset();m.anim.scream(rise);m.sink=-m.stats.height-.4;
  sRumble(m.pos.x,m.pos.z,rise+.4);sCreature(m,'wake');graveDirt(m.pos.x,m.pos.z,6);
  hud.banner('THE GRAVEKEEPER',{tone:'danger',kicker:'It keeps the gate',duration:3.6});
  if(localInDanger()){const d=Math.hypot(P.pos.x-m.pos.x,P.pos.z-m.pos.z);camFX.addTrauma(.5+.35*Math.max(0,1-d/25));playStinger('scare','gravekeeper');flashDanger();}
  showMsg('Something climbed out of the grave before the gate. The gate will not open while it walks.',4.5);
}
function graveDirt(x,z,n){if(atm)for(let i=0;i<n;i++)atm.debris(x+rnd(-.9,.9),.12,z+rnd(-1.2,1.2),{dir:BOSS_UP,color:0x3a2c20,sparks:0});}
function bellStep(dt){
  if(!bossBell)return;
  bellT+=dt;bellSwing=Math.max(0,bellSwing-dt*.09);bossBell.rotation.z=Math.sin(bellT*3.2)*.6*bellSwing;
  if(bellSwing>.12&&bellT>=bellNext){bellNext=bellT+Math.PI*2/3.2;sBell(.35+.65*bellSwing);}
}
// (x, z) through the navigator at the Warden's radius, or straight at it when the way is clear.
function bossPath(m,x,z){m.path=mazeNavigator?mazeNavigator.path(m.pos.x,m.pos.z,Math.max(S+.65,Math.min((W-1)*S-.65,x)),Math.max(S+.65,Math.min((W-1)*S-.65,z)),BOSS_NAV):[];}
function bossMove(m,x,z,speed,dt,turn){
  const dx=x-m.pos.x,dz=z-m.pos.z,d=Math.hypot(dx,dz);if(d<.001)return d;
  const step=Math.min(d,speed*dt);m.pos.x+=dx/d*step;m.pos.z+=dz/d*step;
  m.yaw=angLerp(m.yaw,Math.atan2(dx,dz),Math.min(1,dt*(turn||3)));return d;
}
function bossFollow(m,speed,dt){
  if(!m.path.length)return;const [wx,wz]=m.path[0];
  bossMove(m,wx,wz,speed,dt,3.5);if(Math.hypot(m.pos.x-wx,m.pos.z-wz)<.08)m.path.shift();
}
function bossFace(m,dt,rate){m.yaw=angLerp(m.yaw,Math.atan2(P.pos.x-m.pos.x,P.pos.z-m.pos.z),Math.min(1,dt*rate));}
// Its blows go through damagePlayer as a copy of it carrying that blow's damage (the caught close-up shows it).
function bossStrike(m,damage,message){
  const blow=Object.create(m),before=P.health;blow.stats=Object.assign({},m.stats,{damage});
  damagePlayer(blow);
  if(caughtBy===blow)caughtBy=m;
  if(P.health<before&&P.health>0&&message)showMsg(message,3);
  return P.health<before;
}
function bossSlam(m){
  const d=Math.hypot(P.pos.x-m.pos.x,P.pos.z-m.pos.z),reach=4.5;
  sThud(m.pos.x,.2,m.pos.z,1,60);audioAfter(.12,()=>sThud(m.pos.x,.4,m.pos.z,.55,140));sRumble(m.pos.x,m.pos.z,1.3);
  if(atm)for(let k=0;k<8;k++){const a=k/8*Math.PI*2;atm.debris(m.pos.x+Math.cos(a)*1.7,.1,m.pos.z+Math.sin(a)*1.7,{dir:BOSS_UP,color:0x3b2e22,sparks:0});}
  if(!localInDanger())return;
  camFX.addTrauma(Math.max(.15,.8*(1-d/14)));
  if(d<reach&&P.pos.y<.35&&los(m.pos.x,m.pos.z,P.pos.x,P.pos.z))bossStrike(m,m.phase===2?44:36,'The ground broke under you. When it raises its arms, get clear or jump.');
}
// Half its health gone: it screams, comes on faster and calls the dead up out of the graves around the gate (pool
// slots MAX_MON - 3 and up, which S2 leaves free after its waking and sleeping bodies).
function bossEnrage(m){
  m.phase=2;m.act='enrage';m.actT=2;m.path=[];
  m.anim.scream(2);sCreature(m,'scream');audioAfter(.6,()=>{if(!m.dead)sCreature(m,'howl');});
  hud.banner('THE GRAVEKEEPER IS ENRAGED',{tone:'danger',kicker:'The dead answer it',duration:3});wakeBannerT=simulationTime;
  m.g.userData.eyeMat.color.setHex(0xff4a1c);
  if(localInDanger()){camFX.addTrauma(.5);flashDanger();}
  showMsg('It screamed, and the graves around the gate are opening. Keep moving.',4);
}
function bossSummon(m){
  const list=FLOOR().boss.summons;m.summoned=0;
  list.forEach(([cx,cz],k)=>{
    const slot=MAX_MON-list.length+k,o=monsters[slot];if(!o||!o.dead)return;
    const x=(cx+.5)*S,z=(cz+.5)*S;
    resetMonster(o,x,z,Math.atan2(P.pos.x-x,P.pos.z-z));layDown(o,slot);wakeMonster(o,{x:P.pos.x,z:P.pos.z});
    monCount=Math.max(monCount,slot+1);graveDirt(x,z,4);sRumble(x,z,1.1);m.summoned++;
  });
}
function bossHit(m,dmg,headshot){
  m.stagger=0;
  if(m.phase===1&&m.hp>0&&m.hp<=m.stats.hp*.5)m.enrage=true;
}
function bossDown(m){
  m.act='dead';m.deadT=0;m.downT=0;m.spawned=true;m.path=[];
  exitRelease=Math.min(exitRelease,3.5);alarmT=3.2;
  scoreBase.points+=2500;hud.score(runScore().points);
  hud.banner('THE GRAVEKEEPER FALLS',{tone:'objective',kicker:'The gate is unchaining',duration:3.5});
  bellSwing=Math.max(bellSwing,.8);bellNext=bellT;
  audioAfter(.9,()=>{sThud(m.pos.x,.3,m.pos.z,1,55);sRumble(m.pos.x,m.pos.z,1.6);if(localInDanger())camFX.addTrauma(.45);graveDirt(m.pos.x,m.pos.z,5);});
  if(localInDanger())camFX.addTrauma(.5);
  showMsg('It went down into the earth it came from. The gate is unchaining. RUN.',5);
}
function updateBoss(m,dt){
  if(!FLOOR().boss||m.act==='gone')return;
  bellStep(dt);
  if(m.act==='grave')return;
  if(m.act==='toll'){m.actT-=dt;if(m.actT<=0)bossRise(m);return;}
  if(m.act==='dead'){
    // The body lies a while, then the earth takes it back.
    m.deadT+=dt;m.downT+=dt;
    if(m.downT>4)m.sink=-Math.min(m.stats.height+.5,(m.downT-4)*.5);
    if(m.downT>4&&m.downT<11&&Math.random()<dt*2.5)graveDirt(m.pos.x,m.pos.z,1);
    if(m.downT>13){m.spawned=false;m.g.visible=false;}
    return;
  }
  if(m.dead){if(m.hp<=0)bossDown(m);return;}
  m.actT-=dt;m.attackT=Math.max(0,m.attackT-dt);m.chargeCD=Math.max(0,m.chargeCD-dt);m.slamCD=Math.max(0,m.slamCD-dt);
  m.lungeT=Math.max(0,m.lungeT-dt);m.stagger=0;m.g.userData.speed=0;
  if(m.act==='rise'){
    const k=clamp01(1-m.actT/2.6);m.sink=(-m.stats.height-.4)*(1-ease(0,1,k));
    if(Math.random()<dt*5)graveDirt(m.pos.x,m.pos.z,1);
    if(m.actT<=0){m.act='hunt';m.sink=0;m.state='chase';m.repath=0;m.chargeCD=Math.max(m.chargeCD,2.5);sCreature(m,'scream');}
    return;
  }
  if(!localInDanger()){updateMonsterAudio(m,dt,0);return;}
  const tx=P.pos.x,tz=P.pos.z,d=Math.hypot(tx-m.pos.x,tz-m.pos.z),fast=m.phase===2?1.25:1,oldX=m.pos.x,oldZ=m.pos.z;
  m.lastSeen.set(tx,0,tz);m.state='chase';
  if(m.act==='enrage'){bossFace(m,dt,2);if(!m.summoned&&m.actT<1.3)bossSummon(m);if(m.actT<=0){m.act='hunt';m.repath=0;}}
  else if(m.act==='windup'){
    bossFace(m,dt,5);
    if(m.actT<=0){const dx=tx-m.pos.x,dz=tz-m.pos.z,l=Math.max(.01,Math.hypot(dx,dz));m.dirX=dx/l;m.dirZ=dz/l;m.act='charge';m.chargeLeft=Math.min(22,l+5);m.lungeT=.3;sCreature(m,'scream');}
  }else if(m.act==='charge'){
    // A straight run at three times its chase: it stops at the first wall, grave or body in the way.
    let left=m.stats.chase*3*fast*dt,blocked=false;
    while(left>1e-4&&!blocked&&m.act==='charge'){
      const step=Math.min(.2,left),bx=m.pos.x,bz=m.pos.z;left-=step;
      m.pos.x+=m.dirX*step;m.pos.z+=m.dirZ*step;resolve(m.pos,BOSS_NAV);
      const went=Math.hypot(m.pos.x-bx,m.pos.z-bz);m.chargeLeft-=went;
      if(went<step*.5)blocked=true;
      if(Math.hypot(P.pos.x-m.pos.x,P.pos.z-m.pos.z)<m.stats.radius+PR+.3&&P.pos.y<1.6){
        bossStrike(m,m.phase===2?62:54,'It ran you down. Step aside when it rears back.');m.act='recover';m.actT=1.1;
      }
    }
    m.yaw=angLerp(m.yaw,Math.atan2(m.dirX,m.dirZ),Math.min(1,dt*8));
    if(m.act==='charge'&&blocked){
      m.act='recover';m.actT=1.7;sThud(m.pos.x,1.2,m.pos.z,.9,70);graveDirt(m.pos.x+m.dirX*.8,m.pos.z+m.dirZ*.8,3);
      if(Math.hypot(P.pos.x-m.pos.x,P.pos.z-m.pos.z)<14)camFX.addTrauma(.35);
    }else if(m.act==='charge'&&m.chargeLeft<=0){m.act='recover';m.actT=.9;}
  }else if(m.act==='slamUp'){bossFace(m,dt,2.5);if(m.actT<=0){bossSlam(m);m.act='recover';m.actT=1.05;}}
  else if(m.act==='recover'){bossFace(m,dt,1.2);if(m.actT<=0){m.act='hunt';m.repath=0;}}
  else{
    if(m.enrage){m.enrage=false;bossEnrage(m);}
    else if(m.slamCD<=0&&d<3.4){m.act='slamUp';m.actT=m.phase===2?.65:.85;m.slamCD=m.phase===2?4.5:6.5;m.anim.scream(1);sCreature(m,'growl');}
    else if(m.chargeCD<=0&&d>5&&d<17&&movementClear(m.pos.x,m.pos.z,tx,tz,BOSS_NAV)){m.act='windup';m.actT=m.phase===2?.7:.95;m.chargeCD=m.phase===2?4.5:6.5;m.anim.scream(1.1);sCreature(m,'notice');}
    else{
      const speed=m.stats.chase*fast,shelter=currentShelter(),door=shelter&&roomDoors.find(o=>o.room===shelter&&!o.open&&o.health>0);
      if(door){
        // Shut in a refuge: it beats the door down.
        const fx=door.box.x,fz=door.box.z+1.3,dd=Math.hypot(fx-m.pos.x,fz-m.pos.z);
        if(dd<.6){m.yaw=angLerp(m.yaw,Math.atan2(door.box.x-m.pos.x,door.box.z-m.pos.z),Math.min(1,dt*4));door.health-=dt*(door.locked?8:14);m.bashT-=dt;
          if(m.bashT<=0){m.bashT=1.1;m.lungeT=.3;m.anim.attack();sThud(door.box.x,1,door.box.z,.6,65);if(Math.hypot(P.pos.x-door.box.x,P.pos.z-door.box.z)<8)camFX.addTrauma(.2);}
          if(door.health<=0){door.open=true;door.locked=false;door.revision++;showMsg('It tore the door off. Get out of there.',3);}}
        else{m.repath-=dt;if(m.repath<=0){bossPath(m,fx,fz);m.repath=.5;}bossFollow(m,speed,dt);}
      }else if(movementClear(m.pos.x,m.pos.z,tx,tz,BOSS_NAV)){bossMove(m,tx,tz,speed,dt,3);m.path=[];}
      else{m.repath-=dt;if(m.repath<=0){bossPath(m,tx,tz);m.repath=.45;}bossFollow(m,speed,dt);}
      if(d<m.stats.radius+PR+.55&&m.attackT<=0&&P.pos.y<1.6&&los(m.pos.x,m.pos.z,tx,tz)){m.attackT=m.phase===2?1.1:1.5;m.lungeT=.3;bossStrike(m,m.stats.damage,'The Gravekeeper hits like a falling tree. Keep your distance.');}
    }
  }
  resolve(m.pos,BOSS_NAV);
  if(m.act!=='charge'&&(P.pos.y||0)<m.stats.height&&RULES.blocksCircleMove({x:oldX,z:oldZ},m.pos,m.stats.radius,{x:P.pos.x,z:P.pos.z,r:PR})){m.pos.x=oldX;m.pos.z=oldZ;}
  m.pos.y=0;m.g.position.copy(m.pos);m.g.rotation.y=m.yaw;
  const moved=Math.hypot(m.pos.x-oldX,m.pos.z-oldZ);m.g.userData.speed=moved/Math.max(dt,.001);m.g.userData.chasing=true;
  updateMonsterAudio(m,dt,moved);
}
// After HollowMonsterAnim.apply: how deep it stands (rising, or a body sinking), and its telegraphs: arms raised before
// the slam, reared back before the charge, head down in it.
function bossPose(m,dt,close){
  if(close)return;
  const g=m.g,u=g.userData,o=m.pose,k=1-Math.exp(-dt*9);
  g.position.y+=m.sink;
  o.up+=((m.act==='slamUp'?1:0)-o.up)*k;o.rear+=((m.act==='windup'?1:0)-o.rear)*k;o.low+=((m.act==='charge'?1:0)-o.low)*k;
  if(m.dead)return;
  if(u.armL&&u.armR){const a=-2.5*o.up+.9*o.rear;u.armL.rotation.x+=a;u.armR.rotation.x+=a;u.armL.rotation.z-=.35*o.up;u.armR.rotation.z+=.35*o.up;}
  g.rotation.x+=.3*o.low-.22*o.rear-.12*o.up;
}
function aboveGroundHUD(){
  if(checkpointBanner&&simulationTime>.5){checkpointBanner=false;hud.banner('CHECKPOINT REACHED',{tone:'info',kicker:`${FLOOR().code} · ${FLOOR().name}`,duration:4.5});}
  const b=boss,show=!!(b&&FLOOR().boss&&!b.dead&&b.act!=='toll'&&BOSS_UP_ACTS.has(b.act)),bar=$('bossBar');
  if(bar.hidden===show)bar.hidden=!show;
  if(show){$('bossFill').style.width=(Math.max(0,b.hp)/b.stats.hp*100).toFixed(1)+'%';bar.classList.toggle('enraged',b.phase===2);}
}
function bossSnapshot(){
  const b=boss;if(!b||!FLOOR().boss)return null;
  return {kind:b.kind,act:b.act,hp:b.hp,maxHp:b.stats.hp,phase:b.phase,x:b.pos.x,z:b.pos.z,dead:b.dead,visible:b.g.visible,holding:bossHolds(),summoned:b.summoned,sink:b.sink,
    bell:bossBell?bossBell.rotation.z:null};
}
function sBell(volume){
  if(!AC||!bossBell)return;const n=AC.currentTime,p=makePanner(8,.6);setPos(p,bossBell.position.x,bossBell.position.y,bossBell.position.z);
  for(const [ratio,amp,decay] of [[.5,.45,6],[1,1,5],[2.01,.55,3.6],[2.42,.42,3],[3,.3,2.4],[4.18,.2,1.6]]){
    const o=AC.createOscillator(),g=AC.createGain();o.type='sine';o.frequency.value=196*ratio;o.connect(g);g.connect(p);
    g.gain.setValueAtTime(.0001,n);g.gain.exponentialRampToValueAtTime(Math.max(.0002,volume*amp*.22),n+.008);g.gain.exponentialRampToValueAtTime(.0001,n+decay);o.start(n);o.stop(n+decay+.1);}
  logCue('world','bell');
}
function sRumble(x,z,duration){
  if(!AC)return;const n=AC.currentTime,p=makePanner(6,.7);setPos(p,x,.2,z);
  const s=noiseSrc(true),f=AC.createBiquadFilter(),g=AC.createGain();f.type='lowpass';f.frequency.value=90;s.connect(f);f.connect(g);g.connect(p);
  g.gain.setValueAtTime(.0001,n);g.gain.exponentialRampToValueAtTime(.9,n+.25);g.gain.exponentialRampToValueAtTime(.0001,n+duration);s.start(n,Math.random());s.stop(n+duration+.1);
  const o=AC.createOscillator(),og=AC.createGain();o.frequency.setValueAtTime(48,n);o.frequency.exponentialRampToValueAtTime(28,n+duration);o.connect(og);og.connect(p);
  og.gain.setValueAtTime(.0001,n);og.gain.exponentialRampToValueAtTime(.6,n+.2);og.gain.exponentialRampToValueAtTime(.0001,n+duration);o.start(n);o.stop(n+duration+.1);
  logCue('world','rumble');
}
// Seconds since the drawn gun last fired: the bolt-action and the revolver work their bolt and cylinder by it.
let shotT=9;
function updateGun(dt){
  const visible=gunOut&&['play','caught','pause'].includes(state);
  weaponModels.forEach((model,i)=>{model.visible=visible&&i===weaponIndex;if(!model.visible)model.userData.muzzleFlash.visible=false;});
  if(gunOut)torch.visible=false;
  if(!visible){setLight(muzzleLight,0);setLight(fpFlash,0);return;}
  if(state==='pause')return;
  const w=weaponDefs[weaponIndex];fireT-=dt;
  const loaded=mag;
  if(state==='play'&&(mouseDown||fireQueued)&&fireT<=0&&!P.running&&(w.automatic||!semiFired))fire();
  shotT=mag<loaded?0:shotT+dt;
  if(reloadT>0){reloadT=Math.max(0,reloadT-dt);if(reloadT===0){const take=infiniteAmmo()?w.capacity-mag:Math.min(w.capacity-mag,reserve);mag+=take;if(!infiniteAmmo())reserve-=take;weapons[weaponIndex]={mag,reserve};}}
  gunKick*=Math.exp(-dt*15);flashT-=dt;
  const progress=reloadT>0?1-reloadT/w.reload:0,rp=reloadT>0?Math.sin(Math.PI*progress):0;
  gun.userData.run=lerp(gun.userData.run||0,P.running?1:0,1-Math.exp(-dt*8));
  gun.userData.aim=lerp(gun.userData.aim||0,aiming&&!P.running&&!reloadT?1:0,1-Math.exp(-dt*12));
  const rk=gun.userData.run,ak=gun.userData.aim;
  const wp=camFX.pose.weapon;
  gun.position.set(lerp(GUN_BASE.x,.025,ak)+rk*.04+wp.x,lerp(GUN_BASE.y,-.12,ak)-rp*.16-rk*.08+wp.y,GUN_BASE.z+ak*.07+wp.z);
  gun.rotation.set(rp*.45-rk*.35+wp.pitch,rk*.38+wp.yaw,rp*.6+wp.roll);
  if(gun.userData.view){const v=gun.userData.view;gun.position.x+=lerp(v.hip[0],v.aim[0],ak);gun.position.y+=lerp(v.hip[1],v.aim[1],ak);gun.position.z+=lerp(v.hip[2],v.aim[2],ak);}
  if(gunMag)gunMag.visible=!(reloadT>0&&progress>.3&&progress<.65);
  if(gun.userData.bolt)gun.userData.bolt.position.z=(gun.userData.bolt.userData.restZ||0)+gunKick*.025;
  // A gun with its own action (revolver, bolt-action, belt feed) poses its magazine and bolt itself.
  if(gun.userData.pose)gun.userData.pose(reloadT>0?progress:-1,gunKick,shotT);
  const flashing=preferences.effects&&flashT>0;
  if(muzzleFlash){muzzleFlash.visible=flashing;if(flashing)muzzleFlash.rotation.z=Math.random()*6.28;}
  setLight(muzzleLight,flashing?3:0);setLight(fpFlash,flashing?3:0);
}

/* ---------- map ---------- */
const mapEl=$('map'),mapCtx=mapEl.getContext('2d');
function markVisited(){
  const cx=Math.floor(P.pos.x/S),cz=Math.floor(P.pos.z/S);
  if(cx>=0&&cz>=0&&cx<W&&cz<W)visited[cz*W+cx]=1;
}
// The plan is drawn in 150 units; the canvas behind it matches its shown size at the screen's pixel density (the minimap
// and the M floor plan), measured by a ResizeObserver so drawing never forces a layout.
let mapCss=0,mapGuns=[];
if(window.ResizeObserver)new ResizeObserver(entries=>{const w=entries[0].contentRect.width;if(w>0&&w!==mapCss){mapCss=w;mapT=0;}}).observe(mapEl);
function mapBacking(){
  const css=mapCss||mapEl.clientWidth||112,dpr=Math.min(2,Math.max(1,window.devicePixelRatio||1)),size=Math.max(64,Math.round(css*dpr));
  if(mapEl.width!==size){mapEl.width=size;mapEl.height=size;}
  mapCtx.setTransform(size/150,0,0,size/150,0,0);
  return {css,size};
}
// Gun pickups on the plan: a silhouette of each gun, muzzle east, in a 14-unit-high box `w` units long. Parts: r rect,
// q rounded rect, p polygon, c circle, l line [x0,y0,x1,y1,width]; tone 1 metal, 2 furniture.
const GUN_ICONS={
  rifle:{w:32,parts:[[2,'p',0,4.2,6.5,3.8,6.5,7.6,1.2,9,0,9],[1,'r',6,3.6,2,3],[1,'r',7.5,3,9.5,4],[1,'r',9,1.6,5,1.4],[2,'r',17,3.3,7.5,3.4],
    [1,'p',23.2,1.6,24.4,1.6,24.4,3.4,23.2,3.4],[1,'r',24.5,4.4,7.5,1.1],[2,'p',9.6,7,12.2,7,11.2,11.2,8.4,11.2],[2,'p',13.2,7,16.2,7,17.6,12.4,14.8,12.9]]},
  pistol:{w:18,parts:[[2,'p',1.2,5.4,6.8,5.4,5.6,13,0,12.6],[2,'r',3.5,5.4,13.5,1.6],[2,'p',6.6,7,10,7,9,9.4,6.4,9.4],[1,'r',.5,2.2,17.5,3.4]]},
  shotgun:{w:32,parts:[[2,'p',0,6.2,8.5,4.2,8.5,7.6,2.2,10.4,0,10.4],[1,'r',8.3,3.4,6.7,4],[1,'r',15,3.6,17,1.4],[1,'r',15,5.2,13.5,1.3],
    [2,'q',17.5,4.6,7.5,3.2,.8],[1,'c',31.3,3.3,.6],[1,'p',10,7.4,13,7.4,12.6,8.8,10.2,8.8]]},
  smg:{w:24,parts:[[2,'r',0,3,1.4,5.8],[1,'r',1,3.8,4,1.1],[1,'r',1,6,4,1.1],[1,'r',4.2,3,12.3,3.8],[1,'c',6.2,2.7,1.2],[1,'r',15.6,1.6,1.6,1.6],
    [1,'r',12,2.2,6.5,1],[2,'r',12.6,4,5.8,3.6],[1,'r',18.4,4.2,3.6,1.2],[2,'r',21,3.7,3,2.2],[2,'p',6.4,6.8,9,6.8,8,11.4,5.4,11.4],[2,'p',10.2,6.8,12.6,6.8,13.4,13.8,11,13.8]]},
  magnum:{w:24,parts:[[2,'p',2.4,6.2,6,6.2,5.6,9,4.8,13.2,2.4,13.6,.4,12.6,1.4,9],[1,'p',.8,.6,2.4,1.8,3.2,3.2,1.8,3],[1,'r',2.5,1.8,8.5,1],[1,'r',2.5,2.4,3,4.4],
    [1,'p',6,6.6,8.8,6.6,8,9,5.8,9],[1,'r',10,3.1,14,2.1],[1,'r',10,5.2,12.8,1.5],[1,'p',22,1.6,23.4,1.6,23.6,3.1,21.6,3.1],[2,'q',5,2.1,5.6,6,1.3]]},
  marksman:{w:36,parts:[[2,'p',0,4.4,3,4.4,5.5,6,9.5,6.4,23.5,6.2,23.5,7.8,9.5,8.8,4.5,10.4,0,11],[2,'p',7.4,8,9.8,8,9.4,11.8,6.8,11.8],
    [1,'r',10,4.8,9,1.8],[1,'p',19,4.9,36,5.2,36,6,19,6.3],[1,'r',11.2,3.4,1.2,1.6],[1,'r',17,3.4,1.2,1.6],[1,'r',9,2.2,12,1.4],
    [1,'p',20,2.2,22,1.2,23.2,1.2,23.2,4.6,22,4.6,20,3.6],[1,'p',7,1.6,9.6,1.9,9.6,3.9,7,4.2],[1,'r',14.2,1,1.6,1.4],[1,'l',12.2,6.4,12.8,8.3,.7],[1,'c',12.8,8.4,1.1]]},
  lmg:{w:34,parts:[[2,'p',0,3.4,7,4,7,8.2,0,9.6],[1,'l',27,6,25,13.4,.9],[1,'l',28,6,30.4,13.4,.9],[1,'r',7,2.8,12,5.2],[1,'r',8.5,1.8,9,1.2],
    [1,'r',20,.6,5,1.1],[1,'r',20.5,1.5,.9,2],[1,'r',23.6,1.5,.9,2],[1,'r',19,4.2,12,1.3],[2,'r',19,4.4,6,3.2],[1,'r',31,3.8,3,2.1],[1,'r',28.4,2,.9,2.4],
    [2,'p',8,8,10.6,8,9.6,12,7,12],[2,'q',11,8,6.6,5.6,.7]]}
};
const gunIconCache=new Map();
function gunIconPath(part){
  const p=new Path2D(),[,type,...v]=part;
  if(type==='r')p.rect(v[0],v[1],v[2],v[3]);
  else if(type==='q'){const [x,y,w,h,r]=v;p.moveTo(x+r,y);p.arcTo(x+w,y,x+w,y+h,r);p.arcTo(x+w,y+h,x,y+h,r);p.arcTo(x,y+h,x,y,r);p.arcTo(x,y,x+w,y,r);p.closePath();}
  else if(type==='c')p.arc(v[0],v[1],v[2],0,Math.PI*2);
  else if(type==='l'){p.moveTo(v[0],v[1]);p.lineTo(v[2],v[3]);}
  else{p.moveTo(v[0],v[1]);for(let i=2;i<v.length;i+=2)p.lineTo(v[i],v[i+1]);p.closePath();}
  return p;
}
// One gun's icon at `unit` device pixels per icon unit: a soft shadow, a black outline round the whole shape, then the
// parts in two tones. Painted once per kind and size, then only drawImage'd.
function gunIcon(kind,unit){
  const key=kind+':'+unit.toFixed(3);let icon=gunIconCache.get(key);if(icon)return icon;
  if(gunIconCache.size>40)gunIconCache.clear();
  const shape=GUN_ICONS[kind]||GUN_ICONS.rifle,line=Math.max(1.4,unit*.85),pad=Math.ceil(line*2+2);
  const canvas=document.createElement('canvas');canvas.width=Math.ceil(shape.w*unit)+pad*2;canvas.height=Math.ceil(14*unit)+pad*2;
  const x=canvas.getContext('2d');
  x.translate(pad,pad);x.scale(unit,unit);x.lineJoin=x.lineCap='round';
  const parts=shape.parts.map(part=>({part,path:gunIconPath(part),stroke:part[1]==='l'?part[6]:0}));
  for(const [color,extra] of [['rgba(0,0,0,.4)',2.4],['#080a09',0]])for(const {path,stroke} of parts){
    x.strokeStyle=color;x.lineWidth=(line*2+extra)/unit+stroke;x.stroke(path);}
  for(const {part,path,stroke} of parts){const tone=part[0]===1?'#eef0ea':'#a7b3b5';
    if(stroke){x.strokeStyle=tone;x.lineWidth=stroke;x.stroke(path);}else{x.fillStyle=tone;x.fill(path);}}
  icon={canvas,w:canvas.width,h:canvas.height,pad};gunIconCache.set(key,icon);return icon;
}
// Untaken guns on this floor, each centred on where it lies. mapGuns keeps where they were drawn (CSS px on the map).
function drawGunIcons(c,css,size){
  const scale=size/css,base=Math.max(Math.min(15,css*.17),Math.min(44,css*.078)),unit=base*scale/32;
  c.save();c.setTransform(1,0,0,1,0,0);mapGuns=[];
  for(const l of roomLoot)if(l.type==='weapon'&&!l.taken&&l.g.visible){
    const kind=weaponDefs[l.weapon].id,icon=gunIcon(kind,unit),x=l.x/(W*S)*size,z=l.z/(W*S)*size;
    c.drawImage(icon.canvas,Math.round(x-icon.w/2),Math.round(z-icon.h/2));
    mapGuns.push({id:l.id,kind,x:x/scale,z:z/scale,w:(icon.w-icon.pad*2)/scale,h:(icon.h-icon.pad*2)/scale});
  }
  c.restore();
}
function drawMap(){
  const {css,size}=mapBacking();
  const c=mapCtx,sz=150,k=sz/W;c.clearRect(0,0,sz,sz);
  for(let z=0;z<W;z++)for(let x=0;x<W;x++){
    if(visited[z*W+x]){c.fillStyle='rgba(216,208,194,.42)';c.fillRect(x*k,z*k,k+0.5,k+0.5);continue;}
    if(grid[z][x]!==1)continue;
    let seen=false;for(let dz=-1;dz<=1&&!seen;dz++)for(let dx=-1;dx<=1;dx++){const nx=x+dx,nz=z+dz;if(nx>=0&&nz>=0&&nx<W&&nz<W&&visited[nz*W+nx]){seen=true;break;}}
    if(seen){c.fillStyle='rgba(120,40,28,.85)';c.fillRect(x*k,z*k,k+0.5,k+0.5);}
  }
  for(const b of ammoBoxes){if(b.taken)continue;const bx=Math.floor(b.x/S),bz=Math.floor(b.z/S);if(visited[bz*W+bx]){c.fillStyle='#d8c35a';c.fillRect(b.x/S*k-1.5,b.z/S*k-1.5,3,3);}}
  for(const r of specialRooms){const x=(r.x+r.w/2)*k,z=(r.z+r.d/2)*k;
    if(r.shelter){c.strokeStyle='#89c7b7';c.lineWidth=1;c.strokeRect(x-2,z-2,4,4);}
    if(r.fuse&&!roomLoot.find(l=>l.room===r&&l.type==='fuse')?.taken){c.fillStyle='#e6b979';c.beginPath();c.moveTo(x,z-3);c.lineTo(x+3,z);c.lineTo(x,z+3);c.lineTo(x-3,z);c.fill();}
  }
  // Guns not taken yet: a silhouette of each.
  drawGunIcons(c,css,size);
  c.fillStyle=exitPowered?'#96eac5':'#df6f4d';c.fillRect((W-1)*k,(W-2)*k,k,k);
  if(visited[(W-2)*W+(W-1)]){c.fillStyle='#ff3322';c.fillRect((W-1)*k,(W-2)*k,k,k);}
  const px=P.pos.x/S*k,pz=P.pos.z/S*k,fx=-Math.sin(P.yaw),fz=-Math.cos(P.yaw);
  c.strokeStyle='#e0402e';c.lineWidth=1.5;c.beginPath();c.moveTo(px,pz);c.lineTo(px+fx*7,pz+fz*7);c.stroke();
  c.fillStyle='#fff';c.beginPath();c.arc(px,pz,2.2,0,7);c.fill();
  if(NET.inGame)for(const R of REMOTES.values())if(liveRemote(R)){c.fillStyle='#7fb2ff';c.beginPath();c.arc(R.pos.x/S*k,R.pos.z/S*k,2.2,0,7);c.fill();}
}
function updatePickups(){
  if(state!=='play')return;
  for(const l of roomLoot)if(!l.taken&&automaticLoot(l.type)&&pickupReach(l,P.pos))requestLoot(l);
  for(let i=0;i<ammoBoxes.length;i++){
    const b=ammoBoxes[i];if(b.taken||!pickupReach(b,P.pos))continue;
    if(NET.inGame&&NET.role==='guest'){if(!b.pending&&queueAction({type:'ammo',id:i}))b.pending=NET.actionSeq;continue;}
    b.taken=true;b.g.visible=false;rewardLoot('ammo');NET.tk.push(i);sPickup();
  }
}

/* ---------- torch ---------- */
function updateTorch(dt){
  if(torchOn){battery-=dt/420;if(battery<=0){battery=0;torchOn=false;sClick();showMsg('Torch depleted. Stay hidden while it recharges.');}}
  else battery=Math.min(1,battery+dt/100);
  let f=1;
  if(preferences.effects&&battery<.15)f=.93+.07*Math.sin(t*1.8);
  const base=4*(.65+.35*Math.min(1,battery/.3));
  setLight(spot,torchOn?base*f:0);setLight(bounce,torchOn?.32*f:0);setLight(fpTorchLight,torchOn?.8*f:0);
  const l=torchOn?f:0.08;lensMat.color.setRGB(l,l*0.92,l*0.8);
}

/* ---------- caught ---------- */
// The kill: HollowKillCam plays the creature's own choreography (camera, body, joints, timed blows), HollowKillFX
// paints the lens and HollowKillAudio the gore. The kill frame is fixed when it starts: the survivor's feet and the
// bearing to the creature (body frame: x right, y up, f forward).
const killCam=HollowKillCam.create(),killFX=window.HollowKillFX?HollowKillFX.create():null;
let killAudio=null,killKind=null;
const kill={on:false,hold:false,m:null,x:0,y:0,z:0,yaw:0,fx:0,fz:-1,rx:1,rz:0,face:{x:0,y:0,f:1},faceSeen:false,faceAt:new THREE.Vector3(),
  local:new THREE.Vector3(),off:new THREE.Vector3(),eye:new THREE.Vector3(),view:new THREE.Vector3(),dir:new THREE.Vector3(),voice:'stalker',shadows:[]};
const KILL_JOINTS=HollowKillCam.JOINTS;
function caught(m){
  if(!localInDanger())return;
  if(state==='pause'){showScreen(null);}
  state='caught';caughtT=0;caughtBy=m;torchOn=true;mouseDown=false;
  stopAudio();$('hud').hidden=true;$('msg').style.opacity=0;msgTimer=0;
  audioOnCaught(m);
  startKill(m,killKind||m.kind);
}
// Free space from the survivor along (dx, dz), at knee and chest height, up to `max` metres.
function killClear(dx,dz,max){for(let d=.1;d<max;d+=.1)if(blocksRay(P.pos.x+dx*d,.3,P.pos.z+dz*d)||blocksRay(P.pos.x+dx*d,1.1,P.pos.z+dz*d))return d;return max;}
function startKill(m,kind){
  const dx=m.pos.x-P.pos.x,dz=m.pos.z-P.pos.z,d=Math.hypot(dx,dz),yaw=d>.05?Math.atan2(-dx,-dz):P.yaw;
  kill.on=true;kill.m=m;kill.x=P.pos.x;kill.y=P.pos.y;kill.z=P.pos.z;kill.yaw=yaw;kill.faceSeen=false;
  kill.fx=-Math.sin(yaw);kill.fz=-Math.cos(yaw);kill.rx=Math.cos(yaw);kill.rz=-Math.sin(yaw);
  const f=HollowKillCam.FACE[m.kind]||HollowKillCam.FACE[kind]||HollowKillCam.FACE.stalker;kill.local.set(f[0],f[1],f[2]);
  kill.voice=HollowAudio.KIND_NAMES.includes(m.kind)?m.kind:'stalker';
  let yaw0=P.yaw-yaw;yaw0-=Math.round(yaw0/(2*Math.PI))*2*Math.PI;
  killCam.start(kind,{motion:preferences.motion,effects:preferences.effects,yaw0,pitch0:P.pitch,eye0:P.eye,dist0:d,ceiling:H,seed:monsters.indexOf(m)+1,
    back:killClear(-kill.fx,-kill.fz,4),left:killClear(-kill.rx,-kill.rz,3),right:killClear(kill.rx,kill.rz,3)});
  if(killFX)killFX.start({effects:preferences.effects,seed:(Math.random()*1e9)|0});
  if(AC&&!killAudio&&window.HollowKillAudio){try{killAudio=HollowKillAudio.create({context:AC,output:master,noiseBuffer:noiseBuf});}catch(e){killAudio=null;}}
  m.g.rotation.order='YXZ';
  // At arm's length the creature's body would shadow the whole torch beam: it stops casting for the kill.
  for(const o of kill.shadows)o.castShadow=true;kill.shadows.length=0;m.g.traverse(o=>{if(o.isMesh&&o.castShadow){o.castShadow=false;kill.shadows.push(o);}});
  killEvents(killCam.pose);
}
// World eye position and view direction of the current kill camera.
function killEye(){
  const c=killCam.pose.cam,Y=kill.yaw+c.yaw,cp=Math.cos(c.pitch);
  kill.eye.set(kill.x+kill.rx*c.x+kill.fx*c.f,kill.y+c.y,kill.z+kill.rz*c.x+kill.fz*c.f);
  kill.view.set(-Math.sin(Y)*cp,Math.sin(c.pitch),-Math.cos(Y)*cp);
}
function killEvents(p){
  if(!p.eventCount)return;
  const fxOn=preferences.effects,gore=fxOn?1:.35;killEye();
  for(let i=0;i<p.eventCount;i++){const e=p.events[i];
    if(e.type==='sfx'){if(killAudio&&killAudio.play(e.cue,{level:e.a,effects:fxOn,kind:p.track})!=null)logCue('kill',e.cue,p.track);}
    else if(e.type==='voice'){const w=kill.faceSeen?kill.faceAt:kill.eye;sVoice(kill.voice,e.cue,w.x,w.y,w.z,1);}
    else if(e.type==='heart'){if(killAudio)killAudio.heart(e.a,e.b);}
    else if(e.type==='flat'||e.type==='skip'){if(killAudio){killAudio.heart(0);if(e.type==='flat')killAudio.play('flat',{effects:fxOn});}}
    else if(e.type==='blood'){if(killFX)killFX.blood(e.b,e.c,e.a*(fxOn?1:.6));}
    else if(e.type==='spray'){
      // Lens blood is the overlay's: the world spray bursts off to one side of the view (its mist would fill the
      // screen in front of the lens) and rains onto the floor.
      if(atm){const s=Math.random()<.5?-1:1,h=Math.hypot(kill.view.x,kill.view.z)||1;
        kill.dir.set(kill.eye.x+kill.view.x*.9-s*kill.view.z/h*.6,Math.max(.25,kill.eye.y+kill.view.y*.9-.25),kill.eye.z+kill.view.z*.9+s*kill.view.x/h*.6);
        _atmNd.set(-s*kill.view.z/h,.8,s*kill.view.x/h);atm.blood(kill.dir.x,kill.dir.y,kill.dir.z,{dir:_atmNd,amount:Math.min(3,e.a*1.5*gore)});}
    }else if(e.type==='crack'){if(killFX)killFX.crack(e.a,e.b,e.c);}
    else if(e.type==='dirt'){if(killFX)killFX.dirt(e.b,e.c,e.a);if(atm)atm.debris(kill.eye.x,kill.eye.y+1.4,kill.eye.z,{dir:_atmNd.set(0,-1,0),color:0x3a2a1c,sparks:0});}
  }
}
function updateCaught(dt,force){
  caughtT+=dt;
  const p=killCam.update(kill.hold&&!force?0:dt,kill.faceSeen?kill.face:null),f=p.fx;
  killEvents(p);
  if(killAudio)killAudio.update(dt);
  setLight(spot,(preferences.effects?3.2:2.6)*f.light);setLight(bounce,.55*f.light);
  if(killFX)killFX.update(dt,f);
  if(!(fx&&fx.enabled))killCss(f);
  $('flash').style.opacity=0;danger=1;
  if(!p.done)return;
  if(NET.inGame){killEnd();coopLocalDone('dead');return;}
  state='dead';hideMonsters();setLight(spot,0);$('flash').style.opacity=0;gun.visible=false;
  const lasted=Math.round(elapsed*10)/10,m=Math.floor(lasted/60),s=Math.floor(lasted%60),own=runScore();
  $('deadText').textContent=`${p.line} You lasted ${m}:${String(s).padStart(2,'0')} in the dark${floor?`, ${FLOOR().outdoor?'out in':'down to'} ${FLOOR().code} · ${FLOOR().name}`:''}. ${FLOOR().outdoor?'The night is quiet again.':'The corridors are quiet again.'}`;
  $('retryDark').textContent=checkpoint&&checkpoint.floor?`Retry ${FLOOR().code} · ${FLOOR().name}`:'Re-enter the ward';
  showScreen('dead');recordRun({mode:'solo',escaped:false,time:elapsed,kills:own.kills,score:own.points},'deadRank');try{document.exitPointerLock();}catch(e){}
}
// The kill pose on the creature's joints (the rest of the live pose stays: legs keep their stance).
function killJoints(pose){
  const k=killCam.pose,J=pose.joints;
  for(let i=0;i<KILL_JOINTS.length;i++){const j=J[KILL_JOINTS[i][0]];if(!j)continue;const a=KILL_JOINTS[i][1];if(k.jointSet[i])j[a]=k.joints[i];else j[a]+=k.joints[i];}
}
// Places the creature so its face lands on the track's face target (or its feet on the floor when grounded), from
// the posed rig itself, so any model (or a stand-in) is framed the same way.
function killPlace(m){
  const g=m.g,u=g.userData,mo=killCam.pose.mon,c=killCam.pose.cam;
  g.rotation.set(mo.pitch,kill.yaw+mo.yaw,mo.roll);g.position.set(0,0,0);g.visible=true;g.updateMatrixWorld(true);
  const off=u.head?u.head.localToWorld(kill.off.copy(kill.local)):kill.off.set(0,u.headHeight||2,0);
  const tx=mo.x+mo.follow*c.x,ty=mo.y+mo.follow*c.y,tf=mo.f+mo.follow*c.f;
  const wx=kill.x+kill.rx*tx+kill.fx*tf,wz=kill.z+kill.rz*tx+kill.fz*tf;
  const py=lerp(kill.y+ty-off.y,kill.y+mo.drop,clamp01(mo.ground));
  g.position.set(wx-off.x,py,wz-off.z);
  kill.face.x=tx;kill.face.f=tf;kill.face.y=py+off.y-kill.y;kill.faceSeen=true;kill.faceAt.set(wx,py+off.y,wz);
}
// The kill camera replaces the rig's view; the gun is knocked out of the hands.
function killView(cam){
  const c=killCam.pose.cam;killEye();
  camera.position.copy(kill.eye);camera.rotation.set(c.pitch,kill.yaw+c.yaw,c.roll);cam.fov=c.fov;
  const g=killCam.pose.fx.gun;
  if(g>0){gun.position.y-=g*.6;gun.position.x+=g*.14;gun.rotation.z+=g*1.5;gun.rotation.x-=g*.9;if(g>=.999)gun.visible=false;}
}
function killPost(u){
  const f=killCam.pose.fx;
  u.danger.value=1;u.damage.value=Math.max(u.damage.value,Math.min(1,f.flash*.8+f.red*.45));u.health.value=1-.9*Math.min(1,f.tunnel);
  u.saturation.value*=1-.85*Math.min(1,f.desat);u.killFlash.value=0;
  if(u.aberration)u.aberration.value=Math.min(1,f.aberr+f.flash*.3);
  if(u.slowmo)u.slowmo.value=Math.min(1,f.blur)*(preferences.motion?1:.3);
}
// Without the post pipeline the kill grades the canvas itself: drained, hardened, blurred, and warped by a scream.
function killCss(f){
  const a=preferences.effects&&preferences.motion?Math.min(1,f.aberr):0,b=Math.min(1,f.blur)*(preferences.motion?1:.3);
  canvas.style.filter=`saturate(${(1-.8*f.desat).toFixed(3)}) contrast(${(1+.25*f.red).toFixed(3)})${b>.02?` blur(${(b*2.5).toFixed(2)}px)`:''}`;
  canvas.style.transform=a>.02?`scale(${(1+.05*a).toFixed(3)}) skew(${(a*1.6*Math.sin(t*41)).toFixed(2)}deg,${(a*.9*Math.sin(t*33)).toFixed(2)}deg)`:'';
}
function killEnd(){
  if(!kill.on)return;
  kill.on=false;kill.hold=false;kill.faceSeen=false;killCam.stop();
  for(const o of kill.shadows)o.castShadow=true;kill.shadows.length=0;
  if(killFX)killFX.stop();if(killAudio)killAudio.stop(.35);
  if(!(fx&&fx.enabled))canvas.style.filter='none';
  canvas.style.transform='';
}
function killSkip(){if(state==='caught'&&kill.on&&killCam.skip())killEvents(killCam.pose);}
addEventListener('pointerdown',()=>{if(state==='caught')killSkip();});
addEventListener('keydown',e=>{if(state==='caught'&&!e.repeat&&['Space','Enter','Escape'].includes(e.code))killSkip();});
function killSnapshot(){
  const s=killCam.snapshot(),g=caughtBy&&caughtBy.g;
  return {...s,on:kill.on,hold:kill.hold,line:killCam.pose.line,face:kill.faceSeen?{x:kill.face.x,y:kill.face.y,f:kill.face.f}:null,
    eye:kill.on?{x:kill.eye.x,y:kill.eye.y,z:kill.eye.z}:null,
    body:kill.on&&g?{x:g.position.x,y:g.position.y,z:g.position.z,pitch:g.rotation.x,yaw:g.rotation.y,roll:g.rotation.z,visible:g.visible}:null,
    overlay:killFX?killFX.snapshot():null,audio:killAudio?killAudio.snapshot():null};
}
/* ---------- grain ---------- */
const gc=$('grain').getContext('2d'),gimg=gc.createImageData(256,144);
function drawGrain(){const d=gimg.data;for(let i=0;i<d.length;i+=4){const v=Math.random()*255;d[i]=d[i+1]=d[i+2]=v;d[i+3]=255;}gc.putImageData(gimg,0,0);}

/* ---------- loop ---------- */
const timer=new THREE.Timer();let frame=0,hudT=0,baseFov=72;
// Pipeline warm-up while the menu idles: compile the play-state lighting, monsters and weapons ahead of time so
// pressing Play does not stall on shader/pipeline builds. The menu frame is not redrawn while the hell state is staged.
let warming=false,warmed=false,prebuiltSeed=0;const warmCam=new THREE.PerspectiveCamera(100,1.6,.04,120);warmCam.rotation.order='YXZ';
async function warmPlayPipelines(){
  if(warming||warmed||state!=='menu'||typeof renderer.compileAsync!=='function')return;
  warming=warmed=true;
  const views=[[PED.x-.85,PED.z],[W*S/2,W*S/2]],yaws=[0,Math.PI/2,Math.PI,-Math.PI/2];
  try{
    // Build the next dark run's B1 world now, unless one is already waiting (Play then skips the ~1-2 s build), and
    // compile it in its play lighting. Play always starts on B1, whichever floor the last run ended on.
    HollowVisuals.settleSurfaces();
    floor=0;if(!prebuiltSeed){const seed=1+Math.floor(Math.random()*2e9);buildMazeSeeded(seed);prebuiltSeed=seed;}
    // Let the title breathe between the build and the rest: a Play click made meanwhile enters this ward at once.
    await new Promise(resolve=>setTimeout(resolve,0));
    if(state!=='menu')return;
    setHell();weaponModels.forEach(g=>g.visible=true);
    // Fill the navigator's per-radius clearance caches, which the first monster paths would otherwise build mid-play.
    if(mazeNavigator)for(const kind in RULES.MONSTERS)if(!RULES.MONSTERS[kind].boss)for(const [cx,cz] of [[W-2,W-2],[W-2,3],[3,W-2],[N,N]])if(openCell(cx,cz))mazeNavigator.path(PED.x+1,PED.z,cx*S+S/2,cz*S+S/2,RULES.MONSTERS[kind].radius);
    monsters.forEach((m,i)=>{m.g.visible=true;m.g.position.set(views[0][0]+3+(i%4)*.9,0,views[0][1]-1.5+Math.floor(i/4)*1.2);m.g.updateMatrixWorld(true);});
    avatar.visible=true;avatar.userData.weapons.forEach(g=>g.visible=true);avatar.position.set(views[0][0]+2,0,views[0][1]+1.5);avatar.updateMatrixWorld(true);
    dynamicWorld.updateMatrixWorld(true);
    warmCam.aspect=camera.aspect;warmCam.updateProjectionMatrix();
    for(const [x,z] of views)for(const yaw of yaws){
      if(state!=='menu'||graphicsDown)break;
      warmCam.position.set(x,EYE,z);warmCam.rotation.set(-.15,yaw,0);warmCam.updateMatrixWorld(true);
      // The atmosphere's prewarm stand-ins are staged in front of the warm camera so its pipelines compile too.
      if(atm){atm.prewarm();_atmIn.cameraPosition=warmCam.position;warmCam.getWorldDirection(_atmDir);_atmIn.torchOn=true;atm.update(0,_atmIn);_atmIn.cameraPosition=camera.position;}
      await renderer.compileAsync(scene,warmCam);
    }
    if(state==='menu'&&!graphicsDown)await renderer.compileAsync(fpScene,camera);
  }catch(e){console.warn('[The Hollow] pipeline warm-up skipped:',e);}
  finally{
    warming=false;renderRequested=true;
    if(state==='menu'){monsters.forEach(m=>m.g.visible=false);weaponModels.forEach(g=>g.visible=false);}
    if(!NET.inGame){avatar.visible=false;avatar.userData.weapons.forEach((g,i)=>g.visible=i===RIGS[0].weapon);}
  }
}
function updateAtmosphere(dt){
  if(!atm)return;
  for(const l of practicalLights){const c=l.userData.cone;if(c)c.setIntensity(l.visible?l.intensity/(1.75*l.userData.scale):0);}
  const ch=typeof chaos!=='undefined'?chaos:null;
  if(ch&&typeof ch.beacon==='function')for(let i=0;i<atmBeacons.length;i++){const s=ch.beacon(i),b=atmBeacons[i];b.setActive(s.on);b.setAngle(s.angle);b.setIntensity(s.intensity);}
  atmBeam.setIntensity(qualityLevel==='low'?0:spot.userData.level/4);
  camera.getWorldDirection(_atmDir);_atmIn.torchOn=spot.userData.level>0;_atmIn.danger=danger;
  atm.update(state==='pause'?0:dt,_atmIn);
}
// The post pipeline draws vignette/grain/danger/damage itself: the CSS layers it replaces are zeroed while it runs
// (#healthVignette stays the CSS injury frame).
function hideCssPostOverlays(){
  for(const id of ['grain','vignette','danger','flash']){const s=$(id).style;if(s.opacity!=='0')s.opacity=0;}
  if(canvas.style.filter!=='none')canvas.style.filter='none';
}
function updatePostFX(dt){
  if(!fx)return;
  const u=fx.uniforms,hell=state!=='menu';
  fxKill=Math.max(0,fxKill-dt/.35);fxFlash=Math.max(0,fxFlash-dt*6);
  u.danger.value=state==='play'||state==='caught'?Math.min(1,danger+(state==='caught'?.3:0)):0;
  u.damage.value=state==='play'||state==='caught'?Math.min(1,damageT/1.05*hurtPulse):0;
  u.health.value=1;
  u.grain.value=hell?.35:.1;u.vignette.value=hell?.5:.3;
  u.saturation.value=hell?1:1.06;
  u.killFlash.value=fxKill;u.flash.value=fxFlash;
  if(kill.on)killPost(u);
}
function updateHealthVignette(){
  const active=state==='play'||state==='caught'||state==='pause'&&prevState==='play';
  const injury=active?RULES.injuryLevel(P.health):0;
  $('healthVignette').style.opacity=(injury*.98).toFixed(3);
  $('healthVignette').style.setProperty('--injury-clear',(65-injury*33).toFixed(1)+'%');
}
function updateHUD(){
  const active=state==='play',w=weaponDefs[weaponIndex],touch=controls?controls.touch:IS_TOUCH;
  $('hud').hidden=!active;$('ammo').hidden=!(active||state==='spect');$('cross').hidden=!active;
  $('hud').querySelector('.vitals-panel').hidden=!active;
    const room=active&&specialRooms.find(r=>RULES.insideRoom(r,P.pos.x,P.pos.z));
    const T=TEXT();
    $('locationText').textContent=active?(room?room.name:T.areas[P.pos.z<36?0:P.pos.z<72?1:2]):'';
    $('horrorCaption').textContent=active?captionText:'';
    $('escapeStatus').textContent=active&&exitPowered?(exitOpen?T.released:bossHolds()?'THE GRAVEKEEPER HOLDS THE GATE':T.releasing+' · '+Math.ceil(exitRelease)+'s'):'';
    document.body.classList.toggle('reading-record',active&&captionT>0&&captionText[0]!=='[');
  if(controls)controls.update({active,state,torchOn,canInteract:!!interaction,decoys,mapExpanded});
  if(!active)return;
  aboveGroundHUD();
  $('batBar').style.width=(battery*100).toFixed(1)+'%';$('batBar').style.background=battery<.2?'var(--ember)':'var(--bone)';
  $('stamBar').style.width=(P.stamina*100).toFixed(1)+'%';$('stamBar').style.background=P.exhausted?'var(--ember)':'var(--bone)';$('stamRow').style.opacity=1;
  $('healthBar').style.width=P.health+'%';$('healthBar').style.background=P.health<35?'var(--critical)':'var(--bone)';$('healthText').textContent=Math.ceil(P.health)+'%';$('healthText').style.color=P.health<35?'var(--critical)':'';
  $('noiseBar').style.width=Math.round(P.noise*100)+'%';$('stanceText').textContent=P.hidden?'CONCEALED':slideT>0?'SLIDING':P.crouching?'CROUCHED':P.running?'SPRINTING':P.onGround?'STANDING':'AIRBORNE';
  const remaining=roomLoot.filter(l=>l.type==='fuse'&&!l.taken).sort((a,b)=>Math.hypot(a.x-P.pos.x,a.z-P.pos.z)-Math.hypot(b.x-P.pos.x,b.z-P.pos.z));
  const nearest=remaining[0];
  $('objectiveText').textContent=exitOpen?T.go:bossHolds()?'KILL THE GRAVEKEEPER · then run for the gate':exitPowered?'THE ALARM IS DRAWING THEM HERE':fuses===3?T.ready:`${fuses} / 3 ${T.tags} · ${nearest?nearest.room.name.slice(5):'search marked rooms'}`;
  $('floorText').textContent=FLOOR().code+' · '+FLOOR().name.toUpperCase();$('wingText').textContent=T.wing;
  $('fpsText').textContent=Math.round(1000/frameAverage)+' FPS · '+qualityLevel.toUpperCase()+(renderScale<1?' '+Math.round(renderScale*100)+'%':'');
  $('weaponName').textContent=w.name;$('magTxt').textContent=mag;$('resTxt').textContent='/ '+(infiniteAmmo()?'∞':reserve);$('magTxt').style.color=mag===0?'var(--ember)':'';
  $('ammoLbl').textContent=reloadT>0?`RELOADING · ${reloadT.toFixed(1)}s`:aiming?'AIMING':WEAPON_ACTION[w.id]||(w.automatic?'AUTOMATIC':'SEMI-AUTOMATIC');
  if($('weaponSlots').children.length!==weaponDefs.length){$('weaponSlots').textContent='';weaponDefs.forEach((v,i)=>{const slot=document.createElement('span');slot.textContent=(i+1)+' '+(WEAPON_TAG[v.id]||v.id.toUpperCase());$('weaponSlots').appendChild(slot);});}
  [...$('weaponSlots').children].forEach((slot,i)=>{slot.classList.toggle('selected',i===weaponIndex);slot.classList.toggle('locked',!owned[i]);slot.title=owned[i]?weaponDefs[i].name:'Not found yet';});
  $('reticleHit').style.opacity=hitMarkerT>0?1:0;$('cross').classList.toggle('aiming',aiming);
  let prompt='';const key=touch?'USE':'[E]';
  if(interaction){
    if(interaction.type==='door'){const d=interaction.item,inside=RULES.insideRoom(d.room,P.pos.x,P.pos.z);prompt=d.open?`${key} Close isolation door`:d.locked?(inside?`${key} Unlock & open · lock integrity ${Math.ceil(d.health)}%`:'Door locked from inside'):inside?`${key} Lock door · crouch + torch OFF to hide`:`${key} Open isolation door`;}
    if(interaction.type==='loot'){const type=interaction.item.type;prompt=`${key} ${type==='fuse'?T.take:type==='medical'?'Use field dressing · +45 health':type==='weapon'?'Take the '+weaponDefs[interaction.item.weapon].name:'Collect ammunition, battery & decoy'}`;}
    if(interaction.type==='record')prompt=captionT>6?'':`${key} Read ${readNotes.has(interaction.item.id)?'case note again':'case note'}`;
        if(interaction.type==='exit')prompt=fuses===3?`${key} ${T.start} · ${FLOOR().boss?'the bell will toll':'alarm will sound'}`:T.need(3-fuses);
  }else if([...roomLoot.filter(l=>automaticLoot(l.type)),...ammoBoxes].some(l=>!l.taken&&pickupReach(l,P.pos,2.4)))prompt='WALK OVER · ammunition collects automatically';
  else if(P.hidden)prompt='CONCEALED · Stay quiet. Listen for footsteps to fade.';
  else if(currentShelter())prompt='SHELTER · Close and lock the door. Crouch. Torch off.';
  else if(simulationTime<15)prompt=`MAP · amber diamonds = ${T.many} · gun icons = weapons · green squares = shelters · red = exit`;
  $('interactionPrompt').textContent=prompt;
  $('controlsHint').textContent=touch?'Left stick: move · Drag right: look · USE: interact':
    P.hidden?'E unlock & leave · Keep your torch off until the footsteps fade':
    mag===0?'R reload · Q switch weapon · V throw a noise decoy':
    P.running?'C while sprinting: slide · Release SHIFT to aim and fire':
    simulationTime<20?'WASD move · SHIFT sprint · C crouch · E use · F torch · M floor plan':'';
}
function stepSurvival(dt){
  simulationTime+=dt;updatePlayer(dt);updateRooms(dt);updateHorror(dt);updateThreats(dt);hitsStep(dt);
  updateTorch(dt);updatePickups();markVisited();
  chaosStep(dt);
}
function loop(){
  requestAnimationFrame(loop);
  timer.update();const rawDt=timer.getDelta(),dt=Math.min(.05,rawDt);t+=dt;frame++;
  const sdt=dopaFrame(rawDt,dt);
  if(rawDt>0&&!document.hidden)frameAverage=lerp(frameAverage,Math.min(rawDt*1000,1000),.065);
  autoQuality(rawDt);
  if(state==='play'){
    elapsed+=rawDt;stepSurvival(sdt);
    if(exitOpen&&NET.inGame&&P.pos.x>W*S+.6){coopLocalDone('out');}
    else if(exitOpen&&P.pos.x>W*S+.6&&floor<RULES.FLOORS.length-1)descend();
    else if(exitOpen&&P.pos.x>W*S+.6){
      state='win';const m=Math.floor(elapsed/60),s=Math.floor(elapsed%60);
      const kills=monsters.filter((o,i)=>i<monCount&&o.dead).length;
      $('winText').textContent=FLOOR().boss?`The Gravekeeper lies in its own grave, and the bell is quiet. You walked out of Blackwater in ${fmtTime(elapsed)}.`:`Cold air on your face. You got out in ${fmtTime(elapsed)}. Behind you, ${kills>=monCount?'nothing is walking any more':'something keeps walking'}.`;
      $('winRank').textContent='';
      const own=runScore();clearCampaign();
      showScreen('win');recordRun({mode:'solo',escaped:true,time:elapsed,kills:own.kills,score:own.points},'winRank');try{document.exitPointerLock();}catch(e){}
      stopAudio();if(droneGain)fadeTo(droneGain,0,2);mouseDown=false;
    }
    if(droneGain){const target=preferences.effects?.025+fuses*.006:.014;droneGain.gain.setTargetAtTime(target,AC.currentTime,1.2);}
  }else if(state==='caught')updateCaught(Math.min(.25,rawDt));
  if(NET.inGame){
    if(state!=='play'&&state!=='caught'&&state!=='coopEnd'){elapsed+=rawDt;simulationTime+=dt;updateRooms(dt);updateThreats(dt);}
    netTick(dt);
  }
  if(state==='play'||state==='caught'||(NET.inGame&&state!=='coopEnd'))monsters.forEach(m=>animateMonster(m,sdt));
  if(kill.on&&state!=='caught'&&state!=='dead')killEnd();
  if(!['menu','pause','dead','win','coopEnd'].includes(state))updateCameraRig(dt);
  updateGun(dt);updatePuffs(dt,sdt);
  if(msgTimer>0){msgTimer-=dt;if(msgTimer<=0)$('msg').style.opacity=0;}

  // camera
  const spectating=state==='spect'||(state==='pause'&&prevState==='spect'),cam=camFX.pose;
  if(spectating){
    const R=watched();camera.position.set(R.pos.x,(R.raw.y||0)+(R.raw.crouch?1:EYE),R.pos.z);camera.rotation.set(R.pitch,R.yaw,0);
  }else{
    camera.rotation.set(P.pitch+cam.rot.pitch,P.yaw+cam.rot.yaw,cam.rot.roll);
    camera.position.set(P.pos.x,P.pos.y+P.eye,P.pos.z);
    camera.translateX(cam.pos.x);camera.translateY(cam.pos.y);camera.translateZ(cam.pos.z);
    if(state==='caught'&&kill.on)killView(cam);
  }
  baseFov=lerp(baseFov,aiming&&!reloadT&&!P.running?55:72,1-Math.exp(-dt*10));
  const fov=baseFov+(spectating?0:cam.fov);
  if(Math.abs(camera.fov-fov)>.01){camera.fov=fov;camera.updateProjectionMatrix();}
  torch.position.y=-0.27+cam.weapon.y;
  sky.position.copy(camera.position);
  updateListener();
  audioFrame(dt);

  updateHealthVignette();
  const post=!!(fx&&fx.enabled);
  if(post)hideCssPostOverlays();
  else{
  $('danger').style.opacity=preferences.effects&&(state==='play'||state==='caught')?Math.min(.8,danger*.5+(state==='caught'?.3:0)):0;
  if(state==='play')$('flash').style.opacity=preferences.effects&&damageT>.7?Math.max(0,(damageT-.7)*.7):0;
  }
  hudT-=dt;if(hudT<=0){hudT=.08;updateHUD();}
  if(state==='play'||state==='spect'){mapT-=dt;if(mapT<=0){mapT=.2;drawMap();}}
  if(!post&&preferences.effects&&qualityLevel!=='low'&&frame%6===0)drawGrain();
  camera.updateMatrixWorld();fpRig.position.copy(camera.position);fpRig.quaternion.copy(camera.quaternion);
  fpHemi.color.copy(hemi.color);fpHemi.groundColor.copy(hemi.groundColor);setLight(fpHemi,Math.max(.25,hemi.userData.level*.9));
  if(state==='play'||state==='spect'){
    for(const r of specialRooms)r.group.visible=Math.hypot(r.group.position.x-camera.position.x,r.group.position.z-camera.position.z)<38;
    for(const m of monsters)m.g.visible=!!m.spawned&&(!m.dead&&Math.hypot(m.pos.x-camera.position.x,m.pos.z-camera.position.z)<42||m.dead&&m.deadT<18&&Math.hypot(m.pos.x-camera.position.x,m.pos.z-camera.position.z)<25);
  }
  updateAtmosphere(sdt);updatePostFX(dt);
  renderer.info.reset();
  // The ward's decor surfaces may still be coming from prepaint.js's workers: wait for them (up to ~10 s) rather than
  // paint them again here.
  if(state==='menu'&&!warmed&&frame>20&&(frame>600||!window.HollowPrepaint||HollowPrepaint.finished))warmPlayPipelines();
  // The title screens are opaque. Nothing is drawn behind them until the warm-up has compiled the play pipelines
  // without blocking (it then asks for one frame); an earlier frame would compile them all while the menu froze.
  if(state==='menu'&&(warming||!warmed))return;
  if(['menu','pause','dead','win','coopEnd'].includes(state)&&!renderRequested&&lastRenderedState===state)return;
  renderRequested=false;lastRenderedState=state;
  HollowVisuals.settleSurfaces();
  if(fx){fx.render(dt);renderCalls=renderer.info.render.drawCalls;renderedFrames++;return;}
  // clear -> world -> clear depth -> viewmodel, expressed with auto-clear flags: an explicit clear()/clearDepth()
  // would add a full-screen output (tone-mapping) pass each. The world renders straight into the renderer's own HDR
  // frame buffer (internal to three r187), so tone mapping and sRGB output run once, after the viewmodel.
  const hdr=renderer.needsFrameBufferTarget&&typeof renderer._getFrameBufferTarget==='function'?renderer._getFrameBufferTarget():null;
  if(hdr)renderer.setRenderTarget(hdr);renderer.render(scene,camera);if(hdr)renderer.setRenderTarget(null);
  renderer.autoClearColor=false;renderer.render(fpScene,camera);renderer.autoClearColor=true;
  renderCalls=renderer.info.render.drawCalls;renderedFrames++;
}

/* ---------- co-op (two to four players over the live room) ---------- */
const NET={room:null,roomState:'loading',g:null,code:null,role:null,inGame:false,recorded:false,gen:0,seed:0,shots:0,tk:[],dm:[],ff:{},myPeer:null,sendT:0,joinT:0,over:false,unsubs:[],actions:[],actionSeq:0,actionAck:0,ackSeen:0,claimed:new Set(),joining:false,joinToken:0,spect:null,watched:null,pts:[],ptsKey:''};
// Everyone else in the room, keyed by peer id: the host sees every guest, a guest sees the host and the other guests.
const REMOTES=new Map(),MAX_GUESTS=3;
function newRemote(peer){return {present:false,peer,role:'',nm:'Partner',lastNm:'',gn:-1,al:1,out:0,sh:0,lastSh:0,ff:0,ffApplied:0,tk:[],dm:[],dmApplied:new Array(MAX_MON).fill(0),ph:'',seed:0,mc:0,mon:null,el:0,
  raw:{x:0,z:0,y:0,yaw:0,pitch:0,torch:false,run:false,crouch:false,hidden:false,reload:false,aim:false,health:100,weapon:0},pos:new THREE.Vector3(),vx:0,vz:0,yaw:0,pitch:0,stepD:0,seen:false,actions:[],actionAck:0,grants:[],gk:0,rig:null};}
const partners=()=>[...REMOTES.values()].filter(r=>r.present);
const anyPartner=()=>partners().length>0;
const inRound=r=>r.present&&r.gn===NET.gen;
const liveRemote=r=>inRound(r)&&r.al&&!r.out;
const hostRemote=()=>partners().find(r=>r.role==='host')||null;
const nameList=list=>list.map(r=>r.nm).join(', ');
// Awake creatures in a co-op round: 12 for two survivors, two more for each extra one (B1's sleepers fill the slots left).
const coopHunters=players=>12+2*Math.max(0,Math.min(4,players)-2);
const HUNTER_WORDS={12:'Twelve',14:'Fourteen',16:'Sixteen'};
// The partner a spectator watches: the chosen one while they live, else the first living partner.
function spectRemote(){let r=NET.spect?REMOTES.get(NET.spect):null;if(!r||!liveRemote(r)){r=partners().find(liveRemote)||null;NET.spect=r?r.peer:null;}if(r)NET.watched=r;return r;}
const NOBODY={nm:'Partner',pos:new THREE.Vector3(),raw:{},yaw:0,pitch:0,al:0};
function watched(){return spectRemote()||NET.watched||NOBODY;}
function cycleSpect(){const live=partners().filter(liveRemote);if(live.length<2)return;const i=live.findIndex(r=>r.peer===NET.spect);const r=live[(i+1)%live.length];NET.spect=r.peer;NET.watched=r;showMsg(`Watching ${r.nm}.`,2);}
function seeded(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
function buildMazeSeeded(seed){worldSeed=seed;prebuiltSeed=0;const o=Math.random;Math.random=seeded(seed);try{buildMaze();}finally{Math.random=o;}}
const r2=v=>Math.round(v*100)/100;
// A partner's bullet hurts like a creature's bite: ~12 per rifle round, ~16 per pistol round, a close shotgun blast ~75.
const FRIENDLY_FIRE=12;

// a partner's body in the world: the modelled survivor carrying their equipped weapon, with a shoulder torch.
// One rig per partner, made when they first appear and reused when another takes their place.
const RIGS=[];
function makeRig(){
  const avatar=HollowVisuals.makeSurvivor(THREE);avatar.visible=false;scene.add(avatar);const rig=avatar.userData;
  const spot=physical(new THREE.SpotLight(0xfff1d6,0,22,0.42,0.55),5,0.5);spot.position.set(0,0,-0.06);rig.torch.add(spot);
  const tgt=new THREE.Object3D();tgt.position.set(0.1,-0.25,-6);rig.torch.add(tgt);spot.target=tgt;
  const flash=physical(new THREE.PointLight(0xffb060,0,10),5,1);
  const [labelCv]=cv(256,64),labelTex=new THREE.CanvasTexture(labelCv);
  const label=new THREE.Sprite(new THREE.SpriteMaterial({map:labelTex,transparent:true,depthWrite:false,fog:false}));label.scale.set(0.9,0.225,1);label.position.y=2.12;avatar.add(label);
  const o={avatar,spot,flash,label,labelTex,labelCv,weapon:-1,owner:null};setAvatarWeapon(o,0);
  spot.visible=NET.inGame;flash.visible=NET.inGame&&qualityLevel!=='low';RIGS.push(o);return o;
}
function setAvatarWeapon(o,i){
  if(i===o.weapon)return;o.weapon=i;o.avatar.userData.setWeapon(i);
  const w=o.avatar.userData.weapons[i]||o.avatar.userData.weapons[0];w.add(o.flash);o.flash.position.copy(w.userData.muzzlePosition);
}
function setAvatarName(o,n){const x=o.labelCv.getContext('2d');x.clearRect(0,0,256,64);x.font='30px "Special Elite",monospace';x.textAlign='center';x.textBaseline='middle';
  x.fillStyle='rgba(0,0,0,.55)';const w=Math.min(250,x.measureText(n).width+24);x.fillRect(128-w/2,12,w,40);x.fillStyle='#9fc1ff';x.fillText(n,128,33);o.labelTex.needsUpdate=true;}
function claimRig(r){if(r.rig)return r.rig;const o=RIGS.find(o=>!o.owner)||makeRig();o.owner=r.peer;r.rig=o;r.lastNm='';return o;}
function releaseRig(r){if(!r.rig)return;r.rig.owner=null;r.rig.avatar.visible=false;setLight(r.rig.spot,0);setLight(r.rig.flash,0);r.rig=null;}
function rigLights(on){for(const o of RIGS){o.spot.visible=on;o.flash.visible=on&&qualityLevel!=='low';if(!on)o.avatar.visible=false;}}
const avatar=makeRig().avatar;

function sStepAt(x,z,vol){if(!AC)return;const n=AC.currentTime,p=makePanner(1.8,1.2);setPos(p,x,0.1,z);const s=noiseSrc(),f=AC.createBiquadFilter(),g=AC.createGain();
  f.type='lowpass';f.frequency.value=rnd(380,700);s.connect(f);f.connect(g);g.connect(p);env(g,n,0.006,vol,0.13);s.start(n,Math.random());s.stop(n+0.2);}

async function initNet(){
  try{NET.room=await claude.use('room');}catch(e){NET.room=null;}
  NET.roomState=NET.room?'ok':'none';
}
function coopErr(t){$('coopErr').textContent=t||'';}
async function openCoop(){
  state='menu';showScreen('coop');coopErr('');
  if(NET.roomState!=='ok'){coopErr('Connecting…');await initNet();coopErr('');}
  if(NET.g){$('coopChoose').hidden=true;$('coopLobby').hidden=false;renderLobby();}
  else{$('coopChoose').hidden=false;$('coopLobby').hidden=true;}
  if(NET.roomState==='none')coopErr('Can’t reach the game server. Check your internet connection and reload the page.');
}
function randCode(){const a='abcdefghjkmnpqrstuvwxyz23456789';let c='';for(let i=0;i<4;i++)c+=a[Math.floor(Math.random()*a.length)];return c;}
function dropRemotes(){for(const r of REMOTES.values())releaseRig(r);REMOTES.clear();NET.spect=null;NET.watched=null;NET.pts=[];NET.ptsKey='';}
async function joinRoom(code,role){
  if(!NET.room){coopErr('Can’t reach the game server. Check your connection and try again.');return false;}
  if(NET.joining||NET.g)return false;
  const joinToken=++NET.joinToken;NET.joining=true;$('coopCreate').disabled=true;$('coopJoinForm').querySelector('button').disabled=true;
  coopErr(role==='host'?'Opening a game…':'Joining…');
  try{const joined=await NET.room.join('hollow-'+code);if(joinToken!==NET.joinToken){await joined.leave();return false;}NET.g=joined;}
  catch(e){if(joinToken===NET.joinToken){NET.g=null;coopErr(e&&e.code==='limit_reached'?'That game is full.':e&&e.code==='not_permitted'?'The game server refused the connection.':'Couldn’t connect. Try again in a moment.');}return false;}
  finally{if(joinToken===NET.joinToken){NET.joining=false;$('coopCreate').disabled=false;$('coopJoinForm').querySelector('button').disabled=false;}}
  NET.code=code;NET.role=role;NET.gen=0;NET.inGame=false;NET.joinT=performance.now();dropRemotes();
  NET.g.presence({v:3,nm:(playerName||'Guest').slice(0,18),role,ph:'lobby',gn:0}).catch(()=>{});
  NET.unsubs.push(NET.g.onPeers(onPeers,()=>{coopErr('The connection to the game was lost.');if(NET.inGame&&!NET.over)coopShowEnd('Connection lost','Your connection was interrupted. Return to the menu to reconnect.',true);}));
  coopErr('');$('coopChoose').hidden=true;$('coopLobby').hidden=false;$('coopCode').textContent=code;
  renderLobby();
  if(role==='guest')setTimeout(()=>{if(joinToken===NET.joinToken&&NET.g&&NET.role==='guest'&&!hostRemote())coopErr('No game found with that code yet. Check the code, or wait for the host to open it.');},7000);
  return true;
}
async function leaveRoom(){
  NET.joinToken++;NET.joining=false;$('coopCreate').disabled=false;$('coopJoinForm').querySelector('button').disabled=false;
  NET.unsubs.forEach(u=>{try{u();}catch(e){}});NET.unsubs=[];
  const oldRoom=NET.g;
  NET.g=null;NET.inGame=false;NET.role=null;dropRemotes();rigLights(false);
  if(oldRoom){try{await oldRoom.leave();}catch(e){}}
}
function onPeers(ch){
  const peers=ch.peers;const me=peers.find(p=>p.sameTab);if(me)NET.myPeer=me.peer;
  const others=peers.filter(p=>!p.sameTab&&p.presence&&(p.presence.role==='host'||p.presence.role==='guest'));
  let list;
  if(NET.role==='host'){
    // The host admits up to three guests, oldest first, and tells everyone who is in.
    const keep=others.filter(p=>p.presence.role==='guest'&&REMOTES.has(p.peer)),fresh=others.filter(p=>p.presence.role==='guest'&&!REMOTES.has(p.peer));
    list=[...keep,...fresh].slice(0,MAX_GUESTS);
    const key=list.map(p=>p.peer).join(',');if(key!==NET.ptsKey){NET.ptsKey=key;NET.pts=list.map(p=>p.peer);if(NET.g)NET.g.presence({pts:NET.pts}).catch(()=>{});}
  }else{
    const host=others.find(p=>p.presence.role==='host');
    const pts=host&&Array.isArray(host.presence.pts)?host.presence.pts.filter(id=>typeof id==='string').slice(0,MAX_GUESTS):null;
    NET.pts=pts||[];
    if(host&&pts&&NET.myPeer&&pts.length>=MAX_GUESTS&&!pts.includes(NET.myPeer)){list=[];coopErr('That game already has four players.');}
    else list=host?[host,...others.filter(p=>p.presence.role==='guest'&&(!pts||pts.includes(p.peer)))]:[];
  }
  const ids=new Set(list.map(p=>p.peer));
  for(const r of [...REMOTES.values()])if(!ids.has(r.peer)){const was=r.present;r.present=false;releaseRig(r);REMOTES.delete(r.peer);if(NET.spect===r.peer)NET.spect=null;if(was)partnerLeft(r);}
  for(const p of list)readRemote(p.peer,p.presence);
  if(!NET.inGame)renderLobby();
}
function readRemote(peer,pr){
  let r=REMOTES.get(peer);if(!r){r=newRemote(peer);REMOTES.set(peer,r);}
  const was=r.present;r.present=true;claimRig(r);r.role=pr.role==='host'?'host':'guest';
  r.nm=String(pr.nm||'Partner').slice(0,18);if(r.nm!==r.lastNm){r.lastNm=r.nm;setAvatarName(r.rig,r.nm);}
  r.gn=Math.floor(finiteNumber(pr.gn,0,0,1e9));r.al=pr.al===0?0:1;r.out=pr.out?1:0;r.ph=typeof pr.ph==='string'?pr.ph:'';
  const q=r.raw;
  if(Array.isArray(pr.p)){q.x=finiteNumber(pr.p[0],q.x,-110,W*S+60);q.z=finiteNumber(pr.p[1],q.z,-70,W*S+70);q.yaw=finiteNumber(pr.p[2],q.yaw);q.pitch=finiteNumber(pr.p[3],q.pitch,-1.35,1.35);q.torch=!!pr.p[4];q.run=!!pr.p[5];q.y=finiteNumber(pr.p[6],0,0,H);q.crouch=!!pr.p[7];q.hidden=!!pr.p[8];q.health=finiteNumber(pr.p[9],100,0,100);q.weapon=Math.floor(finiteNumber(pr.p[10],0,0,weaponDefs.length-1));q.reload=!!pr.p[11];q.aim=!!pr.p[12];
    if(!r.seen){r.pos.set(q.x,0,q.z);r.yaw=q.yaw;r.pitch=q.pitch;r.seen=true;}}
  // ff: the damage this partner's shots have done to each of the others, keyed by peer
  r.sh=finiteNumber(pr.sh,0,0);r.ff=pr.ff&&typeof pr.ff==='object'&&NET.myPeer?finiteNumber(pr.ff[NET.myPeer],0,0):0;r.tk=Array.isArray(pr.tk)?pr.tk.filter(i=>Number.isInteger(i)&&i>=0&&i<ammoBoxes.length):[];
  if(NET.role==='host'&&r.role==='guest'){r.dm=Array.isArray(pr.dm)?pr.dm.slice(0,MAX_MON).map(v=>finiteNumber(v,0,0)):[];r.actions=Array.isArray(pr.actions)?pr.actions.slice(0,32):[];
    r.gk=Math.floor(finiteNumber(pr.gk,0,0));if(r.grants.length)r.grants=r.grants.filter(g=>g.n>r.gk);}
  if(NET.role==='guest'&&r.role==='host'){r.mon=Array.isArray(pr.mon)?pr.mon.slice(0,MAX_MON).map(v=>Array.isArray(v)&&v.length>=4&&v.slice(0,4).every(Number.isFinite)?[finiteNumber(v[0],0,-110,W*S+60),finiteNumber(v[1],0,-70,W*S+70),finiteNumber(v[2],0),Math.floor(v[3])&31,finiteNumber(v[4],0,-100,100)]:null):null;r.mc=Math.floor(finiteNumber(pr.mc,0,0,MAX_MON));r.el=finiteNumber(pr.el,0,0,7200);
    // host started (or restarted) a round we're not in yet
    const remoteSeed=finiteNumber(pr.seed,0,0,2147483647);
    // Wait for the host to admit this guest before starting, so late joiners
    // receive their own spawn slot instead of overlapping the first guest.
    if(pr.ph==='play'&&r.gn>NET.gen&&remoteSeed&&NET.myPeer&&NET.pts.includes(NET.myPeer)){startCoopRound(remoteSeed,r.gn);}
    if(r.gn===NET.gen&&NET.inGame){
      if(Array.isArray(pr.doors))pr.doors.forEach((v,i)=>{const d=roomDoors[i];if(!d||!Array.isArray(v))return;d.open=!!v[0];d.locked=!!v[1];d.health=Math.max(0,Math.min(100,Number(v[2])||0));});
      if(Array.isArray(pr.fuses))for(const l of roomLoot)if(l.type==='fuse'&&pr.fuses.includes(l.id)){l.taken=true;l.g.visible=false;}
      if(Array.isArray(pr.loot))for(const l of roomLoot)if(pr.loot.includes(l.id)){l.taken=true;l.g.visible=false;}
      const grants=pr.grants&&typeof pr.grants==='object'&&NET.myPeer?pr.grants[NET.myPeer]:null;
      if(Array.isArray(grants))for(const grant of grants){if(grant&&typeof grant.id==='string'&&!NET.claimed.has(grant.id)&&['ammo','medical','supplies'].includes(grant.type)){NET.claimed.add(grant.id);rewardLoot(grant.type);sPickup();}}
      fuses=roomLoot.filter(l=>l.type==='fuse'&&l.taken).length;exitPowered=!!pr.power;
            exitRelease=finiteNumber(pr.release,exitPowered?FLOOR().release:0,0,FLOOR().release);exitOpen=exitPowered&&pr.exitOpen===1;
      const ack=pr.acks&&typeof pr.acks==='object'&&NET.myPeer?Number(pr.acks[NET.myPeer])||0:0;NET.ackSeen=ack;NET.actions=NET.actions.filter(a=>a.n>ack);for(const item of [...ammoBoxes,...roomLoot])if(item.pending&&item.pending<=ack)item.pending=false;
    }
    if(pr.ph==='lobby'&&NET.inGame&&state==='coopEnd'){$('ceWait').textContent=`Waiting for ${r.nm} to start another round.`;}
  }
  if(!was){r.lastSh=r.sh;r.ffApplied=r.ff;if(NET.inGame)showMsg(`${r.nm} is here.`,2.5);}
}
function partnerLeft(r){
  if(NET.inGame&&state!=='coopEnd'){
    if(r.role==='host'&&NET.role==='guest'){coopShowEnd('The host left','The game ended because the host left. You can open a new game from the menu.',true);}
    else showMsg(anyPartner()?`${r.nm} left the game.`:`${r.nm} left the game. You’re on your own.`,4);
  }else if(NET.inGame&&state==='coopEnd'&&NET.role==='guest'&&r.role==='host'){$('ceWait').textContent='The host left the game.';$('ceAgain').hidden=true;}
}
// A partner is ready in the lobby once their presence arrives and they are not still finishing a round.
const remoteReady=r=>r.present&&r.ph!=='play';
function renderLobby(){
  if(!NET.g)return;
  const ul=$('coopPlayers');ul.textContent='';
  const add=(name,tag)=>{const li=document.createElement('li');li.textContent=name;const sp=document.createElement('span');sp.textContent=tag;li.appendChild(sp);ul.appendChild(li);};
  add(playerName||'Guest',NET.role==='host'?'you · host · ready':'you · ready');
  const list=partners().sort((a,b)=>(b.role==='host')-(a.role==='host'));
  for(const r of list)add(r.nm,(r.role==='host'?'host':'partner')+(remoteReady(r)?' · ready':' · not ready'));
  if(!hostRemote()&&NET.role==='guest'){const li=document.createElement('li');li.style.color='var(--ash)';li.textContent='Looking for the host…';ul.appendChild(li);}
  else if(1+list.length<4){const li=document.createElement('li');li.style.color='var(--ash)';li.textContent=list.length?`Room for ${3-list.length} more. Share the code.`:'Waiting for your partner to join…';ul.appendChild(li);}
  $('coopStartRow').hidden=NET.role!=='host';
  $('coopStart').disabled=!(list.length&&list.every(remoteReady));
  const host=hostRemote();
  if(NET.role==='guest'&&host&&!NET.inGame)coopErr(`Connected. Waiting for ${host.nm} to start the game.`);
}
function hostStart(){
  if(NET.role!=='host'||!anyPartner())return;
  const seed=1+Math.floor(Math.random()*2e9);
  startCoopRound(seed,NET.gen+1);
}
function startCoopRound(seed,gen){
  initAudio();
  NET.gen=gen;NET.seed=seed;NET.inGame=true;NET.over=false;NET.myAl=true;NET.myOut=false;NET.recorded=false;NET.shots=0;NET.ff={};NET.tk=[];NET.dm=new Array(MAX_MON).fill(0);
  runToken++;$('ceRank').textContent='';
  rigLights(true);
  NET.actions=[];NET.actionSeq=0;NET.actionAck=0;NET.ackSeen=0;NET.claimed.clear();NET.spect=null;NET.watched=null;
  for(const r of REMOTES.values()){r.actions=[];r.actionAck=0;r.grants=[];r.gk=0;r.dmApplied=new Array(MAX_MON).fill(0);r.lastSh=r.gn===gen?r.sh:0;r.ffApplied=r.gn===gen?r.ff:0;r.seen=false;}
  // Co-op rounds are played on B1.
  floor=0;scoreBase={points:0,kills:0};checkpoint=null;sleepHint=false;wakeBannerT=wakeStingT=howlAt=-99;
  buildMazeSeeded(seed);resetSurvivor();
  P.vel.set(0,0,0);P.velY=0;P.onGround=true;P.stamina=1;P.exhausted=false;camFX.reset();hitsReset();
  battery=1;elapsed=0;danger=0;ambientT=14;$('flash').style.opacity=0;
  visited=new Uint8Array(W*W);
  // Survivors start around the pedestal: the host, then each guest in the order the host admitted them.
  const slot=NET.role==='host'?0:1+Math.max(0,NET.pts.indexOf(NET.myPeer)),at=[[-.85,-.8],[-.85,.8],[-1.65,-.4],[-1.65,.4]][Math.min(3,slot)];
  setHell();P.pos.set(PED.x+at[0],0,PED.z+at[1]);P.yaw=Math.PI/2;P.pitch=0;grace=10;
  const hunters=coopHunters(1+partners().length);
  if(NET.role==='host')spawnMonsters(hunters,FLOOR().sleepers);else{hideMonsters();monCount=hunters;}
  if(droneGain)fadeTo(droneGain,0.07,1);
  state='play';showScreen(null);lock();
  sendNet(true);
  showMsg(NET.role==='guest'&&!IS_TOUCH&&document.pointerLockElement!==canvas?'The game started. Click the screen to take control.':`Recover the fuses together. ${HUNTER_WORDS[hunters]||hunters} threats are hunting, and more lie sleeping.`,5);
}
function coopLocalDone(how){
  NET.myAl=how!=='dead';NET.myOut=how==='out';
  // Each survivor records their own result once a round, as soon as they get out or fall.
  if(!NET.recorded){NET.recorded=true;const own=streak.snapshot(),mates=partners().filter(r=>r.gn===NET.gen);recordRun({mode:'coop',escaped:how==='out',time:elapsed,kills:own.kills,score:own.points,partner:(nameList(mates)||'Partner').slice(0,18)},'ceRank');}
  mouseDown=false;setLight(spot,0);setLight(bounce,0);setLight(fpTorchLight,0);setLight(muzzleLight,0);
  torch.visible=false;gun.visible=false;gunOut=false;$('flash').style.opacity=0;
  sendNet(true);
  const mate=spectRemote();
  if(mate){state='spect';const more=partners().filter(liveRemote).length>1?' Press Space to switch.':'';
    showMsg((how==='out'?`You’re out. Watching ${mate.nm} through their eyes.`:`You’re dead. Watching ${mate.nm} through their eyes.`)+more,5);}
  else coopFinish();
}
function hurtByPartner(d,r){
  if(!localInDanger()||P.hidden)return;
  P.health=Math.max(0,P.health-d);damageT=Math.max(damageT,.9);
  {const dx=r.pos.x-P.pos.x,dz=r.pos.z-P.pos.z,dist=Math.max(.01,Math.hypot(dx,dz));camFX.punch((dx*Math.cos(P.yaw)-dz*Math.sin(P.yaw))/dist,.4);camFX.addTrauma(.35);}
  if(P.health<=0){mouseDown=false;stopAudio();if(state==='pause')showScreen(null);state='play';coopLocalDone('dead');
    if(state==='spect')showMsg(`${r.nm} shot you dead. Watching ${watched().nm} through their eyes.`,5);return;}
  playerAudio?.hurt(d);showMsg(`${r.nm} shot you!`,2);
}
function coopFinish(){
  if(NET.over)return;NET.over=true;
  const meOut=!!NET.myOut,mates=partners().filter(r=>r.gn===NET.gen),outs=mates.filter(r=>r.out),lost=mates.filter(r=>!r.out);
  let title,text;
  if(meOut&&mates.length&&!lost.length){title='Outside';text=`${mates.length>1?'You all':'You both'} made it out in ${fmtTime(elapsed)}. Behind you, something keeps walking.`;}
  else if(meOut){title='Outside';text=!mates.length?'You made it out alone.':outs.length?`You made it out with ${nameList(outs)}. ${nameList(lost)} didn’t.`:`You made it out. ${nameList(lost)} didn’t.`;}
  else if(outs.length){title='Left behind';text=`${nameList(outs)} made it out. You didn’t.`;}
  else{title=mates.length>1?'It found you all':'It found you both';text='The corridors are quiet again.';}
  coopShowEnd(title,text,false);
}
function coopShowEnd(title,text,hostGone){
  state='coopEnd';NET.over=true;stopAudio();
  if(droneGain)fadeTo(droneGain,0,2);
  $('ceTitle').textContent=title;$('ceTitle').className='title'+(title.startsWith('It found')||title.startsWith('Left')?' red':'');
  $('ceText').textContent=text;
  $('ceAgain').hidden=NET.role!=='host'||hostGone;
  const host=hostRemote();
  $('ceWait').textContent=hostGone?'':NET.role==='host'?(anyPartner()?'':'Everyone else left.'):`Waiting for ${host?host.nm:'the host'} to start another round.`;
  showScreen('coopEnd');try{document.exitPointerLock();}catch(e){}
  if(NET.role==='host'&&NET.g)NET.g.presence({ph:'lobby'}).catch(()=>{});
}
function sendNet(force){
  if(!NET.g)return;
  const now=performance.now();if(!force&&now-NET.sendT<67)return;NET.sendT=now;
  const ff={};for(const id in NET.ff)ff[id]=r2(NET.ff[id]);
  const pk={gn:NET.gen,ph:NET.inGame&&!NET.over?'play':'lobby',p:[r2(P.pos.x),r2(P.pos.z),r2(P.yaw),r2(P.pitch),torchOn?1:0,P.running?1:0,r2(P.pos.y),P.crouching?1:0,P.hidden?1:0,Math.round(P.health),weaponIndex,reloadT>0?1:0,aiming&&!reloadT?1:0],
    al:NET.myAl===false?0:1,out:NET.myOut?1:0,sh:NET.shots,ff,tk:NET.tk.slice(0,32)};
  if(NET.role==='guest'){pk.dm=NET.dm.slice(0,MAX_MON).map(r2);pk.actions=NET.actions.slice(0,12);pk.gk=NET.ackSeen;}
  if(NET.role==='host'){pk.seed=NET.seed;pk.mc=monCount;pk.el=r2(elapsed);pk.pts=NET.pts;
    pk.mon=monsters.slice(0,monCount).map(m=>[r2(m.pos.x),r2(m.pos.z),r2(m.yaw),(m.state==='chase'?1:0)|(m.dead?2:0)|(m.stagger>0?4:0)|(m.state==='stalk'?8:0)|(m.dormant?16:0),r2(m.hp)]);
    pk.doors=roomDoors.map(d=>[d.open?1:0,d.locked?1:0,Math.round(d.health)]);pk.fuses=roomLoot.filter(l=>l.type==='fuse'&&l.taken).map(l=>l.id);pk.power=exitPowered?1:0;pk.release=r2(exitRelease);pk.exitOpen=exitOpen?1:0;
    pk.loot=roomLoot.filter(l=>l.taken&&l.type!=='weapon').map(l=>l.id);
    // per guest: the last action handled and the pickups granted that the guest has not yet confirmed
    pk.acks={};pk.grants={};for(const r of partners())if(r.role==='guest'){pk.acks[r.peer]=r.actionAck;if(r.grants.length)pk.grants[r.peer]=r.grants.map(g=>({id:g.id,type:g.type}));}
  }
  NET.g.presence(pk).catch(()=>{});
}
function guestMonsters(dt){
  let target=0;nearestD=99;
  const R=hostRemote();
  if(!R||R.gn!==NET.gen||!R.mon){danger*=0.98;return;}
  monCount=R.mc||coopHunters(1+partners().length);
  for(let i=0;i<MAX_MON;i++){const m=monsters[i],d=R.mon[i];
    if(!d||i>=monCount){m.g.visible=false;m.dead=true;m.dormant=false;continue;}
    const [x,z,yaw,fl,hp]=d;const dead=!!(fl&2),chase=!!(fl&1),stalk=!!(fl&8),asleep=!!(fl&16);m.hp=Number(hp)||0;m.attackT=Math.max(0,m.attackT-dt);m.lungeT=Math.max(0,m.lungeT-dt);
    if(m.dead&&!dead){clearHits(m);m.spawned=true;m.g.visible=true;m.dead=false;m.deadT=0;m.pos.set(x,0,z);m.yaw=yaw;m.g.rotation.set(0,yaw,0);m.g.userData.eyeMat.color.setHex(m.g.userData.eyeColor||0xff2a14);m.state='wander';m.voiceT=rnd(2,6);m.stepT=rnd(.2,.8);m.lungeT=0;m.lungeCD=0;m.lungeBoost=0;m.spotCD=0;m.stagger=0;m.anim.reset();m.animYaw=m.yaw;
      m.dormant=false;m.riseT=0;m.wakeIn=-1;if(asleep&&!dead)layDown(m,i);}
    if(dead&&!m.dead){m.dead=true;m.dormant=false;m.riseT=0;m.deadT=0;m.g.userData.eyeMat.color.set(0x120000);m.g.userData.glow.intensity=0;sCreature(m,'death');
      m.anim.die({dirX:m.pos.x-P.pos.x,dirZ:m.pos.z-P.pos.z,yaw:m.yaw});
      const left=R.mon.slice(0,monCount).filter(q=>q&&!(q[3]&2)).length;showMsg(left?`It went down. ${left} still walking.`:'It went down. The corridors are silent.',3);}
    if(m.dead){if(m.g.visible)m.deadT+=dt;continue;}
    if(m.dormant&&!asleep){m.state=chase?'chase':'wander';wakeEffects(m);}
    if(m.dormant){sleeperVoice(m,dt);continue;}
    if(m.riseT>0){m.riseT=Math.max(0,m.riseT-dt);m.g.userData.speed=0;continue;}
    if(chase&&m.state!=='chase')chargeCue(m,true);
    m.spotCD=Math.max(0,(m.spotCD||0)-dt);
    m.state=chase?'chase':stalk?'stalk':'wander';if(fl&4)m.stagger=Math.max(m.stagger,0.1);m.stagger=Math.max(0,m.stagger-dt);
    const ox=m.pos.x,oz=m.pos.z,k=Math.min(1,dt*10);
    m.pos.x+=(x-m.pos.x)*k;m.pos.z+=(z-m.pos.z)*k;m.yaw=angLerp(m.yaw,yaw,k);
    const moved=Math.hypot(m.pos.x-ox,m.pos.z-oz);
    m.g.position.copy(m.pos);m.g.rotation.set(0,m.yaw,0);
    m.g.userData.speed=dt>0?moved/dt:0;m.g.userData.chasing=chase;
    updateMonsterAudio(m,dt,moved);
    const dp=Math.hypot(P.pos.x-m.pos.x,P.pos.z-m.pos.z);nearestD=Math.min(nearestD,dp);
    target=Math.max(target,chase?Math.max(0,1-dp/32):stalk?Math.max(0,1-dp/6)*.18:Math.max(0,1-dp/14)*.35);
    if(localInDanger()&&grace<=0&&m.attackT<=0&&dp<m.stats.radius+PR+.35&&P.pos.y<(m.kind==='crawler'?.6:1.3)&&los(m.pos.x,m.pos.z,P.pos.x,P.pos.z)){m.attackT=m.kind==='warden'?1.7:1.1;damagePlayer(m);}
  }
  danger+=(target-danger)*Math.min(1,dt*2);
}
// The host resolves a guest's queued actions against that guest's own position.
function hostActions(R){
  for(const a of R.actions){
    if(!a||!Number.isInteger(a.n)||a.n<=R.actionAck)continue;R.actionAck=a.n;
    if(a.type==='door'){
      const d=roomDoors.find(d=>d.id===a.id);if(!d||Math.hypot(d.box.x-R.raw.x,d.box.z-R.raw.z)>3.5)continue;
      const inside=RULES.insideRoom(d.room,R.raw.x,R.raw.z);
      if(a.action==='lock'&&!inside||a.action==='open'&&d.locked&&!inside)continue;
      if(['open','close','lock'].includes(a.action))doorAction(d,a.action);
    }else if(a.type==='loot'||a.type==='fuse'){
      const l=roomLoot.find(l=>l.id===a.id);if(!l||l.taken||l.type==='weapon'||Math.hypot(l.x-R.raw.x,l.z-R.raw.z)>3||!los(R.raw.x,R.raw.z,l.x,l.z))continue;
      if(automaticLoot(l.type)&&!pickupReach(l,R.raw,1.6))continue;
      if(l.type==='fuse')collectLoot(l);
      else if(l.type!=='medical'||R.raw.health<100){l.taken=true;l.g.visible=false;R.grants.push({id:l.id,type:l.type,n:a.n});showMsg(`${R.nm} collected ${l.type==='medical'?'a medical kit':'supplies'}.`,2);}
    }else if(a.type==='ammo'){
      const b=Number.isInteger(a.id)&&a.id>=0&&a.id<ammoBoxes.length?ammoBoxes[a.id]:null;if(b&&!b.taken&&pickupReach(b,R.raw,1.6)){b.taken=true;b.g.visible=false;NET.tk.push(a.id);R.grants.push({id:'ammo:'+a.id,type:'ammo',n:a.n});}
    }else if(a.type==='exit'&&Math.hypot(R.raw.x-(W-1)*S,R.raw.z-((W-2)*S+S/2))<3.5)powerExit();
    else if(a.type==='decoy'&&Number.isFinite(a.x)&&Number.isFinite(a.z)&&Math.hypot(a.x-R.raw.x,a.z-R.raw.z)<12)decoyEvents.push({x:a.x,z:a.z,remaining:5,pulse:0});
  }
}
function netTick(dt){
  const spectating=state==='spect'||(state==='pause'&&prevState==='spect'),seen=spectating?spectRemote():null;
  // each partner's avatar + sounds
  for(const R of REMOTES.values()){const o=R.rig;if(!o)continue;
    if(!(R.present&&R.gn===NET.gen&&R.seen)){o.avatar.visible=false;continue;}
    const k=Math.min(1,dt*22),ox=R.pos.x,oz=R.pos.z;
    R.pos.x+=(R.raw.x-R.pos.x)*k;R.pos.z+=(R.raw.z-R.pos.z)*k;R.yaw=angLerp(R.yaw,R.raw.yaw,k);R.pitch+=(R.raw.pitch-R.pitch)*k;
    const moved=Math.hypot(R.pos.x-ox,R.pos.z-oz);
    // A spectator looks out through the watched partner's eyes, so that body is hidden; the others stay in view.
    const show=R.al&&!R.out&&R!==seen;
    o.avatar.visible=!!show;o.avatar.position.set(R.pos.x,R.raw.y||0,R.pos.z);o.avatar.rotation.y=R.yaw;
    if(dt>0){const kv=Math.min(1,dt*8);R.vx+=((R.pos.x-ox)/dt-R.vx)*kv;R.vz+=((R.pos.z-oz)/dt-R.vz)*kv;}
    if(show){setAvatarWeapon(o,R.raw.weapon||0);
      o.avatar.userData.animate({vx:R.vx,vz:R.vz,yaw:R.yaw,pitch:R.pitch,crouch:R.raw.crouch,run:R.raw.run,aim:R.raw.aim,reload:R.raw.reload},dt);
      o.label.position.y=2.12-o.avatar.userData.state.crouch*.32;}
    setLight(o.spot,R.al&&!R.out&&R.raw.torch?2.4:0);
    R.stepD+=moved;if(R.stepD>(R.raw.run?1.1:0.75)){R.stepD=0;if(R.al&&!R.out)sStepAt(R.pos.x,R.pos.z,R.raw.run?0.3:0.13);}
    if(R.sh>R.lastSh){const n=Math.min(3,R.sh-R.lastSh),wid=R.raw.weapon;R.lastSh=R.sh;for(let q=0;q<n;q++)setTimeout(()=>sShotAt(R.pos.x,R.pos.z,wid),q*90);setLight(o.flash,preferences.effects?2.5:0);if(preferences.effects)o.avatar.userData.fire();
      if(NET.role==='host'){const noise=weaponDefs[R.raw.weapon]?.noise||30;alertMonsters(noise,R.raw.x,R.raw.z,0);rouseByShot(R.raw.x,R.raw.z,noise);}}
    setLight(o.flash,o.flash.userData.level*Math.max(0,1-dt*30));
    if(R.ff<R.ffApplied)R.ffApplied=R.ff;else if(R.ff-R.ffApplied>.01){const d=R.ff-R.ffApplied;R.ffApplied=R.ff;hurtByPartner(Math.min(d,100),R);}
    // ammo boxes the partner took
    for(const ix of R.tk){const b=ammoBoxes[ix];if(b&&!b.taken){b.taken=true;b.g.visible=false;}}
    // the host applies each guest's hits and actions
    if(NET.role==='host'&&R.role==='guest'){for(let i=0;i<monCount;i++){const tot=Number(R.dm[i])||0,d=tot-(R.dmApplied[i]||0);if(d>0){R.dmApplied[i]=tot;hitMonster(monsters[i],Math.min(d,30),{x:R.raw.x,z:R.raw.z});}}
      hostActions(R);}
  }
  // spectating: the watched partner's torch is the light we see by
  if(state==='spect'){const w=watched();setLight(spot,w.raw.torch&&w.al?2.6:0);}
  // round over once every survivor is out or down
  if(!NET.over&&NET.inGame){
    const meDone=(state==='spect'||state==='coopEnd'||NET.myAl===false||NET.myOut)&&state!=='play'&&state!=='caught';
    const othersDone=partners().every(r=>r.gn===NET.gen&&(!r.al||r.out));
    if(meDone&&othersDone)coopFinish();
  }
  sendNet(false);
}
$('coopBtn').addEventListener('click',()=>{initAudio();openCoop();});
$('coopBack').addEventListener('click',async()=>{await leaveRoom();openMenu();});
$('coopCreate').addEventListener('click',async()=>{await joinRoom(randCode(),'host');});
$('coopJoinForm').addEventListener('submit',async e=>{e.preventDefault();const c=$('coopCodeIn').value.trim().toLowerCase().replace(/[^a-z0-9]/g,'');
  if(c.length<4){coopErr('Game codes are 4 letters or numbers.');return;}await joinRoom(c,'guest');});
$('coopCopy').addEventListener('click',()=>{const b=$('coopCopy');try{navigator.clipboard.writeText(NET.code||'').then(()=>{b.textContent='Copied';setTimeout(()=>b.textContent='Copy',1500);},()=>{});}catch(e){}});
$('coopStart').addEventListener('click',()=>hostStart());
$('ceAgain').addEventListener('click',()=>{if(anyPartner())hostStart();else $('ceWait').textContent='Everyone else left. Open a new game from the menu.';});
$('ceLeave').addEventListener('click',async()=>{await leaveRoom();openMenu();});

/* ---------- player name + scoreboard ---------- */
const LS_NAME='hollow.playerName',LS_SCORES='hollow.scores';
function lsGet(k){try{return localStorage.getItem(k);}catch(e){return null;}}
function lsSet(k,v){try{localStorage.setItem(k,v);}catch(e){}}
function cookieGet(k){try{const m=document.cookie.match(new RegExp('(?:^|; )'+k.replace(/\./g,'\\.')+'=([^;]*)'));return m?decodeURIComponent(m[1]):null;}catch(e){return null;}}
function cookieSet(k,v){try{document.cookie=k+'='+encodeURIComponent(v)+';max-age=31536000;path=/;SameSite=None;Secure';}catch(e){}}
let playerName=lsGet(LS_NAME)||cookieGet(LS_NAME)||'';
function setName(v){playerName=v;lsSet(LS_NAME,v);cookieSet(LS_NAME,v);$('whoName').textContent=v;renderBoards();}
function fmtTime(sec){const m=Math.floor(sec/60),s=sec-m*60;return m+':'+(s<10?'0':'')+s.toFixed(1);}
function openNameScreen(){state='menu';$('playerName').value=playerName;$('nameErr').textContent='';showScreen('name');setTimeout(()=>$('playerName').focus(),30);}
function openMenu(){state='menu';$('whoName').textContent=playerName||'Guest';showScreen('menu');renderBoards();updateContinue();}

let localScores=[];try{localScores=JSON.parse(lsGet(LS_SCORES)||'[]');if(!Array.isArray(localScores))localScores=[];}catch(e){localScores=[];}
localScores=localScores.map(cleanRow).filter(Boolean);
let sharedRows=null,sharedState='loading',myId=null,canPost=null,lastMine=null,scoresCol=null,amOwner=false,runToken=0;
// ===== I1b: chaos, streaks, HUDFX =====
// Chaos director (practical lights that stutter, surge and black out, emergency mood, beacons, scare cues), kill
// streaks, hitstop and the HUDFX layer. Existing code calls in through one-line hooks only: chaosWorldBuilt
// (buildRooms), chaosLightsRefreshed (refreshRoomLights), chaosStep (stepSurvival), dopaFrame (loop; returns the
// hitstop-scaled simulation dt), dopaShotBegin/dopaShotHit/dopaShotEnd (fire), dopaHurt (damagePlayer), dopaSnapshot.
// The streak gets the live effects preference with every kill (a creation-time option would pin it).
const chaos=HollowChaos.create(worldSeed),streak=HollowChaos.createStreak();
const hud=HollowHUDFX.create({root:$('hud'),document,motion:preferences.motion,effects:preferences.effects,touch:dopaTouch()});
const HITSTOP_SCALE=.08,EMERGENCY_RED=lin(0xff2414),SPARK_DOWN=new THREE.Vector3(0,-1,0),SPARK_CLEAR=2.2,coneTint=new THREE.Color();
let hitstopT=0,chaosLive=false;
// chaos.beacon(0..1), refreshed every simulation step. The atmosphere beacons read chaos.beacon(i) in updateAtmosphere.
const beacons=[chaos.beacon(0),chaos.beacon(1)];
const chaosIn={active:false,danger:0,chasers:0,nearest:99,alarm:false,sheltered:false,effects:true,health:100,lights:0,yaw:0,cue:false};
const dopa={state:'',motion:preferences.motion,effects:preferences.effects,touch:dopaTouch(),snap:chaos.snapshot(),
  hEvents:0,hFuses:0,fuses:0,powered:false,open:false,chasers:0,chaseT:-1e9,lostT:-1e9,emergency:0,shock:0,hemi:-1,
  live:null,liveBase:.45,liveColor:new THREE.Color(),livePhase:0,cones:new Map(),shot:{id:0,hits:0,head:false,list:[],flash0:0},
  flashCD:0,hitstops:0,lastHitstop:0,kills:0,lastKill:null,damage:null,damageHits:0};
function dopaTouch(){return !!(controls?controls.touch:IS_TOUCH);}
function dopaTrauma(amount){const rig=typeof camFX!=='undefined'?camFX:null;if(rig&&typeof rig.addTrauma==='function')rig.addTrauma(amount);}
function chaosWorldBuilt(ward){
  chaos.reset(worldSeed);streak.reset();hud.clear();hitstopT=0;chaosLive=false;chaosHemiRestore();chaosBeacons();
  const h=horror.snapshot();dopa.hEvents=h.events;dopa.hFuses=h.fuses;dopa.snap=chaos.snapshot();
  dopa.fuses=fuses;dopa.powered=exitPowered;dopa.open=exitOpen;dopa.chasers=0;dopa.chaseT=dopa.lostT=-1e9;dopa.emergency=dopa.shock=0;
  dopa.hitstops=dopa.lastHitstop=dopa.kills=dopa.damageHits=dopa.flashCD=0;dopa.lastKill=dopa.damage=null;dopa.cones.clear();
  for(const m of monsters){m.dopaHitT=-1e9;m.dopaHead=false;m.dopaDown=!!m.dead;m.dopaShot=-1;}
  for(const l of practicalLights){l.userData.base=undefined;l.userData.shelter=false;}
  // The shared ward:live strip material (re-armed by decorateWard on every build) flickers with light channel 0.
  let live=ward&&ward.userData.liveMaterial||null;
  if(!live&&ward)ward.traverse(o=>{if(live||!o.isMesh)return;for(const m of Array.isArray(o.material)?o.material:[o.material])if(m&&m.emissive&&m.emissiveIntensity>0&&m.emissive.r+m.emissive.g+m.emissive.b>0){live=m;break;}});
  dopa.live=live;if(live){dopa.liveBase=live.emissiveIntensity;dopa.liveColor.copy(live.emissive);}
  const practicals=ward&&ward.userData.practicals;dopa.livePhase=practicals&&practicals.length?practicals[0].phase:0;
}
function chaosLightsRefreshed(nearest){
  practicalLights.forEach((l,i)=>{const u=l.userData,info=nearest[i];u.base=u.level;u.shelter=!!(info&&info.shelter);u.phase=info?info.phase:undefined;u.hex=info?info.color:0;(u.tint||(u.tint=new THREE.Color())).copy(l.color);});
}
function chaosStep(dt){
  const h=horror.snapshot(),cue=h.events!==dopa.hEvents||h.fuses!==dopa.hFuses;dopa.hEvents=h.events;dopa.hFuses=h.fuses;
  let chasers=0,lights=0;
  for(let i=0;i<monCount;i++){const m=monsters[i];if(!m.dead&&m.state==='chase')chasers++;}
  for(const l of practicalLights)if(l.visible&&l.userData.base>0)lights++;
  chaosLive=state==='play';dopa.chasers=chasers;
  const c=chaosIn;c.active=chaosLive;c.danger=danger;c.chasers=chasers;c.nearest=nearestD;c.alarm=exitPowered&&!exitOpen;c.sheltered=!!currentShelter();
  c.effects=preferences.effects;c.health=P.health;c.lights=lights;c.yaw=P.yaw;c.cue=cue;
  const events=chaos.update(dt,c);dopa.snap=chaos.snapshot();chaosBeacons();
  for(let i=0;i<events.length;i++)chaosEvent(events[i]);
  // Emergency mood: chases, the exit alarm and blackouts pull the practicals and live strips toward red.
  const s=dopa.snap,target=preferences.effects&&chaosLive?Math.min(1,(s.chasing?.85:0)+(c.alarm?.45:0)+.3*s.blackoutLevel):0;
  dopa.emergency+=(target-dopa.emergency)*(1-Math.exp(-dt*(target>dopa.emergency?2.5:.8)));
  chaosLights();dopaObjectives();
  if(NET.inGame&&NET.role==='guest')dopaGuestKills();
}
// Lights only change intensity and colour here, never .visible. Effects off, shelters and an idle director keep the
// exact base level that refreshRoomLights set.
function chaosLights(){
  const effects=preferences.effects,k=effects?.42*dopa.emergency:0;
  for(let i=0;i<practicalLights.length;i++){
    const l=practicalLights[i],u=l.userData;if(u.base===undefined)continue;
    const steady=!effects||!chaosLive||u.shelter||!(u.base>0);
    setLight(l,steady?u.base:u.base*chaos.lightLevel(i,u.phase));
    if(u.tint){if(steady||k<.002)l.color.copy(u.tint);else l.color.copy(u.tint).lerp(EMERGENCY_RED,k);}
    // The fixture's light shaft (atmosphere cone, assigned in refreshRoomLights) takes the same emergency tint.
    const cone=u.cone;
    if(cone&&typeof cone.setColor==='function'){
      if(!steady&&k>=.002){if(!dopa.cones.has(cone))dopa.cones.set(cone,u.hex);cone.setColor(coneTint.set(u.hex).lerp(EMERGENCY_RED,k));}
      else if(dopa.cones.has(cone)){cone.setColor(dopa.cones.get(cone));dopa.cones.delete(cone);}
    }
  }
  const live=dopa.live;
  if(live){
    const on=effects&&chaosLive;
    live.emissiveIntensity=on?dopa.liveBase*chaos.lightLevel(0,dopa.livePhase):dopa.liveBase;
    if(on&&dopa.emergency>.002)live.emissive.copy(dopa.liveColor).lerp(EMERGENCY_RED,.5*dopa.emergency);else live.emissive.copy(dopa.liveColor);
  }
  // Without the post pipeline a blackout also takes most of the ambient fill (postfx darkens through its own uniform).
  const post=typeof fx!=='undefined'?fx:null,black=effects&&chaosLive&&!(post&&post.enabled)?dopa.snap.blackoutLevel:0;
  if(black>.002){if(dopa.hemi<0)dopa.hemi=hemi.userData.level;setLight(hemi,dopa.hemi*(1-.55*black));}
  else chaosHemiRestore();
}
function chaosHemiRestore(){if(dopa.hemi>=0){setLight(hemi,dopa.hemi);dopa.hemi=-1;}}
function chaosEvent(e){
  if(!e||typeof e!=='object')return;
  // Scares use the HollowHorror convention: x += cos(bearing)*distance, z += sin(bearing)*distance.
  if(e.bearing!=null&&e.x===undefined){const d=e.distance||3;e.x=P.pos.x+Math.cos(e.bearing)*d;e.z=P.pos.z+Math.sin(e.bearing)*d;}
  if(e.type==='chaseStart'){
    dopa.chaseT=simulationTime;dopa.shock=Math.max(dopa.shock,.35);
    // A body getting up has its own banner (wakeEffects); the chase it starts does not replace it.
    if(simulationTime-wakeBannerT>2)hud.banner(dopa.chasers>1?'THEY SEE YOU':'IT SEES YOU',{tone:'danger',duration:1.6});dopaTrauma(.25);
  }else if(e.type==='chaseEnd'){
    if(simulationTime-dopa.chaseT-HollowChaos.LIMITS.chaseEndHold>4&&simulationTime-dopa.lostT>30){dopa.lostT=simulationTime;hud.banner('YOU LOST IT',{tone:'info',duration:1.8});}
  }else if(e.type==='surge'){
    // The postfx surge and blackout uniforms follow the director's levels (chaosVisuals).
    dopa.shock=Math.max(dopa.shock,.3*(e.intensity||0));
  }else if(e.type==='blackout'){
    dopa.shock=Math.max(dopa.shock,.5);
  }else if(e.type==='sparks'){
    chaosSparks(e);
  }else if(HollowChaos.SCARES.includes(e.type)){
    if(e.type==='slam')dopaTrauma(.35);
    dopa.shock=Math.max(dopa.shock,e.type==='slam'||e.type==='scream'?.5:.25);
    chaosCaption(e);
  }
  // Every event's sound (stingers, the surge, the breaker, spark crackle, scare voices) is audioChaosEvent's (I2).
  if(typeof audioChaosEvent==='function')audioChaosEvent(e);
}
function chaosCaption(e){
  if(captionT>0&&captionText[0]!=='[')return;
  const a=HollowHUDFX.bearing(P.pos.x,P.pos.z,P.yaw,e.x,e.z),r=Math.abs(a);
  const where=r<Math.PI/4?'ahead':r>Math.PI*3/4?'behind you':a>0?'to your right':'to your left';
  captionText=e.type==='scream'?`[A scream, somewhere ${where}.]`:e.type==='slam'?`[Metal slams ${where}.]`:e.type==='whisper'?`[Something whispers ${where}.]`:`[Soft laughter ${where}.]`;
  captionT=4;
}
// Sparks rain from the light that cut out, or from the nearest ceiling fixture during a blackout (never a refuge).
// A fixture within SPARK_CLEAR of the player is passed over: sparks falling past the eye smear into screen-tall streaks.
function chaosSparks(e){
  const l=e.light!=null?practicalLights[e.light]:null;let x,z;
  if(l&&l.userData.level>0&&!l.userData.shelter&&Math.hypot(l.position.x-P.pos.x,l.position.z-P.pos.z)>=SPARK_CLEAR){x=l.position.x;z=l.position.z;}
  else{let near=Infinity;for(const f of roomLights){if(f.shelter)continue;const d=Math.hypot(f.x-P.pos.x,f.z-P.pos.z);if(d>=SPARK_CLEAR&&d<near){near=d;x=f.x;z=f.z;}}}
  if(x===undefined)return;
  e.x=x;e.y=2.9;e.z=z;
  const a=typeof atm!=='undefined'?atm:null;
  if(a&&typeof a.sparks==='function')a.sparks(x,2.9,z,{dir:SPARK_DOWN,count:28,speed:3});
}
function chaosBeacons(){for(let i=0;i<beacons.length;i++)beacons[i]=chaos.beacon(i);}
function chaosVisuals(){
  const post=typeof fx!=='undefined'?fx:null;if(!post||!post.uniforms)return;
  const u=post.uniforms,s=dopa.snap,on=preferences.effects&&chaosLive&&state==='play';
  if(u.blackout)u.blackout.value=on?.75*s.blackoutLevel:0;
  if(u.surge)u.surge.value=on?s.surgeLevel:0;
  if(u.aberration)u.aberration.value=on?Math.min(1,.3*s.intensity+dopa.shock):0;
  if(u.slowmo)u.slowmo.value=preferences.motion&&state==='play'?Math.min(1,hitstopT/.05):0;
}
function dopaFrame(rawDt,dt){
  hud.update(rawDt);
  const touch=dopaTouch();
  if(preferences.motion!==dopa.motion||preferences.effects!==dopa.effects||touch!==dopa.touch){
    const relight=preferences.effects!==dopa.effects;
    dopa.motion=preferences.motion;dopa.effects=preferences.effects;dopa.touch=touch;
    hud.setOptions({motion:dopa.motion,effects:dopa.effects,touch});if(relight)chaosLights();
  }
  if(state!==dopa.state){dopa.state=state;if(state==='caught'||state==='dead'||state==='win'||state==='coopEnd')hud.clear();}
  if(chaosLive&&state!=='play'&&state!=='pause'){chaosLive=false;chaosIn.active=false;chaos.update(0,chaosIn);dopa.snap=chaos.snapshot();dopa.emergency=0;chaosBeacons();chaosLights();}
  dopa.shock=Math.max(0,dopa.shock-rawDt*1.6);dopa.flashCD=Math.max(0,dopa.flashCD-rawDt);
  let sdt=dt;
  if(NET.inGame||state!=='play')hitstopT=0;
  else if(hitstopT>0){const frozen=Math.min(dt,hitstopT);hitstopT-=frozen;sdt=dt-frozen*(1-HITSTOP_SCALE);}
  chaosVisuals();
  return sdt;
}
function dopaObjectives(){
  const T=TEXT();
  if(fuses!==dopa.fuses){if(fuses>dopa.fuses)hud.banner(`${T.tag} ${fuses}/3`,{tone:'objective',kicker:fuses>=3?T.allKick:T.kick});dopa.fuses=fuses;}
  if(exitPowered!==dopa.powered){if(exitPowered)hud.banner(T.power,{tone:'objective',kicker:T.powerKick});dopa.powered=exitPowered;}
  if(exitOpen!==dopa.open){if(exitOpen)hud.banner(T.open,{tone:'objective',duration:2.8});dopa.open=exitOpen;}
}
// One marker, one streak hit and at most one hitstop per shot, however many pellets land. fire() never targets a
// dead monster, so a monster hit by this shot that is dead at the end of it was killed by it.
function dopaShotBegin(){const s=dopa.shot;s.id++;s.hits=0;s.head=false;s.list.length=0;s.flash0=typeof fxKill!=='undefined'?fxKill:0;}
function dopaShotHit(m,headshot,distance){
  const s=dopa.shot;
  if(m.dopaShot!==s.id){m.dopaShot=s.id;m.dopaShotHead=false;if(s.list.length<12)s.list.push(m);}
  if(headshot){m.dopaShotHead=true;s.head=true;}
  s.hits++;m.dopaDist=distance;m.dopaHitT=simulationTime;m.dopaHead=m.dopaShotHead;
}
function dopaShotEnd(){
  const s=dopa.shot;if(!s.hits)return;
  let killed=null,armored=false,result=null;
  for(const m of s.list){if(m.dead){if(!killed)killed=m;}else if(m.kind==='warden')armored=true;}
  const hit=streak.hit(simulationTime,{headshot:s.head});dopaHitstop(hit.hitstop);
  hud.hit({headshot:s.head,kill:!!killed,armored:armored&&!killed});
  let flash=0;
  for(const m of s.list)if(m.dead){m.dopaResult=dopaKill(m,m.dopaShotHead,m.dopaDist);result=m.dopaResult;flash=Math.max(flash,result.flash);}
  if(killed)dopaKillFlash(flash,s.flash0);
  if(typeof audioOnHit==='function')audioOnHit({m:killed||s.list[0],headshot:s.head,kill:!!killed,armored:armored&&!killed,result});
  if(typeof audioOnKill==='function')for(const m of s.list)if(m.dead)audioOnKill({m,headshot:!!m.dopaShotHead,kill:true,armored:false,result:m.dopaResult});
}
function dopaKill(m,headshot,distance){
  const r=streak.kill(simulationTime,{headshot:!!headshot,kind:m.kind,distance,effects:preferences.effects});
  hud.kill({...r,kind:m.kind,headshot:!!headshot});hud.score(scoreBase.points+streak.snapshot().points);dopaHitstop(r.hitstop);
  if(m.kind==='warden')dopaTrauma(.3);
  dopa.kills++;dopa.lastKill={kind:m.kind,headshot:!!headshot,label:r.label,count:r.count,points:r.points,hitstop:r.hitstop,flash:r.flash};
  return r;
}
// Co-op guests only send damage: a host-confirmed death shortly after a local hit counts as the guest's kill.
function dopaGuestKills(){
  for(let i=0;i<monCount;i++){
    const m=monsters[i];
    if(!m.dead){m.dopaDown=false;continue;}
    if(m.dopaDown)continue;m.dopaDown=true;
    if(!(simulationTime-m.dopaHitT<=1.6))continue;
    hud.hit({headshot:!!m.dopaHead,kill:true});
    const r=dopaKill(m,m.dopaHead,m.dopaDist);dopaKillFlash(r.flash,typeof fxKill!=='undefined'?fxKill:0);
    if(typeof audioOnKill==='function')audioOnKill({m,headshot:!!m.dopaHead,kill:true,armored:false,result:r});
  }
}
// The postfx kill flash (fxKill, set to 1 by hitMonster) scales with the streak's flash and starts at most ~3 times a
// second; inside the cooldown the earlier flash just keeps fading. Effects off: the streak flash is 0, so no new flash.
function dopaKillFlash(flash,before){
  if(typeof fxKill==='undefined')return;
  if(flash>0&&dopa.flashCD<=0){fxKill=Math.max(before,.45+.55*flash);dopa.flashCD=.34;}
  else fxKill=before;
}
// Hitstop only slows local solo simulation (stepSurvival and monster animation), never look, HUD, audio or co-op.
function dopaHitstop(seconds){if(NET.inGame||!(seconds>0))return;hitstopT=Math.max(hitstopT,seconds);dopa.hitstops++;dopa.lastHitstop=seconds;}
function dopaHurt(m){
  const bearing=HollowHUDFX.bearing(P.pos.x,P.pos.z,P.yaw,m.pos.x,m.pos.z),amount=Math.min(1,m.stats.damage/50);
  hud.damage(bearing,amount);dopa.damage={bearing,amount,kind:m.kind};dopa.damageHits++;
}
function dopaSnapshot(){
  return {chaos:chaos.snapshot(),chaosIntensity:chaos.intensity(),streak:streak.snapshot(simulationTime),hud:hud.snapshot(),hitstop:hitstopT,
    beacons:beacons.map(b=>({on:b.on,angle:b.angle,intensity:b.intensity})),
    chaosLights:practicalLights.map((l,i)=>({index:i,visible:l.visible,base:l.userData.base===undefined?null:l.userData.base,level:l.userData.level,shelter:!!l.userData.shelter})),
    dopamine:{hitstops:dopa.hitstops,lastHitstop:dopa.lastHitstop,emergency:dopa.emergency,shock:dopa.shock,kills:dopa.kills,lastKill:dopa.lastKill,
      damage:dopa.damage,damageHits:dopa.damageHits,liveEmissive:dopa.live?dopa.live.emissiveIntensity:null,liveBase:dopa.liveBase,
      killFlash:typeof fxKill!=='undefined'?fxKill:null,tintedCones:dopa.cones.size}};
}
function fnv(str){let h=0x811c9dc5;for(let i=0;i<str.length;i++){h^=str.charCodeAt(i);h=Math.imul(h,0x01000193)>>>0;}return h.toString(36);}
function encodeResult(r){const o={n:r.name,t:r.time,k:r.kills,a:r.at};if(r.score)o.s=r.score;if(r.mode==='coop'){o.m='coop';if(r.partner)o.p=r.partner;}if(r.escaped===false)o.e=0;
  const j=JSON.stringify(o);const b=btoa(unescape(encodeURIComponent(j))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');return 'HOLLOW-'+b+'-'+fnv('hollow|'+j);}
function decodeResult(code){
  const m=String(code).trim().match(/^HOLLOW-([A-Za-z0-9_-]+)-([a-z0-9]+)$/);if(!m)return null;
  try{let b=m[1].replace(/-/g,'+').replace(/_/g,'/');while(b.length%4)b+='=';const j=decodeURIComponent(escape(atob(b)));
    if(fnv('hollow|'+j)!==m[2])return null;const o=JSON.parse(j);return cleanRow({name:o.n,time:o.t,kills:o.k,at:o.a,score:o.s,mode:o.m,partner:o.p,escaped:o.e!==0});}catch(e){return null;}
}
function localBest(){const me=nameKey(playerName);return localScores.map(cleanRow).filter(r=>r&&(!me||nameKey(r.name)===me)).sort(compareRuns)[0]||null;}
function copyCode(codeEl,btn){const txt=codeEl.textContent;
  const done=()=>{btn.textContent='Copied';setTimeout(()=>btn.textContent='Copy code',1600);};
  const sel=()=>{try{const r=document.createRange();r.selectNodeContents(codeEl);const s=getSelection();s.removeAllRanges();s.addRange(r);btn.textContent='Press Ctrl+C';}catch(e){}};
  try{navigator.clipboard.writeText(txt).then(done,sel);}catch(e){sel();}}
function updateShare(){
  const posting=sharedRows!==null&&canPost!==false;
  const best=localBest();
  const onBoard=best&&sharedRows&&sharedRows.some(r=>nameKey(r.name)===nameKey(best.name)&&r.mode===best.mode&&compareRuns(r,best)<=0);
  const show=!posting&&sharedState!=='loading'&&best&&!onBoard;
  $('menuShare').hidden=!show;if(show)$('menuCode').textContent=encodeResult(best);
  $('importForm').hidden=!(amOwner&&scoresCol);
}
// Rows without the newer fields are solo escapes, the only results the board used to keep.
function cleanRow(r){if(!r||typeof r!=='object')return null;const time=Number(r.time),escaped=r.escaped!==false,mode=r.mode==='coop'?'coop':'solo';if(!isFinite(time)||time<0||(escaped&&time<=0))return null;
  return {name:String(r.name||'Someone').slice(0,18),time,kills:Math.max(0,Math.min(12,Number(r.kills)||0)),score:Math.max(0,Math.min(1e6,Math.floor(Number(r.score)||0))),
    mode,partner:mode==='coop'?String(r.partner||'').slice(0,18):'',escaped,at:Number(r.at)||0,uid:r.uid||null,imported:!!r.imported};}
// Same order as the server: escapes first, then higher score, then the faster escape or longer survival.
function compareRuns(a,b){return (b.escaped-a.escaped)||(b.score-a.score)||(a.escaped?a.time-b.time:b.time-a.time)||(a.at-b.at);}
function nameKey(n){return String(n||'').replace(/\s+/g,' ').trim().toLowerCase();}
function fmtScore(n){return String(Math.max(0,Math.floor(Number(n)||0))).replace(/\B(?=(\d{3})+(?!\d))/g,',');}
function runSummary(r){return [(r.escaped?'escaped in ':'lasted ')+fmtTime(r.time),r.score?fmtScore(r.score)+' pts':'',r.mode==='coop'?'co-op'+(r.partner?' with '+r.partner:''):''].filter(Boolean).join(' · ');}
// ===== I2: audio integration =====
// Creature voices (audio.js), the player's body (player-audio.js) and the weapons (weapon-audio.js) are driven from
// here; call sites elsewhere only make short calls into this section.
if(!window.HollowPlayerAudio||!window.HollowWeaponAudio)throw new Error('A local game asset could not be loaded.');
const VOICE_PRIORITY={breath:0,step:1,whisper:2,moan:2,chatter:2,notice:3,laugh:3,growl:3,howl:3,snarl:3,attack:4,death:4,scream:4,wake:4};
// Footsteps by weight: the Warden's tread carries, the others creep about 3-4.5 dB under it.
const STEP_LEVEL={warden:1,stalker:.85,crawler:.85,shrieker:.85};
const audioLater=[],audioLog=[],shotHit={headshot:false,armored:false,heavy:false};
const bodyIn={active:false,stamina:1,exhausted:false,running:false,moving:false,danger:0,chase:false,health:100,effects:true,hidden:false};
// A threat call ducks the player's body bus (heartbeat, grunts, chase music): [max distance m, gain, hold s].
const DUCK={scream:[30,.4,1.4],wake:[30,.45,1.4],notice:[20,.65,.9],howl:[45,.7,1.2],snarl:[10,.6,.8],laugh:[12,.7,1],whisper:[10,.7,1.2]};
let reloadEmpty=false,audioFault=false,audioSeq=0,bodyBus=null,duckFree=0,duckDepth=1,duckEnd=0;
// Master safety limiter: a fast high-ratio compressor (its automatic makeup gain trimmed back out), then a soft
// ceiling at -0.63 dBFS, so a pile-up of shots, screams and stingers never clips. Returns the chain's input.
function masterOut(){
  const comp=AC.createDynamicsCompressor(),trim=AC.createGain(),ceiling=AC.createWaveShaper(),curve=new Float32Array(2049);
  comp.threshold.value=-4;comp.knee.value=3;comp.ratio.value=20;comp.attack.value=.002;comp.release.value=.12;
  trim.gain.value=.816;
  for(let i=0;i<curve.length;i++){const x=i/1024-1,a=Math.abs(x);curve[i]=Math.sign(x)*(a<.8?a:.8+.15*Math.tanh((a-.8)/.15));}
  ceiling.curve=curve;ceiling.oversample='none';
  comp.connect(trim);trim.connect(ceiling);ceiling.connect(AC.destination);
  return comp;
}
// HollowPlayerAudio's own bus. A scream, a rush notice, a laugh or a whisper nearby ducks it, so the call cuts through a
// racing heartbeat and the chase bed; a stinger is never ducked and holds ducking off for 1.5 s.
function bodyOut(){bodyBus=AC.createGain();bodyBus.connect(master);return bodyBus;}
function bodyGain(value,tau){const g=bodyBus.gain,now=AC.currentTime;g.cancelScheduledValues(now);g.setValueAtTime(g.value,now);g.setTargetAtTime(value,now,tau);}
function duckBody(cue,d){
  const k=DUCK[cue],now=AC.currentTime;if(!k||!bodyBus||d>k[0]||now<duckFree)return;
  duckDepth=now<duckEnd?Math.min(duckDepth,k[1]):k[1];duckEnd=Math.max(duckEnd,now+k[2]);
  bodyGain(duckDepth,.03);bodyBus.gain.setTargetAtTime(1,duckEnd,.25);
}
function playStinger(cue,kind){
  if(!playerAudio||playerAudio.stinger(cue)==null)return false;
  logCue('player',cue,kind);duckFree=AC.currentTime+1.5;duckEnd=0;if(bodyBus)bodyGain(1,.02);
  return true;
}
// A short ring buffer of played cues for QA (HollowGame.snapshot().audioLog).
function logCue(src,cue,kind){audioLog.push({n:++audioSeq,t:Math.round(t*1000)/1000,src,cue,kind:kind||null});if(audioLog.length>96)audioLog.shift();}
function audioAfter(delay,fn){if(AC)audioLater.push({at:AC.currentTime+delay,fn});}

/* creature voices */
// One creature cue at a world position, gated by distance, the effects setting and the voice budget; walls muffle it.
function sVoice(kind,cue,x,y,z,volume=1){
  if(!creatureAudio)return null;
  const spectating=state==='spect'||state==='pause'&&prevState==='spect',viewer=spectating?watched().pos:P.pos,d=Math.hypot(viewer.x-x,viewer.z-z);
  if(d>(cue==='breath'?16:cue==='whisper'?10:cue==='chatter'?14:cue==='scream'||cue==='howl'?60:cue==='wake'?48:38))return null;
  if(!preferences.effects){
    if(cue==='notice'||cue==='attack'||cue==='scream'||cue==='laugh'||cue==='howl'||cue==='wake'){if(d>38)return null;cue='breath';volume*=.65;}
    else if(cue==='whisper'||cue==='moan'||cue==='growl'||cue==='snarl'||cue==='chatter')volume*=.5;
  }
  if(!voiceRoom(cue))return null;
  const eye=spectating?(watched().raw.y||0)+(watched().raw.crouch?1:EYE):P.pos.y+P.eye;
  const id=creatureAudio.play(kind,cue,{x,y,z,volume,occluded:!sightLine(viewer.x,eye,viewer.z,x,y,z)});
  if(id!=null){logCue('creature',cue,kind);duckBody(cue,d);}
  return id;
}
// A full mix gives up its oldest lowest-priority voice: a growl, laugh or scream must never take a rush's notice.
function voiceRoom(cue){
  if(VOICE_PRIORITY[cue]<3||cue==='notice'||cue==='attack'||cue==='death'||cue==='wake')return true;
  const s=creatureAudio.snapshot();if(s.activeVoices<s.maxVoices)return true;
  let victim=null;for(const v of s.voices)if(!victim||VOICE_PRIORITY[v.cue]<VOICE_PRIORITY[victim.cue])victim=v;
  return !victim||victim.cue!=='notice';
}
function vox(m){return m.vox||(m.vox={state:null,whisperT:rnd(2,6),moanT:rnd(8,16),laughT:0,laughed:false,chargeT:0,lungeCD:0,lunge:0,painAt:-99,killed:false,said:{attack:-99,scream:-99}});}
function playerSees(m){return watchingMonster(m,{x:P.pos.x,z:P.pos.z,yaw:P.yaw,torch:torchOn})&&los(P.pos.x,P.pos.z,m.pos.x,m.pos.z);}
// The voice timer plus the moments that matter: a chase starting, a stare, a hiding player, a whisper behind your back.
function monsterVoice(m,dt){
  const v=vox(m),d=Math.hypot(P.pos.x-m.pos.x,P.pos.z-m.pos.z);
  v.killed=false;v.whisperT-=dt;v.moanT-=dt;v.laughT-=dt;v.chargeT-=dt;v.lungeCD-=dt;
  if(m.lungeT>v.lunge+.05)audioOnLunge(m);
  v.lunge=m.lungeT;
  if(m.state!==v.state){
    const was=v.state;v.state=m.state;
    if(m.state==='stalk')v.laughed=false;
    // Losing the trail: a long howl that tells the whole floor it is still hunting.
    if(was==='chase'&&m.state==='search'&&t-howlAt>4){howlAt=t;m.voiceT=Math.max(m.voiceT,rnd(4,6));audioAfter(rnd(.2,.6),()=>{if(!m.dead&&!m.dormant)sCreature(m,'howl');});}
    // chargeCue plays the notice; the Warden and the Shrieker follow it with a scream, the sneaky kinds with a growl.
    if(m.state==='chase'&&v.chargeT<=0){
      const cue=m.kind==='warden'||m.kind==='shrieker'?'scream':'growl';v.chargeT=6;m.voiceT=Math.max(m.voiceT,rnd(2.2,3.4));
      if(t-v.said.scream>2)audioAfter(rnd(.35,.55),()=>{if(!m.dead&&m.state==='chase')sCreature(m,cue);});
    }
  }
  if(m.state==='stalk'){
    if(!v.laughed&&(m.watchT>.5||P.hidden&&d<8)){v.laughed=true;sCreature(m,'laugh');m.voiceT=Math.max(m.voiceT,2.5);return;}
    if(d<=6&&v.whisperT<=0&&!playerSees(m)){v.whisperT=rnd(8,14);sCreature(m,'whisper');m.voiceT=Math.max(m.voiceT,3);return;}
  }else if(m.state!=='chase'&&P.hidden&&d<8&&v.laughT<=0){v.laughT=rnd(20,30);sCreature(m,'laugh');m.voiceT=Math.max(m.voiceT,2.5);return;}
  if(m.voiceT>0)return;
  if(m.state==='chase'){
    // Within reach it snarls, fast and close; far off it may howl to the others.
    if(d<9){m.voiceT=rnd(.9,1.6);sCreature(m,'snarl');}
    else if(d>22&&t-howlAt>7&&Math.random()<.35){howlAt=t;m.voiceT=rnd(3,5);sCreature(m,'howl');}
    else{m.voiceT=rnd(1.6,3);sCreature(m,'growl');}
  }
  else if(m.state==='stalk'){m.voiceT=rnd(4.5,7.5);if(m.kind==='crawler'&&d<12&&Math.random()<.6)sCreature(m,'chatter',.8);else sCreature(m,'breath',.55);}
  else{
    m.voiceT=rnd(5,9);
    if(d<8&&v.whisperT<=0){v.whisperT=rnd(8,14);sCreature(m,'whisper');}
    else if(m.state==='search'&&d>10&&t-howlAt>8&&Math.random()<.3){howlAt=t;sCreature(m,'howl');}
    else if(m.kind==='crawler'&&d<12&&Math.random()<.4)sCreature(m,'chatter',.7);
    else if(v.moanT<=0&&Math.random()<.4){v.moanT=rnd(12,20);sCreature(m,'moan');}
    else sCreature(m,'breath',.85);
  }
}
// A lunge (a pounce, a door bash) growls, the Shrieker screams; a hit on the player already has its attack cue.
function audioOnLunge(m){
  const v=vox(m);if(v.lungeCD>0||t-v.said.attack<.8)return;
  v.lungeCD=m.kind==='shrieker'?8:3;sCreature(m,m.kind==='shrieker'?'scream':'growl');
}
// I1b's fire() hook (dopaShotEnd) reports each shot's result here once: info={m,headshot,kill,armored,result}.
function audioOnHit(info){
  const m=info&&info.m;if(!m||m.dead||info.kill)return;
  const v=vox(m);if(t-v.painAt<1.5)return;
  v.painAt=t;sCreature(m,'growl',m.kind==='warden'?.6:.85);m.voiceT=Math.max(m.voiceT,1.2);
}
function audioOnKill(info){
  const m=info&&info.m;if(!m)return;const v=vox(m);if(v.killed)return;v.killed=true;
  const r=info.result;playStinger(info.headshot?'headshot':'kill',m.kind);
  if(r&&(r.count>=2||r.label==='WARDEN DOWN'))playStinger('streak',r.label);
}
// A blow that leaves the survivor standing (hurtfx.js plan): the world goes dull through the master low-pass and creeps
// back; a heavy one rings in the ears, straight into the output past the muffle.
function audioHurt(p){
  if(!AC||!hurtLP||!p)return;
  const now=AC.currentTime,f=hurtLP.frequency,mu=p.muffle;
  if(mu&&mu.amount>.02){
    const from=Math.min(22000,Math.max(100,f.value||22000)),to=Math.max(120,Math.min(from,mu.hz));
    f.cancelScheduledValues(now);f.setValueAtTime(from,now);f.exponentialRampToValueAtTime(to,now+.03);
    f.setTargetAtTime(22000,now+.03+mu.time*.35,mu.time*.3);
    logCue('player','muffle',p.kind||'blow');
  }
  const r=p.ring;
  if(r&&preferences.effects&&preferences.volume>0){
    const peak=.05*r.gain*preferences.volume,g=AC.createGain();g.gain.value=0;g.connect(hurtOut);
    g.gain.setValueAtTime(0,now);g.gain.linearRampToValueAtTime(peak,now+.06);g.gain.setTargetAtTime(0,now+.06+r.time*.15,r.time*.3);
    for(const hz of [r.hz,r.hz*1.006]){const o=AC.createOscillator();o.type='sine';o.frequency.value=hz;o.connect(g);o.start(now);o.stop(now+.1+r.time*1.6);}
    logCue('player','ring',p.kind||'blow');
  }
}
// The killing blow lands under the scare hit; the kill sequence (HollowKillAudio) plays the rest.
function audioOnCaught(m){
  if(playerAudio)playStinger('scare','caught');
}

/* chaos director events (I1b calls this for every event) */
function audioChaosEvent(e){
  if(!e||!AC)return;
  if(e.type==='chaseStart'){playStinger('chase');return;}
  if(e.type==='surge'){if(playerAudio&&playerAudio.surge(e.intensity)!=null)logCue('player','surge');return;}
  if(e.type==='blackout'){sThud(P.pos.x,H-.1,P.pos.z,.45,110);logCue('world','blackout');return;}
  // chaosEvent() fills e.x/e.y/e.z (where the sparks fall, where the caption points) before it calls here.
  const placed=Number.isFinite(e.x)&&Number.isFinite(e.z);
  if(e.type==='sparks'){
    const l=Number.isInteger(e.light)?practicalLights[e.light]:null,o=placed?e:l&&l.position;
    if(o&&Number.isFinite(o.x))sSpark(o.x,Number.isFinite(o.y)?o.y:H-.3,o.z);else sSpark(P.pos.x+rnd(-2.5,2.5),H-.1,P.pos.z+rnd(-2.5,2.5));
    logCue('world','sparks');return;
  }
  let x=e.x,z=e.z;
  if(!placed){const b=Number(e.bearing),d=Number(e.distance);if(!Number.isFinite(b)||!Number.isFinite(d))return;x=P.pos.x+Math.cos(b)*d;z=P.pos.z+Math.sin(b)*d;}
  if(e.type==='scream'){sVoice('shrieker','scream',x,1.7,z);playStinger('scare');}
  else if(e.type==='slam'){sThud(x,1.4,z,.95,170);audioAfter(.11,()=>sThud(x,1.1,z,.4,320));logCue('world','slam');playStinger('scare');}
  else if(e.type==='whisper'){sVoice(Math.random()<.5?'stalker':'crawler','whisper',x,1.5,z);}
  else if(e.type==='laugh'){sVoice('stalker','laugh',x,1.6,z);}
}
function sSpark(x,y,z){
  if(!AC)return;const n=AC.currentTime,p=makePanner(2,1.2);setPos(p,x,y,z);
  for(let k=0,grains=preferences.effects?7:3;k<grains;k++){const st=n+rnd(0,.22),s=noiseSrc(),f=AC.createBiquadFilter(),g=AC.createGain();
    f.type='highpass';f.frequency.value=rnd(2500,6000);s.connect(f);f.connect(g);g.connect(p);env(g,st,.001,rnd(.06,.2),rnd(.015,.05));s.start(st,Math.random());s.stop(st+.08);}
  const o=AC.createOscillator(),og=AC.createGain();o.type='sawtooth';o.frequency.value=120;o.connect(og);og.connect(p);env(og,n,.004,.035,.18);o.start(n);o.stop(n+.25);
}

/* weapons */
function sShot(){
  if(!weaponAudio)return;const w=weaponDefs[weaponIndex],floor=stepKind();
  if(weaponAudio.shot(w.id,{aiming,ammo:mag,capacity:w.capacity,indoor:floor==='grass'?0:1,effects:preferences.effects})!=null)logCue('weapon','shot',w.id);
  weaponAudio.casing(w.id,{surface:floor});
}
function sShotAt(x,z,weapon){
  if(!weaponAudio)return;const viewer=state==='spect'||state==='pause'&&prevState==='spect'?watched().pos:P.pos;
  weaponAudio.remoteShot(weaponDefs[weapon]?.id||'rifle',{x,y:1.5,z,occluded:!los(x,z,viewer.x,viewer.z),distance:Math.hypot(x-viewer.x,z-viewer.z)});
}
function sDry(){if(weaponAudio&&weaponAudio.dry(weaponDefs[weaponIndex].id)!=null)logCue('weapon','dry');}
function sReload(){const w=weaponDefs[weaponIndex];reloadEmpty=mag===0;if(weaponAudio&&weaponAudio.reload(w.id,w.reload,{empty:reloadEmpty})!=null)logCue('weapon','reload',w.id);}
function sPickup(type){playStinger(type==='fuse'?'fuse':'pickup',type);}
// Per pellet, once fire() has resolved it: flesh on monsters, the struck material on walls, doors and props.
// imp (hitzones.js impact()): where the round went picks the flesh sound (a cracking skull, a heavy torso thump...).
function audioBullet(hit,best,distance,wallDistance,imp){
  if(best){
    const m=best.m;
    if(m){if(best.headshot??best.y>m.stats.head)shotHit.headshot=true;if(m.kind==='warden')shotHit.armored=true;}
    if(weaponAudio&&weaponAudio.impact('flesh',{x:hit.x,y:hit.y,z:hit.z,distance,variant:imp?.variant,weight:imp?.weight})!=null)logCue('weapon','impact','flesh');
  }else if(wallDistance<48&&weaponAudio){
    const surface=surfaceAt(hit.x+_d.x*.08,hit.y+_d.y*.08,hit.z+_d.z*.08);
    if(weaponAudio.impact(surface,{x:hit.x,y:hit.y,z:hit.z,distance:wallDistance})!=null)logCue('weapon','impact',surface);
  }
}
function surfaceAt(x,y,z){
  if(y<=0||y>=H)return 'concrete';
  if(metalAt(x,z))return 'metal';
  for(const p of roomProps)if(y<p.h+.05&&Math.abs(x-p.x)<p.w/2+.1&&Math.abs(z-p.z)<p.d/2+.1)return p.h>1.3?'metal':'wood';
  return 'concrete';
}
// One tick per volley, on the same event as the visual hit marker.
function audioHitTick(){
  if(weaponAudio&&weaponAudio.hitMarker({headshot:shotHit.headshot,armored:shotHit.armored,heavy:!!shotHit.heavy})!=null)logCue('weapon','hitMarker',shotHit.headshot?'headshot':shotHit.armored?'armored':'body');
  shotHit.headshot=shotHit.armored=shotHit.heavy=false;
}

/* per frame, stopping and resuming */
function audioFrame(dt){
  if(!AC)return;
  try{
    const now=AC.currentTime;
    for(let i=0;i<audioLater.length;){if(audioLater[i].at<=now)audioLater.splice(i,1)[0].fn();else i++;}
    const active=state==='play';
    let chase=false;
    if(active)for(const m of monsters)if(!m.dead&&m.state==='chase'&&Math.hypot(P.pos.x-m.pos.x,P.pos.z-m.pos.z)<32){chase=true;break;}
    if(!playerAudio)return;
    bodyIn.active=active;bodyIn.stamina=P.stamina;bodyIn.exhausted=P.exhausted;bodyIn.running=P.running;bodyIn.moving=P.moving;
    bodyIn.danger=danger;bodyIn.chase=chase;bodyIn.health=P.health;bodyIn.effects=preferences.effects;bodyIn.hidden=P.hidden;
    playerAudio.update(dt,bodyIn);
  }catch(error){if(!audioFault){audioFault=true;console.warn('[The Hollow] Audio update failed:',error);}}
}
// keepTails lets the death screen hear the last laugh and the scare hit ring out.
function stopAudio(keepTails){
  if(weaponAudio)weaponAudio.stop();
  if(keepTails)return;
  if(creatureAudio)creatureAudio.stop();if(playerAudio)playerAudio.stop();audioLater.length=0;
}
// A co-op pause keeps the shared world audible but holds the reload, which no longer advances.
function audioPause(){if(!NET.inGame)stopAudio();else if(weaponAudio)weaponAudio.cancelReload();}
function resumeAudio(){const w=weaponDefs[weaponIndex];if(weaponAudio&&state==='play'&&reloadT>0)weaponAudio.reload(w.id,w.reload,{empty:reloadEmpty,progress:1-reloadT/w.reload});}

function renderBoards(){
  const shared=sharedRows!==null;
  const all=(shared?sharedRows:localScores.map(cleanRow).filter(Boolean)).slice().sort(compareRuns);
  const me=nameKey(playerName);
  const isMine=r=>!!me&&nameKey(r.name)===me&&(!shared||(!!myId&&r.uid===myId)||r.imported);
  // The player's best solo and best co-op runs are marked, and still listed when they fall outside the top ten.
  const mineAt=['solo','coop'].map(mode=>all.findIndex(r=>r.mode===mode&&isMine(r))).filter(i=>i>=0).sort((a,b)=>a-b);
  const myIdx=mineAt.length?mineAt[0]:-1;
  const top=all.slice(0,10);
  const mkRow=(r,rank)=>{const li=document.createElement('li');if(mineAt.includes(rank-1))li.className='me';
    li.title=r.name+': '+runSummary(r);
    const cells=[['rk',String(rank)],['nm',r.name],['tg',[r.mode==='coop'?'co-op':'',r.escaped?'':'fell'].filter(Boolean).join(' · ')],
      ['sc',fmtScore(r.score)],['tm',fmtTime(r.time)],['kl',r.kills?r.kills+(r.kills===1?' kill':' kills'):'no kills']];
    for(const [c,t] of cells){const sp=document.createElement('span');sp.className=c;sp.textContent=t;li.appendChild(sp);}return li;};
  document.querySelectorAll('.board').forEach(b=>{
    b.querySelector('.boardScope').textContent=sharedState==='loading'?'Loading':shared?'All players':'This browser';
    const mine=b.querySelector('.boardMine');mine.textContent='';
    if(playerName&&sharedState!=='loading'){
      if(myIdx>=0){mine.append('Your best: ');const bb=document.createElement('b');bb.textContent='#'+(myIdx+1);mine.append(bb,` of ${all.length} · ${runSummary(all[myIdx])}`);}
      else{const lb=localBest();mine.textContent=lb?`Your best on this browser: ${runSummary(lb)} \u2014 ${all.length>=100?'not in the top 100 yet':'not on the shared board yet'}.`:`${playerName}, finish a run to get on the board.`;}
    }
    const ol=b.querySelector('.boardList');ol.textContent='';
    if(!all.length){const p=document.createElement('p');p.className='empty';p.textContent='No scores yet. Be the first to go in.';ol.appendChild(p);}
    top.forEach((r,i)=>ol.appendChild(mkRow(r,i+1)));
    const below=mineAt.filter(i=>i>=10);
    if(below.length){const g=document.createElement('li');g.className='gap';g.textContent='⋮';ol.appendChild(g);for(const i of below)ol.appendChild(mkRow(all[i],i+1));}
    let foot='';
    if(shared&&canPost===false)foot='Only the owner\u2019s account can post directly. Other players send the owner a result code from the win screen or main menu.';
    else if(!shared&&sharedState==='none')foot='Scores are saved on this browser.';
    else if(shared)foot='Escapes rank first, then score. Every player keeps a best solo and a best co-op run.';
    b.querySelector('.boardFoot').textContent=foot;
  });
  updateShare();
}
async function initBoard(){
  try{
    const db=await claude.use('db');
    if(!db){sharedState='none';renderBoards();return;}
    const user=await claude.use('user');
    if(user){try{myId=await user.id();}catch(e){myId=null;}try{canPost=await user.can('data.write');}catch(e){canPost=null;}try{amOwner=await user.isOwner();}catch(e){amOwner=false;}}
    if(!myId)canPost=false;
    scoresCol=db.collection('scores');
    scoresCol.orderBy('time','asc').limit(100).onSnapshot(snap=>{
      sharedState='live';
      sharedRows=snap.docs.map(d=>{const r=cleanRow(d.data()||{});if(r&&!r.uid)r.uid=d.id;return r;}).filter(Boolean);
      renderBoards();
    },()=>{sharedState='none';sharedRows=null;renderBoards();});
  }catch(e){sharedState='none';renderBoards();}
}
// Two co-op partners on one network share an IP, and the server accepts one score per IP every few seconds.
async function postRun(ref,data){
  for(let attempt=0;;attempt++){
    try{return await ref.set(data);}
    catch(e){if(!e||e.code!=='rate_limited'||attempt>=3)throw e;await new Promise(done=>setTimeout(done,Math.min(10,Math.max(1,Number(e.retryAfter)||3))*1000+Math.random()*400));}
  }
}
// Every finished run is recorded: solo or co-op, escaped or not. noteId is the result screen's rank line.
async function recordRun(run,noteId){
  const row=cleanRow({...run,name:playerName||'Guest',time:Math.min(7200,Math.round(run.time*10)/10),at:Date.now()});if(!row)return;
  const token=++runToken,note=text=>{if(token===runToken)$(noteId).textContent=`Score ${fmtScore(row.score)}.`+(text?' '+text:'');};
  lastMine=row;localScores.push(row);localScores.sort(compareRuns);localScores=localScores.slice(0,50);lsSet(LS_SCORES,JSON.stringify(localScores));
  note('');renderBoards();
  let text='';
  if(scoresCol&&myId&&canPost!==false){
    try{
      const cur=sharedRows&&sharedRows.find(r=>r.uid===myId&&r.mode===row.mode&&nameKey(r.name)===nameKey(row.name)),kept=!!cur&&compareRuns(cur,row)<=0;
      let best=kept?cur:null;
      if(!kept||cur.name!==row.name){
        const send=kept?cur:row;
        const res=await postRun(scoresCol.doc(myId+'_'+row.mode+'_'+fnv(nameKey(row.name))),{name:row.name,time:send.time,kills:send.kills,score:send.score,mode:send.mode,partner:send.partner,escaped:send.escaped,at:send.at,uid:myId});
        // A best run outside the cached top 100 is only known to the server.
        if(!kept&&res&&res.improved===false&&res.best)best=cleanRow({...row,...res.best,partner:''});
      }
      text=best?`Your best ${row.mode==='coop'?'co-op ':''}run is still: ${runSummary(best)}.`:'New personal best, posted to the board.';
    }catch(e){text='Saved on this browser. Shared board temporarily unavailable.';}
  }else{const r=localScores.indexOf(row)+1;text=r?`Rank ${r} on this browser.`:'';}
  if(noteId==='winRank'){const showCode=canPost===false||!scoresCol;$('winShare').hidden=!showCode;if(showCode)$('winCode').textContent=encodeResult(row);}
  note(text);renderBoards();
}

// Read-only instrumentation is useful for profiling; deterministic test controls
// are deliberately restricted to an explicit localhost QA session.
function animSummary(m){const a=m.anim.snapshot();return {run:a.run,lunge:a.lunge,attack:a.attack,scream:a.scream,dying:a.dying,dead:a.dead,settled:a.settled,deathMode:a.deathMode,footsteps:a.footsteps,rising:a.rising,rise:a.rise,
  pitch:m.g.rotation.x,roll:m.g.rotation.z,y:m.g.position.y,lowest:HollowMonsterAnim.lowest(m.kind,m.anim.pose)};}
function snapshot(){return {
  state,seed:worldSeed,position:{x:P.pos.x,y:P.pos.y,z:P.pos.z},yaw:P.yaw,pitch:P.pitch,onGround:P.onGround,crouching:P.crouching,running:P.running,hidden:P.hidden,health:P.health,stamina:P.stamina,torchOn,battery,
  weapon:weaponDefs[weaponIndex].id,mag,reserve,reloadT,aiming,elapsed,simulationTime,fuses,exitPowered,exitRelease,exitOpen,decoys,
  floor,floorCode:FLOOR().code,owned:weaponDefs.filter((w,i)=>owned[i]).map(w=>w.id),score:runScore(),
  checkpoint:checkpoint?{floor:checkpoint.floor,elapsed:checkpoint.elapsed,owned:weaponDefs.filter((w,i)=>checkpoint.kit.owned[i]).map(w=>w.id)}:null,
  savedFloor:savedCampaign()?.floor||0,
  viewmodel:{weapons:weaponModels.filter(model=>model.visible).map(model=>model.userData.kind),torch:torch.visible},
  player:{speed:Math.hypot(P.vel.x,P.vel.z),sprint:P.sprint,stamina:P.stamina,exhausted:P.exhausted,sliding:slideT>0,strafe:P.strafe},
  camera:{...camFX.snapshot(),y:camFX.pose.pos.y,x:camFX.pose.pos.x,roll:camFX.pose.rot.roll,pitch:camFX.pose.rot.pitch,fovAdd:camFX.pose.fov,fov:camera.fov,weaponZ:camFX.pose.weapon.z},
  kill:killSnapshot(),
  injury:RULES.injuryLevel(P.health),audio:creatureAudio?creatureAudio.snapshot():null,
  playerAudio:playerAudio?playerAudio.snapshot():null,weaponAudio:weaponAudio?weaponAudio.snapshot():null,audioLog:audioLog.slice(),bodyDuck:bodyBus&&AC.currentTime<duckEnd?duckDepth:1,
    horror:{...horror.snapshot(),effects:preferences.effects,notesRead:readNotes.size},
      flashes:{muzzle:!!muzzleFlash?.visible,world:muzzleLight.userData.level,weapon:fpFlash.userData.level,partner:Math.max(0,...RIGS.map(o=>o.flash.userData.level))},
    records:caseNotes.map(n=>({id:n.id,x:n.x,z:n.z,title:n.title})),
    // intensity keeps the r128 light level; candela is the physical value sent to the renderer.
    atmosphere:atm?atm.snapshot():null,postfx:fx?fx.snapshot():null,
    lighting:practicalLights.map(l=>({visible:l.visible,intensity:l.userData.level,candela:l.intensity,x:l.position.x,z:l.position.z})),
    notes:captionText,
    ...dopaSnapshot(),
  performance:{fps:Math.round(1000/frameAverage),drawCalls:renderCalls,frames:renderedFrames,triangles:renderer.info.render.triangles,quality:qualityLevel,renderScale,pixelRatio:renderer.getPixelRatio(),wardDetail:wardDetail.value,geometries:renderer.info.memory.geometries,textures:renderer.info.memory.textures,backend:window.HollowBackend},
  rooms:specialRooms.map(r=>({id:r.id,name:r.name,x:r.x,z:r.z,w:r.w,d:r.d,shelter:!!r.shelter,fuse:!!r.fuse})),
  doors:roomDoors.map(d=>({id:d.id,x:d.box.x,z:d.box.z,open:d.open,locked:d.locked,health:d.health})),
  mapGuns:mapGuns.map(g=>({...g})),
  loot:roomLoot.map(l=>({id:l.id,type:l.type,x:l.x,z:l.z,taken:l.taken,pending:!!l.pending,...(l.type==='weapon'?{weapon:weaponDefs[l.weapon].id,visible:l.g.visible}:{})})),
  ammoPickups:ammoBoxes.map((b,i)=>({id:i,x:b.x,z:b.z,taken:b.taken,pending:!!b.pending})),
  boss:bossSnapshot(),
  enemies:monsters.slice(0,monCount).map((m,i)=>({index:i,kind:m.kind,x:m.pos.x,z:m.pos.z,hp:m.hp,dead:m.dead,state:m.state,speed:m.stats.chase,moveSpeed:m.g.userData.speed,stalkTime:m.stalkT,watchTime:m.watchT,lunge:m.lungeBoost>0,lungeCooldown:m.lungeCD,anim:animSummary(m),
    dormant:!!m.dormant,sleep:m.sleep||0,wakeIn:m.wakeIn,rising:m.riseT>0,visible:m.g.visible,body:m.dormant?m.lay.slice():null,hits:hitsSummary(m)})),
  // Hits (hitzones.js, gore.js, hurtfx.js): the last shot that struck a creature, the gore pools, the survivor's hurt.
  shot:lastShot,gore:gore.snapshot(),
  hurt:{last:hurtLast,slow:hurtSlowT>0?1-(1-hurtSlowF)*Math.min(1,hurtSlowT/hurtSlowDur*1.5):1,slowTime:hurtSlowT,pulse:hurtPulse,muffle:hurtLP?hurtLP.frequency.value:null,fx:hurtFX.snapshot()},
  network:(()=>{const list=partners(),R=list.find(r=>r.role==='guest')||list[0]||NOBODY;return{role:NET.role,inGame:NET.inGame,generation:NET.gen,partner:list.length>0,code:NET.code,partnerY:R.raw.y||0,partnerCrouching:!!R.raw.crouch,
    partners:list.map(r=>({name:r.nm,role:r.role,present:r.present,alive:!!r.al&&!r.out,inRound:r.gn===NET.gen,avatar:!!r.rig&&r.rig.avatar.visible})),avatars:RIGS.filter(o=>o.owner&&o.avatar.visible).length,spectating:NET.spect&&REMOTES.get(NET.spect)?.nm||null};})(),
  input:{mouseDown,touchX:touchMove.x,touchY:touchMove.y}
};}
window.HollowGame=Object.freeze({snapshot});
if(['localhost','127.0.0.1','[::1]'].includes(location.hostname)&&new URLSearchParams(location.search).get('qa')==='1'){
  window.HollowTest=Object.freeze({
    snapshot,maze:()=>grid.map(row=>row.slice()),
    colliders:()=>roomProps.map(p=>({...p})),
    pose:({x,z,y=0,yaw=0,pitch=0})=>{P.pos.set(x,y,z);P.vel.set(0,0,0);P.velY=0;P.yaw=yaw;P.pitch=pitch;P.onGround=y===0;},
    silence:()=>{hideMonsters();grace=100000;},
    enemy:(index,pose)=>{const m=monsters[index];m.pos.set(pose.x,0,pose.z);m.g.position.copy(m.pos);m.hp=m.stats.hp;m.dead=false;m.spawned=true;m.g.visible=true;m.state=pose.state||'wander';m.path=[];m.yaw=pose.yaw||0;m.g.rotation.set(0,m.yaw,0);m.lastSeen.copy(P.pos);m.attackT=0;m.senseT=0;m.seenTarget=null;m.heardTarget=null;m.stalkT=0;m.watchT=0;m.lost=0;m.spotCD=0;m.repath=0;m.lungeT=0;m.lungeCD=0;m.lungeBoost=0;m.watched=false;m.anim.reset();m.animYaw=m.yaw;m.voiceT=3;grace=0;
      m.dormant=false;m.riseT=0;m.wakeIn=-1;m.sleep=0;m.rate=0;m.g.userData.eyeMat.color.setHex(m.g.userData.eyeColor||0xff2a14);monCount=Math.max(monCount,index+1);clearHits(m);},
    // A sleeping body in slot `index`, lying at (x, z) along `yaw`. Returns its three body points.
    sleeper:(index,{x,z,yaw=0})=>{const m=monsters[index];resetMonster(m,x,z,yaw);layDown(m,index);monCount=Math.max(monCount,index+1);return m.lay.slice();},
    wake:index=>wakeMonster(monsters[index],{x:P.pos.x,z:P.pos.z}),
    // Gives the survivor `ids` (full magazines and the starting reserves) and draws `select`, like the old full kit.
    arm:(ids=['rifle','pistol','shotgun'],select='rifle')=>{
      owned=weaponDefs.map(w=>ids.includes(w.id));weapons=weaponDefs.map(w=>({mag:w.capacity,reserve:w.reserve}));
      const i=weaponDefs.findIndex(w=>w.id===select),k=i>=0&&owned[i]?i:Math.max(0,owned.indexOf(true));
      weaponModels.forEach(g=>g.visible=false);weaponIndex=k;gun=weaponModels[k];gunMag=gun.userData.magazine;muzzleFlash=gun.userData.muzzleFlash;
      mag=weapons[k].mag;reserve=weapons[k].reserve;reloadT=0;fireT=.3;gunKick=0;flashT=0;semiFired=false;stowOwnedWeapons();
      return weaponDefs.filter((w,j)=>owned[j]).map(w=>w.id);},
    // Jumps straight onto floor `index` (a new layout, or `seed`'s), carrying the current kit.
    floor:(index,seed)=>{if(NET.inGame)return;scoreBase=runScore();enterFloor(index,currentKit(),seed);showScreen(null);return floor;},
    freezeAI:value=>{aiFrozen=!!value;},
    // Feed the auto-quality governor `count` frames of `ms` each, starting a fresh window with no settle time.
    autoQualityFrames:(ms,count)=>{const n=finiteNumber(count,0,0,2000),dt=finiteNumber(ms,16,1,1000)/1000;autoMs=autoFrames=autoSettle=0;for(let i=0;i<n;i++)autoQuality(dt);return {quality:qualityLevel,renderScale,wardDetail:wardDetail.value,autoBest};},
    health:value=>{P.health=finiteNumber(value,100,0,100);damageT=0;},torch:value=>{torchOn=value;},
    advance:seconds=>{if(NET.inGame)return;let remaining=finiteNumber(seconds,0,0,10);while(remaining>0&&state==='play'){const dt=Math.min(.05,remaining);remaining-=dt;t+=dt;elapsed+=dt;stepSurvival(dt);updateCameraRig(dt);updateGun(dt);monsters.forEach(m=>animateMonster(m,dt));updatePuffs(dt);}updateHUD();updateHealthVignette();},
    hit:(index,damage)=>hitMonster(monsters[index],damage),
    aim:(index,part)=>aimAtPart(monsters[index],part),
    // Kill sequences: slot `index` (placed at x, z when given) kills the survivor with `kind`'s track (its own by
    // default). hold freezes the kill clock for advanceCaught, which steps it exactly.
    kill:(index,o={})=>{const m=monsters[index];if(state!=='play'||!m)return state;if(Number.isFinite(o.x))window.HollowTest.enemy(index,{x:o.x,z:o.z,state:'chase',yaw:o.yaw||0});
      kill.hold=false;killKind=o.kind||null;P.health=0;damageT=0;grace=0;caught(m);killKind=null;kill.hold=!!o.hold;return state;},
    killHold:value=>{kill.hold=!!value;},killSkip,
    advanceCaught:seconds=>{let remaining=finiteNumber(seconds,0,0,10);while(remaining>0&&state==='caught'){const dt=Math.min(.05,remaining);remaining-=dt;t+=dt;updateCaught(dt,true);if(caughtBy)animateMonster(caughtBy,dt);}return killSnapshot();},
    action:inputAction,pause,quality:applyQuality,pickupReach,
    path:(index,x,z)=>{setPathTo(monsters[index],x,z);return monsters[index].path.map(cell=>cell.slice());},
    navClear:(ax,az,bx,bz,radius)=>movementClear(ax,az,bx,bz,radius),
    chaosAudio:event=>audioChaosEvent(event),
    // Always B1. The guns carried stay carried, reloaded to their starting rounds.
    build:seed=>{const kit=currentKit();kit.health=100;kit.decoys=3;kit.weapons=kit.weapons.map((w,i)=>owned[i]?{mag:weaponDefs[i].capacity,reserve:weaponDefs[i].reserve}:w);
      floor=0;buildMazeSeeded(seed);resetSurvivor(kit);P.pos.set(PED.x-.85,0,PED.z);P.vel.set(0,0,0);setHell();state='play';showScreen(null);spawnMonsters(FLOOR().active,FLOOR().sleepers);grace=10;
      checkpoint={floor:0,kit:copyKit(kit),elapsed,score:{...scoreBase}};},
    collide:(position,radius=PR)=>{const point={...position};resolve(point,radius);return point;},
    // The Gravekeeper on S2: 'wake' (the bell, and the survivor's grace ends; `value` true skips the toll and the rise), 'hit' (`value` damage),
    // 'pose' ({x, z}), 'phase' (into its second phase now). Returns its snapshot.
    boss:(action,value)=>{const b=boss;if(!b||!FLOOR().boss)return null;
      if(action==='wake'){grace=0;if(b.act==='grave'){exitPowered=true;exitRelease=FLOOR().release;bossAwaken();}if(value===true&&(b.act==='toll'||b.act==='rise')){if(b.act==='toll')bossRise(b);b.actT=0;updateBoss(b,.001);}}
      else if(action==='hit')hitMonster(b,finiteNumber(value,10,0,1000),null,false,1);
      else if(action==='pose'&&value){b.pos.set(value.x,0,value.z);b.g.position.copy(b.pos);}
      else if(action==='phase'&&!b.dead&&b.phase===1){b.hp=Math.min(b.hp,b.stats.hp*.5);bossHit(b,0,false);}
      return bossSnapshot();}
  });
}

// Build the hall, put the survivor at the pedestal and idle behind the title. The title screens hide the world, so the
// B1 ward is built after the menu is up (warmPlayPipelines), or by Play if the player is quicker.
buildStatic();
hall.traverse(o=>{if(o.isMesh){o.updateMatrix();o.matrixAutoUpdate=false;}});hall.updateMatrix();hall.matrixAutoUpdate=false;
floor=0;resetSurvivor(freshKit());setHell();P.pos.set(PED.x-.85,0,PED.z);P.yaw=Math.PI/2;P.pitch=0;
hideMonsters();state='menu';$('msg').style.opacity=0;msgTimer=0;
applyQuality(qualityLevel);if(autoStart)applyQuality(autoStart[0],autoStart[1]);
if(playerName){$('whoName').textContent=playerName;openMenu();}else openNameScreen();
initBoard();initNet();renderBoards();
loop();
// menu.js lights the title and replays a Play/Multiplay click made while the game was loading.
window.HollowReady=true;try{performance.mark('hollow:ready');}catch(e){}window.dispatchEvent(new Event('hollow:ready'));
} catch(error) {
  console.error('[The Hollow] Startup failed:',error);
  document.querySelectorAll('.screen').forEach(screen=>screen.hidden=true);
  const screen=document.createElement('section');screen.className='screen form';screen.setAttribute('role','alert');
  const panel=document.createElement('div');panel.className='panel';
  const title=document.createElement('h1');title.className='title';title.textContent='A little more light.';
  const message=document.createElement('p');message.className='lede';message.textContent='The 3D engine could not start. Enable hardware acceleration, close other busy tabs, or try a current browser.';
  const retry=document.createElement('button');retry.className='link';retry.textContent='Try loading again';retry.addEventListener('click',()=>location.reload());
  panel.append(title,message,retry);screen.append(panel);document.body.append(screen);
}
})();
