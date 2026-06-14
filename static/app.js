/**
 * UPS Power Monitor — app.js
 * Handles data fetching, gauge animation, charts, and auto-refresh
 */

'use strict';

// ── Config ─────────────────────────────────
const REFRESH_MS   = 5000;      // poll the local Flask API every 5s
const MAX_WATTS    = 720;       // Prolink 1.2kVA × 0.6 PF
const CURRENCY     = 'LKR';

// ── Chart instances ─────────────────────────
let hourlyChart = null;
let weekChart   = null;

// ── Countdown ──────────────────────────────
let countdown = 5;

// ── Gauge Arc Math ─────────────────────────
const GAUGE_CX = 110, GAUGE_CY = 130, GAUGE_R = 90;
const START_ANG = 210, END_ANG = -30;   // degrees (sweep 240°)

function degToRad(d) { return d * Math.PI / 180; }

function describeArc(cx, cy, r, startDeg, endDeg) {
  const start = degToRad(startDeg);
  const end   = degToRad(endDeg);
  const x1 = cx + r * Math.cos(start);
  const y1 = cy + r * Math.sin(start);
  const x2 = cx + r * Math.cos(end);
  const y2 = cy + r * Math.sin(end);
  const large = (endDeg - startDeg + 360) % 360 > 180 ? 1 : 0;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
}

function initGaugeDefs() {
  const svg = document.querySelector('.gauge-svg');
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  defs.innerHTML = `
    <linearGradient id="gaugeGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%"   stop-color="#00b4ff"/>
      <stop offset="100%" stop-color="#00e5a0"/>
    </linearGradient>`;
  svg.prepend(defs);
  document.getElementById('gauge-bg-arc').setAttribute('d',
    describeArc(GAUGE_CX, GAUGE_CY, GAUGE_R, START_ANG, END_ANG));
}

function updateGauge(watts) {
  const pct    = Math.min(watts / MAX_WATTS, 1);
  const endDeg = START_ANG - pct * 240;   // sweep 240° total
  document.getElementById('gauge-fill-arc').setAttribute('d',
    describeArc(GAUGE_CX, GAUGE_CY, GAUGE_R, START_ANG, endDeg));

  const el = document.getElementById('gauge-watts');
  animateNumber(el, parseFloat(el.textContent) || 0, watts, 600);

  // Colour the watts display based on load %
  if (pct < 0.5)       el.style.color = '#00e5a0';
  else if (pct < 0.75) el.style.color = '#ffc542';
  else                 el.style.color = '#ff5252';
}

// ── Smooth number animation ──────────────
function animateNumber(el, from, to, duration, decimals = 0) {
  const start = performance.now();
  function step(ts) {
    const t    = Math.min((ts - start) / duration, 1);
    const ease = 1 - Math.pow(1 - t, 3);   // ease-out cubic
    el.textContent = (from + (to - from) * ease).toFixed(decimals);
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// ── Status badge ────────────────────────
function setStatus(connected) {
  const badge = document.getElementById('status-badge');
  const text  = document.getElementById('status-text');
  badge.className = 'status-badge ' +
    (connected === null ? 'status-connecting' :
     connected ? 'status-connected' : 'status-disconnected');
  text.textContent = connected === null ? 'Connecting…' :
                     connected ? 'ViewPower Connected' : 'ViewPower Offline';
}

// ── Main data fetch & render ─────────────
async function fetchStatus() {
  try {
    const res  = await fetch('/api/status');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();

    setStatus(data.connected);

    if (data.connected) {
      // Gauge
      updateGauge(data.watts || 0);

      // Load bar
      const pct = data.load_percent || 0;
      document.getElementById('load-bar').style.width = pct + '%';
      document.getElementById('load-pct-text').textContent = pct + '%';

      // Today stats
      document.getElementById('today-kwh').textContent    = (data.daily_kwh || 0).toFixed(3);
      document.getElementById('today-cost').textContent   = `${CURRENCY} ${(data.daily_cost || 0).toFixed(2)}`;
      document.getElementById('today-samples').textContent = data.samples || 0;

      // Vitals
      document.getElementById('v-input').textContent    = fmt(data.input_voltage, 'V');
      document.getElementById('v-output').textContent   = fmt(data.output_voltage, 'V');
      document.getElementById('v-freq').textContent     = fmt(data.frequency, 'Hz');
      document.getElementById('v-mode').textContent     = data.ups_mode || '—';
      document.getElementById('v-batvolt').textContent  = fmt(data.battery_voltage, 'V');
      document.getElementById('v-batcap').textContent   = fmt(data.battery_capacity, '%', 0);

      // Battery bar
      document.getElementById('bat-bar').style.width = (data.battery_capacity || 0) + '%';

      // Rate input sync (only if not focused)
      const rateEl = document.getElementById('rate-input');
      if (document.activeElement !== rateEl && data.elec_rate) {
        rateEl.value = parseFloat(data.elec_rate).toFixed(2);
      }
    }

    // Last update
    if (data.last_update) {
      const d = new Date(data.last_update);
      document.getElementById('last-update').textContent =
        'Updated ' + d.toLocaleTimeString('en-LK');
    }
  } catch (e) {
    console.warn('Status fetch error:', e);
    setStatus(false);
  }
}

function fmt(val, unit, dec = 1) {
  if (val === undefined || val === null || val === 0) return '—';
  return `${parseFloat(val).toFixed(dec)} ${unit}`;
}

// ── Hourly chart ─────────────────────────
async function fetchHourly() {
  try {
    const res  = await fetch('/api/history');
    const data = await res.json();

    // Fill all 24 hours
    const hours  = Array.from({length: 24}, (_, i) => i);
    const values = hours.map(h => {
      const found = data.find(d => d.hour === h);
      return found ? found.avg_watts : null;
    });
    const labels = hours.map(h => h.toString().padStart(2,'0') + ':00');

    if (!hourlyChart) {
      const ctx = document.getElementById('hourlyChart').getContext('2d');
      hourlyChart = new Chart(ctx, {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: 'Avg Watts',
            data: values,
            borderColor: '#00b4ff',
            backgroundColor: 'rgba(0,180,255,0.08)',
            borderWidth: 2,
            pointRadius: 3,
            pointBackgroundColor: '#00b4ff',
            fill: true,
            tension: 0.4,
            spanGaps: true,
          }]
        },
        options: chartOptions('W')
      });
    } else {
      hourlyChart.data.datasets[0].data = values;
      hourlyChart.update('none');
    }
  } catch (e) { console.warn('Hourly chart error:', e); }
}

// ── 7-day chart ──────────────────────────
async function fetchWeekly() {
  try {
    const res  = await fetch('/api/daily');
    const data = await res.json();

    const labels = data.map(d => {
      const dt = new Date(d.date + 'T00:00:00');
      return dt.toLocaleDateString('en-LK', {weekday:'short', month:'short', day:'numeric'});
    });
    const values = data.map(d => d.kwh);

    if (!weekChart) {
      const ctx = document.getElementById('weekChart').getContext('2d');
      weekChart = new Chart(ctx, {
        type: 'bar',
        data: {
          labels,
          datasets: [{
            label: 'kWh',
            data: values,
            backgroundColor: values.map((_, i) =>
              i === values.length - 1 ? '#00e5a0' : 'rgba(0,229,160,0.3)'),
            borderColor: '#00e5a0',
            borderWidth: 1,
            borderRadius: 6,
          }]
        },
        options: chartOptions('kWh')
      });
    } else {
      weekChart.data.labels = labels;
      weekChart.data.datasets[0].data = values;
      weekChart.data.datasets[0].backgroundColor = values.map((_, i) =>
        i === values.length - 1 ? '#00e5a0' : 'rgba(0,229,160,0.3)');
      weekChart.update('none');
    }
  } catch (e) { console.warn('Weekly chart error:', e); }
}

function chartOptions(unit) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: 'rgba(10,14,26,0.95)',
        titleColor: '#7b8db0',
        bodyColor: '#e8eaf6',
        borderColor: 'rgba(255,255,255,0.1)',
        borderWidth: 1,
        callbacks: {
          label: ctx => ` ${ctx.parsed.y !== null ? ctx.parsed.y.toFixed(2) : '—'} ${unit}`
        }
      }
    },
    scales: {
      x: {
        grid:  { color: 'rgba(255,255,255,0.04)' },
        ticks: { color: '#4a5880', font: { size: 10, family: 'JetBrains Mono' }, maxRotation: 0 },
      },
      y: {
        grid:  { color: 'rgba(255,255,255,0.04)' },
        ticks: { color: '#4a5880', font: { size: 10, family: 'JetBrains Mono' },
          callback: v => v + ' ' + unit },
        beginAtZero: true,
      }
    }
  };
}

// ── Rate save ────────────────────────────
async function saveRate() {
  const val  = parseFloat(document.getElementById('rate-input').value);
  const btn  = document.getElementById('rate-save-btn');
  if (isNaN(val) || val < 0) return;
  btn.textContent = '…';
  try {
    await fetch('/api/settings', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ elec_rate: val })
    });
    btn.textContent = '✓ Saved';
    setTimeout(() => btn.textContent = 'Save', 2000);
  } catch {
    btn.textContent = 'Error';
  }
}

// ── Countdown ticker ─────────────────────
function tickCountdown() {
  countdown--;
  const el = document.getElementById('countdown');
  if (el) el.textContent = countdown <= 0 ? 5 : countdown;
  if (countdown <= 0) countdown = 5;
}

// ── Auto-Updater ────────────────────────────
let updateDetails = null;

async function checkUpdate() {
  try {
    const res = await fetch('/api/check_update');
    if (!res.ok) return;
    const data = await res.json();
    if (data.update_available) {
      updateDetails = data;
      const banner = document.getElementById('update-banner');
      const versionEl = document.getElementById('update-version');
      if (banner && versionEl) {
        versionEl.textContent = data.latest_version;
        banner.style.display = 'flex';
      }
    }
  } catch (err) {
    console.error('Error checking for updates:', err);
  }
}

async function performUpdate() {
  if (!updateDetails || !updateDetails.zipball_url) return;
  
  const btn = document.getElementById('update-action-btn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Updating…';
  }
  
  try {
    const res = await fetch('/api/perform_update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ zipball_url: updateDetails.zipball_url })
    });
    
    if (res.ok) {
      const banner = document.getElementById('update-banner');
      if (banner) {
        banner.innerHTML = `
          <div class="update-banner-content" style="width: 100%; justify-content: center; padding: 4px 0;">
            <span class="update-icon">⚡</span>
            <span class="update-message" style="margin-left: 8px;">Installing update… The app will restart automatically in a few seconds.</span>
          </div>
        `;
      }
    } else {
      alert('Failed to start update.');
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Update Now';
      }
    }
  } catch (err) {
    console.error('Error performing update:', err);
    alert('An error occurred during update.');
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Update Now';
    }
  }
}

function closeUpdateBanner() {
  const banner = document.getElementById('update-banner');
  if (banner) banner.style.display = 'none';
}

// ── Init & refresh loop ──────────────────
async function refresh() {
  await fetchStatus();
}

async function refreshCharts() {
  await fetchHourly();
  await fetchWeekly();
}

window.addEventListener('DOMContentLoaded', async () => {
  initGaugeDefs();
  setStatus(null);

  // Initial load
  await refresh();
  await refreshCharts();
  
  // Check for updates on startup
  checkUpdate();

  // Status refresh every 5s
  setInterval(async () => {
    tickCountdown();
    await refresh();
  }, REFRESH_MS);

  // Charts refresh every 60s
  setInterval(refreshCharts, 60_000);
  setInterval(tickCountdown, 1000);
});

// Expose for inline onclick
window.saveRate = saveRate;
window.performUpdate = performUpdate;
window.closeUpdateBanner = closeUpdateBanner;
