'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../public/systems');
const Locomotion = require('../public/locomotion');

const { EVENTS, DEFAULTS, TUNING } = Locomotion;
const PL = rules.PLAYER;
const NAMES = Object.keys(EVENTS);
const WALK = Object.freeze({ forward: 1, strafe: 0, sprint: false, crouch: false, aiming: false, onGround: true });
const SPRINT = Object.freeze({ ...WALK, sprint: true });
const IDLE = Object.freeze({ ...WALK, forward: 0 });

function near(actual, expected, tolerance, message) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected} (±${tolerance})`);
}
function names(bits) { return NAMES.filter(name => bits & EVENTS[name]); }

// Steps a locomotion model at a fixed frame rate. `input(t, loco)` sees the time at the start of the
// frame and may press jump/slide first, exactly like key handlers between frames.
function sim(loco, seconds, fps, input, each, t0 = 0) {
  const dt = 1 / fps, log = [];
  for (let frame = 0, frames = Math.round(seconds * fps); frame < frames; frame++) {
    const start = t0 + frame * dt, s = loco.update(dt, typeof input === 'function' ? input(start, loco) : input);
    for (const name of names(s.events)) log.push({ name, t: start + dt });
    if (each) each(s, start + dt, dt);
  }
  return log;
}
function fresh() { return Locomotion.create(PL); }
function elapsed(loco, fps, input, until, limit = 30) {
  let at = null;
  sim(loco, limit, fps, input, (s, t) => { if (at === null && until(s)) at = t; });
  return at;
}

test('defaults mirror HollowSystems.PLAYER; partial or invalid constants fall back field by field', () => {
  assert.deepEqual({ ...DEFAULTS }, { ...PL });
  for (const value of [Locomotion, EVENTS, DEFAULTS, TUNING, Locomotion.NOISE]) assert.equal(Object.isFrozen(value), true);
  const bits = Object.values(EVENTS);
  assert.equal(new Set(bits).size, bits.length);
  for (const bit of bits) assert.ok(Number.isInteger(Math.log2(bit)), 'each event is a single bit');
  assert.deepEqual(NAMES.sort(), ['EXHAUSTED', 'JUMP', 'RECOVERED', 'SLIDE_END', 'SLIDE_START', 'SPRINT_START', 'SPRINT_STOP']);
  for (const player of [undefined, null, 'player', 7, {}]) assert.deepEqual({ ...Locomotion.create(player).constants }, { ...DEFAULTS });
  const custom = Locomotion.create({ walk: 4, run: NaN, crouch: -1, slideTime: Infinity, jumpCost: '0.1' }).constants;
  assert.equal(Object.isFrozen(custom), true);
  assert.deepEqual([custom.walk, custom.run, custom.crouch, custom.slideTime, custom.jumpCost], [4, DEFAULTS.run, DEFAULTS.crouch, DEFAULTS.slideTime, .1]);
  const loco = fresh(), state = loco.update(0, null);
  assert.deepEqual({ ...state }, { speed: 3, running: false, sprint: 0, stamina: 1, exhausted: false, sliding: false, slideT: 0,
    crouching: false, moving: false, events: 0, noise: .02 });
});

test('sprint starts on the first eligible frame, eases out to full speed over sprintAccel and releases in ~.25 s', () => {
  for (const fps of [30, 60, 144]) {
    const loco = fresh(), dt = 1 / fps;
    const first = loco.update(dt, SPRINT);
    assert.equal(first.running, true, `${fps} fps: running is a flag, not a ramp`);
    assert.deepEqual(names(first.events), ['SPRINT_START']);
    assert.ok(first.speed > PL.walk && first.speed < PL.run);
    let previous = first.speed, full = null, half = null;
    sim(loco, 1, fps, SPRINT, (s, t) => {
      assert.ok(s.speed >= previous - 1e-12, 'speed never dips while accelerating');
      previous = s.speed;
      if (half === null && t + dt >= PL.sprintAccel / 2) half = s.speed;
      if (full === null && s.speed >= PL.run - 1e-9) full = t + dt;
      assert.equal(s.events, 0, 'no repeated start events');
    });
    near(full, PL.sprintAccel, dt + 1e-9, `${fps} fps: time to full sprint`);
    assert.ok(half - PL.walk > .65 * (PL.run - PL.walk), `${fps} fps: ease-out reaches most of the gain early (${half})`);
    assert.equal(loco.update(dt, SPRINT).sprint, 1);
    const stop = loco.update(dt, WALK);
    assert.deepEqual(names(stop.events), ['SPRINT_STOP']);
    assert.equal(stop.running, false);
    const back = elapsed(loco, fps, WALK, s => s.speed <= PL.walk + 1e-9, 2) + dt;
    near(back, TUNING.sprintRelease, dt + 1e-9, `${fps} fps: sprint release`);
  }
});

test('a full bar sprints for about seven seconds, then exhaustion means a 2.55 m/s walk until stamina reaches .35', () => {
  for (const fps of [30, 60, 144]) {
    const loco = fresh(), dt = 1 / fps;
    const log = sim(loco, 7.5, fps, SPRINT);
    const start = log.find(e => e.name === 'SPRINT_START'), tired = log.find(e => e.name === 'EXHAUSTED');
    assert.ok(start && tired, `${fps} fps`);
    near(tired.t - start.t + dt, 7, .3, `${fps} fps: sustained sprint including the ramp`);
    assert.deepEqual(log.filter(e => e.t === tired.t).map(e => e.name).sort(), ['EXHAUSTED', 'SPRINT_STOP']);
    const state = loco.snapshot();
    assert.deepEqual([state.exhausted, state.running, state.stamina], [true, false, 0], 'regeneration waits before refilling');
    const walking = [];
    const recovery = sim(loco, 5, fps, SPRINT, s => { if (s.exhausted) walking.push({ running: s.running, speed: s.speed }); }, 7.5);
    for (const s of walking) assert.equal(s.running, false, 'exhaustion blocks sprinting even with sprint held');
    near(walking[walking.length - 1].speed, PL.walk * PL.exhaustedSpeed, 1e-9, 'exhausted walk');
    near(PL.walk * PL.exhaustedSpeed, 2.55, 1e-9, 'design number');
    const recovered = recovery.find(e => e.name === 'RECOVERED');
    near(recovered.t - tired.t, TUNING.regenDelay + PL.exhaustedRecover / PL.staminaRegenMove, 2 * dt, `${fps} fps: moving recovery`);
    assert.equal(recovery.filter(e => e.name === 'RECOVERED').length, 1);
    assert.ok(recovery.some(e => e.name === 'SPRINT_START' && Math.abs(e.t - recovered.t) <= dt + 1e-9), 'held sprint resumes on recovery');

    const idle = fresh();
    const spent = sim(idle, 7.5, fps, SPRINT).find(e => e.name === 'EXHAUSTED');
    const back = sim(idle, 4, fps, IDLE, null, 7.5).find(e => e.name === 'RECOVERED');
    near(back.t - spent.t, TUNING.regenDelay + PL.exhaustedRecover / PL.staminaRegenIdle, 2 * dt, `${fps} fps: idle recovery`);
  }
  const loco = fresh();
  sim(loco, 7.2, 60, SPRINT);
  assert.equal(loco.snapshot().exhausted, true);
  sim(loco, .3, 60, { ...WALK, aiming: true });
  near(loco.update(1 / 60, { ...WALK, aiming: true }).speed, PL.aimWalk * PL.exhaustedSpeed, 1e-9, 'aiming while exhausted');
  sim(loco, .5, 60, { ...WALK, crouch: true });
  near(loco.update(1 / 60, { ...WALK, crouch: true }).speed, PL.crouch * PL.exhaustedSpeed, 1e-9, 'crouching while exhausted');
});

test('stamina waits .6 s after exertion, then refills in about 5 s idle or 8 s while moving', () => {
  for (const fps of [30, 60, 144]) {
    const dt = 1 / fps;
    for (const [input, rate] of [[IDLE, PL.staminaRegenIdle], [WALK, PL.staminaRegenMove], [{ ...IDLE, strafe: 1 }, PL.staminaRegenMove]]) {
      const loco = fresh();
      sim(loco, 3.5, fps, SPRINT);
      const low = loco.snapshot().stamina;
      near(low, .5, .02, 'half a bar after 3.5 s');
      let flatUntil = null, fullAt = null;
      sim(loco, 10, fps, input, (s, t) => {
        if (flatUntil === null && s.stamina > low + 1e-12) flatUntil = t - dt;
        if (fullAt === null && s.stamina >= 1) fullAt = t;
      });
      near(flatUntil, TUNING.regenDelay, dt + 1e-9, `${fps} fps: regen delay`);
      near(fullAt, TUNING.regenDelay + (1 - low) / rate, dt + 1e-9, `${fps} fps: refill`);
    }
  }
  near(1 / PL.staminaRegenIdle, 5, 1e-9, 'idle refill');
  near(1 / PL.staminaRegenMove, 8, 1e-9, 'moving refill');
});

test('direction scales speed and only mostly-forward input sprints; aiming and crouching gate sprint', () => {
  const diagonal = Math.SQRT1_2;
  const walking = [
    [{ forward: 1 }, PL.walk], [{ forward: 0, strafe: 1 }, PL.walk * .9], [{ forward: 0, strafe: -1 }, PL.walk * .9],
    [{ forward: -1 }, PL.walk * .75], [{ forward: -diagonal, strafe: diagonal }, PL.walk * (.9 - .15 * diagonal)],
    [{ forward: diagonal, strafe: diagonal }, PL.walk * (.9 + .1 * diagonal)], [{ forward: 1, aiming: true }, PL.aimWalk],
    [{ forward: 1, crouch: true }, PL.crouch], [{ forward: -1, crouch: true }, PL.crouch * .75]
  ];
  for (const [input, speed] of walking) {
    for (const sprint of [false, true]) {
      const s = fresh().update(1 / 60, { ...WALK, strafe: 0, ...input, sprint });
      if (!s.running) near(s.speed, speed, 1e-9, JSON.stringify(input));
    }
  }
  const sprinting = [
    [{ forward: 1 }, true], [{ forward: 2 }, true], [{ forward: .7071, strafe: .7071 }, true], [{ forward: .5, strafe: .866 }, true],
    [{ forward: .45, strafe: .893 }, false], [{ forward: 0, strafe: 1 }, false], [{ forward: -1 }, false], [{ forward: .05 }, false],
    [{ forward: 1, aiming: true }, false], [{ forward: 1, crouch: true }, false], [{ forward: 1, moving: false }, false]
  ];
  for (const [input, sprints] of sprinting) {
    const s = fresh().update(1 / 60, { ...SPRINT, strafe: 0, ...input });
    assert.equal(s.running, sprints, JSON.stringify(input));
    if (!sprints) assert.equal(s.sprint, 0);
  }
  for (const input of [{ aiming: true }, { crouch: true }, { forward: -1 }, { forward: 0, strafe: 1 }]) {
    const loco = fresh();
    sim(loco, 1, 60, SPRINT);
    const s = loco.update(1 / 60, { ...SPRINT, ...input });
    assert.equal(s.running, false, JSON.stringify(input));
    assert.deepEqual(names(s.events), ['SPRINT_STOP']);
  }
  const loco = fresh();
  for (const [input, noise] of [[IDLE, .02], [WALK, .3], [{ ...WALK, crouch: true }, .09], [SPRINT, .8], [{ ...IDLE, crouch: true }, .02]]) {
    assert.equal(loco.update(1 / 60, input).noise, noise, JSON.stringify(input));
  }
});

test('slides: gated on running, ground and stamina, cost .16, decay smoothly to crouch speed, crouch while sliding', () => {
  const walking = fresh();
  walking.update(1 / 60, WALK);
  assert.equal(walking.slide(), false, 'walking cannot slide');
  const airborne = fresh();
  airborne.update(1 / 60, { ...SPRINT, onGround: false });
  assert.equal(airborne.snapshot().running, true);
  assert.equal(airborne.slide(), false, 'no slide in the air');
  const tired = fresh();
  sim(tired, 5.75, 60, SPRINT);
  assert.ok(tired.snapshot().stamina <= .2 && tired.snapshot().running);
  assert.equal(tired.slide(), false, 'needs more than .2 stamina');
  for (const fps of [30, 60, 144]) {
    const loco = fresh(), dt = 1 / fps;
    sim(loco, 1, fps, SPRINT);
    const before = loco.snapshot().stamina;
    assert.equal(loco.slide(), true);
    assert.equal(loco.slide(), false, 'one slide at a time');
    let s = loco.snapshot();
    near(before - s.stamina, PL.slideCost, 1e-12, 'slide cost');
    assert.deepEqual([s.sliding, s.slideT, s.crouching], [true, PL.slideTime, true]);
    const speeds = [], log = [];
    log.push(...sim(loco, 1.2, fps, SPRINT, (state, t) => { if (state.sliding || state.events & EVENTS.SLIDE_END) speeds.push({ speed: state.speed, t, crouching: state.crouching, running: state.running, noise: state.noise }); }));
    s = loco.snapshot();
    const first = speeds[0], start = log.find(e => e.name === 'SLIDE_START'), end = log.find(e => e.name === 'SLIDE_END');
    assert.equal(log.filter(e => e.name === 'SLIDE_START').length, 1);
    assert.equal(log.filter(e => e.name === 'SLIDE_END').length, 1);
    assert.deepEqual(log.filter(e => e.t === start.t).map(e => e.name).sort(), ['SLIDE_START', 'SPRINT_STOP']);
    near(end.t - start.t + dt, PL.slideTime, dt + 1e-9, `${fps} fps: slide duration`);
    assert.ok(first.speed > PL.slideSpeed - .1 && first.speed <= PL.slideSpeed, 'a slide launches at slide speed');
    for (let k = 1; k < speeds.length - 1; k++) assert.ok(speeds[k].speed <= speeds[k - 1].speed + 1e-12, 'slide speed only decays');
    for (const sample of speeds.slice(0, -1)) {
      assert.equal(sample.crouching, true); assert.equal(sample.running, false); assert.equal(sample.noise, .8);
    }
    const steepest = Math.max(...speeds.slice(1, -1).map((v, k) => Math.abs(v.speed - speeds[k].speed) / dt));
    assert.ok(steepest < 1.6 * (PL.slideSpeed - PL.crouch) / PL.slideTime, `${fps} fps: smooth decay (${steepest})`);
    near(speeds[speeds.length - 2].speed, PL.crouch, .1, 'a slide ends at crouch speed');
    assert.equal(s.sliding, false);
  }
  const crouched = fresh();
  sim(crouched, 1, 60, SPRINT);
  crouched.slide();
  sim(crouched, .8, 60, { ...WALK, crouch: true });
  near(crouched.snapshot().speed, PL.crouch, 1e-9, 'holding crouch after a slide keeps crouch speed');
  assert.equal(crouched.snapshot().crouching, true);
});

test('jumps cost .08, need the stamina, are blocked while crouching or sliding and report JUMP once', () => {
  const loco = fresh();
  loco.update(1 / 60, WALK);
  assert.equal(loco.jump(), true);
  assert.equal(loco.jump(), false, 'one jump per frame');
  near(loco.snapshot().stamina, 1 - PL.jumpCost, 1e-12, 'jump cost');
  assert.deepEqual(names(loco.update(1 / 60, WALK).events), ['JUMP']);
  assert.equal(loco.update(1 / 60, WALK).events, 0);
  const stamina = loco.snapshot().stamina;
  sim(loco, .55, 60, IDLE);
  assert.equal(loco.snapshot().stamina, stamina, 'jumping restarts the regeneration delay');
  loco.update(1 / 60, { ...WALK, crouch: true });
  assert.equal(loco.jump(), false, 'no jump while crouching');
  const sliding = fresh();
  sim(sliding, 1, 60, SPRINT); sliding.slide();
  assert.equal(sliding.jump(), false, 'no jump while sliding');
  const leaping = fresh();
  sim(leaping, 1, 60, SPRINT);
  assert.equal(leaping.jump(), true);
  assert.equal(leaping.slide(), false, 'a jump leaves the ground, so no slide before the next grounded update');
  leaping.update(1 / 60, SPRINT);
  assert.equal(leaping.slide(), true, 'grounded again');
  const empty = fresh();
  sim(empty, 6.9, 60, SPRINT);
  sim(empty, .05, 60, IDLE);
  const left = empty.snapshot().stamina;
  assert.ok(left > 0 && left < PL.jumpCost);
  assert.equal(empty.jump(), false, 'not enough stamina');
  // Binary-exact costs: four quarter-bar jumps empty the bar, and the last one exhausts the player.
  const exact = Locomotion.create({ ...PL, jumpCost: .25 });
  for (let jump = 0; jump < 4; jump++) {
    assert.equal(exact.jump(), true, `jump ${jump}`);
    const after = exact.update(1 / 60, IDLE);
    assert.deepEqual(names(after.events).sort(), jump === 3 ? ['EXHAUSTED', 'JUMP'] : ['JUMP']);
  }
  assert.deepEqual([exact.snapshot().stamina, exact.snapshot().exhausted, exact.jump()], [0, true, false]);
});

test('every event fires exactly once per state transition under random play', () => {
  for (const seed of [1, 2, 3]) {
    const loco = fresh(), random = mulberry(seed);
    let previous = loco.snapshot(), hold = 0, input = WALK, jumped = false, slid = false;
    const counts = Object.fromEntries(NAMES.map(name => [name, 0]));
    for (let frame = 0; frame < 60 * 240; frame++) {
      if ((hold -= 1 / 60) <= 0) {
        hold = random() * 2.5;
        input = { forward: random() * 2 - 1, strafe: random() < .5 ? 0 : random() * 2 - 1, sprint: random() < .7, crouch: random() < .1,
          aiming: random() < .15, onGround: random() < .9 };
      }
      const wantJump = random() < .01, wantSlide = random() < .02;
      jumped = wantJump && loco.jump();
      slid = wantSlide && loco.slide();
      const s = loco.update(1 / 60, input), label = `seed ${seed}, frame ${frame}`;
      for (const name of names(s.events)) counts[name]++;
      assert.equal(!!(s.events & EVENTS.SPRINT_START), !previous.running && s.running, `${label}: SPRINT_START`);
      assert.equal(!!(s.events & EVENTS.SPRINT_STOP), previous.running && !s.running, `${label}: SPRINT_STOP`);
      assert.equal(!!(s.events & EVENTS.EXHAUSTED), !previous.exhausted && s.exhausted, `${label}: EXHAUSTED`);
      assert.equal(!!(s.events & EVENTS.RECOVERED), previous.exhausted && !s.exhausted, `${label}: RECOVERED`);
      assert.equal(!!(s.events & EVENTS.JUMP), jumped, `${label}: JUMP`);
      assert.equal(!!(s.events & EVENTS.SLIDE_START), slid, `${label}: SLIDE_START`);
      assert.equal(!!(s.events & EVENTS.SLIDE_END), (previous.sliding || slid) && !s.sliding, `${label}: SLIDE_END`);
      if (s.exhausted) assert.equal(s.running, false);
      assert.ok(s.stamina >= 0 && s.stamina <= 1 && s.speed >= 0 && s.speed <= PL.slideSpeed);
      previous = loco.snapshot();
    }
    for (const name of NAMES) assert.ok(counts[name] > 0, `seed ${seed}: ${name} exercised`);
  }
});

function scripted() {
  const done = {};
  const once = (name, t, at, action) => { if (t >= at && !done[name]) done[name] = action() || 'tried'; };
  return (t, loco) => {
    once('slide', t, 2, () => loco.slide());
    once('jump', t, 9, () => loco.jump());
    once('jump2', t, 21.5, () => loco.jump());
    if (t < 2) return SPRINT;
    if (t < 3) return { ...WALK, crouch: true };
    if (t < 6) return SPRINT;
    if (t < 7) return { ...WALK, aiming: true };
    if (t < 16) return SPRINT;
    if (t < 20) return { ...WALK, forward: t % 2 < 1 ? -1 : 0, strafe: t % 2 < 1 ? 0 : 1 };
    if (t < 23) return IDLE;
    return { ...SPRINT, strafe: .3 };
  };
}

test('30, 60 and 144 fps agree on events, distance and stamina', () => {
  const runs = [30, 60, 144].map(fps => {
    const loco = fresh(), checkpoints = [];
    let distance = 0, next = 2.5;
    const log = sim(loco, 30, fps, scripted(), (s, t, dt) => {
      distance += s.speed * dt;
      if (t >= next - 1e-9) { checkpoints.push(s.stamina); next += 2.5; }
    });
    return { fps, log, distance, checkpoints };
  });
  const [low, base, high] = runs;
  assert.ok(base.log.length >= 10, 'the script exercises sprint, slide, jump, exhaustion and recovery');
  for (const name of NAMES) assert.ok(base.log.some(e => e.name === name), `script exercises ${name}`);
  for (const other of [low, high]) {
    assert.deepEqual(other.log.map(e => e.name), base.log.map(e => e.name), `${other.fps} fps event order`);
    // Each input switch lands on a frame boundary, so later times may drift by a couple of 30 fps frames.
    other.log.forEach((event, k) => near(event.t, base.log[k].t, 2.5 / 30, `${other.fps} fps ${event.name} time`));
    near(other.distance, base.distance, base.distance * .01, `${other.fps} fps distance`);
    other.checkpoints.forEach((value, k) => near(value, base.checkpoints[k], .02, `${other.fps} fps stamina checkpoint ${k}`));
  }
});

// The game eases velocity toward the target speed at 13/s on the ground.
function pursuit(fps, seconds, chase, onFrame) {
  const loco = fresh(), dt = 1 / fps, k = 1 - Math.exp(-13 * dt);
  let velocity = PL.walk, player = 0, monster = 0, exhaustedAt = null;
  sim(loco, seconds, fps, SPRINT, (s, t) => {
    velocity += (s.speed - velocity) * k; player += velocity * dt; monster += chase * dt;
    if (exhaustedAt === null && s.events & EVENTS.EXHAUSTED) exhaustedAt = player - monster;
    if (onFrame) onFrame(player - monster, t, s);
  });
  return { exhaustedAt, lead: player - monster };
}

test('escape: one stamina bar out-runs a crawler by over 3 m and a warden never closes in over 20 s', () => {
  for (const fps of [30, 60, 144]) {
    for (const [kind, m] of Object.entries(rules.MONSTERS)) {
      const { exhaustedAt } = pursuit(fps, 8, m.chase);
      assert.ok(exhaustedAt > 3, `${fps} fps ${kind}: lead at exhaustion ${exhaustedAt.toFixed(2)} m`);
    }
    let lowest = Infinity, closing = 0;
    const warden = pursuit(fps, 20, rules.MONSTERS.warden.chase, (lead, t, s) => {
      if (t > 1) lowest = Math.min(lowest, lead);
      if (s.exhausted && s.sprint === 0) closing++;
    });
    assert.ok(lowest > 0 && warden.lead > 10, `${fps} fps: warden lead ${warden.lead.toFixed(2)} m, lowest ${lowest.toFixed(2)} m`);
    assert.ok(closing > 0, 'the run includes exhausted stretches where the warden gains');
  }
  const loco = fresh();
  sim(loco, 7.5, 60, SPRINT);
  const exhausted = loco.update(1 / 60, SPRINT).speed;
  for (const [kind, m] of Object.entries(rules.MONSTERS)) assert.ok(exhausted < m.chase, `${kind}: exhaustion is deadly`);
});

test('hostile dt and input are harmless, update returns one persistent object and reset restores a fresh model', () => {
  const loco = fresh(), state = loco.update(1 / 60, SPRINT);
  assert.equal(loco.state, state, 'the persistent state object is also exposed for key handlers');
  for (let frame = 0; frame < 100; frame++) assert.equal(loco.update(1 / 60, SPRINT), state, 'the same state object every frame');
  for (const dt of [NaN, -1, 0, undefined, null, '0.016', {}, -Infinity]) {
    const before = loco.snapshot();
    loco.update(dt, SPRINT);
    const after = loco.snapshot();
    assert.equal(after.stamina, before.stamina, `dt ${String(dt)} does not advance time`);
    assert.equal(after.slideT, before.slideT);
  }
  const capped = fresh(), control = fresh();
  for (const dt of [Infinity, 5, 1e300]) assert.deepEqual({ ...capped.update(dt, SPRINT) }, { ...control.update(.1, SPRINT) }, 'dt clamps to .1');
  const junk = [NaN, undefined, null, 'x', '1', {}, [], Infinity, -Infinity, 1e9, -5, true, false];
  const random = mulberry(9), pick = () => junk[Math.floor(random() * junk.length)];
  for (let frame = 0; frame < 5000; frame++) {
    if (random() < .05) loco.jump();
    if (random() < .05) loco.slide();
    const s = loco.update(random() < .9 ? 1 / 60 : pick(), random() < .05 ? pick() : {
      forward: pick(), strafe: pick(), sprint: pick(), crouch: pick(), aiming: pick(), onGround: pick(), moving: pick()
    });
    assert.equal(s, state);
    for (const key of ['speed', 'sprint', 'stamina', 'slideT', 'events', 'noise']) assert.ok(Number.isFinite(s[key]), `${key}: ${s[key]}`);
    for (const key of ['running', 'exhausted', 'sliding', 'crouching', 'moving']) assert.equal(typeof s[key], 'boolean');
    assert.ok(s.speed >= 0 && s.speed <= PL.slideSpeed && s.stamina >= 0 && s.stamina <= 1 && s.sprint >= 0 && s.sprint <= 1);
  }
  const missing = fresh().update(1 / 60, { forward: NaN, sprint: NaN, crouch: NaN, aiming: NaN });
  assert.deepEqual([missing.running, missing.crouching, missing.moving, missing.speed], [false, false, false, PL.walk]);
  loco.reset();
  assert.deepEqual(loco.snapshot(), fresh().snapshot());
  assert.equal(loco.update(1 / 60, SPRINT), state, 'reset keeps the same state object');
  assert.equal(Object.isFrozen(loco), true);
});

function mulberry(seed) {
  return function () {
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
