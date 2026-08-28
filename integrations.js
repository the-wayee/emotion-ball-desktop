/* ============================================================
 * integrations.js —— 一键接入 Claude Code / Codex
 *
 * 手改 ~/.claude/settings.json 和 ~/.codex/config.toml 太劝退，
 * 这里把探测 / 安装 / 卸载都封起来，设置界面和命令行安装器共用。
 *
 * 三条原则：
 *   1. 幂等 —— 重复安装不会写出两份，靠命令里的 /agent 标记识别自己人
 *   2. 先备份 —— 动任何文件之前先写 .bak
 *   3. 不顶掉别人 —— Codex 的 notify 只能配一个程序，安装时把原来那个
 *      读出来存好、由包装脚本转发；卸载时原样还回去
 *
 * 不依赖 electron，命令行安装器可以直接 node 跑。
 * ============================================================ */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 17817;

/* 认自己人用的标记：命令里出现这一段就是我们装的 */
const MARK = `:${PORT}/agent`;

/* async + `|| true`：后台跑、连不上也静默失败 ——
 * 桌宠没开的时候绝不能拖住用户的会话 */
const HOOK_CMD =
  `curl -s -m 2 -X POST http://127.0.0.1:${PORT}/agent ` +
  `-H 'Content-Type: application/json' --data-binary @- >/dev/null 2>&1 || true`;

/* Windows 没有 curl 的老机器用 PowerShell 兜底 */
const HOOK_CMD_PS =
  `try { $i = [Console]::In.ReadToEnd(); ` +
  `Invoke-RestMethod -Uri 'http://127.0.0.1:${PORT}/agent' -Method Post ` +
  `-ContentType 'application/json' -Body $i -TimeoutSec 2 | Out-Null } catch {}`;

const EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'Notification',
  'PermissionRequest',
  'Stop',
  'SessionEnd',
  'PostToolUseFailure'
];

/** 跨平台的应用数据目录；Electron 里传 app.getPath('userData') 进来更准 */
function defaultUserData() {
  const name = 'emotion-ball-desktop';
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', name);
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), name);
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), name);
}

let userDataDir = defaultUserData();
function setUserData(dir) { if (dir) userDataDir = dir; }

const claudeSettings = () => path.join(os.homedir(), '.claude', 'settings.json');
const codexConfig = () => path.join(os.homedir(), '.codex', 'config.toml');
const codexHooks = () => path.join(os.homedir(), '.codex', 'hooks.json');
const statePath = () => path.join(userDataDir, 'integrations.json');
const wrapperPath = () =>
  path.join(userDataDir, process.platform === 'win32' ? 'codex-notify.cmd' : 'codex-notify.sh');

function readState() {
  try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch (e) { return {}; }
}
function writeState(o) {
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(statePath(), JSON.stringify(o, null, 2));
}

function backup(file) {
  try {
    if (fs.existsSync(file) && !fs.existsSync(file + '.bak')) {
      fs.copyFileSync(file, file + '.bak');
    }
  } catch (e) { /* 备份失败不阻断，下面写入本来就有 try */ }
}

/* ---------------- Claude Code ---------------- */

const hookCommand = () => (process.platform === 'win32' ? HOOK_CMD_PS : HOOK_CMD);

function hookEntry() {
  const h = { type: 'command', command: hookCommand(), async: true, timeout: 5 };
  if (process.platform === 'win32') h.shell = 'powershell';
  return { hooks: [h] };
}

const isOurs = group =>
  (group.hooks || []).some(h => typeof h.command === 'string' && h.command.includes(MARK));

function claudeStatus() {
  const file = claudeSettings();
  if (!fs.existsSync(file)) {
    return { available: false, installed: false, reason: '没找到 ~/.claude/settings.json' };
  }
  let c;
  try { c = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return { available: false, installed: false, reason: 'settings.json 不是合法 JSON' }; }
  const hooks = c.hooks || {};
  const done = EVENTS.filter(ev => (hooks[ev] || []).some(isOurs));
  return {
    available: true,
    installed: done.length === EVENTS.length,
    partial: done.length > 0 && done.length < EVENTS.length,
    events: done.length,
    total: EVENTS.length,
    file
  };
}

function claudeInstall() {
  const file = claudeSettings();
  if (!fs.existsSync(file)) {
    /* Claude Code 装了但还没生成过设置文件时，建一个最小的 */
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '{}\n');
    } catch (e) {
      return { ok: false, reason: '创建 ~/.claude/settings.json 失败：' + e.message };
    }
  }
  let c;
  try { c = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return { ok: false, reason: 'settings.json 不是合法 JSON，先修好再装' }; }

  backup(file);
  const hooks = (c.hooks = c.hooks || {});
  for (const ev of EVENTS) {
    const list = (hooks[ev] || []).filter(g => !isOurs(g));   /* 先去重再加，保证幂等 */
    hooks[ev] = list.concat([hookEntry()]);
  }
  try {
    fs.writeFileSync(file, JSON.stringify(c, null, 2) + '\n');
  } catch (e) {
    return { ok: false, reason: '写入失败：' + e.message };
  }
  return { ok: true, events: EVENTS.length };
}

function claudeUninstall() {
  const file = claudeSettings();
  if (!fs.existsSync(file)) return { ok: true, removed: 0 };
  let c;
  try { c = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return { ok: false, reason: 'settings.json 不是合法 JSON' }; }

  backup(file);
  const hooks = c.hooks || {};
  let removed = 0;
  for (const ev of Object.keys(hooks)) {
    const before = hooks[ev].length;
    hooks[ev] = hooks[ev].filter(g => !isOurs(g));
    removed += before - hooks[ev].length;
    if (!hooks[ev].length) delete hooks[ev];      /* 空数组就整个删掉，别留垃圾 */
  }
  if (!Object.keys(hooks).length) delete c.hooks;
  try {
    fs.writeFileSync(file, JSON.stringify(c, null, 2) + '\n');
  } catch (e) {
    return { ok: false, reason: '写入失败：' + e.message };
  }
  return { ok: true, removed };
}

/* ---------------- Codex ----------------
 * 两条路一起用，各补各的短板：
 *
 *   ~/.codex/hooks.json  —— 事件齐全（和 Claude Code 同构，字段名都叫
 *     hook_event_name），能拿到"任务开始"。但有信任门槛：改动过的 hook
 *     会被静默跳过，要在 Codex 里 /settings → Hooks 审核一次。
 *   config.toml 的 notify —— 只有 agent-turn-complete 一个事件（没有"开始"），
 *     但没有信任门槛，装上就生效。用来兜住"任务结束"。
 *
 * 实测要点（都是踩出来的）：
 *   - Codex 不支持 async，带 async:true 的 hook 会被整个跳过，
 *     日志里只有一行 "async hooks are not supported yet"
 *   - timeout 会被 clamp 到 3s
 *   - matcher 不能省，省了一个事件都不触发
 *   - hook 跑在只读沙箱里：回环网络可用，写文件会失败
 *
 * notify 只能配一个程序，所以生成一个包装脚本：先把参数原样转给
 * 原来的通知程序，再通知桌宠。原程序不是硬编码的 —— 安装时从
 * config.toml 里读出来存进 integrations.json，卸载时原样还回去。 */

/* 只挑有用的，PreToolUse / PostToolUse 每次工具调用都触发，太吵 */
const CODEX_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Stop', 'SessionEnd'];

function codexHookEntry() {
  const h = { type: 'command', command: hookCommand(), timeout: 3 };  /* 不能加 async */
  return { matcher: '', hooks: [h] };
}

function readHooksFile() {
  try { return JSON.parse(fs.readFileSync(codexHooks(), 'utf8')); } catch (e) { return {}; }
}

function codexHooksInstalled() {
  const doc = readHooksFile();
  const h = (doc && doc.hooks) || {};
  return CODEX_EVENTS.every(ev => (h[ev] || []).some(isOurs));
}

function writeCodexHooks(remove) {
  const file = codexHooks();
  const doc = readHooksFile();
  doc.hooks = doc.hooks || {};
  for (const ev of Object.keys(doc.hooks)) {
    doc.hooks[ev] = (doc.hooks[ev] || []).filter(g => !isOurs(g));
    if (!doc.hooks[ev].length) delete doc.hooks[ev];
  }
  if (!remove) for (const ev of CODEX_EVENTS) {
    doc.hooks[ev] = (doc.hooks[ev] || []).concat([codexHookEntry()]);
  }
  if (fs.existsSync(file)) backup(file);
  if (remove && !Object.keys(doc.hooks).length) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
}

const NOTIFY_RE = /^\s*notify\s*=\s*\[[^\]\n]*\]\s*$/m;

function parseNotify(text) {
  const m = text.match(NOTIFY_RE);
  if (!m) return null;
  const inner = m[0].slice(m[0].indexOf('[') + 1, m[0].lastIndexOf(']'));
  const parts = inner.match(/"(?:[^"\\]|\\.)*"/g) || [];
  return parts.map(x => JSON.parse(x));
}

const shq = s => "'" + String(s).replace(/'/g, `'\\''`) + "'";

function writeWrapper(original) {
  fs.mkdirSync(userDataDir, { recursive: true });
  const p = wrapperPath();

  if (process.platform === 'win32') {
    const fwd = original.length
      ? `call ${original.map(a => `"${a}"`).join(' ')} %* >nul 2>&1\r\n`
      : '';
    fs.writeFileSync(p,
      '@echo off\r\n' +
      'rem 由 emotion-ball-desktop 生成，卸载时会删除\r\n' +
      fwd +
      `powershell -NoProfile -Command "try { Invoke-RestMethod -Uri 'http://127.0.0.1:${PORT}/agent' ` +
      `-Method Post -ContentType 'application/json' -Body '%~1' -TimeoutSec 2 | Out-Null } catch {}"\r\n` +
      'exit /b 0\r\n');
    return p;
  }

  const fwd = original.length
    ? `ORIGINAL=(${original.map(shq).join(' ')})\n` +
      'if [ -x "${ORIGINAL[0]}" ]; then "${ORIGINAL[@]}" "$@" >/dev/null 2>&1 || true; fi\n'
    : 'ORIGINAL=()\n';

  fs.writeFileSync(p,
`#!/bin/bash
# 由 emotion-ball-desktop 生成，卸载时会删除。
# Codex 的 notify 只能配一个程序，这里先转发给原来那个，再通知桌宠。
set -u

${fwd}
# Codex 把事件 JSON 追加在最后一个参数
PAYLOAD="\${!#:-}"
case "$PAYLOAD" in
  '{'*) ;;
  *) PAYLOAD='{"type":"turn-ended"}' ;;
esac

# 桌宠没开时静默失败，绝不拖住 Codex
curl -s -m 2 -X POST http://127.0.0.1:${PORT}/agent \\
  -H 'Content-Type: application/json' -d "$PAYLOAD" >/dev/null 2>&1 || true
exit 0
`, { mode: 0o755 });
  return p;
}

function codexStatus() {
  const file = codexConfig();
  if (!fs.existsSync(file)) {
    return { available: false, installed: false, reason: '没找到 ~/.codex/config.toml' };
  }
  let notify;
  try { notify = parseNotify(fs.readFileSync(file, 'utf8')); }
  catch (e) { return { available: false, installed: false, reason: '读取失败' }; }
  const notifyOurs = !!(notify && notify[0] === wrapperPath());
  const hooksOurs = codexHooksInstalled();
  return {
    available: true,
    installed: notifyOurs && hooksOurs,
    partial: (notifyOurs || hooksOurs) && !(notifyOurs && hooksOurs),
    notify: notifyOurs,
    hooks: hooksOurs,
    /* hooks 装上还要在 Codex 里审核一次才会真正生效，界面要提示 */
    needsTrust: hooksOurs,
    file,
    /* 装上之后原来的通知程序还在不在，界面上要说清楚 */
    forwarding: notifyOurs ? (readState().codexOriginalNotify || []).length > 0 : false
  };
}

function codexInstall() {
  const file = codexConfig();
  if (!fs.existsSync(file)) return { ok: false, reason: '没找到 ~/.codex/config.toml' };

  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) { return { ok: false, reason: '读取失败：' + e.message }; }

  const cur = parseNotify(text);
  const wrapper = wrapperPath();

  /* 已经指向我们了就别把自己存成"原程序"，否则卸载会还回一个自引用 */
  const original = (cur && cur[0] !== wrapper) ? cur : (readState().codexOriginalNotify || []);
  writeState(Object.assign(readState(), { codexOriginalNotify: original }));
  writeWrapper(original);

  try { writeCodexHooks(false); }
  catch (e) { return { ok: false, reason: '写 hooks.json 失败：' + e.message }; }

  backup(file);
  const line = `notify = [${JSON.stringify(wrapper)}]`;
  const next = NOTIFY_RE.test(text)
    ? text.replace(NOTIFY_RE, line)
    : (text.trimEnd() + '\n' + line + '\n');
  try {
    fs.writeFileSync(file, next);
  } catch (e) {
    return { ok: false, reason: '写入失败：' + e.message };
  }
  return { ok: true, forwarding: original.length > 0, original, needsTrust: true };
}

function codexUninstall() {
  const file = codexConfig();
  if (!fs.existsSync(file)) return { ok: true };
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) { return { ok: false, reason: '读取失败：' + e.message }; }

  try { writeCodexHooks(true); } catch (e) { /* hooks.json 清理失败不阻断 */ }

  const st = readState();
  const original = st.codexOriginalNotify || [];
  backup(file);
  const next = original.length
    ? text.replace(NOTIFY_RE, `notify = [${original.map(a => JSON.stringify(a)).join(', ')}]`)
    : text.replace(NOTIFY_RE, '').replace(/\n{3,}/g, '\n\n');
  try {
    fs.writeFileSync(file, next);
    fs.rmSync(wrapperPath(), { force: true });
  } catch (e) {
    return { ok: false, reason: '写入失败：' + e.message };
  }
  delete st.codexOriginalNotify;
  writeState(st);
  return { ok: true, restored: original.length > 0 };
}

/* ---------------- 对外 ---------------- */

function status() {
  return { claude: claudeStatus(), codex: codexStatus(), port: PORT };
}

function install(target) {
  if (target === 'claude') return claudeInstall();
  if (target === 'codex') return codexInstall();
  return { ok: false, reason: '未知目标：' + target };
}

function uninstall(target) {
  if (target === 'claude') return claudeUninstall();
  if (target === 'codex') return codexUninstall();
  return { ok: false, reason: '未知目标：' + target };
}

module.exports = { status, install, uninstall, setUserData, EVENTS, PORT };
