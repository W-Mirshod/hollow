/* The survivor's guns: layered gunshots that ring down a shared corridor reverb, reload and equip foley,
   hit-marker ticks, bullet impacts and brass. The caller owns the context, its master gain, the listener and
   all game timing; every call schedules finite one-shots on the audio clock and returns a voice id or null. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else if (typeof define === 'function' && define.amd) define([], factory);
  else root.HollowWeaponAudio = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_VOICES = 16, LEAD = .005, FADE = .02, STEAL = .012, MERGE = .025, UNMASK = .02, CASING_GAP = .2, CLUSTER = .03;
  const RELOAD_RANGE = [.1, 20];
  // A full mix retires the oldest voice of the lowest tier; the hit marker outranks everything, so it is never dropped.
  const PRIORITY = Object.freeze({ casing: 0, impact: 1, remoteShot: 2, dry: 3, equip: 3, reload: 4, shot: 5, hitMarker: 6 });
  // Gunshot layers. crack [shelf Hz, boost dB, length s, peak]: the broadband snap. body [band Hz from, to, Q, decay s,
  // peak]: the blast. thump [Hz from, to, glide s, decay s, peak]: the punch. All three are saturated together by `drive`.
  // mech [delay s, band Hz, decay s, peak, attack s]: bolt, slide or pump strikes. level = voice gain, send = corridor tail.
  const GUNS = {
    rifle: { level: .31, drive: 2.4, send: .5, ping: 2650, mechQ: 3.2,
      crack: [3400, 8, .0035, .85], body: [1150, 380, .7, .09, 3.1], thump: [165, 56, .07, .13, .56],
      mech: [[.019, 2300, .022, .45], [.033, 3300, .018, .34]] },
    pistol: { level: .36, drive: 2.2, send: .42, ping: 3100, mechQ: 3.6,
      crack: [3900, 9, .0025, .95], body: [1450, 450, .75, .06, 2.8], thump: [220, 84, .045, .085, .52],
      mech: [[.018, 2900, .016, .42], [.03, 3800, .014, .32]] },
    shotgun: { level: .33, drive: 2.9, send: .8, ping: 2100, mechQ: 2.2,
      crack: [2900, 7, .0055, .85], body: [700, 170, .55, .18, 3.2], thump: [130, 53, .12, .28, .72],
      // A light rattle with the blast, then the pump racked back and slammed home from ~.35 s.
      mech: [[.026, 1900, .02, .18], [.35, 1350, .05, .45, .007], [.47, 2500, .045, .55]],
      thunks: [[.352, 190, .05, .3], [.472, 240, .045, .38]] }
  };
  const IMPACTS = { flesh: { level: .34, send: .1 }, metal: { level: .34, send: .3 }, concrete: { level: .32, send: .2 },
    wood: { level: .6, send: .15 } };
  // Spent brass: partials [Hz, second partial ratio, its level], ring decay s, bounces; the shotgun hull is a dull plastic tok.
  const CASINGS = {
    rifle: { level: .045, delay: [.42, .75], partials: [4300, 2.32, .5], ring: .08, bounces: 3, click: 5200 },
    pistol: { level: .04, delay: [.35, .6], partials: [6100, 1.93, .45], ring: .055, bounces: 3, click: 6500 },
    shotgun: { level: .055, delay: [.45, .8], partials: [760, 2.95, .3], ring: .03, bounces: 2, click: 1400 }
  };
  const FLOORS = {
    concrete: { ring: 1, level: 1, tone: 1, click: 1 }, tile: { ring: 1.15, level: 1.05, tone: 1.04, click: 1.1 },
    metal: { ring: 1.45, level: 1.08, tone: .97, click: 1 }, wood: { ring: .45, level: .8, tone: .9, click: .7 },
    carpet: { ring: .2, level: .4, tone: .85, click: .35 }, grass: { ring: .15, level: .3, tone: .85, click: .3 }
  };
  // Foley strikes on three lanes: a = handling/thunk noise band, b = bright click band, c = metal ring.
  // [time, lane, Hz, attack s, decay s, peak]. Dry and equip times are seconds; reload times are fractions of the reload.
  const DRY = {
    rifle: [[0, 'b', 3400, .0003, .014, 1], [.001, 'c', 1350, .001, .035, .25], [.03, 'b', 2500, .0004, .01, .25]],
    pistol: [[0, 'b', 4200, .0003, .011, 1], [.001, 'c', 1800, .001, .03, .22]],
    shotgun: [[0, 'b', 2300, .0004, .016, 1], [.001, 'c', 900, .001, .04, .3], [.04, 'b', 1800, .0005, .012, .2]]
  };
  const EQUIP = {
    rifle: [[0, 'a', 1100, .05, .1, .5], [.05, 'b', 3800, .0005, .012, .32], [.085, 'b', 4300, .0005, .01, .24],
      [.13, 'b', 3500, .0005, .012, .2], [.2, 'b', 2600, .0006, .03, .85], [.2, 'a', 640, .002, .05, .55], [.202, 'c', 520, .001, .045, .3]],
    pistol: [[0, 'a', 1500, .02, .03, .4], [.035, 'a', 2900, .012, .03, .45], [.11, 'b', 4200, .0004, .014, .7],
      [.112, 'c', 900, .001, .03, .2]],
    shotgun: [[0, 'a', 800, .07, .12, .5], [.06, 'b', 2100, .0006, .02, .3], [.09, 'b', 1900, .0006, .018, .26],
      [.12, 'b', 2200, .0006, .02, .22], [.24, 'b', 1800, .0008, .04, .9], [.24, 'a', 420, .003, .07, .6], [.242, 'c', 330, .001, .06, .35]]
  };
  const RELOADS = {
    // Mag release click, mag out, pouch rustle, mag in and seat; an empty rifle also slams its bolt home.
    rifle: { nominal: 2.15, level: .38, steps: [
      [.06, 'b', 3600, .0005, .012, .55], [.064, 'c', 2250, .001, .03, .14],
      [.12, 'a', 1150, .018, .07, .45], [.168, 'a', 520, .002, .05, .5], [.17, 'b', 1900, .001, .02, .3],
      [.33, 'a', 1000, .03, .06, .22], [.38, 'a', 1350, .022, .05, .17], [.44, 'a', 880, .03, .07, .2],
      [.58, 'a', 1500, .014, .04, .4], [.645, 'b', 2800, .0008, .03, .95], [.646, 'a', 620, .002, .06, .7], [.65, 'c', 1650, .001, .05, .2]],
      empty: [[.83, 'b', 3200, .0006, .035, 1], [.831, 'a', 480, .002, .07, .8], [.835, 'c', 1100, .001, .07, .26]],
      full: [[.8, 'a', 700, .01, .05, .25]] },
    // Mag release, the mag dropping and clattering on the floor, a fresh mag seated, the slide snapping forward.
    pistol: { nominal: 1.45, level: .38, steps: [
      [.06, 'b', 4200, .0004, .01, .5], [.1, 'a', 1700, .01, .04, .32],
      [.31, 'a', 380, .002, .06, .55], [.311, 'b', 2600, .0008, .025, .42], [.313, 'c', 3150, .001, .06, .12],
      [.37, 'a', 420, .002, .04, .25], [.372, 'b', 3000, .0008, .018, .2],
      [.55, 'a', 1900, .012, .03, .35], [.6, 'b', 3400, .0006, .025, .85], [.601, 'a', 760, .002, .05, .55],
      [.82, 'b', 3800, .0005, .03, 1], [.821, 'a', 950, .002, .055, .7], [.825, 'c', 1950, .001, .06, .24]] },
    // Shells thumbed in one by one (four when empty), then the pump.
    shotgun: { nominal: 2.85, level: .38, shells: { empty: [.1, .27, .44, .61], full: [.12, .32, .52] },
      shell: [[0, 'a', 1450, .012, .03, .3], [.012, 'b', 2400, .0006, .016, .7], [.013, 'c', 270, .002, .05, .28]],
      pump: [[.8, 'a', 1300, .008, .05, .6], [.801, 'b', 1850, .002, .03, .4], [.84, 'a', 620, .003, .05, .7],
        [.841, 'b', 2600, .0008, .035, 1], [.843, 'c', 900, .001, .05, .2]] }
  };
  const MARKER = { level: .31, headshot: .8, armored: .92 };
  const DRY_LEVEL = .3, EQUIP_LEVEL = .3;
  // The shared corridor: a ~1.45 s stereo impulse with sparse early reflections and a darkening diffuse tail, plus a slapback.
  const ROOM = { length: 1.45, rt60: 1.25, early: 2.6, wet: .9, slap: .092, slapLevel: .2, slapTone: 2300, lowCut: 160 };
  // [seconds, level]: floor and ceiling first, then side walls bouncing back and forth, then the far corridor ends.
  const REFLECTIONS = [[.0042, .9], [.0071, -.7], [.0093, .8], [.0131, -.55], [.0178, .6], [.0226, -.45], [.0264, .42],
    [.0318, -.36], [.0365, .33], [.0442, -.28], [.0521, .25], [.0613, -.2], [.0705, .18], [.0864, -.14]];

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const owns = (table, key) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key);
  const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value : NaN;
  const decibels = value => Math.pow(10, value / 20);
  const EMPTY = Object.freeze({});
  const settings = value => value === undefined || value === null ? EMPTY : typeof value === 'object' ? value : null;
  const curves = new Map();
  // Odd tanh saturation normalised to ±1: silent at rest, denser and punchier as the drive rises.
  function saturation(drive) {
    const key = Math.round(drive * 100) / 100;
    if (!curves.has(key)) {
      const curve = new Float32Array(1025), norm = Math.tanh(key);
      for (let index = 0; index < curve.length; index++) curve[index] = Math.tanh(key * (index * 2 / (curve.length - 1) - 1)) / norm;
      curves.set(key, curve);
    }
    return curves.get(key);
  }
  let limiter = null;
  // Fed at half level: unity gain near silence, a soft knee above, never past ±.95.
  function limiterCurve() {
    if (!limiter) {
      limiter = new Float32Array(1025);
      for (let index = 0; index < limiter.length; index++) limiter[index] = .95 * Math.tanh(2 * (index * 2 / (limiter.length - 1) - 1) / .95);
    }
    return limiter;
  }
  // The corridor impulse depends only on the sample rate, so it is computed once per rate and copied into each
  // context's buffer. A fixed generator: the room never depends on, or consumes, the injected random source.
  const impulses = new Map();
  function corridor(rate) {
    if (impulses.has(rate)) return impulses.get(rate);
    const length = Math.max(2, Math.round(rate * ROOM.length)), early = ROOM.early * Math.sqrt(rate / 48000);
    const fall = Math.exp(-6.9078 / (ROOM.rt60 * rate)), darken = Math.exp(-2.4 / rate);
    let seed = 0x1f2e3d4c;
    const white = () => { seed = (Math.imul(seed, 1664525) + 1013904223) | 0; return (seed >>> 0) / 2147483648 - 1; };
    const channels = [0, 1].map(channel => {
      const data = new Float32Array(length);
      let smooth = 0, pole = 0, level = 1, bright = 9000, energy = 0;
      for (let index = 0; index < length; index++) {
        // The diffuse tail darkens as it decays; its lowpass only needs updating every 32 samples.
        if (!(index & 31)) pole = 1 - Math.exp(-2 * Math.PI * Math.min(rate * .45, 700 + bright) / rate);
        smooth += pole * (white() - smooth);
        data[index] = smooth * clamp((index / rate - .006) / .06, 0, 1) * level;
        level *= fall; bright *= darken;
      }
      // Each ear hears the reflections at slightly different times, which widens the corridor.
      for (const [time, gain] of REFLECTIONS) {
        const at = Math.round(time * (1 + (channel ? .04 : -.03) + .03 * white()) * rate);
        for (let offset = -1; offset <= 1; offset++) {
          if (at + offset >= 0 && at + offset < length) data[at + offset] += gain * early * (offset ? .45 : 1);
        }
      }
      for (let index = 0; index < length; index++) energy += data[index] * data[index];
      // Unit energy per ear, so ROOM.wet and each voice's send alone set the tail level.
      const scale = energy > 0 ? 1 / Math.sqrt(energy) : 0;
      for (let index = 0; index < length; index++) data[index] *= scale;
      return data;
    });
    impulses.set(rate, channels);
    return channels;
  }

  function create({ context, output, noiseBuffer, random } = {}) {
    const methods = ['createGain', 'createBufferSource', 'createOscillator', 'createBiquadFilter', 'createWaveShaper',
      'createDynamicsCompressor', 'createPanner', 'createConvolver', 'createDelay', 'createBuffer'];
    if (!context || methods.some(method => typeof context[method] !== 'function') ||
        !Number.isFinite(context.currentTime) || !Number.isFinite(context.sampleRate) || context.sampleRate <= 0 ||
        !output || !output.gain || typeof output.connect !== 'function' ||
        (output.context && output.context !== context) ||
        !noiseBuffer || !Number.isFinite(noiseBuffer.duration) || noiseBuffer.duration <= 0 ||
        (random !== undefined && random !== null && typeof random !== 'function')) {
      throw new TypeError('HollowWeaponAudio needs an AudioContext, its master GainNode and a nonempty noise AudioBuffer');
    }
    // Pure math, no audio nodes: computing the impulse at audio init keeps it from hitching the first gunshot.
    corridor(context.sampleRate);
    const draw = typeof random === 'function' ? random : Math.random;
    const chance = () => { const value = Number(draw()); return Number.isFinite(value) ? clamp(value, 0, .999999) : .5; };
    const rand = (min, max) => min + chance() * (max - min);
    const hz = value => clamp(value, 20, context.sampleRate * .45);
    const inactive = () => context.state === 'closed' || context.state === 'interrupted' ||
      (context.state === 'suspended' && typeof context.startRendering !== 'function');

    const voices = new Map(), retiring = new Set(), dropped = new Set(), recent = [];
    let nextId = 1, bus = null, impulse = null, reloading = null, marker = null, lastCasing = -Infinity, lastShot = -Infinity;

    /* ---------- shared bus: corridor reverb, slapback, glue compressor and limiter ---------- */
    function corridorBuffer() {
      if (impulse) return impulse;
      const channels = corridor(context.sampleRate), buffer = context.createBuffer(2, channels[0].length, context.sampleRate);
      channels.forEach((data, channel) => buffer.getChannelData(channel).set(data));
      return (impulse = buffer);
    }
    function connectBus() {
      if (bus) return bus;
      const nodes = [], make = node => { nodes.push(node); return node; };
      try {
        const mix = make(context.createGain()), compressor = make(context.createDynamicsCompressor());
        const post = make(context.createGain()), ceiling = make(context.createWaveShaper());
        const verb = make(context.createGain()), lowCut = make(context.createBiquadFilter());
        const room = make(context.createConvolver()), wet = make(context.createGain());
        const slap = make(context.createDelay(.5)), dull = make(context.createBiquadFilter()), echo = make(context.createGain());
        compressor.threshold.value = -12; compressor.knee.value = 8; compressor.ratio.value = 4;
        compressor.attack.value = .002; compressor.release.value = .16;
        post.gain.value = .5; ceiling.curve = limiterCurve(); ceiling.oversample = '2x';
        lowCut.type = 'highpass'; lowCut.frequency.value = hz(ROOM.lowCut); lowCut.Q.value = .7;
        room.normalize = false; room.buffer = corridorBuffer();
        wet.gain.value = ROOM.wet;
        slap.delayTime.value = ROOM.slap; dull.type = 'lowpass'; dull.frequency.value = hz(ROOM.slapTone); dull.Q.value = .5;
        echo.gain.value = ROOM.slapLevel;
        mix.connect(compressor); compressor.connect(post); post.connect(ceiling); ceiling.connect(output);
        verb.connect(lowCut); lowCut.connect(room); room.connect(wet); wet.connect(mix);
        lowCut.connect(slap); slap.connect(dull); dull.connect(echo); echo.connect(mix);
        bus = { mix, post, verb, nodes };
        return bus;
      } catch (error) {
        for (const node of nodes) node.disconnect();
        throw error;
      }
    }
    // stop() fades the whole bus, then the next sound builds a fresh one, so no old tail can return.
    function dropBus(now, closed) {
      if (!bus) return;
      const old = bus;
      bus = null;
      if (closed) { for (const node of old.nodes) node.disconnect(); return; }
      for (const param of [old.mix.gain, old.post.gain]) {
        param.setValueAtTime(param.value, now);
        param.linearRampToValueAtTime(0, now + FADE);
      }
      dropped.add({ nodes: old.nodes, end: now + FADE });
    }

    /* ---------- voices ---------- */
    const add = (voice, node) => { voice.nodes.add(node); return node; };
    function release(voice, cancel) {
      if (voice.closed) return;
      voice.closed = true;
      const now = context.currentTime;
      for (const [source, end] of voice.sources) {
        source.onended = null;
        if (cancel && end > now) {
          try { source.stop(now); } catch (error) { /* Already stopped. */ }
        }
      }
      for (const node of voice.nodes) node.disconnect();
      voice.sources.clear(); voice.nodes.clear();
      if (voices.get(voice.id) === voice) voices.delete(voice.id);
      retiring.delete(voice);
      if (reloading === voice) reloading = null;
      if (marker === voice) marker = null;
    }
    // Stolen, cancelled or stopped voices fade on the audio clock instead of clicking off.
    function retire(voice, fade) {
      const now = context.currentTime, end = now + fade, gain = voice.out.gain;
      if (voices.get(voice.id) === voice) voices.delete(voice.id);
      if (reloading === voice) reloading = null;
      if (marker === voice) marker = null;
      gain.setValueAtTime(gain.value, now);
      gain.linearRampToValueAtTime(0, end);
      for (const [source, stopAt] of voice.sources) {
        if (stopAt <= end) continue;
        try { source.stop(end); } catch (error) { /* Already stopped. */ }
        voice.sources.set(source, end);
      }
      voice.end = Math.min(voice.end, end);
      retiring.add(voice);
      if (!voice.sources.size) release(voice, false);
    }
    function prune() {
      const now = context.currentTime;
      for (const voice of Array.from(voices.values())) if (voice.end <= now) release(voice, false);
      for (const voice of Array.from(retiring)) if (voice.end <= now) release(voice, false);
      for (const old of Array.from(dropped)) {
        if (old.end > now) continue;
        for (const node of old.nodes) node.disconnect();
        dropped.delete(old);
      }
    }
    function allocate(kind) {
      const priority = PRIORITY[kind];
      if (voices.size >= MAX_VOICES) {
        let victim = null;
        for (const candidate of voices.values()) if (!victim || candidate.priority < victim.priority) victim = candidate;
        // Brass and impacts never cut a shot; ties retire the oldest.
        if (victim.priority > priority) return null;
        retire(victim, STEAL);
      }
      const voice = { id: nextId++, kind, priority, start: Infinity, end: -Infinity, sources: new Map(), nodes: new Set(),
        closed: false, bus, out: null };
      voices.set(voice.id, voice);
      voice.out = add(voice, context.createGain());
      return voice;
    }
    function oneShot(kind, build) {
      if (inactive()) return null;
      let voice = null;
      try {
        prune();
        connectBus();
        voice = allocate(kind);
        if (!voice) return null;
        build(voice, context.currentTime + LEAD);
        if (!voice.sources.size) throw new Error('Silent voice');
        return voice;
      } catch (error) {
        // A failing or closing context must not take the frame loop down with it.
        if (voice) release(voice, true);
        return null;
      }
    }

    /* ---------- synthesis kit ---------- */
    function gainNode(voice, value, destination) {
      const node = add(voice, context.createGain());
      node.gain.value = value;
      if (destination) node.connect(destination);
      return node;
    }
    function filterNode(voice, type, frequency, q, destination) {
      const node = add(voice, context.createBiquadFilter());
      node.type = type; node.frequency.value = hz(frequency); node.Q.value = q;
      if (destination) node.connect(destination);
      return node;
    }
    // Silent start, fast linear attack, exponential decay to -60 dB, then true zero.
    function strike(param, at, attack, decay, peak) {
      param.setValueAtTime(0, at);
      param.linearRampToValueAtTime(peak, at + attack);
      param.exponentialRampToValueAtTime(Math.max(peak * 1e-3, 1e-6), at + attack + decay);
      param.linearRampToValueAtTime(0, at + attack + decay + .0015);
      return at + attack + decay + .0015;
    }
    // Several strikes on one gain, each shortened so it is silent again before the next one.
    function strikes(param, hits) {
      let end = -Infinity;
      hits.forEach((hit, index) => {
        const next = hits[index + 1], at = Math.max(hit.at, end), room = next ? next.at - at : Infinity;
        if (room < .003 || !(hit.peak > 0)) return;
        const attack = Math.min(hit.attack, room * .3), decay = Math.max(.0005, Math.min(hit.decay, room - attack - .0015));
        end = strike(param, at, attack, decay, hit.peak);
      });
      return end;
    }
    function play(voice, source, start, end, offset) {
      if (offset === undefined) source.start(start);
      else source.start(start, offset);
      voice.sources.set(source, end);
      voice.start = Math.min(voice.start, start); voice.end = Math.max(voice.end, end);
      source.onended = () => {
        if (voice.closed) return;
        source.onended = null; source.disconnect();
        voice.sources.delete(source); voice.nodes.delete(source);
        if (!voice.sources.size) release(voice, false);
      };
      source.stop(end);
    }
    // Reuses the supplied noise: a random window when it fits, otherwise a loop with a finite stop.
    function noiseSource(voice, start, end, rate = 1) {
      const source = add(voice, context.createBufferSource()), span = (end - start) * rate;
      const fits = span <= noiseBuffer.duration * .95;
      source.buffer = noiseBuffer; source.loop = !fits; source.playbackRate.value = rate;
      play(voice, source, start, end, fits ? rand(0, noiseBuffer.duration - span) : rand(0, noiseBuffer.duration * .9));
      return source;
    }
    // An oscillator gliding through [seconds after start, Hz] points into its own struck gain.
    function tone(voice, destination, type, start, glide, hits) {
      const source = add(voice, context.createOscillator()), level = gainNode(voice, 0, destination);
      source.type = type;
      source.frequency.setValueAtTime(hz(glide[0][1]), start);
      for (let index = 1; index < glide.length; index++) source.frequency.exponentialRampToValueAtTime(hz(glide[index][1]), start + glide[index][0]);
      source.connect(level);
      play(voice, source, start, strikes(level.gain, hits) + .004);
    }
    // Finite foley on three lanes sharing one noise source: a = handling band, b = click band, c = metal ring.
    function foley(voice, start, events, destination) {
      const lanes = { a: [], b: [], c: [] };
      for (const [at, lane, frequency, attack, decay, peak] of events) lanes[lane].push({ at: start + at, frequency, attack, decay, peak });
      for (const lane of Object.values(lanes)) lane.sort((first, second) => first.at - second.at);
      const sinks = [];
      let from = Infinity, until = -Infinity;
      for (const [lane, q] of [['a', 1.2], ['b', 3]]) {
        const hits = lanes[lane];
        if (!hits.length) continue;
        const level = gainNode(voice, 0, destination), band = filterNode(voice, 'bandpass', hits[0].frequency, q, level);
        for (const hit of hits) band.frequency.setValueAtTime(hz(hit.frequency), hit.at);
        until = Math.max(until, strikes(level.gain, hits));
        from = Math.min(from, hits[0].at);
        sinks.push(band);
      }
      if (sinks.length) {
        const source = noiseSource(voice, from, until + .004);
        for (const sink of sinks) source.connect(sink);
      }
      if (lanes.c.length) {
        const hits = lanes.c, ring = gainNode(voice, 0, destination), source = add(voice, context.createOscillator());
        source.type = 'triangle';
        for (const hit of hits) source.frequency.setValueAtTime(hz(hit.frequency), hit.at);
        source.connect(ring);
        play(voice, source, hits[0].at, strikes(ring.gain, hits) + .004);
      }
    }
    function spatial(voice, place, model, distanceModel, ref, rolloff) {
      const panner = add(voice, context.createPanner()), now = context.currentTime;
      panner.panningModel = model; panner.distanceModel = distanceModel;
      panner.refDistance = ref; panner.rolloffFactor = rolloff; panner.maxDistance = 80;
      // Positioned before the sound starts, so HRTF never glides in from the origin.
      if (panner.positionX) {
        panner.positionX.setValueAtTime(place.x, now);
        panner.positionY.setValueAtTime(place.y, now);
        panner.positionZ.setValueAtTime(place.z, now);
      } else panner.setPosition(place.x, place.y, place.z);
      return panner;
    }
    function position(options) {
      const input = settings(options);
      if (!input) return null;
      const { x = 0, y = 1.5, z = 0, occluded = false, distance } = input;
      if (![x, y, z].every(value => typeof value === 'number' && Number.isFinite(value)) ||
          !(typeof occluded === 'boolean' || (typeof occluded === 'number' && Number.isFinite(occluded))) ||
          (distance !== undefined && !(numeric(distance) >= 0))) return null;
      return { x, y, z, occluded: clamp(Number(occluded), 0, 1), distance };
    }
    // Metres to the listener: an explicit distance wins, then the live listener position, then a mid-corridor guess.
    function range(place) {
      if (place.distance !== undefined) return place.distance;
      const listener = context.listener, read = param => param && typeof param === 'object' ? numeric(param.value) : NaN;
      const at = listener ? [read(listener.positionX), read(listener.positionY), read(listener.positionZ)] : [];
      return at.length && at.every(Number.isFinite) ? Math.hypot(place.x - at[0], place.y - at[1], place.z - at[2]) : 8;
    }
    // Air absorbs the highs over distance; a wall leaves only the low boom.
    const muffle = (distance, occluded) => hz(clamp(16000 * Math.exp(-distance / 24), 1300, 16000) * Math.pow(.07, occluded));

    /* ---------- gunshots ---------- */
    function blast(voice, gun, start, { aim = false, effects = true, remote = false, ratio = NaN, last = false }) {
      const pitch = 1 + rand(-.04, .04), color = rand(.95, 1.05), stretch = rand(.92, 1.08), out = voice.out;
      const [shelfHz, boost, crackLength, crackPeak] = gun.crack, [from, to, q, decay, bodyPeak] = gun.body;
      const [punch, sub, glide, boom, thumpPeak] = gun.thump;
      const shaper = add(voice, context.createWaveShaper());
      shaper.curve = saturation(effects ? gun.drive : gun.drive * .7); shaper.oversample = '2x';
      shaper.connect(out);
      // 1. Crack: a few milliseconds of noise with a high-shelf bite.
      const crack = gainNode(voice, 0, shaper), shelf = filterNode(voice, 'highshelf', shelfHz * color, .7, crack);
      shelf.gain.value = effects ? boost : boost - 4;
      let noiseEnd = strike(crack.gain, start, .0004, crackLength * stretch, crackPeak * (remote ? .45 : 1) * (effects ? 1 : .6));
      // 2. Body: a band-passed burst sweeping down, tighter when aiming.
      const body = gainNode(voice, 0, shaper), band = filterNode(voice, 'bandpass', from * color * pitch, aim ? q * 1.3 : q, body);
      const length = decay * stretch * (aim ? .88 : 1);
      band.frequency.setValueAtTime(hz(from * color * pitch), start);
      band.frequency.exponentialRampToValueAtTime(hz(to * color * pitch), start + length * 1.3);
      noiseEnd = Math.max(noiseEnd, strike(body.gain, start, .0012, length, bodyPeak));
      // ... and its pitch-dropping thump, with more low end when aiming. The shotgun pump reuses it for weight.
      const thump = gainNode(voice, 0, shaper), kick = add(voice, context.createOscillator());
      kick.type = 'sine';
      kick.frequency.setValueAtTime(hz(punch * pitch), start);
      kick.frequency.exponentialRampToValueAtTime(hz(sub * pitch), start + glide * stretch);
      const hits = [{ at: start, attack: .0015, decay: boom * stretch, peak: thumpPeak * (aim ? 1.2 : 1) }];
      if (!remote && gun.thunks) for (const [delay, frequency, span, peak] of gun.thunks) {
        const at = start + delay + rand(-.004, .004);
        kick.frequency.setValueAtTime(hz(frequency * pitch), at);
        hits.push({ at, attack: .002, decay: span, peak });
      }
      kick.connect(thump);
      play(voice, kick, start, strikes(thump.gain, hits) + .004);
      const sinks = [shelf, band];
      // 3. Mechanical action after the blast: bolt, slide or pump.
      if (!remote) {
        const clack = gainNode(voice, 0, out), action = filterNode(voice, 'bandpass', gun.mech[0][1] * color, gun.mechQ, clack);
        const list = gun.mech.map(([delay, frequency, span, peak, attack = .0006]) => {
          const at = start + delay + rand(-.003, .003);
          action.frequency.setValueAtTime(hz(frequency * color), at);
          return { at, attack, decay: span * stretch, peak: peak * rand(.85, 1.05) };
        });
        noiseEnd = Math.max(noiseEnd, strikes(clack.gain, list));
        sinks.push(action);
      }
      const source = noiseSource(voice, start, noiseEnd + .004, pitch);
      for (const sink of sinks) source.connect(sink);
      // Low ammo: a mechanical ping rising as the magazine empties; the last round rings twice, higher and longer.
      if (!remote && ratio <= .25) {
        const rise = clamp(1 - ratio / .25, 0, 1), at = start + rand(.014, .02), ring = .05 + .03 * rise;
        const ping = gun.ping * (last ? 1.42 : 1 + .4 * rise) * rand(.985, 1.015);
        const glide = last ? [[0, ping], [.049, ping * 1.01], [.05, ping * 1.335], [.2, ping * 1.32]] : [[0, ping], [ring, ping * .99]];
        const rings = last ? [{ at, attack: .0006, decay: .045, peak: .13 }, { at: at + .05, attack: .0006, decay: .16, peak: .15 }]
          : [{ at, attack: .0006, decay: ring, peak: .05 + .06 * rise }];
        tone(voice, out, 'triangle', at, glide, rings);
      }
    }
    function shot(id, options) {
      const gun = owns(GUNS, id) ? GUNS[id] : null, input = settings(options);
      if (!gun || !input) return null;
      const ammo = numeric(input.ammo), capacity = numeric(input.capacity);
      const ratio = capacity > 0 && ammo >= 0 ? Math.min(1, ammo / capacity) : NaN;
      const indoor = Number.isFinite(numeric(input.indoor)) ? clamp(input.indoor, 0, 1) : 1;
      const aim = !!input.aiming, effects = input.effects !== false;
      const voice = oneShot('shot', (voice, start) => {
        voice.out.gain.value = gun.level * decibels(rand(-1.5, 1.5) - (effects ? 0 : 1));
        voice.out.connect(voice.bus.mix);
        // The tail lives in the shared corridor bus; the voice itself stays short.
        if (indoor > 0) voice.out.connect(gainNode(voice, gun.send * indoor * (aim ? .85 : 1), voice.bus.verb));
        blast(voice, gun, start, { aim, effects, ratio, last: ammo <= 0 });
      });
      if (voice) lastShot = voice.start;
      return voice ? voice.id : null;
    }
    function remoteShot(id, options) {
      const gun = owns(GUNS, id) ? GUNS[id] : null, place = position(options);
      if (!gun || !place) return null;
      const voice = oneShot('remoteShot', (voice, start) => {
        const distance = range(place), far = clamp(distance / 25, 0, 1);
        const wall = filterNode(voice, 'lowpass', muffle(distance, place.occluded), .7, null);
        const panner = spatial(voice, place, 'HRTF', 'exponential', 3, .8);
        voice.out.gain.value = gun.level * .9 * decibels(rand(-1.5, 1.5)) * (1 - .45 * place.occluded);
        voice.out.connect(wall); wall.connect(panner); panner.connect(voice.bus.mix);
        // Far or walled-off shots arrive mostly as corridor reverb.
        wall.connect(gainNode(voice, gun.send * (.7 + .6 * far) / (1 + distance / 35) * (1 + .2 * place.occluded), voice.bus.verb));
        blast(voice, gun, start, { remote: true });
      });
      return voice ? voice.id : null;
    }

    /* ---------- foley: dry trigger, equip, reload ---------- */
    function dry(id) {
      if (!owns(DRY, id)) return null;
      const voice = oneShot('dry', (voice, start) => {
        voice.out.gain.value = DRY_LEVEL * decibels(rand(-1, 1));
        voice.out.connect(voice.bus.mix);
        foley(voice, start, DRY[id].map(([at, lane, frequency, attack, decay, peak]) =>
          [at, lane, frequency * rand(.97, 1.03), attack, decay, peak]), voice.out);
      });
      return voice ? voice.id : null;
    }
    function equip(id) {
      if (!owns(EQUIP, id)) return null;
      // A weapon switch always voids a reload in progress.
      cancelReload();
      const voice = oneShot('equip', (voice, start) => {
        voice.out.gain.value = EQUIP_LEVEL * decibels(rand(-1, 1));
        voice.out.connect(voice.bus.mix);
        voice.out.connect(gainNode(voice, .12, voice.bus.verb));
        foley(voice, start, EQUIP[id].map(([at, lane, frequency, attack, decay, peak]) =>
          [at + (at ? rand(-.004, .004) : 0), lane, frequency * rand(.96, 1.04), attack, decay, peak * rand(.85, 1.05)]), voice.out);
      });
      return voice ? voice.id : null;
    }
    function sequence(id, empty) {
      const plan = RELOADS[id];
      if (id === 'rifle') return plan.steps.concat(empty ? plan.empty : plan.full);
      if (id === 'pistol') return plan.steps;
      const shells = plan.shells[empty ? 'empty' : 'full'];
      return shells.flatMap(phase => plan.shell.map(([offset, ...rest]) => [phase + offset, ...rest])).concat(plan.pump);
    }
    function cancelReload() {
      const voice = reloading;
      reloading = null;
      if (!voice || voice.closed) return false;
      if (voice.end <= context.currentTime) { release(voice, false); return false; }
      if (inactive()) release(voice, true);
      else retire(voice, FADE);
      return true;
    }
    // `progress` (0..1) resumes a paused reload: events already heard are skipped, the rest keep their places.
    function reload(id, duration, options) {
      const length = numeric(duration), input = settings(options);
      if (!owns(RELOADS, id) || !input || !(length >= RELOAD_RANGE[0] && length <= RELOAD_RANGE[1])) return null;
      const plan = RELOADS[id], empty = !!input.empty;
      const progress = Number.isFinite(numeric(input.progress)) ? clamp(input.progress, 0, .98) : 0;
      cancelReload();
      const voice = oneShot('reload', (voice, start) => {
        const scale = Math.min(1, length / plan.nominal), skip = progress * length;
        // Every strike, including its source's stop, ends inside the reload window measured from now.
        const room = length - skip - (start - context.currentTime) - .006, events = [];
        for (const [phase, lane, frequency, attack, decay, peak] of sequence(id, empty)) {
          if (phase * length < skip) continue;
          const span = (attack + decay) * scale, at = Math.min(phase * length - skip + rand(-.004, .004) * scale, room - span - .0015);
          if (at < 0) continue;
          events.push([at, lane, frequency * rand(.96, 1.04), attack * scale, decay * scale, peak * rand(.85, 1.05)]);
        }
        voice.out.gain.value = plan.level * decibels(rand(-1, 1));
        voice.out.connect(voice.bus.mix);
        voice.out.connect(gainNode(voice, .1, voice.bus.verb));
        foley(voice, start, events, voice.out);
      });
      if (voice) reloading = voice;
      return voice ? voice.id : null;
    }

    /* ---------- hit marker ---------- */
    function hitMarker(options) {
      const input = settings(options);
      if (!input) return null;
      const headshot = !!input.headshot, armored = !!input.armored, now = context.currentTime;
      // Hits reported within a few milliseconds share one tick (a headshot still upgrades a body hit).
      if (marker && !marker.closed && !inactive() && now - marker.called < MERGE && (marker.headshot || !headshot)) return marker.id;
      const voice = oneShot('hitMarker', (voice, soon) => {
        // A hit landed by this frame's shot ticks just after its crack instead of under it.
        const start = Math.max(soon, lastShot + UNMASK), pitch = 1 + rand(-.025, .025), dull = armored ? .52 : 1;
        voice.out.gain.value = MARKER.level * (headshot ? MARKER.headshot : armored ? MARKER.armored : 1) * decibels(rand(-1, 1));
        // Dry, and after the glue compressor so sustained fire never ducks it.
        voice.out.connect(voice.bus.post);
        const tick = gainNode(voice, 0, voice.out), band = filterNode(voice, 'bandpass', 4300 * dull * pitch, armored ? 1.1 : 1.6, tick);
        let end = strike(tick.gain, start, .0003, armored ? .012 : .008, 2.6);
        const sinks = [band];
        if (headshot) {
          // A bony crunch under the bright tink.
          const crunch = gainNode(voice, 0, voice.out), bone = filterNode(voice, 'bandpass', 1150 * pitch, 2, crunch);
          end = Math.max(end, strikes(crunch.gain, [{ at: start, attack: .0004, decay: .006, peak: 2.2 },
            { at: start + rand(.006, .008), attack: .0004, decay: .005, peak: 1.6 }, { at: start + rand(.013, .016), attack: .0004, decay: .006, peak: 1.1 }]));
          sinks.push(bone);
        }
        const source = noiseSource(voice, start, end + .003, 1);
        for (const sink of sinks) source.connect(sink);
        const ring = 2350 * dull * pitch, decay = armored ? .018 : .028;
        tone(voice, voice.out, 'sine', start, [[0, ring], [decay, ring * .97]], [{ at: start + .0005, attack: .0007, decay, peak: .55 }]);
        if (headshot) {
          const tink = 3520 * dull * pitch;
          tone(voice, voice.out, 'sine', start + .002, [[0, tink], [.045, tink * .99]], [{ at: start + .002, attack: .0006, decay: .042, peak: .45 }]);
        }
        // Armour: a duller thud under the tick.
        if (armored) tone(voice, voice.out, 'sine', start, [[0, 175], [.022, 118]], [{ at: start, attack: .001, decay: .022, peak: .75 }]);
      });
      if (!voice) return null;
      voice.called = now; voice.headshot = headshot; marker = voice;
      return voice.id;
    }

    /* ---------- impacts and brass ---------- */
    const HITS = {
      // Wet thwack: a slap sweeping down, a squelchy resonant sweep and a body thump.
      flesh(voice, start, out) {
        const p = rand(.94, 1.06);
        const slap = gainNode(voice, 0, out), band = filterNode(voice, 'bandpass', 950 * p, .9, slap);
        band.frequency.setValueAtTime(hz(950 * p), start);
        band.frequency.exponentialRampToValueAtTime(hz(360 * p), start + .055);
        let end = strike(slap.gain, start, .0015, .06 * rand(.9, 1.1), 2.6);
        const wet = gainNode(voice, 0, out), squelch = filterNode(voice, 'bandpass', 2300 * p, 4.5, wet), at = start + rand(.006, .011);
        squelch.frequency.setValueAtTime(hz(2300 * p), at);
        squelch.frequency.exponentialRampToValueAtTime(hz(820 * p), at + .045);
        end = Math.max(end, strike(wet.gain, at, .004, .04, 2.2));
        const source = noiseSource(voice, start, end + .004, rand(.9, 1.05));
        source.connect(band); source.connect(squelch);
        tone(voice, out, 'sine', start, [[0, 150 * p], [.05, 68 * p]], [{ at: start, attack: .001, decay: .06, peak: .7 }]);
      },
      // Ricochet: a bright tick, a ringing ping and, usually, a short falling whine.
      metal(voice, start, out) {
        const p = rand(.93, 1.07);
        const tick = gainNode(voice, 0, out), high = filterNode(voice, 'highpass', 2600, .7, tick);
        noiseSource(voice, start, strike(tick.gain, start, .0003, .007, 1.3) + .003).connect(high);
        const ping = 2900 * p;
        tone(voice, out, 'triangle', start, [[0, ping], [.16, ping * .985]], [{ at: start, attack: .0008, decay: .17, peak: .4 }]);
        if (chance() < .65) {
          const at = start + rand(.012, .03), top = rand(4200, 5600);
          tone(voice, out, 'sine', at, [[0, top * .86], [.03, top], [rand(.2, .26), top * rand(.3, .4)]],
            [{ at, attack: .025, decay: .24, peak: .26 }]);
        }
      },
      // Crack and chips sweeping down, then a trickle of dust grains.
      concrete(voice, start, out) {
        const p = rand(.94, 1.06);
        const chip = gainNode(voice, 0, out), band = filterNode(voice, 'bandpass', 4200 * p, .8, chip);
        band.frequency.setValueAtTime(hz(4200 * p), start);
        band.frequency.exponentialRampToValueAtTime(hz(1250 * p), start + .02);
        let end = strike(chip.gain, start, .0003, .035, 2.4);
        const dust = gainNode(voice, 0, out), grit = filterNode(voice, 'highpass', 3200, .7, dust), grains = [];
        for (let index = 0, count = 5 + Math.floor(chance() * 4), at = start + rand(.04, .07); index < count; index++, at += rand(.02, .055)) {
          grains.push({ at, attack: .0004, decay: rand(.004, .012), peak: rand(.1, .3) * (1 - index / (count + 2)) });
        }
        end = Math.max(end, strikes(dust.gain, grains));
        const source = noiseSource(voice, start, end + .004, rand(.95, 1.05));
        source.connect(band); source.connect(grit);
        tone(voice, out, 'sine', start, [[0, 190 * p], [.03, 95 * p]], [{ at: start, attack: .001, decay: .035, peak: .35 }]);
      },
      // Dull knock: a resonant low-mid band and a hollow tone, with a few splinters.
      wood(voice, start, out) {
        const p = rand(.94, 1.06);
        const knock = gainNode(voice, 0, out), band = filterNode(voice, 'bandpass', 560 * p, 2.6, knock);
        let end = strike(knock.gain, start, .001, .05, 3);
        const splinter = gainNode(voice, 0, out), high = filterNode(voice, 'highpass', 2800, .7, splinter);
        end = Math.max(end, strikes(splinter.gain, [{ at: start + rand(.003, .008), attack: .0003, decay: .004, peak: .3 },
          { at: start + rand(.014, .022), attack: .0003, decay: .003, peak: .2 }, { at: start + rand(.03, .04), attack: .0003, decay: .003, peak: .12 }]));
        const source = noiseSource(voice, start, end + .004, rand(.95, 1.05));
        source.connect(band); source.connect(high);
        tone(voice, out, 'triangle', start, [[0, 215 * p], [.07, 178 * p]], [{ at: start, attack: .001, decay: .075, peak: .55 }]);
      }
    };
    // Shotgun pellets arrive together: at most four impacts per ~30 ms, two per surface, each a little quieter.
    function cluster(surface, now) {
      while (recent.length && recent[0].at <= now - CLUSTER) recent.shift();
      if (recent.length >= 4 || recent.filter(entry => entry.surface === surface).length >= 2) return 0;
      return [1, .8, .68, .58][recent.length];
    }
    function impact(surface, options) {
      const place = position(options);
      if (!owns(IMPACTS, surface) || !place || inactive()) return null;
      const now = context.currentTime, thin = cluster(surface, now);
      if (!thin) return null;
      const voice = oneShot('impact', (voice, start) => {
        const distance = range(place), setting = IMPACTS[surface];
        const wall = filterNode(voice, 'lowpass', muffle(distance, place.occluded), .7, null);
        const panner = spatial(voice, place, 'equalpower', 'inverse', 2, 1.1);
        voice.out.gain.value = setting.level * thin * decibels(rand(-1.5, 1.5)) * (1 - .5 * place.occluded);
        voice.out.connect(wall); wall.connect(panner); panner.connect(voice.bus.mix);
        wall.connect(gainNode(voice, setting.send / (1 + distance / 30), voice.bus.verb));
        HITS[surface](voice, start, voice.out);
      });
      if (voice) recent.push({ at: now, surface });
      return voice ? voice.id : null;
    }
    function casing(id, options) {
      const brass = owns(CASINGS, id) ? CASINGS[id] : null, input = settings(options);
      if (!brass || !input) return null;
      const surface = input.surface === undefined ? 'concrete' : input.surface;
      // Automatic fire drops most of its brass: one casing voice per CASING_GAP is plenty.
      if (!owns(FLOORS, surface) || inactive() || context.currentTime - lastCasing < CASING_GAP) return null;
      const floor = FLOORS[surface], now = context.currentTime;
      const voice = oneShot('casing', (voice, start) => {
        voice.out.gain.value = brass.level * floor.level * decibels(rand(-1.5, 1.5));
        // Brass lands near the player, a little to the right of the ejection port.
        if (typeof context.createStereoPanner === 'function') {
          const pan = add(voice, context.createStereoPanner());
          pan.pan.value = rand(.15, .45);
          voice.out.connect(pan); pan.connect(voice.bus.mix);
        } else voice.out.connect(voice.bus.mix);
        const [base, ratio, second] = brass.partials, f = base * floor.tone * rand(.96, 1.04), rings = [], clicks = [];
        let at = start + rand(...brass.delay), gap = rand(.085, .13), level = 1;
        for (let index = 0; index < brass.bounces; index++) {
          rings.push({ at, attack: .0004, decay: brass.ring * floor.ring * rand(.8, 1.2), peak: level });
          clicks.push({ at, attack: .0002, decay: .004, peak: level * floor.click });
          at += gap; gap *= rand(.5, .68); level *= rand(.42, .6);
        }
        const ring = gainNode(voice, 0, voice.out), overtone = gainNode(voice, second, ring);
        const low = add(voice, context.createOscillator()), high = add(voice, context.createOscillator());
        low.type = high.type = 'sine';
        for (const hit of rings) {
          const shift = rand(.99, 1.01);
          low.frequency.setValueAtTime(hz(f * shift), hit.at); high.frequency.setValueAtTime(hz(f * ratio * shift), hit.at);
        }
        low.connect(ring); high.connect(overtone);
        const end = strikes(ring.gain, rings) + .004;
        play(voice, low, rings[0].at, end); play(voice, high, rings[0].at, end);
        const tap = gainNode(voice, 0, voice.out), contact = filterNode(voice, 'highpass', brass.click, .7, tap);
        noiseSource(voice, clicks[0].at, strikes(tap.gain, clicks) + .003).connect(contact);
      });
      if (voice) lastCasing = now;
      return voice ? voice.id : null;
    }

    /* ---------- public API ---------- */
    function stop() {
      const closed = inactive(), now = context.currentTime;
      recent.length = 0; lastCasing = lastShot = -Infinity; marker = null; reloading = null;
      for (const voice of Array.from(voices.values())) {
        if (closed) release(voice, true);
        else retire(voice, FADE);
      }
      if (closed) {
        for (const voice of Array.from(retiring)) release(voice, true);
        for (const old of dropped) for (const node of old.nodes) node.disconnect();
        dropped.clear();
      }
      dropBus(now, closed);
    }
    function snapshot() {
      prune();
      const now = context.currentTime;
      return {
        activeVoices: voices.size, maxVoices: MAX_VOICES,
        reloading: !!reloading && !reloading.closed && reloading.end > now,
        voices: Array.from(voices.values(), voice => ({ id: voice.id, kind: voice.kind, priority: voice.priority,
          start: voice.start, end: voice.end }))
      };
    }
    return Object.freeze({ shot, remoteShot, dry, reload, cancelReload, equip, hitMarker, impact, casing, stop, snapshot });
  }
  return Object.freeze({
    create, PRIORITIES: PRIORITY, MAX_VOICES,
    WEAPON_IDS: Object.freeze(Object.keys(GUNS)),
    IMPACT_SURFACES: Object.freeze(Object.keys(IMPACTS)),
    CASING_SURFACES: Object.freeze(Object.keys(FLOORS))
  });
});
