/* The Hollow / Blackwater Ward — self-contained procedural PBR assets.
 * No downloads, per-frame allocations, or per-creature lights. Units are metres.
 * Meshes are batched per material and joint; shared textures live for the session.
 */
(function (global) {
  'use strict';

  const stores = new WeakMap();
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function store(THREE) {
    if (!stores.has(THREE)) stores.set(THREE, {
      geometries: new Map(), materials: new Map(), maps: new Map(),
      environments: new WeakMap(), environmentTargets: new Set()
    });
    return stores.get(THREE);
  }

  function seeded(seed) {
    let v = seed >>> 0;
    return () => { v = (Math.imul(v, 1664525) + 1013904223) >>> 0; return v / 4294967296; };
  }

  function canvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return [c, c.getContext('2d', { willReadFrequently: true })];
  }

  function texture(THREE, c, color) {
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
    if (color) {
      if ('colorSpace' in t && THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace;
      else t.encoding = THREE.sRGBEncoding;
    }
    t.userData = Object.assign(t.userData || {}, { hollowShared: true });
    return t;
  }

  // Periodic multi-octave height field: adjacent tiles have matching edges.
  function field(size, seed) {
    const out = new Float32Array(size * size), random = seeded(seed);
    for (const [cells, amp] of [[4, 0.53], [12, 0.25], [40, 0.15], [96, 0.07]]) {
      const values = new Float32Array(cells * cells);
      for (let i = 0; i < values.length; i++) values[i] = random();
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const fx = x * cells / size, fy = y * cells / size;
        const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
        const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
        const a = values[iy * cells + ix], b = values[iy * cells + (ix + 1) % cells];
        const c = values[((iy + 1) % cells) * cells + ix];
        const d = values[((iy + 1) % cells) * cells + (ix + 1) % cells];
        out[y * size + x] += (a + (b - a) * sx + (c - a + (d - c - b + a) * sx) * sy) * amp;
      }
    }
    return out;
  }

  function materialMaps(THREE, requestedKind) {
    const allowed = ['wall', 'floor', 'metal', 'skin', 'fabric', 'concrete', 'wood'];
    const kind = allowed.includes(requestedKind) ? requestedKind : 'concrete';
    const cache = store(THREE).maps;
    if (cache.has(kind)) return cache.get(kind);
    const n = 256, random = seeded(811 + allowed.indexOf(kind) * 731), f = field(n, 197 + allowed.indexOf(kind));
    const [hc, hctx] = canvas(n, n), hdata = hctx.createImageData(n, n);
    for (let i = 0; i < f.length; i++) {
      let v = 115 + f[i] * (kind === 'metal' ? 18 : 58) + (random() - 0.5) * 10;
      if (kind === 'fabric') v += ((i % n) % 4 < 2 ? 4 : -4) + (Math.floor(i / n) % 4 < 2 ? 5 : -5);
      // Broad damp blisters and recessed grout, rather than uniform noisy bumps.
      if (kind === 'wall') v += clamp((f[i] - 0.55) * 180, 0, 24);
      if (kind === 'floor' && ((i % n) < 3 || Math.floor(i / n) < 3)) v -= 36;
      if (kind === 'wood') v += Math.sin((i % n) * 0.7 + f[i] * 11) * 9;
      hdata.data[i * 4] = hdata.data[i * 4 + 1] = hdata.data[i * 4 + 2] = v;
      hdata.data[i * 4 + 3] = 255;
    }
    hctx.putImageData(hdata, 0, 0);
    if (kind === 'metal') {
      hctx.lineWidth = 0.6;
      for (let i = 0; i < 160; i++) {
        hctx.strokeStyle = i % 4 ? 'rgba(75,75,75,.22)' : 'rgba(215,215,215,.25)';
        const x = random() * n, y = random() * n;
        hctx.beginPath(); hctx.moveTo(x, y); hctx.lineTo(x + random() * 3, y + 12 + random() * 100); hctx.stroke();
      }
    } else if (kind === 'floor') {
      hctx.fillStyle = '#4b4b4b'; hctx.fillRect(0, 0, n, 2); hctx.fillRect(0, 0, 2, n);
      hctx.fillStyle = '#a2a2a2'; hctx.fillRect(2, 2, n - 2, 1); hctx.fillRect(2, 2, 1, n - 2);
      // Worn hospital tile, not industrial diamond plate.
      hctx.strokeStyle = 'rgba(68,68,68,.38)'; hctx.lineWidth = 0.7;
      for (let i = 0; i < 9; i++) {
        const x = random() * n, y = random() * n;
        hctx.beginPath(); hctx.moveTo(x, y); hctx.lineTo(x + 14, y + 5); hctx.lineTo(x + 21, y + 19); hctx.stroke();
      }
    } else if (kind === 'wall' || kind === 'concrete') {
      hctx.strokeStyle = 'rgba(50,50,50,.35)'; hctx.lineWidth = 0.6;
      for (let i = 0; i < 4; i++) {
        let x = random() * n, y = random() * n;
        hctx.beginPath(); hctx.moveTo(x, y);
        for (let j = 0; j < 7; j++) { x += random() * 12 - 6; y += random() * 9; hctx.lineTo(x, y); }
        hctx.stroke();
      }
    } else if (kind === 'skin') {
      hctx.strokeStyle = 'rgba(65,65,65,.26)'; hctx.lineWidth = 1;
      for (let i = 0; i < 15; i++) {
        const x = random() * n, y = random() * n;
        hctx.beginPath(); hctx.moveTo(x, y); hctx.bezierCurveTo(x + 15, y + 8, x - 10, y + 26, x + 8, y + 55); hctx.stroke();
      }
    }
    const height = hctx.getImageData(0, 0, n, n).data;
    const [nc, nx] = canvas(n, n), [rc, rx] = canvas(n, n), [ac, ax] = canvas(n, n);
    const normal = nx.createImageData(n, n), rough = rx.createImageData(n, n), albedo = ax.createImageData(n, n);
    const roughBase = { metal: 182, skin: 235, wall: 245, concrete: 244, floor: 208, fabric: 250, wood: 224 }[kind];
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const i = y * n + x, p = i * 4;
      const hx = height[(y * n + (x + 1) % n) * 4] - height[(y * n + (x + n - 1) % n) * 4];
      const hy = height[(((y + 1) % n) * n + x) * 4] - height[(((y + n - 1) % n) * n + x) * 4];
      const dx = -hx * 0.021, dy = hy * 0.021, inv = 1 / Math.hypot(dx, dy, 1);
      normal.data[p] = (dx * inv * 0.5 + 0.5) * 255;
      normal.data[p + 1] = (dy * inv * 0.5 + 0.5) * 255;
      normal.data[p + 2] = (inv * 0.5 + 0.5) * 255; normal.data[p + 3] = 255;
      const damp = clamp((f[i] - 0.47) / 0.24, 0, 1);
      const wet = kind === 'floor' ? damp : kind === 'wall' ? damp * 0.35 : 0;
      const rv = clamp(roughBase + (f[i] - 0.5) * 70 + (random() - 0.5) * 9
        - wet * wet * (3 - wet * 2) * 166 + (kind === 'metal' ? Math.abs(height[p] - 123) * 0.28 : 0), 46, 255);
      rough.data[p] = rough.data[p + 1] = rough.data[p + 2] = rv; rough.data[p + 3] = 255;
      const stain = kind === 'fabric' ? damp * 69 : kind === 'wall' || kind === 'floor' ? damp * 48 : kind === 'metal' ? damp * 32 : 0;
      const av = clamp((kind === 'skin' ? 215 : 239) + (f[i] - 0.5) * (kind === 'skin' ? 95 : 43) + (height[p] - 140) * 0.18 - stain, 105, 254);
      albedo.data[p] = av;
      albedo.data[p + 1] = kind === 'skin' ? av * 0.97 : av - stain * 0.09;
      albedo.data[p + 2] = kind === 'skin' ? av * (0.96 + damp * 0.035) : av - stain * 0.23;
      albedo.data[p + 3] = 255;
    }
    nx.putImageData(normal, 0, 0); rx.putImageData(rough, 0, 0); ax.putImageData(albedo, 0, 0);
    const maps = { normal: texture(THREE, nc, false), roughness: texture(THREE, rc, false), albedo: texture(THREE, ac, true) };
    cache.set(kind, maps);
    return maps;
  }

  function enhanceMaterial(THREE, material, options) {
    if (!material || !material.isMeshStandardMaterial) return material;
    const opts = options || {}, kind = opts.kind || 'concrete', maps = materialMaps(THREE, kind);
    // All standard surface maps share the existing albedo's UV transform in r128.
    // Leave custom shader hooks untouched (including the world's burn transition).
    if (!material.normalMap || opts.replace) material.normalMap = maps.normal;
    if (!material.roughnessMap || opts.replace) material.roughnessMap = maps.roughness;
    const strength = opts.strength == null ? ({ wall: 0.3, floor: 0.4, metal: 0.22, skin: 0.18, fabric: 0.2, wood: 0.32 }[kind] || 0.36) : opts.strength;
    material.normalScale.set(strength, strength);
    material.needsUpdate = true;
    return material;
  }

  function standard(THREE, key, color, roughness, metalness, kind) {
    const cache = store(THREE).materials;
    if (!cache.has(key)) {
      const m = new THREE.MeshStandardMaterial({ color, roughness, metalness: metalness || 0 });
      // r128 predates automatic colour management: authored swatches are sRGB,
      // while physical BRDF/vertex colours need linear reflectance. Without this
      // a torch bleaches grey skin and oxidised steel almost completely white.
      if (!THREE.ColorManagement || !THREE.ColorManagement.enabled) m.color.convertSRGBToLinear();
      if (kind) { m.map = materialMaps(THREE, kind).albedo; enhanceMaterial(THREE, m, { kind }); }
      m.userData.hollowShared = true; m.userData.hollowSurface = kind; cache.set(key, m);
    }
    return cache.get(key);
  }

  function basic(THREE, key, color) {
    const cache = store(THREE).materials;
    if (!cache.has(key)) {
      const m = new THREE.MeshBasicMaterial({ color, toneMapped: false });
      m.userData.hollowShared = true; cache.set(key, m);
    }
    return cache.get(key);
  }

  function geometry(THREE, key, make) {
    const cache = store(THREE).geometries;
    if (!cache.has(key)) { const g = make(); g.userData.hollowShared = true; cache.set(key, g); }
    return cache.get(key);
  }

  function add(THREE, parent, geom, mat, x, y, z, sx, sy, sz, rx, ry, rz) {
    const m = new THREE.Mesh(geom, mat);
    m.position.set(x || 0, y || 0, z || 0);
    m.scale.set(sx == null ? 1 : sx, sy == null ? 1 : sy, sz == null ? 1 : sz);
    m.rotation.set(rx || 0, ry || 0, rz || 0);
    m.castShadow = true; m.receiveShadow = true; parent.add(m); return m;
  }

  function box(THREE, parent, mat, x, y, z, w, h, d, rx, ry, rz) {
    return add(THREE, parent, geometry(THREE, 'box', () => new THREE.BoxGeometry(1, 1, 1)), mat, x, y, z, w, h, d, rx, ry, rz);
  }

  function oval(THREE, parent, mat, x, y, z, w, h, d, rx, ry, rz) {
    const organic = mat.userData.hollowSurface === 'skin';
    const geom = geometry(THREE, organic ? 'organic' : 'sphere', () => {
      const sphere = new THREE.SphereGeometry(1, 12, 10);
      if (organic) {
        const pos = sphere.attributes.position;
        for (let i = 0; i < pos.count; i++) {
          const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
          const distortion = 1 + Math.sin(py * 9 + px * 3) * Math.sin(pz * 6 + py * 2) * 0.045;
          pos.setXYZ(i, px * distortion, py, pz * distortion);
        }
        sphere.computeVertexNormals();
      }
      return sphere;
    });
    return add(THREE, parent, geom, mat, x, y, z, w, h, d, rx, ry, rz);
  }

  // Off-centre cross sections, not scaled spheres: a collapsed cheek, shoulder or
  // knuckle keeps its broken silhouette even when animation replaces joint Euler angles.
  function anatomy(THREE, parent, mat, shape, x, y, z, w, h, d, rx, ry, rz) {
    const geom = geometry(THREE, 'creature:hull:' + shape, () => {
      // y, half-width, half-depth, lateral displacement, forward displacement.
      const profiles = {
        skull: [[-1, .36, .51, .06, .04], [-.46, .79, .78, -.06, 0], [.32, 1, .90, .03, -.06], [.80, .80, .82, -.12, -.16], [1, .38, .50, -.19, -.13]],
        shard: [[-1, .22, .26, .16, 0], [-.32, .87, .91, -.09, .11], [.49, 1, .65, .08, -.07], [1, .12, .24, -.13, .08]],
        chest: [[-1, .37, .67, .13, .13], [-.40, .64, .78, -.08, .04], [.30, 1, 1, -.10, -.10], [.78, .94, .88, .04, -.05], [1, .40, .72, .12, -.15]],
        hump: [[-1, .66, .63, .18, .05], [-.35, 1, .97, -.05, -.08], [.30, .89, 1, -.18, -.05], [.86, .51, .76, -.25, -.13], [1, .14, .31, -.31, -.11]],
        pelvis: [[-1, .51, .54, .20, .05], [-.50, .81, .66, .05, .15], [.25, 1, 1, -.09, -.03], [1, .64, .61, -.20, -.11]],
        palm: [[-1, .52, .64, .10, .12], [-.50, 1, .65, -.13, .04], [.52, .78, .81, .05, 0], [1, .49, .58, .14, -.10]]
      }[shape];
      const section = [[-.64, .82], [.31, 1], [.92, .42], [.82, -.55], [.30, -.90], [-.55, -.80], [-1, -.15], [-.91, .45]];
      const rings = profiles.map(([yy, ww, dd, xx, zz]) => section.map(([a, b]) => [xx + a * ww, yy, zz + b * dd]));
      const positions = [], uv = [];
      const face = (a, b, c, ta, tb, tc) => { positions.push(...a, ...b, ...c); uv.push(...ta, ...tb, ...tc); };
      for (let row = 0; row < rings.length - 1; row++) for (let j = 0; j < 8; j++) {
        // Leave the lower face physically open; sockets and a recessed mouth sit
        // inside this shell rather than being a smile painted over a round head.
        if (shape === 'skull' && row < 2 && (j === 0 || j === 1 || j === 7)) continue;
        const next = (j + 1) % 8, a = rings[row][j], b = rings[row][next], c = rings[row + 1][next], d0 = rings[row + 1][j];
        const ta = [j / 8, row / (rings.length - 1)], tb = [(j + 1) / 8, ta[1]];
        const tc = [tb[0], (row + 1) / (rings.length - 1)], td = [ta[0], tc[1]];
        face(a, b, c, ta, tb, tc); face(a, c, d0, ta, tc, td);
      }
      for (const row of [0, rings.length - 1]) {
        if (shape === 'skull' && row === 0) continue;
        const p = profiles[row], center = [p[3], p[0], p[4]];
        for (let j = 0; j < 8; j++) {
          const a = rings[row][j], b = rings[row][(j + 1) % 8];
          const ta = [a[0] * .5 + .5, a[2] * .5 + .5], tb = [b[0] * .5 + .5, b[2] * .5 + .5];
          if (row === 0) face(center, b, a, [.5, .5], tb, ta);
          else face(center, a, b, [.5, .5], ta, tb);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.computeVertexNormals(); return g;
    });
    return add(THREE, parent, geom, mat, x, y, z, w, h, d, rx, ry, rz);
  }

  function sinew(THREE, parent, mat, from, to, radius) {
    const a = new THREE.Vector3(...from), b = new THREE.Vector3(...to), delta = b.clone().sub(a);
    const geom = geometry(THREE, 'creature:taper', () => new THREE.CylinderGeometry(.55, 1, 1, 5, 1));
    const m = add(THREE, parent, geom, mat, (a.x + b.x) * .5, (a.y + b.y) * .5, (a.z + b.z) * .5, radius, delta.length(), radius);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize()); return m;
  }

  function cyl(THREE, parent, mat, x, y, z, top, bottom, len, rx, ry, rz, sides) {
    const count = sides || 10;
    const geom = geometry(THREE, 'cylinder:' + top + ':' + bottom + ':' + len + ':' + count,
      () => new THREE.CylinderGeometry(top, bottom, len, count));
    return add(THREE, parent, geom, mat, x, y, z, 1, 1, 1, rx, ry, rz);
  }

  function link(THREE, parent, mat, from, to, r1, r2) {
    const a = new THREE.Vector3(...from), b = new THREE.Vector3(...to), delta = b.clone().sub(a), len = delta.length();
    const m = cyl(THREE, parent, mat, (a.x + b.x) * 0.5, (a.y + b.y) * 0.5, (a.z + b.z) * 0.5, r2 || r1, r1, len);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
    return m;
  }

  function ring(THREE, parent, mat, x, y, z, radius, tube, rx, ry, rz, arc) {
    const a = arc || TAU;
    return add(THREE, parent, geometry(THREE, 'ring:' + radius + ':' + tube + ':' + a,
      () => new THREE.TorusGeometry(radius, tube, 5, 18, a)), mat, x, y, z, 1, 1, 1, rx, ry, rz);
  }

  function bevel(THREE, parent, mat, x, y, z, w, h, d, edge, rx, ry, rz) {
    const b = Math.min(edge || 0.006, w * 0.2, h * 0.2, d * 0.2);
    const key = 'bevel:' + [w, h, d, b].join(':');
    const geom = geometry(THREE, key, () => {
      const s = new THREE.Shape();
      s.moveTo(-w * 0.5 + b, -h * 0.5 + b); s.lineTo(w * 0.5 - b, -h * 0.5 + b);
      s.lineTo(w * 0.5 - b, h * 0.5 - b); s.lineTo(-w * 0.5 + b, h * 0.5 - b); s.closePath();
      const g = new THREE.ExtrudeGeometry(s, { depth: d - b * 2, bevelEnabled: true, bevelThickness: b, bevelSize: b, bevelSegments: 1, steps: 1, curveSegments: 1 });
      g.translate(0, 0, -d * 0.5 + b); return g;
    });
    return add(THREE, parent, geom, mat, x, y, z, 1, 1, 1, rx, ry, rz);
  }

  function joint(THREE, parent, name, x, y, z) {
    const g = new THREE.Group(); g.name = name; g.position.set(x, y, z); parent.add(g); return g;
  }

  // Static batching without requiring BufferGeometryUtils or another dependency.
  // Groups/animated joints remain intact. Invisible/dynamic meshes are not merged.
  function batch(THREE, root) {
    for (const child of root.children.slice()) if (child.isGroup) batch(THREE, child);
    const bins = new Map();
    for (const child of root.children) {
      if (!child.isMesh || !child.visible || child.userData.dynamic || Array.isArray(child.material)) continue;
      if (!bins.has(child.material)) bins.set(child.material, []);
      bins.get(child.material).push(child);
    }
    for (const [material, meshes] of bins) {
      if (meshes.length < 2) continue;
      const chunks = [], counts = { position: 0, normal: 0, uv: 0, color: 0 };
      for (const mesh of meshes) {
        mesh.updateMatrix();
        const g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
        g.applyMatrix4(mesh.matrix); chunks.push(g);
        for (const key of Object.keys(counts)) if (g.attributes[key]) counts[key] += g.attributes[key].array.length;
      }
      const merged = new THREE.BufferGeometry();
      for (const key of ['position', 'normal', 'uv', 'color']) {
        if (chunks.some(g => !g.attributes[key])) continue;
        const values = new Float32Array(counts[key]); let offset = 0;
        for (const g of chunks) { values.set(g.attributes[key].array, offset); offset += g.attributes[key].array.length; }
        merged.setAttribute(key, new THREE.BufferAttribute(values, key === 'uv' ? 2 : 3));
      }
      merged.computeBoundingSphere();
      const m = new THREE.Mesh(merged, material);
      m.castShadow = meshes.some(o => o.castShadow); m.receiveShadow = meshes.some(o => o.receiveShadow);
      root.add(m);
      for (const mesh of meshes) {
        root.remove(mesh);
        if (!mesh.geometry.userData.hollowShared) mesh.geometry.dispose();
      }
      for (const g of chunks) g.dispose();
    }
    return root;
  }

  function consolidateOrganicMaterials(THREE, root, palette) {
    const material = standard(THREE, 'creature:organic-batch', 0xffffff, 0.91, 0, 'skin');
    material.vertexColors = true; material.flatShading = true;
    // Garment folds/wrap seams are geometry; vertex tinting keeps even dressed
    // articulated limbs at one draw per joint without a material-array draw penalty.
    material.side = THREE.DoubleSide;
    const mergeable = new Set([palette.skin, palette.bone, palette.dark, palette.tendon, palette.cloth, palette.bandage]);
    root.traverse(o => {
      if (!o.isMesh || !mergeable.has(o.material)) return;
      const geom = o.geometry.clone(), color = o.material.color;
      // r128 aliases userData when cloning; never relabel the cached source as owned.
      geom.userData = Object.assign({}, geom.userData, { hollowShared: false });
      const values = new Float32Array(geom.attributes.position.count * 3);
      for (let i = 0; i < values.length; i += 3) {
        values[i] = color.r; values[i + 1] = color.g; values[i + 2] = color.b;
      }
      geom.setAttribute('color', new THREE.BufferAttribute(values, 3));
      o.geometry = geom; o.material = material;
    });
  }

  function flattenStatic(THREE, root) {
    root.updateMatrixWorld(true);
    const inverse = root.matrixWorld.clone().invert(), meshes = [];
    root.traverse(o => { if (o.isMesh) meshes.push(o); });
    for (const mesh of meshes) {
      const transform = new THREE.Matrix4().multiplyMatrices(inverse, mesh.matrixWorld);
      root.add(mesh); transform.decompose(mesh.position, mesh.quaternion, mesh.scale);
    }
    for (const child of root.children.slice()) if (child.isGroup) root.remove(child);
  }

  function monsterPalette(THREE, kind) {
    const colors = {
      warden: { skin: 0x666c63, bone: 0x96917d, cloth: 0x363c36, eyes: 0x292b28 },
      stalker: { skin: 0x858b7d, bone: 0xa3a08a, cloth: 0x4b554d, eyes: 0x30322e },
      crawler: { skin: 0x666e68, bone: 0x8b9282, cloth: 0x3e4945, eyes: 0x272c29 },
      shrieker: { skin: 0x97988b, bone: 0xaaa28d, cloth: 0x62665b, eyes: 0x343530 }
    }[kind];
    return {
      skin: standard(THREE, kind + ':skin', colors.skin, 0.87, 0, 'skin'),
      bone: standard(THREE, kind + ':bone', colors.bone, 0.72, 0, 'skin'),
      cloth: standard(THREE, kind + ':gown', colors.cloth, 0.98, 0, 'fabric'),
      bandage: standard(THREE, 'creature:bandage', 0x817c67, 0.98, 0, 'fabric'),
      dark: standard(THREE, 'creature:dark', 0x090b0a, 1, 0, 'skin'),
      tendon: standard(THREE, 'creature:tendon', 0x514742, 0.94, 0, 'skin'),
      // Instance-owned for death/respawn writes; dry, recessed slits, not bright beads.
      eye: new THREE.MeshStandardMaterial({ color: colors.eyes, roughness: 0.92, metalness: 0, fog: true })
    };
  }

  function teeth(THREE, parent, mat, y, z, width, count, down, x) {
    for (let i = 0; i < count; i++) {
      if (i === 2 && count > 4) continue;
      box(THREE, parent, mat, (x || 0) + (i / Math.max(1, count - 1) - .5) * width,
        y + (down ? -1 : 1) * (i % 3) * .004, z + (i % 2) * .004,
        .010, .014 + (i % 3) * .004, .012, .12, 0, (i % 2 ? 1 : -1) * .17);
    }
  }

  // Unit cloth panel: shared topology, real pleats, a sagging seam and torn hem.
  // Scale at the call site so room dimensions never grow the geometry cache.
  function drape(THREE, parent, mat, x, y, z, w, h, depth, ry, rz) {
    const geom = geometry(THREE, 'ward:drape', () => {
      const g = new THREE.PlaneGeometry(1, 1, 24, 8), pos = g.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const px = pos.getX(i), py = pos.getY(i), bottom = 0.5 - py;
        pos.setXYZ(i, px, py - Math.sin((px + 0.5) * Math.PI) * 0.035
          + (py < -0.49 ? Math.sin(px * 83) * 0.025 : 0),
        Math.sin((px + 0.5) * TAU * 6) * (0.65 + bottom * 0.35) + bottom * bottom * 0.25);
      }
      g.computeVertexNormals(); return g;
    });
    return add(THREE, parent, geom, mat, x, y, z, w, h, depth, 0, ry || 0, rz || 0);
  }

  function wraps(THREE, parent, mat, x, y, z, radius, count) {
    const geom = geometry(THREE, 'creature:wrap', () => new THREE.CylinderGeometry(1, .98, 1, 6, 1, true));
    for (let i = 0; i < count; i++) add(THREE, parent, geom, mat, x, y - i * .032, z,
      radius, .029, radius * 1.10, .03, 0, i % 2 ? .08 : -.06);
  }

  function rag(THREE, parent, mat, x, y, z, w, h, depth, rx, ry, rz) {
    const geom = geometry(THREE, 'creature:rag', () => {
      const g = new THREE.PlaneGeometry(1, 1, 8, 4), pos = g.attributes.position;
      const hem = [.05, .28, -.02, .14, .48, .06, .24, -.03, .19];
      for (let i = 0; i < pos.count; i++) {
        const px = pos.getX(i), py = pos.getY(i), t = .5 - py;
        pos.setXYZ(i, px + Math.sin(i * 1.7) * t * .028, py - t * t * t * hem[i % 9],
          Math.sin(px * 31) * .65 + t * t * .35);
      }
      const indices = [];
      for (let row = 0; row < 4; row++) for (let col = 0; col < 8; col++) {
        if (row === 3 && (col === 1 || col === 4 || col === 6)) continue;
        const a = row * 9 + col, b = a + 1, c = a + 9, d = c + 1;
        indices.push(a, c, b);
        if (row !== 2 || col !== 5) indices.push(b, c, d);
      }
      g.setIndex(indices); g.computeVertexNormals(); return g;
    });
    return add(THREE, parent, geom, mat, x, y, z, w, h, depth, rx, ry, rz);
  }

  function hollow(THREE, parent, mat, x, y, z, w, h, depth) {
    const geom = geometry(THREE, 'creature:cavity', () => {
      const outline = [[-.64, .87], [-.95, .16], [-.68, -.68], [-.13, -1], [.65, -.77], [1, .25], [.44, 1]];
      const positions = [], uv = [];
      const face = (a, b, c) => {
        positions.push(...a, ...b, ...c);
        for (const p of [a, b, c]) uv.push(p[0] * .5 + .5, p[1] * .5 + .5);
      };
      for (let i = 0; i < outline.length; i++) {
        const a = [...outline[i], 0], b = [...outline[(i + 1) % outline.length], 0];
        const c = [b[0] * .48, b[1] * .72, -1], d = [a[0] * .48, a[1] * .72, -1];
        face(a, b, c); face(a, c, d); face(d, c, [-.07, -.11, -1.08]);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.computeVertexNormals(); return g;
    });
    return add(THREE, parent, geom, mat, x, y, z, w, h, depth);
  }

  function hookedHand(THREE, parent, p, at, side, size, crawling) {
    const point = (x, y, z) => [at[0] + x * size, at[1] + (crawling ? z : y) * size, at[2] + (crawling ? -y : z) * size];
    anatomy(THREE, parent, p.skin, 'palm', ...point(0, -.06, .006), .064 * size, .092 * size, .032 * size,
      crawling ? -Math.PI / 2 : 0, 0, side * .075);
    for (let f = 0; f < 4; f++) {
      const x = (f - 1.5) * .031, length = [.22, .31, .27, .18][f];
      const a = point(x, -.105, .012), b = point(x * 1.3 + side * .007, -.11 - length * .65, -.012);
      const c = point(x * 1.5 + side * .017, -.11 - length, -.034), tip = point(x * 1.6 + side * .023, -.058 - length, .07);
      sinew(THREE, parent, p.bone, point(x * .65, -.015, .022), a, .010 * size);
      sinew(THREE, parent, p.skin, a, b, .015 * size);
      sinew(THREE, parent, p.skin, b, c, .010 * size);
      sinew(THREE, parent, p.bone, c, tip, .007 * size);
    }
    sinew(THREE, parent, p.skin, point(side * .046, -.035, .018), point(side * .12, -.14, -.004), .020 * size);
    sinew(THREE, parent, p.skin, point(side * .12, -.14, -.004), point(side * .086, -.20, .067), .012 * size);
  }

  function patientLimb(THREE, p, limb, name, bend, end, width, side, handSize, crawling) {
    sinew(THREE, limb, p.skin, [0, 0, 0], bend, width);
    sinew(THREE, limb, p.bone, [side * .012, -.025, .025], [bend[0], bend[1] * .93, bend[2] + .024], width * .18);
    anatomy(THREE, limb, p.cloth, 'shard', side * .012, -.045, -.008, width * 1.18, .14, width,
      crawling ? .6 : .07, .12, crawling ? side * 1.1 : side * .18);
    const distal = joint(THREE, limb, name, ...bend);
    anatomy(THREE, distal, p.bone, 'shard', 0, -.008, .012, width * .72, .083, width * .64, .1, 0, side * .21);
    sinew(THREE, distal, p.skin, [0, 0, 0], end, width * .64);
    sinew(THREE, distal, p.bone, [side * .014, -.025, .025], [end[0], end[1] * .93, end[2] + .020], width * .16);
    wraps(THREE, distal, p.bandage, 0, -.018, .004, width * .71, side < 0 ? 3 : 1);
    if (side < 0) rag(THREE, limb, p.bandage, side * width, -.16, .035, .065, .23, .013, crawling ? 1.25 : 0, 0, -.18);
    if (handSize) hookedHand(THREE, distal, p, end, side, handSize, crawling);
    else {
      anatomy(THREE, distal, p.skin, 'palm', end[0], end[1] - .014, end[2] + .060, width * .76, .15, .05, -Math.PI / 2, side * .18);
      for (let i = 0; i < 3; i++) sinew(THREE, distal, p.bone,
        [end[0] + (i - 1) * .034, end[1] - .008, end[2] + .12],
        [end[0] + (i - 1) * .040, end[1] - .025, end[2] + .21 - i * .019], width * .13);
    }
    return distal;
  }

  function makeMonster(THREE, requestedKind) {
    const kind = ['warden', 'stalker', 'crawler', 'shrieker'].includes(requestedKind) ? requestedKind : 'stalker';
    const g = new THREE.Group(), p = monsterPalette(THREE, kind);
    g.name = 'Blackwater Ward / ' + kind;
    if (!THREE.ColorManagement || !THREE.ColorManagement.enabled) p.eye.color.convertSRGBToLinear();
    const heavy = kind === 'warden', crawling = kind === 'crawler', screaming = kind === 'shrieker';
    // These dimensions match RULES.MONSTERS. The head pivot is the hit-height;
    // hunched backs, a long cranial vault and splayed limbs supply the silhouette.
    const form = {
      warden: { height: 2.8, head: 2.35, radius: .58, hips: [[-.245, 1.10, -.035], [.255, 1.02, .045]], shoulders: [[-.48, 2.30, .015], [.47, 2.13, .055]], neck: [-.055, 2.35, .28] },
      stalker: { height: 2.65, head: 2.12, radius: .34, hips: [[-.135, 1.30, -.045], [.135, 1.21, .045]], shoulders: [[-.27, 2.18, -.035], [.255, 2.02, .04]], neck: [.075, 2.12, .18] },
      crawler: { height: .9, head: .55, radius: .43, hips: [[-.20, .52, -.36], [.225, .45, -.43]], shoulders: [[-.245, .61, .22], [.26, .54, .16]], neck: [-.065, .55, .46] },
      shrieker: { height: 2.3, head: 1.9, radius: .34, hips: [[-.15, 1.03, -.07], [.12, 1.08, .015]], shoulders: [[-.26, 1.78, .015], [.24, 1.71, -.025]], neck: [.015, 1.9, .17] }
    }[kind];
    const legL = joint(THREE, g, 'legL', ...form.hips[0]), legR = joint(THREE, g, 'legR', ...form.hips[1]);
    const armL = joint(THREE, g, 'armL', ...form.shoulders[0]), armR = joint(THREE, g, 'armR', ...form.shoulders[1]);
    const neck = joint(THREE, g, 'neck', ...form.neck), head = joint(THREE, neck, 'head', 0, 0, 0);
    const knees = [], elbows = [];
    let jaw = null;

    if (crawling) {
      // A collapsed patient held off the floor by inverted, uneven elbows/knees.
      anatomy(THREE, g, p.skin, 'chest', .01, .54, -.055, .265, .53, .16, Math.PI / 2, .04, -.08);
      anatomy(THREE, g, p.skin, 'hump', .035, .74, -.19, .125, .147, .27, .09, .1, -.08);
      rag(THREE, g, p.cloth, -.045, .773, -.18, .39, .56, .026, -Math.PI / 2, .07, -.13);
      for (let i = 0; i < 6; i++) {
        const z = -.49 + i * .145, x = Math.sin(i * .9) * .043;
        anatomy(THREE, g, p.bone, 'shard', x, .745 + Math.sin(i * .7) * .026, z, .028, .053, .048, -.18, .1, -.15);
        sinew(THREE, g, p.bone, [x, .745, z], [-.245, .565, z + .045], .020);
        if (i !== 2) sinew(THREE, g, p.bone, [x, .723, z], [.23, .55, z - .025], .014);
      }
      sinew(THREE, g, p.tendon, [-.07, .65, .25], [-.065, .55, .49], .055);
      const bends = [[-.36, .10, -.30], [.29, .20, -.20], [-.34, .08, .12], [.33, .04, .25]];
      const ends = [[.12, -.55, -.09], [.20, -.56, .13], [.17, -.61, .33], [.17, -.50, .24]];
      for (const [i, limb] of [legL, legR, armL, armR].entries()) {
        const distal = patientLimb(THREE, p, limb, ['kneeL', 'kneeR', 'elbowL', 'elbowR'][i], bends[i], ends[i], i < 2 ? .072 : .067, i % 2 ? 1 : -1, .86, true);
        (i < 2 ? knees : elbows).push(distal);
      }
      box(THREE, g, p.bandage, -.11, .798, -.31, .075, .013, .09, 0, .12, -.08);
    } else {
      const hipY = (form.hips[0][1] + form.hips[1][1]) * .5;
      anatomy(THREE, g, p.cloth, 'pelvis', .015, hipY + .025, -.015, heavy ? .28 : .18, .22, heavy ? .19 : .12, .08, .08, -.12);
      if (heavy) {
        anatomy(THREE, g, p.skin, 'chest', .025, 1.79, .01, .49, .56, .28, .10, 0, -.04);
        anatomy(THREE, g, p.skin, 'hump', -.105, 2.19, -.18, .45, .60, .36, -.20, .02, .11);
        anatomy(THREE, g, p.tendon, 'shard', .045, 1.40, .245, .19, .26, .035, .12, 0, .12);
        rag(THREE, g, p.cloth, -.13, 1.24, .295, .43, .97, .027, 0, -.06, .08);
        rag(THREE, g, p.cloth, .24, 1.17, .17, .22, .72, .025, .08, .9, -.13);
        // Canvas restraints bite across the hunch; no armour or ornamental chains.
        box(THREE, g, p.bandage, -.025, 2.13, .285, .88, .12, .032, .10, 0, -.20);
        box(THREE, g, p.cloth, .015, 1.80, .275, .70, .115, .035, .06, 0, .14);
        box(THREE, g, p.bandage, -.23, 2.12, .315, .09, .77, .029, .12, -.08, .38);
        box(THREE, g, p.bandage, .20, 2.0, .295, .08, .61, .030, .10, .08, -.32);
        box(THREE, g, p.dark, .28, 1.84, .311, .145, .12, .023, 0, 0, .14);
        box(THREE, g, p.bandage, .28, 1.84, .325, .09, .066, .016, 0, 0, .14);
        rag(THREE, g, p.bandage, -.34, 1.77, .315, .08, .34, .019, 0, -.2, -.24);
      } else if (screaming) {
        anatomy(THREE, g, p.skin, 'chest', .02, 1.39, -.025, .23, .41, .14, -.08, -.1, .075);
        anatomy(THREE, g, p.tendon, 'shard', -.02, 1.20, .105, .07, .22, .035, .08, 0, -.15);
        rag(THREE, g, p.cloth, .10, 1.24, .145, .25, .45, .022, 0, -.12, -.14);
        rag(THREE, g, p.cloth, .02, 1.46, -.16, .40, .56, .026, .1, Math.PI, .12);
        rag(THREE, g, p.bandage, .12, 1.63, .12, .065, .40, .013, 0, .2, -.20);
      } else {
        anatomy(THREE, g, p.skin, 'chest', -.045, 1.72, -.018, .228, .47, .155, .08, .12, -.13);
        anatomy(THREE, g, p.tendon, 'shard', .045, 1.46, .122, .070, .25, .034, .12, 0, .14);
        rag(THREE, g, p.cloth, .095, 1.40, .15, .24, .52, .025, 0, -.08, .13);
        rag(THREE, g, p.cloth, -.10, 1.68, -.165, .30, .80, .022, .08, Math.PI, -.1);
        rag(THREE, g, p.cloth, -.26, 2.05, .04, .14, .40, .025, .05, -.3, -.18);
      }
      for (let i = 0; i < 5; i++) {
        const yy = (heavy ? 2.16 : screaming ? 1.68 : 2.03) - i * (screaming ? .088 : .12);
        const w = (heavy ? .37 : .205) * (1 - i * .065), front = heavy ? .315 : .173;
        for (const side of [-1, 1]) {
          const a = [-.024, yy - (side > 0 ? i * .007 : 0), front];
          const b = [side * w * .63, yy + (side < 0 ? .053 : .013), front - .02];
          if (side < 0 || i !== 2) sinew(THREE, g, p.bone, a, b, heavy ? .023 : .015);
          sinew(THREE, g, p.bone, b, [side * w, yy - .035, front - .11], heavy ? .018 : .012);
        }
        anatomy(THREE, g, p.bone, 'shard', Math.sin(i) * .026, hipY + .20 + i * (heavy ? .23 : .14), heavy ? -.29 : -.17, .025, .059, .047, -.15, .12, .18);
      }
      const legBends = heavy ? [[-.075, -.47, .10], [.065, -.42, -.04]]
        : screaming ? [[-.05, -.42, -.02], [.07, -.50, .10]] : [[-.09, -.58, .02], [.105, -.63, .18]];
      const legEnds = heavy ? [[.025, -.55, -.085], [-.012, -.51, .09]]
        : screaming ? [[.02, -.54, .10], [-.02, -.51, -.07]] : [[.08, -.65, -.065], [-.14, -.51, -.13]];
      const armBends = heavy ? [[-.075, -.64, .09], [.105, -.53, -.03]]
        : screaming ? [[-.06, -.43, .10], [.12, -.52, -.02]] : [[-.055, -.65, .045], [.085, -.43, -.075]];
      const armEnds = heavy ? [[.025, -.69, .035], [-.015, -.79, .16]]
        : screaming ? [[.035, -.44, .17], [-.17, -.34, .28]] : [[-.015, -.78, .055], [-.035, -.52, .15]];
      for (let i = 0; i < 2; i++) {
        const side = i ? 1 : -1;
        knees.push(patientLimb(THREE, p, i ? legR : legL, i ? 'kneeR' : 'kneeL', legBends[i], legEnds[i], heavy ? .14 : .072, side, 0, false));
        elbows.push(patientLimb(THREE, p, i ? armR : armL, i ? 'elbowR' : 'elbowL', armBends[i], armEnds[i], heavy ? .12 : .054, side, heavy ? 1.27 : screaming ? .93 : 1, false));
      }
      sinew(THREE, neck, p.skin, [0, -.23, -.17], [0, .035, -.035], heavy ? .14 : .065);
      sinew(THREE, neck, p.bone, [-.04, -.22, -.075], [.023, .09, -.08], heavy ? .028 : .019);
    }

    const skullW = heavy ? .205 : crawling ? .125 : .12, front = heavy ? .208 : .142;
    const eyeY = screaming ? .132 : crawling ? .055 : .105;
    anatomy(THREE, head, p.skin, 'skull', 0, crawling ? .03 : heavy ? .075 : screaming ? .14 : .13, -.035,
      skullW, heavy ? .28 : crawling ? .205 : screaming ? .225 : .36, heavy ? .185 : .135, .06, -.08, .035);
    for (const side of [-1, 1]) {
      const xx = side * skullW * (side < 0 ? .48 : .43), yy = eyeY - (side > 0 ? .03 : 0);
      hollow(THREE, head, p.dark, xx, yy, front, heavy ? .064 : .044, side < 0 ? .042 : .032, .037);
      sinew(THREE, head, p.skin, [side * .012, yy + .043, front + .027], [xx * 1.55, yy + .030, front + .010], heavy ? .031 : .021);
      anatomy(THREE, head, p.skin, 'shard', side * skullW * .74, yy - .11, front - .013, heavy ? .058 : .034, .14, .047, .1, side * .3, side * .23);
    }
    // One almost lost slit; the other socket is occluded. No paired catchlights.
    box(THREE, head, p.eye, skullW * .43, eyeY - .03, front - .012, .019, .005, .003, 0, 0, -.12);
    anatomy(THREE, head, p.bone, 'shard', -.018, eyeY - .072, front + .009, .023, .083, .032, .15, -.14, -.16);
    rag(THREE, head, p.bandage, -skullW * .51, eyeY + .062, front + .021, skullW * .83, crawling ? .18 : .22, .013, 0, -.16, .17);
    if (crawling) {
      hollow(THREE, head, p.dark, -.012, -.075, front + .006, .071, .108, .065);
      sinew(THREE, head, p.skin, [-.105, .015, .09], [-.095, -.15, .18], .027);
      sinew(THREE, head, p.bone, [-.095, -.15, .18], [-.023, -.18, .20], .022);
      sinew(THREE, head, p.skin, [.092, .005, .09], [.055, -.157, .19], .022);
      teeth(THREE, head, p.bone, -.012, front + .018, .045, 3, true, -.008);
      head.rotation.set(.11, -.16, -.42); neck.rotation.set(.05, .12, .06);
    } else {
      jaw = joint(THREE, head, 'jaw', heavy ? .022 : screaming ? .008 : -.018, screaming ? .09 : .035, .025);
      const drop = heavy ? .255 : screaming ? .565 : .33, width = heavy ? .145 : screaming ? .108 : .087;
      hollow(THREE, jaw, p.dark, -.014, -drop * .52, front + .01, width, drop * (screaming ? .64 : .60), screaming ? .14 : .095);
      for (const side of [-1, 1]) {
        const hinge = [side * skullW * .82, .01, front * .58];
        const corner = [side * width, -drop * (side < 0 ? .81 : .74), front + .022];
        const chin = [side * (screaming ? .037 : .022), -drop * (side < 0 ? 1 : .94), front + .06];
        sinew(THREE, jaw, p.skin, hinge, corner, heavy ? .047 : .027);
        sinew(THREE, jaw, p.bone, corner, chin, heavy ? .030 : .021);
        if (screaming) {
          sinew(THREE, jaw, p.tendon, [side * .07, -.06, front - .024], [side * .049, -.47, front + .025], .016);
          teeth(THREE, jaw, p.bone, chin[1] + .025, front + .062, .031, 2, false, side * .067);
        }
      }
      teeth(THREE, head, p.bone, .018, front + .03, heavy ? .14 : .085, heavy ? 7 : 5, true);
      if (!screaming) {
        sinew(THREE, jaw, p.skin, [-.023, -drop, front + .06], [.033, -drop * .94, front + .065], .021);
        teeth(THREE, jaw, p.bone, -drop + .028, front + .066, .08, 4, false, .008);
      }
      rag(THREE, jaw, p.bandage, -width, -drop * .53, front * .55, .05, heavy ? .22 : .27, .013, 0, -.45, -.18);
      if (heavy) {
        box(THREE, head, p.cloth, -.017, eyeY + .082, front - .002, .38, .061, .029, .1, -.1, -.14);
        wraps(THREE, neck, p.bandage, 0, -.145, -.07, .145, 2);
        head.rotation.set(.13, -.08, -.13); neck.rotation.set(.12, 0, -.03); jaw.rotation.x = .06;
      } else if (screaming) {
        // The mouth continues down between two pulled-apart mandibular rails.
        sinew(THREE, neck, p.tendon, [-.06, -.40, -.07], [-.11, .13, .025], .023);
        sinew(THREE, neck, p.tendon, [.07, -.36, -.04], [.085, .10, .013], .018);
        for (let i = 0; i < 4; i++) box(THREE, neck, p.bone, .008, -.13 - i * .055, .043, .061, .015, .032, 0, 0, i * .04);
        head.rotation.set(-.07, .09, .12); neck.rotation.set(-.03, .10, .04); jaw.rotation.x = .04;
      } else {
        head.rotation.set(.10, -.12, -.34); neck.rotation.set(.02, -.04, .08); jaw.rotation.x = -.04;
      }
    }
    // Immutable local XYZ Euler baselines for additive animation. Distortions are
    // also in mesh endpoints and the head child, so the legacy animator is safe.
    const restPose = {};
    for (const part of [legL, legR, armL, armR, neck, head, ...knees, ...elbows, ...(jaw ? [jaw] : [])]) {
      restPose[part.name] = Object.freeze({ x: part.rotation.x, y: part.rotation.y, z: part.rotation.z });
    }
    consolidateOrganicMaterials(THREE, g, p);
    batch(THREE, g);
    const glow = { intensity: 0 }; // Compatibility handle only; never drives light or emission.
    g.userData = {
      kind, direction: 'Blackwater Ward', legL, legR, armL, armR, neck, head, jaw, restPose: Object.freeze(restPose),
      eyeMat: p.eye, eyeColor: p.eye.color.getHex(), glow, limbs: [legL, legR, armL, armR], knees, elbows, phase: 0,
      twitch: 0, twitchT: 1, speed: 0, chasing: false,
      height: form.height, bodyRadius: form.radius, headHeight: form.head,
      stride: crawling ? .2 : heavy ? .27 : .44, resources: { uniqueMaterials: [p.eye] }
    };
    return g;
  }

  function label(THREE, key, lines, color, background) {
    const cache = store(THREE).materials, id = 'label:' + key;
    if (cache.has(id)) return cache.get(id);
    const [c, x] = canvas(512, 256);
    x.fillStyle = background || '#182126'; x.fillRect(0, 0, 512, 256);
    x.strokeStyle = color || '#a6bec3'; x.lineWidth = 3; x.strokeRect(12, 12, 488, 232);
    x.fillStyle = color || '#a6bec3'; x.textAlign = 'left';
    lines.forEach((s, i) => { x.font = (i ? '22px ' : 'bold 35px ') + 'monospace'; x.fillText(s, 30, 58 + i * 45); });
    const m = new THREE.MeshStandardMaterial({ map: texture(THREE, c, true), roughness: 0.8, metalness: 0.2 });
    m.userData.hollowShared = true; cache.set(id, m); return m;
  }

  function flashMaterial(THREE) {
    const cache = store(THREE).materials;
    if (cache.has('muzzle')) return cache.get('muzzle');
    const [c, x] = canvas(128, 128);
    const bloom = x.createRadialGradient(64, 64, 0, 64, 64, 62);
    bloom.addColorStop(0, 'rgba(255,252,228,1)'); bloom.addColorStop(0.12, 'rgba(255,226,164,1)');
    bloom.addColorStop(0.32, 'rgba(255,169,66,.65)'); bloom.addColorStop(1, 'rgba(250,88,14,0)');
    x.fillStyle = bloom; x.fillRect(0, 0, 128, 128);
    x.fillStyle = 'rgba(255,231,180,.6)'; x.beginPath();
    for (let i = 0; i < 16; i++) {
      const a = i / 16 * TAU, r = i % 2 ? 11 : i % 4 ? 43 : 58;
      const px = 64 + Math.cos(a) * r, py = 64 + Math.sin(a) * r;
      if (!i) x.moveTo(px, py); else x.lineTo(px, py);
    }
    x.closePath(); x.fill();
    const m = new THREE.MeshBasicMaterial({ map: texture(THREE, c, true), transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false });
    m.userData.hollowShared = true; cache.set('muzzle', m); return m;
  }

  function makeWeapon(THREE, requestedKind) {
    const kind = ['rifle', 'pistol', 'shotgun'].includes(requestedKind) ? requestedKind : 'rifle';
    const g = new THREE.Group(); g.name = kind;
    const steel = standard(THREE, 'gun:steel', 0x737f86, 0.42, 0.88, 'metal');
    const edge = standard(THREE, 'gun:edge', 0xadb4b7, 0.32, 0.93, 'metal');
    const black = standard(THREE, 'gun:black', 0x3d464a, 0.64, 0.58, 'metal');
    const polymer = standard(THREE, 'gun:polymer', 0x343e40, 0.94, 0, 'fabric');
    const wood = standard(THREE, 'gun:wood', 0x745039, 0.7, 0, 'wood');
    const brass = standard(THREE, 'gun:brass', 0xbd9552, 0.29, 0.85, 'metal');
    const rubber = standard(THREE, 'gun:rubber', 0x14191a, 0.96, 0, 'fabric');
    const glove = standard(THREE, 'gun:glove', 0x5d6963, 0.96, 0, 'fabric');
    const sight = basic(THREE, 'gun:sight', 0x97d3b1);
    const magazine = joint(THREE, g, 'magazine', 0, 0, 0);
    const bolt = joint(THREE, g, 'bolt', 0, 0, 0);
    let muzzle;

    if (kind === 'rifle') {
      bevel(THREE, g, steel, 0, 0, -0.007, 0.065, 0.084, 0.30, 0.009);
      bevel(THREE, g, black, 0, 0.050, -0.005, 0.055, 0.032, 0.29, 0.006);
      bevel(THREE, g, polymer, 0, -0.020, 0.235, 0.060, 0.085, 0.19, 0.014, -0.07);
      bevel(THREE, g, rubber, 0, -0.022, 0.331, 0.064, 0.094, 0.018, 0.006);
      cyl(THREE, g, steel, 0, 0.01, 0.147, 0.024, 0.024, 0.105, Math.PI / 2);
      bevel(THREE, g, polymer, 0, -0.118, 0.066, 0.045, 0.143, 0.066, 0.009, -0.27);
      ring(THREE, g, black, 0, -0.071, 0.013, 0.038, 0.006, 0, Math.PI / 2).scale.set(1, 0.8, 1.05);
      box(THREE, g, steel, 0, -0.066, 0.025, 0.008, 0.035, 0.012, -0.3);
      bevel(THREE, g, polymer, 0, 0.003, -0.305, 0.074, 0.085, 0.28, 0.012);
      cyl(THREE, g, steel, 0, 0.018, -0.520, 0.012, 0.014, 0.40, Math.PI / 2);
      cyl(THREE, g, black, 0, 0.050, -0.445, 0.009, 0.009, 0.20, Math.PI / 2);
      for (let i = 0; i < 8; i++) {
        box(THREE, g, black, 0, 0.051, -0.19 - i * 0.031, 0.081, 0.010, 0.011);
        for (const side of [-1, 1]) bevel(THREE, g, black, side * 0.0378, 0.002, -0.206 - i * 0.028, 0.005, 0.029, 0.011, 0.002);
      }
      bevel(THREE, g, steel, 0, 0.068, -0.50, 0.025, 0.035, 0.044, 0.005);
      ring(THREE, g, black, 0, 0.102, -0.49, 0.023, 0.005);
      box(THREE, g, edge, 0, 0.093, -0.49, 0.005, 0.029, 0.006);
      bevel(THREE, g, steel, 0, 0.091, 0.007, 0.055, 0.029, 0.055, 0.006);
      ring(THREE, g, black, 0, 0.111, 0.009, 0.019, 0.005);
      cyl(THREE, g, black, 0, 0.018, -0.738, 0.019, 0.019, 0.065, Math.PI / 2);
      for (const side of [-1, 1]) for (let i = 0; i < 3; i++) box(THREE, g, rubber, side * 0.018, 0.018, -0.72 - i * 0.018, 0.003, 0.018, 0.009);
      magazine.position.set(0, -0.052, -0.082);
      bevel(THREE, magazine, steel, 0, -0.064, 0, 0.043, 0.13, 0.077, 0.007, -0.08);
      bevel(THREE, magazine, steel, 0, -0.151, -0.021, 0.043, 0.076, 0.077, 0.007, -0.34);
      bevel(THREE, magazine, black, 0, -0.195, -0.035, 0.049, 0.014, 0.085, 0.003, -0.34);
      for (const side of [-1, 1]) for (let i = 0; i < 3; i++) {
        box(THREE, magazine, black, side * 0.022, -0.08, -0.021 + i * 0.022, 0.002, 0.105, 0.006, -0.08);
        box(THREE, magazine, black, side * 0.022, -0.155, -0.043 + i * 0.022, 0.002, 0.055, 0.006, -0.34);
      }
      bevel(THREE, bolt, black, -0.034, 0.021, -0.05, 0.005, 0.026, 0.115, 0.004);
      bevel(THREE, bolt, edge, -0.038, 0.021, -0.034, 0.012, 0.011, 0.061, 0.003);
      cyl(THREE, bolt, steel, -0.054, 0.025, 0.064, 0.007, 0.007, 0.037, 0, 0, Math.PI / 2);
      muzzle = new THREE.Vector3(0, 0.018, -0.787);
    } else if (kind === 'pistol') {
      bevel(THREE, bolt, steel, 0, 0.032, -0.098, 0.055, 0.063, 0.292, 0.007);
      bevel(THREE, g, polymer, 0, -0.02, -0.082, 0.053, 0.038, 0.246, 0.006);
      bevel(THREE, g, polymer, 0, -0.102, 0.042, 0.052, 0.173, 0.087, 0.012, -0.29);
      bevel(THREE, g, rubber, -0.027, -0.113, 0.044, 0.006, 0.126, 0.072, 0.007, -0.29);
      bevel(THREE, g, rubber, 0.027, -0.113, 0.044, 0.006, 0.126, 0.072, 0.007, -0.29);
      ring(THREE, g, black, 0, -0.069, -0.048, 0.038, 0.007, 0, Math.PI / 2).scale.set(1, 0.78, 1);
      box(THREE, g, steel, 0, -0.061, -0.043, 0.009, 0.037, 0.015, -0.20);
      cyl(THREE, g, black, 0, 0.028, -0.247, 0.017, 0.017, 0.016, Math.PI / 2);
      for (const side of [-1, 1]) for (let i = 0; i < 7; i++) {
        box(THREE, bolt, black, side * 0.0278, 0.028, 0.024 - i * 0.009, 0.002, 0.039, 0.004, -0.05);
      }
      bevel(THREE, bolt, black, 0, 0.047, -0.068, 0.038, 0.034, 0.057, 0.006);
      bevel(THREE, bolt, edge, 0, 0.048, -0.068, 0.028, 0.034, 0.040, 0.005);
      bevel(THREE, bolt, black, 0, 0.072, 0.023, 0.04, 0.017, 0.022, 0.003);
      box(THREE, bolt, sight, -0.012, 0.073, 0.035, 0.006, 0.006, 0.002);
      box(THREE, bolt, sight, 0.012, 0.073, 0.035, 0.006, 0.006, 0.002);
      box(THREE, bolt, black, 0, 0.07, -0.224, 0.011, 0.017, 0.027);
      box(THREE, bolt, sight, 0, 0.075, -0.209, 0.006, 0.006, 0.002);
      magazine.position.set(0, -0.197, 0.066);
      bevel(THREE, magazine, black, 0, 0.027, 0, 0.042, 0.065, 0.060, 0.005, -0.29);
      bevel(THREE, magazine, steel, 0, -0.005, 0, 0.056, 0.014, 0.077, 0.004, -0.29);
      muzzle = new THREE.Vector3(0, 0.028, -0.272);
    } else {
      bevel(THREE, g, steel, 0, 0.004, -0.047, 0.075, 0.094, 0.265, 0.009);
      bevel(THREE, g, wood, 0, -0.048, 0.217, 0.068, 0.111, 0.255, 0.015, -0.22);
      bevel(THREE, g, rubber, 0, -0.071, 0.336, 0.076, 0.123, 0.025, 0.007, -0.22);
      ring(THREE, g, black, 0, -0.077, 0.061, 0.039, 0.007, 0, Math.PI / 2).scale.set(1, 0.8, 1);
      box(THREE, g, steel, 0, -0.067, 0.064, 0.008, 0.037, 0.013, -0.32);
      cyl(THREE, g, steel, 0, 0.023, -0.498, 0.019, 0.022, 0.675, Math.PI / 2, 0, 0, 14);
      cyl(THREE, magazine, black, 0, -0.033, -0.46, 0.021, 0.021, 0.572, Math.PI / 2);
      cyl(THREE, magazine, edge, 0, -0.033, -0.745, 0.023, 0.023, 0.016, Math.PI / 2);
      bevel(THREE, bolt, wood, 0, -0.026, -0.385, 0.085, 0.090, 0.244, 0.014);
      for (let i = 0; i < 11; i++) ring(THREE, bolt, black, 0, -0.026, -0.281 - i * 0.020, 0.043, 0.003).scale.set(1, 1.03, 1);
      box(THREE, g, black, 0, 0.056, -0.458, 0.016, 0.013, 0.697);
      for (let i = 0; i < 6; i++) box(THREE, g, steel, 0, 0.047, -0.24 - i * 0.104, 0.015, 0.018, 0.023);
      oval(THREE, g, brass, 0, 0.069, -0.792, 0.006, 0.006, 0.006);
      bevel(THREE, g, black, -0.039, 0.006, -0.051, 0.005, 0.045, 0.096, 0.005);
      bevel(THREE, g, edge, -0.042, 0.006, -0.048, 0.007, 0.034, 0.062, 0.005);
      const shell = standard(THREE, 'gun:shell', 0x884d35, 0.62, 0.12, 'metal');
      for (let i = 0; i < 4; i++) {
        cyl(THREE, g, shell, -0.053, -0.021, 0.029 - i * 0.038, 0.011, 0.011, 0.064);
        cyl(THREE, g, brass, -0.053, 0.014, 0.029 - i * 0.038, 0.012, 0.012, 0.01);
      }
      muzzle = new THREE.Vector3(0, 0.023, -0.855);
    }
    // A real dark bore and milled crown catch the light at the business end.
    ring(THREE, g, edge, muzzle.x, muzzle.y, muzzle.z + 0.012, kind === 'shotgun' ? 0.019 : 0.013, 0.0035);
    const bore = add(THREE, g, geometry(THREE, 'bore', () => new THREE.CircleGeometry(1, 16)), rubber,
      muzzle.x, muzzle.y, muzzle.z + 0.011, kind === 'shotgun' ? 0.016 : 0.011, kind === 'shotgun' ? 0.016 : 0.011, 1, 0, Math.PI);
    bore.castShadow = false;
    const gripY = kind === 'shotgun' ? -0.105 : -0.136, gripZ = kind === 'shotgun' ? 0.12 : 0.073;
    oval(THREE, g, glove, 0.02, gripY, gripZ, 0.064, 0.077, 0.068, -0.2);
    for (let i = 0; i < 3; i++) oval(THREE, g, rubber, -0.024, gripY - 0.004 + i * 0.027, gripZ - 0.038,
      0.032, 0.011, 0.022, 0.03);
    if (kind !== 'pistol') {
      oval(THREE, g, glove, -0.028, -0.088, kind === 'rifle' ? -0.294 : -0.382, 0.063, 0.045, 0.080);
      for (let i = 0; i < 4; i++) oval(THREE, g, rubber, -0.045, -0.034, (kind === 'rifle' ? -0.259 : -0.347) - i * 0.024, 0.016, 0.034, 0.011);
    }
    for (const z of [-0.1, 0.062]) {
      cyl(THREE, g, edge, -0.036, 0.006, z, 0.0045, 0.0045, 0.003, 0, 0, Math.PI / 2, 6);
    }
    batch(THREE, g);
    const muzzleFlash = new THREE.Mesh(geometry(THREE, 'flashPlane', () => new THREE.PlaneGeometry(0.27, 0.27)), flashMaterial(THREE));
    muzzleFlash.position.copy(muzzle); muzzleFlash.visible = false; muzzleFlash.userData.dynamic = true; g.add(muzzleFlash);
    g.userData = { kind, magazine, muzzleFlash, muzzlePosition: muzzle, bolt, run: 0 };
    return g;
  }

  function makeFlashlight(THREE) {
    const g = new THREE.Group(); g.name = 'field flashlight';
    const steel = standard(THREE, 'gun:steel', 0x737f86, 0.42, 0.88, 'metal');
    const edge = standard(THREE, 'gun:edge', 0xadb4b7, 0.32, 0.93, 'metal');
    const black = standard(THREE, 'gun:black', 0x3d464a, 0.64, 0.58, 'metal');
    const rubber = standard(THREE, 'gun:rubber', 0x14191a, 0.96, 0, 'fabric');
    const glove = standard(THREE, 'gun:glove', 0x5d6963, 0.96, 0, 'fabric');
    const sleeve = standard(THREE, 'flashlight:sleeve', 0x2b373b, 0.96, 0, 'fabric');
    cyl(THREE, g, black, 0, 0, 0, 0.027, 0.027, 0.236, Math.PI / 2, 0, 0, 16);
    cyl(THREE, g, steel, 0, 0, -0.134, 0.03, 0.045, 0.073, Math.PI / 2, 0, 0, 18);
    cyl(THREE, g, black, 0, 0, -0.172, 0.047, 0.047, 0.018, Math.PI / 2, 0, 0, 18);
    ring(THREE, g, edge, 0, 0, -0.183, 0.042, 0.004);
    ring(THREE, g, steel, 0, 0, -0.182, 0.0355, 0.003);
    for (const z of [-0.109, -0.121, -0.132]) ring(THREE, g, black, 0, 0, z, 0.032 + (-z - 0.109) * 0.28, 0.004);
    for (let i = 0; i < 9; i++) ring(THREE, g, rubber, 0, 0, 0.073 - i * 0.016, 0.027, 0.0025);
    cyl(THREE, g, steel, 0, 0, 0.115, 0.031, 0.031, 0.018, Math.PI / 2, 0, 0, 16);
    cyl(THREE, g, rubber, 0, 0, 0.126, 0.021, 0.021, 0.009, Math.PI / 2, 0, 0, 12);
    oval(THREE, g, rubber, 0, 0.029, -0.067, 0.015, 0.005, 0.022);
    box(THREE, g, edge, 0, 0.034, -0.067, 0.003, 0.001, 0.016);
    // Anatomical grip: cupped palm, articulated fingers, separate thumb, and cuff.
    oval(THREE, g, glove, 0.011, -0.047, 0.02, 0.047, 0.027, 0.071, 0.02, 0.05, -0.12);
    for (let i = 0; i < 4; i++) {
      const z = -0.038 + i * 0.027, rise = i === 3 ? -0.004 : 0;
      link(THREE, g, glove, [-0.031, -0.043, z], [-0.042, -0.014 + rise, z], 0.013, 0.012);
      link(THREE, g, glove, [-0.042, -0.014 + rise, z], [-0.034, 0.015 + rise, z - 0.002], 0.012, 0.011);
      link(THREE, g, rubber, [-0.034, 0.015 + rise, z - 0.002], [-0.017, 0.025 + rise, z - 0.003], 0.011, 0.009);
      oval(THREE, g, rubber, -0.042, -0.013 + rise, z, 0.014, 0.013, 0.011);
    }
    link(THREE, g, glove, [0.034, -0.043, 0.059], [0.049, -0.012, 0.032], 0.017, 0.014);
    link(THREE, g, glove, [0.049, -0.012, 0.032], [0.036, 0.014, 0.002], 0.014, 0.011);
    oval(THREE, g, rubber, 0.036, 0.014, 0.002, 0.012, 0.009, 0.018, 0.42);
    cyl(THREE, g, rubber, 0.014, -0.052, 0.114, 0.048, 0.045, 0.061, Math.PI / 2, 0, 0, 14);
    cyl(THREE, g, sleeve, 0.012, -0.054, 0.251, 0.064, 0.047, 0.237, Math.PI / 2, 0, 0, 14);
    ring(THREE, g, glove, 0.014, -0.052, 0.139, 0.048, 0.003).scale.y = 0.88;
    bevel(THREE, g, black, 0.014, -0.100, 0.124, 0.064, 0.012, 0.044, 0.004);
    // Subtle reflective optics; game owns this material's on/off tint.
    const [c, x] = canvas(128, 128), radial = x.createRadialGradient(61, 61, 3, 64, 64, 61);
    radial.addColorStop(0, '#fafcf8'); radial.addColorStop(0.12, '#c6d1c7');
    radial.addColorStop(0.29, '#4a5e64'); radial.addColorStop(0.78, '#a2afb0'); radial.addColorStop(1, '#18252b');
    x.fillStyle = radial; x.fillRect(0, 0, 128, 128);
    x.strokeStyle = 'rgba(228,245,245,.35)'; x.lineWidth = 3;
    x.beginPath(); x.arc(64, 64, 48, -2.7, -1.25); x.stroke();
    const opticsMap = texture(THREE, c, true); opticsMap.userData.hollowShared = false;
    const lensMaterial = new THREE.MeshBasicMaterial({ color: 0x221c14, map: opticsMap, toneMapped: false });
    lensMaterial.userData.hollowOwnedMaps = [opticsMap];
    batch(THREE, g);
    const lens = add(THREE, g, geometry(THREE, 'flashlight:lens', () => new THREE.CircleGeometry(0.038, 24)), lensMaterial,
      0, 0, -0.184, 1, 1, 1, 0, Math.PI);
    lens.castShadow = false; lens.receiveShadow = false;
    g.userData = { lensMaterial, lens, muzzlePosition: new THREE.Vector3(0, 0, -0.184) };
    return g;
  }

  function roomPalette(THREE) {
    return {
      steel: standard(THREE, 'room:steel', 0x647477, 0.58, 0.76, 'metal'),
      dark: standard(THREE, 'room:dark', 0x283335, 0.79, 0.61, 'metal'),
      paint: standard(THREE, 'room:paint', 0x697775, 0.85, 0.19, 'metal'),
      black: standard(THREE, 'room:black', 0x172022, 0.94, 0, 'fabric'),
      cloth: standard(THREE, 'room:cloth', 0xa29f8b, 0.97, 0, 'fabric'),
      damp: standard(THREE, 'room:damp', 0x4b4c3d, 0.68, 0, 'concrete'),
      rust: standard(THREE, 'room:rust', 0x795441, 0.83, 0.42, 'metal'),
      yellow: standard(THREE, 'room:yellow', 0xbba75d, 0.83, 0.25, 'metal'),
      light: basic(THREE, 'room:light', 0x727b70),

      red: standard(THREE, 'room:red', 0x78524b, 0.92, 0, 'metal')
    };
  }

  function roomDimension(value, fallback, min, max) {
    return Number.isFinite(value) ? clamp(value, min, max) : fallback;
  }

  function shroud(THREE, parent, mat, x, y, z) {
    const geom = geometry(THREE, 'ward:shroud', () => {
      const g = new THREE.PlaneGeometry(1, 1, 16, 24), p = g.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const across = p.getX(i), along = p.getY(i);
        const head = Math.exp(-Math.pow((along + 0.35) / 0.10, 2));
        const chest = Math.exp(-Math.pow((along + 0.10) / 0.18, 2));
        const feet = Math.exp(-Math.pow((along - 0.37) / 0.10, 2));
        const width = 0.17 + chest * 0.18 + feet * 0.04;
        const rise = Math.max(0, 1 - Math.pow(across / width, 2));
        p.setXYZ(i, across, rise * (0.38 + head * 0.35 + chest * 0.38 + feet * 0.18)
          + Math.sin(across * 61 + along * 11) * 0.025, along);
      }
      g.computeVertexNormals(); return g;
    });
    return add(THREE, parent, geom, mat, x, y, z, 0.82, 0.40, 1.80);
  }

  function decorateRoom(THREE, options) {
    const opts = options || {}, width = roomDimension(opts.width, 9, 3, 40), depth = roomDimension(opts.depth, 9, 3, 40);
    const height = roomDimension(opts.height, 3.2, 2.6, 6);
    const type = opts.type || 'maintenance', p = roomPalette(THREE), g = new THREE.Group();
    g.name = 'Blackwater Ward / ' + type;
    p.cloth.side = THREE.DoubleSide;
    const colliders = [], dressing = [];
    const story = (kind, object) => {
      object.updateWorldMatrix(true, true);
      const bounds = new THREE.Box3().setFromObject(object);
      dressing.push({ kind, bounds: { min: bounds.min.toArray(), max: bounds.max.toArray() } });
    };
    const mark = (x, z, w, d, h) => colliders.push({ x, z, w, d, h });
    const left = -width / 2 + 0.75, right = width / 2 - 0.8, back = -depth / 2 + 0.70;

    function placard(x, y, z, title, subtitle, color, angle) {
      const mat = label(THREE, title, [title, subtitle || 'RESTRICTED ACCESS', 'BLACKWATER WARD / BELOW MANOR'], color || '#aaa996');
      const m = add(THREE, g, geometry(THREE, 'placard', () => new THREE.PlaneGeometry(0.92, 0.46)), mat, x, y, z, 1, 1, 1, 0, angle || 0);
      m.castShadow = false;
    }

    function shelf(x, z, orientation) {
      const r = joint(THREE, g, 'shelf', x, 0, z); r.rotation.y = orientation || 0;
      for (const sx of [-0.7, 0.7]) for (const sz of [-0.26, 0.26]) box(THREE, r, p.dark, sx, 0.88, sz, 0.042, 1.76, 0.042);
      for (let row = 0; row < 4; row++) {
        box(THREE, r, p.steel, 0, 0.20 + row * 0.48, 0, 1.50, 0.032, 0.60);
        for (let j = 0; j < 3; j++) {
          const x0 = -0.48 + j * 0.46, y0 = 0.36 + row * 0.48;
          bevel(THREE, r, (j + row) % 3 ? p.paint : p.rust, x0, y0, 0, 0.34, 0.27, 0.42, 0.014);
          box(THREE, r, p.cloth, x0, y0 + 0.02, 0.211, 0.15, 0.07, 0.003);
          box(THREE, r, p.dark, x0, y0 - 0.02, 0.219, 0.07, 0.012, 0.013);
        }
      }
      mark(x, z, orientation ? 0.65 : 1.55, orientation ? 1.55 : 0.65, 1.80);
    }

    function bed(x, z, covered) {
      const r = joint(THREE, g, 'medical bed', x, 0, z);
      bevel(THREE, r, p.dark, 0, 0.61, 0, 0.90, 0.10, 1.98, 0.02);
      bevel(THREE, r, p.cloth, 0, 0.71, 0, 0.83, 0.14, 1.89, 0.025);
      oval(THREE, r, p.cloth, 0, 0.84, -0.68, 0.34, 0.09, 0.25, 0.05);
      for (let i = 0; i < 6; i++) {
        oval(THREE, r, p.damp, Math.sin(i * 4.1) * 0.14, 0.783 + i * 0.0004, -0.25 + i * 0.16,
          0.10 + i % 3 * 0.035, 0.002, 0.13, 0, i * 0.7);
      }
      for (const sx of [-0.405, 0.405]) box(THREE, r, p.damp, sx, 0.738, 0, 0.008, 0.012, 1.72);
      story('stained mattress', r);
      if (covered) story('body-shaped shroud', shroud(THREE, r, p.cloth, 0, 0.795, 0));
      else {
        drape(THREE, r, p.cloth, -0.39, 0.53, 0.29, 0.63, 0.46, 0.022, Math.PI / 2, -0.12);
        for (const sx of [-0.31, 0.31]) box(THREE, r, p.dark, sx, 0.80, 0.48, 0.17, 0.012, 0.049);
      }
      for (const x0 of [-0.38, 0.38]) for (const z0 of [-0.79, 0.79]) {
        cyl(THREE, r, p.steel, x0, 0.35, z0, 0.026, 0.026, 0.51);
        cyl(THREE, r, p.black, x0, 0.10, z0, 0.078, 0.078, 0.05, 0, 0, Math.PI / 2);
      }
      for (const sx of [-0.47, 0.47]) {
        link(THREE, r, p.steel, [sx, 0.62, -0.70], [sx, 0.99, -0.70], 0.019);
        link(THREE, r, p.steel, [sx, 0.62, 0.65], [sx, 0.99, 0.65], 0.019);
        link(THREE, r, p.steel, [sx, 0.99, -0.70], [sx, 0.99, 0.65], 0.019);
      }
      cyl(THREE, r, p.steel, 0.68, 1.02, -0.70, 0.016, 0.016, 1.99);
      link(THREE, r, p.steel, [0.51, 1.99, -0.70], [0.86, 1.99, -0.70], 0.012);
      bevel(THREE, r, p.cloth, 0.59, 1.80, -0.70, 0.13, 0.24, 0.055, 0.011);
      link(THREE, r, p.dark, [0.59, 1.65, -0.70], [0.35, 0.82, -0.59], 0.004);
      // The IV stand must not turn the entire mattress into a two-metre wall.
            mark(x, z, 1.04, 2.12, covered ? 1.2 : 1.01);
            mark(x + 0.69, z - 0.70, 0.38, 0.10, 2.02);
    }

    function consoleDesk(x, z, wide) {
      const w = wide ? 1.9 : 1.2, r = joint(THREE, g, 'workbench', x, 0, z);
      bevel(THREE, r, p.steel, 0, 0.83, 0, w, 0.065, 0.72, 0.016);
      for (const sx of [-w * 0.42, w * 0.42]) box(THREE, r, p.dark, sx, 0.40, 0, 0.066, 0.80, 0.61);
      bevel(THREE, r, p.black, 0.12, 1.19, -0.16, 0.58, 0.39, 0.055, 0.012, -0.13);
      const screenMat = label(THREE, 'terminal', ['WARD ADMISSIONS', 'TRANSFER LIST / INCOMPLETE', 'BEDS OCCUPIED: 12', 'DISCHARGES: 00'], '#647568', '#101714');
      screenMat.emissive.set(0x243327); screenMat.emissiveMap = screenMat.map; screenMat.emissiveIntensity = 0.07;
      add(THREE, r, geometry(THREE, 'terminalPlane', () => new THREE.PlaneGeometry(0.53, 0.33)), screenMat,
        0.12, 1.19, -0.126, 1, 1, 1, -0.13);
      box(THREE, r, p.dark, 0.12, 0.96, -0.16, 0.07, 0.24, 0.06);
      bevel(THREE, r, p.black, 0.12, 0.88, 0.16, 0.43, 0.029, 0.16, 0.008, 0.08);
      for (let i = 0; i < 6; i++) box(THREE, r, p.steel, -0.05 + i * 0.066, 0.898, 0.16, 0.042, 0.003, 0.09);
      if (wide) {
        bevel(THREE, r, p.paint, -0.67, 1.06, -0.15, 0.29, 0.40, 0.31, 0.016);
        for (let i = 0; i < 4; i++) box(THREE, r, p.dark, -0.67, 1.07 + i * 0.038, 0.009, 0.21, 0.014, 0.003);
        oval(THREE, r, p.paint, -0.70, 0.94, 0.014, 0.008, 0.008, 0.003);
      }
      mark(x, z, w, 0.82, 0.90);
    }

    function generator(x, z) {
      const r = joint(THREE, g, 'backup generator', x, 0, z);
      bevel(THREE, r, p.dark, 0, 0.20, 0, 1.55, 0.24, 1.1, 0.04);
      cyl(THREE, r, p.paint, -0.19, 0.69, 0, 0.36, 0.36, 0.93, Math.PI / 2, 0, 0, 16);
      cyl(THREE, r, p.steel, -0.19, 0.69, 0.49, 0.28, 0.28, 0.045, Math.PI / 2, 0, 0, 16);
      for (let i = 0; i < 11; i++) ring(THREE, r, p.dark, -0.19, 0.69, -0.42 + i * 0.081, 0.365, 0.013);
      bevel(THREE, r, p.paint, 0.49, 0.88, 0, 0.37, 0.95, 0.78, 0.028);
      bevel(THREE, r, p.black, 0.49, 1.05, 0.401, 0.23, 0.22, 0.022, 0.009);
      for (let i = 0; i < 3; i++) oval(THREE, r, i === 2 ? p.rust : p.paint, 0.41 + i * 0.08, 0.91, 0.42, 0.013, 0.013, 0.006);
      for (let i = 0; i < 4; i++) box(THREE, r, p.dark, 0.49, 0.51 + i * 0.05, 0.395, 0.26, 0.018, 0.011);
      cyl(THREE, r, p.rust, -0.44, 1.45, -0.31, 0.041, 0.041, 1.5);
      link(THREE, r, p.rust, [-0.44, 2.20, -0.31], [-0.44, 2.2, -0.9], 0.041);
      for (let i = 0; i < 6; i++) box(THREE, r, i % 2 ? p.dark : p.yellow, -0.64 + i * 0.255, 0.205, 0.558, 0.25, 0.11, 0.004);
      mark(x, z, 1.62, 1.18, 1.38);
    }

    function cabinet(x, z, medical) {
      const r = joint(THREE, g, medical ? 'medical cabinet' : 'equipment cabinet', x, 0, z);
      bevel(THREE, r, p.paint, 0, 0.96, 0, 0.90, 1.88, 0.49, 0.02);
      for (const sx of [-0.216, 0.216]) {
        bevel(THREE, r, p.steel, sx, 1.00, 0.255, 0.41, 1.67, 0.025, 0.010);
        box(THREE, r, p.dark, sx * 0.25, 1.01, 0.286, 0.021, 0.19, 0.03);
        for (let i = 0; i < 6; i++) box(THREE, r, p.dark, sx, 1.48 + i * 0.035, 0.27, 0.27, 0.009, 0.005);
      }
      if (medical) {
        box(THREE, r, p.cloth, -0.216, 1.22, 0.272, 0.19, 0.19, 0.006);
        box(THREE, r, p.red, -0.216, 1.22, 0.279, 0.037, 0.13, 0.005);
        box(THREE, r, p.red, -0.216, 1.22, 0.279, 0.13, 0.037, 0.005);
      }
      mark(x, z, 0.98, 0.57, 1.90);
    }

    function curtain(x, z) {
      const r = joint(THREE, g, 'privacy curtain', x, 0, z);
      link(THREE, r, p.steel, [0, 2.48, -0.86], [0, 2.48, 0.86], 0.019);
      drape(THREE, r, p.cloth, 0, 1.47, 0, 1.65, 1.86, 0.041, Math.PI / 2);
      for (let i = 0; i < 7; i++) ring(THREE, r, p.dark, 0, 2.43, -0.72 + i * 0.24, 0.046, 0.006, 0, Math.PI / 2);
      for (const dz of [-0.85, 0.85]) link(THREE, r, p.steel, [0, 2.48, dz], [0, height - 0.05, dz], 0.008);
      mark(x, z, 0.15, 1.78, 2.50); story('privacy curtain', r);
    }

    function evidence(x, z) {
      const r = joint(THREE, g, 'discarded admission records', x, 0, z);
      for (let i = 0; i < 3; i++) {
        const paper = joint(THREE, r, 'case sheet', i * 0.09, 0.013 + i * 0.006, i * 0.06);
        paper.rotation.y = -0.32 + i * 0.41;
        box(THREE, paper, p.cloth, 0, 0, 0, 0.21, 0.004, 0.29);
        box(THREE, paper, p.rust, -0.038, 0.003, -0.09, 0.09, 0.002, 0.02);
        for (let line = 0; line < 5; line++) box(THREE, paper, p.dark, -0.005, 0.003, -0.045 + line * 0.038, line === 2 ? 0.065 : 0.14, 0.002, 0.004);
      }
      cyl(THREE, r, p.paint, -0.17, 0.04, 0.19, 0.025, 0.025, 0.10, 0, 0, 1.4);
      story('discarded evidence', r);
    }

    function belongings(x, z) {
      const r = joint(THREE, g, 'unclaimed belongings', x, 0, z);
      bevel(THREE, r, p.paint, 0, 0.13, 0, 0.47, 0.23, 0.30, 0.015);
      box(THREE, r, p.cloth, 0.07, 0.252, 0, 0.11, 0.007, 0.07);
      box(THREE, r, p.dark, 0, 0.16, 0.154, 0.14, 0.025, 0.02);
      for (const dx of [-0.10, 0.10]) oval(THREE, r, p.black, dx, 0.043, 0.36, 0.07, 0.04, 0.14, 0, dx);
      story('unclaimed belongings', r); mark(x, z + 0.15, 0.51, 0.73, 0.26);
    }

    // Furnishings stay in quadrants. Small rooms get wall dressing only rather
    // than squeezing full-size beds/colliders into the navigation crossroads.
    if (width >= 7 && depth >= 7) {
      if (type === 'infirmary' || type === 'medical') {
        bed(left + 0.1, Math.max(back + 0.7, -depth * 0.25), true);
        curtain(left + 1.20, -depth * 0.25);
        if (depth >= 8) bed(left + 0.1, depth * 0.24);
        cabinet(right, back, true); consoleDesk(right, Math.min(depth * 0.25, 1.7), false);
        placard(-width * 0.24, 2.35, -depth / 2 + 0.04, 'BLACKWATER WARD', 'TREATMENT / NO DISCHARGES');
      } else if (type === 'generator' || type === 'power') {
        generator(left + 0.25, -depth * 0.27); cabinet(right, back, false);
        if (width >= 11) { consoleDesk(right - 0.2, depth * 0.22, true); cabinet(left, depth * 0.23, false); }
        placard(-width * 0.20, 2.36, -depth / 2 + 0.04, 'AUXILIARY POWER', 'CAUTION / HIGH VOLTAGE', '#c4b776');
      } else if (type === 'archive' || type === 'storage') {
        shelf(left, -depth * 0.23, Math.PI / 2); shelf(right, -depth * 0.23, Math.PI / 2);
        if (depth > 6) { shelf(left, depth * 0.22, Math.PI / 2); shelf(right, depth * 0.22, Math.PI / 2); }
        placard(width * 0.23, 2.34, -depth / 2 + 0.04, 'PATIENT RECORDS', 'TRANSFER ORDERS / DO NOT REMOVE');
      } else if (type === 'armory') {
        cabinet(left, back, false); cabinet(right, back, false); consoleDesk(right, depth * 0.24, false);
        placard(-width * 0.22, 2.35, -depth / 2 + 0.04, 'SECURITY STORES', 'COUNT EVERY ROUND', '#c4b776');
      } else if (type === 'security' || type === 'control') {
        consoleDesk(-width * 0.23, back, true); cabinet(right, back, false);
        placard(-width * 0.23, 2.35, -depth / 2 + 0.04, 'OBSERVATION', 'NIGHT REGISTER / WARD B2');
      } else if (type === 'lounge' || type === 'shelter' || type === 'safe') {
        const x = left + 1.5, z = back + 0.3;
        bevel(THREE, g, p.dark, x, 0.34, z, 0.68, 0.14, 1.75, 0.025);
        bevel(THREE, g, p.cloth, x, 0.47, z, 0.63, 0.13, 1.7, 0.023);
        bevel(THREE, g, p.cloth, x - 0.24, 0.80, z, 0.13, 0.58, 1.7, 0.027, 0, 0, -0.12);
        for (const z0 of [-0.68, 0.68]) box(THREE, g, p.steel, x, 0.16, z + z0, 0.58, 0.30, 0.07);
        mark(x, z, 0.75, 1.85, 0.58);
        cabinet(right, back, true);
        placard(-width * 0.2, 2.34, -depth / 2 + 0.04, 'ATTENDANTS ONLY', 'PERSONAL EFFECTS / UNCLAIMED', '#aaa996');
      } else {
        shelf(left, back + 0.3, Math.PI / 2); consoleDesk(right - 0.2, back, false);
        if (width >= 11) { consoleDesk(left + 0.3, depth * 0.23, true); cabinet(right, depth * 0.23, true); }
        placard(width * 0.2, 2.32, -depth / 2 + 0.04, 'SERVICE ACCESS', 'MAINTENANCE / LEVEL B2');
      }

      evidence(right - 0.4, depth * 0.39);
      belongings(left + 0.10, depth * 0.40);
    }

    // Tide marks and irregular rising damp stay on the back wall, away from
    // doorway axes. Opaque, shallow geometry avoids decal sorting/alpha passes.
    for (const side of [-1, 1]) {
      const r = joint(THREE, g, 'water ingress', side * width * 0.34, 0, -depth / 2 + 0.018);
      const span = Math.min(1.6, width * 0.20);
      for (let i = 0; i < 18; i++) {
        const rise = 0.30 + (Math.sin(i * 2.73) + 1) * 0.19;
        box(THREE, r, p.damp, (i / 17 - 0.5) * span, rise / 2 + 0.06, 0, span / 17 + 0.005, rise, 0.006);
        box(THREE, r, p.damp, (i / 17 - 0.5) * span, 1.52 - rise / 2, 0, 0.014 + i % 3 * 0.009, rise * 1.1, 0.006);
      }
      box(THREE, r, p.rust, 0, 0.31, 0.005, span, 0.017, 0.005);
      story('water damage', r);
    }

    // One surviving tube, one dead tube; no additional light/shadow passes.
    const ceilingY = Math.min(height, 3.2) - 0.18;
    for (let i = 0; i < 2; i++) {
      link(THREE, g, i ? p.rust : p.dark, [-width / 2 + 0.06, ceilingY - i * 0.12, -depth / 2 + 0.33],
        [width / 2 - 0.06, ceilingY - i * 0.12, -depth / 2 + 0.33], 0.036 - i * 0.009);
    }
    for (let x = -width / 2 + 0.5; x < width / 2; x += 1.6) box(THREE, g, p.steel, x, ceilingY - 0.05, -depth / 2 + 0.33, 0.06, 0.29, 0.10);
    bevel(THREE, g, p.dark, 0, ceilingY + 0.025, 0, 1.38, 0.085, 0.36, 0.015);
    for (const z of [-0.08, 0.08]) {
      const lamp = cyl(THREE, g, z < 0 ? p.light : p.cloth, 0, ceilingY - 0.035, z, 0.023, 0.023, 1.19, 0, 0, Math.PI / 2);
      lamp.castShadow = false;
    }
    flattenStatic(THREE, g);
    batch(THREE, g);
    g.userData = { type, width, depth, height, colliders, dressing, direction: 'Blackwater Ward' };
    return g;
  }

  // grid[z][x]: 0 = open, 1 = wall. Rooms {x,z,w,d,door?:{x,z}}
  // use cell units; returned geometry/practicals use world metres at origin (0,0).
  // Shared source assets live for the session; disposeGroup owns merged geometry.
  function decorateWard(THREE, { grid = [], cellSize = 3, height = 3.2, rooms = [], seed = 0 } = {}) {
    const g = new THREE.Group(); g.name = 'Blackwater corridor dressing';
    g.userData = { decoration: true, practicals: [], colliders: [] };
    if (!Array.isArray(grid) || !Number.isFinite(cellSize) || cellSize < 0.5 || !Number.isFinite(height) || height < 1.5) return g;
    const s = cellSize, random = seeded(seed), excluded = new Set();
    const key = (x, z) => x + ',' + z;
    for (const r of rooms || []) {
      if (!r || ![r.x, r.z, r.w, r.d].every(Number.isInteger) || r.w <= 0 || r.d <= 0) continue;
      for (let z = Math.max(0, r.z); z < Math.min(grid.length, r.z + r.d); z++) {
        for (let x = Math.max(0, r.x); x < Math.min(grid[z]?.length || 0, r.x + r.w); x++) excluded.add(key(x, z));
      }
      if (r.door) excluded.add(key(r.door.x, r.door.z));
    }
    const corridor = (x, z) => grid[z]?.[x] === 0 && !excluded.has(key(x, z));
    const directions = [[1, 0], [0, 1], [-1, 0], [0, -1]], cells = [];
    for (let z = 0; z < grid.length; z++) for (let x = 0; x < (grid[z]?.length || 0); x++) {
      // Leave exterior thresholds bare, even when their grid cell is open.
      if (corridor(x, z) && x > 0 && z > 0 && z < grid.length - 1 && x < grid[z].length - 1) {
        cells.push({ x, z, wx: (x + 0.5) * s, wz: (z + 0.5) * s, rank: random() });
      }
    }
    if (!cells.length) return g;

    // The game exit is the east boundary opening. Never point through a room
    // or a locked isolation door; disconnected circulation gets no exit signs.
    const route = new Map(), queue = [];
    for (let z = grid.length - 1; z >= 0; z--) {
      const x = (grid[z]?.length || 0) - 1;
      if (x > 0 && corridor(x, z)) { queue.push([x, z]); route.set(key(x, z), null); break; }
    }
    for (let i = 0; i < queue.length; i++) {
      const [x, z] = queue[i];
      for (const [dx, dz] of directions) {
        const nx = x + dx, nz = z + dz, id = key(nx, nz);
        if (!corridor(nx, nz) || route.has(id)) continue;
        route.set(id, [-dx, -dz]); queue.push([nx, nz]);
      }
    }
    const p = {
      steel: standard(THREE, 'ward:steel', 0x58605c, 0.78, 0.55, 'metal'),
      paint: standard(THREE, 'ward:paint', 0x77796a, 0.92, 0.1, 'wall'),
      rail: standard(THREE, 'ward:rail', 0x414c43, 0.88, 0.05, 'wood'),
      rust: standard(THREE, 'ward:rust', 0x665044, 0.95, 0.25, 'metal'),
      grime: standard(THREE, 'ward:grime', 0x30362c, 1, 0, 'concrete'),
      paper: label(THREE, 'ward:paper', ['PATIENT TRANSFER', 'BED ____  /  WARD 04', 'DISCHARGE: PENDING'], '#55554a', '#99937c'),
      dead: standard(THREE, 'ward:dead', 0x696c5e, 0.85, 0),
      live: standard(THREE, 'ward:live', 0xc4bba4, 0.65, 0),
      left: label(THREE, 'ward:exit-left', ['< EXIT', 'BLACKWATER WARD', 'EVACUATION ROUTE'], '#b0b6a1', '#293e36'),
      right: label(THREE, 'ward:exit-right', ['EXIT >', 'BLACKWATER WARD', 'EVACUATION ROUTE'], '#b0b6a1', '#293e36')
    };
    const lampColor = 0xe6d6b5;
    p.live.emissive.setHex(lampColor); p.live.emissiveIntensity = 0.45;
    const plane = geometry(THREE, 'ward:plane', () => new THREE.PlaneGeometry(1, 1));
    const ceilingY = height - 0.16, overhead = height >= 2.95;
    const ranked = cells.slice().sort((a, b) => a.rank - b.rank), fixtures = [], signs = [];
    const spaced = (list, c, distance) => list.every(v => Math.hypot(v.wx - c.wx, v.wz - c.wz) >= distance);
    // Seeded spatial thinning avoids a luminous ceiling grid in broad cross-halls.
    if (overhead) for (const c of ranked) if (spaced(fixtures, c, Math.max(6, s * 2))) fixtures.push(c);
    const working = [], limit = Math.min(8, Math.floor(fixtures.length / 4));
    for (const c of fixtures) if (working.length < limit && spaced(working, c, Math.max(12, s * 4))) working.push(c);
    for (const c of fixtures) {
      const alongX = corridor(c.x + 1, c.z) && corridor(c.x - 1, c.z);
      const length = Math.min(1.35, s * 0.7), live = working.includes(c);
      const part = (mat, dx, y, dz, w, h, d) => box(THREE, g, mat, c.wx + (alongX ? dx : dz), y,
        c.wz + (alongX ? dz : dx), alongX ? w : d, h, alongX ? d : w);
      part(p.steel, 0, ceilingY, 0, length + 0.08, 0.075, 0.3);
      part(p.paint, 0, ceilingY - 0.042, 0, length, 0.016, 0.25);
      for (const side of [-1, 1]) {
        part(side === -1 && live ? p.live : p.dead, 0, ceilingY - 0.063, side * 0.065, length - 0.12, 0.025, 0.035);
        part(p.steel, side * (length / 2 - 0.035), ceilingY - 0.05, 0, 0.05, 0.05, 0.28);
      }
      if (live) g.userData.practicals.push({ x: c.wx, z: c.wz, color: lampColor, phase: random() * TAU });
    }

    for (const c of cells) {
      for (const [dx, dz] of directions) {
        if (grid[c.z + dz]?.[c.x + dx] !== 1) continue;
        const wx = c.wx + dx * s / 2, wz = c.wz + dz * s / 2;
        // All wall details project at most 7 cm into the navigable cell.
        const wallPart = (mat, tangent, y, inset, length, h, depth) => box(THREE, g, mat,
          wx - dz * tangent - dx * inset, y, wz + dx * tangent - dz * inset,
          dx ? depth : length, h, dx ? length : depth);
        wallPart(p.rail, 0, 0.075, 0.018, s, 0.15, 0.032);
        wallPart(p.rail, 0, 0.94, 0.046, s - 0.06, 0.095, 0.045);
        for (const t of [-s * 0.32, s * 0.32]) wallPart(p.steel, t, 0.92, 0.028, 0.055, 0.17, 0.052);
        if (overhead) {
          for (let i = 0; i < 2; i++) {
            const inset = 0.16 + i * 0.13, y = ceilingY - i * 0.055, radius = i ? 0.022 : 0.035;
            cyl(THREE, g, i ? p.rust : p.steel, wx - dx * inset, y, wz - dz * inset,
              radius, radius, s, dx ? Math.PI / 2 : 0, 0, dx ? 0 : Math.PI / 2);
            cyl(THREE, g, p.rust, wx - dx * inset, y, wz - dz * inset,
              radius + 0.008, radius + 0.008, 0.065, dx ? Math.PI / 2 : 0, 0, dx ? 0 : Math.PI / 2);
          }
          wallPart(p.steel, 0, ceilingY + 0.025, 0.21, 0.045, 0.12, 0.38);
        }
        if (random() < 0.18) {
          for (let i = 0; i < 5; i++) {
            const rise = 0.12 + random() * 0.4;
            wallPart(p.grime, (random() - 0.5) * s * 0.75, rise / 2 + 0.16, 0.003,
              Math.min(s * 0.2, 0.035 + random() * 0.12), rise, 0.004);
          }
        }
        const next = route.get(key(c.x, c.z));
        const tangent = next && -dz * next[0] + dx * next[1];
        if (height >= 2.5 && tangent && spaced(signs, c, Math.max(15, s * 5))) {
          // Local +X follows (-dz,dx); the plane normal faces away from the wall.
          add(THREE, g, plane, tangent > 0 ? p.right : p.left, wx - dx * 0.012, 2.1, wz - dz * 0.012,
            Math.min(1.35, s * 0.7), 0.6, 1, 0, Math.atan2(-dx, -dz), 0);
          signs.push(c);
        }
      }
      const wear = random();
      if (wear < 0.09) {
        const x = c.wx + (random() - 0.5) * s * 0.55, z = c.wz + (random() - 0.5) * s * 0.55;
        add(THREE, g, plane, p.paper, x, 0.006, z, Math.min(0.21, s * 0.22), Math.min(0.29, s * 0.3), 1, -Math.PI / 2, 0, random() * TAU);
      } else if (wear < 0.13) {
        const width = Math.min(0.48, s * 0.6);
        box(THREE, g, p.grime, c.wx, 0.004, c.wz, width, 0.006, width);
        for (let i = 0; i < 7; i++) box(THREE, g, p.steel, c.wx + (i - 3) * width / 8, 0.009, c.wz,
          width / 18, 0.008, width);
      }
    }
    batch(THREE, g);
    // No shadow-map draws: these thin details receive the caller's pooled light.
    g.traverse(o => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = true; } });
    return g;
  }

  function createEnvironment(THREE, renderer) {
    const res = store(THREE);
    if (res.environments.has(renderer)) return res.environments.get(renderer).texture;
    const [c, x] = canvas(512, 256);
    const gradient = x.createLinearGradient(0, 0, 0, 256);
    gradient.addColorStop(0, '#596b76'); gradient.addColorStop(0.25, '#343f46');
    gradient.addColorStop(0.52, '#171e24'); gradient.addColorStop(0.74, '#101515'); gradient.addColorStop(1, '#0a0d0d');
    x.fillStyle = gradient; x.fillRect(0, 0, 512, 256);
    // Soft ceiling strips and one warm doorway become broad, plausible PBR highlights.
    for (const [cx, width] of [[74, 64], [258, 48], [433, 70]]) {
      const glow = x.createRadialGradient(cx, 62, 2, cx, 62, 72);
      glow.addColorStop(0, 'rgba(162,185,193,.70)'); glow.addColorStop(1, 'rgba(80,105,118,0)');
      x.fillStyle = glow; x.fillRect(cx - 76, 0, 152, 146);
      x.fillStyle = '#a3bfc5'; x.fillRect(cx - width / 2, 49, width, 5);
    }
    const doorway = x.createLinearGradient(340, 0, 383, 0);
    doorway.addColorStop(0, 'rgba(110,76,46,0)'); doorway.addColorStop(0.5, 'rgba(154,118,73,.65)'); doorway.addColorStop(1, 'rgba(110,76,46,0)');
    x.fillStyle = doorway; x.fillRect(340, 91, 43, 82);
    const source = texture(THREE, c, true); source.mapping = THREE.EquirectangularReflectionMapping;
    let target;
    try {
      const pmrem = new THREE.PMREMGenerator(renderer);
      try { pmrem.compileEquirectangularShader(); target = pmrem.fromEquirectangular(source); }
      finally { pmrem.dispose(); }
      source.dispose();
    } catch (_) {
      target = { texture: source, dispose: () => source.dispose() };
    }
    target.texture.userData = Object.assign(target.texture.userData || {}, { hollowShared: true });
    res.environments.set(renderer, target); res.environmentTargets.add(target);
    const maxAnisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    for (const maps of res.maps.values()) for (const t of Object.values(maps)) t.anisotropy = maxAnisotropy;
    return target.texture;
  }

  function disposeEnvironment(THREE, renderer) {
    const res = store(THREE), target = res.environments.get(renderer);
    if (!target) return;
    target.dispose(); res.environments.delete(renderer); res.environmentTargets.delete(target);
  }

  function disposeGroup(group) {
    if (!group || group.userData.hollowDisposed) return;
    group.userData.hollowDisposed = true;
    const geometries = new Set(), materials = new Set(), maps = new Set();
    group.traverse(o => {
      if (o.geometry && !o.geometry.userData.hollowShared) geometries.add(o.geometry);
      if (o.material) for (const mat of Array.isArray(o.material) ? o.material : [o.material]) {
        if (!mat.userData.hollowShared) materials.add(mat);
      }
    });
    for (const geom of geometries) geom.dispose();
    for (const mat of materials) {
      for (const map of mat.userData.hollowOwnedMaps || []) if (!map.userData?.hollowShared) maps.add(map);
      mat.dispose();
    }
    for (const map of maps) map.dispose();
    if (group.parent) group.parent.remove(group);
  }

  global.HollowVisuals = Object.freeze({ makeMonster, makeWeapon, makeFlashlight, decorateRoom, decorateWard, enhanceMaterial, createEnvironment, disposeEnvironment, disposeGroup });
})(window);
