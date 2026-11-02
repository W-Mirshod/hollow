// The Hollow: module boot. Starts WebGPURenderer (WebGL2 fallback), then the game scripts in order.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';

// Classic scripts share globals and run in this order; `.mjs` entries are imported as ES modules in place.
// game.js stays last: it requires every global above it.
const BOOT_ORDER = ['systems.js', 'locomotion.js', 'camerafx.js', 'horror.js', 'audio.js', 'navigation.js', 'visuals.js', 'controls.js', 'chaos.js', 'hudfx.js', 'game.js'];

const query = new URLSearchParams(location.search);
const IS_TOUCH = matchMedia('(pointer:coarse)').matches || navigator.maxTouchPoints > 1;

// A fallback (software) WebGPU adapter rasterises on the CPU, where 4x MSAA costs about a third of every frame.
async function softwareAdapter() {
  try {
    const adapter = navigator.gpu && await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
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

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = false;
    script.addEventListener('load', () => resolve(), { once: true });
    script.addEventListener('error', () => reject(new Error('A local game asset could not be loaded: ' + src)), { once: true });
    document.body.append(script);
  });
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
  const renderer = await createRenderer();
  window.HollowRenderer = renderer;
  window.HollowBackend = renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl2';
  window.HollowCreateRenderer = createRenderer;
  // Optional effect modules: a failure only disables that layer, never the game.
  try { await import('./postfx.mjs'); } catch (e) { console.warn('[The Hollow] post-processing disabled:', e); }
  try { await import('./atmosphere.mjs'); } catch (e) { console.warn('[The Hollow] atmosphere disabled:', e); }
  for (const entry of BOOT_ORDER) await (entry.endsWith('.mjs') ? import('./' + entry) : loadScript(entry));
} catch (error) {
  startupFailed(error);
}
