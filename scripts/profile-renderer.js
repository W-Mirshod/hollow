#!/usr/bin/env node
'use strict';

/* Controlled render-optimization A/B, NOT an original-version or hardware FPS
 * benchmark. The alternate engine exists only in Playwright route responses.
 * No game source, geometry, gameplay rules, live scores, or saved games are edited.
 *
 * node scripts/profile-renderer.js
 * node scripts/profile-renderer.js --frames 30 --rounds 1 --output artifacts/performance.json
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('@playwright/test');
const { createGameServer } = require('../server');

const ROOT = path.resolve(__dirname, '..');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const round = value => Math.round(value * 1000) / 1000;
const OPTIMIZED = 'optimized';
const DISABLED = 'render-optimizations-disabled';

function parseArgs(argv) {
  const opts = { frames: 30, warmup: 12, rounds: 2, seed: 44102, timeout: 180000, backend: 'webgpu',
    output: path.join(ROOT, 'artifacts/performance.json'), chrome: process.env.CHROME_PATH };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { opts.help = true; continue; }
    const key = { '--frames': 'frames', '--warmup': 'warmup', '--rounds': 'rounds', '--seed': 'seed',
      '--timeout': 'timeout', '--output': 'output', '--chrome': 'chrome', '--backend': 'backend' }[arg];
    if (!key || !argv[i + 1]) throw new Error(`Unknown or incomplete option: ${arg}`);
    const value = argv[++i]; opts[key] = ['output', 'chrome', 'backend'].includes(key) ? value : Number(value);
  }
  if (!['webgpu', 'webgl'].includes(opts.backend)) throw new Error('backend must be webgpu or webgl');
  for (const [key, min, max] of [['frames', 5, 500], ['warmup', 0, 300], ['rounds', 1, 8], ['seed', 1, 2147483647], ['timeout', 30000, 600000]]) {
    if (!Number.isInteger(opts[key]) || opts[key] < min || opts[key] > max) throw new Error(`${key} must be an integer in ${min}..${max}`);
  }
  opts.output = path.resolve(opts.output);
  return opts;
}

function replaceOnce(source, before, after, description) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`Refusing an unverified source override: ${description} matched ${count} times (expected 1).`);
  return source.replace(before, after);
}

function rollbackRendererOptimizations(input) {
  let source = input;
  const changes = [];
  // The TSL morph graph keeps its branches; out-of-range thresholds make every fragment take the blending path.
  source = replaceOnce(source, 'If(U.progress.greaterThan(.999),()=>{color.assign(texture(b));}).ElseIf(U.progress.lessThan(.001),',
    'If(U.progress.greaterThan(2),()=>{color.assign(texture(b));}).ElseIf(U.progress.lessThan(-1),', 'morph shader steady-state fast paths');
  changes.push({ optimization: 'Steady-state morph shader branch', replacements: 1,
    disabledBehavior: 'Always sample both surface maps and both transition-noise lookups; at progress=1 the resulting surface is still the final map.' });

  const matrixCount = (source.match(/\.matrixAutoUpdate=false\b/g) || []).length;
  if (matrixCount < 6) throw new Error('Static-matrix freeze markers changed; review this profiler before rerunning.');
  source = source.replace(/\.matrixAutoUpdate=false\b/g, '.matrixAutoUpdate=true');
  changes.push({ optimization: 'Static local-matrix freezing', replacements: matrixCount,
    disabledBehavior: 'Recompose unchanged local matrices on each normal scene update; retain the same transforms.' });

  source = replaceOnce(source, 'exterior.visible=false;', 'exterior.visible=true;', 'exterior culling');
  changes.push({ optimization: 'Interior exterior-group culling', replacements: 1,
    disabledBehavior: 'Submit the existing exterior group as well; opaque room surfaces still occlude it in the chosen view.' });

  source = replaceOnce(source,
    'r.group.visible=Math.hypot(r.group.position.x-camera.position.x,r.group.position.z-camera.position.z)<38;',
    'r.group.visible=true;', 'room-distance culling');
  changes.push({ optimization: 'Room-distance culling', replacements: 1,
    disabledBehavior: 'Keep all existing room groups visible and let normal frustum/depth processing handle them.' });

  source = replaceOnce(source, 'sun.visible=false;', 'sun.visible=true;', 'zero-intensity sun suppression');
  source = replaceOnce(source, 'chanLight.visible=pedLight.visible=false;', 'chanLight.visible=pedLight.visible=true;', 'zero-intensity hall light suppression');
  source = replaceOnce(source, "muzzleLight.visible=level!=='low';", 'muzzleLight.visible=true;', 'idle muzzle-light suppression');
  changes.push({ optimization: 'Zero-intensity light suppression', replacements: 4,
    disabledBehavior: 'Retain the zero-intensity sun, chandelier, pedestal, and idle muzzle light in renderer light processing. Active lighting and all shadow settings stay unchanged.' });

  return { source, changes };
}

// Common measurement instrumentation is present in BOTH routed engines. It does
// not alter the loop, clocks, geometry, movement, AI, state, or render scheduling.
const PROBE = `
window.__HollowRenderProfile=Object.freeze({
  settleProjection:()=>{camera.fov=72;camera.updateProjectionMatrix();},
  inspect:()=>{
    const seen=new Set(),maps=new Set();let nodes=0,meshNodes=0,frozenNodes=0,visibleMeshNodes=0,vertices=0,indices=0,hash=2166136261;
    const mix=array=>{const bytes=new Uint8Array(array.buffer,array.byteOffset,array.byteLength);for(let i=0;i<bytes.length;i++)hash=Math.imul(hash^bytes[i],16777619)>>>0;};
    const visibleLights=[];
    for(const world of [scene,fpScene]){
      world.traverse(o=>{
        nodes++;if(!o.matrixAutoUpdate)frozenNodes++;
        if(o.isMesh){
          meshNodes++;if(o.instanceMatrix)mix(o.instanceMatrix.array);if(o.instanceColor)mix(o.instanceColor.array);
          const geo=o.geometry;if(!seen.has(geo)){seen.add(geo);vertices+=geo.attributes.position?.count||0;indices+=geo.index?.count||0;
            for(const key of Object.keys(geo.attributes).sort())mix(geo.attributes[key].array);if(geo.index)mix(geo.index.array);}
          for(const mat of Array.isArray(o.material)?o.material:[o.material])for(const map of [mat.map,mat.normalMap,mat.roughnessMap,mat.userData?.transitionMap])if(map)maps.add(map);
        }
      });
      world.traverseVisible(o=>{if(o.isMesh)visibleMeshNodes++;if(o.isLight)visibleLights.push({type:o.type,intensity:o.intensity,color:o.color.getHex(),position:o.matrixWorld.elements.slice(12,15),castShadow:o.castShadow});});
    }
    const backend=renderer.backend,gl=backend.gl,ext=gl&&gl.getExtension('WEBGL_debug_renderer_info'),adapter=backend.device&&backend.device.adapterInfo;
    return {
      camera:{position:camera.position.toArray(),quaternion:camera.quaternion.toArray(),fov:camera.fov,aspect:camera.aspect},
      framebuffer:{width:renderer.domElement.width,height:renderer.domElement.height},
      inventory:{nodes,meshNodes,frozenNodes,visibleMeshNodes,geometryBuffers:seen.size,vertices,indices,geometryHash:hash.toString(16)},
      anisotropy:[...new Set([...maps].map(map=>map.anisotropy))].sort((a,b)=>a-b),
      visibleLights,exteriorVisible:exterior.visible,visibleRooms:specialRooms.filter(r=>r.group.visible).length,
      gpu:gl?{backend:window.HollowBackend,vendor:gl.getParameter(ext?ext.UNMASKED_VENDOR_WEBGL:gl.VENDOR),renderer:gl.getParameter(ext?ext.UNMASKED_RENDERER_WEBGL:gl.RENDERER),version:gl.getParameter(gl.VERSION),shadingLanguage:gl.getParameter(gl.SHADING_LANGUAGE_VERSION)}:
        {backend:window.HollowBackend,vendor:adapter?adapter.vendor:'',renderer:adapter?[adapter.architecture,adapter.description].filter(Boolean).join(' ')||adapter.vendor:'WebGPU adapter'}
    };
  }
});
`;

function addProbe(source) {
  const marker = 'window.HollowGame=Object.freeze({snapshot});';
  return replaceOnce(source, marker, marker + PROBE, 'common read-only renderer probe');
}

function percentile(values, quantile) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), index = (sorted.length - 1) * quantile;
  const low = Math.floor(index), high = Math.ceil(index);
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

function summarize(values) {
  return { samples: values.length, min: round(Math.min(...values)), median: round(percentile(values, 0.5)),
    p95: round(percentile(values, 0.95)), max: round(Math.max(...values)),
    mean: round(values.reduce((sum, value) => sum + value, 0) / values.length) };
}

function captureAssets() {
  const assets = new Map(), publicRoot = path.join(ROOT, 'public');
  const threeBuild = path.dirname(require.resolve('three/webgpu'));
  const html = fs.readFileSync(path.join(publicRoot, 'index.html'));
  assets.set('/index.html', html);
  // Discover local script/style/module-preload references, the import map's three builds and the classic
  // scripts that boot.mjs loads. Freeze these bytes for both variants even if the worktree changes mid-run.
  const text = html.toString('utf8');
  const references = [...text.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)=["']([^"']+)["']/gi)].map(match => match[1]);
  const importMap = text.match(/<script type="importmap">([\s\S]*?)<\/script>/);
  if (importMap) references.push(...Object.values(JSON.parse(importMap[1]).imports).filter(target => /\.m?js$/.test(target)));
  const boot = fs.readFileSync(path.join(publicRoot, 'boot.mjs'), 'utf8').match(/BOOT_ORDER\s*=\s*\[([^\]]*)\]/);
  if (!boot) throw new Error('boot.mjs no longer declares BOOT_ORDER; review this profiler before rerunning.');
  references.push(...[...boot[1].matchAll(/'([^']+)'/g)].map(match => match[1]));
  for (const reference of references) {
    const url = new URL(reference, 'http://hollow-profile.invalid/');
    if (url.origin !== 'http://hollow-profile.invalid' || !/\.(?:m?js|css)$/.test(url.pathname)) continue;
    const vendor = url.pathname.match(/^\/vendor\/three\/build\/(three\.(?:webgpu|tsl|core)\.js)$/);
    const file = vendor ? path.join(threeBuild, vendor[1]) : path.resolve(publicRoot, '.' + decodeURIComponent(url.pathname));
    if (!vendor && !file.startsWith(publicRoot + path.sep)) throw new Error('Refusing an asset reference outside public/.');
    assets.set(url.pathname, fs.readFileSync(file));
  }
  if (!assets.has('/game.js')) throw new Error('game.js was not discovered from boot.mjs; review this profiler before rerunning.');
  return assets;
}

async function sampleRun(browser, origin, source, assets, options, id, variant, imageDir) {
  const context = await browser.newContext({ viewport: { width: 640, height: 400 }, deviceScaleFactor: 1,
    reducedMotion: 'reduce', serviceWorkers: 'block' });
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(options.timeout);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  try {
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
      if (url.origin !== origin || !assets.has(pathname)) return route.continue();
      const body = pathname === '/game.js' ? source : assets.get(pathname);
      const contentType = /\.m?js$/.test(pathname) ? 'text/javascript; charset=utf-8' :
        pathname.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8';
      return route.fulfill({ status: 200, contentType, body });
    });
    await page.addInitScript(seed => {
      let value = seed >>> 0;
      Math.random = () => { value = (Math.imul(value, 1664525) + 1013904223) >>> 0; return value / 4294967296; };
      localStorage.setItem('hollow.uid', 'renderer_profile_user');
      localStorage.setItem('hollow.playerName', 'Render profile');
      localStorage.setItem('hollow.settings', JSON.stringify({ quality: 'low', motion: false, volume: 0, sensitivity: 1 }));
    }, options.seed);
    await page.goto(origin + '/?qa=1' + (options.backend === 'webgl' ? '&renderer=webgl' : ''), { waitUntil: 'domcontentloaded', timeout: options.timeout });
    await page.waitForFunction(() => !!window.HollowTest && !!window.__HollowRenderProfile, null, { timeout: options.timeout });
    await page.evaluate(seed => {
      // QA setup leaves the actual gameplay/render loop running. Never pause.
      HollowTest.build(seed); HollowTest.silence(); HollowTest.quality('low');
      HollowTest.pose({ x: 25.5, y: 0, z: 16.8, yaw: 0, pitch: 0.04 });
      HollowTest.torch(true); __HollowRenderProfile.settleProjection();
    }, options.seed);

    let timer;
    const measurement = await Promise.race([
      page.evaluate(async ({ warmup, frames }) => {
        const next = () => new Promise(resolve => requestAnimationFrame(resolve));
        for (let i = 0; i < warmup; i++) await next();
        const before = __HollowRenderProfile.inspect();
        let previous = await next(), prior = HollowGame.snapshot();
        const start = performance.now(), startFrame = prior.performance.frames;
        const intervals = [], calls = [], triangles = [], frameDeltas = [];
        const stable = JSON.stringify({ position: prior.position, yaw: prior.yaw, pitch: prior.pitch, weapon: prior.weapon,
          health: prior.health, fuses: prior.fuses, rooms: prior.rooms, doors: prior.doors, loot: prior.loot });
        for (let i = 0; i < frames; i++) {
          const timestamp = await next(), now = HollowGame.snapshot();
          if (now.state !== 'play' || document.hidden) throw new Error('Gameplay was paused, hidden, or left play during measurement.');
          if (now.performance.quality !== 'low' || now.performance.renderScale !== 0.8) throw new Error('Render quality changed during measurement.');
          if (now.enemies.some(enemy => !enemy.dead)) throw new Error('An active enemy changed the controlled scene.');
          const current = JSON.stringify({ position: now.position, yaw: now.yaw, pitch: now.pitch, weapon: now.weapon,
            health: now.health, fuses: now.fuses, rooms: now.rooms, doors: now.doors, loot: now.loot });
          if (current !== stable) throw new Error('Controlled camera or gameplay invariants changed.');
          const delta = now.performance.frames - prior.performance.frames;
          if (delta !== 1) throw new Error('Expected one actual game render per rAF sample, got ' + delta + '.');
          intervals.push(timestamp - previous); calls.push(now.performance.drawCalls); triangles.push(now.performance.triangles); frameDeltas.push(delta);
          previous = timestamp; prior = now;
        }
        return { intervalsMs: intervals, drawCalls: calls, triangles, frameDeltas,
          wallTimeMs: performance.now() - start, actualRenderedFrames: prior.performance.frames - startFrame,
          before, after: __HollowRenderProfile.inspect(), finalSnapshot: prior, invariants: JSON.parse(stable), maze: HollowTest.maze() };
      }, { warmup: options.warmup, frames: options.frames }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Measurement ${id} exceeded ${options.timeout}ms`)), options.timeout); })
    ]).finally(() => clearTimeout(timer));
    if (errors.length) throw new Error(`Browser errors in ${id}: ${errors.join('; ')}`);
    measurement.mazeHash = sha256(JSON.stringify(measurement.maze)); delete measurement.maze;
    measurement.gameplayHash = sha256(JSON.stringify(measurement.invariants));
    measurement.intervalSummaryMs = summarize(measurement.intervalsMs);
    measurement.drawCallSummary = summarize(measurement.drawCalls);
    measurement.triangleSummary = summarize(measurement.triangles);
    measurement.wallTimeMs = round(measurement.wallTimeMs);

    // Normal HTML HUD work remains in the measurement above. Omit it ONLY from
    // equivalence images, so elapsed/status text does not become a pixel delta.
    await page.addStyleTag({ content: 'body > :not(#game){visibility:hidden !important;} #game{visibility:visible !important;}' });
    const screenshot = path.join(imageDir, id + '.png');
    await page.screenshot({ path: screenshot, animations: 'disabled', timeout: options.timeout });
    return { id, variant, sourceSha256: sha256(source), screenshot, browserErrors: errors, ...measurement };
  } finally { await context.close(); }
}

async function imageDifference(browser, first, second) {
  const context = await browser.newContext(), page = await context.newPage();
  try {
    return await page.evaluate(async sources => {
      async function pixels(source) {
        const img = new Image(); img.src = source; await img.decode();
        const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(img, 0, 0);
        return { width: img.width, height: img.height, data: ctx.getImageData(0, 0, img.width, img.height).data };
      }
      const [a, b] = await Promise.all(sources.map(pixels));
      if (a.width !== b.width || a.height !== b.height) throw new Error('Equivalence images have different dimensions.');
      let sum = 0, max = 0, changed = 0, changedOver3 = 0;
      for (let i = 0; i < a.data.length; i += 4) {
        let pixelMax = 0;
        for (let j = 0; j < 3; j++) { const d = Math.abs(a.data[i + j] - b.data[i + j]); sum += d; pixelMax = Math.max(pixelMax, d); }
        max = Math.max(max, pixelMax); if (pixelMax) changed++; if (pixelMax > 3) changedOver3++;
      }
      const count = a.width * a.height;
      return { width: a.width, height: a.height, meanAbsoluteRgbError: sum / (count * 3), maxChannelError: max,
        differentPixelPercent: changed * 100 / count, pixelsOver3LevelsPercent: changedOver3 * 100 / count };
    }, [first, second].map(file => 'data:image/png;base64,' + fs.readFileSync(file).toString('base64')));
  } finally { await context.close(); }
}

function formatReport(report, output) {
  const a = report.aggregate[OPTIMIZED], b = report.aggregate[DISABLED], delta = report.comparison;
  const relative = file => path.relative(path.dirname(output), file).split(path.sep).join('/');
  return `# Controlled renderer A/B\n\n` +
    `This compares the captured current engine with a transient variant that disables only the rendering work-saving changes listed below. It is **not** a comparison with the original game and is **not** a hardware FPS claim.\n\n` +
    `Seed ${report.configuration.seed}; stationary play-state camera; 640 × 400 CSS viewport; ${report.runs[0].after.framebuffer.width} × ${report.runs[0].after.framebuffer.height} framebuffer; low quality; DPR 1; motion off; enemies hidden; normal HUD active during measurement.\n\n` +
    `Backend: ${report.environment.gpu.backend}. Adapter: ${report.environment.gpu.renderer}. Chromium ${report.environment.browserVersion}.\n\n` +
    `| Renderer | Samples | Median frame interval | p95 frame interval | Median draw calls | Median triangles |\n|---|---:|---:|---:|---:|---:|\n` +
    `| Current optimized | ${a.intervalsMs.samples} | ${a.intervalsMs.median} ms | ${a.intervalsMs.p95} ms | ${a.drawCalls.median} | ${a.triangles.median} |\n` +
    `| Render optimizations disabled | ${b.intervalsMs.samples} | ${b.intervalsMs.median} ms | ${b.intervalsMs.p95} ms | ${b.drawCalls.median} | ${b.triangles.median} |\n\n` +
    `Observed median interval reduction: ${delta.medianIntervalReductionPercent}%. Draw-call reduction: ${delta.drawCallReduction} (${delta.drawCallReductionPercent}%). Negative reductions mean the optimized case was slower/higher in this run.\n\n` +
    `Both variants retained identical geometry-buffer, maze, gameplay-invariant, active-light, camera, and filtering fingerprints. Screenshots differ by ${round(report.equivalence.images.meanAbsoluteRgbError)} mean RGB levels; ${round(report.equivalence.images.pixelsOver3LevelsPercent)}% of pixels differ by more than 3 channel levels. ${report.equivalence.images.pixelsOver3LevelsPercent <= 1 ? 'This supports visual equivalence for this camera.' : 'Pixel-level visual equivalence is not established; inspect the images before interpreting timing differences.'}\n\n` +
    report.runs.map(run => `- [${run.id}](${relative(run.screenshot)}): ${run.intervalSummaryMs.median} ms median / ${run.intervalSummaryMs.p95} ms p95; ${run.drawCallSummary.median} draws; ${run.actualRenderedFrames} verified renders.`).join('\n') + '\n\n' +
    `## Disabled rendering optimizations\n\n` + report.sourceOverrides.map(change => `- ${change.optimization}: ${change.disabledBehavior}`).join('\n') + '\n\n' +
    `## Limits\n\n` + report.limitations.map(limit => `- ${limit}`).join('\n') + '\n';
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write('Controlled renderer A/B (no game edits).\nOptions: --frames 30 --warmup 12 --rounds 2 --seed 44102 --timeout 180000 --backend webgpu|webgl --output artifacts/performance.json --chrome /path/to/chromium\n');
    return;
  }
  const assets = captureAssets(), capturedSource = assets.get('/game.js').toString('utf8');
  const rollback = rollbackRendererOptimizations(capturedSource);
  const sources = { [OPTIMIZED]: addProbe(capturedSource), [DISABLED]: addProbe(rollback.source) };
  const imageDir = path.join(path.dirname(options.output), path.basename(options.output, path.extname(options.output)) + '.screenshots');
  fs.mkdirSync(imageDir, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hollow-render-profile-'));
  let app, browser, cleanupPromise, interrupted = false;
  async function cleanup() {
    if (!cleanupPromise) cleanupPromise = (async () => {
      try { if (browser) await browser.close(); }
      finally {
        try { if (app) await app.close(); }
        finally {
          if (path.dirname(dataDir) !== path.resolve(os.tmpdir()) || !path.basename(dataDir).startsWith('hollow-render-profile-')) throw new Error('Refusing cleanup of an unverified temporary path.');
          fs.rmSync(dataDir, { recursive: true, force: true });
        }
      }
    })();
    return cleanupPromise;
  }
  const onSignal = () => { interrupted = true; process.exitCode = 130; cleanup().catch(error => process.stderr.write(error.message + '\n')); };
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal); process.once('SIGHUP', onSignal);
  try {
    app = createGameServer({ dataDir, scoreCooldownMs: 0 });
    const address = await app.listen(0, '127.0.0.1'), origin = `http://127.0.0.1:${address.port}`;
    if (interrupted) throw new Error('Renderer profile interrupted before browser launch.');
    const executablePath = options.chrome || (fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined);
    // Own signal cleanup: Playwright's default SIGINT handler exits Node before
    // our temporary server/data directory can be closed and removed.
    browser = await chromium.launch({ executablePath, headless: true, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
      args: ['--no-sandbox', '--enable-unsafe-swiftshader',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
      // Headless WebGPU (SwiftShader) presents only with Vulkan compositing; see playwright.config.js.
      '--enable-unsafe-webgpu', '--use-angle=vulkan', '--use-vulkan=swiftshader', '--enable-features=Vulkan,CDPScreenshotNewSurface'] });
    if (interrupted) { await browser.close(); throw new Error('Renderer profile interrupted during browser launch.'); }
    const order = [];
    for (let roundIndex = 0; roundIndex < options.rounds; roundIndex++) order.push(...(roundIndex % 2 ? [DISABLED, OPTIMIZED] : [OPTIMIZED, DISABLED]));
    const runs = [];
    process.stdout.write(`Isolated renderer A/B: ${order.length} runs, ${options.frames} rAF intervals each, source ${sha256(capturedSource).slice(0, 12)}\n`);
    for (let i = 0; i < order.length; i++) {
      const variant = order[i], id = `${i + 1}-${variant}`;
      process.stdout.write(`[${i + 1}/${order.length}] ${variant}: loading, then ${options.warmup} warmup frames...\n`);
      const result = await sampleRun(browser, origin, sources[variant], assets, options, id, variant, imageDir);
      runs.push(result);
      process.stdout.write(`[${i + 1}/${order.length}] ${result.intervalSummaryMs.median} ms median; ${result.intervalSummaryMs.p95} ms p95; ${result.drawCallSummary.median} draws; ${result.actualRenderedFrames} actual renders\n`);
    }
    const first = runs[0];
    const signature = run => JSON.stringify({ camera: run.after.camera, framebuffer: run.after.framebuffer,
      geometry: run.after.inventory.geometryHash, maze: run.mazeHash, gameplay: run.gameplayHash,
      anisotropy: run.after.anisotropy, activeLights: run.after.visibleLights.filter(light => light.intensity > 0) });
    for (const run of runs) if (signature(run) !== signature(first)) throw new Error(`Equivalence invariant failed for ${run.id}; no performance comparison will be claimed.`);
    const images = await imageDifference(browser, runs.find(run => run.variant === OPTIMIZED).screenshot, runs.find(run => run.variant === DISABLED).screenshot);
    const aggregate = {};
    for (const variant of [OPTIMIZED, DISABLED]) {
      const selected = runs.filter(run => run.variant === variant);
      aggregate[variant] = { intervalsMs: summarize(selected.flatMap(run => run.intervalsMs)),
        drawCalls: summarize(selected.flatMap(run => run.drawCalls)), triangles: summarize(selected.flatMap(run => run.triangles)) };
    }
    const a = aggregate[OPTIMIZED], b = aggregate[DISABLED];
    const report = {
      schemaVersion: 1, generatedAt: new Date().toISOString(),
      kind: 'controlled-render-optimization-ab-not-original-version-or-hardware-benchmark',
      configuration: { seed: options.seed, backend: options.backend, viewport: { width: 640, height: 400 }, deviceScaleFactor: 1, quality: 'low',
        motion: false, framesPerRun: options.frames, warmupFrames: options.warmup, runOrder: order,
        position: { x: 25.5, y: 0, z: 16.8 }, yaw: 0, pitch: 0.04, fov: 72, state: 'play', enemies: 'hidden with existing QA control' },
      sourceAssets: Object.fromEntries([...assets].map(([file, body]) => [file, { sha256: sha256(body), bytes: body.length }])),
      sourceOverrides: rollback.changes, commonProbeSha256: sha256(PROBE),
      environment: { browserVersion: browser.version(), executablePath: executablePath || 'Playwright-managed Chromium',
        gpu: first.after.gpu, platform: process.platform, architecture: process.arch, cpu: os.cpus()[0]?.model,
        isolation: 'Temporary local server and score directory; fresh browser context each run; captured static assets routed identically.' },
      equivalence: { geometryBuffers: true, maze: true, gameplayInvariants: true, actualCamera: true, activeLighting: true, textureFiltering: true, images },
      aggregate, comparison: { medianIntervalReductionPercent: round((b.intervalsMs.median - a.intervalsMs.median) / b.intervalsMs.median * 100),
        p95IntervalReductionPercent: round((b.intervalsMs.p95 - a.intervalsMs.p95) / b.intervalsMs.p95 * 100),
        drawCallReduction: b.drawCalls.median - a.drawCalls.median,
        drawCallReductionPercent: round((b.drawCalls.median - a.drawCalls.median) / b.drawCalls.median * 100) },
      limitations: [
        'The alternate build is a deliberately less-efficient version of the captured current engine, not the original game or a separate historical release.',
        'Only one stationary interior camera and one maze seed are sampled. This does not cover traversal, combat, networking, mobile thermals, or input latency.',
        'Frame intervals are native requestAnimationFrame wall-time intervals with one verified game render per interval. They are not the smoothed HUD counter or the capped simulation delta.',
        'Driver/software-renderer behavior, shared host load, browser scheduling, JIT and shader caches affect this local measurement. No target-device FPS claim is supported.',
        'Viewport is 640×400 CSS pixels; the unchanged low-quality 0.8 render scale produces a 512×320 framebuffer on DPR 1.',
        'Anisotropic filtering, active practical-light budgets, shadow quality, geometry and batching remain identical. Raising those would change visual quality and confound this comparison.',
        'Game state remains play throughout. Menu/pause idle-frame skipping is not exercised. HTML overlays are omitted only from screenshots, after timing is finished.',
        'The benchmark uses existing QA controls to remove enemy motion and make a fixed scene; it is rendering evidence, not a full-game performance certification.'
      ], runs
    };
    fs.writeFileSync(options.output, JSON.stringify(report, null, 2) + '\n');
    const markdown = options.output.replace(/\.[^.]+$/, '') + '.md';
    fs.writeFileSync(markdown, formatReport(report, options.output));
    process.stdout.write(`Report: ${options.output}\nSummary: ${markdown}\nPixel MAE: ${round(images.meanAbsoluteRgbError)}; pixels >3 levels: ${round(images.pixelsOver3LevelsPercent)}%\n`);
  } finally {
    await cleanup(); process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); process.off('SIGHUP', onSignal);
  }
}

module.exports = { rollbackRendererOptimizations, percentile, summarize, parseArgs };
if (require.main === module) main().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = process.exitCode || 1; });
