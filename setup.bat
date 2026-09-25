@echo off
rem ============================================================
rem  Lumen Workbench - one-click launcher (lightweight shell)
rem  Requirements: Windows 10+ and Node.js 18 or newer.
rem  First run: installs Electron via npm (npmmirror for speed).
rem  Then: starts the desktop window. Double-click me next time.
rem  No Node.js? Use the setup.exe instead:
rem  https://github.com/lyz0v0/lumen-workbench/releases/latest
rem ============================================================
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [Lumen] Node.js is not installed.
  echo         Please install Node.js 18 or newer (LTS recommended):
  echo         https://nodejs.org
  echo         Or download the no-install setup.exe instead:
  echo         https://github.com/lyz0v0/lumen-workbench/releases/latest
  pause
  exit /b 1
)

set NODE_VER=unknown
for /f "tokens=*" %%v in ('node -v') do set NODE_VER=%%v
set NODE_MAJOR=0
for /f "tokens=1 delims=v." %%a in ("%NODE_VER%") do set NODE_MAJOR=%%a
if %NODE_MAJOR% LSS 18 (
  echo [Lumen] Node.js %NODE_VER% is too old. Node.js 18 or newer is required.
  echo         Download the current LTS version from:
  echo         https://nodejs.org
  echo         Or download the no-install setup.exe instead:
  echo         https://github.com/lyz0v0/lumen-workbench/releases/latest
  pause
  exit /b 1
)

echo [Lumen] Node.js %NODE_VER% OK.

if not exist "node_modules\electron\dist\electron.exe" (
  echo [Lumen] First run: installing Electron, please wait...
  set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [Lumen] npm install failed. Check your network and try again.
    pause
    exit /b 1
  )
)

start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
endlocal
