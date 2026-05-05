@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [NaviWrite Runner] Node.js를 찾을 수 없습니다.
  echo Node.js 18 이상을 설치한 뒤 다시 실행하세요.
  echo https://nodejs.org/
  pause
  exit /b 1
)

echo [NaviWrite Runner] Starting on http://127.0.0.1:39271
echo 이 창을 닫으면 Runner 연결이 끊깁니다.
node server.js
pause
