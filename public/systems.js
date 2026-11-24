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
  // Speeds in m/s. A lunge multiplies chase speed by lungeSpeed for lungeTime seconds when the
  // target is within lungeRange metres, then waits lungeCooldown seconds before the next one.
  const MONSTERS = Object.freeze({
    warden: Object.freeze({name:'Warden',hp:28,walk:1.2,chase:3.2,search:2.2,damage:68,radius:.58,height:2.8,head:2.35,hearing:17,vision:12,lungeRange:2.6,lungeSpeed:1.35,lungeTime:.5,lungeCooldown:3.4}),
    stalker: Object.freeze({name:'Stalker',hp:7,walk:1.6,chase:5.5,search:2.75,damage:32,radius:.34,height:2.65,head:2.12,hearing:11,vision:11,lungeRange:4.4,lungeSpeed:1.5,lungeTime:.42,lungeCooldown:2.6}),
    crawler: Object.freeze({name:'Crawler',hp:4,walk:1.9,chase:6.2,search:3.35,damage:19,radius:.43,height:.9,head:.55,hearing:8,vision:8,lungeRange:3.6,lungeSpeed:1.6,lungeTime:.35,lungeCooldown:2.8}),
    shrieker: Object.freeze({name:'Shrieker',hp:6,walk:1.4,chase:4.4,search:2.6,damage:24,radius:.34,height:2.3,head:1.9,hearing:15,vision:16,lungeRange:3.2,lungeSpeed:1.45,lungeTime:.4,lungeCooldown:2.8}),
    // The Graveyard's boss (boss: never in the shared pool, never stunned by a hit). Its lunge is the charge.
    gravekeeper: Object.freeze({name:'The Gravekeeper',hp:90,walk:1.3,chase:3.6,search:2.4,damage:45,radius:.8,height:3.6,head:3.05,hearing:40,vision:30,lungeRange:4.5,lungeSpeed:1.5,lungeTime:.5,lungeCooldown:4,boss:true})
  });
  // Player movement (m/s) and stamina (0..1 per second). Sprinting reaches full speed over
  // sprintAccel seconds; at zero stamina the player is exhausted until exhaustedRecover.
  const PLAYER = Object.freeze({
    walk:3, run:6.8, crouch:1.5, aimWalk:2.1, sprintAccel:.45,
    staminaDrain:1/7, staminaRegenIdle:1/5, staminaRegenMove:1/8,
    exhaustedRecover:.35, exhaustedSpeed:.85, jumpCost:.08, slideCost:.16, slideSpeed:7.5, slideTime:.65
  });
  // The campaign: three floors below and two above, each with three objective items behind one exit. active: monsters awake on arrival;
  // sleepers: bodies on the floor that wake when disturbed; ammo: supply boxes; release: seconds the exit takes to open
  // once powered (B1 keeps HollowHorror.RELEASE_SECONDS). weapons: gun -> room id where it lies, if not yet owned.
  const FLOORS = Object.freeze([
    Object.freeze({id:'b1', code:'B1', name:'Blackwater Ward', item:'power fuse', items:'power fuses', exit:'east loading shutter',
      active:8, sleepers:5, ammo:16, release:10, weapons:Object.freeze({rifle:'armory'})}),
    Object.freeze({id:'b2', code:'B2', name:'Records & Morgue', item:'lift keycard', items:'lift keycards', exit:'freight lift',
      active:6, sleepers:12, ammo:18, release:15, weapons:Object.freeze({shotgun:'m-security', rifle:'m-intake'})}),
    Object.freeze({id:'b3', code:'B3', name:'The Hollow', item:'floodgate key', items:'floodgate keys', exit:'surface floodgate',
      active:10, sleepers:9, ammo:20, release:25, weapons:Object.freeze({rifle:'h-guard', shotgun:'h-cell-a'})}),
    // Above ground (outdoor: a night sky, hedges or churchyard walls). S2's gate opens only once its boss is dead: the
    // Gravekeeper rises from `grave` inside the open `arena` [x0, z0, x1, z1] (cells), and later calls the bodies in
    // `summons` up out of their graves into the pool slots left free after active + sleepers.
    Object.freeze({id:'garden', code:'S1', name:'The Overgrown Garden', item:'gate key', items:'gate keys', exit:'garden gate',
      active:9, sleepers:11, ammo:22, release:30, outdoor:true, fountain:Object.freeze([17, 17]), weapons:Object.freeze({rifle:'g-potting'})}),
    Object.freeze({id:'graveyard', code:'S2', name:'Blackwater Graveyard', item:'crypt key', items:'crypt keys', exit:'cemetery gate',
      active:8, sleepers:9, ammo:24, release:35, outdoor:true, weapons:Object.freeze({shotgun:'y-gravedigger'}),
      boss:Object.freeze({kind:'gravekeeper', grave:Object.freeze([29, 30]), arena:Object.freeze([21, 21, 33, 33]),
        summons:Object.freeze([Object.freeze([23, 23]), Object.freeze([31, 23]), Object.freeze([23, 31])])})})
  ]);
  // Every run starts with the sidearm alone; the other guns lie somewhere below and are picked up when found.
  const STARTING_WEAPONS = Object.freeze(['pistol']);
  // Sleeping bodies build disturbance toward `wake` and lose it at `decay` per second when left alone. Distances in
  // metres: a torch beam (within `cone` radians of its axis), a sprint, a walk or a crouch-walk inside its range, or
  // lingering beside one (`near`); contact (`touch`) wakes at once. A gunshot wakes sleepers within noise x `shot`.
  // A woken body needs `rise` seconds to stand, then rouses other sleepers within `chain` metres.
  const SLEEP = Object.freeze({wake:1, decay:.3, touch:1, torch:15, cone:.45, run:9.5, walk:4, crouch:1.8, near:1.8,
    shot:.7, rise:.9, chain:11});
  // Disturbance per second a sleeper at `distance` gets from one survivor: {torch, moving, running, crouching}.
  // torch means the beam is on the body with a clear line of sight. Infinity: woken at once.
  function sleepDisturbance(distance, stimulus) {
    const s = stimulus || {}, d = Number.isFinite(distance) ? Math.max(0, distance) : Infinity;
    if (d < SLEEP.touch) return Infinity;
    let rate = 0;
    if (s.torch && d < SLEEP.torch) rate += 1.2 + 1.5 * (1 - d / SLEEP.torch);
    if (s.moving && s.running) { if (d < SLEEP.run) rate += 2.6 * (1.3 - d / SLEEP.run); }
    else if (s.moving && s.crouching) { if (d < SLEEP.crouch) rate += .9; }
    else if (s.moving) { if (d < SLEEP.walk) rate += 1.7; }
    else if (d < SLEEP.near) rate += .25;
    return rate;
  }
  // Seconds until a gunshot of `noise` wakes a sleeper at `distance`, or -1 when it sleeps through it.
  function shotWakeDelay(distance, noise) {
    const reach = (Number(noise) || 0) * SLEEP.shot, d = Number(distance);
    if (!(reach > 0) || !Number.isFinite(d) || d < 0 || d >= reach) return -1;
    return .15 + .9 * d / reach;
  }
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
  // Lower floors keep fixed rooms around their own hall plans. Each `optional` side passage opens on a coin flip and
  // each `debris` cell is walled on one, so every seed reshuffles the shortcuts without moving a room.
  const room = (id, name, type, x, z, w, d, flags) => Object.freeze({id, name, type, x, z, w, d, ...flags});
  const FLOOR_PLANS = Object.freeze([null, Object.freeze({
    rooms: [
      room('m-intake', '01 / Intake', 'infirmary', 4, 6, 3, 3),
      room('m-records', '02 / Records vault', 'archive', 10, 4, 5, 5, {fuse:true}),
      room('m-chapel', '03 / Chapel of rest', 'lounge', 19, 6, 3, 3),
      room('m-boiler', '04 / Boiler room', 'maintenance', 25, 4, 5, 5),
      room('m-vault-a', '05 / Cold vault A', 'security', 4, 15, 3, 3, {shelter:true}),
      room('m-morgue', '06 / Morgue', 'morgue', 10, 13, 5, 5, {fuse:true}),
      room('m-security', '07 / Security', 'security', 19, 15, 3, 3),
      room('m-staff', '08 / Staff room', 'lounge', 25, 15, 5, 3),
      room('m-autopsy', '09 / Autopsy', 'morgue', 4, 22, 5, 5),
      room('m-vault-b', '10 / Cold vault B', 'security', 12, 24, 3, 3, {shelter:true}),
      room('m-crematory', '11 / Crematorium', 'generator', 19, 22, 5, 5, {fuse:true}),
      room('m-vault-c', '12 / Cold vault C', 'security', 27, 24, 3, 3, {shelter:true})
    ],
    halls: [[1,1,33,2], [1,1,2,33], [32,1,33,33], [1,32,33,33], [16,1,17,33], [1,10,33,11], [1,19,33,20], [1,28,33,29]],
    optional: [[8,3,8,9], [23,3,23,9], [18,3,22,4], [8,12,8,18], [3,12,8,12], [18,13,31,13], [23,12,23,18], [10,21,10,27],
      [10,21,15,21], [25,21,25,27], [25,22,31,22], [5,30,5,31], [9,30,9,31], [13,30,13,31], [21,30,21,31], [25,30,25,31], [29,30,29,31]],
    pillars: [], debris: []
  }), Object.freeze({
    rooms: [
      room('h-guard', '01 / Guard post', 'armory', 4, 5, 3, 3),
      room('h-pump', '02 / Pump room', 'generator', 10, 5, 5, 3, {fuse:true}),
      room('h-safe-a', '03 / Bulkhead A', 'security', 18, 5, 3, 3, {shelter:true}),
      room('h-control', '04 / Floodgate control', 'maintenance', 25, 5, 5, 3),
      room('h-infirm', '05 / Sick bay', 'infirmary', 4, 12, 3, 3),
      room('h-safe-b', '06 / Bulkhead B', 'security', 4, 19, 3, 3, {shelter:true}),
      room('h-cell-b', '07 / Cell block B', 'security', 27, 12, 3, 3),
      room('h-store', '08 / Flood store', 'lounge', 27, 19, 3, 3),
      room('h-well', '09 / The Well', 'generator', 15, 15, 5, 5, {fuse:true}),
      room('h-cell-a', '10 / Cell block A', 'security', 4, 28, 3, 3),
      room('h-nest', '11 / The Nest', 'morgue', 10, 28, 5, 3, {fuse:true}),
      room('h-safe-c', '12 / Bulkhead C', 'security', 18, 28, 3, 3, {shelter:true}),
      room('h-cistern', '13 / Cistern', 'maintenance', 25, 28, 5, 3)
    ],
    halls: [[1,1,33,2], [1,1,2,33], [32,1,33,33], [1,32,33,33], [1,9,33,10], [1,24,33,25], [9,9,10,25], [24,9,25,25],
      [11,11,23,23], [1,16,10,17], [24,16,33,17]],
    optional: [[8,3,8,8], [16,3,16,8], [22,3,22,8], [23,3,23,8], [8,26,8,31], [16,26,16,31], [22,26,22,31], [23,26,23,31], [6,3,33,3]],
    pillars: [[12,12], [22,12], [12,22], [22,22], [17,12], [12,17], [22,17]],
    debris: [[14,12], [20,12], [12,14], [12,20], [22,14], [22,20], [14,22], [20,22]]
  }), Object.freeze({
    // S1: hedged garden rooms around an open lawn with a fountain; `look` picks each room's outdoor dressing.
    rooms: [
      room('g-potting', '01 / Potting shed', 'armory', 4, 5, 3, 3, {look:'shed'}),
      room('g-glasshouse', '02 / Glasshouse', 'maintenance', 10, 5, 5, 3, {fuse:true, look:'glasshouse'}),
      room('g-icehouse', '03 / Ice house', 'security', 18, 5, 3, 3, {shelter:true, look:'icehouse'}),
      room('g-orangery', '04 / Orangery', 'lounge', 24, 5, 5, 3, {look:'orangery'}),
      room('g-herb', '05 / Physic garden', 'infirmary', 4, 12, 3, 3, {look:'herb'}),
      room('g-bothy', '06 / Bothy', 'security', 4, 19, 3, 3, {shelter:true, look:'bothy'}),
      room('g-aviary', '07 / Aviary', 'lounge', 28, 12, 3, 3, {look:'aviary'}),
      room('g-rose', '08 / Rose walk', 'lounge', 28, 19, 3, 3, {look:'rose'}),
      room('g-wild', '09 / Wild garden', 'morgue', 4, 28, 3, 3, {look:'wild'}),
      room('g-cottage', '10 / Gardener\'s cottage', 'morgue', 10, 28, 5, 3, {fuse:true, look:'cottage'}),
      room('g-summer', '11 / Summerhouse', 'security', 18, 28, 3, 3, {shelter:true, look:'summerhouse'}),
      room('g-folly', '12 / The Folly', 'maintenance', 24, 28, 5, 3, {fuse:true, look:'folly'})
    ],
    halls: [[1,1,33,2], [1,1,2,33], [32,1,33,33], [1,32,33,33], [1,9,33,10], [1,24,33,25], [9,9,10,25], [24,9,25,25],
      [11,11,23,23], [1,16,10,17], [24,16,33,17]],
    optional: [[8,3,8,8], [16,3,16,8], [22,3,22,8], [30,3,30,8], [8,26,8,31], [16,26,16,31], [22,26,22,31], [30,26,30,31],
      [3,11,3,15], [26,11,26,15], [26,18,26,22], [3,18,3,22]],
    pillars: [[13,13], [14,13], [13,14], [21,13], [20,13], [21,14], [13,21], [14,21], [13,20], [21,21], [20,21], [21,20]],
    debris: [[17,12], [12,17], [22,17], [17,22], [15,15], [19,15], [15,19], [19,19]]
  }), Object.freeze({
    // S2: crypts and chapels along gravel walks; the south-east plot before the gate is kept open for the boss fight.
    rooms: [
      room('y-sexton', '01 / Sexton\'s lodge', 'infirmary', 4, 5, 3, 3, {look:'lodge'}),
      room('y-chapel', '02 / Cemetery chapel', 'maintenance', 10, 5, 5, 3, {fuse:true, look:'chapel'}),
      room('y-crypt-a', '03 / Crypt of St Agnes', 'security', 18, 5, 3, 3, {shelter:true, look:'crypt'}),
      room('y-gravedigger', '04 / Gravedigger\'s hut', 'armory', 23, 5, 3, 3, {look:'hut'}),
      room('y-columbarium', '05 / Columbarium', 'lounge', 28, 5, 3, 3, {look:'columbarium'}),
      room('y-ossuary', '06 / Ossuary', 'morgue', 4, 12, 3, 3, {look:'ossuary'}),
      room('y-mausoleum', '07 / Blackwater mausoleum', 'morgue', 13, 12, 5, 5, {fuse:true, look:'mausoleum'}),
      room('y-charnel', '08 / Charnel house', 'morgue', 27, 12, 3, 3, {fuse:true, look:'charnel'}),
      room('y-crypt-b', '09 / Crypt of St Jude', 'security', 4, 19, 3, 3, {shelter:true, look:'crypt'}),
      room('y-vestry', '10 / Vestry', 'lounge', 22, 12, 3, 3, {look:'vestry'}),
      room('y-paupers', '11 / Paupers\' chapel', 'lounge', 4, 28, 3, 3, {look:'paupers'}),
      room('y-embalm', '12 / Embalming house', 'maintenance', 10, 28, 5, 3, {look:'embalm'}),
      room('y-crypt-c', '13 / Crypt of St Mary', 'security', 16, 28, 3, 3, {shelter:true, look:'crypt'})
    ],
    halls: [[1,1,33,2], [1,1,2,33], [32,1,33,33], [1,32,33,33], [1,9,33,10], [9,9,10,33], [19,9,20,33], [1,16,10,17],
      [1,24,20,25], [11,19,20,20], [21,17,33,19], [23,20,24,20], [29,20,30,20], [21,21,33,33]],
    optional: [[8,3,8,8], [16,3,16,8], [21,3,21,8], [26,3,26,8], [3,11,3,15], [8,11,8,15], [11,11,11,18], [26,11,26,16], [31,11,31,16],
      [8,26,8,31], [15,26,15,31], [20,26,20,31], [3,18,3,22], [8,18,8,22], [26,20,27,20]],
    pillars: [],
    debris: [[10,21], [19,22], [22,18], [25,18], [28,18], [31,18]]
  })]);
  function generateFloor(index, random) {
    const plan = FLOOR_PLANS[Math.max(0, Math.min(FLOOR_PLANS.length - 1, index | 0))];
    if (!plan) return generateMaze(random);
    random = random || Math.random;
    const w = SIZE, grid = Array.from({length:w}, () => Array(w).fill(1)), reserved = new Set();
    const rooms = plan.rooms.map(r => ({...r, door:{x:r.x+(r.w>>1)-(r.w===3?1:0), z:r.z+r.d}}));
    for (const r of rooms) for (let z = r.z-1; z <= r.z+r.d; z++) for (let x = r.x-1; x <= r.x+r.w; x++) reserved.add(z*w+x);
    const corridor = (x0, z0, x1, z1) => {
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) if (!reserved.has(z*w+x)) grid[z][x] = 0;
    };
    for (const hall of plan.halls) corridor(...hall);
    for (const hall of plan.optional) if (random() < .5) corridor(...hall);
    for (const [x, z] of plan.pillars) grid[z][x] = 1;
    for (const [x, z] of plan.debris) if (random() < .5) grid[z][x] = 1;
    // Doors face south and run straight to the first open hall cell.
    for (const r of rooms) {
      for (let z = r.z; z < r.z+r.d; z++) for (let x = r.x; x < r.x+r.w; x++) grid[z][x] = 0;
      grid[r.door.z][r.door.x] = 0;
      for (let z = r.door.z+1; z < w-1 && grid[z][r.door.x] && !reserved.has(z*w+r.door.x); z++) grid[z][r.door.x] = 0;
    }
    corridor(1, 1, 5, 3);
    grid[2][0] = grid[w-2][w-1] = 0;
    return {grid, rooms};
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
  // Block approaching/crossing another body, but always let an overlapped actor
  // move away. Contact constrains movement; it must never shove the other actor.
  function blocksCircleMove(from,to,radius,other){
    const dx=to.x-from.x,dz=to.z-from.z,ox=from.x-other.x,oz=from.z-other.z;
    const limit=radius+other.r,initial=ox*ox+oz*oz,dot=ox*dx+oz*dz;
    if(initial<limit*limit+1e-8&&dot>=-1e-8)return false;
    const length=dx*dx+dz*dz,k=length>1e-10?Math.max(0,Math.min(1,-dot/length)):0;
    return (ox+dx*k)**2+(oz+dz*k)**2<limit*limit-1e-8;
  }
  function injuryLevel(health){
    const value=Number.isFinite(health)?Math.max(0,Math.min(100,health)):100;
    return Math.pow(1-value/100,1.15);
  }
  function insideRoom(room,x,z,margin){margin=margin||0;return x>room.x*CELL+margin&&x<(room.x+room.w)*CELL-margin&&z>room.z*CELL+margin&&z<(room.z+room.d)*CELL-margin;}
  function weaponDamage(kind,headshot,distance,monsterKind){
    const w=WEAPONS.find(v=>v.id===kind)||WEAPONS[0];
    const falloff=kind==='shotgun'?Math.max(.22,1-Math.max(0,distance-7)/25):kind==='pistol'?Math.max(.6,1-Math.max(0,distance-18)/70):1;
    return w.damage*falloff*(headshot?(monsterKind==='warden'?1.1:1.85):1);
  }
  return {SIZE,CELL,BASELINE_SIZE,DIRECTIONS,WEAPONS,MONSTERS,PLAYER,FLOORS,STARTING_WEAPONS,SLEEP,seeded,generateMaze,generateFloor,flood,circleBox,blocksCircleMove,injuryLevel,insideRoom,weaponDamage,sleepDisturbance,shotWakeDelay};
});
