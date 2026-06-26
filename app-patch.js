    
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
