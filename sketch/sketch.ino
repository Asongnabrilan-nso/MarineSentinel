// MarineSentinel — MCU Sensor Interface
// Runs on: Arduino UNO Q — STM32 MCU block
// Environment: Arduino App Lab
//
// Serial port assignments
//   Serial   App Lab / USB console  115200 baud
//   Serial2  GPS module             9600 baud   board-specific pins
//
// Wiring (UNO Q STM32 side):
//   pH sensor    AOUT → A0
//   Turbidity    AOUT → A1
//   DS18B20 data      → D12  (4.7 kΩ pull-up to 5 V is mandatory)
//   TDS sensor   AOUT → A2
//   GPS TX            → Serial1 RX pin  (check UNO Q pinout)
//   GPS module VCC    → 3.3 V or 5 V
//   All GNDs connected

#include <Arduino_RouterBridge.h>
#include <OneWire.h>
#include <DallasTemperature.h>

// ── Pin assignments ────────────────────────────────────────────────────────────
#define PH_PIN         A0
#define TURBIDITY_PIN  A1
#define DS18B20_PIN    12
#define TDS_PIN        A2

// ── Timing ────────────────────────────────────────────────────────────────────
#define SENSOR_UPDATE_MS  5000
#define GPS_BAUD          9600

OneWire           oneWire(DS18B20_PIN);
DallasTemperature waterTempSensor(&oneWire);

unsigned long lastUpdate = 0;
String        lastNmea   = "";
char          sensorCache[256] = "{}";

// ── LED helper ────────────────────────────────────────────────────────────────
void blinkLED(int times, int ms) {
  for (int i = 0; i < times; i++) {
    digitalWrite(LED_BUILTIN, HIGH); delay(ms);
    digitalWrite(LED_BUILTIN, LOW);  delay(ms);
  }
}

// ── Bridge callbacks ──────────────────────────────────────────────────────────
String getSensors() { return String(sensorCache); }

void set_alert(int severity) {
  if (severity > 0) blinkLED(severity, 200);
}

void ping(int dummy) { Serial.println("[MCU] PONG"); }

// ── Setup ─────────────────────────────────────────────────────────────────────
void setup() {
  pinMode(LED_BUILTIN, OUTPUT);

  // Stage 1 — 3 fast blinks: code started
  blinkLED(3, 80);

  Serial.begin(115200);
  delay(500);
  Serial.println("[MCU] === MarineSentinel booting ===");

  // Stage 2 — GPS serial
  Serial1.begin(GPS_BAUD);
  Serial.println("[MCU] Serial2 ready (GPS)");

  // Stage 3 — water sensors
  waterTempSensor.begin();
  Serial.println("[MCU] DS18B20 ready");

  // Stage 4 — Bridge
  // Bridge.begin() blocks until the MPU Python side is running.
  Serial.println("[MCU] Starting Bridge — waiting for MPU handshake...");
  Bridge.begin();
  Serial.println("[MCU] Bridge ready");

  // Stage 5 — 5 blinks: past Bridge.begin()
  blinkLED(5, 80);

  Bridge.provide("get_sensors", getSensors);
  Bridge.provide("set_alert",   set_alert);
  Bridge.provide("ping",        ping);

  // 1 long blink — all setup done
  blinkLED(1, 500);
  Serial.println("[MCU] Setup complete. Sensor loop running.");
}

// ── Main loop ─────────────────────────────────────────────────────────────────
void loop() {
  Bridge.update();

  // Buffer GPS NMEA sentences non-blocking
  while (Serial1.available()) {
    String line = Serial1.readStringUntil('\n');
    line.trim();
    if (line.startsWith("$GNGGA") || line.startsWith("$GPGGA")) {
      lastNmea = line;
    }
  }

  if (millis() - lastUpdate >= SENSOR_UPDATE_MS) {
    lastUpdate = millis();
    updateSensorCache();
  }
}

// ── Sensor cycle ──────────────────────────────────────────────────────────────
// Reads all local sensors (DS18B20 blocks ~750 ms at 12-bit) and
// updates the JSON cache that Bridge.provide returns to the MPU.
void updateSensorCache() {
  Serial.println("[MCU] ---- sensor cycle ----");

  // pH
  int   phRaw  = analogRead(PH_PIN);
  float phVolt = phRaw * (5.0f / 1023.0f);
  float ph = constrain(7.0f + ((2.5f - phVolt) / 0.18f), 0.0f, 14.0f);

  // Turbidity
  int turbRaw = analogRead(TURBIDITY_PIN);

  // Water temperature — requestTemperatures() blocks ~750 ms at 12-bit resolution
  waterTempSensor.requestTemperatures();
  float wTemp = waterTempSensor.getTempCByIndex(0);

  // TDS
  int   tdsRaw  = analogRead(TDS_PIN);
  float tdsVolt = tdsRaw * (5.0f / 1023.0f);
  float tds = (133.42f * tdsVolt * tdsVolt * tdsVolt
              - 255.86f * tdsVolt * tdsVolt
              + 857.39f * tdsVolt) * 0.5f;

  Serial.print("[MCU] pH:"); Serial.print(ph, 2);
  Serial.print("  turb:");   Serial.print(turbRaw);
  Serial.print("  wTemp:");  Serial.print(wTemp, 1);
  Serial.print("  tds:");    Serial.println(tds, 0);

  snprintf(sensorCache, sizeof(sensorCache),
    "{\"ph\":%.2f,\"turb\":%d,\"wtemp\":%.1f,\"tds\":%.0f,\"gps\":\"%s\"}",
    ph, turbRaw, wTemp, tds, lastNmea.c_str());

  Serial.println("[MCU] Cache updated.");
  blinkLED(1, 50);
}
