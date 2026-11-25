/* Lumen 桌面灵动岛 · 系统媒体会话桥（Windows SMTC）
 *
 * Electron 没有读取「系统正在播放什么」的 API，Windows 上唯一现成的入口是
 * SMTC（GlobalSystemMediaTransportControlsSessionManager），只有 WinRT 能调。
 * 所以这里挂一个常驻 PowerShell 进程做轮询，主进程只读它的 stdout（JSON 行）。
 *
 * 为什么常驻：单次 powershell 启动约 700ms，1 秒轮询若是每次起进程会白烧 CPU；
 * 常驻进程初始化一次后每轮只要几毫秒，改成「有变化才输出 + 10 秒心跳」几乎零开销。
 *
 * 对外 API：
 *   start(cb)   启动轮询，状态变化时 cb(state)；重复调用安全（先停再起）
 *   stop()      退出轮询进程
 *   last()      最近一次状态（页面首屏直接拿，不用等下一轮）
 *   command(a)  发送播放控制：toggle / next / prev / seek（seek 需第二参数秒数）
 *
 * state 形状（页面侧只认这些字段）：
 *   { ok:true, session:null }
 *   { ok:true, app, title, artist, album, status:'Playing'|'Paused'|'Stopped',
 *     pos, dur, canPlay, canNext, canPrev, art:'data:image/...;base64,..', track:true }
 *   art 只在切歌时下发（几十 KB 的 base64，别每轮重复传）
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const readline = require('readline');

/* 打包后 shell/ 在 app.asar 里，PowerShell 打不开 asar 虚拟路径 —— 所以启动时
 * 把两个脚本按内容同步到 userData/bin/（内容变了才重写），再从那跑。
 * 开发态也一样跑这套，省得两种形态两套路径。 */
let BIN_DIR = '';
let QUEUE_FILE = '';
function ensureScripts() {
  let base = '';
  try { base = require('electron').app.getPath('userData'); } catch (e) {}
  if (!base) base = require('os').tmpdir();
  const dir = path.join(base, 'bin');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  for (const f of ['media-poll.ps1', 'media-cmd.ps1']) {
    try {
      const src = fs.readFileSync(path.join(__dirname, f));
      const dst = path.join(dir, f);
      let old = null;
      try { old = fs.readFileSync(dst); } catch (e) {}
      if (!old || !old.equals(src)) fs.writeFileSync(dst, src);
    } catch (e) {
      console.log('[island] 媒体脚本准备失败 ' + f + ' ' + ((e && e.message) || e));
    }
  }
  BIN_DIR = dir;
  QUEUE_FILE = path.join(dir, 'media-cmd.txt');
  return dir;
}

const PS = (() => {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const p = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return p;
})();
const SCRIPT_POLL_NAME = 'media-poll.ps1';
const SCRIPT_CMD_NAME = 'media-cmd.ps1';
const PS_ARGS = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File'];

let proc = null;
let rl = null;
let cb = null;
let fgCb = null;
let lastFg = null;
let lastState = { ok: true, session: null };
let stopping = false;
let lastLineAt = 0;
let watchdog = null;
let restartTimer = null;
let failCount = 0;

function emit(s) {
  lastState = s;
  if (typeof cb === 'function') { try { cb(s); } catch (e) {} }
}

function launch() {
  if (stopping) return;
  if (!BIN_DIR) ensureScripts();
  let p;
  try {
    p = spawn(PS, [...PS_ARGS, path.join(BIN_DIR, SCRIPT_POLL_NAME), '-Parent', String(process.pid), '-Queue', QUEUE_FILE], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    failCount++;
    if (failCount <= 3) console.log('[island] 媒体轮询启动失败 ' + ((e && e.message) || e));
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
      if (j && j.hb) return;                       /* 心跳：只证明进程活着 */
      if (j && j.ok === false) { failCount++; return; }
      /* 前台窗口快照（智能隐藏用），不是媒体状态，别覆盖 lastState */
      if (j && j.fg) {
        lastFg = j.fg;
        if (typeof fgCb === 'function') { try { fgCb(j.fg); } catch (e) {} }
        return;
      }
      failCount = 0;
      emit(j);
    });
  }
  if (p.stderr) {
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', d => {
      const s = String(d || '').trim();
      if (s) console.log('[island] ps stderr ' + s.slice(0, 200));
    });
  }
  p.on('error', e => console.log('[island] 媒体轮询进程错误 ' + ((e && e.message) || e)));
  p.on('exit', () => {
    proc = null;
    if (rl) { try { rl.close(); } catch (e) {} rl = null; }
    if (stopping) return;
    /* 进程自己退了（PowerShell 崩、被系统杀）→ 1.5 秒后重拉，别让岛永久失去媒体 */
    restartTimer = setTimeout(launch, 1500);
  });
}

function start(onState, onFg) {
  cb = onState;
  if (typeof onFg === 'function') fgCb = onFg;
  if (proc) return;                                /* 已在跑：只换回调，别重启进程 */
  stopping = false;
  failCount = 0;
  launch();
  if (!watchdog) {
    watchdog = setInterval(() => {
      if (stopping || !proc) return;
      /* 12 秒没有任何输出说明卡死了（脚本有 10 秒心跳）→ 杀掉让它自己重拉 */
      if (Date.now() - lastLineAt > 12000) {
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

function last() { return lastState; }

/* 轮询进程是否真的活着（脚本有 10 秒心跳，15 秒没输出就当作挂了）。
 * 页面/设置页用它区分「没有播放器」和「桥没起来」。 */
function alive() { return !!proc && (Date.now() - lastLineAt) < 15000; }

function command(action, pos) {
  const a = String(action || 'toggle');
  if (!/^(toggle|next|prev|seek)$/.test(a)) return false;
  if (!BIN_DIR) ensureScripts();
  /* 常驻进程活着就把指令丢进队列（它每轮读一次，没有启动开销）；
   * 进程不在时才退回到「起一个一次性 PowerShell」。 */
  if (proc && alive() && QUEUE_FILE) {
    try { fs.writeFileSync(QUEUE_FILE, a === 'seek' ? ('seek ' + (Number(pos) || 0)) : a, 'utf8'); return true; } catch (e) {}
  }
  const args = [...PS_ARGS, path.join(BIN_DIR, SCRIPT_CMD_NAME), '-Action', a];
  if (a === 'seek') args.push('-Pos', String(Number(pos) || 0));
  try {
    const c = spawn(PS, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    if (c.stdout) c.stdout.resume();
    c.on('error', () => {});
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = { start, stop, last, alive, command };
