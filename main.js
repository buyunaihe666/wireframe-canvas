'use strict';

const { app, BrowserWindow, ipcMain, clipboard, dialog, nativeImage, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

const SRC = path.join(__dirname, 'src');
const PRELOAD = path.join(__dirname, 'preload.js');
const ICON = path.join(__dirname, 'build', 'app.ico');
const DEV = !!process.env.WFC_DEV;

/* 去掉默认菜单：避免 Ctrl+R / Ctrl+Shift+I 之类的意外快捷键打断画图 */
Menu.setApplicationMenu(null);

let mainWindow = null;

/* ------------------------------------------------------------------ *
 * 主窗口
 * ------------------------------------------------------------------ */
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#eceef2',
    show: false,
    icon: fs.existsSync(ICON) ? ICON : undefined,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#ffffff', symbolColor: '#3f4653', height: 46 },
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(SRC, 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  if (DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });
  mainWindow.on('closed', () => { mainWindow = null; });
  // F12 打开/关闭开发者工具（仅开发模式）
  mainWindow.webContents.on('before-input-event', (_e, input) => {
    if (DEV && input.type === 'keyDown' && input.key === 'F12') {
      mainWindow.webContents.toggleDevTools();
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

/* ------------------------------------------------------------------ *
 * 离屏画板渲染 → 截图
 *   用固定尺寸的隐藏窗口把单个画板按 1:1 设备像素渲染出来，
 *   保证「截图 = 该设备的真实规格图」，不受主窗口缩放影响。
 * ------------------------------------------------------------------ */
let pendingExport = null;   // { project, artboardId }
let captureQueue = Promise.resolve();

function captureOne(job) {
  return new Promise((resolve, reject) => {
    const w = Math.max(1, Math.round(job.width));
    const h = Math.max(1, Math.round(job.height));

    const win = new BrowserWindow({
      show: false,
      width: w,
      height: h,
      useContentSize: true,
      frame: false,
      resizable: true,          // 需要能被 resize 到「画板 + 规格条 + 文字清单」的实际高度
      backgroundColor: job.bg || '#ffffff',
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false,
        backgroundThrottling: false,
        additionalArguments: ['--app-mode=export'],
      },
    });

    pendingExport = job;

    let target = { w, h };      // 渲染进程回报的实际内容尺寸
    let done = false;

    const onLayout = (event, lw, lh) => {
      if (done || event.sender !== win.webContents) return;
      target = { w: Math.max(1, Math.ceil(lw)), h: Math.max(1, Math.ceil(lh)) };
    };
    ipcMain.on('export:layout', onLayout);

    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ipcMain.removeListener('export:ready', onReady);
      ipcMain.removeListener('export:layout', onLayout);
      try { if (!win.isDestroyed()) win.destroy(); } catch (_) {}
      fn(arg);
    };

    const timer = setTimeout(() => finish(reject, new Error('画板渲染超时')), 20000);

    const onReady = async (event) => {
      if (done) return;
      if (event.sender !== win.webContents) return;
      try {
        // 等一帧，确保首次绘制已落到 surface 上
        await new Promise((r) => setTimeout(r, 180));
        let img = await win.webContents.capturePage();
        if (img.isEmpty()) {
          await new Promise((r) => setTimeout(r, 260));
          img = await win.webContents.capturePage();
        }
        if (img.isEmpty()) throw new Error('画板渲染结果为空');
        const size = img.getSize();
        if (size.width !== target.w || size.height !== target.h) {
          img = img.resize({ width: target.w, height: target.h, quality: 'best' });
        }
        finish(resolve, { dataUrl: img.toDataURL(), width: target.w, height: target.h });
      } catch (err) {
        finish(reject, err);
      }
    };

    ipcMain.on('export:ready', onReady);
    win.loadFile(path.join(SRC, 'index.html'), {
      query: { mode: 'export', id: job.artboardId, token: String(Date.now()) },
    });
  });
}

ipcMain.handle('capture:artboards', async (_e, payload) => {
  const list = (payload && payload.jobs) || [];
  const run = async () => {
    const out = [];
    for (const job of list) {
      const shot = await captureOne(job);
      out.push({ ...shot, id: job.artboardId, label: job.label || '' });
    }
    return out;
  };
  const p = captureQueue.then(run, run);
  captureQueue = p.catch(() => {});
  return p;
});

ipcMain.handle('export:payload', () => pendingExport);

// 导出窗口按内容实际高度自我调整（例如带「文字清单」时会更长）
ipcMain.on('export:layout', (e, w, h) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.isDestroyed()) return;
  const nw = Math.max(1, Math.ceil(w));
  const nh = Math.max(1, Math.ceil(h));
  const cur = win.getContentSize();
  if (cur[0] !== nw || cur[1] !== nh) win.setContentSize(nw, nh, false);
});

/* ------------------------------------------------------------------ *
 * 剪贴板 / 文件
 * ------------------------------------------------------------------ */
ipcMain.handle('clipboard:writeImage', (_e, dataUrl) => {
  const img = nativeImage.createFromDataURL(dataUrl);
  if (img.isEmpty()) return { ok: false, error: '图像为空' };
  clipboard.writeImage(img);
  return { ok: true, size: img.getSize() };
});

ipcMain.handle('png:save', async (_e, dataUrl, suggested) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: '导出 PNG',
    defaultPath: suggested || 'wireframe.png',
    filters: [{ name: 'PNG 图片', extensions: ['png'] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  const img = nativeImage.createFromDataURL(dataUrl);
  fs.writeFileSync(filePath, img.toPNG());
  return { ok: true, filePath };
});

ipcMain.handle('project:save', async (_e, json, suggested) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: '保存工程',
    defaultPath: suggested || '未命名.wire.json',
    filters: [{ name: '线框画布工程', extensions: ['json'] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  fs.writeFileSync(filePath, json, 'utf8');
  return { ok: true, filePath, name: path.basename(filePath).replace(/\.wire\.json$|\.json$/i, '') };
});

ipcMain.handle('project:open', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: '打开工程',
    properties: ['openFile'],
    filters: [{ name: '线框画布工程', extensions: ['json'] }],
  });
  if (canceled || !filePaths.length) return { ok: false, canceled: true };
  const json = fs.readFileSync(filePaths[0], 'utf8');
  return {
    ok: true,
    json,
    filePath: filePaths[0],
    name: path.basename(filePaths[0]).replace(/\.wire\.json$|\.json$/i, ''),
  };
});

ipcMain.on('window:title', (e, t) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win) win.setTitle(String(t || '线框画布'));
});

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(createMainWindow);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
