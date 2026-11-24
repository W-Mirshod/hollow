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
      geometries: new Map(), materials: new Map(), maps: new Map(), monsters: new Map(),
      environments: new WeakMap(), environmentTargets: new Set()
    });
    return stores.get(THREE);
  }

  function seeded(seed) {
    let v = seed >>> 0;
    return () => { v = (Math.imul(v, 1664525) + 1013904223) >>> 0; return v / 4294967296; };
  }

  // A texture worker has no DOM: it draws on an OffscreenCanvas.
  function canvas(w, h) {
    const c = typeof document === 'undefined' ? new OffscreenCanvas(w, h) : document.createElement('canvas');
    c.width = w; c.height = h;
    return [c, c.getContext('2d', { willReadFrequently: true })];
  }

  function texture(THREE, c, color) {
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
    if (color) t.colorSpace = THREE.SRGBColorSpace;
    t.userData = Object.assign(t.userData || {}, { hollowShared: true });
    return t;
  }

  function maxAnisotropy(renderer) {
    if (renderer && typeof renderer.getMaxAnisotropy === 'function') return renderer.getMaxAnisotropy();
    const capabilities = renderer && renderer.capabilities;
    return capabilities && typeof capabilities.getMaxAnisotropy === 'function' ? capabilities.getMaxAnisotropy() : 1;
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

  // ---------- tileable raster toolkit for coherent procedural PBR surfaces ----------
  // Albedo, height and roughness come from the same features, so grout, cracks, chipped paint and puddles light
  // correctly under the moving torch. Every buffer is periodic: maps tile without seams. Pure pixel math (no
  // canvas paths), so node tests see exactly the pixels a browser uploads.
  const DETAIL = { low: 0, medium: 1, high: 2 };
  let detail = 0;
  const surfaces = new Map();
  // Branch clamps: these run per pixel and must not depend on Math.max/min call overhead.
  const sat = v => v < 0 ? 0 : v > 1 ? 1 : v;
  const smoothstep = (a, b, v) => { const t = sat((v - a) / (b - a)); return t * t * (3 - 2 * t); };

  // Octaves are [cellsX, cellsY, amplitude]; unequal cell counts give streaks.
  function noiseField(n, seed, octaves) {
    const out = new Float32Array(n * n), random = seeded(seed);
    const x0 = new Int32Array(n), x1 = new Int32Array(n), sx = new Float32Array(n);
    for (const [cx, cy, amp] of octaves) {
      const lat = new Float32Array(cx * cy);
      for (let i = 0; i < lat.length; i++) lat[i] = random();
      for (let x = 0; x < n; x++) {
        const f = x * cx / n, i = Math.floor(f), t = f - i;
        x0[x] = i % cx; x1[x] = (i + 1) % cx; sx[x] = t * t * (3 - 2 * t);
      }
      for (let y = 0; y < n; y++) {
        const f = y * cy / n, j = Math.floor(f), t = f - j, sy = t * t * (3 - 2 * t);
        const r0 = (j % cy) * cx, r1 = ((j + 1) % cy) * cx, row = y * n;
        for (let x = 0; x < n; x++) {
          const s = sx[x], a = lat[r0 + x0[x]], b = lat[r0 + x1[x]], c = lat[r1 + x0[x]], d = lat[r1 + x1[x]];
          const top = a + (b - a) * s;
          out[row + x] += (top + (c + (d - c) * s - top) * sy) * amp;
        }
      }
    }
    return out;
  }

  // Bilinear periodic upsample (m -> n): cheap large-scale fields.
  function upsample(src, m, n) {
    const out = new Float32Array(n * n), k = m / n, i0 = new Int32Array(n), i1 = new Int32Array(n), tx = new Float32Array(n);
    for (let x = 0; x < n; x++) { const f = x * k, i = Math.floor(f); i0[x] = i % m; i1[x] = (i + 1) % m; tx[x] = f - i; }
    for (let y = 0; y < n; y++) {
      const r0 = i0[y] * m, r1 = i1[y] * m, ty = tx[y], row = y * n;
      for (let x = 0; x < n; x++) {
        const a = src[r0 + i0[x]], c = src[r1 + i0[x]], t = tx[x];
        const top = a + (src[r0 + i1[x]] - a) * t;
        out[row + x] = top + (c + (src[r1 + i1[x]] - c) * t - top) * ty;
      }
    }
    return out;
  }

  // Smooth bump: 1 at v = 0, 0 beyond |v| >= w (a cheap stand-in for a gaussian in per-pixel loops).
  const bump = (v, w) => { const t = v * v / (w * w); return t >= 1 ? 0 : (1 - t) * (1 - t); };

  // Anti-aliased capsule from (x0,y0) to (x1,y1), radius r px, wrapping around the tile.
  function stroke(n, x0, y0, x1, y1, r, visit) {
    const dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy || 1e-9;
    const minX = Math.floor(Math.min(x0, x1) - r - 1), maxX = Math.ceil(Math.max(x0, x1) + r + 1);
    const minY = Math.floor(Math.min(y0, y1) - r - 1), maxY = Math.ceil(Math.max(y0, y1) + r + 1);
    for (let y = minY; y <= maxY; y++) {
      const row = (((y % n) + n) % n) * n;
      for (let x = minX; x <= maxX; x++) {
        const t = sat(((x - x0) * dx + (y - y0) * dy) / l2);
        const px = x0 + t * dx - x, py = y0 + t * dy - y, cover = sat(r + 0.5 - Math.sqrt(px * px + py * py));
        if (cover > 0) visit(row + (((x % n) + n) % n), cover, t);
      }
    }
  }

  // Wandering crack with thinner side branches, max-blended into mask.
  function crack(n, random, mask, x, y, angle, steps, step, r) {
    for (let i = 0; i < steps; i++) {
      angle += (random() - 0.5) * 0.9;
      const nx = x + Math.cos(angle) * step * (0.6 + random() * 0.8), ny = y + Math.sin(angle) * step * (0.6 + random() * 0.8);
      const w = r * (1 - i / steps * 0.6);
      stroke(n, x, y, nx, ny, w, (k, c) => { if (c > mask[k]) mask[k] = c; });
      if (random() < 0.14 && steps > 4) crack(n, random, mask, nx, ny, angle + (random() < 0.5 ? 1 : -1) * (0.6 + random() * 0.7), Math.ceil(steps * 0.35), step * 0.8, r * 0.6);
      x = nx; y = ny;
    }
  }

  // Height (mm) -> tangent-space normal map; px/py are millimetres per pixel across/down the image.
  function normalPixels(h, n, px, py, out) {
    const data = out || new Uint8ClampedArray(n * n * 4), left = new Int32Array(n), right = new Int32Array(n);
    for (let x = 0; x < n; x++) { left[x] = (x + n - 1) % n; right[x] = (x + 1) % n; }
    const kx = -1 / (2 * px), ky = 1 / (2 * py);
    for (let y = 0; y < n; y++) {
      const up = left[y] * n, down = right[y] * n, row = y * n;
      for (let x = 0; x < n; x++) {
        const dx = (h[row + right[x]] - h[row + left[x]]) * kx, dy = (h[down + x] - h[up + x]) * ky;
        const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1), p = (row + x) * 4;
        data[p] = (dx * inv * 0.5 + 0.5) * 255; data[p + 1] = (dy * inv * 0.5 + 0.5) * 255;
        data[p + 2] = (inv * 0.5 + 0.5) * 255; data[p + 3] = 255;
      }
    }
    return data;
  }

  // In a texture worker (no DOM), or while settleSurfaces() paints a placeholder, a painted map stays raw RGBA pixels;
  // adoptSurface draws them on the page.
  let rawPixels = false;
  function pixelImage(w, h, data) {
    if (rawPixels || typeof document === 'undefined') return { width: w, height: h, data };
    const [c, x] = canvas(w, h), img = x.createImageData(w, h);
    img.data.set(data); x.putImageData(img, 0, 0); return c;
  }

  function pixelCanvas(n, data) { return pixelImage(n, n, data); }

  // rgb: 0..1 sRGB triplets; rough: 0..1; height: mm. Returns the canvas triplet the materials consume.
  function surfaceCanvases(n, rgb, rough, height, px, py, strength) {
    if (strength && strength !== 1) for (let i = 0; i < n * n; i++) height[i] *= strength;
    const albedo = new Uint8ClampedArray(n * n * 4), r = new Uint8ClampedArray(n * n * 4);
    for (let i = 0, p = 0; i < n * n; i++, p += 4) {
      albedo[p] = rgb[i * 3] * 255; albedo[p + 1] = rgb[i * 3 + 1] * 255; albedo[p + 2] = rgb[i * 3 + 2] * 255; albedo[p + 3] = 255;
      const v = rough[i]; r[p] = r[p + 1] = r[p + 2] = (v < 0.03 ? 0.03 : v > 1 ? 1 : v) * 255; r[p + 3] = 255;
    }
    return { albedo: pixelCanvas(n, albedo), normal: pixelCanvas(n, normalPixels(height, n, px, py)), roughness: pixelCanvas(n, r), size: n };
  }

  // Blackwater ward wall, one 3 m wide x 3.2 m tall face (image top = ceiling). Matte cream upper paint with an
  // oxblood way-finding stripe, glossy teal enamel wainscot under the chair rail, a dark baseboard, rising damp,
  // soot, ceiling leaks with tide marks, rust runs under pipes and brackets, peeling paint, cracks and trolley scuffs.
  function wardWall(n, seed) {
    const N = n * n, random = seeded(seed * 7919 + 17), at = y => 3.2 * (1 - (y + 0.5) / n);
    const D = noiseField(n, seed + 1, [[48, 48, 0.3], [140, 140, 0.35], [360, 360, 0.35]]);
    const q = n >> 2, M = upsample(noiseField(q, seed + 2, [[3, 3, 0.42], [7, 7, 0.3], [17, 17, 0.17], [41, 41, 0.11]]), q, n);
    const S = noiseField(n, seed + 3, [[40, 3, 0.55], [104, 5, 0.45]]);
    const cracks = new Float32Array(N), rust = new Float32Array(N);
    for (let i = 0; i < 5; i++) crack(n, random, cracks, random() * n, n * (0.1 + random() * 0.55), Math.PI * (0.3 + random() * 0.4), 9 + (random() * 9 | 0), n * 0.018, Math.max(0.6, n / 1100));
    // Rust runs below the ceiling pipes and the chair-rail brackets (decorateWard puts them at 0.18/0.82 of a cell):
    // tapered, streaky columns that fade as they run down.
    const runs = [[0.18, 0.89, 0.22], [0.82, 0.89, 0.18], [0.12 + random() * 0.3, 2.96, 0.9], [0.55 + random() * 0.35, 2.96, 0.6]];
    for (const [cx, from, len] of runs) {
      const y0 = Math.round(n * (1 - from / 3.2)), y1 = Math.min(n - 1, Math.round(n * (1 - (from - len) / 3.2))), w0 = n * (0.006 + random() * 0.006);
      for (let y = y0; y <= y1; y++) {
        const t = (y - y0) / Math.max(1, y1 - y0), w = w0 * (1.15 - 0.75 * t) * (0.7 + 0.6 * S[y * n + (cx * n | 0)]);
        const fade = Math.pow(1 - t, 0.8) * sat((y - y0) / (n * 0.01));
        for (let x = Math.floor(cx * n - w * 3); x <= Math.ceil(cx * n + w * 3); x++) {
          const k = y * n + ((x % n) + n) % n, dx = Math.abs(x - cx * n) / w;
          const v = (dx < 1 ? 1 - dx * dx * 0.6 : dx < 3 ? 0.4 * (3 - dx) / 2 : 0) * fade * (0.45 + 0.55 * S[k]);
          if (v > rust[k]) rust[k] = v;
        }
      }
    }
    const rgb = new Float32Array(N * 3), rough = new Float32Array(N), height = new Float32Array(N);
    const peelShift = (n * 0.37 | 0) + (n * 0.61 | 0) * n, stainShift = (n * 0.71 | 0) + (n * 0.19 | 0) * n;
    for (let y = 0; y < n; y++) {
      const hm = at(y), upper = hm >= 1.02, base = hm < 0.12;
      const stripe = smoothstep(1.295, 1.3, hm) * (1 - smoothstep(1.375, 1.38, hm));
      const soot = smoothstep(2.35, 3.2, hm), damp0 = 1 - smoothstep(0.12, 0.62, hm), leak = smoothstep(1.5, 3.1, hm);
      for (let x = 0; x < n; x++) {
        const i = y * n + x, d = D[i], m = M[i], s = S[i];
        const mp = M[(i + peelShift) % N], ms = M[(i + stainShift) % N];
        let r, g, b, ro, h = (d - 0.5) * 1.4;
        if (base) { r = 0.085; g = 0.095; b = 0.088; ro = 0.48; h += 1.2; }
        else if (upper) { r = 0.62; g = 0.61; b = 0.54; ro = 0.86 + (d - 0.5) * 0.1; }
        else { r = 0.19; g = 0.27; b = 0.25; ro = 0.3 + (d - 0.5) * 0.08; h += 0.7 - (d - 0.5) * 0.9; }
        if (stripe > 0) { r += (0.34 - r) * stripe; g += (0.1 - g) * stripe; b += (0.085 - b) * stripe; ro += (0.55 - ro) * stripe; h += 0.35 * stripe - (d - 0.5) * 0.7 * stripe; }
        const grain = 1 + (d - 0.5) * 0.16;
        r *= grain; g *= grain; b *= grain;
        // Peeling paint: exposed plaster with a raised, curled paint lip and a shadowed inner edge.
        if (!base) {
          const t = upper ? 0.64 - 0.1 * leak : 0.71, pv = mp * 0.82 + d * 0.18;
          const inside = smoothstep(t, t + 0.006, pv), lip = bump(pv - t, 0.012), shade = bump(pv - t - 0.012, 0.012);
          if (inside > 0 || lip > 0.01) {
            const plaster = 0.5 + (d - 0.5) * 0.22;
            r += (plaster * 1.03 - r) * inside; g += (plaster * 0.97 - g) * inside; b += (plaster * 0.85 - b) * inside;
            ro += (0.95 - ro) * inside; h += -1.1 * inside + 0.7 * lip;
            const dk = 0.3 * shade * inside + 0.12 * lip * (1 - inside);
            r *= 1 - dk; g *= 1 - dk; b *= 1 - dk;
          }
        }
        // Large-scale grime and soot from years of trolleys, hands and a failing boiler.
        const grime = smoothstep(0.3, 0.78, m) * 0.34 + soot * (0.35 + 0.35 * mp);
        r *= 1 - grime; g *= 1 - grime * 1.02; b *= 1 - grime * 1.08;
        // Leaks from the ceiling: stain interior plus a hard tide line and a fainter older one.
        const sv = ms + leak * 0.32 - 0.28 + (d - 0.5) * 0.05;
        if (sv > 0.34) {
          const inside = smoothstep(0.36, 0.42, sv), tide = bump(sv - 0.415, 0.016) + 0.45 * bump(sv - 0.5, 0.014);
          r *= 1 - 0.16 * inside; g *= 1 - 0.22 * inside; b *= 1 - 0.36 * inside;
          r *= 1 - 0.28 * tide; g *= 1 - 0.34 * tide; b *= 1 - 0.46 * tide;
          ro -= 0.12 * inside; h -= 0.25 * tide;
        }
        // Drips run down from the leaks; fresh ones are still wet.
        const drip = smoothstep(0.6, 0.8, s) * smoothstep(0.25, 0.6, ms + leak * 0.3) * (0.4 + 0.6 * leak);
        if (drip > 0) { r *= 1 - 0.42 * drip; g *= 1 - 0.45 * drip; b *= 1 - 0.5 * drip; ro -= 0.4 * drip * (0.4 + 0.6 * smoothstep(0.5, 0.8, mp)); h += 0.2 * drip; }
        // Chips and gurney scuffs through the wainscot enamel.
        if (!upper && !base) {
          // Trolley bumpers scrape a band at 0.4-0.65 m: pale abrasions and black rubber, both streaky.
          const band = smoothstep(0.38, 0.45, hm) * (1 - smoothstep(0.6, 0.68, hm)), st = S[x * n + y];
          const pale = smoothstep(0.66, 0.8, st) * band * (0.4 + 0.6 * m), rubber = smoothstep(0.7, 0.86, S[((x + (n >> 1)) % n) * n + y]) * band;
          if (pale > 0) { r += (0.4 - r) * pale * 0.65; g += (0.4 - g) * pale * 0.65; b += (0.36 - b) * pale * 0.65; ro += (0.75 - ro) * pale; h -= 0.35 * pale; }
          if (rubber > 0) { r *= 1 - 0.55 * rubber; g *= 1 - 0.55 * rubber; b *= 1 - 0.52 * rubber; ro += (0.55 - ro) * rubber; }
          const chip = smoothstep(0.83, 0.86, D[(i + stainShift) % N] * 0.55 + s * 0.45 + (1.02 - hm) * 0.05);
          if (chip > 0) { r += (0.58 - r) * chip; g += (0.55 - g) * chip; b += (0.48 - b) * chip; ro += (0.92 - ro) * chip; h -= 0.9 * chip; }
        }
        // Rising damp with a crust of salt at its wavy top edge.
        const dampEdge = damp0 * (0.55 + 0.45 * m);
        if (dampEdge > 0.01 && !base) {
          const dmp = smoothstep(0.25, 0.6, dampEdge), salt = bump(dampEdge - 0.3, 0.06) * (0.5 + 0.5 * d);
          r *= 1 - 0.38 * dmp; g *= 1 - 0.36 * dmp; b *= 1 - 0.32 * dmp; ro -= 0.25 * dmp * (upper ? 1 : 0.4);
          r += (0.62 - r) * salt * 0.3; g += (0.61 - g) * salt * 0.3; b += (0.57 - b) * salt * 0.3; h += 0.4 * salt;
        }
        const ru = rust[i];
        if (ru > 0) { const v = Math.min(1, ru) * 0.85; r += (0.3 - r) * v; g += (0.14 - g) * v; b += (0.065 - b) * v; ro += (0.9 - ro) * v; h += 0.25 * v; }
        const c = cracks[i];
        if (c > 0) { r *= 1 - 0.6 * c; g *= 1 - 0.62 * c; b *= 1 - 0.64 * c; ro += (0.95 - ro) * c; h -= 2.2 * c; }
        rgb[i * 3] = sat(r); rgb[i * 3 + 1] = sat(g); rgb[i * 3 + 2] = sat(b);
        rough[i] = ro; height[i] = h;
      }
    }
    return surfaceCanvases(n, rgb, rough, height, 3000 / n, 3200 / n, 1.6);
  }

  // One 3 m floor cell of 37.5 cm institutional tiles: muted cream / grey-green checker, terrazzo flecks, grimy
  // grout, bevelled and slightly tilted tiles (so reflections break up), cracks, chipped corners, one missing tile,
  // dried stains and broad standing water that turns tiles into dark glossy mirrors.
  function wardFloor(n, seed) {
    const N = n * n, T = 8, tile = n / T, random = seeded(seed * 104729 + 3);
    const D = noiseField(n, seed + 1, [[64, 64, 0.25], [192, 192, 0.35], [n >> 1, n >> 1, 0.4]]);
    const q = n >> 2, M = upsample(noiseField(q, seed + 2, [[3, 3, 0.45], [6, 6, 0.3], [13, 13, 0.15], [29, 29, 0.1]]), q, n);
    const cracks = new Float32Array(N);
    const tiles = [];
    const pitch = 3000 / n;
    for (let i = 0; i < T * T; i++) tiles.push({ tone: (random() - 0.5) * 0.1, tx: (random() - 0.5) * 0.03 * pitch, ty: (random() - 0.5) * 0.03 * pitch,
      chip: random() < 0.22 ? (random() * 4 | 0) : -1, missing: false, worn: random() });
    tiles[(1 + random() * (T - 2) | 0) * T + (1 + random() * (T - 2) | 0)].missing = true;
    for (let i = 0; i < 6; i++) {
      const tx = random() * T | 0, ty = random() * T | 0;
      crack(n, random, cracks, (tx + 0.1 + random() * 0.8) * tile, (ty + 0.1 + random() * 0.8) * tile, random() * Math.PI * 2, 5 + (random() * 5 | 0), tile * 0.16, Math.max(0.55, n / 1100));
    }
    const gw = Math.max(1.1, tile * 0.03), bevel = Math.max(1.5, tile * 0.05);
    const rgb = new Float32Array(N * 3), rough = new Float32Array(N), height = new Float32Array(N);
    const wetShift = (n * 0.43 | 0) + (n * 0.29 | 0) * n, stainShift = (n * 0.13 | 0) + (n * 0.77 | 0) * n;
    for (let y = 0; y < n; y++) {
      const ty = Math.floor(y / tile), ly = y + 0.5 - ty * tile;
      for (let x = 0; x < n; x++) {
        const i = y * n + x, tx = Math.floor(x / tile), lx = x + 0.5 - tx * tile, info = tiles[ty * T + tx];
        const d = D[i], m = M[i], mw = M[(i + wetShift) % N], mst = M[(i + stainShift) % N];
        const edge = Math.min(lx, tile - lx, ly, tile - ly);
        const grout = 1 - smoothstep(gw * 0.5, gw * 0.5 + 1, edge);
        let r, g, b, ro, h;
        if (info.missing) {
          // Bare screed with trowel ridges of old adhesive.
          const ridge = 0.5 + 0.5 * Math.sin((lx + ly) * 0.9);
          r = 0.26 + d * 0.08; g = 0.24 + d * 0.07; b = 0.2 + d * 0.06; ro = 0.93; h = -3 + ridge * 0.35 + (d - 0.5) * 0.4;
          r *= 0.85 + ridge * 0.15; g *= 0.85 + ridge * 0.15; b *= 0.85 + ridge * 0.15;
        } else {
          const cream = (tx + ty) & 1, tone = 1 + info.tone + (d - 0.5) * 0.08;
          r = (cream ? 0.6 : 0.29) * tone; g = (cream ? 0.58 : 0.325) * tone; b = (cream ? 0.51 : 0.305) * tone;
          // Terrazzo flecks.
          const fleck = D[(i * 7 + 13) % N];
          if (fleck > 0.83) { const v = (fleck - 0.83) * 5; r += 0.18 * v; g += 0.17 * v; b += 0.15 * v; }
          else if (fleck < 0.16) { const v = (0.16 - fleck) * 5; r *= 1 - 0.45 * v; g *= 1 - 0.45 * v; b *= 1 - 0.42 * v; }
          ro = 0.44 + (d - 0.5) * 0.1 + info.worn * 0.12;
          const bev = smoothstep(gw * 0.5, gw * 0.5 + bevel, edge);
          h = -0.9 * (1 - bev) + (lx - tile / 2) * info.tx + (ly - tile / 2) * info.ty + (d - 0.5) * 0.12;
          // Dirt packed along tile edges.
          const rim = (1 - smoothstep(gw, gw + tile * 0.14, edge)) * (0.45 + 0.55 * m);
          r *= 1 - 0.38 * rim; g *= 1 - 0.38 * rim; b *= 1 - 0.36 * rim; ro += 0.18 * rim;
          if (info.chip >= 0) {
            const cx = info.chip & 1 ? tile : 0, cy = info.chip & 2 ? tile : 0;
            const chip = 1 - smoothstep(tile * 0.13, tile * 0.13 + 1.2, Math.hypot(lx - cx, ly - cy) + (d - 0.5) * tile * 0.08);
            if (chip > 0) { r += (0.2 - r) * chip; g += (0.19 - g) * chip; b += (0.16 - b) * chip; ro += (0.95 - ro) * chip; h -= 1.6 * chip; }
          }
        }
        if (grout > 0) { r += (0.12 - r) * grout; g += (0.115 - g) * grout; b += (0.1 - b) * grout; ro += (0.94 - ro) * grout; h += (-1.8 + (d - 0.5) * 0.3 - h) * grout; }
        const grime = smoothstep(0.32, 0.8, m) * 0.36;
        r *= 1 - grime; g *= 1 - grime; b *= 1 - grime * 1.06; ro += grime * 0.12;
        // Dried stains: rust-brown and blackened blood.
        const st = smoothstep(0.7, 0.735, mst + (d - 0.5) * 0.06) + smoothstep(0.86, 0.9, D[(i * 11 + 5) % N]) * smoothstep(0.6, 0.68, mst);
        if (st > 0) { const v = Math.min(1, st) * 0.75; r += (0.16 - r) * v; g += (0.06 - g) * v; b += (0.045 - b) * v; ro += (0.62 - ro) * v; }
        const c = cracks[i] * (info.missing ? 0 : 1);
        if (c > 0) { r *= 1 - 0.65 * c; g *= 1 - 0.65 * c; b *= 1 - 0.65 * c; ro += (0.95 - ro) * c; h -= 1.1 * c; }
        // Standing water: darker, near-mirror, and flat (it fills grout and cracks).
        const wv = mw + (d - 0.5) * 0.035, wet = smoothstep(0.585, 0.64, wv);
        if (wet > 0) {
          const damp = smoothstep(0.52, 0.585, wv) * (1 - wet);
          r *= 1 - 0.5 * wet - 0.18 * damp; g *= 1 - 0.48 * wet - 0.18 * damp; b *= 1 - 0.44 * wet - 0.16 * damp;
          ro += (0.05 - ro) * wet; ro -= 0.15 * damp; h += (-0.9 - h) * wet * 0.92;
        } else {
          const damp = smoothstep(0.52, 0.585, wv);
          r *= 1 - 0.18 * damp; g *= 1 - 0.18 * damp; b *= 1 - 0.16 * damp; ro -= 0.15 * damp;
        }
        rgb[i * 3] = sat(r); rgb[i * 3 + 1] = sat(g); rgb[i * 3 + 2] = sat(b);
        rough[i] = ro; height[i] = h;
      }
    }
    return surfaceCanvases(n, rgb, rough, height, 3000 / n, 3000 / n, 1.4);
  }

  // One 3 m ceiling cell of 60 cm acoustic tiles in a rusting T-bar grid: fissured board, sagging and water-ringed
  // tiles, black mould, a broken corner and one missing tile opening onto the dark void above.
  function wardCeiling(n, seed) {
    const N = n * n, T = 5, tile = n / T, random = seeded(seed * 15485863 + 7);
    const D = noiseField(n, seed + 1, [[60, 60, 0.5], [150, 150, 0.5]]);
    const q = n >> 2, M = upsample(noiseField(q, seed + 2, [[3, 3, 0.45], [7, 7, 0.3], [15, 15, 0.15], [33, 33, 0.1]]), q, n);
    const F = noiseField(n, seed + 3, [[24, 24, 0.6], [52, 52, 0.4]]);
    const tiles = [];
    for (let i = 0; i < T * T; i++) tiles.push({ sag: random() * random() * 5, tone: (random() - 0.5) * 0.12, missing: false, broken: random() < 0.12 });
    tiles[(random() * T | 0) * T + (random() * T | 0)].missing = true;
    const bar = Math.max(1.5, tile * 0.04);
    const rgb = new Float32Array(N * 3), rough = new Float32Array(N), height = new Float32Array(N);
    const stainShift = (n * 0.33 | 0) + (n * 0.57 | 0) * n;
    for (let y = 0; y < n; y++) {
      const ty = Math.floor(y / tile), ly = y + 0.5 - ty * tile;
      for (let x = 0; x < n; x++) {
        const i = y * n + x, tx = Math.floor(x / tile), lx = x + 0.5 - tx * tile, info = tiles[ty * T + tx];
        const d = D[i], m = M[i], ms = M[(i + stainShift) % N];
        const edge = Math.min(lx, tile - lx, ly, tile - ly), tbar = 1 - smoothstep(bar * 0.5, bar * 0.5 + 1, edge);
        const u = lx / tile * 2 - 1, v = ly / tile * 2 - 1;
        let r, g, b, ro, h;
        const hole = info.missing || (info.broken && u + v > 1.15 + (d - 0.5) * 0.25);
        if (hole) { r = 0.02; g = 0.018; b = 0.016; ro = 1; h = -22; }
        else {
          const fissure = (1 - smoothstep(0.006, 0.022, Math.abs(F[i] - 0.5))) * smoothstep(0.48, 0.62, D[(i * 13 + 29) % N]);
          const base = 0.5 + info.tone + (d - 0.5) * 0.08;
          r = base; g = base * 0.97; b = base * 0.88; ro = 0.95;
          r *= 1 - 0.35 * fissure; g *= 1 - 0.35 * fissure; b *= 1 - 0.35 * fissure;
          h = info.sag * (1 - u * u) * (1 - v * v) - 0.35 * fissure + (d - 0.5) * 0.12;
          // Water rings and mould.
          const sv = ms + info.sag * 0.03;
          if (sv > 0.55) {
            const inside = smoothstep(0.55, 0.6, sv), ring = bump(sv - 0.6, 0.02) + 0.6 * bump(sv - 0.68, 0.017);
            r *= 1 - 0.16 * inside - 0.28 * ring; g *= 1 - 0.22 * inside - 0.34 * ring; b *= 1 - 0.34 * inside - 0.44 * ring;
            const mould = smoothstep(0.74, 0.8, D[(i * 5 + 3) % N] * 0.45 + sv * 0.6) * 0.8;
            r *= 1 - 0.8 * mould; g *= 1 - 0.76 * mould; b *= 1 - 0.8 * mould;
          }
        }
        if (tbar > 0) {
          const rustSpot = smoothstep(0.62, 0.75, m * 0.6 + d * 0.4);
          r += (0.42 - r) * tbar; g += (0.41 - g) * tbar; b += (0.38 - b) * tbar; ro += (0.48 - ro) * tbar; h += (2.5 - h) * tbar;
          r += (0.3 - r) * rustSpot * tbar; g += (0.15 - g) * rustSpot * tbar; b += (0.07 - b) * rustSpot * tbar; ro += 0.35 * rustSpot * tbar;
        }
        const grime = smoothstep(0.35, 0.85, m) * 0.4;
        r *= 1 - grime; g *= 1 - grime; b *= 1 - grime;
        rgb[i * 3] = sat(r); rgb[i * 3 + 1] = sat(g); rgb[i * 3 + 2] = sat(b);
        rough[i] = ro; height[i] = h;
      }
    }
    return surfaceCanvases(n, rgb, rough, height, 3000 / n, 3000 / n, 1.8);
  }

  // Three independent smooth periodic fields (R standing water, G grime, B gloss) for world-space sampling: large-scale
  // wear that never repeats with the 3 m surface maps. Returned as {map} (raw data, not colour).
  function wardMacro(n, seed) {
    const data = new Uint8ClampedArray(n * n * 4);
    [[[3, 3, 0.45], [6, 6, 0.3], [13, 13, 0.17], [29, 29, 0.08]], [[2, 2, 0.4], [5, 5, 0.33], [11, 11, 0.17], [23, 23, 0.1]],
      [[4, 4, 0.5], [9, 9, 0.3], [21, 21, 0.2]]].forEach((octaves, c) => {
      const f = noiseField(n, seed + 11 + c, octaves);
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < f.length; i++) { if (f[i] < lo) lo = f[i]; if (f[i] > hi) hi = f[i]; }
      for (let i = 0; i < f.length; i++) data[i * 4 + c] = (f[i] - lo) / (hi - lo || 1) * 255;
    });
    for (let i = 3; i < data.length; i += 4) data[i] = 255;
    return { map: pixelCanvas(n, data), size: n };
  }

  // Corridor decals: one alpha-tested atlas of 4 x 2 square tiles, t px each (see DECAL). Alpha is coverage, so the
  // decals draw in the opaque pass without sorting; heights (mm) emboss blood and paint and sink the claw gouges.
  // Image up = up on walls and forward on floors.
  const DECAL = { smear: 0, hands: 1, splatter: 2, trail: 3, hazard: 4, pool: 5, claws: 6, steps: 7 };
  function wardDecals(t, seed) {
    const w = t * 4, h = t * 2, N = w * h, random = seeded(seed * 48271 + 11);
    const A = new Float32Array(N), C = new Float32Array(N * 3), R = new Float32Array(N).fill(1), Hm = new Float32Array(N);
    const E = noiseField(t, seed + 1, [[5, 5, 0.4], [11, 11, 0.3], [27, 27, 0.3]]);
    const S = noiseField(t, seed + 2, [[3, 30, 0.6], [6, 60, 0.4]]), V = noiseField(t, seed + 3, [[30, 3, 0.6], [60, 6, 0.4]]);
    const edge = (d, e, soft) => smoothstep(1 + soft, 1 - soft, d + (e - 0.5) * 0.55);
    // Ellipse distance (1 on the outline); c/s rotate it.
    const ell = (u, v, cx, cy, rx, ry, c, s) => {
      const x = u - cx, y = v - cy, p = (x * c + y * s) / rx, q = (y * c - x * s) / ry;
      return Math.sqrt(p * p + q * q);
    };
    // Capsule distance (1 on the outline).
    const seg = (u, v, x0, y0, dx, dy, l2, r) => {
      let k = ((u - x0) * dx + (v - y0) * dy) / l2; k = k < 0 ? 0 : k > 1 ? 1 : k;
      const px = x0 + dx * k - u, py = y0 + dy * k - v;
      return Math.sqrt(px * px + py * py) / r;
    };
    const capsule = (x0, y0, x1, y1, r) => [x0, y0, x1 - x0, y1 - y0, (x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0) || 1e-9, r];
    // o = [alpha, r, g, b, roughness, height]. Fresh blood is dark, glossy and raised; dried blood is browner and matte.
    const o = new Float32Array(6);
    const blood = (a, fresh, e) => {
      const k = sat(fresh + (e - 0.5) * 0.4);
      o[0] = a; o[1] = 0.16 + 0.15 * k; o[2] = 0.035 - 0.012 * k; o[3] = 0.03 - 0.008 * k; o[4] = 0.6 - 0.44 * k; o[5] = 0.1 + 0.25 * k * a;
      return a;
    };
    const paint = (tile, fn) => {
      const ox = (tile & 3) * t, oy = (tile >> 2) * t, sx = tile * 37 % t, sy = tile * 61 % t;
      for (let y = 0; y < t; y++) for (let x = 0; x < t; x++) {
        const l = ((y + sy) % t) * t + (x + sx) % t;
        if (!(fn((x + 0.5) / t, (y + 0.5) / t, E[l], S[l], V[l]) > 0.02)) continue;
        const i = (oy + y) * w + ox + x;
        A[i] = o[0]; C[i * 3] = o[1]; C[i * 3 + 1] = o[2]; C[i * 3 + 2] = o[3]; R[i] = o[4]; Hm[i] = o[5];
      }
    };
    // Runs: [x, top, length, radius] -> a tapering line with a bead at its end.
    const drips = list => (u, v, e) => {
      let a = 0;
      for (let j = 0; j < list.length; j++) {
        const [x, y0, len, r] = list[j];
        if (v < y0 || v > y0 + len + r * 2 || Math.abs(u - x) > r * 2) continue;
        const k = (v - y0) / len, wid = r * (1 - 0.45 * (k < 1 ? k : 1)) * (0.85 + 0.3 * e);
        if (k <= 1) a = Math.max(a, smoothstep(wid + 0.004, wid - 0.002, Math.abs(u - x)));
        a = Math.max(a, smoothstep(1.15, 0.85, ell(u, v, x, y0 + len, r * 1.25, r * 1.6, 1, 0)));
      }
      return a;
    };
    // 0: a hand wiped along the wall, thinning into streaks, with runs below.
    const smearDrips = drips(Array.from({ length: 4 }, (_, i) => {
      const x = 0.14 + i * 0.17 + random() * 0.08;
      return [x, 0.42 + x * 0.08 + Math.sin(x * 5) * 0.02 + 0.15 * (1 - 0.5 * x) * 0.5, 0.06 + random() * random() * 0.34, 0.0045 + random() * 0.004];
    }));
    const c3 = Math.cos(0.3), s3 = Math.sin(0.3);
    paint(DECAL.smear, (u, v, e, s) => {
      const cy = 0.42 + u * 0.08 + Math.sin(u * 5) * 0.02, hw = 0.15 * (1 - 0.5 * u);
      const band = smoothstep(hw + 0.03, hw - 0.02, Math.abs(v - cy) + (e - 0.5) * 0.05) * smoothstep(0.04, 0.12, u) * smoothstep(0.97, 0.82, u);
      const streak = band > 0 ? smoothstep(0.22 + 0.5 * u, 0.3 + 0.5 * u, s * 0.8 + e * 0.2) : 0;
      const start = u < 0.32 ? edge(ell(u, v, 0.15, 0.42, 0.1, 0.13, c3, s3), e, 0.12) : 0;
      return blood(Math.max(band * streak, start, smearDrips(u, v, e)), 0.75 - u * 0.5, e);
    });
    // 1: three hands slapped against the wall; the lowest one slid down.
    const hand = [capsule(-0.06, -0.02, -0.06 + Math.sin(-0.2) * 0.13, -0.02 - Math.cos(-0.2) * 0.13, 0.021),
      capsule(-0.02, -0.02, -0.02 + Math.sin(-0.06) * 0.155, -0.02 - Math.cos(-0.06) * 0.155, 0.021),
      capsule(0.02, -0.02, 0.02 + Math.sin(0.06) * 0.145, -0.02 - Math.cos(0.06) * 0.145, 0.021),
      capsule(0.06, -0.02, 0.06 + Math.sin(0.2) * 0.11, -0.02 - Math.cos(0.2) * 0.11, 0.021), capsule(-0.075, 0.07, -0.16, -0.01, 0.025)];
    const prints = [[0.27, 0.33, -0.25, 0.95], [0.66, 0.24, 0.3, 1.05], [0.5, 0.6, -0.08, 0.9]].map(([x, y, a, sc]) => [x, y, Math.cos(a) / sc, Math.sin(a) / sc]);
    const slide = capsule(0.5, 0.62, 0.53, 0.97, 1);
    paint(DECAL.hands, (u, v, e, s, vs) => {
      let a = 0;
      for (let j = 0; j < 3; j++) {
        const [hx, hy, c, sn] = prints[j], x = (u - hx) * c + (v - hy) * sn, y = (v - hy) * c - (u - hx) * sn;
        if (x < -0.3 || x > 0.3 || y < -0.3 || y > 0.3) continue;
        let d = ell(x, y, 0, 0.05, 0.085, 0.1, 1, 0);
        for (let f = 0; f < 5; f++) { const q = hand[f]; d = Math.min(d, seg(x, y, q[0], q[1], q[2], q[3], q[4], q[5])); }
        a = Math.max(a, edge(d, e, 0.1) * smoothstep(0.3, 0.46, e * 0.5 + vs * 0.5 + (d > 0.65 ? 0.1 : 0)));
      }
      if (v > 0.55 && u > 0.38 && u < 0.65) {
        const d = seg(u, v, slide[0], slide[1], slide[2], slide[3], slide[4], 0.07 * (1.15 - v));
        a = Math.max(a, smoothstep(1.1, 0.8, d) * smoothstep(0.35, 0.5, vs * 0.7 + e * 0.3) * smoothstep(0.98, 0.85, v));
      }
      return blood(a, 0.55, e);
    });
    // 2: an impact spray: an uneven core, radial droplets and runs.
    const drops = Array.from({ length: 48 }, () => {
      const a = random() * TAU, r = 0.13 + Math.pow(random(), 1.5) * 0.34, s = 0.003 + random() * random() * 0.014, rx = s * (1.4 + random() * 1.6);
      return [0.47 + Math.cos(a) * r, 0.4 + Math.sin(a) * r, rx, s, Math.cos(a), Math.sin(a)];
    });
    const sprayDrips = drips(Array.from({ length: 5 }, (_, i) => [0.36 + i * 0.055 + random() * 0.02, 0.45, 0.2 + random() * 0.32, 0.007 + random() * 0.006]));
    const c4 = Math.cos(0.4), s4 = Math.sin(0.4);
    paint(DECAL.splatter, (u, v, e) => {
      let a = edge(ell(u, v, 0.47, 0.4, 0.12, 0.1, c4, s4), e, 0.1);
      for (let j = 0; j < drops.length; j++) {
        const q = drops[j];
        if (Math.abs(u - q[0]) < q[2] * 1.2 && Math.abs(v - q[1]) < q[2] * 1.2) a = Math.max(a, smoothstep(1.1, 0.9, ell(u, v, q[0], q[1], q[2], q[3], q[4], q[5])));
      }
      return blood(Math.max(a, sprayDrips(u, v, e)), 0.8, e);
    });
    // 3: a body dragged along the floor (u = direction of travel on a 1.9 x 0.75 m quad): a pool, then a solid smear
    // that breaks up into parallel streaks of different lengths.
    const c1 = Math.cos(0.1), s1 = Math.sin(0.1);
    const streaks = Array.from({ length: 15 }, (_, i) => [0.5 + (i / 14 - 0.5) * 0.36 + (random() - 0.5) * 0.02,
      0.003 + random() * random() * 0.011, 0.3 + random() * 0.62]);
    paint(DECAL.trail, (u, v, e, s) => {
      const y = v - Math.sin(u * 5.5) * 0.03 - Math.sin(u * 13 + 1) * 0.008;
      let a = 0;
      if (u > 0.08 && Math.abs(y - 0.5) < 0.23) {
        a = smoothstep(0.22, 0.18, Math.abs(y - 0.5) + (e - 0.5) * 0.06) * smoothstep(0.44, 0.2, u + (s - 0.5) * 0.25);
        for (let j = 0; j < streaks.length; j++) {
          const [cy, w, len] = streaks[j], dv = Math.abs(y - cy);
          if (dv > w + 0.005 || u > len + 0.05) continue;
          a = Math.max(a, smoothstep(w + 0.004, w, dv) * smoothstep(len + 0.04, len - 0.06, u + (e - 0.5) * 0.08) * (0.75 + 0.5 * s));
        }
      }
      const pool = u < 0.32 ? edge(ell(u, v, 0.14, 0.5, 0.1, 0.21, c1, s1), e, 0.15) : 0;
      return blood(Math.max(a * (1 - u * 0.35), pool), 0.45 - u * 0.3, e);
    });
    // 4: worn diagonal yellow-black hazard paint (tiles seamlessly with itself, unmirrored).
    paint(DECAL.hazard, (u, v, e, s) => {
      const yellow = (Math.floor((u + v) * 4) & 1) === 0, wear = smoothstep(0.66, 0.74, e * 0.65 + s * 0.35), grime = smoothstep(0.35, 0.85, e) * 0.35;
      o[0] = 1 - wear; o[1] = (yellow ? 0.8 : 0.07) * (1 - grime); o[2] = (yellow ? 0.6 : 0.07) * (1 - grime); o[3] = (yellow ? 0.08 : 0.065) * (1 - grime);
      o[4] = 0.6 + grime * 0.3; o[5] = 0.06 - wear * 0.1;
      return o[0];
    });
    // 5: an old pool: dried brown rim, still-wet black centre.
    const spots = Array.from({ length: 14 }, () => { const a = random() * TAU, r = 0.36 + random() * 0.1; return [0.5 + Math.cos(a) * r, 0.5 + Math.sin(a) * r, 0.01 + random() * 0.025]; });
    const c5 = Math.cos(0.5), s5 = Math.sin(0.5);
    paint(DECAL.pool, (u, v, e) => {
      const d = ell(u, v, 0.5, 0.5, 0.33, 0.27, c5, s5) + (e - 0.5) * 0.5;
      let a = smoothstep(1.06, 0.96, d);
      for (let j = 0; j < spots.length; j++) {
        const q = spots[j];
        if (Math.abs(u - q[0]) < q[2] * 1.2 && Math.abs(v - q[1]) < q[2] * 1.2) a = Math.max(a, smoothstep(1.15, 0.85, ell(u, v, q[0], q[1], q[2], q[2], 1, 0)));
      }
      if (!(blood(a, 0.15 + smoothstep(0.85, 0.55, d) * 0.85, e) > 0.02)) return 0;
      const wet = smoothstep(0.85, 0.55, d);
      o[1] *= 1 - 0.45 * wet; o[2] *= 1 - 0.45 * wet; o[4] = 0.62 - 0.52 * wet; o[5] = 0.1 + 0.35 * wet;
      return a;
    });
    // 6: four claw gouges through paint into plaster, ragged dark rims.
    paint(DECAL.claws, (u, v, e) => {
      let a = 0, inside = 0;
      for (let i = 0; i < 4; i++) {
        const k = (v - 0.1 - i * 0.03) / 0.78;
        if (k < 0 || k > 1) continue;
        const x = 0.24 + i * 0.13 + k * 0.14 + Math.sin(k * Math.PI) * 0.035, wid = 0.004 + 0.02 * Math.sqrt(Math.sin(k * Math.PI));
        const d = Math.abs(u - x) / wid + (e - 0.5) * 0.6;
        inside = Math.max(inside, smoothstep(0.85, 0.6, d)); a = Math.max(a, smoothstep(1.7, 1.4, d));
      }
      const rim = a * (1 - inside);
      o[0] = a; o[1] = 0.58 * inside + 0.07 * rim; o[2] = 0.54 * inside + 0.065 * rim; o[3] = 0.46 * inside + 0.06 * rim; o[4] = 0.95; o[5] = -1.4 * inside + 0.15 * rim;
      return a;
    });
    // 7: bloody shoe prints walking out along u, fading step by step. Drawn in metres on a 1.5 x 0.5 m quad: forefoot,
    // the outer edge of the arch, heel and (from 256 px) a chevron tread.
    const tread = t >= 256;
    paint(DECAL.steps, (u, v, e, s, vs) => {
      const X = u * 1.5, Y = v * 0.5;
      let a = 0;
      for (let i = 0; i < 4; i++) {
        const side = i & 1 ? 1 : -1, cx = 0.2 + i * 0.37, cy = 0.25 + side * 0.085, c = Math.cos(side * 0.07), sn = Math.sin(side * 0.07);
        const x = (X - cx) * c + (Y - cy) * sn, y = ((Y - cy) * c - (X - cx) * sn) * side;
        if (x < -0.17 || x > 0.17 || y < -0.07 || y > 0.07) continue;
        const arch = x > -0.075 && x < 0.005 ? Math.abs(y - 0.024) / 0.015 : 9;
        const d = Math.min(ell(x, y, 0.055, 0.004, 0.09, 0.047, 1, 0), ell(x, y, -0.105, 0, 0.045, 0.036, 1, 0), arch);
        const bars = !tread || Math.abs((x * 31.25 + Math.abs(y) * 9 + 64) % 1 - 0.5) < 0.37 ? 1 : 0.4;
        a = Math.max(a, edge(d, e, 0.08) * bars * smoothstep(0.18 + i * 0.1, 0.3 + i * 0.1, e * 0.55 + vs * 0.45));
      }
      return blood(a, 0.25, e);
    });
    const albedo = new Uint8ClampedArray(N * 4), rough = new Uint8ClampedArray(N * 4), normal = new Uint8ClampedArray(N * 4);
    for (let i = 0, p = 0; i < N; i++, p += 4) {
      albedo[p] = sat(C[i * 3]) * 255; albedo[p + 1] = sat(C[i * 3 + 1]) * 255; albedo[p + 2] = sat(C[i * 3 + 2]) * 255; albedo[p + 3] = sat(A[i]) * 255;
      rough[p] = rough[p + 1] = rough[p + 2] = (R[i] < 0.03 ? 0.03 : R[i] > 1 ? 1 : R[i]) * 255; rough[p + 3] = 255;
    }
    // Relief within each tile (clamped at tile borders), as if a tile spans one metre.
    const mm = 1000 / t;
    for (let y = 0; y < h; y++) {
      const ty = y - y % t, yu = Math.max(ty, y - 1), yd = Math.min(ty + t - 1, y + 1);
      for (let x = 0; x < w; x++) {
        const tx = x - x % t, i = y * w + x, p = i * 4, xl = Math.max(tx, x - 1), xr = Math.min(tx + t - 1, x + 1);
        const dx = -(Hm[y * w + xr] * A[y * w + xr] - Hm[y * w + xl] * A[y * w + xl]) / ((xr - xl || 1) * mm);
        const dy = (Hm[yd * w + x] * A[yd * w + x] - Hm[yu * w + x] * A[yu * w + x]) / ((yd - yu || 1) * mm);
        const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
        normal[p] = (dx * inv * 0.5 + 0.5) * 255; normal[p + 1] = (dy * inv * 0.5 + 0.5) * 255; normal[p + 2] = (inv * 0.5 + 0.5) * 255; normal[p + 3] = 255;
      }
    }
    const make = data => pixelImage(w, h, data);
    return { albedo: make(albedo), normal: make(normal), roughness: make(rough), size: t };
  }

  // ---------- viewmodel finishes ----------
  // One periodic tile spans 10 cm of a weapon (batch() box-projects UVs), so machining marks, stipple and grain read at
  // arm's length. Albedo is a near-white modulation of the material colour; heights are millimetres.
  function finish(n, fill) {
    const N = n * n, rgb = new Float32Array(N * 3), rough = new Float32Array(N), height = new Float32Array(N);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const i = y * n + x, [v, ro, h] = fill(i, x, y);
      rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = sat(v); rough[i] = ro; height[i] = h;
    }
    return surfaceCanvases(n, rgb, rough, height, 100 / n, 100 / n, 1);
  }

  // Parkerized steel: phosphate speckle, machining lines along the bore axis, polished wear and bright scratches.
  function gunMetal(n, seed) {
    const random = seeded(seed * 2654435761 + 1), scratch = new Float32Array(n * n);
    const D = noiseField(n, seed + 1, [[64, 64, 0.45], [n >> 1, n >> 1, 0.55]]);
    const M = noiseField(n, seed + 2, [[3, 3, 0.5], [7, 7, 0.3], [15, 15, 0.2]]);
    const L = noiseField(n, seed + 3, [[2, n >> 1, 0.6], [3, n >> 2, 0.4]]);
    for (let i = 0; i < 46; i++) {
      const x = random() * n, y = random() * n, a = random() * Math.PI, len = n * (0.04 + random() * 0.18);
      stroke(n, x, y, x + Math.cos(a) * len, y + Math.sin(a) * len, 0.35 + random() * 0.4, (k, c, t) => {
        const v = c * (0.35 + 0.65 * Math.sin(t * Math.PI)); if (v > scratch[k]) scratch[k] = v;
      });
    }
    return finish(n, i => {
      const d = D[i], l = L[i], wear = smoothstep(0.6, 0.8, M[i]), s = scratch[i];
      let v = 0.8 + (d - 0.5) * 0.16 + (l - 0.5) * 0.08, ro = 0.52 + (d - 0.5) * 0.24 + (l - 0.5) * 0.12;
      v += (0.97 - v) * wear * 0.55; ro += (0.3 - ro) * wear * 0.8;
      v += (1 - v) * s; ro += (0.16 - ro) * s;
      return [v, ro, (d - 0.5) * 0.07 + (l - 0.5) * 0.06 - s * 0.09];
    });
  }

  // Stippled grip polymer, worn smooth and slightly glossy where hands rub it.
  function gunPolymer(n, seed) {
    const S = noiseField(n, seed + 1, [[48, 48, 0.35], [96, 96, 0.4], [n >> 1, n >> 1, 0.25]]);
    const M = noiseField(n, seed + 2, [[3, 3, 0.5], [8, 8, 0.3], [17, 17, 0.2]]);
    return finish(n, i => {
      const st = S[i], scuff = smoothstep(0.62, 0.82, M[i]);
      return [0.8 + (st - 0.5) * 0.2 + scuff * 0.1, 0.74 + (st - 0.5) * 0.22 - scuff * 0.26, (st - 0.5) * 0.6 * (1 - scuff * 0.7)];
    });
  }

  // Varnished walnut: thin late-wood lines, fibres and fine open pores along the stock, rubbed dull on the high spots.
  function gunWood(n, seed) {
    const G = noiseField(n, seed + 1, [[2, 24, 0.5], [3, 56, 0.3], [5, 120, 0.2]]);
    const F = noiseField(n, seed + 2, [[4, n >> 1, 0.6], [8, n >> 1, 0.4]]), P = noiseField(n, seed + 3, [[n >> 2, n >> 1, 1]]);
    const M = noiseField(n, seed + 4, [[3, 3, 0.6], [7, 7, 0.4]]);
    return finish(n, (i, x, y) => {
      const g = G[i], late = smoothstep(0.72, 1, 0.5 + 0.5 * Math.sin((y / n * 9 + g * 2.2) * TAU));
      const pore = smoothstep(0.76, 0.9, P[i]), fibre = F[i] - 0.5, rub = smoothstep(0.62, 0.8, M[i]);
      return [0.86 - late * 0.3 - pore * 0.22 + fibre * 0.12 + (g - 0.5) * 0.08, 0.38 + late * 0.08 + pore * 0.3 + rub * 0.2,
        fibre * 0.05 - late * 0.03 - pore * 0.08];
    });
  }

  function gunRubber(n, seed) {
    const D = noiseField(n, seed + 1, [[32, 32, 0.4], [n >> 1, n >> 1, 0.6]]);
    return finish(n, i => { const d = D[i]; return [0.85 + (d - 0.5) * 0.12, 0.88 + (d - 0.5) * 0.12, (d - 0.5) * 0.05]; });
  }

  // Basket-woven glove and sleeve fabric, 64 threads per 10 cm.
  function gunFabric(n, seed) {
    const D = noiseField(n, seed + 1, [[16, 16, 0.5], [n >> 1, n >> 1, 0.5]]), k = 64;
    return finish(n, (i, x, y) => {
      const u = x / n * k, v = y / n * k, fu = u - Math.floor(u), fv = v - Math.floor(v);
      const h = (Math.floor(u) + Math.floor(v)) & 1 ? Math.sin(fv * Math.PI) : Math.sin(fu * Math.PI), d = D[i];
      return [0.78 + h * 0.12 + (d - 0.5) * 0.14, 0.92 + (d - 0.5) * 0.08, h * 0.12 + (d - 0.5) * 0.04];
    });
  }

  // ---------- above ground ----------
  // Pointed-leaf (lens) or round stamp of len x wid px at (cx, cy), wrapping around the tile: fn(index, u, v, edge) for
  // every pixel inside, u along the stamp and v across it in -1..1, edge 0 on the outline and 1 on the axis.
  function stamp(n, cx, cy, len, wid, angle, round, fn) {
    const c = Math.cos(angle), s = Math.sin(angle), r = Math.ceil(Math.max(len, wid)) + 1;
    const ex = Math.ceil(Math.abs(c) * len + Math.abs(s) * wid) + 1, ey = Math.ceil(Math.abs(s) * len + Math.abs(c) * wid) + 1;
    for (let y = Math.floor(cy) - Math.min(r, ey); y <= Math.ceil(cy) + Math.min(r, ey); y++) {
      const row = (((y % n) + n) % n) * n, dy = y - cy;
      for (let x = Math.floor(cx) - Math.min(r, ex); x <= Math.ceil(cx) + Math.min(r, ex); x++) {
        const dx = x - cx, u = (dx * c + dy * s) / len, v = (dy * c - dx * s) / wid;
        const limit = round ? 1 - u * u : (1 - u * u) * (1 - u * u);
        if (limit <= 0 || v * v >= limit) continue;
        fn(row + (((x % n) + n) % n), u, v, 1 - Math.sqrt(v * v / limit));
      }
    }
  }

  // One 3 m wide x 3.2 m tall face of an overgrown box hedge (image top = hedge top): overlapping glossy leaves in
  // clumps, deep dark gaps between sprigs, a few dead leaves, and bare woody stems and leaf litter at the foot.
  function gardenHedge(n, seed) {
    const N = n * n, random = seeded(seed * 4099 + 31), mm = n / 3000;
    const rgb = new Float32Array(N * 3), rough = new Float32Array(N).fill(1), height = new Float32Array(N).fill(-38), top = new Float32Array(N).fill(-1e9);
    const q = n >> 2, M = upsample(noiseField(q, seed + 5, [[3, 3, 0.4], [8, 8, 0.35], [19, 19, 0.25]]), q, n);
    const D = noiseField(n, seed + 6, [[64, 64, 0.5], [n >> 1, n >> 1, 0.5]]);
    for (let i = 0; i < N; i++) { rgb[i * 3] = 0.012; rgb[i * 3 + 1] = 0.022; rgb[i * 3 + 2] = 0.01; }
    // Woody stems in the gaps, mostly near the foot.
    for (let i = 0; i < 70; i++) {
      const x = random() * n, y = n * (0.55 + random() * 0.45), len = n * (0.05 + random() * 0.18), a = -Math.PI / 2 + (random() - 0.5) * 1.1;
      stroke(n, x, y, x + Math.cos(a) * len, y + Math.sin(a) * len, Math.max(0.6, 7 * mm), (k, c) => {
        if (c < 0.3 || height[k] > -20) return;
        rgb[k * 3] = 0.075; rgb[k * 3 + 1] = 0.058; rgb[k * 3 + 2] = 0.038; rough[k] = 0.95; height[k] = -24 + c * 6;
      });
    }
    const count = Math.round(30000 * (n >= 512 ? 1 : 0.75));
    for (let i = 0; i < count; i++) {
      const x = random() * n, y = random() * n, k0 = (y | 0) * n + (x | 0), clump = M[k0], hm = 3.2 * (1 - y / n);
      // Thinner at the foot and in the gaps between clumps.
      const keep = smoothstep(0.08, 0.5, hm) * (0.35 + 0.9 * smoothstep(0.3, 0.62, clump));
      if (random() > keep) continue;
      const len = (20 + random() * 16) * mm, wid = len * (0.42 + random() * 0.14), angle = random() * TAU;
      const layer = (clump - 0.5) * 44 + random() * 22 - 6, dead = random() < 0.018;
      const tone = 0.75 + random() * 0.5, yellow = random() * 0.35;
      const r0 = dead ? 0.13 : (0.06 + 0.06 * yellow) * tone, g0 = dead ? 0.1 : (0.16 + 0.04 * yellow) * tone, b0 = dead ? 0.05 : 0.045 * tone;
      const lit = Math.cos(angle - 2.2) * 0.18;
      stamp(n, x, y, Math.max(0.8, len), Math.max(0.5, wid), angle, false, (k, u, v, e) => {
        const h = layer + e * 3.2 - u * 1.5;
        if (h <= top[k]) return;
        top[k] = h; height[k] = h - (Math.abs(v) < 0.12 ? 0.5 : 0);
        const shade = (1 + lit * u) * (0.82 + 0.18 * e) * (Math.abs(v) < 0.1 ? 0.8 : 1);
        rgb[k * 3] = r0 * shade; rgb[k * 3 + 1] = g0 * shade; rgb[k * 3 + 2] = b0 * shade;
        rough[k] = dead ? 0.85 : 0.42 + (1 - e) * 0.25 + D[k] * 0.12;
      });
    }
    // Leaves deep in the hedge sit in shadow; litter collects along the foot.
    for (let y = 0; y < n; y++) {
      const hm = 3.2 * (1 - (y + 0.5) / n), foot = 1 - smoothstep(0.02, 0.22, hm);
      for (let x = 0; x < n; x++) {
        const i = y * n + x, ao = 0.3 + 0.7 * smoothstep(-36, 14, height[i]), d = D[i];
        let r = rgb[i * 3] * ao, g = rgb[i * 3 + 1] * ao, b = rgb[i * 3 + 2] * ao;
        if (foot > 0) { const f = foot * (0.6 + 0.4 * d); r += (0.07 - r) * f; g += (0.055 - g) * f; b += (0.035 - b) * f; rough[i] += (0.95 - rough[i]) * f; height[i] += (-30 + d * 14 - height[i]) * f * 0.7; }
        rgb[i * 3] = sat(r); rgb[i * 3 + 1] = sat(g); rgb[i * 3 + 2] = sat(b);
      }
    }
    return surfaceCanvases(n, rgb, rough, height, 3000 / n, 3200 / n, 0.55);
  }

  // One 3 m cell of a neglected lawn: matted, overgrown blades lying in swirls, clover, moss, bare earth, fallen leaves
  // and a few pale flowers that catch the torch.
  function gardenLawn(n, seed) {
    const N = n * n, random = seeded(seed * 6151 + 7), mm = n / 3000;
    const rgb = new Float32Array(N * 3), rough = new Float32Array(N), height = new Float32Array(N), top = new Float32Array(N).fill(-1e9);
    const q = n >> 2, M = upsample(noiseField(q, seed + 2, [[3, 3, 0.45], [7, 7, 0.35], [16, 16, 0.2]]), q, n);
    const F = upsample(noiseField(q, seed + 3, [[2, 2, 0.6], [5, 5, 0.4]]), q, n), D = noiseField(n, seed + 4, [[48, 48, 0.4], [n >> 1, n >> 1, 0.6]]);
    for (let i = 0; i < N; i++) {
      const d = D[i], m = M[i];
      rgb[i * 3] = 0.058 + d * 0.025; rgb[i * 3 + 1] = 0.07 + d * 0.025 + m * 0.025; rgb[i * 3 + 2] = 0.034 + d * 0.012;
      rough[i] = 0.95; height[i] = (d - 0.5) * 4 + (m - 0.5) * 6;
    }
    const blades = Math.round(42000 * (n >= 512 ? 1 : 0.6));
    for (let i = 0; i < blades; i++) {
      const x = random() * n, y = random() * n, k0 = (y | 0) * n + (x | 0);
      if (random() > 0.15 + 0.95 * smoothstep(0.28, 0.55, M[k0])) continue;
      const a = F[k0] * TAU * 1.5 + (random() - 0.5) * 2.2, len = (40 + random() * 80) * mm;
      const layer = random() * 5 + M[k0] * 4, tone = 0.7 + random() * 0.6, dry = smoothstep(0.55, 0.85, D[k0]) * random();
      stroke(n, x, y, x + Math.cos(a) * len, y + Math.sin(a) * len, Math.max(0.55, 1.1 * mm), (k, c, t) => {
        const h = layer + t * 2.5 + c;
        if (c < 0.35 || h <= top[k]) return;
        top[k] = h; height[k] = Math.max(height[k], h);
        const tip = t * t;
        rgb[k * 3] = (0.055 + 0.1 * dry + tip * 0.04) * tone; rgb[k * 3 + 1] = (0.16 + 0.02 * dry + tip * 0.06) * tone; rgb[k * 3 + 2] = (0.04 + tip * 0.01) * tone;
        rough[k] = 0.76 + 0.16 * dry;
      });
    }
    // Clover and moss patches, then the fallen leaves and a few flowers on top.
    for (let i = 0; i < 180; i++) {
      const x = random() * n, y = random() * n, r = (9 + random() * 6) * mm;
      for (let j = 0; j < 3; j++) {
        const a = j * TAU / 3 + random() * 0.4;
        stamp(n, x + Math.cos(a) * r * 0.9, y + Math.sin(a) * r * 0.9, r, r, a, true, (k, u, v, e) => {
          const h = 7 + e * 1.5; if (h <= top[k]) return; top[k] = h; height[k] = h;
          rgb[k * 3] = 0.06; rgb[k * 3 + 1] = 0.15 + e * 0.03; rgb[k * 3 + 2] = 0.05; rough[k] = 0.68;
        });
      }
    }
    for (let i = 0; i < 40; i++) {
      const x = random() * n, y = random() * n, len = (24 + random() * 20) * mm, a = random() * TAU, rust = random();
      stamp(n, x, y, len, len * (0.6 + random() * 0.3), a, true, (k, u, v, e) => {
        const h = 9 + e * 1.2; if (h <= top[k]) return; top[k] = h; height[k] = h;
        const s = 0.8 + 0.2 * e;
        rgb[k * 3] = (0.13 + rust * 0.06) * s; rgb[k * 3 + 1] = (0.08 + rust * 0.03) * s; rgb[k * 3 + 2] = 0.035 * s; rough[k] = 0.8;
      });
    }
    for (let i = 0; i < 26; i++) {
      const x = random() * n, y = random() * n, r = (6 + random() * 4) * mm;
      for (let j = 0; j < 5; j++) {
        const a = j * TAU / 5;
        stamp(n, x + Math.cos(a) * r, y + Math.sin(a) * r, r, r * 0.5, a, true, (k, u, v, e) => {
          const h = 11 + e; if (h <= top[k]) return; top[k] = h; height[k] = h;
          rgb[k * 3] = 0.62; rgb[k * 3 + 1] = 0.6; rgb[k * 3 + 2] = 0.52; rough[k] = 0.55;
        });
      }
      stamp(n, x, y, r * 0.5, r * 0.5, 0, true, k => { top[k] = 12; height[k] = 12; rgb[k * 3] = 0.55; rgb[k * 3 + 1] = 0.42; rgb[k * 3 + 2] = 0.08; rough[k] = 0.6; });
    }
    for (let i = 0; i < N; i++) {
      const ao = 0.55 + 0.45 * smoothstep(-2, 9, height[i]);
      rgb[i * 3] = sat(rgb[i * 3] * ao); rgb[i * 3 + 1] = sat(rgb[i * 3 + 1] * ao); rgb[i * 3 + 2] = sat(rgb[i * 3 + 2] * ao);
    }
    return surfaceCanvases(n, rgb, rough, height, 3000 / n, 3000 / n, 0.8);
  }

  // One 3 m wide x 3.2 m tall face of an old churchyard wall: rubble stone laid in rough courses, deep crumbling mortar,
  // moss in the joints and along the coping, lichen rosettes, rain streaks from the top and damp at the foot.
  function graveWall(n, seed) {
    const N = n * n, random = seeded(seed * 2909 + 13), mm = n / 3000, py = 3200 / n;
    const D = noiseField(n, seed + 1, [[40, 40, 0.3], [120, 120, 0.35], [n >> 1, n >> 1, 0.35]]);
    const q = n >> 2, M = upsample(noiseField(q, seed + 2, [[3, 3, 0.4], [8, 8, 0.35], [19, 19, 0.25]]), q, n);
    const L = upsample(noiseField(q, seed + 3, [[12, 12, 0.5], [29, 29, 0.5]]), q, n), S = noiseField(n, seed + 4, [[40, 3, 0.55], [104, 5, 0.45]]);
    // Courses from the foot up (px rows, image top = wall top), each with its own stones (px columns, wrapping).
    const courses = [];
    for (let y = n; y > 0;) {
      const h = Math.min(y, Math.round((140 + random() * 240) / py));
      const stones = [];
      let x = random() * n, total = 0;
      while (total < n) { const w = Math.round((180 + random() * 440) * mm); stones.push({ x0: x + total, w: Math.min(w, n - total), tone: (random() - 0.5) * 0.11, warm: random(), bulge: 4 + random() * 9, tilt: (random() - 0.5) * 0.02 }); total += w; }
      courses.push({ y0: y - h, y1: y, stones });
      y -= h;
    }
    const rowCourse = new Int16Array(n);
    courses.forEach((c, i) => { for (let y = Math.max(0, c.y0); y < c.y1; y++) rowCourse[y] = i; });
    const joint = 16 * mm, round = 45 * mm;
    const rgb = new Float32Array(N * 3), rough = new Float32Array(N), height = new Float32Array(N);
    for (let y = 0; y < n; y++) {
      const c = courses[rowCourse[y]], hm = 3.2 * (1 - (y + 0.5) / n), dyTop = y + 0.5 - Math.max(0, c.y0), dyBot = c.y1 - y - 0.5;
      const coping = smoothstep(2.9, 3.15, hm), damp = 1 - smoothstep(0.1, 0.9, hm);
      for (let x = 0; x < n; x++) {
        const i = y * n + x, d = D[i], m = M[i];
        let st = c.stones[0], lx = 0;
        for (const s of c.stones) { const off = (((x - s.x0) % n) + n) % n; if (off < s.w) { st = s; lx = off + 0.5; break; } }
        const dx = Math.min(lx, st.w - lx), dyy = Math.min(dyTop, dyBot);
        let edge = Math.min(dx, dyy);
        if (dx < round && dyy < round) edge = round - Math.hypot(round - dx, round - dyy);
        edge += (L[i] - 0.5) * 50 * mm + (d - 0.5) * 16 * mm;
        const stone = smoothstep(joint * 0.5, joint * 0.5 + 1.2, edge);
        let r, g, b, ro, h;
        const t = 0.21 + st.tone + (d - 0.5) * 0.12, warm = st.warm;
        r = t * (1 + 0.08 * warm); g = t * (0.98 + 0.02 * warm); b = t * (0.9 - 0.06 * warm);
        ro = 0.88 + (d - 0.5) * 0.1;
        h = st.bulge * smoothstep(0, round * 1.2, edge) + (d - 0.5) * 3 + st.tilt * (lx - st.w / 2);
        if (stone < 1) {
          const mortar = 0.13 + d * 0.06;
          r += (mortar * 1.02 - r) * (1 - stone); g += (mortar - g) * (1 - stone); b += (mortar * 0.9 - b) * (1 - stone);
          ro += (0.97 - ro) * (1 - stone); h += (-11 + (d - 0.5) * 4 - h) * (1 - stone);
        }
        // Moss: in the joints and on the coping first, then over damp stone.
        const mossAmount = smoothstep(0.5, 0.75, m * 0.7 + (1 - stone) * 0.35 + coping * 0.5 + damp * 0.15);
        if (mossAmount > 0) { const v = mossAmount * (0.6 + 0.4 * d); r += (0.06 - r) * v; g += (0.085 - g) * v; b += (0.035 - b) * v; ro += (0.98 - ro) * v; h += 2.5 * v; }
        const lichen = smoothstep(0.74, 0.8, M[(i * 7 + 11) % N] * 0.5 + d * 0.5) * stone * 0.5;
        if (lichen > 0) { r += (0.34 - r) * lichen; g += (0.35 - g) * lichen; b += (0.28 - b) * lichen; h += 0.5 * lichen; }
        const grime = smoothstep(0.35, 0.8, m) * 0.4;
        r *= 1 - grime; g *= 1 - grime; b *= 1 - grime * 1.05;
        const streak = smoothstep(0.55, 0.85, S[i]) * smoothstep(1.2, 3.1, hm) * 0.5;
        r *= 1 - streak; g *= 1 - streak; b *= 1 - streak * 0.9;
        const wet = damp * (0.5 + 0.5 * m);
        r *= 1 - 0.45 * wet; g *= 1 - 0.42 * wet; b *= 1 - 0.38 * wet; ro -= 0.3 * wet;
        rgb[i * 3] = sat(r); rgb[i * 3 + 1] = sat(g); rgb[i * 3 + 2] = sat(b); rough[i] = ro; height[i] = h;
      }
    }
    return surfaceCanvases(n, rgb, rough, height, 3000 / n, 3200 / n, 1.2);
  }

  // One 3 m cell of churchyard ground: dark wet loam and trodden gravel, dead grass in tussocks, moss, fallen leaves
  // and standing water in the low spots.
  function graveSoil(n, seed) {
    const N = n * n, random = seeded(seed * 9973 + 5), mm = n / 3000;
    const rgb = new Float32Array(N * 3), rough = new Float32Array(N), height = new Float32Array(N), top = new Float32Array(N).fill(-1e9);
    const q = n >> 2, M = upsample(noiseField(q, seed + 2, [[3, 3, 0.45], [7, 7, 0.35], [15, 15, 0.2]]), q, n);
    const G = upsample(noiseField(q, seed + 3, [[2, 2, 0.5], [5, 5, 0.3], [11, 11, 0.2]]), q, n), D = noiseField(n, seed + 4, [[40, 40, 0.35], [n >> 1, n >> 1, 0.65]]);
    for (let i = 0; i < N; i++) {
      const d = D[i], m = M[i];
      rgb[i * 3] = 0.085 + d * 0.035; rgb[i * 3 + 1] = 0.068 + d * 0.028; rgb[i * 3 + 2] = 0.05 + d * 0.02;
      rough[i] = 0.92; height[i] = (m - 0.5) * 12 + (d - 0.5) * 3; top[i] = height[i];
    }
    // Gravel where the paths are trodden.
    const pebbles = Math.round(9000 * (n >= 512 ? 1 : 0.5));
    for (let i = 0; i < pebbles; i++) {
      const x = random() * n, y = random() * n, k0 = (y | 0) * n + (x | 0);
      if (random() > smoothstep(0.42, 0.62, G[k0])) continue;
      const r = (5 + random() * 10) * mm, tone = 0.11 + random() * 0.13, warm = random() * 0.03, base = height[k0];
      stamp(n, x, y, Math.max(0.6, r), Math.max(0.5, r * (0.6 + random() * 0.4)), random() * TAU, true, (k, u, v, e) => {
        const h = base + 2 + e * r / mm * 0.35; if (h <= top[k]) return; top[k] = h; height[k] = h;
        const s = 0.75 + 0.25 * e;
        rgb[k * 3] = (tone + warm) * s; rgb[k * 3 + 1] = tone * s; rgb[k * 3 + 2] = (tone - warm) * 0.95 * s; rough[k] = 0.7;
      });
    }
    // Dead grass in tussocks away from the gravel.
    const blades = Math.round(16000 * (n >= 512 ? 1 : 0.6));
    for (let i = 0; i < blades; i++) {
      const x = random() * n, y = random() * n, k0 = (y | 0) * n + (x | 0);
      if (random() > smoothstep(0.5, 0.7, M[k0]) * (1 - smoothstep(0.45, 0.6, G[k0]))) continue;
      const a = random() * TAU, len = (40 + random() * 70) * mm, tone = 0.6 + random() * 0.5, green = random() < 0.3, base = height[k0];
      stroke(n, x, y, x + Math.cos(a) * len, y + Math.sin(a) * len, Math.max(0.55, 1 * mm), (k, c, t) => {
        const h = base + 4 + t * 3; if (c < 0.35 || h <= top[k]) return; top[k] = h; height[k] = h;
        rgb[k * 3] = (green ? 0.08 : 0.2) * tone; rgb[k * 3 + 1] = (green ? 0.12 : 0.16) * tone; rgb[k * 3 + 2] = (green ? 0.04 : 0.08) * tone; rough[k] = 0.8;
      });
    }
    for (let i = 0; i < 60; i++) {
      const x = random() * n, y = random() * n, len = (28 + random() * 22) * mm, rust = random(), base = height[(y | 0) * n + (x | 0)];
      stamp(n, x, y, len, len * (0.6 + random() * 0.3), random() * TAU, true, (k, u, v, e) => {
        const h = base + 6 + e; if (h <= top[k]) return; top[k] = h; height[k] = h;
        rgb[k * 3] = 0.11 + rust * 0.05; rgb[k * 3 + 1] = 0.07 + rust * 0.025; rgb[k * 3 + 2] = 0.035; rough[k] = 0.75;
      });
    }
    // Mud in the hollows: dark and flat.
    for (let i = 0; i < N; i++) {
      const m = M[i], wet = smoothstep(0.27, 0.22, m), damp = smoothstep(0.36, 0.27, m) * (1 - wet);
      let r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
      const ao = 0.6 + 0.4 * smoothstep(-8, 8, height[i]);
      r *= ao * (1 - 0.55 * wet - 0.2 * damp); g *= ao * (1 - 0.52 * wet - 0.2 * damp); b *= ao * (1 - 0.45 * wet - 0.18 * damp);
      rough[i] += (0.86 - rough[i]) * wet; height[i] += (-5 - height[i]) * wet;
      rgb[i * 3] = sat(r); rgb[i * 3 + 1] = sat(g); rgb[i * 3 + 2] = sat(b);
    }
    return surfaceCanvases(n, rgb, rough, height, 3000 / n, 3000 / n, 0.9);
  }

  const SURFACES = {
    'ward-wall': [wardWall, [512, 1024, 1024]], 'ward-floor': [wardFloor, [512, 1024, 1024]],
    'ward-ceiling': [wardCeiling, [256, 512, 512]], 'ward-macro': [wardMacro, [256, 256, 256]], 'ward-decals': [wardDecals, [128, 256, 256]],
    'gun-metal': [gunMetal, [256, 256, 256]], 'gun-polymer': [gunPolymer, [256, 256, 256]], 'gun-wood': [gunWood, [256, 256, 256]],
    'gun-rubber': [gunRubber, [128, 128, 128]], 'gun-fabric': [gunFabric, [256, 256, 256]],
    'garden-hedge': [gardenHedge, [256, 512, 1024]], 'garden-lawn': [gardenLawn, [256, 512, 1024]],
    'grave-wall': [graveWall, [256, 512, 1024]], 'grave-soil': [graveSoil, [256, 512, 1024]]
  };
  // Surfaces only the floors above ground use: workers paint them after every other surface, and the boot never
  // waits for them (see surfacePlan and prepaint.js).
  const LATE_SURFACES = Object.freeze(['garden-hedge', 'garden-lawn', 'grave-wall', 'grave-soil']);
  // standard()'s shared material maps are surfaces too ('material-skin', ...), so texture workers can paint them.
  const MATERIAL_KINDS = ['wall', 'floor', 'metal', 'skin', 'fabric', 'concrete', 'wood'];
  for (const kind of MATERIAL_KINDS) SURFACES['material-' + kind] = [() => materialSurface(kind), [256, 256, 256]];

  // Cached canvases {albedo, normal, roughness, size} for a ward surface, sized by the configured detail tier.
  // options.pending: a surface not painted yet (a texture worker is on it) comes back as blank canvases instead, which
  // adoptSurface() fills in place; settleSurfaces() paints any still blank on the page before they are first drawn.
  const placeholders = new Map();
  function surface(kind, options) {
    const opts = options || {}, spec = SURFACES[kind];
    if (!spec) throw new Error('Unknown surface ' + kind);
    const size = opts.size || spec[1][detail], seed = Number.isFinite(opts.seed) ? opts.seed : 7, key = kind + ':' + size + ':' + seed;
    if (!surfaces.has(key)) {
      if (opts.pending && typeof document !== 'undefined') {
        const set = { size };
        for (const name of kind === 'ward-macro' ? ['map'] : ['albedo', 'normal', 'roughness']) set[name] = canvas(size, size)[0];
        placeholders.set(key, { kind, size, seed, set, listeners: [] });
        surfaces.set(key, set);
      } else surfaces.set(key, spec[0](size, seed));
    }
    return surfaces.get(key);
  }

  // Draws painted raw pixels into a placeholder's canvases, then tells whoever waits on it (see whenPainted).
  function fillPlaceholder(key, painted) {
    const job = placeholders.get(key);
    placeholders.delete(key);
    for (const name of Object.keys(job.set)) {
      const value = painted[name];
      if (!value || !value.data) continue;
      const c = job.set[name];
      if (c.width !== value.width || c.height !== value.height) { c.width = value.width; c.height = value.height; }
      const x = c.getContext('2d', { willReadFrequently: true }), img = x.createImageData(value.width, value.height);
      img.data.set(value.data); x.putImageData(img, 0, 0);
    }
    for (const fn of job.listeners) fn(job.set);
  }

  // Paints every placeholder still blank (its worker failed, or painted another quality tier) on this thread.
  function settleSurfaces() {
    let painted = 0;
    for (const [key, job] of placeholders) {
      let pixels;
      rawPixels = true;
      try { pixels = SURFACES[job.kind][0](job.size, job.seed); } finally { rawPixels = false; }
      fillPlaceholder(key, pixels); painted++;
    }
    return painted;
  }

  // fn(set) once a surface's pixels are in: now if they are, otherwise when its placeholder is filled.
  function whenPainted(set, fn) {
    for (const job of placeholders.values()) if (job.set === set) { job.listeners.push(fn); return; }
    fn(set);
  }

  // A surface painted by surface() in a texture worker (raw pixels) joins the cache surface() reads from.
  function adoptSurface(kind, painted, options) {
    const opts = options || {}, seed = Number.isFinite(opts.seed) ? opts.seed : 7;
    if (!SURFACES[kind] || !painted || !Number.isFinite(painted.size)) return false;
    const key = kind + ':' + painted.size + ':' + seed;
    if (placeholders.has(key)) { fillPlaceholder(key, painted); return true; }
    if (surfaces.has(key)) return false;
    const adopted = {};
    for (const [name, value] of Object.entries(painted)) adopted[name] = value && value.data ? pixelImage(value.width, value.height, value.data) : value;
    surfaces.set(key, adopted);
    return true;
  }

  // Every surface at a quality tier split into `workers` lists of similar pixel counts. `order` is a list of kind lists:
  // the first group leads every list, then the next, then the kinds in none, then LATE_SURFACES; each group largest first.
  function surfacePlan(quality, workers, order) {
    const tier = Object.prototype.hasOwnProperty.call(DETAIL, quality) ? DETAIL[quality] : detail, groups = order || [], rank = new Map();
    groups.forEach((kinds, i) => kinds.forEach(kind => { if (!rank.has(kind)) rank.set(kind, i); }));
    const lists = Array.from({ length: Math.max(1, Math.floor(workers) || 1) }, () => ({ cost: 0, kinds: [] }));
    Object.keys(SURFACES).map(kind => {
      const n = SURFACES[kind][1][tier];
      return { kind, rank: rank.has(kind) ? rank.get(kind) : groups.length + (LATE_SURFACES.includes(kind) ? 1 : 0), cost: kind === 'ward-decals' ? n * n * 8 : n * n };
    }).sort((a, b) => a.rank - b.rank || b.cost - a.cost).forEach(job => {
      const target = lists.reduce((best, list) => list.cost < best.cost ? list : best);
      target.kinds.push(job.kind); target.cost += job.cost;
    });
    return lists.map(list => list.kinds);
  }

  // Normal and roughness canvases for an existing painted albedo (the manor's wallpaper, carpet, gilt and marble):
  // relief follows luminance, so gilding and inlays emboss and polished areas catch the chandelier.
  function deriveMaps(source, options) {
    const opts = options || {}, w = source.width, h = source.height;
    const pixels = source.getContext('2d').getImageData(0, 0, w, h).data;
    const lum = new Float32Array(w * h), rough = new Uint8ClampedArray(w * h * 4);
    const roughOf = opts.roughness || ((r, g, b, l) => 0.6 + (1 - l) * 0.3);
    for (let i = 0, p = 0; i < w * h; i++, p += 4) {
      const r = pixels[p] / 255, g = pixels[p + 1] / 255, b = pixels[p + 2] / 255, l = r * 0.2126 + g * 0.7152 + b * 0.0722;
      lum[i] = l; rough[p] = rough[p + 1] = rough[p + 2] = clamp(roughOf(r, g, b, l), 0.03, 1) * 255; rough[p + 3] = 255;
    }
    // Soften single-pixel paint noise before differentiating, then emboss.
    const soft = new Float32Array(w * h), depth = opts.depth == null ? 1.6 : opts.depth;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let k = -1; k <= 1; k++) sum += lum[((y + k + h) % h) * w + x] * 2 + lum[((y + k + h) % h) * w + (x + w - 1) % w] + lum[((y + k + h) % h) * w + (x + 1) % w];
      soft[y * w + x] = sum / 12 * depth * (opts.invert ? -1 : 1);
    }
    const normal = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const dx = -(soft[y * w + (x + 1) % w] - soft[y * w + (x + w - 1) % w]) * 0.5, dy = (soft[((y + 1) % h) * w + x] - soft[((y + h - 1) % h) * w + x]) * 0.5;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1), p = (y * w + x) * 4;
      normal[p] = (dx * inv * 0.5 + 0.5) * 255; normal[p + 1] = (dy * inv * 0.5 + 0.5) * 255; normal[p + 2] = (inv * 0.5 + 0.5) * 255; normal[p + 3] = 255;
    }
    const make = data => { const [c, x] = canvas(w, h), img = x.createImageData(w, h); img.data.set(data); x.putImageData(img, 0, 0); return c; };
    return { normal: make(normal), roughness: make(rough) };
  }

  function configure(options) {
    const opts = options || {};
    if (Object.prototype.hasOwnProperty.call(DETAIL, opts.quality)) detail = DETAIL[opts.quality];
    return { quality: Object.keys(DETAIL)[detail] };
  }

  function materialMaps(THREE, requestedKind) {
    const kind = MATERIAL_KINDS.includes(requestedKind) ? requestedKind : 'concrete';
    const cache = store(THREE).maps;
    if (cache.has(kind)) return cache.get(kind);
    const s = surface('material-' + kind);
    const maps = { normal: texture(THREE, s.normal, false), roughness: texture(THREE, s.roughness, false), albedo: texture(THREE, s.albedo, true) };
    cache.set(kind, maps);
    return maps;
  }

  // A 256 px tiling height field with a few drawn scratches, cracks, grout or creases, and the normal, roughness and
  // albedo derived from it.
  function materialSurface(kind) {
    const n = 256, random = seeded(811 + MATERIAL_KINDS.indexOf(kind) * 731), f = field(n, 197 + MATERIAL_KINDS.indexOf(kind));
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
    const normal = new Uint8ClampedArray(n * n * 4), rough = new Uint8ClampedArray(n * n * 4), albedo = new Uint8ClampedArray(n * n * 4);
    const roughBase = { metal: 182, skin: 235, wall: 245, concrete: 244, floor: 208, fabric: 250, wood: 224 }[kind];
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const i = y * n + x, p = i * 4;
      const hx = height[(y * n + (x + 1) % n) * 4] - height[(y * n + (x + n - 1) % n) * 4];
      const hy = height[(((y + 1) % n) * n + x) * 4] - height[(((y + n - 1) % n) * n + x) * 4];
      const dx = -hx * 0.021, dy = hy * 0.021, inv = 1 / Math.hypot(dx, dy, 1);
      normal[p] = (dx * inv * 0.5 + 0.5) * 255;
      normal[p + 1] = (dy * inv * 0.5 + 0.5) * 255;
      normal[p + 2] = (inv * 0.5 + 0.5) * 255; normal[p + 3] = 255;
      const damp = clamp((f[i] - 0.47) / 0.24, 0, 1);
      const wet = kind === 'floor' ? damp : kind === 'wall' ? damp * 0.35 : 0;
      const rv = clamp(roughBase + (f[i] - 0.5) * 70 + (random() - 0.5) * 9
        - wet * wet * (3 - wet * 2) * 166 + (kind === 'metal' ? Math.abs(height[p] - 123) * 0.28 : 0), 46, 255);
      rough[p] = rough[p + 1] = rough[p + 2] = rv; rough[p + 3] = 255;
      const stain = kind === 'fabric' ? damp * 69 : kind === 'wall' || kind === 'floor' ? damp * 48 : kind === 'metal' ? damp * 32 : 0;
      const av = clamp((kind === 'skin' ? 215 : 239) + (f[i] - 0.5) * (kind === 'skin' ? 95 : 43) + (height[p] - 140) * 0.18 - stain, 105, 254);
      albedo[p] = av;
      albedo[p + 1] = kind === 'skin' ? av * 0.97 : av - stain * 0.09;
      albedo[p + 2] = kind === 'skin' ? av * (0.96 + damp * 0.035) : av - stain * 0.23;
      albedo[p + 3] = 255;
    }
    return { normal: pixelCanvas(n, normal), roughness: pixelCanvas(n, rough), albedo: pixelCanvas(n, albedo), size: n };
  }

  // Surface maps follow the albedo's UV transform (r128 shared one uvTransform; newer Three
  // transforms each map). A tiled albedo gets a material-owned clone of the cached map.
  function followAlbedo(map, material) {
    const albedo = material.map;
    if (!albedo || !albedo.isTexture || (albedo.repeat.equals(map.repeat) && albedo.offset.equals(map.offset) &&
      albedo.center.equals(map.center) && albedo.rotation === map.rotation)) return map;
    const t = map.clone();
    t.repeat.copy(albedo.repeat); t.offset.copy(albedo.offset); t.center.copy(albedo.center); t.rotation = albedo.rotation;
    t.userData = Object.assign({}, map.userData, { hollowShared: false });
    material.userData.hollowOwnedMaps = (material.userData.hollowOwnedMaps || []).concat(t);
    return t;
  }

  function enhanceMaterial(THREE, material, options) {
    if (!material || !material.isMeshStandardMaterial) return material;
    const opts = options || {}, kind = opts.kind || 'concrete', maps = materialMaps(THREE, kind);
    // Leave custom shading untouched (including the world's burn transition node graph).
    if (!material.normalMap || opts.replace) material.normalMap = followAlbedo(maps.normal, material);
    if (!material.roughnessMap || opts.replace) material.roughnessMap = followAlbedo(maps.roughness, material);
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

  // Viewmodel reflections: a dark ward with long overhead tubes and a warm low bounce, so steel reads as steel without
  // lighting the world. Equirectangular; node materials prefilter it once (PMREM) on first use.
  function viewEnvironment(THREE) {
    const res = store(THREE);
    if (res.viewEnvironment) return res.viewEnvironment;
    const [c, x] = canvas(512, 256), sky = x.createLinearGradient(0, 0, 0, 256);
    sky.addColorStop(0, '#3f4a4f'); sky.addColorStop(0.42, '#1f2528'); sky.addColorStop(0.56, '#121617'); sky.addColorStop(1, '#070808');
    x.fillStyle = sky; x.fillRect(0, 0, 512, 256);
    // A broad soft panel up and to the left (equirect x 0..128 = -x..-z) puts a long sheen along the weapon's visible flank.
    const panel = x.createRadialGradient(70, 92, 4, 70, 92, 70);
    panel.addColorStop(0, 'rgba(176,192,198,.75)'); panel.addColorStop(0.55, 'rgba(120,138,146,.35)'); panel.addColorStop(1, 'rgba(90,104,110,0)');
    x.fillStyle = panel; x.fillRect(0, 22, 140, 140);
    for (const [cx, w, y, rgb, alpha] of [[128, 150, 36, '214,226,230', 0.95], [384, 120, 42, '196,212,218', 0.8], [256, 56, 20, '232,238,240', 0.7]]) {
      const glow = x.createRadialGradient(cx, y, 2, cx, y, w * 0.6);
      glow.addColorStop(0, `rgba(${rgb},${alpha * 0.35})`); glow.addColorStop(1, `rgba(${rgb},0)`);
      x.fillStyle = glow; x.fillRect(cx - w, 0, w * 2, y * 2 + w * 0.3);
      x.fillStyle = `rgba(${rgb},${alpha})`; x.fillRect(cx - w / 2, y - 3, w, 6);
    }
    const warm = x.createLinearGradient(0, 118, 0, 176);
    warm.addColorStop(0, 'rgba(150,104,62,0)'); warm.addColorStop(0.5, 'rgba(150,104,62,.45)'); warm.addColorStop(1, 'rgba(150,104,62,0)');
    x.fillStyle = warm; x.fillRect(20, 118, 150, 58);
    const t = texture(THREE, c, true); t.mapping = THREE.EquirectangularReflectionMapping; t.anisotropy = 1;
    res.viewEnvironment = t; return t;
  }

  function finishMaps(THREE, kind) {
    const cache = store(THREE).maps, id = 'finish:' + kind;
    if (!cache.has(id)) {
      const s = surface(kind);
      cache.set(id, { albedo: texture(THREE, s.albedo, true), normal: texture(THREE, s.normal, false), roughness: texture(THREE, s.roughness, false) });
    }
    return cache.get(id);
  }

  // Weapon and flashlight finishes: tiled finish maps (box-projected UVs), their own reflections, and a roughness
  // factor over the finish's roughness map. World copies (carried by the co-op partner) reflect the scene's own
  // environment instead of the viewmodel studio, so they stay dark in a dark corridor.
  function gunMaterial(THREE, key, color, metalness, finishKind, roughness, world) {
    const cache = store(THREE).materials;
    if (world) key += ':world';
    if (!cache.has(key)) {
      const maps = finishMaps(THREE, finishKind);
      const m = new THREE.MeshStandardMaterial(Object.assign({ color, roughness: roughness == null ? 1 : roughness, metalness,
        map: maps.albedo, normalMap: maps.normal, roughnessMap: maps.roughness }, world ? {} : { envMap: viewEnvironment(THREE), envMapIntensity: 1.35 }));
      if (!THREE.ColorManagement || !THREE.ColorManagement.enabled) m.color.convertSRGBToLinear();
      m.userData.hollowShared = true; m.userData.hollowSurface = finishKind; cache.set(key, m);
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

  // Box-projected UVs (scale: UV units per metre) from each triangle's dominant axis; u follows the length (z) axis
  // where it can, so wood grain and machining marks run along a weapon.
  function boxUV(THREE, g, scale) {
    const p = g.attributes.position.array, uv = new Float32Array(p.length / 3 * 2);
    for (let i = 0; i + 8 < p.length; i += 9) {
      const ax = p[i + 3] - p[i], ay = p[i + 4] - p[i + 1], az = p[i + 5] - p[i + 2];
      const bx = p[i + 6] - p[i], by = p[i + 7] - p[i + 1], bz = p[i + 8] - p[i + 2];
      const nx = Math.abs(ay * bz - az * by), ny = Math.abs(az * bx - ax * bz), nz = Math.abs(ax * by - ay * bx);
      for (let k = 0; k < 3; k++) {
        const x = p[i + k * 3], y = p[i + k * 3 + 1], z = p[i + k * 3 + 2], o = (i / 3 + k) * 2;
        if (nx >= ny && nx >= nz) { uv[o] = z * scale; uv[o + 1] = y * scale; }
        else if (ny >= nz) { uv[o] = z * scale; uv[o + 1] = x * scale; }
        else { uv[o] = x * scale; uv[o + 1] = y * scale; }
      }
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  }

  // Static batching without requiring BufferGeometryUtils or another dependency.
  // Groups/animated joints remain intact. Invisible/dynamic meshes are not merged.
  // options.boxUV re-projects UVs in the parent's space (single meshes are then rebuilt too).
  function batch(THREE, root, options) {
    const projected = options && options.boxUV;
    for (const child of root.children.slice()) if (child.isGroup) batch(THREE, child, options);
    const bins = new Map();
    for (const child of root.children) {
      if (!child.isMesh || !child.visible || child.userData.dynamic || Array.isArray(child.material)) continue;
      if (!bins.has(child.material)) bins.set(child.material, []);
      bins.get(child.material).push(child);
    }
    for (const [material, meshes] of bins) {
      if (meshes.length < (projected ? 1 : 2)) continue;
      const chunks = [];
      for (const mesh of meshes) {
        mesh.updateMatrix();
        const g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
        g.applyMatrix4(mesh.matrix); if (projected) boxUV(THREE, g, projected); chunks.push(g);
      }
      // Every float attribute all chunks share (position, normal, uv, color and per-vertex surface data such as wet).
      const merged = new THREE.BufferGeometry();
      for (const key of Object.keys(chunks[0].attributes)) {
        const size = chunks[0].attributes[key].itemSize;
        if (chunks.some(g => !g.attributes[key] || g.attributes[key].itemSize !== size || g.attributes[key].normalized || !(g.attributes[key].array instanceof Float32Array))) continue;
        const values = new Float32Array(chunks.reduce((sum, g) => sum + g.attributes[key].array.length, 0)); let offset = 0;
        for (const g of chunks) { values.set(g.attributes[key].array, offset); offset += g.attributes[key].array.length; }
        merged.setAttribute(key, new THREE.BufferAttribute(values, size));
      }
      merged.computeBoundingSphere();
      const m = new THREE.Mesh(merged, material);
      m.castShadow = meshes.some(o => o.castShadow); m.receiveShadow = meshes.some(o => o.receiveShadow);
      root.add(m);
      // Object3D.remove() per mesh (indexOf + splice) is quadratic in a furnished corridor: drop them in one pass.
      const gone = new Set(meshes);
      let kept = 0;
      for (const child of root.children) if (!gone.has(child)) root.children[kept++] = child;
      root.children.length = kept;
      for (const mesh of meshes) {
        mesh.parent = null;
        mesh.dispatchEvent({ type: 'removed' });
        root.dispatchEvent({ type: 'childremoved', child: mesh });
        if (!mesh.geometry.userData.hollowShared) mesh.geometry.dispose();
      }
      for (const g of chunks) g.dispose();
    }
    return root;
  }

  // Smooth deterministic 3D value noise in [0, 1] for per-vertex tints.
  function hash3(a, b, c) {
    let v = (Math.imul(a, 374761393) + Math.imul(b, 668265263) + Math.imul(c, 1274126177)) | 0;
    v = Math.imul(v ^ (v >>> 13), 1103515245); return ((v ^ (v >>> 16)) >>> 0) / 4294967296;
  }
  // (Closure-free: creature consolidation samples it several times per vertex.)
  function noise3(x, y, z) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), tx = x - xi, ty = y - yi, tz = z - zi;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty), sz = tz * tz * (3 - 2 * tz);
    let a = hash3(xi, yi, zi), b = hash3(xi, yi + 1, zi);
    a += (hash3(xi + 1, yi, zi) - a) * sx; b += (hash3(xi + 1, yi + 1, zi) - b) * sx;
    const near = a + (b - a) * sy;
    a = hash3(xi, yi, zi + 1); b = hash3(xi, yi + 1, zi + 1);
    a += (hash3(xi + 1, yi, zi + 1) - a) * sx; b += (hash3(xi + 1, yi + 1, zi + 1) - b) * sx;
    return near + (a + (b - a) * sy - near) * sz;
  }

  // One organic material for every creature: vertex tints carry the anatomy, and a per-vertex `wet` value lets the
  // node renderer keep skin, tendon and mouths clammy (tight torch highlights) while gowns and wraps stay dry.
  function organicMaterial(THREE) {
    const cache = store(THREE).materials, key = 'creature:organic-batch';
    if (cache.has(key)) return cache.get(key);
    const TSL = global.TSL;
    if (!THREE.MeshStandardNodeMaterial || !TSL) {
      const plain = standard(THREE, key, 0xffffff, 0.91, 0, 'skin');
      plain.vertexColors = true; plain.side = THREE.DoubleSide;
      return plain;
    }
    const maps = materialMaps(THREE, 'skin');
    const m = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.91, metalness: 0, map: maps.albedo,
      normalMap: maps.normal, roughnessMap: maps.roughness, vertexColors: true, side: THREE.DoubleSide });
    m.normalScale.set(0.7, 0.7);
    // Clammy skin and raw meat catch the torch in tight highlights; gowns, straps and bone stay dry.
    m.roughnessNode = TSL.mix(TSL.float(0.95), TSL.float(0.24), TSL.attribute('wet', 'float')).mul(TSL.texture(maps.roughness).g.mul(0.4).add(0.64));
    m.userData.hollowShared = true; m.userData.hollowSurface = 'skin'; cache.set(key, m);
    return m;
  }

  // Garment folds/wrap seams are geometry; vertex tinting keeps even dressed articulated limbs at one draw per joint
  // without a material-array draw penalty. Tints: mottled, bruised skin; stained gowns; floor grime on whatever touches
  // the floor; blood darkening the lips and jaw (mouth: {front, eyeY} in head space).
  // Baked on top: per-vertex tints authored with the geometry (wounds, keratin, gums, sockets), blood running down
  // from the mouth and other `drips` ([x, y, z, half-width, length] in root space), and a cheap occlusion term that
  // darkens undersides so the anatomy reads under a single torch.
  function consolidateOrganicMaterials(THREE, root, palette, seed, mouth, drips) {
    const material = organicMaterial(THREE);
    const wetness = new Map([[palette.skin, 0.36], [palette.tendon, 1], [palette.dark, 0.5], [palette.bone, 0.5], [palette.cloth, 0.2],
      [palette.bandage, 0.1], [palette.flesh, 1], [palette.nail, 0.75], [palette.leather, 0.42], [palette.iron, 0.3], [palette.wood, 0.12]]);
    const point = new THREE.Vector3(), local = new THREE.Vector3(), normal = new THREE.Vector3(), basis = new THREE.Matrix3(), s = seed * 7.31;
    const tone = tints(THREE), bloodColor = tone.blood;
    root.updateMatrixWorld(true);
    root.traverse(o => {
      if (!o.isMesh || !wetness.has(o.material)) return;
      // Cached primitives are copied; an owned loft is only ever used here, so it takes its colours in place.
      const geom = o.geometry.userData.hollowShared ? o.geometry.clone() : o.geometry, color = o.material.color, positions = geom.attributes.position;
      // r128 aliases userData when cloning; never relabel the cached source as owned.
      geom.userData = Object.assign({}, geom.userData, { hollowShared: false });
      const skin = o.material === palette.skin || o.material === palette.tendon || o.material === palette.flesh;
      const cloth = o.material === palette.cloth || o.material === palette.bandage || o.material === palette.leather;
      const dark = o.material === palette.dark, iron = o.material === palette.iron;
      const jaw = o.parent && o.parent.name === 'jaw', head = o.parent && o.parent.name === 'head';
      const tint = geom.attributes.tint, tintWet = geom.attributes.tintWet, normals = geom.attributes.normal;
      basis.getNormalMatrix(o.matrixWorld);
      const values = new Float32Array(positions.count * 3), wet = new Float32Array(positions.count);
      // Cavity: how far a vertex sits below its neighbours' mean, along its normal (umbrella Laplacian over the mean
      // edge). Creases, dents and folds darken; ridges, knuckles and bone edges stay lit.
      const cavity = geom.index && normals ? new Float32Array(positions.count) : null;
      if (cavity) {
        const sum = new Float32Array(positions.count * 5), idx = geom.index.array, P = positions.array;
        for (let i = 0; i < idx.length; i += 3) for (let e = 0; e < 3; e++) {
          const a = idx[i + e], b = idx[i + (e + 1) % 3], len = Math.hypot(P[a * 3] - P[b * 3], P[a * 3 + 1] - P[b * 3 + 1], P[a * 3 + 2] - P[b * 3 + 2]);
          sum[a * 5] += P[b * 3]; sum[a * 5 + 1] += P[b * 3 + 1]; sum[a * 5 + 2] += P[b * 3 + 2]; sum[a * 5 + 3]++; sum[a * 5 + 4] += len;
          sum[b * 5] += P[a * 3]; sum[b * 5 + 1] += P[a * 3 + 1]; sum[b * 5 + 2] += P[a * 3 + 2]; sum[b * 5 + 3]++; sum[b * 5 + 4] += len;
        }
        for (let i = 0; i < positions.count; i++) {
          const n = sum[i * 5 + 3];
          if (!n) continue;
          const dx = sum[i * 5] / n - P[i * 3], dy = sum[i * 5 + 1] / n - P[i * 3 + 1], dz = sum[i * 5 + 2] / n - P[i * 3 + 2];
          cavity[i] = (dx * normals.getX(i) + dy * normals.getY(i) + dz * normals.getZ(i)) / (sum[i * 5 + 4] / n + 1e-5);
        }
      }
      for (let i = 0; i < positions.count; i++) {
        local.fromBufferAttribute(positions, i).applyMatrix4(o.matrix);
        point.fromBufferAttribute(positions, i).applyMatrix4(o.matrixWorld);
        let r = color.r, g = color.g, b = color.b, w = wetness.get(o.material);
        if (!dark) {
          const mottle = noise3(point.x * 9 + s, point.y * 9, point.z * 9), patch = noise3(point.x * 3.1 - s, point.y * 3.1 + 5, point.z * 3.1);
          if (skin) {
            // Blotchy dead skin: bruised patches, yellow-brown rot, dark threads of veins and drier, flaking areas.
            const k = 0.45 + 0.7 * mottle, bruise = smoothstep(0.56, 0.76, patch);
            const rot = smoothstep(0.6, 0.8, noise3(point.x * 2.3 + s, point.y * 2.3 - 7, point.z * 2.3)) * 0.7;
            const vein = patch > 0.4 ? (1 - smoothstep(0.012, 0.04, Math.abs(noise3(point.x * 13 - s, point.y * 6, point.z * 13) - 0.5))) * smoothstep(0.4, 0.62, patch) : 0;
            r *= k * (1 - 0.22 * bruise); g *= k * (1 - 0.4 * bruise); b *= k * (1 - 0.26 * bruise);
            r += (tone.rot[0] * k - r) * rot; g += (tone.rot[1] * k - g) * rot; b += (tone.rot[2] * k - b) * rot;
            r *= 1 - 0.55 * vein; g *= 1 - 0.62 * vein; b *= 1 - 0.42 * vein;
            if (o.material === palette.skin) w *= 0.3 + 1.1 * smoothstep(0.35, 0.75, noise3(point.x * 6, point.y * 6 + s, point.z * 6));
          } else if (cloth) {
            const stain = smoothstep(0.52, 0.74, patch), blood = smoothstep(0.7, 0.86, mottle) * 0.75;
            r *= 1 - 0.28 * stain; g *= 1 - 0.36 * stain; b *= 1 - 0.55 * stain;
            r += (0.13 - r) * blood; g += (0.018 - g) * blood; b += (0.015 - b) * blood; w += 0.6 * blood;
          } else if (iron) {
            const rust = smoothstep(0.35, 0.7, mottle);
            r *= 0.7 + 0.6 * rust; g *= 0.75 + 0.3 * rust; b *= 0.8 + 0.1 * rust; w *= 1 - rust;
          } else { const k = 0.82 + 0.26 * mottle; r *= k; g *= k; b *= k * 0.95; }
          if (tint) {
            const f = tint.getW(i);
            if (f > 0) { r += (tint.getX(i) - r) * f; g += (tint.getY(i) - g) * f; b += (tint.getZ(i) - b) * f; w += (tintWet.getX(i) - w) * f; }
          }
          const grime = point.y < 0.75 ? Math.max(1 - smoothstep(0.03, 0.34, point.y), (1 - smoothstep(0.1, 0.75, point.y)) * 0.6 * noise3(point.x * 5, point.y * 5, point.z * 5 + s)) : 0;
          r *= 1 - 0.5 * grime; g *= 1 - 0.52 * grime; b *= 1 - 0.55 * grime;
          // Lips, chin and the jaw's inner face are crusted with old blood.
          let blood = 0;
          if (mouth && jaw) blood = smoothstep(mouth.front * 0.4, mouth.front * 1.1, local.z) * (0.3 + 0.6 * smoothstep(0.3, 0.7, mottle));
          else if (mouth && head) blood = smoothstep(mouth.eyeY - 0.03, mouth.eyeY - 0.13, local.y) * smoothstep(mouth.front * 0.55, mouth.front * 1.05, local.z) * 0.7;
          for (const d of drips || []) {
            const down = (d[1] - point.y) / d[4];
            if (down < -0.05 || down > 1 || point.z < d[2] - 0.3) continue;
            const wander = (noise3(point.y * 7 + d[0] * 13, d[2] * 5, s) - 0.5) * d[3] * 1.6, dx = Math.abs(point.x - d[0] - wander);
            const rivulet = smoothstep(d[3] * (0.25 + 0.75 * noise3(point.x * 40, d[1], s + 3)), 0, dx);
            blood = Math.max(blood, rivulet * smoothstep(-0.05, 0.06, down) * (1 - smoothstep(0.55, 1, down + 0.35 * noise3(point.x * 23, s, 1))) * 0.9);
          }
          if (blood > 0) { r += (bloodColor[0] - r) * blood; g += (bloodColor[1] - g) * blood; b += (bloodColor[2] - b) * blood; w = Math.max(w, blood * 0.8); }
          if (normals) {
            const up = normal.fromBufferAttribute(normals, i).applyMatrix3(basis).normalize().y;
            const c = cavity ? cavity[i] : 0, ao = (0.66 + 0.34 * smoothstep(-0.85, 0.55, up)) * (1 - 0.62 * smoothstep(0.01, 0.22, c) + 0.14 * smoothstep(0.04, 0.3, -c));
            r *= ao; g *= ao; b *= ao;
          }
        }
        values[i * 3] = r; values[i * 3 + 1] = g; values[i * 3 + 2] = b; wet[i] = Math.min(1, w);
      }
      geom.deleteAttribute('tint'); geom.deleteAttribute('tintWet');
      geom.setAttribute('color', new THREE.BufferAttribute(values, 3));
      geom.setAttribute('wet', new THREE.BufferAttribute(wet, 1));
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
      warden: { skin: 0x4c5048, bone: 0x96917d, cloth: 0x363c36, eyes: 0x292b28 },
      stalker: { skin: 0x4e5046, bone: 0xa3a08a, cloth: 0x4b554d, eyes: 0x30322e },
      crawler: { skin: 0x4b514b, bone: 0x8b9282, cloth: 0x3e4945, eyes: 0x272c29 },
      shrieker: { skin: 0x6c6c60, bone: 0xaaa28d, cloth: 0x4a4c43, eyes: 0x343530 },
      gravekeeper: { skin: 0x535550, bone: 0xa49a7e, cloth: 0x2e2b25, eyes: 0x262624 }
    }[kind];
    return {
      skin: standard(THREE, kind + ':skin', colors.skin, 0.87, 0, 'skin'),
      bone: standard(THREE, kind + ':bone', colors.bone, 0.72, 0, 'skin'),
      cloth: standard(THREE, kind + ':gown', colors.cloth, 0.98, 0, 'fabric'),
      bandage: standard(THREE, 'creature:bandage', 0x6a6452, 0.98, 0, 'fabric'),
      dark: standard(THREE, 'creature:dark', 0x090b0a, 1, 0, 'skin'),
      tendon: standard(THREE, 'creature:tendon', 0x5a3c36, 0.94, 0, 'skin'),
      // Tags only: everything below is baked into the one vertex-coloured organic batch.
      flesh: standard(THREE, 'creature:flesh', 0x5e1f19, 0.9, 0, 'skin'),
      nail: standard(THREE, 'creature:nail', 0x4a3f2c, 0.8, 0, 'skin'),
      leather: standard(THREE, 'creature:leather', 0x2f251c, 0.85, 0, 'fabric'),
      iron: standard(THREE, 'creature:iron', 0x3d3129, 0.9, 0, 'skin'),
      wood: standard(THREE, 'creature:wood', 0x3a2e22, 0.9, 0, 'wood'),
      // Instance-owned for death/respawn writes; dry, recessed slits, not bright beads.
      eye: new THREE.MeshStandardMaterial({ color: colors.eyes, roughness: 0.92, metalness: 0, fog: true })
    };
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

  // Linear tint colours (wounds, gore, keratin, sockets...) baked into vertex colours by consolidateOrganicMaterials.
  function tints(THREE) {
    const res = store(THREE);
    if (res.tints) return res.tints;
    const lin = hex => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
    res.tints = { wound: lin(0x4a0c08), gore: lin(0x170303), blood: lin(0x300505), nail: lin(0x2b2316), socket: lin(0x070606),
      gum: lin(0x45130e), bruise: lin(0x3d2f3d), tooth: lin(0xc2b590), drool: lin(0x8c7a68), rot: lin(0x3a3a24), rust: lin(0x6a3317),
      brass: lin(0x3a301b), verdigris: lin(0x26342b), moss: lin(0x2f3a22), wax: lin(0x8d8468) };
    return res.tints;
  }

  function spline(a, b, c, d, t) {
    const t2 = t * t, t3 = t2 * t;
    return .5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (3 * b - a - 3 * c + d) * t3);
  }
  const pair = r => typeof r === 'number' ? [r, r] : r;

  // A swept organic tube in the parent's space: a Catmull-Rom spine through `points`, elliptical sections (radius or
  // [width, depth] half-axes per point) carried by parallel transport, smooth normals, rounded caps and UVs scaled to
  // metres (the skin maps stay one size on a finger and a torso). Options: sides, seg (samples per span), up (initial
  // depth axis), lump (seeded flesh noise), folds [count, amplitude] (cloth), sculpt [{at, to?, r, d, wound, dark}]
  // (dents, ridges and raw wounds; `to` makes a capsule), tint(t, a, x, y, z) -> [r, g, b, weight, wet],
  // skip(t, a, x, y, z) (torn gaps, given each quad's centre), caps [start, end].
  function loft(THREE, parent, mat, points, radii, options) {
    const o = options || {}, sides = o.sides || 8, seg = o.seg || 2, n = points.length, T = tints(THREE);
    const caps = o.caps || [true, true], lump = o.lump || 0, seed = o.seed || 0, sculpt = o.sculpt || [], folds = o.folds;
    const C = [], R = [];
    for (let i = 0; i < n - 1; i++) {
      const i0 = Math.max(0, i - 1), i3 = Math.min(n - 1, i + 2), a = pair(radii[i0]), b = pair(radii[i]), c = pair(radii[i + 1]), d = pair(radii[i3]);
      for (let s = 0; s < (i === n - 2 ? seg + 1 : seg); s++) {
        const t = s / seg;
        C.push(new THREE.Vector3(spline(points[i0][0], points[i][0], points[i + 1][0], points[i3][0], t),
          spline(points[i0][1], points[i][1], points[i + 1][1], points[i3][1], t), spline(points[i0][2], points[i][2], points[i + 1][2], points[i3][2], t)));
        R.push([Math.max(0, spline(a[0], b[0], c[0], d[0], t)), Math.max(0, spline(a[1], b[1], c[1], d[1], t))]);
      }
    }
    const m = C.length, stride = sides + 1, count = m * stride + 2;
    const pos = new Float32Array(count * 3), uv = new Float32Array(count * 2), tint = new Float32Array(count * 4), wetT = new Float32Array(count);
    let painted = false, length = 0;
    const tan = new THREE.Vector3(), nrm = new THREE.Vector3(...(o.up || [0, 0, 1])), bin = new THREE.Vector3();
    const dir = new THREE.Vector3(), p = new THREE.Vector3(), q = new THREE.Vector3(), seam = [];
    const paint = (k, c) => {
      if (!c || !(c[3] > 0)) return;
      const w = Math.min(1, c[3]), was = tint[k * 4 + 3], total = Math.min(1, was + w * (1 - was)), f = total > 0 ? w / total : 0;
      for (let ch = 0; ch < 3; ch++) tint[k * 4 + ch] += (c[ch] - tint[k * 4 + ch]) * f;
      wetT[k] += ((c[4] == null ? 1 : c[4]) - wetT[k]) * f; tint[k * 4 + 3] = total; painted = true;
    };
    const frames = [];
    for (let i = 0; i < m; i++) {
      tan.copy(C[Math.min(m - 1, i + 1)]).sub(C[Math.max(0, i - 1)]).normalize();
      nrm.addScaledVector(tan, -nrm.dot(tan));
      if (nrm.lengthSq() < 1e-10) { nrm.set(Math.abs(tan.x) < .9 ? 1 : 0, Math.abs(tan.x) < .9 ? 0 : 1, 0); nrm.addScaledVector(tan, -nrm.dot(tan)); }
      nrm.normalize(); bin.crossVectors(tan, nrm).normalize();
      frames.push([tan.clone(), nrm.clone(), bin.clone()]);
      if (i) length += C[i].distanceTo(C[i - 1]);
      const t = i / (m - 1), [rx, rz] = R[i];
      for (let j = 0; j <= sides; j++) {
        // `focus` crowds the samples toward the depth axis (a face, a sternum) and thins them out behind.
        const a = (j % sides) / sides, k = i * stride + j, ang = a * TAU - (o.focus || 0) * Math.sin(a * TAU - Math.PI / 2);
        dir.copy(bin).multiplyScalar(Math.cos(ang) * rx).addScaledVector(nrm, Math.sin(ang) * rz);
        p.copy(C[i]).add(dir);
        let f = 1;
        if (lump) f += lump * (noise3(p.x * 11 + seed, p.y * 11, p.z * 11 - seed) - .5) * 2;
        if (folds) f += folds[1] * Math.sin(ang * folds[0] + seed) * (folds[2] ? Math.pow(t, folds[2]) : 1);
        p.copy(C[i]).addScaledVector(dir, f);
        const len = dir.length();
        for (const s of sculpt) {
          let dist;
          if (s.to) {
            const ax = s.to[0] - s.at[0], ay = s.to[1] - s.at[1], az = s.to[2] - s.at[2], l2 = ax * ax + ay * ay + az * az;
            const h = clamp(((p.x - s.at[0]) * ax + (p.y - s.at[1]) * ay + (p.z - s.at[2]) * az) / l2, 0, 1);
            dist = Math.hypot(p.x - s.at[0] - ax * h, p.y - s.at[1] - ay * h, p.z - s.at[2] - az * h);
          } else dist = Math.hypot(p.x - s.at[0], p.y - s.at[1], p.z - s.at[2]);
          if (dist >= s.r) continue;
          const w = 1 - dist / s.r, fall = w * w * (3 - 2 * w);
          if (s.d && len > 1e-6) p.addScaledVector(dir, s.d * fall / len);
          if (s.wound) {
            paint(k, [...T.wound, fall * s.wound * 1.4, 1]);
            if (fall > .55) paint(k, [...T.gore, (fall - .55) * 2.2 * s.wound, 1]);
          }
          if (s.dark) paint(k, [...T.socket, fall * s.dark, .6]);
          if (s.color) paint(k, [...s.color, fall * (s.weight == null ? 1 : s.weight), s.wet == null ? .5 : s.wet]);
        }
        if (o.tint) paint(k, o.tint(t, a, p.x, p.y, p.z));
        pos[k * 3] = p.x; pos[k * 3 + 1] = p.y; pos[k * 3 + 2] = p.z;
        uv[k * 2] = a * Math.max(1, Math.round(TAU * (rx + rz) * .5 * 3)); uv[k * 2 + 1] = length * 3;
      }
    }
    const index = [];
    for (let i = 0; i < m - 1; i++) for (let j = 0; j < sides; j++) {
      const a = i * stride + j, b = a + 1, c = a + stride, d = c + 1;
      if (o.skip) {
        const mid = ch => (pos[a * 3 + ch] + pos[b * 3 + ch] + pos[c * 3 + ch] + pos[d * 3 + ch]) * .25;
        if (o.skip((i + .5) / (m - 1), (j + .5) / sides, mid(0), mid(1), mid(2))) continue;
      }
      index.push(a, c, b, b, c, d);
    }
    for (const [end, ring] of [[0, 0], [1, m - 1]]) {
      const k = m * stride + end;
      // An unused cap vertex sits on its ring's centre, not at the origin, so it never stretches an unbatched mesh's bounds.
      if (!caps[end] || Math.max(...R[ring]) < 1e-4) { pos[k * 3] = C[ring].x; pos[k * 3 + 1] = C[ring].y; pos[k * 3 + 2] = C[ring].z; continue; }
      const [tg] = frames[ring], r = (R[ring][0] + R[ring][1]) * .5 * (o.dome == null ? .6 : o.dome);
      q.copy(C[ring]).addScaledVector(tg, end ? r : -r);
      pos[k * 3] = q.x; pos[k * 3 + 1] = q.y; pos[k * 3 + 2] = q.z; uv[k * 2] = .5; uv[k * 2 + 1] = end ? length * 3 : 0;
      for (let ch = 0; ch < 4; ch++) tint[k * 4 + ch] = tint[(ring * stride) * 4 + ch];
      wetT[k] = wetT[ring * stride];
      for (let j = 0; j < sides; j++) {
        const a = ring * stride + j;
        if (end) index.push(k, a + 1, a); else index.push(k, a, a + 1);
      }
    }
    for (let i = 0; i < m; i++) seam.push([i * stride, i * stride + sides]);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    if (painted) { g.setAttribute('tint', new THREE.BufferAttribute(tint, 4)); g.setAttribute('tintWet', new THREE.BufferAttribute(wetT, 1)); }
    g.setIndex(index); g.computeVertexNormals();
    // The UV seam duplicates a column of vertices: give both copies the averaged normal so the tube shades as one.
    const nr = g.attributes.normal;
    for (const [a, b] of seam) {
      p.fromBufferAttribute(nr, a).add(q.fromBufferAttribute(nr, b)).normalize();
      nr.setXYZ(a, p.x, p.y, p.z); nr.setXYZ(b, p.x, p.y, p.z);
    }
    return add(THREE, parent, g, mat);
  }

  // First point where a ray (parent space) meets an owned loft: seats ribs, staples, straps and spines on a body.
  function surf(THREE, meshes, origin, direction, lift) {
    const [ox, oy, oz] = origin, len = Math.hypot(...direction), dx = direction[0] / len, dy = direction[1] / len, dz = direction[2] / len;
    let best = Infinity;
    // Two-sided Moller-Trumbore straight off the index and position arrays (thousands of rays per creature).
    for (const mesh of Array.isArray(meshes) ? meshes : [meshes]) {
      const P = mesh.geometry.attributes.position.array, idx = mesh.geometry.index.array;
      for (let i = 0; i < idx.length; i += 3) {
        const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
        const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2], e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
        const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x, det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-12) continue;
        const inv = 1 / det, tx = ox - P[a], ty = oy - P[a + 1], tz = oz - P[a + 2], u = (tx * px + ty * py + tz * pz) * inv;
        if (u < 0 || u > 1) continue;
        const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x, v = (dx * qx + dy * qy + dz * qz) * inv;
        if (v < 0 || u + v > 1) continue;
        const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (t >= 0 && t < best) best = t;
      }
    }
    if (best === Infinity) return [...origin];
    // lift > 0 sinks the point into the surface, < 0 stands it proud.
    const t = best + (lift || 0);
    return [ox + dx * t, oy + dy * t, oz + dz * t];
  }

  // Tapered tube through points (tendons, ribs, drool, straps' loose ends).
  function strand(THREE, parent, mat, points, r0, r1, options) {
    const n = points.length;
    return loft(THREE, parent, mat, points, points.map((_, i) => r0 + (r1 - r0) * i / (n - 1)),
      Object.assign({ sides: 4, seg: 1, caps: [true, r1 > .002] }, options));
  }

  // A curved needle (tooth, claw, spur) from base to tip, its middle pushed by `bow`.
  function fang(THREE, parent, mat, base, tip, r, bow, tint, sides) {
    const mid = [0, 1, 2].map(k => (base[k] + tip[k]) * .5 + (bow ? bow[k] : 0));
    return loft(THREE, parent, mat, [base, mid, tip], [r, r * .62, 0], { sides: sides || 3, seg: 1, caps: [true, false], tint });
  }

  // Uneven needle teeth along a jaw arc (parent space): count across width at height y, raked back by `curve`; a
  // missing centre tooth keeps the throat open, a seeded few are broken or absent. Roots are gum-red, points stained.
  function dentition(THREE, parent, p, o) {
    const T = tints(THREE), random = seeded(o.seed || 1), dirY = o.down ? -1 : 1;
    const tint = t => t < .22 ? [...T.gum, (1 - t / .22) * .85, 1] : t > .7 ? [...T.nail, (t - .7) * 1.6, .7] : null;
    for (let i = 0; i < o.count; i++) {
      const u = o.count > 1 ? i / (o.count - 1) * 2 - 1 : 0, roll = random(), len = o.length * (.55 + .75 * random());
      if (Math.abs(u) < .6 / Math.max(1, o.count - 1) || roll < (o.missing || .08)) continue;
      const x = o.x + u * o.width * .5, z = o.z - o.curve * u * u, y = o.y + (random() - .5) * .006;
      const tip = [x + u * (o.splay || .2) * len, y + dirY * len, z + (o.rake == null ? -.25 : o.rake) * len];
      fang(THREE, parent, p.bone, [x, y - dirY * .006, z], tip, o.radius * (.7 + .5 * random()), [0, 0, o.hook == null ? .12 * len : o.hook * len], tint);
    }
  }

  // Leather/canvas band (cached open 12-gon) around a limb or torso, optional iron buckle on its +z face.
  function band(THREE, parent, mat, at, rx, rz, h, rot, buckle) {
    const geom = geometry(THREE, 'creature:band', () => new THREE.CylinderGeometry(1, 1, 1, 12, 1, true));
    const m = add(THREE, parent, geom, mat, at[0], at[1], at[2], rx, h, rz, ...(rot || [0, 0, 0]));
    if (buckle) {
      const e = new THREE.Euler(...(rot || [0, 0, 0])), f = new THREE.Vector3(0, 0, rz + .006).applyEuler(e);
      box(THREE, parent, buckle, at[0] + f.x, at[1] + f.y, at[2] + f.z, h * 1.25, h * 1.1, .008, ...(rot || [0, 0, 0]));
    }
    return m;
  }

  // A strap that hugs a body: rays from around `c` (in the plane tilted by rot) seat a closed loop on the reference
  // lofts, then a flat [thickness, height] section is swept round it. `from`/`to` (0..1) leave part of the loop off.
  function girdle(THREE, parent, mat, ref, c, o) {
    const n = o.n || 14, e = new THREE.Euler(...(o.rot || [0, 0, 0])), d = new THREE.Vector3(), pts = [];
    const from = o.from || 0, to = o.to == null ? 1 : o.to, closed = from === 0 && to === 1;
    for (let i = 0; i <= (closed ? n : n - 1); i++) {
      const a = (from + (to - from) * (i % (closed ? n : Infinity)) / (closed ? n : n - 1)) * TAU;
      d.set(Math.sin(a), 0, Math.cos(a)).applyEuler(e);
      pts.push(surf(THREE, ref, [c[0] + d.x, c[1] + d.y, c[2] + d.z], [-d.x, -d.y, -d.z], -(o.thick || .008) * (1 + .4 * Math.sin(a * 5 + c[1] * 9))));
    }
    return loft(THREE, parent, mat, pts, pts.map(() => [o.thick || .008, o.height || .05]), { sides: 4, seg: 1, up: [0, 1, 0],
      caps: [!closed, !closed], tint: o.tint, lump: o.lump || 0, seed: o.seed || 0 });
  }

  // A flat plank or blade: a convex outline [[u, v]...] (counter-clockwise) extruded `depth` thick along local z,
  // optionally cupped (z += cup * u * u), placed at `at` with Euler `rot`. tint(u, v) paints it like a loft.
  function slab(THREE, parent, mat, outline, depth, at, rot, o) {
    o = o || {};
    const pos = [], uv = [], index = [], tint = [], wetT = [], n = outline.length, cup = o.cup || 0;
    let painted = false;
    const vert = (u, v, z) => {
      pos.push(u, v, z + cup * u * u); uv.push(u * 3, v * 3);
      const c = o.tint ? o.tint(u, v) : null;
      if (c && c[3] > 0) { tint.push(c[0], c[1], c[2], Math.min(1, c[3])); wetT.push(c[4] == null ? .5 : c[4]); painted = true; } else { tint.push(0, 0, 0, 0); wetT.push(0); }
      return pos.length / 3 - 1;
    };
    const cu = outline.reduce((sum, q) => sum + q[0], 0) / n, cv = outline.reduce((sum, q) => sum + q[1], 0) / n;
    for (const side of [1, -1]) {
      const z = side * depth / 2, c = vert(cu, cv, z), ring = outline.map(q => vert(q[0], q[1], z));
      for (let i = 0; i < n; i++) { const a = ring[i], b = ring[(i + 1) % n]; if (side > 0) index.push(c, a, b); else index.push(c, b, a); }
    }
    for (let i = 0; i < n; i++) {
      const p0 = outline[i], p1 = outline[(i + 1) % n];
      const a = vert(p0[0], p0[1], depth / 2), b = vert(p1[0], p1[1], depth / 2), c = vert(p0[0], p0[1], -depth / 2), d = vert(p1[0], p1[1], -depth / 2);
      index.push(a, c, b, b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    if (painted) { g.setAttribute('tint', new THREE.Float32BufferAttribute(tint, 4)); g.setAttribute('tintWet', new THREE.Float32BufferAttribute(wetT, 1)); }
    g.setIndex(index); g.computeVertexNormals();
    return add(THREE, parent, g, mat, at[0], at[1], at[2], 1, 1, 1, ...(rot || [0, 0, 0]));
  }

  // The part of a convex outline between u0 and u1 (one plank of a lid).
  function clipStrip(outline, u0, u1) {
    let poly = outline;
    for (const [edge, keep] of [[u0, 1], [u1, -1]]) {
      const out = [];
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length], ia = (a[0] - edge) * keep >= 0, ib = (b[0] - edge) * keep >= 0;
        if (ia) out.push(a);
        if (ia !== ib) { const t = (edge - a[0]) / (b[0] - a[0]); out.push([edge, a[1] + (b[1] - a[1]) * t]); }
      }
      poly = out;
    }
    return poly;
  }

  // A row of surgical staples across an incision running from a to b (points on the skin, offset along `out`).
  function staples(THREE, parent, p, a, b, n, out) {
    const T = tints(THREE);
    strand(THREE, parent, p.flesh, [a, [0, 1, 2].map(k => (a[k] + b[k]) * .5 + out[k] * .004), b], .007, .005,
      { sides: 3, tint: () => [...T.wound, .7, 1] });
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2], across = Math.atan2(dy, dx) + Math.PI / 2;
    for (let i = 0; i < n; i++) {
      const f = (i + .5) / n;
      box(THREE, parent, p.iron, a[0] + dx * f + out[0] * .006, a[1] + dy * f + out[1] * .006, a[2] + dz * f + out[2] * .006,
        .026, .004, .004, 0, Math.atan2(out[0], out[2]), across);
    }
  }

  // Long bony hand at `at`: palm, four jointed fingers ending in hooked keratin claws, and a thumb. Local frame: fingers
  // hang along -y and curl toward +z; crawling hands lie palm-down with the fingers forward and claws dug into the floor.
  function claws(THREE, parent, p, at, o) {
    const T = tints(THREE), s = o.size || 1, side = o.side || 1, reach = o.length || 1, crawl = !!o.crawling, w = o.thick || 1;
    const pt = (x, y, z) => crawl ? [at[0] + x * s, at[1] - z * s, at[2] - y * s] : [at[0] + x * s, at[1] + y * s, at[2] + z * s];
    const up = crawl ? [0, 1, 0] : [0, 0, 1], curl = o.curl == null ? .55 : o.curl, claw = o.claw || 1;
    loft(THREE, parent, p.skin, [pt(0, .012, 0), pt(0, -.045, .008), pt(side * .004, -.092, .014)],
      [[.026 * w, .016 * w], [.039 * w, .017 * w], [.043 * w, .014 * w]], { sides: 6, seg: 1, up });
    const nail = (bloody) => t => t > .64 ? [...(bloody ? T.blood : T.nail), Math.min(1, (t - .64) * 4), .8] : null;
    const digit = (base, lengths, bend, r, splay, bloody) => {
      const pts = [base];
      let ang = .05, x = base[0], y = base[1], z = base[2];
      for (let k = 0; k < lengths.length; k++) {
        ang += bend[k]; x += splay * lengths[k]; y -= Math.cos(ang) * lengths[k]; z += Math.sin(ang) * lengths[k]; pts.push([x, y, z]);
      }
      const radii = pts.map((_, k) => r * (k === pts.length - 1 ? 0 : k >= pts.length - 3 ? .62 - (k - pts.length + 3) * .2 : 1 - k * .14));
      loft(THREE, parent, p.skin, pts.map(q => pt(...q)), radii, { sides: 4, seg: 1, up, tint: nail(bloody), caps: [true, false] });
    };
    const fingers = o.fingers || [.86, 1, .95, .74];
    for (let f = 0; f < fingers.length; f++) {
      const x = (f - (fingers.length - 1) / 2) * .022 * w, L = fingers[f] * reach;
      digit([x, -.09, .014], [.05 * L, .04 * L, .032 * L, .03 * claw, .028 * claw], [curl * .25, curl * .4, curl * .5, .55, .75],
        .0105 * w, x * .9, f === 1 || f === 3);
    }
    if (o.thumb !== false) digit([side * .036 * w, -.035, .02], [.038 * reach, .032 * reach, .026 * claw, .022 * claw], [.5, .35, .5, .7],
      .011 * w, side * .38, false);
  }

  // Foot planted on the floor (floorY in the parent's space): heel, arch and ball, four long toes with curled nails.
  function talons(THREE, parent, p, at, floorY, o) {
    const T = tints(THREE), s = o.size || 1, w = o.width || 1, x0 = at[0], z0 = at[2];
    loft(THREE, parent, p.skin, [[x0, floorY + .036 * s, z0 - .065 * s], [x0, floorY + .05 * s, z0], [x0, floorY + .046 * s, z0 + .065 * s],
      [x0, floorY + .03 * s, z0 + .13 * s]], [[.03 * w, .033 * s], [.038 * w, .042 * s], [.046 * w, .032 * s], [.05 * w, .021 * s]],
    { sides: 6, seg: 1, up: [0, 1, 0], lump: .06, seed: x0 * 9 });
    const nail = t => t > .6 ? [...T.nail, Math.min(1, (t - .6) * 3.5), .7] : null;
    for (let i = 0; i < (o.toes || 4); i++) {
      const u = i / ((o.toes || 4) - 1) - .5, x = x0 + u * .07 * w, l = (1 - Math.abs(u) * .6) * (o.length || 1) * s;
      strand(THREE, parent, p.skin, [[x, floorY + .026 * s, z0 + .12 * s], [x + u * .02, floorY + .024 * s, z0 + (.12 + .05 * l) * s],
        [x + u * .03, floorY + .016 * s, z0 + (.12 + .085 * l) * s], [x + u * .034, floorY + .002, z0 + (.12 + .11 * l) * s]],
      .011 * w, .002, { sides: 3, tint: nail });
    }
  }

  // Thigh + shin under hip and knee joints, knobbed knee, calf, exposed tibia, Achilles tendon and a planted foot.
  function bodyLeg(THREE, p, limb, name, bend, end, o) {
    const w = o.width, side = o.side, seed = o.seed || 1, hipY = o.hipY, mass = o.mass || 0;
    const lerp3 = (f, dz) => [bend[0] * f, bend[1] * f, bend[2] * f + (dz || 0)];
    const e = end, at = f => [e[0] * f, e[1] * f, e[2] * f];
    const thigh = mass ? [{ at: lerp3(.4, w * .9), r: w * 1.6, d: w * mass }, { at: lerp3(.55, -side * w * .8), r: w * 1.2, d: w * mass * .6 }] : [];
    const calf = mass ? [{ at: [e[0] * .28, e[1] * .28, e[2] * .28 - w * .85], r: w * 1.1, d: w * mass * .8 }] : [];
    loft(THREE, limb, p.skin, [[0, .07, -.01], lerp3(.3, w * .3), lerp3(.68, w * .1), [bend[0], bend[1] - .02, bend[2]]],
      [[w * 1.2, w * 1.15], [w * 1.05, w * 1.1], [w * .76, w * .8], [w * .7, w * .72]], { sides: 8, seg: 2, lump: o.lump || .07, seed, sculpt: thigh.concat(o.thigh || []) });
    const distal = joint(THREE, limb, name, ...bend);
    loft(THREE, distal, p.skin, [[0, .045, -.005], [e[0] * .28, e[1] * .28, e[2] * .28 - w * .42], at(.62), [e[0], e[1] + .03, e[2]]],
      [[w * .78, w * .8], [w * .74, w * .86], [w * .5, w * .52], [w * .42, w * .44]], { sides: 8, seg: 2, lump: o.lump || .07, seed: seed + 3, sculpt: calf.concat(o.shin || []) });
    loft(THREE, distal, p.bone, [[0, .02, w * .62], [0, -.018, w * .82], [0, -.05, w * .6]], [w * .32, w * .38, w * .2], { sides: 5, seg: 1 });
    strand(THREE, distal, p.bone, [[0, -.07, w * .7], [e[0] * .5, e[1] * .5, e[2] * .5 + w * .5], [e[0], e[1] + .06, e[2] + w * .34]], w * .16, w * .12, { sides: 3 });
    strand(THREE, distal, p.tendon, [[e[0] * .35, e[1] * .35, e[2] * .35 - w * .8], [e[0], e[1] + .02, e[2] - w * .5]], w * .2, w * .14, { sides: 3 });
    talons(THREE, distal, p, e, -(hipY + bend[1]), { size: o.foot || 1, width: o.footWidth || w / .072 * .9, length: o.toes || 1 });
    return distal;
  }

  // Upper arm + forearm under shoulder and elbow joints, a bony elbow spur, forearm tendons and a clawed hand.
  function bodyArm(THREE, p, limb, name, bend, end, o) {
    const T = tints(THREE), w = o.width, seed = o.seed || 2, lerp3 = (f, dz) => [bend[0] * f, bend[1] * f, bend[2] * f + (dz || 0)], mass = o.mass || 0, e = end;
    // `mass` swells biceps, triceps and the forearm's flexors into a labourer's (or a brute's) arm.
    const upper = mass ? [{ at: lerp3(.45, w * .9), r: w * 1.7, d: w * mass }, { at: lerp3(.38, -w * .9), r: w * 1.5, d: w * mass * .7 }] : [];
    const fore = mass ? [{ at: [e[0] * .22, e[1] * .22, e[2] * .22 + w * .6], r: w * 1.3, d: w * mass * .8 }] : [];
    loft(THREE, limb, p.skin, [[0, .05, -.01], lerp3(.28, w * .18), lerp3(.65), [bend[0], bend[1] - .015, bend[2]]],
      [[w * 1.3, w * 1.2], [w * 1.08, w * 1.06], [w * .78, w * .8], [w * .72, w * .74]], { sides: 8, seg: 2, lump: o.lump || .07, seed, sculpt: upper.concat(o.upper || []) });
    const distal = joint(THREE, limb, name, ...bend);
    loft(THREE, distal, p.skin, [[0, .035, 0], [e[0] * .3, e[1] * .3, e[2] * .3 + w * .12], [e[0] * .72, e[1] * .72, e[2] * .72], [e[0], e[1] + .01, e[2]]],
      [[w * .8, w * .78], [w * .84, w * .8], [w * .6, w * .52], [w * .5, w * .38]], { sides: 8, seg: 2, lump: o.lump || .07, seed: seed + 5, sculpt: fore.concat(o.fore || []) });
    fang(THREE, distal, p.bone, [0, .01, -w * .45], [0, -.01, -w * 1.25], w * .32, [0, .012, 0], null, 4);
    for (const dx of [-.4, .45]) strand(THREE, distal, p.tendon, [[dx * w, -.03, w * .55], [e[0] * .5 + dx * w * .8, e[1] * .5, e[2] * .5 + w * .56],
      [e[0] + dx * w * .6, e[1] + .02, e[2] + w * .26]], w * .1, w * .07, { sides: 3, tint: () => [...T.bruise, .5, .5] });
    if (o.hand !== false) claws(THREE, distal, p, e, Object.assign({ side: o.side }, o.hand));
    return distal;
  }

  // Every creature of a kind is the same model (fixed seeds), so each kind is built once per THREE and then cloned.
  // A clone owns copies of its geometry and its unique materials (eyes; the Gravekeeper's lantern): disposing it, or a
  // death/respawn write to its eyes, never reaches the template or a sibling.
  function makeMonster(THREE, requestedKind) {
    const kind = ['warden', 'stalker', 'crawler', 'shrieker', 'gravekeeper'].includes(requestedKind) ? requestedKind : 'stalker';
    const templates = store(THREE).monsters;
    if (!templates.has(kind)) templates.set(kind, buildMonster(THREE, kind));
    return cloneMonster(templates.get(kind));
  }

  function cloneMonster(template) {
    const source = template.userData, nodes = new Map();
    const owned = new Map(source.resources.uniqueMaterials.map(material => [material, material.clone()]));
    // Object3D.clone() copies userData through JSON, which cannot carry the joint references: they are remapped below.
    template.userData = {};
    let g;
    try { g = template.clone(); } finally { template.userData = source; }
    // clone() copies quaternions and re-derives the Euler angles (so -0 becomes 0), but joints are posed by Euler angles
    // against their restPose. Copying the angles reproduces the quaternion of a part posed by angles; one oriented by
    // its quaternion (a sinew) gets that back, with the template's own derived angles.
    const pair = (from, to) => {
      nodes.set(from, to);
      to.rotation.copy(from.rotation);
      if (!to.quaternion.equals(from.quaternion)) to.quaternion.copy(from.quaternion);
      from.children.forEach((child, i) => pair(child, to.children[i]));
    };
    pair(template, g);
    g.traverse(o => {
      if (!o.isMesh) return;
      if (owned.has(o.material)) o.material = owned.get(o.material);
      if (!o.geometry.userData.hollowShared) {
        const geom = o.geometry.clone();
        geom.userData = Object.assign({}, geom.userData);
        o.geometry = geom;
      }
    });
    const remap = value => value && value.isObject3D ? nodes.get(value) : owned.has(value) ? owned.get(value) : Array.isArray(value) ? value.map(remap) : value;
    const data = {};
    for (const key of Object.keys(source)) data[key] = remap(source[key]);
    g.userData = Object.assign(data, { glow: { intensity: 0 }, resources: { uniqueMaterials: [...owned.values()] } });
    return g;
  }

  // Joint layout per kind (root space, metres; +z is the creature's front). These match RULES.MONSTERS and the
  // monster-anim.js RIGS mirror: hips, shoulders, the neck pivot (= head hit height), knee/elbow bends and ankle/wrist ends.
  const FORMS = {
    warden: { height: 2.8, head: 2.35, radius: .58, stride: .27, hips: [[-.245, 1.10, -.035], [.255, 1.02, .045]],
      shoulders: [[-.48, 2.30, .015], [.47, 2.13, .055]], neck: [-.055, 2.35, .28],
      knees: [[-.075, -.47, .10], [.065, -.42, -.04]], ankles: [[.025, -.55, -.085], [-.012, -.51, .09]],
      elbows: [[-.075, -.64, .09], [.105, -.53, -.03]], wrists: [[.025, -.69, .035], [-.015, -.79, .16]],
      rest: { neck: [.12, 0, -.03], head: [.13, -.08, -.13], jaw: [.06, 0, 0] }, jaw: [.022, .035, .025] },
    stalker: { height: 2.65, head: 2.12, radius: .34, stride: .44, hips: [[-.135, 1.30, -.045], [.135, 1.21, .045]],
      shoulders: [[-.27, 2.18, -.035], [.255, 2.02, .04]], neck: [.075, 2.12, .18],
      knees: [[-.09, -.58, .02], [.105, -.63, .18]], ankles: [[.08, -.65, -.065], [-.14, -.51, -.13]],
      elbows: [[-.055, -.65, .045], [.085, -.43, -.075]], wrists: [[-.015, -.78, .055], [-.035, -.52, .15]],
      rest: { neck: [.02, -.04, .08], head: [.10, -.12, -.34], jaw: [-.04, 0, 0] }, jaw: [-.018, .035, .025] },
    crawler: { height: .9, head: .55, radius: .43, stride: .2, hips: [[-.20, .52, -.36], [.225, .45, -.43]],
      shoulders: [[-.245, .61, .22], [.26, .54, .16]], neck: [-.065, .55, .46],
      knees: [[-.36, .10, -.30], [.29, .20, -.20]], ankles: [[.12, -.55, -.09], [.20, -.56, .13]],
      elbows: [[-.34, .08, .12], [.33, .04, .25]], wrists: [[.17, -.61, .33], [.17, -.50, .24]],
      rest: { neck: [.05, .12, .06], head: [.11, -.16, -.42] }, jaw: null },
    shrieker: { height: 2.3, head: 1.9, radius: .34, stride: .44, hips: [[-.15, 1.03, -.07], [.12, 1.08, .015]],
      shoulders: [[-.26, 1.78, .015], [.24, 1.71, -.025]], neck: [.015, 1.9, .17],
      knees: [[-.05, -.42, -.02], [.07, -.50, .10]], ankles: [[.02, -.54, .10], [-.02, -.51, -.07]],
      elbows: [[-.06, -.43, .10], [.12, -.52, -.02]], wrists: [[.035, -.44, .17], [-.17, -.34, .28]],
      rest: { neck: [-.03, .10, .04], head: [-.07, .09, .12], jaw: [.04, 0, 0] }, jaw: [.008, .09, .025] },
    gravekeeper: { height: 3.6, head: 3.05, radius: .8, stride: .36, hips: [[-.2, 1.72, -.04], [.2, 1.66, .04]],
      shoulders: [[-.42, 2.86, -.02], [.44, 2.78, .06]], neck: [0, 3.05, .3],
      knees: [[-.04, -.82, .1], [.05, -.78, .06]], ankles: [[.02, -.86, -.08], [-.02, -.84, -.06]],
      elbows: [[-.1, -.78, .12], [.08, -.7, .16]], wrists: [[.02, -.82, .1], [-.02, -.62, .32]],
      rest: { neck: [.3, 0, .04], head: [.12, .06, -.15], jaw: [.08, 0, 0] }, jaw: [0, 0, .06] }
  };

  // Shared skeleton: joint groups, rest Eulers, then the kind's body; consolidated and batched once per kind.
  function buildMonster(THREE, kind) {
    const g = new THREE.Group(), p = monsterPalette(THREE, kind), form = FORMS[kind];
    g.name = 'Blackwater Ward / ' + kind;
    if (!THREE.ColorManagement || !THREE.ColorManagement.enabled) p.eye.color.convertSRGBToLinear();
    const legL = joint(THREE, g, 'legL', ...form.hips[0]), legR = joint(THREE, g, 'legR', ...form.hips[1]);
    const armL = joint(THREE, g, 'armL', ...form.shoulders[0]), armR = joint(THREE, g, 'armR', ...form.shoulders[1]);
    const neck = joint(THREE, g, 'neck', ...form.neck), head = joint(THREE, neck, 'head', 0, 0, 0);
    const jaw = form.jaw ? joint(THREE, head, 'jaw', ...form.jaw) : null;
    const rig = { g, legL, legR, armL, armR, neck, head, jaw, knees: [], elbows: [], form };
    const body = BODIES[kind](THREE, p, rig);
    for (const [name, part] of [['neck', neck], ['head', head], ['jaw', jaw]]) if (part && form.rest[name]) part.rotation.set(...form.rest[name]);
    const restPose = {};
    for (const part of [legL, legR, armL, armR, neck, head, ...rig.knees, ...rig.elbows, ...(jaw ? [jaw] : [])]) {
      restPose[part.name] = Object.freeze({ x: part.rotation.x, y: part.rotation.y, z: part.rotation.z });
    }
    consolidateOrganicMaterials(THREE, g, p, { warden: 1, stalker: 2, crawler: 3, shrieker: 4, gravekeeper: 5 }[kind], { front: body.front, eyeY: body.eyeY }, body.drips);
    batch(THREE, g);
    g.userData = Object.assign({
      kind, direction: 'Blackwater Ward', legL, legR, armL, armR, neck, head, jaw, restPose: Object.freeze(restPose),
      eyeMat: p.eye, eyeColor: p.eye.color.getHex(), glow: { intensity: 0 }, limbs: [legL, legR, armL, armR], knees: rig.knees, elbows: rig.elbows,
      phase: 0, twitch: 0, twitchT: 1, speed: 0, chasing: false, height: form.height, bodyRadius: form.radius, headHeight: form.head,
      stride: form.stride, resources: { uniqueMaterials: [p.eye, ...(body.materials || [])] }
    }, body.userData);
    return g;
  }

  // Seats a hanging limb pair: legs then arms, both sides, with the kind's options per side.
  function limbs(THREE, p, rig, legs, arms) {
    const f = rig.form;
    for (let i = 0; i < 2; i++) {
      const side = i ? 1 : -1;
      rig.knees.push(bodyLeg(THREE, p, i ? rig.legR : rig.legL, i ? 'kneeR' : 'kneeL', f.knees[i], f.ankles[i],
        Object.assign({ side, hipY: f.hips[i][1], seed: 11 + i }, legs(i))));
      rig.elbows.push(bodyArm(THREE, p, i ? rig.armR : rig.armL, i ? 'elbowR' : 'elbowL', f.elbows[i], f.wrists[i],
        Object.assign({ side, seed: 21 + i }, arms(i))));
    }
  }

  // Ribs as arcs seated on a reference torso surface at each height: `buried` sinks them into taut skin; `lift` stands
  // them proud of a flayed cavity. sides: -1 (L), 1 (R).
  function ribcage(THREE, parent, p, ref, o) {
    for (let i = 0; i < o.count; i++) {
      const y = o.top - i * o.gap;
      for (const side of o.sides) {
        const exposed = o.exposed && o.exposed(side, i), lift = exposed ? -.02 : o.buried, pts = [];
        if (o.only && !exposed) continue;
        for (const [ang, dy] of [[-.48, .03], [-.28, .02], [0, 0], [.27, -.035], [.43, -.07]]) {
          if (ang > .4 && !exposed && i > 3) continue;
          const a = ang * Math.PI, dx = side * Math.cos(a), dz = Math.sin(a);
          const cx = o.center[0] + (o.lean || 0) * (y - o.top), cz = o.center[1];
          pts.push(surf(THREE, ref, [cx + dx * 1.2, y + dy, cz + dz * 1.2], [-dx, 0, -dz], lift));
        }
        strand(THREE, parent, p.bone, pts, o.radius * (exposed ? 1.15 : 1), o.radius * .8, { sides: 4, caps: [false, true] });
      }
    }
  }

  // Spinous processes down the back: bony knobs seated on the reference surface, pointing back and down.
  function vertebrae(THREE, parent, p, ref, o) {
    for (let i = 0; i < o.count; i++) {
      const y = o.from + (o.to - o.from) * i / (o.count - 1), x = (o.x || 0) + Math.sin(i * 1.7) * .006;
      const at = surf(THREE, ref, [x, y, (o.z || 0) - 1], [0, 0, 1], .006), r = o.radius * (1 - .25 * Math.abs(i / (o.count - 1) - .45));
      fang(THREE, parent, p.bone, at, [at[0], at[1] - r * .7, at[2] - r * 2.1], r, [0, r * .3, 0], null, 4);
    }
  }

  const BODIES = {
    warden(THREE, p, rig) {
      const { g, neck, head, jaw } = rig, T = tints(THREE), front = .208, eyeY = .105, drop = .255;
      // A hulking brute: gut, barrel chest, a lumpy hump with the spine breaking through, an autopsy Y-incision
      // stapled shut, a flayed right flank over bare ribs, and what is left of a straitjacket cinched with leather.
      const spine = [[0, .98, 0], [0, 1.22, .04], [0, 1.5, .05], [-.01, 1.78, .03], [-.03, 2.04, 0], [-.04, 2.26, .01], [-.05, 2.38, .06]];
      const girth = [[.25, .19], [.31, .24], [.35, .25], [.43, .27], [.49, .28], [.4, .24], [.18, .15]];
      const hump = [[-.06, 1.72, -.12], [-.09, 2.08, -.2], [-.12, 2.45, -.17], [-.11, 2.66, -.07], [-.1, 2.75, .02]];
      const humpR = [[.3, .17], [.42, .24], [.38, .24], [.24, .16], [0, 0]];
      const tmp = new THREE.Group(), ref = [loft(THREE, tmp, p.skin, spine, girth, { sides: 16, seg: 2 }), loft(THREE, tmp, p.skin, hump, humpR, { sides: 12, seg: 2 })];
      loft(THREE, g, p.skin, spine, girth, { sides: 16, seg: 2, focus: .3, lump: .08, seed: 1, sculpt: [
        { at: [.36, 1.62, .1], r: .17, d: -.06, wound: 1 }, { at: [-.22, 1.3, .2], r: .09, d: -.02, color: T.bruise, weight: .7 },
        { at: [0, 1.06, .2], to: [0, 1.06, -.15], r: .07, d: -.03 }, { at: [-.2, 1.95, -.2], r: .12, d: .03 },
        { at: [-.2, 2.02, .26], r: .17, d: .035 }, { at: [.19, 1.99, .27], r: .16, d: .03 }, { at: [-.32, 1.87, .2], to: [.3, 1.85, .22], r: .045, d: -.025 },
        { at: [0, 1.36, .3], r: .24, d: .045 }, { at: [.02, 1.33, .29], r: .025, d: -.02, dark: .8 }] });
      loft(THREE, g, p.skin, hump, humpR, { sides: 10, seg: 3, lump: .16, seed: 2, sculpt: [{ at: [.12, 2.3, -.42], r: .12, d: -.03, wound: .7 },
        { at: [-.32, 2.2, -.3], r: .13, d: .06 }, { at: [.15, 2.5, -.3], r: .1, d: .05 }, { at: [-.25, 1.9, -.33], r: .09, d: .04, color: T.bruise, weight: .8 },
        { at: [-.1, 2.6, -.2], to: [-.1, 1.8, -.4], r: .055, d: -.02, wound: .55 }] });
      ribcage(THREE, g, p, ref[0], { count: 5, top: 1.86, gap: .075, center: [-.02, .03], sides: [1], radius: .017, buried: .01, only: true,
        exposed: (side, i) => i >= 1 && i <= 3 });
      vertebrae(THREE, g, p, ref, { count: 8, from: 1.82, to: 2.62, radius: .048, x: -.1, z: -.1 });
      // Trapezius and deltoids: one slab of muscle from shoulder to shoulder, the left heaved higher.
      loft(THREE, g, p.skin, [[-.6, 2.31, .0], [-.36, 2.43, -.01], [-.08, 2.45, .02], [.22, 2.33, .05], [.54, 2.15, .06]],
        [[.14, .13], [.19, .17], [.2, .16], [.17, .15], [.13, .12]], { sides: 10, seg: 3, up: [0, 1, 0], lump: .1, seed: 3 });
      const chest = (x, y) => surf(THREE, ref[0], [x, y, 1.5], [0, 0, -1], -.002);
      const sternum = chest(-.02, 1.86);
      staples(THREE, g, p, chest(-.3, 2.07), sternum, 6, [0, 0, 1]); staples(THREE, g, p, chest(.27, 2.0), sternum, 6, [0, 0, 1]);
      staples(THREE, g, p, sternum, chest(-.01, 1.5), 5, [0, 0, 1]); staples(THREE, g, p, chest(-.01, 1.5), chest(0, 1.2), 4, [0, 0, 1]);
      // Straitjacket: open down the front, torn over the flayed flank, ragged at the hem.
      loft(THREE, g, p.cloth, [[0, 1.04, .0], [0, 1.25, .04], [0, 1.5, .05], [-.01, 1.75, .03], [-.02, 1.96, .015]],
        [[.29, .23], [.345, .275], [.385, .285], [.465, .305], [.515, .31]], { sides: 16, seg: 2, caps: [false, false], folds: [9, .035], seed: 4,
          skip: (t, a, x, y, z) => Math.abs(a - .25) < .075 || Math.hypot(x - .38, y - 1.64, z - .12) < .2 || (t < .15 && noise3(a * 13, 1, 2) > .45) || noise3(t * 6, a * 11, 7) > .74 });
      for (const [y, tilt, at] of [[1.8, .03, -.12], [1.38, -.04, .16]]) {
        girdle(THREE, g, p.leather, ref[0], [0, y, .03], { n: 16, rot: [0, 0, tilt], thick: .012, height: .036, seed: y });
        const b = surf(THREE, ref[0], [at, y + at * tilt, 1], [0, 0, -1], -.02);
        box(THREE, g, p.iron, b[0], b[1], b[2], .07, .06, .012, 0, 0, tilt);
      }
      rag(THREE, g, p.cloth, .1, .98, .27, .38, .62, .06, 0, -.06, .06);
      rag(THREE, g, p.cloth, -.08, 1.0, -.22, .44, .7, .06, .05, Math.PI, -.05);
      rag(THREE, g, p.bandage, -.33, 1.12, .2, .09, .42, .03, 0, -.3, -.2);
      limbs(THREE, p, rig, () => ({ width: .14, foot: 1.3, toes: .7, lump: .1, mass: .35 }),
        () => ({ width: .12, lump: .1, mass: .45, hand: { size: 1.27, thick: 1.45, claw: 1.25, length: 1.05, curl: .75 } }));
      // A canvas sleeve and a cuff with its strap torn loose; old dressings on the other forearm and a knee.
      const f = rig.form, b0 = f.elbows[0];
      loft(THREE, rig.armL, p.cloth, [[0, .06, 0], [b0[0] * .5, b0[1] * .5, b0[2] * .5], [b0[0] * .92, b0[1] * .92, b0[2] * .92]], [[.18, .17], [.15, .15], [.135, .13]],
        { sides: 10, seg: 2, caps: [false, false], folds: [5, .05], seed: 6, skip: (t, a) => t > .7 && noise3(a * 9, t * 4, 3) > .5 });
      band(THREE, rig.armL, p.leather, [b0[0] * .82, b0[1] * .82, b0[2] * .82], .14, .135, .06, [0, 0, 0], p.iron);
      strand(THREE, rig.armL, p.leather, [[b0[0] * .82 + .1, b0[1] * .82, b0[2] * .82 + .08], [b0[0] * .82 + .14, b0[1] * .82 - .12, b0[2] * .82 + .1],
        [b0[0] * .82 + .12, b0[1] * .82 - .3, b0[2] * .82 + .06]], .024, .02, { sides: 3, up: [1, 0, 0] });
      wraps(THREE, rig.elbows[1], p.bandage, 0, -.2, .01, .09, 4);
      wraps(THREE, rig.knees[0], p.bandage, 0, -.03, .01, .12, 3);
      // Thick neck in a restraint collar.
      const throat = loft(THREE, neck, p.skin, [[0, -.26, -.22], [0, -.14, -.12], [0, -.02, -.05], [0, .05, -.02]], [[.2, .18], [.17, .16], [.15, .15], [.14, .14]],
        { sides: 12, seg: 2, lump: .1, seed: 8 });
      girdle(THREE, neck, p.leather, throat, [0, -.12, -.1], { n: 14, rot: [.55, 0, 0], thick: .014, height: .04, seed: 2 });
      const ring = surf(THREE, throat, [0, -.08, .5], [0, -.3, -1], -.025);
      loft(THREE, neck, p.iron, [[ring[0] - .03, ring[1] + .02, ring[2]], [ring[0], ring[1] - .02, ring[2] + .012], [ring[0] + .03, ring[1] + .02, ring[2]]], [.007, .007, .007], { sides: 4, seg: 2 });
      // Low sloping skull: an overhanging brow, sunken temples, a tumour swelling the left side of the vault. A riveted
      // iron band is bolted across the eyes and over the crown; blood weeps from under it; the right socket peers out.
      const skull = loft(THREE, head, p.skin, [[0, -.04, .01], [0, .0, .02], [0, .05, .028], [0, .1, .022], [0, .15, .0], [0, .2, -.04], [0, .25, -.09], [0, .29, -.14]],
        [[.15, .13], [.185, .175], [.19, .185], [.192, .185], [.185, .18], [.17, .165], [.13, .12], [0, 0]], { sides: 20, seg: 2, focus: .55, lump: .09, seed: 13, sculpt: [
          { at: [-.075, eyeY, .2], r: .07, d: -.04, dark: 1.4 }, { at: [.08, eyeY - .02, .19], r: .072, d: -.06, dark: 2.2 },
          { at: [-.13, eyeY + .06, .17], to: [.13, eyeY + .06, .17], r: .05, d: .04 }, { at: [0, .045, .22], r: .045, d: -.035, dark: 1.6 },
          { at: [-.14, .03, .13], r: .06, d: .025 }, { at: [.14, .03, .13], r: .06, d: .025 }, { at: [.05, .2, .1], r: .05, d: -.02, wound: .8 },
          { at: [-.16, .1, .06], r: .06, d: -.025 }, { at: [.16, .1, .06], r: .06, d: -.025 }, { at: [-.17, .19, -.06], r: .1, d: .05, color: T.bruise, weight: .6 },
          { at: [-.08, eyeY - .02, .2], to: [-.1, eyeY - .16, .17], r: .03, color: T.blood, weight: .9, wet: 1 },
          { at: [.1, eyeY - .06, .19], to: [.12, eyeY - .2, .16], r: .025, color: T.blood, weight: .8, wet: 1 }] });
      girdle(THREE, head, p.iron, skull, [0, eyeY + .03, .0], { n: 18, rot: [-.06, 0, .13], thick: .012, height: .028, seed: 3 });
      girdle(THREE, head, p.iron, skull, [0, eyeY + .03, -.02], { n: 9, rot: [0, 0, Math.PI / 2], from: .02, to: .62, thick: .011, height: .022, seed: 4 });
      for (const x of [-.13, -.04, .05, .14]) {
        const r = surf(THREE, skull, [x, eyeY + .03 - x * .13, .6], [0, 0, -1], -.024);
        box(THREE, head, p.iron, r[0], r[1], r[2], .016, .016, .01, 0, Math.atan2(x, .2), .13);
      }
      const eyeAt = surf(THREE, skull, [.085, eyeY - .025, .6], [0, 0, -1], -.002);
      box(THREE, head, p.eye, eyeAt[0], eyeAt[1], eyeAt[2], .02, .005, .003, 0, 0, -.12);
      dentition(THREE, head, p, { x: 0, y: .015, z: front + .015, width: .23, curve: .09, count: 15, length: .075, radius: .011, down: true, seed: 3, splay: .12 });
      dentition(THREE, head, p, { x: 0, y: .01, z: front - .035, width: .17, curve: .06, count: 7, length: .05, radius: .008, down: true, seed: 5, rake: -.4 });
      strand(THREE, head, p.tendon, [[.045, -.015, front + .01], [.05, -.1, front + .015], [.044, -.19, front]], .006, .002, { sides: 3, tint: () => [...T.drool, .6, 1] });
      // Jaw: a heavy mandible with tusks, gums, cheek tendons stretched to the skull and a strip of torn bite-mask.
      hollow(THREE, jaw, p.dark, -.014, -drop * .52, front + .01, .145, drop * .6, .16);
      loft(THREE, jaw, p.skin, [[-.15, .0, -.04], [-.14, -drop * .6, front * .5], [-.09, -drop * .95, front * .9], [0, -drop * 1.02, front + .045],
        [.09, -drop * .95, front * .9], [.14, -drop * .6, front * .5], [.15, .0, -.04]], [[.024, .04], [.026, .062], [.028, .07], [.03, .072], [.028, .07], [.026, .062], [.024, .04]],
      { sides: 8, seg: 2, up: [0, 1, 0], lump: .08, seed: 14, tint: (t, a) => Math.abs(a - .25) < .06 ? [...T.gum, .7 - Math.abs(a - .25) * 11, .6] : null });
      dentition(THREE, jaw, p, { x: 0, y: -drop + .045, z: front + .035, width: .2, curve: .08, count: 13, length: .065, radius: .01, seed: 7, splay: .15 });
      const tooth = t => t < .2 ? [...T.gum, 1 - t * 5, 1] : t > .7 ? [...T.nail, (t - .7) * 2, .6] : null;
      for (const side of [-1, 1]) {
        fang(THREE, jaw, p.bone, [side * .1, -drop * .78, front * .82], [side * .13, -drop * .78 + .17, front * .9], .021, [side * .012, 0, .03], tooth, 4);
        strand(THREE, jaw, p.tendon, [[side * .14, -drop * .55, front * .45], [side * .16, -drop * .25, front * .25], [side * .15, .0, .0]], .018, .013, { sides: 4 });
      }
      strand(THREE, jaw, p.leather, [[-.15, -.05, .02], [-.17, -drop * .7, front * .3], [-.15, -drop * 1.2, front * .5]], .022, .02, { sides: 3, up: [1, 0, 0] });
      return { front, eyeY, drips: [[-.02, 2.15, .33, .05, .7], [.08, 2.1, .3, .035, .9], [-.12, 2.05, .3, .03, .5], [-.53, 1.25, -.2, .08, .65], [.56, 1.1, -.15, .07, .5]] };
    },
    stalker(THREE, p, rig) {
      const { g, neck, head, jaw } = rig, T = tints(THREE), front = .142, eyeY = .105, drop = .33;
      // Starved torso: pinched waist, ribs under taut skin, a flayed left flank with the ribs standing over the cavity.
      const spine = [[0, 1.18, 0], [-.005, 1.36, -.02], [-.015, 1.55, -.04], [-.02, 1.75, -.03], [-.02, 1.93, -.02], [0, 2.07, 0], [.03, 2.16, .04]];
      const girth = [[.13, .095], [.15, .1], [.1, .07], [.15, .1], [.172, .112], [.16, .1], [.07, .065]];
      const ref = loft(THREE, new THREE.Group(), p.skin, spine, girth, { sides: 14, seg: 3 });
      loft(THREE, g, p.skin, spine, girth, { sides: 14, seg: 3, lump: .05, seed: 3, sculpt: [
        { at: [-.15, 1.74, .03], r: .14, d: -.05, wound: 1 }, { at: [.13, 1.62, -.07], r: .07, d: -.016, wound: .9 },
        { at: [-.12, 1.99, -.11], r: .08, d: .022 }, { at: [.12, 1.97, -.1], r: .08, d: .02 },
        { at: [-.115, 1.36, .07], r: .05, d: .018 }, { at: [.115, 1.36, .07], r: .05, d: .018 },
        { at: [0, 1.5, .07], r: .09, d: -.02, color: T.bruise, weight: .5 }] });
      loft(THREE, g, p.skin, [[-.3, 2.17, -.045], [-.15, 2.165, -.035], [.03, 2.13, -.005], [.15, 2.06, .015], [.28, 2.01, .04]],
        [[.06, .045], [.07, .05], [.075, .055], [.068, .05], [.055, .045]], { sides: 8, seg: 2, up: [0, 1, 0], lump: .06, seed: 5 });
      ribcage(THREE, g, p, ref, { count: 6, top: 1.93, gap: .062, center: [-.02, -.02], sides: [-1, 1], radius: .011, buried: .003,
        exposed: (side, i) => side < 0 && i > 0 && i < 5 });
      vertebrae(THREE, g, p, ref, { count: 11, from: 1.3, to: 2.1, radius: .016, z: -.02 });
      const sternum = [surf(THREE, ref, [0, 1.95, 1], [0, 0, -1]), surf(THREE, ref, [0, 1.6, 1], [0, 0, -1])];
      staples(THREE, g, p, sternum[0], sternum[1], 7, [0, 0, 1]);
      rag(THREE, g, p.cloth, .085, 1.42, .135, .22, .5, .025, 0, -.1, .12);
      rag(THREE, g, p.cloth, -.06, 1.66, -.15, .32, .8, .022, .07, Math.PI, -.08);
      rag(THREE, g, p.cloth, .2, 1.98, .02, .13, .36, .02, .05, -.4, .2);
      limbs(THREE, p, rig, () => ({ width: .072 }), i => ({ width: .054, hand: i ? { size: 1, length: 1.3 } : { size: 1.2, length: 1.6, claw: 1.4, curl: .4 } }));
      // A torn wrist restraint on the dragging arm, old dressings on the other.
      const [elbowL, elbowR] = rig.elbows, wl = rig.form.wrists[0];
      band(THREE, elbowL, p.leather, [wl[0], wl[1] + .07, wl[2]], .036, .03, .045, [.05, 0, .1], p.iron);
      strand(THREE, elbowL, p.leather, [[wl[0] + .03, wl[1] + .06, wl[2] + .02], [wl[0] + .05, wl[1] - .04, wl[2] + .05], [wl[0] + .04, wl[1] - .17, wl[2] + .02]],
        .012, .009, { sides: 3, up: [1, 0, 0] });
      wraps(THREE, elbowR, p.bandage, 0, -.12, .004, .04, 3);
      // Neck: a long stalk with corded tendons and a windpipe ridge.
      loft(THREE, neck, p.skin, [[-.07, -.26, -.19], [-.03, -.13, -.1], [0, -.03, -.045], [0, .05, -.02]], [.072, .052, .044, .05], { sides: 8, seg: 2, lump: .05, seed: 7 });
      strand(THREE, neck, p.tendon, [[-.04, .02, .02], [-.03, -.1, -.04], [-.02, -.24, -.1]], .011, .014, { sides: 3 });
      strand(THREE, neck, p.tendon, [[.04, .02, .0], [.035, -.1, -.05], [.02, -.22, -.12]], .01, .013, { sides: 3 });
      strand(THREE, neck, p.bone, [[0, -.04, .01], [-.01, -.14, -.035], [-.04, -.24, -.1]], .012, .01, { sides: 4 });
      // Elongated vault, sockets pressed in (the left one sewn shut), a lipless snout of needles and a hanging jaw.
      const skull = loft(THREE, head, p.skin, [[0, -.075, .0], [0, .0, .015], [0, .05, .017], [0, .1, .015], [0, .15, .004], [0, .22, -.02], [0, .31, -.05], [0, .42, -.1], [0, .47, -.12]],
        [[.07, .085], [.092, .11], [.098, .12], [.1, .125], [.104, .128], [.106, .13], [.1, .125], [.075, .1], [0, 0]], { sides: 20, seg: 2, focus: .6, lump: .035, seed: 9, sculpt: [
          { at: [.05, eyeY, .13], r: .062, d: -.045, dark: 1.9 }, { at: [-.05, eyeY + .004, .13], r: .055, d: -.028, color: T.bruise, weight: 1.2, wet: .9 },
          { at: [-.075, .158, .12], to: [.075, .158, .12], r: .03, d: .014 }, { at: [0, .045, .145], r: .036, d: -.026, dark: 1.6 },
          { at: [-.085, .055, .085], r: .04, d: .014 }, { at: [.085, .055, .085], r: .04, d: .014 },
          { at: [-.1, .16, .0], r: .05, d: -.012 }, { at: [.1, .16, .0], r: .05, d: -.012 },
          { at: [-.105, .24, .03], to: [.105, .25, .04], r: .02, d: -.006, wound: .8 }] });
      const scar = [surf(THREE, skull, [-.4, .23, .03], [1, 0, 0], -.002), surf(THREE, skull, [0, .25, .5], [0, 0, -1], -.002), surf(THREE, skull, [.4, .26, .04], [-1, 0, 0], -.002)];
      staples(THREE, head, p, scar[0], scar[1], 4, [0, 0, 1]); staples(THREE, head, p, scar[1], scar[2], 4, [0, 0, 1]);
      const eyeAt = surf(THREE, skull, [.048, eyeY, .5], [0, 0, -1], -.002);
      box(THREE, head, p.eye, eyeAt[0], eyeAt[1], eyeAt[2], .019, .005, .003, 0, 0, -.12);
      for (let i = 0; i < 4; i++) {
        const y = eyeY + .02 - i * .014, a = surf(THREE, skull, [-.075, y, .5], [0, 0, -1], -.002), b = surf(THREE, skull, [-.022, y - .006, .5], [0, 0, -1], -.002);
        strand(THREE, head, p.dark, [a, b], .0025, .0025, { sides: 3, caps: [false, false] });
      }
      dentition(THREE, head, p, { x: 0, y: .012, z: front + .012, width: .13, curve: .055, count: 13, length: .055, radius: .007, down: true, seed: 4, splay: .1 });
      dentition(THREE, head, p, { x: 0, y: .006, z: front - .025, width: .1, curve: .04, count: 8, length: .035, radius: .005, down: true, seed: 8, rake: -.4 });
      strand(THREE, head, p.tendon, [[.032, -.01, front + .01], [.035, -.08, front + .012], [.03, -.15, front + .002]], .0045, .0015,
        { sides: 3, tint: () => [...T.drool, .6, 1] });
      strand(THREE, head, p.tendon, [[-.05, -.015, front - .005], [-.052, -.11, front - .002]], .004, .002, { sides: 3, tint: () => [...T.drool, .6, 1] });
      // Jaw: a bare mandible hung far open, lower needles, cheek tendons stretched up to the skull.
      hollow(THREE, jaw, p.dark, -.014, -drop * .52, front + .01, .087, drop * .6, .17);
      loft(THREE, jaw, p.skin, [[-.085, .01, -.03], [-.08, -drop * .6, front * .45], [-.05, -drop * .95, front * .9], [0, -drop * 1.02, front + .04],
        [.05, -drop * .95, front * .9], [.08, -drop * .6, front * .45], [.085, .01, -.03]], [[.018, .02], [.022, .026], [.026, .03], [.028, .032], [.026, .03], [.022, .026], [.018, .02]],
      { sides: 8, seg: 2, up: [0, 1, 0], lump: .08, seed: 12, tint: (t, a) => Math.abs(a - .25) < .2 ? [...T.gum, 1 - Math.abs(a - .25) * 4, 1]
        : Math.abs(t - .5) < .12 ? [...T.tooth, .7, .4] : null });
      dentition(THREE, jaw, p, { x: 0, y: -drop + .03, z: front + .03, width: .1, curve: .06, count: 11, length: .05, radius: .0065, seed: 6, splay: .15 });
      for (const side of [-1, 1]) {
        strand(THREE, jaw, p.tendon, [[side * .08, -drop * .55, front * .4], [side * .095, -drop * .25, front * .2], [side * .09, .0, .0]], .012, .009, { sides: 4 });
        strand(THREE, jaw, p.flesh, [[side * .07, -drop * .8, front * .7], [side * .085, -drop * .45, front * .55], [side * .086, -.06, front * .45]], .008, .006, { sides: 3 });
      }
      strand(THREE, jaw, p.tendon, [[-.055, -drop * .85, front * .82], [-.058, -drop * 1.15, front * .8], [-.054, -drop * 1.4, front * .72]], .004, .0012,
        { sides: 3, tint: () => [...T.drool, .6, 1] });
      return { front, eyeY, drips: [[.04, 1.97, .3, .03, .55], [.12, 1.9, .26, .022, .75], [-.03, 1.88, .2, .018, .4]] };
    },
    crawler(THREE, p, rig) {
      const { g, head } = rig, T = tints(THREE), front = .142, eyeY = .055, f = rig.form;
      // An emaciated patient on all fours, belly to the floor, the arched spine splitting through its skin; the limbs
      // fold up above the body like a spider's, and lank black hair hangs round a face wrenched sideways.
      const spine = [[0, .5, -.66], [0, .55, -.48], [0, .62, -.24], [-.01, .66, .0], [-.02, .63, .2], [-.04, .58, .34]];
      const girth = [[.09, .07], [.16, .1], [.12, .085], [.16, .11], [.19, .12], [.1, .085]];
      const ref = loft(THREE, new THREE.Group(), p.skin, spine, girth, { sides: 14, seg: 3, up: [0, 1, 0] });
      loft(THREE, g, p.skin, spine, girth, { sides: 14, seg: 3, up: [0, 1, 0], lump: .06, seed: 5, sculpt: [
        { at: [0, .72, -.32], to: [-.01, .76, .08], r: .05, d: -.025, wound: 1 }, { at: [0, .47, -.2], r: .1, d: -.02 },
        { at: [-.12, .73, .2], r: .07, d: .03 }, { at: [.12, .71, .18], r: .07, d: .03 }, { at: [.14, .6, -.3], r: .06, d: -.015, wound: .7 },
        { at: [-.15, .55, .05], r: .08, d: -.01, color: T.bruise, weight: .8 }] });
      for (let i = 0; i < 6; i++) {
        const z = .26 - i * .065, cy = .64 - i * .006;
        for (const side of [-1, 1]) {
          const exposed = side > 0 && i > 0 && i < 4, pts = [];
          for (const ang of [.42, .25, 0, -.25, -.4]) {
            const a = ang * Math.PI, dx = side * Math.cos(a), dy = Math.sin(a);
            pts.push(surf(THREE, ref, [-.015 + dx, cy + dy, z - Math.abs(ang) * .04], [-dx, -dy, 0], exposed ? -.016 : .005));
          }
          strand(THREE, g, p.bone, pts, exposed ? .012 : .01, .008, { sides: 4, caps: [false, true], tint: exposed ? (t => [...T.wound, .35 + .4 * Math.sin(t * 9) ** 2, 1]) : null });
        }
      }
      for (let i = 0; i < 12; i++) {
        const z = -.45 + i * .065, at = surf(THREE, ref, [Math.sin(i * 1.3) * .006, 1.5, z], [0, -1, 0], .006), r = .021 * (1 - .3 * Math.abs(i / 11 - .5));
        fang(THREE, g, p.bone, at, [at[0], at[1] + r * 2.2, at[2] - r * .9], r, [0, 0, r * .3], null, 4);
      }
      // What is left of the gown, plastered over the back.
      loft(THREE, g, p.cloth, [[0, .53, -.5], [0, .6, -.3], [0, .655, -.05], [-.01, .625, .16]], [[.185, .125], [.145, .11], [.18, .125], [.21, .135]],
        { sides: 14, seg: 2, up: [0, 1, 0], caps: [false, false], folds: [6, .05], seed: 7, skip: (t, a, x, y) => y < .57 || Math.abs(x) < .05 || noise3(t * 6, a * 9, 4) > .68 });
      rag(THREE, g, p.cloth, .16, .5, -.1, .12, .26, .02, .1, Math.PI / 2, .1);
      rag(THREE, g, p.bandage, -.15, .5, -.35, .07, .22, .015, .05, -Math.PI / 2, -.1);
      // Neck stalk (on the body: the crawler spends no draw on a neck group).
      loft(THREE, g, p.skin, [[-.03, .6, .28], [-.05, .585, .38], [-.065, .56, .46], [-.07, .54, .52]], [[.065, .055], [.052, .048], [.048, .044], [.044, .04]],
        { sides: 8, seg: 2, up: [0, 1, 0], lump: .06, seed: 6 });
      for (const side of [-1, 1]) strand(THREE, g, p.tendon, [[side * .04 - .03, .64, .3], [side * .035 - .06, .6, .42], [side * .03 - .07, .58, .5]], .011, .008, { sides: 3 });
      for (let i = 0; i < 2; i++) {
        const side = i ? 1 : -1;
        rig.knees.push(crawlLimb(THREE, p, i ? rig.legR : rig.legL, i ? 'kneeR' : 'kneeL', f.knees[i], f.ankles[i], { width: .072, side, rootY: f.hips[i][1], seed: 31 + i }));
        rig.elbows.push(crawlLimb(THREE, p, i ? rig.armR : rig.armL, i ? 'elbowR' : 'elbowL', f.elbows[i], f.wrists[i], { width: .067, side, rootY: f.shoulders[i][1], seed: 41 + i }));
      }
      const [elbowL] = rig.elbows, wl = f.wrists[0];
      band(THREE, elbowL, p.leather, [wl[0] * .9, wl[1] * .9, wl[2] * .9], .032, .028, .04, [.3, 0, .1], p.iron);
      strand(THREE, elbowL, p.leather, [[wl[0] * .9 + .03, wl[1] * .9, wl[2] * .9], [wl[0] * .9 + .08, wl[1] * .9 - .03, wl[2] * .9 - .06], [wl[0] * .9 + .1, wl[1] * .9 - .04, wl[2] * .9 - .2]],
        .011, .009, { sides: 3, up: [0, 1, 0] });
      wraps(THREE, rig.knees[1], p.bandage, f.ankles[1][0] * .5, f.ankles[1][1] * .5, f.ankles[1][2] * .5, .05, 3);
      // Head: a gaping lipless mouth that cannot close, one staring socket, the other sewn shut.
      const skull = loft(THREE, head, p.skin, [[0, -.17, -.02], [0, -.12, .0], [0, -.06, .02], [0, .0, .025], [0, .06, .02], [0, .12, .0], [0, .17, -.04], [0, .2, -.07]],
        [[.06, .07], [.085, .1], [.1, .115], [.112, .122], [.115, .122], [.11, .115], [.085, .09], [0, 0]], { sides: 18, seg: 2, focus: .5, lump: .05, seed: 15, sculpt: [
          { at: [0, -.075, .15], r: .11, color: T.gum, weight: .8, wet: 1 }, { at: [0, -.06, .14], to: [0, -.1, .14], r: .065, d: -.07, dark: 2.4 },
          { at: [.045, eyeY, .125], r: .042, d: -.035, dark: 2 }, { at: [-.045, eyeY + .004, .125], r: .04, d: -.018, color: T.bruise, weight: 1.1, wet: .9 },
          { at: [-.075, eyeY + .035, .11], to: [.075, eyeY + .035, .11], r: .022, d: .012 }, { at: [-.085, -.01, .1], r: .04, d: .015 }, { at: [.085, -.01, .1], r: .04, d: .015 },
          { at: [-.1, .09, .03], r: .04, d: -.012 }, { at: [.1, .09, .03], r: .04, d: -.012 }, { at: [.06, .15, .06], r: .03, d: -.01, wound: .8 },
          { at: [0, .23, -.03], r: .2, d: .008, color: T.socket, weight: 1.6, wet: .85 }] });
      hollow(THREE, head, p.dark, 0, -.08, front - .025, .052, .07, .1);
      const eyeAt = surf(THREE, skull, [.045, eyeY, .5], [0, 0, -1], -.002);
      box(THREE, head, p.eye, eyeAt[0], eyeAt[1], eyeAt[2], .018, .006, .003, 0, 0, .1);
      for (let i = 0; i < 3; i++) {
        const y = eyeY + .018 - i * .016, a = surf(THREE, skull, [-.068, y, .5], [0, 0, -1], -.002), b = surf(THREE, skull, [-.022, y - .005, .5], [0, 0, -1], -.002);
        strand(THREE, head, p.dark, [a, b], .0025, .0025, { sides: 3, caps: [false, false] });
      }
      dentition(THREE, head, p, { x: 0, y: -.032, z: front - .012, width: .1, curve: .05, count: 11, length: .045, radius: .0065, down: true, seed: 9, splay: .15 });
      dentition(THREE, head, p, { x: 0, y: -.128, z: front - .02, width: .09, curve: .045, count: 10, length: .04, radius: .006, seed: 10, splay: .2, rake: .1 });
      strand(THREE, head, p.tendon, [[.03, -.13, front - .01], [.034, -.2, front], [.03, -.27, front - .02]], .004, .0012, { sides: 3, tint: () => [...T.drool, .6, 1] });
      // Lank wet hair from the crown, parted round the face, hanging toward the floor.
      const random = seeded(29);
      for (let i = 0; i < 36; i++) {
        const phi = (i / 36 - .5) * TAU + (random() - .5) * .1, sx = Math.sin(phi), sz = Math.cos(phi);
        const root = surf(THREE, skull, [sx, .13 + random() * .05, sz - .02], [-sx, 0, -sz], .006), len = .24 + random() * .12, sway = (random() - .5) * .04;
        let pts;
        if (sz > .55) {
          // Bangs: hanging over the eyes and down past the mouth, parted so the grin shows through.
          const xs = (sx < 0 || (sx === 0 && i % 2) ? -1 : 1) * (.036 + Math.abs(root[0]) * .7 + random() * .02);
          pts = [root, [root[0] * .9 + xs * .2, root[1] + .01, root[2] + .035], [xs, eyeY - .02, .172 + random() * .02], [xs * 1.08 + sway, -.12, .168], [xs * 1.12 - sway, -.2 - random() * .08, .15]];
        } else {
          const out = 1.06 + random() * .06;
          pts = [root, [root[0] * 1.1 + sx * .015, root[1] - .03, root[2] * 1.1 + sz * .015], [root[0] * out + sway, root[1] - len * .4, root[2] * out + sz * .01],
            [root[0] * out - sway, root[1] - len * .75, root[2] * out], [root[0] * (out - .03) + sway, root[1] - len, root[2] * (out - .03)]];
        }
        strand(THREE, head, p.dark, pts, .0045 + random() * .003, .0015, { sides: 3 });
      }
      return { front, eyeY, drips: [] };
    },
    shrieker(THREE, p, rig) {
      const { g, neck, head, jaw } = rig, T = tints(THREE), front = .142, eyeY = .132, drop = .565, zf = front - .025;
      // Gaunt and pale: a sunken belly, the sternum sawn open and the ribs prised apart, a smock off one shoulder.
      const spine = [[0, .96, -.03], [0, 1.12, -.01], [.005, 1.32, -.03], [.01, 1.52, -.04], [.012, 1.68, -.02], [.015, 1.8, .03]];
      const girth = [[.15, .1], [.13, .085], [.105, .07], [.145, .1], [.165, .105], [.08, .07]];
      const ref = loft(THREE, new THREE.Group(), p.skin, spine, girth, { sides: 14, seg: 3 });
      loft(THREE, g, p.skin, spine, girth, { sides: 14, seg: 3, focus: .25, lump: .05, seed: 4, sculpt: [
        { at: [0, 1.66, .1], to: [0, 1.3, .07], r: .075, d: -.045, wound: 1.1 }, { at: [0, 1.15, .07], r: .09, d: -.03, color: T.bruise, weight: .6 },
        { at: [-.12, 1.66, -.1], r: .07, d: .02 }, { at: [.12, 1.64, -.1], r: .07, d: .02 }, { at: [.1, 1.2, -.06], r: .06, d: -.015, wound: .6 }] });
      ribcage(THREE, g, p, ref, { count: 6, top: 1.68, gap: .06, center: [0, -.02], sides: [-1, 1], radius: .011, buried: .003, exposed: (side, i) => i >= 1 && i <= 4 });
      vertebrae(THREE, g, p, ref, { count: 10, from: 1.05, to: 1.75, radius: .016, z: -.03 });
      loft(THREE, g, p.skin, [[-.31, 1.79, .0], [-.15, 1.81, -.005], [.02, 1.8, .01], [.15, 1.75, -.01], [.29, 1.71, -.03]],
        [[.055, .045], [.065, .05], [.07, .055], [.062, .05], [.05, .045]], { sides: 8, seg: 2, up: [0, 1, 0], lump: .06, seed: 6 });
      loft(THREE, g, p.cloth, [[0, 1.79, 0], [0, 1.6, -.01], [0, 1.38, -.02], [0, 1.15, -.02], [0, .92, -.03]], [[.2, .12], [.18, .125], [.16, .115], [.19, .135], [.23, .16]],
        { sides: 14, seg: 2, caps: [false, false], folds: [7, .06, 1.2], seed: 9, skip: (t, a, x, y) => (Math.abs(a - .25) < .1 && y > 1.12) || (x < -.08 && y > 1.6)
          || noise3(t * 7, a * 9, 3) > .72 || (t > .82 && noise3(a * 17, 2, 5) > .45) });
      rag(THREE, g, p.cloth, .05, .78, .12, .14, .36, .02, 0, -.1, .08);
      limbs(THREE, p, rig, () => ({ width: .068, lump: .06 }), () => ({ width: .052, lump: .06, hand: { size: .95, length: 1.4, claw: 1.35, curl: .95 } }));
      wraps(THREE, rig.elbows[1], p.bandage, -.06, -.1, .1, .04, 3);
      rag(THREE, rig.armL, p.bandage, -.06, -.2, .03, .05, .26, .013, 0, 0, -.15);
      // An opened throat: the windpipe's rings bare inside a split neck.
      const n0 = [-.015, -.15, -.2], n1 = [0, .04, 0];
      loft(THREE, neck, p.skin, [n0, [-.01, -.08, -.1], [0, -.02, -.03], n1], [.06, .05, .045, .05], { sides: 8, seg: 2, lump: .05, seed: 7,
        skip: (t, a) => Math.abs(a - .25) < .1 && t > .15 && t < .85, sculpt: [{ at: [0, -.05, -.02], r: .05, wound: .9 }] });
      strand(THREE, neck, p.dark, [n0, n1], .032, .03, { sides: 6 });
      for (let i = 0; i < 6; i++) {
        const t = .2 + i * .12;
        band(THREE, neck, p.bone, [n0[0] + (n1[0] - n0[0]) * t, n0[1] + (n1[1] - n0[1]) * t - .015, n0[2] + (n1[2] - n0[2]) * t + .022], .02, .02, .008, [.81, 0, 0]);
      }
      for (const side of [-1, 1]) strand(THREE, neck, p.tendon, [[side * .05, .04, -.04], [side * .055, -.06, -.08], [side * .04, -.17, -.17]], .011, .013, { sides: 3 });
      // Head: a narrow eyeless vault, the cheeks torn back to the hinges, the upper teeth bare.
      const skull = loft(THREE, head, p.skin, [[0, -.04, -.01], [0, .03, .008], [0, .09, .014], [0, .15, .008], [0, .21, -.02], [0, .27, -.06], [0, .31, -.09]],
        [[.085, .09], [.1, .11], [.108, .118], [.11, .12], [.105, .115], [.082, .09], [0, 0]], { sides: 18, seg: 2, focus: .5, lump: .04, seed: 10, sculpt: [
          { at: [-.045, eyeY, .115], r: .045, d: -.035, dark: 2 }, { at: [.048, eyeY - .006, .115], r: .043, d: -.032, dark: 1.8 },
          { at: [-.07, eyeY + .04, .1], to: [.07, eyeY + .04, .1], r: .025, d: .012 }, { at: [0, .075, .125], r: .03, d: -.025, dark: 1.5 },
          { at: [-.07, .02, .1], to: [-.105, .1, .0], r: .02, d: -.012, wound: 1 }, { at: [.07, .02, .1], to: [.105, .1, .0], r: .02, d: -.012, wound: 1 },
          { at: [-.1, .17, .02], r: .045, d: -.012 }, { at: [.1, .17, .02], r: .045, d: -.012 },
          { at: [-.02, .3, .0], to: [.03, .2, .1], r: .018, d: -.008, wound: .9 }, { at: [.06, .22, -.08], r: .05, color: T.bruise, weight: .7 }] });
      staples(THREE, head, p, surf(THREE, skull, [-.02, .6, -.02], [0, -1, 0], -.002), surf(THREE, skull, [.03, .2, 1], [0, 0, -1], -.002), 5, [0, .7, .7]);
      const eyeAt = surf(THREE, skull, [.048, eyeY - .006, .5], [0, 0, -1], -.002);
      box(THREE, head, p.eye, eyeAt[0], eyeAt[1], eyeAt[2], .018, .005, .003, 0, 0, .1);
      dentition(THREE, head, p, { x: 0, y: .02, z: front - .005, width: .11, curve: .05, count: 12, length: .05, radius: .006, down: true, seed: 11, splay: .1 });
      strand(THREE, head, p.tendon, [[-.03, .0, front - .01], [-.034, -.08, front], [-.03, -.16, front - .01]], .004, .0015, { sides: 3, tint: () => [...T.drool, .6, 1] });
      // Jaw: two mandibles split apart at the chin, hung to the sternum, their inner edges lined with teeth; a long
      // tongue lolls between them over the dark of the throat.
      hollow(THREE, jaw, p.dark, 0, -drop * .5, zf - .01, .075, drop * .62, .14);
      const tooth = t => t < .2 ? [...T.gum, 1 - t * 5, 1] : t > .7 ? [...T.nail, (t - .7) * 2, .6] : null;
      for (const side of [-1, 1]) {
        const rail = [[side * .087, -.02, -.035], [side * .1, -.12, zf * .55], [side * .088, -.27, zf * .9], [side * .07, -.42, zf + .005], [side * .045, -drop, zf + .012], [side * .03, -drop - .07, zf - .01]];
        loft(THREE, jaw, p.skin, rail, [[.022, .034], [.024, .04], [.022, .036], [.019, .03], [.015, .022], [0, 0]], { sides: 6, seg: 2, lump: .06, seed: 16 + side,
          tint: (t, a) => { const inner = side > 0 ? Math.abs(a - .5) : Math.min(a, 1 - a); return inner < .09 ? [...T.gum, .8 - inner * 8, .7] : null; } });
        for (let k = 0; k < 9; k++) {
          const s = .6 + k * .48, i = Math.floor(s), u = s - i, a = rail[i], b = rail[i + 1], len = .04 + .028 * Math.sin(k * 2.1 + side) ** 2;
          const base = [a[0] + (b[0] - a[0]) * u - side * .01, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u + .004];
          fang(THREE, jaw, p.bone, base, [base[0] - side * len, base[1] + len * .45, base[2] + .008], .0085, [0, .006, .004], tooth, 3);
        }
        strand(THREE, jaw, p.tendon, [[side * .1, .0, .03], [side * .1, -.15, zf * .7], [side * .085, -.3, zf * .85]], .01, .007, { sides: 4 });
        strand(THREE, jaw, p.flesh, [[side * .1, -.04, .0], [side * .095, -.2, zf * .65]], .011, .008, { sides: 3, tint: () => [...T.wound, .8, 1] });
      }
      loft(THREE, jaw, p.tendon, [[-.035, -.08, -.0], [-.042, -.3, zf * .6], [-.045, -.5, zf + .02], [-.035, -.66, zf + .05], [-.025, -.76, zf]],
        [[.02, .01], [.022, .011], [.02, .01], [.015, .008], [0, 0]], { sides: 6, seg: 2, lump: .15, seed: 18, tint: () => [...T.bruise, .45, 1] });
      for (const [y0, y1] of [[-.2, -.23], [-.53, -.57]]) {
        strand(THREE, jaw, p.tendon, [[-.075, y0, zf * .8], [0, y1 - .05, zf * .85], [.07, y0 - .01, zf * .8]], .0035, .0035, { sides: 3, caps: [false, false], tint: () => [...T.drool, .7, 1] });
      }
      return { front, eyeY, drips: [[0, 1.66, .1, .045, .7], [-.05, 1.5, .06, .03, .45], [.06, 1.62, .08, .025, .55]] };
    },
    gravekeeper(THREE, p, rig) {
      const { g, neck, head, jaw } = rig, T = tints(THREE), front = .175, eyeY = .1, drop = .23, jf = front - .06, f = rig.form;
      // The boss: a towering, starved gravedigger. Ribs bare through a rotted chest, a grave-coat in tatters, a coffin lid
      // strapped to its back with a crook rising from it to dangle a lantern before its face, and a spade grown into
      // its right arm.
      const spine = [[0, 1.56, -.02], [0, 1.85, -.05], [0, 2.15, -.09], [0, 2.45, -.09], [0, 2.7, -.03], [0, 2.9, .08], [0, 3.0, .2]];
      const girth = [[.2, .13], [.16, .1], [.14, .095], [.19, .125], [.23, .145], [.17, .12], [.09, .08]];
      const ref = loft(THREE, new THREE.Group(), p.skin, spine, girth, { sides: 14, seg: 3 });
      loft(THREE, g, p.skin, spine, girth, { sides: 14, seg: 3, focus: .2, lump: .07, seed: 21, sculpt: [
        { at: [-.12, 2.5, .1], r: .14, d: -.05, wound: .9 }, { at: [0, 2.02, .1], r: .13, d: -.045, color: T.rot, weight: 1 },
        { at: [.1, 2.2, .08], r: .06, d: -.02, dark: 1.2 }, { at: [.15, 1.8, -.05], r: .07, d: -.02, wound: .6 }, { at: [0, 2.0, -.1], r: .1, color: T.moss, weight: .6 }] });
      ribcage(THREE, g, p, ref, { count: 7, top: 2.72, gap: .07, center: [0, -.04], sides: [-1, 1], radius: .014, buried: .004, exposed: (side, i) => side < 0 && i >= 1 && i <= 5 });
      vertebrae(THREE, g, p, ref, { count: 12, from: 1.7, to: 2.85, radius: .024, z: -.06 });
      const yoke = loft(THREE, g, p.skin, [[-.52, 2.86, -.02], [-.28, 2.97, -.04], [0, 3.0, .02], [.26, 2.92, .05], [.54, 2.78, .07]],
        [[.09, .08], [.11, .1], [.12, .1], [.11, .1], [.09, .08]], { sides: 8, seg: 2, up: [0, 1, 0], lump: .08, seed: 22 });
      // Grave-coat: open down the front, split up the back, its hem shredded; a mantle over the shoulders.
      const coat = loft(THREE, g, p.cloth, [[0, 2.93, -.02], [0, 2.7, -.05], [0, 2.4, -.1], [0, 2.05, -.08], [0, 1.7, -.04], [0, 1.25, -.03], [0, .85, -.03], [0, .55, -.05]],
        [[.34, .2], [.29, .2], [.25, .18], [.24, .17], [.29, .21], [.37, .27], [.43, .32], [.47, .35]], { sides: 22, seg: 2, caps: [false, false], folds: [11, .1, 1.2], seed: 23,
          skip: (t, a, x, y) => Math.abs(a - .25) < (y < 1.75 ? .15 : .055) || (y < 1.35 && Math.abs(a - .75) < .045) || (y < .9 && noise3(a * 23, 3, 1) > .5) || noise3(t * 9, a * 13, 5) > .78,
          tint: (t, a, x, y) => y < 1 ? [...T.moss, (1 - y) * .9, .3] : null });
      loft(THREE, g, p.cloth, [[0, 3.04, .1], [0, 2.92, .02], [0, 2.72, -.03], [0, 2.48, -.05]], [[.15, .13], [.38, .25], [.5, .31], [.54, .33]],
        { sides: 22, seg: 2, caps: [false, false], folds: [9, .13, 1.5], seed: 24, skip: (t, a) => (t > .5 && noise3(a * 19, t * 3, 2) > .45 - (t - .5) * .4) || (Math.abs(a - .25) < .05 + t * .04 && t > .3) });
      girdle(THREE, g, p.leather, coat, [0, 1.72, -.04], { n: 16, rot: [0, 0, -.06], thick: .012, height: .035, seed: 5 });
      // A ring of iron keys at the hip.
      const ringAt = surf(THREE, coat, [1, 1.62, .05], [-1, 0, 0], -.02);
      const keyRing = Array.from({ length: 9 }, (_, i) => [ringAt[0] + .01 * Math.sin(i / 8 * TAU), ringAt[1] - .035 + .035 * Math.cos(i / 8 * TAU), ringAt[2] + .035 * Math.sin(i / 8 * TAU)]);
      loft(THREE, g, p.iron, keyRing, keyRing.map(() => .004), { sides: 4, seg: 1, caps: [false, false] });
      for (let i = 0; i < 4; i++) {
        const top = [ringAt[0] + .01, ringAt[1] - .065, ringAt[2] + (i - 1.5) * .018], len = .07 + i % 2 * .03;
        strand(THREE, g, p.iron, [top, [top[0] + .004, top[1] - len, top[2] + (i - 1.5) * .006]], .004, .003, { sides: 3 });
        box(THREE, g, p.iron, top[0] + .004, top[1] - len + .01, top[2] + (i - 1.5) * .006 + .008, .006, .022, .016, 0, 0, 0);
      }
      // The coffin lid: three warped planks, a nailed iron cross, two straps over the shoulders.
      const lid = [[-.17, 0], [.17, 0], [.29, 1.2], [.21, 1.72], [-.21, 1.72], [-.29, 1.2]];
      const lidAt = [.06, 1.76, -.43], lidRot = [.04, .05, -.08], lidE = new THREE.Euler(...lidRot);
      const onLid = (u, v, z) => new THREE.Vector3(u, v, z).applyEuler(lidE).add(new THREE.Vector3(...lidAt)).toArray();
      for (const [u0, u1, k] of [[-.3, -.103, 0], [-.091, .091, 1], [.103, .3, 2]]) {
        slab(THREE, g, p.wood, clipStrip(lid, u0, u1), .045, onLid(0, 0, (k - 1) * .004), [lidRot[0] + (k - 1) * .015, lidRot[1], lidRot[2] + (k - 1) * .006],
          { tint: (u, v) => [...T.moss, .1 + .35 * noise3(u * 9 + k, v * 4, 3), .2] });
      }
      const cross = onLid(0, 1.18, -.03);
      box(THREE, g, p.iron, cross[0], cross[1], cross[2], .045, .62, .014, lidRot[0], lidRot[1], lidRot[2]);
      const arm = onLid(0, 1.32, -.03);
      box(THREE, g, p.iron, arm[0], arm[1], arm[2], .3, .045, .014, lidRot[0], lidRot[1], lidRot[2]);
      for (const side of [-1, 1]) {
        const a = onLid(side * .16, 1.55, .0), b = surf(THREE, [yoke, ref], [side * .2, 3.4, -.05], [0, -1, 0], -.07);
        const c = surf(THREE, ref, [side * .1, 2.62, 1], [0, 0, -1], -.012), d = surf(THREE, ref, [-side * .12, 1.95, 1], [0, 0, -1], -.012);
        strand(THREE, g, p.leather, [a, [a[0] * .8, b[1] + .02, (a[2] + b[2]) * .5], b, c, d], .02, .02, { sides: 4, up: [0, 0, 1], tint: () => [...T.moss, .3, .2] });
      }
      // The crook and its cage-lantern, hung before the face.
      const pole = [onLid(.2, 1.6, .04), [.21, 3.5, -.25], [.2, 3.585, .05], [.18, 3.55, .38], [.17, 3.47, .55]];
      loft(THREE, g, p.wood, pole, [.02, .019, .018, .016, .013], { sides: 6, seg: 3, lump: .12, seed: 26 });
      const L = [.17, 3.22, .56];
      strand(THREE, g, p.iron, [[.17, 3.47, .56], [.172, 3.4, .562], [L[0], L[1] + .1, L[2]]], .005, .005, { sides: 3 });
      loft(THREE, g, p.iron, [[L[0], L[1] + .115, L[2]], [L[0], L[1] + .095, L[2]], [L[0], L[1] + .085, L[2]]], [.012, .055, .062], { sides: 8, seg: 1 });
      loft(THREE, g, p.iron, [[L[0], L[1] - .085, L[2]], [L[0], L[1] - .075, L[2]]], [.058, .058], { sides: 8, seg: 1 });
      for (let i = 0; i < 6; i++) {
        const a = i / 6 * TAU, x = L[0] + Math.cos(a) * .055, z = L[2] + Math.sin(a) * .055;
        strand(THREE, g, p.iron, [[x, L[1] + .088, z], [x * 1.0 + Math.cos(a) * .006, L[1], z + Math.sin(a) * .006], [x, L[1] - .078, z]], .004, .004, { sides: 3 });
      }
      loft(THREE, g, p.bone, [[L[0], L[1] - .075, L[2]], [L[0], L[1] - .02, L[2]]], [.017, .015], { sides: 6, seg: 1, tint: () => [...T.wax, .8, .4] });
      const lantern = new THREE.MeshStandardMaterial({ color: 0x2a1a08, emissive: 0xff9a3c, emissiveIntensity: 2.4, roughness: .6, metalness: 0, fog: true });
      loft(THREE, g, lantern, [[L[0], L[1] - .022, L[2]], [L[0], L[1] + .005, L[2]], [L[0], L[1] + .04, L[2]]], [.012, .016, 0], { sides: 6, seg: 2 });
      // Limbs: bare, starved and over-long; the left hand a rake of claws, the right forearm ending in the spade.
      limbs(THREE, p, rig, () => ({ width: .1, foot: 1.4, lump: .09 }),
        i => i ? { width: .078, lump: .09, hand: false } : { width: .075, lump: .09, hand: { size: 1.5, length: 1.8, claw: 1.7, curl: .55, thick: 1.1 } });
      for (const [i, limb] of [rig.armL, rig.armR].entries()) {
        const b = f.elbows[i];
        loft(THREE, limb, p.cloth, [[0, .07, 0], [b[0] * .45, b[1] * .45, b[2] * .45], [b[0] * .8, b[1] * .8, b[2] * .8]], [[.13, .12], [.11, .1], [.1, .095]],
          { sides: 10, seg: 2, caps: [false, false], folds: [5, .05], seed: 27 + i, skip: (t, a) => t > .55 && noise3(a * 9, t * 4, 3 + i) > .45 });
      }
      for (const knee of rig.knees) wraps(THREE, knee, p.bandage, 0, -.25, .01, .085, 4);
      const e = f.wrists[1], el = Math.hypot(...e), dir = e.map(v => v / el), [, elbowR] = rig.elbows;
      const at = k => [e[0] + dir[0] * k, e[1] + dir[1] * k, e[2] + dir[2] * k];
      strand(THREE, elbowR, p.wood, [at(-el * .65), at(-el * .3), e, at(.15), at(.32)], .021, .019, { sides: 6, tint: (t) => t < .5 ? [...T.blood, .5, .6] : null });
      loft(THREE, elbowR, p.flesh, [at(-.08), at(-.02), at(.04)], [[.045, .04], [.04, .036], [.026, .024]], { sides: 8, seg: 2, lump: .3, seed: 28, tint: () => [...T.wound, .7, 1] });
      for (let k = 0; k < 7; k++) {
        const a = k * 1.9, c = at(-.06 + k * .012);
        strand(THREE, elbowR, p.iron, [[c[0] + Math.cos(a) * .035, c[1], c[2] + Math.sin(a) * .035], [c[0] + Math.cos(a + 1.6) * .035, c[1] - .01, c[2] + Math.sin(a + 1.6) * .035]], .003, .003, { sides: 3 });
      }
      const blade = [[-.13, 0], [-.15, -.29], [0, -.43], [.15, -.29], [.13, 0]];
      slab(THREE, elbowR, p.iron, blade, .012, at(.3), [Math.atan2(-dir[2], -dir[1]), 0, 0], { cup: .9,
        tint: (u, v) => v < -.2 ? [...T.blood, .85, .9] : [...T.rust, .55, .3] });
      // Neck: long and corded, a hangman's noose still knotted round it.
      const throat = loft(THREE, neck, p.skin, [[0, -.1, -.26], [0, -.06, -.16], [0, -.02, -.07], [0, .03, 0]], [.085, .075, .07, .07], { sides: 10, seg: 2, lump: .08, seed: 29 });
      girdle(THREE, neck, p.bandage, throat, [0, -.04, -.1], { n: 12, rot: [.9, 0, .1], thick: .014, height: .014, lump: .2, seed: 6 });
      const knot = surf(THREE, throat, [.6, -.02, -.1], [-1, 0, 0], -.012);
      strand(THREE, neck, p.bandage, [knot, [knot[0] + .03, knot[1] - .1, knot[2] - .02], [knot[0] + .025, knot[1] - .26, knot[2] - .06]], .016, .012, { sides: 4, lump: .2 });
      for (const side of [-1, 1]) strand(THREE, neck, p.tendon, [[side * .055, .02, -.01], [side * .06, -.06, -.1], [side * .05, -.1, -.22]], .012, .014, { sides: 3 });
      // Head: a long gaunt skull in a hood, antlers grown up through the cloth, coins on the eyes (the right one has
      // slipped), a second ring of teeth waiting in the throat.
      const skull = loft(THREE, head, p.skin, [[0, -.06, .035], [0, -.03, .045], [0, .0, .055], [0, .08, .05], [0, .16, .025], [0, .24, -.02], [0, .3, -.08], [0, .34, -.13]],
        [[.08, .095], [.095, .11], [.105, .12], [.112, .125], [.115, .125], [.11, .118], [.085, .09], [0, 0]], { sides: 20, seg: 2, focus: .55, lump: .07, seed: 30, sculpt: [
          { at: [-.048, eyeY, .155], r: .045, d: -.035, dark: 1.6 }, { at: [.05, eyeY - .004, .155], r: .05, d: -.05, dark: 2.4 },
          { at: [-.08, eyeY + .045, .14], to: [.08, eyeY + .045, .14], r: .025, d: .016 }, { at: [0, .045, .17], r: .03, d: -.03, dark: 1.5 },
          { at: [-.1, -.03, .09], r: .055, d: -.03 }, { at: [.1, -.03, .09], r: .055, d: -.03 }, { at: [-.09, .06, .12], r: .035, d: .015 }, { at: [.09, .06, .12], r: .035, d: .015 },
          { at: [.08, .2, .08], r: .06, color: T.rot, weight: .8 }, { at: [-.06, -.1, .1], r: .04, d: -.015, wound: .8 }] });
      for (const [x, y, tilt] of [[-.048, eyeY, 0]]) {
        const c = surf(THREE, skull, [x, y, .6], [0, 0, -1], -.004), n = [0, Math.sin(tilt) * .004, .004];
        loft(THREE, head, p.iron, [[c[0], c[1] - n[1], c[2] - n[2]], [c[0], c[1] + n[1], c[2] + n[2]]], [.023, .023], { sides: 10, seg: 1,
          tint: () => [...(x < 0 ? T.brass : T.verdigris), .9, .5] });
      }
      const eyeAt = surf(THREE, skull, [.05, eyeY + .012, .6], [0, 0, -1], -.002);
      box(THREE, head, p.eye, eyeAt[0], eyeAt[1], eyeAt[2], .018, .005, .003, 0, 0, -.1);
      loft(THREE, head, p.cloth, [[0, -.34, -.12], [0, -.18, -.08], [0, 0, -.05], [0, .16, -.05], [0, .3, -.1], [0, .38, -.16], [0, .41, -.22]],
        [[.2, .17], [.19, .18], [.175, .2], [.17, .19], [.15, .16], [.1, .1], [0, 0]], { sides: 16, seg: 2, folds: [5, .04], seed: 25,
          skip: (t, a) => Math.abs(a - .25) < .17 && t > .14 && t < .74 });
      for (const side of [-1, 1]) {
        const base = surf(THREE, skull, [side * .055, .6, -.03], [0, -1, 0], .01);
        const beam = [base, [side * .1, .34, -.06], [side * .18, .385, -.07], [side * .26, .405, -.06], [side * .31, .43, -.02]];
        loft(THREE, head, p.bone, beam, [.024, .02, .016, .011, 0], { sides: 5, seg: 2, lump: .15, seed: 31 + side, tint: t => [...T.moss, .4 * (1 - t), .2] });
        fang(THREE, head, p.bone, beam[2], [beam[2][0] + side * .02, beam[2][1] + .07, beam[2][2] + .06], .012, [0, 0, .01], null, 4);
        fang(THREE, head, p.bone, beam[3], [beam[3][0] + side * .03, beam[3][1] + .05, beam[3][2] - .02], .009, [0, 0, 0], null, 4);
        fang(THREE, head, p.bone, beam[1], [beam[1][0] + side * .06, beam[1][1] + .03, beam[1][2] + .09], .01, [0, .02, 0], null, 4);
      }
      dentition(THREE, head, p, { x: 0, y: -.02, z: front - .008, width: .15, curve: .07, count: 14, length: .07, radius: .008, down: true, seed: 31, splay: .08 });
      const inner = [0, -.075, .085];
      loft(THREE, head, p.flesh, Array.from({ length: 11 }, (_, i) => [inner[0] + Math.cos(i / 10 * TAU) * .042, inner[1] + Math.sin(i / 10 * TAU) * .042, inner[2]]),
        Array.from({ length: 11 }, () => .012), { sides: 5, seg: 2, caps: [false, false], lump: .2, seed: 33, tint: () => [...T.gum, .6, 1] });
      for (let i = 0; i < 10; i++) {
        const a = i / 10 * TAU + .3, cx = Math.cos(a), cy = Math.sin(a);
        fang(THREE, head, p.bone, [inner[0] + cx * .042, inner[1] + cy * .042, inner[2] + .006], [inner[0] + cx * .01, inner[1] + cy * .01, inner[2] + .03], .006, [0, 0, .006], null, 3);
      }
      // Jaw: a long mandible with a double row of teeth, the chin's rotten skin hanging in a flap.
      hollow(THREE, jaw, p.dark, 0, -drop * .5, jf - .01, .085, drop * .62, .12);
      loft(THREE, jaw, p.skin, [[-.105, .0, -.06], [-.1, -drop * .6, jf * .45], [-.07, -drop * .95, jf * .88], [0, -drop * 1.02, jf + .03], [.07, -drop * .95, jf * .88],
        [.1, -drop * .6, jf * .45], [.105, .0, -.06]], [[.016, .035], [.017, .055], [.018, .062], [.02, .064], [.018, .062], [.017, .055], [.016, .035]],
      { sides: 8, seg: 2, up: [0, 1, 0], lump: .08, seed: 34, tint: (t, a) => Math.abs(a - .25) < .06 ? [...T.gum, .6 - Math.abs(a - .25) * 9, .6] : null });
      dentition(THREE, jaw, p, { x: 0, y: -drop + .035, z: jf + .02, width: .15, curve: .07, count: 14, length: .065, radius: .008, seed: 32, splay: .12 });
      dentition(THREE, jaw, p, { x: 0, y: -drop + .03, z: jf - .02, width: .11, curve: .05, count: 10, length: .045, radius: .006, seed: 35, rake: -.35 });
      for (const side of [-1, 1]) strand(THREE, jaw, p.tendon, [[side * .1, -drop * .55, jf * .4], [side * .115, -drop * .25, jf * .2], [side * .11, .0, -.02]], .012, .009, { sides: 4 });
      loft(THREE, jaw, p.skin, [[-.03, -drop * 1.02, jf + .02], [-.035, -drop * 1.3, jf], [-.02, -drop * 1.55, jf - .02]], [[.03, .006], [.025, .005], [0, 0]],
        { sides: 4, seg: 2, lump: .3, seed: 36, tint: () => [...T.wound, .5, .9] });
      return { front, eyeY, drips: [[0, 2.95, .32, .045, .9], [-.07, 2.9, .3, .03, .6], [.49, 1.25, .45, .1, .45]], materials: [lantern], userData: { lanternMat: lantern } };
    }
  };

  // A crawler's limb: up and out to a joint folded above the body (a knob of bone splitting the skin over it), then
  // down to a long hand standing on its fingertips.
  function crawlLimb(THREE, p, limb, name, bend, end, o) {
    const w = o.width, side = o.side, floorY = -(o.rootY + bend[1]), e = end, T = tints(THREE);
    loft(THREE, limb, p.skin, [[0, -.01, 0], [bend[0] * .5, bend[1] * .5 + .03, bend[2] * .5], bend], [[w * 1.15, w * 1.1], [w * .9, w * .85], [w * .72, w * .74]],
      { sides: 8, seg: 3, lump: .08, seed: o.seed, sculpt: [{ at: [bend[0] * .5, bend[1] * .5 + .03 + w * .8, bend[2] * .5], r: w * 1.4, d: w * .3 }] });
    const distal = joint(THREE, limb, name, ...bend);
    fang(THREE, distal, p.bone, [0, .0, 0], [-side * .012, .08, -.02], w * .45, [0, .01, 0], t => t < .3 ? [...T.wound, 1 - t * 3, 1] : null, 4);
    loft(THREE, distal, p.skin, [[0, .025, 0], [e[0] * .45, e[1] * .45 + .02, e[2] * .45], [e[0] * .85, e[1] * .85, e[2] * .85], [e[0], e[1] + .02, e[2]]],
      [[w * .78, w * .78], [w * .62, w * .6], [w * .48, w * .45], [w * .4, w * .36]], { sides: 8, seg: 2, lump: .08, seed: o.seed + 3 });
    strand(THREE, distal, p.tendon, [[side * w * .5, .0, -w * .4], [e[0] * .5 + side * w * .45, e[1] * .5, e[2] * .5 - w * .35], [e[0] + side * w * .3, e[1] + .04, e[2] - w * .25]],
      w * .16, w * .1, { sides: 3 });
    claws(THREE, distal, p, [e[0], floorY + .095, e[2] + .01], { side, size: .9, crawling: true, length: 1.3, claw: 1.3, curl: .15 });
    return distal;
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

  // ---------- gloved hands ----------
  // A finger is a chain of rounded phalanges (cached 8-sided open cylinders) with a knuckle at every joint.
  function digit(THREE, parent, mat, points, r) {
    const up = new THREE.Vector3(0, 1, 0), unit = geometry(THREE, 'gun:phalanx', () => new THREE.CylinderGeometry(1, 1, 1, 8, 1, true));
    const knuckle = geometry(THREE, 'gun:knuckle', () => new THREE.SphereGeometry(1, 8, 6));
    add(THREE, parent, knuckle, mat, points[0][0], points[0][1], points[0][2], r * 1.12, r * 1.12, r * 1.12);
    for (let i = 1; i < points.length; i++) {
      const a = new THREE.Vector3(...points[i - 1]), b = new THREE.Vector3(...points[i]), delta = b.clone().sub(a), radius = r * (1 - i * 0.06);
      const m = add(THREE, parent, unit, mat, (a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2, radius, delta.length(), radius);
      m.quaternion.setFromUnitVectors(up, delta.normalize());
      add(THREE, parent, knuckle, mat, b.x, b.y, b.z, radius * 1.02, radius * 1.02, radius * 1.02);
    }
  }

  // Sleeve from the wrist out of view along dir (weapon space), with a ribbed glove cuff.
  function forearm(THREE, parent, mats, wrist, dir, radius) {
    const d = new THREE.Vector3(...dir).normalize(), length = 0.34, up = new THREE.Vector3(0, 1, 0);
    const cuff = add(THREE, parent, geometry(THREE, 'gun:cuff', () => new THREE.CylinderGeometry(1, 1.06, 1, 12, 1, true)), mats.glove,
      wrist[0] + d.x * 0.02, wrist[1] + d.y * 0.02, wrist[2] + d.z * 0.02, radius, 0.05, radius);
    cuff.quaternion.setFromUnitVectors(up, d);
    const sleeve = add(THREE, parent, geometry(THREE, 'gun:sleeve', () => new THREE.CylinderGeometry(1, 1.22, 1, 12, 3, true)), mats.sleeve,
      wrist[0] + d.x * (0.04 + length / 2), wrist[1] + d.y * (0.04 + length / 2), wrist[2] + d.z * (0.04 + length / 2), radius * 1.18, length, radius * 1.12);
    sleeve.quaternion.setFromUnitVectors(up, d);
  }

  // Right hand closed on a grip. Grip frame: centre c, tilted about x; hw/hd are the grip's half width/depth and top the
  // height of the index finger. Palm on the outer face, three fingers wrapped round the front, the index on the trigger,
  // the thumb over the back strap, then cuff and sleeve along arm.
  function gripHand(THREE, g, mats, c, tilt, hw, hd, top, arm) {
    const cos = Math.cos(tilt), sin = Math.sin(tilt), r = 0.0098, glove = mats.glove;
    const at = (x, y, z) => [c[0] + x, c[1] + y * cos - z * sin, c[2] + y * sin + z * cos];
    const palm = at(hw + 0.012, top - 0.04, hd * 0.25);
    oval(THREE, g, glove, palm[0], palm[1], palm[2], 0.019, 0.052, hd + 0.014, tilt);
    digit(THREE, g, glove, [at(hw + r * 0.7, top, -hd * 0.2), at(hw * 0.7, top + 0.004, -(hd + r * 1.1)), at(hw * 0.05, top + 0.003, -(hd + r * 2))], r);
    for (let i = 1; i < 4; i++) {
      const y = top - 0.008 - i * 0.023, k = 1 - i * 0.045;
      digit(THREE, g, glove, [at(hw + r * 0.7, y, -hd * 0.3), at(hw * 0.45, y, -(hd + r * 0.95)), at(-hw * 0.55, y - 0.002, -(hd + r * 0.85)),
        at(-(hw + r * 0.55), y - 0.004, -hd * 0.3)], r * k);
    }
    digit(THREE, g, glove, [at(hw + 0.005, top - 0.016, hd * 0.75), at(hw * 0.2, top + 0.006, hd + 0.009), at(-(hw + 0.003), top + 0.002, hd * 0.2)], r * 1.12);
    forearm(THREE, g, mats, at(hw * 0.6, top - 0.1, hd * 0.9), arm, 0.034);
  }

  // Left hand cradling a handguard or pump from below (c: centre, hw/hh: half width/height): palm under, fingers curled
  // up the far side, thumb along the near side.
  function supportHand(THREE, g, mats, c, hw, hh, arm) {
    const r = 0.0094, glove = mats.glove, [x, y, z] = c;
    oval(THREE, g, glove, x - 0.004, y - hh - 0.013, z + 0.004, 0.036, 0.016, 0.048);
    for (let i = 0; i < 4; i++) {
      const fz = z + 0.031 - i * 0.021, k = 1 - Math.abs(i - 1.2) * 0.06;
      digit(THREE, g, glove, [[x + hw * 0.35, y - hh - 0.007, fz], [x + hw + r * 0.7, y - hh * 0.45, fz], [x + hw + r * 0.6, y + hh * 0.3, fz - 0.002],
        [x + hw * 0.55, y + hh * 0.8, fz - 0.004]], r * k);
    }
    digit(THREE, g, glove, [[x - hw * 0.55, y - hh - 0.006, z + 0.05], [x - hw - r * 0.8, y - hh * 0.3, z + 0.022], [x - hw - r * 0.5, y + hh * 0.45, z - 0.018]], r * 1.1);
    forearm(THREE, g, mats, [x - hw * 0.35, y - hh - 0.028, z + 0.075], arm, 0.032);
  }

  // Parkerized steel, bare-steel edges, black oxide, stippled polymer, walnut, brass, rubber and a woven glove.
  function gunPalette(THREE, world) {
    return {
      // Phosphate and oxide finishes are coatings: half-metallic, so the key light still models their shape.
      steel: gunMaterial(THREE, 'gun:steel', 0x6b7377, 0.5, 'gun-metal', null, world),
      edge: gunMaterial(THREE, 'gun:edge', 0xc0c6c9, 0.95, 'gun-metal', 0.5, world),
      black: gunMaterial(THREE, 'gun:black', 0x353c3f, 0.4, 'gun-metal', null, world),
      polymer: gunMaterial(THREE, 'gun:polymer', 0x3a4042, 0, 'gun-polymer', null, world),
      wood: gunMaterial(THREE, 'gun:wood', 0x7a5236, 0, 'gun-wood', null, world),
      brass: gunMaterial(THREE, 'gun:brass', 0xc29a55, 0.9, 'gun-metal', 0.6, world),
      rubber: gunMaterial(THREE, 'gun:rubber', 0x1c1f20, 0, 'gun-rubber', null, world),
      glove: gunMaterial(THREE, 'gun:glove', 0x30352f, 0, 'gun-fabric', null, world),
      od: gunMaterial(THREE, 'gun:od', 0x4f553c, 0, 'gun-polymer', null, world),
      glass: gunMaterial(THREE, 'gun:glass', 0x2a4c5c, 0.6, 'gun-metal', 0.1, world)
    };
  }

  // ---------- the guns found below B1 ----------
  // Each builder adds its parts to g and its joints (k.magazine, k.bolt), and returns its muzzle, where the carrier's
  // hands go (grips), the viewmodel hands, and pose(reload, kick, sinceShot): reload is the reload progress 0..1 or -1,
  // kick the recoil impulse, sinceShot seconds since the last round. An optional view {hip, aim} nudges the viewmodel.
  const GUN_MODELS = {
    // KV-9: a compact 9 mm with a long straight magazine, a cocking tube over the barrel and a sliding stock.
    smg(THREE, g, k) {
      const { steel, edge, black, polymer, rubber, magazine, bolt } = k;
      bevel(THREE, g, steel, 0, 0.012, -0.05, 0.056, 0.064, 0.33, 0.008);
      bevel(THREE, g, black, 0, 0.046, -0.04, 0.03, 0.012, 0.25, 0.003);
      for (let i = 0; i < 9; i++) box(THREE, g, black, 0, 0.053, 0.06 - i * 0.024, 0.032, 0.006, 0.009);
      bevel(THREE, g, polymer, 0, -0.03, 0.045, 0.05, 0.042, 0.15, 0.008);
      bevel(THREE, g, polymer, 0, -0.108, 0.08, 0.042, 0.13, 0.06, 0.01, -0.27);
      ring(THREE, g, black, 0, -0.064, 0.025, 0.031, 0.005, 0, Math.PI / 2).scale.set(1, 0.72, 1.05);
      box(THREE, g, steel, 0, -0.06, 0.03, 0.007, 0.032, 0.01, -0.3);
      bevel(THREE, g, polymer, 0, -0.05, -0.06, 0.042, 0.045, 0.062, 0.006);
      bevel(THREE, g, polymer, 0, -0.008, -0.175, 0.064, 0.07, 0.13, 0.012);
      for (const side of [-1, 1]) for (let i = 0; i < 4; i++) box(THREE, g, black, side * 0.0322, -0.005, -0.13 - i * 0.026, 0.002, 0.032, 0.012);
      cyl(THREE, g, steel, 0, 0.012, -0.28, 0.0105, 0.0105, 0.13, Math.PI / 2, 0, 0, 12);
      cyl(THREE, g, steel, 0, 0.046, -0.2, 0.0095, 0.0095, 0.15, Math.PI / 2, 0, 0, 10);
      cyl(THREE, g, black, 0, 0.012, -0.36, 0.0145, 0.0145, 0.052, Math.PI / 2, 0, 0, 12);
      for (let i = 0; i < 3; i++) ring(THREE, g, black, 0, 0.012, -0.343 - i * 0.014, 0.0152, 0.0022);
      // Rear drum sight and a hooded front post.
      cyl(THREE, g, black, 0, 0.069, 0.075, 0.012, 0.012, 0.024, 0, 0, Math.PI / 2, 12);
      box(THREE, g, k.sight, 0, 0.081, 0.075, 0.004, 0.004, 0.002);
      bevel(THREE, g, black, 0, 0.06, -0.265, 0.014, 0.016, 0.022, 0.003);
      ring(THREE, g, black, 0, 0.072, -0.265, 0.011, 0.0028);
      box(THREE, g, k.sight, 0, 0.071, -0.256, 0.003, 0.003, 0.002);
      // Retractable stock: twin rods and a rubber butt.
      for (const side of [-1, 1]) cyl(THREE, g, edge, side * 0.021, 0.012, 0.2, 0.005, 0.005, 0.2, Math.PI / 2, 0, 0, 8);
      bevel(THREE, g, black, 0, 0.0, 0.3, 0.054, 0.05, 0.022, 0.005);
      bevel(THREE, g, rubber, 0, -0.012, 0.312, 0.05, 0.095, 0.016, 0.006);
      magazine.position.set(0, -0.07, -0.06);
      bevel(THREE, magazine, steel, 0, -0.05, -0.003, 0.03, 0.12, 0.05, 0.005, -0.06);
      bevel(THREE, magazine, steel, 0, -0.155, -0.017, 0.03, 0.1, 0.05, 0.005, -0.18);
      bevel(THREE, magazine, black, 0, -0.208, -0.027, 0.035, 0.014, 0.058, 0.003, -0.18);
      for (const side of [-1, 1]) for (let i = 0; i < 2; i++) box(THREE, magazine, black, side * 0.0152, -0.07 - i * 0.07, -0.01 - i * 0.008, 0.002, 0.06, 0.008, -0.1);
      bolt.position.set(0, 0.046, -0.235);
      box(THREE, bolt, black, -0.022, 0, 0, 0.032, 0.008, 0.012);
      oval(THREE, bolt, black, -0.04, 0, 0, 0.007, 0.007, 0.009);
      return {
        muzzle: new THREE.Vector3(0, 0.012, -0.387),
        grips: { right: [0, -0.1, 0.078], left: [0, -0.045, -0.18] },
        hands(hands) {
          gripHand(THREE, g, hands, [0, -0.108, 0.08], -0.27, 0.021, 0.03, 0.05, [0.36, -0.5, 0.79]);
          supportHand(THREE, g, hands, [0, -0.008, -0.185], 0.032, 0.035, [-0.42, -0.46, 0.78]);
        }
      };
    },
    // .44: a six-shot double-action revolver. The cylinder turns a chamber per shot and swings out on its crane.
    magnum(THREE, g, k) {
      const { steel, edge, black, wood, brass, magazine, bolt } = k;
      // Frame: top strap, the window round the cylinder, recoil shield and grip frame.
      bevel(THREE, g, steel, 0, 0.044, -0.004, 0.026, 0.012, 0.082, 0.004);
      bevel(THREE, g, steel, 0, -0.019, -0.004, 0.03, 0.018, 0.074, 0.005);
      bevel(THREE, g, steel, 0, 0.012, 0.036, 0.033, 0.075, 0.016, 0.005);
      bevel(THREE, g, steel, 0, 0.014, -0.045, 0.028, 0.05, 0.012, 0.004);
      bevel(THREE, g, steel, 0, -0.01, 0.06, 0.03, 0.05, 0.05, 0.007, -0.2);
      // Six-inch barrel with a ventilated top rib and a full underlug round the ejector rod.
      cyl(THREE, g, steel, 0, 0.031, -0.152, 0.0108, 0.0108, 0.21, Math.PI / 2, 0, 0, 14);
      bevel(THREE, g, steel, 0, 0.044, -0.152, 0.012, 0.009, 0.21, 0.003);
      for (let i = 0; i < 6; i++) box(THREE, g, black, 0, 0.0445, -0.07 - i * 0.033, 0.0125, 0.004, 0.012);
      bevel(THREE, g, steel, 0, 0.013, -0.149, 0.019, 0.028, 0.204, 0.006);
      bevel(THREE, g, black, 0, 0.054, -0.244, 0.005, 0.014, 0.022, 0.002);
      box(THREE, g, k.sight, 0, 0.06, -0.237, 0.0055, 0.004, 0.002);
      bevel(THREE, g, black, 0, 0.053, 0.03, 0.018, 0.009, 0.014, 0.002);
      for (const side of [-1, 1]) box(THREE, g, k.sight, side * 0.0055, 0.055, 0.038, 0.004, 0.004, 0.002);
      // Walnut grip and a slim backstrap; trigger guard and trigger.
      bevel(THREE, g, wood, 0, -0.082, 0.07, 0.038, 0.12, 0.058, 0.014, -0.33);
      oval(THREE, g, wood, 0, -0.136, 0.091, 0.019, 0.017, 0.03, -0.33);
      bevel(THREE, g, edge, 0, -0.06, 0.103, 0.014, 0.09, 0.006, 0.002, -0.33);
      ring(THREE, g, black, 0, -0.035, 0.0, 0.021, 0.0035, 0, Math.PI / 2).scale.set(1, 0.85, 1);
      box(THREE, g, edge, 0, -0.03, 0.006, 0.006, 0.026, 0.008, -0.25);
      for (const z of [-0.022, 0.016]) cyl(THREE, g, edge, -0.0155, -0.014, z, 0.004, 0.004, 0.002, 0, 0, Math.PI / 2, 8);
      // The crane: the cylinder, its six rounds and the ejector rod swing out to the left about a pivot under it.
      magazine.position.set(-0.011, -0.008, -0.004);
      const cylinder = joint(THREE, magazine, 'cylinder', 0.011, 0.02, 0);
      cyl(THREE, cylinder, steel, 0, 0, 0, 0.0225, 0.0225, 0.066, Math.PI / 2, 0, 0, 18);
      for (let i = 0; i < 6; i++) {
        const a = (i + 0.5) * TAU / 6;
        box(THREE, cylinder, black, Math.cos(a) * 0.0213, Math.sin(a) * 0.0213, -0.006, 0.006, 0.004, 0.044, 0, 0, a + Math.PI / 2);
      }
      const rounds = joint(THREE, cylinder, 'rounds', 0, 0, 0);
      for (let i = 0; i < 6; i++) {
        const a = i * TAU / 6;
        cyl(THREE, rounds, brass, Math.cos(a) * 0.0135, Math.sin(a) * 0.0135, 0.0345, 0.0066, 0.0066, 0.004, Math.PI / 2, 0, 0, 10);
      }
      cyl(THREE, magazine, steel, 0.011, 0.02, -0.06, 0.0042, 0.0042, 0.05, Math.PI / 2, 0, 0, 8);
      box(THREE, magazine, steel, 0.004, 0.008, -0.036, 0.012, 0.016, 0.008);
      // The hammer (bolt): it falls with each shot and is cocked again by the trigger.
      bolt.position.set(0, 0.03, 0.045);
      box(THREE, bolt, steel, 0, 0.004, 0.006, 0.008, 0.03, 0.012, -0.5);
      bevel(THREE, bolt, steel, 0, 0.018, 0.018, 0.012, 0.007, 0.018, 0.002, -0.2);
      let previous = -1, chamber = 0;
      return {
        muzzle: new THREE.Vector3(0, 0.031, -0.262), bore: 0.0115, cylinder, rounds,
        // Held higher and further out than the pistol, so the cylinder and hammer show at the hip.
        view: { hip: [0, 0.03, -0.02], aim: [0, 0, 0] },
        grips: { right: [0, -0.085, 0.07], left: [-0.035, -0.105, 0.05] },
        hands(hands) { gripHand(THREE, g, hands, [0, -0.082, 0.07], -0.33, 0.019, 0.029, 0.05, [0.34, -0.52, 0.78]); },
        pose(reload, kick, since) {
          if (since < previous) chamber++;
          previous = since;
          const swing = reload < 0 ? 0 : smoothstep(0.05, 0.18, reload) * (1 - smoothstep(0.8, 0.92, reload));
          magazine.rotation.z = swing * 1.3;
          // The ejector throws the empties out, then a speedloader drops in six fresh rounds.
          rounds.position.z = reload < 0 ? 0 : smoothstep(0.22, 0.3, reload) * (1 - smoothstep(0.5, 0.56, reload)) * 0.035;
          rounds.visible = reload < 0 || reload < 0.31 || reload > 0.5;
          cylinder.rotation.z = (chamber + smoothstep(0, 0.12, since) - 1) * TAU / 6;
          magazine.visible = true;
          bolt.position.z = bolt.userData.restZ || 0;
          bolt.rotation.x = since < 0.25 ? -0.65 * (1 - smoothstep(0, 0.05, since)) + 0.15 * kick : 0;
        }
      };
    },
    // M24: a bolt-action marksman rifle with a heavy barrel, a long scope and an olive synthetic stock.
    marksman(THREE, g, k) {
      const { steel, edge, black, rubber, brass, od, glass, magazine, bolt } = k;
      // Stock: butt, comb, wrist and grip, the action bed and the forend.
      bevel(THREE, g, od, 0, -0.038, 0.305, 0.05, 0.124, 0.15, 0.014);
      bevel(THREE, g, od, 0, 0.002, 0.225, 0.044, 0.05, 0.19, 0.012, 0.06);
      bevel(THREE, g, od, 0, -0.045, 0.14, 0.042, 0.07, 0.1, 0.012, -0.42);
      bevel(THREE, g, od, 0, -0.088, 0.112, 0.04, 0.085, 0.052, 0.012, -0.45);
      bevel(THREE, g, od, 0, -0.012, -0.035, 0.054, 0.05, 0.27, 0.012);
      bevel(THREE, g, od, 0, -0.014, -0.34, 0.056, 0.046, 0.36, 0.014);
      bevel(THREE, g, od, 0, -0.03, -0.18, 0.05, 0.03, 0.06, 0.008);
      bevel(THREE, g, rubber, 0, -0.038, 0.385, 0.052, 0.13, 0.018, 0.006);
      ring(THREE, g, black, 0, -0.045, 0.06, 0.022, 0.0035, 0, Math.PI / 2).scale.set(1, 0.8, 1.1);
      box(THREE, g, steel, 0, -0.04, 0.064, 0.006, 0.026, 0.008, -0.2);
      for (const z of [0.29, -0.43]) ring(THREE, g, edge, 0, -0.072 + (z < 0 ? 0.036 : 0) - (z > 0 ? 0.03 : 0), z, 0.008, 0.002, 0, Math.PI / 2);
      // Receiver: the front ring and the rear bridge either side of the bolt's travel, open on the right.
      cyl(THREE, g, steel, 0, 0.028, -0.1, 0.0175, 0.0175, 0.09, Math.PI / 2, 0, 0, 14);
      cyl(THREE, g, steel, 0, 0.028, 0.065, 0.0175, 0.0175, 0.04, Math.PI / 2, 0, 0, 14);
      bevel(THREE, g, steel, -0.008, 0.02, -0.018, 0.02, 0.026, 0.13, 0.004);
      bevel(THREE, g, black, 0, 0.012, -0.018, 0.034, 0.012, 0.13, 0.003);
      // Heavy free-floated barrel.
      cyl(THREE, g, steel, 0, 0.028, -0.505, 0.0135, 0.0102, 0.72, Math.PI / 2, 0, 0, 14);
      // Scope: rings, tube, turrets, objective and ocular bells, and its glass.
      for (const z of [0.045, -0.105]) {
        bevel(THREE, g, black, 0, 0.056, z, 0.022, 0.026, 0.018, 0.003);
        ring(THREE, g, black, 0, 0.09, z, 0.0185, 0.0042);
      }
      cyl(THREE, g, black, 0, 0.09, -0.035, 0.0155, 0.0155, 0.3, Math.PI / 2, 0, 0, 16);
      cyl(THREE, g, black, 0, 0.09, -0.21, 0.0155, 0.026, 0.05, Math.PI / 2, 0, 0, 16);
      cyl(THREE, g, black, 0, 0.09, -0.262, 0.0265, 0.0265, 0.055, Math.PI / 2, 0, 0, 18);
      ring(THREE, g, edge, 0, 0.09, -0.29, 0.0255, 0.0018);
      cyl(THREE, g, black, 0, 0.09, 0.13, 0.021, 0.0155, 0.04, Math.PI / 2, 0, 0, 16);
      cyl(THREE, g, black, 0, 0.09, 0.172, 0.0215, 0.0215, 0.045, Math.PI / 2, 0, 0, 16);
      cyl(THREE, g, black, 0, 0.114, -0.035, 0.012, 0.012, 0.03, 0, 0, 0, 14);
      cyl(THREE, g, edge, 0, 0.13, -0.035, 0.0105, 0.0105, 0.004, 0, 0, 0, 14);
      cyl(THREE, g, black, 0.024, 0.09, -0.035, 0.011, 0.011, 0.026, 0, 0, Math.PI / 2, 14);
      const lens = geometry(THREE, 'gun:lens', () => new THREE.CircleGeometry(1, 20));
      add(THREE, g, lens, glass, 0, 0.09, -0.2896, 0.023, 0.023, 1, 0, Math.PI).castShadow = false;
      add(THREE, g, lens, glass, 0, 0.09, 0.1946, 0.019, 0.019, 1).castShadow = false;
      // Internal magazine: a hinged floorplate, with the rounds showing through the open action.
      magazine.position.set(0, 0, -0.02);
      bevel(THREE, magazine, black, 0, -0.04, 0.0, 0.036, 0.008, 0.09, 0.002);
      const rounds = joint(THREE, magazine, 'rounds', 0, 0, 0);
      for (const [x, y] of [[0.004, 0.02], [-0.006, 0.012]]) {
        cyl(THREE, rounds, brass, x, y, 0.002, 0.0055, 0.0055, 0.056, Math.PI / 2, 0, 0, 10);
        cyl(THREE, rounds, brass, x, y, -0.033, 0.0055, 0.003, 0.016, Math.PI / 2, 0, 0, 10);
      }
      // Bolt: body, shroud, and the handle that lifts and runs back to chamber each round.
      bolt.position.set(0, 0.028, 0);
      cyl(THREE, bolt, edge, 0, 0, -0.012, 0.0158, 0.0158, 0.112, Math.PI / 2, 0, 0, 14);
      cyl(THREE, bolt, steel, 0, 0, 0.1, 0.0145, 0.012, 0.03, Math.PI / 2, 0, 0, 12);
      link(THREE, bolt, edge, [0.014, 0, 0.038], [0.046, -0.022, 0.05], 0.0042);
      oval(THREE, bolt, black, 0.049, -0.026, 0.052, 0.0105, 0.0105, 0.0105);
      return {
        muzzle: new THREE.Vector3(0, 0.028, -0.868), bore: 0.0095, rounds,
        // Aimed with the eye over the scope's ocular, not pressed into it.
        view: { hip: [0, 0, 0], aim: [0, -0.035, -0.06] },
        grips: { right: [0, -0.082, 0.112], left: [0, -0.05, -0.33] },
        hands(hands) {
          gripHand(THREE, g, hands, [0, -0.085, 0.112], -0.45, 0.02, 0.026, 0.045, [0.37, -0.42, 0.82]);
          supportHand(THREE, g, hands, [0, -0.014, -0.34], 0.028, 0.023, [-0.42, -0.46, 0.78]);
        },
        pose(reload, kick, since) {
          let lift = 0, back = 0;
          // The bolt is worked about .4 s after the shot, in time with its foley.
          if (reload >= 0) { lift = smoothstep(0.02, 0.07, reload) * (1 - smoothstep(0.9, 0.96, reload)); back = smoothstep(0.07, 0.13, reload) * (1 - smoothstep(0.82, 0.88, reload)); }
          else if (since < 1) { lift = smoothstep(0.36, 0.44, since) * (1 - smoothstep(0.7, 0.78, since)); back = smoothstep(0.44, 0.52, since) * (1 - smoothstep(0.6, 0.68, since)); }
          bolt.rotation.z = lift * 1.2;
          bolt.position.z = back * 0.085 + kick * 0.004;
          magazine.visible = true;
          rounds.visible = !(reload >= 0 && reload > 0.1 && reload < 0.22);
        }
      };
    },
    // M249: belt fed from a 100-round box, with a feed cover that lifts to lay a new belt, a carry handle and a bipod.
    lmg(THREE, g, k) {
      const { steel, edge, black, polymer, rubber, brass, od, magazine, bolt } = k;
      bevel(THREE, g, black, 0, 0.0, 0.0, 0.07, 0.092, 0.36, 0.008);
      for (const side of [-1, 1]) {
        bevel(THREE, g, steel, side * 0.036, -0.004, -0.02, 0.004, 0.05, 0.28, 0.002);
        for (let i = 0; i < 3; i++) cyl(THREE, g, edge, side * 0.0365, 0.025, 0.12 - i * 0.12, 0.004, 0.004, 0.003, 0, 0, Math.PI / 2, 6);
      }
      bevel(THREE, g, black, 0, 0.05, -0.165, 0.06, 0.02, 0.04, 0.004);
      // Pistol grip, trigger guard, buffer and stock.
      bevel(THREE, g, polymer, 0, -0.1, 0.092, 0.045, 0.14, 0.064, 0.01, -0.27);
      ring(THREE, g, black, 0, -0.062, 0.04, 0.036, 0.006, 0, Math.PI / 2).scale.set(1, 0.75, 1.05);
      box(THREE, g, steel, 0, -0.057, 0.047, 0.008, 0.034, 0.012, -0.3);
      bevel(THREE, g, polymer, 0, -0.02, 0.29, 0.054, 0.098, 0.22, 0.014, -0.04);
      bevel(THREE, g, polymer, 0, 0.004, 0.205, 0.044, 0.05, 0.06, 0.01);
      bevel(THREE, g, rubber, 0, -0.026, 0.405, 0.058, 0.112, 0.018, 0.006);
      // Barrel, heat shield, gas tube and block, handguard, front sight, carry handle and flash hider.
      cyl(THREE, g, steel, 0, 0.012, -0.47, 0.0142, 0.0142, 0.56, Math.PI / 2, 0, 0, 14);
      bevel(THREE, g, black, 0, 0.032, -0.3, 0.032, 0.008, 0.2, 0.003);
      for (let i = 0; i < 6; i++) box(THREE, g, steel, 0, 0.0365, -0.215 - i * 0.034, 0.024, 0.002, 0.014);
      cyl(THREE, g, steel, 0, -0.022, -0.39, 0.0075, 0.0075, 0.36, Math.PI / 2, 0, 0, 8);
      bevel(THREE, g, black, 0, -0.008, -0.575, 0.03, 0.052, 0.04, 0.005);
      bevel(THREE, g, black, 0, 0.042, -0.585, 0.008, 0.05, 0.016, 0.002);
      bevel(THREE, g, polymer, 0, -0.024, -0.275, 0.074, 0.058, 0.17, 0.012);
      for (const side of [-1, 1]) for (let i = 0; i < 5; i++) box(THREE, g, black, side * 0.0372, -0.024, -0.21 - i * 0.03, 0.002, 0.03, 0.012);
      for (const z of [-0.23, -0.33]) link(THREE, g, black, [0, 0.035, z], [0, 0.086, z + 0.01], 0.006);
      bevel(THREE, g, black, 0, 0.09, -0.275, 0.02, 0.014, 0.13, 0.005);
      cyl(THREE, g, black, 0, 0.012, -0.76, 0.0165, 0.0165, 0.062, Math.PI / 2, 0, 0, 12);
      for (let i = 0; i < 4; i++) box(THREE, g, black, Math.cos(i * TAU / 4) * 0.0168, 0.012 + Math.sin(i * TAU / 4) * 0.0168, -0.765, 0.004, 0.004, 0.04, 0, 0, i * TAU / 4);
      // Bipod, folded back under the barrel.
      for (const side of [-1, 1]) {
        link(THREE, g, steel, [side * 0.012, -0.03, -0.6], [side * 0.016, -0.04, -0.385], 0.0055);
        oval(THREE, g, rubber, side * 0.016, -0.041, -0.378, 0.008, 0.008, 0.012);
      }
      bevel(THREE, g, steel, 0, -0.03, -0.605, 0.036, 0.014, 0.02, 0.003);
      // Feed cover over the tray, hinged at the front.
      const cover = joint(THREE, g, 'cover', 0, 0.046, -0.13);
      bevel(THREE, cover, black, 0, 0.009, 0.095, 0.066, 0.018, 0.19, 0.005);
      bevel(THREE, cover, black, 0, 0.026, 0.16, 0.02, 0.018, 0.026, 0.004);
      box(THREE, cover, k.sight, 0, 0.037, 0.162, 0.006, 0.003, 0.002);
      // The ammunition box hangs under the left side; its belt climbs into the feed tray, each round pointing forward
      // in its link.
      magazine.position.set(-0.03, -0.046, -0.04);
      bevel(THREE, magazine, od, -0.004, -0.068, 0, 0.068, 0.124, 0.13, 0.012);
      bevel(THREE, magazine, black, -0.004, -0.004, 0, 0.072, 0.012, 0.134, 0.004);
      for (let i = 0; i < 5; i++) {
        const t = i / 4, x = -0.024 + t * 0.012, y = 0.009 + t * 0.068 - Math.sin(t * Math.PI) * 0.01;
        cyl(THREE, magazine, brass, x, y, -0.006, 0.0052, 0.0052, 0.05, Math.PI / 2, 0, 0, 8);
        box(THREE, magazine, black, x, y, 0.004, 0.0125, 0.0125, 0.022, 0, 0, 0.3 * (1 - t));
      }
      bolt.position.set(0.04, 0.0, -0.1);
      bevel(THREE, bolt, black, 0.006, 0, 0, 0.016, 0.014, 0.03, 0.003);
      oval(THREE, bolt, black, 0.017, 0, 0.004, 0.008, 0.009, 0.01);
      return {
        muzzle: new THREE.Vector3(0, 0.012, -0.792), bore: 0.0145, cover,
        grips: { right: [0, -0.1, 0.095], left: [0, -0.06, -0.28] },
        hands(hands) {
          gripHand(THREE, g, hands, [0, -0.1, 0.092], -0.27, 0.0225, 0.032, 0.05, [0.36, -0.5, 0.79]);
          supportHand(THREE, g, hands, [0, -0.024, -0.285], 0.037, 0.029, [-0.42, -0.46, 0.78]);
        },
        pose(reload, kick) {
          const open = reload < 0 ? 0 : smoothstep(0.04, 0.13, reload) * (1 - smoothstep(0.7, 0.78, reload));
          cover.rotation.x = -open * 1.1;
          magazine.visible = reload < 0 || reload < 0.28 || reload > 0.52;
          bolt.position.z = -0.1 + kick * 0.03;
        }
      };
    }
  };
  // RULES.WEAPONS order: a carrier's weapon index picks from this list.
  const WEAPON_KINDS = ['rifle', 'pistol', 'shotgun', ...Object.keys(GUN_MODELS)];

  // options.world: a third-person copy (scene-lit finishes, no first-person hands) for the co-op partner.
  function makeWeapon(THREE, requestedKind, options) {
    const kind = WEAPON_KINDS.includes(requestedKind) ? requestedKind : 'rifle';
    const world = !!(options && options.world);
    const g = new THREE.Group(); g.name = kind;
    const palette = gunPalette(THREE, world), { steel, edge, black, polymer, wood, brass, rubber, glove } = palette;
    const sight = basic(THREE, 'gun:sight', 0x97d3b1);
    const magazine = joint(THREE, g, 'magazine', 0, 0, 0);
    const bolt = joint(THREE, g, 'bolt', 0, 0, 0);
    const extra = GUN_MODELS[kind] ? GUN_MODELS[kind](THREE, g, Object.assign({ sight, magazine, bolt }, palette)) : null;
    let muzzle = extra && extra.muzzle;

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
    } else if (kind === 'shotgun') {
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
      const shell = gunMaterial(THREE, 'gun:shell', 0x8a3b2b, 0, 'gun-polymer', 0.7, world);
      for (let i = 0; i < 4; i++) {
        cyl(THREE, g, shell, -0.053, -0.021, 0.029 - i * 0.038, 0.011, 0.011, 0.064);
        cyl(THREE, g, brass, -0.053, 0.014, 0.029 - i * 0.038, 0.012, 0.012, 0.01);
      }
      muzzle = new THREE.Vector3(0, 0.023, -0.855);
    }
    // A real dark bore and milled crown catch the light at the business end.
    const crown = extra && extra.bore ? [extra.bore * 0.9, 0.0025, extra.bore * 0.7] : null;
    ring(THREE, g, edge, muzzle.x, muzzle.y, muzzle.z + 0.012, crown ? crown[0] : kind === 'shotgun' ? 0.019 : 0.013, crown ? crown[1] : 0.0035);
    const boreSize = crown ? crown[2] : kind === 'shotgun' ? 0.016 : 0.011;
    const bore = add(THREE, g, geometry(THREE, 'bore', () => new THREE.CircleGeometry(1, 16)), rubber,
      muzzle.x, muzzle.y, muzzle.z + 0.011, boreSize, boreSize, 1, 0, Math.PI);
    bore.castShadow = false;
    const hands = { glove, rubber, sleeve: gunMaterial(THREE, 'flashlight:sleeve', 0x22292d, 0, 'gun-fabric', null, world) };
    // Where a carrier's hands hold the weapon (weapon space): firing grip, and the support hand (null: one-handed).
    const grips = extra ? extra.grips : {
      rifle: { right: [0, -0.1, 0.07], left: [0, -0.045, -0.25] },
      pistol: { right: [0, -0.095, 0.045], left: [-0.035, -0.115, 0.03] },
      shotgun: { right: [0, -0.07, 0.125], left: [0, -0.07, -0.31] }
    }[kind];
    if (world) {
      // No viewmodel hands: the survivor's own arms reach these grips.
    } else if (kind === 'rifle') {
      gripHand(THREE, g, hands, [0, -0.118, 0.066], -0.27, 0.0225, 0.033, 0.05, [0.36, -0.5, 0.79]);
      supportHand(THREE, g, hands, [0, 0.003, -0.31], 0.037, 0.0425, [-0.42, -0.46, 0.78]);
    } else if (kind === 'pistol') {
      gripHand(THREE, g, hands, [0, -0.102, 0.042], -0.29, 0.026, 0.0435, 0.062, [0.34, -0.52, 0.78]);
    } else if (extra) {
      extra.hands(hands);
    } else {
      gripHand(THREE, g, hands, [0, -0.074, 0.13], -0.95, 0.034, 0.03, 0.03, [0.38, -0.36, 0.85]);
      supportHand(THREE, g, hands, [0, -0.026, -0.385], 0.0425, 0.045, [-0.42, -0.46, 0.78]);
    }
    if (!extra) for (const z of [-0.1, 0.062]) {
      cyl(THREE, g, edge, -0.036, 0.006, z, 0.0045, 0.0045, 0.003, 0, 0, Math.PI / 2, 6);
    }
    batch(THREE, g, { boxUV: 10 });
    const muzzleFlash = new THREE.Mesh(geometry(THREE, 'flashPlane', () => new THREE.PlaneGeometry(0.27, 0.27)), flashMaterial(THREE));
    muzzleFlash.position.copy(muzzle); muzzleFlash.visible = false; muzzleFlash.userData.dynamic = true; g.add(muzzleFlash);
    bolt.userData.restZ = bolt.position.z;
    g.userData = { kind, world, magazine, muzzleFlash, muzzlePosition: muzzle, bolt, run: 0,
      grips: { right: new THREE.Vector3(...grips.right), left: grips.left && new THREE.Vector3(...grips.left) } };
    // The new guns animate their own parts (cylinder, bolt handle, feed cover); a world copy only needs its joints.
    if (extra) for (const key of ['cylinder', 'rounds', 'cover']) if (extra[key]) g.userData[key] = extra[key];
    if (extra && extra.pose && !world) g.userData.pose = extra.pose;
    if (extra && extra.view && !world) g.userData.view = extra.view;
    return g;
  }

  function makeFlashlight(THREE) {
    const g = new THREE.Group(); g.name = 'field flashlight';
    const { steel, edge, black, rubber, glove } = gunPalette(THREE);
    const sleeve = gunMaterial(THREE, 'flashlight:sleeve', 0x22292d, 0, 'gun-fabric');
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
    batch(THREE, g, { boxUV: 10 });
    const lens = add(THREE, g, geometry(THREE, 'flashlight:lens', () => new THREE.CircleGeometry(0.038, 24)), lensMaterial,
      0, 0, -0.184, 1, 1, 1, 0, Math.PI);
    lens.castShadow = false; lens.receiveShadow = false;
    g.userData = { lensMaterial, lens, muzzlePosition: new THREE.Vector3(0, 0, -0.184) };
    return g;
  }

  // ---------- co-op survivor ----------
  // The partner as others see them: a field evacuation contractor in a softshell, plate carrier with pouches, radio
  // and hydration pack, coyote cargo trousers with knee pads, boots, gloves and a bump helmet with a headset. Blue ID
  // strobes on the helmet, strap and pack keep a partner from ever reading as a creature in the dark.
  // Feet, knees, hands and elbows are solved every frame (two-bone IK), so the body walks on the floor and both hands
  // stay on whichever weapon is carried. Space: +y up, -z forward (the camera's convention), metres.
  function makeSurvivor(THREE) {
    const root = new THREE.Group(); root.name = 'survivor';
    const mat = {
      skin: standard(THREE, 'survivor:skin', 0xb7856a, 0.55, 0, 'skin'),
      hair: standard(THREE, 'survivor:hair', 0x2b221c, 0.85, 0, 'fabric'),
      jacket: standard(THREE, 'survivor:jacket', 0x2e3946, 0.88, 0, 'fabric'),
      vest: standard(THREE, 'survivor:vest', 0x4d5541, 0.92, 0, 'fabric'),
      webbing: standard(THREE, 'survivor:webbing', 0x3b4134, 0.95, 0, 'fabric'),
      pants: standard(THREE, 'survivor:pants', 0x6d5f4a, 0.9, 0, 'fabric'),
      boot: standard(THREE, 'survivor:boot', 0x3b2c21, 0.62, 0, 'fabric'),
      sole: standard(THREE, 'survivor:sole', 0x18191a, 0.85, 0),
      glove: standard(THREE, 'survivor:glove', 0x27292a, 0.8, 0, 'fabric'),
      helmet: standard(THREE, 'survivor:helmet', 0x3b4146, 0.48, 0.05),
      hardware: standard(THREE, 'survivor:hardware', 0x1d2023, 0.45, 0.4),
      patch: standard(THREE, 'survivor:patch', 0x3466d6, 0.55, 0),
      eye: basic(THREE, 'survivor:eye', 0x0c0a09),
      id: basic(THREE, 'survivor:id', 0x6fb0ff)
    };
    const capsule = (parent, m, r, len, x, y, z, sx, sz) => add(THREE, parent,
      geometry(THREE, 'survivor:capsule:' + r + ':' + len, () => new THREE.CapsuleGeometry(r, len, 4, 12)), m, x, y, z, sx || 1, 1, sz || 1);
    const HIP = 0.94, ANKLE = 0.085, THIGH = 0.43, SHIN = 0.43, UPPER = 0.31, FORE = 0.31;

    // Pelvis, belt and dump pouch.
    const hips = joint(THREE, root, 'hips', 0, HIP, 0);
    oval(THREE, hips, mat.pants, 0, -0.03, 0, 0.165, 0.12, 0.115);
    cyl(THREE, hips, mat.webbing, 0, 0.055, 0, 0.169, 0.169, 0.05, 0, 0, 0, 16).scale.z = 0.72;
    box(THREE, hips, mat.hardware, 0, 0.055, -0.123, 0.05, 0.036, 0.012);
    bevel(THREE, hips, mat.webbing, 0, 0, 0.125, 0.14, 0.1, 0.06, 0.012);
    bevel(THREE, hips, mat.webbing, 0.15, 0.0, -0.02, 0.05, 0.11, 0.09, 0.01);

    // Torso: softshell under a plate carrier.
    const spine = joint(THREE, hips, 'spine', 0, 0.07, 0);
    capsule(spine, mat.jacket, 0.165, 0.2, 0, 0.27, 0, 1.08, 0.68);
    for (const side of [-1, 1]) {
      oval(THREE, spine, mat.jacket, side * 0.178, 0.43, 0, 0.075, 0.066, 0.076);
      bevel(THREE, spine, mat.vest, side * 0.17, 0.2, -0.005, 0.045, 0.17, 0.2, 0.01);
      bevel(THREE, spine, mat.webbing, side * 0.105, 0.47, 0, 0.062, 0.034, 0.25, 0.008);
    }
    cyl(THREE, spine, mat.jacket, 0, 0.535, 0, 0.075, 0.09, 0.06, 0, 0, 0, 14);
    cyl(THREE, spine, mat.skin, 0, 0.585, 0.005, 0.05, 0.056, 0.1, 0, 0, 0, 12);
    bevel(THREE, spine, mat.vest, 0, 0.3, -0.112, 0.3, 0.33, 0.05, 0.012);
    bevel(THREE, spine, mat.vest, 0, 0.31, 0.105, 0.3, 0.34, 0.05, 0.012);
    for (const x of [-0.085, 0, 0.085]) {
      bevel(THREE, spine, mat.webbing, x, 0.2, -0.148, 0.072, 0.12, 0.04, 0.008);
      bevel(THREE, spine, mat.vest, x, 0.256, -0.152, 0.076, 0.032, 0.046, 0.006);
    }
    bevel(THREE, spine, mat.webbing, 0, 0.372, -0.142, 0.2, 0.07, 0.028, 0.006);
    box(THREE, spine, mat.patch, 0.055, 0.378, -0.157, 0.062, 0.04, 0.004);
    bevel(THREE, spine, mat.hardware, -0.195, 0.29, 0.035, 0.05, 0.13, 0.055, 0.008);
    cyl(THREE, spine, mat.hardware, -0.2, 0.46, 0.04, 0.004, 0.006, 0.22, 0, 0, 0, 6);
    bevel(THREE, spine, mat.vest, 0, 0.29, 0.165, 0.24, 0.34, 0.07, 0.02);
    box(THREE, spine, mat.id, 0.105, 0.492, 0.06, 0.022, 0.012, 0.03);
    box(THREE, spine, mat.id, 0, 0.43, 0.202, 0.03, 0.02, 0.008);

    // Head: face, hair, a bump helmet with rails, an NVG shroud and a headset with a boom mic.
    const head = joint(THREE, spine, 'head', 0, 0.6, 0);
    oval(THREE, head, mat.skin, 0, 0.1, 0, 0.088, 0.112, 0.098);
    oval(THREE, head, mat.skin, 0, 0.036, -0.022, 0.072, 0.058, 0.078);
    box(THREE, head, mat.skin, 0, 0.086, -0.1, 0.024, 0.042, 0.03, 0.25);
    for (const side of [-1, 1]) {
      oval(THREE, head, mat.skin, side * 0.09, 0.095, 0.008, 0.013, 0.03, 0.022);
      oval(THREE, head, mat.eye, side * 0.034, 0.112, -0.087, 0.012, 0.007, 0.006);
      box(THREE, head, mat.hair, side * 0.034, 0.127, -0.091, 0.032, 0.008, 0.012, 0, 0, side * -0.08);
      bevel(THREE, head, mat.hardware, side * 0.108, 0.137, 0.005, 0.012, 0.022, 0.1, 0.004);
      cyl(THREE, head, mat.webbing, side * 0.099, 0.088, 0.01, 0.037, 0.037, 0.032, 0, 0, Math.PI / 2, 14);
    }
    box(THREE, head, mat.eye, 0, 0.046, -0.096, 0.03, 0.004, 0.006);
    oval(THREE, head, mat.hair, 0, 0.115, 0.022, 0.091, 0.075, 0.092);
    add(THREE, head, geometry(THREE, 'survivor:helmet', () => new THREE.SphereGeometry(1, 18, 10, 0, TAU, 0, Math.PI * 0.56)),
      mat.helmet, 0, 0.13, 0.008, 0.114, 0.11, 0.124);
    bevel(THREE, head, mat.hardware, 0, 0.202, -0.113, 0.045, 0.032, 0.022, 0.005);
    link(THREE, head, mat.hardware, [-0.104, 0.07, -0.01], [-0.045, 0.04, -0.098], 0.004);
    box(THREE, head, mat.id, 0, 0.21, 0.104, 0.022, 0.012, 0.012);

    // Shoulder torch (the partner's light), riding with the aim so it points where they look.
    const aim = joint(THREE, spine, 'aim', 0, 0.42, 0);
    const torch = joint(THREE, aim, 'torch', -0.15, 0.06, -0.12);
    cyl(THREE, torch, mat.hardware, 0, 0, 0, 0.022, 0.022, 0.1, Math.PI / 2, 0, 0, 10);
    const mount = joint(THREE, aim, 'mount', 0, 0, 0);
    const weapons = WEAPON_KINDS.map(kind => {
      const w = makeWeapon(THREE, kind, { world: true }); w.visible = kind === 'rifle'; mount.add(w);
      const flash = w.userData.muzzleFlash, cross = flash.clone(); cross.rotation.set(0, Math.PI / 2, 0); flash.add(cross);
      return w;
    });

    // Limbs: placed per frame in root space.
    const limb = (m, r, length) => {
      const mesh = capsule(root, m, r, Math.max(0.01, length - r)); mesh.userData.dynamic = true; return mesh;
    };
    const legs = [-1, 1].map(side => {
      const foot = joint(THREE, root, 'foot', side * 0.11, ANKLE, 0);
      cyl(THREE, foot, mat.boot, 0, 0.03, 0, 0.055, 0.06, 0.1, 0, 0, 0, 12);
      bevel(THREE, foot, mat.boot, 0, -0.025, -0.05, 0.1, 0.075, 0.25, 0.02);
      bevel(THREE, foot, mat.sole, 0, -0.07, -0.05, 0.106, 0.024, 0.27, 0.008);
      const pad = oval(THREE, root, mat.hardware, 0, 0, 0, 0.052, 0.062, 0.035); pad.userData.dynamic = true;
      return { side, foot, pad, thigh: limb(mat.pants, 0.07, THIGH), shin: limb(mat.pants, 0.058, SHIN),
        hip: new THREE.Vector3(), knee: new THREE.Vector3(), ankle: new THREE.Vector3(), target: new THREE.Vector3() };
    });
    const arms = [-1, 1].map(side => {
      const hand = joint(THREE, root, 'hand', 0, 0, 0);
      oval(THREE, hand, mat.glove, 0, 0, 0, 0.042, 0.05, 0.058);
      oval(THREE, hand, mat.glove, side * -0.03, 0.02, -0.02, 0.016, 0.03, 0.018, 0.4);
      cyl(THREE, hand, mat.glove, 0, -0.01, 0.05, 0.04, 0.036, 0.04, Math.PI / 2, 0, 0, 10);
      return { side, hand, upper: limb(mat.jacket, 0.052, UPPER), fore: limb(mat.jacket, 0.045, FORE),
        shoulder: new THREE.Vector3(), elbow: new THREE.Vector3(), wrist: new THREE.Vector3(), target: new THREE.Vector3() };
    });
    for (const group of [hips, spine, head, torch, ...legs.map(l => l.foot), ...arms.map(a => a.hand)]) batch(THREE, group);

    const UP = new THREE.Vector3(0, 1, 0), FORWARD = new THREE.Vector3(0, 0, -1);
    const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3(), inv = new THREE.Matrix4();
    const q1 = new THREE.Quaternion(), q2 = new THREE.Quaternion();
    const poles = { knee: [new THREE.Vector3(-0.15, 0, -1), new THREE.Vector3(0.15, 0, -1)],
      elbow: [new THREE.Vector3(-0.8, -1, 0.15), new THREE.Vector3(0.6, -1, 0.45)] };
    // Weapon placement in aim space, at rest and aimed down the sights: [x, y, z, adsX, adsY, adsZ, torso blade (rad)].
    const MOUNT = { rifle: [0.1, -0.04, -0.31, 0.06, 0, -0.3, 0.35], pistol: [0.03, -0.07, -0.47, 0.01, -0.025, -0.5, 0.08], shotgun: [0.1, -0.045, -0.3, 0.06, -0.005, -0.29, 0.35],
      smg: [0.09, -0.04, -0.36, 0.05, 0, -0.36, 0.3], magnum: [0.03, -0.07, -0.47, 0.01, -0.03, -0.5, 0.08],
      marksman: [0.1, -0.05, -0.26, 0.06, -0.035, -0.25, 0.35], lmg: [0.1, -0.07, -0.3, 0.06, -0.035, -0.3, 0.38] };
    const st = { phase: 0, walk: 0, run: 0, crouch: 0, aim: 0, reload: 0, kick: 0, flash: 0, flinch: 0, flinchX: 0, t: 0, weapon: 0 };

    // Two-bone IK from a toward t (lengths l1, l2), bending toward pole; writes the joint and the (reachable) end.
    function solve(a, t, l1, l2, pole, mid, end) {
      const d = v1.subVectors(t, a); let len = d.length();
      if (len < 1e-6) { d.set(0, -1, 0); len = 1e-6; } else d.divideScalar(len);
      const reach = clamp(len, Math.abs(l1 - l2) + 1e-3, l1 + l2 - 1e-3);
      end.copy(a).addScaledVector(d, reach);
      const along = (l1 * l1 - l2 * l2 + reach * reach) / (2 * reach), h = Math.sqrt(Math.max(0, l1 * l1 - along * along));
      const bend = v2.copy(pole).addScaledVector(d, -pole.dot(d));
      if (bend.lengthSq() < 1e-8) bend.set(0, 0, -1).addScaledVector(d, -d.z);
      mid.copy(a).addScaledVector(d, along).addScaledVector(bend.normalize(), h);
    }
    function place(mesh, a, b) {
      mesh.position.addVectors(a, b).multiplyScalar(0.5);
      mesh.quaternion.setFromUnitVectors(UP, v3.subVectors(b, a).normalize());
    }
    const toRoot = (object, local, out) => out.copy(local).applyMatrix4(object.matrixWorld).applyMatrix4(inv);

    function setWeapon(index) {
      const i = clamp(Math.floor(index) || 0, 0, weapons.length - 1);
      if (i === st.weapon) return;
      weapons[st.weapon].visible = false; weapons[st.weapon].userData.muzzleFlash.visible = false;
      st.weapon = i; weapons[i].visible = true;
    }
    function fire() {
      st.kick = 1; st.flash = 0.055;
      const f = weapons[st.weapon].userData.muzzleFlash;
      f.visible = true; f.rotation.z = Math.random() * TAU; f.scale.setScalar(0.8 + Math.random() * 0.5);
    }
    function flinch(dirX) { st.flinch = 1; st.flinchX = clamp(dirX || 0, -1, 1); }

    // input: {vx, vz} world velocity (m/s), yaw (root rotation.y), pitch (look, + up), crouch, run, aim, reload.
    function animate(input, dt) {
      const k = (rate) => 1 - Math.exp(-dt * rate), yaw = input.yaw || 0;
      const lx = (input.vx || 0) * Math.cos(yaw) - (input.vz || 0) * Math.sin(yaw);
      const lz = (input.vx || 0) * Math.sin(yaw) + (input.vz || 0) * Math.cos(yaw);
      const speed = Math.hypot(lx, lz);
      st.t += dt;
      st.walk += (smoothstep(0.08, 0.6, speed) - st.walk) * k(10);
      st.run += ((input.run && speed > 1.5 ? 1 : 0) - st.run) * k(6);
      st.crouch += ((input.crouch ? 1 : 0) - st.crouch) * k(10);
      st.aim += ((input.aim ? 1 : 0) - st.aim) * k(12);
      st.reload += ((input.reload ? 1 : 0) - st.reload) * k(8);
      st.kick *= Math.exp(-dt * 16); st.flinch *= Math.exp(-dt * 7);
      if (st.flash > 0) { st.flash -= dt; if (st.flash <= 0) weapons[st.weapon].userData.muzzleFlash.visible = false; }
      const stride = 0.3 + 0.12 * Math.min(speed, 6), w = st.walk;
      st.phase = (st.phase + dt * speed / stride * Math.PI) % (TAU * 64);
      const pitch = clamp(input.pitch || 0, -1.3, 1.3), low = st.run * (1 - st.aim) * (1 - st.reload), crouch = st.crouch;

      const m = MOUNT[weapons[st.weapon].name] || MOUNT.rifle, a = st.aim, blade = m[6] * (1 - low * 0.6);
      hips.position.y = HIP - crouch * 0.3 - 0.03 * w * Math.abs(Math.sin(st.phase));
      hips.rotation.y = -Math.sin(st.phase) * 0.05 * w - blade * 0.35;
      spine.rotation.set(-0.2 * st.run * w - 0.28 * crouch + pitch * 0.3 - st.flinch * 0.18 - st.kick * 0.03,
        Math.sin(st.phase) * 0.07 * w * (1 - st.aim) - blade * 0.65 + st.flinchX * st.flinch * 0.2, st.flinchX * st.flinch * -0.12);
      head.rotation.set(pitch * 0.45 + crouch * 0.22 + st.run * w * 0.12 + st.aim * 0.06 + st.reload * -0.35, blade + st.aim * -0.05, st.aim * 0.1);
      aim.rotation.set(pitch - spine.rotation.x - low * 0.75 - st.reload * 0.25, blade + low * 0.4 + st.reload * 0.15, 0);
      mount.position.set(m[0] + (m[3] - m[0]) * a, m[1] + (m[4] - m[1]) * a, m[2] + (m[5] - m[2]) * a + 0.05 * st.kick);
      mount.rotation.set(0.09 * st.kick - st.reload * 0.2, 0, st.reload * 0.55);

      root.updateMatrixWorld(true); inv.copy(root.matrixWorld).invert();
      // Legs: each foot cycles half a stride either side of its stance along the motion, lifted while it swings.
      const dirX = speed > 0.05 ? lx / speed : 0, dirZ = speed > 0.05 ? lz / speed : 0;
      for (const leg of legs) {
        const phase = st.phase + (leg.side > 0 ? Math.PI : 0), along = Math.sin(phase) * stride * 0.5 * w;
        const lift = Math.max(0, Math.cos(phase)) * (0.07 + 0.06 * st.run) * w;
        leg.target.set(leg.side * 0.11 * (1 + 0.3 * crouch) + dirX * along, ANKLE + lift, (leg.side < 0 ? -0.12 : 0.15) * crouch + dirZ * along);
        toRoot(hips, v3.set(leg.side * 0.095, -0.05, 0), leg.hip);
        solve(leg.hip, leg.target, THIGH, SHIN, poles.knee[leg.side < 0 ? 0 : 1], leg.knee, leg.ankle);
        place(leg.thigh, leg.hip, leg.knee); place(leg.shin, leg.knee, leg.ankle);
        leg.foot.position.copy(leg.ankle); leg.foot.rotation.set(lift * 2.2, 0, 0);
        leg.pad.position.copy(leg.knee).addScaledVector(poles.knee[leg.side < 0 ? 0 : 1], 0.045);
        leg.pad.quaternion.copy(leg.shin.quaternion);
      }
      // Arms: the firing hand on the grip, the support hand on the fore-end (or the magazine while reloading).
      const gun = weapons[st.weapon], grips = gun.userData.grips;
      gun.getWorldQuaternion(q1); root.getWorldQuaternion(q2); q1.premultiply(q2.invert());
      for (const arm of arms) {
        if (arm.side > 0) toRoot(gun, grips.right, arm.target);
        else {
          toRoot(gun, grips.left || grips.right, arm.target);
          if (st.reload > 0.01) {
            toRoot(gun.userData.magazine, v3.set(0, -0.08 + Math.sin(st.t * 7) * 0.025, 0), v1);
            arm.target.lerp(v1, st.reload);
          }
        }
        toRoot(spine, v3.set(arm.side * 0.18, 0.43, 0.01), arm.shoulder);
        solve(arm.shoulder, arm.target, UPPER, FORE, poles.elbow[arm.side < 0 ? 0 : 1], arm.elbow, arm.wrist);
        place(arm.upper, arm.shoulder, arm.elbow); place(arm.fore, arm.elbow, arm.wrist);
        arm.hand.position.copy(arm.wrist); arm.hand.quaternion.copy(q1);
      }
    }

    root.userData = { kind: 'survivor', hips, spine, head, aim, mount, torch, weapons, legs, arms, state: st,
      animate, setWeapon, fire, flinch, height: 1.8 };
    animate({}, 0);
    return root;
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

    function bed(x, z, covered, bare) {
      const r = joint(THREE, g, bare ? 'mortuary gurney' : 'medical bed', x, 0, z);
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
      if (bare) {
        // A morgue gurney: no drip, just a toe tag hanging off the sheet.
        link(THREE, r, p.dark, [0.12, 0.84, 0.93], [0.13, 0.66, 1.0], 0.003);
        box(THREE, r, p.cloth, 0.13, 0.62, 1.0, 0.075, 0.11, 0.004);
        mark(x, z, 1.04, 2.12, 1.2);
        return;
      }
      cyl(THREE, r, p.steel, 0.68, 1.02, -0.70, 0.016, 0.016, 1.99);
      link(THREE, r, p.steel, [0.51, 1.99, -0.70], [0.86, 1.99, -0.70], 0.012);
      bevel(THREE, r, p.cloth, 0.59, 1.80, -0.70, 0.13, 0.24, 0.055, 0.011);
      link(THREE, r, p.dark, [0.59, 1.65, -0.70], [0.35, 0.82, -0.59], 0.004);
      // The IV stand must not turn the entire mattress into a two-metre wall.
            mark(x, z, 1.04, 2.12, covered ? 1.2 : 1.01);
            mark(x + 0.69, z - 0.70, 0.38, 0.10, 2.02);
    }

    // A bank of cold-store doors against the west wall, facing into the room; one drawer has slid out.
    function drawers(x, z) {
      const r = joint(THREE, g, 'mortuary drawers', x, 0, z); r.rotation.y = Math.PI / 2;
      bevel(THREE, r, p.steel, 0, 1.0, 0, 1.46, 2.0, 0.62, 0.02);
      for (let row = 0; row < 3; row++) for (let col = 0; col < 2; col++) {
        const x0 = -0.355 + col * 0.71, y0 = 0.42 + row * 0.62, open = row === 0 && col === 1, front = open ? 0.64 : 0.322;
        bevel(THREE, r, p.paint, x0, y0, front, 0.6, 0.5, 0.025, 0.01);
        box(THREE, r, p.dark, x0, y0 + 0.13, front + 0.03, 0.22, 0.03, 0.035);
        box(THREE, r, p.cloth, x0 - 0.19, y0 - 0.15, front + 0.016, 0.11, 0.07, 0.004);
      }
      box(THREE, r, p.steel, 0.355, 0.25, 0.48, 0.56, 0.04, 0.32);
      oval(THREE, r, p.cloth, 0.355, 0.31, 0.48, 0.24, 0.07, 0.17);
      story('mortuary drawers', r);
      mark(x + 0.17, z, 0.96, 1.46, 2.0);
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
      } else if (type === 'morgue') {
        drawers(-width / 2 + 0.34, -depth * 0.22);
        if (depth >= 11) drawers(-width / 2 + 0.34, depth * 0.17);
        bed(right - 0.1, Math.max(back + 0.7, -depth * 0.25), true, true);
        if (depth >= 8) bed(right - 0.1, depth * 0.24, true, true);
        if (width >= 11) bed(-width * 0.2, Math.max(back + 0.7, -depth * 0.25), true, true);
        placard(width * 0.22, 2.35, -depth / 2 + 0.04, 'MORTUARY', 'COLD STORAGE / TAG EVERY BODY', '#9fb4b8');
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

  // The decal atlas as one alpha-tested material; polygon offset keeps it on top of walls and floors at any distance.
  function decalMaterial(THREE) {
    const cache = store(THREE).materials, key = 'ward:decals';
    if (!cache.has(key)) {
      const s = surface('ward-decals'), maps = { albedo: texture(THREE, s.albedo, true), normal: texture(THREE, s.normal, false), roughness: texture(THREE, s.roughness, false) };
      for (const t of Object.values(maps)) t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      store(THREE).maps.set('decals', maps);
      const m = new THREE.MeshStandardMaterial({ map: maps.albedo, normalMap: maps.normal, roughnessMap: maps.roughness, roughness: 1, metalness: 0,
        alphaTest: 0.5, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
      m.userData.hollowShared = true; m.userData.hollowSurface = 'decals'; cache.set(key, m);
    }
    return cache.get(key);
  }

  // A unit quad showing one atlas tile (optionally mirrored), half a texel inside the tile so mips never pull in a neighbour.
  function decalGeometry(THREE, tile, mirror) {
    return geometry(THREE, 'ward:decal:' + tile + (mirror ? ':m' : ''), () => {
      const g = new THREE.PlaneGeometry(1, 1), uv = g.attributes.uv, col = tile & 3, row = tile >> 2, e = 0.004;
      for (let i = 0; i < uv.count; i++) {
        const u = mirror ? 1 - uv.getX(i) : uv.getX(i), v = uv.getY(i);
        uv.setXY(i, (col + e + u * (1 - 2 * e)) / 4, 1 - (row + 1 - (e + v * (1 - 2 * e))) / 2);
      }
      return g;
    });
  }

  // Story dressing on its own seeded stream, so the fixtures, signs and wear keep their layout: blood at the room
  // doorways, sparse spatter, claw marks and footprints, debris along the wall bases, sagging and loose cables, and
  // hazard paint at the exit gate. Everything is flush with a wall, flat on the floor or above 2.65 m.
  function dressWard(THREE, g, { grid, s, height, rooms, seed, cells, corridor, exit, ceilingY, overhead }) {
    const random = seeded((Math.imul(seed | 0, 2654435761) ^ 0x5bd1e995) >>> 0), decal = decalMaterial(THREE);
    const cable = standard(THREE, 'ward:cable', 0x15181a, 0.5, 0), plaster = standard(THREE, 'ward:plaster', 0x8b8676, 0.96, 0, 'concrete');
    const grime = standard(THREE, 'ward:grime', 0x30362c, 1, 0, 'concrete'), k = Math.min(1, s / 3), low = detail === 0;
    const flake = geometry(THREE, 'ward:flake', () => new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2));
    const [tubeSides, tubeSteps] = low ? [3, 8] : [4, 12];
    const walls = (x, z) => [[1, 0], [0, 1], [-1, 0], [0, -1]].filter(([dx, dz]) => grid[z + dz]?.[x + dx] === 1);
    const wallPoint = (c, dx, dz, along) => [c.wx + dx * s / 2 - dz * along, c.wz + dz * s / 2 + dx * along];
    const clampAlong = (a, w) => Math.max(-s / 2 + w / 2 + 0.02, Math.min(s / 2 - w / 2 - 0.02, a));
    // (x, z) lies on the wall face; the quad faces back into the corridor.
    const onWall = (tile, x, y, z, dx, dz, w, h, mirror) => {
      y = Math.min(y, height - 0.06 - h / 2);
      if (y - h / 2 < 0.02) return;
      add(THREE, g, decalGeometry(THREE, tile, mirror == null ? random() < 0.5 : mirror), decal, x - dx * 0.006, y, z - dz * 0.006, w, h, 1, 0, Math.atan2(-dx, -dz), 0);
    };
    // Image right follows (dirX, dirZ) on the floor.
    const onFloor = (tile, x, z, len, wid, dirX, dirZ, mirror) => add(THREE, g, decalGeometry(THREE, tile, mirror == null ? random() < 0.5 : mirror),
      decal, x, 0.004, z, len, wid, 1, -Math.PI / 2, 0, Math.atan2(-dirZ, dirX));
    const cellAt = new Map(cells.map(c => [c.x + ',' + c.z, c]));

    // Approach corridors run south from each room door: hands and a smear on their side walls, a trail out of the room.
    for (const r of rooms || []) {
      const d = r && r.door, c = d && cellAt.get(d.x + ',' + (d.z + 1));
      if (!c) continue;
      walls(c.x, c.z).filter(([dx]) => dx !== 0).forEach(([dx, dz], i) => {
        if (i && random() < 0.35) return;
        const w = 0.62 * k, [x, z] = wallPoint(c, dx, dz, clampAlong(-dx * s * (0.16 + random() * 0.12), w));
        onWall(i ? DECAL.smear : DECAL.hands, x, i ? 0.95 + random() * 0.3 : 1.2 + random() * 0.3, z, dx, dz, w, w);
      });
      if (random() < 0.7) onFloor(DECAL.trail, c.wx + (random() - 0.5) * 0.3 * k, c.wz - s / 2 + 0.96 * k, 1.9 * k, 0.75 * k, 0, 1);
      else onFloor(DECAL.steps, c.wx + (random() - 0.5) * 0.3 * k, c.wz - s / 2 + 0.8 * k, 1.5 * k, 0.5 * k, 0, 1);
    }

    for (const c of cells) {
      const sides = walls(c.x, c.z), roll = random();
      if (roll < 0.1 && sides.length) {
        const [dx, dz] = sides[random() * sides.length | 0], tile = roll < 0.04 ? DECAL.splatter : roll < 0.075 ? DECAL.claws : DECAL.smear;
        const w = (tile === DECAL.claws ? 0.72 : 0.6) * k, [x, z] = wallPoint(c, dx, dz, clampAlong((random() - 0.5) * s, w));
        onWall(tile, x, tile === DECAL.claws ? 1.3 + random() * 0.35 : 0.95 + random() * 0.6, z, dx, dz, w, w);
      } else if (roll < 0.14) {
        onFloor(DECAL.pool, c.wx + (random() - 0.5) * s * 0.35, c.wz + (random() - 0.5) * s * 0.35, 0.95 * k, 0.8 * k, Math.cos(roll * 99), Math.sin(roll * 99));
      } else if (roll < 0.175) {
        const alongX = corridor(c.x + 1, c.z) || corridor(c.x - 1, c.z), sign = random() < 0.5 ? -1 : 1;
        onFloor(DECAL.steps, c.wx, c.wz, 1.5 * k, 0.5 * k, alongX ? sign : 0, alongX ? 0 : sign);
      }
      // Plaster crumbs against the skirting, with flakes and grit spreading into the corridor.
      for (const [dx, dz] of sides) {
        if (random() > 0.14) continue;
        const a0 = (random() - 0.5) * (s - 1.2 * k), wallX = c.wx + dx * s / 2, wallZ = c.wz + dz * s / 2;
        for (let i = 3 + (random() * 5 | 0); i > 0; i--) {
          const size = (0.016 + random() * 0.022) * k, [x, z] = wallPoint(c, dx, dz, clampAlong(a0 + (random() - 0.5) * 0.8 * k, 0.1));
          const mat = random() < 0.72 ? plaster : grime, rx = random() * 0.6, ry = random() * TAU, rz = random() * 0.6;
          if (low && i > 3) continue;
          const m = box(THREE, g, mat, x - dx * 0.055, size, z - dz * 0.055, size * 1.3, size * 0.7, size, rx, ry, rz);
          m.updateMatrixWorld(true);
          const b = new THREE.Box3().setFromObject(m);
          m.position.y -= b.min.y;
          const far = dx > 0 ? wallX - b.min.x : dx < 0 ? b.max.x - wallX : dz > 0 ? wallZ - b.min.z : b.max.z - wallZ;
          if (far > 0.075) { m.position.x += dx * (far - 0.075); m.position.z += dz * (far - 0.075); }
        }
        for (let i = 0; i < 5; i++) {
          const w = (0.025 + random() * 0.06) * k, off = 0.08 + random() * random() * 0.55 * k;
          const [x, z] = wallPoint(c, dx, dz, clampAlong(a0 + (random() - 0.5) * k, 0.1));
          add(THREE, g, flake, plaster, x - dx * off, 0.003, z - dz * off, w, 1, w * (0.5 + random() * 0.6), 0, random() * TAU, 0).castShadow = false;
        }
      }
      if (!overhead) continue;
      // Cables tied off at the wall pipes sag between them; a few loose ends drop out of the ceiling.
      for (const [dx, dz] of sides) {
        if (random() > 0.09) continue;
        const y0 = ceilingY - 0.035, drop = Math.min(0.12 + random() * 0.2, y0 - 2.7), inset = 0.2 + random() * 0.08;
        if (drop < 0.04) continue;
        const a = -s * (0.3 + random() * 0.15), b = s * (0.3 + random() * 0.15), pts = [];
        for (let i = 0; i <= 10; i++) {
          const t = i / 10, sag = drop * 4 * t * (1 - t), out = inset + 0.12 * sag, [x, z] = wallPoint(c, dx, dz, a + (b - a) * t);
          pts.push(new THREE.Vector3(x - dx * out, y0 - sag, z - dz * out));
        }
        add(THREE, g, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), tubeSteps, 0.011, tubeSides, false), cable, 0, 0, 0);
      }
      const len = Math.min(0.3 + random() * 0.22, height - 0.04 - 2.72);
      if (random() < 0.045 && len > 0.1) {
        const x0 = c.wx + (random() - 0.5) * s * 0.5, z0 = c.wz + (random() - 0.5) * s * 0.5, a = random() * TAU, pts = [];
        for (let i = 0; i <= 6; i++) {
          const t = i / 6, curl = t * t * 0.07;
          pts.push(new THREE.Vector3(x0 + Math.cos(a) * curl, height - 0.04 - len * t, z0 + Math.sin(a) * curl));
        }
        add(THREE, g, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), tubeSteps >> 1, 0.009, tubeSides, false), cable, 0, 0, 0);
      }
    }

    // Worn hazard paint across the floor in front of the exit gate and up both jambs.
    const inner = exit && cellAt.get((exit[0] - 1) + ',' + exit[1]);
    if (inner) {
      const gateX = exit[0] * s, wid = Math.min(0.56, s * 0.19), n = Math.max(1, Math.round(s / 0.75)), x = gateX - 0.06 - wid / 2;
      for (let i = 0; i < n; i++) onFloor(DECAL.hazard, x, inner.z * s + (i + 0.5) * s / n, s / n, wid, 0, 1, false);
      for (const [dx, dz] of walls(inner.x, inner.z)) {
        if (dx) continue;
        const z = inner.wz + dz * s / 2, h = Math.min(0.8, (height - 0.2) / 3);
        for (let i = 0; i < 3; i++) onWall(DECAL.hazard, gateX - 0.06 - 0.21 * k, h * (i + 0.5) + 0.03, z, 0, dz, 0.42 * k, h, false);
      }
    }
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
    dressWard(THREE, g, { grid, s, height, rooms, seed, cells, corridor, exit: queue[0], ceilingY, overhead });
    batch(THREE, g);
    // No shadow-map draws: these thin details receive the caller's pooled light.
    g.traverse(o => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = true; } });
    return g;
  }

  // ---------- above ground: rooms, grounds and the horizon of S1 (garden) and S2 (graveyard) ----------
  function outdoorPalette(THREE) {
    const cache = store(THREE).materials;
    if (!cache.has('out:glass')) {
      const glass = new THREE.MeshStandardMaterial({ color: 0x223236, roughness: 0.08, metalness: 0.2, transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide });
      glass.userData.hollowShared = true; cache.set('out:glass', glass);
    }
    const live = standard(THREE, 'out:lamp', 0xffd9a8, 0.35, 0);
    live.emissive.setHex(0xffa851); live.emissiveIntensity = 1.6;
    return {
      wood: standard(THREE, 'out:wood', 0x5a4531, 0.86, 0, 'wood'), dark: standard(THREE, 'out:darkwood', 0x2b2118, 0.9, 0, 'wood'),
      plank: standard(THREE, 'out:plank', 0x5f5240, 0.92, 0, 'wood'), stone: standard(THREE, 'out:stone', 0x6f6c62, 0.93, 0, 'concrete'),
      pale: standard(THREE, 'out:pale', 0x96938a, 0.9, 0, 'concrete'), mossy: standard(THREE, 'out:mossy', 0x4d5240, 0.96, 0, 'concrete'),
      slate: standard(THREE, 'out:slate', 0x2a2d31, 0.72, 0.05, 'concrete'), brick: standard(THREE, 'out:brick', 0x5e3427, 0.92, 0, 'wall'),
      iron: standard(THREE, 'out:iron', 0x232627, 0.55, 0.75, 'metal'), rust: standard(THREE, 'out:rust', 0x5a3824, 0.85, 0.4, 'metal'),
      leaf: standard(THREE, 'out:leaf', 0x1f3417, 0.78, 0, 'fabric'), leaf2: standard(THREE, 'out:leaf2', 0x2c4119, 0.8, 0, 'fabric'),
      dry: standard(THREE, 'out:dry', 0x574b2f, 0.92, 0, 'fabric'), soil: standard(THREE, 'out:soil', 0x271e16, 1, 0, 'concrete'),
      clay: standard(THREE, 'out:clay', 0x7d4229, 0.88, 0, 'concrete'), cloth: standard(THREE, 'out:cloth', 0x837e6b, 0.97, 0, 'fabric'),
      bone: standard(THREE, 'out:bone', 0xaea48b, 0.8, 0, 'concrete'), rose: standard(THREE, 'out:rose', 0x5c0a12, 0.55, 0),
      white: standard(THREE, 'out:white', 0xc9c4b5, 0.7, 0), bark: standard(THREE, 'out:bark', 0x2e261f, 0.95, 0, 'wood'),
      pit: basic(THREE, 'out:pit', 0x050403), glass: cache.get('out:glass'), live
    };
  }

  // A triangular prism (unit base and height, unit depth along z) for gables and grave mounds.
  function prism(THREE, parent, mat, x, y, z, w, h, d, ry) {
    const geom = geometry(THREE, 'out:prism', () => {
      const s = new THREE.Shape(); s.moveTo(-0.5, 0); s.lineTo(0.5, 0); s.lineTo(0, 1); s.closePath();
      const g = new THREE.ExtrudeGeometry(s, { depth: 1, bevelEnabled: false }); g.translate(0, 0, -0.5); return g;
    });
    return add(THREE, parent, geom, mat, x, y, z, w, h, d, 0, ry || 0, 0);
  }

  // oval() and link() for the floors above ground, which carry thousands of leaves, stems and bones: a coarse sphere
  // (lo: coarser still, for the horizon and small clutter) and an open stem of a few sides. Both are unit shapes,
  // scaled, so random sizes share one cached geometry.
  function blob(THREE, parent, mat, x, y, z, w, h, d, rx, ry, rz, lo) {
    const geom = geometry(THREE, lo ? 'out:blob-lo' : 'out:blob', () => new THREE.SphereGeometry(1, lo ? 6 : 8, lo ? 4 : 6));
    return add(THREE, parent, geom, mat, x, y, z, w, h, d, rx, ry, rz);
  }
  function twig(THREE, parent, mat, from, to, r1, r2, sides) {
    const n = sides || 5, taper = Math.round((r2 == null ? 1 : r2 / r1) * 20) / 20;
    const geom = geometry(THREE, 'out:twig:' + n + ':' + taper, () => new THREE.CylinderGeometry(taper, 1, 1, n, 1, true));
    const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2], len = Math.hypot(dx, dy, dz) || 0.001;
    const m = add(THREE, parent, geom, mat, (from[0] + to[0]) / 2, (from[1] + to[1]) / 2, (from[2] + to[2]) / 2, r1, len, r1);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(dx / len, dy / len, dz / len));
    return m;
  }

  // Shared small furniture of the outdoor rooms and grounds. Each builder adds meshes to `g` (local metres) and returns
  // its collider box {x, z, w, d, h} (or null for low clutter that never blocks).
  function outdoorKit(THREE, g, p, random) {
    const k = {};
    const C = (x, z, w, d, h) => ({ x, z, w, d, h });
    k.lantern = (x, y, z, hanging) => {
      if (hanging) twig(THREE, g, p.iron, [x, y + 0.2, z], [x, y + 0.75, z], 0.012);
      box(THREE, g, p.iron, x, y + 0.18, z, 0.2, 0.03, 0.2); box(THREE, g, p.iron, x, y - 0.17, z, 0.18, 0.03, 0.18);
      box(THREE, g, p.live, x, y, z, 0.13, 0.3, 0.13).castShadow = false;
      for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) box(THREE, g, p.iron, x + dx * 0.08, y, z + dz * 0.08, 0.018, 0.34, 0.018);
      prism(THREE, g, p.iron, x, y + 0.195, z, 0.22, 0.12, 0.22);
    };
    k.post = (x, z) => {
      cyl(THREE, g, p.iron, x, 1.3, z, 0.045, 0.06, 2.6, 0, 0, 0, 8);
      cyl(THREE, g, p.iron, x, 0.12, z, 0.12, 0.14, 0.24, 0, 0, 0, 8);
      k.lantern(x, 2.78, z);
      return C(x, z, 0.3, 0.3, 2.6);
    };
    k.bench = (x, z, ry, mat) => {
      const r = joint(THREE, g, 'bench', x, 0, z); r.rotation.y = ry || 0; const m = mat || p.wood;
      box(THREE, r, m, 0, 0.45, 0, 1.6, 0.06, 0.42); box(THREE, r, m, 0, 0.82, -0.2, 1.6, 0.3, 0.05, -0.15);
      for (const sx of [-0.68, 0.68]) { box(THREE, r, p.iron, sx, 0.22, 0, 0.06, 0.45, 0.4); box(THREE, r, p.iron, sx, 0.62, -0.19, 0.05, 0.42, 0.05); }
      const turned = Math.abs(Math.sin(ry || 0)) > 0.5;
      return C(x, z, turned ? 0.6 : 1.7, turned ? 1.7 : 0.6, 0.9);
    };
    k.table = (x, z, w, d, mat) => {
      bevel(THREE, g, mat || p.wood, x, 0.78, z, w, 0.06, d, 0.01);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(THREE, g, mat || p.wood, x + sx * (w / 2 - 0.08), 0.38, z + sz * (d / 2 - 0.08), 0.07, 0.76, 0.07);
      return C(x, z, w, d, 0.82);
    };
    k.pot = (x, y, z, r, dead) => {
      cyl(THREE, g, p.clay, x, y + r * 0.6, z, r, r * 0.72, r * 1.2, 0, 0, 0, 9);
      cyl(THREE, g, p.soil, x, y + r * 1.18, z, r * 0.9, r * 0.9, 0.02, 0, 0, 0, 9);
      const plant = dead ? p.dry : p.leaf2;
      for (let i = 0; i < 3; i++) blob(THREE, g, plant, x + (random() - 0.5) * r, y + r * 1.4 + random() * r * 0.8, z + (random() - 0.5) * r, r * 0.55, r * 0.7, r * 0.55);
    };
    k.shelf = (x, z, ry, len, fill) => {
      const r = joint(THREE, g, 'shelf', x, 0, z); r.rotation.y = ry || 0;
      for (const sx of [-len / 2 + 0.04, len / 2 - 0.04]) box(THREE, r, p.dark, sx, 0.95, 0, 0.05, 1.9, 0.4);
      for (let row = 0; row < 4; row++) {
        box(THREE, r, p.plank, 0, 0.3 + row * 0.48, 0, len, 0.035, 0.42);
        for (let j = 0; j < Math.floor(len / 0.35); j++) if (random() < 0.7) fill(r, -len / 2 + 0.22 + j * 0.35, 0.32 + row * 0.48);
      }
      const turned = Math.abs(Math.sin(ry || 0)) > 0.5;
      return C(x, z, turned ? 0.5 : len, turned ? len : 0.5, 1.95);
    };
    k.crate = (x, z, s, ry) => { bevel(THREE, g, p.plank, x, s / 2, z, s, s, s, 0.02, 0, ry || 0); box(THREE, g, p.dark, x, s / 2, z, s * 1.01, 0.05, s * 1.01, 0, ry || 0); return C(x, z, s * 1.2, s * 1.2, s); };
    k.barrel = (x, z) => { cyl(THREE, g, p.wood, x, 0.45, z, 0.3, 0.3, 0.9, 0, 0, 0, 12); for (const y of [0.15, 0.75]) cyl(THREE, g, p.iron, x, y, z, 0.31, 0.31, 0.04, 0, 0, 0, 12); return C(x, z, 0.65, 0.65, 0.9); };
    k.sack = (x, z) => { blob(THREE, g, p.cloth, x, 0.25, z, 0.3, 0.3, 0.24, 0, random() * TAU); return null; };
    k.tools = (x, z, ry) => {
      const r = joint(THREE, g, 'tools', x, 0, z); r.rotation.y = ry || 0;
      for (let i = 0; i < 3; i++) {
        const sx = -0.4 + i * 0.4, lean = 0.18 + random() * 0.08;
        twig(THREE, r, p.wood, [sx, 0.05, 0.2], [sx + lean * 0.3, 1.5, -0.1], 0.02);
        if (i === 1) box(THREE, r, p.rust, sx, 0.2, 0.22, 0.24, 0.3, 0.03); else box(THREE, r, p.rust, sx + 0.05, 1.5, -0.12, 0.34, 0.04, 0.06);
      }
      return null;
    };
    k.bed = (x, z, ry) => {
      const r = joint(THREE, g, 'cot', x, 0, z); r.rotation.y = ry || 0;
      box(THREE, r, p.dark, 0, 0.32, 0, 0.9, 0.12, 1.95); bevel(THREE, r, p.cloth, 0, 0.44, 0, 0.82, 0.14, 1.85, 0.03);
      drape(THREE, r, p.dry, -0.2, 0.45, 0.25, 0.9, 0.5, 0.02, Math.PI / 2, -0.1);
      for (const sx of [-0.4, 0.4]) for (const sz of [-0.9, 0.9]) box(THREE, r, p.dark, sx, 0.15, sz, 0.06, 0.3, 0.06);
      const turned = Math.abs(Math.sin(ry || 0)) > 0.5;
      return C(x, z, turned ? 2 : 0.95, turned ? 0.95 : 2, 0.55);
    };
    k.stove = (x, z) => { bevel(THREE, g, p.iron, x, 0.45, z, 0.7, 0.9, 0.6, 0.02); cyl(THREE, g, p.iron, x, 2.0, z, 0.07, 0.07, 2.2, 0, 0, 0, 8); return C(x, z, 0.75, 0.65, 0.95); };
    k.tub = (x, z, dead) => {
      cyl(THREE, g, p.wood, x, 0.35, z, 0.42, 0.34, 0.7, 0, 0, 0, 10); cyl(THREE, g, p.soil, x, 0.69, z, 0.38, 0.38, 0.02, 0, 0, 0, 10);
      twig(THREE, g, p.bark, [x, 0.7, z], [x + 0.05, 1.7, z], 0.05);
      for (let i = 0; i < 5; i++) blob(THREE, g, dead ? p.dry : p.leaf, x + (random() - 0.5) * 0.6, 1.7 + random() * 0.6, z + (random() - 0.5) * 0.6, 0.35, 0.3, 0.35);
      return C(x, z, 0.9, 0.9, 2.2);
    };
    k.raised = (x, z, w, d) => {
      for (const [sx, sz, bw, bd] of [[0, -d / 2, w, 0.14], [0, d / 2, w, 0.14], [-w / 2, 0, 0.14, d], [w / 2, 0, 0.14, d]]) box(THREE, g, p.brick, x + sx, 0.2, z + sz, bw, 0.4, bd);
      box(THREE, g, p.soil, x, 0.36, z, w - 0.1, 0.04, d - 0.1);
      for (let i = 0; i < Math.round(w * d * 4); i++) blob(THREE, g, random() < 0.3 ? p.dry : p.leaf2, x + (random() - 0.5) * (w - 0.3), 0.45 + random() * 0.15, z + (random() - 0.5) * (d - 0.3), 0.12 + random() * 0.1, 0.12, 0.12 + random() * 0.1, 0, 0, 0, true);
      return C(x, z, w, d, 0.45);
    };
    k.roses = (x, z, w) => {
      for (let i = 0; i < Math.round(w * 2.5); i++) {
        const px = x + (random() - 0.5) * w, pz = z + (random() - 0.5) * 0.5, h = 0.5 + random() * 0.6;
        blob(THREE, g, p.leaf, px, h, pz, 0.32, 0.38, 0.3);
        for (let j = 0; j < 3; j++) blob(THREE, g, p.rose, px + (random() - 0.5) * 0.4, h + 0.15 + random() * 0.25, pz + (random() - 0.5) * 0.3, 0.06, 0.05, 0.06, 0, 0, 0, true);
      }
    };
    k.tuft = (x, z, s, mat) => {
      for (let i = 0; i < 5; i++) { const a = i / 5 * TAU + random(); twig(THREE, g, mat || p.leaf2, [x, 0, z], [x + Math.cos(a) * 0.18 * s, (0.4 + random() * 0.35) * s, z + Math.sin(a) * 0.18 * s], 0.012 * s, 0.002, 3); }
    };
    k.statue = (x, z, ry, winged) => {
      const r = joint(THREE, g, 'statue', x, 0, z); r.rotation.y = ry || 0;
      bevel(THREE, r, p.mossy, 0, 0.45, 0, 0.8, 0.9, 0.8, 0.03); box(THREE, r, p.pale, 0, 0.93, 0, 0.9, 0.06, 0.9);
      cyl(THREE, r, p.pale, 0, 1.6, 0, 0.17, 0.32, 1.3, 0, 0, 0, 10);
      blob(THREE, r, p.pale, 0, 2.38, 0.02, 0.13, 0.16, 0.14);
      blob(THREE, r, p.pale, 0, 2.15, 0.02, 0.24, 0.12, 0.17);
      twig(THREE, r, p.pale, [-0.2, 2.1, 0.05], [-0.08, 1.75, 0.22], 0.05); twig(THREE, r, p.pale, [0.2, 2.1, 0.05], [0.06, 1.78, 0.22], 0.05);
      if (winged) for (const s of [-1, 1]) blob(THREE, r, p.pale, s * 0.32, 2.1, -0.16, 0.08, 0.5, 0.3, 0.2, s * 0.4, s * 0.35);
      return C(x, z, 0.95, 0.95, 2.5);
    };
    k.column = (x, z, h, r0) => { cyl(THREE, g, p.pale, x, h / 2 + 0.2, z, r0 || 0.28, (r0 || 0.28) * 1.1, h, 0, 0, 0, 12); bevel(THREE, g, p.stone, x, 0.1, z, 0.8, 0.2, 0.8, 0.02); if (h > 2.4) box(THREE, g, p.pale, x, h + 0.28, z, 0.75, 0.16, 0.75); return C(x, z, 0.8, 0.8, h + 0.2); };
    k.headstone = (x, z, ry, style, h) => {
      const r = joint(THREE, g, 'headstone', x, 0, z); r.rotation.y = ry || 0; const mat = random() < 0.3 ? p.mossy : random() < 0.5 ? p.pale : p.stone;
      const hh = h || 0.8 + random() * 0.5, tilt = (random() - 0.5) * 0.14;
      if (style === 0) { bevel(THREE, r, mat, 0, hh / 2, 0, 0.6, hh, 0.14, 0.02, tilt); cyl(THREE, r, mat, 0, hh, 0, 0.3, 0.3, 0.14, Math.PI / 2, 0, 0, 12); }
      else if (style === 1) { box(THREE, r, mat, 0, hh * 0.6, 0, 0.13, hh * 1.2, 0.13, tilt); box(THREE, r, mat, 0, hh * 0.92, 0, 0.55, 0.12, 0.13, tilt); box(THREE, r, mat, 0, 0.08, 0, 0.5, 0.16, 0.4); }
      else if (style === 2) { bevel(THREE, r, mat, 0, 0.15, 0, 0.6, 0.3, 0.6, 0.02); cyl(THREE, r, mat, 0, 0.3 + hh * 0.7, 0, 0.07, 0.17, hh * 1.4, 0, 0, 0, 4); }
      else bevel(THREE, r, mat, 0, hh * 0.45, 0, 0.55, hh * 0.9, 0.16, 0.03, tilt, 0, (random() - 0.5) * 0.1);
      const wide = style === 2 ? 0.65 : 0.62, deep = style === 2 ? 0.65 : style === 1 ? 0.42 : 0.24;
      const turned = Math.abs(Math.sin(ry || 0)) > 0.5;
      return C(x, z, turned ? deep : wide, turned ? wide : deep, style === 2 ? 0.3 + hh * 1.4 : hh + 0.2);
    };
    k.mound = (x, z, ry, open) => {
      prism(THREE, g, p.soil, x, 0, z, 0.9, 0.26, 1.9, ry);
      if (open) { const ox = Math.cos(ry || 0) * 1.0, oz = -Math.sin(ry || 0) * 1.0; box(THREE, g, p.pit, x + ox, 0.006, z + oz, 0.85, 0.01, 1.9, 0, ry || 0); }
    };
    k.tomb = (x, z, ry) => {
      const r = joint(THREE, g, 'tomb', x, 0, z); r.rotation.y = ry || 0;
      bevel(THREE, r, p.stone, 0, 0.42, 0, 1.0, 0.84, 2.0, 0.03); bevel(THREE, r, p.pale, 0, 0.88, 0, 1.12, 0.1, 2.12, 0.02);
      shroud(THREE, r, p.pale, 0, 0.92, 0).scale.set(0.6, 0.25, 1.5);
      const turned = Math.abs(Math.sin(ry || 0)) > 0.5;
      return C(x, z, turned ? 2.15 : 1.15, turned ? 1.15 : 2.15, 1.0);
    };
    k.bones = (x, z, s) => {
      for (let i = 0; i < 9 * s; i++) blob(THREE, g, p.bone, x + (random() - 0.5) * 0.8 * s, 0.05 + random() * 0.25 * s, z + (random() - 0.5) * 0.6 * s, 0.03, 0.03, 0.2, random(), random() * TAU, 0, true);
      for (let i = 0; i < 2 * s; i++) blob(THREE, g, p.bone, x + (random() - 0.5) * 0.6 * s, 0.12 + random() * 0.2 * s, z + (random() - 0.5) * 0.4 * s, 0.1, 0.11, 0.12);
    };
    k.coffin = (x, z, ry) => {
      const r = joint(THREE, g, 'coffin', x, 0, z); r.rotation.y = ry || 0;
      bevel(THREE, r, p.dark, 0, 0.2, 0, 0.65, 0.4, 2.0, 0.02); box(THREE, r, p.plank, 0.25, 0.43, 0.1, 0.62, 0.05, 1.9, 0, 0.25, 0.08);
      const turned = Math.abs(Math.sin(ry || 0)) > 0.5;
      return C(x, z, turned ? 2.05 : 0.8, turned ? 0.8 : 2.05, 0.48);
    };
    // lo: a silhouette for the horizon, seen only from far off.
    k.tree = (x, z, h, dead, lo) => {
      const lean = (random() - 0.5) * 0.4, f = h / 6.5;
      twig(THREE, g, p.bark, [x, 0, z], [x + lean, h * 0.6, z + lean * 0.5], 0.24 * Math.max(1, f * 0.8), 0.16, lo ? 5 : 7);
      for (let i = 0; i < 5; i++) {
        const a = i / 5 * TAU + random(), y0 = h * (0.4 + random() * 0.25), len = h * (0.25 + random() * 0.2);
        const end = [x + lean + Math.cos(a) * len, y0 + len * (0.4 + random() * 0.5), z + Math.sin(a) * len];
        twig(THREE, g, p.bark, [x + lean * 0.8, y0, z + lean * 0.4], end, 0.09, 0.03, lo ? 3 : 5);
        if (dead) twig(THREE, g, p.bark, end, [end[0] + Math.cos(a + 0.8) * len * 0.4, end[1] + len * 0.3, end[2] + Math.sin(a + 0.8) * len * 0.4], 0.03, 0.01, 3);
        else blob(THREE, g, random() < 0.5 ? p.leaf : p.leaf2, end[0], end[1], end[2], (1.1 + random() * 0.6) * f, (0.8 + random() * 0.4) * f, (1.1 + random() * 0.6) * f, 0, random() * TAU, 0, lo);
      }
      if (!dead) blob(THREE, g, p.leaf, x + lean, h * 0.85, z + lean * 0.5, 1.6 * f, 1.2 * f, 1.6 * f, 0, 0, 0, lo);
      return C(x, z, 0.55, 0.55, h * 0.6);
    };
    k.yew = (x, z, h, lo) => { cyl(THREE, g, p.bark, x, 0.6, z, 0.12, 0.18, 1.2, 0, 0, 0, 6); twig(THREE, g, p.leaf, [x, 0.8, z], [x, 0.8 + h, z], 0.9, 0.05, lo ? 6 : 9); return C(x, z, 1.1, 1.1, h); };
    return k;
  }

  // Outdoor room dressing. The room's walls are hedge or churchyard-wall cells: buildings are clad inside (planks, brick,
  // stone or glass) and roofed above the wall tops; gardens stay open to the sky. Furniture keeps to the walls, clear
  // of the centre (pickups), the doorway (south wall; a 3-wide room's door is its west cell) and the shelter kit spot.
  // options: {width, depth, height, look, seed}. Returns a Group; userData.colliders lists furniture boxes.
  const OUTDOOR_LOOKS = Object.freeze({
    shed: { clad: 'plank', roof: 'pitched', roofMat: 'slate' }, bothy: { clad: 'stone', roof: 'pitched', roofMat: 'slate' },
    cottage: { clad: 'pale', roof: 'pitched', roofMat: 'slate' }, icehouse: { clad: 'brick', roof: 'flat', roofMat: 'mossy' },
    summerhouse: { clad: 'plank', roof: 'pitched', roofMat: 'dark', glass: true }, glasshouse: { clad: 'brick', roof: 'glass', glass: true },
    orangery: { clad: 'pale', roof: 'glass', glass: true }, herb: {}, aviary: {}, rose: {}, wild: {}, folly: {},
    lodge: { clad: 'plank', roof: 'pitched', roofMat: 'slate' }, chapel: { clad: 'stone', roof: 'pitched', roofMat: 'slate', tall: true },
    crypt: { clad: 'stone', roof: 'flat', roofMat: 'mossy' }, hut: { clad: 'plank', roof: 'pitched', roofMat: 'dark' },
    columbarium: { clad: 'pale', roof: 'flat', roofMat: 'stone' }, ossuary: { clad: 'stone', roof: 'flat', roofMat: 'mossy' },
    mausoleum: { clad: 'pale', roof: 'pitched', roofMat: 'stone', tall: true }, charnel: { clad: 'stone', roof: 'pitched', roofMat: 'slate' },
    vestry: { clad: 'wood', roof: 'pitched', roofMat: 'slate' }, paupers: { clad: 'plank', roof: 'pitched', roofMat: 'dark' },
    embalm: { clad: 'pale', roof: 'pitched', roofMat: 'slate' }
  });
  function decorateOutdoorRoom(THREE, options) {
    const opts = options || {}, width = roomDimension(opts.width, 9, 3, 40), depth = roomDimension(opts.depth, 9, 3, 40);
    const H = roomDimension(opts.height, 3.2, 2.6, 6), look = OUTDOOR_LOOKS[opts.look] ? opts.look : 'shed', spec = OUTDOOR_LOOKS[look];
    const g = new THREE.Group(), p = outdoorPalette(THREE), colliders = [];
    g.name = 'Above ground / ' + look;
    let state = (Number(opts.seed) | 0) * 31 + width * 7 + depth * 13;
    for (let i = 0; i < look.length; i++) state = Math.imul(state ^ look.charCodeAt(i), 2654435761);
    const random = seeded(state >>> 0), kit = outdoorKit(THREE, g, p, random);
    const W2 = width / 2, D2 = depth / 2, cells = Math.max(1, Math.round(width / 3));
    const doorX = (Math.floor(cells / 2) - (cells === 3 ? 1 : 0) + 0.5) * width / cells - W2, half = width / cells / 2;
    // Clear: the centre (pickups and the shelter kit), the doorway and the walk from it.
    const blocked = (x, z, w, d) => Math.abs(x) < w / 2 + 2.1 && Math.abs(z) < d / 2 + 2.1 ||
      Math.abs(x - doorX) < w / 2 + half + 0.2 && z + d / 2 > D2 - 2.6;
    const put = c => { if (c) colliders.push(c); return c; };
    const try_ = (x, z, w, d, make) => { if (blocked(x, z, w, d)) return false; put(make(x, z)); return true; };
    const clad = spec.clad && p[spec.clad];
    if (clad) {
      // A boarded or flagged floor over the lawn.
      box(THREE, g, spec.clad === 'plank' || spec.clad === 'wood' ? p.plank : p.stone, 0, 0.01, 0, width - 0.04, 0.02, depth - 0.04);
      const t = 0.08, wainscot = spec.glass ? 0.7 : H;
      box(THREE, g, clad, 0, wainscot / 2, -D2 + t / 2, width, wainscot, t);
      for (const s of [-1, 1]) box(THREE, g, clad, s * (W2 - t / 2), wainscot / 2, 0, t, wainscot, depth);
      const l0 = -W2, l1 = doorX - half, r0 = doorX + half, r1 = W2;
      if (l1 - l0 > 0.05) box(THREE, g, clad, (l0 + l1) / 2, wainscot / 2, D2 - t / 2, l1 - l0, wainscot, t);
      if (r1 - r0 > 0.05) box(THREE, g, clad, (r0 + r1) / 2, wainscot / 2, D2 - t / 2, r1 - r0, wainscot, t);
      box(THREE, g, spec.glass ? p.iron : clad, doorX, H - 0.3, D2 - t / 2, half * 2, 0.6, t + 0.04);
      for (const s of [-1, 1]) box(THREE, g, p.dark, doorX + s * half, 1.3, D2 - 0.06, 0.14, 2.6, 0.14);
      if (spec.glass) {
        // Iron glazing bars over a low wall; the panes are one transparent material.
        box(THREE, g, p.glass, 0, (H + wainscot) / 2, -D2 + 0.05, width, H - wainscot, 0.02);
        for (const s of [-1, 1]) box(THREE, g, p.glass, s * (W2 - 0.05), (H + wainscot) / 2, 0, 0.02, H - wainscot, depth);
        for (let x = -W2; x <= W2 + 0.01; x += 1.5) box(THREE, g, p.iron, x, (H + wainscot) / 2, -D2 + 0.07, 0.05, H - wainscot, 0.05);
        for (let z = -D2; z <= D2 + 0.01; z += 1.5) for (const s of [-1, 1]) box(THREE, g, p.iron, s * (W2 - 0.07), (H + wainscot) / 2, z, 0.05, H - wainscot, 0.05);
        box(THREE, g, p.iron, 0, H - 0.04, -D2 + 0.07, width, 0.06, 0.06);
      }
    }
    if (spec.roof === 'pitched' || spec.roof === 'glass') {
      const rise = spec.tall ? 2.6 : 1.6, eave = D2 + 0.45, len = Math.hypot(eave, rise), a = Math.atan2(rise, eave), m = spec.roof === 'glass' ? p.glass : p[spec.roofMat] || p.slate;
      for (const s of [-1, 1]) box(THREE, g, m, 0, H + rise / 2, s * eave / 2, width + 0.7, spec.roof === 'glass' ? 0.03 : 0.12, len, s * a);
      box(THREE, g, p.dark, 0, H + rise + 0.02, 0, width + 0.75, 0.14, 0.18);
      for (const s of [-1, 1]) prism(THREE, g, spec.roof === 'glass' ? p.iron : clad || p.stone, s * (W2 + 0.02), H, 0, depth + 0.6, rise, spec.roof === 'glass' ? 0.06 : 0.16, Math.PI / 2);
      if (spec.roof === 'glass') for (let x = -W2; x <= W2 + 0.01; x += 1.5) for (const s of [-1, 1]) box(THREE, g, p.iron, x, H + rise / 2 + 0.03, s * eave / 2, 0.05, 0.05, len, s * a);
      for (let x = -W2 + 1.5; x < W2; x += 3) box(THREE, g, p.dark, x, H - 0.08, 0, 0.14, 0.16, depth);
      kit.lantern(0, H - 0.75, 0, true);
    } else if (spec.roof === 'flat') {
      box(THREE, g, p[spec.roofMat] || p.stone, 0, H + 0.2, 0, width + 0.8, 0.4, depth + 0.8);
      box(THREE, g, p.stone, 0, H + 0.45, 0, width + 0.5, 0.1, depth + 0.5);
      kit.lantern(0, H - 0.75, 0, true);
    } else kit.lantern(W2 - 0.6, 2.5, -D2 + 0.6);
    const north = -D2 + 0.45, west = -W2 + 0.45, east = W2 - 0.45;
    const alongNorth = (step, w, d, make) => { for (let x = -W2 + w / 2 + 0.3; x <= W2 - w / 2 - 0.3; x += step) try_(x, north + d / 2 - 0.3, w, d, make); };
    const alongSides = (step, w, d, make, sides) => {
      for (const s of sides || [-1, 1]) for (let z = -D2 + d / 2 + 0.3; z <= D2 - d / 2 - 0.3; z += step) try_(s < 0 ? west + w / 2 - 0.3 : east - w / 2 + 0.3, z, w, d, (x, zz) => make(x, zz, s));
    };
    switch (look) {
      case 'shed':
        alongNorth(2.6, 2.2, 0.7, (x, z) => { const c = kit.table(x, z, 2.2, 0.7, p.plank); for (let i = 0; i < 4; i++) kit.pot(x - 0.8 + i * 0.5, 0.81, z, 0.13, true); return c; });
        alongSides(2.4, 0.5, 1.8, (x, z, s) => kit.shelf(x, z, Math.PI / 2, 1.8, (r, sx, y) => cyl(THREE, r, p.clay, sx, y + 0.1, 0, 0.1, 0.07, 0.2, 0, 0, 0, 8)), [1]);
        kit.tools(west + 0.1, -0.5, Math.PI / 2); kit.sack(west + 0.2, 1.6); kit.sack(east - 0.3, D2 - 0.6);
        break;
      case 'bothy': case 'lodge':
        alongSides(9, 0.95, 2, (x, z) => kit.bed(x, z, 0), [-1]);
        try_(east - 0.4, north + 0.3, 0.75, 0.65, (x, z) => kit.stove(x, z));
        try_(1.2, north + 0.4, 1.4, 0.8, (x, z) => kit.table(x, z, 1.3, 0.75, p.dark));
        alongSides(2.6, 0.5, 1.6, (x, z) => kit.shelf(x, z, Math.PI / 2, 1.6, (r, sx, y) => box(THREE, r, random() < 0.5 ? p.cloth : p.dry, sx, y + 0.1, 0, 0.22, 0.2, 0.3)), [1]);
        break;
      case 'cottage': case 'embalm': case 'vestry':
        alongNorth(3, look === 'embalm' ? 2.1 : 1.8, 0.5, (x, z) => kit.shelf(x, z, 0, look === 'embalm' ? 2.1 : 1.8, (r, sx, y) => cyl(THREE, r, look === 'embalm' ? p.glass : p.white, sx, y + 0.12, 0, 0.08, 0.08, 0.24, 0, 0, 0, 8)));
        alongSides(3.2, look === 'embalm' ? 1.0 : 0.95, 2.1, (x, z, s) => look === 'embalm' ? (shroud(THREE, g, p.cloth, x, 0.85, z), kit.table(x, z, 0.9, 2.0, p.iron)) : s < 0 ? kit.bed(x, z, 0) : kit.table(x, z, 0.9, 1.6, p.wood));
        if (look === 'cottage') { try_(east - 1.6, D2 - 0.8, 0.75, 0.65, (x, z) => kit.stove(x, z)); kit.sack(west + 0.4, D2 - 0.5); }
        break;
      case 'icehouse':
        alongSides(1.4, 0.9, 0.9, (x, z) => { bevel(THREE, g, p.white, x, 0.4, z, 0.8, 0.8, 0.8, 0.04); return { x, z, w: 0.85, d: 0.85, h: 0.8 }; });
        for (let i = 0; i < 6; i++) blob(THREE, g, p.dry, -W2 + 1 + random() * (width - 2), 0.05, north + 0.5 + random() * 1.2, 0.5, 0.06, 0.4, 0, 0, 0, true);
        for (let x = -W2 + 1; x < W2; x += 1.2) twig(THREE, g, p.iron, [x, H - 0.05, north], [x, H - 0.5, north], 0.012);
        break;
      case 'summerhouse':
        try_(0, north + 0.3, 1.7, 0.6, (x, z) => kit.bench(x, z, 0, p.wood));
        alongSides(9, 0.8, 0.8, (x, z) => kit.table(x, z, 0.75, 0.75, p.dark));
        break;
      case 'glasshouse': case 'orangery':
        if (look === 'glasshouse') {
          alongNorth(3.2, 2.8, 0.8, (x, z) => { const c = kit.table(x, z, 2.8, 0.8, p.plank); for (let i = 0; i < 5; i++) kit.pot(x - 1.1 + i * 0.55, 0.81, z, 0.14, random() < 0.7); return c; });
          alongSides(3, 0.8, 2.6, (x, z) => { const c = kit.table(x, z, 0.8, 2.6, p.plank); for (let i = 0; i < 4; i++) kit.pot(x, 0.81, z - 0.9 + i * 0.6, 0.15, random() < 0.7); return c; });
        } else {
          alongNorth(2.2, 1.0, 1.0, (x, z) => kit.tub(x, z, random() < 0.6));
          alongSides(2.4, 1.0, 1.0, (x, z) => kit.tub(x, z, random() < 0.6));
        }
        break;
      case 'herb':
        alongNorth(9, width - 1.2, 1.0, (x, z) => kit.raised(x, z, width - 1.4, 1.0));
        alongSides(9, 1.0, 3.2, (x, z) => kit.raised(x, z, 1.0, 3.0), [1]);
        try_(west + 0.4, -0.4, 0.6, 1.7, (x, z) => kit.bench(x, z, Math.PI / 2, p.wood));
        break;
      case 'aviary': {
        for (let i = 0; i < 4; i++) { const a = i / 4 * Math.PI; ring(THREE, g, p.iron, 0, 0.1, 0, Math.min(W2, D2) - 0.2, 0.02, 0, a, 0, Math.PI); }
        for (const s of [-1, 1]) ring(THREE, g, p.iron, 0, 0.1, 0, Math.min(W2, D2) - 0.2, 0.025, Math.PI / 2 * s, 0, 0, Math.PI);
        alongSides(2.8, 0.3, 0.3, (x, z) => { twig(THREE, g, p.dark, [x, 0, z], [x, 1.9, z], 0.035); twig(THREE, g, p.dark, [x - 0.5, 1.6, z], [x + 0.5, 1.6, z], 0.02); blob(THREE, g, p.dark, x + 0.2, 1.67, z, 0.08, 0.06, 0.12); return { x, z, w: 0.3, d: 0.3, h: 1.9 }; });
        for (let i = 0; i < 9; i++) blob(THREE, g, p.dark, (random() - 0.5) * (width - 2), 0.05, north + random() * 1.5, 0.09, 0.05, 0.13, 0, random() * TAU, 0, true);
        break;
      }
      case 'rose':
        kit.roses(0, north + 0.3, width - 1.4);
        for (const s of [-1, 1]) { const x = s < 0 ? west : east; for (let z = -D2 + 1; z < D2 - 2.8; z += 1.1) kit.roses(x, z, 1); colliders.push({ x, z: -0.9, w: 0.7, d: depth - 3.4, h: 1 }); }
        colliders.push({ x: 0, z: north + 0.3, w: width - 1.2, d: 0.7, h: 1 });
        ring(THREE, g, p.iron, 0, 2.0, north + 1.0, 1.1, 0.03, 0, 0, 0, Math.PI);
        for (const s of [-1, 1]) twig(THREE, g, p.iron, [s * 1.1, 0, north + 1.0], [s * 1.1, 2.0, north + 1.0], 0.03);
        break;
      case 'wild':
        for (let i = 0; i < 26; i++) { const x = (random() - 0.5) * (width - 1.2), z = (random() - 0.5) * (depth - 1.2); if (!blocked(x, z, 0.3, 0.3)) kit.tuft(x, z, 1.6 + random(), random() < 0.5 ? p.dry : p.leaf2); }
        try_(east - 0.6, north + 0.6, 0.95, 0.95, (x, z) => kit.statue(x, z, -0.6, true));
        blob(THREE, g, p.pale, west + 0.8, 0.3, 0.4, 0.35, 0.3, 0.55, Math.PI / 2, 0.4, 0);
        for (let i = 0; i < 5; i++) blob(THREE, g, p.leaf, west + 0.4 + random(), 0.3, north + 0.4 + random() * 1.5, 0.5, 0.35, 0.5);
        break;
      case 'folly':
        for (const [x, z, h] of [[-W2 + 1.5, north + 0.5, 3.4], [-W2 + 4.5, north + 0.5, 1.4], [W2 - 4.5, north + 0.5, 3.4], [W2 - 1.5, north + 0.5, 2.1]]) try_(x, z, 0.85, 0.85, (xx, zz) => kit.column(xx, zz, h));
        box(THREE, g, p.pale, -W2 + 1.5, 3.75, north + 0.5, 0.8, 0.2, 0.8);
        for (let i = 0; i < 3; i++) { const x = W2 - 1.6 - i * 0.9, z = D2 - 1.2; if (!blocked(x, z, 0.9, 0.7)) { cyl(THREE, g, p.pale, x, 0.3, z, 0.3, 0.3, 0.7, Math.PI / 2, random(), 0, 12); colliders.push({ x, z, w: 0.8, d: 0.8, h: 0.6 }); } }
        alongSides(9, 0.95, 0.95, (x, z) => kit.statue(x, z, 0, false), [-1]);
        break;
      case 'chapel': case 'paupers': {
        const aisle = 1.6, rows = Math.floor((depth - 3.2) / 1.2);
        try_(0, north + 0.4, 1.8, 0.8, (x, z) => { bevel(THREE, g, p.pale, x, 0.5, z, 1.8, 1.0, 0.8, 0.03); box(THREE, g, p.white, x, 1.02, z, 1.6, 0.03, 0.7); for (const s of [-0.6, 0.6]) { cyl(THREE, g, p.white, x + s, 1.2, z, 0.03, 0.03, 0.3, 0, 0, 0, 6); box(THREE, g, p.live, x + s, 1.38, z, 0.02, 0.05, 0.02).castShadow = false; } return { x, z, w: 1.9, d: 0.9, h: 1.05 }; });
        if (look === 'chapel') { box(THREE, g, p.dark, 0, 2.3, -D2 + 0.1, 0.12, 1.4, 0.06); box(THREE, g, p.dark, 0, 2.55, -D2 + 0.1, 0.8, 0.12, 0.06); }
        else { box(THREE, g, p.wood, 0, 2.0, -D2 + 0.1, 0.1, 1.2, 0.05); box(THREE, g, p.wood, 0, 2.3, -D2 + 0.1, 0.6, 0.1, 0.05); }
        for (let i = 0; i < rows; i++) for (const s of [-1, 1]) {
          const z = north + 1.8 + i * 1.2, w = W2 - aisle / 2 - 0.5, x = s * (aisle / 2 + w / 2);
          try_(x, z, w, 0.5, (xx, zz) => { box(THREE, g, p.dark, xx, 0.45, zz, w, 0.05, 0.4); box(THREE, g, p.dark, xx, 0.75, zz + 0.2, w, 0.55, 0.05); for (const e of [-1, 1]) box(THREE, g, p.dark, xx + e * (w / 2 - 0.04), 0.4, zz, 0.05, 0.8, 0.45); return { x: xx, z: zz, w, d: 0.5, h: 0.9 }; });
        }
        break;
      }
      case 'crypt': case 'mausoleum':
        alongNorth(look === 'crypt' ? 9 : 4, 2.15, 1.15, (x, z) => kit.tomb(x, z, Math.PI / 2));
        if (look === 'mausoleum') { alongSides(3.6, 1.15, 2.15, (x, z) => kit.tomb(x, z, 0)); for (const s of [-1, 1]) for (const z of [-D2 + 0.5, D2 - 0.5]) kit.column(s * (W2 - 0.5), z, H - 0.2, 0.22); }
        else alongSides(9, 0.8, 2.05, (x, z) => kit.coffin(x, z, 0), [1]);
        for (let x = -W2 + 1; x < W2 - 0.5; x += 1.5) box(THREE, g, p.pale, x, H - 0.2, north - 0.2, 0.2, 0.4, 0.2);
        break;
      case 'columbarium': {
        for (const [x, z, ry, len] of [[0, -D2 + 0.12, 0, width - 0.6], [-W2 + 0.12, 0, Math.PI / 2, depth - 3.2], [W2 - 0.12, 0, -Math.PI / 2, depth - 3.2]]) {
          const r = joint(THREE, g, 'niches', x, 0, z); r.rotation.y = ry;
          for (let row = 0; row < 4; row++) for (let i = 0; i < Math.floor(len / 0.6); i++) {
            const nx = -len / 2 + 0.3 + i * 0.6, y = 0.5 + row * 0.6;
            box(THREE, r, p.pit, nx, y, 0.01, 0.42, 0.42, 0.02).castShadow = false;
            if (random() < 0.7) { cyl(THREE, r, random() < 0.5 ? p.clay : p.pale, nx, y - 0.08, 0.08, 0.09, 0.07, 0.24, 0, 0, 0, 8); }
          }
        }
        colliders.push({ x: 0, z: -D2 + 0.15, w: width, d: 0.3, h: 2.6 });
        try_(1.2, 1.2, 1.7, 0.6, (x, z) => kit.bench(x, z, Math.PI, p.stone));
        break;
      }
      case 'ossuary': case 'charnel':
        alongNorth(2.2, 1.6, 0.9, (x, z) => { kit.bones(x, z, 1.4); return { x, z, w: 1.6, d: 0.9, h: 0.5 }; });
        alongSides(2.8, 0.5, 2.0, (x, z) => kit.shelf(x, z, Math.PI / 2, 2.0, (r, sx, y) => blob(THREE, r, p.bone, sx, y + 0.11, 0, 0.1, 0.11, 0.12, 0, 0, 0, true)), look === 'ossuary' ? [-1, 1] : [1]);
        if (look === 'charnel') alongSides(9, 1.0, 2.1, (x, z) => { shroud(THREE, g, p.cloth, x, 0.85, z); return kit.table(x, z, 0.95, 2.05, p.stone); }, [-1]);
        break;
      case 'hut':
        alongNorth(3, 2.0, 0.8, (x, z) => kit.coffin(x, z, Math.PI / 2));
        kit.tools(west + 0.15, -1.2, Math.PI / 2); kit.tools(east - 0.2, 1.0, -Math.PI / 2);
        alongSides(2.2, 0.65, 0.65, (x, z) => kit.barrel(x, z), [1]);
        kit.mound(east - 1.3, D2 - 1.1, 0, false); kit.sack(west + 0.3, 1.8);
        break;
    }
    flattenStatic(THREE, g);
    batch(THREE, g, { boxUV: 1 });
    g.traverse(o => { if (o.isMesh && o.material === p.glass) o.castShadow = false; });
    g.userData = { look, width, depth, height: H, colliders, direction: 'Above ground' };
    return g;
  }

  // The dressing of an outdoor floor's paths and lawns (it replaces decorateWard there): S1's fountain, trees, statues,
  // benches, urns and lamp posts; S2's rows of graves, chest tombs, dead trees and yews, the boss's grave, the graves
  // its summons climb out of and the bell by the gate. Everything with a footprint stays one stride off the cells in
  // `avoid` ({x, z, r} world metres) and out of door approaches, and is listed in userData.colliders.
  // options: {grid, cellSize, height, rooms, seed, kind: 'garden'|'graveyard', centre: [cx, cz], avoid, boss, landmarks}
  function decorateGrounds(THREE, options) {
    const opts = options || {}, grid = opts.grid || [], s = opts.cellSize || 3, kind = opts.kind === 'graveyard' ? 'graveyard' : 'garden';
    const g = new THREE.Group(); g.name = 'Above ground / ' + kind;
    const p = outdoorPalette(THREE), random = seeded(((opts.seed | 0) ^ 0x2c1b3c6d) >>> 0), kit = outdoorKit(THREE, g, p, random);
    const colliders = [], practicals = [], avoid = (opts.avoid || []).slice(), rooms = opts.rooms || [];
    g.userData = { decoration: true, practicals, colliders, liveMaterial: p.live, bell: null };
    const W = grid.length; if (!W) return g;
    const key = (x, z) => x + ',' + z, special = new Set();
    for (const r of rooms) {
      for (let z = r.z - 1; z <= r.z + r.d; z++) for (let x = r.x - 1; x <= r.x + r.w; x++) special.add(key(x, z));
      if (r.door) for (let z = r.door.z; z <= r.door.z + 2; z++) special.add(key(r.door.x, z));
    }
    const open = (x, z) => grid[z]?.[x] === 0, wall = (x, z) => grid[z]?.[x] === 1;
    const cells = [];
    for (let z = 1; z < W - 1; z++) for (let x = 1; x < W - 1; x++) {
      if (!open(x, z) || special.has(key(x, z)) || (x <= 6 && z <= 4)) continue;
      const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dz]) => wall(x + dx, z + dz));
      let around = 0; for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (open(x + dx, z + dz)) around++;
      cells.push({ x, z, wx: (x + 0.5) * s, wz: (z + 0.5) * s, sides, around, rank: random() });
    }
    cells.sort((a, b) => a.rank - b.rank);
    const taken = [];
    // A clear 1.25 m between any two footprints keeps every creature's way through (the Warden needs 1.16 m).
    const fits = (x, z, w, d) => avoid.every(a => Math.hypot(Math.max(0, Math.abs(a.x - x) - w / 2), Math.max(0, Math.abs(a.z - z) - d / 2)) > a.r) &&
      taken.every(t => Math.abs(t.x - x) > (t.w + w) / 2 + 1.25 || Math.abs(t.z - z) > (t.d + d) / 2 + 1.25);
    const place = c => { if (c) { colliders.push(c); taken.push(c); } return c; };
    // Against a wall of cell c: centre `inset` metres off the wall face, `along` metres along it.
    const against = (c, side, inset, along) => { const [dx, dz] = side; return [c.wx + dx * (s / 2 - inset) - dz * along, c.wz + dz * (s / 2 - inset) + dx * along, Math.atan2(-dx, -dz)]; };
    const landmarks = opts.landmarks || {};
    if (landmarks.ped) {
      const { x, z } = landmarks.ped;
      if (kind === 'garden') { cyl(THREE, g, p.pale, x, 1.03, z, 0.3, 0.3, 0.04, 0, 0, 0, 16); prism(THREE, g, p.rust, x, 1.05, z, 0.04, 0.22, 0.32, Math.PI / 2); }
      else { bevel(THREE, g, p.dark, x, 1.08, z, 0.42, 0.1, 0.32, 0.02, -0.3); kit.lantern(x + 0.12, 1.27, z - 0.08); }
    }
    if (landmarks.chan) {
      const { x, z } = landmarks.chan;
      if (kind === 'garden') { cyl(THREE, g, p.pale, x, 0.42, z, 0.42, 0.25, 0.85, 0, 0, Math.PI / 2 - 0.15, 12); cyl(THREE, g, p.soil, x - 0.5, 0.05, z + 0.1, 0.5, 0.6, 0.1, 0, 0, 0, 9); }
      else { kit.statue(0, 0, 0, true); const last = g.children.slice(-1)[0]; last.position.set(x, 0.5, z); last.rotation.set(Math.PI / 2 - 0.2, 0.6, 0); }
    }
    const used = new Set();
    const pick = (test, count, make) => {
      let n = 0;
      for (const c of cells) {
        if (n >= count) break;
        if (used.has(key(c.x, c.z)) || !test(c)) continue;
        if (make(c)) { used.add(key(c.x, c.z)); n++; }
      }
    };
    const lamp = (c, side) => {
      const [x, z] = side ? against(c, side, 0.35, 0) : [c.wx, c.wz];
      if (!fits(x, z, 0.4, 0.4)) return false;
      place(kit.post(x, z)); practicals.push({ x, z, color: kind === 'garden' ? 0xd9a466 : 0xc9a06a, phase: random() * TAU });
      return true;
    };
    const boss = opts.boss || null, arena = boss && boss.arena;
    const inArena = c => arena && c.x >= arena[0] && c.x <= arena[2] && c.z >= arena[1] && c.z <= arena[3];
    if (kind === 'garden') {
      if (opts.centre) {
        const [x, z] = opts.centre;
        cyl(THREE, g, p.pale, x, 0.32, z, 1.75, 1.85, 0.64, 0, 0, 0, 28); cyl(THREE, g, p.slate, x, 0.6, z, 1.55, 1.55, 0.04, 0, 0, 0, 28);
        ring(THREE, g, p.pale, x, 0.64, z, 1.66, 0.11, Math.PI / 2, 0, 0);
        cyl(THREE, g, p.pale, x, 1.1, z, 0.16, 0.28, 1.0, 0, 0, 0, 12); cyl(THREE, g, p.pale, x, 1.65, z, 0.8, 0.2, 0.22, 0, 0, 0, 18);
        cyl(THREE, g, p.slate, x, 1.77, z, 0.68, 0.68, 0.03, 0, 0, 0, 18); kit.statue(x, z, 0.4, false);
        const figure = g.children[g.children.length - 1]; figure.position.y = 0.95; figure.scale.setScalar(0.8);
        colliders.push({ x, z, w: 3.3, d: 3.3, h: 0.7 }); taken.push({ x, z, w: 3.6, d: 3.6 });
        for (let i = 0; i < 4; i++) { const a = i / 4 * TAU + Math.PI / 4; place(kit.post(x + Math.cos(a) * 4.6, z + Math.sin(a) * 4.6)); }
        practicals.push({ x: x + 3.25, z: z + 3.25, color: 0xd9a466, phase: random() * TAU });
      }
      pick(c => c.around >= 8, 9, c => { const x = c.wx + (random() - 0.5) * 1.2, z = c.wz + (random() - 0.5) * 1.2; if (!fits(x, z, 0.6, 0.6)) return false; place(kit.tree(x, z, 5 + random() * 3, false)); return true; });
      pick(c => c.sides.length === 1, 7, c => { const [x, z, ry] = against(c, c.sides[0], 0.65, 0); if (!fits(x, z, 1, 1)) return false; place(kit.statue(x, z, ry, random() < 0.4)); return true; });
      pick(c => c.sides.length >= 1, 8, c => { const side = c.sides[0], [x, z, ry] = against(c, side, 0.4, (random() - 0.5) * 0.8); const turned = side[0] !== 0; if (!fits(x, z, turned ? 0.6 : 1.7, turned ? 1.7 : 0.6)) return false; place(kit.bench(x, z, ry)); return true; });
      pick(c => c.sides.length >= 2, 10, c => { const [x, z] = against(c, c.sides[0], 0.55, (s / 2 - 0.55) * (random() < 0.5 ? -1 : 1)); if (!fits(x, z, 0.8, 0.8)) return false; bevel(THREE, g, p.mossy, x, 0.35, z, 0.7, 0.7, 0.7, 0.03); cyl(THREE, g, p.pale, x, 0.95, z, 0.36, 0.2, 0.5, 0, 0, 0, 12); kit.pot(x, 1.12, z, 0.1, random() < 0.5); place({ x, z, w: 0.75, d: 0.75, h: 1.3 }); return true; });
      pick(c => c.sides.length >= 1, 9, c => lamp(c, c.sides[0]));
      // Shrubs, flowers and long grass at the hedge feet: no footprint, walked through.
      for (const c of cells) for (const side of c.sides) {
        if (random() > 0.45) continue;
        for (let i = 0; i < 3; i++) {
          const [x, z] = against(c, side, 0.22 + random() * 0.2, (random() - 0.5) * (s - 0.6));
          if (random() < 0.5) kit.tuft(x, z, 1 + random() * 0.8, random() < 0.3 ? p.dry : p.leaf2);
          else { blob(THREE, g, random() < 0.5 ? p.leaf : p.leaf2, x, 0.18, z, 0.3, 0.25, 0.3, 0, 0, 0, true); if (random() < 0.4) blob(THREE, g, random() < 0.5 ? p.white : p.rose, x, 0.4, z, 0.05, 0.04, 0.05, 0, 0, 0, true); }
        }
      }
    } else {
      if (boss && boss.grave) {
        const [gx, gz] = boss.grave, x = (gx + 0.5) * s, z = (gz + 0.5) * s;
        kit.mound(x + 1.15, z, 0, false); box(THREE, g, p.pit, x, 0.006, z, 1.3, 0.01, 2.3);
        const stone = kit.headstone(x, z - 1.75, 0, 0, 1.9); colliders.push(stone); taken.push({ x, z, w: 3.4, d: 3.4 });
        for (let i = 0; i < 6; i++) blob(THREE, g, p.soil, x + (random() - 0.5) * 2, 0.06, z + (random() - 0.5) * 2.4, 0.3, 0.1, 0.25, 0, 0, 0, true);
        practicals.push({ x: x - 1.8, z: z - 1.6, color: 0x7fa68a, phase: random() * TAU });
        box(THREE, g, p.live, x - 0.25, 0.1, z - 1.55, 0.05, 0.12, 0.05).castShadow = false; box(THREE, g, p.live, x + 0.25, 0.1, z - 1.6, 0.05, 0.1, 0.05).castShadow = false;
      }
      for (const [sx, sz] of (boss && boss.summons) || []) {
        const x = (sx + 0.5) * s, z = (sz + 0.5) * s;
        kit.mound(x, z + 0.15, 0, false); colliders.push(kit.headstone(x, z - 1.5, 0, [0, 1, 3][random() * 3 | 0])); taken.push({ x, z, w: 2.4, d: 2.4 });
      }
      if (opts.gate) {
        // The bell on its gallows frame beside the gate: it swings when the Gravekeeper is called.
        const [ex, ez] = opts.gate, x = ex * s - 1.0, z = (ez - 2) * s + 0.5, frame = joint(THREE, g, 'bell frame', x, 0, z);
        for (const d of [-0.75, 0.75]) box(THREE, frame, p.dark, 0, 1.6, d, 0.16, 3.2, 0.16);
        box(THREE, frame, p.dark, 0, 3.2, 0, 0.2, 0.2, 1.8); prism(THREE, frame, p.slate, 0, 3.3, 0, 0.9, 0.5, 2.0, Math.PI / 2);
        const bell = new THREE.Group(); bell.position.set(x, 3.08, z); g.add(bell);
        const cup = cyl(THREE, bell, p.rust, 0, -0.4, 0, 0.16, 0.36, 0.62, 0, 0, 0, 14); cup.userData.dynamic = true;
        const lip = ring(THREE, bell, p.rust, 0, -0.71, 0, 0.36, 0.035, Math.PI / 2, 0, 0); lip.userData.dynamic = true;
        const clapper = blob(THREE, bell, p.iron, 0, -0.66, 0, 0.07, 0.07, 0.07); clapper.userData.dynamic = true;
        g.userData.bell = bell; colliders.push({ x, z, w: 0.5, d: 1.9, h: 3.2 });
      }
      pick(c => c.around >= 6 && !inArena(c), 8, c => { const x = c.wx + (random() - 0.5), z = c.wz + (random() - 0.5); if (!fits(x, z, 1.2, 1.2)) return false; place(random() < 0.6 ? kit.tree(x, z, 5 + random() * 3, true) : kit.yew(x, z, 3.5 + random() * 2)); return true; });
      pick(c => c.around >= 7, 7, c => { const turned = random() < 0.5, x = c.wx + (random() - 0.5) * 0.6, z = c.wz + (random() - 0.5) * 0.6; if (!fits(x, z, turned ? 2.2 : 1.2, turned ? 1.2 : 2.2)) return false; place(kit.tomb(x, z, turned ? Math.PI / 2 : 0)); if (random() < 0.5) for (let i = 0; i < 10; i++) { const a = i / 10 * TAU; twig(THREE, g, p.iron, [x + Math.cos(a) * 1.5, 0, z + Math.sin(a) * 1.5], [x + Math.cos(a) * 1.5, 0.9, z + Math.sin(a) * 1.5], 0.015); } return true; });
      // Rows of graves: a headstone at the head, a sunken or mounded plot below it.
      let stones = 0;
      for (const c of cells) {
        if (stones >= 70) break;
        const wide = c.around >= 7, edge = c.sides.length >= 1;
        if (!wide && !(edge && random() < 0.4)) continue;
        const spots = wide ? [[-0.85, -0.7], [0.85, -0.7]] : [[0, 0]];
        for (const [ox, oz] of spots) {
          if (random() < (wide ? 0.35 : 0)) continue;
          let x = c.wx + ox, z = c.wz + oz, ry = 0;
          if (!wide) { const side = c.sides[0]; [x, z, ry] = against(c, side, 0.3, (random() - 0.5) * 1.4); }
          const st = kit.headstone(0, 0, 0, random() * 4 | 0), last = g.children[g.children.length - 1];
          if (!fits(x, z, Math.max(st.w, st.d), Math.max(st.w, st.d))) { g.remove(last); continue; }
          last.position.set(x, 0, z); last.rotation.y = ry + (random() - 0.5) * 0.15;
          const turned = Math.abs(Math.sin(ry)) > 0.5;
          place({ x, z, w: turned ? st.d : st.w, d: turned ? st.w : st.d, h: st.h }); stones++;
          if (wide && random() < 0.7) kit.mound(x, z + 1.15, 0, random() < 0.08);
          if (random() < 0.12) box(THREE, g, p.live, x + 0.2, 0.06, z + 0.3, 0.04, 0.1, 0.04).castShadow = false;
        }
      }
      // Flat ledger stones and leaning markers between them: no footprint.
      for (const c of cells) if (c.around >= 7 && random() < 0.25) box(THREE, g, random() < 0.5 ? p.stone : p.mossy, c.wx + (random() - 0.5) * 1.5, 0.04, c.wz + 0.6, 0.8, 0.08, 1.6, 0, (random() - 0.5) * 0.2);
      pick(c => c.sides.length >= 1, 8, c => lamp(c, c.sides[0]));
      for (const c of cells) for (const side of c.sides) if (random() < 0.4) for (let i = 0; i < 2; i++) { const [x, z] = against(c, side, 0.2 + random() * 0.2, (random() - 0.5) * (s - 0.6)); kit.tuft(x, z, 1 + random() * 0.7, random() < 0.7 ? p.dry : p.leaf2); }
    }
    const bell = g.userData.bell;
    if (bell) g.remove(bell);
    flattenStatic(THREE, g);
    batch(THREE, g, { boxUV: 1 });
    // Low clutter receives light without casting; trees, statues and stones cast the torch's shadows.
    if (bell) g.add(bell);
    g.userData.colliders = colliders;
    return g;
  }

  // Beyond the walls: a ring of tall tree silhouettes against the night sky (S1 full canopies, S2 bare trees and yews).
  function decorateHorizon(THREE, options) {
    const opts = options || {}, size = opts.size || 105, kind = opts.kind === 'graveyard' ? 'graveyard' : 'garden';
    const g = new THREE.Group(); g.name = 'Above ground / horizon';
    const p = outdoorPalette(THREE), random = seeded(((opts.seed | 0) ^ 0x51ed270b) >>> 0), kit = outdoorKit(THREE, g, p, random);
    for (let i = 0; i < 70; i++) {
      const side = i % 4, t = random() * (size + 40) - 20, out = 4 + random() * 34;
      const x = side === 0 ? -out : side === 1 ? size + out : t, z = side === 2 ? -out : side === 3 ? size + out : t;
      const h = 9 + random() * 9;
      if (kind === 'garden' && random() < 0.3) twig(THREE, g, p.leaf, [x, h * 0.05, z], [x, h * 1.05, z], 2 + random(), 0.2, 7);
      else if (kind === 'graveyard' && random() < 0.35) kit.yew(x, z, h * 0.7, true);
      else kit.tree(x, z, h, kind === 'graveyard' || random() < 0.15, true);
    }
    flattenStatic(THREE, g);
    batch(THREE, g);
    g.traverse(o => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
    g.userData.decoration = true;
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
    let target = { texture: source, dispose: () => source.dispose() };
    // Node materials (WebGPURenderer) prefilter an equirectangular environment on first use.
    if (renderer.isWebGPURenderer !== true) try {
      const pmrem = new THREE.PMREMGenerator(renderer);
      try { pmrem.compileEquirectangularShader(); target = pmrem.fromEquirectangular(source); }
      finally { pmrem.dispose(); }
      source.dispose();
    } catch (_) {
      target = { texture: source, dispose: () => source.dispose() };
    }
    target.texture.userData = Object.assign(target.texture.userData || {}, { hollowShared: true });
    res.environments.set(renderer, target); res.environmentTargets.add(target);
    const anisotropy = Math.min(8, maxAnisotropy(renderer));
    for (const maps of res.maps.values()) for (const t of Object.values(maps)) t.anisotropy = anisotropy;
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

  global.HollowVisuals = Object.freeze({ makeMonster, makeWeapon, makeFlashlight, makeSurvivor, decorateRoom, decorateWard, enhanceMaterial, createEnvironment, disposeEnvironment, disposeGroup, configure, surface, adoptSurface, settleSurfaces, whenPainted, surfacePlan, deriveMaps,
    decorateOutdoorRoom, decorateGrounds, decorateHorizon, OUTDOOR_LOOKS, LATE_SURFACES });
})(window);
