'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const audio = require('../public/audio');
const script = readFileSync(require.resolve('../public/audio'), 'utf8');
const KINDS = ['warden', 'stalker', 'crawler', 'shrieker'];
const CUES = ['breath', 'notice', 'attack', 'death', 'step'];

class FakeParam {
  constructor(value) { this.value = value; this.events = []; }
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
    if (kind === 'buffer') this.playbackRate = new FakeParam(1);
    else { this.frequency = new FakeParam(440); this.type = 'sine'; }
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
  createGain() { const node = new FakeNode(this, 'gain'); node.gain = new FakeParam(1); return node; }
  createBiquadFilter() {
    const node = new FakeNode(this, 'filter');
    node.type = 'lowpass'; node.frequency = new FakeParam(350); node.Q = new FakeParam(1);
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
    else for (const key of ['positionX', 'positionY', 'positionZ']) node[key] = new FakeParam(0);
    return node;
  }
  createDynamicsCompressor() {
    const node = new FakeNode(this, 'compressor');
    for (const [key, value] of Object.entries({ threshold: -24, knee: 30, ratio: 12, attack: .003, release: .25 })) {
      node[key] = new FakeParam(value);
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

function fixture({ api = audio, duration = 2, ...options } = {}) {
  const context = new FakeContext(options), output = context.createGain();
  output.gain.value = .63; output.connect(context.destination);
  const data = new Float32Array(Math.max(1, Math.floor(duration * context.sampleRate)));
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
  assert.deepEqual(Object.keys(audio), ['create']);
  assert.ok(Object.isFrozen(audio));
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
