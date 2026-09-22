@echo off
rem 按端口停止 DataBridge 三个 dev 服务（3100 前端 / 3001 管理后端 / 8080 引擎）
setlocal
for %%p in (3100 3001 8080) do (
  for /f "tokens=5" %%i in ('netstat -ano ^| findstr /R ":%%p .*LISTENING"') do (
    echo stopping port %%p (pid %%i)
    taskkill /PID %%i /F >nul 2>&1
  )
)
echo done.
endlocal
