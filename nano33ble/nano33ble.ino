// =============================================================================
// MarineSentinel — Nano 33 BLE Sense Peripheral Node
// =============================================================================
//
// Upload this sketch to the Arduino Nano 33 BLE Sense using Arduino IDE 2.3.
// This file is STANDALONE — it is NOT part of the Arduino App Lab project.
//
// Role:
//   Provides real-time environmental + stability data to the UNO Q MCU.
//   When the UNO Q sends "GET_SENSORS\n" over UART, this sketch reads all
//   onboard sensors and replies with a single CSV line that the UNO Q parses.
//
// Wiring  (UNO Q STM32 side  ↔  Nano 33 BLE Sense):
//   UNO Q D1 (Serial1 TX)  ───►  Nano D0 (Serial1 RX)
//   UNO Q D0 (Serial1 RX)  ◄───  Nano D1 (Serial1 TX)
//   UNO Q GND              ────   Nano GND   ← REQUIRED common ground
//   UNO Q 3.3 V (optional) ────   Nano 3.3 V (or power Nano via its own USB)
//
// Response format (one line, newline-terminated, no spaces):
//   ATEMP:23.5,HUM:65.2,PRESS:1013.5,AX:0.01,AY:-0.02,AZ:0.99,GX:0.5,GY:-0.3,GZ:0.1
//
// Required Arduino libraries — install via Arduino IDE → Library Manager:
//   • Arduino_HTS221   v1.0+   (air temperature + relative humidity)
//   • Arduino_LPS22HB  v1.0+   (barometric pressure)
//   • Arduino_LSM9DS1  v1.1+   (accelerometer + gyroscope)
//
// Board package (Boards Manager):
//   "Arduino Mbed OS Nano Boards"
//   Board: Arduino Nano 33 BLE  (or Arduino Nano 33 BLE Sense)
//
// NOTE — Nano 33 BLE Sense Rev2 users:
//   Rev2 ships with different ICs (HS3003, BMI270, BMM150).
//   Replace the three #include lines and sensor init/read calls with the
//   corresponding Rev2 libraries (Arduino_HS300x, Arduino_BMI270_BMM150).
//   The response format stays identical.
// =============================================================================

#include <Arduino_HTS221.h>   // HTS221  — air temperature + humidity
#include <Arduino_LPS22HB.h>  // LPS22HB — barometric pressure
#include <Arduino_LSM9DS1.h>  // LSM9DS1 — 6-DOF IMU (accel + gyro)

// ── Configuration ─────────────────────────────────────────────────────────────
#define UART_BAUD  9600   // Must match UART_NANO_BAUD in the UNO Q sketch

// ── Sensor availability flags ──────────────────────────────────────────────────
static bool hts_ok = false;   // HTS221  initialised successfully
static bool lps_ok = false;   // LPS22HB initialised successfully
static bool imu_ok = false;   // LSM9DS1 initialised successfully

// ── UART receive accumulation buffer ──────────────────────────────────────────
static String rxBuf;   // command characters accumulate here until '\n'

// ── Latest sensor readings (updated on each GET_SENSORS request) ──────────────
static float s_atemp = 0.0f;               // air temperature   °C
static float s_hum   = 0.0f;               // relative humidity  %
static float s_press = 0.0f;               // pressure          hPa
static float s_ax = 0.0f, s_ay = 0.0f, s_az = 1.0f;  // acceleration g
static float s_gx = 0.0f, s_gy = 0.0f, s_gz = 0.0f;  // rotation     °/s

// =============================================================================
// LED helper
// The Nano 33 BLE Sense LED is active-LOW: LOW → ON, HIGH → OFF.
// =============================================================================
void blinkLED(int count, int ms) {
  for (int i = 0; i < count; i++) {
    digitalWrite(LED_BUILTIN, LOW);   // ON
    delay(ms);
    digitalWrite(LED_BUILTIN, HIGH);  // OFF
    delay(ms);
  }
}

// =============================================================================
// setup()
// =============================================================================
void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, HIGH);  // LED off at boot

  // ── USB serial (debug only; device must work headless without USB) ──────────
  Serial.begin(115200);
  unsigned long t0 = millis();
  while (!Serial && millis() - t0 < 2000);  // wait ≤ 2 s for USB host
  Serial.println("[Nano] === MarineSentinel Nano 33 BLE Sense booting ===");

  // ── UART to UNO Q (pins D0=RX, D1=TX) ─────────────────────────────────────
  Serial1.begin(UART_BAUD);
  rxBuf.reserve(32);
  Serial.print("[Nano] Serial1 ready — "); Serial.print(UART_BAUD); Serial.println(" baud to UNO Q");

  // ── HTS221 — air temperature + humidity ────────────────────────────────────
  if (HTS.begin()) {
    hts_ok = true;
    Serial.println("[Nano] HTS221  OK (air temp + humidity)");
  } else {
    Serial.println("[Nano] WARN: HTS221 not found — check board revision");
  }

  // ── LPS22HB — barometric pressure ──────────────────────────────────────────
  if (BARO.begin()) {
    lps_ok = true;
    Serial.println("[Nano] LPS22HB OK (pressure)");
  } else {
    Serial.println("[Nano] WARN: LPS22HB not found");
  }

  // ── LSM9DS1 — 6-DOF IMU (accelerometer + gyroscope) ───────────────────────
  if (IMU.begin()) {
    imu_ok = true;
    Serial.print("[Nano] LSM9DS1 OK (IMU @ ");
    Serial.print(IMU.accelerationSampleRate(), 0);
    Serial.println(" Hz accel)");
  } else {
    Serial.println("[Nano] WARN: LSM9DS1 not found");
  }

  // 5 blinks → fully initialised
  blinkLED(5, 80);
  Serial.println("[Nano] Ready — waiting for GET_SENSORS commands.");
}

// =============================================================================
// readSensors()
// Refresh all cached sensor values. Called only when GET_SENSORS is received
// so that the UART reply contains fresh readings.
// =============================================================================
void readSensors() {
  if (hts_ok) {
    s_atemp = HTS.readTemperature();  // °C
    s_hum   = HTS.readHumidity();     // %
  }

  if (lps_ok) {
    // readPressure() returns kPa — multiply by 10 to convert to hPa.
    // Standard atmosphere: 101.325 kPa = 1013.25 hPa ✓
    s_press = BARO.readPressure() * 10.0f;
  }

  if (imu_ok) {
    // Only read when new sample is available to avoid stale data.
    if (IMU.accelerationAvailable()) {
      IMU.readAcceleration(s_ax, s_ay, s_az);  // g
    }
    if (IMU.gyroscopeAvailable()) {
      IMU.readGyroscope(s_gx, s_gy, s_gz);  // °/s
    }
  }
}

// =============================================================================
// sendSensorData()
// Build and transmit the CSV reply to the UNO Q.
// Key names must exactly match what the UNO Q's parseField() looks for.
// =============================================================================
void sendSensorData() {
  readSensors();

  char buf[128];
  snprintf(buf, sizeof(buf),
    "ATEMP:%.1f,HUM:%.1f,PRESS:%.1f,"
    "AX:%.2f,AY:%.2f,AZ:%.2f,"
    "GX:%.1f,GY:%.1f,GZ:%.1f",
    s_atemp, s_hum, s_press,
    s_ax,    s_ay,  s_az,
    s_gx,    s_gy,  s_gz
  );

  // '\n' signals end-of-line to the UNO Q's pollNanoResponse() reader.
  Serial1.println(buf);
  Serial1.flush();

  Serial.print("[Nano] >> ");
  Serial.println(buf);

  blinkLED(1, 30);  // brief confirmation flash per successful reply
}

// =============================================================================
// loop()
// Non-blocking UART command receiver.
// Accumulates bytes until '\n', then dispatches if command == "GET_SENSORS".
// Never blocks so it remains responsive to back-to-back commands.
// =============================================================================
void loop() {
  while (Serial1.available()) {
    char c = (char)Serial1.read();

    if (c == '\n' || c == '\r') {
      if (rxBuf.length() > 0) {
        rxBuf.trim();

        if (rxBuf.equalsIgnoreCase("GET_SENSORS")) {
          sendSensorData();
        } else {
          // Log unknown commands for debugging; do not hang or reset.
          Serial.print("[Nano] Unknown cmd: ");
          Serial.println(rxBuf);
        }

        rxBuf = "";
      }
      // Ignore lone \r or blank lines.
    } else if (rxBuf.length() < 30) {
      // 30-char guard prevents unbounded growth if line noise prevents '\n'.
      rxBuf += c;
    }
  }
}
