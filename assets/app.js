// MarineSentinel — In-app web UI (socket.io client)
// This page is served locally by the WebUI brick on the UNO Q MPU.
// Real-time data arrives via socket.io events emitted from python/main.py.
// Camera frames are streamed directly from the AI runner on port 4912.

// ── Main WebUI socket (port 7000 — sensor data, detections, alerts) ───────────
const socket = io(`http://${window.location.host}`);

// ── Camera socket (port 4912 — JPEG frames from the AI runner) ────────────────
(function initCamera() {
  const img         = document.getElementById("cameraFeed");
  const placeholder = document.getElementById("cameraPlaceholder");
  const statusEl    = document.getElementById("cameraStatus");

  const camSocket = io(`http://${window.location.hostname}:4912`, {
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionDelay: 3000,
  });

  camSocket.on("connect", () => {
    if (statusEl) statusEl.textContent = "Camera connected — waiting for frames…";
  });

  camSocket.on("disconnect", () => {
    img.style.display         = "none";
    placeholder.style.display = "flex";
    if (statusEl) statusEl.textContent = "Camera disconnected. Reconnecting…";
  });

  camSocket.on("image", (data) => {
    const src = (data && data.img) ? data.img : data;
    if (!src) return;
    img.src = src;
    if (img.style.display === "none") {
      placeholder.style.display = "none";
      img.style.display         = "block";
    }
  });
})();

// ── Thresholds for tile colouring (mirrors python/main.py defaults) ───────────
const T = {
  ph_min: 6.5, ph_max: 9.5,
  turbidity_max: 300,
  wtemp_max: 30.0,
  tds_max: 500.0,
};

const MAX_ALERTS = 8;
let alertHistory = [];

// ── Utility helpers ───────────────────────────────────────────────────────────
function set(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text != null ? text : "—";
}

function tileState(id, isAlert) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.toggle("tile-alert", isAlert);
  el.classList.toggle("tile-ok",    !isAlert);
}

function fmt(val, dp = 1) {
  return val != null ? Number(val).toFixed(dp) : "—";
}

function fmtTime(iso) {
  try { return new Date(iso).toLocaleTimeString(); } catch { return iso || "—"; }
}

// ── Connection status dot ─────────────────────────────────────────────────────
socket.on("connect",    () => document.getElementById("statusDot").className = "status-dot online");
socket.on("disconnect", () => document.getElementById("statusDot").className = "status-dot offline");

// ── Sensor data from MCU (via python/main.py → ui.send_message) ───────────────
socket.on("sensor_data", (data) => {
  set("val-ph",    fmt(data.ph,    2));
  set("val-turb",  data.turb  ?? "—");
  set("val-wtemp", fmt(data.wtemp, 1));
  set("val-tds",   data.tds != null ? Math.round(data.tds) : "—");

  tileState("tile-ph",    data.ph    < T.ph_min || data.ph > T.ph_max);
  tileState("tile-turb",  data.turb  > T.turbidity_max);
  tileState("tile-wtemp", data.wtemp > T.wtemp_max && data.wtemp > -100);
  tileState("tile-tds",   data.tds   > T.tds_max);
});

// ── AI detection result ───────────────────────────────────────────────────────
socket.on("detection", (data) => {
  const label = (data.label || "—").replace(/_/g, " ").toUpperCase();
  const conf  = data.confidence != null ? `${data.confidence}%` : "—";

  set("detLabel", label);
  set("detConf",  conf);
  set("detTime",  fmtTime(data.timestamp));
  set("detGPS",
    data.lat && data.lon
      ? `GPS: ${data.lat.toFixed(5)}°, ${data.lon.toFixed(5)}°`
      : "GPS: no fix"
  );

  const labelEl = document.getElementById("detLabel");
  if (labelEl) {
    labelEl.classList.toggle("label-debris", label !== "OCEAN" && label !== "—");
    labelEl.classList.toggle("label-clean",  label === "OCEAN");
  }
});

// ── Alert banner and history ──────────────────────────────────────────────────
socket.on("alert", (data) => {
  const bar  = document.getElementById("alertBar");
  const type = data.type || "ALERT";
  const msg  = data.message || "";
  const loc  = data.location || null;

  document.getElementById("alertType").textContent = type;
  document.getElementById("alertMsg").textContent  = msg;

  const gpsEl = document.getElementById("alertGPS");
  if (gpsEl) {
    const hasGPS = type === "DEBRIS" && loc && loc.lat != null;
    if (hasGPS) {
      gpsEl.textContent = `\u{1F4CD} ${loc.lat.toFixed(5)}°, ${loc.lon.toFixed(5)}°`;
      gpsEl.classList.remove("hidden");
    } else {
      gpsEl.classList.add("hidden");
    }
  }

  bar.classList.remove("hidden");
  clearTimeout(bar._timer);
  bar._timer = setTimeout(() => bar.classList.add("hidden"), 10000);

  alertHistory.unshift({ type, msg, loc, time: data.timestamp });
  if (alertHistory.length > MAX_ALERTS) alertHistory.pop();
  renderAlerts();
});

function renderAlerts() {
  const list = document.getElementById("alertList");
  if (!list) return;
  if (alertHistory.length === 0) {
    list.innerHTML = '<li class="empty-state">No alerts yet.</li>';
    return;
  }
  list.innerHTML = alertHistory.map(a => {
    const gpsStr = (a.type === "DEBRIS" && a.loc && a.loc.lat != null)
      ? `<span class="alert-gps">\u{1F4CD} ${a.loc.lat.toFixed(5)}°, ${a.loc.lon.toFixed(5)}°</span>`
      : "";
    return `
    <li>
      <span class="badge badge-${a.type.toLowerCase()}">${a.type}</span>
      <span class="alert-text">${a.msg}</span>
      ${gpsStr}
      <span class="alert-time">${fmtTime(a.time)}</span>
    </li>`;
  }).join("");
}
