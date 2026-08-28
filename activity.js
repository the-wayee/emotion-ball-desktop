/* ============================================================
 * activity.js —— 你在干嘛（跨平台）
 *
 * 平台实现在 platform/ 下，本文件只负责分类与汇总：
 *   platform/darwin.js  lsappinfo 取前台 + ps 取后台
 *   platform/win32.js   PowerShell + user32 P/Invoke
 * 平台层统一返回 { app, apps, fullscreen }，拿不到就返回空值，
 * 绝不抛异常 —— 桌宠不该因为读不到进程列表就崩。
 *
 * 隐私：只取应用名，**不取窗口标题**。窗口标题里常有文件路径、文档名、
 * 聊天对象，这些会随上下文发给大模型。默认不开。
 * ============================================================ */
'use strict';

const os = require('os');

const impl = (() => {
  try {
    if (process.platform === 'darwin') return require('./platform/darwin');
    if (process.platform === 'win32') return require('./platform/win32');
  } catch (e) {
    console.warn('[activity] 平台实现加载失败：', e.message);
  }
  /* Linux 等：不报错，只是认不出在干嘛 */
  return { probe: async () => ({ app: null, self: false, apps: [], fullscreen: false }) };
})();

/* 分类关键词：小写子串匹配。中英文都列上 ——
 * macOS 的 lsappinfo 给本地化显示名（「飞书」），Windows 给进程名 / 文件描述
 * （Feishu / Visual Studio Code），两边命中任一即可 */
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

/* 一堆 Helper、后台服务和系统进程，分类时全部忽略 */
const NOISE = /helper|renderer|gpu|agent|daemon|service|svr|crashpad|updater|plugin|networking|webkit|xpc|notification|extension|appex|host$|^system|^runtime/i;

function classify(name) {
  if (!name) return null;
  const n = String(name).toLowerCase();
  for (const [key, label, kws] of RULES) {
    for (const k of kws) if (n.includes(k)) return { key, label };
  }
  return null;
}

/**
 * 汇总一次快照。
 * @param {Array} displays 主进程传进来的 screen.getAllDisplays()，macOS 的全屏判定要用
 * @returns {{app:string|null,key:string,label:string,alsoRunning:string[],fullscreen:boolean}}
 */
async function snapshot(displays) {
  let raw;
  try {
    raw = await impl.probe(displays);
  } catch (e) {
    console.warn('[activity] 采样失败：', e.message);
    raw = { app: null, self: false, apps: [], fullscreen: false };
  }

  const apps = (raw.apps || []).filter(a => a && !NOISE.test(a));
  const front = classify(raw.app);

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
    app: raw.app || null,
    self: !!raw.self,          /* 当前前台就是桌宠自己，app 是记住的上一个 */
    key: cat.key,
    label: cat.label,
    /* 只挑分类命中的，避免把一整屏进程名发出去 */
    alsoRunning: apps.filter(a => classify(a)).slice(0, 8),
    fullscreen: !!raw.fullscreen,
    platform: process.platform
  };
}

module.exports = { snapshot, classify, platform: process.platform };
