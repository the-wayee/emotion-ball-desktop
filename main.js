/* ============================================================
 * main.js —— 主进程
 *
 * 桌宠三件套：
 *   1. 透明无边框置顶窗；默认鼠标穿透，只有指针压到球身上才吃事件
 *   2. 主进程轮询全局光标 → 驱动注视 / 拖拽（不依赖渲染进程的 mousemove，
 *      所以快速拖拽时指针甩出窗口也不会掉帧）
 *   3. 托盘菜单 + 本地 HTTP 接口，两条路都通到 handleAIMessage
 * ============================================================ */
'use strict';

const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const http = require('http');

const WIN_W = 320;
const WIN_H = 300;
const GAZE_RANGE = 320;   /* 光标离球心多远算满幅注视（px） */
const POLL_MS = 24;       /* 约 40Hz 轮询光标 */
const API_PORT = 17817;

let win = null;
let tray = null;
let apiServer = null;
let pollTimer = null;

let clickThrough = true;                 /* 当前是否处于穿透态 */
let drag = null;                         /* { m0:{x,y}, w0:{x,y} } */
let emotions = [];                       /* 渲染进程上报的表情清单 */
let groups = [];
let shape = 'blob';
let sketch = false;
let lastGaze = { x: 9, y: 9 };           /* 哨兵值，保证首帧一定下发 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const send = (ch, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(ch, payload);
};

/* ---------------- 窗口 ---------------- */

function createWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: wa.x + wa.width - WIN_W - 40,
    y: wa.y + wa.height - WIN_H - 40,
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    fullscreenable: false,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  /* screen-saver 层级 + 跨空间可见：全屏应用之上也能浮着 */
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  /* 默认穿透，但仍转发 mousemove —— 渲染进程靠它做球身命中检测 */
  win.setIgnoreMouseEvents(true, { forwardMouseMove: true });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
}

/* ---------------- 光标轮询：注视 + 拖拽 ---------------- */

function startPoll() {
  pollTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const p = screen.getCursorScreenPoint();

    if (drag) {
      win.setPosition(
        Math.round(drag.w0.x + p.x - drag.m0.x),
        Math.round(drag.w0.y + p.y - drag.m0.y)
      );
      return;                       /* 拖拽期间不动注视，避免眼睛乱晃 */
    }

    const b = win.getBounds();
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    const nx = clamp((p.x - cx) / GAZE_RANGE, -1, 1);
    const ny = clamp((p.y - cy) / GAZE_RANGE, -1, 1);
    /* 抖动阈值：静止时不发 IPC */
    if (Math.abs(nx - lastGaze.x) < 0.004 && Math.abs(ny - lastGaze.y) < 0.004) return;
    lastGaze = { x: nx, y: ny };
    send('gaze', lastGaze);
  }, POLL_MS);
}

/* ---------------- 穿透切换 ---------------- */

function setClickThrough(on) {
  if (!win || win.isDestroyed() || clickThrough === on) return;
  clickThrough = on;
  if (on) win.setIgnoreMouseEvents(true, { forwardMouseMove: true });
  else win.setIgnoreMouseEvents(false);
}

/* ---------------- 菜单 ---------------- */

function emotionSubmenus() {
  return groups
    .map(g => ({
      label: g.name,
      submenu: emotions
        .filter(e => e.group === g.key)
        .map(e => ({
          label: `${e.id}  ${e.name}`,
          click: () => send('emotion', { emotionId: e.id })
        }))
    }))
    .filter(m => m.submenu.length);
}

function buildTray() {
  if (tray) tray.destroy();
  const img = nativeImage
    .createFromPath(path.join(__dirname, 'assets', 'tray.png'))
    .resize({ width: 18, height: 18 });
  img.setTemplateImage(true);
  tray = new Tray(img);
  tray.setToolTip('Emotion Ball 桌宠');
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '表情', submenu: emotionSubmenus() },
    { type: 'separator' },
    {
      label: '形态',
      submenu: [
        { id: 'blob', label: '圆胖 blob' },
        { id: 'wedge', label: '三角 wedge' },
        { id: 'gem', label: '菱形 gem' }
      ].map(s => ({
        label: s.label,
        type: 'radio',
        checked: shape === s.id,
        click: () => { shape = s.id; send('shape', s.id); refreshTrayMenu(); }
      }))
    },
    {
      label: '线稿模式',
      type: 'checkbox',
      checked: sketch,
      click: () => { sketch = !sketch; send('sketch', sketch); refreshTrayMenu(); }
    },
    { type: 'separator' },
    { label: '回到右下角', click: resetPosition },
    { label: `HTTP 接口 :${API_PORT}`, enabled: false },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ]));
}

function resetPosition() {
  if (!win || win.isDestroyed()) return;
  const wa = screen.getPrimaryDisplay().workArea;
  win.setPosition(wa.x + wa.width - WIN_W - 40, wa.y + wa.height - WIN_H - 40);
}

/* ---------------- 本地 HTTP 接口 ----------------
 * 只绑 127.0.0.1。POST 的 body 原样转给 handleAIMessage ——
 * 格式容错本来就是引擎自己的职责，这里不做二次解析 */

function startApi() {
  apiServer = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    if (req.method === 'GET' && req.url === '/emotions') {
      res.end(JSON.stringify(emotions));
      return;
    }
    if (req.method === 'POST' && req.url === '/emotion') {
      let body = '';
      req.on('data', c => {
        body += c;
        if (body.length > 8192) req.destroy();
      });
      req.on('end', () => {
        send('emotion', body);
        res.end('{"ok":true}');
      });
      return;
    }
    res.statusCode = 404;
    res.end('{"ok":false,"hint":"GET /emotions | POST /emotion"}');
  });

  apiServer.on('error', e => console.error('[api] 启动失败：', e.message));
  apiServer.listen(API_PORT, '127.0.0.1', () => {
    console.log(`[api] http://127.0.0.1:${API_PORT}`);
  });
}

/* ---------------- IPC ---------------- */

ipcMain.on('ready', (_e, payload) => {
  emotions = payload.emotions || [];
  groups = payload.groups || [];
  buildTray();
});

/* 渲染进程命中检测的结果：指针是否压在球身上 */
ipcMain.on('hover', (_e, on) => {
  if (!drag) setClickThrough(!on);
});

ipcMain.on('drag:start', () => {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  drag = { m0: screen.getCursorScreenPoint(), w0: { x: b.x, y: b.y } };
});

ipcMain.on('drag:end', () => { drag = null; });

ipcMain.on('menu', () => {
  Menu.buildFromTemplate([
    ...emotionSubmenus(),
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ]).popup({ window: win });
});

/* ---------------- 生命周期 ---------------- */

app.whenReady().then(() => {
  if (app.dock) app.dock.hide();       /* macOS：不占 Dock，纯托盘应用 */
  createWindow();
  startPoll();
  startApi();
});

app.on('window-all-closed', () => app.quit());

app.on('before-quit', () => {
  if (pollTimer) clearInterval(pollTimer);
  if (apiServer) apiServer.close();
});
