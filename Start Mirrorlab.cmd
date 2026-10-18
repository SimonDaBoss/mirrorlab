@echo off
rem Mirrorlab - first run installs dependencies (one time), then builds and launches.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 20+ is required: https://nodejs.org & pause & exit /b 1)
if not exist "node_modules\electron\dist\electron.exe" (
  echo First run: installing dependencies, about 250 MB, one time...
  call npm install || (pause & exit /b 1)
)
if not exist "resources\airplay\win32\uxplay.exe" call npm run build:airplay || (pause & exit /b 1)
if not exist "resources\usb\win32\iphone-usb.exe" call npm run build:usb || (pause & exit /b 1)
call npm run build || (pause & exit /b 1)
start "" "node_modules\electron\dist\electron.exe" .
