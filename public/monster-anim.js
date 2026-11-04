/* Procedural animation brain for the visuals.js creatures: speed/state-blended gaits, lunges, screams, attacks,
   directional hit flinches and directional deaths. Pure math (no THREE). update() mutates and returns one
   preallocated pose of ADDITIVE joint Euler offsets (on top of userData.restPose) plus a root offset in the
   monster's local frame (+z forward, +x its left; apply with rotation order 'YXZ'). Springs and blends use exact
   closed forms and intermittent behaviour is a pure function of time, so 30/60/144 fps agree and every seed is
   deterministic. Disturbing motion (twitches, head snaps, spasms, shudder) only runs when `effects` is true. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else if (typeof define === 'function' && define.amd) define([], factory);
  else root.HollowMonsterAnim = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const PI = Math.PI, TAU = PI * 2, HALF = PI / 2;
  const JOINTS = Object.freeze(['legL', 'legR', 'armL', 'armR', 'neck', 'head', 'jaw', 'kneeL', 'kneeR', 'elbowL', 'elbowR']);
  // Channel layout: joint i owns [3i, 3i + 2] (x, y, z); the root follows (x, y, z, pitch, yaw, roll).
  const LL = 0, LR = 3, AL = 6, AR = 9, NK = 12, HD = 15, JW = 18, KL = 21, KR = 24, EL = 27, ER = 30;
  const RX = 33, RY = 34, RZ = 35, RP = 36, RW = 37, RR = 38, CH = 39;
  const STATES = Object.freeze({ wander: 0, stalk: 1, search: 2, chase: 3 });
  const MODES = Object.freeze({ alive: 0, back: 1, front: 2, roll: 3 });
  const EMPTY = Object.freeze({}), NONE = Object.freeze([]);

  // Pairs are [at walk speed, at chase speed]. Angles in radians, offsets in metres at the default height.
  // Signs (see makeMonster): limb x < 0 swings a hanging limb forward; knee x > 0 folds the shin back; elbow x < 0
  // curls the forearm forward; limb z moves the end toward +x, so "outward" is -z on L and +z on R; neck x < 0 throws
  // the head back; jaw x > 0 opens. Root pitch > 0 leans forward, roll < 0 leans toward +x (the creature's left).
  const KINDS = deepFreeze({
    warden: {
      height: 2.8, head: 2.35, radius: .58, walk: 1.2, chase: 3.2, quad: false, hip: 1.06, leg: 1.02,
      cadence: [.8, 1.35, 2.3, 2.9], stance: [.62, .45], stride: .5, hipMax: .6,
      knee: [.6, 1.05], load: [.12, .22], arm: [.2, .3], lag: .1, elbow: [-.14, -.4], elbowSwing: .14,
      reach: [-.04, -.2], flail: [0, 0], spread: [.08, .14], lope: 0,
      dip: [.07, .15], sway: [.06, .05], roll: [.065, .095], nod: [.04, .07], twist: [.05, .08], lean: [.1, .28],
      neck: .16, steady: .55, look: .3, breath: 4.2, breathAmp: .024, jaw: [.05, .14], jawMax: .62,
      steps: [.75, 1], flinch: .3, headFlinch: .55, bank: .14, bankGain: .05,
      stalk: { lean: .12, crouch: .2, tilt: .1, look: -.12, reach: -.12, claw: -.3, cadence: .8, lift: 1.2 },
      lunge: { drop: .12, pitch: .22, arms: -1.35, spread: .22, elbow: -.08, jaw: .5, neck: -.28 },
      scream: { neck: -.55, head: -.2, jaw: .6, arms: -.5, spread: .75, elbow: -.7, pitch: -.12, shudder: .022 },
      attack: { up: -2.15, out: .3, bend: -1, down: -.4, across: -.25, jaw: .6, lurch: .16, dur: .42 },
      death: { T: 1.45, hsT: 1.05, recoil: .14, bounce: .07, slide: .55, crumple: .3, sink: .06, twist: 1.1,
        back: { tilt: 1.5, legs: .05, knees: .3, arms: -.1, elbows: 0, neck: [0, -.2], turn: 1.5 },
        front: { tilt: 1.56, legs: -.45, knees: .3, arms: -.1, elbows: 0, neck: [0, -.2], turn: 1.5 } }
    },
    stalker: {
      height: 2.65, head: 2.12, radius: .34, walk: 1.6, chase: 5.5, quad: false, hip: 1.25, leg: 1.23,
      cadence: [.9, 1.55, 2.95, 3.6], stance: [.6, .38], stride: .5, hipMax: .74,
      knee: [.7, 1.5], load: [.1, .2], arm: [.3, .32], lag: .03, elbow: [-.12, -.38], elbowSwing: .3,
      reach: [-.12, -1.05], flail: [.04, .38], spread: [.08, .18], lope: 0,
      dip: [.04, .1], sway: [.035, .04], roll: [.035, .06], nod: [.03, .06], twist: [.04, .1], lean: [.1, .38],
      neck: .04, steady: .7, look: .4, breath: 3.4, breathAmp: .018, jaw: [.04, .2], jawMax: .72,
      steps: [.35, .65], flinch: 1, headFlinch: 1, bank: .32, bankGain: .045,
      stalk: { lean: .3, crouch: .42, tilt: .32, look: -.22, reach: -.38, claw: -.62, cadence: .62, lift: 1.6 },
      lunge: { drop: .14, pitch: .3, arms: -1.55, spread: .3, elbow: -.02, jaw: .72, neck: -.42 },
      scream: { neck: -.7, head: -.25, jaw: .72, arms: -.35, spread: .9, elbow: -.55, pitch: -.14, shudder: .03 },
      attack: { up: -2.2, out: .35, bend: -1.1, down: -.45, across: -.3, jaw: .7, lurch: .2, dur: .35 },
      death: { T: 1.1, hsT: .82, recoil: .17, bounce: .08, slide: .6, crumple: .32, sink: 0, twist: 1.1,
        back: { tilt: 1.6, legs: .05, knees: 0, arms: -.1, elbows: 0, neck: [0, .2], turn: 1.5 },
        front: { tilt: 1.5, legs: .15, knees: 0, arms: -.1, elbows: 0, neck: [-.1, .2], turn: 1.5 } }
    },
    crawler: {
      height: .9, head: .55, radius: .43, walk: 1.9, chase: 6.2, quad: true, hip: .5, leg: .55,
      cadence: [1.4, 2.6, 4.7, 5.6], stance: [.55, .42],
      sweep: [.22, .36], lift: [.24, .38], tuck: [.32, .5], armLift: [.18, .28], armSweep: .08,
      dip: [.025, .045], roll: [.05, .085], nod: [.03, .05], wiggle: [.08, .15], lean: [.02, .08], low: [0, .06],
      jitter: .05, look: .35, breath: 2.6, breathAmp: .012, mouth: .06, jawMax: 1,
      steps: [.25, .5], flinch: 1, headFlinch: 1, bank: .26, bankGain: .04,
      stalk: { low: .07, look: -.18, splay: .1, cadence: .7, lift: 1.3 },
      lunge: { rise: .08, surge: .12, pitch: .1, arms: -.8, legs: .35, neck: -.42 },
      scream: { rear: -.36, rise: .1, arms: -.9, spread: .3, neck: -.55, shudder: .03 },
      attack: { up: -.95, down: .25, neck: .32, lurch: .12, dur: .32 },
      death: { T: .62, hsT: .46, roll: 1.52, pitch: .1, hop: .09, slide: .18, under: [-2.2, .8, -.8], over: [1.8, -1.2, -1.5] }
    },
    shrieker: {
      height: 2.3, head: 1.9, radius: .34, walk: 1.4, chase: 4.4, quad: false, hip: 1.05, leg: .98,
      cadence: [.9, 1.55, 2.7, 3.3], stance: [.6, .4], stride: .5, hipMax: .7,
      knee: [.65, 1.3], load: [.1, .2], arm: [.3, .55], lag: .05, elbow: [-.18, -.45], elbowSwing: .25,
      reach: [-.06, -.3], flail: [.06, .42], spread: [.14, .62], lope: .11,
      dip: [.05, .13], sway: [.04, .045], roll: [.045, .07], nod: [.03, .07], twist: [.05, .09], lean: [.08, .3],
      neck: 0, steady: .6, look: .45, breath: 3, breathAmp: .02, jaw: [.08, .22], jawMax: .85,
      steps: [.3, .6], flinch: 1, headFlinch: 1, bank: .3, bankGain: .045,
      stalk: { lean: .2, crouch: .3, tilt: .25, look: -.2, reach: -.3, claw: -.5, cadence: .7, lift: 1.4 },
      lunge: { drop: .1, pitch: .26, arms: -1.45, spread: .25, elbow: -.06, jaw: .8, neck: -.38 },
      scream: { neck: -.85, head: -.3, jaw: .85, arms: -.6, spread: 1.15, elbow: -.8, pitch: -.18, shudder: .035 },
      attack: { up: -2.1, out: .4, bend: -1.05, down: -.5, across: -.3, jaw: .8, lurch: .18, dur: .35 },
      death: { T: 1, hsT: .78, recoil: .17, bounce: .08, slide: .5, crumple: .32, sink: 0, twist: 1.1,
        back: { tilt: 1.6, legs: .05, knees: .3, arms: .1, elbows: .25, neck: [.4, -.2], turn: 1.5 },
        front: { tilt: 1.5, legs: -.05, knees: .3, arms: .1, elbows: .25, neck: [.4, -.1], turn: 1.5 } }
    }
  });

  // Coarse mirror of the visuals.js rig, used to keep dying bodies on the floor: joint offsets [L xyz, R xyz] relative
  // to the parent joint, limb radii, hand/foot ellipsoids [centre xyz, semi-axes xyz] relative to the limb end in the
  // distal frame, and torso support points (mesh vertices chosen so their lowest point tracks the whole torso within
  // ~2 cm at any pitch/roll a death reaches). Head: skull ellipsoid, face point [y, z, r] and jaw [joint xyz, rest x,
  // drop, chin z] in the head frame; neckLow [y, z, r] is the lowest neck sinew point.
  const RIGS = deepFreeze({
    warden: {
      hips: [-.245, 1.10, -.035, .255, 1.02, .045], knees: [-.075, -.47, .10, .065, -.42, -.04],
      ankles: [.025, -.55, -.085, -.012, -.51, .09], legW: .14, foot: [0, -.014, .06, .106, .05, .15],
      shoulders: [-.48, 2.30, .015, .47, 2.13, .055], elbows: [-.075, -.64, .09, .105, -.53, -.03],
      wrists: [.025, -.69, .035, -.015, -.79, .16], armW: .12, hand: [0, -.305, .013, .127, .254, .089],
      neck: [-.055, 2.35, .28], neckRest: [.12, 0, -.03], headRest: [.13, -.08, -.13], neckLow: [-.23, -.17, .14],
      skull: [0, .075, -.046, .205, .28, .167], face: [.105, .238, .05], jaw: [.022, .035, .025, .06, .255, .268],
      torso: [-.04, .875, -.1, -.21, 2.63, -.565, .04, .535, .33, -.33, 2.49, .365, -.065, .29, .31, .025, 1.93, -.48,
        .185, .465, .195, .005, 1.235, -.32, .155, .85, -.09, -.095, 2.3, -.55]
    },
    stalker: {
      hips: [-.135, 1.30, -.045, .135, 1.21, .045], knees: [-.09, -.58, .02, .105, -.63, .18],
      ankles: [.08, -.65, -.065, -.14, -.51, -.13], legW: .072, foot: [0, -.014, .06, .055, .05, .15],
      shoulders: [-.27, 2.18, -.035, .255, 2.02, .04], elbows: [-.055, -.65, .045, .085, -.43, -.075],
      wrists: [-.015, -.78, .055, -.035, -.52, .15], armW: .054, hand: [0, -.24, .01, .1, .2, .07],
      neck: [.075, 2.12, .18], neckRest: [.02, -.04, .08], headRest: [.1, -.12, -.34], neckLow: [-.23, -.17, .065],
      skull: [0, .13, -.043, .12, .36, .122], face: [.105, .172, .04], jaw: [-.018, .035, .025, -.04, .33, .202],
      torso: [.055, .985, .17, -.12, 1.085, -.235, .205, 1.025, .185, .075, 1.075, -.235, -.025, 2.035, .19,
        -.015, .905, -.235, -.02, 2.04, -.205, .155, .895, .165]
    },
    crawler: {
      hips: [-.2, .52, -.36, .225, .45, -.43], knees: [-.36, .1, -.3, .29, .2, -.2],
      ankles: [.12, -.55, -.09, .2, -.56, .13], legW: .072, foot: [0, 0, .206, .086, .043, .172],
      shoulders: [-.245, .61, .22, .26, .54, .16], elbows: [-.34, .08, .12, .33, .04, .25],
      wrists: [.17, -.61, .33, .17, -.5, .24], armW: .067, hand: [0, 0, .206, .086, .043, .172],
      neck: [-.065, .55, .46], neckRest: [.05, .12, .06], headRest: [.11, -.16, -.42], neckLow: null,
      skull: [0, .03, -.043, .125, .205, .122], face: [-.15, .19, .03], jaw: null,
      torso: [.085, .4, .1, -.085, .465, -.58, -.095, .54, .485, .285, .5, .34, .03, .615, -.59, -.2, .78, -.485,
        .08, .58, -.59, -.24, .475, .125, .23, .555, -.52, -.29, .795, .1, -.25, .57, -.45, .135, .41, .35, .095, .48, -.595,
        .12, .455, .47, -.17, .42, .12, .035, .415, -.59, -.17, .475, .375, .165, .635, .465, -.25, .57, .275, -.1, .43, .37,
        .18, .52, .465, -.055, .43, -.58]
    },
    shrieker: {
      hips: [-.15, 1.03, -.07, .12, 1.08, .015], knees: [-.05, -.42, -.02, .07, -.5, .1],
      ankles: [.02, -.54, .1, -.02, -.51, -.07], legW: .072, foot: [0, -.014, .06, .055, .05, .15],
      shoulders: [-.26, 1.78, .015, .24, 1.71, -.025], elbows: [-.06, -.43, .1, .12, -.52, -.02],
      wrists: [.035, -.44, .17, -.17, -.34, .28], armW: .054, hand: [0, -.223, .009, .093, .186, .065],
      neck: [.015, 1.9, .17], neckRest: [-.03, .1, .04], headRest: [-.07, .09, .12], neckLow: [-.4, -.07, .03],
      skull: [0, .14, -.043, .12, .225, .122], face: [.132, .172, .04], jaw: [.008, .09, .025, .04, .565, .202],
      torso: [-.065, .87, -.03, .11, .845, -.01, -.02, 1.84, -.205, .175, .915, .165, -.135, 1.065, -.225,
        -.02, 1.3, .19, .03, .805, .145, -.035, .92, -.225, -.025, 1.685, .19, .095, .85, -.07, .115, 1.015, -.23]
    }
  });

  function deepFreeze(o) { for (const k in o) if (o[k] && typeof o[k] === 'object') deepFreeze(o[k]); return Object.freeze(o); }
  // Float-only clamps (Math.min/max): V8 keeps them unboxed where ternary clamps boxed results. NaN passes through.
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const num = v => typeof v === 'number' && Number.isFinite(v) ? v : 0;
  const positive = (v, d) => typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d;
  const flag = v => !!v && v === v;
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (a, b, v) => { const x = Math.min(1, Math.max(0, (v - a) / (b - a))); return x * x * (3 - 2 * x); };
  const bump = (v, a, b) => v <= a || v >= b ? 0 : Math.sin(PI * (v - a) / (b - a));
  const ease = (cur, target, rate, dt) => target + (cur - target) * Math.exp(-rate * dt);
  const out = (v, lim) => v !== v ? 0 : Math.min(lim, Math.max(-lim, v));
  // Footfall: sharp drop right after a plant (u = 0), smooth recovery by the next plant.
  const dipCurve = (u, a) => u < a ? Math.sin(HALF * u / a) : .5 + .5 * Math.cos(PI * (u - a) / (1 - a));
  function hash(i, ch, sh) {
    let h = (Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(ch + 1, 0x165667b1) ^ sh) | 0;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35); h ^= h >>> 16;
    return (h >>> 0) / 2147483647.5 - 1;
  }
  // 1D gradient noise in about [-1, 1] (quintic fade, C2 smooth).
  function gnoise(x, ch, sh) {
    const i = Math.floor(x), f = x - i, u = f * f * f * (f * (f * 6 - 15) + 10);
    const a = hash(i, ch, sh) * f, b = hash(i + 1, ch, sh) * (f - 1);
    return 2 * (a + (b - a) * u);
  }
  // Seeded impulse train, a pure function of time: each `period` slot fires with probability p a snap (snap s)
  // to a signed random amplitude, a hold, then a release; events finish inside their slot (no seams).
  function twitch(t, period, p, snap, hold, ch, sh) {
    const k = Math.floor(t / period);
    if (hash(k, ch, sh) * .5 + .5 > p) return 0;
    const start = (hash(k, ch + 7, sh) * .5 + .5) * .3 * period, rel = Math.min(.25, .65 * period - snap - hold);
    const d = t - k * period - start;
    if (d <= 0) return 0;
    const a = hash(k, ch + 13, sh), amp = (a < 0 ? -1 : 1) * (.45 + .55 * Math.abs(a));
    // Smoothstep envelope written out: as smooth() calls it overflowed V8's inlining budget and boxed every frame.
    const e0 = snap + hold, e1 = snap + hold + rel;
    const x = d < snap ? Math.min(1, Math.max(0, (d - 0) / (snap - 0))) : Math.min(1, Math.max(0, (d - e0) / (e1 - e0)));
    const e = x * x * (3 - 2 * x);
    return amp * (d < snap ? e : d < e0 ? 1 : 1 - e);
  }
  // Noise/twitch channel tables: each group is sampled from one call site in a loop, so V8 inlines the sampler once
  // instead of boxing doubles across repeated calls. NZ is shared scratch (single-threaded, consumed immediately).
  const NZ = new Float64Array(9), NZ_T = 8;
  const FLAIL_F = [1, 1.13, .9, 1.27], FLAIL_O = [0, 5, 9, 2], SKIT_F = [1, .83, 1.21, 1], SKIT_O = [0, 3, 7, 11];
  const LOOK_F = [.13, .17, .3, .55], LOOK_C = [1, 2, 3, 51], SCR_F = [1, 1.1], SCR_O = [0, 4];
  // Twitch rows [time offset, period, probability, snap, hold, channel]: idle head/arm, stare micro-twitches (2),
  // sprint head jerks (2), then death spasms (3).
  const TW = [[0, 2.6, .5, .05, .18, 70], [1.3, 3.4, .45, .04, .1, 72], [0, .45, .55, .025, .05, 74], [.2, .6, .5, .03, .06, 75],
    [0, .7, .55, .035, .07, 77], [.31, .9, .5, .035, .08, 78], [0, .38, .7, .03, .05, 90], [.13, .46, .6, .03, .06, 91],
    [.27, .55, .55, .04, .07, 92], [0, .3, .8, .02, .07, 93], [.11, .37, .75, .02, .06, 94], [.2, .43, .7, .025, .05, 95]];
  function twitches(from, n, sh) {
    const t = NZ[NZ_T];
    for (let q = 0; q < n; q++) { const w = TW[from + q]; NZ[q] = twitch(t + w[0], w[1], w[2], w[3], w[4], w[5], sh); }
  }

  function seeded(seed) {
    let s = seed | 0;
    return function () {
      s = s + 0x6D2B79F5 | 0;
      let t = Math.imul(s ^ s >>> 15, 1 | s);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  // Exact damped-spring step coefficients (x'' = -w^2 x - 2 z w x'), zeta <= 1.
  function springCoef(m, o, w, z, dt) {
    if (z >= .999) {
      const e = Math.exp(-w * dt);
      m[o] = e * (1 + w * dt); m[o + 1] = e * dt; m[o + 2] = -e * w * w * dt; m[o + 3] = e * (1 - w * dt); return;
    }
    const wd = w * Math.sqrt(1 - z * z), e = Math.exp(-z * w * dt), c = Math.cos(wd * dt), s = Math.sin(wd * dt) / wd, zw = z * w;
    m[o] = e * (c + zw * s); m[o + 1] = e * s; m[o + 2] = -e * w * w * s; m[o + 3] = e * (c - zw * s);
  }

  // Floor contact. Only world height matters, so each frame carries just its world "up" row (a 3-vector): the root's is
  // the y row of YXZ(pitch, yaw, roll), which yaw leaves alone; a child's is that row times the joint's XYZ matrix.
  // RV holds four frame rows (0, 3, 6, 9), then scalar slots: helpers take only integers and exchange doubles here
  // (double arguments and return values of calls V8 does not inline would be boxed on every frame).
  const RV = new Float64Array(19), TMP = new Float64Array(CH), R_SCALE = 12, R_LOW = 13, R_ANG = 14, R_Y0 = 17, R_ELL = 18;
  // Row of frame o = row of frame src times the XYZ rotation RV[R_ANG..R_ANG+2].
  function rowEuler(o, src) {
    const vx = RV[src], vy = RV[src + 1], vz = RV[src + 2], x = RV[R_ANG], y = RV[R_ANG + 1], z = RV[R_ANG + 2];
    const a = Math.cos(x), b = Math.sin(x), c = Math.cos(y), d = Math.sin(y), e = Math.cos(z), f = Math.sin(z);
    RV[o] = vx * c * e + vy * (a * f + b * e * d) + vz * (b * f - a * e * d);
    RV[o + 1] = -vx * c * f + vy * (a * e - b * f * d) + vz * (b * e + a * f * d);
    RV[o + 2] = vx * d - vy * b * c + vz * a * c;
  }
  function angles(ch, j, rest) {
    RV[R_ANG] = rest ? rest[0] + ch[j] : ch[j]; RV[R_ANG + 1] = rest ? rest[1] + ch[j + 1] : ch[j + 1];
    RV[R_ANG + 2] = rest ? rest[2] + ch[j + 2] : ch[j + 2];
  }
  // Lowest point (into RV[R_ELL]) of the ellipsoid E[i..i+5] (centre, semi-axes) in frame o, origin at height RV[R_Y0].
  function ell(o, E, i) {
    const vx = RV[o], vy = RV[o + 1], vz = RV[o + 2], ax = E[i + 3] * vx, ay = E[i + 4] * vy, az = E[i + 5] * vz;
    RV[R_ELL] = RV[R_Y0] + RV[R_SCALE] * (vx * E[i] + vy * E[i + 1] + vz * E[i + 2] - Math.sqrt(ax * ax + ay * ay + az * az));
  }
  // Lowest point of a posed rig (channels ch, scale RV[R_SCALE]) with the root at height 0, written to RV[R_LOW].
  // parts (optional) receives the minimum per part: torso, legL, legR, armL, armR, head.
  function lowestCh(R, ch, parts) {
    const s = RV[R_SCALE], cp = Math.cos(ch[RP]);
    RV[0] = cp * Math.sin(ch[RR]); RV[1] = cp * Math.cos(ch[RR]); RV[2] = -Math.sin(ch[RP]);
    const Tp = R.torso;
    let lo = Infinity, part = Infinity;
    for (let i = 0; i < Tp.length; i += 3) { const y = RV[0] * Tp[i] + RV[1] * Tp[i + 1] + RV[2] * Tp[i + 2]; if (y < part) part = y; }
    part *= s;
    if (parts) parts[0] = part;
    lo = part;
    for (let k = 0; k < 4; k++) {
      const leg = k < 2, o = (k & 1) * 3;
      const jo = leg ? (o ? LR : LL) : (o ? AR : AL), dj = leg ? (o ? KR : KL) : (o ? ER : EL);
      const P = leg ? R.hips : R.shoulders, B = leg ? R.knees : R.elbows, E = leg ? R.ankles : R.wrists;
      const w = (leg ? R.legW : R.armW) * s, X = leg ? R.foot : R.hand;
      const yP = s * (RV[0] * P[o] + RV[1] * P[o + 1] + RV[2] * P[o + 2]);
      angles(ch, jo, null); rowEuler(3, 0);
      const yB = yP + s * (RV[3] * B[o] + RV[4] * B[o + 1] + RV[5] * B[o + 2]);
      angles(ch, dj, null); rowEuler(6, 3);
      const yE = yB + s * (RV[6] * E[o] + RV[7] * E[o + 1] + RV[8] * E[o + 2]);
      RV[R_Y0] = yE; ell(6, X, 0);
      part = Math.min(yP - w, yB - .75 * w, yE - .45 * w, RV[R_ELL]);
      if (parts) parts[1 + k] = part;
      if (part < lo) lo = part;
    }
    const N = R.neck, nr = R.neckRest, hr = R.headRest, F = R.face, Jw = R.jaw, NL = R.neckLow;
    const yN = s * (RV[0] * N[0] + RV[1] * N[1] + RV[2] * N[2]);
    angles(ch, NK, nr); rowEuler(3, 0);
    part = NL ? yN + s * (RV[4] * NL[0] + RV[5] * NL[1] - NL[2]) : Infinity;
    angles(ch, HD, hr); rowEuler(6, 3);
    RV[R_Y0] = yN; ell(6, R.skull, 0);
    part = Math.min(part, RV[R_ELL], yN + s * (RV[7] * F[0] + RV[8] * F[1] - F[2]));
    if (Jw) {
      const yJ = yN + s * (RV[6] * Jw[0] + RV[7] * Jw[1] + RV[8] * Jw[2]);
      RV[R_ANG] = Jw[3] + ch[JW]; RV[R_ANG + 1] = ch[JW + 1]; RV[R_ANG + 2] = ch[JW + 2]; rowEuler(9, 6);
      part = Math.min(part, yJ + s * (RV[11] * Jw[5] - RV[10] * Jw[4] - .03));
    }
    if (parts) parts[5] = part;
    RV[R_LOW] = part < lo ? part : lo;
  }

  // Hit-reaction spring slots: [group, omega, zeta]; groups share coefficients.
  const SPRINGS = [[0, 12, .45], [1, 16, .38], [2, 10, .35], [3, 14, .5], [4, 9, .7]];
  const S_PITCH = 0, S_ROLL = 1, S_X = 2, S_Z = 3, S_NECKX = 4, S_NECKZ = 5, S_ARMX = 6, S_ARMZ = 7, S_JAW = 8, S_KNEE = 9, S_N = 10;
  const S_GROUP = [0, 0, 4, 4, 1, 1, 2, 2, 3, 4];
  // Per-instance float state slots: clock, gait phase/cadence, smoothed speed (+velocity) and turn, state weights,
  // event timers, mouth, step intensity and death clock. The rest are per-frame scratch values handed between update
  // stages (passing doubles as arguments would box them).
  const I_CLOCK = 0, I_PHASE = 1, I_CAD = 2, I_SPD = 3, I_SPDV = 4, I_TURN = 5, I_MOVE = 6, I_STALK = 7, I_CHASE = 8;
  const I_SEARCH = 9, I_WATCH = 10, I_LUNGE = 11, I_STAG = 12, I_ATK = 13, I_SCR = 14, I_MOUTH = 15, I_STEP = 16;
  const I_DEATH = 17, I_DT = 18, I_T = 19, I_SIN = 20, I_TURNIN = 21, I_LUNGEIN = 22, I_STAGIN = 23, I_RUN = 24;
  const I_STRIDE = 25, I_ROFF = 26, I_FREEZE = 27, I_BANK = 28, I_TD = 29, I_RISE = 30, I_RDUR = 31, I_RLOW = 32, I_N = 33;
  const DQ_ROWS = 5, DQ_OUT = DQ_ROWS * 6;
  const S_LIMIT = [.75, .6, .35, .35, 1.25, .8, 1.1, .9, .7, .9];

  function create(kind, opts) {
    const name = Object.prototype.hasOwnProperty.call(KINDS, kind) ? kind : 'stalker', K = KINDS[name];
    opts = opts && typeof opts === 'object' ? opts : EMPTY;
    const seed = (Math.floor(num(opts.seed)) | 0) ^ 0x2c9277b5;
    const H = positive(opts.height, K.height), scale = H / K.height;
    const walkS = positive(opts.walkSpeed, K.walk), chaseS = Math.max(walkS * 1.25, positive(opts.chaseSpeed, K.chase));
    const hipH = K.hip * scale, legL = K.leg * scale, quad = K.quad, rig = RIGS[name], pivotZ = quad ? -.1 * scale : 0;

    // lay: the pose a rising body left the floor in (read only while ms[I_RDUR] > 0, so reset() leaves it alone).
    const c = new Float64Array(CH), cur = new Float64Array(CH), from = new Float64Array(CH), lay = new Float64Array(CH);
    const sx = new Float64Array(S_N), sv = new Float64Array(S_N), coef = new Float64Array(SPRINGS.length * 4 + 4);
    // Death keyframe rows [t1, v1, t2, v2, t3, v3] (set by startDeath), then each row's current value.
    const dq = new Float64Array(DQ_OUT + DQ_ROWS);
    // Pose fields start as doubles (-0) so V8 keeps them unboxed; reset() overwrites them before anyone reads them.
    const joints = {};
    for (let i = 0; i < JOINTS.length; i++) joints[JOINTS[i]] = { x: -0, y: -0, z: -0 };
    const pose = { joints, root: { x: -0, y: -0, z: -0, pitch: -0, yaw: -0, roll: -0 }, footstep: 0, stepIntensity: -0, mouth: -0 };
    const J = JOINTS.map(n => joints[n]);

    // Per-frame float state lives in a typed array: closure variables would box a new number on every write.
    const ms = new Float64Array(I_N);
    let rand, attackSide, screamDur, effectsLast, footsteps;
    let dying, settled, mode, sgn, twist, fx, fz, rollF, headTurn, headshot, Tfall, side2, limp, tilt0, keyRows = 0;

    function reset() {
      rand = seeded(seed);
      ms.fill(0);
      ms[I_PHASE] = rand(); ms[I_CAD] = K.cadence[0];
      ms[I_ATK] = -1; attackSide = rand() < .5 ? -1 : 1; ms[I_SCR] = -1; screamDur = 1.2; effectsLast = true;
      footsteps = 0;
      dying = false; settled = false; mode = MODES.alive; sgn = -1; twist = 0; fx = 0; fz = -1;
      rollF = 0; headTurn = 0; headshot = false; Tfall = 1; side2 = 1;
      limp = .9 + rand() * .2; tilt0 = (rand() - .5) * .16;
      c.fill(0); cur.fill(0); from.fill(0); sx.fill(0); sv.fill(0);
      writePose(0);
    }

    function biped(effects) {
      const k = K, mv = ms[I_MOVE], st = ms[I_STALK], T = ms[I_T], run = ms[I_RUN], A = ms[I_STRIDE], rOff = ms[I_ROFF];
      const sig = lerp(k.stance[0], k.stance[1], run);
      const kSw = lerp(k.knee[0], k.knee[1], run) * (1 + (k.stalk.lift - 1) * st) * mv;
      const kLd = lerp(k.load[0], k.load[1], run) * mv;
      const pL = ms[I_PHASE], pR = ms[I_PHASE] - rOff < 0 ? ms[I_PHASE] - rOff + 1 : ms[I_PHASE] - rOff;
      // Leg cycle (p = 0 at the heel strike): linear stance sweep (planted foot), eased swing with knee lift.
      for (let side = 0; side < 2; side++) {
        const p = side ? pR : pL, a = side ? A : A * limp;
        if (p < sig) { const u = p / sig; c[side ? LR : LL] += -a + 2 * a * u; c[side ? KR : KL] += kLd * Math.sin(PI * u); }
        else {
          const u = (p - sig) / (1 - sig);
          c[side ? LR : LL] += a - 2 * a * (.5 - .5 * Math.cos(PI * u)); c[side ? KR : KL] += kSw * Math.sin(PI * Math.pow(u, .78));
        }
      }
      // Arms counter-swing their own side's leg with a pendulum lag; elbows curl as the arm comes forward.
      const armA = lerp(k.arm[0], k.arm[1], run) * mv * (1 - .5 * st), lag = k.lag;
      const aL = Math.cos(TAU * (pL - lag)), aR = Math.cos(TAU * (pR - lag));
      const reach = lerp(k.reach[0], k.reach[1], run) * mv * (.55 + .45 * ms[I_CHASE]);
      const elb = lerp(k.elbow[0], k.elbow[1], run) * mv, eSw = k.elbowSwing * mv;
      c[AL] += reach + armA * aL; c[AR] += reach + armA * aR;
      c[EL] += elb + eSw * Math.min(0, aL); c[ER] += elb + eSw * Math.min(0, aR);
      const spread = lerp(k.spread[0], k.spread[1], run) * mv;
      c[AL + 2] -= spread; c[AR + 2] += spread;
      // Flailing: smooth irregular noise; it only snaps hard with effects on.
      const fl = lerp(k.flail[0], k.flail[1], run) * mv * (.6 + .4 * ms[I_CHASE]);
      if (fl > 0) {
        const hz = effects ? 3.1 : 1.6;
        for (let q = 0; q < 4; q++) NZ[q] = gnoise(T * hz * FLAIL_F[q] + FLAIL_O[q], 31 + q, seed);
        const n1 = NZ[0], n2 = NZ[1], n3 = NZ[2], n4 = NZ[3];
        if (name === 'shrieker') {
          c[AL + 2] -= fl * (.6 + .6 * n1); c[AR + 2] += fl * (.6 + .6 * n2);
          c[AL] += fl * .8 * n3; c[AR] += fl * .8 * n4; c[EL] -= fl * .5 * (1 + n2); c[ER] -= fl * .5 * (1 + n1);
        } else {
          c[AL] += fl * n1; c[AR] += fl * n2; c[AL + 2] -= fl * .45 * (.5 + .5 * n3); c[AR + 2] += fl * .45 * (.5 + .5 * n4);
          c[EL] -= fl * .6 * (1 + n3); c[ER] -= fl * .6 * (1 + n4);
        }
      }
      // Root: footfall dip, weight shift over the stance foot, shoulder roll and twist.
      const u = pL < rOff ? pL / rOff : (pL - rOff) / (1 - rOff), d = dipCurve(u, .22) * mv;
      const sL = Math.sin(TAU * pL);
      c[RY] -= lerp(k.dip[0], k.dip[1], run) * scale * d;
      c[RX] -= lerp(k.sway[0], k.sway[1], run) * scale * sL * mv;
      c[RR] += lerp(k.roll[0], k.roll[1], run) * sL * mv;
      c[RP] += lerp(k.nod[0], k.nod[1], run) * d;
      c[RW] -= lerp(k.twist[0], k.twist[1], run) * Math.cos(TAU * pL) * mv;
      c[NK] -= k.steady * lerp(k.nod[0], k.nod[1], run) * d;
      c[JW] += .1 * lerp(k.jaw[0], k.jaw[1], run) * d;
    }

    // Crawler: diagonal pairs (legL + armR, legR + armL); limbs lift outward and tuck in the swing, sweep in stance.
    function crawler(effects) {
      const k = K, mv = ms[I_MOVE], st = ms[I_STALK], T = ms[I_T], run = ms[I_RUN];
      const sig = lerp(k.stance[0], k.stance[1], run), lift = 1 + (k.stalk.lift - 1) * st;
      const sw = lerp(k.sweep[0], k.sweep[1], run) * mv, lf = lerp(k.lift[0], k.lift[1], run) * mv * lift;
      const tk = lerp(k.tuck[0], k.tuck[1], run) * mv * lift, al = lerp(k.armLift[0], k.armLift[1], run) * mv * lift;
      const pA = ms[I_PHASE], pB = ms[I_PHASE] < .5 ? ms[I_PHASE] + .5 : ms[I_PHASE] - .5;
      // Pair cycle: sweep back through the stance, lift (outward and tucked) through the swing.
      for (let pair = 0; pair < 2; pair++) {
        const p = pair ? pB : pA;
        let sweep, up;
        if (p < sig) { const u = p / sig; sweep = 1 - 2 * u; up = 0; }
        else { const u = (p - sig) / (1 - sig); sweep = -1 + 2 * (.5 - .5 * Math.cos(PI * u)); up = Math.pow(Math.sin(PI * u), .8); }
        if (pair === 0) {                                   // legL + armR
          c[LL] -= sweep * sw * limp; c[LL + 2] -= up * lf; c[KL] -= up * tk;
          c[AR] -= up * al + sweep * k.armSweep * mv; c[AR + 2] += up * lf * .5; c[ER] -= up * tk * .5;
        } else {                                            // legR + armL
          c[LR] -= sweep * sw; c[LR + 2] += up * lf; c[KR] -= up * tk;
          c[AL] -= up * al + sweep * k.armSweep * mv; c[AL + 2] -= up * lf * .5; c[EL] -= up * tk * .5;
        }
      }
      const u = pA < .5 ? pA * 2 : pA * 2 - 1, d = dipCurve(u, .25) * mv;
      c[RY] -= lerp(k.dip[0], k.dip[1], run) * scale * d + lerp(k.low[0], k.low[1], run) * scale * mv;
      c[RR] += lerp(k.roll[0], k.roll[1], run) * Math.sin(TAU * pA) * mv;
      c[RP] += lerp(k.nod[0], k.nod[1], run) * d + lerp(k.lean[0], k.lean[1], run) * mv;
      const wig = lerp(k.wiggle[0], k.wiggle[1], run) * Math.sin(TAU * pA + .6) * mv;
      c[RW] += wig; c[NK + 1] -= wig * .8;
      // Erratic skitter jitter: twitchy with effects, a slow drift otherwise.
      const j = k.jitter * (.35 + .65 * mv), hz = effects ? 7.3 : 1.4, ja = effects ? 1 : .35, hzLook = effects ? 2.3 : .7;
      for (let q = 0; q < 4; q++) NZ[q] = gnoise(T * (q < 3 ? hz : hzLook) * SKIT_F[q] + SKIT_O[q], 41 + q, seed);
      c[RR] += j * ja * NZ[0];
      c[RW] += j * 1.3 * ja * NZ[1];
      c[RX] += j * .5 * ja * scale * NZ[2];
      c[NK + 1] += k.look * .6 * ja * NZ[3] * (.4 + .6 * mv);
    }

    // Root pivot: rotate the body about (0, h, z0) (the hips; the crawler's body centre) instead of the feet.
    function pivot() {
      const h = hipH, z0 = pivotZ, p = c[RP], r = c[RR], w = c[RW];
      const X = -h * Math.sin(r), Y0 = h * Math.cos(r), Z0 = z0;
      const Y = Y0 * Math.cos(p) - Z0 * Math.sin(p), Z = Y0 * Math.sin(p) + Z0 * Math.cos(p);
      const cw = Math.cos(w), sw = Math.sin(w);
      c[RX] += 0 - (X * cw + Z * sw); c[RY] += h - Y; c[RZ] += z0 - (-X * sw + Z * cw);
    }

    // The live pose is built in stages that hand doubles over through ms (as arguments they would be boxed); each
    // stage is its own optimisation unit, so its small helpers inline.
    function alive(state, watched, effects) {
      const foot = drivers(state, watched);
      for (let i = 0; i < CH; i++) c[i] = 0;
      if (quad) crawler(effects); else biped(effects);
      posture(effects);
      actions(effects);
      if (effects) life();
      reactions();
      // Plant events: the warden's stomp carries; stalking creeps are quiet.
      ms[I_STEP] = 0;
      if (foot) {
        footsteps++;
        ms[I_STEP] = clamp(lerp(K.steps[0], K.steps[1], ms[I_RUN]) * (1 - .55 * ms[I_STALK]) * (1 + .2 * ms[I_LUNGE]), .05, 1);
      }
      return foot;
    }

    // Smoothed drivers (exact closed forms), gait phase and plant events (+1 left, -1 right).
    function drivers(state, watched) {
      const dt = ms[I_DT], sIn = ms[I_SIN], m = coef;
      springCoef(m, SPRINGS.length * 4, 9, 1, dt);
      const o4 = SPRINGS.length * 4, e0 = ms[I_SPD] - sIn;
      ms[I_SPD] = sIn + m[o4] * e0 + m[o4 + 1] * ms[I_SPDV]; ms[I_SPDV] = m[o4 + 2] * e0 + m[o4 + 3] * ms[I_SPDV];
      if (ms[I_SPD] < 0) { ms[I_SPD] = 0; if (ms[I_SPDV] < 0) ms[I_SPDV] = 0; }
      const s = ms[I_SPD], lunge = ms[I_LUNGEIN] > 0, stag = ms[I_STAGIN] > 0;
      ms[I_TURN] = ease(ms[I_TURN], clamp(ms[I_TURNIN], -5, 5), 7, dt);
      ms[I_STALK] = ease(ms[I_STALK], state === 1 ? 1 : 0, 4, dt);
      ms[I_SEARCH] = ease(ms[I_SEARCH], state === 2 ? 1 : 0, 3, dt);
      ms[I_CHASE] = ease(ms[I_CHASE], state === 3 ? 1 : 0, 3.5, dt);
      ms[I_WATCH] = ease(ms[I_WATCH], watched ? 1 : 0, watched ? 12 : 3, dt);
      ms[I_LUNGE] = ease(ms[I_LUNGE], lunge ? 1 : 0, lunge ? 16 : 5, dt);
      ms[I_STAG] = ease(ms[I_STAG], stag ? 1 : 0, stag ? 18 : 4.5, dt);
      ms[I_MOVE] = smooth(.06 * walkS, .55 * walkS, s);
      const run = ms[I_RUN] = smooth(walkS * 1.05, chaseS * .92, s);
      const over = clamp((s - chaseS) / (chaseS * .5), 0, 1);
      const cd = K.cadence;
      const base = s <= walkS ? cd[0] + (cd[1] - cd[0]) * s / walkS : Math.min(cd[3], cd[1] + (cd[2] - cd[1]) * (s - walkS) / (chaseS - walkS));
      ms[I_CAD] = base * (1 + (K.stalk.cadence - 1) * ms[I_STALK]) * (1 + .12 * over);
      const rOff = ms[I_ROFF] = quad ? .5 : .5 - K.lope * run;
      const prev = ms[I_PHASE];
      ms[I_PHASE] += ms[I_CAD] * .5 * dt;
      let foot = 0;
      if (ms[I_PHASE] >= 1) { ms[I_PHASE] -= 1; foot = 1; }
      else if (prev < rOff && ms[I_PHASE] >= rOff) foot = -1;
      if (foot && (ms[I_MOVE] < .35 || s < .25 || ms[I_WATCH] > .6)) foot = 0;
      // Stride: angle that roughly keeps a planted foot still, capped; lunges stretch it.
      ms[I_STRIDE] = quad ? 0 : Math.min(K.stride * s / (Math.max(.3, ms[I_CAD]) * legL), K.hipMax * (1 + .3 * ms[I_LUNGE])) * ms[I_MOVE] * (1 + .2 * ms[I_STALK]);
      return foot;
    }

    // Lean, stalk crouch, idle life (breathing, head tracking, slack jaw, frozen under a stare) and turn banking.
    function posture(effects) {
      const T = ms[I_T], run = ms[I_RUN], s = ms[I_SPD];
      // Lean (forward with speed, hunched when stalking) about the hips; legs counter-rotate to stay under it.
      const lean = quad ? 0 : lerp(K.lean[0], K.lean[1], run) * ms[I_MOVE] + K.stalk.lean * ms[I_STALK] + .06 * ms[I_SEARCH];
      c[RP] += lean;
      if (!quad) {
        c[NK] += K.neck * (1 - .6 * run) - K.steady * lean * .8;
        // Stalk crouch: hips flex, knees fold twice as far; the root sinks so the feet stay planted.
        const cr = K.stalk.crouch * ms[I_STALK] + .1 * ms[I_STAG];
        c[LL] -= cr; c[LR] -= cr; c[KL] += 2 * cr; c[KR] += 2 * cr; c[RY] -= legL * (1 - Math.cos(cr));
        c[NK + 2] += K.stalk.tilt * ms[I_STALK]; c[NK] += K.stalk.look * ms[I_STALK];
        c[AL] += K.stalk.reach * ms[I_STALK]; c[AR] += K.stalk.reach * ms[I_STALK] * .8;
        c[EL] += K.stalk.claw * ms[I_STALK]; c[ER] += K.stalk.claw * ms[I_STALK] * 1.1;
      } else {
        c[RY] -= K.stalk.low * scale * ms[I_STALK]; c[NK] += K.stalk.look * ms[I_STALK];
        c[LL + 2] -= K.stalk.splay * ms[I_STALK]; c[LR + 2] += K.stalk.splay * ms[I_STALK];
        c[AL + 2] -= K.stalk.splay * ms[I_STALK]; c[AR + 2] += K.stalk.splay * ms[I_STALK];
      }
      const freeze = ms[I_FREEZE] = ms[I_WATCH] * (1 - ms[I_MOVE]);
      const breathP = K.breath / (1 + .6 * ms[I_CHASE]), br = Math.sin(TAU * T / breathP + seed * 1e-3);
      const bA = K.breathAmp * (1 - .6 * ms[I_MOVE]) * (1 - .75 * freeze) * (1 + .5 * ms[I_CHASE]);
      c[AL + 2] -= bA * (.6 + .4 * br); c[AR + 2] += bA * (.6 + .4 * br);
      c[RY] += bA * .25 * scale * br; c[RP] -= bA * .4 * br; c[NK] -= bA * .5 * br;
      const look = K.look * (1 - .7 * ms[I_CHASE]) * (1 - freeze) * (1 - .5 * ms[I_MOVE]);
      for (let q = 0; q < 4; q++) NZ[q] = gnoise(T * LOOK_F[q], LOOK_C[q], seed);
      const nThrow = NZ[3];
      c[NK + 1] += look * NZ[0] + .5 * ms[I_SEARCH] * Math.sin(T * 1.7 + seed);
      c[NK] += .08 * NZ[1] * (1 - freeze) + .05 * ms[I_SEARCH] * Math.sin(T * 3.1);
      c[HD + 2] += tilt0 + .25 * freeze * (name === 'stalker' ? 1 : .5);
      const slack = quad ? 0 : lerp(K.jaw[0], K.jaw[1], ms[I_CHASE]) + .04 * NZ[2];
      c[JW] += slack + (quad ? 0 : .3 * bA / K.breathAmp * .05 * (br + 1));
      // Banking: roll into turns, body lags, head leads.
      const bank = ms[I_BANK] = clamp(-ms[I_TURN] * Math.min(s, chaseS * 1.2) * K.bankGain, -K.bank, K.bank);
      c[RR] += bank; c[RW] -= clamp(ms[I_TURN] * .03, -.12, .12); c[NK + 1] += clamp(ms[I_TURN] * .12, -.35, .35);
      // Shrieker: head intermittently thrown back mid-chase.
      if (name === 'shrieker') {
        const g = smooth(.25, effects ? .45 : .7, nThrow) * ms[I_CHASE] * (.4 + .6 * ms[I_MOVE]);
        c[NK] -= .7 * g; c[HD] -= .2 * g; c[JW] += .45 * g;
      }
    }

    // Lunge, scream, attack and stagger layers.
    function actions(effects) {
      const dt = ms[I_DT];
      // Lunge: drop, drive forward, both arms thrust out, jaw wide, head up to keep the prey in sight.
      if (ms[I_LUNGE] > 1e-4) {
        const L = K.lunge, w = ms[I_LUNGE];
        if (quad) {
          c[RY] += L.rise * scale * w; c[RZ] += L.surge * scale * w; c[RP] += L.pitch * w; c[NK] += L.neck * w;
          c[AL] += (L.arms - c[AL]) * w * .85; c[AR] += (L.arms - c[AR]) * w * .85;
          c[EL] -= .35 * w; c[ER] -= .35 * w; c[LL] += L.legs * w; c[LR] += L.legs * w;
        } else {
          c[RY] -= L.drop * scale * w; c[RP] += L.pitch * w; c[NK] += L.neck * w;
          // L.arms is the thrust angle in world terms: the target compensates the torso pitch. Flails are drawn in.
          const ax = L.arms - c[RP];
          c[AL] += (ax - c[AL]) * w * .88; c[AR] += (ax - c[AR]) * w * .88;
          c[AL + 2] += (-L.spread - c[AL + 2]) * w * .88; c[AR + 2] += (L.spread - c[AR + 2]) * w * .88;
          c[EL] += (L.elbow - c[EL]) * w * .8; c[ER] += (L.elbow - c[ER]) * w * .8;
          c[JW] += L.jaw * w;
        }
      }
      // Scream: inhale, then head thrown back, jaw wide, arms spread, body shudder.
      if (ms[I_SCR] >= 0) {
        ms[I_SCR] += dt;
        if (ms[I_SCR] >= screamDur + .05) ms[I_SCR] = -1;
        else {
          const S = K.scream, t = ms[I_SCR], w = smooth(0, .2, t) * (1 - smooth(screamDur - .32, screamDur, t));
          const inhale = bump(t, 0, .24) * .18 * (1 - smooth(.05, .3, t));
          const hz = effects ? 16 : 2.4, sh = S.shudder * (effects ? 1 : .35) * w;
          for (let q = 0; q < 2; q++) NZ[q] = gnoise(t * hz * SCR_F[q] + SCR_O[q], 61 + q, seed);
          const n1 = NZ[0], n2 = NZ[1];
          if (quad) {
            c[RP] += S.rear * w; c[RY] += S.rise * scale * w;
            c[AL] += (S.arms - c[AL]) * w; c[AR] += (S.arms - c[AR]) * w;
            c[AL + 2] -= S.spread * w; c[AR + 2] += S.spread * w; c[EL] -= .5 * w; c[ER] -= .5 * w;
            c[NK] += S.neck * w + inhale; c[RR] += sh * n1; c[AL + 2] += sh * 2 * n2; c[AR + 2] += sh * 2 * n1;
          } else {
            c[NK] += (S.neck - c[NK]) * w + inhale; c[HD] += S.head * w; c[JW] += (S.jaw - c[JW]) * w - inhale * .5;
            c[AL] += (S.arms - c[AL]) * w * .9; c[AR] += (S.arms - c[AR]) * w * .9;
            c[AL + 2] -= S.spread * w; c[AR + 2] += S.spread * w;
            c[EL] += (S.elbow - c[EL]) * w; c[ER] += (S.elbow - c[ER]) * w;
            c[RP] += S.pitch * w; c[RY] += .02 * scale * w;
            c[RR] += sh * n1; c[NK + 2] += sh * 1.6 * n2; c[AL + 2] += sh * 3 * n2; c[AR + 2] += sh * 3 * n1;
            c[JW] += sh * 2 * n1;
          }
        }
      }
      // Attack: one arm winds up overhead and rakes down/across while the jaw snaps shut.
      if (ms[I_ATK] >= 0) {
        ms[I_ATK] += dt;
        const A2 = K.attack, D = A2.dur;
        if (ms[I_ATK] >= D + .2) ms[I_ATK] = -1;
        else {
          const t = ms[I_ATK], w = smooth(0, .07, t) * (1 - smooth(D, D + .2, t));
          const up = smooth(0, D * .35, t), down = smooth(D * .38, D * .62, t);
          if (quad) {
            const x = A2.up * up + (A2.down - A2.up) * down;
            c[AL] += (x - c[AL]) * w; c[AR] += (x - c[AR]) * w; c[EL] -= .4 * w * (up - down); c[ER] -= .4 * w * (up - down);
            c[NK] += (-.3 * up + (A2.neck + .3) * down) * w; c[RP] += (-.12 * up + (A2.lurch + .12) * down) * w;
          } else {
            const a = attackSide < 0 ? AL : AR, e = attackSide < 0 ? EL : ER, o = attackSide < 0 ? -1 : 1;
            const x = A2.up * up + (A2.down - A2.up) * down, z = o * (A2.out * up + (A2.across - A2.out) * down);
            c[a] += (x - c[a]) * w; c[a + 2] += (z - c[a + 2]) * w;
            c[e] += (A2.bend * up + (-.12 - A2.bend) * down - c[e]) * w;
            const other = a === AL ? AR : AL;
            c[other] += (-.5 - c[other]) * w * .5;
            c[NK] += (-.22 * up + .55 * down) * w; c[RP] += (-.07 * up + (A2.lurch + .07) * down) * w;
            c[JW] += (A2.jaw * up * (1 - down) - c[JW] * down * .8) * w;
          }
        }
      }
      // Stagger: knees buckle and wobble (a slow sway when effects are off).
      if (ms[I_STAG] > 1e-4) {
        const wob = effects ? Math.sin(ms[I_CLOCK] * TAU * 7.5) * .14 : Math.sin(ms[I_CLOCK] * TAU * 2.2) * .05;
        if (quad) { c[RY] -= .05 * scale * ms[I_STAG]; c[RR] += wob * .6 * ms[I_STAG]; c[KL] += .3 * ms[I_STAG]; c[KR] += .3 * ms[I_STAG]; }
        else {
          c[KL] += (.45 + wob) * ms[I_STAG]; c[KR] += (.45 - wob) * ms[I_STAG]; c[LL] -= .22 * ms[I_STAG]; c[LR] -= .22 * ms[I_STAG];
          c[RY] -= .07 * scale * ms[I_STAG]; c[RR] += wob * .3 * ms[I_STAG];
        }
      }
    }

    // Effects-only life: twitches, head jerks while sprinting, micro-twitches under a stare.
    function life() {
      const T = ms[I_T], freeze = ms[I_FREEZE], run = ms[I_RUN];
      NZ[NZ_T] = T; twitches(0, 6, seed);
      const tw = NZ[0] * (1 - ms[I_MOVE]) * (1 - .6 * freeze);
      c[NK + 2] += .3 * tw; c[NK] += .12 * tw;
      const ar = NZ[1] * (1 - ms[I_MOVE]);
      c[AL + 2] -= .14 * ar; c[EL] -= .25 * ar;
      if (freeze > .01) {
        const m1 = NZ[2], m2 = NZ[3];
        c[NK + 2] += .12 * m1 * freeze; c[NK] += .07 * m2 * freeze; c[HD + 1] += .1 * m2 * freeze;
        c[EL] -= .16 * m2 * freeze; c[ER] -= .14 * m1 * freeze; c[AL + 2] -= .05 * m1 * freeze;
      }
      if (!quad && name !== 'warden') {
        const j = NZ[4] * run * ms[I_MOVE];
        c[NK + 1] += .28 * j; c[NK + 2] += .22 * NZ[5] * run * ms[I_MOVE];
      }
    }

    // Hit-reaction springs (impulses from hit()), then the root pivot (bipeds: legs counter-rotate the torso
    // pitch/roll but not the bank, so the feet stay planted under the hips).
    function reactions() {
      const dt = ms[I_DT], m = coef;
      for (let g = 0; g < SPRINGS.length; g++) springCoef(m, g * 4, SPRINGS[g][1], SPRINGS[g][2], dt);
      for (let i = 0; i < S_N; i++) {
        const o = S_GROUP[i] * 4, x = sx[i], v = sv[i], lim = S_LIMIT[i];
        sx[i] = clamp(m[o] * x + m[o + 1] * v, -lim, lim); sv[i] = clamp(m[o + 2] * x + m[o + 3] * v, -40, 40);
        if (sx[i] !== sx[i] || sv[i] !== sv[i]) { sx[i] = 0; sv[i] = 0; }
      }
      c[RP] += sx[S_PITCH]; c[RR] += sx[S_ROLL]; c[RX] += sx[S_X] * scale; c[RZ] += sx[S_Z] * scale;
      c[NK] += sx[S_NECKX]; c[NK + 2] += sx[S_NECKZ]; c[HD] += sx[S_NECKX] * .35;
      c[AL] += sx[S_ARMX]; c[AR] += sx[S_ARMX] * .85; c[AL + 2] -= sx[S_ARMZ]; c[AR + 2] += sx[S_ARMZ];
      c[JW] += Math.max(0, sx[S_JAW]); c[KL] += sx[S_KNEE]; c[KR] += sx[S_KNEE] * .8;
      if (!quad) {
        const lp = c[RP], lr = c[RR] - ms[I_BANK];
        c[LL] -= lp; c[LR] -= lp; c[LL + 2] -= lr; c[LR + 2] -= lr;
      }
      pivot();
    }

    // --- death ---------------------------------------------------------------------------------------------------
    function startDeath(o) {
      if (dying) return;
      o = o && typeof o === 'object' ? o : EMPTY;
      const yaw = num(o.yaw), dx = num(o.dirX), dz = num(o.dirZ);
      let lx = dx * Math.cos(yaw) - dz * Math.sin(yaw), lz = dx * Math.sin(yaw) + dz * Math.cos(yaw);
      const len = Math.hypot(lx, lz);
      if (len < 1e-6) { lx = 0; lz = -1; } else { lx /= len; lz /= len; }
      dying = true; ms[I_DEATH] = 0; ms[I_RDUR] = 0; settled = false; headshot = flag(o.headshot);
      for (let i = 0; i < CH; i++) from[i] = cur[i];
      const D = K.death;
      side2 = rand() < .5 ? -1 : 1;
      if (quad) {
        mode = MODES.roll; Tfall = headshot ? D.hsT : D.T;
        // Roll so the top moves along the bullet's sideways push (top toward +x needs negative roll).
        sgn = Math.abs(lx) > .25 ? (lx > 0 ? -1 : 1) : side2;
        fx = lx; fz = lz; twist = clamp(lx * lz, -.5, .5) * .6;
      } else {
        const front = lz > .12 ? true : lz < -.12 ? false : side2 > 0;
        mode = front ? MODES.front : MODES.back; sgn = front ? 1 : -1;
        twist = clamp(front ? Math.atan2(lx, lz) : Math.atan2(-lx, -lz), -D.twist, D.twist);
        fx = front ? Math.sin(twist) : -Math.sin(twist); fz = front ? Math.cos(twist) : -Math.cos(twist);
        Tfall = headshot ? D.hsT : D.T;
      }
      rollF = (rand() - .5) * .14; headTurn = (rand() < .5 ? -1 : 1) * (.8 + .2 * rand());
      // Keyframed channels, evaluated by deathPose every frame: the crawler's neck; a biped's arms (x), elbows, neck,
      // jaw and arm spread (z).
      const T = Tfall;
      if (quad) { keyRows = 1; key(0, .1, -.5, T, -.2, T + .3, -.35); return; }
      const F = sgn > 0 ? D.front : D.back, front = sgn > 0, neckF = F.neck[headTurn < 0 ? 0 : 1];
      keyRows = 5;
      if (headshot) {
        key(0, .15, front ? .1 : -.15, T * .8, front ? .3 : -.55, T + .12, F.arms);
        key(1, .2, -.2, T, -.45, T + .2, F.elbows);
        key(2, .06, front ? .45 : -.9, T * .7, front ? -.2 : -.35, T + .15, neckF);
        key(3, .08, .7, T, .6, T + .2, .5);
      } else if (front) {
        key(0, .16, .35, T * .85, .45, T + .12, F.arms);
        key(1, .2, -.7, T * .85, -.4, T + .2, F.elbows);
        key(2, .1, -.5, T * .7, -.3, T + .15, neckF);
        key(3, .12, .62, T, .55, T + .2, .38);
      } else {
        key(0, .16, -1, T * .8, -1.35, T + .12, F.arms);
        key(1, .2, -.7, T * .8, -.55, T + .2, F.elbows);
        key(2, .1, -.45, T * .7, -.22, T + .15, neckF);
        key(3, .12, .62, T, .55, T + .2, .42);
      }
      key(4, .16, headshot ? .12 : .35, T * .8, .3, T + .15, .72 + .08 * side2);
    }
    // Keyframe row r: 0 at t = 0, then each value eased in over [previous key time, its key time].
    function key(r, t1, v1, t2, v2, t3, v3) {
      const o = r * 6;
      dq[o] = t1; dq[o + 1] = v1; dq[o + 2] = t2; dq[o + 3] = v2; dq[o + 4] = t3; dq[o + 5] = v3;
    }

    // Biped: recoil away from the shot, knees buckle (first and hardest on a headshot), an accelerating topple with
    // the arms trailing, a floor impact with a small rebound, then a fitted corpse pose. Height comes from the floor
    // contact in deathPose, so the body always rests on whatever touches first (toes, knees, chest).
    function bipedDeath(effects) {
      const t = ms[I_TD], D = K.death, F = sgn > 0 ? D.front : D.back, T = Tfall, hs = headshot, front = sgn > 0;
      const tr = hs ? .2 : .14, psiR = hs ? .05 : D.recoil, tilt = F.tilt;
      let psi;
      if (t < tr) { const u = t / tr; psi = psiR * (hs ? u * u : 1 - (1 - u) * (1 - u)); }
      else if (t < T) psi = psiR + (tilt - psiR) * Math.pow((t - tr) / (T - tr), hs ? 2.5 : 2.2);
      else psi = tilt - D.bounce * bump(t, T, T + .3);
      const land = smooth(T - .04, T + .14, t);
      const cr = (hs ? smooth(0, .2, t) : D.crumple * smooth(.04, .45, t)) * (1 - land);
      c[RP] = sgn * psi; c[RW] = twist * smooth(.05, T + .05, t); c[RR] = rollF * smooth(.1, T, t);
      c[RY] = -D.sink * scale * land;
      const slide = D.slide * scale * smooth(.05, T + .1, t);
      c[RX] = -fx * slide; c[RZ] = -fz * slide;
      // Legs buckle, then settle into the fitted corpse pose.
      c[LL] = -.72 * cr + F.legs * land; c[LR] = -.6 * cr * limp + F.legs * .9 * land;
      c[KL] = cr + F.knees * land; c[KR] = .85 * cr + F.knees * 1.2 * land;
      c[LL + 2] = -.14 * land; c[LR + 2] = .14 * land;
      // Limp arms lag the toppling torso (trailing away from the floor), land just after it and bounce off it.
      const slap = bump(t, T + .06, T + .3) * (front ? .14 : -.14);
      const ax = dq[DQ_OUT], ex = dq[DQ_OUT + 1], nx = dq[DQ_OUT + 2], jw = dq[DQ_OUT + 3], az = dq[DQ_OUT + 4];
      c[AL] = ax + slap; c[AR] = ax * .9 + slap * .8;
      c[AL + 2] = -az; c[AR + 2] = az * .95;
      c[EL] = ex; c[ER] = ex * 1.1;
      c[NK] = nx; c[NK + 1] = (front ? (headTurn < 0 ? -1 : 1) : headTurn) * F.turn * smooth(.2, T + .2, t); c[NK + 2] = .12 * side2 * smooth(0, T, t);
      c[HD] = -.08 * land; c[JW] = jw;
      if (effects) spasms(false);
    }

    // Crawler: a jolt, a quick roll onto its side with a hop, legs folding in (underside first) like a dead insect.
    function crawlerDeath(effects) {
      const t = ms[I_TD], D = K.death, T = Tfall;
      const psi = D.roll * smooth(.06, T, t) - .06 * bump(t, T, T + .28);
      const sp = Math.sin(Math.min(Math.abs(psi), HALF));
      c[RR] = sgn * psi; c[RP] = D.pitch * smooth(0, T, t); c[RW] = twist * smooth(0, T, t);
      c[RY] = D.hop * scale * bump(t, 0, .34) * (1 - sp);
      c[RX] = -sgn * D.slide * scale * smooth(.05, T + .1, t); c[RZ] = fz * .08 * scale * smooth(0, T, t);
      const splay = .35 * bump(t, 0, .3), under = smooth(.04, T * .8, t), over = smooth(.2, T + .4, t);
      // sigma: -1 for L limbs, +1 for R; the underside is the R side when rolling with sgn < 0.
      for (let i = 0; i < 4; i++) {
        const base = i === 0 ? LL : i === 1 ? LR : i === 2 ? AL : AR, dist = i === 0 ? KL : i === 1 ? KR : i === 2 ? EL : ER;
        const sigma = i % 2 ? 1 : -1, down = sigma === -sgn, arm = i > 1, k = down ? under : over;
        const P = down ? D.under : D.over;
        c[base + 2] = sigma * (splay + (P[0] - splay) * k);
        c[base] = (arm ? -1 : 1) * P[1] * k;
        c[dist + 2] = sigma * P[2] * k;
      }
      c[NK] = dq[DQ_OUT]; c[NK + 1] = headTurn * .5 * smooth(.1, T, t);
      c[NK + 2] = .2 * sgn * smooth(0, T, t);
      if (effects) spasms(true);
    }

    // Short death spasms after the body lands (effects only); compact support, so the corpse ends perfectly still.
    function spasms(legs) {
      const t = ms[I_TD], T = Tfall;
      const env = smooth(T + .05, T + .2, t) * (1 - smooth(T + .6, T + 1.6, t));
      if (env <= 0) return;
      NZ[NZ_T] = t; twitches(6, 3, seed ^ 0x51ed27);
      const a = NZ[0] * env, b = NZ[1] * env, d = NZ[2] * env;
      if (legs) {
        c[KL + 2] += .35 * a; c[KR + 2] -= .3 * b; c[EL + 2] += .3 * d; c[ER + 2] -= .35 * a;
        c[LL] += .2 * b; c[AR] += .2 * d;
      } else {
        // Directions that move limbs off the floor: on the back a knee lifts with the foot planted; face down the
        // shin kicks up; arms jerk upward; the head rolls on the floor.
        const A1 = Math.abs(a), B1 = Math.abs(b), D1 = Math.abs(d);
        if (sgn < 0) { c[LL] -= .22 * A1; c[KL] += .44 * A1; c[EL] -= .3 * D1; }
        else { c[KL] += .5 * A1; c[AL + 2] -= .2 * D1; }
        c[AR] += sgn * .25 * B1; c[NK + 2] += .14 * d; c[JW] += .15 * D1;
      }
    }

    function deathPose(effects) {
      ms[I_DEATH] += ms[I_DT];
      if (settled) return;
      const t = ms[I_DEATH], tEnd = Tfall + 1.7;
      for (let i = 0; i < CH; i++) c[i] = 0;
      const td = ms[I_TD] = Math.min(t, tEnd);
      for (let r = 0, o = 0; r < keyRows; r++, o += 6) {
        dq[DQ_OUT + r] = dq[o + 1] * smooth(0, dq[o], td) + (dq[o + 3] - dq[o + 1]) * smooth(dq[o], dq[o + 2], td) +
          (dq[o + 5] - dq[o + 3]) * smooth(dq[o + 2], dq[o + 4], td);
      }
      if (quad) crawlerDeath(effects); else bipedDeath(effects);
      const wb = smooth(0, headshot ? .1 : .16, t);
      for (let i = 0; i < CH; i++) c[i] = from[i] + (c[i] - from[i]) * wb;
      // Rest on the lowest point of the blended pose (the choreography only adds hops, rebounds and sink).
      RV[R_SCALE] = scale;
      lowestCh(rig, c, null);
      c[RY] -= wb * RV[R_LOW];
      if (t >= tEnd) settled = true;
    }

    // Getting up off the floor: the live pose (already in c) is blended in from the pose the body lay in, in fits and
    // starts (a stair-step ease that stalls twice on the way up), with jerks through the neck, arms and knees. Until
    // the last fifth the blend rests on its lowest point, so the body neither sinks into nor floats above the floor.
    function risePose(effects) {
      const d = ms[I_RDUR], t = ms[I_RISE] = Math.min(d, ms[I_RISE] + ms[I_DT]), u = t / d;
      const st = u - Math.sin(TAU * 3 * u) / (TAU * 3), w = st * st * (3 - 2 * st);
      for (let i = 0; i < CH; i++) c[i] = lay[i] + (c[i] - lay[i]) * w;
      if (effects) {
        NZ[NZ_T] = t; twitches(9, 3, seed ^ 0x3a1c55);
        const env = Math.sin(PI * u) * .5;
        c[NK] += .5 * env * NZ[0]; c[NK + 2] += .3 * env * NZ[1];
        c[AL] += .6 * env * NZ[2]; c[AR] -= .5 * env * NZ[1]; c[quad ? KL + 2 : KL] += .4 * env * Math.abs(NZ[2]);
      }
      RV[R_SCALE] = scale;
      lowestCh(rig, c, null);
      const f = u < .8 ? 0 : (u - .8) / .2, hold = 1 - f * f * (3 - 2 * f);
      c[RY] -= hold * (c[RY] + RV[R_LOW] - ms[I_RLOW] * (1 - w));
      if (t >= d) ms[I_RDUR] = 0;
    }

    function writePose(foot) {
      for (let i = 0; i < CH; i++) if (c[i] !== c[i]) c[i] = 0;
      for (let i = 0; i < JOINTS.length; i++) {
        const j = J[i], o = i * 3;
        j.x = clamp(c[o], -PI, PI); j.y = clamp(c[o + 1], -PI, PI); j.z = clamp(c[o + 2], -PI, PI);
      }
      const r = pose.root;
      r.x = clamp(c[RX], -H, H); r.z = clamp(c[RZ], -H, H); r.y = clamp(c[RY], -.2, H);
      r.pitch = clamp(c[RP], -1.7, 1.7); r.roll = clamp(c[RR], -1.7, 1.7); r.yaw = clamp(c[RW], -PI, PI);
      pose.footstep = foot; pose.stepIntensity = foot ? ms[I_STEP] : 0;
      const open = quad ? ms[I_MOUTH] : (c[JW] - K.jaw[0] * .5) / K.jawMax;
      pose.mouth = clamp(open !== open ? 0 : open, 0, 1);
      for (let i = 0; i < CH; i++) cur[i] = c[i];
    }

    function update(dt, inp) {
      dt = clamp(num(dt), 0, .1);
      inp = inp && typeof inp === 'object' ? inp : EMPTY;
      const effects = flag(inp.effects); effectsLast = effects;
      ms[I_CLOCK] += dt;
      // Each input field is read once: through a megamorphic load (callers passing many object shapes) every read
      // of a double field copies it into a new heap number.
      const time = inp.time, dead = inp.dead;
      const T = Number.isFinite(time) ? time + (seed & 1023) * .37 : ms[I_CLOCK] + (seed & 1023) * .37;
      if (flag(dead) && !dying) startDeath(EMPTY);
      else if (!flag(dead) && dying && dead !== undefined && dead !== null) reset();
      ms[I_DT] = dt; ms[I_T] = T;
      if (dying) { deathPose(effects); writePose(0); return pose; }
      const st = STATES[inp.state] || 0;
      ms[I_SIN] = clamp(num(inp.speed), 0, chaseS * 2.2);
      ms[I_LUNGEIN] = clamp(num(inp.lunge), 0, 1); ms[I_STAGIN] = clamp(num(inp.stagger), 0, 3); ms[I_TURNIN] = num(inp.turn);
      let foot = alive(st, flag(inp.watched), effects);
      if (ms[I_RDUR] > 0) { risePose(effects); foot = 0; }
      if (quad) {
        // No jaw: mouth follows lunges, screams, attacks and chase panting.
        let m = .1 * ms[I_CHASE] + .7 * ms[I_LUNGE];
        if (ms[I_SCR] >= 0) m = Math.max(m, smooth(0, .2, ms[I_SCR]) * (1 - smooth(screamDur - .3, screamDur, ms[I_SCR])));
        if (ms[I_ATK] >= 0) m = Math.max(m, bump(ms[I_ATK], 0, K.attack.dur));
        ms[I_MOUTH] = clamp(m, 0, 1);
      }
      writePose(foot);
      return pose;
    }

    function hit(o) {
      if (dying) return;
      o = o && typeof o === 'object' ? o : EMPTY;
      const yaw = num(o.yaw), dx = num(o.dirX), dz = num(o.dirZ);
      let lx = dx * Math.cos(yaw) - dz * Math.sin(yaw), lz = dx * Math.sin(yaw) + dz * Math.cos(yaw);
      const len = Math.hypot(lx, lz);
      if (len < 1e-6) { lx = 0; lz = -1; } else { lx /= len; lz /= len; }
      const strength = o.strength === undefined || o.strength === null ? 1 : clamp(num(o.strength), 0, 1);
      const soft = effectsLast ? 1 : .6, hs = flag(o.headshot);
      const k = strength * K.flinch * soft, kh = strength * (hs ? K.headFlinch : K.flinch) * (effectsLast ? 1 : .45);
      // Pushed along the bullet: from the front the torso snaps back, from the side it rolls away.
      sv[S_PITCH] += lz * 6.5 * k; sv[S_ROLL] -= lx * 5 * k;
      sv[S_X] += lx * .9 * k; sv[S_Z] += lz * .9 * k;
      sv[S_NECKX] += lz * (hs ? 24 : 6) * kh; sv[S_NECKZ] -= lx * (hs ? 10 : 5) * kh;
      sv[S_ARMX] += lz * 5.5 * k; sv[S_ARMZ] += 3 * k; sv[S_JAW] += 7 * k; sv[S_KNEE] += 3.2 * k;
      for (let i = 0; i < S_N; i++) sv[i] = out(sv[i], 40);
    }

    function attack() {
      if (dying) return;
      if (ms[I_ATK] >= 0 && ms[I_ATK] < K.attack.dur * .6) return;
      ms[I_ATK] = 0; attackSide = -attackSide;
    }
    function scream(duration) {
      if (dying) return;
      const d = clamp(positive(duration, 1.2), .4, 4);
      // A request during a scream extends it (no second inhale): to now + d/2, and to d in total when that is longer.
      if (ms[I_SCR] >= 0 && ms[I_SCR] < screamDur) { screamDur = Math.max(screamDur, ms[I_SCR] + d * .5, d); return; }
      ms[I_SCR] = 0; screamDur = d;
    }
    function die(o) { startDeath(o); }
    // Wakes a body (usually a corpse-still sleeper) where it lies: over `duration` seconds it gets up into the live
    // pose that update() drives. Callers stop passing dead: true at the same time.
    function rise(duration) {
      const d = clamp(positive(duration, .9), .3, 3);
      for (let i = 0; i < CH; i++) lay[i] = cur[i];
      RV[R_SCALE] = scale;
      lowestCh(rig, lay, null);
      const low = out(lay[RY] + RV[R_LOW], .2);
      reset();
      ms[I_RDUR] = d; ms[I_RLOW] = low;
      for (let i = 0; i < CH; i++) c[i] = lay[i];
      writePose(0);
    }
    function snapshot() {
      const spd = ms[I_SPD], wMove = ms[I_MOVE];
      return {
        phase: ms[I_PHASE], cadence: ms[I_CAD], speed: spd, footsteps, move: wMove, run: smooth(walkS * 1.05, chaseS * .92, spd),
        idle: 1 - wMove, stalk: ms[I_STALK], chase: ms[I_CHASE], search: ms[I_SEARCH], watched: ms[I_WATCH],
        lunge: ms[I_LUNGE], stagger: ms[I_STAG], scream: ms[I_SCR] >= 0 ? 1 : 0, attack: ms[I_ATK] >= 0 ? 1 : 0,
        dying: dying && !settled ? 1 : 0, dead: dying ? 1 : 0, deathT: dying ? ms[I_DEATH] : 0, deathMode: mode,
        fall: dying ? sgn : 0, headshot: headshot ? 1 : 0, settled: settled ? 1 : 0, time: ms[I_CLOCK], mouth: pose.mouth,
        rising: ms[I_RDUR] > 0 ? 1 : 0, rise: ms[I_RDUR] > 0 ? ms[I_RISE] / ms[I_RDUR] : 0
      };
    }

    reset();
    return { kind: name, pose, update, hit, attack, scream, die, rise, reset, snapshot };
  }

  // Writes a pose onto a visuals.js monster group (duck-typed THREE.Object3D): joints = restPose + offsets, root
  // rotation order 'YXZ' with the creature yaw, root offset rotated by that yaw. jointsOnly leaves the group's own
  // position and rotation alone, for code that places the body itself (the caught close-up). No allocation.
  function setJoint(part, rest, v) {
    if (!part || !v) return;
    const r = rest && rest[part.name];
    if (r) part.rotation.set(r.x + v.x, r.y + v.y, r.z + v.z);
  }
  function apply(g, pose, x, z, yaw, jointsOnly) {
    if (!g || !pose || !pose.joints) return;
    const u = g.userData || EMPTY, rest = u.restPose, J = pose.joints, r = pose.root;
    setJoint(u.legL, rest, J.legL); setJoint(u.legR, rest, J.legR); setJoint(u.armL, rest, J.armL); setJoint(u.armR, rest, J.armR);
    setJoint(u.neck, rest, J.neck); setJoint(u.head, rest, J.head); setJoint(u.jaw, rest, J.jaw);
    const knees = u.knees || NONE, elbows = u.elbows || NONE;
    for (let i = 0; i < knees.length; i++) setJoint(knees[i], rest, J[knees[i].name]);
    for (let i = 0; i < elbows.length; i++) setJoint(elbows[i], rest, J[elbows[i].name]);
    if (jointsOnly || !r) return;
    yaw = num(yaw);
    const cs = Math.cos(yaw), sn = Math.sin(yaw);
    if (g.rotation.order !== 'YXZ') g.rotation.order = 'YXZ';
    g.rotation.set(r.pitch, yaw + r.yaw, r.roll);
    g.position.set(num(x) + r.x * cs + r.z * sn, r.y, num(z) - r.x * sn + r.z * cs);
  }

  // Estimated lowest world height of a pose (root.y included) on the default visuals.js rig of `kind`: the estimate
  // dying bodies use to stay on the floor. parts (optional, length >= 6) receives torso, legL, legR, armL, armR, head.
  function lowest(kind, pose, height, parts) {
    const name = Object.prototype.hasOwnProperty.call(RIGS, kind) ? kind : 'stalker', K = KINDS[name];
    if (!pose || typeof pose !== 'object' || !pose.joints || !pose.root) return 0;
    const s = positive(height, K.height) / K.height, Jn = pose.joints, r = pose.root;
    for (let i = 0; i < JOINTS.length; i++) {
      const j = Jn[JOINTS[i]], o = i * 3;
      TMP[o] = j ? num(j.x) : 0; TMP[o + 1] = j ? num(j.y) : 0; TMP[o + 2] = j ? num(j.z) : 0;
    }
    TMP[RP] = num(r.pitch); TMP[RR] = num(r.roll); RV[R_SCALE] = s;
    lowestCh(RIGS[name], TMP, parts && parts.length >= 6 ? parts : null);
    return num(r.y) + RV[R_LOW];
  }

  return Object.freeze({ create, apply, lowest, KINDS, JOINTS, STATES, MODES });
});
