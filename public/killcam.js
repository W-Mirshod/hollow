/* First-person kill choreography: what a creature does to the survivor once it has them. Pure math (no THREE, no DOM).
   Every kind owns a keyframed track: the camera (body-frame offsets from the survivor's feet: x right, y eye height,
   f forward; pitch/yaw/roll; fov offset; `look` aims at the creature's face), the creature (where its face goes, the
   root rotation, whether it stands on the floor or hangs off the camera), joint overrides on top of the
   monster-anim pose, screen FX levels and timed events (impacts, blood, cracks, sounds, the heartbeat). update()
   mutates and returns one preallocated pose (no per-frame allocation); everything is a pure function of the track
   clock, so 30, 60 and 144 fps play the same kill. Reduced motion keeps the framing but drops the shake, the jolts
   and most of the roll and zoom. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HollowKillCam = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const PI = Math.PI, HALF_PI = PI / 2;
  // Easing into a key: s smooth, l linear, o fast-then-settle (impacts), i slow-then-fast (falls), h hold then jump,
  // b overshoot.
  const EASES = { s: 0, l: 1, o: 2, i: 3, h: 4, b: 5 };
  const CAM = ['x', 'y', 'f', 'pitch', 'yaw', 'roll', 'fov', 'look', 'lpitch', 'lyaw'];
  // Creature: face target (x right, y height, f forward; offsets from the camera where `follow` is 1), root rotation
  // (yaw 0 faces the survivor, pitch > 0 leans toward them), ground (1: root on the floor, face only steers x/f),
  // drop (root height when grounded).
  const MON = ['x', 'y', 'f', 'pitch', 'yaw', 'roll', 'ground', 'follow', 'drop'];
  const FX = ['black', 'red', 'tunnel', 'desat', 'blur', 'aberr', 'light', 'shake', 'tremor', 'gun', 'grave'];
  // Joint override channels: [joint, axis]. Signs follow monster-anim.js: limb x < 0 swings forward, outward is -z on
  // the left and +z on the right, elbow x < 0 curls, knee x > 0 folds, neck x < 0 throws the head back, jaw x > 0 opens.
  const JOINTS = [['legL', 'x'], ['legR', 'x'], ['kneeL', 'x'], ['kneeR', 'x'], ['armL', 'x'], ['armL', 'z'], ['armR', 'x'],
    ['armR', 'z'], ['elbowL', 'x'], ['elbowR', 'x'], ['neck', 'x'], ['neck', 'y'], ['neck', 'z'], ['head', 'x'], ['head', 'y'],
    ['head', 'z'], ['jaw', 'x']];
  const JOINT_KEYS = JOINTS.map(([j, a]) => j + (a === 'x' ? 'X' : a === 'y' ? 'Y' : 'Z'));
  const DEFAULTS = {
    cam: { x: 0, y: 1.6, f: 0, pitch: 0, yaw: 0, roll: 0, fov: 0, look: 0, lpitch: 0, lyaw: 0 },
    mon: { x: 0, y: 2, f: 1, pitch: 0, yaw: 0, roll: 0, ground: 1, follow: 0, drop: 0 },
    fx: { black: 0, red: 0, tunnel: 0, desat: 0, blur: 0, aberr: 0, light: 1, shake: 0, tremor: 0, gun: 0, grave: 0 }
  };
  const EVENT_TYPES = ['hit', 'blood', 'crack', 'sfx', 'voice', 'heart', 'flat', 'gun', 'dirt', 'spray', 'skip'];
  // Camera limits (body frame) and reduced-motion scales.
  const LIMITS = { x: 1.6, yMin: .12, yMax: 3.4, fMin: -1.7, fMax: 1.2, pitch: 1.5, yaw: 1.2, roll: 1.6, fov: [-30, 30] };
  const REDUCED = { roll: .3, fov: .3, shake: .12, jolt: .15 };
  const JOLTS = 8, MAX_EVENTS = 24;
  // Face points in each kind's head-joint frame (the creature's face, not its skull centre).
  const FACE = { warden: [0, .07, .24], stalker: [0, .1, .18], crawler: [0, -.02, .16], shrieker: [0, .1, .17], gravekeeper: [0, .1, .2] };
  const LINES = {
    warden: 'The Warden crushed your skull.',
    stalker: 'The Stalker dragged you down and opened your throat.',
    crawler: 'The Crawler ate your face.',
    shrieker: 'The Shrieker screamed you deaf, then bit your face off.',
    gravekeeper: 'The Gravekeeper buried you alive.',
    maul: 'Something tore you apart.'
  };

  function deepFreeze(o) { for (const k in o) if (o[k] && typeof o[k] === 'object') deepFreeze(o[k]); return Object.freeze(o); }
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const num = (v, d) => typeof v === 'number' && Number.isFinite(v) ? v : d;
  function ease(code, u) {
    if (code === 1) return u;
    if (code === 2) { const k = 1 - u; return 1 - k * k * k; }
    if (code === 3) return u * u * u;
    if (code === 4) return u < 1 ? 0 : 1;
    if (code === 5) { const k = u - 1; return 1 + 2.70158 * k * k * k + 1.70158 * k * k; }
    return u * u * (3 - 2 * u);
  }
  // K(t0, v0, t1, v1, 'o', ...): keys as flat [time, value, ease into it] triples.
  function K() {
    const out = [];
    for (let i = 0; i < arguments.length;) {
      const t = arguments[i++], v = arguments[i++];
      let e = 0;
      if (typeof arguments[i] === 'string') e = EASES[arguments[i++]];
      if (!Number.isFinite(t) || !Number.isFinite(v) || e === undefined) throw new Error('Bad key at ' + i);
      out.push(t, v, e);
    }
    return out;
  }
  function sample(keys, t) {
    const n = keys.length;
    if (t <= keys[0]) return keys[1];
    if (t >= keys[n - 3]) return keys[n - 2];
    for (let i = 3; i < n; i += 3) {
      if (t < keys[i]) {
        const t0 = keys[i - 3], t1 = keys[i], v0 = keys[i - 2], v1 = keys[i + 1];
        return v0 + (v1 - v0) * ease(keys[i + 2], t1 > t0 ? (t - t0) / (t1 - t0) : 1);
      }
    }
    return keys[n - 2];
  }
  // Seeded 1D gradient noise in about [-1, 1].
  function hash(i, ch) {
    let h = (Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(ch + 1, 0x165667b1)) | 0;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35); h ^= h >>> 16;
    return (h >>> 0) / 2147483647.5 - 1;
  }
  function noise(x, ch) {
    const i = Math.floor(x), f = x - i, u = f * f * f * (f * (f * 6 - 15) + 10);
    const a = hash(i, ch) * f, b = hash(i + 1, ch) * (f - 1);
    return 2 * (a + (b - a) * u);
  }

  /* ---------- authoring helpers ---------- */
  // A raking strike pattern on one arm: wind up over `wind` s, slash through by the hit time.
  function rake(times, up, down, wind) {
    const keys = [];
    for (const t of times) keys.push(t - wind, up, 0, t, down, EASES.o);
    return keys;
  }
  function seq(start, keys) { return start.concat(keys); }

  /* ---------- tracks ---------- */
  // Times in seconds. `black` is when the screen is fully black, `skip` the earliest a click may cut to `skipTo`.
  const TRACKS = {
    warden: {
      duration: 3.7, black: 3.2, skip: 1.4, skipTo: 2.9,
      phases: [[0, 'grab'], [.32, 'lift'], [1.15, 'windup'], [1.42, 'slam'], [1.56, 'floor'], [2.3, 'blow'], [2.48, 'fade']],
      cam: {
        y: K(0, 1.6, .3, 1.6, .55, 1.82, 1.0, 2.18, 1.15, 2.26, 1.4, 2.42, 1.53, .24, 'i', 1.62, .32, 'o', 1.75, .22, 3.7, .2),
        f: K(0, 0, .3, .04, 1.0, .16, 1.4, .26, 1.53, .02, 'i', 3.7, -.04),
        x: K(0, 0, 1.15, 0, 1.4, .24, 1.53, -.06, 'i', 3.7, -.08),
        roll: K(0, 0, .35, .04, .55, -.08, .78, .09, .98, -.06, 1.15, .03, 1.4, -.34, 1.53, 1.28, 'i', 1.62, 1.16, 'o', 1.8, 1.24, 2.44, 1.26, 2.5, 1.4, 'o', 3.7, 1.42),
        look: K(0, .95, 1.36, .95, 1.5, .1, 1.7, .7, 2.3, .9, 2.44, .6, 3.7, .5),
        lpitch: K(0, 0, 1.0, -.05, 1.7, .08),
        pitch: K(0, .2, 1.5, -.2, 1.62, .25),
        fov: K(0, 0, .22, -7, 'o', .5, -2, 1.36, 5, 1.53, -12, 'o', 1.85, -3, 2.3, 2, 2.45, -15, 'o', 2.9, -5, 3.7, -8)
      },
      mon: {
        f: K(0, 1.05, .22, .86, 'o', 1.0, .88, 1.4, .98, 1.53, .74, 'o', 2.28, .6, 2.45, .46, 'o', 3.7, .5),
        x: K(0, 0, 1.4, .1, 1.53, -.05),
        pitch: K(0, .08, .22, .16, 1.15, .1, 1.4, -.14, 1.53, .42, 'o', 2.28, .55, 2.45, .78, 'o', 3.7, .7),
        drop: K(0, 0, 1.45, 0, 1.6, -.28, 'o', 3.7, -.3),
        yaw: K(0, 0, 1.4, .12, 1.53, -.08)
      },
      joints: {
        armRX: K(0, -.5, .2, -1.95, 'o', 1.0, -1.85, 1.15, -2.3, 1.4, -2.55, 1.53, -1.05, 'i', 1.95, -1.25, 2.28, -2.85, 2.44, -.55, 'i', 3.7, -.6),
        armRZ: K(0, .15, .2, .05, 1.4, .25, 1.53, .1, 2.28, .3, 2.44, .05),
        elbowRX: K(0, -.25, .2, -.45, 1.0, -.55, 1.4, -.95, 1.53, -.2, 2.0, -.6, 2.28, -1.25, 2.44, -.1, 'o'),
        armLX: K(0, -.45, .3, -.75, 1.4, -.35, 1.53, -1.15, 2.4, -1.0),
        armLZ: K(0, -.4, .3, -.3, 1.53, -.55),
        elbowLX: K(0, -.6, 1.53, -.9),
        neckX: K(0, -.2, .3, .15, .8, .32, 1.15, -.15, 1.4, -.35, 1.53, .45, 'o', 2.28, .5, 2.44, .7, 'o'),
        neckZ: K(0, 0, .5, .05, .8, .38, 1.1, .18, 1.4, 0, 1.9, -.25, 2.3, .1),
        jawX: K(0, .25, .3, .62, .7, .35, .95, .7, 1.1, .5, 1.25, .9, 1.45, .95, 1.6, .45, 1.95, .8, 2.2, .95, 2.44, .35, 'o', 2.9, .6),
        legLX: K(0, 0, 1.45, 0, 1.6, -.55), legRX: K(0, 0, 1.45, 0, 1.6, -.4),
        kneeLX: K(0, 0, 1.45, 0, 1.6, 1.05), kneeRX: K(0, 0, 1.45, 0, 1.6, .85)
      },
      fx: {
        black: K(0, 0, 1.51, 0, 1.54, .42, 'o', 1.7, .1, 2.42, .12, 2.47, .82, 'o', 2.64, .5, 2.8, .86, 2.92, .7, 3.2, 1, 3.7, 1),
        red: K(0, 0, .8, .15, 1.53, .35, 2.45, .55, 3.7, .6),
        tunnel: K(0, 0, .5, .22, 1.4, .38, 1.6, .58, 2.45, .72, 2.7, .9),
        desat: K(0, 0, 1.5, .15, 1.6, .5, 2.6, .8),
        blur: K(0, 0, 1.5, 0, 1.54, .85, 'o', 1.95, .35, 2.42, .3, 2.47, 1, 'o', 2.9, .55),
        light: K(0, 1, 1.52, 1, 1.54, .4, 1.58, .9, 1.62, .35, 1.7, .85, 2.44, .8, 2.47, .15, 2.6, .5, 3.1, 0),
        shake: K(0, .15, .35, .25, 1.15, .3, 1.4, .45, 1.6, .2, 2.3, .25, 2.5, .5, 3.0, .1),
        tremor: K(0, .3, 1.2, .55, 1.5, .8, 2.3, 1, 2.6, .3),
        gun: K(0, 0, .22, 0, .7, 1, 'i')
      },
      events: [[0, 'voice', 'attack'], [.2, 'hit', .65, 0, -.3], [.2, 'sfx', 'grab', .9], [.22, 'gun'], [.3, 'heart', 165, .8],
        [.48, 'sfx', 'choke', .8], [.66, 'voice', 'snarl'], [.78, 'sfx', 'crunch', .45], [.84, 'blood', .35, .5, .08],
        [1.12, 'voice', 'scream'], [1.36, 'sfx', 'whoosh', 1], [1.53, 'hit', 1.1, .5, 1], [1.53, 'sfx', 'slam', 1],
        [1.53, 'sfx', 'crunch', 1], [1.53, 'crack', .6, .52, 1], [1.53, 'blood', 1.2, .58, .62], [1.55, 'sfx', 'ring', .8],
        [1.8, 'sfx', 'gurgle', .6], [1.9, 'heart', 96, .9], [1.98, 'voice', 'growl'], [2.3, 'sfx', 'whoosh', .8],
        [2.44, 'hit', 1.35, -.2, 1], [2.44, 'sfx', 'crunch', 1.3], [2.45, 'sfx', 'snap', 1], [2.45, 'blood', 1.7, .44, .48],
        [2.46, 'blood', 1.2, .62, .36], [2.46, 'crack', .4, .44, 1.5], [2.47, 'spray', 1.4], [2.5, 'heart', 48, .9],
        [2.62, 'sfx', 'squelch', .6], [2.95, 'flat']]
    },

    stalker: {
      duration: 3.5, black: 3.15, skip: 1.4, skipTo: 2.85,
      phases: [[0, 'lunge'], [.2, 'tackle'], [.56, 'mount'], [.84, 'frenzy'], [2.15, 'bite'], [2.6, 'fade']],
      cam: {
        y: K(0, 1.6, .2, 1.58, .56, .2, 'i', .64, .26, 'o', .74, .2, 3.5, .2),
        f: K(0, 0, .2, -.06, .56, -1.05, 3.5, -1.08),
        x: K(0, 0, .56, .1, 3.5, .1),
        pitch: K(0, .1, .2, .25, .56, 1.15, 'i', .7, 1.05, 3.5, 1.05),
        look: K(0, 1, .2, .9, .34, 0, .62, 0, .86, .92, 2.3, .92, 2.45, .35, 3.5, .3),
        lpitch: K(0, 0, 2.3, 0, 2.45, -.5, 'o', 3.5, -.45),
        roll: K(0, 0, .2, .06, .56, .28, 'i', .7, .2, 1.0, .16, 2.45, .3, 'o', 3.5, .34),
        fov: K(0, 0, .2, -8, 'o', .42, 8, .56, -10, 'o', .9, -2, 2.45, -14, 'o', 3.0, -6)
      },
      mon: {
        ground: K(0, 1, .2, 1, .21, 0, 'h'),
        f: K(0, 1.35, .2, .52, 'i', .56, -.72, .86, -.82, 2.25, -.86, 2.45, -.88, 'o', 2.6, -.92, 3.5, -.9),
        y: K(0, 2.2, .2, 1.86, .21, 1.86, .56, .98, 'i', .86, .82, 2.25, 1.02, 2.45, .3, 'i', 2.6, .26, 3.5, .3),
        x: K(0, 0, .56, .12, 3.5, .1),
        pitch: K(0, .3, .2, .55, .56, 1.24, 'i', .86, 1.28, 2.25, 1.1, 2.45, 1.38, 'o', 3.5, 1.35),
        roll: K(0, 0, .56, .1, 1.2, -.08, 1.8, .12, 2.45, 0),
        drop: K(0, 0, .2, -.12)
      },
      joints: {
        armLX: seq(K(0, -1.5, .2, -1.65, .56, -2.2, .78, -1.8), rake([.92, 1.3, 1.72], -2.85, -.8, .12).concat(K(2.2, -1.9, 2.45, -1.4))),
        armRX: seq(K(0, -1.45, .2, -1.6, .56, -2.1, .78, -1.9), rake([1.1, 1.52, 1.96], -2.85, -.8, .12).concat(K(2.2, -1.9, 2.45, -1.5))),
        armLZ: K(0, -.4, .2, -.25, .56, -.55, .92, -.12, 1.0, -.5, 1.3, -.1, 1.4, -.5, 1.72, -.12, 1.8, -.45),
        armRZ: K(0, .4, .2, .25, .56, .55, 1.1, .12, 1.2, .5, 1.52, .1, 1.62, .5, 1.96, .12, 2.06, .45),
        elbowLX: seq(K(0, -.2, .56, -.5), rake([.92, 1.3, 1.72], -1.3, -.15, .12)),
        elbowRX: seq(K(0, -.2, .56, -.5), rake([1.1, 1.52, 1.96], -1.3, -.15, .12)),
        neckX: K(0, -.35, .2, -.5, .56, -.2, .86, -.3, 2.2, -.35, 2.32, -.75, 2.45, .2, 'o', 3.5, .15),
        neckY: K(0, 0, 2.45, 0, 2.55, .45, 2.65, -.45, 2.75, .4, 2.85, -.3, 2.98, .15),
        neckZ: K(0, 0, .6, .45, .9, .2, 1.4, -.3, 1.9, .3, 2.3, 0),
        jawX: K(0, .75, .2, .8, .56, .5, .86, .62, 1.3, .8, 1.9, .7, 2.3, 1.05, 2.45, .25, 'o', 2.6, .4, 3.5, .35),
        legLX: K(0, -.3, .56, -.9), legRX: K(0, .2, .56, -.7), kneeLX: K(0, .4, .56, 1.6), kneeRX: K(0, .3, .56, 1.4)
      },
      fx: {
        black: K(0, 0, .55, 0, .57, .4, 'o', .7, 0, 2.43, .06, 2.47, .42, 'o', 2.62, .28, 2.95, .88, 3.15, 1, 3.5, 1),
        red: K(0, 0, .9, .1, 1.95, .35, 2.5, .65, 3.5, .7),
        tunnel: K(0, 0, .56, .3, 1.9, .55, 2.5, .8, 3.0, .95),
        desat: K(0, 0, .9, .1, 2.0, .5, 2.6, .85),
        blur: K(0, 0, .55, 0, .57, .6, 'o', .9, .1, 2.0, .3, 2.47, .9, 'o', 3.0, .5),
        light: K(0, 1, .55, 1, .57, .3, .62, .85, 2.44, .8, 2.47, .3, 2.6, .55, 3.05, 0),
        shake: K(0, .2, .56, .35, .86, .25, 1.0, .55, 2.0, .6, 2.3, .3, 2.5, .7, 3.0, .15),
        tremor: K(0, .5, .86, .7, 1.0, 1, 2.1, 1, 2.3, .4, 2.5, 1, 3.0, .3),
        gun: K(0, 0, .2, 0, .55, 1, 'i')
      },
      events: [[0, 'voice', 'attack'], [.2, 'hit', .9, .1, -.4], [.2, 'gun'], [.21, 'sfx', 'choke', .9], [.24, 'heart', 170, .8],
        [.4, 'sfx', 'whoosh', .6], [.56, 'hit', .85, -.2, .7], [.56, 'sfx', 'thud', 1], [.62, 'sfx', 'gasp', .9],
        [.8, 'voice', 'snarl'],
        [.92, 'hit', .55, -1, .3], [.92, 'sfx', 'tear', .8], [.93, 'blood', .7, .34, .42], [.95, 'sfx', 'choke', .7],
        [1.1, 'hit', .6, 1, .35], [1.1, 'sfx', 'squelch', .8], [1.11, 'blood', .8, .66, .5],
        [1.3, 'hit', .6, -1, .25], [1.3, 'sfx', 'tear', .9], [1.31, 'blood', .9, .3, .58], [1.34, 'spray', .6],
        [1.52, 'hit', .65, 1, .3], [1.52, 'sfx', 'squelch', .9], [1.53, 'blood', .9, .7, .34], [1.6, 'voice', 'snarl'],
        [1.72, 'hit', .7, -1, .3], [1.72, 'sfx', 'tear', 1], [1.73, 'blood', 1, .42, .7], [1.78, 'sfx', 'gurgle', .6],
        [1.96, 'hit', .75, 1, .3], [1.96, 'sfx', 'crunch', .8], [1.97, 'blood', 1.1, .6, .55], [2.05, 'heart', 110, .9],
        [2.25, 'voice', 'growl'], [2.45, 'hit', 1.25, 0, -.8], [2.45, 'sfx', 'bite', 1.2], [2.46, 'sfx', 'crunch', 1],
        [2.46, 'blood', 1.6, .5, .82], [2.47, 'blood', 1.2, .4, .66], [2.47, 'spray', 1.5], [2.5, 'sfx', 'gurgle', 1],
        [2.62, 'heart', 55, .9], [2.66, 'sfx', 'tear', 1], [2.7, 'blood', .9, .58, .74], [2.92, 'flat'], [3.0, 'voice', 'laugh']]
    },

    crawler: {
      duration: 3.3, black: 2.95, skip: 1.3, skipTo: 2.7,
      phases: [[0, 'coil'], [.15, 'leap'], [.34, 'impact'], [.7, 'gnaw'], [2.32, 'tear'], [2.55, 'fade']],
      cam: {
        y: K(0, 1.6, .34, 1.6, .7, .22, 'i', .78, .28, 'o', .9, .22, 3.3, .22),
        f: K(0, 0, .34, 0, .7, -.85, 3.3, -.88),
        x: K(0, 0, .7, -.08),
        pitch: K(0, -.4, .34, .1, .7, 1.0, 'i', 3.3, .98),
        look: K(0, 1, .34, .9, .45, .2, .8, .95, 2.3, .95, 2.42, .4, 3.3, .35),
        roll: K(0, 0, .34, -.1, .7, .32, 'i', .85, .26, 1.42, .55, 'o', 1.6, .3, 2.08, -.1, 'o', 2.3, .25, 2.45, .5, 'o', 3.3, .55),
        fov: K(0, 0, .15, 3, .34, -12, 'o', .7, 5, .8, -6, 'o', 2.3, -2, 2.45, -14, 'o', 3.0, -6)
      },
      mon: {
        ground: K(0, 1, .15, 1, .16, 0, 'h'),
        follow: K(0, 0, .34, 0, .341, 1, 'h'),
        // Gnawing: rears back to about half a metre along the view, then lunges in to bite (~0.3 m).
        f: K(0, 1.6, .15, 1.45, .34, .3, 'o', .341, .3, 'h', .7, .3, .78, .19, 'o', 1.0, .32, 1.2, .19, 'o', 1.42, .3, 1.62, .19, 'o', 1.85, .32, 2.08, .2, 'o', 2.32, .3, 2.48, .5, 'o', 3.3, .55),
        y: K(0, .5, .15, .56, .34, 1.55, 'o', .341, -.05, 'h', .7, .36, .78, .24, 'o', 1.0, .38, 1.2, .24, 'o', 1.42, .36, 1.62, .23, 'o', 1.85, .38, 2.08, .25, 'o', 2.32, .36, 2.48, .48, 'o', 3.3, .46),
        x: K(0, 0, 1.42, .06, 1.6, -.04, 2.08, .07, 2.32, 0),
        // Face down over the survivor's face (from below, a shallower angle shows only its hanging hair).
        pitch: K(0, .1, .15, .2, .34, -.75, 'o', .7, 1.15, 1.42, 1.05, 2.08, 1.2, 2.48, .85, 3.3, .9),
        // The thrashing is in the neck: the body stays put (pinned face, a swinging root sweeps it through the lens).
        roll: K(0, 0, .34, .2, .7, -.05, 1.42, .1, 'o', 1.6, -.03, 2.08, -.1, 'o', 2.3, .03),
        yaw: K(0, 0, 1.42, .06, 'o', 1.6, -.02, 2.08, -.07, 'o', 2.3, 0),
        drop: K(0, 0, .15, -.06)
      },
      joints: {
        armLX: K(0, 0, .15, .2, .34, -1.5, 'o', .7, -1.7, 2.3, -1.6), armRX: K(0, 0, .15, .2, .34, -1.45, 'o', .7, -1.75, 2.3, -1.6),
        // Arms out wide, claws pinning the head from the sides (not over the lens).
        armLZ: K(0, 0, .34, -.6, .7, -1.25, 2.3, -1.2), armRZ: K(0, 0, .34, .6, .7, 1.25, 2.3, 1.2),
        elbowLX: K(0, 0, .34, -.6, .7, -.75), elbowRX: K(0, 0, .34, -.6, .7, -.75),
        legLX: K(0, 0, .15, -.3, .34, .7, 'o', .7, .5), legRX: K(0, 0, .15, -.3, .34, .75, 'o', .7, .5),
        neckX: K(0, -.2, .34, -.5, .7, .1, .78, -.35, 'o', .9, .15, 1.0, -.3, 'o', 1.1, .15, 1.2, -.35, 'o', 1.32, .1, 1.42, -.2, 'o',
          1.62, -.3, 'o', 1.74, .15, 1.85, -.35, 'o', 1.96, .1, 2.08, -.3, 'o', 2.2, .1, 2.32, -.4, 'o', 2.48, .3, 'o'),
        neckY: K(0, 0, 1.3, 0, 1.42, .85, 'o', 1.6, -.15, 2.0, 0, 2.08, -.9, 'o', 2.3, .1, 2.48, .4, 'o'),
        neckZ: K(0, 0, .7, .3, 1.42, -.45, 'o', 1.6, .1, 2.08, .5, 'o', 2.48, -.2),
        headX: K(0, 0, .78, .25, .9, -.1, 1.0, .25, 1.1, -.1, 1.2, .25, 1.32, -.1)
      },
      fx: {
        black: K(0, 0, .69, 0, .72, .45, 'o', .85, .05, 2.45, .06, 2.5, .5, 'o', 2.64, .38, 2.95, 1, 3.3, 1),
        red: K(0, 0, .8, .15, 2.0, .38, 2.5, .65, 3.3, .7),
        tunnel: K(0, 0, .34, .25, .8, .35, 2.0, .55, 2.6, .95),
        desat: K(0, 0, .8, .15, 2.0, .55, 2.6, .85),
        blur: K(0, 0, .33, 0, .35, .7, 'o', .7, .25, .72, .7, 'o', 1.0, .25, 2.0, .35, 2.5, .95, 'o', 2.9, .5),
        light: K(0, 1, .7, 1, .72, .35, .8, .9, 2.45, .8, 2.5, .5, 2.9, 0),
        shake: K(0, .2, .34, .5, .7, .3, .8, .7, 2.3, .7, 2.5, .6, 2.9, .1),
        tremor: K(0, .8, .34, .5, .7, 1, 2.3, 1, 2.6, .3),
        gun: K(0, 0, .34, 0, .62, 1, 'i')
      },
      events: [[0, 'voice', 'chatter'], [.15, 'voice', 'attack'], [.15, 'sfx', 'whoosh', .5], [.34, 'hit', 1.15, .2, -.5],
        [.34, 'sfx', 'bite', .7], [.35, 'gun'], [.35, 'blood', .6, .5, .5], [.36, 'sfx', 'choke', 1], [.4, 'heart', 175, .8],
        [.7, 'hit', .8, -.2, .6], [.7, 'sfx', 'thud', 1],
        [.78, 'hit', .45, 0, .4], [.78, 'sfx', 'bite', .8], [.79, 'blood', .7, .22, .3],
        [1.0, 'hit', .45, .3, .4], [1.0, 'sfx', 'squelch', .8], [1.01, 'blood', .7, .8, .6], [1.04, 'sfx', 'choke', .7],
        [1.2, 'hit', .5, -.3, .4], [1.2, 'sfx', 'bite', .9], [1.21, 'blood', .8, .26, .74],
        [1.42, 'hit', .8, 1, .2], [1.42, 'sfx', 'tear', 1], [1.43, 'blood', 1.1, .82, .3], [1.45, 'spray', .7],
        [1.62, 'hit', .5, 0, .4], [1.62, 'sfx', 'bite', .9], [1.63, 'blood', .8, .6, .14], [1.7, 'sfx', 'gurgle', .7],
        [1.85, 'hit', .5, .3, .4], [1.85, 'sfx', 'squelch', 1], [1.86, 'blood', .9, .14, .48], [1.9, 'heart', 105, .9],
        [2.08, 'hit', .85, -1, .2], [2.08, 'sfx', 'tear', 1.1], [2.09, 'blood', 1.2, .76, .78], [2.1, 'spray', .8],
        [2.32, 'sfx', 'bite', 1.1], [2.33, 'blood', 1, .42, .82],
        [2.48, 'hit', 1.2, .2, -.6], [2.48, 'sfx', 'tear', 1.3], [2.48, 'sfx', 'crunch', 1], [2.49, 'blood', 1.7, .5, .45],
        [2.5, 'spray', 1.6], [2.52, 'sfx', 'gurgle', 1], [2.55, 'heart', 50, .9], [2.75, 'flat']]
    },

    shrieker: {
      duration: 3.5, black: 3.1, skip: 1.4, skipTo: 2.8,
      phases: [[0, 'grab'], [.3, 'pull'], [.85, 'scream'], [2.0, 'bite'], [2.25, 'collapse'], [2.8, 'fade']],
      cam: {
        y: K(0, 1.6, .3, 1.72, 2.25, 1.74, 2.72, .3, 'i', 2.82, .36, 'o', 2.95, .3, 3.5, .3),
        f: K(0, 0, .3, .2, 'o', 2.25, .22, 2.72, -.15, 3.5, -.2),
        look: K(0, 1, 2.12, 1, 2.22, .25, 2.5, .2, 3.5, .2),
        lpitch: K(0, 0, .85, .02, 2.0, -.04),
        pitch: K(0, .2, 2.25, .2, 2.72, .4),
        roll: K(0, 0, .3, -.05, .85, .1, 2.0, -.06, 2.25, .1, 2.72, -1.1, 'i', 2.82, -.98, 'o', 3.5, -1.02),
        fov: K(0, 0, .25, -6, 'o', .85, -3, .95, -9, 'o', 1.1, 3, 1.25, -9, 'o', 1.42, 4, 1.58, -10, 'o', 1.75, 5, 1.9, -9, 'o',
          2.0, 2, 2.2, -16, 'i', 2.5, -5, 3.5, -6)
      },
      mon: {
        f: K(0, 1.05, .3, .66, 'o', .85, .62, 1.0, .55, 'o', 2.0, .54, 2.2, .42, 'i', 2.3, .48, 2.72, .52, 3.5, .55),
        x: K(0, 0, .5, .03, .85, -.02),
        pitch: K(0, .1, .3, .22, .85, .18, 1.0, .3, 2.0, .3, 2.2, .45, 2.72, .62, 3.5, .65),
        roll: K(0, 0, .5, .1, .85, -.08, 2.0, .05),
        drop: K(0, 0, .3, .04, 2.0, .04, 2.72, -.25)
      },
      joints: {
        armLX: K(0, -1.35, .3, -1.6, 'o', 2.2, -1.65, 2.72, -1.0), armRX: K(0, -1.3, .3, -1.6, 'o', 2.2, -1.62, 2.72, -.9),
        armLZ: K(0, -.75, .3, -.12, 'o', 2.2, -.1, 2.72, -.5), armRZ: K(0, .75, .3, .12, 'o', 2.2, .1, 2.72, .5),
        elbowLX: K(0, -.4, .3, -1.25, 'o', 2.2, -1.3, 2.72, -.5), elbowRX: K(0, -.4, .3, -1.25, 'o', 2.2, -1.3, 2.72, -.5),
        neckX: K(0, -.25, .3, .1, .85, .2, 1.0, -.15, 'o', 2.0, -.2, 2.1, -.45, 2.2, .3, 'i', 2.72, .55),
        neckZ: K(0, 0, .3, .5, .6, .2, .85, -.25, 1.4, -.1, 2.0, .1),
        headZ: K(0, 0, .5, .2, .85, -.15),
        jawX: K(0, .4, .3, .35, .55, .7, .7, .9, .74, 1.15, 'o', .85, 1.45, 1.0, 1.6, 'o', 2.0, 1.55, 2.1, 1.65, 2.22, .25, 'o', 2.6, .5)
      },
      fx: {
        black: K(0, 0, 2.2, 0, 2.24, .55, 'o', 2.5, .3, 2.72, .62, 2.82, .45, 3.1, 1, 3.5, 1),
        red: K(0, 0, .85, .1, 1.9, .35, 2.25, .6, 3.5, .65),
        tunnel: K(0, 0, .3, .2, .85, .35, 1.9, .55, 2.25, .75, 2.8, .92),
        desat: K(0, 0, .85, .1, 1.9, .45, 2.3, .7, 2.9, .85),
        blur: K(0, 0, .85, 0, 1.0, .55, 1.9, .6, 2.0, .2, 2.24, .95, 'o', 2.9, .5),
        aberr: K(0, 0, .85, 0, .95, 1, 'o', 1.9, .85, 2.0, .2, 2.24, .8, 'o', 2.8, .2, 3.1, 0),
        light: K(0, 1, .9, 1, 1.0, .75, 1.2, 1, 1.4, .7, 1.6, 1, 2.23, .9, 2.25, .45, 2.6, .6, 3.05, 0),
        shake: K(0, .2, .3, .3, .85, .2, .95, .85, 1.9, .9, 2.0, .3, 2.25, .6, 2.9, .15),
        tremor: K(0, .4, .85, .4, .95, 1, 1.95, 1, 2.1, .3, 2.25, .6),
        gun: K(0, 0, .25, 0, .65, 1, 'i')
      },
      events: [[0, 'voice', 'attack'], [.22, 'hit', .6, 0, -.25], [.22, 'sfx', 'grab', .8], [.25, 'gun'], [.3, 'heart', 175, .8],
        [.42, 'sfx', 'gasp', .9], [.66, 'sfx', 'choke', .6], [.74, 'sfx', 'crunch', .5], [.76, 'sfx', 'snap', .6],
        [.85, 'voice', 'scream'], [.85, 'sfx', 'screech', 1], [1.0, 'hit', .45, 0, -.2], [1.0, 'sfx', 'choke', .8],
        [1.15, 'sfx', 'ring', 1], [1.3, 'blood', .35, .03, .5], [1.55, 'blood', .35, .97, .44], [1.7, 'heart', 130, .9],
        [2.2, 'hit', 1.35, 0, .2], [2.2, 'sfx', 'bite', 1.3], [2.21, 'sfx', 'crunch', 1.2], [2.22, 'blood', 1.8, .5, .45],
        [2.22, 'blood', 1.2, .38, .58], [2.23, 'spray', 1.4], [2.36, 'sfx', 'tear', 1.1], [2.4, 'blood', .9, .62, .4],
        [2.42, 'sfx', 'gurgle', .9], [2.45, 'heart', 50, .9], [2.72, 'hit', .7, -.6, .5], [2.72, 'sfx', 'thud', 1], [2.95, 'flat'],
        [3.05, 'voice', 'laugh']]
    },

    gravekeeper: {
      duration: 3.9, black: 3.6, skip: 1.5, skipTo: 3.25,
      phases: [[0, 'loom'], [.3, 'impale'], [.6, 'lift'], [1.45, 'throw'], [1.95, 'grave'], [2.2, 'bury'], [3.4, 'fade']],
      cam: {
        y: K(0, 1.6, .32, 1.55, .6, 1.62, 1.42, 2.9, 1.55, 2.95, 1.95, .16, 'i', 2.05, .22, 'o', 2.2, .15, 3.9, .15),
        f: K(0, 0, .32, .06, .6, .12, 1.42, .5, 1.55, .5, 1.95, -1.3, 'i', 3.9, -1.32),
        x: K(0, 0, 1.55, .05, 1.95, -.15, 3.9, -.15),
        look: K(0, .9, .32, .9, .45, .25, .62, .25, .9, .8, 1.45, .8, 1.6, 0, 2.15, 0, 2.5, .88, 3.9, .82),
        pitch: K(0, .3, .32, .1, .5, -.78, 'o', .62, -.7, 1.45, -.7, 1.62, -.4, 1.95, 1.35, 'i', 3.9, 1.35),
        lpitch: K(0, 0, 2.5, -.04),
        roll: K(0, 0, .32, .05, .5, .15, .9, -.12, 1.2, .14, 1.45, -.05, 1.95, .35, 'i', 2.05, .2, 3.9, .22),
        fov: K(0, 0, .32, -12, 'o', .7, -4, 1.42, 3, 1.6, 10, 1.95, -12, 'o', 2.4, -2, 3.9, 4)
      },
      mon: {
        f: K(0, 1.45, .32, 1.05, 'o', 1.42, .95, 1.6, .9, 1.95, .7, 2.6, -.72, 3.9, -.78),
        x: K(0, 0, 1.95, .1, 2.6, .16, 3.9, .16),
        pitch: K(0, .05, .32, .3, 'o', 1.0, .1, 1.42, -.05, 1.75, .35, 'o', 2.0, .2, 2.6, .45, 3.9, .5),
        yaw: K(0, 0, 1.4, .15, 1.8, -.3, 'o', 2.6, .2, 3.9, .2),
        drop: K(0, 0, 2.6, -.05)
      },
      joints: {
        armRX: K(0, .55, .12, .7, .32, -.72, 'i', .6, -.75, 1.42, -2.65, 1.75, -.9, 'i', 2.0, -1.0, 2.2, -2.3, 2.45, -.55, 'o', 2.7, -2.3, 2.95, -.55, 'o',
          3.2, -2.3, 3.45, -.55, 'o', 3.9, -1.0),
        armRZ: K(0, .2, .32, .05, 1.42, .2, 1.75, .3),
        elbowRX: K(0, -1.4, .32, -.1, 'o', 1.42, -.3, 1.75, -.2, 2.2, -1.1, 2.45, -.3, 2.7, -1.1, 2.95, -.3, 3.2, -1.1, 3.45, -.3),
        armLX: K(0, -.4, .32, -1.2, 'o', 1.42, -1.6, 1.75, -.6, 2.2, -2.1, 2.45, -.7, 2.7, -2.1, 2.95, -.7, 3.2, -2.1, 3.45, -.7),
        armLZ: K(0, -.4, .32, -.2, 1.42, -.35), elbowLX: K(0, -.6, 1.42, -.4, 2.2, -1.0),
        neckX: K(0, -.3, .32, .2, .6, -.3, 1.42, -.65, 1.75, .3, 2.0, .45, 3.9, .5),
        neckZ: K(0, 0, .8, .3, 1.42, -.2, 2.6, .35),
        jawX: K(0, .3, .32, .9, 'o', .6, .5, .9, 1.1, 1.42, 1.0, 1.6, .5, 2.2, .7, 2.6, .4, 3.0, .8, 3.9, .3)
      },
      fx: {
        black: K(0, 0, .31, 0, .34, .25, 'o', .5, .04, 1.94, .1, 1.97, .5, 'o', 2.15, .15, 2.45, .3, 2.95, .55, 3.45, .85, 3.6, 1, 3.9, 1),
        red: K(0, 0, .34, .25, 1.4, .35, 2.0, .45, 3.9, .5),
        tunnel: K(0, 0, .34, .3, 1.4, .45, 1.95, .3, 2.6, .5, 3.4, .85),
        desat: K(0, 0, .34, .2, 1.95, .45, 3.0, .75),
        blur: K(0, 0, .31, 0, .34, .75, 'o', .7, .2, 1.94, .2, 1.97, .8, 'o', 2.3, .3),
        light: K(0, 1, .33, 1, .35, .6, .45, .95, 1.94, .85, 1.97, .3, 2.1, .6, 3.5, .15, 3.8, 0),
        shake: K(0, .3, .32, .4, .7, .5, 1.42, .3, 1.6, .5, 1.95, .3, 2.2, .2, 3.9, .1),
        tremor: K(0, .4, .32, .7, 1.4, .9, 2.0, .4),
        gun: K(0, 0, .32, 0, .6, 1, 'i'),
        grave: K(0, 0, 1.93, 0, 1.97, 1, 'o', 3.9, 1.35)
      },
      events: [[0, 'voice', 'scream'], [.25, 'sfx', 'whoosh', .7], [.32, 'hit', 1.3, 0, .6], [.32, 'sfx', 'impale', 1.2],
        [.33, 'sfx', 'crunch', 1], [.33, 'gun'], [.34, 'blood', 1.4, .5, .82], [.34, 'spray', 1.2], [.38, 'sfx', 'choke', 1],
        [.5, 'heart', 150, .9], [.9, 'voice', 'scream'], [1.0, 'sfx', 'gurgle', .8], [1.05, 'spray', .5], [1.3, 'spray', .5],
        [1.5, 'sfx', 'whoosh', 1], [1.95, 'hit', 1.1, .2, -.7], [1.95, 'sfx', 'thud', 1.2], [1.96, 'sfx', 'crunch', .6],
        [2.05, 'sfx', 'gasp', .7], [2.2, 'voice', 'growl'], [2.2, 'heart', 80, .9],
        [2.45, 'hit', .45, .3, -.5], [2.45, 'dirt', 1, .45, .3], [2.45, 'sfx', 'dirt', 1], [2.95, 'hit', .5, -.3, -.5],
        [2.95, 'dirt', 1.2, .6, .4], [2.95, 'sfx', 'dirt', 1], [3.1, 'heart', 44, .8], [3.2, 'voice', 'laugh'],
        [3.45, 'hit', .55, 0, -.6], [3.45, 'dirt', 1.5, .5, .5], [3.45, 'sfx', 'dirt', 1.1], [3.45, 'flat']]
    },

    maul: {
      duration: 3.2, black: 2.85, skip: 1.3, skipTo: 2.6,
      phases: [[0, 'lunge'], [.22, 'down'], [.6, 'maul'], [1.8, 'bite'], [2.3, 'fade']],
      cam: {
        y: K(0, 1.6, .22, 1.58, .6, .22, 'i', .7, .28, 'o', .8, .22, 3.2, .22),
        f: K(0, 0, .22, -.05, .6, -.95, 3.2, -.98),
        pitch: K(0, .1, .22, .3, .6, 1.1, 'i', 3.2, 1.0),
        look: K(0, 1, .22, .9, .36, 0, .66, 0, .9, .9, 1.85, .9, 2.0, .35, 3.2, .3),
        lpitch: K(0, 0, 1.85, 0, 2.0, -.45, 'o'),
        roll: K(0, 0, .6, -.3, 'i', .8, -.22, 1.1, -.4, 'o', 1.5, -.1, 'o', 2.0, -.35, 3.2, -.4),
        fov: K(0, 0, .22, -8, 'o', .45, 6, .6, -10, 'o', 1.0, -2, 2.0, -14, 'o', 2.5, -6)
      },
      mon: {
        ground: K(0, 1, .22, 1, .23, 0, 'h'),
        f: K(0, 1.3, .22, .55, 'i', .6, -.62, 1.85, -.72, 2.0, -.8, 'o', 3.2, -.8),
        y: K(0, 2.1, .22, 1.8, .23, 1.8, .6, .95, 'i', 1.85, 1.0, 2.0, .3, 'i', 3.2, .32),
        pitch: K(0, .3, .22, .55, .6, 1.2, 'i', 1.85, 1.1, 2.0, 1.35, 'o', 3.2, 1.3),
        roll: K(0, 0, .6, .1)
      },
      joints: {
        armLX: seq(K(0, -1.5, .22, -1.6, .6, -2.1), rake([1.1], -2.8, -.8, .14).concat(K(1.5, -2.0, 2.0, -1.4))),
        armRX: seq(K(0, -1.45, .22, -1.6, .6, -2.0), rake([1.5], -2.8, -.8, .14).concat(K(1.8, -1.9, 2.0, -1.5))),
        elbowLX: K(0, -.3, .6, -.5), elbowRX: K(0, -.3, .6, -.5),
        neckX: K(0, -.35, .6, -.25, 1.85, -.7, 2.0, .2, 'o'),
        neckY: K(0, 0, 2.0, 0, 2.1, .4, 2.2, -.4, 2.3, .3, 2.4, 0),
        jawX: K(0, .7, .6, .5, 1.85, 1.0, 2.0, .25, 'o', 3.2, .35)
      },
      fx: {
        black: K(0, 0, .59, 0, .62, .4, 'o', .75, 0, 1.98, .05, 2.02, .45, 'o', 2.2, .3, 2.6, .9, 2.85, 1, 3.2, 1),
        red: K(0, 0, 1.0, .2, 2.0, .6, 3.2, .65),
        tunnel: K(0, 0, .6, .3, 1.6, .55, 2.2, .85),
        desat: K(0, 0, .8, .2, 2.2, .8),
        blur: K(0, 0, .59, 0, .62, .6, 'o', 1.0, .15, 2.0, .9, 'o', 2.6, .5),
        light: K(0, 1, .59, 1, .62, .35, .7, .85, 1.98, .8, 2.02, .3, 2.7, 0),
        shake: K(0, .2, .6, .4, 1.0, .5, 1.8, .4, 2.0, .7, 2.6, .1),
        tremor: K(0, .5, 1.0, 1, 2.2, .4),
        gun: K(0, 0, .22, 0, .55, 1, 'i')
      },
      events: [[0, 'voice', 'attack'], [.22, 'hit', .9, 0, -.4], [.22, 'gun'], [.23, 'sfx', 'choke', .9], [.3, 'heart', 165, .8],
        [.6, 'hit', .8, .2, .7], [.6, 'sfx', 'thud', 1], [.66, 'sfx', 'gasp', .8],
        [1.1, 'hit', .65, -1, .3], [1.1, 'sfx', 'tear', 1], [1.11, 'blood', .9, .22, .4],
        [1.5, 'hit', .7, 1, .3], [1.5, 'sfx', 'squelch', 1], [1.51, 'blood', 1, .78, .62], [1.55, 'sfx', 'gurgle', .7],
        [1.7, 'heart', 100, .9], [2.0, 'hit', 1.2, 0, -.8], [2.0, 'sfx', 'bite', 1.2], [2.01, 'sfx', 'crunch', 1],
        [2.02, 'blood', 1.6, .5, .78], [2.02, 'spray', 1.3], [2.15, 'sfx', 'tear', 1], [2.2, 'heart', 50, .9], [2.6, 'flat']]
    }
  };

  /* ---------- compile ---------- */
  function keysOf(kind, name, keys) {
    for (let i = 3; i < keys.length; i += 3) if (!(keys[i] > keys[i - 3])) throw new Error(`${kind}: ${name} keys out of order at ${keys[i]}`);
    return Float64Array.from(keys);
  }
  function channelList(kind, names, defaults, spec) {
    return names.map(name => spec && spec[name] ? keysOf(kind, name, spec[name]) : Float64Array.from([0, defaults[name], 0]));
  }
  function compile(kind, T) {
    for (const group of ['cam', 'mon', 'fx', 'joints']) {
      const names = group === 'cam' ? CAM : group === 'mon' ? MON : group === 'fx' ? FX : JOINT_KEYS;
      for (const key of Object.keys(T[group] || {})) if (!names.includes(key)) throw new Error(`${kind}: unknown ${group} channel ${key}`);
    }
    const events = T.events.map(([t, type, ...args]) => {
      if (!EVENT_TYPES.includes(type)) throw new Error(`${kind}: unknown event ${type}`);
      const cue = typeof args[0] === 'string' ? args.shift() : null;
      return Object.freeze({ t, type, cue, a: num(args[0], 1), b: num(args[1], .5), c: num(args[2], .5) });
    }).sort((p, q) => p.t - q.t);
    return Object.freeze({
      kind, duration: T.duration, black: T.black, skip: T.skip, skipTo: T.skipTo,
      phases: T.phases.map(p => Object.freeze(p.slice())),
      cam: channelList(kind, CAM, DEFAULTS.cam, T.cam), mon: channelList(kind, MON, DEFAULTS.mon, T.mon),
      fx: channelList(kind, FX, DEFAULTS.fx, T.fx),
      joints: JOINT_KEYS.map(k => T.joints && T.joints[k] ? keysOf(kind, k, T.joints[k]) : null),
      events: Object.freeze(events), line: LINES[kind] || LINES.maul
    });
  }
  const COMPILED = {};
  for (const kind of Object.keys(TRACKS)) COMPILED[kind] = compile(kind, TRACKS[kind]);
  // The generic maul plays for any kind without a track of its own.
  const trackFor = kind => Object.prototype.hasOwnProperty.call(COMPILED, kind) ? COMPILED[kind] : COMPILED.maul;

  /* ---------- player ---------- */
  function create() {
    const pose = {
      kind: 'maul', track: 'maul', active: false, done: false, t: 0, duration: 0, phase: '', skipped: false, line: '',
      cam: { x: 0, y: 1.6, f: 0, pitch: 0, yaw: 0, roll: 0, fov: 0, look: 0 },
      mon: { x: 0, y: 0, f: 1, pitch: 0, yaw: 0, roll: 0, ground: 1, follow: 0, drop: 0 },
      fx: { black: 0, red: 0, tunnel: 0, desat: 0, blur: 0, aberr: 0, light: 1, shake: 0, tremor: 0, gun: 0, grave: 0, flash: 0 },
      joints: new Float64Array(JOINTS.length), jointSet: new Uint8Array(JOINTS.length),
      events: new Array(MAX_EVENTS).fill(null), eventCount: 0
    };
    const jolt = new Float64Array(JOLTS * 4); // [t0, strength, dx, dy]
    const opt = { motion: 1, effects: 1, yaw0: 0, pitch0: 0, eye0: 1.6, dist0: 1, back: 9, left: 9, right: 9, ceiling: 3.2, seed: 0 };
    let track = COMPILED.maul, nextEvent = 0, joltN = 0, t = 0;

    function start(kind, o) {
      o = o && typeof o === 'object' ? o : {};
      track = trackFor(kind);
      opt.motion = o.motion === false ? 0 : 1; opt.effects = o.effects === false ? 0 : 1;
      opt.yaw0 = clamp(num(o.yaw0, 0), -PI, PI); opt.pitch0 = clamp(num(o.pitch0, 0), -1.4, 1.4);
      opt.eye0 = clamp(num(o.eye0, 1.6), .5, 2); opt.dist0 = clamp(num(o.dist0, 1), .3, 3);
      opt.back = Math.max(.3, num(o.back, 9)); opt.left = Math.max(.3, num(o.left, 9)); opt.right = Math.max(.3, num(o.right, 9));
      opt.ceiling = Math.max(1.8, num(o.ceiling, 3.2)); opt.seed = num(o.seed, 0) | 0;
      t = 0; nextEvent = 0; joltN = 0; jolt.fill(0);
      pose.kind = typeof kind === 'string' ? kind : 'maul'; pose.track = track.kind; pose.active = true; pose.done = false;
      pose.skipped = false; pose.duration = track.duration; pose.line = track.line;
      for (let i = 0; i < JOINTS.length; i++) pose.jointSet[i] = track.joints[i] ? 1 : 0;
      evaluate(null);
      pose.eventCount = 0;
      emit(0);
      return pose;
    }
    function emit(upTo) {
      pose.eventCount = 0;
      const E = track.events;
      while (nextEvent < E.length && E[nextEvent].t <= upTo) {
        const e = E[nextEvent++];
        if (e.type === 'hit') { const o = (joltN++ % JOLTS) * 4; jolt[o] = e.t; jolt[o + 1] = e.a; jolt[o + 2] = e.b; jolt[o + 3] = e.c; }
        if (pose.eventCount < MAX_EVENTS) pose.events[pose.eventCount++] = e;
      }
    }
    // Sum of decaying jolts: a hard snap away from the blow, then a fast damped wobble.
    function joltAt(ch) {
      let s = 0;
      for (let i = 0; i < JOLTS; i++) {
        const o = i * 4, k = jolt[o + 1];
        if (!k) continue;
        const d = t - jolt[o];
        if (d < 0 || d > 1.2) continue;
        const env = Math.exp(-d * 7) * k, w = Math.sin(Math.min(d * 26, HALF_PI) + Math.max(0, d * 26 - HALF_PI) * .55);
        const dx = jolt[o + 2], dy = jolt[o + 3];
        if (ch === 0) s += env * w * (-dy * .16 + .03 * hash(i, 5));   // pitch
        else if (ch === 1) s += env * w * dx * .12;                       // yaw
        else if (ch === 2) s += env * w * (dx * .22 + .06 * hash(i, 7)); // roll
        else if (ch === 3) s += env * w * -.045;                         // camera pushed back
        else if (ch === 4) s += Math.exp(-d * 9) * k * -7;                // fov punch
        else if (ch === 5) s += Math.exp(-d * 10) * k;                    // flash
      }
      return s;
    }
    function evaluate(face) {
      const C = track.cam, M = track.mon, F = track.fx, c = pose.cam, m = pose.mon, fx = pose.fx;
      const mo = opt.motion, intro = 1 - ease(EASES.o, clamp(t / .3, 0, 1));
      // Camera body-frame position, kept inside the walls and under the ceiling.
      c.x = clamp(sample(C[0], t), -Math.min(LIMITS.x, opt.left - .25), Math.min(LIMITS.x, opt.right - .25));
      c.y = clamp(sample(C[1], t) + (opt.eye0 - 1.6) * intro, LIMITS.yMin, Math.min(LIMITS.yMax, opt.ceiling - .22));
      c.f = clamp(sample(C[2], t), Math.max(LIMITS.fMin, -(opt.back - .28)), LIMITS.fMax);
      // Creature placement.
      for (let i = 0; i < MON.length; i++) m[MON[i]] = sample(M[i], t);
      m.f += (opt.dist0 - sample(M[2], 0)) * intro * (1 - m.follow);
      // Aim: look at the creature's face (the measured one when the caller passes it back).
      const look = clamp(sample(C[7], t), 0, 1);
      let pitch = sample(C[3], t), yaw = sample(C[4], t);
      if (look > 0) {
        const fx0 = face ? num(face.x, 0) : m.x + m.follow * c.x, fy0 = face ? num(face.y, 0) : m.y + m.follow * c.y;
        const ff0 = face ? num(face.f, 1) : m.f + m.follow * c.f;
        const dx = fx0 - c.x, dy = fy0 - c.y, df = ff0 - c.f, h = Math.hypot(dx, df);
        if (h + Math.abs(dy) > 1e-4) {
          const lp = Math.atan2(dy, Math.max(h, 1e-4)) + sample(C[8], t), ly = Math.atan2(-dx, df) + sample(C[9], t);
          pitch += (lp - pitch) * look; yaw += (ly - yaw) * look;
        }
      }
      // The survivor was looking somewhere else: whip round onto the creature over the first 0.3 s.
      pitch += (opt.pitch0 - pitch) * intro; yaw += (opt.yaw0 - yaw) * intro;
      let roll = sample(C[5], t) * (mo ? 1 : REDUCED.roll), fov = sample(C[6], t) * (mo ? 1 : REDUCED.fov);
      for (let i = 0; i < FX.length; i++) fx[FX[i]] = sample(F[i], t);
      // Shake (continuous) and jolts (per blow); reduced motion keeps a trace of both.
      const js = mo ? 1 : REDUCED.jolt, ss = (mo ? 1 : REDUCED.shake) * clamp(fx.shake, 0, 1);
      const sh = ss * ss + .4 * ss;
      pitch += joltAt(0) * js + sh * .03 * noise(t * 17, 1 + opt.seed);
      yaw += joltAt(1) * js + sh * .025 * noise(t * 15, 2 + opt.seed);
      roll += joltAt(2) * js + sh * .045 * noise(t * 13, 3 + opt.seed);
      fov += joltAt(4) * js;
      c.f += joltAt(3) * js;
      c.x += sh * .012 * noise(t * 11, 4 + opt.seed); c.y += sh * .012 * noise(t * 12, 5 + opt.seed);
      c.pitch = clamp(pitch, -LIMITS.pitch, LIMITS.pitch); c.yaw = clamp(yaw, -LIMITS.yaw - PI, LIMITS.yaw + PI);
      c.roll = clamp(roll, -LIMITS.roll, LIMITS.roll); c.fov = clamp(fov, LIMITS.fov[0], LIMITS.fov[1]); c.look = look;
      fx.flash = clamp(joltAt(5) * (opt.effects ? 1 : .45), 0, 1.5);
      fx.black = clamp(fx.black, 0, 1); fx.light = clamp(fx.light, 0, 1.5); fx.gun = clamp(fx.gun, 0, 1);
      // Joint overrides, with a shudder through the neck, head and jaw.
      const tr = clamp(fx.tremor, 0, 1.5) * (opt.effects ? 1 : .4), hz = opt.effects ? 21 : 6;
      for (let i = 0; i < JOINTS.length; i++) {
        const keys = track.joints[i];
        let v = keys ? sample(keys, t) : 0;
        if (i >= 10 && i <= 16) v += tr * (i === 16 ? .12 : i >= 13 ? .07 : .09) * noise(t * hz + i * 3.7, 40 + i + opt.seed);
        pose.joints[i] = v;
      }
      // Phase name.
      const P = track.phases;
      let ph = P[0][1];
      for (let i = 1; i < P.length; i++) if (t >= P[i][0]) ph = P[i][1];
      pose.phase = ph; pose.t = t;
      for (const key in c) if (c[key] !== c[key]) c[key] = 0;
      for (const key in m) if (m[key] !== m[key]) m[key] = 0;
      for (const key in fx) if (fx[key] !== fx[key]) fx[key] = 0;
    }
    function update(dt, face) {
      if (!pose.active) { pose.eventCount = 0; return pose; }
      dt = clamp(num(dt, 0), 0, .25);
      t = Math.min(track.duration, t + dt);
      emit(t);
      evaluate(face);
      if (t >= track.duration) pose.done = true;
      return pose;
    }
    // Cuts to the end: from track.skip on, a click jumps to skipTo; the events in between are dropped (a synthetic
    // 'skip' event tells the caller), the blows still to come are kept.
    const SKIP = Object.freeze({ t: 0, type: 'skip', cue: null, a: 1, b: .5, c: .5 });
    function skip() {
      if (!pose.active || pose.done || t < track.skip || t >= track.skipTo) return false;
      t = track.skipTo; pose.skipped = true; joltN = 0; jolt.fill(0);
      while (nextEvent < track.events.length && track.events[nextEvent].t <= t && track.events[nextEvent].type !== 'flat') nextEvent++;
      emit(t);
      if (pose.eventCount < MAX_EVENTS) pose.events[pose.eventCount++] = SKIP;
      evaluate(null);
      return true;
    }
    function stop() { pose.active = false; pose.done = false; pose.eventCount = 0; t = 0; }
    function snapshot() {
      const c = pose.cam, m = pose.mon, fx = pose.fx;
      return { active: pose.active, done: pose.done, kind: pose.kind, track: pose.track, phase: pose.phase, t: pose.t,
        duration: pose.duration, skipped: pose.skipped, events: nextEvent,
        camera: { x: c.x, y: c.y, f: c.f, pitch: c.pitch, yaw: c.yaw, roll: c.roll, fov: c.fov, look: c.look },
        monster: { x: m.x, y: m.y, f: m.f, pitch: m.pitch, yaw: m.yaw, roll: m.roll, ground: m.ground, follow: m.follow },
        fx: { black: fx.black, red: fx.red, tunnel: fx.tunnel, desat: fx.desat, blur: fx.blur, aberr: fx.aberr, light: fx.light, flash: fx.flash, grave: fx.grave, gun: fx.gun } };
    }
    return Object.freeze({ start, update, skip, stop, snapshot, pose });
  }
  return Object.freeze({ create, TRACKS: Object.freeze(COMPILED), KINDS: Object.freeze(Object.keys(COMPILED)), JOINTS: deepFreeze(JOINTS.map(j => j.slice())),
    FACE: deepFreeze(FACE), LINES: deepFreeze(LINES), EVENT_TYPES: Object.freeze(EVENT_TYPES.slice()), LIMITS: deepFreeze(LIMITS),
    REDUCED: deepFreeze(REDUCED), trackFor, sample, K });
});
