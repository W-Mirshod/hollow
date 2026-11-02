(function(){
'use strict';
try {
if(!window.THREE||!window.TSL||!window.HollowRenderer||!window.HollowSystems||!window.HollowVisuals||!window.HollowNavigation||!window.HollowHorror||!window.HollowAudio||!window.HollowChaos||!window.HollowHUDFX)throw new Error('A local game asset could not be loaded.');
const $=id=>document.getElementById(id);
const clamp01=v=>v<0?0:v>1?1:v;
const lerp=(a,b,k)=>a+(b-a)*k;
const ease=(a,b,t)=>{const k=clamp01((t-a)/(b-a));return k*k*(3-2*k);};
const rnd=(a,b)=>a+Math.random()*(b-a);

/* ---------- constants ---------- */
const RULES=window.HollowSystems;
const S=RULES.CELL, H=3.2, W=RULES.SIZE, N=(W-1)/2, HF=H+2.4;
const ENT_Z=2, DZ0=ENT_Z*S, DZ1=DZ0+S, DZC=DZ0+S/2;      // door spans z 6..9
const PED={x:16.5,z:DZC}, CHAN={x:10.5,z:DZC}, START={x:-34,z:DZC};
const WALK=2.8, RUN=5.6, CROUCH=1.4;
const EYE=1.6, PR=0.32, MR=0.38;
const IS_TOUCH=matchMedia('(pointer:coarse)').matches||navigator.maxTouchPoints>1;
let preferences={quality:'auto',sensitivity:1,volume:.7,motion:!matchMedia('(prefers-reduced-motion: reduce)').matches,effects:!matchMedia('(prefers-reduced-motion: reduce)').matches};
try{preferences=Object.assign(preferences,JSON.parse(localStorage.getItem('hollow.settings')||'{}'));}catch(e){}
const finiteNumber=(value,fallback,min=-1e6,max=1e6)=>{const n=Number(value);return Number.isFinite(n)?Math.max(min,Math.min(max,n)):fallback;};
preferences.quality=['auto','low','medium','high'].includes(preferences.quality)?preferences.quality:'auto';
preferences.sensitivity=finiteNumber(preferences.sensitivity,1,.4,2.5);preferences.volume=finiteNumber(preferences.volume,.7,0,1);preferences.motion=preferences.motion!==false;preferences.effects=preferences.effects!==false;
const qualityProfiles={low:{ratio:.8,shadows:false,shadowSize:512},medium:{ratio:1,shadows:true,shadowSize:512},high:{ratio:1.5,shadows:true,shadowSize:1024}};
let qualityLevel=preferences.quality==='auto'?(IS_TOUCH?'low':'high'):preferences.quality;
if(!qualityProfiles[qualityLevel])qualityLevel='medium';
let renderScale=qualityProfiles[qualityLevel].ratio,frameAverage=16.7,qualityTimer=0,renderCalls=0,renderedFrames=0,renderRequested=true,lastRenderedState='';

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
const {uniform,texture,property,positionWorld,positionLocal,vec2,vec3,vec4,float,mix,step,smoothstep,select,If,Fn,materialEmissive}=TSL;
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
const sunDir=new THREE.Vector3(-0.6,0.62,-0.5).normalize();
const sun=physical(new THREE.DirectionalLight(0xfff0d6,1.6),Math.PI);
sun.castShadow=true;sun.shadow.mapSize.set(1024,1024);
const sc=sun.shadow.camera;sc.left=-55;sc.right=55;sc.top=55;sc.bottom=-55;sc.near=1;sc.far=320;
sun.shadow.bias=-0.0004;sun.shadow.normalBias=0.03;
sun.target.position.set(-22,0,10);sun.position.copy(sun.target.position).addScaledVector(sunDir,140);
scene.add(sun);scene.add(sun.target);

// torch: a gentle decay keeps the old long, even beam (lit corridor ~10-20 m) instead of a blown-out hotspot
const spot=physical(new THREE.SpotLight(0xfff1d6,0,24,0.42,0.55),5,0.5);
spot.position.set(-0.22,-0.18,0.05);
spot.castShadow=true;spot.shadow.mapSize.set(qualityProfiles[qualityLevel].shadowSize,qualityProfiles[qualityLevel].shadowSize);
spot.shadow.camera.near=0.2;spot.shadow.camera.far=26;spot.shadow.bias=-0.0006;spot.shadow.radius=2;
camera.add(spot);
const spotTarget=new THREE.Object3D();spotTarget.position.set(0,-0.25,-6);camera.add(spotTarget);spot.target=spotTarget;
const bounce=physical(new THREE.PointLight(0xffe7c4,0,4.5),2,1);camera.add(bounce);
const muzzleLight=physical(new THREE.PointLight(0xffb060,0,12),5,1);muzzleLight.position.set(0.18,-0.1,-1.0);camera.add(muzzleLight);

/* ---------- environments ---------- */
const ENV={
  out:{sky:lin(0xbfe3ff),gnd:lin(0x5a7a3a),hi:0.75,fog:untone(0xcfe2ee),fd:0.0045,sun:1.6},
  lux:{sky:lin(0xffd2a0),gnd:lin(0x40180c),hi:0.6,fog:untone(0x1c0d07),fd:0.022,sun:0},
  hell:{sky:lin(0x889796),gnd:lin(0x24221f),hi:0.23,fog:untone(0x0b100f),fd:0.024,sun:0}
};
function applyEnv(a,b,k,flick){
  hemi.color.copy(a.sky).lerp(b.sky,k);hemi.groundColor.copy(a.gnd).lerp(b.gnd,k);
  setLight(hemi,lerp(a.hi,b.hi,k)*(flick==null?1:flick));
  scene.fog.color.copy(a.fog).lerp(b.fog,k);scene.fog.density=lerp(a.fd,b.fd,k);
  setLight(sun,lerp(a.sun,b.sun,k));
}

/* ---------- textures ---------- */
function noiseFill(ctx,w,h,amt){
  const img=ctx.getImageData(0,0,w,h),d=img.data;
  for(let i=0;i<d.length;i+=4){const n=(Math.random()-.5)*amt;d[i]+=n;d[i+1]+=n;d[i+2]+=n;}
  ctx.putImageData(img,0,0);
}
function cv(w,h){const c=document.createElement('canvas');c.width=w;c.height=h;return [c,c.getContext('2d')];}
function blot(x,cx,cy,r,col){const g=x.createRadialGradient(cx,cy,0,cx,cy,r);g.addColorStop(0,col);g.addColorStop(1,'rgba(0,0,0,0)');x.fillStyle=g;x.fillRect(cx-r,cy-r,r*2,r*2);}
function tex(c,rep,srgb){
  const t=new THREE.CanvasTexture(c);t.wrapS=t.wrapT=THREE.RepeatWrapping;
  if(rep)t.repeat.set(rep[0],rep[1]);
  if(srgb!==false)t.colorSpace=THREE.SRGBColorSpace;
  t.anisotropy=qualityLevel==='low'?1:Math.min(4,renderer.getMaxAnisotropy());
  return t;
}
// --- luxury ---
function luxWallC(){
  const [c,x]=cv(512,512);
  x.fillStyle='#5e0b12';x.fillRect(0,0,512,512);
  x.save();x.beginPath();x.rect(0,34,512,284);x.clip();
  for(let row=0,y=40;y<330;y+=52,row++)for(let cx=(row%2)*32;cx<540;cx+=64){
    x.save();x.translate(cx,y);const s=44;
    x.fillStyle='rgba(140,24,34,.6)';
    x.beginPath();x.ellipse(0,0,s*.2,s*.4,0,0,7);x.fill();
    x.beginPath();x.ellipse(-s*.3,s*.05,s*.11,s*.24,.6,0,7);x.fill();
    x.beginPath();x.ellipse(s*.3,s*.05,s*.11,s*.24,-.6,0,7);x.fill();
    x.strokeStyle='rgba(212,166,92,.4)';x.lineWidth=1.4;
    x.beginPath();x.moveTo(0,-s*.5);x.bezierCurveTo(s*.38,-s*.3,s*.38,s*.3,0,s*.5);x.bezierCurveTo(-s*.38,s*.3,-s*.38,-s*.3,0,-s*.5);x.stroke();
    x.fillStyle='rgba(222,176,100,.55)';x.beginPath();x.arc(0,0,s*.06,0,7);x.fill();
    x.restore();
  }
  x.restore();
  let g=x.createLinearGradient(0,0,0,34);g.addColorStop(0,'#f1e2b8');g.addColorStop(.6,'#c99a48');g.addColorStop(1,'#6a4617');x.fillStyle=g;x.fillRect(0,0,512,34);
  g=x.createLinearGradient(0,318,0,338);g.addColorStop(0,'#e8c97a');g.addColorStop(.5,'#a87a2e');g.addColorStop(1,'#5c3c12');x.fillStyle=g;x.fillRect(0,318,512,20);
  x.fillStyle='#3a1a10';x.fillRect(0,338,512,174);
  for(const px of [22,268]){x.fillStyle='#4a2414';x.fillRect(px,354,222,132);x.strokeStyle='#26100a';x.lineWidth=4;x.strokeRect(px+6,360,210,120);
    x.strokeStyle='rgba(212,166,92,.55)';x.lineWidth=1.5;x.strokeRect(px+14,368,194,104);}
  x.fillStyle='#1e0d07';x.fillRect(0,496,512,16);
  g=x.createLinearGradient(0,0,0,512);g.addColorStop(0,'rgba(255,220,160,.08)');g.addColorStop(1,'rgba(0,0,0,.15)');x.fillStyle=g;x.fillRect(0,0,512,512);
  noiseFill(x,512,512,10);return c;
}
function luxFloorC(){
  const [c,x]=cv(256,256);x.fillStyle='#6d0a10';x.fillRect(0,0,256,256);
  x.strokeStyle='rgba(205,150,70,.28)';x.lineWidth=2;
  for(let i=-256;i<=512;i+=64){x.beginPath();x.moveTo(i,0);x.lineTo(i+256,256);x.stroke();x.beginPath();x.moveTo(i,256);x.lineTo(i+256,0);x.stroke();}
  for(let a=0;a<=256;a+=64)for(let b=0;b<=256;b+=64){x.fillStyle='rgba(222,176,100,.5)';x.beginPath();x.moveTo(a,b-5);x.lineTo(a+5,b);x.lineTo(a,b+5);x.lineTo(a-5,b);x.fill();
    blot(x,a+32,b+32,14,'rgba(150,20,28,.6)');}
  noiseFill(x,256,256,16);return c;
}
function luxCeilC(){
  const [c,x]=cv(256,256);x.fillStyle='#cdb98f';x.fillRect(0,0,256,256);
  for(let a=0;a<256;a+=128)for(let b=0;b<256;b+=128){x.fillStyle='#b29e74';x.fillRect(a+8,b+8,112,112);x.fillStyle='#c7b287';x.fillRect(a+18,b+18,92,92);
    x.strokeStyle='rgba(176,130,50,.7)';x.lineWidth=2;x.strokeRect(a+18,b+18,92,92);blot(x,a+64,b+64,18,'rgba(190,140,60,.6)');}
  noiseFill(x,256,256,10);return c;
}
function runnerC(){
  const [c,x]=cv(256,128);x.fillStyle='#8a0d14';x.fillRect(0,0,256,128);
  x.fillStyle='#c9a04e';x.fillRect(0,8,256,6);x.fillRect(0,114,256,6);x.fillStyle='#5a070c';x.fillRect(0,0,256,8);x.fillRect(0,120,256,8);
  for(let i=0;i<256;i+=32){x.fillStyle='rgba(222,176,100,.35)';x.beginPath();x.moveTo(i+16,40);x.lineTo(i+30,64);x.lineTo(i+16,88);x.lineTo(i+2,64);x.fill();}
  noiseFill(x,256,128,14);return c;
}
function luxDoorC(){
  const [c,x]=cv(256,512);x.fillStyle='#2b140b';x.fillRect(0,0,256,512);
  for(let k=0;k<40;k++){x.strokeStyle=`rgba(${60+rnd(0,30)},${28+rnd(0,15)},12,.25)`;x.lineWidth=rnd(1,3);const yy=rnd(0,512);x.beginPath();x.moveTo(0,yy);x.bezierCurveTo(80,yy+rnd(-10,10),170,yy+rnd(-10,10),256,yy+rnd(-6,6));x.stroke();}
  for(const [py,ph] of [[30,180],[240,240]]){x.strokeStyle='#160904';x.lineWidth=8;x.strokeRect(30,py,196,ph);x.strokeStyle='rgba(214,170,90,.7)';x.lineWidth=2;x.strokeRect(42,py+12,172,ph-24);}
  x.fillStyle='#d8b060';x.beginPath();x.arc(214,262,10,0,7);x.fill();x.fillRect(208,262,12,40);
  noiseFill(x,256,512,10);return c;
}
function marbleC(){
  const [c,x]=cv(256,256);x.fillStyle='#ece7de';x.fillRect(0,0,256,256);
  for(let k=0;k<14;k++){x.strokeStyle=`rgba(120,110,100,${rnd(.1,.35)})`;x.lineWidth=rnd(.6,2);let px=rnd(0,256),py=0;x.beginPath();x.moveTo(px,py);for(let s=0;s<16;s++){px+=rnd(-22,22);py+=16;x.lineTo(px,py);}x.stroke();}
  noiseFill(x,256,256,10);return c;
}
// --- otherworld ---
function hellWallC(){
  const [c,x]=cv(512,512);x.fillStyle='#929084';x.fillRect(0,0,512,512);
  // Faded two-tone hospital paint over plaster, not repeating metal panels.
  x.fillStyle='#536760';x.fillRect(0,240,512,272);x.fillStyle='#afb09b';x.fillRect(0,232,512,7);
  for(let i=0;i<65;i++)blot(x,rnd(0,512),rnd(0,512),rnd(12,110),i%3?'rgba(30,34,27,.13)':'rgba(140,119,73,.16)');
  for(let i=0;i<32;i++){const dx=rnd(0,512),len=rnd(35,260);const g=x.createLinearGradient(0,0,0,len);g.addColorStop(0,'rgba(35,39,28,.38)');g.addColorStop(1,'rgba(35,39,28,0)');x.fillStyle=g;x.fillRect(dx,0,rnd(2,10),len);}
  x.strokeStyle='rgba(35,34,28,.42)';x.lineWidth=.8;
  for(let i=0;i<8;i++){let px=rnd(0,512),py=rnd(0,512);x.beginPath();x.moveTo(px,py);for(let j=0;j<5;j++){px+=rnd(-11,11);py+=rnd(4,17);x.lineTo(px,py);}x.stroke();}
  for(let i=0;i<90;i++){x.fillStyle=i%2?'rgba(182,175,151,.28)':'rgba(34,43,37,.23)';x.fillRect(rnd(0,512),rnd(245,495),rnd(1,12),rnd(1,4));}
  const damp=x.createLinearGradient(0,430,0,512);damp.addColorStop(0,'rgba(12,19,15,0)');damp.addColorStop(1,'rgba(12,19,15,.62)');x.fillStyle=damp;x.fillRect(0,430,512,82);
  noiseFill(x,512,512,10);return c;
}
function hellFloorC(){
  const [c,x]=cv(512,512);x.fillStyle='#272d29';x.fillRect(0,0,512,512);
  for(let row=0;row<4;row++)for(let col=0;col<4;col++){
    const shade=Math.floor(rnd(-7,7));x.fillStyle=`rgb(${80+shade},${86+shade},${77+shade})`;x.fillRect(col*128+2,row*128+2,124,124);
    x.strokeStyle='rgba(175,179,151,.12)';x.strokeRect(col*128+3,row*128+3,122,122);
  }
  for(let i=0;i<48;i++)blot(x,rnd(0,512),rnd(0,512),rnd(10,70),'rgba(13,23,20,.22)');
  x.strokeStyle='rgba(21,29,25,.4)';x.lineWidth=3;for(let i=0;i<12;i++){const a=rnd(0,480),b=rnd(0,512);x.beginPath();x.moveTo(a,b);x.lineTo(a+rnd(15,90),b+rnd(-8,8));x.stroke();}
  noiseFill(x,512,512,12);return c;
}
function hellCeilC(){const [c,x]=cv(256,256);x.fillStyle='#22150f';x.fillRect(0,0,256,256);for(let i=0;i<24;i++)blot(x,rnd(0,256),rnd(0,256),rnd(10,70),'rgba(0,0,0,.55)');noiseFill(x,256,256,26);return c;}
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
function noiseC(){
  const n=256,[c,x]=cv(n,n),img=x.createImageData(n,n),acc=new Float32Array(n*n);
  for(const [cells,amp] of [[4,.5],[8,.25],[16,.14],[32,.08],[64,.04]]){
    const g=[];for(let i=0;i<cells*cells;i++)g.push(Math.random());
    const at=(i,j)=>g[((j%cells+cells)%cells)*cells+((i%cells+cells)%cells)];
    for(let y=0;y<n;y++)for(let xx=0;xx<n;xx++){const fx=xx/n*cells,fy=y/n*cells,ix=Math.floor(fx),iy=Math.floor(fy),tx=fx-ix,ty=fy-iy;
      const sx=tx*tx*(3-2*tx),sy=ty*ty*(3-2*ty);
      acc[y*n+xx]+=amp*lerp(lerp(at(ix,iy),at(ix+1,iy),sx),lerp(at(ix,iy+1),at(ix+1,iy+1),sx),sy);}
  }
  let mn=9,mx=-9;for(const v of acc){if(v<mn)mn=v;if(v>mx)mx=v;}
  for(let i=0;i<n*n;i++){const v=(acc[i]-mn)/(mx-mn)*255;img.data[i*4]=img.data[i*4+1]=img.data[i*4+2]=v;img.data[i*4+3]=255;}
  x.putImageData(img,0,0);return c;
}
// --- outdoors ---
function grassC(){
  const [c,x]=cv(256,256);x.fillStyle='#4a7f2c';x.fillRect(0,0,256,256);
  for(let i=0;i<30;i++)blot(x,rnd(0,256),rnd(0,256),rnd(20,70),Math.random()<.5?'rgba(90,140,50,.35)':'rgba(30,60,20,.3)');
  for(let i=0;i<2600;i++){const px=rnd(0,256),py=rnd(0,256),l=rnd(3,9);x.strokeStyle=`rgba(${rnd(50,120)|0},${rnd(110,170)|0},${rnd(30,60)|0},.7)`;x.lineWidth=1;x.beginPath();x.moveTo(px,py);x.lineTo(px+rnd(-2,2),py-l);x.stroke();}
  noiseFill(x,256,256,14);return c;
}
function pathC(){
  const [c,x]=cv(256,256);x.fillStyle='#8d8579';x.fillRect(0,0,256,256);
  for(let a=0;a<256;a+=64)for(let b=0;b<256;b+=42){const off=(b/42)%2?32:0;const v=rnd(-14,14);x.fillStyle=`rgb(${170+v},${160+v},${145+v})`;x.fillRect(((a+off)%256)+2,b+2,60,38);}
  noiseFill(x,256,256,18);return c;
}
function facadeC(){
  const [c,x]=cv(512,480);x.fillStyle='#d9ccb2';x.fillRect(0,0,512,480);
  x.strokeStyle='rgba(120,105,85,.45)';x.lineWidth=2;
  for(let y=0;y<480;y+=40){x.beginPath();x.moveTo(0,y);x.lineTo(512,y);x.stroke();const off=(y/40)%2?64:0;for(let xx=off;xx<512;xx+=128){x.beginPath();x.moveTo(xx,y);x.lineTo(xx,y+40);x.stroke();}}
  // arched window
  const wx=176,wy=100,ww=160,wh=270;
  x.fillStyle='#f4efe4';x.beginPath();x.moveTo(wx-14,wy+wh+10);x.lineTo(wx-14,wy+60);x.arc(wx+ww/2,wy+60,ww/2+14,Math.PI,0);x.lineTo(wx+ww+14,wy+wh+10);x.fill();
  const g=x.createLinearGradient(0,wy,0,wy+wh);g.addColorStop(0,'#2d3a4a');g.addColorStop(.5,'#5b6d7e');g.addColorStop(1,'#25303c');
  x.fillStyle=g;x.beginPath();x.moveTo(wx,wy+wh);x.lineTo(wx,wy+60);x.arc(wx+ww/2,wy+60,ww/2,Math.PI,0);x.lineTo(wx+ww,wy+wh);x.fill();
  x.fillStyle='rgba(255,255,255,.18)';x.beginPath();x.moveTo(wx+20,wy+wh);x.lineTo(wx+70,wy+30);x.lineTo(wx+90,wy+30);x.lineTo(wx+40,wy+wh);x.fill();
  x.strokeStyle='#f4efe4';x.lineWidth=5;x.beginPath();x.moveTo(wx+ww/2,wy);x.lineTo(wx+ww/2,wy+wh);x.moveTo(wx,wy+150);x.lineTo(wx+ww,wy+150);x.stroke();
  x.fillStyle='#efe8da';x.fillRect(wx-24,wy+wh+8,ww+48,14);
  x.fillStyle='#efe8da';x.fillRect(0,0,512,22);
  const gb=x.createLinearGradient(0,400,0,480);gb.addColorStop(0,'rgba(0,0,0,0)');gb.addColorStop(1,'rgba(70,80,50,.45)');x.fillStyle=gb;x.fillRect(0,400,512,80);
  noiseFill(x,512,480,12);return c;
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
function plaqueC(hell){
  const [c,x]=cv(256,112);
  if(!hell){const g=x.createLinearGradient(0,0,256,112);g.addColorStop(0,'#d9b45c');g.addColorStop(.5,'#9c7430');g.addColorStop(1,'#d2aa52');x.fillStyle=g;x.fillRect(0,0,256,112);
    x.strokeStyle='#5c3f12';x.lineWidth=4;x.strokeRect(6,6,244,100);x.fillStyle='#3a240a';x.textAlign='center';x.font='bold 38px "IBM Plex Mono",monospace';x.fillText('KEEP AWAY',128,58);
    x.font='15px "Special Elite",monospace';x.fillText('do not touch the button',128,88);}
  else{x.fillStyle='#2a1810';x.fillRect(0,0,256,112);noiseFill(x,256,112,40);x.fillStyle='#8a0a0a';x.textAlign='center';x.font='32px "Special Elite",monospace';x.fillText('YOU WERE',128,48);x.fillText('WARNED',128,86);}
  return c;
}
function paintingC(hell){
  const [c,x]=cv(256,192);
  let g=x.createLinearGradient(0,0,0,192);
  if(!hell){g.addColorStop(0,'#3d4f73');g.addColorStop(.55,'#d48a4e');g.addColorStop(1,'#5a3a22');}else{g.addColorStop(0,'#0c0202');g.addColorStop(.55,'#5a0808');g.addColorStop(1,'#120404');}
  x.fillStyle=g;x.fillRect(0,0,256,192);
  x.fillStyle=hell?'#070202':'#2c3a1f';x.beginPath();x.moveTo(0,150);for(let i=0;i<=256;i+=16)x.lineTo(i,130+Math.sin(i*.05)*14);x.lineTo(256,192);x.lineTo(0,192);x.fill();
  if(!hell){x.fillStyle='rgba(255,220,150,.8)';x.beginPath();x.arc(180,95,14,0,7);x.fill();}
  else{x.fillStyle='#000';x.beginPath();x.ellipse(128,92,10,14,0,0,7);x.fill();x.fillRect(122,104,12,44);x.fillRect(112,108,4,46);x.fillRect(140,108,4,46);
    x.strokeStyle='rgba(200,180,160,.4)';for(let k=0;k<6;k++){x.beginPath();x.moveTo(rnd(0,256),rnd(0,192));x.lineTo(rnd(0,256),rnd(0,192));x.stroke();}}
  noiseFill(x,256,192,20);return c;
}

/* ---------- transformation material (peels like a burning page) ---------- */
// TSL uniforms keep the old `U.progress.value=` API. The colour graph writes the burning rim into burnEdge,
// which the emissive graph of the same fragment reads; the end states sample a single albedo.
const U={progress:uniform(0),ember:uniform(0)};
const noiseTex=tex(noiseC(),null,false);
const burnEdge=property('float','burnEdge');
function morphMat(luxC,hellC,rep,opts){
  const a=tex(luxC,rep),b=tex(hellC,rep);
  const m=new THREE.MeshStandardNodeMaterial(Object.assign({map:a,roughness:0.8,metalness:0},opts||{}));
  m.userData.transitionMap=b;
  m.colorNode=Fn(()=>{
    const color=vec4(0).toVar();burnEdge.assign(0);
    If(U.progress.greaterThan(.999),()=>{color.assign(texture(b));}).ElseIf(U.progress.lessThan(.001),()=>{color.assign(texture(a));}).Else(()=>{
      const p=positionWorld,nuv=vec2(p.x.add(p.z.mul(.71)),p.y.mul(1.3).add(p.z.mul(.37))).mul(.11);
      const n=texture(noiseTex,nuv).r.mul(.7).add(texture(noiseTex,nuv.mul(3.1)).r.mul(.3));
      const front=U.progress.mul(1.2).sub(.05),keep=step(front,n);
      burnEdge.assign(smoothstep(0,.06,n.sub(front)).oneMinus().mul(keep).mul(U.progress.mul(25).clamp(0,1)));
      const c=mix(texture(b),texture(a),keep);
      color.assign(vec4(mix(c.rgb,vec3(.02,.01,.008),burnEdge.mul(.9)),c.a));
    });
    return color;
  })();
  m.emissiveNode=materialEmissive.add(vec3(1,.32,.06).mul(burnEdge.pow(3)).mul(U.ember));
  return m;
}
const wallMat=morphMat(luxWallC(),hellWallC(),null,{roughness:0.85});
const floorMat=morphMat(luxFloorC(),hellFloorC(),[W,W],{roughness:0.9});
const ceilMat=morphMat(luxCeilC(),hellCeilC(),[W/1.5,W/1.5],{roughness:0.95});
const runnerMat=morphMat(runnerC(),hellRunnerC(),[7,1],{roughness:0.95});
const doorMat=morphMat(luxDoorC(),hellDoorC(),null,{roughness:0.45,metalness:0.1});
const pedMat=morphMat(marbleC(),hellCeilC(),null,{roughness:0.3});
if(window.HollowVisuals){
  HollowVisuals.enhanceMaterial(THREE,wallMat,{kind:'wall'});
  HollowVisuals.enhanceMaterial(THREE,floorMat,{kind:'floor'});
  HollowVisuals.enhanceMaterial(THREE,doorMat,{kind:'metal'});
  scene.environment=HollowVisuals.createEnvironment(THREE,renderer);
}

/* ---------- maze ---------- */
let grid=[],specialRooms=[],roomDoors=[],roomProps=[],roomLoot=[],fuses=0,decoys=3,decoyEvents=[],exitPowered=false,mazeNavigator=null;
let interaction=null,interactionT=0,hideTime=0,hitMarkerT=0,damageT=0,noticeT=0,worldSeed=0;
let horror=HollowHorror.create(0),caseNotes=[],readNotes=new Set(),captionText='',captionT=0,exitRelease=0,exitOpen=false,alarmT=0,simulationTime=0;
const dynamicWorld=new THREE.Group();scene.add(dynamicWorld);
dynamicWorld.matrixAutoUpdate=false;
const roomLights=[];
function genMaze(){
  const layout=RULES.generateMaze(Math.random);specialRooms=layout.rooms;return layout.grid;
}
function cellWall(cx,cz){if(cx<0||cz<0||cx>=W||cz>=W)return false;return grid[cz][cx]===1;}
function wallAt(x,z){return cellWall(Math.floor(x/S),Math.floor(z/S));}
function openCell(cx,cz){return cx>=0&&cz>=0&&cx<W&&cz<W&&grid[cz][cx]===0&&!(cx===0&&cz===ENT_Z);}
function doorAtCell(cx,cz){return roomDoors.find(d=>d.room.door.x===cx&&d.room.door.z===cz&&!d.open);}
function center(cx,cz){return [cx*S+S/2,cz*S+S/2];}
const obstacles=[];   // {x,z,r}
const treeObs=[];
function resolve(p,r){
  const circ=o=>{const dx=p.x-o.x,dz=p.z-o.z,d=Math.hypot(dx,dz),limit=o.r+r;if(d<limit&&d>1e-6){p.x=o.x+dx/d*limit;p.z=o.z+dz/d*limit;}};
  // Recheck world solids after furniture/door corrections. Living actors are
  // handled as movement constraints, never as forces on the player's position.
  for(let it=0;it<3;it++){
    for(const o of obstacles)circ(o);
    for(const o of roomProps)if((p.y||0)<o.h-.05)RULES.circleBox(p,r,o);
    for(const d of roomDoors)if(!d.open)RULES.circleBox(p,r,d.box);
    if(p.x<0)for(const o of treeObs)circ(o);
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
  const blocked=()=>state==='play'&&monsters.some(m=>!m.dead&&P.pos.y<m.stats.height&&
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
function blocksRay(x,y,z){
  if(y<0||y>H||wallAt(x,z))return true;
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

/* ---------- static world: outdoors + manor shell + hall props ---------- */
const skyU={top:uniform(untone(0x3f7fd6)),hor:uniform(untone(0xd6e8f2)),bot:uniform(untone(0x9fb39a))};
const skyMat=new THREE.MeshBasicNodeMaterial({side:THREE.BackSide,depthWrite:false,fog:false});
{const h=positionLocal.normalize().y;skyMat.colorNode=select(h.greaterThan(0),mix(skyU.hor,skyU.top,h.max(0).pow(.55)),mix(skyU.hor,skyU.bot,h.negate().mul(5).clamp(0,1)));}
const sky=new THREE.Mesh(new THREE.SphereGeometry(500,32,16),skyMat);
sky.renderOrder=-10;scene.add(sky);
function glowTex(inner,outer){const [c,x]=cv(128,128);const g=x.createRadialGradient(64,64,0,64,64,64);g.addColorStop(0,inner);g.addColorStop(.18,inner);g.addColorStop(.35,outer);g.addColorStop(1,'rgba(0,0,0,0)');x.fillStyle=g;x.fillRect(0,0,128,128);return new THREE.CanvasTexture(c);}
const sunSprite=new THREE.Sprite(new THREE.SpriteMaterial({map:glowTex('rgba(255,255,245,1)','rgba(255,230,170,.35)'),fog:false,depthWrite:false,blending:THREE.AdditiveBlending}));
sunSprite.scale.set(90,90,1);scene.add(sunSprite);
const clouds=[];
{const [c,x]=cv(256,128);for(let i=0;i<14;i++)blot(x,rnd(50,206),rnd(45,85),rnd(22,45),'rgba(255,255,255,.55)');const ct=new THREE.CanvasTexture(c);
 for(let i=0;i<9;i++){const s=new THREE.Sprite(new THREE.SpriteMaterial({map:ct,fog:false,depthWrite:false,transparent:true,opacity:.9}));
  const a=rnd(0,Math.PI*2),el=rnd(.18,.45);s.userData.dir=new THREE.Vector3(Math.cos(a)*Math.cos(el),Math.sin(el),Math.sin(a)*Math.cos(el));s.scale.set(rnd(90,150),rnd(40,60),1);scene.add(s);clouds.push(s);}}

const exterior=new THREE.Group();scene.add(exterior);
function buildExterior(){
  const grass=new THREE.Mesh(new THREE.PlaneGeometry(700,700),new THREE.MeshStandardMaterial({map:tex(grassC(),[175,175]),roughness:1}));
  grass.rotation.x=-Math.PI/2;grass.position.set(-10,-0.02,35);grass.receiveShadow=true;exterior.add(grass);
  const path=new THREE.Mesh(new THREE.PlaneGeometry(36,2.6),new THREE.MeshStandardMaterial({map:tex(pathC(),[14,1]),roughness:0.95}));
  path.rotation.x=-Math.PI/2;path.position.set(-18.2,0.01,DZC);path.receiveShadow=true;exterior.add(path);
  // facade
  const fc=facadeC();
  const fbox=(x0,x1,z0,z1,y0,y1)=>{const lx=x1-x0,lz=z1-z0,len=Math.max(lx,lz);
    const t=tex(fc,[len/6,(y1-y0)/HF]);const m=new THREE.Mesh(new THREE.BoxGeometry(lx,y1-y0,lz),new THREE.MeshStandardMaterial({map:t,roughness:0.9}));
    m.position.set((x0+x1)/2,(y0+y1)/2,(z0+z1)/2);m.castShadow=true;m.receiveShadow=true;exterior.add(m);};
  const L=W*S,T=0.12;
  fbox(-T,0.01,-T,DZ0,0,HF);fbox(-T,0.01,DZ1,L+T,0,HF);fbox(-T,0.01,DZ0,DZ1,3.0,HF);
  fbox(L-0.01,L+T,-T,(W-2)*S,0,HF);fbox(L-0.01,L+T,(W-1)*S,L+T,0,HF);fbox(L-0.01,L+T,(W-2)*S,(W-1)*S,H,HF);
  fbox(-T,L+T,-T,0.01,0,HF);fbox(-T,L+T,L-0.01,L+T,0,HF);
  const white=new THREE.MeshStandardMaterial({color:lin(0xf2ede2),roughness:0.6});
  const corn=(x0,x1,z0,z1)=>{const m=new THREE.Mesh(new THREE.BoxGeometry(x1-x0,0.35,z1-z0),white);m.position.set((x0+x1)/2,HF+0.12,(z0+z1)/2);m.castShadow=true;exterior.add(m);};
  corn(-0.45,L+0.45,-0.45,0.2);corn(-0.45,L+0.45,L-0.2,L+0.45);corn(-0.45,0.2,-0.45,L+0.45);corn(L-0.2,L+0.45,-0.45,L+0.45);
  const roof=new THREE.Mesh(new THREE.BoxGeometry(L,0.2,L),new THREE.MeshStandardMaterial({color:lin(0x3b3d44),roughness:0.9}));roof.position.set(L/2,H+0.11,L/2);roof.castShadow=true;exterior.add(roof);
  // portico
  for(const z of [DZ0-0.8,DZ1+0.8]){const col=new THREE.Mesh(new THREE.CylinderGeometry(0.24,0.28,3.7,20),white);col.position.set(-2,1.85,z);col.castShadow=true;col.receiveShadow=true;exterior.add(col);
    const base=new THREE.Mesh(new THREE.BoxGeometry(0.7,0.25,0.7),white);base.position.set(-2,0.12,z);exterior.add(base);obstacles.push({x:-2,z,r:0.35});}
  const lintel=new THREE.Mesh(new THREE.BoxGeometry(2.6,0.45,(DZ1-DZ0)+2.8),white);lintel.position.set(-1.2,3.92,DZC);lintel.castShadow=true;exterior.add(lintel);
  const shape=new THREE.Shape();const hw=(DZ1-DZ0)/2+1.4;shape.moveTo(-hw,0);shape.lineTo(hw,0);shape.lineTo(0,1.1);shape.lineTo(-hw,0);
  const ped=new THREE.Mesh(new THREE.ExtrudeGeometry(shape,{depth:2.6,bevelEnabled:false}),white);ped.rotation.y=Math.PI/2;ped.position.set(-2.5,4.14,DZC);ped.castShadow=true;exterior.add(ped);
  const step=new THREE.Mesh(new THREE.BoxGeometry(2.4,0.06,4.6),white);step.position.set(-1.25,0.03,DZC);step.receiveShadow=true;exterior.add(step);
  // trees
  const trees=[];let guard=0;
  while(trees.length<110&&guard++<4000){
    const x=rnd(-140,W*S+60),z=rnd(-80,W*S+80);
    if(x>-9&&x<W*S+9&&z>-9&&z<W*S+9)continue;
    if(x<0&&Math.abs(z-DZC)<7&&x>-48)continue;
    if(Math.hypot(x-START.x,z-START.z)<10)continue;
    trees.push([x,z,rnd(0.8,1.4)]);
  }
  const trunk=new THREE.InstancedMesh(new THREE.CylinderGeometry(0.18,0.3,3,7),new THREE.MeshStandardMaterial({color:lin(0x4a3324),roughness:1}),trees.length);
  const leafGeo=new THREE.IcosahedronGeometry(1.7,1);
  const leaves=new THREE.InstancedMesh(leafGeo,new THREE.MeshStandardMaterial({roughness:0.95,flatShading:true}),trees.length*3);
  const m=new THREE.Matrix4(),q=new THREE.Quaternion(),sv=new THREE.Vector3(),pv=new THREE.Vector3(),col=new THREE.Color();
  trees.forEach(([x,z,s],i)=>{
    m.compose(pv.set(x,1.5*s,z),q.identity(),sv.set(s,s,s));trunk.setMatrixAt(i,m);
    for(let k=0;k<3;k++){const ls=s*rnd(.8,1.25)*(1-k*.18);q.setFromAxisAngle(new THREE.Vector3(0,1,0),rnd(0,6));
      m.compose(pv.set(x+rnd(-.6,.6)*s,(3+k*1.2)*s,z+rnd(-.6,.6)*s),q,sv.set(ls,ls*rnd(.8,1),ls));leaves.setMatrixAt(i*3+k,m);
      leaves.setColorAt(i*3+k,col.setHSL(rnd(.22,.32),rnd(.45,.65),rnd(.22,.34)));}
    if(x<0)treeObs.push({x,z,r:0.35*s});
  });
  trunk.castShadow=leaves.castShadow=true;trunk.receiveShadow=leaves.receiveShadow=true;exterior.add(trunk,leaves);
  // hedges along the facade
  const hed=[];for(let z=1;z<W*S;z+=1.3){if(z>DZ0-3&&z<DZ1+3)continue;hed.push([-1.0,z]);}
  for(let x=1;x<W*S;x+=1.3){hed.push([x,-1.0]);hed.push([x,W*S+1.0]);}
  const hedge=new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.75,1),new THREE.MeshStandardMaterial({color:lin(0x2f5a22),roughness:1,flatShading:true}),hed.length);
  hed.forEach(([x,z],i)=>{m.compose(pv.set(x,0.55,z),q.identity(),sv.set(rnd(.9,1.2),rnd(.8,1),rnd(.9,1.2)));hedge.setMatrixAt(i,m);});
  hedge.castShadow=hedge.receiveShadow=true;exterior.add(hedge);
  // grass tufts and flowers
  const nT=2200,tuft=new THREE.InstancedMesh(new THREE.ConeGeometry(0.05,0.42,3),new THREE.MeshStandardMaterial({roughness:1}),nT);
  for(let i=0;i<nT;i++){let x,z;do{x=rnd(-70,-0.5);z=rnd(-35,50);}while(Math.abs(z-DZC)<1.6&&x>-37);
    q.setFromEuler(new THREE.Euler(rnd(-.25,.25),0,rnd(-.25,.25)));const s=rnd(.6,1.4);m.compose(pv.set(x,0.18*s,z),q,sv.set(s,s,s));tuft.setMatrixAt(i,m);tuft.setColorAt(i,col.setHSL(rnd(.2,.3),rnd(.5,.7),rnd(.22,.38)));}
  exterior.add(tuft);
  const nF=900,flower=new THREE.InstancedMesh(new THREE.SphereGeometry(0.07,6,4),new THREE.MeshStandardMaterial({roughness:0.7}),nF);
  const fcols=[0xffffff,0xffe14a,0xff6fa5,0xb685ff,0xff8a3d];
  for(let i=0;i<nF;i++){let x,z;do{x=rnd(-60,-0.8);z=rnd(-30,45);}while(Math.abs(z-DZC)<1.5&&x>-37);
    m.compose(pv.set(x,rnd(.2,.32),z),q.identity(),sv.set(1,.7,1));flower.setMatrixAt(i,m);flower.setColorAt(i,col.set(fcols[i%fcols.length]));}
  exterior.add(flower);
}

const maze=new THREE.Group();scene.add(maze);
const hall=new THREE.Group();scene.add(hall);
let doorL,doorR,chandelier,chanLight,pedLight,button,plaque,plaqueLux,plaqueHell,paintings=[],bulbMat,sconceBulbMat,writingMats=[];
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
  button=new THREE.Mesh(new THREE.SphereGeometry(0.075,20,10,0,Math.PI*2,0,Math.PI/2),new THREE.MeshStandardMaterial({color:lin(0x8a0b0b),emissive:lin(0x550000),roughness:0.25}));
  button.position.set(PED.x,1.05,PED.z);hall.add(button);
  plaqueLux=new THREE.CanvasTexture(plaqueC(false));plaqueLux.colorSpace=THREE.SRGBColorSpace;plaqueHell=new THREE.CanvasTexture(plaqueC(true));plaqueHell.colorSpace=THREE.SRGBColorSpace;
  plaque=new THREE.Mesh(new THREE.PlaneGeometry(0.5,0.22),new THREE.MeshStandardMaterial({map:plaqueLux,metalness:0.5,roughness:0.4}));
  plaque.position.set(PED.x-0.345,0.8,PED.z);plaque.rotation.set(0,-Math.PI/2,0);plaque.rotateX(-0.12);hall.add(plaque);
  obstacles.push({x:PED.x,z:PED.z,r:0.42});
  pedLight=physical(new THREE.PointLight(0xffd7a0,1.1,9),4,1);pedLight.position.set(PED.x-1,2.7,PED.z);hall.add(pedLight);
  // chandelier
  chandelier=new THREE.Group();chandelier.position.set(CHAN.x,H,CHAN.z);hall.add(chandelier);
  const chain=new THREE.Mesh(new THREE.CylinderGeometry(0.015,0.015,0.55,6),gold);chain.position.y=-0.27;chain.name='chain';chandelier.add(chain);
  const ring=new THREE.Mesh(new THREE.TorusGeometry(0.55,0.03,8,32),gold);ring.rotation.x=Math.PI/2;ring.position.y=-0.78;chandelier.add(ring);
  const hub=new THREE.Mesh(new THREE.SphereGeometry(0.12,12,10),gold);hub.position.y=-0.7;chandelier.add(hub);
  bulbMat=new THREE.MeshBasicMaterial({color:lin(0xffe2a6)});
  const crystal=new THREE.MeshStandardMaterial({color:lin(0xffffff),metalness:0.1,roughness:0.05,emissive:lin(0x332211)});
  for(let k=0;k<10;k++){const a=k/10*Math.PI*2,cx=Math.cos(a)*0.55,cz=Math.sin(a)*0.55;
    const cand=new THREE.Mesh(new THREE.CylinderGeometry(0.018,0.018,0.12,6),new THREE.MeshStandardMaterial({color:lin(0xf6f0e0)}));cand.position.set(cx,-0.71,cz);chandelier.add(cand);
    const b=new THREE.Mesh(new THREE.SphereGeometry(0.03,8,6),bulbMat);b.scale.y=1.5;b.position.set(cx,-0.62,cz);chandelier.add(b);
    const cr=new THREE.Mesh(new THREE.OctahedronGeometry(0.04),crystal);cr.scale.y=2;cr.position.set(Math.cos(a+.3)*0.45,-0.95,Math.sin(a+.3)*0.45);chandelier.add(cr);}
  chandelier.traverse(o=>{if(o.isMesh)o.castShadow=true;});
  chanLight=physical(new THREE.PointLight(0xffc98a,2.2,18),7.5,1);chanLight.position.y=-0.85;chandelier.add(chanLight);
  // paintings on the hall's north wall
  for(const px of [6,10.5,15]){
    const frame=new THREE.Mesh(new THREE.BoxGeometry(1.5,1.12,0.06),gold);frame.position.set(px,1.9,3.03);hall.add(frame);
    const lt=new THREE.CanvasTexture(paintingC(false)),ht=new THREE.CanvasTexture(paintingC(true));lt.colorSpace=ht.colorSpace=THREE.SRGBColorSpace;
    const pm=new THREE.Mesh(new THREE.PlaneGeometry(1.32,0.96),new THREE.MeshStandardMaterial({map:lt,roughness:0.8}));pm.position.set(px,1.9,3.065);hall.add(pm);
    pm.userData={lt,ht};paintings.push(pm);
  }
  // exit sign + lights
  const ex=(W-1)*S,ez=(W-2)*S+S/2;
  const [scv,sx]=cv(256,96);sx.fillStyle='#120202';sx.fillRect(0,0,256,96);sx.fillStyle='#ff2a1c';sx.font='bold 64px "IBM Plex Mono",monospace';sx.textAlign='center';sx.textBaseline='middle';sx.fillText('EXIT',128,50);
  const stex=new THREE.CanvasTexture(scv);stex.colorSpace=THREE.SRGBColorSpace;
  const sign=new THREE.Mesh(new THREE.PlaneGeometry(0.9,0.34),new THREE.MeshBasicMaterial({map:stex}));sign.rotation.y=-Math.PI/2;sign.position.set(ex+0.02,H-0.35,ez);hall.add(sign);
  const red=physical(new THREE.PointLight(0xff2010,1.3,9),4,1);red.position.set(ex-0.5,H-0.5,ez);hall.add(red);
  sconceBulbMat=new THREE.MeshBasicMaterial({color:lin(0xffcf85)});
}
const boxGeo=new THREE.BoxGeometry(0.56,0.3,0.32),lidGeo=new THREE.PlaneGeometry(0.4,0.14);
const boxMat=new THREE.MeshStandardMaterial({color:lin(0x4b5230),roughness:0.75,metalness:0.2});
const boxLabelMat=(()=>{const [c,x]=cv(256,96);x.fillStyle='#4b5230';x.fillRect(0,0,256,96);x.fillStyle='#d8c35a';x.font='bold 40px "IBM Plex Mono",monospace';x.textAlign='center';x.textBaseline='middle';x.fillText('7.62x39',128,38);x.font='22px "IBM Plex Mono",monospace';x.fillText('30 RDS',128,76);const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;return new THREE.MeshStandardMaterial({map:t,roughness:0.8,emissive:lin(0x111108)});})();
const MESSAGES=['IT HEARS YOU RUN','LOCK THE DOOR','LIGHTS OFF','THE WARDEN DOES NOT HURRY','THREE FUSES. ONE EXIT.','CROUCH. BREATHE. WAIT.','A SHOT IS AN INVITATION','ISOLATION SAVES LIVES'];
function buildMaze(){
  maze.traverse(o=>{if(o.isInstancedMesh&&o.dispose)o.dispose();if(o.geometry&&o.geometry!==boxGeo&&o.geometry!==lidGeo)o.geometry.dispose();if(o.material&&o.userData.own){if(o.material.map)o.material.map.dispose();o.material.dispose();}});
  scene.remove(maze);maze.clear();scene.add(maze);writingMats=[];
  grid=genMaze();
  let count=0;for(let z=0;z<W;z++)for(let x=0;x<W;x++)if(grid[z][x]===1)count++;
  const walls=new THREE.InstancedMesh(new THREE.BoxGeometry(S,H,S),wallMat,count);
  const m=new THREE.Matrix4();let i=0;
  for(let z=0;z<W;z++)for(let x=0;x<W;x++)if(grid[z][x]===1){m.makeTranslation(x*S+S/2,H/2,z*S+S/2);walls.setMatrixAt(i++,m);}
  walls.instanceMatrix.needsUpdate=true;walls.castShadow=walls.receiveShadow=true;maze.add(walls);
  // wall sconces
  const spots=[];
  for(let z=0;z<W;z++)for(let x=0;x<W;x++){if(!openCell(x,z)||Math.random()<.45)continue;
    const sides=[];if(cellWall(x+1,z))sides.push(0);if(cellWall(x-1,z))sides.push(1);if(cellWall(x,z+1))sides.push(2);if(cellWall(x,z-1))sides.push(3);
    if(!sides.length)continue;const sd=sides[Math.floor(Math.random()*sides.length)],[wx,wz]=center(x,z);
    if(sd===0)spots.push([(x+1)*S-0.06,wz]);if(sd===1)spots.push([x*S+0.06,wz]);if(sd===2)spots.push([wx,(z+1)*S-0.06]);if(sd===3)spots.push([wx,z*S+0.06]);}
  const baseM=new THREE.InstancedMesh(new THREE.CylinderGeometry(0.05,0.07,0.22,8),new THREE.MeshStandardMaterial({color:lin(0xb8913f),metalness:0.8,roughness:0.35}),spots.length);
  const bulbM=new THREE.InstancedMesh(new THREE.SphereGeometry(0.055,8,6),sconceBulbMat,spots.length);
  spots.forEach(([x,z],k)=>{m.makeTranslation(x,2.15,z);baseM.setMatrixAt(k,m);m.makeTranslation(x,2.3,z);bulbM.setMatrixAt(k,m);});
  baseM.userData.own=true;baseM.name='manor-sconces';bulbM.name='manor-bulbs';maze.add(baseM,bulbM);
  // writings (appear after the change)
  const used=new Set();let placed=0,tries=0;
  while(placed<9&&tries<600){tries++;
    const cx=1+Math.floor(Math.random()*(W-2)),cz=1+Math.floor(Math.random()*(W-2));
    if(!openCell(cx,cz)||used.has(cz*W+cx))continue;
    const inHall=cx<=5&&cz<=3;if(inHall&&placed>0)continue;
    const sides=[];if(cellWall(cx+1,cz))sides.push('px');if(cellWall(cx-1,cz))sides.push('nx');if(cellWall(cx,cz+1))sides.push('pz');if(cellWall(cx,cz-1)&&!inHall)sides.push('nz');
    if(!sides.length)continue;used.add(cz*W+cx);
    const side=sides[Math.floor(Math.random()*sides.length)];
    const t=new THREE.CanvasTexture(writingC(placed===0?'YOU TOUCHED IT':MESSAGES[placed%MESSAGES.length]));t.colorSpace=THREE.SRGBColorSpace;
    const mat=new THREE.MeshStandardMaterial({map:t,transparent:true,opacity:0,depthWrite:false,roughness:0.6,polygonOffset:true,polygonOffsetFactor:-2});writingMats.push(mat);
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
  for(const c of shuf(ends).concat(shuf(any))){if(picks.every(o=>Math.abs(o[0]-c[0])+Math.abs(o[1]-c[1])>5))picks.push(c);if(picks.length===12)break;}
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
function isolationDoorMaterial(){
  const [surface,c]=cv(512,512);c.fillStyle='#496267';c.fillRect(0,0,512,512);
  for(let i=0;i<30;i++)blot(c,rnd(0,512),rnd(0,512),rnd(12,95),i%3?'rgba(10,18,18,.16)':'rgba(133,88,45,.2)');
  c.strokeStyle='#1a292d';c.lineWidth=5;c.strokeRect(18,18,476,476);c.lineWidth=2;c.strokeRect(32,32,448,448);
  c.fillStyle='#1a252b';c.fillRect(62,100,388,95);c.strokeStyle='#617277';c.lineWidth=3;
  for(let y=112;y<190;y+=15){c.beginPath();c.moveTo(75,y);c.lineTo(437,y);c.stroke();}
  for(const x of [27,485])for(const y of [28,120,390,484]){c.fillStyle='#9ca6a0';c.beginPath();c.arc(x,y,4,0,Math.PI*2);c.fill();c.strokeStyle='#283330';c.lineWidth=1;c.beginPath();c.moveTo(x-3,y+1);c.lineTo(x+3,y-1);c.stroke();}
  c.save();c.beginPath();c.rect(36,450,440,28);c.clip();c.fillStyle='#242a29';c.fillRect(36,450,440,28);c.fillStyle='#b1a05c';for(let x=0;x<560;x+=52){c.beginPath();c.moveTo(x,445);c.lineTo(x+25,445);c.lineTo(x-9,485);c.lineTo(x-34,485);c.fill();}c.restore();
  noiseFill(c,512,512,12);
  const material=new THREE.MeshStandardMaterial({map:tex(surface),metalness:.38,roughness:.64});
  return HollowVisuals.enhanceMaterial(THREE,material,{kind:'metal'});
}
function buildRooms(){
  const oldDecorations=[];dynamicWorld.traverse(o=>{if(o.userData.decoration)oldDecorations.push(o);});
  if(window.HollowVisuals)oldDecorations.forEach(o=>HollowVisuals.disposeGroup(o));
  dynamicWorld.traverse(o=>{if(o.userData.own){if(o.geometry)o.geometry.dispose();if(o.material){if(o.material.map)o.material.map.dispose();o.material.dispose();}}});
  dynamicWorld.clear();roomDoors=[];roomProps=[];roomLoot=[];roomLights.length=0;fuses=0;exitPowered=false;exitRelease=0;exitOpen=false;alarmT=0;decoys=3;decoyEvents=[];hideTime=0;
    horror=HollowHorror.create(worldSeed);caseNotes=[];readNotes=new Set();captionText='';captionT=0;simulationTime=0;
    const ward=HollowVisuals.decorateWard(THREE,{grid,cellSize:S,height:H,rooms:specialRooms,seed:worldSeed});
    dynamicWorld.add(ward);roomLights.push(...ward.userData.practicals);
    chaosWorldBuilt(ward);
  const own=o=>{o.userData.own=true;return o;};
  for(const r of specialRooms){
    const cx=(r.x+r.w/2)*S,cz=(r.z+r.d/2)*S;
    const group=new THREE.Group();group.position.set(cx,0,cz);dynamicWorld.add(group);r.group=group;
    if(window.HollowVisuals){
      const decoration=HollowVisuals.decorateRoom(THREE,{width:r.w*S,depth:r.d*S,type:r.type});decoration.userData.decoration=true;group.add(decoration);
      for(const p of decoration.userData.colliders||[])roomProps.push({...p,x:p.x+cx,z:p.z+cz,room:r.id});
      decoration.traverse(o=>{o.updateMatrix();o.matrixAutoUpdate=false;});
    }
    const sign=worldLabel(r.name.toUpperCase(),r.shelter?'#8cdcc8':r.fuse?'#e7b878':'#a5bdca',2.9);
    sign.position.set(cx,2.7,r.z*S+.025);dynamicWorld.add(sign);
    const strip=own(new THREE.Mesh(new THREE.BoxGeometry(2.4,.035,.12),new THREE.MeshBasicMaterial({color:lin(r.shelter?0x83d4c2:r.fuse?0xffc282:0xa6c4dd)})));
    strip.position.set(cx,H-.07,cz);group.add(strip);strip.position.x=0;strip.position.z=0;
    // Only the three nearest practical lights are active. Emissive fixtures stay visible.
    roomLights.push({x:cx,z:cz,color:r.shelter?0xbac3a7:r.fuse?0xcdb48b:0x9caeaa,shelter:!!r.shelter});
        const record=HollowHorror.RECORDS[r.id];
        if(record){
          const [paper,ink]=cv(512,512);ink.fillStyle='#b6ae95';ink.fillRect(0,0,512,512);
          ink.fillStyle='#393a31';ink.font='bold 24px monospace';ink.fillText('BLACKWATER / INTERNAL',28,52);
          ink.fillStyle='#723f30';ink.font='bold 18px monospace';ink.fillText(record.title,28,94,450);
          ink.fillStyle='#45443a';ink.font='19px monospace';let line='',y=150;
          for(const word of record.text.split(' ')){if(ink.measureText(line+word).width>445){ink.fillText(line,28,y);y+=29;line='';}line+=word+' ';}ink.fillText(line,28,y);
          ink.fillStyle='#6b6758';ink.fillRect(204,0,104,18);noiseFill(ink,512,512,9);
          const note=own(new THREE.Mesh(new THREE.PlaneGeometry(.62,.62),new THREE.MeshStandardMaterial({map:tex(paper),roughness:1})));
          note.position.set(cx,1.45,r.z*S+.055);dynamicWorld.add(note);
          caseNotes.push({id:r.id,x:cx,z:r.z*S+.055,...record});
        }
    if(r.shelter){
      const [dx,dz]=center(r.door.x,r.door.z),hinge=new THREE.Group();hinge.position.set(dx-S/2,0,dz);dynamicWorld.add(hinge);
      const panel=own(new THREE.Mesh(new THREE.BoxGeometry(S-.08,H-.15,.16),isolationDoorMaterial()));
      panel.position.set(S/2,(H-.15)/2,0);panel.castShadow=panel.receiveShadow=true;hinge.add(panel);
      const sign=worldLabel('ISOLATION / MANUAL LOCK','#94d4bd',2.4);sign.position.set(S/2,2,.095);hinge.add(sign);
      const insideSign=worldLabel('MANUAL OVERRIDE','#94d4bd',1.3);insideSign.position.set(S/2,1.45,-.095);insideSign.rotation.y=Math.PI;hinge.add(insideSign);
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
  const guide=worldLabel('BLACKWATER / ISOLATION ROOMS →','#b8bea3',3.3);guide.position.set(7.5,2.3,3.06);dynamicWorld.add(guide);
  const exitSign=worldLabel('POWER OFFLINE / 3 FUSES','#e7b878',2.3);exitSign.position.set((W-1)*S-.04,1.9,(W-2)*S+S/2);exitSign.rotation.y=-Math.PI/2;dynamicWorld.add(exitSign);
  const gate=own(new THREE.Mesh(new THREE.BoxGeometry(.14,H,S),isolationDoorMaterial()));
  gate.position.set((W-1)*S-.02,H/2,(W-2)*S+S/2);gate.castShadow=true;dynamicWorld.add(gate);dynamicWorld.userData.gate=gate;dynamicWorld.userData.exitSign=exitSign;
  mazeNavigator=HollowNavigation.create({grid,cellSize:S,props:roomProps,circles:obstacles,doors:()=>roomDoors.map(d=>({...d.box,open:d.open}))});
}
function makeLoot(type,x,z,room){
  const group=new THREE.Group();group.position.set(x,type==='fuse'?.3:.15,z);dynamicWorld.add(group);
  const color=type==='fuse'?0xe9bd79:type==='medical'?0x81cbb3:0x879dae;
  const box=new THREE.Mesh(new THREE.BoxGeometry(type==='fuse'?.24:.5,type==='fuse'?.55:.26,.26),new THREE.MeshStandardMaterial({color:lin(color),metalness:.45,roughness:.35,emissive:lin(color),emissiveIntensity:.15}));box.userData.own=true;group.add(box);
  const label=worldLabel(type==='fuse'?'POWER FUSE':type==='medical'?'FIELD DRESSING':'AMMO / WALK OVER','#b5dad0',.9);label.scale.y=.4;label.position.set(0,.6,0);group.add(label);group.userData.label=label;
  return {id:room.id+':'+type,type,x,z,g:group,taken:false,room};
}
// Linear decay follows r128's (1-d/13)^2 pools within ~15% from 2 to 10 m without blowing out the ceiling.
const practicalLights=Array.from({length:3},()=>{const l=physical(new THREE.PointLight(0xb4cadd,0,13),4.7,1);dynamicWorld.add(l);scene.add(l);return l;});
const exitTint=lin(0xd09b62);
function refreshRoomLights(){
  const viewer=state==='spect'||state==='pause'&&prevState==='spect'?R.pos:P.pos;
    const nearest=roomLights.map(l=>({...l,d:Math.hypot(l.x-viewer.x,l.z-viewer.z)})).sort((a,b)=>a.d-b.d);
  practicalLights.forEach((l,i)=>{l.visible=qualityLevel!=='low'||i===0;const info=nearest[i];if(!info||info.d>24||state==='outside'||state==='menu'){setLight(l,0);return;}l.color.setHex(info.color,THREE.LinearSRGBColorSpace);l.position.set(info.x,2.85,info.z);setLight(l,(info.shelter?1.45:1.75)*(info.shelter?1:horror.snapshot().lighting));
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
  if(NET.inGame&&NET.role==='guest'){if(queueAction({type:'loot',id:l.id}))l.pending=NET.actionSeq;}
  else collectLoot(l);
}
function collectLoot(l){
  if(l.taken)return;
  if(l.type==='fuse'&&(!NET.inGame||NET.role==='host'))alertMonsters(24,l.x,l.z);
  if(l.type==='medical'&&P.health>=100){showMsg('Health is full. Save this kit for later.',2);return;}
  l.taken=true;l.g.visible=false;sPickup();
  rewardLoot(l.type);
}
function rewardLoot(type){
  if(type==='fuse'){fuses=roomLoot.filter(v=>v.type==='fuse'&&v.taken).length;showMsg(fuses===3?'All fuses secured. Reach the exit to restore power.':`Power fuse recovered · ${fuses}/3.`,3.5);}
  else if(type==='medical'){P.health=Math.min(100,P.health+45);showMsg('Field dressing · +45 health.',2);}
  else if(type==='ammo'){weapons[0].reserve+=20;weapons[1].reserve+=6;weapons[2].reserve+=3;reserve=weapons[weaponIndex].reserve;showMsg('Ammunition · +20 carbine / +6 sidearm / +3 shells.',2.5);}
  else {weapons[0].reserve+=30;weapons[1].reserve+=12;weapons[2].reserve+=6;reserve=weapons[weaponIndex].reserve;decoys=Math.min(5,decoys+1);battery=1;showMsg('Supplies secured · ammunition, battery and a decoy.',3);}
  if(automaticLoot(type)&&mag===0&&reserve>0)startReload();
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
    }else if(fuses<3)showMsg(`Power is offline. Recover ${3-fuses} more ${fuses===2?'fuse':'fuses'} from marked rooms.`,3);
  else if(NET.inGame&&NET.role==='guest')queueAction({type:'exit'});
  else powerExit();
}
function powerExit(){
  if(fuses<3||exitPowered)return;
  exitPowered=true;exitRelease=HollowHorror.RELEASE_SECONDS;alarmT=0;sMetal(0,90,.22);
  showMsg('Power restored. The shutter is releasing. Keep moving — they can hear it.',5);
  if(!NET.inGame||NET.role==='host')alertMonsters(100,(W-2)*S+S/2,(W-2)*S+S/2);
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
  if(exitPowered&&!exitOpen){
    if(!NET.inGame||NET.role==='host'){exitRelease=Math.max(0,exitRelease-dt);if(exitRelease===0){exitOpen=true;showMsg('SHUTTER OPEN. Leave the ward.',4);}}
    alarmT-=dt;if(alarmT<=0){alarmT=3.2;sWardSound('alarm',(W-2)*S+S/2,(W-2)*S+S/2);if(!NET.inGame||NET.role==='host')alertMonsters(100,(W-2)*S+S/2,(W-2)*S+S/2);}
  }
  const gate=dynamicWorld.userData.gate;if(gate)gate.position.y=lerp(gate.position.y,exitOpen?H*1.5:exitPowered?H/2+.16:H/2,Math.min(1,dt*2));
  if(dynamicWorld.userData.exitSign)dynamicWorld.userData.exitSign.visible=!exitOpen;
  const shelter=currentShelter(),door=shelter&&roomDoors.find(d=>d.room===shelter);
  const concealed=door&&!door.open&&door.locked&&P.crouching&&!torchOn&&!P.running&&!mouseDown;
  hideTime=concealed?hideTime+dt:0;P.hidden=hideTime>1.25;
  for(const l of roomLoot)if(!l.taken){l.g.userData.label.visible=Math.hypot(P.pos.x-l.x,P.pos.z-l.z)<3.2;l.g.userData.label.rotation.y=P.yaw;}
  for(const d of decoyEvents){d.remaining-=dt;d.pulse-=dt;if(d.pulse<=0){d.pulse=1.2;sThud(d.x,.1,d.z,.6,680);if(!NET.inGame||NET.role==='host')alertMonsters(23,d.x,d.z);}}
  decoyEvents=decoyEvents.filter(d=>d.remaining>0);
  interactionT-=dt;if(interactionT<=0){interactionT=.1;interaction=findInteraction();refreshRoomLights();}
}

/* ---------- first-person layer: hand, torch, rifle ---------- */
const fpScene=new THREE.Scene();
fpScene.matrixAutoUpdate=false;
const fpRig=new THREE.Group();fpScene.add(fpRig);
const fpHemi=physical(new THREE.HemisphereLight(0xffffff,0x000000,0.5),Math.PI);fpScene.add(fpHemi);
const fpKey=physical(new THREE.DirectionalLight(0xbad1dc,.5),Math.PI);fpKey.position.set(-1,2,1);fpRig.add(fpKey);fpRig.add(fpKey.target);
const fpTorchLight=physical(new THREE.PointLight(0xffe7c4,0,2.5),1,1);fpTorchLight.position.set(-0.1,0.15,0.1);fpRig.add(fpTorchLight);
const fpFlash=physical(new THREE.PointLight(0xffa850,0,2.5),1,1);fpFlash.position.set(0.18,-0.12,-0.75);fpRig.add(fpFlash);
const skin=new THREE.MeshStandardMaterial({color:lin(0xc99f86),roughness:0.7});
const sleeveMat=new THREE.MeshStandardMaterial({color:lin(0x1c1f2b),roughness:0.95});
const hand=new THREE.Group();
{const sleeve=new THREE.Mesh(new THREE.CylinderGeometry(0.05,0.058,0.55,12),sleeveMat);sleeve.rotation.x=Math.PI/2;sleeve.position.z=0.47;hand.add(sleeve);
 const palm=new THREE.Mesh(new THREE.BoxGeometry(0.085,0.032,0.1),skin);palm.position.z=0.15;hand.add(palm);
 const idx=new THREE.Mesh(new THREE.CylinderGeometry(0.0095,0.0115,0.1,8),skin);idx.rotation.x=Math.PI/2;idx.position.set(-0.026,0.004,0.05);hand.add(idx);
 for(let k=0;k<3;k++){const f=new THREE.Mesh(new THREE.BoxGeometry(0.019,0.03,0.04),skin);f.position.set(-0.004+k*0.021,-0.018,0.1);f.rotation.x=0.6;hand.add(f);}
 const th=new THREE.Mesh(new THREE.CylinderGeometry(0.011,0.012,0.06,8),skin);th.rotation.set(Math.PI/2,0,0.9);th.position.set(-0.05,-0.008,0.12);hand.add(th);}
hand.visible=false;fpRig.add(hand);
const HAND_REST=new THREE.Vector3(0.32,-0.62,-0.2);
const torch=HollowVisuals.makeFlashlight(THREE);
const lensMat=torch.userData.lensMaterial;
torch.position.set(-0.25,-0.27,-0.44);torch.rotation.set(0.06,-0.07,0);torch.visible=false;fpRig.add(torch);

// Three distinct, fully modeled weapons share the same first-person rig.
const weaponDefs=RULES.WEAPONS;
const weaponModels=weaponDefs.map(w=>HollowVisuals.makeWeapon(THREE,w.id));
let weaponIndex=0,weapons=weaponDefs.map(w=>({mag:w.capacity,reserve:w.reserve}));
let gun=weaponModels[0],gunMag=gun.userData.magazine,muzzleFlash=gun.userData.muzzleFlash;
const GUN_BASE=new THREE.Vector3(.22,-.24,-.38);
weaponModels.forEach(model=>{model.position.copy(GUN_BASE);model.visible=false;fpRig.add(model);});
fpScene.environment=scene.environment;
function selectWeapon(index){
  index=(index+weaponDefs.length)%weaponDefs.length;if(index===weaponIndex)return;
  weapons[weaponIndex].mag=mag;weapons[weaponIndex].reserve=reserve;
  gun.visible=false;weaponIndex=index;gun=weaponModels[index];gunMag=gun.userData.magazine;muzzleFlash=gun.userData.muzzleFlash;
  mag=weapons[index].mag;reserve=weapons[index].reserve;reloadT=0;fireT=.24;gunKick=0;flashT=0;semiFired=false;sMetal(0,560,.07);
}

/* ---------- impacts ---------- */
const sparkTex=glowTex('rgba(255,240,200,1)','rgba(255,150,40,.6)');
const bloodTex=(()=>{const [c,x]=cv(64,64);for(let i=0;i<14;i++)blot(x,rnd(16,48),rnd(16,48),rnd(6,16),'rgba(90,0,0,.9)');return new THREE.CanvasTexture(c);})();
const puffs=[];
for(let i=0;i<20;i++){const blood=i%2===1;const sp=new THREE.Sprite(new THREE.SpriteMaterial({map:blood?bloodTex:sparkTex,transparent:true,depthWrite:false,blending:blood?THREE.NormalBlending:THREE.AdditiveBlending}));
  sp.visible=false;sp.userData={blood,life:0};scene.add(sp);puffs.push(sp);}
function puff(p,blood){const sp=puffs.find(s=>!s.visible&&s.userData.blood===blood);if(!sp)return;sp.position.copy(p);sp.visible=true;sp.userData.life=blood?0.4:0.09;sp.userData.max=sp.userData.life;sp.scale.setScalar(blood?0.25:0.18);sp.material.opacity=1;}
function updatePuffs(dt){for(const sp of puffs){if(!sp.visible)continue;sp.userData.life-=dt;if(sp.userData.life<=0){sp.visible=false;continue;}const k=sp.userData.life/sp.userData.max;sp.material.opacity=k;if(sp.userData.blood){sp.scale.setScalar(0.25+(1-k)*0.35);sp.position.y-=dt*0.3;}}}

/* ---------- monster ---------- */
function makeMonster(kind){return HollowVisuals.makeMonster(THREE,kind);}
const MAX_MON=12;let monCount=8;
const MONSTER_ORDER=['warden','stalker','crawler','shrieker','stalker','crawler','warden','shrieker','crawler','stalker','warden','shrieker'];
const monsters=[];
for(let i=0;i<MAX_MON;i++){const kind=MONSTER_ORDER[i],g=makeMonster(kind);g.visible=false;scene.add(g);
  monsters.push({g,kind,stats:RULES.MONSTERS[kind],pos:new THREE.Vector3(),yaw:0,state:'wander',path:[],repath:0,lastSeen:new THREE.Vector3(),lost:0,searchT:0,stepT:rnd(0,0.6),spotCD:0,hp:RULES.MONSTERS[kind].hp,dead:true,deadT:0,stagger:0,voiceT:rnd(2,6),stalkT:0,watchT:0,flank:i%2?1:-1,lungeT:0,attackT:0,screamT:0,senseT:0,seenTarget:null});}

/* ---------- state ---------- */
const keys={};
const P={pos:new THREE.Vector3(),vel:new THREE.Vector3(),velY:0,onGround:true,yaw:-Math.PI/2,pitch:0,bob:0,bobPhase:0,stamina:1,exhausted:false,running:false,moving:false,health:100,crouching:false,eye:EYE,hidden:false,noise:0,groundY:0,jumpBuffer:0,coyote:0,landing:0,slide:0};
let aiming=false,semiFired=false,fireQueued=false,crouchHeld=false,sprintHeld=false,slideT=0,lean=0,mapExpanded=false;
const touchMove={x:0,y:0};
let state='menu',prevState='outside',torchOn=false,battery=1,elapsed=0,t=0,grace=0,danger=0,caughtT=0,ambientT=12,heartT=0,lastStep=0,msgTimer=0;
let cs=0,csFlags={},csFrom=null,shakeAmt=0,chanFall=null,birdT=1,boxT=0;
const MAG=30;let mag=MAG,reserve=weaponDefs[0].reserve,fireT=0,reloadT=0,mouseDown=false,gunKick=0,flashT=0,gunOut=false,nearestD=99,caughtBy=null,stingerCD=0,mapT=0;
let visited=new Uint8Array(W*W),ammoBoxes=[];

function resetHallProps(){
  chandelier.position.set(CHAN.x,H,CHAN.z);chandelier.rotation.set(0,0,0);chandelier.getObjectByName('chain').visible=true;
  for(let i=obstacles.length-1;i>=0;i--)if(obstacles[i].chan)obstacles.splice(i,1);
  chanFall=null;doorL.rotation.y=0;doorR.rotation.y=0;
}
function setLux(){
  for(const name of ['manor-sconces','manor-bulbs']){const fixture=maze.getObjectByName(name);if(fixture)fixture.visible=true;}
  exterior.visible=true;sun.visible=true;sun.castShadow=true;dynamicWorld.visible=false;chanLight.visible=pedLight.visible=true;
  U.progress.value=0;U.ember.value=0;applyEnv(ENV.out,ENV.lux,0);
  skyU.top.value.copy(untone(0x3f7fd6));skyU.hor.value.copy(untone(0xd6e8f2));skyU.bot.value.copy(untone(0x9fb39a));sunSprite.visible=true;clouds.forEach(c=>c.visible=true);
  bulbMat.color.copy(lin(0xffe2a6));sconceBulbMat.color.copy(lin(0xffcf85));setLight(chanLight,2.2);setLight(pedLight,1.1);
  button.material.emissive.copy(lin(0x550000));plaque.material.map=plaqueLux;plaque.material.needsUpdate=true;
  paintings.forEach(p=>{p.material.map=p.userData.lt;p.material.needsUpdate=true;});
  writingMats.forEach(m=>m.opacity=0);
  torchOn=false;torch.visible=false;hand.visible=false;gunOut=false;gun.visible=false;setLight(spot,0);setLight(bounce,0);lensMat.color.set(0x221c14);
  canvas.style.filter='saturate(1.06)';$('grain').style.opacity=.03;$('vignette').style.opacity=.35;
  resetHallProps();
  if(mazeNavigator)mazeNavigator.invalidate();
}
function setHell(){
  for(const name of ['manor-sconces','manor-bulbs']){const fixture=maze.getObjectByName(name);if(fixture)fixture.visible=false;}
  exterior.visible=false;sun.visible=false;sun.castShadow=false;dynamicWorld.visible=true;chanLight.visible=pedLight.visible=false;
  U.progress.value=1;U.ember.value=0;applyEnv(ENV.lux,ENV.hell,1);
  skyU.top.value.copy(untone(0x050203));skyU.hor.value.copy(untone(0x1a0505));skyU.bot.value.set(0x000000);sunSprite.visible=false;clouds.forEach(c=>c.visible=false);
  bulbMat.color.copy(lin(0x0a0604));sconceBulbMat.color.copy(lin(0x0a0604));setLight(chanLight,0);setLight(pedLight,0);
  button.material.emissive.set(0x000000);plaque.material.map=plaqueHell;plaque.material.needsUpdate=true;
  paintings.forEach(p=>{p.material.map=p.userData.ht;p.material.needsUpdate=true;});
  writingMats.forEach(m=>m.opacity=1);
  canvas.style.filter='none';$('grain').style.opacity=preferences.effects?.027:0;$('vignette').style.opacity=.6;
  doorL.rotation.y=0;doorR.rotation.y=0;
  // chandelier lies where it fell
  chandelier.position.set(CHAN.x,0.9,CHAN.z);chandelier.rotation.set(0.05,0.4,0.22);chandelier.getObjectByName('chain').visible=false;
  if(!obstacles.some(o=>o.chan))obstacles.push({x:CHAN.x,z:CHAN.z,r:0.75,chan:true});
  torchOn=true;torch.visible=false;hand.visible=false;gunOut=true;gun.visible=true;
  if(mazeNavigator)mazeNavigator.invalidate();
}
function spawnMonsters(count){
  monCount=count||8;
  const df=distField(3,2);let max=0;for(const v of df)if(v>max)max=v;
  const cand=[];for(let z=0;z<W;z++)for(let x=0;x<W;x++){const v=df[z*W+x];if(v>Math.min(22,max*.3)&&x<W-1&&!specialRooms.some(r=>r.shelter&&RULES.insideRoom(r,x*S+S/2,z*S+S/2)))cand.push([x,z]);}
  for(let i=cand.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[cand[i],cand[j]]=[cand[j],cand[i]];}
  const chosen=[];
  for(const c of cand){if(chosen.every(o=>Math.abs(o[0]-c[0])+Math.abs(o[1]-c[1])>7))chosen.push(c);if(chosen.length===monCount)break;}
  while(chosen.length<monCount)chosen.push(cand[Math.floor(Math.random()*cand.length)]);
  monsters.forEach((m,i)=>{if(i>=monCount){m.dead=true;m.spawned=false;m.g.visible=false;return;}m.spawned=true;const [wx,wz]=center(chosen[i][0],chosen[i][1]);
    m.pos.set(wx,0,wz);m.yaw=Math.random()*Math.PI*2;m.state='wander';m.path=[];m.repath=0;m.lost=0;m.spotCD=0;m.hp=m.stats.hp;m.dead=false;m.deadT=0;m.stagger=0;m.attackT=0;m.screamT=0;m.senseT=0;m.seenTarget=null;m.heardTarget=null;
    m.voiceT=rnd(2,6);m.stepT=rnd(.2,.8);m.stalkT=0;m.watchT=0;m.lungeT=0;
    m.g.position.copy(m.pos);m.g.rotation.set(0,m.yaw,0);m.g.visible=true;m.g.userData.eyeMat.color.setHex(m.g.userData.eyeColor||0xff2a14);});
}
function hideMonsters(){monsters.forEach(m=>{m.g.visible=false;m.spawned=false;m.dead=true;});if(creatureAudio)creatureAudio.stop();}
function resetSurvivor(){
  if(creatureAudio)creatureAudio.stop();
  P.health=100;P.crouching=false;P.eye=EYE;P.hidden=false;P.noise=0;P.groundY=0;P.jumpBuffer=0;P.coyote=0;P.landing=0;slideT=0;damageT=0;stingerCD=0;aiming=false;semiFired=false;crouchHeld=false;sprintHeld=false;touchMove.x=touchMove.y=0;
  for(const k in keys)keys[k]=false;
  weaponModels.forEach(g=>g.visible=false);weapons=weaponDefs.map(w=>({mag:w.capacity,reserve:w.reserve}));weaponIndex=0;gun=weaponModels[0];gunMag=gun.userData.magazine;muzzleFlash=gun.userData.muzzleFlash;
  mag=weapons[0].mag;reserve=weapons[0].reserve;reloadT=0;fireT=.3;gunKick=0;mouseDown=false;fireQueued=false;flashT=0;hitMarkerT=0;setLight(muzzleLight,0);setLight(fpFlash,0);
}
function newGame(full){
  if(NET.g)leaveRoom();NET.inGame=false;avatar.visible=false;
  avSpot.visible=avFlash.visible=false;
  worldSeed=1+Math.floor(Math.random()*2e9);buildMazeSeeded(worldSeed);resetSurvivor();
  P.vel.set(0,0,0);P.velY=0;P.onGround=true;P.stamina=1;P.exhausted=false;P.bob=0;
  battery=1;elapsed=0;danger=0;ambientT=14;heartT=0;$('flash').style.opacity=0;
  visited=new Uint8Array(W*W);
  if(droneGain)droneGain.gain.value=0;
  if(full){
    setLux();P.pos.set(START.x,0,START.z);P.yaw=-Math.PI/2;P.pitch=0.02;hideMonsters();
    state='outside';showMsg('Walk up to the manor.',4);
    startOutdoor();
  }else{
    setHell();P.pos.set(PED.x-.85,0,PED.z);P.yaw=Math.PI/2;P.pitch=0;spawnMonsters(8);grace=10;state='play';
    if(droneGain)droneGain.gain.value=0.07;stopOutdoor();
    showMsg('BLACKWATER WARD · Recover three fuses. The east loading shutter is your way out.',6);
  }
}

/* ---------- audio ---------- */
let AC=null,master,noiseBuf,creatureAudio=null,droneFilter,droneGain=null,outGain,luxGain,sirenGain,echoIn,luxOn=false;
function initAudio(){
  if(AC){if(AC.state==='suspended')AC.resume();return;}
  try{AC=new (window.AudioContext||window.webkitAudioContext)();}catch(e){AC=null;return;}
  master=AC.createGain();master.gain.value=preferences.volume;master.connect(AC.destination);
  noiseBuf=AC.createBuffer(1,AC.sampleRate*2,AC.sampleRate);const d=noiseBuf.getChannelData(0);for(let i=0;i<d.length;i++)d[i]=Math.random()*2-1;
  // horror drone
  droneFilter=AC.createBiquadFilter();droneFilter.type='lowpass';droneFilter.frequency.value=110;
  droneGain=AC.createGain();droneGain.gain.value=0;droneFilter.connect(droneGain);droneGain.connect(master);
  [36.7,37.1,55.2].forEach(f=>{const o=AC.createOscillator();o.type='sawtooth';o.frequency.value=f;o.connect(droneFilter);o.start();});
  const air=noiseSrc(true),af=AC.createBiquadFilter();af.type='bandpass';af.frequency.value=260;af.Q.value=0.7;
  const ag=AC.createGain();ag.gain.value=0.25;air.connect(af);af.connect(ag);ag.connect(droneGain);air.start();
  // outdoor: wind
  outGain=AC.createGain();outGain.gain.value=0;outGain.connect(master);
  const wind=noiseSrc(true),wf=AC.createBiquadFilter();wf.type='lowpass';wf.frequency.value=500;const wg=AC.createGain();wg.gain.value=0.05;wind.connect(wf);wf.connect(wg);wg.connect(outGain);wind.start();
  const wl=AC.createOscillator();wl.frequency.value=0.09;const wlg=AC.createGain();wlg.gain.value=300;wl.connect(wlg);wlg.connect(wf.frequency);wl.start();
  // luxury music bus
  luxGain=AC.createGain();luxGain.gain.value=0;luxGain.connect(master);
  [220,277.2,329.6,415.3].forEach((f,k)=>{const o=AC.createOscillator();o.type='sine';o.frequency.value=f;const g=AC.createGain();g.gain.value=0.025;
    const tl=AC.createOscillator();tl.frequency.value=0.2+k*0.07;const tg=AC.createGain();tg.gain.value=0.012;tl.connect(tg);tg.connect(g.gain);o.connect(g);g.connect(luxGain);o.start();tl.start();});
  sirenGain=AC.createGain();sirenGain.gain.value=1;sirenGain.connect(master);
  creatureAudio=HollowAudio.create({context:AC,output:master,noiseBuffer:noiseBuf});
  // corridor echo for gunshots
  echoIn=AC.createGain();const ed=AC.createDelay(1),efb=AC.createGain(),elp=AC.createBiquadFilter();ed.delayTime.value=0.13;efb.gain.value=0.42;elp.type='lowpass';elp.frequency.value=1600;
  echoIn.connect(ed);ed.connect(elp);elp.connect(efb);efb.connect(ed);elp.connect(master);
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
function startOutdoor(){if(outGain)fadeTo(outGain,1,2);}
function stopOutdoor(){if(outGain)fadeTo(outGain,0,2.5);}
function sStep(vol,kind){
  if(!AC)return;const n=AC.currentTime,s=noiseSrc(),f=AC.createBiquadFilter(),g=AC.createGain();
  f.type=kind==='grass'?'bandpass':'lowpass';f.frequency.value=kind==='grass'?rnd(1800,2600):kind==='carpet'?rnd(250,380):rnd(380,700);
  s.connect(f);f.connect(g);g.connect(master);env(g,n,0.006,kind==='grass'?vol*0.6:vol,kind==='grass'?0.09:0.13);s.start(n,Math.random());s.stop(n+0.2);
  if(kind==='metal'&&Math.random()<0.5){const o=AC.createOscillator(),og=AC.createGain();o.type='triangle';o.frequency.value=rnd(380,520);o.connect(og);og.connect(master);env(og,n,0.002,vol*0.08,0.25);o.start(n);o.stop(n+0.3);}
}
function sThud(x,y,z,vol,freq){
  if(!AC)return;const n=AC.currentTime,p=makePanner(2.2,1.2);setPos(p,x,y,z);
  const s=noiseSrc(),f=AC.createBiquadFilter(),g=AC.createGain();f.type='lowpass';f.frequency.value=freq||200;s.connect(f);f.connect(g);g.connect(p);env(g,n,0.01,vol,0.28);s.start(n,Math.random());s.stop(n+0.4);
  const o=AC.createOscillator(),og=AC.createGain();o.frequency.setValueAtTime(70,n);o.frequency.exponentialRampToValueAtTime(35,n+0.25);o.connect(og);og.connect(p);env(og,n,0.01,vol*0.8,0.3);o.start(n);o.stop(n+0.4);
}
function shaper(amount){const ws=AC.createWaveShaper(),c=new Float32Array(1024);for(let i=0;i<1024;i++){const x=i/512-1;c[i]=Math.tanh(x*amount);}ws.curve=c;return ws;}
function sCreature(m,cue,volume=1){
  if(!creatureAudio)return;
  const spectating=state==='spect'||state==='pause'&&prevState==='spect',viewer=spectating?R.pos:P.pos;
  if(Math.hypot(viewer.x-m.pos.x,viewer.z-m.pos.z)>(cue==='breath'?16:38))return;
  if(!preferences.effects&&(cue==='notice'||cue==='attack')){cue='breath';volume*=.65;}
  const y=cue==='step'?.15:m.stats.head,eye=spectating?(R.raw.y||0)+(R.raw.crouch?1:EYE):P.pos.y+P.eye;
  return creatureAudio.play(m.kind,cue,{x:m.pos.x,y,z:m.pos.z,volume,occluded:!sightLine(viewer.x,eye,viewer.z,m.pos.x,y,m.pos.z)});
}
function updateMonsterAudio(m,dt,moved){
  const quiet=m.state==='stalk';m.stepT-=moved;m.voiceT-=dt;
  if(m.stepT<=0&&moved>.001){m.stepT=(m.kind==='warden'?1.15:m.kind==='crawler'?.65:.85)*rnd(.85,1.15);sCreature(m,'step',quiet?.3:1);}
  if(m.voiceT<=0){m.voiceT=quiet?rnd(4.5,7.5):m.state==='chase'?rnd(2.2,4):rnd(5,9);sCreature(m,'breath',quiet?.55:.85);}
}


function sHeart(vol){if(!AC)return;const n=AC.currentTime;[0,0.17].forEach((d,k)=>{const o=AC.createOscillator(),g=AC.createGain();o.frequency.setValueAtTime(62,n+d);o.frequency.exponentialRampToValueAtTime(38,n+d+0.15);o.connect(g);g.connect(master);env(g,n+d,0.008,vol*(k?0.7:1),0.18);o.start(n+d);o.stop(n+d+0.3);});}
function sClick(){if(!AC)return;const n=AC.currentTime,o=AC.createOscillator(),g=AC.createGain();o.type='square';o.frequency.value=2400;o.connect(g);g.connect(master);env(g,n,0.002,0.06,0.03);o.start(n);o.stop(n+0.05);}
function sSlam(){
  if(!AC)return;const n=AC.currentTime,p=makePanner(3,0.8);setPos(p,0,1.5,DZC);
  const dl=AC.createDelay(1),fb=AC.createGain();dl.delayTime.value=0.33;fb.gain.value=0.45;dl.connect(fb);fb.connect(dl);dl.connect(p);
  const s=noiseSrc(),f=AC.createBiquadFilter(),g=AC.createGain();f.type='lowpass';f.frequency.value=320;s.connect(f);f.connect(g);g.connect(p);g.connect(dl);env(g,n,0.005,1.0,0.6);s.start(n);s.stop(n+0.8);
  const o=AC.createOscillator(),og=AC.createGain();o.frequency.setValueAtTime(55,n);o.frequency.exponentialRampToValueAtTime(28,n+0.6);o.connect(og);og.connect(p);og.connect(dl);env(og,n,0.005,1,0.7);o.start(n);o.stop(n+0.9);
  setTimeout(()=>{dl.disconnect();fb.disconnect();p.disconnect();g.disconnect();og.disconnect();},4500);
}
function sCreak(){
  if(!AC)return;const n=AC.currentTime,p=makePanner(2,1);setPos(p,0.2,1.5,DZC);
  const o=AC.createOscillator(),f=AC.createBiquadFilter(),g=AC.createGain();o.type='sawtooth';o.frequency.setValueAtTime(55,n);o.frequency.linearRampToValueAtTime(80,n+1.4);
  const l=AC.createOscillator(),lg=AC.createGain();l.frequency.value=17;lg.gain.value=18;l.connect(lg);lg.connect(o.frequency);
  f.type='bandpass';f.frequency.value=900;f.Q.value=7;o.connect(f);f.connect(g);g.connect(p);
  g.gain.setValueAtTime(0.0001,n);g.gain.exponentialRampToValueAtTime(0.35,n+0.2);g.gain.exponentialRampToValueAtTime(0.0001,n+1.5);o.start(n);o.stop(n+1.6);l.start(n);l.stop(n+1.6);
}
function sBird(){
  if(!AC)return;const n=AC.currentTime,a=rnd(0,Math.PI*2),p=makePanner(4,1);setPos(p,P.pos.x+Math.cos(a)*rnd(8,25),rnd(4,9),P.pos.z+Math.sin(a)*rnd(8,25));
  p.disconnect();p.connect(outGain);
  const f0=rnd(2400,4200),cnt=1+Math.floor(rnd(1,5));
  for(let k=0;k<cnt;k++){const st=n+k*rnd(0.09,0.16),o=AC.createOscillator(),g=AC.createGain();o.type='sine';
    o.frequency.setValueAtTime(f0,st);o.frequency.exponentialRampToValueAtTime(f0*rnd(1.2,1.6),st+0.05);o.frequency.exponentialRampToValueAtTime(f0*0.8,st+0.09);
    o.connect(g);g.connect(p);env(g,st,0.01,0.12,0.08);o.start(st);o.stop(st+0.12);}
}
const BOX=[659.3,830.6,987.8,1318.5,1108.7,987.8,830.6,987.8,1108.7,880,830.6,659.3];let boxI=0;
function sMusicBox(){
  if(!AC)return;const n=AC.currentTime,f=BOX[boxI++%BOX.length];
  [1,2.76,5.4].forEach((m,k)=>{const o=AC.createOscillator(),g=AC.createGain();o.type='sine';o.frequency.value=f*m;o.connect(g);g.connect(luxGain);env(g,n,0.003,[0.09,0.03,0.012][k],1.4/(k+1));o.start(n);o.stop(n+1.6);});
}
function sPress(){
  if(!AC)return;const n=AC.currentTime;sClick();
  const o=AC.createOscillator(),g=AC.createGain();o.frequency.setValueAtTime(48,n);o.frequency.exponentialRampToValueAtTime(24,n+2.5);o.connect(g);g.connect(master);env(g,n,0.02,0.7,2.6);o.start(n);o.stop(n+2.8);
}
function sSiren(){
  if(!AC||!preferences.effects)return;const n=AC.currentTime,ws=shaper(2.5),f=AC.createBiquadFilter(),g=AC.createGain();f.type='lowpass';f.frequency.value=1800;
  const dl=AC.createDelay(1),fb=AC.createGain();dl.delayTime.value=0.42;fb.gain.value=0.5;dl.connect(fb);fb.connect(dl);
  ws.connect(f);f.connect(g);g.connect(sirenGain);g.connect(dl);dl.connect(sirenGain);
  g.gain.setValueAtTime(0.0001,n);g.gain.exponentialRampToValueAtTime(0.32,n+1.5);g.gain.setValueAtTime(0.32,n+7.5);g.gain.exponentialRampToValueAtTime(0.0001,n+10.5);
  [1,1.006,0.5].forEach(m=>{const o=AC.createOscillator();o.type='sawtooth';const fr=o.frequency;
    fr.setValueAtTime(140*m,n);fr.exponentialRampToValueAtTime(620*m,n+2.6);fr.setValueAtTime(620*m,n+3.6);fr.exponentialRampToValueAtTime(300*m,n+5.6);
    fr.exponentialRampToValueAtTime(610*m,n+7.6);fr.exponentialRampToValueAtTime(110*m,n+10.5);o.connect(ws);o.start(n);o.stop(n+10.6);});
  setTimeout(()=>{dl.disconnect();fb.disconnect();g.disconnect();f.disconnect();ws.disconnect();},15000);
}
function sCrash(){
  if(!AC)return;const n=AC.currentTime,p=makePanner(3,0.9);setPos(p,CHAN.x,0.5,CHAN.z);
  const s=noiseSrc(),f=AC.createBiquadFilter(),g=AC.createGain();f.type='lowpass';f.frequency.value=600;s.connect(f);f.connect(g);g.connect(p);env(g,n,0.004,1.2,0.5);s.start(n);s.stop(n+0.6);
  for(let k=0;k<28;k++){const st=n+rnd(0,0.9),ss=noiseSrc(),hf=AC.createBiquadFilter(),hg=AC.createGain();hf.type='highpass';hf.frequency.value=rnd(3000,7000);ss.connect(hf);hf.connect(hg);hg.connect(p);env(hg,st,0.002,rnd(.1,.35),rnd(.03,.12));ss.start(st,Math.random());ss.stop(st+0.2);}
  [2093,3136,4186].forEach(fr=>{const o=AC.createOscillator(),og=AC.createGain();o.frequency.value=fr*rnd(.98,1.02);o.connect(og);og.connect(p);env(og,n,0.003,0.08,1.6);o.start(n);o.stop(n+1.8);});
  const b=AC.createOscillator(),bg=AC.createGain();b.frequency.setValueAtTime(70,n);b.frequency.exponentialRampToValueAtTime(30,n+0.6);b.connect(bg);bg.connect(p);env(bg,n,0.004,1,0.7);b.start(n);b.stop(n+0.8);
}
function sShot(){
  if(!AC)return;const n=AC.currentTime,s=noiseSrc(),hp=AC.createBiquadFilter(),lp=AC.createBiquadFilter(),g=AC.createGain();
  const kind=weaponDefs[weaponIndex].id;
  hp.type='highpass';hp.frequency.value=kind==='shotgun'?90:kind==='pistol'?550:300;lp.type='lowpass';lp.frequency.setValueAtTime(kind==='pistol'?7500:kind==='shotgun'?3300:6000,n);lp.frequency.exponentialRampToValueAtTime(900,n+.15);
  s.connect(hp);hp.connect(lp);lp.connect(g);g.connect(master);g.connect(echoIn);env(g,n,0.002,0.85,0.17);s.start(n,Math.random());s.stop(n+0.25);
  const o=AC.createOscillator(),og=AC.createGain();o.frequency.setValueAtTime(150,n);o.frequency.exponentialRampToValueAtTime(45,n+0.14);o.connect(og);og.connect(master);og.connect(echoIn);env(og,n,0.002,0.8,0.16);o.start(n);o.stop(n+0.25);
  const c=AC.createOscillator(),cg=AC.createGain();c.type='square';c.frequency.value=rnd(3200,3800);c.connect(cg);cg.connect(master);env(cg,n+0.05,0.001,0.02,0.03);c.start(n+0.05);c.stop(n+0.1);
}
function sMetal(at,f,v){if(!AC)return;const n=AC.currentTime+at,o=AC.createOscillator(),g=AC.createGain();o.type='triangle';o.frequency.value=f;o.connect(g);g.connect(master);env(g,n,0.002,v,0.09);o.start(n);o.stop(n+0.15);
  const s=noiseSrc(),hf=AC.createBiquadFilter(),hg=AC.createGain();hf.type='highpass';hf.frequency.value=2500;s.connect(hf);hf.connect(hg);hg.connect(master);env(hg,n,0.001,v*0.8,0.04);s.start(n,Math.random());s.stop(n+0.08);}
function sDry(){sMetal(0,900,0.1);}
function sReload(){sMetal(0.25,600,0.14);sMetal(0.33,420,0.1);sMetal(1.25,700,0.16);sMetal(1.32,500,0.12);sMetal(1.8,820,0.15);sMetal(1.95,560,0.18);}
function sPickup(){sMetal(0,520,0.12);sMetal(0.09,760,0.12);}

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
function updateHorror(dt){
  captionT=Math.max(0,captionT-dt);if(captionT===0)captionText='';
  const events=horror.update(dt,{active:state==='play',threat:danger,sheltered:!!currentShelter(),fuses,powered:exitPowered,effects:preferences.effects});
  for(const event of events){
    const x=P.pos.x+Math.cos(event.bearing||P.yaw)*(event.distance||3),z=P.pos.z+Math.sin(event.bearing||P.yaw)*(event.distance||3);
    sWardSound(event.kind,x,z);
    if(captionT<=0){captionText=event.caption;captionT=5;}
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
  if(['outside','play','cutscene'].includes(state)&&['AltLeft','AltRight','Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','ControlLeft','ControlRight'].includes(e.code))e.preventDefault();
  keys[e.code]=true;
  if(!e.repeat){
    const actions={KeyF:'torch',KeyR:'reload',KeyE:'interact',KeyQ:'weapon',KeyV:'decoy',KeyM:'map',Space:'jump',Escape:'pause'};
    if(actions[e.code])inputAction(actions[e.code],true);
    if(state==='play'&&['Digit1','Digit2','Digit3'].includes(e.code))selectWeapon(Number(e.code.slice(-1))-1);
    if(['KeyC','ControlLeft','ControlRight'].includes(e.code))inputAction('crouch',true);
  }
  if((e.code==='Enter'||e.code==='NumpadEnter')&&state==='cutscene'&&cs<21.5)skipCutscene();
},{passive:false});
addEventListener('keyup',e=>{if(e.code==='AltLeft'||e.code==='AltRight')e.preventDefault();keys[e.code]=false;if(['KeyC','ControlLeft','ControlRight'].includes(e.code))inputAction('crouch',false);},{passive:false});
function look(dx,dy){if(state!=='play'&&state!=='outside')return;const touch=controls?controls.touch:IS_TOUCH;const sensitivity=(touch?3.4/Math.max(320,innerWidth):.0022)*preferences.sensitivity*(aiming?.62:1);P.yaw-=dx*sensitivity;P.pitch=Math.max(-1.35,Math.min(1.35,P.pitch-dy*sensitivity));}
addEventListener('mousemove',e=>{
  if((state!=='play'&&state!=='outside')||document.pointerLockElement!==canvas)return;
  look(e.movementX,e.movementY);
});
addEventListener('mousedown',e=>{if(state==='play'&&document.pointerLockElement===canvas){if(e.button===0)inputAction('fire',true);if(e.button===2)inputAction('aim',true);}});
addEventListener('mouseup',e=>{if(e.button===0)inputAction('fire',false);if(e.button===2)inputAction('aim',false);});
canvas.addEventListener('contextmenu',e=>e.preventDefault());
function inputAction(action,pressed){
  if(action==='pause'&&pressed){if(state==='pause')resume();else if(['play','outside','spect'].includes(state)){pause();try{document.exitPointerLock();}catch(e){}}return;}
  if(action==='jump'&&pressed&&state==='cutscene'){skipCutscene();return;}
  if(!['play','outside'].includes(state)&&pressed)return;
  if(action==='fire'){mouseDown=pressed;if(pressed){semiFired=false;fireQueued=true;}}
  if(action==='aim')aiming=pressed;
  if(action==='sprint')sprintHeld=pressed;
  if(action==='crouch'){if(pressed&&P.running&&P.onGround&&P.stamina>.2){slideT=.65;P.stamina-=.16;}crouchHeld=pressed;}
  if(!pressed)return;
  if(action==='jump')P.jumpBuffer=.16;
  if(action==='torch'&&state==='play'){if(battery>.01){torchOn=!torchOn;sClick();}else showMsg('Battery depleted. Leave the torch off to recharge.',2);}
  if(action==='reload'&&state==='play')startReload();
  if(action==='weapon'&&state==='play')selectWeapon(weaponIndex+1);
  if(action==='interact')interact();
  if(action==='decoy')throwDecoy();
  if(action==='map'){mapExpanded=!mapExpanded;$('map').classList.toggle('expanded',mapExpanded);}
}
const controls=window.HollowControls?HollowControls.create({canvas,onAction:inputAction,onLook:look,onMove:(x,y)=>{touchMove.x=x;touchMove.y=y;}}):null;
function lock(){if(controls?controls.touch:IS_TOUCH)return;try{const r=canvas.requestPointerLock();if(r&&r.catch)r.catch(()=>showMsg('Click the game to capture the mouse.',2));}catch(e){}}
function showScreen(id){renderRequested=true;['name','menu','pause','dead','win','coop','coopEnd'].forEach(s=>$(s).hidden=s!==id);$('hud').hidden=!(id===null&&state==='play');
  // A button that closed its own screen keeps focus until the browser's next focus fix-up (a whole frame on slow GPUs),
  // and the key handler ignores buttons: release it now so the next key reaches the game.
  const f=document.activeElement;if(f&&f!==document.body&&f.closest('[hidden]')&&f.blur)f.blur();}
function resume(){initAudio();state=prevState;showScreen(null);lock();}

$('startDarkBtn')?.addEventListener('click',()=>{initAudio();newGame(false);showScreen(null);lock();});
$('changeName').addEventListener('click',()=>openNameScreen());
$('winCopy').addEventListener('click',()=>copyCode($('winCode'),$('winCopy')));
$('menuCopy').addEventListener('click',()=>copyCode($('menuCode'),$('menuCopy')));
$('importForm').addEventListener('submit',async e=>{e.preventDefault();
  const msg=$('importMsg'),r=decodeResult($('importCode').value);
  if(!r){msg.textContent='That code isn’t valid. Ask the player to copy it again, all of it.';return;}
  const id='n_'+fnv(r.name.toLowerCase());
  const cur=sharedRows&&sharedRows.find(x=>x.uid===id);
  if(cur&&cur.time<=r.time){msg.textContent=`${r.name} already has a better time on the board (${fmtTime(cur.time)}).`;return;}
  try{await scoresCol.doc(id).set({name:r.name,time:r.time,kills:r.kills,at:r.at,uid:id,imported:true});
    msg.textContent=`Added ${r.name} — ${fmtTime(r.time)}.`;$('importCode').value='';}
  catch(err){msg.textContent='The board didn’t accept it. Try again in a moment.';}});
$('nameForm').addEventListener('submit',e=>{e.preventDefault();
  const v=$('playerName').value.replace(/\s+/g,' ').trim();
  if(v.length<2){$('nameErr').textContent='Use at least 2 characters.';$('playerName').focus();return;}
  setName(v.slice(0,18));$('nameErr').textContent='';openMenu();});
$('resumeBtn')?.addEventListener('click',resume);
$('pauseMenuBtn')?.addEventListener('click',async()=>{if(NET.g)await leaveRoom();hideMonsters();gunOut=false;weaponModels.forEach(g=>g.visible=false);torch.visible=false;openMenu();});
$('retryDark').addEventListener('click',e=>{e.stopPropagation();initAudio();newGame(false);showScreen(null);lock();});
$('retryFull').addEventListener('click',e=>{e.stopPropagation();initAudio();newGame(true);showScreen(null);lock();});
$('againBtn').addEventListener('click',()=>{initAudio();newGame(true);showScreen(null);lock();});
$('menuBtn').addEventListener('click',()=>openMenu());
canvas.addEventListener('click',()=>{if((state==='play'||state==='outside')&&document.pointerLockElement!==canvas)lock();});
document.addEventListener('pointerlockchange',()=>{if(!(controls?controls.touch:IS_TOUCH)&&document.pointerLockElement!==canvas&&(state==='play'||state==='outside'))pause();});
function releaseInput(){for(const k in keys)keys[k]=false;mouseDown=false;fireQueued=false;aiming=false;crouchHeld=false;sprintHeld=false;touchMove.x=touchMove.y=0;P.jumpBuffer=0;P.running=false;}
addEventListener('blur',()=>{if(state==='play'||state==='outside')pause();releaseInput();});
document.addEventListener('visibilitychange',()=>{if(document.hidden){if(state==='play'||state==='outside')pause();releaseInput();}});
function pause(){if(state==='pause')return;if(!NET.inGame&&creatureAudio)creatureAudio.stop();prevState=state;state='pause';releaseInput();$('pauseLede').textContent=NET.inGame?'Your partner’s game continues. Shelter before pausing.':'Take a breath. The world is paused.';showScreen('pause');if(document.pointerLockElement)try{document.exitPointerLock();}catch(e){}}
addEventListener('resize',()=>{renderRequested=true;renderer.setSize(innerWidth,innerHeight);camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();});
// A lost GPU device (WebGPU) or WebGL context pauses play; the renderer is rebuilt on the same canvas once the
// device is back, because WebGPURenderer cannot restore a lost backend itself.
let graphicsDown=false;
function graphicsLost(){if(graphicsDown)return;graphicsDown=true;if(['play','outside','spect'].includes(state))pause();showMsg('Graphics paused. Waiting for your device to restore the display.',6);}
// Replaces three's default handler (a console error, then no more renders): the game pauses and recovers instead.
function watchDevice(r){r.onDeviceLost=info=>{r._isDeviceLost=true;if(r!==renderer)return;console.warn('[The Hollow] Graphics device lost:',info&&info.message);graphicsLost();if(info&&info.api==='WebGPU')restoreGraphics();};}
async function restoreGraphics(){
  if(!graphicsDown||typeof window.HollowCreateRenderer!=='function')return;
  const old=renderer;
  try{
    const next=await window.HollowCreateRenderer({forceWebGL:!old.backend.isWebGPUBackend});
    renderer=window.HollowRenderer=next;window.HollowBackend=next.backend.isWebGPUBackend?'webgpu':'webgl2';
    configureRenderer();watchDevice(next);graphicsDown=false;renderRequested=true;
    // A restored WebGL context is shared with the new renderer and the old objects died with it: only a lost
    // WebGPU device is released explicitly.
    old.setAnimationLoop(null);if(old.backend.isWebGPUBackend)old.dispose().catch(()=>{});
    showMsg('Display restored. Resume when ready.',4);
  }catch(error){console.warn('[The Hollow] Graphics could not be restored:',error);showMsg('The display could not be restored. Reload the page to continue.',8);}
}
watchDevice(renderer);
canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();graphicsLost();});
canvas.addEventListener('webglcontextrestored',()=>{restoreGraphics();});
function applyQuality(level){
  if(!Object.prototype.hasOwnProperty.call(qualityProfiles,level))return;renderRequested=true;qualityLevel=level;const profile=qualityProfiles[level];renderScale=profile.ratio;
  // Shadow settings are part of the renderer's pipeline cache key: materials need no manual rebuild.
  renderer.setPixelRatio(Math.min(devicePixelRatio||1,renderScale));renderer.shadowMap.enabled=profile.shadows;
  muzzleLight.visible=level!=='low';practicalLights.forEach((light,i)=>light.visible=level!=='low'||i===0);
  spot.shadow.mapSize.set(profile.shadowSize,profile.shadowSize);
  for(const world of [scene,fpScene])world.traverse(o=>{if(o.isMesh){const mats=Array.isArray(o.material)?o.material:[o.material];mats.forEach(m=>{for(const map of [m.map,m.normalMap,m.roughnessMap,m.userData?.transitionMap])if(map){const aniso=level==='low'?1:4;if(map.anisotropy!==aniso){map.anisotropy=aniso;map.needsUpdate=true;}}});}});
}
for(const [id,key] of [['settingsQuality','quality'],['settingsSensitivity','sensitivity'],['settingsVolume','volume'],['settingsMotion','motion'],['settingsEffects','effects']]){
  const el=$(id);if(!el)continue;if(el.type==='checkbox')el.checked=preferences[key];else el.value=preferences[key];
  el.addEventListener('input',()=>{preferences[key]=el.type==='checkbox'?el.checked:key==='quality'?el.value:Number(el.value);try{localStorage.setItem('hollow.settings',JSON.stringify(preferences));}catch(e){}
    if(key==='quality')applyQuality(preferences.quality==='auto'?(IS_TOUCH?'low':'high'):preferences.quality);
    if(key==='volume'&&master)master.gain.value=preferences.volume;
        if(key==='effects'){renderRequested=true;$('grain').style.opacity=preferences.effects?.027:0;if(!preferences.effects){if(creatureAudio)creatureAudio.stop();$('flash').style.opacity=0;setLight(spot,torchOn?3.6:0);weaponModels.forEach(g=>g.userData.muzzleFlash.visible=false);setLight(muzzleLight,0);setLight(fpFlash,0);setLight(avFlash,0);}refreshRoomLights();}
  });
}
function showMsg(text,dur){const m=$('msg');m.textContent=text;m.style.opacity=1;msgTimer=dur||3.2;}
function flashDanger(){danger=Math.max(danger,.6);}
function bars(on){document.body.classList.toggle('bars-on',on);}

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
  slideT=Math.max(0,slideT-dt);P.crouching=crouchHeld||slideT>0;
  P.eye=lerp(P.eye,P.crouching?1.0:EYE,1-Math.exp(-dt*12));
  P.moving=Math.hypot(ix,iz)>.08||slideT>0;
  const wantRun=sprintHeld||keys.AltLeft||keys.AltRight||keys.ShiftLeft||keys.ShiftRight;
  if(P.exhausted&&P.stamina>.3)P.exhausted=false;
  P.running=!!(wantRun&&P.moving&&!P.crouching&&!aiming&&!P.exhausted&&P.stamina>0);
  if(P.running){P.stamina=Math.max(0,P.stamina-dt/8);if(P.stamina<=0)P.exhausted=true;}
  else P.stamina=Math.min(1,P.stamina+dt/(P.moving?8:5));
  P.jumpBuffer=Math.max(0,P.jumpBuffer-dt);
  P.coyote=P.onGround?.1:Math.max(0,P.coyote-dt);
  if(P.jumpBuffer>0&&P.coyote>0&&!P.crouching&&P.stamina>.08){
    // A small vault assist clears waist-high furniture without raising every jump.
        const vault=roomProps.some(p=>p.h>.8&&p.h<=1.1&&Math.abs(P.pos.x-p.x)<p.w/2+PR+.18&&Math.abs(P.pos.z-p.z)<p.d/2+PR+.18);
        P.velY=vault?5.65:5.15;P.onGround=false;P.coyote=0;P.jumpBuffer=0;P.stamina=Math.max(0,P.stamina-.08);sStep(.1,stepKind());
  }
  const speed=slideT>0?RUN*1.15:P.crouching?CROUCH:P.running?RUN:aiming?WALK*.7:WALK;
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
    if(P.pos.y<=ground){
      if(!P.onGround&&P.velY<-1){P.landing=Math.min(.15,-P.velY*.015);sStep(Math.min(.4,-P.velY*.035),stepKind());}
      P.pos.y=ground;P.groundY=ground;P.velY=0;P.onGround=true;
    }else P.onGround=false;
    if(P.pos.x>0&&P.pos.x<W*S&&P.pos.z>0&&P.pos.z<W*S&&P.pos.y+P.eye+.16>H){
      P.pos.y=H-P.eye-.16;P.velY=Math.min(0,P.velY);
    }
  }
  P.landing*=Math.exp(-dt*10);
  const hs=Math.hypot(P.vel.x,P.vel.z);
  if(P.onGround&&hs>.35)stepBob(dt,P.running);else P.bob*=Math.exp(-dt*8);
  P.noise=mouseDown&&mag>0?1:slideT>0?.8:P.running?.8:P.moving?(P.crouching?.09:.3):.02;
  lean=lerp(lean,-ix*(P.running?.026:.013),1-Math.exp(-dt*7));
}
function stepKind(){return state==='outside'||P.pos.x<0?'grass':state==='cutscene'&&U.progress.value<.5?'carpet':specialRooms.some(r=>r.type==='lounge'&&RULES.insideRoom(r,P.pos.x,P.pos.z))?'carpet':'metal';}
function stepBob(dt,running){
  P.bobPhase+=dt*(P.crouching?5:running?11:7.2);
  const step=Math.floor(P.bobPhase/Math.PI);if(step!==lastStep){lastStep=step;sStep(P.crouching?.035:running?.3:.11,stepKind());}
  P.bob=preferences.motion?Math.sin(P.bobPhase)*(P.crouching?.012:running?.045:.022):0;
}

/* ---------- cutscene: the walk to the button, then the change ---------- */
function once(name,at,fn){if(cs>=at&&!csFlags[name]){csFlags[name]=true;fn();}}
function startCutscene(){
  state='cutscene';cs=0;csFlags={};csFrom={x:P.pos.x,z:P.pos.z,yaw:P.yaw,pitch:P.pitch};
  bars(true);P.vel.set(0,0,0);showScreen(null);$('msg').style.opacity=0;
}
function angLerp(a,b,k){if(!Number.isFinite(a))a=0;if(!Number.isFinite(b))return a;const tau=Math.PI*2,d=((b-a+Math.PI)%tau+tau)%tau-Math.PI;return a+d*k;}
const _bw=new THREE.Vector3();
function updateCutscene(dt){
  const prev=cs;cs+=dt;
  const base=-Math.PI/2,X0=-2.8,X1=PED.x-0.75;
  // position + gaze
  if(cs<1.8){const a=ease(0,1.6,cs);P.pos.x=lerp(csFrom.x,X0,a);P.pos.z=lerp(csFrom.z,DZC,a);P.yaw=angLerp(csFrom.yaw,base,a);P.pitch=lerp(csFrom.pitch,0.04,a);}
  else{
    const w=ease(1.8,8.8,cs);P.pos.x=lerp(X0,X1,w);P.pos.z=DZC;
    const walking=cs<8.8;
    if(walking)stepBob(dt,false);else P.bob*=Math.max(0,1-6*dt);
    let yaw=base+0.14*Math.sin((cs-1.8)*0.9)*(1-ease(7.5,8.8,cs));
    const chanLook=ease(4.2,6.0,cs)*(1-ease(6.6,8.2,cs));
    let pitch=lerp(0.04,0.5,chanLook);
    pitch=lerp(pitch,-0.58,ease(8.6,9.8,cs));
    pitch=lerp(pitch,-0.05,ease(15.0,16.0,cs));
    yaw=angLerp(yaw,base+Math.PI,ease(15.0,16.1,cs));
    P.yaw=yaw;P.pitch=pitch;
  }
  const inside=ease(-1.6,2.6,P.pos.x);
  // doors: open, then slam
  let da=ease(0.3,2.1,cs)*1.42;if(cs>=16.0)da=1.42*(1-ease(16.0,16.22,cs));
  doorL.rotation.y=da;doorR.rotation.y=-da;
  once('open',0.3,()=>{sCreak();luxOn=true;if(luxGain)fadeTo(luxGain,1,2.5);stopOutdoor();});
  // lighting: outside -> lux -> hell
  const hk=ease(12.4,20.5,cs);
  let flick=1;
  if(preferences.effects&&cs>12.4&&cs<21)flick=1-.28*Math.pow(Math.sin((cs-12.4)*.55),2);
  if(cs<12.4)applyEnv(ENV.out,ENV.lux,inside);else applyEnv(ENV.lux,ENV.hell,hk,flick);
  U.progress.value=ease(12.6,20.5,cs);U.ember.value=Math.sin(Math.PI*U.progress.value)*1.6;
  writingMats.forEach(m=>m.opacity=ease(17,21,cs));
  // sconces & hall lights die
  const sc=lin(0xffcf85).lerp(lin(0x0a0604),ease(13,19.5,cs));
  if(preferences.effects&&cs>12.4&&cs<20)sc.multiplyScalar(flick);
  sconceBulbMat.color.copy(sc);
  if(!chanFall){setLight(chanLight,cs>12.4?2.2*flick*(1-hk*0.5):2.2);bulbMat.color.setScalar(1).lerp(lin(0xffe2a6),1).multiplyScalar(cs>12.4?flick:1);}
  setLight(pedLight,cs<11.2?1.1:cs<12.4?0.4:1.1*flick*(1-ease(14,18,cs)));
  // hand reaches for the button
  hand.visible=cs>9.6&&cs<12.6;
  if(hand.visible){
    camera.updateMatrixWorld();
    const target=camera.worldToLocal(new THREE.Vector3(PED.x-0.025,1.115,PED.z));
    const k=ease(9.8,11.2,cs)*(1-ease(11.6,12.5,cs));
    hand.position.lerpVectors(HAND_REST,target,k);hand.rotation.set(0.42,0.32,-0.1);
  }
  once('touch',11.2,()=>{sPress();luxOn=false;if(luxGain){const n=AC.currentTime;luxGain.gain.cancelScheduledValues(n);luxGain.gain.setValueAtTime(0,n);}});
  button.material.emissive.setRGB(cs<11.2?0.33+0.12*Math.sin(cs*4):Math.max(0,1.8*(1-(cs-11.2)/0.8)),0,0);
  // the change
  once('siren',12.4,()=>{sSiren();shakeAmt=0.004;});
  once('plaque',16.8,()=>{plaque.material.map=plaqueHell;plaque.material.needsUpdate=true;});
  once('paint',15.8,()=>{paintings.forEach(p=>{p.material.map=p.userData.ht;p.material.needsUpdate=true;});});
  once('sky',16.3,()=>{skyU.top.value.copy(untone(0x050203));skyU.hor.value.copy(untone(0x1a0505));skyU.bot.value.set(0);sunSprite.visible=false;clouds.forEach(c=>c.visible=false);});
  once('drone',13,()=>{if(droneGain)fadeTo(droneGain,0.07,6);});
  once('filter',13,()=>{canvas.style.filter='saturate(.72) contrast(1.08)';$('grain').style.opacity=.1;$('vignette').style.opacity=1;});
  once('jitter',13.5,()=>{});
  if(cs>13.5&&cs<14.6){chandelier.rotation.z=Math.sin(cs*31)*0.03;chandelier.rotation.x=Math.cos(cs*27)*0.02;}
  once('drop',14.6,()=>{chanFall={v:0};chandelier.getObjectByName('chain').visible=false;});
  if(chanFall&&!chanFall.done){chanFall.v+=9.8*dt;chandelier.position.y-=chanFall.v*dt;setLight(chanLight,preferences.effects?1.2*flick:.7);
    if(chandelier.position.y<=0.9){chandelier.position.y=0.9;chandelier.rotation.set(0.05,0.4,0.22);chanFall.done=true;sCrash();shakeAmt=0.09;setLight(chanLight,0);bulbMat.color.copy(lin(0x0a0604));obstacles.push({x:CHAN.x,z:CHAN.z,r:0.75,chan:true});}}
  once('slam',16.0,()=>{sSlam();shakeAmt=Math.max(shakeAmt,0.06);});
  // darkness, then the torch
  once('torch',21.6,()=>{torchOn=true;torch.visible=false;hand.visible=false;gunOut=true;gun.visible=true;sClick();sMetal(0.4,560,0.14);sMetal(0.55,800,0.12);});
  if(cs>=21.6){const k=ease(21.6,22.0,cs);setLight(spot,2.6*k);setLight(bounce,0.18*k);lensMat.color.setRGB(k,k*0.92,k*0.8);}
  once('end',22.8,()=>endCutscene());
  shakeAmt*=Math.max(0,1-2.2*dt);
}
function skipCutscene(){
  if(luxGain){const n=AC.currentTime;luxGain.gain.cancelScheduledValues(n);luxGain.gain.setValueAtTime(0,n);}
  if(sirenGain){fadeTo(sirenGain,0,0.3);setTimeout(()=>{if(sirenGain)fadeTo(sirenGain,1,0.1);},12000);}
  luxOn=false;stopOutdoor();if(droneGain)fadeTo(droneGain,0.07,1);
  setHell();P.pos.set(PED.x-0.75,0,PED.z);P.yaw=Math.PI/2;P.pitch=-0.05;hand.visible=false;
  setLight(spot,2.6);setLight(bounce,0.18);lensMat.color.setRGB(1,0.92,0.8);
  endCutscene();
}
function endCutscene(){
  bars(false);setHell();state='play';grace=10;spawnMonsters(8);showScreen(null);
  showMsg('Recover three power fuses. Lock an isolation room to hide from the Warden.',5);
}

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
  if(localInDanger())out.push({x:P.pos.x,z:P.pos.z,y:P.pos.y,yaw:P.yaw,torch:torchOn,running:P.running,crouching:P.crouching,hidden:P.hidden,local:true});
  if(NET.inGame&&NET.role==='host'&&R.present&&R.gn===NET.gen&&R.al&&!R.out)out.push({x:R.raw.x,z:R.raw.z,y:R.raw.y||0,yaw:R.raw.yaw,torch:R.raw.torch,running:R.raw.run,crouching:R.raw.crouch,hidden:R.raw.hidden,local:false});
  return out;
}
function setPathTo(m,x,z){m.path=mazeNavigator?mazeNavigator.path(m.pos.x,m.pos.z,Math.max(S+.65,Math.min((W-1)*S-.65,x)),Math.max(S+.65,Math.min((W-1)*S-.65,z)),m.stats.radius):[];}
function moveToward(m,x,z,sp,dt){
  const dx=x-m.pos.x,dz=z-m.pos.z,d=Math.hypot(dx,dz);if(d<.001)return d;
  const step=Math.min(d,sp*dt);m.pos.x+=dx/d*step;m.pos.z+=dz/d*step;
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
function alertMonsters(radius,x,z){
  if(x==null){x=P.pos.x;z=P.pos.z;}
  for(const m of monsters){if(m.dead)continue;if(Math.hypot(x-m.pos.x,z-m.pos.z)<radius){m.state='chase';m.lastSeen.set(x,0,z);m.lost=0;m.repath=0;}}
}
function damagePlayer(m){
  if(!localInDanger()||damageT>0||grace>0||P.hidden)return;
  P.health=Math.max(0,P.health-m.stats.damage);damageT=1.05;P.landing=preferences.motion?.06:0;m.lungeT=.3;
  sCreature(m,'attack');sThud(P.pos.x,1,P.pos.z,.16,90);
  dopaHurt(m);
  if(P.health<=0){caught(m);return;}
  showMsg(m.kind==='warden'?'The Warden hits hard. Run, lock a door, hide.':`${m.stats.name} attack · find cover or a medical kit.`,2.5);

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
  m.spotCD=10;sCreature(m,'notice');
  if(local&&stingerCD<=0&&Math.hypot(P.pos.x-m.pos.x,P.pos.z-m.pos.z)<9){stingerCD=8;flashDanger();}
}
function updateMonster(m,dt){
  if(m.dead){if(m.g.visible){m.deadT+=dt;const k=ease(0,.8,m.deadT);m.g.rotation.x=-1.5*k;m.g.position.y=.15*k;if(m.deadT>18)m.g.visible=false;}return;}
  resolve(m.pos,m.stats.radius);
  const previousState=m.state,sneaky=m.kind==='stalker'||m.kind==='crawler';
  m.spotCD=Math.max(0,m.spotCD-dt);m.stagger=Math.max(0,m.stagger-dt);m.attackT=Math.max(0,m.attackT-dt);m.screamT=Math.max(0,m.screamT-dt);m.lungeT=Math.max(0,m.lungeT-dt);
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
    const watched=sees&&watchingMonster(m,tg);
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
      m.screamT=16;if(previousState==='chase')sCreature(m,'notice');
      alertMonsters(28,m.pos.x,m.pos.z);m.lastSeen.set(tg.x,0,tg.z);
      if(tg.local)showMsg('A Shrieker called the others. Change direction.',2.8);
    }
    speed=m.stats.chase*(m.stagger>0?(m.kind==='warden'?.85:.35):1);
    if(m.kind==='crawler')speed*=Math.sin(t*8+m.g.userData.phase*.2)>.15?1.12:.62;
    const locked=roomDoors.find(d=>!d.open&&RULES.insideRoom(d.room,m.lastSeen.x,m.lastSeen.z));
    if(!sees)m.lost+=dt;
    if(locked){
      const d=Math.hypot(m.pos.x-locked.box.x,m.pos.z-locked.box.z);
      if(d<2.4){
        m.yaw=angLerp(m.yaw,Math.atan2(locked.box.x-m.pos.x,locked.box.z-m.pos.z),Math.min(1,dt*4));
        if(tgs.some(c=>c.torch&&RULES.insideRoom(locked.room,c.x,c.z)))m.lost=0;
        locked.health-=dt*(locked.locked?(m.kind==='warden'?6:2):32);
        if(m.attackT<=0){m.attackT=1.3;m.lungeT=.3;sThud(locked.box.x,1,locked.box.z,.35,m.kind==='warden'?75:150);}
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
  for(const other of monsters){if(other===m||other.dead)continue;const dx=m.pos.x-other.pos.x,dz=m.pos.z-other.pos.z,d=Math.hypot(dx,dz),gap=m.stats.radius+other.stats.radius;
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
    updateMonster(m,dt);if(state!==st0)return;
    if(m.dead)continue;const d=Math.hypot(P.pos.x-m.pos.x,P.pos.z-m.pos.z);nearestD=Math.min(nearestD,d);
    target=Math.max(target,m.state==='chase'?Math.max(0,1-d/32):m.state==='stalk'?Math.max(0,1-d/6)*.18:Math.max(0,1-d/14)*.35);
  }
  danger+=(target-danger)*Math.min(1,dt*2);
}
function animateMonster(m,dt){
  const u=m.g.userData;if(m.dead){u.glow.intensity=0;return;}
  const sp=u.speed||0,moving=Math.min(1,sp),quiet=m.state==='stalk';
  u.phase+=dt*sp*(m.kind==='warden'?1.6:m.kind==='crawler'?4.8:2.4);
  const s=Math.sin(u.phase)*moving,drag=Math.sin(u.phase+.65)*moving;
  const lunge=Math.sin(Math.PI*clamp01((m.lungeT||0)/.3)),chasing=u.chasing||state==='caught'&&m===caughtBy;
  const reach=chasing?-.5:quiet?-.16:0,jolt=preferences.effects&&m.stagger>0?Math.sin(m.stagger*45)*.12:0;
  const pose=(part,x=0,y=0,z=0)=>{if(!part)return;const rest=u.restPose[part.name];part.rotation.set(rest.x+x,rest.y+y,rest.z+z);};
  pose(u.legL,s*.34);pose(u.legR,-drag*.25);
  pose(u.armL,reach-s*.14-lunge*.65+jolt,0,-lunge*.09);
  pose(u.armR,reach*.55+drag*.12-lunge*.42-jolt,0,lunge*.15);
  u.knees.forEach((joint,i)=>pose(joint,Math.max(0,-Math.sin(u.phase+i*Math.PI))*.42*moving));
  u.elbows.forEach((joint,i)=>pose(joint,Math.sin(u.phase+i*Math.PI)*.07*moving-lunge*.22));
  u.twitchT-=dt;if(u.twitchT<=0){u.twitchT=rnd(1.8,4.8);u.twitch=rnd(-.24,.24);}
  u.twitchAngle=lerp(u.twitchAngle||0,preferences.effects?u.twitch:0,1-Math.exp(-dt*8));
  pose(u.neck,Math.sin(t*.85)*.035+jolt-lunge*.12,Math.sin(t*.47)*.05,u.twitchAngle);
  pose(u.jaw,(m.kind==='shrieker'?.09:.035)*(1+Math.sin(t*1.7))+lunge*.3);
  if(m.kind==='stalker'){
    pose(u.legR,-drag*.19);pose(u.armR,reach*.4+drag*.09-lunge*.7,Math.sin(t*.6)*.08,.1);
    pose(u.head,Math.sin(t*.8)*.025,Math.sin(t*.43)*.06);
  }else if(m.kind==='crawler'){
    pose(u.armL,s*.18-lunge*.25,0,s*.06);pose(u.armR,-s*.26-lunge*.35,0,-drag*.08);
    pose(u.legL,-drag*.22,0,drag*.05);pose(u.legR,s*.14,0,-s*.07);
    u.elbows.forEach((joint,i)=>pose(joint,Math.max(0,Math.sin(u.phase+i*Math.PI))*.28));
    pose(u.neck,Math.sin(t*.9)*.025-lunge*.18,Math.sin(u.phase*.5)*.045,u.twitchAngle*.4);
  }else if(m.kind==='warden'){
    pose(u.armL,-s*.12-lunge*.6);pose(u.armR,drag*.08-lunge*.3);
    pose(u.neck,-lunge*.1,Math.sin(t*.5)*.035,Math.sin(t*.7)*.035);
  }
}

/* ---------- rifle ---------- */
function startReload(){
  const w=weaponDefs[weaponIndex];
  if(state!=='play'||reloadT>0||mag>=w.capacity)return;
  if(reserve<=0){showMsg('No spare ammunition. Search rooms and dead ends.',2);return;}
  reloadT=w.reload;aiming=false;sReload();
}
const _o=new THREE.Vector3(),_d=new THREE.Vector3(),_shotDir=new THREE.Vector3(),_shotQuat=new THREE.Quaternion(),_shotEuler=new THREE.Euler(0,0,0,'YXZ');
function fire(){
  if(reloadT>0||P.hidden)return;
  fireQueued=false;
  const w=weaponDefs[weaponIndex];
  if(mag<=0){sDry();fireT=.3;semiFired=true;if(reserve>0)startReload();else showMsg('Weapon empty. Switch weapons or find supplies.',2);return;}
  mag--;weapons[weaponIndex].mag=mag;fireT=w.interval;gunKick=1;flashT=.045;semiFired=true;sShot();NET.shots++;
  if(!NET.inGame||NET.role==='host')alertMonsters(w.noise);
  _o.set(P.pos.x,P.pos.y+P.eye+P.bob,P.pos.z);
  _shotQuat.setFromEuler(_shotEuler.set(P.pitch,P.yaw,0,'YXZ'));_shotDir.set(0,0,-1).applyQuaternion(_shotQuat);
  const spread=w.spread*(aiming?.4:1)*(P.crouching?.65:1)+(P.moving?.008:0);
  dopaShotBegin();
  let didHit=false;
  for(let pellet=0;pellet<w.pellets;pellet++){
    _d.copy(_shotDir);_d.x+=rnd(-spread,spread);_d.y+=rnd(-spread,spread);_d.z+=rnd(-spread,spread);_d.normalize();
    let wallDistance=48;
    for(let st=.1;st<48;st+=.13){if(blocksRay(_o.x+_d.x*st,_o.y+_d.y*st,_o.z+_d.z*st)){wallDistance=st;break;}}
    let best=null,distance=wallDistance;
    for(const m of monsters){if(m.dead)continue;
      const ox=_o.x-m.pos.x,oz=_o.z-m.pos.z,a=_d.x*_d.x+_d.z*_d.z;if(a<.00001)continue;
      const radius=m.stats.radius,b=2*(ox*_d.x+oz*_d.z),c=ox*ox+oz*oz-radius*radius,disc=b*b-4*a*c;if(disc<0)continue;
      const sq=Math.sqrt(disc);let at=(-b-sq)/(2*a);if(at<0)at=(-b+sq)/(2*a);if(at<0||at>=distance)continue;
      const y=_o.y+_d.y*at;if(y<.06||y>m.stats.height)continue;distance=at;best={m,y};
    }
    const hit=_o.clone().addScaledVector(_d,Math.max(0,distance-.04));
    if(best){
      didHit=true;puff(hit,true);
      const damage=RULES.weaponDamage(w.id,best.y>best.m.stats.head,distance,best.m.kind);
      dopaShotHit(best.m,best.y>best.m.stats.head,distance);
      if(NET.inGame&&NET.role==='guest'){const k=monsters.indexOf(best.m);NET.dm[k]=(NET.dm[k]||0)+damage;best.m.stagger=.2;}
      else hitMonster(best.m,damage);
    }else if(wallDistance<48)puff(hit,false);
  }
  dopaShotEnd();
  if(didHit){hitMarkerT=.16;sMetal(0,1700,.025);}
  P.pitch=Math.min(1.35,P.pitch+w.recoil*(aiming?.65:1));P.yaw+=rnd(-.003,.003);
  if(w.id==='shotgun')sMetal(.35,440,.14);
}
function hitMonster(m,dmg,from){
  if(m.dead)return;
  m.hp-=dmg;m.stagger=m.kind==='warden'?.07:.25;m.state='chase';
  if(from)m.lastSeen.set(from.x,0,from.z);else m.lastSeen.copy(P.pos);m.lost=0;
  if(m.hp<=0){
    m.dead=true;m.deadT=0;m.g.userData.eyeMat.color.set(0x120000);m.g.userData.glow.intensity=0;sCreature(m,'death');
    const left=monsters.filter((o,i)=>i<monCount&&!o.dead).length;
    showMsg(left?`${m.stats.name} down · ${left} threats remain.`:'The corridors are silent. Restore the exit power.',2.5);
  }else if(m.kind==='warden'&&noticeT<=0){noticeT=12;showMsg('It barely flinched. Save ammunition: break sight, lock a room, hide.',3.2);}
}
function updateGun(dt){
  const visible=gunOut&&['play','caught','cutscene','pause'].includes(state);
  weaponModels.forEach((model,i)=>{model.visible=visible&&i===weaponIndex;if(!model.visible)model.userData.muzzleFlash.visible=false;});
  if(gunOut){torch.visible=false;hand.visible=false;}
  if(!visible){setLight(muzzleLight,0);setLight(fpFlash,0);return;}
  if(state==='pause')return;
  const w=weaponDefs[weaponIndex];fireT-=dt;
  if(state==='play'&&(mouseDown||fireQueued)&&fireT<=0&&!P.running&&(w.automatic||!semiFired))fire();
  if(reloadT>0){reloadT=Math.max(0,reloadT-dt);if(reloadT===0){const take=Math.min(w.capacity-mag,reserve);mag+=take;reserve-=take;weapons[weaponIndex]={mag,reserve};}}
  gunKick*=Math.exp(-dt*15);flashT-=dt;
  const progress=reloadT>0?1-reloadT/w.reload:0,rp=reloadT>0?Math.sin(Math.PI*progress):0;
  gun.userData.run=lerp(gun.userData.run||0,P.running?1:0,1-Math.exp(-dt*8));
  gun.userData.aim=lerp(gun.userData.aim||0,aiming&&!P.running&&!reloadT?1:0,1-Math.exp(-dt*12));
  const rk=gun.userData.run,ak=gun.userData.aim;
  gun.position.set(lerp(GUN_BASE.x,.025,ak)+rk*.04,lerp(GUN_BASE.y,-.12,ak)+P.bob*.4-rp*.16-rk*.08,GUN_BASE.z+gunKick*(w.id==='shotgun'?.09:.045)+ak*.07);
  gun.rotation.set(gunKick*.09+rp*.45-rk*.35,rk*.38,rp*.6+lean*.5);
  if(gunMag)gunMag.visible=!(reloadT>0&&progress>.3&&progress<.65);
  if(gun.userData.bolt)gun.userData.bolt.position.z=(gun.userData.bolt.userData.restZ||0)+gunKick*.025;
  const flashing=preferences.effects&&flashT>0;
  if(muzzleFlash){muzzleFlash.visible=flashing;if(flashing)muzzleFlash.rotation.z=Math.random()*6.28;}
  setLight(muzzleLight,flashing?3:0);setLight(fpFlash,flashing?3:0);
}

/* ---------- map ---------- */
const mapCtx=$('map').getContext('2d');
function markVisited(){
  const cx=Math.floor(P.pos.x/S),cz=Math.floor(P.pos.z/S);
  if(cx>=0&&cz>=0&&cx<W&&cz<W)visited[cz*W+cx]=1;
}
function drawMap(){
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
  c.fillStyle=exitPowered?'#96eac5':'#df6f4d';c.fillRect((W-1)*k,(W-2)*k,k,k);
  if(visited[(W-2)*W+(W-1)]){c.fillStyle='#ff3322';c.fillRect((W-1)*k,(W-2)*k,k,k);}
  const px=P.pos.x/S*k,pz=P.pos.z/S*k,fx=-Math.sin(P.yaw),fz=-Math.cos(P.yaw);
  c.strokeStyle='#e0402e';c.lineWidth=1.5;c.beginPath();c.moveTo(px,pz);c.lineTo(px+fx*7,pz+fz*7);c.stroke();
  c.fillStyle='#fff';c.beginPath();c.arc(px,pz,2.2,0,7);c.fill();
  if(NET.inGame&&R.present&&R.gn===NET.gen&&R.al&&!R.out){c.fillStyle='#7fb2ff';c.beginPath();c.arc(R.pos.x/S*k,R.pos.z/S*k,2.2,0,7);c.fill();}
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
function caught(m){
  if(!localInDanger())return;
  if(state==='pause'){showScreen(null);}
  state='caught';caughtT=0;caughtBy=m;torchOn=true;mouseDown=false;
  if(creatureAudio)creatureAudio.stop();sCreature(m,'attack');$('hud').hidden=true;
}
function updateCaught(dt){
  caughtT+=dt;const g=caughtBy.g;
  const fx=-Math.sin(P.yaw),fz=-Math.cos(P.yaw),camY=P.pos.y+EYE;
  g.position.set(P.pos.x+fx*0.72,camY-caughtBy.g.userData.headHeight,P.pos.z+fz*0.72);g.rotation.set(0,Math.atan2(-fx,-fz),0);
  P.pitch+=(0-P.pitch)*Math.min(1,dt*12);
  setLight(spot,preferences.effects?3.2*(1-ease(.3,1.6,caughtT)):2.6);
  $('flash').style.opacity=0;danger=1;
  if(caughtT>1.6&&NET.inGame){coopLocalDone('dead');return;}
  if(caughtT>1.6){
    state='dead';hideMonsters();setLight(spot,0);$('flash').style.opacity=0;gun.visible=false;
    const m=Math.floor(elapsed/60),s=Math.floor(elapsed%60),kills=monsters.length-0;
    $('deadText').textContent=`You lasted ${m}:${String(s).padStart(2,'0')} in the dark. The corridors are quiet again.`;
    showScreen('dead');renderBoards();try{document.exitPointerLock();}catch(e){}
  }
}
/* ---------- grain ---------- */
const gc=$('grain').getContext('2d'),gimg=gc.createImageData(256,144);
function drawGrain(){const d=gimg.data;for(let i=0;i<d.length;i+=4){const v=Math.random()*255;d[i]=d[i+1]=d[i+2]=v;d[i+3]=255;}gc.putImageData(gimg,0,0);}

/* ---------- loop ---------- */
const timer=new THREE.Timer();let frame=0,hudT=0;
function updateHealthVignette(){
  const active=state==='play'||state==='caught'||state==='pause'&&prevState==='play';
  const injury=active?RULES.injuryLevel(P.health):0;
  $('healthVignette').style.opacity=(injury*.98).toFixed(3);
  $('healthVignette').style.setProperty('--injury-clear',(65-injury*33).toFixed(1)+'%');
}
function updateHUD(){
  const active=state==='play',exploring=state==='outside',cinematic=state==='cutscene',w=weaponDefs[weaponIndex],touch=controls?controls.touch:IS_TOUCH;
  $('hud').hidden=!(active||exploring||cinematic);$('ammo').hidden=!(active||state==='spect');$('cross').hidden=!active;
  $('hud').querySelector('.vitals-panel').hidden=!active;
    const room=active&&specialRooms.find(r=>RULES.insideRoom(r,P.pos.x,P.pos.z));
    $('locationText').textContent=active?(room?room.name:'BLACKWATER / '+(P.pos.z<36?'ADMISSIONS':P.pos.z<72?'SERVICE WING':'LOWER TREATMENT')):'';
    $('horrorCaption').textContent=active?captionText:'';
    $('escapeStatus').textContent=active&&exitPowered?(exitOpen?'RELEASE COMPLETE · RUN':'RELEASING SHUTTER · '+Math.ceil(exitRelease)+'s'):'';
    document.body.classList.toggle('reading-record',active&&captionT>0&&captionText[0]!=='[');
  if(controls)controls.update({active:active||state==='outside'||state==='cutscene',state,torchOn,canInteract:!!interaction,decoys,mapExpanded});
  if(!active){if(exploring||cinematic){$('objectiveText').textContent=exploring?'THE ARRIVAL · follow the stone path to the manor':'THE OTHER SIDE · something is changing';$('interactionPrompt').textContent='';$('controlsHint').textContent=cinematic?(touch?'Tap SKIP SCENE to continue':'ENTER · skip the scene'):touch?'Left stick: move · Drag right: look · Hold SPRINT to run':'WASD move · Mouse look · SHIFT sprint · SPACE jump · ESC pause';$('fpsText').textContent=Math.round(1000/frameAverage)+' FPS';}return;}
  $('batBar').style.width=(battery*100).toFixed(1)+'%';$('batBar').style.background=battery<.2?'var(--ember)':'var(--bone)';
  $('stamBar').style.width=(P.stamina*100).toFixed(1)+'%';$('stamBar').style.background=P.exhausted?'var(--ember)':'var(--bone)';$('stamRow').style.opacity=1;
  $('healthBar').style.width=P.health+'%';$('healthBar').style.background=P.health<35?'var(--critical)':'var(--bone)';$('healthText').textContent=Math.ceil(P.health)+'%';$('healthText').style.color=P.health<35?'var(--critical)':'';
  $('noiseBar').style.width=Math.round(P.noise*100)+'%';$('stanceText').textContent=P.hidden?'CONCEALED':slideT>0?'SLIDING':P.crouching?'CROUCHED':P.running?'SPRINTING':P.onGround?'STANDING':'AIRBORNE';
  const remaining=roomLoot.filter(l=>l.type==='fuse'&&!l.taken).sort((a,b)=>Math.hypot(a.x-P.pos.x,a.z-P.pos.z)-Math.hypot(b.x-P.pos.x,b.z-P.pos.z));
  const nearest=remaining[0];
  $('objectiveText').textContent=exitOpen?'EVACUATE · east loading exit':exitPowered?'THE ALARM IS DRAWING THEM HERE':fuses===3?'3 / 3 FUSES · power the east loading shutter':`${fuses} / 3 FUSES · ${nearest?nearest.room.name.slice(5):'search marked rooms'}`;
  $('fpsText').textContent=Math.round(1000/frameAverage)+' FPS · '+qualityLevel.toUpperCase();
  $('weaponName').textContent=w.name;$('magTxt').textContent=mag;$('resTxt').textContent='/ '+reserve;$('magTxt').style.color=mag===0?'var(--ember)':'';
  $('ammoLbl').textContent=reloadT>0?`RELOADING · ${reloadT.toFixed(1)}s`:aiming?'AIMING':w.automatic?'AUTOMATIC':w.id==='shotgun'?'PUMP ACTION':'SEMI-AUTOMATIC';
  if($('weaponSlots').children.length!==weaponDefs.length){$('weaponSlots').textContent='';weaponDefs.forEach((v,i)=>{const slot=document.createElement('span');slot.textContent=(i+1)+' '+['AR','M9','SG'][i];slot.title=v.name;$('weaponSlots').appendChild(slot);});}
  [...$('weaponSlots').children].forEach((slot,i)=>slot.classList.toggle('selected',i===weaponIndex));
  $('reticleHit').style.opacity=hitMarkerT>0?1:0;$('cross').classList.toggle('aiming',aiming);
  let prompt='';const key=touch?'USE':'[E]';
  if(interaction){
    if(interaction.type==='door'){const d=interaction.item,inside=RULES.insideRoom(d.room,P.pos.x,P.pos.z);prompt=d.open?`${key} Close isolation door`:d.locked?(inside?`${key} Unlock & open · lock integrity ${Math.ceil(d.health)}%`:'Door locked from inside'):inside?`${key} Lock door · crouch + torch OFF to hide`:`${key} Open isolation door`;}
    if(interaction.type==='loot'){const type=interaction.item.type;prompt=`${key} ${type==='fuse'?'Recover power fuse':type==='medical'?'Use field dressing · +45 health':'Collect ammunition, battery & decoy'}`;}
    if(interaction.type==='record')prompt=captionT>6?'':`${key} Read ${readNotes.has(interaction.item.id)?'case note again':'case note'}`;
        if(interaction.type==='exit')prompt=fuses===3?`${key} Start emergency release · alarm will sound`:`Exit needs ${3-fuses} more power ${fuses===2?'fuse':'fuses'}`;
  }else if([...roomLoot.filter(l=>automaticLoot(l.type)),...ammoBoxes].some(l=>!l.taken&&pickupReach(l,P.pos,2.4)))prompt='WALK OVER · ammunition collects automatically';
  else if(P.hidden)prompt='CONCEALED · Stay quiet. Listen for footsteps to fade.';
  else if(currentShelter())prompt='SHELTER · Close and lock the door. Crouch. Torch off.';
  else if(simulationTime<15)prompt='MAP · amber diamonds = fuses · green squares = shelters · red = exit';
  $('interactionPrompt').textContent=prompt;
  $('controlsHint').textContent=touch?'Left stick: move · Drag right: look · USE: interact':
    P.hidden?'E unlock & leave · Keep your torch off until the footsteps fade':
    mag===0?'R reload · Q switch weapon · V throw a noise decoy':
    P.running?'C while sprinting: slide · Release SHIFT to aim and fire':
    simulationTime<20?'WASD move · SHIFT sprint · C crouch · E use · F torch · M floor plan':'';
}
function stepSurvival(dt){
  simulationTime+=dt;updatePlayer(dt);updateRooms(dt);updateHorror(dt);updateThreats(dt);
  updateTorch(dt);updatePickups();markVisited();
  chaosStep(dt);
}
function loop(){
  requestAnimationFrame(loop);
  timer.update();const rawDt=timer.getDelta(),dt=Math.min(.05,rawDt);t+=dt;frame++;
  const sdt=dopaFrame(rawDt,dt);
  if(rawDt>0&&!document.hidden)frameAverage=lerp(frameAverage,Math.min(rawDt*1000,1000),.065);
  qualityTimer+=Math.min(rawDt,1);
  if(preferences.quality==='auto'&&state==='play'&&qualityTimer>6){
    qualityTimer=0;
    if(frameAverage>30&&qualityLevel==='high')applyQuality('medium');
    else if(frameAverage>38&&qualityLevel==='medium')applyQuality('low');
    else if(frameAverage>40&&qualityLevel==='low'&&renderScale>.56){renderScale=Math.max(.55,renderScale-.1);renderer.setPixelRatio(Math.min(devicePixelRatio||1,renderScale));}
  }
  if(state==='outside'){
    updatePlayer(dt);
    if(P.pos.x>-3.0&&Math.abs(P.pos.z-DZC)<2.4)startCutscene();
    birdT-=dt;if(birdT<=0){birdT=rnd(0.6,2.6);sBird();}
  }else if(state==='cutscene'){
    updateCutscene(dt);
    if(cs<3){birdT-=dt;if(birdT<=0){birdT=rnd(0.8,2.6);sBird();}}
  }else if(state==='play'){
    elapsed+=rawDt;stepSurvival(sdt);
    if(exitOpen&&NET.inGame&&P.pos.x>W*S+.6){coopLocalDone('out');}
    else if(exitOpen&&P.pos.x>W*S+.6){
      state='win';const m=Math.floor(elapsed/60),s=Math.floor(elapsed%60);
      const kills=monsters.filter((o,i)=>i<monCount&&o.dead).length;
      $('winText').textContent=`Cold air on your face. You got out in ${fmtTime(elapsed)}. Behind you, ${kills>=monCount?'nothing is walking any more':'something keeps walking'}.`;
      $('winRank').textContent='';
      showScreen('win');recordWin(elapsed,kills);try{document.exitPointerLock();}catch(e){}
      if(creatureAudio)creatureAudio.stop();if(droneGain)fadeTo(droneGain,0,2);mouseDown=false;
    }
    const strain=Math.max(danger,RULES.injuryLevel(P.health));
    heartT-=dt;if(strain>.15&&heartT<=0){heartT=1.25-strain*.65;sHeart(.06+strain*.16);}
    if(droneGain){const target=preferences.effects?.025+danger*.035+fuses*.006:.014;droneGain.gain.setTargetAtTime(target,AC.currentTime,1.2);}
    if(AC&&droneFilter)droneFilter.frequency.value=110+danger*260;
  }else if(state==='caught')updateCaught(dt);
  if(NET.inGame){
    if(state!=='play'&&state!=='caught'&&state!=='coopEnd'){elapsed+=rawDt;simulationTime+=dt;updateRooms(dt);updateThreats(dt);}
    netTick(dt);
  }
  if(state==='play'||state==='caught'||(NET.inGame&&state!=='coopEnd'))monsters.forEach(m=>animateMonster(m,sdt));
  updateGun(dt);updatePuffs(dt);
  if(luxOn){boxT-=dt;if(boxT<=0){boxT=0.46;sMusicBox();}}
  if(msgTimer>0){msgTimer-=dt;if(msgTimer<=0)$('msg').style.opacity=0;}

  // camera
  let shake=preferences.motion?shakeAmt:0;
  if(state==='play'&&preferences.motion){const md=nearestD;if(md<5)shake=Math.max(shake,(1-md/5)*.008);}
  if(state==='caught'&&preferences.motion)shake=.035;
  if(state==='spect'||(state==='pause'&&prevState==='spect')){
    camera.position.set(R.pos.x,(R.raw.y||0)+(R.raw.crouch?1:EYE),R.pos.z);camera.rotation.set(R.pitch,R.yaw,0);
  }else{
  camera.position.set(P.pos.x+rnd(-shake,shake),P.pos.y+P.eye+P.bob-P.landing+rnd(-shake,shake),P.pos.z);
  camera.rotation.y=P.yaw+rnd(-shake,shake)*.5;camera.rotation.x=P.pitch;camera.rotation.z=preferences.motion?lean+Math.sin(P.bobPhase*.5)*.003:0;
  }
  const desiredFov=aiming&&!reloadT&&!P.running?55:P.running&&preferences.motion?77:72;
  if(Math.abs(camera.fov-desiredFov)>.05){camera.fov=lerp(camera.fov,desiredFov,1-Math.exp(-dt*10));camera.updateProjectionMatrix();}
  torch.position.y=-0.27+P.bob*0.35;
  sky.position.copy(camera.position);
  sunSprite.position.copy(camera.position).addScaledVector(sunDir,400);
  for(const c of clouds)c.position.copy(camera.position).addScaledVector(c.userData.dir,420);
  updateListener();

  updateHealthVignette();
  $('danger').style.opacity=preferences.effects&&(state==='play'||state==='caught')?Math.min(.8,danger*.5+(state==='caught'?.3:0)):0;
  if(state==='play')$('flash').style.opacity=preferences.effects&&damageT>.7?Math.max(0,(damageT-.7)*.7):0;
  hudT-=dt;if(hudT<=0){hudT=.08;updateHUD();}
  if(state==='play'||state==='spect'){mapT-=dt;if(mapT<=0){mapT=.2;drawMap();}}
  if(preferences.effects&&qualityLevel!=='low'&&frame%6===0)drawGrain();
  camera.updateMatrixWorld();fpRig.position.copy(camera.position);fpRig.quaternion.copy(camera.quaternion);
  fpHemi.color.copy(hemi.color);fpHemi.groundColor.copy(hemi.groundColor);setLight(fpHemi,Math.max(.25,hemi.userData.level*.9));
  if(state==='play'||state==='spect'){
    for(const r of specialRooms)r.group.visible=Math.hypot(r.group.position.x-camera.position.x,r.group.position.z-camera.position.z)<38;
    for(const m of monsters)m.g.visible=!!m.spawned&&(!m.dead&&Math.hypot(m.pos.x-camera.position.x,m.pos.z-camera.position.z)<42||m.dead&&m.deadT<18&&Math.hypot(m.pos.x-camera.position.x,m.pos.z-camera.position.z)<25);
  }
  renderer.info.reset();
  if(['menu','pause','dead','win','coopEnd'].includes(state)&&!renderRequested&&lastRenderedState===state)return;
  renderRequested=false;lastRenderedState=state;
  // clear -> world -> clear depth -> viewmodel, expressed with auto-clear flags: an explicit clear()/clearDepth()
  // would add a full-screen output (tone-mapping) pass each. The world renders straight into the renderer's own HDR
  // frame buffer (internal to three r187), so tone mapping and sRGB output run once, after the viewmodel.
  const hdr=renderer.needsFrameBufferTarget&&typeof renderer._getFrameBufferTarget==='function'?renderer._getFrameBufferTarget():null;
  if(hdr)renderer.setRenderTarget(hdr);renderer.render(scene,camera);if(hdr)renderer.setRenderTarget(null);
  renderer.autoClearColor=false;renderer.render(fpScene,camera);renderer.autoClearColor=true;
  renderCalls=renderer.info.render.drawCalls;renderedFrames++;
}

/* ---------- co-op (two players over the live room) ---------- */
const NET={room:null,roomState:'loading',g:null,code:null,role:null,inGame:false,gen:0,seed:0,shots:0,tk:[],dm:[],myPeer:null,sendT:0,joinT:0,over:false,unsubs:[],actions:[],actionSeq:0,actionAck:0,claimed:new Set(),joining:false,joinToken:0};
const R={present:false,peer:null,nm:'Partner',gn:-1,al:1,out:0,sh:0,lastSh:0,tk:[],dm:[],dmApplied:[],ph:'',seed:0,mc:0,mon:null,
  raw:{x:0,z:0,y:0,yaw:0,pitch:0,torch:false,run:false,crouch:false,hidden:false},pos:new THREE.Vector3(),yaw:0,pitch:0,stepD:0,seen:false,actions:[],actionAck:0,grants:[]};
function seeded(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
function buildMazeSeeded(seed){worldSeed=seed;const o=Math.random;Math.random=seeded(seed);try{buildMaze();}finally{Math.random=o;}}
const r2=v=>Math.round(v*100)/100;

// partner's body in the world
const avatar=new THREE.Group();avatar.visible=false;scene.add(avatar);
let avLegL,avLegR,avPivot,avSpot,avFlash,avLabelTex,avLabelCv;
{const coat=new THREE.MeshStandardMaterial({color:lin(0x2a2f3d),roughness:0.9}),pants=new THREE.MeshStandardMaterial({color:lin(0x1b1c22),roughness:0.95});
 const body=new THREE.Mesh(new THREE.CylinderGeometry(0.22,0.2,0.75,10),coat);body.position.y=1.15;body.castShadow=true;avatar.add(body);
 const head=new THREE.Mesh(new THREE.SphereGeometry(0.13,12,10),skin);head.position.y=1.65;head.castShadow=true;avatar.add(head);
 const legGeo=new THREE.CylinderGeometry(0.08,0.07,0.8,8);legGeo.translate(0,-0.4,0);
 avLegL=new THREE.Mesh(legGeo,pants);avLegL.position.set(-0.1,0.8,0);avatar.add(avLegL);
 avLegR=new THREE.Mesh(legGeo,pants);avLegR.position.set(0.1,0.8,0);avatar.add(avLegR);
 avPivot=new THREE.Group();avPivot.position.y=1.42;avatar.add(avPivot);
 const rifle=new THREE.Mesh(new THREE.BoxGeometry(0.05,0.08,0.7),new THREE.MeshStandardMaterial({color:lin(0x1c1d20),metalness:0.6,roughness:0.5}));rifle.position.set(0.16,-0.05,-0.3);avPivot.add(rifle);
 const tl=new THREE.Mesh(new THREE.CylinderGeometry(0.03,0.03,0.18,8),new THREE.MeshStandardMaterial({color:lin(0x26272b)}));tl.rotation.x=Math.PI/2;tl.position.set(-0.18,0,-0.25);avPivot.add(tl);
 avSpot=physical(new THREE.SpotLight(0xfff1d6,0,22,0.42,0.55),5,0.5);avSpot.position.set(-0.18,0,-0.35);avPivot.add(avSpot);
 const tgt=new THREE.Object3D();tgt.position.set(-0.1,-0.2,-6);avPivot.add(tgt);avSpot.target=tgt;
 avFlash=physical(new THREE.PointLight(0xffb060,0,10),5,1);avFlash.position.set(0.16,0,-0.7);avPivot.add(avFlash);
 [avLabelCv]=cv(256,64);avLabelTex=new THREE.CanvasTexture(avLabelCv);
 const lab=new THREE.Sprite(new THREE.SpriteMaterial({map:avLabelTex,transparent:true,depthWrite:false,fog:false}));lab.scale.set(0.9,0.225,1);lab.position.y=2.05;avatar.add(lab);}
function setAvatarName(n){const x=avLabelCv.getContext('2d');x.clearRect(0,0,256,64);x.font='30px "Special Elite",monospace';x.textAlign='center';x.textBaseline='middle';
  x.fillStyle='rgba(0,0,0,.55)';const w=Math.min(250,x.measureText(n).width+24);x.fillRect(128-w/2,12,w,40);x.fillStyle='#9fc1ff';x.fillText(n,128,33);avLabelTex.needsUpdate=true;}

function sStepAt(x,z,vol){if(!AC)return;const n=AC.currentTime,p=makePanner(1.8,1.2);setPos(p,x,0.1,z);const s=noiseSrc(),f=AC.createBiquadFilter(),g=AC.createGain();
  f.type='lowpass';f.frequency.value=rnd(380,700);s.connect(f);f.connect(g);g.connect(p);env(g,n,0.006,vol,0.13);s.start(n,Math.random());s.stop(n+0.2);}
function sShotAt(x,z){if(!AC)return;const n=AC.currentTime,p=makePanner(3,0.9);setPos(p,x,1.5,z);const s=noiseSrc(),lp=AC.createBiquadFilter(),g=AC.createGain();
  lp.type='lowpass';lp.frequency.setValueAtTime(5000,n);lp.frequency.exponentialRampToValueAtTime(700,n+0.15);s.connect(lp);lp.connect(g);g.connect(p);g.connect(echoIn);env(g,n,0.002,0.9,0.17);s.start(n,Math.random());s.stop(n+0.25);
  const o=AC.createOscillator(),og=AC.createGain();o.frequency.setValueAtTime(140,n);o.frequency.exponentialRampToValueAtTime(45,n+0.14);o.connect(og);og.connect(p);env(og,n,0.002,0.7,0.16);o.start(n);o.stop(n+0.25);}

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
async function joinRoom(code,role){
  if(!NET.room){coopErr('Can’t reach the game server. Check your connection and try again.');return false;}
  if(NET.joining||NET.g)return false;
  const joinToken=++NET.joinToken;NET.joining=true;$('coopCreate').disabled=true;$('coopJoinForm').querySelector('button').disabled=true;
  coopErr(role==='host'?'Opening a game…':'Joining…');
  try{const joined=await NET.room.join('hollow-'+code);if(joinToken!==NET.joinToken){await joined.leave();return false;}NET.g=joined;}
  catch(e){if(joinToken===NET.joinToken){NET.g=null;coopErr(e&&e.code==='limit_reached'?'That game is full.':e&&e.code==='not_permitted'?'The game server refused the connection.':'Couldn’t connect. Try again in a moment.');}return false;}
  finally{if(joinToken===NET.joinToken){NET.joining=false;$('coopCreate').disabled=false;$('coopJoinForm').querySelector('button').disabled=false;}}
  NET.code=code;NET.role=role;NET.gen=0;NET.inGame=false;NET.joinT=performance.now();R.present=false;R.peer=null;
  NET.g.presence({v:2,nm:(playerName||'Guest').slice(0,18),role,ph:'lobby',gn:0}).catch(()=>{});
  NET.unsubs.push(NET.g.onPeers(onPeers,()=>{coopErr('The connection to the game was lost.');if(NET.inGame&&!NET.over)coopShowEnd('Connection lost','Your connection was interrupted. Return to the menu to reconnect.',true);}));
  coopErr('');$('coopChoose').hidden=true;$('coopLobby').hidden=false;$('coopCode').textContent=code;
  renderLobby();
  if(role==='guest')setTimeout(()=>{if(joinToken===NET.joinToken&&NET.g&&NET.role==='guest'&&!R.present)coopErr('No game found with that code yet. Check the code, or wait for the host to open it.');},7000);
  return true;
}
async function leaveRoom(){
  NET.joinToken++;NET.joining=false;$('coopCreate').disabled=false;$('coopJoinForm').querySelector('button').disabled=false;
  NET.unsubs.forEach(u=>{try{u();}catch(e){}});NET.unsubs=[];
  const oldRoom=NET.g;
  NET.g=null;NET.inGame=false;NET.role=null;R.present=false;avatar.visible=false;avSpot.visible=avFlash.visible=false;
  if(oldRoom){try{await oldRoom.leave();}catch(e){}}
}
function onPeers(ch){
  const peers=ch.peers;const me=peers.find(p=>p.sameTab);if(me)NET.myPeer=me.peer;
  let partner=null;
  if(NET.role==='host'){partner=peers.find(p=>!p.sameTab&&p.presence&&p.presence.role==='guest'&&p.peer===R.peer)||peers.find(p=>!p.sameTab&&p.presence&&p.presence.role==='guest');}
  else{partner=peers.find(p=>!p.sameTab&&p.presence&&p.presence.role==='host');}
  const was=R.present;
  if(!partner){R.present=false;
    if(was){partnerLeft();}
    renderLobby();return;}
  const pr=partner.presence;
  if(NET.role==='guest'&&pr.pt&&NET.myPeer&&pr.pt!==NET.myPeer){R.present=false;coopErr('That game already has two players.');renderLobby();return;}
  R.present=true;
  if(NET.role==='host'&&R.peer!==partner.peer){R.actionAck=0;R.actions=[];R.grants=[];R.dmApplied=new Array(MAX_MON).fill(0);R.lastSh=0;R.seen=false;if(NET.g)NET.g.presence({pt:partner.peer}).catch(()=>{});}
  R.peer=partner.peer;
  R.nm=String(pr.nm||'Partner').slice(0,18);if(R.nm!==R.lastNm){R.lastNm=R.nm;setAvatarName(R.nm);}
  R.gn=Math.floor(finiteNumber(pr.gn,0,0,1e9));R.al=pr.al===0?0:1;R.out=pr.out?1:0;R.ph=typeof pr.ph==='string'?pr.ph:'';
  if(Array.isArray(pr.p)){R.raw.x=finiteNumber(pr.p[0],R.raw.x,-110,W*S+60);R.raw.z=finiteNumber(pr.p[1],R.raw.z,-70,W*S+70);R.raw.yaw=finiteNumber(pr.p[2],R.raw.yaw);R.raw.pitch=finiteNumber(pr.p[3],R.raw.pitch,-1.35,1.35);R.raw.torch=!!pr.p[4];R.raw.run=!!pr.p[5];R.raw.y=finiteNumber(pr.p[6],0,0,H);R.raw.crouch=!!pr.p[7];R.raw.hidden=!!pr.p[8];R.raw.health=finiteNumber(pr.p[9],100,0,100);R.raw.weapon=Math.floor(finiteNumber(pr.p[10],0,0,2));
    if(!R.seen){R.pos.set(R.raw.x,0,R.raw.z);R.yaw=R.raw.yaw;R.pitch=R.raw.pitch;R.seen=true;}}
  R.sh=finiteNumber(pr.sh,0,0);R.tk=Array.isArray(pr.tk)?pr.tk.filter(i=>Number.isInteger(i)&&i>=0&&i<ammoBoxes.length):[];R.dm=Array.isArray(pr.dm)?pr.dm.slice(0,MAX_MON).map(v=>finiteNumber(v,0,0)):[];R.actions=Array.isArray(pr.actions)?pr.actions.slice(0,32):[];
  if(NET.role==='guest'){R.mon=Array.isArray(pr.mon)?pr.mon.slice(0,MAX_MON).map(v=>Array.isArray(v)&&v.length>=4&&v.slice(0,4).every(Number.isFinite)?[finiteNumber(v[0],0,-110,W*S+60),finiteNumber(v[1],0,-70,W*S+70),finiteNumber(v[2],0),Math.floor(v[3])&15,finiteNumber(v[4],0,-100,100)]:null):null;R.mc=Math.floor(finiteNumber(pr.mc,0,0,MAX_MON));R.el=finiteNumber(pr.el,0,0,7200);
    // host started (or restarted) a round we're not in yet
    const remoteSeed=finiteNumber(pr.seed,0,0,2147483647);
    if(pr.ph==='play'&&R.gn>NET.gen&&remoteSeed){startCoopRound(remoteSeed,R.gn);}
    if(R.gn===NET.gen&&NET.inGame){
      if(Array.isArray(pr.doors))pr.doors.forEach((v,i)=>{const d=roomDoors[i];if(!d||!Array.isArray(v))return;d.open=!!v[0];d.locked=!!v[1];d.health=Math.max(0,Math.min(100,Number(v[2])||0));});
      if(Array.isArray(pr.fuses))for(const l of roomLoot)if(l.type==='fuse'&&pr.fuses.includes(l.id)){l.taken=true;l.g.visible=false;}
      if(Array.isArray(pr.loot))for(const l of roomLoot)if(pr.loot.includes(l.id)){l.taken=true;l.g.visible=false;}
      if(Array.isArray(pr.grants))for(const grant of pr.grants){if(grant&&typeof grant.id==='string'&&!NET.claimed.has(grant.id)&&['ammo','medical','supplies'].includes(grant.type)){NET.claimed.add(grant.id);rewardLoot(grant.type);sPickup();}}
      fuses=roomLoot.filter(l=>l.type==='fuse'&&l.taken).length;exitPowered=!!pr.power;
            exitRelease=finiteNumber(pr.release,exitPowered?HollowHorror.RELEASE_SECONDS:0,0,HollowHorror.RELEASE_SECONDS);exitOpen=exitPowered&&pr.exitOpen===1;
      const ack=Number(pr.ack)||0;NET.actions=NET.actions.filter(a=>a.n>ack);for(const item of [...ammoBoxes,...roomLoot])if(item.pending&&item.pending<=ack)item.pending=false;
    }
    if(pr.ph==='lobby'&&NET.inGame&&state==='coopEnd'){$('ceWait').textContent=`Waiting for ${R.nm} to start another round.`;}
  }
  if(!was){R.lastSh=R.sh;if(NET.inGame)showMsg(`${R.nm} is here.`,2.5);}
  if(!NET.inGame)renderLobby();
}
function partnerLeft(){
  if(NET.inGame&&state!=='coopEnd'){
    if(NET.role==='guest'){coopShowEnd('The host left','The game ended because the host left. You can open a new game from the menu.',true);}
    else showMsg(`${R.nm} left the game. You’re on your own.`,4);
  }else if(NET.inGame&&state==='coopEnd'&&NET.role==='guest'){$('ceWait').textContent='The host left the game.';$('ceAgain').hidden=true;}
}
function renderLobby(){
  if(!NET.g)return;
  const ul=$('coopPlayers');ul.textContent='';
  const add=(name,tag)=>{const li=document.createElement('li');li.textContent=name;const sp=document.createElement('span');sp.textContent=tag;li.appendChild(sp);ul.appendChild(li);};
  add(playerName||'Guest',NET.role==='host'?'you · host':'you');
  if(R.present)add(R.nm,NET.role==='host'?'partner':'host');
  else{const li=document.createElement('li');li.style.color='var(--ash)';li.textContent=NET.role==='host'?'Waiting for your partner to join…':'Looking for the host…';ul.appendChild(li);}
  $('coopStartRow').hidden=NET.role!=='host';
  $('coopStart').disabled=!R.present;
  if(NET.role==='guest'&&R.present&&!NET.inGame)coopErr(`Connected. Waiting for ${R.nm} to start the game.`);
}
function hostStart(){
  if(NET.role!=='host'||!R.present)return;
  const seed=1+Math.floor(Math.random()*2e9);
  startCoopRound(seed,NET.gen+1);
}
function startCoopRound(seed,gen){
  initAudio();
  NET.gen=gen;NET.seed=seed;NET.inGame=true;NET.over=false;NET.myAl=true;NET.myOut=false;NET.shots=0;NET.tk=[];NET.dm=new Array(MAX_MON).fill(0);
  avSpot.visible=true;avFlash.visible=qualityLevel!=='low';
  NET.actions=[];NET.actionSeq=0;NET.actionAck=0;NET.claimed.clear();R.actions=[];R.actionAck=0;R.grants=[];
  R.dmApplied=new Array(MAX_MON).fill(0);R.lastSh=R.gn===gen?R.sh:0;R.seen=false;
  buildMazeSeeded(seed);resetSurvivor();
  P.vel.set(0,0,0);P.velY=0;P.onGround=true;P.stamina=1;P.exhausted=false;P.bob=0;
  battery=1;elapsed=0;danger=0;ambientT=14;heartT=0;$('flash').style.opacity=0;
  visited=new Uint8Array(W*W);
  setHell();P.pos.set(PED.x-.85,0,PED.z+(NET.role==='host'?-.8:.8));P.yaw=Math.PI/2;P.pitch=0;grace=10;
  if(NET.role==='host')spawnMonsters(12);else{hideMonsters();monCount=12;}
  if(droneGain)fadeTo(droneGain,0.07,1);stopOutdoor();luxOn=false;
  state='play';showScreen(null);lock();
  sendNet(true);
  showMsg(NET.role==='guest'&&!IS_TOUCH&&document.pointerLockElement!==canvas?'The game started. Click the screen to take control.':'Recover the fuses together. Twelve threats are hunting.',5);
}
function coopLocalDone(how){
  NET.myAl=how!=='dead';NET.myOut=how==='out';
  mouseDown=false;setLight(spot,0);setLight(bounce,0);setLight(fpTorchLight,0);setLight(muzzleLight,0);
  torch.visible=false;gun.visible=false;gunOut=false;$('flash').style.opacity=0;
  sendNet(true);
  const partnerIn=R.present&&R.gn===NET.gen&&R.al&&!R.out;
  if(partnerIn){state='spect';
    showMsg(how==='out'?`You’re out. Watching ${R.nm} through their eyes.`:`You’re dead. Watching ${R.nm} through their eyes.`,5);}
  else coopFinish();
}
function coopFinish(){
  if(NET.over)return;NET.over=true;
  const meOut=!!NET.myOut,themOut=R.present&&R.gn===NET.gen&&!!R.out,haveP=R.present;
  let title,text;
  if(meOut&&themOut){title='Outside';text=`You both made it out in ${fmtTime(elapsed)}. Behind you, something keeps walking.`;}
  else if(meOut){title='Outside';text=haveP?`You made it out. ${R.nm} didn’t.`:'You made it out alone.';}
  else if(themOut){title='Left behind';text=`${R.nm} made it out. You didn’t.`;}
  else{title='It found you both';text='The corridors are quiet again.';}
  coopShowEnd(title,text,false);
}
function coopShowEnd(title,text,hostGone){
  state='coopEnd';NET.over=true;if(creatureAudio)creatureAudio.stop();
  if(droneGain)fadeTo(droneGain,0,2);
  $('ceTitle').textContent=title;$('ceTitle').className='title'+(title.startsWith('It found')||title.startsWith('Left')?' red':'');
  $('ceText').textContent=text;
  $('ceAgain').hidden=NET.role!=='host'||hostGone;
  $('ceWait').textContent=hostGone?'':NET.role==='host'?(R.present?'':'Your partner left.'):`Waiting for ${R.nm} to start another round.`;
  showScreen('coopEnd');try{document.exitPointerLock();}catch(e){}
  if(NET.role==='host'&&NET.g)NET.g.presence({ph:'lobby'}).catch(()=>{});
}
function sendNet(force){
  if(!NET.g)return;
  const now=performance.now();if(!force&&now-NET.sendT<67)return;NET.sendT=now;
  const alive=state==='play'||state==='caught'||(state==='pause'&&prevState==='play');
  const pk={gn:NET.gen,ph:NET.inGame&&!NET.over?'play':'lobby',p:[r2(P.pos.x),r2(P.pos.z),r2(P.yaw),r2(P.pitch),torchOn?1:0,P.running?1:0,r2(P.pos.y),P.crouching?1:0,P.hidden?1:0,Math.round(P.health),weaponIndex],
    al:NET.myAl===false?0:1,out:NET.myOut?1:0,sh:NET.shots,tk:NET.tk.slice(0,32)};
  if(NET.role==='guest'){pk.dm=NET.dm.slice(0,MAX_MON).map(r2);pk.actions=NET.actions.slice(0,12);}
  if(NET.role==='host'){pk.seed=NET.seed;pk.mc=monCount;pk.el=r2(elapsed);pk.pt=R.peer||null;
    pk.mon=monsters.slice(0,monCount).map(m=>[r2(m.pos.x),r2(m.pos.z),r2(m.yaw),(m.state==='chase'?1:0)|(m.dead?2:0)|(m.stagger>0?4:0)|(m.state==='stalk'?8:0),r2(m.hp)]);
    pk.doors=roomDoors.map(d=>[d.open?1:0,d.locked?1:0,Math.round(d.health)]);pk.fuses=roomLoot.filter(l=>l.type==='fuse'&&l.taken).map(l=>l.id);pk.power=exitPowered?1:0;pk.release=r2(exitRelease);pk.exitOpen=exitOpen?1:0;pk.ack=R.actionAck;
    pk.loot=roomLoot.filter(l=>l.taken).map(l=>l.id);pk.grants=R.grants;
  }
  NET.g.presence(pk).catch(()=>{});
}
function guestMonsters(dt){
  let target=0;nearestD=99;
  if(!R.present||R.gn!==NET.gen||!R.mon){danger*=0.98;return;}
  monCount=R.mc||12;
  for(let i=0;i<MAX_MON;i++){const m=monsters[i],d=R.mon[i];
    if(!d||i>=monCount){m.g.visible=false;m.dead=true;continue;}
    const [x,z,yaw,fl,hp]=d;const dead=!!(fl&2),chase=!!(fl&1),stalk=!!(fl&8);m.hp=Number(hp)||0;m.attackT=Math.max(0,m.attackT-dt);m.lungeT=Math.max(0,m.lungeT-dt);
    if(m.dead&&!dead){m.spawned=true;m.g.visible=true;m.dead=false;m.deadT=0;m.pos.set(x,0,z);m.yaw=yaw;m.g.rotation.set(0,yaw,0);m.g.userData.eyeMat.color.setHex(m.g.userData.eyeColor||0xff2a14);m.state='wander';m.voiceT=rnd(2,6);m.stepT=rnd(.2,.8);m.lungeT=0;m.spotCD=0;m.stagger=0;}
    if(dead&&!m.dead){m.dead=true;m.deadT=0;m.g.userData.eyeMat.color.set(0x120000);m.g.userData.glow.intensity=0;sCreature(m,'death');
      const left=R.mon.slice(0,monCount).filter(q=>q&&!(q[3]&2)).length;showMsg(left?`It went down. ${left} still walking.`:'It went down. The corridors are silent.',3);}
    if(m.dead){if(m.g.visible){m.deadT+=dt;const k=ease(0,0.8,m.deadT);m.g.rotation.x=-1.5*k;m.g.position.y=0.15*k;}continue;}
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
function netTick(dt){
  // partner avatar + sounds
  if(R.present&&R.gn===NET.gen&&R.seen){
    const k=Math.min(1,dt*22),ox=R.pos.x,oz=R.pos.z;
    R.pos.x+=(R.raw.x-R.pos.x)*k;R.pos.z+=(R.raw.z-R.pos.z)*k;R.yaw=angLerp(R.yaw,R.raw.yaw,k);R.pitch+=(R.raw.pitch-R.pitch)*k;
    const moved=Math.hypot(R.pos.x-ox,R.pos.z-oz);
    const show=R.al&&!R.out&&state!=='spect'&&!(state==='pause'&&prevState==='spect');
    avatar.visible=!!show;avatar.position.set(R.pos.x,R.raw.y||0,R.pos.z);avatar.scale.y=R.raw.crouch?.65:1;avatar.rotation.y=R.yaw;avPivot.rotation.x=R.pitch;
    R.walk=(R.walk||0)+moved*3.2;avLegL.rotation.x=Math.sin(R.walk)*0.5;avLegR.rotation.x=-Math.sin(R.walk)*0.5;
    setLight(avSpot,R.al&&!R.out&&R.raw.torch?2.4:0);
    R.stepD+=moved;if(R.stepD>(R.raw.run?1.1:0.75)){R.stepD=0;if(R.al&&!R.out)sStepAt(R.pos.x,R.pos.z,R.raw.run?0.3:0.13);}
    if(R.sh>R.lastSh){const n=Math.min(3,R.sh-R.lastSh);R.lastSh=R.sh;for(let q=0;q<n;q++)setTimeout(()=>sShotAt(R.pos.x,R.pos.z),q*90);setLight(avFlash,preferences.effects?2.5:0);
      if(NET.role==='host')alertMonsters(weaponDefs[R.raw.weapon]?.noise||30,R.raw.x,R.raw.z);}
    setLight(avFlash,avFlash.userData.level*Math.max(0,1-dt*30));
    // ammo boxes the partner took
    for(const ix of R.tk){const b=ammoBoxes[ix];if(b&&!b.taken){b.taken=true;b.g.visible=false;}}
    // host applies the partner's hits
    if(NET.role==='host'){for(let i=0;i<monCount;i++){const tot=Number(R.dm[i])||0,d=tot-(R.dmApplied[i]||0);if(d>0){R.dmApplied[i]=tot;hitMonster(monsters[i],Math.min(d,30),{x:R.raw.x,z:R.raw.z});}}}
    if(NET.role==='host')for(const a of R.actions){
      if(!a||!Number.isInteger(a.n)||a.n<=R.actionAck)continue;R.actionAck=a.n;
      if(a.type==='door'){
        const d=roomDoors.find(d=>d.id===a.id);if(!d||Math.hypot(d.box.x-R.raw.x,d.box.z-R.raw.z)>3.5)continue;
        const inside=RULES.insideRoom(d.room,R.raw.x,R.raw.z);
        if(a.action==='lock'&&!inside||a.action==='open'&&d.locked&&!inside)continue;
        if(['open','close','lock'].includes(a.action))doorAction(d,a.action);
      }else if(a.type==='loot'||a.type==='fuse'){
        const l=roomLoot.find(l=>l.id===a.id);if(!l||l.taken||Math.hypot(l.x-R.raw.x,l.z-R.raw.z)>3||!los(R.raw.x,R.raw.z,l.x,l.z))continue;
        if(automaticLoot(l.type)&&!pickupReach(l,R.raw,1.6))continue;
        if(l.type==='fuse')collectLoot(l);
        else if(l.type!=='medical'||R.raw.health<100){l.taken=true;l.g.visible=false;R.grants.push({id:l.id,type:l.type});showMsg(`${R.nm} collected ${l.type==='medical'?'a medical kit':'supplies'}.`,2);}
      }else if(a.type==='ammo'){
        const b=Number.isInteger(a.id)&&a.id>=0&&a.id<ammoBoxes.length?ammoBoxes[a.id]:null;if(b&&!b.taken&&pickupReach(b,R.raw,1.6)){b.taken=true;b.g.visible=false;NET.tk.push(a.id);R.grants.push({id:'ammo:'+a.id,type:'ammo'});}
      }else if(a.type==='exit'&&Math.hypot(R.raw.x-(W-1)*S,R.raw.z-((W-2)*S+S/2))<3.5)powerExit();
      else if(a.type==='decoy'&&Number.isFinite(a.x)&&Number.isFinite(a.z)&&Math.hypot(a.x-R.raw.x,a.z-R.raw.z)<12)decoyEvents.push({x:a.x,z:a.z,remaining:5,pulse:0});
    }
  }else avatar.visible=false;
  // spectating: partner's torch is the light we see by
  if(state==='spect'){avatar.visible=false;setLight(spot,R.raw.torch&&R.al?2.6:0);}
  // round over?
  if(!NET.over&&NET.inGame){
    const meDone=(state==='spect'||state==='coopEnd'||NET.myAl===false||NET.myOut)&&state!=='play'&&state!=='caught';
    const themDone=!R.present||(R.gn===NET.gen&&(!R.al||R.out));
    if(meDone&&themDone)coopFinish();
    else if(state==='spect'&&R.present&&R.gn===NET.gen&&(!R.al||R.out))coopFinish();
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
$('ceAgain').addEventListener('click',()=>{if(R.present)hostStart();else $('ceWait').textContent='Your partner left. Open a new game from the menu.';});
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
function openMenu(){state='menu';$('whoName').textContent=playerName||'Guest';showScreen('menu');renderBoards();}

let localScores=[];try{localScores=JSON.parse(lsGet(LS_SCORES)||'[]');if(!Array.isArray(localScores))localScores=[];}catch(e){localScores=[];}
localScores=localScores.map(cleanRow).filter(Boolean);
let sharedRows=null,sharedState='loading',myId=null,canPost=null,lastMine=null,scoresCol=null,amOwner=false;
// ===== I1b: chaos, streaks, HUDFX =====
// Chaos director (practical lights that stutter, surge and black out, emergency mood, beacons, scare cues), kill
// streaks, hitstop and the HUDFX layer. Existing code calls in through one-line hooks only: chaosWorldBuilt
// (buildRooms), chaosLightsRefreshed (refreshRoomLights), chaosStep (stepSurvival), dopaFrame (loop; returns the
// hitstop-scaled simulation dt), dopaShotBegin/dopaShotHit/dopaShotEnd (fire), dopaHurt (damagePlayer), dopaSnapshot.
const chaos=HollowChaos.create(worldSeed),streak=HollowChaos.createStreak({effects:preferences.effects});
const hud=HollowHUDFX.create({root:$('hud'),document,motion:preferences.motion,effects:preferences.effects,touch:dopaTouch()});
const HITSTOP_SCALE=.08,EMERGENCY_RED=lin(0xff2414),SPARK_DOWN=new THREE.Vector3(0,-1,0);
let hitstopT=0,chaosLive=false;
// chaos.beacon(0..1), refreshed every simulation step for the emergency beacons. TODO(I3 visuals): atmosphere beacons read these.
const beacons=[chaos.beacon(0),chaos.beacon(1)];
const chaosIn={active:false,danger:0,chasers:0,nearest:99,alarm:false,sheltered:false,effects:true,health:100,lights:0,yaw:0,cue:false};
const dopa={state:'',motion:preferences.motion,effects:preferences.effects,touch:dopaTouch(),snap:chaos.snapshot(),
  hEvents:0,hFuses:0,fuses:0,powered:false,open:false,chasers:0,chaseT:-1e9,lostT:-1e9,emergency:0,shock:0,hemi:-1,
  live:null,liveBase:.45,liveColor:new THREE.Color(),livePhase:0,shot:{id:0,hits:0,head:false,list:[]},
  hitstops:0,lastHitstop:0,kills:0,lastKill:null,damage:null,damageHits:0};
function dopaTouch(){return !!(controls?controls.touch:IS_TOUCH);}
function dopaTrauma(amount){const rig=typeof camFX!=='undefined'?camFX:null;if(rig&&typeof rig.addTrauma==='function')rig.addTrauma(amount);}
function chaosWorldBuilt(ward){
  chaos.reset(worldSeed);streak.reset();hud.clear();hitstopT=0;chaosLive=false;chaosHemiRestore();chaosBeacons();
  const h=horror.snapshot();dopa.hEvents=h.events;dopa.hFuses=h.fuses;dopa.snap=chaos.snapshot();
  dopa.fuses=fuses;dopa.powered=exitPowered;dopa.open=exitOpen;dopa.chasers=0;dopa.chaseT=dopa.lostT=-1e9;dopa.emergency=dopa.shock=0;
  dopa.hitstops=dopa.lastHitstop=dopa.kills=dopa.damageHits=0;dopa.lastKill=dopa.damage=null;
  for(const m of monsters){m.dopaHitT=-1e9;m.dopaHead=false;m.dopaDown=!!m.dead;m.dopaShot=-1;}
  for(const l of practicalLights){l.userData.base=undefined;l.userData.shelter=false;}
  // The shared ward:live strip material (re-armed by decorateWard on every build) flickers with light channel 0.
  let live=ward&&ward.userData.liveMaterial||null;
  if(!live&&ward)ward.traverse(o=>{if(live||!o.isMesh)return;for(const m of Array.isArray(o.material)?o.material:[o.material])if(m&&m.emissive&&m.emissiveIntensity>0&&m.emissive.r+m.emissive.g+m.emissive.b>0){live=m;break;}});
  dopa.live=live;if(live){dopa.liveBase=live.emissiveIntensity;dopa.liveColor.copy(live.emissive);}
  const practicals=ward&&ward.userData.practicals;dopa.livePhase=practicals&&practicals.length?practicals[0].phase:0;
}
function chaosLightsRefreshed(nearest){
  practicalLights.forEach((l,i)=>{const u=l.userData,info=nearest[i];u.base=u.level;u.shelter=!!(info&&info.shelter);u.phase=info?info.phase:undefined;(u.tint||(u.tint=new THREE.Color())).copy(l.color);});
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
    hud.banner(dopa.chasers>1?'THEY SEE YOU':'IT SEES YOU',{tone:'danger',duration:1.6});dopaTrauma(.25);
    // TODO(I2 audio): chase stinger and music bed.
  }else if(e.type==='chaseEnd'){
    if(simulationTime-dopa.chaseT-HollowChaos.LIMITS.chaseEndHold>4&&simulationTime-dopa.lostT>30){dopa.lostT=simulationTime;hud.banner('YOU LOST IT',{tone:'info',duration:1.8});}
    // TODO(I2 audio): fade the chase bed.
  }else if(e.type==='surge'){
    dopa.shock=Math.max(dopa.shock,.3*(e.intensity||0));
    // TODO(I2 audio): surge zap. TODO(I3 visuals): postfx surge follows chaos.snapshot().surgeLevel (chaosVisuals).
  }else if(e.type==='blackout'){
    dopa.shock=Math.max(dopa.shock,.5);
    // TODO(I2 audio): breaker thunk. TODO(I3 visuals): postfx blackout follows blackoutLevel (chaosVisuals).
  }else if(e.type==='sparks'){
    chaosSparks(e);
    // TODO(I2 audio): spark crackle at e.x/e.y/e.z.
  }else if(HollowChaos.SCARES.includes(e.type)){
    if(e.type==='slam')dopaTrauma(.35);
    dopa.shock=Math.max(dopa.shock,e.type==='slam'||e.type==='scream'?.5:.25);
    chaosCaption(e);
    // TODO(I2 audio): scare voice cue (scream, slam, whisper, laugh) at e.x/e.z.
  }
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
function chaosSparks(e){
  const l=e.light!=null?practicalLights[e.light]:null;let x,z;
  if(l&&l.userData.level>0&&!l.userData.shelter){x=l.position.x;z=l.position.z;}
  else{let near=Infinity;for(const f of roomLights){if(f.shelter)continue;const d=Math.hypot(f.x-P.pos.x,f.z-P.pos.z);if(d<near){near=d;x=f.x;z=f.z;}}}
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
  dopa.shock=Math.max(0,dopa.shock-rawDt*1.6);
  let sdt=dt;
  if(NET.inGame||state!=='play')hitstopT=0;
  else if(hitstopT>0){const frozen=Math.min(dt,hitstopT);hitstopT-=frozen;sdt=dt-frozen*(1-HITSTOP_SCALE);}
  chaosVisuals();
  return sdt;
}
function dopaObjectives(){
  if(fuses!==dopa.fuses){if(fuses>dopa.fuses)hud.banner(`FUSE ${fuses}/3`,{tone:'objective',kicker:fuses>=3?'All fuses · reach the exit':'Power fuse'});dopa.fuses=fuses;}
  if(exitPowered!==dopa.powered){if(exitPowered)hud.banner('POWER RESTORED',{tone:'objective',kicker:'Shutter releasing'});dopa.powered=exitPowered;}
  if(exitOpen!==dopa.open){if(exitOpen)hud.banner('SHUTTER OPEN · RUN',{tone:'objective',duration:2.8});dopa.open=exitOpen;}
}
// One marker, one streak hit and at most one hitstop per shot, however many pellets land. fire() never targets a
// dead monster, so a monster hit by this shot that is dead at the end of it was killed by it.
function dopaShotBegin(){const s=dopa.shot;s.id++;s.hits=0;s.head=false;s.list.length=0;}
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
  for(const m of s.list)if(m.dead){m.dopaResult=dopaKill(m,m.dopaShotHead,m.dopaDist);result=m.dopaResult;}
  if(typeof audioOnHit==='function')audioOnHit({m:killed||s.list[0],headshot:s.head,kill:!!killed,armored:armored&&!killed,result});
  if(typeof audioOnKill==='function')for(const m of s.list)if(m.dead)audioOnKill({m,headshot:!!m.dopaShotHead,kill:true,armored:false,result:m.dopaResult});
}
function dopaKill(m,headshot,distance){
  const r=streak.kill(simulationTime,{headshot:!!headshot,kind:m.kind,distance,effects:preferences.effects});
  hud.kill({...r,kind:m.kind,headshot:!!headshot});hud.score(streak.snapshot().points);dopaHitstop(r.hitstop);
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
    const r=dopaKill(m,m.dopaHead,m.dopaDist);
    if(typeof audioOnKill==='function')audioOnKill({m,headshot:!!m.dopaHead,kill:true,armored:false,result:r});
  }
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
      damage:dopa.damage,damageHits:dopa.damageHits,liveEmissive:dopa.live?dopa.live.emissiveIntensity:null,liveBase:dopa.liveBase}};
}
function fnv(str){let h=0x811c9dc5;for(let i=0;i<str.length;i++){h^=str.charCodeAt(i);h=Math.imul(h,0x01000193)>>>0;}return h.toString(36);}
function encodeResult(r){const j=JSON.stringify({n:r.name,t:r.time,k:r.kills,a:r.at});const b=btoa(unescape(encodeURIComponent(j))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');return 'HOLLOW-'+b+'-'+fnv('hollow|'+j);}
function decodeResult(code){
  const m=String(code).trim().match(/^HOLLOW-([A-Za-z0-9_-]+)-([a-z0-9]+)$/);if(!m)return null;
  try{let b=m[1].replace(/-/g,'+').replace(/_/g,'/');while(b.length%4)b+='=';const j=decodeURIComponent(escape(atob(b)));
    if(fnv('hollow|'+j)!==m[2])return null;const o=JSON.parse(j);return cleanRow({name:o.n,time:o.t,kills:o.k,at:o.a});}catch(e){return null;}
}
function localBest(){const mine=localScores.map(cleanRow).filter(r=>r&&(!playerName||r.name===playerName)).sort((a,b)=>a.time-b.time);return mine[0]||null;}
function copyCode(codeEl,btn){const txt=codeEl.textContent;
  const done=()=>{btn.textContent='Copied';setTimeout(()=>btn.textContent='Copy code',1600);};
  const sel=()=>{try{const r=document.createRange();r.selectNodeContents(codeEl);const s=getSelection();s.removeAllRanges();s.addRange(r);btn.textContent='Press Ctrl+C';}catch(e){}};
  try{navigator.clipboard.writeText(txt).then(done,sel);}catch(e){sel();}}
function updateShare(){
  const posting=sharedRows!==null&&canPost!==false;
  const best=localBest();
  const onBoard=best&&sharedRows&&sharedRows.some(r=>r.name===best.name&&r.time<=best.time);
  const show=!posting&&sharedState!=='loading'&&best&&!onBoard;
  $('menuShare').hidden=!show;if(show)$('menuCode').textContent=encodeResult(best);
  $('importForm').hidden=!(amOwner&&scoresCol);
}
function cleanRow(r){if(!r||typeof r!=='object')return null;const time=Number(r.time);if(!isFinite(time)||time<=0)return null;
  return {name:String(r.name||'Someone').slice(0,18),time,kills:Math.max(0,Math.min(12,Number(r.kills)||0)),at:Number(r.at)||0,uid:r.uid||null,imported:!!r.imported};}
function renderBoards(){
  const shared=sharedRows!==null;
  const all=(shared?sharedRows:localScores.map(cleanRow).filter(Boolean)).slice().sort((a,b)=>a.time-b.time);
  const isMine=r=>shared?((myId&&r.uid===myId)||(r.imported&&playerName&&r.name===playerName)):(playerName&&r.name===playerName);
  const myIdx=all.findIndex(isMine);
  const top=all.slice(0,10);
  const mkRow=(r,rank)=>{const li=document.createElement('li');if(isMine(r)&&rank===myIdx+1)li.className='me';
    const cells=[['rk',String(rank)],['nm',r.name],['tm',fmtTime(r.time)],['kl',r.kills?r.kills+(r.kills===1?' kill':' kills'):'no kills']];
    for(const [c,t] of cells){const sp=document.createElement('span');sp.className=c;sp.textContent=t;li.appendChild(sp);}return li;};
  document.querySelectorAll('.board').forEach(b=>{
    b.querySelector('.boardScope').textContent=sharedState==='loading'?'Loading':shared?'All players':'This browser';
    const mine=b.querySelector('.boardMine');mine.textContent='';
    if(playerName&&sharedState!=='loading'){
      if(myIdx>=0){mine.append('Your best: ');const bb=document.createElement('b');bb.textContent='#'+(myIdx+1);mine.append(bb,` of ${all.length} · ${fmtTime(all[myIdx].time)}`);}
      else{const lb=localBest();mine.textContent=lb?`Your best on this browser: ${fmtTime(lb.time)} \u2014 not on the shared board yet.`:`${playerName}, you haven\u2019t escaped yet.`;}
    }
    const ol=b.querySelector('.boardList');ol.textContent='';
    if(!all.length){const p=document.createElement('p');p.className='empty';p.textContent='Nobody has escaped yet. Be the first.';ol.appendChild(p);}
    top.forEach((r,i)=>ol.appendChild(mkRow(r,i+1)));
    if(myIdx>=10){const g=document.createElement('li');g.className='gap';g.textContent='⋮';ol.appendChild(g);ol.appendChild(mkRow(all[myIdx],myIdx+1));}
    let foot='';
    if(shared&&canPost===false)foot='Only the owner\u2019s account can post directly. Other players send the owner a result code from the win screen or main menu.';
    else if(!shared&&sharedState==='none')foot='Times are saved on this browser.';
    else if(shared)foot='Each player’s best time is kept.';
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
    scoresCol.orderBy('time','asc').limit(50).onSnapshot(snap=>{
      sharedState='live';
      sharedRows=snap.docs.map(d=>{const r=cleanRow(d.data()||{});if(r&&!r.uid)r.uid=d.id;return r;}).filter(Boolean);
      renderBoards();
    },()=>{sharedState='none';sharedRows=null;renderBoards();});
  }catch(e){sharedState='none';renderBoards();}
}
async function recordWin(time,kills){
  const row={name:playerName||'Guest',time:Math.round(time*10)/10,kills,at:Date.now()};
  lastMine=row;localScores.push(row);localScores.sort((a,b)=>a.time-b.time);localScores=localScores.slice(0,50);lsSet(LS_SCORES,JSON.stringify(localScores));
  const rankIn=list=>list.slice().sort((a,b)=>a.time-b.time).findIndex(r=>r===row||(r.at===row.at&&r.time===row.time))+1;
  let note='';
  if(scoresCol&&myId&&canPost!==false){
    try{
      const ref=scoresCol.doc(myId),cur=sharedRows&&sharedRows.find(r=>r.uid===myId);
      if(!cur||row.time<cur.time||cur.name!==row.name){
        const best=cur&&cur.time<row.time?cur.time:row.time;
        await ref.set({name:row.name,time:best,kills:best===row.time?kills:cur.kills,at:best===row.time?row.at:cur.at,uid:myId});
      }
      if(cur&&cur.time<row.time)note=`Your best is still ${fmtTime(cur.time)}.`;
      else note='New personal best, posted to the board.';
    }catch(e){note='Saved on this browser. Shared board temporarily unavailable.';}
  }else{const r=rankIn(localScores);note=r?`Rank ${r} on this browser.`:'';}
  const showCode=canPost===false||!scoresCol;
  $('winShare').hidden=!showCode;if(showCode)$('winCode').textContent=encodeResult(row);
  $('winRank').textContent=note;renderBoards();
}

// Read-only instrumentation is useful for profiling; deterministic test controls
// are deliberately restricted to an explicit localhost QA session.
function snapshot(){return {
  state,seed:worldSeed,position:{x:P.pos.x,y:P.pos.y,z:P.pos.z},yaw:P.yaw,pitch:P.pitch,onGround:P.onGround,crouching:P.crouching,running:P.running,hidden:P.hidden,health:P.health,stamina:P.stamina,torchOn,battery,
  weapon:weaponDefs[weaponIndex].id,mag,reserve,reloadT,aiming,elapsed,simulationTime,fuses,exitPowered,exitRelease,exitOpen,decoys,
  viewmodel:{weapons:weaponModels.filter(model=>model.visible).map(model=>model.userData.kind),torch:torch.visible,hand:hand.visible},
  injury:RULES.injuryLevel(P.health),audio:creatureAudio?creatureAudio.snapshot():null,
    horror:{...horror.snapshot(),effects:preferences.effects,notesRead:readNotes.size},
      flashes:{muzzle:!!muzzleFlash?.visible,world:muzzleLight.userData.level,weapon:fpFlash.userData.level,partner:avFlash.userData.level},
    records:caseNotes.map(n=>({id:n.id,x:n.x,z:n.z,title:n.title})),
    // intensity keeps the r128 light level; candela is the physical value sent to the renderer.
    lighting:practicalLights.map(l=>({visible:l.visible,intensity:l.userData.level,candela:l.intensity,x:l.position.x,z:l.position.z})),
    notes:captionText,
    ...dopaSnapshot(),
  performance:{fps:Math.round(1000/frameAverage),drawCalls:renderCalls,frames:renderedFrames,triangles:renderer.info.render.triangles,quality:qualityLevel,renderScale,geometries:renderer.info.memory.geometries,textures:renderer.info.memory.textures,backend:window.HollowBackend},
  rooms:specialRooms.map(r=>({id:r.id,name:r.name,x:r.x,z:r.z,w:r.w,d:r.d,shelter:!!r.shelter,fuse:!!r.fuse})),
  doors:roomDoors.map(d=>({id:d.id,x:d.box.x,z:d.box.z,open:d.open,locked:d.locked,health:d.health})),
  loot:roomLoot.map(l=>({id:l.id,type:l.type,x:l.x,z:l.z,taken:l.taken,pending:!!l.pending})),
  ammoPickups:ammoBoxes.map((b,i)=>({id:i,x:b.x,z:b.z,taken:b.taken,pending:!!b.pending})),
  enemies:monsters.slice(0,monCount).map((m,i)=>({index:i,kind:m.kind,x:m.pos.x,z:m.pos.z,hp:m.hp,dead:m.dead,state:m.state,speed:m.stats.chase,moveSpeed:m.g.userData.speed,stalkTime:m.stalkT,watchTime:m.watchT})),
  network:{role:NET.role,inGame:NET.inGame,generation:NET.gen,partner:R.present,code:NET.code,partnerY:R.raw.y||0,partnerCrouching:!!R.raw.crouch},
  input:{mouseDown,touchX:touchMove.x,touchY:touchMove.y}
};}
window.HollowGame=Object.freeze({snapshot});
if(['localhost','127.0.0.1','[::1]'].includes(location.hostname)&&new URLSearchParams(location.search).get('qa')==='1'){
  window.HollowTest=Object.freeze({
    snapshot,maze:()=>grid.map(row=>row.slice()),
    colliders:()=>roomProps.map(p=>({...p})),
    pose:({x,z,y=0,yaw=0,pitch=0})=>{P.pos.set(x,y,z);P.vel.set(0,0,0);P.velY=0;P.yaw=yaw;P.pitch=pitch;P.onGround=y===0;},
    silence:()=>{hideMonsters();grace=100000;},
    enemy:(index,pose)=>{const m=monsters[index];m.pos.set(pose.x,0,pose.z);m.g.position.copy(m.pos);m.hp=m.stats.hp;m.dead=false;m.spawned=true;m.g.visible=true;m.state=pose.state||'wander';m.path=[];m.yaw=pose.yaw||0;m.g.rotation.set(0,m.yaw,0);m.lastSeen.copy(P.pos);m.attackT=0;m.senseT=0;m.seenTarget=null;m.heardTarget=null;m.stalkT=0;m.watchT=0;m.lost=0;m.spotCD=0;m.repath=0;m.lungeT=0;m.voiceT=3;grace=0;},
    health:value=>{P.health=finiteNumber(value,100,0,100);damageT=0;},torch:value=>{torchOn=value;},
    advance:seconds=>{if(NET.inGame)return;let remaining=finiteNumber(seconds,0,0,10);while(remaining>0&&state==='play'){const dt=Math.min(.05,remaining);remaining-=dt;t+=dt;elapsed+=dt;stepSurvival(dt);updateGun(dt);monsters.forEach(m=>animateMonster(m,dt));}updateHUD();updateHealthVignette();},
    hit:(index,damage)=>hitMonster(monsters[index],damage),
    action:inputAction,pause,quality:applyQuality,pickupReach,
    path:(index,x,z)=>{setPathTo(monsters[index],x,z);return monsters[index].path.map(cell=>cell.slice());},
    navClear:(ax,az,bx,bz,radius)=>movementClear(ax,az,bx,bz,radius),
    build:seed=>{buildMazeSeeded(seed);resetSurvivor();P.pos.set(PED.x-.85,0,PED.z);P.vel.set(0,0,0);setHell();state='play';showScreen(null);spawnMonsters(8);grace=10;},
    collide:(position,radius=PR)=>{const point={...position};resolve(point,radius);return point;}
  });
}

// build everything, then idle behind the title on the meadow
buildExterior();buildStatic();
exterior.traverse(o=>{o.updateMatrix();o.matrixAutoUpdate=false;});
hall.traverse(o=>{if(o.isMesh){o.updateMatrix();o.matrixAutoUpdate=false;}});hall.updateMatrix();hall.matrixAutoUpdate=false;
newGame(true);state='menu';P.yaw=-Math.PI/2+0.25;P.pitch=0.08;$('msg').style.opacity=0;msgTimer=0;
applyQuality(qualityLevel);
if(playerName){$('whoName').textContent=playerName;openMenu();}else openNameScreen();
initBoard();initNet();renderBoards();
loop();
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
