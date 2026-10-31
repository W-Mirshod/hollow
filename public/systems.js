/* Deterministic, renderer-independent game rules. Shared by the browser and tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HollowSystems = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const SIZE = 35, CELL = 3, BASELINE_SIZE = 23;
  const DIRECTIONS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const WEAPONS = Object.freeze([
    Object.freeze({id:'rifle', name:'AR-27 · Carbine', capacity:30, reserve:15, damage:1, pellets:1, interval:.115, reload:2.15, spread:.008, recoil:.015, noise:32, automatic:true}),
    Object.freeze({id:'pistol', name:'M9 · Sidearm', capacity:12, reserve:12, damage:1.35, pellets:1, interval:.29, reload:1.45, spread:.005, recoil:.025, noise:18, automatic:false}),
    Object.freeze({id:'shotgun', name:'SG-8 · Breacher', capacity:6, reserve:2, damage:.78, pellets:8, interval:.88, reload:2.85, spread:.059, recoil:.068, noise:45, automatic:false})
  ]);
  const MONSTERS = Object.freeze({
    warden: Object.freeze({name:'Warden',hp:28,walk:.95,chase:1.65,search:1.3,damage:68,radius:.58,height:2.8,head:2.35,hearing:17,vision:12}),
    stalker: Object.freeze({name:'Stalker',hp:7,walk:1.3,chase:3.65,search:2,damage:32,radius:.34,height:2.65,head:2.12,hearing:11,vision:11}),
    crawler: Object.freeze({name:'Crawler',hp:4,walk:1.6,chase:4.25,search:2.5,damage:19,radius:.43,height:.9,head:.55,hearing:8,vision:8}),
    shrieker: Object.freeze({name:'Shrieker',hp:6,walk:1.15,chase:2.8,search:1.8,damage:24,radius:.34,height:2.3,head:1.9,hearing:15,vision:16})
  });
  function seeded(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function roomDefinitions() {
    return [
      {id:'infirmary',name:'01 / Infirmary',type:'infirmary',x:7,z:3,w:3,d:3},
      {id:'archive',name:'02 / Records',type:'archive',x:17,z:3,w:5,d:3,fuse:true},
      {id:'refuge-a',name:'03 / Isolation A',type:'security',x:9,z:11,w:3,d:3,shelter:true},
      {id:'generator',name:'04 / Generator',type:'generator',x:27,z:7,w:5,d:5,fuse:true},
      {id:'armory',name:'05 / Armory',type:'armory',x:3,z:19,w:5,d:3},
      {id:'refuge-b',name:'06 / Isolation B',type:'security',x:21,z:17,w:3,d:3,shelter:true},
      {id:'refuge-c',name:'07 / Isolation C',type:'security',x:29,z:25,w:3,d:3,shelter:true},
      {id:'laboratory',name:'08 / Treatment',type:'maintenance',x:19,z:27,w:5,d:5,fuse:true},
      {id:'refuge-d',name:'09 / Isolation D',type:'security',x:3,z:29,w:3,d:3,shelter:true},
      {id:'stores',name:'10 / Supply store',type:'lounge',x:11,z:25,w:3,d:3}
    ].map(r => ({...r,door:{x:r.x+(r.w>>1)-(r.w===3?1:0),z:r.z+r.d}}));
  }
  function flood(grid, sx, sz, blocked) {
    const w = grid.length, distances = new Int32Array(w*w).fill(-1);
    if (!grid[sz] || grid[sz][sx] !== 0) return distances;
    const queue = new Int32Array(w*w); let head=0,tail=1;
    queue[0]=sz*w+sx;distances[queue[0]]=0;
    while(head<tail){const at=queue[head++],x=at%w,z=(at/w)|0;
      for(const [dx,dz] of DIRECTIONS){const nx=x+dx,nz=z+dz,n=nz*w+nx;
        if(nx<0||nz<0||nx>=w||nz>=w||grid[nz][nx]||distances[n]>=0||(blocked&&blocked(nx,nz)))continue;
        distances[n]=distances[at]+1;queue[tail++]=n;
      }
    }
    return distances;
  }
  function generateMaze(random) {
    random=random||Math.random;
    const w=SIZE, grid=Array.from({length:w},()=>Array(w).fill(1));
    const rooms=roomDefinitions(), reserved=new Set();
    // Reserve whole room envelopes before circulation: halls must go around
    // treatment rooms, never through their furniture or isolation walls.
    for(const r of rooms){
      for(let z=r.z-1;z<=r.z+r.d;z++)for(let x=r.x-1;x<=r.x+r.w;x++)reserved.add(z*w+x);
    }
    function corridor(x0,z0,x1,z1){
      for(let z=z0;z<=z1;z++)for(let x=x0;x<=x1;x++)if(!reserved.has(z*w+x))grid[z][x]=0;
    }
    // A continuous central spine and four cross-halls make the wing legible.
    // Wide halls narrow only alongside existing room envelopes.
    corridor(14,1,16,33);
    for(const [z0,z1] of [[1,2],[7,9],[14,15],[22,23],[32,33]])corridor(1,z0,33,z1);
    // Parallel service routes reconnect at cross-halls, providing escape loops
    // even when every isolation door is locked.
    for(const [x0,x1] of [[1,2],[25,26],[32,33]])corridor(x0,1,x1,33);
    corridor(7,29,33,30);
    // Seeded changes move entire secondary routes, not individual maze walls.
    for(const [baseX,z0,z1] of [[4,7,17],[7,23,33],[18,7,25],[29,13,23]]){
      const x=baseX+(random()*2|0);corridor(x,z0,x+1,z1);
    }
    const serviceZ=18+(random()*3|0);
    corridor(1,serviceZ,15,serviceZ+1);
    corridor(15,20,33,21);
    // Each south-facing doorway has a short, straight approach to a hall.
    // Objective rooms and their clear central floors stay stable for fixtures.
    for(const r of rooms){
      for(let z=r.z;z<r.z+r.d;z++)for(let x=r.x;x<r.x+r.w;x++)grid[z][x]=0;
      grid[r.door.z][r.door.x]=0;
      const hallZ=[7,15,23,29,33].find(z=>z>r.door.z);
      corridor(r.door.x,r.door.z+1,r.door.x,hallZ);
    }
    corridor(1,1,5,3);
    grid[2][0]=grid[w-2][w-1]=0;
    return {grid,rooms};
  }
  function circleBox(p,r,b){
    const nx=Math.max(b.x-b.w/2,Math.min(p.x,b.x+b.w/2));
    const nz=Math.max(b.z-b.d/2,Math.min(p.z,b.z+b.d/2));
    const dx=p.x-nx,dz=p.z-nz,d=Math.hypot(dx,dz);
    if(d>=r)return false;
    if(d>.00001){p.x+=dx/d*(r-d);p.z+=dz/d*(r-d);}
    else {const left=p.x-(b.x-b.w/2),right=b.x+b.w/2-p.x,top=p.z-(b.z-b.d/2),bottom=b.z+b.d/2-p.z;
      const min=Math.min(left,right,top,bottom);
      if(min===left)p.x=b.x-b.w/2-r;else if(min===right)p.x=b.x+b.w/2+r;else if(min===top)p.z=b.z-b.d/2-r;else p.z=b.z+b.d/2+r;
    }
    return true;
  }
  function insideRoom(room,x,z,margin){margin=margin||0;return x>room.x*CELL+margin&&x<(room.x+room.w)*CELL-margin&&z>room.z*CELL+margin&&z<(room.z+room.d)*CELL-margin;}
  function weaponDamage(kind,headshot,distance,monsterKind){
    const w=WEAPONS.find(v=>v.id===kind)||WEAPONS[0];
    const falloff=kind==='shotgun'?Math.max(.22,1-Math.max(0,distance-7)/25):kind==='pistol'?Math.max(.6,1-Math.max(0,distance-18)/70):1;
    return w.damage*falloff*(headshot?(monsterKind==='warden'?1.1:1.85):1);
  }
  return {SIZE,CELL,BASELINE_SIZE,DIRECTIONS,WEAPONS,MONSTERS,seeded,generateMaze,flood,circleBox,insideRoom,weaponDamage};
});
