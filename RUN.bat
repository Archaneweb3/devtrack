@echo off
title Memecoin Dev Tracker
cd /d "%~dp0"
echo Memecoin Dev Tracker running at http://localhost:3456
start "" http://localhost:3456
node server.js
pause
