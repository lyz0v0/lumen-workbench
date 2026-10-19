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
const { app, BrowserWindow, Menu, Tray, shell, ipcMain, clipboard, nativeImage, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const srv = require('./server');
const rec = require('./rec');

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
app.on('before-quit', () => { quitting = true; });

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
   六、启动
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
