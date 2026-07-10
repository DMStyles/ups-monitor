"""
UPS Power Monitor v2.0.5
Standalone Windows desktop app — monitors UPS directly via USB HID (Megatec/Voltronic protocol).
Features: real-time dashboard, analytics, battery health tracker, on-battery warning theme,
          dynamic CEB bill estimator (D-2026/05 tariff), outage log, auto-updater, tray icon.
"""

import os
import sys
import json
import re
import time
import sqlite3
import supabase_sync
import requests
import logging
import threading
import subprocess
import winreg
from datetime import datetime, date, timedelta, timezone
from io import StringIO
from pathlib import Path

import hid
from flask import Flask, jsonify, render_template, request, Response
from PIL import Image, ImageDraw
import pystray

# ══════════════════════════════════════════════════════
#  VERSION
# ══════════════════════════════════════════════════════
VERSION = "v2.0.52"

# ══════════════════════════════════════════════════════
#  UPS MODEL DATABASE  (add more models here later)
# ══════════════════════════════════════════════════════
UPS_MODELS = {
    "Prolink PRO1201SFC": {
        "va":                    1200,
        "power_factor":          0.7,
        "max_watts":             840,
        "battery_wh":            196.8,          # 2 × 12 V × 8.2 Ah
        "battery_desc":          "2 × 12 V / 8.2 Ah",
        "input_range":           "140–300 VAC",
        "output_voltage":        "230 VAC ± 10 %",
        "waveform":              "Simulated Sine (battery) / Pure Sine (line)",
        "transfer_time":         "≤ 2 ms",
        "recharge_time":         "2–4 h to 90 %",
        "temperature_supported": False,   # No onboard temperature sensor
        # Battery health thresholds (2 × 12 V lead-acid in series = 24 V nominal)
        "battery_rated_v":       27.2,  # Healthy full charge (2 × 13.6 V)
        "battery_warn_v":        25.0,  # Fair — capacity starting to drop
        "battery_replace_v":     24.0,  # Poor — replace soon (2 × 12.0 V)
        # Standard SLA resting voltage → capacity lookup table (24V system).
        # These are resting voltages (no load). Under load, the caller adds
        # a compensation offset before looking up the table.
        # Source: standard sealed lead-acid discharge characteristics.
        "batt_curve": [
            (25.60, 100),
            (25.20,  95),
            (24.80,  90),
            (24.40,  80),
            (24.00,  70),
            (23.60,  60),
            (23.20,  50),
            (22.80,  40),
            (22.40,  30),
            (22.00,  20),
            (21.40,  10),
            (20.80,   0),
        ],
        # Max load-sag compensation (V) at 100% load for this 24V pack.
        # At full load (~840 W) the battery voltage sags approximately 2.4 V.
        "load_sag_v":  2.4,
    },
}





# ══════════════════════════════════════════════════════
#  PATHS
# ══════════════════════════════════════════════════════
BASE_DIR  = Path(__file__).parent
APP_NAME  = "UPS Power Monitor"
DATA_DIR  = Path(os.environ.get("APPDATA", Path.home())) / APP_NAME
DATA_DIR.mkdir(parents=True, exist_ok=True)

DB_PATH       = DATA_DIR / "energy.db"
LOG_PATH      = DATA_DIR / "ups_monitor.log"
SETTINGS_PATH = DATA_DIR / "settings.json"

# ══════════════════════════════════════════════════════
#  LOGGING
# ══════════════════════════════════════════════════════
logging.basicConfig(
    filename=str(LOG_PATH),
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger(__name__)

# ══════════════════════════════════════════════════════
#  SETTINGS
# ══════════════════════════════════════════════════════
DEFAULT_SETTINGS = {
    "ups_model":             "Prolink PRO1201SFC",
    "elec_rate":             30.0,
    "fast_poll_interval":    2,
    "db_write_interval":     60,
    "autostart":             False,
    "notifications_enabled": True,
    "low_battery_threshold": 20,
    "ntfy_topic":            "",
    "auto_shutdown_enabled": False,
    "auto_shutdown_action":  "shutdown",
    "auto_shutdown_pct":     10,
    "auto_shutdown_mins":    5,
    # CEB billing settings
    "billing_days":          30,
    "billing_tariff":        "domestic",
    # Battery health
    "battery_replaced_date": "",   # ISO date e.g. "2023-01-15"
    "health_alert_sent":     False, # prevent repeated poor-health notifications
    "gemini_api_key":        "",    # For Smart Assistant
    "auto_test_enabled":     False,
    "last_auto_test_date":   "",
}

settings: dict = {}


def load_settings() -> dict:
    try:
        if SETTINGS_PATH.exists():
            with open(SETTINGS_PATH) as f:
                saved = json.load(f)
            return {**DEFAULT_SETTINGS, **saved}
    except Exception as e:
        log.error(f"Settings load error: {e}")
    return dict(DEFAULT_SETTINGS)


def save_settings(s: dict):
    try:
        with open(SETTINGS_PATH, "w") as f:
            json.dump(s, f, indent=2)
    except Exception as e:
        log.error(f"Settings save error: {e}")


settings = load_settings()


def get_model_cfg() -> dict:
    model = settings.get("ups_model", "Prolink PRO1201SFC")
    return UPS_MODELS.get(model, next(iter(UPS_MODELS.values())))


# ══════════════════════════════════════════════════════
#  CONSTANTS
# ══════════════════════════════════════════════════════
UPS_VID          = 0x0665
UPS_PID          = 0x5161
DASHBOARD_PORT  = 8765
DASHBOARD_URL   = f"http://localhost:{DASHBOARD_PORT}"
MAX_READING_GAP = 300   # seconds — gaps > this = PC/app was off, skip for energy calc

# ══════════════════════════════════════════════════════
#  GLOBAL STATE
state_lock    = threading.Lock()
state_updated = threading.Event()   # signals SSE subscribers on every new poll
ups_state: dict = {
    "connected":         False,
    "ups_mode":          "Unknown",
    "input_voltage":     0.0,
    "output_voltage":    0.0,
    "frequency":         0.0,
    "load_percent":      0,
    "watts":             0.0,
    "battery_voltage":   0.0,
    "battery_capacity":  0,
    "temperature":       None,
    "runtime_estimate":  None,   # minutes remaining on battery
    "on_battery":        False,
    "beeper_on":         True,   # True = alarm active, False = muted
    "last_update":       None,
}

tray_icon  = None
_last_on_battery   = False
_outage_row_id     = None
_low_bat_notified  = False   # prevent repeated low-battery pings
_high_load_notified = False
_shutdown_triggered = False
_outage_start_time  = None

# ══════════════════════════════════════════════════════
#  WINDOWS AUTOSTART  (Task Scheduler — most reliable)
# ══════════════════════════════════════════════════════
_REG_RUN    = r"Software\Microsoft\Windows\CurrentVersion\Run"
_TASK_NAME  = "UPS Power Monitor"


def _find_launcher() -> str:
    """Return the best executable / script path to launch the app."""
    # Preferred: compiled .exe sitting next to this file
    exe = BASE_DIR / f"{APP_NAME}.exe"
    if exe.exists():
        return str(exe)
    # Compiled .exe next to sys.executable (PyInstaller one-file)
    exe2 = Path(sys.executable).with_name(f"{APP_NAME}.exe")
    if exe2.exists():
        return str(exe2)
    # Fall back to the .bat launcher created by install.bat
    bat = BASE_DIR / "start_ups_monitor_minimized.bat"
    if bat.exists():
        return str(bat)
    # Last resort: pythonw + this script
    pythonw = Path(sys.executable).with_name("pythonw.exe")
    if not pythonw.exists():
        pythonw = Path(sys.executable)
    return f'"{pythonw}" "{BASE_DIR / "ups_monitor.py"}" --minimized'


def set_autostart(enabled: bool):
    """Enable / disable autostart using Windows Task Scheduler (primary)
    and the Registry Run key (fallback compatibility)."""
    launcher = _find_launcher()

    # ── Task Scheduler ────────────────────────────────────────────────
    try:
        if enabled:
            # Delete old task first to avoid duplicates
            subprocess.run(
                ["schtasks", "/delete", "/tn", _TASK_NAME, "/f"],
                capture_output=True, shell=False
            )
            # Create a new ONLOGON task with a 30-second delay
            result = subprocess.run(
                [
                    "schtasks", "/create",
                    "/tn",    _TASK_NAME,
                    "/tr",    f'"{launcher}"',
                    "/sc",    "ONLOGON",
                    "/delay", "0000:30",
                    "/rl",    "HIGHEST",
                    "/f",
                ],
                capture_output=True, text=True, shell=False
            )
            if result.returncode != 0:
                log.warning(f"schtasks create failed: {result.stderr.strip()}")
        else:
            subprocess.run(
                ["schtasks", "/delete", "/tn", _TASK_NAME, "/f"],
                capture_output=True, shell=False
            )
    except Exception as e:
        log.error(f"Task Scheduler autostart error: {e}")

    # ── Registry Run (secondary / legacy) ─────────────────────────────
    try:
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, _REG_RUN, 0, winreg.KEY_SET_VALUE)
        if enabled:
            winreg.SetValueEx(key, APP_NAME, 0, winreg.REG_SZ, f'"{launcher}" --minimized')
        else:
            try:
                winreg.DeleteValue(key, APP_NAME)
            except FileNotFoundError:
                pass
        winreg.CloseKey(key)
    except Exception as e:
        log.error(f"Registry autostart error: {e}")


def get_autostart() -> bool:
    """Return True if the Task Scheduler task OR the Registry entry exists."""
    # Check Task Scheduler first
    try:
        r = subprocess.run(
            ["schtasks", "/query", "/tn", _TASK_NAME],
            capture_output=True, text=True, shell=False
        )
        if r.returncode == 0:
            return True
    except Exception:
        pass
    # Fallback: check Registry
    try:
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, _REG_RUN, 0, winreg.KEY_READ)
        winreg.QueryValueEx(key, APP_NAME)
        winreg.CloseKey(key)
        return True
    except Exception:
        return False


# ══════════════════════════════════════════════════════
#  NOTIFICATIONS  (via pystray & ntfy.sh)
# ══════════════════════════════════════════════════════
def notify(title: str, message: str, level: str = "info"):
    # Desktop Tray
    if settings.get("notifications_enabled", True):
        try:
            if tray_icon:
                tray_icon.notify(message, title)
        except Exception as e:
            log.debug(f"Notification error: {e}")
            
    # ntfy.sh Mobile Push Notification
    topic = settings.get("ntfy_topic", "").strip()
    if topic:
        try:
            # Map levels to ntfy tags and priorities
            tags_map = {
                "info": "information_source",
                "warning": "warning",
                "danger": "rotating_light",
                "success": "white_check_mark"
            }
            priority_map = {
                "info": "3",
                "warning": "4",
                "danger": "5",
                "success": "3"
            }
            
            headers = {
                "Title": title.encode('utf-8'),
                "Tags": tags_map.get(level, "zap"),
                "Priority": priority_map.get(level, "3")
            }
            
            requests.post(f"https://ntfy.sh/{topic}", 
                          data=message.encode('utf-8'), 
                          headers=headers, 
                          timeout=5)
        except Exception as e:
            log.debug(f"ntfy.sh push error: {e}")


# ══════════════════════════════════════════════════════
#  RUNTIME ESTIMATION
# ══════════════════════════════════════════════════════
def estimate_runtime(battery_pct: int, watts: float) -> int | None:
    """Estimate battery runtime in minutes with Peukert's law approximation."""
    if watts <= 0 or battery_pct <= 0:
        return None
        
    cfg = get_model_cfg()
    max_watts = cfg.get("max_watts", 840)
    
    # Lead-acid batteries lose significant usable capacity under high load (Peukert's effect).
    # At 100% load, a UPS battery might only deliver ~25% of its rated Wh before voltage drops too low.
    load_ratio = min(1.0, watts / max_watts)
    
    # Efficiency scales down from 85% at low load to 25% at max load
    peukert_efficiency = max(0.25, 0.85 - (0.60 * load_ratio))
    
    # UPS systems shut down before reaching 0% to prevent battery damage (typically ~15% reserve)
    usable_pct = max(0, battery_pct - 15) / 100.0
    
    available_wh = usable_pct * cfg.get("battery_wh", 196.8) * peukert_efficiency
    return max(0, int((available_wh / watts) * 60))


# ══════════════════════════════════════════════════════
#  DATABASE
# ══════════════════════════════════════════════════════
def init_db():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("""CREATE TABLE IF NOT EXISTS readings (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        ts               TEXT NOT NULL,
        date             TEXT NOT NULL,
        input_voltage    REAL,
        output_voltage   REAL,
        frequency        REAL,
        load_percent     INTEGER,
        watts            REAL,
        battery_voltage  REAL,
        battery_capacity INTEGER,
        ups_mode         TEXT,
        temperature      REAL
    )""")
    c.execute("""CREATE TABLE IF NOT EXISTS outages (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at        TEXT NOT NULL,
        ended_at          TEXT,
        duration_seconds  INTEGER,
        battery_at_start  INTEGER,
        battery_at_end    INTEGER
    )""")
    
    c.execute("""CREATE TABLE IF NOT EXISTS outage_snapshots (
        outage_id         INTEGER,
        ts                TEXT NOT NULL,
        battery_capacity  INTEGER,
        battery_voltage   REAL,
        watts             REAL,
        FOREIGN KEY(outage_id) REFERENCES outages(id)
    )""")
    
    c.execute("""CREATE TABLE IF NOT EXISTS ceb_bills (
        month             TEXT PRIMARY KEY,
        amount_lkr        REAL NOT NULL,
        calculated_kwh    REAL NOT NULL,
        ups_kwh           REAL NOT NULL
    )""")
    # Migrations — safe to run every time
    for col_def in ["temperature REAL"]:
        try:
            c.execute(f"ALTER TABLE readings ADD COLUMN {col_def}")
        except sqlite3.OperationalError:
            pass
            
    # Resolve stale outages (if the PC turned off during an outage)
    try:
        c.execute("SELECT id, started_at FROM outages WHERE ended_at IS NULL")
        stale_outages = c.fetchall()
        for oid, started_at in stale_outages:
            # Find the last reading after the outage started to use as the end time
            c.execute("SELECT ts, battery_capacity FROM readings WHERE ts >= ? ORDER BY ts DESC LIMIT 1", (started_at,))
            last_reading = c.fetchone()
            if last_reading:
                end_ts, bat_end = last_reading
                start_dt = datetime.fromisoformat(started_at)
                end_dt = datetime.fromisoformat(end_ts)
                if start_dt.tzinfo is None:
                    start_dt = start_dt.replace(tzinfo=timezone.utc)
                if end_dt.tzinfo is None:
                    end_dt = end_dt.replace(tzinfo=timezone.utc)
                duration = int((end_dt - start_dt).total_seconds())
                duration = max(0, duration)
            else:
                now_utc = datetime.now(timezone.utc)
                end_ts = now_utc.isoformat()
                bat_end = None
                start_dt = datetime.fromisoformat(started_at)
                if start_dt.tzinfo is None:
                    start_dt = start_dt.replace(tzinfo=timezone.utc)
                duration = int((now_utc - start_dt).total_seconds())
            
            c.execute("""UPDATE outages SET ended_at=?, duration_seconds=?, battery_at_end=?
                         WHERE id=?""", (end_ts, duration, bat_end, oid))
    except Exception as e:
        log.error(f"Resolve stale outages error: {e}")
        
    conn.commit()
    conn.close()


def save_reading(data: dict):
    try:
        now = datetime.now()
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        c.execute("""INSERT INTO readings
            (ts, date, input_voltage, output_voltage, frequency,
             load_percent, watts, battery_voltage, battery_capacity,
             ups_mode, temperature)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)""", (
            now.isoformat(), now.strftime("%Y-%m-%d"),
            data.get("input_voltage"),  data.get("output_voltage"),
            data.get("frequency"),      data.get("load_percent"),
            data.get("watts"),          data.get("battery_voltage"),
            data.get("battery_capacity"), data.get("ups_mode"),
            data.get("temperature"),
        ))
        conn.commit()
        conn.close()
    except Exception as e:
        log.error(f"DB save error: {e}")


def record_outage_start(battery_pct: int) -> int | None:
    global _outage_row_id
    try:
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        c.execute("INSERT INTO outages (started_at, battery_at_start) VALUES (?, ?)",
                  (datetime.now(timezone.utc).isoformat(), battery_pct))
        _outage_row_id = c.lastrowid
        conn.commit()
        conn.close()
    except Exception as e:
        log.error(f"Outage start error: {e}")


def record_outage_end(battery_pct: int):
    global _outage_row_id
    if _outage_row_id is None:
        return
    try:
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        c.execute("SELECT started_at FROM outages WHERE id=?", (_outage_row_id,))
        row = c.fetchone()
        if row:
            start_dt = datetime.fromisoformat(row[0])
            now_utc = datetime.now(timezone.utc)
            if start_dt.tzinfo is None:
                start_dt = start_dt.replace(tzinfo=timezone.utc)
            duration = int((now_utc - start_dt).total_seconds())
            c.execute("""UPDATE outages SET ended_at=?, duration_seconds=?, battery_at_end=?
                         WHERE id=?""",
                      (now_utc.isoformat(), duration, battery_pct, _outage_row_id))
            conn.commit()
        conn.close()
    except Exception as e:
        log.error(f"Outage end error: {e}")
    _outage_row_id = None


# ── Query helpers ───────────────────────────────────
def get_daily_stats(target_date: str = None) -> dict:
    if target_date is None:
        target_date = date.today().isoformat()
    try:
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        c.execute("SELECT watts, ts FROM readings WHERE date=? ORDER BY ts ASC", (target_date,))
        rows = c.fetchall()
        conn.close()

        kwh = 0.0
        for i in range(1, len(rows)):
            w0, t0 = rows[i - 1]
            _,  t1 = rows[i]
            dt = (datetime.fromisoformat(t1) - datetime.fromisoformat(t0)).total_seconds()
            if dt <= MAX_READING_GAP:   # skip gaps — PC/app was off
                kwh += (w0 / 1000.0) * (dt / 3600.0)

        # Partial interval from last reading to now (only for today)
        if rows and target_date == date.today().isoformat():
            last_w, last_t = rows[-1]
            dt = (datetime.now() - datetime.fromisoformat(last_t)).total_seconds()
            dt = min(dt, settings.get("db_write_interval", 60) * 1.5)
            kwh += (last_w / 1000.0) * (dt / 3600.0)

        # Estimate CEB cost for today by projecting to 30 days
        projected_monthly_kwh = kwh * 30.0
        ceb_bill = calc_ceb_bill(projected_monthly_kwh)
        daily_cost = ceb_bill["total"] / 30.0

        return {"date": target_date, "kwh": round(kwh, 4),
                "cost_lkr": round(daily_cost, 2), "samples": len(rows)}
    except Exception as e:
        log.error(f"Daily stats error: {e}")
        return {"date": target_date, "kwh": 0, "cost_lkr": 0, "samples": 0}


# ══════════════════════════════════════════════════════
#  CEB BILL ESTIMATOR  (Sri Lanka Domestic Tariff 2026/05)
# ══════════════════════════════════════════════════════


def calc_ceb_bill(units: float) -> dict:
    """Calculate a CEB domestic electricity bill given consumption in kWh.
    Returns a detailed breakdown dict matching CEB D-2026/05 tariff structure.
    """
    if units <= 0:
        return {
            "units":          0.0,
            "breakdown":      [],
            "energy_charge":  0.0,
            "fixed_charge":   0.0,
            "sscl_tax":       0.0,
            "total":          0.0,
            "fixed_charge_label": "Fixed Charge (Domestic)",
        }

    # Round units to 2 decimal places for billing
    units = round(units, 2)

    # 1. Determine Tariff Block and Tiers based on monthly consumption
    if units <= 60.0:
        # Low consumption block (0 - 60 kWh)
        tiers = [
            (30.0, 5.00),   # 0–30 kWh @ Rs. 5.00
            (30.0, 9.00),   # 31–60 kWh @ Rs. 9.00
        ]
        # Fixed charge based on actual consumption
        if units <= 30.0:
            fixed_charge = 80.00
        else:
            fixed_charge = 210.00
    else:
        # Standard block (> 60 kWh)
        tiers = [
            (60.0,  14.00),  # first 60 units @ Rs. 14.00
            (30.0,  20.00),  # next 30 units (61–90) @ Rs. 20.00
            (30.0,  28.00),  # next 30 units (91–120) @ Rs. 28.00
            (60.0,  44.00),  # next 60 units (121–180) @ Rs. 44.00
            (None,  100.00), # units above 180 (181+) @ Rs. 100.00 (revised May 2026)
        ]
        # Fixed charge based on actual consumption
        if units <= 90.0:
            fixed_charge = 400.00
        elif units <= 120.0:
            fixed_charge = 1000.00
        elif units <= 180.0:
            fixed_charge = 1500.00
        else:
            fixed_charge = 3410.00

    # 2. Calculate Energy Charge
    remaining = units
    breakdown = []
    energy_charge = 0.0

    for limit, rate in tiers:
        if remaining <= 0:
            break
        block = min(remaining, limit) if limit is not None else remaining
        charge = round(block * rate, 2)
        breakdown.append({
            "units": round(block, 2),
            "rate":  rate,
            "charge": charge,
        })
        energy_charge += charge
        remaining -= block

    energy_charge = round(energy_charge, 2)
    
    # 3. Calculate SSCL Tax (2.5% on 102.5% of liable turnover = 2.5% / 97.5% of subtotal)
    # The screenshots show that SSCL is ceiling-rounded (rounded up to next cent).
    subtotal = energy_charge + fixed_charge
    import math
    sscl_tax = math.ceil(subtotal * 2.5 / 97.5 * 100) / 100.0
    
    # Total Bill = Subtotal + SSCL Tax
    total = round(subtotal + sscl_tax, 2)

    return {
        "units":          units,
        "breakdown":      breakdown,
        "energy_charge":  energy_charge,
        "fixed_charge":   fixed_charge,
        "sscl_tax":       sscl_tax,
        "total":          total,
        "fixed_charge_label": "Fixed Charge (Domestic)",
    }


def get_monthly_data(month: str = None) -> list:
    if month is None:
        month = date.today().strftime("%Y-%m")
    try:
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        c.execute("SELECT DISTINCT date FROM readings WHERE date LIKE ? ORDER BY date",
                  (f"{month}%",))
        dates = [r[0] for r in c.fetchall()]
        conn.close()
        return [get_daily_stats(d) for d in dates]
    except Exception as e:
        log.error(f"Monthly data error: {e}")
        return []


def get_hourly_data(target_date: str = None) -> list:
    if target_date is None:
        target_date = date.today().isoformat()
    try:
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        c.execute("""SELECT strftime('%H', ts) as hr,
                            AVG(watts), MAX(watts), MIN(watts), COUNT(*)
                     FROM readings WHERE date=? GROUP BY hr ORDER BY hr""",
                  (target_date,))
        rows = c.fetchall()
        conn.close()
        return [{"hour": int(r[0]), "avg_watts": round(r[1], 1),
                 "max_watts": round(r[2], 1), "min_watts": round(r[3], 1),
                 "samples": r[4]} for r in rows]
    except Exception as e:
        log.error(f"Hourly data error: {e}")
        return []


def get_trends(days: int = 30) -> list:
    try:
        since = (date.today() - timedelta(days=days)).isoformat()
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        c.execute("""SELECT date,
                            AVG(battery_voltage), AVG(temperature),
                            AVG(input_voltage), MIN(input_voltage), MAX(input_voltage),
                            AVG(battery_capacity)
                     FROM readings WHERE date >= ?
                     GROUP BY date ORDER BY date""", (since,))
        rows = c.fetchall()
        conn.close()
        return [{"date": r[0],
                 "avg_bat_v":   round(r[1], 2) if r[1] is not None else None,
                 "avg_temp":    round(r[2], 1) if r[2] is not None else None,
                 "avg_input_v": round(r[3], 1) if r[3] is not None else None,
                 "min_input_v": round(r[4], 1) if r[4] is not None else None,
                 "max_input_v": round(r[5], 1) if r[5] is not None else None,
                 "avg_bat_cap": round(r[6], 1) if r[6] is not None else None,
                 } for r in rows]
    except Exception as e:
        log.error(f"Trends error: {e}")
        return []


def get_outages(limit: int = 50) -> list:
    try:
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        c.execute("""SELECT id, started_at, ended_at, duration_seconds,
                            battery_at_start, battery_at_end
                     FROM outages ORDER BY started_at DESC LIMIT ?""", (limit,))
        rows = c.fetchall()
        conn.close()
        return [{"id": r[0], "started_at": r[1], "ended_at": r[2],
                 "duration_seconds": r[3], "battery_at_start": r[4],
                 "battery_at_end": r[5]} for r in rows]
    except Exception as e:
        log.error(f"Outages error: {e}")
        return []


def export_csv(start_date: str, end_date: str) -> str:
    try:
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        c.execute("""SELECT ts, date, input_voltage, output_voltage, frequency,
                            load_percent, watts, battery_voltage, battery_capacity,
                            ups_mode, temperature
                     FROM readings WHERE date BETWEEN ? AND ? ORDER BY ts""",
                  (start_date, end_date))
        rows = c.fetchall()
        conn.close()
        buf = StringIO()
        buf.write("timestamp,date,input_voltage,output_voltage,frequency,"
                  "load_percent,watts,battery_voltage,battery_capacity,"
                  "ups_mode,temperature\n")
        for row in rows:
            buf.write(",".join("" if v is None else str(v) for v in row) + "\n")
        return buf.getvalue()
    except Exception as e:
        log.error(f"CSV export error: {e}")
        return ""



# ══════════════════════════════════════════════════════
#  BATTERY HEALTH TRACKER
# ══════════════════════════════════════════════════════
def get_battery_health() -> dict:
    """Analyse historical battery voltage readings taken when the battery was
    nearly fully charged (≥ 90 %) to estimate battery health over time.

    Health % formula (per month):
        health = (avg_full_v - replace_v) / (rated_v - replace_v) * 100
    clamped to [0, 100].
    """
    cfg         = get_model_cfg()
    rated_v     = cfg.get("battery_rated_v",  27.2)
    warn_v      = cfg.get("battery_warn_v",   25.0)
    replace_v   = cfg.get("battery_replace_v", 24.0)

    try:
        conn = sqlite3.connect(DB_PATH)
        c    = conn.cursor()

        # Monthly average voltage at high-charge (≥ 90 %)
        c.execute("""
            SELECT strftime('%Y-%m', ts)  AS month,
                   AVG(battery_voltage)   AS avg_v,
                   COUNT(*)               AS samples
            FROM   readings
            WHERE  battery_capacity >= 90
              AND  battery_voltage  >  0
            GROUP  BY month
            ORDER  BY month ASC
        """)
        monthly = c.fetchall()
        conn.close()
    except Exception as e:
        log.error(f"Battery health query error: {e}")
        return {}

    if not monthly:
        return {
            "status":         "no_data",
            "health_pct":     None,
            "current_avg_v":  None,
            "rated_v":        rated_v,
            "warn_v":         warn_v,
            "replace_v":      replace_v,
            "monthly_trend":  [],
            "battery_age_days": None,
            "replaced_date":  settings.get("battery_replaced_date", ""),
        }

    def _health(v: float) -> float:
        if rated_v <= replace_v:
            return 100.0
        return max(0.0, min(100.0, (v - replace_v) / (rated_v - replace_v) * 100))

    trend = [
        {
            "month":    r[0],
            "avg_v":    round(r[1], 2),
            "samples":  r[2],
            "health":   round(_health(r[1]), 1),
        }
        for r in monthly
    ]

    current_avg_v  = trend[-1]["avg_v"]
    current_health = round(_health(current_avg_v), 1)

    if current_health >= 80:
        status = "good"
    elif current_health >= 55:
        status = "fair"
    else:
        status = "poor"

    # Battery age
    replaced_date = settings.get("battery_replaced_date", "").strip()
    age_days      = None
    if replaced_date:
        try:
            rd       = date.fromisoformat(replaced_date)
            age_days = (date.today() - rd).days
        except ValueError:
            pass

    return {
        "status":           status,
        "health_pct":       current_health,
        "current_avg_v":    current_avg_v,
        "rated_v":          rated_v,
        "warn_v":           warn_v,
        "replace_v":        replace_v,
        "monthly_trend":    trend,
        "battery_age_days": age_days,
        "replaced_date":    replaced_date,
    }


# ══════════════════════════════════════════════════════
#  VIEWPOWER CLIENT  (reads from ViewPower software API)
# ══════════════════════════════════════════════════════
VIEWPOWER_BASE = "http://localhost:15178/ViewPower"

class ViewPowerClient:
    """
    Communicates with the local ViewPower software at localhost:15178.
    Tries multiple strategies: JSON endpoint → HTML scrape.
    ViewPower reports battery_capacity directly so no voltage math needed.
    """
    HEADERS = {"Accept": "application/json, text/html, */*", "User-Agent": "UPSMonitor/2.0"}
    TIMEOUT  = 5

    def __init__(self, base_url: str = VIEWPOWER_BASE):
        self.base_url   = base_url.rstrip("/")
        self.session    = requests.Session()
        self.session.headers.update(self.HEADERS)
        self._device_id = None

    def send_command(self, cmd_str: str) -> bool:
        """ViewPower mode: commands not supported via this client."""
        log.warning("Hardware commands are not available in ViewPower mode.")
        return False

    def fetch(self) -> dict | None:
        """Return parsed UPS data dict, or None if ViewPower is unreachable."""
        data = self._try_req_monitor_data()
        if data:
            return data
        data = self._try_load_info_action()
        if data:
            return data
        data = self._try_device_summary_action()
        if data:
            return data
        return self._try_html_monitor()

    def _try_req_monitor_data(self) -> dict | None:
        try:
            r = self.session.get(f"{self.base_url}/monitor", timeout=self.TIMEOUT)
            if r.status_code != 200:
                return None
            html = r.text
            m = re.search(r'var\s+portName\s*=\s*\"([^\"]+)\";', html)
            if not m:
                m = re.search(r"var\s+portName\s*=\s*'([^']+)';", html)
            port_name = m.group(1) if m else self._resolve_port_name_from_tree()
            if not port_name:
                port_name = "USB2F7113A9"
            r2 = self.session.post(f"{self.base_url}/workstatus/reqMonitorData",
                                   data={"portName": port_name}, timeout=self.TIMEOUT)
            if r2.status_code == 200:
                work_info = r2.json().get("workInfo")
                if work_info:
                    return self._parse_work_info(work_info)
        except Exception as e:
            log.debug(f"reqMonitorData failed: {e}")
        return None

    def _resolve_port_name_from_tree(self) -> str | None:
        try:
            import random
            r = self.session.get(f"{self.base_url}/initDeviceTree?{random.random()}", timeout=self.TIMEOUT)
            if r.status_code == 200:
                for node in r.json():
                    if node.get("pId") == "11" or "USB" in node.get("name", ""):
                        m2 = re.match(r'([A-Za-z]+)\s*\(id=([A-Za-z0-9]+)_[A-Za-z0-9]+\)', node.get("name",""))
                        if m2:
                            return m2.group(1) + m2.group(2)
        except Exception as e:
            log.debug(f"Port name tree resolve failed: {e}")
        return None

    def _parse_work_info(self, wi: dict) -> dict | None:
        try:
            def f(v, d=0.0): 
                try: return float(v) if v not in (None, "", "----") else d
                except: return d
            def i(v, d=0):
                try: return int(v) if v not in (None, "", "----") else d
                except: return d
            return {
                "input_voltage":    f(wi.get("inputVoltage")),
                "output_voltage":   f(wi.get("outputVoltage")),
                "frequency":        f(wi.get("outputFrequency")),
                "load_percent":     i(wi.get("outputLoadPercent")),
                "battery_voltage":  f(wi.get("batteryVoltage")),
                "battery_capacity": i(wi.get("batteryCapacity")),
                "temperature":      f(wi.get("temperature")) or None,
                "ups_mode":         wi.get("workMode", "Line mode"),
                "beeper_on":        True,
            }
        except Exception as e:
            log.debug(f"parse_work_info failed: {e}")
        return None

    def _try_load_info_action(self) -> dict | None:
        did = self._device_id or self._get_device_id()
        if not did:
            return None
        try:
            r = self.session.get(f"{self.base_url}/loadInfo.action",
                                 params={"deviceId": did}, timeout=self.TIMEOUT)
            if r.status_code == 200:
                return self._parse_load_info_json(r.json())
        except Exception as e:
            log.debug(f"loadInfo.action failed: {e}")
        return None

    def _get_device_id(self) -> str | None:
        for ep in ("/deviceList.action", "/getDeviceList.action"):
            try:
                r = self.session.get(self.base_url + ep, timeout=self.TIMEOUT)
                if r.status_code == 200:
                    devs = r.json().get("deviceList") or r.json().get("devices") or []
                    if devs:
                        self._device_id = str(devs[0].get("deviceId") or devs[0].get("id") or "")
                        return self._device_id
            except Exception as e:
                log.debug(f"deviceList {ep} failed: {e}")
        return None

    def _parse_load_info_json(self, j: dict) -> dict | None:
        try:
            return {
                "input_voltage":    float(j.get("inputVoltage", 0) or 0),
                "output_voltage":   float(j.get("outputVoltage", 0) or 0),
                "frequency":        float(j.get("outputFrequency", 0) or j.get("inputFrequency", 0) or 0),
                "load_percent":     int(j.get("loadLevel", 0) or j.get("load", 0) or 0),
                "battery_voltage":  float(j.get("batteryVoltage", 0) or 0),
                "battery_capacity": int(j.get("batteryCapacity", 0) or 0),
                "temperature":      None,
                "ups_mode":         j.get("upsMode", "Unknown"),
                "beeper_on":        True,
            }
        except:
            return None

    def _try_device_summary_action(self) -> dict | None:
        did = self._device_id or self._get_device_id()
        if not did:
            return None
        try:
            r = self.session.get(f"{self.base_url}/getDeviceSummary.action",
                                 params={"deviceId": did}, timeout=self.TIMEOUT)
            if r.status_code == 200 and r.text.strip().startswith("{"):
                return self._parse_load_info_json(r.json())
        except Exception as e:
            log.debug(f"getDeviceSummary failed: {e}")
        return None

    def _try_html_monitor(self) -> dict | None:
        for url in [f"{self.base_url}/monitor", "http://localhost:15178/ViewPower/"]:
            try:
                r = self.session.get(url, timeout=self.TIMEOUT)
                if r.status_code == 200 and "<html" in r.text.lower():
                    # Extract numbers from input fields (ViewPower layout)
                    from html.parser import HTMLParser
                    vals = []
                    class _P(HTMLParser):
                        def handle_starttag(self, tag, attrs):
                            if tag == "input":
                                d = dict(attrs)
                                if d.get("type") == "text" and d.get("value"):
                                    m2 = re.search(r"[-+]?\d*\.?\d+", d["value"])
                                    if m2:
                                        vals.append(float(m2.group()))
                    _P().feed(r.text)
                    if len(vals) >= 6:
                        return {
                            "input_voltage": vals[0], "output_voltage": vals[1],
                            "frequency": vals[2],     "load_percent": int(vals[3]),
                            "battery_voltage": vals[4], "battery_capacity": int(vals[5]),
                            "temperature": None, "ups_mode": "Line mode", "beeper_on": True,
                        }
            except Exception as e:
                log.debug(f"HTML monitor {url} failed: {e}")
        return None


# ══════════════════════════════════════════════════════
#  DIRECT USB CLIENT  (reads from UPS hardware via HID)
# ══════════════════════════════════════════════════════
class DirectUPSClient:
    """Reads UPS data directly via USB HID using the Megatec/Voltronic QS protocol.
    Vendor ID 0x0665 / Product ID 0x5161 is the Cypress USB bridge used by many
    Voltronic / ViewPower compatible UPS devices.
    """

    VID = UPS_VID
    PID = UPS_PID

    def __init__(self):
        self._static_fetched = False
        self._static_cache = {}

    def _query(self, cmd_str: str) -> bytes | None:
        try:
            dev = hid.device()
            dev.open(self.VID, self.PID)
            dev.set_nonblocking(False)
            cmd = cmd_str.encode('ascii') + b'\r'
            packet = b'\x00' + cmd + b'\x00' * (8 - len(cmd))
            dev.write(packet)

            raw = b''
            empty_reads = 0
            for _ in range(20): # max 4 seconds total
                chunk = dev.read(8, timeout_ms=200)
                if chunk:
                    empty_reads = 0
                    raw += bytes(chunk)
                    if b'\r' in raw and b'(' in raw:
                        if raw.find(b'\r', raw.find(b'(')) != -1:
                            break
                else:
                    empty_reads += 1
                    # Fail fast: if we get absolutely no bytes for 1 second, the UPS ignored the command
                    if not raw and empty_reads >= 5:
                        break
            dev.close()
            return raw
        except Exception as e:
            log.error(f"DirectUPS HID query '{cmd_str}' failed: {e}")
            return None

    def fetch(self) -> dict | None:
        raw_qs = self._query('QS')
        if not raw_qs:
            return None
            
        data = self._parse_q1(raw_qs)
        if not data:
            return None
            
        if not self._static_fetched:
            # 1. Firmware Version (QVFW)
            raw_qvfw = self._query('QVFW')
            if raw_qvfw:
                text_qvfw = raw_qvfw.replace(b'\x00', b'').decode('ascii', errors='ignore').strip()
                if text_qvfw.startswith('('):
                    self._static_cache["firmware"] = text_qvfw.split(':')[-1].replace('\r', '').strip() if ':' in text_qvfw else text_qvfw[1:].replace('\r', '')
                    
            # 2. Serial Number (QID)
            raw_qid = self._query('QID')
            if raw_qid:
                text_qid = raw_qid.replace(b'\x00', b'').decode('ascii', errors='ignore').strip()
                if text_qid.startswith('(') and "NAK" not in text_qid:
                    self._static_cache["serial"] = text_qid[1:].replace('\r', '').strip()
                    
            # 3. Model Info / Rated Capacity (QMD)
            raw_qmd = self._query('QMD')
            if raw_qmd:
                text_qmd = raw_qmd.replace(b'\x00', b'').decode('ascii', errors='ignore').strip()
                if text_qmd.startswith('('):
                    parts = text_qmd[1:].split()
                    if len(parts) >= 2:
                        try:
                            va_capacity = parts[1].split('#')[-1]
                            self._static_cache["rated_va"] = int(va_capacity)
                        except ValueError:
                            pass
            
            self._static_fetched = True
            
        data.update(self._static_cache)
                        
        # 4. Warning Status (QWS) - Rate limited to every 5th loop (10s) to keep polling fast
        if not hasattr(self, '_loop_count'):
            self._loop_count = 0
            self._faults_cache = []
            
        self._loop_count += 1
        if self._loop_count % 5 == 1:
            raw_qws = self._query('QWS')
            if raw_qws:
                text_qws = raw_qws.replace(b'\x00', b'').decode('ascii', errors='ignore').strip()
                if text_qws.startswith('('):
                    bits = text_qws[1:].replace('\r', '')
                    if len(bits) >= 8:
                        faults = []
                        if bits[0] == '1': faults.append("Battery Open")
                        if bits[1] == '1': faults.append("Overload")
                        if bits[2] == '1': faults.append("Short Circuit")
                        if bits[3] == '1': faults.append("Inverter Fault")
                        if bits[4] == '1': faults.append("Bus Fault")
                        if bits[5] == '1': faults.append("Over Temperature")
                        if bits[6] == '1': faults.append("Fan Fault")
                        if bits[7] == '1': faults.append("Battery Over Voltage")
                        self._faults_cache = faults

        if self._faults_cache:
            data["faults"] = self._faults_cache

        return data

    def send_command(self, cmd_str: str) -> bool:
        """Sends a raw command (like 'Q' or 'T') to the UPS."""
        try:
            dev = hid.device()
            dev.open(self.VID, self.PID)
            dev.set_nonblocking(False)
            cmd = cmd_str.encode('ascii') + b'\r'
            packet = b'\x00' + cmd + b'\x00' * (8 - len(cmd))
            dev.write(packet)
            dev.close()
            return True
        except Exception as e:
            log.error(f"Failed to send UPS command '{cmd_str}': {e}")
            return False

    def _parse_q1(self, raw: bytes) -> dict | None:
        """Parse a Voltronic Q1 response string.
        Format: (BBB.B CCC.C DDD.D EEE FF.F GG.G HHH.H IIIIIIII<CR>
          B = Input voltage
          C = Input fault voltage
          D = Output voltage
          E = Output current percent
          F = Output frequency
          G = Battery voltage
          H = Temperature (or --.- if not available)
          I = Status bits (8 chars)
        """
        try:
            # Strip nulls and find the '(' response
            text = raw.replace(b'\x00', b'').decode('ascii', errors='ignore')
            m = re.search(r'\(([\d. -]+[01]{8})\r?', text)
            if not m:
                return None

            parts = m.group(1).split()
            if len(parts) < 8:
                return None

            input_v   = float(parts[0])
            output_v  = float(parts[2])
            load_pct  = int(parts[3])
            freq      = float(parts[4])
            bat_v     = float(parts[5])
            temp_raw  = parts[6]
            status    = parts[7] if len(parts) > 7 else '00000000'

            # Status bits: bit 0 = Utility Fail (on battery)
            on_battery = status[0] == '1'
            test_active = status[5] == '1' if len(status) == 8 else False
            
            if test_active:
                ups_mode = 'Self-Test'
            else:
                ups_mode = 'Battery mode' if on_battery else 'Line mode'
                
            beeper_on  = status[7] == '1' if len(status) == 8 else True

            # battery_capacity is now managed by fast_poll_loop using state tracking.
            # We report the raw voltage here and let the poll loop compute a stable percentage.
            bat_pct = None

            temp = None
            if temp_raw != '--.-':
                try:
                    temp = float(temp_raw)
                    if temp == 0.0:
                        temp = None
                except ValueError:
                    pass

            return {
                'input_voltage':    input_v,
                'output_voltage':   output_v,
                'frequency':        freq,
                'load_percent':     load_pct,
                'battery_voltage':  bat_v,
                'battery_capacity': bat_pct,
                'ups_mode':         ups_mode,
                'temperature':      temp,
                'beeper_on':        beeper_on,
            }
        except Exception as e:
            log.debug(f"Q1 parse error: {e} | raw: {raw!r}")
            return None


# ══════════════════════════════════════════════════════
#  POLLING LOOPS
# ══════════════════════════════════════════════════════
def _make_ups_client():
    """Return the correct UPS client based on the current data_source setting."""
    src = settings.get("data_source", "direct")
    if src == "viewpower":
        log.info("Data source: ViewPower")
        return ViewPowerClient()
    log.info("Data source: Direct USB")
    return DirectUPSClient()

ups_client = _make_ups_client()


_vp_cur_capacity = 90
_vp_cur_time = 0.0

def _vp_calculate_battery_capacity(v_bat_per_block: float, load_pct: int, on_battery: bool) -> int:
    """
    Official ViewPower fallback battery calculation algorithm.
    Used when the UPS does not support the QBV hardware capacity command.
    """
    global _vp_cur_capacity, _vp_cur_time
    import time
    
    if not on_battery:
        # Line mode / Standby mode (Charging)
        if v_bat_per_block < 11.6:
            return 0
        if v_bat_per_block >= 13.5:
            return 100
        if v_bat_per_block >= 13.3:
            if _vp_cur_capacity >= 100:
                return 100
            if _vp_cur_time > 0:
                now = time.time()
                # ViewPower adds 1% every 720,000 ms (12 minutes) during float charge
                if (now - _vp_cur_time) >= 720.0:
                    _vp_cur_time = now
                    _vp_cur_capacity += 1
                    return _vp_cur_capacity
                return _vp_cur_capacity
            _vp_cur_time = time.time()
            return _vp_cur_capacity
            
        # Between 11.6 and 13.3, linear ramp up to 90%
        return int(90.0 * (v_bat_per_block - 11.6) / 1.7)
    
    else:
        # Battery mode / Discharging
        _vp_cur_capacity = 90
        _vp_cur_time = 0.0
        
        if load_pct < 20:
            if v_bat_per_block > 13.2:
                return 100
            if v_bat_per_block > 10.2:
                return int(100.0 * (v_bat_per_block - 10.2) / 3.0)
            return 0
        else:
            if v_bat_per_block > 12.7:
                return 100
            if v_bat_per_block > 10.2:
                return int(100.0 * (v_bat_per_block - 10.2) / 2.5)
            return 0


def fast_poll_loop():
    """Updates in-memory UPS state every ~2 s. Handles outage detection + notifications."""
    global _last_on_battery, _low_bat_notified, _high_load_notified, _shutdown_triggered, _outage_start_time
    _high_load_notified = False
    _shutdown_triggered = False
    _outage_start_time = None

    log.info("Fast poll loop started.")
    while True:
        try:
            data = ups_client.fetch()
            with state_lock:
                if data:
                    cfg = get_model_cfg()
                    on_bat = "battery" in (data.get("ups_mode") or "").lower()
                    is_test = data.get("ups_mode") == "Self-Test"

                    use_viewpower = settings.get("data_source", "direct") == "viewpower"

                    # ── Max Watts Auto-Detect ────────────────────────────────
                    if "rated_va" in data and not use_viewpower:
                        # Auto-detect max watts assuming 0.6 power factor
                        max_watts = int(data["rated_va"] * 0.6)
                        data["max_watts"] = max_watts
                    else:
                        max_watts = cfg["max_watts"]
                        data["max_watts"] = max_watts

                    watts = round(max_watts * (data["load_percent"] / 100.0), 1)

                    # ── Battery % State Machine ────────────────────────────────
                    if use_viewpower:
                        # ViewPower reports battery_capacity directly — trust it as-is.
                        pass
                    elif is_test:
                        if "battery_capacity" in ups_state:
                            data["battery_capacity"] = ups_state["battery_capacity"]
                    else:
                        if "hardware_battery_capacity" in data:
                            data["battery_capacity"] = data.pop("hardware_battery_capacity")
                        else:
                            bat_blocks = cfg.get("bat_blocks", 2)
                            v_bat_per_block = data["battery_voltage"] / bat_blocks
                            new_pct = _vp_calculate_battery_capacity(v_bat_per_block, data["load_percent"], on_bat)
                            
                            # Clamp while discharging
                            if on_bat and "battery_capacity" in ups_state:
                                new_pct = min(new_pct, ups_state["battery_capacity"])
                            
                            data["battery_capacity"] = new_pct

                    rt = estimate_runtime(data.get("battery_capacity", 100), watts) if on_bat else None
                    
                    ct = None
                    if not on_bat and data.get("battery_capacity", 100) < 100:
                        pct = data["battery_capacity"]
                        # Bulk charge: 0-90% takes ~4 hours (240 mins) -> ~2.66 mins per %
                        # Float charge: 90-100% takes ~2 hours (120 mins) -> 12 mins per %
                        if pct < 90:
                            mins_left = int((90 - pct) * 2.66) + 120
                        else:
                            mins_left = int((100 - pct) * 12)
                            
                        if mins_left >= 60:
                            h = mins_left // 60
                            m = mins_left % 60
                            ct = f"{h}h {m}m" if m > 0 else f"{h}h"
                        else:
                            ct = f"{mins_left}m"

                    # ── Outage detection ──────────────────────
                    if on_bat and not _last_on_battery:
                        record_outage_start(data["battery_capacity"])
                        _low_bat_notified = False
                        _high_load_notified = False
                        _outage_start_time = datetime.now()
                        log.warning(f"POWER OUTAGE — battery {data['battery_capacity']}%")
                        threading.Thread(
                            target=notify,
                            args=("⚡ Power Outage!",
                                  f"Mains lost. Running on battery "
                                  f"({data['battery_capacity']}% remaining).",
                                  "danger"),
                            daemon=True).start()


                    elif not on_bat and _last_on_battery:
                        record_outage_end(data["battery_capacity"])
                        _low_bat_notified = False
                        _high_load_notified = False
                        _outage_start_time = None
                        # Start charge tracking from the current depleted level
                        _charge_start_pct  = data["battery_capacity"]
                        _charge_start_time = datetime.now()
                        log.info(f"Charging started from {_charge_start_pct}%")

                        # Abort shutdown if one was pending
                        if _shutdown_triggered:
                            _shutdown_triggered = False
                            if settings.get("auto_shutdown_action", "shutdown") == "shutdown":
                                subprocess.Popen("shutdown /a", shell=True)
                            threading.Thread(
                                target=notify,
                                args=("🛑 Shutdown Aborted", "Power was restored! System shutdown has been cancelled.", "success"),
                                daemon=True).start()
                                
                        log.info(f"Power restored. Battery {data['battery_capacity']}%")
                        threading.Thread(
                            target=notify,
                            args=("✅ Power Restored",
                                  f"Mains power is back. Battery at {data['battery_capacity']}%.",
                                  "success"),
                            daemon=True).start()

                    # ── Auto-Shutdown Safety Net ──────────────
                    if on_bat and settings.get("auto_shutdown_enabled", False) and not _shutdown_triggered:
                        trigger_shutdown = False
                        
                        # Check Battery Percentage Trigger
                        if data["battery_capacity"] <= settings.get("auto_shutdown_pct", 10):
                            trigger_shutdown = True
                            reason = f"Battery dropped to {data['battery_capacity']}%"
                            
                        # Check Outage Duration Trigger
                        elif settings.get("auto_shutdown_mins", 0) > 0 and _outage_start_time:
                            outage_mins = (datetime.now() - _outage_start_time).total_seconds() / 60.0
                            if outage_mins >= settings.get("auto_shutdown_mins", 5):
                                trigger_shutdown = True
                                reason = f"Outage lasted {settings.get('auto_shutdown_mins')} minutes"
                                
                        if trigger_shutdown:
                            _shutdown_triggered = True
                            log.warning(f"AUTO-SHUTDOWN TRIGGERED: {reason}")
                            action = settings.get("auto_shutdown_action", "shutdown")
                            action_text = "hibernate" if action == "hibernate" else "shut down"
                            
                            threading.Thread(
                                target=notify,
                                args=("⚠️ AUTO-SHUTDOWN INITIATED",
                                      f"{reason}. Windows will {action_text} in 60 seconds. Save your work immediately!",
                                      "danger"),
                                daemon=True).start()
                                
                            # Force a native Windows message box on top of everything (including full-screen games)
                            import ctypes
                            threading.Thread(
                                target=lambda: ctypes.windll.user32.MessageBoxW(
                                    0, 
                                    f"{reason}.\n\nWindows will {action_text} in 60 seconds!\n\nSave your work immediately!", 
                                    "UPS Auto-Shutdown Initiated", 
                                    0x1000 | 0x30 # MB_SYSTEMMODAL | MB_ICONWARNING
                                ),
                                daemon=True).start()
                                
                            if action == "hibernate":
                                def execute_hibernate():
                                    if _shutdown_triggered:
                                        log.warning("Executing hibernation...")
                                        subprocess.Popen("shutdown /h", shell=True)
                                threading.Timer(60.0, execute_hibernate).start()
                            else:
                                subprocess.Popen(f'shutdown /s /t 60 /c "UPS Auto-Shutdown: {reason}"', shell=True)

                    # ── High Load Warning (during outage) ─────
                    if on_bat:
                        if data["load_percent"] > 50 and not _high_load_notified:
                            _high_load_notified = True
                            threading.Thread(
                                target=notify,
                                args=("⚠️ High Power Usage!",
                                      f"You are drawing {watts}W on battery. "
                                      "Close heavy apps (like games) immediately to save battery!",
                                      "warning"),
                                daemon=True).start()
                        elif data["load_percent"] < 40:
                            _high_load_notified = False

                    # ── Low battery warning (once per outage) ─
                    if (on_bat and not _low_bat_notified
                            and data["battery_capacity"] <= settings.get("low_battery_threshold", 20)):
                        _low_bat_notified = True
                        threading.Thread(
                            target=notify,
                            args=("🪫 Low Battery!",
                                  f"Battery at {data['battery_capacity']}%. Save your work now!",
                                  "danger"),
                            daemon=True).start()


                    # ── High-Res Outage Snapshots ──
                    if on_bat and _outage_row_id:
                        if not hasattr(fast_poll_loop, "snapshot_counter"):
                            fast_poll_loop.snapshot_counter = 0
                        fast_poll_loop.snapshot_counter += 1
                        if fast_poll_loop.snapshot_counter >= 5:  # Every 5 loops (~10 seconds)
                            fast_poll_loop.snapshot_counter = 0
                            try:
                                conn = sqlite3.connect(DB_PATH)
                                c = conn.cursor()
                                c.execute("INSERT INTO outage_snapshots (outage_id, ts, battery_capacity, battery_voltage, watts) VALUES (?, ?, ?, ?, ?)",
                                          (_outage_row_id, datetime.now(timezone.utc).isoformat(), data["battery_capacity"], data["battery_voltage"], watts))
                                conn.commit()
                                conn.close()
                            except Exception as e:
                                log.error(f"Snapshot error: {e}")

                    _last_on_battery = on_bat
                    ups_state.update({
                        "connected":        True,
                        "ups_mode":         data.get("ups_mode", "Unknown"),
                        "input_voltage":    data["input_voltage"],
                        "output_voltage":   data["output_voltage"],
                        "frequency":        data["frequency"],
                        "load_percent":     data["load_percent"],
                        "watts":            watts,
                        "battery_voltage":  data["battery_voltage"],
                        "battery_capacity": data["battery_capacity"],
                        "temperature":      data.get("temperature"),
                        "runtime_estimate": rt,
                        "charge_time_estimate": ct,
                        "on_battery":       on_bat,
                        "beeper_on":        data.get("beeper_on", True),
                        "last_update":      datetime.now().isoformat(),
                    })
                else:
                    # If we fail to read data, don't instantly end the outage. 
                    # Just mark as disconnected until we get a clean read.
                    ups_state["connected"] = False
                # notify SSE subscribers of new data
                state_updated.set()
        except Exception as e:
            log.error(f"Fast poll error: {e}")
            with state_lock:
                ups_state["connected"] = False
            state_updated.set()

        time.sleep(max(1, settings.get("fast_poll_interval", 2)))


def db_write_loop():
    """Saves a reading to DB every 60 s (configurable). Keeps DB lean."""
    log.info("DB write loop started.")
    while True:
        interval = max(30, settings.get("db_write_interval", 60))
        time.sleep(interval)
        try:
            with state_lock:
                connected = ups_state["connected"]
                snap = dict(ups_state)
            if connected:
                save_reading(snap)
                log.debug(f"DB write: {snap['watts']}W bat:{snap['battery_capacity']}%")

                # ── Scheduled Monthly Self-Test ──
                try:
                    if settings.get("auto_test_enabled", False):
                        today = datetime.now()
                        if today.day == 1 and not snap.get("on_battery"):
                            last_test = settings.get("last_auto_test_date", "")
                            if last_test != today.strftime("%Y-%m-%d"):
                                log.info("Running monthly scheduled self-test...")
                                if ups_client:
                                    ups_client.send_command("T")
                                settings["last_auto_test_date"] = today.strftime("%Y-%m-%d")
                                save_settings(settings)
                except Exception as te:
                    log.error(f"Scheduled test error: {te}")

                # ── Battery health notification (once per degradation event) ──
                try:
                    h = get_battery_health()
                    if h.get("status") == "poor" and not settings.get("health_alert_sent", False):
                        settings["health_alert_sent"] = True
                        save_settings(settings)
                        pct = h.get("health_pct", 0)
                        threading.Thread(
                            target=notify,
                            args=("🔋 Battery Health Warning!",
                                  f"Your UPS battery health is LOW ({pct:.0f}%). "
                                  "Consider replacing the battery soon to avoid data loss during outages.",
                                  "warning"),
                            daemon=True).start()
                    elif h.get("status") in ("good", "fair") and settings.get("health_alert_sent", False):
                        # Health improved (e.g. after a battery replacement) — reset flag
                        settings["health_alert_sent"] = False
                        save_settings(settings)
                except Exception as he:
                    log.debug(f"Health check error: {he}")
        except Exception as e:
            log.error(f"DB write error: {e}")


# ══════════════════════════════════════════════════════
#  FLASK APP
# ══════════════════════════════════════════════════════
flask_app = Flask(
    __name__,
    template_folder=str(BASE_DIR / "templates"),
    static_folder=str(BASE_DIR / "static"),
)
flask_app.config["SECRET_KEY"] = "ups-monitor-key-2024"


@flask_app.route("/")
def index():
    return render_template("index.html")

def reverse_ceb_bill(target_lkr: float) -> float:
    """Reverse calculate the kWh consumption given a target LKR bill amount using binary search."""
    if target_lkr <= 0:
        return 0.0
    low, high = 0.0, 5000.0
    for _ in range(50):
        mid = (low + high) / 2
        bill = calc_ceb_bill(mid)["total"]
        if bill < target_lkr:
            low = mid
        else:
            high = mid
    return round(mid, 2)


@flask_app.route("/favicon.ico")
def favicon():
    return flask_app.send_from_directory(str(BASE_DIR / "static"), "favicon.ico")



@flask_app.route("/api/status")
def api_status():
    with state_lock:
        s = dict(ups_state)
    today = get_daily_stats()
    cfg   = get_model_cfg()
    s.update({
        "daily_kwh":             today["kwh"],
        "daily_cost":            today["cost_lkr"],
        "samples":               today["samples"],
        "elec_rate":             settings.get("elec_rate", 30.0),
        "max_watts":             cfg["max_watts"],
        "ups_model":             settings.get("ups_model", "Prolink PRO1201SFC"),
        "temperature_supported": cfg.get("temperature_supported", True),
        "version":               VERSION,
        "cloud_synced":          supabase_sync.sync_enabled,
        "data_source":           settings.get("data_source", "direct"),
    })
    return jsonify(s)


@flask_app.route("/api/stream")
def api_stream():
    """Server-Sent Events endpoint - pushes a status frame whenever ups_state changes."""
    def generate():
        # Send an initial frame immediately on connect
        try:
            with state_lock:
                s = dict(ups_state)
            today = get_daily_stats()
            cfg   = get_model_cfg()
            s.update({
                "daily_kwh":             today["kwh"],
                "daily_cost":            today["cost_lkr"],
                "samples":               today["samples"],
                "elec_rate":             settings.get("elec_rate", 30.0),
                "max_watts":             cfg["max_watts"],
                "ups_model":             settings.get("ups_model", "Prolink PRO1201SFC"),
                "temperature_supported": cfg.get("temperature_supported", True),
                "version":               VERSION,
        "cloud_synced":          supabase_sync.sync_enabled,
            })
            yield f"data: {json.dumps(s)}\n\n"
        except Exception as e:
            log.error(f"SSE initial frame error: {e}")

        while True:
            # Block until the poll loop signals new data (with 5s timeout as keepalive)
            state_updated.wait(timeout=5)
            state_updated.clear()  # reset so we block again next cycle
            try:
                with state_lock:
                    s = dict(ups_state)
                today = get_daily_stats()
                cfg   = get_model_cfg()
                s.update({
                    "daily_kwh":             today["kwh"],
                    "daily_cost":            today["cost_lkr"],
                    "samples":               today["samples"],
                    "elec_rate":             settings.get("elec_rate", 30.0),
                    "max_watts":             cfg["max_watts"],
                    "ups_model":             settings.get("ups_model", "Prolink PRO1201SFC"),
                    "temperature_supported": cfg.get("temperature_supported", True),
                    "version":               VERSION,
        "cloud_synced":          supabase_sync.sync_enabled,
                })
                yield f"data: {json.dumps(s)}\n\n"
            except GeneratorExit:
                break
            except Exception as e:
                log.error(f"SSE stream error: {e}")
                yield f"data: {{}}\n\n"

    return flask_app.response_class(
        generate(),
        mimetype="text/event-stream",
        headers={
            "Cache-Control":  "no-cache",
            "X-Accel-Buffering": "no",
        }
    )


@flask_app.route("/api/settings", methods=["GET", "POST"])
def api_settings():
    global settings
    if request.method == "POST":
        body = request.get_json(force=True)

        # ── Server-side sanity guard ───────────────────────────────────
        # Numeric fields are validated before being accepted so a corrupt
        # or accidental client-side value (NaN, None, negative) can never
        # silently overwrite a previously valid setting.
        def _safe_float(key: str, lo: float = 0.0, hi: float = 1e9) -> None:
            if key not in body:
                return
            try:
                v = float(body[key])
                if lo <= v <= hi:
                    body[key] = v
                else:
                    log.warning(f"Settings POST: {key}={v} out of range [{lo},{hi}], ignored.")
                    del body[key]
            except (TypeError, ValueError):
                log.warning(f"Settings POST: {key}={body[key]!r} is not numeric, ignored.")
                del body[key]

        def _safe_int(key: str, lo: int = 0, hi: int = 10_000) -> None:
            if key not in body:
                return
            try:
                v = int(body[key])
                if lo <= v <= hi:
                    body[key] = v
                else:
                    log.warning(f"Settings POST: {key}={v} out of range [{lo},{hi}], ignored.")
                    del body[key]
            except (TypeError, ValueError):
                log.warning(f"Settings POST: {key}={body[key]!r} is not numeric, ignored.")
                del body[key]

        _safe_float("elec_rate",             lo=0.0,  hi=10_000.0)
        _safe_int("low_battery_threshold",   lo=5,    hi=50)
        _safe_int("fast_poll_interval",      lo=1,    hi=60)
        _safe_int("db_write_interval",       lo=30,   hi=600)
        
        # Shutdown action can be 'shutdown' or 'hibernate'
        if "auto_shutdown_action" in body and body["auto_shutdown_action"] in ("shutdown", "hibernate"):
            settings["auto_shutdown_action"] = body["auto_shutdown_action"]
            
        _safe_int("auto_shutdown_pct",       lo=5,    hi=99)
        _safe_int("auto_shutdown_mins",      lo=0,    hi=1440)
        _safe_int("billing_days",            lo=28,   hi=35)
        if "battery_replaced_date" in body:
            rdate = str(body["battery_replaced_date"]).strip()
            if rdate:
                try:
                    date.fromisoformat(rdate)
                    settings["battery_replaced_date"] = rdate
                    settings["health_alert_sent"] = False
                except ValueError:
                    log.warning(f"Settings POST: battery_replaced_date={rdate!r} invalid, ignored.")
            else:
                settings["battery_replaced_date"] = ""
            del body["battery_replaced_date"]

        settings.update(body)
        if "autostart" in body:
            set_autostart(bool(body["autostart"]))
        settings["autostart"] = get_autostart()
        save_settings(settings)
        # Sync settings to cloud if signed in
        try:
            import supabase_sync
            if supabase_sync.sync_enabled:
                threading.Thread(target=supabase_sync.sync_settings_to_cloud,
                                 args=(dict(settings),), daemon=True).start()
        except Exception:
            pass
        return jsonify({"ok": True, **settings})
    settings["autostart"] = get_autostart()
    return jsonify(settings)


@flask_app.route("/api/models")
def api_models():
    return jsonify({"models": list(UPS_MODELS.keys()), "specs": UPS_MODELS})


import subprocess

def _start_viewpower():
    log.info("Starting ViewPower...")
    vp_paths = [
        r"C:\ViewPower\ViewPower.exe",
        r"C:\Program Files\ViewPower\ViewPower.exe",
        r"C:\Program Files (x86)\ViewPower\ViewPower.exe"
    ]
    for p in vp_paths:
        if os.path.exists(p):
            try:
                os.startfile(p)
                log.info(f"Started ViewPower: {p}")
                return
            except Exception as e:
                log.warning(f"Error starting {p}: {e}")
    log.warning("Could not find ViewPower.exe to start it.")

def _stop_viewpower():
    log.info("Stopping ViewPower...")
    try:
        # Kill the monitor apps
        subprocess.run('taskkill /F /IM ViewPower.exe', shell=True, capture_output=True)
        subprocess.run('taskkill /F /IM upsMonitor.exe', shell=True, capture_output=True)
        # Kill any Java process running out of the ViewPower directory
        subprocess.run('powershell -Command "Get-WmiObject Win32_Process | Where-Object { $_.ExecutablePath -like \'*ViewPower*\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"', shell=True, capture_output=True)
        
        # Remove ViewPower from Windows Startup so it doesn't auto-start on boot
        try:
            startup_path = Path(os.getenv("APPDATA", "")) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup" / "ViewPower.lnk"
            if startup_path.exists():
                startup_path.unlink()
                log.info("Removed ViewPower.lnk from Windows Startup folder.")
        except Exception as startup_e:
            log.warning(f"Could not remove ViewPower from startup: {startup_e}")
            
        log.info("ViewPower stopped.")
    except Exception as e:
        log.warning(f"Error stopping ViewPower: {e}")

@flask_app.route("/api/settings/data_source", methods=["POST"])
def api_set_data_source():
    """Save the data_source setting and hot-swap the UPS client."""
    global ups_client, settings
    body = request.get_json(force=True)
    src = body.get("data_source", "direct")
    if src not in ("direct", "viewpower"):
        return jsonify({"ok": False, "error": "Invalid data_source value"}), 400
    settings["data_source"] = src
    save_settings(settings)
    
    if src == "viewpower":
        _start_viewpower()
    else:
        _stop_viewpower()
        
    # Hot-swap the client so the running poll loop picks it up immediately
    ups_client = _make_ups_client()
    log.info(f"Data source changed to: {src}")
    return jsonify({"ok": True, "data_source": src})



@flask_app.route("/api/history")
def api_history():
    d = request.args.get("date", date.today().isoformat())
    return jsonify(get_hourly_data(d))


@flask_app.route("/api/daily")
def api_daily():
    return jsonify([get_daily_stats((date.today() - timedelta(days=i)).isoformat())
                    for i in range(6, -1, -1)])


@flask_app.route("/api/monthly")
def api_monthly():
    month = request.args.get("month", date.today().strftime("%Y-%m"))
    daily_data = get_monthly_data(month)
    t_kwh = sum(d["kwh"] for d in daily_data)
    ceb_accumulated = calc_ceb_bill(t_kwh)["total"]
    return jsonify({
        "daily": daily_data,
        "ceb_accumulated": ceb_accumulated
    })


@flask_app.route("/api/bill_estimate")
def api_bill_estimate():
    """Return a CEB bill estimate for the requested month (or the current one).

    Query params:
      month   – YYYY-MM  (default: current month)
      days    – billing cycle length (default: 30)
    """
    month      = request.args.get("month", date.today().strftime("%Y-%m"))
    bill_days  = int(request.args.get("days", settings.get("billing_days", 30)))

    # Sum kWh for the month from the DB
    daily_data = get_monthly_data(month)
    recorded_kwh  = sum(d["kwh"] for d in daily_data)
    recorded_days = len([d for d in daily_data if d["samples"] > 0])

    # Project to full billing cycle if we only have partial data
    if recorded_days > 0 and recorded_days < bill_days:
        projected_kwh = (recorded_kwh / recorded_days) * bill_days
    else:
        projected_kwh = recorded_kwh

    today_stats   = get_daily_stats()
    daily_avg_kwh = (recorded_kwh / recorded_days) if recorded_days > 0 else today_stats["kwh"]

    bill      = calc_ceb_bill(projected_kwh)
    daily_est = calc_ceb_bill(daily_avg_kwh)

    # ────────────────────────────────────────────────────────
    # Household Prediction Logic
    # ────────────────────────────────────────────────────────
    household_prediction = None
    with sqlite3.connect(DB_PATH) as conn:
        c = conn.cursor()
        c.execute("SELECT amount_lkr, calculated_kwh, ups_kwh FROM ceb_bills")
        past_bills = c.fetchall()
        
    if past_bills:
        total_base_load = 0.0
        for b in past_bills:
            base = max(0.0, b[1] - b[2]) # calculated_kwh - ups_kwh
            total_base_load += base
        avg_base_load = total_base_load / len(past_bills)
        predicted_total_kwh = avg_base_load + projected_kwh
        household_prediction = {
            "avg_base_load_kwh": round(avg_base_load, 2),
            "predicted_total_kwh": round(predicted_total_kwh, 2),
            "predicted_bill": calc_ceb_bill(predicted_total_kwh)
        }

    return jsonify({
        "month":           month,
        "recorded_kwh":    round(recorded_kwh, 3),
        "projected_kwh":   round(projected_kwh, 3),
        "recorded_days":   recorded_days,
        "bill_days":       bill_days,
        "daily_avg_kwh":   round(daily_avg_kwh, 4),
        "monthly_bill":    bill,
        "daily_cost":      daily_est,
        "household":       household_prediction
    })

@flask_app.route("/api/actual_bill", methods=["POST"])
def api_actual_bill():
    body = request.get_json(force=True)
    month = body.get("month")
    amount = body.get("amount")
    if not month or amount is None:
        return jsonify({"error": "Missing month or amount"}), 400
    
    amount = float(amount)
    
    # Get the UPS recorded kWh for that month
    daily_data = get_monthly_data(month)
    ups_kwh = sum(d["kwh"] for d in daily_data)
    
    calculated_kwh = reverse_ceb_bill(amount)
    
    with sqlite3.connect(DB_PATH) as conn:
        c = conn.cursor()
        c.execute('''
            INSERT INTO ceb_bills (month, amount_lkr, calculated_kwh, ups_kwh) 
            VALUES (?, ?, ?, ?)
            ON CONFLICT(month) DO UPDATE SET 
                amount_lkr = excluded.amount_lkr,
                calculated_kwh = excluded.calculated_kwh,
                ups_kwh = excluded.ups_kwh
        ''', (month, amount, calculated_kwh, ups_kwh))
        conn.commit()
        
    return jsonify({"ok": True, "calculated_kwh": calculated_kwh, "ups_kwh": ups_kwh})


@flask_app.route("/api/trends")
def api_trends():
    days = int(request.args.get("days", 30))
    return jsonify(get_trends(days))


@flask_app.route("/api/outages")
def api_outages():
    return jsonify(get_outages())

@flask_app.route("/api/outages/<int:outage_id>/snapshots")
def api_outage_snapshots(outage_id):
    try:
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        c.execute("SELECT ts, battery_capacity, battery_voltage, watts FROM outage_snapshots WHERE outage_id = ? ORDER BY ts ASC", (outage_id,))
        rows = c.fetchall()
        conn.close()
        
        data = []
        for r in rows:
            data.append({
                "ts": r[0],
                "battery_capacity": r[1],
                "battery_voltage": r[2],
                "watts": r[3]
            })
        return jsonify(data)
    except Exception as e:
        log.error(f"Error fetching snapshots: {e}")
        return jsonify([])


@flask_app.route("/api/battery_health")
def api_battery_health():
    """Return battery health assessment based on historical voltage data."""
    return jsonify(get_battery_health())


@flask_app.route("/api/battery_health/set_replaced", methods=["POST"])
def api_set_battery_replaced():
    """Record the date the battery was last replaced."""
    global settings
    body = request.get_json(force=True)
    replaced = body.get("replaced_date", "").strip()
    if replaced:
        try:
            date.fromisoformat(replaced)   # validate format
            settings["battery_replaced_date"] = replaced
            settings["health_alert_sent"]     = False   # reset alert
            save_settings(settings)
            log.info(f"Battery replaced date set to {replaced}")
        except ValueError:
            return jsonify({"ok": False, "error": "Invalid date format"}), 400
    else:
        settings["battery_replaced_date"] = ""
        save_settings(settings)
    return jsonify({"ok": True, "replaced_date": settings["battery_replaced_date"]})


@flask_app.route("/api/export")
def api_export():
    start = request.args.get("start", (date.today() - timedelta(days=30)).isoformat())
    end   = request.args.get("end",   date.today().isoformat())
    csv   = export_csv(start, end)
    return Response(csv, mimetype="text/csv",
                    headers={"Content-Disposition":
                             f"attachment; filename=ups_data_{start}_{end}.csv"})


@flask_app.route("/api/check_update")
def check_update():
    try:
        r = requests.get(
            "https://api.github.com/repos/DMStyles/ups-monitor/releases/latest",
            headers={
                "User-Agent": "UPS-Monitor",
                "Accept":     "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            timeout=10)

        if r.status_code != 200:
            log.warning(f"Update check: GitHub returned HTTP {r.status_code}")
            return jsonify({
                "update_available": False,
                "current_version":  VERSION,
                "error": f"GitHub returned HTTP {r.status_code}. Try again in a moment."
            })

        j   = r.json()
        tag = j.get("tag_name", VERSION)

        def pv(v):
            parts = re.sub(r"[^\d.]", "", v).split(".")
            return [int(x) for x in parts if x]

        try:
            update_available = pv(tag) > pv(VERSION)
        except Exception:
            update_available = tag.strip().lstrip("v") != VERSION.strip().lstrip("v")

        dl_url = next(
            (a["browser_download_url"] for a in j.get("assets", [])
             if a["name"].endswith(".exe")),
            j.get("zipball_url"))

        return jsonify({
            "update_available": update_available,
            "latest_version":   tag,
            "current_version":  VERSION,
            "changelog":        j.get("body", ""),
            "download_url":     dl_url,
        })
    except Exception as e:
        log.error(f"Update check error: {e}")
    return jsonify({"update_available": False, "current_version": VERSION, "error": str(e)})


@flask_app.route("/api/ups/action", methods=["POST"])
def api_ups_action():
    try:
        body = request.json or {}
        action = body.get("action")
        if action == "mute":
            # Toggle beep
            success = ups_client.send_command("Q")
            return jsonify({"status": "ok" if success else "error", "message": "Mute toggle sent" if success else "Failed to send command"})
        elif action == "test":
            # 10s battery test
            success = ups_client.send_command("T")
            return jsonify({"status": "ok" if success else "error", "message": "10s test started" if success else "Failed to send command"})
        else:
            return jsonify({"status": "error", "message": "Unknown action"}), 400
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@flask_app.route("/api/perform_update", methods=["POST"])
def perform_update():
    body = request.get_json(force=True)
    url  = body.get("download_url") or body.get("zipball_url")
    if not url:
        return jsonify({"ok": False, "error": "No URL"}), 400
    threading.Thread(target=run_updater, args=(url,), daemon=True).start()
    return jsonify({"ok": True})


def run_updater(url: str):
    import urllib.request, zipfile, shutil, tempfile
    log.info(f"Update from: {url}")
    try:
        tmp = tempfile.mkdtemp()
        if url.endswith(".exe"):
            exe_path = os.path.join(tmp, "setup.exe")
            req = urllib.request.Request(url, headers={"User-Agent": "UPS-Monitor-Updater"})
            with urllib.request.urlopen(req) as resp, open(exe_path, "wb") as out:
                shutil.copyfileobj(resp, out)
            subprocess.Popen([exe_path, "/SILENT"], shell=False)
        else:
            zip_path = os.path.join(tmp, "update.zip")
            req = urllib.request.Request(url, headers={"User-Agent": "UPS-Monitor-Updater"})
            with urllib.request.urlopen(req) as resp, open(zip_path, "wb") as out:
                shutil.copyfileobj(resp, out)
            with zipfile.ZipFile(zip_path) as z:
                z.extractall(tmp)
            extracted = next((
                os.path.join(tmp, n) for n in os.listdir(tmp)
                if os.path.isdir(os.path.join(tmp, n)) and n.startswith("DMStyles")), None)
            if not extracted:
                log.error("Extracted dir not found")
                return
            app_dir = str(BASE_DIR.absolute())
            bat = os.path.join(tempfile.gettempdir(), "ups_update.bat")
            with open(bat, "w") as f:
                f.write(f'@echo off\ntimeout /t 2 /nobreak >nul\n'
                        f'xcopy /y /e /q "{extracted}\\*" "{app_dir}\\"\n'
                        f'rmdir /s /q "{tmp}"\n'
                        f'start "" "{app_dir}\\UPS Power Monitor.exe"\n'
                        f'del "%~f0"\n')
            subprocess.Popen([bat], shell=True,
                             creationflags=subprocess.CREATE_NEW_CONSOLE)
        os._exit(0)
    except Exception as e:
        log.error(f"Update error: {e}")


@flask_app.route("/api/show_window")
def api_show_window():
    global window
    if window:
        try:
            window.show()
            window.restore()
        except Exception as e:
            log.error(f"Show window error: {e}")
    return jsonify({"ok": True})


@flask_app.route("/api/cloud/login", methods=["POST"])
def api_cloud_login():
    """Initiates Supabase OAuth by opening default browser."""
    import webbrowser
    auth_url = f"https://izupevznjwrqzfoyzxhw.supabase.co/auth/v1/authorize?provider=google&redirect_to=http://localhost:{DASHBOARD_PORT}/api/oauth/callback"
    webbrowser.open(auth_url)
    return jsonify({"ok": True})


@flask_app.route("/api/oauth/callback")
def api_oauth_callback():
    """Serves the redirect target page that extracts tokens and POSTs back to local api."""
    html_content = """<!DOCTYPE html>
<html>
<head>
    <title>UPS Monitor - Cloud Sync Status</title>
</head>
<body style="font-family: sans-serif; background: #0b0f19; color: #f8fafc; text-align: center; padding-top: 50px; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 80vh;">
    <div style="background: rgba(255,255,255,0.05); padding: 30px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.1); max-width: 450px;">
        <h2 style="color: #00e5a0; margin-top:0;">☁️ Cloud Sync Authorization</h2>
        <p id="status" style="font-size: 1.1rem; line-height: 1.5;">Reading authentication data...</p>
    </div>
    <script>
        const hash = window.location.hash;
        if (hash) {
            const params = new URLSearchParams(hash.replace('#', '?'));
            const access_token = params.get('access_token');
            const refresh_token = params.get('refresh_token');
            if (access_token) {
                document.getElementById('status').innerText = 'Connecting application to cloud...';
                fetch('/api/set_supabase_token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ access_token, refresh_token })
                })
                .then(res => res.json())
                .then(data => {
                    document.getElementById('status').innerHTML = '<span style="color:#00e5a0; font-weight:bold;">Success!</span><br><br>UPS Monitor Cloud Sync is now authorized and active.<br>You can safely close this browser window and return to the app.';
                })
                .catch(err => {
                    document.getElementById('status').innerText = 'Error sending authorization to app: ' + err.message;
                });
            } else {
                document.getElementById('status').innerText = 'Auth failed: No access token in redirect URL.';
            }
        } else {
            document.getElementById('status').innerText = 'No credentials found. Please sign in via the app.';
        }
    </script>
</body>
</html>"""
    return html_content


@flask_app.route("/api/open_browser", methods=["POST"])
def api_open_browser():
    """Open a URL in the system default browser (needed for Google OAuth in WebView2)."""
    import webbrowser
    data = request.json or {}
    url = data.get("url", "")
    if url.startswith("https://"):
        webbrowser.open(url)
        return jsonify({"ok": True})
    return jsonify({"ok": False, "error": "Invalid URL"}), 400


@flask_app.route("/api/set_supabase_token", methods=["POST"])
def api_set_supabase_token():
    data = request.json or {}
    access_token  = data.get("access_token", "")
    refresh_token = data.get("refresh_token", "")
    if access_token:
        try:
            import supabase_sync
            if supabase_sync.set_supabase_session(access_token, refresh_token):
                # Save tokens locally to persist login across restarts
                settings["supabase_access_token"] = access_token
                settings["supabase_refresh_token"] = refresh_token
                save_settings(settings)
                log.info("Supabase session updated and saved to settings")
                
                # Retrieve settings from cloud and merge if any exist
                cloud_settings = supabase_sync.fetch_settings_from_cloud()
                if cloud_settings:
                    for k in ["ups_model", "low_battery_threshold", "auto_shutdown_enabled",
                              "auto_shutdown_action", "auto_shutdown_pct", "auto_shutdown_mins",
                              "billing_days", "fast_poll_interval", "db_write_interval",
                              "notifications_enabled", "ntfy_topic", "battery_replaced_date"]:
                        if k in cloud_settings and cloud_settings[k] is not None:
                            settings[k] = cloud_settings[k]
                    save_settings(settings)
                    log.info("Merged settings from Supabase cloud backup")
        except Exception as e:
            log.warning(f"supabase_sync.set_supabase_session failed: {e}")
    return jsonify({"ok": True})


@flask_app.route("/api/cloud_user")
def api_cloud_user():
    """Return the currently signed-in cloud user's profile info."""
    try:
        import supabase_sync
        return jsonify({
            "signed_in":  supabase_sync.sync_enabled,
            "name":       supabase_sync.user_name  or "",
            "email":      supabase_sync.user_email or "",
            "avatar_url": supabase_sync.user_avatar or "",
            "last_sync":  supabase_sync.last_sync_time or "",
        })
    except Exception as e:
        return jsonify({"signed_in": False, "name": "", "email": "", "avatar_url": "", "last_sync": ""})


@flask_app.route("/api/cloud_signout", methods=["POST"])
def api_cloud_signout():
    """Sign out of Supabase cloud sync."""
    try:
        import supabase_sync
        supabase_sync.sign_out_supabase()
        # Clear persisted tokens from settings
        if "supabase_access_token" in settings:
            del settings["supabase_access_token"]
        if "supabase_refresh_token" in settings:
            del settings["supabase_refresh_token"]
        save_settings(settings)
    except Exception as e:
        log.warning(f"Cloud sign-out error: {e}")
    return jsonify({"ok": True})


def run_flask():
    log.info(f"Flask starting on :{DASHBOARD_PORT}")
    flask_app.run(host="127.0.0.1", port=DASHBOARD_PORT, debug=False, use_reloader=False, threaded=True)


# ══════════════════════════════════════════════════════
#  SYSTEM TRAY
# ══════════════════════════════════════════════════════
def make_tray_icon(watts: float = 0, connected: bool = False) -> Image.Image:
    size = 64
    img  = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.ellipse([2, 2, size - 2, size - 2],
                 fill=(30, 200, 100) if connected else (200, 80, 80))
    draw.polygon([(32, 4), (18, 34), (30, 34), (24, 60), (46, 26), (34, 26)],
                 fill=(255, 255, 255))
    return img


window = None


def on_closing():
    global window
    try:
        window.hide()
    except Exception:
        pass
    return False


@flask_app.route("/api/ai/chat", methods=["POST"])
def api_ai_chat():
    global settings, ups_state
    
    api_key = settings.get("gemini_api_key", "").strip()
    if not api_key:
        return jsonify({"ok": False, "error": "Gemini API key is not configured in Settings."}), 400
        
    body = request.get_json(force=True)
    user_prompt = body.get("message", "").strip()
    if not user_prompt:
        return jsonify({"ok": False, "error": "Message is empty."}), 400
        
    try:
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        
        c.execute("SELECT started_at, duration_seconds FROM outages ORDER BY started_at DESC LIMIT 5")
        outages = c.fetchall()
        
        c.execute("SELECT watts, load_percent FROM readings ORDER BY ts DESC LIMIT 10")
        recent_reads = c.fetchall()
        avg_watts = sum(r[0] for r in recent_reads) / len(recent_reads) if recent_reads else 0
        avg_load = sum(r[1] for r in recent_reads) / len(recent_reads) if recent_reads else 0
        conn.close()
        
        system_prompt = f"""You are the AI Assistant built into 'UPS Power Monitor', a desktop app for a Voltronic/Megatec UPS.
You must provide short, punchy, helpful answers in plain markdown. Do not use generic filler.
Use emojis sparingly but effectively.
Here is the real-time context of the user's UPS hardware:
Model: {settings.get('ups_model', 'Unknown')}
Current Status: {'On Battery' if ups_state.get('on_battery') else 'Online/Charging'}
Current Load: {ups_state.get('watts', 0)}W ({ups_state.get('load_percent', 0)}%)
Recent Avg Load: {avg_watts:.1f}W ({avg_load:.1f}%)
Battery: {ups_state.get('battery_capacity', 0)}% ({ups_state.get('battery_voltage', 0)}V)
Firmware: {ups_state.get('firmware', 'Unknown')}

Recent Outages:
"""
        for o in outages:
            system_prompt += f"- {o[0]} (Duration: {o[1]}s)\n"

        app_logs = "No logs available."
        try:
            if LOG_PATH.exists():
                with open(LOG_PATH, 'r') as f:
                    app_logs = "".join(f.readlines()[-30:])
        except:
            pass
            
        system_prompt += f"\nRecent App Logs (for debugging):\n{app_logs}"

        headers = {"Content-Type": "application/json"}
        models_to_try = [
            "gemini-2.0-flash",
            "gemini-1.5-flash-latest",
            "gemini-1.5-pro-latest",
            "gemini-pro"
        ]
        
        last_error = ""
        last_status = 500
        
        for model in models_to_try:
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
            
            # gemini-pro does not support systemInstruction, prepend to user prompt
            if model == "gemini-pro":
                payload = {
                    "contents": [{"parts": [{"text": system_prompt + "\n\nUser Question: " + user_prompt}]}]
                }
            else:
                payload = {
                    "contents": [{"parts": [{"text": user_prompt}]}],
                    "systemInstruction": {"parts": [{"text": system_prompt}]}
                }
                
            r = requests.post(url, headers=headers, json=payload, timeout=15)
            
            if r.status_code == 200:
                data = r.json()
                reply = data["candidates"][0]["content"]["parts"][0]["text"]
                return jsonify({"ok": True, "reply": reply})
            
            last_status = r.status_code
            last_error = r.text
            
            if r.status_code in (404, 429, 403):
                log.warning(f"Gemini API: {model} returned {r.status_code}. Trying next model...")
                continue
            else:
                break
                
        return jsonify({"ok": False, "error": f"Gemini API Error: {last_status} {last_error}"}), 400
            
    except Exception as e:
        log.error(f"AI Chat error: {e}")
        return jsonify({"ok": False, "error": str(e)}), 500

def create_tray():
    global tray_icon

    def open_dashboard(icon, item):
        global window
        try:
            window.show()
            window.restore()
        except Exception as e:
            log.error(f"Open dashboard error: {e}")

    def quit_app(icon, item):
        icon.stop()
        os._exit(0)

    icon = pystray.Icon(
        "UPS Monitor",
        make_tray_icon(connected=False),
        "UPS Monitor",
        pystray.Menu(
            pystray.MenuItem("📊 Open Dashboard", open_dashboard, default=True),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("❌ Quit", quit_app),
        ),
    )
    tray_icon = icon

    def update_loop():
        while True:
            with state_lock:
                w, con = ups_state["watts"], ups_state["connected"]
                bat, on_bat = ups_state["battery_capacity"], ups_state["on_battery"]
                rt = ups_state["runtime_estimate"]
            icon.icon = make_tray_icon(w, con)
            if con:
                status = f"🔋 Battery (~{rt} min left)" if on_bat and rt else "✅ Line"
                icon.title = f"⚡ UPS — {w:.0f} W  |  {status}  |  Bat:{bat}%"
            else:
                icon.title = "⚡ UPS Monitor — Connecting to UPS via USB…"
            time.sleep(5)

    threading.Thread(target=update_loop, daemon=True).start()
    icon.run()


# ══════════════════════════════════════════════════════
#  SINGLE INSTANCE LOCK
# ══════════════════════════════════════════════════════
def check_single_instance():
    import ctypes
    ERROR_ALREADY_EXISTS = 183
    mutex_name = "UPS_Power_Monitor_Mutex_v1"
    mutex = ctypes.windll.kernel32.CreateMutexW(None, False, mutex_name)
    if ctypes.windll.kernel32.GetLastError() == ERROR_ALREADY_EXISTS:
        log.warning("Another instance is running. Waking it up and exiting.")
        try:
            requests.get(f"http://localhost:{DASHBOARD_PORT}/api/show_window", timeout=1)
        except Exception:
            pass
        os._exit(0)
    return mutex


# ══════════════════════════════════════════════════════
#  ENTRY POINT
# ══════════════════════════════════════════════════════
_app_mutex = None

def main():
    global _app_mutex
    _app_mutex = check_single_instance()
    
    # Set AppUserModelID on Windows so taskbar groups properly and shows custom icon
    if sys.platform == "win32":
        try:
            import ctypes
            ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("DMStyles.UPSPowerMonitor.v1.4.2")
        except Exception as e:
            log.warning(f"Could not set AppUserModelID: {e}")
            
    log.info("=" * 60)
    log.info(f"UPS Power Monitor {VERSION} starting…")
    init_db()
    # Restore Supabase session if credentials are saved
    try:
        import supabase_sync
        
        def save_refreshed_tokens(access, refresh):
            if access and refresh and (settings.get("supabase_access_token") != access or settings.get("supabase_refresh_token") != refresh):
                settings["supabase_access_token"] = access
                settings["supabase_refresh_token"] = refresh
                save_settings(settings)
                log.info("Supabase tokens were automatically refreshed and saved.")
        
        supabase_sync.auth_callback = save_refreshed_tokens
        
        access = settings.get("supabase_access_token")
        refresh = settings.get("supabase_refresh_token")
        if access and refresh:
            log.info("Restoring Supabase session from settings...")
            supabase_sync.set_supabase_session(access, refresh)
        supabase_sync.start_sync_thread(str(DB_PATH))
    except Exception as e:
        log.error(f"Failed to restore session or start supabase sync thread: {e}")

    def _enforce_viewpower_state():
        src = settings.get("data_source", "direct")
        if src == "viewpower":
            _start_viewpower()
        else:
            _stop_viewpower()
            
    _enforce_viewpower_state()

    threading.Thread(target=fast_poll_loop, daemon=True).start()
    threading.Thread(target=db_write_loop,  daemon=True).start()
    threading.Thread(target=run_flask,       daemon=True).start()
    time.sleep(2)
    threading.Thread(target=create_tray,     daemon=True).start()

    import webview
    global window
    window = webview.create_window(
        title="UPS Power Monitor",
        url=DASHBOARD_URL,
        width=1200, height=840,
        resizable=True, min_size=(960, 640),
        hidden="--minimized" in sys.argv,
    )
    window.events.closing += on_closing

    def set_native_icon():
        if sys.platform == "win32":
            try:
                # Wait for native window to be initialized (up to 3 seconds)
                for _ in range(30):
                    if window.native is not None:
                        break
                    time.sleep(0.1)
                
                if window.native is None:
                    log.warning("Native window never initialized, cannot set icon")
                    return
                
                native_type = type(window.native).__name__
                log.info(f"Native window initialized. Type: {native_type}")
                
                icon_path = str(BASE_DIR / "static" / "favicon.ico")
                if not os.path.exists(icon_path):
                    log.warning(f"Icon path not found: {icon_path}")
                    return
                
                import clr
                
                if "Form" in native_type:  # WinForms Form
                    clr.AddReference('System.Drawing')
                    clr.AddReference('System.Windows.Forms')
                    from System.Drawing import Icon
                    from System import Action
                    
                    def set_winforms_icon():
                        window.native.Icon = Icon(icon_path)
                        log.info("Set native WinForms window icon successfully")
                        
                    if window.native.InvokeRequired:
                        window.native.Invoke(Action(set_winforms_icon))
                    else:
                        set_winforms_icon()
                        
                elif "Window" in native_type:  # WPF Window
                    clr.AddReference('System.Windows.Presentation')
                    clr.AddReference('PresentationCore')
                    clr.AddReference('WindowsBase')
                    from System.Windows.Media.Imaging import BitmapFrame
                    from System import Uri, Action
                    
                    def set_wpf_icon():
                        window.native.Icon = BitmapFrame.Create(Uri(icon_path))
                        log.info("Set native WPF window icon successfully")
                        
                    if not window.native.Dispatcher.CheckAccess():
                        window.native.Dispatcher.Invoke(Action(set_wpf_icon))
                    else:
                        set_wpf_icon()
                else:
                    log.warning(f"Unknown native window type: {native_type}")
            except Exception as e:
                log.warning(f"Could not set native window icon: {e}")

    webview.start(set_native_icon)


if __name__ == "__main__":
    main()

