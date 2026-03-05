/*
 * Flood Finder — Mailbox Sensor Firmware
 * Hardware: Heltec ESP32 LoRa 32 V4 (ESP32-S3 + SX1262)
 *
 * Required Libraries (install via Arduino Library Manager):
 *   - Heltec ESP32 Dev-Boards (board package)
 *   - TinyGPS++ by Mikal Hart
 *   - Adafruit BMP3XX by Adafruit
 *   - Wire (built-in)
 *   - EEPROM (built-in)
 *   - LoRa (included with Heltec board package)
 *
 * Wiring:
 *   HC-SR04 TRIG → GPIO 33
 *   HC-SR04 ECHO → GPIO 34
 *   GPS TX → GPIO 46 (Serial1 RX)
 *   GPS RX → GPIO 45 (Serial1 TX)
 *   BMP390  → I2C (SDA=41, SCL=42 on Heltec V4)
 */

#include <Wire.h>
#include <EEPROM.h>
#include <esp_task_wdt.h>
#include <LoRa.h>
#include <SSD1306Wire.h>    // Heltec OLED
#include <TinyGPS++.h>
#include <Adafruit_BMP3XX.h>

// ── Pin Definitions ─────────────────────────────────────────
#define TRIG_PIN       33
#define ECHO_PIN       34
#define GPS_RX_PIN     46
#define GPS_TX_PIN     45
#define BATTERY_PIN    1     // ADC pin for LiPo voltage divider
#define VBAT_DIVIDER   2.0   // Voltage divider ratio

// ── LoRa Config (US 915 MHz) ────────────────────────────────
#define LORA_FREQ      915E6
#define LORA_BW        125E3
#define LORA_SF        7
#define LORA_TX_POWER  14

// ── Timing ──────────────────────────────────────────────────
#define NORMAL_INTERVAL_SEC    600    // 10 minutes
#define FLOOD_INTERVAL_SEC     30     // 30 seconds when flooding
#define GPS_TIMEOUT_MS         30000
#define FLOOD_THRESHOLD_CM     5

// ── EEPROM Addresses ────────────────────────────────────────
#define EEPROM_SIZE            64
#define ADDR_CALIBRATED        0   // byte: 0xAA if calibrated
#define ADDR_BASELINE          1   // int16: baseline distance cm

// ── Device Config ───────────────────────────────────────────
const char* DEVICE_ID = "FF-001";  // Change per device
const int MAILBOX_HEIGHT_CM = 95;

// ── Objects ─────────────────────────────────────────────────
SSD1306Wire display(0x3c, SDA_OLED, SCL_OLED);
TinyGPSPlus gps;
Adafruit_BMP3XX bmp;
HardwareSerial gpsSerial(1);

// ── State ───────────────────────────────────────────────────
int baselineDistanceCm = 0;
double lastLat = 0, lastLng = 0, lastAltGPS = 0;
bool gpsValid = false;
unsigned long gpsEpoch = 0;    // Unix timestamp from GPS
unsigned long gpsEpochMillis = 0; // millis() when epoch was captured

// ── Ultrasonic Reading ──────────────────────────────────────
int readUltrasonicCm() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);

  long duration = pulseIn(ECHO_PIN, HIGH, 30000); // 30ms timeout
  if (duration == 0) return -1;
  return (int)(duration * 0.0343 / 2.0);
}

// Take multiple readings, discard outliers, return average
int readUltrasonicAvg(int numReadings) {
  int readings[numReadings];
  int validCount = 0;

  for (int i = 0; i < numReadings; i++) {
    int r = readUltrasonicCm();
    if (r > 0 && r < 400) {
      readings[validCount++] = r;
    }
    delay(60); // HC-SR04 needs ~60ms between readings
  }

  if (validCount == 0) return -1;

  // Sort for median-based outlier rejection
  for (int i = 0; i < validCount - 1; i++)
    for (int j = i + 1; j < validCount; j++)
      if (readings[i] > readings[j]) {
        int tmp = readings[i];
        readings[i] = readings[j];
        readings[j] = tmp;
      }

  // Use middle 60% of readings
  int start = validCount / 5;
  int end = validCount - start;
  if (end <= start) { start = 0; end = validCount; }

  long sum = 0;
  for (int i = start; i < end; i++) sum += readings[i];
  return (int)(sum / (end - start));
}

// ── Battery Voltage ─────────────────────────────────────────
float readBatteryV() {
  // Average 4 readings for stability
  long sum = 0;
  for (int i = 0; i < 4; i++) {
    sum += analogRead(BATTERY_PIN);
    delay(5);
  }
  return (sum / 4.0 / 4095.0) * 3.3 * VBAT_DIVIDER;
}

// ── GPS ─────────────────────────────────────────────────────
bool updateGPS() {
  unsigned long start = millis();
  while (millis() - start < GPS_TIMEOUT_MS) {
    while (gpsSerial.available()) {
      gps.encode(gpsSerial.read());
    }
    if (gps.location.isUpdated() && gps.location.isValid()) {
      lastLat = gps.location.lat();
      lastLng = gps.location.lng();
      lastAltGPS = gps.altitude.meters();
      gpsValid = true;
      // Capture Unix epoch from GPS date/time
      if (gps.date.isValid() && gps.time.isValid()) {
        struct tm t;
        t.tm_year = gps.date.year() - 1900;
        t.tm_mon = gps.date.month() - 1;
        t.tm_mday = gps.date.day();
        t.tm_hour = gps.time.hour();
        t.tm_min = gps.time.minute();
        t.tm_sec = gps.time.second();
        gpsEpoch = (unsigned long)mktime(&t);
        gpsEpochMillis = millis();
      }
      return true;
    }
    delay(10);
  }
  return false; // Timeout — use last known
}

// ── Calibration (first boot) ────────────────────────────────
void calibrate() {
  display.clear();
  display.drawString(0, 0, "CALIBRATING...");
  display.drawString(0, 16, "Keep area clear!");
  display.display();

  // 20 readings over 10 seconds
  long sum = 0;
  int count = 0;
  for (int i = 0; i < 20; i++) {
    int r = readUltrasonicCm();
    if (r > 0 && r < 400) {
      sum += r;
      count++;
    }
    delay(500);
  }

  if (count > 0) {
    baselineDistanceCm = (int)(sum / count);
    EEPROM.write(ADDR_CALIBRATED, 0xAA);
    EEPROM.put(ADDR_BASELINE, (int16_t)baselineDistanceCm);
    EEPROM.commit();
  }

  display.clear();
  display.drawString(0, 0, "Baseline: " + String(baselineDistanceCm) + "cm");
  display.display();
  delay(2000);
}

// ── Send LoRa Packet ────────────────────────────────────────
void sendPacket(int distanceCm, float altBaro, float batteryV) {
  int floodDepth = max(0, MAILBOX_HEIGHT_CM - distanceCm);
  bool waterDetected = floodDepth > FLOOD_THRESHOLD_CM;

  // Build JSON
  String json = "{";
  json += "\"deviceId\":\"" + String(DEVICE_ID) + "\",";
  json += "\"lat\":" + String(lastLat, 6) + ",";
  json += "\"lng\":" + String(lastLng, 6) + ",";
  json += "\"altitudeGPS\":" + String(lastAltGPS, 1) + ",";
  json += "\"altitudeBaro\":" + String(altBaro, 2) + ",";
  json += "\"distanceCm\":" + String(distanceCm) + ",";
  json += "\"waterDetected\":" + String(waterDetected ? "true" : "false") + ",";
  json += "\"batteryV\":" + String(batteryV, 2) + ",";
  json += "\"rssi\":0,";
  // Use GPS-derived epoch if available, otherwise uptime
  unsigned long ts = gpsEpoch > 0
    ? gpsEpoch + ((millis() - gpsEpochMillis) / 1000)
    : millis() / 1000;
  json += "\"timestamp\":" + String(ts);
  json += "}";

  LoRa.beginPacket();
  LoRa.print(json);
  LoRa.endPacket();
}

// ── Display Status ──────────────────────────────────────────
void updateDisplay(int distanceCm, float batteryV, bool hasGPS) {
  int floodDepth = max(0, MAILBOX_HEIGHT_CM - distanceCm);

  display.clear();
  display.setFont(ArialMT_Plain_10);
  display.drawString(0, 0, String(DEVICE_ID));
  display.drawString(80, 0, batteryV > 3.5 ? "BAT OK" : "BAT LOW");

  display.setFont(ArialMT_Plain_16);
  if (floodDepth > FLOOD_THRESHOLD_CM) {
    display.drawString(0, 16, "FLOOD: " + String(floodDepth) + "cm");
  } else {
    display.drawString(0, 16, "Clear: " + String(distanceCm) + "cm");
  }

  display.setFont(ArialMT_Plain_10);
  display.drawString(0, 40, "GPS: " + String(hasGPS ? "Fix" : "No fix"));
  display.drawString(60, 40, String(batteryV, 1) + "V");

  display.display();
}

// ── Setup ───────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  EEPROM.begin(EEPROM_SIZE);

  // Watchdog timer — reboot if loop takes > 60 seconds
  esp_task_wdt_config_t wdt_config = {
    .timeout_ms = 60000,
    .idle_core_mask = 0,
    .trigger_panic = true,
  };
  esp_task_wdt_reconfigure(&wdt_config);
  esp_task_wdt_add(NULL);

  // OLED
  display.init();
  display.setFont(ArialMT_Plain_10);
  display.drawString(0, 0, "Flood Finder");
  display.drawString(0, 16, DEVICE_ID);
  display.display();

  // Ultrasonic
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);

  // GPS
  gpsSerial.begin(9600, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);

  // BMP390
  Wire.begin(SDA, SCL);
  if (!bmp.begin_I2C()) {
    Serial.println("BMP390 not found!");
  } else {
    bmp.setTemperatureOversampling(BMP3_OVERSAMPLING_8X);
    bmp.setPressureOversampling(BMP3_OVERSAMPLING_16X);
    bmp.setIIRFilterCoeff(BMP3_IIR_FILTER_COEFF_3);
    bmp.setOutputDataRate(BMP3_ODR_50_HZ);
  }

  // LoRa
  LoRa.setPins(SS, RST_LoRa, DIO0);
  if (!LoRa.begin(LORA_FREQ)) {
    Serial.println("LoRa init failed!");
    while (1);
  }
  LoRa.setSpreadingFactor(LORA_SF);
  LoRa.setSignalBandwidth(LORA_BW);
  LoRa.setTxPower(LORA_TX_POWER);

  // Calibration check
  if (EEPROM.read(ADDR_CALIBRATED) != 0xAA) {
    calibrate();
  } else {
    int16_t stored;
    EEPROM.get(ADDR_BASELINE, stored);
    baselineDistanceCm = stored;
    Serial.println("Loaded baseline: " + String(baselineDistanceCm) + "cm");
  }
}

// ── Main Loop ───────────────────────────────────────────────
void loop() {
  // Read sensors
  int distanceCm = readUltrasonicAvg(5);
  if (distanceCm < 0) distanceCm = baselineDistanceCm; // Fallback

  float altBaro = 0;
  if (bmp.performReading()) {
    altBaro = bmp.readAltitude(1013.25); // Sea level pressure
  }

  bool gotGPS = updateGPS();
  float batteryV = readBatteryV();

  // Display
  updateDisplay(distanceCm, batteryV, gotGPS || gpsValid);

  // Send
  sendPacket(distanceCm, altBaro, batteryV);
  Serial.println("Sent: dist=" + String(distanceCm) + "cm batt=" + String(batteryV) + "V");

  // Determine sleep duration
  int floodDepth = max(0, MAILBOX_HEIGHT_CM - distanceCm);
  int sleepSec = floodDepth > FLOOD_THRESHOLD_CM ? FLOOD_INTERVAL_SEC : NORMAL_INTERVAL_SEC;

  // Deep sleep
  esp_sleep_enable_timer_wakeup((uint64_t)sleepSec * 1000000ULL);
  esp_deep_sleep_start();
}
