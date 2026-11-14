-- Set when the Admin page erases an appliance's temperature history. The
-- ESP32 sees it in its next check-in reply, restarts its danger-zone timer
-- (so the LED drops back to green/yellow) and sends a fresh reading right away.
-- Idempotent (runs on API start).

ALTER TABLE device_status ADD COLUMN IF NOT EXISTS history_reset_pending BOOLEAN NOT NULL DEFAULT false;
