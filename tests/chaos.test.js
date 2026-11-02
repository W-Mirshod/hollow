'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const chaos = require('../public/chaos');

const STEP = 1 / 60;
const TAU = Math.PI * 2;
const CALM = Object.freeze({ active: true, danger: 0, chasers: 0, nearest: Infinity, alarm: false, sheltered: false, effects: true, health: 100 });
const FRENZY = Object.freeze({ active: true, danger: 1, chasers: 2, nearest: 1.5, alarm: true, sheltered: false, effects: true, health: 25 });
const SCARES = ['scream', 'slam', 'whisper', 'laugh'];
const BIG = new Set(['surge', 'blackout', 'chaseStart', ...SCARES]);

// Advances a director, returning every event stamped with the director's own clock.
function run(director, seconds, input, step = STEP, each) {
  const events = [];
  for (let frame = 0, frames = Math.round(seconds / step); frame < frames; frame++) {
    const output = director.update(step, typeof input === 'function' ? input(frame) : input);
    const at = director.snapshot().age;
    for (const event of output) events.push({ ...event, at });
    if (each) each(output, at);
  }
  return events;
}

function scenario(frame) {
  const t = frame * STEP;
  if (t < 40) return CALM;
  if (t < 60) return { ...CALM, danger: .5, nearest: 4 };
  if (t < 110) return { ...FRENZY, nearest: 1 + Math.abs(Math.sin(t * .3)) * 6 };
  if (t < 130) return { ...FRENZY, sheltered: true, chasers: 0, danger: .3 };
  if (t < 160) return { ...FRENZY, effects: false };
  return { ...CALM, alarm: true, health: 60 };
}

function trace(seed) {
  const director = chaos.create(seed), lights = [], beacons = [], levels = [];
  const events = run(director, 200, scenario, STEP, (output, at) => {
    if (Math.round(at * 60) % 7) return;
    lights.push([0, 1, 2, 3].map(i => director.lightLevel(i, i * 1.7)));
    beacons.push(director.beacon(1));
    levels.push(director.intensity());
  });
  return { events, lights, beacons, levels, state: director.snapshot() };
}

// High-contrast transitions: the level moves more than 50% (of the brighter value) away from
// the level at the previous counted transition. Slow fades are counted too, which is conservative.
function transitions(samples, rate) {
  const times = [];
  let anchor = samples[0];
  for (let k = 1; k < samples.length; k++) {
    const value = samples[k];
    if (Math.abs(value - anchor) > .5 * Math.max(value, anchor)) { times.push(k / rate); anchor = value; }
  }
  return times;
}
function busiestSecond(times) {
  let best = 0;
  for (let k = 0, j = 0; k < times.length; k++) {
    while (times[k] - times[j] >= 1) j++;
    best = Math.max(best, k - j + 1);
  }
  return best;
}

test('equal seeds replay identical events, lights, beacons and state; different seeds vary', () => {
  for (const seed of [0, 1, -1, 42, 0x12345678, 0x7fffffff, 0xffffffff]) {
    const first = trace(seed);
    assert.ok(first.events.length > 20, `seed ${seed}: the scenario must exercise the director`);
    assert.deepEqual(trace(seed), first, `seed ${seed}`);
  }
  assert.notDeepEqual(trace(123).events, trace(124).events);
  assert.notDeepEqual(trace(123).lights, trace(124).lights);
  assert.deepEqual(trace('77').events, trace(77).events, 'numeric strings are accepted as seeds');
});

test('every event has its documented shape with finite, bounded fields', () => {
  const seen = new Set();
  for (const seed of [3, 8, 21, 55]) {
    for (const lights of [undefined, 0, 1, 3, 6]) {
      const director = chaos.create(seed);
      const events = run(director, 200, frame => ({ ...scenario(frame), lights, yaw: frame % 2 ? 1.2 : undefined }));
      for (const { at, ...event } of events) {
        seen.add(event.type);
        const label = `seed ${seed}, lights ${lights}: ${JSON.stringify(event)}`;
        if (event.type === 'chaseStart' || event.type === 'chaseEnd') assert.deepEqual(Object.keys(event), ['type'], label);
        else if (event.type === 'surge') {
          assert.deepEqual(Object.keys(event).sort(), ['duration', 'intensity', 'type'], label);
          assert.ok(event.duration >= .4 && event.duration <= 1.6, label);
          assert.ok(event.intensity > 0 && event.intensity <= 1, label);
        } else if (event.type === 'blackout') {
          assert.deepEqual(Object.keys(event).sort(), ['duration', 'type'], label);
          assert.ok(event.duration > .5 && event.duration <= 1.2, label);
        } else if (event.type === 'sparks') {
          assert.deepEqual(Object.keys(event).sort(), ['light', 'type'], label);
          const count = lights === undefined ? 3 : lights;
          assert.ok(event.light === null || (Number.isInteger(event.light) && event.light >= 0 && event.light < count), label);
          if (!count) assert.equal(event.light, null, label);
        } else {
          assert.ok(SCARES.includes(event.type), label);
          assert.deepEqual(Object.keys(event).sort(), ['bearing', 'distance', 'type'], label);
          assert.ok(Number.isFinite(event.bearing) && event.bearing >= 0 && event.bearing < TAU, label);
          assert.ok(Number.isFinite(event.distance) && event.distance >= 2 && event.distance <= 26, label);
        }
      }
    }
  }
  assert.deepEqual([...seen].sort(), ['blackout', 'chaseEnd', 'chaseStart', 'laugh', 'scream', 'slam', 'sparks', 'surge', 'whisper']);
});

test('chase edges are debounced: glimpses are ignored, lulls do not end a chase, edges strictly alternate', () => {
  const director = chaos.create(5);
  for (let i = 0; i < 20; i++) {
    assert.deepEqual(run(director, .15, { ...CALM, chasers: 1 }).filter(e => e.type.startsWith('chase')), [], 'a glimpse is not a chase');
    run(director, 2, CALM);
  }
  const start = director.snapshot().age;
  const begun = run(director, 1, { ...CALM, chasers: 1 }).filter(e => e.type.startsWith('chase'));
  assert.equal(begun.length, 1);
  assert.equal(begun[0].type, 'chaseStart');
  assert.ok(begun[0].at - start >= .2 - 1e-9 && begun[0].at - start <= .25, 'a real chase starts within a quarter second');
  for (let i = 0; i < 10; i++) {
    const flapping = [...run(director, 3, CALM), ...run(director, .5, { ...CALM, chasers: 3 })];
    assert.deepEqual(flapping.filter(e => e.type.startsWith('chase')), [], 'short lulls keep the chase alive');
  }
  assert.deepEqual(run(director, 3.4, CALM).filter(e => e.type.startsWith('chase')), []);
  const ended = run(director, .2, CALM).filter(e => e.type.startsWith('chase'));
  assert.deepEqual(ended.map(e => e.type), ['chaseEnd']);
  assert.equal(director.snapshot().chasing, false);

  for (const seed of [1, 2, 3]) {
    const random = chaos.create(seed + 100), rng = mulberry(seed);
    let chasers = 0, hold = 0;
    const edges = run(random, 900, () => {
      if ((hold -= STEP) <= 0) { chasers = rng() < .5 ? 0 : 1 + Math.floor(rng() * 3); hold = rng() * (chasers ? 1.5 : 6); }
      return { ...CALM, chasers };
    }).filter(e => e.type.startsWith('chase'));
    assert.ok(edges.length > 20, 'random sightings must produce several chases');
    edges.forEach((edge, index) => assert.equal(edge.type, index % 2 ? 'chaseEnd' : 'chaseStart', `seed ${seed}, edge ${index}`));
    const starts = edges.filter(e => e.type === 'chaseStart').map(e => e.at);
    for (let k = 1; k < starts.length; k++) assert.ok(starts[k] - starts[k - 1] >= 3.7 - 1e-9, 'no stinger spam');
  }
});

test('scares keep 12–30 s cooldowns, never repeat back-to-back and never stack on other big moments', () => {
  for (const seed of [0, 9, 31, 77, 0x1234]) {
    for (const [label, input] of [['calm', CALM], ['frenzy', FRENZY], ['scenario', scenario]]) {
      const director = chaos.create(seed);
      const events = run(director, 900, input);
      const scares = events.filter(e => SCARES.includes(e.type));
      assert.ok(scares.length >= 20, `${label}, seed ${seed}: ${scares.length} scares`);
      for (let k = 0; k < scares.length; k++) {
        const scare = scares[k], name = `${label}, seed ${seed}, scare ${k}`;
        if (k) {
          const gap = scare.at - scares[k - 1].at;
          assert.ok(gap >= 12 - 1e-9, `${name}: spacing ${gap}`);
          if (input === CALM) assert.ok(gap <= 30 + 4.7, `${name}: calm spacing ${gap}`);
          assert.notEqual(scare.type, scares[k - 1].type, `${name}: repeated type`);
        }
        for (const other of events) {
          if (other === scare || !BIG.has(other.type)) continue;
          assert.ok(!(other.at > scare.at - 3 && other.at <= scare.at), `${name}: ${other.type} just before the scare`);
          if (other.type !== 'chaseStart') assert.ok(!(other.at > scare.at && other.at < scare.at + 2), `${name}: ${other.type} piled on`);
        }
      }
      if (input === FRENZY) assert.ok(scares.filter(e => e.type === 'scream').length > scares.length / 5, 'tension favours screams');
    }
  }
  const director = chaos.create(4), state = director.snapshot();
  assert.ok(state.scareCooldown >= 12 && state.scareCooldown < 30, 'the first scare waits a full cooldown');
});

test('a refuge is relief: no scares, surges or blackouts while sheltered, then a short grace', () => {
  for (const seed of [2, 6, 10]) {
    const director = chaos.create(seed);
    run(director, 30, FRENZY);
    run(director, 2, { ...FRENZY, sheltered: true });
    const inside = run(director, 300, { ...FRENZY, sheltered: true }).filter(e => e.type !== 'sparks');
    assert.deepEqual(inside.filter(e => e.type !== 'chaseStart' && e.type !== 'chaseEnd'), [], `seed ${seed}`);
    const left = director.snapshot().age, outside = run(director, 60, FRENZY);
    const first = outside.find(e => SCARES.includes(e.type));
    assert.ok(first, 'scares resume after leaving the refuge');
    assert.ok(first.at - left >= 6 - 1e-9, `leaving a refuge is not punished with an instant scare (${first.at - left})`);
    assert.ok(outside.some(e => e.type === 'surge'), 'surges resume outside');
  }
});

test('blackouts are brief, at least 20 s apart and only happen in a chase or at high danger with effects on', () => {
  let total = 0;
  for (const seed of [1, 2, 3, 4, 5]) {
    for (const input of [CALM, { ...CALM, danger: .6, nearest: 2 }, { ...FRENZY, effects: false }, { ...FRENZY, sheltered: true }]) {
      const events = run(chaos.create(seed), 600, input);
      assert.deepEqual(events.filter(e => e.type === 'blackout'), [], `seed ${seed}: ${JSON.stringify(input)}`);
    }
    for (const input of [FRENZY, { ...CALM, danger: 1 }, { ...CALM, chasers: 1, danger: .2 }]) {
      const director = chaos.create(seed), dark = [];
      let open = null;
      const events = run(director, 600, input, STEP, (output, at) => {
        const blackout = output.find(e => e.type === 'blackout');
        if (blackout) open = { at, end: at + blackout.duration, darkest: Infinity };
        if (open && at <= open.end) open.darkest = Math.min(open.darkest, Math.max(...[0, 1, 2, 3, 4, 5, 6, 7].map(i => director.lightLevel(i, i))));
        else if (open) { dark.push(open.darkest); open = null; }
      });
      const blackouts = events.filter(e => e.type === 'blackout');
      assert.ok(blackouts.length >= 5, `seed ${seed}: ${blackouts.length} blackouts in ${JSON.stringify(input)}`);
      total += blackouts.length;
      for (let k = 1; k < blackouts.length; k++) assert.ok(blackouts[k].at - blackouts[k - 1].at >= 20, 'blackout cooldown');
      for (const level of dark) assert.ok(level <= .05, `every light goes near-black during a blackout (${level})`);
      const envelope = [];
      run(director, 40, input, STEP, () => envelope.push(director.snapshot().blackoutLevel));
      assert.ok(envelope.every(v => v >= 0 && v <= 1) && Math.max(...envelope.slice(1).map((v, k) => Math.abs(v - envelope[k]))) < .25,
        'the smoothed blackout level is safe for full-screen grading');
    }
  }
  assert.ok(total > 50);
});

test('effects off: no blackout or strobing, smooth lights within [0.75, 1.05], fewer and gentler scares', () => {
  for (const seed of [11, 12, 13]) {
    const director = chaos.create(seed), previous = [];
    let worst = 0, low = Infinity, high = -Infinity;
    const events = run(director, 400, frame => ({ ...scenario(Math.floor(frame / 4)), effects: false }), 1 / 240, () => {
      for (let i = 0; i < 4; i++) {
        const value = director.lightLevel(i, i * 2.1);
        low = Math.min(low, value); high = Math.max(high, value);
        if (previous[i] !== undefined) worst = Math.max(worst, Math.abs(value - previous[i]));
        previous[i] = value;
      }
    });
    assert.ok(low >= .75 && high <= 1.05, `seed ${seed}: range ${low}..${high}`);
    assert.ok(worst <= .005, `seed ${seed}: largest step between 240 Hz samples ${worst}`);
    assert.deepEqual(events.filter(e => e.type === 'blackout'), []);
    for (const surge of events.filter(e => e.type === 'surge')) assert.ok(surge.intensity <= .4);
    const scares = events.filter(e => SCARES.includes(e.type));
    assert.ok(scares.length > 3);
    for (const scare of scares) {
      assert.ok(['slam', 'whisper'].includes(scare.type), `gentle scare kinds only: ${scare.type}`);
      assert.ok(scare.distance >= 6, 'gentle scares stay further away');
    }
    for (let k = 1; k < scares.length; k++) assert.ok(scares[k].at - scares[k - 1].at >= 19, 'fewer scares');
    const loud = run(chaos.create(seed), 400, frame => scenario(Math.floor(frame / 4)), 1 / 240).filter(e => SCARES.includes(e.type));
    assert.ok(loud.length > scares.length, 'effects on produces more scares than effects off');
  }
});

test('no light ever exceeds three high-contrast transitions per second (240 Hz sampling)', () => {
  for (const seed of [0, 7, 99]) {
    const director = chaos.create(seed), rate = 240, rng = mulberry(seed + 1);
    const samples = Array.from({ length: 12 }, () => []);
    const phases = [0, .5, 1, 1.5, 2, 2.5, 3, 3.5, NaN, 4.4, 5.2, 6.2];
    let nearest = 3, chasers = 2;
    const events = run(director, 240, frame => {
      if (frame % 240 === 0) { nearest = rng() * 7; chasers = rng() < .85 ? 2 : 0; }
      return { ...FRENZY, nearest, chasers, alarm: frame % 9000 < 6000, lights: 8 };
    }, 1 / rate, () => {
      for (let k = 0; k < samples.length; k++) samples[k].push(director.lightLevel(k < 8 ? k : k + 8, phases[k]));
    });
    assert.ok(events.filter(e => e.type === 'surge').length >= 10 && events.some(e => e.type === 'blackout'), 'stress surges and blackouts');
    let total = 0, saturated = 0;
    samples.forEach((values, k) => {
      for (const value of values) assert.ok(Number.isFinite(value) && value >= 0 && value <= 1.25, `light ${k}: ${value}`);
      const times = transitions(values, rate);
      const busiest = busiestSecond(times);
      assert.ok(busiest <= 3, `seed ${seed}, light ${k}: ${busiest} high-contrast transitions within one second`);
      total += times.length;
      if (busiest === 3) saturated++;
    });
    assert.ok(total > 12 * 60, `the stress run must actually flicker (${total} transitions)`);
    assert.ok(saturated > 0, 'the limiter is reached, not merely avoided');
  }
});

test('lights stay within [0, 1.25] and react to surges, monster proximity and alarms', () => {
  const sample = (input, seconds = 120) => {
    const director = chaos.create(21), values = [];
    run(director, seconds, input, STEP, () => { for (let i = 0; i < 3; i++) values.push(director.lightLevel(i, i)); });
    return values;
  };
  const off = values => values.filter(v => v < .1).length;
  const calm = sample(CALM), stalked = sample({ ...CALM, nearest: .8 }), alarm = sample({ ...CALM, alarm: true });
  for (const values of [calm, stalked, alarm]) for (const v of values) assert.ok(v >= 0 && v <= 1.25);
  assert.ok(off(calm) > 0, 'rare baseline flick-outs happen');
  assert.ok(off(calm) < calm.length * .02, 'but the calm baseline is lit over 98% of the time');
  assert.ok(off(stalked) > off(calm) * 4, 'a nearby monster makes the lights cut out');
  const spread = values => Math.max(...values) - Math.min(...values.filter(v => v > .1));
  assert.ok(spread(stalked) > .15, 'interference buzz is visible');
  assert.ok(spread(alarm) > .1, 'the alarm pulses the lights');
  const director = chaos.create(8);
  let surge = null, darkened = false, bright = 0;
  run(director, 300, { ...CALM, chasers: 1, danger: 1 }, STEP, (output, at) => {
    const found = output.find(e => e.type === 'surge');
    if (found && !surge) surge = { at, end: at + found.duration };
    if (surge && at <= surge.end) for (let i = 0; i < 3; i++) {
      const v = director.lightLevel(i, i);
      darkened = darkened || v < .1; bright = Math.max(bright, v);
    }
  });
  assert.ok(surge && darkened, 'a surge visibly cuts the lights');
  assert.ok(bright > 1.05, 'surges overdrive the lights briefly');
});

test('the strobe limit also holds with jittery frame times and every light index', () => {
  const director = chaos.create(1234), rng = mulberry(9), history = new Map();
  let clock = 0;
  for (let frame = 0; frame < 30000; frame++) {
    const dt = rng() < .1 ? rng() * .05 : 1 / 240 + rng() * .01;
    director.update(dt, { ...FRENZY, nearest: rng() < .001 ? 0 : 1.2, chasers: frame % 12000 < 9000 ? 3 : 0 });
    clock += Math.min(dt, .25);
    for (let i = 0; i < 16; i++) {
      const value = director.lightLevel(i, i * .37), entry = history.get(i) || { anchor: value, times: [] };
      if (Math.abs(value - entry.anchor) > .5 * Math.max(value, entry.anchor)) { entry.times.push(clock); entry.anchor = value; }
      history.set(i, entry);
    }
  }
  for (const [i, entry] of history) {
    assert.ok(entry.times.length > 50, `light ${i} flickers`);
    assert.ok(busiestSecond(entry.times) <= 3, `light ${i}`);
  }
});

test('emergency beacons ease on during a chase or alarm, rotate about 1.5 rev/s, then ease off', () => {
  const director = chaos.create(17);
  run(director, 5, CALM);
  assert.deepEqual({ ...director.beacon(0), angle: 0 }, { on: false, angle: 0, intensity: 0 });
  let previous = 0, chaseAt = null;
  run(director, 1.5, { ...CALM, chasers: 1 }, STEP, (output, at) => {
    if (output.some(e => e.type === 'chaseStart')) chaseAt = at;
    const { intensity } = director.beacon(0);
    assert.ok(intensity >= previous - 1e-12 && intensity <= 1, 'eases monotonically up');
    previous = intensity;
  });
  assert.ok(chaseAt !== null);
  assert.equal(director.beacon(0).intensity, 1);
  assert.equal(director.beacon(3).on, true);
  const spin = (seconds, input) => {
    let turned = 0, angle = director.beacon(2).angle;
    run(director, seconds, input, STEP, () => {
      const next = director.beacon(2).angle;
      assert.ok(next >= 0 && next < TAU);
      turned += (next - angle + TAU) % TAU; angle = next;
    });
    return turned / TAU / seconds;
  };
  assert.ok(Math.abs(spin(2, { ...CALM, chasers: 1 }) - 1.5) < .02, 'about 1.5 revolutions per second');
  assert.notEqual(director.beacon(0).angle, director.beacon(1).angle, 'beacons are staggered');
  previous = 1;
  const fading = run(director, 6, CALM, STEP, () => {
    const { intensity } = director.beacon(0);
    assert.ok(intensity <= previous + 1e-12, 'eases monotonically down');
    previous = intensity;
  });
  assert.deepEqual(fading.filter(e => e.type.startsWith('chase')).map(e => e.type), ['chaseEnd']);
  assert.equal(director.beacon(0).on, false);
  run(director, 1, { ...CALM, alarm: true });
  assert.ok(director.beacon(0).intensity > .99, 'the exit alarm alone lights the beacons');
  run(director, 3, { ...CALM, alarm: true, effects: false });
  assert.ok(director.beacon(0).intensity <= .36 && director.beacon(0).on, 'reduced effects dim the beacons');
  assert.ok(Math.abs(spin(2, { ...CALM, alarm: true, effects: false }) - .5) < .03, 'and slow them down');
  director.update(STEP, { ...CALM, active: false });
  assert.equal(director.beacon(0).on, false);
  assert.equal(director.beacon(0).intensity, 0);
});

test('inactive or missing input emits nothing, keeps lights at 1 and does not advance the scheduler', () => {
  for (const input of [undefined, null, {}, 'active', { ...FRENZY, active: false }, { ...FRENZY, active: 0 }]) {
    const director = chaos.create(12), control = chaos.create(12);
    run(director, 45, FRENZY); run(control, 45, FRENZY);
    for (let frame = 0; frame < 600; frame++) {
      assert.deepEqual(director.update(STEP, input), []);
      for (let i = 0; i < 8; i++) assert.equal(director.lightLevel(i, i), 1);
      assert.equal(director.intensity(), 0);
      assert.equal(director.beacon(0).on, false);
    }
    const paused = director.snapshot();
    assert.equal(paused.active, false);
    assert.equal(paused.age, control.snapshot().age);
    assert.deepEqual(run(director, 60, FRENZY), run(control, 60, FRENZY), 'ignored updates must not consume randomness');
    assert.deepEqual(director.snapshot(), control.snapshot());
  }
  const fresh = chaos.create(1);
  assert.equal(fresh.lightLevel(0, 0), 1, 'lights are neutral before the first update');
  assert.equal(fresh.intensity(), 0);
});

test('invalid dt, garbage input and hostile light indices are harmless', () => {
  for (const dt of [0, -.25, -100, NaN, Infinity, -Infinity, undefined, null, '0.25', {}, []]) {
    const director = chaos.create(88), control = chaos.create(88);
    run(director, 10, FRENZY); run(control, 10, FRENZY);
    const before = director.snapshot();
    assert.deepEqual(director.update(dt, FRENZY), [], `dt ${String(dt)}`);
    assert.deepEqual(director.snapshot(), before);
    assert.deepEqual(run(director, 20, FRENZY), run(control, 20, FRENZY));
  }
  const capped = chaos.create(4), control = chaos.create(4);
  for (const dt of [1, 60, Number.MAX_VALUE]) {
    assert.deepEqual(capped.update(dt, FRENZY), control.update(.25, FRENZY), 'large steps are capped at a quarter second');
  }
  assert.deepEqual(capped.snapshot(), control.snapshot());
  const director = chaos.create(66), rng = mulberry(66);
  const junk = [NaN, -1, 0, 1, 2.5, 1e9, -Infinity, Infinity, '3', 'x', null, undefined, {}, [], true];
  const pick = () => junk[Math.floor(rng() * junk.length)];
  for (let frame = 0; frame < 6000; frame++) {
    const events = director.update(rng() < .9 ? STEP : pick(), {
      active: rng() < .95, danger: pick(), chasers: pick(), nearest: pick(), alarm: pick(), sheltered: rng() < .1,
      effects: rng() < .1 ? false : pick(), health: pick(), lights: pick(), yaw: pick(), cue: pick()
    });
    assert.ok(Array.isArray(events));
    for (const event of events) {
      for (const [key, value] of Object.entries(event)) {
        if (key !== 'type' && value !== null) assert.ok(Number.isFinite(value), `${event.type}.${key} = ${value}`);
      }
    }
    for (const i of [pick(), frame % 9, -3]) {
      const level = director.lightLevel(i, pick());
      assert.ok(Number.isFinite(level) && level >= 0 && level <= 1.25, `light ${String(i)}: ${level}`);
    }
    const beacon = director.beacon(pick());
    assert.ok(Number.isFinite(beacon.angle) && beacon.angle >= 0 && beacon.angle < TAU);
    assert.ok(beacon.intensity >= 0 && beacon.intensity <= 1 && typeof beacon.on === 'boolean');
    const level = director.intensity();
    assert.ok(Number.isFinite(level) && level >= 0 && level <= 1);
  }
  for (const value of Object.values(director.snapshot())) {
    assert.ok(typeof value === 'boolean' || Number.isFinite(value), `snapshot value ${value}`);
  }
});

test('reset restores a fresh director, optionally with a new seed', () => {
  const director = chaos.create(31);
  const first = run(director, 120, scenario);
  director.reset();
  assert.deepEqual(director.snapshot(), chaos.create(31).snapshot());
  assert.deepEqual(run(director, 120, scenario), first);
  director.reset(32);
  assert.deepEqual(director.snapshot(), chaos.create(32).snapshot());
  assert.deepEqual(run(director, 120, scenario), run(chaos.create(32), 120, scenario));
  assert.equal(Object.isFrozen(chaos), true);
  assert.equal(Object.isFrozen(director), true);
  assert.equal(chaos.LIMITS.transitionsPerSecond, 3);
  assert.equal(chaos.LIMITS.blackoutMax, 1.2);
  assert.ok(chaos.LIMITS.blackoutCooldown >= 20);
});

test('overall intensity is calm when calm, high in a frenzy and changes smoothly', () => {
  const director = chaos.create(5);
  let previous = 0, steepest = 0;
  const watch = () => {
    const value = director.intensity();
    assert.ok(value >= 0 && value <= 1);
    steepest = Math.max(steepest, Math.abs(value - previous)); previous = value;
  };
  run(director, 20, CALM, STEP, watch);
  assert.ok(director.intensity() < .1, 'exploration is calm');
  run(director, 2, { ...CALM, danger: .5 }, STEP, watch);
  const tense = director.intensity();
  assert.ok(tense > .2 && tense < .6);
  run(director, 20, FRENZY, STEP, watch);
  assert.ok(director.intensity() > .75, 'a chase near a monster with the alarm sounding is chaos');
  run(director, 30, CALM, STEP, watch);
  assert.ok(director.intensity() < .1, 'and it settles again');
  assert.ok(steepest < .05, `no single frame jumps (${steepest})`);
});

test('kill streak labels follow count, Warden and headshot precedence inside a four second window', () => {
  const streak = chaos.createStreak();
  const kill = (time, info) => streak.kill(time, info);
  assert.deepEqual([kill(0).label, kill(1, { headshot: true }).label, kill(2).label, kill(3).label, kill(4).label, kill(8).label],
    [null, 'DOUBLE KILL', 'TRIPLE KILL', 'MULTI KILL', 'RAMPAGE', 'RAMPAGE']);
  assert.equal(streak.snapshot().count, 6);
  assert.equal(kill(12.01).count, 1, 'a gap beyond four seconds ends the streak');
  assert.equal(kill(30, { headshot: true }).label, 'HEADSHOT');
  const warden = kill(31, { kind: 'warden', headshot: true });
  assert.equal(warden.label, 'WARDEN DOWN');
  assert.equal(warden.count, 2);
  assert.equal(kill(60, { kind: 'warden' }).label, 'WARDEN DOWN');
  assert.equal(kill(100, { kind: 'stalker' }).label, null);
  assert.equal(kill(104, { kind: 'stalker' }).label, 'DOUBLE KILL', 'exactly four seconds still chains');
  assert.equal(kill(103).count, 1, 'time running backwards starts a new streak');
  assert.equal(streak.snapshot().best, 6);
  assert.equal(streak.snapshot().kills, 13);
});

test('kill rewards: bounded hitstop and flash, consistent points, tiny hit feedback', () => {
  const streak = chaos.createStreak();
  let total = 0;
  for (const [index, info] of [{}, { headshot: true }, { kind: 'warden' }, { kind: 'warden', headshot: true, distance: 30 },
    { kind: 'crawler', distance: 15 }, { kind: 'shrieker' }, { kind: 'stalker', headshot: true }].entries()) {
    for (let chain = 0; chain < 8; chain++) {
      const result = streak.kill(index * 100 + chain, info);
      assert.deepEqual(Object.keys(result).sort(), ['count', 'flash', 'hitstop', 'label', 'points']);
      assert.ok(result.hitstop >= .04 && result.hitstop <= .12, `hitstop ${result.hitstop}`);
      assert.ok(result.flash >= 0 && result.flash <= 1);
      assert.ok(Number.isInteger(result.points) && result.points > 0 && result.points % 5 === 0);
      total += result.points;
    }
  }
  assert.equal(streak.snapshot().points, total);
  const points = (info, at = 0) => chaos.createStreak().kill(at, info).points;
  assert.ok(points({ kind: 'warden' }) > points({ kind: 'stalker' }) && points({ kind: 'stalker' }) > points({ kind: 'crawler' }));
  assert.ok(points({ kind: 'stalker', headshot: true }) > points({ kind: 'stalker' }));
  assert.ok(points({ kind: 'stalker', distance: 25 }) > points({ kind: 'stalker', distance: 5 }));
  const chained = chaos.createStreak();
  const firstKill = chained.kill(0, { kind: 'stalker' }), secondKill = chained.kill(1, { kind: 'stalker' });
  assert.ok(secondKill.points > firstKill.points && secondKill.hitstop > firstKill.hitstop && secondKill.flash > firstKill.flash);
  assert.ok(chaos.createStreak().kill(0, { kind: 'warden' }).hitstop > firstKill.hitstop, 'a Warden kill lands harder');
  assert.equal(chaos.createStreak({ effects: false }).kill(0, { kind: 'warden' }).flash, 0);
  assert.equal(chaos.createStreak().kill(0, { kind: 'warden', effects: false }).flash, 0);

  const hits = chaos.createStreak();
  const body = hits.hit(0, {}), head = hits.hit(1, { headshot: true }), rapid = hits.hit(1.05, {});
  assert.deepEqual([body.marker, head.marker, rapid.marker], ['hit', 'headshot', 'hit']);
  assert.ok(body.hitstop > 0 && body.hitstop < .01 && head.hitstop > body.hitstop && head.hitstop < .03);
  assert.equal(rapid.hitstop, 0, 'automatic fire does not stutter on every bullet');
  assert.deepEqual(hits.snapshot(), { count: 0, best: 0, points: 0, kills: 0 }, 'hits alone do not score');
});

test('streak snapshot expiry, reset and hostile inputs', () => {
  const streak = chaos.createStreak();
  streak.kill(10, { kind: 'shrieker' }); streak.kill(12, { kind: 'shrieker' });
  assert.equal(streak.snapshot().count, 2);
  assert.equal(streak.snapshot(15).count, 2);
  assert.equal(streak.snapshot(16.5).count, 0, 'an expired streak reports zero');
  assert.equal(streak.snapshot(5).count, 0);
  assert.equal(streak.snapshot(NaN).count, 2);
  for (const [time, info] of [[NaN, null], [undefined, undefined], ['13', { kind: 'constructor', distance: -4 }],
    [Infinity, { kind: 42, headshot: 'yes', distance: NaN }], [null, []]]) {
    const result = streak.kill(time, info);
    assert.ok(Number.isInteger(result.count) && result.count >= 1);
    assert.ok(Number.isFinite(result.points) && result.points > 0);
    assert.ok(result.hitstop >= .04 && result.hitstop <= .12 && result.flash >= 0 && result.flash <= 1);
  }
  assert.equal(streak.kill(14, { kind: 'constructor' }).points > 0, true);
  const state = streak.snapshot();
  assert.ok(state.best >= 2 && state.points > 0 && state.kills === 8);
  streak.reset();
  assert.deepEqual(streak.snapshot(), { count: 0, best: 0, points: 0, kills: 0 });
  assert.equal(streak.kill(0).count, 1);
  assert.equal(Object.isFrozen(streak), true);
});

function mulberry(seed) {
  return function () {
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
