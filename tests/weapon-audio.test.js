'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const weaponAudio = require('../public/weapon-audio');
const script = readFileSync(require.resolve('../public/weapon-audio'), 'utf8');
const GUNS = ['rifle', 'pistol', 'shotgun'], SURFACES = ['flesh', 'metal', 'concrete', 'wood'];
const FLOORS = ['concrete', 'tile', 'metal', 'wood', 'carpet', 'grass'];
const METHODS = ['shot', 'remoteShot', 'dry', 'reload', 'cancelReload', 'equip', 'hitMarker', 'impact', 'casing', 'stop', 'snapshot'];
// systems.js WEAPONS: reload seconds and magazine sizes.
const RELOAD = { rifle: 2.15, pistol: 1.45, shotgun: 2.85 }, CAPACITY = { rifle: 30, pistol: 12, shotgun: 6 };
const FPS = 60, DT = 1 / FPS, FADE = .02;

// Fakes follow tests/player-audio.test.js, extended with convolvers, delays, buffers, panners and the listener.
// Failed expectations are also recorded, because the module deliberately swallows graph errors.
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
    if (method === 'exponential') check(context, value > 0 && (last ? last.value : this.value) > 0, 'Exponential ramps never touch zero');
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
    if (kind === 'buffer') { this.playbackRate = new FakeParam(this, 1); this.loop = false; this.buffer = null; }
    else { this.frequency = new FakeParam(this, 440); this.detune = new FakeParam(this, 0); this.type = 'sine'; }
  }
  start(time, offset = 0) {
    const context = this.context;
    check(context, this.starts.length === 0, 'Each source starts exactly once');
    check(context, Number.isFinite(time) && time >= context.currentTime, 'Starts are finite and not in the past');
    if (this.kind === 'buffer') check(context, this.buffer && offset >= 0 && offset < this.buffer.duration, 'Offset inside the buffer');
    this.starts.push({ time, offset });
    context.pending.add(this);
  }
  stop(time) {
    check(this.context, this.starts.length === 1, 'Only started sources can be stopped');
    check(this.context, Number.isFinite(time) && time >= 0, 'Every stop has a finite time');
    check(this.context, !this.stops.length || time <= this.stops[this.stops.length - 1], 'A stop is only ever brought forward');
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
    this.nodes = []; this.buffers = []; this.errors = []; this.pending = new Set();
    this.destination = new FakeNode(this, 'destination');
    if (legacy) this.listener = { setPosition() {}, setOrientation() {} };
    else {
      this.listener = {};
      for (const [key, value] of Object.entries({ positionX: 0, positionY: 1.6, positionZ: 0, forwardX: 0, forwardY: 0,
        forwardZ: -1, upX: 0, upY: 1, upZ: 0 })) this.listener[key] = new FakeParam({ context: this }, value);
      this.createStereoPanner = () => { const node = new FakeNode(this, 'stereo'); node.pan = new FakeParam(node, 0); return node; };
    }
  }
  createGain() { const node = new FakeNode(this, 'gain'); node.gain = new FakeParam(node, 1); return node; }
  createBiquadFilter() {
    const node = new FakeNode(this, 'filter');
    node.type = 'lowpass'; node.frequency = new FakeParam(node, 350); node.Q = new FakeParam(node, 1); node.gain = new FakeParam(node, 0);
    return node;
  }
  createBufferSource() { return new FakeSource(this, 'buffer'); }
  createOscillator() { return new FakeSource(this, 'oscillator'); }
  createWaveShaper() { const node = new FakeNode(this, 'shaper'); node.curve = null; node.oversample = 'none'; return node; }
  createDynamicsCompressor() {
    const node = new FakeNode(this, 'compressor');
    for (const [key, value] of Object.entries({ threshold: -24, knee: 30, ratio: 12, attack: .003, release: .25 })) {
      node[key] = new FakeParam(node, value);
    }
    return node;
  }
  createPanner() {
    const node = new FakeNode(this, 'panner');
    Object.assign(node, { panningModel: 'equalpower', distanceModel: 'inverse', refDistance: 1, rolloffFactor: 1, maxDistance: 10000 });
    if (this.legacy) node.setPosition = (x, y, z) => { node.position = [x, y, z]; };
    else for (const key of ['positionX', 'positionY', 'positionZ']) node[key] = new FakeParam(node, 0);
    return node;
  }
  createConvolver() {
    const node = new FakeNode(this, 'convolver'), context = this;
    let buffer = null;
    node.normalize = true;
    Object.defineProperty(node, 'buffer', { get: () => buffer, set(value) {
      check(context, value && [1, 2, 4].includes(value.numberOfChannels) && value.sampleRate === context.sampleRate,
        'The impulse matches the context');
      node.normalizedOnSet = node.normalize;
      buffer = value;
    } });
    return node;
  }
  createDelay(max = 1) {
    check(this, max > 0 && max < 180, 'Delay range');
    const node = new FakeNode(this, 'delay');
    node.maxDelayTime = max; node.delayTime = new FakeParam(node, 0);
    return node;
  }
  createBuffer(channels, length, rate) {
    check(this, Number.isInteger(channels) && channels >= 1 && channels <= 32 && Number.isInteger(length) && length >= 1 &&
      rate >= 3000 && rate <= 768000, 'Valid buffer');
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    const buffer = { numberOfChannels: channels, length, sampleRate: rate, duration: length / rate, getChannelData: channel => data[channel] };
    this.buffers.push(buffer);
    return buffer;
  }
  resume() { assert.fail('The caller owns context activation'); }
  suspend() { assert.fail('The caller owns context activation'); }
  close() { assert.fail('The caller owns context lifetime'); }
  get sources() { return this.nodes.filter(node => node instanceof FakeSource); }
  advanceTo(time, dispatch = true) {
    assert.ok(time >= this.currentTime);
    this.currentTime = time;
    if (dispatch) for (const source of Array.from(this.pending)) if (source.endTime <= time) source.finish();
  }
  advance(seconds) { this.advanceTo(this.currentTime + seconds); }
}

function seeded(seed = 1) {
  let state = seed;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) | 0; return (state >>> 0) / 4294967296; };
}
// White noise like game.js's shared buffer, so the renderer below can measure real levels.
function noise(context, duration) {
  const data = new Float32Array(Math.max(1, Math.round(duration * context.sampleRate)));
  let state = 12345;
  for (let index = 0; index < data.length; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) | 0;
    data[index] = (state >>> 0) / 2147483648 - 1;
  }
  return Object.freeze({ duration: data.length / context.sampleRate, sampleRate: context.sampleRate, numberOfChannels: 1,
    length: data.length, getChannelData: () => data });
}
const checksum = buffer => buffer.getChannelData(0).reduce((sum, value, index) => sum + value * (index % 7 + 1), 0);
function fixture({ api = weaponAudio, duration = 2, seed = 7, random, ...options } = {}) {
  const context = new FakeContext(options), output = context.createGain();
  output.gain.value = .7; output.connect(context.destination);
  const noiseBuffer = noise(context, duration);
  const instance = api.create({ context, output, noiseBuffer, random: random || seeded(seed) });
  const setup = { context, output, noiseBuffer, instance,
    owned: () => context.nodes.filter(node => node !== output && node !== context.destination) };
  // One API call: its id, its snapshot entry and the voice nodes it allocated (the shared bus excluded).
  setup.play = call => {
    const before = context.nodes.length, id = call(instance), bus = busOf(context);
    const nodes = context.nodes.slice(before).filter(node => !bus || !bus.nodes.has(node));
    const voice = typeof id === 'number' ? instance.snapshot().voices.find(entry => entry.id === id) : null;
    return { id, voice, bus, nodes, out: nodes[0], sources: nodes.filter(node => node instanceof FakeSource) };
  };
  return setup;
}
// The shared bus, found by its wiring: mix -> compressor -> post -> ceiling -> output; verb -> low cut -> convolver -> wet -> mix;
// low cut -> slapback delay -> lowpass -> echo -> mix.
function busOf(context) {
  const latest = kind => context.nodes.filter(node => node.kind === kind).at(-1);
  const compressor = latest('compressor'), room = latest('convolver'), slap = latest('delay');
  if (!compressor || !compressor.connections.length) return null;
  const feeding = target => context.nodes.filter(node => node.connections.includes(target));
  const mix = feeding(compressor)[0], post = compressor.connections[0], ceiling = post.connections[0];
  const lowCut = feeding(room)[0], verb = feeding(lowCut)[0], wet = room.connections[0];
  const dull = slap.connections[0], echo = dull.connections[0];
  const parts = { mix, compressor, post, ceiling, verb, lowCut, room, wet, slap, dull, echo };
  return { ...parts, nodes: new Set(Object.values(parts)) };
}
const live = context => context.nodes.filter(node => node.connections.length);
const params = node => ['gain', 'frequency', 'Q', 'detune', 'playbackRate', 'pan', 'positionX', 'positionY', 'positionZ', 'delayTime']
  .map(key => node[key]).filter(param => param instanceof FakeParam);
const strikes = node => node.gain.events.filter(event => event.method === 'linear' && event.value > 0);
const peak = node => Math.max(...node.gain.events.map(event => event.value));
const decayOf = node => node.gain.events.find(event => event.method === 'exponential').time - node.gain.events[0].time;
function near(actual, expected, epsilon = 1e-9) { assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`); }

// Every voice: sources started and stopped once inside the voice, true-zero strike envelopes, in-range frequencies,
// nothing scheduled past its end, and no swallowed graph errors.
function inspect(setup, played, { length = Infinity, nodes = Infinity } = {}) {
  const { context, noiseBuffer } = setup, { voice } = played;
  assert.equal(typeof played.id, 'number');
  assert.ok(voice, 'Listed in the snapshot');
  assert.ok(voice.start >= context.currentTime && voice.end > voice.start);
  assert.ok(voice.end - voice.start <= length, `${voice.kind} lasts ${(voice.end - voice.start).toFixed(3)} s`);
  assert.ok(played.nodes.length <= nodes, `${voice.kind} allocates ${played.nodes.length} nodes`);
  assert.ok(played.sources.length >= 1);
  for (const source of played.sources) {
    assert.equal(source.starts.length, 1);
    assert.equal(source.stops.length, 1);
    const [{ time, offset }] = source.starts, stop = source.stops[0];
    assert.ok(time >= voice.start - 1e-9 && stop > time && stop <= voice.end + 1e-9);
    assert.equal(typeof source.onended, 'function');
    if (source.kind === 'buffer') {
      assert.equal(source.buffer, noiseBuffer, 'Reuses the supplied noise');
      if (!source.loop) assert.ok(offset + (stop - time) * source.playbackRate.value <= noiseBuffer.duration + 1e-9);
    } else assert.ok(['sine', 'triangle'].includes(source.type));
  }
  for (const node of played.nodes) {
    for (const param of params(node)) assert.ok(param.events.every(event => event.time <= voice.end + 1e-9), 'Nothing past the end');
    if (node.frequency) {
      for (const value of [node.frequency.value, ...node.frequency.events.map(event => event.value)]) {
        assert.ok(value > 0 && value < context.sampleRate / 2, `${node.kind} at ${value} Hz`);
      }
    }
    if (node.kind === 'gain' && node.gain.events.length) {
      const events = node.gain.events;
      assert.equal(events[0].value, 0, 'Strikes start silent');
      assert.equal(events.at(-1).value, 0, 'and end at true zero');
      assert.ok(events.every(event => event.value >= 0 && event.value <= 3.5));
    }
    if (node.kind === 'shaper') {
      assert.ok(node.curve instanceof Float32Array && node.curve.every(value => Number.isFinite(value) && Math.abs(value) <= 1));
    }
  }
  assert.deepEqual(context.errors, []);
}
// Let a voice play out: every node it allocated is disconnected and forgotten.
function finish(setup, played) {
  setup.context.advanceTo(Math.max(setup.context.currentTime, played.voice.end) + .01);
  assert.ok(played.nodes.every(node => node.connections.length === 0), `${played.voice.kind} releases its graph`);
  assert.ok(played.sources.every(source => source.onended === null && source.ended));
  assert.ok(!setup.instance.snapshot().voices.some(voice => voice.id === played.id));
}
function assertReleased(setup) {
  const { context, instance, output, owned } = setup, state = instance.snapshot();
  assert.equal(state.activeVoices, 0);
  assert.equal(state.reloading, false);
  assert.deepEqual(context.errors, [], 'No invalid graph operations were swallowed');
  assert.ok(owned().every(node => node.connections.length === 0), 'All owned graph edges are disconnected');
  assert.ok(context.sources.every(source => source.onended === null), 'No retained ended callbacks');
  assert.ok(context.sources.every(source => source.stops.length > 0), 'Every source was given a finite stop');
  assert.equal(context.pending.size, 0, 'Every source has ended');
  assert.equal(output.gain.value, .7, 'The supplied master volume is untouched');
  assert.equal(output.gain.events.length, 0);
  assert.equal(output.disconnects, 0);
  assert.deepEqual(output.connections, [context.destination]);
}
function settle(setup, seconds = 2) {
  setup.instance.stop();
  setup.context.advance(seconds);
  assertReleased(setup);
}
// A shot's layers, found by their wiring.
function layersOf(played) {
  const { nodes, out } = played, find = match => nodes.find(match);
  const shaper = find(node => node.kind === 'shaper'), shelf = find(node => node.type === 'highshelf');
  const body = find(node => node.type === 'bandpass' && node.connections[0] && node.connections[0].connections[0] === shaper);
  const mech = find(node => node.type === 'bandpass' && node.connections[0] && node.connections[0].connections[0] === out);
  const kick = find(node => node.kind === 'oscillator' && node.type === 'sine');
  const ping = find(node => node.kind === 'oscillator' && node.type === 'triangle');
  return { shaper, shelf, crack: shelf.connections[0], body, bodyGain: body.connections[0], kick, thump: kick.connections[0],
    mech, clack: mech && mech.connections[0], ping, ring: ping && ping.connections[0] };
}
const sendOf = played => played.out.connections.find(node => node.connections.includes(played.bus.verb));

test('CommonJS, browser global and AMD load without audio hardware, DOM or timers', () => {
  assert.deepEqual(Object.keys(weaponAudio), ['create', 'PRIORITIES', 'MAX_VOICES', 'WEAPON_IDS', 'IMPACT_SURFACES', 'CASING_SURFACES']);
  assert.ok(Object.isFrozen(weaponAudio) && Object.isFrozen(weaponAudio.PRIORITIES));
  assert.deepEqual(weaponAudio.WEAPON_IDS, GUNS);
  assert.deepEqual(weaponAudio.IMPACT_SURFACES, SURFACES);
  assert.deepEqual(weaponAudio.CASING_SURFACES, FLOORS);
  assert.equal(weaponAudio.MAX_VOICES, 16);
  const tier = weaponAudio.PRIORITIES;
  assert.ok(Object.entries(tier).every(([kind, value]) => kind === 'hitMarker' || value < tier.hitMarker), 'The hit marker outranks all');
  assert.ok(tier.shot > tier.reload && tier.reload > tier.remoteShot && tier.remoteShot > tier.impact && tier.impact > tier.casing);
  const sandbox = {};
  vm.runInNewContext(script, sandbox, { filename: 'weapon-audio.js' });
  assert.equal(typeof sandbox.HollowWeaponAudio.create, 'function');
  const setup = fixture({ api: sandbox.HollowWeaponAudio });
  assert.equal(setup.owned().length, 0, 'Creation is silent and lazy');
  assert.ok(Object.isFrozen(setup.instance));
  assert.deepEqual(Object.keys(setup.instance), METHODS);
  assert.equal(typeof setup.instance.shot('rifle'), 'number');
  settle(setup);
  let amd;
  const define = (dependencies, factory) => { assert.equal(dependencies.length, 0); amd = factory(); };
  define.amd = {};
  const amdSandbox = { define };
  vm.runInNewContext(script, amdSandbox);
  assert.equal(typeof amd.create, 'function');
  assert.equal(amdSandbox.HollowWeaponAudio, undefined);
});

test('dependencies are validated without touching the supplied output or noise', () => {
  assert.throws(() => weaponAudio.create(), /AudioContext/);
  const setup = fixture(), { context, output, noiseBuffer, instance } = setup;
  const dependencies = { context, output, noiseBuffer };
  for (const patch of [{ context: {} }, { context: null }, { output: null }, { output: { connect() {} } }, { output: { gain: {} } },
    { noiseBuffer: null }, { noiseBuffer: { duration: 0 } }, { noiseBuffer: { duration: NaN } }, { output: fixture().output },
    { random: 4 }, { random: 'seeded' }]) {
    assert.throws(() => weaponAudio.create({ ...dependencies, ...patch }), TypeError);
  }
  const bare = new FakeContext();
  bare.createConvolver = undefined;
  assert.throws(() => weaponAudio.create({ context: bare, output: bare.createGain(), noiseBuffer }), TypeError, 'Needs a convolver');
  assert.equal(setup.owned().length, 0);
  const sum = checksum(noiseBuffer);
  for (const id of GUNS) { instance.shot(id, { ammo: 1, capacity: 6 }); instance.reload(id, 1); }
  assert.equal(checksum(noiseBuffer), sum, 'The shared noise is only read');
  const snapshot = instance.snapshot();
  assert.deepEqual(Object.keys(snapshot), ['activeVoices', 'maxVoices', 'reloading', 'voices']);
  assert.equal(snapshot.maxVoices, 16);
  assert.equal(snapshot.reloading, true);
  assert.deepEqual(Object.keys(snapshot.voices[0]), ['id', 'kind', 'priority', 'start', 'end']);
  assert.ok(snapshot.voices.every(voice => Number.isFinite(voice.start) && voice.end > voice.start));
  assert.doesNotThrow(() => JSON.stringify(snapshot));
  settle(setup);
});

test('one shared bus, built lazily once: corridor convolver, slapback, glue compressor and a limiter before the output', () => {
  const setup = fixture(), { context, instance, output } = setup;
  for (let index = 0; index < 12; index++) {
    instance.shot(GUNS[index % 3], { ammo: 9, capacity: 30 });
    instance.impact(SURFACES[index % 4], { x: index, y: 1, z: -6 });
    context.advance(.1);
  }
  assert.equal(context.nodes.filter(node => node.kind === 'compressor').length, 1);
  assert.equal(context.nodes.filter(node => node.kind === 'convolver').length, 1);
  assert.equal(context.buffers.length, 1, 'The corridor impulse is generated once');
  const bus = busOf(context);
  assert.deepEqual(bus.mix.connections, [bus.compressor]);
  assert.deepEqual(bus.compressor.connections, [bus.post]);
  assert.deepEqual(bus.post.connections, [bus.ceiling]);
  assert.deepEqual(bus.ceiling.connections, [output]);
  assert.deepEqual(context.nodes.filter(node => node.connections.includes(output)), [bus.ceiling], 'Only the limiter feeds the master');
  const { threshold, knee, ratio, attack, release } = bus.compressor;
  assert.ok(threshold.value <= -6 && threshold.value >= -24 && ratio.value >= 2 && ratio.value <= 8 && knee.value <= 12);
  assert.ok(attack.value <= .005 && release.value >= .05 && release.value <= .3, 'Fast glue that still lets transients punch');
  // The ceiling: unity gain near silence (it is fed at the post gain), a soft knee, never past ±.95.
  const ceiling = bus.ceiling.curve, middle = (ceiling.length - 1) / 2, step = 2 / (ceiling.length - 1);
  assert.ok(ceiling.every(value => Math.abs(value) <= .95 + 1e-6));
  for (let index = 1; index < ceiling.length; index++) assert.ok(ceiling[index] > ceiling[index - 1], 'Monotonic');
  near(bus.post.gain.value * (ceiling[middle + 1] - ceiling[middle - 1]) / (2 * step), 1, .01);
  // The corridor: a highpassed send into an unnormalised ~1.45 s stereo impulse, plus a dark slapback.
  assert.equal(bus.lowCut.type, 'highpass');
  assert.ok(bus.lowCut.frequency.value >= 100 && bus.lowCut.frequency.value <= 300);
  assert.ok(bus.lowCut.connections.includes(bus.room) && bus.lowCut.connections.includes(bus.slap));
  assert.equal(bus.room.normalizedOnSet, false, 'normalize is cleared before the impulse is assigned');
  assert.deepEqual(bus.wet.connections, [bus.mix]);
  assert.deepEqual(bus.echo.connections, [bus.mix]);
  const slap = bus.slap.delayTime.value;
  assert.ok(slap >= .06 && slap <= .14 && slap <= bus.slap.maxDelayTime);
  assert.equal(bus.dull.type, 'lowpass');
  assert.ok(bus.echo.gain.value > 0 && bus.echo.gain.value < .5);
  const impulse = bus.room.buffer, rate = impulse.sampleRate;
  assert.equal(impulse.numberOfChannels, 2);
  assert.ok(impulse.duration >= 1.2 && impulse.duration <= 1.6, `impulse ${impulse.duration} s`);
  const energy = (data, from, to) => {
    let sum = 0;
    for (let index = Math.round(from * rate); index < Math.min(data.length, Math.round(to * rate)); index++) sum += data[index] ** 2;
    return sum;
  };
  const [left, right] = [0, 1].map(channel => impulse.getChannelData(channel));
  for (const data of [left, right]) {
    assert.ok(data.every(Number.isFinite));
    near(energy(data, 0, impulse.duration), 1, 1e-3);
    assert.ok(energy(data, 0, .1) > 1e4 * energy(data, impulse.duration - .1, impulse.duration), 'Decays by more than 40 dB');
    let early = 0;
    for (const value of data.subarray(0, Math.round(.09 * rate))) early = Math.max(early, Math.abs(value));
    assert.ok(early > 6 * Math.sqrt(energy(data, .1, .2) / (.1 * rate)), 'Sparse early reflections stand out');
  }
  let correlation = 0;
  for (let index = 0; index < left.length; index++) correlation += left[index] * right[index];
  assert.ok(Math.abs(correlation) < .5, 'Decorrelated ears widen the corridor');
  // The room never depends on, or consumes, the injected random source.
  const other = fixture({ seed: 99 });
  other.instance.dry('pistol');
  assert.deepEqual(busOf(other.context).room.buffer.getChannelData(1), right);
  settle(other);
  settle(setup);
});

for (const id of GUNS) {
  test(`${id}: crack, saturated body and thump, mechanical clack, and a send into the corridor tail`, () => {
    const setup = fixture();
    const played = setup.play(api => api.shot(id, { ammo: CAPACITY[id], capacity: CAPACITY[id] }));
    inspect(setup, played, { length: id === 'shotgun' ? .7 : .3, nodes: 12 });
    const { voice, out, bus } = played, layer = layersOf(played);
    assert.equal(voice.kind, 'shot');
    assert.equal(voice.priority, weaponAudio.PRIORITIES.shot);
    // 1. Crack: 2–6 ms of noise with a high-shelf bite, into the saturator.
    assert.ok(layer.shelf.gain.value >= 6 && layer.shelf.frequency.value >= 2000, 'High-shelf bite');
    const crack = decayOf(layer.crack);
    assert.ok(crack >= .002 && crack <= .0065, `crack lasts ${crack}`);
    assert.deepEqual(layer.crack.connections, [layer.shaper]);
    // 2. Body: band-passed noise sweeping down; thump: a sine dropping in pitch. Saturated together.
    const sweep = layer.body.frequency.events;
    assert.ok(sweep[0].value > 2 * sweep.at(-1).value, 'The blast darkens as it decays');
    assert.deepEqual(layer.bodyGain.connections, [layer.shaper]);
    const glide = layer.kick.frequency.events, sub = glide[1].value;
    assert.equal(glide[1].method, 'exponential');
    assert.ok(glide[0].value > 2.4 * sub, 'The thump drops in pitch');
    if (id === 'pistol') assert.ok(sub > 80, 'The pistol thump stays snappier');
    else assert.ok(sub >= 50 && sub <= 80, `${id} sub at ${sub} Hz`);
    assert.deepEqual(layer.thump.connections, [layer.shaper]);
    const curve = layer.shaper.curve, last = curve.length - 1;
    near(curve[0], -1, 1e-6); near(curve[last], 1, 1e-6); near(curve[last / 2], 0, 1e-6);
    assert.ok(curve[Math.round(last * .75)] > .6, 'Driven: denser than linear');
    assert.notEqual(layer.shaper.oversample, 'none');
    assert.deepEqual(layer.shaper.connections, [out]);
    // 3. The action: a clack 15–40 ms after the blast, unsaturated.
    const clack = layer.clack.gain.events.find(event => event.method === 'set').time - voice.start;
    assert.ok(clack >= .015 - 1e-9 && clack <= .04, `clack at ${clack}`);
    assert.deepEqual(layer.clack.connections, [out]);
    // 4. Tail: the voice stays short; its send feeds the shared corridor.
    assert.ok(out.connections.includes(bus.mix));
    const send = sendOf(played);
    assert.deepEqual(send.connections, [bus.verb]);
    assert.ok(send.gain.value > .2 && send.gain.value < 1);
    assert.equal(layer.ping, undefined, 'No low-ammo ping on a full magazine');
    finish(setup, played);
    settle(setup);
  });
}

test('every shot varies: pitch ±4%, filter colour, and level ±1.5 dB', () => {
  const setup = fixture({ seed: 13 }), levels = [], pitches = [], colours = [];
  for (let index = 0; index < 24; index++) {
    const played = setup.play(api => api.shot('rifle', { ammo: 30, capacity: 30 })), layer = layersOf(played);
    levels.push(played.out.gain.value); pitches.push(layer.kick.frequency.events[0].value); colours.push(layer.shelf.frequency.value);
    setup.context.advance(.2);
  }
  const spread = values => Math.max(...values) / Math.min(...values);
  assert.ok(spread(levels) > 1.08 && spread(levels) <= Math.pow(10, 3 / 20) + 1e-9, `level spread ${spread(levels)}`);
  assert.ok(spread(pitches) > 1.03 && spread(pitches) <= 1.04 / .96 + 1e-9, `pitch spread ${spread(pitches)}`);
  assert.ok(spread(colours) > 1.03 && spread(colours) <= 1.05 / .95 + 1e-9, `colour spread ${spread(colours)}`);
  assert.equal(new Set(levels).size, levels.length);
  settle(setup);
});

test('aiming focuses the shot; effects off is tamer; outdoors drops the corridor tail and half-indoors halves it', () => {
  const shoot = options => {
    const setup = fixture({ seed: 4 }), played = setup.play(api => api.shot('rifle', { ammo: 30, capacity: 30, ...options }));
    inspect(setup, played, { nodes: 12 });
    return { setup, played, layer: layersOf(played), send: sendOf(played) };
  };
  const hip = shoot({}), aim = shoot({ aiming: true }), tame = shoot({ effects: false }), outside = shoot({ indoor: 0 });
  const half = shoot({ indoor: .5 });
  assert.ok(aim.layer.body.Q.value > hip.layer.body.Q.value, 'A tighter, more focused body');
  assert.ok(decayOf(aim.layer.bodyGain) < decayOf(hip.layer.bodyGain));
  assert.ok(peak(aim.layer.thump) >= 1.15 * peak(hip.layer.thump), 'More low end');
  assert.ok(aim.send.gain.value < hip.send.gain.value, 'Less room');
  assert.ok(tame.layer.shelf.gain.value < hip.layer.shelf.gain.value && peak(tame.layer.crack) < peak(hip.layer.crack));
  const drive = curve => curve[Math.round((curve.length - 1) * .75)];
  assert.ok(drive(tame.layer.shaper.curve) < drive(hip.layer.shaper.curve), 'Gentler saturation');
  assert.ok(tame.played.out.gain.value < hip.played.out.gain.value);
  assert.equal(outside.send, undefined, 'Outdoors there is no corridor tail');
  assert.deepEqual(outside.played.out.connections, [outside.played.bus.mix]);
  assert.equal(outside.played.nodes.length, 11);
  near(half.send.gain.value, hip.send.gain.value / 2);
  for (const result of [hip, aim, tame, outside, half]) settle(result.setup);
});

test('low ammo adds a rising mechanical ping; the last round rings twice and higher', () => {
  for (const id of GUNS) {
    const capacity = CAPACITY[id];
    const fire = ammo => {
      const setup = fixture({ seed: 8 }), played = setup.play(api => api.shot(id, { ammo, capacity })), layer = layersOf(played);
      inspect(setup, played, { length: id === 'shotgun' ? .7 : .3, nodes: 14 });
      const result = { ping: layer.ping, frequency: layer.ping && layer.ping.frequency.events[0].value,
        top: layer.ping && Math.max(...layer.ping.frequency.events.map(event => event.value)), rings: layer.ring && strikes(layer.ring).length };
      settle(setup);
      return result;
    };
    const quarter = Math.floor(capacity / 4);
    const above = fire(quarter + 1), edge = fire(quarter), one = fire(1), last = fire(0);
    assert.equal(above.ping, undefined, `${id}: silent above a quarter magazine`);
    assert.ok(edge.ping && one.ping && last.ping, `${id}: pings from a quarter magazine down`);
    assert.ok(edge.frequency <= one.frequency && one.frequency < last.frequency, `${id}: the ping rises as the magazine empties`);
    assert.equal(one.rings, 1);
    assert.equal(last.rings, 2, 'The last round rings twice');
    assert.ok(last.top > 1.3 * last.frequency, 'and steps up');
    assert.equal(fire(undefined).ping, undefined, 'No ammo count, no ping');
  }
});

test('the shotgun racks its pump about a third of a second after the blast, inside the same voice', () => {
  const setup = fixture(), played = setup.play(api => api.shot('shotgun', { ammo: 4, capacity: 6 }));
  inspect(setup, played, { length: .7, nodes: 12 });
  const { voice } = played, layer = layersOf(played);
  const clacks = layer.clack.gain.events.filter(event => event.method === 'set').map(event => event.time - voice.start);
  assert.ok(clacks.some(time => time >= .3 && time <= .4), 'Pump back');
  assert.ok(clacks.some(time => time > .4 && time <= .55), 'and home');
  const thunks = layer.kick.frequency.events.filter(event => event.method === 'set' && event.time > voice.start + .3);
  assert.equal(thunks.length, 2, 'The thump oscillator gives the pump its weight');
  assert.equal(strikes(layer.thump).length, 3);
  // Heavier than the rifle: a longer blast and boom, and more of the room.
  const rifle = fixture(), rifleShot = rifle.play(api => api.shot('rifle', { ammo: 30, capacity: 30 })), rifleLayer = layersOf(rifleShot);
  assert.ok(decayOf(layer.bodyGain) > 1.5 * decayOf(rifleLayer.bodyGain));
  assert.ok(decayOf(layer.thump) > 1.5 * decayOf(rifleLayer.thump));
  assert.ok(sendOf(played).gain.value > sendOf(rifleShot).gain.value);
  settle(setup);
  settle(rifle);
});

test('remote shots are HRTF-panned, darker with distance and walls, and lean on the corridor tail', () => {
  const setup = fixture({ random: () => .5 }), { context } = setup;
  const remote = (place, target = setup, id = 'rifle') => {
    const played = target.play(api => api.remoteShot(id, place));
    const panner = played.nodes.find(node => node.kind === 'panner'), wall = played.nodes.find(node => node.type === 'lowpass');
    return { played, panner, wall, cutoff: wall.frequency.value, send: wall.connections.find(node => node !== panner) };
  };
  const close = remote({ x: 3, y: 1.6, z: -4 }), { played, panner, wall } = close, bus = played.bus;
  inspect(setup, played, { length: .3, nodes: 12 });
  assert.equal(played.voice.kind, 'remoteShot');
  assert.equal(panner.panningModel, 'HRTF');
  assert.equal(panner.distanceModel, 'exponential');
  for (const [axis, value] of [['positionX', 3], ['positionY', 1.6], ['positionZ', -4]]) {
    assert.deepEqual(panner[axis].events, [{ method: 'set', value, time: context.currentTime }], 'Placed before it sounds');
  }
  assert.deepEqual(played.out.connections, [wall]);
  assert.deepEqual(panner.connections, [bus.mix]);
  assert.deepEqual(close.send.connections, [bus.verb]);
  assert.equal(played.sources.length, 2, "No bolt clack or ammo ping from someone else's gun");
  const far = remote({ x: 0, y: 1.6, z: -40 }), walled = remote({ x: 3, y: 1.6, z: -4, occluded: true });
  const half = remote({ x: 3, y: 1.6, z: -4, occluded: .5 }), told = remote({ x: 3, y: 1.6, z: -4, distance: 40 });
  assert.ok(far.cutoff < .5 * close.cutoff, 'Air eats the highs');
  assert.ok(walled.cutoff < .15 * close.cutoff, 'A wall leaves only the boom');
  assert.ok(walled.played.out.gain.value < .7 * close.played.out.gain.value);
  assert.ok(half.cutoff < close.cutoff && half.cutoff > walled.cutoff);
  near(told.cutoff, far.cutoff, 1e-6);
  // Against the panner's own distance gain, a far shot arrives mostly as corridor.
  const direct = distance => Math.pow(Math.max(distance, panner.refDistance) / panner.refDistance, -panner.rolloffFactor);
  assert.ok(far.send.gain.value / close.send.gain.value > 3 * direct(40) / direct(5));
  assert.ok(walled.send.gain.value > close.send.gain.value);
  // Legacy panners take setPosition; without a listener position the module assumes a mid-corridor 8 m.
  const legacy = fixture({ legacy: true, random: () => .5 }), old = remote({ x: -2, y: 1.5, z: 6 }, legacy, 'pistol');
  inspect(legacy, old.played, { length: .3, nodes: 12 });
  assert.deepEqual(old.panner.position, [-2, 1.5, 6]);
  near(old.cutoff, remote({ x: 0, y: 1.6, z: -8 }, setup, 'pistol').cutoff, 1e-6);
  settle(legacy);
  settle(setup);
});

test('impacts: four surfaces with their own character, spatial, occludable, and thinned for shotgun pellets', () => {
  const setup = fixture({ random: () => .5 }), { context, instance } = setup, place = { x: 2, y: 1.2, z: -3 };
  for (const surface of SURFACES) {
    const played = setup.play(api => api.impact(surface, place));
    inspect(setup, played, { length: .8, nodes: 16 });
    assert.equal(played.voice.kind, 'impact');
    const panner = played.nodes.find(node => node.kind === 'panner'), wall = played.nodes.find(node => node.type === 'lowpass');
    assert.deepEqual([panner.positionX, panner.positionY, panner.positionZ].map(param => param.events[0].value), [2, 1.2, -3]);
    assert.deepEqual(played.out.connections, [wall]);
    assert.ok(wall.connections.includes(panner) && panner.connections[0] === played.bus.mix);
    assert.ok(wall.connections.some(node => node.connections.includes(played.bus.verb)), 'A little of the corridor');
    if (surface === 'flesh') {
      const sweep = played.nodes.find(node => node.type === 'bandpass' && node.Q.value < 2).frequency.events;
      assert.ok(sweep[0].value > 2 * sweep.at(-1).value, 'A wet slap sweeping down');
      assert.ok(played.sources.some(source => source.type === 'sine' && source.frequency.events[0].value < 200), 'and a body thump');
    } else if (surface === 'metal') {
      const ping = played.sources.find(source => source.type === 'triangle');
      assert.ok(ping.frequency.events[0].value > 2500 && ping.stops[0] - ping.starts[0].time > .1, 'A ringing ricochet ping');
    } else if (surface === 'concrete') {
      assert.ok(strikes(played.nodes.find(node => node.type === 'highpass').connections[0]).length >= 5, 'Chips, then trickling grit');
    } else {
      const knock = played.nodes.find(node => node.type === 'bandpass');
      assert.ok(knock.frequency.value > 450 && knock.frequency.value < 700 && knock.Q.value >= 2, 'A resonant, hollow knock');
      assert.ok(played.sources.some(source => source.type === 'triangle' && source.frequency.events[0].value < 300));
    }
    context.advance(.05);
  }
  const cutoff = played => played.nodes.find(node => node.type === 'lowpass').frequency.value;
  const open = setup.play(api => api.impact('concrete', place));
  context.advance(.05);
  const walled = setup.play(api => api.impact('concrete', { ...place, occluded: true }));
  assert.ok(cutoff(walled) < .15 * cutoff(open) && walled.out.gain.value < .6 * open.out.gain.value, 'Muffled behind a wall');
  // Eight pellets in one frame: at most four impacts, two per surface, each a little quieter.
  context.advance(.1);
  const pellets = ['flesh', 'flesh', 'concrete', 'concrete', 'flesh', 'concrete', 'metal', 'wood']
    .map(surface => setup.play(api => api.impact(surface, place)));
  assert.deepEqual(pellets.map(played => played.id !== null), [true, true, true, true, false, false, false, false]);
  assert.ok(pellets.slice(4).every(played => played.nodes.length === 0), 'Dropped pellets allocate nothing');
  near(pellets[1].out.gain.value / pellets[0].out.gain.value, .8);
  near(pellets[3].out.gain.value / pellets[2].out.gain.value, .58 / .68);
  context.advance(.035);
  const ricochets = [0, 1, 2].map(() => setup.play(api => api.impact('metal', place)));
  assert.deepEqual(ricochets.map(played => played.id !== null), [true, true, false], 'At most two of a surface per volley');
  for (const surface of ['glass', 'toString', '', null, 7]) assert.equal(instance.impact(surface, place), null);
  settle(setup);
});

test('hit markers are dry, centred, under 60 ms, merged per volley and tucked just after the crack', () => {
  const setup = fixture(), { context, instance } = setup;
  const body = setup.play(api => api.hitMarker());
  inspect(setup, body, { length: .06, nodes: 8 });
  assert.equal(body.voice.kind, 'hitMarker');
  assert.equal(body.voice.priority, weaponAudio.PRIORITIES.hitMarker);
  assert.ok(body.nodes.every(node => node.kind !== 'panner' && node.kind !== 'stereo'), 'Non-spatial');
  assert.deepEqual(body.out.connections, [body.bus.post], 'Dry, and after the glue compressor so gunfire never ducks it');
  near(body.voice.start, context.currentTime + .005);
  assert.ok(body.nodes.find(node => node.type === 'bandpass').frequency.value > 3500, 'A bright tick');
  // Pellets landing together share one tick; a headshot upgrades it.
  assert.equal(instance.hitMarker(), body.id);
  context.advance(.01);
  assert.equal(instance.hitMarker({ armored: true }), body.id);
  const head = setup.play(api => api.hitMarker({ headshot: true }));
  assert.ok(typeof head.id === 'number' && head.id !== body.id);
  inspect(setup, head, { length: .06, nodes: 12 });
  assert.ok(head.sources.some(source => source.type === 'sine' && source.frequency.events[0].value > 3000), 'A higher tink');
  assert.ok(head.nodes.some(node => node.type === 'bandpass' && node.frequency.value < 1500 && strikes(node.connections[0]).length === 3),
    'over a bony crunch');
  assert.equal(instance.hitMarker(), head.id, 'The headshot absorbs the rest of the volley');
  context.advance(.03);
  const armored = setup.play(api => api.hitMarker({ armored: true }));
  assert.ok(typeof armored.id === 'number' && armored.id !== head.id);
  inspect(setup, armored, { length: .06, nodes: 10 });
  assert.ok(armored.nodes.find(node => node.type === 'bandpass').frequency.value < 3000, 'Armour dulls the tick');
  assert.ok(armored.sources.some(source => source.type === 'sine' && source.frequency.events[0].value < 200), 'with a thud under it');
  // A hit from this frame's shot ticks 20 ms after its crack instead of under it.
  context.advance(.5);
  const gun = setup.play(api => api.shot('rifle', { ammo: 20, capacity: 30 })), tick = setup.play(api => api.hitMarker());
  near(tick.voice.start - gun.voice.start, .02);
  assert.ok(tick.voice.end - context.currentTime < .08);
  context.advance(.04);
  const later = setup.play(api => api.hitMarker());
  near(later.voice.start, context.currentTime + .005);
  for (const options of ['x', 5, true]) assert.equal(instance.hitMarker(options), null);
  assert.equal(instance.hitMarker(null), later.id);
  settle(setup);
});

test('brass lands .35–.8 s after the shot, rings by floor, the shotgun hull is dull, and automatic fire is thinned', () => {
  const setup = fixture({ random: () => .5 }), { context, instance } = setup;
  const ringOf = played => played.sources.filter(source => source.kind === 'oscillator').map(source => source.connections[0])
    .find(node => node.gain.events.length);
  const rifle = setup.play(api => api.casing('rifle'));
  inspect(setup, rifle, { length: 1.4, nodes: 10 });
  assert.equal(rifle.voice.kind, 'casing');
  const ring = ringOf(rifle), bounces = strikes(ring), times = ring.gain.events.filter(event => event.method === 'set').map(event => event.time);
  assert.equal(bounces.length, 3);
  assert.ok(bounces[1].value < bounces[0].value && bounces[2].value < bounces[1].value, 'Each bounce is quieter');
  assert.ok(times[2] - times[1] < times[1] - times[0], 'and comes sooner');
  const landing = times[0] - context.currentTime;
  assert.ok(landing >= .35 && landing <= .8, `lands after ${landing} s`);
  assert.ok(Math.min(...rifle.sources.filter(source => source.kind === 'oscillator').map(source => source.frequency.events[0].value)) > 3500,
    'Bright brass');
  const pan = rifle.nodes.find(node => node.kind === 'stereo');
  assert.ok(pan.pan.value > 0 && pan.pan.value < .5, 'Ejected to the right, near the player');
  assert.equal(instance.casing('rifle'), null, 'Automatic fire drops most of its brass');
  context.advance(.1);
  assert.equal(instance.casing('pistol'), null);
  context.advance(.11);
  const shell = setup.play(api => api.casing('shotgun', { surface: 'metal' }));
  inspect(setup, shell, { length: 1.4, nodes: 10 });
  assert.ok(Math.min(...shell.sources.filter(source => source.kind === 'oscillator').map(source => source.frequency.events[0].value)) < 1000,
    'A dull plastic hull');
  assert.equal(strikes(ringOf(shell)).length, 2);
  assert.ok(decayOf(ringOf(shell)) < decayOf(ring));
  const level = {}, decay = {};
  for (const floor of FLOORS) {
    context.advance(.21);
    const played = setup.play(api => api.casing('rifle', { surface: floor }));
    level[floor] = played.out.gain.value; decay[floor] = decayOf(ringOf(played));
  }
  assert.ok(level.carpet < level.concrete && level.grass < level.concrete && level.metal >= level.concrete, 'Soft floors swallow it');
  assert.ok(decay.metal > decay.concrete && decay.carpet < decay.concrete / 2);
  for (const surface of ['lava', 'toString', '', 7]) assert.equal(instance.casing('rifle', { surface }), null);
  settle(setup);
  // Seeded landings all fall inside the window; contexts without a StereoPannerNode still get their brass.
  const seeded = fixture({ seed: 3 });
  for (let index = 0; index < 30; index++) {
    const played = seeded.play(api => api.casing(GUNS[index % 3], { surface: FLOORS[index % 6] }));
    const first = Math.min(...played.sources.map(source => source.starts[0].time)) - seeded.context.currentTime;
    assert.ok(first >= .35 && first <= .8, `landed after ${first} s`);
    seeded.context.advance(.25);
  }
  settle(seeded);
  const legacy = fixture({ legacy: true }), plain = legacy.play(api => api.casing('pistol', { surface: 'tile' }));
  inspect(legacy, plain, { length: 1.4, nodes: 9 });
  assert.deepEqual(plain.out.connections, [plain.bus.mix]);
  settle(legacy);
});

test('dry fire and weapon equips are short, finite foley', () => {
  for (const id of GUNS) {
    const setup = fixture();
    const click = setup.play(api => api.dry(id));
    inspect(setup, click, { length: .1, nodes: 10 });
    assert.equal(click.voice.kind, 'dry');
    assert.ok(click.nodes.some(node => node.type === 'bandpass' && node.Q.value === 3 && node.frequency.value > 2000), 'A bright trigger click');
    finish(setup, click);
    const draw = setup.play(api => api.equip(id));
    inspect(setup, draw, { length: .4, nodes: 12 });
    assert.equal(draw.voice.kind, 'equip');
    const hits = draw.nodes.filter(node => node.kind === 'gain' && node.gain.events.length).reduce((sum, node) => sum + strikes(node).length, 0);
    assert.ok(hits >= 4, 'Cloth, handling clicks and a lock');
    finish(setup, draw);
    settle(setup);
  }
});

// The click lane of a foley voice: its bright bandpass (Q 3) and the strikes on its gain.
const clicksOf = played => strikes(played.nodes.find(node => node.type === 'bandpass' && node.Q.value === 3).connections[0]);

test('reload foley fits inside the reload time for every weapon, duration and magazine state', () => {
  const counts = {};
  for (const id of GUNS) {
    for (const duration of [RELOAD[id], RELOAD[id] * .5, .3, 6]) {
      for (const empty of [true, false]) {
        const setup = fixture({ seed: 2 }), { context, instance } = setup, now = context.currentTime;
        const played = setup.play(api => api.reload(id, duration, { empty }));
        inspect(setup, played, { length: duration, nodes: 12 });
        assert.equal(played.voice.kind, 'reload');
        assert.ok(played.voice.end <= now + duration + 1e-9 && played.sources.every(source => source.stops[0] <= now + duration + 1e-9),
          `${id} ${duration} s: every strike lands inside the reload`);
        assert.equal(instance.snapshot().reloading, true);
        const clicks = clicksOf(played);
        counts[`${id} ${duration} ${empty}`] = clicks.length;
        if (id === 'pistol' && duration === RELOAD.pistol) {
          const handling = played.nodes.find(node => node.type === 'bandpass' && node.Q.value < 2).frequency.events;
          assert.ok(handling.some(event => event.value < 450), 'The empty magazine clatters on the floor');
          assert.ok(clicks.at(-1).time - now >= .75 * duration, 'The slide snaps forward at the end');
        }
        context.advanceTo(now + duration + .01);
        assert.equal(instance.snapshot().reloading, false);
        assert.equal(instance.cancelReload(), false, 'A finished reload has nothing to cancel');
        settle(setup);
      }
    }
    for (const duration of [RELOAD[id], RELOAD[id] * .5, .3, 6]) {
      const [empty, full] = [counts[`${id} ${duration} true`], counts[`${id} ${duration} false`]];
      // An empty rifle also slams its bolt home; an empty shotgun takes a fourth shell; the pistol always racks its slide.
      assert.equal(empty, id === 'pistol' ? full : full + 1, `${id} at ${duration} s: ${empty} vs ${full} clicks`);
    }
  }
  // A paused reload resumes from where it was: earlier strikes are skipped and the rest keep their places.
  const whole = fixture({ seed: 2 }), resumed = fixture({ seed: 2 }), now = resumed.context.currentTime;
  const all = whole.play(api => api.reload('rifle', 2.15, { empty: true }));
  const rest = resumed.play(api => api.reload('rifle', 2.15, { empty: true, progress: .5 }));
  inspect(resumed, rest, { length: 2.15 * .5 });
  assert.ok(rest.voice.end <= now + 2.15 * .5 + 1e-9);
  assert.ok(clicksOf(rest).length >= 1 && clicksOf(rest).length < clicksOf(all).length);
  settle(whole);
  settle(resumed);
});

test('cancelReload() cuts pending foley within a short fade; equip and a new reload cancel it too', () => {
  const setup = fixture(), { context, instance } = setup;
  assert.equal(instance.cancelReload(), false, 'Nothing to cancel');
  const reload = setup.play(api => api.reload('rifle', 2.15, { empty: true })), later = clicksOf(reload).at(-1).time;
  context.advance(.5);
  const now = context.currentTime;
  assert.equal(instance.cancelReload(), true);
  assert.equal(instance.snapshot().reloading, false);
  assert.ok(later > now + .5, 'The bolt release was still to come');
  assert.ok(reload.sources.every(source => source.stops.at(-1) <= now + FADE + 1e-9), 'and is cut with everything else');
  const fade = reload.out.gain.events;
  assert.equal(fade.at(-1).value, 0);
  assert.ok(fade.at(-1).time <= now + FADE + 1e-9);
  assert.equal(instance.cancelReload(), false);
  context.advance(.05);
  assert.ok(reload.nodes.every(node => node.connections.length === 0) && reload.sources.every(source => source.onended === null));
  // Switching weapons voids the reload.
  const shells = setup.play(api => api.reload('shotgun', 2.85, {}));
  context.advance(.3);
  const swap = setup.play(api => api.equip('pistol'));
  assert.equal(typeof swap.id, 'number');
  assert.equal(instance.snapshot().reloading, false);
  assert.ok(shells.sources.every(source => source.stops.at(-1) <= context.currentTime + FADE + 1e-9));
  // A new reload replaces the old one.
  context.advance(.5);
  const first = setup.play(api => api.reload('pistol', 1.45, {})), second = setup.play(api => api.reload('pistol', 1.45, { empty: true }));
  assert.deepEqual(instance.snapshot().voices.filter(voice => voice.kind === 'reload').map(voice => voice.id), [second.id]);
  assert.ok(first.sources.every(source => source.stops.at(-1) <= context.currentTime + FADE + 1e-9));
  assert.equal(instance.snapshot().reloading, true);
  assert.deepEqual(context.errors, []);
  settle(setup);
});

test('sixteen voices: shots outrank brass, impacts and remote fire; the hit marker is never dropped', () => {
  const setup = fixture(), { context, instance } = setup, place = { x: 1, y: 1.5, z: -10 };
  const first = setup.play(api => api.remoteShot('rifle', place)), stale = first.sources[0].onended;
  for (let index = 1; index < 16; index++) assert.equal(typeof instance.remoteShot('rifle', { ...place, x: index }), 'number');
  assert.equal(instance.snapshot().activeVoices, 16);
  const before = context.nodes.length;
  assert.equal(instance.impact('flesh', { x: 0, y: 1, z: -3 }), null, 'An impact never cuts a gunshot');
  assert.equal(instance.casing('rifle'), null, 'nor does brass');
  assert.equal(context.nodes.length, before, 'Dropped cues allocate nothing');
  const now = context.currentTime;
  assert.equal(typeof instance.shot('rifle', { ammo: 30, capacity: 30 }), 'number');
  assert.equal(instance.snapshot().activeVoices, 16);
  assert.ok(instance.snapshot().voices.every(voice => voice.id !== first.id), 'The oldest remote shot was stolen');
  assert.ok(first.sources.every(source => source.stops.at(-1) <= now + .015 + 1e-9), 'Stolen layers stop within a short fade');
  assert.equal(first.out.gain.events.at(-1).value, 0);
  context.advance(.03);
  assert.ok(first.nodes.every(node => node.connections.length === 0) && first.sources.every(source => source.onended === null));
  stale();
  assert.equal(instance.snapshot().activeVoices, 16, 'A stale ended callback cannot remove a replacement');
  // A reload outranks remote fire.
  const reload = instance.reload('shotgun', 2.85, {});
  for (let index = 0; index < 20; index++) instance.remoteShot('pistol', place);
  assert.ok(instance.snapshot().voices.some(voice => voice.id === reload));
  // A full mix of gunfire still makes room for the hit marker, and never steals it back.
  for (let index = 0; index < 16; index++) instance.shot(GUNS[index % 3], { ammo: 30, capacity: 30 });
  assert.ok(instance.snapshot().voices.every(voice => voice.kind === 'shot'));
  const marker = instance.hitMarker({ headshot: true });
  assert.equal(typeof marker, 'number');
  for (let index = 0; index < 32; index++) instance.shot('rifle', { ammo: 30, capacity: 30 });
  assert.ok(instance.snapshot().voices.some(voice => voice.id === marker), 'Gunfire never steals the hit marker');
  context.advance(.02);
  for (let step = 0; step < 40; step++) {
    for (let index = 0; index < 4; index++) instance.shot(GUNS[(step + index) % 3], { ammo: 30, capacity: 30 });
    const tick = instance.hitMarker({ headshot: step % 3 === 0, armored: step % 4 === 0 });
    assert.equal(typeof tick, 'number', 'Every reported hit gets its tick');
    const state = instance.snapshot();
    assert.ok(state.voices.some(voice => voice.id === tick && voice.kind === 'hitMarker'));
    assert.ok(state.activeVoices <= 16 && context.pending.size <= 16 * 6, 'Bounded voices and live sources');
    context.advance(.03);
  }
  assert.deepEqual(context.errors, []);
  settle(setup);
});

// A minute of play at 60 fps: rifle auto fire at 8.7 rounds/s through 30-round magazines (dry click, 2.15 s reload),
// brass for every round, an impact per round (flesh with a hit marker, or the walls), and a teammate firing nearby.
function firefight(setup, { checks = true } = {}) {
  const { context, instance } = setup;
  const stats = { peakVoices: 0, peakLive: 0, peakPending: 0, created: [], kinds: new Set(), shots: 0, ticks: 0, reloads: 0 };
  let mag = 30, next = 0, reloaded = Infinity;
  instance.equip('rifle');
  for (let frame = 0; frame < 60 * FPS; frame++) {
    const time = frame / FPS;
    context.advance(DT);
    if (time >= reloaded) { mag = 30; reloaded = Infinity; next = time; }
    while (reloaded === Infinity && next <= time) {
      if (mag === 0) {
        instance.dry('rifle');
        instance.reload('rifle', 2.15, { empty: true });
        stats.reloads++; reloaded = time + 2.15;
        break;
      }
      mag--;
      const shot = instance.shot('rifle', { ammo: mag, capacity: 30, aiming: time % 10 > 6 });
      if (checks) assert.equal(typeof shot, 'number', 'Every round fires');
      instance.casing('rifle', { surface: FLOORS[stats.shots % FLOORS.length] });
      const at = { x: 4 * Math.sin(time), y: 1.2, z: -6 - (stats.shots % 7) };
      if (stats.shots % 3) {
        instance.impact('flesh', at);
        const tick = instance.hitMarker({ headshot: stats.shots % 7 === 0, armored: stats.shots % 11 === 0 });
        if (checks) assert.equal(typeof tick, 'number', 'Every hit ticks');
        stats.ticks++;
      } else instance.impact(SURFACES[1 + stats.shots % 3], at);
      stats.shots++;
      next += .115;
    }
    if (frame % 40 === 13) {
      instance.remoteShot(frame % 120 === 13 ? 'shotgun' : 'rifle', { x: 9 * Math.cos(time), y: 1.5, z: 12 * Math.sin(time), occluded: frame % 80 === 13 });
    }
    if (!checks) continue;
    const state = instance.snapshot();
    for (const voice of state.voices) stats.kinds.add(voice.kind);
    stats.peakVoices = Math.max(stats.peakVoices, state.activeVoices);
    if (frame % 15 === 0) {
      stats.peakLive = Math.max(stats.peakLive, live(context).length);
      stats.peakPending = Math.max(stats.peakPending, context.pending.size);
    }
    if (frame % FPS === 0) stats.created.push(context.nodes.length);
  }
  return stats;
}

test('a minute of automatic fire at 8.7 rounds/s with reloads, brass, impacts and hit markers leaks nothing', t => {
  const setup = fixture({ seed: 3 }), { context } = setup;
  const stats = firefight(setup);
  const perSecond = stats.created.slice(1).map((count, index) => count - stats.created[index]);
  const average = perSecond.reduce((sum, value) => sum + value, 0) / perSecond.length;
  t.diagnostic(`shots ${stats.shots}, ticks ${stats.ticks}, reloads ${stats.reloads}, peak voices ${stats.peakVoices}, ` +
    `peak connected nodes ${stats.peakLive}, peak live sources ${stats.peakPending}, nodes/s ${average.toFixed(0)} (max ${Math.max(...perSecond)})`);
  assert.ok(stats.shots >= 300 && stats.reloads >= 9, `${stats.shots} rounds, ${stats.reloads} reloads`);
  for (const kind of ['shot', 'casing', 'impact', 'hitMarker', 'reload', 'dry', 'remoteShot', 'equip']) assert.ok(stats.kinds.has(kind), kind);
  assert.ok(stats.peakVoices <= 16);
  assert.ok(stats.peakLive < 300, `connected nodes peaked at ${stats.peakLive}`);
  assert.ok(stats.peakPending < 80, `live sources peaked at ${stats.peakPending}`);
  assert.ok(average < 450 && Math.max(...perSecond) < 700, 'Bounded allocation rate');
  for (const node of context.nodes) {
    for (const param of params(node)) assert.ok(param.events.length < 80, 'No parameter accumulates an automation queue');
  }
  assert.equal(context.nodes.filter(node => node.kind === 'compressor').length, 1, 'One bus for the whole fight');
  assert.deepEqual(context.errors, []);
  settle(setup);
});

test('stop() fades every voice and the shared tail, is idempotent, and sound resumes on a fresh bus', () => {
  const setup = fixture(), { context, instance } = setup;
  instance.stop(); instance.stop();
  assert.equal(setup.owned().length, 0, 'Stopping an idle instance allocates nothing');
  instance.equip('rifle');
  instance.shot('shotgun', { ammo: 0, capacity: 6 });
  instance.casing('shotgun');
  instance.reload('rifle', 2.15, { empty: true });
  instance.impact('metal', { x: 1, y: 1, z: -5 });
  instance.hitMarker({ headshot: true });
  instance.remoteShot('rifle', { x: 4, y: 1.5, z: -9 });
  assert.equal(instance.snapshot().activeVoices, 7);
  const bus = busOf(context), sources = context.sources.filter(source => !source.ended), now = context.currentTime;
  instance.stop();
  const state = instance.snapshot();
  assert.equal(state.activeVoices, 0);
  assert.equal(state.reloading, false);
  assert.ok(sources.every(source => source.stops.at(-1) <= now + FADE + 1e-9), 'Every layer, even brass yet to land, is cut');
  for (const node of [bus.mix, bus.post]) {
    assert.equal(node.gain.events.at(-1).value, 0);
    assert.ok(node.gain.events.at(-1).time <= now + FADE + 1e-9, 'The corridor tail fades with them');
  }
  const stops = context.sources.map(source => source.stops.length), count = context.nodes.length, events = bus.mix.gain.events.length;
  instance.stop(); instance.stop();
  assert.deepEqual(context.sources.map(source => source.stops.length), stops);
  assert.equal(context.nodes.length, count);
  assert.equal(bus.mix.gain.events.length, events);
  assert.equal(instance.cancelReload(), false);
  context.advance(.1);
  assertReleased(setup);
  const again = setup.play(api => api.shot('rifle', { ammo: 30, capacity: 30 }));
  inspect(setup, again, { nodes: 12 });
  const fresh = busOf(context);
  assert.notEqual(fresh.compressor, bus.compressor, 'No old tail can come back');
  assert.equal(fresh.room.buffer, bus.room.buffer, 'The corridor impulse is reused');
  assert.equal(context.buffers.length, 1);
  settle(setup);
});

test('inactive contexts stay silent; suspending or closing mid-play releases at once; a failing build leaves nothing', () => {
  const calls = api => [() => api.shot('rifle'), () => api.remoteShot('pistol', { x: 1, y: 1, z: 1 }), () => api.dry('shotgun'),
    () => api.reload('rifle', 2), () => api.equip('pistol'), () => api.hitMarker(), () => api.impact('wood', { x: 0, y: 1, z: -2 }),
    () => api.casing('rifle')];
  for (const state of ['suspended', 'interrupted', 'closed']) {
    const idle = fixture();
    idle.context.state = state;
    for (const call of calls(idle.instance)) assert.equal(call(), null, state);
    assert.equal(idle.instance.cancelReload(), false);
    assert.equal(idle.owned().length, 0, `${state}: nothing allocated`);
    assert.deepEqual(idle.instance.snapshot(), { activeVoices: 0, maxVoices: 16, reloading: false, voices: [] });
    assert.doesNotThrow(() => idle.instance.stop());
    assert.deepEqual(idle.context.errors, []);
  }
  const offline = fixture();
  offline.context.state = 'suspended';
  offline.context.startRendering = () => assert.fail('The caller owns offline rendering');
  assert.ok(calls(offline.instance).every(call => typeof call() === 'number'), 'Offline contexts may schedule while suspended');
  offline.context.state = 'running';
  settle(offline);

  const paused = fixture();
  paused.instance.reload('shotgun', 2.85, { empty: true });
  paused.instance.shot('rifle', { ammo: 3, capacity: 30 });
  paused.instance.casing('rifle');
  paused.context.state = 'suspended';
  const frozen = paused.context.nodes.length;
  assert.equal(paused.instance.shot('pistol'), null);
  assert.equal(paused.context.nodes.length, frozen);
  assert.equal(paused.instance.cancelReload(), true);
  paused.instance.stop();
  assert.ok(paused.owned().every(node => node.connections.length === 0), 'Nothing waits on a frozen audio clock');
  assert.ok(paused.context.sources.every(source => source.onended === null));
  paused.context.state = 'running';
  assert.equal(typeof paused.instance.shot('pistol'), 'number');
  settle(paused);

  const closing = fixture();
  closing.instance.shot('shotgun', { ammo: 1, capacity: 6 });
  closing.instance.casing('shotgun');
  closing.instance.reload('rifle', 2.15, {});
  closing.context.advance(.1);
  closing.context.state = 'closed';
  closing.instance.stop();
  assert.ok(closing.owned().every(node => node.connections.length === 0), 'A closed context is released at once');
  assert.ok(closing.context.sources.every(source => source.onended === null));
  assert.equal(closing.instance.shot('rifle'), null);
  assert.equal(closing.instance.snapshot().activeVoices, 0);
  assert.deepEqual(closing.context.errors, []);

  const failing = fixture(), { context, instance } = failing, original = context.createOscillator.bind(context);
  let made = 0;
  context.createOscillator = () => { if (++made > 1) throw new Error('Synthetic allocation failure'); return original(); };
  assert.equal(instance.shot('rifle', { ammo: 0, capacity: 30 }), null);
  assert.ok(context.sources.some(source => source.kind === 'oscillator' && source.starts.length), 'Exercise a partial build');
  assert.ok(context.sources.every(source => !source.starts.length || source.stops.at(-1) <= context.currentTime), 'Nothing keeps running');
  const shared = busOf(context).nodes;
  assert.ok(failing.owned().filter(node => !shared.has(node)).every(node => node.connections.length === 0), 'The partial voice is released');
  assert.equal(instance.snapshot().activeVoices, 0);
  context.createOscillator = original;
  assert.equal(typeof instance.shot('rifle', { ammo: 0, capacity: 30 }), 'number');
  settle(failing);

  const broken = fixture(), convolver = broken.context.createConvolver;
  broken.context.createConvolver = () => { throw new Error('No convolver'); };
  assert.equal(broken.instance.shot('pistol'), null);
  assert.ok(broken.owned().every(node => node.connections.length === 0), 'A half-built bus is torn down');
  broken.context.createConvolver = convolver;
  assert.equal(typeof broken.instance.shot('pistol'), 'number');
  settle(broken);
});

test('unknown weapons, surfaces, floors and malformed options return null without allocating', () => {
  const setup = fixture(), { context, instance } = setup, place = { x: 1, y: 1, z: 1 };
  for (const id of ['toString', '__proto__', 'constructor', 'hasOwnProperty', '', 'RIFLE', 'smg', null, undefined, 42, {}, ['rifle']]) {
    assert.equal(instance.shot(id), null);
    assert.equal(instance.remoteShot(id, place), null);
    assert.equal(instance.dry(id), null);
    assert.equal(instance.equip(id), null);
    assert.equal(instance.reload(id, 2), null);
    assert.equal(instance.casing(id), null);
    assert.equal(instance.impact(id, place), null);
  }
  for (const options of ['aiming', 7, true]) {
    assert.equal(instance.shot('rifle', options), null);
    assert.equal(instance.hitMarker(options), null);
    assert.equal(instance.reload('rifle', 2, options), null);
    assert.equal(instance.casing('rifle', options), null);
  }
  for (const bad of [{ x: NaN, y: 1, z: 1 }, { x: 1, y: Infinity, z: 1 }, { x: '1', y: 1, z: 1 }, { ...place, occluded: 'yes' },
    { ...place, distance: -2 }, 'here', 3]) {
    assert.equal(instance.remoteShot('rifle', bad), null);
    assert.equal(instance.impact('metal', bad), null);
  }
  for (const duration of [NaN, -1, 0, .05, 21, Infinity, '2', null, undefined]) assert.equal(instance.reload('rifle', duration), null);
  for (const surface of ['lava', 'toString', 'carpet ', 3]) assert.equal(instance.casing('rifle', { surface }), null);
  assert.equal(instance.cancelReload(), false);
  assert.equal(setup.owned().length, 0, 'Nothing was allocated');
  // Junk numbers inside valid options are sanitised rather than refused.
  for (const options of [{ ammo: NaN, capacity: 30 }, { ammo: 3, capacity: 0 }, { ammo: -4, capacity: -1 }, { indoor: NaN, aiming: 'yes' },
    { ammo: 1e9, capacity: 1 }, { indoor: 7 }, { indoor: -3 }, []]) {
    const played = setup.play(api => api.shot('rifle', options));
    inspect(setup, played, { nodes: 14 });
    context.advance(.2);
  }
  assert.equal(typeof instance.reload('pistol', 1, { empty: 'yes', progress: -5 }), 'number');
  assert.equal(instance.reload('pistol', 1, { progress: 9 }), null, 'A reload resumed at its very end has nothing left to play');
  assert.deepEqual(context.errors, []);
  settle(setup);
});

test('given the same random source and calls, the graph is reproduced exactly', () => {
  const trace = seed => {
    const setup = fixture({ seed });
    firefight(setup, { checks: false });
    const nodes = setup.context.nodes.map(node => [node.kind, node.type, node.starts, node.stops, node.gain?.value,
      node.gain?.events.length, node.frequency?.events.slice(0, 3), node.Q?.value, node.playbackRate?.value, node.pan?.value]);
    setup.instance.stop();
    return JSON.stringify(nodes);
  };
  const first = trace(21);
  assert.equal(trace(21), first);
  assert.notEqual(trace(22), first);
});

test('short noise buffers and low sample rates still produce finite, in-range schedules', () => {
  for (const [duration, sampleRate] of [[.035, 8000], [.25, 22050]]) {
    const setup = fixture({ duration, sampleRate }), { context, instance, noiseBuffer } = setup;
    for (const id of GUNS) {
      instance.shot(id, { ammo: 0, capacity: 6, aiming: true });
      instance.remoteShot(id, { x: 2, y: 1, z: -30, occluded: true });
      instance.dry(id); instance.equip(id); instance.casing(id, { surface: 'metal' });
      instance.reload(id, RELOAD[id], { empty: true });
      context.advance(.25);
    }
    for (const surface of SURFACES) instance.impact(surface, { x: 1, y: 1, z: -2 });
    instance.hitMarker({ headshot: true, armored: true });
    for (const source of context.sources.filter(source => source.kind === 'buffer')) {
      const { time, offset } = source.starts[0], consumed = (source.stops[0] - time) * source.playbackRate.value;
      assert.ok(source.loop ? offset < noiseBuffer.duration : offset + consumed <= noiseBuffer.duration + 1e-8);
    }
    for (const node of context.nodes.filter(node => node.frequency)) {
      for (const value of [node.frequency.value, ...node.frequency.events.map(event => event.value)]) {
        assert.ok(value > 0 && value < sampleRate / 2, `${value} Hz at ${sampleRate} Hz`);
      }
    }
    const impulse = busOf(context).room.buffer;
    assert.equal(impulse.sampleRate, sampleRate);
    assert.ok(impulse.getChannelData(0).every(Number.isFinite));
    assert.deepEqual(context.errors, []);
    settle(setup);
  }
});

// A small mono offline renderer for the fake graph, enough to compare loudness through the shared bus: automation,
// biquads, saturators, noise and oscillator sources, the glue compressor (static curve with knee, makeup gain, attack,
// release and a 6 ms look-ahead) and panner distance gains. The convolver and slapback stay silent: it measures the dry hit.
function automation(param) {
  const events = param.events;
  let index = 0;
  return time => {
    while (index < events.length && events[index].time <= time) index++;
    if (!index) return param.value;
    const previous = events[index - 1], next = events[index];
    if (!next || next.method === 'set') return previous.value;
    const mix = (time - previous.time) / (next.time - previous.time);
    if (next.method === 'linear') return previous.value + (next.value - previous.value) * mix;
    return previous.value * Math.pow(next.value / previous.value, mix);
  };
}
function biquad(type, frequency, q, gain, rate) {
  const w = 2 * Math.PI * Math.min(Math.max(frequency, 1), rate * .499) / rate, cos = Math.cos(w), sin = Math.sin(w);
  let b, a;
  if (type === 'bandpass') {
    const alpha = sin / (2 * Math.max(q, 1e-4));
    b = [alpha, 0, -alpha]; a = [1 + alpha, -2 * cos, 1 - alpha];
  } else if (type === 'highshelf') {
    // WebAudio shelves ignore Q: slope 1.
    const A = Math.pow(10, gain / 40), root = Math.SQRT2 * Math.sqrt(A) * sin;
    b = [A * ((A + 1) + (A - 1) * cos + root), -2 * A * ((A - 1) + (A + 1) * cos), A * ((A + 1) + (A - 1) * cos - root)];
    a = [(A + 1) - (A - 1) * cos + root, 2 * ((A - 1) - (A + 1) * cos), (A + 1) - (A - 1) * cos - root];
  } else {
    // WebAudio lowpass and highpass Q is in dB.
    const alpha = sin / (2 * Math.pow(10, q / 20));
    b = type === 'highpass' ? [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2] : [(1 - cos) / 2, 1 - cos, (1 - cos) / 2];
    a = [1 + alpha, -2 * cos, 1 - alpha];
  }
  return [b[0] / a[0], b[1] / a[0], b[2] / a[0], a[1] / a[0], a[2] / a[0]];
}
function distanceGain(panner, listener) {
  const read = key => panner[key].events.length ? panner[key].events.at(-1).value : panner[key].value;
  const [x, y, z] = panner.position || [read('positionX'), read('positionY'), read('positionZ')];
  const ear = listener.positionX ? [listener.positionX.value, listener.positionY.value, listener.positionZ.value] : [0, 0, 0];
  const ref = panner.refDistance, distance = Math.max(ref, Math.hypot(x - ear[0], y - ear[1], z - ear[2]));
  if (panner.distanceModel === 'exponential') return Math.pow(distance / ref, -panner.rolloffFactor);
  return ref / (ref + panner.rolloffFactor * (distance - ref));
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
  const values = param => {
    if (!timelines.has(param)) timelines.set(param, automation(param));
    const timeline = timelines.get(param), out = new Float64Array(size);
    for (let index = 0; index < size; index++) out[index] = timeline(timeAt(index));
    return out;
  };
  function pull(node) {
    if (memo.has(node)) return memo.get(node);
    const out = new Float64Array(size);
    memo.set(node, out);
    if (!states.has(node)) states.set(node, { phase: 0, z: [0, 0, 0, 0], reduction: 0, ring: null, write: 0 });
    const state = states.get(node);
    if (node instanceof FakeSource) {
      if (!node.starts.length) return out;
      const [{ time: begin, offset }] = node.starts, end = node.stops.length ? node.stops.at(-1) : Infinity;
      const frequency = node.kind === 'oscillator' ? values(node.frequency) : null;
      const data = node.kind === 'buffer' ? node.buffer.getChannelData(0) : null;
      for (let index = 0; index < size; index++) {
        const time = timeAt(index);
        if (time < begin || time >= end) continue;
        if (data) {
          let at = Math.floor((offset + (time - begin) * node.playbackRate.value) * node.buffer.sampleRate);
          if (node.loop) at %= data.length;
          out[index] = at < data.length ? data[at] : 0;
        } else {
          const phase = state.phase;
          state.phase = (phase + frequency[index] / rate) % 1;
          out[index] = node.type === 'triangle' ? (phase < .25 ? 4 * phase : phase < .75 ? 2 - 4 * phase : 4 * phase - 4)
            : Math.sin(2 * Math.PI * phase);
        }
      }
      return out;
    }
    const input = new Float64Array(size);
    for (const source of inputs.get(node) || []) {
      const signal = pull(source);
      for (let index = 0; index < size; index++) input[index] += signal[index];
    }
    if (node.kind === 'gain') {
      const gain = values(node.gain);
      for (let index = 0; index < size; index++) out[index] = input[index] * gain[index];
    } else if (node.kind === 'filter') {
      const frequency = values(node.frequency), q = values(node.Q), z = state.z;
      let c;
      for (let index = 0; index < size; index++) {
        if (index % 8 === 0) c = biquad(node.type, frequency[index], q[index], node.gain.value, rate);
        const y = c[0] * input[index] + c[1] * z[0] + c[2] * z[1] - c[3] * z[2] - c[4] * z[3];
        z[1] = z[0]; z[0] = input[index]; z[3] = z[2]; z[2] = y; out[index] = y;
      }
    } else if (node.kind === 'shaper') {
      const curve = node.curve, last = curve.length - 1;
      for (let index = 0; index < size; index++) {
        const at = Math.min(last, Math.max(0, (input[index] + 1) / 2 * last)), low = Math.floor(at), high = Math.min(last, low + 1);
        out[index] = curve[low] + (curve[high] - curve[low]) * (at - low);
      }
    } else if (node.kind === 'compressor') {
      const T = node.threshold.value, K = node.knee.value, R = node.ratio.value;
      const curve = level => level <= T ? level : level < T + K ? level + (1 / R - 1) * (level - T) ** 2 / (2 * K)
        : T + K / 2 + K / (2 * R) + (level - T - K) / R;
      const makeup = -.6 * curve(0), attack = Math.exp(-1 / (rate * node.attack.value)), release = Math.exp(-1 / (rate * node.release.value));
      if (!state.ring) state.ring = new Float64Array(Math.round(.006 * rate) + 1);
      for (let index = 0; index < size; index++) {
        const level = 20 * Math.log10(Math.max(Math.abs(input[index]), 1e-9)), want = curve(level) - level;
        state.reduction = want + (state.reduction - want) * (want < state.reduction ? attack : release);
        state.ring[state.write] = input[index];
        state.write = (state.write + 1) % state.ring.length;
        out[index] = state.ring[state.write] * Math.pow(10, (state.reduction + makeup) / 20);
      }
    } else if (node.kind === 'panner' || node.kind === 'stereo') {
      // Equal-power panning summed to mono, times the distance model.
      const angle = node.kind === 'stereo' ? (Math.max(-1, Math.min(1, node.pan.value)) + 1) * Math.PI / 4 : Math.PI / 4;
      const gain = (Math.cos(angle) + Math.sin(angle)) / 2 * (node.kind === 'panner' ? distanceGain(node, context.listener) : 1);
      for (let index = 0; index < size; index++) out[index] = input[index] * gain;
    } else if (node.kind !== 'convolver' && node.kind !== 'delay') out.set(input);
    return out;
  }
  for (base = 0; base < frames; base += size) {
    memo = new Map();
    const out = pull(target);
    for (let index = 0; index < size && base + index < frames; index++) result[base + index] = out[index];
  }
  return result;
}
// BS.1770 K-weighting (48 kHz coefficients), then the loudest 50 ms window, in dB.
const K_WEIGHTING = [[1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, .73248077421585],
  [1, -2, 1, -1.99004745483398, .99007225036621]];
function loudness(signal) {
  const weighted = Float64Array.from(signal), size = Math.round(.05 * 48000);
  for (const [b0, b1, b2, a1, a2] of K_WEIGHTING) {
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let index = 0; index < weighted.length; index++) {
      const x = weighted[index], y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y; weighted[index] = y;
    }
  }
  let sum = 0, best = 0;
  for (let index = 0; index < weighted.length; index++) {
    sum += weighted[index] ** 2;
    if (index >= size) sum -= weighted[index - size] ** 2;
    best = Math.max(best, sum);
  }
  return 10 * Math.log10(Math.max(best / size, 1e-20));
}
// One call rendered through the bus to the module output: mean loudness over a few seeds, and the highest peak.
function measure(call, seeds = [5, 17, 29]) {
  let level = 0, top = 0;
  for (const seed of seeds) {
    const setup = fixture({ seed }), { context, instance } = setup, from = context.currentTime;
    assert.equal(context.sampleRate, 48000);
    const id = call(instance);
    assert.equal(typeof id, 'number');
    const voice = instance.snapshot().voices.find(entry => entry.id === id);
    const signal = render(context, busOf(context).ceiling, from, voice.end + .03);
    for (const value of signal) { assert.ok(Number.isFinite(value)); top = Math.max(top, Math.abs(value)); }
    level += loudness(signal) / seeds.length;
    instance.stop();
  }
  return { level, peak: top };
}

test('rendered loudness: shotgun > rifle ≈ pistol > impacts > hit marker > brass, all under the ceiling', t => {
  const at = { x: 0, y: 1.6, z: -2 }, full = id => ({ ammo: CAPACITY[id], capacity: CAPACITY[id] });
  const sounds = {
    shotgun: api => api.shot('shotgun', full('shotgun')), rifle: api => api.shot('rifle', full('rifle')),
    pistol: api => api.shot('pistol', full('pistol')), 'remote rifle 10 m': api => api.remoteShot('rifle', { x: 0, y: 1.6, z: -10 }),
    ...Object.fromEntries(SURFACES.map(surface => [`impact ${surface}`, api => api.impact(surface, at)])),
    'hit marker': api => api.hitMarker(), 'hit marker headshot': api => api.hitMarker({ headshot: true }),
    'hit marker armored': api => api.hitMarker({ armored: true }),
    ...Object.fromEntries(GUNS.map(id => [`casing ${id}`, api => api.casing(id, { surface: 'metal' })])),
    'casing rifle concrete': api => api.casing('rifle')
  };
  const level = {};
  for (const [name, call] of Object.entries(sounds)) {
    const result = measure(call);
    level[name] = result.level;
    assert.ok(result.peak < .96, `${name} stays under the limiter ceiling (${result.peak})`);
    assert.ok(result.level > -50, `${name} is audible (${result.level.toFixed(1)} dB)`);
  }
  t.diagnostic(Object.entries(level).map(([name, value]) => `${name} ${value.toFixed(1)}`).join(', '));
  const impacts = SURFACES.map(surface => level[`impact ${surface}`]);
  const markers = ['', ' headshot', ' armored'].map(kind => level[`hit marker${kind}`]);
  const brass = [...GUNS.map(id => level[`casing ${id}`]), level['casing rifle concrete']];
  assert.ok(level.shotgun > Math.max(level.rifle, level.pistol) + 1.5, 'The shotgun is the biggest gun');
  assert.ok(Math.abs(level.rifle - level.pistol) < 2.5, 'Rifle and pistol sit together');
  assert.ok(Math.min(level.rifle, level.pistol) > Math.max(...impacts) + 6, 'Guns over impacts');
  assert.ok(Math.min(...impacts) > Math.max(...markers) + 1.5, 'Close impacts over the hit marker');
  assert.ok(Math.min(...markers) > Math.max(...brass) + 4, 'The hit marker over brass');
  assert.ok(level['remote rifle 10 m'] < level.rifle - 8, 'A teammate down the corridor sits well under your own gun');
});
