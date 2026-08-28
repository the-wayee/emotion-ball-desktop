/* ============================================================
 * settings.js —— 配置读写（主进程）
 *
 * 落盘位置是 app.getPath('userData')/config.json，不是项目目录 ——
 * 以后打包成 .app 时项目目录在 bundle 里是只读的，设置界面就存不进去。
 * 首次启动会把项目根目录里手写的 config.local.json 导入一次（迁移用）。
 *
 * API key 仍然支持环境变量 DEEPSEEK_API_KEY 覆盖，方便临时试。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  deepseek: {
    apiKey: '',
    model: 'deepseek-chat'
  },
  comment: {
    enabled: true,
    everyMin: 10,          /* 没别的事发生时多久说一句 */
    minGapMin: 3,          /* 两次调用的硬下限 */
    awayMin: 5,            /* 光标这么久没动就当人不在 */
    quietWhenFullscreen: true,
    quietWhenGaming: true,
    useActiveHours: false,
    activeFrom: '09:00',
    activeTo: '23:00'
  },
  pet: {
    autoBehave: true,      /* 自发散步与小动作 */
    shape: 'blob',         /* blob / wedge / gem */
    sketch: false,
    x: null,               /* 上次退出时的窗口位置；null = 默认右下角 */
    y: null
  }
};

let cache = null;
let filePath = null;

function file() {
  if (!filePath) filePath = path.join(app.getPath('userData'), 'config.json');
  return filePath;
}

function merge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const k of Object.keys(patch || {})) {
    const v = patch[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object') {
      out[k] = merge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

const clampNum = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const asTime = (v, dflt) => (HHMM.test(String(v)) ? String(v) : dflt);

/** 收口用户输入：界面可以填任何东西，这里挡住越界值 */
function normalize(c) {
  const d = DEFAULTS;
  return {
    deepseek: {
      apiKey: String(c.deepseek.apiKey || '').trim(),
      model: String(c.deepseek.model || d.deepseek.model).trim() || d.deepseek.model
    },
    comment: {
      enabled: !!c.comment.enabled,
      everyMin: clampNum(c.comment.everyMin, 1, 240, d.comment.everyMin),
      minGapMin: clampNum(c.comment.minGapMin, 1, 120, d.comment.minGapMin),
      awayMin: clampNum(c.comment.awayMin, 1, 180, d.comment.awayMin),
      quietWhenFullscreen: !!c.comment.quietWhenFullscreen,
      quietWhenGaming: !!c.comment.quietWhenGaming,
      useActiveHours: !!c.comment.useActiveHours,
      activeFrom: asTime(c.comment.activeFrom, d.comment.activeFrom),
      activeTo: asTime(c.comment.activeTo, d.comment.activeTo)
    },
    pet: {
      autoBehave: !!c.pet.autoBehave,
      shape: ['blob', 'wedge', 'gem'].includes(c.pet.shape) ? c.pet.shape : d.pet.shape,
      sketch: !!c.pet.sketch,
      /* 位置允许为空（首次启动），但存进来的必须是有限数 */
      x: Number.isFinite(Number(c.pet.x)) ? Math.round(Number(c.pet.x)) : null,
      y: Number.isFinite(Number(c.pet.y)) ? Math.round(Number(c.pet.y)) : null
    }
  };
}

function load() {
  if (cache) return cache;
  let disk = {};
  try {
    disk = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch (e) {
    /* 首次运行：项目根目录有手写的 config.local.json 就导入一次 */
    try {
      disk = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.local.json'), 'utf8'));
      /* 旧字段名兼容 */
      if (disk.deepseek) {
        disk.comment = Object.assign({}, disk.comment);
        if (disk.deepseek.enabled !== undefined) disk.comment.enabled = disk.deepseek.enabled;
        if (disk.deepseek.everyMs) disk.comment.everyMin = Math.round(disk.deepseek.everyMs / 60000);
        if (disk.deepseek.minGapMs) disk.comment.minGapMin = Math.round(disk.deepseek.minGapMs / 60000);
      }
    } catch (e2) { /* 都没有就用默认值 */ }
  }
  cache = normalize(merge(DEFAULTS, disk));
  return cache;
}

function save(patch) {
  cache = normalize(merge(load(), patch));
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    /* key 是明文，权限收到 0600 */
    fs.writeFileSync(file(), JSON.stringify(cache, null, 2), { mode: 0o600 });
  } catch (e) {
    console.error('[settings] 保存失败：', e.message);
  }
  return cache;
}

/** 环境变量优先，方便临时换 key 试 */
function apiKey() {
  return process.env.DEEPSEEK_API_KEY || load().deepseek.apiKey || '';
}

function isReady() {
  return !!(load().comment.enabled && apiKey());
}

const toMin = hhmm => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** 是否落在用户设定的活跃时段内；支持跨夜（22:00 → 02:00） */
function withinActiveHours(now) {
  const c = load().comment;
  if (!c.useActiveHours) return true;
  const from = toMin(c.activeFrom);
  const to = toMin(c.activeTo);
  const d = now || new Date();
  const cur = d.getHours() * 60 + d.getMinutes();
  if (from === to) return true;                 /* 起止相同视为全天 */
  return from < to ? (cur >= from && cur < to) : (cur >= from || cur < to);
}

module.exports = {
  DEFAULTS, load, save, apiKey, isReady, withinActiveHours,
  configPath: file
};
