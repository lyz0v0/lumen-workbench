/* Lumen 桌面灵动岛 · 页面逻辑
 *
 * 与主窗口同源（http://127.0.0.1:端口/__lumen/island），所以：
 *   · 主题、天气城市、天气缓存直接读同一份 localStorage，不需要任何同步协议；
 *   · 主窗口改了设置（storage 事件）这里立刻跟随。
 *
 * 主进程负责：窗口创建 / 光标热区 / 收起态穿透 / 媒体轮询；页面只负责画和发指令。
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var bridge = window.lumenIsland || null;

  /* ================= 主题 ================= */
  function themeMode() {
    try {
      var s = JSON.parse(localStorage.getItem('lumen-settings-v1') || '{}');
      return (s && s.themeMode) || 'system';
    } catch (e) { return 'system'; }
  }
  function applyTheme() {
    var m = themeMode();
    var dark = m === 'dark' || (m === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }
  applyTheme();
  try {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
    window.addEventListener('storage', function (e) {
      if (!e.key || e.key === 'lumen-settings-v1') applyTheme();
      if (e.key === 'lumen-weather-v2') { var c = readCache(); if (c) renderWx(c); }
    });
  } catch (e) {}

  /* ================= 时钟 =================
     可显示秒数（设置 → 桌面）；左右停靠时竖排成「时 / 分（/ 秒）」多行。
     长时间无操作且不显示秒时降到 5s 一跳省资源，任何指针活动立刻恢复。 */
  var WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  var showSec = false;
  var dock = 'top';                /* 'top' | 'left' | 'right'，壳配置推送后切换 */
  var clockTimer = 0, slowClock = false, lastAct = Date.now();
  function clock() {
    var d = new Date();
    var hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
    var sec = showSec ? ':' + pad(d.getSeconds()) : '';
    if (dock !== 'top') {
      /* 竖排：白空行分隔（CSS pre-line），时 / 分 / 秒各一行 */
      $('capTime').textContent = pad(d.getHours()) + '\n' + pad(d.getMinutes()) + (showSec ? '\n' + pad(d.getSeconds()) : '');
    } else {
      $('capTime').textContent = hm + sec;
    }
    $('pTime').textContent = hm + sec;
    $('pDate').textContent = (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + WD[d.getDay()];
    /* 闲置降频：收起 + 10 分钟无操作 + 不显示秒 → 5s 一跳；有秒数就不降（要跳秒） */
    if (!showSec && !slowClock && document.body.dataset.state === 'collapsed' &&
        Date.now() - lastAct > 10 * 60 * 1000) {
      slowClock = true;
      clockTimerReset();
    }
  }
  function clockTimerReset() {
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = setInterval(clock, slowClock ? 5000 : 1000);
  }
  function userActive() {
    lastAct = Date.now();
    if (slowClock) { slowClock = false; clockTimerReset(); }
  }
  document.addEventListener('pointerdown', userActive, true);
  document.addEventListener('pointermove', userActive, true);
  document.addEventListener('wheel', userActive, true);
  clock();
  clockTimerReset();

  /* ================= 胶囊自适应尺寸 =================
     「小」的关键不是缩小字号，而是**尺寸跟着内容走**：量出实际尺寸后回填居中
     margin，并把尺寸报给主进程当热区。顶部停靠量宽、左右停靠量高（竖排胶囊）。 */
  var capEl = $('cap');
  var capW = 0;
  function measureCap() {
    if (!capEl) return;
    if (document.body.dataset.min === '1') return;   /* 细线态由 CSS 定尺寸，不量 */
    var side = dock !== 'top';
    var n = Math.round(side ? capEl.offsetHeight : capEl.offsetWidth);
    if (!n) return;
    if (side) {
      capEl.style.marginTop = (-n / 2) + 'px';
      capEl.style.marginLeft = '';
    } else {
      capEl.style.marginLeft = (-n / 2) + 'px';
      capEl.style.marginTop = '';
    }
    if (n !== capW) {
      capW = n;
      if (bridge && bridge.setCapWidth) bridge.setCapWidth(n);
    }
  }
  measureCap();
  try { new ResizeObserver(function () { measureCap(); }).observe(capEl); } catch (e) {}

  /* ================= 登场动画 =================
     窗口 ready-to-show 时页面早就画完了，直接 show 就是「啪」地蹦出来。
     先用 data-boot="1" 遮住首帧，等胶囊宽度量稳、字体落定，再摘遮罩 + 播 capIn：
     从上方落下、末端过冲 3% 停住。全屏隐藏恢复时主进程会再发 enter，复用同一个动画。 */
  function playEnter() {
    if (!capEl) return;
    capEl.classList.remove('enter');
    void capEl.offsetWidth;              /* 强制回流，否则连续加同一个类不会重播 */
    capEl.classList.add('enter');
  }
  capEl.addEventListener('animationend', function (e) {
    if (e.animationName !== 'capIn') return;
    capEl.classList.remove('enter');     /* 摘掉，别让 fill 锁死 expanded 态的 transform */
    document.body.removeAttribute('data-boot');
  });
  function boot() {
    measureCap();
    /* 不在这里直接播：窗口此时可能还 hidden（ready-to-show 之前），动画会在看不见的时候放完，
       用户看到的还是「凭空出现」。等主进程 showInactive 之后发 enter 再播；
       600ms 兜底自己播一次，避免 IPC 丢了岛一直停在透明态。 */
    setTimeout(startEnter, 600);
  }
  var booted = false;
  function startEnter() {
    if (booted) return;
    booted = true;
    document.body.dataset.boot = '0';
    playEnter();
    /* 兜底：系统「减少动效」把动画压成瞬时也不一定派发 animationend，遮罩得自己摘 */
    setTimeout(function () { document.body.removeAttribute('data-boot'); }, 900);
  }
  boot();

  /* ================= 拖动位置 =================
     岛仔拖的是整个岛：按住 → 窗口跟着光标走，松手落在屏幕任意水平位置。
     这里页面不位移任何元素，只把「从按下算起的屏幕位移」报给壳，由壳平移窗口。
     早期版本是「窗口做宽 + 页面 translateX」，范围只有 ±100px，手感是拖一点就撞墙；
     而且岛被 clamp 住后光标继续走会掉出面板，450ms 后自动收起把拖动掐断。 */
  var offset = 0;
  function readPos() {
    if (!bridge || !bridge.get) return;
    bridge.get().then(function (r) {
      if (r && typeof r.offset === 'number') offset = r.offset;
    }).catch(function () {});
  }
  readPos();

  /* ================= 天气 =================
     Open-Meteo 的字段与缓存结构跟主窗口 weather.js 完全一致（键 lumen-weather-v2），
     主窗口刷新过就直接拿来用，岛自己只在缓存过期时补一次。 */
  var WX_KEY = 'lumen-weather-v2';
  var WX_CODES = {
    0: ['晴', 'sun'], 1: ['基本晴', 'sun'], 2: ['多云', 'partly'], 3: ['阴', 'cloud'],
    45: ['雾', 'fog'], 48: ['雾凇', 'fog'],
    51: ['毛毛雨', 'rain'], 53: ['毛毛雨', 'rain'], 55: ['浓毛毛雨', 'rain'],
    56: ['冻毛毛雨', 'rain'], 57: ['冻毛毛雨', 'rain'],
    61: ['小雨', 'rain'], 63: ['中雨', 'rain'], 65: ['大雨', 'rain'],
    66: ['冻雨', 'rain'], 67: ['冻雨', 'rain'],
    71: ['小雪', 'snow'], 73: ['中雪', 'snow'], 75: ['大雪', 'snow'], 77: ['雪粒', 'snow'],
    80: ['阵雨', 'rain'], 81: ['阵雨', 'rain'], 82: ['强阵雨', 'rain'],
    85: ['阵雪', 'snow'], 86: ['阵雪', 'snow'],
    95: ['雷阵雨', 'storm'], 96: ['雷雨伴冰雹', 'storm'], 99: ['雷雨伴冰雹', 'storm']
  };
  var WX_ICONS = {
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v1.8M12 19.7v1.8M2.5 12h1.8M19.7 12h1.8M5.3 5.3l1.3 1.3M17.4 17.4l1.3 1.3M18.7 5.3l-1.3 1.3M6.6 17.4l-1.3 1.3"/>',
    partly: '<circle cx="7" cy="7" r="2.6"/><path d="M7 2.8v1.2M1.8 7H3M11 7h1.2M3.4 3.4l.9.9M10.6 3.4l-.9.9"/><path d="M9 19a4 4 0 1 1 .6-7.96A5.5 5.5 0 0 1 20 12.5a3.5 3.5 0 0 1-.5 6.5H9z"/>',
    cloud: '<path d="M7 18a4 4 0 1 1 .6-7.96A5.5 5.5 0 0 1 18 11.5a3.5 3.5 0 0 1-.5 6.5H7z"/>',
    rain: '<path d="M7 15a4 4 0 1 1 .6-7.96A5.5 5.5 0 0 1 18 8.5a3.5 3.5 0 0 1-.5 6.5H7z"/><path d="M9 17.5l-1 2.5M13 17.5l-1 2.5M17 17.5l-1 2.5"/>',
    snow: '<path d="M7 15a4 4 0 1 1 .6-7.96A5.5 5.5 0 0 1 18 8.5a3.5 3.5 0 0 1-.5 6.5H7z"/><path d="M9 19.5h.01M12.5 21h.01M16 19.5h.01"/>',
    storm: '<path d="M7 14a4 4 0 1 1 .6-7.96A5.5 5.5 0 0 1 18 7.5a3.5 3.5 0 0 1-.5 6.5H7z"/><path d="M13 15.5l-2.5 3.5h3L11 22.5"/>',
    fog: '<path d="M4 9.5h16M6 13.5h12M8 17.5h8"/>',
    moon: '<path d="M20.2 14.6A8.2 8.2 0 0 1 9.4 4.1a8.2 8.2 0 1 0 10.8 10.5z"/><path d="M19 3.4l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8z"/>',
    partlyn: '<path transform="translate(0.4 -1.2) scale(0.42)" d="M20.2 14.6A8.2 8.2 0 0 1 9.4 4.1a8.2 8.2 0 1 0 10.8 10.5z"/><path d="M9 19a4 4 0 1 1 .6-7.96A5.5 5.5 0 0 1 20 12.5a3.5 3.5 0 0 1-.5 6.5H9z"/>'
  };
  function wxIcon(kind) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true">' + (WX_ICONS[kind] || WX_ICONS.cloud) + '</svg>';
  }
  function wxNight(kind) { return kind === 'sun' ? 'moon' : kind === 'partly' ? 'partlyn' : kind; }
  function wxInfo(code) { return WX_CODES[code] || ['—', 'cloud']; }
  function wxNum(v) { var n = +v; return isFinite(n) ? n : null; }

  function readCache() {
    try { return JSON.parse(localStorage.getItem(WX_KEY)) || null; } catch (e) { return null; }
  }
  function cityName(c) {
    if (!c) return '';
    return c.admin1 && c.admin1 !== c.name ? c.admin1 + ' ' + c.name : c.name;
  }

  var lastWx = null;
  function renderWx(o) {
    if (!o || !o.data || !o.data.current) return;
    lastWx = o;
    var cur = o.data.current;
    var info = wxInfo(cur.weather_code);
    var kind = cur.is_day === 0 ? wxNight(info[1]) : info[1];
    var t = wxNum(cur.temperature_2m);
    var tStr = t === null ? '--°' : Math.round(t) + '°';

    $('capWxIc').innerHTML = wxIcon(kind);
    $('capWxT').textContent = tStr;
    $('pWxIc').innerHTML = wxIcon(kind);
    $('pWxT').textContent = tStr;
    $('pWxD').textContent = info[0];
    $('pWx').setAttribute('aria-label', cityName(o.city) + (t === null ? '' : ' · 体感 ' + Math.round(wxNum(cur.apparent_temperature) ?? t) + '°'));

    /* 四天预报 */
    var d = o.data.daily || {};
    var days = d.time || [];
    var fc = $('fc');
    if (!days.length) { fc.className = 'fc none'; fc.textContent = '暂无预报数据'; return; }
    fc.className = 'fc';
    var html = '';
    for (var i = 0; i < Math.min(4, days.length); i++) {
      var di = wxInfo((d.weather_code || [])[i]);
      var hi = wxNum((d.temperature_2m_max || [])[i]);
      var lo = wxNum((d.temperature_2m_min || [])[i]);
      var label = i === 0 ? '今天' : i === 1 ? '明天' : WD[new Date(days[i] + 'T12:00:00').getDay()];
      html += '<div class="fc-day"><span class="d">' + label + '</span>'
        + '<span class="ic">' + wxIcon(di[1]) + '</span>'
        + '<span class="t"><b>' + (hi === null ? '--' : Math.round(hi)) + '°</b> '
        + (lo === null ? '--' : Math.round(lo)) + '°</span></div>';
    }
    fc.innerHTML = html;
  }

  function net(url) {
    if (window.lumenNet && window.lumenNet.fetch) {
      return window.lumenNet.fetch(url).then(function (r) {
        if (!r || !r.ok) throw new Error('HTTP ' + ((r && r.status) || 0));
        return JSON.parse(r.text);
      });
    }
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function loadWx(force) {
    var c = readCache();
    if (c && c.data && !force && Date.now() - (c.ts || 0) < 30 * 60 * 1000) { renderWx(c); return; }
    var city = (c && c.city) || { name: '北京', admin1: '', lat: 39.9042, lon: 116.4074 };
    if (c && c.data) renderWx(c);                    /* 有过期缓存先顶上，别空着 */
    var cur = 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,wind_speed_10m,wind_direction_10m';
    var day = 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max,sunrise,sunset';
    var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + city.lat + '&longitude=' + city.lon
      + '&current=' + cur + '&daily=' + day + '&timezone=auto&forecast_days=4';
    net(url).then(function (j) {
      if (!j || !j.current || !j.daily) throw new Error('empty');
      var o = { city: city, data: j, ts: Date.now() };
      try { localStorage.setItem(WX_KEY, JSON.stringify(o)); } catch (e) {}
      renderWx(o);
    }).catch(function () {
      if (!lastWx) {
        $('pWxD').textContent = '天气不可用';
        $('fc').className = 'fc none';
        $('fc').textContent = '天气加载失败';
      }
    });
  }
  loadWx(false);
  setInterval(function () { loadWx(false); }, 30 * 60 * 1000);

  /* ================= 电量 ================= */
  function initBattery() {
    if (!navigator.getBattery) return;
    navigator.getBattery().then(function (b) {
      function paint() {
        var pct = Math.round(b.level * 100);
        $('pBat').hidden = false;
        $('pBatFill').style.width = pct + '%';
        $('pBatT').textContent = pct + '%';
        $('pBat').setAttribute('aria-label', b.charging ? '正在充电' : '电池电量');
      }
      paint();
      b.addEventListener('levelchange', paint);
      b.addEventListener('chargingchange', paint);
    }).catch(function () {});
  }
  initBattery();

  /* ================= 媒体 =================
     音乐播放器暂时撤下（用户要求，后续再考虑恢复）：DOM 都还在，SHOW_MEDIA
     置 true 即可整卡恢复；撤下期间 SMTC 桥照常跑，只是不再画到界面上。 */
  var SHOW_MEDIA = false;
  var M = { active: false, status: '', pos: 0, dur: 0, at: Date.now(), title: '', artist: '' };

  function fmt(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    var s = Math.floor(sec % 60);
    return Math.floor(sec / 60) + ':' + pad(s);
  }

  function hashHue(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
    return h;
  }

  function setArt(src, title) {
    var art = $('art');
    if (src) {
      var img = art.querySelector('img');
      if (!img || img.getAttribute('data-src') !== src.slice(0, 64)) {
        art.innerHTML = '';
        img = document.createElement('img');
        img.setAttribute('data-src', src.slice(0, 64));
        img.src = src;
        art.appendChild(img);
      }
      art.classList.remove('ph');
      art.style.removeProperty('--art-a');
      art.style.removeProperty('--art-b');
    } else {
      /* 没有封面（酷狗这类不上传缩略图的播放器）：按标题生成一对稳定的渐变色 */
      var h = hashHue(title || 'lumen');
      art.innerHTML = '<span class="art-ph">♪</span>';
      art.classList.add('ph');
      art.style.setProperty('--art-a', 'hsl(' + h + ' 46% 52%)');
      art.style.setProperty('--art-b', 'hsl(' + ((h + 58) % 360) + ' 52% 42%)');
    }
  }

  var artSrc = '';
  var lastTrackKey = '';
  var swapTimer = 0;
  /* 换歌时让封面与标题轻轻上浮淡入（CSS 的 mediaSwap），比文字直接跳变自然 */
  function playSwap() {
    var m = $('media');
    if (!m) return;
    m.dataset.swap = '1';
    clearTimeout(swapTimer);
    swapTimer = setTimeout(function () { delete m.dataset.swap; }, 420);
  }
  /* SMTC 给的是 app 的 AUMID，显示成用户认得的名字 */
  var APP_NAMES = [
    [/kugou/i, '酷狗音乐'], [/cloudmusic|netease/i, '网易云音乐'], [/qqmusic/i, 'QQ 音乐'],
    [/spotify/i, 'Spotify'], [/applemusic|music\.ui/i, 'Apple Music'],
    [/potplayer/i, 'PotPlayer'], [/foobar/i, 'foobar2000'], [/wmplayer/i, 'Windows Media Player'],
    [/chrome/i, 'Chrome'], [/msedge|edge/i, 'Edge'], [/firefox/i, 'Firefox']
  ];
  function appName(id) {
    var s = String(id || '');
    for (var i = 0; i < APP_NAMES.length; i++) if (APP_NAMES[i][0].test(s)) return APP_NAMES[i][1];
    return '系统播放器';
  }

  function renderMedia(s) {
    var active = !!(s && s.ok && s.title !== undefined && s.app !== undefined);
    M.active = active;
    /* 撤下期间不碰媒体 DOM，只记状态（E2E / 后续恢复用） */
    if (!SHOW_MEDIA) {
      $('capEq').hidden = true;
      if (active) {
        M.status = s.status || '';
        M.title = s.title || '';
        M.artist = s.artist || '';
        M.pos = +s.pos || 0;
        M.dur = +s.dur || 0;
        M.at = Date.now();
      }
      return;
    }
    $('capEq').hidden = !(active && s.status === 'Playing');

    if (!active) {
      $('media').style.display = 'none';
      $('ctrl').hidden = true;
      $('empty').style.display = 'flex';
      artSrc = '';
      lastTrackKey = '';          /* 停播后再播同一首也要有浮现 */
      return;
    }

    $('media').style.display = '';
    $('ctrl').hidden = false;
    $('empty').style.display = 'none';

    var trackKey = (s.title || '') + '\u0001' + (s.artist || '');
    if (trackKey !== lastTrackKey) {
      if (lastTrackKey) playSwap();
      lastTrackKey = trackKey;
    }

    M.status = s.status || '';
    M.pos = +s.pos || 0;
    M.dur = +s.dur || 0;
    M.at = Date.now();
    M.title = s.title || '';
    M.artist = s.artist || '';

    $('mTitle').textContent = s.title || '未知曲目';
    $('mArtist').textContent = [s.artist, s.album].filter(Boolean).join(' · ') || '未知艺术家';
    $('mTitle').setAttribute('aria-label', s.title || '');
    $('btnPlay').classList.toggle('playing', s.status === 'Playing');
    $('btnPlay').setAttribute('aria-label', s.status === 'Playing' ? '暂停' : '播放');
    $('btnPrev').disabled = s.canPrev === false;
    $('btnNext').disabled = s.canNext === false;

    var known = M.dur > 0;
    $('mProg').classList.toggle('hide', !known);
    $('mProg').parentNode.querySelector('.mtimes').classList.toggle('hide', !known);
    if (known) {
      $('mDur').textContent = fmt(M.dur);
      $('mSrc').hidden = true;
    } else {
      /* 播放器不上报时间轴（酷狗常见）：用来源行填位，别留一块空 */
      $('mSrc').hidden = false;
      $('mSrc').textContent = '正在播放 · ' + appName(s.app);
    }

    if (s.art) { artSrc = s.art; }
    if (s.track || !artSrc) setArt(artSrc, M.title);

    paintProgress();
  }

  function paintProgress() {
    if (!M.active || !M.dur) return;
    var pos = M.status === 'Playing' ? M.pos + (Date.now() - M.at) / 1000 : M.pos;
    pos = Math.max(0, Math.min(M.dur, pos));
    $('mFill').style.width = (pos / M.dur * 100).toFixed(2) + '%';
    $('mPos').textContent = fmt(pos);
  }
  setInterval(paintProgress, 250);

  if (bridge) {
    bridge.onMedia(function (s) { renderMedia(s); });
    bridge.media().then(function (s) { if (s) renderMedia(s); }).catch(function () {});
    bridge.onState(function (st) {
      /* 万一在登场动画还没结束时就展开了：摘掉 enter，别让它锁住胶囊的退出 transform */
      if (st === 'expanded') capEl.classList.remove('enter');
      /* 展开即视为看过通知：红点消失，列表留着等用户清 */
      if (st === 'expanded') markNotesRead();
      document.body.dataset.state = st;
    });
    if (bridge.onEnter) bridge.onEnter(function () {
      /* 首次：摘遮罩 + 播；之后（全屏恢复）：重播一遍 */
      if (booted) playEnter(); else startEnter();
    });
  }

  /* ================= 系统通知 =================
     壳侧读 Windows 通知库（QQ / 微信 / 邮件…），新通知推过来。
     胶囊末尾显示未读数；面板里列出最近 3 条。展开面板即视为已读（红点消失、列表保留），
     点「全部清除」才真的清空。有通知时通知区顶掉「进行中的工作」空态，避免两卡互挤。 */
  var noteItems = [];
  var noteUnread = 0;
  var noteInited = false;
  var notePopTimer = 0;
  var NOTE_APPS = [
    [/^qq(\.exe)?$/i, 'QQ'], [/tencent\.qq|qqmusic|qqtalk/i, 'QQ'],
    [/wechat|weixin|wxwork/i, '微信'],
    [/dingtalk|dingtalk/i, '钉钉'], [/feishu|lark/i, '飞书'],
    [/telegram/i, 'Telegram'], [/discord/i, 'Discord'], [/slack/i, 'Slack'],
    [/teams/i, 'Teams'], [/outlook|olk\.exe/i, 'Outlook'],
    [/microsoft\.windows\.explorer/i, '文件资源管理器'],
    [/powershell|windowsterminal|cmd\.exe/i, '终端'],
    [/workbuddy/i, 'WorkBuddy'],
    [/kugou/i, '酷狗音乐'], [/cloudmusic|netease/i, '网易云音乐'],
    [/chrome/i, 'Chrome'], [/msedge|edge/i, 'Edge'],
    [/weiyun|onedrive|dropbox/i, '云盘']
  ];
  function noteAppName(aumid) {
    var s = String(aumid || '');
    for (var i = 0; i < NOTE_APPS.length; i++) if (NOTE_APPS[i][0].test(s)) return NOTE_APPS[i][1];
    /* 兜底：AUMID 取包名末段（去掉 !入口 与 _哈希），实在认不出就写「应用」 */
    var base = s.split('!')[0].replace(/_[a-z0-9]{13}$/i, '');
    var seg = base.split(/[.\\/]/).filter(Boolean).pop() || '';
    if (!seg || /^[0-9a-f-]{16,}$/i.test(seg) || seg === s) return '应用';
    return seg.charAt(0).toUpperCase() + seg.slice(1);
  }
  function noteChar(name) {
    var s = String(name || '');
    if (!s) return '·';
    var m = s.match(/^[A-Za-z]/);
    return m ? s.charAt(0).toUpperCase() : s.charAt(0);
  }
  function noteTime(ms) {
    var n = Number(ms) || 0;
    if (!n) return '';
    var d = new Date(n), now = new Date();
    var same = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    if (same) return pad(d.getHours()) + ':' + pad(d.getMinutes());
    var y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    if (d.getFullYear() === y.getFullYear() && d.getMonth() === y.getMonth() && d.getDate() === y.getDate()) return '昨天';
    return (d.getMonth() + 1) + '/' + d.getDate();
  }
  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function paintCapNote() {
    var el = $('capNote');
    if (!el) return;
    el.hidden = noteUnread <= 0;
    if (noteUnread > 0) $('capNoteN').textContent = noteUnread > 9 ? '9+' : String(noteUnread);
    requestAnimationFrame(measureCap);
  }
  /* 展开即视为看过：红点清零，列表留着等用户清 */
  function markNotesRead() {
    if (!noteUnread) return;
    noteUnread = 0;
    paintCapNote();
  }
  /* 中段：通知与工作状态并存（有工作时通知列表压矮，给状态卡让位）；
     两者都没有时才回到空态 */
  function syncMid() {
    var hasNotes = !$('notes').hidden;
    var hasWork = !!curAct;
    var work = $('work'), none = $('workNone');
    work.hidden = !hasWork;
    none.hidden = hasWork || hasNotes;
    var mid = document.querySelector('.p-mid');
    if (mid) mid.dataset.compact = hasWork ? '1' : '0';
  }
  function renderNotes() {
    var box = $('notes'), list = $('notesList');
    if (!box || !list) return;
    if (!noteItems.length) {
      box.hidden = true;
      list.innerHTML = '';
      syncMid();
      paintCapNote();
      return;
    }
    box.hidden = false;
    var html = '';
    for (var i = 0; i < Math.min(3, noteItems.length); i++) {
      var n = noteItems[i] || {};
      var name = noteAppName(n.app);
      html += '<div class="note' + (n.fresh ? ' new' : '') + '">'
        + '<span class="note-app">' + escHtml(noteChar(name)) + '</span>'
        + '<div class="note-t"><div class="note-top">'
        + '<span class="note-appname">' + escHtml(name) + '</span>'
        + '<span class="note-time">' + escHtml(noteTime(n.at)) + '</span></div>'
        + '<div class="note-title">' + escHtml(n.title || '新通知') + '</div>'
        + (n.body ? '<div class="note-body">' + escHtml(n.body) + '</div>' : '')
        + '</div></div>';
    }
    list.innerHTML = html;
    /* fresh 只用来播一次入场动画，别让重绘时反复播 */
    setTimeout(function () { for (var j = 0; j < noteItems.length; j++) delete noteItems[j].fresh; }, 460);
    syncMid();
    paintCapNote();
  }
  function applyNotes(list) {
    list = Array.isArray(list) ? list : [];
    var prev = {};
    for (var i = 0; i < noteItems.length; i++) prev[String(noteItems[i] && noteItems[i].id)] = 1;
    var added = 0, fresh = {};
    if (noteInited) {
      for (var k = 0; k < list.length; k++) {
        var it = list[k];
        if (it && !prev[String(it.id)]) { added++; fresh[String(it.id)] = 1; }
      }
    }
    noteInited = true;
    noteItems = list.slice(0, 20);
    for (var m = 0; m < noteItems.length; m++) {
      if (noteItems[m] && fresh[String(noteItems[m].id)]) noteItems[m].fresh = 1;
    }
    if (added && document.body.dataset.state !== 'expanded') {
      noteUnread += added;
      var el = $('capNote');
      if (el && !el.hidden) {
        el.classList.remove('pop');
        void el.offsetWidth;
        el.classList.add('pop');
        clearTimeout(notePopTimer);
        notePopTimer = setTimeout(function () { el.classList.remove('pop'); }, 480);
      }
    }
    renderNotes();
  }
  if (bridge && bridge.onNotify) {
    bridge.onNotify(applyNotes);
    if (bridge.notify) {
      bridge.notify().then(function (r) {
        if (r && Array.isArray(r.items)) applyNotes(r.items); else renderNotes();
      }).catch(function () { renderNotes(); });
    } else {
      renderNotes();
    }
    var notesClearBtn = $('notesClear');
    if (notesClearBtn) {
      notesClearBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (!bridge.notifyClear) return;
        bridge.notifyClear().then(function () {
          noteItems = [];
          noteUnread = 0;
          noteInited = true;
          renderNotes();
        }).catch(function () {});
      });
    }
  }

  /* ================= 工作状态 =================
     主窗口换视图（打开工具 / 切页）或 AI 忙碌态变化时，壳把状态推过来。
     胶囊上是一颗绿点 + 短名；面板里是完整的状态卡。 */
  var ACT_KICKER = { page: '正在查看', tool: '正在使用', task: '进行中' };
  var ACT_ICONS = {
    tool: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="7" height="7" rx="1.6"/><rect x="13" y="4" width="7" height="7" rx="1.6"/><rect x="4" y="13" width="7" height="7" rx="1.6"/><path d="M16.5 13.5v6M13.5 16.5h6"/></svg>',
    page: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="2.4"/><path d="M3.5 9h17M8 4.5V9"/></svg>',
    task: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>'
  };
  var curAct = null;
  var lastActKey = '';
  var actSwapTimer = 0;
  var capAnimTimer = 0;
  var capByeTimer = 0;
  function clipName(s, n) {
    s = String(s || '');
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }
  /* 重播一个动画类：先摘掉再强制回流，连续加同一个类也能重新播 */
  function replay(el, cls) {
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }
  function renderActivity(a) {
    curAct = (a && a.kind && a.kind !== 'idle' && a.name) ? a : null;
    var work = $('work'), none = $('workNone'), capW = $('capWork');
    if (curAct) {
      var key = curAct.kind + '\u0001' + curAct.name;
      var appeared = capW.hidden;        /* 之前没显示 → 这次是徽标登场，用 pop */
      clearTimeout(capByeTimer);
      capW.classList.remove('bye');
      $('workIc').innerHTML = ACT_ICONS[curAct.kind] || ACT_ICONS.tool;
      $('workKicker').textContent = ACT_KICKER[curAct.kind] || '正在进行';
      $('workName').textContent = clipName(curAct.name, 18);
      $('workName').setAttribute('aria-label', curAct.name);
      $('workSub').hidden = !curAct.extra;
      if (curAct.extra) $('workSub').textContent = clipName(curAct.extra, 12);
      work.hidden = false;
      none.hidden = true;
      capW.hidden = false;
      capW.classList.toggle('live', curAct.kind === 'task');
      $('capWorkT').textContent = clipName(curAct.name, 9);
      $('capWorkT').setAttribute('aria-label', curAct.name);
      if (key !== lastActKey) {
        work.dataset.swap = '1';
        clearTimeout(actSwapTimer);
        actSwapTimer = setTimeout(function () { delete work.dataset.swap; }, 380);
        /* 胶囊徽标：登场弹出（pop），换名上浮淡入（swap），播完摘类别占着 animation */
        if (appeared) replay(capW, 'pop'); else replay(capW, 'swap');
        clearTimeout(capAnimTimer);
        capAnimTimer = setTimeout(function () { capW.classList.remove('swap', 'pop'); }, 460);
      }
      lastActKey = key;
      syncMid();
    } else {
      work.hidden = true;
      none.hidden = false;
      lastActKey = '';
      syncMid();
      /* 胶囊徽标退场：先播 160ms 淡出再真隐藏，别「啪」地消失 */
      if (!capW.hidden) {
        replay(capW, 'bye');
        clearTimeout(capAnimTimer);
        capByeTimer = setTimeout(function () {
          capW.hidden = true;
          capW.classList.remove('bye');
          requestAnimationFrame(measureCap);
        }, 170);
      } else {
        capW.hidden = true;
      }
    }
    requestAnimationFrame(measureCap);
  }
  if (bridge && bridge.onActivity) bridge.onActivity(renderActivity);
  if (bridge && bridge.get) {
    bridge.get().then(function (r) {
      if (!r) return;
      if (r.activity) renderActivity(r.activity);
      if (r.dock) applyDock(r.dock);
      if (typeof r.clockSeconds === 'boolean') showSec = r.clockSeconds;
      if (typeof r.offset === 'number') offset = r.offset;
      clock();
      requestAnimationFrame(measureCap);
    }).catch(function () {});
  }

  /* ================= 交互 ================= */
  function cmd(a) {
    if (!bridge) return;
    window.__lastCmd = { a: a, t: Date.now() };      /* E2E 诊断：确认点击真的走到了指令层 */
    if (a === 'toggle') {
      /* 乐观切换：点下去图标立刻变，主进程下一帧会推真实状态覆盖 */
      $('btnPlay').classList.toggle('playing', M.status !== 'Playing');
      M.status = M.status === 'Playing' ? 'Paused' : 'Playing';
      M.at = Date.now();
    }
    bridge.cmd(a);
  }
  $('btnPlay').addEventListener('click', function (e) { e.stopPropagation(); cmd('toggle'); });
  $('btnPrev').addEventListener('click', function (e) { e.stopPropagation(); cmd('prev'); });
  $('btnNext').addEventListener('click', function (e) { e.stopPropagation(); cmd('next'); });
  $('pWx').addEventListener('click', function () { if (bridge) bridge.openMain(); });

  /* 拖动（照岛仔的手感整套重做）：
     · 原地按住 120ms「拿起」：胶囊提起放大（沿停靠边 +8%、厚度方向 +14%），不必先移动；
     · 移动 >3px 才真正进入拖动，避免点一下就抖走位置；
     · 位移报给壳（壳用弹簧跟手拖尾，不直接贴光标），壳负责磁吸与换边；
     · 光标速度换成「果冻拉伸」：越快沿运动方向拉得越长（最多 22%），厚度收窄；
     · 壳吸附居中时推 lock 事件：吸住瞬间轻沉 + 绿描边 + 一道扫光，停住时绿边呼吸。 */
  var drag = null;
  var panelEl = $('panel');
  var pClock = $('pClock');
  var NO_DRAG = '.cbtn, .p-wx, .foot, .mprog, .notes-head button';
  var holdTimer = 0;
  var stretch = 0, stretchTarget = 0, stretchRaf = 0;
  var lastMove = { t: 0, dx: 0, dy: 0 };
  var lockFadeTimer = 0;
  function dockAxis() { return dock === 'top' ? 'x' : 'y'; }
  function stretchFrame() {
    var holding = drag && !drag.moved && document.body.dataset.hold === '1';
    var active = (drag && drag.moved) || holding;
    /* 光标停下后拉伸目标快速归零；拉伸量以 ~12/s 的速率逼近目标（岛仔弹簧的近似） */
    if (performance.now() - lastMove.t > 90) stretchTarget = 0;
    stretch += (stretchTarget - stretch) * 0.2;
    if (stretch < 0.003 && stretchTarget === 0 && !active) {
      stretch = 0;
      capEl.style.removeProperty('--sx');
      capEl.style.removeProperty('--sy');
      stretchRaf = 0;
      return;
    }
    var lift = active ? 1 : 0;
    var along = 1 + 0.08 * lift + stretch;
    var across = 1 + 0.14 * lift - 0.5 * stretch;
    if (dockAxis() === 'x') {
      capEl.style.setProperty('--sx', along.toFixed(4));
      capEl.style.setProperty('--sy', across.toFixed(4));
    } else {
      capEl.style.setProperty('--sx', across.toFixed(4));
      capEl.style.setProperty('--sy', along.toFixed(4));
    }
    stretchRaf = requestAnimationFrame(stretchFrame);
  }
  function startStretchLoop() {
    if (!stretchRaf) stretchRaf = requestAnimationFrame(stretchFrame);
  }
  function applyLock(o) {
    var locked = !!(o && o.locked);
    if (locked) {
      capEl.dataset.locked = '1';
      if (!o.silent) {
        /* 吸住瞬间：轻沉一下（像卡进槽位）+ 一道亮光从中心沿胶囊向两端扫开 */
        capEl.classList.remove('lockin', 'sweep');
        void capEl.offsetWidth;
        capEl.classList.add('lockin', 'sweep');
        setTimeout(function () { capEl.classList.remove('sweep'); }, 620);
        setTimeout(function () { capEl.classList.remove('lockin'); }, 340);
      }
    } else {
      delete capEl.dataset.locked;
      capEl.classList.remove('sweep', 'lockin');
    }
  }
  if (bridge && bridge.onLock) bridge.onLock(applyLock);
  if (bridge && bridge.onCfg) bridge.onCfg(function (c) {
    if (c && c.dock) applyDock(c.dock);
    if (c && typeof c.clockSeconds === 'boolean' && c.clockSeconds !== showSec) {
      showSec = c.clockSeconds;
      slowClock = false;
      clockTimerReset();
      clock();
    }
  });
  /* 拖动入口：胶囊（收起态）和面板（展开态）都要挂。
     两者是兄弟节点，只挂面板的话收起态根本收不到按下 —— 实机踩中「拖不动」。 */
  function beginDrag(e) {
    if (e.button !== 0 || drag) return;
    if (e.target.closest && e.target.closest(NO_DRAG)) return;
    drag = { sx: e.screenX, sy: e.screenY, moved: false, dx: 0, dy: 0 };
    lastMove = { t: 0, dx: 0, dy: 0 };
    clearTimeout(holdTimer);
    holdTimer = setTimeout(function () {
      /* 原地按住也算拿起：先给反馈再移动（岛仔 LIFT_HOLD） */
      if (drag && !drag.moved) {
        document.body.dataset.hold = '1';
        startStretchLoop();
      }
    }, 120);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
  }
  panelEl.addEventListener('pointerdown', beginDrag);
  capEl.addEventListener('pointerdown', beginDrag);
  /* move / up 挂 document 捕获层，不能挂面板：拖动态下面板被 CSS 设成
     pointer-events:none，松手的 pointerup 会落到面板外的元素上，面板自己的
     监听永远收不到 → dragEnd 丢失 → 主进程卡死在拖动态（E2E 实测踩中）。 */
  document.addEventListener('pointermove', function (e) {
    if (!drag) return;
    var dx = e.screenX - drag.sx;
    var dy = e.screenY - drag.sy;
    if (!drag.moved) {
      if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
      drag.moved = true;
      clearTimeout(holdTimer);
      delete document.body.dataset.hold;
      document.body.dataset.drag = '1';
      startStretchLoop();
      if (bridge && bridge.dragStart) bridge.dragStart();
    }
    drag.dx = dx; drag.dy = dy;
    var now = performance.now();
    if (lastMove.t) {
      var dt = now - lastMove.t;
      if (dt > 4) {
        var v = dockAxis() === 'x' ? (dx - lastMove.dx) : (dy - lastMove.dy);
        stretchTarget = Math.min(1, Math.abs(v) / dt * 1000 / 1400) * 0.22;
      }
    }
    lastMove = { t: now, dx: dx, dy: dy };
    if (bridge && bridge.dragMove) bridge.dragMove(dx, dy);
  }, true);
  function endDrag(e) {
    if (!drag) return;
    var d0 = drag;
    drag = null;
    clearTimeout(holdTimer);
    delete document.body.dataset.hold;
    delete document.body.dataset.drag;
    try { panelEl.releasePointerCapture(e && e.pointerId); } catch (_) {}
    try { capEl.releasePointerCapture(e && e.pointerId); } catch (_) {}
    if (!d0.moved) {
      /* 没拖动 = 单击：点时间区打开工作台（保持原有手感） */
      if (pClock && e && e.target && e.target.closest && e.target.closest('#pClock') && bridge) bridge.openMain();
      return;
    }
    window.__lastDrag = { dx: d0.dx, dy: d0.dy };
    if (bridge && bridge.dragEnd) bridge.dragEnd();
    readPos();
    stretchTarget = 0;
    /* 松手后绿边停留一会再淡出，让人确认落在了中间（岛仔 center_guide 余韵） */
    clearTimeout(lockFadeTimer);
    lockFadeTimer = setTimeout(function () {
      if (!drag) delete capEl.dataset.locked;
    }, 900);
  }
  document.addEventListener('pointerup', endDrag, true);
  document.addEventListener('pointercancel', endDrag, true);

  /* 智能隐藏：主进程判定「被前台窗口遮住 / 全屏」后切细线，光标靠近再还原 */
  if (bridge && bridge.onMin) {
    bridge.onMin(function (min) { setMin(!!min); });
  }
  function setMin(min) {
    document.body.dataset.min = min ? '1' : '0';
    if (min) {
      /* 细线态的 margin 由 CSS 接管：清掉自适应的内联 margin，别把线挤偏 */
      capEl.style.marginLeft = '';
      capEl.style.marginTop = '';
    } else {
      requestAnimationFrame(measureCap);
    }
  }

  /* 停靠边：壳在配置变化（设置页切换 / 拖动中换边）时推送 */
  function applyDock(d) {
    if (d !== 'left' && d !== 'right') d = 'top';
    if (dock === d) return;
    dock = d;
    document.body.dataset.dock = d;
    clock();
    requestAnimationFrame(measureCap);
  }

  document.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  /* 点击计数：E2E 用来确认「无焦点窗口也能收到真实鼠标点击」 */
  document.addEventListener('mousedown', function () {
    window.__islandClicks = (window.__islandClicks || 0) + 1;
  }, true);

  /* E2E 钩子：只读状态 + 手动切态（正式运行时主进程也会发同样的消息） */
  window.__island = {
    state: function () {
      return {
        state: document.body.dataset.state,
        theme: document.documentElement.dataset.theme,
        dock: dock,
        media: M.active ? { title: M.title, artist: M.artist, status: M.status, dur: M.dur } : null,
        work: curAct ? { kind: curAct.kind, name: curAct.name, extra: curAct.extra || '' } : null,
        workVisible: !$('work').hidden,
        capWorkVisible: !$('capWork').hidden,
        wx: $('pWxT').textContent,
        days: document.querySelectorAll('.fc-day').length,
        notes: noteItems.length,
        noteUnread: noteUnread,
        notesVisible: !$('notes').hidden,
        noteTitles: Array.prototype.slice.call(document.querySelectorAll('.note-title')).map(function (e) { return e.textContent; }),
        capNoteVisible: !$('capNote').hidden,
        art: !!document.querySelector('#art img'),
        /* offsetWidth 是布局尺寸；getBoundingClientRect 会把收起态的 scale 算进去 */
        capW: Math.round(dock === 'top' ? $('cap').offsetWidth : $('cap').offsetHeight),
        capWpx: Math.round($('cap').offsetWidth),
        capHpx: Math.round($('cap').offsetHeight),
        panelW: Math.round($('panel').offsetWidth),
        panelH: Math.round($('panel').offsetHeight),
        offset: offset,
        min: document.body.dataset.min === '1',
        dragging: document.body.dataset.drag === '1',
        holding: document.body.dataset.hold === '1',
        locked: capEl.dataset.locked === '1',
        capTime: $('capTime').textContent,
        clockSeconds: showSec
      };
    },
    setState: function (st) {
      if (st === 'expanded') markNotesRead();   /* E2E 直接切态也要走同一条已读逻辑 */
      document.body.dataset.state = st;
    },
    setDock: function (d) { applyDock(d); }
  };
})();
