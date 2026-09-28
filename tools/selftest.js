/* 开发用自检：用真实的离屏导出管线渲染示例画板并存成 PNG，用于目视核对。
   运行： node_modules/.bin/electron tools/selftest.js            */
'use strict';
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const OUT = process.env.WFC_OUT || path.join(ROOT, '.selftest-out');
const LS_KEY = 'wireframe-canvas.project.v1';

const box = (x, y, w, h, level, text) => ({ id: 'b' + Math.random().toString(36).slice(2, 8), x, y, w, h, level, text });

const SAMPLE = {
  version: 1,
  name: '自检示例',
  artboards: [
    {
      id: 'aDesktop', name: '首页 · 桌面', device: 'd1440', w: 1440, h: 900,
      boxes: [
        box(0, 0, 1440, 64, 'h2', '顶部导航：左侧 Logo「品牌名」 | 中部菜单 首页 / 产品 / 定价 / 文档 | 右侧「登录」「免费试用」按钮'),
        box(120, 120, 600, 150, 'h1', '主标题：一句话说清产品价值\n副标题：补充一句，说明适用人群'),
        box(120, 290, 180, 44, 'p', '主按钮：立即开始'),
        box(320, 290, 180, 44, 'p', '次按钮：观看演示'),
        box(120, 420, 360, 180, 'h3', '功能卡片 1\n图表区块，占位'),
        box(540, 420, 360, 180, 'h3', '功能卡片 2\n图表区块，占位'),
        box(960, 420, 360, 180, 'h3', '功能卡片 3\n图表区块，占位'),
        box(0, 660, 1440, 140, 'h2', '底部 CTA：再来一次转化\n按钮：免费注册'),
        box(0, 800, 1440, 100, 'box', '页脚：链接分组 + 版权信息'),
      ],
    },
    {
      id: 'aMobile', name: '首页 · 手机', device: 'm390', w: 390, h: 844,
      boxes: [
        box(0, 0, 390, 56, 'h2', '顶部栏：返回箭头 + 标题 + 右侧图标'),
        box(16, 80, 358, 96, 'h1', '主标题：两行以内\n副标题一行'),
        box(16, 196, 358, 160, 'h3', '主视觉 / 轮播图'),
        box(16, 372, 358, 72, 'p', '列表项：左图标 + 标题 + 描述'),
        box(16, 452, 358, 72, 'p', '列表项：左图标 + 标题 + 描述'),
        box(16, 532, 358, 72, 'p', '列表项：左图标 + 标题 + 描述'),
        box(16, 640, 358, 48, 'p', '主按钮：立即开始'),
        box(0, 776, 390, 68, 'h2', '底部标签栏：首页 / 发现 / 我的'),
      ],
    },
  ],
};

let pendingExport = null;

function captureOne(job) {
  return new Promise((resolve, reject) => {
    const w = Math.round(job.width), h = Math.round(job.height);
    const win = new BrowserWindow({
      show: false, width: w, height: h, useContentSize: true, frame: false,
      resizable: true, backgroundColor: job.bg || '#ffffff',
      webPreferences: {
        preload: path.join(ROOT, 'preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: false,
        backgroundThrottling: false,
        additionalArguments: ['--app-mode=export'],
      },
    });
    pendingExport = job;
    let target = { w, h };
    let done = false;
    const onLayout = (ev, lw, lh) => {
      if (done || ev.sender !== win.webContents) return;
      target = { w: Math.max(1, Math.ceil(lw)), h: Math.max(1, Math.ceil(lh)) };
    };
    ipcMain.on('export:layout', onLayout);
    const finish = (fn, arg) => {
      if (done) return; done = true;
      clearTimeout(timer);
      ipcMain.removeListener('export:ready', onReady);
      ipcMain.removeListener('export:layout', onLayout);
      try { if (!win.isDestroyed()) win.destroy(); } catch (_) {}
      fn(arg);
    };
    const timer = setTimeout(() => finish(reject, new Error('timeout')), 20000);
    const onReady = async (ev) => {
      if (done || ev.sender !== win.webContents) return;
      try {
        await new Promise((r) => setTimeout(r, 200));
        /* 顺手抓一下导出 DOM 里的框编号，核对 a1 / a2 / a3 … */
        let probe = '';
        try {
          probe = await win.webContents.executeJavaScript(
            `[...document.querySelectorAll('#export-root .box .oid')].map((e) => e.textContent).join(',')`);
        } catch (_) {}
        let img = await win.webContents.capturePage();
        if (img.isEmpty()) { await new Promise((r) => setTimeout(r, 300)); img = await win.webContents.capturePage(); }
        if (img.isEmpty()) throw new Error('empty');
        const s = img.getSize();
        if (s.width !== target.w || s.height !== target.h) img = img.resize({ width: target.w, height: target.h, quality: 'best' });
        finish(resolve, { img, probe });
      } catch (e) { finish(reject, e); }
    };
    ipcMain.on('export:ready', onReady);
    win.loadFile(path.join(SRC, 'index.html'), { query: { mode: 'export', id: job.artboardId } });
  });
}

ipcMain.handle('export:payload', () => pendingExport);
ipcMain.on('export:layout', (e, w, h) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win && !win.isDestroyed()) win.setContentSize(Math.ceil(w), Math.ceil(h), false);
});
ipcMain.on('window:title', () => {});
ipcMain.handle('clipboard:writeImage', () => ({ ok: true }));
ipcMain.handle('png:save', () => ({ ok: false }));
ipcMain.handle('project:save', () => ({ ok: false }));
ipcMain.handle('project:open', () => ({ ok: false }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const log = [];
  try {
    /* ---- 1. 主界面 ---- */
    const win = new BrowserWindow({
      width: 1480, height: 940, show: false, backgroundColor: '#eceef2',
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#ffffff', symbolColor: '#3f4653', height: 46 },
      webPreferences: {
        preload: path.join(ROOT, 'preload.js'),
        contextIsolation: true, sandbox: false, backgroundThrottling: false,
      },
    });
    await win.loadFile(path.join(SRC, 'index.html'));
    await win.webContents.executeJavaScript(
      `localStorage.setItem(${JSON.stringify(LS_KEY)}, ${JSON.stringify(JSON.stringify(SAMPLE))}); location.reload();`);
    await new Promise((r) => win.webContents.once('did-finish-load', r));
    await sleep(1200);
    const ui = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, '01-ui.png'), ui.toPNG());
    log.push('01-ui.png ' + JSON.stringify(ui.getSize()));

    /* 界面上的框编号必须按顺序连续（每个画板各一套 a1、a2…） */
    const uiLabels = await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('.artboard')].map((be) =>
         [...be.querySelectorAll('.box .oid')].map((e) => e.textContent).join(','))`);
    log.push('[编号] 界面： ' + uiLabels.join('  |  '));

    /* 编号必须落在所属框的范围内（左下角），不能越界 */
    const oidGeom = await win.webContents.executeJavaScript(`(() => {
      const bad = [];
      document.querySelectorAll('.box').forEach((box) => {
        const o = box.querySelector('.oid');
        if (!o) { bad.push('缺少编号: ' + box.dataset.id); return; }
        const b = box.getBoundingClientRect(), r = o.getBoundingClientRect();
        const inX = r.left >= b.left - 1 && r.right <= b.right + 1;
        const inY = r.top >= b.top - 1 && r.bottom <= b.bottom + 1;
        const leftHalf = (r.left + r.width / 2) < (b.left + b.width / 2);
        const bottomHalf = (r.top + r.height / 2) > (b.top + b.height / 2);
        if (!inX || !inY || !leftHalf || !bottomHalf) {
          bad.push(o.textContent + ' 越界或位置不对');
        }
      });
      const total = document.querySelectorAll('.box .oid').length;
      return '共 ' + total + ' 个编号，全部位于左下角且未越界: ' + (bad.length === 0) +
        (bad.length ? ' → ' + bad.join('; ') : '');
    })()`);
    log.push('[编号] ' + oidGeom);

    /* 删掉中间的框 → 编号必须自动重排，仍然是连续的 a1、a2… */
    const renumber = await win.webContents.executeJavaScript(`(async () => {
      const be = document.querySelector('.artboard');
      const boxes = [...be.querySelectorAll('.box')];
      const before = boxes.map((d) => d.querySelector('.oid').textContent).join(',');
      const t = boxes[2];
      const r = t.getBoundingClientRect();
      t.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, button: 0, pointerId: 1, isPrimary: true,
        clientX: r.left + 6, clientY: r.top + 6,
      }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
      await new Promise((res) => setTimeout(res, 80));
      const after = [...be.querySelectorAll('.box')].map((d) => d.querySelector('.oid').textContent).join(',');
      return '删第 3 个框： ' + before + '  ->  ' + after;
    })()`);
    log.push('[编号] ' + renumber);

    /* ---- 2. 单画板导出（带规格条 + 文字清单）---- */
    for (const a of SAMPLE.artboards) {
      const shot = await captureOne({
        project: SAMPLE, artboardId: a.id, width: a.w, height: a.h, bg: '#ffffff',
        stripH: 30, stripText: `${a.name} · ${a.w} × ${a.h}`,
        showLegend: true, label: a.name,
      });
      fs.writeFileSync(path.join(OUT, `02-${a.device}.png`), shot.img.toPNG());
      log.push(`02-${a.device}.png ` + JSON.stringify(shot.img.getSize()));
      log.push(`[编号] 导出 ${a.device}： ${shot.probe}`);
    }
  } catch (err) {
    log.push('ERROR ' + (err && err.stack ? err.stack : err));
  }
  fs.writeFileSync(path.join(OUT, 'report.txt'), log.join('\n'), 'utf8');
  console.log(log.join('\n'));
  app.exit(0);
});
