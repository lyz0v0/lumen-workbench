@echo off
rem ============================================================
rem  Lumen Workbench - one-click launcher (lightweight shell)
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
  echo         Install Node.js from https://nodejs.org
  echo         Or download the no-install setup.exe from:
  echo         https://github.com/lyz0v0/lumen-workbench/releases/latest
  pause
  exit /b 1
)

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
