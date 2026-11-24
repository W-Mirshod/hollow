/* Where a bullet lands on a creature and what it does there. Pure math (no THREE): a hit-region classifier over coarse
   capsule bodies in the creature's own frame (+z forward, +x toward its armL/legL side is -x: joint names follow the
   visuals.js rigs), per-region damage multipliers on top of HollowSystems.weaponDamage, and the stat-driven numbers
   behind every reaction: flinch strength, knockback, stagger, kneeling, gore, severing and decapitation. Everything is
   derived from the gun's stats (damage per pellet, pellet count), the damage actually dealt and the distance, never
   from a gun id, so any gun added to RULES.WEAPONS gets fitting hits. */
(function (root, factory) {
  const systems = typeof module === 'object' && module.exports ? require('./systems.js') : root.HollowSystems;
  const api = factory(systems);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HollowHitZones = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (systems) {
  'use strict';
  const REGIONS = Object.freeze(['head', 'neck', 'chest', 'gut', 'armL', 'armR', 'legL', 'legR']);
  const ZONES = Object.freeze({ head: 'head', neck: 'neck', chest: 'torso', gut: 'torso', armL: 'arm', armR: 'arm', legL: 'leg', legR: 'leg' });
  const HEAD = 0, NECK = 1, CHEST = 2, GUT = 3, ARM_L = 4, ARM_R = 5, LEG_L = 6, LEG_R = 7, TORSO = 8;
  // Non-head damage multipliers (a head hit uses weaponDamage's headshot factor). Arms barely matter, legs a little.
  const MULT = Object.freeze({ neck: 1.5, chest: 1, gut: .9, armL: .55, armR: .55, legL: .7, legR: .7 });
  const HEAVY_NECK = 1.2;
  // Body masses for knockback: the Warden and anything as broad are barely moved, a crawler is light.
  const MASS = Object.freeze({ warden: .3, gravekeeper: .22, crawler: 1.25, stalker: 1, shrieker: 1 });
  const JOINT_REGION = Object.freeze({ head: 'head', jaw: 'head', neck: 'neck', armL: 'armL', elbowL: 'armL', armR: 'armR',
    elbowR: 'armR', legL: 'legL', kneeL: 'legL', legR: 'legR', kneeR: 'legR' });

  // Capsules [region, ax, ay, az, bx, by, bz, radius] of the rest pose, fitted to the visuals.js meshes (each joint
  // segment's surface: its principal axis, the radius holding 80% of it). chest is the height (bipeds) or forward depth
  // (crawlers) where the gut ends; hip the height a fallen body's pool gathers under.
  const BODIES = {
    warden: { quad: false, height: 2.8, head: 2.35, radius: 0.58, hip: 1.06, chest: 1.55, parts: [
      [HEAD, -0.076, 2.208, 0.397, -0.032, 2.51, 0.314, 0.184],
      [NECK, -0.056, 2.167, 0.09, -0.062, 2.314, 0.214, 0.175],
      [TORSO, -0.056, 0.996, -0.002, 0.018, 1.393, 0.063, 0.333],
      [TORSO, -0.214, 1.841, -0.063, 0.208, 1.881, -0.029, 0.313],
      [TORSO, -0.308, 2.392, -0.097, 0.171, 2.359, -0.058, 0.311],
      [ARM_L, -0.529, 1.763, 0.103, -0.492, 2.255, 0.027, 0.155],
      [ARM_L, -0.534, 0.828, 0.176, -0.551, 1.632, 0.116, 0.095],
      [ARM_R, 0.557, 1.684, 0.039, 0.477, 2.118, 0.063, 0.139],
      [ARM_R, 0.564, 0.679, 0.229, 0.575, 1.569, 0.035, 0.096],
      [LEG_L, -0.303, 0.72, 0.072, -0.249, 1.104, -0.005, 0.16],
      [LEG_L, -0.299, 0.129, 0.021, -0.319, 0.596, 0.035, 0.132],
      [LEG_R, 0.305, 0.685, 0.035, 0.26, 1.022, 0.067, 0.16],
      [LEG_R, 0.308, 0.083, 0.143, 0.321, 0.571, -0.029, 0.122]] },
    stalker: { quad: false, height: 2.65, head: 2.12, radius: 0.34, hip: 1.25, chest: 1.62, parts: [
      [HEAD, -0.019, 1.907, 0.264, 0.174, 2.454, 0.176, 0.113],
      [NECK, 0.045, 1.879, 0.012, 0.082, 2.114, 0.161, 0.063],
      [TORSO, 0.018, 1.277, -0.005, -0.018, 1.63, -0.047, 0.166],
      [TORSO, -0.131, 2.016, -0.05, 0.102, 1.969, -0.009, 0.181],
      [ARM_L, -0.32, 1.572, 0.01, -0.271, 2.197, -0.034, 0.06],
      [ARM_L, -0.347, 0.483, 0.114, -0.324, 1.516, 0.01, 0.043],
      [ARM_R, 0.33, 1.622, -0.023, 0.258, 2.037, 0.038, 0.062],
      [ARM_R, 0.304, 0.893, 0.166, 0.338, 1.587, -0.031, 0.044],
      [LEG_L, -0.215, 0.768, -0.017, -0.136, 1.326, -0.038, 0.079],
      [LEG_L, -0.147, 0.072, -0.06, -0.222, 0.713, -0.046, 0.067],
      [LEG_R, 0.229, 0.625, 0.216, 0.136, 1.241, 0.055, 0.078],
      [LEG_R, 0.107, 0.074, 0.132, 0.233, 0.574, 0.199, 0.071]] },
    crawler: { quad: true, height: 0.9, head: 0.55, radius: 0.43, hip: 0.5, chest: -0.1, parts: [
      [HEAD, -0.091, 0.475, 0.496, -0.028, 0.642, 0.487, 0.129],
      [TORSO, -0.018, 0.543, -0.54, 0.028, 0.632, -0.156, 0.149],
      [TORSO, -0.053, 0.587, 0.34, 0, 0.669, 0.104, 0.161],
      [ARM_L, -0.271, 0.621, 0.231, -0.537, 0.702, 0.322, 0.068],
      [ARM_L, -0.405, 0.046, 0.742, -0.577, 0.668, 0.341, 0.058],
      [ARM_R, 0.283, 0.55, 0.177, 0.547, 0.596, 0.378, 0.068],
      [ARM_R, 0.774, 0.049, 0.747, 0.608, 0.563, 0.403, 0.062],
      [LEG_L, -0.515, 0.632, -0.624, -0.225, 0.532, -0.379, 0.073],
      [LEG_L, -0.454, 0.112, -0.684, -0.553, 0.6, -0.688, 0.07],
      [LEG_R, 0.244, 0.466, -0.443, 0.47, 0.646, -0.597, 0.072],
      [LEG_R, 0.723, 0.068, -0.427, 0.533, 0.628, -0.646, 0.066]] },
    shrieker: { quad: false, height: 2.3, head: 1.9, radius: 0.34, hip: 1.05, chest: 1.3, parts: [
      [HEAD, 0.105, 1.508, 0.307, -0.014, 2.096, 0.159, 0.111],
      [NECK, -0.009, 1.76, 0.002, 0.012, 1.913, 0.146, 0.053],
      [TORSO, 0.037, 0.847, 0.041, 0, 1.323, -0.052, 0.158],
      [TORSO, -0.144, 1.704, -0.025, 0.075, 1.649, -0.033, 0.16],
      [ARM_L, -0.32, 1.383, 0.101, -0.264, 1.799, 0.017, 0.058],
      [ARM_L, -0.285, 0.743, 0.349, -0.316, 1.352, 0.123, 0.04],
      [ARM_R, 0.348, 1.228, -0.04, 0.243, 1.724, -0.025, 0.059],
      [ARM_R, 0.173, 0.705, 0.308, 0.345, 1.198, -0.027, 0.045],
      [LEG_L, -0.194, 0.647, -0.077, -0.151, 1.064, -0.066, 0.075],
      [LEG_L, -0.18, 0.048, 0.047, -0.199, 0.594, -0.106, 0.065],
      [LEG_R, 0.18, 0.622, 0.112, 0.121, 1.114, 0.024, 0.074],
      [LEG_R, 0.171, 0.071, 0.081, 0.19, 0.574, 0.091, 0.067]] },
    gravekeeper: { quad: false, height: 3.6, head: 3.05, radius: 0.8, hip: 1.75, chest: 2.1, parts: [
      [HEAD, -0.025, 2.848, 0.202, 0.023, 3.303, 0.347, 0.198],
      [NECK, 0.02, 3.018, 0.072, 0.001, 3.056, 0.258, 0.087],
      [TORSO, 0.047, 0.911, -0.153, 0.014, 1.516, -0.112, 0.361],
      [TORSO, 0.042, 2.078, -0.215, 0.017, 2.3, -0.167, 0.275],
      [TORSO, -0.205, 2.725, -0.062, 0.232, 2.705, -0.158, 0.276],
      [TORSO, -0.015, 3.02, 0.06, 0.135, 3.119, -0.237, 0.316],
      [ARM_L, -0.504, 2.196, 0.084, -0.429, 2.836, -0.009, 0.11],
      [ARM_L, -0.509, 0.896, 0.286, -0.515, 2.065, 0.1, 0.059],
      [ARM_R, 0.511, 2.178, 0.19, 0.448, 2.759, 0.073, 0.111],
      [ARM_R, 0.488, 0.934, 0.82, 0.519, 2.061, 0.239, 0.064],
      [LEG_L, -0.235, 0.969, 0.061, -0.201, 1.734, -0.027, 0.109],
      [LEG_L, -0.222, 0.104, 0.03, -0.239, 0.863, 0.034, 0.1],
      [LEG_R, 0.242, 0.946, 0.106, 0.201, 1.673, 0.054, 0.109],
      [LEG_R, 0.231, 0.101, 0.092, 0.25, 0.845, 0.072, 0.1]] }
  };
  for (const name in BODIES) { const b = BODIES[name]; b.parts.forEach(p => Object.freeze(p)); Object.freeze(b.parts); Object.freeze(b); }
  Object.freeze(BODIES);

  const num = (v, d) => typeof v === 'number' && Number.isFinite(v) ? v : d;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const isQuad = (kind, stats) => kind === 'crawler' || (!Object.prototype.hasOwnProperty.call(BODIES, kind) && num(stats && stats.height, 2) < 1.3);

  // Known kinds use their fitted body; any other creature (a boss, a new model) scales the closest template to its stats:
  // height and head height stretch it vertically, radius widens it.
  const cache = new Map();
  function profile(kind, stats) {
    stats = stats && typeof stats === 'object' ? stats : null;
    const known = Object.prototype.hasOwnProperty.call(BODIES, kind);
    const key = known && !stats ? kind : kind + '|' + (stats ? [stats.height, stats.head, stats.radius].join(',') : '');
    if (cache.has(key)) return cache.get(key);
    const base = known ? BODIES[kind] : isQuad(kind, stats) ? BODIES.crawler : num(stats && stats.radius, .34) >= .5 ? BODIES.warden : BODIES.stalker;
    const height = num(stats && stats.height, base.height), head = num(stats && stats.head, base.head), radius = num(stats && stats.radius, base.radius);
    const sy = known ? 1 : head / base.head, top = known ? 1 : (height - head) / Math.max(.05, base.height - base.head);
    const sw = known ? 1 : radius / base.radius;
    const y = v => v <= base.head ? v * sy : head + (v - base.head) * top;
    const parts = known ? base.parts : base.parts.map(p => Object.freeze([p[0], p[1] * sw, y(p[2]), p[3] * sw, p[4] * sw, y(p[5]), p[6] * sw, p[7] * Math.sqrt(sw * Math.max(sy, .01))]));
    const out = Object.freeze({ kind: String(kind), quad: base.quad, height, head, radius, hip: y(base.hip), chest: base.quad ? base.chest * sw : y(base.chest),
      parts: known ? parts : Object.freeze(parts) });
    if (cache.size > 64) cache.clear();
    cache.set(key, out);
    return out;
  }

  // Closest approach between the ray (o + t d, t >= 0, |d| = 1) and the segment a-b. Writes [t, distance] to S.
  const S = new Float64Array(2);
  function raySegment(ox, oy, oz, dx, dy, dz, ax, ay, az, bx, by, bz) {
    const ex = bx - ax, ey = by - ay, ez = bz - az, rx = ox - ax, ry = oy - ay, rz = oz - az;
    const e = ex * ex + ey * ey + ez * ez, b = dx * ex + dy * ey + dz * ez, c = dx * rx + dy * ry + dz * rz, f = ex * rx + ey * ry + ez * rz;
    const den = e - b * b;
    let t = den > 1e-9 ? Math.max(0, (b * f - c * e) / den) : Math.max(0, -c), u = e > 1e-12 ? (b * t + f) / e : 0;
    if (u < 0) { u = 0; t = Math.max(0, -c); } else if (u > 1) { u = 1; t = Math.max(0, b - c); }
    const px = ox + dx * t - (ax + ex * u), py = oy + dy * t - (ay + ey * u), pz = oz + dz * t - (az + ez * u);
    S[0] = t; S[1] = Math.sqrt(px * px + py * py + pz * pz);
  }

  // input: { kind, stats, x, z, yaw, ox, oy, oz, dx, dy, dz, pose? } in world units; pose (the posed group:
  // { x, y, z, pitch, yaw, roll }, rotation order YXZ) moves the upper body, the legs stay on the creature's footprint.
  // Returns the region name (and fills `out` when given: region, zone, headshot, local hit point, t along the ray).
  const L = new Float64Array(12);
  function classify(input, out) {
    const i = input && typeof input === 'object' ? input : {}, P = profile(i.kind, i.stats);
    let dx = num(i.dx, 0), dy = num(i.dy, 0), dz = num(i.dz, -1);
    const dl = Math.hypot(dx, dy, dz) || 1; dx /= dl; dy /= dl; dz /= dl;
    const ox = num(i.ox, 0), oy = num(i.oy, 1.5), oz = num(i.oz, 0), mx = num(i.x, 0), mz = num(i.z, 0), yaw = num(i.yaw, 0);
    const pose = i.pose && typeof i.pose === 'object' ? i.pose : null;
    // Legs: the creature's footprint frame.
    let c = Math.cos(yaw), s = Math.sin(yaw), rx = ox - mx, rz = oz - mz;
    L[0] = rx * c - rz * s; L[1] = oy; L[2] = rx * s + rz * c; L[3] = dx * c - dz * s; L[4] = dy; L[5] = dx * s + dz * c;
    // Upper body: the inverse of the posed group's transform (translate, yaw, pitch, roll).
    if (pose) {
      const gy = num(pose.yaw, yaw), pitch = num(pose.pitch, 0), roll = num(pose.roll, 0);
      c = Math.cos(gy); s = Math.sin(gy);
      const cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
      for (let k = 0; k < 2; k++) {
        const vx = k ? dx : ox - num(pose.x, mx), vy = k ? dy : oy - num(pose.y, 0), vz = k ? dz : oz - num(pose.z, mz);
        const ax = vx * c - vz * s, az = vx * s + vz * c;
        const by = vy * cp + az * sp, bz = -vy * sp + az * cp;
        L[6 + k * 3] = ax * cr + by * sr; L[7 + k * 3] = -ax * sr + by * cr; L[8 + k * 3] = bz;
      }
    } else for (let k = 0; k < 6; k++) L[6 + k] = L[k];
    let best = -1, bestT = Infinity, near = -1, nearGap = Infinity, hitT = 0;
    const parts = P.parts;
    for (let p = 0; p < parts.length; p++) {
      const q = parts[p], o = q[0] >= LEG_L && q[0] <= LEG_R ? 0 : 6, r = q[7];
      raySegment(L[o], L[o + 1], L[o + 2], L[o + 3], L[o + 4], L[o + 5], q[1], q[2], q[3], q[4], q[5], q[6]);
      const t = S[0], d = S[1];
      if (d <= r) { const at = Math.max(0, t - Math.sqrt(r * r - d * d)); if (at < bestT) { bestT = at; best = p; } }
      else if (d - r < nearGap) { nearGap = d - r; near = p; hitT = t; }
    }
    const pick = best >= 0 ? best : near, t = best >= 0 ? bestT : hitT, q = parts[pick < 0 ? 0 : pick];
    const o = q[0] >= LEG_L && q[0] <= LEG_R ? 0 : 6;
    const lx = L[o] + L[o + 3] * t, ly = L[o + 1] + L[o + 4] * t, lz = L[o + 2] + L[o + 5] * t;
    let region = q[0];
    if (region === TORSO) region = P.quad ? (lz >= P.chest ? CHEST : GUT) : ly >= P.chest ? CHEST : GUT;
    // A ray that grazes the hit cylinder without touching the body keeps the old rule: entering above the head pivot is
    // a headshot (a crawler's only through the front half of its cylinder).
    const a = L[3] * L[3] + L[5] * L[5], b = 2 * (L[0] * L[3] + L[2] * L[5]), cc = L[0] * L[0] + L[2] * L[2] - P.radius * P.radius;
    const disc = b * b - 4 * a * cc, drop = pose ? Math.min(0, num(pose.y, 0)) : 0;
    if (best < 0 && a > 1e-9 && disc >= 0) {
      const sq = Math.sqrt(disc);
      let at = (-b - sq) / (2 * a);
      if (at < 0) at = (-b + sq) / (2 * a);
      if (at >= 0 && L[1] + L[4] * at > P.head + drop && (!P.quad || L[2] + L[5] * at > -.1)) region = HEAD;
    }
    const name = REGIONS[region];
    if (out && typeof out === 'object') {
      out.region = name; out.zone = ZONES[name]; out.headshot = region === HEAD; out.exact = best >= 0;
      out.x = lx; out.y = ly; out.z = lz; out.t = t; out.side = lx < 0 ? -1 : 1;
    }
    return name;
  }

  // The region of a mesh hit: the nearest named joint above it (head before neck), else the torso split by height.
  function jointRegion(name) { return typeof name === 'string' && Object.prototype.hasOwnProperty.call(JOINT_REGION, name) ? JOINT_REGION[name] : null; }
  function torsoRegion(kind, stats, ly, lz) {
    const P = profile(kind, stats);
    if (P.quad) return num(lz, 0) >= P.chest ? 'chest' : 'gut';
    return num(ly, 0) >= P.chest ? 'chest' : 'gut';
  }
  // A body lying on the floor is three points along it (game.js layDown): feet end, middle, head end.
  function layRegion(kind, k, side) {
    const left = num(side, 1) < 0;
    return k <= 0 ? (left ? 'legL' : 'legR') : k === 1 ? 'gut' : 'chest';
  }

  function regionName(r) { return typeof r === 'string' && Object.prototype.hasOwnProperty.call(ZONES, r) ? r : 'chest'; }
  function multiplier(kind, region, stats) {
    region = regionName(region);
    if (region === 'head') return 1;
    if (region === 'neck' && mass(kind, stats) < .5) return HEAVY_NECK;
    return MULT[region];
  }
  function weaponOf(w) {
    if (w && typeof w === 'object') return w;
    const list = systems && systems.WEAPONS ? systems.WEAPONS : [];
    return list.find(v => v.id === w) || list[0] || { id: 'rifle', damage: 1, pellets: 1 };
  }
  // Damage of one pellet: weaponDamage's falloff and headshot factor, then the region's multiplier. A gun that is not in
  // RULES.WEAPONS (only its stats are known) deals its own damage with the same headshot factors.
  function damage(weapon, region, distance, kind, stats) {
    const w = weaponOf(weapon), head = regionName(region) === 'head';
    const listed = !!systems && Array.isArray(systems.WEAPONS) && systems.WEAPONS.some(v => v.id === w.id) && typeof systems.weaponDamage === 'function';
    const base = listed ? systems.weaponDamage(w.id, head, num(distance, 0), kind) : num(w.damage, 1) * (head ? (kind === 'warden' ? 1.1 : 1.85) : 1);
    return base * multiplier(kind, region, stats);
  }
  function mass(kind, stats) {
    if (Object.prototype.hasOwnProperty.call(MASS, kind)) return MASS[kind];
    const r = num(stats && stats.radius, .34), h = num(stats && stats.height, 2.4);
    if (h < 1.3) return 1.25;
    return r >= .5 ? clamp(.3 * Math.pow(.58 / r, 1.5) * (2.8 / Math.max(2.8, h)), .12, .3) : 1;
  }

  // One pellet's physical effect. weapon: {damage, pellets}; hit: {region, dealt, distance, kind, stats}.
  // force: flinch strength (1 = an unaimed carbine round in the chest); knock: m/s of shove along the bullet;
  // stagger: seconds slowed; blood: atmosphere blood amount; wound: entry size m; exit: exit wound size (0 = none);
  // reach: metres an exit spray carries; variant/weight: the flesh impact sound.
  function impact(weapon, hit, out) {
    const w = weaponOf(weapon), h = hit && typeof hit === 'object' ? hit : {}, o = out && typeof out === 'object' ? out : {};
    const pellets = Math.max(1, Math.round(num(w.pellets, 1))), spread = pellets > 1, region = regionName(h.region), zone = ZONES[region];
    const dealt = Math.max(0, num(h.dealt, num(w.damage, 1))), dist = Math.max(0, num(h.distance, 5)), m = mass(h.kind, h.stats);
    const force = dealt * (spread ? .45 : 1), close = 1 / (1 + Math.max(0, dist - 2) / 14);
    o.region = region; o.zone = zone; o.force = force;
    o.strength = clamp(force, 0, 2);
    o.knock = clamp(.42 * force * m * close, 0, 6);
    o.stagger = (zone === 'leg' ? .3 + .45 * Math.min(1.6, force) : zone === 'arm' ? .08 : zone === 'head' ? .22 + .18 * Math.min(1.5, force)
      : region === 'gut' ? .32 : .25) * (m < .5 ? .3 : 1);
    o.heat = force;
    o.blood = clamp((spread ? .7 : 1) * Math.pow(dealt, .8) * (zone === 'head' ? 1.3 : zone === 'arm' || zone === 'leg' ? .8 : 1), .2, 4);
    o.wound = clamp(.045 + .03 * Math.sqrt(dealt) * (spread ? .8 : 1), .035, .14);
    o.exit = !spread && dealt >= .9 || dealt >= 1.6 ? clamp(.07 + .06 * dealt, .08, .32) : 0;
    o.reach = clamp(1.2 + 1.1 * dealt * (spread ? .5 : 1), 1, 3.2);
    o.variant = zone === 'head' && dealt >= .9 ? 'bone' : dealt >= 2 || spread && dist < 4 ? 'meaty' : 'thwack';
    o.weight = clamp(.55 + .35 * dealt, .45, 1.6);
    return o;
  }

  // A whole shot's verdict on one creature. tally: {head, neck, chest, gut, armL, armR, legL, legR (damage dealt per
  // region this shot), force (summed pellet force), distance, killed, kind, stats, maxPellet}; weapon as in impact().
  // kneel: a shotgun-class leg hit drops a biped to one knee; gib: the head comes apart; jaw: a lighter killing
  // headshot tears the jaw off; sever: 'armL' | 'armR' torn off by a close heavy killing blow; chunks: flesh bits;
  // deathForce: 0..3 momentum handed to the death fall; region: the region that took the most.
  function verdict(weapon, tally, out) {
    const w = weaponOf(weapon), t = tally && typeof tally === 'object' ? tally : {}, o = out && typeof out === 'object' ? out : {};
    const pellets = Math.max(1, Math.round(num(w.pellets, 1))), dist = Math.max(0, num(t.distance, 5)), m = mass(t.kind, t.stats);
    const P = profile(t.kind, t.stats), killed = !!t.killed;
    const v = r => Math.max(0, num(t[r], 0));
    const head = v('head'), legs = v('legL') + v('legR'), arms = v('armL') + v('armR');
    const total = head + v('neck') + v('chest') + v('gut') + arms + legs, maxPellet = Math.max(0, num(t.maxPellet, total / pellets));
    let region = 'chest', most = -1;
    for (const r of REGIONS) if (v(r) > most) { most = v(r); region = r; }
    const close = dist <= 6;
    o.region = region; o.total = total;
    o.kneel = !killed && !P.quad && legs * m >= 1.55 && legs >= .5 * total;
    o.kneelSide = v('legL') >= v('legR') ? 'legL' : 'legR';
    o.gib = killed && head > 0 && (head >= 1.5 || pellets > 1 && close && head >= 1.2);
    o.jaw = killed && head > 0 && !o.gib;
    const armHit = arms >= 1 && (close || maxPellet >= 2), blast = total >= 4 && dist <= 3.5 && pellets > 1;
    o.sever = killed && !o.gib && (armHit || blast || maxPellet >= 3 && dist <= 8 && (region === 'chest' || region === 'armL' || region === 'armR'))
      ? (v('armL') === v('armR') ? (num(t.side, 1) < 0 ? 'armL' : 'armR') : v('armL') > v('armR') ? 'armL' : 'armR') : '';
    o.chunks = Math.round(clamp((killed ? 2 : 0) + total * (o.gib ? 2.6 : killed ? 1.1 : .35) * (maxPellet >= 2 || pellets > 1 && close ? 1.4 : 1), 0, 16));
    if (!killed && maxPellet < 1.6 && !(pellets > 1 && close && total >= 2.5)) o.chunks = 0;
    o.deathForce = clamp(num(t.force, total) * Math.min(1.3, m) / (1 + Math.max(0, dist - 3) / 10) * .55, 0, 3);
    return o;
  }

  return Object.freeze({ REGIONS, ZONES, BODIES, profile, classify, jointRegion, torsoRegion, layRegion, multiplier, damage, mass, impact, verdict });
});
