/* ============================================================
 * activity.js —— 你在干嘛（macOS）
 *
 * 前台应用用 lsappinfo 取，不走 System Events —— 后者要辅助功能权限，
 * 会弹窗要授权；lsappinfo 开箱即用，而且给的是本地化显示名（「飞书」）。
 *
 * 隐私：只取应用名，**不取窗口标题**。窗口标题里常有文件路径、文档名、
 * 聊天对象，这些会随上下文发给大模型。要更精准的评论可以自行打开，
 * 但那是另一个量级的信息暴露，默认不开。
 * ============================================================ */
'use strict';

const { execFile } = require('child_process');

/* 分类关键词：小写子串匹配，中英文都列上（ps 给英文可执行名，
 * lsappinfo 给本地化显示名，两边命中任一即可） */
const RULES = [
  ['coding', '写代码', [
    'code', 'cursor', 'xcode', 'intellij', 'pycharm', 'webstorm', 'goland',
    'rubymine', 'clion', 'datagrip', 'android studio', 'sublime', 'zed',
    'nova', 'vim', 'emacs', 'terminal', 'iterm', 'warp', 'ghostty',
    'kitty', 'alacritty', 'tower', 'sourcetree', 'fork', 'github desktop',
    'apifox', 'postman', 'docker', 'tableplus', 'navicat', '终端'
  ]],
  ['gaming', '玩游戏', [
    'steam', 'wegame', 'epic games', 'battle.net', 'minecraft', 'league of legends',
    'dota', 'openemu', 'whisky', 'crossover', 'parallels', 'porting kit',
    '网易游戏', 'gameloop', 'riot', 'genshin', 'honkai', '原神', '崩坏'
  ]],
  ['video', '看视频', [
    'iina', 'quicktime', 'vlc', 'infuse', 'mpv', 'plex', 'jellyfin', 'emby',
    'netflix', 'bilibili', '哔哩哔哩', '爱奇艺', '腾讯视频', '优酷', 'youku',
    'potplayer', 'movist', '视频'
  ]],
  ['music', '听音乐', [
    'spotify', 'music', '网易云', 'neteasemusic', 'qq音乐', 'qqmusic',
    'apple music', 'audirvana', '音乐'
  ]],
  ['chat', '聊天沟通', [
    'wechat', '微信', 'lark', 'feishu', '飞书', 'dingtalk', '钉钉', 'qq',
    'slack', 'discord', 'telegram', 'whatsapp', 'messages', '信息', 'zoom',
    'tencent meeting', '腾讯会议'
  ]],
  ['design', '搞设计', [
    'figma', 'sketch', 'photoshop', 'illustrator', 'affinity', 'blender',
    'principle', 'framer', 'pixelmator', 'canva'
  ]],
  ['writing', '写文档', [
    'notion', 'obsidian', 'bear', 'ulysses', 'typora', 'craft', '语雀', 'yuque',
    'word', 'pages', 'wps', 'onenote', 'evernote', 'logseq', 'anytype'
  ]],
  ['mail', '收邮件', ['mail', 'spark', 'outlook', 'airmail', '邮件', 'foxmail']],
  ['browsing', '逛网页', [
    'safari', 'chrome', 'arc', 'edge', 'firefox', 'brave', 'opera', 'vivaldi',
    'orion', 'zen browser'
  ]],
  ['ai', '和 AI 聊天', ['chatgpt', 'claude', 'codex', 'gemini', 'perplexity', 'copilot']]
];

/* ps 里一堆系统进程和 Helper，分类时全部忽略 */
const NOISE = /helper|renderer|gpu|agent|daemon|service|svr|crashpad|updater|plugin|networking|webkit|xpc|notification|extension|appex/i;

function classify(name) {
  if (!name) return null;
  const n = String(name).toLowerCase();
  for (const [key, label, kws] of RULES) {
    for (const k of kws) if (n.includes(k)) return { key, label };
  }
  return null;
}

function run(cmd, args) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout: 4000 }, (err, stdout) => {
      resolve(err ? '' : String(stdout));
    });
  });
}

/* 桌宠自己（启动或点击时会短暂抢焦点），不能算成"用户在干嘛" */
const SELF = /^(electron|emotion-ball-desktop)$/i;
let lastKnownApp = null;

/** 当前前台应用的显示名；前台是桌宠自己时沿用上一个已知应用 */
async function frontApp() {
  const asn = (await run('lsappinfo', ['front'])).trim();
  if (!asn) return lastKnownApp;
  const info = await run('lsappinfo', ['info', '-only', 'name', asn]);
  const m = info.match(/"LSDisplayName"\s*=\s*"([^"]*)"/);
  const name = m ? m[1] : null;
  if (!name || SELF.test(name)) return lastKnownApp;
  lastKnownApp = name;
  return name;
}

/** 后台在跑的 GUI 应用（去掉 Helper / 系统进程），用来发现"游戏开着但没在前台"这类情况 */
async function runningApps() {
  const out = await run('ps', ['-axo', 'comm=']);
  const set = new Set();
  for (const line of out.split('\n')) {
    /* 嵌套 bundle（WeChat.app/.../WeChatAppEx.app/...）要取最后一段，
     * 用 indexOf 会拿到中间那截路径 */
    const i = line.lastIndexOf('.app/Contents/MacOS/');
    if (i < 0) continue;
    const name = line.slice(i + 20).trim();
    if (!name || NOISE.test(name)) continue;
    set.add(name);
  }
  return [...set];
}

/**
 * 汇总一次快照。
 * @returns {{ app: string|null, key: string, label: string, alsoRunning: string[] }}
 */
async function snapshot() {
  const [app, apps] = await Promise.all([frontApp(), runningApps()]);
  const front = classify(app);

  /* 前台认不出来时，看看后台有没有跑着能认出来的（游戏 / 播放器常挂后台） */
  let hinted = null;
  if (!front) {
    for (const a of apps) {
      const c = classify(a);
      if (c && (c.key === 'gaming' || c.key === 'video')) { hinted = c; break; }
    }
  }
  const cat = front || hinted || { key: 'unknown', label: '不太看得出在干嘛' };

  return {
    app: app || null,
    key: cat.key,
    label: cat.label,
    /* 只挑分类命中的，避免把一整屏进程名发出去 */
    alsoRunning: apps.filter(a => classify(a)).slice(0, 8)
  };
}

module.exports = { snapshot, frontApp, runningApps, classify };
