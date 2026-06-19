@echo off
title UPS Power Monitor — Transition Setup
echo.
echo ========================================================
echo   UPS Power Monitor  ^|  Transition to Packaged Version
echo ========================================================
echo.
echo This script will:
echo 1. Remove the old Task Scheduler autostart task (requires Admin)
echo 2. Launch the new Installer setup to install the app permanently
echo.
echo Please run this script as Administrator. If you did not, 
echo please close this window, right-click clean_old_setup.bat, 
echo and select "Run as administrator".
echo.
pause

echo.
echo [1/2] Deleting old Task Scheduler autostart task...
schtasks /delete /tn "UPS Power Monitor" /f

echo.
echo [2/2] Launching the new Installer setup...
start "" "%~dp0release\UPS-Power-Monitor-Setup-v1.4.0.exe"

echo.
echo Clean up complete! Follow the installation wizard to complete setup.
echo.
pause
