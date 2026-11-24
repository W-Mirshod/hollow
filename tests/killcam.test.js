'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const KillCam = require('../public/killcam');

const KINDS = ['warden', 'stalker', 'crawler', 'shrieker', 'gravekeeper'];
const { LIMITS, REDUCED } = KillCam;

// Plays a whole kill at `fps`; calls onFrame(pose, events) after every step (events copied out of the pose).
function play(kind, { fps = 60, options = {}, face = null, onFrame, until = Infinity } = {}) {
  const cam = KillCam.create(), seen = [];
  let pose = cam.start(kind, options);
  for (let i = 0; i < pose.eventCount; i++) seen.push(pose.events[i]);
  if (onFrame) onFrame(pose, pose.events.slice(0, pose.eventCount));
  for (let i = 0; i < 10000 && !pose.done && pose.t < until; i++) {
    pose = cam.update(1 / fps, face);
    const events = pose.events.slice(0, pose.eventCount);
    seen.push(...events);
    if (onFrame) onFrame(pose, events);
  }
  return { cam, pose, seen };
}
// Steps at `fps` up to just short of `at`, then lands on it exactly.
function poseAt(kind, at, fps, options) {
  const cam = KillCam.create();
  cam.start(kind, options);
  while (cam.pose.t + 1 / fps < at) cam.update(1 / fps);
  cam.update(at - cam.pose.t);
  return cam.pose;
}
const values = pose => [...Object.values(pose.cam), ...Object.values(pose.mon), ...Object.values(pose.fx), ...pose.joints];
function assertFinite(pose, where) {
  for (const v of values(pose)) assert.ok(Number.isFinite(v), `${where}: every pose value is finite`);
}
function assertBounded(pose, where) {
  const c = pose.cam;
  assert.ok(Math.abs(c.x) <= LIMITS.x + .05, `${where}: camera x ${c.x}`);
  assert.ok(c.y >= LIMITS.yMin - .05 && c.y <= LIMITS.yMax + .05, `${where}: camera y ${c.y}`);
  assert.ok(c.f >= LIMITS.fMin - .1 && c.f <= LIMITS.fMax + .1, `${where}: camera f ${c.f}`);
  assert.ok(Math.abs(c.pitch) <= LIMITS.pitch && Math.abs(c.roll) <= LIMITS.roll, `${where}: camera pitch/roll`);
  assert.ok(c.fov >= LIMITS.fov[0] && c.fov <= LIMITS.fov[1], `${where}: fov ${c.fov}`);
  for (const j of pose.joints) assert.ok(Math.abs(j) < Math.PI, `${where}: joint override within half a turn`);
  for (const k of ['black', 'gun']) assert.ok(pose.fx[k] >= 0 && pose.fx[k] <= 1, `${where}: fx.${k} in [0, 1]`);
  assert.ok(pose.fx.light >= 0 && pose.fx.light <= 1.5 && pose.fx.flash >= 0 && pose.fx.flash <= 1.5, `${where}: light and flash`);
}

test('loads as CommonJS and as a browser global, frozen and DOM free', () => {
  const sandbox = {};
  vm.runInNewContext(readFileSync(require.resolve('../public/killcam'), 'utf8'), sandbox, { filename: 'killcam.js' });
  assert.equal(typeof sandbox.HollowKillCam.create, 'function');
  assert.deepEqual([...sandbox.HollowKillCam.KINDS], [...KillCam.KINDS]);
  assert.ok(Object.isFrozen(KillCam) && Object.isFrozen(KillCam.TRACKS) && Object.isFrozen(KillCam.FACE) && Object.isFrozen(KillCam.LINES));
  assert.ok(Object.isFrozen(KillCam.create()));
});

test('every creature kind has its own kill, its own death line and a face anchor; anything else gets the maul', () => {
  for (const kind of KINDS) {
    assert.ok(KillCam.KINDS.includes(kind), kind);
    assert.equal(KillCam.trackFor(kind).kind, kind);
    assert.equal(KillCam.FACE[kind].length, 3);
    assert.match(KillCam.LINES[kind], /^The \w+ .+\.$/);
    assert.equal(KillCam.trackFor(kind).line, KillCam.LINES[kind]);
  }
  for (const kind of ['maul', 'ghoul', undefined, null, 42, '__proto__', 'constructor', 'toString']) assert.equal(KillCam.trackFor(kind).kind, 'maul');
  const cam = KillCam.create();
  assert.equal(cam.start('mystery').track, 'maul');
  assert.equal(cam.pose.kind, 'mystery');
  assert.equal(cam.start({}).kind, 'maul');
  const lines = new Set(KillCam.KINDS.map(k => KillCam.trackFor(k).line));
  assert.equal(lines.size, KillCam.KINDS.length, 'No two kills share a death line');
});

test('tracks are well formed: 2.5 to 4 s, blackout before the end, skip window inside it, events valid and sorted', () => {
  for (const kind of KillCam.KINDS) {
    const T = KillCam.trackFor(kind);
    assert.ok(T.duration >= 2.5 && T.duration <= 4, `${kind}: duration ${T.duration}`);
    assert.ok(T.skip >= 1.2 && T.skip < T.skipTo && T.skipTo < T.black && T.black < T.duration, `${kind}: skip/black order`);
    assert.ok(T.phases.length >= 4 && T.phases[0][0] === 0, `${kind}: phases`);
    for (let i = 1; i < T.phases.length; i++) assert.ok(T.phases[i][0] > T.phases[i - 1][0], `${kind}: phases in order`);
    for (let i = 0; i < T.events.length; i++) {
      const e = T.events[i];
      assert.ok(KillCam.EVENT_TYPES.includes(e.type), `${kind}: event type ${e.type}`);
      assert.ok(e.t >= 0 && e.t < T.duration, `${kind}: event inside the kill`);
      assert.ok(i === 0 || e.t >= T.events[i - 1].t, `${kind}: events sorted`);
      for (const k of ['a', 'b', 'c']) assert.ok(Number.isFinite(e[k]), `${kind}: event args finite`);
      if (e.type === 'sfx' || e.type === 'voice') assert.equal(typeof e.cue, 'string');
    }
    const count = type => T.events.filter(e => e.type === type).length;
    assert.ok(count('hit') >= 3, `${kind}: at least three blows`);
    assert.ok(count('blood') + count('dirt') >= 3, `${kind}: the lens gets painted`);
    assert.ok(count('sfx') >= 8, `${kind}: enough gore audio`);
    assert.equal(count('flat'), 1, `${kind}: exactly one flatline`);
    assert.ok(T.events.find(e => e.type === 'flat').t <= T.black, `${kind}: the flatline starts before the blackout`);
    assert.equal(T.events.find(e => e.type === 'gun') !== undefined, true, `${kind}: the gun is knocked away`);
  }
});

test('the keyframe helpers reject bad keys and sample the eases inside their range', () => {
  assert.throws(() => KillCam.K(0, NaN), /Bad key/);
  assert.throws(() => KillCam.K(0, 1, 1, 2, 'x'), /Bad key/);
  const keys = KillCam.K(0, 0, 1, 10, 'l', 2, 20, 'o', 3, 30, 'i', 4, 40, 'h', 5, 50);
  assert.equal(KillCam.sample(keys, -1), 0);
  assert.equal(KillCam.sample(keys, .5), 5);
  assert.equal(KillCam.sample(keys, 9), 50);
  assert.ok(KillCam.sample(keys, 1.5) > 15, 'o: fast first');
  assert.ok(KillCam.sample(keys, 2.5) < 25, 'i: slow first');
  assert.equal(KillCam.sample(keys, 3.99), 30, 'h: holds until the key');
});

test('every kill plays to the end with finite, bounded values and finishes fully black', () => {
  for (const kind of KillCam.KINDS) {
    const T = KillCam.trackFor(kind);
    let frames = 0, maxY = 0, minY = 9;
    const { pose, seen } = play(kind, { onFrame(p) {
      frames++; assertFinite(p, kind); assertBounded(p, kind);
      maxY = Math.max(maxY, p.cam.y); minY = Math.min(minY, p.cam.y);
      if (p.t >= T.black) assert.ok(p.fx.black > .999, `${kind}: black from ${T.black} s on`);
    } });
    assert.equal(pose.done, true, kind);
    assert.ok(Math.abs(pose.t - T.duration) < 1e-9, `${kind}: ends at its duration`);
    assert.equal(pose.fx.black, 1, `${kind}: ends black`);
    assert.ok(Math.abs(frames - T.duration * 60) <= 2, `${kind}: ${frames} frames at 60 fps`);
    assert.equal(seen.length, T.events.length, `${kind}: every event fires once`);
    assert.deepEqual(seen, T.events.slice(), `${kind}: in order`);
    assert.ok(minY < .5 || maxY > 2.4, `${kind}: the survivor ends up on the floor or off the ground`);
    const phases = [];
    play(kind, { onFrame(p) { if (phases[phases.length - 1] !== p.phase) phases.push(p.phase); } });
    assert.deepEqual(phases, T.phases.map(p => p[1]), `${kind}: plays every phase in order`);
    // Done stays done; further updates neither move nor re-emit.
    const cam = KillCam.create();
    cam.start(kind);
    while (!cam.pose.done) cam.update(.05);
    const before = values(cam.pose);
    cam.update(.05);
    assert.equal(cam.pose.eventCount, 0);
    assert.deepEqual(values(cam.pose), before);
  }
});

test('the creature stays in frame through the attack, and the camera follows the face it is given', () => {
  // Angle between the camera's forward axis and the creature's face (body frame: x right, y up, f forward).
  const offAxis = (c, x, y, f) => {
    const dx = x - c.x, dy = y - c.y, df = f - c.f, d = Math.hypot(dx, dy, df), cp = Math.cos(c.pitch);
    return Math.acos(Math.max(-1, Math.min(1, (-Math.sin(c.yaw) * cp * dx + Math.sin(c.pitch) * dy + Math.cos(c.yaw) * cp * df) / d)));
  };
  for (const kind of KINDS) {
    let inFrame = 0, frames = 0;
    play(kind, { until: KillCam.trackFor(kind).skip, onFrame(p) {
      if (p.t < .3) return;
      frames++;
      const m = p.mon, c = p.cam;
      if (offAxis(c, m.x + m.follow * c.x, m.y + m.follow * c.y, m.f + m.follow * c.f) < .62) inFrame++;
    } });
    // (The Gravekeeper's kill looks down at the spike through the chest for a moment.)
    assert.ok(inFrame > frames * .6, `${kind}: face in frame on ${inFrame}/${frames} frames`);
    // A measured face pulls the aim with it.
    const cam = KillCam.create();
    cam.start(kind);
    while (cam.pose.t < .3 || cam.pose.cam.look < .8) cam.update(1 / 60);
    const a = Object.assign({}, cam.pose.cam), probe = { x: a.x + .6, y: a.y, f: a.f + 1 };
    cam.update(0, probe);
    assert.ok(offAxis(cam.pose.cam, probe.x, probe.y, probe.f) < offAxis(a, probe.x, probe.y, probe.f) - .2, `${kind}: turns toward the measured face`);
  }
});

test('the same kill at 30, 60 and 144 fps lands on the same pose', () => {
  for (const kind of KillCam.KINDS) {
    for (const at of [.47, 1.234, 2.051, KillCam.trackFor(kind).duration - .1]) {
      const ref = values(poseAt(kind, at, 60, { seed: 3 }));
      for (const fps of [30, 144]) {
        const got = values(poseAt(kind, at, fps, { seed: 3 }));
        got.forEach((v, i) => assert.ok(Math.abs(v - ref[i]) < 1e-6, `${kind} @${at}s ${fps} fps: channel ${i} ${v} vs ${ref[i]}`));
      }
    }
  }
});

test('update reuses one pose object and survives garbage input', () => {
  const cam = KillCam.create();
  const pose = cam.start('stalker', { yaw0: NaN, pitch0: Infinity, eye0: -5, dist0: 1e9, back: -1, left: NaN, right: 'x', ceiling: 0, seed: NaN });
  assertFinite(pose, 'garbage start');
  for (const dt of [NaN, -1, Infinity, 1e9, .016, undefined]) {
    assert.equal(cam.update(dt, { x: NaN, y: Infinity, f: undefined }), pose);
    assertFinite(pose, `dt ${dt}`);
    assertBounded(pose, `dt ${dt}`);
  }
  assert.equal(cam.update(.016, { x: 0, y: pose.cam.y, f: pose.cam.f }), pose, 'face at the eye is ignored');
  assertFinite(pose, 'face at the eye');
  cam.stop();
  assert.equal(pose.active, false);
  const t = pose.t;
  cam.update(.5);
  assert.equal(pose.t, t, 'A stopped kill does not run');
  assert.equal(pose.eventCount, 0);
});

test('the opening whips round from wherever the survivor was looking', () => {
  for (const kind of KINDS) {
    const cam = KillCam.create();
    cam.start(kind, { yaw0: 2.6, pitch0: -.6, eye0: 1.1 });
    assert.ok(Math.abs(cam.pose.cam.yaw - 2.6) < .05 && Math.abs(cam.pose.cam.pitch + .6) < .05, `${kind}: starts on the old view`);
    assert.ok(Math.abs(cam.pose.cam.y - 1.1) < .05, `${kind}: starts at the crouched eye`);
    while (cam.pose.t < .32) cam.update(1 / 60);
    const free = poseAt(kind, cam.pose.t, 60, {});
    assert.ok(Math.abs(cam.pose.cam.yaw - free.cam.yaw) < 1e-6, `${kind}: whip is over by 0.3 s`);
  }
});

test('walls and ceilings pull the camera in instead of through them', () => {
  for (const kind of KillCam.KINDS) {
    let back = 0, high = 0, side = 0;
    play(kind, { options: { back: .6, left: .5, right: .5, ceiling: 2.2 }, onFrame(p) {
      back = Math.min(back, p.cam.f); high = Math.max(high, p.cam.y); side = Math.max(side, Math.abs(p.cam.x));
    } });
    assert.ok(back >= -(.6 - .28) - .06, `${kind}: stays off the wall behind (${back})`);
    assert.ok(high <= 2.2 - .22 + .02, `${kind}: stays under the ceiling (${high})`);
    assert.ok(side <= .3, `${kind}: stays off the side walls (${side})`);
  }
});

test('reduced motion keeps the framing but drops most of the roll, zoom and shake', () => {
  for (const kind of KillCam.KINDS) {
    const trace = (motion, seed) => {
      const out = { roll: 0, fov: 0, y: [], f: [], aim: [] };
      play(kind, { options: { motion, seed }, onFrame(p) {
        out.roll = Math.max(out.roll, Math.abs(p.cam.roll)); out.fov = Math.max(out.fov, Math.abs(p.cam.fov));
        out.y.push(p.cam.y); out.f.push(p.cam.f); out.aim.push([p.cam.pitch, p.cam.yaw, p.cam.roll]);
      } });
      return out;
    };
    // The shake is the only seeded part: two seeds differ by exactly that much.
    const shake = (a, b) => a.aim.reduce((s, v, i) => s + Math.abs(v[0] - b.aim[i][0]) + Math.abs(v[1] - b.aim[i][1]) + Math.abs(v[2] - b.aim[i][2]), 0);
    const full = trace(true, 1), calm = trace(false, 1);
    assert.ok(calm.roll <= full.roll * REDUCED.roll + .12, `${kind}: roll ${calm.roll} vs ${full.roll}`);
    assert.ok(calm.fov <= full.fov * REDUCED.fov + 1.5, `${kind}: zoom ${calm.fov} vs ${full.fov}`);
    const fullShake = shake(full, trace(true, 2)), calmShake = shake(calm, trace(false, 2));
    assert.ok(fullShake > .5, `${kind}: there is a shake to drop (${fullShake})`);
    assert.ok(calmShake < fullShake * .15, `${kind}: shake ${calmShake} vs ${fullShake}`);
    const drift = Math.max(...full.y.map((y, i) => Math.abs(y - calm.y[i])), ...full.f.map((f, i) => Math.abs(f - calm.f[i])));
    assert.ok(drift < .08, `${kind}: same framing (${drift})`);
  }
});

test('a click cuts to the end only after the first blows, and the flatline still sounds', () => {
  for (const kind of KillCam.KINDS) {
    const T = KillCam.trackFor(kind), cam = KillCam.create();
    cam.start(kind);
    while (cam.pose.t < T.skip - .1) cam.update(1 / 60);
    assert.equal(cam.skip(), false, `${kind}: too early to skip`);
    while (cam.pose.t < T.skip + .02) cam.update(1 / 60);
    assert.equal(cam.skip(), true, `${kind}: skips`);
    assert.equal(cam.pose.t, T.skipTo);
    assert.equal(cam.pose.skipped, true);
    const now = cam.pose.events.slice(0, cam.pose.eventCount);
    assert.equal(now[now.length - 1].type, 'skip');
    assert.ok(now.every(e => e.type === 'skip' || e.t <= T.skipTo));
    assertFinite(cam.pose, `${kind} skipped`);
    assert.equal(cam.skip(), false, `${kind}: only once`);
    let flats = now.filter(e => e.type === 'flat').length;
    while (!cam.pose.done) { cam.update(1 / 60); flats += cam.pose.events.slice(0, cam.pose.eventCount).filter(e => e.type === 'flat').length; }
    assert.equal(flats, 1, `${kind}: one flatline after a skip`);
    assert.equal(cam.pose.fx.black, 1);
    assert.equal(cam.snapshot().skipped, true);
  }
});

test('snapshot is plain, finite JSON', () => {
  const cam = KillCam.create();
  cam.start('crawler');
  for (let i = 0; i < 40; i++) cam.update(1 / 60);
  const s = cam.snapshot();
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
  assert.equal(s.kind, 'crawler');
  assert.equal(s.active, true);
  assert.ok(s.events > 0 && s.t > .6 && s.duration === KillCam.trackFor('crawler').duration);
  for (const group of ['camera', 'monster', 'fx']) for (const v of Object.values(s[group])) assert.ok(Number.isFinite(v));
});
