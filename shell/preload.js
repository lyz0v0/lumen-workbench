/* Lumen 工作台 · 预加载脚本
 * 给渲染进程两条受控网络通道（都只放行 http/https）：
 *   1) lumenNet.fetch      —— GET，用于抓网页类只读请求
 *   2) lumenNet.chat       —— POST + 自定义请求头 + SSE 流式转发，用于 AI 接口
 * 之所以要代发：工作台以 file:// 打开，页面里的 fetch 受浏览器跨域策略约束，
 * 部分服务端（如 api.openai.com）不返回 CORS 头，交主进程直连最稳。 */
const { contextBridge, ipcRenderer } = require('electron');

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
