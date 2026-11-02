/* Finite creature cues only. The caller owns enemy timing, listener updates and
   effects-off gating; this module never invents positions or starts ambience. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else if (typeof define === 'function' && define.amd) define([], factory);
  else root.HollowAudio = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_VOICES = 8;
  // `tract` scales the neutral vowel formants below: a long throat sounds lower and larger.
  const KINDS = {
    warden: { pitch: 48, formants: [190, 510], air: 620, claw: 1250, breath: 1.65, balance: 1, tract: .7 },
    stalker: { pitch: 94, formants: [430, 1380], air: 1850, claw: 2900, breath: 1.2, balance: .7, tract: .96 },
    crawler: { pitch: 132, formants: [680, 1950], air: 2600, claw: 4200, breath: .85, balance: .8, tract: 1.16 },
    shrieker: { pitch: 285, formants: [1080, 2920], air: 3200, claw: 2150, breath: 1.4, balance: .85, tract: 1.3 }
  };
  // Priority tiers: breath < steps < ambient voices < engagement < violence. Ties retire the oldest.
  // `ref`/`rolloff` shape distance: whispers stay intimate, moans and screams carry down corridors.
  const CUES = {
    breath: { gain: .12, priority: 0, ref: 1.4, rolloff: 1.65 },
    step: { gain: .19, priority: 1, ref: 2.2, rolloff: 1.3 },
    notice: { gain: .36, priority: 3, ref: 2.2, rolloff: 1.3 },
    attack: { gain: .42, priority: 4, ref: 2.2, rolloff: 1.3 },
    death: { gain: .32, priority: 4, ref: 2.2, rolloff: 1.3 },
    whisper: { gain: .22, priority: 2, ref: 1, rolloff: 1.5 },
    moan: { gain: .27, priority: 2, ref: 2.8, rolloff: 1.1 },
    growl: { gain: .34, priority: 3, ref: 2.2, rolloff: 1.25 },
    laugh: { gain: .3, priority: 3, ref: 1.8, rolloff: 1.35 },
    scream: { gain: .46, priority: 4, ref: 3.2, rolloff: 1 }
  };
  // Uneven openings/closures replace steady buzzes and metronomic tremolo.
  const ENVELOPES = {
    breath: [[.17, .24], [.36, 1], [.51, .23], [.68, .66], [.87, .12], [1, 0]],
    whisper: [[.2, .52], [.34, 1], [.48, .08], [.7, .56], [1, 0]],
    throat: [[.09, 1], [.21, .25], [.34, .78], [.49, .12], [.63, .65], [.81, .22], [1, 0]],
    wail: [[.12, .14], [.29, .72], [.44, .48], [.64, 1], [.83, .36], [1, 0]],
    hit: [[.06, 1], [.23, .4], [.62, .12], [1, 0]],
    scrape: [[.12, .6], [.28, .23], [.48, 1], [.69, .28], [.83, .43], [1, 0]],
    collapse: [[.08, 1], [.31, .5], [.52, .61], [.74, .16], [1, 0]],
    // A reversed swell: a slow ingressive rise that is cut off rather than released.
    swell: [[.3, .05], [.55, .18], [.76, .46], [.92, 1], [.965, .3], [1, 0]],
    exhale: [[.06, 1], [.18, .5], [.45, .32], [.7, .4], [.9, .14], [1, 0]],
    hiss: [[.12, .45], [.3, .9], [.52, .6], [.78, 1], [1, 0]],
    moan: [[.16, .42], [.3, .8], [.44, .6], [.6, 1], [.76, .68], [.9, .3], [1, 0]],
    roughen: [[.18, .2], [.38, .72], [.58, 1], [.8, .55], [1, 0]],
    growl: [[.05, .7], [.14, 1], [.3, .8], [.5, .95], [.7, .74], [.86, .5], [1, 0]],
    stutter: [[.04, 1], [.17, .72], [.23, .08], [.3, .92], [.49, .76], [.55, .1], [.62, .86], [.85, .45], [1, 0]],
    scream: [[.04, .55], [.12, 1], [.35, .84], [.55, .96], [.75, .7], [.9, .33], [1, 0]]
  };
  // F1–F3 of a neutral throat; formant paths interpolate between these targets.
  const VOWELS = {
    u: [310, 870, 2250], o: [460, 880, 2550], a: [700, 1220, 2600],
    e: [460, 1890, 2550], i: [280, 2250, 2900], uh: [520, 1450, 2500]
  };
  // [band (0 follows the vowel's F2), Q, min length, max length, level]; k/t are plosive bursts.
  const FRICATIVES = {
    s: [6300, 3, .07, .12, .7], sh: [2900, 1.7, .08, .14, .85], f: [4600, .8, .06, .1, .35],
    h: [0, .9, .05, .09, .45], k: [2300, 1.3, .02, .035, 1], t: [3900, 1.1, .015, .03, .9]
  };
  const WHISPERS = {
    warden: { trim: 1.2, count: [3, 5], span: [1.3, 1.62], vowels: ['u', 'o', 'a', 'uh'], letters: ['h', 'h', 'sh', 'k', 'f'], consonants: .6 },
    stalker: { trim: 1.2, count: [6, 8], span: [1.2, 1.58], vowels: ['a', 'e', 'i', 'o', 'u', 'uh'], letters: ['s', 'sh', 'h', 'k', 't', 'f', 's'], consonants: .75 },
    crawler: { trim: 1, count: [6, 9], span: [1.15, 1.42], vowels: ['i', 'e', 'e', 'uh'], letters: ['s', 's', 't', 'k', 'sh'], consonants: .9 },
    shrieker: { trim: 1.3, count: [4, 6], span: [1.15, 1.45], vowels: ['i', 'a', 'e', 'uh'], letters: ['h', 'sh', 's', 'h', 'f'], consonants: .65 }
  };
  const MOANS = {
    warden: { trim: 2.5, span: [2.2, 2.68], path: [[0, 'u'], [.3, 'o'], [.56, 'a'], [1, 'u']], contour: [1, 1.06, .9, .74], sub: .5, ring: [31, 37], depth: .7, breath: .3 },
    stalker: { trim: 2.2, span: [1.9, 2.55], path: [[0, 'u'], [.45, 'a'], [1, 'u']], contour: [.97, 1.08, .95, .72], sub: .35, ratio: [.53, .6], depth: .5, breath: .35 },
    crawler: { trim: 2, span: [1.65, 2.1], path: [[0, 'e'], [.4, 'a'], [1, 'u']], contour: [1, 1.1, .85, .68], sub: .3, ring: [17, 24], depth: .65, breath: .3 },
    shrieker: { trim: 1, span: [2.1, 2.65], path: [[0, 'i'], [.42, 'a'], [1, 'u']], contour: [1, 1.12, .93, .66], sub: .55, ratio: [1.38, 1.45], depth: .45, breath: .25 }
  };
  const GROWLS = {
    warden: { trim: 2.15, span: [1.05, 1.22], pitch: .82, sub: .5, flutter: [25, 30], drive: 3, scale: .62, rasp: .45 },
    stalker: { trim: 1.85, span: [.8, 1.1], pitch: .78, sub: .35, flutter: [31, 38], drive: 4, scale: .85, rasp: .5 },
    crawler: { trim: 1.8, span: [.68, .88], pitch: .8, sub: 0, flutter: [38, 45], drive: 5, scale: 1, rasp: .6 },
    shrieker: { trim: 1.6, span: [.8, 1.12], pitch: .5, sub: 0, flutter: [34, 42], drive: 5, scale: 1.05, rasp: .45 }
  };
  const LAUGHS = {
    warden: { trim: 1.7, count: [4, 5], burst: [.13, .2], gap: [.09, .15], pitch: [1.3, 1.45], step: [.93, .97], vowels: ['o', 'uh', 'o', 'u'], breath: .55 },
    stalker: { trim: 1.23, count: [5, 7], burst: [.06, .11], gap: [.05, .1], pitch: [1.8, 2.05], step: [.93, .97], vowels: ['e', 'i', 'e', 'uh'], breath: .6 },
    crawler: { trim: 1.18, count: [6, 8], burst: [.04, .065], gap: [.04, .075], pitch: [1.55, 1.75], step: [.94, .97], vowels: ['i', 'e'], breath: .4 },
    shrieker: { trim: .43, count: [6, 8], burst: [.05, .085], gap: [.035, .07], pitch: [1.25, 1.4], step: [.92, .965], vowels: ['i', 'e', 'i'], breath: .45 }
  };
  const SCREAMS = {
    warden: { trim: 2.75, lead: 0, span: [1.3, 1.6], contour: [1, 1.45, 1.35, .9], layers: [[1, .8], [.5, .5], [1.02, .45]], path: ['o', 'a', 'e', 'a', 'o'], drive: 5, flutter: [28, 32], noise: .6 },
    stalker: { trim: 1.15, lead: 0, span: [1.15, 1.45], contour: [1.2, 2.3, 2.1, 1.4], layers: [[1, .75], [1.031, .55], [.5, .3]], path: ['uh', 'a', 'e', 'a', 'o'], drive: 4, noise: .55 },
    crawler: { trim: .54, lead: 0, span: [.9, 1.2], contour: [1.5, 2.8, 2.6, 1.8], layers: [[1, .75], [1.045, .55]], path: ['e', 'a', 'i', 'e', 'a'], drive: 6, flutter: [40, 45], noise: .65 },
    shrieker: { trim: .65, lead: .24, span: [1.6, 1.95], contour: [.85, 1.55, 1.45, 1.05], layers: [[1, .7], [1.067, .5], [1.414, .4]], path: ['u', 'a', 'i', 'a', 'u'], drive: 4, noise: .7 }
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
    const curves = new Map();
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
    // Biased tanh: throaty even harmonics, exactly silent at rest, bounded to [-1, 1].
    function distortion(drive) {
      if (!curves.has(drive)) {
        const curve = new Float32Array(1025), bias = .12, rest = Math.tanh(drive * bias);
        for (let index = 0; index < curve.length; index++) {
          curve[index] = Math.tanh(drive * (index * 2 / (curve.length - 1) - 1 + bias)) - rest;
        }
        const peak = Math.max(Math.abs(curve[0]), Math.abs(curve[curve.length - 1]));
        for (let index = 0; index < curve.length; index++) curve[index] /= peak;
        curves.set(drive, curve);
      }
      return curves.get(drive);
    }

    function build(voice) {
      const profile = KINDS[voice.kind], definition = CUES[voice.cue];
      const color = random(.94, 1.06), pace = random(.93, 1.08);
      const node = value => { voice.nodes.add(value); return value; };
      const gain = node(context.createGain()), wall = node(context.createBiquadFilter()), panner = node(context.createPanner());
      gain.gain.value = voice.gain;
      wall.type = 'lowpass'; wall.frequency.value = voice.lowpass; wall.Q.value = .7;
      panner.panningModel = 'HRTF'; panner.distanceModel = 'exponential';
      panner.refDistance = definition.ref; panner.rolloffFactor = definition.rolloff;
      panner.maxDistance = 60;
      const { x, y, z } = voice.position;
      if (panner.positionX) {
        panner.positionX.setValueAtTime(x, voice.startedAt);
        panner.positionY.setValueAtTime(y, voice.startedAt);
        panner.positionZ.setValueAtTime(z, voice.startedAt);
      } else panner.setPosition(x, y, z);
      gain.connect(wall); wall.connect(panner); panner.connect(bus.input);
      // Static makeup levels each synthesized vocal so the CUES table alone sets relative loudness.
      const vocal = { whisper: WHISPERS, moan: MOANS, growl: GROWLS, laugh: LAUGHS, scream: SCREAMS }[voice.cue];
      const mixdown = vocal ? vca(vocal[voice.kind].trim, gain) : gain;

      // One automated gain per source; `shape` is a named or generated [phase, amount] list.
      function envelope(start, duration, level, shape, bands = 1, destination = gain) {
        const layer = node(context.createGain());
        layer.gain.setValueAtTime(0, start);
        for (const [phase, amount] of typeof shape === 'string' ? ENVELOPES[shape] : shape) {
          layer.gain.linearRampToValueAtTime(level * amount / bands, start + duration * phase);
        }
        layer.connect(destination);
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

      // Exponential glide through [phase, hz, jump] points; a jump steps instead of sliding.
      function glide(param, start, duration, points) {
        points.forEach(([phase, value, jump], index) => {
          const time = start + duration * phase;
          if (!index || jump) param.setValueAtTime(cutoff(value), time);
          else param.exponentialRampToValueAtTime(cutoff(value), time);
        });
      }
      // Uneven, alternating deviations around a contour: jitter plus a drunken vibrato.
      function wobble(points, seconds, rate, depth) {
        const result = [];
        let sign = random(0, 1) < .5 ? -1 : 1;
        points.forEach(([phase, value, jump], index) => {
          result.push([phase, value, jump]);
          const next = points[index + 1];
          if (!next || !(rate * seconds > 0)) return;
          const target = next[2] ? value : next[1], step = 1 / (rate * seconds);
          for (let at = phase + step * random(.5, 1); at < next[0] - step * .3; at += step * random(.6, 1.4)) {
            sign = -sign;
            const mix = (at - phase) / (next[0] - phase);
            result.push([at, value * Math.pow(target / value, mix) * (1 + sign * depth * random(.3, 1))]);
          }
        });
        return result;
      }
      // Parallel F1–F3 resonators gliding through a vowel path; enveloped layers feed the input.
      function tract(duration, path, q, weights, scale = profile.tract, destination = mixdown) {
        const input = node(context.createGain());
        for (let band = 0; band < 3; band++) {
          const filter = node(context.createBiquadFilter()), weight = node(context.createGain());
          filter.type = 'bandpass'; filter.Q.value = q[band]; weight.gain.value = weights[band];
          glide(filter.frequency, voice.startedAt, duration * pace, path.map(([phase, vowel, jump]) =>
            [phase, VOWELS[vowel][band] * scale * color * random(.97, 1.03), jump]));
          input.connect(filter); filter.connect(weight); weight.connect(destination);
        }
        return input;
      }
      function voiced(delay, length, level, contour, destination, shape, rate = 8, depth = .018) {
        const source = node(context.createOscillator());
        const start = voice.startedAt + delay * pace, duration = length * pace;
        source.setPeriodicWave(wave());
        glide(source.frequency, start, duration,
          wobble(contour.map(([phase, value, jump]) => [phase, value * color, jump]), duration, rate, depth));
        const layer = envelope(start, duration, level, shape, 1, destination);
        source.connect(layer);
        schedule(source, start, duration + .015);
        return layer;
      }
      // A low oscillator whose enveloped depth is summed into another gain's AudioParam.
      function modulator(delay, length, level, contour, param, shape, glottal) {
        const source = node(context.createOscillator());
        const start = voice.startedAt + delay * pace, duration = length * pace;
        if (glottal) source.setPeriodicWave(wave());
        else source.type = 'sine';
        glide(source.frequency, start, duration, contour);
        source.connect(envelope(start, duration, level, shape, 1, param));
        schedule(source, start, duration + .015);
      }
      // Unfiltered noise into any destination; slows playback rather than looping a short buffer.
      function air(delay, length, level, destination, shape) {
        const source = node(context.createBufferSource());
        const rate = Math.max(.5, Math.min(random(.82, 1.18), noiseBuffer.duration * .9 / (length * pace)));
        source.buffer = noiseBuffer; source.loop = false; source.playbackRate.value = rate;
        const available = noiseBuffer.duration / rate;
        const duration = Math.min(length * pace, available * .9), tail = Math.min(.015, available - duration);
        const start = voice.startedAt + delay * pace;
        source.connect(envelope(start, duration, level, shape, 1, destination));
        schedule(source, start, duration + tail, random(0, Math.max(0, noiseBuffer.duration - (duration + tail) * rate)));
        return { start, duration };
      }
      function band(frequency, q, destination = mixdown) {
        const filter = node(context.createBiquadFilter());
        filter.type = 'bandpass'; filter.frequency.value = cutoff(frequency * color); filter.Q.value = q;
        filter.connect(destination);
        return filter;
      }
      // A static gain stage for amplitude/ring modulation: base 0 is a true ring modulator.
      function vca(base, destination) {
        const stage = node(context.createGain());
        stage.gain.value = base; stage.connect(destination);
        return stage;
      }
      function grit(drive, destination) {
        const shaper = node(context.createWaveShaper());
        shaper.curve = distortion(drive); shaper.oversample = '2x';
        shaper.connect(destination);
        return shaper;
      }
      // Wet droplet clicks: tiny sine chirps that rise as a bubble or tongue releases.
      function chirps(delay, length, count, level, low, high) {
        const source = node(context.createOscillator());
        const start = voice.startedAt + delay * pace, duration = length * pace, points = [], pitch = [];
        source.type = 'sine';
        for (let index = 0; index < count; index++) {
          const at = (index + random(.1, .75)) / count * .92, size = random(.012, .022) / length, hz = random(low, high);
          points.push([at, 0], [at + .002 / length, random(.55, 1)], [at + size, 0]);
          pitch.push([at, hz, true], [at + size, hz * random(1.6, 2.2)]);
        }
        points.push([1, 0]);
        glide(source.frequency, start, duration, pitch);
        source.connect(envelope(start, duration, level, points, 1, mixdown));
        schedule(source, start, duration + .015);
      }
      // Irregular syllables laid out to fill `span` seconds after `lead`, with an optional catch.
      function syllables(count, lead, span) {
        const list = [], broken = count > 4 ? Math.floor(random(2, count - 1)) : -1;
        let time = 0;
        for (let index = 0; index < count; index++) {
          const length = random(.08, .2) * (index === count - 1 ? 1.5 : 1);
          list.push({ start: time, length, stress: random(.45, 1), group: broken >= 0 && index > broken ? 1 : 0 });
          time += length + (index === broken ? random(.16, .28) : random(.02, .1));
        }
        const last = list[list.length - 1], scale = span / (last.start + last.length);
        for (const item of list) { item.start = lead + item.start * scale; item.length *= scale; }
        return list;
      }
      // Syllable-shaped amplitude for a layer spanning [from, from + length] seconds.
      function bumps(items, from, length, floor, tremble = 0) {
        const points = [], phase = time => clamp((time - from) / length, 0, 1);
        for (const { start, length: size, stress } of items) {
          points.push([phase(start), floor], [phase(start + size * .2), stress]);
          for (let at = start + size * .2 + tremble, low = true; tremble && at < start + size * .7; at += tremble, low = !low) {
            points.push([phase(at), stress * (low ? .45 : 1)]);
          }
          points.push([phase(start + size * .7), stress * random(.5, .85)], [phase(start + size), floor]);
        }
        points.push([1, 0]);
        return points;
      }
      const pick = list => list[Math.floor(random(0, list.length)) % list.length];
      const integer = ([low, high]) => Math.floor(random(low, high + 1 - 1e-9));

      // Breathy, unintelligible syllables: noise through moving vowel formants plus fricative bursts.
      function whisper() {
        const kind = voice.kind, setting = WHISPERS[kind], lead = .15, span = random(...setting.span);
        const items = syllables(integer(setting.count), lead, span), last = items[items.length - 1];
        let vowel = Math.floor(random(0, setting.vowels.length));
        for (const item of items) {
          vowel = (vowel + 1 + Math.floor(random(0, setting.vowels.length - 1))) % setting.vowels.length;
          item.vowel = setting.vowels[vowel];
        }
        const spoken = last.start + last.length + .05, path = [[0, items[0].vowel]];
        for (const item of items) {
          path.push([(item.start + item.length * .3) / spoken, item.vowel], [(item.start + item.length) / spoken, item.vowel]);
        }
        path.push([1, last.vowel]);
        const mouth = tract(spoken, path, [4, 6, 7], [.6, 1, .55]);
        for (const group of [0, 1]) {
          const members = items.filter(item => item.group === group);
          if (!members.length) continue;
          const from = members[0].start - .02, end = members[members.length - 1];
          const length = end.start + end.length + .04 - from;
          air(from, length, .9, mouth, bumps(members, from, length, .05, kind === 'shrieker' ? .055 : 0));
        }
        const marks = [];
        let free = 0;
        items.forEach((item, index) => {
          if (index && random(0, 1) > setting.consonants) return;
          const letter = pick(setting.letters), [hz, q, shortest, longest, level] = FRICATIVES[letter];
          const stop = item.start + .015, begin = Math.max(free + .005, stop - random(shortest, longest));
          if (stop - begin < .012) return;
          marks.push({ begin, stop, q, level, plosive: letter === 'k' || letter === 't',
            hz: hz ? hz * Math.sqrt(profile.tract) : VOWELS[item.vowel][1] * profile.tract });
          free = stop;
        });
        const from = marks[0].begin - .01, length = marks[marks.length - 1].stop + .01 - from;
        const phase = time => (time - from) / length, points = [];
        for (const mark of marks) {
          const size = mark.stop - mark.begin;
          points.push([phase(mark.begin), 0]);
          if (mark.plosive) points.push([phase(mark.begin + .003), mark.level], [phase(mark.begin + size * .5), mark.level * .35]);
          else points.push([phase(mark.begin + size * .3), mark.level], [phase(mark.begin + size * .75), mark.level * .8]);
          points.push([phase(mark.stop), 0]);
        }
        points.push([1, 0]);
        const sibilant = node(context.createBiquadFilter());
        sibilant.type = 'bandpass'; sibilant.connect(mixdown);
        const fricative = air(from, length, .8, sibilant, points), at = mark => fricative.start + fricative.duration * phase(mark.begin);
        glide(sibilant.frequency, fricative.start, fricative.duration, marks.map(mark => [phase(mark.begin), mark.hz * color, true]));
        for (const mark of marks) sibilant.Q.setValueAtTime(mark.q, at(mark));
        if (kind === 'warden' || kind === 'stalker') {
          // A voice leaking through the whisper: Warden mutters, the Stalker mumbles a few syllables aloud.
          const low = kind === 'warden', pitch = profile.pitch * (low ? random(.95, 1.1) : random(1.15, 1.35));
          const from = items[0].start - .02, length = spoken - from;
          const stresses = items.map(item => ({ ...item, stress: low ? item.stress * .8 : random(0, 1) < .4 ? item.stress : .12 }));
          voiced(from, length, low ? .42 : .22, [[0, pitch], [.5, pitch * 1.05], [1, pitch * .86]], mouth,
            bumps(stresses, from, length, .02), low ? 14 : 10, low ? .05 : .03);
          if (low) air(lead + span - .1, .55, .5, band(profile.air * .8, .7), 'exhale');
          else air(lead + span + .04, random(.26, .36), .6, band(profile.air * 1.1, 1.2), 'swell');
        } else if (kind === 'crawler') {
          air(0, lead + span + .12, .3, band(profile.air * 1.6, 1.6), 'hiss');
          chirps(lead - .05, span + .1, integer([7, 11]), .35, 700, 1900);
        } else {
          // Sobbing: jerky ingressive catches, then a voice that cracks downward on the last syllable.
          const sobs = integer([2, 3]), catches = [];
          for (let index = 0; index < sobs; index++) {
            const a = index / sobs, b = (index + 1) / sobs;
            catches.push([a + (b - a) * .1, 0], [a + (b - a) * .62, random(.35, .6)], [a + (b - a) * .78, random(.75, 1)], [a + (b - a) * .84, 0]);
          }
          catches.push([1, 0]);
          air(lead + span + .02, random(.4, .55), .6, band(profile.air * .75, 1.1), catches);
          const pitch = profile.pitch * random(1.3, 1.5);
          voiced(last.start, last.length + .05, .2, [[0, pitch], [.3, pitch * 1.04], [1, pitch * .7]], mouth, 'wail', 12, .03);
        }
      }
      // A long voiced vowel glide sinking in pitch, doubled an octave down and ring-modulated.
      function moan() {
        const setting = MOANS[voice.kind], span = random(...setting.span), pitch = profile.pitch;
        const contour = setting.contour.map((value, index) => [[0, .2, .55, 1][index], pitch * value]);
        const mouth = tract(span, setting.path, [6, 10, 12], [1, .55, .3]);
        const ring = vca(0, mouth), body = voiced(0, span, .85, contour, mouth, 'moan', 8, .03);
        body.connect(ring);
        const rate = setting.ring ? random(...setting.ring) : pitch * color * random(...setting.ratio);
        modulator(0, span, setting.depth, [[0, rate], [.5, rate * random(.9, 1.1)], [1, rate * random(.85, 1)]], ring.gain, 'roughen');
        voiced(.05, span - .05, setting.sub, contour.map(([phase, value]) => [phase, value * .498]), mouth, 'moan', 5, .015);
        air(0, span, setting.breath, mouth, 'exhale');
        if (voice.kind === 'shrieker') voiced(.08, span - .1, .25, contour.map(([phase, value]) => [phase, value * 1.067]), mouth, 'wail', 9, .02);
      }
      // Chase rumble: flutter-modulated voice and rasp driven into a waveshaper, then the throat.
      function growl() {
        const setting = GROWLS[voice.kind], span = random(...setting.span), pitch = profile.pitch * setting.pitch;
        const contour = [[0, pitch * .8], [.15, pitch], [.6, pitch * .96], [1, pitch * .82]];
        const mouth = tract(span, [[0, 'o'], [.4, 'a'], [.75, 'o'], [1, 'u']], [4, 6, 8], [1, .6, .35], profile.tract * setting.scale);
        const flutter = vca(.55, grit(setting.drive, mouth)), shape = voice.kind === 'crawler' ? 'stutter' : 'growl';
        voiced(0, span, .8, contour, flutter, shape, 12, .03);
        if (setting.sub) voiced(.02, span - .02, setting.sub, contour.map(([phase, value]) => [phase, value * .5]), flutter, shape, 9, .04);
        if (voice.kind === 'shrieker') voiced(.03, span - .05, .3, contour.map(([phase, value]) => [phase, value * 2.134]), flutter, shape, 14, .03);
        air(0, span, setting.rasp, flutter, shape);
        const rates = [];
        for (let phase = 0; phase < 1; phase += random(.08, .16)) rates.push([phase, random(...setting.flutter)]);
        rates.push([1, random(...setting.flutter)]);
        modulator(0, span, .45, rates, flutter.gain, 'roughen', true);
      }
      // Staccato voiced bursts on descending pitch steps, with aspiration and breath in between.
      function laugh() {
        const kind = voice.kind, setting = LAUGHS[kind], bursts = [], lead = .03;
        let time = lead, pitch = profile.pitch * random(...setting.pitch);
        for (let index = 0, total = integer(setting.count); index < total; index++) {
          const length = random(...setting.burst), gap = random(...setting.gap);
          bursts.push({ start: time, length, gap, pitch, vowel: setting.vowels[index % setting.vowels.length],
            peak: (1 - .35 * index / total) * random(.8, 1) });
          time += length + gap;
          pitch *= random(...setting.step);
        }
        const last = bursts[bursts.length - 1], spoken = last.start + last.length, total = spoken + .06;
        const from = bursts[0].start, length = spoken - from, phase = at => (at - from) / length;
        const contour = [], points = [], breath = [], path = [[0, bursts[0].vowel]];
        for (const [index, burst] of bursts.entries()) {
          const end = burst.start + burst.length, before = index ? bursts[index - 1].gap : lead;
          contour.push([phase(burst.start), burst.pitch, true], [phase(end), burst.pitch * .88]);
          points.push([phase(burst.start), 0], [phase(burst.start + .012), burst.peak], [phase(burst.start + burst.length * .5), burst.peak * .75], [phase(end), 0]);
          path.push([burst.start / total, burst.vowel, true], [end / total, burst.vowel]);
          const hold = burst.start - Math.min(.02, before / 3);
          breath.push([hold / total, .04], [(burst.start + .006) / total, random(.6, 1)], [(burst.start + .03) / total, .08],
            [(end + burst.gap * .35) / total, random(.25, .45)], [Math.min(end + burst.gap * .65, total) / total, .04]);
        }
        points.push([1, 0]); breath.push([1, 0]); path.push([1, last.vowel]);
        const mouth = tract(total, path, [5, 8, 10], [1, .6, .35]);
        const body = voiced(from, length, .9, contour, mouth, points, 30, .02);
        air(0, total, setting.breath, mouth, breath);
        if (kind === 'warden') voiced(from, length, .5, contour.map(([at, value, jump]) => [at, value * .5, jump]), mouth, points, 20, .03);
        else if (kind === 'shrieker') {
          voiced(from, length, .45, contour.map(([at, value, jump]) => [at, value * 1.067, jump]), mouth, points, 30, .025);
          air(total, .26, .6, band(profile.air * .8, 1.4), 'swell');
        } else if (kind === 'stalker') {
          const ring = vca(0, mouth), rate = bursts[0].pitch * random(.48, .55);
          body.connect(ring);
          modulator(from, length, .3, [[0, rate], [1, rate * random(.8, .95)]], ring.gain, 'roughen');
          air(spoken, .45, .5, band(profile.air * .9, .8), 'exhale');
        } else {
          // Clicking titter: a tongue click before every burst, chittering on after the laugh.
          const clicks = [], tail = total + .2, click = band(profile.claw, 4);
          for (const burst of bursts) {
            const at = burst.start - .012;
            clicks.push([at / tail, 0], [(at + .002) / tail, random(.7, 1)], [(at + .01) / tail, 0]);
          }
          for (let index = 0; index < 4; index++) {
            const at = total + .03 + index * .04 + random(0, .02);
            clicks.push([at / tail, 0], [(at + .002) / tail, random(.4, .8)], [(at + .01) / tail, 0]);
          }
          clicks.push([1, 0]);
          air(0, tail, .7, click, clicks);
        }
      }
      // A harsh shriek/roar: detuned voices plus noise, distorted, formants sweeping up then down.
      function scream() {
        const setting = SCREAMS[voice.kind], span = random(...setting.span), lead = setting.lead, pitch = profile.pitch;
        const contour = setting.contour.map((value, index) => [[0, .15, .6, 1][index], pitch * value]);
        const vowels = setting.path, path = vowels.map((vowel, index) => [(lead + span * index / (vowels.length - 1)) / (lead + span), vowel]);
        if (lead) path.unshift([0, vowels[0]]);
        const mouth = tract(lead + span, path, [5, 8, 10], [1, .7, .45]);
        const drive = grit(setting.drive, mouth), body = setting.flutter ? vca(.6, drive) : drive;
        if (lead) air(0, lead, .7, band(profile.air * .9, 1.2), 'swell');
        for (const [ratio, level] of setting.layers) {
          voiced(lead, span, level, contour.map(([phase, value]) => [phase, value * ratio]), body, 'scream', 16, .035);
        }
        air(lead, span, setting.noise, body, 'scream');
        if (setting.flutter) {
          const rates = [];
          for (let phase = 0; phase < 1; phase += random(.1, .2)) rates.push([phase, random(...setting.flutter)]);
          rates.push([1, random(...setting.flutter)]);
          modulator(lead, span, .35, rates, body.gain, 'roughen', true);
        }
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
      } else if (voice.cue === 'whisper') whisper();
      else if (voice.cue === 'moan') moan();
      else if (voice.cue === 'growl') growl();
      else if (voice.cue === 'laugh') laugh();
      else if (voice.cue === 'scream') scream();
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
  return Object.freeze({ create, CUE_NAMES: Object.freeze(Object.keys(CUES)), KIND_NAMES: Object.freeze(Object.keys(KINDS)) });
});
