/* Multi-touch input for The Hollow. The game remains the single owner of gameplay state. */
(function (global) {
  'use strict';

  const ICONS = {
    fire: '<circle cx="12" cy="12" r="6"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4"/><circle cx="12" cy="12" r="1.5"/>',
    jump: '<path d="m5 11 7-7 7 7M12 4v14M5 21h14"/>',
    crouch: '<circle cx="13" cy="4" r="2"/><path d="m12 8-4 5 5 2 3 6m-3-6H6l-3 6m9-13 4 4h5"/>',
    interact: '<path d="M8 12V6a2 2 0 0 1 4 0v6-8a2 2 0 0 1 4 0v9-5a2 2 0 0 1 4 0v7c0 5-3 7-7 7-3 0-5-2-7-5l-3-5a2 2 0 0 1 3-2l2 2"/>',
    reload: '<path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5"/>',
    sprint: '<circle cx="15" cy="4" r="2"/><path d="m12 8 4 4h5m-9-4-4 5-5 1m9-2 1 5 5 4m-7-8-3 6-5 2"/>',
    torch: '<path d="m8 9 3-3 7 7-3 3-7-7Zm1 1-5 5a2 2 0 0 0 3 3l5-5m2-11 2 3m5 1-3 2m4 4-3 1"/>',
    weapon: '<path d="M3 9h14l4 3h-5l-2 3H8l-2 5H3l2-7H3V9Zm9 6v4h3l1-5M1 9h2m14 0V7"/>',
    aim: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5"/><circle cx="12" cy="12" r="4"/>',
    pause: '<path d="M8 5v14M16 5v14" stroke-width="3"/>',
    decoy: '<path d="m9 9 2-4h4l1 5 4 8c1 2-1 3-3 3H9c-2 0-4-1-3-3l3-9Zm2-4V2h4v3M9 13h9"/>',
    map: '<path d="m3 5 6-3 6 3 6-3v17l-6 3-6-3-6 3V5Zm6-3v17m6-14v17"/>'
  };
  const HOLD_ACTIONS = new Set(['fire', 'aim', 'sprint', 'crouch']);

  function create(options) {
    options = options || {};
    const canvas = options.canvas || document.getElementById('game');
    const onAction = typeof options.onAction === 'function' ? options.onAction : function () {};
    const onLook = typeof options.onLook === 'function' ? options.onLook : function () {};
    const onMove = typeof options.onMove === 'function' ? options.onMove : function () {};
    const coarseMedia = global.matchMedia ? global.matchMedia('(pointer: coarse)') : null;
    const fineMedia = global.matchMedia ? global.matchMedia('(any-pointer: fine)') : null;
    let touch = !!((coarseMedia && coarseMedia.matches) || (navigator.maxTouchPoints > 0 && !(fineMedia && fineMedia.matches)));
    let active = false;
    let destroyed = false;
    let movePointer = null;
    let lookPointer = null;
    let moveCenter = { x: 0, y: 0, radius: 45 };
    let lookLast = { x: 0, y: 0 };
    let moveX = 0;
    let moveY = 0;
    const pressed = new Map();
    const actionPointers = new Map();
    const toggled = new Map();
    const listeners = [];
    const buttons = {};
    const overlay = document.createElement('div');
    overlay.id = 'touchControls';
    overlay.hidden = true;
    overlay.setAttribute('aria-label', 'Touch game controls');
    overlay.innerHTML = '<div id="touchLook" aria-label="Drag to look around"><span class="touch-look-caption">Drag to look</span></div>' +
      '<div id="touchMove" role="group" aria-label="Movement joystick"><div class="joystick-ring"><div class="joystick-thumb"></div></div><span class="joystick-label">MOVE</span></div>';
    const lookZone = overlay.querySelector('#touchLook');
    const moveZone = overlay.querySelector('#touchMove');
    const thumb = overlay.querySelector('.joystick-thumb');

    const specs = [
      ['fire', 'Fire', 'Hold to fire'], ['jump', 'Jump', 'Jump'], ['crouch', 'Crouch', 'Hold to crouch'],
      ['interact', 'Use', 'Interact, close or lock a shelter'], ['reload', 'Reload', 'Reload weapon'],
      ['sprint', 'Sprint', 'Hold while moving to sprint'], ['torch', 'Torch', 'Toggle torch'],
      ['weapon', 'Weapon', 'Change weapon'], ['aim', 'Aim', 'Hold to aim'], ['pause', 'Pause', 'Pause and settings'],
      ['decoy', 'Decoy', 'Throw a noise decoy'], ['map', 'Map', 'Expand map']
    ];
    for (const [action, label, accessible] of specs) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'touch-button touch-' + action;
      button.setAttribute('aria-label', accessible);
      button.setAttribute('aria-pressed', 'false');
      if (HOLD_ACTIONS.has(action)) button.setAttribute('aria-description', 'Touch: hold. Keyboard or screen reader: activate to toggle.');
      button.dataset.action = action;
      button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + ICONS[action] + '</svg><span>' + label + '</span>';
      overlay.appendChild(button);
      buttons[action] = button;
    }
    document.body.appendChild(overlay);

    function listen(target, name, callback, opts) {
      target.addEventListener(name, callback, opts);
      listeners.push([target, name, callback, opts]);
    }

    function setTouch(value) {
      touch = !!value;
      api.touch = touch;
      document.body.classList.toggle('touch-mode', touch);
      overlay.hidden = !touch || !active;
    }

    function reflectAction(action) {
      const held = !!(actionPointers.get(action) && actionPointers.get(action).size);
      if (!buttons[action]) return;
      buttons[action].classList.toggle('pressed', held);
      buttons[action].setAttribute('aria-pressed', String(toggled.has(action) ? toggled.get(action) : held));
    }

    function reflectToggle(action, value) {
      toggled.set(action, !!value);
      buttons[action].classList.toggle('is-on', !!value);
      reflectAction(action);
    }

    function setAction(action, isDown, pointerId) {
      let ids = actionPointers.get(action);
      if (!ids) { ids = new Set(); actionPointers.set(action, ids); }
      const wasDown = ids.size > 0;
      if (isDown) ids.add(pointerId);
      else ids.delete(pointerId);
      const isNowDown = ids.size > 0;
      reflectAction(action);
      if (wasDown !== isNowDown) onAction(action, isNowDown);
    }

    function capture(target, id) {
      try { target.setPointerCapture(id); } catch (_) { /* Cancellation may race capture. */ }
    }

    function release(target, id) {
      try { if (target.hasPointerCapture(id)) target.releasePointerCapture(id); } catch (_) {}
    }

    function emitMove(x, y) {
      if (x === moveX && y === moveY) return;
      moveX = x; moveY = y;
      onMove(x, y);
    }

    function updateStick(event) {
      let x = (event.clientX - moveCenter.x) / moveCenter.radius;
      let y = (moveCenter.y - event.clientY) / moveCenter.radius;
      const length = Math.hypot(x, y);
      if (length > 1) { x /= length; y /= length; }
      thumb.style.transform = 'translate(' + (x * moveCenter.radius * .76).toFixed(1) + 'px,' + (-y * moveCenter.radius * .76).toFixed(1) + 'px)';
      // Soft dead zone, but retain analog speed outside it.
      const clamped = Math.min(length, 1);
      if (clamped < .1) emitMove(0, 0);
      else { const scale = (clamped - .1) / .9 / clamped; emitMove(x * scale, y * scale); }
    }

    function stopMove() {
      const id = movePointer;
      movePointer = null;
      thumb.style.transform = 'translate(0px,0px)';
      emitMove(0, 0);
      if (id !== null) release(moveZone, id);
    }

    function releaseAll() {
      stopMove();
      const id = lookPointer;
      lookPointer = null;
      if (id !== null) release(lookZone, id);
      // Empty before releasing capture: lostpointercapture may fire synchronously.
      const items = Array.from(pressed.entries());
      pressed.clear();
      for (const [pointerId, action] of items) { setAction(action, false, pointerId); release(buttons[action], pointerId); }
    }

    function accept(event) {
      if (!active || destroyed || (event.pointerType === 'mouse' && !touch)) return false;
      if (!touch && event.pointerType !== 'mouse') setTouch(true);
      event.preventDefault();
      event.stopPropagation();
      return true;
    }

    listen(moveZone, 'pointerdown', function (event) {
      if (!accept(event) || movePointer !== null) return;
      const rect = moveZone.getBoundingClientRect();
      moveCenter = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, radius: Math.min(rect.width, rect.height) * .34 };
      movePointer = event.pointerId;
      capture(moveZone, movePointer);
      updateStick(event);
    });
    listen(moveZone, 'pointermove', function (event) {
      if (event.pointerId !== movePointer || !active) return;
      event.preventDefault(); updateStick(event);
    });
    function endMove(event) { if (event.pointerId === movePointer) stopMove(); }
    listen(moveZone, 'pointerup', endMove);
    listen(moveZone, 'pointercancel', endMove);
    listen(moveZone, 'lostpointercapture', endMove);

    listen(lookZone, 'pointerdown', function (event) {
      if (!accept(event) || lookPointer !== null) return;
      lookPointer = event.pointerId;
      lookLast = { x: event.clientX, y: event.clientY };
      capture(lookZone, lookPointer);
    });
    listen(lookZone, 'pointermove', function (event) {
      if (event.pointerId !== lookPointer || !active) return;
      event.preventDefault();
      const dx = event.clientX - lookLast.x;
      const dy = event.clientY - lookLast.y;
      lookLast = { x: event.clientX, y: event.clientY };
      if (Math.abs(dx) + Math.abs(dy) > 0) { onLook(dx, dy); overlay.classList.add('has-looked'); }
    });
    function endLook(event) {
      if (event.pointerId !== lookPointer) return;
      lookPointer = null;
      release(lookZone, event.pointerId);
    }
    listen(lookZone, 'pointerup', endLook);
    listen(lookZone, 'pointercancel', endLook);
    listen(lookZone, 'lostpointercapture', endLook);

    for (const [index, [action, button]] of Object.entries(buttons).entries()) {
      const assistivePointer = -100 - index;
      listen(button, 'pointerdown', function (event) {
        if (!accept(event)) return;
        pressed.set(event.pointerId, action);
        capture(button, event.pointerId);
        setAction(action, true, event.pointerId);
      });
      const endButton = function (event) {
        if (pressed.get(event.pointerId) !== action) return;
        pressed.delete(event.pointerId);
        setAction(action, false, event.pointerId);
        release(button, event.pointerId);
      };
      listen(button, 'pointerup', endButton);
      listen(button, 'pointercancel', endButton);
      listen(button, 'lostpointercapture', endButton);
      // Screen readers activate via click, without a preceding pointer event.
      listen(button, 'click', function (event) {
        event.preventDefault(); event.stopPropagation();
        if (!active || event.detail !== 0) return;
        // A same-task true/false pulse is never observed by a frame-based game.
        // Accessible activation toggles sustained actions until activated again.
        if (HOLD_ACTIONS.has(action)) {
          const down = !pressed.has(assistivePointer);
          if (down) pressed.set(assistivePointer, action);
          else pressed.delete(assistivePointer);
          setAction(action, down, assistivePointer);
        } else { onAction(action, true); onAction(action, false); }
      });
      listen(button, 'keydown', function (event) {
        if (event.repeat && (event.key === 'Enter' || event.key === ' ')) event.preventDefault();
      });
    }

    listen(overlay, 'contextmenu', function (event) { event.preventDefault(); });
    listen(overlay, 'touchstart', function (event) { if (active) event.preventDefault(); }, { passive: false });
    listen(global, 'blur', releaseAll);
    listen(global, 'pagehide', releaseAll);
    listen(document, 'visibilitychange', function () { if (document.hidden) releaseAll(); });
    listen(global, 'resize', releaseAll);
    // A hybrid laptop becomes touch-first only after a real touch on the game surface.
    if (canvas) listen(canvas, 'pointerdown', function (event) {
      if (event.pointerType === 'touch' && !touch) setTouch(true);
    });

    const api = {
      touch: touch,
      update: function (data) {
        if (destroyed) return;
        data = data || {};
        if (typeof data.active === 'boolean' && data.active !== active) {
          active = data.active;
          if (!active) releaseAll();
          overlay.hidden = !touch || !active;
        }
        if (typeof data.touch === 'boolean' && data.touch !== touch) { releaseAll(); setTouch(data.touch); }
        if ('torch' in data) reflectToggle('torch', data.torch);
        if ('torchOn' in data) reflectToggle('torch', data.torchOn);
        if ('mapExpanded' in data) reflectToggle('map', data.mapExpanded);
        if ('interact' in data) buttons.interact.classList.toggle('is-on', !!data.interact);
        if ('canInteract' in data) buttons.interact.classList.toggle('is-on', !!data.canInteract);
        if ('decoys' in data) buttons.decoy.setAttribute('aria-label', 'Throw a noise decoy, ' + data.decoys + ' remaining');
        if (data.state && overlay.dataset.state !== data.state) {
          releaseAll();
          overlay.dataset.state = data.state;
          const inStory = data.state === 'outside' || data.state === 'cutscene';
          const cinematic = data.state === 'cutscene';
          for (const name of ['fire', 'aim', 'reload', 'weapon', 'decoy', 'torch', 'interact', 'map']) buttons[name].hidden = inStory;
          for (const name of ['crouch', 'sprint', 'pause']) buttons[name].hidden = cinematic;
          moveZone.hidden = cinematic;
          lookZone.hidden = cinematic;
          buttons.jump.querySelector('span').textContent = cinematic ? 'Skip scene' : 'Jump';
          buttons.jump.setAttribute('aria-label', cinematic ? 'Skip cinematic' : 'Jump');
        }
      },
      destroy: function () {
        if (destroyed) return;
        releaseAll(); destroyed = true;
        for (const [target, name, callback, opts] of listeners) target.removeEventListener(name, callback, opts);
        overlay.remove(); document.body.classList.remove('touch-mode');
      }
    };
    setTouch(touch);
    return api;
  }

  global.HollowControls = { create: create };
})(window);
