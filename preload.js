'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

contextBridge.exposeInMainWorld('api', {
  mode: arg('app-mode', 'app'),

  // 导出（离屏画板）
  getExportPayload: () => ipcRenderer.invoke('export:payload'),
  reportLayout: (w, h) => ipcRenderer.send('export:layout', w, h),
  exportReady: () => ipcRenderer.send('export:ready'),

  // 截图 / 剪贴板
  captureArtboards: (jobs) => ipcRenderer.invoke('capture:artboards', { jobs }),
  copyImage: (dataUrl) => ipcRenderer.invoke('clipboard:writeImage', dataUrl),
  savePng: (dataUrl, suggested) => ipcRenderer.invoke('png:save', dataUrl, suggested),

  // 工程文件
  saveProject: (json, suggested) => ipcRenderer.invoke('project:save', json, suggested),
  openProject: () => ipcRenderer.invoke('project:open'),

  setTitle: (t) => ipcRenderer.send('window:title', t),
});
