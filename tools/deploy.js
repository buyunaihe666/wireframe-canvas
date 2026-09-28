/*
 * 部署到用户级目录并创建桌面 / 开始菜单快捷方式。
 *
 * 为什么不直接把快捷方式指向 dist/win-unpacked/：
 *   运行中的 exe 会锁住它所在目录。若快捷方式指向构建输出目录，
 *   每次运行完这个应用，下一轮 electron-builder 就删不掉目录 → 构建无限期卡死。
 *   所以先镜像部署到 %LOCALAPPDATA%\Programs\线框画布，快捷方式只指向那里。
 *
 * 用法： node tools/deploy.js
 */
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'dist', 'win-unpacked');
const APP_NAME = '线框画布';
const TARGET = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', APP_NAME);
const EXE = path.join(TARGET, `${APP_NAME}.exe`);

const log = (...a) => console.log(...a);

if (!fs.existsSync(path.join(SRC, `${APP_NAME}.exe`))) {
  console.error(`找不到构建产物：${SRC}\\${APP_NAME}.exe`);
  console.error('请先执行： npm run dist:dir   （或 npm run dist）');
  process.exit(1);
}

/* ---------- 1. 关掉正在运行的旧实例，否则镜像复制会被文件锁挡住 ---------- */
function killRunning() {
  const script = [
    `$t = ${JSON.stringify(TARGET)}`,
    `$hit = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($t, 'OrdinalIgnoreCase') })`,
    `if ($hit.Count -gt 0) { $hit | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Seconds 2 }`,
    `[Console]::Out.Write('killed=' + $hit.Count)`,
  ].join('\n');
  const b64 = Buffer.from(script, 'utf16le').toString('base64');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64], { encoding: 'utf8' });
  return (r.stdout || '').trim() || 'killed=?';
}

log('检查正在运行的实例 …');
log('  ' + killRunning());

/* ---------- 2. 镜像部署（/MIR：目标多出来的文件会被清掉，保证与产物一致） ---------- */
log(`部署到 ${TARGET} …`);
const rc = spawnSync('robocopy', [SRC, TARGET, '/MIR', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1'],
  { stdio: 'ignore', windowsHide: true });
if (rc.status === null || rc.status >= 8) {
  console.error('robocopy 失败，status=' + rc.status);
  process.exit(1);
}
log('  完成');

/* ---------- 3. 创建快捷方式 ---------- */
// 用 -EncodedCommand 传脚本（UTF-16LE + base64），彻底绕开中文路径的编码问题；
// 返回结果写到 ASCII 路径的 JSON 文件再由 node 读取，同样避免 stdout 编码问题。
const RESULT_FILE = path.join(os.tmpdir(), 'wfc-deploy-result.json');

const ps = [
  `$ErrorActionPreference = 'Stop'`,
  `$exe = ${JSON.stringify(EXE)}`,
  `$dir = ${JSON.stringify(TARGET)}`,
  `$name = ${JSON.stringify(APP_NAME)}`,
  `$result = [ordered]@{ desktop = ''; startmenu = ''; errors = @() }`,
  `try {`,
  `  $ws = New-Object -ComObject WScript.Shell`,
  `  $targets = [ordered]@{`,
  `    desktop   = (Join-Path ([Environment]::GetFolderPath('Desktop'))  ($name + '.lnk'))`,
  `    startmenu = (Join-Path ([Environment]::GetFolderPath('Programs')) ($name + '.lnk'))`,
  `  }`,
  `  foreach ($key in $targets.Keys) {`,
  `    $lnk = $targets[$key]`,
  `    try {`,
  `      $parent = Split-Path $lnk -Parent`,
  `      if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }`,
  `      $sc = $ws.CreateShortcut($lnk)`,
  `      $sc.TargetPath = $exe`,
  `      $sc.WorkingDirectory = $dir`,
  `      $sc.IconLocation = $exe + ',0'`,
  `      $sc.Description = '多端线框画布 — 按设备尺寸画线框，一键截图给大模型'`,
  `      $sc.WindowStyle = 1`,
  `      $sc.Save()`,
  `      $result[$key] = $lnk`,
  `    } catch { $result.errors += ($lnk + ' :: ' + $_.Exception.Message) }`,
  `  }`,
  `} catch { $result.errors += $_.Exception.Message }`,
  `$json = $result | ConvertTo-Json -Compress`,
  `[System.IO.File]::WriteAllText(${JSON.stringify(RESULT_FILE)}, $json, (New-Object System.Text.UTF8Encoding $false))`,
].join('\n');

log('创建快捷方式 …');
try { fs.unlinkSync(RESULT_FILE); } catch (_) {}
const b64 = Buffer.from(ps, 'utf16le').toString('base64');
const r2 = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64], { encoding: 'utf8' });

let res = null;
try {
  res = JSON.parse(fs.readFileSync(RESULT_FILE, 'utf8').replace(/^\uFEFF/, ''));
} catch (_) {
  console.error('未能读回创建结果。PowerShell stderr：');
  console.error((r2.stderr || '').trim() || '(空)');
  process.exit(1);
}

log('  桌面快捷方式：' + (res.desktop || '(未创建)'));
log('  开始菜单：    ' + (res.startmenu || '(未创建)'));
if (res.errors && res.errors.length) {
  log('  错误：');
  res.errors.forEach((e) => log('    - ' + e));
}

/* ---------- 4. 复核 ---------- */
const ok = fs.existsSync(EXE) && res.desktop && fs.existsSync(res.desktop);
log('');
log(ok ? '✓ 部署完成，双击桌面「' + APP_NAME + '」即可使用' : '✗ 部署存在未完成项');
log('  程序位置：' + EXE);
log('  卸载方式：直接删除该目录 + 两个快捷方式即可（不写注册表）');
process.exit(ok ? 0 : 1);
