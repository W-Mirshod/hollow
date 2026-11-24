'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const THREE = require('three');
const Gore = require('../public/gore.js');

let visualsModule;
function visuals() {
  if (visualsModule) return visualsModule;
  const drawing = () => {
    const image = (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }), gradient = () => ({ addColorStop() {} });
    let pixels;
    return { createImageData: image, getImageData: (_x, _y, w, h) => pixels ? { width: w, height: h, data: pixels.data.slice() } : image(w, h),
      putImageData(v) { pixels = { width: v.width, height: v.height, data: v.data.slice() }; }, fillRect() {}, strokeRect() {}, fillText() {},
      beginPath() {}, moveTo() {}, lineTo() {}, bezierCurveTo() {}, arc() {}, closePath() {}, fill() {}, stroke() {}, save() {}, restore() {},
      translate() {}, rotate() {}, createLinearGradient: gradient, createRadialGradient: gradient };
  };
  const context = { window: {}, document: { createElement: () => { const d = drawing(); return { width: 0, height: 0, getContext: () => d }; } },
    WeakMap, Map, Set, Math, Float32Array, Uint8ClampedArray, Object, Array };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/visuals.js'), 'utf8'), context);
  return (visualsModule = context.window.HollowVisuals);
}
function prng(seed) { let s = seed; return () => { s = s * 16807 % 2147483647; return s / 2147483647; }; }
function setup(extra = {}) {
  const scene = new THREE.Scene();
  const gore = Gore.create({ THREE, scene, random: prng(7), ...extra });
  return { scene, gore };
}
function creature(scene, kind = 'stalker', x = 0, z = 0, yaw = 0) {
  const g = visuals().makeMonster(THREE, kind);
  g.position.set(x, 0, z); g.rotation.set(0, yaw, 0); scene.add(g); g.updateMatrixWorld(true);
  return { g, u: g.userData, kind };
}
const step = (gore, seconds, dt = 1 / 60) => { for (let i = 0; i < Math.round(seconds / dt); i++) gore.update(dt); };
const mesh = (gore, name) => gore.meshes.find(m => m.name === 'gore:' + name);
const at = (m, i) => new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().fromArray(m.instanceMatrix.array, i * 16));
const meshOf = joint => { let found = null; joint.traverse(n => { if (!found && n.isMesh) found = n; }); return found; };
const centre = obj => new THREE.Box3().setFromObject(obj, true).getCenter(new THREE.Vector3());

test('loads as a browser global and a CommonJS module; meshes start hidden and dispose cleans up after itself', () => {
  const context = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/gore.js'), 'utf8'), context);
  for (const api of [context.HollowGore, Gore]) {
    assert.ok(Object.isFrozen(api));
    assert.equal(typeof api.create, 'function');
    assert.deepEqual(Object.keys(api.QUALITY), ['high', 'medium', 'low']);
  }
  assert.throws(() => Gore.create({}), TypeError);
  const { scene, gore } = setup();
  assert.equal(gore.meshes.length, 8);
  for (const m of gore.meshes) {
    assert.ok(m.isInstancedMesh && m.parent === scene && !m.visible && m.count === 0 && m.frustumCulled === false, m.name);
  }
  const decals = ['splats', 'walls', 'pools'].map(n => mesh(gore, n));
  for (const m of decals) {
    assert.equal(m.material.blending, THREE.MultiplyBlending, `${m.name} multiplies the floor`);
    assert.ok(m.material.premultipliedAlpha && m.material.transparent && !m.material.depthWrite && m.material.map.isDataTexture);
  }
  const disposed = new Set();
  for (const m of gore.meshes) {
    for (const x of [m.geometry, m.material, m.material.map].filter(Boolean)) x.addEventListener('dispose', () => disposed.add(x));
  }
  const c = creature(scene);
  gore.sever('m', c.g, c.u.armL, { dir: { x: 0, z: -1 } });
  const limb = scene.children.find(n => n.name.startsWith('gore:limb'));
  let shared = 0;
  limb.traverse(n => { if (n.isMesh) n.geometry.addEventListener('dispose', () => shared++); });
  gore.dispose();
  for (const m of gore.meshes) assert.equal(m.parent, null);
  assert.ok(disposed.size >= 14, `geometries, materials and textures disposed (${disposed.size})`);
  assert.equal(shared, 0, 'the creature geometry a limb shares is never disposed');
  assert.ok(!scene.children.some(n => n.name.startsWith('gore:')), 'no gore left in the scene');
  assert.equal(c.u.armL.visible, true, 'disposing gives the arm back');
  gore.update(1 / 60); gore.spray(0, 1, 0, 1, 0, 0); gore.dispose();
});

test('prewarm shows every pool for a pipeline compile, survives update(), and puts back exactly what was drawn', () => {
  const { scene, gore } = setup();
  const before = () => gore.meshes.map(m => [m.name, m.count, m.visible]);
  const idle = before();
  gore.prewarm(true);
  for (const m of gore.meshes) assert.ok(m.visible && m.count >= 1, `${m.name} draws while warming`);
  step(gore, .2);
  for (const m of gore.meshes) assert.ok(m.visible && m.count >= 1, `${m.name} still draws after update()`);
  gore.prewarm(false);
  assert.deepEqual(before(), idle, 'back to nothing drawn');
  step(gore, .1);
  assert.ok(gore.meshes.every(m => !m.visible && m.count === 0), 'and update() keeps it hidden');
  // With live gore the counts come back as they were, not reset.
  gore.spray(0, 1, 0, 1, 0, 0, { amount: 1 }); step(gore, 1);
  const live = before();
  assert.ok(live.some(([, count]) => count > 1), 'the spray left splats');
  gore.prewarm(true); gore.prewarm(true); step(gore, .05); gore.prewarm(false);
  assert.deepEqual(before(), live);
  gore.dispose(); gore.prewarm(true);
  assert.ok(gore.meshes.every(m => m.parent === null));
  assert.equal(scene.children.filter(n => n.name.startsWith('gore:')).length, 0);
});

test('wounds ride the joint they were shot into, and hide with it', () => {
  const { scene, gore } = setup();
  const c = creature(scene, 'stalker', 2, -3, .7), arm = meshOf(c.u.armL), point = centre(arm);
  assert.ok(gore.wound('m', { root: c.g, object: arm, point, normal: { x: 0, y: 0, z: 1 }, size: .06 }));
  gore.update(1 / 60);
  const entry = mesh(gore, 'entry');
  assert.equal(entry.count, 1);
  assert.ok(at(entry, 0).distanceTo(point) < .02, 'placed where it was hit');
  // Swing the arm and walk the creature: the wound follows the arm's surface.
  c.u.armL.rotation.x += 1.1; c.g.position.x += 1.5; c.g.updateMatrixWorld(true);
  const moved = centre(arm);
  gore.update(1 / 60);
  assert.ok(at(entry, 0).distanceTo(moved) < .12 && at(entry, 0).distanceTo(point) > .5, `follows the arm (${at(entry, 0).distanceTo(moved).toFixed(3)} m from it)`);
  c.u.armL.visible = false; gore.update(1 / 60);
  assert.equal(entry.count, 0, 'a hidden arm hides its wounds');
  c.u.armL.visible = true; c.g.visible = false; gore.update(1 / 60);
  assert.equal(entry.count, 0, 'so does a hidden creature');
  c.g.visible = true; gore.update(1 / 60);
  assert.equal(entry.count, 1);
  assert.ok(gore.wound('m', { root: c.g, object: c.g.children.find(n => n.isMesh), point: new THREE.Vector3(2, 1.6, -2.8), normal: { x: 0, y: 0, z: 1 }, kind: 'exit', size: .1 }));
  gore.update(1 / 60);
  assert.equal(mesh(gore, 'exit').count, 1);
  assert.equal(gore.woundsOf('m'), 2);
});

test('wounds are capped per creature and overall, and fewer at low quality or with effects off', () => {
  const run = opts => {
    const { scene, gore } = setup(opts), list = [0, 1, 2, 3, 4, 5].map(i => creature(scene, 'stalker', i * 3, 0));
    for (const [i, c] of list.entries()) {
      for (let k = 0; k < 30; k++) gore.wound(i, { root: c.g, object: meshOf(c.u.armR), point: centre(c.u.armR), normal: { x: 1, y: 0, z: 0 }, size: .05 });
    }
    gore.update(1 / 60);
    const snap = gore.snapshot();
    return { snap, per: list.map((c, i) => gore.woundsOf(i)), rendered: mesh(gore, 'entry').count };
  };
  const high = run({}), low = run({ quality: 'low' }), calm = run({ effects: false });
  assert.ok(high.per.every(n => n === high.snap.caps.perMonster) && high.snap.caps.perMonster === 10, `per creature ${high.per}`);
  assert.equal(high.rendered, 60);
  assert.ok(low.snap.caps.perMonster < 10 && low.per.every(n => n <= low.snap.caps.perMonster));
  assert.ok(low.snap.wounds <= low.snap.caps.wounds && low.snap.caps.wounds < high.snap.caps.wounds);
  assert.ok(calm.snap.caps.splats < high.snap.caps.splats && calm.snap.caps.drops <= high.snap.caps.drops / 2 + 1, 'effects off halves the pools');
  assert.deepEqual([high.snap.quality, low.snap.quality, calm.snap.effects], ['high', 'low', false]);
});

test('sprays splat the floor and the wall behind the creature; wall stains face the shooter', () => {
  const wall = (x, y, z) => x > 2 || y > 3.2;               // a wall face at x = 2
  const { gore } = setup({ blocks: wall, ceiling: 3.2 });
  const n = gore.spray(.5, 1.4, 0, 1, 0, 0, { amount: 2, reach: 2.5 });
  assert.ok(n >= 10, `${n} drops`);
  step(gore, 2);
  const snap = gore.snapshot(), walls = mesh(gore, 'walls'), floor = mesh(gore, 'splats');
  assert.equal(snap.drops, 0, 'every drop has landed');
  assert.ok(snap.walls >= 3 && snap.splats >= 1, `wall ${snap.walls}, floor ${snap.splats}`);
  // In the open the same spray all comes down on the floor, strung out along the shot.
  const open = setup({ ceiling: 3.2 }).gore;
  open.spray(.5, 1.4, 0, 1, 0, 0, { amount: 2, reach: 2.5 });
  step(open, 2);
  const xs = [], spread = mesh(open, 'splats');
  for (let i = 0; i < spread.count; i++) xs.push(at(spread, i).x);
  assert.ok(open.snapshot().splats >= 5 && open.snapshot().walls === 0, `open floor ${open.snapshot().splats}`);
  assert.ok(Math.min(...xs) > .4 && Math.max(...xs) - Math.min(...xs) > .5, `downrange ${Math.min(...xs).toFixed(2)}..${Math.max(...xs).toFixed(2)}`);
  for (let i = 0; i < walls.count; i++) {
    const p = at(walls, i), m = new THREE.Matrix4().fromArray(walls.instanceMatrix.array, i * 16), n2 = new THREE.Vector3(0, 0, 1).transformDirection(m);
    assert.ok(p.x > 1.95 && p.x < 2.01, `on the wall face (${p.x.toFixed(3)})`);
    assert.ok(n2.x < -.95, 'facing back toward the shooter');
  }
  for (let i = 0; i < floor.count; i++) {
    const p = at(floor, i);
    assert.ok(p.y > 0 && p.y < .02 && p.x < 2.01, `on the floor in front of the wall (${p.x.toFixed(2)}, ${p.y.toFixed(3)})`);
  }
  // The ring keeps the newest stains: a hundred more sprays never exceed the cap.
  for (let i = 0; i < 100; i++) gore.spray(0, 1.2, 0, Math.cos(i), 0, Math.sin(i), { amount: 1 });
  step(gore, 2);
  const full = gore.snapshot();
  assert.ok(full.splats === full.caps.splats && full.walls <= full.caps.walls, JSON.stringify(full));
});

test('chunks fly, bounce and lie still on the floor; bone bits come out pale', () => {
  const { gore } = setup();
  assert.equal(gore.chunks(0, 1.8, 0, 0, 0, -1, { count: 12, speed: 4, bone: .5 }), 12);
  let peak = 0;
  for (let i = 0; i < 300; i++) { gore.update(1 / 60); const m = mesh(gore, 'chunks'); for (let k = 0; k < m.count; k++) peak = Math.max(peak, at(m, k).y); }
  const m = mesh(gore, 'chunks'), still = [];
  for (let k = 0; k < m.count; k++) still.push(at(m, k));
  step(gore, 1);
  assert.ok(peak > 1.8, 'thrown up before falling');
  for (let k = 0; k < m.count; k++) {
    const p = at(m, k);
    assert.ok(p.y > 0 && p.y < .05, `resting on the floor (${p.y.toFixed(3)})`);
    assert.ok(p.distanceTo(still[k]) < 1e-6, 'and staying there');
  }
  const colours = Array.from({ length: m.count }, (_, k) => m.instanceColor.array[k * 3 + 1]);
  assert.ok(colours.some(g => g > .5) && colours.some(g => g < .1), 'bone and meat');
  assert.ok(gore.snapshot().splats >= 4, 'landing chunks leave stains');
  const low = setup({ quality: 'low' }).gore;
  assert.ok(low.chunks(0, 1, 0, 1, 0, 0, { count: 12 }) < 12, 'fewer at low quality');
});

test('a severed arm tumbles to the floor of the real rig, takes its wounds, and leaves stumps', () => {
  for (const kind of ['stalker', 'warden', 'shrieker']) {
    const { scene, gore } = setup({ blocks: (x, y) => y > 3.2 });
    const c = creature(scene, kind, 0, 0, .4), arm = c.u.armR, hand = meshOf(c.u.elbows[1]);
    gore.wound('m', { root: c.g, object: hand, point: centre(hand), normal: { x: 1, y: 0, z: 0 }, size: .05 });
    const limb = gore.sever('m', c.g, arm, { dir: { x: 1, z: 0 }, force: 2 });
    assert.ok(limb && limb.parent === scene && arm.visible === false, `${kind} arm torn off`);
    const pairs = [];
    arm.traverse(n => { if (n.isMesh) pairs.push(n); });
    const copies = [];
    limb.traverse(n => { if (n.isMesh) copies.push(n); });
    assert.ok(copies.length === pairs.length && copies.every((n, i) => n.geometry === pairs[i].geometry && n.material === pairs[i].material), 'shares geometry and materials');
    step(gore, 4);
    limb.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(limb, true);
    assert.ok(box.min.y > -.08 && box.min.y < .06, `${kind} limb lies on the floor (${box.min.y.toFixed(3)})`);
    assert.ok(box.max.y < .45, `${kind} lying down (${box.max.y.toFixed(2)})`);
    assert.ok(Math.hypot(box.getCenter(new THREE.Vector3()).x, box.getCenter(new THREE.Vector3()).z) > .5, `${kind} thrown along the shot`);
    const snap = gore.snapshot();
    assert.equal(snap.limbs, 1);
    assert.ok(snap.stumps === 2, `${kind} a stump on the shoulder and one on the arm (${snap.stumps})`);
    assert.equal(mesh(gore, 'entry').count, 1, 'the hand wound went with the arm');
    assert.ok(at(mesh(gore, 'entry'), 0).y < .4, 'and lies on the floor with it');
    assert.deepEqual(gore.severed('m'), ['armR']);
    gore.clear('m');
    assert.equal(arm.visible, true);
    assert.equal(limb.parent, null);
    assert.deepEqual([gore.snapshot().limbs, gore.snapshot().stumps, gore.woundsOf('m')], [0, 0, 0]);
  }
});

test('a decapitation hides the head, caps the neck, throws skull and flesh, and the neck fountains for seconds', () => {
  for (const kind of ['stalker', 'crawler', 'warden']) {
    const { scene, gore } = setup();
    const c = creature(scene, kind, 0, 0, 0), head = c.u.head;
    gore.wound('m', { root: c.g, object: meshOf(head), point: centre(head), normal: { x: 0, y: 0, z: 1 }, size: .05 });
    assert.ok(gore.decapitate('m', c.g, head, { dir: { x: 0, y: 0, z: -1 }, force: 2, chunks: 10 }));
    assert.equal(head.visible, false);
    assert.ok(gore.headless('m'));
    assert.equal(gore.decapitate('m', c.g, head), false, 'only once');
    gore.update(1 / 60);
    const snap = gore.snapshot();
    assert.ok(snap.stumps === 1 && snap.wounds === 0 && snap.chunks >= 8 && snap.fountains === 1, `${kind} ${JSON.stringify(snap)}`);
    const neck = new THREE.Vector3().setFromMatrixPosition(head.matrixWorld), stump = at(mesh(gore, 'stumps'), 0);
    assert.ok(stump.distanceTo(neck) < .02, `${kind} stump where the head was`);
    let pumping = 0;
    for (let i = 0; i < 150; i++) { gore.update(1 / 60); pumping = Math.max(pumping, gore.snapshot().drops); }
    assert.ok(pumping > 10, `${kind} the neck pumps blood (${pumping} drops in flight)`);
    step(gore, 3);
    assert.equal(gore.snapshot().fountains, 0, 'until the heart stops');
    assert.ok(gore.snapshot().splats > 10, `${kind} and it pools on the floor (${gore.snapshot().splats})`);
    gore.clear('m');
    assert.ok(head.visible && !gore.headless('m') && gore.snapshot().stumps === 0);
    assert.ok(gore.snapshot().splats > 10, 'the floor keeps its stains when the creature is reset');
    gore.clear();
    assert.equal(gore.snapshot().splats, 0, 'a new level starts clean');
  }
});

test('the Gravekeeper loses its head on its own rig, and nothing spurts or drips once its body sinks under the floor', () => {
  const { scene, gore } = setup();
  const c = creature(scene, 'gravekeeper'), head = c.u.head;
  gore.wound('m', { root: c.g, object: meshOf(c.u.armR), point: centre(c.u.armR), normal: { x: 0, y: 0, z: 1 } });
  assert.ok(gore.decapitate('m', c.g, head, { dir: { x: 0, y: 0, z: -1 }, force: .5, chunks: 0 }));
  assert.ok(!head.visible && gore.headless('m'));
  gore.bleed('m', c.g, 1.5);
  step(gore, .3);
  assert.ok(gore.snapshot().drops > 0, 'it bleeds on the surface');
  c.g.position.y = -4.1;                 // bossPose: the grave has taken it
  step(gore, 1);
  const stains = gore.snapshot().splats;
  step(gore, 2);
  assert.equal(gore.snapshot().drops, 0, 'not from under the floor');
  assert.equal(gore.snapshot().splats, stains, 'and it leaves no new stains over the grave');
  gore.clear('m');
  assert.ok(head.visible, 'its head is back for the next run');
});

test('wounded creatures drip a trail; corpses pool once they have fallen', () => {
  const { scene, gore } = setup();
  const c = creature(scene, 'stalker');
  gore.wound('m', { root: c.g, object: meshOf(c.u.legL), point: centre(c.u.legL), normal: { x: 0, y: 0, z: 1 } });
  gore.bleed('m', c.g, 1);
  const xs = [];
  for (let i = 0; i < 240; i++) { c.g.position.x = i * .02; gore.update(1 / 60); }
  const floor = mesh(gore, 'splats');
  for (let k = 0; k < floor.count; k++) xs.push(at(floor, k).x);
  assert.ok(xs.length >= 5 && Math.max(...xs) - Math.min(...xs) > 1.5, `a trail of ${xs.length} drips over ${(Math.max(...xs) - Math.min(...xs)).toFixed(2)} m`);
  assert.equal(gore.snapshot().bleeding, 1);
  step(gore, 40);
  assert.equal(gore.snapshot().bleeding, 0, 'bleeding slows and stops');
  gore.pool('m', c.g, { local: { x: 0, y: 1.2, z: 0 }, size: 1, delay: .5, grow: 4 });
  step(gore, .4);
  assert.equal(mesh(gore, 'pools').count, 0, 'waits for the body to land');
  step(gore, .3);
  const pools = mesh(gore, 'pools'), early = new THREE.Vector3().setFromMatrixScale(new THREE.Matrix4().fromArray(pools.instanceMatrix.array, 0)).y;
  step(gore, 5);
  const late = new THREE.Vector3().setFromMatrixScale(new THREE.Matrix4().fromArray(pools.instanceMatrix.array, 0)).y;
  assert.ok(pools.count === 1 && late > 2.5 * early && late <= 1.01, `spreads ${early.toFixed(2)} -> ${late.toFixed(2)} m`);
  assert.ok(Math.abs(at(pools, 0).x - c.g.position.x) < .1 && at(pools, 0).y < .01, 'under the body, on the floor');
});

test('quality can drop at runtime: live pools shrink to the new caps', () => {
  const { scene, gore } = setup();
  const list = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => creature(scene, 'crawler', i, 0));
  for (const [i, c] of list.entries()) for (let k = 0; k < 10; k++) gore.wound(i, { root: c.g, object: meshOf(c.u.head), point: centre(c.u.head), normal: { x: 0, y: 1, z: 0 } });
  for (let i = 0; i < 60; i++) gore.spray(i * .2, 1, 0, 0, 0, 1);
  gore.chunks(0, 1, 0, 0, 0, 1, { count: 24 }); gore.chunks(0, 1, 0, 0, 0, 1, { count: 24 }); gore.chunks(0, 1, 0, 0, 0, 1, { count: 24 });
  step(gore, 2);
  const before = gore.snapshot();
  gore.setQuality('low'); gore.setEffects(false); gore.update(1 / 60);
  const after = gore.snapshot();
  for (const key of ['wounds', 'splats', 'chunks']) assert.ok(after[key] <= after.caps[key] && after[key] < before[key], `${key} ${before[key]} -> ${after[key]}`);
});

// A fresh process: young-generation bytes per update(), first with wounded creatures moving (the steady state of a
// fight), then with every system busy (sprays, chunks, a tumbling arm, a decapitation fountain, a spreading pool).
function allocationProbe(gorePath, visualsPath) {
  const v8 = require('node:v8'), THREE = require('three'), Gore = require(gorePath), fs = require('node:fs'), vm = require('node:vm');
  const newSpace = () => (v8.getHeapSpaceStatistics().find(s => s.space_name === 'new_space') || {}).space_used_size;
  if (typeof v8.GCProfiler !== 'function' || !Number.isFinite(newSpace())) return { skip: 'no GC profiler or new_space statistics' };
  const drawing = () => ({ createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }), getImageData: (_x, _y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData() {}, fillRect() {}, strokeRect() {}, fillText() {}, beginPath() {}, moveTo() {}, lineTo() {}, bezierCurveTo() {}, arc() {}, closePath() {}, fill() {}, stroke() {},
    save() {}, restore() {}, translate() {}, rotate() {}, createLinearGradient: () => ({ addColorStop() {} }), createRadialGradient: () => ({ addColorStop() {} }) });
  const context = { window: {}, document: { createElement: () => { const d = drawing(); return { width: 0, height: 0, getContext: () => d }; } }, WeakMap, Map, Set, Math, Float32Array, Uint8ClampedArray, Object, Array };
  vm.runInNewContext(fs.readFileSync(visualsPath, 'utf8'), context);
  const V = context.window.HollowVisuals, scene = new THREE.Scene();
  const gore = Gore.create({ THREE, scene, blocks: (x, y) => x > 6 || y > 3.2, ceiling: 3.2 });
  const list = ['stalker', 'warden', 'crawler', 'shrieker'].map((kind, i) => { const g = V.makeMonster(THREE, kind); g.position.set(i * 1.5, 0, 0); scene.add(g); g.updateMatrixWorld(true); return g; });
  const meshOf = j => { let f = null; j.traverse(n => { if (!f && n.isMesh) f = n; }); return f; };
  const P = new THREE.Vector3();
  let frame = 0;
  const wounds = () => list.forEach((g, k) => {
    const u = g.userData;
    for (const j of [u.legL, u.armL, u.neck]) gore.wound(k, { root: g, object: meshOf(j), point: P.setFromMatrixPosition(j.matrixWorld), normal: { x: 0, y: 0, z: 1 } });
  });
  const step = (frames, busy) => {
    for (let i = 0; i < frames; i++, frame++) {
      if (busy && frame % 400 === 0) {
        gore.clear(); wounds();
        list.forEach((g, k) => gore.bleed(k, g, 1));
        gore.sever(0, list[0], list[0].userData.armR, { dir: { x: 1, z: 0 }, force: 2 });
        gore.decapitate(1, list[1], list[1].userData.head, { dir: { x: 0, y: 0, z: -1 } });
        gore.chunks(1, 1.5, 0, 1, 0, 0, { count: 16 }); gore.spray(1, 1.4, 0, 1, 0, 0, { amount: 3 });
        gore.pool(2, list[2], { delay: .2 });
      }
      list[3].rotation.y = frame * .01; list[0].userData.armL.rotation.x = Math.sin(frame * .05);
      gore.update(1 / 60);
    }
  };
  const measure = busy => {
    const rounds = [];
    for (let round = 0; round < 16; round++) {
      // Busy rounds start on an event frame (every 400th), which allocates; the 399 frames after it are measured.
      step(1, busy);
      const gc = new v8.GCProfiler();
      gc.start();
      const before = newSpace();
      step(399, busy);
      const after = newSpace();
      rounds.push(gc.stop().statistics.length ? 'gc' : Math.round((after - before) / 399));
    }
    return rounds;
  };
  wounds();
  return { steady: measure(false), busy: measure(true) };
}

test('update() makes next to no garbage per frame', t => {
  const probe = `console.log(JSON.stringify((${allocationProbe})(${JSON.stringify(path.join(__dirname, '../public/gore.js'))}, ${JSON.stringify(path.join(__dirname, '../public/visuals.js'))})))`;
  const child = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', timeout: 180000, cwd: path.join(__dirname, '..') });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout.trim().split('\n').pop());
  if (result.skip) return t.skip(result.skip);
  const median = rounds => { const clean = rounds.slice(4).filter(rate => rate !== 'gc').sort((a, b) => a - b); return clean.length >= 3 ? clean[clean.length >> 1] : Infinity; };
  // Wounds following moving creatures: nothing beyond the probe's own few bytes. Everything at once: a few boxed numbers
  // in the short-lived phases (a limb settling, a fountain, chunks landing): a few kilobytes a second at most.
  t.diagnostic(`median bytes per update: steady ${median(result.steady)}, busy ${median(result.busy)}`);
  assert.ok(median(result.steady) < 40, `steady bytes per update by round: ${result.steady.join(' ')}`);
  assert.ok(median(result.busy) < 400, `busy bytes per update by round: ${result.busy.join(' ')}`);
});
