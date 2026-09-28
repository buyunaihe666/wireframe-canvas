/*
 * 可靠地删除大型构建产物目录。
 *
 * 为什么不用 fs.rmSync：
 *   在本机（Windows + 中文用户名路径）上，fs.rmSync 删除 300MB+ 目录时会
 *   卡死在 0% CPU 不动，最终把整个 electron-builder 构建拖挂。
 *   robocopy /MIR 是 Windows 官方的镜像删除，对海量小文件 + 长路径
 *   + 文件锁的容忍度高得多，且失败会重试而不是无限期挂起。
 *
 * 用法：
 *   node tools/clean.js            # 清理 release/（默认）
 *   node tools/clean.js <dir>...   # 清理指定目录
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function robocopyMirror(target) {
  // 建一个空目录作为“源”，镜像到目标 = 清空目标
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-empty-'));
  try {
    const r = spawnSync(
      'robocopy',
      [empty, target, '/MIR', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1'],
      { stdio: 'ignore', windowsHide: true }
    );
    // robocopy: 0-7 表示成功（含“已删除文件”），>=8 才是真失败
    return r.status !== null && r.status < 8;
  } finally {
    try { fs.rmdirSync(empty); } catch (_) {}
  }
}

function removeDir(dir) {
  if (!fs.existsSync(dir)) {
    console.log('skip (不存在):', dir);
    return true;
  }
  const before = sizeOf(dir);
  console.log(`清理 ${dir}  (${before}) …`);
  const ok = robocopyMirror(dir);
  // robocopy 会保留目标目录本身，且可能留下空的子目录
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  const gone = !fs.existsSync(dir);
  console.log(gone ? '  完成' : `  ${ok ? '部分' : '失败'}：仍有残留 ${sizeOf(dir)}`);
  return gone;
}

function sizeOf(dir) {
  let n = 0;
  const walk = (p) => {
    let ents;
    try { ents = fs.readdirSync(p, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      const f = path.join(p, e.name);
      if (e.isDirectory()) walk(f);
      else { try { n += fs.statSync(f).size; } catch (_) {} }
    }
  };
  walk(dir);
  return (n / 1024 / 1024).toFixed(1) + 'MB';
}

const targets = process.argv.slice(2);
const list = targets.length ? targets : [path.join(ROOT, 'dist'), path.join(ROOT, 'dist-portable')];

module.exports = { removeDir, sizeOf, robocopyMirror };

// 仅在被直接调用时执行 CLI，被 require 时只导出工具函数
if (require.main === module) {
  let allOk = true;
  for (const t of list) allOk = removeDir(path.resolve(t)) && allOk;
  process.exit(allOk ? 0 : 1);
}
