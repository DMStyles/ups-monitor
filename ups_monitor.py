"""
UPS Power Monitor - Main Backend
Communicates with ViewPower (localhost:15178) to track UPS data,
calculates daily energy usage, and serves a local web dashboard.
Runs as a Windows system tray application.
"""

import os
import sys
import json
import time
import sqlite3
import logging
import threading
import webbrowser
import subprocess
from datetime import datetime, date, timedelta
from pathlib import Path

import requests
from bs4 import BeautifulSoup
from flask import Flask, jsonify, render_template, request
from PIL import Image, ImageDraw, ImageFont
import pystray

# ─────────────────────────────────────────────
#  CONFIG
# ─────────────────────────────────────────────
VIEWPOWER_BASE   = "http://localhost:15178/ViewPower"
DASHBOARD_PORT   = 8765
DASHBOARD_URL    = f"http://localhost:{DASHBOARD_PORT}"
POLL_INTERVAL    = 30          # seconds between ViewPower polls
UPS_VA           = 1200        # VA rating of your Prolink UPS
POWER_FACTOR     = 0.6         # standard line-interactive PF
MAX_WATTS        = UPS_VA * POWER_FACTOR   # 720 W
ELEC_RATE_LKR    = 30.0        # LKR per kWh (Sri Lanka domestic avg — change to your rate)

BASE_DIR  = Path(__file__).parent
DB_PATH   = BASE_DIR / "energy.db"
LOG_PATH  = BASE_DIR / "ups_monitor.log"

logging.basicConfig(
    filename=LOG_PATH,
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger(__name__)

# ─────────────────────────────────────────────
#  GLOBAL STATE  (thread-safe via lock)
# ─────────────────────────────────────────────
state_lock = threading.Lock()
ups_state = {
    "connected":        False,
    "ups_mode":         "Unknown",
    "input_voltage":    0.0,
    "output_voltage":   0.0,
    "frequency":        0.0,
    "load_percent":     0,
    "watts":            0.0,
    "battery_voltage":  0.0,
    "battery_capacity": 0,
    "max_watts":        MAX_WATTS,
    "last_update":      None,
    "device_id":        None,
}


# ─────────────────────────────────────────────
#  DATABASE
# ─────────────────────────────────────────────
def init_db():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("""
        CREATE TABLE IF NOT EXISTS readings (
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
            ups_mode         TEXT
        )
    """)
    conn.commit()
    conn.close()


def save_reading(data: dict):
    try:
        now = datetime.now()
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        c.execute("""
            INSERT INTO readings
                (ts, date, input_voltage, output_voltage, frequency,
                 load_percent, watts, battery_voltage, battery_capacity, ups_mode)
            VALUES (?,?,?,?,?,?,?,?,?,?)
        """, (
            now.isoformat(),
            now.strftime("%Y-%m-%d"),
            data.get("input_voltage"),
            data.get("output_voltage"),
            data.get("frequency"),
            data.get("load_percent"),
            data.get("watts"),
            data.get("battery_voltage"),
            data.get("battery_capacity"),
            data.get("ups_mode"),
        ))
        conn.commit()
        conn.close()
    except Exception as e:
        log.error(f"DB save error: {e}")


def get_daily_stats(target_date: str = None):
    """Return kWh and cost for a given date (defaults to today)."""
    if target_date is None:
        target_date = date.today().isoformat()
    try:
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        c.execute("""
            SELECT watts, ts FROM readings WHERE date=? ORDER BY ts ASC
        """, (target_date,))
        rows = c.fetchall()
        conn.close()

        kwh = 0.0
        for i in range(1, len(rows)):
            w0, t0 = rows[i-1]
            _, t1  = rows[i]
            dt = (datetime.fromisoformat(t1) - datetime.fromisoformat(t0)).total_seconds()
            kwh += (w0 / 1000.0) * (dt / 3600.0)

        # Add partial interval from last reading to now
        if rows:
            last_w, last_t = rows[-1]
            dt = (datetime.now() - datetime.fromisoformat(last_t)).total_seconds()
            dt = min(dt, POLL_INTERVAL * 2)   # cap at 2 intervals
            kwh += (last_w / 1000.0) * (dt / 3600.0)

        return {
            "date":       target_date,
            "kwh":        round(kwh, 4),
            "cost_lkr":   round(kwh * ELEC_RATE_LKR, 2),
            "samples":    len(rows),
        }
    except Exception as e:
        log.error(f"Daily stats error: {e}")
        return {"date": target_date, "kwh": 0, "cost_rs": 0, "samples": 0}


def get_hourly_data(target_date: str = None):
    """Return hourly average watts for the given date."""
    if target_date is None:
        target_date = date.today().isoformat()
    try:
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        c.execute("""
            SELECT strftime('%H', ts) as hour, AVG(watts)
            FROM readings WHERE date=?
            GROUP BY hour ORDER BY hour
        """, (target_date,))
        rows = c.fetchall()
        conn.close()
        return [{"hour": int(r[0]), "avg_watts": round(r[1], 1)} for r in rows]
    except Exception as e:
        log.error(f"Hourly data error: {e}")
        return []


# ─────────────────────────────────────────────
#  VIEWPOWER SCRAPER
# ─────────────────────────────────────────────
class ViewPowerClient:
    """
    Communicates with the local ViewPower software.
    Tries multiple strategies (JSON endpoint → HTML scrape).
    """
    HEADERS = {"Accept": "application/json, text/html, */*", "User-Agent": "UPSMonitor/1.0"}
    TIMEOUT  = 5

    def __init__(self, base_url: str = VIEWPOWER_BASE):
        self.base_url = base_url.rstrip("/")
        self.session  = requests.Session()
        self.session.headers.update(self.HEADERS)
        self._device_id = None

    # ── public ──────────────────────────────
    def fetch(self) -> dict | None:
        """Return parsed UPS data dict, or None if ViewPower unreachable."""
        # Try reqMonitorData POST strategy first
        data = self._try_req_monitor_data()
        if data:
            return data

        # Fallbacks
        data = self._try_load_info_action()
        if data:
            return data
        data = self._try_device_summary_action()
        if data:
            return data
        data = self._try_html_monitor()
        return data

    def _try_req_monitor_data(self) -> dict | None:
        """Fetch real-time UPS data via the reqMonitorData endpoint using the active portName."""
        try:
            # 1. Fetch monitor page to get portName
            monitor_url = f"{self.base_url}/monitor"
            r = self.session.get(monitor_url, timeout=self.TIMEOUT)
            if r.status_code != 200:
                log.debug(f"ReqMonitorData: /monitor page returned status {r.status_code}")
                return None
            
            html = r.text
            
            # Extract portName from Javascript in monitor page
            import re
            m = re.search(r'var\s+portName\s*=\s*\"([^\"]+)\";', html)
            if not m:
                m = re.search(r'var\s+portName\s*=\s*\'([^\']+)\';', html)
                
            if m:
                port_name = m.group(1)
                log.debug(f"Parsed portName from monitor page: {port_name}")
            else:
                # Fallback to device tree check if not found
                log.debug("portName not found in /monitor HTML, checking device tree...")
                port_name = self._resolve_port_name_from_tree()
                
            if not port_name:
                port_name = "USB2F7113A9"  # last-resort default
                
            # 2. Make POST request to reqMonitorData
            post_url = f"{self.base_url}/workstatus/reqMonitorData"
            r_post = self.session.post(post_url, data={"portName": port_name}, timeout=self.TIMEOUT)
            if r_post.status_code == 200:
                j = r_post.json()
                work_info = j.get("workInfo")
                if work_info:
                    return self._parse_work_info(work_info)
        except Exception as e:
            log.debug(f"reqMonitorData strategy failed: {e}")
        return None

    def _resolve_port_name_from_tree(self) -> str | None:
        """Fetch the device list and construct the portName."""
        try:
            import json
            import random
            tree_url = f"{self.base_url}/initDeviceTree?{random.random()}"
            r = self.session.get(tree_url, timeout=self.TIMEOUT)
            if r.status_code == 200:
                tree = r.json()
                for node in tree:
                    if node.get("pId") == "11" or "USB" in node.get("name", ""):
                        name = node.get("name", "")
                        import re
                        m_name = re.match(r'([A-Za-z]+)\s*\(id=([A-Za-z0-9]+)_[A-Za-z0-9]+\)', name)
                        if m_name:
                            constructed = m_name.group(1) + m_name.group(2)
                            log.info(f"Resolved portName from device tree: {constructed}")
                            return constructed
        except Exception as e:
            log.debug(f"Failed to resolve portName from tree: {e}")
        return None

    def _parse_work_info(self, work_info: dict) -> dict | None:
        """Parse the workInfo dictionary from ViewPower response."""
        try:
            def to_float(val, default=0.0):
                if val is None or val == "" or val == "----":
                    return default
                try:
                    return float(val)
                except ValueError:
                    return default

            def to_int(val, default=0):
                if val is None or val == "" or val == "----":
                    return default
                try:
                    return int(val)
                except ValueError:
                    return default

            return {
                "input_voltage":    to_float(work_info.get("inputVoltage")),
                "output_voltage":   to_float(work_info.get("outputVoltage")),
                "frequency":        to_float(work_info.get("outputFrequency")),
                "load_percent":     to_int(work_info.get("outputLoadPercent")),
                "battery_voltage":  to_float(work_info.get("batteryVoltage")),
                "battery_capacity": to_int(work_info.get("batteryCapacity")),
                "ups_mode":         work_info.get("workMode", "Line mode"),
            }
        except Exception as e:
            log.debug(f"Failed to parse workInfo: {e}")
            return None

    # ── strategy 1: /loadInfo.action ────────
    def _try_load_info_action(self) -> dict | None:
        device_id = self._device_id or self._get_device_id()
        if device_id is None:
            return None
        try:
            url = f"{self.base_url}/loadInfo.action"
            r = self.session.get(url, params={"deviceId": device_id}, timeout=self.TIMEOUT)
            if r.status_code == 200:
                j = r.json()
                return self._parse_load_info_json(j)
        except Exception as e:
            log.debug(f"loadInfo.action failed: {e}")
        return None

    def _get_device_id(self) -> str | None:
        for endpoint in ("/deviceList.action", "/getDeviceList.action"):
            try:
                r = self.session.get(self.base_url + endpoint, timeout=self.TIMEOUT)
                if r.status_code == 200:
                    j = r.json()
                    devs = j.get("deviceList") or j.get("devices") or []
                    if devs:
                        self._device_id = str(devs[0].get("deviceId") or devs[0].get("id") or "")
                        log.info(f"Device ID resolved: {self._device_id}")
                        return self._device_id
            except Exception as e:
                log.debug(f"deviceList {endpoint} failed: {e}")
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
                "ups_mode":         j.get("upsMode", "Unknown"),
            }
        except Exception:
            return None

    # ── strategy 2: /getDeviceSummary.action ──
    def _try_device_summary_action(self) -> dict | None:
        device_id = self._device_id or self._get_device_id()
        if device_id is None:
            return None
        try:
            url = f"{self.base_url}/getDeviceSummary.action"
            r = self.session.get(url, params={"deviceId": device_id}, timeout=self.TIMEOUT)
            if r.status_code == 200 and r.text.strip().startswith("{"):
                return self._parse_load_info_json(r.json())
        except Exception as e:
            log.debug(f"getDeviceSummary failed: {e}")
        return None

    # ── strategy 3: HTML scrape ──────────────
    def _try_html_monitor(self) -> dict | None:
        """Scrape the ViewPower web monitor page."""
        urls_to_try = [
            f"{self.base_url}/monitor",
            f"http://localhost:15178/ViewPower/",
        ]
        for url in urls_to_try:
            try:
                r = self.session.get(url, timeout=self.TIMEOUT)
                if r.status_code == 200 and "<html" in r.text.lower():
                    data = self._parse_html(r.text)
                    if data:
                        log.info("Data retrieved via HTML scrape.")
                        return data
            except Exception as e:
                log.debug(f"HTML scrape {url} failed: {e}")
        return None

    def _parse_html(self, html: str) -> dict | None:
        """Parse ViewPower monitor HTML to extract UPS values."""
        try:
            soup = BeautifulSoup(html, "html.parser")

            def find_val(label_text: str, default=0):
                """Find a value next to a label in the page."""
                # Method 1: look for text in td/label/span then sibling
                for tag in soup.find_all(string=lambda t: t and label_text.lower() in t.lower()):
                    parent = tag.parent
                    # Look at next sibling or next element
                    for sib in [parent.find_next_sibling(), parent.parent.find_next_sibling()]:
                        if sib:
                            txt = sib.get_text(strip=True)
                            num = _extract_number(txt)
                            if num is not None:
                                return num
                # Method 2: look for input/span with class containing value
                return default

            def _extract_number(txt: str):
                import re
                m = re.search(r"[-+]?\d*\.?\d+", txt)
                return float(m.group()) if m else None

            iv = find_val("Input voltage")
            ov = find_val("Output voltage")
            of = find_val("Output frequency")
            ll = find_val("Load level")
            bv = find_val("Battery voltage")
            bc = find_val("Battery capacity")

            # Try input type=text fields which often hold the values
            inputs = soup.find_all("input", {"type": "text"})
            values = [_extract_number(i.get("value", "")) for i in inputs if i.get("value")]
            values = [v for v in values if v is not None]
            log.debug(f"HTML input values found: {values}")

            # ViewPower typically shows values in order: inputV, outputV, freq, load, battV, battC
            if len(values) >= 6 and iv == 0:
                iv, ov, of, ll, bv, bc = values[0], values[1], values[2], values[3], values[4], values[5]

            if iv == 0 and ov == 0:
                return None   # Couldn't parse anything useful

            return {
                "input_voltage":    iv,
                "output_voltage":   ov,
                "frequency":        of,
                "load_percent":     int(ll),
                "battery_voltage":  bv,
                "battery_capacity": int(bc),
                "ups_mode":         "Line mode",
            }
        except Exception as e:
            log.debug(f"HTML parse error: {e}")
            return None


# ─────────────────────────────────────────────
#  POLLING THREAD
# ─────────────────────────────────────────────
vp_client = ViewPowerClient()

def polling_loop():
    log.info("Polling thread started.")
    while True:
        try:
            data = vp_client.fetch()
            with state_lock:
                if data:
                    watts = round(MAX_WATTS * (data["load_percent"] / 100.0), 1)
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
                        "last_update":      datetime.now().isoformat(),
                    })
                    save_reading({**data, "watts": watts})
                    log.info(f"Poll OK — {watts}W ({data['load_percent']}% load), Bat:{data['battery_capacity']}%")
                else:
                    ups_state["connected"] = False
                    log.warning("ViewPower unreachable or data not available.")
        except Exception as e:
            log.error(f"Polling error: {e}")
            with state_lock:
                ups_state["connected"] = False

        time.sleep(POLL_INTERVAL)


# ─────────────────────────────────────────────
#  FLASK APP
# ─────────────────────────────────────────────
app = Flask(__name__, template_folder=str(BASE_DIR / "templates"), static_folder=str(BASE_DIR / "static"))
app.config["SECRET_KEY"] = "ups-monitor-key-2024"

@app.route("/")
def index():
    return render_template("index.html")

@app.route("/api/status")
def api_status():
    with state_lock:
        s = dict(ups_state)
    today = get_daily_stats()
    s.update({
        "daily_kwh":    today["kwh"],
        "daily_cost":   today["cost_lkr"],
        "samples":      today["samples"],
        "elec_rate":    ELEC_RATE_LKR,
        "max_watts":    MAX_WATTS,
    })
    return jsonify(s)

@app.route("/api/history")
def api_history():
    d = request.args.get("date", date.today().isoformat())
    return jsonify(get_hourly_data(d))

@app.route("/api/daily")
def api_daily():
    # Return last 7 days of stats
    results = []
    for i in range(6, -1, -1):
        d = (date.today() - timedelta(days=i)).isoformat()
        results.append(get_daily_stats(d))
    return jsonify(results)

@app.route("/api/settings", methods=["POST"])
def api_settings():
    global ELEC_RATE_LKR
    body = request.get_json(force=True)
    if "elec_rate" in body:
        ELEC_RATE_LKR = float(body["elec_rate"])
    return jsonify({"ok": True, "elec_rate": ELEC_RATE_LKR})

def run_flask():
    log.info(f"Flask server starting on port {DASHBOARD_PORT}")
    app.run(host="127.0.0.1", port=DASHBOARD_PORT, debug=False, use_reloader=False)


# ─────────────────────────────────────────────
#  SYSTEM TRAY ICON
# ─────────────────────────────────────────────
def make_tray_icon(watts: float = 0, connected: bool = False) -> Image.Image:
    """Draw a 64×64 tray icon showing connection status + watts."""
    size = 64
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Background circle
    bg_color = (30, 200, 100) if connected else (200, 80, 80)
    draw.ellipse([2, 2, size-2, size-2], fill=bg_color)

    # Lightning bolt symbol ⚡ (simplified polygon)
    bolt = [(32, 4), (18, 34), (30, 34), (24, 60), (46, 26), (34, 26)]
    draw.polygon(bolt, fill=(255, 255, 255))

    return img


def create_tray():
    def open_dashboard(icon, item):
        webbrowser.open(DASHBOARD_URL)

    def quit_app(icon, item):
        log.info("Quit requested from tray.")
        icon.stop()
        os._exit(0)

    icon_image = make_tray_icon(connected=False)
    menu = pystray.Menu(
        pystray.MenuItem("📊 Open Dashboard", open_dashboard, default=True),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("❌ Quit", quit_app),
    )
    icon = pystray.Icon("UPS Monitor", icon_image, "UPS Monitor — Loading…", menu)

    def update_tray():
        """Periodically update tray icon title."""
        while True:
            with state_lock:
                w = ups_state["watts"]
                con = ups_state["connected"]
                bat = ups_state["battery_capacity"]
            icon.icon = make_tray_icon(w, con)
            if con:
                icon.title = f"⚡ UPS Monitor — {w:.0f}W  |  Bat: {bat}%"
            else:
                icon.title = "⚡ UPS Monitor — Waiting for ViewPower…"
            time.sleep(10)

    threading.Thread(target=update_tray, daemon=True).start()
    icon.run()


# ─────────────────────────────────────────────
#  ENTRY POINT
# ─────────────────────────────────────────────
def main():
    log.info("=" * 60)
    log.info("UPS Power Monitor starting…")
    init_db()

    # Start polling thread
    t_poll = threading.Thread(target=polling_loop, daemon=True)
    t_poll.start()

    # Start Flask in background thread
    t_flask = threading.Thread(target=run_flask, daemon=True)
    t_flask.start()

    # Give Flask a moment to start, then open browser
    time.sleep(2)
    webbrowser.open(DASHBOARD_URL)

    # Run system tray (blocks main thread)
    log.info("Starting system tray…")
    create_tray()


if __name__ == "__main__":
    main()
