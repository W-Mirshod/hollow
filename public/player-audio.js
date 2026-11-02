/* The survivor's own body and score: breathing, heartbeat, grunts, a chase bed and stingers.
   The caller owns the context, its master gain and the frame clock; update() is cheap per frame. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else if (typeof define === 'function' && define.amd) define([], factory);
  else root.HollowPlayerAudio = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_VOICES = 12, LOOKAHEAD = .12, CONTROL = 1 / 30, FADE = .025, BPM = 130;
  const BREATH = .2, HEART = .16, BED = .16;
  const PRIORITY = { breath: 0, heart: 1, pickup: 1, land: 2, gasp: 2, surge: 2, hurt: 3, kill: 3, headshot: 3,
    fuse: 3, chase: 4, streak: 4, scare: 5 };
  const STINGERS = ['chase', 'kill', 'headshot', 'streak', 'fuse', 'pickup', 'scare'];
  const FLAGS = ['exhausted', 'running', 'moving', 'crouching', 'chase', 'hidden'];
  const LADDER = [0, 2, 4, 7, 9, 12], EMPTY = Object.freeze({});
  // [centre Hz, Q, weight]. Breath is broad turbulence; voiced grunts ring through narrow vocal-tract bands.
  const FORMANTS = {
    inhale: [[960, 1.2, .5], [1820, 1.5, .9], [3700, 1.8, .55]],
    exhale: [[640, 1.4, 1], [1180, 1.7, .72], [2550, 2.2, .3]],
    nasal: [[360, 1.8, 1], [980, 2.2, .4], [2300, 2.6, .16]],
    gasp: [[880, 3.5, .9], [1700, 4.5, 1], [3000, 5, .45]],
    grunt: [[540, 6, 1], [1060, 7.5, .62], [2380, 9, .28]],
    pain: [[760, 5.5, 1], [1280, 7, .72], [2650, 8.5, .34]],
    cough: [[470, 4, 1], [1350, 5, .6], [2450, 6, .3]]
  };
  // [phase, amount] breakpoints after a silent start; every shape closes at true zero.
  const SHAPES = {
    inhale: [[.3, .45], [.6, .9], [.8, 1], [.93, .5], [1, 0]],
    gaspIn: [[.07, .7], [.2, 1], [.45, .8], [.72, .62], [.9, .3], [1, 0]],
    exhale: [[.07, .85], [.18, 1], [.42, .6], [.72, .24], [1, 0]],
    pant: [[.04, 1], [.15, .88], [.34, .6], [.6, .32], [.84, .12], [1, 0]],
    held: [[.3, .55], [.55, 1], [.8, .45], [1, 0]],
    edge: [[.1, 1], [.35, .55], [.7, .18], [1, 0]],
    grunt: [[.05, 1], [.2, .86], [.48, .62], [.78, .28], [1, 0]],
    gasp: [[.12, 1], [.4, .92], [.7, .7], [.88, .35], [1, 0]],
    squeak: [[.2, 1], [.55, .6], [1, 0]],
    swell: [[.12, .55], [.3, 1], [.46, .7], [.62, .95], [.84, .45], [1, 0]],
    rise: [[.5, .12], [.8, .45], [.97, 1], [1, 0]],
    hold: [[.06, 1], [.8, .85], [1, 0]]
  };
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const unit = (value, fallback) => Number.isFinite(value) ? clamp(value, 0, 1) : fallback;
  const ease = (from, to, value) => { const k = clamp((value - from) / (to - from), 0, 1); return k * k * (3 - 2 * k); };
  const follow = (value, target, step, tau) => value + (target - value) * (1 - Math.exp(-step / tau));
  const strike = (attack, decay) => ({ attack, decay });
  const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value : NaN;
  let limiterCurve = null;
  function softClip() {
    if (!limiterCurve) {
      limiterCurve = new Float32Array(1025);
      for (let index = 0; index < limiterCurve.length; index++) {
        const value = index * 2 / (limiterCurve.length - 1) - 1;
        limiterCurve[index] = .85 * Math.tanh(value / .85);
      }
    }
    return limiterCurve;
  }

  function create({ context, output, noiseBuffer, random } = {}) {
    const methods = ['createGain', 'createBufferSource', 'createOscillator', 'createPeriodicWave',
      'createBiquadFilter', 'createDynamicsCompressor', 'createWaveShaper'];
    if (!context || methods.some(method => typeof context[method] !== 'function') ||
        !Number.isFinite(context.currentTime) || !Number.isFinite(context.sampleRate) || context.sampleRate <= 0 ||
        !output || !output.gain || typeof output.connect !== 'function' ||
        (output.context && output.context !== context) ||
        !noiseBuffer || !Number.isFinite(noiseBuffer.duration) || noiseBuffer.duration <= 0 ||
        (random !== undefined && typeof random !== 'function')) {
      throw new TypeError('HollowPlayerAudio needs an AudioContext, its master GainNode and a nonempty noise AudioBuffer');
    }
    const draw = random || Math.random;
    const chance = () => { const value = Number(draw()); return Number.isFinite(value) ? clamp(value, 0, .999999) : .5; };
    const rand = (min, max) => min + chance() * (max - min);
    const hz = value => clamp(value, 20, context.sampleRate * .45);
    const inactive = () => context.state === 'closed' || context.state === 'interrupted' ||
      (context.state === 'suspended' && typeof context.startRendering !== 'function');

    const voices = new Map(), retiring = new Set();
    const input = { active: false, stamina: 1, exhausted: false, running: false, moving: false, crouching: false,
      danger: 0, chase: false, health: 100, effects: true, hidden: false };
    const breath = { effort: 0, rate: 14, level: 0, ragged: false, inhale: true, nextAt: 0, wasExhausted: false };
    const heart = { strain: 0, bpm: 60, level: 0, nextAt: 0 };
    const music = { intensity: 0, target: 0, level: 0 };
    const combo = { step: 0, at: -Infinity };
    let nextId = 1, bus = null, bed = null, glottis = null, pulse = null, live = false, gaspAt = -Infinity;

    /* ---------- graph bookkeeping ---------- */
    const add = (group, node) => { group.nodes.add(node); return node; };
    function connectBus() {
      if (bus) return bus;
      const mix = context.createGain(), compressor = context.createDynamicsCompressor(), limiter = context.createWaveShaper();
      mix.gain.value = 1;
      compressor.threshold.value = -20; compressor.knee.value = 12; compressor.ratio.value = 4;
      compressor.attack.value = .005; compressor.release.value = .2;
      limiter.curve = softClip(); limiter.oversample = '2x';
      mix.connect(compressor); compressor.connect(limiter); limiter.connect(output);
      bus = { mix, nodes: [mix, compressor, limiter] };
      return bus;
    }
    function release(group, cancel) {
      if (group.closed) return;
      group.closed = true;
      for (const source of group.sources) {
        source.onended = null;
        if (cancel) {
          try { source.stop(context.currentTime); } catch (error) { /* Already stopped. */ }
        }
      }
      for (const node of group.nodes) node.disconnect();
      group.sources.clear(); group.nodes.clear();
      if (voices.get(group.id) === group) voices.delete(group.id);
      retiring.delete(group);
      if (bed === group) bed = null;
    }
    function watch(group, source) {
      group.sources.add(source);
      source.onended = () => {
        if (group.closed) return;
        source.onended = null; source.disconnect();
        group.sources.delete(source); group.nodes.delete(source);
        if (!group.sources.size) release(group, false);
      };
    }
    function play(group, source, start, end, offset) {
      watch(group, source);
      group.endsAt = Math.max(group.endsAt, end);
      if (offset === undefined) source.start(start);
      else source.start(start, offset);
      if (Number.isFinite(end)) source.stop(end);
    }
    // A stolen voice or an idle bed fades/stops on the audio clock instead of clicking off.
    function retire(group, fade) {
      const now = context.currentTime, end = now + FADE;
      if (voices.get(group.id) === group) voices.delete(group.id);
      if (bed === group) bed = null;
      if (fade && group.out) {
        group.out.gain.setValueAtTime(group.out.gain.value, now);
        group.out.gain.linearRampToValueAtTime(0, end);
      }
      for (const source of group.sources) {
        try { source.stop(end); } catch (error) { /* Already stopped. */ }
      }
      group.endsAt = end;
      retiring.add(group);
      if (!group.sources.size) release(group, false);
    }
    function prune() {
      const now = context.currentTime;
      for (const voice of voices.values()) if (voice.endsAt <= now) release(voice, false);
      for (const group of retiring) if (group.endsAt <= now) release(group, false);
      if (bus && !live && !voices.size && !bed && !retiring.size) {
        for (const node of bus.nodes) node.disconnect();
        bus = null;
      }
    }
    function allocate(kind, level, at) {
      const priority = PRIORITY[kind];
      if (voices.size >= MAX_VOICES) {
        let victim = null;
        for (const candidate of voices.values()) if (!victim || candidate.priority < victim.priority) victim = candidate;
        // Quiet body sounds never cut a stinger; ties retire the oldest.
        if (victim.priority > priority) return null;
        retire(victim, true);
      }
      connectBus();
      const start = Math.max(context.currentTime + .006, Number.isFinite(at) ? at : 0);
      const voice = { id: nextId++, kind, priority, level, startedAt: start, endsAt: start,
        sources: new Set(), nodes: new Set(), closed: false, out: null };
      voices.set(voice.id, voice);
      voice.out = add(voice, context.createGain());
      voice.out.gain.value = level; voice.out.connect(bus.mix);
      return voice;
    }
    function oneShot(kind, level, build, at) {
      if (inactive() || !Number.isFinite(level) || level <= 0) return null;
      let voice = null;
      try {
        prune();
        voice = allocate(kind, Math.min(level, 1), at);
        if (!voice) return null;
        build(voice, voice.startedAt);
        if (!voice.sources.size) throw new Error('Silent voice');
        return voice.id;
      } catch (error) {
        // A failing or closing context must not take the frame loop down with it.
        if (voice) release(voice, true);
        return null;
      }
    }

    /* ---------- synthesis kit ---------- */
    function glottal() {
      if (!glottis) {
        const real = new Float32Array(40), imaginary = new Float32Array(40);
        for (let harmonic = 1; harmonic < imaginary.length; harmonic++) imaginary[harmonic] = 1 / Math.pow(harmonic, 1.3);
        glottis = context.createPeriodicWave(real, imaginary);
      }
      return glottis;
    }
    function shape(param, start, length, level, points) {
      param.setValueAtTime(0, start);
      for (const [phase, amount] of points) param.linearRampToValueAtTime(level * amount, start + length * phase);
      return start + length;
    }
    function hit(param, start, attack, decay, level) {
      param.setValueAtTime(0, start);
      param.linearRampToValueAtTime(level, start + attack);
      param.exponentialRampToValueAtTime(Math.max(level * .001, 1e-6), start + attack + decay);
      param.linearRampToValueAtTime(0, start + attack + decay + .004);
      return start + attack + decay + .004;
    }
    function glide(param, start, points) {
      param.setValueAtTime(hz(points[0][1]), start);
      for (let index = 1; index < points.length; index++) {
        param.exponentialRampToValueAtTime(hz(points[index][1]), start + points[index][0]);
      }
    }
    function envelope(voice, destination, start, length, level, form) {
      const gain = add(voice, context.createGain());
      const end = Array.isArray(form) ? shape(gain.gain, start, length, level, form)
        : hit(gain.gain, start, form.attack, form.decay, level);
      gain.connect(destination);
      return { gain, end };
    }
    function filter(voice, destination, type, frequency, q) {
      const node = add(voice, context.createBiquadFilter());
      node.type = type; node.frequency.value = hz(frequency); node.Q.value = q;
      node.connect(destination);
      return node;
    }
    function amp(voice, destination, value) {
      const node = add(voice, context.createGain());
      node.gain.value = value; node.connect(destination);
      return node;
    }
    function tone(voice, destination, wave, start, length, level, form, pitch) {
      const source = add(voice, context.createOscillator());
      if (typeof wave === 'string') source.type = wave;
      else source.setPeriodicWave(wave);
      glide(source.frequency, start, pitch);
      const { gain, end } = envelope(voice, destination, start, length, level, form);
      source.connect(gain);
      play(voice, source, start, end + .01);
      return end;
    }
    // Reuses the supplied noise without looping it; long shapes are squeezed into the available buffer.
    function noise(voice, destination, start, length, level, form, rate = 1) {
      const playback = clamp(rate, .25, 4), available = noiseBuffer.duration / playback * .95;
      let span = length, timing = form;
      if (!Array.isArray(form)) {
        const total = form.attack + form.decay + .004, fit = Math.min(1, available / total);
        timing = strike(form.attack * fit, Math.max(.001, form.decay * fit - .004 * (1 - fit)));
      } else span = Math.min(length, available);
      const source = add(voice, context.createBufferSource());
      source.buffer = noiseBuffer; source.loop = false; source.playbackRate.value = playback;
      const { gain, end } = envelope(voice, destination, start, span, level, timing);
      source.connect(gain);
      const offset = rand(0, Math.max(0, noiseBuffer.duration - (end - start) * playback));
      play(voice, source, start, end, offset);
      return end;
    }
    function tract(voice, set, start, length, drift = 1, scale = 1, muffle = 0) {
      const input = add(voice, context.createGain());
      const output = muffle ? filter(voice, voice.out, 'lowpass', muffle, .7) : voice.out;
      for (const [frequency, q, weight] of set) {
        const band = add(voice, context.createBiquadFilter()), level = amp(voice, output, weight);
        const centre = frequency * scale * rand(.95, 1.05);
        band.type = 'bandpass'; band.Q.value = q;
        band.frequency.setValueAtTime(hz(centre), start);
        if (drift !== 1) band.frequency.exponentialRampToValueAtTime(hz(centre * drift), start + Math.max(.02, length));
        input.connect(band); band.connect(level);
      }
      return input;
    }
    // Irregular openings and catches for exhausted, ragged breaths.
    const roughen = points => points.map(([phase, amount], index) =>
      [phase, index === points.length - 1 ? 0 : amount * rand(.5, 1)]);
    // Irregular sparks on one gain: ordered, non-overlapping spikes.
    function crackle(voice, destination, start, length, count, level) {
      const source = add(voice, context.createBufferSource()), gain = add(voice, context.createGain());
      const playback = 1, span = Math.min(length, noiseBuffer.duration * .95);
      source.buffer = noiseBuffer; source.loop = false; source.playbackRate.value = playback;
      gain.gain.setValueAtTime(0, start);
      let at = start + rand(0, .02), end = start;
      for (let index = 0; index < count && at < start + span - .03; index++) {
        const width = rand(.004, .022), peak = level * rand(.25, 1);
        gain.gain.setValueAtTime(0, at);
        gain.gain.linearRampToValueAtTime(peak, at + .0015);
        gain.gain.linearRampToValueAtTime(peak * rand(.1, .4), at + width * .5);
        gain.gain.linearRampToValueAtTime(0, at + width);
        end = at + width;
        at = end + rand(.006, Math.max(.012, span / Math.max(1, count) * 1.6));
      }
      gain.gain.linearRampToValueAtTime(0, Math.max(end, start) + .005);
      source.connect(gain); gain.connect(destination);
      const stopAt = Math.max(end, start) + .01;
      play(voice, source, start, stopAt, rand(0, Math.max(0, noiseBuffer.duration - (stopAt - start) * playback)));
    }

    /* ---------- body: breathing and heartbeat ---------- */
    function physiology(step) {
      const fatigue = 1 - input.stamina;
      let effort = 0;
      if (input.active) {
        if (input.exhausted) effort = 1;
        else if (input.running) effort = .3 + .58 * fatigue;
        else effort = .82 * Math.pow(fatigue, 1.25) + (input.moving ? .05 : 0);
      }
      // Breathing climbs over seconds of sprinting, snaps ragged at exhaustion and recovers slowly.
      breath.effort = follow(breath.effort, effort, step, effort > breath.effort ? (input.exhausted ? .35 : 1.4) : 3.2);
      breath.ragged = input.active && (input.exhausted || breath.effort > .9);
      breath.rate = (14 + 36 * breath.effort) * (input.hidden ? .62 : 1);
      breath.level = BREATH * (.05 + .95 * Math.pow(breath.effort, 1.7)) * (input.hidden ? .28 : 1) * (input.crouching ? .62 : 1);
      const injury = Math.pow(1 - input.health / 100, 1.15);
      const strain = input.active ? Math.max(input.danger, injury, .5 * breath.effort) : 0;
      heart.strain = follow(heart.strain, strain, step, strain > heart.strain ? .7 : 4);
      heart.bpm = 60 + 90 * clamp(heart.strain, 0, 1);
      heart.level = HEART * ease(.1, .32, heart.strain) * (.45 + .55 * heart.strain) * (input.hidden ? 1.25 : 1);
      music.target = input.active ? (input.chase ? Math.max(.6, input.danger) : .75 * input.danger) * (input.hidden ? .7 : 1) : 0;
      music.intensity = follow(music.intensity, music.target, step,
        music.target > music.intensity ? .5 : input.active ? 3 : .8);
      if (music.intensity < 1e-5 && !music.target) music.intensity = 0;
    }
    function breathVoice(inhale, at, length) {
      const ragged = breath.ragged, hidden = input.hidden;
      const level = breath.level * (inhale ? .82 : 1) * (ragged ? rand(.8, 1.12) : rand(.92, 1.06));
      return oneShot('breath', level, (voice, start) => {
        const set = hidden ? FORMANTS.nasal : inhale ? FORMANTS.inhale : FORMANTS.exhale;
        const throat = tract(voice, set, start, length, inhale ? 1.1 : .9, 1 + .16 * breath.effort, hidden ? 1500 : 5200);
        const form = hidden ? SHAPES.held : inhale ? (ragged ? SHAPES.gaspIn : SHAPES.inhale) : (ragged ? SHAPES.pant : SHAPES.exhale);
        const cough = !inhale && ragged && chance() < .14;
        const air = cough ? .07 : 0;
        noise(voice, throat, start + air, length, 1, ragged ? roughen(form) : form, rand(.9, 1.1));
        if (!inhale && ragged && !hidden) {
          // The faint voiced "hah" edge of a winded exhale.
          const pitch = rand(108, 128), edge = length * .42;
          tone(voice, throat, glottal(), start + air + length * .03, edge, rand(.1, .17), SHAPES.edge,
            [[0, pitch], [edge, pitch * .86]]);
        }
        if (cough) {
          const cords = tract(voice, FORMANTS.cough, start, .16, .85);
          noise(voice, cords, start, .1, 1.3, strike(.004, .07), rand(.8, .95));
          tone(voice, cords, glottal(), start + .004, .08, .5, strike(.006, .06), [[0, rand(140, 160)], [.07, 105]]);
        }
      }, at);
    }
    function breathe(now) {
      if (!breath.nextAt || breath.nextAt < now - .3) breath.nextAt = now + .04;
      if (breath.nextAt > now + LOOKAHEAD) return;
      const at = Math.max(breath.nextAt, now + .006), inhale = breath.inhale, ragged = breath.ragged;
      const period = 60 / breath.rate, wobble = () => ragged ? rand(.8, 1.2) : rand(.94, 1.06);
      const length = clamp(period * (inhale ? (ragged ? .4 : .36) : (ragged ? .47 : .44)) * wobble(), .22, inhale ? 1.7 : 2.1);
      // Winded breathing snags: now and then a held catch before the next gulp of air.
      const snag = ragged && !inhale && chance() < .16 ? rand(.12, .32) : 0;
      const rest = inhale ? Math.max(.03, period * .05 * wobble()) : Math.max(.05, period * (ragged ? .08 : .17) * wobble()) + snag;
      breath.inhale = !inhale;
      breath.nextAt = at + length + rest;
      breathVoice(inhale, at, length);
    }
    function beat(at) {
      const strain = clamp(heart.strain, 0, 1);
      return oneShot('heart', heart.level, (voice, start) => {
        const gap = .3 - .1 * strain, pitch = 52 + 10 * strain;
        const body = filter(voice, voice.out, 'lowpass', 320, .8);
        // One sine and one triangle carry both the "lub" and the softer, higher "dub".
        for (const [wave, level, ratio] of [['sine', 1, 1], ['triangle', .45, 2.02]]) {
          const source = add(voice, context.createOscillator()), gain = add(voice, context.createGain());
          const f = pitch * ratio;
          source.type = wave;
          source.frequency.setValueAtTime(hz(f), start);
          source.frequency.exponentialRampToValueAtTime(hz(f * .6), start + .12);
          source.frequency.setValueAtTime(hz(f * 1.12), start + gap);
          source.frequency.exponentialRampToValueAtTime(hz(f * .7), start + gap + .1);
          hit(gain.gain, start, .01, .16, level);
          gain.gain.setValueAtTime(0, start + gap);
          gain.gain.linearRampToValueAtTime(level * .62, start + gap + .01);
          gain.gain.exponentialRampToValueAtTime(level * 6e-4, start + gap + .14);
          gain.gain.linearRampToValueAtTime(0, start + gap + .144);
          source.connect(gain); gain.connect(body);
          play(voice, source, start, start + gap + .16);
        }
        noise(voice, body, start, .14, .5, strike(.006, .11), .5);
      }, at);
    }
    function heartbeat(now) {
      if (heart.level < .004) { heart.nextAt = 0; return; }
      if (!heart.nextAt || heart.nextAt < now - .3) heart.nextAt = now + .03;
      if (heart.nextAt > now + LOOKAHEAD) return;
      const at = Math.max(heart.nextAt, now + .006);
      heart.nextAt = at + 60 / heart.bpm * rand(.975, 1.025);
      beat(at);
    }

    /* ---------- chase bed: built once, then only automated ---------- */
    function buildBed() {
      const now = context.currentTime, start = now + .02;
      const group = { id: 0, kind: 'bed', sources: new Set(), nodes: new Set(), closed: false, endsAt: Infinity,
        startedAt: start, tick: 0, idle: 0, controlAt: -Infinity, last: {}, out: null };
      bed = group;
      try {
        if (!pulse) pulse = context.createPeriodicWave(new Float32Array([0, 1, .55, .2]), new Float32Array(4));
        const out = group.out = amp(group, connectBus().mix, 0);
        // Low pulsing drone: detuned saws and a tritone through a resonant, breathing lowpass.
        const drone = amp(group, out, .2), throb = amp(group, drone, .75);
        const body = filter(group, throb, 'lowpass', 140, 4.5);
        for (const [frequency, detune] of [[55, -7], [55, 8], [77.78, -3]]) {
          const source = add(group, context.createOscillator());
          source.type = 'sawtooth'; source.frequency.value = frequency; source.detune.value = detune;
          source.connect(body); play(group, source, start, Infinity);
        }
        const lfo = add(group, context.createOscillator());
        lfo.setPeriodicWave(pulse); lfo.frequency.value = BPM / 60;
        const depth = amp(group, throb.gain, .15), sweep = amp(group, body.frequency, 60);
        lfo.connect(depth); lfo.connect(sweep); play(group, lfo, start, Infinity);
        // Ticking percussion: one looping noise source, struck by scheduled envelopes on the 8ths.
        const ticks = amp(group, out, 0), hits = amp(group, ticks, 0);
        const band = filter(group, hits, 'bandpass', 6200, 1.2);
        const hiss = add(group, context.createBufferSource());
        hiss.buffer = noiseBuffer; hiss.loop = true; hiss.connect(band);
        play(group, hiss, start, Infinity, rand(0, noiseBuffer.duration * .5));
        // Dissonant string cluster with shared vibrato and tremolo.
        const strings = amp(group, out, 0), tremolo = amp(group, strings, 1);
        const sheen = filter(group, tremolo, 'lowpass', 600, .9), cluster = [];
        for (const frequency of [293.66, 311.13, 415.3, 440]) {
          const source = add(group, context.createOscillator());
          source.type = 'sawtooth'; source.frequency.value = frequency; source.detune.value = rand(-6, 6);
          source.connect(sheen); play(group, source, start, Infinity); cluster.push(source);
        }
        const shiver = add(group, context.createOscillator());
        shiver.type = 'sine'; shiver.frequency.value = rand(5.2, 6.1);
        const vibrato = amp(group, cluster[0].detune, 7), shake = amp(group, tremolo.gain, .12);
        for (const source of cluster.slice(1)) vibrato.connect(source.detune);
        shiver.connect(vibrato); shiver.connect(shake); play(group, shiver, start, Infinity);
        Object.assign(group, { drone, throb, body, depth, sweep, ticks, hits, strings, sheen, cluster,
          detunes: cluster.map(source => source.detune.value), bends: cluster.map((source, index) => 'bend' + index) });
      } catch (error) {
        release(group, true);
        bed = null;
      }
    }
    function write(group, key, param, value, epsilon, now) {
      const last = group.last[key];
      if (last !== undefined && Math.abs(value - last) <= epsilon) return;
      group.last[key] = value;
      param.setTargetAtTime(value, now, .045);
    }
    function steer(now) {
      const group = bed, i = music.intensity, soft = !input.effects;
      const chase = input.active && input.chase;
      music.level = BED * Math.pow(i, 1.25) * (soft ? .6 : 1);
      write(group, 'out', group.out.gain, music.level, 1e-4, now);
      write(group, 'body', group.body.frequency, 140 + 820 * i, 4, now);
      write(group, 'sweep', group.sweep.gain, 60 + 300 * i, 4, now);
      write(group, 'depth', group.depth.gain, .15 + .35 * i, .005, now);
      write(group, 'throb', group.throb.gain, .75 - .15 * i, .005, now);
      write(group, 'ticks', group.ticks.gain, chase ? (.6 + .9 * i) * (soft ? .5 : 1) * (input.hidden ? .35 : 1) : 0, 1e-3, now);
      write(group, 'strings', group.strings.gain, soft ? 0 : .13 * ease(.35, 1, i), 1e-3, now);
      write(group, 'sheen', group.sheen.frequency, 600 + 2600 * Math.pow(i, 1.5), 8, now);
      const bend = 60 * ease(.5, 1, i);
      for (let index = 0; index < group.cluster.length; index++) {
        write(group, group.bends[index], group.cluster[index].detune, group.detunes[index] + bend, 1.5, now);
      }
    }
    function tick(group, at, index) {
      const accent = index % 8 === 0 ? 1 : index % 2 === 0 ? .78 : .46, level = accent * rand(.88, 1);
      const param = group.hits.gain;
      param.setValueAtTime(0, at);
      param.linearRampToValueAtTime(level, at + .0015);
      param.linearRampToValueAtTime(level * .45, at + .02);
      param.linearRampToValueAtTime(0, at + .06);
    }
    function score(step, now) {
      if (!bed && live && (music.target > .02 || music.intensity > .01)) buildBed();
      const group = bed;
      if (!group) return;
      if (music.intensity < .002 && music.target < .01) {
        group.idle += step;
        if (group.idle > 2.5) { retire(group, false); music.level = 0; return; }
      } else group.idle = 0;
      if (now - group.controlAt >= CONTROL) { group.controlAt = now; steer(now); }
      const period = 30 / BPM;
      if (group.startedAt + group.tick * period < now) group.tick = Math.ceil((now - group.startedAt) / period);
      for (let at = group.startedAt + group.tick * period; at <= now + LOOKAHEAD; at = group.startedAt + group.tick * period) {
        if (input.active && input.chase && group.last.ticks > .002) tick(group, at, group.tick);
        group.tick++;
      }
    }

    /* ---------- public API ---------- */
    function read(state) {
      const source = state && typeof state === 'object' ? state : EMPTY;
      input.active = !!source.active;
      input.stamina = unit(source.stamina, 1);
      input.danger = unit(source.danger, 0);
      input.health = Number.isFinite(source.health) ? clamp(source.health, 0, 100) : 100;
      input.effects = source.effects !== false;
      for (const key of FLAGS) input[key] = !!source[key];
    }
    function update(dt, state) {
      const step = Number.isFinite(dt) ? clamp(dt, 0, .25) : 0;
      read(state);
      physiology(step);
      if (inactive()) {
        live = false;
        if (context.state === 'closed') stop();
        return;
      }
      const wasLive = live, now = context.currentTime;
      live = input.active;
      try {
        prune();
        if (live) {
          if (!wasLive) { breath.nextAt = 0; heart.nextAt = 0; breath.inhale = true; }
          // Exhaustion snaps straight into a ragged, gasping inhale.
          if (input.exhausted && !breath.wasExhausted && !input.hidden) { breath.inhale = true; breath.nextAt = now + .02; }
          breathe(now);
          heartbeat(now);
        }
        breath.wasExhausted = input.exhausted;
        score(step, now);
      } catch (error) { /* The audio graph is optional; a failing context must not stall the frame. */ }
    }
    function pushBreath(at, inhale) {
      breath.inhale = inhale;
      breath.nextAt = Math.max(breath.nextAt || 0, at);
    }
    function gasp(strength = 1) {
      const value = numeric(strength);
      if (!Number.isFinite(value) || value <= 0) return null;
      const k = clamp(value, 0, 1), now = context.currentTime;
      if (now - gaspAt < .6) return null;
      const id = oneShot('gasp', .18 + .22 * k, (voice, start) => {
        const length = .24 + .16 * k;
        const throat = tract(voice, FORMANTS.gasp, start, length, 1.14);
        noise(voice, throat, start, length, 1, SHAPES.gasp, rand(1, 1.15));
        if (k > .45) {
          const squeak = .13 + .06 * k;
          tone(voice, throat, glottal(), start + .03, squeak, .22 * k, SHAPES.squeak,
            [[0, rand(240, 270)], [squeak, rand(310, 340)]]);
        }
      });
      if (id !== null) { gaspAt = now; pushBreath(voices.get(id).endsAt + .08, false); }
      return id;
    }
    function hurt(amount) {
      const value = numeric(amount);
      if (!Number.isFinite(value) || value <= 0) return null;
      // amount is health lost (0..100); a Warden blow (~68) is the biggest grunt.
      const severity = clamp(value / 60, .12, 1), length = .17 + .4 * severity;
      const id = oneShot('hurt', .34 + .4 * severity, (voice, start) => {
        const pitch = rand(132, 152) * (1 + .12 * severity);
        const throat = tract(voice, FORMANTS.pain, start, length + .05, .94);
        tone(voice, throat, glottal(), start + .008, length, .9, SHAPES.grunt,
          [[0, pitch * .92], [length * .2, pitch * 1.18], [length * .55, pitch * 1.02], [length, pitch * .74]]);
        noise(voice, throat, start, length * .95, .55, SHAPES.grunt, rand(.9, 1.1));
        if (severity > .55) {
          const winded = tract(voice, FORMANTS.exhale, start + length * .9, .55, .9);
          noise(voice, winded, start + length * .9, .5, .45 * severity, SHAPES.exhale);
        }
      });
      if (id !== null) pushBreath(voices.get(id).endsAt + .12, true);
      return id;
    }
    function land(impact) {
      const value = numeric(impact);
      if (!Number.isFinite(value) || value <= .02) return null;
      const k = clamp(value, 0, 1);
      return oneShot('land', .14 + .26 * k, (voice, start) => {
        const body = filter(voice, voice.out, 'lowpass', 420, .8);
        tone(voice, body, 'sine', start, 0, .35, strike(.004, .16 + .1 * k), [[0, 92], [.13, 41]]);
        noise(voice, body, start, 0, .25, strike(.003, .1), .6);
        noise(voice, filter(voice, voice.out, 'bandpass', 3200, .8), start + .01, 0, .12 * k, strike(.01, .06), 1);
        if (k > .3) {
          const length = .12 + .1 * k, pitch = rand(112, 128);
          const throat = tract(voice, FORMANTS.grunt, start + .03, length, .92);
          tone(voice, throat, glottal(), start + .03, length, .9 * k, SHAPES.grunt, [[0, pitch], [length, pitch * .8]]);
          noise(voice, throat, start + .03, length, .4 * k, SHAPES.grunt, .9);
        }
      });
    }
    function surge(intensity = 1) {
      const value = numeric(intensity);
      if (!Number.isFinite(value) || value <= 0) return null;
      const k = clamp(value, 0, 1), soft = !input.effects;
      return oneShot('surge', (.12 + .18 * k) * (soft ? .5 : 1), (voice, start) => {
        const length = .45 + .9 * k, mains = 60 * rand(.995, 1.005);
        // Transformer buzz: mains saw plus its square second harmonic, swelling and fluttering.
        const buzz = filter(voice, voice.out, 'highpass', 90, .7);
        tone(voice, buzz, 'sawtooth', start, length, .5, roughen(SHAPES.swell),
          [[0, mains], [length * .3, mains * 1.01], [length, mains * .985]]);
        if (!soft) tone(voice, buzz, 'square', start + .02, length * .9, .14, roughen(SHAPES.swell), [[0, mains * 2]]);
        if (!soft) {
          const zap = filter(voice, voice.out, 'bandpass', 1800, 1);
          tone(voice, zap, 'sawtooth', start, 0, .2 * k, strike(.001, .07), [[0, 2600], [.07, 240]]);
        }
        crackle(voice, filter(voice, voice.out, 'highpass', 2800, .7), start, length,
          Math.round((4 + 14 * k) * (soft ? .5 : 1)), soft ? .35 : .7);
      });
    }
    const KITS = {
      chase(voice, start, soft) {
        const swell = soft ? .28 : .34, stab = start + swell;
        // Reverse swell sucked into the stab.
        const rush = filter(voice, voice.out, 'bandpass', 300, 1.4);
        glide(rush.frequency, start, [[0, 300], [swell, soft ? 1400 : 2400]]);
        noise(voice, rush, start, swell + .01, .5, SHAPES.rise, 1);
        if (!soft) {
          const pull = filter(voice, voice.out, 'lowpass', 400, 1);
          glide(pull.frequency, start, [[0, 400], [swell, 3000]]);
          for (const frequency of [146.83, 155.56, 220]) {
            tone(voice, pull, 'sawtooth', start, swell + .01, .1, SHAPES.rise, [[0, frequency * .94], [swell, frequency]]);
          }
        }
        const cutoff = soft ? 2200 : 5200, bite = filter(voice, voice.out, 'lowpass', cutoff, 1.2);
        glide(bite.frequency, stab, [[0, cutoff], [1.2, 700]]);
        for (const frequency of [146.83, 155.56, 207.65, 220, 311.13]) {
          const pitch = frequency * Math.pow(2, rand(-4, 4) / 1200);
          tone(voice, bite, 'sawtooth', stab, 0, .1, strike(.006, 1.5), [[0, pitch], [1.5, pitch * .97]]);
        }
        tone(voice, voice.out, 'sine', stab, 0, .55, strike(.005, 1.2), [[0, 62], [.9, 31]]);
        noise(voice, filter(voice, voice.out, 'lowpass', 1800, .7), stab, 0, .35, strike(.003, .25), .8);
      },
      kill(voice, start, soft, ratio) {
        // Punch, tick, bell-like double tink and a short whoosh: the confirm should feel good.
        tone(voice, voice.out, 'sine', start, 0, .55, strike(.002, .2), [[0, 150], [.11, 48]]);
        noise(voice, filter(voice, voice.out, 'highpass', 2500, .7), start, 0, .25, strike(.001, .025), 1.2);
        const f = 1568 * ratio;
        [[0, 1], [.035, 1.5]].forEach(([delay, interval], index) => {
          [[1, .14, .35], [2.76, .07, .2], [5.4, .035, .12]].forEach(([partial, level, decay]) => {
            tone(voice, voice.out, 'sine', start + .012 + delay, 0, level * (index ? .7 : 1), strike(.001, decay),
              [[0, f * interval * partial * rand(.997, 1.003)]]);
          });
        });
        const air = filter(voice, voice.out, 'bandpass', 2600, 1.4);
        glide(air.frequency, start, [[0, 2600], [.2, 700]]);
        noise(voice, air, start, .23, .12, [[.12, 1], [.45, .5], [1, 0]], 1);
      },
      headshot(voice, start, soft, ratio) {
        KITS.kill(voice, start, soft, ratio);
        noise(voice, filter(voice, voice.out, 'highpass', 4000, .7), start, 0, .3, strike(.001, .008), 1.3);
        for (const [partial, level] of [[1, .12], [2, .045]]) {
          tone(voice, voice.out, 'sine', start + .05, 0, level, strike(.001, .55), [[0, 2637 * ratio * partial], [.55, 2637 * ratio * partial * 1.004]]);
        }
      },
      streak(voice, start, soft) {
        const rise = .62, at = start + rise;
        const sweep = filter(voice, voice.out, 'bandpass', 500, 2.5);
        glide(sweep.frequency, start, [[0, 500], [rise, 7000]]);
        noise(voice, sweep, start, rise + .01, .45, SHAPES.rise, 1);
        tone(voice, filter(voice, voice.out, 'lowpass', 2000, .8), 'sawtooth', start, rise + .01, .12, SHAPES.rise,
          [[0, 110], [rise, 880]]);
        tone(voice, voice.out, 'sine', at, 0, .55, strike(.004, .8), [[0, 70], [.8, 34]]);
        const chord = filter(voice, voice.out, 'lowpass', 3000, .7);
        glide(chord.frequency, at, [[0, 3000], [1.3, 900]]);
        for (const frequency of [110, 164.81, 220, 277.18, 329.63]) {
          tone(voice, chord, 'sawtooth', at, 0, .07, strike(.008, 1.3), [[0, frequency]]);
        }
        noise(voice, filter(voice, voice.out, 'highpass', 3000, .7), at, 0, soft ? .1 : .22, strike(.003, .9), 1);
        for (const [frequency, level] of [[1760, .08], [2640, .05]]) {
          tone(voice, voice.out, 'sine', at + .01, 0, level, strike(.002, .8), [[0, frequency]]);
        }
      },
      fuse(voice, start, soft) {
        tone(voice, voice.out, 'sine', start, 0, .5, strike(.003, .14), [[0, 95], [.14, 45]]);
        noise(voice, filter(voice, voice.out, 'bandpass', 700, 2), start, 0, .35, strike(.003, .12), .9);
        tone(voice, voice.out, 'triangle', start, 0, .08, strike(.002, .1), [[0, 420]]);
        tone(voice, filter(voice, voice.out, 'bandpass', 1500, 1), 'sawtooth', start + .03, .15, .1, SHAPES.grunt, [[0, 100]]);
        const power = start + .12;
        tone(voice, voice.out, 'sine', power, .95, .12, SHAPES.hold, [[0, 196], [.9, 784]]);
        tone(voice, voice.out, 'triangle', power, .95, .05, SHAPES.hold, [[0, 392], [.9, 1568]]);
        for (const [frequency, level] of [[1568, .1], [2352, .06]]) {
          tone(voice, voice.out, 'sine', start + 1, 0, level, strike(.002, .6), [[0, frequency]]);
        }
        crackle(voice, filter(voice, voice.out, 'highpass', 3000, .7), start, .5, soft ? 3 : 6, .5);
      },
      pickup(voice, start) {
        [[0, 1320], [.075, 1760]].forEach(([delay, frequency]) => {
          tone(voice, voice.out, 'sine', start + delay, 0, .36, strike(.001, .16), [[0, frequency]]);
          tone(voice, voice.out, 'sine', start + delay, 0, .15, strike(.001, .08), [[0, frequency * 2.76]]);
        });
        noise(voice, filter(voice, voice.out, 'highpass', 3500, .7), start, 0, .36, strike(.001, .015), 1);
      },
      scare(voice, start, soft) {
        const low = filter(voice, voice.out, 'lowpass', soft ? 600 : 900, .9);
        for (const frequency of [73.42, 77.78, 110]) tone(voice, low, 'sawtooth', start, 0, .16, strike(.005, 1.2), [[0, frequency], [1.2, frequency * .96]]);
        tone(voice, voice.out, 'sine', start, 0, .6, strike(.004, 1), [[0, 58], [1, 28]]);
        if (soft) {
          noise(voice, filter(voice, voice.out, 'lowpass', 1200, .7), start, 0, .2, strike(.004, .4), .8);
          return;
        }
        const high = filter(voice, voice.out, 'lowpass', 6000, .7);
        for (const frequency of [739.99, 783.99, 1046.5, 1108.73]) {
          tone(voice, high, 'sawtooth', start, 0, .07, strike(.004, .9), [[0, frequency], [.9, frequency * .985]]);
        }
        noise(voice, filter(voice, voice.out, 'bandpass', 2200, .7), start, 0, .4, strike(.002, .5), 1);
        tone(voice, filter(voice, voice.out, 'bandpass', 2500, 3), 'sawtooth', start + .02, .8, .15, SHAPES.grunt,
          [[0, 1800], [.2, 1500], [.45, 1650], [.8, 600]]);
      }
    };
    const LEVELS = { chase: [.36, .55], kill: [.3, .8], headshot: [.34, .8], streak: [.36, .8], fuse: [.34, .8],
      pickup: [.24, 1], scare: [.5, .35] };
    function stinger(kind) {
      if (typeof kind !== 'string' || !STINGERS.includes(kind)) return null;
      const soft = !input.effects, [level, softened] = LEVELS[kind], now = context.currentTime;
      const confirm = kind === 'kill' || kind === 'headshot';
      // Quick multi-kills climb a pentatonic ladder.
      const step = confirm && now - combo.at < 2.5 ? Math.min(combo.step + 1, LADDER.length - 1) : 0;
      const ratio = Math.pow(2, LADDER[step] / 12);
      const id = oneShot(kind, level * (soft ? softened : 1), (voice, start) => KITS[kind](voice, start, soft, ratio));
      if (id !== null && confirm) { combo.step = step; combo.at = now; }
      if (id !== null && kind === 'chase' && live) music.intensity = Math.max(music.intensity, .5);
      return id;
    }
    function stop() {
      live = false;
      breath.nextAt = heart.nextAt = 0; breath.inhale = true;
      music.intensity = music.target = music.level = 0;
      combo.step = 0; combo.at = -Infinity;
      if (!bus && !voices.size && !bed) return;
      // A closed or suspended context renders nothing, so its graph can be dropped at once.
      const now = context.currentTime, closed = inactive();
      const groups = [...voices.values(), ...Array.from(retiring).filter(old => closed || old.kind !== 'stop')];
      if (bed) groups.push(bed);
      voices.clear(); bed = null;
      for (const old of groups) retiring.delete(old);
      const fading = bus, group = { id: 0, kind: 'stop', sources: new Set(), nodes: new Set(fading ? fading.nodes : []),
        endsAt: now + FADE, closed: false };
      bus = null;
      if (closed) {
        for (const old of groups) release(old, true);
        for (const old of Array.from(retiring)) release(old, true);
        release(group, false);
        return;
      }
      // Fade the whole mix over a few milliseconds, then let the audio clock end every source.
      if (fading) {
        fading.mix.gain.setValueAtTime(fading.mix.gain.value, now);
        fading.mix.gain.linearRampToValueAtTime(0, now + FADE);
      }
      for (const old of groups) {
        old.closed = true;
        for (const node of old.nodes) group.nodes.add(node);
        for (const source of old.sources) {
          watch(group, source);
          try { source.stop(now + FADE); } catch (error) { /* Already stopped. */ }
        }
        old.sources.clear(); old.nodes.clear();
      }
      retiring.add(group);
      if (!group.sources.size && !fading) release(group, false);
    }
    function snapshot() {
      if (!inactive()) prune();
      const on = live && !inactive();
      return {
        breathing: { rate: breath.rate, level: on ? breath.level : 0, exhausted: on && breath.ragged },
        heart: { bpm: heart.bpm, level: on ? heart.level : 0 },
        music: { level: bed ? music.level : 0, intensity: music.intensity },
        activeVoices: voices.size, maxVoices: MAX_VOICES,
        voices: Array.from(voices.values(), voice => ({ id: voice.id, kind: voice.kind, priority: voice.priority,
          level: voice.level, startedAt: voice.startedAt, endsAt: voice.endsAt }))
      };
    }
    return Object.freeze({ update, gasp, hurt, stinger, surge, land, stop, snapshot });
  }
  return Object.freeze({ create });
});
