/* Lumen 工作台 · Electron 壳（**唯一源码**，两种形态共用）
 *
 * 同一份代码服务两种形态 —— 打包壳不再单独维护，构建时从本目录整体拷过去：
 *   · 仓库轻量壳（npm start）：纯 JS，无 electron-updater → 没有自动更新通道；
 *   · 安装包壳（workbench/，electron-builder）：依赖里带 electron-updater → 自动接上应用内更新。
 * 所有形态差异都用**运行时探测**解决，不靠编译期分支：
 *   require('electron-updater') 成不成 → 有没有自动更新；index.html 在哪 → 加载内置产物还是仓库产物。
 *
 * 做八件事：
 *   1) 起本地端口服务（server.js）—— 浏览器也能打开同一个工作台；
 *   2) 开窗口加载工作台，且**走本地端口**（与浏览器同源 → localStorage 共享，不需要同步代码）；
 *   3) 外链交给系统浏览器；
 *   4) 联网请求代发（绕 CORS）；5) AI 请求代发（POST + SSE 流式）；
 *   6) 屏幕录制（列源 / 系统声音 / 流式落盘，见 rec.js）；
 *   7) 壳状态页（status.html）—— 端口 / 占用诊断 / 日志，出问题时用户自己就能看；
 *   8) 应用内自动更新（仅当带 electron-updater 且是打包态）；
 *   9) 本机能力（剪贴板历史采集 / 系统硬件信息，见「五-b」）——
 *      这两项页面拿不到，只能主进程做，网页版直开时页面侧降级；
 *  10) Python 运行时（见「五-c」）—— 把参数交给本机 python 跑自带脚本、收回图片，
 *      给创意工具当算力后端；网页版直开同样降级。
 * 关窗口缩到托盘常驻，端口继续服务；托盘里退出才算真退出。
 *
 * 环境变量：LUMEN_PORT 指定端口；LUMEN_MODE=file 强制回到 file:// 模式（回退开关）；
 * 命令行 --lumen-dev（npm run dev）：开发模式，独立端口 + 独立数据目录，不与正式实例互顶。 */
const { app, BrowserWindow, Menu, Tray, shell, ipcMain, clipboard, nativeImage, net, dialog, session, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const srv = require('./server');
const rec = require('./rec');
const media = require('./media');
const notify = require('./notify');
const islandFg = require('./island-fg');

/* ---------- 数据目录（必须在 app ready 之前定）----------
 * 固定成 lumen-workbench-shell：开发态与安装版共用同一份，
 * 覆盖安装、卸载都不会动它（electron-builder.yml 里 deleteAppDataOnUninstall: false），
 * 历史记录 / AI 配置 / 价格备忘不会因为换壳而丢。 */
try { app.setPath('userData', path.join(app.getPath('appData'), 'lumen-workbench-shell')); } catch (e) {}

/* ---------- 开发模式 ----------
 * 跟正式实例彻底分开：端口换一个、数据目录换一个。
 * 否则同时开 dev 与正式版会互抢 17870；共用一份存储也容易把真数据搅混。 */
const DEV = process.argv.includes('--lumen-dev') || String(process.env.LUMEN_DEV || '') === '1';
const DEV_PORT = 17871;
if (DEV) {
  try { app.setPath('userData', app.getPath('userData') + '-dev'); } catch (e) {}
}

/* ---------- 路径探测 ----------
 * 两种形态的目录结构不同，全部按存在性判断，谁也不用为谁改路径：
 *   仓库轻量壳：            <root>/index.html      + <root>/shell/*
 *   安装包（asar 内）：      <root>/app/index.html  + <root>/shell/*
 *   本地开发（产物未分发）：<工作区>/workbench-app/dist/index.html */
const APP_ROOT = path.join(__dirname, '..');

function firstExisting(cands, fallback) {
  for (const p of cands) { try { if (fs.existsSync(p)) return p; } catch (e) {} }
  return fallback;
}

const INDEX_HTML = firstExisting([
  path.join(APP_ROOT, 'app', 'index.html'),
  path.join(APP_ROOT, 'index.html'),
  path.join(APP_ROOT, '..', 'workbench-app', 'dist', 'index.html')
], path.join(APP_ROOT, 'index.html'));

/* 端口服务的根 = 产物所在目录（打包态是 app/，仓库态是仓库根） */
const SERVE_ROOT = path.dirname(INDEX_HTML);

/* 数据迁移探针：file:// 身份的极小页面，用来读旧版存在 file:// 下的 localStorage。
 * 不能用 index.html —— 那会连带跑一遍完整应用，启动要多等好几秒。 */
const PROBE_HTML = path.join(__dirname, 'probe.html');
const STATUS_HTML = path.join(__dirname, 'status.html');
/* 窗口 / 任务栏 / 托盘图标：仓库态用 shell/icon.ico；打包工程开发态用 build/icon.ico；
 * 安装版随 exe 本体（electron-builder win.icon）。都找不到就回落 Electron 默认图标，不报错 */
const APP_ICON = firstExisting([
  path.join(__dirname, 'icon.ico'),
  path.join(APP_ROOT, 'build', 'icon.ico')
], path.join(__dirname, 'icon.ico'));

const FORCE_FILE = String(process.env.LUMEN_MODE || '').toLowerCase() === 'file';
const WANT_PORT = Number(process.env.LUMEN_PORT) || (DEV ? DEV_PORT : srv.DEFAULT_PORT);
const VERIFY = process.env.LUMEN_VERIFY === '1';
const MARK = process.env.LUMEN_MARK || '';
const TRACE = path.join(__dirname, '_trace.txt');          /* E2E 脚本读它，保留 */
const VERIFY_JSON = path.join(os.tmpdir(), 'lumen-verify.json');   /* 装机自测读它 */
const VERIFY_PNG = path.join(os.tmpdir(), 'lumen-verify.png');

/* ---------- 日志 ----------
 * 以前只在 LUMEN_VERIFY=1 时才落文件，用户遇到问题手上什么都没有。
 * 现在常开：内存里留最近 400 行给状态页看，同时追加到 userData 下的日志文件；
 * 文件超过 256KB 就清一次，避免无限长。
 * 打包态 __dirname 在 asar 内只读，所以回落目标也放临时目录。 */
const LOG_FILE = (() => {
  try { return path.join(app.getPath('userData'), 'lumen-shell.log'); }
  catch (e) { return path.join(os.tmpdir(), 'lumen-shell.log'); }
})();
const LOG_MAX = 256 * 1024;
const LOGS = [];

function trace(m) {
  const line = new Date().toISOString().slice(11, 23) + ' ' + m;
  LOGS.push(line);
  if (LOGS.length > 400) LOGS.shift();
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) {}
  if (VERIFY) { try { fs.appendFileSync(TRACE, line + '\n'); } catch (e) {} }
}
function trimLog() {
  try { if (fs.statSync(LOG_FILE).size > LOG_MAX) fs.writeFileSync(LOG_FILE, ''); } catch (e) {}
}

let win = null;
let tray = null;
let trayHinted = false;
let httpSrv = null;
let httpPort = 0;
let quitting = false;
let migratePayload = null;                 /* 旧 file:// origin 的 localStorage，给 preload 同步取 */
let booting = true;                        /* 启动阶段：迁移用的隐藏窗口销毁会触发 window-all-closed，别当成“用户关完了” */
let recWired = false;                      /* rec.wire 内部注册 ipcMain.handle，只能接一次线 */
let portDiag = [];                         /* 端口被占时的探活结果：[{ port, by:'lumen'|'other'|'unknown', version, pid }] */
let statusWin = null;                      /* 壳状态页窗口 */

/* 出网一律走 Electron 的网络栈（Chromium）：它会读系统代理设置。
 * Node 原生 fetch（undici）不读代理，会让需要代理的接口在中继/代发里静默失败。 */
const httpFetch = (u, o) => net.fetch(u, o);

const baseUrl = () => 'http://' + srv.HOST + ':' + httpPort + '/';

function readVersion() {
  try {
    const v = fs.readFileSync(path.join(APP_ROOT, 'VERSION'), 'utf8').trim();
    if (v) return v;
  } catch (e) {}
  /* 打包态没有 VERSION 文件（files 里只有 app/ + shell/），退回应用版本号 */
  try { return app.getVersion(); } catch (e) { return ''; }
}

/* ============================================================
   〇、应用内自动更新（有没有 electron-updater 决定形态）
   —— 安装包带 app-update.yml（electron-builder 按 publish 配置生成）才有意义；
   仓库轻量壳没装这个依赖，require 直接抛 → 自动退化成「无自动更新」。
   页面侧读 lumenApp.isInstalled 决定显示哪种更新入口（应用内 / 去 GitHub 下载）。 */
let updater = null;
/* 更新源与回退（1017 加入）：
 *   GitHub（electron-builder 生成的 app-update.yml）为默认；
 *   GitHub 不通时拉 Gitee 镜像的 VERSION，比当前新就用 generic provider
 *   直指 Gitee Release 目录（附件 URL 与 GitHub 同构，latest.yml 在里面）。
 *   回退只在内存里，重启后重新从 GitHub 试起。 */
const UPD_GH_FEED = process.env.LUMEN_UPDATE_URL
  ? { provider: 'generic', url: process.env.LUMEN_UPDATE_URL }
  : { provider: 'github', owner: 'lyz0v0', repo: 'lumen-workbench' };
const UPD_GITEE_REPO = 'https://gitee.com/lyz0v0/lumen-workbench';
let updSource = 'github';        /* github | gitee */
let updQuiet = false;            /* 非末位源尝试中：压掉 error 推送，别让页面闪一下失败 */

function updTuple(v) {
  return String(v || '').replace(/^v/i, '').split(/[.\-+]/).map(n => parseInt(n, 10) || 0);
}
function updCmp(a, b) {          /* a>b 返回正数 */
  const A = updTuple(a), B = updTuple(b);
  for (let i = 0; i < 3; i++) { const d = (A[i] || 0) - (B[i] || 0); if (d) return d; }
  return 0;
}
async function updGiteeVersion() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6000);
  try {
    const r = await httpFetch(UPD_GITEE_REPO + '/raw/master/VERSION?t=' + Date.now(),
      { signal: ctl.signal, cache: 'no-store' });
    if (!r.ok) return '';
    const v = String(await r.text()).trim().replace(/^v/i, '');
    return /^\d+(\.\d+){1,3}$/.test(v) ? v : '';
  } catch (e) {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

function initUpdater() {
  if (!app.isPackaged && String(process.env.LUMEN_FORCE_UPDATE || '') !== '1') {
    trace('非打包态：不接自动更新');
    return;
  }
  try {
    const { autoUpdater } = require('electron-updater');
    if (process.env.LUMEN_UPDATE_URL) {
      autoUpdater.setFeedURL(UPD_GH_FEED);
      trace('更新源覆盖为 ' + process.env.LUMEN_UPDATE_URL);
    }
    autoUpdater.autoDownload = false;          /* 由页面决定何时下载 */
    autoUpdater.autoInstallOnAppQuit = true;

    const push = (state, extra) => {
      try {
        for (const w of BrowserWindow.getAllWindows()) {
          if (!w.webContents.isDestroyed()) w.webContents.send('lumen:update-status', Object.assign({ state }, extra || {}));
        }
      } catch (e) {}
      trace('update-status ' + state + ' ' + JSON.stringify(extra || {}));
    };

    autoUpdater.on('checking-for-update', () => { if (!updQuiet) push('checking', { source: updSource }); });
    autoUpdater.on('update-available', i => push('available', { version: (i && i.version) || '', source: updSource }));
    autoUpdater.on('update-not-available', i => push('none', { version: (i && i.version) || '', source: updSource }));
    autoUpdater.on('download-progress', p => push('downloading', { percent: Math.round((p && p.percent) || 0) }));
    autoUpdater.on('update-downloaded', i => push('downloaded', { version: (i && i.version) || '' }));
    autoUpdater.on('error', e => {
      const msg = String((e && e.message) || e);
      if (updQuiet) { trace('（' + updSource + ' 源失败，准备换源）' + msg); return; }
      push('error', { message: msg, source: updSource });
    });

    updater = autoUpdater;
    trace('自动更新已就绪 v' + app.getVersion());
  } catch (e) {
    updater = null;
    trace('未启用自动更新（' + ((e && e.message) || e) + '）');
  }
}

/* 依次尝试可用源：默认 GitHub → Gitee；上次已切到 Gitee 就先走 Gitee。
 * 返回 { info, source }；Gitee 明确「不比当前新」时直接算无更新，不必再去啃 GitHub。 */
async function updCheckAny() {
  const order = updSource === 'gitee' ? ['gitee', 'github'] : ['github', 'gitee'];
  let lastErr = null;
  for (let i = 0; i < order.length; i++) {
    const src = order[i];
    const last = i === order.length - 1;
    updQuiet = !last;
    try {
      if (src === 'github') {
        updater.setFeedURL(UPD_GH_FEED);
      } else {
        const gv = await updGiteeVersion();
        if (!gv) throw new Error('Gitee 版本号读取失败');
        if (updCmp(gv, app.getVersion()) <= 0) {
          updSource = 'gitee';
          updQuiet = false;
          trace('Gitee 源：' + gv + '，不比当前新');
          return { info: { version: gv }, source: 'gitee' };
        }
        updater.setFeedURL({ provider: 'generic', url: UPD_GITEE_REPO + '/releases/download/v' + gv + '/' });
        trace('切到 Gitee 更新源 v' + gv);
      }
      const r = await updater.checkForUpdates();
      updSource = src;
      updQuiet = false;
      trace('更新源 ' + src + ' 检查完成：' + ((r && r.updateInfo && r.updateInfo.version) || 'none'));
      return { info: (r && r.updateInfo) || {}, source: src };
    } catch (e) {
      lastErr = e;
      updQuiet = false;
      trace('更新源 ' + src + ' 失败：' + ((e && e.message) || e));
    }
  }
  throw lastErr || new Error('检查更新失败');
}

ipcMain.handle('lumen:app-info', () => ({
  version: readVersion(),
  packaged: app.isPackaged,
  canAutoUpdate: !!updater,
  userData: app.getPath('userData')
}));

/* 托盘菜单接管：设置面板提交 {action,label} 数组，白名单校验后重建托盘并持久化 */
ipcMain.handle('lumen:tray-set', (_e, items) => {
  const v = sanitizeTray(items);
  if (!v) return { ok: false, error: '菜单数据不合法（须为 {action,label} 数组），已保留当前菜单' };
  trayItems = v;
  try { fs.writeFileSync(trayJson(), JSON.stringify(v, null, 1)); } catch (e) {}
  refreshTray();
  trace('托盘菜单已由页面接管 ' + v.length + ' 项');
  return { ok: true, applied: v.length };
});
ipcMain.handle('lumen:tray-get', () => ({ ok: true, items: trayItems || loadTrayItems() }));

ipcMain.handle('lumen:update-check', async () => {
  if (!updater) return { ok: false, error: '当前是轻量壳，去 GitHub 下载安装包' };
  try {
    const r = await updCheckAny();
    return { ok: true, version: (r.info && r.info.version) || '', source: r.source };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('lumen:update-download', async () => {
  if (!updater) return { ok: false, error: '当前是轻量壳' };
  try {
    await updater.downloadUpdate();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('lumen:update-install', async () => {
  if (!updater) return { ok: false, error: '当前是轻量壳' };
  /* 先让 IPC 返回，再退出重启，避免页面还在等回包时进程已经没了 */
  setTimeout(() => { try { updater.quitAndInstall(false, true); } catch (e) { trace('quitAndInstall 失败 ' + ((e && e.message) || e)); } }, 400);
  return { ok: true };
});

/* ============================================================
   一、本地端口服务
   ============================================================ */
async function startServer() {
  if (FORCE_FILE) { trace('LUMEN_MODE=file，跳过端口服务'); return false; }
  const r = await srv.start({ root: SERVE_ROOT, port: WANT_PORT, version: readVersion(), fetchImpl: httpFetch });
  portDiag = r.diagnostics || [];
  if (!r.ok) { trace('端口服务启动失败: ' + r.error); return false; }
  httpSrv = r;
  httpPort = r.port;
  trace('端口服务已起 ' + baseUrl() + '（根目录 ' + SERVE_ROOT + '）' +
    (portDiag.length ? '（前面 ' + portDiag.map(d => d.port + ' 被 ' + d.by + ' 占用）') : ''));
  return true;
}

/* 再打开壳时重启端口服务：保证端口一定是本进程的，被抢或挂了都能自愈 */
async function restartServer() {
  if (FORCE_FILE) return false;
  const oldPort = httpPort;
  try { if (httpSrv) await httpSrv.close(); } catch (e) {}
  httpSrv = null; httpPort = 0;
  const ok = await startServer();
  trace('重启端口服务 ' + ok + ' 端口 ' + oldPort + ' → ' + httpPort);
  if (ok) {
    refreshTray();
    /* 端口被迫变了：已加载的页面还在旧地址上，重新载到新端口 */
    if (win && httpPort !== oldPort) {
      try { win.loadURL(baseUrl()); } catch (e) {}
    }
  }
  return ok;
}

/* ============================================================
   二、旧 file:// 数据迁移（只做一次，不删旧数据，随时可回退）
   ============================================================ */
/* 标记只在 preload 确认补写之后才落；读失败不落标记，下次启动继续试 ——
 * 避免“读到了但没写进去就再不复盘”把用户数据闷死。 */
function migrateFlag() { return path.join(app.getPath('userData'), 'lumen-migrated-v2.json'); }

let migrateReadOK = false;

async function prepareMigration() {
  if (FORCE_FILE) return;
  if (DEV) { trace('dev 模式：独立数据目录，跳过旧数据迁移'); return; }
  try { if (fs.existsSync(migrateFlag())) return; } catch (e) {}
  if (!fs.existsSync(PROBE_HTML)) { trace('迁移探针缺失，跳过'); return; }

  const hidden = new BrowserWindow({ show: false, width: 320, height: 240 });
  let data = {};
  try {
    await new Promise(resolve => {
      hidden.webContents.once('dom-ready', resolve);
      hidden.webContents.once('did-fail-load', resolve);
      hidden.loadFile(PROBE_HTML);
      setTimeout(resolve, 5000);                         /* 兜底 */
    });
    data = await hidden.webContents.executeJavaScript(
      '(()=>{const o={};try{for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);' +
      'if(k&&k.indexOf("lumen-")===0)o[k]=localStorage.getItem(k);}}catch(e){}return o;})()', true
    ) || {};
    migrateReadOK = true;
  } catch (e) {
    trace('迁移读取失败 ' + ((e && e.message) || e));
  } finally {
    try { hidden.destroy(); } catch (e) {}
  }

  migratePayload = data;
  trace('旧版数据待补写，键数 ' + Object.keys(data).length);
}

/* preload 同步取：保证在页面脚本执行前就把旧数据补进去 */
ipcMain.on('lumen:migrate-pull', e => { e.returnValue = migratePayload || null; });
ipcMain.on('lumen:migrate-done', (_e, n) => {
  if (!migrateReadOK) { trace('迁移曾读取失败，保留重试'); return; }
  try { fs.writeFileSync(migrateFlag(), JSON.stringify({ at: Date.now(), keys: Object.keys(migratePayload || {}).length, wrote: Number(n) || 0 })); } catch (e) {}
  trace('迁移完成，补写 ' + n + ' 项');
});

/* 壳信息（端口 / 地址 / 版本），页面需要时可取 */
ipcMain.handle('lumen:shell-info', () => ({
  mode: httpPort ? 'http' : 'file',
  port: httpPort,
  url: httpPort ? baseUrl() : '',
  version: readVersion()
}));
ipcMain.handle('lumen:open-in-browser', () => {
  if (!httpPort) return false;
  shell.openExternal(baseUrl());
  return true;
});

/* ---------- 壳状态 ----------
 * 托盘「壳状态 / 日志」和 shell/status.html 读的是同一份数据。
 * 状态页自己走 file:// 加载，所以端口服务挂了它也照样打得开。 */
function buildStatus() {
  let migrated = false;
  try { migrated = fs.existsSync(migrateFlag()); } catch (e) {}
  return {
    app: 'lumen-workbench',
    version: readVersion(),
    kind: updater ? '安装版' : (app.isPackaged ? '安装版（无更新模块）' : '轻量壳'),
    dev: DEV,
    forcedFile: FORCE_FILE,
    mode: httpPort ? 'http' : 'file',
    port: httpPort,
    url: httpPort ? baseUrl() : '',
    wantPort: WANT_PORT,
    diagnostics: portDiag,
    migrated,
    autoUpdate: !!updater,
    serveRoot: SERVE_ROOT,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    logFile: LOG_FILE,
    log: LOGS.slice(-120)
  };
}

ipcMain.handle('lumen:shell-status', () => buildStatus());
ipcMain.handle('lumen:restart-server', async () => { await restartServer(); return buildStatus(); });
ipcMain.handle('lumen:open-log', () => {
  try { shell.openPath(LOG_FILE); return true; } catch (e) { return false; }
});

/* ============================================================
   三、窗口
   ============================================================ */
function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    title: (DEV ? 'Lumen 工作台 [dev]' : 'Lumen 工作台'),
    backgroundColor: '#F6F6F4',
    autoHideMenuBar: true,
    show: true,
    icon: fs.existsSync(APP_ICON) ? APP_ICON : undefined,
    webPreferences: {
      spellcheck: false,
      preload: path.join(__dirname, 'preload.js'),
      /* 页面侧要同步知道「能不能应用内更新」才能决定显示哪种更新入口，走启动参数最省事 */
      additionalArguments: ['--lumen-packaged=' + (updater ? '1' : '0')]
    }
  });

  /* 原型里的热榜原文、二维码结果等都走新窗口 → 统一交给系统默认浏览器 */
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  if (httpPort) {
    win.loadURL(baseUrl());
    trace('loadURL ' + baseUrl());
  } else {
    win.loadFile(INDEX_HTML);
    trace('loadFile 回落（端口不可用）' + INDEX_HTML);
  }

  win.webContents.on('did-start-loading', () => trace('did-start-loading'));
  win.webContents.on('did-finish-load', () => trace('did-finish-load'));
  win.webContents.on('did-fail-load', (_e, c, d, u) => {
    trace('did-fail-load ' + c + ' ' + d + ' ' + u);
    /* 本地端口没起来/中途挂了 → 回落到 file://，别给用户一张白屏 */
    if (httpPort && c !== -3 && String(u || '').indexOf('127.0.0.1') >= 0) {
      trace('端口加载失败，回落 file://');
      httpPort = 0;
      refreshTray();
      try { win.loadFile(INDEX_HTML); } catch (e) {}
      trayNotify('端口服务异常，已切回本地文件模式',
        '壳内功能照常可用，但与浏览器不再同源。\n右键托盘图标 → 壳状态 / 日志，可查看原因并重试。');
    }
  });
  win.webContents.on('render-process-gone', (_e, d) => trace('render-gone ' + JSON.stringify(d)));

  /* 关窗口 = 缩到托盘（端口继续服务）；没有托盘可用时才真退出 */
  win.on('close', e => {
    if (quitting || !tray) return;
    e.preventDefault();
    win.hide();
    trace('窗口已缩到托盘');
    trayHintOnce();
  });
  /* 真被销毁了（页面脚本 window.close()、渲染进程崩溃等）→ 置空，托盘点一下能重建 */
  win.on('closed', () => { win = null; trace('窗口已销毁（托盘可重建）'); });

  /* 屏幕录制：页面拿不到 desktopCapturer、也绕不过捕获授权，全交给主进程（rec.js） */
  if (!recWired) {
    try { rec.wire({ win, trace }); recWired = true; }
    catch (e) { trace('rec 接线失败 ' + ((e && e.message) || e)); }
  }

  if (VERIFY) {
    win.webContents.once('did-finish-load', async () => {
      trace('验证开始');
      const out = { ok: false };
      try {
        /* 走 DOM 读，别依赖内部变量名（构建产物会被压缩改名） */
        const info = await win.webContents.executeJavaScript(`(async () => {
          const sleep = ms => new Promise(r => setTimeout(r, ms));
          let ls = 'fail';
          try { localStorage.setItem('__t','1'); ls = localStorage.getItem('__t') === '1' ? 'ok' : 'bad'; localStorage.removeItem('__t'); } catch (e) { ls = 'fail:' + e.message; }
          if (${JSON.stringify(MARK)}) { try { localStorage.setItem('lumen-verify-mark', ${JSON.stringify(MARK)}); } catch (e) {} }
          let mark = ''; try { mark = localStorage.getItem('lumen-verify-mark') || ''; } catch (e) {}
          location.hash = '#tools';
          await sleep(450);
          const sub = (document.querySelector('.ap-sub') || {}).textContent || '';
          return {
            title: document.title, origin: location.origin, href: location.href, hash: location.hash, ls, mark,
            tools: (typeof TOOLS !== 'undefined' ? TOOLS.length : -1),
            navCats: document.querySelectorAll('#catNav .nav-item[data-cat]').length,
            cards: document.querySelectorAll('.card[data-tool]').length,
            sub: sub.trim(),
            /* 真去列一次屏幕源：录制通道（desktopCapturer → rec.js）能不能用，
             * 光看「preload 暴露了 lumenRec」不算数，要端到端打通才算 */
            recSources: await (async () => {
              try {
                if (!window.lumenRec || !window.lumenRec.listSources) return -1;
                const r = await window.lumenRec.listSources();
                return (r && r.sources) ? r.sources.length : -1;
              } catch (e) { return 'err:' + e.message; }
            })(),
            bridges: {
              net: !!(window.lumenNet && window.lumenNet.isElectron),
              rec: !!(window.lumenRec && window.lumenRec.isElectron),
              sh: !!(window.lumenShell && window.lumenShell.isElectron),
              app: !!(window.lumenApp && window.lumenApp.isInstalled)
            }
          };
        })()`, true);
        out.ok = true;
        out.info = info;
        out.packaged = app.isPackaged;
        out.autoUpdate = !!updater;
        out.version = readVersion();
        out.userData = app.getPath('userData');
        out.serveRoot = SERVE_ROOT;
        const img = await win.webContents.capturePage();
        /* 两份都写：tmp 给 workbench/scripts/install-test.mjs 的装机自测；
         * shell/ 给仓库侧 E2E 脚本（打包态 asar 内只读，写失败忽略） */
        try { fs.writeFileSync(VERIFY_PNG, img.toPNG()); } catch (e) {}
        try { fs.writeFileSync(path.join(__dirname, '_verify_shot.png'), img.toPNG()); } catch (e) {}
        try { fs.writeFileSync(VERIFY_JSON, JSON.stringify(out, null, 2)); } catch (e) {}
        trace('验证完成 ' + JSON.stringify(info));
        console.log('VERIFY_OK ' + JSON.stringify(info));
      } catch (e) {
        out.error = String((e && e.message) || e);
        trace('验证异常 ' + out.error);
        try { fs.writeFileSync(VERIFY_JSON, JSON.stringify(out, null, 2)); } catch (_) {}
        console.log('VERIFY_ERR ' + out.error);
      }
      app.exit(0);
    });
  }

  return win;
}

function showWin() {
  if (!win || win.isDestroyed()) { createWindow(); return; }   /* 被销毁过就重建一个 */
  try {
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
  } catch (e) {}
}

/* 壳状态页：独立小窗，走 file:// 加载 —— 端口服务挂掉时它必须照样能开 */
function openStatusWindow() {
  if (statusWin && !statusWin.isDestroyed()) {
    try { if (statusWin.isMinimized()) statusWin.restore(); statusWin.show(); statusWin.focus(); } catch (e) {}
    return;
  }
  if (!fs.existsSync(STATUS_HTML)) { trace('状态页缺失，跳过'); return; }
  statusWin = new BrowserWindow({
    width: 680, height: 640, minWidth: 460, minHeight: 400,
    title: 'Lumen 工作台 · 壳状态',
    backgroundColor: '#F6F6F4',
    autoHideMenuBar: true,
    icon: fs.existsSync(APP_ICON) ? APP_ICON : undefined,
    webPreferences: { spellcheck: false, preload: path.join(__dirname, 'preload.js') }
  });
  statusWin.loadFile(STATUS_HTML);
  statusWin.on('closed', () => { statusWin = null; trace('状态页已关闭'); });
  trace('打开壳状态页');
}

/* ============================================================
   四、托盘常驻
   ============================================================ */
function trayNotify(title, content) {
  if (!tray) return;
  try { tray.displayBalloon({ title, content }); } catch (e) {}
}

function trayHintOnce() {
  if (trayHinted) return;
  trayHinted = true;
  trayNotify('Lumen 工作台仍在运行',
    (httpPort ? '浏览器随时可打开 ' + baseUrl() + '\n' : '') + '需要彻底退出请右键托盘图标 → 退出');
}

/* ---------- 托盘菜单：默认项 + 页面接管 ----------
 * 设置面板（仅壳内）可勾选前四项显隐；「重启端口服务」「退出」强制保留。
 * 页面通过 lumenShell.setTrayMenu 提交 {action,label} 数组，壳按白名单校验——
 * 动作的实现永远只在壳里，页面传什么都不可能执行任意代码；
 * 自定义项持久化到 userData/tray-menu.json，重启即恢复，无需等页面加载。 */
const TRAY_ALLOWED = new Set(['show', 'browser', 'copy', 'status']);
const TRAY_DEFAULT = [
  { action: 'show',    label: '显示主窗口' },
  { action: 'browser', label: '在浏览器中打开' },
  { action: 'copy',    label: '复制地址' },
  { action: 'status',  label: '壳状态 / 日志' }
];
let trayItems = null;                        /* 懒加载：首次 refreshTray 时读盘 */
const trayJson = () => path.join(app.getPath('userData'), 'tray-menu.json');

function sanitizeTray(arr) {
  if (!Array.isArray(arr)) return null;
  const out = [];
  for (const it of arr.slice(0, 8)) {
    if (!it || typeof it !== 'object') continue;
    const label = String(it.label || '').trim().slice(0, 20);
    if (!label || !TRAY_ALLOWED.has(it.action)) continue;
    out.push({ action: it.action, label });
  }
  /* 传了条目但全被滤掉 = 数据有问题，按拒收处理；空数组 = 用户全关，合法 */
  if (arr.length && !out.length) return null;
  return out;                                /* 允许全关：托盘只剩「重启端口服务/退出」 */
}
function loadTrayItems() {
  try {
    const v = sanitizeTray(JSON.parse(fs.readFileSync(trayJson(), 'utf8')));
    if (v) return v;
  } catch (e) {}
  return TRAY_DEFAULT.slice();
}

function trayTemplate() {
  const click = {
    show: showWin,
    browser: () => { if (httpPort) shell.openExternal(baseUrl()); },
    copy: () => { if (httpPort) clipboard.writeText(baseUrl()); },
    status: openStatusWindow
  };
  const items = trayItems.map(it => ({
    label: it.label,
    enabled: (it.action === 'browser' || it.action === 'copy') ? !!httpPort : true,
    click: click[it.action]
  }));
  items.push(
    { type: 'separator' },
    { label: '重启端口服务', enabled: !FORCE_FILE, click: () => { restartServer(); } },
    { type: 'separator' },
    { label: '退出', click: quitApp }
  );
  return items;
}

function refreshTray() {
  if (!tray) return;
  if (!trayItems) trayItems = loadTrayItems();
  const url = httpPort ? baseUrl() : '';
  tray.setToolTip('Lumen 工作台' + (DEV ? '（dev）' : '') + (url ? ' · ' + url : ''));
  tray.setContextMenu(Menu.buildFromTemplate(trayTemplate()));
}

function createTray() {
  try {
    let img = nativeImage.createEmpty();
    if (fs.existsSync(APP_ICON)) img = nativeImage.createFromPath(APP_ICON);
    tray = new Tray(img);
    refreshTray();
    tray.on('double-click', showWin);
  } catch (e) {
    trace('托盘创建失败 ' + ((e && e.message) || e));
    tray = null;
  }
}

function quitApp() {
  quitting = true;
  try { if (httpSrv) httpSrv.close(); } catch (e) {}
  app.quit();
}
app.on('before-quit', () => {
  quitting = true;
  /* 岛的媒体轮询是个常驻 PowerShell 进程，退出时必须收掉，否则会留在任务管理器里 */
  try { media.stop(); } catch (e) {}
});

Menu.setApplicationMenu(null);

/* ============================================================
   五、联网代发
   —— 工作台走 file:// 时页面里的 fetch 会被跨域策略拦掉；
 * 走 http://127.0.0.1 时，这部分请求虽然由页面的同源中继（server.js）承担，
 * 但壳窗口内仍优先走 IPC（更快、不受端口服务影响）。只放行 http/https。 */
ipcMain.handle('lumen:net-fetch', async (_e, url) => {
  const u = String(url || '');
  if (!/^https?:\/\//i.test(u)) return { ok: false, status: 0, error: '只允许 http/https 请求' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);   /* 挂死的服务端别拖住整轮刷新 */
  try {
    const r = await httpFetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (Lumen Workbench)' }, signal: ctl.signal });
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
    return { ok: false, status: 0, error: String((e && e.message) || e), timeout: ctl.signal.aborted };
  } finally {
    clearTimeout(timer);
  }
});

/* ============================================================
   五-a、通用 HTTP 转发（开发工具 · API 测试）
   ------------------------------------------------------------
   与 net-fetch 的区别：能带方法、请求头与请求体，并把全部响应头
   原样回传（net-fetch 只挑三条限流头，够抓页面不够测接口）。
   响应体按文本返回——二进制下载走 media-vdl，不是这个工具的事。
   超时 30 秒，方法白名单，协议只放行 http/https。 */
ipcMain.handle('lumen:http', async (_e, payload) => {
  const p = payload || {};
  const url = String(p.url || '');
  if (!/^https?:\/\//i.test(url)) return { ok: false, status: 0, error: '只允许 http/https 请求' };
  const method = String(p.method || 'GET').toUpperCase();
  if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(method)) {
    return { ok: false, status: 0, error: '不支持的方法：' + method };
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30000);
  const t0 = Date.now();
  try {
    const body = (method === 'GET' || method === 'HEAD') ? undefined : p.body;
    const r = await httpFetch(url, { method, headers: p.headers || {}, body, signal: ctl.signal });
    const text = await r.text();
    const headers = {};
    try { r.headers.forEach((v, k) => { headers[k] = v; }); } catch (e) {}
    trace('http ' + method + ' ' + r.status + ' ' + url.slice(0, 90));
    return { ok: r.ok, status: r.status, statusText: r.statusText, headers, text, ms: Date.now() - t0 };
  } catch (e) {
    const aborted = ctl.signal.aborted;
    trace('http ERR ' + method + ' ' + url.slice(0, 90) + ' ' + ((e && e.message) || e));
    return {
      ok: false, status: 0, ms: Date.now() - t0, aborted,
      error: aborted ? '请求超时（30 秒）' : String((e && e.message) || e)
    };
  } finally {
    clearTimeout(timer);
  }
});

/* ============================================================
   五-b、视频下载（Beta）
   ------------------------------------------------------------
   页面侧做不到三件事：带自定义请求头（Referer / Cookie）、流式落盘、
   进度与取消。所以整条链路在主进程，页面只发地址、收进度。

   · 直链：单次 GET 流式写盘，Content-Length 已知时给百分比
   · HLS ：解析 m3u8 —— master 列表取带宽最高变体，媒体列表按序拉分片，
           AES-128 分片就地解密后追加；不依赖 ffmpeg
   拒绝：非 http(s)、SAMPLE-AES(DRM) 播放列表
   ============================================================ */

const DL_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const dlJobs = new Map();
let dlSeq = 0;

function dlEmit(sender, msg){
  try{
    if (sender && !sender.isDestroyed()) sender.send('lumen:dl-progress', msg);
  }catch(_){}
}

/* 统一请求入口：跟随重定向；collect 时收 body（可限长），否则把流交给调用方 */
function dlReach(url, opt){
  opt = opt || {};
  return new Promise((resolve, reject) => {
    const u = String(url || '');
    if (!/^https?:/i.test(u)) { reject(new Error('只支持 http / https 地址')); return; }
    const headers = Object.assign({ 'User-Agent': DL_UA, 'Accept': '*/*' }, opt.headers || {});
    const req = net.request({ url: u, method: opt.method || 'GET', redirect: 'follow', useSessionCookies: !!opt.cookies });
    for (const k in headers) { try { req.setHeader(k, headers[k]); } catch (_) {} }
    const idle = setTimeout(() => { try { req.abort(); } catch (_) {} reject(new Error('连接超时（30 秒无响应）')); }, opt.timeout || 30000);
    let settled = false;
    const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(idle); fn(v); };

    req.on('response', res => {
      const ctype = String(res.headers['content-type'] || '');
      if (!opt.collect) {
        done(resolve, { req, res, status: res.statusCode, headers: res.headers, mime: ctype });
        return;
      }
      const chunks = [];
      let size = 0;
      const cap = opt.limit || 8 * 1024 * 1024;
      res.on('data', c => {
        size += c.length;
        if (size > cap) { try { req.abort(); } catch (_) {} done(reject, new Error('响应内容过大')); return; }
        chunks.push(c);
      });
      res.on('end', () => done(resolve, {
        status: res.statusCode, headers: res.headers, mime: ctype, body: Buffer.concat(chunks)
      }));
      res.on('error', e => done(reject, e));
    });
    req.on('error', e => done(reject, e));
    req.end();
  });
}

function dlGetText(url, headers, limit){
  return dlReach(url, { headers, collect: true, limit: limit || 8 * 1024 * 1024 })
    .then(r => ({ status: r.status, headers: r.headers, text: r.body.toString('utf8') }));
}
function dlGetBuf(url, headers, limit){
  return dlReach(url, { headers, collect: true, limit: limit || 64 * 1024 * 1024 })
    .then(r => ({ status: r.status, headers: r.headers, body: r.body }));
}

/* content-range 里的总长优先（Range 探测时 content-length 只是这一段） */
function dlSizeOf(hs){
  hs = hs || {};
  const m = /\/(\d+)\s*$/.exec(String(hs['content-range'] || ''));
  if (m) return parseInt(m[1], 10) || 0;
  return parseInt(hs['content-length'], 10) || 0;
}

/* URL / content-disposition → 安全文件名（无扩展名时按 MIME 补） */
function dlNameFrom(url, ctype, cd){
  let name = '';
  if (cd) {
    const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(cd);
    const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
    try { name = star ? decodeURIComponent(star[1].trim()) : (plain ? plain[1].trim() : ''); }
    catch (_) { name = plain ? plain[1].trim() : ''; }
  }
  if (!name) {
    try { name = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || ''); } catch (_) {}
  }
  name = String(name).replace(/[\u0000-\u001f\\/:*?"<>|]/g, '_').trim().slice(0, 120) || 'video';
  if (!/\.[a-z0-9]{2,5}$/i.test(name)) {
    const map = { 'video/mp4':'mp4', 'video/webm':'webm', 'video/quicktime':'mov',
      'video/x-matroska':'mkv', 'audio/mpeg':'mp3', 'audio/mp4':'m4a', 'audio/aac':'aac' };
    name += '.' + (map[String(ctype || '').split(';')[0].trim().toLowerCase()] || 'mp4');
  }
  return name;
}

/* m3u8 → 变体列表 / 分片列表（EXT-X-KEY 状态按出现顺序落在后续分片上） */
function dlParsePlaylist(text, base){
  const lines = String(text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const abs = u => { try { return new URL(u, base).href; } catch (_) { return String(u); } };
  const variants = [], segs = [];
  let key = null, dur = 0, seq = 0, init = null;
  for (let i = 0; i < lines.length; i++){
    const L = lines[i];
    if (L.startsWith('#EXT-X-MEDIA-SEQUENCE:')) { seq = parseInt(L.split(':')[1], 10) || 0; continue; }
    if (L.startsWith('#EXT-X-KEY:')) {
      const m = /METHOD=([A-Za-z0-9-]+)/.exec(L);
      const method = m ? m[1].toUpperCase() : 'NONE';
      if (method === 'NONE') key = null;
      else {
        const u = /URI="([^"]+)"/.exec(L);
        const iv = /IV=0x([0-9A-Fa-f]+)/.exec(L);
        key = { method, url: u ? abs(u[1]) : '', iv: iv ? iv[1] : '' };
      }
      continue;
    }
    if (L.startsWith('#EXT-X-MAP:')) {
      const u = /URI="([^"]+)"/.exec(L);
      if (u) init = abs(u[1]);
      continue;
    }
    if (L.startsWith('#EXT-X-STREAM-INF:')) {
      const bw = /BANDWIDTH=(\d+)/.exec(L);
      let j = i + 1;
      while (j < lines.length && lines[j].startsWith('#')) j++;
      if (lines[j]) variants.push({ bw: bw ? +bw[1] : 0, url: abs(lines[j]) });
      continue;
    }
    if (L.startsWith('#EXTINF:')) { dur = parseFloat(L.slice(8)) || 0; continue; }
    if (L.startsWith('#')) continue;
    segs.push({ url: abs(L), dur, key, seq: seq + segs.length, init });
    dur = 0;
  }
  return { variants, segs, init };
}

/* AES-128-CBC；IV 缺省时按规范用媒体序号（16 字节大端） */
function dlDecrypt(buf, keyBuf, ivHex, seq){
  let iv;
  if (ivHex) iv = Buffer.from(String(ivHex).padStart(32, '0').slice(-32), 'hex');
  else { iv = Buffer.alloc(16); iv.writeUInt32BE(seq >>> 0, 12); }
  try {
    const d = crypto.createDecipheriv('aes-128-cbc', keyBuf.subarray(0, 16), iv);
    return Buffer.concat([d.update(buf), d.final()]);
  } catch (_) {
    return buf;                       /* 解不开就原样落盘，别废掉整条流 */
  }
}

function dlWrite(stream, buf){
  return new Promise(resolve => { if (stream.write(buf)) resolve(); else stream.once('drain', resolve); });
}

/* 探测：类型 / 大小 / 是否支持分段 / 页面里可能的直链（HTML 原样带回页面侧嗅探） */
async function dlProbe(url, headers){
  const h = Object.assign({}, headers || {});
  let status = 0, hs = {}, body = null;
  try{
    const r = await dlReach(url, { method: 'HEAD', headers: h });
    status = r.status; hs = r.headers;
    try { r.res.destroy(); r.req.abort(); } catch (_) {}
  }catch(_){ status = 0; }
  if (status >= 400 || !hs['content-type']){
    const r = await dlReach(url, { headers: Object.assign({ Range: 'bytes=0-262143' }, h), collect: true, limit: 512 * 1024 });
    status = r.status; hs = r.headers; body = r.body;
  }
  const ct = String(hs['content-type'] || '').toLowerCase();
  const isHls = /mpegurl/.test(ct) || /\.m3u8(\?|#|$)/i.test(url);
  const isHtml = /text\/html|application\/xhtml/.test(ct);
  const out = {
    ok: status > 0 && status < 400, status, url,
    mime: ct.split(';')[0].trim(), size: dlSizeOf(hs),
    name: dlNameFrom(url, ct, hs['content-disposition']),
    type: isHls ? 'hls' : (isHtml ? 'page' : 'file'),
    ranges: /bytes/i.test(String(hs['accept-ranges'] || ''))
  };
  if (isHtml){
    if (!body) {
      try { body = (await dlReach(url, { headers: h, collect: true, limit: 400 * 1024 })).body; } catch (_) {}
    }
    if (body) out.html = body.toString('utf8').slice(0, 300 * 1024);
  }
  return out;
}

/* 单文件直链 */
async function dlRunFile(sender, job, url, headers, filePath){
  const r = await dlReach(url, { headers });
  if (r.status >= 400) { try { r.req.abort(); } catch (_) {} throw new Error('下载失败（HTTP ' + r.status + '）'); }
  job.req = r.req;
  const total = dlSizeOf(r.headers);
  const out = fs.createWriteStream(filePath);
  job.out = out;
  await new Promise((resolve, reject) => {
    let got = 0, last = 0;
    r.res.on('data', c => {
      got += c.length; job.got = got;
      const now = Date.now();
      if (now - last > 200 || (total && got >= total)) {
        last = now;
        dlEmit(sender, { id: job.id, phase: 'file', got, total });
      }
    });
    r.res.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    r.res.on('error', reject);
    r.res.on('aborted', () => reject(new Error('连接中断')));
  });
}

/* HLS：分片合并。TS / fMP4 分片直接顺序拼接即可播放 */
async function dlRunHls(sender, job, url, headers, filePath){
  let base = url;
  let r = await dlGetText(url, headers, 4 * 1024 * 1024);
  if (r.status >= 400) throw new Error('播放列表请求失败（HTTP ' + r.status + '）');
  let pl = dlParsePlaylist(r.text, base);

  if (pl.variants.length){                          /* master：挑带宽最高的一路 */
    const best = pl.variants.slice().sort((a, b) => b.bw - a.bw)[0];
    base = best.url;
    r = await dlGetText(base, headers, 4 * 1024 * 1024);
    if (r.status >= 400) throw new Error('清晰度列表请求失败（HTTP ' + r.status + '）');
    pl = dlParsePlaylist(r.text, base);
  }
  if (!pl.segs.length) throw new Error('播放列表里没有可下载的分片');
  const bad = pl.segs.find(s => s.key && s.key.method !== 'AES-128');
  if (bad) throw new Error('该视频使用 DRM 加密（' + bad.key.method + '），无法下载');

  const out = fs.createWriteStream(filePath);
  job.out = out;
  const total = pl.segs.length;
  const keyCache = new Map();
  const initUrl = pl.init || (pl.segs[0] && pl.segs[0].init);

  if (initUrl){                                      /* fMP4 的初始化段必须先写 */
    const ib = (await dlGetBuf(initUrl, headers, 32 * 1024 * 1024)).body;
    await dlWrite(out, ib);
    job.got = ib.length;
  }
  for (let i = 0; i < total; i++){
    if (job.cancelled) break;
    const s = pl.segs[i];
    const sr = await dlGetBuf(s.url, headers, 96 * 1024 * 1024);
    if (sr.status >= 400) throw new Error('第 ' + (i + 1) + ' 个分片下载失败（HTTP ' + sr.status + '）');
    let buf = sr.body;
    if (s.key && s.key.method === 'AES-128' && s.key.url){
      let kb = keyCache.get(s.key.url);
      if (!kb) { kb = (await dlGetBuf(s.key.url, headers, 64 * 1024)).body; keyCache.set(s.key.url, kb); }
      buf = dlDecrypt(buf, kb, s.key.iv, s.seq);
    }
    await dlWrite(out, buf);
    job.got = (job.got || 0) + buf.length;
    dlEmit(sender, { id: job.id, phase: 'hls', done: i + 1, total, bytes: job.got });
  }
  await new Promise((resolve, reject) => { out.end(resolve); out.on('error', reject); });
}

async function dlRun(sender, job, p){
  const url = String(p.url || '');
  const headers = Object.assign({}, p.headers || {});
  const info = await dlProbe(url, headers);
  if (!info.ok) throw new Error('地址无法访问（HTTP ' + (info.status || '无响应') + '）');
  if (info.type === 'page') throw new Error('这是网页地址，不是视频直链');

  const isHls = info.type === 'hls' || p.mode === 'hls';
  let name = info.name || 'video';
  if (isHls) name = name.replace(/\.[a-z0-9]{2,5}$/i, '') + '.ts';

  /* savePath 只给自动化 / 后续"直接下到默认目录"用；页面正常走弹框 */
  let filePath = String(p.savePath || '');
  if (!filePath){
    const pick = await dialog.showSaveDialog(win || undefined, {
      title: '保存到本机',
      defaultPath: path.join(app.getPath('downloads'), name),
      filters: isHls
        ? [{ name: '视频流', extensions: ['ts'] }]
        : [{ name: '视频', extensions: [(name.split('.').pop() || 'mp4'), 'mp4', 'webm', 'mkv'] }]
    });
    if (pick.canceled || !pick.filePath) { dlEmit(sender, { id: job.id, cancelled: true }); return; }
    filePath = pick.filePath;
  }

  job.file = filePath;
  dlEmit(sender, { id: job.id, phase: 'start', name: path.basename(filePath) });
  try{
    if (isHls) await dlRunHls(sender, job, url, headers, filePath);
    else await dlRunFile(sender, job, url, headers, filePath);
    if (job.cancelled) return;
    dlEmit(sender, { id: job.id, phase: 'done', path: filePath, name: path.basename(filePath), size: job.got || 0 });
  }catch(e){
    if (job.cancelled) return;
    try { fs.unlinkSync(filePath); } catch (_) {}
    throw e;
  }
}

ipcMain.handle('lumen:dl-probe', async (_e, payload) => {
  const p = payload || {};
  try{
    return await dlProbe(String(p.url || ''), p.headers || {});
  }catch(e){
    return { ok: false, status: 0, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('lumen:dl-start', (e, payload) => {
  const id = 'dl' + (++dlSeq);
  const job = { id, cancelled: false, got: 0 };
  dlJobs.set(id, job);
  dlRun(e.sender, job, payload || {}).catch(err => {
    if (job.cancelled) return;
    dlEmit(e.sender, { id, phase: 'error', error: String((err && err.message) || err) });
  }).finally(() => { dlJobs.delete(id); });
  return { ok: true, id };
});

ipcMain.handle('lumen:dl-cancel', (_e, id) => {
  const job = dlJobs.get(String(id || ''));
  if (!job) return { ok: false };
  job.cancelled = true;
  try { if (job.req) job.req.abort(); } catch (_) {}
  try { if (job.out) job.out.destroy(); } catch (_) {}
  try { if (job.proc) job.proc.kill(); } catch (_) {}     /* 站点解析走子进程，杀掉即可 */
  if (job.file) setTimeout(() => { try { fs.unlinkSync(job.file); } catch (_) {} }, 150);
  return { ok: true };
});

ipcMain.handle('lumen:dl-reveal', (_e, p) => {
  try { if (p) shell.showItemInFolder(String(p)); return { ok: true }; } catch (e) { return { ok: false }; }
});

/* ============================================================
   五-c、站点解析组件（yt-dlp · Beta）
   ------------------------------------------------------------
   直链与 HLS 不需要任何外部程序；但 B站 / 抖音 / YouTube 这类
   页面的地址不是明文直链，只能靠站点解析器。做成「按需组件」：

   · 不随安装包分发 —— 安装包体积不变，也少一个杀软误报源
   · 首次用到时才下载到 userData/bin（约 17MB），之后本地待命
   · 站点改版时点「更新」即可，不必等新版本发布
   · 只列「单文件含音轨」的清晰度 —— 分离的音视频轨要 ffmpeg 合并，
     没装 ffmpeg 就不给用户一个只有画面的文件
   ============================================================ */

const { spawn } = require('child_process');

const ytBinDir = () => path.join(app.getPath('userData'), 'bin');
const ytFile = () => path.join(ytBinDir(), process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const ffFile = () => path.join(ytBinDir(), process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const ytRelName = () => (process.platform === 'win32' ? 'yt-dlp.exe'
  : process.platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp_linux');

/* 直连 GitHub 在国内常年超时，镜像放前面试；最后才回落到官方源 */
function ytSources(){
  const tail = '/yt-dlp/yt-dlp/releases/latest/download/' + ytRelName();
  return [
    'https://ghfast.top/https://github.com' + tail,
    'https://gh-proxy.com/https://github.com' + tail,
    'https://github.com' + tail
  ];
}

let ytVer = '';
let ytInstalling = false;

function webEmit(sender, msg){
  try{ if (sender && !sender.isDestroyed()) sender.send('lumen:web-progress', msg); }
  catch(_){}
}

function webState(){
  const f = ytFile();
  let size = 0, ok = false;
  try { size = fs.statSync(f).size; ok = size > 1024 * 1024; } catch (_) {}
  const ff = fs.existsSync(ffFile());
  return {
    ok: true, installed: ok, size, version: ok ? ytVer : '',
    ffmpeg: ff, dir: ytBinDir(), platform: process.platform
  };
}

/* 跑组件：只收输出，不经过 shell（参数里的地址原样传递，不拼命令行） */
function ytRun(args, opt){
  opt = opt || {};
  return new Promise(resolve => {
    let out = [], err = [], done = false;
    const line = { out: '', err: '' };
    let p;
    try {
      p = spawn(ytFile(), args, { windowsHide: true, cwd: ytBinDir() });
    } catch (e) {
      resolve({ code: -1, out: '', err: String((e && e.message) || e) });
      return;
    }
    if (opt.onSpawn) { try { opt.onSpawn(p); } catch (_) {} }
    const finish = r => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    const timer = opt.timeout ? setTimeout(() => {
      try { p.kill(); } catch (_) {}
      finish({ code: -1, out: Buffer.concat(out).toString('utf8'), err: '组件响应超时' });
    }, opt.timeout) : null;

    /* 进度行在 stderr（跟大多数命令行工具一样），JSON 在 stdout，两边都喂给 onLine */
    const eat = (which, chunk) => {
      if (!opt.onLine) return;
      line[which] += chunk.toString('utf8');
      let i;
      while ((i = line[which].indexOf('\n')) >= 0) {
        const L = line[which].slice(0, i).replace(/\r$/, '');
        line[which] = line[which].slice(i + 1);
        try { opt.onLine(L); } catch (_) {}
      }
    };

    p.stdout.on('data', c => { out.push(c); eat('out', c); });
    p.stderr.on('data', c => { err.push(c); eat('err', c); });
    p.on('error', e => finish({ code: -1, out: Buffer.concat(out).toString('utf8'), err: String((e && e.message) || e) }));
    p.on('close', code => finish({
      code,
      out: Buffer.concat(out).toString('utf8'),
      err: Buffer.concat(err).toString('utf8')
    }));
  });
}

/* 组件报错原样是英文长串，翻成人能看懂的一句 */
function ytErr(raw){
  const t = String(raw || '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .filter(s => /error|unable|unsupported|forbidden|sign in|private|not available|geo/i.test(s))
    .pop() || '';
  const s = t.replace(/^ERROR:\s*/i, '').trim().slice(0, 300);
  if (!s) return '解析失败';
  if (/Unsupported URL/i.test(s)) return '这个站点暂不支持解析';
  if (/HTTP Error 404/i.test(s)) return '视频不存在或已被删除';
  /* YouTube 2026 起对人机校验收得很紧：代理 / VPN / 机房 IP 上没登录态就被判机器人。
     原文是 "Sign in to confirm you're not a bot"，跟「视频要登录才能看」不是一回事 */
  if (/Sign in to confirm|not a bot/i.test(s)) return 'YouTube 要求人机验证：这个网络出口被判定成机器人（代理 / VPN / 共享 IP 常见）';
  if (/HTTP Error 403/i.test(s)) return '站点拒绝了请求（可能需要 Cookie 或已失效）';
  if (/Private video|unavailable|removed/i.test(s)) return '视频不可见或已下架';
  if (/login|account/i.test(s)) return '站点要求登录验证，这个视频需要 Cookie';
  if (/ffmpeg/i.test(s)) return '需要 ffmpeg 组件才能合并音视频';
  if (/timed out|timeout/i.test(s)) return '连接站点超时';
  return s;
}

/* 两个可选组件，都用「用到才下载」：
 *   ytdlp  —— 站点解析（约 23MB）
 *   ffmpeg —— 只用来把分离的音视频轨合成一个文件（约 77MB），
 *             B站 / YouTube 的 1080P 必须靠它，装不装由用户决定 */
const FF_SOURCES = [
  'https://ghfast.top/https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-win32-x64',
  'https://gh-proxy.com/https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-win32-x64',
  'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-win32-x64'
];

const WEB_COMPS = {
  ytdlp: { file: () => ytFile(), min: 5 * 1024 * 1024, sources: () => ytSources(), ver: true },
  ffmpeg: { file: () => ffFile(), min: 30 * 1024 * 1024, sources: () => FF_SOURCES, ver: false }
};

/* 下载组件本体：多个源依次试，落盘前校验 PE 头与体积，避免把错误页当 exe */
async function webInstall(sender, key){
  const id = WEB_COMPS[key] ? key : 'ytdlp';
  const comp = WEB_COMPS[id];
  if (ytInstalling) return { ok: false, error: '正在安装中' };
  ytInstalling = true;
  const target = comp.file();
  const tmp = target + '.part';
  let last = '';
  try {
    fs.mkdirSync(ytBinDir(), { recursive: true });
    for (const src of comp.sources()) {
      try {
        webEmit(sender, { phase: 'component', target: id, stage: 'connect', source: src });
        const r = await dlReach(src, { headers: { Accept: 'application/octet-stream' }, timeout: 20000 });
        if (r.status >= 400) {
          last = 'HTTP ' + r.status;
          try { r.req.abort(); } catch (_) {}
          continue;
        }
        const total = dlSizeOf(r.headers);
        const out = fs.createWriteStream(tmp);
        let got = 0, tick = 0;
        await new Promise((resolve, reject) => {
          r.res.on('data', c => {
            got += c.length;
            const now = Date.now();
            if (now - tick > 200) { tick = now; webEmit(sender, { phase: 'component', target: id, stage: 'download', got, total, source: src }); }
          });
          r.res.on('error', reject);
          r.res.on('aborted', () => reject(new Error('连接中断')));
          out.on('error', reject);
          out.on('finish', resolve);
          r.res.pipe(out);
        });
        const size = fs.statSync(tmp).size;
        const head = Buffer.alloc(2);
        const fd = fs.openSync(tmp, 'r');
        fs.readSync(fd, head, 0, 2, 0);
        fs.closeSync(fd);
        const pe = process.platform !== 'win32' || (head[0] === 0x4d && head[1] === 0x5a);
        if (size < comp.min || !pe) {
          last = '下载内容不是有效的组件（' + size + ' 字节）';
          try { fs.unlinkSync(tmp); } catch (_) {}
          continue;
        }
        try { fs.unlinkSync(target); } catch (_) {}
        fs.renameSync(tmp, target);
        try { fs.chmodSync(target, 0o755); } catch (_) {}
        if (comp.ver) {
          const v = await ytRun(['--version'], { timeout: 20000 });
          ytVer = (v.out || '').trim().split(/\r?\n/)[0] || '';
        }
        webEmit(sender, { phase: 'component', target: id, stage: 'done', size, version: comp.ver ? ytVer : '' });
        return Object.assign(webState(), { ok: true });
      } catch (e) {
        last = String((e && e.message) || e);
        try { fs.unlinkSync(tmp); } catch (_) {}
      }
    }
    return { ok: false, error: last || '下载失败' };
  } finally {
    ytInstalling = false;
  }
}

ipcMain.handle('lumen:web-state', async () => {
  const st = webState();
  if (st.installed && !ytVer) {
    const r = await ytRun(['--version'], { timeout: 15000 });
    ytVer = (r.out || '').trim().split(/\r?\n/)[0] || '';
    st.version = ytVer;
  }
  return st;
});

ipcMain.handle('lumen:web-install', async (e, payload) => {
  const p = payload || {};
  const key = p.target === 'ffmpeg' ? 'ffmpeg' : 'ytdlp';
  const st = webState();
  const done = key === 'ffmpeg' ? st.ffmpeg : st.installed;
  if (done && !p.force) return st;
  try { return await webInstall(e.sender, key); }
  catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
});

/* yt-dlp 2026 的 YouTube 提取要跑 JS 算签名，默认只认 deno（Windows 上极少有人装）。
 * node 普及得多，PATH 里能探到就显式喂给 --js-runtimes；探不到就照旧，其它站点不受影响。 */
let ytNodeBin;                                  /* undefined=没探过，''=真没有 */
function ytNodeRuntime(){
  if (ytNodeBin !== undefined) return ytNodeBin;
  ytNodeBin = '';
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    for (const exe of ['node.exe', 'node']) {
      const p = path.join(d, exe);
      try { if (fs.existsSync(p)) { ytNodeBin = p; return p; } } catch (_) {}
    }
  }
  return ytNodeBin;
}

/* 公共参数：站点需要 Referer / Cookie 时透传，别把用户挡在 403 外面 */
function ytCommon(url, headers, quiet){
  const a = ['--no-warnings', '--no-playlist', '--socket-timeout', '20'];
  if (quiet !== false) a.push('--no-progress');    /* 只读 JSON 时关掉进度；下载时必须留着 */
  const h = headers || {};
  if (h.Referer) a.push('--add-header', 'Referer: ' + h.Referer);
  if (h.Cookie) a.push('--add-header', 'Cookie: ' + h.Cookie);
  if (h['User-Agent']) a.push('--user-agent', h['User-Agent']);
  /* YouTube 的未登录请求会被判机器人（出口 IP 稍差就必中），
     用应用内登录窗口存下来的 Cookie 带上登录态，解析和下载都走同一条路 */
  try {
    if (isYouTubeHost(new URL(url).hostname) && ytHasCookies()) a.push('--cookies', ytCookiePath());
  } catch (_) {}
  /* YouTube 没有 JS 运行时只返回缩略图轨，等于没有可下载画质 */
  try {
    if (isYouTubeHost(new URL(url).hostname)) {
      const nd = ytNodeRuntime();
      if (nd) a.push('--js-runtimes', 'node:' + nd);
    }
  } catch (_) {}
  /* 本机地址绝不能走系统代理（挂了代理的机器会把 127.0.0.1 也发出去） */
  try {
    const host = new URL(url).hostname;
    if (/^(localhost|127\.|\[?::1\]?$)/i.test(host)) a.push('--proxy', '');
  } catch (_) {}
  return a;
}

/* ---------- YouTube 专项 ----------
 * 2026 年 YouTube 把网页端切到 SABR 协议，并对未登录请求做人机校验：
 *   · web 客户端在机房 / 代理 IP 上常直接回「Sign in to confirm you're not a bot」
 *   · 同一条视频换个客户端（tv / android / ios）往往就能拿到正常的 DASH 清单
 * 所以这里按「客户端组合」逐档重试，成功的这套参数记下来给下载复用——
 * 解析用一个客户端、下载换另一个，拿到的直链会直接 403。 */
const YT_CLIENT_SETS = [
  'youtube:player_client=tv_downgraded,mweb,android_vr',
  'youtube:player_client=tv,android,ios',
  ''
];
const ytPick = new Map();     /* videoId -> { args } */

function isYouTubeHost(host){
  return /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i.test(host || '');
}

function ytVideoId(u){
  const s = String(u || '');
  const m = s.match(/[?&]v=([A-Za-z0-9_-]{6,})/) || s.match(/(?:youtu\.be\/|\/shorts\/|\/embed\/|\/live\/)([A-Za-z0-9_-]{6,})/);
  return m ? m[1] : '';
}

function fileReadable(p){
  try { const fd = fs.openSync(p, 'r'); fs.closeSync(fd); return true; } catch (_) { return false; }
}

/* 本机浏览器里有没有能读的登录态：
 *   Chromium 系（Chrome 127+ 用 App-Bound 加密，且浏览器开着时 Cookie 库独占锁）多半读不到，
 *   读不到就别去试，免得白等一轮；Firefox 的 cookies.sqlite 开着也能读。 */
function ytCookieArgs(){
  const local = process.env.LOCALAPPDATA || '';
  const roam = process.env.APPDATA || '';
  const cands = [
    { b: 'chrome', f: path.join(local, 'Google/Chrome/User Data/Default/Network/Cookies') },
    { b: 'edge', f: path.join(local, 'Microsoft/Edge/User Data/Default/Network/Cookies') },
    { b: 'brave', f: path.join(local, 'BraveSoftware/Brave-Browser/User Data/Default/Network/Cookies') }
  ];
  for (const c of cands) if (c.f && fileReadable(c.f)) return { args: ['--cookies-from-browser', c.b], from: c.b };
  try {
    const ini = fs.readFileSync(path.join(roam, 'Mozilla/Firefox/profiles.ini'), 'utf8');
    const m = ini.match(/^Path=([^\r\n]+)/m);
    const db = m ? path.join(roam, 'Mozilla/Firefox', m[1].trim(), 'cookies.sqlite') : '';
    if (db && fs.existsSync(db)) return { args: ['--cookies-from-browser', 'firefox'], from: 'firefox' };
  } catch (_) {}
  return null;
}

/* 逐档试，失败就换下一档；拿到任何一档的结果就停 */
async function ytProbeYouTube(url, headers){
  const base = ytCommon(url, headers);
  const tries = [];
  for (const s of YT_CLIENT_SETS) tries.push(s ? ['--extractor-args', s] : []);
  /* 已经有自己的登录态文件时，别再试「读系统浏览器 Cookie」：
     Chrome 开着基本读不到，白等一轮还容易被误判成又失败一次 */
  const ck = ytHasCookies() ? null : ytCookieArgs();
  if (ck) tries.push(ck.args);

  const errs = [];
  for (const extra of tries) {
    const r = await ytRun(base.concat(extra, ['-J', '--', url]), { timeout: 60000 });
    if (r.code === 0) {
      ytPick.set(ytVideoId(url), { args: extra });
      return { r, cookie: !!extra.find(x => String(x).startsWith('--cookies')) };
    }
    const msg = ytErr(r.err || r.out);
    errs.push(msg);
    /* 视频本身没了 / 站点不支持，换参数和换 Cookie 都没用 */
    if (/不存在|已下架|不可见|暂不支持/.test(msg)) break;
    /* 人机校验：客户端换来换去都是同一条（实测 tv/android/mweb/embedded 全被拦），
       只有接下来那一档是「浏览器 Cookie」才值得再等一次，否则立刻收工 */
    if (/人机验证/.test(msg)) {
      const ni = tries.indexOf(extra) + 1;
      const nextCookie = ck && ni < tries.length && tries[ni] === ck.args;
      if (!nextCookie) break;
    }
  }
  /* 同一个原因重复出现时只说一次，别让界面上一串同义句 */
  const uniq = errs.filter((m, i) => errs.indexOf(m) === i);
  return { r: null, error: uniq.pop() || '解析失败', tried: uniq, cookie: !!ck };
}

/* ---------- YouTube 登录态 ----------
 * 系统浏览器里的登录态拿不到：Chrome 127+ 的 Cookie 用 App-Bound 加密，
 * 浏览器开着时库还被独占锁（yt-dlp 直接报 Could not copy Chrome cookie database）。
 * 所以在应用内开一个登录窗口，用独立分区存登录态，登录完把 Cookie 导成
 * Netscape 格式给 yt-dlp —— 解析和下载都带上，人机校验自然就过了。
 * 只写本机 userData，不上传；换账号重新登录会覆盖。 */
const YT_LOGIN_PART = 'persist:lumen-ytlogin';
let ytLoginWin = null;
let ytLoginBusy = null;

function ytCookiePath(){ return path.join(app.getPath('userData'), 'cookies', 'youtube.txt'); }
function ytHasCookies(){
  try { return fs.statSync(ytCookiePath()).size > 200; } catch (_) { return false; }
}

async function ytExportCookies(){
  const ses = session.fromPartition(YT_LOGIN_PART);
  const list = await ses.cookies.get({});
  const rows = ['# Netscape HTTP Cookie File', '# 由 Lumen 工作台从应用内登录窗口导出，仅存本机', ''];
  let n = 0;
  for (const c of list) {
    const d = String(c.domain || '');
    if (!/(^|\.)(youtube\.com|google\.com|youtu\.be)$/i.test(d)) continue;
    rows.push([
      (c.httpOnly ? '#HttpOnly_' : '') + d,
      d.charAt(0) === '.' ? 'TRUE' : 'FALSE',
      c.path || '/',
      c.secure ? 'TRUE' : 'FALSE',
      String(Math.round(c.expirationDate || 0)),
      c.name,
      c.value
    ].join('\t'));
    n++;
  }
  if (!n) return 0;
  const f = ytCookiePath();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, rows.join('\n') + '\n', 'utf8');
  return n;
}

async function ytLoginFlow(){
  if (ytLoginWin && !ytLoginWin.isDestroyed()) { try { ytLoginWin.focus(); } catch (_) {} return { ok: false, pending: true }; }
  const ses = session.fromPartition(YT_LOGIN_PART);
  try { ses.setUserAgent(RENDER_UA); } catch (_) {}

  return new Promise(resolve => {
    let settled = false, timer = null;
    const finish = r => {
      if (settled) return;
      settled = true;
      if (timer) { clearInterval(timer); timer = null; }
      resolve(r);
    };
    const win2 = new BrowserWindow({
      width: 1000, height: 780, parent: win && !win.isDestroyed() ? win : undefined,
      title: '登录 YouTube · 登录态只保存在本机',
      autoHideMenuBar: true, backgroundColor: '#1b1b1f',
      webPreferences: {
        partition: YT_LOGIN_PART, nodeIntegration: false, contextIsolation: true,
        sandbox: true, spellcheck: false
      }
    });
    ytLoginWin = win2;
    try { win2.setMenuBarVisibility(false); } catch (_) {}
    win2.webContents.setWindowOpenHandler(({ url }) => {
      try { win2.loadURL(url); } catch (_) {}
      return { action: 'deny' };
    });
    win2.on('closed', () => { ytLoginWin = null; finish({ ok: false, cancelled: true }); });
    win2.loadURL('https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F').catch(() => {});

    const started = Date.now();
    /* 登录成功的判据：分区里出现了 Google 的登录 Cookie。
       已经在别的窗口登过就是秒过；没登过就等用户自己输，最长 5 分钟 */
    timer = setInterval(async () => {
      if (settled) return;
      if (Date.now() - started > 300000) { try { win2.close(); } catch (_) {} finish({ ok: false, error: '登录超时' }); return; }
      let list = [];
      try { list = await ses.cookies.get({}); } catch (_) {}
      const ok = list.some(c => /^(SID|__Secure-1PSID|__Secure-3PSID|SAPISID)$/.test(c.name) &&
        /(^|\.)(youtube\.com|google\.com)$/i.test(String(c.domain || '')));
      if (!ok) return;
      let n = 0;
      try { n = await ytExportCookies(); } catch (_) {}
      if (!n) return;
      finish({ ok: true, count: n });
      setTimeout(() => { try { if (!win2.isDestroyed()) win2.close(); } catch (_) {} }, 700);
    }, 1500);
  });
}

ipcMain.handle('lumen:yt-login', () => {
  if (!ytLoginBusy) ytLoginBusy = ytLoginFlow().finally(() => { ytLoginBusy = null; });
  return ytLoginBusy;
});

ipcMain.handle('lumen:yt-cookie', () => ({ ok: true, has: ytHasCookies(), file: ytHasCookies() ? ytCookiePath() : '' }));

/* ---------- 从系统浏览器导入登录态 ----------
 * 「网页版已经登录了」这个场景很常见，但应用读不到系统浏览器的 Cookie：
 * 浏览器开着时 Cookie 库被独占锁，Chrome 127+ 还加了 App-Bound 加密（拷出来也解不开）。
 * 所以给两条手工通道，都不需要重新输账号：
 *   1. 把浏览器请求头里的 Cookie 整串粘进来（DevTools → Network → 任一 youtube 请求 → Cookie）
 *   2. 导入扩展导出的 cookies.txt
 * 统一转成 Netscape 格式的文件，解析和下载共用同一份。 */
const CK_HOSTS = /(^|\.)(youtube\.com|google\.com|youtu\.be)$/i;

function ytCookieRows(raw){
  const s = String(raw || '').trim();
  if (!s) return { rows: [], error: '粘贴的内容是空的' };
  const rows = [];
  const seen = new Set();
  const exp = Math.round(Date.now() / 1000) + 400 * 86400;
  const push = (domain, p2, secure, e2, name, value, httpOnly) => {
    if (!name || !value) return;
    const k = name + '\t' + domain;
    if (seen.has(k)) return;
    seen.add(k);
    rows.push([
      (httpOnly ? '#HttpOnly_' : '') + domain,
      domain.charAt(0) === '.' ? 'TRUE' : 'FALSE',
      p2 || '/', secure ? 'TRUE' : 'FALSE', String(e2 || 0), name, value
    ].join('\t'));
  };

  for (const line0 of s.split(/\r?\n/)) {
    const line = line0.trim();
    /* cookie 值里不会有 tab 之外的麻烦字符，按行判断是哪种格式 */
    if (!line || /^#(?!HttpOnly_)/.test(line)) continue;
    if (line.includes('\t')) {
      const httpOnly = line.startsWith('#HttpOnly_');
      const f = line.replace(/^#HttpOnly_/, '').split('\t');
      if (f.length < 7 || !CK_HOSTS.test(f[0])) continue;
      push(f[0], f[2], /^TRUE$/i.test(f[3]), Number(f[4]) || exp, f[5], f.slice(6).join('\t'), httpOnly);
      continue;
    }
    /* 请求头格式没有域名，统一挂到 .youtube.com（Google 的登录 Cookie 同时也在 .youtube.com 下） */
    const body = line.replace(/^cookie\s*:\s*/i, '');
    for (const part of body.split(';')) {
      const t = part.trim();
      const i = t.indexOf('=');
      if (i <= 0) continue;
      const name = t.slice(0, i).trim();
      const value = t.slice(i + 1).trim();
      /* 超过 4KB 的单条基本是别的站点串进来了，丢掉 */
      if (!name || !value || value.length > 4096) continue;
      push('.youtube.com', '/', true, exp, name, value, /^(SID|HSID|SSID|APISID|SAPISID|__Secure-|__Host-)/.test(name));
    }
  }
  if (!rows.length) return { rows: [], error: '没认出 Cookie：需要 name=value; name=value 这种整串，或 cookies.txt 文件' };
  return { rows, error: '' };
}

function ytWriteCookieRows(rows){
  const f = ytCookiePath();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '# Netscape HTTP Cookie File\n# 由 Lumen 工作台导入，仅存本机\n\n' + rows.join('\n') + '\n', 'utf8');
  return f;
}

ipcMain.handle('lumen:yt-cookie-set', (_e, p) => {
  const r = ytCookieRows(p && p.raw);
  if (!r.rows.length) return { ok: false, error: r.error };
  try { ytWriteCookieRows(r.rows); } catch (e) { return { ok: false, error: '写登录态失败：' + String((e && e.message) || e) }; }
  return { ok: true, count: r.rows.length };
});

ipcMain.handle('lumen:yt-cookie-file', async () => {
  const opt = { title: '选择 cookies.txt', properties: ['openFile'], filters: [{ name: 'cookies.txt', extensions: ['txt'] }, { name: '所有文件', extensions: ['*'] }] };
  const r = (win && !win.isDestroyed()) ? await dialog.showOpenDialog(win, opt) : await dialog.showOpenDialog(opt);
  if (!r || r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, cancelled: true };
  let raw = '';
  try { raw = fs.readFileSync(r.filePaths[0], 'utf8'); } catch (_) { return { ok: false, error: '读不了这个文件' }; }
  const rows = ytCookieRows(raw);
  if (!rows.rows.length) return { ok: false, error: rows.error };
  try { ytWriteCookieRows(rows.rows); } catch (e) { return { ok: false, error: '写登录态失败：' + String((e && e.message) || e) }; }
  return { ok: true, count: rows.rows.length };
});

ipcMain.handle('lumen:yt-cookie-clear', () => {
  try { fs.unlinkSync(ytCookiePath()); } catch (_) {}
  return { ok: true, has: ytHasCookies() };
});

/* ---------- 浏览器渲染解析 ----------
 * 有些站点的播放接口要求 JS 生成的签名（抖音的 a_bogus / msToken、小红书的 x-s 等），
 * 第三方组件跟不上这种对抗。这里直接用真实 Chromium 打开页面，让页面自己的脚本去算签名，
 * 然后从 <video> 或网络请求里把播放地址取出来。签名算法变了也不影响，因为算签名的是页面本身。 */
const RENDER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
let renderSes = null;

function renderSession(){
  /* 用持久分区：访客 Cookie / 登录态留在本机，下次解析还认得，用户不用反复登录 */
  if (!renderSes) renderSes = session.fromPartition('persist:lumen-render');
  return renderSes;
}

function hostOf(u){
  try { return new URL(u).hostname.toLowerCase(); } catch (_) { return ''; }
}

function isDouyinHost(host){ return /(^|\.)douyin\.com$/i.test(host) || /(^|\.)iesdouyin\.com$/i.test(host); }

/* 抖音的 /jingxuan、/discover、用户主页这些是信息流，里面没有单一视频 */
function isDouyinFeed(u){
  const h = hostOf(u);
  if (!isDouyinHost(h)) return false;
  if (/\/(video|note)\/\d{6,}/.test(u)) return false;
  if (/v\.douyin\.com/i.test(h)) return false;
  return true;
}

function renderPage(url, opt){
  const o = opt || {};
  const timeout = o.timeout || 22000;
  return new Promise(resolve => {
    let done = false, win = null, timer = null, poll = null;
    const hits = [];
    const ses = renderSession();

    const onReq = (d, cb) => {
      const u = d.url;
      if (/\.(mp4|webm|m3u8)(\?|$)/i.test(u) || /douyinvod|douyinstatic.*\/video\//.test(u) || /\/aweme\/v1\/play\//.test(u)) {
        if (hits.length < 30) hits.push(u);
      }
      cb({});
    };

    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (poll) { clearInterval(poll); poll = null; }
      try { ses.webRequest.onBeforeRequest(null); } catch (_) {}
      try { if (win && !win.isDestroyed()) win.destroy(); } catch (_) {}
    };

    const finish = res => {
      if (done) return;
      done = true;
      cleanup();
      resolve(res);
    };

    try {
      ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, onReq);
      win = new BrowserWindow({
        show: false, width: 1280, height: 900,
        webPreferences: {
          session: ses,
          backgroundThrottling: false,     /* 隐藏窗口里也要让定时器和视频照常跑 */
          images: false                    /* 不加载图片，省带宽也快一点 */
        }
      });
      win.webContents.setUserAgent(RENDER_UA);
      win.webContents.on('did-fail-load', (_e, code, desc) => finish({ ok: false, error: '页面打不开（' + (desc || code) + '）' }));
    } catch (e) {
      return finish({ ok: false, error: '无法创建渲染窗口：' + ((e && e.message) || e) });
    }

    win.webContents.loadURL(url).catch(() => {});

    const startedAt = Date.now();
    let srcSince = 0;

    const grab = async () => {
      try {
        const info = await win.webContents.executeJavaScript(`(() => {
          /* 页面上可能不止一个 <video>（背景动画/预览也算），挑画面最大的那个 */
          const vs = Array.from(document.querySelectorAll('video'));
          let best = null;
          for (const v of vs) {
            const src = v.currentSrc || v.src || '';
            if (!/^https?:/i.test(src)) continue;
            const area = (v.videoWidth || 0) * (v.videoHeight || 0);
            if (!best || area > best.area) best = { src, w: v.videoWidth || 0, h: v.videoHeight || 0,
              dur: isFinite(v.duration) ? Math.round(v.duration) : 0, area };
          }
          /* 有些页面 preload=none，元数据一直不解析 → 静音播一下把尺寸逼出来 */
          if (best && !best.h) {
            const el = vs.find(v => (v.currentSrc || v.src) === best.src);
            if (el) {
              try { el.muted = true; el.preload = 'metadata'; const pr = el.play(); if (pr && pr.catch) pr.catch(() => {}); } catch (_) {}
            }
          }
          return best ? Object.assign(best, {
            title: document.title
              || (document.querySelector('meta[property="og:title"]') || {}).content
              || (document.querySelector('h1') || {}).textContent
              || ''
          }) : null;
        })()`, true);
        if (!info) return false;              /* 还没出现 <video>，继续等 */
        if (!srcSince) srcSince = Date.now();
        /* 只拿到 src 但元数据还没解析出来时，再等一会儿，好让分辨率有值 */
        if ((!info.h || !String(info.title || '').trim()) && Date.now() - srcSince < 9000) return false;
        /* 标题还没渲染出来时 getTitle() 会返回地址，别把它当标题 */
        let title = String(info.title || '').trim();
        if (!title || /^https?:/i.test(title) || /^(www\.)?[a-z0-9-]+\.(com|cn|net)\//i.test(title)) {
          title = String(win.webContents.getTitle() || '').trim();
        }
        if (/^https?:/i.test(title) || /^(www\.)?[a-z0-9-]+\.(com|cn|net)\//i.test(title)) title = '';
        finish({
          ok: true,
          url: info.src,
          title: title.replace(/\s*-\s*抖音\s*$/, '').slice(0, 120),
          w: info.w, h: info.h, duration: info.dur,
          ext: /\.m3u8(\?|$)/i.test(info.src) ? 'm3u8' : 'mp4'
        });
        return true;
      } catch (_) {}
      return false;
    };

    poll = setInterval(async () => {
      if (done) return;
      if (await grab()) return;
      /* 兜底：页面用 MSE/懒加载时 <video> 没有可用 src，但网络里已经有真正的视频流。
         只认内容域（douyinvod / video/tos / play 接口），别把页面自己的 UI 动画 mp4 当成视频。 */
      if (Date.now() - startedAt > 6000) {
        const u = hits.find(x => /douyinvod|\/video\/tos\/|\/aweme\/v1\/play\//.test(x));
        if (u) {
          finish({
            ok: true, url: u, title: String(win.webContents.getTitle() || '').replace(/\s*-\s*抖音\s*$/, '').slice(0, 120),
            w: 0, h: 0, duration: 0, ext: /\.m3u8(\?|$)/i.test(u) ? 'm3u8' : 'mp4'
          });
        }
      }
    }, 700);

    timer = setTimeout(() => finish({ ok: false, error: '页面里没找到可以下载的视频（可能需要登录，或这条内容本身不可播放）' }), timeout);
  });
}

async function renderFormats(url, extra){
  const r = await renderPage(url, { timeout: 22000 });
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || '渲染解析失败' };
  const fmt = {
    id: 'direct', ext: r.ext === 'm3u8' ? 'ts' : 'mp4',
    h: r.h || 0, w: r.w || 0, fps: 0, v: true, a: true,
    size: 0, tbr: 0, note: ''
  };
  return Object.assign({
    ok: true, site: 'render', render: true,
    title: r.title || '', duration: r.duration || 0, uploader: '',
    formats: [fmt], audio: null, needMerge: false, mergeH: 0,
    ffmpeg: fs.existsSync(ffFile()),
    direct: r.url
  }, extra || {});
}

ipcMain.handle('lumen:web-formats', async (_e, payload) => {
  const p = payload || {};
  const url = String(p.url || '');
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: '只支持 http / https 地址' };

  const host = hostOf(url);

  /* 抖音：yt-dlp 的 web detail 接口需要 a_bogus 签名（官方源码里仍是 TODO，必 403），
     所以不走组件，直接用渲染解析。信息流页面提前拦下来，给能看懂的提示。 */
  if (isDouyinHost(host)) {
    if (isDouyinFeed(url)) {
      return {
        ok: false, feed: true,
        error: '这是抖音的信息流页面，不是一个视频。请在抖音里打开视频 → 分享 → 复制链接，再粘进来'
      };
    }
    const rd = await renderFormats(url);
    if (rd.ok) return rd;
    return { ok: false, error: rd.error || '抖音页面解析失败' };
  }

  if (!fs.existsSync(ytFile())) return { ok: false, needInstall: true, error: '解析组件还没安装' };

  let r;
  if (isYouTubeHost(host)) {
    const y = await ytProbeYouTube(url, p.headers);
    if (!y.r) {
      return {
        ok: false, error: y.error, yt: true,
        hint: '这是 YouTube 对未登录请求的人机校验，跟视频本身无关，换播放器客户端也绕不过。' +
          '点下面的按钮在应用内登录一次即可（登录态只存本机，解析和下载都会带上）。' +
          '也可以换一个代理节点（日本 / 新加坡 / 住宅线路）再试。'
      };
    }
    r = y.r;
  } else {
    r = await ytRun(ytCommon(url, p.headers).concat(['-J', '--', url]), { timeout: 90000 });
  }
  if (r.code !== 0) {
    const msg = ytErr(r.err || r.out);
    /* 组件啃不动的（签名 / 403 / 不支持），再用渲染兜一层；纯网络错误就别白等 20 秒。
       YouTube 的播放器走 MSE，<video> 里没有可下载地址，渲染这层对它无效 */
    if (!isYouTubeHost(host) && /cookie|403|signature|not.*support|unsupported|无法|解析失败/i.test(msg)) {
      const rd = await renderFormats(url);
      if (rd.ok) return rd;
    }
    return { ok: false, error: msg };
  }
  let j = null;
  try { j = JSON.parse(r.out); } catch (_) { return { ok: false, error: '解析结果不完整（站点返回了页面而不是数据）' }; }
  if (j && j._type === 'playlist' && j.entries && j.entries.length) j = j.entries[0];

  const fmts = (Array.isArray(j.formats) ? j.formats : []).map(f => ({
    id: String(f.format_id || ''),
    ext: f.ext || '',
    h: f.height || 0,
    w: f.width || 0,
    fps: f.fps || 0,
    v: !!f.vcodec && f.vcodec !== 'none',
    a: !!f.acodec && f.acodec !== 'none',
    size: f.filesize || f.filesize_approx || 0,
    tbr: Math.round(f.tbr || 0),
    note: f.format_note || ''
  })).filter(f => f.id && (f.v || f.a));

  /* 有些站点（比如内嵌 <video> 的页面）不返回 formats，只在顶层给一个 url */
  if (!fmts.length && j.url) {
    const audioOnly = j.vcodec === 'none' || /^(mp3|m4a|aac|opus|ogg|wav|flac)$/i.test(j.ext || '');
    fmts.push({
      id: 'best', ext: j.ext || 'mp4', h: j.height || 0, w: j.width || 0, fps: j.fps || 0,
      v: !audioOnly, a: true,
      size: j.filesize || j.filesize_approx || 0, tbr: Math.round(j.tbr || 0), note: ''
    });
  }

  const byQ = (x, y) => (y.h - x.h) || (y.tbr - x.tbr);
  const prog = fmts.filter(f => f.v && f.a).sort(byQ);
  const audio = fmts.filter(f => f.a && !f.v).sort((x, y) => y.tbr - x.tbr);
  const vonly = fmts.filter(f => f.v && !f.a).sort(byQ);
  const bestV = vonly[0] || null;
  const bestP = prog[0] || null;

  const seen = new Set();
  const list = prog.filter(f => { const k = f.h + ':' + f.ext; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 12);

  /* YouTube 缺 JS 运行时 / 被风控时，yt-dlp 会「成功」返回但 formats 里只剩 storyboard（缩略图轨）。
     别让界面显示「解析成功、却没有清晰度」让人干瞪眼，直接给实验性说明和下一步。 */
  if (isYouTubeHost(host) && !list.length && !audio.length) {
    return {
      ok: false, yt: true, experimental: true,
      error: '这条 YouTube 视频没有解析出可下载的画质（只返回了缩略图轨）',
      hint: 'YouTube 2026 年起要求下载请求带 JS 运行时签名（PO token），常见结果是拿不到任何视频流。' +
        '已经尝试借用本机的 Node.js 运行时，仍可能被拦。B站 / 抖音 / 直链不受影响。'
    };
  }

  return {
    ok: true,
    site: j.extractor_key || j.extractor || '',
    title: String(j.title || '').slice(0, 200),
    duration: j.duration || 0,
    uploader: String(j.uploader || j.channel || '').slice(0, 80),
    formats: list,
    audio: audio[0] ? { id: audio[0].id, ext: audio[0].ext, tbr: audio[0].tbr, size: audio[0].size } : null,
    /* 有更高画质的分离流，但本机没 ffmpeg → 只提示，不列出来当选项 */
    needMerge: !!(bestV && (!bestP || bestV.h > bestP.h)),
    mergeH: bestV ? bestV.h : 0,
    ffmpeg: fs.existsSync(ffFile())
  };
});

async function webDownload(sender, job, p){
  const url = String(p.url || '');
  /* 渲染解析出来的直链不需要组件：直接流式下载 */
  const direct = /^https?:\/\//i.test(String(p.direct || '')) ? String(p.direct) : '';
  if (!direct && !fs.existsSync(ytFile())) throw new Error('解析组件还没安装');

  const fmt = String(p.format || 'best');
  const isAudio = !/\+/.test(fmt) && /^ba|audio/i.test(fmt);
  const title = String(p.title || 'video').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 80) || 'video';
  const guess = isAudio ? (p.ext || 'm4a') : (p.ext || 'mp4');

  const workDir = path.join(app.getPath('userData'), 'cache', 'webdl', job.id);
  fs.mkdirSync(workDir, { recursive: true });
  job.dir = workDir;

  let filePath = String(p.savePath || '');
  if (!filePath) {
    const pick = await dialog.showSaveDialog(win || undefined, {
      title: '保存到本机',
      defaultPath: path.join(app.getPath('downloads'), title + '.' + guess),
      filters: [{ name: '视频 / 音频', extensions: ['mp4', 'mkv', 'webm', 'm4a', 'mp3', 'opus'] }]
    });
    if (pick.canceled || !pick.filePath) {
      job.cancelled = true;
      dlEmit(sender, { id: job.id, cancelled: true });
      return;
    }
    filePath = pick.filePath;
  }

  /* 直链（渲染解析得到）：走和普通下载一样的流式落盘，支持进度与取消 */
  if (direct) {
    dlEmit(sender, { id: job.id, phase: 'start', name: path.basename(filePath) });
    const hd = Object.assign({ 'User-Agent': RENDER_UA, Referer: 'https://www.douyin.com/' }, p.headers || {});
    await dlRunFile(sender, job, direct, hd, filePath);
    if (job.cancelled) return;
    let dsize = 0;
    try { dsize = fs.statSync(filePath).size; } catch (_) {}
    dlEmit(sender, { id: job.id, phase: 'done', path: filePath, name: path.basename(filePath), size: dsize });
    return;
  }

  const hasFf = fs.existsSync(ffFile());
  const args = ytCommon(url, p.headers, false).concat([
    '--no-part', '--newline',
    '--progress-template',
    'download:ytp:%(progress.downloaded_bytes)s/%(progress.total_bytes)s/%(progress.total_bytes_estimate)s/%(progress.speed)s',
    '-f', fmt,
    '-o', path.join(workDir, 'out.%(ext)s')
  ]);
  if (hasFf) args.push('--ffmpeg-location', ytBinDir(), '--merge-output-format', 'mp4');
  /* 解析时哪组客户端拿到了清单，下载就沿用哪组，否则直链签名对不上会 403 */
  const pk = ytPick.get(ytVideoId(url));
  if (pk && pk.args && pk.args.length) args.push(...pk.args);
  args.push('--', url);

  dlEmit(sender, { id: job.id, phase: 'start', name: path.basename(filePath) });
  const r = await ytRun(args, {
    onSpawn: pr => { job.proc = pr; },
    onLine: L => {
      /* --progress-template 的 "download:" 只是类型选择器，不会出现在输出里，
         所以模板自己带 ytp: 前缀，只认自己的行 */
      if (!L.startsWith('ytp:')) return;
      const parts = L.slice(4).split('/');
      const got = parseInt(parts[0], 10) || 0;
      const total = parseInt(parts[1], 10) || parseInt(parts[2], 10) || 0;
      const now = Date.now();
      if (now - (job.tick || 0) < 220) return;
      job.tick = now;
      job.got = got;
      dlEmit(sender, { id: job.id, phase: 'file', got, total, speed: parseInt(parts[3], 10) || 0 });
    }
  });
  if (job.cancelled) return;
  if (r.code !== 0) throw new Error(ytErr(r.err || r.out));

  const made = fs.readdirSync(workDir).filter(n => /^out\.[^.]+$/.test(n));
  if (!made.length) throw new Error('组件没有产出文件');
  const src = path.join(workDir, made[0]);
  const realExt = (made[0].split('.').pop() || guess).toLowerCase();

  /* 实际封装格式可能与用户选的扩展名不同（站点只给 webm 之类），以真实后缀为准 */
  if (!new RegExp('\\.' + realExt + '$', 'i').test(filePath)) filePath = filePath.replace(/\.[^.\\/]+$/, '') + '.' + realExt;

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try { fs.renameSync(src, filePath); }
  catch (_) { fs.copyFileSync(src, filePath); try { fs.unlinkSync(src); } catch (_) {} }

  let size = 0;
  try { size = fs.statSync(filePath).size; } catch (_) {}
  dlEmit(sender, { id: job.id, phase: 'done', path: filePath, name: path.basename(filePath), size });
}

ipcMain.handle('lumen:web-start', (e, payload) => {
  const id = 'wd' + (++dlSeq);
  const job = { id, cancelled: false, got: 0 };
  dlJobs.set(id, job);
  webDownload(e.sender, job, payload || {}).catch(err => {
    if (job.cancelled) return;
    dlEmit(e.sender, { id, phase: 'error', error: String((err && err.message) || err) });
  }).finally(() => {
    dlJobs.delete(id);
    if (job.dir) { try { fs.rmSync(job.dir, { recursive: true, force: true }); } catch (_) {} }
  });
  return { ok: true, id };
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
    const r = await httpFetch(url, {
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

/* ============================================================
   五-b、本机能力：剪贴板历史 + 系统信息
   ------------------------------------------------------------
   这两件事**只能**在主进程做（所以网页版直开时页面侧要降级）：
     · 剪贴板 —— 窗口没焦点时也要继续记（你在别的程序里复制），
       Electron 的 clipboard 模块在主进程里随时可读；页面的
       navigator.clipboard 需要焦点 + 授权，读图更是不可能。
     · 系统信息 —— 物理核数、显卡型号、完整内存量、多屏参数，
       navigator 只肯吐极小一部分（且各浏览器口径不一）。
   渲染层看到的是 lumenClip / lumenSys 两个桥，别的什么都不碰。 */
const CLIP_FILE = (() => {
  try { return path.join(app.getPath('userData'), 'lumen-clip.json'); }
  catch (e) { return path.join(os.tmpdir(), 'lumen-clip.json'); }
})();
const CLIP_MAX = 100;                     /* 条目总数上限，超出丢最旧 */
const CLIP_IMG_MAX = 20;                  /* 图片条目另设上限（base64 太占地方） */
const CLIP_FILE_MAX = 8 * 1024 * 1024;    /* 落盘上限，超了从最旧的图片开始砍 */
const CLIP_TEXT_MAX = 20000;              /* 单条文本上限（整篇文档别塞满存储） */
const CLIP_IMG_FULL_MAX = 2 * 1024 * 1024;/* 原图超过这个只留缩略图（回填时告知） */
const CLIP_TICK = 900;                    /* 轮询间隔 */

let clipItems = [];
let clipWatch = true;
let clipTimer = null;
let clipSig = '';          /* 上一次读到的指纹，用来去重 */
let clipKind = '';         /* 上一次读到的类型：files / text / image */
let clipPrimed = false;    /* 首次轮询只认指纹不入库（别把启动前的旧剪贴板也记进来） */
let clipQuiet = 0;         /* 「回填到剪贴板」之后的静默窗口，别把自己写进去的又记一遍 */
let clipSeq = 0;

function clipLoad() {
  try {
    const d = JSON.parse(fs.readFileSync(CLIP_FILE, 'utf8'));
    if (Array.isArray(d.items)) clipItems = d.items.slice(0, CLIP_MAX);
    if (typeof d.watch === 'boolean') clipWatch = d.watch;
    for (const it of clipItems) {
      const n = Number(String(it.id || '').replace(/^c/, '').split('-')[0]);
      if (n > clipSeq) clipSeq = n;
    }
  } catch (e) {}
}
function clipSave() {
  try {
    let json = JSON.stringify({ watch: clipWatch, items: clipItems });
    /* 体积兜底：从最旧的图片条目开始砍，直到落盘大小达标 */
    while (json.length > CLIP_FILE_MAX && clipItems.some(x => x.type === 'image')) {
      for (let k = clipItems.length - 1; k >= 0; k--) {
        if (clipItems[k].type === 'image') { clipItems.splice(k, 1); break; }
      }
      json = JSON.stringify({ watch: clipWatch, items: clipItems });
    }
    fs.writeFileSync(CLIP_FILE, json);
  } catch (e) {}
}
/* 分两类上限修剪：非图片按总数、图片单独计数（filter 重建，别用 splice 按下标删，
   下标会在删除过程中错位，把相邻的文本条目一起带走） */
function clipTrim() {
  let imgs = 0;
  clipItems = clipItems.filter(x => {
    if (x.type !== 'image') return true;
    imgs++;
    return imgs <= CLIP_IMG_MAX;
  });
  if (clipItems.length > CLIP_MAX) clipItems.length = CLIP_MAX;
}
/* 列表用的轻量视图：图片只带缩略图，原图留在主进程里（IPC 别扛着几 MB 的 base64 来回跑） */
function clipEntry(x) {
  const o = { id: x.id, type: x.type, ts: x.ts };
  if (x.type === 'text') o.text = x.text;
  if (x.type === 'files') o.files = x.files;
  if (x.type === 'image') { o.thumb = x.thumb; o.w = x.w; o.h = x.h; o.big = !!x.big; }
  return o;
}
function clipAdd(entry) {
  entry.id = 'c' + (++clipSeq) + '-' + Date.now().toString(36);
  entry.ts = Date.now();
  clipItems.unshift(entry);
  clipTrim();
  clipSave();
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('lumen:clip-new', clipEntry(entry)); } catch (e) {}
  }
  return entry;
}
/* 复制进来的文件（Windows 的 CF_HDROP）。Electron 没有专门的读接口，
   FileNameW 是块 UTF-16LE、以 \0 分隔的缓冲区，自己拆。 */
function clipReadFiles() {
  if (process.platform !== 'win32') return [];
  try {
    const buf = clipboard.readBuffer('FileNameW');
    if (!buf || !buf.length) return [];
    return buf.toString('utf16le').split('\u0000').map(s => s.trim()).filter(Boolean);
  } catch (e) { return []; }
}
function clipThumb(img) {
  try {
    const s = img.getSize();
    const out = s.width > 320 ? img.resize({ width: 320, quality: 'good' }) : img;
    return 'data:image/png;base64,' + out.toPNG().toString('base64');
  } catch (e) { return ''; }
}
/* 读一次剪贴板。图片这一支要跑 toPNG（整屏截图上百毫秒），所以只在
   「类型刚刚变成图片」的边沿或显式刷新时才做，别每 900ms 烧一次 CPU。 */
function clipPoll(force) {
  if (!clipWatch && !force) return;
  /* 首次轮询只认指纹不入库：启动前就躺在剪贴板里的东西别冒充「刚复制的」。
     显式刷新（force）例外 —— 那是用户自己在页面上点的「立即读取」。 */
  const dry = !clipPrimed && !force;
  clipPrimed = true;
  const quiet = dry || Date.now() < clipQuiet;

  const files = clipReadFiles();
  if (files.length) {
    const sig = 'F:' + files.join('|');
    const edge = clipKind !== 'files';
    clipKind = 'files';
    if (quiet || sig === clipSig) { clipSig = sig; return; }
    clipSig = sig;
    if (edge) clipAdd({ type: 'files', files: files.slice(0, 50) });
    return;
  }

  const txt = String(clipboard.readText() || '');
  if (txt) {
    const sig = 'T:' + txt.length + ':' + txt.slice(0, 200);
    clipKind = 'text';
    if (quiet || sig === clipSig) { clipSig = sig; return; }
    clipSig = sig;
    clipAdd({ type: 'text', text: txt.slice(0, CLIP_TEXT_MAX) });
    return;
  }

  let img = null;
  try { img = clipboard.readImage(); } catch (e) { img = null; }
  if (!img || (typeof img.isEmpty === 'function' && img.isEmpty())) { clipKind = ''; return; }
  const sz = img.getSize();
  const edge = clipKind !== 'image';
  clipKind = 'image';
  const guard = 'I:' + sz.width + 'x' + sz.height;
  if (quiet || (!edge && guard === clipSig)) { clipSig = guard; return; }
  clipSig = guard;

  let png;
  try { png = img.toPNG(); } catch (e) { return; }
  const top = clipItems[0];
  /* 同一张图重复复制（尺寸 + 字节数都一样）就不再入库 */
  if (top && top.type === 'image' && top.w === sz.width && top.h === sz.height && top.bytes === png.length) return;
  const big = png.length > CLIP_IMG_FULL_MAX;
  clipAdd({
    type: 'image', w: sz.width, h: sz.height, bytes: png.length, big,
    thumb: clipThumb(img) || ('data:image/png;base64,' + png.toString('base64')),
    data: big ? '' : 'data:image/png;base64,' + png.toString('base64')
  });
}
function clipStart() {
  if (clipTimer) return;
  clipLoad();
  clipTimer = setInterval(() => clipPoll(false), CLIP_TICK);
  if (clipTimer.unref) clipTimer.unref();
}
function clipStop() {
  if (clipTimer) clearInterval(clipTimer);
  clipTimer = null;
}

ipcMain.handle('lumen:clip-list', () => ({ ok: true, watch: clipWatch, items: clipItems.map(clipEntry) }));
ipcMain.handle('lumen:clip-copy', (_e, id) => {
  const it = clipItems.find(x => x.id === String(id || ''));
  if (!it) return { ok: false, error: '条目不存在' };
  /* 写回之后别把自己的写入又记一条 */
  clipQuiet = Date.now() + 1600;
  try {
    if (it.type === 'text') {
      clipboard.writeText(it.text);
      clipKind = 'text'; clipSig = 'T:' + it.text.length + ':' + it.text.slice(0, 200);
      return { ok: true, note: '' };
    }
    if (it.type === 'files') {
      const text = it.files.join('\r\n');
      clipboard.writeText(text);
      clipKind = 'text'; clipSig = 'T:' + text.length + ':' + text.slice(0, 200);
      return { ok: true, note: '文件复制受限，已按路径文本写入剪贴板' };
    }
    const src = it.data || it.thumb;
    clipboard.writeImage(nativeImage.createFromDataURL(src));
    clipKind = 'image'; clipSig = 'I:' + it.w + 'x' + it.h;
    return { ok: true, note: it.big && !it.data ? '原图过大，回填的是缩略图' : '' };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});
ipcMain.handle('lumen:clip-del', (_e, id) => {
  const k = clipItems.findIndex(x => x.id === String(id || ''));
  if (k >= 0) { clipItems.splice(k, 1); clipSave(); }
  return { ok: true, count: clipItems.length };
});
ipcMain.handle('lumen:clip-clear', () => {
  clipItems = []; clipSave();
  return { ok: true, count: 0 };
});
ipcMain.handle('lumen:clip-watch', (_e, on) => {
  clipWatch = !!on;
  /* 重新打开监听时先认一次指纹：暂停期间复制的东西不补记，但从现在起接着记 */
  if (clipWatch) clipPrimed = false;
  clipSave();
  return { ok: true, watch: clipWatch };
});
ipcMain.handle('lumen:clip-poll', () => { clipPoll(true); return { ok: true, items: clipItems.map(clipEntry) }; });

/* ---------- 系统信息 ---------- */
let sysGpuCache = null;

/* 显卡型号：Electron 的 app.getGPUInfo('complete') 最省事，但本机为了稳
   （无显卡 VM）把硬件加速关掉了，它汇报的常是 SwiftShader / llvmpipe 这种
   软件渲染器 —— 拿那个当「你的显卡」是误导。所以识别出来之后改问操作系统。 */
const SYS_GPU_TIMEOUT = 2500;
const SYS_GPU_SOFT = /swiftshader|llvmpipe|basic render|software renderer|angle \(google/i;

/* 走异步的 execFile：同步版会把主进程整个卡住（UI 跟着冻住），PowerShell 慢的时候很难看 */
function sysRun(cmd, args, ms) {
  return new Promise(resolve => {
    try {
      const { execFile } = require('child_process');
      execFile(cmd, args, { timeout: ms || 8000, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => resolve(err ? '' : String(stdout || '')));
    } catch (e) { resolve(''); }
  });
}
async function sysGpuByOS() {
  try {
    if (process.platform === 'win32') {
      /* wmic 在新版 Windows 已移除，走 PowerShell 的 CIM 接口 */
      const out = await sysRun('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name'], 9000);
      return out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    }
    if (process.platform === 'darwin') {
      const out = await sysRun('/usr/sbin/system_profiler', ['SPDisplaysDataType'], 9000);
      return out.split(/\r?\n/).filter(l => /Chipset Model/.test(l)).map(l => l.split(':').slice(-1)[0].trim());
    }
    const out = await sysRun('lspci', [], 9000);
    return out.split(/\r?\n/).filter(l => /VGA|3D|Display/i.test(l)).map(l => l.slice(l.indexOf(':') + 1).trim());
  } catch (e) { return []; }
}
async function sysGpu() {
  if (sysGpuCache) return sysGpuCache;
  let raw = [];
  try {
    const info = await Promise.race([
      app.getGPUInfo('complete'),
      new Promise((_res, rej) => setTimeout(() => rej(new Error('timeout')), SYS_GPU_TIMEOUT))
    ]);
    raw = ((info && info.gpuDevice) || []).map(d => (d && (d.deviceString || d.driverVendor)) || '').filter(Boolean);
  } catch (e) {}

  let list = raw.filter(s => !SYS_GPU_SOFT.test(s));
  let from = 'electron';
  if (!list.length) {
    const os = await sysGpuByOS();
    if (os.length) { list = os; from = 'os'; }
    else if (raw.length) { list = raw; from = 'electron'; }   /* 兜底：有总比空着强 */
    else from = '';
  }
  sysGpuCache = { list, from };
  return sysGpuCache;
}
/* Windows 的 os.release() 给的是内核版本（10.0.22631），拿它判 10 / 11 */
function sysOsName(release) {
  if (process.platform === 'win32') {
    const b = Number(String(release).split('.')[2] || 0);
    return b >= 22000 ? 'Windows 11' : 'Windows 10';
  }
  if (process.platform === 'darwin') return 'macOS';
  return 'Linux';
}
async function sysInfo() {
  const cpus = os.cpus() || [];
  const out = {
    ok: true,
    shell: 'desktop',
    result: {
      platform: process.platform,
      osName: sysOsName(os.release()),
      osRelease: os.release(),
      osVersion: (() => { try { return os.version ? String(os.version()) : ''; } catch (e) { return ''; } })(),
      arch: process.arch,
      host: (() => { try { return os.hostname(); } catch (e) { return ''; } })(),
      uptime: os.uptime(),
      locale: (() => { try { return app.getLocale(); } catch (e) { return ''; } })(),
      cpuModel: cpus[0] ? String(cpus[0].model).replace(/\s+/g, ' ').trim() : '',
      cpuCount: cpus.length,
      cpuSpeed: cpus[0] ? cpus[0].speed : 0,
      memTotal: os.totalmem(),
      memFree: os.freemem(),
      home: (() => { try { return os.homedir(); } catch (e) { return ''; } })(),
      tmp: (() => { try { return os.tmpdir(); } catch (e) { return ''; } })(),
      userData: (() => { try { return app.getPath('userData'); } catch (e) { return ''; } })(),
      logFile: LOG_FILE,
      appVersion: readVersion(),
      versions: {
        electron: process.versions.electron || '',
        chrome: process.versions.chrome || '',
        node: process.versions.node || '',
        v8: process.versions.v8 || ''
      },
      screens: [],
      gpu: [],
      gpuFrom: ''
    }
  };
  /* screen 模块只能在 ready 之后 require，所以在函数里取 */
  try {
    const { screen } = require('electron');
    const primary = screen.getPrimaryDisplay().id;
    for (const d of screen.getAllDisplays()) {
      out.result.screens.push({
        w: d.size.width, h: d.size.height, scale: d.scaleFactor,
        depth: d.colorDepth, hz: d.displayFrequency || 0, primary: d.id === primary
      });
    }
  } catch (e) {}
  try {
    const g = await sysGpu();
    out.result.gpu = g.list;
    out.result.gpuFrom = g.from;
  } catch (e) {}
  return out;
}
ipcMain.handle('lumen:sys-info', () => sysInfo());

/* ============================================================
   五-c、Python 运行时（创意工具的算力后端）
   ============================================================ */
/* 创意工具里有些活（画像素 / 算图形 / 合成音频）交给本机 Python 干最合适。
 * 通道设计：
 *   页面发 { source, args, timeout } → 壳把 source 落到临时目录 → 起本机 python 跑
 *   → 脚本把产物写进同一目录、往 stdout 打一行 JSON 摘要 → 壳收回文件转 data URL 给页面。
 * source 只认构建时内联进 app.js 的 src/py/*.py（py-bridge.js 解 __LUMEN_PY_URI__ 后原样转发），
 * 而且第一行必须是 PY_MARKER —— 主进程这里只当它是「本工具自带的脚本」，
 * 网页版直开没有进程可借：window.lumenPy 不存在，工具页自己降级。 */
const PY_MARKER = '# lumen-py-script';       // 自带脚本的身份证（源码第一行必须是它）
const PY_SRC_MAX = 512 * 1024;               // 单个脚本源码上限
const PY_FILE_MAX = 24 * 1024 * 1024;        // 单个产物读回上限
const PY_OUT_MAX = 96 * 1024 * 1024;         // stdout / stderr 上限
let pyProbeCache = null;

function pyConfigFile() {
  try { return path.join(app.getPath('userData'), 'lumen-py.json'); }
  catch (e) { return path.join(os.tmpdir(), 'lumen-py.json'); }
}
function pyReadConfig() {
  try { return JSON.parse(fs.readFileSync(pyConfigFile(), 'utf8')) || {}; } catch (e) { return {}; }
}
function pyWriteConfig(cfg) {
  try { fs.writeFileSync(pyConfigFile(), JSON.stringify(cfg, null, 2), 'utf8'); } catch (e) {}
}

/* 候选顺序：用户在设置里指定的 > PATH 上的启动器 > 常见安装位置。
 * Windows 上 `py` 是官方启动器，多数装了 Python 的机器都有它；
 * `python` 在只装了商店版 stub 的机器上会弹微软商店，所以排在 py / python3 后面。 */
function pyCandidates() {
  const cfg = pyReadConfig();
  const list = [];
  if (cfg && cfg.exe) list.push(String(cfg.exe));
  if (process.platform === 'win32') {
    list.push('py', 'python3', 'python');
    const bases = [process.env.LOCALAPPDATA, 'C:\\Python313', 'C:\\Python312', 'C:\\Python311']
      .filter(Boolean);
    for (const b of bases) {
      for (const v of ['313', '312', '311', '310']) list.push(path.join(String(b), 'Python' + v, 'python.exe'));
    }
  } else {
    list.push('python3', 'python', '/usr/local/bin/python3', '/opt/homebrew/bin/python3');
  }
  return [...new Set(list)];
}

/* 与 sysRun 的区别：这里要 stderr 和退出码、要往 stdin 喂参数、缓冲也大得多（收图） */
function pyExec(exe, args, opts) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    const out = [], err = [];
    let outLen = 0, errLen = 0, p = null;
    try { p = require('child_process').spawn(exe, args, { windowsHide: true }); }
    catch (e) { return finish({ code: -1, out: Buffer.alloc(0), err: Buffer.alloc(0), errText: String((e && e.message) || e) }); }
    const t = setTimeout(() => {
      try { p.kill(); } catch (e) {}
      finish({ code: -1, out: Buffer.concat(out), err: Buffer.concat(err), errText: '执行超时' });
    }, (opts && opts.timeout) || 30000);
    p.stdout.on('data', d => { out.push(d); if ((outLen += d.length) > PY_OUT_MAX) { try { p.kill(); } catch (e) {} } });
    p.stderr.on('data', d => { err.push(d); if ((errLen += d.length) > PY_OUT_MAX) { try { p.kill(); } catch (e) {} } });
    p.on('error', e => { clearTimeout(t); finish({ code: -1, out: Buffer.concat(out), err: Buffer.concat(err), errText: String((e && e.message) || e) }); });
    p.on('close', code => { clearTimeout(t); finish({ code, out: Buffer.concat(out), err: Buffer.concat(err), errText: '' }); });
    if (opts && opts.input != null) { try { p.stdin.write(opts.input); } catch (e) {} }
    try { p.stdin.end(); } catch (e) {}
  });
}

/* 探测本机 Python：谁先应答用谁，结果缓存（pip 装完东西要 force 重探） */
async function pyProbe(force) {
  if (pyProbeCache && !force) return pyProbeCache;
  const t0 = Date.now();
  for (const exe of pyCandidates()) {
    const r = await pyExec(exe,
      ['-c', 'import sys,json;print(json.dumps({"exe":sys.executable,"ver":sys.version.split()[0]}))'],
      { timeout: 8000 });
    if (r.code !== 0 || r.errText) continue;
    let info = null;
    try { info = JSON.parse(r.out.toString('utf8').trim().split(/\r?\n/).pop()); } catch (e) {}
    if (!info || !info.exe) continue;
    const pil = await pyExec(exe, ['-c', 'import PIL;print(PIL.__version__)'], { timeout: 8000 });
    pyProbeCache = {
      ok: true, exe: info.exe, version: info.ver || '',
      hasPillow: pil.code === 0, probedMs: Date.now() - t0
    };
    trace('python 探测：' + info.exe + ' ' + (info.ver || '') + '（Pillow ' + (pyProbeCache.hasPillow ? '有' : '无') + '）');
    return pyProbeCache;
  }
  pyProbeCache = { ok: false, err: '本机没找到可用的 Python', probedMs: Date.now() - t0 };
  trace('python 探测失败');
  return pyProbeCache;
}

/* 跑一个自带脚本：约定 stdout 最后一行是 JSON 摘要，产物文件写在 --out 指向的目录 */
async function pyRun(payload) {
  const t0 = Date.now();
  const st = await pyProbe(false);
  if (!st.ok) return { ok: false, err: st.err };
  const src = payload && payload.source;
  /* 身份证行允许出现在文件头几行里（脚本第一行是 shebang，第二行才是标记） */
  if (typeof src !== 'string' || src.indexOf(PY_MARKER) < 0 || src.indexOf(PY_MARKER) > 256) {
    return { ok: false, err: '只接受本工具自带的脚本' };
  }
  if (src.length > PY_SRC_MAX) return { ok: false, err: '脚本源码超过上限' };
  let dir = '';
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-py-'));
    fs.writeFileSync(path.join(dir, 'script.py'), src, 'utf8');
    const r = await pyExec(st.exe, [path.join(dir, 'script.py'), '--out', dir], {
      timeout: Math.min(Math.max(Number(payload && payload.timeout) || 30000, 3000), 120000),
      input: JSON.stringify((payload && payload.args) || {})
    });
    const log = r.err.toString('utf8').trim();
    if (r.errText) return { ok: false, err: r.errText, log };
    let res = null;
    const lines = r.out.toString('utf8').split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      try { res = JSON.parse(lines[i]); break; } catch (e) {}
    }
    if (!res) return { ok: false, err: '脚本没有返回结果', log };
    if (!res.ok) return { ok: false, err: res.error || '脚本执行失败', log };
    /* 收产物：文件名只允许安全字符、只在本临时目录里找（防路径穿越） */
    const files = [];
    for (const f of (res.files || [])) {
      const name = String((f && f.name) || '');
      if (!/^[\w.\-]+$/.test(name)) continue;
      let buf;
      try { buf = fs.readFileSync(path.join(dir, name)); } catch (e) { continue; }
      if (!buf.length || buf.length > PY_FILE_MAX) continue;
      const mime = /\.png$/i.test(name) ? 'image/png' : 'application/octet-stream';
      files.push({ name, size: buf.length, mime, dataUrl: 'data:' + mime + ';base64,' + buf.toString('base64') });
    }
    return { ok: true, result: res, files, ms: Date.now() - t0, exe: st.exe, log };
  } catch (e) {
    return { ok: false, err: String((e && e.message) || e) };
  } finally {
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} }
  }
}

/* 补依赖：白名单，页面只能点「装 Pillow」这类按钮，不能装任意包 */
const PY_PKGS = { pillow: 'pillow', numpy: 'numpy' };
ipcMain.handle('lumen:py-status', (_e, force) => pyProbe(!!force));
ipcMain.handle('lumen:py-run', (_e, payload) => pyRun(payload || {}));
ipcMain.handle('lumen:py-set-exe', (_e, exe) => {
  const v = String(exe || '').trim();
  const cfg = pyReadConfig();
  if (v) cfg.exe = v; else delete cfg.exe;
  pyWriteConfig(cfg);
  pyProbeCache = null;
  return pyProbe(false);
});
ipcMain.handle('lumen:py-install', async (_e, name) => {
  const pkg = PY_PKGS[String(name || '').toLowerCase()];
  if (!pkg) return { ok: false, err: '只允许安装 ' + Object.keys(PY_PKGS).join(' / ') };
  const st = await pyProbe(false);
  if (!st.ok) return { ok: false, err: st.err };
  trace('python pip install ' + pkg);
  const r = await pyExec(st.exe, ['-m', 'pip', 'install', '--user', '--disable-pip-version-check', pkg],
    { timeout: 300000 });
  pyProbeCache = null;
  return {
    ok: r.code === 0 && !r.errText,
    err: r.code === 0 ? '' : '安装失败',
    log: (r.out.toString('utf8') + '\n' + r.err.toString('utf8')).trim().slice(-8000)
  };
});

/* 本地工具用不上 GPU 加速：禁掉，免得在无显卡 / 驱动异常的环境里白耗。
 *
 * ⚠️ 千万别开 --in-process-gpu（v0.16.10 的闪退就是它）：那个开关把 Chromium 的 GPU
 *    逻辑并进主进程、和 Node 共用同一个事件循环，于是 GPU 层任何 fail-fast 都会
 *    直接掀翻整个应用 —— 外部表现就是「点开本机信息就闪退 / 后台正跑的活全断」。
 *    实测现场：ucrtbase.dll 报 0xC0000409（__fastfail），发生在主进程派生子进程
 *    （本机信息问 PowerShell 要显卡型号）之后的下一次事件循环里。
 *    留着独立 GPU 进程时，同样的崩溃只会落在子进程上，Chromium 自己降级重启，
 *    主进程和用户数据毫发无伤 —— 拿「一点 GPU 开销」换「应用不被拖死」，值。
 *
 * no-sandbox：本机（无显卡 VM）渲染进程沙箱起不来；应用只加载本地文件、外链全部交系统浏览器，风险可控。 */
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');

/* ============================================================
   六、桌面灵动岛
   —— 独立透明窗贴屏幕顶边：收起只画胶囊（整窗鼠标穿透），光标靠近展开面板。
   两条来自 _island_spike 实测的铁律：
     · **窗口尺寸固定**，收起/展开全靠页面 CSS 切类。用 setBounds 缩放透明窗，
       命中区域会跟不上（请求 260×44 实得 264×47），展开后鼠标事件全丢。
     · 展开态的保持条件是「光标在面板矩形内」，不能写成「光标不在热区就收起」——
       否则光标一进面板就被自己收掉，表现像点击失灵。
     · **拖动靠平移窗口**（尺寸不变，只改 x）。早期版本把窗口做宽、让岛在画布内
       translateX，范围只能是 ±100px，用户手感就是「拖一点就撞墙」；而且岛被 clamp
       住后光标继续走会掉出面板，450ms 后自动收起把拖动打断。改成移动窗口后，
       拖动范围 = 整个工作区宽度，且光标与窗口的相对位置始终不变。
   宽度常量必须与 island.css 的 .cap / .panel 一致。
   ============================================================ */
const ISLAND = {
  W: 420, H: 300,                 /* 窗口只包住面板 + 边距：位置靠平移窗口，见 islandApplyPos。
                                     三种停靠共用同一窗口尺寸（竖排胶囊 44 × ~230 也装得下）。 */
  CAP_W: 168, CAP_H: 44,          /* 胶囊默认宽，页面量出实际内容尺寸后回填。
                                     顶部停靠 = 胶囊宽度；左右停靠 = 胶囊长度（CAP_H 变厚度）。 */
  PANEL_W: 352, PANEL_H: 240,
  EDGE: 6,                        /* 岛体离屏幕边缘的最小留白 */
  MAGNET: 24,                     /* 拖中吸附半径 px：进圈吸住居中 / 原位（岛仔 DRAG_MAGNET） */
  MAGNET_OUT: 44,                 /* 吸住后要拖出这么远才解锁（滞回，岛仔 CENTER_RELEASE） */
  DOCK_SWITCH: 64,                /* 拖动中距新停靠边这么近才换边（岛仔同款，角落留缓冲） */
  DOCK_SWITCH_BUF: 24             /* 且必须明显比当前边更近，防止在角落横竖来回跳 */
};
/* 拖拽物理（照岛仔 v0.6.65 抄的参数）：窗口不直接贴光标，用弹簧跟随 ——
   拖动时明显拖尾并轻微冲过光标，松手换更硬的弹簧落位、回弹一两下。 */
const ISLAND_DRAG = {
  FOLLOW: { k: 320, z: 0.72 },    /* 跟手弹簧（刚度, 阻尼比）：欠阻尼，有一点点过冲 */
  SETTLE: { k: 380, z: 0.38 },    /* 松手落位：更明显的回弹 */
  HOLD_MS: 120                    /* 原地按住多久算「拿起」（视觉反馈在页面侧） */
};
/* 会触发「智能隐藏」的浏览器名单独放在 island-fg.js（可离线单测） */

let island = null;
let islandExpanded = false;
let islandLeaveAt = 0;
let islandTimer = null;
let islandCapW = ISLAND.CAP_W;     /* 页面实测的内容尺寸（热区按它算）：
                                      顶部停靠 = 胶囊宽；左右停靠 = 胶囊长 */
let islandOffset = 0;              /* 顶部停靠：窗口 x 相对「屏幕居中」的偏移，持久化 */
let islandOffsetSide = 0;          /* 左右停靠：窗口 y 相对「竖直居中」的偏移，持久化 */
let islandDock = 'top';            /* 'top' | 'left' | 'right'，持久化 */
let islandDragging = false;        /* 拖动锁：期间不收起、不细线、不切穿透 */
let islandDragStartOff = 0;        /* 本次拖动起手时的 offset（吸附「原位」用） */
let islandDragStartPt = { x: 0, y: 0 }; /* 起手时的光标屏幕坐标（换边距离判定用） */
let islandDragBaseD = 0;           /* 起手 / 换边基准：光标位移从哪个值起算 */
let islandDragRaw = 0;             /* 本拍未吸附的原始目标 offset */
let islandCenterLocked = false;    /* 拖动中是否吸在居中（带滞回，见 ISLAND.MAGNET_OUT） */
let islandGlide = null;            /* 弹簧 { pos, vel, target, k, z }：窗口位置的真值 */
let islandGlideTimer = null;       /* 16ms 步进，只在拖动 / 落位期间跑 */
let islandMin = false;             /* 智能隐藏：被前台窗口遮住时收成细线 */
let islandCovered = false;         /* 前台窗口是否正压在岛的位置上 */
let islandHidden = false;          /* 全屏应用时整窗隐藏 */
let islandLastHit = 0;             /* 光标最后一次落在岛上的时刻 */

function islandCfgFile() { return path.join(app.getPath('userData'), 'island.json'); }
function islandLoadCfg() {
  try {
    const j = JSON.parse(fs.readFileSync(islandCfgFile(), 'utf8'));
    return (j && typeof j === 'object') ? j : {};
  } catch (e) { return {}; }
}
function islandSaveCfg(o) {
  try { fs.writeFileSync(islandCfgFile(), JSON.stringify(o)); } catch (e) { trace('岛配置写入失败 ' + ((e && e.message) || e)); }
}
function islandAvailable() { return !!httpPort && !FORCE_FILE; }

/* ---------- 位置几何 ----------
   位置存成「相对屏幕工作区居中的偏移」，而不是绝对坐标：换分辨率、副屏拔插后
   岛仍然落在中间附近，不至于跑到屏幕外。
   顶部停靠沿 x 平移；左右停靠窗口贴屏幕左 / 右边、沿 y 平移。
   x/y/clamp 都按主屏工作区算——岛只贴主屏（多屏支持留给后续版本）。 */
function islandWorkArea() { return screen.getPrimaryDisplay().workArea; }
function islandBaseX() {
  const wa = islandWorkArea();
  return Math.round(wa.x + (wa.width - ISLAND.W) / 2);
}
function islandClampX(x) {
  const wa = islandWorkArea();
  const lo = wa.x + ISLAND.EDGE;
  const hi = wa.x + wa.width - ISLAND.W - ISLAND.EDGE;
  if (hi <= lo) return Math.round(wa.x);
  return Math.max(lo, Math.min(hi, Math.round(x)));
}
function islandMaxOffset() {
  const wa = islandWorkArea();
  if (islandDock === 'top') return Math.max(0, Math.round((wa.width - ISLAND.W) / 2) - ISLAND.EDGE);
  return Math.max(0, Math.round((wa.height - ISLAND.H) / 2) - ISLAND.EDGE);
}
function islandClampOffset(off) {
  const m = islandMaxOffset();
  return Math.max(-m, Math.min(m, Math.round(Number(off) || 0)));
}
/* offset=0 时窗口的位置（各停靠的「居中」基准点） */
function islandBasePos() {
  const wa = islandWorkArea();
  if (islandDock === 'left') return { x: wa.x, y: wa.y + Math.round((wa.height - ISLAND.H) / 2) };
  if (islandDock === 'right') return { x: wa.x + wa.width - ISLAND.W, y: wa.y + Math.round((wa.height - ISLAND.H) / 2) };
  return { x: islandBaseX(), y: wa.y };
}
function islandCurOffset() { return islandDock === 'top' ? islandOffset : islandOffsetSide; }
function islandPosFromOffset(off) {
  const base = islandBasePos();
  if (islandDock === 'top') return { x: islandClampX(base.x + (Number(off) || 0)), y: base.y };
  const wa = islandWorkArea();
  const lo = wa.y + ISLAND.EDGE, hi = wa.y + wa.height - ISLAND.H - ISLAND.EDGE;
  return { x: base.x, y: Math.max(lo, Math.min(hi, Math.round(base.y + (Number(off) || 0)))) };
}
function islandOffsetFromPos(p) {
  const base = islandBasePos();
  return Math.round(islandDock === 'top' ? p.x - base.x : p.y - base.y);
}

/* ---------- 弹簧窗口位置 ----------
   窗口位置的真值是 islandGlide（pos/vel），setBounds 只是每拍把真值落下去。
   拖动中 target 跟着光标（欠阻尼拖尾），松手换 settle 参数落位回弹。
   注意 setBounds 是异步落到 OS 的，紧接着 getBounds() 可能还是旧值 ——
   所以 offset 一律按「算出来的目标」写，不回读。 */
function islandSpringStep() {
  const g = islandGlide;
  if (!g) return;
  const dt = 1 / 60;
  const velBefore = g.vel;
  g.vel += (g.k * (g.target - g.pos) - 2 * g.z * Math.sqrt(g.k) * g.vel) * dt;
  g.pos += g.vel * dt;
  const p = islandPosFromOffset(g.pos);
  /* 窗口 clamp 后 g.pos 也同步收进去，免得贴边时 vel 一直推不动形成假振荡 */
  const clamped = islandDock === 'top' ? p.x : p.y;
  if (Math.abs(clamped - (islandDock === 'top' ? islandBasePos().x + g.pos : islandBasePos().y + g.pos)) > 1) {
    g.pos = islandOffsetFromPos(p);
    if (Math.sign(g.vel) === Math.sign(velBefore) || velBefore === 0) g.vel = 0;
  }
  if (island && !island.isDestroyed()) {
    let b;
    try { b = island.getBounds(); } catch (e) { b = null; }
    const moved = islandDock === 'top' ? (b && p.x !== b.x) : (b && p.y !== b.y);
    if (moved) {
      /* 尺寸一律传常量，绝不传实测宽：Windows + 125% 缩放下透明窗会补 4px 边框
         （请求 420 实得 424），把实测宽度再传回去会一轮轮复利，越拖越宽。 */
      try { island.setBounds(islandDock === 'top'
        ? { x: p.x, y: p.y, width: ISLAND.W, height: ISLAND.H }
        : { x: p.x, y: p.y, width: ISLAND.W, height: ISLAND.H }); } catch (e) {}
    }
  }
  /* 落位判定：拖动结束后弹簧逼近 target，稳定了就写盘收摊 */
  if (!islandDragging && Math.abs(g.vel) < 8 && Math.abs(g.target - g.pos) < 0.8) {
    islandGlide = null;
    if (islandGlideTimer) { clearInterval(islandGlideTimer); islandGlideTimer = null; }
    const off = islandClampOffset(g.target);
    if (islandDock === 'top') islandOffset = off; else islandOffsetSide = off;
    const cfg = islandLoadCfg();
    if (cfg.dock !== islandDock || cfg.offset !== islandOffset || cfg.offsetSide !== islandOffsetSide) {
      cfg.dock = islandDock; cfg.offset = islandOffset; cfg.offsetSide = islandOffsetSide;
      islandSaveCfg(cfg);
    }
    islandApplyVisibility();
  }
}
function islandGlideStart(fromOff) {
  islandGlide = { pos: fromOff, vel: 0, target: fromOff, k: ISLAND_DRAG.FOLLOW.k, z: ISLAND_DRAG.FOLLOW.z };
  if (!islandGlideTimer) islandGlideTimer = setInterval(islandSpringStep, 16);
}
/* 非拖动路径（开关 / 设置改停靠 / 启动）：直接落位，不走弹簧 */
function islandApplyPos(off, save) {
  if (!island || island.isDestroyed()) return;
  off = islandClampOffset(off);
  if (islandDock === 'top') islandOffset = off; else islandOffsetSide = off;
  const p = islandPosFromOffset(off);
  let b;
  try { b = island.getBounds(); } catch (e) { b = null; }
  if (!b || p.x !== b.x || p.y !== b.y) {
    try { island.setBounds({ x: p.x, y: p.y, width: ISLAND.W, height: ISLAND.H }); } catch (e) {}
  }
  if (save) {
    const cfg = islandLoadCfg();
    cfg.dock = islandDock; cfg.offset = islandOffset; cfg.offsetSide = islandOffsetSide;
    islandSaveCfg(cfg);
  }
}

function islandSend(ch, payload) {
  if (!island || island.isDestroyed()) return;
  try { island.webContents.send(ch, payload); } catch (e) {}
}

/* ---------- 工作状态联动 ----------
   主窗口在换视图（render）/ AI 忙碌态变化时上报，壳只做中转与看门：
   kind: idle(没在干活) | page(在某个页面) | tool(打开了工具) | task(任务进行中)
   task 有超时 —— 万一页面崩了没人收尾，岛不能永远卡在「回复中」。 */
const ISLAND_TASK_TTL = 6 * 60 * 1000;
let islandActivity = null;           /* { kind, name, extra?, at } | null */

function islandActivityValid(a) {
  return !!a && typeof a === 'object'
    && ['idle', 'page', 'tool', 'task'].includes(a.kind)
    && typeof a.name === 'string' && a.name.length > 0 && a.name.length <= 40
    && (a.extra === undefined || (typeof a.extra === 'string' && a.extra.length <= 40));
}
function islandSetActivity(a) {
  if (!islandActivityValid(a) || a.kind === 'idle') {
    if (islandActivity) { islandActivity = null; islandSend('lumen:island-activity', null); }
    return;
  }
  /* 幂等：render() 在搜索这类高频操作下会反复进来，状态没变就不打扰岛 */
  const next = { kind: a.kind, name: a.name, extra: a.extra || '' };
  if (islandActivity && islandActivity.kind === next.kind && islandActivity.name === next.name
    && islandActivity.extra === next.extra) {
    islandActivity.at = Date.now();          /* 只续期，不重播 */
    return;
  }
  islandActivity = Object.assign(next, { at: Date.now() });
  islandSend('lumen:island-activity', islandActivity);
}
function islandActivityExpire() {
  if (!islandActivity) return;
  if (islandActivity.kind === 'task' && Date.now() - islandActivity.at > ISLAND_TASK_TTL) {
    islandActivity = null;
    islandSend('lumen:island-activity', null);
    trace('岛工作状态超时自动清空');
  }
}

function islandSetState(exp) {
  islandExpanded = !!exp;
  islandLeaveAt = 0;
  if (island && !island.isDestroyed()) {
    /* 收起态穿透：不挡桌面点击；展开态必须能点按钮 */
    try { island.setIgnoreMouseEvents(!islandExpanded, { forward: true }); } catch (e) {}
  }
  islandSend('lumen:island-state', islandExpanded ? 'expanded' : 'collapsed');
  /* 展开时先不细线化；收起后按遮挡状态决定要不要收成细线 */
  if (islandExpanded && islandMin) islandSetMin(false);
  if (!islandExpanded) setTimeout(islandApplyVisibility, 60);
}

function islandSetMin(on) {
  on = !!on;
  if (islandMin === on) return;
  islandMin = on;
  islandSend('lumen:island-min', on);
  if (!on) islandLastHit = Date.now();
}

/* 根据「全屏 / 被遮挡」决定岛的可见形态，任何一处状态变化都调它收口 */
function islandApplyVisibility() {
  if (!island || island.isDestroyed()) return;
  if (islandHidden) {
    if (island.isVisible()) { try { island.hide(); } catch (e) {} }
    return;
  }
  if (!island.isVisible()) {
    try { island.showInactive(); } catch (e) {}
    islandSend('lumen:island-enter');      /* 从全屏隐藏里回来：让页面重播登场动画 */
  }
  /* 被遮住且已经收起 → 细线；展开中（用户正在操作）或拖动中不打断 */
  islandSetMin(islandCovered && !islandExpanded && !islandDragging);
}

/* 前台窗口变化（PowerShell 每 ~1s 推一次，已经按进程/矩形去重） */
function islandOnFg(fg) {
  if (!island || island.isDestroyed() || !fg) return;
  const cfg = islandLoadCfg();
  const d = screen.getPrimaryDisplay();
  const v = islandFg.decide({
    cfg: cfg,
    fg: fg,
    display: d,
    islandRect: island.getBounds(),
    capW: islandCapW,
    dock: islandDock,
    selfPid: process.pid
  });
  if (v.hidden === islandHidden && v.min === islandCovered) { islandApplyVisibility(); return; }
  islandHidden = v.hidden;
  islandCovered = v.min;
  islandApplyVisibility();
}

/* 光标热区。110ms 一次：比 16ms 省电，体感上仍然瞬开 */
function islandTick() {
  if (!island || island.isDestroyed()) return;
  islandActivityExpire();
  if (islandHidden) return;                       /* 全屏时整窗隐藏，不必再算热区 */
  /* 拖动期间一律不动：否则「光标暂时离开面板」会触发收起 + 转穿透，
     pointer capture 一断，拖动就被掐在半路（早期版本的毛病） */
  if (islandDragging) { islandLastHit = Date.now(); return; }
  let p, b;
  try { p = screen.getCursorScreenPoint(); b = island.getBounds(); } catch (e) { return; }
  /* 各停靠的胶囊 / 面板矩形。窗口跟着岛走：
     顶部：胶囊贴顶水平居中；左右：胶囊贴边竖直居中，面板从边缘向屏幕内展开。 */
  const capLen = Math.max(60, Math.min(islandCapW, ISLAND.H - 24));
  let capRect, panRect;
  if (islandDock === 'left' || islandDock === 'right') {
    const cy = b.y + ISLAND.H / 2;
    const capX = islandDock === 'left' ? b.x : b.x + ISLAND.W - ISLAND.CAP_H;
    capRect = { x: capX, y: cy - capLen / 2, w: ISLAND.CAP_H, h: capLen };
    const panX = islandDock === 'left' ? b.x + ISLAND.CAP_H + 10 : b.x + ISLAND.W - ISLAND.CAP_H - 10 - ISLAND.PANEL_W;
    panRect = { x: panX, y: cy - ISLAND.PANEL_H / 2, w: ISLAND.PANEL_W, h: ISLAND.PANEL_H };
  } else {
    const cx = b.x + b.width / 2;
    capRect = { x: cx - islandCapW / 2, y: b.y, w: islandCapW, h: ISLAND.CAP_H };
    panRect = { x: cx - ISLAND.PANEL_W / 2, y: b.y, w: ISLAND.PANEL_W, h: ISLAND.PANEL_H };
  }

  /* 细线态：只留贴边一小段感应区，碰到就还原成小胶囊并展开 */
  if (islandMin) {
    const near = islandDock === 'top' ? (p.y <= b.y + 12 && Math.abs(p.x - (capRect.x + capRect.w / 2)) <= 44)
      : islandDock === 'left' ? (p.x <= b.x + 12 && Math.abs(p.y - (capRect.y + capRect.h / 2)) <= 44)
      : (p.x >= b.x + ISLAND.W - 12 && Math.abs(p.y - (capRect.y + capRect.h / 2)) <= 44);
    if (near) {
      islandSetMin(false);
      islandSetState(true);
      islandLastHit = Date.now();
    }
    return;
  }

  const inCap = p.x >= capRect.x - 4 && p.x <= capRect.x + capRect.w + 4 &&
                p.y >= capRect.y - 2 && p.y <= capRect.y + capRect.h + 8;
  const inPan = p.x >= panRect.x - 6 && p.x <= panRect.x + panRect.w + 6 &&
                p.y >= panRect.y - 2 && p.y <= panRect.y + panRect.h + 10;
  if (inCap || inPan) islandLastHit = Date.now();

  if (!islandExpanded) {
    if (inCap) { islandSetState(true); return; }
    /* 被遮住时，光标离开 1.4s 后收成细线 */
    if (islandCovered && Date.now() - islandLastHit > 1400) islandSetMin(true);
    return;
  }
  if (inPan) { islandLeaveAt = 0; return; }
  /* 离开面板：留 450ms 缓冲，避免从胶囊走到面板的途中闪收 */
  if (!islandLeaveAt) islandLeaveAt = Date.now() + 450;
  else if (Date.now() >= islandLeaveAt) islandSetState(false);
}

function islandCreate() {
  if (island && !island.isDestroyed()) return island;
  if (!islandAvailable()) return null;

  const wa = screen.getPrimaryDisplay().workArea;
  const cfg0 = islandLoadCfg();
  islandDock = (cfg0.dock === 'left' || cfg0.dock === 'right') ? cfg0.dock : 'top';
  islandOffset = islandClampOffset(Number(cfg0.offset) || 0);
  islandOffsetSide = islandClampOffset(Number(cfg0.offsetSide) || 0);
  const startPos = islandPosFromOffset(islandCurOffset());
  islandDragStartOff = islandCurOffset();
  islandDragging = false;
  islandCenterLocked = false;
  islandMin = false;
  islandHidden = false;
  islandCovered = false;
  island = new BrowserWindow({
    x: startPos.x,
    y: startPos.y,
    width: ISLAND.W,
    height: ISLAND.H,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    /* 必须可激活：Windows 上 focusable:false（WS_EX_NOACTIVATE）的窗口，
       Chromium 收不到鼠标「按下」（抬起能收到），拖拽和按钮永远点不动 —— 实机踩中。
       出现时仍用 showInactive()，单纯悬停不会抢焦点；只有用户真点它才会激活。 */
    focusable: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      spellcheck: false,
      backgroundThrottling: false
    }
  });
  try { island.setAlwaysOnTop(true, 'floating'); } catch (e) {}
  try { island.setIgnoreMouseEvents(true, { forward: true }); } catch (e) {}
  island.loadURL(baseUrl() + '__lumen/island');
  island.once('ready-to-show', () => {
    if (!island || island.isDestroyed()) return;
    island.showInactive();
    island.setIgnoreMouseEvents(true, { forward: true });
    islandSend('lumen:island-enter');      /* 窗真的显示之后再放登场动画，否则在不可见时白播 */
    trace('岛已显示 · ' + JSON.stringify(island.getBounds()));
  });
  island.webContents.on('did-fail-load', (_e, c, d) => trace('岛加载失败 ' + c + ' ' + d));
  island.webContents.on('render-process-gone', () => { trace('岛渲染进程退出，销毁重建'); try { island.destroy(); } catch (e) {} });
  island.webContents.on('did-finish-load', () => {
    islandSend('lumen:island-state', 'collapsed');
    islandSend('lumen:island-media', media.last());
    islandSend('lumen:island-min', islandMin);
    islandSend('lumen:island-activity', islandActivity);   /* 岛重建后把工作状态补上 */
    islandSend('lumen:island-cfg', islandCfgPayload());    /* 停靠边 / 时钟秒数也补上 */
    islandSend('lumen:island-notify', notify.last());      /* 通知列表补上 */
  });
  island.on('closed', () => {
    island = null; islandExpanded = false; islandLeaveAt = 0;
    islandMin = false; islandHidden = false; islandCovered = false;
    if (islandGlideTimer) { clearInterval(islandGlideTimer); islandGlideTimer = null; }
    islandGlide = null; islandDragging = false; islandCenterLocked = false;
  });

  /* 第二参是前台窗口快照：智能隐藏（全屏 / 浏览器遮住岛）靠它 */
  media.start(s => islandSend('lumen:island-media', s), fg => islandOnFg(fg));

  /* 系统通知桥（QQ / 微信 / 邮件…）：读 Windows 通知库，默认开，可在设置里关 */
  if (cfg0.notify !== false) notify.start(list => islandSend('lumen:island-notify', list));

  if (islandTimer) clearInterval(islandTimer);
  islandTimer = setInterval(islandTick, 110);
  return island;
}

function islandDestroy() {
  if (islandTimer) { clearInterval(islandTimer); islandTimer = null; }
  if (islandGlideTimer) { clearInterval(islandGlideTimer); islandGlideTimer = null; }
  islandGlide = null;
  media.stop();
  notify.stop();
  if (island && !island.isDestroyed()) { try { island.destroy(); } catch (e) {} }
  island = null;
  islandExpanded = false;
  islandLeaveAt = 0;
}

function islandSetEnabled(on) {
  on = !!on;
  const cfg = islandLoadCfg();
  cfg.enabled = on;
  islandSaveCfg(cfg);
  if (!on) { islandDestroy(); return { ok: true, enabled: false, available: islandAvailable() }; }
  if (!islandAvailable()) return { ok: false, enabled: false, available: false, error: 'no-port' };
  islandCreate();
  return { ok: true, enabled: true, available: true };
}

ipcMain.handle('lumen:island-get', () => {
  const cfg = islandLoadCfg();
  let b = null;
  try { b = island && !island.isDestroyed() ? island.getBounds() : null; } catch (e) { b = null; }
  return {
    ok: true,
    enabled: !!cfg.enabled,
    available: islandAvailable(),
    running: !!island,
    media: media.last(),
    dock: islandDock,
    clockSeconds: !!cfg.clockSeconds,
    offset: islandCurOffset(),
    x: b ? b.x : islandPosFromOffset(islandCurOffset()).x,
    y: b ? b.y : islandPosFromOffset(islandCurOffset()).y,
    w: b ? b.width : ISLAND.W,
    maxOffset: islandMaxOffset(),
    mini: islandMin,
    smart: cfg.smart !== false,
    activity: islandActivity
  };
});
ipcMain.handle('lumen:island-set', (_e, on) => islandSetEnabled(on));
/* 工作状态上报：主窗口换视图 / AI 忙碌态变化时发，壳中转给岛 */
ipcMain.on('lumen:island-activity', (_e, act) => islandSetActivity(act));
/* 胶囊宽度随内容变：页面量完报上来，热区立刻跟着变 */
ipcMain.on('lumen:island-cap', (_e, w) => {
  const n = Math.round(Number(w) || 0);
  if (n >= 60 && n <= 420) islandCapW = n;
});
/* ---------- 拖动（照岛仔的弹簧物理重做） ----------
   页面只负责「按下 / 松手 + 光标位移」，位置全由壳算：
     drag(on)  → 记录起手 offset 与光标屏幕位置，启动跟随弹簧（欠阻尼拖尾）
     move      → 原始目标 = 起手 offset + 光标位移；拖中实时吸附居中 / 原位（滞回）；
                 光标贴近左 / 右边时直接换停靠边（画布横竖互换 snap 到位）
     drag(off) → 弹簧换 settle 参数落位回弹，稳定后写盘
   位移用页面报的 dx/dy（光标相对按下点的位移），壳只在 dragStart 读一次光标，
   之后用位移推算位置 —— 不逐拍读系统光标，合成输入（E2E）也能走全链路。 */
function islandCfgPayload() {
  const cfg = islandLoadCfg();
  return { dock: islandDock, clockSeconds: !!cfg.clockSeconds, smart: cfg.smart !== false, notify: cfg.notify !== false };
}
/* 吸附：居中（带滞回）优先，其次原位。返回落位目标 offset。 */
function islandDragTarget(raw) {
  const enter = islandCenterLocked ? ISLAND.MAGNET_OUT : ISLAND.MAGNET;
  let target = raw;
  if (Math.abs(raw) <= enter) {
    if (!islandCenterLocked) { islandCenterLocked = true; islandSend('lumen:island-lock', { locked: true }); }
    target = 0;
  } else if (islandCenterLocked && Math.abs(raw) > ISLAND.MAGNET_OUT) {
    islandCenterLocked = false;
    islandSend('lumen:island-lock', { locked: false });
  } else if (!islandCenterLocked && Math.abs(raw - islandDragStartOff) <= ISLAND.MAGNET) {
    target = islandDragStartOff;              /* 拖回原位附近也轻轻吸住 */
  }
  return target;
}
/* 拖动中贴近新边缘就换停靠边：距新边 ≤64px 且明显比当前边更近才换，角落留缓冲。
   dx/dy 是光标相对按下点的位移，光标绝对位置 = 起手点 + 位移。 */
function islandDragMaybeSwitchDock(dx, dy) {
  const wa = islandWorkArea();
  const cxp = islandDragStartPt.x + (Number(dx) || 0);
  const cyp = islandDragStartPt.y + (Number(dy) || 0);
  const cands = [
    ['top', Math.max(0, cyp - wa.y)],
    ['left', Math.max(0, cxp - wa.x)],
    ['right', Math.max(0, wa.x + wa.width - cxp)]
  ];
  const cur = islandDock === 'top' ? cands[0][1] : islandDock === 'left' ? cands[1][1] : cands[2][1];
  let nearest = cands[0];
  for (const c of cands) if (c[1] < nearest[1]) nearest = c;
  let target = null;
  if (nearest[0] !== islandDock && nearest[1] <= ISLAND.DOCK_SWITCH &&
      nearest[1] + ISLAND.DOCK_SWITCH_BUF < cur) target = nearest[0];
  /* 左右对侧：过了中线、明显更靠近另一侧就换，不必甩到屏幕尽头 */
  if (!target && islandDock !== 'top') {
    const opp = islandDock === 'left' ? 'right' : 'left';
    const far = opp === 'left' ? cands[1][1] : cands[2][1];
    if (far + wa.width * 0.07 < cur) target = opp;
  }
  if (!target || target === islandDock) return;
  islandDock = target;
  /* 换边时画布横竖互换：offset 直接按光标在新区轴上的位置取值，snap 到位，不从旧边滑过去 */
  const along = islandDock === 'top' ? cxp - wa.x : cyp - wa.y;
  islandDragStartOff = islandClampOffset(along - (islandDock === 'top' ? wa.width / 2 : wa.height / 2));
  islandDragBaseD = islandDock === 'top' ? (Number(dx) || 0) : (Number(dy) || 0);
  islandDragRaw = islandDragStartOff;
  islandCenterLocked = false;
  islandSend('lumen:island-lock', { locked: false });
  const t = islandDragTarget(islandDragRaw);
  if (islandGlide) { islandGlide.pos = t; islandGlide.vel = 0; islandGlide.target = t; }
  islandApplyPos(t, false);
  islandSend('lumen:island-cfg', islandCfgPayload());
  trace('岛拖动换停靠边 → ' + target);
}
ipcMain.on('lumen:island-drag', (_e, on) => {
  if (!island || island.isDestroyed()) return;
  if (on) {
    if (islandDragging) return;
    islandDragging = true;
    islandDragStartOff = islandCurOffset();
    islandDragBaseD = 0;
    try { islandDragStartPt = screen.getCursorScreenPoint(); } catch (e) { islandDragStartPt = { x: 0, y: 0 }; }
    islandDragRaw = islandDragStartOff;
    /* 本来就停在居中：直接亮绿边，不重播扫光（岛仔同款细节） */
    islandCenterLocked = islandDragStartOff === 0;
    islandSend('lumen:island-lock', { locked: islandCenterLocked, silent: islandCenterLocked });
    islandGlideStart(islandDragStartOff);
    islandLeaveAt = 0;
    islandSetMin(false);
    try { island.setIgnoreMouseEvents(false); } catch (e) {}
    islandLastHit = Date.now();
    return;
  }
  if (!islandDragging) return;
  islandDragging = false;
  /* 松手：换更硬的弹簧落位（回弹一两下），稳定后由步进函数写盘 */
  if (islandGlide) {
    islandGlide.k = ISLAND_DRAG.SETTLE.k;
    islandGlide.z = ISLAND_DRAG.SETTLE.z;
    islandGlide.target = islandDragTarget(islandDragRaw);
  }
  islandLastHit = Date.now();
});
ipcMain.on('lumen:island-move', (_e, dx, dy) => {
  if (!islandDragging || !island || island.isDestroyed()) return;
  dx = Number(dx) || 0; dy = Number(dy) || 0;
  islandDragMaybeSwitchDock(dx, dy);
  /* 换边可能重置了基准，以最新的基准起算 */
  const raw = islandClampOffset(islandDragStartOff + (islandDock === 'top' ? dx - islandDragBaseD : dy - islandDragBaseD));
  islandDragRaw = raw;
  const t = islandDragTarget(raw);
  if (islandGlide) islandGlide.target = t;
});
/* 停靠边设置：设置页切换，立即落位并广播给页面 */
ipcMain.handle('lumen:island-dock', (_e, d) => {
  if (!['top', 'left', 'right'].includes(d)) return { ok: false };
  islandDock = d;
  islandCenterLocked = false;
  if (island && !island.isDestroyed()) {
    if (islandGlide) { islandGlideTimer && clearInterval(islandGlideTimer); islandGlideTimer = null; islandGlide = null; }
    islandApplyPos(islandCurOffset(), true);
  }
  const cfg = islandLoadCfg();
  cfg.dock = d; cfg.offset = islandOffset; cfg.offsetSide = islandOffsetSide;
  islandSaveCfg(cfg);
  islandSend('lumen:island-cfg', islandCfgPayload());
  return { ok: true, dock: islandDock };
});
/* 岛选项（时钟秒数 / 系统通知）：写壳侧配置并即时广播 */
ipcMain.handle('lumen:island-opt', (_e, patch) => {
  const cfg = islandLoadCfg();
  if (patch && typeof patch === 'object') {
    if (typeof patch.clockSeconds === 'boolean') cfg.clockSeconds = patch.clockSeconds;
    if (typeof patch.notify === 'boolean') cfg.notify = patch.notify;
  }
  islandSaveCfg(cfg);
  /* 通知开关即时生效：关 → 停桥并清掉面板；开 → 立刻接上（岛没开就不用起，下次建岛自会启动） */
  if (patch && typeof patch.notify === 'boolean') {
    if (!patch.notify) {
      notify.stop();
      islandSend('lumen:island-notify', []);
    } else if (island && !island.isDestroyed()) {
      notify.start(list => islandSend('lumen:island-notify', list));
      islandSend('lumen:island-notify', notify.last());
    }
  }
  islandSend('lumen:island-cfg', islandCfgPayload());
  return { ok: true, clockSeconds: !!cfg.clockSeconds, notify: cfg.notify !== false };
});
/* 智能隐藏开关：写壳侧配置并立即生效 */
ipcMain.handle('lumen:island-smart', (_e, on) => {
  const cfg = islandLoadCfg();
  cfg.smart = !!on;
  islandSaveCfg(cfg);
  if (!cfg.smart) { islandHidden = false; islandCovered = false; islandApplyVisibility(); }
  return { ok: true, smart: !!cfg.smart };
});
ipcMain.handle('lumen:island-media-get', () => Object.assign({}, media.last(), { alive: media.alive() }));
ipcMain.handle('lumen:island-cmd', (_e, action, pos) => ({ ok: media.command(action, pos) }));
ipcMain.handle('lumen:island-notify-get', () => ({
  ok: true,
  items: notify.last(),
  enabled: islandLoadCfg().notify !== false,
  alive: notify.alive()
}));
ipcMain.handle('lumen:island-notify-clear', () => { notify.clear(); return { ok: true }; });
ipcMain.handle('lumen:island-open-main', () => { showWin(); return { ok: true }; });

/* ============================================================
   七、启动
   ============================================================ */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', async () => {
    trace('second-instance：重启端口服务并唤回窗口');
    await restartServer();
    showWin();
  });

  app.whenReady().then(async () => {
    trimLog();
    /* 形态（轻量壳 / 安装版）由 initUpdater 判定并自己打日志，这里不重复写，免得早于判定 */
    trace('app ready' + (DEV ? '（dev 模式）' : '') +
      ' · 端口 ' + WANT_PORT + ' · 数据目录 ' + app.getPath('userData'));
    try {
      await prepareMigration();        /* 必须在窗口加载前把旧数据读出来 */
      await startServer();
      initUpdater();                   /* 必须在建窗口前：要向窗口传「能否应用内更新」 */
      createWindow();
      createTray();
      clipStart();                     /* 剪贴板历史采集（托盘常驻期间也一直记） */
      /* 桌面灵动岛：每次启动都从「关」开始，需要时去 设置 → 桌面 手动打开。
         上次运行留下的 enabled 一律归零 —— 否则设置里显示「开」、岛上却空着，
         而且开机自启的用户会被一个自己没要的胶囊挡在屏幕顶上。
         自动化/排障用 LUMEN_ISLAND_ON=1 绕过这条，直接拉起。 */
      const icfg = islandLoadCfg();
      if (icfg.enabled) { icfg.enabled = false; islandSaveCfg(icfg); }
      if (String(process.env.LUMEN_ISLAND_ON || '') === '1') {
        try { islandSetEnabled(true); } catch (e) { trace('岛创建失败 ' + ((e && e.message) || e)); }
      }
      /* LUMEN_OPEN_STATUS=1：启动后自动打开壳状态页（排障用，也可以配进快捷方式） */
      if (String(process.env.LUMEN_OPEN_STATUS || '') === '1') {
        setTimeout(openStatusWindow, 1200);
      }
    } catch (e) {
      trace('启动异常 ' + ((e && e.message) || e));
      try { if (!win) createWindow(); } catch (_) {}
    } finally {
      booting = false;
    }
  });

  app.on('window-all-closed', () => {
    if (booting) return;               /* 启动阶段忽略（迁移窗口销毁会走到这） */
    if (quitting || !tray) app.quit();
  });
}
