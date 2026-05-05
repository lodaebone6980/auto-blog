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

set "TASK_NAME=NaviWrite Runner"
set "RUNNER_CMD=%~dp0start-runner.cmd"

schtasks /Create /TN "%TASK_NAME%" /SC ONLOGON /TR "\"%RUNNER_CMD%\"" /RL LIMITED /F >nul
if errorlevel 1 (
  echo [NaviWrite Runner] Windows 자동실행 등록에 실패했습니다.
  echo start-runner.cmd를 직접 실행하거나, 이 파일을 다시 실행해 주세요.
  pause
  exit /b 1
)

echo [NaviWrite Runner] Windows 로그인 시 자동 실행되도록 등록했습니다.
echo 지금 Runner도 바로 실행합니다.
start "NaviWrite Runner" "%RUNNER_CMD%"
timeout /t 2 >nul
echo.
echo 설치 후 확인 주소:
echo http://127.0.0.1:39271/health
pause
