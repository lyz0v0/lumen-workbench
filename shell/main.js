/* Lumen 工作台 · 最小 Electron 壳
 * 只做四件事：开窗口加载工作台、外链交给系统浏览器、代发联网请求（绕 CORS）、退出即关。 */
const { app, BrowserWindow, Menu, shell, ipcMain } = require('electron');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const VERIFY = process.env.LUMEN_VERIFY === '1';
const TRACE = path.join(__dirname, '_trace.txt');
function trace(m) {
  if (VERIFY) { try { require('fs').appendFileSync(TRACE, new Date().toISOString().slice(11, 23) + ' ' + m + '\n'); } catch (e) {} }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    title: 'Lumen 工作台',
    backgroundColor: '#F6F6F4',
    autoHideMenuBar: true,
    show: true,
    webPreferences: {
      spellcheck: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  /* 原型里的热榜原文、二维码结果等都走新窗口 → 统一交给系统默认浏览器 */
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.loadFile(INDEX_HTML);
  trace('loadFile 调用');

  win.webContents.on('did-start-loading', () => trace('did-start-loading'));
  win.webContents.on('did-finish-load', () => trace('did-finish-load'));
  win.webContents.on('did-fail-load', (_e, c, d) => trace('did-fail-load ' + c + ' ' + d));
  win.webContents.on('render-process-gone', (_e, d) => trace('render-gone ' + JSON.stringify(d)));

  if (VERIFY) {
    win.webContents.once('did-finish-load', async () => {
      trace('验证开始');
      try {
        const info = await win.webContents.executeJavaScript(
          '({ title: document.title, hash: location.hash, ls: (()=>{ try{ localStorage.setItem("__t","1"); localStorage.removeItem("__t"); return "ok"; }catch(e){ return "fail:"+e.message; } })(), tools: (typeof TOOLS !== "undefined" ? TOOLS.length : -1) })',
          true
        );
        trace('executeJavaScript 完成: ' + JSON.stringify(info));
        const img = await win.webContents.capturePage();
        require('fs').writeFileSync(path.join(__dirname, '_verify_shot.png'), img.toPNG());
        trace('截图完成 ' + img.getSize().width + 'x' + img.getSize().height);
        console.log('VERIFY_OK ' + JSON.stringify(info));
      } catch (e) {
        trace('验证异常: ' + e.message);
        console.log('VERIFY_ERR ' + e.message);
      }
      app.exit(0);
    });
  }

  return win;
}

Menu.setApplicationMenu(null);

/* 联网代发：工作台以 file:// 打开时，页面里的 fetch 会被浏览器跨域策略拦掉；
 * 交主进程直连可以绕开（快递查询、后续 AI 请求都走这条通道）。只放行 http/https。 */
ipcMain.handle('lumen:net-fetch', async (_e, url) => {
  const u = String(url || '');
  if (!/^https?:\/\//i.test(u)) return { ok: false, status: 0, error: '只允许 http/https 请求' };
  try {
    const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (Lumen Workbench)' } });
    const text = await r.text();
    const headers = {};
    for (const k of ['ratelimit', 'retry-after', 'x-ratelimit-remaining']) {
      const v = r.headers.get(k);
      if (v) headers[k] = v;
    }
    trace('net-fetch ' + r.status + ' ' + u.slice(0, 90));
    return { ok: r.ok, status: r.status, text, headers };
  } catch (e) {
    trace('net-fetch ERR ' + u.slice(0, 90) + ' ' + ((e && e.message) || e));
    return { ok: false, status: 0, error: String((e && e.message) || e) };
  }
});

/* AI 请求代发：POST + 自定义请求头（Authorization 等）+ SSE 流式转发。
 * 渲染进程只负责拼 body，密钥与请求都由主进程发出，页面侧不产生跨域请求。 */
const chatAborts = new Map();

ipcMain.handle('lumen:chat', async (event, payload) => {
  const p = payload || {};
  const url = String(p.url || '');
  if (!/^https?:\/\//i.test(url)) return { ok: false, status: 0, error: '只允许 http/https 请求' };

  const id = String(p.id || Date.now());
  const ctl = new AbortController();
  chatAborts.set(id, ctl);

  try {
    const r = await fetch(url, {
      method: p.method || 'POST',
      headers: p.headers || {},
      body: p.body,
      signal: ctl.signal
    });
    const ctype = String(r.headers.get('content-type') || '');
    const sse = /text\/event-stream/i.test(ctype);

    if (!r.ok) {
      const text = await r.text();
      trace('chat ' + r.status + ' ' + url.slice(0, 80));
      return { ok: false, status: r.status, text, sse, error: 'HTTP ' + r.status };
    }
    /* 非流式（或服务端不支持流）→ 整体返回 */
    if (!p.stream || !sse || !r.body) {
      const text = await r.text();
      trace('chat ' + r.status + ' (whole ' + text.length + 'B)');
      return { ok: true, status: r.status, text, sse: false };
    }
    /* 流式：边读边推给渲染进程 */
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let all = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = dec.decode(value, { stream: true });
      all += chunk;
      if (!event.sender.isDestroyed()) event.sender.send('lumen:chat-delta', { id, chunk });
    }
    trace('chat ' + r.status + ' (stream ' + all.length + 'B)');
    return { ok: true, status: r.status, text: all, sse: true };
  } catch (e) {
    const aborted = ctl.signal.aborted;
    trace('chat ERR ' + url.slice(0, 80) + ' ' + ((e && e.message) || e));
    return { ok: false, status: 0, aborted, error: String((e && e.message) || e) };
  } finally {
    chatAborts.delete(id);
  }
});

ipcMain.on('lumen:chat-abort', (_e, id) => {
  const c = chatAborts.get(String(id || ''));
  if (c) c.abort();
});

/* 本地工具用不上 GPU 加速：禁 GPU 并把渲染并入主进程，避免 GPU 子进程在无显卡环境下崩溃。
 * no-sandbox：本机（无显卡 VM）渲染进程沙箱起不来；应用只加载本地文件、外链全部交系统浏览器，风险可控。 */
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('no-sandbox');

app.whenReady().then(() => { trace('app ready'); createWindow(); });
app.on('window-all-closed', () => app.quit());
