@echo off
setlocal
set "TASK_NAME=NaviWrite Runner"

schtasks /Delete /TN "%TASK_NAME%" /F >nul 2>nul
if errorlevel 1 (
  echo [NaviWrite Runner] 등록된 자동실행 작업을 찾지 못했습니다.
) else (
  echo [NaviWrite Runner] Windows 자동실행 등록을 해제했습니다.
)
pause
