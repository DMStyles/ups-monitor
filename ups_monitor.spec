# -*- mode: python ; coding: utf-8 -*-
"""
UPS Power Monitor — PyInstaller spec
Bundles all Python code, dependencies, templates, and static assets
into a single-directory dist that works without Python installed.
"""

import os
from pathlib import Path

SRC = Path(".")

a = Analysis(
    [str(SRC / "ups_monitor.py")],
    pathex=[str(SRC)],
    binaries=[],
    datas=[
        # Include HTML templates and static assets
        (str(SRC / "templates"), "templates"),
        (str(SRC / "static"), "static"),
    ],
    hiddenimports=[
        # Flask internals
        "flask",
        "flask.templating",
        "jinja2",
        "werkzeug",
        "werkzeug.serving",
        # HID (direct USB)
        "hid",
        "hidapi",
        # Image
        "PIL",
        "PIL.Image",
        "PIL.ImageDraw",
        "PIL.ImageFont",
        # Tray
        "pystray",
        "pystray._win32",
        # WebView
        "webview",
        "webview.platforms.winforms",
        "clr",
        # DB
        "sqlite3",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["tkinter", "test", "unittest"],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="UPS Power Monitor",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,          # no console window (windowsed app)
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=str(SRC / "static" / "favicon.ico"),
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="UPS Power Monitor",
)
