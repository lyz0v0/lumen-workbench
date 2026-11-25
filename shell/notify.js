/* Lumen 桌面灵动岛 · 系统通知桥
 *
 * 数据源是 Windows 通知平台的本地库（%LOCALAPPDATA%\Microsoft\Windows\Notifications\
 * wpndatabase.db）。为什么不用 UI Automation 抓 toast 窗口：Win11 的 toast 宿主窗口
 * 对 UIA 客户端整体不可见（根元素枚举不到、WindowOpened / StructureChanged 事件
 * 永不触发），实机验证过；数据库是通知中心自己渲染用的同一份数据，勿扰模式下也照常
 * 写入，而且能拿到发送方 AUMID。
 *
 * 读取由常驻 PowerShell 完成（Add-Type P/Invoke 系统自带的 winsqlite3.dll，只读打开，
 * 零第三方依赖），主进程只读它的 stdout 行，和媒体桥（media.js）同款结构。
 *
 * 对外 API：
 *   start(cb)   启动轮询；cb(items) 在收到新通知时回调（items 为完整列表，新的在前）
 *   stop()      停止
 *   last()      最近一次列表（页面首屏直接拿）
 *   clear()     清空已收集的通知（不动 lastId，不会把旧通知重新拉回来）
 *   alive()     桥是否真的在跑
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const readline = require('readline');

let BIN_DIR = '';
let DATA_FILE = '';
const MAX_ITEMS = 20;

const PS = (() => {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
})();
const SCRIPT_NAME = 'notify-poll.ps1';
const PS_ARGS = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File'];

let proc = null;
let rl = null;
let cb = null;
let stopping = false;
let lastLineAt = 0;
let watchdog = null;
let restartTimer = null;
let failCount = 0;
let items = [];          /* 新的在前 */
let lastId = 0;
let loaded = false;

function ensureScripts() {
  let base = '';
  try { base = require('electron').app.getPath('userData'); } catch (e) {}
  if (!base) base = require('os').tmpdir();
  const dir = path.join(base, 'bin');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  try {
    const src = fs.readFileSync(path.join(__dirname, SCRIPT_NAME));
    const dst = path.join(dir, SCRIPT_NAME);
    let old = null;
    try { old = fs.readFileSync(dst); } catch (e) {}
    if (!old || !old.equals(src)) fs.writeFileSync(dst, src);
  } catch (e) {
    console.log('[island] 通知脚本准备失败 ' + ((e && e.message) || e));
  }
  BIN_DIR = dir;
  DATA_FILE = path.join(base, 'notify.json');
}

function load() {
  if (loaded) return;
  loaded = true;
  if (!DATA_FILE) ensureScripts();
  try {
    const j = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (j && Array.isArray(j.items)) items = j.items.slice(0, MAX_ITEMS);
    if (j && typeof j.lastId === 'number') lastId = j.lastId;
  } catch (e) {}
}

function save() {
  if (!DATA_FILE) return;
  try { fs.writeFileSync(DATA_FILE, JSON.stringify({ lastId: lastId, items: items })); } catch (e) {}
}

function emit() {
  if (typeof cb === 'function') { try { cb(items); } catch (e) {} }
}

function merge(incoming) {
  if (!Array.isArray(incoming) || !incoming.length) return false;
  const seen = {};
  for (const it of items) seen[String(it.id)] = 1;
  let added = 0;
  for (const it of incoming) {
    const id = String(it && it.id);
    if (!it || seen[id]) continue;
    /* 同一条通知重复推送（WAL checkpoint 后偶发）按 id 去重 */
    seen[id] = 1;
    items.push(it);
    added++;
    if (typeof it.id === 'number' && it.id > lastId) lastId = it.id;
  }
  if (!added) return false;
  items.sort((a, b) => (b.id || 0) - (a.id || 0));
  if (items.length > MAX_ITEMS) items = items.slice(0, MAX_ITEMS);
  save();
  return true;
}

function launch() {
  if (stopping) return;
  if (!BIN_DIR) ensureScripts();
  load();
  let p;
  try {
    p = spawn(PS, [...PS_ARGS, path.join(BIN_DIR, SCRIPT_NAME), '-Parent', String(process.pid),
      '-Since', String(lastId || 0), '-SinceTime', String(Date.now())],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    failCount++;
    if (failCount <= 3) console.log('[island] 通知轮询启动失败 ' + ((e && e.message) || e));
    return;
  }
  proc = p;
  lastLineAt = Date.now();

  if (p.stdout) {
    p.stdout.setEncoding('utf8');
    rl = readline.createInterface({ input: p.stdout });
    rl.on('line', line => {
      lastLineAt = Date.now();
      const t = String(line || '').trim();
      if (!t || t[0] !== '{') return;
      let j = null;
      try { j = JSON.parse(t); } catch (e) { return; }
      if (!j) return;
      if (j.hb) return;
      if (j.ok === false) { failCount++; return; }
      failCount = 0;
      if (j.items && merge(j.items)) emit();
    });
  }
  if (p.stderr) {
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', d => {
      const s = String(d || '').trim();
      if (s) console.log('[island] notify ps stderr ' + s.slice(0, 200));
    });
  }
  p.on('error', e => console.log('[island] 通知轮询进程错误 ' + ((e && e.message) || e)));
  p.on('exit', () => {
    proc = null;
    if (rl) { try { rl.close(); } catch (e) {} rl = null; }
    if (stopping) return;
    /* 脚本自己退了（数据库被锁、PowerShell 崩）→ 1.5 秒后重拉 */
    restartTimer = setTimeout(launch, 1500);
  });
}

function start(onItems) {
  if (typeof onItems === 'function') cb = onItems;
  if (proc) return;
  stopping = false;
  failCount = 0;
  ensureScripts();
  load();
  launch();
  if (!watchdog) {
    watchdog = setInterval(() => {
      if (stopping || !proc) return;
      if (Date.now() - lastLineAt > 13000) {
        try { proc.kill(); } catch (e) {}
      }
    }, 6000);
  }
}

function stop() {
  stopping = true;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  if (watchdog) { clearInterval(watchdog); watchdog = null; }
  if (rl) { try { rl.close(); } catch (e) {} rl = null; }
  if (proc) { try { proc.kill(); } catch (e) {} proc = null; }
  cb = null;
}

function last() { return items; }

function clear() {
  items = [];
  save();
  emit();
}

function alive() { return !!proc && (Date.now() - lastLineAt) < 16000; }

module.exports = { start, stop, last, clear, alive };
