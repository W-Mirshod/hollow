/* Finite creature cues only. The caller owns enemy timing, listener updates and
   effects-off gating; this module never invents positions or starts ambience. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else if (typeof define === 'function' && define.amd) define([], factory);
  else root.HollowAudio = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_VOICES = 8;
  const KINDS = {
    warden: { pitch: 48, formants: [190, 510], air: 620, claw: 1250, breath: 1.65, balance: 1 },
    stalker: { pitch: 94, formants: [430, 1380], air: 1850, claw: 2900, breath: 1.2, balance: .7 },
    crawler: { pitch: 132, formants: [680, 1950], air: 2600, claw: 4200, breath: .85, balance: .8 },
    shrieker: { pitch: 285, formants: [1080, 2920], air: 3200, claw: 2150, breath: 1.4, balance: .85 }
  };
  const CUES = {
    breath: { gain: .12, priority: 0 },
    step: { gain: .19, priority: 1 },
    notice: { gain: .36, priority: 2 },
    attack: { gain: .42, priority: 3 },
    death: { gain: .32, priority: 3 }
  };
  // Uneven openings/closures replace steady buzzes and metronomic tremolo.
  const ENVELOPES = {
    breath: [[.17, .24], [.36, 1], [.51, .23], [.68, .66], [.87, .12], [1, 0]],
    whisper: [[.2, .52], [.34, 1], [.48, .08], [.7, .56], [1, 0]],
    throat: [[.09, 1], [.21, .25], [.34, .78], [.49, .12], [.63, .65], [.81, .22], [1, 0]],
    wail: [[.12, .14], [.29, .72], [.44, .48], [.64, 1], [.83, .36], [1, 0]],
    hit: [[.06, 1], [.23, .4], [.62, .12], [1, 0]],
    scrape: [[.12, .6], [.28, .23], [.48, 1], [.69, .28], [.83, .43], [1, 0]],
    collapse: [[.08, 1], [.31, .5], [.52, .61], [.74, .16], [1, 0]]
  };
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const random = (min, max) => min + Math.random() * (max - min);
  const owns = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

  function create({ context, output, noiseBuffer } = {}) {
    const methods = ['createGain', 'createBufferSource', 'createOscillator', 'createPeriodicWave',
      'createBiquadFilter', 'createPanner', 'createDynamicsCompressor', 'createWaveShaper'];
    if (!context || methods.some(method => typeof context[method] !== 'function') ||
        !Number.isFinite(context.currentTime) || !Number.isFinite(context.sampleRate) || context.sampleRate <= 0 ||
        !output || !output.gain || typeof output.connect !== 'function' ||
        (output.context && output.context !== context) ||
        !noiseBuffer || !Number.isFinite(noiseBuffer.duration) || noiseBuffer.duration <= 0) {
      throw new TypeError('HollowAudio needs an AudioContext, its master GainNode and a nonempty noise AudioBuffer');
    }

    const voices = new Map();
    let nextId = 1, bus = null, glottalWave = null;
    const cutoff = value => clamp(value, 20, context.sampleRate * .45);

    function connectBus() {
      if (bus) return;
      const highpass = context.createBiquadFilter(), headroom = context.createGain();
      const compressor = context.createDynamicsCompressor(), limiter = context.createWaveShaper();
      highpass.type = 'highpass'; highpass.frequency.value = 24; highpass.Q.value = .7;
      headroom.gain.value = .7;
      compressor.threshold.value = -18; compressor.knee.value = 18; compressor.ratio.value = 8;
      compressor.attack.value = .004; compressor.release.value = .18;
      const curve = new Float32Array(1025);
      for (let index = 0; index < curve.length; index++) {
        const value = index * 2 / (curve.length - 1) - 1;
        curve[index] = .7 * Math.tanh(value / .7);
      }
      limiter.curve = curve; limiter.oversample = '2x';
      highpass.connect(headroom); headroom.connect(compressor); compressor.connect(limiter); limiter.connect(output);
      bus = { input: highpass, nodes: [highpass, headroom, compressor, limiter] };
    }
    function disconnectBus() {
      if (!bus) return;
      for (const node of bus.nodes) node.disconnect();
      bus = null;
    }
    function release(voice, cancel) {
      if (voice.closed) return;
      voice.closed = true;
      for (const source of voice.sources) {
        source.onended = null;
        if (cancel) {
          // The audio thread can finish before its ended event reaches JavaScript.
          try { source.stop(context.currentTime); } catch (error) { /* Already ended. */ }
        }
      }
      for (const node of voice.nodes) node.disconnect();
      voice.sources.clear(); voice.nodes.clear(); voices.delete(voice.id);
      if (!voices.size) disconnectBus();
    }
    function prune() {
      for (const voice of voices.values()) {
        if (voice.endsAt <= context.currentTime) release(voice, true);
      }
    }
    function wave() {
      if (!glottalWave) {
        const real = new Float32Array(24), imaginary = new Float32Array(24);
        // A soft, harmonic-rich glottal excitation, always heard through formants.
        for (let harmonic = 1; harmonic < imaginary.length; harmonic++) imaginary[harmonic] = 1 / Math.pow(harmonic, 1.35);
        glottalWave = context.createPeriodicWave(real, imaginary);
      }
      return glottalWave;
    }

    function build(voice) {
      const profile = KINDS[voice.kind], color = random(.94, 1.06), pace = random(.93, 1.08);
      const node = value => { voice.nodes.add(value); return value; };
      const gain = node(context.createGain()), wall = node(context.createBiquadFilter()), panner = node(context.createPanner());
      gain.gain.value = voice.gain;
      wall.type = 'lowpass'; wall.frequency.value = voice.lowpass; wall.Q.value = .7;
      panner.panningModel = 'HRTF'; panner.distanceModel = 'exponential';
      panner.refDistance = voice.cue === 'breath' ? 1.4 : 2.2;
      panner.rolloffFactor = voice.cue === 'breath' ? 1.65 : 1.3;
      panner.maxDistance = 60;
      const { x, y, z } = voice.position;
      if (panner.positionX) {
        panner.positionX.setValueAtTime(x, voice.startedAt);
        panner.positionY.setValueAtTime(y, voice.startedAt);
        panner.positionZ.setValueAtTime(z, voice.startedAt);
      } else panner.setPosition(x, y, z);
      gain.connect(wall); wall.connect(panner); panner.connect(bus.input);

      function envelope(start, duration, level, shape, bands = 1) {
        const layer = node(context.createGain());
        layer.gain.setValueAtTime(0, start);
        for (const [phase, amount] of ENVELOPES[shape]) {
          layer.gain.linearRampToValueAtTime(level * amount / bands, start + duration * phase);
        }
        layer.connect(gain);
        return layer;
      }
      function formants(source, destination, bands, q, start, duration, end) {
        for (const frequency of bands) {
          const filter = node(context.createBiquadFilter());
          filter.type = 'bandpass'; filter.Q.value = q;
          const base = frequency * color;
          filter.frequency.setValueAtTime(cutoff(base), start);
          filter.frequency.exponentialRampToValueAtTime(cutoff(base * random(1.03, 1.15)), start + duration * .27);
          filter.frequency.exponentialRampToValueAtTime(cutoff(base * random(.8, .94)), start + duration * .61);
          filter.frequency.exponentialRampToValueAtTime(cutoff(base * end), start + duration);
          source.connect(filter); filter.connect(destination);
        }
      }
      function schedule(source, start, duration, offset) {
        voice.sources.add(source); voice.layers++;
        const end = start + duration;
        voice.endsAt = Math.max(voice.endsAt, end);
        source.onended = () => {
          if (voice.closed) return;
          source.onended = null; source.disconnect();
          voice.sources.delete(source); voice.nodes.delete(source);
          if (!voice.sources.size) release(voice, false);
        };
        if (offset === undefined) source.start(start);
        else source.start(start, offset);
        source.stop(end);
      }
      function noise(delay, length, level, bands, shape = 'breath', q = .8, end = .72) {
        const source = node(context.createBufferSource()), rate = random(.82, 1.18);
        source.buffer = noiseBuffer; source.loop = false; source.playbackRate.value = rate;
        const available = noiseBuffer.duration / rate;
        const duration = Math.min(length * pace, available * .9), tail = Math.min(.015, available - duration);
        const start = voice.startedAt + delay * pace;
        const layer = envelope(start, duration, level, shape, bands.length);
        formants(source, layer, bands, q, start, duration, end);
        // Fit even a short supplied buffer; never loop it or read past its end.
        const offset = random(0, Math.max(0, noiseBuffer.duration - (duration + tail) * rate));
        schedule(source, start, duration + tail, offset);
      }
      function tone(delay, length, level, pitch, bands, shape, end = .78, crest = 1.12) {
        const source = node(context.createOscillator());
        const start = voice.startedAt + delay * pace, duration = length * pace, base = pitch * color;
        if (bands.length) source.setPeriodicWave(wave());
        else source.type = 'sine';
        source.frequency.setValueAtTime(cutoff(base), start);
        source.frequency.exponentialRampToValueAtTime(cutoff(base * random(.95, 1.04)), start + duration * .16);
        source.frequency.exponentialRampToValueAtTime(cutoff(base * crest), start + duration * .43);
        source.frequency.exponentialRampToValueAtTime(cutoff(base * crest * .91), start + duration * .67);
        source.frequency.exponentialRampToValueAtTime(cutoff(base * end), start + duration);
        const layer = envelope(start, duration, level, shape, Math.max(1, bands.length));
        if (bands.length) formants(source, layer, bands, 2.4, start, duration, end);
        else source.connect(layer);
        schedule(source, start, duration + .015);
      }
      function throat(delay, duration, level, shape = 'throat', end = .74) {
        noise(delay, duration, level, profile.formants, shape, 1.5, end);
        tone(delay + .012, duration * .94, level * .55, profile.pitch, profile.formants, shape, end,
          voice.kind === 'shrieker' ? 1.48 : 1.12);
        if (voice.kind === 'shrieker') {
          tone(delay + .047, duration * .9, level * .28, profile.pitch * 1.067,
            profile.formants.map(value => value * 1.17), shape, end * .93, 1.36);
          tone(delay + .083, duration * .82, level * .16, profile.pitch * 1.414,
            profile.formants, shape, end, 1.19);
        }
      }
      function claws(delay, count, level) {
        let at = delay;
        for (let index = 0; index < count; index++) {
          noise(at, random(.025, .064), level * random(.5, 1), [profile.claw * random(.83, 1.2)], 'hit', 1.3, .63);
          at += random(.045, .13);
        }
        noise(delay + .03, count * .08 + .12, level * .42, [profile.claw * .55, profile.claw], 'scrape', .9, .6);
      }
      function thump(delay, level) {
        const heavy = voice.kind === 'warden';
        noise(delay, heavy ? .35 : .21, level, [heavy ? 110 : 240, heavy ? 280 : 560], 'hit', .75, .62);
        tone(delay, heavy ? .4 : .23, level * .7, heavy ? 58 : 83, [], 'hit', .66, .92);
      }

      if (voice.cue === 'breath') {
        noise(0, profile.breath, .78, [profile.air], 'breath', .65, .62);
        const grains = voice.kind === 'stalker' || voice.kind === 'crawler' ? 5 : 3;
        for (let index = 0; index < grains; index++) {
          const at = profile.breath * (.12 + index * .14) + random(0, .045);
          noise(at, random(.065, .16), random(.32, .56), [profile.air * random(.65, 1.15)], 'whisper', 1.4, .8);
        }
        if (voice.kind === 'warden') {
          tone(.13, profile.breath * .72, .24, profile.pitch, profile.formants, 'throat', .85, 1.04);
          tone(.2, profile.breath * .6, .12, 37, [], 'breath', .92, 1.02);
        } else if (voice.kind === 'crawler') claws(.24, 2, .2);
        else if (voice.kind === 'shrieker') noise(.16, profile.breath * .7, .34, profile.formants, 'whisper', 2, .86);
      } else if (voice.cue === 'step') {
        if (voice.kind === 'warden') {
          thump(0, .78);
          throat(.045, .5, .27);
          noise(.06, .24, .25, [800], 'scrape');
        } else if (voice.kind === 'crawler') claws(0, 4, .65);
        else {
          noise(0, .2, .62, [voice.kind === 'stalker' ? 340 : 620], 'hit');
          claws(.035, 1, voice.kind === 'stalker' ? .25 : .38);
        }
      } else if (voice.cue === 'notice') {
        noise(0, .28, .6, [profile.air], 'breath');
        const duration = voice.kind === 'shrieker' ? 1.9 : voice.kind === 'warden' ? 1.3 : voice.kind === 'crawler' ? .65 : .95;
        throat(.13, duration, .8, voice.kind === 'shrieker' ? 'wail' : 'throat');
        if (voice.kind === 'warden') thump(.08, .34);
        else if (voice.kind === 'crawler') claws(.08, 3, .42);
        else if (voice.kind === 'stalker') noise(.63, .34, .5, [profile.air * 1.2], 'whisper', 1.2);
      } else if (voice.cue === 'attack') {
        noise(0, .13, .7, [profile.air], 'whisper');
        throat(.035, voice.kind === 'shrieker' ? 1.05 : .68, .95, 'throat', .63);
        claws(.12, voice.kind === 'crawler' ? 4 : 2, .5);
        if (voice.kind === 'warden') thump(.055, .55);
      } else if (voice.cue === 'death') {
        throat(0, voice.kind === 'warden' ? 1.5 : 1.2, .75, 'collapse', .4);
        thump(voice.kind === 'warden' ? .56 : .4, .75);
        claws(.48, 3, .4);
        noise(.72, .78, .4, [profile.air * .6], 'breath', .7, .42);
      }
    }

    // Returns a voice id, or null for a muted/invalid cue, inactive realtime context
    // or full higher-priority mix. Positions are world-space, fixed per one-shot.
    function play(kind, cue, { x = 0, y = 0, z = 0, occluded = false, volume = 1 } = {}) {
      // Offline contexts start suspended; realtime cues must not queue for resume.
      const inactive = context.state === 'closed' || context.state === 'interrupted' ||
        (context.state === 'suspended' && typeof context.startRendering !== 'function');
      if (typeof kind !== 'string' || typeof cue !== 'string' || !owns(KINDS, kind) || !owns(CUES, cue) ||
          ![x, y, z, volume].every(Number.isFinite) ||
          !(typeof occluded === 'boolean' || Number.isFinite(occluded)) || volume <= 0 || inactive) return null;
      prune();
      const definition = CUES[cue], obstruction = clamp(Number(occluded), 0, 1);
      if (voices.size >= MAX_VOICES) {
        let oldest = null;
        for (const candidate of voices.values()) {
          if (!oldest || candidate.priority < oldest.priority) oldest = candidate;
        }
        // Quiet movement must not steal an attack/death cue. Ties retire the oldest.
        if (oldest.priority > definition.priority) return null;
        release(oldest, true);
      }
      connectBus();
      const voice = {
        id: nextId++, kind, cue, position: { x, y, z }, occluded: obstruction,
        volume: clamp(volume, 0, 1), priority: definition.priority,
        gain: definition.gain * KINDS[kind].balance * clamp(volume, 0, 1) * (1 - .72 * obstruction),
        lowpass: cutoff(10000 * Math.pow(.075, obstruction)),
        startedAt: context.currentTime + .008, endsAt: context.currentTime + .008,
        sources: new Set(), nodes: new Set(), layers: 0, closed: false
      };
      voices.set(voice.id, voice);
      try { build(voice); }
      catch (error) { release(voice, true); throw error; }
      return voice.id;
    }
    function stop() {
      for (const voice of voices.values()) release(voice, true);
      disconnectBus();
    }
    function snapshot() {
      prune();
      return {
        activeVoices: voices.size, maxVoices: MAX_VOICES,
        activeSources: Array.from(voices.values()).reduce((sum, voice) => sum + voice.sources.size, 0),
        voices: Array.from(voices.values(), voice => ({
          id: voice.id, kind: voice.kind, cue: voice.cue, position: { ...voice.position },
          occluded: voice.occluded, volume: voice.volume, gain: voice.gain, lowpass: voice.lowpass,
          startedAt: voice.startedAt, endsAt: voice.endsAt, layers: voice.layers, sources: voice.sources.size
        }))
      };
    }
    return Object.freeze({ play, stop, snapshot });
  }
  return Object.freeze({ create });
});
