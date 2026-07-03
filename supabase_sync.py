import os
import sqlite3
import threading
import time
from datetime import datetime
from supabase import create_client, Client
import logging

log = logging.getLogger('werkzeug')

SUPABASE_URL = "https://izupevznjwrqzfoyzxhw.supabase.co"
SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml6dXBldnpuandycXpmb3l6eGh3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI1NTY5NzMsImV4cCI6MjA5ODEzMjk3M30.BCmbOArY6vT7BGl3u_hRoEc6pQJXfhAOQNksmVNvwN0"

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
sync_enabled = False
user_name = None
user_email = None
user_avatar = None
auth_callback = None

def _on_auth_change(event, session):
    if auth_callback and session:
        auth_callback(session.access_token, session.refresh_token)

supabase.auth.on_auth_state_change(_on_auth_change)

def set_supabase_session(access_token, refresh_token):
    global sync_enabled, user_name, user_email, user_avatar
    try:
        try:
            res = supabase.auth.set_session(access_token, refresh_token)
        except Exception as e:
            log.warning(f"set_session failed (likely expired). Attempting manual refresh: {e}")
            res = supabase.auth.refresh_session(refresh_token)

        user = res.user
        if user:
            user_email = user.email
            user_name = user.user_metadata.get('full_name', '')
            # Try to get avatar
            user_avatar = user.user_metadata.get('avatar_url', '')
            if not user_avatar:
                user_avatar = user.user_metadata.get('picture', '')
        sync_enabled = True
        log.info(f"Supabase session established for {user_email}")
        return True
    except Exception as e:
        log.error(f"Failed to set/refresh Supabase session: {e}")
        return False

def sign_out_supabase():
    global sync_enabled, user_name, user_email, user_avatar
    try:
        supabase.auth.sign_out()
    except Exception:
        pass
    sync_enabled = False
    user_name = None
    user_email = None
    user_avatar = None
    log.info("Supabase session cleared")

def fetch_settings_from_cloud():
    try:
        res = supabase.table("user_settings").select("*").maybe_single().execute()
        if res and res.data:
            return res.data
    except Exception as e:
        log.warning(f"Failed to fetch settings from Supabase: {e}")
    return None

def sync_settings_to_cloud(settings_dict):
    global sync_enabled
    if not sync_enabled:
        return
    
    data = {
        "ups_model":             settings_dict.get("ups_model", ""),
        "low_battery_threshold": int(settings_dict.get("low_battery_threshold", 20)),
        "auto_shutdown_enabled": bool(settings_dict.get("auto_shutdown_enabled", False)),
        "auto_shutdown_action":  settings_dict.get("auto_shutdown_action", "shutdown"),
        "auto_shutdown_pct":     int(settings_dict.get("auto_shutdown_pct", 10)),
        "auto_shutdown_mins":    int(settings_dict.get("auto_shutdown_mins", 5)),
        "billing_days":          int(settings_dict.get("billing_days", 30)),
        "fast_poll_interval":    int(settings_dict.get("fast_poll_interval", 2)),
        "db_write_interval":     int(settings_dict.get("db_write_interval", 60)),
        "notifications_enabled": bool(settings_dict.get("notifications_enabled", True)),
        "ntfy_topic":            settings_dict.get("ntfy_topic", ""),
        "autostart":             bool(settings_dict.get("autostart", False)),
        "battery_replaced_date": settings_dict.get("battery_replaced_date", ""),
        "updated_at":            datetime.now().isoformat()
    }
    
    try:
        supabase.table("user_settings").upsert(data).execute()
        log.info("Synced settings to Supabase")
    except Exception as e:
        log.warning(f"Failed to sync settings to Supabase: {e}")


last_sync_time = None

def sync_worker(db_path):
    global sync_enabled, last_sync_time
    while True:
        if sync_enabled:
            try:
                sync_readings(db_path)
                sync_outages(db_path)
                sync_bills(db_path)
                sync_daily_stats(db_path)
                last_sync_time = datetime.now().strftime("%I:%M %p")
            except Exception as e:
                log.error(f"Cloud sync error: {e}")
        time.sleep(60) # Sync every 60 seconds

def sync_readings(db_path):
    # Only fetch last 50 to avoid huge payloads on first sync
    with sqlite3.connect(db_path) as conn:
        c = conn.cursor()
        c.execute('''SELECT ts, date, input_voltage, output_voltage, frequency, 
                            load_percent, watts, battery_voltage, battery_capacity, 
                            ups_mode, temperature 
                     FROM readings ORDER BY ts DESC LIMIT 50''')
        rows = c.fetchall()
        
    for r in rows[::-1]:
        ts = r[0]
        try:
            dt = datetime.fromisoformat(ts)
            if dt.tzinfo is None:
                ts = dt.astimezone().isoformat()
        except Exception:
            pass
            
        data = {
            "ts": ts, "date": r[1], "input_voltage": r[2], "output_voltage": r[3],
            "frequency": r[4], "load_percent": r[5], "watts": r[6], "battery_voltage": r[7],
            "battery_capacity": r[8], "ups_mode": r[9], "temperature": r[10]
        }
        # In a real app we'd track last_synced_ts, but for this demo we just upsert/insert
        try:
            supabase.table("readings").insert(data).execute()
        except Exception as e:
            if "duplicate key" not in str(e):
                pass # ignore duplicates if we didn't add a unique constraint

def sync_outages(db_path):
    with sqlite3.connect(db_path) as conn:
        c = conn.cursor()
        c.execute('''SELECT id, started_at, ended_at, duration_seconds, 
                            battery_at_start, battery_at_end 
                     FROM outages ORDER BY started_at DESC LIMIT 10''')
        rows = c.fetchall()
        
    for r in rows:
        data = {
            "id": r[0], "started_at": r[1], "ended_at": r[2], 
            "duration_seconds": r[3], "battery_at_start": r[4], "battery_at_end": r[5]
        }
        try:
            supabase.table("outages").upsert(data).execute()
        except Exception:
            pass

def sync_bills(db_path):
    with sqlite3.connect(db_path) as conn:
        c = conn.cursor()
        c.execute('''SELECT month, amount_lkr, calculated_kwh, ups_kwh FROM ceb_bills''')
        rows = c.fetchall()
        
    for r in rows:
        data = {
            "month": r[0], "amount_lkr": r[1], "calculated_kwh": r[2], "ups_kwh": r[3]
        }
        try:
            supabase.table("ceb_bills").upsert(data).execute()
        except Exception:
            pass

def sync_daily_stats(db_path):
    """Compute last 8 days of kWh and push to Supabase daily_stats table."""
    from datetime import date, timedelta
    MAX_GAP = 300  # seconds — skip gaps longer than 5 mins (app was off)
    today = date.today()
    
    for day_offset in range(32):
        target = (today - timedelta(days=day_offset)).isoformat()
        try:
            with sqlite3.connect(db_path) as conn:
                c = conn.cursor()
                c.execute("SELECT watts, ts FROM readings WHERE date=? ORDER BY ts ASC", (target,))
                rows = c.fetchall()
            
            if not rows:
                continue
            
            kwh = 0.0
            for i in range(1, len(rows)):
                w0, t0 = rows[i - 1]
                _,  t1 = rows[i]
                try:
                    t0_dt = datetime.fromisoformat(t0)
                    t1_dt = datetime.fromisoformat(t1)
                    if t0_dt.tzinfo is None:
                        t0_dt = t0_dt.replace(tzinfo=__import__('datetime').timezone.utc)
                    if t1_dt.tzinfo is None:
                        t1_dt = t1_dt.replace(tzinfo=__import__('datetime').timezone.utc)
                    dt = (t1_dt - t0_dt).total_seconds()
                except Exception:
                    dt = 0
                if 0 < dt <= MAX_GAP:
                    kwh += (float(w0) / 1000.0) * (dt / 3600.0)
            
            data = {
                "date": target,
                "kwh": round(kwh, 4),
                "samples": len(rows),
                "updated_at": datetime.utcnow().isoformat() + "Z"
            }
            # Try to compute cost using the desktop's own calc_ceb_bill
            try:
                from ups_monitor import get_daily_stats as _gds
                day_stat = _gds(target)
                data["cost_lkr"] = day_stat.get("cost_lkr", 0.0)
            except Exception:
                pass
            supabase.table("daily_stats").upsert(data, on_conflict="user_id,date").execute()
            log.info(f"Synced daily_stats for {target}: {kwh:.4f} kWh")
        except Exception as e:
            log.warning(f"sync_daily_stats error for {target}: {e}")

def start_sync_thread(db_path):
    t = threading.Thread(target=sync_worker, args=(db_path,), daemon=True)
    t.start()
