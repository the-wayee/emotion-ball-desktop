/* ============================================================
 * platform/darwin.js —— macOS 活动探测
 *
 * 前台应用用 lsappinfo，不走 System Events —— 后者要「辅助功能」权限会弹窗，
 * lsappinfo 开箱即用，而且返回本地化显示名（「飞书」而不是 Feishu）。
 *
 * 全屏判定靠菜单栏：应用进全屏时 macOS 会自动隐藏菜单栏与 Dock，
 * 该显示器的 workArea 就等于 bounds。免权限，但有个前提 ——
 * 用户如果常年手动隐藏菜单栏 + Dock，这里会一直判定为全屏。
 * 设置界面里对此有说明，可以单独关掉。
 * ============================================================ */
'use strict';

const { execFile } = require('child_process');

/* 桌宠自己（启动或点击时会短暂抢焦点），不能算成"用户在干嘛" */
const SELF = /^(electron|emotion-ball-desktop)$/i;
let lastKnownApp = null;

function run(cmd, args) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout: 4000 }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });
}

/** @returns {{app:string|null, self:boolean}} self = 当前前台就是桌宠自己 */
async function frontApp() {
  const asn = (await run('lsappinfo', ['front'])).trim();
  if (!asn) return { app: lastKnownApp, self: false };
  const info = await run('lsappinfo', ['info', '-only', 'name', asn]);
  const m = info.match(/"LSDisplayName"\s*=\s*"([^"]*)"/);
  const name = m ? m[1] : null;
  /* 前台是自己（设置窗口 / 刚点过小球）时退回上一个已知应用，
   * 并把 self 报上去，界面才能解释清楚显示的是"上一个" */
  if (!name || SELF.test(name)) return { app: lastKnownApp, self: !!name };
  lastKnownApp = name;
  return { app: name, self: false };
}

async function runningApps() {
  const out = await run('ps', ['-axo', 'comm=']);
  const set = new Set();
  for (const line of out.split('\n')) {
    /* 嵌套 bundle（WeChat.app/.../WeChatAppEx.app/...）要取最后一段，
     * 用 indexOf 会拿到中间那截路径 */
    const i = line.lastIndexOf('.app/Contents/MacOS/');
    if (i < 0) continue;
    const name = line.slice(i + 20).trim();
    if (name) set.add(name);
  }
  return [...set];
}

/** 任一显示器的菜单栏 + Dock 都被隐藏 → 大概率有应用在全屏 */
function detectFullscreen(displays) {
  if (!displays || !displays.length) return false;
  return displays.some(d =>
    d.bounds.y === d.workArea.y &&
    d.bounds.height === d.workArea.height &&
    d.bounds.width === d.workArea.width);
}

async function probe(displays) {
  const [front, apps] = await Promise.all([frontApp(), runningApps()]);
  return { app: front.app, self: front.self, apps, fullscreen: detectFullscreen(displays) };
}

module.exports = { probe };
