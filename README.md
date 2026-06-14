# ⚡ UPS Power Monitor

A beautiful Windows system tray app that communicates with your **Prolink 1.2kVA UPS** through ViewPower to track real-time power consumption and daily energy usage.

---

## 📋 Requirements

- Windows 10/11
- **ViewPower** must be running (already installed on your system at `localhost:15178`)
- Python 3.10+ (installed automatically by `install.bat`)

---

## 🚀 Quick Start

### 1. Install
Double-click **`install.bat`**
- Automatically installs Python if not found (via winget)
- Installs all required Python packages

### 2. Launch
Double-click **`start_ups_monitor.bat`**
- A ⚡ tray icon appears in the taskbar notification area (bottom-right)
- Your browser opens automatically to the dashboard at `http://localhost:8765`

### 3. Start with Windows (optional)
Double-click **`setup_autostart.bat`**
- Registers the app in Windows Task Scheduler
- App starts 30 seconds after you log in

---

## 📊 Dashboard Features

| Feature | Details |
|---|---|
| **Real-time Watt gauge** | Shows current draw (0–720W) with animated arc |
| **Load percentage** | % of UPS capacity being used |
| **Daily kWh** | Energy consumed today |
| **Estimated cost** | In **LKR** (configurable rate) |
| **UPS Vitals** | Input/Output voltage, frequency, battery % |
| **Hourly chart** | Average watts per hour today |
| **7-day history** | Daily kWh for the past week |

---

## ⚙️ Configuration

### Electricity Rate
In the dashboard → **Today's Energy** card → change the LKR/kWh value and click **Save**.

### UPS Specs (ups_monitor.py)
```python
UPS_VA       = 1200    # Your UPS VA rating
POWER_FACTOR = 0.6     # Standard line-interactive power factor
ELEC_RATE_LKR = 30.0  # LKR per kWh
POLL_INTERVAL = 30     # Seconds between ViewPower polls
```

---

## 🔌 How it Connects to ViewPower

The app queries ViewPower's local web server using three strategies:
1. **JSON endpoint** → `http://localhost:15178/ViewPower/loadInfo.action`
2. **Summary endpoint** → `http://localhost:15178/ViewPower/getDeviceSummary.action`
3. **HTML scrape** → Parses the ViewPower monitor page directly

ViewPower **must be running** before the UPS Monitor starts.

---

## 📁 File Structure

```
ups-monitor/
├── ups_monitor.py        ← Main Python backend
├── templates/
│   └── index.html        ← Dashboard HTML
├── static/
│   ├── style.css         ← Dark glassmorphism styles
│   └── app.js            ← Frontend JavaScript
├── energy.db             ← SQLite database (auto-created)
├── ups_monitor.log       ← Log file (auto-created)
├── requirements.txt
├── install.bat           ← Run first!
├── start_ups_monitor.bat ← Launch the app
└── setup_autostart.bat   ← Enable Windows startup
```

---

## 🐛 Troubleshooting

**Dashboard shows "ViewPower Offline"**
→ Make sure ViewPower is running at `localhost:15178`
→ Check `ups_monitor.log` for detailed error messages

**Tray icon not appearing**
→ Check the system tray overflow (^ arrow near clock)
→ Look for errors in `ups_monitor.log`

**Wrong wattage shown**
→ Verify your UPS model is 1200VA (check `UPS_VA` in `ups_monitor.py`)

---

## 🗑️ Uninstall Autostart

```bat
schtasks /delete /tn "UPS Power Monitor" /f
```
