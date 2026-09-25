/* Lumen 工作台 · 预加载脚本（**唯一源码**，两种形态共用）
 * 给渲染进程五条受控通道（网络请求都只放行 http/https）：
 *   1) lumenNet.fetch      —— GET，用于抓网页类只读请求（热榜官方榜、快递、抓图）
 *   2) lumenNet.chat       —— POST + 自定义请求头 + SSE 流式转发，用于 AI 接口
 *   3) lumenRec.*          —— 屏幕录制：列源 / 选目录 / 流式落盘（主进程实现见 rec.js）
 *   4) lumenShell.*        —— 壳信息（本地端口地址 / 版本 / 状态）与「在浏览器中打开」
 *   5) lumenApp.*          —— 版本信息与应用内更新（只有带 electron-updater 的安装版可用，
 *                             轻量壳里 isInstalled 恒为 false，页面侧据此走「去 GitHub 下载」）
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
