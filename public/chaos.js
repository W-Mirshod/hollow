/* Chaos director: seeded practical-light flicker, surges, blackouts, emergency beacons and spatial
   scare cues, plus a kill-streak tracker. Pure and renderer-independent; equal seeds and inputs replay exactly. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HollowChaos = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const TAU = Math.PI * 2, GOLDEN = 2.399963229728653;
  const CH = 8, OFF = .04, MAX_DT = .25, NEAR = 6;
  // Any four consecutive on/off switches of one light span more than a second: <= 3 per second.
  const SWITCH_WINDOW = 1.05;
  const START_HOLD = .2, END_HOLD = 3.5, BLACKOUT_MAX = 1.2, BLACKOUT_COOLDOWN = 20;
  const SCARE_MIN = 12, SCARE_SPAN = 18, SCARE_CALM = 3, SCARE_CLEAR = 2;
  const SCARES = ['scream', 'slam', 'whisper', 'laugh'];
  const STREAK_WINDOW = 4;
  const KILL_POINTS = Object.freeze({ warden: 500, stalker: 150, crawler: 120, shrieker: 140 });

  function mix(n) {
    let h = Math.imul(n | 0, 0x27d4eb2d);
    h ^= h >>> 15; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
    return (h ^ h >>> 16) >>> 0;
  }
  function noise(x, salt) {
    const n = Math.floor(x), f = x - n, u = f * f * (3 - 2 * f);
    const a = mix(n ^ salt) / 4294967296, b = mix((n + 1) ^ salt) / 4294967296;
    return a + (b - a) * u;
  }
  function ease(dt, rate) { return 1 - Math.exp(-dt * rate); }
  function unit(value) { const v = Number(value); return v > 0 ? (v < 1 ? v : 1) : 0; }
  function toSeed(seed) { const v = Number(seed); return Number.isFinite(v) ? v | 0 : 0; }

  function create(seed) {
    const on = new Uint8Array(CH), want = new Uint8Array(CH), head = new Uint8Array(CH);
    const hist = new Float64Array(CH * 3), next = new Float64Array(CH), until = new Float64Array(CH);
    const chHaz = new Float64Array(CH), chNeed = new Float64Array(CH);
    let seed0 = 0, state = 0, saltA = 0, saltB = 0;
    let age, live, fx, dangerS, nearS, alarmS, chaseS, injury, surgeEnv, blackEnv, volt, capS;
    let beaconLin, beaconAngle, beaconOmega, chasing, onT, offT, chases;
    let surgeT, surgeAmp, surgeCD, surgeHaz, surgeNeed, midSpark, surges;
    let blackT, blackCD, blackHaz, blackNeed, blackPrime, blackouts;
    let scareCD, calmT, sinceScare, lastKind, scares, sparkHaz, sparkNeed, sparks;

    function rand() {
      state = state + 0x6D2B79F5 | 0;
      let t = Math.imul(state ^ state >>> 15, 1 | state);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    }
    function expo() { return -Math.log(1 - rand()); }
    function init(value) {
      seed0 = toSeed(value); state = seed0; saltA = mix(seed0 ^ 0x51ed27); saltB = mix(seed0 ^ 0x2c1b3c6d);
      age = 0; live = false; fx = true; dangerS = nearS = alarmS = chaseS = injury = surgeEnv = blackEnv = 0; volt = 1; capS = 1;
      beaconLin = 0; beaconAngle = rand() * TAU; beaconOmega = TAU * 1.5; chasing = false; onT = offT = 0; chases = 0;
      surgeT = surgeAmp = 0; surgeCD = 6 + rand() * 6; surgeHaz = 0; surgeNeed = expo(); midSpark = -1; surges = 0;
      blackT = 0; blackCD = BLACKOUT_COOLDOWN + rand() * 8; blackHaz = blackPrime = 0; blackNeed = expo(); blackouts = 0;
      scareCD = SCARE_MIN + rand() * SCARE_SPAN; calmT = sinceScare = 99; lastKind = -1; scares = 0;
      sparkHaz = 0; sparkNeed = expo(); sparks = 0;
      for (let c = 0; c < CH; c++) {
        on[c] = want[c] = 1; head[c] = 0; hist[c * 3] = hist[c * 3 + 1] = hist[c * 3 + 2] = -1e9;
        next[c] = 0; until[c] = -1; chHaz[c] = 0; chNeed[c] = expo();
      }
    }
    function sparkEvent(out, lights) {
      const light = lights > 0 ? Math.floor(rand() * lights) : null;
      sparks++; out.push({ type: 'sparks', light });
      if (light !== null && fx && surgeT <= 0 && blackT <= 0) { want[light] = 0; until[light] = age + .05 + rand() * .06; }
    }
    function startSurge(out, lights) {
      const duration = (.6 + rand()) * (fx ? 1 : .7);
      surgeT = duration;
      surgeAmp = Math.min(1, .45 + .3 * dangerS + (chasing ? .15 : 0) + .1 * rand());
      if (!fx) surgeAmp = Math.min(surgeAmp, .4);
      midSpark = rand() < .5 ? duration * (.3 + .4 * rand()) : -1;
      surges++; calmT = 0;
      out.push({ type: 'surge', duration, intensity: surgeAmp });
      sparkEvent(out, lights);
      for (let c = 0; c < CH; c++) next[c] = age + rand() * .12;
    }
    function startBlackout(out) {
      const duration = .7 + rand() * .5;
      blackT = duration; blackCD = BLACKOUT_COOLDOWN + 2 + rand() * 14; blackouts++; calmT = 0;
      out.push({ type: 'blackout', duration });
      sparks++; out.push({ type: 'sparks', light: null });
    }
    function scareEvent(out, yaw) {
      let kind;
      if (!fx) kind = lastKind === 1 ? 2 : 1;
      else {
        const tense = chasing || dangerS >= .4;
        let w0 = tense ? .35 : .15, w1 = tense ? .3 : .25, w2 = (tense ? .15 : .35) + (injury > .65 ? .2 : 0), w3 = tense ? .2 : .25;
        if (lastKind === 0) w0 = 0; else if (lastKind === 1) w1 = 0; else if (lastKind === 2) w2 = 0; else if (lastKind === 3) w3 = 0;
        let pick = rand() * (w0 + w1 + w2 + w3);
        kind = (pick -= w0) < 0 ? 0 : (pick -= w1) < 0 ? 1 : (pick -= w2) < 0 ? 2 : 3;
      }
      const distance = (kind === 0 ? 10 + rand() * 12 : kind === 1 ? 5 + rand() * 9 : kind === 2 ? 2 + rand() * 2.5 : 6 + rand() * 7) + (fx ? 0 : 4);
      // HollowHorror convention: x += cos(bearing) * distance, z += sin(bearing) * distance. Voices come from behind.
      let bearing = (kind === 2 || kind === 3) && Number.isFinite(yaw) ? Math.PI / 2 - yaw + (rand() - .5) * 1.2 : rand() * TAU;
      bearing %= TAU; if (bearing < 0) bearing += TAU; if (!(bearing < TAU)) bearing = 0;
      lastKind = kind; scares++; calmT = 0; sinceScare = 0;
      scareCD = (SCARE_MIN + rand() * SCARE_SPAN * (1 - .45 * dangerS)) * (fx ? 1 : 1.6);
      out.push({ type: SCARES[kind], bearing, distance });
    }
    function record(c) { hist[c * 3 + head[c]] = age; head[c] = (head[c] + 1) % 3; }
    function canCutAll() {
      for (let c = 0; c < CH; c++) if (on[c] && age - hist[c * 3 + head[c]] < SWITCH_WINDOW) return false;
      return true;
    }
    function updateChannels(dt) {
      const surging = surgeT > 0, flickRate = .03 + .9 * nearS * nearS;
      for (let c = 0; c < CH; c++) {
        if (!fx) { want[c] = 1; chHaz[c] = 0; until[c] = -1; if (!on[c]) { on[c] = 1; record(c); } continue; }
        if (blackT > 0) want[c] = 0;
        else if (surging) {
          if (age >= next[c]) {
            if (want[c]) { want[c] = 0; next[c] = age + .04 + rand() * .12; }
            else { want[c] = 1; next[c] = age + .06 + rand() * .3 * (1.25 - surgeAmp); }
          }
        } else {
          if (until[c] >= 0 && age >= until[c]) until[c] = -1;
          if (until[c] < 0) want[c] = 1;
          chHaz[c] += flickRate * dt;
          if (chHaz[c] >= chNeed[c]) { chHaz[c] = 0; chNeed[c] = expo(); want[c] = 0; until[c] = age + .04 + rand() * .09; }
        }
        if (on[c] !== want[c] && age - hist[c * 3 + head[c]] >= SWITCH_WINDOW) { on[c] = want[c]; record(c); }
      }
    }

    function update(dt, input) {
      if (!input || typeof input !== 'object' || !input.active) { live = false; return []; }
      if (!Number.isFinite(dt) || dt <= 0) return [];
      dt = Math.min(dt, MAX_DT);
      const effects = input.effects !== false, danger = unit(input.danger);
      const chasers = Number(input.chasers) >= 1 ? Math.floor(Number(input.chasers)) : 0;
      const near = input.nearest == null || Number.isNaN(Number(input.nearest)) ? Infinity : Math.max(0, Number(input.nearest));
      const alarm = !!input.alarm, sheltered = !!input.sheltered;
      const health = input.health == null || !Number.isFinite(Number(input.health)) ? 100 : Math.max(0, Math.min(100, Number(input.health)));
      const lights = input.lights == null ? 3 : Math.max(0, Math.min(CH, Math.floor(Number(input.lights)) || 0));
      const yaw = input.yaw == null ? NaN : Number(input.yaw);
      const out = [];
      age += dt; live = true; fx = effects; calmT += dt; sinceScare += dt;
      if (input.cue) calmT = 0;
      dangerS += (danger - dangerS) * ease(dt, 2.5);
      const close = near < NEAR ? 1 - near / NEAR : 0;
      nearS += (close - nearS) * ease(dt, close > nearS ? 5 : 2);
      alarmS += ((alarm ? 1 : 0) - alarmS) * ease(dt, alarm ? 3 : 1.2);
      injury += (1 - health / 100 - injury) * ease(dt, 2);

      if (chasers > 0) { onT += dt; offT = 0; } else { offT += dt; onT = 0; }
      if (!chasing && onT >= START_HOLD) {
        chasing = true; chases++; calmT = 0; out.push({ type: 'chaseStart' });
        if (surgeT <= 0 && blackT <= 0 && !sheltered && sinceScare >= SCARE_CLEAR && rand() < .6) startSurge(out, lights);
      } else if (chasing && offT >= END_HOLD) { chasing = false; out.push({ type: 'chaseEnd' }); }

      blackCD -= dt; blackPrime = Math.max(0, blackPrime - dt);
      if (blackT > 0) { blackT -= dt; if (blackT <= 0 || !fx) blackT = 0; }
      if (surgeT > 0) {
        surgeT -= dt;
        if (midSpark >= 0 && (midSpark -= dt) < 0) { midSpark = -1; if (surgeT > 0) sparkEvent(out, lights); }
        if (surgeT <= 0) {
          surgeT = 0; midSpark = -1; surgeCD = 3 + rand() * 4;
          // Sometimes the surge trips the breaker: a blackout follows once every light is free to cut.
          if (fx && (chasing || dangerS >= .7) && blackCD <= 0 && rand() < .35) blackPrime = 1.5;
        }
      } else surgeCD -= dt;

      const clear = !sheltered && surgeT <= 0 && blackT <= 0 && sinceScare >= SCARE_CLEAR;
      if (clear && surgeCD <= 0) {
        surgeHaz += (1 / 70 + dangerS / 12 + (chasing ? .1 : 0) + nearS / 15 + alarmS / 20 + injury / 40) * (fx ? 1 : .5) * dt;
        if (surgeHaz >= surgeNeed) { surgeHaz = 0; surgeNeed = expo(); startSurge(out, lights); }
      }
      if (clear && fx && surgeT <= 0 && blackCD <= 0 && (chasing || dangerS >= .7)) {
        blackHaz += (.04 + (chasing && dangerS > .8 ? .05 : 0)) * dt;
        if ((blackHaz >= blackNeed || blackPrime > 0) && canCutAll()) { blackHaz = blackPrime = 0; blackNeed = expo(); startBlackout(out); }
      }
      if (!sheltered && surgeT <= 0 && blackT <= 0) {
        sparkHaz += (fx ? 1 / 45 : 1 / 90) * dt;
        if (sparkHaz >= sparkNeed) { sparkHaz = 0; sparkNeed = expo(); sparkEvent(out, lights); }
      }
      scareCD -= dt;
      // A refuge is relief: no scares inside, and a short grace after leaving.
      if (sheltered) scareCD = Math.max(scareCD, 6);
      else if (scareCD <= 0 && calmT >= SCARE_CALM && surgeT <= 0 && blackT <= 0) scareEvent(out, yaw);

      surgeEnv += ((surgeT > 0 ? surgeAmp : 0) - surgeEnv) * ease(dt, surgeT > 0 ? 12 : 3);
      blackEnv += ((blackT > 0 ? 1 : 0) - blackEnv) * ease(dt, blackT > 0 ? 14 : 3);
      volt += ((surgeT > 0 && fx ? 1 + .15 * surgeAmp : 1) - volt) * ease(dt, 10);
      chaseS += ((chasing ? 1 : 0) - chaseS) * ease(dt, chasing ? 3 : .7);
      beaconLin = Math.max(0, Math.min(1, beaconLin + (chasing || alarm ? dt / .45 : -dt / 1.1)));
      capS += ((fx ? 1 : .35) - capS) * ease(dt, 4);
      beaconOmega += (TAU * (fx ? 1.5 : .5) - beaconOmega) * ease(dt, 3);
      beaconAngle = (beaconAngle + beaconOmega * dt) % TAU;
      updateChannels(dt);
      return out;
    }

    function lightLevel(i, phase) {
      if (!live) return 1;
      const p = Number(phase), q0 = Number.isFinite(p) ? p : NaN;
      let c = Math.floor(Number(i));
      if (!(c >= 0 && c < Infinity)) c = Number.isFinite(q0) ? Math.floor(Math.abs(q0) / TAU * CH) : 0;
      c %= CH;
      const q = Number.isFinite(q0) ? q0 : c * GOLDEN;
      if (!fx) {
        // Reduced effects: slow, smooth, shallow modulation only. Range [.786, 1].
        return (1 - .03 * (.5 + .5 * Math.sin(age * .9 + q))) * (1 - .1 * alarmS * (.5 - .5 * Math.cos(age * TAU * .55 + q * .2))) * (1 - .1 * nearS);
      }
      // Voltage and modulation stay within a 1.73:1 band (< 50% change); only on/off switches are high contrast.
      let s = 1 + .02 * Math.sin(age * 9.3 + q * 3);
      if (nearS > 1e-4) s *= 1 - .3 * Math.pow(nearS, 1.2) * noise(age * 23 + q * 7, saltA);
      if (surgeEnv > 1e-4) s *= 1 - .25 * surgeEnv * noise(age * 31 + q * 5, saltB);
      if (alarmS > 1e-4) s *= 1 - .16 * alarmS * (.5 - .5 * Math.cos(age * TAU * 1.1 + q * .3));
      s = s < .72 ? .72 : s > 1.08 ? 1.08 : s;
      return (on[c] ? 1 : OFF) * volt * s;
    }
    function beacon(i) {
      const k = Number(i), index = Number.isFinite(k) ? Math.floor(k) : 0;
      let angle = (beaconAngle + index * GOLDEN) % TAU;
      if (angle < 0) angle += TAU;
      if (!(angle < TAU)) angle = 0;
      if (!live) return { on: false, angle, intensity: 0 };
      const intensity = beaconLin * beaconLin * (3 - 2 * beaconLin) * capS;
      return { on: intensity > 0, angle, intensity };
    }
    function intensity() {
      if (!live) return 0;
      const calm = (1 - .55 * dangerS) * (1 - .3 * chaseS) * (1 - .35 * surgeEnv) * (1 - .3 * blackEnv) *
        (1 - .25 * nearS) * (1 - .15 * alarmS) * (1 - .15 * injury);
      return Math.max(0, Math.min(1, 1 - calm));
    }
    function snapshot() {
      let dark = 0;
      for (let c = 0; c < CH; c++) if (!on[c]) dark++;
      return {
        seed: seed0, age, active: live, effects: fx, chasing, chases, danger: dangerS, closeness: nearS, alarm: alarmS,
        surge: surgeT, surgeIntensity: surgeT > 0 ? surgeAmp : 0, surgeLevel: live ? surgeEnv : 0, surges, surgeCooldown: Math.max(0, surgeCD),
        blackout: blackT, blackoutLevel: live ? blackEnv : 0, blackouts, blackoutCooldown: Math.max(0, blackCD),
        scareCooldown: Math.max(0, scareCD), scares,
        sparks, lightsOff: live && fx ? dark : 0, beacon: beacon(0).intensity, intensity: intensity()
      };
    }
    init(seed);
    return Object.freeze({ update, lightLevel, beacon, intensity, reset(value) { init(value === undefined ? seed0 : value); }, snapshot });
  }

  function createStreak(options) {
    const quiet = !!options && options.effects === false;
    let count, best, points, kills, last, lastHit, clock;
    function reset() { count = best = points = kills = 0; last = lastHit = -Infinity; clock = 0; }
    function at(time) { const t = time == null ? NaN : Number(time); if (Number.isFinite(t)) clock = t; return clock; }
    function hit(time, info) {
      const t = at(time), headshot = !!(info && info.headshot), rapid = t >= lastHit && t - lastHit < .12;
      lastHit = t;
      return { marker: headshot ? 'headshot' : 'hit', hitstop: headshot ? .016 : rapid ? 0 : .006 };
    }
    function kill(time, info) {
      info = info && typeof info === 'object' ? info : {};
      const t = at(time), headshot = !!info.headshot, kind = typeof info.kind === 'string' ? info.kind : '';
      const d = Number(info.distance), distance = Number.isFinite(d) && d > 0 ? d : 0;
      count = count > 0 && t >= last && t - last <= STREAK_WINDOW ? count + 1 : 1;
      last = t; kills++; if (count > best) best = count;
      const label = kind === 'warden' ? 'WARDEN DOWN' : count >= 5 ? 'RAMPAGE' : count === 4 ? 'MULTI KILL' :
        count === 3 ? 'TRIPLE KILL' : count === 2 ? 'DOUBLE KILL' : headshot ? 'HEADSHOT' : null;
      const chain = Math.min(count - 1, 6), base = Object.prototype.hasOwnProperty.call(KILL_POINTS, kind) ? KILL_POINTS[kind] : 100;
      const award = Math.round(base * (headshot ? 1.5 : 1) * (1 + .25 * chain) * (distance >= 20 ? 1.25 : distance >= 12 ? 1.1 : 1) / 5) * 5;
      points += award;
      const hitstop = Math.min(.12, .045 + (headshot ? .015 : 0) + (kind === 'warden' ? .045 : 0) + .01 * Math.min(chain, 4));
      const flash = quiet || info.effects === false ? 0 :
        Math.min(1, .35 + (headshot ? .15 : 0) + (kind === 'warden' ? .35 : 0) + .1 * Math.min(chain, 4));
      return { count, label, points: award, hitstop, flash };
    }
    function snapshot(time) {
      const t = time == null ? NaN : Number(time);
      const expired = Number.isFinite(t) && (t < last || t - last > STREAK_WINDOW);
      return { count: expired ? 0 : count, best, points, kills };
    }
    reset();
    return Object.freeze({ hit, kill, reset, snapshot });
  }

  const LIMITS = Object.freeze({ channels: CH, transitionsPerSecond: 3, switchWindow: SWITCH_WINDOW, off: OFF, nearRange: NEAR,
    chaseStartHold: START_HOLD, chaseEndHold: END_HOLD, blackoutMax: BLACKOUT_MAX, blackoutCooldown: BLACKOUT_COOLDOWN,
    scareCooldown: Object.freeze([SCARE_MIN, SCARE_MIN + SCARE_SPAN]), streakWindow: STREAK_WINDOW });
  return Object.freeze({ create, createStreak, LIMITS, SCARES: Object.freeze(SCARES.slice()), KILL_POINTS });
});
