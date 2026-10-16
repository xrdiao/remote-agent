@echo off
setlocal
cd /d "%~dp0"

set "NODE="
where node >nul 2>&1 && for /f "delims=" %%i in ('where node') do (
  set "NODE=%%i"
  goto :have_node
)
for /d %%D in ("%~dp0..\.runtime\node*") do (
  if exist "%%~fD\node.exe" (
    set "NODE=%%~fD\node.exe"
    goto :have_node
  )
)
set "NODE=node"

:have_node
"%NODE%" "%~dp0pair-link.mjs"
set "ERR=%ERRORLEVEL%"
echo.
if not "%ERR%"=="0" (
  echo 启动中继、隧道或生成配对链接失败，请看上方提示。
  exit /b %ERR%
)
exit /b %ERR%
