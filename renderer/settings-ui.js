/* ============================================================
 * settings-ui.js —— 设置窗口逻辑
 * 表单 ↔ 配置对象的双向映射；保存后主进程立即生效，不用重启
 * ============================================================ */
'use strict';

(function () {
  const $ = id => document.getElementById(id);
  const api = window.settings;

  /* 表单字段 → 配置路径 */
  const BOOLS = {
    enabled: 'comment.enabled',
    quietWhenFullscreen: 'comment.quietWhenFullscreen',
    quietWhenGaming: 'comment.quietWhenGaming',
    useActiveHours: 'comment.useActiveHours',
    autoBehave: 'pet.autoBehave'
  };
  const NUMS = { everyMin: 'comment.everyMin', minGapMin: 'comment.minGapMin', awayMin: 'comment.awayMin' };
  const TEXTS = {
    apiKey: 'deepseek.apiKey',
    model: 'deepseek.model',
    activeFrom: 'comment.activeFrom',
    activeTo: 'comment.activeTo'
  };

  const dig = (obj, p) => p.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
  function put(obj, p, v) {
    const ks = p.split('.');
    let o = obj;
    for (let i = 0; i < ks.length - 1; i++) o = (o[ks[i]] = o[ks[i]] || {});
    o[ks[ks.length - 1]] = v;
  }

  let cfg = null;

  function render() {
    for (const [id, path] of Object.entries(BOOLS)) $(id).checked = !!dig(cfg, path);
    for (const [id, path] of Object.entries(NUMS)) $(id).value = dig(cfg, path);
    for (const [id, path] of Object.entries(TEXTS)) $(id).value = dig(cfg, path) || '';
    syncLabels();
  }

  function syncLabels() {
    $('everyVal').textContent = $('everyMin').value;
    $('minGapVal').textContent = $('minGapMin').value;
    $('awayVal').textContent = $('awayMin').value;

    $('aiFields').classList.toggle('off', !$('enabled').checked);
    $('hoursRow').classList.toggle('off', !$('useActiveHours').checked);

    /* 跨夜提示：22:00 → 02:00 这种要说清楚，不然用户以为填错了 */
    const from = $('activeFrom').value, to = $('activeTo').value;
    $('wrapHint').textContent =
      from && to && from > to ? '(跨夜)' : '';

    $('keyHint').textContent = $('apiKey').value.trim()
      ? '保存在本机配置文件里,不会进仓库'
      : '没有 key 时 AI 评论自动关闭,其余功能不受影响';
  }

  function collect() {
    const out = {};
    for (const [id, path] of Object.entries(BOOLS)) put(out, path, $(id).checked);
    for (const [id, path] of Object.entries(NUMS)) put(out, path, Number($(id).value));
    for (const [id, path] of Object.entries(TEXTS)) put(out, path, $(id).value.trim());
    return out;
  }

  let toastTimer = 0;
  function toast(msg, kind) {
    const el = $('toast');
    el.innerHTML = msg;
    el.className = 'toast show ' + (kind || '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast'; }, kind === 'err' ? 6000 : 2600);
  }

  const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  async function refreshProbe() {
    $('probe').textContent = '检测中…';
    const p = await api.probe();
    if (!p) { $('probe').textContent = '读取失败'; return; }
    const yes = v => (v ? '是' : '否');
    $('probe').innerHTML =
      `前台应用：<b>${esc(p.app || '识别不到')}</b>\n` +
      `判断在：<b>${esc(p.label)}</b>\n` +
      `全屏中：<b>${yes(p.fullscreen)}</b>　　当前系统：<b>${esc(p.platform)}</b>`;

    /* 全屏判定的口径两个平台不一样，实话写在界面上 */
    $('fsHint').textContent = p.platform === 'darwin'
      ? 'macOS 靠"菜单栏与 Dock 是否隐藏"判断。如果你平时就手动隐藏菜单栏,这项会一直判定为全屏,建议关掉。'
      : p.platform === 'win32'
        ? 'Windows 比对前台窗口与显示器的矩形,独占全屏游戏和 F11 全屏都能识别。'
        : '当前系统不支持全屏检测,此项无效。';
  }

  /* ---- 事件 ---- */

  document.addEventListener('input', syncLabels);
  document.addEventListener('change', syncLabels);

  $('reveal').addEventListener('click', () => {
    const el = $('apiKey');
    const show = el.type === 'password';
    el.type = show ? 'text' : 'password';
    $('reveal').textContent = show ? '隐藏' : '显示';
  });

  $('save').addEventListener('click', async () => {
    cfg = await api.save(collect());
    render();
    refreshModels();
    toast('已保存,<b>立即生效</b>', 'ok');
  });

  $('test').addEventListener('click', async () => {
    const btn = $('test');
    btn.disabled = true;
    btn.textContent = '请求中…';
    /* 先存再测，否则测的是旧 key */
    cfg = await api.save(collect());
    const r = await api.test();
    btn.disabled = false;
    btn.textContent = '测试一句';
    if (r && r.ok) toast(`它说：<b>${esc(r.result.text)}</b>（表情 ${esc(r.result.id)}）`, 'ok');
    else toast(`没成功：<b>${esc((r && r.reason) || '未知原因')}</b>`, 'err');
  });

  /* 模型清单：从 /models 拉真实可用的填进 datalist。
   * 用 input + datalist 而不是 select —— 拉取失败时仍能手动输入，不至于卡死 */
  async function refreshModels() {
    const ids = await api.models();
    const dl = $('modelList');
    dl.innerHTML = '';
    for (const id of ids) {
      const o = document.createElement('option');
      o.value = id;
      dl.appendChild(o);
    }
    $('modelHint').textContent = ids.length
      ? '账号可用：' + ids.join('、')
      : '拉不到模型列表(Key 不对或网络不通),可以手动填';
  }

  $('refresh').addEventListener('click', () => { refreshProbe(); refreshModels(); });
  $('openFolder').addEventListener('click', () => api.openFolder());

  window.addEventListener('keydown', e => {
    if (e.key === 'Escape') api.close();
    if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); $('save').click(); }
  });

  (async () => {
    cfg = await api.get();
    render();
    refreshProbe();
    if (cfg.deepseek.apiKey) refreshModels();
  })();
})();
