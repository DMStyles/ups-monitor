let hourlyChart, weekChart, monthlyChart, detailChart, batVoltChart, inputVoltChart, outageSnapshotChart;
let globalMaxWatts = 840;
let fastPollInterval = 2000;
let currentMonth = new Date().toISOString().slice(0, 7);
let currentOutageMonth = new Date().toISOString().slice(0, 7);
let allOutages = [];
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
  initCloudAuth();      // bind cloud login listener safely
  loadWeekData();
  
  // Poll every fastPollInterval (default 2s)
  setInterval(pollStatus, fastPollInterval);
  // week data refreshes every 5 mins
  setInterval(loadWeekData, 300000);
  // Poll cloud status every 30s to update the last sync time
  setInterval(loadCloudProfile, 30000);
}

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
// SETTINGS
// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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
    
    if (document.getElementById('s-gemini')) {
      document.getElementById('s-gemini').value = settings.gemini_api_key || '';
      document.getElementById('s-ollama').value = settings.ollama_model || 'llama3';
      document.getElementById('s-ai-provider').value = settings.ai_provider || 'gemini';
      if (typeof toggleAIFields === 'function') toggleAIFields();
    }
    if (document.getElementById('s-autotest')) {
      document.getElementById('s-autotest').checked = !!settings.auto_test_enabled;
    }
    
    // Set version label from API response
    if (settings.version) {
      const el = document.getElementById('s-version');
      if (el) el.innerText = settings.version;
    }

    onModelChange();
    loadCloudProfile();

    // Load data source selection
    const src = settings.data_source || 'direct';
    const radio = document.getElementById(src === 'viewpower' ? 'ds-viewpower' : 'ds-direct');
    if (radio) radio.checked = true;
    highlightDataSourceCard(src);

  } catch (err) {
    console.error("Error loading settings:", err);
  }
}



function highlightDataSourceCard(src) {
  const lblDirect    = document.getElementById('lbl-direct');
  const lblViewpower = document.getElementById('lbl-viewpower');
  if (!lblDirect || !lblViewpower) return;
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#00e5a0';
  lblDirect.style.border    = src === 'direct'    ? `2px solid ${accent}` : '2px solid transparent';
  lblViewpower.style.border = src === 'viewpower' ? `2px solid ${accent}` : '2px solid transparent';
}

document.addEventListener('DOMContentLoaded', () => {
  ['ds-direct', 'ds-viewpower'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', () => highlightDataSourceCard(el.value));
  });
});

async function saveDataSource() {
  const selected = document.querySelector('input[name="data_source"]:checked');
  if (!selected) return;
  const src = selected.value;
  const btn = document.getElementById('ds-save-btn');
  const status = document.getElementById('ds-status');
  btn.disabled = true;
  btn.innerText = 'Saving…';
  try {
    const res = await fetch('/api/settings/data_source', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({data_source: src})
    });
    const d = await res.json();
    if (d.ok) {
      status.style.color = 'var(--accent)';
      status.innerText = `✅ Switched to ${src === 'viewpower' ? 'ViewPower' : 'Direct USB'} — restarting in 3s…`;
      highlightDataSourceCard(src);
      setTimeout(() => location.reload(), 3500);
    } else {
      status.style.color = '#f87171';
      status.innerText = '❌ Failed to save';
    }
  } catch(e) {
    status.style.color = '#f87171';
    status.innerText = '❌ Error: ' + e;
  }
  btn.disabled = false;
  btn.innerText = '💾 Apply & Restart';
}

async function loadCloudProfile() {
  try {
    const res = await fetch('/api/cloud_user');
    const u = await res.json();
    const notIn    = document.getElementById('cloud-not-signed-in');
    const signedIn = document.getElementById('cloud-signed-in');
    if (!notIn || !signedIn) return;

    if (u.signed_in) {
      notIn.style.display = 'none';
      signedIn.style.display = '';
      document.getElementById('cloud-name').innerText  = u.name  || u.email;
      document.getElementById('cloud-email').innerText = u.email || '';
      const avatar = document.getElementById('cloud-avatar');
      const fallback = document.getElementById('cloud-avatar-fallback');
      const name = u.name || u.email || 'U';
      const firstLetter = name.trim().charAt(0);
      if (fallback) {
        fallback.innerText = firstLetter;
      }
      if (u.avatar_url) {
        avatar.src = u.avatar_url;
        avatar.onload = () => {
          avatar.style.display = '';
          if (fallback) fallback.style.display = 'none';
        };
        avatar.onerror = () => {
          avatar.style.display = 'none';
          if (fallback) fallback.style.display = 'flex';
        };
      } else {
        avatar.style.display = 'none';
        if (fallback) fallback.style.display = 'flex';
      }
      const lastSyncEl = document.getElementById('cloud-last-sync');
      if (lastSyncEl) {
        if (u.last_sync) {
          lastSyncEl.innerText = u.last_sync;
        } else {
          const now = new Date();
          lastSyncEl.innerText = now.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
        }
      }
    } else {
      notIn.style.display = '';
      signedIn.style.display = 'none';
    }
  } catch(e) { console.warn('loadCloudProfile error', e); }
}

async function signOutCloud() {
  if (!confirm('Sign out of Cloud Sync?')) return;
  try {
    await fetch('/api/cloud_signout', { method: 'POST' });
    // Reset header button
    const btnCloud = document.getElementById('btn-cloud-login');
    if (btnCloud) {
      btnCloud.innerHTML = '<i class="ph ph-cloud"></i> Sign in to Cloud';
      btnCloud.style.background = '';
      btnCloud.style.color = '';
      btnCloud.disabled = false;
    }
    // Reset Settings card sign-in button
    const btnGoog = document.getElementById('btn-signin-google');
    if (btnGoog) {
      btnGoog.disabled = false;
      btnGoog.innerText = 'Sign in with Google';
    }
    // Allow profile to reload on next login
    window._cloudProfileLoaded = false;
    loadCloudProfile();
  } catch(e) { console.warn('signOutCloud error', e); }
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
    document.getElementById('header-sub').innerHTML = `${model} &nbsp;&bull;&nbsp; ${spec.max_watts}W Max Output`;
  }
}

async function saveSettings() {
  // Ã¢â€â‚¬Ã¢â€â‚¬ Validate numeric fields before building payload Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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
  
  if (document.getElementById('s-gemini')) {
    payload.gemini_api_key = document.getElementById('s-gemini').value.trim();
    payload.ollama_model = document.getElementById('s-ollama').value.trim();
    payload.ai_provider = document.getElementById('s-ai-provider').value;
  }
  if (document.getElementById('s-autotest')) {
    payload.auto_test_enabled = document.getElementById('s-autotest').checked;
  }

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

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
// PREVENT SCROLL WHEEL FROM CHANGING NUMBER INPUTS
// This is the root cause of the "rate randomly drops" bug:
// hovering a number input while scrolling the page silently
// changes its value, which then gets saved on next Save click.
// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
document.querySelectorAll('input[type=number]').forEach(input => {
  input.addEventListener('wheel', e => {
    e.preventDefault();
    input.blur();
  }, { passive: false });
});

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
// DASHBOARD
// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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

    // Show / hide Hardware Controls depending on data source
    const hwSection  = document.getElementById('hardware-controls-section');
    const hwSubtitle = document.getElementById('hw-controls-subtitle');
    const isViewPower = d.data_source === 'viewpower';
    if (hwSection) {
      if (isViewPower) {
        hwSection.style.opacity = '0.45';
        hwSection.style.pointerEvents = 'none';
        if (hwSubtitle) hwSubtitle.innerText = 'Unavailable in ViewPower mode';
      } else {
        hwSection.style.opacity = '';
        hwSection.style.pointerEvents = '';
        if (hwSubtitle) hwSubtitle.innerText = 'Direct USB command link active';
      }
    }

    // Faults Banner
    const faultBanner = document.getElementById('fault-banner');
    if (faultBanner) {
      if (d.faults && d.faults.length > 0) {
        faultBanner.style.display = 'flex';
        document.getElementById('fault-banner-msg').innerText = 'UPS FAULT: ' + d.faults.join(', ');
      } else {
        faultBanner.style.display = 'none';
      }
    }

    // Auto-detected wattage badge
    const autoWattsBadge = document.getElementById('auto-watts-badge');
    if (autoWattsBadge) {
      if (d.rated_va && !isViewPower) {
        autoWattsBadge.style.display = 'inline-block';
      } else {
        autoWattsBadge.style.display = 'none';
      }
    }

    // Device Info
    const devInfoSec = document.getElementById('device-info-section');
    if (devInfoSec) {
      if ((d.serial || d.firmware) && !isViewPower) {
        devInfoSec.style.display = 'block';
        document.getElementById('device-serial').innerText = d.serial || '----';
        document.getElementById('device-firmware').innerText = d.firmware || '----';
      } else {
        devInfoSec.style.display = 'none';
      }
    }

    
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
        muteBtn.innerHTML = '\uD83D\uDD15 Mute Alarm';
        muteBtn.style.borderColor = 'rgba(255,255,255,0.1)';
        muteBtn.style.color = '#fff';
      } else {
        muteBtn.innerHTML = '\uD83D\uDD14 Unmute Alarm';
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
      
      document.getElementById('chargetime-badge').style.display = 'none';
    } else {
      document.body.classList.remove('on-battery-theme');
      document.getElementById('battery-alert').style.display = 'none';
      document.getElementById('runtime-badge').style.display = 'none';
      
      if (d.charge_time_estimate !== null && d.charge_time_estimate !== undefined) {
        document.getElementById('chargetime-badge').style.display = 'flex';
        document.getElementById('chargetime-val').innerText = d.charge_time_estimate;
      } else {
        document.getElementById('chargetime-badge').style.display = 'none';
      }
    }

    document.getElementById('today-kwh').innerText = d.daily_kwh.toFixed(3);
    document.getElementById('today-cost').innerText = 'LKR ' + d.daily_cost.toFixed(2);
    document.getElementById('today-samples').innerText = d.samples;

    // Update Cloud Synced button status dynamically
    const btnCloud = document.getElementById('btn-cloud-login');
    if (btnCloud) {
      if (d.cloud_synced) {
        btnCloud.innerHTML = '<i class="ph ph-cloud-check"></i> Cloud Synced';
        btnCloud.style.background = 'rgba(0,229,160,0.5)';
        btnCloud.style.color = '#fff';
        btnCloud.disabled = true;
        // Reset the Settings card sign-in button and show profile
        var btnGoog = document.getElementById('btn-signin-google');
        if (btnGoog && (btnGoog.innerText.includes('Waiting') || btnGoog.innerText.includes('Opening'))) {
          btnGoog.disabled = false;
          btnGoog.innerText = 'Sign in with Google';
        }
        if (typeof loadCloudProfile === 'function' && !window._cloudProfileLoaded) {
          window._cloudProfileLoaded = true;
          loadCloudProfile();
        }
      } else {
        if (!btnCloud.innerText.includes('Opening') && !btnCloud.innerText.includes('Waiting')) {
          btnCloud.innerHTML = '<i class="ph ph-cloud"></i> Sign in to Cloud';
          btnCloud.style.background = '';
          btnCloud.style.color = '';
          btnCloud.disabled = false;
        }
      }
    }
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

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
// ANALYTICS
// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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
    allOutages = oData;
    renderOutages();
    
    // Update Battery Health UI
    updateBatteryHealthUI(hData);
    
  } catch (err) {
    console.error("Analytics load error", err);
  }
  
  // Load bill estimator
  loadBillEstimate();
}

function renderOutages() {
  document.getElementById('outage-month-label').innerText = currentOutageMonth;
  const filtered = allOutages.filter(o => o.started_at.startsWith(currentOutageMonth));
  document.getElementById('outage-count').innerText = `${filtered.length} outages`;
  const tb = document.getElementById('outage-tbody');
  if (filtered.length === 0) {
    tb.innerHTML = '<tr><td colspan="7" class="no-data">No outages recorded in this month</td></tr>';
  } else {
    tb.innerHTML = filtered.map((o, i) => {
      const start = new Date(o.started_at).toLocaleString();
      const end = o.ended_at ? new Date(o.ended_at).toLocaleString() : 'Ongoing';
      const dur = o.duration_seconds ? Math.floor(o.duration_seconds/60) + 'm ' + (o.duration_seconds%60) + 's' : '- ';
      return `<tr>
        <td>${filtered.length - i}</td>
        <td>${start}</td>
        <td>${end}</td>
        <td>${dur}</td>
        <td style="color:var(--accent)">${o.battery_at_start}%</td>
        <td style="color:var(--warn)">${o.battery_at_end !== null ? o.battery_at_end+'%' : '- '}</td>
        <td>${o.ended_at ? 'Resolved' : '<span style="color:var(--warn)">Active</span>'}</td>
      </tr>`;
    }).join('');
  }
  
  // Populate the High-Res Outage Inspector dropdown
  const select = document.getElementById('outage-select');
  if (select) {
    const recent = allOutages.slice(0, 20); // Top 20 across all months
    select.innerHTML = '<option value="">Select a recent outage to view graph...</option>' + 
      recent.map(o => {
        const d = new Date(o.started_at).toLocaleString();
        const dur = o.duration_seconds ? Math.floor(o.duration_seconds/60) + 'm ' + (o.duration_seconds%60) + 's' : 'Ongoing';
        return `<option value="${o.id}">${d} (Duration: ${dur})</option>`;
      }).join('');
  }
}

function changeOutageMonth(delta) {
  const d = new Date(currentOutageMonth + '-01');
  d.setMonth(d.getMonth() + delta);
  currentOutageMonth = d.toISOString().slice(0, 7);
  renderOutages();
}

function updateBatteryHealthUI(h) {
  const pctEl = document.getElementById('bh-pct');
  const badgeEl = document.getElementById('bh-status-badge');
  const avgVEl = document.getElementById('bh-avg-v');
  const ageEl = document.getElementById('bh-age');
  const pickerEl = document.getElementById('bh-date-picker');

  if (!h || h.status === 'no_data' || h.health_pct === null) {
    pctEl.innerText = '-%';
    badgeEl.className = 'bh-status-badge bh-status-nodata';
    badgeEl.innerText = 'No Data';
    avgVEl.innerText = '-';
    ageEl.innerText = '-';
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

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
// CEB BILL ESTIMATOR
// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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
      const label = `LKR ${tier.rate.toFixed(2)} &times; ${tier.units.toFixed(2)} units`;
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
    document.getElementById('d-peak').innerText = peak > 0 ? peak : '-';
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

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
// UPDATER
// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
let updateUrl = null;
async function manualCheckUpdate() {
  const btn = document.getElementById('check-update-btn');
  const msg = document.getElementById('update-status-msg');
  btn.disabled = true;
  msg.innerText = "Checking...";
  try {
    const res = await fetch('/api/check_update');
    const data = await res.json();
    if (data.error && !data.update_available) {
      msg.innerHTML = `⚠️ ${data.error} &mdash; <a href="https://github.com/DMStyles/ups-monitor/releases/latest" target="_blank" style="color:#00b4ff;">Check manually on GitHub</a>`;
    } else if (data.update_available) {
      msg.innerHTML = `🚀 Update <strong>${data.latest_version}</strong> is available! <button onclick="performUpdateFromSettings()" class="settings-btn settings-btn-primary" style="padding:4px 10px; margin-left:10px; font-size:0.8rem;">Install Now</button>`;
      updateUrl = data.download_url;
    } else {
      msg.innerText = `✓ You are on the latest version (${data.current_version}).`;
    }
  } catch (err) {
    msg.innerHTML = `⚠️ Could not reach update server. <a href="https://github.com/DMStyles/ups-monitor/releases/latest" target="_blank" style="color:#00b4ff;">Check manually on GitHub</a>`;
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


// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// CHARTS INIT
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function initCharts() {
  const commonOpts = {
    responsive: true, maintainAspectRatio: false,
    animation: false, // Disable animations to save GPU during live data updates
    devicePixelRatio: 1, // Cap pixel ratio to save GPU rasterization cost
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

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// CLOUD SYNC (Initiated via Backend OAuth Callback)
// ─────────────────────────────────────────────────────────────────────────────
async function signInCloud() {
  const btnCloud = document.getElementById('btn-cloud-login');
  const btnSettings = document.querySelector('#cloud-not-signed-in .settings-btn-primary');
  
  try {
    if (btnCloud) {
      btnCloud.disabled = true;
      btnCloud.innerText = 'Opening browser...';
    }
    if (btnSettings) {
      btnSettings.disabled = true;
      btnSettings.innerText = 'Opening browser...';
    }

    const res = await fetch('/api/cloud/login', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      if (btnCloud) btnCloud.innerText = 'Waiting for sign-in...';
      if (btnSettings) btnSettings.innerText = 'Waiting for sign-in...';
    } else {
      if (btnCloud) {
        btnCloud.disabled = false;
        btnCloud.innerHTML = '<i class="ph ph-cloud"></i> Sign in to Cloud';
      }
      if (btnSettings) {
        btnSettings.disabled = false;
        btnSettings.innerText = 'Sign in with Google';
      }
      alert('Failed to initiate login.');
    }
  } catch (e) {
    console.warn('Cloud login error', e);
    if (btnCloud) {
      btnCloud.disabled = false;
      btnCloud.innerHTML = '<i class="ph ph-cloud"></i> Sign in to Cloud';
    }
    if (btnSettings) {
      btnSettings.disabled = false;
      btnSettings.innerText = 'Sign in with Google';
    }
  }
}

function initCloudAuth() {
  const btnCloud = document.getElementById('btn-cloud-login');
  if (btnCloud) {
    btnCloud.addEventListener('click', signInCloud);
  }
}

// ══════════════════════════════════════════════════════
//  OUTAGE INSPECTOR
// ══════════════════════════════════════════════════════
async function loadOutageSnapshot() {
  const sel = document.getElementById('outage-select');
  if (!sel || !sel.value) return;
  const oid = sel.value;
  try {
    const res = await fetch('/api/outages/' + oid + '/snapshots');
    const data = await res.json();
    if (outageSnapshotChart) {
      outageSnapshotChart.destroy();
    }
    const ctx = document.getElementById('outageSnapshotChart').getContext('2d');
    
    if (data.length === 0) {
      outageSnapshotChart = new Chart(ctx, { type: 'line', data: { labels: [], datasets: [] } });
      return;
    }
    
    const labels = data.map(d => new Date(d.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    
    outageSnapshotChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          {
            label: 'Battery %',
            data: data.map(d => d.battery_capacity),
            borderColor: '#10b981',
            backgroundColor: 'rgba(16, 185, 129, 0.1)',
            yAxisID: 'y',
            fill: true,
            tension: 0.3
          },
          {
            label: 'Load (W)',
            data: data.map(d => d.watts),
            borderColor: '#ef4444',
            backgroundColor: 'transparent',
            yAxisID: 'y1',
            tension: 0.3
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          y: { type: 'linear', display: true, position: 'left', title: { display: true, text: 'Battery %', color:'rgba(255,255,255,0.7)' }, min: 0, max: 100, ticks:{color:'rgba(255,255,255,0.7)'} },
          y1: { type: 'linear', display: true, position: 'right', title: { display: true, text: 'Watts', color:'rgba(255,255,255,0.7)' }, grid: { drawOnChartArea: false }, ticks:{color:'rgba(255,255,255,0.7)'} }
        },
        plugins: {
          legend: { labels: { color: 'rgba(255,255,255,0.7)' } }
        }
      }
    });
  } catch(e) {
    console.error("Failed to load snapshot", e);
  }
}

// ══════════════════════════════════════════════════════
//  AI ASSISTANT
// ══════════════════════════════════════════════════════
function parseMarkdown(text) {
  return text
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/\n\n/g, '<br><br>')
    .replace(/\n/g, '<br>')
    .replace(/- (.*?)<br>/g, '<li>$1</li>')
    .replace(/<li>/g, '<ul style="margin:0; padding-left:20px;"><li>')
    .replace(/<\/li>(?!<li>)/g, '</li></ul>');
}

async function sendAiMessage(promptText) {
  const input = document.getElementById('ai-input-box');
  const btn = document.getElementById('ai-send-btn');
  const log = document.getElementById('ai-chat-log');
  
  const msg = promptText || input.value.trim();
  if (!msg) return;
  
  // Add User msg
  input.value = '';
  input.disabled = true;
  btn.disabled = true;
  btn.innerText = '...';
  
  const userDiv = document.createElement('div');
  userDiv.className = 'ai-msg ai-msg-user';
  userDiv.style = 'align-self:flex-end; background: var(--primary); color:#ffffff; border-radius: 12px; border-bottom-right-radius: 2px; padding: 1rem; max-width:80%; font-weight:500;';
  userDiv.innerText = msg;
  log.appendChild(userDiv);
  log.scrollTop = log.scrollHeight;
  
  try {
    const res = await fetch('/api/ai/chat', {
      method: 'POST',
      body: JSON.stringify({ message: msg })
    });
    const data = await res.json();
    
    const aiDiv = document.createElement('div');
    aiDiv.className = 'ai-msg ai-msg-system';
    aiDiv.style = 'align-self:flex-start; background: rgba(14,165,233,0.1); border: 1px solid rgba(14,165,233,0.2); border-radius: 12px; border-bottom-left-radius: 2px; padding: 1rem; max-width:80%;';
    
    if (data.ok) {
      aiDiv.innerHTML = parseMarkdown(data.reply);
    } else {
      aiDiv.style.background = 'rgba(239,68,68,0.1)';
      aiDiv.style.borderColor = 'rgba(239,68,68,0.3)';
      aiDiv.style.color = '#fca5a5';
      aiDiv.innerText = "Error: " + (data.error || "Unknown error");
    }
    
    log.appendChild(aiDiv);
    log.scrollTop = log.scrollHeight;
    
  } catch (err) {
    console.error(err);
    const errDiv = document.createElement('div');
    errDiv.style = 'align-self:flex-start; background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.3); border-radius: 12px; border-bottom-left-radius: 2px; padding: 1rem; color:#fca5a5; max-width:80%;';
    errDiv.innerText = "Connection error. Make sure your API key is correct in Settings.";
    log.appendChild(errDiv);
  }
  
  input.disabled = false;
  btn.disabled = false;
  btn.innerText = 'Send';
  input.focus();
  log.scrollTop = log.scrollHeight;
}
