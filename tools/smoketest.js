/*
 * 打包产物冒烟测试：从**副本**目录启动 exe，确认主进程能稳定常驻。
 *
 * 为什么必须从副本跑：
 *   运行中的 exe 会锁住所在目录。若从 dist/win-unpacked/ 直接跑，
 *   下一轮 electron-builder 删不掉该目录 → 构建无限期卡死（实测过）。
 *
 * 用法： node tools/smoketest.js <可执行文件所在目录>
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = process.argv[2] || path.join(__dirname, '..', 'dist', 'win-unpacked');
const exe = path.join(dir, '线框画布.exe');
const WAIT = 12000;

if (!fs.existsSync(exe)) {
  console.error('找不到可执行文件：' + exe);
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // 否则 Electron 退化成纯 node
delete env.NODE_OPTIONS;

console.log('启动：' + exe);
const child = spawn(exe, [], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });

let out = '';
let err = '';
let exited = null;
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { err += d; });
child.on('exit', (code, sig) => { exited = { code, sig }; });

setTimeout(() => {
  const alive = !exited; // 必须在 kill 之前取快照，否则会被自己的 kill 覆盖成「已退出」
  console.log('---');
  console.log(exited ? `✗ 已退出 code=${exited.code} sig=${exited.sig}` : `✓ 存活 ${WAIT / 1000}s，主进程稳定`);
  if (out.trim()) console.log('stdout:\n' + out.trim().slice(0, 800));
  if (err.trim()) console.log('stderr:\n' + err.trim().slice(0, 800));
  if (!out.trim() && !err.trim()) console.log('输出：(空 — 无报错)');

  try { child.kill(); } catch (_) {}
  // 给子进程一点时间收尾，避免它继续占用目录
  setTimeout(() => process.exit(alive ? 0 : 1), 1500);
}, WAIT);
