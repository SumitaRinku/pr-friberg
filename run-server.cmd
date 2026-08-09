@echo off
cd /d "%~dp0"
node admin-server.mjs
if errorlevel 1 pause
