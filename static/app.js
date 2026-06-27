let hourlyChart, weekChart, monthlyChart, detailChart, batVoltChart, inputVoltChart;
let globalMaxWatts = 840;
let fastPollInterval = 2000;
let currentMonth = new Date().toISOString().slice(0, 7);
let currentBillMonth = new Date().toISOString().slice(0, 7);

// Chart.js global config
Chart.defaults.color = '#7b8db0';
Chart.defaults.font.family = "'Inter', sans-serif";

function switchTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.remove('active'));
  
  document.getElementById(`tab-btn-${tabId}`).classList.add('active');
  const activePanel = document.getElementById(`tab-${tabId}`);
  activePanel.classList.add('active');

  // Force browser reflow to restart CSS fade-in animation on every switch
  activePanel.style.animation = 'none';
  void activePanel.offsetHeight;
  activePanel.style.animation = '';

  if (tabId === 'analytics') {
    loadAnalytics();
  }
}

async function initDashboard() {
  initCharts();
  await loadSettings(); // loads models, specs, and settings
  pollStatus();         // one immediate fetch on load
  loadWeekData();
  
  // Poll every fastPollInterval (default 2s)
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
    document.getElementById('s-low-bat').value = settings.low_battery_threshold || 20;
    
    document.getElementById('s-auto-shutdown').checked = !!settings.auto_shutdown_enabled;
    document.getElementById('s-auto-shutdown-action').value = settings.auto_shutdown_action || 'shutdown';
    document.getElementById('s-shutdown-pct').value = settings.auto_shutdown_pct || 10;
    document.getElementById('s-shutdown-mins').value = settings.auto_shutdown_mins || 5;
    
    document.getElementById('s-billing-days').value = settings.billing_days || 30;
    
    document.getElementById('s-fast-poll').value = settings.fast_poll_interval || 2;
    document.getElementById('s-fast-poll-val').innerText = (settings.fast_poll_interval || 2) + 's';
    fastPollInterval = (settings.fast_poll_interval || 2) * 1000;
    document.getElementById('live-interval').innerText = settings.fast_poll_interval || 2;
    
    document.getElementById('s-db-write').value = settings.db_write_interval || 60;
    document.getElementById('s-db-write-val').innerText = (settings.db_write_interval || 60) + 's';
    
    document.getElementById('s-notifications').checked = settings.notifications_enabled !== false;
    document.getElementById('s-ntfy').value = settings.ntfy_topic || '';
    document.getElementById('s-autostart').checked = !!settings.autostart;
    document.getElementById('s-battery-replaced').value = settings.battery_replaced_date || '';
    
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
  // ── Validate numeric fields before building payload ──────
  const lowBatRaw = parseInt(document.getElementById('s-low-bat').value);
  const sdPctRaw  = parseInt(document.getElementById('s-shutdown-pct').value);
  const sdMinsRaw = parseInt(document.getElementById('s-shutdown-mins').value);
  const bdaysRaw  = parseInt(document.getElementById('s-billing-days').value);

  const errors = [];
  if (isNaN(lowBatRaw) || lowBatRaw < 5 || lowBatRaw > 50)  errors.push('Low Battery Threshold must be between 5 and 50%.');
  if (isNaN(sdPctRaw)  || sdPctRaw < 5 || sdPctRaw > 99)    errors.push('Shutdown battery % must be between 5 and 99.');
  if (isNaN(sdMinsRaw) || sdMinsRaw < 0)          errors.push('Shutdown time (minutes) must be 0 or more.');

  if (errors.length > 0) {
    const status = document.getElementById('save-status');
    status.innerText = '\u26a0\ufe0f ' + errors[0];
    status.style.color = 'var(--danger)';
    status.classList.add('show');
    setTimeout(() => { status.classList.remove('show'); status.style.color = ''; }, 4000);
    return;
  }

  const payload = {
    ups_model:             document.getElementById('s-model').value,
    low_battery_threshold: lowBatRaw,
    auto_shutdown_enabled: document.getElementById('s-auto-shutdown').checked,
    auto_shutdown_action:  document.getElementById('s-auto-shutdown-action').value,
    auto_shutdown_pct:     sdPctRaw,
    auto_shutdown_mins:    sdMinsRaw,
    billing_days:          isNaN(bdaysRaw) ? 30 : Math.max(28, Math.min(35, bdaysRaw)),
    fast_poll_interval:    parseInt(document.getElementById('s-fast-poll').value),
    db_write_interval:     parseInt(document.getElementById('s-db-write').value),
    notifications_enabled: document.getElementById('s-notifications').checked,
    ntfy_topic:            document.getElementById('s-ntfy').value.trim(),
    autostart:             document.getElementById('s-autostart').checked,
    battery_replaced_date: document.getElementById('s-battery-replaced').value,
  };

  try {
    await fetch('/api/settings', { method: 'POST', body: JSON.stringify(payload) });
    const status = document.getElementById('save-status');
    status.innerText = '\u2705 Saved successfully!';
    status.style.color = '';
    status.classList.add('show');
    setTimeout(() => status.classList.remove('show'), 2500);

    fastPollInterval = payload.fast_poll_interval * 1000;
    document.getElementById('live-interval').innerText = payload.fast_poll_interval;
    loadWeekData(); // re-calc costs

  } catch (err) {
    alert('Failed to save settings. Please try again.');
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
// PREVENT SCROLL WHEEL FROM CHANGING NUMBER INPUTS
// This is the root cause of the "rate randomly drops" bug:
// hovering a number input while scrolling the page silently
// changes its value, which then gets saved on next Save click.
// ─────────────────────────────────────────────────────────
document.querySelectorAll('input[type=number]').forEach(input => {
  input.addEventListener('wheel', e => {
    e.preventDefault();
    input.blur();
  }, { passive: false });
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
const arcD = `M ${CX - R} ${CY} A ${R} ${R} 0 0 1 ${CX + R} ${CY}`;
document.getElementById('gauge-bg-arc').setAttribute('d', arcD);
document.getElementById('gauge-fill-arc').setAttribute('d', arcD);

function applyStatus(d) {
    if (d.version) {
      document.getElementById('s-version').innerText = d.version;
      document.getElementById('app-version-footer').innerText = d.version;
    }
    
    if (!d.connected) {
      document.getElementById('status-badge').className = 'status-badge status-disconnected';
      document.getElementById('status-text').innerText = 'Disconnected';
      document.getElementById('last-update').innerText = d.last_update ? 'Last seen ' + d.last_update.substring(11,19) : 'Waiting for UPS...';
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
    
    // Update Beeper UI
    const muteBtn = document.getElementById('mute-btn');
    if (muteBtn && typeof d.beeper_on !== 'undefined') {
      if (d.beeper_on) {
        muteBtn.innerHTML = '🔕 Mute Alarm';
        muteBtn.style.borderColor = 'rgba(255,255,255,0.1)';
        muteBtn.style.color = '#fff';
      } else {
        muteBtn.innerHTML = '🔔 Unmute Alarm';
        muteBtn.style.borderColor = 'var(--accent2)';
        muteBtn.style.color = 'var(--accent2)';
      }
    }
    
    document.getElementById('v-input').innerText = d.input_voltage.toFixed(1) + ' V';
    document.getElementById('v-output').innerText = d.output_voltage.toFixed(1) + ' V';
    document.getElementById('v-freq').innerText = d.frequency.toFixed(1) + ' Hz';
    document.getElementById('v-mode').innerText = d.ups_mode;
    document.getElementById('v-batvolt').innerText = d.battery_voltage.toFixed(1) + ' V';
    
    // Show temperature only if the model has a sensor AND reading is valid (non-null, non-zero)
    const tempSupported = d.temperature_supported !== false;
    const tempValid     = d.temperature !== null && d.temperature !== 0;
    const batcapItem    = document.getElementById('v-batcap-item');
    if (tempSupported && tempValid) {
      document.getElementById('v-temp-item').style.display = 'flex';
      document.getElementById('v-temp').innerText = d.temperature.toFixed(1) + ' \u00b0C';
      if (batcapItem) batcapItem.classList.add('battery-full');
    } else {
      document.getElementById('v-temp-item').style.display = 'none';
      if (batcapItem) batcapItem.classList.remove('battery-full');
    }
    
    // Battery alert & runtime
    if (d.on_battery || d.ups_mode === 'Self-Test') {
      document.body.classList.add('on-battery-theme');
      
      if (d.ups_mode === 'Self-Test') {
          document.getElementById('battery-alert').style.display = 'none'; // Don't show outage text
      } else {
          document.getElementById('battery-alert').style.display = 'flex';
      }
      
      if (d.runtime_estimate !== null) {
        document.getElementById('runtime-badge').style.display = 'flex';
        document.getElementById('runtime-val').innerText = d.runtime_estimate;
      } else {
        document.getElementById('runtime-badge').style.display = 'none';
      }
    } else {
      document.body.classList.remove('on-battery-theme');
      document.getElementById('battery-alert').style.display = 'none';
      document.getElementById('runtime-badge').style.display = 'none';
    }

    document.getElementById('today-kwh').innerText = d.daily_kwh.toFixed(3);
    document.getElementById('today-cost').innerText = 'LKR ' + d.daily_cost.toFixed(2);
    document.getElementById('today-samples').innerText = d.samples;
}

async function pollStatus() {
  try {
    const res = await fetch('/api/status');
    const d = await res.json();
    applyStatus(d);
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
    const [monthRes, trendRes, outageRes, healthRes] = await Promise.all([
      fetch(`/api/monthly?month=${currentMonth}`),
      fetch('/api/trends?days=30'),
      fetch('/api/outages'),
      fetch('/api/battery_health')
    ]);
    const mData = await monthRes.json();
    const tData = await trendRes.json();
    const oData = await outageRes.json();
    const hData = await healthRes.json();
    
    // Monthly stats
    const dailyData = mData.daily;
    const tKwh = dailyData.reduce((s, d) => s + d.kwh, 0);
    const tCost = mData.ceb_accumulated;
    document.getElementById('m-total-kwh').innerText = tKwh.toFixed(2);
    document.getElementById('m-total-cost').innerText = tCost.toFixed(2);
    document.getElementById('m-days').innerText = dailyData.filter(d => d.samples > 0).length;
    document.getElementById('m-avg-daily').innerText = (tKwh / (dailyData.filter(d => d.samples > 0).length || 1)).toFixed(2);
    
    monthlyChart.data.labels = dailyData.map(d => d.date.substring(5)); // MM-DD
    monthlyChart.data.datasets[0].data = dailyData.map(d => d.kwh);
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
    
    // Update Battery Health UI
    updateBatteryHealthUI(hData);
    
  } catch (err) {
    console.error("Analytics load error", err);
  }
  
  // Load bill estimator
  loadBillEstimate();
}

function updateBatteryHealthUI(h) {
  const pctEl = document.getElementById('bh-pct');
  const badgeEl = document.getElementById('bh-status-badge');
  const avgVEl = document.getElementById('bh-avg-v');
  const ageEl = document.getElementById('bh-age');
  const pickerEl = document.getElementById('bh-date-picker');

  if (!h || h.status === 'no_data' || h.health_pct === null) {
    pctEl.innerText = '—%';
    badgeEl.className = 'bh-status-badge bh-status-nodata';
    badgeEl.innerText = 'No Data';
    avgVEl.innerText = '—';
    ageEl.innerText = '—';
    if (pickerEl) pickerEl.value = h ? h.replaced_date : '';
    return;
  }

  pctEl.innerText = h.health_pct.toFixed(1) + '%';
  avgVEl.innerText = h.current_avg_v.toFixed(1) + ' V';
  
  if (h.battery_age_days !== null) {
    ageEl.innerText = h.battery_age_days + ' days';
  } else {
    ageEl.innerText = 'Unknown age';
  }

  badgeEl.className = 'bh-status-badge bh-status-' + h.status;
  badgeEl.innerText = h.status.toUpperCase();

  if (pickerEl) {
    pickerEl.value = h.replaced_date || '';
  }
}

async function saveBatteryReplacedDate() {
  const picker = document.getElementById('bh-date-picker');
  const btn = document.getElementById('bh-save-btn');
  const dateVal = picker.value;

  btn.disabled = true;
  btn.innerText = 'Saving...';

  try {
    const res = await fetch('/api/battery_health/set_replaced', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ replaced_date: dateVal })
    });
    const data = await res.json();
    if (data.ok) {
      // Reload analytics to recalculate age & health
      loadAnalytics();
      // Also sync settings page input if it exists
      const sInput = document.getElementById('s-battery-replaced');
      if (sInput) sInput.value = dateVal;
    } else {
      alert('Error: ' + data.error);
    }
  } catch (err) {
    console.error('Failed to save replacement date:', err);
    alert('Failed to save date.');
  } finally {
    btn.disabled = false;
    btn.innerText = 'Save';
  }
}

function changeMonth(delta) {
  const d = new Date(currentMonth + "-01");
  d.setMonth(d.getMonth() + delta);
  currentMonth = d.toISOString().slice(0, 7);
  loadAnalytics();
}

// ───────────────────────────────────────────────────────────
// CEB BILL ESTIMATOR
// ───────────────────────────────────────────────────────────
async function loadBillEstimate() {
  const billDays = parseInt(document.getElementById('s-billing-days')?.value) || 30;
  document.getElementById('bill-month-label').innerText = currentBillMonth;
  try {
    const res = await fetch(`/api/bill_estimate?month=${currentBillMonth}&days=${billDays}`);
    const data = await res.json();
    const bill = data.monthly_bill;
    const daily = data.daily_cost;

    // Summary cards
    document.getElementById('bill-proj-kwh').innerText = data.projected_kwh.toFixed(2) + ' kWh';
    
    // Daily cost = total monthly projected bill divided by bill cycle days
    const dailyTotal = bill.total / billDays;
    document.getElementById('bill-daily-cost').innerText = 'LKR ' + dailyTotal.toFixed(2);
    document.getElementById('bill-total').innerText = 'LKR ' + bill.total.toLocaleString('en-LK', {minimumFractionDigits: 2});

    // Tier breakdown rows
    const tierContainer = document.getElementById('bill-tier-rows');
    tierContainer.innerHTML = bill.breakdown.map(tier => {
      const label = `LKR ${tier.rate.toFixed(2)} × ${tier.units.toFixed(2)} units`;
      return `
        <div class="bill-tier-row">
          <span class="bill-tier-label">${label}</span>
          <span class="bill-tier-charge">= LKR ${tier.charge.toLocaleString('en-LK', {minimumFractionDigits: 2})}</span>
        </div>`;
    }).join('');

    document.getElementById('bill-energy-total').innerText = 'LKR ' + bill.energy_charge.toLocaleString('en-LK', {minimumFractionDigits: 2});
    document.getElementById('bill-fixed').innerText = 'LKR ' + bill.fixed_charge.toLocaleString('en-LK', {minimumFractionDigits: 2});
    document.getElementById('bill-sscl').innerText = 'LKR ' + bill.sscl_tax.toLocaleString('en-LK', {minimumFractionDigits: 2});
    document.getElementById('bill-grand-total').innerText = 'LKR ' + bill.total.toLocaleString('en-LK', {minimumFractionDigits: 2});
  } catch (e) {
    console.error('Bill estimate error:', e);
  }
}

function changeBillMonth(delta) {
  const d = new Date(currentBillMonth + '-01');
  d.setMonth(d.getMonth() + delta);
  currentBillMonth = d.toISOString().slice(0, 7);
  loadBillEstimate();
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
function sendUpsAction(action) {
  fetch('/api/ups/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: action })
  })
  .then(res => res.json())
  .then(data => {
    const toast = document.getElementById('toast');
    const toastMsg = document.getElementById('toast-msg');
    toast.className = 'toast show ' + (data.status === 'ok' ? 'success' : 'error');
    toastMsg.innerText = data.message;
    setTimeout(() => { toast.classList.remove('show'); }, 3000);
  })
  .catch(err => console.error('UPS Action error:', err));
}
