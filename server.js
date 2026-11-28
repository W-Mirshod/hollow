// The Hollow: local game assets, co-op presence and a persistent community board.
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const { isIP } = require('node:net');
const { randomBytes, createHash } = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');

const ROOM_RE = /^[a-z0-9][a-z0-9_.-]{0,47}$/;
const EVENT_RE = /^[a-z][a-z0-9_-]{0,15}$/;
const UID_RE = /^[A-Za-z0-9_-]{8,40}$/;
const THREE_BUILD = new Set(['three.webgpu.js', 'three.tsl.js', 'three.core.js']);
const THREE_ADDON_RE = /^\/vendor\/three\/addons\/((?:[A-Za-z0-9_-]+\/){0,8}[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.js)$/;
// /vendor/three@<version>/... is the cache-forever spelling of /vendor/three/...; index.html is served with it.
const THREE_VERSIONED_RE = /^\/vendor\/three@([0-9A-Za-z.+-]{1,32})(\/.*)$/;
const IMMUTABLE = 'public, max-age=31536000, immutable';
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.mjs', '.json', '.svg', '.txt']);
// Files above this size are streamed from disk as before, uncompressed and uncached.
const MAX_CACHED_FILE = 8 * 1024 * 1024;
const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);
const brotliParams = (quality, size) => ({ params: {
  [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
  [zlib.constants.BROTLI_PARAM_QUALITY]: quality, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: size
} });
const hashOf = body => createHash('sha1').update(body).digest('base64url').slice(0, 20);
const MAX_KILLS = 12;
const MAX_SCORE = 1000000;
const MODES = new Set(['solo', 'coop']);
const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json', '.ktx2': 'image/ktx2', '.bin': 'application/octet-stream'
});

class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function cleanName(value) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 18)
    : '';
}

// Escapes rank above runs that ended in the ward; then higher score, then the faster escape or the
// longer survival, then the earlier run. public/game.js sorts the board with the same order.
function compareRuns(a, b) {
  return (b.escaped - a.escaped) || (b.score - a.score) || (a.escaped ? a.time - b.time : b.time - a.time) || (a.at - b.at);
}

// One best run is kept per browser identity, mode and (case-insensitive) player name, so players who
// share a browser and both co-op partners each keep their own entry.
function recordKey(run) {
  return run.uid + '|' + run.mode + '|' + run.name.toLowerCase();
}

// A run as submitted or saved; missing fields describe the original solo escape. Returns null if invalid.
function cleanRun(uid, record, at) {
  if (!UID_RE.test(uid) || !record || typeof record !== 'object' || Array.isArray(record)) return null;
  const name = cleanName(record.name);
  const mode = record.mode == null ? 'solo' : record.mode;
  const escaped = record.escaped == null ? true : record.escaped;
  const time = Number(record.time);
  const kills = record.kills == null ? 0 : Number(record.kills);
  const score = record.score == null ? 0 : Number(record.score);
  if (name.length < 2 || !MODES.has(mode) || typeof escaped !== 'boolean' || !Number.isFinite(time) ||
    time < (escaped ? 15 : 0) || time > 7200 || !Number.isFinite(kills) || !Number.isFinite(score)) return null;
  return {
    uid, name, mode, partner: mode === 'coop' ? cleanName(record.partner) : '', escaped,
    time: Math.round(time * 10) / 10,
    kills: Math.max(0, Math.min(MAX_KILLS, Math.floor(kills))),
    score: Math.max(0, Math.min(MAX_SCORE, Math.floor(score))),
    at
  };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    req.on('data', chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        chunks.length = 0;
        reject(new RequestError(413, 'request too large'));
        req.resume();
      } else chunks.push(chunk);
    });
    req.on('end', () => { if (!settled) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
    req.on('aborted', () => reject(new RequestError(400, 'request aborted')));
  });
}

function send(req, res, status, type, body, extraHeaders = {}) {
  if (res.destroyed || res.writableEnded) return;
  const data = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    ...extraHeaders
  });
  res.end(req.method === 'HEAD' ? undefined : data);
}

function json(req, res, status, body, headers) {
  send(req, res, status, 'application/json; charset=utf-8', JSON.stringify(body), headers);
}

// Picks br, then gzip, from an Accept-Encoding header; q=0 refuses an encoding.
function acceptedEncodings(req) {
  const accepted = new Set();
  for (const part of String(req.headers['accept-encoding'] || '').split(',')) {
    const [token, ...params] = part.trim().toLowerCase().split(';');
    const q = params.map(p => p.trim()).find(p => p.startsWith('q='));
    if (token && !(q && Number(q.slice(2)) === 0)) accepted.add(token);
  }
  return accepted;
}

function etagMatches(req, tags) {
  const header = String(req.headers['if-none-match'] || '');
  if (!header) return false;
  return header.split(/\s*,\s*/).some(tag => tag === '*' || tags.includes(tag.replace(/^W\//, '')));
}

function requestQuery(req) {
  const raw = String(req.url || '').split('#', 1)[0];
  const at = raw.indexOf('?');
  return new URLSearchParams(at < 0 ? '' : raw.slice(at + 1));
}

function requestPath(req) {
  // Check the original path before URL normalization can conceal ../ segments.
  const raw = String(req.url || '');
  if (!raw.startsWith('/') || raw.startsWith('//')) throw new RequestError(400, 'bad URL');
  let pathname;
  try { pathname = decodeURIComponent(raw.split(/[?#]/, 1)[0]); }
  catch { throw new RequestError(400, 'bad URL'); }
  if (/[\u0000-\u001f\u007f\\]/.test(pathname)) throw new RequestError(400, 'bad URL');
  if (pathname.split('/').some(segment => segment === '..')) throw new RequestError(403, 'forbidden');
  return pathname.replace(/\/+$/, '') || '/';
}

function createGameServer(options = {}) {
  const publicDir = path.resolve(options.publicDir || path.join(__dirname, 'public'));
  const dataDir = path.resolve(options.dataDir || process.env.DATA_DIR || path.join(__dirname, 'data'));
  const scoresFile = path.join(dataDir, 'scores.json');
  const threeBuildDir = path.dirname(require.resolve('three/webgpu'));
  const threeAddonDir = path.join(threeBuildDir, '..', 'examples', 'jsm');
  const threeVersion = JSON.parse(fs.readFileSync(path.join(threeBuildDir, '..', 'package.json'), 'utf8')).version;
  const indexFile = path.join(publicDir, 'index.html');
  // precompress: compress every public file and the three.js builds at start-up, then upgrade each to maximum brotli
  // one file at a time in the background. Without it files are compressed (fast settings) on first request.
  const precompress = options.precompress ?? false;
  const scoreCooldownMs = options.scoreCooldownMs ?? 3000;
  const trustProxy = options.trustProxy ?? process.env.TRUST_PROXY === '1';
  const maxRoomsPerConnection = options.maxRoomsPerConnection ?? 2;
  const maxRooms = options.maxRooms ?? 1024;
  const logError = options.logError || (error => console.error('[hollow]', error.message));
  const scores = Object.create(null);
  const lastPost = new Map();
  const rooms = new Map();
  let saveTimer = null;
  let dirty = false;
  let writes = Promise.resolve();
  let closePromise = null;

  fs.mkdirSync(dataDir, { recursive: true });
  try {
    const saved = JSON.parse(fs.readFileSync(scoresFile, 'utf8'));
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      for (const [key, record] of Object.entries(saved)) {
        if (!record || typeof record !== 'object') continue;
        // Older files were keyed by browser identity alone and held solo escapes.
        const uid = typeof record.uid === 'string' ? record.uid : key;
        const run = cleanRun(uid, { ...record, kills: Number(record.kills) || 0, score: Number(record.score) || 0 },
          Number.isFinite(Number(record.at)) ? Number(record.at) : 0);
        if (!run) continue;
        const id = recordKey(run);
        if (!scores[id] || compareRuns(run, scores[id]) < 0) scores[id] = run;
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') logError(new Error('Scoreboard could not be loaded; the original file was left untouched.'));
  }

  function persistScores() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!dirty) return writes;
    dirty = false;
    const snapshot = JSON.stringify(scores);
    // Serialize writes: a slow older rename must not overwrite a newer score.
    writes = writes.catch(() => {}).then(async () => {
      const temporaryFile = scoresFile + '.tmp';
      try {
        await fs.promises.writeFile(temporaryFile, snapshot, { mode: 0o600 });
        await fs.promises.rename(temporaryFile, scoresFile);
      } catch (error) {
        dirty = true;
        throw error;
      }
    });
    return writes;
  }

  function scheduleSave() {
    dirty = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => persistScores().catch(logError), 250);
    saveTimer.unref();
  }

  function topScores() {
    return Object.values(scores).sort(compareRuns).slice(0, 100);
  }

  // Every open menu polls the board: sort and serialize once per change, and answer unchanged polls with 304.
  let board = null;
  function boardResponse() {
    if (!board) {
      const body = Buffer.from(JSON.stringify(topScores()));
      board = { body, etag: '"' + hashOf(body) + '"', gz: body.length >= 1024 ? zlib.gzipSync(body, { level: 6 }) : null };
    }
    return board;
  }
  function serveBoard(req, res) {
    const current = boardResponse(), gz = !!current.gz && acceptedEncodings(req).has('gzip');
    const headers = { 'Cache-Control': 'no-cache', 'ETag': gz ? current.etag.slice(0, -1) + '-gz"' : current.etag };
    if (current.gz) headers['Vary'] = 'Accept-Encoding';
    if (etagMatches(req, [current.etag, current.etag.slice(0, -1) + '-gz"'])) {
      res.writeHead(304, { ...headers, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
      return res.end();
    }
    send(req, res, 200, 'application/json; charset=utf-8', gz ? current.gz : current.body, gz ? { ...headers, 'Content-Encoding': 'gzip' } : headers);
  }

  function requestIP(req) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return trustProxy && isIP(forwarded) ? forwarded : (req.socket.remoteAddress || 'unknown');
  }

  // Only the pinned Three.js ES module build and its addons are exposed from node_modules.
  function vendorAsset(pathname) {
    const versioned = THREE_VERSIONED_RE.exec(pathname);
    if (versioned) pathname = '/vendor/three' + versioned[2];
    const tag = { versioned: !!versioned, current: !!versioned && versioned[1] === threeVersion };
    if (pathname.startsWith('/vendor/three/build/')) {
      const name = pathname.slice('/vendor/three/build/'.length);
      return THREE_BUILD.has(name) ? { file: path.join(threeBuildDir, name), root: threeBuildDir, ...tag } : null;
    }
    const addon = THREE_ADDON_RE.exec(pathname);
    return addon ? { file: path.join(threeAddonDir, addon[1]), root: threeAddonDir, ...tag } : null;
  }

  /* Asset cache: each file is read and compressed once per version (size + mtime), then served from memory. */
  const assets = new Map();
  let upgrades = Promise.resolve();
  let closing = false;

  // A representation is one body with its brotli/gzip variants and validators.
  async function represent(body, compressible) {
    const rep = { body, etag: '"' + hashOf(body) + '"', br: null, gz: null };
    if (compressible && body.length >= 1024) {
      const [br, gz] = await Promise.all([brotli(body, brotliParams(5, body.length)), gzip(body, { level: 6 })]);
      if (br.length < body.length) rep.br = br;
      if (gz.length < body.length) rep.gz = gz;
      // Maximum brotli is ~50x slower: one file at a time on one libuv thread, so requests never queue behind it.
      if (precompress && rep.br) upgrades = upgrades.then(async () => {
        if (closing) return;
        const best = await brotli(body, brotliParams(11, body.length));
        if (best.length < rep.br.length) rep.br = best;
      }).catch(() => {});
    }
    return rep;
  }

  function loadAsset(filename, stats) {
    const stamp = stats.size + ':' + stats.mtimeMs;
    const cached = assets.get(filename);
    if (cached && cached.stamp === stamp) return cached.ready;
    const entry = { stamp, derived: new Map() };
    entry.ready = fs.promises.readFile(filename)
      .then(body => represent(body, COMPRESSIBLE.has(path.extname(filename).toLowerCase())))
      .then(rep => Object.assign(entry, { rep }));
    entry.ready.catch(() => { if (assets.get(filename) === entry) assets.delete(filename); });
    assets.set(filename, entry);
    return entry.ready;
  }

  // A cached transformation of a file (the versioned index.html, a versioned stylesheet).
  function derive(entry, key, transform) {
    if (!entry.derived.has(key)) {
      if (entry.derived.size >= 4) entry.derived.clear();
      const ready = represent(Buffer.from(transform(entry.rep.body.toString('utf8'))), true);
      ready.catch(() => entry.derived.delete(key));
      entry.derived.set(key, ready);
    }
    return entry.derived.get(key);
  }

  // One version for every public file: a hash of their contents, rechecked (sizes and mtimes) at most once a second.
  let version = null;
  async function publicFiles(dir = publicDir, prefix = '', out = []) {
    for (const item of await fs.promises.readdir(dir, { withFileTypes: true })) {
      if (item.name.startsWith('.')) continue;
      const filename = path.join(dir, item.name), rel = prefix + item.name;
      if (item.isDirectory()) await publicFiles(filename, rel + '/', out);
      else if (item.isFile()) out.push({ rel, filename, stats: await fs.promises.stat(filename) });
    }
    return out;
  }
  function assetVersion() {
    const now = Date.now();
    if (version && now - version.checkedAt < 1000) return version.value;
    const previous = version, state = { checkedAt: now, signature: null, value: null };
    state.value = publicFiles().then(async files => {
      files.sort((a, b) => a.rel < b.rel ? -1 : 1);
      const signature = state.signature = files.map(f => f.rel + ':' + f.stats.size + ':' + f.stats.mtimeMs).join('|');
      if (previous && previous.signature === signature) return previous.value;
      const hash = createHash('sha1');
      for (const f of files) {
        const id = f.stats.size <= MAX_CACHED_FILE ? (await loadAsset(f.filename, f.stats)).rep.etag : f.stats.size + ':' + f.stats.mtimeMs;
        hash.update(f.rel + '\0' + id + '\0');
      }
      return hash.digest('base64url').slice(0, 12);
    });
    state.value.catch(() => { if (version === state) version = null; });
    version = state;
    return state.value;
  }

  // index.html: point the import map and preloads at the cache-forever three.js path and stamp every local script,
  // stylesheet and font with ?v=<version>. boot.mjs carries its own ?v= onto everything it loads.
  const LOCAL_REF_RE = /\b(src|href)="(?![a-z][\w+.-]*:|\/\/|#)([^"?#]+\.(?:m?js|css|woff2))"/gi;
  function renderIndex(html, assetsVersion) {
    return html.replace(/\bvendor\/three\//g, 'vendor/three@' + threeVersion + '/')
      .replace(LOCAL_REF_RE, (match, attribute, ref) => ref.startsWith('vendor/') ? match : `${attribute}="${ref}?v=${assetsVersion}"`);
  }
  // A versioned stylesheet stamps its fonts the same way, so they match the preloads in index.html.
  const CSS_URL_RE = /url\((["']?)(?![a-z][\w+.-]*:|\/\/|#)([^"')?#]+)\1\)/gi;
  function renderStylesheet(css, assetsVersion) {
    return css.replace(CSS_URL_RE, (match, quote, ref) => `url(${quote}${ref}?v=${assetsVersion}${quote})`);
  }

  function warmAssets() {
    const vendor = [...THREE_BUILD].map(name => path.join(threeBuildDir, name));
    return Promise.all([
      assetVersion(),
      ...vendor.map(file => fs.promises.stat(file).then(stats => loadAsset(file, stats)))
    ]).catch(logError);
  }

  async function serveAsset(req, res, pathname) {
    const isVendor = pathname.startsWith('/vendor/three/') || pathname.startsWith('/vendor/three@');
    const vendor = isVendor ? vendorAsset(pathname) : null;
    if (isVendor && !vendor) throw new RequestError(404, 'not found');
    const relative = pathname === '/' ? '/index.html' : pathname;
    if (!isVendor && relative.split('/').some(segment => segment.startsWith('.'))) {
      throw new RequestError(403, 'forbidden');
    }
    const candidate = isVendor ? vendor.file : path.resolve(publicDir, '.' + relative);
    if (!isVendor && !candidate.startsWith(publicDir + path.sep)) throw new RequestError(403, 'forbidden');
    let filename;
    let stats;
    try {
      filename = await fs.promises.realpath(candidate);
      // Public symlinks are permitted only when their destination stays public; vendor files never leave their root.
      const allowedRoot = await fs.promises.realpath(isVendor ? vendor.root : publicDir);
      if (!filename.startsWith(allowedRoot + path.sep)) throw isVendor ? new RequestError(404, 'not found') : new RequestError(403, 'forbidden');
      stats = await fs.promises.stat(filename);
      if (!stats.isFile()) throw new RequestError(404, 'not found');
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new RequestError(404, 'not found');
      throw error;
    }
    const extension = path.extname(filename).toLowerCase();
    const headers = {
      'Content-Type': MIME[extension] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin'
    };
    // Unversioned URLs keep their old policies; a URL carrying the current version is cached forever, so a returning
    // player's browser loads the game without asking the server again. index.html is always revalidated.
    const isIndex = !isVendor && filename === indexFile;
    const requested = isVendor ? null : requestQuery(req).get('v');
    const currentVersion = isIndex || requested ? await assetVersion() : null;
    if (isVendor) headers['Cache-Control'] = vendor.versioned ? (vendor.current ? IMMUTABLE : 'no-cache') : 'public, max-age=86400';
    else if (!isIndex && requested && requested === currentVersion) headers['Cache-Control'] = IMMUTABLE;

    if (stats.size > MAX_CACHED_FILE) {
      const etag = `"${stats.size.toString(16)}-${Math.trunc(stats.mtimeMs).toString(16)}"`;
      Object.assign(headers, { 'ETag': etag, 'Last-Modified': stats.mtime.toUTCString() });
      if (etagMatches(req, [etag])) { res.writeHead(304, headers); res.end(); return; }
      res.writeHead(200, { ...headers, 'Content-Length': stats.size });
      if (req.method === 'HEAD') return res.end();
      const stream = fs.createReadStream(filename);
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
      return;
    }

    const entry = await loadAsset(filename, stats);
    let rep = entry.rep;
    if (isIndex) rep = await derive(entry, 'index:' + currentVersion, html => renderIndex(html, currentVersion));
    else if (extension === '.css' && headers['Cache-Control'] === IMMUTABLE) rep = await derive(entry, 'css:' + currentVersion, css => renderStylesheet(css, currentVersion));
    else headers['Last-Modified'] = stats.mtime.toUTCString();

    const accepted = acceptedEncodings(req);
    const encoding = rep.br && accepted.has('br') ? 'br' : rep.gz && accepted.has('gzip') ? 'gzip' : null;
    const body = encoding === 'br' ? rep.br : encoding === 'gzip' ? rep.gz : rep.body;
    headers['ETag'] = encoding ? rep.etag.slice(0, -1) + '-' + (encoding === 'br' ? 'br' : 'gz') + '"' : rep.etag;
    if (rep.br || rep.gz) headers['Vary'] = 'Accept-Encoding';
    if (encoding) headers['Content-Encoding'] = encoding;
    const tags = [rep.etag, rep.etag.slice(0, -1) + '-br"', rep.etag.slice(0, -1) + '-gz"'];
    if (etagMatches(req, tags)) { delete headers['Content-Encoding']; res.writeHead(304, headers); res.end(); return; }
    res.writeHead(200, { ...headers, 'Content-Length': body.length });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const pathname = requestPath(req);
      if (pathname === '/api/scores') {
        if (req.method === 'GET' || req.method === 'HEAD') return serveBoard(req, res);
        if (req.method !== 'POST') return json(req, res, 405, { error: 'method not allowed' }, { Allow: 'GET, HEAD, POST' });
        const ip = requestIP(req);
        const now = Date.now();
        const previous = lastPost.get(ip);
        if (previous !== undefined && now - previous < scoreCooldownMs) {
          return json(req, res, 429, { error: 'slow down' }, { 'Retry-After': Math.ceil((scoreCooldownMs - now + previous) / 1000) });
        }
        if (lastPost.size >= 10000 && !lastPost.has(ip)) lastPost.delete(lastPost.keys().next().value);
        lastPost.set(ip, now);
        let body;
        try { body = JSON.parse(await readBody(req, 2048)); }
        catch (error) { throw error instanceof RequestError ? error : new RequestError(400, 'bad request'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError(400, 'invalid score');
        const run = cleanRun(typeof body.uid === 'string' ? body.uid : '', body, now);
        if (!run) throw new RequestError(400, 'invalid score');
        const id = recordKey(run);
        const current = scores[id];
        const improved = !current || compareRuns(run, current) < 0;
        if (improved) scores[id] = run;
        else if (current.name !== run.name) current.name = run.name;
        board = null;
        scheduleSave();
        const best = scores[id];
        return json(req, res, 200, { ok: true, improved, best: { escaped: best.escaped, time: best.time, score: best.score, kills: best.kills } });
      }
      if (pathname === '/health' && (req.method === 'GET' || req.method === 'HEAD')) return send(req, res, 200, 'text/plain; charset=utf-8', 'ok');
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(req, res, 405, { error: 'method not allowed' }, { Allow: 'GET, HEAD' });
      if (pathname === '/favicon.ico') return send(req, res, 204, 'image/x-icon', '');
      await serveAsset(req, res, pathname);
    } catch (error) {
      const status = error instanceof RequestError ? error.status : 500;
      if (status === 500) logError(error);
      if (res.headersSent) res.destroy();
      else json(req, res, status, { error: status === 500 ? 'server error' : error.message });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;

  // Wire format: join -> joined/full, presence -> peer (kept for late joiners), emit -> event (not kept), leave -> left.
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8 * 1024, perMessageDeflate: false });

  function outText(ws, text) {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 256 * 1024) { ws.terminate(); return; }
    try { ws.send(text, error => { if (error) ws.terminate(); }); }
    catch { ws.terminate(); }
  }
  function out(ws, message) { outText(ws, JSON.stringify(message)); }
  // One serialization for the whole room. A `droppable` message (a pose frame, replaced by the next one a moment
  // later) is skipped for a member whose connection is backed up: queued behind the backlog it would only arrive
  // stale, and make the backlog longer.
  function relay(room, from, message, droppable) {
    let text = null;
    for (const [id, member] of room) {
      if (id === from) continue;
      if (droppable && member.ws.bufferedAmount > 24 * 1024) continue;
      if (text === null) text = JSON.stringify(message);
      outText(member.ws, text);
    }
  }

  function leave(ws, roomName) {
    const room = rooms.get(roomName);
    ws.rooms.delete(roomName);
    if (!room || !room.delete(ws.peerId)) return;
    for (const member of room.values()) out(member.ws, { t: 'left', room: roomName, peer: ws.peerId });
    if (!room.size) rooms.delete(roomName);
  }

  wss.on('connection', ws => {
    ws.peerId = 'p' + randomBytes(9).toString('hex');
    ws.rooms = new Set();
    ws.alive = true;
    ws.budget = 120;
    ws.budgetAt = Date.now();
    ws.on('pong', () => { ws.alive = true; });
    // Protocol and payload-limit errors belong to this client, not the process.
    ws.on('error', () => {});
    ws.on('message', (raw, isBinary) => {
      const now = Date.now();
      // 100 messages a second, 200 in a burst: a player sends 30 pose frames a second and state changes besides.
      ws.budget = Math.min(200, ws.budget + (now - ws.budgetAt) * 0.1);
      ws.budgetAt = now;
      if (ws.budget < 1) return;
      ws.budget -= 1;
      let message;
      try { if (isBinary) return; message = JSON.parse(raw.toString()); }
      catch { return out(ws, { t: 'error', code: 'invalid_message' }); }
      if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.room !== 'string' || !ROOM_RE.test(message.room)) return;
      if (message.t === 'join') {
        let room = rooms.get(message.room);
        if (!ws.rooms.has(message.room) && ws.rooms.size >= maxRoomsPerConnection) return out(ws, { t: 'full', room: message.room, code: 'room_limit' });
        if (!room && rooms.size >= maxRooms) return out(ws, { t: 'full', room: message.room, code: 'server_busy' });
        if (room && !room.has(ws.peerId) && room.size >= 4) return out(ws, { t: 'full', room: message.room });
        if (!room) { room = new Map(); rooms.set(message.room, room); }
        const alreadyJoined = room.has(ws.peerId);
        if (!alreadyJoined) room.set(ws.peerId, { ws, pr: {} });
        ws.rooms.add(message.room);
        out(ws, {
          t: 'joined', room: message.room, peer: ws.peerId,
          peers: [...room].filter(([id]) => id !== ws.peerId).map(([peer, member]) => ({ peer, pr: member.pr }))
        });
        if (!alreadyJoined) for (const [id, member] of room) if (id !== ws.peerId) out(member.ws, { t: 'peer', room: message.room, peer: ws.peerId, pr: {} });
      } else if (message.t === 'presence') {
        const room = rooms.get(message.room);
        if (!room || !room.has(ws.peerId) || !message.pr || typeof message.pr !== 'object' || Array.isArray(message.pr)) return;
        try { if (Buffer.byteLength(JSON.stringify(message.pr)) > 4096) return; }
        catch { return; }
        room.get(ws.peerId).pr = message.pr;
        relay(room, ws.peerId, { t: 'peer', room: message.room, peer: ws.peerId, pr: message.pr }, false);
      } else if (message.t === 'emit') {
        // A passing event (the 30-a-second pose frames): relayed to the others in the room, never kept.
        const room = rooms.get(message.room);
        if (!room || !room.has(ws.peerId) || typeof message.e !== 'string' || !EVENT_RE.test(message.e) || message.d === undefined || raw.length > 4096) return;
        relay(room, ws.peerId, { t: 'event', room: message.room, peer: ws.peerId, e: message.e, d: message.d }, true);
      } else if (message.t === 'leave') leave(ws, message.room);
    });
    ws.on('close', () => { for (const roomName of [...ws.rooms]) leave(ws, roomName); });
  });
  wss.on('error', logError);

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false;
      try { ws.ping(); } catch { ws.terminate(); }
    }
  }, options.heartbeatMs ?? 20000);
  heartbeat.unref();
  const sweep = setInterval(() => {
    const cutoff = Date.now() - Math.max(scoreCooldownMs, 60000);
    for (const [ip, at] of lastPost) if (at < cutoff) lastPost.delete(ip);
  }, 60000);
  sweep.unref();

  function listen(port = process.env.PORT === undefined ? 3077 : Number(process.env.PORT), host = process.env.HOST || '127.0.0.1') {
    return new Promise((resolve, reject) => {
      const onError = error => { server.off('listening', onListening); reject(error); };
      const onListening = () => { server.off('error', onError); resolve(server.address()); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
      if (precompress) warmAssets();
    });
  }

  function close() {
    if (closePromise) return closePromise;
    closing = true;
    clearInterval(heartbeat);
    clearInterval(sweep);
    clearTimeout(saveTimer);
    for (const ws of wss.clients) ws.terminate();
    closePromise = (async () => {
      const deadline = setTimeout(() => server.closeAllConnections?.(), 5000);
      deadline.unref();
      try {
        await Promise.all([
          new Promise(resolve => wss.close(resolve)),
          new Promise((resolve, reject) => {
            if (!server.listening) return resolve();
            server.close(error => error ? reject(error) : resolve());
            server.closeIdleConnections?.();
          })
        ]);
        // A request already in flight may have submitted a score while closing.
        await persistScores();
      } finally { clearTimeout(deadline); }
    })();
    return closePromise;
  }

  return { server, wss, rooms, listen, close };
}

if (require.main === module) {
  const app = createGameServer({ precompress: process.env.PRECOMPRESS !== '0' });
  app.listen().then(address => {
    console.log(`The Hollow is running on http://${address.address}:${address.port}`);
  }).catch(async error => {
    console.error('[hollow] Could not start:', error.message);
    process.exitCode = 1;
    await app.close();
  });
  const shutdown = () => app.close().catch(error => {
    console.error('[hollow] Could not save scoreboard:', error.message);
    process.exitCode = 1;
  });
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

module.exports = { createGameServer };
