@echo off
rem DSH Moments Agent - elevated client + geometry executor launcher (Windows).
rem Keep this file ASCII-only: cmd.exe misparses multi-byte characters after chcp.
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "scripts\start-client-admin.ps1" %*
if errorlevel 1 (
  echo.
  echo [ERROR] Admin launcher failed. See the PowerShell output above.
  pause
)
endlocal
