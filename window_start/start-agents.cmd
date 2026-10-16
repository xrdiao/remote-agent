@echo off
setlocal
cd /d "%~dp0"
start "Remote Agent startup" powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-agents.ps1"
exit /b %ERRORLEVEL%
