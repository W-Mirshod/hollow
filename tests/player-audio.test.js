'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const playerAudio = require('../public/player-audio');
const script = readFileSync(require.resolve('../public/player-audio'), 'utf8');
const STINGERS = ['chase', 'kill', 'headshot', 'streak', 'fuse', 'pickup', 'scare'];
const METHODS = ['update', 'hurt', 'stinger', 'surge', 'land', 'stop', 'snapshot'];
const FPS = 60, DT = 1 / FPS;

// Fakes follow tests/audio.test.js, extended with AudioParam inputs, setTargetAtTime, detune and looping
// sources. Failed expectations are also recorded, because the module deliberately swallows graph errors.
function check(context, condition, message) {
  if (condition) return;
  const error = new assert.AssertionError({ message });
  context.errors.push(error);
  throw error;
}
class FakeParam {
  constructor(owner, value) { this.owner = owner; this.value = value; this.events = []; }
  get context() { return this.owner.context; }
  record(method, value, time, extra) {
    const context = this.context, last = this.events[this.events.length - 1];
    check(context, Number.isFinite(value), `${method}: finite value`);
    check(context, Number.isFinite(time) && time >= 0, `${method}: finite, nonnegative time`);
    check(context, !last || time >= last.time, 'Ordered automation');
    if (method === 'exponential') check(context, value > 0, 'Exponential ramps cannot reach zero');
    if (method === 'target') check(context, Number.isFinite(extra) && extra > 0, 'Positive time constant');
    this.events.push({ method, value, time });
    return this;
  }
  setValueAtTime(value, time) { return this.record('set', value, time); }
  linearRampToValueAtTime(value, time) { return this.record('linear', value, time); }
  exponentialRampToValueAtTime(value, time) { return this.record('exponential', value, time); }
  setTargetAtTime(value, time, constant) { return this.record('target', value, time, constant); }
}
class FakeNode {
  constructor(context, kind) {
    this.context = context; this.kind = kind; this.connections = []; this.disconnects = 0;
    context.nodes.push(this);
  }
  connect(target) {
    check(this.context, target && target.context === this.context, 'No cross-context connections');
    this.connections.push(target);
    return target;
  }
  disconnect() { this.disconnects++; this.connections.length = 0; }
}
class FakeSource extends FakeNode {
  constructor(context, kind) {
    super(context, kind);
    this.starts = []; this.stops = []; this.onended = null; this.ended = false;
    if (kind === 'buffer') { this.playbackRate = new FakeParam(this, 1); this.loop = false; }
    else { this.frequency = new FakeParam(this, 440); this.detune = new FakeParam(this, 0); this.type = 'sine'; }
  }
  setPeriodicWave(wave) { this.wave = wave; this.type = 'custom'; }
  start(time, offset) {
    const context = this.context;
    check(context, this.starts.length === 0, 'Each source starts exactly once');
    check(context, Number.isFinite(time) && time >= context.currentTime, 'Starts are finite and not in the past');
    if (this.kind === 'buffer') check(context, offset >= 0 && offset < this.buffer.duration, 'Offset inside the buffer');
    this.starts.push({ time, offset });
    context.pending.add(this);
  }
  stop(time) {
    check(this.context, this.starts.length === 1, 'Only started sources can be stopped');
    check(this.context, Number.isFinite(time) && time >= 0, 'Every stop has a finite time');
    this.stops.push(time);
  }
  get endTime() {
    const stop = this.stops.length ? this.stops[this.stops.length - 1] : Infinity;
    if (this.kind !== 'buffer' || !this.starts.length || this.loop) return stop;
    const { time, offset } = this.starts[0];
    return Math.min(stop, time + (this.buffer.duration - offset) / this.playbackRate.value);
  }
  finish() {
    if (this.ended) return;
    this.ended = true;
    this.context.pending.delete(this);
    if (this.onended) this.onended();
  }
}
class FakeContext {
  constructor({ sampleRate = 48000, legacy = false } = {}) {
    this.currentTime = 4; this.sampleRate = sampleRate; this.state = 'running'; this.legacy = legacy;
    this.nodes = []; this.waves = []; this.errors = []; this.pending = new Set();
    this.destination = new FakeNode(this, 'destination');
  }
  createGain() { const node = new FakeNode(this, 'gain'); node.gain = new FakeParam(node, 1); return node; }
  createBiquadFilter() {
    const node = new FakeNode(this, 'filter');
    node.type = 'lowpass'; node.frequency = new FakeParam(node, 350); node.Q = new FakeParam(node, 1);
    return node;
  }
  createBufferSource() { return new FakeSource(this, 'buffer'); }
  createOscillator() { return new FakeSource(this, 'oscillator'); }
  createPeriodicWave(real, imaginary) {
    check(this, real.length === imaginary.length && real.length >= 2, 'Matching wave tables');
    const wave = { real: Array.from(real), imaginary: Array.from(imaginary) };
    this.waves.push(wave);
    return wave;
  }
  createDynamicsCompressor() {
    const node = new FakeNode(this, 'compressor');
    for (const [key, value] of Object.entries({ threshold: -24, knee: 30, ratio: 12, attack: .003, release: .25 })) {
      node[key] = new FakeParam(node, value);
    }
    return node;
  }
  createWaveShaper() { return new FakeNode(this, 'shaper'); }
  resume() { assert.fail('The caller owns context activation'); }
  close() { assert.fail('The caller owns context lifetime'); }
  get sources() { return this.nodes.filter(node => node instanceof FakeSource); }
  advanceTo(time, dispatch = true) {
    assert.ok(time >= this.currentTime);
    this.currentTime = time;
    if (dispatch) for (const source of Array.from(this.pending)) if (source.endTime <= time) source.finish();
  }
}

function seeded(seed = 1) {
  let state = seed;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) | 0; return (state >>> 0) / 4294967296; };
}
function fixture({ api = playerAudio, duration = 2, seed = 7, random, ...options } = {}) {
  const context = new FakeContext(options), output = context.createGain();
  output.gain.value = .63; output.connect(context.destination);
  const data = new Float32Array(Math.max(1, Math.floor(duration * context.sampleRate)));
  data[0] = .375;
  const noiseBuffer = Object.freeze({ duration, sampleRate: context.sampleRate, numberOfChannels: 1,
    length: data.length, getChannelData: () => data });
  const instance = api.create({ context, output, noiseBuffer, random: random || seeded(seed) });
  const setup = { context, output, noiseBuffer, instance, seen: new Map(),
    owned: () => context.nodes.filter(node => node !== output && node !== context.destination) };
  setup.watch = () => {
    for (const voice of instance.snapshot().voices) if (!setup.seen.has(voice.id)) setup.seen.set(voice.id, voice);
  };
  setup.of = (kind, from = -Infinity, to = Infinity) => Array.from(setup.seen.values())
    .filter(voice => voice.kind === kind && voice.startedAt >= from && voice.startedAt < to);
  // Advance the audio clock and the frame loop together.
  setup.run = (seconds, state, each) => {
    const frames = Math.round(seconds * FPS);
    for (let frame = 0; frame < frames; frame++) {
      context.advanceTo(context.currentTime + DT);
      instance.update(DT, typeof state === 'function' ? state(frame / FPS) : state);
      setup.watch();
      if (each) each(frame / FPS);
    }
    return instance.snapshot();
  };
  return setup;
}
const mean = values => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
const body = (overrides = {}) => ({ active: true, stamina: 1, exhausted: false, running: false, moving: false,
  danger: 0, chase: false, health: 100, effects: true, hidden: false, ...overrides });
const live = context => context.nodes.filter(node => node.connections.length);
const voicesOf = (context, filterFn) => context.sources.filter(filterFn);
function near(actual, expected, epsilon = 1e-8) { assert.ok(Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`); }

function assertReleased(setup) {
  const { context, instance, output, owned } = setup;
  const state = instance.snapshot();
  assert.equal(state.activeVoices, 0);
  assert.deepEqual(context.errors, [], 'No invalid graph operations were swallowed');
  assert.ok(owned().every(node => node.connections.length === 0), 'All owned graph edges are disconnected');
  assert.ok(context.sources.every(source => source.onended === null), 'No retained ended callbacks');
  assert.ok(context.sources.every(source => source.stops.length > 0), 'Every source was given a finite stop');
  assert.equal(output.gain.value, .63, 'The supplied master volume is untouched');
  assert.equal(output.gain.events.length, 0);
  assert.equal(output.disconnects, 0);
  assert.deepEqual(output.connections, [context.destination]);
}
function settle(setup, seconds = 4) {
  setup.instance.stop();
  setup.context.advanceTo(setup.context.currentTime + seconds);
  assertReleased(setup);
}

test('CommonJS, browser global and AMD load without audio hardware, DOM or timers', () => {
  assert.deepEqual(Object.keys(playerAudio), ['create']);
  assert.ok(Object.isFrozen(playerAudio));
  const sandbox = {};
  vm.runInNewContext(script, sandbox, { filename: 'player-audio.js' });
  assert.equal(typeof sandbox.HollowPlayerAudio.create, 'function');
  const setup = fixture({ api: sandbox.HollowPlayerAudio });
  assert.equal(setup.owned().length, 0, 'Creation is silent and lazy');
  assert.ok(Object.isFrozen(setup.instance));
  assert.deepEqual(Object.keys(setup.instance), METHODS);
  assert.equal(typeof setup.instance.stinger('kill'), 'number');
  settle(setup);
  let amd;
  const define = (dependencies, factory) => { assert.equal(dependencies.length, 0); amd = factory(); };
  define.amd = {};
  const amdSandbox = { define };
  vm.runInNewContext(script, amdSandbox);
  assert.equal(typeof amd.create, 'function');
  assert.equal(amdSandbox.HollowPlayerAudio, undefined);
});

test('dependencies are validated without touching the supplied output or noise', () => {
  assert.throws(() => playerAudio.create(), /AudioContext/);
  const setup = fixture();
  const dependencies = { context: setup.context, output: setup.output, noiseBuffer: setup.noiseBuffer };
  for (const patch of [{ context: {} }, { output: null }, { output: { connect() {} } },
    { noiseBuffer: null }, { noiseBuffer: { duration: 0 } }, { noiseBuffer: { duration: NaN } },
    { output: fixture().output }, { random: 4 }]) {
    assert.throws(() => playerAudio.create({ ...dependencies, ...patch }), TypeError);
  }
  assert.equal(setup.owned().length, 0);
  assert.equal(setup.noiseBuffer.getChannelData(0)[0], .375);
  const snapshot = setup.instance.snapshot();
  assert.deepEqual(Object.keys(snapshot).slice(0, 4), ['heart', 'music', 'activeVoices', 'maxVoices']);
  assert.deepEqual(Object.keys(snapshot.heart), ['bpm', 'level']);
  assert.deepEqual(Object.keys(snapshot.music), ['level', 'intensity']);
  assert.equal(snapshot.maxVoices, 12);
  assert.doesNotThrow(() => JSON.stringify(snapshot));
});

test('the player never breathes or gasps: calm, sprinting, exhausted, hidden or hurt', () => {
  assert.equal(fixture().instance.gasp, undefined, 'No gasp API');
  const calm = fixture({ seed: 11 });
  const calmState = calm.run(30, body({ moving: true }));
  assert.equal(calm.owned().length, 0, 'A calm walk is silent');
  assert.equal(calmState.heart.level, 0);
  const runs = {
    sprint: time => body({ running: true, moving: true, stamina: 1 - time / 8 }),
    exhausted: body({ exhausted: true, moving: true, stamina: 0 }),
    hidden: body({ exhausted: true, stamina: 0, hidden: true })
  };
  const bpm = {};
  for (const [name, state] of Object.entries(runs)) {
    const setup = fixture({ seed: 11 });
    bpm[name] = setup.run(name === 'sprint' ? 6 : 20, state).heart.bpm;
    if (name === 'exhausted') { setup.instance.hurt(40); setup.run(4, state); }
    const kinds = new Set(Array.from(setup.seen.values(), voice => voice.kind));
    assert.ok([...kinds].every(kind => kind === 'heart' || kind === 'hurt'), `${name}: only heartbeats and grunts, got ${[...kinds]}`);
    assert.ok(kinds.has('heart'), `${name}: the heart still pounds`);
    assert.equal(setup.instance.snapshot().breathing, undefined);
    settle(setup);
  }
  assert.ok(bpm.sprint > 70 && bpm.sprint < bpm.exhausted, `exertion raises the heart rate: ${JSON.stringify(bpm)}`);
  assert.ok(bpm.exhausted > 100 && bpm.exhausted <= 105.1, `exhausted ${bpm.exhausted}`);
  settle(calm);
});

test('after exhaustion the heart settles gradually without rebounding', () => {
  const setup = fixture({ seed: 5 });
  setup.run(6, body({ exhausted: true, stamina: 0, moving: true }));
  const rates = [];
  setup.run(16, time => body({ stamina: Math.min(1, time / 6), exhausted: time < 2.1 }),
    time => { if (Math.abs(time % 1) < DT / 2) rates.push(setup.instance.snapshot().heart.bpm); });
  for (let index = 1; index < rates.length; index++) assert.ok(rates[index] <= rates[index - 1] + .05, 'No rebound while recovering');
  assert.ok(rates[0] > 100 && rates[5] > 95, `Still racing seconds after the sprint: ${rates.slice(0, 6)}`);
  assert.ok(rates[rates.length - 1] < 70, `Back near rest once stamina has refilled: ${rates.at(-1)}`);
  settle(setup);
});

test('the heartbeat is silent at rest and pounds lub-dub from 60 to 150 bpm with danger or injury', () => {
  const rest = fixture();
  let state = rest.run(10, body());
  assert.equal(state.heart.bpm, 60);
  assert.equal(state.heart.level, 0);
  assert.equal(rest.of('heart').length, 0);
  settle(rest);

  const terror = fixture();
  state = terror.run(12, body({ danger: 1, chase: true }));
  assert.ok(state.heart.bpm > 147 && state.heart.bpm <= 150, `bpm ${state.heart.bpm}`);
  const beats = terror.of('heart', terror.context.currentTime - 6);
  assert.ok(beats.length >= 14 && beats.length <= 16, `~15 beats in 6 s at 150 bpm, got ${beats.length}`);
  const loud = state.heart.level;
  // Each beat is one voice whose sine carries a "lub" and a quieter, higher "dub".
  const sine = terror.context.sources.find(source => source.type === 'sine' && source.frequency.events.length === 4);
  const [lub, , dub] = sine.frequency.events;
  assert.ok(lub.value > 45 && lub.value < 65 && dub.value > lub.value);
  assert.ok(dub.time - lub.time > .18 && dub.time - lub.time < .32);
  settle(terror);

  const wounded = fixture();
  state = wounded.run(12, body({ health: 15 }));
  assert.ok(state.heart.bpm > 125 && state.heart.bpm < 150, `injured bpm ${state.heart.bpm}`);
  assert.ok(state.heart.level > 0 && state.heart.level <= loud);
  const recovering = wounded.run(3, body({ health: 100 }));
  assert.ok(recovering.heart.bpm < state.heart.bpm - 10 && recovering.heart.bpm > 85, 'The heart settles slowly');
  settle(wounded);

  const extreme = fixture();
  for (const input of [body({ danger: 50, health: -400 }), body({ danger: -3, health: 1e9 }), body({ danger: NaN, health: NaN })]) {
    state = extreme.run(2, input);
    assert.ok(state.heart.bpm >= 60 && state.heart.bpm <= 150);
    assert.ok(Number.isFinite(state.heart.level) && state.heart.level >= 0 && state.heart.level < .6);
  }
  settle(extreme);
});

test('the chase bed is absent at rest, swells with danger, ticks only in a chase and is torn down when idle', () => {
  const setup = fixture(), { context } = setup;
  const continuous = () => context.sources.filter(source => source.starts.length && !source.stops.length);
  let state = setup.run(10, body());
  assert.equal(state.music.level, 0);
  assert.equal(state.music.intensity, 0);
  assert.equal(continuous().length, 0, 'Nothing drones at rest');

  state = setup.run(5, body({ danger: .4 }));
  const creep = state.music;
  assert.ok(creep.intensity > .25 && creep.intensity <= .3 && creep.level > .01 && creep.level < .1, JSON.stringify(creep));
  const layers = continuous();
  assert.equal(layers.length, 10, 'Drone, pulse, ticks, cluster and vibrato are built once');
  const lfo = layers.find(source => source.type === 'custom');
  near(lfo.frequency.value, 130 / 60);
  assert.equal(layers.filter(source => source.type === 'sawtooth').length, 7, 'Detuned saws for the drone and string cluster');
  const hiss = layers.find(source => source.kind === 'buffer');
  assert.equal(hiss.loop, true);
  assert.equal(hiss.buffer, setup.noiseBuffer, 'Reuse the supplied noise');
  const band = context.nodes.find(node => node.type === 'bandpass' && node.frequency.value === 6200);
  const hits = band.connections[0];
  assert.equal(hits.gain.events.length, 0, 'No ticking without a chase');

  const before = context.nodes.length, beforeVoices = setup.seen.size;
  state = setup.run(6, body({ danger: .85, chase: true }));
  const chase = state.music;
  assert.ok(chase.level > creep.level * 2 && chase.intensity > .8, JSON.stringify(chase));
  assert.deepEqual(continuous(), layers, 'A chase only automates the existing layers');
  const created = context.nodes.slice(before);
  assert.ok(created.every(node => node.kind !== 'oscillator' || node.stops.length), 'No new continuous sources');
  assert.ok(created.length < (setup.seen.size - beforeVoices + 1) * 26, 'Only one-shot voices allocate nodes');
  const ticks = hits.gain.events.filter(event => event.method === 'set');
  assert.ok(ticks.length >= 24 && ticks.length <= 27, `8ths at 130 bpm, got ${ticks.length}`);
  const period = 30 / 130;
  for (let index = 1; index < ticks.length; index++) near(ticks[index].time - ticks[index - 1].time, period, 1e-6);
  assert.ok(hits.gain.events.every(event => event.value >= 0 && event.value <= 1));
  const out = context.nodes.find(node => node.kind === 'gain' && node.gain.events.some(event => event.method === 'target' &&
    Math.abs(event.value - chase.level) <= 1.5e-4));
  assert.ok(out, 'The bed level is automated, never jumped');
  for (const node of context.nodes) {
    for (const param of [node.gain, node.frequency, node.detune].filter(Boolean)) {
      const targets = param.events.filter(event => event.method === 'target').length;
      assert.ok(targets <= 21 * 31, 'Continuous automation is written at a bounded control rate');
    }
  }

  state = setup.run(30, body());
  assert.ok(state.music.level === 0 && state.music.intensity < .002, JSON.stringify(state.music));
  assert.equal(continuous().length, 0, 'The idle bed is stopped');
  assert.ok(layers.every(source => source.connections.length === 0 && source.onended === null));
  assert.ok(layers.every(source => source.stops[0] >= source.starts[0].time));
  settle(setup);
});

test('effects off keeps the chase bed quieter and drops the harsh string cluster', () => {
  const results = {};
  for (const effects of [true, false]) {
    const setup = fixture();
    const state = setup.run(8, body({ danger: 1, chase: true, effects }));
    const strings = setup.context.nodes.find(node => node.type === 'lowpass' && node.connections.length &&
      node.frequency.events.some(event => event.value > 3000));
    const sheenTarget = strings && strings.frequency.events[strings.frequency.events.length - 1].value;
    const stringGain = strings && strings.connections[0].connections[0];
    results[effects] = { level: state.music.level, strings: stringGain.gain.events[stringGain.gain.events.length - 1]?.value ?? 0, sheenTarget };
    settle(setup);
  }
  assert.ok(results.false.level < results.true.level * .7);
  assert.ok(results.true.strings > .1);
  assert.equal(results.false.strings, 0);
});

for (const kind of STINGERS) {
  test(`${kind} stinger: finite layered one-shot with true-zero envelopes and complete cleanup`, () => {
    const setup = fixture(), { context, instance, noiseBuffer } = setup;
    const id = instance.stinger(kind);
    assert.equal(typeof id, 'number');
    const state = instance.snapshot(), voice = state.voices[0];
    assert.equal(voice.id, id);
    assert.equal(voice.kind, kind);
    assert.equal(state.activeVoices, 1);
    assert.ok(voice.level > 0 && voice.level <= .7);
    assert.ok(voice.endsAt > voice.startedAt && voice.endsAt - voice.startedAt < 2.6);
    assert.ok(context.sources.length >= 3 && context.sources.length <= 24, `${context.sources.length} layers`);
    for (const source of context.sources) {
      assert.equal(source.starts.length, 1);
      assert.equal(source.stops.length, 1);
      assert.ok(source.starts[0].time >= voice.startedAt);
      assert.ok(source.stops[0] > source.starts[0].time && source.stops[0] <= voice.endsAt);
      assert.equal(typeof source.onended, 'function');
      if (source.kind === 'buffer') {
        assert.equal(source.buffer, noiseBuffer);
        assert.equal(source.loop, false);
        const consumed = (source.stops[0] - source.starts[0].time) * source.playbackRate.value;
        assert.ok(source.starts[0].offset + consumed <= noiseBuffer.duration + 1e-8);
      }
    }
    for (const node of context.nodes) {
      if (node.frequency) assert.ok(node.frequency.events.every(event => event.value > 0 && event.value < context.sampleRate / 2));
      if (node.kind !== 'gain' || !node.gain.events.length) continue;
      const events = node.gain.events;
      assert.equal(events[0].value, 0, 'Start silent');
      assert.equal(events[events.length - 1].value, 0, 'End at true zero');
      assert.ok(events.every(event => event.value >= 0 && event.value <= 1 && event.time <= voice.endsAt));
    }
    assert.deepEqual(context.errors, []);
    context.advanceTo(voice.endsAt + .1);
    assertReleased(setup);
    const count = context.nodes.length;
    context.advanceTo(context.currentTime + 60);
    instance.snapshot();
    assert.equal(context.nodes.length, count, 'Nothing reschedules itself');
  });
}

test('stingers have their own characters: stab, confirm, ping, riser, power-up, clink and scare', () => {
  const play = (kind, effects = true) => {
    const setup = fixture();
    if (!effects) setup.instance.update(DT, body({ effects }));
    setup.instance.stinger(kind);
    const voice = setup.instance.snapshot().voices.find(entry => entry.kind === kind);
    const sources = setup.context.sources.filter(source => source.starts[0].time >= voice.startedAt);
    return { setup, voice, sources, pitches: sources.filter(source => source.frequency).map(source => source.frequency.events[0].value) };
  };
  const chase = play('chase');
  const stab = chase.sources.filter(source => source.type === 'sawtooth' && source.starts[0].time > chase.voice.startedAt + .3);
  assert.equal(stab.length, 5, 'A five-note cluster stab lands after the reverse swell');
  assert.ok(stab.some(source => source.frequency.events[0].value > 150 && source.frequency.events[0].value < 160), 'Minor-second rub');
  assert.ok(chase.sources.some(source => source.type === 'sine' && source.frequency.events[0].value === 62), 'Sub boom');
  const kill = play('kill'), headshot = play('headshot');
  assert.ok(kill.voice.endsAt - kill.voice.startedAt < .8, 'The confirm is short and punchy');
  assert.ok(kill.pitches.includes(150), 'Low thump');
  assert.ok(kill.pitches.some(value => Math.abs(value / 1568 - 2.76) < .01), 'Bell-like metallic tink partials');
  assert.ok(headshot.sources.length > kill.sources.length);
  assert.ok(headshot.pitches.some(value => value >= 2600), 'Bright headshot ping');
  const streak = play('streak');
  assert.ok(streak.sources.some(source => source.starts[0].time >= streak.voice.startedAt + .6), 'Riser before the hit');
  assert.ok(streak.voice.endsAt - streak.voice.startedAt > 1.5);
  const fuse = play('fuse');
  assert.ok(fuse.sources.some(source => source.frequency && source.frequency.events.at(-1).value / source.frequency.events[0].value > 3.9),
    'Rising power-up tone');
  const pickup = play('pickup');
  assert.ok(pickup.voice.level < .3 && pickup.voice.endsAt - pickup.voice.startedAt < .4, 'Soft, short clink');
  const scare = play('scare'), soft = play('scare', false);
  assert.ok(soft.voice.level < scare.voice.level * .5, 'Effects off softens the scare');
  assert.ok(scare.pitches.some(value => value > 700) && !soft.pitches.some(value => value > 700), 'No shrill layers when softened');
  assert.ok(soft.sources.length < scare.sources.length);
  for (const result of [chase, kill, headshot, streak, fuse, pickup, scare, soft]) settle(result.setup);
});

test('quick multi-kills climb a pentatonic ladder and reset after a lull', () => {
  const setup = fixture(), { context, instance } = setup;
  const tinks = [];
  for (const gap of [0, .8, .8, .8, 4]) {
    context.advanceTo(context.currentTime + gap);
    const before = context.nodes.length;
    instance.stinger('kill');
    const first = context.nodes.slice(before).find(node => node.kind === 'oscillator' && node.frequency.events[0].value > 1000);
    tinks.push(first.frequency.events[0].value);
  }
  const steps = tinks.map(value => Math.round(12 * Math.log2(value / tinks[0])) + 0);
  assert.deepEqual(steps, [0, 2, 4, 7, 0]);
  assert.equal(typeof instance.stinger('headshot'), 'number');
  for (const kind of ['toString', '__proto__', 'constructor', '', 'KILL', 'boom']) assert.equal(instance.stinger(kind), null);
  for (const kind of [null, undefined, 42, {}, ['kill']]) assert.equal(instance.stinger(kind), null);
  settle(setup);
});

test('hurt, land and surge are short synthesized one-shots scaled by their argument', () => {
  const setup = fixture(), { context, instance } = setup;
  const shot = (call) => {
    const id = call();
    assert.equal(typeof id, 'number');
    const voice = instance.snapshot().voices.find(entry => entry.id === id);
    const sources = context.sources.filter(source => source.starts[0].time >= voice.startedAt - 1e-9 &&
      source.stops[0] <= voice.endsAt + 1e-9 && !source.ended);
    context.advanceTo(voice.endsAt + .05);
    return { ...voice, length: voice.endsAt - voice.startedAt, sources };
  };
  const scratch = shot(() => instance.hurt(19)), blow = shot(() => instance.hurt(68));
  assert.ok(blow.level > scratch.level && blow.length > scratch.length + .2, 'Bigger damage, louder and longer grunt');
  assert.ok(blow.length < 1.4);
  const voiced = blow.sources.filter(source => source.type === 'custom');
  assert.equal(voiced.length, 1, 'A glottal source through vocal-tract formants');
  const pitch = voiced[0].frequency.events.map(event => event.value);
  assert.ok(Math.max(...pitch) > pitch[0] && pitch.at(-1) < pitch[0], 'Pain rises then sags');
  assert.ok(context.nodes.filter(node => node.type === 'bandpass' && node.Q.value >= 5).length >= 3);


  assert.equal(instance.land(0), null);
  assert.equal(instance.land(.015), null, 'Ordinary steps belong to the footstep system');
  const hard = shot(() => instance.land(.9)), soft = shot(() => instance.land(.25));
  assert.ok(hard.level > soft.level);
  assert.ok(hard.sources.some(source => source.type === 'custom') && !soft.sources.some(source => source.type === 'custom'),
    'Only a hard landing knocks a grunt out');
  assert.ok(hard.sources.some(source => source.type === 'sine' && source.frequency.events[0].value < 100), 'Body thud');

  const strong = shot(() => instance.surge(1)), weak = shot(() => instance.surge(.2));
  assert.ok(strong.level > weak.level && strong.length > weak.length + .5);
  const buzz = strong.sources.find(source => source.type === 'sawtooth' && source.frequency.events[0].value < 70);
  assert.ok(buzz && buzz.frequency.events[0].value > 59 && buzz.frequency.events[0].value < 61, '60 Hz mains buzz');
  const spikes = result => context.nodes.filter(node => node.kind === 'gain' && node.gain.events.length > 8 &&
    node.gain.events[0].time >= result.startedAt && node.gain.events[0].time < result.endsAt)
    .reduce((sum, node) => sum + node.gain.events.filter(event => event.method === 'set').length - 1, 0);
  assert.ok(spikes(strong) > spikes(weak) + 4, `crackle density scales: ${spikes(strong)} vs ${spikes(weak)}`);
  instance.update(DT, body({ effects: false }));
  const tame = shot(() => instance.surge(1));
  assert.ok(tame.level < strong.level * .6);
  assert.ok(!tame.sources.some(source => source.type === 'square'), 'No square buzz or zap with effects off');
  for (const value of [NaN, -1, 0, Infinity, '1', null, {}]) {
    assert.equal(instance.hurt(value), null);
    assert.equal(instance.land(value), null);
    assert.equal(instance.surge(value), null);
  }
  settle(setup);
});

test('twelve-voice cap fades out the oldest lowest-priority voice and protects stingers from body sounds', () => {
  const setup = fixture(), { context, instance } = setup;
  const first = instance.stinger('pickup');
  const firstSources = context.sources.slice(), staleEnded = firstSources[0].onended;
  for (let index = 1; index < 12; index++) instance.stinger('pickup');
  assert.equal(instance.snapshot().activeVoices, 12);
  const firstOut = context.nodes.find(node => node.kind === 'gain' && node.gain.value === instance.snapshot().voices[0].level &&
    firstSources.some(source => source.connections.length));
  assert.equal(typeof instance.stinger('kill'), 'number');
  const state = instance.snapshot();
  assert.equal(state.activeVoices, 12);
  assert.ok(state.voices.every(voice => voice.id !== first), 'The oldest pickup was stolen');
  const now = context.currentTime;
  assert.ok(firstSources.every(source => source.stops.at(-1) <= now + .03 + 1e-9), 'Stolen layers stop within a short fade');
  assert.ok(firstOut);
  context.advanceTo(now + .05);
  assert.ok(firstSources.every(source => source.connections.length === 0 && source.onended === null));
  staleEnded && staleEnded();
  assert.equal(instance.snapshot().activeVoices, 12, 'A stale ended callback cannot remove a replacement');

  for (let index = 0; index < 12; index++) instance.stinger('kill');
  assert.ok(instance.snapshot().voices.every(voice => voice.kind === 'kill'));
  const before = context.nodes.length;
  for (const call of [() => instance.land(1), () => instance.surge(1), () => instance.stinger('pickup')]) {
    assert.equal(call(), null);
  }
  assert.equal(context.nodes.length, before, 'Dropped cues allocate nothing');
  const oldest = instance.snapshot().voices[0].id;
  assert.equal(typeof instance.stinger('scare'), 'number');
  assert.ok(instance.snapshot().voices.every(voice => voice.id !== oldest));

  const kinds = [() => instance.stinger(STINGERS[0]), () => instance.hurt(30), () => instance.surge(.5),
    () => instance.land(.6), ...STINGERS.map(kind => () => instance.stinger(kind))];
  for (let index = 0; index < 120; index++) {
    kinds[index % kinds.length]();
    instance.update(.07, body({ danger: .7, chase: true, exhausted: index % 40 > 20 }));
    const snapshot = instance.snapshot();
    assert.ok(snapshot.activeVoices <= 12);
    assert.ok(context.pending.size <= 12 * 24 + 10, 'Bounded live sources');
    context.advanceTo(context.currentTime + .07);
  }
  settle(setup);
});

test('stop() silences everything within a short fade, is idempotent, and update() can restart afterwards', () => {
  const setup = fixture(), { context, instance } = setup;
  instance.stop(); instance.stop();
  assert.equal(setup.owned().length, 0, 'Stopping an idle instance allocates nothing');
  setup.run(4, body({ danger: .9, chase: true, exhausted: true, stamina: 0, health: 30 }));
  instance.stinger('chase'); instance.stinger('streak'); instance.hurt(30);
  const busy = instance.snapshot();
  assert.ok(busy.activeVoices >= 3 && busy.music.level > 0 && busy.heart.level > 0);
  const sources = context.sources.filter(source => !source.ended);
  const mix = context.nodes.find(node => node.connections.some(target => target.kind === 'compressor'));
  const now = context.currentTime;
  instance.stop();
  const silent = instance.snapshot();
  assert.equal(silent.activeVoices, 0);
  assert.equal(silent.music.level, 0); assert.equal(silent.music.intensity, 0);
  assert.equal(silent.heart.level, 0);
  const fade = mix.gain.events;
  assert.equal(fade.at(-1).value, 0); assert.ok(fade.at(-1).time <= now + .03);
  assert.ok(sources.every(source => source.stops.at(-1) <= now + .03 + 1e-9), 'Every layer, including future ones, is cut');
  const stops = context.sources.map(source => source.stops.length), events = fade.length, count = context.nodes.length;
  instance.stop(); instance.stop();
  assert.deepEqual(context.sources.map(source => source.stops.length), stops);
  assert.equal(fade.length, events);
  assert.equal(context.nodes.length, count);
  context.advanceTo(now + .1);
  assertReleased(setup);
  const restarted = setup.run(3, body({ danger: .9, chase: true, exhausted: true, stamina: 0 }));
  assert.ok(restarted.heart.level > 0 && restarted.music.level > 0 && setup.of('heart', now + .1).length > 0);
  settle(setup);
});

test('invalid inputs are sanitised and inactive contexts stay silent without throwing', () => {
  const setup = fixture(), { context, instance } = setup;
  for (const [dt, state] of [[NaN, null], [Infinity, 'x'], [-1, 7], [1e9, { active: true, stamina: NaN, danger: Infinity, health: -50 }],
    [DT, { active: true, stamina: '1', danger: '1', health: '20', exhausted: 'yes' }], [DT, []], [DT, { active: true, danger: -4 }]]) {
    assert.doesNotThrow(() => instance.update(dt, state));
    const snapshot = instance.snapshot();
    for (const value of [snapshot.heart.bpm, snapshot.heart.level, snapshot.music.level, snapshot.music.intensity]) {
      assert.ok(Number.isFinite(value) && value >= 0);
    }
    assert.ok(snapshot.heart.bpm >= 60 && snapshot.heart.bpm <= 150);
  }
  assert.deepEqual(context.errors, []);
  settle(setup);

  for (const state of ['suspended', 'interrupted', 'closed']) {
    const idle = fixture();
    idle.context.state = state;
    idle.run(2, body({ danger: 1, chase: true, exhausted: true, stamina: 0 }));
    for (const call of [() => idle.instance.hurt(50), () => idle.instance.land(1),
      () => idle.instance.surge(1), ...STINGERS.map(kind => () => idle.instance.stinger(kind))]) assert.equal(call(), null);
    assert.equal(idle.owned().length, 0, `${state}: nothing allocated`);
    const snapshot = idle.instance.snapshot();
    assert.equal(snapshot.activeVoices, 0);
    assert.equal(snapshot.heart.level, 0);
    idle.instance.stop();
  }
  const offline = fixture();
  offline.context.state = 'suspended';
  offline.context.startRendering = () => assert.fail('The caller owns offline rendering');
  assert.equal(typeof offline.instance.stinger('kill'), 'number', 'Offline contexts may stage cues while suspended');
  offline.context.state = 'running';
  settle(offline);

  const closing = fixture();
  closing.run(3, body({ danger: 1, chase: true }));
  closing.instance.stinger('scare');
  closing.context.state = 'closed';
  closing.instance.update(DT, body({ danger: 1, chase: true }));
  assert.ok(closing.owned().every(node => node.connections.length === 0), 'A closed context is released at once');
  assert.ok(closing.context.sources.every(source => source.onended === null));
  assert.deepEqual(closing.context.errors, []);
});

test('a failing context during a build releases the partial graph and returns quietly', () => {
  const setup = fixture(), { context, instance } = setup;
  let calls = 0;
  const original = context.createOscillator.bind(context);
  context.createOscillator = () => { if (++calls > 2) throw new Error('Synthetic allocation failure'); return original(); };
  assert.equal(instance.stinger('chase'), null);
  assert.ok(context.sources.length > 0, 'Exercise a partial build');
  assert.doesNotThrow(() => setup.run(2, body({ danger: 1, chase: true, health: 10 })));
  assert.equal(instance.snapshot().activeVoices, 0, 'Failed heartbeats and the bed leave nothing behind');
  assert.ok(context.sources.every(source => source.kind === 'buffer' || source.stops.length), 'No orphaned oscillators keep running');
  context.createOscillator = original;
  assert.equal(typeof instance.stinger('kill'), 'number');
  settle(setup);
});

// Two minutes of play: walking, a sprint into exhaustion, recovery, a long chase with kills, hits and surges,
// a pause, and a hidden stretch.
function session(setup, { checks = true } = {}) {
  const { context, instance } = setup;
  const stats = { peakVoices: 0, peakLive: 0, peakPending: 0, created: [] };
  setup.run(120, time => {
    if (time >= 70 && time < 73) return { active: false };
    if (time < 10) return body({ moving: true });
    if (time < 17) return body({ running: true, moving: true, stamina: 1 - (time - 10) / 7 });
    if (time < 27) return body({ exhausted: true, moving: true, stamina: 0, danger: .2 });
    if (time < 40) return body({ moving: true, stamina: Math.min(1, (time - 27) / 6), danger: .3 });
    if (time < 90) return body({ moving: true, running: time % 9 < 5, stamina: .5, danger: Math.min(1, (time - 38) / 6),
      chase: true, health: Math.max(20, 100 - (time - 40) * 2) });
    return body({ hidden: true, danger: .3, health: 20 });
  }, time => {
    const frame = Math.round(time * FPS);
    if (frame === 70 * FPS) instance.stop();
    if (time > 40 && time < 90 && (time < 70 || time >= 73)) {
      if (frame % 90 === 0) instance.stinger(frame % 450 === 0 ? 'headshot' : 'kill');
      if (frame % 300 === 17) instance.hurt(15 + (frame % 40));
      if (frame % 420 === 33) instance.surge(.3 + (frame % 7) / 10);
      if (frame % 600 === 51) instance.stinger('streak');
      if (frame % 240 === 77) instance.land(.4 + (frame % 5) / 10);
    }
    if (frame === 40 * FPS) instance.stinger('chase');
    if (frame === 95 * FPS) instance.stinger('scare');
    if (frame % 600 === 300) instance.stinger(frame % 1200 === 300 ? 'fuse' : 'pickup');
    if (!checks || frame % 15) return;
    const state = instance.snapshot();
    stats.peakVoices = Math.max(stats.peakVoices, state.activeVoices);
    stats.peakLive = Math.max(stats.peakLive, live(context).length);
    stats.peakPending = Math.max(stats.peakPending, context.pending.size);
    if (frame % FPS === 0) stats.created.push(context.nodes.length);
  });
  return stats;
}

test('a two-minute session with events, a pause and a resume keeps the graph bounded and leaks nothing', () => {
  const setup = fixture({ seed: 3 }), { context, instance } = setup;
  const stats = session(setup);
  if (process.env.PLAYER_AUDIO_STATS) console.log(JSON.stringify({ ...stats, created: stats.created.at(-1) }));
  assert.ok(stats.peakVoices <= 12);
  assert.ok(stats.peakLive < 260, `connected nodes peaked at ${stats.peakLive}`);
  assert.ok(stats.peakPending < 70, `live sources peaked at ${stats.peakPending}`);
  const perSecond = stats.created.slice(1).map((count, index) => count - stats.created[index]);
  assert.ok(Math.max(...perSecond) < 250 && mean(perSecond) < 80, `allocation rate ${mean(perSecond)}/s, peak ${Math.max(...perSecond)}`);
  assert.equal(stats.created[72], stats.created[70], 'Nothing is allocated while paused');
  const kinds = new Set(Array.from(setup.seen.values(), voice => voice.kind));
  for (const kind of ['heart', 'kill', 'headshot', 'hurt', 'surge', 'streak', 'land', 'chase', 'scare', 'fuse', 'pickup']) {
    assert.ok(kinds.has(kind), `${kind} played during the session`);
  }
  for (const node of context.nodes) {
    for (const param of [node.gain, node.frequency, node.detune, node.playbackRate].filter(Boolean)) {
      assert.ok(param.events.length < 4000, 'No parameter accumulates an unbounded automation queue');
    }
  }
  assert.deepEqual(context.errors, []);
  assert.ok(!kinds.has('breath') && !kinds.has('gasp'), 'Two minutes of sprinting and fright without a breath or gasp');
  settle(setup);
});

test('given the same random source and inputs, the graph is reproduced exactly', () => {
  const trace = seed => {
    const setup = fixture({ seed });
    session(setup, { checks: false });
    const nodes = setup.context.nodes.map(node => [node.kind, node.type, node.starts, node.stops,
      node.gain?.events.length, node.frequency?.events.slice(0, 3), node.playbackRate?.value]);
    setup.instance.stop();
    return JSON.stringify(nodes);
  };
  const first = trace(21);
  assert.equal(trace(21), first);
  assert.notEqual(trace(22), first);
});

test('short noise buffers and low sample rates still produce finite in-range schedules', () => {
  const setup = fixture({ duration: .035, sampleRate: 8000 }), { context, instance, noiseBuffer } = setup;
  setup.run(6, body({ exhausted: true, stamina: 0, danger: 1, chase: true, health: 10 }));
  for (const kind of STINGERS) instance.stinger(kind);
  instance.hurt(60); instance.surge(1); instance.land(1);
  for (const source of context.sources.filter(source => source.kind === 'buffer' && !source.loop)) {
    const consumed = (source.stops[0] - source.starts[0].time) * source.playbackRate.value;
    assert.ok(source.starts[0].offset + consumed <= noiseBuffer.duration + 1e-8);
  }
  for (const node of context.nodes.filter(node => node.frequency)) {
    assert.ok(node.frequency.events.every(event => event.value > 0 && event.value < context.sampleRate / 2));
    assert.ok(node.frequency.value > 0 && node.frequency.value < context.sampleRate / 2);
  }
  assert.deepEqual(context.errors, []);
  settle(setup);
});

test('update() at rest is allocation-free and an inactive player only fades what is already playing', () => {
  const setup = fixture(), { context, instance } = setup;
  setup.run(5, { active: false });
  assert.equal(setup.owned().length, 0, 'Menus and cutscenes allocate nothing');
  setup.run(4, body({ danger: 1, chase: true }));
  const count = context.nodes.length;
  const state = setup.run(20, { active: false, danger: 1, chase: true });
  assert.equal(context.nodes.length, count, 'No new beats or layers once inactive');
  assert.equal(state.music.level, 0);
  assert.equal(state.heart.level, 0);
  assert.equal(instance.snapshot().activeVoices, 0);
  assertReleased(setup);
});

test('stop() on a suspended context drops the graph at once, and resuming starts cleanly', () => {
  const setup = fixture(), { context, instance } = setup;
  setup.run(3, body({ danger: 1, chase: true, exhausted: true, stamina: 0 }));
  instance.stinger('streak');
  context.state = 'suspended';
  instance.update(DT, body({ danger: 1, chase: true }));
  const frozen = context.nodes.length;
  instance.stop();
  assert.equal(context.nodes.length, frozen);
  assert.ok(setup.owned().every(node => node.connections.length === 0), 'Nothing waits on a frozen audio clock');
  assert.ok(context.sources.every(source => source.onended === null));
  context.state = 'running';
  const state = setup.run(2, body({ danger: 1, chase: true }));
  assert.ok(state.music.level > 0 && setup.of('heart', context.currentTime - 2).length > 0);
  settle(setup);
});
