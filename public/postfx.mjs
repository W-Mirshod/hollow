// The Hollow — cinematic post-processing for THREE.WebGPURenderer (WebGPU or its WebGL2 fallback), built on TSL.
// HollowPostFX.create({ renderer, scene, fpScene, camera, quality }) -> fx. Call fx.render(dt) instead of renderer.render().
// low = direct render (no pipeline); medium = HDR pass + half-res bloom + filmic grade; high = + full bloom, lens dirt, FXAA.
import { RenderPipeline, DataTexture, RGBAFormat, UnsignedByteType, LinearFilter, ClampToEdgeWrapping, Vector2, Vector3,
  AgXToneMapping, NeutralToneMapping, NodeUpdateType } from 'three/webgpu';
import { Fn, If, Loop, PassNode, float, vec2, vec3, vec4, uvec2, uniform, uv, texture, screenCoordinate, screenSize, mix, smoothstep,
  clamp, max, min, dot, length, fract, sin, floor, exp, mod, step, hash, acesFilmicToneMapping, agxToneMapping,
  neutralToneMapping, sRGBTransferOETF } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';

// bloomScale = bloom resolution vs. the drawing buffer, capped so the bloom chain never exceeds bloomMax pixels wide.
const TIERS = {
  medium: { bloomScale: 0.5, bloomMax: 960, aa: false, dirt: false },
  high: { bloomScale: 0.5, bloomMax: 1920, aa: true, dirt: true }
};
const TONEMAPS = { aces: acesFilmicToneMapping, agx: agxToneMapping, neutral: neutralToneMapping };
const LUMA = vec3(0.2126, 0.7152, 0.0722);

// World pass that also draws the first-person viewmodel into the same HDR target after clearing only depth:
// exactly the direct path (render world, clearDepth, render fpScene) but feeding one texture into the post chain.
class ViewmodelPassNode extends PassNode {
  static get type() { return 'ViewmodelPassNode'; }
  constructor(scene, fpScene, camera, options) { super(PassNode.COLOR, scene, camera, options); this.fpScene = fpScene || null; }
  updateBefore(frame) {
    super.updateBefore(frame);
    if (!this.fpScene) return;
    const r = frame.renderer, rt = r.getRenderTarget(), mrt = r.getMRT();
    const ac = r.autoClear, acc = r.autoClearColor, acd = r.autoClearDepth, acs = r.autoClearStencil;
    r.setRenderTarget(this.renderTarget); r.setMRT(null);
    r.autoClear = true; r.autoClearColor = false; r.autoClearDepth = true; r.autoClearStencil = true;
    r.render(this.fpScene, this.camera);
    r.setRenderTarget(rt); r.setMRT(mrt);
    r.autoClear = ac; r.autoClearColor = acc; r.autoClearDepth = acd; r.autoClearStencil = acs;
  }
}

// three refreshes passes once per animation frame (its own rAF tick); refresh them once per fx.render() call instead,
// so a second render within one frame (tests, on-demand redraws) never composites a stale world, bloom or AA input.
function oncePerRender(node, ctx) {
  const update = node.updateBefore.bind(node);
  let seen = -1;
  node.updateBeforeType = NodeUpdateType.OBJECT;
  node.updateBefore = frame => { if (seen !== ctx.serial) { seen = ctx.serial; update(frame); } };
  return node;
}

// Soft-knee bright pass on the peak channel (saturated red exit signs still bloom; lit walls below threshold do not).
const softKneeHighPass = Fn(({ input, threshold, smoothWidth }) => {
  const c = input.rgb, peak = max(c.r, max(c.g, c.b));
  const soft = clamp(peak.sub(threshold).add(smoothWidth), 0, smoothWidth.mul(2));
  const w = max(soft.mul(soft).div(smoothWidth.mul(4).add(1e-4)), peak.sub(threshold)).div(max(peak, 1e-4));
  return vec4(c.mul(w), 1);
});

// Procedural lens grime (no external assets): soft smudges, a few bokeh rings and finger smears.
function makeDirtTexture() {
  const w = 256, h = 144, acc = new Float32Array(w * h);
  let s = 90217; const r = () => (s = s * 16807 % 2147483647) / 2147483647;
  const splat = (cx, cy, rad, a, ring) => {
    for (let y = Math.max(0, cy - rad | 0); y <= Math.min(h - 1, cy + rad + 1 | 0); y++)
      for (let x = Math.max(0, cx - rad | 0); x <= Math.min(w - 1, cx + rad + 1 | 0); x++) {
        const d = Math.hypot(x - cx, y - cy) / rad; if (d >= 1) continue;
        const v = (1 - d * d) ** 2, e = (d - 0.82) * 9; acc[y * w + x] += a * (ring ? v * 0.35 + Math.exp(-e * e) * 0.65 : v);
      }
  };
  for (let i = 0; i < 70; i++) splat(r() * w, r() * h, 3 + r() * r() * 26, 0.06 + r() * 0.3, r() < 0.25);
  for (let i = 0; i < 6; i++) {
    const x = r() * w, y = r() * h, a = r() * Math.PI, len = 18 + r() * 50;
    for (let k = 0; k < len; k += 1.5) splat(x + Math.cos(a) * k, y + Math.sin(a) * k + Math.sin(k * 0.15) * 3, 2.5 + r() * 2, 0.035, false);
  }
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { const v = Math.min(1, acc[i]) * 255; data[i * 4] = v; data[i * 4 + 1] = v * 0.94; data[i * 4 + 2] = v * 0.86; data[i * 4 + 3] = 255; }
  const tex = new DataTexture(data, w, h, RGBAFormat, UnsignedByteType);
  tex.magFilter = tex.minFilter = LinearFilter; tex.wrapS = tex.wrapT = ClampToEdgeWrapping; tex.generateMipmaps = false; tex.needsUpdate = true;
  return tex;
}

function buildChain(ctx, tierName) {
  const tier = ctx.tiers[tierName], { renderer, scene, fpScene, camera, U, I } = ctx;
  const c01 = n => clamp(n, 0, 1), one = float(1);
  // effects = 0 removes flashes, pulses, flicker and grain (game "effects" preference); motion = 0 removes tearing/shake/zoom.
  const fx = I.effects, mo = I.motion;
  const danger = c01(U.danger).mul(mix(float(0.5), one, fx)), damage = c01(U.damage).mul(mix(float(0.35), one, fx));
  const surge = c01(U.surge), blackout = c01(U.blackout), slow = c01(U.slowmo);
  const kill = c01(U.killFlash).mul(fx), flash = c01(U.flash).mul(fx), health = c01(U.health);
  const exposure = I.baseExposure.mul(clamp(U.exposure, 0, 8)).mul(flash.mul(0.5).add(1)).mul(kill.mul(0.3).add(1)).mul(mix(one, float(0.045), blackout));

  const scenePass = oncePerRender(new ViewmodelPassNode(scene, fpScene, camera, { samples: 0 }), ctx);
  const sceneTex = scenePass.getTextureNode('output');

  const bloomNode = bloom(vec4(min(sceneTex.rgb.mul(exposure), vec3(16)), 1), I.bloomStrength.mul(kill.mul(0.6).add(flash.mul(0.4)).add(1)), I.bloomRadius, I.bloomThreshold);
  oncePerRender(bloomNode, ctx);
  bloomNode.highPassFn = softKneeHighPass; bloomNode.smoothWidth = I.bloomKnee; bloomNode.setResolutionScale(tier.bloomScale);
  [[1, 1, 1], [1, 0.98, 0.95], [1.03, 0.95, 0.88], [1.06, 0.92, 0.8], [1.1, 0.9, 0.74]].forEach((c, i) => bloomNode.bloomTintColors[i].set(...c));
  const bloomTex = bloomNode.getTextureNode();
  const dirtTex = tier.dirt ? ctx.dirt() : null;
  const toneMap = TONEMAPS[ctx.toneMapping] || acesFilmicToneMapping;

  const graded = Fn(() => {
    const p0 = uv(), t = U.time, aspect = screenSize.x.div(screenSize.y), tick = mod(floor(t.mul(24)), 4096);
    // surge: horizontal band tearing + shake (motion-gated); slow-mo: slight zoom
    const p = p0.toVar(), band = floor(p0.y.mul(46)).mul(13).add(tick.mul(71));
    const tear = step(0.8, hash(band.toUint())).mul(hash(band.add(5).toUint()).sub(0.5)).mul(0.04);
    p.x.addAssign(tear.add(sin(t.mul(71)).mul(0.0025)).mul(surge).mul(mo));
    p.assign(p.sub(0.5).mul(slow.mul(mo).mul(-0.035).add(1)).add(0.5));
    // radial chromatic aberration, zero at the centre, strongest in the corners
    const d = p.sub(0.5), dn = d.mul(vec2(aspect, 1)), r2 = dot(dn, dn).div(aspect.mul(aspect).add(1).mul(0.25));
    const ca = I.chromatic.add(c01(U.aberration).mul(0.022)).add(danger.mul(0.005)).add(damage.mul(0.016)).add(surge.mul(0.01)).add(slow.mul(0.005)).min(0.03);
    const off = d.mul(r2.mul(ca).mul(2));
    const col = vec3(sceneTex.sample(p.sub(off)).r, sceneTex.sample(p).g, sceneTex.sample(p.add(off)).b).toVar();
    If(slow.greaterThan(0.004), () => {
      const acc = vec3(0).toVar();
      const reach = slow.mul(mix(float(0.004), float(0.011), mo));
      Loop(6, ({ i }) => { acc.addAssign(sceneTex.sample(p.sub(d.mul(float(i).add(1).mul(reach)))).rgb); });
      col.assign(mix(col, acc.div(6), slow.mul(0.65)));
    });
    const bl = bloomTex.sample(p).rgb;
    let hdr = col.mul(exposure).add(bl);
    if (dirtTex) hdr = hdr.add(texture(dirtTex, p).rgb.mul(bl).mul(I.lensDirt));
    // filmic tone map, then grade in display space
    const s = sRGBTransferOETF(toneMap(hdr, one)).toVar();
    s.mulAssign(mix(I.shadowTint, I.highlightTint, smoothstep(0.06, 0.78, dot(s, LUMA))));
    s.assign(clamp(s, 0, 1));
    s.assign(mix(s, s.mul(s).mul(float(3).sub(s.mul(2))), I.contrast.add(kill.mul(0.25)).add(danger.mul(0.1))));
    const injury = one.sub(health).pow(1.15), critical = one.sub(smoothstep(0.1, 0.45, health));
    const sat = clamp(U.saturation, 0, 2).mul(one.sub(damage.mul(0.6))).mul(one.sub(critical.mul(0.6))).mul(one.sub(slow.mul(0.35)))
      .mul(one.sub(danger.mul(0.15))).mul(one.sub(blackout.mul(0.5))).add(kill.mul(0.18));
    s.assign(mix(vec3(dot(s, LUMA)), s, sat));
    s.assign(mix(s, s.mul(vec3(0.72, 0.97, 1.3)).add(vec3(0, 0.02, 0.055)), surge.mul(0.75)));
    s.assign(mix(s, s.mul(vec3(1.12, 1.02, 0.86)).add(vec3(0.04, 0.02, 0)), kill.mul(0.8)));
    s.assign(mix(s, vec3(1, 0.95, 0.86), flash.mul(0.14)));
    // screen-edge treatments: vignette, danger breathing frame, heartbeat health frame, damage pulse
    const rad = length(p0.sub(0.5).mul(vec2(aspect, 1))).div(length(vec2(aspect, 1).mul(0.5)));
    s.mulAssign(one.sub(smoothstep(0.3, 1.15, rad).mul(c01(U.vignette)).mul(0.85)));
    s.mulAssign(one.sub(smoothstep(0.2, 1.0, rad).mul(danger).mul(0.62).mul(sin(t.mul(2.6)).mul(0.15).mul(fx).add(0.85))));
    const ph = fract(t.mul(critical.mul(0.6).add(1.05))), bump = x => exp(x.mul(x).negate());
    const beat = bump(ph.mul(16)).add(bump(ph.sub(1).mul(16))).add(bump(ph.sub(0.3).mul(16)).mul(0.6));
    const hurt = smoothstep(mix(float(0.66), float(0.3), injury), 1.1, rad).mul(injury.mul(0.8).add(beat.mul(critical).mul(fx).mul(0.3))).min(0.92);
    s.assign(mix(s, s.mul(vec3(0.45, 0.04, 0.05)).add(vec3(0.13, 0, 0.012)), hurt));
    const hit = damage.mul(damage.sqrt());
    s.assign(mix(s, s.mul(vec3(1.06, 0.9, 0.88)), hit.mul(0.6)));
    s.assign(mix(s, s.mul(vec3(0.5, 0.08, 0.07)).add(vec3(0.24, 0, 0.012)), smoothstep(0.32, 1.12, rad).mul(hit).mul(0.8)));
    s.mulAssign(mix(vec3(1), vec3(0.75, 0.82, 1), blackout));
    // surge scanlines + low-amplitude flicker (photosensitive-safe)
    const scan = sin(screenCoordinate.y.mul(1.7).add(t.mul(36))).mul(0.5).add(0.5);
    s.mulAssign(one.sub(surge.mul(fx).mul(scan.mul(0.12).add(hash(tick.add(1).toUint()).mul(0.08)))));
    return s;
  })();

  const finish = color => Fn(() => {
    const s = vec3(color).toVar(), cell = uvec2(floor(screenCoordinate.div(I.grainScale)));
    const seed = cell.x.mul(1973).add(cell.y.mul(9277)).add(mod(floor(U.time.mul(24)), 4096).toUint().mul(26699));
    const n = hash(seed).add(hash(seed.add(104729))).sub(1);
    const amt = c01(U.grain).add(danger.mul(0.2)).mul(fx).mul(0.11).mul(one.sub(dot(s, LUMA).mul(0.65)));
    s.addAssign(n.mul(amt).add(hash(seed.add(7919)).sub(0.5).div(255)));
    return vec4(s, 1);
  })();

  let aaNode = null, output;
  if (tier.aa) { aaNode = fxaa(vec4(graded, 1)); oncePerRender(aaNode.textureNode, ctx); output = finish(aaNode.rgb); }
  else output = finish(graded);
  const pipeline = new RenderPipeline(renderer, output);
  pipeline.outputColorTransform = false;
  return {
    tier, pipeline, scenePass, bloomNode, aaNode,
    passes: 2 + 12 + (aaNode ? 1 : 0) + 1,
    dispose() {
      pipeline.dispose(); scenePass.dispose(); bloomNode.dispose();
      if (aaNode && aaNode.textureNode && aaNode.textureNode.dispose) aaNode.textureNode.dispose();
    }
  };
}

function create(opts = {}) {
  const { renderer, scene, camera } = opts, fpScene = opts.fpScene || null;
  if (!renderer || !scene || !camera) throw new Error('HollowPostFX.create needs { renderer, scene, camera }');
  const U = { time: uniform(0), danger: uniform(0), damage: uniform(0), health: uniform(1), flash: uniform(0), exposure: uniform(1),
    saturation: uniform(1), aberration: uniform(0), grain: uniform(0.35), vignette: uniform(0.5), blackout: uniform(0), surge: uniform(0),
    killFlash: uniform(0), slowmo: uniform(0) };
  // Unspecified effects/motion follow the OS reduced-motion setting, like the game's own preference defaults.
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const flag = v => (v === undefined ? !reduced : v !== false) ? 1 : 0;
  const I = { baseExposure: uniform(1), effects: uniform(flag(opts.effects)), motion: uniform(flag(opts.motion)),
    grainScale: uniform(1), bloomStrength: uniform(0.55), bloomRadius: uniform(0.35), bloomThreshold: uniform(1), bloomKnee: uniform(0.5),
    lensDirt: uniform(2), contrast: uniform(0.22), chromatic: uniform(0.0025),
    shadowTint: uniform(new Vector3(0.92, 0.98, 1.08)), highlightTint: uniform(new Vector3(1.08, 1.0, 0.86)) };
  let dirtTex = null, chain = null, quality = 'low', disposed = false, lastTime = 0, failure = null;
  const tiers = {};
  for (const k of Object.keys(TIERS)) tiers[k] = Object.assign({}, TIERS[k], opts.tiers && opts.tiers[k]);
  // Tone curve follows the renderer's (so low and pipeline tiers match) unless overridden; ACES is the default look.
  const rendererCurve = () => renderer.toneMapping === AgXToneMapping ? 'agx' : renderer.toneMapping === NeutralToneMapping ? 'neutral' : 'aces';
  const ctx = { renderer, scene, fpScene, camera, U, I, tiers, serial: 0, toneMapping: TONEMAPS[opts.toneMapping] ? opts.toneMapping : rendererCurve(), dirt: () => dirtTex || (dirtTex = makeDirtTexture()) };
  const size = new Vector2();
  const backend = () => renderer.backend && renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl2';
  const normalize = level => level === 'low' || level === 'medium' || level === 'high' ? level : level === 'auto' ? 'high' : 'medium';

  // Same result as "clear, render world, clearDepth, render fpScene" but with render-pass clears: half the output passes,
  // and explicit clear() calls proved unreliable on WebGPU when rendering through an output render target.
  function direct() {
    const ac = renderer.autoClear, acc = renderer.autoClearColor, acd = renderer.autoClearDepth;
    renderer.autoClear = true; renderer.autoClearColor = true; renderer.autoClearDepth = true;
    renderer.render(scene, camera);
    if (fpScene) { renderer.autoClearColor = false; renderer.render(fpScene, camera); }
    renderer.autoClear = ac; renderer.autoClearColor = acc; renderer.autoClearDepth = acd;
  }
  function teardown() {
    try { if (chain) chain.dispose(); } catch (e) { /* lost device: nothing left to free */ }
    chain = null;
    if (dirtTex) { dirtTex.dispose(); dirtTex = null; }
  }
  function rebuild() {
    teardown();
    if (disposed || quality === 'low') return;
    try { chain = buildChain(ctx, quality); failure = null; }
    catch (e) { failure = String(e && e.message || e); chain = null; console.warn('HollowPostFX: pipeline unavailable, using direct rendering.', e); }
  }
  const fx = {
    uniforms: U,
    tuning: { bloomStrength: I.bloomStrength, bloomRadius: I.bloomRadius, bloomThreshold: I.bloomThreshold, bloomKnee: I.bloomKnee,
      lensDirt: I.lensDirt, contrast: I.contrast, chromatic: I.chromatic, shadowTint: I.shadowTint, highlightTint: I.highlightTint },
    get enabled() { return !!chain; },
    get quality() { return quality; },
    render(dt) {
      dt = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.25) : 1 / 60;
      if (U.time.value === lastTime) U.time.value += dt;
      lastTime = U.time.value;
      if (!chain) return direct();
      renderer.getDrawingBufferSize(size);
      if (size.x < 2 || size.y < 2) return;
      I.baseExposure.value = Number.isFinite(renderer.toneMappingExposure) ? renderer.toneMappingExposure : 1;
      I.grainScale.value = Math.max(1, Math.round(renderer.getPixelRatio() * 1.5) / 2);
      chain.bloomNode.setResolutionScale(Math.min(chain.tier.bloomScale, chain.tier.bloomMax / size.x));
      ctx.serial++;
      try { chain.pipeline.render(); }
      catch (e) { failure = String(e && e.message || e); console.warn('HollowPostFX: pipeline failed, falling back to direct rendering.', e); teardown(); direct(); }
    },
    setQuality(level) {
      const next = normalize(level);
      if (next === quality && (chain || next === 'low')) return fx.snapshot();
      quality = next; rebuild(); return fx.snapshot();
    },
    setSize() {},
    setOptions(o = {}) {
      if ('effects' in o) I.effects.value = o.effects === false ? 0 : 1;
      if ('motion' in o) I.motion.value = o.motion === false ? 0 : 1;
      if (o.toneMapping && TONEMAPS[o.toneMapping] && o.toneMapping !== ctx.toneMapping) { ctx.toneMapping = o.toneMapping; rebuild(); }
      return fx.snapshot();
    },
    snapshot() {
      return { quality, enabled: !!chain, bloom: !!chain, passes: chain ? chain.passes : 2, backend: backend(),
        aa: chain && chain.tier.aa ? 'fxaa' : 'none', bloomScale: chain ? +chain.bloomNode.getResolutionScale().toFixed(3) : 0, lensDirt: !!(chain && chain.tier.dirt),
        toneMapping: chain ? ctx.toneMapping : 'renderer', effects: I.effects.value > 0, motion: I.motion.value > 0, failure };
    },
    dispose() { teardown(); disposed = true; }
  };
  quality = normalize(opts.quality); rebuild();
  return fx;
}

window.HollowPostFX = Object.freeze({ create });
