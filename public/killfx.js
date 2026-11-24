/* Screen layer for the kill sequences: blood thrown onto the lens (it builds up and runs), fractured vision, dirt
   shovelled into a grave, red flashes, the closing tunnel and the final blackout. One 2D canvas over the game canvas
   (below every screen); splats are drawn once into a stain layer, so a frame costs a few full-screen blits.
   Seeded, so a replayed kill paints the same blood. DOM only (no THREE). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HollowKillFX = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const TAU = Math.PI * 2, MAX_DRIPS = 24;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const num = (v, d) => typeof v === 'number' && Number.isFinite(v) ? v : d;
  function rng(seed) {
    let s = seed | 0;
    return () => { s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  }
  // A jagged ring of n radii around 1, for the grave mouth and fracture rings.
  function jagged(rand, n, amount) { const out = new Float32Array(n); for (let i = 0; i < n; i++) out[i] = 1 + (rand() * 2 - 1) * amount; return out; }

  function create(options) {
    const o = options || {}, doc = o.document || (typeof document !== 'undefined' ? document : null);
    const win = o.window || (typeof window !== 'undefined' ? window : null);
    const state = { active: false, effects: true, splats: 0, cracks: 0, dirt: 0, black: 0, red: 0, tunnel: 0, flash: 0, grave: 0 };
    const drips = [];
    for (let i = 0; i < MAX_DRIPS; i++) drips.push({ on: false, x: 0, y: 0, v: 0, w: 0, life: 0, a: 0 });
    let canvas = null, ctx = null, stain = null, sctx = null, crack = null, cctx = null, W = 0, H = 0, scale = 1;
    let rand = rng(1), mouth = null, dirty = false;

    function layer(w, h) { const c = doc.createElement('canvas'); c.width = w; c.height = h; return c; }
    function ensure() {
      if (!doc) return false;
      if (!canvas) {
        canvas = doc.createElement('canvas'); canvas.id = 'killfx'; canvas.setAttribute('aria-hidden', 'true');
        Object.assign(canvas.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', zIndex: '4', pointerEvents: 'none', display: 'none' });
        (doc.body || doc.documentElement).appendChild(canvas);
        ctx = canvas.getContext('2d');
      }
      const vw = Math.max(64, num(win && win.innerWidth, 1000)), vh = Math.max(64, num(win && win.innerHeight, 650));
      scale = Math.min(1, 1280 / vw);
      const w = Math.round(vw * scale), h = Math.round(vh * scale);
      if (w !== W || h !== H) {
        W = w; H = h; canvas.width = W; canvas.height = H;
        stain = layer(W, H); sctx = stain.getContext('2d'); crack = layer(W, H); cctx = crack.getContext('2d');
      }
      return !!ctx;
    }

    function start(opts) {
      opts = opts || {};
      state.effects = opts.effects !== false;
      rand = rng(num(opts.seed, 1) | 0 || 1);
      mouth = { top: jagged(rand, 24, .06), side: jagged(rand, 24, .06) };
      state.splats = state.cracks = state.dirt = 0; state.black = state.red = state.tunnel = state.flash = state.grave = 0;
      for (const d of drips) d.on = false;
      if (!ensure()) { state.active = true; return; }
      sctx.clearRect(0, 0, W, H); cctx.clearRect(0, 0, W, H); ctx.clearRect(0, 0, W, H);
      canvas.style.display = 'block'; state.active = true; dirty = true;
    }

    function drip(x, y, w) {
      if (!state.effects && rand() < .5) return;
      const d = drips.find(q => !q.on);
      if (!d) return;
      d.on = true; d.x = x; d.y = y; d.v = (40 + rand() * 70) * (H / 650); d.w = w; d.life = 1.2 + rand() * 2.2; d.a = .55 + rand() * .3;
    }
    // A closed, smoothly lumpy outline around (cx, cy): radius r(θ) = r·(1 + rough·Σ sin(kθ + φ)).
    function lump(c, cx, cy, r, rough, sx, sy) {
      const p1 = rand() * TAU, p2 = rand() * TAU, p3 = rand() * TAU, n = 36;
      c.beginPath();
      for (let i = 0; i <= n; i++) {
        const t = i / n * TAU, k = 1 + rough * (.5 * Math.sin(3 * t + p1) + .3 * Math.sin(5 * t + p2) + .2 * Math.sin(9 * t + p3));
        const px = cx + Math.cos(t) * r * k * sx, py = cy + Math.sin(t) * r * k * sy;
        i ? c.lineTo(px, py) : c.moveTo(px, py);
      }
      c.closePath();
    }
    // A tapering run of blood thrown out from the splat along `ang`, bending a little, ending in a bead.
    function tendril(c, cx, cy, ang, from, len, w0, alpha) {
      const n = 9, left = [], right = [];
      let px = cx + Math.cos(ang) * from, py = cy + Math.sin(ang) * from, dir = ang;
      const bend = (rand() - .5) * .5;
      for (let i = 0; i <= n; i++) {
        const u = i / n, w = w0 * (1 - .78 * u) * (.85 + .3 * rand()) * .5, nx = -Math.sin(dir), ny = Math.cos(dir);
        left.push(px + nx * w, py + ny * w); right.push(px - nx * w, py - ny * w);
        dir += bend / n; px += Math.cos(dir) * len / n; py += Math.sin(dir) * len / n;
      }
      c.fillStyle = `rgba(${78 + rand() * 30 | 0},0,5,${alpha})`;
      c.beginPath(); c.moveTo(left[0], left[1]);
      for (let i = 2; i < left.length; i += 2) c.lineTo(left[i], left[i + 1]);
      for (let i = right.length - 2; i >= 0; i -= 2) c.lineTo(right[i], right[i + 1]);
      c.closePath(); c.fill();
      if (rand() < .65) {
        const d = len * (.08 + .12 * rand()), r = Math.max(.8, w0 * (.25 + .25 * rand()));
        drop(c, px + Math.cos(dir) * d, py + Math.sin(dir) * d, r, dir, 1.3 + rand() * .6, alpha);
      }
    }
    // A droplet, stretched along the direction it flew.
    function drop(c, x, y, r, ang, stretch, alpha) {
      c.fillStyle = `rgba(${70 + rand() * 50 | 0},0,4,${alpha})`;
      c.beginPath();
      if (typeof c.ellipse === 'function') c.ellipse(x, y, r * stretch, r, ang, 0, TAU); else c.arc(x, y, r, 0, TAU);
      c.fill();
    }
    // Blood on the lens at (x, y) in 0..1 screen space. amount ~0.3 (a fleck) .. 2 (the screen goes red).
    function blood(x, y, amount) {
      state.splats++;
      if (!sctx) return;
      const a = clamp(num(amount, 1), .1, 2.5), soft = state.effects ? 1 : .55, s = Math.min(W, H);
      const cx = clamp(num(x, .5), -.1, 1.1) * W, cy = clamp(num(y, .5), -.1, 1.1) * H, R = s * (.035 + .06 * a) * (.8 + .4 * rand());
      const c = sctx;
      c.save();
      // A thin wet film around it.
      const film = c.createRadialGradient(cx, cy, R * .4, cx, cy, R * 2.4);
      film.addColorStop(0, `rgba(105,0,6,${.2 * soft})`); film.addColorStop(1, 'rgba(105,0,6,0)');
      c.fillStyle = film; c.beginPath(); c.arc(cx, cy, R * 2.4, 0, TAU); c.fill();
      // Tendrils first, so the body covers their roots.
      const arms = Math.round((3 + 4 * a) * (state.effects ? 1 : .6));
      for (let i = 0; i < arms; i++) {
        const ang = rand() * TAU, len = R * (.35 + 1.1 * rand() * Math.min(1.6, a));
        tendril(c, cx, cy, ang, R * .55, len, R * (.16 + .22 * rand()), (.7 + .2 * rand()) * soft);
      }
      // Body: one lumpy pool and a few smaller ones breaking its edge; dark and dense in the middle.
      const g = c.createRadialGradient(cx - R * .15, cy - R * .1, R * .05, cx, cy, R * 1.25);
      g.addColorStop(0, `rgba(42,0,3,${.92 * soft})`); g.addColorStop(.6, `rgba(78,0,5,${.88 * soft})`); g.addColorStop(1, `rgba(128,6,10,${.78 * soft})`);
      c.fillStyle = g; lump(c, cx, cy, R, .28, 1, .85 + .3 * rand()); c.fill();
      const lobes = 2 + Math.round(2 * a);
      for (let i = 0; i < lobes; i++) {
        const ang = rand() * TAU, d = R * (.55 + .35 * rand()), r = R * (.25 + .3 * rand());
        c.fillStyle = `rgba(${70 + rand() * 30 | 0},0,5,${.85 * soft})`;
        lump(c, cx + Math.cos(ang) * d, cy + Math.sin(ang) * d, r, .3, 1, 1); c.fill();
      }
      // Satellite droplets, most of them small, stretched outward.
      const drops = Math.round((8 + 18 * a) * (state.effects ? 1 : .5));
      for (let i = 0; i < drops; i++) {
        const ang = rand() * TAU, d = R * (1.1 + 2.3 * Math.pow(rand(), 1.4)), r = Math.max(.7, s * .0035 * (.4 + 2.4 * Math.pow(rand(), 3)));
        drop(c, cx + Math.cos(ang) * d, cy + Math.sin(ang) * d, r, ang, 1 + rand() * 1.2, (.55 + .35 * rand()) * soft);
      }
      // Wet sheen: one soft, stretched highlight on the upper left of the pool.
      c.globalCompositeOperation = 'lighter';
      const hx = cx - R * (.25 + .2 * rand()), hy = cy - R * (.3 + .15 * rand()), hr = R * (.22 + .12 * rand());
      c.translate(hx, hy); c.rotate(-.6 + rand() * .3); c.scale(1, .35);
      const h = c.createRadialGradient(0, 0, 0, 0, 0, hr);
      h.addColorStop(0, `rgba(255,140,130,${.13 * soft})`); h.addColorStop(1, 'rgba(255,140,130,0)');
      c.fillStyle = h; c.beginPath(); c.arc(0, 0, hr, 0, TAU); c.fill();
      c.restore();
      // It runs: a couple of drips from the bottom edge of the splat.
      const runs = Math.round(1 + 2 * a * rand());
      for (let i = 0; i < runs; i++) drip(cx + (rand() * 2 - 1) * R * .6, cy + R * (.3 + .3 * rand()), Math.max(1.2, R * (.05 + .05 * rand())));
      dirty = true;
    }
    // Fractured vision: jagged rays from (x, y) with branches and broken rings.
    function fracture(x, y, size) {
      state.cracks++;
      if (!cctx) return;
      const c = cctx, s = Math.min(W, H), k = clamp(num(size, 1), .3, 2), cx = clamp(num(x, .5), 0, 1) * W, cy = clamp(num(y, .5), 0, 1) * H;
      const rays = 7 + Math.round(5 * k), reach = s * (.25 + .3 * k);
      c.save(); c.lineCap = 'round'; c.lineJoin = 'round';
      // Polylines [x0, y0, x1, y1, ...]: jagged rays, the cracks branching off them, and broken rings.
      const lines = [];
      const walk = (x0, y0, dir, len, wiggle) => {
        let px = x0, py = y0;
        const pts = [px, py];
        for (let d = 0; d < len;) {
          const step = s * (.015 + .03 * rand()); d += step;
          const ang = dir + (rand() - .5) * wiggle;
          px += Math.cos(ang) * step; py += Math.sin(ang) * step; pts.push(px, py);
          if (wiggle > .3 && rand() < .16) lines.push(walk(px, py, dir + (rand() < .5 ? -1 : 1) * (.5 + rand() * .6), len * .3 * rand(), .3));
        }
        return pts;
      };
      for (let i = 0; i < rays; i++) lines.push(walk(cx, cy, i / rays * TAU + rand() * .4, reach * (.4 + .8 * rand()), .5));
      const rings = 1 + Math.round(k * 1.5);
      for (let r = 0; r < rings; r++) {
        const rr = reach * (.12 + .22 * r + .05 * rand()), n = 14, pts = [];
        const from = rand() * TAU, span = TAU * (.45 + .4 * rand());
        for (let i = 0; i <= n; i++) { const a = from + span * i / n, j = rr * (1 + (rand() - .5) * .18); pts.push(cx + Math.cos(a) * j, cy + Math.sin(a) * j); }
        lines.push(pts);
      }
      const stroke = (dx, dy, color, width) => {
        c.strokeStyle = color; c.lineWidth = width;
        for (const p of lines) {
          if (p.length < 4) continue;
          c.beginPath(); c.moveTo(p[0] + dx, p[1] + dy);
          for (let i = 2; i < p.length; i += 2) c.lineTo(p[i] + dx, p[i + 1] + dy);
          c.stroke();
        }
      };
      stroke(1.2, 1.2, 'rgba(0,0,0,.55)', Math.max(1.5, s * .004));
      stroke(0, 0, 'rgba(225,215,210,.42)', Math.max(1, s * .0022));
      // The impact point itself is crushed white.
      const g = c.createRadialGradient(cx, cy, 0, cx, cy, s * .05 * k);
      g.addColorStop(0, 'rgba(230,220,215,.35)'); g.addColorStop(1, 'rgba(230,220,215,0)');
      c.fillStyle = g; c.beginPath(); c.arc(cx, cy, s * .05 * k, 0, TAU); c.fill();
      c.restore(); dirty = true;
    }
    // A shovelful of grave dirt landing on the face.
    function dirt(x, y, amount) {
      state.dirt++;
      if (!sctx) return;
      const a = clamp(num(amount, 1), .2, 2.5), s = Math.min(W, H), cx = clamp(num(x, .5), 0, 1) * W, cy = clamp(num(y, .5), 0, 1) * H;
      const c = sctx, R = s * (.12 + .1 * a), clods = Math.round(30 + 45 * a);
      c.save();
      // Dust and smeared earth under the clods.
      const haze = c.createRadialGradient(cx, cy, R * .2, cx, cy, R * 1.9);
      haze.addColorStop(0, 'rgba(46,32,20,.62)'); haze.addColorStop(.6, 'rgba(40,28,18,.32)'); haze.addColorStop(1, 'rgba(40,28,18,0)');
      c.fillStyle = haze; c.beginPath(); c.arc(cx, cy, R * 1.9, 0, TAU); c.fill();
      // Clods: lumpy, brown, lit from above (the pit mouth), with a dark underside.
      for (let i = 0; i < clods; i++) {
        const ang = rand() * TAU, d = R * Math.pow(rand(), .7) * 1.5, r = s * (.005 + .028 * Math.pow(rand(), 2.4)) * (1 + a * .25);
        const px = cx + Math.cos(ang) * d, py = cy + Math.sin(ang) * d * .8, tone = rand(), wet = rand() < .3 ? .7 : 1;
        c.fillStyle = 'rgba(12,8,5,.85)'; lump(c, px + r * .12, py + r * .22, r, .35, 1, .8); c.fill();
        c.fillStyle = `rgba(${(36 + 28 * tone) * wet | 0},${(25 + 19 * tone) * wet | 0},${(16 + 12 * tone) * wet | 0},.97)`;
        lump(c, px, py, r, .35, 1, .8); c.fill();
        if (r > s * .008) { c.fillStyle = `rgba(${100 + 30 * tone | 0},${80 + 20 * tone | 0},${58 + 12 * tone | 0},.14)`; lump(c, px - r * .2, py - r * .3, r * .45, .3, 1, .6); c.fill(); }
      }
      // Grit.
      for (let i = 0, n = Math.round(160 * a); i < n; i++) {
        const ang = rand() * TAU, d = R * 1.8 * Math.pow(rand(), .8), g = 30 + rand() * 50 | 0;
        c.fillStyle = `rgba(${g + 12},${g + 4},${g - 6},${.5 + .4 * rand()})`;
        c.fillRect(cx + Math.cos(ang) * d, cy + Math.sin(ang) * d * .85, 1 + rand() * 2.2, 1 + rand() * 2.2);
      }
      c.restore(); dirty = true;
    }

    function update(dt, levels) {
      if (!state.active) return;
      dt = clamp(num(dt, 0), 0, .1);
      const L = levels || {};
      state.black = clamp(num(L.black, 0), 0, 1); state.red = clamp(num(L.red, 0), 0, 1); state.tunnel = clamp(num(L.tunnel, 0), 0, 1);
      state.flash = clamp(num(L.flash, 0), 0, 1.5); state.grave = clamp(num(L.grave, 0), 0, 2);
      if (!ctx || !ensure()) return;
      // Drips run down the stain layer, slowing as they thin out.
      for (const d of drips) {
        if (!d.on) continue;
        const y0 = d.y; d.y += d.v * dt; d.v *= Math.exp(-.7 * dt); d.life -= dt;
        sctx.strokeStyle = `rgba(92,0,5,${d.a})`; sctx.lineWidth = d.w; sctx.lineCap = 'round';
        sctx.beginPath(); sctx.moveTo(d.x, y0); sctx.lineTo(d.x + Math.sin(d.y * .05) * .4, d.y); sctx.stroke();
        if (d.life <= 0 || d.y > H + 4) d.on = false;
        dirty = true;
      }
      const c = ctx;
      c.clearRect(0, 0, W, H);
      c.globalAlpha = state.effects ? .96 : .7; c.drawImage(stain, 0, 0); c.globalAlpha = 1;
      for (const d of drips) if (d.on) { c.fillStyle = `rgba(120,0,8,${d.a})`; c.beginPath(); c.arc(d.x, d.y, d.w * .9, 0, TAU); c.fill(); }
      if (state.cracks) c.drawImage(crack, 0, 0);
      const diag = Math.hypot(W, H) * .5, mx = W / 2, my = H / 2;
      if (state.red > .01) { c.fillStyle = `rgba(90,0,0,${state.red * .22})`; c.fillRect(0, 0, W, H); }
      const flash = Math.min(1, state.flash) * (state.effects ? 1 : .5);
      if (flash > .01) {
        const g = c.createRadialGradient(mx, my, diag * .1, mx, my, diag);
        g.addColorStop(0, `rgba(150,0,0,${flash * .08})`); g.addColorStop(1, `rgba(120,0,0,${flash * .42})`);
        c.fillStyle = g; c.fillRect(0, 0, W, H);
      }
      if (state.tunnel > .01) {
        const inner = diag * (1 - .78 * state.tunnel);
        const g = c.createRadialGradient(mx, my, inner * .35, mx, my, Math.max(inner, diag * .3) * 1.12);
        g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(.7, `rgba(10,0,0,${.55 * state.tunnel})`); g.addColorStop(1, `rgba(0,0,0,${.96 * state.tunnel})`);
        c.fillStyle = g; c.fillRect(0, 0, W, H);
      }
      if (state.grave > .01 && mouth) {
        // Looking up out of a pit: earth walls frame a shrinking jagged mouth.
        const k = clamp(state.grave, 0, 2), open = clamp(1.08 - .42 * k, .2, 1), hw = W * .5 * open * 1.05, hh = H * .5 * open * .95;
        c.fillStyle = `rgba(13,9,6,${Math.min(.97, k)})`;
        c.beginPath(); c.rect(0, 0, W, H);
        const n = mouth.top.length;
        for (let i = 0; i <= n; i++) {
          const q = i % n, a = q / n * TAU, sx = Math.cos(a), sy = Math.sin(a);
          // A rounded rectangle, roughened.
          const m = Math.pow(Math.pow(Math.abs(sx), 4) + Math.pow(Math.abs(sy), 4), -.25), j = (Math.abs(sx) > Math.abs(sy) ? mouth.side[q] : mouth.top[q]);
          const px = mx + sx * m * hw * j, py = my + sy * m * hh * j;
          i ? c.lineTo(px, py) : c.moveTo(px, py);
        }
        c.closePath(); c.fill('evenodd');
        const g = c.createRadialGradient(mx, my, Math.min(hw, hh) * .5, mx, my, Math.max(hw, hh) * 1.05);
        g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(20,12,6,${.6 * Math.min(1, k)})`);
        c.fillStyle = g; c.fillRect(0, 0, W, H);
      }
      if (state.black > .002) { c.fillStyle = `rgba(0,0,0,${state.black})`; c.fillRect(0, 0, W, H); }
      dirty = false;
    }
    function stop() {
      state.active = false;
      for (const d of drips) d.on = false;
      if (canvas) { canvas.style.display = 'none'; if (ctx) ctx.clearRect(0, 0, W, H); }
    }
    function snapshot() {
      return { active: state.active, splats: state.splats, cracks: state.cracks, dirt: state.dirt, drips: drips.filter(d => d.on).length,
        black: state.black, red: state.red, tunnel: state.tunnel, flash: state.flash, grave: state.grave, size: [W, H], dirty };
    }
    return Object.freeze({ start, blood, crack: fracture, dirt, update, stop, snapshot });
  }
  return Object.freeze({ create });
});
