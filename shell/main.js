/* Lumen 工作台 · 最小 Electron 壳
 * 只做三件事：开窗口加载单文件原型、外链交给系统浏览器、退出即关。
 * AI 请求代发（无 CORS）等 BYOK 工具实装时再加 IPC，这里保持最小。 */
const { app, BrowserWindow, Menu, shell } = require('electron');
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
      spellcheck: false
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

/* 本地工具用不上 GPU 加速：禁 GPU 并把渲染并入主进程，避免 GPU 子进程在无显卡环境下崩溃。
 * no-sandbox：本机（无显卡 VM）渲染进程沙箱起不来；应用只加载本地文件、外链全部交系统浏览器，风险可控。 */
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('no-sandbox');

app.whenReady().then(() => { trace('app ready'); createWindow(); });
app.on('window-all-closed', () => app.quit());
