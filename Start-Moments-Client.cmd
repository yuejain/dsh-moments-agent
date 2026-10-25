@echo off
rem DSH Moments Agent client launcher (modern web client, Windows).
rem One elevated Python process hosts both client and desktop executor.
rem Keep this file ASCII-only: cmd.exe misparses multi-byte characters after chcp.
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"

set "DSH_PYTHON=D:\dsh\resources\runtime\primary-runtime\dependencies\python\python.exe"
set "PYTHON_EXE="

if exist "%DSH_PYTHON%" (
  set "PYTHON_EXE=%DSH_PYTHON%"
) else (
  where python >nul 2>nul
  if not errorlevel 1 set "PYTHON_EXE=python"
)

if not defined PYTHON_EXE (
  echo [ERROR] Python interpreter not found.
  echo         Expected DSH bundled Python at:
  echo         %DSH_PYTHON%
  echo.
  pause
  exit /b 1
)

echo Starting DSH Moments Agent client...
echo Python: %PYTHON_EXE%
echo Local UI: http://127.0.0.1:18770/
echo Close the app window to stop the local service automatically.
echo.
"%PYTHON_EXE%" -X utf8 "client\server.py" --port 18770 %*
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo.
  echo [ERROR] Client exited with code %EXIT_CODE%. See output above.
  pause
)
exit /b %EXIT_CODE%
