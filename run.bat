@echo off
rem Starts the Mindmap preview server and opens it in your browser.
setlocal
set PORT=8080
if not "%~1"=="" set PORT=%~1
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo Python was not found. Install it from https://www.python.org/downloads/ and make sure "Add to PATH" is ticked.
  pause
  exit /b 1
)
echo Mindmap running at http://127.0.0.1:%PORT%
echo Close this window to stop the server.
start "" "http://127.0.0.1:%PORT%/"
python scripts\serve.py %PORT%
