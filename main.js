/* ============================================================
 * main.js —— 主进程
 *
 * 桌宠四件套：
 *   1. 透明无边框置顶窗；默认鼠标穿透，只有指针压到球身上才吃事件
 *   2. 主进程轮询全局光标 → 驱动注视 / 拖拽（不依赖渲染进程的 mousemove，
 *      所以快速拖拽时指针甩出窗口也不会掉帧）
 *   3. 行为调度：一弹一弹的散步 + 自发小动作 + 活跃/发呆/睡眠三段生命周期
 *   4. 托盘菜单 + 本地 HTTP 接口，两条路都通到 handleAIMessage
 * ============================================================ */
'use strict';

const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const http = require('http');
const REACT = require('./reactions');
const activity = require('./activity');
const deepseek = require('./deepseek');

const WIN_W = 280;
const WIN_H = 240;
const GAZE_RANGE = 300;   /* 光标离球心多远算满幅注视（px） */
const POLL_MS = 16;       /* ~60Hz：物理积分要比注视更细 */
const API_PORT = 17817;

/* ---- 跳跃物理 ----
 * 不再是「N 段等高等距的弧」，而是真的积分：蹬地给一个初速度，
 * 之后靠重力落体、按弹性系数衰减，越弹越低直到停住。 */
const GRAV = 2600;        /* 重力 px/s² */
const REST = 0.58;        /* 弹性系数：每次落地保留的垂直速度比 */
const VX_DAMP = 0.86;     /* 每次落地的水平衰减 */
const LAUNCH_V = 420;     /* 蹬地垂直初速 → 首跳约 34px 高 */
const LAUNCH_VX = 110;    /* 蹬地水平初速 */
const STOP_V = 70;        /* 反弹速度低于此值就算停住 */
const CROUCH_MS = 150;    /* 蹬地前的下蹲蓄力 */

/* ---- 生命周期分段（距上次交互的时长）---- */
const ACTIVE_MS = 45000;    /* 45s 内算活跃期，动作频繁 */
const SLEEP_MS = 150000;    /* 150s 后睡觉 */

const AI_TICK_MS = 20000;   /* 多久查一次「你在干嘛」（查本身很便宜，45ms）*/
const AWAY_MS = 5 * 60 * 1000;  /* 光标这么久没动 = 人不在，别自言自语 */

const SULK_AT = 8;          /* 连击到第几下彻底不理人 */
const SULK_MS = 10000;      /* 闹脾气时长：期间点击 / 悬停一律无响应 */

const IDLE_ID = '02';       /* 待机 */
const SLEEP_ID = '00';      /* 睡眠 */
const WALK_ID = '50';       /* 散步（自定义段，渲染进程运行时注册） */

let win = null;
let tray = null;
let apiServer = null;
let pollTimer = null;
let lastPoll = 0;

let clickThrough = true;                 /* 当前是否处于穿透态 */
let drag = null;                         /* { m0:{x,y}, w0:{x,y} } */
let emotions = [];                       /* 渲染进程上报的表情清单 */
let groups = [];
let shape = 'blob';
let sketch = false;
let lastGaze = { x: 9, y: 9 };           /* 哨兵值，保证首帧一定下发 */

/* ---- 行为调度状态 ---- */
let autoBehave = true;
let phase = 'active';                    /* active | drift | sleep */
let lastInteract = Date.now();
let behaveNext = 0;                      /* 下次自发行为的时刻 */
let tempBackAt = 0;                      /* 临时表情回落到待机的时刻 */
let curEmotion = IDLE_ID;
let walk = null;                         /* { dir, t0, hops, x0, y0 } */

/* ---- 交互反应状态 ---- */
let clickN = 0;                          /* 连击计数 */
let lastClickAt = 0;
let hoverNext = 0;                       /* 悬停反应冷却 */
let sulkUntil = 0;                       /* 闹脾气到期时刻，之前一切交互无响应 */

/* ---- AI 评论 ---- */
let aiOn = true;
let aiBusy = false;
let aiTimer = null;
let lastComment = 0;
let lastActKey = null;                   /* 上次快照的活动分类，变了就值得说一句 */
let recentSaid = [];                     /* 最近说过的话，塞进提示里避免复读 */
let lastCursorMove = Date.now();
let lastCursorPt = { x: -1, y: -1 };
const lastPick = new Map();              /* 每个池上次抽中的下标，避免连续重复 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const rand = (a, b) => a + Math.random() * (b - a);
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

/* ---------------- 散步（物理版）----------------
 * 位移做在窗口层而不是 SVG 层：引擎的 ball.bounce() 是球在窗口内原地弹，
 * 两者叠加会变成双重运动，所以散步期间不调 bounce()。
 *
 * 一次「散步」= 若干次蹬地。每次蹬地：
 *   下蹲蓄力 → 起跳 → 落体 → 落地(速度 ×REST) → 越弹越低 → 停住 → 歇一下 → 再蹬
 * 压缩形变不在这里算，主进程只把落地冲量发给渲染进程，
 * 由那边的弹簧驱动 CSS 形变（见 renderer/pet.js）。 */

function workAreaOf(b) {
  return screen.getDisplayNearestPoint({
    x: Math.round(b.x + b.width / 2),
    y: Math.round(b.y + b.height / 2)
  }).workArea;
}

function startWalk(dir, launches) {
  if (!win || win.isDestroyed() || drag) return;
  /* 已经在散步中：先落地复位再重来。否则下面的 baseY 会取到半空中的
   * 窗口位置，地面高度会随每次打断一路往上漂。 */
  if (walk) {
    win.setPosition(Math.round(walk.x), Math.round(walk.baseY));
    walk = null;
  }
  const b = win.getBounds();
  const wa = workAreaOf(b);

  /* 朝目标方向贴边了就掉头；两边都没空间就放弃 */
  const roomOf = d => (d > 0 ? wa.x + wa.width - (b.x + b.width) : b.x - wa.x);
  if (roomOf(dir) < 60) dir = -dir;
  if (roomOf(dir) < 60) return;

  walk = {
    dir,
    left: Math.max(1, launches || 3),
    stage: 'crouch',
    tStage: Date.now(),
    restMs: 0,
    h: 0, vh: 0, vx: 0,
    x: b.x,
    baseY: b.y
  };
  tempBackAt = 0;                 /* 作废排队中的表情回落，见 tickBehaviour */
  curEmotion = WALK_ID;
  send('walk', { active: true, dir });
  send('phys', { type: 'crouch' });
}

function stepWalk(now, dt) {
  const wa = workAreaOf(win.getBounds());

  if (walk.stage === 'crouch') {
    /* 蓄力期间窗口不动，形变由渲染进程的弹簧做 */
    if (now - walk.tStage >= CROUCH_MS) {
      walk.stage = 'air';
      walk.vh = LAUNCH_V * rand(0.88, 1.12);
      walk.vx = walk.dir * LAUNCH_VX * rand(0.85, 1.15);
      send('phys', { type: 'launch', v: walk.vh });
    }
    return;
  }

  if (walk.stage === 'rest') {
    if (now - walk.tStage >= walk.restMs) {
      if (walk.left <= 0) { stopWalk(); return; }
      walk.stage = 'crouch';
      walk.tStage = now;
      send('phys', { type: 'crouch' });
    }
    return;
  }

  /* ---- 空中：显式欧拉积分 ---- */
  walk.vh -= GRAV * dt;
  walk.h += walk.vh * dt;
  walk.x += walk.vx * dt;

  /* 撞到工作区左右边界就反向弹开 */
  const maxX = wa.x + wa.width - WIN_W;
  if (walk.x < wa.x) { walk.x = wa.x; walk.vx = -walk.vx; walk.dir = 1; }
  else if (walk.x > maxX) { walk.x = maxX; walk.vx = -walk.vx; walk.dir = -1; }

  /* ---- 落地 ---- */
  if (walk.h <= 0 && walk.vh < 0) {
    const impact = -walk.vh;
    walk.h = 0;
    walk.vh = impact * REST;
    walk.vx *= VX_DAMP;
    send('phys', { type: 'land', impact: impact });
    if (walk.vh < STOP_V) {
      walk.vh = 0;
      walk.left -= 1;
      walk.stage = 'rest';
      walk.tStage = now;
      walk.restMs = rand(280, 700);   /* 歇一下再蹬，避免连续跳得像弹力球 */
    }
  }

  win.setPosition(Math.round(walk.x), Math.round(walk.baseY - walk.h));
}

function stopWalk() {
  if (!walk) return;
  /* 落地：把纵坐标收回基线，避免停在半空 */
  if (win && !win.isDestroyed()) {
    win.setPosition(Math.round(walk.x), Math.round(walk.baseY));
  }
  walk = null;
  send('walk', { active: false });
  send('phys', { type: 'settle' });
  setEmotion(phase === 'sleep' ? SLEEP_ID : IDLE_ID);
}

/* ---------------- 行为调度 ----------------
 * 引擎自带的 idle 策略在创建时就关掉了（renderer 传 idle:false）——
 * 否则 _checkIdle 每帧都会把非 '02'/'00' 的表情强行拉回待机，
 * 这里设的"好奇""散步"活不过一帧。生命周期由这一套独占。 */

function setEmotion(id, holdMs, tips) {
  curEmotion = id;
  /* 带 tips 时走完整 AI 协议格式，渲染进程那边会转成气泡 */
  send('emotion', tips ? { emotionId: id, tips: tips } : { emotionId: id, auto: true });
  tempBackAt = holdMs ? Date.now() + holdMs : 0;
}

/* ---------------- 交互反应 ----------------
 * 罐头台词和以后大模型生成的台词走同一条管道：
 * 挑一条 → setEmotion(id, hold, text) → {emotionId, tips} → handleAIMessage */

function pick(pool, key) {
  if (!pool || !pool.length) return null;
  if (pool.length === 1) return pool[0];
  const last = lastPick.get(key);
  let i;
  do { i = Math.floor(Math.random() * pool.length); } while (i === last);
  lastPick.set(key, i);
  return pool[i];
}

/** 台词长度决定停留时长，和渲染进程的气泡计时用同一个公式 */
function holdFor(text) {
  return text ? Math.min(7000, Math.max(2400, text.length * 240)) : 2200;
}

function say(r) {
  if (!r) return;
  const hold = holdFor(r.text);
  setEmotion(r.id, hold, r.text || null);
  /* 说话期间别让自发行为插队 */
  behaveNext = Date.now() + hold + rand(4000, 9000);
}

function clearSulk() { sulkUntil = 0; clickN = 0; }

function react(kind) {
  const now = Date.now();
  const wasSleeping = phase === 'sleep';

  /* 闹脾气期间是真的不理人：点击、悬停、双击一概不响应。
   * 具体长什么样取决于抽中哪条 sulk：'21'/'38' 会眨眼，看着是在赌气；
   * '41' 停止终止本身就是 blinkMs:null + gaze:false + settle:'hold'，
   * 闭眼定格连鼠标都不看 —— 那是"装死"该有的样子，不是卡住。 */
  if (now < sulkUntil) return;

  if (kind === 'hover') {
    /* 冷却 + 不打断正在说的话：鼠标扫来扫去不该让它一直叨叨 */
    if (now < hoverNext) return;
    if (tempBackAt && now < tempBackAt) return;
    hoverNext = now + rand(7000, 12000);
    wake();
    stopWalk();
    say(wasSleeping ? pick(REACT.wakeUp, 'wake') : pick(REACT.hover, 'hover'));
    return;
  }

  wake();
  stopWalk();

  if (kind === 'delight') { say(pick(REACT.delight, 'delight')); return; }

  /* 点击：6s 内的连击累计，越戳越不耐烦 */
  if (now - lastClickAt > 6000) clickN = 0;
  clickN += 1;
  lastClickAt = now;
  hoverNext = now + 6000;                /* 刚聊过就别再触发悬停反应 */

  if (wasSleeping) { say(pick(REACT.wakeUp, 'wake')); return; }

  /* 戳满 SULK_AT 下：撂一句狠话，然后进入冷却彻底不理人。
   * 表情按 SULK_MS 保持 —— tempBackAt 到期正好就是气消的时刻，
   * 由 tickBehaviour 接手说一句 calmDown 收尾 */
  if (clickN >= SULK_AT) {
    const r = pick(REACT.sulk, 'sulk');
    sulkUntil = now + SULK_MS;
    setEmotion(r.id, SULK_MS, r.text || null);
    behaveNext = sulkUntil + rand(2000, 5000);
    return;
  }

  const tier = clickN <= 2 ? 'calm' : clickN <= 5 ? 'bored' : 'angry';
  say(pick(REACT.click[tier], 'click:' + tier));
}

function pickBehaviour(now) {
  const r = Math.random();
  /* 活跃期动作密一点，发呆期主要就是溜达 */
  if (phase === 'active') {
    if (r < 0.42) startWalk(Math.random() < 0.5 ? -1 : 1, Math.round(rand(2, 5)));
    else if (r < 0.62) setEmotion('03', 4200);        /* 好奇：东张西望 */
    else if (r < 0.78) setEmotion('04', 6000);        /* 发呆 */
    else if (r < 0.92) send('act', 'spin');           /* 伸个懒腰甩彩带 */
    else setEmotion('10', 3000);                      /* 开心 */
    behaveNext = now + rand(14000, 26000);
  } else {
    if (r < 0.62) startWalk(Math.random() < 0.5 ? -1 : 1, Math.round(rand(3, 7)));
    else if (r < 0.82) setEmotion('04', 6000);
    else send('act', 'spin');
    behaveNext = now + rand(26000, 48000);
  }
}

function tickBehaviour(now) {
  if (drag) return;

  /* 三段生命周期切换 */
  const idleFor = now - lastInteract;
  const want = idleFor > SLEEP_MS ? 'sleep' : idleFor > ACTIVE_MS ? 'drift' : 'active';
  if (want !== phase) {
    phase = want;
    if (phase === 'sleep') { stopWalk(); setEmotion(SLEEP_ID); }
    else if (phase === 'drift' && curEmotion === SLEEP_ID) setEmotion(IDLE_ID);
    behaveNext = now + rand(6000, 14000);
  }

  if (phase === 'sleep' || !autoBehave) return;

  /* 散步期间不碰表情，也不排下一个行为 ——
   * 这个 return 必须在回落检查之前：否则散步前排队的临时表情回落
   * 会在半路触发，把「散步」覆盖成「待机」 */
  if (walk) return;
  /* 临时表情到点回落。闹脾气的 hold 时长就是 SULK_MS，
   * 所以这里到期正好是气消的时刻，接一句 calmDown 收尾 */
  if (tempBackAt && now >= tempBackAt) {
    tempBackAt = 0;
    if (sulkUntil && now >= sulkUntil) {
      clearSulk();
      say(pick(REACT.calmDown, 'calmDown'));
    } else {
      setEmotion(IDLE_ID);
    }
  }
  if (now < sulkUntil) return;              /* 闹脾气期间不自发散步 / 换表情 */
  if (now >= behaveNext) pickBehaviour(now);
}

function wake(silent) {
  lastInteract = Date.now();
  if (phase === 'sleep') {
    phase = 'active';
    /* silent：AI 主动开口时用 —— 播 '01' 唤醒序列会马上被台词表情盖掉，
     * 白闪一下反而难看 */
    if (!silent) setEmotion('01');
    behaveNext = Date.now() + rand(8000, 16000);
  }
}

/* ---------------- AI 评论 ----------------
 * 周期性看一眼「你在干嘛」，交给 DeepSeek 换一句话回来。
 * 拿到的 { id, text } 和 reactions.js 里的罐头台词同构，
 * 所以直接走 say() —— 底下还是 {emotionId, tips} → handleAIMessage 那条管道。 */

/** 真正发起一次评论。act 可传入已取好的快照，避免重复采样 */
async function comment(act) {
  if (aiBusy || !emotions.length) return null;
  aiBusy = true;
  try {
    if (!act) act = await activity.snapshot();
    lastActKey = act.key;
    const r = await deepseek.comment(act, emotions, recentSaid);
    if (!r) return null;
    lastComment = Date.now();
    recentSaid.push(r.text);
    if (recentSaid.length > 5) recentSaid.shift();
    wake(true);                 /* 睡着也醒过来说，但不播 '01' 免得白闪 */
    stopWalk();
    say(r);
    return r;
  } finally {
    aiBusy = false;
  }
}

async function tickAI() {
  if (!aiOn || aiBusy || !deepseek.isReady()) return;
  const now = Date.now();

  /* 人不在就别自言自语 */
  if (now - lastCursorMove > AWAY_MS) return;
  /* 闹脾气 / 正在走 / 话还没说完，都不插嘴。睡着倒是可以醒来说一句 */
  if (now < sulkUntil || walk) return;
  if (tempBackAt && now < tempBackAt) return;

  const c = deepseek.loadConfig();
  if (now - lastComment < c.minGapMs) return;   /* 硬下限，防止切来切去烧额度 */

  const act = await activity.snapshot();
  const changed = lastActKey !== null && act.key !== lastActKey;
  lastActKey = act.key;
  /* 活动类别变了就值得马上说一句，否则等到 everyMs */
  if (!changed && now - lastComment < c.everyMs) return;

  await comment(act);
}

/* ---------------- 光标轮询：注视 + 拖拽 + 行为 ---------------- */

function startPoll() {
  pollTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const now = Date.now();
    const dt = lastPoll ? clamp((now - lastPoll) / 1000, 0.001, 0.05) : 1 / 60;
    lastPoll = now;
    const p = screen.getCursorScreenPoint();
    if (p.x !== lastCursorPt.x || p.y !== lastCursorPt.y) {
      lastCursorPt = p;
      lastCursorMove = now;
    }

    if (drag) {
      win.setPosition(
        Math.round(drag.w0.x + p.x - drag.m0.x),
        Math.round(drag.w0.y + p.y - drag.m0.y)
      );
      return;                       /* 拖拽期间不动注视，避免眼睛乱晃 */
    }

    tickBehaviour(now);
    if (walk) stepWalk(now, dt);

    /* 散步时看向前进方向，其余时候盯着光标 */
    let nx, ny;
    if (walk) {
      nx = walk.dir * 0.72;
      ny = 0.06;
    } else {
      const b = win.getBounds();
      nx = clamp((p.x - (b.x + b.width / 2)) / GAZE_RANGE, -1, 1);
      ny = clamp((p.y - (b.y + b.height / 2)) / GAZE_RANGE, -1, 1);
    }
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
          click: () => { clearSulk(); wake(); stopWalk(); setEmotion(e.id); }
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
    { label: '散步一段', click: () => { wake(); startWalk(Math.random() < 0.5 ? -1 : 1, 4); } },
    {
      label: '自发行为（散步 / 小动作）',
      type: 'checkbox',
      checked: autoBehave,
      click: () => { autoBehave = !autoBehave; if (!autoBehave) stopWalk(); refreshTrayMenu(); }
    },
    { type: 'separator' },
    deepseek.isReady()
      ? {
          label: 'AI 评论（DeepSeek）',
          type: 'checkbox',
          checked: aiOn,
          click: () => { aiOn = !aiOn; refreshTrayMenu(); }
        }
      : { label: 'AI 评论：未配置 key', enabled: false },
    { label: '现在让它说一句', enabled: deepseek.isReady(), click: () => comment() },
    { type: 'separator' },
    { label: '表情', submenu: emotionSubmenus() },
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
  stopWalk();
  const wa = screen.getPrimaryDisplay().workArea;
  win.setPosition(wa.x + wa.width - WIN_W - 40, wa.y + wa.height - WIN_H - 40);
}

/* ---------------- 本地 HTTP 接口 ----------------
 * 只绑 127.0.0.1。/emotion 的 body 原样转给 handleAIMessage ——
 * 格式容错本来就是引擎自己的职责，这里不做二次解析 */

function readBody(req, cb) {
  let body = '';
  req.on('data', c => {
    body += c;
    if (body.length > 8192) req.destroy();
  });
  req.on('end', () => cb(body));
}

function startApi() {
  apiServer = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    if (req.method === 'GET' && req.url === '/emotions') {
      res.end(JSON.stringify(emotions));
      return;
    }
    /* 当前状态：调试用，后续接大模型时也靠它拿上下文 */
    if (req.method === 'GET' && req.url === '/state') {
      const b = win && !win.isDestroyed() ? win.getBounds() : null;
      res.end(JSON.stringify({
        phase: phase,
        emotion: curEmotion,
        walking: !!walk,
        walkDir: walk ? walk.dir : 0,
        stage: walk ? walk.stage : null,
        height: walk ? Math.round(walk.h) : 0,
        autoBehave: autoBehave,
        clicks: clickN,
        sulkMsLeft: Math.max(0, sulkUntil - Date.now()),
        ai: {
          ready: deepseek.isReady(),
          on: aiOn,
          lastCommentMsAgo: lastComment ? Date.now() - lastComment : null,
          awayMs: Date.now() - lastCursorMove
        },
        idleForMs: Date.now() - lastInteract,
        bounds: b
      }));
      return;
    }
    if (req.method === 'POST' && req.url === '/emotion') {
      readBody(req, body => {
        clearSulk();                      /* API 是控制通道，不算"戳它" */
        wake();
        stopWalk();
        tempBackAt = 0;
        send('emotion', body);
        res.end('{"ok":true}');
      });
      return;
    }
    /* 看看它以为你在干嘛（调分类规则用） */
    if (req.method === 'GET' && req.url === '/activity') {
      activity.snapshot().then(a => res.end(JSON.stringify(a)));
      return;
    }
    /* 手动催一次评论，返回模型给的原样结果，便于排查 */
    if (req.method === 'POST' && req.url === '/comment') {
      if (!deepseek.isReady()) {
        res.statusCode = 503;
        res.end('{"ok":false,"reason":"未配置 DeepSeek key，见 config.example.json"}');
        return;
      }
      comment().then(r => res.end(JSON.stringify({ ok: !!r, result: r })));
      return;
    }
    if (req.method === 'POST' && req.url === '/walk') {
      readBody(req, body => {
        let o = {};
        try { o = JSON.parse(body || '{}'); } catch (e) { /* 空 body 也当默认散步 */ }
        clearSulk();
        wake();
        startWalk(o.dir === 'left' ? -1 : o.dir === 'right' ? 1 : (Math.random() < 0.5 ? -1 : 1),
          Number(o.launches) || Number(o.hops) || 4);
        res.end('{"ok":true}');
      });
      return;
    }
    res.statusCode = 404;
    res.end('{"ok":false,"hint":"GET /emotions | GET /state | GET /activity | POST /emotion | POST /walk | POST /comment"}');
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
  stopWalk();
  wake();
  const b = win.getBounds();
  drag = { m0: screen.getCursorScreenPoint(), w0: { x: b.x, y: b.y } };
});

ipcMain.on('drag:end', () => { drag = null; lastInteract = Date.now(); });

ipcMain.on('poke', () => { wake(); stopWalk(); });

ipcMain.on('react', (_e, kind) => react(kind));

ipcMain.on('menu', () => {
  Menu.buildFromTemplate([
    { label: '散步一段', click: () => { wake(); startWalk(Math.random() < 0.5 ? -1 : 1, 4); } },
    { type: 'separator' },
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
  aiTimer = setInterval(tickAI, AI_TICK_MS);
  if (!deepseek.isReady()) {
    console.log('[deepseek] 未配置 key，AI 评论已关闭（复制 config.example.json 为 config.local.json 填入即可）');
  }
});

app.on('window-all-closed', () => app.quit());

app.on('before-quit', () => {
  if (pollTimer) clearInterval(pollTimer);
  if (aiTimer) clearInterval(aiTimer);
  if (apiServer) apiServer.close();
});
