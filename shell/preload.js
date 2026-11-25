/* Lumen 工作台 · 预加载脚本（**唯一源码**，两种形态共用）
 * 给渲染进程五条受控通道（网络请求都只放行 http/https）：
 *   1) lumenNet.fetch      —— GET，用于抓网页类只读请求（热榜官方榜、快递、抓图）
 *   2) lumenNet.chat       —— POST + 自定义请求头 + SSE 流式转发，用于 AI 接口
 *   3) lumenRec.*          —— 屏幕录制：列源 / 选目录 / 流式落盘（主进程实现见 rec.js）
 *   4) lumenShell.*        —— 壳信息（本地端口地址 / 版本 / 状态）与「在浏览器中打开」
 *   5) lumenApp.*          —— 版本信息与应用内更新（只有带 electron-updater 的安装版可用，
 *                             轻量壳里 isInstalled 恒为 false，页面侧据此走「去 GitHub 下载」）
 *   6) lumenClip.* / lumenSys.* —— 剪贴板历史与系统硬件信息（只有桌面壳有；
 *                             网页版直开时 window.lumenClip 为 undefined，页面走降级实现）
 *   7) lumenPy.*            —— 本机 Python 运行时：探测 / 跑自带脚本 / 装白名单依赖
 *                             （只有桌面壳有；网页版直开时为 undefined，工具页降级）
 * 之所以要代发：部分服务端（如 api.openai.com）不返回 CORS 头，交主进程直连最稳。
 * 另外，首次以本地端口启动时，把旧 file:// 时代存下的本机数据补写过来（见下）。 */
const { contextBridge, ipcRenderer } = require('electron');

/* 形态判定由主进程给：只有真正装了 electron-updater 且是打包态才会传 1 */
const packagedArg = process.argv.find(a => a.indexOf('--lumen-packaged=') === 0);
const isInstalled = !!packagedArg && packagedArg.split('=')[1] === '1';

/* ---------- 旧数据一次性补写 ----------
 * 壳从 file:// 换成 http://127.0.0.1 加载后，浏览器存储按 origin 隔离，
 * 原来配好的 Key / 设置 / 亲友链接都读不到了。这里在**页面脚本执行之前**
 * 把主进程从旧 origin 读到的键值补齐（只补缺失的，不覆盖新数据），
 * 于是各模块在顶层读 localStorage 时就能拿到。
 * 浏览器侧不需要这段：壳窗口先启动并写好，同源的浏览器打开即是同一份。 */
/* 只在 http(s) 身份下补写：迁移的方向是 file:// → 本地端口。
 * file:// 打开的那些窗口（LUMEN_MODE=file 的主窗口、壳状态页、迁移探针本身）
 * 本来就在自己的 origin 上，补写只会把数据糊进它们各自的存储里。 */
if (location.protocol === 'http:' || location.protocol === 'https:') {
  try {
    const mig = ipcRenderer.sendSync('lumen:migrate-pull');
    if (mig && typeof mig === 'object') {
      let wrote = 0;
      for (const k in mig) {
        if (!Object.prototype.hasOwnProperty.call(mig, k)) continue;
        const v = mig[k];
        if (typeof v !== 'string') continue;
        try {
          if (localStorage.getItem(k) === null) { localStorage.setItem(k, v); wrote++; }
        } catch (e) {}
      }
      /* 回报主进程：写进去了才算迁完，之后启动不再探测 */
      try { ipcRenderer.send('lumen:migrate-done', wrote); } catch (e) {}
      if (wrote) console.log('[lumen] 已从旧版本迁入 ' + wrote + ' 项本机数据');
    }
  } catch (e) {}
}

contextBridge.exposeInMainWorld('lumenNet', {
  isElectron: true,

  fetch: url => ipcRenderer.invoke('lumen:net-fetch', String(url || '')),

  /* 通用 HTTP（API 测试工具）：payload { method, url, headers, body }
   * 返回 { ok, status, statusText, headers, text, ms, error } */
  http: payload => ipcRenderer.invoke('lumen:http', payload || {}),

  /* payload: { id, url, headers, body, stream }
   * onDelta(chunkText) 会被逐块回调；返回 { ok, status, text, sse, error, aborted } */
  chat: (payload, onDelta) => {
    const id = (payload && payload.id) || String(Date.now());
    let handler = null;
    if (typeof onDelta === 'function') {
      handler = (_e, d) => { if (d && d.id === id) onDelta(d.chunk); };
      ipcRenderer.on('lumen:chat-delta', handler);
    }
    const done = () => { if (handler) ipcRenderer.removeListener('lumen:chat-delta', handler); };
    return ipcRenderer.invoke('lumen:chat', { ...payload, id }).then(
      r => { done(); return r; },
      e => { done(); throw e; }
    );
  },

  abort: id => ipcRenderer.send('lumen:chat-abort', id)
});

/* 视频下载（Beta）：探测 / 开始 / 取消 / 定位文件。
 * 进度走 lumen:dl-progress 事件，页面按 id 过滤。 */
contextBridge.exposeInMainWorld('lumenDl', {
  isElectron: true,
  probe: (payload) => ipcRenderer.invoke('lumen:dl-probe', payload || {}),
  start: (payload) => ipcRenderer.invoke('lumen:dl-start', payload || {}),
  cancel: (id) => ipcRenderer.invoke('lumen:dl-cancel', String(id || '')),
  reveal: (p) => ipcRenderer.invoke('lumen:dl-reveal', String(p || '')),
  onProgress: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const h = (_e, d) => { try { cb(d); } catch (_) {} };
    ipcRenderer.on('lumen:dl-progress', h);
    return () => ipcRenderer.removeListener('lumen:dl-progress', h);
  }
});

/* 站点解析组件（yt-dlp，按需下载，不进安装包） */
contextBridge.exposeInMainWorld('lumenWeb', {
  isElectron: true,
  state: () => ipcRenderer.invoke('lumen:web-state'),
  install: (target, force) => ipcRenderer.invoke('lumen:web-install', { target: String(target || 'ytdlp'), force: !!force }),
  formats: (payload) => ipcRenderer.invoke('lumen:web-formats', payload || {}),
  start: (payload) => ipcRenderer.invoke('lumen:web-start', payload || {}),
  /* YouTube 人机校验：应用内登录一次，登录态导出成本机 Cookie 文件给解析组件用 */
  ytLogin: () => ipcRenderer.invoke('lumen:yt-login'),
  ytCookie: () => ipcRenderer.invoke('lumen:yt-cookie'),
  /* 网页版已登录时，直接粘贴 Cookie 或导入 cookies.txt，不必在应用里再登一次 */
  ytCookieSet: (raw) => ipcRenderer.invoke('lumen:yt-cookie-set', { raw: String(raw || '') }),
  ytCookiePick: () => ipcRenderer.invoke('lumen:yt-cookie-file'),
  ytCookieClear: () => ipcRenderer.invoke('lumen:yt-cookie-clear'),
  onProgress: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const h = (_e, d) => { try { cb(d); } catch (_) {} };
    ipcRenderer.on('lumen:web-progress', h);
    return () => ipcRenderer.removeListener('lumen:web-progress', h);
  }
});

/* 壳信息：{ mode:'http'|'file', port, url, version } */
contextBridge.exposeInMainWorld('lumenShell', {
  isElectron: true,
  info: () => ipcRenderer.invoke('lumen:shell-info'),
  openInBrowser: () => ipcRenderer.invoke('lumen:open-in-browser'),
  /* 下面三个给壳状态页（shell/status.html）用 */
  status: () => ipcRenderer.invoke('lumen:shell-status'),
  restartServer: () => ipcRenderer.invoke('lumen:restart-server'),
  openLog: () => ipcRenderer.invoke('lumen:open-log'),
  /* 托盘菜单接管：设置面板用（见 settings.js）；动作实现只在壳里，页面只能提交动作名 */
  setTrayMenu: (items) => ipcRenderer.invoke('lumen:tray-set', items),
  getTrayMenu: () => ipcRenderer.invoke('lumen:tray-get')
});

/* 应用版本与应用内更新。
 * 轻量壳（无 electron-updater）里 isInstalled 为 false，info().canAutoUpdate 也是 false，
 * 页面侧 update.js 据此走「检查 GitHub 版本 → 跳转下载」那条老路径。 */
contextBridge.exposeInMainWorld('lumenApp', {
  isElectron: true,
  isInstalled,
  /* { version, packaged, canAutoUpdate, userData } */
  info: () => ipcRenderer.invoke('lumen:app-info'),
  checkUpdate: () => ipcRenderer.invoke('lumen:update-check'),
  downloadUpdate: () => ipcRenderer.invoke('lumen:update-download'),
  installUpdate: () => ipcRenderer.invoke('lumen:update-install'),
  /* onUpdateStatus(cb)：cb({ state, version?, percent?, message? })
   * state: checking | available | none | downloading | downloaded | error
   * 返回取消订阅函数 */
  onUpdateStatus: cb => {
    const h = (_e, d) => { try { cb(d); } catch (e) {} };
    ipcRenderer.on('lumen:update-status', h);
    return () => ipcRenderer.removeListener('lumen:update-status', h);
  }
});

/* 剪贴板历史：采集在主进程（窗口失焦时也要记），页面只读列表 + 发指令。
 * list(): { ok, watch, items:[{id,type:'text'|'files'|'image',ts,text?,files?,thumb?,w?,h?,big?}] }
 * copy(id) 把某条写回系统剪贴板；del/clear 管理；watch(bool) 暂停 / 继续记录；
 * refresh() 立刻读一次（用户手动「记录当前剪贴板」）；
 * onNew(cb) 新条目推过来时回调，返回取消订阅函数。 */
contextBridge.exposeInMainWorld('lumenClip', {
  isElectron: true,
  list: () => ipcRenderer.invoke('lumen:clip-list'),
  copy: id => ipcRenderer.invoke('lumen:clip-copy', String(id || '')),
  del: id => ipcRenderer.invoke('lumen:clip-del', String(id || '')),
  clear: () => ipcRenderer.invoke('lumen:clip-clear'),
  watch: on => ipcRenderer.invoke('lumen:clip-watch', !!on),
  refresh: () => ipcRenderer.invoke('lumen:clip-poll'),
  onNew: cb => {
    const h = (_e, d) => { try { cb(d); } catch (err) {} };
    ipcRenderer.on('lumen:clip-new', h);
    return () => ipcRenderer.removeListener('lumen:clip-new', h);
  }
});

/* 系统硬件信息（CPU 型号 / 物理核数 / 内存 / 显卡 / 多屏参数 / 路径…）。
 * info(): { ok, shell:'desktop', result:{...} }；网页版没有这个桥。 */
contextBridge.exposeInMainWorld('lumenSys', {
  isElectron: true,
  info: () => ipcRenderer.invoke('lumen:sys-info')
});

/* 桌面灵动岛。
 * 主窗口的设置面板只用 get / setEnabled；岛页面自己用 onState / onMedia 收推送。
 * media() 返回的是「最近一次」状态，首屏直接画，不必等下一轮轮询。 */
contextBridge.exposeInMainWorld('lumenIsland', {
  isElectron: true,
  /* { ok, enabled, available, running, media } */
  get: () => ipcRenderer.invoke('lumen:island-get'),
  /* { ok, enabled, available, error? } */
  setEnabled: on => ipcRenderer.invoke('lumen:island-set', !!on),
  media: () => ipcRenderer.invoke('lumen:island-media-get'),
  cmd: (action, pos) => ipcRenderer.invoke('lumen:island-cmd', String(action || 'toggle'), Number(pos) || 0),
  openMain: () => ipcRenderer.invoke('lumen:island-open-main'),
  /* 系统通知（QQ / 微信 / 邮件…）：读 Windows 通知库，列表新的在前 */
  notify: () => ipcRenderer.invoke('lumen:island-notify-get'),
  notifyClear: () => ipcRenderer.invoke('lumen:island-notify-clear'),
  onNotify: cb => {
    if (typeof cb !== 'function') return () => {};
    const h = (_e, d) => { try { cb(Array.isArray(d) ? d : []); } catch (err) {} };
    ipcRenderer.on('lumen:island-notify', h);
    return () => ipcRenderer.removeListener('lumen:island-notify', h);
  },
  onMedia: cb => {
    if (typeof cb !== 'function') return () => {};
    const h = (_e, d) => { try { cb(d); } catch (err) {} };
    ipcRenderer.on('lumen:island-media', h);
    return () => ipcRenderer.removeListener('lumen:island-media', h);
  },
  onState: cb => {
    if (typeof cb !== 'function') return () => {};
    const h = (_e, d) => { try { cb(d); } catch (err) {} };
    ipcRenderer.on('lumen:island-state', h);
    return () => ipcRenderer.removeListener('lumen:island-state', h);
  },
  /* 智能隐藏开关（全屏 / 浏览器遮住岛时收细线） */
  setSmart: on => ipcRenderer.invoke('lumen:island-smart', !!on),
  /* 工作状态上报：主窗口换视图 / AI 忙碌态变化时发，壳中转给岛。
     act = { kind:'idle'|'page'|'tool'|'task', name, extra? }，非法或 idle 都视为清空 */
  activity: act => ipcRenderer.send('lumen:island-activity', act),
  onActivity: cb => {
    if (typeof cb !== 'function') return () => {};
    const h = (_e, d) => { try { cb(d); } catch (err) {} };
    ipcRenderer.on('lumen:island-activity', h);
    return () => ipcRenderer.removeListener('lumen:island-activity', h);
  },
  /* 胶囊尺寸是内容自适应的：页面量完报给主进程，热区按实测算。
     顶部停靠报宽度；左右停靠报长度。 */
  setCapWidth: w => ipcRenderer.send('lumen:island-cap', Number(w) || 0),
  /* 拖动：页面只报「按下 / 松手」，光标位移由壳自己读屏幕坐标（弹簧跟手在壳侧） */
  dragStart: () => ipcRenderer.send('lumen:island-drag', true),
  dragMove: (dx, dy) => ipcRenderer.send('lumen:island-move', Number(dx) || 0, Number(dy) || 0),
  dragEnd: () => ipcRenderer.send('lumen:island-drag', false),
  /* 停靠边：'top' | 'left' | 'right'；岛选项：{ clockSeconds } */
  setDock: d => ipcRenderer.invoke('lumen:island-dock', String(d || 'top')),
  setOpt: patch => ipcRenderer.invoke('lumen:island-opt', patch || {}),
  /* 拖中吸附状态变化：{ locked, silent? }，页面据此画绿描边 / 扫光 */
  onLock: cb => {
    if (typeof cb !== 'function') return () => {};
    const h = (_e, d) => { try { cb(d || {}); } catch (err) {} };
    ipcRenderer.on('lumen:island-lock', h);
    return () => ipcRenderer.removeListener('lumen:island-lock', h);
  },
  /* 停靠边 / 时钟秒数等配置变化（设置页改了、或拖动中换边） */
  onCfg: cb => {
    if (typeof cb !== 'function') return () => {};
    const h = (_e, d) => { try { cb(d || {}); } catch (err) {} };
    ipcRenderer.on('lumen:island-cfg', h);
    return () => ipcRenderer.removeListener('lumen:island-cfg', h);
  },
  /* 智能隐藏：被前台窗口遮住时收成细线，光标靠近自动还原 */
  onMin: cb => {
    if (typeof cb !== 'function') return () => {};
    const h = (_e, d) => { try { cb(!!d); } catch (err) {} };
    ipcRenderer.on('lumen:island-min', h);
    return () => ipcRenderer.removeListener('lumen:island-min', h);
  },
  /* 从全屏隐藏里回来：窗口刚 show 出来，让页面重播一次登场动画 */
  onEnter: cb => {
    if (typeof cb !== 'function') return () => {};
    const h = () => { try { cb(); } catch (err) {} };
    ipcRenderer.on('lumen:island-enter', h);
    return () => ipcRenderer.removeListener('lumen:island-enter', h);
  }
});

/* 本机 Python 运行时（创意工具的算力后端）。
 * status(force) → { ok, exe, version, hasPillow, err }
 * run({ source, args, timeout }) → { ok, result, files:[{name,mime,dataUrl}], ms, log }
 *   source 必须是构建时内联的自带脚本（主进程会验身份证行），页面不能凭空造脚本；
 * setExe(path) 手动指定解释器；install(name) 只允许 pillow / numpy。 */
contextBridge.exposeInMainWorld('lumenPy', {
  isElectron: true,
  status: force => ipcRenderer.invoke('lumen:py-status', !!force),
  run: payload => ipcRenderer.invoke('lumen:py-run', payload || {}),
  setExe: p => ipcRenderer.invoke('lumen:py-set-exe', String(p || '')),
  install: name => ipcRenderer.invoke('lumen:py-install', String(name || ''))
});

/* 屏幕录制：页面拿不到 desktopCapturer，也绕不过捕获授权，全走这里。
 * 录制数据用 write() 分片交给主进程直接写文件，页面不攒 Blob。 */
contextBridge.exposeInMainWorld('lumenRec', {
  isElectron: true,
  /* { ok, hotkey, hotkeyOK, electron } */
  info: () => ipcRenderer.invoke('lumen:rec-info'),
  /* { ok, sources: [{ id, name, kind:'screen'|'window', thumb }] } */
  listSources: () => ipcRenderer.invoke('lumen:rec-sources'),
  /* 记住选择的源，下一次取流按它给 */
  pickSource: id => ipcRenderer.invoke('lumen:rec-pick', String(id || '')),
  /* { ok, dir, exists } —— 默认是「视频/Lumen 录制」 */
  defaultDir: () => ipcRenderer.invoke('lumen:rec-dir'),
  chooseDir: cur => ipcRenderer.invoke('lumen:rec-choose-dir', String(cur || '')),
  openDir: dir => ipcRenderer.invoke('lumen:rec-open-dir', String(dir || '')),
  /* { ok, id, path } */
  prepare: payload => ipcRenderer.invoke('lumen:rec-prepare', payload || {}),
  write: (id, buf) => ipcRenderer.invoke('lumen:rec-chunk', String(id || ''), buf),
  finish: id => ipcRenderer.invoke('lumen:rec-finish', String(id || '')),
  abort: id => ipcRenderer.invoke('lumen:rec-abort', String(id || '')),
  /* 删除已保存的录制文件 */
  deleteFile: p => ipcRenderer.invoke('lumen:rec-delete', String(p || '')),
  /* 按范围读录制文件（页面解析分片用）；返回 { ok, size, buf } */
  readRange: (path, offset, length) => ipcRenderer.invoke('lumen:rec-rd',
    { path: String(path || ''), offset: Number(offset) || 0, length: Number(length) || 0 }),
  /* 重排落盘：主进程流式「新头 + 拷范围」覆盖原文件；payload = { path, header:ArrayBuffer, ranges:[{off,len}] } */
  remux: payload => ipcRenderer.invoke('lumen:rec-remux', payload || {}),
  /* 全局快捷键（Ctrl+Shift+F9）按下时回调；返回取消订阅函数 */
  onHotkey: cb => {
    const h = () => { try { cb(); } catch (e) {} };
    ipcRenderer.on('lumen:rec-hotkey', h);
    return () => ipcRenderer.removeListener('lumen:rec-hotkey', h);
  }
});
