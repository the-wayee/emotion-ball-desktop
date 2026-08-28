#!/usr/bin/env node
/* ============================================================
 * setup-hooks.mjs —— 命令行接入 Claude Code / Codex
 *
 *   node tools/setup-hooks.mjs            查看当前状态
 *   node tools/setup-hooks.mjs install    两边都接上
 *   node tools/setup-hooks.mjs install claude
 *   node tools/setup-hooks.mjs remove     撤掉
 *
 * 和设置界面里的按钮走同一套 integrations.js，效果完全一致。
 * ============================================================ */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const I = require('../integrations.js');

const [, , cmd = 'status', only] = process.argv;
const targets = only ? [only] : ['claude', 'codex'];

const NAME = { claude: 'Claude Code', codex: 'Codex' };

function show() {
  const s = I.status();
  console.log(`\n桌宠接口：http://127.0.0.1:${s.port}/agent\n`);
  for (const k of ['claude', 'codex']) {
    const v = s[k];
    const mark = !v.available ? '—' : v.installed ? '✅' : v.partial ? '◐' : '⬜';
    let note = !v.available ? v.reason
      : v.installed ? '已接入'
      : v.partial ? `只接了一部分（${v.events}/${v.total}）`
      : '未接入';
    if (k === 'codex' && v.installed) note += v.forwarding ? '（原通知程序已保留转发）' : '';
    if (k === 'claude' && v.available && !v.installed && !v.partial) note += `（共 ${v.total} 个事件）`;
    console.log(`  ${mark} ${NAME[k].padEnd(12)} ${note}`);
  }
  console.log();
}

if (cmd === 'status') {
  show();
} else if (cmd === 'install' || cmd === 'remove') {
  for (const t of targets) {
    const st = I.status()[t];
    if (!st.available) { console.log(`  跳过 ${NAME[t]}：${st.reason}`); continue; }
    const r = cmd === 'install' ? I.install(t) : I.uninstall(t);
    console.log(r.ok ? `  ✅ ${NAME[t]} ${cmd === 'install' ? '已接入' : '已撤除'}`
                     : `  ❌ ${NAME[t]}：${r.reason}`);
  }
  show();
  if (cmd === 'install') {
    console.log('提示：Claude Code 需要重开一个会话（或打开一次 /hooks）才会加载新 hook。\n');
  }
} else {
  console.log('用法: node tools/setup-hooks.mjs [status|install|remove] [claude|codex]');
  process.exit(1);
}
