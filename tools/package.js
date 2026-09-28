/* 便携版打包：把 Electron 运行时 + 应用代码组装成一个可直接双击运行的文件夹。
   不依赖 electron-builder，不需要额外下载任何东西。
   运行： node tools/package.js
   输出： dist-portable/线框画布-win32-x64/    （与 electron-builder 的 dist/ 互不干扰） */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');
const OUT_ROOT = path.join(ROOT, 'dist-portable');
const APP_NAME = '线框画布';
const OUT = path.join(OUT_ROOT, `${APP_NAME}-win32-x64`);

const log = (...a) => console.log(...a);

/* 自己实现递归复制：Windows 上 fs.cpSync 遇到「\\?\ 长路径前缀 + 非 ASCII 目标目录」会报 EIO */
function copyTree(src, dest, skip = () => false) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (skip(s, e.name)) continue;
    if (e.isDirectory()) copyTree(s, d, skip);
    else if (e.isFile()) fs.copyFileSync(s, d);
    // 符号链接一律跳过（Electron 运行时里用不到）
  }
}

if (!fs.existsSync(DIST)) {
  console.error('找不到 Electron 运行时，请先执行： npm install');
  process.exit(1);
}

log('清理输出目录 …');
require('./clean.js').removeDir(OUT);
fs.mkdirSync(OUT, { recursive: true });

log('复制 Electron 运行时（约 250MB，请稍候）…');
copyTree(DIST, OUT, (_s, name) => name === 'default_app.asar');

log('重命名可执行文件 …');
const exe = path.join(OUT, `${APP_NAME}.exe`);
fs.renameSync(path.join(OUT, 'electron.exe'), exe);

log('组装应用 …');
const appDir = path.join(OUT, 'resources', 'app');
fs.mkdirSync(appDir, { recursive: true });
copyTree(path.join(ROOT, 'src'), path.join(appDir, 'src'));
fs.copyFileSync(path.join(ROOT, 'main.js'), path.join(appDir, 'main.js'));
fs.copyFileSync(path.join(ROOT, 'preload.js'), path.join(appDir, 'preload.js'));
if (fs.existsSync(path.join(ROOT, 'build', 'app.ico'))) {
  fs.mkdirSync(path.join(appDir, 'build'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'build', 'app.ico'), path.join(appDir, 'build', 'app.ico'));
}
fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({
  name: 'wireframe-canvas',
  productName: APP_NAME,
  version: require(path.join(ROOT, 'package.json')).version,
  description: '多端线框画布',
  main: 'main.js',
}, null, 2), 'utf8');

// 精简：移除 Electron 自带的默认应用示例（已在复制阶段跳过）

fs.writeFileSync(path.join(OUT, '使用说明.txt'),
  `${APP_NAME} —— 多端线框画布\r\n` +
  `\r\n` +
  `双击「${APP_NAME}.exe」即可运行，免安装，可整个文件夹拷到任意位置（U 盘也行）。\r\n` +
  `首次运行会在同目录生成配置；工程数据默认自动保存在本地。\r\n` +
  `\r\n` +
  `基本用法\r\n` +
  `  1. 点「新建画板」按设备尺寸（手机 / 平板 / 桌面）建画板，画板尺寸就是真实设备视口尺寸。\r\n` +
  `  2. 在画板空白处拖拽拉出文本框，双击框内输入这一块要放什么。\r\n` +
  `  3. 点框右下角的小标签切换层级：h1 → h2 → h3 → p → box。\r\n` +
  `  4. 点右上角「截图」，图片直接进剪贴板，Ctrl+V 粘贴给任意大模型。\r\n` +
  `\r\n` +
  `快捷键\r\n` +
  `  Ctrl+Shift+C   复制当前画板截图\r\n` +
  `  Ctrl+Shift+A   复制全部画板（拼接成一张）\r\n` +
  `  Ctrl+S / Ctrl+O 保存 / 打开工程\r\n` +
  `  Ctrl+Z / Ctrl+Shift+Z 撤销 / 重做\r\n` +
  `  Ctrl+D 复制框   Delete 删除框   方向键微调（Shift 加速）\r\n` +
  `  Ctrl+1..5 直接设为 h1/h2/h3/p/box\r\n` +
  `  Ctrl+滚轮 缩放   Ctrl+0 适应窗口   空格+拖拽 平移\r\n` +
  `  Alt+拖拽 临时关闭对齐吸附\r\n`,
  'utf8');

const size = (() => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
    .reduce((s, e) => s + (e.isDirectory() ? walk(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0);
  return walk(OUT);
})();

log('');
log('打包完成：' + OUT);
log(`可执行文件：${exe}`);
log(`总大小：${(size / 1024 / 1024).toFixed(1)} MB`);
