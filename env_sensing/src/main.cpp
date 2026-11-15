// ESP32 fridge/freezer temperature logger.
// Reads a temperature sensor, timestamps each reading with NTP time, logs it to
// Serial, and POSTs it as JSON to the FastAPI server (api/main.py -> POST /readings).
// Readings that fail to send are kept in a small queue and retried later.
//
// Three FreeRTOS tasks keep the LEDs in step with the website:
//   ledTask      - redraws the LEDs every 10 ms (never blocks)
//   checkinTask  - checks in with the API every 250 ms (locate, history reset,
//                  thresholds), so dashboard actions reach the LEDs in well under a second
//   loop()       - samples the sensor every 2 s and uploads readings; a reading
//                  that crosses into or out of the danger zone is uploaded at once
//   displayTask  - redraws the OLED every 250 ms (item, employee, days until spoiled)
// None of them waits on another, so a slow upload or sensor retry can't delay
// a Locate/Stop click or a color change.

#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <time.h>
#include <DHT.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

// Wi-Fi credentials live in include/secrets.h (git-ignored).
// Copy include/secrets.example.h to include/secrets.h and fill it in.
#if __has_include("secrets.h")
#include "secrets.h"
#else
#error "Missing include/secrets.h: copy include/secrets.example.h to include/secrets.h and set your Wi-Fi details."
#endif

// ---------------- Configuration (edit these) ----------------
const char *WIFI_SSID = WIFI_SSID_VALUE;
const char *WIFI_PASSWORD = WIFI_PASSWORD_VALUE;

// LAN address of the computer running the API (no trailing slash). Start it with:
//   uvicorn main:app --host 0.0.0.0 --port 8000
const char *API_BASE = API_BASE_VALUE;

const int APPLIANCE_ID = 1;                     // must exist in the appliances table
const unsigned long SAMPLE_INTERVAL_MS = 2000;  // how often the sensor is read (DHT11 minimum ~1 s)
const unsigned long UPLOAD_INTERVAL_MS = 30000; // regular upload; zone changes upload immediately

// "Find my device" / reset / thresholds: the ESP32 checks in this often
// (POST /devices/{id}/checkin, connection kept open so each one is cheap).
const unsigned long CHECKIN_INTERVAL_MS = 250;
const unsigned long LOCATE_BLINK_MS = 100; // all three LEDs: 100 ms on, 100 ms off

// Sensor: DHT11. Wiring:
//   VCC  -> 3.3V
//   DATA -> GPIO 4 (needs a 10k pull-up to 3.3V; 3-pin breakout boards already have one)
//   GND  -> GND
// Don't use GPIO 34-39: they are input-only and the DHT11 data line is bidirectional.
// The DHT11 measures 0-50 °C (±2 °C), so it suits a fridge but not a freezer.
const int DHT_PIN = 4;
DHT dht(DHT_PIN, DHT11);

const char *NTP_SERVER = "pool.ntp.org";

// Status LEDs (each: GPIO -> 220-330 ohm resistor -> LED anode, cathode -> GND).
// Exactly one LED flashes at a time, using the same rule as the website:
//   green  = temperature is outside the danger zone
//   yellow = in the danger zone (min..max, inclusive) for less than the spoil time
//   red    = in the danger zone continuously for at least the spoil time
const int LED_RED_PIN = 25;
const int LED_YELLOW_PIN = 26;
const int LED_GREEN_PIN = 27;
const unsigned long LED_BLINK_MS = 500; // on/off half-period

// OLED: 0.96" 128x64 SSD1306 on I2C. Wiring:
//   VCC -> 3.3V, GND -> GND, SDA -> GPIO 21, SCL -> GPIO 22
// Most of these modules are at address 0x3C; a few are 0x3D (see the address
// jumper/resistor on the back). Shows the newest item in this fridge (set on
// the dashboard), who logged it and how many days until it spoils.
const int OLED_SDA_PIN = 21;
const int OLED_SCL_PIN = 22;
const uint8_t OLED_ADDRESS = 0x3C;
const int OLED_WIDTH = 128;
const int OLED_HEIGHT = 64;
const unsigned long DISPLAY_REFRESH_MS = 250;
Adafruit_SSD1306 oled(OLED_WIDTH, OLED_HEIGHT, &Wire, -1);

// Danger zone and spoil time. These are only the defaults (same as
// public/src/config.js); the real values (edited on the Admin page) arrive
// with every check-in reply.
float dangerMinC = 4.0;
float dangerMaxC = 50.0;
unsigned long dangerAlertMs = 2UL * 60UL * 1000UL; // 2 minutes
// -------------------------------------------------------------

// Guards the danger-zone state below, which all three tasks touch.
portMUX_TYPE stateMux = portMUX_INITIALIZER_UNLOCKED;
bool haveReading = false;       // no LED lit until the first good reading
float lastTempC = NAN;          // latest good sensor value
bool inDangerZone = false;
unsigned long dangerStartMs = 0; // millis() when the current danger stretch began

// "Find my device" state, written only by checkinTask.
volatile bool locating = false;
volatile unsigned long locateEndMs = 0; // millis() when locating should stop

// Set by checkinTask, handled by loop().
volatile bool historyResetRequested = false;

// What the OLED shows, written by checkinTask and read by displayTask (guarded by displayMux).
struct DisplayInfo {
  bool known = false;     // false until the first successful check-in
  char item[81] = "";     // "" = no item in this fridge
  char employee[81] = "";
  bool hasSpoil = false;  // false = item has no USDA fridge storage time
  int64_t spoilAtMs = 0;  // nowMs() when the item spoils
};
portMUX_TYPE displayMux = portMUX_INITIALIZER_UNLOCKED;
DisplayInfo displayInfo;

// 64-bit milliseconds since boot: spoil times can be months away, past
// where 32-bit millis() would wrap.
int64_t nowMs() { return esp_timer_get_time() / 1000; }

// Signed difference handles millis() wrapping around after ~49 days.
bool locateActive() {
  return locating && (long)(locateEndMs - millis()) > 0;
}

// Re-test the last temperature against the current thresholds (same test as
// isInDangerZone() in public/src/lib/safety.js, inclusive bounds). Starts the
// danger timer on entry. Call with stateMux held. Returns true if the zone changed.
bool evaluateDangerLocked() {
  bool danger = haveReading && lastTempC >= dangerMinC && lastTempC <= dangerMaxC;
  bool changed = danger != inDangerZone;
  if (danger && !inDangerZone) dangerStartMs = millis();
  inDangerZone = danger;
  return changed;
}

// ---------------- LEDs ----------------

enum LedMode { LED_NONE, LED_GREEN, LED_YELLOW, LED_RED, LED_LOCATE };

LedMode currentLedMode() {
  if (locateActive()) return LED_LOCATE;
  LedMode m = LED_NONE;
  portENTER_CRITICAL(&stateMux);
  if (haveReading) {
    if (!inDangerZone) m = LED_GREEN;
    else if (millis() - dangerStartMs >= dangerAlertMs) m = LED_RED;
    else m = LED_YELLOW;
  }
  portEXIT_CRITICAL(&stateMux);
  return m;
}

// Redraws every 10 ms. When the mode changes (zone entered, red reached, timer
// reset, locate started or stopped) the blink restarts in its "on" phase, so
// the new color lights up at once instead of after an off half-period.
void ledTask(void *) {
  LedMode shown = LED_NONE;
  unsigned long phaseStart = millis();
  for (;;) {
    LedMode m = currentLedMode();
    if (m != shown) {
      shown = m;
      phaseStart = millis();
    }
    unsigned long half = m == LED_LOCATE ? LOCATE_BLINK_MS : LED_BLINK_MS;
    bool on = ((millis() - phaseStart) / half) % 2 == 0;
    digitalWrite(LED_GREEN_PIN, on && (m == LED_GREEN || m == LED_LOCATE));
    digitalWrite(LED_YELLOW_PIN, on && (m == LED_YELLOW || m == LED_LOCATE));
    digitalWrite(LED_RED_PIN, on && (m == LED_RED || m == LED_LOCATE));
    vTaskDelay(pdMS_TO_TICKS(10));
  }
}

// ---------------- Check-ins ----------------

// Pull a number out of a flat JSON reply (no JSON library needed).
bool jsonNumber(const String &json, const char *key, double &out) {
  String needle = String("\"") + key + "\":";
  int at = json.indexOf(needle);
  if (at < 0) return false;
  out = json.substring(at + needle.length()).toDouble();
  return true;
}

// Pull a string out of a flat JSON reply into `out` (truncated to fit).
// Handles \" \\ \/ escapes; any \uXXXX becomes '?' (the API already sends ASCII).
bool jsonString(const String &json, const char *key, char *out, size_t len) {
  String needle = String("\"") + key + "\":\"";
  int at = json.indexOf(needle);
  if (at < 0) return false;
  size_t n = 0;
  for (int i = at + needle.length(); i < (int)json.length(); i++) {
    char c = json[i];
    if (c == '"') break;
    if (c == '\\' && i + 1 < (int)json.length()) {
      char e = json[++i];
      if (e == 'u') { c = '?'; i += 4; }
      else if (e == 'n' || e == 't' || e == 'r') c = ' ';
      else c = e;
    }
    if (n + 1 < len) out[n++] = c;
  }
  out[n] = '\0';
  return true;
}

// Item, employee and spoil time for the OLED from a check-in reply:
//   "display_item":"Raw beef - chops", "display_employee":"Sam",
//   "display_spoil_in_s":259200   (null = no storage time, negative = spoiled)
// The countdown then runs on the ESP32's own clock between check-ins (and
// keeps running if the API goes away).
void applyDisplay(const String &resp) {
  DisplayInfo next;
  next.known = true;
  if (!jsonString(resp, "display_item", next.item, sizeof(next.item))) return; // older API
  jsonString(resp, "display_employee", next.employee, sizeof(next.employee));
  double secs = 0;
  int at = resp.indexOf("\"display_spoil_in_s\":");
  next.hasSpoil = at >= 0 && resp[at + 21] != 'n' && jsonNumber(resp, "display_spoil_in_s", secs);
  if (next.hasSpoil) next.spoilAtMs = nowMs() + (int64_t)(secs * 1000.0);

  bool changed;
  portENTER_CRITICAL(&displayMux);
  changed = strcmp(next.item, displayInfo.item) != 0 || strcmp(next.employee, displayInfo.employee) != 0 ||
            next.hasSpoil != displayInfo.hasSpoil || !displayInfo.known;
  // Network delay shifts each estimate a little; only move the deadline for a
  // real change (e.g. the item was removed and added again) so the seconds
  // don't jitter.
  if (changed || llabs(next.spoilAtMs - displayInfo.spoilAtMs) > 2000) {
    displayInfo = next;
    changed = true;
  }
  portEXIT_CRITICAL(&displayMux);
  if (changed) {
    if (next.item[0] == '\0') Serial.println("Display: no item");
    else if (next.hasSpoil)
      Serial.printf("Display: \"%s\" by %s, spoils in %.1f days\n", next.item, next.employee, secs / 86400.0);
    else Serial.printf("Display: \"%s\" by %s, no storage time\n", next.item, next.employee);
  }
}

// Use the shared danger zone and spoil time from a check-in reply. If they're
// missing or invalid, the last values seen stay in use (like the website does).
// A change re-tests the last temperature right away, so the LED follows an
// Admin-page edit without waiting for the next sensor sample.
void applyThresholds(const String &resp) {
  double lo, hi, secs;
  if (!jsonNumber(resp, "danger_min_c", lo) || !jsonNumber(resp, "danger_max_c", hi) ||
      !jsonNumber(resp, "spoil_after_seconds", secs) || lo >= hi || secs <= 0) {
    return;
  }
  unsigned long ms = (unsigned long)(secs * 1000.0);
  bool changed = false;
  portENTER_CRITICAL(&stateMux);
  if ((float)lo != dangerMinC || (float)hi != dangerMaxC || ms != dangerAlertMs) {
    changed = true;
    dangerMinC = lo;
    dangerMaxC = hi;
    dangerAlertMs = ms;
    evaluateDangerLocked();
  }
  portEXIT_CRITICAL(&stateMux);
  if (changed) Serial.printf("Thresholds from API: danger zone %.1f-%.1f C, red after %lu s\n", lo, hi, ms / 1000);
}

// Tell the API we're alive (with IP and Wi-Fi signal for the Locate page) and
// find out whether the dashboard wants us to flash our LEDs.
// Reply: {"locate": true|false, "locate_remaining_ms": N, "history_reset": true|false,
//         "danger_min_c": 4.0, "danger_max_c": 50.0, "spoil_after_seconds": 120}
// Returns false if the API couldn't be reached.
bool checkIn(HTTPClient &http) {
  if (WiFi.status() != WL_CONNECTED) return false;

  char url[128];
  snprintf(url, sizeof(url), "%s/devices/%d/checkin", API_BASE, APPLIANCE_ID);
  char body[96];
  snprintf(body, sizeof(body), "{\"ip\":\"%s\",\"rssi\":%d}",
           WiFi.localIP().toString().c_str(), (int)WiFi.RSSI());

  http.setReuse(true);
  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  http.setConnectTimeout(1000);
  http.setTimeout(1500);
  int code = http.POST((uint8_t *)body, strlen(body));
  String resp = code == 200 ? http.getString() : "";
  http.end(); // keeps the connection open for the next check-in
  if (code != 200) return false;

  applyThresholds(resp);
  applyDisplay(resp);

  // Temperature history erased on the Admin page: restart the danger-zone
  // timer now, so the LED shows yellow (or green, if outside the zone) at
  // once, like the website does; loop() then uploads a fresh reading.
  if (resp.indexOf("\"history_reset\":true") >= 0) {
    portENTER_CRITICAL(&stateMux);
    dangerStartMs = millis();
    portEXIT_CRITICAL(&stateMux);
    historyResetRequested = true;
    Serial.println("History reset from the dashboard: danger-zone timer restarted");
  }

  bool wantLocate = resp.indexOf("\"locate\":true") >= 0;
  long remaining = 0;
  int at = resp.indexOf("\"locate_remaining_ms\":");
  if (at >= 0) remaining = resp.substring(at + 22).toInt();

  if (wantLocate && remaining > 0) {
    if (!locateActive()) Serial.printf("Find my device: flashing all LEDs for %ld s\n", remaining / 1000);
    locateEndMs = millis() + (unsigned long)remaining; // set before the flag the LED task reads
    locating = true;
  } else if (locating) {
    // Stopped from the dashboard (or expired): the LED task goes straight back
    // to the current green/yellow/red on its next 10 ms redraw.
    locating = false;
    Serial.println("Locate stopped, back to normal LEDs");
  }
  return true;
}

void checkinTask(void *) {
  HTTPClient http; // one client with keep-alive, reused for every check-in
  unsigned long backoffMs = 0;
  for (;;) {
    unsigned long started = millis();
    if (checkIn(http)) {
      backoffMs = 0;
    } else if (WiFi.status() == WL_CONNECTED) {
      // API down or old API without /checkin: keep current state, retry a bit slower.
      if (backoffMs == 0) Serial.printf("Check-in failed, is the API reachable at %s?\n", API_BASE);
      backoffMs = min(backoffMs + 500UL, 3000UL);
    }
    if (locating && !locateActive()) {
      locating = false; // expired on its own (e.g. API unreachable)
      Serial.println("Locate finished, back to normal LEDs");
    }
    unsigned long elapsed = millis() - started;
    unsigned long wait = CHECKIN_INTERVAL_MS + backoffMs;
    vTaskDelay(pdMS_TO_TICKS(elapsed < wait ? wait - elapsed : 10));
  }
}

// ---------------- OLED ----------------

// Print `text` horizontally centered at row y.
void printCentered(const char *text, int y, uint8_t size) {
  int16_t x1, y1;
  uint16_t w, h;
  oled.setTextSize(size);
  oled.getTextBounds(text, 0, 0, &x1, &y1, &w, &h);
  oled.setCursor(max(0, (OLED_WIDTH - (int)w) / 2), y);
  oled.print(text);
}

// Layout (size-1 text is 6x8 px, 21 characters per line):
//   rows  0-15  item name (up to two lines)
//   rows 19-34  days left, large ("3 DAYS" / "SPOILED")
//   rows 38-45  exact time left, e.g. "2d 13:05:22 left"
//   rows 56-63  employee who logged it
void drawDisplay(const DisplayInfo &d) {
  oled.clearDisplay();
  oled.setTextColor(SSD1306_WHITE);
  oled.setTextWrap(false);

  if (!d.known) {
    printCentered("Fridge monitor", 12, 1);
    printCentered(WiFi.status() == WL_CONNECTED ? "Contacting API..." : "Connecting Wi-Fi...", 36, 1);
  } else if (d.item[0] == '\0') {
    printCentered("No item", 14, 2);
    printCentered("Add one on the", 40, 1);
    printCentered("dashboard", 50, 1);
  } else {
    // Item name: two lines of 21 characters, "..." if it's longer.
    char line[22];
    size_t len = strlen(d.item);
    oled.setTextSize(1);
    strncpy(line, d.item, 21);
    line[21] = '\0';
    oled.setCursor(0, 0);
    oled.print(line);
    if (len > 21) {
      strncpy(line, d.item + 21, 21);
      line[21] = '\0';
      if (len > 42) strcpy(line + 18, "...");
      oled.setCursor(0, 8);
      oled.print(line);
    }

    char big[16], small[24];
    if (!d.hasSpoil) {
      strcpy(big, "-- DAYS");
      strcpy(small, "No USDA fridge time");
    } else {
      int64_t left = d.spoilAtMs - nowMs();
      if (left <= 0) {
        strcpy(big, "SPOILED");
        strcpy(small, "Throw it out");
      } else {
        long secs = (long)((left + 999) / 1000);
        long days = (secs + 86399) / 86400; // whole days, rounded up
        snprintf(big, sizeof(big), "%ld DAY%s", days, days == 1 ? "" : "S");
        snprintf(small, sizeof(small), "%ldd %02ld:%02ld:%02ld left", secs / 86400, (secs / 3600) % 24,
                 (secs / 60) % 60, secs % 60);
      }
    }
    printCentered(big, 19, 2);
    printCentered(small, 38, 1);

    oled.drawFastHLine(0, 51, OLED_WIDTH, SSD1306_WHITE);
    snprintf(line, sizeof(line), "By %s", d.employee[0] ? d.employee : "-");
    oled.setTextSize(1);
    oled.setCursor(0, 56);
    oled.print(line);
  }
  oled.display();
}

// Same priority as loop() and below ledTask, so I2C transfers never hold up the LEDs.
void displayTask(void *) {
  for (;;) {
    DisplayInfo d;
    portENTER_CRITICAL(&displayMux);
    d = displayInfo;
    portEXIT_CRITICAL(&displayMux);
    drawDisplay(d);
    vTaskDelay(pdMS_TO_TICKS(DISPLAY_REFRESH_MS));
  }
}

// ---------------- Readings ----------------

struct Reading {
  time_t timestamp; // Unix time (UTC)
  float temperatureC;
};

// Ring buffer of readings not yet accepted by the API (only touched by loop()).
const int QUEUE_SIZE = 50;
Reading queue[QUEUE_SIZE];
int queueHead = 0; // index of oldest reading
int queueCount = 0;

unsigned long lastSampleMs = 0;
unsigned long lastUploadMs = 0;
unsigned long lastWifiAttemptMs = 0;

float readTemperatureC() {
  // The DHT11 occasionally returns a bad read; retry a few times
  // (it needs at least ~1 s between reads).
  for (int attempt = 0; attempt < 3; attempt++) {
    // force=true: otherwise the library returns its cached (failed) result for
    // any call within 2 s of the last read, so the retries never touch the sensor.
    float t = dht.readTemperature(false, true); // °C
    if (!isnan(t)) return t;
    delay(1100); // LEDs and check-ins carry on in their own tasks
  }
  return NAN;
}

void formatIso8601(time_t ts, char *out, size_t len) {
  struct tm t;
  gmtime_r(&ts, &t);
  strftime(out, len, "%Y-%m-%dT%H:%M:%SZ", &t);
}

void enqueue(const Reading &r) {
  if (queueCount == QUEUE_SIZE) { // full: drop the oldest
    queueHead = (queueHead + 1) % QUEUE_SIZE;
    queueCount--;
    Serial.println("Queue full, dropped oldest reading");
  }
  queue[(queueHead + queueCount) % QUEUE_SIZE] = r;
  queueCount++;
}

// Returns true if the API accepted the reading (or permanently rejected it,
// so retrying would be pointless).
bool sendReading(const Reading &r) {
  char ts[25];
  formatIso8601(r.timestamp, ts, sizeof(ts));

  char body[160];
  snprintf(body, sizeof(body),
           "{\"appliance_id\":%d,\"temperature_c\":%.2f,\"recorded_at\":\"%s\"}",
           APPLIANCE_ID, r.temperatureC, ts);

  HTTPClient http;
  http.begin(String(API_BASE) + "/readings");
  http.addHeader("Content-Type", "application/json");
  http.setConnectTimeout(2000); // fail fast when the API's computer is unreachable
  http.setTimeout(5000);
  int code = http.POST((uint8_t *)body, strlen(body));
  String resp = code > 0 ? http.getString() : http.errorToString(code);
  http.end();

  Serial.printf("POST %s -> %d %s\n", body, code, resp.c_str());
  if (code >= 200 && code < 300) return true;
  if (code >= 400 && code < 500) {
    Serial.println("API rejected reading (check APPLIANCE_ID), discarding it");
    return true;
  }
  return false; // network error or 5xx: keep it and retry later
}

void flushQueue() {
  if (WiFi.status() != WL_CONNECTED) return;
  while (queueCount > 0) {
    if (!sendReading(queue[queueHead])) break;
    queueHead = (queueHead + 1) % QUEUE_SIZE;
    queueCount--;
  }
  if (queueCount > 0) Serial.printf("%d reading(s) waiting to be sent\n", queueCount);
}

// ---------------- Setup / loop ----------------

void connectWiFiBlocking() {
  Serial.printf("Connecting to WiFi \"%s\"", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  lastWifiAttemptMs = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - lastWifiAttemptMs < 15000) {
    delay(500);
    Serial.print(".");
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\nWiFi connected, IP: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("\nWiFi connection failed, will keep retrying in the background");
  }
}

void setup() {
  Serial.begin(115200);
  delay(500);

  pinMode(LED_RED_PIN, OUTPUT);
  pinMode(LED_YELLOW_PIN, OUTPUT);
  pinMode(LED_GREEN_PIN, OUTPUT);
  // All off until the first reading. Priority 2 (above loop()'s 1) on the
  // loop's core, so blocking network calls can't hold the LEDs up.
  xTaskCreatePinnedToCore(ledTask, "leds", 2048, nullptr, 2, nullptr, 1);

  // OLED stays on for as long as the device is powered.
  Wire.begin(OLED_SDA_PIN, OLED_SCL_PIN);
  Wire.setClock(400000);
  if (oled.begin(SSD1306_SWITCHCAPVCC, OLED_ADDRESS)) {
    xTaskCreatePinnedToCore(displayTask, "oled", 4096, nullptr, 1, nullptr, 1);
  } else {
    Serial.printf("OLED not found at 0x%02X (check SDA=GPIO %d, SCL=GPIO %d, or try 0x3D)\n", OLED_ADDRESS,
                  OLED_SDA_PIN, OLED_SCL_PIN);
  }

  // Wiring check: weakly pull the pin LOW with the ESP32's internal pull-down
  // (~45k). A powered sensor's 10k pull-up is stronger, so the line still reads
  // HIGH; with nothing connected (or no power) it reads LOW instead of floating.
  // dht.begin()/read() switch the pin back to INPUT_PULLUP, so this only affects the check.
  pinMode(DHT_PIN, INPUT_PULLDOWN);
  delay(10);
  int idle = digitalRead(DHT_PIN);
  Serial.printf("DHT data line (GPIO %d) idle level: %s\n", DHT_PIN,
                idle ? "HIGH (ok: pull-up detected, sensor connected and powered)"
                     : "LOW -> no pull-up seen: check DATA is on this pin, VCC/GND, and the 10k pull-up");

  dht.begin();
  delay(2000); // DHT11 needs ~1-2 s after power-up before the first read

  connectWiFiBlocking();
  // SNTP keeps syncing in the background; nothing below waits for it.
  configTime(0, 0, NTP_SERVER); // keep everything in UTC

  // Check-ins on core 0 (beside the Wi-Fi stack), independent of loop().
  xTaskCreatePinnedToCore(checkinTask, "checkin", 6144, nullptr, 1, nullptr, 0);

  lastSampleMs = millis() - SAMPLE_INTERVAL_MS; // first sample immediately
  lastUploadMs = millis() - UPLOAD_INTERVAL_MS; // and upload it
}

void loop() {
  // Non-blocking reconnect: the sensor keeps being sampled (and the LEDs kept
  // current) while Wi-Fi is down.
  if (WiFi.status() != WL_CONNECTED && millis() - lastWifiAttemptMs > 10000) {
    lastWifiAttemptMs = millis();
    Serial.println("WiFi down, reconnecting");
    WiFi.reconnect();
  }

  bool resetNow = historyResetRequested;
  if (resetNow) {
    historyResetRequested = false;
    queueHead = 0; // drop unsent readings from before the reset
    queueCount = 0;
    lastSampleMs = millis() - SAMPLE_INTERVAL_MS; // fresh sample + upload right away
  }

  if (millis() - lastSampleMs < SAMPLE_INTERVAL_MS) {
    delay(10);
    return;
  }
  lastSampleMs = millis();

  float tempC = readTemperatureC();
  if (isnan(tempC)) {
    Serial.println("Sensor read failed (check wiring)");
    return;
  }

  portENTER_CRITICAL(&stateMux);
  lastTempC = tempC;
  haveReading = true;
  bool zoneChanged = evaluateDangerLocked();
  bool danger = inDangerZone;
  unsigned long inZoneMs = millis() - dangerStartMs;
  portEXIT_CRITICAL(&stateMux);

  // Upload on schedule, and immediately when the zone changes or after a
  // reset, so the website switches color at the same moment as the LEDs.
  if (zoneChanged || resetNow || millis() - lastUploadMs >= UPLOAD_INTERVAL_MS) {
    lastUploadMs = millis();
    Reading r = {time(nullptr), tempC};
    char ts[25];
    formatIso8601(r.timestamp, ts, sizeof(ts));
    Serial.printf("[%s] Temperature: %.2f C%s\n", ts, tempC,
                  zoneChanged ? (danger ? " (entered danger zone)" : " (left danger zone)") : "");
    if (danger) {
      Serial.printf("In danger zone (%.1f-%.1f C) for %lu s of %lu s\n", dangerMinC, dangerMaxC,
                    inZoneMs / 1000, dangerAlertMs / 1000);
    }
    enqueue(r);
    flushQueue();
  }
}
