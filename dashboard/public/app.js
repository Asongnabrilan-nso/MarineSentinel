/**
 * MarineSentinel Dashboard — app.js
 *
 * Replace the firebaseConfig object below with YOUR project's config.
 * Firebase Console → Project Settings → Your apps → Firebase SDK snippet → Config
 */

// ── Firebase configuration ────────────────────────────────────────────────────
const firebaseConfig = {
  apiKey:            'YOUR_API_KEY',
  authDomain:        'YOUR_PROJECT_ID.firebaseapp.com',
  databaseURL:       'https://YOUR_PROJECT_ID-default-rtdb.firebaseio.com',
  projectId:         'YOUR_PROJECT_ID',
  storageBucket:     'YOUR_PROJECT_ID.appspot.com',
  messagingSenderId: 'YOUR_SENDER_ID',
  appId:             'YOUR_APP_ID',
};

firebase.initializeApp(firebaseConfig);
const db = firebase.database();

// ── Alert thresholds (local copy — kept in sync with /config/thresholds) ──────
const thresholds = {
  ph_min: 6.5, ph_max: 9.5,
  turbidity_max: 300,
  wtemp_max: 30.0,
  tds_max: 500.0,
};

// ── Utility helpers ───────────────────────────────────────────────────────────

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = (value !== null && value !== undefined) ? value : '—';
}

function tileAlert(id, isAlert) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.toggle('tile-alert', isAlert);
  el.classList.toggle('tile-ok',    !isAlert);
}

function formatTime(isoStr) {
  if (!isoStr) return '—';
  try { return new Date(isoStr).toLocaleTimeString(); } catch { return isoStr; }
}

function formatLabel(label) {
  if (!label) return '—';
  return label.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ── Device status ─────────────────────────────────────────────────────────────
db.ref('/device/status').on('value', snap => {
  const data  = snap.val() || {};
  const pill  = document.getElementById('statusPill');
  const since = document.getElementById('lastSeen');

  if (data.online) {
    pill.textContent = 'Online';
    pill.className   = 'status-pill online';
  } else {
    pill.textContent = 'Offline';
    pill.className   = 'status-pill offline';
  }
  if (data.updated_at) {
    since.textContent = `Last seen: ${formatTime(data.updated_at)}`;
  }
});

// ── AI Detection ──────────────────────────────────────────────────────────────
db.ref('/device/detection').on('value', snap => {
  const d = snap.val() || {};
  setText('detectionLabel', formatLabel(d.label));
  setText('detectionConf',  d.confidence != null ? `${d.confidence}%` : '—');
  setText('detectionTime',  formatTime(d.timestamp));

  const hasGPS = d.lat != null && d.lon != null;
  setText('gpsCoords', hasGPS ? `${d.lat.toFixed(5)}°, ${d.lon.toFixed(5)}°` : 'No GPS fix');

  const gpsBadge = document.getElementById('gpsStatus');
  if (gpsBadge) {
    gpsBadge.textContent = hasGPS ? 'Fix' : 'No fix';
    gpsBadge.className   = `badge ${hasGPS ? 'badge-ok' : 'badge-warn'}`;
  }

  const labelEl = document.getElementById('detectionLabel');
  if (labelEl) {
    labelEl.className = 'detection-label';
    if (d.label && d.label !== 'ocean') labelEl.classList.add('debris-detected');
  }
});

// ── Live sensor readings ──────────────────────────────────────────────────────
db.ref('/device/sensors').on('value', snap => {
  const s = snap.val() || {};

  setText('val-ph',    s.ph    != null ? s.ph.toFixed(2)           : '—');
  setText('val-turb',  s.turb  != null ? s.turb                     : '—');
  setText('val-wtemp', s.wtemp != null ? `${s.wtemp.toFixed(1)}°C` : '—');
  setText('val-tds',   s.tds   != null ? `${Math.round(s.tds)} ppm`: '—');

  const t = thresholds;
  tileAlert('tile-ph',    s.ph    < t.ph_min  || s.ph > t.ph_max);
  tileAlert('tile-turb',  s.turb  > t.turbidity_max);
  tileAlert('tile-wtemp', s.wtemp > t.wtemp_max && s.wtemp > -100);
  tileAlert('tile-tds',   s.tds   > t.tds_max);

  const bridgeEl = document.getElementById('bridgeStatus');
  if (bridgeEl) {
    bridgeEl.textContent = Object.keys(s).length > 1 ? 'Active' : 'Waiting';
    bridgeEl.className   = `badge ${Object.keys(s).length > 1 ? 'badge-ok' : 'badge-warn'}`;
  }
});

// ── Camera snapshot ───────────────────────────────────────────────────────────
db.ref('/device/camera/snapshot').on('value', snap => {
  const data        = snap.val();
  const img         = document.getElementById('cameraSnapshot');
  const placeholder = document.getElementById('snapshotPlaceholder');
  const meta        = document.getElementById('snapshotMeta');
  const badge       = document.getElementById('cameraStatus');

  if (!data || !data.img || !img) return;

  img.src           = data.img;
  img.style.display = 'block';
  if (placeholder) placeholder.style.display = 'none';
  if (meta)        meta.textContent = `Last updated: ${formatTime(data.updated_at)}`;
  if (badge) {
    badge.textContent = 'Live';
    badge.className   = 'badge badge-ok';
  }
});

// ── Latest alert banner ───────────────────────────────────────────────────────
db.ref('/device/alerts/latest').on('value', snap => {
  const a = snap.val();
  const banner = document.getElementById('alertBanner');
  if (!a || !banner) return;

  document.getElementById('alertType').textContent    = a.type;
  document.getElementById('alertMessage').textContent = a.message;
  banner.classList.remove('hidden');

  clearTimeout(banner._hideTimer);
  banner._hideTimer = setTimeout(() => banner.classList.add('hidden'), 12000);
});

// ── Recent alerts list ────────────────────────────────────────────────────────
db.ref('/history/alerts').limitToLast(10).on('value', snap => {
  const list = document.getElementById('alertList');
  if (!list) return;
  list.innerHTML = '';

  const data = snap.val();
  if (!data) {
    list.innerHTML = '<li class="empty">No alerts recorded yet.</li>';
    return;
  }

  Object.values(data).reverse().forEach(a => {
    const li = document.createElement('li');
    const typeClass = a.type?.toLowerCase() === 'debris' ? 'badge-blue' : 'badge-warn';
    li.innerHTML = `
      <span class="badge ${typeClass}">${a.type || 'ALERT'}</span>
      <span class="alert-msg-text">${a.message || ''}</span>
      <span class="alert-ts">${formatTime(a.timestamp)}</span>
    `;
    list.appendChild(li);
  });
});

// ── Remote threshold control ──────────────────────────────────────────────────
db.ref('/config/thresholds').once('value').then(snap => {
  const cfg = snap.val() || {};
  const map = {
    'p-ph-min':    'ph_min',
    'p-ph-max':    'ph_max',
    'p-turb-max':  'turbidity_max',
    'p-wtemp-max': 'wtemp_max',
    'p-tds-max':   'tds_max',
  };
  for (const [inputId, key] of Object.entries(map)) {
    const el = document.getElementById(inputId);
    if (el && cfg[key] != null) el.value = cfg[key];
  }
});

document.getElementById('saveParams')?.addEventListener('click', () => {
  const params = {
    ph_min:        parseFloat(document.getElementById('p-ph-min').value),
    ph_max:        parseFloat(document.getElementById('p-ph-max').value),
    turbidity_max: parseFloat(document.getElementById('p-turb-max').value),
    wtemp_max:     parseFloat(document.getElementById('p-wtemp-max').value),
    tds_max:       parseFloat(document.getElementById('p-tds-max').value),
  };

  Object.assign(thresholds, params);

  db.ref('/config/thresholds').set(params).then(() => {
    const status = document.getElementById('saveStatus');
    if (status) {
      status.textContent = '✓ Saved — device will apply on next sync';
      setTimeout(() => { status.textContent = ''; }, 4000);
    }
  }).catch(err => {
    console.error('Firebase write failed:', err);
  });
});
