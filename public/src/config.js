// Tunable dashboard settings. Change these instead of digging through components.

// Temperature range treated as the food-safety danger zone, inclusive.
// Kept in °C because the sensor and database use °C; the site displays it in °F
// (4–50 °C = 39.2–122 °F).
export const DANGER_MIN_C = 4
export const DANGER_MAX_C = 50

// Within this many °C of the danger zone, the temperature card adds a
// "close to the danger zone" note (the status itself stays green).
export const NEAR_ZONE_MARGIN_C = 2

// Danger-zone time before a warning turns from yellow to red (an item is then spoiled).
// Applies to the fridge (time continuously in the zone) and to each item
// (total time it has spent in the zone).
export const RED_EXPOSURE_MS = 2 * 60 * 1000

// How often to poll the backend. The ESP32 reads its sensor every 1 s and
// uploads as soon as the temperature changes, so with a 1 s poll the site shows
// a new temperature (and changes color) within ~2 s.
export const POLL_INTERVAL_MS = 1_000

// The ESP32 posts on every temperature change and at least every 30 s. With no reading for this long (three missed
// readings), the device is shown as off and the last reading as "last known".
export const STALE_AFTER_MS = 90 * 1000

// Readings fetched per poll (the API caps this at 1000: at least 8 h at one per 30 s,
// less while the temperature is changing).
export const READINGS_LIMIT = 1000

export const DEFAULT_APPLIANCE_ID = 1

// How long a popup stays on screen before fading out (hovering pauses it).
export const TOAST_DURATION_MS = 6000
