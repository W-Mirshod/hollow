/* The Hollow: paints the ward's procedural surfaces on the player's spare CPU cores while the engine downloads.
 * boot.mjs hands the pixels to visuals.js as they arrive and starts game.js once the ones it reads at start-up are in
 * (ready). The ward shell comes next, into placeholders game.js has already built its materials on; the rest are for
 * the ward the menu builds afterwards (finished). A surface that is missing (no workers, an error, another quality
 * tier) is painted by visuals.js on the page as before. */
(function () {
  'use strict';
  // The GPU adapter can take a moment to come up the first time: ask once the menu has painted, while three.js is
  // still downloading. boot.mjs uses the answer for its software-adapter check.
  if (navigator.gpu && typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => setTimeout(() => {
      if (window.HollowAdapter === undefined) window.HollowAdapter = navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null);
    }, 0));
  }
  if (typeof Worker !== 'function') return;

  // The quality game.js will start with (see qualityLevel and autoStart there); only the texture sizes depend on it.
  function startingQuality() {
    let settings = {}, rung = NaN;
    try { settings = JSON.parse(localStorage.getItem('hollow.settings') || '{}') || {}; } catch (e) {}
    if (['low', 'medium', 'high'].includes(settings.quality)) return settings.quality;
    try { rung = parseInt(localStorage.getItem('hollow.autoRung'), 10); } catch (e) {}
    const tiers = ['high', 'high', 'medium', 'medium', 'medium', 'low', 'low', 'low', 'low'];
    const top = matchMedia('(pointer:coarse)').matches || navigator.maxTouchPoints > 1 ? 5 : 0;
    return Number.isFinite(rung) && rung > top + 1 ? tiers[Math.min(tiers.length, rung) - 1] : tiers[top];
  }

  // What game.js reads while it starts (gun finishes, survivor and creature skin and cloth, the ward's wear layer), then
  // the ward shell it takes as placeholders (see surface() in visuals.js). Ward decals and decor materials follow.
  const STARTUP = ['ward-macro', 'gun-metal', 'gun-polymer', 'gun-wood', 'gun-rubber', 'gun-fabric', 'material-skin', 'material-fabric'];
  const SHELL = ['ward-wall', 'ward-floor', 'ward-ceiling'];

  const script = document.currentScript;
  const version = script && script.src ? new URL(script.src).search : '';
  const quality = startingQuality();
  const workers = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
  const queue = [], takers = [], waiting = new Set(STARTUP);
  // finished: every worker has painted what the ward uses (it says `settled`, or ends); the surfaces only the floors
  // above ground use (visuals.js LATE_SURFACES) are painted after that and never hold anything up.
  let running = workers, finished = false, settle;
  const ready = new Promise(resolve => { settle = resolve; });
  const arrived = kind => { if (waiting.delete(kind) && !waiting.size) settle(); };
  for (let index = 0; index < workers; index++) {
    let worker = null, kinds = [], ended = false, settled = false;
    const settledWorker = () => {
      if (settled) return;
      settled = true;
      if (--running === 0) {
        finished = true;
        try { performance.mark('hollow:prepainted'); } catch (e) {}
        settle();
      }
    };
    const end = () => {
      if (ended) return;
      ended = true;
      if (worker) worker.terminate();
      // Whatever this worker did not deliver is painted on the page when asked for.
      kinds.forEach(arrived);
      settledWorker();
    };
    try { worker = new Worker('texture-worker.js' + version); } catch (e) { end(); continue; }
    worker.onmessage = ({ data }) => {
      if (data.done) return end();
      if (data.settled) return settledWorker();
      if (data.kinds) { kinds = data.kinds; return; }
      if (data.painted) {
        const item = { kind: data.kind, painted: data.painted };
        if (takers.length) takers.forEach(take => take(item)); else queue.push(item);
      }
      arrived(data.kind);
    };
    worker.onerror = event => { event.preventDefault(); end(); };
    worker.postMessage({ quality, index, workers, order: [STARTUP, SHELL] });
  }
  window.HollowPrepaint = Object.freeze({
    quality, workers, ready,
    // take(fn): fn receives every painted surface, those already waiting and each later one.
    take(fn) { takers.push(fn); queue.splice(0).forEach(fn); },
    get finished() { return finished; }
  });
})();
