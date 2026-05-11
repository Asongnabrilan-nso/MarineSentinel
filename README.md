# 🌊 MarineSentinel

![MarineSentinel Floating on Ocean](./images/imagesMarineSentinel_floating.gif)

AI-powered marine debris detection and water quality monitoring device. MarineSentinel floats on water bodies (oceans, seas, rivers) and continuously:

- **Detects plastic debris** (plastic bags, plastic bottles) via an Edge Impulse image-classification model running on the MPU.
- **Monitors water quality** (pH, turbidity, water temperature, TDS) via the MCU's sensor interface.
- **Streams all data** to a local in-device WebUI (real-time) and a remote Firebase dashboard (global access).
- **Shows live camera feed** in the local WebUI and uploads periodic snapshots to the remote Firebase dashboard.

---

## Table of Contents

1. [System Architecture](#system-architecture)
2. [Hardware Requirements](#hardware-requirements)
3. [Wiring Diagram](#wiring-diagram)
4. [Software Setup](#software-setup)
   - [A — UNO Q MCU Sketch (App Lab)](#a--uno-q-mcu-sketch-app-lab)
   - [B — UNO Q MPU Python App (App Lab)](#b--uno-q-mpu-python-app-app-lab)
   - [C — Firebase Remote Dashboard](#c--firebase-remote-dashboard)
5. [Edge Impulse AI Model](#edge-impulse-ai-model)
6. [Configuration & Thresholds](#configuration--thresholds)
7. [Project Structure](#project-structure)
8. [Troubleshooting](#troubleshooting)

---

## System Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                      Arduino UNO Q                                 │
│                                                                    │
│  ┌──────────────────────────────────┐  ┌───────────────────────┐  │
│  │  MPU  (Linux / Python)           │  │  MCU  (STM32 / C++)   │  │
│  │                                  │  │                       │  │
│  │  python/main.py                  │  │  sketch/sketch.ino    │  │
│  │  ├─ VideoObjectDetection brick   │  │  ├─ pH sensor (A0)    │  │
│  │  │   (Edge Impulse model)        │  │  ├─ Turbidity (A1)    │  │
│  │  ├─ WebUI brick  (local UI)      │  │  ├─ DS18B20  (D12)    │  │
│  │  ├─ Firebase Admin SDK           │  │  ├─ TDS sensor (A2)   │  │
│  │  ├─ Camera socket (port 4912)    │  │  └─ GPS (Serial2)     │  │
│  │  └─ Bridge.call("get_sensors")◄──┼──┼──Bridge.provide()     │  │
│  └──────────────────────────────────┘  └───────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘

 ┌──────────────────────┐        ┌──────────────────────────────┐
 │  AI Runner  (port    │        │  Local WebUI  (port 7000)    │
 │  4912 Socket.IO)     │◄──────►│  Browser connects to both    │
 │  JPEG camera frames  │        │  port 7000 (data) and        │
 └──────────────────────┘        │  port 4912 (live camera)     │
                                 └──────────────────────────────┘

Local WebUI ──► browser on same network  http://<device-ip>:7000
Firebase    ──► global dashboard         https://your-project.web.app
```

### Data Flow

1. **AI Detection**: Camera → `VideoObjectDetection` brick → `process_detections()` → WebUI + Firebase
2. **Water Sensors**: MCU reads A0/A1/A2/D12 → Bridge `get_sensors` → Python → WebUI + Firebase
3. **GPS**: GPS module → MCU Serial2 → included in sensor JSON → Python parses NMEA → lat/lon in alerts
4. **Live Camera (local)**: Browser connects directly to AI runner Socket.IO on port 4912 — receives JPEG frames in real time
5. **Camera Snapshots (remote)**: Python subscribes to AI runner Socket.IO, compresses latest frame, uploads to Firebase every 30 s

---

## Hardware Requirements

| Component | Qty | Notes |
|---|---|---|
| Arduino UNO Q | 1 | MPU (Linux) + MCU (STM32) in one board |
| Camera module | 1 | Compatible with UNO Q App Lab camera brick |
| GPS module (UART) | 1 | e.g. Neo-6M / Neo-8M — 9600 baud UART output |
| pH sensor + circuit | 1 | Analog voltage output 0–5 V |
| Turbidity sensor | 1 | Analog voltage output |
| DS18B20 waterproof | 1 | 1-Wire, requires 4.7 kΩ pull-up resistor |
| TDS sensor *(optional)* | 1 | Analog voltage output |
| 4.7 kΩ resistor | 1 | Pull-up for DS18B20 data line |
| Waterproof float/enclosure | 1 | Housing for ocean/river deployment |

> **Note:** The Arduino Nano 33 BLE Sense environmental node has been suspended from this build.
> All sensing is handled directly by the UNO Q STM32 MCU block.

---

## Wiring Diagram

### UNO Q STM32 MCU Pins

```
Sensor                   UNO Q pin
─────────────────────────────────────────────────────────
pH sensor AOUT      ──►  A0
Turbidity AOUT      ──►  A1
TDS sensor AOUT     ──►  A2          (optional)
DS18B20 data        ──►  D12  (4.7 kΩ pull-up to 5 V mandatory)
GPS module TX       ──►  Serial2 RX  (check UNO Q pinout for Serial2 pin)
GPS module VCC      ──►  3.3 V or 5 V (check GPS module datasheet)
GPS module GND      ──►  GND
```

---

## Software Setup

### A — UNO Q MCU Sketch (App Lab)

The MCU sketch (`sketch/sketch.ino`) is managed by Arduino App Lab and runs on the STM32 block.

**Libraries** — App Lab installs these automatically from `sketch/sketch.yaml`:

| Library | Purpose |
|---|---|
| `Arduino_RouterBridge` | MCU ↔ MPU bridge communication |
| `OneWire` v2.3.8 | 1-Wire bus for DS18B20 |
| `DallasTemperature` v4.0.6 | DS18B20 water temperature reads |

**Boot LED sequence** — watch the UNO Q built-in LED after power-on:

| Pattern | Stage |
|---|---|
| 3 × fast blinks | Code started |
| 5 × fast blinks | Bridge handshake with MPU complete |
| 1 × long blink | All setup done — sensor loop running |
| 1 × short blink every 5 s | Sensor cache updated successfully |

---

### B — UNO Q MPU Python App (App Lab)

The Python app (`python/main.py`) runs on the Linux MPU block of the UNO Q.

**App bricks** (configured in `app.yaml`):

| Brick | Purpose |
|---|---|
| `arduino:video_object_detection` | Runs Edge Impulse model; streams camera to port 4912 |
| `arduino:web_ui` | Serves local WebUI from `assets/` directory on port 7000 |

**Firebase Admin SDK credential**

1. Open [Firebase Console](https://console.firebase.google.com) → your project.
2. Go to **Project Settings → Service Accounts → Generate new private key**.
3. Download the JSON file and copy it to:
   ```
   python/config/serviceAccountKey.json
   ```
4. Update `DATABASE_URL` at the top of `python/main.py`:
   ```python
   DATABASE_URL = "https://YOUR_PROJECT_ID-default-rtdb.firebaseio.com"
   ```

Python dependencies are auto-installed on first run and listed in `python/requirements.txt`:
```
pynmea2        — parses NMEA GPS sentences
firebase-admin — Firebase Realtime Database Admin SDK
```

The following packages are pre-installed in the App Lab base image and do **not** need to be listed in `requirements.txt`:
- `python-socketio` — receives camera frames from the AI runner
- `Pillow` — compresses frames before uploading to Firebase

**Local WebUI** is accessible at `http://<device-ip>:7000` once running. It displays:

- Live camera feed (JPEG frames streamed directly from the AI runner on port 4912)
- AI detection result: class label, confidence %, GPS coordinates
- Debris alert banner with geo-location (`lat°, lon°`) when plastic is detected
- Water quality tiles: pH, turbidity, water °C, TDS ppm
- Scrollable recent-alerts list with GPS stamp on debris events

---

### C — Firebase Remote Dashboard

The Firebase dashboard (`dashboard/public/`) enables worldwide remote monitoring.

**Step 1 — Create a Firebase project**

1. Go to [Firebase Console](https://console.firebase.google.com) → **Add project**.
2. Enable **Realtime Database** (create in test mode initially).
3. Enable **Hosting**.

**Step 2 — Configure the dashboard**

Open `dashboard/public/app.js` and replace the `firebaseConfig` block with your real project config
(find it at **Firebase Console → Project Settings → Your apps → SDK setup → Config**):

```javascript
const firebaseConfig = {
  apiKey:            'YOUR_API_KEY',
  authDomain:        'YOUR_PROJECT_ID.firebaseapp.com',
  databaseURL:       'https://YOUR_PROJECT_ID-default-rtdb.firebaseio.com',
  projectId:         'YOUR_PROJECT_ID',
  storageBucket:     'YOUR_PROJECT_ID.appspot.com',
  messagingSenderId: 'YOUR_SENDER_ID',
  appId:             'YOUR_APP_ID',
};
```

**Step 3 — Deploy to Firebase Hosting**

```bash
# Install Firebase CLI (once, requires Node.js)
npm install -g firebase-tools

# Authenticate
firebase login

# Deploy from the dashboard directory
cd dashboard
firebase deploy
```

Firebase prints a Hosting URL such as `https://your-project.web.app`. Open it anywhere in the world.

**Step 4 — Apply security rules**

```bash
cd dashboard
firebase database:rules:set database.rules.json
```

Current rules allow:
- **Public read** of `/device/*` and `/config/thresholds` — anyone with the URL can view live data.
- **Authenticated write** only — only signed-in users can change thresholds or write data.

**Dashboard features**:

- Live online/offline status + last-seen timestamp
- AI detection card with class label, confidence, GPS fix
- Water quality sensor tiles (colour-coded alert/ok)
- **Camera snapshot** — latest compressed JPEG from the device, refreshed every 30 s
- Remote threshold control — save new limits to Firebase; MPU pulls them every 60 s
- Recent alerts log (last 10 events)

---

## Edge Impulse AI Model

The model is configured in `app.yaml`:

```yaml
bricks:
  - arduino:video_object_detection:
      model: ei-model-949141-1
```

### Detection classes

| Class | Meaning |
|---|---|
| `plastic_bag` | Plastic bag visible in camera frame |
| `plastic_bottle` | Plastic bottle visible in camera frame |
| `ocean` | Open water — no debris detected |

Any class that is not `ocean` and exceeds the confidence threshold triggers a **DEBRIS alert** with the current GPS location.

### Confidence threshold

Default: **70 %** (`CONFIDENCE_THRESHOLD = 0.70` in `python/main.py`).
Adjustable at runtime via the confidence slider in the local WebUI.

---

## Configuration & Thresholds

Thresholds are defined in `python/main.py` and can be updated remotely from the Firebase dashboard.
The MPU pulls updates from `/config/thresholds` every 60 seconds (no restart required).

| Key | Default | Alert trigger |
|---|---|---|
| `ph_min` | 6.5 | pH drops below — acidic contamination |
| `ph_max` | 9.5 | pH rises above — alkaline contamination |
| `turbidity_max` | 300 ADC | Turbidity raw ADC exceeds value |
| `wtemp_max` | 30.0 °C | Water temperature above threshold |
| `tds_max` | 500 ppm | Total dissolved solids above threshold |

---

## Project Structure

```
marinesentinel_code/
│
├── app.yaml                        # App Lab project (bricks, ports, metadata)
│
├── python/                         # MPU — Linux side of Arduino UNO Q
│   ├── main.py                     # Main controller: AI, Bridge polling,
│   │                               # WebUI events, Firebase sync, camera socket
│   ├── requirements.txt            # Python package list
│   └── config/
│       └── serviceAccountKey.json  # Firebase Admin credential (keep private)
│
├── sketch/                         # MCU — STM32 side of Arduino UNO Q
│   ├── sketch.ino                  # Sensor reads + Bridge (pH, turbidity,
│   │                               # DS18B20, TDS, GPS)
│   └── sketch.yaml                 # Board profile + library dependencies
│
├── assets/                         # Local WebUI (served by the WebUI brick)
│   ├── index.html                  # Dashboard layout
│   ├── app.js                      # Socket.io client: sensors, detections,
│   │                               # camera (direct link to port 4912),
│   │                               # geo-located debris alerts
│   ├── style.css                   # Dark-theme responsive styles
│   └── libs/
│       └── socket.io.min.js        # Socket.IO v4 client library
│
├── nano33ble/
│   └── nano33ble.ino               # SUSPENDED — Nano 33 BLE Sense sketch
│                                   # (not used in current build)
│
├── dashboard/                      # Firebase-hosted global dashboard
│   ├── firebase.json               # Hosting + Database config
│   ├── database.rules.json         # Realtime Database security rules
│   └── public/
│       ├── index.html              # Remote monitoring layout
│       ├── app.js                  # Firebase DB listeners, camera snapshot,
│       │                           # threshold control
│       └── style.css               # Dashboard styles
│
└── README.md                       # Setup and deployment guide (this file)
```

---

## Troubleshooting

### Camera feed not showing in local WebUI

The browser opens two Socket.IO connections: one to port 7000 (data) and one to port 4912 (camera frames). Port 4912 is served by the AI runner container.

- Ensure the App Lab project is running (both bricks must be healthy).
- Check browser console for WebSocket errors to port 4912.
- The AI runner must complete its healthcheck (port 5050) before the camera socket is active.

### Camera snapshot not appearing on remote dashboard

- The Python app connects to the AI runner Socket.IO on port 4912. Check MPU logs for `[Camera]` lines.
- Snapshots upload to Firebase at `/device/camera/snapshot` every 30 s (only when a frame is available).
- If `HOST_IP` env var is missing, Python falls back to the Docker service name `ei-video-obj-detection-runner`.

### GPS — always `fix: false`

- GPS needs a clear sky to acquire a fix; avoid indoor testing without a GPS simulator.
- Confirm the GPS module TX wire goes to the **Serial2 RX** pin on the UNO Q.
- Only `$GNGGA` and `$GPGGA` NMEA sentences are accepted; other sentence types are discarded.

### Firebase — data not appearing on remote dashboard

- Confirm `python/config/serviceAccountKey.json` exists and belongs to the correct project.
- Match `DATABASE_URL` in `python/main.py` exactly to your Realtime Database URL.
- Look for `[Firebase] Write ... failed:` messages in the MPU Python console.

### pH reading stuck at 7.0

- 2.5 V on A0 maps to pH 7.0. A floating pin reads mid-rail. Confirm the pH probe is connected to A0 with power and GND.

### DS18B20 returns −127 °C

- No 1-Wire device detected. Check the **4.7 kΩ pull-up** between D12 and 5 V, and the sensor's DATA/VCC/GND connections.
