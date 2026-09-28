@echo off
rem Launch Wireframe Canvas from source (no packaging needed)
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Electron runtime not found. Run: npm install
  echo If the binary is missing, run:
  echo   set ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/
  echo   node node_modules\electron\install.js
  pause
  exit /b 1
)
start "" "node_modules\electron\dist\electron.exe" .
