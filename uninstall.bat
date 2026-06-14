@echo off
title UPS Monitor — Uninstall
echo.
echo  ========================================================
echo    UPS Power Monitor  ^|  Uninstall
echo  ========================================================
echo.
echo  This will stop the application, remove the autostart task,
echo  delete the desktop shortcut, and remove all files.
echo.
set /p "CONFIRM=Are you sure you want to uninstall? (Y/N): "
if /i not "%CONFIRM%"=="Y" (
    echo Uninstall cancelled.
    pause
    exit /b 0
)

echo.
echo [1/4] Stopping running processes...
powershell -Command "Get-CimInstance Win32_Process -Filter \"Name = 'pythonw.exe' or Name = 'python.exe'\" | Where-Object { $_.CommandLine -like '*ups_monitor.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

echo [2/4] Removing Windows Autostart task...
schtasks /delete /tn "UPS Power Monitor" /f >nul 2>&1

echo [3/4] Removing Desktop shortcut...
powershell -Command "$WshShell = New-Object -ComObject WScript.Shell; $Desktop = $WshShell.SpecialFolders.Item('Desktop'); Remove-Item -Path \"$Desktop\UPS Power Monitor.lnk\" -ErrorAction SilentlyContinue"

echo [4/4] Removing files...
del /q /f "%~dp0energy.db" >nul 2>&1
del /q /f "%~dp0ups_monitor.log" >nul 2>&1
del /q /f "%~dp0python_path.txt" >nul 2>&1
del /q /f "%~dp0start_ups_monitor.bat" >nul 2>&1
del /q /f "%~dp0start_ups_monitor_minimized.bat" >nul 2>&1
del /q /f "%~dp0setup_autostart.bat" >nul 2>&1
del /q /f "%~dp0install.bat" >nul 2>&1
del /q /f "%~dp0requirements.txt" >nul 2>&1
del /q /f "%~dp0README.md" >nul 2>&1
del /q /f "%~dp0ups_monitor.py" >nul 2>&1
rmdir /s /q "%~dp0static" >nul 2>&1
rmdir /s /q "%~dp0templates" >nul 2>&1
rmdir /s /q "%~dp0__pycache__" >nul 2>&1

echo.
echo [OK] Uninstallation complete!
echo.
pause
(goto) 2>nul ^& del "%~f0"
