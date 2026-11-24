'use strict';
// Opening screens: the light follows the pointer like a hand torch, rests on the
// title when nobody is aiming it, and falters now and then. Purely decorative;
// without this script the CSS fallback keeps the light on the title.
(() => {
  const screens = Array.from(document.querySelectorAll('.screen.entry'));
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let effects = true;
  // "Disturbing effects" can be switched off in the pause menu; re-read it whenever a menu opens.
  function readEffects() {
    try { effects = JSON.parse(localStorage.getItem('hollow.settings') || '{}').effects !== false; } catch (e) { effects = true; }
    document.documentElement.classList.toggle('calm-entry', !effects);
  }
  readEffects();

  // The light is drawn at quarter resolution; a soft gradient upscales cleanly and
  // repainting it costs almost nothing, unlike a full-screen CSS gradient.
  const SCALE = 0.25;
  const STOPS = [[0, 'rgba(255,196,128,.06)'], [0.34, 'rgba(7,6,5,.04)'], [0.6, 'rgba(7,6,5,.44)'], [0.84, 'rgba(7,6,5,.84)'], [1, 'rgba(7,6,5,.96)']];
  const LOADING_LEVEL = 0.45;
  const SWITCH_ON = [[0.12, 160], [0.85, 60], [0.2, 110], [1, 0]];
  const FALTERS = [
    [[0.35, 55], [1, 80], [0.18, 45], [1, 0]],
    [[0.7, 90], [0.25, 40], [0.9, 60], [0.4, 50], [1, 0]],
    [[0.08, 70], [1, 0]]
  ];
  const WATCHER_SPOTS = [[74, 1], [86, 0.86], [58, 0.78], [93, 1.08]];
  const light = { x: NaN, y: NaN, aimX: 0, aimY: 0, aimedAt: -Infinity, mouseInside: false };
  const watcher = { seen: 0, goneAt: 0, spot: 0 };
  let ready = !!window.HollowReady, switchOn = false;
  let current = null, raf = 0, last = 0, lastPaint = 0, flicker = null, nextFalter = 0, painted = '';

  const visibleScreen = () => screens.find(screen => !screen.hidden) || null;
  const calm = () => reduceMotion.matches || !effects;
  // Matches the gradient radius of the CSS fallback in .torchlight.
  const radius = () => Math.min(700, Math.max(280, Math.max(innerWidth, innerHeight) * 0.4));

  function restingPoint(screen) {
    const title = screen.querySelector('.entry-title');
    const box = title && title.getBoundingClientRect();
    if (!box || !box.width) return { x: innerWidth * 0.32, y: innerHeight * 0.42 };
    return { x: box.left + Math.min(box.width * 0.48, innerWidth * 0.5), y: box.top + box.height * 0.4 };
  }

  function play(steps, now) { flicker = { steps, index: -1, until: now }; }

  function flickerLevel(now) {
    if (!flicker) return 1;
    while (now >= flicker.until) {
      flicker.index++;
      const step = flicker.steps[flicker.index];
      if (!step) { flicker = null; return 1; }
      flicker.until = now + step[1] * (0.75 + Math.random() * 0.5);
      if (step[2]) step[2](now);
    }
    return flicker.steps[flicker.index][0];
  }

  function watch(screen, now, dt, level) {
    const figure = screen.querySelector('.watcher');
    if (!figure || calm()) return;
    const box = figure.getBoundingClientRect();
    const distance = Math.hypot(light.x - (box.left + box.width / 2), light.y - (box.top + box.height * 0.4));
    if (watcher.goneAt) {
      // It only comes back while the light is pointed elsewhere.
      if (now - watcher.goneAt > 9000 && distance > radius() * 1.15) {
        watcher.goneAt = 0;
        watcher.seen = 0;
        figure.classList.remove('gone');
      }
      return;
    }
    watcher.seen = distance < radius() * 0.42 * level ? watcher.seen + dt : Math.max(0, watcher.seen - dt * 0.5);
    if (watcher.seen > 0.6 && !flicker) {
      // The torch falters, and by the time it steadies the figure has moved.
      play([[0.06, 120, at => {
        watcher.goneAt = at;
        watcher.spot = (watcher.spot + 1 + Math.floor(Math.random() * (WATCHER_SPOTS.length - 1))) % WATCHER_SPOTS.length;
        const [x, scale] = WATCHER_SPOTS[watcher.spot];
        figure.classList.add('gone');
        figure.style.setProperty('--watcher-x', x + '%');
        figure.style.setProperty('--watcher-scale', scale);
      }], [0.6, 60], [0.1, 70], [1, 0]], now);
    }
  }

  function paint(screen, x, y, level) {
    const torch = screen.querySelector('.torchlight');
    if (!torch) return;
    let canvas = torch.firstElementChild;
    if (!canvas) {
      canvas = document.createElement('canvas');
      if (!canvas.getContext('2d')) {
        torch.style.setProperty('--tx', x.toFixed(1) + 'px');
        torch.style.setProperty('--ty', y.toFixed(1) + 'px');
        torch.style.setProperty('--k', level.toFixed(2));
        return;
      }
      torch.appendChild(canvas);
      torch.classList.add('live');
    }
    const width = Math.max(1, Math.round(innerWidth * SCALE)), height = Math.max(1, Math.round(innerHeight * SCALE));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    const context = canvas.getContext('2d');
    const gradient = context.createRadialGradient(x * SCALE, y * SCALE, 0, x * SCALE, y * SCALE, Math.max(0.5, radius() * level * SCALE));
    for (const [stop, color] of STOPS) gradient.addColorStop(stop, color);
    context.clearRect(0, 0, width, height);
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
  }

  function frame(now) {
    raf = 0;
    const screen = visibleScreen();
    if (!screen) { current = null; return; }
    // A long stall (page load, background tab) should not end in an immediate falter.
    if (now - last > 1000) nextFalter = Math.max(nextFalter, now + 5000);
    const dt = Math.min(0.1, Math.max(0, (now - (last || now)) / 1000));
    last = now;
    if (screen !== current) {
      // Returning from the ward relights the torch; moving between menus does not.
      if (!current) { readEffects(); light.x = NaN; if (ready && !calm()) switchOn = true; }
      current = screen;
      painted = '';
    }
    if (switchOn) {
      switchOn = false;
      play(SWITCH_ON, now);
      nextFalter = now + 9000 + Math.random() * 9000;
    }
    const aiming = light.mouseInside || now - light.aimedAt < 3500;
    const rest = restingPoint(screen);
    let targetX = aiming ? light.aimX : rest.x, targetY = aiming ? light.aimY : rest.y;
    if (!reduceMotion.matches) {
      // A hand never holds a torch perfectly still.
      const s = now / 1000;
      targetX += Math.sin(s * 0.53) * 12 + Math.sin(s * 1.37) * 3;
      targetY += Math.cos(s * 0.41) * 8 + Math.sin(s * 1.13) * 2.5;
    }
    if (Number.isNaN(light.x) || reduceMotion.matches) { light.x = targetX; light.y = targetY; }
    else {
      const ease = 1 - Math.exp(-dt * (aiming ? 11 : 2.4));
      light.x += (targetX - light.x) * ease;
      light.y += (targetY - light.y) * ease;
    }
    let level = 1;
    if (calm()) flicker = null;
    else if (!ready) level = LOADING_LEVEL;
    else {
      if (!flicker && now > nextFalter) {
        play(FALTERS[Math.floor(Math.random() * FALTERS.length)], now);
        nextFalter = now + 8000 + Math.random() * 14000;
      }
      level = flickerLevel(now);
      watch(screen, now, dt, level);
    }

    const settling = Math.hypot(targetX - light.x, targetY - light.y) > 2;
    // Idle sway does not need every display frame.
    if (reduceMotion.matches || flicker || settling || now - lastPaint > 48) {
      const value = light.x.toFixed(1) + ' ' + light.y.toFixed(1) + ' ' + level.toFixed(2) + ' ' + innerWidth + 'x' + innerHeight;
      if (value !== painted) { paint(screen, light.x, light.y, level); painted = value; }
      lastPaint = now;
    }
    if (!reduceMotion.matches || flicker || settling) schedule();
  }

  function schedule() { if (!raf) raf = requestAnimationFrame(frame); }

  function aim(event) {
    if (document.pointerLockElement || !visibleScreen()) return;
    light.aimX = event.clientX;
    light.aimY = event.clientY;
    light.aimedAt = performance.now();
    if (event.pointerType === 'mouse') light.mouseInside = true;
    schedule();
  }

  if (screens.length) {
    addEventListener('pointermove', aim, { passive: true });
    addEventListener('pointerdown', aim, { passive: true });
    document.addEventListener('mouseout', event => { if (!event.relatedTarget) { light.mouseInside = false; schedule(); } });
    addEventListener('blur', () => { light.mouseInside = false; });
    addEventListener('resize', schedule);
    // The torch stays dim until game.js has built the ward and wired the menu (hollow:ready), then switches on.
    if (!ready) addEventListener('hollow:ready', () => { ready = true; switchOn = !calm(); schedule(); }, { once: true });
    if (reduceMotion.addEventListener) reduceMotion.addEventListener('change', schedule);
    const observer = new MutationObserver(schedule);
    for (const screen of screens) observer.observe(screen, { attributes: true, attributeFilter: ['hidden'] });
    schedule();
  }

  // Play and Multiplay are on screen before game.js has wired them. A click meanwhile is remembered and replayed once
  // the game is ready (within a few seconds the browser still counts it as the player's gesture, so the pointer
  // lock and audio start as usual); a first visit, which opens the name screen instead, drops it.
  let queued = null;
  if (!window.HollowReady) {
    document.addEventListener('click', event => {
      if (window.HollowReady) return;
      const button = event.target instanceof Element && event.target.closest('#startDarkBtn, #coopBtn');
      if (!button) return;
      if (queued) queued.removeAttribute('aria-busy');
      queued = button;
      button.setAttribute('aria-busy', 'true');
    }, true);
    addEventListener('hollow:ready', () => {
      const button = queued;
      queued = null;
      if (!button) return;
      button.removeAttribute('aria-busy');
      const menu = document.getElementById('menu');
      if (menu && !menu.hidden && !button.hidden && !button.disabled) button.click();
    }, { once: true });
  }

  const howTo = document.getElementById('howTo');
  const howToButton = document.getElementById('howToBtn');
  if (howTo && howToButton) {
    howToButton.addEventListener('click', () => {
      if (typeof howTo.showModal === 'function') howTo.showModal();
      else howTo.setAttribute('open', '');
    });
    // A click on the dimmed backdrop lands on the dialog element itself.
    howTo.addEventListener('click', event => { if (event.target === howTo) howTo.close(); });
  }
})();
