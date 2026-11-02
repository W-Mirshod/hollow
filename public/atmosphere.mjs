// HollowAtmosphere: GPU-cheap volumetric light shafts, torch beam, dust motes, emergency beacons, bullet tracers and
// pooled impact particles (sparks / blood / debris + floor splats) for WebGPURenderer (WebGPU or its WebGL2 backend).
// Everything is emissive or blended geometry built from TSL node materials: no lights are created, every effect
// system is one instanced draw call over a fixed pool (beacons: housing + light), and update() performs no allocations.
const QUALITY = Object.freeze({
  low: Object.freeze({ dust: 150, particles: 0.45, slices: 4, decals: 32, tracers: 16, tracerWidth: 0.8 }),
  medium: Object.freeze({ dust: 320, particles: 0.75, slices: 6, decals: 64, tracers: 48, tracerWidth: 1 }),
  high: Object.freeze({ dust: 560, particles: 1, slices: 8, decals: 96, tracers: 48, tracerWidth: 1 })
});
const MAX_CONES = 64, MAX_BEACONS = 12, MAX_SPARKS = 640, MAX_MATTER = 512, MAX_DECALS = 96, MAX_DUST = 560, MAX_TRACERS = 48, LIT = 8;
const PUFF = 0, DROP = 1, CHIP = 2, DOME_Y = 0.115, BLADE = 3.4, BLADE_SLOPE = 0.16, BEACON_GAIN = 4, GRAVITY = 9.8;
const NOOP_HANDLE = Object.freeze({ setIntensity() {}, setColor() {}, setActive() {}, setAngle() {}, dispose() {} });
const NO_INPUT = Object.freeze({});
// camera-space muzzle of the game's rifle at the hip: tracers fired from the eye start here so they read as streaks
const MUZZLE = Object.freeze({ x: 0.21, y: -0.21, z: -1.1 }), SHORT_SHOT = 1.5, FLASH_LIFE = 0.05, HALO = 3;
const finite = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const tier = v => (typeof v === 'string' && Object.prototype.hasOwnProperty.call(QUALITY, v) ? v : null);

// Numbers written every frame live in class instances: V8 keeps their fields unboxed, whereas a store into an
// object-literal field, a closure variable or a uniform's .value allocates a fresh heap number.
class FrameState { constructor() { this.now = 0; this.dt = 0; this.dust = 0; this.flick = 1; this.slow = 1; this.decalEnd = -1; } }
class Fixture {   // a light cone or a beacon
  constructor(slot, x, y, z, color, intensity, bounds) {
    this.slot = slot; this.x = x; this.y = y; this.z = z; this.color = color; this.intensity = intensity; this.bounds = bounds || null;
    this.live = true; this.r0 = 0; this.R = 0; this.L = 0; this.seed = 0; this.angle = 0; this.active = false;
  }
}
class BeamRecord {   // level = intensity after torch state and flicker; color = base * level (the uniform's value)
  constructor(mesh, base, color, flicker, length, angle) {
    this.mesh = mesh; this.base = base; this.color = color; this.flicker = flicker; this.length = length; this.angle = angle;
    this.intensity = 1; this.level = 1; this.live = true;
  }
}

// Tileable value-noise fbm, 4 channels with different frequencies (R low, G mid, B high, A cellular specks).
function noiseTexture(THREE, size = 128) {
  let seed = 0x9e3779b9;
  const rand = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const channel = periods => {
    const out = new Float32Array(size * size);
    let amp = 1;
    for (const g of periods) {
      const lat = new Float32Array(g * g); for (let i = 0; i < lat.length; i++) lat[i] = rand();
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const fx = x / size * g, fy = y / size * g, xi = Math.floor(fx), yi = Math.floor(fy), u = fx - xi, w = fy - yi;
        const su = u * u * (3 - 2 * u), sw = w * w * (3 - 2 * w), x1 = (xi + 1) % g, y1 = (yi + 1) % g;
        const a = lat[yi * g + xi], b = lat[yi * g + x1], c = lat[y1 * g + xi], d = lat[y1 * g + x1];
        out[y * size + x] += (a + (b - a) * su + (c - a) * sw + (a - b - c + d) * su * sw) * amp;
      }
      amp *= 0.5;
    }
    let lo = Infinity, hi = -Infinity; for (const v of out) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    for (let i = 0; i < out.length; i++) out[i] = (out[i] - lo) / (hi - lo || 1);
    return out;
  };
  const r = channel([4, 8, 16, 32]), g = channel([8, 16, 32, 64]), b = channel([16, 32, 64]);
  const specks = new Float32Array(size * size), cells = 12, pts = [], reach = size / cells * 0.5;
  for (let i = 0; i < cells * cells; i++) pts.push([(i % cells + rand()) / cells * size, (Math.floor(i / cells) + rand()) / cells * size, 0.2 + 0.8 * rand() ** 1.5]);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let best = 0;
    for (const [px, py, amp] of pts) {
      let dx = Math.abs(px - x), dy = Math.abs(py - y); dx = Math.min(dx, size - dx); dy = Math.min(dy, size - dy);
      best = Math.max(best, Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) / reach) * amp);
    }
    specks[y * size + x] = best;
  }
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) { data[i * 4] = r[i] * 255; data[i * 4 + 1] = g[i] * 255; data[i * 4 + 2] = b[i] * 255; data[i * 4 + 3] = specks[i] * 255; }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false; tex.colorSpace = THREE.NoColorSpace; tex.needsUpdate = true;
  return tex;
}

function create(options) {
  options = options || {};
  const THREE = options.THREE || globalThis.THREE, TSL = options.TSL || globalThis.TSL;
  const scene = options.scene, camera = options.camera || null;
  if (!THREE || !TSL || !scene) throw new Error('HollowAtmosphere.create needs THREE, TSL and a scene.');
  const { Fn, attribute, uniform, uniformArray, varying, float, vec2, vec3, vec4, mix, smoothstep, step, select, max, min, exp, sin, cos,
    fract, textureLevel, positionGeometry, normalGeometry, positionWorld, cameraPosition, cameraViewMatrix, cameraWorldMatrix, modelWorldMatrix,
    uv, screenSize } = TSL;
  // Q caches the tier's settings: hot paths never look QUALITY up by a string key (V8 deopts on non-internalized keys)
  let quality = tier(options.quality) || 'medium', Q = QUALITY[quality], effects = options.effects !== false, disposed = false;
  const st = new FrameState();
  const meshes = [], disposables = [];
  const noise = noiseTexture(THREE); disposables.push(noise);
  const fade = (lo, hi, x) => float(1).sub(smoothstep(lo, hi, x));

  /* ---------- shared uniforms ---------- */
  // scalars are packed into vector uniforms whose components are written in place every frame
  const frameV = new THREE.Vector4(0, 0, 1, 0), fogV = new THREE.Vector3(0, 1e6, 2e6), gainV = new THREE.Vector4(0.9, 1, 1, 0.035);
  const viewV = new THREE.Vector4(Math.tan(35 * Math.PI / 180), Math.cos(0.42), Math.cos(0.19), effects ? 1 : 0);
  const uFrame = uniform(frameV), uFog = uniform(fogV), uView = uniform(viewV), uGain = uniform(gainV);
  const U = {
    time: uFrame.x, dustTime: uFrame.y, flicker: uFrame.z, torchOn: uFrame.w, fogDensity: uFog.x, fogNear: uFog.y, fogFar: uFog.z,
    tanHalf: uView.x, torchOuter: uView.y, torchInner: uView.z, effects: uView.w,
    coneGain: uGain.x, dustGain: uGain.y, sparkGain: uGain.z, ambient: uGain.w,
    torchPos: uniform(new THREE.Vector3()), torchDir: uniform(new THREE.Vector3(0, 0, -1)),
    dustCenter: uniform(new THREE.Vector3()), dustBox: uniform(new THREE.Vector3(7.5, 3.5, 7.5)), tracerGain: uniform(1)
  };
  const litA = [], litB = [], litC = [];
  for (let i = 0; i < LIT; i++) { litA.push(new THREE.Vector4(0, -50, 0, 1)); litB.push(new THREE.Vector4(0.2, 1, 0, 0)); litC.push(new THREE.Vector4()); }
  const uLitA = uniformArray(litA, 'vec4'), uLitB = uniformArray(litB, 'vec4'), uLitC = uniformArray(litC, 'vec4');
  const pixelSize = U.tanHalf.mul(2).div(max(screenSize.y, 1));   // view-plane size of one pixel at depth 1

  // exp2 fog transmittance (FogExp2) times linear-fog fade (Fog); additive light fades out instead of tinting.
  const fogFade = dist => { const k = dist.mul(U.fogDensity); return exp(k.mul(k).negate()).mul(fade(U.fogNear, U.fogFar, dist)); };
  // Fake lighting for particles: torch spot + the eight nearest light shafts.
  const torchLight = P => {
    const toP = P.sub(U.torchPos), d = max(toP.length(), 0.05);
    return smoothstep(U.torchOuter, U.torchInner, toP.dot(U.torchDir).div(d)).mul(U.torchOn).div(d.mul(d).mul(0.06).add(1));
  };
  const coneLight = P => {
    let sum = vec3(0);
    for (let i = 0; i < LIT; i++) {
      const A = uLitA.element(i), B = uLitB.element(i), C = uLitC.element(i);
      const hn = A.y.sub(P.y).div(A.w), hc = hn.clamp(0, 1);
      const rho = P.xz.sub(A.xz).length().div(mix(B.x, B.y, hc));
      const f = float(1).sub(rho.mul(rho)).max(0).pow(2).mul(hc.oneMinus().pow(1.3)).mul(step(0, hn)).mul(step(hn, 1));
      sum = sum.add(C.xyz.mul(f.mul(B.z)));
    }
    return sum;
  };
  const addMesh = (mesh, order, parent = scene, owned = true) => {
    mesh.frustumCulled = false; mesh.matrixAutoUpdate = false; mesh.renderOrder = order; mesh.castShadow = mesh.receiveShadow = false;
    mesh.updateMatrix(); parent.add(mesh); meshes.push(mesh); if (owned) disposables.push(mesh.geometry, mesh.material); return mesh;
  };
  // Pools are small (<= 32 KB per attribute), so dirty attributes are re-uploaded whole: no update-range objects, no
  // per-frame garbage, one bufferSubData/writeBuffer each.
  const instAttr = (geo, name, count, size = 4) => {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(count * size), size); a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute(name, a); return a;
  };
  // instanced quad, x in [0, 1] (along a streak), y in [-1, 1]
  const quadGeometry = () => {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 0, 1, 0, 1, 1, 0], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
    g.setIndex([0, 1, 2, 2, 1, 3]); g.instanceCount = 0; return g;
  };
  const additive = (side = THREE.FrontSide) => new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side, fog: false });
  // Ray o + t*d in "cone space" (apex at the origin, axis +x, radius = s*x): returns the [t0, t1] span inside the
  // frustum x in [w0, w1]. a > 0: inside between the roots; a < 0: the +x nappe lies past the far root (moving +x)
  // or before the near root (moving -x); no roots with a < 0 means the line stays inside, the slab clips it.
  const coneSpan = (o, d, s, w0, w1) => {
    const s2 = s.mul(s), BIG = float(1e4);
    const a0 = d.y.mul(d.y).add(d.z.mul(d.z)).sub(s2.mul(d.x).mul(d.x));
    const a = select(a0.abs().lessThan(1e-5), select(a0.lessThan(0), float(-1e-5), float(1e-5)), a0);
    const b = o.y.mul(d.y).add(o.z.mul(d.z)).sub(s2.mul(o.x).mul(d.x)).mul(2);
    const c = o.y.mul(o.y).add(o.z.mul(o.z)).sub(s2.mul(o.x).mul(o.x));
    const disc = b.mul(b).sub(a.mul(c).mul(4)), sq = disc.max(0).sqrt();
    const r1 = b.negate().sub(sq).div(a.mul(2)), r2 = b.negate().add(sq).div(a.mul(2));
    const lo = min(r1, r2), hi = max(r1, r2), roots = disc.greaterThanEqual(0), fwd = d.x.greaterThan(0), pos = a.greaterThan(0);
    const c0 = select(pos, lo, select(roots.and(fwd), hi, BIG.negate()));
    const c1 = select(pos, select(roots, hi, BIG.negate()), select(roots.and(fwd.not()), lo, BIG));
    const dx = select(d.x.abs().lessThan(1e-4), float(1e-4), d.x);
    const ta = w0.sub(o.x).div(dx), tb = w1.sub(o.x).div(dx);
    return [max(max(c0, min(ta, tb)), 0), min(c1, max(ta, tb))];
  };
  // Span of the ray inside an optional xz box (minX, maxX, minZ, maxZ): without depth input this is how shafts stop at
  // walls instead of glowing through them.
  const boxSpan = (O, D, box) => {
    const dx = select(D.x.abs().lessThan(1e-5), float(1e-5), D.x), dz = select(D.z.abs().lessThan(1e-5), float(1e-5), D.z);
    const ax = box.x.sub(O.x).div(dx), bx = box.y.sub(O.x).div(dx), az = box.z.sub(O.z).div(dz), bz = box.w.sub(O.z).div(dz);
    return [max(min(ax, bx), min(az, bz)), min(max(ax, bx), max(az, bz))];
  };
  const OPEN = 1e4, isNum = v => typeof v === 'number' && Number.isFinite(v), writeBox = (attr, i, b) => {
    const a = attr.array, ok = !!b && isNum(b.minX) && isNum(b.maxX) && isNum(b.minZ) && isNum(b.maxZ);
    a[i * 4] = ok ? Math.min(b.minX, b.maxX) : -OPEN; a[i * 4 + 1] = ok ? Math.max(b.minX, b.maxX) : OPEN;
    a[i * 4 + 2] = ok ? Math.min(b.minZ, b.maxZ) : -OPEN; a[i * 4 + 3] = ok ? Math.max(b.minZ, b.maxZ) : OPEN;
    attr.needsUpdate = true;
  };

  /* ---------- volumetric light shafts (analytic cone in-scattering) ---------- */
  const coneGeo = new THREE.InstancedBufferGeometry();
  { const c = new THREE.CylinderGeometry(1, 1, 1, 20, 1, false); coneGeo.index = c.index; coneGeo.setAttribute('position', c.getAttribute('position')); }
  coneGeo.instanceCount = 0;
  const cTop = instAttr(coneGeo, 'cTop', MAX_CONES, 3), cShape = instAttr(coneGeo, 'cShape', MAX_CONES), cColor = instAttr(coneGeo, 'cColor', MAX_CONES);
  const cBox = instAttr(coneGeo, 'cBox', MAX_CONES);
  const coneMat = additive();
  {
    const top = attribute('cTop', 'vec3'), shape = attribute('cShape', 'vec4'), col = attribute('cColor', 'vec4'), box = attribute('cBox', 'vec4');
    // One shaded face per pixel: when the camera is inside a (slightly grown) cone its hull is mirrored, which flips the
    // winding so the far side becomes front-facing; outside, the near side is shaded. The integral starts at the camera.
    coneMat.positionNode = Fn(() => {
      const hn = top.y.sub(cameraPosition.y).div(shape.z), grown = mix(shape.x, shape.y, hn.clamp(0, 1)).add(0.15);
      const inside = step(-0.04, hn).mul(step(hn, 1.04)).mul(step(cameraPosition.xz.sub(top.xz).length(), grown));
      const g = positionGeometry, h = float(0.5).sub(g.y), rad = mix(shape.x, shape.y, h).mul(1.07);
      // a cone at intensity 0 collapses to a point: switched-off fixtures cost no fill
      return top.add(vec3(g.x.mul(rad).mul(inside.mul(-2).add(1)), h.mul(shape.z).negate(), g.z.mul(rad)).mul(step(1e-5, col.w)));
    })();
    coneMat.colorNode = Fn(() => {
      const r0 = shape.x, R = shape.y, L = shape.z, O = cameraPosition;
      const D = positionWorld.sub(O).normalize().toVar();
      // cone space: depth below the virtual apex along +x, horizontal offsets as y/z
      const s = max(R.sub(r0).div(L), 0.05), h0 = r0.div(s), apexY = top.y.add(h0);
      const [c0, c1] = coneSpan(vec3(apexY.sub(O.y), O.x.sub(top.x), O.z.sub(top.z)), vec3(D.y.negate(), D.x, D.z), s, h0, h0.add(L));
      const [b0, b1] = boxSpan(O, D, box), t0 = max(c0, b0), t1 = min(c1, b1), seg = max(t1.sub(t0), 0);
      const density = t => {
        const P = O.add(D.mul(t)), hn = top.y.sub(P.y).div(L).clamp(0, 1);
        const rho = P.xz.sub(top.xz).length().div(mix(r0, R, hn));
        // near fade: the veil of haze around the viewer is dropped so standing in a shaft never greys the screen
        return float(1).sub(rho.mul(rho)).max(0).pow(2).mul(hn.oneMinus().pow(1.5)).mul(smoothstep(0, 0.1, hn)).mul(smoothstep(0.35, 2.4, t));
      };
      const tm = t0.add(seg.mul(0.5)), Pm = O.add(D.mul(tm));
      // slowly drifting dust: mostly vertical streaks (noise barely changes with height) read as light rays
      const n = textureLevel(noise, Pm.xz.mul(0.55).add(vec2(Pm.y.mul(0.11), Pm.y.mul(0.04))).add(vec2(U.time.mul(0.011), U.time.mul(-0.017))).add(shape.w), 0);
      const sum = density(t0.add(seg.mul(1 / 6))).add(density(tm)).add(density(t0.add(seg.mul(5 / 6))));
      const shimmer = sin(U.time.mul(7.3).add(shape.w.mul(40))).mul(0.015).add(0.985);
      const lum = sum.mul(seg).div(3).mul(n.x.mul(0.6).add(n.y.mul(0.25)).add(0.55)).mul(col.w).mul(U.flicker).mul(U.coneGain).mul(shimmer);
      return vec4(col.xyz.mul(lum.div(lum.mul(0.5).add(1))).mul(fogFade(tm)), 1);
    })();
  }
  const coneMesh = addMesh(new THREE.Mesh(coneGeo, coneMat), 30); coneMesh.visible = false; coneMesh.name = 'atmosphere:cones';
  const cones = [];   // Fixture records by slot

  function writeCone(rec) {
    const i = rec.slot;
    cTop.array[i * 3] = rec.x; cTop.array[i * 3 + 1] = rec.y; cTop.array[i * 3 + 2] = rec.z;
    cShape.array[i * 4] = rec.r0; cShape.array[i * 4 + 1] = rec.R; cShape.array[i * 4 + 2] = rec.L; cShape.array[i * 4 + 3] = rec.seed;
    cColor.array[i * 4] = rec.color.r; cColor.array[i * 4 + 1] = rec.color.g; cColor.array[i * 4 + 2] = rec.color.b; cColor.array[i * 4 + 3] = rec.intensity;
    cTop.needsUpdate = cShape.needsUpdate = cColor.needsUpdate = true; writeBox(cBox, i, rec.bounds);
  }
  function addLightCone(o) {
    if (disposed || cones.length >= MAX_CONES) return NOOP_HANDLE;
    o = o || NO_INPUT;
    const R = clamp(finite(o.radius, 1.4), 0.1, 6), L = clamp(finite(o.length, 2.6), 0.2, 12);
    const rec = new Fixture(cones.length, finite(o.x, 0), finite(o.y, 3), finite(o.z, 0), new THREE.Color(o.color ?? 0xe6d6b5), Math.max(0, finite(o.intensity, 1)), o.bounds);
    rec.R = R; rec.L = L; rec.r0 = Math.min(R * 0.16, 0.24); rec.seed = Math.random() * 10;
    cones.push(rec); writeCone(rec); coneGeo.instanceCount = cones.length; coneMesh.visible = true;
    return {
      setIntensity(v) { if (!rec.live) return; v = Math.max(0, finite(v, 0)); if (v === rec.intensity) return; rec.intensity = v; cColor.array[rec.slot * 4 + 3] = v; cColor.needsUpdate = true; },
      setColor(hex) { if (!rec.live) return; rec.color.set(hex); writeCone(rec); },
      dispose() {
        if (!rec.live) return; rec.live = false;
        const last = cones.pop();
        if (last !== rec) { last.slot = rec.slot; cones[rec.slot] = last; writeCone(last); }
        coneGeo.instanceCount = cones.length; coneMesh.visible = cones.length > 0;
      }
    };
  }

  /* ---------- dust motes (GPU-only, wrapped around the camera) ---------- */
  const dustGeo = new THREE.BufferGeometry();
  {
    const corner = new Float32Array(MAX_DUST * 8), seeds = new Float32Array(MAX_DUST * 16), moves = new Float32Array(MAX_DUST * 16), idx = new Uint16Array(MAX_DUST * 6);
    for (let i = 0; i < MAX_DUST; i++) {
      const sd = [Math.random(), Math.random(), Math.random(), Math.random()], big = Math.random() < 0.08;
      const mv = [(Math.random() - 0.5) * 0.05, (Math.random() - 0.62) * 0.03, (Math.random() - 0.5) * 0.05, (big ? 0.012 : 0.004) + Math.random() * 0.006];
      corner.set([-1, -1, 1, -1, -1, 1, 1, 1], i * 8);
      for (let k = 0; k < 4; k++) { seeds.set(sd, i * 16 + k * 4); moves.set(mv, i * 16 + k * 4); }
      idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 1, i * 4 + 3], i * 6);
    }
    dustGeo.setAttribute('corner', new THREE.BufferAttribute(corner, 2)); dustGeo.setAttribute('dSeed', new THREE.BufferAttribute(seeds, 4));
    dustGeo.setAttribute('dMove', new THREE.BufferAttribute(moves, 4)); dustGeo.setIndex(new THREE.BufferAttribute(idx, 1));
    // three needs a position attribute for draw-range bookkeeping; the vertex stage ignores it
    dustGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_DUST * 12), 3));
  }
  const dustMat = additive();
  {
    const seed = attribute('dSeed', 'vec4'), move = attribute('dMove', 'vec4'), corner = attribute('corner', 'vec2');
    const t = U.time, B = U.dustBox, C = U.dustCenter;
    const wob = vec3(sin(t.mul(0.37).add(seed.w.mul(6.3))), sin(t.mul(0.29).add(seed.w.mul(4.1))).mul(0.6), cos(t.mul(0.31).add(seed.w.mul(5.3)))).mul(0.07);
    const base = seed.xyz.mul(B).add(move.xyz.mul(U.dustTime)).add(wob);
    const rel = fract(base.sub(C).div(B).add(0.5)).sub(0.5);
    const wp = C.add(rel.mul(B));
    const edge = fade(0.36, 0.5, max(max(rel.x.abs(), rel.y.abs()), rel.z.abs()));
    const vc = cameraViewMatrix.mul(vec4(wp, 1)).xyz, depth = max(vc.z.negate(), 0.02);
    const size = max(move.w, pixelSize.mul(depth).mul(0.75));
    const energy = move.w.div(size).pow(2).clamp(0.12, 1);
    const twinkle = sin(t.mul(seed.w.mul(2.5).add(0.6)).add(seed.x.mul(40))).mul(0.35).add(0.75);
    const light = torchLight(wp).mul(1.5).add(coneLight(wp).mul(2.4)).add(U.ambient.mul(0.25));
    // motes within ~1 m fade out: one drifting past the lens would otherwise be a big bright disc (and bloom into a blob)
    const lum = light.mul(energy).mul(twinkle).mul(edge).mul(smoothstep(0.25, 1.1, depth)).mul(fogFade(depth)).mul(U.dustGain);
    dustMat.positionNode = cameraWorldMatrix.mul(vec4(vc.add(vec3(corner.mul(size), 0)), 1)).xyz;
    const vLum = varying(lum.mul(vec3(1, 0.93, 0.82)), 'vDust'), vCorner = varying(corner, 'vDustCorner');
    dustMat.colorNode = Fn(() => { const r2 = vCorner.dot(vCorner); return vec4(vLum.mul(float(1).sub(r2).max(0).pow(2)), 1); })();
  }
  const dustMesh = addMesh(new THREE.Mesh(dustGeo, dustMat), 32); dustMesh.name = 'atmosphere:dust';

  /* ---------- sparks: CPU-simulated pooled streaks, additive ---------- */
  const sparkGeo = quadGeometry();
  const sP = instAttr(sparkGeo, 'sP', MAX_SPARKS), sV = instAttr(sparkGeo, 'sV', MAX_SPARKS), sC = instAttr(sparkGeo, 'sC', MAX_SPARKS);
  // streak quad built in "tan space" (view xy / depth) so its screen direction follows the projected velocity
  const streak = (P, V, width, tStreak, minPx) => {
    const head = cameraViewMatrix.mul(vec4(P, 1)).xyz, tail = cameraViewMatrix.mul(vec4(P.sub(V.mul(tStreak)), 1)).xyz;
    const hz = max(head.z.negate(), 0.03), tz = max(tail.z.negate(), 0.03);
    const sh = head.xy.div(hz), st = tail.xy.div(tz), dv = sh.sub(st), dl = dv.length();
    const dir = select(dl.greaterThan(1e-6), dv.div(max(dl, 1e-6)), vec2(1, 0)), perp = vec2(dir.y.negate(), dir.x);
    const w = max(width.div(hz), pixelSize.mul(minPx)), gx = positionGeometry.x, gy = positionGeometry.y;
    const tan2 = mix(st, sh, gx).add(perp.mul(gy.mul(w))).add(dir.mul(gx.mul(2).sub(1).mul(w)));
    const z = mix(tz, hz, gx);
    return { world: cameraWorldMatrix.mul(vec4(tan2.mul(z), z.negate(), 1)).xyz, depth: hz, energy: width.div(hz).div(w).clamp(0.2, 1) };
  };
  const sparkMat = additive();
  {
    const p = attribute('sP', 'vec4'), v = attribute('sV', 'vec4'), c = attribute('sC', 'vec4');
    const s = streak(p.xyz, v.xyz, v.w, 0.034, 1);
    sparkMat.positionNode = s.world;
    const a = p.w;
    const hot = mix(vec3(1, 0.9, 0.72), c.xyz, smoothstep(0, 0.2, a));
    const col = mix(hot, c.xyz.mul(vec3(0.95, 0.3, 0.1)), smoothstep(0.4, 1, a));
    const vCol = varying(col.mul(c.w).mul(fade(0.72, 1, a)).mul(s.energy).mul(fogFade(s.depth)).mul(U.sparkGain), 'vSpark');
    sparkMat.colorNode = Fn(() => { const q = uv(), y = q.y.mul(2).sub(1); return vec4(vCol.mul(float(1).sub(y.mul(y)).pow(1.5)).mul(mix(0.3, 1, q.x)), 1); })();
  }
  const sparkMesh = addMesh(new THREE.Mesh(sparkGeo, sparkMat), 33); sparkMesh.visible = false; sparkMesh.name = 'atmosphere:sparks';
  const SPK = 13, spark = new Float32Array(MAX_SPARKS * SPK); let sparkCount = 0;   // x y z vx vy vz age life width r g b bright

  /* ---------- bullet tracers: pooled camera-facing streaks, additive ---------- */
  const tracerGeo = quadGeometry();
  const tH = instAttr(tracerGeo, 'tH', MAX_TRACERS), tT = instAttr(tracerGeo, 'tT', MAX_TRACERS), tC = instAttr(tracerGeo, 'tC', MAX_TRACERS);
  const tracerMat = additive();
  {
    const h = attribute('tH', 'vec4'), t = attribute('tT', 'vec4'), c = attribute('tC', 'vec4'), NEAR = 0.06;
    // view space, with the ends clipped to a near plane so streaks passing beside or behind the viewer stay sane
    const hv0 = cameraViewMatrix.mul(vec4(h.xyz, 1)).xyz, tv0 = cameraViewMatrix.mul(vec4(t.xyz, 1)).xyz, dz = hv0.z.sub(tv0.z);
    const cut = float(-NEAR).sub(tv0.z).div(select(dz.abs().lessThan(1e-6), float(1e-6), dz)).clamp(0, 1);
    const hBack = hv0.z.greaterThan(-NEAR), tBack = tv0.z.greaterThan(-NEAR);
    const hv = select(hBack, mix(tv0, hv0, cut), hv0), tv = select(tBack, mix(tv0, hv0, cut), tv0);
    const hz = max(hv.z.negate(), NEAR), tz = max(tv.z.negate(), NEAR);
    const sh = hv.xy.div(hz), stl = tv.xy.div(tz), dv = sh.sub(stl), dl = dv.length();
    const dir = select(dl.greaterThan(1e-6), dv.div(max(dl, 1e-6)), vec2(1, 0)), perp = vec2(dir.y.negate(), dir.x);
    // w = half-width of the line; the quad is HALO times wider and reaches HALO widths past the head for its glow
    const w = max(t.w.div(hz), pixelSize), W = w.mul(HALO), gx = positionGeometry.x, gy = positionGeometry.y;
    const tan2 = mix(stl, sh, gx).add(perp.mul(gy.mul(W))).add(dir.mul(mix(w.negate(), W, gx))), z = mix(tz, hz, gx);
    tracerMat.positionNode = cameraWorldMatrix.mul(vec4(select(hBack.and(tBack), vec3(0, 0, -1), vec3(tan2.mul(z), z.negate())), 1)).xyz;
    // distances in metres behind the true head (the hot end): per vertex, so the interpolation stays perspective-correct
    const extH = w.mul(hz), extT = w.mul(tz), cutH = hv0.sub(hv).length(), seg = hv.sub(tv).length();
    const vAlong = varying(cutH.add(gx.oneMinus().mul(seg.add(extT))).sub(gx.mul(extH).mul(HALO)), 'vTracerAlong');
    const vInfo = varying(vec4(cutH.add(seg), extH, extT, c.w), 'vTracerInfo');
    // the across coordinate is interpolated linearly in screen space (gy*w / w): a streak reaching close to the camera is
    // a strongly tapered quad in 3D, where perspective-correct interpolation would bend and break the line
    const vAcross = varying(vec2(gy.mul(z), z), 'vTracerAcross');
    const k = t.w.div(hz).div(w).clamp(0.35, 1).mul(fogFade(z)).mul(U.tracerGain).mul(h.w);   // thin far streaks: wider and dimmer
    // near the head: tail ~1.6 + core ~3.4 (x1.22 with the halo) peaks at HDR ~5.7 for bloom; reduced effects: ~3.4
    const vTail = varying(c.xyz.mul(k.mul(U.effects.mul(0.4).add(1.2))), 'vTracerTail');
    const vHot = varying(mix(c.xyz, vec3(1, 0.96, 0.88), 0.65).mul(k.mul(U.effects.mul(1.6).add(1.8))), 'vTracerHot');
    tracerMat.colorNode = Fn(() => {
      const d = vAlong, y = vAcross.x.div(vAcross.y).mul(HALO), y2 = y.mul(y), keep = float(1).sub(d.div(vInfo.w).clamp(0, 1)), k2 = keep.mul(keep);
      // the tail is anchored to the head and cools from the tracer colour to deep orange; both ends are capped
      const tail = k2.mul(smoothstep(vInfo.y.negate(), 0, d)).mul(fade(vInfo.x, vInfo.x.add(vInfo.z), d)).mul(float(1).sub(y2).max(0).pow(1.5));
      const tint = mix(vec3(1, 0.42, 0.16), vec3(1), k2);
      // white-hot head drawn out along the flight path, plus a soft halo that reads without bloom
      const hd = d.div(select(d.lessThan(0), vInfo.y, max(vInfo.y.mul(2.5), 0.06))), r2 = hd.mul(hd).add(y2);
      return vec4(vTail.mul(tint).mul(tail).add(vHot.mul(exp(r2.mul(-3)).add(exp(r2.mul(-0.45)).mul(0.22)))), 1);
    })();
  }
  const tracerMesh = addMesh(new THREE.Mesh(tracerGeo, tracerMat), 36); tracerMesh.visible = false; tracerMesh.name = 'atmosphere:tracers';
  // start xyz, unit dir xyz, end (drawn length), age, speed, length, width, r g b, short (0/1), fresh (0/1)
  const TRK = 16, trc = new Float32Array(MAX_TRACERS * TRK), tracerCol = new THREE.Color(0xffd9a0); let tracerCount = 0, tracerHex = 0xffd9a0;

  /* ---------- matter: blood mist, droplets, dust puffs, chips (fake-lit, alpha blended) ---------- */
  const matterGeo = quadGeometry();
  const mP = instAttr(matterGeo, 'mP', MAX_MATTER), mV = instAttr(matterGeo, 'mV', MAX_MATTER), mC = instAttr(matterGeo, 'mC', MAX_MATTER), mK = instAttr(matterGeo, 'mK', MAX_MATTER);
  const matterMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.NormalBlending, fog: false });
  {
    const p = attribute('mP', 'vec4'), v = attribute('mV', 'vec4'), c = attribute('mC', 'vec4'), k = attribute('mK', 'vec4');
    const drop = streak(p.xyz, v.xyz, v.w, 0.03, 1.0);
    const vc = cameraViewMatrix.mul(vec4(p.xyz, 1)).xyz, depth = max(vc.z.negate(), 0.03);
    const gx = positionGeometry.x.mul(2).sub(1), gy = positionGeometry.y, cr = cos(k.z), sr = sin(k.z);
    const size = max(v.w, pixelSize.mul(depth).mul(1.2));
    const bill = cameraWorldMatrix.mul(vec4(vc.add(vec3(vec2(gx.mul(cr).sub(gy.mul(sr)), gx.mul(sr).add(gy.mul(cr))).mul(size), 0)), 1)).xyz;
    const isDrop = k.x.greaterThan(0.5).and(k.x.lessThan(1.5));
    matterMat.positionNode = select(isDrop, drop.world, bill);
    const light = U.ambient.add(torchLight(p.xyz).mul(2.2)).add(coneLight(p.xyz).mul(1.4));
    const vCol = varying(c.xyz.mul(light), 'vMatterCol');
    const vA = varying(c.w.mul(fogFade(depth)), 'vMatterA');
    const vKind = varying(k.xy, 'vMatterKind');
    matterMat.colorNode = Fn(() => {
      const q = uv(), pq = q.mul(2).sub(1), r = pq.length();
      const n = textureLevel(noise, q.mul(0.42).add(vKind.y), 0);
      const puff = fade(0.25, 1, r.add(n.x.sub(0.5).mul(0.55))).mul(n.y.mul(0.5).add(0.6));
      const dropShape = float(1).sub(pq.y.mul(pq.y)).mul(mix(0.55, 1, q.x));
      const chip = fade(0.7, 0.95, max(pq.x.abs(), pq.y.abs().mul(1.35)));
      const shape = select(vKind.x.lessThan(0.5), puff, select(vKind.x.lessThan(1.5), dropShape, chip));
      return vec4(vCol, vA.mul(shape).clamp(0, 1));
    })();
  }
  const matterMesh = addMesh(new THREE.Mesh(matterGeo, matterMat), 31); matterMesh.visible = false; matterMesh.name = 'atmosphere:matter';
  // x y z vx vy vz age life size0 size1 r g b alpha kind seed rot spin drag grav decal
  const MTK = 21, matter = new Float32Array(MAX_MATTER * MTK); let matterCount = 0;

  /* ---------- blood floor splats (multiply blended decals, ring pool) ---------- */
  const decalGeo = new THREE.InstancedBufferGeometry();
  decalGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, -1, 1, 0, -1, -1, 0, 1, 1, 0, 1], 3));
  decalGeo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
  decalGeo.setIndex([0, 2, 1, 1, 2, 3]); decalGeo.instanceCount = 0;
  const dA = instAttr(decalGeo, 'dA', MAX_DECALS), dB = instAttr(decalGeo, 'dB', MAX_DECALS), dC = instAttr(decalGeo, 'dC', MAX_DECALS);
  const decalMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.MultiplyBlending, premultipliedAlpha: true, fog: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  {
    const A = attribute('dA', 'vec4'), Bd = attribute('dB', 'vec4'), Cd = attribute('dC', 'vec4');
    const age = U.time.sub(Cd.x), alive = step(0, age).mul(step(age, Cd.y));
    const grow = smoothstep(0, 0.35, age).mul(0.45).add(0.55).mul(alive);
    const g = positionGeometry, lx = g.x.mul(A.w).mul(Bd.z).mul(grow), lz = g.z.mul(A.w).mul(grow);
    decalMat.positionNode = vec3(A.x.add(lx.mul(Bd.x)).sub(lz.mul(Bd.y)), A.y, A.z.add(lx.mul(Bd.y)).add(lz.mul(Bd.x)));
    const vFade = varying(smoothstep(0, 0.12, age).mul(fade(Cd.y.sub(7), Cd.y, age)).mul(Cd.z).mul(fogFade(positionWorld.sub(cameraPosition).length())), 'vDecalFade');
    const vSeed = varying(Bd.w, 'vDecalSeed');
    decalMat.colorNode = Fn(() => {
      const q = uv(), p = q.mul(2).sub(1), r = p.length(), dir = p.div(max(r, 1e-3));
      const na = textureLevel(noise, dir.mul(0.16).add(vSeed), 0), nb = textureLevel(noise, dir.mul(0.42).add(vSeed.mul(1.37)), 0);
      const edge = na.x.sub(0.5).mul(0.26).add(0.4).add(nb.y.pow(4).mul(0.42));
      const core = fade(edge.sub(0.045), edge, r);
      const sp = textureLevel(noise, q.mul(1.25).add(vSeed.mul(2.3)), 0).w;
      const ring = smoothstep(edge, edge.add(0.06), r).mul(fade(0.82, 0.98, r)).mul(smoothstep(-0.4, 0.7, dir.x).mul(0.75).add(0.25));
      const sat = smoothstep(0.66, 0.74, sp).mul(ring);
      const fine = textureLevel(noise, q.mul(0.7).add(vSeed), 0);
      const a = max(core.mul(fine.z.mul(0.3).add(0.7)), sat).mul(vFade).clamp(0, 1);
      const thick = core.mul(smoothstep(0.02, 0.3, edge.sub(r)));
      return vec4(mix(vec3(0.42, 0.035, 0.03), vec3(0.15, 0.0, 0.006), thick), a);
    })();
  }
  const decalMesh = addMesh(new THREE.Mesh(decalGeo, decalMat), 29); decalMesh.visible = false; decalMesh.name = 'atmosphere:decals';
  let decalHead = 0, decalSpawned = 0;

  /* ---------- emergency beacons: lit housing + additive blades/flare ---------- */
  const merge = parts => {
    const pos = [], nrm = [], part = [], idx = [];
    for (const [geo, tag] of parts) {
      const base = pos.length / 3, p = geo.getAttribute('position'), n = geo.getAttribute('normal');
      for (let i = 0; i < p.count; i++) { pos.push(p.getX(i), p.getY(i), p.getZ(i)); nrm.push(n.getX(i), n.getY(i), n.getZ(i)); part.push(...tag(p.getX(i), p.getY(i), p.getZ(i))); }
      const index = geo.index; for (let i = 0; i < index.count; i++) idx.push(base + index.getX(i));
      geo.dispose();
    }
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('part', new THREE.Float32BufferAttribute(part, 2)); g.setIndex(idx); g.instanceCount = 0; return g;
  };
  const housingGeo = merge([
    [new THREE.CylinderGeometry(0.105, 0.12, 0.05, 20).translate(0, 0.025, 0), () => [0, 0]],
    [new THREE.CylinderGeometry(0.086, 0.092, 0.024, 20).translate(0, 0.062, 0), () => [0, 0]],
    [new THREE.SphereGeometry(0.082, 20, 8, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 1.15, 1).translate(0, 0.072, 0), () => [1, 0]]
  ]);
  const bladeCone = sign => new THREE.CylinderGeometry(0.06, BLADE * BLADE_SLOPE * 1.1 + 0.03, BLADE + 0.1, 14, 1, false).translate(0, -BLADE / 2 - 0.02, 0).rotateZ(sign * Math.PI / 2);
  const bladeGeo = merge([
    [bladeCone(1), () => [0, 1]], [bladeCone(-1), () => [0, -1]],
    [new THREE.PlaneGeometry(2, 2), () => [1, 0]]
  ]);
  const bPos = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BEACONS * 4), 4), bCol = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BEACONS * 4), 4);
  const bBox = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BEACONS * 4), 4);
  for (const a of [bPos, bCol, bBox]) a.setUsage(THREE.DynamicDrawUsage);
  for (const g of [housingGeo, bladeGeo]) { g.setAttribute('bPos', bPos); g.setAttribute('bCol', bCol); }
  bladeGeo.setAttribute('bBox', bBox);
  const housingMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.5, metalness: 0.6 });
  const bladeMat = additive();
  {
    const P = attribute('bPos', 'vec4'), C = attribute('bCol', 'vec4'), part = attribute('part', 'vec2');
    const ca = cos(P.w), sa = sin(P.w), on = step(0.001, C.w);
    const isDome = part.x.greaterThan(0.5);
    housingMat.positionNode = P.xyz.add(positionGeometry);
    housingMat.colorNode = select(isDome, C.xyz.mul(0.3).add(0.04), vec3(0.07, 0.075, 0.08));
    housingMat.roughnessNode = select(isDome, float(0.22), float(0.55));
    housingMat.metalnessNode = select(isDome, float(0), float(0.7));
    const lobe = normalGeometry.xz.normalize().dot(vec2(ca, sa)).abs().pow(6);
    housingMat.emissiveNode = C.xyz.mul(C.w).mul(lobe.mul(3.2).add(0.45)).mul(select(isDome, float(1), float(0))).mul(on);
    const rot = v => vec3(v.x.mul(ca).sub(v.z.mul(sa)), v.y, v.x.mul(sa).add(v.z.mul(ca)));
    const center = P.xyz.add(vec3(0, DOME_Y, 0));
    const isFlare = part.x.greaterThan(0.5);
    const vcen = cameraViewMatrix.mul(vec4(center, 1)).xyz;
    const flare = cameraWorldMatrix.mul(vec4(vcen.add(vec3(positionGeometry.xy.mul(0.5), 0.14)), 1)).xyz;
    const toCam = cameraPosition.sub(center), camDist = toCam.length();
    const beamDir = vec2(ca, sa), flat = toCam.xz.div(max(toCam.xz.length(), 1e-4));
    const facing = flat.dot(beamDir).abs().pow(10).mul(fade(0.25, 0.9, toCam.y.abs().div(max(camDist, 1e-3))));
    // the head-on flash is the strobing part of a rotating beacon: reduced effects keep only a mild swell
    const vFlash = varying(C.xyz.mul(C.w).mul(facing.mul(U.effects.mul(2).add(0.6)).add(0.22)).mul(fogFade(camDist)), 'vBladeFlash');
    // into blade space: rotate by -angle, mirror the second blade so both point along +x
    const toBlade = (v, sg) => vec3(v.x.mul(ca).add(v.z.mul(sa)).mul(sg), v.y, v.z.mul(ca).sub(v.x.mul(sa)));
    const slope = float(BLADE_SLOPE);
    const camIn = Fn(() => {
      const o = toBlade(toCam, part.y);
      return step(-0.1, o.x).mul(step(o.x, BLADE + 0.1)).mul(step(o.yz.length(), o.x.mul(slope).add(0.15)));
    })();
    // a blade containing the camera is mirrored (z -> -z) so its far side is the front face, like the light shafts
    bladeMat.positionNode = select(isFlare, flare, center.add(rot(positionGeometry.mul(vec3(1, 1, camIn.mul(-2).add(1)))).mul(on)));
    bladeMat.colorNode = Fn(() => {
      const r = positionGeometry.xy.length(), glow = float(1).sub(r).max(0).pow(3).add(fade(0, 0.16, r).mul(0.8));
      const flareCol = vFlash.mul(glow);
      const D = positionWorld.sub(cameraPosition).normalize().toVar();
      const o = toBlade(toCam, part.y), d = toBlade(D, part.y);
      const [c0, c1] = coneSpan(o, d, slope, float(0.03), float(BLADE));
      const [b0, b1] = boxSpan(cameraPosition, D, attribute('bBox', 'vec4')), t0 = max(c0, b0), t1 = min(c1, b1), seg = max(t1.sub(t0), 0);
      const density = t => {
        const p = o.add(d.mul(t)), x = max(p.x, 0.02), rho = p.yz.length().div(x.mul(slope).add(0.015));
        return float(1).sub(rho.mul(rho)).max(0).pow(2).div(x.mul(1.6).add(0.25)).mul(fade(BLADE * 0.5, BLADE, x)).mul(smoothstep(0.15, 1.2, t));
      };
      const tm = t0.add(seg.mul(0.5)), w = cameraPosition.add(D.mul(tm));
      const n = textureLevel(noise, w.xz.mul(0.6).add(vec2(w.y.mul(0.2), U.time.mul(0.03))), 0);
      const sum = density(t0.add(seg.mul(1 / 6))).add(density(tm)).add(density(t0.add(seg.mul(5 / 6))));
      const lum = sum.mul(seg).div(3).mul(n.x.mul(0.6).add(0.55)).mul(C.w).mul(0.5);
      const shaft = mix(C.xyz, vec3(1, 0.55, 0.45), 0.12).mul(lum.div(lum.mul(0.35).add(1))).mul(fogFade(tm));
      return vec4(select(isFlare, flareCol, shaft), 1);
    })();
  }
  const housingMesh = addMesh(new THREE.Mesh(housingGeo, housingMat), 0); housingMesh.visible = false; housingMesh.name = 'atmosphere:beacon-housing';
  const bladeMesh = addMesh(new THREE.Mesh(bladeGeo, bladeMat), 34); bladeMesh.visible = false; bladeMesh.name = 'atmosphere:beacon-blades';
  const beacons = [];
  function writeBeacon(rec) {
    const i = rec.slot;
    bPos.array[i * 4] = rec.x; bPos.array[i * 4 + 1] = rec.y; bPos.array[i * 4 + 2] = rec.z; bPos.array[i * 4 + 3] = rec.angle;
    const k = rec.active ? rec.intensity * BEACON_GAIN : 0;
    bCol.array[i * 4] = rec.color.r; bCol.array[i * 4 + 1] = rec.color.g; bCol.array[i * 4 + 2] = rec.color.b; bCol.array[i * 4 + 3] = k;
    bPos.needsUpdate = bCol.needsUpdate = true; writeBox(bBox, i, rec.bounds); syncBeacons();
  }
  // housings stay visible; the additive blades/flares are skipped entirely while every beacon is dark
  function syncBeacons() {
    let lit = false;
    for (let i = 0; i < beacons.length && !lit; i++) lit = beacons[i].active && beacons[i].intensity > 0;
    housingGeo.instanceCount = bladeGeo.instanceCount = beacons.length; housingMesh.visible = beacons.length > 0; bladeMesh.visible = lit;
  }
  function addBeacon(o) {
    if (disposed || beacons.length >= MAX_BEACONS) return NOOP_HANDLE;
    o = o || NO_INPUT;
    const rec = new Fixture(beacons.length, finite(o.x, 0), finite(o.y, 2.8), finite(o.z, 0), new THREE.Color(o.color ?? 0xff1a0a), Math.max(0, finite(o.intensity, 1)), o.bounds);
    rec.active = o.active === true;
    beacons.push(rec); writeBeacon(rec);
    return {
      setActive(v) { if (rec.live && rec.active !== !!v) { rec.active = !!v; writeBeacon(rec); } },
      setAngle(rad) { if (rec.live) { rec.angle = finite(rad, 0) % (Math.PI * 2); writeBeacon(rec); } },
      setIntensity(v) { if (rec.live) { rec.intensity = Math.max(0, finite(v, 0)); writeBeacon(rec); } },
      setColor(hex) { if (rec.live) { rec.color.set(hex); writeBeacon(rec); } },
      dispose() {
        if (!rec.live) return; rec.live = false;
        const last = beacons.pop();
        if (last !== rec) { last.slot = rec.slot; beacons[rec.slot] = last; writeBeacon(last); }
        syncBeacons();
      }
    };
  }

  /* ---------- torch beam: depth-tested slices perpendicular to the beam axis ---------- */
  const beams = [];
  // Slices span the part of the beam that is visible (the profile fades in by ~2 m and out by the far end): every slice
  // covers about the same screen area, so none is spent where it would contribute little.
  function beamGeometry(n, length, angle) {
    const pos = new Float32Array(n * 27), info = new Float32Array(n * 36), idx = [], tanA = Math.tan(angle), d0 = Math.min(1.15, length * 0.3), span = length * 0.84 - d0;
    for (let i = 0; i < n; i++) {
      const d = d0 + span * Math.pow((i + 0.5) / n, 1.25), w = span * (Math.pow((i + 1) / n, 1.25) - Math.pow(i / n, 1.25));
      const r = 0.03 + d * tanA, e = r * 1.09, b = i * 9;   // octagon fan circumscribing the slice disc
      pos.set([0, 0, -d], b * 3);
      for (let k = 0; k < 8; k++) { pos.set([Math.cos(k * Math.PI / 4) * e, Math.sin(k * Math.PI / 4) * e, -d], (b + 1 + k) * 3); idx.push(b, b + 1 + k, b + 1 + (k + 1) % 8); }
      for (let k = 0; k < 9; k++) info.set([d, r, w, (i + 0.5) / n], (b + k) * 4);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('bSlice', new THREE.BufferAttribute(info, 4)); g.setIndex(idx);
    return g;
  }
  function torchBeam(parent, o) {
    if (disposed) return NOOP_HANDLE;
    o = o || NO_INPUT;
    parent = parent || camera || scene;
    const length = clamp(finite(o.length, 9), 1, 30), angle = clamp(finite(o.angle, 0.42), 0.05, 1.2);
    const off = o.offset || { x: -0.22, y: -0.18, z: 0.05 }, tg = o.target || { x: 0, y: -0.25, z: -6 };
    const base = new THREE.Color(o.color ?? 0xfff1d6), uColor = uniform(base.clone()), uLen = uniform(length);
    const mat = additive(THREE.DoubleSide);
    mat.forceSinglePass = true;
    {
      // everything but the radial profile and the dust texture is smooth over a slice: computed per vertex
      const sl = attribute('bSlice', 'vec4'), d = sl.x, W = positionWorld;
      const prof = smoothstep(0.6, 2.4, d).mul(fade(uLen.mul(0.45), uLen, d)).div(d.mul(d).mul(0.06).add(1));
      const axis = modelWorldMatrix.mul(vec4(0, 0, -1, 0)).xyz.normalize();
      const V = W.sub(cameraPosition), dist = V.length();
      const align = smoothstep(0.3, 0.75, V.div(max(dist, 1e-4)).dot(axis).abs());
      const vGain = varying(uColor.mul(sl.z.mul(prof).mul(align).mul(fogFade(dist)).mul(0.03)), 'vBeamGain');
      const vDisc = varying(positionGeometry.xy.div(sl.y), 'vBeamDisc');
      const vDustUV = varying(W.xz.mul(0.7).add(vec2(W.y.mul(0.3), W.y.mul(0.45))).add(vec2(U.time.mul(0.021), U.time.mul(0.013))), 'vBeamDust');
      mat.colorNode = Fn(() => {
        const rho = vDisc.length(), radial = fade(0.6, 1, rho).mul(fade(0, 0.7, rho).mul(0.45).add(0.55));
        const n = textureLevel(noise, vDustUV, 0);
        return vec4(vGain.mul(radial.mul(n.x.mul(n.y).mul(1.6).add(n.z.mul(0.35)).add(0.25))), 1);
      })();
    }
    const mesh = new THREE.Mesh(beamGeometry(Q.slices, length, angle), mat);
    mesh.position.set(finite(off.x, 0), finite(off.y, 0), finite(off.z, 0));
    const dir = new THREE.Vector3(finite(tg.x, 0) - mesh.position.x, finite(tg.y, 0) - mesh.position.y, finite(tg.z, -6) - mesh.position.z).normalize();
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), dir);
    mesh.name = 'atmosphere:torch-beam';
    addMesh(mesh, 35, parent, false);
    const rec = new BeamRecord(mesh, base, uColor.value, clamp(finite(o.flicker, 0.5), 0, 1), length, angle);
    beams.push(rec);
    // particles are lit by the first beam's cone (spot penumbra 0.55 like the game's torch)
    if (beams.length === 1) { viewV.y = Math.cos(angle); viewV.z = Math.cos(angle * 0.45); }
    return {
      setIntensity(v) { if (rec.live) rec.intensity = Math.max(0, finite(v, 0)); },
      setColor(hex) { if (rec.live) { base.set(hex); rec.color.copy(base).multiplyScalar(rec.level); } },
      dispose() {
        if (!rec.live) return; rec.live = false; beams.splice(beams.indexOf(rec), 1);
        mesh.removeFromParent(); meshes.splice(meshes.indexOf(mesh), 1); mesh.geometry.dispose(); mat.dispose();
      }
    };
  }

  /* ---------- particle spawning ---------- */
  const tmpColor = new THREE.Color(), dirTmp = { x: 0, y: 0, z: 0 }, rnd = (a, b) => a + Math.random() * (b - a);
  const readDir = d => {
    if (!d) { dirTmp.x = dirTmp.y = dirTmp.z = 0; return 0; }
    const x = finite(d.x, 0), y = finite(d.y, 0), z = finite(d.z, 0), l = Math.sqrt(x * x + y * y + z * z);
    if (l < 1e-6) { dirTmp.x = dirTmp.y = dirTmp.z = 0; return 0; }
    dirTmp.x = x / l; dirTmp.y = y / l; dirTmp.z = z / l; return 1;
  };
  // random direction biased around dirTmp (spread 0 = exact, 1 = hemisphere-ish); writes into out[0..2]
  const scatter = (out, has, spread, up) => {
    let x = rnd(-1, 1), y = rnd(-1, 1), z = rnd(-1, 1);
    const l = Math.sqrt(x * x + y * y + z * z) || 1; x /= l; y /= l; z /= l;
    if (has) { x = dirTmp.x + x * spread; y = dirTmp.y + y * spread; z = dirTmp.z + z * spread; }
    y += up; const m = Math.sqrt(x * x + y * y + z * z) || 1; out[0] = x / m; out[1] = y / m; out[2] = z / m;
  };
  const vtmp = new Float64Array(3);
  const budget = n => Math.max(1, Math.round(n * Q.particles));

  function emitSpark(x, y, z, vx, vy, vz, life, width, bright) {
    if (sparkCount >= MAX_SPARKS) return;
    const o = sparkCount++ * SPK;
    spark[o] = x; spark[o + 1] = y; spark[o + 2] = z; spark[o + 3] = vx; spark[o + 4] = vy; spark[o + 5] = vz;
    spark[o + 6] = 0; spark[o + 7] = life; spark[o + 8] = width; spark[o + 9] = tmpColor.r; spark[o + 10] = tmpColor.g; spark[o + 11] = tmpColor.b; spark[o + 12] = bright;
  }
  function sparks(x, y, z, o) {
    if (disposed) return;
    o = o || NO_INPUT;
    x = finite(x, 0); y = finite(y, 0); z = finite(z, 0);
    const has = readDir(o.dir), speed = clamp(finite(o.speed, 4), 0.2, 30), n = budget(clamp(finite(o.count, 24), 1, 200));
    tmpColor.set(o.color ?? 0xffc070);
    for (let i = 0; i < n; i++) {
      scatter(vtmp, has, 0.75, 0.25);
      const s = speed * (0.3 + Math.random() * Math.random() * 1.1 + Math.random() * 0.25);
      emitSpark(x, y, z, vtmp[0] * s, vtmp[1] * s, vtmp[2] * s, rnd(0.4, 0.9), rnd(0.0035, 0.0075), (Math.random() < 0.15 ? rnd(9, 16) : rnd(2.5, 7)) * (effects ? 1 : 0.6));
    }
    sparkMesh.visible = true;
  }
  function emitMatter(kind, x, y, z, vx, vy, vz, life, s0, s1, r, g, b, alpha, drag, grav, decal) {
    if (matterCount >= MAX_MATTER) return;
    const o = matterCount++ * MTK;
    matter[o] = x; matter[o + 1] = y; matter[o + 2] = z; matter[o + 3] = vx; matter[o + 4] = vy; matter[o + 5] = vz;
    matter[o + 6] = 0; matter[o + 7] = life; matter[o + 8] = s0; matter[o + 9] = s1; matter[o + 10] = r; matter[o + 11] = g; matter[o + 12] = b;
    matter[o + 13] = alpha; matter[o + 14] = kind; matter[o + 15] = Math.random(); matter[o + 16] = Math.random() * 6.28;
    matter[o + 17] = kind === CHIP ? rnd(-14, 14) : rnd(-0.6, 0.6); matter[o + 18] = drag; matter[o + 19] = grav; matter[o + 20] = decal;
  }
  function blood(x, y, z, o) {
    if (disposed) return;
    o = o || NO_INPUT;
    x = finite(x, 0); y = finite(y, 1); z = finite(z, 0);
    const has = readDir(o.dir), amount = clamp(finite(o.amount, 1), 0.2, 4), k = Q.particles;
    const mist = Math.max(2, Math.round((3 + 2 * amount) * Math.sqrt(k))), drops = budget(12 * amount);
    for (let i = 0; i < mist; i++) {
      scatter(vtmp, has, 0.9, 0.1); const s = rnd(0.4, 1.6) * Math.sqrt(amount);
      const shade = rnd(0.7, 1.15);
      emitMatter(PUFF, x + rnd(-0.05, 0.05), y + rnd(-0.05, 0.05), z + rnd(-0.05, 0.05), vtmp[0] * s, vtmp[1] * s, vtmp[2] * s, rnd(0.55, 1.05),
        rnd(0.06, 0.12) * amount ** 0.3, rnd(0.32, 0.6) * amount ** 0.4, 0.34 * shade, 0.012 * shade, 0.018 * shade, rnd(0.55, 0.8), 4.5, 0.45, 0);
    }
    for (let i = 0; i < drops; i++) {
      scatter(vtmp, has, 0.8, 0.35); const s = rnd(1.2, 4.2);
      const heavy = i < Math.max(1, Math.round(amount)) ? 1 : 0;
      emitMatter(DROP, x, y, z, vtmp[0] * s, vtmp[1] * s, vtmp[2] * s, 2.5, rnd(0.006, 0.013) * (heavy ? 1.6 : 1), 0, 0.24, 0.0, 0.012, 0.95, 0.15, GRAVITY,
        heavy ? rnd(0.13, 0.2) * Math.sqrt(amount) : Math.random() < 0.55 ? rnd(0.025, 0.06) : 0);
    }
    matterMesh.visible = true;
  }
  function debris(x, y, z, o) {
    if (disposed) return;
    o = o || NO_INPUT;
    x = finite(x, 0); y = finite(y, 1); z = finite(z, 0);
    const has = readDir(o.dir), puffs = Math.max(3, Math.round(6 * Math.sqrt(Q.particles))), chips = budget(12);
    tmpColor.set(o.color ?? 0x9d9384);
    const cr = tmpColor.r, cg = tmpColor.g, cb = tmpColor.b;
    for (let i = 0; i < puffs; i++) {
      // a fast jet along the normal plus a slower cloud that billows and settles
      const jet = i < 2; scatter(vtmp, has, jet ? 0.25 : 0.6, 0.05); const s = jet ? rnd(1.6, 2.6) : rnd(0.3, 1.1), shade = rnd(0.8, 1.1);
      emitMatter(PUFF, x, y, z, vtmp[0] * s, vtmp[1] * s, vtmp[2] * s, rnd(1.0, 1.9), jet ? rnd(0.07, 0.11) : rnd(0.04, 0.08), jet ? rnd(0.3, 0.45) : rnd(0.4, 0.75),
        cr * shade, cg * shade, cb * shade, jet ? 0.62 : rnd(0.5, 0.75), jet ? 4.5 : 2.6, -0.1, 0);
    }
    for (let i = 0; i < chips; i++) {
      scatter(vtmp, has, 0.85, 0.3); const s = rnd(1.4, 4.5), shade = rnd(0.3, 0.8);
      emitMatter(CHIP, x, y, z, vtmp[0] * s, vtmp[1] * s, vtmp[2] * s, rnd(0.7, 1.3), rnd(0.012, 0.026), 0, cr * shade, cg * shade, cb * shade, 1, 0.3, GRAVITY, 0);
    }
    const flecks = Math.round(finite(o.sparks, 4));
    if (flecks > 0) {
      tmpColor.set(0xffd9a0);
      for (let i = 0; i < flecks; i++) { scatter(vtmp, has, 0.6, 0.2); const s = rnd(2, 5); emitSpark(x, y, z, vtmp[0] * s, vtmp[1] * s, vtmp[2] * s, rnd(0.12, 0.3), 0.006, rnd(3, 6)); }
      sparkMesh.visible = true;
    }
    matterMesh.visible = true;
  }
  // o = pool offset of the drop that just landed (helpers on the per-frame path take no float arguments: boxing)
  function spawnDecal(o) {
    const x = matter[o], z = matter[o + 2], vx = matter[o + 3], vz = matter[o + 5], size = matter[o + 20], alpha = size > 0.1 ? 0.94 : 0.85;
    const cap = Q.decals, i = decalHead % cap; decalHead = (decalHead + 1) % cap; decalSpawned++;
    const h = Math.sqrt(vx * vx + vz * vz), ang = h > 0.05 ? Math.atan2(vz, vx) : Math.random() * 6.28, stretch = 1 + Math.min(0.9, h * 0.22);
    const life = rnd(19, 24);
    dA.array[i * 4] = x; dA.array[i * 4 + 1] = 0.004 + (decalSpawned % 8) * 0.0007; dA.array[i * 4 + 2] = z; dA.array[i * 4 + 3] = size;
    dB.array[i * 4] = Math.cos(ang); dB.array[i * 4 + 1] = Math.sin(ang); dB.array[i * 4 + 2] = stretch; dB.array[i * 4 + 3] = Math.random() * 7;
    dC.array[i * 4] = st.now; dC.array[i * 4 + 1] = life; dC.array[i * 4 + 2] = alpha; dC.array[i * 4 + 3] = 0;
    dA.needsUpdate = dB.needsUpdate = dC.needsUpdate = true;
    decalGeo.instanceCount = Math.min(cap, Math.max(decalGeo.instanceCount, i + 1));
    st.decalEnd = Math.max(st.decalEnd, st.now + life); decalMesh.visible = true;
  }

  // Bullet tracer from the shot origin to its hit point. An origin at the viewer's eye is moved to the camera-space
  // muzzle (o.muzzle, false to keep the origin) so the streak is not seen end-on. Called once per shot: everything is
  // written straight into the pool, without helper calls that take float arguments (V8 would box them).
  function tracer(ox, oy, oz, hx, hy, hz, o) {
    if (disposed || !isNum(ox) || !isNum(oy) || !isNum(oz) || !isNum(hx) || !isNum(hy) || !isNum(hz)) return;
    o = o || NO_INPUT;
    let fx = hx - ox, fy = hy - oy, fz = hz - oz;
    const d0 = Math.sqrt(fx * fx + fy * fy + fz * fz);
    if (d0 < 0.05) return;
    fx /= d0; fy /= d0; fz /= d0;
    let sx = ox, sy = oy, sz = oz;
    const m = o.muzzle === undefined ? MUZZLE : o.muzzle;
    if (m && typeof m === 'object' && d0 >= SHORT_SHOT) {
      const e = camera ? camera.matrixWorld.elements : null, ex = e ? e[12] : camPos.x, ey = e ? e[13] : camPos.y, ez = e ? e[14] : camPos.z;
      if ((ox - ex) * (ox - ex) + (oy - ey) * (oy - ey) + (oz - ez) * (oz - ez) < 0.1225) {
        // camera basis (right, up, back); without a camera it is rebuilt from the shot direction
        let rx = 1, ry = 0, rz = 0, ux = 0, uy = 1, uz = 0, bx = -fx, by = -fy, bz = -fz;
        if (e) { rx = e[0]; ry = e[1]; rz = e[2]; ux = e[4]; uy = e[5]; uz = e[6]; bx = e[8]; by = e[9]; bz = e[10]; }
        else {
          const hl = Math.sqrt(fx * fx + fz * fz);
          if (hl > 1e-4) { rx = -fz / hl; rz = fx / hl; }
          ux = by * rz - bz * ry; uy = bz * rx - bx * rz; uz = bx * ry - by * rx;
        }
        const qx = m.x, qy = m.y, qz = m.z;
        const mx = typeof qx === 'number' && qx - qx === 0 ? qx : MUZZLE.x, my = typeof qy === 'number' && qy - qy === 0 ? qy : MUZZLE.y, mz = typeof qz === 'number' && qz - qz === 0 ? qz : MUZZLE.z;
        const px = ox + rx * mx + ux * my + bx * mz, py = oy + ry * mx + uy * my + by * mz, pz = oz + rz * mx + uz * my + bz * mz;
        if ((hx - px) * fx + (hy - py) * fy + (hz - pz) * fz > 0.5) { sx = px; sy = py; sz = pz; }
      }
    }
    let dx = hx - sx, dy = hy - sy, dz = hz - sz;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1; dx /= dist; dy /= dist; dz /= dist;
    const sp = o.speed, ln = o.length, wd = o.width, col = o.color, flash = d0 < SHORT_SHOT;
    const speed = typeof sp === 'number' && sp - sp === 0 ? Math.min(5000, Math.max(5, sp)) : 260;
    const length = typeof ln === 'number' && ln - ln === 0 ? Math.min(30, Math.max(0.1, ln)) : 3.5;
    const width = (typeof wd === 'number' && wd - wd === 0 ? Math.min(0.3, Math.max(0.001, wd)) : 0.018) * Q.tracerWidth;
    if (typeof col === 'number') { if (col !== tracerHex) { tracerCol.setHex(col); tracerHex = col; } }
    else if (col != null) { tracerCol.set(col); tracerHex = -1; }
    else if (tracerHex !== 0xffd9a0) { tracerCol.setHex(0xffd9a0); tracerHex = 0xffd9a0; }
    // the pool is full: recycle the oldest streak
    let i = tracerCount;
    if (i >= Q.tracers) { i = 0; for (let k = 1; k < tracerCount; k++) if (trc[k * TRK + 7] > trc[i * TRK + 7]) i = k; } else tracerCount++;
    // the head stops just short of the surface; a fresh streak already shows half its length (visible on its first frame)
    const r = i * TRK, end = dist - Math.min(0.12, dist * 0.1);
    trc[r] = sx; trc[r + 1] = sy; trc[r + 2] = sz; trc[r + 3] = dx; trc[r + 4] = dy; trc[r + 5] = dz; trc[r + 6] = end;
    trc[r + 7] = flash ? 0 : Math.min(0.5 * length, end) / speed; trc[r + 8] = speed; trc[r + 9] = length; trc[r + 10] = width;
    trc[r + 11] = tracerCol.r; trc[r + 12] = tracerCol.g; trc[r + 13] = tracerCol.b; trc[r + 14] = flash ? 1 : 0; trc[r + 15] = 1;
    writeTracers();
  }

  /* ---------- per-frame simulation ---------- */
  function stepTracers() {
    const dt = st.dt;
    for (let i = 0; i < tracerCount;) {
      // the first update after a spawn does not move it: the streak leaving the muzzle is always drawn once
      const r = i * TRK, age = trc[r + 15] > 0.5 ? trc[r + 7] : trc[r + 7] + dt;
      trc[r + 7] = age; trc[r + 15] = 0;
      // a streak dies once its tail has drained into the hit point; a short-range shot is a brief flash
      if (trc[r + 14] > 0.5 ? age >= FLASH_LIFE : age * trc[r + 8] - trc[r + 9] >= trc[r + 6]) {
        const last = --tracerCount * TRK; if (last !== r) trc.copyWithin(r, last, last + TRK); continue;
      }
      i++;
    }
    writeTracers();
  }
  function writeTracers() {
    const Hd = tH.array, Tl = tT.array, C = tC.array;
    for (let i = 0; i < tracerCount; i++) {
      const r = i * TRK, j = i * 4, end = trc[r + 6], len = trc[r + 9], flash = trc[r + 14] > 0.5, travel = trc[r + 7] * trc[r + 8];
      const head = flash ? end : Math.min(travel, end), tail = flash ? Math.max(0, end - len) : Math.min(Math.max(travel - len, 0), end);
      Hd[j] = trc[r] + trc[r + 3] * head; Hd[j + 1] = trc[r + 1] + trc[r + 4] * head; Hd[j + 2] = trc[r + 2] + trc[r + 5] * head;
      Hd[j + 3] = flash ? 1 - trc[r + 7] / FLASH_LIFE : 1;
      Tl[j] = trc[r] + trc[r + 3] * tail; Tl[j + 1] = trc[r + 1] + trc[r + 4] * tail; Tl[j + 2] = trc[r + 2] + trc[r + 5] * tail; Tl[j + 3] = trc[r + 10];
      C[j] = trc[r + 11]; C[j + 1] = trc[r + 12]; C[j + 2] = trc[r + 13]; C[j + 3] = len;
    }
    tracerGeo.instanceCount = tracerCount; tracerMesh.visible = tracerCount > 0;
    if (tracerCount) tH.needsUpdate = tT.needsUpdate = tC.needsUpdate = true;
  }
  function stepSparks() {
    const dt = st.dt;
    const drag = Math.exp(-dt * 1.6);
    for (let i = 0; i < sparkCount;) {
      const o = i * SPK;
      spark[o + 6] += dt;
      if (spark[o + 6] >= spark[o + 7]) { const last = --sparkCount * SPK; if (last !== o) spark.copyWithin(o, last, last + SPK); continue; }
      spark[o + 4] -= GRAVITY * dt; spark[o + 3] *= drag; spark[o + 4] *= drag; spark[o + 5] *= drag;
      spark[o] += spark[o + 3] * dt; spark[o + 1] += spark[o + 4] * dt; spark[o + 2] += spark[o + 5] * dt;
      if (spark[o + 1] < 0.01 && spark[o + 4] < 0) { spark[o + 1] = 0.01; spark[o + 4] *= -0.32; spark[o + 3] *= 0.62; spark[o + 5] *= 0.62; }
      i++;
    }
    const P = sP.array, V = sV.array, C = sC.array;
    for (let i = 0; i < sparkCount; i++) {
      const o = i * SPK, j = i * 4;
      P[j] = spark[o]; P[j + 1] = spark[o + 1]; P[j + 2] = spark[o + 2]; P[j + 3] = spark[o + 6] / spark[o + 7];
      V[j] = spark[o + 3]; V[j + 1] = spark[o + 4]; V[j + 2] = spark[o + 5]; V[j + 3] = spark[o + 8];
      C[j] = spark[o + 9]; C[j + 1] = spark[o + 10]; C[j + 2] = spark[o + 11]; C[j + 3] = spark[o + 12];
    }
    sparkGeo.instanceCount = sparkCount; sparkMesh.visible = sparkCount > 0;
    if (sparkCount) sP.needsUpdate = sV.needsUpdate = sC.needsUpdate = true;
  }
  function stepMatter() {
    const dt = st.dt;
    for (let i = 0; i < matterCount;) {
      const o = i * MTK, kind = matter[o + 14];
      matter[o + 6] += dt;
      let dead = matter[o + 6] >= matter[o + 7];
      if (!dead) {
        const drag = Math.exp(-dt * matter[o + 18]);
        matter[o + 4] -= matter[o + 19] * dt; matter[o + 3] *= drag; matter[o + 4] *= drag; matter[o + 5] *= drag;
        matter[o] += matter[o + 3] * dt; matter[o + 1] += matter[o + 4] * dt; matter[o + 2] += matter[o + 5] * dt;
        matter[o + 16] += matter[o + 17] * dt;
        if (kind === DROP && matter[o + 1] <= 0.004) {
          if (matter[o + 20] > 0) spawnDecal(o);
          dead = true;
        } else if (kind === CHIP && matter[o + 1] < 0.006 && matter[o + 4] < 0) {
          matter[o + 1] = 0.006; matter[o + 4] *= -0.28; matter[o + 3] *= 0.5; matter[o + 5] *= 0.5; matter[o + 17] *= 0.5;
        } else if (kind === PUFF && matter[o + 1] < 0.05) { matter[o + 1] = 0.05; matter[o + 4] = Math.max(0, matter[o + 4]); }
      }
      if (dead) { const last = --matterCount * MTK; if (last !== o) matter.copyWithin(o, last, last + MTK); continue; }
      i++;
    }
    const P = mP.array, V = mV.array, C = mC.array, K = mK.array;
    for (let i = 0; i < matterCount; i++) {
      const o = i * MTK, j = i * 4, kind = matter[o + 14], a = matter[o + 6] / matter[o + 7];
      let size = matter[o + 8], alpha = matter[o + 13];
      if (kind === PUFF) { const g = 1 - (1 - a) * (1 - a); size = matter[o + 8] + (matter[o + 9] - matter[o + 8]) * g; alpha *= Math.min(1, a * 12) * (1 - a) * (1 - a); }
      else if (kind === CHIP) alpha *= Math.min(1, (1 - a) * 6);
      P[j] = matter[o]; P[j + 1] = matter[o + 1]; P[j + 2] = matter[o + 2]; P[j + 3] = a;
      V[j] = matter[o + 3]; V[j + 1] = matter[o + 4]; V[j + 2] = matter[o + 5]; V[j + 3] = size;
      C[j] = matter[o + 10]; C[j + 1] = matter[o + 11]; C[j + 2] = matter[o + 12]; C[j + 3] = alpha;
      K[j] = kind; K[j + 1] = matter[o + 15]; K[j + 2] = matter[o + 16]; K[j + 3] = 0;
    }
    matterGeo.instanceCount = matterCount; matterMesh.visible = matterCount > 0;
    if (matterCount) mP.needsUpdate = mV.needsUpdate = mC.needsUpdate = mK.needsUpdate = true;
  }
  const litPick = new Int32Array(LIT), litDist = new Float32Array(LIT);
  function pickLitCones() {
    const cx = camPos.x, cz = camPos.z, flick = st.flick;
    let n = 0, on = 0;
    for (let i = 0; i < cones.length; i++) {
      const c = cones[i]; if (c.intensity <= 0) continue;
      on++;
      const d = (c.x - cx) * (c.x - cx) + (c.z - cz) * (c.z - cz);
      if (n < LIT) { litPick[n] = i; litDist[n] = d; n++; continue; }
      let worst = 0; for (let k = 1; k < LIT; k++) if (litDist[k] > litDist[worst]) worst = k;
      if (d < litDist[worst]) { litPick[worst] = i; litDist[worst] = d; }
    }
    for (let k = 0; k < LIT; k++) {
      if (k >= n) { litB[k].z = 0; litA[k].y = -50; continue; }
      const c = cones[litPick[k]], a = litA[k], b = litB[k], col = litC[k];
      a.x = c.x; a.y = c.y; a.z = c.z; a.w = c.L; b.x = c.r0; b.y = c.R; b.z = c.intensity * flick; col.x = c.color.r; col.y = c.color.g; col.z = c.color.b;
    }
    return on;
  }

  // Pipelines compile on first draw. While warm > 0 every effect is also drawn with an invisible stand-in instance (zero
  // colour, alpha or life), so the first shot, splat or chase does not hitch. create() arms it for its first two frames;
  // prewarm() re-arms it, e.g. after fixtures are added later.
  let warm = 0, warmed = false;
  function prewarm() { if (!disposed) warm = 2; }
  function warmDraw() {
    warmed = true;
    if (!sparkCount) { sC.array[3] = 0; sC.needsUpdate = true; sparkGeo.instanceCount = 1; sparkMesh.visible = true; }
    if (!matterCount) { mC.array[3] = 0; mC.needsUpdate = true; matterGeo.instanceCount = 1; matterMesh.visible = true; }
    if (!tracerCount) { tH.array[3] = 0; tH.needsUpdate = true; tracerGeo.instanceCount = 1; tracerMesh.visible = true; }
    if (!decalMesh.visible) { dC.array[1] = dC.array[2] = 0; dC.needsUpdate = true; decalGeo.instanceCount = 1; decalMesh.visible = true; }
    if (!coneMesh.visible) { if (!cones.length) { cColor.array[3] = 0; cColor.needsUpdate = true; coneGeo.instanceCount = 1; } coneMesh.visible = true; }
    if (!bladeMesh.visible) { if (!beacons.length) { bCol.array[3] = 0; bCol.needsUpdate = true; bladeGeo.instanceCount = 1; } bladeMesh.visible = true; }
    dustMesh.visible = true;   // unlit motes only carry the faint ambient term
    for (let i = 0; i < beams.length; i++) beams[i].mesh.visible = true;   // a dark beam's colour is zero
  }
  const camPos = new THREE.Vector3(), camDir = new THREE.Vector3(0, 0, -1), dustCenter = U.dustCenter.value, dustBox = U.dustBox.value;
  // The per-frame path writes fields directly and validates inputs inline: a float passed to (or returned from) a call
  // that V8 does not inline gets boxed. Measured allocation-free in both optimising tiers while the caller keeps its
  // argument shapes stable from frame to frame (mixing e.g. {x,y,z} literals and Vector3s makes V8 box the reads).
  function readVec(v, out) {
    const x = v.x, y = v.y, z = v.z;
    out.x = typeof x === 'number' && x - x === 0 ? x : 0; out.y = typeof y === 'number' && y - y === 0 ? y : 0; out.z = typeof z === 'number' && z - z === 0 ? z : 0;
  }
  function update(dt, o) {
    if (disposed) return;
    o = o || NO_INPUT;
    dt = dt > 0 ? Math.min(dt, 0.1) : 0;
    st.dt = dt; st.now += dt; frameV.x = st.now;
    const cp = o.cameraPosition, cd = o.cameraDirection;
    if (cp) readVec(cp, camPos); else if (camera) camera.getWorldPosition(camPos);
    if (cd) readVec(cd, camDir); else if (camera) camera.getWorldDirection(camDir);
    const dl = Math.sqrt(camDir.x * camDir.x + camDir.y * camDir.y + camDir.z * camDir.z);
    if (dl < 1e-4) { camDir.x = 0; camDir.y = 0; camDir.z = -1; } else { camDir.x /= dl; camDir.y /= dl; camDir.z /= dl; }
    const fl = o.flicker, flick = typeof fl === 'number' && fl - fl === 0 ? Math.min(2, Math.max(0, fl)) : 1;
    // with effects off, rapid light strobing reaches the shafts only as a slow dim
    st.flick = effects ? flick : st.flick + (flick - st.flick) * (1 - Math.exp(-dt * 3));
    st.slow += (st.flick - st.slow) * (1 - Math.exp(-dt * 1.5));
    // torch beams follow fast dips below the recent level (interference) but not sustained darkness (a blackout)
    const dip = Math.min(1, Math.max(0, (st.slow - st.flick) / Math.max(st.slow, 0.25))), torch = o.torchOn === false ? 0 : 1;
    for (let i = 0; i < beams.length; i++) {
      const b = beams[i], k = torch * b.intensity * (1 - b.flicker * dip);
      b.level = k; b.color.r = b.base.r * k; b.color.g = b.base.g * k; b.color.b = b.base.b * k; b.mesh.visible = k > 1e-4;
    }
    frameV.z = st.flick; viewV.w = effects ? 1 : 0;
    const dg = o.danger, danger = typeof dg === 'number' && dg - dg === 0 ? Math.min(1, Math.max(0, dg)) : 0;
    st.dust += dt * (1 + 1.5 * danger); frameV.y = st.dust;
    U.torchPos.value.copy(camPos); U.torchDir.value.copy(camDir);
    frameV.w = beams.length ? beams[0].level : torch * (1 - 0.5 * dip);
    const fog = scene.fog;
    const exp2 = !!fog && fog.isFogExp2 === true, lin = !!fog && !exp2 && fog.isFog === true;
    fogV.x = exp2 ? fog.density : 0; fogV.y = lin ? fog.near : 1e6; fogV.z = lin ? Math.max(fog.far, fog.near + 0.01) : 2e6;
    if (camera && camera.isPerspectiveCamera) viewV.x = Math.tan(camera.fov * Math.PI / 360) / (camera.zoom || 1);
    dustCenter.x = camPos.x + camDir.x * dustBox.x * 0.32; dustCenter.y = camPos.y + camDir.y * 0.5; dustCenter.z = camPos.z + camDir.z * dustBox.z * 0.32;
    // nothing is drawn for shafts that are all dark; motes are skipped when neither the torch nor a shaft lights them
    coneMesh.visible = pickLitCones() > 0 && st.flick > 1e-3;
    dustMesh.visible = coneMesh.visible || frameV.w > 1e-4;
    if (sparkCount || sparkMesh.visible) stepSparks();
    if (matterCount || matterMesh.visible) stepMatter();
    if (tracerCount || tracerMesh.visible) stepTracers();
    if (decalMesh.visible && st.now > st.decalEnd) { decalMesh.visible = false; decalGeo.instanceCount = 0; decalHead = 0; }
    if (warmed) { warmed = false; coneGeo.instanceCount = cones.length; syncBeacons(); }
    if (warm > 0) { warm--; warmDraw(); }
  }

  function setQuality(level) {
    const lv = tier(level);
    if (disposed || !lv || lv === quality) return;
    quality = lv; Q = QUALITY[lv];
    dustGeo.setDrawRange(0, Q.dust * 6);
    if (decalGeo.instanceCount > Q.decals) decalGeo.instanceCount = Q.decals;
    if (tracerCount > Q.tracers) { tracerCount = Q.tracers; writeTracers(); }
    decalHead %= Q.decals;
    for (const b of beams) { const old = b.mesh.geometry; b.mesh.geometry = beamGeometry(Q.slices, b.length, b.angle); old.dispose(); }
  }
  function setPreferences(p = {}) {
    if (p && typeof p.effects === 'boolean') { effects = p.effects; viewV.w = effects ? 1 : 0; }
  }
  // global brightness trims for matching a scene's light levels (1 = authored look)
  const gains = { cones: 1, dust: 1, sparks: 1, ambient: 1, tracers: 1 };
  function setGains(g) {
    if (g) for (const k in gains) if (typeof g[k] === 'number' && Number.isFinite(g[k])) gains[k] = clamp(g[k], 0, 10);
    gainV.set(0.9 * gains.cones, gains.dust, gains.sparks, 0.035 * gains.ambient); U.tracerGain.value = gains.tracers;
    return { ...gains };
  }
  function clear(o) {
    sparkCount = matterCount = tracerCount = 0; sparkGeo.instanceCount = matterGeo.instanceCount = decalGeo.instanceCount = tracerGeo.instanceCount = 0;
    sparkMesh.visible = matterMesh.visible = decalMesh.visible = tracerMesh.visible = false; decalHead = 0; st.decalEnd = -1;
    for (let i = 0; i < MAX_DECALS; i++) dC.array[i * 4 + 1] = 0;
    dC.needsUpdate = true;
    if (o && o.fixtures) {
      while (cones.length) cones[cones.length - 1].live = false, cones.pop();
      while (beacons.length) beacons[beacons.length - 1].live = false, beacons.pop();
      coneGeo.instanceCount = housingGeo.instanceCount = bladeGeo.instanceCount = 0; coneMesh.visible = housingMesh.visible = bladeMesh.visible = false;
    }
  }
  function dispose() {
    if (disposed) return; disposed = true;
    for (const b of beams) { b.live = false; b.mesh.removeFromParent(); b.mesh.geometry.dispose(); b.mesh.material.dispose(); }
    beams.length = 0;
    for (const m of meshes) m.removeFromParent();
    for (const d of new Set(disposables)) d.dispose();
    meshes.length = 0; cones.length = 0; beacons.length = 0;
  }
  function snapshot() {
    let draws = 0; for (const m of meshes) if (m.visible && (!m.geometry.isInstancedBufferGeometry || m.geometry.instanceCount > 0)) draws++;
    let decals = 0; for (let i = 0; i < decalGeo.instanceCount; i++) { const age = st.now - dC.array[i * 4]; if (age >= 0 && age < dC.array[i * 4 + 1]) decals++; }
    return { cones: cones.length, beacons: beacons.length, beams: beams.length, particles: sparkCount + matterCount, sparks: sparkCount, matter: matterCount,
      tracers: tracerCount, decals, dust: disposed ? 0 : dustGeo.drawRange.count / 6, torch: disposed ? 0 : frameV.w, quality, effects, drawCalls: disposed ? 0 : draws, time: st.now };
  }
  dustGeo.setDrawRange(0, Q.dust * 6);
  setGains(options.gains);
  prewarm();

  return Object.freeze({ addLightCone, torchBeam, addBeacon, sparks, blood, debris, tracer, update, prewarm, setQuality, setPreferences, setGains, clear, dispose, snapshot });
}

globalThis.HollowAtmosphere = Object.freeze({ create, QUALITY });
