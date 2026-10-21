@echo off
cd /d "%~dp0"

rem 1) Start Ollama if it is not running yet
tasklist /FI "IMAGENAME eq ollama app.exe" | find /i "ollama app.exe" >nul
if errorlevel 1 start "" "%LOCALAPPDATA%\Programs\Ollama\ollama app.exe"

rem 2) If the app server is already running, just open the browser
netstat -ano | find ":5173" | find "LISTENING" >nul
if not errorlevel 1 (
  start "" http://localhost:5173
  exit /b 0
)

rem 3) Otherwise start the server and open the browser
start "" http://localhost:5173
node server.js
