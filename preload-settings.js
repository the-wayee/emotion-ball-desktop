/* ============================================================
 * preload-settings.js —— 设置窗口的安全桥
 * 和桌宠窗口的 preload 分开：两个窗口需要的能力完全不同，
 * 合成一个会让桌宠那边平白拿到写配置的权限
 * ============================================================ */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settings', {
  get: () => ipcRenderer.invoke('settings:get'),
  save: patch => ipcRenderer.invoke('settings:save', patch),
  test: () => ipcRenderer.invoke('settings:test'),
  probe: () => ipcRenderer.invoke('settings:probe'),
  openFolder: () => ipcRenderer.invoke('settings:openFolder'),
  close: () => ipcRenderer.invoke('settings:close')
});
