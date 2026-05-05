@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r=Invoke-WebRequest -Uri 'http://127.0.0.1:39271/health' -UseBasicParsing -TimeoutSec 5; Write-Host $r.Content; exit 0 } catch { Write-Host '[NaviWrite Runner] 연결 실패:' $_.Exception.Message; exit 1 }"
pause
