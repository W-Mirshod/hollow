'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const audio = require('../public/audio');
const script = readFileSync(require.resolve('../public/audio'), 'utf8');
const KINDS = ['warden', 'stalker', 'crawler', 'shrieker'];
const CUES = ['breath', 'notice', 'attack', 'death', 'step'];
const VOCALS = ['whisper', 'moan', 'growl', 'laugh', 'scream'];
const RANGES = { whisper: [1.2, 2.6], moan: [1.5, 3], growl: [.6, 1.4], laugh: [.6, 2.2], scream: [.8, 2.5] };
// Tiers mirror the module: breath < step < ambient voices < engagement < violence.
const TIERS = { breath: 0, step: 1, whisper: 2, moan: 2, notice: 3, growl: 3, laugh: 3, attack: 4, death: 4, scream: 4 };

class FakeParam {
  constructor(value, context) { this.value = value; this.events = []; this.context = context; }
  record(method, value, time) {
    assert.ok(Number.isFinite(value), `${method}: finite value`);
    assert.ok(Number.isFinite(time) && time >= 0, `${method}: finite, nonnegative time`);
    assert.ok(!this.events.length || time >= this.events[this.events.length - 1].time, 'Ordered automation');
    if (method === 'exponential') assert.ok(value > 0, 'Exponential ramps cannot reach zero');
    this.events.push({ method, value, time });
    return this;
  }
  setValueAtTime(value, time) { return this.record('set', value, time); }
  linearRampToValueAtTime(value, time) { return this.record('linear', value, time); }
  exponentialRampToValueAtTime(value, time) { return this.record('exponential', value, time); }
}

class FakeNode {
  constructor(context, kind) {
    this.context = context; this.kind = kind; this.connections = []; this.disconnects = 0;
    context.nodes.push(this);
  }
  connect(target) {
    assert.equal(target.context, this.context, 'No cross-context connections');
    this.connections.push(target);
    return target;
  }
  disconnect() { this.disconnects++; this.connections.length = 0; }
}

class FakeSource extends FakeNode {
  constructor(context, kind) {
    super(context, kind);
    this.starts = []; this.stops = []; this.onended = null; this.ended = false;
    if (kind === 'buffer') this.playbackRate = new FakeParam(1, context);
    else { this.frequency = new FakeParam(440, context); this.type = 'sine'; }
  }
  setPeriodicWave(wave) { this.wave = wave; this.type = 'custom'; }
  start(time, offset) {
    assert.equal(this.starts.length, 0, 'Each source starts exactly once');
    assert.ok(Number.isFinite(time) && time >= this.context.currentTime);
    if (this.kind === 'buffer') assert.ok(offset >= 0 && offset < this.buffer.duration);
    this.starts.push({ time, offset });
  }
  stop(time) {
    assert.equal(this.starts.length, 1, 'Only started sources can be stopped');
    assert.ok(Number.isFinite(time) && time >= 0, 'Every stop has a finite time');
    this.stops.push(time);
  }
  get endTime() {
    const stop = this.stops.length ? this.stops[this.stops.length - 1] : Infinity;
    if (this.kind !== 'buffer' || !this.starts.length) return stop;
    const { time, offset } = this.starts[0];
    return Math.min(stop, time + (this.buffer.duration - offset) / this.playbackRate.value);
  }
  finish() {
    if (this.ended) return;
    this.ended = true;
    if (this.onended) this.onended();
  }
}

class FakeContext {
  constructor({ sampleRate = 48000, legacy = false } = {}) {
    this.currentTime = 4; this.sampleRate = sampleRate; this.state = 'running'; this.legacy = legacy;
    this.nodes = []; this.waves = [];
    this.destination = new FakeNode(this, 'destination');
  }
  createGain() { const node = new FakeNode(this, 'gain'); node.gain = new FakeParam(1, this); return node; }
  createBiquadFilter() {
    const node = new FakeNode(this, 'filter');
    node.type = 'lowpass'; node.frequency = new FakeParam(350, this); node.Q = new FakeParam(1, this);
    return node;
  }
  createBufferSource() { return new FakeSource(this, 'buffer'); }
  createOscillator() { return new FakeSource(this, 'oscillator'); }
  createPeriodicWave(real, imaginary) {
    const wave = { real: Array.from(real), imaginary: Array.from(imaginary) };
    this.waves.push(wave);
    return wave;
  }
  createPanner() {
    const node = new FakeNode(this, 'panner');
    if (this.legacy) node.setPosition = (x, y, z) => { node.position = { x, y, z }; };
    else for (const key of ['positionX', 'positionY', 'positionZ']) node[key] = new FakeParam(0, this);
    return node;
  }
  createDynamicsCompressor() {
    const node = new FakeNode(this, 'compressor');
    for (const [key, value] of Object.entries({ threshold: -24, knee: 30, ratio: 12, attack: .003, release: .25 })) {
      node[key] = new FakeParam(value, this);
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
    if (dispatch) for (const source of this.sources) {
      if (source.starts.length && source.endTime <= time) source.finish();
    }
  }
}

function fixture({ api = audio, duration = 2, white = false, ...options } = {}) {
  const context = new FakeContext(options), output = context.createGain();
  output.gain.value = .63; output.connect(context.destination);
  const data = new Float32Array(Math.max(1, Math.floor(duration * context.sampleRate)));
  if (white) for (let index = 0, state = 99; index < data.length; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) | 0;
    data[index] = (state >>> 0) / 2147483648 - 1;
  }
  data[0] = .375;
  const noiseBuffer = Object.freeze({ duration, sampleRate: context.sampleRate, numberOfChannels: 1,
    length: data.length, getChannelData: () => data });
  const instance = api.create({ context, output, noiseBuffer });
  return { context, output, noiseBuffer, instance,
    owned: () => context.nodes.filter(node => node !== output && node !== context.destination) };
}
function envelopes(context) { return context.nodes.filter(node => node.kind === 'gain' && node.gain.events.length); }
function near(actual, expected, epsilon = 1e-8) { assert.ok(Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`); }
function peakTime(node) {
  const peak = Math.max(...node.gain.events.map(event => event.value));
  return node.gain.events.find(event => event.value === peak).time - node.gain.events[0].time;
}
function browserAPI(seed = 1) {
  let state = seed;
  const math = Object.create(Math);
  math.random = () => { state = (Math.imul(state, 1664525) + 1013904223) | 0; return (state >>> 0) / 4294967296; };
  const sandbox = { Math: math };
  vm.runInNewContext(script, sandbox, { filename: 'audio.js' });
  return sandbox.HollowAudio;
}

function assertReleased(setup) {
  const { context, instance, output, owned } = setup;
  assert.equal(instance.snapshot().activeVoices, 0);
  assert.equal(instance.snapshot().activeSources, 0);
  assert.ok(owned().every(node => node.connections.length === 0), 'All owned graph edges are disconnected');
  assert.ok(context.sources.every(source => source.onended === null), 'No retained ended callbacks');
  assert.equal(output.gain.value, .63, 'The supplied master volume is untouched');
  assert.equal(output.disconnects, 0);
  assert.deepEqual(output.connections, [context.destination]);
}

test('CommonJS, browser global and AMD load without audio hardware, DOM or timers', () => {
  assert.deepEqual(Object.keys(audio), ['create', 'CUE_NAMES', 'KIND_NAMES']);
  assert.ok(Object.isFrozen(audio));
  assert.deepEqual(audio.CUE_NAMES, [...CUES.slice(0, 1), 'step', 'notice', 'attack', 'death', ...VOCALS]);
  assert.deepEqual(audio.KIND_NAMES, KINDS);
  assert.ok(Object.isFrozen(audio.CUE_NAMES) && Object.isFrozen(audio.KIND_NAMES));
  assert.throws(() => { 'use strict'; audio.CUE_NAMES.push('loop'); }, TypeError);
  const globalAPI = browserAPI();
  assert.equal(typeof globalAPI.create, 'function');
  const setup = fixture({ api: globalAPI });
  assert.equal(setup.owned().length, 0, 'Creation is silent and lazy');
  assert.ok(Object.isFrozen(setup.instance));
  assert.equal(typeof setup.instance.play('stalker', 'breath', { x: 2, y: 1, z: -3 }), 'number');
  setup.instance.stop();
  assertReleased(setup);
  let amd;
  const define = (dependencies, factory) => { assert.equal(dependencies.length, 0); amd = factory(); };
  define.amd = {};
  const sandbox = { define };
  vm.runInNewContext(script, sandbox);
  assert.equal(typeof amd.create, 'function');
  assert.equal(sandbox.HollowAudio, undefined);
});

test('dependencies are validated without touching the supplied output or noise', () => {
  assert.throws(() => audio.create(), /AudioContext/);
  const setup = fixture();
  const dependencies = { context: setup.context, output: setup.output, noiseBuffer: setup.noiseBuffer };
  for (const patch of [{ context: {} }, { output: null }, { output: { connect() {} } },
    { noiseBuffer: null }, { noiseBuffer: { duration: 0 } }, { noiseBuffer: { duration: Infinity } },
    { output: fixture().output }]) {
    assert.throws(() => audio.create({ ...dependencies, ...patch }), TypeError);
  }
  assert.equal(setup.owned().length, 0);
  assert.equal(setup.noiseBuffer.getChannelData(0)[0], .375);
  assertReleased(setup);
});

for (const kind of KINDS) for (const cue of CUES) {
  test(`${kind} ${cue}: layered one-shots have finite starts, stops, envelopes and cleanup`, () => {
    const setup = fixture(), { context, instance, noiseBuffer } = setup;
    const id = instance.play(kind, cue, { x: 7, y: .8, z: -11 });
    const state = instance.snapshot(), voice = state.voices[0];
    assert.equal(voice.id, id);
    assert.equal(state.activeVoices, 1);
    assert.ok(voice.layers >= 3 && voice.layers <= 12, 'Bounded internal layers');
    assert.equal(voice.layers, context.sources.length);
    assert.equal(state.activeSources, voice.layers);
    assert.ok(voice.endsAt > voice.startedAt && voice.endsAt - voice.startedAt < 2.3);
    for (const source of context.sources) {
      assert.equal(source.starts.length, 1);
      assert.equal(source.stops.length, 1);
      assert.ok(source.starts[0].time >= voice.startedAt);
      assert.ok(source.stops[0] > source.starts[0].time && source.stops[0] <= voice.endsAt);
      assert.equal(typeof source.onended, 'function');
      if (source.kind === 'buffer') {
        assert.equal(source.buffer, noiseBuffer, 'Reuse, do not copy or regenerate, the supplied noise');
        assert.equal(source.loop, false);
        const consumed = (source.stops[0] - source.starts[0].time) * source.playbackRate.value;
        assert.ok(source.starts[0].offset + consumed <= noiseBuffer.duration + 1e-8);
      } else assert.ok(['sine', 'custom'].includes(source.type), 'No naked saw/square buzz');
    }
    const layers = envelopes(context);
    assert.equal(layers.length, voice.layers);
    for (const layer of layers) {
      const events = layer.gain.events;
      assert.equal(events[0].value, 0, 'Start silent');
      assert.equal(events[events.length - 1].value, 0, 'End at true zero');
      assert.ok(events.length >= 5, 'Articulated rather than flat envelopes');
      assert.ok(events.every(event => event.time <= voice.endsAt && event.value >= 0 && event.value <= 1));
    }
    context.advanceTo(voice.endsAt + .1);
    assertReleased(setup);
    const count = context.nodes.length;
    context.advanceTo(context.currentTime + 60);
    assert.equal(context.nodes.length, count, 'Nothing reschedules itself');
  });
}

const isParam = target => target instanceof FakeParam;
const ownerOf = (context, param) => context.nodes.find(node => Object.values(node).includes(param));
const feeding = (context, target) => context.nodes.filter(node => node.connections.includes(target));
const envelopeOf = (context, source) => source.connections.length === 1 ? source.connections[0] : null;
const crest = node => Math.max(...node.gain.events.map(event => event.value));
// Distinct rises from silence/floor to a real articulation, e.g. syllables, bursts or clicks.
function articulations(node, threshold = .25) {
  let count = 0, armed = true;
  for (const { value } of node.gain.events) {
    if (armed && value > threshold) { count++; armed = false; } else if (value <= threshold * .3) armed = true;
  }
  return count;
}
function frequencyRanges(context) {
  for (const node of context.nodes.filter(node => node.frequency)) {
    const values = node.frequency.events.length ? node.frequency.events.map(event => event.value) : [node.frequency.value];
    assert.ok(values.every(value => value > 0 && value < context.sampleRate / 2), `${node.kind} frequency in range`);
  }
}
// Checks shared by every vocal: finite one-shots, exactly one silent-ended envelope per source,
// modulators only drive static stages inside the voice, and the voice stays inside its stated length.
function assertVocal(setup, cue, voice, nodes = setup.owned()) {
  const { context, noiseBuffer, output } = setup;
  const owned = new Set(nodes), sources = nodes.filter(node => node instanceof FakeSource);
  const [shortest, longest] = RANGES[cue], length = voice.endsAt - voice.startedAt;
  assert.ok(length >= shortest && length <= longest, `${voice.kind} ${cue} lasts ${length.toFixed(3)} s`);
  assert.ok(voice.layers >= 3 && voice.layers <= 12, 'Bounded internal layers');
  assert.equal(voice.layers, sources.length);
  const layers = new Set();
  for (const source of sources) {
    assert.equal(source.starts.length, 1);
    assert.ok(source.starts[0].time >= voice.startedAt);
    assert.ok(source.stops[0] > source.starts[0].time && source.stops[0] <= voice.endsAt + 1e-9);
    assert.equal(typeof source.onended, 'function');
    if (source.kind === 'buffer') {
      assert.equal(source.buffer, noiseBuffer); assert.equal(source.loop, false);
      assert.ok(source.playbackRate.value >= .5 && source.playbackRate.value <= 1.18);
      const consumed = (source.stops[0] - source.starts[0].time) * source.playbackRate.value;
      assert.ok(source.starts[0].offset + consumed <= noiseBuffer.duration + 1e-8);
    } else assert.ok(['sine', 'custom'].includes(source.type), 'No naked saw/square buzz');
    const layer = envelopeOf(context, source);
    assert.ok(layer && layer.kind === 'gain' && layer.gain.events.length, 'Each source feeds exactly its own envelope');
    assert.ok(!layers.has(layer)); layers.add(layer);
  }
  const automated = [...owned].filter(node => node.kind === 'gain' && node.gain.events.length);
  assert.deepEqual(new Set(automated), layers, 'Every automated gain is one source envelope');
  for (const layer of layers) {
    const events = layer.gain.events;
    assert.equal(events[0].value, 0, 'Start silent'); assert.equal(events[events.length - 1].value, 0, 'End at true zero');
    assert.ok(events.length >= 5, 'Articulated rather than flat envelopes');
    assert.ok(events.every(event => event.time >= voice.startedAt && event.time <= voice.endsAt + 1e-9 && event.value >= 0 && event.value <= 1));
    for (const target of layer.connections) {
      if (!isParam(target)) continue;
      const stage = ownerOf(context, target);
      assert.ok(owned.has(stage) && stage.kind === 'gain' && stage.gain === target, 'Modulators only drive gains in the voice');
      assert.equal(stage.gain.events.length, 0, 'Modulated stages have no automation of their own');
      assert.ok(stage.gain.value - crest(layer) >= -1e-9 || stage.gain.value === 0, 'Amplitude modulation never flips polarity');
      assert.ok(stage.connections.every(next => next.type !== 'lowpass'), 'The occlusion master is never modulated');
    }
  }
  frequencyRanges(context);
  const panner = [...owned].find(node => node.kind === 'panner');
  assert.equal(panner.panningModel, 'HRTF'); assert.equal(panner.maxDistance, 60);
  assert.equal(context.nodes.filter(node => node.connections.includes(output)).length, 1, 'No unprotected dry path');
}

for (const kind of KINDS) for (const cue of VOCALS) {
  test(`${kind} ${cue}: vocal one-shots keep finite schedules, one envelope per layer and full cleanup`, () => {
    const setup = fixture(), { context, instance } = setup;
    const id = instance.play(kind, cue, { x: -5, y: 1.4, z: 6 });
    const state = instance.snapshot(), voice = state.voices[0];
    assert.equal(voice.id, id); assert.equal(voice.cue, cue); assert.equal(voice.kind, kind);
    assert.equal(state.activeVoices, 1); assert.equal(state.activeSources, voice.layers);
    assert.equal(voice.layers, context.sources.length);
    assertVocal(setup, cue, voice);
    context.advanceTo(voice.endsAt + .1);
    assertReleased(setup);
    const count = context.nodes.length;
    context.advanceTo(context.currentTime + 60);
    assert.equal(context.nodes.length, count, 'Nothing reschedules itself');
  });
}

test('vocal lengths, layer budgets and envelopes hold across many random seeds', () => {
  for (let seed = 1; seed <= 24; seed++) {
    const setup = fixture({ api: browserAPI(seed * 7919) }), { context, instance } = setup;
    for (const kind of KINDS) for (const cue of VOCALS) {
      const before = context.nodes.length;
      instance.play(kind, cue);
      const voice = instance.snapshot().voices[0];
      assertVocal(setup, cue, voice, context.nodes.slice(before));
      instance.stop();
    }
    assertReleased(setup);
  }
});

test('species have distinct vocal registers and resonances; the wail is dissonant, not a shared growl', () => {
  const pitches = { warden: 48, stalker: 94, crawler: 132, shrieker: 285 };
  const formants = { warden: [190, 510], stalker: [430, 1380], crawler: [680, 1950], shrieker: [1080, 2920] };
  const signatures = new Set();
  for (const kind of KINDS) {
    const { context, instance } = fixture();
    instance.play(kind, 'notice');
    const voiced = context.sources.filter(source => source.type === 'custom');
    const pitch = voiced[0].frequency.events[0].value;
    assert.ok(pitch >= pitches[kind] * .94 && pitch <= pitches[kind] * 1.06);
    const bands = context.nodes.filter(node => node.type === 'bandpass').map(node => node.frequency.events[0].value);
    for (const expected of formants[kind]) assert.ok(bands.some(value => value >= expected * .94 && value <= expected * 1.06));
    signatures.add(bands.map(value => Math.round(value / 10)).join(','));
    assert.equal(context.waves.length, 1, 'Reuse a glottal wave within an instance');
    const wave = context.waves[0];
    assert.ok(wave.real.every(value => value === 0));
    assert.equal(wave.imaginary[0], 0, 'No DC component');
    for (let index = 2; index < wave.imaginary.length; index++) {
      assert.ok(wave.imaginary[index] > 0 && wave.imaginary[index] < wave.imaginary[index - 1]);
    }
    if (kind === 'shrieker') {
      assert.equal(voiced.length, 3);
      near(voiced[1].frequency.events[0].value / pitch, 1.067);
      near(voiced[2].frequency.events[0].value / pitch, 1.414);
      assert.ok(instance.snapshot().voices[0].endsAt - instance.snapshot().voices[0].startedAt > 1.8);
    } else assert.equal(voiced.length, 1);
    instance.stop();
  }
  assert.equal(signatures.size, 4);
});

test('sneaky breath is quiet, unvoiced, spatial and slower to open than an attack', () => {
  const breath = fixture(), attack = fixture(), death = fixture();
  breath.instance.play('stalker', 'breath', { x: -4, y: 1.7, z: 9 });
  attack.instance.play('stalker', 'attack');
  death.instance.play('stalker', 'death');
  assert.ok(breath.context.sources.every(source => source.kind === 'buffer'), 'Whispers contain no buzzy oscillators');
  assert.equal(breath.context.sources.length, 6, 'One exhale plus five choked grains');
  assert.ok(breath.instance.snapshot().voices[0].gain < attack.instance.snapshot().voices[0].gain * .3);
  assert.ok(peakTime(envelopes(breath.context)[0]) > peakTime(envelopes(attack.context)[0]) * 5);
  assert.notDeepEqual(envelopes(breath.context)[0].gain.events.map(event => event.value),
    envelopes(death.context)[0].gain.events.map(event => event.value));
  const panner = breath.context.nodes.find(node => node.kind === 'panner');
  assert.equal(panner.refDistance, 1.4);
  assert.equal(panner.rolloffFactor, 1.65, 'Whispers disappear at a distance rather than becoming global ambience');
  const dyingPitch = death.context.sources.find(source => source.type === 'custom').frequency.events;
  assert.ok(dyingPitch[dyingPitch.length - 1].value < dyingPitch[0].value * .5, 'Collapse loses vocal tension');
  assert.ok(death.context.sources.some(source => source.type === 'sine' && source.starts[0].time > 4.35), 'Delayed body impact');
  for (const setup of [breath, attack, death]) setup.instance.stop();
});

test('claws use irregular finite ticks and a longer broken scrape; Warden steps have sub-bass weight', () => {
  const crawler = fixture({ api: browserAPI(17) }), warden = fixture();
  crawler.instance.play('crawler', 'step');
  const ticks = crawler.context.sources.slice(0, 4), scrape = crawler.context.sources[4];
  const gaps = ticks.slice(1).map((source, index) => source.starts[0].time - ticks[index].starts[0].time);
  assert.ok(gaps.every(value => value > .04 && value < .15));
  assert.ok(new Set(gaps.map(value => value.toFixed(5))).size > 1, 'Not clocked chatter');
  assert.ok(ticks.every(source => source.stops[0] - source.starts[0].time < .09));
  assert.ok(scrape.stops[0] - scrape.starts[0].time > .4);
  assert.ok(crawler.context.sources.every(source => source.kind === 'buffer'));
  warden.instance.play('warden', 'step');
  const body = warden.context.sources.find(source => source.type === 'sine');
  assert.ok(body.frequency.events[0].value > 50 && body.frequency.events[0].value < 65);
  assert.ok(warden.context.sources.some(source => source.type === 'custom'), 'Footfall also contains a throat/wood-like creak');
  crawler.instance.stop(); warden.instance.stop();
});

test('fresh cues vary grain offsets, articulation timing and pitch without allocating another noise buffer', () => {
  const { context, instance, noiseBuffer } = fixture({ api: browserAPI(23) });
  const traces = [];
  for (let index = 0; index < 3; index++) {
    const before = context.sources.length;
    instance.play('warden', 'breath');
    traces.push(context.sources.slice(before).map(source => ({ start: source.starts[0], end: source.stops[0],
      rate: source.playbackRate?.value, pitch: source.frequency?.events[0].value })));
    instance.stop();
  }
  assert.notDeepEqual(traces[0], traces[1]);
  assert.notDeepEqual(traces[1], traces[2]);
  assert.ok(context.sources.filter(source => source.kind === 'buffer').every(source => source.buffer === noiseBuffer));
  assert.equal(context.waves.length, 1);
});

test('HRTF uses the exact source coordinates, including legacy panners, without changing the listener', () => {
  for (const legacy of [false, true]) {
    const setup = fixture({ legacy }), { context, instance } = setup;
    const position = { x: -13.25, y: .24, z: 28.5 };
    instance.play('crawler', 'breath', position);
    const panner = context.nodes.find(node => node.kind === 'panner');
    assert.equal(panner.panningModel, 'HRTF');
    assert.equal(panner.distanceModel, 'exponential');
    assert.equal(panner.maxDistance, 60);
    if (legacy) assert.deepEqual(panner.position, position);
    else for (const [key, value] of Object.entries(position)) {
      const parameter = panner[`position${key.toUpperCase()}`];
      assert.equal(parameter.events[0].value, value);
    }
    assert.deepEqual(instance.snapshot().voices[0].position, position);
    assert.equal(context.listener, undefined, 'The module does not require or replace listener state');
    instance.stop();
    assertReleased(setup);
  }
});

test('occlusion darkens and attenuates the entire positioned voice; partial obstruction is continuous', () => {
  const states = [];
  for (const occluded of [false, .5, true]) {
    const { context, instance } = fixture();
    instance.play('stalker', 'notice', { x: 3, y: 2, z: -8, volume: .5, occluded });
    const voice = instance.snapshot().voices[0];
    const wall = context.nodes.find(node => node.type === 'lowpass');
    const panner = context.nodes.find(node => node.kind === 'panner');
    const gain = context.nodes.find(node => node.kind === 'gain' && node.connections.includes(wall));
    assert.equal(wall.frequency.value, voice.lowpass);
    assert.equal(gain.gain.value, voice.gain);
    assert.deepEqual(wall.connections, [panner]);
    assert.deepEqual(voice.position, { x: 3, y: 2, z: -8 });
    states.push(voice);
    instance.stop();
  }
  near(states[0].lowpass, 10000); near(states[2].lowpass, 750);
  near(states[2].gain / states[0].gain, .28);
  near(states[0].gain, .36 * .7 * .5);
  assert.ok(states[0].gain > states[1].gain && states[1].gain > states[2].gain);
  assert.ok(states[0].lowpass > states[1].lowpass && states[1].lowpass > states[2].lowpass);
});

test('the shared stereo bus provides headroom, compression and a symmetric bounded soft limiter', () => {
  const setup = fixture(), { context, output, instance } = setup;
  for (let index = 0; index < 8; index++) instance.play('shrieker', 'attack', { volume: 100 });
  const compressors = context.nodes.filter(node => node.kind === 'compressor');
  assert.equal(compressors.length, 1, 'All voices share one compressor');
  const compressor = compressors[0], limiter = context.nodes.find(node => node.kind === 'shaper');
  assert.equal(compressor.threshold.value, -18); assert.equal(compressor.knee.value, 18);
  assert.equal(compressor.ratio.value, 8); assert.ok(compressor.attack.value <= .005);
  assert.equal(compressor.release.value, .18);
  assert.deepEqual(compressor.connections, [limiter]);
  assert.deepEqual(limiter.connections, [output]);
  assert.equal(limiter.oversample, '2x');
  assert.equal(limiter.curve[512], 0);
  for (let index = 0; index < limiter.curve.length; index++) {
    assert.ok(Math.abs(limiter.curve[index]) < .7);
    near(limiter.curve[index], -limiter.curve[limiter.curve.length - 1 - index]);
    if (index) assert.ok(limiter.curve[index] >= limiter.curve[index - 1]);
  }
  const headroom = context.nodes.find(node => node.connections.includes(compressor));
  assert.equal(headroom.gain.value, .7);
  const highpass = context.nodes.find(node => node.connections.includes(headroom));
  assert.equal(highpass.type, 'highpass'); assert.equal(highpass.frequency.value, 24);
  const panners = context.nodes.filter(node => node.kind === 'panner');
  assert.equal(panners.length, 8);
  assert.ok(panners.every(node => node.connections.length === 1 && node.connections[0] === highpass));
  assert.equal(context.nodes.filter(node => node.connections.includes(output)).length, 1, 'No unprotected dry path');
  assert.ok(instance.snapshot().voices.every(voice => voice.volume === 1));
  instance.stop(); assertReleased(setup);
});

test('eight-voice cap retires oldest lowest-priority cues and protects attacks from quiet movement', () => {
  const setup = fixture(), { context, instance } = setup;
  const first = instance.play('stalker', 'breath');
  const firstSources = context.sources.slice(), staleEnded = firstSources[0].onended;
  for (let index = 1; index < 8; index++) instance.play(KINDS[index % 4], 'breath');
  assert.equal(instance.snapshot().activeVoices, 8);
  instance.play('crawler', 'step');
  assert.equal(instance.snapshot().activeVoices, 8);
  assert.ok(instance.snapshot().voices.every(voice => voice.id !== first));
  assert.ok(firstSources.every(source => source.onended === null && source.connections.length === 0 && source.stops[1] === context.currentTime));
  staleEnded();
  assert.equal(instance.snapshot().activeVoices, 8, 'An already-queued ended callback cannot remove a replacement');
  for (let index = 0; index < 8; index++) instance.play(KINDS[index % 4], 'attack');
  assert.ok(instance.snapshot().voices.every(voice => voice.cue === 'attack'));
  const before = context.nodes.length;
  for (const cue of ['breath', 'step', 'notice']) assert.equal(instance.play('warden', cue), null);
  assert.equal(context.nodes.length, before, 'Dropped cues do not allocate nodes');
  const oldestAttack = instance.snapshot().voices[0].id;
  assert.equal(typeof instance.play('warden', 'death'), 'number');
  assert.ok(instance.snapshot().voices.every(voice => voice.id !== oldestAttack));
  for (let index = 0; index < 100; index++) {
    instance.play(KINDS[index % 4], CUES[index % 5]);
    assert.ok(instance.snapshot().activeVoices <= 8);
    assert.ok(instance.snapshot().activeSources <= 8 * 12);
    assert.ok(context.sources.filter(source => !source.ended && source.endTime > context.currentTime).length <= 8 * 12);
    context.advanceTo(context.currentTime + .07);
  }
  instance.stop(); assertReleased(setup);
});

test('onended disconnects each source promptly and releases the entire graph after the final layer', () => {
  const setup = fixture(), { context, instance } = setup;
  instance.play('shrieker', 'death');
  const voice = instance.snapshot().voices[0], sources = context.sources;
  const first = sources.reduce((earliest, source) => source.endTime < earliest.endTime ? source : earliest);
  context.advanceTo(first.endTime + .000001);
  assert.equal(first.onended, null); assert.equal(first.connections.length, 0);
  assert.equal(instance.snapshot().activeVoices, 1);
  assert.ok(instance.snapshot().activeSources < sources.length);
  context.advanceTo(voice.endsAt + .01);
  assertReleased(setup);
});

test('an audio-clock prune cleans up even if ended event delivery is delayed', () => {
  const setup = fixture(), { context, instance } = setup;
  instance.play('warden', 'notice');
  const endsAt = instance.snapshot().voices[0].endsAt;
  context.advanceTo(endsAt + .1, false);
  assert.ok(context.sources.every(source => !source.ended));
  assertReleased(setup);
  assert.equal(typeof instance.play('stalker', 'step'), 'number');
  instance.stop(); assertReleased(setup);
});

test('stop is idempotent, cancels future layers immediately and permits a fresh cue afterwards', () => {
  const setup = fixture(), { context, instance } = setup;
  instance.stop(); instance.stop();
  assert.equal(setup.owned().length, 0);
  const first = instance.play('warden', 'death');
  instance.play('crawler', 'breath');
  const sources = context.sources, callbacks = sources.map(source => source.onended);
  assert.ok(sources.some(source => source.starts[0].time > context.currentTime + .5));
  instance.stop();
  assertReleased(setup);
  assert.ok(sources.every(source => source.stops[source.stops.length - 1] === context.currentTime));
  const stops = sources.map(source => source.stops.length);
  instance.stop(); instance.stop();
  assert.deepEqual(sources.map(source => source.stops.length), stops);
  const replacement = instance.play('stalker', 'breath');
  assert.ok(replacement > first);
  for (const callback of callbacks) callback();
  assert.equal(instance.snapshot().activeVoices, 1);
  instance.stop(); assertReleased(setup);
});

test('invalid/muted payloads and inactive contexts are silent; numeric controls are bounded', () => {
  const setup = fixture(), { context, instance } = setup;
  for (const [kind, cue, options] of [
    ['ghost', 'breath', {}], ['toString', 'attack', {}], ['warden', '__proto__', {}],
    [['stalker'], 'breath', {}], ['warden', ['attack'], {}], [null, 'breath', {}], ['warden', 0, {}],
    ['warden', 'loop', {}], ['stalker', 'breath', { x: NaN }], ['crawler', 'step', { y: Infinity }],
    ['stalker', 'breath', { z: '4' }], ['shrieker', 'notice', { volume: NaN }],
    ['shrieker', 'attack', { volume: 0 }], ['warden', 'death', { volume: -2 }],
    ['warden', 'breath', { volume: Infinity }], ['stalker', 'step', { occluded: 'yes' }]
  ]) assert.equal(instance.play(kind, cue, options), null);
  for (const state of ['suspended', 'interrupted', 'closed']) {
    context.state = state;
    assert.equal(instance.play('shrieker', 'attack'), null);
  }
  assert.equal(setup.owned().length, 0);
  context.state = 'running';
  instance.play('warden', 'breath', { volume: 2, occluded: 3 });
  let voice = instance.snapshot().voices[0];
  assert.equal(voice.volume, 1); assert.equal(voice.occluded, 1);
  assert.deepEqual(voice.position, { x: 0, y: 0, z: 0 });
  instance.stop();
  instance.play('warden', 'step', { occluded: -2 });
  voice = instance.snapshot().voices[0];
  assert.equal(voice.occluded, 0);
  instance.stop(); assertReleased(setup);
});

test('offline contexts can stage finite cues while initially suspended, without being started by the module', () => {
  const setup = fixture(), { context, instance } = setup;
  context.state = 'suspended';
  context.startRendering = () => { assert.fail('The caller owns offline rendering'); };
  assert.equal(typeof instance.play('shrieker', 'notice'), 'number');
  assert.equal(instance.snapshot().activeVoices, 1);
  assert.equal(context.state, 'suspended');
  instance.stop(); assertReleased(setup);
});

test('short noise buffers and low sample rates still produce finite in-range schedules', () => {
  const setup = fixture({ duration: .035, sampleRate: 8000 }), { context, instance, noiseBuffer } = setup;
  instance.play('shrieker', 'notice');
  for (const source of context.sources.filter(source => source.kind === 'buffer')) {
    const consumed = (source.stops[0] - source.starts[0].time) * source.playbackRate.value;
    assert.ok(source.starts[0].offset + consumed <= noiseBuffer.duration + 1e-8);
    assert.equal(source.loop, false);
  }
  for (const node of context.nodes.filter(node => node.frequency)) {
    assert.ok(node.frequency.events.every(event => event.value > 0 && event.value < context.sampleRate / 2));
  }
  const lowpass = context.nodes.find(node => node.type === 'lowpass');
  assert.ok(lowpass.frequency.value < context.sampleRate / 2);
  instance.stop(); assertReleased(setup);
});

test('snapshot is detached metadata, not access to live nodes or mutable playback state', () => {
  const setup = fixture(), { instance } = setup;
  instance.play('stalker', 'breath', { x: 3, z: 7 });
  const before = instance.snapshot(), changed = instance.snapshot();
  changed.voices[0].position.x = 999; changed.voices[0].gain = 100;
  changed.voices[0].sources = 0; changed.voices.length = 0; changed.activeVoices = 90;
  assert.deepEqual(instance.snapshot(), before);
  assert.doesNotThrow(() => JSON.stringify(before));
  assert.equal(before.maxVoices, 8);
  instance.stop(); assertReleased(setup);
});

test('a failed voice build cancels and disconnects layers that were already scheduled', () => {
  const setup = fixture(), { context, instance } = setup;
  context.createOscillator = () => { throw new Error('Synthetic allocation failure'); };
  assert.throws(() => instance.play('warden', 'breath'), /Synthetic allocation failure/);
  assert.ok(context.sources.length > 0, 'Exercise a partial build');
  assertReleased(setup);
  assert.ok(context.sources.every(source => source.stops[source.stops.length - 1] === context.currentTime));
});

// A small offline renderer for the fake graph: enough WebAudio semantics (automation, AudioParam
// inputs, biquads, wave shapers, periodic waves) to measure what a cue actually sounds like.
const tables = new WeakMap();
function wavetable(wave) {
  if (!tables.has(wave)) {
    const data = new Float64Array(2048);
    for (let index = 0; index < data.length; index++) for (let harmonic = 1; harmonic < wave.imaginary.length; harmonic++) {
      const angle = 2 * Math.PI * harmonic * index / data.length;
      data[index] += wave.imaginary[harmonic] * Math.sin(angle) + wave.real[harmonic] * Math.cos(angle);
    }
    const peak = Math.max(...data.map(Math.abs));
    tables.set(wave, data.map(value => value / peak));
  }
  return tables.get(wave);
}
function automation(param) {
  const events = param.events;
  let index = 0;
  return time => {
    while (index < events.length && events[index].time <= time) index++;
    if (!index) return param.value;
    const previous = events[index - 1], next = events[index], mix = next && (time - previous.time) / (next.time - previous.time);
    if (next && next.method === 'linear') return previous.value + (next.value - previous.value) * mix;
    if (next && next.method === 'exponential') return previous.value * Math.pow(next.value / previous.value, mix);
    return previous.value;
  };
}
function biquad(type, frequency, q, rate) {
  const w = 2 * Math.PI * Math.min(Math.max(frequency, 1), rate * .499) / rate, cos = Math.cos(w), sin = Math.sin(w);
  const alpha = type === 'bandpass' ? sin / (2 * Math.max(q, 1e-4)) : sin / (2 * Math.pow(10, q / 20));
  const b = type === 'bandpass' ? [alpha, 0, -alpha] : type === 'highpass' ? [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2] : [(1 - cos) / 2, 1 - cos, (1 - cos) / 2];
  const a0 = 1 + alpha;
  return [b[0] / a0, b[1] / a0, b[2] / a0, -2 * cos / a0, (1 - alpha) / a0];
}
function render(context, target, from, to) {
  const rate = context.sampleRate, frames = Math.ceil((to - from) * rate), size = 128;
  const inputs = new Map(), timelines = new Map(), states = new Map(), result = new Float64Array(frames);
  for (const node of context.nodes) for (const next of node.connections) {
    if (!inputs.has(next)) inputs.set(next, []);
    inputs.get(next).push(node);
  }
  let base = 0, memo = new Map();
  const timeAt = index => from + (base + index) / rate;
  const mix = into => {
    const sum = new Float64Array(size);
    for (const node of inputs.get(into) || []) { const out = pull(node); for (let i = 0; i < size; i++) sum[i] += out[i]; }
    return sum;
  };
  const values = param => {
    if (!timelines.has(param)) timelines.set(param, automation(param));
    const timeline = timelines.get(param), sum = mix(param);
    for (let i = 0; i < size; i++) sum[i] += timeline(timeAt(i));
    return sum;
  };
  function pull(node) {
    if (memo.has(node)) return memo.get(node);
    const out = new Float64Array(size);
    if (!states.has(node)) states.set(node, { phase: 0, x1: 0, x2: 0, y1: 0, y2: 0 });
    const state = states.get(node);
    memo.set(node, out);
    if (node instanceof FakeSource) {
      if (!node.starts.length) return out;
      const begin = node.starts[0].time, end = node.stops.length ? node.stops[node.stops.length - 1] : Infinity;
      const frequency = node.kind === 'buffer' ? null : values(node.frequency);
      const data = node.kind === 'buffer' ? node.buffer.getChannelData(0) : node.type === 'custom' ? wavetable(node.wave) : null;
      for (let i = 0; i < size; i++) {
        const time = timeAt(i);
        if (time < begin || time >= end) continue;
        if (node.kind === 'buffer') {
          const at = Math.floor((node.starts[0].offset + (time - begin) * node.playbackRate.value) * node.buffer.sampleRate);
          out[i] = at < data.length ? data[at] : 0;
        } else {
          state.phase = (state.phase + frequency[i] / rate) % 1;
          out[i] = data ? data[Math.floor(state.phase * data.length)] : Math.sin(2 * Math.PI * state.phase);
        }
      }
      return out;
    }
    const input = mix(node);
    if (node.kind === 'gain') {
      const gain = values(node.gain);
      for (let i = 0; i < size; i++) out[i] = input[i] * gain[i];
    } else if (node.kind === 'filter') {
      const frequency = values(node.frequency), q = values(node.Q);
      let c;
      for (let i = 0; i < size; i++) {
        if (i % 8 === 0) c = biquad(node.type, frequency[i], q[i], rate);
        const y = c[0] * input[i] + c[1] * state.x1 + c[2] * state.x2 - c[3] * state.y1 - c[4] * state.y2;
        state.x2 = state.x1; state.x1 = input[i]; state.y2 = state.y1; state.y1 = y; out[i] = y;
      }
    } else if (node.kind === 'shaper' && node.curve) {
      const curve = node.curve, last = curve.length - 1;
      for (let i = 0; i < size; i++) {
        const at = Math.min(last, Math.max(0, (input[i] + 1) / 2 * last)), low = Math.floor(at), high = Math.min(last, low + 1);
        out[i] = curve[low] + (curve[high] - curve[low]) * (at - low);
      }
    } else out.set(input);
    return out;
  }
  for (base = 0; base < frames; base += size) {
    memo = new Map();
    const out = pull(target);
    for (let i = 0; i < size && base + i < frames; i++) result[base + i] = out[i];
  }
  return result;
}
// Peak short-term (50 ms) RMS, a rough proxy for how loud a one-shot is perceived.
function loudness(signal, rate, window = .05) {
  const size = Math.max(1, Math.round(window * rate));
  let best = 0;
  for (let start = 0; start + size <= signal.length; start += size >> 1) {
    let sum = 0;
    for (let index = start; index < start + size; index++) sum += signal[index] * signal[index];
    best = Math.max(best, Math.sqrt(sum / size));
  }
  return best;
}
function measure(kind, cue, seed = 5) {
  const setup = fixture({ api: browserAPI(seed), sampleRate: 22050, white: true }), { context, instance } = setup;
  instance.play(kind, cue);
  const voice = instance.snapshot().voices[0], wall = context.nodes.find(node => node.type === 'lowpass');
  const signal = render(context, wall, voice.startedAt, voice.endsAt);
  instance.stop();
  return { signal, rate: context.sampleRate, loud: loudness(signal, context.sampleRate), peak: Math.max(...signal.map(Math.abs)) };
}

test('rendered loudness: screams lead, whispers stay intimate, nothing is silent or clips inside a voice', t => {
  const seeds = [5, 29];
  for (const kind of KINDS) {
    const level = {};
    for (const cue of [...CUES, ...VOCALS]) {
      const runs = seeds.map(seed => measure(kind, cue, seed));
      for (const { signal, peak, loud } of runs) {
        assert.ok(signal.every(Number.isFinite), `${kind} ${cue} renders finite samples`);
        assert.ok(peak < .6, `${kind} ${cue} leaves headroom before the shared bus`);
        assert.ok(loud > .012 || CUES.includes(cue), `${kind} ${cue} is audible`);
      }
      level[cue] = runs.reduce((sum, run) => sum + run.loud, 0) / runs.length;
    }
    t.diagnostic(`${kind} ${Object.entries(level).map(([cue, value]) => `${cue}=${value.toFixed(3)}`).join(' ')}`);
    const calm = ['breath', 'step', 'whisper', 'moan', 'laugh', 'growl', 'notice'];
    assert.ok(level.scream >= 1.4 * Math.max(...calm.map(cue => level[cue])), `${kind} scream leads every non-violent cue`);
    assert.ok(level.scream >= .85 * Math.max(level.attack, level.death), `${kind} scream matches the violent tier`);
    assert.ok(level.whisper >= .9 * level.breath && level.whisper < .9 * level.notice, `${kind} whisper sits between breath and notice`);
    assert.ok(level.whisper < level.growl && level.growl <= 1.1 * level.attack, `${kind} growl stays under an attack`);
    for (const cue of ['moan', 'laugh']) assert.ok(level[cue] < .6 * level.scream && level[cue] > level.breath, `${kind} ${cue} balance`);
  }
});

const tractOf = context => context.nodes.filter(node => node.type === 'bandpass' &&
  feeding(context, node).some(input => input.kind === 'gain' && !input.gain.events.length));
const turns = values => values.slice(2).filter((value, index) => Math.sign(value - values[index + 1]) * Math.sign(values[index + 1] - values[index]) < 0).length;
const layerOf = (context, source) => envelopeOf(context, source);
const startsAt = (layer, threshold = .25) => {
  const times = [];
  let armed = true;
  for (const { value, time } of layer.gain.events) {
    if (armed && value > threshold) { times.push(time); armed = false; } else if (value <= threshold * .3) armed = true;
  }
  return times;
};
const modulators = context => context.sources.filter(source => layerOf(context, source)?.connections.some(isParam));

test('whispers are breathy syllables through moving vowel formants with sibilant bursts and uneven rhythm', () => {
  const sibilance = Object.fromEntries(KINDS.map(kind => [kind, 0]));
  for (const kind of KINDS) for (const seed of [3, 8, 21, 34]) {
    const { context, instance } = fixture({ api: browserAPI(seed) });
    instance.play(kind, 'whisper');
    const voice = instance.snapshot().voices[0], noise = context.sources.filter(source => source.kind === 'buffer');
    const voicedLayers = context.sources.filter(source => source.kind === 'oscillator').map(source => layerOf(context, source));
    const mouth = tractOf(context), input = feeding(context, mouth[0]).find(node => !node.gain.events.length);
    assert.equal(mouth.length, 3, 'F1–F3 resonators');
    for (const filter of mouth) assert.ok(filter.frequency.events.length >= 5 && turns(filter.frequency.events.map(event => event.value)) >= 1, 'Vowels move');
    const syllables = feeding(context, input).filter(layer => noise.some(source => layerOf(context, source) === layer));
    const onsets = syllables.flatMap(layer => startsAt(layer, .2)).sort((a, b) => a - b);
    assert.ok(onsets.length >= 3, `${kind} whispers several syllables`);
    const gaps = onsets.slice(1).map((time, index) => time - onsets[index]);
    assert.ok(Math.max(...gaps) > Math.min(...gaps) * 1.15, 'Irregular syllable rhythm');
    const sibilant = context.nodes.find(node => node.type === 'bandpass' && node.Q.events.length);
    assert.ok(sibilant.frequency.events.every(event => event.method === 'set'), 'Consonants switch cleanly between bursts');
    assert.ok(startsAt(feeding(context, sibilant)[0]).length >= 1);
    if (sibilant.frequency.events.some(event => event.value > 2000)) sibilance[kind]++;
    assert.ok(noise.length >= 3 && Math.max(...voicedLayers.map(crest), 0) < Math.max(...noise.map(source => crest(layerOf(context, source)))), 'Breath dominates any voicing');
    const panner = context.nodes.find(node => node.kind === 'panner');
    assert.equal(panner.refDistance, 1); assert.equal(panner.rolloffFactor, 1.5);
    const custom = context.sources.filter(source => source.type === 'custom');
    const lateNoise = noise.reduce((late, source) => source.starts[0].time > late.starts[0].time ? source : late);
    if (kind === 'stalker' || kind === 'warden') {
      assert.equal(custom.length, 1, 'A voice leaks through the whisper');
      const pitch = custom[0].frequency.events[0].value;
      assert.ok(kind === 'warden' ? pitch < 60 : pitch > 94 * 1.05 && pitch < 94 * 1.45);
      if (kind === 'stalker') assert.ok(peakTime(layerOf(context, lateNoise)) > .85 * (lateNoise.stops[0] - lateNoise.starts[0].time), 'Ends on a sharp ingressive gasp');
    } else if (kind === 'crawler') {
      assert.equal(custom.length, 0);
      const wet = context.sources.find(source => source.type === 'sine'), events = wet.frequency.events;
      assert.ok(startsAt(layerOf(context, wet), crest(layerOf(context, wet)) * .4).length >= 7, 'Wet chitter clicks');
      events.forEach((event, index) => { if (event.method === 'exponential') assert.ok(event.value > events[index - 1].value * 1.5, 'Droplets rise'); });
      assert.ok(context.nodes.some(node => node.type === 'bandpass' && node.frequency.value > 3000 && !node.frequency.events.length), 'Hissing band');
    } else {
      assert.equal(custom.length, 1);
      const whimper = custom[0].frequency.events;
      assert.ok(whimper[0].value > 300 && whimper[whimper.length - 1].value < whimper[0].value * .8, 'A voice cracking downward');
      assert.ok(startsAt(layerOf(context, lateNoise), .3).length >= 2, 'Sobbing catches of breath');
    }
    assert.ok(voice.endsAt - voice.startedAt >= 1.2);
    instance.stop();
  }
  for (const kind of ['stalker', 'crawler', 'shrieker']) assert.ok(sibilance[kind] >= 2, `${kind} hisses s/sh/t sibilants`);
});

test('moans glide oo-ah-oo, sink in pitch with jitter, double an octave down and ring-modulate', () => {
  for (const kind of KINDS) for (const seed of [2, 13]) {
    const { context, instance } = fixture({ api: browserAPI(seed) });
    instance.play(kind, 'moan');
    const [main, sub] = context.sources.filter(source => source.type === 'custom'), pitch = main.frequency.events;
    assert.ok(pitch.length >= 10 && turns(pitch.map(event => event.value)) >= 3, 'Irregular jitter/vibrato');
    assert.ok(pitch[pitch.length - 1].value < pitch[0].value * .8, 'Pitch drifts down');
    near(sub.frequency.events[0].value / pitch[0].value, .498, 1e-9);
    const ring = context.nodes.find(node => node.kind === 'gain' && node.gain.value === 0 && !node.gain.events.length);
    assert.ok(feeding(context, ring).includes(layerOf(context, main)), 'The voice itself is ring-modulated');
    const [carrier] = modulators(context);
    assert.equal(carrier.type, 'sine'); assert.ok(layerOf(context, carrier).connections.includes(ring.gain));
    const ratio = carrier.frequency.events[0].value / pitch[0].value;
    assert.ok(Math.abs(ratio - Math.round(ratio)) > .03, 'Inharmonic sidebands');
    const [f1] = tractOf(context), formant = f1.frequency.events.map(event => event.value);
    const top = formant.indexOf(Math.max(...formant));
    assert.ok(top > 0 && top < formant.length - 1 && formant[top] > formant[0] * 1.3 && formant[formant.length - 1] < formant[top] * .75, 'Open vowel in the middle');
    assert.equal(context.nodes.find(node => node.kind === 'panner').refDistance, 2.8, 'A moan carries down corridors');
    instance.stop();
  }
});

test('growls flutter at 25–45 Hz through a bounded waveshaper and throat formants; the Warden is deepest', () => {
  const rates = {};
  for (const kind of KINDS) for (const seed of [4, 19]) {
    const { context, instance, output } = fixture({ api: browserAPI(seed) });
    instance.play(kind, 'growl');
    const [flutter] = modulators(context), depth = layerOf(context, flutter);
    assert.equal(flutter.type, 'custom', 'A glottal rattle, not a smooth tremolo');
    const hz = flutter.frequency.events.map(event => event.value);
    assert.ok(hz.every(value => value >= 25 && value <= 45));
    rates[kind] = [...(rates[kind] || []), ...hz];
    const stage = ownerOf(context, depth.connections[0]);
    assert.ok(stage.gain.value - crest(depth) >= .09, 'Flutter never fully gates or inverts the voice');
    const shaper = context.nodes.find(node => node.kind === 'shaper' && !node.connections.includes(output));
    assert.deepEqual(stage.connections, [shaper]);
    const curve = shaper.curve, middle = (curve.length - 1) / 2;
    assert.ok(curve.length % 2 === 1 && curve[middle] === 0, 'Silent at rest');
    assert.ok(curve.every((value, index) => Math.abs(value) <= 1 && (!index || value >= curve[index - 1])));
    assert.ok(Math.abs(curve[0] + curve[curve.length - 1]) > .01, 'Asymmetric, throaty saturation');
    assert.equal(shaper.connections.length, 1);
    assert.deepEqual(shaper.connections[0].connections, tractOf(context), 'Distortion is voiced through the throat');
    const pitch = context.sources.find(source => source.type === 'custom').frequency.events[0].value;
    if (kind === 'warden') assert.ok(pitch < 45 && pitch > 20, 'Very deep rumble');
    else assert.ok(pitch > 50);
    instance.stop();
  }
  assert.ok(Math.max(...rates.warden) < Math.min(...rates.crawler), 'Warden rattles slower than a Crawler chitters');
});

test('laughs are 4–8 staccato bursts on descending pitch steps with breath between', () => {
  const spacing = {};
  for (const kind of KINDS) for (const seed of [6, 15, 27]) {
    const { context, instance } = fixture({ api: browserAPI(seed) });
    instance.play(kind, 'laugh');
    const main = context.sources.find(source => source.type === 'custom');
    const steps = main.frequency.events.filter(event => event.method === 'set').map(event => event.value);
    assert.ok(steps.length >= 4 && steps.length <= 8, `${kind} laughs in ${steps.length} bursts`);
    assert.ok(steps.every((value, index) => !index || value < steps[index - 1]), 'Each burst steps down');
    const onsets = startsAt(layerOf(context, main));
    assert.equal(onsets.length, steps.length);
    spacing[kind] = (onsets[onsets.length - 1] - onsets[0]) / (onsets.length - 1);
    const input = feeding(context, tractOf(context)[0]).find(node => !node.gain.events.length);
    const breath = context.sources.find(source => source.kind === 'buffer' && layerOf(context, source).connections.includes(input));
    const air = layerOf(context, breath).gain.events;
    assert.ok(startsAt(layerOf(context, breath), .2).length >= steps.length, 'Aspirated onsets and breaths');
    for (let index = 1; index < onsets.length; index++) {
      assert.ok(air.some(event => event.time > onsets[index - 1] + .03 && event.time < onsets[index] - .005 && event.value > .2), 'Breath between bursts');
    }
    if (kind === 'stalker' || kind === 'shrieker') assert.ok(steps[0] > KINDS_PITCH[kind] * 1.2, 'High, unsettling giggle');
    if (kind === 'crawler') {
      const click = context.sources.find(source => source.kind === 'buffer' && source !== breath);
      assert.ok(startsAt(layerOf(context, click)).length >= steps.length + 4, 'Clicking titter');
    }
    instance.stop();
  }
  assert.ok(spacing.warden > spacing.shrieker * 1.8, 'A slow, deep chuckle against a rapid giggle');
});
const KINDS_PITCH = { warden: 48, stalker: 94, crawler: 132, shrieker: 285 };

test('screams stack detuned voices and noise, distorted, with formants sweeping up then down', () => {
  for (const kind of KINDS) for (const seed of [9, 31]) {
    const { context, instance, output } = fixture({ api: browserAPI(seed) });
    instance.play(kind, 'scream');
    const voice = instance.snapshot().voices[0], flutter = modulators(context);
    const voiced = context.sources.filter(source => source.type === 'custom' && !flutter.includes(source));
    const first = voiced.map(source => source.frequency.events[0].value), lowest = Math.min(...first);
    assert.ok(voiced.length >= 2 && new Set(first.map(value => value.toFixed(6))).size === voiced.length, 'Detuned layers');
    assert.ok(Math.max(...first) / lowest < 3);
    const shaper = context.nodes.find(node => node.kind === 'shaper' && !node.connections.includes(output));
    assert.ok(context.sources.some(source => source.kind === 'buffer' && source.starts[0].time >= voiced[0].starts[0].time - 1e-9 &&
      layerOf(context, source).connections.some(next => next === shaper || next.connections?.includes(shaper))), 'Noise is driven with the voice');
    const f2 = tractOf(context)[1].frequency.events.map(event => event.value), top = f2.indexOf(Math.max(...f2));
    assert.ok(top > 0 && top < f2.length - 1 && f2[0] < .9 * f2[top] && f2[f2.length - 1] < .9 * f2[top], 'Formants sweep up then down');
    if (kind === 'shrieker') {
      near(first[1] / first[0], 1.067); near(first[2] / first[0], 1.414);
      const gasp = context.sources.find(source => source.kind === 'buffer');
      assert.ok(gasp.starts[0].time === voice.startedAt && voiced[0].starts[0].time >= voice.startedAt + .2, 'A reversed-swell inhale before the shriek');
      assert.ok(peakTime(layerOf(context, gasp)) > .85 * (gasp.stops[0] - gasp.starts[0].time));
    }
    assert.equal(context.nodes.find(node => node.kind === 'panner').refDistance, 3.2);
    instance.stop();
  }
});

test('priority tiers: violence > engagement > ambient voices > steps > breath; ties retire the oldest', () => {
  const names = Object.keys(TIERS);
  for (const held of names) for (const incoming of names) {
    const setup = fixture(), { context, instance } = setup;
    const ids = Array.from({ length: 8 }, (_, index) => instance.play(KINDS[index % 4], held));
    const before = context.nodes.length, id = instance.play('crawler', incoming), live = instance.snapshot().voices.map(voice => voice.id);
    if (TIERS[incoming] < TIERS[held]) {
      assert.equal(id, null, `${incoming} cannot steal ${held}`);
      assert.equal(context.nodes.length, before); assert.deepEqual(live, ids);
    } else {
      assert.equal(typeof id, 'number', `${incoming} may replace ${held}`);
      assert.deepEqual(live, [...ids.slice(1), id], 'The oldest equal-or-lower voice retires');
    }
    instance.stop(); assertReleased(setup);
  }
});

test('a scream is never stolen by whispers; whispers recycle among themselves around it', () => {
  const setup = fixture(), { context, instance } = setup;
  const whispers = Array.from({ length: 7 }, (_, index) => instance.play(KINDS[index % 4], 'whisper'));
  const scream = instance.play('shrieker', 'scream');
  for (let round = 0; round < 12; round++) {
    assert.equal(typeof instance.play('stalker', 'whisper'), 'number');
    const voices = instance.snapshot().voices;
    assert.equal(voices.length, 8); assert.ok(voices.some(voice => voice.id === scream), 'The scream survives');
    context.advanceTo(context.currentTime + .02);
  }
  assert.ok(instance.snapshot().voices.every(voice => !whispers.includes(voice.id)), 'Old whispers were the ones retired');
  for (let index = 0; index < 7; index++) instance.play('warden', 'scream');
  assert.equal(instance.play('stalker', 'whisper'), null, 'A full violent mix drops whispers');
  assert.ok(instance.snapshot().voices.every(voice => voice.cue === 'scream'));
  instance.stop(); assertReleased(setup);
});

test('vocal cues honour occlusion and per-cue distance: whispers stay intimate, screams carry', () => {
  const reference = {};
  for (const cue of [...CUES, ...VOCALS]) {
    const { context, instance } = fixture();
    instance.play('stalker', cue, { occluded: true, volume: .5 });
    const voice = instance.snapshot().voices[0], panner = context.nodes.find(node => node.kind === 'panner');
    const wall = context.nodes.find(node => node.type === 'lowpass');
    near(voice.lowpass, 750); near(wall.frequency.value, 750);
    assert.deepEqual(wall.connections, [panner]);
    assert.equal(feeding(context, wall).length, 1, 'Every layer passes the occlusion master');
    reference[cue] = { ref: panner.refDistance, rolloff: panner.rolloffFactor, gain: voice.gain / (.7 * .5 * .28) };
    instance.stop();
  }
  assert.ok(reference.whisper.ref < reference.breath.ref && reference.whisper.ref < Math.min(...VOCALS.slice(1).map(cue => reference[cue].ref)));
  assert.ok(reference.scream.ref > reference.moan.ref && reference.moan.ref > reference.notice.ref);
  assert.ok(reference.scream.rolloff <= Math.min(...Object.values(reference).map(value => value.rolloff)));
  near(reference.scream.gain, .46); near(reference.whisper.gain, .22);
  assert.ok(reference.scream.gain > reference.attack.gain && reference.whisper.gain < reference.moan.gain &&
    reference.moan.gain < reference.laugh.gain && reference.laugh.gain < reference.growl.gain);
});
