/* ============================================================
 * pet.js —— 渲染进程
 *
 * 职责：
 *   1. 实例化引擎，把表情清单上报给主进程（托盘 / 右键菜单据此生成）
 *   2. 圆形命中检测 → 告诉主进程何时关掉鼠标穿透
 *   3. 拖拽 / 点击 / 右键；位移小于阈值才算点击
 *   4. 接收主进程转发的 AI 消息，交给 handleAIMessage 自行容错
 * ============================================================ */
'use strict';

(function () {
  var petEl = document.getElementById('pet');
  var bubbleEl = document.getElementById('bubble');

  var shape = 'blob';
  var sketch = false;
  var curEmotion = '02';
  var ball = null;

  /* ---------------- 实例化 ---------------- */

  function build() {
    if (ball) ball.destroy();
    petEl.innerHTML = '';
    ball = EmotionBall.create(petEl, {
      emotion: curEmotion,
      shape: shape,
      idle: true,           /* 60s 转待机、180s 转睡眠 */
      lite: false           /* 保留彩带与撒花 */
    });
    if (sketch) ball.setStyle({ sketch: 1 });

    ball.on('change', function (e) { curEmotion = e.id; });
    ball.on('tips', function (e) { showBubble(e.text); });
    ball.on('error', function (e) { console.warn('[pet] 协议错误：', e); });
  }

  build();

  /* 表情清单上报（主进程用来建菜单） */
  var groupNames = {};
  EmotionBall.config.groups().forEach(function (g) { groupNames[g.key] = g.name; });
  window.pet.ready({
    groups: EmotionBall.config.groups(),
    emotions: EmotionBall.config.list().map(function (d) {
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
    ball.resetIdle();
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
    ball.resetIdle();
  });

  window.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    if (isOverBall(e.clientX, e.clientY)) window.pet.menu();
  });

  /* ---------------- 主进程事件 ---------------- */

  window.pet.onGaze(function (g) { ball.setGaze(g.x, g.y); });

  window.pet.onEmotion(function (msg) {
    ball.resetIdle();
    ball.handleAIMessage(msg);                  /* 对象或字符串都收，容错在引擎里 */
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
