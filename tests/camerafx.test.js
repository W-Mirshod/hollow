'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const CameraFX = require('../public/camerafx');

const DEG = Math.PI / 180;
const BASE = Object.freeze({ speed: 0, walkSpeed: 3, runSpeed: 6.8, running: false, crouching: false, aiming: false,
  onGround: true, sliding: false, strafe: 0, lookDX: 0, lookDY: 0, stamina: 1, exhausted: false, danger: 0, health: 100, motion: true });
const input = over => Object.assign({}, BASE, over);
const WALK = input({ speed: 3 }), SPRINT = input({ speed: 6.8, running: true }), CROUCH = input({ speed: 1.5, crouching: true });

// Runs `seconds` at `fps`; `inp` may be a function of the frame start time. Calls onFrame(pose, endTime).
function run(rig, seconds, fps, inp, onFrame) {
  const frames = Math.round(seconds * fps);
  for (let i = 0; i < frames; i++) {
    const pose = rig.update(1 / fps, typeof inp === 'function' ? inp(i / fps) : inp);
    if (onFrame) onFrame(pose, (i + 1) / fps);
  }
}
function flat(pose) {
  return [pose.pos.x, pose.pos.y, pose.pos.z, pose.rot.pitch, pose.rot.yaw, pose.rot.roll, pose.fov,
    pose.weapon.x, pose.weapon.y, pose.weapon.z, pose.weapon.pitch, pose.weapon.yaw, pose.weapon.roll, pose.footstep, pose.stepIntensity];
}
function range(rig, seconds, inp, pick, warm = 2) {
  run(rig, warm, 60, inp);
  let lo = Infinity, hi = -Infinity;
  run(rig, seconds, 60, inp, pose => { const v = pick(pose); lo = Math.min(lo, v); hi = Math.max(hi, v); });
  return hi - lo;
}
function footsteps(rig, seconds, inp, fps = 60) {
  const events = [];
  run(rig, seconds, fps, inp, (pose, time) => { if (pose.footstep) events.push({ time, foot: pose.footstep, intensity: pose.stepIntensity }); });
  return events;
}
const cadenceOf = events => (events.length - 1) / (events[events.length - 1].time - events[0].time);
function assertBounded(pose) {
  for (const v of flat(pose)) assert.ok(Number.isFinite(v), 'pose values must stay finite');
  assert.ok(Math.abs(pose.pos.x) <= .12 && Math.abs(pose.pos.y) <= .2 && Math.abs(pose.pos.z) <= .1);
  for (const k of ['pitch', 'yaw', 'roll']) assert.ok(Math.abs(pose.rot[k]) <= .3 && Math.abs(pose.weapon[k]) <= .45);
  for (const k of ['x', 'y', 'z']) assert.ok(Math.abs(pose.weapon[k]) <= .2);
  assert.ok(pose.fov >= -12 && pose.fov <= 14);
  assert.ok([0, 1, -1].includes(pose.footstep) && pose.stepIntensity >= 0 && pose.stepIntensity <= 1);
}

test('API shape: one mutable pose object, plain-number snapshots', () => {
  const rig = CameraFX.create();
  for (const name of ['update', 'addTrauma', 'kick', 'land', 'punch', 'reset', 'snapshot']) assert.equal(typeof rig[name], 'function');
  const first = rig.update(1 / 60, WALK), { pos, rot, weapon } = first;
  const second = rig.update(1 / 60, SPRINT);
  assert.equal(first, second); assert.equal(rig.pose, first);
  assert.equal(second.pos, pos); assert.equal(second.rot, rot); assert.equal(second.weapon, weapon);
  assert.deepEqual(Object.keys(first).sort(), ['footstep', 'fov', 'pos', 'rot', 'stepIntensity', 'weapon']);
  const snap = rig.snapshot();
  for (const key of ['trauma', 'phase', 'stepRate']) assert.ok(key in snap);
  for (const [key, value] of Object.entries(snap)) assert.ok(typeof value === 'number' && Number.isFinite(value), key);
  assert.ok(Object.isFrozen(CameraFX.TUNING) && Object.isFrozen(CameraFX.TUNING.bob));
});

test('fuzzed garbage inputs never produce NaN and stay bounded', () => {
  const rig = CameraFX.create({ seed: 99 });
  let seed = 12345;
  const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) | 0; return (seed >>> 0) / 4294967296; };
  const junk = [NaN, undefined, null, Infinity, -Infinity, 'x', {}, -5, 1e9, -1e9, true];
  const pick = scale => rand() < .2 ? junk[Math.floor(rand() * junk.length)] : (rand() * 2 - 1) * scale;
  for (let i = 0; i < 6000; i++) {
    const dt = rand() < .1 ? junk[Math.floor(rand() * junk.length)] : rand() < .05 ? rand() * 5 : rand() * .05;
    const inp = rand() < .03 ? junk[Math.floor(rand() * junk.length)] : {
      speed: pick(9), walkSpeed: pick(4), runSpeed: pick(8), running: rand() < .5, crouching: rand() < .2, aiming: rand() < .3,
      onGround: rand() < .8, sliding: rand() < .1, strafe: pick(2), lookDX: pick(.4), lookDY: pick(.4), stamina: pick(1),
      exhausted: rand() < .2, danger: pick(1.5), health: pick(120), motion: rand() < .8 ? true : pick(1)
    };
    if (rand() < .05) rig.addTrauma(pick(2));
    if (rand() < .08) rig.kick(pick(.5), pick(.2));
    if (rand() < .03) rig.land(pick(40));
    if (rand() < .03) rig.punch(pick(3), pick(3));
    assertBounded(rig.update(dt, inp));
  }
  assertBounded(rig.update()); assertBounded(rig.update(1 / 60, null)); assertBounded(rig.update(-1, 'nope'));
  for (const v of Object.values(rig.snapshot())) assert.ok(Number.isFinite(v));
});

test('worst-case stacking (sprint, trauma, kicks, falls, punches, fast look) stays bounded', () => {
  const rig = CameraFX.create({ seed: 3 });
  run(rig, 3, 60, time => {
    rig.addTrauma(1); rig.kick(.3, .3); rig.land(30); rig.punch(1.5, -1.5);
    return input({ speed: 30, running: true, strafe: 1, lookDX: time % .5 < .25 ? 2 : -2, lookDY: 1, exhausted: true, stamina: 0, danger: 1, health: 0 });
  }, assertBounded);
});

test('footstep cadence follows the gait and alternates feet', () => {
  const walk = footsteps(CameraFX.create(), 12, WALK).slice(2);
  const sprint = footsteps(CameraFX.create(), 12, SPRINT).slice(2);
  const crouch = footsteps(CameraFX.create(), 12, CROUCH).slice(2);
  assert.ok(Math.abs(cadenceOf(walk) - 2) < .05, `walk ${cadenceOf(walk)}`);
  assert.ok(cadenceOf(sprint) >= 2.88 && cadenceOf(sprint) <= 3.02, `sprint ${cadenceOf(sprint)}`);
  assert.ok(cadenceOf(crouch) < 1.6 && cadenceOf(crouch) > 1, `crouch ${cadenceOf(crouch)}`);
  for (const events of [walk, sprint, crouch]) {
    for (let i = 1; i < events.length; i++) assert.equal(events[i].foot, -events[i - 1].foot, 'feet must alternate');
  }
  const loud = events => events[0].intensity;
  assert.ok(loud(sprint) > loud(walk) && loud(walk) > loud(crouch) && loud(crouch) > 0);
  assert.ok(Math.abs(loud(sprint) - 1) < .01);
  const start = footsteps(CameraFX.create(), 1, WALK);
  assert.ok(start[0].time > .15 && start[0].time < .35, 'first plant about half a step after starting');
  assert.equal(footsteps(CameraFX.create(), 3, input({ speed: 0 })).length, 0, 'standing still is silent');
  assert.equal(footsteps(CameraFX.create(), 3, input({ speed: 3, onGround: false })).length, 0, 'no steps in the air');
  assert.equal(footsteps(CameraFX.create(), 3, input({ speed: 7.5, sliding: true, crouching: true })).length, 0, 'no steps while sliding');
});

test('footstep plants coincide with the heel-strike dip', () => {
  const rig = CameraFX.create();
  run(rig, 2, 60, WALK);
  let planted = 0, before = 0, after = null;
  run(rig, 3, 60, WALK, pose => {
    if (after === 'next') { assert.ok(pose.pos.y < before - .004, 'camera drops sharply right after a plant'); after = null; }
    if (pose.footstep) { planted++; after = 'next'; before = pose.pos.y; }
  });
  assert.ok(planted >= 5);
});

test('bob amplitude: sprint > walk > crouch, aiming steadies, lateral sway scales', () => {
  const y = inp => range(CameraFX.create(), 4, inp, pose => pose.pos.y);
  const x = inp => range(CameraFX.create(), 4, inp, pose => pose.pos.x);
  const walk = y(WALK), sprint = y(SPRINT), crouch = y(CROUCH), aim = y(input({ speed: 3, aiming: true }));
  assert.ok(sprint > walk && walk > crouch, `${sprint} ${walk} ${crouch}`);
  assert.ok(walk > .02 && walk < .03, `walk ${walk}`);
  assert.ok(sprint > .05 && sprint < .07, `sprint ${sprint}`);
  assert.ok(crouch > .009 && crouch < .016, `crouch ${crouch}`);
  assert.ok(aim < walk * .32, `aim ${aim}`);
  const walkSide = x(WALK), sprintSide = x(SPRINT);
  assert.ok(Math.abs(walkSide / 2 - .015) < .003 && Math.abs(sprintSide / 2 - .035) < .005, `${walkSide} ${sprintSide}`);
  const gun = inp => range(CameraFX.create(), 4, inp, pose => pose.weapon.x);
  assert.ok(gun(SPRINT) > gun(WALK) && gun(input({ speed: 3, aiming: true })) < gun(WALK) * .3);
});

test('sprint FOV kick and forward pitch blend in smoothly; strafe leans into the move', () => {
  const rig = CameraFX.create();
  const fovs = [];
  run(rig, 1.5, 60, SPRINT, pose => fovs.push(pose.fov));
  assert.ok(Math.abs(fovs[fovs.length - 1] - 8) < .1 && fovs[0] < 1.5, 'reaches +8 deg without a pop');
  for (let i = 1; i < fovs.length; i++) assert.ok(Math.abs(fovs[i] - fovs[i - 1]) < 1);
  const lean = inp => { const r = CameraFX.create(); run(r, 2, 60, inp); return r.snapshot().lean; };
  assert.ok(Math.abs(lean(input({ speed: 3, strafe: 1 })) + 2.5 * DEG) < .1 * DEG, 'strafe right rolls right (negative)');
  assert.ok(Math.abs(lean(input({ speed: 6.8, running: true, strafe: -1 })) - 3 * DEG) < .15 * DEG);
  assert.ok(Math.abs(lean(input({ speed: 0, strafe: 1 }))) < 1e-6, 'no lean while blocked');
  const meanPitch = inp => {
    const rig = CameraFX.create();
    run(rig, 2, 60, inp);
    let sum = 0, n = 0;
    run(rig, 2, 60, inp, pose => { sum += pose.rot.pitch; n++; });
    return sum / n;
  };
  const sprintPitch = meanPitch(SPRINT), walkPitch = meanPitch(WALK);
  assert.ok(sprintPitch < -1.1 * DEG && sprintPitch > -2 * DEG && walkPitch > -.3 * DEG, `${sprintPitch / DEG} ${walkPitch / DEG}`);
});

test('landing dips with an underdamped spring that scales with impact and settles', () => {
  const measure = speed => {
    const rig = CameraFX.create();
    run(rig, 1, 60, input({}));
    rig.land(speed);
    let low = 0, high = 0, nod = 0, settled = null;
    run(rig, 2, 60, input({}), (pose, time) => {
      low = Math.min(low, pose.pos.y); high = Math.max(high, pose.pos.y); nod = Math.min(nod, pose.rot.pitch);
      if (time > 1.5 && settled === null) settled = Math.abs(rig.snapshot().landing);
    });
    return { low, high, nod, settled };
  };
  const soft = measure(5), hard = measure(10), huge = measure(30), tiny = measure(1);
  assert.ok(hard.low < soft.low && soft.low < -.03, `${soft.low} ${hard.low}`);
  assert.ok(huge.low >= -.125 && huge.low < -.11, `max dip ~12 cm, got ${huge.low}`);
  assert.ok(hard.high > .005, 'rebounds above rest (underdamped)');
  assert.ok(hard.nod < soft.nod - .5 * DEG, 'hard falls nod the view down');
  assert.ok(tiny.low > -.002, 'tiny drops are ignored');
  for (const r of [soft, hard, huge]) assert.ok(r.settled < 1e-4);
  const both = CameraFX.create();
  both.land(-10);
  let low = 0;
  run(both, .5, 60, input({}), pose => { low = Math.min(low, pose.pos.y); });
  assert.ok(Math.abs(low - hard.low) < .002, 'impact sign does not matter');
});

test('trauma shake: clamps to 1, quadratic, bounded by ~3 deg, decays to zero', () => {
  const rig = CameraFX.create({ seed: 5 });
  rig.addTrauma(.6); rig.addTrauma(.6);
  assert.equal(rig.snapshot().trauma, 1);
  let peak = 0;
  run(rig, .4, 60, input({}), pose => { peak = Math.max(peak, Math.abs(pose.rot.pitch), Math.abs(pose.rot.yaw), Math.abs(pose.rot.roll)); });
  const left = rig.snapshot().trauma;
  assert.ok(left > .4 && left < .6, `decay ~1-1.5/s, left ${left}`);
  assert.ok(peak > .8 * DEG && peak <= 3.05 * DEG, `peak ${peak / DEG}`);
  run(rig, 1, 60, input({}));
  assert.equal(rig.snapshot().trauma, 0);
  const still = rig.update(1 / 60, input({}));
  assert.ok(Math.abs(still.rot.yaw) < 1e-6 && Math.abs(still.pos.x) < 1e-6);
  const energy = amount => {
    const r = CameraFX.create({ seed: 5 });
    r.addTrauma(amount);
    let sum = 0;
    run(r, .05, 240, input({}), pose => { sum += Math.abs(pose.pos.x) + Math.abs(pose.rot.yaw); });
    return sum;
  };
  const ratio = energy(1) / energy(.5);
  assert.ok(ratio > 3 && ratio < 5, `trauma^2 scaling, ratio ${ratio}`);
});

test('recoil kicks up fast and recovers; viewmodel kicks back and up', () => {
  const rig = CameraFX.create();
  run(rig, 1, 120, input({}));
  rig.kick(.02, .004);
  let peak = 0, peakT = 0, gunZ = 0, gunPitch = 0, at300 = null, yaw = 0;
  run(rig, .8, 240, input({}), (pose, time) => {
    if (pose.rot.pitch > peak) { peak = pose.rot.pitch; peakT = time; }
    gunZ = Math.max(gunZ, pose.weapon.z); gunPitch = Math.max(gunPitch, pose.weapon.pitch); yaw = Math.max(yaw, pose.rot.yaw);
    if (at300 === null && time >= .3) at300 = Math.abs(rig.snapshot().kickPitch);
  });
  assert.ok(Math.abs(peak - .02) < .003, `peak ${peak}`);
  assert.ok(peakT > .025 && peakT < .06, `peak time ${peakT}`);
  assert.ok(at300 < .1 * peak, `recovered by 300 ms, ${at300}`);
  assert.ok(Math.abs(rig.snapshot().kickPitch) < .005 * peak);
  assert.ok(gunZ > .02 && gunPitch > 1 * DEG && yaw > .003);
  const shotgun = CameraFX.create(), rifle = CameraFX.create();
  shotgun.kick(.068, 0); rifle.kick(.015, 0);
  let sz = 0, rz = 0;
  run(shotgun, .2, 120, input({}), pose => { sz = Math.max(sz, pose.weapon.z); });
  run(rifle, .2, 120, input({}), pose => { rz = Math.max(rz, pose.weapon.z); });
  assert.ok(sz > rz * 1.8 && sz < .12);
});

test('look sway lags opposite to the turn, saturates, and springs back', () => {
  const rig = CameraFX.create();
  let pose;
  run(rig, .4, 60, input({ lookDX: -3 / 60 }), p => { pose = p; }); // turning right at 3 rad/s
  assert.ok(pose.weapon.yaw > 2 * DEG && pose.weapon.x < -.002, 'gun points/drifts back to the left');
  assert.ok(pose.weapon.yaw < 4.6 * DEG);
  run(rig, .4, 60, input({ lookDY: 2 / 60 }), p => { pose = p; }); // looking up
  assert.ok(pose.weapon.pitch < -1 * DEG && pose.weapon.y < 0);
  run(rig, 1.5, 60, input({}));
  assert.ok(Math.abs(rig.snapshot().swayYaw) < 1e-3 && Math.abs(rig.snapshot().swayPitch) < 1e-3);
  const aimed = CameraFX.create();
  run(aimed, .4, 60, input({ aiming: true, lookDX: -3 / 60 }), p => { pose = p; });
  assert.ok(Math.abs(aimed.snapshot().swayYaw) < 2 * DEG, 'ADS steadies sway');
});

test('exhaustion breathes heavily (~0.6 deg at ~0.4 Hz) and low health sways woozily', () => {
  const rig = CameraFX.create();
  run(rig, 6, 60, input({ exhausted: true, stamina: 0 }));
  const pitches = [];
  run(rig, 10, 60, input({ exhausted: true, stamina: 0 }), pose => pitches.push(pose.rot.pitch));
  const amp = Math.max(...pitches.map(Math.abs));
  let crossings = 0;
  for (let i = 1; i < pitches.length; i++) if (Math.sign(pitches[i]) !== Math.sign(pitches[i - 1])) crossings++;
  assert.ok(amp > .45 * DEG && amp < .75 * DEG, `amp ${amp / DEG}`);
  assert.ok(crossings >= 7 && crossings <= 9, `0.4 Hz -> 8 crossings, got ${crossings}`);
  const calm = range(CameraFX.create(), 10, input({}), pose => pose.rot.pitch);
  assert.ok(calm < .15 * DEG);
  const tiredGun = range(CameraFX.create(), 8, input({ exhausted: true }), pose => pose.weapon.y);
  assert.ok(tiredGun > 2 * range(CameraFX.create(), 8, input({}), pose => pose.weapon.y));
  const roll = health => range(CameraFX.create(), 10, input({ health }), pose => pose.rot.roll, 4);
  assert.ok(roll(8) > 1.5 * DEG && roll(100) < .05 * DEG, `${roll(8) / DEG}`);
});

test('motion=false: near-zero camera, reduced recoil, footsteps still fire', () => {
  const on = CameraFX.create({ seed: 4 }), off = CameraFX.create({ seed: 4 });
  const frame = motion => time => input({ speed: 6.8, running: true, strafe: 1, lookDX: .04, lookDY: -.02, exhausted: true,
    danger: 1, health: 5, motion, onGround: time % 1 > .2 });
  const stepsOn = [], stepsOff = [];
  let maxOff = 0, gunOff = 0, fovOff = 0;
  run(on, 3, 60, frame(true), pose => { if (pose.footstep) stepsOn.push(pose.footstep); });
  run(off, 3, 60, time => {
    if (time % .5 < 1e-9) { off.addTrauma(1); off.land(12); off.punch(1, 1); }
    return frame(false)(time);
  }, pose => {
    if (pose.footstep) stepsOff.push(pose.footstep);
    maxOff = Math.max(maxOff, Math.abs(pose.pos.x), Math.abs(pose.pos.y), Math.abs(pose.pos.z), Math.abs(pose.rot.pitch), Math.abs(pose.rot.yaw), Math.abs(pose.rot.roll));
    gunOff = Math.max(gunOff, ...flat(pose).slice(7, 13).map(Math.abs)); fovOff = Math.max(fovOff, Math.abs(pose.fov));
  });
  assert.ok(maxOff < 1e-9 && gunOff < 1e-9 && fovOff < 1e-9, `${maxOff} ${gunOff} ${fovOff}`);
  assert.ok(stepsOff.length > 4);
  assert.deepEqual(stepsOff, stepsOn, 'same footsteps regardless of motion');
  const kick = motion => {
    const rig = CameraFX.create();
    rig.kick(.02, 0);
    let cam = 0, gun = 0;
    run(rig, .2, 240, input({ motion }), pose => { cam = Math.max(cam, pose.rot.pitch); gun = Math.max(gun, pose.weapon.z); });
    return { cam, gun };
  };
  const full = kick(true), reduced = kick(false);
  assert.ok(Math.abs(reduced.cam / full.cam - .25) < .01 && reduced.gun > 0 && reduced.gun <= full.gun * .41);
  const defaults = CameraFX.create().update(1 / 60, { speed: 3, onGround: true });
  assert.ok(flat(defaults).slice(0, 13).every(v => v === 0), 'missing motion flag counts as false');
});

test('determinism by seed', () => {
  const trace = (seed, rig = CameraFX.create({ seed })) => {
    const out = [];
    rig.addTrauma(.9);
    run(rig, 2, 60, time => {
      if (Math.abs(time - .5) < 1e-9) { rig.kick(.03, .01); rig.punch(); rig.land(11); }
      return input({ speed: 3 + time, strafe: Math.sin(time * 3), lookDX: .01 * Math.cos(time * 5), danger: .5 });
    }, pose => out.push(...flat(pose)));
    return out;
  };
  assert.deepEqual(trace(11), trace(11));
  assert.notDeepEqual(trace(11), trace(12));
  assert.deepEqual(trace(7, CameraFX.create(7)), trace(7), 'create(seed) matches create({ seed })');
  assert.deepEqual(trace(0, CameraFX.create()), trace(0, CameraFX.create({})), 'default seed is fixed');
});

test('frame-rate independence: 30 vs 60 vs 144 fps over 2 s', () => {
  const scenario = fps => {
    const rig = CameraFX.create({ seed: 21 });
    rig.addTrauma(.8); rig.kick(.025, -.006); rig.land(8); rig.punch(.6, .3);
    const events = [], samples = {};
    // Input changes land on multiples of 1/6 s so every frame rate switches at the same instant.
    const SAMPLES = [1 / 6, .5, 1, 2];
    run(rig, 2, fps, time => input({
      speed: time < .5 ? 3 : 6.8, running: time >= .5, strafe: time < 1 ? .6 : -.4, lookDX: (time < 7 / 6 ? -1.5 : .8) / fps,
      lookDY: .4 / fps, stamina: 1 - time * .2, danger: time >= 1 ? .7 : 0, exhausted: time >= 4 / 3, health: 30
    }), (pose, time) => {
      if (pose.footstep) events.push(pose.footstep);
      for (const at of SAMPLES) if (Math.abs(time - at) < 1e-9) samples[at] = flat(pose).slice(0, 13);
    });
    assert.equal(Object.keys(samples).length, SAMPLES.length);
    return { events, samples, snap: rig.snapshot() };
  };
  const ref = scenario(60);
  for (const fps of [30, 144]) {
    const other = scenario(fps);
    assert.ok(Math.abs(other.events.length - ref.events.length) <= 1, `${fps}: ${other.events.length} vs ${ref.events.length}`);
    assert.ok(Math.abs(other.snap.phase - ref.snap.phase) < .01 && Math.abs(other.snap.steps - ref.snap.steps) <= 1);
    for (const at of Object.keys(ref.samples)) {
      const a = ref.samples[at], b = other.samples[at];
      a.forEach((v, i) => {
        const tol = i < 3 || (i >= 7 && i <= 9) ? .002 : i === 6 ? .1 : .1 * DEG;
        assert.ok(Math.abs(v - b[i]) < tol, `${fps} fps, t=${at}, channel ${i}: ${v} vs ${b[i]}`);
      });
    }
  }
});

test('reset() restores a fresh rig exactly', () => {
  const used = CameraFX.create({ seed: 8 }), fresh = CameraFX.create({ seed: 8 });
  used.addTrauma(1); used.kick(.05, .02); used.land(15); used.punch(-1, .5);
  run(used, 1.3, 60, input({ speed: 6.8, running: true, exhausted: true, health: 10, lookDX: .03 }));
  used.reset();
  assert.deepEqual(used.snapshot(), fresh.snapshot());
  assert.deepEqual(flat(used.pose), flat(fresh.pose));
  const a = [], b = [];
  for (const [rig, out] of [[used, a], [fresh, b]]) {
    rig.addTrauma(.7); rig.punch();
    run(rig, 1, 60, input({ speed: 3, strafe: .5 }), pose => out.push(...flat(pose)));
  }
  assert.deepEqual(a, b);
});
