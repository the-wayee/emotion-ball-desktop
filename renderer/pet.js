/* ============================================================
 * pet.js —— 渲染进程
 *
 * 职责：
 *   1. 实例化引擎，注册「散步」自定义表情，把表情清单上报给主进程
 *   2. 圆形命中检测 → 告诉主进程何时关掉鼠标穿透
 *   3. 拖拽 / 点击 / 右键；位移小于阈值才算点击
 *   4. 接收主进程转发的 AI 消息，交给 handleAIMessage 自行容错
 *
 * 注意：创建时 idle:false —— 生命周期（活跃 / 发呆 / 睡眠）由主进程
 * 的行为调度器独占。引擎自带的 _checkIdle 会把非 '02'/'00' 的表情
 * 每帧强行拉回待机，两个调度器并存的话「好奇」「散步」活不过一帧。
 * ============================================================ */
'use strict';

(function () {
  var petEl = document.getElementById('pet');
  var bubbleEl = document.getElementById('bubble');

  /* 球体底部在容器高度中的占比（viewBox -15 -15 259 259 内实测）——
   * 压缩形变的锚点，设错会变成"悬空压扁" */
  var BALL_BOTTOM = { blob: 94, gem: 94, wedge: 90.2 };

  var shape = 'blob';
  var sketch = false;
  var curEmotion = '02';
  var ball = null;

  /* ---------------- 散步表情（自定义段 50+）----------------
   * 摇摆不再挂在跳跃节奏上：物理版每一跳的滞空时长都在衰减，
   * 拿固定 period 的正弦去对是对不上的。跳跃的节奏感交给压缩形变，
   * 这里只留一点慢速侧倾当"走路的松弛感"。 */

  EmotionBall.config.register({
    id: '50', name: '散步', group: 'custom',
    desc: '一弹一弹地挪动，落地压扁再弹回来',
    en: { name: 'Strolling', desc: 'Hops along, squashing on each landing' },
    transition: 260,
    pool: [2, 11, 17, 19],          /* 笑眼池 */
    poolMs: [1800, 3200],
    blinkMs: [2600, 5200],
    body: { breathe: 0.016 },
    anims: [
      { target: 'body', prop: 'rotate', type: 'sine', amp: 3.5, period: 1500 }
    ]
  });

  /* ---------------- 实例化 ---------------- */

  function build() {
    if (ball) ball.destroy();
    petEl.innerHTML = '';
    ball = EmotionBall.create(petEl, {
      emotion: curEmotion,
      shape: shape,
      idle: false,          /* 生命周期交给主进程，见文件头注释 */
      lite: false,          /* 保留彩带与撒花 */
      eyeScale: 1.2         /* 球缩到 100px，眼睛按集成指南补一点占比保证可读 */
    });
    petEl.style.transformOrigin = '50% ' + (BALL_BOTTOM[shape] || 94) + '%';
    if (sketch) ball.setStyle({ sketch: 1 });

    ball.on('change', function (e) { curEmotion = e.id; });
    ball.on('tips', function (e) { showBubble(e.text); });
    ball.on('error', function (e) { console.warn('[pet] 协议错误：', e); });
  }

  build();

  /* 表情清单上报（主进程用来建菜单）；散步是内部状态，不进菜单 */
  window.pet.ready({
    groups: EmotionBall.config.groups(),
    emotions: EmotionBall.config.list()
      .filter(function (d) { return d.id !== '50'; })
      .map(function (d) {
        return { id: d.id, name: d.name, group: d.group, desc: d.desc };
      })
  });

  /* ---------------- 气泡 ---------------- */

  var bubbleTimer = 0;
  function showBubble(text) {
    if (!text) return;
    bubbleEl.textContent = text;
    bubbleEl.classList.add('show');
    clearTimeout(bubbleTimer);
    /* 按字数给阅读时间，2.4s 起步、7s 封顶 */
    var ms = Math.min(7000, Math.max(2400, text.length * 220));
    bubbleTimer = setTimeout(function () {
      bubbleEl.classList.remove('show');
    }, ms);
  }

  /* ---------------- 命中检测 ----------------
   * .pet 是 pointer-events:none，这里手算圆形范围。
   * 半径取容器宽的 46%：blob 基本填满，wedge / gem 也在这个圆内 */

  function isOverBall(x, y) {
    var r = petEl.getBoundingClientRect();
    var cx = r.left + r.width / 2;
    var cy = r.top + r.height / 2;
    var dx = x - cx, dy = y - cy;
    return dx * dx + dy * dy <= Math.pow(r.width * 0.46, 2);
  }

  var hovering = false;
  window.addEventListener('mousemove', function (e) {
    if (drag.on) return;                        /* 拖拽中不重算穿透 */
    var over = isOverBall(e.clientX, e.clientY);
    if (over === hovering) return;
    hovering = over;
    window.pet.hover(over);                     /* 主进程据此开关 ignoreMouseEvents */
  });

  /* ---------------- 拖拽 / 点击 ----------------
   * 位移由主进程按全局光标算，这里只负责起止与「拖拽 or 点击」的判定 */

  var drag = { on: false, x0: 0, y0: 0, moved: 0 };

  window.addEventListener('pointerdown', function (e) {
    if (e.button !== 0 || !isOverBall(e.clientX, e.clientY)) return;
    drag.on = true;
    drag.x0 = e.screenX;
    drag.y0 = e.screenY;
    drag.moved = 0;
    window.pet.dragStart();
  });

  window.addEventListener('pointermove', function (e) {
    if (!drag.on) return;
    drag.moved = Math.max(drag.moved, Math.hypot(e.screenX - drag.x0, e.screenY - drag.y0));
  });

  function endDrag() {
    if (!drag.on) return;
    drag.on = false;
    window.pet.dragEnd();
    /* 位移不超过 6px 才算点击 —— 否则拖一下就会转圈 */
    if (drag.moved <= 6) ball.spin(1);
    hovering = false;                           /* 强制下一次 mousemove 重新判定 */
  }

  window.addEventListener('pointerup', endDrag);
  window.addEventListener('blur', endDrag);

  window.addEventListener('dblclick', function (e) {
    if (!isOverBall(e.clientX, e.clientY)) return;
    ball.burst(28);
    window.pet.poke();
  });

  window.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    if (isOverBall(e.clientX, e.clientY)) window.pet.menu();
  });

  /* ---------------- 主进程事件 ---------------- */

  window.pet.onGaze(function (g) { ball.setGaze(g.x, g.y); });

  window.pet.onEmotion(function (msg) {
    ball.handleAIMessage(msg);                  /* 对象或字符串都收，容错在引擎里 */
  });

  window.pet.onWalk(function (w) {
    if (!w.active) return;                      /* 结束由主进程另发 emotion 收尾 */
    ball.setEmotion('50');
  });

  /* ---------------- 压缩形变 ----------------
   * 主进程只发事件（蓄力 / 起跳 / 落地冲量 / 收尾），形变本身在这里跑一个
   * 欠阻尼弹簧：落地给一记速度冲量 → 压扁 → 回弹过冲 → 余震衰减。
   * 作用在容器的 CSS transform 上，锚点设在球底（见 BALL_BOTTOM），
   * 这样不用改引擎一行代码，也不会和引擎自己的 SVG 变换打架。 */

  var sq = { x: 0, v: 0, t: 0 };   /* x > 0 压扁，x < 0 拉长 */

  function springStep(s, w, z, dt) {
    var n = Math.max(1, Math.ceil(dt / (1 / 240)));
    var h = dt / n;
    for (var i = 0; i < n; i++) {
      s.v += (w * w * (s.t - s.x) - 2 * z * w * s.v) * h;
      s.x += s.v * h;
    }
  }

  window.pet.onPhys(function (e) {
    if (e.type === 'crouch') { sq.t = 0.34; }                       /* 蓄力：慢慢压下去 */
    else if (e.type === 'launch') { sq.t = 0; sq.v -= 7; }          /* 蹬地：向上拉长 */
    else if (e.type === 'land') {
      sq.t = 0;
      /* 冲量按落地速度给，封顶避免第一跳压成饼 */
      sq.v += Math.min(1, e.impact / 430) * 15;
    } else if (e.type === 'settle') { sq.t = 0; }
  });

  var lastT = 0;
  (function squashLoop(t) {
    requestAnimationFrame(squashLoop);
    var dt = lastT ? Math.min(0.05, Math.max(0.001, (t - lastT) / 1000)) : 1 / 60;
    lastT = t;
    springStep(sq, 26, 0.34, dt);               /* 欠阻尼 → 回弹带余震 */
    var v = Math.max(-0.42, Math.min(0.5, sq.x));
    if (Math.abs(v) < 0.0008) { petEl.style.transform = ''; return; }
    /* 压扁时横向撑开，粗略保体积 */
    petEl.style.transform = 'scaleX(' + (1 + v * 0.30).toFixed(4) +
                            ') scaleY(' + (1 - v * 0.34).toFixed(4) + ')';
  })(0);

  window.pet.onAct(function (act) {
    if (act === 'spin') ball.spin(1);
    else if (act === 'burst') ball.burst(24);
    else if (act === 'bounce') ball.bounce();
  });

  window.pet.onShape(function (s) {
    if (s === shape) return;
    shape = s;
    build();                                    /* shape 只在创建时生效，重建实例 */
  });

  window.pet.onSketch(function (on) {
    sketch = !!on;
    ball.setStyle({ sketch: sketch ? 1 : 0 });
  });
})();
