@echo off
setlocal enabledelayedexpansion

echo ============================================
echo  UPS Power Monitor - Build Release v1.4.2
echo ============================================

REM --- Check Python ---
python --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Python not found. Please install Python 3.12+
    pause
    exit /b 1
)

REM --- Install/upgrade pip dependencies ---
echo [1/4] Installing Python dependencies...
pip install flask requests pywebview pystray pillow beautifulsoup4 pyinstaller --quiet

REM --- Build with PyInstaller ---
echo [2/4] Building standalone app with PyInstaller...
pyinstaller ups_monitor.spec --clean --noconfirm
if errorlevel 1 (
    echo ERROR: PyInstaller build failed!
    pause
    exit /b 1
)

REM --- Find Inno Setup ---
echo [3/4] Looking for Inno Setup...
set ISCC=
for %%P in (
    "C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
    "C:\Program Files\Inno Setup 6\ISCC.exe"
    "C:\Program Files (x86)\Inno Setup 5\ISCC.exe"
) do (
    if exist %%P (
        set ISCC=%%P
        goto :found_iscc
    )
)
REM search in user-local install locations
for /f "tokens=*" %%G in ('dir /b /s "%LOCALAPPDATA%\Programs\Inno Setup*\ISCC.exe" 2^>nul') do (
    set ISCC=%%G
    goto :found_iscc
)

:found_iscc
if "%ISCC%"=="" (
    echo WARNING: Inno Setup not found - skipping installer build.
    echo You can install it from https://jrsoftware.org/isdl.php
    goto :release_zip
)

echo Found Inno Setup: %ISCC%
mkdir release 2>nul
%ISCC% installer.iss
if errorlevel 1 (
    echo ERROR: Inno Setup compilation failed!
    pause
    exit /b 1
)
echo [4/4] Installer created in release\ folder.
goto :done

:release_zip
echo [4/4] Creating ZIP release instead...
mkdir release 2>nul
powershell -Command "Compress-Archive -Path 'dist\UPS Power Monitor\*' -DestinationPath 'release\UPS-Power-Monitor-v1.4.2-portable.zip' -Force"
echo ZIP created: release\UPS-Power-Monitor-v1.4.2-portable.zip

:done
echo.
echo ============================================
echo  Build complete! Files are in: release\
echo ============================================
pause
