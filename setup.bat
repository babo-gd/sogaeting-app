@echo off
rem Launcher only: the real steps are in setup.ps1 (cmd garbles Korean text in .bat files)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
pause
