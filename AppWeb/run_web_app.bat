@echo off
setlocal
cd /d "%~dp0"

where py >nul 2>nul
if %errorlevel%==0 (
  set "PYTHON_CMD=py -3"
) else (
  set "PYTHON_CMD=python"
)

echo Starting ETVIEW Web at http://localhost:8080
start "ETVIEW Web Server" /min %PYTHON_CMD% -m http.server 8080 --bind 127.0.0.1
timeout /t 1 /nobreak >nul
start "" http://localhost:8080

