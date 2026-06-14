@echo off
title UPS Monitor — Setup Windows Autostart
echo ============================================
echo   Setting up UPS Monitor to start with Windows
echo   (Uses Windows Task Scheduler — no UAC needed)
echo ============================================
echo.

set "SCRIPT_DIR=%~dp0"
set "TASK_NAME=UPS Power Monitor"
set "SCRIPT_PATH=%SCRIPT_DIR%start_ups_monitor_minimized.bat"

:: Remove existing task if present
schtasks /delete /tn "%TASK_NAME%" /f >nul 2>&1

:: Create scheduled task that runs at login for current user (minimized)
schtasks /create ^
  /tn "%TASK_NAME%" ^
  /tr "\"%SCRIPT_PATH%\"" ^
  /sc ONLOGON ^
  /delay 0000:30 ^
  /f

if errorlevel 1 (
    echo [ERROR] Failed to create scheduled task.
    pause
    exit /b 1
)

echo.
echo [OK] Autostart task created successfully!
echo      UPS Monitor will start automatically 30 seconds after you log in.
echo.
echo To remove autostart, run:
echo   schtasks /delete /tn "UPS Power Monitor" /f
echo.
pause
