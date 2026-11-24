'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const THREE = require('three');
const Laser = require('../public/laser.js');
const rules = require('../public/systems.js');

const HEIGHTS = rules.LASER.heights, RANGE = rules.LASER.range;
function prng(seed) { let s = seed; return () => { s = s * 16807 % 2147483647; return s / 2147483647; }; }
// A wall everywhere x >= 3; a crate 0.7 m high over x -3.5..-2.5, z -0.5..0.5.
const wallEast = (x, y, z) => x >= 3;
const crateWest = (x, y, z) => y < .7 && x > -3.5 && x < -2.5 && Math.abs(z) < .5;
function setup(extra = {}) {
  const scene = new THREE.Scene();
  return { scene, fx: Laser.create({ THREE, scene, ...extra }) };
}
const named = (fx, name) => fx.meshes.find(m => m.name === 'laser:' + name);
function run(fx, seconds, dt = 1 / 60) { for (let t = 0; t < seconds - 1e-9; t += dt) fx.update(dt); }

test('loads as a browser global and a CommonJS module; meshes start hidden and dispose cleans up after itself', () => {
  const context = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/laser.js'), 'utf8'), context);
  for (const api of [context.HollowLaser, Laser]) {
    assert.ok(Object.isFrozen(api));
    for (const f of ['create', 'place', 'scan', 'reach', 'targets', 'front']) assert.equal(typeof api[f], 'function', f);
    assert.deepEqual(Object.keys(api.QUALITY), ['high', 'medium', 'low']);
  }
  assert.throws(() => Laser.create({}), TypeError);
  const { scene, fx } = setup();
  assert.deepEqual(fx.meshes.map(m => m.name), ['laser:core', 'laser:glow', 'laser:ring', 'laser:flare']);
  for (const m of fx.meshes) {
    assert.ok(m.isInstancedMesh && m.parent === scene && !m.visible && m.count === 0 && m.frustumCulled === false, m.name);
    assert.equal(m.material.blending, THREE.AdditiveBlending, `${m.name} adds light`);
    assert.ok(m.material.transparent && !m.material.depthWrite && m.instanceColor, `${m.name}: no depth writes, a colour per instance from the start`);
  }
  const pickup = fx.pickup();
  const disposed = new Set();
  for (const m of fx.meshes) for (const x of [m.geometry, m.material]) x.addEventListener('dispose', () => disposed.add(x));
  pickup.traverse(n => { if (n.isMesh) for (const x of [n.geometry, n.material, n.material.map].filter(Boolean)) x.addEventListener('dispose', () => disposed.add(x)); });
  fx.dispose();
  for (const m of fx.meshes) assert.equal(m.parent, null);
  assert.ok(disposed.size >= 16, `geometries, materials and textures disposed (${disposed.size})`);
  assert.equal(scene.children.length, 0, 'nothing left in the scene');
  fx.update(1 / 60); fx.fire({ scan: Laser.scan({}) }); fx.prewarm(true); fx.dispose();
});

test('the rules: one charge to start, a few more on every floor, a range of 7-9 m and three heights', () => {
  const L = rules.LASER;
  assert.ok(Object.isFrozen(L) && Object.isFrozen(L.heights));
  assert.equal(L.start, 1);
  assert.ok(L.range >= 7 && L.range <= 9, `range ${L.range}`);
  assert.ok(L.max > L.start && L.cooldown > 0 && L.boss > 0 && L.boss < rules.MONSTERS.gravekeeper.hp, 'the Gravekeeper survives one');
  assert.deepEqual([...L.heights].sort((a, b) => a - b), [...L.heights]);
  assert.ok(L.heights[0] < rules.MONSTERS.crawler.height && L.heights[0] < .62, 'the lowest beam cuts crawlers and bodies on the floor');
  assert.ok(L.heights.at(-1) > 1.6, 'the highest passes over the survivor\'s eyes');
  for (const f of rules.FLOORS) assert.ok(Number.isInteger(f.lasers) && f.lasers >= 2, `${f.code} has charges lying along the way`);
});

test('place: one charge per band of distance from the start, spread apart, off the skipped cells, the same every time', () => {
  const size = 20, dist = new Int32Array(size * size).fill(-1);
  // An open field: steps from the corner (0, 0); row 5 is walled off (unreachable).
  for (let z = 0; z < size; z++) for (let x = 0; x < size; x++) if (z !== 5) dist[z * size + x] = x + z;
  const skip = (x, z) => x === z;
  const o = { size, dist, count: 3, near: 6, spacing: 6, skip };
  const a = Laser.place({ ...o, rand: prng(3) }), b = Laser.place({ ...o, rand: prng(3) }), c = Laser.place({ ...o, rand: prng(91) });
  assert.equal(a.length, 3);
  assert.deepEqual(a, b, 'a seeded stream places them the same way (co-op partners agree)');
  assert.notDeepEqual(a, c, 'another seed, other cells');
  for (const p of [...a, ...c]) {
    assert.ok(p.d >= 6, 'never by the start'); assert.notEqual(p.cz, 5, 'never where nobody can go'); assert.ok(!skip(p.cx, p.cz), 'never on a skipped cell');
    assert.equal(p.d, dist[p.cz * size + p.cx]);
  }
  for (const list of [a, c]) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) assert.ok(Math.abs(list[i].cx - list[j].cx) + Math.abs(list[i].cz - list[j].cz) >= 6, 'spread apart');
    assert.ok(list[0].d <= list[1].d && list[1].d <= list[2].d, 'nearest band first: one near the start, one far out');
    assert.ok(list[2].d - list[0].d >= 10, `along the way, not bunched up (${list.map(p => p.d)})`);
  }
  // Crowded: fewer than asked rather than piled up; nothing to place, nothing placed.
  const tight = Laser.place({ size, dist, count: 40, near: 6, spacing: 9, rand: prng(5) });
  assert.ok(tight.length > 1 && tight.length < 40);
  assert.deepEqual(Laser.place({ size, dist, count: 0, rand: prng(5) }), []);
  assert.deepEqual(Laser.place({ size, dist: null, count: 3 }), []);
});

test('scan: each height stops at the first wall, door or piece of furniture in each direction, out to the range', () => {
  const s = Laser.scan({ x: 0, y: 0, z: 0, range: RANGE, heights: HEIGHTS, blocks: (x, y, z) => wallEast(x, y, z) || crateWest(x, y, z) });
  assert.equal(s.table.length, HEIGHTS.length * s.bins);
  for (let h = 0; h < HEIGHTS.length; h++) {
    assert.ok(Math.abs(Laser.reach(s, h, 0) - 3) < .15, `east: the wall at 3 m (height ${h})`);
    assert.equal(Laser.reach(s, h, Math.PI / 2), RANGE, 'north: open to the range');
    assert.ok(Math.abs(Laser.reach(s, h, Math.PI / 4) - 3 * Math.SQRT2) < .2, 'north-east: the wall further off at an angle');
    assert.equal(Laser.reach(s, h, -Math.PI / 2), Laser.reach(s, h, 3 * Math.PI / 2), 'angles wrap round');
  }
  assert.ok(Math.abs(Laser.reach(s, 0, Math.PI) - 2.5) < .15, 'west: the crate stops the low beam');
  assert.equal(Laser.reach(s, 1, Math.PI), RANGE, 'and the chest-high one passes over it');
  const open = Laser.scan({ x: 4, y: 0, z: 4, range: RANGE, heights: HEIGHTS });
  assert.ok(open.table.every(v => v === RANGE), 'nothing to stop them: all out to the range');
  const raised = Laser.scan({ x: 0, y: 1, z: 0, range: RANGE, heights: HEIGHTS, blocks: crateWest });
  assert.equal(Laser.reach(raised, 0, Math.PI), RANGE, 'jumping over the crate, the low beam clears it too');
});

test('targets: every body within the beams\' reach and in the open is cut, nearest first; walls, height and range spare the rest', () => {
  const blocks = (x, y, z) => wallEast(x, y, z) || crateWest(x, y, z);
  const bodies = [
    { x: 0, z: 6, r: .34, bottom: 0, top: 2.65 },      // 0: a stalker 6 m north, in the open
    { x: 5, z: 0, r: .58, bottom: 0, top: 2.8 },       // 1: a Warden behind the east wall
    { x: 0, z: -9.5, r: .34, bottom: 0, top: 2.65 },   // 2: out of reach
    { x: -6, z: 0, r: .43, bottom: 0, top: .9 },       // 3: a crawler behind the crate: only the low beam reaches that low
    { x: -2, z: 5, r: .36, bottom: 0, top: .62 },      // 4: a body lying on the floor, in the open
    null,                                              // 5: dead
    { x: 1.5, z: -1, r: .58, bottom: 0, top: 2.8 },    // 6: a Warden right beside the survivor
    { x: 0, z: 8.7, r: .58, bottom: 0, top: 2.8 },     // 7: its near side just inside the range
    { x: -2, z: -4, r: .3, bottom: 2.2, top: 2.4 }     // 8: something above the highest beam
  ];
  const all = Laser.targets({ x: 0, y: 0, z: 0, range: RANGE, heights: HEIGHTS, blocks, bodies });
  assert.deepEqual(all.map(h => h.index), [6, 4, 0, 7]);
  for (let i = 1; i < all.length; i++) assert.ok(all[i].distance >= all[i - 1].distance);
  assert.equal(all.find(h => h.index === 4).layer, 0, 'the lying body: the low beam');
  assert.equal(all.find(h => h.index === 0).layer, 0, 'the first height that gets through');
  assert.ok(Math.abs(all.find(h => h.index === 0).distance - (6 - .34)) < 1e-9, 'distance to its near side');
  const early = Laser.targets({ x: 0, y: 0, z: 0, range: RANGE, front: 3, heights: HEIGHTS, blocks, bodies });
  assert.deepEqual(early.map(h => h.index), [6], 'only what the beams\' front has reached');
  const noCrate = Laser.targets({ x: 0, y: 0, z: 0, range: RANGE, heights: HEIGHTS, blocks: wallEast, bodies });
  assert.ok(noCrate.some(h => h.index === 3), 'without the crate the crawler is cut');
  const jumping = Laser.targets({ x: 0, y: .6, z: 0, range: RANGE, heights: HEIGHTS, blocks: wallEast, bodies });
  assert.ok(!jumping.some(h => h.index === 3 || h.index === 4), 'in the air, every beam passes over the low bodies');
  assert.deepEqual(Laser.targets({ x: 0, y: 0, z: 0, range: RANGE, heights: HEIGHTS }), []);
});

test('a burst: the beams reach out, sweep round at full strength while they cut, then fade and are gone', () => {
  const { fx } = setup({ quality: 'high' });
  const s = Laser.scan({ x: 2, y: 0, z: 2, range: RANGE, heights: HEIGHTS, blocks: (x, y, z) => x >= 5 });
  assert.ok(fx.fire({ scan: s, angle: .3 }) > 0);
  fx.update(1 / 60);
  const core = named(fx, 'core'), glow = named(fx, 'glow'), ring = named(fx, 'ring'), flare = named(fx, 'flare');
  const first = fx.snapshot();
  assert.ok(first.active === 1 && first.front < 2, `starting out (${first.front} m)`);
  assert.ok(ring.visible && ring.count === 2 && flare.visible && flare.count === 1, 'two blast rings and the flash at the chest');
  run(fx, .25);
  const out = fx.snapshot();
  assert.equal(out.front, RANGE, 'out to the range in about a fifth of a second');
  assert.equal(core.count, HEIGHTS.length * Laser.QUALITY.high, 'every beam at every height');
  assert.equal(glow.count, core.count);
  // Beam i: from START m out, along (cos a, sin a), as long as the scan allows; core bright, glow red.
  const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), c = new THREE.Color();
  let east = 0;
  for (let i = 0; i < core.count; i++) {
    core.getMatrixAt(i, m); m.decompose(p, q, sc);
    const dir = new THREE.Vector3(1, 0, 0).applyQuaternion(q), tip = p.clone().addScaledVector(dir, sc.x);
    assert.ok(Math.abs(Math.hypot(p.x - 2, p.z - 2) - Laser.START) < 1e-6, 'starts clear of the survivor');
    assert.ok(HEIGHTS.some(h => Math.abs(p.y - h) < 1e-6), 'at one of the heights');
    assert.ok(tip.x < 5.1, 'never through the wall');
    assert.ok(Math.hypot(tip.x - 2, tip.z - 2) <= RANGE + 1e-6, 'never past the range');
    if (dir.x > .9) { east++; assert.ok(tip.x > 4.7, 'right up to the wall'); }
    core.getColorAt(i, c); assert.ok(c.r > 1.5, 'white-hot at full strength');
  }
  assert.ok(east > 0);
  core.getMatrixAt(0, m); const before = new THREE.Quaternion(); m.decompose(p, before, sc);
  run(fx, .3);
  core.getMatrixAt(0, m); m.decompose(p, q, sc);
  assert.ok(q.angleTo(before) > .05, 'they sweep round while they cut');
  assert.ok(!ring.visible, 'the rings are spent');
  run(fx, .35);
  core.getColorAt(0, c);
  assert.ok(c.r < 1, `fading after the sweep (${c.r})`);
  run(fx, .2);
  assert.equal(fx.active(), false);
  for (const mesh of fx.meshes) assert.ok(!mesh.visible && mesh.count === 0, `${mesh.name} gone`);
});

test('fewer, steadier beams at low quality or with effects off; bursts at once share the meshes and the oldest gives way', () => {
  const { fx } = setup({ quality: 'low' });
  const s = Laser.scan({ x: 0, y: 0, z: 0, range: RANGE, heights: HEIGHTS });
  fx.fire({ scan: s }); run(fx, .3);
  assert.equal(named(fx, 'core').count, HEIGHTS.length * Laser.QUALITY.low);
  fx.setEffects(false); fx.update(1 / 60);
  assert.ok(named(fx, 'core').count < HEIGHTS.length * Laser.QUALITY.low, 'effects off: fewer still');
  fx.setEffects(true); fx.setQuality('high'); fx.setQuality('nonsense'); fx.update(1 / 60);
  assert.equal(fx.snapshot().quality, 'high');
  fx.clear();
  assert.equal(fx.active(), false);
  for (let i = 0; i < Laser.MAX_BURSTS; i++) { fx.fire({ scan: Laser.scan({ x: i * 20, range: RANGE, heights: HEIGHTS }) }); fx.update(.05); }
  assert.equal(fx.snapshot().active, Laser.MAX_BURSTS);
  assert.equal(named(fx, 'core').count, Laser.MAX_BURSTS * HEIGHTS.length * Laser.QUALITY.high, 'one draw call for every burst\'s beams');
  fx.fire({ scan: Laser.scan({ x: 99, range: RANGE, heights: HEIGHTS }) }); fx.update(1 / 60);
  assert.equal(fx.snapshot().active, Laser.MAX_BURSTS, 'a fourth replaces the oldest');
  assert.equal(fx.fire({}), 0, 'no scan, no burst');
});

test('prewarm draws every mesh for a pipeline compile, survives update(), and puts back exactly what was drawn', () => {
  const { fx } = setup();
  const drawn = () => fx.meshes.map(m => [m.name, m.count, m.visible]);
  const idle = drawn();
  fx.prewarm(true);
  for (const m of fx.meshes) assert.ok(m.visible && m.count >= 1, `${m.name} draws while warming`);
  fx.update(.2);
  for (const m of fx.meshes) assert.ok(m.visible && m.count >= 1, `${m.name} still draws after update()`);
  fx.prewarm(false);
  assert.deepEqual(drawn(), idle);
  fx.fire({ scan: Laser.scan({ range: RANGE, heights: HEIGHTS }) }); run(fx, .3);
  const live = drawn();
  fx.prewarm(true); fx.prewarm(true); fx.prewarm(false);
  assert.deepEqual(drawn(), live, 'a live burst comes back as it was');
});

test('the charge on the floor: a canister with glowing bands in a soft glow, sharing its geometry and materials, beating together', () => {
  const { fx } = setup();
  const a = fx.pickup(), b = fx.pickup();
  const meshes = g => { const out = []; g.traverse(n => { if (n.isMesh) out.push(n); }); return out; };
  assert.ok(meshes(a).length >= 7);
  meshes(a).forEach((m, i) => { assert.equal(m.geometry, meshes(b)[i].geometry); assert.equal(m.material, meshes(b)[i].material); });
  const box = new THREE.Box3().setFromObject(a);
  assert.ok(box.min.y >= 0 && box.max.y < .4 && box.max.x - box.min.x < 1.3, 'small, standing on the floor');
  assert.ok(a.userData.spin && a.userData.spin.parent === a);
  const hot = meshes(a).find(m => m.material.emissive && m.material.emissive.getHex() !== 0).material, halo = meshes(a).find(m => m.material.map).material;
  assert.equal(halo.blending, THREE.AdditiveBlending);
  fx.pulse(0); const low = hot.emissiveIntensity; fx.pulse(Math.PI / 8);
  assert.ok(hot.emissiveIntensity > low, 'the bands pulse');
});
