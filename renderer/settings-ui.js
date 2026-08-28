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
    autoBehave: 'pet.autoBehave',
    dropFall: 'pet.dropFall'
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

  let probeBusy = false;
  async function refreshProbe(quiet) {
    if (probeBusy) return;
    probeBusy = true;
    if (!quiet) $('probe').textContent = '检测中…';
    const p = await api.probe();
    probeBusy = false;
    if (!p) { $('probe').textContent = '读取失败'; return; }
    const yes = v => (v ? '是' : '否');
    /* 设置窗口开着的时候，前台应用就是桌宠自己 —— 显示的必然是"上一个"，
     * 不说清楚会让人以为检测坏了 */
    const appLine = p.app
      ? `<b>${esc(p.app)}</b>${p.self ? '　<span class="dim">(你正看着设置窗口,这是切过来之前用的)</span>' : ''}`
      : (p.self ? '<b>还没见过别的应用</b>　<span class="dim">(切到别的窗口用几秒再回来)</span>' : '<b>识别不到</b>');
    /* 顺带把发给模型的那条轨迹显出来 —— 用户能直接看到 AI 拿到的是什么 */
    const trail = (p.recentApps || []).length
      ? `\n最近用过：<b>${p.recentApps.map(esc).join(' → ')}</b>`
      : '';
    $('probe').innerHTML =
      `前台应用：${appLine}\n` +
      `判断在：<b>${esc(p.label)}</b>\n` +
      `全屏中：<b>${yes(p.fullscreen)}</b>　　当前系统：<b>${esc(p.platform)}</b>` + trail;

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

  /* ---- 接入 Claude Code / Codex ----
   * 探测 / 安装 / 卸载都在主进程的 integrations.js，这里只负责画和点。
   * 命令行 `npm run hooks:install` 走的是同一套代码，两条路效果一致。 */

  const INTEG = {
    claude: { name: 'Claude Code', file: '~/.claude/settings.json' },
    codex: { name: 'Codex', file: '~/.codex/config.toml' }
  };

  let integBusy = false;
  async function refreshIntegrations() {
    const st = await api.integrations();
    const box = $('integrations');
    box.innerHTML = '';
    for (const key of ['claude', 'codex']) {
      const v = st[key];
      const meta = INTEG[key];
      const row = document.createElement('div');
      row.className = 'integ' + (v.available ? '' : ' off');

      let note;
      if (!v.available) note = esc(v.reason);
      else if (v.installed) {
        note = '已接入';
        if (key === 'claude') note += `　${v.total} 个事件`;
        if (key === 'codex') {
          if (v.forwarding) note += '　原通知程序已保留转发';
          /* Codex 的 hook 有信任门槛，不说清楚用户会以为坏了 */
          note += '<br>还要在 Codex 里 <b>/settings → Hooks</b> 审核一次才会触发';
        }
      } else if (v.partial) note = `只接了一部分(${v.events}/${v.total}),点一下补齐`;
      else note = esc(meta.file);

      row.innerHTML = `<div class="who"><b>${esc(meta.name)}</b><span>${note}</span></div>`;
      if (v.available) {
        const btn = document.createElement('button');
        btn.className = v.installed ? 'ghost' : 'primary';
        btn.textContent = v.installed ? '撤除' : (v.partial ? '补齐' : '接入');
        btn.disabled = integBusy;
        btn.addEventListener('click', async () => {
          integBusy = true;
          btn.disabled = true;
          btn.textContent = '处理中…';
          const r = await api.setIntegration(key, !v.installed);
          integBusy = false;
          await refreshIntegrations();
          if (r && r.ok) {
            toast(v.installed
              ? `已撤除 <b>${esc(meta.name)}</b>`
              : `已接入 <b>${esc(meta.name)}</b>,重开一个会话生效`, 'ok');
          } else {
            toast(`没成功：<b>${esc((r && r.reason) || '未知原因')}</b>`, 'err');
          }
        });
        row.appendChild(btn);
      }
      box.appendChild(row);
    }
  }

  $('refresh').addEventListener('click', () => { refreshProbe(); refreshModels(); refreshIntegrations(); });

  /* 面板自动刷新：原来只在打开时渲染一次，切了应用回来还是旧文案，
   * 让人以为检测很慢 —— 其实后端 50ms 就知道了。
   *
   * 注意不能用 document.hidden 做守卫：窗口明明在屏幕上，只要不是焦点窗口
   * Electron 就报 hidden，加了守卫等于把刷新全挡掉。窗口关闭时页面一起销毁，
   * 定时器不会漏。 */
  let probeTimer = 0;
  function startAutoProbe(ms) {
    clearInterval(probeTimer);
    probeTimer = setInterval(() => refreshProbe(true), ms);
  }
  /* 切回窗口时立刻刷一次，不用等下一个 tick */
  window.addEventListener('focus', () => refreshProbe(true));
  $('openFolder').addEventListener('click', () => api.openFolder());

  window.addEventListener('keydown', e => {
    if (e.key === 'Escape') api.close();
    if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); $('save').click(); }
  });

  (async () => {
    cfg = await api.get();
    render();
    const first = await api.probe();
    /* 刷新频率按平台定：macOS 一次采样约 21ms，1.2s 一刷无所谓；
     * Windows 每次都要起 PowerShell（约 1s），必须放慢，否则 CPU 打满 */
    startAutoProbe(first && first.platform === 'win32' ? 5000 : 1200);
    refreshProbe();
    refreshIntegrations();
    if (cfg.deepseek.apiKey) refreshModels();
  })();
})();
