/* ============================================================
 * probe-squash.mjs —— 压缩形变探针（调手感用）
 *
 * 落地压扁只持续约 150ms，截图抓不准，所以直接读渲染进程的
 * computed transform。走 Electron 的远程调试端口 + CDP，
 * Node 自带的 WebSocket 就够用，不需要装依赖。
 *
 *   env -u ELECTRON_RUN_AS_NODE npx electron . --remote-debugging-port=9222 &
 *   node tools/probe-squash.mjs
 *
 * 输出每 40ms 一行的 scaleX / scaleY，用来核对
 * main.js 里的 GRAV / REST / LAUNCH_V 与 pet.js 里的弹簧参数。
 * ============================================================ */
const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find(t => t.type === 'page');
if (!page) { console.log('没找到 page 目标'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);

const expr = `new Promise(r => {
  const el = document.getElementById('pet');
  const out = []; const t0 = performance.now();
  const id = setInterval(() => {
    const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
    out.push(((performance.now()-t0)/1000).toFixed(2)+' sx='+m.a.toFixed(3)+' sy='+m.d.toFixed(3));
    if (performance.now()-t0 > 2600) { clearInterval(id); r(out.join('|')); }
  }, 40);
})`;

ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate',
  params: { expression: expr, awaitPromise: true, returnByValue: true } }));

// 采样开始后立刻触发散步
setTimeout(() => fetch('http://127.0.0.1:17817/walk',
  { method:'POST', body: JSON.stringify({dir:'left', launches:2}) }), 120);

const res = await new Promise(r => ws.onmessage = e => r(JSON.parse(e.data)));
const rows = (res.result?.result?.value || '').split('|');
console.log('t     scaleX scaleY');
for (const l of rows) {
  const [t, sx, sy] = l.split(' ');
  const x = +sx.slice(3), y = +sy.slice(3);
  const bar = y < 0.99 ? '压扁' + '#'.repeat(Math.round((1-y)*60)) : (y > 1.01 ? '拉长' + '='.repeat(Math.round((y-1)*60)) : '');
  console.log(`${t}  ${x.toFixed(3)}  ${y.toFixed(3)}  ${bar}`);
}
ws.close();
