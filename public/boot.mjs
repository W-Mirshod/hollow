// The Hollow: module boot. Starts WebGPURenderer (WebGL2 fallback), then the game scripts in order.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';

// Classic scripts share globals and run in this order; `.mjs` entries are imported as ES modules in place.
// game.js stays last: it requires every global above it.
const BOOT_ORDER = ['systems.js', 'locomotion.js', 'camerafx.js', 'monster-anim.js', 'horror.js', 'audio.js', 'player-audio.js', 'weapon-audio.js', 'navigation.js', 'visuals.js', 'controls.js', 'chaos.js', 'hudfx.js', 'killcam.js', 'killfx.js', 'kill-audio.js', 'hitzones.js', 'gore.js', 'hurtfx.js', 'game.js'];

const query = new URLSearchParams(location.search);
const IS_TOUCH = matchMedia('(pointer:coarse)').matches || navigator.maxTouchPoints > 1;
// The server stamps boot.mjs with ?v=<version> (see index.html); everything loaded from here carries the same stamp,
// which the server marks cache-forever, so a returning player's browser starts the game without asking for files.
const VERSION = new URL(import.meta.url).search;

// A fallback (software) WebGPU adapter rasterises on the CPU, where 4x MSAA costs about a third of every frame.
// prepaint.js may already have asked for the adapter while the engine downloaded; that answer is used once.
async function softwareAdapter() {
  try {
    const early = window.HollowAdapter;
    window.HollowAdapter = null;
    const adapter = navigator.gpu && await (early || navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }));
    const info = adapter && adapter.info;
    return !!adapter && (info && 'isFallbackAdapter' in info ? info.isFallbackAdapter : adapter.isFallbackAdapter) === true;
  } catch { return false; }
}

// Also used by game.js to rebuild the renderer after a lost GPU device or WebGL context.
async function createRenderer({ forceWebGL = false } = {}) {
  forceWebGL = forceWebGL || query.get('renderer') === 'webgl';
  const renderer = new THREE.WebGPURenderer({
    canvas: document.getElementById('game'), antialias: !IS_TOUCH && (forceWebGL || !(await softwareAdapter())), alpha: false,
    powerPreference: 'high-performance', forceWebGL
  });
  await renderer.init();
  return renderer;
}

// Scripts are preloaded by index.html; async=false runs them in insertion order as soon as each one has arrived.
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src + VERSION;
    script.async = false;
    script.addEventListener('load', () => resolve(), { once: true });
    script.addEventListener('error', () => reject(new Error('A local game asset could not be loaded: ' + src)), { once: true });
    document.body.append(script);
  });
}

// Surfaces painted by prepaint.js's workers join visuals.js's cache as they arrive, so game.js does not paint them on
// this thread. game.js starts once the ones it reads at start-up are in; the ward shell and decor keep arriving.
async function adoptPrepainted() {
  const prepaint = window.HollowPrepaint, visuals = window.HollowVisuals;
  if (!prepaint || !visuals || typeof visuals.adoptSurface !== 'function') return;
  prepaint.take(item => {
    try { visuals.adoptSurface(item.kind, item.painted); } catch (e) { console.warn('[The Hollow] painted surface skipped:', item.kind, e); }
  });
  let timer;
  await Promise.race([prepaint.ready, new Promise(resolve => { timer = setTimeout(resolve, 20000); })]);
  clearTimeout(timer);
}

function startupFailed(error) {
  console.error('[The Hollow] Startup failed:', error);
  document.querySelectorAll('.screen').forEach(screen => screen.hidden = true);
  const screen = document.createElement('section'); screen.className = 'screen form'; screen.setAttribute('role', 'alert');
  const panel = document.createElement('div'); panel.className = 'panel';
  const title = document.createElement('h1'); title.className = 'title'; title.textContent = 'A little more light.';
  const message = document.createElement('p'); message.className = 'lede'; message.textContent = 'The 3D engine could not start. Enable hardware acceleration, close other busy tabs, or try a current browser.';
  const retry = document.createElement('button'); retry.className = 'link'; retry.textContent = 'Try loading again'; retry.addEventListener('click', () => location.reload());
  panel.append(title, message, retry); screen.append(panel); document.body.append(screen);
}

try {
  window.THREE = THREE;
  window.TSL = TSL;
  // Everything before game.js needs only THREE: it runs while the GPU device is being set up.
  const scripts = Promise.all(BOOT_ORDER.slice(0, -1).map(entry => entry.endsWith('.mjs') ? import('./' + entry + VERSION) : loadScript(entry)));
  scripts.catch(() => {});
  // Optional effect modules: a failure only disables that layer, never the game.
  const effects = Promise.allSettled([import('./postfx.mjs' + VERSION), import('./atmosphere.mjs' + VERSION)]);
  const renderer = await createRenderer();
  performance.mark('hollow:renderer');
  window.HollowRenderer = renderer;
  window.HollowBackend = renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl2';
  window.HollowCreateRenderer = createRenderer;
  const [post, atmosphere] = await effects;
  if (post.status === 'rejected') console.warn('[The Hollow] post-processing disabled:', post.reason);
  if (atmosphere.status === 'rejected') console.warn('[The Hollow] atmosphere disabled:', atmosphere.reason);
  await scripts;
  performance.mark('hollow:scripts');
  await adoptPrepainted();
  performance.mark('hollow:game');
  await loadScript(BOOT_ORDER[BOOT_ORDER.length - 1]);
} catch (error) {
  startupFailed(error);
}
