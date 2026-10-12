@echo off
title LaunchPad Panel
cd /d "%~dp0"

rem Already running? Just open the browser and exit.
curl -s -o nul --max-time 2 http://127.0.0.1:7788/ && (
  start "" http://127.0.0.1:7788
  exit /b
)

rem Start server minimized; the server opens the browser itself when ready (LP_OPEN=1).
set LP_OPEN=1
start "LaunchPad-Server" /min cmd /c "node server.js"
echo LaunchPad panel is starting. Your browser will open automatically.
echo To stop the panel, close the minimized "LaunchPad-Server" window.
exit /b
