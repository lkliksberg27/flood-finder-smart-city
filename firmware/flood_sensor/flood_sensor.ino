/*
 * Flood Finder — Mailbox Sensor Firmware (Deep Sleep, Dual-Mode)
 * Hardware: Heltec ESP32 LoRa V4 (ESP32-S3 + SX1262 + L76 GNSS)
 *
 * Power: Deep sleep between readings (~10µA). Wakes on timer or button.
 *   Normal: wake every 30 min, read sensor, send data, sleep (~15 sec awake)
 *   Flood:  wake every 2 min while water detected
 *
 * Button (single USER button, GPIO 0):
 *   Press < 2s:   show status for 5 sec
 *   Hold 5s:      recalibrate height measurement
 *   Hold 8s:      switch WiFi <-> LoRa mode
 *   While status showing, press again: WiFi reconfigure
 *
 * WiFi setup: device creates AP "FloodFinder-Setup" (pass: floodfinder)
 *   Connect with phone → captive portal shows nearby networks → pick one
 *
 * Required Libraries (Arduino Library Manager):
 *   - Heltec ESP32 Dev-Boards (board package)
 *   - TinyGPS++ by Mikal Hart
 *   - Adafruit BMP3XX by Adafruit
 *   - WiFiManager by tzapu
 *   - ArduinoJson by Benoit Blanchon
 *
 * Wiring (Carrier Board V2 for Heltec V4):
 *   JSN-SR04T TRIG → GPIO 2, ECHO → GPIO 3, VCC → 3.3V (on J3 left header)
 *   BMP390 + MPU6050 SDA → GPIO 33, SCL → GPIO 34 (on J2 right header — external I2C, Wire1)
 *   NOTE: Cannot use GPIO17/18 (OLED_SDA/OLED_SCL) — they are internal-only on V4
 *   GPS (L76) → GNSS connector (RX=39, TX=38)
 */

#include <Wire.h>
#include <EEPROM.h>
#include <LoRa.h>
#include <SSD1306Wire.h>
#include <TinyGPS++.h>
#include <Adafruit_BMP3XX.h>
#include <WiFi.h>
#include <WiFiManager.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <esp_sleep.h>
#include <driver/rtc_io.h>

// ── Pins ────────────────────────────────────────────────────
#define TRIG_PIN       2
#define ECHO_PIN       3
#define GPS_RX_PIN     39
#define GPS_TX_PIN     38
#define BATTERY_PIN    1
#define VBAT_DIVIDER   2.0
#define USER_BUTTON    0

// ── LoRa ────────────────────────────────────────────────────
#define LORA_FREQ      915E6
#define LORA_BW        125E3
#define LORA_SF        7
#define LORA_TX_POWER  14

// ── Timing ──────────────────────────────────────────────────
#define NORMAL_INTERVAL_SEC    1800   // 30 minutes
#define FLOOD_INTERVAL_SEC     120    // 2 minutes when flooding
#define GPS_TIMEOUT_MS         10000  // 10s GPS timeout (position is mostly static)
#define FLOOD_THRESHOLD_CM     5

// ── EEPROM ──────────────────────────────────────────────────
#define EEPROM_SIZE            64
#define ADDR_CALIBRATED        0
#define ADDR_BASELINE          1     // int16
#define ADDR_MODE              4     // 0=LoRa, 1=WiFi
#define ADDR_GPS_SAVED         5     // 0xBB if GPS position saved
#define ADDR_LAT               6     // double (8 bytes)
#define ADDR_LNG               14    // double (8 bytes)

// ── Supabase ────────────────────────────────────────────────
#include "secrets.h"  // Create from secrets.h.example with your real keys

const char* DEVICE_ID = "FF-001";
const int MAILBOX_HEIGHT_CM = 95;

// ── RTC Memory (survives deep sleep) ────────────────────────
RTC_DATA_ATTR int bootCount = 0;
RTC_DATA_ATTR bool lastWaterDetected = false;
RTC_DATA_ATTR double savedLat = 0, savedLng = 0, savedAltGPS = 0;
RTC_DATA_ATTR bool savedGpsValid = false;

// ── Objects ─────────────────────────────────────────────────
SSD1306Wire display(0x3c, SDA_OLED, SCL_OLED);
TinyGPSPlus gps;
Adafruit_BMP3XX bmp;
HardwareSerial gpsSerial(1);

bool bmpAvailable = false;
int baselineDistanceCm = 0;
bool useWiFiMode = false;

// ══════════════════════════════════════════════════════════════
// DEEP SLEEP
// ══════════════════════════════════════════════════════════════
void goToSleep(int seconds) {
  Serial.printf("[SLEEP] Deep sleep for %d sec\n", seconds);
  Serial.flush();

  // Turn off everything
  display.clear();
  display.display();
  display.end();
  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);
  LoRa.end();
  LoRa.sleep();

  // Configure wake sources
  esp_sleep_enable_timer_wakeup((uint64_t)seconds * 1000000ULL);
  esp_sleep_enable_ext0_wakeup((gpio_num_t)USER_BUTTON, 0);  // Wake on button LOW

  esp_deep_sleep_start();
}

// ══════════════════════════════════════════════════════════════
// HARDWARE INIT (runs every wake)
// ══════════════════════════════════════════════════════════════
void initHardware() {
  Serial.begin(115200);
  EEPROM.begin(EEPROM_SIZE);

  // Read config from EEPROM
  useWiFiMode = (EEPROM.read(ADDR_MODE) == 1);
  if (EEPROM.read(ADDR_CALIBRATED) == 0xAA) {
    int16_t stored;
    EEPROM.get(ADDR_BASELINE, stored);
    baselineDistanceCm = stored;
  }

  // Pins
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  pinMode(USER_BUTTON, INPUT_PULLUP);

  // OLED
  display.init();
  display.flipScreenVertically();
  display.setFont(ArialMT_Plain_10);

  // BMP390
  // Heltec V4 carrier: use GPIO33/34 for external I2C (Wire1)
  // GPIO17/18 are internal-only to OLED on V4 — not on side headers.
  Wire.begin(33, 34);  // SDA=GPIO33, SCL=GPIO34
  if (bmp.begin_I2C(0x77, &Wire)) {
    bmpAvailable = true;
    bmp.setTemperatureOversampling(BMP3_OVERSAMPLING_2X);
    bmp.setPressureOversampling(BMP3_OVERSAMPLING_16X);
    bmp.setIIRFilterCoeff(BMP3_IIR_FILTER_COEFF_3);
    bmp.setOutputDataRate(BMP3_ODR_25_HZ);
  }
}

// ══════════════════════════════════════════════════════════════
// SETUP — runs fresh on every wake from deep sleep
// ══════════════════════════════════════════════════════════════
void setup() {
  bootCount++;
  initHardware();

  esp_sleep_wakeup_cause_t wakeReason = esp_sleep_get_wakeup_cause();

  if (wakeReason == ESP_SLEEP_WAKEUP_EXT0) {
    // ── BUTTON WAKE ──
    handleButtonWake();
    goToSleep(lastWaterDetected ? FLOOD_INTERVAL_SEC : NORMAL_INTERVAL_SEC);

  } else if (wakeReason == ESP_SLEEP_WAKEUP_TIMER) {
    // ── TIMER WAKE — take reading ──
    bool flooding = doSensorReading();

    if (flooding) {
      // Stay awake, keep WiFi connected, enter flood loop
      Serial.println("[FLOOD] Water detected — staying awake");
      floodLoop();
    }
    // No flood (or flood ended) — deep sleep
    goToSleep(NORMAL_INTERVAL_SEC);

  } else {
    // ── FIRST BOOT (power on / reset) ──
    Serial.println("[BOOT] First boot — initializing");

    if (baselineDistanceCm == 0) {
      calibrate();
    }

    // Get GPS fix once and save forever (mailbox doesn't move)
    if (EEPROM.read(ADDR_GPS_SAVED) != 0xBB) {
      acquireAndSaveGPS();
    } else {
      EEPROM.get(ADDR_LAT, savedLat);
      EEPROM.get(ADDR_LNG, savedLng);
      savedGpsValid = true;
    }

    display.clear();
    display.setTextAlignment(TEXT_ALIGN_CENTER);
    display.setFont(ArialMT_Plain_16);
    display.drawString(64, 0, "FLOOD FINDER");
    display.setFont(ArialMT_Plain_10);
    display.drawString(64, 20, "ID: " + String(DEVICE_ID));
    display.drawString(64, 33, "Base: " + String(baselineDistanceCm) + "cm");
    display.drawString(64, 46, useWiFiMode ? "Mode: WiFi" : "Mode: LoRa");
    display.display();
    delay(2000);

    doSensorReading();
    goToSleep(lastWaterDetected ? FLOOD_INTERVAL_SEC : NORMAL_INTERVAL_SEC);
  }
}

void loop() {
  // Only reached during flood loop (handled inside floodLoop)
}

// ══════════════════════════════════════════════════════════════
// FLOOD LOOP — stays awake with WiFi connected, reads every 2 min
// Returns to setup() → deep sleep once water clears
// ══════════════════════════════════════════════════════════════
void floodLoop() {
  // Connect WiFi once and keep it alive
  if (useWiFiMode && WiFi.status() != WL_CONNECTED) {
    connectWiFi();
  }

  while (true) {
    // Wait 2 minutes (check button every 100ms)
    for (int i = 0; i < FLOOD_INTERVAL_SEC * 10; i++) {
      delay(100);
      // Check button for user interaction
      if (digitalRead(USER_BUTTON) == LOW) {
        handleButtonWake();
      }
    }

    // Take reading
    bool stillFlooding = doSensorReading();

    if (!stillFlooding) {
      Serial.println("[FLOOD] Water cleared — going to deep sleep");
      // Disconnect WiFi, deep sleep
      if (useWiFiMode) {
        WiFi.disconnect(true);
        WiFi.mode(WIFI_OFF);
      }
      return;  // Back to setup() → goToSleep()
    }
  }
}

// ══════════════════════════════════════════════════════════════
// SENSOR READING CYCLE — returns true if water detected
// ══════════════════════════════════════════════════════════════
bool doSensorReading() {
  Serial.printf("[READ] Boot #%d — taking reading\n", bootCount);

  // Load saved GPS from EEPROM (position is fixed — mailbox doesn't move)
  if (EEPROM.read(ADDR_GPS_SAVED) == 0xBB) {
    EEPROM.get(ADDR_LAT, savedLat);
    EEPROM.get(ADDR_LNG, savedLng);
    savedGpsValid = true;
  }

  // Take 10 ultrasonic readings with outlier rejection
  int distanceCm = readUltrasonic10();
  float battV = readBatteryV();
  int floodDepth = max(0, MAILBOX_HEIGHT_CM - distanceCm);
  bool waterDetected = (floodDepth >= FLOOD_THRESHOLD_CM);

  lastWaterDetected = waterDetected;  // Save to RTC for sleep duration

  Serial.printf("[READ] dist=%dcm flood=%dcm water=%s batt=%.1fV\n",
    distanceCm, floodDepth, waterDetected ? "YES" : "no", battV);

  // Build reading payload (6 core values + device_id)
  JsonDocument doc;
  doc["device_id"] = DEVICE_ID;
  doc["lat"] = savedLat;
  doc["lng"] = savedLng;
  doc["distance_cm"] = distanceCm;
  doc["water_detected"] = waterDetected;
  doc["flood_depth_cm"] = floodDepth;
  doc["battery_v"] = round(battV * 100) / 100.0;
  String json;
  serializeJson(doc, json);

  // Send
  if (useWiFiMode) {
    sendViaWiFi(json, battV);
  } else {
    sendViaLoRa(json);
  }

  return waterDetected;
}

// ══════════════════════════════════════════════════════════════
// BUTTON WAKE HANDLER
// While button is held, show live feedback on what will happen.
// Release timing determines the action.
// ══════════════════════════════════════════════════════════════
void handleButtonWake() {
  Serial.println("[BTN] Button wake");

  unsigned long pressStart = millis();
  bool released = false;
  int action = 0;  // 0=status, 1=recalibrate, 2=switch mode

  // Wait for button release, showing live feedback
  while (!released) {
    unsigned long held = millis() - pressStart;

    display.clear();
    display.setTextAlignment(TEXT_ALIGN_CENTER);
    display.setFont(ArialMT_Plain_10);

    if (held < 2000) {
      display.drawString(64, 0, "FLOOD FINDER");
      display.drawString(64, 20, "Release: show status");
      display.drawString(64, 34, "Hold 5s: recalibrate");
      display.drawString(64, 48, "Hold 8s: switch mode");
      action = 0;
    } else if (held < 5000) {
      display.setFont(ArialMT_Plain_16);
      display.drawString(64, 5, "HOLD...");
      display.setFont(ArialMT_Plain_10);
      int progress = ((held - 2000) * 100) / 3000;
      display.drawString(64, 28, "Recalibrate");
      display.drawRect(14, 42, 100, 10);
      display.fillRect(14, 42, progress, 10);
      action = 0;  // Not yet at threshold
    } else if (held < 8000) {
      display.setFont(ArialMT_Plain_16);
      display.drawString(64, 0, "RECALIBRATE");
      display.setFont(ArialMT_Plain_10);
      display.drawString(64, 22, "Release now to confirm");
      display.drawString(64, 38, "Keep holding: switch mode");
      int progress = ((held - 5000) * 100) / 3000;
      display.drawRect(14, 50, 100, 8);
      display.fillRect(14, 50, progress, 8);
      action = 1;
    } else {
      display.setFont(ArialMT_Plain_16);
      display.drawString(64, 10, "SWITCH MODE");
      display.setFont(ArialMT_Plain_10);
      display.drawString(64, 34, "Release to confirm");
      display.drawString(64, 48, useWiFiMode ? "WiFi -> LoRa" : "LoRa -> WiFi");
      action = 2;
    }

    display.display();
    delay(50);

    if (digitalRead(USER_BUTTON) == HIGH) {
      released = true;
    }

    // Safety timeout (30s)
    if (held > 30000) {
      released = true;
      action = 0;
    }
  }

  unsigned long heldTime = millis() - pressStart;

  if (action == 2) {
    // ── SWITCH MODE ──
    useWiFiMode = !useWiFiMode;
    EEPROM.write(ADDR_MODE, useWiFiMode ? 1 : 0);
    EEPROM.commit();
    Serial.printf("[MODE] Switched to %s\n", useWiFiMode ? "WiFi" : "LoRa");

    display.clear();
    display.setTextAlignment(TEXT_ALIGN_CENTER);
    display.setFont(ArialMT_Plain_16);
    display.drawString(64, 5, useWiFiMode ? "WiFi MODE" : "LoRa MODE");
    display.setFont(ArialMT_Plain_10);
    if (useWiFiMode) {
      display.drawString(64, 30, "Connecting...");
      display.display();
      connectWiFi();
    } else {
      display.drawString(64, 30, "915MHz / SF7");
      display.drawString(64, 44, "Via gateway");
      display.display();
    }
    delay(2000);

  } else if (action == 1) {
    // ── RECALIBRATE ──
    calibrate();

  } else {
    // ── SHOW STATUS ──
    showStatus();

    // Wait for second press (WiFi reconfigure) or timeout
    unsigned long statusStart = millis();
    while (millis() - statusStart < 5000) {
      delay(50);
      if (digitalRead(USER_BUTTON) == LOW) {
        delay(50);  // debounce
        if (digitalRead(USER_BUTTON) == LOW) {
          // Second press detected — WiFi reconfigure
          while (digitalRead(USER_BUTTON) == LOW) delay(50);  // wait for release
          reconfigureWiFi();
          break;
        }
      }
    }
  }
}

// ══════════════════════════════════════════════════════════════
// WIFI
// ══════════════════════════════════════════════════════════════
void connectWiFi() {
  WiFiManager wm;
  wm.setConfigPortalTimeout(180);
  wm.setConnectTimeout(10);

  wm.setAPCallback([](WiFiManager* myWM) {
    Serial.println("[WIFI] Portal opened");
    showWiFiSetup();
  });

  bool connected = wm.autoConnect("FloodFinder-Setup", "floodfinder");

  if (connected) {
    Serial.printf("[WIFI] Connected: %s\n", WiFi.SSID().c_str());
    display.clear();
    display.setTextAlignment(TEXT_ALIGN_CENTER);
    display.setFont(ArialMT_Plain_10);
    display.drawString(64, 10, "WiFi CONNECTED");
    display.setFont(ArialMT_Plain_16);
    display.drawString(64, 28, WiFi.SSID());
    display.display();
    delay(1500);
  } else {
    Serial.println("[WIFI] Connection failed");
  }
}

void reconfigureWiFi() {
  display.clear();
  display.setTextAlignment(TEXT_ALIGN_CENTER);
  display.setFont(ArialMT_Plain_10);
  display.drawString(64, 15, "RESETTING WIFI");
  display.drawString(64, 32, "Forgetting network...");
  display.display();
  delay(1000);

  WiFiManager wm;
  wm.resetSettings();

  useWiFiMode = true;
  EEPROM.write(ADDR_MODE, 1);
  EEPROM.commit();

  connectWiFi();
}

// ══════════════════════════════════════════════════════════════
// SEND DATA
// ══════════════════════════════════════════════════════════════
void sendViaWiFi(String json, float battV) {
  // Only connect if not already connected (stays connected during flood loop)
  if (WiFi.status() != WL_CONNECTED) {
    connectWiFi();
  }

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[WIFI] Not connected — skipping");
    return;
  }

  // Upsert device
  {
    HTTPClient http;
    String url = String(SUPABASE_URL) + "/rest/v1/devices";
    JsonDocument doc;
    doc["device_id"] = DEVICE_ID;
    doc["lat"] = savedLat;
    doc["lng"] = savedLng;
    doc["altitude_baro"] = bmpAvailable ? readBaroAltitude() : (JsonVariant)nullptr;
    doc["mailbox_height_cm"] = MAILBOX_HEIGHT_CM;
    doc["baseline_distance_cm"] = baselineDistanceCm;
    doc["status"] = "online";
    doc["battery_v"] = battV;
    doc["last_seen"] = "now()";
    String body;
    serializeJson(doc, body);

    http.begin(url);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("apikey", SUPABASE_KEY);
    http.addHeader("Authorization", "Bearer " + String(SUPABASE_KEY));
    http.addHeader("Prefer", "return=minimal,resolution=merge-duplicates");
    int code = http.POST(body);
    Serial.printf("[WIFI] Device upsert → %d\n", code);
    http.end();
  }

  // Insert reading
  {
    HTTPClient http;
    String url = String(SUPABASE_URL) + "/rest/v1/sensor_readings";
    http.begin(url);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("apikey", SUPABASE_KEY);
    http.addHeader("Authorization", "Bearer " + String(SUPABASE_KEY));
    http.addHeader("Prefer", "return=minimal");
    int code = http.POST(json);
    Serial.printf("[WIFI] Reading POST → %d\n", code);
    http.end();
  }
  // WiFi stays connected — goToSleep() or floodLoop() handles disconnect
}

void sendViaLoRa(String json) {
  LoRa.setPins(8, 12, 14);
  if (LoRa.begin(LORA_FREQ)) {
    LoRa.setSpreadingFactor(LORA_SF);
    LoRa.setSignalBandwidth(LORA_BW);
    LoRa.setTxPower(LORA_TX_POWER, PA_OUTPUT_PA_BOOST_PIN);
    LoRa.beginPacket();
    LoRa.print(json);
    LoRa.endPacket();
    Serial.printf("[LORA] Sent %d bytes\n", json.length());
    LoRa.end();
  } else {
    Serial.println("[LORA] Init failed");
  }
}

// ══════════════════════════════════════════════════════════════
// SENSOR READINGS (10x with outlier trimming)
// ══════════════════════════════════════════════════════════════
int readUltrasonicCm() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  long duration = pulseIn(ECHO_PIN, HIGH, 30000);
  if (duration == 0) return -1;
  return duration * 0.0343 / 2;
}

// ══════════════════════════════════════════════════════════════
// GPS — acquire once on first boot, save to EEPROM forever
// ══════════════════════════════════════════════════════════════
void acquireAndSaveGPS() {
  Serial.println("[GPS] Acquiring fix (first boot only)...");

  display.clear();
  display.setTextAlignment(TEXT_ALIGN_CENTER);
  display.setFont(ArialMT_Plain_10);
  display.drawString(64, 0, "ACQUIRING GPS");
  display.drawString(64, 16, "First boot only");
  display.drawString(64, 32, "This may take 30-60s");
  display.drawString(64, 48, "Place sensor outside");
  display.display();

  gpsSerial.begin(9600, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
  unsigned long gpsStart = millis();
  bool gotFix = false;

  while (millis() - gpsStart < 90000) {  // 90 second timeout
    while (gpsSerial.available()) {
      gps.encode(gpsSerial.read());
    }
    if (gps.location.isValid() && gps.location.lat() != 0) {
      savedLat = gps.location.lat();
      savedLng = gps.location.lng();
      savedGpsValid = true;
      gotFix = true;
      break;
    }

    // Show progress
    int elapsed = (millis() - gpsStart) / 1000;
    if (elapsed % 5 == 0) {
      display.clear();
      display.setTextAlignment(TEXT_ALIGN_CENTER);
      display.setFont(ArialMT_Plain_10);
      display.drawString(64, 0, "ACQUIRING GPS...");
      display.drawString(64, 20, String(elapsed) + "s / 90s");
      display.drawString(64, 40, "Sats: " + String(gps.satellites.value()));
      display.display();
    }
    delay(100);
  }

  if (gotFix) {
    // Save to EEPROM — never need GPS again
    EEPROM.write(ADDR_GPS_SAVED, 0xBB);
    EEPROM.put(ADDR_LAT, savedLat);
    EEPROM.put(ADDR_LNG, savedLng);
    EEPROM.commit();

    Serial.printf("[GPS] Saved: %.6f, %.6f\n", savedLat, savedLng);

    display.clear();
    display.setTextAlignment(TEXT_ALIGN_CENTER);
    display.setFont(ArialMT_Plain_10);
    display.drawString(64, 10, "GPS LOCKED");
    display.setFont(ArialMT_Plain_16);
    display.drawString(64, 28, String(savedLat, 4) + "," + String(savedLng, 4));
    display.display();
    delay(2000);
  } else {
    Serial.println("[GPS] No fix — will retry next power cycle");
    display.clear();
    display.setTextAlignment(TEXT_ALIGN_CENTER);
    display.setFont(ArialMT_Plain_10);
    display.drawString(64, 10, "GPS: NO FIX");
    display.drawString(64, 28, "Move sensor outside");
    display.drawString(64, 42, "and power cycle");
    display.display();
    delay(3000);
  }
}

// ══════════════════════════════════════════════════════════════
// SENSOR READINGS (10x with outlier trimming)
// ══════════════════════════════════════════════════════════════
int readUltrasonic10() {
  int readings[10];
  int valid = 0;

  for (int i = 0; i < 10; i++) {
    int r = readUltrasonicCm();
    if (r >= 25 && r < 400) {
      readings[valid++] = r;
    }
    delay(500);
  }

  if (valid == 0) return baselineDistanceCm;
  if (valid <= 2) {
    long s = 0;
    for (int i = 0; i < valid; i++) s += readings[i];
    return s / valid;
  }

  // Sort
  for (int i = 0; i < valid - 1; i++)
    for (int j = i + 1; j < valid; j++)
      if (readings[j] < readings[i]) { int t = readings[i]; readings[i] = readings[j]; readings[j] = t; }

  // Trim 20% from each end, average the middle
  int trim = max(1, valid / 5);
  long sum = 0;
  int count = 0;
  for (int i = trim; i < valid - trim; i++) {
    sum += readings[i];
    count++;
  }
  return (count > 0) ? (sum / count) : readings[valid / 2];
}

float readBaroAltitude() {
  if (!bmpAvailable || !bmp.performReading()) return 0;
  return bmp.readAltitude(1013.25);
}

float readBatteryV() {
  int raw = analogRead(BATTERY_PIN);
  return (raw / 4095.0) * 3.3 * VBAT_DIVIDER;
}

// ══════════════════════════════════════════════════════════════
// CALIBRATION (10 readings, outlier rejection)
// ══════════════════════════════════════════════════════════════
void calibrate() {
  Serial.println("[CAL] Starting calibration");

  display.clear();
  display.setTextAlignment(TEXT_ALIGN_CENTER);
  display.setFont(ArialMT_Plain_10);
  display.drawString(64, 0, "-- CALIBRATING --");
  display.drawString(64, 16, "Measuring height");
  display.drawString(64, 32, "Keep area below clear");
  display.display();
  delay(2000);

  int readings[10];
  int valid = 0;

  for (int i = 0; i < 10; i++) {
    int r = readUltrasonicCm();
    if (r >= 25 && r < 400) readings[valid++] = r;

    display.clear();
    display.setTextAlignment(TEXT_ALIGN_CENTER);
    display.setFont(ArialMT_Plain_10);
    display.drawString(64, 0, "CALIBRATING");
    display.drawString(64, 14, "Sample " + String(i + 1) + "/10");
    display.drawRect(14, 30, 100, 10);
    display.fillRect(14, 30, ((i + 1) * 10), 10);
    if (r >= 25 && r < 400) display.drawString(64, 46, String(r) + " cm");
    else display.drawString(64, 46, "-- invalid --");
    display.display();
    delay(1000);
  }

  if (valid < 3) {
    display.clear();
    display.setTextAlignment(TEXT_ALIGN_CENTER);
    display.setFont(ArialMT_Plain_16);
    display.drawString(64, 10, "CAL FAILED");
    display.setFont(ArialMT_Plain_10);
    display.drawString(64, 34, "Only " + String(valid) + " valid");
    display.drawString(64, 48, "Check sensor wiring");
    display.display();
    delay(3000);
    return;
  }

  // Sort + trim outliers
  for (int i = 0; i < valid - 1; i++)
    for (int j = i + 1; j < valid; j++)
      if (readings[j] < readings[i]) { int t = readings[i]; readings[i] = readings[j]; readings[j] = t; }

  int trim = max(1, valid / 5);
  long sum = 0;
  int count = 0;
  for (int i = trim; i < valid - trim; i++) { sum += readings[i]; count++; }
  baselineDistanceCm = (count > 0) ? (sum / count) : readings[valid / 2];

  EEPROM.write(ADDR_CALIBRATED, 0xAA);
  int16_t val = (int16_t)baselineDistanceCm;
  EEPROM.put(ADDR_BASELINE, val);
  EEPROM.commit();

  Serial.printf("[CAL] Baseline: %d cm\n", baselineDistanceCm);

  display.clear();
  display.setTextAlignment(TEXT_ALIGN_CENTER);
  display.setFont(ArialMT_Plain_10);
  display.drawString(64, 5, "CALIBRATION DONE");
  display.setFont(ArialMT_Plain_16);
  display.drawString(64, 22, String(baselineDistanceCm) + " cm");
  display.setFont(ArialMT_Plain_10);
  display.drawString(64, 44, "Mailbox: " + String(MAILBOX_HEIGHT_CM) + "cm");
  display.display();
  delay(3000);
}

// ══════════════════════════════════════════════════════════════
// OLED SCREENS
// ══════════════════════════════════════════════════════════════
void showStatus() {
  float battV = readBatteryV();
  int battPct = constrain(map((int)(battV * 100), 300, 420, 0, 100), 0, 100);

  display.clear();
  display.setTextAlignment(TEXT_ALIGN_CENTER);
  display.setFont(ArialMT_Plain_10);

  display.drawString(64, 0, String(DEVICE_ID) + " | Boot #" + String(bootCount));
  display.drawLine(0, 11, 128, 11);

  // Mode + connection
  if (useWiFiMode) {
    display.drawString(64, 13, "Mode: WiFi");
  } else {
    display.drawString(64, 13, "Mode: LoRa 915MHz");
  }

  display.drawString(64, 25, "Base: " + String(baselineDistanceCm) + "cm | " +
    (lastWaterDetected ? "FLOOD" : "Dry"));

  display.drawString(64, 37, "Batt: " + String(battV, 1) + "V (" + String(battPct) + "%)");

  display.drawLine(0, 49, 128, 49);
  display.drawString(64, 51, "Press: WiFi setup");

  display.display();
}

void showWiFiSetup() {
  display.clear();
  display.setTextAlignment(TEXT_ALIGN_CENTER);
  display.setFont(ArialMT_Plain_10);
  display.drawString(64, 0, "-- WIFI SETUP --");
  display.drawString(64, 14, "1. Open phone WiFi");
  display.drawString(64, 26, "2. Join: FloodFinder-Setup");
  display.drawString(64, 38, "3. Pass: floodfinder");
  display.drawString(64, 50, "4. Pick your network");
  display.display();
}
