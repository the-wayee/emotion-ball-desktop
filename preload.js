/* ============================================================
 * preload.js —— 安全桥
 * contextIsolation 开启，渲染进程只能看到这里白名单出去的方法
 * ============================================================ */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const on = (ch, cb) => ipcRenderer.on(ch, (_e, payload) => cb(payload));

contextBridge.exposeInMainWorld('pet', {
  /* 主进程 → 渲染进程 */
  onGaze: cb => on('gaze', cb),
  onEmotion: cb => on('emotion', cb),
  onShape: cb => on('shape', cb),
  onSketch: cb => on('sketch', cb),
  onWalk: cb => on('walk', cb),
  onAct: cb => on('act', cb),

  /* 渲染进程 → 主进程 */
  ready: payload => ipcRenderer.send('ready', payload),
  hover: isOver => ipcRenderer.send('hover', isOver),
  dragStart: () => ipcRenderer.send('drag:start'),
  dragEnd: () => ipcRenderer.send('drag:end'),
  poke: () => ipcRenderer.send('poke'),
  menu: () => ipcRenderer.send('menu')
});
