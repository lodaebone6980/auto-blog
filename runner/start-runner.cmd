@echo off
setlocal
cd /d "%~dp0"
echo Starting NaviWrite Local Runner...
echo.
node server.js
echo.
echo Runner stopped. Press any key to close.
pause > nul
