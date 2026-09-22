@echo off
rem ============================================================================
rem DataBridge 一键启动（开发模式，三窗口）
rem   start-dev.cmd            使用 node-express-boilerplate\.env 里的 DB_DRIVER（当前=mysql）
rem   start-dev.cmd memory     强制内存 mock 模式（不碰数据库）
rem   start-dev.cmd mysql      强制 MySQL 持久化模式
rem 停止请用 stop-dev.cmd（按端口杀进程）
rem ============================================================================
setlocal
set ROOT=%~dp0

if /I "%~1"=="memory" set DB_DRIVER=memory
if /I "%~1"=="mysql"  set DB_DRIVER=mysql

echo [1/3] 启动 Go 同步引擎 :8080 ...
start "databridge-engine" cmd /k "cd /d %ROOT%databridge-engine && set SERVER_PORT=8080&& set NODE_REPORT_URL=http://127.0.0.1:3001/api/v1/engine&& go run ./cmd/server -conf config/local.yml"

rem 等引擎起来再拉后端（管道/任务回报不至于丢首包）
timeout /t 5 /nobreak >nul

echo [2/3] 启动 Node 管理后端 :3001（DB_DRIVER=%DB_DRIVER%（空则读 .env））...
start "databridge-admin" cmd /k "cd /d %ROOT%node-express-boilerplate && if not "%DB_DRIVER%"=="" set DB_DRIVER=%DB_DRIVER% && node src/index.js"

timeout /t 3 /nobreak >nul

echo [3/3] 启动 Vue 前端 :3100 ...
start "databridge-web" cmd /k "cd /d %ROOT%vue-vben-admin && pnpm dev"

echo.
echo 启动完成（各窗口独立运行，关窗即停单个服务）：
echo   前端      http://localhost:3100   登录 vben / 123456
echo   管理后端  http://localhost:3001/api/v1/health
echo   同步引擎  http://localhost:8080/health
echo 停止全部：stop-dev.cmd
endlocal
