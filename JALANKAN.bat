@echo off
title Memecoin Dev Tracker
cd /d "%~dp0"
echo Memecoin Dev Tracker jalan di http://localhost:3456
start "" http://localhost:3456
node server.js
pause
