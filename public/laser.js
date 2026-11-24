/* The laser burst: a ring of laser beams out of the survivor on every side, at a few heights, that reach out to their
   range, sweep round once and cut down every creature the walls, closed doors and furniture do not shield.
   The pure part: where a floor's charges lie along its corridors (place), how far each beam gets before something
   stops it (scan, reach), which bodies the beams cross (targets). The effect: the beams (a white-hot core in a red
   glow), the blast rings and the flash at the chest, all additive and instanced (four draw calls for any number of
   bursts, update() allocates nothing), and the charge lying on the floor (pickup). Angles go round the circle with
   direction (cos a, sin a) in x, z. Works with three's WebGPURenderer and plain three in tests.
   HollowLaser.create({ THREE, scene, quality, effects }). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HollowLaser = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const NOOP = Object.freeze({});
  const TAU = Math.PI * 2;
  const finite = (v, d) => Number.isFinite(v) ? v : d;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  // The timeline (s): the beams leave START m out (clear of the survivor's own eyes) and reach out at SPEED m/s, sweep
  // round one beam's spacing until SWEEP (they cut until then), and are gone at END.
  const SPEED = 45, START = .8, SWEEP = .75, END = 1.05;
  // Beams per height by quality (fewer, dimmer, steadier with effects off); directions scanned round the circle.
  const QUALITY = Object.freeze({ high: 20, medium: 16, low: 12 });
  const MAX_BURSTS = 3, MAX_LAYERS = 4, BINS = 180, CORE_W = .007, GLOW_W = .034;

  // How far the beams have got `t` s after the burst, out to `range`.
  function front(t, range) { return Math.min(finite(range, 8.5), START + SPEED * Math.max(0, finite(t, 0))); }

  // Corridor cells for `count` charges along the way. dist: a size*size field of steps from the start (-1 where it
  // cannot be reached); cells at least `near` steps out are split into `count` bands by that distance, and one is
  // picked at random in each band (rand: the floor's own seeded stream) at least `spacing` cells (Manhattan) from the
  // others. skip(cx, cz): cells to leave out (rooms, the lobby, the exit, other pickups, furniture). Returns
  // [{cx, cz, d}], nearest band first.
  function place(o) {
    o = o || NOOP;
    const size = Math.max(0, o.size | 0), dist = o.dist, count = Math.max(0, o.count | 0), rand = typeof o.rand === 'function' ? o.rand : Math.random;
    const near = finite(o.near, 6), spacing = finite(o.spacing, 6), skip = typeof o.skip === 'function' ? o.skip : () => false;
    if (!size || !dist || !count) return [];
    const cand = [];
    for (let z = 0; z < size; z++) for (let x = 0; x < size; x++) { const d = dist[z * size + x]; if (d >= near && !skip(x, z)) cand.push({ cx: x, cz: z, d }); }
    cand.sort((a, b) => a.d - b.d || a.cz - b.cz || a.cx - b.cx);
    const out = [], far = c => out.every(p => Math.abs(p.cx - c.cx) + Math.abs(p.cz - c.cz) >= spacing);
    for (let band = 0; band < count && cand.length; band++) {
      const pool = cand.slice(Math.floor(band * cand.length / count), Math.floor((band + 1) * cand.length / count));
      for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const k = pool[i]; pool[i] = pool[j]; pool[j] = k; }
      // A band too crowded by the picks before it gives way to the nearest free cell beyond it.
      const pick = pool.find(far) || cand.slice(Math.floor((band + 1) * cand.length / count)).find(far);
      if (pick) out.push({ cx: pick.cx, cz: pick.cz, d: pick.d });
    }
    return out;
  }

  // How far each beam gets: for each of `heights` (m above y) and BINS directions round the circle, the distance
  // (up to range) at which blocks(x, y, z) first stops it, marched every `step` m.
  function scan(o) {
    o = o || NOOP;
    const x = finite(o.x, 0), y = finite(o.y, 0), z = finite(o.z, 0), range = clamp(finite(o.range, 8.5), .5, 40);
    const heights = (Array.isArray(o.heights) && o.heights.length ? o.heights : [1.15]).slice(0, MAX_LAYERS).map(h => finite(h, 1.15));
    const blocks = typeof o.blocks === 'function' ? o.blocks : null, bins = Math.max(8, Math.round(finite(o.bins, BINS))), step = clamp(finite(o.step, .12), .02, 1);
    const table = new Float32Array(heights.length * bins).fill(range);
    if (blocks) for (let h = 0; h < heights.length; h++) {
      const hy = y + heights[h];
      for (let i = 0; i < bins; i++) {
        const a = i / bins * TAU, dx = Math.cos(a), dz = Math.sin(a);
        for (let s = step; s <= range + 1e-6; s += step) if (blocks(x + dx * s, hy, z + dz * s)) { table[h * bins + i] = Math.max(0, s - step * .5); break; }
      }
    }
    return { x, y, z, range, heights, bins, table };
  }
  // The scanned reach of height `layer` toward `angle` (the nearest direction scanned).
  function reach(s, layer, angle) {
    const b = s.bins;
    let i = Math.round(finite(angle, 0) / TAU * b) % b;
    if (i < 0) i += b;
    return s.table[clamp(layer | 0, 0, s.heights.length - 1) * b + i];
  }

  // The bodies the beams cut: bodies [{x, z, r, bottom, top}] (or null), the span of heights above the floor each
  // stands in. A body is cut when a beam height inside its span reaches its near side, within the beams' `front`
  // (range when not given), with nothing in the way (blocks, marched every `step` m). Returns [{index, distance, layer}]
  // nearest first: distance to its near side, layer the first height that got through.
  function targets(o) {
    o = o || NOOP;
    const x = finite(o.x, 0), y = finite(o.y, 0), z = finite(o.z, 0), range = finite(o.range, 8.5), reachOut = Math.min(range, finite(o.front, range));
    const heights = Array.isArray(o.heights) && o.heights.length ? o.heights : [1.15], blocks = typeof o.blocks === 'function' ? o.blocks : null;
    const step = clamp(finite(o.step, .1), .02, 1), bodies = Array.isArray(o.bodies) ? o.bodies : [], out = [];
    for (let index = 0; index < bodies.length; index++) {
      const b = bodies[index];
      if (!b) continue;
      const dx = finite(b.x, 0) - x, dz = finite(b.z, 0) - z, d = Math.hypot(dx, dz), near = Math.max(0, d - Math.max(0, finite(b.r, .3)));
      if (near > reachOut) continue;
      const bottom = finite(b.bottom, 0), top = finite(b.top, 2), ux = d > 1e-6 ? dx / d : 0, uz = d > 1e-6 ? dz / d : 0;
      for (let h = 0; h < heights.length; h++) {
        const hy = y + heights[h];
        if (hy < bottom || hy > top) continue;
        let clear = true;
        if (blocks) for (let s = step; s < near; s += step) if (blocks(x + ux * s, hy, z + uz * s)) { clear = false; break; }
        if (clear) { out.push({ index, distance: near, layer: h }); break; }
      }
    }
    return out.sort((a, b) => a.distance - b.distance);
  }

  function create(options) {
    const o = options && typeof options === 'object' ? options : NOOP, THREE = o.THREE, scene = o.scene;
    if (!THREE || !scene || typeof scene.add !== 'function') throw new TypeError('HollowLaser needs THREE and a scene');
    let quality = Object.prototype.hasOwnProperty.call(QUALITY, o.quality) ? o.quality : 'high', effects = o.effects !== false, disposed = false;
    const owned = [], keep = x => { owned.push(x); return x; };
    const meshes = [], MAXI = MAX_BURSTS * MAX_LAYERS * QUALITY.high;
    const M = new THREE.Matrix4(), P = new THREE.Vector3(), Q = new THREE.Quaternion(), SC = new THREE.Vector3(), C = new THREE.Color(), UP = new THREE.Vector3(0, 1, 0);
    const QI = new THREE.Quaternion();

    /* ---------- meshes ---------- */
    const additive = (color, double, ramp) => keep(new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      side: double ? THREE.DoubleSide : THREE.FrontSide, vertexColors: !!ramp }));
    function instanced(geo, mat, count, name) {
      const mesh = new THREE.InstancedMesh(geo, mat, count);
      mesh.name = 'laser:' + name; mesh.count = 0; mesh.visible = false; mesh.frustumCulled = false; mesh.renderOrder = 3;
      mesh.castShadow = false; mesh.receiveShadow = false; mesh.matrixAutoUpdate = false;
      // The colour attribute (each instance's brightness) exists from the start: one pipeline for the mesh's whole life.
      C.setRGB(1, 1, 1);
      for (let i = 0; i < count; i++) mesh.setColorAt(i, C);
      if (THREE.DynamicDrawUsage) { mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.instanceColor.setUsage(THREE.DynamicDrawUsage); }
      scene.add(mesh); meshes.push(mesh);
      return mesh;
    }
    // A beam is a unit box from x 0 to 1, scaled to its length along +x and to its thickness across. Its vertex colours
    // ramp up over the first part of its length: dim beside the survivor (where a beam fills the eye), white-hot out
    // to where it strikes.
    const beamGeo = keep(new THREE.BoxGeometry(1, 1, 1, 16, 1, 1)); beamGeo.translate(.5, 0, 0);
    const pos = beamGeo.attributes.position, ramp = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) { const k = clamp(pos.getX(i) / .3, 0, 1), v = .06 + .94 * k * k * (3 - 2 * k); ramp[i * 3] = ramp[i * 3 + 1] = ramp[i * 3 + 2] = v; }
    beamGeo.setAttribute('color', new THREE.BufferAttribute(ramp, 3));
    const ringGeo = keep(new THREE.RingGeometry(.955, 1, 64)); ringGeo.rotateX(-Math.PI / 2);
    const flareGeo = keep(new THREE.IcosahedronGeometry(1, 2));
    const core = instanced(beamGeo, additive(new THREE.Color(1, .62, .55), false, true), MAXI, 'core');
    const glow = instanced(beamGeo, additive(new THREE.Color(1, .07, .035), false, true), MAXI, 'glow');
    const ring = instanced(ringGeo, additive(new THREE.Color(1, .16, .07), true), MAX_BURSTS * 2, 'ring');
    const flare = instanced(flareGeo, additive(new THREE.Color(1, .42, .3)), MAX_BURSTS, 'flare');

    /* ---------- bursts ---------- */
    const bursts = Array.from({ length: MAX_BURSTS }, () => ({ active: false, t: 0, scan: null, base: 0, spin: 1, id: 0, flare: true }));
    let serial = 0;
    // A burst from what scan() saw. angle: where the first beam points; spin: 1 or -1, the way they sweep; flare: false
    // leaves out the flash at the chest (the survivor's own burst, seen from inside it).
    function fire(p) {
      if (disposed || !p || !p.scan || !p.scan.table) return 0;
      let b = bursts.find(c => !c.active);
      if (!b) b = bursts.reduce((a, c) => c.t > a.t ? c : a);
      b.active = true; b.t = 0; b.scan = p.scan; b.base = finite(p.angle, 0); b.spin = p.spin === -1 ? -1 : 1; b.id = ++serial; b.flare = p.flare !== false;
      return b.id;
    }
    const ease = k => k * k * (3 - 2 * k);
    let lastFront = 0, lastT = 0;
    function update(dt) {
      if (disposed) return;
      dt = clamp(finite(dt, 0), 0, .1);
      const per = Math.max(4, Math.round(QUALITY[quality] * (effects ? 1 : .6))), spacing = TAU / per;
      let nb = 0, nr = 0, nf = 0;
      lastFront = 0; lastT = 0;
      for (const b of bursts) {
        if (!b.active) continue;
        b.t += dt;
        if (b.t >= END) { b.active = false; b.scan = null; continue; }
        const s = b.scan, t = b.t, reachOut = front(t, s.range);
        lastFront = Math.max(lastFront, reachOut); lastT = Math.max(lastT, t);
        // Full strength while they cut, then fading; a fast shimmer on top with effects on.
        const on = Math.min(1, t / .04) * (t < SWEEP ? 1 : Math.pow(1 - (t - SWEEP) / (END - SWEEP), 1.5));
        const shimmer = effects ? .84 + .16 * Math.sin(t * 95 + b.id * 1.7) : 1;
        const turn = b.base + b.spin * spacing * 1.15 * ease(clamp(t / SWEEP, 0, 1));
        for (let h = 0; h < s.heights.length; h++) {
          const y = s.y + s.heights[h], offset = h * spacing / s.heights.length;
          for (let j = 0; j < per && nb < MAXI; j++) {
            const a = turn + offset + j * spacing, len = Math.min(reachOut, reach(s, h, a));
            if (len <= START + .03) continue;
            P.set(s.x + Math.cos(a) * START, y, s.z + Math.sin(a) * START); Q.setFromAxisAngle(UP, -a);
            SC.set(len - START, CORE_W, CORE_W); M.compose(P, Q, SC); core.setMatrixAt(nb, M);
            const w = GLOW_W * (.55 + .45 * on);
            SC.set(len - START, w, w); M.compose(P, Q, SC); glow.setMatrixAt(nb, M);
            C.setScalar(2.4 * on * shimmer); core.setColorAt(nb, C);
            C.setScalar(.85 * on * shimmer); glow.setColorAt(nb, C);
            nb++;
          }
        }
        // The blast rings: one along the floor and one at chest height, out with the beams' front.
        const rk = Math.max(0, 1 - t / .55);
        if (rk > 0) for (const ry of [.04, s.heights[Math.min(1, s.heights.length - 1)]]) {
          P.set(s.x, s.y + ry, s.z); SC.set(reachOut, 1, reachOut); M.compose(P, QI, SC); ring.setMatrixAt(nr, M);
          C.setScalar(rk * rk * (ry < .1 ? .8 : 1.3)); ring.setColorAt(nr, C); nr++;
        }
        // The flash at the chest where they came from.
        const fk = b.flare ? Math.max(0, 1 - t / .3) : 0;
        if (fk > 0) {
          P.set(s.x, s.y + 1.15, s.z); SC.setScalar(.1 + .32 * (1 - fk)); M.compose(P, QI, SC); flare.setMatrixAt(nf, M);
          C.setScalar(2.2 * fk); flare.setColorAt(nf, C); nf++;
        }
      }
      draw(core, nb); draw(glow, nb); draw(ring, nr); draw(flare, nf);
      if (warmed) holdWarm();
    }
    function draw(mesh, n) {
      mesh.count = n; mesh.visible = n > 0;
      if (n) { mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor.needsUpdate = true; }
    }
    function clear() { for (const b of bursts) { b.active = false; b.scan = null; } for (const m of meshes) draw(m, 0); }
    // prewarm(true): every mesh draws (at least) one instance, so a renderer.compileAsync() pass builds its pipelines
    // before the first burst instead of on it; prewarm(false) puts back exactly what was drawn before.
    let warmed = null;
    function holdWarm() { for (const m of meshes) { if (m.count < 1) m.count = 1; m.visible = true; } }
    function prewarm(on) {
      if (disposed) return;
      if (on && !warmed) { warmed = meshes.map(m => [m.count, m.visible]); holdWarm(); }
      else if (!on && warmed) { meshes.forEach((m, i) => { m.count = warmed[i][0]; m.visible = warmed[i][1]; }); warmed = null; }
    }

    /* ---------- the charge on the floor ---------- */
    // A squat hexagonal canister with two glowing bands and a lens on top, standing in a soft red glow: geometry and
    // materials shared by every charge (pulse() beats them all together); the caller owns each group it gets.
    let parts = null;
    function radial() {
      const n = 64, data = new Uint8Array(n * n * 4);
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        const r = Math.min(1, Math.hypot((x + .5) / n * 2 - 1, (y + .5) / n * 2 - 1)), i = (y * n + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = 255; data[i + 3] = Math.round(255 * Math.pow(1 - r, 2.2));
      }
      const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
      t.magFilter = t.minFilter = THREE.LinearFilter; t.needsUpdate = true;
      return t;
    }
    function pickupParts() {
      if (parts) return parts;
      parts = {
        metal: keep(new THREE.MeshStandardMaterial({ color: 0x23272b, metalness: .85, roughness: .32 })),
        trim: keep(new THREE.MeshStandardMaterial({ color: 0x80868b, metalness: .9, roughness: .24 })),
        hot: keep(new THREE.MeshStandardMaterial({ color: 0x2a0402, emissive: 0xff2a14, emissiveIntensity: 2.6, roughness: .4 })),
        halo: keep(new THREE.MeshBasicMaterial({ map: keep(radial()), color: 0xff3a24, transparent: true, opacity: .5, depthWrite: false, blending: THREE.AdditiveBlending })),
        body: keep(new THREE.CylinderGeometry(.11, .125, .2, 6)), cap: keep(new THREE.CylinderGeometry(.135, .135, .035, 6)),
        band: keep(new THREE.TorusGeometry(.124, .013, 6, 24)), lens: keep(new THREE.SphereGeometry(.05, 14, 7, 0, TAU, 0, Math.PI / 2)),
        disc: keep(new THREE.CircleGeometry(.6, 28))
      };
      return parts;
    }
    function pickup() {
      const k = pickupParts(), g = new THREE.Group(), spin = new THREE.Group();
      g.name = 'laser:pickup'; g.add(spin);
      const part = (geo, mat, y, flat) => { const m = new THREE.Mesh(geo, mat); m.position.y = y; if (flat) m.rotation.x = Math.PI / 2; m.castShadow = true; spin.add(m); return m; };
      part(k.body, k.metal, .14); part(k.cap, k.trim, .035); part(k.cap, k.trim, .245);
      part(k.band, k.hot, .1, true); part(k.band, k.hot, .18, true); part(k.lens, k.hot, .262);
      const disc = new THREE.Mesh(k.disc, k.halo); disc.rotation.x = -Math.PI / 2; disc.position.y = .012; disc.renderOrder = 2; g.add(disc);
      g.userData.spin = spin;
      return g;
    }
    function pulse(time) {
      if (!parts) return;
      const k = .5 + .5 * Math.sin(finite(time, 0) * 4);
      parts.hot.emissiveIntensity = 1.6 + 2.2 * k; parts.halo.opacity = .3 + .3 * k;
    }

    function setQuality(q) { if (Object.prototype.hasOwnProperty.call(QUALITY, q)) quality = q; }
    function setEffects(on) { effects = on !== false; }
    function active() { return bursts.some(b => b.active); }
    function snapshot() {
      return { quality, effects, active: bursts.filter(b => b.active).length, beams: core.count, rings: ring.count, flares: flare.count, front: lastFront, t: lastT,
        perHeight: Math.max(4, Math.round(QUALITY[quality] * (effects ? 1 : .6))) };
    }
    function dispose() {
      if (disposed) return;
      disposed = true;
      for (const m of meshes) { if (m.parent) m.parent.remove(m); if (m.dispose) m.dispose(); }
      for (const x of owned) if (x && typeof x.dispose === 'function') x.dispose();
      owned.length = 0; parts = null;
    }

    return Object.freeze({ fire, update, clear, prewarm, pickup, pulse, setQuality, setEffects, active, snapshot, dispose, meshes: Object.freeze(meshes.slice()) });
  }

  return Object.freeze({ create, place, scan, reach, targets, front, QUALITY, SPEED, START, SWEEP, END, MAX_BURSTS, BINS });
});
