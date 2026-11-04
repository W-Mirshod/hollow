'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const THREE = require('three');
const Anim = require('../public/monster-anim.js');

const KINDS = ['warden', 'stalker', 'crawler', 'shrieker'];
const BIPEDS = KINDS.filter(kind => !Anim.KINDS[kind].quad);
const ROOT = ['x', 'y', 'z', 'pitch', 'yaw', 'roll'];
const AXES = ['x', 'y', 'z'];

// Real visuals.js rigs, loaded like tests/visuals.test.js: a VM with a fake 2D canvas. Only the geometry tests use it.
function drawingContext() {
  const image = (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
  const gradient = () => ({ addColorStop() {} });
  let pixels;
  return {
    createImageData: image,
    getImageData: (_x, _y, w, h) => pixels ? { width: w, height: h, data: pixels.data.slice() } : image(w, h),
    putImageData(value) { pixels = { width: value.width, height: value.height, data: value.data.slice() }; },
    fillRect() {}, strokeRect() {}, fillText() {}, beginPath() {},
    moveTo() {}, lineTo() {}, bezierCurveTo() {}, arc() {}, closePath() {}, fill() {},
    stroke() {}, save() {}, restore() {}, translate() {}, rotate() {},
    createLinearGradient: gradient, createRadialGradient: gradient
  };
}
let visualsModule;
function visuals() {
  if (visualsModule) return visualsModule;
  const context = {
    window: {}, document: { createElement: () => {
      const drawing = drawingContext();
      return { width: 0, height: 0, getContext: () => drawing };
    } },
    WeakMap, Map, Set, Math, Float32Array, Uint8ClampedArray, Object, Array
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/visuals.js'), 'utf8'), context);
  return (visualsModule = context.window.HollowVisuals);
}

// Steps `anim` for `seconds` at `fps`; `input` is an update() input or a function of time. each(pose, t) sees
// every frame. update() reuses one pose object, so callers copy what they keep (see channels()).
function run(anim, seconds, input, { fps = 60, t0 = 0, each } = {}) {
  const frames = Math.round(seconds * fps);
  let pose;
  for (let i = 1; i <= frames; i++) {
    const t = t0 + i / fps;
    pose = anim.update(1 / fps, typeof input === 'function' ? input(t) : input);
    if (each) each(pose, t);
  }
  return pose;
}
function channels(pose) {
  const out = [];
  for (const name of Anim.JOINTS) for (const axis of AXES) out.push(pose.joints[name][axis]);
  for (const key of ROOT) out.push(pose.root[key]);
  return out;
}
const JOINT_CHANNELS = Anim.JOINTS.length * 3;
const maxDiff = (a, b, from = 0, to = a.length) => {
  let m = 0;
  for (let i = from; i < to; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};
const mean = values => values.reduce((sum, v) => sum + v, 0) / values.length;
const chase = (kind, extra) => ({ speed: Anim.KINDS[kind].chase, state: 'chase', effects: true, ...extra });
const idle = (extra) => ({ speed: 0, state: 'wander', effects: true, ...extra });
// Biped pivot (hip) height: the root itself is the floor point under the body.
const hipHeight = (kind, pose) => pose.root.y + Anim.KINDS[kind].hip * Math.cos(pose.root.pitch) * Math.cos(pose.root.roll);
// World direction of the torso's up axis: where the head ends up once the body lies down.
const torsoUp = (pose, yaw) => new THREE.Vector3(0, 1, 0)
  .applyEuler(new THREE.Euler(pose.root.pitch, yaw + pose.root.yaw, pose.root.roll, 'YXZ'));
const fellFlat = pose => Math.max(Math.abs(pose.root.pitch), Math.abs(pose.root.roll)) > 1.3;
function prng(seed) {
  let s = seed | 0;
  return () => {
    s = s + 0x6D2B79F5 | 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// Footstep, lean and arm statistics over `seconds` of steady locomotion (after a 2 s warm-up).
function gait(kind, speed, state, { seconds = 10, fps = 60, effects = false } = {}) {
  const anim = Anim.create(kind, { seed: 1 });
  run(anim, 2, { speed, state, effects }, { fps });
  const steps = [], intensity = [], pitch = [], arms = [], yaw = [];
  run(anim, seconds, { speed, state, effects }, { fps, t0: 2, each: pose => {
    if (pose.footstep) { steps.push(pose.footstep); intensity.push(pose.stepIntensity); }
    else assert.equal(pose.stepIntensity, 0, `${kind}: stepIntensity is only set on plant frames`);
    pitch.push(pose.root.pitch); arms.push((pose.joints.armL.x + pose.joints.armR.x) / 2); yaw.push(pose.root.yaw);
  } });
  return {
    rate: steps.length / seconds, steps, intensity: intensity.length ? mean(intensity) : 0,
    pitch: mean(pitch), arms: mean(arms), yawRange: Math.max(...yaw) - Math.min(...yaw)
  };
}

// Kills `anim` (after `alive` seconds of chasing) and steps it until long after it settles.
function kill(kind, shot, { seed = 1, alive = 1, seconds = 4, effects = false, each } = {}) {
  const anim = Anim.create(kind, { seed });
  run(anim, alive, chase(kind, { effects }));
  anim.die(shot);
  const pose = run(anim, seconds, { dead: true, effects }, { each });
  return { anim, pose };
}

test('loads as a browser global and as a CommonJS module with a frozen API', () => {
  const context = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/monster-anim.js'), 'utf8'), context);
  const global = context.HollowMonsterAnim;
  assert.ok(global, 'the UMD wrapper defines globalThis.HollowMonsterAnim without module/define');
  for (const api of [global, Anim]) {
    assert.ok(Object.isFrozen(api));
    for (const name of ['create', 'apply', 'lowest']) assert.equal(typeof api[name], 'function', name);
    assert.deepEqual([...api.JOINTS], ['legL', 'legR', 'armL', 'armR', 'neck', 'head', 'jaw', 'kneeL', 'kneeR', 'elbowL', 'elbowR']);
    assert.deepEqual(Object.keys(api.KINDS).sort(), [...KINDS].sort());
    assert.deepEqual({ ...api.STATES }, { wander: 0, stalk: 1, search: 2, chase: 3 });
    assert.deepEqual({ ...api.MODES }, { alive: 0, back: 1, front: 2, roll: 3 });
    assert.ok(Object.isFrozen(api.KINDS.stalker.death.front.neck), 'tuning tables are deeply frozen');
  }
  // Both builds animate identically (no hidden dependency on Node globals).
  const a = global.create('shrieker', { seed: 9 }), b = Anim.create('shrieker', { seed: 9 });
  for (let i = 0; i < 90; i++) assert.deepEqual(channels(a.update(1 / 60, chase('shrieker'))), channels(b.update(1 / 60, chase('shrieker'))));
});

test('update() mutates and returns one preallocated pose; snapshot() is plain numbers', () => {
  for (const kind of KINDS) {
    const anim = Anim.create(kind, { seed: 1 });
    assert.equal(anim.kind, kind);
    for (const name of ['update', 'hit', 'attack', 'scream', 'die', 'rise', 'reset', 'snapshot']) assert.equal(typeof anim[name], 'function');
    const pose = anim.update(1 / 60, chase(kind)), { joints, root } = pose, legL = joints.legL;
    assert.equal(pose, anim.pose);
    assert.deepEqual(Object.keys(pose), ['joints', 'root', 'footstep', 'stepIntensity', 'mouth']);
    assert.deepEqual(Object.keys(joints), [...Anim.JOINTS]);
    for (const name of Anim.JOINTS) assert.deepEqual(Object.keys(joints[name]), AXES);
    assert.deepEqual(Object.keys(root), ROOT);
    for (let i = 0; i < 120; i++) {
      assert.equal(anim.update(1 / 60, i % 2 ? chase(kind) : undefined), pose);
      if (i === 60) anim.die({ dirX: 0, dirZ: 1 });
    }
    assert.equal(pose.joints, joints); assert.equal(pose.joints.legL, legL); assert.equal(pose.root, root);
    const snap = anim.snapshot();
    assert.notEqual(snap, anim.snapshot(), 'each snapshot is a fresh object');
    for (const [key, value] of Object.entries(snap)) assert.ok(typeof value === 'number' && Number.isFinite(value), `${kind} snapshot.${key}`);
    assert.deepEqual(JSON.parse(JSON.stringify(snap)), snap);
    assert.equal(snap.dead, 1);
  }
  assert.equal(Anim.create('ghost').kind, 'stalker', 'unknown kinds fall back to the stalker');
  assert.equal(Anim.create().kind, 'stalker');
});

test('fuzzed junk inputs and calls never produce NaN or out-of-range poses', () => {
  const rand = prng(20261102), pick = list => list[Math.floor(rand() * list.length)];
  const junk = [NaN, Infinity, -Infinity, -1e9, -3, -0, 0, 1e-12, .3, 1, 2.5, 7, 1e9, '2', null, undefined, {}, [], true];
  const fail = message => assert.fail(message);
  for (const kind of [...KINDS, 'nonsense']) {
    for (let instance = 0; instance < 3; instance++) {
      const opts = rand() < .25 ? pick([null, undefined, 5, 'x']) : {
        seed: pick([0, 1, -7, 2 ** 40, NaN, '3', undefined]), height: pick([undefined, 1, 2.6, 4, NaN, -2, 0, '2']),
        walkSpeed: pick(junk), chaseSpeed: pick(junk)
      };
      const anim = Anim.create(kind, opts), label = `${kind}#${instance}`;
      const h = opts && typeof opts.height === 'number' && opts.height > 0 && Number.isFinite(opts.height)
        ? opts.height : Anim.KINDS[anim.kind].height;
      for (let frame = 0; frame < 1500; frame++) {
        const roll = rand();
        if (roll < .01) anim.hit(rand() < .3 ? pick([null, 5, 'x', undefined]) : { dirX: pick(junk), dirZ: pick(junk), yaw: pick(junk), headshot: pick(junk), strength: pick(junk) });
        else if (roll < .015) anim.attack();
        else if (roll < .02) anim.scream(pick(junk));
        else if (roll < .023) anim.die(rand() < .3 ? pick([null, 5, undefined]) : { dirX: pick(junk), dirZ: pick(junk), yaw: pick(junk), headshot: pick(junk) });
        else if (roll < .026) anim.reset();
        else if (roll < .029) anim.rise(pick(junk));
        const dt = pick([1 / 60, 1 / 60, 1 / 144, 1 / 30, .1, .5, 0, -.1, NaN, Infinity, undefined, '0.016', null]);
        const input = rand() < .04 ? pick([null, undefined, 7, 'chase', []]) : {
          speed: rand() < .7 ? rand() * 14 : pick(junk), state: pick(['wander', 'stalk', 'search', 'chase', 'bogus', 3, null, undefined, {}]),
          lunge: rand() < .85 ? 0 : pick([...junk, 1, .5]), stagger: rand() < .9 ? 0 : pick(junk),
          turn: rand() < .7 ? (rand() - .5) * 10 : pick(junk), watched: pick([true, false, false, NaN, 'yes', 0, 1, undefined]),
          time: rand() < .5 ? undefined : rand() < .8 ? frame / 60 : pick(junk), effects: pick([true, false, 1, 0, NaN, undefined]),
          dead: rand() < .97 ? undefined : pick([true, false, null, NaN, 1])
        };
        const pose = anim.update(dt, input);
        if (pose !== anim.pose) fail(`${label}: update() returned a different object`);
        for (const name of Anim.JOINTS) for (const axis of AXES) {
          const v = pose.joints[name][axis];
          if (!(Number.isFinite(v) && Math.abs(v) <= Math.PI)) fail(`${label} frame ${frame}: ${name}.${axis} = ${v}`);
        }
        const r = pose.root;
        for (const key of ROOT) if (!Number.isFinite(r[key])) fail(`${label} frame ${frame}: root.${key} = ${r[key]}`);
        if (!(r.y >= -.2 && r.y <= h)) fail(`${label} frame ${frame}: root.y = ${r.y} outside [-0.2, ${h}]`);
        if (!(Math.abs(r.x) <= h && Math.abs(r.z) <= h)) fail(`${label} frame ${frame}: root offset ${r.x}, ${r.z}`);
        if (!(Math.abs(r.pitch) <= 1.7 && Math.abs(r.roll) <= 1.7 && Math.abs(r.yaw) <= Math.PI)) fail(`${label} frame ${frame}: root angles`);
        if (![-1, 0, 1].includes(pose.footstep)) fail(`${label}: footstep ${pose.footstep}`);
        if (!(pose.stepIntensity >= 0 && pose.stepIntensity <= 1 && (pose.footstep || pose.stepIntensity === 0))) fail(`${label}: stepIntensity ${pose.stepIntensity}`);
        if (!(pose.mouth >= 0 && pose.mouth <= 1)) fail(`${label}: mouth ${pose.mouth}`);
      }
      for (const [key, value] of Object.entries(anim.snapshot())) assert.ok(Number.isFinite(value), `${label} snapshot.${key}`);
    }
  }
  assert.equal(Anim.lowest('nonsense', null), 0);
  assert.equal(Anim.lowest('warden', { joints: {} }), 0);
  assert.ok(Number.isFinite(Anim.lowest('crawler', { joints: {}, root: { y: NaN, pitch: 'x' } })));
});

test('NaN inputs behave exactly like neutral ones', () => {
  for (const kind of KINDS) {
    const junk = Anim.create(kind, { seed: 4 }), clean = Anim.create(kind, { seed: 4 });
    for (let i = 0; i < 240; i++) {
      const a = junk.update(i % 7 ? 1 / 60 : NaN, { speed: NaN, state: 'chase', turn: NaN, lunge: NaN, stagger: NaN, watched: NaN, time: NaN, effects: NaN });
      const b = clean.update(i % 7 ? 1 / 60 : 0, { speed: 0, state: 'chase', turn: 0, lunge: 0, stagger: 0, watched: false, effects: false });
      assert.deepEqual(channels(a), channels(b), `${kind} frame ${i}`);
    }
  }
});

test('footsteps alternate feet, come faster with speed and carry intensity only on plant frames', () => {
  for (const kind of KINDS) {
    const K = Anim.KINDS[kind];
    const walk = gait(kind, K.walk, 'wander'), sprint = gait(kind, K.chase, 'chase');
    assert.ok(walk.rate > .8, `${kind} walk plants ${walk.rate}/s`);
    assert.ok(sprint.rate > walk.rate * 1.3, `${kind} plants ${walk.rate}/s walking, ${sprint.rate}/s chasing`);
    for (const g of [walk, sprint]) {
      for (let i = 1; i < g.steps.length; i++) assert.equal(g.steps[i], -g.steps[i - 1], `${kind} footsteps alternate`);
    }
    assert.ok(sprint.intensity > walk.intensity && sprint.intensity <= 1 && walk.intensity > 0, `${kind} step intensity ${walk.intensity} -> ${sprint.intensity}`);
    assert.equal(gait(kind, 0, 'wander', { seconds: 4 }).rate, 0, `${kind} makes no footsteps standing still`);
  }
});

test('the crawler skitters: diagonal pairs plant 4-5.5 times a second at chase, with jitter and yaw wiggle', () => {
  const crawler = gait('crawler', Anim.KINDS.crawler.chase, 'chase', { effects: true });
  const warden = gait('warden', Anim.KINDS.warden.chase, 'chase', { effects: true });
  assert.ok(crawler.rate >= 4 && crawler.rate <= 5.5, `crawler plants ${crawler.rate}/s`);
  assert.ok(crawler.rate > warden.rate * 1.5, `crawler ${crawler.rate}/s vs warden ${warden.rate}/s`);
  assert.ok(crawler.yawRange > .25, `crawler yaw wiggle ${crawler.yawRange}`);
});

test('lean grows with speed; the stalker sprints at 20-25 degrees with its arms reaching', () => {
  for (const kind of KINDS) {
    const K = Anim.KINDS[kind];
    const still = gait(kind, 0, 'wander', { seconds: 4 }), walk = gait(kind, K.walk, 'wander'), sprint = gait(kind, K.chase, 'chase');
    assert.ok(walk.pitch > still.pitch && sprint.pitch > walk.pitch + (K.quad ? .03 : .1), `${kind} pitch ${still.pitch} / ${walk.pitch} / ${sprint.pitch}`);
  }
  const stalker = gait('stalker', Anim.KINDS.stalker.chase, 'chase');
  assert.ok(stalker.pitch >= .35 && stalker.pitch <= .44, `stalker sprint lean ${(stalker.pitch * 180 / Math.PI).toFixed(1)} deg`);
  assert.ok(stalker.arms < -.7, `stalker sprint arms ${stalker.arms}`);
});

test('stalkers hunch when stalking; a stare freezes everyone, with micro-twitches only when effects are on', () => {
  const posture = state => {
    const anim = Anim.create('stalker', { seed: 2 }), pitch = [], knees = [];
    run(anim, 2, { speed: 1, state, effects: false });
    run(anim, 4, { speed: 1, state, effects: false }, { each: p => { pitch.push(p.root.pitch); knees.push(p.joints.kneeL.x + p.joints.kneeR.x); } });
    return { pitch: mean(pitch), knees: mean(knees) / 2 };
  };
  const walk = posture('wander'), stalk = posture('stalk');
  assert.ok(stalk.pitch > walk.pitch + .2 && stalk.knees > walk.knees + .5, `stalk hunch ${JSON.stringify({ walk, stalk })}`);
  for (const kind of KINDS) {
    const jitter = effects => {
      const anim = Anim.create(kind, { seed: 2 });
      let prev = channels(run(anim, 1, { speed: 0, state: 'stalk', watched: true, effects })), worst = 0;
      run(anim, 8, { speed: 0, state: 'stalk', watched: true, effects }, { each: p => {
        const now = channels(p);
        worst = Math.max(worst, maxDiff(now, prev, 0, JOINT_CHANNELS)); prev = now;
      } });
      return worst;
    };
    assert.ok(jitter(false) < .01, `${kind} frozen without effects (${jitter(false)})`);
    assert.ok(jitter(true) > .03, `${kind} micro-twitches with effects (${jitter(true)})`);
  }
});

test('turns bank into the curve', () => {
  for (const kind of KINDS) {
    const roll = turn => {
      const anim = Anim.create(kind, { seed: 3 }), rolls = [];
      run(anim, 1.5, chase(kind, { turn, effects: false }));
      run(anim, 2, chase(kind, { turn, effects: false }), { each: p => rolls.push(p.root.roll) });
      return mean(rolls);
    };
    const left = roll(2), right = roll(-2);
    assert.ok(left < -.08 && right > .08, `${kind} banks ${left} turning left, ${right} turning right`);
  }
});

test('idle creatures breathe, track slowly with the head and hang the jaw slack', () => {
  for (const kind of KINDS) {
    const anim = Anim.create(kind, { seed: 4 }), y = [], look = [];
    let step = 0, jaw = Infinity, mouth = 0;
    run(anim, 1, idle({ effects: false }));
    run(anim, 12, idle({ effects: false }), { each: p => {
      if (look.length) step = Math.max(step, Math.abs(p.joints.neck.y - look[look.length - 1]));
      y.push(p.root.y); look.push(p.joints.neck.y); jaw = Math.min(jaw, p.joints.jaw.x); mouth = Math.max(mouth, p.mouth);
    } });
    const breath = Math.max(...y) - Math.min(...y), sweep = Math.max(...look) - Math.min(...look);
    assert.ok(breath > .003 && breath < .03, `${kind} breathing ${breath} m`);
    assert.ok(sweep > .08 && step < .005, `${kind} head tracking sweep ${sweep}, fastest step ${step}`);
    assert.ok(mouth < .3, `${kind} idle mouth ${mouth}`);
    if (!Anim.KINDS[kind].quad) assert.ok(jaw > .015, `${kind} slack jaw ${jaw}`);
  }
});

test('the shrieker throws its head back now and then while chasing; nobody else does', () => {
  for (const kind of KINDS) {
    const anim = Anim.create(kind, { seed: 4 }), neck = [];
    run(anim, 2, chase(kind));
    run(anim, 20, chase(kind), { each: p => neck.push(p.joints.neck.x) });
    const sorted = [...neck].sort((a, b) => a - b), median = sorted[sorted.length >> 1];
    const thrown = neck.filter(v => v < median - .3).length / neck.length;
    if (kind === 'shrieker') {
      assert.ok(sorted[0] < median - .5 && thrown > .01 && thrown < .4, `shrieker head throws: min ${sorted[0]}, median ${median}, ${thrown}`);
    } else assert.equal(thrown, 0, `${kind} never throws its head back mid-chase`);
  }
});

test('lunges drop the body, thrust both arms forward and open the mouth wide', () => {
  for (const kind of KINDS) {
    const anim = Anim.create(kind, { seed: 4 }), arms = [], mouth = [], hips = [], y = [];
    run(anim, 2, chase(kind));
    run(anim, 2, chase(kind), { each: p => {
      arms.push(p.joints.armL.x, p.joints.armR.x); mouth.push(p.mouth); hips.push(hipHeight(kind, p)); y.push(p.root.y);
    } });
    const p = run(anim, .35, chase(kind, { lunge: 1 }));
    const label = `${kind}: run arms ${mean(arms).toFixed(2)} lunge ${p.joints.armL.x.toFixed(2)}/${p.joints.armR.x.toFixed(2)}`;
    assert.ok(Math.max(p.joints.armL.x, p.joints.armR.x) < mean(arms) - .35, label);
    assert.ok(p.mouth > Math.max(.75, mean(mouth) + .3), `${kind} lunge mouth ${p.mouth}`);
    assert.ok(anim.snapshot().lunge > .9);
    if (Anim.KINDS[kind].quad) assert.ok(p.root.y > mean(y), 'the crawler rises into its pounce');
    else assert.ok(hipHeight(kind, p) < mean(hips) - .05, `${kind} hips ${mean(hips).toFixed(3)} -> ${hipHeight(kind, p).toFixed(3)}`);
  }
});

test('screams open the jaw wide and throw the head back, then subside', () => {
  for (const kind of KINDS) {
    const anim = Anim.create(kind, { seed: 4 });
    const before = run(anim, 1, idle()), neck0 = before.joints.neck.x, mouth0 = before.mouth;
    anim.scream(1.5);
    const during = run(anim, .7, idle()), neck = during.joints.neck.x, mouth = during.mouth;
    assert.equal(anim.snapshot().scream, 1);
    assert.ok(mouth > .6 && mouth > mouth0 + .4, `${kind} scream mouth ${mouth0} -> ${mouth}`);
    assert.ok(neck < neck0 - .3, `${kind} head thrown back: neck ${neck0} -> ${neck}`);
    const after = run(anim, 1.5, idle());
    assert.equal(anim.snapshot().scream, 0);
    assert.ok(after.mouth < .4, `${kind} mouth closes after the scream (${after.mouth})`);
  }
  // Requests during a scream extend it: a longer one right after a short one wins (game.js cues a notice roar and the
  // shrieker's call in the same frame), and a late short one only adds half its length.
  const anim = Anim.create('shrieker', { seed: 4 });
  anim.scream(.9); anim.scream(1.6);
  run(anim, 1.5, idle());
  assert.equal(anim.snapshot().scream, 1, 'still screaming 1.5 s into a 1.6 s scream');
  run(anim, .3, idle());
  assert.equal(anim.snapshot().scream, 0);
  anim.scream(1); run(anim, .8, idle()); anim.scream(1);
  run(anim, .5, idle());
  assert.equal(anim.snapshot().scream, 1, 'extended past its original end');
  run(anim, .3, idle());
  assert.equal(anim.snapshot().scream, 0, 'by half the new request');
});

test('attacks wind an arm up and strike within about 0.35 s', () => {
  for (const kind of KINDS) {
    const anim = Anim.create(kind, { seed: 4 });
    const rest = run(anim, 1, chase(kind, { speed: 0 }));
    const rested = Math.min(rest.joints.armL.x, rest.joints.armR.x);
    anim.attack();
    let lowest = Infinity, at = 0, done = -1;
    run(anim, 1, chase(kind, { speed: 0 }), { each: (p, t) => {
      const arm = Math.min(p.joints.armL.x, p.joints.armR.x);
      if (arm < lowest) { lowest = arm; at = t; }
      if (done < 0 && !anim.snapshot().attack) done = t;
    } });
    assert.ok(lowest < rested - .6 && at < .3, `${kind} wind-up ${rested} -> ${lowest} at ${at}s`);
    assert.ok(done > .35 && done < .8, `${kind} attack finishes at ${done}s`);
  }
});

test('hits flinch along the bullet, headshots snap the head back and the warden barely moves', () => {
  const flinch = (kind, shot) => {
    const anim = Anim.create(kind, { seed: 1 });
    const base = channels(run(anim, 1, idle()));
    anim.hit(shot);
    const lo = new Array(base.length).fill(0), hi = new Array(base.length).fill(0);
    run(anim, .6, idle(), { each: p => channels(p).forEach((v, i) => { lo[i] = Math.min(lo[i], v - base[i]); hi[i] = Math.max(hi[i], v - base[i]); }) });
    const at = (joint, axis) => Anim.JOINTS.indexOf(joint) * 3 + AXES.indexOf(axis), root = key => JOINT_CHANNELS + ROOT.indexOf(key);
    return {
      pitchBack: lo[root('pitch')], pitchFwd: hi[root('pitch')], rollLeft: lo[root('roll')], rollRight: hi[root('roll')],
      neck: lo[at('neck', 'x')]
    };
  };
  const pitchBack = {};
  for (const kind of KINDS) {
    const front = flinch(kind, { dirX: 0, dirZ: -1, yaw: 0 });            // shooter in front: bullet travels to -z
    const behind = flinch(kind, { dirX: 0, dirZ: 1, yaw: 0 });
    const side = flinch(kind, { dirX: 1, dirZ: 0, yaw: 0 });              // bullet travels toward the creature's left
    const turned = flinch(kind, { dirX: -1, dirZ: 0, yaw: Math.PI / 2 });  // facing +x, shot from the front
    const head = flinch(kind, { dirX: 0, dirZ: -1, yaw: 0, headshot: true });
    pitchBack[kind] = front.pitchBack;
    // The springs overshoot a little on the rebound; the push along the bullet dominates.
    assert.ok(front.pitchBack < -.05 && -front.pitchBack > 2 * front.pitchFwd, `${kind} snaps back: ${JSON.stringify(front)}`);
    assert.ok(behind.pitchFwd > .05 && behind.pitchFwd > -2 * behind.pitchBack, `${kind} shoved forward from behind: ${JSON.stringify(behind)}`);
    assert.ok(side.rollLeft < -.03 && -side.rollLeft > 2 * side.rollRight, `${kind} rolls along a side hit: ${JSON.stringify(side)}`);
    assert.ok(Math.abs(turned.pitchBack - front.pitchBack) < 1e-9, `${kind} reads the bullet in its own frame`);
    assert.ok(head.neck < -.25 && head.neck < front.neck - .15, `${kind} headshot neck ${head.neck} vs body ${front.neck}`);
  }
  const ratio = pitchBack.warden / pitchBack.stalker;
  assert.ok(ratio > .2 && ratio < .45, `warden flinch is ~0.3x a stalker's (${ratio})`);
});

test('stagger buckles the knees and drops the body', () => {
  for (const kind of KINDS) {
    const anim = Anim.create(kind, { seed: 4 });
    const before = run(anim, 1, idle({ effects: false })), knee = before.joints.kneeL.x, y = before.root.y;
    const p = run(anim, .5, idle({ effects: false, stagger: 1 }));
    assert.ok(p.joints.kneeL.x > knee + .25 && p.joints.kneeR.x > knee + .2, `${kind} knees ${knee} -> ${p.joints.kneeL.x}`);
    assert.ok(p.root.y < y - .03, `${kind} sinks while staggering`);
  }
});

test('deaths fall away from the shooter and end lying still on the floor', () => {
  for (const kind of KINDS) {
    const K = Anim.KINDS[kind];
    for (const yaw of [0, 1.1, 2.6, -2]) {
      const forward = [Math.sin(yaw), Math.cos(yaw)], left = [Math.cos(yaw), -Math.sin(yaw)];
      // [label, bullet direction in world xz]
      const shots = K.quad
        ? [['from its left', [-left[0], -left[1]]], ['from its right', left]]
        : [['from the front', [-forward[0], -forward[1]]], ['from behind', forward], ['from its left', [-left[0], -left[1]]],
          ['from front-right', [(left[0] - forward[0]) / Math.SQRT2, (left[1] - forward[1]) / Math.SQRT2]]];
      for (const [label, dir] of shots) {
        const name = `${kind} yaw ${yaw} shot ${label}`;
        const { anim, pose } = kill(kind, { dirX: dir[0], dirZ: dir[1], yaw });
        const up = torsoUp(pose, yaw), flat = Math.hypot(up.x, up.z);
        assert.ok((up.x * dir[0] + up.z * dir[1]) / flat > .8, `${name}: fell toward ${up.x.toFixed(2)}, ${up.z.toFixed(2)}`);
        const tilt = K.quad ? Math.abs(pose.root.roll) : Math.abs(pose.root.pitch);
        assert.ok(tilt >= 1.35 && tilt <= 1.65, `${name}: lying at ${tilt}`);
        if (label === 'from the front') assert.ok(pose.root.pitch < 0 && anim.snapshot().deathMode === Anim.MODES.back && anim.snapshot().fall === -1, name);
        if (label === 'from behind') assert.ok(pose.root.pitch > 0 && anim.snapshot().deathMode === Anim.MODES.front, name);
        assert.ok(pose.root.y > .1 && pose.root.y < K.height * .5, `${name}: root lifted by the body's thickness (${pose.root.y})`);
        const floor = Anim.lowest(kind, pose);
        assert.ok(floor > -.07 && floor < .005, `${name}: lowest point ${floor}`);
        const snap = anim.snapshot();
        assert.deepEqual([snap.dead, snap.dying, snap.settled], [1, 0, 1]);
        const settled = channels(pose);
        run(anim, 1, { dead: true, effects: true }, { each: p => assert.deepEqual(channels(p), settled, `${name}: corpse stays still`) });
      }
    }
  }
});

test('headshots collapse faster; bodies hit the floor within 1.6 s and stop moving soon after', () => {
  for (const kind of KINDS) {
    const timing = headshot => {
      const shot = Anim.KINDS[kind].quad ? { dirX: 1, dirZ: 0, headshot } : { dirX: 0, dirZ: -1, headshot };
      const frames = [];
      const { pose } = kill(kind, shot, { each: (p, t) => frames.push([t, channels(p), fellFlat(p)]) });
      const final = channels(pose), floor = frames.find(f => f[2]);
      let still = 0;
      for (const [t, c] of frames) if (maxDiff(c, final) > .02) still = t;
      return { floor: floor ? floor[0] : Infinity, still };
    };
    const body = timing(false), head = timing(true);
    assert.ok(body.floor >= .4 && body.floor <= 1.6, `${kind} body shot reaches the floor at ${body.floor}s`);
    assert.ok(head.floor < body.floor - .05, `${kind} headshot ${head.floor}s vs body ${body.floor}s`);
    assert.ok(body.still < 2 && head.still < body.still, `${kind} motion ends at ${body.still}s (headshot ${head.still}s)`);
  }
});

test('the crawler rolls onto its side and curls its legs like a dead insect', () => {
  const { pose } = kill('crawler', { dirX: 1, dirZ: 0, yaw: 0 });   // shot from its right: the top goes toward +x
  assert.ok(pose.root.roll < -1.35, `rolled ${pose.root.roll}`);
  for (const name of ['legL', 'legR', 'armL', 'armR']) assert.ok(Math.abs(pose.joints[name].z) > 1, `${name} folded ${pose.joints[name].z}`);
  for (const name of ['kneeL', 'kneeR', 'elbowL', 'elbowR']) assert.ok(Math.abs(pose.joints[name].z) > .6, `${name} curled ${pose.joints[name].z}`);
});

test('a dead flag starts a default fall and clearing it revives; hits, attacks and screams are ignored while dying', () => {
  for (const kind of KINDS) {
    const anim = Anim.create(kind, { seed: 6 }), twin = Anim.create(kind, { seed: 6 });
    run(anim, 1, chase(kind)); run(twin, 1, chase(kind));
    for (let i = 0; i < 180; i++) {
      if (i === 20) { anim.hit({ dirX: 1, dirZ: 0, headshot: true }); anim.attack(); anim.scream(2); anim.die({ dirX: 1, dirZ: 0 }); }
      assert.deepEqual(channels(anim.update(1 / 60, { dead: true, effects: true })), channels(twin.update(1 / 60, { dead: true, effects: true })), `${kind} frame ${i}`);
    }
    assert.equal(anim.snapshot().dead, 1);
    assert.equal(anim.snapshot().deathMode, Anim.KINDS[kind].quad ? Anim.MODES.roll : Anim.MODES.back);
    assert.ok(fellFlat(run(anim, 2, { dead: true })), `${kind} lies down`);
    const revived = run(anim, 1, { dead: false, speed: 0, state: 'wander' });
    assert.equal(anim.snapshot().dead, 0);
    assert.ok(Math.abs(revived.root.pitch) < .3 && Math.abs(revived.root.roll) < .3, `${kind} stands again`);
  }
});

test('a sleeping body gets up off the floor in fits and starts, then moves like the living', () => {
  for (const kind of KINDS) {
    const { anim, pose } = kill(kind, { dirX: .3, dirZ: 1 }, { seed: 7 });
    const lying = channels(pose), tilt = p => Math.max(Math.abs(p.root.pitch), Math.abs(p.root.roll));
    anim.rise(.9);
    assert.deepEqual(channels(anim.pose), lying, `${kind} starts exactly where it lay`);
    assert.deepEqual([anim.snapshot().dead, anim.snapshot().dying, anim.snapshot().rising], [0, 0, 1]);
    let up = -1, steps = 0, quarter = 0;
    run(anim, 2.4, idle({ dead: false, speed: Anim.KINDS[kind].walk }), { each: (p, t) => {
      const floor = Anim.lowest(kind, p), rising = anim.snapshot().rising;
      if (rising) {
        assert.ok(floor > -.07 && floor < .04, `${kind} at ${t.toFixed(2)} s: lowest point ${floor.toFixed(3)} while rising`);
        assert.equal(p.footstep, 0, `${kind} takes no steps while rising`);
        if (!quarter && t >= .225) quarter = tilt(p);
      } else if (up < 0) up = t;
      if (up >= 0 && p.footstep) steps++;
    } });
    assert.ok(up > .85 && up < .95, `${kind} stands at ${up} s`);
    assert.ok(quarter > tilt({ root: { pitch: lying[JOINT_CHANNELS + 3], roll: lying[JOINT_CHANNELS + 5] } }) * .6, `${kind} still mostly down a quarter of the way in`);
    assert.ok(tilt(anim.pose) < .3 && hipHeight(kind, anim.pose) > Anim.KINDS[kind].hip * .8, `${kind} ends upright`);
    assert.ok(steps > 0, `${kind} walks off once up`);
    assert.equal(anim.snapshot().rising, 0);
  }
});

test('rising stalls twice on the way up, agrees across frame rates and yields to death or reset', () => {
  for (const kind of KINDS) {
    const rate = [];
    const { anim } = kill(kind, { dirX: 0, dirZ: 1 }, { seed: 2 });
    anim.rise(.9);
    let prev = channels(anim.pose);
    run(anim, .9, idle({ dead: false, effects: false }), { each: p => { const now = channels(p); rate.push(maxDiff(now, prev)); prev = now; } });
    const at = u => rate[Math.min(rate.length - 1, Math.round(u * 54))];
    assert.ok(at(1 / 3) < at(1 / 6) * .5 && at(2 / 3) < at(.5) * .5, `${kind} stalls: ${[1 / 6, 1 / 3, .5, 2 / 3].map(u => at(u).toFixed(3))}`);
    const scripted = fps => {
      const a = kill(kind, { dirX: .5, dirZ: -1 }, { seed: 4 }).anim;
      a.rise(1.2);
      const middle = channels(run(a, .5, idle({ dead: false }), { fps }));
      return [middle, channels(run(a, 1, idle({ dead: false }), { fps, t0: .5 }))];
    };
    const [a, b, c] = [30, 60, 144].map(scripted);
    for (const other of [a, c]) for (const i of [0, 1]) {
      assert.ok(maxDiff(other[i], b[i]) < .01, `${kind} rise ${i ? 'end' : 'middle'} differs by ${maxDiff(other[i], b[i])} across frame rates`);
    }
    const again = kill(kind, { dirX: 0, dirZ: 1 }, { seed: 2 }).anim;
    again.rise(.9); run(again, .3, idle({ dead: false }));
    again.die({ dirX: 0, dirZ: -1 });
    assert.ok(fellFlat(run(again, 3, { dead: true })), `${kind} shot while rising falls again`);
    assert.equal(again.snapshot().rising, 0);
    again.rise(); again.reset();
    assert.deepEqual(again.snapshot(), Anim.create(kind, { seed: 2 }).snapshot(), `${kind} reset() clears a rise`);
  }
});

test('effects=false keeps per-frame motion bounded; settled corpses do not depend on effects', () => {
  for (const kind of KINDS) {
    const K = Anim.KINDS[kind];
    const worst = (input, seconds = 8, setup) => {
      const anim = Anim.create(kind, { seed: 2 });
      let prev = channels(run(anim, 1, input)), joints = 0, root = 0;
      if (setup) setup(anim);
      run(anim, seconds, input, { each: p => {
        const now = channels(p);
        joints = Math.max(joints, maxDiff(now, prev, 0, JOINT_CHANNELS)); root = Math.max(root, maxDiff(now, prev, JOINT_CHANNELS + 3));
        prev = now;
      } });
      return { joints, root };
    };
    const calm = { effects: false };
    assert.ok(worst({ ...calm, speed: 0, state: 'wander' }).joints < .01, `${kind} idle`);
    assert.ok(worst({ ...calm, speed: 0, state: 'stalk', watched: true }).joints < .01, `${kind} watched`);
    assert.ok(worst({ ...calm, speed: K.walk, state: 'stalk' }).joints < .25, `${kind} stalking`);
    const dying = worst({ ...calm, dead: true }, 4, anim => anim.die({ dirX: 0, dirZ: 1 }));
    assert.ok(dying.joints < .25 && dying.root < .15, `${kind} death ${JSON.stringify(dying)}`);
    const plain = kill(kind, { dirX: .3, dirZ: -1 }, { effects: false }).pose, spasming = kill(kind, { dirX: .3, dirZ: -1 }, { effects: true }).pose;
    assert.ok(maxDiff(channels(plain), channels(spasming)) < 1e-9, `${kind} spasms end before the corpse settles`);
  }
});

test('30, 60 and 144 fps agree', () => {
  for (const kind of KINDS) {
    const K = Anim.KINDS[kind];
    const scripted = fps => {
      const anim = Anim.create(kind, { seed: 3 });
      let steps = 0;
      for (let i = 1; i <= 3 * fps; i++) {
        const t = i / fps;
        if (i === fps) anim.hit({ dirX: 0, dirZ: -1, yaw: 0 });
        if (i === 2 * fps) anim.scream(1);
        const pose = anim.update(1 / fps, { speed: t < 1.5 ? K.chase * Math.min(1, t) : K.walk, state: t < 1.5 ? 'chase' : 'search', turn: Math.sin(t), effects: true });
        if (pose.footstep) steps++;
      }
      const sprint = gait(kind, K.chase, 'chase', { fps, seconds: 8 }).steps.length;
      const corpse = Anim.create(kind, { seed: 3 });
      run(corpse, 1, chase(kind), { fps });
      corpse.die({ dirX: .4, dirZ: 1 });
      return { pose: channels(anim.pose), steps, sprint, corpse: channels(run(corpse, 4, { dead: true, effects: true }, { fps })) };
    };
    const [a, b, c] = [30, 60, 144].map(scripted);
    for (const other of [a, c]) {
      assert.ok(maxDiff(other.pose, b.pose) < .01, `${kind} pose differs by ${maxDiff(other.pose, b.pose)}`);
      assert.ok(Math.abs(other.steps - b.steps) <= 1 && Math.abs(other.sprint - b.sprint) <= 1, `${kind} footsteps ${a.sprint}/${b.sprint}/${c.sprint}`);
      assert.ok(maxDiff(other.corpse, b.corpse) < 1e-9, `${kind} corpse differs by ${maxDiff(other.corpse, b.corpse)}`);
    }
  }
});

test('deterministic per seed; reset() restores a fresh animator', () => {
  const script = anim => {
    const trace = [];
    for (let f = 0; f < 600; f++) {
      const t = f / 60;
      if (f === 100) anim.hit({ dirX: .5, dirZ: -1, yaw: .2, headshot: true });
      if (f === 160) anim.scream(1);
      if (f === 260) anim.attack();
      if (f === 420) anim.die({ dirX: 0, dirZ: 1, yaw: 0 });
      const pose = anim.update(1 / 60, { speed: 2 + 2 * Math.sin(t), state: f < 300 ? 'chase' : 'stalk', turn: Math.cos(t), lunge: f > 200 && f < 230 ? 1 : 0, watched: f > 330 && f < 370, effects: true });
      trace.push([...channels(pose), pose.footstep, pose.stepIntensity, pose.mouth]);
    }
    return trace;
  };
  for (const kind of KINDS) {
    const first = script(Anim.create(kind, { seed: 5 }));
    assert.deepEqual(script(Anim.create(kind, { seed: 5 })), first, `${kind} same seed, same motion`);
    const other = script(Anim.create(kind, { seed: 6 }));
    assert.ok(first.some((row, i) => maxDiff(row, other[i]) > 1e-3), `${kind} seeds differ`);
    const reused = Anim.create(kind, { seed: 5 });
    script(reused);
    reused.reset();
    assert.deepEqual(reused.snapshot(), Anim.create(kind, { seed: 5 }).snapshot());
    assert.deepEqual(script(reused), first, `${kind} reset() replays like a fresh animator`);
  }
});

// Runs in a fresh process (see below): young-generation bytes per update() over rounds of 10k updates (four kinds,
// live and dying, occasional die()/reset() events included) until the JIT settles. Rounds with a GC are skipped.
function allocationProbe(modulePath) {
  const v8 = require('node:v8'), Anim = require(modulePath);
  const newSpace = () => (v8.getHeapSpaceStatistics().find(s => s.space_name === 'new_space') || {}).space_used_size;
  if (typeof v8.GCProfiler !== 'function' || !Number.isFinite(newSpace())) return { skip: 'no GC profiler or new_space statistics' };
  const anims = ['warden', 'stalker', 'crawler', 'shrieker'].map((kind, i) => Anim.create(kind, { seed: i }));
  const input = { speed: 3, state: 'chase', turn: .3, lunge: 0, watched: false, effects: true, time: 0 };
  let frame = 0;
  const step = frames => {
    for (let i = 0; i < frames; i++, frame++) {
      input.time = frame / 60; input.lunge = frame % 300 < 20 ? 1 : 0;
      for (let k = 0; k < 4; k++) {
        const anim = anims[k];
        if (frame % 600 === 0) anim.reset();
        if (frame % 600 === 300 && k % 2) anim.die({ dirX: 1, dirZ: 0, yaw: frame });
        if (frame % 600 === 450 && k % 2) anim.rise(.9);
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

test('update() does not allocate once warmed up', t => {
  // A fresh process, because the fuzz test above fed junk of every shape through this process's copy: once a property
  // load in update() is megamorphic, each read of a double field of the caller's input object copies it into a new
  // heap number. A game passing consistently shaped input objects never gets there. A boxed double costs 16 bytes.
  const probe = `console.log(JSON.stringify((${allocationProbe})(${JSON.stringify(path.join(__dirname, '../public/monster-anim.js'))})))`;
  const child = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', timeout: 120000 });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  if (result.skip) return t.skip(result.skip);
  const clean = result.rounds.slice(3).filter(rate => rate !== 'gc');
  assert.ok(clean.length >= 2 && clean.slice(-2).every(rate => rate < 24), `bytes per update by round: ${result.rounds.join(' ')}`);
});

test('a dozen monsters animate well within a frame budget', () => {
  const anims = Array.from({ length: 12 }, (_, i) => Anim.create(KINDS[i % 4], { seed: i }));
  const start = process.hrtime.bigint();
  for (let f = 0; f < 600; f++) {
    for (let i = 0; i < 12; i++) {
      if (f === 300 && i % 3 === 0) anims[i].die({ dirX: 1, dirZ: 0, yaw: i });
      anims[i].update(1 / 60, { speed: (i % 5) + f / 300, state: i % 2 ? 'chase' : 'stalk', turn: Math.sin(f / 30), effects: true, dead: f >= 300 && i % 3 === 0 });
    }
  }
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(ms < 2000, `7200 updates (cold JIT included) took ${ms.toFixed(0)} ms`);
});

test('apply() writes restPose + offsets and the yawed root onto visuals.js rigs', () => {
  const V = visuals();
  for (const kind of KINDS) {
    const g = V.makeMonster(THREE, kind), u = g.userData, pose = run(Anim.create(kind, { seed: 2 }), 1, chase(kind));
    Anim.apply(g, pose, 2, -3, .7);
    const parts = [u.legL, u.legR, u.armL, u.armR, u.neck, u.head, ...u.knees, ...u.elbows, ...(u.jaw ? [u.jaw] : [])];
    assert.equal(parts.length, kind === 'crawler' ? 10 : 11);
    for (const part of parts) {
      for (const axis of AXES) assert.equal(part.rotation[axis], u.restPose[part.name][axis] + pose.joints[part.name][axis], `${kind}.${part.name}.${axis}`);
    }
    const r = pose.root, c = Math.cos(.7), s = Math.sin(.7);
    assert.equal(g.rotation.order, 'YXZ');
    assert.deepEqual([g.rotation.x, g.rotation.y, g.rotation.z], [r.pitch, .7 + r.yaw, r.roll]);
    assert.ok(Math.abs(g.position.x - (2 + r.x * c + r.z * s)) < 1e-12 && Math.abs(g.position.z - (-3 - r.x * s + r.z * c)) < 1e-12);
    assert.equal(g.position.y, r.y);
    // jointsOnly poses the limbs but leaves the group where game code put it (the caught close-up).
    const other = run(Anim.create(kind, { seed: 3 }), .5, idle());
    g.position.set(1, 2, 3); g.rotation.set(.1, .2, .3, 'XYZ');
    Anim.apply(g, other, 9, 9, 1, true);
    for (const part of parts) assert.equal(part.rotation.x, u.restPose[part.name].x + other.joints[part.name].x, `${kind}.${part.name} jointsOnly`);
    assert.deepEqual([g.position.x, g.position.y, g.position.z, g.rotation.x, g.rotation.y, g.rotation.z, g.rotation.order], [1, 2, 3, .1, .2, .3, 'XYZ']);
    Anim.apply(null, pose); Anim.apply(g, null); Anim.apply(g, { joints: pose.joints }, 0, 0, 0);
  }
});

test('falling and fallen bodies stay on the floor of the real meshes', () => {
  const V = visuals();
  const box = g => { g.updateMatrixWorld(true); return new THREE.Box3().setFromObject(g, true); };
  for (const kind of KINDS) {
    const g = V.makeMonster(THREE, kind), K = Anim.KINDS[kind];
    // The warden's hunched bulk lies ~0.95 m thick (and sinks 6 cm into the floor); the others stay under 0.95 m.
    const ceiling = kind === 'warden' ? 1.1 : .95;
    const shots = K.quad
      ? [['from its right', 1, 0, false], ['from its left', -1, 0, false], ['headshot from its left', -1, 0, true]]
      : [['from the front', 0, -1, false], ['from behind', 0, 1, false], ['headshot from the front', 0, -1, true],
        ['headshot from behind', 0, 1, true], ['from its left', -1, .1, false]];
    for (const [label, dirX, dirZ, headshot] of shots) {
      const name = `${kind} shot ${label}`;
      let frame = 0, sunk = Infinity, when = 0;
      const { pose } = kill(kind, { dirX, dirZ, yaw: 0, headshot }, { alive: .5, seconds: 3.5, effects: true, each: (p, t) => {
        if (frame++ % 5) return;
        Anim.apply(g, p, 0, 0, 0);
        const y = box(g).min.y;
        if (y < sunk) { sunk = y; when = t; }
      } });
      assert.ok(sunk >= -.15, `${name}: sank to ${sunk.toFixed(3)} m at ${when.toFixed(2)} s`);
      Anim.apply(g, pose, 0, 0, 0);
      const corpse = box(g), estimate = Anim.lowest(kind, pose);
      assert.ok(corpse.min.y >= -.15 && corpse.min.y <= .06, `${name}: corpse rests at ${corpse.min.y.toFixed(3)} m`);
      assert.ok(corpse.max.y <= ceiling, `${name}: corpse ${corpse.max.y.toFixed(3)} m tall`);
      assert.ok(Math.abs(estimate - corpse.min.y) < .06, `${name}: lowest() ${estimate.toFixed(3)} vs mesh ${corpse.min.y.toFixed(3)}`);
    }
  }
});

test('lunging hands reach further forward than sprinting ones on the real meshes', () => {
  const V = visuals();
  for (const kind of KINDS) {
    const g = V.makeMonster(THREE, kind), u = g.userData, anim = Anim.create(kind, { seed: 4 });
    const reach = () => {
      Anim.apply(g, anim.pose, 0, 0, 0);
      g.updateMatrixWorld(true);
      return Math.max(new THREE.Box3().setFromObject(u.armL, true).max.z, new THREE.Box3().setFromObject(u.armR, true).max.z);
    };
    run(anim, 2, chase(kind));
    const sprint = [];
    run(anim, 1, chase(kind), { each: () => sprint.push(reach()) });
    run(anim, .35, chase(kind, { lunge: 1 }));
    const lunge = reach();
    assert.ok(lunge > Math.max(...sprint) && lunge > mean(sprint) + .1,
      `${kind} hands reach ${lunge.toFixed(2)} m lunging vs ${mean(sprint).toFixed(2)} (max ${Math.max(...sprint).toFixed(2)}) sprinting`);
  }
});
