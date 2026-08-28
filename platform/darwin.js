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

/* 前台轮询间隔：一次 frontApp 实测 16ms，几秒一次完全无压力 */
const FRONT_POLL_MS = 4000;

function run(cmd, args) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout: 4000 }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });
}

/** 只取原始前台名，不做任何过滤 —— 是不是桌宠自己、是不是 Helper，
 *  由 activity.js 统一判断，免得两个平台各写一份还写歪 */
async function frontApp() {
  const asn = (await run('lsappinfo', ['front'])).trim();
  if (!asn) return null;
  const info = await run('lsappinfo', ['info', '-only', 'name', asn]);
  const m = info.match(/"LSDisplayName"\s*=\s*"([^"]*)"/);
  return m ? m[1] : null;
}

/* 用 lsappinfo visibleProcessList 而不是 ps：
 *   - 只列有 Dock 图标的应用（本机 17 个 vs ps 的 118 个进程），
 *     不用再靠正则去猜哪些是 Helper / 后台服务
 *   - 给的是本地化名，和 frontApp() 一致（都拿到「飞书」而不是 Feishu）
 * 注意它的顺序**不是**前后台顺序 —— 实测切到某个应用后它可能仍排在第二，
 * 所以「最近用过哪些」由 activity.js 自己维护 MRU，不依赖这里的次序。 */
async function runningApps() {
  const out = await run('lsappinfo', ['visibleProcessList']);
  const names = [];
  for (const m of out.matchAll(/"([^"]+)"/g)) {
    /* 这个接口把名字里的空格换成了下划线：Google_Chrome / WPS_Office */
    const name = m[1].replace(/_/g, ' ').trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
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
  const [app, apps] = await Promise.all([frontApp(), runningApps()]);
  return { app, apps, fullscreen: detectFullscreen(displays) };
}

module.exports = { probe, pollFront: frontApp, FRONT_POLL_MS };
