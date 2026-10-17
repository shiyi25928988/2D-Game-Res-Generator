@echo off
rem One-click build for Windows. Double-click to build the NSIS installer.
rem Usage: build.bat [--dir] [--nsis] [--portable] [--all] [--no-typecheck] [--cn] [--proxy=URL]
setlocal
chcp 65001 >nul
cd /d "%~dp0"
set "CODE=1"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js 18+ first: https://nodejs.org
  goto :end
)

if not exist "node_modules\electron-builder" (
  echo [INFO] Dependencies missing, running npm install ...
  call npm install --no-audit --no-fund
  if errorlevel 1 goto :end
)

node "scripts\build.mjs" %*
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" echo [ERROR] Build failed with exit code %CODE%

:end
echo %cmdcmdline% | findstr /i /c:"build.bat" >nul
if not errorlevel 1 pause
exit /b %CODE%
