/* Lumen 工作台 · 屏幕录制壳支持（两个壳共用同一份，改了就两边同步）
 *
 * 页面（file://）自己录不了屏，必须由主进程补三件浏览器给不了的能力：
 *   1) 列屏幕/窗口 —— desktopCapturer，顺带出缩略图给页面的选择卡片用
 *   2) 放行捕获请求 —— setDisplayMediaRequestHandler；**不注册这一条，
 *      页面里调用 getDisplayMedia 会直接抛 NotSupportedError（已实测）**
 *   3) 系统声音 —— handler 里回 audio:'loopback'（Windows 专有），
 *      拿到的是 48kHz 单声道音轨
 * 另外两件工程上的事：
 *   4) 录制数据流式落盘：MediaRecorder 的分片直接写文件，不把整段录制
 *      攒成 Blob 留在内存里（1 小时 1080p 攒内存要 1.8GB）
 *   5) 全局快捷键停止录制：录全屏时工作台窗口被挡住，得有个能按的键
 */
'use strict';

const path = require('path');
const fs = require('fs');
const {
  app, ipcMain, dialog, session, desktopCapturer, globalShortcut, BrowserWindow, shell
} = require('electron');

const HOTKEY = 'Control+Shift+F9';
const THUMB = { width: 320, height: 180 };

let pendingSourceId = '';          /* 页面选中的源，下一次捕获请求用它 */
const writers = new Map();         /* id → { stream, file, bytes } */
let hotkeyOK = false;
let trace = () => {};

/* ---------- 工具 ---------- */

function safeName(n) {
  const s = String(n || '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim();
  return s.slice(0, 120) || 'recording';
}

function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let p = path.join(dir, name);
  let i = 2;
  while (fs.existsSync(p)) p = path.join(dir, base + ' (' + (i++) + ')' + ext);
  return p;
}

function isScreen(id) { return /^screen:/.test(String(id || '')); }

/* ---------- 对外装配 ---------- */

function wire(opts) {
  opts = opts || {};
  if (typeof opts.trace === 'function') trace = opts.trace;

  /* 1) 放行捕获：没有这一段，页面里的 getDisplayMedia 直接报 NotSupportedError */
  try {
    session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen', 'window'],
          thumbnailSize: { width: 0, height: 0 }
        });
        let src = sources.find(s => s.id === pendingSourceId);
        if (!src) src = sources.find(s => isScreen(s.id)) || sources[0];
        if (!src) { trace('displayMedia：找不到可录的源'); return callback({}); }
        const res = { video: src };
        if (request && request.audioRequested) res.audio = 'loopback';
        trace('displayMedia 放行 ' + src.id + ' audio=' + (res.audio || '-'));
        callback(res);
      } catch (e) {
        trace('displayMedia 异常 ' + ((e && e.message) || e));
        callback({});
      }
    }, { useSystemPicker: false });
  } catch (e) {
    trace('displayMedia handler 注册失败 ' + ((e && e.message) || e));
  }

  /* 2) 列源（含缩略图） */
  ipcMain.handle('lumen:rec-sources', async () => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: THUMB,
        fetchWindowIcons: false
      });
      const out = sources.map(s => {
        let thumb = '';
        try { thumb = s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : ''; } catch (e) {}
        return {
          id: s.id,
          name: s.name || (isScreen(s.id) ? '屏幕' : '窗口'),
          kind: isScreen(s.id) ? 'screen' : 'window',
          thumb
        };
      });
      trace('列源 ' + out.length + ' 个');
      return { ok: true, sources: out };
    } catch (e) {
      trace('列源失败 ' + ((e && e.message) || e));
      return { ok: false, sources: [], error: String((e && e.message) || e) };
    }
  });

  /* 3) 记住页面选的源 */
  ipcMain.handle('lumen:rec-pick', (_e, id) => {
    pendingSourceId = String(id || '');
    return { ok: true, id: pendingSourceId };
  });

  /* 4) 目录：默认「视频/Lumen 录制」，可让用户另选 */
  ipcMain.handle('lumen:rec-dir', () => {
    let dir;
    try { dir = path.join(app.getPath('videos'), 'Lumen 录制'); }
    catch (e) { dir = path.join(app.getPath('home'), 'Lumen 录制'); }
    return { ok: true, dir, exists: fs.existsSync(dir) };
  });

  ipcMain.handle('lumen:rec-choose-dir', async (_e, current) => {
    try {
      const r = await dialog.showOpenDialog({
        title: '选择录制文件的保存位置',
        defaultPath: String(current || '') || app.getPath('videos'),
        properties: ['openDirectory', 'createDirectory'],
        buttonLabel: '用这个文件夹'
      });
      if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, canceled: true };
      const dir = r.filePaths[0];
      /* 用户可能在对话框里新建了文件夹，这里保证它真的存在 */
      try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
      trace('录制目录改为 ' + dir);
      return { ok: true, dir };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  ipcMain.handle('lumen:rec-open-dir', async (_e, dir) => {
    try {
      const d = String(dir || '');
      if (d && fs.existsSync(d)) await shell.openPath(d);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  /* 5) 落盘：prepare → write*N → finish */
  ipcMain.handle('lumen:rec-prepare', async (_e, payload) => {
    const p = payload || {};
    try {
      const dir = String(p.dir || '');
      if (!dir) return { ok: false, error: '没有保存位置' };
      fs.mkdirSync(dir, { recursive: true });          /* 目录不在就建 */
      if (p.sourceId) pendingSourceId = String(p.sourceId);
      const file = uniquePath(dir, safeName(p.name));
      const stream = fs.createWriteStream(file);
      const id = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      let bytes = 0;
      stream.on('error', e => trace('写流异常 ' + id + ' ' + ((e && e.message) || e)));
      writers.set(id, { stream, file, bytes });
      await new Promise((res, rej) => {
        stream.once('open', res);
        stream.once('error', rej);
      });
      trace('开始写 ' + file);
      return { ok: true, id, path: file };
    } catch (e) {
      trace('prepare 失败 ' + ((e && e.message) || e));
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  ipcMain.handle('lumen:rec-chunk', async (_e, id, chunk) => {
    const w = writers.get(String(id || ''));
    if (!w) return { ok: false, error: '录制会话不存在' };
    try {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      w.bytes += buf.length;
      /* 等 drain：写盘慢时让页面侧自然节流，别把内存堆起来 */
      if (!w.stream.write(buf)) {
        await new Promise(res => w.stream.once('drain', res));
      }
      return { ok: true, bytes: w.bytes };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  ipcMain.handle('lumen:rec-finish', async (_e, id) => {
    const key = String(id || '');
    const w = writers.get(key);
    if (!w) return { ok: false, error: '录制会话不存在' };
    writers.delete(key);
    try {
      await new Promise((res, rej) => {
        w.stream.end(() => res());
        w.stream.once('error', rej);
      });
      trace('写完 ' + w.file + ' ' + w.bytes + 'B');
      return { ok: true, path: w.file, bytes: w.bytes };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  ipcMain.handle('lumen:rec-abort', async (_e, id) => {
    const key = String(id || '');
    const w = writers.get(key);
    if (!w) return { ok: false };
    writers.delete(key);
    try {
      await new Promise(res => w.stream.close(() => res()));
      fs.unlinkSync(w.file);                            /* 用户主动取消，别留半个文件 */
      trace('取消并删除 ' + w.file);
    } catch (e) {}
    return { ok: true };
  });

  /* 6) 删除已保存的录制文件（页面列表里的「删除」） */
  ipcMain.handle('lumen:rec-delete', async (_e, file) => {
    const p = String(file || '');
    if (!p) return { ok: false, error: '没有文件路径' };
    try {
      await fs.promises.unlink(p);
      trace('删除 ' + p);
      return { ok: true };
    } catch (e) {
      const msg = e && e.code === 'ENOENT' ? '文件已经不在了' : String((e && e.message) || e);
      return { ok: false, error: msg };
    }
  });

  /* 7) 重排通道：页面把分片 MP4 重排成普通 MP4（进度条可拖）。
   * rd = 按范围读原文件（页面解析 moof 用）；remux = 主进程流式「新头 + 拷范围」覆盖原文件 */
  ipcMain.handle('lumen:rec-rd', async (_e, payload) => {
    const p = payload || {};
    try {
      const fh = await fs.promises.open(String(p.path || ''), 'r');
      try {
        const st = await fh.stat();
        const want = Math.max(0, Math.min(Number(p.length) || 0, 8 * 1024 * 1024));
        const buf = Buffer.alloc(want);
        const { bytesRead } = await fh.read(buf, 0, want, Number(p.offset) || 0);
        return { ok: true, size: st.size, buf: buf.buffer.slice(buf.byteOffset, buf.byteOffset + bytesRead) };
      } finally { await fh.close(); }
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  ipcMain.handle('lumen:rec-remux', async (_e, payload) => {
    const p = payload || {};
    try {
      const src = String(p.path || '');
      if (!src || !p.header) return { ok: false, error: '参数不全' };
      const tmp = src + '.muxing';
      const out = fs.createWriteStream(tmp);
      out.write(Buffer.from(p.header));
      for (const r of (p.ranges || [])) {
        if (!r || !(r.len > 0)) continue;               /* 空碎片会产生 len=0 的区间，跳过 */
        await new Promise((res, rej) => {
          const rs = fs.createReadStream(src, { start: r.off, end: r.off + r.len - 1 });
          rs.once('error', rej); out.once('error', rej);
          rs.pipe(out, { end: false });
          rs.once('end', res);
        });
      }
      await new Promise((res, rej) => { out.end(res); out.once('error', rej); });
      fs.renameSync(tmp, src);
      const bytes = fs.statSync(src).size;
      trace('重排完成 ' + src + ' ' + bytes + 'B');
      return { ok: true, bytes };
    } catch (e) {
      try { const t = String(p.path || '') + '.muxing'; if (fs.existsSync(t)) fs.unlinkSync(t); } catch (e2) {}
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  /* 8) 全局快捷键：录全屏时页面被挡住，靠它停 */
  try {
    hotkeyOK = globalShortcut.register(HOTKEY, () => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.webContents.isDestroyed()) w.webContents.send('lumen:rec-hotkey');
      }
    });
  } catch (e) { hotkeyOK = false; }
  trace('停止快捷键 ' + (hotkeyOK ? HOTKEY : '注册失败'));

  app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch (e) {} });

  /* 页面侧想知道快捷键是否可用 */
  ipcMain.handle('lumen:rec-info', () => ({ ok: true, hotkey: HOTKEY, hotkeyOK, electron: process.versions.electron }));
}

module.exports = { wire, HOTKEY };
