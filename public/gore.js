/* Persistent gore for the creatures and the floors they bleed on: wounds that ride the joint they were shot into, exit
   sprays that splat the walls and floor behind a creature, drips that trail a wounded one, chunks that bounce and lie
   where they land, severed arms and jaws that tumble to the floor, decapitations with a pulsing neck fountain, and blood
   pooling under corpses. Everything is pooled and capped (fewer with low quality or effects off), update() performs no
   allocations, and the textures are generated in code. Works with three's WebGPURenderer and plain three in tests.
   HollowGore.create({ THREE, scene, quality, effects, blocks(x, y, z), floorY, ceiling, random }). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HollowGore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const QUALITY = Object.freeze({ high: 1, medium: .75, low: .45 });
  // Pool sizes at high quality with effects on; quality and effects scale the live caps below these.
  const MAX = Object.freeze({ wounds: 96, perMonster: 10, stumps: 12, splats: 320, walls: 128, pools: 14, chunks: 72, drops: 360,
    limbs: 4, fountains: 4 });
  const GRAVITY = 9.8, ENTRY = 0, EXIT = 1, STUMP = 2;
  const DK = 12;      // drop: x y z vx vy vz size splat age life walls kind
  const CK = 20;      // chunk: x y z vx vy vz qx qy qz qw wx wy wz size sleep landed r g b age
  const NOOP = Object.freeze({});
  const LIMB_POINTS = 128;    // surface samples a severed limb rests on
  // 26 directions (cube faces, edges and corners): each mesh contributes its furthest vertex along each, so the samples
  // cover the limb's outline however finely its meshes are tessellated.
  const DIRS = [];
  for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) if (x || y || z) DIRS.push([x, y, z]);

  const finite = (v, d) => typeof v === 'number' && Number.isFinite(v) ? v : d;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  /* ---------- procedural textures and geometry (built once per create) ---------- */
  function hash2(x, y, s) {
    let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(s | 0, 0x1b873593);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35); h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  function vnoise(x, y, s) {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy, u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    const a = hash2(ix, iy, s), b = hash2(ix + 1, iy, s), c = hash2(ix, iy + 1, s), d = hash2(ix + 1, iy + 1, s);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  function fbm(x, y, s) { return .55 * vnoise(x, y, s) + .3 * vnoise(x * 2.1, y * 2.1, s + 7) + .15 * vnoise(x * 4.3, y * 4.3, s + 13); }
  const toSRGB = c => { c = clamp(c, 0, 1); return Math.round(255 * (c <= .0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - .055)); };
  // Thin blood (edges, flecks) to thick (cores), in linear RGB: the atmosphere splats' colours.
  const THIN = [.42, .035, .03], THICK = [.13, 0, .005];

  function texture(THREE, size, paint) {
    const data = new Uint8Array(size * size * 4), px = [0, 0, 0, 0];
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      paint((x + .5) / size * 2 - 1, (y + .5) / size * 2 - 1, px);
      const o = (y * size + x) * 4;
      data[o] = toSRGB(px[0]); data[o + 1] = toSRGB(px[1]); data[o + 2] = toSRGB(px[2]); data[o + 3] = Math.round(255 * clamp(px[3], 0, 1));
    }
    const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    if ('colorSpace' in tex && THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.generateMipmaps = true;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping; tex.needsUpdate = true;
    return tex;
  }
  function bloodColor(out, thick, n) {
    const k = clamp(thick, 0, 1), m = .85 + .3 * n;
    out[0] = (THIN[0] + (THICK[0] - THIN[0]) * k) * m; out[1] = (THIN[1] + (THICK[1] - THIN[1]) * k) * m; out[2] = (THIN[2] + (THICK[2] - THIN[2]) * k) * m;
  }
  // Droplets and streaks thrown out of a splat: [x, y, radius, streak dx, streak dy].
  function satellites(seed, n, near, far, up) {
    const list = [];
    for (let i = 0; i < n; i++) {
      const a = hash2(i, 1, seed) * Math.PI * 2, d = near + (far - near) * Math.sqrt(hash2(i, 2, seed));
      const streak = hash2(i, 3, seed) < .35 ? .08 + .14 * hash2(i, 4, seed) : 0;
      list.push([Math.cos(a) * d, Math.sin(a) * d * (up ? .7 : 1) + (up || 0), .012 + .05 * Math.pow(hash2(i, 5, seed), 2), Math.cos(a) * streak, Math.sin(a) * streak]);
    }
    return list;
  }
  function dropMask(list, x, y) {
    let m = 0;
    for (const [cx, cy, r, sx, sy] of list) {
      let dx = x - cx, dy = y - cy;
      if (sx || sy) {                       // a capsule from the droplet back toward the centre, tapering
        const l2 = sx * sx + sy * sy, t = clamp(-(dx * sx + dy * sy) / l2, 0, 1);
        dx += sx * t; dy += sy * t;
        const rr = r * (1 - .6 * t);
        m = Math.max(m, clamp((rr - Math.hypot(dx, dy)) / (rr * .35 + .004), 0, 1));
      } else m = Math.max(m, clamp((r - Math.hypot(dx, dy)) / (r * .35 + .004), 0, 1));
    }
    return m;
  }
  function floorTexture(THREE) {
    const sats = satellites(11, 26, .5, .95);
    return texture(THREE, 128, (x, y, px) => {
      const r = Math.hypot(x, y), a = Math.atan2(y, x);
      const edge = .36 + .16 * fbm(Math.cos(a) * 1.6 + 3, Math.sin(a) * 1.6 + 3, 5) + .08 * Math.pow(vnoise(a * 2.6 + 9, 1, 3), 3);
      const core = clamp((edge - r) / .03, 0, 1), n = fbm(x * 5, y * 5, 9);
      const m = Math.max(core, dropMask(sats, x, y));
      bloodColor(px, clamp((edge - r) / (edge * .55), 0, 1), n);
      px[3] = m * (.82 + .18 * n);
    });
  }
  function poolTexture(THREE) {
    return texture(THREE, 128, (x, y, px) => {
      const r = Math.hypot(x, y), a = Math.atan2(y, x);
      const edge = .74 + .12 * fbm(Math.cos(a) * 1.2 + 5, Math.sin(a) * 1.2 + 5, 21) + .06 * vnoise(a * 3 + 2, 4, 8);
      const m = clamp((edge - r) / .025, 0, 1), n = fbm(x * 4, y * 4, 33);
      // A darker, thicker middle and a lighter meniscus right at the rim.
      const rim = clamp(1 - (edge - r) / .07, 0, 1);
      bloodColor(px, clamp((edge - r) / .25, 0, 1) * (1 - .55 * rim), n);
      px[3] = m * .96;
    });
  }
  function wallTexture(THREE) {
    const sats = satellites(23, 40, .2, .86, .25), runs = [];
    for (let i = 0; i < 6; i++) {
      runs.push([(hash2(i, 7, 41) - .5) * .7, .25 + (hash2(i, 8, 41) - .5) * .25, -.25 - .65 * hash2(i, 9, 41), .012 + .022 * hash2(i, 10, 41)]);
    }
    return texture(THREE, 128, (x, y, px) => {
      const dx = x, dy = y - .25, r = Math.hypot(dx, dy * 1.15), a = Math.atan2(dy, dx);
      const edge = .27 + .12 * fbm(Math.cos(a) * 1.8 + 1, Math.sin(a) * 1.8 + 1, 17);
      let m = Math.max(clamp((edge - r) / .03, 0, 1), dropMask(sats, x, y));
      // Runs down the wall from the splat, thinning, each ending in a bead.
      for (const [cx, top, end, w] of runs) {
        if (y > top || y < end - w * 1.6) continue;
        const t = clamp((top - y) / (top - end), 0, 1), width = w * (1 - .45 * t);
        m = Math.max(m, clamp((width - Math.abs(x - cx)) / (width * .4 + .003), 0, 1) * (y >= end ? 1 : 0),
          clamp((w * 1.25 - Math.hypot(x - cx, y - end)) / (w * .5), 0, 1));
      }
      const n = fbm(x * 5, y * 5, 29);
      bloodColor(px, clamp((edge - r) / (edge * .6), 0, 1), n);
      px[3] = m * (.8 + .2 * n);
    });
  }

  // Vertex-coloured blobs: positions displaced by a hash of the (quantised) position, so the duplicated vertices of
  // non-indexed geometry move together and nothing cracks open.
  function jagged(THREE, geo, jag, squash, seed, color) {
    const p = geo.attributes.position, col = new Float32Array(p.count * 3), c = [0, 0, 0];
    for (let i = 0; i < p.count; i++) {
      let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const len = Math.hypot(x, y, z) || 1, h = hash2(Math.round(x * 997), Math.round(y * 991) + Math.round(z * 983) * 7, seed);
      const k = 1 + jag * (h * 2 - 1);
      color(x / len, y / len, z / len, h, c);
      x *= k; y *= k; z *= k * squash;
      p.setXYZ(i, x, y, z);
      col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.deleteAttribute('normal'); geo.computeVertexNormals();
    return geo;
  }
  const lerp3 = (out, a, b, t) => { out[0] = a[0] + (b[0] - a[0]) * t; out[1] = a[1] + (b[1] - a[1]) * t; out[2] = a[2] + (b[2] - a[2]) * t; };
  const HOLE = [.012, 0, 0], RAW = [.3, .012, .01], MEAT = [.52, .075, .055], BONE = [.74, .66, .55], MARROW = [.2, .008, .006];
  // Wounds are darker than the chunks: wet, half-clotted, mostly in shadow inside the hole.
  const BRUISE = [.04, .005, .008], SMEAR = [.06, .002, .002], W_RAW = [.09, .004, .003], W_MEAT = [.17, .018, .013];
  // A wound facing +z, in units of its size: a crater (rings of [radius, height, colour stop], each ring torn by angle so
  // the rim is ragged) sunk into a dark hole, and a run of blood down its -y side whose end dips into the skin, so on a
  // flat face it fades out and on a rounded one it follows the body round. wound() turns -y to face down the body.
  function crater(THREE, rings, seg, seed, tear, lift, color, run) {
    const pos = [], col = [], idx = [], c = [0, 0, 0];
    for (let j = 0; j < rings.length; j++) {
      const [r, z] = rings[j];
      for (let i = 0; i < seg; i++) {
        const a = i / seg * Math.PI * 2, h = hash2(i, j, seed), torn = hash2(i, 0, seed + 1);
        const rr = r * (1 + tear * (torn - .5) + .12 * (h - .5)), zz = z + lift * (j > 0 && j < rings.length - 1 ? (h - .35) * r : 0);
        pos.push(rr * Math.cos(a), rr * Math.sin(a), zz);
        color(j, h, torn, c); col.push(c[0], c[1], c[2]);
      }
    }
    for (let j = 0; j < rings.length - 1; j++) for (let i = 0; i < seg; i++) {
      const a = j * seg + i, b = j * seg + (i + 1) % seg, cc = (j + 1) * seg + i, d = (j + 1) * seg + (i + 1) % seg;
      idx.push(a, cc, d, a, d, b);
    }
    // The run: three columns (the middle one wetter and raised) wandering down -y, then a bead where it stops.
    const [start, len, width] = run, base = pos.length / 3, n = 9;
    for (let k = 0; k <= n; k++) {
      const t = k / n, y = -start - len * t, x = .09 * Math.sin(t * 4.5 + seed) * t, w = width * (1 - .55 * t);
      const z = .035 - (t > .6 ? (t - .6) / .4 * .16 : 0);
      for (let s = -1; s <= 1; s++) {
        pos.push(x + s * w, y, z + (s ? 0 : .025));
        lerp3(c, SMEAR, RAW, s ? .1 : .35 * (1 - t)); col.push(c[0], c[1], c[2]);
      }
      if (k) for (let s = 0; s < 2; s++) {
        const p0 = base + (k - 1) * 3 + s, p1 = p0 + 1, q0 = p0 + 3, q1 = q0 + 1;
        idx.push(p0, p1, q1, p0, q1, q0);
      }
    }
    const tip = base + n * 3 + 1, bead = pos.length / 3, by = pos[tip * 3 + 1] - width * .3, bx = pos[tip * 3], br = width * .9;
    pos.push(bx, by, .05); lerp3(c, SMEAR, RAW, .3); col.push(c[0], c[1], c[2]);
    for (let i = 0; i < 6; i++) {
      const a = i / 6 * Math.PI * 2;
      pos.push(bx + br * Math.cos(a), by + br * 1.2 * Math.sin(a), -.03); col.push(SMEAR[0], SMEAR[1], SMEAR[2]);
    }
    for (let i = 0; i < 6; i++) idx.push(bead, bead + 1 + i, bead + 1 + (i + 1) % 6);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx); geo.computeVertexNormals();
    return geo;
  }
  // Entry: a small dark hole, a lip of raw flesh, a bruised ring, smeared blood, a thin run.
  function entryGeometry(THREE) {
    const rings = [[0, -.32], [.16, -.22], [.27, .02], [.38, .1], [.55, .05], [.8, .03], [1, -.01]];
    return crater(THREE, rings, 14, 3, .3, .12, (j, h, torn, c) => {
      if (j < 2) lerp3(c, HOLE, MARROW, .4 * j * h);
      else if (j < 4) lerp3(c, W_RAW, W_MEAT, .25 * h + .1 * (j - 2));
      else if (j < 5) lerp3(c, BRUISE, W_RAW, .35 * h);
      else lerp3(c, SMEAR, THICK, .5 * h);
    }, [.55, 2.1, .2]);
  }
  // Exit: a wide ragged blowout, flaps of meat torn outward with flecks of bone, a heavier run.
  function exitGeometry(THREE) {
    const rings = [[0, -.22], [.2, -.12], [.32, .06], [.48, .24], [.62, .14], [.8, .06], [1.05, -.01]];
    return crater(THREE, rings, 16, 7, .55, .5, (j, h, torn, c) => {
      if (j < 2) lerp3(c, HOLE, MARROW, .6 * h);
      else if (j < 5 && h > .82) lerp3(c, BONE, W_MEAT, .3 * torn);
      else if (j < 5) lerp3(c, W_RAW, W_MEAT, .55 * h + .2 * torn);
      else lerp3(c, SMEAR, W_RAW, .25 * h);
    }, [.7, 1.8, .26]);
  }
  // A torn stump facing +z: bone in the middle, marrow, raw meat, a ragged rim of skin.
  function stumpGeometry(THREE) {
    const prof = [[0, .55], [.13, .52], [.2, .4], [.27, .3], [.45, .34], [.7, .28], [.92, .24], [1.06, .05], [1, -.45]];
    const g = new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), 14);
    g.rotateX(Math.PI / 2);
    const p = g.attributes.position, col = new Float32Array(p.count * 3), c = [0, 0, 0];
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i), r = Math.hypot(x, y), h = hash2(Math.round(x * 911), Math.round(y * 919), 5);
      if (r < .22) lerp3(c, BONE, MEAT, .1 * h);
      else if (r < .3) lerp3(c, MARROW, RAW, h);
      else if (r < .95) lerp3(c, MEAT, RAW, .7 * h);
      else lerp3(c, RAW, [.16, .02, .02], .5);
      // Ragged rim: the skin edge is torn to different lengths.
      if (r > .85 && z > -.1) p.setZ(i, z + (h - .5) * .35);
      col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    return g;
  }
  function chunkGeometry(THREE) {
    return jagged(THREE, new THREE.IcosahedronGeometry(1, 0), .32, .8, 13, (x, y, z, h, c) => {
      const k = .75 + .25 * h; c[0] = k; c[1] = .72 * k; c[2] = .68 * k;
    });
  }

  function create(options) {
    const o = options && typeof options === 'object' ? options : NOOP, THREE = o.THREE, scene = o.scene;
    if (!THREE || !scene || typeof scene.add !== 'function') throw new TypeError('HollowGore needs THREE and a scene');
    const blocks = typeof o.blocks === 'function' ? o.blocks : null, random = typeof o.random === 'function' ? o.random : Math.random;
    const floorY = finite(o.floorY, 0), ceiling = finite(o.ceiling, Infinity);
    // A mulberry32 stream seeded once from `random` (Math.random by default): inlined in the per-frame paths, where calls
    // through a callback would box every double they return.
    const RS = new Int32Array(1);
    RS[0] = Math.floor(clamp(finite(random(), .5), 0, 1) * 4294967295) | 0;
    function rand() {
      const s0 = RS[0] = (RS[0] + 0x6d2b79f5) | 0;
      let t = Math.imul(s0 ^ (s0 >>> 15), 1 | s0);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    const rnd = (a, b) => a + (b - a) * rand();
    let quality = Object.prototype.hasOwnProperty.call(QUALITY, o.quality) ? o.quality : 'high', effects = o.effects !== false, disposed = false;
    let scale = 1;
    const cap = { wounds: 0, perMonster: 0, splats: 0, walls: 0, pools: 0, chunks: 0, drops: 0, limbs: 0, fountains: 0 };
    function caps() {
      scale = QUALITY[quality] * (effects ? 1 : .5);
      for (const k in cap) cap[k] = Math.max(k === 'limbs' || k === 'fountains' ? 1 : 2, Math.round(MAX[k] * (k === 'perMonster' ? Math.sqrt(scale) : scale)));
    }
    caps();

    /* ---------- meshes ---------- */
    const owned = [];   // geometries, materials, textures disposed with the module
    const keep = x => { owned.push(x); return x; };
    function instanced(geo, mat, count, name, dynamic) {
      const mesh = new THREE.InstancedMesh(keep(geo), mat, count);
      mesh.name = 'gore:' + name; mesh.count = 0; mesh.visible = false; mesh.frustumCulled = false;
      mesh.castShadow = false; mesh.receiveShadow = false; mesh.matrixAutoUpdate = false;
      if (dynamic && mesh.instanceMatrix.setUsage && THREE.DynamicDrawUsage) mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.setColorAt(0, new THREE.Color(1, 1, 1));
      scene.add(mesh);
      return mesh;
    }
    const fleshMat = keep(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .3, metalness: 0 }));
    const chunkMat = keep(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .42, metalness: 0, flatShading: true }));
    const dropMat = keep(new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(.22, .004, .004), roughness: .18, metalness: 0 }));
    const decal = map => keep(new THREE.MeshBasicMaterial({ map: keep(map), transparent: true, depthWrite: false, blending: THREE.MultiplyBlending,
      premultipliedAlpha: true, side: THREE.DoubleSide, fog: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, toneMapped: false }));
    const plane = new THREE.PlaneGeometry(1, 1);
    const woundMesh = [instanced(entryGeometry(THREE), fleshMat, MAX.wounds, 'entry', true),
      instanced(exitGeometry(THREE), fleshMat, MAX.wounds, 'exit', true), instanced(stumpGeometry(THREE), fleshMat, MAX.stumps, 'stumps', true)];
    const floorMesh = instanced(plane, decal(floorTexture(THREE)), MAX.splats, 'splats', false);
    const wallMesh = instanced(plane.clone(), decal(wallTexture(THREE)), MAX.walls, 'walls', false);
    const poolMesh = instanced(plane.clone(), decal(poolTexture(THREE)), MAX.pools, 'pools', true);
    const chunkMesh = instanced(chunkGeometry(THREE), chunkMat, MAX.chunks, 'chunks', true);
    const dropMesh = instanced(new THREE.OctahedronGeometry(1, 0), dropMat, MAX.drops, 'drops', true);
    for (const m of [floorMesh, wallMesh, poolMesh]) m.renderOrder = 2;
    const meshes = [...woundMesh, floorMesh, wallMesh, poolMesh, chunkMesh, dropMesh];

    /* ---------- scratch (no allocation after create) ---------- */
    const M = new THREE.Matrix4(), M2 = new THREE.Matrix4(), V = new THREE.Vector3(), V2 = new THREE.Vector3(), V3 = new THREE.Vector3();
    const Q = new THREE.Quaternion(), Q2 = new THREE.Quaternion(), E = new THREE.Euler(), S = new THREE.Vector3();
    const Z = new THREE.Vector3(0, 0, 1);
    function put(mesh, i, m) { const a = mesh.instanceMatrix.array, e = m.elements, k = i * 16; for (let j = 0; j < 16; j++) a[k + j] = e[j]; }
    function tint(mesh, i, r, g, b) { const a = mesh.instanceColor.array, k = i * 3; a[k] = r; a[k + 1] = g; a[k + 2] = b; }
    function shown(obj) { for (let p = obj; p; p = p.parent) { if (!p.visible) return false; if (p === scene) return true; } return false; }

    /* ---------- owners (creatures) ---------- */
    const owners = new Map(), ownerList = [];
    function ownerOf(owner, rootObj) {
      let rec = owners.get(owner);
      if (!rec) { rec = { owner, root: rootObj || null, slots: [], stumps: 0, hidden: [], bleed: 0, timer: 0, limbs: [] }; owners.set(owner, rec); ownerList.push(rec); }
      if (rootObj) rec.root = rootObj;
      return rec;
    }

    /* ---------- wounds ---------- */
    const SLOTS = MAX.wounds + MAX.stumps;
    const slots = Array.from({ length: SLOTS }, () => ({ active: false, kind: 0, joint: null, owner: null, local: new THREE.Matrix4(), stamp: 0, r: 1, g: 1, b: 1 }));
    let stamp = 0;
    function freeSlot(s) {
      if (!s.active) return;
      s.active = false;
      const rec = owners.get(s.owner);
      if (rec) { const i = rec.slots.indexOf(s); if (i >= 0) rec.slots.splice(i, 1); if (s.kind === STUMP) rec.stumps--; }
      s.joint = null; s.owner = null;
    }
    function takeSlot(rec, kind) {
      // Per creature: its oldest wound gives way. Overall: the oldest anywhere.
      if (kind !== STUMP && rec.slots.length - rec.stumps >= cap.perMonster) {
        for (const s of rec.slots) if (s.kind !== STUMP) { freeSlot(s); break; }
      }
      let live = 0, stumps = 0, free = null, oldest = null;
      for (const s of slots) {
        if (!s.active) { if (!free) free = s; continue; }
        if (s.kind === STUMP) stumps++; else { live++; if (!oldest || s.stamp < oldest.stamp) oldest = s; }
      }
      if (kind === STUMP && stumps >= MAX.stumps) return null;
      if (kind !== STUMP && live >= cap.wounds && oldest) { freeSlot(oldest); free = oldest; }
      return free;
    }
    // The joint a mesh moves with: the mesh itself unless it is scaled, else its nearest unscaled ancestor.
    function jointOf(object, rootObj) {
      let j = object;
      while (j && j !== rootObj && j.isMesh) j = j.parent;
      return j || rootObj || object;
    }
    // A wound at world `point` facing `normal` on `object` (a mesh or joint of creature `owner`, whose group is `root`).
    function wound(owner, w) {
      if (disposed || !w || !w.object || !w.point) return false;
      const rootObj = w.root || null, rec = ownerOf(owner, rootObj), kind = w.kind === 'exit' ? EXIT : w.kind === 'stump' ? STUMP : ENTRY;
      const s = takeSlot(rec, kind);
      if (!s) return false;
      if (rootObj) rootObj.updateMatrixWorld(true); else w.object.updateMatrixWorld(true);
      const joint = w.joint || jointOf(w.object, rootObj);
      const nx = finite(w.normal && w.normal.x, 0), ny = finite(w.normal && w.normal.y, 0), nz = finite(w.normal && w.normal.z, 1);
      V.set(nx, ny, nz); if (V.lengthSq() < 1e-8) V.set(0, 0, 1); V.normalize();
      const size = clamp(finite(w.size, .06), .015, .5), lift = kind === STUMP ? 0 : kind === EXIT ? size * .12 : size * .05;
      Q.setFromUnitVectors(Z, V);
      // The run (-y) points down the body: world down laid into the wound's plane (any way on a face that looks up).
      V3.set(V.x * V.y, V.y * V.y - 1, V.z * V.y);
      let spin = rnd(0, Math.PI * 2);
      if (kind !== STUMP && V3.lengthSq() > .04) { Q2.copy(Q).invert(); V3.applyQuaternion(Q2); spin = Math.atan2(V3.x, -V3.y) + rnd(-.3, .3); }
      Q2.setFromAxisAngle(Z, spin); Q.multiply(Q2);
      V2.set(w.point.x + V.x * lift, w.point.y + V.y * lift, w.point.z + V.z * lift);
      S.set(size * rnd(.85, 1.15), size * rnd(.85, 1.15), size);
      M.compose(V2, Q, S);
      M2.copy(joint.matrixWorld).invert();
      s.local.multiplyMatrices(M2, M);
      s.active = true; s.kind = kind; s.joint = joint; s.owner = owner; s.stamp = ++stamp;
      const shade = kind === ENTRY ? rnd(.8, 1.1) : rnd(.9, 1.2);
      s.r = shade; s.g = shade * rnd(.85, 1.1); s.b = shade * rnd(.85, 1.1);
      rec.slots.push(s); if (kind === STUMP) rec.stumps++;
      return true;
    }

    /* ---------- decals ---------- */
    let floorHead = 0, floorCount = 0, wallHead = 0, wallCount = 0, poolHead = 0, poolCount = 0, decalSerial = 0;
    let floorDirty = false, wallDirty = false;
    // Helpers on the per-frame path take their numbers through these scratch arrays: double arguments to calls V8 does
    // not inline are boxed. FS: x z size angle stretch dark. WS: x y z nx nz size. EM: x y z vx vy vz size splat walls.
    const FS = new Float64Array(6), WS = new Float64Array(6), EM = new Float64Array(9);
    // A floor decal (the plane turned face up, yawed by `angle`): FL = x y z angle width depth, written into instance i.
    const FL = new Float64Array(6);
    function flat(mesh, i) {
      const a = mesh.instanceMatrix.array, k = i * 16, c = Math.cos(FL[3]), s2 = Math.sin(FL[3]), w = FL[4], d = FL[5];
      a[k] = c * w; a[k + 1] = 0; a[k + 2] = -s2 * w; a[k + 3] = 0;
      a[k + 4] = -s2 * d; a[k + 5] = 0; a[k + 6] = -c * d; a[k + 7] = 0;
      a[k + 8] = 0; a[k + 9] = 1; a[k + 10] = 0; a[k + 11] = 0;
      a[k + 12] = FL[0]; a[k + 13] = FL[1]; a[k + 14] = FL[2]; a[k + 15] = 1;
    }
    function floorSplatNow() {
      const size = FS[2];
      if (disposed || !(size > 0)) return;
      const i = floorHead % cap.splats; floorHead = (i + 1) % cap.splats; floorCount = Math.min(cap.splats, floorCount + 1);
      FL[0] = FS[0]; FL[1] = floorY + .005 + (decalSerial++ % 9) * .0007; FL[2] = FS[1]; FL[3] = FS[3]; FL[4] = size * FS[4]; FL[5] = size;
      flat(floorMesh, i);
      const k = Math.min(1.4, Math.max(.55, FS[5])), a = floorMesh.instanceColor.array;
      a[i * 3] = k; a[i * 3 + 1] = k; a[i * 3 + 2] = k;
      floorDirty = true;
    }
    function floorSplat(x, z, size, angle, stretch, dark) {
      FS[0] = finite(x, 0); FS[1] = finite(z, 0); FS[2] = finite(size, 0); FS[3] = finite(angle, 0); FS[4] = finite(stretch, 1); FS[5] = finite(dark, 1);
      floorSplatNow();
    }
    const recentWall = new Float64Array(12); let recentHead = 0;
    function wallSplat(x, y, z, nx, nz, size) {
      WS[0] = finite(x, 0); WS[1] = finite(y, 1); WS[2] = finite(z, 0); WS[3] = finite(nx, 0); WS[4] = finite(nz, 1); WS[5] = finite(size, 0);
      wallSplatNow();
    }
    function wallSplatNow() {
      const x = WS[0], y = WS[1], z = WS[2], nx = WS[3], nz = WS[4], size = WS[5];
      if (disposed || !(size > 0)) return;
      // Spray lands as a cluster: drops within 12 cm of a stain from the last few add to it instead.
      for (let k = 0; k < 12; k += 3) {
        const dx = recentWall[k] - x, dy = recentWall[k + 1] - y, dz = recentWall[k + 2] - z;
        if (dx * dx + dy * dy + dz * dz < .0144) return;
      }
      recentWall[recentHead] = x; recentWall[recentHead + 1] = y; recentWall[recentHead + 2] = z; recentHead = (recentHead + 3) % 12;
      const i = wallHead % cap.walls; wallHead = (i + 1) % cap.walls; wallCount = Math.min(cap.walls, wallCount + 1);
      // The plane yawed to face along (nx, nz), rolled a little about its normal.
      const off = .006 + (decalSerial++ % 7) * .0008, roll = (rand() - .5) * .4, cr = Math.cos(roll), sr = Math.sin(roll);
      // Mirrored at random and stretched a little, so neighbouring stains are not the same stamp.
      const w = size * (rand() < .5 ? -1.3 : 1.3) * (.85 + .3 * rand()), h = size * 1.75 * (.85 + .3 * rand()), m = wallMesh.instanceMatrix.array, mk = i * 16;
      // right = (nz, 0, -nx), up = (0, 1, 0), normal = (nx, 0, nz)
      m[mk] = nz * cr * w; m[mk + 1] = sr * w; m[mk + 2] = -nx * cr * w; m[mk + 3] = 0;
      m[mk + 4] = -nz * sr * h; m[mk + 5] = cr * h; m[mk + 6] = nx * sr * h; m[mk + 7] = 0;
      m[mk + 8] = nx; m[mk + 9] = 0; m[mk + 10] = nz; m[mk + 11] = 0;
      m[mk + 12] = x + nx * off; m[mk + 13] = y; m[mk + 14] = z + nz * off; m[mk + 15] = 1;
      const k = .8 + .35 * rand(), a = wallMesh.instanceColor.array;
      a[i * 3] = k; a[i * 3 + 1] = k; a[i * 3 + 2] = k;
      wallDirty = true;
    }
    // Pools: [x, z, size, age, grow, yaw, active] per slot; pending pools wait for the body to land.
    const PK = 7, pools = new Float64Array(MAX.pools * PK);
    const pending = [];
    function pool(owner, rootObj, p) {
      if (disposed || !rootObj) return;
      p = p || NOOP;
      const local = p.local && typeof p.local === 'object' ? p.local : { x: 0, y: 1, z: 0 };
      if (pending.length >= 8) pending.shift();
      pending.push({ owner, root: rootObj, x: finite(local.x, 0), y: finite(local.y, 1), z: finite(local.z, 0), size: clamp(finite(p.size, .8), .2, 2),
        delay: Math.max(0, finite(p.delay, 1)), grow: clamp(finite(p.grow, 7), .5, 30) });
    }
    function startPool(x, z, size, grow) {
      const i = poolHead % cap.pools; poolHead = (i + 1) % cap.pools; poolCount = Math.min(cap.pools, poolCount + 1);
      const o2 = i * PK;
      pools[o2] = x; pools[o2 + 1] = z; pools[o2 + 2] = size; pools[o2 + 3] = 0; pools[o2 + 4] = grow; pools[o2 + 5] = rnd(0, 6.283); pools[o2 + 6] = 1;
      tint(poolMesh, i, 1, 1, 1);
    }

    /* ---------- drops ---------- */
    const drops = new Float64Array(MAX.drops * DK);
    let dropCount = 0;
    function emitDrop() {
      if (dropCount >= cap.drops) return;
      const k = dropCount++ * DK;
      for (let q = 0; q < 8; q++) drops[k + q] = EM[q];
      drops[k + 8] = 0; drops[k + 9] = 3; drops[k + 10] = EM[8]; drops[k + 11] = 0;
    }
    // A spray of blood along (dx, dy, dz): exit wounds and blasts. reach: metres the fastest drops carry.
    function spray(x, y, z, dx, dy, dz, p) {
      if (disposed) return 0;
      p = p || NOOP;
      const amount = clamp(finite(p.amount, 1), .1, 4), reach = clamp(finite(p.reach, 2), .3, 4), cone = clamp(finite(p.cone, .28), .02, 1.2);
      const l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l;
      const n = Math.max(2, Math.round((5 + 9 * amount) * scale));
      for (let i = 0; i < n; i++) {
        let ex = dx + rnd(-cone, cone), ey = dy + rnd(-cone, cone) + .12, ez = dz + rnd(-cone, cone);
        const el = Math.hypot(ex, ey, ez) || 1; ex /= el; ey /= el; ez /= el;
        const v = reach * rnd(.9, 2.3), big = i < Math.ceil(amount);
        EM[0] = x; EM[1] = y; EM[2] = z; EM[3] = ex * v; EM[4] = ey * v; EM[5] = ez * v;
        EM[6] = big ? rnd(.012, .02) : rnd(.006, .013); EM[7] = big ? rnd(.07, .14) * Math.sqrt(amount) : rnd(.03, .07); EM[8] = 1;
        emitDrop();
      }
      return n;
    }

    /* ---------- chunks ---------- */
    const chunks = new Float64Array(MAX.chunks * CK);
    let chunkHead = 0, chunkCount = 0, chunksDirty = false;
    function chunkBurst(x, y, z, dx, dy, dz, p) {
      if (disposed) return 0;
      p = p || NOOP;
      const n = Math.round(clamp(finite(p.count, 4), 0, 24) * scale), speed = clamp(finite(p.speed, 3), .2, 12), bone = clamp(finite(p.bone, .2), 0, 1);
      const sz = clamp(finite(p.size, 1), .3, 3), l = Math.hypot(dx, dy, dz) || 1;
      for (let i = 0; i < n; i++) {
        const k = (chunkHead % cap.chunks) * CK; chunkHead = (chunkHead + 1) % cap.chunks; chunkCount = Math.min(cap.chunks, chunkCount + 1);
        const isBone = rand() < bone, s = speed * rnd(.35, 1);
        chunks[k] = x + rnd(-.04, .04); chunks[k + 1] = y + rnd(-.04, .04); chunks[k + 2] = z + rnd(-.04, .04);
        chunks[k + 3] = dx / l * s + rnd(-.5, .5) * speed * .6; chunks[k + 4] = dy / l * s + rnd(.2, 1) * speed * .45 + 1; chunks[k + 5] = dz / l * s + rnd(-.5, .5) * speed * .6;
        Q.setFromEuler(E.set(rnd(0, 6.3), rnd(0, 6.3), rnd(0, 6.3), 'XYZ'));
        chunks[k + 6] = Q.x; chunks[k + 7] = Q.y; chunks[k + 8] = Q.z; chunks[k + 9] = Q.w;
        chunks[k + 10] = rnd(-16, 16); chunks[k + 11] = rnd(-16, 16); chunks[k + 12] = rnd(-16, 16);
        chunks[k + 13] = (isBone ? rnd(.01, .024) : rnd(.016, .042)) * sz; chunks[k + 14] = 0; chunks[k + 15] = 0;
        if (isBone) { chunks[k + 16] = 1.05; chunks[k + 17] = 1.02; chunks[k + 18] = .95; }
        else { const d = rnd(.45, 1); chunks[k + 16] = .62 * d; chunks[k + 17] = .07 * d; chunks[k + 18] = .055 * d; }
        chunks[k + 19] = 0;
      }
      chunksDirty = true;
      return n;
    }

    /* ---------- fountains (decapitations, torn shoulders) ---------- */
    // Per fountain in FN: t dur power acc, then the point and direction in the joint's frame.
    const FK = 10, FN = new Float64Array(MAX.fountains * FK);
    const fountains = Array.from({ length: MAX.fountains }, (_, i) => ({ active: false, joint: null, owner: null, i }));
    function fountain(owner, joint, point, dir, p) {
      if (disposed || !joint) return;
      p = p || NOOP;
      let f = null, oldest = null;
      for (let i = 0; i < cap.fountains; i++) { const c = fountains[i]; if (!c.active) { f = c; break; } if (!oldest || FN[c.i * FK] > FN[oldest.i * FK]) oldest = c; }
      f = f || oldest;
      joint.updateMatrixWorld(true);
      M2.copy(joint.matrixWorld).invert();
      const k = f.i * FK;
      V.copy(point).applyMatrix4(M2); FN[k + 4] = V.x; FN[k + 5] = V.y; FN[k + 6] = V.z;
      V.copy(dir).transformDirection(M2); FN[k + 7] = V.x; FN[k + 8] = V.y; FN[k + 9] = V.z;
      FN[k] = 0; FN[k + 1] = clamp(finite(p.duration, 2.6), .3, 6); FN[k + 2] = clamp(finite(p.power, 1), .1, 2); FN[k + 3] = 0;
      f.active = true; f.joint = joint; f.owner = owner;
    }

    /* ---------- severed limbs and jaws ---------- */
    // A severed limb is a rigid triangle of three particles (the torn end, the far end, the point furthest off the line
    // between them) under position-based dynamics; its sampled surface is what touches the floor. Per limb in LS:
    // positions 0-8, velocities 9-17, rest lengths 18-20 (01 02 12), the starting basis 21-29, the starting rotation and
    // scale (3x3, column-major) 30-38, previous positions 39-47, age 48.
    const LK = 49, LS = new Float64Array(MAX.limbs * LK), BS = new Float64Array(9);
    const limbs = Array.from({ length: MAX.limbs }, (_, i) => ({ active: false, obj: null, owner: null, sleep: false, landed: false, b: i * LK,
      settle: false, ground: 0, flat: new Float64Array(3), pts: new Float32Array(LIMB_POINTS * 3), np: 0 }));
    function removeLimb(l) {
      if (!l.active) return;
      l.active = false;
      if (l.obj && l.obj.parent) l.obj.parent.remove(l.obj);
      const rec = owners.get(l.owner);
      if (rec) { const i = rec.limbs.indexOf(l); if (i >= 0) rec.limbs.splice(i, 1); }
      // Wounds that rode on the limb go with it.
      for (const s of slots) if (s.active && s.joint && l.obj && isInside(s.joint, l.obj)) freeSlot(s);
      l.obj = null; l.owner = null;
    }
    function isInside(node, top) { for (let p = node; p; p = p.parent) if (p === top) return true; return false; }
    // Tears `joint` (an arm, a jaw) off creature `owner`: the joint is hidden, a copy sharing its geometry and materials
    // tumbles away along `dir` with `force`, the wounds on it go with it, and both torn ends get a stump.
    function sever(owner, rootObj, joint, p) {
      if (disposed || !joint || !joint.parent || joint.visible === false) return null;
      p = p || NOOP;
      const rec = ownerOf(owner, rootObj);
      if (rootObj) rootObj.updateMatrixWorld(true); else joint.updateMatrixWorld(true);
      let l = null, oldest = null;
      for (let i = 0; i < cap.limbs; i++) { const c = limbs[i]; if (!c.active) { l = c; break; } if (!oldest || LS[c.b + 48] > LS[oldest.b + 48]) oldest = c; }
      if (!l) { removeLimb(oldest); l = oldest; }
      // Copy the subtree (shared geometry and materials) and match nodes for the wound hand-over.
      const copy = joint.clone(true), map = new Map(), a = [], b = [];
      joint.traverse(n => a.push(n)); copy.traverse(n => b.push(n));
      for (let i = 0; i < a.length && i < b.length; i++) map.set(a[i], b[i]);
      copy.userData = {}; copy.name = 'gore:limb:' + (joint.name || '');
      joint.matrixWorld.decompose(copy.position, copy.quaternion, copy.scale);
      copy.visible = true;
      scene.add(copy); copy.updateMatrixWorld(true);
      // Its inner joints never move again, and its own matrix is written by stepLimbs().
      copy.traverse(n => { if (n !== copy) n.matrixAutoUpdate = false; });
      copy.matrixAutoUpdate = false;
      // Surface samples in the copy's frame, spread over its meshes: what it rests on.
      M2.copy(copy.matrixWorld).invert();
      const meshes2 = [];
      copy.traverse(n => { if (n.isMesh && n.geometry && n.geometry.attributes.position) meshes2.push(n); });
      let total = 0;
      for (const m of meshes2) total += m.geometry.attributes.position.count;
      l.np = 0;
      const add = v => { if (l.np < LIMB_POINTS) { l.pts[l.np * 3] = v.x; l.pts[l.np * 3 + 1] = v.y; l.pts[l.np * 3 + 2] = v.z; l.np++; } };
      for (const m of meshes2) {
        const pos = m.geometry.attributes.position;
        M.multiplyMatrices(M2, m.matrixWorld);
        for (const [dx, dy, dz] of DIRS) {
          let best = -Infinity;
          for (let i = 0; i < pos.count; i++) {
            V.fromBufferAttribute(pos, i).applyMatrix4(M);
            const d = V.x * dx + V.y * dy + V.z * dz;
            if (d > best) { best = d; V2.copy(V); }
          }
          add(V2);
        }
      }
      const spare = LIMB_POINTS - l.np;
      for (const m of meshes2) {
        const pos = m.geometry.attributes.position, take = Math.max(1, Math.round(spare * pos.count / Math.max(1, total)));
        M.multiplyMatrices(M2, m.matrixWorld);
        for (let i = 0; i < take; i++) add(V.fromBufferAttribute(pos, Math.floor(i * pos.count / take)).applyMatrix4(M));
      }
      // The far end: the joint's furthest descendant (plus a hand's length), giving the rod the limb tumbles as.
      const origin = V3.setFromMatrixPosition(joint.matrixWorld);
      let far = 0;
      V2.copy(origin);
      joint.traverse(n => { V.setFromMatrixPosition(n.matrixWorld); const d = V.distanceTo(origin); if (d > far) { far = d; V2.copy(V); } });
      if (far < .05) { V.set(0, -.3, 0).applyQuaternion(copy.quaternion); V2.copy(origin).add(V); far = .3; }
      V2.sub(origin).multiplyScalar(1.25).add(origin);
      const o2 = l.b, L = origin.distanceTo(V2), radius = clamp(finite(p.radius, L * .1), .025, .12);
      const dir = V2.clone().sub(origin).normalize();
      // The third particle: the surface sample furthest off the line (an elbow), or a point just beside a straight limb.
      const e = copy.matrixWorld.elements, P3 = new THREE.Vector3();
      let off = 0;
      for (let i = 0; i < l.np * 3; i += 3) {
        V.set(l.pts[i], l.pts[i + 1], l.pts[i + 2]).applyMatrix4(copy.matrixWorld).sub(origin);
        const along = V.dot(dir), dd = V.addScaledVector(dir, -along).length();
        if (dd > off) { off = dd; P3.set(l.pts[i], l.pts[i + 1], l.pts[i + 2]).applyMatrix4(copy.matrixWorld); }
      }
      if (off < .04) {
        V.set(0, 1, 0).cross(dir); if (V.lengthSq() < 1e-4) V.set(1, 0, 0).cross(dir);
        P3.copy(origin).lerp(V2, .5).addScaledVector(V.normalize(), .06);
      }
      const P = [origin, V2, P3];
      for (let k = 0; k < 3; k++) { LS[o2 + 3 * k] = P[k].x; LS[o2 + 3 * k + 1] = P[k].y; LS[o2 + 3 * k + 2] = P[k].z; }
      LS[o2 + 18] = origin.distanceTo(V2); LS[o2 + 19] = origin.distanceTo(P3); LS[o2 + 20] = V2.distanceTo(P3);
      basis(o2);
      for (let k = 0; k < 9; k++) LS[o2 + 21 + k] = BS[k];
      for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) LS[o2 + 30 + 3 * c + r] = e[4 * c + r];
      const force = clamp(finite(p.force, 1), 0, 3), d = p.dir || NOOP, dl = Math.hypot(finite(d.x, 0), finite(d.z, 0)) || 1;
      const sx = finite(d.x, 0) / dl, sz = finite(d.z, 0) / dl, push = .9 + 1.1 * force, kick = 1.5 * (.5 + .5 * force);
      LS[o2 + 9] = sx * push * .7 + rnd(-.3, .3); LS[o2 + 10] = 1.2 + rnd(0, 1.2) * force; LS[o2 + 11] = sz * push * .7 + rnd(-.3, .3);
      LS[o2 + 12] = sx * push * 1.25 + rnd(-.6, .6); LS[o2 + 13] = .6 + rnd(0, 1.5) * force; LS[o2 + 14] = sz * push * 1.25 + rnd(-.6, .6);
      for (let k = 0; k < 3; k++) LS[o2 + 15 + k] = .5 * (LS[o2 + 9 + k] + LS[o2 + 12 + k]) + rnd(-kick, kick);
      LS[o2 + 48] = 0;
      flatAxis(l);
      l.settle = false; l.ground = 0; l.sleep = false; l.landed = false; l.active = true; l.obj = copy; l.owner = owner; rec.limbs.push(l);
      compose(l); copy.updateMatrixWorld();
      // Hand the wounds over, then hide the original.
      for (const s of rec.slots) if (s.active && map.has(s.joint)) s.joint = map.get(s.joint);
      joint.visible = false; rec.hidden.push(joint);
      // Stumps: on the body where the joint was, facing down the limb; on the limb's torn end, facing back.
      const stumpSize = clamp(finite(p.stump, radius * 1.7), .04, .3), torn = origin.clone();
      wound(owner, { root: rootObj, object: joint.parent, joint: joint.parent, point: torn, normal: dir, kind: 'stump', size: stumpSize });
      wound(owner, { root: copy, object: copy, joint: copy, point: torn, normal: dir.clone().negate(), kind: 'stump', size: stumpSize * .9 });
      return copy;
    }
    // Destroys the head of creature `owner`: hidden, a stump on the neck, chunks of flesh and skull, a spray and a
    // pulsing fountain from the neck.
    function decapitate(owner, rootObj, head, p) {
      if (disposed || !head || !head.parent || head.visible === false) return false;
      p = p || NOOP;
      const rec = ownerOf(owner, rootObj), neck = head.parent;
      if (rootObj) rootObj.updateMatrixWorld(true); else head.updateMatrixWorld(true);
      // The head's centre and size from its meshes, and the neck's axis where the head sat.
      const box = new THREE.Box3().setFromObject(head, true), centre = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
      const radius = clamp(Math.min(size.x, size.y, size.z) * .5, .05, .4);
      const pivot = new THREE.Vector3().setFromMatrixPosition(head.matrixWorld);
      const up = centre.clone().sub(pivot);
      if (up.lengthSq() < 1e-4) up.set(0, 1, 0).transformDirection(head.matrixWorld);
      up.normalize();
      head.visible = false; rec.hidden.push(head);
      for (const s of rec.slots) if (s.active && isInside(s.joint, head)) freeSlot(s);
      wound(owner, { root: rootObj, object: neck, joint: neck, point: pivot, normal: up, kind: 'stump', size: clamp(radius * .62, .05, .2) });
      const d = p.dir || NOOP, force = clamp(finite(p.force, 1.5), 0, 3);
      const dx = finite(d.x, 0), dy = finite(d.y, 0), dz = finite(d.z, 0);
      chunkBurst(centre.x, centre.y, centre.z, dx + up.x * .6, dy + up.y * .6, dz + up.z * .6, { count: finite(p.chunks, 10), speed: 2.4 + 1.6 * force, bone: .38, size: Math.min(1.15, radius / .14) });
      spray(centre.x, centre.y, centre.z, dx + up.x * .4, dy + up.y * .4 + .2, dz + up.z * .4, { amount: 2.4 + force, reach: 1.6 + .6 * force, cone: .6 });
      fountain(owner, neck, pivot, up, { duration: 2.8, power: 1.2 });
      return true;
    }

    /* ---------- bleeding ---------- */
    function bleed(owner, rootObj, amount) {
      if (disposed) return;
      const rec = ownerOf(owner, rootObj);
      rec.bleed = clamp(rec.bleed + clamp(finite(amount, .3), 0, 2), 0, 1.6);
    }

    /* ---------- clearing ---------- */
    function clearOwner(rec) {
      for (let i = rec.slots.length - 1; i >= 0; i--) freeSlot(rec.slots[i]);
      for (let i = rec.limbs.length - 1; i >= 0; i--) removeLimb(rec.limbs[i]);
      for (const j of rec.hidden) j.visible = true;
      rec.hidden.length = 0; rec.bleed = 0; rec.timer = 0; rec.stumps = 0;
      for (const f of fountains) if (f.active && f.owner === rec.owner) { f.active = false; f.joint = null; f.owner = null; }
      for (let i = pending.length - 1; i >= 0; i--) if (pending[i].owner === rec.owner) pending.splice(i, 1);
    }
    // clear(owner): that creature's wounds, limbs, stumps, fountains and pending pool (its head and arms come back).
    // clear(): everything, the floors too.
    function clear(owner) {
      if (owner !== undefined && owner !== null) {
        const rec = owners.get(owner);
        if (rec) { clearOwner(rec); owners.delete(owner); ownerList.splice(ownerList.indexOf(rec), 1); }
        return;
      }
      for (const rec of ownerList) clearOwner(rec);
      owners.clear(); ownerList.length = 0;
      for (const s of slots) { s.active = false; s.joint = null; s.owner = null; }
      for (const l of limbs) removeLimb(l);
      for (const f of fountains) { f.active = false; f.joint = null; f.owner = null; }
      pending.length = 0; pools.fill(0);
      floorHead = floorCount = wallHead = wallCount = poolHead = poolCount = dropCount = chunkHead = chunkCount = 0;
      recentWall.fill(1e9);
      for (const m of meshes) { m.count = 0; m.visible = false; }
    }
    recentWall.fill(1e9);

    /* ---------- per frame ---------- */
    let frameWounds = 0;
    // Lowest sample of a limb's surface (sampled at sever time, in its own frame) into LO: world y, x, z.
    const LO = new Float64Array(3);
    function lowestOf(l) {
      const e = l.obj.matrixWorld.elements, P = l.pts;
      let lo = Infinity, at = 0;
      for (let i = 0; i < l.np * 3; i += 3) {
        const y = e[1] * P[i] + e[5] * P[i + 1] + e[9] * P[i + 2] + e[13];
        if (y < lo) { lo = y; at = i; }
      }
      LO[0] = lo; LO[1] = e[0] * P[at] + e[4] * P[at + 1] + e[8] * P[at + 2] + e[12]; LO[2] = e[2] * P[at] + e[6] * P[at + 1] + e[10] * P[at + 2] + e[14];
    }
    // The limb's thinnest direction in its own frame (the sampled surface's axis of least spread), into l.flat.
    function flatAxis(l) {
      const P = l.pts, n = l.np;
      let mx = 0, my = 0, mz = 0;
      for (let i = 0; i < n * 3; i += 3) { mx += P[i] / n; my += P[i + 1] / n; mz += P[i + 2] / n; }
      let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
      for (let i = 0; i < n * 3; i += 3) {
        const x = P[i] - mx, y = P[i + 1] - my, z = P[i + 2] - mz;
        xx += x * x; xy += x * y; xz += x * z; yy += y * y; yz += y * z; zz += z * z;
      }
      // Power iteration on (trace - C): its dominant eigenvector is C's smallest.
      const tr = xx + yy + zz;
      let vx = .577, vy = .577, vz = .577;
      for (let it = 0; it < 40; it++) {
        const ux = (tr - xx) * vx - xy * vy - xz * vz, uy = -xy * vx + (tr - yy) * vy - yz * vz, uz = -xz * vx - yz * vy + (tr - zz) * vz;
        const ul = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
        vx = ux / ul; vy = uy / ul; vz = uz / ul;
      }
      l.flat[0] = vx; l.flat[1] = vy; l.flat[2] = vz;
    }
    // Orthonormal basis of a limb's particle triangle into BS: along 0 -> 1, then toward 2, then their cross product.
    function basis(o) {
      let x1 = LS[o + 3] - LS[o], y1 = LS[o + 4] - LS[o + 1], z1 = LS[o + 5] - LS[o + 2];
      const l1 = Math.sqrt(x1 * x1 + y1 * y1 + z1 * z1) || 1e-9;
      x1 /= l1; y1 /= l1; z1 /= l1;
      let x2 = LS[o + 6] - LS[o], y2 = LS[o + 7] - LS[o + 1], z2 = LS[o + 8] - LS[o + 2];
      const d = x2 * x1 + y2 * y1 + z2 * z1;
      x2 -= d * x1; y2 -= d * y1; z2 -= d * z1;
      const l2 = Math.sqrt(x2 * x2 + y2 * y2 + z2 * z2) || 1e-9;
      x2 /= l2; y2 /= l2; z2 /= l2;
      BS[0] = x1; BS[1] = y1; BS[2] = z1; BS[3] = x2; BS[4] = y2; BS[5] = z2;
      BS[6] = y1 * z2 - z1 * y2; BS[7] = z1 * x2 - x1 * z2; BS[8] = x1 * y2 - y1 * x2;
    }
    // The limb's matrix (and world matrix: gore lives in world space): the starting rotation carried from the starting
    // basis to the current one, at the torn end.
    function compose(l) {
      const o = l.b, m = l.obj.matrix.elements, e = l.obj.matrixWorld.elements;
      basis(o);
      for (let c = 0; c < 3; c++) {
        const vx = LS[o + 30 + 3 * c], vy = LS[o + 31 + 3 * c], vz = LS[o + 32 + 3 * c];
        const a0 = LS[o + 21] * vx + LS[o + 22] * vy + LS[o + 23] * vz, a1 = LS[o + 24] * vx + LS[o + 25] * vy + LS[o + 26] * vz;
        const a2 = LS[o + 27] * vx + LS[o + 28] * vy + LS[o + 29] * vz;
        m[4 * c] = e[4 * c] = a0 * BS[0] + a1 * BS[3] + a2 * BS[6];
        m[4 * c + 1] = e[4 * c + 1] = a0 * BS[1] + a1 * BS[4] + a2 * BS[7];
        m[4 * c + 2] = e[4 * c + 2] = a0 * BS[2] + a1 * BS[5] + a2 * BS[8];
        m[4 * c + 3] = e[4 * c + 3] = 0;
      }
      m[12] = e[12] = LS[o]; m[13] = e[13] = LS[o + 1]; m[14] = e[14] = LS[o + 2]; m[15] = e[15] = 1;
      l.obj.matrixWorldNeedsUpdate = true;
    }
    // Restores the triangle's three edge lengths, moving both ends of each edge equally.
    function rigid(o) {
      for (let pass = 0; pass < 2; pass++) {
        for (let edge = 0; edge < 3; edge++) {
          const i = o + (edge === 2 ? 3 : 0), j = o + (edge === 0 ? 3 : 6), rest = LS[o + 18 + edge];
          const dx = LS[j] - LS[i], dy = LS[j + 1] - LS[i + 1], dz = LS[j + 2] - LS[i + 2];
          const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-9, c = (len - rest) / len * .5;
          LS[i] += dx * c; LS[i + 1] += dy * c; LS[i + 2] += dz * c; LS[j] -= dx * c; LS[j + 1] -= dy * c; LS[j + 2] -= dz * c;
        }
      }
    }
    function stepLimbs() {
      const dt = DT[0];
      for (let n = 0; n < MAX.limbs; n++) {
        const l = limbs[n];
        if (!l.active) continue;
        const o = l.b;
        LS[o + 48] += dt;
        if (l.sleep || dt <= 0) continue;
        if (l.settle) { settleLimb(l, dt); continue; }
        let fall = 0;
        for (let k = 0; k < 9; k += 3) {
          const p = o + k, v = o + 9 + k, q = o + 39 + k;
          LS[q] = LS[p]; LS[q + 1] = LS[p + 1]; LS[q + 2] = LS[p + 2];
          LS[v + 1] -= GRAVITY * dt;
          if (LS[v + 1] < fall) fall = LS[v + 1];
          LS[p] += LS[v] * dt; LS[p + 1] += LS[v + 1] * dt; LS[p + 2] += LS[v + 2] * dt;
          if (LS[p + 1] > ceiling - .05) { LS[p + 1] = ceiling - .05; if (LS[v + 1] > 0) LS[v + 1] *= -.2; }
          if (blocks && LS[p + 1] > floorY + .05 && LS[p + 1] < ceiling - .1 && blocks(LS[p], LS[p + 1], LS[p + 2])) {
            const bx = blocks(LS[p], LS[p + 1], LS[q + 2]), bz = blocks(LS[q], LS[p + 1], LS[p + 2]);
            if (bx || !bz) LS[p] = LS[q];
            if (bz || !bx) LS[p + 2] = LS[q + 2];
          }
        }
        // The lowest point of the surface is pushed back up through the particles nearest it.
        let grounded = false;
        for (let it = 0; it < 4; it++) {
          rigid(o); compose(l); lowestOf(l);
          const lift = floorY - LO[0];
          if (!(lift > 0)) continue;
          grounded = true;
          let w0 = 0, w1 = 0, w2 = 0;
          for (let k = 0; k < 3; k++) {
            const dx = LS[o + 3 * k] - LO[1], dz = LS[o + 3 * k + 2] - LO[2], w = 1 / (Math.sqrt(dx * dx + dz * dz) + .05);
            if (k === 0) w0 = w; else if (k === 1) w1 = w; else w2 = w;
          }
          const sum = w0 + w1 + w2;
          w0 /= sum; w1 /= sum; w2 /= sum;
          const nn = w0 * w0 + w1 * w1 + w2 * w2;
          LS[o + 1] += lift * w0 / nn; LS[o + 4] += lift * w1 / nn; LS[o + 7] += lift * w2 / nn;
        }
        rigid(o); compose(l);
        // Velocities from where the particles ended up; friction on the floor.
        const f = grounded ? Math.exp(-6 * dt) : 1;
        let energy = 0;
        for (let k = 0; k < 9; k += 3) {
          const p = o + k, v = o + 9 + k, q = o + 39 + k;
          LS[v] = (LS[p] - LS[q]) / dt * f; LS[v + 1] = (LS[p + 1] - LS[q + 1]) / dt; LS[v + 2] = (LS[p + 2] - LS[q + 2]) / dt * f;
          energy += LS[v] * LS[v] + LS[v + 1] * LS[v + 1] + LS[v + 2] * LS[v + 2];
        }
        if (grounded && fall < -1.2 && !l.landed) {
          l.landed = true; FS[0] = LO[1]; FS[1] = LO[2]; FS[2] = .12 + .1 * rand(); FS[3] = 6.3 * rand(); FS[4] = 1.3; FS[5] = 1;
          floorSplatNow();
        }
        if (grounded) l.ground += dt;
        // Once it has nearly stopped (or rocked about for a while) it settles onto its flattest side.
        if (grounded && (energy < .05 || l.ground > 1.2)) l.settle = true;
        l.obj.updateMatrixWorld();
      }
    }
    // Rolls a settling limb about its centre until its thinnest axis is vertical, keeping its lowest point on the floor.
    function settleLimb(l, dt) {
      const o = l.b, e = l.obj.matrixWorld.elements, fx = l.flat[0], fy = l.flat[1], fz = l.flat[2];
      let nx = e[0] * fx + e[4] * fy + e[8] * fz, ny = e[1] * fx + e[5] * fy + e[9] * fz, nz = e[2] * fx + e[6] * fy + e[10] * fz;
      const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      const sg = ny >= 0 ? 1 : -1, ax = -nz * sg, az = nx * sg, sn = Math.sqrt(ax * ax + az * az), angle = Math.atan2(sn, Math.abs(ny));
      if (angle > .01 && sn > 1e-6) {
        const step = Math.min(angle, 5 * dt), kx = ax / sn, kz = az / sn, c = Math.cos(step), s2 = Math.sin(step);
        const cx = (LS[o] + LS[o + 3] + LS[o + 6]) / 3, cy = (LS[o + 1] + LS[o + 4] + LS[o + 7]) / 3, cz = (LS[o + 2] + LS[o + 5] + LS[o + 8]) / 3;
        for (let k = 0; k < 9; k += 3) {
          // Rodrigues about (kx, 0, kz) through the centre.
          const px = LS[o + k] - cx, py = LS[o + k + 1] - cy, pz = LS[o + k + 2] - cz, dot = kx * px + kz * pz;
          const crx = -kz * py, cry = kz * px - kx * pz, crz = kx * py;
          LS[o + k] = cx + px * c + crx * s2 + kx * dot * (1 - c);
          LS[o + k + 1] = cy + py * c + cry * s2;
          LS[o + k + 2] = cz + pz * c + crz * s2 + kz * dot * (1 - c);
        }
      }
      compose(l); lowestOf(l);
      const drop = Math.max(floorY - LO[0], -2 * dt);
      for (let k = 1; k < 9; k += 3) LS[o + k] += drop;
      compose(l);
      if (angle <= .01 && Math.abs(drop) < 1e-4) {
        l.sleep = true;
        l.obj.matrix.decompose(l.obj.position, l.obj.quaternion, l.obj.scale);
      }
      l.obj.updateMatrixWorld();
    }
    function stepWounds() {
      for (const rec of ownerList) if (rec.slots.length && rec.root && shown(rec.root)) rec.root.updateMatrixWorld(true);
      let n0 = 0, n1 = 0, n2 = 0;
      for (const s of slots) {
        if (!s.active || !shown(s.joint)) continue;
        M.multiplyMatrices(s.joint.matrixWorld, s.local);
        const mesh = woundMesh[s.kind], i = s.kind === ENTRY ? n0++ : s.kind === EXIT ? n1++ : n2++;
        put(mesh, i, M); tint(mesh, i, s.r, s.g, s.b);
      }
      frameWounds = n0 + n1 + n2;
      for (let k = 0; k < 3; k++) {
        const mesh = woundMesh[k], n = k === ENTRY ? n0 : k === EXIT ? n1 : n2;
        mesh.count = n; mesh.visible = n > 0;
        if (n) { mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor.needsUpdate = true; }
      }
    }
    function stepFountains() {
      const dt = DT[0];
      for (let n = 0; n < MAX.fountains; n++) {
        const f = fountains[n];
        if (!f.active) continue;
        const k = n * FK, dur = FN[k + 1], power = FN[k + 2];
        const t = FN[k] += dt;
        if (t >= dur) { f.active = false; f.joint = null; f.owner = null; continue; }
        if (!shown(f.joint)) continue;
        // Arterial pulses (about two a second) that weaken as the heart stops.
        const beat = Math.max(0, Math.sin(Math.PI * 2 * 2.1 * t)), env = Math.exp(-t / (dur * .45)) * (.35 + .65 * beat * beat);
        FN[k + 3] += dt * 70 * power * env * scale;
        if (FN[k + 3] < 1) continue;
        const e = f.joint.matrixWorld.elements, lx = FN[k + 4], ly = FN[k + 5], lz = FN[k + 6], ax = FN[k + 7], ay = FN[k + 8], az = FN[k + 9];
        const px = e[0] * lx + e[4] * ly + e[8] * lz + e[12], py = e[1] * lx + e[5] * ly + e[9] * lz + e[13], pz = e[2] * lx + e[6] * ly + e[10] * lz + e[14];
        // A body sinking into the earth (the Gravekeeper's grave) stops spurting once the stump is under it.
        if (py < floorY) { FN[k + 3] = 0; continue; }
        let dx = e[0] * ax + e[4] * ay + e[8] * az, dy = e[1] * ax + e[5] * ay + e[9] * az, dz = e[2] * ax + e[6] * ay + e[10] * az;
        const dl = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1; dx /= dl; dy /= dl; dz /= dl;
        const v0 = (1.4 + 2.6 * beat) * power * (1 - .5 * t / dur);
        while (FN[k + 3] >= 1) {
          FN[k + 3] -= 1;
          const v = v0 * (.6 + .5 * rand());
          EM[0] = px; EM[1] = py; EM[2] = pz;
          EM[3] = (dx + (rand() - .5) * .6) * v; EM[4] = (dy + (rand() - .5) * .6) * v; EM[5] = (dz + (rand() - .5) * .6) * v;
          EM[6] = .006 + .006 * rand(); EM[7] = .035 + .045 * rand(); EM[8] = 0;
          emitDrop();
        }
      }
    }
    function stepBleeding() {
      const dt = DT[0];
      for (const rec of ownerList) {
        if (rec.bleed <= .02) continue;
        rec.bleed *= Math.exp(-dt / 7);
        if (!rec.root || !shown(rec.root) || !rec.slots.length) continue;
        rec.timer -= dt;
        if (rec.timer > 0) continue;
        rec.timer = (.12 + .28 * rand()) / Math.max(.2, rec.bleed) / Math.max(.5, scale);
        const s = rec.slots[Math.floor(rand() * rec.slots.length) % rec.slots.length];
        if (!s || !shown(s.joint)) continue;
        M.multiplyMatrices(s.joint.matrixWorld, s.local);
        if (M.elements[13] < floorY) continue;
        EM[0] = M.elements[12]; EM[1] = M.elements[13]; EM[2] = M.elements[14];
        EM[3] = (rand() - .5) * .3; EM[4] = -.4 * rand(); EM[5] = (rand() - .5) * .3;
        EM[6] = .005 + .004 * rand(); EM[7] = (.025 + .025 * rand()) * (.7 + .4 * rec.bleed); EM[8] = 0;
        emitDrop();
      }
    }
    function stepDrops() {
      const dt = DT[0];
      let n = 0;
      const a = dropMesh.instanceMatrix.array;
      for (let i = 0; i < dropCount;) {
        const k = i * DK;
        drops[k + 8] += dt;
        let dead = drops[k + 8] >= drops[k + 9];
        if (!dead && dt > 0) {
          const px = drops[k], pz = drops[k + 2], drag = Math.exp(-.35 * dt);
          drops[k + 4] -= GRAVITY * dt; drops[k + 3] *= drag; drops[k + 5] *= drag;
          drops[k] += drops[k + 3] * dt; drops[k + 1] += drops[k + 4] * dt; drops[k + 2] += drops[k + 5] * dt;
          const x = drops[k], z = drops[k + 2], y = drops[k + 1], yy = Math.max(y, floorY + .015);
          if (y >= ceiling) dead = true;
          else if (drops[k + 10] > 0 && blocks && blocks(x, yy, z)) {
            // Which way the wall faces: the axis whose step alone runs into it.
            const bx = blocks(x, yy, pz), bz = blocks(px, yy, z);
            if (bx || bz) {
              // The splat goes on the wall's face: bisect the blocked axis between the last free step and this one.
              const nx = bx && !bz ? (drops[k + 3] > 0 ? -1 : 1) : 0, nz = nx ? 0 : (drops[k + 5] > 0 ? -1 : 1);
              let lo = nx ? px : pz, hi = nx ? x : z;
              for (let it = 0; it < 6; it++) { const mid = (lo + hi) * .5; if (nx ? blocks(mid, yy, z) : blocks(x, yy, mid)) hi = mid; else lo = mid; }
              WS[0] = nx ? lo : x; WS[1] = yy; WS[2] = nz ? lo : z; WS[3] = nx; WS[4] = nz; WS[5] = drops[k + 7] * 1.8;
              wallSplatNow();
            }
            dead = true;
          } else if (y <= floorY + .004) {
            const vx = drops[k + 3], vz = drops[k + 5], h = Math.sqrt(vx * vx + vz * vz);
            FS[0] = x; FS[1] = z; FS[2] = drops[k + 7]; FS[3] = h > .08 ? Math.atan2(-vz, vx) : 6.3 * rand(); FS[4] = 1 + Math.min(1.2, h * .3); FS[5] = .8 + .4 * rand();
            floorSplatNow();
            dead = true;
          }
        }
        if (dead) {
          dropCount--;
          if (i !== dropCount) { const j = dropCount * DK; for (let q = 0; q < DK; q++) drops[k + q] = drops[j + q]; }
          continue;
        }
        // Stretched along the velocity.
        const vx = drops[k + 3], vy = drops[k + 4], vz = drops[k + 5], sp = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1e-6;
        const zx = vx / sp, zy = vy / sp, zz = vz / sp, s = drops[k + 6], st = s * (1 + Math.min(3, sp * .45));
        let xx = zz, xy = 0, xz = -zx;                         // up x z, with up = +y
        let xl = Math.sqrt(xx * xx + xz * xz);
        if (xl < 1e-4) { xx = 1; xz = 0; xl = 1; }
        xx /= xl; xz /= xl;
        const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx, o = n * 16;
        a[o] = xx * s; a[o + 1] = xy * s; a[o + 2] = xz * s; a[o + 3] = 0;
        a[o + 4] = yx * s; a[o + 5] = yy * s; a[o + 6] = yz * s; a[o + 7] = 0;
        a[o + 8] = zx * st; a[o + 9] = zy * st; a[o + 10] = zz * st; a[o + 11] = 0;
        a[o + 12] = drops[k]; a[o + 13] = drops[k + 1]; a[o + 14] = drops[k + 2]; a[o + 15] = 1;
        n++; i++;
      }
      dropMesh.count = n; dropMesh.visible = n > 0;
      if (n) dropMesh.instanceMatrix.needsUpdate = true;
    }
    function stepChunks() {
      const dt = DT[0];
      if (!chunkCount) { chunkMesh.count = 0; chunkMesh.visible = false; return; }
      let moved = chunksDirty;
      const a = chunkMesh.instanceMatrix.array, ca = chunkMesh.instanceColor.array;
      for (let i = 0; i < chunkCount; i++) {
        const k = i * CK;
        if (chunks[k + 14] < 1 && dt > 0) {
          moved = true;
          const s = chunks[k + 13], px = chunks[k], pz = chunks[k + 2];
          chunks[k + 19] += dt;
          chunks[k + 4] -= GRAVITY * dt;
          chunks[k] += chunks[k + 3] * dt; chunks[k + 1] += chunks[k + 4] * dt; chunks[k + 2] += chunks[k + 5] * dt;
          // The ceiling knocks it back down.
          if (chunks[k + 1] > ceiling - s) { chunks[k + 1] = ceiling - s; if (chunks[k + 4] > 0) chunks[k + 4] *= -.3; }
          if (blocks && chunks[k + 1] > floorY + s && chunks[k + 1] < ceiling - s * 1.5 && blocks(chunks[k], chunks[k + 1], chunks[k + 2])) {
            const bx = blocks(chunks[k], chunks[k + 1], pz), bz = blocks(px, chunks[k + 1], chunks[k + 2]);
            if (bx || !bz) { chunks[k] = px; chunks[k + 3] *= -.3; }
            if (bz || !bx) { chunks[k + 2] = pz; chunks[k + 5] *= -.3; }
          }
          if (chunks[k + 1] < floorY + s * .55) {
            chunks[k + 1] = floorY + s * .55;
            if (!chunks[k + 15] && chunks[k + 4] < -1) {
              chunks[k + 15] = 1; FS[0] = chunks[k]; FS[1] = chunks[k + 2]; FS[2] = s * (2.2 + 1.2 * rand()); FS[3] = 6.3 * rand(); FS[4] = 1; FS[5] = .9 + .3 * rand();
              floorSplatNow();
            }
            chunks[k + 4] = chunks[k + 4] < -1 ? -chunks[k + 4] * .2 : 0;
            const f = Math.exp(-10 * dt); chunks[k + 3] *= f; chunks[k + 5] *= f;
            chunks[k + 10] *= f; chunks[k + 11] *= f; chunks[k + 12] *= f;
            if (chunks[k + 3] * chunks[k + 3] + chunks[k + 4] * chunks[k + 4] + chunks[k + 5] * chunks[k + 5] < .01 || chunks[k + 19] > 6) chunks[k + 14] = 1;
          }
          // q += 0.5 * (w, 0) * q * dt
          const wx = chunks[k + 10], wy = chunks[k + 11], wz = chunks[k + 12];
          let qx = chunks[k + 6], qy = chunks[k + 7], qz = chunks[k + 8], qw = chunks[k + 9];
          const h = .5 * dt;
          const nx = qx + h * (wx * qw + wy * qz - wz * qy), ny = qy + h * (wy * qw + wz * qx - wx * qz);
          const nz = qz + h * (wz * qw + wx * qy - wy * qx), nw = qw - h * (wx * qx + wy * qy + wz * qz);
          const ql = Math.sqrt(nx * nx + ny * ny + nz * nz + nw * nw) || 1;
          qx = nx / ql; qy = ny / ql; qz = nz / ql; qw = nw / ql;
          chunks[k + 6] = qx; chunks[k + 7] = qy; chunks[k + 8] = qz; chunks[k + 9] = qw;
        }
        if (!moved) continue;
        const s = chunks[k + 13], qx = chunks[k + 6], qy = chunks[k + 7], qz = chunks[k + 8], qw = chunks[k + 9], o = i * 16;
        const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz, xx = qx * x2, xy = qx * y2, xz = qx * z2, yy = qy * y2, yz = qy * z2, zz = qz * z2;
        const wx = qw * x2, wy = qw * y2, wz = qw * z2;
        a[o] = (1 - (yy + zz)) * s; a[o + 1] = (xy + wz) * s; a[o + 2] = (xz - wy) * s; a[o + 3] = 0;
        a[o + 4] = (xy - wz) * s; a[o + 5] = (1 - (xx + zz)) * s; a[o + 6] = (yz + wx) * s; a[o + 7] = 0;
        a[o + 8] = (xz + wy) * s; a[o + 9] = (yz - wx) * s; a[o + 10] = (1 - (xx + yy)) * s; a[o + 11] = 0;
        a[o + 12] = chunks[k]; a[o + 13] = chunks[k + 1]; a[o + 14] = chunks[k + 2]; a[o + 15] = 1;
        ca[i * 3] = chunks[k + 16]; ca[i * 3 + 1] = chunks[k + 17]; ca[i * 3 + 2] = chunks[k + 18];
      }
      chunkMesh.count = chunkCount; chunkMesh.visible = true;
      if (moved) { chunkMesh.instanceMatrix.needsUpdate = true; chunkMesh.instanceColor.needsUpdate = true; }
      chunksDirty = false;
    }
    function stepPools() {
      const dt = DT[0];
      for (let i = pending.length - 1; i >= 0; i--) {
        const p = pending[i];
        p.delay -= dt;
        if (p.delay > 0) continue;
        pending.splice(i, 1);
        p.root.updateWorldMatrix(true, false);
        V.set(p.x, p.y, p.z).applyMatrix4(p.root.matrixWorld);
        startPool(V.x, V.z, p.size, p.grow);
      }
      let grew = false;
      for (let i = 0; i < poolCount; i++) {
        const k = i * PK;
        if (!pools[k + 6]) continue;
        if (pools[k + 3] < pools[k + 4] || pools[k + 6] === 1) {
          pools[k + 3] = Math.min(pools[k + 4], pools[k + 3] + dt);
          const u = pools[k + 3] / pools[k + 4], r = pools[k + 2] * (.12 + .88 * (1 - Math.pow(1 - u, 2.2)));
          FL[0] = pools[k]; FL[1] = floorY + .0035 + (i % 5) * .0004; FL[2] = pools[k + 1]; FL[3] = pools[k + 5]; FL[4] = r * 1.15; FL[5] = r;
          flat(poolMesh, i);
          pools[k + 6] = u >= 1 ? 2 : 1.5;
          grew = true;
        }
      }
      poolMesh.count = poolCount; poolMesh.visible = poolCount > 0;
      if (grew) { poolMesh.instanceMatrix.needsUpdate = true; poolMesh.instanceColor.needsUpdate = true; }
    }
    // dt: simulation seconds (frozen by hitstop, so blood hangs in the air with everything else).
    const DT = new Float64Array(1);
    function update(dt) {
      if (disposed) return;
      DT[0] = typeof dt === 'number' && dt > 0 ? Math.min(dt, .1) : 0;
      stepLimbs();
      stepWounds();
      stepFountains();
      stepBleeding();
      stepDrops();
      stepChunks();
      stepPools();
      floorMesh.count = floorCount; floorMesh.visible = floorCount > 0;
      wallMesh.count = wallCount; wallMesh.visible = wallCount > 0;
      if (floorDirty) { floorMesh.instanceMatrix.needsUpdate = true; floorMesh.instanceColor.needsUpdate = true; floorDirty = false; }
      if (wallDirty) { wallMesh.instanceMatrix.needsUpdate = true; wallMesh.instanceColor.needsUpdate = true; wallDirty = false; }
    }

    function setQuality(level) {
      if (!Object.prototype.hasOwnProperty.call(QUALITY, level) || level === quality) return;
      quality = level; recap();
    }
    function setEffects(on) { on = on !== false; if (on === effects) return; effects = on; recap(); }
    function recap() {
      caps();
      floorCount = Math.min(floorCount, cap.splats); floorHead %= cap.splats;
      wallCount = Math.min(wallCount, cap.walls); wallHead %= cap.walls;
      poolCount = Math.min(poolCount, cap.pools); poolHead %= cap.pools;
      chunkCount = Math.min(chunkCount, cap.chunks); chunkHead %= cap.chunks;
      dropCount = Math.min(dropCount, cap.drops);
      for (let i = cap.limbs; i < MAX.limbs; i++) removeLimb(limbs[i]);
      for (let i = cap.fountains; i < MAX.fountains; i++) { fountains[i].active = false; fountains[i].joint = null; }
      let live = 0;
      for (const s of slots) if (s.active && s.kind !== STUMP && ++live > cap.wounds) freeSlot(s);
      for (const rec of ownerList) while (rec.slots.length - rec.stumps > cap.perMonster) { const s = rec.slots.find(x => x.kind !== STUMP); if (!s) break; freeSlot(s); }
      chunksDirty = true;
    }

    function woundsOf(owner) { const rec = owners.get(owner); return rec ? rec.slots.length : 0; }
    function headless(owner) { const rec = owners.get(owner); return !!rec && rec.hidden.some(j => j.name === 'head'); }
    function severed(owner) { const rec = owners.get(owner); return rec ? rec.hidden.filter(j => j.name !== 'head').map(j => j.name) : []; }
    function snapshot() {
      let wounds = 0, stumps = 0, fountainsLive = 0, bleeding = 0, limbsLive = 0;
      for (const s of slots) if (s.active) { if (s.kind === STUMP) stumps++; else wounds++; }
      for (const f of fountains) if (f.active) fountainsLive++;
      for (const rec of ownerList) if (rec.bleed > .02) bleeding++;
      for (const l of limbs) if (l.active) limbsLive++;
      let drawCalls = 0;
      for (const m of meshes) if (m.visible && m.count > 0) drawCalls++;
      for (const l of limbs) if (l.active && l.obj) l.obj.traverse(n => { if (n.isMesh && n.visible) drawCalls++; });
      return { quality, effects, scale, wounds, stumps, rendered: frameWounds, splats: floorCount, walls: wallCount, pools: poolCount + pending.length,
        chunks: chunkCount, drops: dropCount, limbs: limbsLive, fountains: fountainsLive, bleeding, owners: ownerList.length, drawCalls,
        caps: { ...cap } };
    }
    function dispose() {
      if (disposed) return;
      clear();
      disposed = true;
      for (const m of meshes) { if (m.parent) m.parent.remove(m); if (typeof m.dispose === 'function') m.dispose(); }
      for (const x of owned) if (x && typeof x.dispose === 'function') x.dispose();
      owned.length = 0;
    }

    return Object.freeze({ wound, spray, splat: floorSplat, wallSplat, chunks: chunkBurst, sever, decapitate, fountain, bleed, pool, clear,
      update, setQuality, setEffects, snapshot, woundsOf, headless, severed, dispose, meshes: Object.freeze(meshes.slice()) });
  }

  return Object.freeze({ create, QUALITY, MAX });
});
