let hourlyChart, weekChart, monthlyChart, detailChart, batVoltChart, inputVoltChart;
let globalMaxWatts = 840;
let fastPollInterval = 2000;
let currentMonth = new Date().toISOString().slice(0, 7);

// Chart.js global config
Chart.defaults.color = '#7b8db0';
Chart.defaults.font.family = "'Inter', sans-serif";

function switchTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.remove('active'));
  
  document.getElementById(`tab-btn-${tabId}`).classList.add('active');
  document.getElementById(`tab-${tabId}`).classList.add('active');

  if (tabId === 'analytics') {
    loadAnalytics();
  }
}

async function initDashboard() {
  initCharts();
  await loadSettings(); // loads models, specs, and settings
  pollStatus();
  loadWeekData();
  
  // start live loop based on interval
  setInterval(pollStatus, fastPollInterval);
  // week data refreshes every 5 mins
  setInterval(loadWeekData, 300000);
}

// ─────────────────────────────────────────────────────────
// SETTINGS
// ─────────────────────────────────────────────────────────
async function loadSettings() {
  try {
    const res = await fetch('/api/settings');
    const settings = await res.json();
    
    // load models
    const mRes = await fetch('/api/models');
    const mData = await mRes.json();
    window.upsModels = mData.specs;
    
    const select = document.getElementById('s-model');
    select.innerHTML = mData.models.map(m => `<option value="${m}">${m}</option>`).join('');
    
    // Fill form
    select.value = settings.ups_model || mData.models[0];
    document.getElementById('s-rate').value = settings.elec_rate || 30.0;
    document.getElementById('s-low-bat').value = settings.low_battery_threshold || 20;
    
    document.getElementById('s-auto-shutdown').checked = !!settings.auto_shutdown_enabled;
    document.getElementById('s-shutdown-pct').value = settings.auto_shutdown_pct || 10;
    document.getElementById('s-shutdown-mins').value = settings.auto_shutdown_mins || 5;
    
    document.getElementById('s-fast-poll').value = settings.fast_poll_interval || 2;
    document.getElementById('s-fast-poll-val').innerText = (settings.fast_poll_interval || 2) + 's';
    fastPollInterval = (settings.fast_poll_interval || 2) * 1000;
    document.getElementById('live-interval').innerText = settings.fast_poll_interval || 2;
    
    document.getElementById('s-db-write').value = settings.db_write_interval || 60;
    document.getElementById('s-db-write-val').innerText = (settings.db_write_interval || 60) + 's';
    
    document.getElementById('s-notifications').checked = settings.notifications_enabled !== false;
    document.getElementById('s-ntfy').value = settings.ntfy_topic || '';
    document.getElementById('s-autostart').checked = !!settings.autostart;
    
    onModelChange();
    
  } catch (err) {
    console.error("Error loading settings:", err);
  }
}

function onModelChange() {
  const model = document.getElementById('s-model').value;
  const spec = window.upsModels[model];
  if (spec) {
    document.getElementById('ms-va').innerText = spec.va + ' VA';
    document.getElementById('ms-watts').innerText = spec.max_watts + ' W';
    document.getElementById('ms-pf').innerText = spec.power_factor;
    document.getElementById('ms-bat').innerText = spec.battery_desc;
    document.getElementById('ms-input').innerText = spec.input_range;
    document.getElementById('ms-wave').innerText = spec.waveform;
    document.getElementById('ms-transfer').innerText = spec.transfer_time;
    document.getElementById('ms-recharge').innerText = spec.recharge_time;
    
    globalMaxWatts = spec.max_watts;
    document.getElementById('gauge-max-label').innerText = `of ${spec.max_watts} W max`;
    document.getElementById('header-sub').innerHTML = `${model} &nbsp;•&nbsp; ${spec.max_watts}W Max Output`;
  }
}

async function saveSettings() {
  const payload = {
    ups_model: document.getElementById('s-model').value,
    elec_rate: parseFloat(document.getElementById('s-rate').value),
    low_battery_threshold: parseInt(document.getElementById('s-low-bat').value),
    auto_shutdown_enabled: document.getElementById('s-auto-shutdown').checked,
    auto_shutdown_pct: parseInt(document.getElementById('s-shutdown-pct').value),
    auto_shutdown_mins: parseInt(document.getElementById('s-shutdown-mins').value),
    fast_poll_interval: parseInt(document.getElementById('s-fast-poll').value),
    db_write_interval: parseInt(document.getElementById('s-db-write').value),
    notifications_enabled: document.getElementById('s-notifications').checked,
    ntfy_topic: document.getElementById('s-ntfy').value.trim(),
    autostart: document.getElementById('s-autostart').checked,
  };
  
  try {
    await fetch('/api/settings', { method: 'POST', body: JSON.stringify(payload) });
    const status = document.getElementById('save-status');
    status.innerText = "Saved successfully!";
    status.classList.add('show');
    setTimeout(() => status.classList.remove('show'), 2000);
    
    fastPollInterval = payload.fast_poll_interval * 1000;
    document.getElementById('live-interval').innerText = payload.fast_poll_interval;
    loadWeekData(); // re-calc costs
    
  } catch (err) {
    alert("Failed to save settings");
  }
}

// Sliders listeners
document.getElementById('s-fast-poll').addEventListener('input', e => {
  document.getElementById('s-fast-poll-val').innerText = e.target.value + 's';
});
document.getElementById('s-db-write').addEventListener('input', e => {
  document.getElementById('s-db-write-val').innerText = e.target.value + 's';
});

// ─────────────────────────────────────────────────────────
// DASHBOARD
// ─────────────────────────────────────────────────────────
function setGauge(watts) {
  const pct = Math.min(Math.max(watts / globalMaxWatts, 0), 1);
  const path = document.getElementById('gauge-fill-arc');
  const R = 70;
  const len = Math.PI * R;
  path.style.strokeDasharray = len;
  path.style.strokeDashoffset = len * (1 - pct);
  
  document.getElementById('gauge-watts').innerText = Math.round(watts);
}

// Initialize SVG Arc
const R = 70, CX = 110, CY = 130;
const d = `M ${CX - R} ${CY} A ${R} ${R} 0 0 1 ${CX + R} ${CY}`;
document.getElementById('gauge-bg-arc').setAttribute('d', d);
document.getElementById('gauge-fill-arc').setAttribute('d', d);

async function pollStatus() {
  try {
    const res = await fetch('/api/status');
    const d = await res.json();
    
    if (d.version) {
      document.getElementById('s-version').innerText = d.version;
      document.getElementById('app-version-footer').innerText = d.version;
    }
    
    if (!d.connected) {
      document.getElementById('status-badge').className = 'status-badge status-disconnected';
      document.getElementById('status-text').innerText = 'Disconnected';
      document.getElementById('last-update').innerText = d.last_update ? 'Last seen ' + d.last_update.substring(11,19) : 'Waiting for ViewPower…';
      return;
    }

    document.getElementById('status-badge').className = 'status-badge status-connected';
    document.getElementById('status-text').innerText = 'Connected';
    document.getElementById('last-update').innerText = 'Updated ' + d.last_update.substring(11,19);
    
    setGauge(d.watts);
    
    const lp = d.load_percent;
    document.getElementById('load-pct-text').innerText = lp + '%';
    document.getElementById('load-bar').style.width = lp + '%';
    
    const bc = d.battery_capacity;
    document.getElementById('v-batcap').innerText = bc + '%';
    document.getElementById('bat-bar').style.width = bc + '%';
    
    document.getElementById('v-input').innerText = d.input_voltage.toFixed(1) + ' V';
    document.getElementById('v-output').innerText = d.output_voltage.toFixed(1) + ' V';
    document.getElementById('v-freq').innerText = d.frequency.toFixed(1) + ' Hz';
    document.getElementById('v-mode').innerText = d.ups_mode;
    document.getElementById('v-batvolt').innerText = d.battery_voltage.toFixed(1) + ' V';
    
    if (d.temperature !== null) {
      document.getElementById('v-temp-item').style.display = 'flex';
      document.getElementById('v-temp').innerText = d.temperature.toFixed(1) + ' °C';
    }
    
    // Battery alert & runtime
    if (d.on_battery) {
      document.getElementById('battery-alert').style.display = 'flex';
      if (d.runtime_estimate !== null) {
        document.getElementById('runtime-badge').style.display = 'flex';
        document.getElementById('runtime-val').innerText = d.runtime_estimate;
      } else {
        document.getElementById('runtime-badge').style.display = 'none';
      }
    } else {
      document.getElementById('battery-alert').style.display = 'none';
      document.getElementById('runtime-badge').style.display = 'none';
    }

    document.getElementById('today-kwh').innerText = d.daily_kwh.toFixed(3);
    document.getElementById('today-cost').innerText = 'LKR ' + d.daily_cost.toFixed(2);
    document.getElementById('today-samples').innerText = d.samples;
    
  } catch (err) {
    console.log("Poll failed", err);
  }
}

async function loadWeekData() {
  try {
    const [histRes, weekRes] = await Promise.all([
      fetch('/api/history'),
      fetch('/api/daily')
    ]);
    const hist = await histRes.json();
    const week = await weekRes.json();

    hourlyChart.data.labels = hist.map(r => r.hour + ':00');
    hourlyChart.data.datasets[0].data = hist.map(r => r.avg_watts);
    hourlyChart.update();

    weekChart.data.labels = week.map(r => r.date.substring(5)); // MM-DD
    weekChart.data.datasets[0].data = week.map(r => r.kwh);
    weekChart.update();
  } catch (e) { console.error("Error loading week data", e); }
}

// ─────────────────────────────────────────────────────────
// ANALYTICS
// ─────────────────────────────────────────────────────────
async function loadAnalytics() {
  document.getElementById('month-label').innerText = currentMonth;
  
  try {
    const [monthRes, trendRes, outageRes] = await Promise.all([
      fetch(`/api/monthly?month=${currentMonth}`),
      fetch('/api/trends?days=30'),
      fetch('/api/outages')
    ]);
    const mData = await monthRes.json();
    const tData = await trendRes.json();
    const oData = await outageRes.json();
    
    // Monthly stats
    const tKwh = mData.reduce((s, d) => s + d.kwh, 0);
    const tCost = mData.reduce((s, d) => s + d.cost_lkr, 0);
    document.getElementById('m-total-kwh').innerText = tKwh.toFixed(2);
    document.getElementById('m-total-cost').innerText = tCost.toFixed(2);
    document.getElementById('m-days').innerText = mData.filter(d => d.samples > 0).length;
    document.getElementById('m-avg-daily').innerText = (tKwh / (mData.filter(d => d.samples > 0).length || 1)).toFixed(2);
    
    monthlyChart.data.labels = mData.map(d => d.date.substring(5)); // MM-DD
    monthlyChart.data.datasets[0].data = mData.map(d => d.kwh);
    monthlyChart.update();
    
    // Trends
    batVoltChart.data.labels = tData.map(d => d.date.substring(5));
    batVoltChart.data.datasets[0].data = tData.map(d => d.avg_bat_v);
    batVoltChart.update();
    
    inputVoltChart.data.labels = tData.map(d => d.date.substring(5));
    inputVoltChart.data.datasets[0].data = tData.map(d => d.avg_input_v);
    inputVoltChart.update();
    
    // Outages
    document.getElementById('outage-count').innerText = `${oData.length} outages`;
    const tb = document.getElementById('outage-tbody');
    if (oData.length === 0) {
      tb.innerHTML = '<tr><td colspan="7" class="no-data">No outages recorded</td></tr>';
    } else {
      tb.innerHTML = oData.map((o, i) => {
        const start = new Date(o.started_at).toLocaleString();
        const end = o.ended_at ? new Date(o.ended_at).toLocaleString() : 'Ongoing';
        const dur = o.duration_seconds ? Math.floor(o.duration_seconds/60) + 'm ' + (o.duration_seconds%60) + 's' : '—';
        return `<tr>
          <td>${oData.length - i}</td>
          <td>${start}</td>
          <td>${end}</td>
          <td>${dur}</td>
          <td style="color:var(--accent)">${o.battery_at_start}%</td>
          <td style="color:var(--warn)">${o.battery_at_end !== null ? o.battery_at_end+'%' : '—'}</td>
          <td>${o.ended_at ? 'Resolved' : '<span style="color:var(--warn)">Active</span>'}</td>
        </tr>`;
      }).join('');
    }
    
  } catch (err) {
    console.error("Analytics load error", err);
  }
}

function changeMonth(delta) {
  const d = new Date(currentMonth + "-01");
  d.setMonth(d.getMonth() + delta);
  currentMonth = d.toISOString().slice(0, 7);
  loadAnalytics();
}

async function showDailyDetail(dateStr) {
  // dateStr is MM-DD, we need YYYY-MM-DD
  const fullDate = currentMonth.substring(0,4) + '-' + dateStr;
  document.getElementById('detail-date').innerText = fullDate;
  document.getElementById('daily-detail-card').style.display = 'block';
  
  try {
    const res = await fetch(`/api/history?date=${fullDate}`);
    const data = await res.json();
    
    const kwh = data.reduce((s, r) => s + (r.avg_watts/1000), 0);
    const peak = Math.max(...data.map(r => r.max_watts));
    const avg = data.reduce((s, r) => s + r.avg_watts, 0) / (data.length || 1);
    const samples = data.reduce((s, r) => s + r.samples, 0);
    
    document.getElementById('d-kwh').innerText = kwh.toFixed(3);
    document.getElementById('d-peak').innerText = peak > 0 ? peak : '—';
    document.getElementById('d-avg').innerText = avg.toFixed(1);
    document.getElementById('d-readings').innerText = samples;
    
    detailChart.data.labels = data.map(r => r.hour + ':00');
    detailChart.data.datasets[0].data = data.map(r => r.avg_watts);
    detailChart.data.datasets[1].data = data.map(r => r.max_watts);
    detailChart.update();
    
    document.getElementById('daily-detail-card').scrollIntoView({behavior: 'smooth'});
    
  } catch (e) { console.error(e); }
}

function closeDailyDetail() {
  document.getElementById('daily-detail-card').style.display = 'none';
}

function exportCSV() {
  let start = document.getElementById('export-start').value;
  let end = document.getElementById('export-end').value;
  if (!start) {
    const d = new Date(); d.setDate(d.getDate()-7);
    start = d.toISOString().split('T')[0];
  }
  if (!end) end = new Date().toISOString().split('T')[0];
  window.location.href = `/api/export?start=${start}&end=${end}`;
}

// ─────────────────────────────────────────────────────────
// UPDATER
// ─────────────────────────────────────────────────────────
let updateUrl = null;
async function manualCheckUpdate() {
  const btn = document.getElementById('check-update-btn');
  const msg = document.getElementById('update-status-msg');
  btn.disabled = true;
  msg.innerText = "Checking...";
  try {
    const res = await fetch('/api/check_update');
    const data = await res.json();
    if (data.update_available) {
      msg.innerHTML = `Update <strong>${data.latest_version}</strong> available! <button onclick="performUpdateFromSettings()" class="settings-btn settings-btn-primary" style="padding:4px 10px; margin-left:10px; font-size:0.8rem;">Install Now</button>`;
      updateUrl = data.download_url;
    } else {
      msg.innerText = `You are on the latest version (${data.current_version}).`;
    }
  } catch (err) {
    msg.innerText = "Failed to check for updates.";
  }
  btn.disabled = false;
}
async function performUpdateFromSettings() {
  document.getElementById('update-status-msg').innerText = "Downloading and installing update... The app will restart.";
  await fetch('/api/perform_update', { method: 'POST', body: JSON.stringify({ download_url: updateUrl }) });
}

async function checkUpdateQuietly() {
  try {
    const res = await fetch('/api/check_update');
    const data = await res.json();
    if (data.update_available) {
      document.getElementById('update-version').innerText = data.latest_version;
      document.getElementById('update-banner').style.display = 'flex';
      updateUrl = data.download_url;
    }
  } catch(e) {}
}

function closeUpdateBanner() {
  document.getElementById('update-banner').style.display = 'none';
}

async function performUpdate() {
  const btn = document.getElementById('update-action-btn');
  btn.innerText = "Updating...";
  btn.disabled = true;
  await fetch('/api/perform_update', { method: 'POST', body: JSON.stringify({ download_url: updateUrl }) });
}

// ─────────────────────────────────────────────────────────
// CHARTS INIT
// ─────────────────────────────────────────────────────────
function initCharts() {
  const commonOpts = {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: { mode: 'index', intersect: false } },
    scales: {
      y: { grid: { color: 'rgba(255,255,255,0.05)' }, beginAtZero: true },
      x: { grid: { display: false } }
    }
  };

  const ctxHourly = document.getElementById('hourlyChart').getContext('2d');
  const gradB = ctxHourly.createLinearGradient(0,0,0,200);
  gradB.addColorStop(0, 'rgba(0,180,255,0.3)'); gradB.addColorStop(1, 'rgba(0,180,255,0)');
  hourlyChart = new Chart(ctxHourly, {
    type: 'line',
    data: { labels: [], datasets: [{ label: 'Avg Watts', data: [], borderColor: '#00b4ff', backgroundColor: gradB, fill: true, tension: 0.4 }] },
    options: commonOpts
  });

  const ctxWeek = document.getElementById('weekChart').getContext('2d');
  const gradG = ctxWeek.createLinearGradient(0,0,0,200);
  gradG.addColorStop(0, 'rgba(0,229,160,0.6)'); gradG.addColorStop(1, 'rgba(0,229,160,0.1)');
  weekChart = new Chart(ctxWeek, {
    type: 'bar',
    data: { labels: [], datasets: [{ label: 'kWh', data: [], backgroundColor: gradG, borderRadius: 4 }] },
    options: commonOpts
  });

  const ctxMonth = document.getElementById('monthlyChart').getContext('2d');
  monthlyChart = new Chart(ctxMonth, {
    type: 'bar',
    data: { labels: [], datasets: [{ label: 'kWh', data: [], backgroundColor: gradG, borderRadius: 2 }] },
    options: {
      ...commonOpts,
      onClick: (e, elements) => {
        if (elements.length > 0) {
          const idx = elements[0].index;
          showDailyDetail(monthlyChart.data.labels[idx]);
        }
      }
    }
  });

  const ctxDetail = document.getElementById('detailChart').getContext('2d');
  detailChart = new Chart(ctxDetail, {
    type: 'line',
    data: { labels: [], datasets: [
      { label: 'Avg Watts', data: [], borderColor: '#00b4ff', backgroundColor: gradB, fill: true, tension: 0.4 },
      { label: 'Peak Watts', data: [], borderColor: '#ffc542', borderDash: [5,5], fill: false, tension: 0.4 }
    ]},
    options: commonOpts
  });

  const ctxBat = document.getElementById('batVoltChart').getContext('2d');
  batVoltChart = new Chart(ctxBat, {
    type: 'line',
    data: { labels: [], datasets: [{ label: 'Battery V', data: [], borderColor: '#ff5252', tension: 0.2 }] },
    options: { ...commonOpts, scales: { y: { min: 20 } } }
  });

  const ctxInp = document.getElementById('inputVoltChart').getContext('2d');
  inputVoltChart = new Chart(ctxInp, {
    type: 'line',
    data: { labels: [], datasets: [{ label: 'Input V', data: [], borderColor: '#7c4dff', tension: 0.2 }] },
    options: { ...commonOpts, scales: { y: { min: 200, max: 260 } } }
  });
}

// Boot
window.onload = () => {
  initDashboard();
  setTimeout(checkUpdateQuietly, 5000);
  
  // Create SVG Gradient for Gauge
  const svgNS = "http://www.w3.org/2000/svg";
  const defs = document.createElementNS(svgNS, 'defs');
  const grad = document.createElementNS(svgNS, 'linearGradient');
  grad.setAttribute('id', 'gaugeGrad'); grad.setAttribute('x1', '0%'); grad.setAttribute('y1', '0%'); grad.setAttribute('x2', '100%'); grad.setAttribute('y2', '0%');
  const stop1 = document.createElementNS(svgNS, 'stop'); stop1.setAttribute('offset', '0%'); stop1.setAttribute('stop-color', '#00b4ff');
  const stop2 = document.createElementNS(svgNS, 'stop'); stop2.setAttribute('offset', '100%'); stop2.setAttribute('stop-color', '#00e5a0');
  grad.appendChild(stop1); grad.appendChild(stop2); defs.appendChild(grad);
  document.querySelector('.gauge-svg').prepend(defs);
};
