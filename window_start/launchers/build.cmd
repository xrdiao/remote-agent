@echo off
setlocal
cd /d "%~dp0"
set "OUT=%~dp0.."
set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" (
  echo 找不到 csc.exe
  exit /b 1
)

"%CSC%" /nologo /codepage:65001 /optimize /target:exe /out:"%OUT%\start-agents.exe" StartAgents.cs
if errorlevel 1 exit /b 1
"%CSC%" /nologo /codepage:65001 /optimize /target:exe /out:"%OUT%\pair.exe" Pair.cs
if errorlevel 1 exit /b 1
echo Built: window_start\start-agents.exe window_start\pair.exe
