/* 生成应用图标 app.ico（多尺寸 PNG 内嵌 ICO）
   运行： node_modules/.bin/electron tools/makeicon.js  */
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, '..', 'build');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

const PAGE = `<!doctype html><html><body style="margin:0"><canvas id="c"></canvas>
<script>
function draw(ctx, S){
  const k = S / 256;
  ctx.clearRect(0,0,S,S);
  ctx.save(); ctx.scale(k,k);

  // 背景：圆角方块 + 渐变
  const g = ctx.createLinearGradient(0,0,256,256);
  g.addColorStop(0,'#3f7df6'); g.addColorStop(1,'#7a5cf0');
  ctx.fillStyle = g;
  const r = 58;
  ctx.beginPath();
  ctx.moveTo(r,0); ctx.lineTo(256-r,0); ctx.quadraticCurveTo(256,0,256,r);
  ctx.lineTo(256,256-r); ctx.quadraticCurveTo(256,256,256-r,256);
  ctx.lineTo(r,256); ctx.quadraticCurveTo(0,256,0,256-r);
  ctx.lineTo(0,r); ctx.quadraticCurveTo(0,0,r,0);
  ctx.closePath(); ctx.fill();

  // 多端线框：手机 + 桌面
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 6; ctx.lineJoin = 'round';
  const rr = (x,y,w,h,rad)=>{
    ctx.beginPath();
    ctx.moveTo(x+rad,y); ctx.lineTo(x+w-rad,y); ctx.quadraticCurveTo(x+w,y,x+w,y+rad);
    ctx.lineTo(x+w,y+h-rad); ctx.quadraticCurveTo(x+w,y+h,x+w-rad,y+h);
    ctx.lineTo(x+rad,y+h); ctx.quadraticCurveTo(x,y+h,x,y+h-rad);
    ctx.lineTo(x,y+rad); ctx.quadraticCurveTo(x,y,x+rad,y);
    ctx.closePath(); ctx.stroke();
  };
  rr(44,54,64,148,12);      // 手机
  rr(126,54,86,62,10);      // 桌面：导航条
  rr(126,130,86,72,10);     // 桌面：内容区
  ctx.restore();
}
window.__render = (S)=>{
  const c = document.getElementById('c');
  c.width = S; c.height = S;
  const ctx = c.getContext('2d');
  draw(ctx, S);
  return c.toDataURL('image/png');
};
<\/script></body></html>`;

/* ---- ICO 封装（每个尺寸内嵌 PNG，Windows Vista+ 支持） ---- */
function buildIco(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);   // reserved
  header.writeUInt16LE(1, 2);   // type = icon
  header.writeUInt16LE(count, 4);

  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  entries.forEach((e, i) => {
    const o = i * 16;
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, o + 0);   // width
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, o + 1);   // height
    dir.writeUInt8(0, o + 2);                            // palette
    dir.writeUInt8(0, o + 3);                            // reserved
    dir.writeUInt16LE(1, o + 4);                         // planes
    dir.writeUInt16LE(32, o + 6);                        // bpp
    dir.writeUInt32LE(e.png.length, o + 8);              // size
    dir.writeUInt32LE(offset, o + 12);                   // offset
    offset += e.png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({
    show: false, width: 300, height: 300,
    webPreferences: { contextIsolation: false, nodeIntegration: false, offscreen: true },
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE));
  const entries = [];
  for (const s of SIZES) {
    const dataUrl = await win.webContents.executeJavaScript(`window.__render(${s})`);
    const png = Buffer.from(dataUrl.split(',')[1], 'base64');
    fs.writeFileSync(path.join(OUT, `icon-${s}.png`), png);
    entries.push({ size: s, png });
  }
  fs.writeFileSync(path.join(OUT, 'app.ico'), buildIco(entries));
  console.log('icon ok:', entries.map((e) => e.size).join(','));
  app.exit(0);
});
