-- "Find my device": each ESP32 checks in every few seconds; the dashboard can
-- ask a device to flash all its LEDs until locate_until. Also stores a
-- human-readable location for every appliance. Idempotent (runs on API start).

ALTER TABLE appliances ADD COLUMN IF NOT EXISTS location TEXT;

CREATE TABLE IF NOT EXISTS device_status (
    appliance_id         INT PRIMARY KEY REFERENCES appliances(id) ON DELETE CASCADE,
    locate_until         TIMESTAMPTZ,   -- LEDs flash until this time (NULL = not locating)
    locate_requested_at  TIMESTAMPTZ,
    last_checkin_at      TIMESTAMPTZ,   -- last time the ESP32 called /devices/{id}/checkin
    ip                   TEXT,          -- reported by the device on check-in
    rssi                 INT            -- Wi-Fi signal strength in dBm (closer to 0 = stronger)
);
