// ESP32 fridge/freezer temperature logger.
// Reads a temperature sensor, timestamps each reading with NTP time, logs it to
// Serial, and POSTs it as JSON to the FastAPI server (api/main.py -> POST /readings).
// Readings that fail to send are kept in a small queue and retried later.
//
// Three FreeRTOS tasks keep the LEDs in step with the website:
//   ledTask      - redraws the LEDs every 10 ms (never blocks)
//   checkinTask  - checks in with the API every 250 ms (locate, history reset,
//                  thresholds), so dashboard actions reach the LEDs in well under a second
//   loop()       - samples the sensor every 1 s and uploads a reading as soon as
//                  the temperature changes (plus every 30 s as a heartbeat)
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
#include <Adafruit_SH110X.h>

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
const unsigned long SAMPLE_INTERVAL_MS = 1000;  // how often the sensor is read (DHT11 minimum ~1 s)
const unsigned long UPLOAD_INTERVAL_MS = 30000; // heartbeat upload; any temperature change uploads immediately

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

// OLED: 1.3" 128x64 SH1106 on I2C (Adafruit SH110X library). Wiring:
//   VCC -> 3.3V, GND -> GND, SDA -> GPIO 21, SCL -> GPIO 22
// Most of these modules are at address 0x3C; a few are 0x3D (see the address
// jumper/resistor on the back). Shows the newest item in this fridge (set on
// the dashboard), who logged it and how many days until it spoils.
const int OLED_SDA_PIN = 21;
const int OLED_SCL_PIN = 22;
const uint8_t OLED_ADDRESS = 0x3C; // tried first; 0x3D is tried too if nothing answers here
const int OLED_WIDTH = 128;
const int OLED_HEIGHT = 64;
const unsigned long DISPLAY_REFRESH_MS = 250;
const unsigned long OLED_CHECK_MS = 5000; // how often to check the OLED still answers (and retry if not)
Adafruit_SH1106G oled(OLED_WIDTH, OLED_HEIGHT, &Wire, -1);
uint8_t oledAddress = OLED_ADDRESS; // address actually in use
bool oledReady = false;             // only touched by setup() and then displayTask

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
  // Food safety (same rules as itemStatus() in public/src/lib/safety.js):
  //   spoiled -> its total danger-zone time reached the spoil time; sticks
  //              even after the fridge cools down, until the item changes
  //   danger  -> not spoiled and the fridge is in the danger zone right now
  //   safe    -> otherwise (danger-zone time so far still counts later)
  char itemId[65] = "";   // tells a re-added item with the same name from the old one
  bool spoiled = false;
  int64_t exposureMs = 0; // danger-zone time so far; counted here while in the zone
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
  jsonString(resp, "display_item_id", next.itemId, sizeof(next.itemId));
  next.spoiled = resp.indexOf("\"display_spoiled\":true") >= 0;
  double exp = 0;
  if (jsonNumber(resp, "display_exposure_ms", exp) && exp > 0) next.exposureMs = (int64_t)exp;

  bool changed;
  bool becameSpoiled = false;
  portENTER_CRITICAL(&displayMux);
  bool sameItem = displayInfo.known && strcmp(next.item, displayInfo.item) == 0 &&
                  strcmp(next.itemId, displayInfo.itemId) == 0;
  if (sameItem) {
    // Same item: spoiled never goes back, and this device's own exposure count
    // is usually ahead of the dashboard's last update, so keep the larger one.
    // (An erased history arrives as 0 and is applied in checkIn().)
    becameSpoiled = next.spoiled && !displayInfo.spoiled;
    next.spoiled = next.spoiled || displayInfo.spoiled;
    next.exposureMs = max(next.exposureMs, displayInfo.exposureMs);
  }
  changed = !sameItem || strcmp(next.employee, displayInfo.employee) != 0 || next.hasSpoil != displayInfo.hasSpoil;
  // Network delay shifts each estimate a little; only move the deadline for a
  // real change (e.g. the item was removed and added again) so the seconds
  // don't jitter.
  if (!changed && llabs(next.spoilAtMs - displayInfo.spoilAtMs) <= 2000) next.spoilAtMs = displayInfo.spoilAtMs;
  else changed = true;
  displayInfo = next;
  portEXIT_CRITICAL(&displayMux);
  if (becameSpoiled) Serial.printf("Display: \"%s\" marked spoiled by the dashboard\n", next.item);
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
    // The erased readings were the item's danger-zone time as well (a spoiled
    // item stays spoiled, like on the website).
    portENTER_CRITICAL(&displayMux);
    displayInfo.exposureMs = 0;
    portEXIT_CRITICAL(&displayMux);
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

// Battery level shown in the corner, 0-100. Placeholder until battery
// monitoring is added: replace the body with a real reading (e.g. an ADC
// voltage divider on the battery) and the icon follows it.
const int BATTERY_PLACEHOLDER_PERCENT = 100;
int batteryPercent() { return BATTERY_PLACEHOLDER_PERCENT; }

// Battery icon (16x8 body + 2 px terminal) with a fill meter and "NN%" to its
// left, in the bottom-right corner (rows 56-63, x 92-127).
const int BATTERY_AREA_X = 92; // text to the left must end before this
void drawBattery(int percent) {
  percent = constrain(percent, 0, 100);
  const int bx = 109, by = 56, bw = 16, bh = 8;
  oled.drawRect(bx, by, bw, bh, SH110X_WHITE);             // body
  oled.fillRect(bx + bw, by + 2, 2, bh - 4, SH110X_WHITE); // terminal
  int fill = (bw - 4) * percent / 100;                      // meter, 1 px gap inside the outline
  if (fill > 0) oled.fillRect(bx + 2, by + 2, fill, bh - 4, SH110X_WHITE);

  char pct[6];
  snprintf(pct, sizeof(pct), "%d%%", percent);
  oled.setTextSize(1);
  oled.setCursor(bx - 2 - 6 * (int)strlen(pct), by);
  oled.print(pct);
}

// Layout (size-1 text is 6x8 px, 21 characters per line):
//   rows  3-18  item name (up to two lines; lowered 3 px because the
//               SH1106 panel crops its top rows)
//   rows 19-34  days left, large ("3 DAYS"), or "SPOILED" once it has spoiled
//   rows 37-46  status tag + exact time left: "[DANGER] 2d 13:05:22" (inverted
//               tag while the fridge is in the danger zone) or "SAFE 2d 13:05:22";
//               once spoiled, why ("Unsafe temp too long" / "Past storage time")
//   rows 56-63  employee who logged it (left), battery (right)
// The days-left countdown comes from the USDA storage time and keeps running
// through danger spells: only spoiling replaces it.
const int ITEM_TOP_Y = 3; // raise/lower the item name here

// "SAFE" or an inverted "DANGER" tag followed by `text`, centered at row y.
void drawStatusLine(bool danger, const char *text, int y) {
  const char *tag = danger ? "DANGER" : "SAFE";
  int tagW = 6 * (int)strlen(tag) + 4;
  int totalW = tagW + 4 + 6 * (int)strlen(text);
  int x = max(0, (OLED_WIDTH - totalW) / 2);
  oled.setTextSize(1);
  if (danger) {
    oled.fillRect(x, y - 1, tagW, 10, SH110X_WHITE);
    oled.setTextColor(SH110X_BLACK);
  }
  oled.setCursor(x + 2, y + 1);
  oled.print(tag);
  oled.setTextColor(SH110X_WHITE);
  oled.setCursor(x + tagW + 4, y + 1);
  oled.print(text);
}

void drawDisplay(const DisplayInfo &d, bool inZone) {
  oled.clearDisplay();
  oled.setTextColor(SH110X_WHITE);
  oled.setTextWrap(false);

  if (!d.known) {
    printCentered("Fridge monitor", 12, 1);
    printCentered(WiFi.status() == WL_CONNECTED ? "Contacting API..." : "Connecting Wi-Fi...", 32, 1);
  } else if (d.item[0] == '\0') {
    printCentered("No item", 10, 2);
    printCentered("Add one on the", 32, 1);
    printCentered("dashboard", 42, 1);
  } else {
    // Item name: two lines of 21 characters, "..." if it's longer.
    char line[22];
    size_t len = strlen(d.item);
    oled.setTextSize(1);
    strncpy(line, d.item, 21);
    line[21] = '\0';
    oled.setCursor(0, ITEM_TOP_Y);
    oled.print(line);
    if (len > 21) {
      strncpy(line, d.item + 21, 21);
      line[21] = '\0';
      if (len > 42) strcpy(line + 18, "...");
      oled.setCursor(0, ITEM_TOP_Y + 8);
      oled.print(line);
    }

    int64_t left = d.hasSpoil ? d.spoilAtMs - nowMs() : 1;
    if (d.spoiled) {
      // Spent the spoil time in the danger zone: stays spoiled even if the fridge cools down.
      printCentered("SPOILED", 19, 2);
      printCentered("Unsafe temp too long", 38, 1);
    } else if (left <= 0) {
      printCentered("SPOILED", 19, 2);
      printCentered("Past storage time", 38, 1);
    } else if (!d.hasSpoil) {
      printCentered("-- DAYS", 19, 2);
      drawStatusLine(inZone, "no USDA time", 37);
    } else {
      char big[16], small[24];
      long secs = (long)((left + 999) / 1000);
      long days = (secs + 86399) / 86400; // whole days, rounded up
      snprintf(big, sizeof(big), "%ld DAY%s", days, days == 1 ? "" : "S");
      snprintf(small, sizeof(small), "%ldd %02ld:%02ld:%02ld", secs / 86400, (secs / 3600) % 24,
               (secs / 60) % 60, secs % 60);
      printCentered(big, 19, 2);
      drawStatusLine(inZone, small, 37);
    }

    oled.drawFastHLine(0, 51, OLED_WIDTH, SH110X_WHITE);
    // Employee name, cut to fit left of the battery (15 characters).
    const size_t maxChars = (BATTERY_AREA_X - 2) / 6;
    snprintf(line, sizeof(line), "By %s", d.employee[0] ? d.employee : "-");
    if (strlen(line) > maxChars) strcpy(line + maxChars - 2, "..");
    oled.setTextSize(1);
    oled.setCursor(0, 56);
    oled.print(line);
  }
  drawBattery(batteryPercent());
  oled.display();
}

// Same priority as loop() and below ledTask, so I2C transfers never hold up the LEDs.
// ---- OLED debugging (all messages go to the serial monitor) ----

// What Wire.endTransmission()'s result means.
const char *i2cErrorText(uint8_t err) {
  switch (err) {
    case 0: return "ok";
    case 1: return "data too long";
    case 2: return "no answer at that address (NACK)";
    case 3: return "data not acknowledged";
    case 5: return "bus timeout (SDA/SCL stuck or no pull-ups)";
    default: return "bus error";
  }
}

// Does a device answer at this I2C address? 0 = yes, otherwise the error code.
uint8_t i2cProbe(uint8_t addr) {
  Wire.beginTransmission(addr);
  return Wire.endTransmission();
}

// List every device on the bus, so a wrong address or dead wiring is obvious.
void i2cScan() {
  Serial.printf("I2C scan (SDA=GPIO %d, SCL=GPIO %d):", OLED_SDA_PIN, OLED_SCL_PIN);
  int found = 0;
  for (uint8_t addr = 1; addr < 127; addr++) {
    if (i2cProbe(addr) == 0) {
      Serial.printf(" 0x%02X", addr);
      found++;
    }
  }
  if (found) Serial.printf("  (%d device%s)\n", found, found == 1 ? "" : "s");
  else Serial.println(" nothing found -> check OLED VCC/GND, and that SDA/SCL aren't swapped");
}

// Find the OLED (configured address first, then the other common one) and
// initialize it. `verbose` prints the full diagnosis; retries stay quieter.
bool oledInit(bool verbose) {
  const uint8_t candidates[] = {OLED_ADDRESS, (uint8_t)(OLED_ADDRESS == 0x3C ? 0x3D : 0x3C)};
  for (uint8_t addr : candidates) {
    uint8_t err = i2cProbe(addr);
    if (err != 0) {
      if (verbose) Serial.printf("OLED: 0x%02X -> %s\n", addr, i2cErrorText(err));
      continue;
    }
    if (addr != OLED_ADDRESS) {
      Serial.printf("OLED: found at 0x%02X instead of 0x%02X (set OLED_ADDRESS to 0x%02X)\n", addr, OLED_ADDRESS,
                    addr);
    }
    if (!oled.begin(addr, true)) {
      // Fails if the frame buffer can't be allocated or the init commands aren't acknowledged.
      Serial.printf("OLED: answered at 0x%02X but init failed (frame buffer or I2C error)\n", addr);
      return false;
    }
    // Many "1.3 inch SH1106" modules actually carry an SSD1306. The SH1106 init
    // never enables the SSD1306's charge pump, so the panel stays dark even
    // though every I2C write is acknowledged. Send the SSD1306 commands too:
    //   0x8D 0x14 = charge pump on, 0x20 0x02 = page addressing (what display() uses)
    // A real SH1106 ignores them (they decode as column-address bytes that
    // display() overwrites on every page).
    Wire.beginTransmission(addr);
    Wire.write(0x00); // command stream
    Wire.write(0x8D);
    Wire.write(0x14);
    Wire.write(0x20);
    Wire.write(0x02);
    Wire.write(0xAF); // display on (again, after the charge pump is up)
    uint8_t cpErr = Wire.endTransmission();
    if (verbose && cpErr != 0) Serial.printf("OLED: SSD1306 charge-pump command failed (%s)\n", i2cErrorText(cpErr));
    oled.setRotation(0);
    oled.clearDisplay();
    oled.display();
    oledAddress = addr;
    Serial.printf("OLED: ready at 0x%02X (%dx%d SH1106)\n", addr, OLED_WIDTH, OLED_HEIGHT);
    if (verbose) {
      Serial.println("OLED: if it still shows nothing or garbage, the module may be an SSD1306 after all");
      Serial.println("      (usually 0.96\" boards), or a 128x32 panel: change the driver/size above");
    }
    return true;
  }
  if (verbose) {
    Serial.println("OLED: not found. Check wiring: VCC->3.3V, GND->GND, SDA->GPIO 21, SCL->GPIO 22.");
    Serial.printf("OLED: will keep retrying every %lu s\n", OLED_CHECK_MS / 1000);
  }
  return false;
}

// Draws every 250 ms. Every 5 s it checks the OLED still answers: a loose wire
// or power blip is reported once, and the screen is re-initialized when it's back.
// It also counts the item's danger-zone time while the fridge is in the zone,
// so the item turns SPOILED on time even between dashboard updates (or with
// the dashboard closed).
void displayTask(void *) {
  unsigned long lastCheck = millis();
  unsigned long retries = 0;
  int64_t lastTick = nowMs();
  for (;;) {
    portENTER_CRITICAL(&stateMux);
    bool inZone = inDangerZone;
    unsigned long spoilMs = dangerAlertMs;
    portEXIT_CRITICAL(&stateMux);
    int64_t t = nowMs();
    int64_t dt = t - lastTick;
    lastTick = t;
    bool justSpoiled = false;
    char spoiledName[81] = "";
    portENTER_CRITICAL(&displayMux);
    if (inZone && displayInfo.known && displayInfo.item[0] && !displayInfo.spoiled) {
      displayInfo.exposureMs += dt;
      if (displayInfo.exposureMs >= (int64_t)spoilMs) {
        displayInfo.spoiled = true; // sticks until a different item is shown
        justSpoiled = true;
        strcpy(spoiledName, displayInfo.item);
      }
    }
    portEXIT_CRITICAL(&displayMux);
    if (justSpoiled) Serial.printf("Display: \"%s\" spoiled (%lu s in the danger zone)\n", spoiledName, spoilMs / 1000);

    if (millis() - lastCheck >= OLED_CHECK_MS) {
      lastCheck = millis();
      if (oledReady) {
        uint8_t err = i2cProbe(oledAddress);
        if (err != 0) {
          oledReady = false;
          retries = 0;
          Serial.printf("OLED: stopped responding at 0x%02X (%s), check its wires\n", oledAddress, i2cErrorText(err));
        }
      } else {
        retries++;
        if (oledInit(false)) {
          oledReady = true;
          Serial.println("OLED: back online");
        } else if (retries % 12 == 0) {
          Serial.printf("OLED: still not found after %lu s, scanning bus again\n", retries * OLED_CHECK_MS / 1000);
          i2cScan();
        }
      }
    }

    if (oledReady) {
      DisplayInfo d;
      portENTER_CRITICAL(&displayMux);
      d = displayInfo;
      portEXIT_CRITICAL(&displayMux);
      drawDisplay(d, inZone);
    }
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
float lastUploadedC = NAN; // temperature in the last uploaded reading

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
    // The ESP32 only has a 2.4 GHz radio: say whether the network is even visible.
    int n = WiFi.scanNetworks();
    bool seen = false;
    for (int i = 0; i < n; i++) {
      if (WiFi.SSID(i) == WIFI_SSID) {
        seen = true;
        Serial.printf("  \"%s\" is visible: channel %d, signal %d dBm, security type %d -> check the password\n",
                      WIFI_SSID, (int)WiFi.channel(i), (int)WiFi.RSSI(i), (int)WiFi.encryptionType(i));
      }
    }
    if (!seen) {
      Serial.printf("  \"%s\" not found among %d 2.4 GHz networks. The ESP32 can't use 5 GHz:\n"
                    "  set the hotspot/router to 2.4 GHz (phone hotspot: turn on 'Extend compatibility').\n",
                    WIFI_SSID, n);
    }
    WiFi.scanDelete();
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD); // scanning interrupts the connect attempt; restart it
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
  i2cScan();
  oledReady = oledInit(true);
  // Started even if the OLED is missing, so it keeps retrying (a loose wire
  // fixed later comes up without a reboot).
  xTaskCreatePinnedToCore(displayTask, "oled", 4096, nullptr, 1, nullptr, 1);

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
  // Restart the attempt from scratch (WiFi.reconnect() errors with "sta is
  // connecting" while a previous attempt is still pending).
  if (WiFi.status() != WL_CONNECTED && millis() - lastWifiAttemptMs > 20000) {
    lastWifiAttemptMs = millis();
    Serial.println("WiFi down, reconnecting");
    WiFi.disconnect();
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
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

  // Upload as soon as the temperature (or zone) changes, after a reset, and
  // every 30 s regardless, so the website shows a new temperature within ~1 s
  // of the sensor. A reading counts until the next one, so skipping unchanged
  // readings doesn't change the danger-zone timing on the website.
  bool tempChanged = isnan(lastUploadedC) || fabsf(tempC - lastUploadedC) >= 0.05f;
  if (tempChanged || zoneChanged || resetNow || millis() - lastUploadMs >= UPLOAD_INTERVAL_MS) {
    lastUploadMs = millis();
    lastUploadedC = tempC;
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
