'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const killAudio = require('../public/kill-audio');
const KillCam = require('../public/killcam');
const script = readFileSync(require.resolve('../public/kill-audio'), 'utf8');

// Fakes follow tests/player-audio.test.js (plus cancelScheduledValues). Failed expectations are also recorded,
// because the module deliberately swallows graph errors.
function check(context, condition, message) {
  if (condition) return;
  const error = new assert.AssertionError({ message });
  context.errors.push(error);
  throw error;
}
class FakeParam {
  constructor(owner, value) { this.owner = owner; this.value = value; this.events = []; }
  get context() { return this.owner.context; }
  record(method, value, time) {
    const context = this.context, last = this.events[this.events.length - 1];
    check(context, Number.isFinite(value), `${method}: finite value`);
    check(context, Number.isFinite(time) && time >= 0, `${method}: finite, nonnegative time`);
    check(context, !last || time >= last.time, 'Ordered automation');
    if (method === 'exponential') check(context, value > 0, 'Exponential ramps cannot reach zero');
    this.events.push({ method, value, time });
    return this;
  }
  setValueAtTime(value, time) { return this.record('set', value, time); }
  linearRampToValueAtTime(value, time) { return this.record('linear', value, time); }
  exponentialRampToValueAtTime(value, time) { return this.record('exponential', value, time); }
  cancelScheduledValues(time) { this.events = this.events.filter(e => e.time < time); return this; }
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
    else { this.frequency = new FakeParam(this, 440); this.type = 'sine'; }
  }
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
    if (time !== undefined) check(this.context, Number.isFinite(time) && time >= 0, 'Every stop has a finite time');
    this.stops.push(time === undefined ? this.context.currentTime : time);
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
  constructor() {
    this.currentTime = 4; this.sampleRate = 48000; this.state = 'running';
    this.nodes = []; this.errors = []; this.pending = new Set();
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
  createDynamicsCompressor() {
    const node = new FakeNode(this, 'compressor');
    for (const [key, value] of Object.entries({ threshold: -24, knee: 30, ratio: 12, attack: .003, release: .25 })) node[key] = new FakeParam(node, value);
    return node;
  }
  createWaveShaper() { return new FakeNode(this, 'shaper'); }
  resume() { assert.fail('The caller owns context activation'); }
  close() { assert.fail('The caller owns context lifetime'); }
  get sources() { return this.nodes.filter(node => node instanceof FakeSource); }
  advanceTo(time) {
    assert.ok(time >= this.currentTime);
    this.currentTime = time;
    for (const source of Array.from(this.pending)) if (source.endTime <= time) source.finish();
  }
}
function seeded(seed = 1) {
  let state = seed;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) | 0; return (state >>> 0) / 4294967296; };
}
function fixture({ api = killAudio, duration = 2, seed = 5 } = {}) {
  const context = new FakeContext(), output = context.createGain();
  output.gain.value = .63; output.connect(context.destination);
  const data = new Float32Array(Math.floor(duration * context.sampleRate));
  const noiseBuffer = Object.freeze({ duration, sampleRate: context.sampleRate, numberOfChannels: 1, length: data.length, getChannelData: () => data });
  const instance = api.create({ context, output, noiseBuffer, random: seeded(seed) });
  const owned = () => context.nodes.filter(node => node !== output && node !== context.destination);
  // Runs the frame loop and the audio clock together at 60 fps.
  const run = (seconds, each) => {
    for (let i = 0, n = Math.round(seconds * 60); i < n; i++) { context.advanceTo(context.currentTime + 1 / 60); instance.update(1 / 60); if (each) each(i / 60); }
    return instance.snapshot();
  };
  return { context, output, noiseBuffer, instance, owned, run };
}
// Everything has stopped, every owned edge is gone, the caller's master gain is untouched.
function assertReleased({ context, instance, output, owned }) {
  assert.equal(instance.snapshot().voices, 0);
  assert.deepEqual(context.errors, [], 'No invalid graph operations were swallowed');
  assert.ok(owned().every(node => node.connections.length === 0), 'All owned graph edges are disconnected');
  assert.ok(context.sources.every(source => source.stops.length > 0), 'Every source was given a stop');
  assert.ok(context.sources.every(source => source.onended === null || source.ended), 'No pending ended callbacks');
  assert.equal(output.gain.value, .63);
  assert.equal(output.gain.events.length, 0);
  assert.equal(output.disconnects, 0);
  assert.deepEqual(output.connections, [context.destination]);
}

test('loads as CommonJS, a browser global and AMD without audio hardware; creation is silent', () => {
  assert.deepEqual(Object.keys(killAudio), ['create', 'CUES', 'VOICES']);
  assert.ok(Object.isFrozen(killAudio) && Object.isFrozen(killAudio.CUES));
  const sandbox = {};
  vm.runInNewContext(script, sandbox, { filename: 'kill-audio.js' });
  assert.equal(typeof sandbox.HollowKillAudio.create, 'function');
  let amd;
  const define = (deps, factory) => { assert.equal(deps.length, 0); amd = factory(); };
  define.amd = {};
  const amdSandbox = { define };
  vm.runInNewContext(script, amdSandbox);
  assert.equal(typeof amd.create, 'function');
  assert.equal(amdSandbox.HollowKillAudio, undefined);
  const setup = fixture({ api: sandbox.HollowKillAudio });
  assert.equal(setup.owned().length, 0, 'Nothing is built until the first cue');
  assert.deepEqual(Object.keys(setup.instance), ['play', 'heart', 'update', 'stop', 'snapshot']);
  assert.ok(Object.isFrozen(setup.instance));
  for (const bad of [{}, { context: new FakeContext() }, { context: new FakeContext(), output: {} }]) assert.throws(() => killAudio.create(bad), TypeError);
  const context = new FakeContext();
  assert.throws(() => killAudio.create({ context, output: context.createGain(), noiseBuffer: { duration: 0 } }), TypeError);
  assert.throws(() => killAudio.create({ context, output: context.createGain(), noiseBuffer: { duration: 1 }, random: 3 }), TypeError);
});

test('every cue builds a finite, ordered graph through one bus and releases itself when it ends', () => {
  for (const cue of killAudio.CUES) {
    const setup = fixture(), { context, instance, output } = setup;
    const id = instance.play(cue, { level: 1, kind: 'shrieker' });
    assert.equal(typeof id, 'number', `${cue}: plays`);
    assert.deepEqual(context.errors, [], `${cue}: valid automation`);
    const sources = context.sources;
    assert.ok(sources.length > 0, `${cue}: makes sound`);
    assert.ok(sources.every(s => s.starts.length === 1 && s.stops.length === 1), `${cue}: every source started and stopped once`);
    const last = Math.max(...sources.map(s => s.endTime));
    assert.ok(Number.isFinite(last) && last - context.currentTime < 3.5, `${cue}: finite (${last - context.currentTime} s)`);
    // One path to the caller's output: cue -> mix -> compressor -> clip -> output.
    const into = context.nodes.filter(n => n.connections.includes(output));
    assert.equal(into.length, 1, `${cue}: one bus into the output`);
    assert.equal(into[0].kind, 'shaper');
    assert.equal(instance.snapshot().voices, 1);
    assert.deepEqual(instance.snapshot().recent, [cue]);
    context.advanceTo(last + .01);
    assert.equal(instance.snapshot().voices, 0, `${cue}: released at the end`);
    const left = setup.owned().filter(n => n.connections.length);
    assert.deepEqual(left.map(n => n.kind).sort(), ['compressor', 'gain', 'shaper'], `${cue}: only the bus stays connected`);
    instance.stop();
    context.advanceTo(context.currentTime + 1);
    assertReleased(setup);
  }
});

test('unknown cues are ignored, levels are clamped and effects off plays softer', () => {
  const { instance, owned } = fixture();
  assert.equal(instance.play('scream'), null);
  assert.equal(instance.play('toString'), null);
  assert.equal(instance.play('crunch', { level: 0 }), null);
  assert.equal(owned().length, 0, 'Nothing built for a rejected cue');
  const levelOf = (opts) => {
    const s = fixture();
    s.instance.play('crunch', opts);
    return s.context.nodes.find(n => n.kind === 'gain' && n.connections[0] && n.connections[0] === s.context.nodes.find(m => m.kind === 'gain' && m.connections.some(c => c.kind === 'compressor'))).gain.value;
  };
  const loud = levelOf({ level: 1 }), soft = levelOf({ level: 1, effects: false }), max = levelOf({ level: 99 });
  assert.ok(soft < loud * .7, 'Effects off is softer');
  assert.ok(Math.abs(max - loud * 1.5) < 1e-9, 'Level is capped at 1.5x');
  assert.equal(levelOf({ level: NaN }), loud);
});

test('a closed context makes everything a no-op', () => {
  const setup = fixture();
  setup.context.state = 'closed';
  assert.equal(setup.instance.play('bite'), null);
  setup.instance.heart(120, 1);
  setup.run(1);
  assert.equal(setup.owned().length, 0);
});

test('the voice count is capped: the oldest cue is cut when a frenzy overflows', () => {
  const setup = fixture(), { instance, context } = setup;
  for (let i = 0; i < 40; i++) instance.play(i % 2 ? 'tear' : 'ring');
  const s = instance.snapshot();
  assert.equal(s.voices, s.maxVoices);
  assert.equal(s.played, 40);
  assert.deepEqual(context.errors, []);
  instance.stop(.2);
  context.advanceTo(context.currentTime + 1);
  assertReleased(setup);
});

test('the heartbeat is scheduled ahead on the audio clock, follows the tempo and stops dead', () => {
  const setup = fixture(), { instance, context } = setup;
  const beats = () => context.sources.filter(s => s.kind === 'buffer').map(s => s.starts[0].time);
  instance.heart(120, .8);
  const t0 = context.currentTime;
  setup.run(3);
  let at = beats();
  assert.ok(at.length >= 5 && at.length <= 7, `about six beats in 3 s at 120 bpm (${at.length})`);
  for (let i = 1; i < at.length; i++) assert.ok(Math.abs(at[i] - at[i - 1] - .5) < 1e-6, 'Steady 0.5 s spacing');
  assert.ok(at[0] - t0 < .2, 'Starts at once');
  assert.ok(at.every(t => t <= context.currentTime + .13), 'Never more than the lookahead ahead');
  instance.heart(48, .9);
  const n = at.length;
  setup.run(3);
  at = beats();
  assert.ok(at.length - n >= 2 && at.length - n <= 4, `slow beats at 48 bpm (${at.length - n})`);
  assert.deepEqual(instance.snapshot().heart, { bpm: 48, level: .9 });
  instance.heart(0);
  const stopped = beats().length;
  setup.run(2);
  assert.equal(beats().length, stopped, 'bpm 0 stops it');
  assert.deepEqual(context.errors, []);
  instance.heart(220e3, 9);
  assert.deepEqual(instance.snapshot().heart, { bpm: 220, level: 1 }, 'Clamped');
  instance.stop();
  context.advanceTo(context.currentTime + 1);
  assertReleased(setup);
});

test('stop fades the bus out, cuts every source and frees the graph; the next kill builds a fresh bus', () => {
  const setup = fixture(), { instance, context } = setup;
  for (const cue of ['screech', 'ring', 'flat', 'gurgle']) instance.play(cue);
  instance.heart(150, 1);
  setup.run(.2);
  const now = context.currentTime, mix = context.nodes.find(n => n.kind === 'gain' && n.connections.some(c => c.kind === 'compressor'));
  instance.stop(.35);
  const ramp = mix.gain.events[mix.gain.events.length - 1];
  assert.deepEqual([ramp.method, ramp.value], ['linear', 0]);
  assert.ok(Math.abs(ramp.time - (now + .35)) < 1e-9, 'Fades over the given time');
  assert.ok(context.sources.every(s => s.endTime <= now + .37), 'Every source stops right after the fade');
  assert.equal(instance.snapshot().heart.bpm, 0);
  assert.equal(instance.snapshot().bus, false);
  setup.run(.5);
  assertReleased(setup);
  assert.equal(typeof instance.play('thud'), 'number');
  assert.equal(instance.snapshot().bus, true);
  instance.stop();
  context.advanceTo(context.currentTime + 1);
  assertReleased(setup);
});

test('every sound a kill track asks for exists, and a whole kill plays cleanly', () => {
  for (const kind of KillCam.KINDS) {
    const T = KillCam.trackFor(kind);
    for (const e of T.events) if (e.type === 'sfx') assert.ok(killAudio.CUES.includes(e.cue), `${kind}: cue ${e.cue}`);
    const setup = fixture(), { instance, context } = setup, cam = KillCam.create();
    let pose = cam.start(kind), played = 0;
    const handle = p => {
      for (let i = 0; i < p.eventCount; i++) {
        const e = p.events[i];
        if (e.type === 'sfx') { assert.equal(typeof instance.play(e.cue, { level: e.a, kind }), 'number', `${kind}: ${e.cue}`); played++; }
        else if (e.type === 'heart') instance.heart(e.a, e.b);
        else if (e.type === 'flat') { instance.heart(0); instance.play('flat'); played++; }
      }
    };
    handle(pose);
    while (!pose.done) { context.advanceTo(context.currentTime + 1 / 60); pose = cam.update(1 / 60); handle(pose); instance.update(1 / 60); }
    assert.equal(instance.snapshot().played, played);
    assert.deepEqual(context.errors, [], kind);
    instance.stop(.35);
    context.advanceTo(context.currentTime + 1);
    assertReleased(setup);
  }
});
