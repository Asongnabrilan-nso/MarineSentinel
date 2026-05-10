# MarineSentinel — MPU Main Controller
# Runs on: Arduino UNO Q — MPU block (Linux / Python)
# Environment: Arduino App Lab

import sys
import subprocess

def _ensure(pip_name, import_name):
    try:
        __import__(import_name)
    except ImportError:
        print(f"[Setup] Installing {pip_name}...")
        subprocess.run([sys.executable, "-m", "pip", "install", "--quiet", pip_name], check=False)

_ensure("pynmea2",        "pynmea2")
_ensure("firebase-admin", "firebase_admin")

from arduino.app_utils import App, Bridge
from arduino.app_bricks.video_objectdetection import VideoObjectDetection
from arduino.app_bricks.web_ui import WebUI

import base64
import io as _io
import json
import os
import threading
import time

try:
    import pynmea2
    _PYNMEA2_OK = True
except ImportError:
    print("[WARN] pynmea2 not installed — GPS parsing disabled")
    _PYNMEA2_OK = False

try:
    import firebase_admin
    from firebase_admin import credentials, db
    _FIREBASE_SDK_OK = True
except ImportError:
    print("[WARN] firebase-admin not installed — Firebase disabled")
    _FIREBASE_SDK_OK = False

try:
    from PIL import Image
    _PIL_OK = True
except ImportError:
    _PIL_OK = False

try:
    import socketio as _sio_module
    _SIO_OK = True
except ImportError:
    print("[WARN] python-socketio not available — camera socket disabled")
    _SIO_OK = False

# ── Firebase configuration ─────────────────────────────────────────────────────
FIREBASE_KEY  = "/app/python/config/serviceAccountKey.json"
DATABASE_URL  = "https://marinesentinel-control-default-rtdb.firebaseio.com"

# ── Alert thresholds ───────────────────────────────────────────────────────────
thresholds = {
    "ph_min":        6.5,
    "ph_max":        9.5,
    "turbidity_max": 300,
    "wtemp_max":     30.0,
    "tds_max":       500.0,
}

CONFIDENCE_THRESHOLD = 0.70
THRESHOLD_SYNC_S     = 60
SENSOR_POLL_S        = 5.0
CAMERA_SNAPSHOT_S    = 30   # seconds between Firebase camera snapshots

# Camera runner is the ei-video-obj-detection-runner service on port 4912.
# HOST_IP is set in the container environment by Arduino App Lab.
_CAMERA_HOST = os.environ.get("HOST_IP", "ei-video-obj-detection-runner")
_CAMERA_URL  = f"http://{_CAMERA_HOST}:4912"

# ── Initialise Firebase ────────────────────────────────────────────────────────
_FIREBASE_OK = False
if _FIREBASE_SDK_OK:
    try:
        cred = credentials.Certificate(FIREBASE_KEY)
        firebase_admin.initialize_app(cred, {"databaseURL": DATABASE_URL})
        _FIREBASE_OK = True
        print("[Firebase] Admin SDK initialised.")
    except Exception as e:
        print(f"[Firebase] Init failed: {e}")
else:
    print("[Firebase] SDK not available — running without Firebase.")

def firebase_push(path: str, data: dict):
    if not _FIREBASE_OK:
        return
    try:
        db.reference(path).set(data)
    except Exception as e:
        print(f"[Firebase] Write to {path} failed: {e}")

def firebase_append(path: str, data: dict):
    if not _FIREBASE_OK:
        return
    try:
        db.reference(path).push(data)
    except Exception as e:
        print(f"[Firebase] Append to {path} failed: {e}")

def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

# ── GPS helper ─────────────────────────────────────────────────────────────────
_gps_location = {"lat": None, "lon": None, "fix": False}

def parse_nmea(nmea_line: str):
    if not nmea_line or not _PYNMEA2_OK:
        return
    try:
        msg = pynmea2.parse(nmea_line.strip())
        if hasattr(msg, "gps_qual") and msg.gps_qual and msg.gps_qual > 0:
            _gps_location.update({
                "lat": round(float(msg.latitude),  6),
                "lon": round(float(msg.longitude), 6),
                "fix": True,
            })
    except Exception:
        pass

def get_location() -> dict:
    return dict(_gps_location)

# ── Threshold evaluation ───────────────────────────────────────────────────────
def evaluate_sensors(data: dict) -> list:
    t = thresholds
    alerts = []
    ph = data.get("ph", 7.0)
    if ph < t["ph_min"]:
        alerts.append(f"pH LOW ({ph:.2f}) — acidic contamination")
    if ph > t["ph_max"]:
        alerts.append(f"pH HIGH ({ph:.2f}) — alkaline contamination")
    if data.get("turb", 0) > t["turbidity_max"]:
        alerts.append(f"Turbidity HIGH (ADC={data['turb']})")
    wtemp = data.get("wtemp", 0.0)
    if wtemp > t["wtemp_max"] and wtemp > -100:
        alerts.append(f"Water temp HIGH ({wtemp:.1f}°C) — thermal pollution")
    if data.get("tds", 0) > t["tds_max"]:
        alerts.append(f"TDS HIGH ({data['tds']:.0f} ppm)")
    return alerts

def fire_sensor_alert(message: str):
    location = get_location()
    payload  = {"type": "SENSOR", "message": message, "location": location, "timestamp": now_iso()}
    firebase_push("/device/alerts/latest", payload)
    firebase_append("/history/alerts", payload)
    ui.send_message("alert", message=payload)
    print(f"[ALERT][SENSOR] {message}")

# ── App Lab bricks ─────────────────────────────────────────────────────────────
ui             = WebUI()
video_detector = VideoObjectDetection(confidence=CONFIDENCE_THRESHOLD, debounce_sec=2.0)

ui.on_message("set_confidence",
    lambda sid, val: video_detector.override_threshold(float(val)))

# ── Sensor data handler ────────────────────────────────────────────────────────
def handle_sensor_update(payload_str: str):
    try:
        data = json.loads(payload_str)
    except (json.JSONDecodeError, TypeError):
        print(f"[Bridge] JSON parse error — raw: {payload_str!r}")
        return

    parse_nmea(data.get("gps", ""))
    data.update(get_location())

    firebase_push("/device/sensors", {**data, "updated_at": now_iso()})
    ui.send_message("sensor_data", message=data)
    print(f"[MCU] pH={data.get('ph')} turb={data.get('turb')} "
          f"wtemp={data.get('wtemp')} tds={data.get('tds')}")

    for alert in evaluate_sensors(data):
        fire_sensor_alert(alert)

# ── AI debris detection callback ───────────────────────────────────────────────
def process_detections(detections: dict):
    location  = get_location()
    timestamp = now_iso()

    best_label = "ocean"
    best_conf  = 0.0
    for label, items in detections.items():
        if isinstance(items, list):
            for item in items:
                c = item.get("confidence", 0)
                if c > best_conf:
                    best_conf, best_label = c, label
        elif isinstance(items, (int, float)) and items > best_conf:
            best_conf, best_label = items, label

    result = {
        "label":      best_label,
        "confidence": round(best_conf * 100, 1),
        "lat":        location.get("lat"),
        "lon":        location.get("lon"),
        "timestamp":  timestamp,
    }

    firebase_push("/device/detection", result)
    firebase_append("/history/detections", result)
    ui.send_message("detection", message=result)
    print(f"[AI] {best_label} {best_conf*100:.1f}%  GPS={location}")

    is_debris = best_label not in ("ocean", "unknown") and best_conf >= CONFIDENCE_THRESHOLD
    try:
        Bridge.call("set_alert", 3 if is_debris else 0)
    except Exception as e:
        print(f"[Bridge] set_alert failed: {e}")

    if is_debris:
        alert_payload = {
            "type":      "DEBRIS",
            "message":   f"{best_label.replace('_', ' ').title()} detected "
                         f"({best_conf*100:.0f}% confidence)",
            "location":  location,
            "timestamp": timestamp,
        }
        firebase_push("/device/alerts/latest", alert_payload)
        firebase_append("/history/alerts", alert_payload)
        ui.send_message("alert", message=alert_payload)

video_detector.on_detect_all(process_detections)

# ── Camera snapshot helpers ────────────────────────────────────────────────────
_latest_frame      = None   # data:image/jpeg;base64,... string from port 4912
_latest_frame_lock = threading.Lock()

def _compress_frame(data_url: str, max_width: int = 320, quality: int = 60) -> str:
    """Resize and re-compress a JPEG data-URL to reduce Firebase payload size."""
    if not _PIL_OK:
        return data_url
    try:
        _, b64 = data_url.split(",", 1)
        img = Image.open(_io.BytesIO(base64.b64decode(b64)))
        if img.width > max_width:
            new_h = int(img.height * max_width / img.width)
            img = img.resize((max_width, new_h), Image.LANCZOS)
        buf = _io.BytesIO()
        img.convert("RGB").save(buf, format="JPEG", quality=quality)
        return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
    except Exception as e:
        print(f"[Camera] Frame compress failed: {e}")
        return data_url

# ── Background thread: camera Socket.IO → port 4912 ───────────────────────────
def _camera_socket_thread():
    if not _SIO_OK:
        return
    print(f"[Camera] Connecting to {_CAMERA_URL}")
    cam = _sio_module.Client(reconnection=True, reconnection_delay=5,
                             reconnection_delay_max=30, logger=False,
                             engineio_logger=False)

    @cam.event
    def image(data):
        global _latest_frame
        frame = data.get("img", "") if isinstance(data, dict) else str(data)
        if frame:
            with _latest_frame_lock:
                _latest_frame = frame

    @cam.event
    def connect():
        print("[Camera] Socket connected to port 4912.")

    @cam.event
    def disconnect():
        print("[Camera] Socket disconnected from port 4912.")

    while True:
        try:
            cam.connect(_CAMERA_URL, wait_timeout=15)
            cam.wait()
        except Exception as e:
            print(f"[Camera] Connection error: {e}. Retrying in 10 s…")
            time.sleep(10)

threading.Thread(target=_camera_socket_thread, daemon=True).start()

# ── Background thread: Firebase heartbeat + threshold sync + camera snapshot ───
def background_tasks():
    last_threshold_sync = 0
    last_cam_snapshot   = 0
    while True:
        time.sleep(30)
        firebase_push("/device/status", {"online": True, "updated_at": now_iso()})

        if _FIREBASE_OK and time.time() - last_threshold_sync >= THRESHOLD_SYNC_S:
            last_threshold_sync = time.time()
            try:
                remote = db.reference("/config/thresholds").get()
                if remote:
                    thresholds.update(remote)
                    print("[Firebase] Thresholds refreshed.")
            except Exception as e:
                print(f"[Firebase] Threshold sync failed: {e}")

        if _FIREBASE_OK and time.time() - last_cam_snapshot >= CAMERA_SNAPSHOT_S:
            last_cam_snapshot = time.time()
            with _latest_frame_lock:
                frame = _latest_frame
            if frame:
                try:
                    compressed = _compress_frame(frame)
                    firebase_push("/device/camera/snapshot", {
                        "img":        compressed,
                        "updated_at": now_iso(),
                    })
                except Exception as e:
                    print(f"[Camera] Firebase snapshot upload failed: {e}")

threading.Thread(target=background_tasks, daemon=True).start()

# ── Sensor polling loop ────────────────────────────────────────────────────────
_last_sensor_poll = 0.0

def user_loop():
    global _last_sensor_poll
    now = time.time()
    if now - _last_sensor_poll >= SENSOR_POLL_S:
        _last_sensor_poll = now
        try:
            payload_str = Bridge.call("get_sensors")
            if payload_str:
                threading.Thread(
                    target=handle_sensor_update,
                    args=(payload_str,),
                    daemon=True
                ).start()
        except Exception as e:
            print(f"[Bridge] get_sensors poll failed: {e}")
    time.sleep(0.05)

firebase_push("/device/status", {"online": True, "updated_at": now_iso()})
print("[MPU] MarineSentinel controller running.")

App.run(user_loop=user_loop)
