/* Lumen 桌面灵动岛 · 智能隐藏判定
 *
 * 纯函数：输入前台窗口快照 + 屏幕/岛体几何，输出岛该「整窗隐藏」还是「收成细线」。
 * 之所以单独成文件：main.js 依赖 electron，没法在 Node 里直接 require 做单测；
 * 判定规则又最容易改错，抽出来就能离线跑断言（见 _island_fg_check.mjs）。
 *
 * 判定参考岛仔：
 *   · 前台窗口铺满整块屏幕 → 整窗隐藏（设置项 hide_fullscreen，默认开）
 *   · 前台是浏览器且压到岛所在的那条顶部带 → 收成细线（browser_minimal）
 *   · 自己的进程（主窗口 / 岛自身）永远不算遮挡
 */

/* 岛仔 is_browser_process 的名单；浏览器是最常见的「顶部被内容占住」场景 */
const BROWSERS = /^(chrome|msedge|firefox|brave|vivaldi|opera|arc|zen|chromium|librewolf|floorp|waterfox|duckduckgo|360se|360chrome|qqbrowser|sogouexplorer|quark)\.exe$/i;

function isBrowser(name) {
  const n = String(name || '').trim();
  if (!n) return false;
  return BROWSERS.test(n.toLowerCase().endsWith('.exe') ? n : n + '.exe');
}

/**
 * @param {object} p
 * @param {object} p.cfg        壳侧配置：{ smart, hideFullscreen, dock? }
 * @param {object} p.fg         前台快照（物理像素）：{ p, n, l, t, r, b }
 * @param {object} p.display    screen.getPrimaryDisplay()：{ bounds, scaleFactor }
 * @param {object} p.islandRect island.getBounds()（DIP）：{ x, y, width, height }
 * @param {number} p.capW       胶囊实测宽度（DIP）
 * @param {string} [p.dock]     停靠边 'top'|'left'|'right'（缺省按顶部处理）
 * @param {number} p.selfPid     本进程 pid
 * @returns {{hidden:boolean, min:boolean, reason:string}}
 */
function decide(p) {
  const cfg = p.cfg || {};
  const fg = p.fg || null;
  const none = { hidden: false, min: false, reason: 'none' };
  if (!fg) return none;
  if (p.selfPid && fg.p === p.selfPid) return Object.assign({}, none, { reason: 'self' });
  if (cfg.smart === false) return none;

  const d = p.display || { bounds: { x: 0, y: 0, width: 0, height: 0 }, scaleFactor: 1 };
  const sf = d.scaleFactor || 1;
  /* PowerShell 给的是物理像素，Electron 的几何是 DIP */
  const r = { l: fg.l / sf, t: fg.t / sf, r: fg.r / sf, b: fg.b / sf };
  const db = d.bounds;

  const full = r.t <= db.y + 1 && r.l <= db.x + 1 &&
               r.r >= db.x + db.width - 1 && r.b >= db.y + db.height - 1;
  if (cfg.hideFullscreen !== false && full) {
    return { hidden: true, min: false, reason: 'fullscreen' };
  }

  /* 左右停靠贴屏幕侧边，「浏览器压顶」是顶部停靠才有的场景 */
  if (p.dock === 'left' || p.dock === 'right') {
    return { hidden: false, min: false, reason: 'side-dock' };
  }
  const b = p.islandRect || { x: 0, y: 0, width: 0, height: 0 };
  /* 窗口跟着岛走（拖动是平移窗口），所以窗口中心就是岛中心，不用再加偏移 */
  const cx = b.x + b.width / 2;
  const half = (Number(p.capW) || 160) / 2 + 8;
  const overlap = isBrowser(fg.n) && r.b > b.y && r.t < b.y + 12 &&
                  r.r > cx - half && r.l < cx + half;
  return { hidden: false, min: overlap, reason: overlap ? 'browser-overlap' : 'clear' };
}

module.exports = { decide, isBrowser, BROWSERS };
