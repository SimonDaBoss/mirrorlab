@echo off
rem Builds a portable Mirrorlab.exe in out\Mirrorlab-win32-x64 (no install needed to run it).
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 20+ is required: https://nodejs.org & pause & exit /b 1)
if not exist "node_modules\electron\dist\electron.exe" call npm install || (pause & exit /b 1)
if not exist "resources\airplay\win32\uxplay.exe" call npm run build:airplay || (pause & exit /b 1)
if not exist "resources\usb\win32\iphone-usb.exe" call npm run build:usb || (pause & exit /b 1)
call npm run package:win || (pause & exit /b 1)
explorer "out\Mirrorlab-win32-x64"
