/* Lumen 工作台 · 轻量壳内置的本地端口服务
 *
 * 三件事：
 *   1) 把工作台三文件（index.html / app.js / style.css）从固定的本地端口发出去，
 *      浏览器打开 http://127.0.0.1:17870 就能看到跟壳里一样的界面；
 *   2) 壳窗口自己也走这个端口加载 —— 与浏览器同源，localStorage / IndexedDB 天然共享，
 *      不需要任何“同步”代码（改设置、填 Key、换壁纸，两边都是同一份）；
 *   3) 同源中继 /__lumen/net 与 /__lumen/chat：把壳主进程的联网代发能力开放给浏览器侧，
 *      浏览器里热榜官方源、AI 对话同样可用（否则会被 CORS 拦）。
 *
 * 只绑 127.0.0.1：同局域网其它设备访问不到。
 * 固定端口被占用时自动往后找（17870 → 17871 → …），最多试 20 个。
 *
 * 出网统一用调用方注入的 fetchImpl —— 壳里传的是 Electron 的 net.fetch，
 * 它走 Chromium 网络栈、会读系统代理；Node 原生 fetch 不读代理，
 * 会让需要走代理的接口（比如 api.openai.com）在中继里全部失败。 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const HOST = '127.0.0.1';
const DEFAULT_PORT = 17870;
const PORT_TRIES = 20;

/* 中继必须带这个自定义头。第三方网页发它必然触发 CORS 预检，
 * 而本服务不返回任何 Access-Control-Allow-* 头 → 预检失败 → 偷用不了。 */
const RELAY_HEADER = 'x-lumen-relay';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8'
};

function sendJSON(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(s),
    'Cache-Control': 'no-store'
  });
  res.end(s);
}

function readBody(req, limit) {
  const cap = limit || 32 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', c => {
      n += c.length;
      if (n > cap) { reject(new Error('请求体过大')); try { req.destroy(); } catch (e) {} return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* 只放行带自定义头、且 Origin 为本机同源的请求 */
function relayAllowed(req) {
  if (String(req.headers[RELAY_HEADER] || '') !== '1') return false;
  const o = String(req.headers.origin || '');
  if (!o) return true;                                   /* 同源 GET 不带 Origin */
  const host = String(req.headers.host || '');
  return o === 'http://' + host || o === 'https://' + host;
}

function serveStatic(res, root, pathname) {
  let rel = pathname;
  if (!rel || rel === '/') rel = '/index.html';
  let decoded = rel;
  try { decoded = decodeURIComponent(rel); } catch (e) {}
  const full = path.normalize(path.join(root, decoded));
  const base = path.normalize(root + path.sep);
  if (!full.startsWith(base)) return sendJSON(res, 403, { ok: false, error: 'forbidden' });

  fs.readFile(full, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('404');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store'                          /* 本地开发：改了刷新就能看到 */
    });
    res.end(buf);
  });
}

/* 只读抓取中继：与壳内 IPC lumen:net-fetch 返回结构完全一致 */
async function handleNet(req, res, urlObj, doFetch) {
  let target = urlObj.searchParams.get('url') || '';
  if (!target && req.method === 'POST') {
    try {
      const j = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8'));
      target = (j && j.url) || '';
    } catch (e) {}
  }
  if (!/^https?:\/\//i.test(target)) return sendJSON(res, 400, { ok: false, status: 0, error: '只允许 http/https 请求' });
  try {
    const r = await doFetch(target, { headers: { 'User-Agent': 'Mozilla/5.0 (Lumen Workbench)' } });
    const text = await r.text();
    const headers = {};
    for (const k of ['ratelimit', 'retry-after', 'x-ratelimit-remaining']) {
      const v = r.headers.get(k);
      if (v) headers[k] = v;
    }
    sendJSON(res, 200, { ok: r.ok, status: r.status, text, headers });
  } catch (e) {
    sendJSON(res, 200, { ok: false, status: 0, error: String((e && e.message) || e) });
  }
}

/* AI 中继：透明透传（状态码 + content-type + 响应体），
 * 页面侧因此可以用与“浏览器直连”完全相同的代码读 SSE，无需另写解析。 */
async function handleChat(req, res, doFetch) {
  let p;
  try { p = JSON.parse((await readBody(req, 48 * 1024 * 1024)).toString('utf8')); }
  catch (e) { return sendJSON(res, 400, { ok: false, status: 0, error: '请求体解析失败' }); }

  const url = String((p && p.url) || '');
  if (!/^https?:\/\//i.test(url)) return sendJSON(res, 400, { ok: false, status: 0, error: '只允许 http/https 请求' });

  const ctl = new AbortController();
  const onClose = () => { try { ctl.abort(); } catch (e) {} };
  res.on('close', onClose);                                /* 页面断开 → 中止上游，别白烧 token */

  try {
    const r = await doFetch(url, {
      method: (p && p.method) || 'POST',
      headers: (p && p.headers) || {},
      body: p && p.body,
      signal: ctl.signal
    });
    const ctype = String(r.headers.get('content-type') || 'application/octet-stream');
    res.writeHead(r.status, { 'Content-Type': ctype, 'Cache-Control': 'no-store' });
    try { res.flushHeaders(); } catch (e) {}
    if (!r.body) { res.end(await r.text()); return; }

    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (e) {
    if (res.headersSent) { try { res.end(); } catch (_) {} }
    else sendJSON(res, 200, { ok: false, status: 0, error: String((e && e.message) || e) });
  } finally {
    res.removeListener('close', onClose);
  }
}

/* 探活：这个端口上住的是不是我们自己的服务。
 * 端口被占时必须分清两种情况 ——
 *   · 占用者是上次残留的 Lumen（僵尸壳 / 没退干净）：得提醒用户去结束它；
 *   · 占用者是别的程序：往后找个空端口就行，与它无关。
 * 只读判断，任何情况下都不"连上去凑合用"。 */
function probe(port, timeoutMs) {
  const ms = Number(timeoutMs) || 600;
  return new Promise(resolve => {
    const out = { port: Number(port) || 0, reachable: false, isLumen: false, version: '', pid: 0, error: '' };
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(out); } };
    let req;
    try {
      req = http.request({
        host: HOST, port: out.port, path: '/__lumen/info', method: 'GET', timeout: ms,
        headers: { [RELAY_HEADER]: '1' }
      }, res => {
        let s = '';
        res.setEncoding('utf8');
        res.on('data', c => {
          s += c;
          if (s.length > 8192) { try { req.destroy(); } catch (e) {} }
        });
        res.on('end', () => {
          out.reachable = true;
          try {
            const j = JSON.parse(s);
            if (j && j.app === 'lumen-workbench') {
              out.isLumen = true;
              out.version = String(j.version || '');
              out.pid = Number(j.pid) || 0;
            }
          } catch (e) {}
          done();
        });
        res.on('error', done);
      });
    } catch (e) { out.error = String((e && e.message) || e); return done(); }
    req.on('timeout', () => { out.error = 'timeout'; try { req.destroy(); } catch (e) {} done(); });
    req.on('error', e => { out.error = String((e && e.message) || e); done(); });
    try { req.end(); } catch (e) { done(); }
  });
}

function createServer(opts) {
  const root = opts.root;
  const version = opts.version || '';
  const doFetch = opts.fetchImpl || globalThis.fetch;

  const server = http.createServer(async (req, res) => {
    let urlObj;
    try { urlObj = new URL(req.url, 'http://' + (req.headers.host || HOST)); }
    catch (e) { return sendJSON(res, 400, { ok: false, error: 'bad url' }); }

    const p = urlObj.pathname;

    if (p.startsWith('/__lumen/')) {
      if (!relayAllowed(req)) return sendJSON(res, 403, { ok: false, error: 'relay forbidden' });
      if (p === '/__lumen/info') {
        const addr = server.address() || {};
        /* pid 是给探活用的：端口被占时能指出占用者是不是自己人 */
        return sendJSON(res, 200, { ok: true, app: 'lumen-workbench', version, mode: 'http', port: addr.port || 0, pid: process.pid });
      }
      if (p === '/__lumen/net') return void handleNet(req, res, urlObj, doFetch);
      if (p === '/__lumen/chat') return void handleChat(req, res, doFetch);
      return sendJSON(res, 404, { ok: false, error: 'unknown relay' });
    }

    serveStatic(res, root, p);
  });

  return server;
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    function cleanup() {
      server.removeListener('error', onErr);
      server.removeListener('listening', onOk);
    }
    function onErr(e) { cleanup(); reject(e); }
    function onOk() { cleanup(); resolve(); }
    server.once('error', onErr);
    server.once('listening', onOk);
    server.listen(port, HOST);
  });
}

/* 起服务；固定端口被占就往后找。
 * 每遇到一个被占的端口先探一次活，把「谁占的」记进 diagnostics ——
 * 壳会把它显示在状态页上，用户一眼能看出是自己残留的实例还是别的程序。 */
async function start(opts) {
  const o = opts || {};
  const root = o.root;
  const startPort = Number(o.port) || DEFAULT_PORT;
  const tries = Number(o.tries) || PORT_TRIES;
  const diagnostics = [];
  let lastErr = null;

  for (let i = 0; i < tries; i++) {
    const tryPort = startPort + i;
    const server = createServer({ root, version: o.version || '', fetchImpl: o.fetchImpl });
    try {
      await listen(server, tryPort);
      return {
        ok: true,
        port: tryPort,
        server,
        diagnostics,
        close: () => new Promise(r => { try { server.close(() => r()); } catch (e) { r(); } })
      };
    } catch (e) {
      lastErr = e;
      try { server.close(); } catch (_) {}
      if (!e || e.code !== 'EADDRINUSE') break;            /* 非端口占用（权限等）不必再试 */
      const d = await probe(tryPort);
      diagnostics.push({
        port: tryPort,
        by: d.isLumen ? 'lumen' : (d.reachable ? 'other' : 'unknown'),
        version: d.version,
        pid: d.pid,
        error: d.error
      });
    }
  }
  return {
    ok: false,
    error: String((lastErr && lastErr.message) || lastErr || '端口不可用'),
    diagnostics
  };
}

module.exports = { start, probe, HOST, DEFAULT_PORT, PORT_TRIES };
