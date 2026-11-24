'use strict';

// Region hit reactions, kneeling, limping and the killing blow's momentum in monster-anim.js (hit({ region, ... }),
// die({ force, region, gib })). The default API is covered by tests/monster-anim.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const THREE = require('three');
const Anim = require('../public/monster-anim.js');

const KINDS = ['warden', 'stalker', 'crawler', 'shrieker'];
const AXES = ['x', 'y', 'z'], ROOT = ['x', 'y', 'z', 'pitch', 'yaw', 'roll'];

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

function run(anim, seconds, input, { fps = 60, each } = {}) {
  let pose;
  for (let i = 1; i <= Math.round(seconds * fps); i++) { pose = anim.update(1 / fps, input); if (each) each(pose, i / fps); }
  return pose;
}
function channels(pose) {
  const out = [];
  for (const name of Anim.JOINTS) for (const axis of AXES) out.push(pose.joints[name][axis]);
  for (const key of ROOT) out.push(pose.root[key]);
  return out;
}
const maxDiff = (a, b) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);
const idle = extra => ({ speed: 0, state: 'wander', effects: true, ...extra });
const chase = kind => ({ speed: Anim.KINDS[kind].chase, state: 'chase', effects: true });
const at = (joint, axis) => Anim.JOINTS.indexOf(joint) * 3 + AXES.indexOf(axis);
const root = key => Anim.JOINTS.length * 3 + ROOT.indexOf(key);
// Largest signed deviation of every channel from the pre-hit pose over `seconds` after hit(shot).
function reaction(kind, shot, { seconds = .8, seed = 1, effects = true } = {}) {
  const anim = Anim.create(kind, { seed }), base = channels(run(anim, 1, idle({ effects })));
  anim.hit(shot);
  const peak = new Array(base.length).fill(0);
  run(anim, seconds, idle({ effects }), { each: p => channels(p).forEach((v, i) => { const d = v - base[i]; if (Math.abs(d) > Math.abs(peak[i])) peak[i] = d; }) });
  return { peak, anim };
}
const FRONT = { dirX: 0, dirZ: -1, yaw: 0 };                  // shooter in front: the bullet travels to -z

test('region names are exported and region-less hits and deaths behave exactly as before', () => {
  assert.deepEqual([...Anim.REGIONS], ['head', 'neck', 'chest', 'gut', 'armL', 'armR', 'legL', 'legR']);
  for (const kind of KINDS) {
    const plain = Anim.create(kind, { seed: 7 }), named = Anim.create(kind, { seed: 7 });
    for (let f = 0; f < 420; f++) {
      if (f === 40) { plain.hit({ dirX: .4, dirZ: -1, yaw: .3, strength: 1.7 }); named.hit({ dirX: .4, dirZ: -1, yaw: .3, strength: 1.7, region: 'elbow', force: 2 }); }
      if (f === 200) { plain.die({ dirX: .2, dirZ: 1, yaw: .3, headshot: true }); named.die({ dirX: .2, dirZ: 1, yaw: .3, headshot: true, region: null, force: NaN }); }
      assert.deepEqual(channels(named.update(1 / 60, chase(kind))), channels(plain.update(1 / 60, chase(kind))), `${kind} frame ${f}`);
    }
    const snap = Anim.create(kind).snapshot();
    assert.deepEqual([snap.heat, snap.kneeling, snap.limpL, snap.limpR, snap.fold, snap.deathForce, snap.gib, snap.region], [0, 0, 0, 0, 0, 0, 0, -1]);
  }
});

test('a head hit snaps the head sideways along the bullet; a neck hit tilts it hard', () => {
  for (const kind of ['stalker', 'shrieker', 'crawler']) {
    const right = reaction(kind, { dirX: 1, dirZ: -.3, yaw: 0, region: 'head' }).peak, left = reaction(kind, { dirX: -1, dirZ: -.3, yaw: 0, region: 'head' }).peak;
    assert.ok(right[at('head', 'y')] > .2 && left[at('head', 'y')] < -.2, `${kind} head turns with the round: ${right[at('head', 'y')]}, ${left[at('head', 'y')]}`);
    const plain = reaction(kind, { dirX: 1, dirZ: -.3, yaw: 0, headshot: true }).peak;
    assert.ok(Math.abs(plain[at('head', 'y')]) < 1e-9, 'only region hits turn the head');
    const neck = reaction(kind, { ...FRONT, region: 'neck', side: 1 }).peak;
    assert.ok(Math.abs(neck[at('head', 'z')]) > .25 && neck[at('jaw', 'x')] > .4, `${kind} neck shot lolls the head and drops the jaw`);
  }
});

test('arm hits fling that arm and spin the torso off the shoulder; arms barely move the body', () => {
  for (const kind of ['stalker', 'shrieker']) {
    const l = reaction(kind, { ...FRONT, region: 'armL' }).peak, r = reaction(kind, { ...FRONT, region: 'armR' }).peak;
    const chest = reaction(kind, { ...FRONT, region: 'chest' }).peak;
    assert.ok(l[at('armL', 'x')] > .4 && l[at('armL', 'x')] > 3 * Math.abs(l[at('armR', 'x')]), `${kind} armL thrown back (${l[at('armL', 'x')]})`);
    assert.ok(r[at('armR', 'x')] > .4 && r[at('elbowR', 'x')] < -.3, `${kind} armR thrown back, forearm flopping`);
    assert.ok(l[root('yaw')] < -.2 && r[root('yaw')] > .2, `${kind} torso spins toward the struck shoulder (${l[root('yaw')]}, ${r[root('yaw')]})`);
    assert.ok(Math.abs(l[root('pitch')]) < .5 * Math.abs(chest[root('pitch')]), `${kind} an arm hit hardly rocks the torso`);
    // A round through the left side of the chest twists that shoulder back.
    const side = reaction(kind, { ...FRONT, region: 'chest', side: -1 }).peak;
    assert.ok(side[root('yaw')] < -.1, `${kind} chest twist ${side[root('yaw')]}`);
  }
});

test('leg hits buckle that knee and leave a limp that shortens the wounded stride, then heals', () => {
  for (const kind of ['stalker', 'shrieker', 'warden']) {
    const { peak, anim } = reaction(kind, { ...FRONT, region: 'legL', strength: 1.2 });
    assert.ok(peak[at('kneeL', 'x')] > 2 * Math.abs(peak[at('kneeR', 'x')]) && peak[at('kneeL', 'x')] > .12, `${kind} kneeL buckles (${peak[at('kneeL', 'x')]})`);
    assert.ok(peak[root('y')] < -.01, `${kind} the body sags`);
    assert.ok(anim.snapshot().limpL > .1 && anim.snapshot().limpR === 0, `${kind} limp ${anim.snapshot().limpL}`);
    assert.equal(anim.snapshot().region, Anim.REGIONS.indexOf('legL'));
  }
  const stride = limp => {
    const anim = Anim.create('stalker', { seed: 2 });
    run(anim, 1, idle());
    if (limp) for (let i = 0; i < 3; i++) anim.hit({ ...FRONT, region: 'legR', strength: 1 });
    const range = { L: [9, -9], R: [9, -9] };
    run(anim, 3, { speed: Anim.KINDS.stalker.walk, state: 'wander', effects: false }, { each: (p, t) => {
      if (t < 1) return;
      range.L = [Math.min(range.L[0], p.joints.legL.x), Math.max(range.L[1], p.joints.legL.x)];
      range.R = [Math.min(range.R[0], p.joints.legR.x), Math.max(range.R[1], p.joints.legR.x)];
    } });
    return { L: range.L[1] - range.L[0], R: range.R[1] - range.R[0], limp: anim.snapshot().limpR };
  };
  const healthy = stride(false), hurt = stride(true);
  assert.ok(hurt.R / hurt.L < .85 * healthy.R / healthy.L, `the wounded leg steps short: ${JSON.stringify({ healthy, hurt })}`);
  const anim = Anim.create('stalker');
  anim.hit({ ...FRONT, region: 'legR' });
  run(anim, 20, idle());
  assert.ok(anim.snapshot().limpR < .01, 'limps heal');
});

test('gut shots double the creature over with its hands at the wound', () => {
  for (const kind of ['stalker', 'shrieker', 'warden', 'crawler']) {
    const gut = reaction(kind, { ...FRONT, region: 'gut', strength: 1.2 }, { seconds: 1.4 }), chest = reaction(kind, { ...FRONT, region: 'chest' });
    // A shot from the front rocks a chest back; a gut shot folds it forward over the wound.
    assert.ok(gut.peak[root('pitch')] > .1 && chest.peak[root('pitch')] < 0, `${kind} gut ${gut.peak[root('pitch')]} chest ${chest.peak[root('pitch')]}`);
    if (kind !== 'crawler') assert.ok(gut.peak[at('elbowL', 'x')] < -.35 && gut.peak[at('elbowR', 'x')] < -.35, `${kind} elbows curl in`);
    run(gut.anim, 1, idle());
    assert.equal(gut.anim.snapshot().fold, 0, `${kind} straightens up again`);
  }
});

test('reactions scale with the round up to strength 2, heavy kinds resist, and rapid hits stack into a stumble', () => {
  const pitch = (kind, strength, region = 'chest') => Math.abs(reaction(kind, { ...FRONT, region, strength }).peak[root('pitch')]);
  assert.ok(pitch('stalker', .4) < pitch('stalker', 1) && pitch('stalker', 1) < pitch('stalker', 1.8), 'heavier rounds rock harder');
  assert.ok(pitch('stalker', 2) > pitch('stalker', 1) * 1.4, 'strength is no longer capped at 1 for region hits');
  assert.ok(pitch('warden', 1.5) < .4 * pitch('stalker', 1.5), 'the warden barely flinches');
  assert.ok(pitch('warden', 1.5) > .02, 'but it does flinch');
  const knee = (kind, hits, gap) => {
    // Hip height: the root sits under the hips and swings out as the torso pitches about them.
    const hip = p => p.root.y + Anim.KINDS[kind].hip * Math.cos(p.root.pitch) * Math.cos(p.root.roll);
    const anim = Anim.create(kind, { seed: 3 }), y0 = hip(run(anim, 1, idle()));
    let peak = 0, drop = 0;
    for (let i = 0; i < hits; i++) {
      anim.hit({ ...FRONT, region: 'chest', strength: 1 });
      run(anim, gap, idle(), { each: p => { peak = Math.max(peak, p.joints.kneeL.x, p.joints.kneeR.x); drop = Math.min(drop, hip(p) - y0); } });
    }
    return { peak, drop, heat: anim.snapshot().heat, anim };
  };
  const one = knee('stalker', 1, .8), burst = knee('stalker', 5, .1);
  assert.ok(burst.heat > 2.4 && one.heat < 1, `heat builds under fire (${one.heat}, ${burst.heat})`);
  assert.ok(burst.peak > one.peak + .15 && burst.drop < one.drop - .02, `a burst stumbles: knees ${one.peak} -> ${burst.peak}, drop ${one.drop} -> ${burst.drop}`);
  run(burst.anim, 3, idle());
  assert.ok(burst.anim.snapshot().heat < .05, 'heat fades');
});

test('a blown-out leg drops a biped to one knee on the real mesh, and it gets back up', () => {
  const V = visuals();
  for (const kind of ['stalker', 'shrieker']) {
    const g = V.makeMonster(THREE, kind), u = g.userData, anim = Anim.create(kind, { seed: 1 });
    const measure = () => {
      Anim.apply(g, anim.pose, 0, 0, 0); g.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(g, true), head = new THREE.Vector3().setFromMatrixPosition(u.head.matrixWorld);
      const knees = u.knees.map(k => new THREE.Vector3().setFromMatrixPosition(k.matrixWorld).y);
      return { floor: box.min.y, head: head.y, knees };
    };
    run(anim, 1, idle());
    const standing = measure();
    anim.hit({ ...FRONT, region: 'legL', strength: 1.4, kneel: true, kneelSide: 'legL', kneelTime: 1.8 });
    assert.equal(anim.snapshot().kneeling, 1);
    let lowest = Infinity;
    run(anim, 1, idle(), { each: (p, t) => { if (t > .3) lowest = Math.min(lowest, measure().floor); } });
    const down = measure();
    assert.ok(down.head < .8 * standing.head, `${kind} head ${standing.head.toFixed(2)} -> ${down.head.toFixed(2)} m`);
    assert.ok(Math.abs(down.floor) < .06 && lowest > -.07, `${kind} rests on the floor (${down.floor.toFixed(3)}, lowest ${lowest.toFixed(3)})`);
    assert.ok(down.knees[0] < .3 && down.knees[0] < down.knees[1] - .25, `${kind} on the left knee: ${down.knees.map(v => v.toFixed(2))}`);
    // A second blast while down keeps it down instead of dropping it again.
    anim.hit({ ...FRONT, region: 'legR', strength: 1, kneel: true, kneelTime: 1.2 });
    run(anim, .9, idle());
    assert.equal(anim.snapshot().kneeling, 1);
    run(anim, 1.5, idle());
    const up = measure();
    assert.equal(anim.snapshot().kneeling, 0);
    assert.ok(up.head > .95 * standing.head && Math.abs(up.floor - standing.floor) < .04, `${kind} back up: head ${up.head.toFixed(2)}`);
  }
  const crawler = Anim.create('crawler');
  crawler.hit({ ...FRONT, region: 'legL', strength: 2, kneel: true });
  run(crawler, .2, idle());
  assert.equal(crawler.snapshot().kneeling, 0, 'crawlers have no knee to drop to');
});

test('killing blows: blasts throw bodies further and faster, a destroyed head drops in place, leg shots pitch forward', () => {
  const V = visuals();
  const box = g => { g.updateMatrixWorld(true); return new THREE.Box3().setFromObject(g, true); };
  for (const kind of KINDS) {
    const K = Anim.KINDS[kind], g = V.makeMonster(THREE, kind);
    const fall = (shot, effects = true) => {
      const anim = Anim.create(kind, { seed: 2 });
      run(anim, .5, chase(kind));
      anim.die({ yaw: 0, ...shot });
      let flat = Infinity, sunk = Infinity, frame = 0, final;
      const frames = [];
      const pose = run(anim, 4, { dead: true, effects }, { each: (p, t) => {
        if (flat === Infinity && Math.max(Math.abs(p.root.pitch), Math.abs(p.root.roll)) > 1.3) flat = t;
        frames.push([t, channels(p)]);
        if (frame++ % 4) return;
        Anim.apply(g, p, 0, 0, 0); sunk = Math.min(sunk, box(g).min.y);
      } });
      final = channels(pose);
      let still = 0;
      for (const [t, c] of frames) if (maxDiff(c, final) > .02) still = t;
      Anim.apply(g, pose, 0, 0, 0);
      return { pose, flat, sunk, still, rest: box(g).min.y, slide: Math.hypot(pose.root.x, pose.root.z), snap: anim.snapshot() };
    };
    const dir = K.quad ? { dirX: 1, dirZ: 0 } : { dirX: 0, dirZ: -1 };
    const plain = fall(dir), blast = fall({ ...dir, force: 3 }), gib = fall({ ...dir, headshot: true, gib: true, region: 'head', force: 1 });
    const head = fall({ ...dir, headshot: true });
    for (const [label, f] of [['plain', plain], ['blast', blast], ['gib', gib]]) {
      const tilt = K.quad ? Math.abs(f.pose.root.roll) : Math.abs(f.pose.root.pitch);
      assert.ok(tilt >= 1.35 && tilt <= 1.65, `${kind} ${label} lies flat (${tilt})`);
      assert.ok(f.sunk >= -.15 && f.rest >= -.15 && f.rest <= .06, `${kind} ${label} stays on the floor (${f.sunk.toFixed(3)}, ${f.rest.toFixed(3)})`);
      assert.ok(f.still < K.death.T + 1.7, `${kind} ${label} lies still by ${f.still}s`);
    }
    assert.ok(blast.flat < plain.flat - .05 && blast.slide > plain.slide * 1.3, `${kind} blast: flat ${plain.flat} -> ${blast.flat}s, slide ${plain.slide.toFixed(2)} -> ${blast.slide.toFixed(2)}`);
    assert.ok(gib.flat <= head.flat, `${kind} a destroyed head drops at least as fast as a headshot`);
    if (!K.quad) {
      assert.ok(gib.slide < .5 * plain.slide, `${kind} a destroyed head drops where it stood (${gib.slide.toFixed(2)} vs ${plain.slide.toFixed(2)})`);
      assert.equal(blast.snap.deathMode, Anim.MODES.back, 'a blast from the front throws it onto its back');
      const leg = fall({ dirX: .2, dirZ: -1, region: 'legL', force: .8 });
      assert.equal(leg.snap.deathMode, Anim.MODES.front, `${kind} shot through the leg from the front still pitches forward`);
      assert.ok(leg.pose.root.pitch > 1.35, `${kind} leg death face down (${leg.pose.root.pitch})`);
      assert.ok(leg.sunk >= -.15 && leg.rest <= .06, `${kind} leg death on the floor`);
      const sideways = fall({ dirX: 1, dirZ: .05, force: 2 });
      assert.equal(sideways.snap.deathMode, Anim.MODES.front, `${kind} a heavy sideways blast falls along the shot, not at random`);
    }
    assert.deepEqual([gib.snap.gib, gib.snap.deathForce, gib.snap.region, blast.snap.deathForce, plain.snap.gib], [1, 1, 0, 3, 0]);
    // Without effects the same corpse lies in the same place (spasms end before it settles).
    assert.ok(maxDiff(channels(fall({ ...dir, gib: true, force: 2 }, false).pose), channels(fall({ ...dir, gib: true, force: 2 }, true).pose)) < 1e-9, `${kind} gib corpse`);
  }
});

// A call made before frame i takes effect over that frame, i.e. at (i - 1) / fps: event times differ by under a frame
// between rates, so poses are compared once each reaction has run its course.
test('region reactions, kneeling and violent deaths agree at 30, 60 and 144 fps', () => {
  for (const kind of KINDS) {
    const script = fps => {
      const anim = Anim.create(kind, { seed: 9 });
      for (let i = 1; i <= 3.5 * fps; i++) {
        if (i === fps / 2) anim.hit({ dirX: .3, dirZ: -1, yaw: 0, region: 'legL', strength: 1.5, kneel: true, kneelTime: 1.2 });
        if (i === fps) anim.hit({ dirX: -1, dirZ: -.2, yaw: 0, region: 'armR', strength: 1.2 });
        if (i === 1.5 * fps) anim.hit({ dirX: 0, dirZ: -1, yaw: 0, region: 'gut', strength: 1 });
        anim.update(1 / fps, idle());
      }
      const live = channels(anim.pose);
      anim.die({ dirX: 0, dirZ: -1, yaw: 0, force: 2.5, region: 'chest' });
      return { live, corpse: channels(run(anim, 4, { dead: true, effects: true }, { fps })) };
    };
    const [a, b, c] = [30, 60, 144].map(script);
    for (const other of [a, c]) {
      assert.ok(maxDiff(other.live, b.live) < .01, `${kind} live pose differs by ${maxDiff(other.live, b.live)}`);
      assert.ok(maxDiff(other.corpse, b.corpse) < 1e-9, `${kind} corpse differs by ${maxDiff(other.corpse, b.corpse)}`);
    }
  }
});

test('fuzzed region hits and deaths never produce NaN or out-of-range poses', () => {
  let s = 99;
  const rand = () => { s = s * 16807 % 2147483647; return s / 2147483647; }, pick = list => list[Math.floor(rand() * list.length)];
  const junk = [NaN, Infinity, -Infinity, -1e9, -1, 0, .5, 1, 1.7, 2, 9, 1e9, '1', null, undefined, {}, true];
  const regions = [...Anim.REGIONS, 'tail', '', null, undefined, 3];
  for (const kind of [...KINDS, 'bogus']) {
    const anim = Anim.create(kind, { seed: 3 }), H = Anim.KINDS[anim.kind].height;
    for (let f = 0; f < 2400; f++) {
      const r = rand();
      if (r < .05) anim.hit({ dirX: pick(junk), dirZ: pick(junk), yaw: pick(junk), strength: pick(junk), region: pick(regions), side: pick(junk),
        kneel: pick([true, false, 1, NaN]), kneelSide: pick(['legL', 'legR', 'x', null]), kneelTime: pick(junk), headshot: pick([true, false]) });
      else if (r < .056) anim.die({ dirX: pick(junk), dirZ: pick(junk), force: pick(junk), region: pick(regions), gib: pick([true, false, NaN]), headshot: pick([true, false]) });
      else if (r < .06) anim.reset();
      const pose = anim.update(pick([1 / 60, 1 / 30, 1 / 144, .1]), { speed: rand() * 6, state: 'chase', effects: rand() < .7 });
      for (const v of channels(pose)) assert.ok(Number.isFinite(v), `${kind} frame ${f}`);
      assert.ok(pose.root.y >= -.4 * H - 1e-9 && pose.root.y <= H, `${kind} frame ${f} root.y ${pose.root.y}`);
      for (const name of Anim.JOINTS) for (const axis of AXES) assert.ok(Math.abs(pose.joints[name][axis]) <= Math.PI);
    }
    for (const [key, value] of Object.entries(anim.snapshot())) assert.ok(Number.isFinite(value), `${kind} snapshot.${key}`);
  }
});

// Runs in a fresh process like the probe in tests/monster-anim.test.js, with region hits, kneels and violent deaths.
function allocationProbe(modulePath) {
  const v8 = require('node:v8'), Anim = require(modulePath);
  const newSpace = () => (v8.getHeapSpaceStatistics().find(s => s.space_name === 'new_space') || {}).space_used_size;
  if (typeof v8.GCProfiler !== 'function' || !Number.isFinite(newSpace())) return { skip: 'no GC profiler or new_space statistics' };
  const anims = ['warden', 'stalker', 'crawler', 'shrieker'].map((kind, i) => Anim.create(kind, { seed: i }));
  const input = { speed: 1.5, state: 'chase', turn: .3, lunge: 0, watched: false, effects: true, time: 0 };
  const hit = { dirX: .3, dirZ: -1, yaw: 0, region: 'legL', strength: 1.4, kneel: true, kneelSide: 'legL', kneelTime: 1.4 };
  const gut = { dirX: -.3, dirZ: -1, yaw: 0, region: 'gut', strength: 1 }, death = { dirX: 0, dirZ: -1, yaw: 0, force: 2, region: 'head', gib: true, headshot: true };
  let frame = 0;
  const step = frames => {
    for (let i = 0; i < frames; i++, frame++) {
      input.time = frame / 60;
      for (let k = 0; k < 4; k++) {
        const anim = anims[k];
        if (frame % 600 === 0) anim.reset();
        if (frame % 600 === 30) anim.hit(hit);
        if (frame % 600 === 150) anim.hit(gut);
        if (frame % 600 === 400 && k % 2) anim.die(death);
        anim.update(1 / 60, input);
      }
    }
  };
  const rounds = [];
  for (let round = 0; round < 40; round++) {
    const gc = new v8.GCProfiler();
    gc.start();
    const before = newSpace();
    step(2500);
    const after = newSpace();
    if (gc.stop().statistics.length) { rounds.push('gc'); continue; }
    rounds.push(Math.round((after - before) / 1e3) / 10);
    if (round >= 3 && rounds.slice(-2).every(rate => rate < 24)) break;
  }
  return { rounds };
}

test('kneeling and region reactions do not allocate per frame', t => {
  const probe = `console.log(JSON.stringify((${allocationProbe})(${JSON.stringify(path.join(__dirname, '../public/monster-anim.js'))})))`;
  const child = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', timeout: 120000 });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  if (result.skip) return t.skip(result.skip);
  const clean = result.rounds.slice(3).filter(rate => rate !== 'gc');
  assert.ok(clean.length >= 2 && clean.slice(-2).every(rate => rate < 24), `bytes per update by round: ${result.rounds.join(' ')}`);
});
