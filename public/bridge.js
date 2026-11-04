/* Local implementations of the game's room, database and user hooks. */
(function () {
  'use strict';

  function lsGet(key) { try { return localStorage.getItem(key); } catch (_) { return null; } }
  function lsSet(key, value) { try { localStorage.setItem(key, value); } catch (_) {} }
  function error(code, message, status) {
    var result = new Error(message);
    result.code = code;
    if (status) result.status = status;
    return result;
  }
  function safely(callback, value) { try { callback(value); } catch (_) {} }
  function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
  function byteLength(value) {
    return typeof TextEncoder === 'function' ? new TextEncoder().encode(value).length : unescape(encodeURIComponent(value)).length;
  }
  var uid = lsGet('hollow.uid');
  if (!uid || !/^[A-Za-z0-9_-]{8,40}$/.test(uid)) {
    uid = 'u' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
    lsSet('hollow.uid', uid);
  }
  var base = new URL('.', location.href);
  var apiURL = new URL('api/scores', base).href;
  function wsURL() { var url = new URL('ws', base); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'; return url.href; }
  var user = Object.freeze({
    id: async function () { return uid; }, can: async function () { return true; },
    isOwner: async function () { return false; }, canEdit: async function () { return false; }
  });

  /* Scoreboard: one non-overlapping poll shared by all subscribers. */
  var listeners = new Set(), pollTimer = null, pollPromise = null, pollController = null;
  var pollEpoch = 0, pollAgain = false, cachedSnapshot = null, lastPollError = null, pageHidden = false;

  // The 8 s request limit is counted in 250 ms timer steps, not wall time. A step that runs late because the page
  // was busy (shader compiles on a slow phone) still counts 250 ms, so a reply that arrived meanwhile is read, not
  // aborted: an abort there would report a score the server already saved as not posted.
  function deadline(controller, ms) {
    var left = ms, timer = null;
    function step() { timer = setTimeout(function () { left -= 250; if (left > 0) step(); else controller.abort(); }, 250); }
    step();
    return function () { clearTimeout(timer); };
  }
  async function requestJSON(options, controller) {
    controller = controller || new AbortController();
    var stop = deadline(controller, 8000);
    try {
      var response = await fetch(apiURL, Object.assign({ cache: 'no-store' }, options, { signal: controller.signal }));
      if (!response.ok) {
        var failure = error(response.status === 429 ? 'rate_limited' : response.status === 401 || response.status === 403 ? 'not_permitted' : 'upstream_error', 'Scoreboard request failed (' + response.status + ')', response.status);
        failure.retryAfter = Number(response.headers && response.headers.get('Retry-After')) || 0;
        throw failure;
      }
      return await response.json();
    } finally { stop(); }
  }

  function schedulePoll(delay) {
    clearTimeout(pollTimer);
    pollTimer = null;
    if (!listeners.size || pageHidden) return;
    pollTimer = setTimeout(function () { pollTimer = null; poll(); }, delay);
  }
  function deliverSnapshot(listener, snapshot) {
    var view = snapshot.docs.length > listener.limit ? Object.freeze({ docs: Object.freeze(snapshot.docs.slice(0, listener.limit)) }) : snapshot;
    safely(listener.cb, view);
  }
  function poll() {
    if (!listeners.size || pageHidden) return Promise.resolve();
    if (pollPromise) return pollPromise;
    var epoch = pollEpoch, controller = new AbortController();
    pollController = controller;
    var promise = (async function () {
      try {
        var rows = await requestJSON({}, controller);
        if (!Array.isArray(rows)) throw error('upstream_error', 'Invalid scoreboard response');
        var docs = rows.slice(0, 100).filter(object).map(function (row) {
          var data = Object.freeze(Object.assign({}, row));
          return Object.freeze({ id: row.uid, data: function () { return data; } });
        });
        if (epoch !== pollEpoch) return;
        cachedSnapshot = Object.freeze({ docs: Object.freeze(docs) });
        lastPollError = null;
        listeners.forEach(function (listener) { deliverSnapshot(listener, cachedSnapshot); });
      } catch (failure) {
        if (epoch !== pollEpoch) return;
        lastPollError = failure;
        listeners.forEach(function (listener) { if (listener.err) safely(listener.err, failure); });
      } finally {
        if (pollPromise === promise) { pollPromise = null; pollController = null; }
        if (epoch === pollEpoch) {
          var delay = pollAgain ? 200 : 8000;
          pollAgain = false;
          schedulePoll(delay);
        }
      }
    })();
    pollPromise = promise;
    return promise;
  }
  function stopPolling() {
    clearTimeout(pollTimer);
    pollTimer = null;
    pollEpoch++;
    if (pollController) pollController.abort();
    pollController = null;
    pollPromise = null;
    pollAgain = false;
  }
  function refreshSoon() { if (pollPromise) pollAgain = true; else schedulePoll(200); }
  function query(limit) {
    var value = {
      orderBy: function () { return value; },
      limit: function (count) { return query(Math.max(1, Math.min(100, Math.floor(Number(count) || 100)))); },
      onSnapshot: function (cb, onError) {
        var listener = { cb: cb, err: onError, limit: limit };
        listeners.add(listener);
        var initial = null;
        if (cachedSnapshot || lastPollError) initial = setTimeout(function () {
          if (!listeners.has(listener)) return;
          if (cachedSnapshot) deliverSnapshot(listener, cachedSnapshot);
          if (lastPollError && listener.err) safely(listener.err, lastPollError);
        }, 0);
        if (!pollTimer && !pollPromise) poll();
        return function () {
          clearTimeout(initial);
          listeners.delete(listener);
          if (!listeners.size) stopPolling();
        };
      },
      doc: function () { return {
        set: async function (data) {
          if (!object(data)) throw error('invalid_score', 'A score must be an object');
          var result = await requestJSON({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
            uid: uid, name: data.name, time: data.time, kills: data.kills,
            score: data.score, mode: data.mode, escaped: data.escaped, partner: data.partner
          }) });
          refreshSoon();
          return result;
        }
      }; }
    };
    return Object.freeze(value);
  }
  var db = Object.freeze({ collection: function () { return query(100); } });

  /* Rooms: retries are bounded while opening a connection. A lost live round is
     reported, never silently resumed with a different peer/authority identity. */
  var transport = null, connectPromise = null, rooms = Object.create(null);
  var roomPattern = /^[a-z0-9][a-z0-9_.-]{0,47}$/;

  function isConnected(connection) { return !!(connection && !connection.closed && connection.ws.readyState === 1 && transport === connection); }
  function notifyConnections(record) {
    var connected = record.state === 'joined' && isConnected(record.transport);
    record.connections.forEach(function (listener) {
      if (listener.last === connected) return;
      listener.last = connected;
      safely(listener.cb, connected);
    });
  }
  function roomError(record, failure) {
    record.lastError = failure;
    record.subscribers.forEach(function (listener) { if (listener.err) safely(listener.err, failure); });
  }
  function closeRoom(record, failure) {
    if (record.state === 'closed') return;
    record.state = 'closed';
    clearTimeout(record.joinTimer);
    record.joinTimer = null;
    if (rooms[record.name] === record) delete rooms[record.name];
    if (record.reject) record.reject(failure);
    record.resolve = record.reject = null;
    record.others.clear();
    record.cache = null;
    notifyConnections(record);
    record.fire();
    roomError(record, failure);
  }
  function endTransport(connection, failure) {
    if (connection.closed) return;
    connection.closed = true;
    clearTimeout(connection.timer);
    if (transport === connection) transport = null;
    if (connection.reject) connection.reject(failure);
    connection.resolve = connection.reject = null;
    Object.keys(rooms).forEach(function (name) {
      var record = rooms[name];
      if (record.transport === connection) closeRoom(record, failure);
    });
    try { connection.ws.close(); } catch (_) {}
  }
  function send(connection, message) {
    if (!isConnected(connection)) throw error('upstream_error', 'Connection lost');
    if (connection.ws.bufferedAmount > 256 * 1024) {
      var busy = error('upstream_error', 'Connection is too slow; please reconnect');
      endTransport(connection, busy);
      throw busy;
    }
    try { connection.ws.send(JSON.stringify(message)); }
    catch (_) { var failure = error('upstream_error', 'Connection lost'); endTransport(connection, failure); throw failure; }
  }
  function receive(connection, raw) {
    if (!isConnected(connection)) return;
    var message;
    try { message = JSON.parse(raw); } catch (_) { return; }
    if (!object(message) || typeof message.room !== 'string') return;
    var record = rooms[message.room];
    if (!record || record.transport !== connection) {
      if (message.t === 'joined' && roomPattern.test(message.room)) try { send(connection, { t: 'leave', room: message.room }); } catch (_) {}
      return;
    }
    if (message.t === 'joined' && typeof message.peer === 'string' && Array.isArray(message.peers)) {
      record.me = message.peer;
      record.state = 'joined';
      record.lastError = null;
      record.others.clear();
      message.peers.forEach(function (peer) {
        if (object(peer) && typeof peer.peer === 'string' && peer.peer !== record.me && object(peer.pr)) record.others.set(peer.peer, Object.freeze(peer.pr));
      });
      clearTimeout(record.joinTimer);
      record.joinTimer = null;
      if (record.resolve) record.resolve(record.api);
      record.resolve = record.reject = null;
      notifyConnections(record);
      record.fire();
    } else if (message.t === 'peer' && typeof message.peer === 'string' && message.peer !== record.me && object(message.pr)) {
      record.others.set(message.peer, Object.freeze(message.pr));
      record.fire();
    } else if (message.t === 'left' && typeof message.peer === 'string') {
      record.others.delete(message.peer);
      record.fire();
    } else if (message.t === 'full') closeRoom(record, error('limit_reached', message.code === 'room_limit' ? 'Too many open rooms' : message.code === 'server_busy' ? 'The server is busy' : 'Room full'));
    else if (message.t === 'error') closeRoom(record, error(message.code || 'upstream_error', 'The server rejected the room request'));
  }
  function openTransport() {
    var connection = { ws: null, closed: false, timer: null, resolve: null, reject: null };
    return new Promise(function (resolve, reject) {
      connection.resolve = resolve;
      connection.reject = reject;
      try { connection.ws = new WebSocket(wsURL()); }
      catch (_) { reject(error('upstream_error', 'Cannot open a game connection')); return; }
      transport = connection;
      connection.timer = setTimeout(function () { endTransport(connection, error('upstream_error', 'Connection timed out')); }, 6000);
      connection.ws.onopen = function () {
        if (connection.closed || transport !== connection) return;
        clearTimeout(connection.timer);
        connection.resolve(connection);
        connection.resolve = connection.reject = null;
      };
      connection.ws.onerror = function () { endTransport(connection, error('upstream_error', 'Cannot reach the game server')); };
      connection.ws.onclose = function () { endTransport(connection, error('upstream_error', 'Connection lost')); };
      connection.ws.onmessage = function (event) { receive(connection, event.data); };
    });
  }
  function connect() {
    if (isConnected(transport)) return Promise.resolve(transport);
    if (connectPromise) return connectPromise;
    var promise = (async function () {
      var failure;
      for (var attempt = 0; attempt < 2; attempt++) {
        if (pageHidden) throw error('upstream_error', 'The page is not active');
        try { return await openTransport(); } catch (caught) { failure = caught; }
        if (attempt === 0) await new Promise(function (resolve) { setTimeout(resolve, 350); });
      }
      throw failure;
    })();
    connectPromise = promise;
    function clear() { if (connectPromise === promise) connectPromise = null; }
    promise.then(clear, clear);
    return promise;
  }
  function makeRoom(name, connection) {
    var record = {
      name: name, transport: connection, state: 'joining', me: null, mine: Object.create(null), others: new Map(),
      subscribers: new Set(), connections: new Set(), cache: null, notifyTimer: null,
      joinTimer: null, resolve: null, reject: null, lastError: null, promise: null
    };
    record.snapshot = function () {
      var now = Date.now();
      var peers = [Object.freeze({ peer: record.me || 'me', by: uid, isMe: true, sameTab: true, kind: 'viewer', guest: false, presence: Object.freeze(Object.assign({}, record.mine)), updatedAt: now })];
      record.others.forEach(function (presence, peer) { peers.push(Object.freeze({ peer: peer, by: null, isMe: false, sameTab: false, kind: 'viewer', guest: false, presence: presence, updatedAt: now })); });
      return Object.freeze(peers);
    };
    record.fire = function () {
      record.cache = null;
      if (record.notifyTimer !== null) return;
      record.notifyTimer = setTimeout(function () {
        record.notifyTimer = null;
        record.cache = record.snapshot();
        var change = Object.freeze({ peers: record.cache, joined: [], left: [], updated: [] });
        record.subscribers.forEach(function (listener) { safely(listener.cb, change); });
      }, 0);
    };
    record.api = Object.freeze({
      name: name,
      presence: async function (patch) {
        if (record.state !== 'joined' || !isConnected(connection)) throw error('upstream_error', 'Room is disconnected');
        if (!object(patch)) throw error('invalid_presence', 'Presence must be an object');
        var next = Object.assign(Object.create(null), record.mine);
        Object.keys(patch).forEach(function (key) { if (patch[key] === null) delete next[key]; else next[key] = patch[key]; });
        var serialized;
        try { serialized = JSON.stringify(next); }
        catch (_) { throw error('invalid_presence', 'Presence must be serializable'); }
        if (byteLength(serialized) > 4096) throw error('invalid_presence', 'Presence exceeds 4096 bytes');
        next = JSON.parse(serialized);
        send(connection, { t: 'presence', room: name, pr: next });
        record.mine = next;
        record.cache = null;
      },
      peers: function () { return record.cache || record.snapshot(); },
      onPeers: function (handler, onError) {
        var listener = { cb: handler, err: onError };
        record.subscribers.add(listener);
        record.fire();
        var initial = record.lastError && onError ? setTimeout(function () { if (record.subscribers.has(listener)) safely(onError, record.lastError); }, 0) : null;
        return function () { clearTimeout(initial); record.subscribers.delete(listener); };
      },
      connected: function () { return record.state === 'joined' && isConnected(connection); },
      onConnection: function (handler) {
        var listener = { cb: handler, last: null };
        record.connections.add(listener);
        var initial = setTimeout(function () { if (record.connections.has(listener)) notifyConnections(record); }, 0);
        return function () { clearTimeout(initial); record.connections.delete(listener); };
      },
      emit: async function () {}, on: function () { return function () {}; },
      leave: async function () {
        if (record.state !== 'closed' && isConnected(connection)) try { send(connection, { t: 'leave', room: name }); } catch (_) {}
        record.state = 'closed';
        clearTimeout(record.joinTimer);
        clearTimeout(record.notifyTimer);
        record.joinTimer = record.notifyTimer = null;
        if (record.reject) record.reject(error('cancelled', 'Room was left before joining'));
        record.resolve = record.reject = null;
        if (rooms[name] === record) delete rooms[name];
        record.others.clear();
        record.cache = null;
        notifyConnections(record);
        record.subscribers.clear();
        record.connections.clear();
      }
    });
    return record;
  }
  var room = Object.freeze({
    join: async function (name) {
      if (typeof name !== 'string' || !roomPattern.test(name)) throw error('invalid_room', 'Invalid room name');
      if (rooms[name]) return rooms[name].promise;
      var connection = await connect();
      if (rooms[name]) return rooms[name].promise;
      var record = makeRoom(name, connection);
      rooms[name] = record;
      record.promise = new Promise(function (resolve, reject) { record.resolve = resolve; record.reject = reject; });
      record.joinTimer = setTimeout(function () {
        if (record.state !== 'joining') return;
        try { send(connection, { t: 'leave', room: name }); } catch (_) {}
        closeRoom(record, error('upstream_error', 'The room did not answer'));
      }, 10000);
      try { send(connection, { t: 'join', room: name }); }
      catch (failure) { closeRoom(record, failure); }
      return record.promise;
    },
    peers: function () { return []; }, onPeers: function () { return function () {}; },
    connected: function () { return isConnected(transport); }
  });

  window.addEventListener('pagehide', function () {
    pageHidden = true;
    stopPolling();
    if (transport) endTransport(transport, error('upstream_error', 'The page was closed'));
  });
  window.addEventListener('pageshow', function () { pageHidden = false; if (listeners.size) poll(); });
  window.addEventListener('online', refreshSoon);
  var capabilities = { room: room, db: db, user: user };
  window.claude = Object.freeze({ use: async function (name) { return capabilities[name] || null; } });
})();
