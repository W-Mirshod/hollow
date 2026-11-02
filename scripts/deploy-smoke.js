#!/usr/bin/env node
'use strict';

// Exercise the shipped UI, never the localhost-only QA mutation hooks. Browser
// contexts are ephemeral and HTTP writes are blocked before they can be sent.
const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const { chromium, expect, request } = require('@playwright/test');

const HELP = 'Usage: node scripts/deploy-smoke.js --base-url https://horror.wmirshod.uz [--webgpu]\n' +
  'The URL may also be positional or set with HOLLOW_SMOKE_URL.\n' +
  'Headless Chrome has no WebGPU adapter by default, so the game is expected to fall back to WebGL2.\n' +
  '--webgpu (or HOLLOW_SMOKE_WEBGPU=1) launches Chrome with WebGPU (SwiftShader) and requires the WebGPU backend.\n' +
  'CHROME_PATH optionally selects Chrome/Chromium. Uses read-only HTTP checks and transient co-op rooms.\n';
const TIMEOUT = 45000;
const POLL = { timeout: TIMEOUT, intervals: [50, 100, 200, 400] };
const BROWSER_ARGS = ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'];
// Headless WebGPU presents its canvas only with Vulkan compositing. Chrome keeps the last --enable-features
// switch, so Playwright's screenshot feature is repeated.
const WEBGPU_ARGS = ['--enable-unsafe-webgpu', '--use-angle=vulkan', '--use-vulkan=swiftshader',
  '--enable-features=Vulkan' + (process.env.PLAYWRIGHT_LEGACY_SCREENSHOT ? '' : ',CDPScreenshotNewSurface')];
// Chrome reports uncaught WebGPU validation errors and GL errors as console warnings, not errors.
const GPU_VALIDATION = /GL_INVALID_(?:OPERATION|VALUE|ENUM|FRAMEBUFFER)| - While (?:calling|validating|encoding|finishing|creating)|\[Invalid [A-Z]/;
// Three.js ships as ES module builds behind the page's import map; any node addon is served the same way.
const VENDOR = ['vendor/three/build/three.webgpu.js', 'vendor/three/build/three.tsl.js', 'vendor/three/build/three.core.js',
  'vendor/three/addons/tsl/display/BloomNode.js'];

function parseArgs(args) {
  let value, webgpu = /^(1|true|yes)$/i.test(process.env.HOLLOW_SMOKE_WEBGPU || '');
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') return null;
    if (arg === '--webgpu') webgpu = true;
    else if (arg === '--base-url') {
      assert(args[index + 1] && !args[index + 1].startsWith('-'), '--base-url needs a URL');
      value = args[++index];
    } else if (arg.startsWith('--base-url=')) value = arg.slice('--base-url='.length);
    else if (!arg.startsWith('-') && !value) value = arg;
    else throw new Error('Unknown argument: ' + arg);
  }
  value = value || process.env.HOLLOW_SMOKE_URL;
  assert(value, 'Provide --base-url or HOLLOW_SMOKE_URL; there is no implicit production target');
  const url = new URL(value);
  assert(['http:', 'https:'].includes(url.protocol), 'The endpoint must use HTTP or HTTPS');
  assert(!url.username && !url.password, 'Credentials must not be included in the endpoint');
  assert(!url.search && !url.hash, 'Use a base URL without a query or fragment; QA mode is never used');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return { baseURL: url.href, webgpu };
}

function executablePath() {
  if (process.env.CHROME_PATH) {
    assert(existsSync(process.env.CHROME_PATH), 'CHROME_PATH does not exist');
    return process.env.CHROME_PATH;
  }
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
    .find(candidate => existsSync(candidate));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) { process.stdout.write(HELP); return; }
  const { baseURL, webgpu } = options;

  const report = {
    target: baseURL,
    startedAt: new Date().toISOString(),
    mode: 'headless UI smoke; not a device FPS benchmark',
    // Without the WebGPU flag headless Chrome has no adapter: the WebGL2 fallback is the expected path.
    renderer: { webgpuFlag: webgpu, expectedBackend: webgpu ? 'webgpu' : 'webgl2', observed: {} },
    gates: []
  };
  const started = Date.now();
  const contexts = new Set();
  const diagnostics = [];
  let browser, http, phase;

  async function gate(name, check) {
    const before = Date.now();
    phase = name;
    process.stderr.write('[deploy-smoke] ' + name + '\n');
    try {
      const details = await check();
      report.gates.push({ name, passed: true, durationMs: Date.now() - before, ...details });
      process.stderr.write('[deploy-smoke] PASS ' + name + '\n');
      return true;
    } catch (error) {
      report.gates.push({ name, phase, passed: false, durationMs: Date.now() - before,
        error: String(error.message || error).replace(/\u001b\[[0-9;]*m/g, '').slice(0, 2200) });
      process.stderr.write('[deploy-smoke] FAIL ' + name + ' (' + phase + ')\n');
      return false;
    }
  }

  async function closeContext(context) {
    for (const entry of diagnostics) if (entry.context === context) entry.closing = true;
    await context.close();
    contexts.delete(context);
  }

  async function newPlayer(label, options = {}) {
    const context = await browser.newContext({
      viewport: { width: 1000, height: 650 }, deviceScaleFactor: 1,
      reducedMotion: 'reduce', serviceWorkers: 'block', ...options
    });
    contexts.add(context);
    context.setDefaultTimeout(TIMEOUT);
    context.setDefaultNavigationTimeout(TIMEOUT);
    const entry = { label, context, errors: [], blockedWrites: [], sockets: [], closing: false };
    diagnostics.push(entry);
    await context.route('**/*', async route => {
      const req = route.request();
      if (!['GET', 'HEAD'].includes(req.method())) {
        entry.blockedWrites.push(req.method() + ' ' + new URL(req.url()).pathname);
        await route.abort('blockedbyclient');
      } else await route.continue();
    });
    await context.addInitScript(name => {
      localStorage.setItem('hollow.playerName', name);
      localStorage.setItem('hollow.settings', JSON.stringify({ quality: 'low', motion: false, sensitivity: 1, volume: 0 }));
    }, label.slice(0, 18));
    const page = await context.newPage();
    page.on('pageerror', error => { if (!entry.closing) entry.errors.push(error.message); });
    page.on('console', message => {
      if (!entry.closing && (message.type() === 'error' || GPU_VALIDATION.test(message.text()))) entry.errors.push(message.text());
    });
    page.on('crash', () => entry.errors.push('Browser page crashed'));
    page.on('websocket', socket => {
      const observed = { url: socket.url(), sent: 0, received: 0, errors: [] };
      entry.sockets.push(observed);
      socket.on('framesent', () => observed.sent++);
      socket.on('framereceived', () => observed.received++);
      socket.on('socketerror', error => { if (!entry.closing) observed.errors.push(String(error)); });
    });
    const response = await page.goto(baseURL, { waitUntil: 'load' });
    assert.equal(response.status(), 200, label + ': game page must return 200');
    await page.waitForFunction(() => !!window.HollowGame, null, { timeout: TIMEOUT });
    assert.equal(await page.evaluate(() => typeof window.HollowTest), 'undefined', 'QA mutation hooks must be absent');
    await expect(page.locator('#menu')).toBeVisible({ timeout: TIMEOUT });
    const backend = await page.evaluate(() => ({ global: window.HollowBackend, snapshot: window.HollowGame.snapshot().performance.backend }));
    report.renderer.observed[label] = backend.global;
    assert(['webgpu', 'webgl2'].includes(backend.global) && backend.snapshot === backend.global, label + ': unexpected renderer backend ' + JSON.stringify(backend));
    if (webgpu) assert.equal(backend.global, 'webgpu', label + ': --webgpu must run the WebGPU backend, not the WebGL2 fallback');
    return { context, page, entry };
  }

  // Composited pixels prove the canvas is presented (a broken swap chain or lost context leaves it flat).
  async function presented(page) {
    const hide = await page.addStyleTag({ content: 'body > :not(#game){visibility:hidden !important}' });
    let png;
    try { png = await page.locator('#game').screenshot({ timeout: TIMEOUT }); }
    finally { await hide.evaluate(tag => tag.remove()); }
    return page.evaluate(async source => {
      const image = new Image(); image.src = source; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let sum = 0, squares = 0, count = 0;
      for (let i = 0; i < data.length; i += 16) { const luma = data[i] * .2126 + data[i + 1] * .7152 + data[i + 2] * .0722; sum += luma; squares += luma * luma; count++; }
      const mean = sum / count;
      return { mean: Math.round(mean * 10) / 10, deviation: Math.round(Math.sqrt(Math.max(0, squares / count - mean * mean)) * 10) / 10 };
    }, 'data:image/png;base64,' + png.toString('base64'));
  }

  const snapshot = page => page.evaluate(() => window.HollowGame.snapshot());
  async function stateIs(page, value) {
    await expect.poll(async () => (await snapshot(page)).state, POLL).toBe(value);
  }
  async function enter(page, touch = false) {
    await page.locator('#startDarkBtn')[touch ? 'tap' : 'click']();
    await stateIs(page, 'play');
    await expect(page.locator('#hud')).toBeVisible();
    await expect.poll(async () => (await snapshot(page)).performance.frames, POLL).toBeGreaterThan(1);
    const current = await snapshot(page);
    assert.equal(current.rooms.length, 10, 'Ten rooms must be present');
    assert.equal(current.enemies.length, 8, 'Solo must have eight monsters');
    assert.equal(new Set(current.enemies.map(enemy => enemy.kind)).size, 4, 'Four monster types must be present');
    assert(current.enemies.some(enemy => enemy.kind === 'warden' && enemy.hp >= 20), 'The armored Warden must be present');
    assert(current.performance.textures > 0 && current.performance.drawCalls > 0, 'The 3D scene must render');
    const frame = await presented(page);
    assert(frame.deviation > 6, 'The ' + current.performance.backend + ' canvas must present a rendered frame: ' + JSON.stringify(frame));
    assert((await page.locator('#controlsHint').textContent()).trim(), 'Bottom instructions must be visible');
    await expect(page.locator('#controlsHint')).toBeVisible();
    current.presentedFrame = frame;
    return current;
  }

  try {
    http = await request.newContext({ baseURL, timeout: 15000 });
    const assetsPassed = await gate('health and local assets', async () => {
      const health = await http.get(new URL('health', baseURL).href);
      assert.equal(health.status(), 200, '/health must return 200');
      assert.equal((await health.text()).trim(), 'ok');
      const types = { '.js': /javascript/i, '.mjs': /javascript/i, '.css': /text\/css/i, '.woff2': /font\/woff2/i };
      const fetchAsset = async asset => {
        const response = await http.get(new URL(asset, baseURL).href, { headers: { 'Cache-Control': 'no-cache' } });
        assert.equal(response.status(), 200, (asset || '/') + ' must return 200');
        const contentType = response.headers()['content-type'] || '';
        assert((types[(asset.match(/\.[a-z0-9]+$/) || [''])[0]] || /text\/html/i).test(contentType), (asset || '/') + ': unexpected content type ' + contentType);
        const body = await response.body();
        assert(body.length > 100, (asset || '/') + ' must not be empty');
        return body.toString('utf8');
      };
      // index.html maps three/webgpu and three/tsl onto the vendor builds, loads the classic page scripts
      // (menu, bridge) and then starts the module boot.
      const html = await fetchAsset('');
      assert(/<script type="importmap">/.test(html) && html.includes('vendor/three/build/three.webgpu.js') && html.includes('vendor/three/build/three.tsl.js'), 'index.html must carry the three import map');
      assert(/<script type="module" src="boot\.mjs">/.test(html), 'index.html must start boot.mjs');
      const pageScripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(match => match[1]);
      assert(pageScripts.includes('bridge.js'), 'index.html must load bridge.js');
      const preloads = [...html.matchAll(/<link rel="preload" href="([^"]+)"/g)].map(match => match[1]);
      // boot.mjs loads the game scripts in order; every listed script must ship.
      const boot = await fetchAsset('boot.mjs');
      const order = boot.match(/BOOT_ORDER\s*=\s*\[([^\]]*)\]/);
      assert(order, 'boot.mjs must declare BOOT_ORDER');
      const scripts = [...order[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
      for (const required of ['systems.js', 'horror.js', 'audio.js', 'navigation.js', 'visuals.js', 'controls.js', 'game.js']) assert(scripts.includes(required), 'boot.mjs must load ' + required);
      assert.equal(scripts[scripts.length - 1], 'game.js', 'game.js must boot last');
      const paths = [...new Set(['styles.css', ...preloads, ...pageScripts, ...VENDOR, ...scripts])];
      await Promise.all(paths.map(fetchAsset));
      const scores = await http.get(new URL('api/scores', baseURL).href);
      assert.equal(scores.status(), 200, 'The scoreboard must remain readable');
      assert(Array.isArray(await scores.json()), 'The scoreboard must return an array');
      return { assetCount: paths.length + 2, pageScripts, bootOrder: scripts, vendor: VENDOR, scoreboard: 'GET only' };
    });
    if (!assetsPassed) return;
    const launched = await gate('browser launch', async () => {
      browser = await chromium.launch({ headless: true, executablePath: executablePath(),
        args: [...BROWSER_ARGS, ...(webgpu ? WEBGPU_ARGS : [])] });
      return { engine: 'Chromium', version: browser.version(), webgpuFlag: webgpu };
    });
    if (!launched) return;

    await gate('desktop play and settings', async () => {
      const { context, page } = await newPlayer('Deployment desktop');
      try {
        phase = 'desktop startup';
        const initial = await enter(page);
        await page.waitForFunction(() => document.pointerLockElement === document.getElementById('game'), null, { timeout: TIMEOUT });
        phase = 'desktop movement and jump';
        await page.keyboard.down('w');
        try {
          await expect.poll(async () => { const current = await snapshot(page); return Math.hypot(current.position.x - initial.position.x, current.position.z - initial.position.z); }, POLL).toBeGreaterThan(0.2);
        } finally { await page.keyboard.up('w'); }
        await page.keyboard.down('Space');
        try { await expect.poll(async () => (await snapshot(page)).position.y, POLL).toBeGreaterThan(0.1); }
        finally { await page.keyboard.up('Space'); }
        await expect.poll(async () => (await snapshot(page)).onGround, POLL).toBe(true);
        phase = 'desktop weapons, firing and reload';
        await page.keyboard.press('2');
        await expect.poll(async () => (await snapshot(page)).weapon, POLL).toBe('pistol');
        const loaded = await snapshot(page);
        await page.mouse.down();
        try { await expect.poll(async () => (await snapshot(page)).mag, POLL).toBeLessThan(loaded.mag); }
        finally { await page.mouse.up(); }
        await page.keyboard.press('r');
        await expect.poll(async () => (await snapshot(page)).mag, POLL).toBe(loaded.mag);
        await page.keyboard.press('3');
        await expect.poll(async () => (await snapshot(page)).weapon, POLL).toBe('shotgun');
        phase = 'desktop initial pause';
        await page.keyboard.press('Escape');
        await stateIs(page, 'pause');
        await expect(page.locator('#pause')).toBeVisible();
        phase = 'desktop quality settings';
        const beforeQuality = (await snapshot(page)).performance.frames;
        await page.locator('#settingsQuality').selectOption('high');
        await expect.poll(async () => (await snapshot(page)).performance.frames, POLL).toBeGreaterThan(beforeQuality);
        assert.equal((await snapshot(page)).performance.quality, 'high');
        await page.locator('#settingsQuality').selectOption('low');
        phase = 'desktop resume and second pause';
        await page.locator('#resumeBtn').click();
        await stateIs(page, 'play');
        // State changes synchronously, but mouse capture is asynchronous. Do
        // not inject Escape into the still-finishing Resume click.
        await page.waitForFunction(() => document.pointerLockElement === document.getElementById('game'), null, { timeout: TIMEOUT });
        await page.keyboard.press('Escape');
        await stateIs(page, 'pause');
        await page.locator('#pauseMenuBtn').click();
        await expect(page.locator('#menu')).toBeVisible();
        phase = 'desktop page reload';
        await page.reload({ waitUntil: 'load' });
        await page.waitForFunction(() => !!window.HollowGame, null, { timeout: TIMEOUT });
        await expect(page.locator('#menu')).toBeVisible();
        assert.equal((await snapshot(page)).performance.quality, 'low');
        return { movement: true, jump: true, weapons: ['rifle', 'pistol', 'shotgun'], fireAndReload: true, pauseResume: true, qualitySwitch: true, reload: true };
      } finally { await closeContext(context); }
    });

    await gate('phone real touch and responsive layout', async () => {
      const { context, page } = await newPlayer('Deployment phone', { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
      try {
        phase = 'phone portrait startup';
        const initial = await enter(page, true);
        await expect(page.locator('#touchControls')).toBeVisible();
        const center = async selector => { const rect = await page.locator(selector).boundingBox(); assert(rect, selector + ' must have bounds'); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; };
        async function checkBounds() {
          // Controls update on the next render frame after Resume/rotation.
          await expect(page.locator('.touch-button:visible')).toHaveCount(12, { timeout: TIMEOUT });
          const layout = await page.locator('.touch-button:visible').evaluateAll(buttons => ({ width: innerWidth, height: innerHeight, buttons: buttons.map(button => { const r = button.getBoundingClientRect(); return { action: button.dataset.action, x: r.x, y: r.y, right: r.right, bottom: r.bottom }; }) }));
          assert.equal(layout.buttons.length, 12, 'All twelve touch actions must be available');
          for (const rect of layout.buttons) assert(rect.x >= -1 && rect.y >= -1 && rect.right <= layout.width + 1 && rect.bottom <= layout.height + 1, rect.action + ' must fit the phone viewport');
        }
        phase = 'phone portrait layout';
        await checkBounds();
        const stick = await center('#touchMove'), fire = await center('.touch-fire');
        const look = await page.evaluate(() => {
          for (const ry of [.45, .4, .5]) for (const rx of [.65, .6, .55]) {
            const point = { x: innerWidth * rx, y: innerHeight * ry };
            if (document.elementFromPoint(point.x, point.y)?.closest('#touchLook')) return point;
          }
          return null;
        });
        assert(look, 'The phone must expose an unobstructed look zone');
        const cdp = await context.newCDPSession(page);
        const point = (id, x, y) => ({ id, x, y, radiusX: 4, radiusY: 4, force: 1 });
        phase = 'phone simultaneous move, look and fire';
        try {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(1, stick.x, stick.y), point(2, look.x, look.y), point(3, fire.x, fire.y)] });
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(1, stick.x, stick.y - 35), point(2, look.x + 26, look.y - 12), point(3, fire.x, fire.y)] });
          await expect.poll(async () => (await snapshot(page)).input.touchY, POLL).toBeGreaterThan(0.5);
          await expect.poll(async () => (await snapshot(page)).mag, POLL).toBeLessThan(initial.mag);
          await expect.poll(async () => (await snapshot(page)).pitch, POLL).toBeGreaterThan(initial.pitch + 0.02);
          await expect.poll(async () => { const current = await snapshot(page); return Math.hypot(current.position.x - initial.position.x, current.position.z - initial.position.z); }, POLL).toBeGreaterThan(0.1);
        } finally {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          await cdp.detach();
        }
        const released = await snapshot(page);
        assert.equal(released.input.mouseDown, false, 'Releasing fire must stop shooting');
        assert.equal(released.input.touchY, 0, 'Releasing the joystick must stop input');
        phase = 'phone pause and rotate';
        await page.locator('.touch-pause').tap();
        await stateIs(page, 'pause');
        await expect(page.locator('#pause')).toBeVisible();
        await page.setViewportSize({ width: 844, height: 390 });
        phase = 'phone landscape resume and layout';
        await page.locator('#resumeBtn').tap();
        await stateIs(page, 'play');
        await checkBounds();
        await page.locator('.touch-pause').tap();
        await stateIs(page, 'pause');
        return { portrait: '390x844', landscape: '844x390', simultaneousMoveLookFire: true, releasedInput: true, pauseResume: true };
      } finally { await closeContext(context); }
    });

    await gate('two-browser live co-op', async () => {
      // One browser process, two isolated contexts and two real WebSocket peers.
      const host = await newPlayer('Deployment host');
      let guest;
      try {
        guest = await newPlayer('Deployment guest');
        await host.page.locator('#coopBtn').click();
        await host.page.locator('#coopCreate').click();
        await expect(host.page.locator('#coopLobby')).toBeVisible();
        const code = (await host.page.locator('#coopCode').textContent()).trim();
        assert(/^[a-z0-9]{4,6}$/.test(code), 'Host must receive a valid fresh room code');
        await guest.page.locator('#coopBtn').click();
        await guest.page.locator('#coopCodeIn').fill(code);
        await guest.page.locator('#coopJoinForm button').click();
        await expect(host.page.locator('#coopStart')).toBeEnabled();
        await expect.poll(async () => (await snapshot(guest.page)).network.partner, POLL).toBe(true);
        await host.page.locator('#coopStart').click();
        await stateIs(guest.page, 'play');
        await expect.poll(async () => {
          const [a, b] = await Promise.all([snapshot(host.page), snapshot(guest.page)]);
          return a.network.inGame && b.network.inGame && a.network.partner && b.network.partner &&
            a.network.role === 'host' && b.network.role === 'guest' && a.seed > 0 && a.seed === b.seed &&
            a.enemies.length === 12 && b.enemies.length === 12 && a.enemies.every((enemy, index) => {
              const remote = b.enemies[index];
              return enemy.kind === remote.kind && enemy.dead === remote.dead && enemy.hp === remote.hp && Math.hypot(enemy.x - remote.x, enemy.z - remote.z) < 2.5;
            });
        }, POLL).toBe(true);
        // Normal guest keyboard input must reach the host, even if it is paused
        // by losing pointer lock when the guest takes control.
        await guest.page.locator('#game').click({ position: { x: 500, y: 325 } });
        await guest.page.keyboard.down('c');
        try { await expect.poll(async () => (await snapshot(host.page)).network.partnerCrouching, POLL).toBe(true); }
        finally { await guest.page.keyboard.up('c'); }
        await expect.poll(async () => (await snapshot(host.page)).network.partnerCrouching, POLL).toBe(false);
        for (const player of [host, guest]) {
          assert(player.entry.sockets.some(socket => socket.sent > 0 && socket.received > 0 && new URL(socket.url).pathname.endsWith('/ws')), player.entry.label + ' must send and receive WebSocket frames');
          assert.deepEqual(player.entry.sockets.flatMap(socket => socket.errors), [], 'WebSockets must remain error-free');
        }
        await closeContext(guest.context);
        guest = null;
        await expect.poll(async () => (await snapshot(host.page)).network.partner, POLL).toBe(false);
        return { isolatedPeers: 2, sharedSeed: true, synchronizedMonsters: 12, guestPresence: true, guestInputSync: true, disconnectObserved: true };
      } finally {
        if (guest) await closeContext(guest.context);
        await closeContext(host.context);
      }
    });

    await gate('browser errors and write protection', async () => {
      const errors = diagnostics.flatMap(entry => entry.errors.map(error => entry.label + ': ' + error));
      const blocked = diagnostics.flatMap(entry => entry.blockedWrites.map(write => entry.label + ': ' + write));
      assert.deepEqual(errors, [], 'There must be no page, console, shader, WebGL or WebGPU validation errors');
      assert.deepEqual(blocked, [], 'Gameplay smoke must not attempt any HTTP writes, including scores');
      return { pages: diagnostics.length, pageOrShaderErrors: 0, scoreboardWrites: 0, qaHooksUsed: false, backends: report.renderer.observed };
    });
  } finally {
    for (const context of contexts) {
      try { await closeContext(context); }
      catch (error) { report.gates.push({ name: 'context cleanup', passed: false, error: String(error.message || error) }); }
    }
    if (browser) await browser.close();
    if (http) await http.dispose();
    report.passed = report.gates.length > 0 && report.gates.every(result => result.passed);
    report.durationMs = Date.now() - started;
    report.finishedAt = new Date().toISOString();
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    if (!report.passed) process.exitCode = 1;
  }
}

main().catch(error => {
  process.stderr.write('[deploy-smoke] ' + (error.message || error) + '\n');
  process.exitCode = 1;
});
