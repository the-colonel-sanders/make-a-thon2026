-- What each ESP32's OLED shows: the item currently in that fridge, who logged
-- it and when it spoils (placed time + the USDA fridge storage time). Items
-- live in the dashboard's browser storage, so the dashboard writes this via
-- PUT /devices/{id}/display and the device reads it in its check-in reply.
-- Idempotent (runs on API start).

ALTER TABLE device_status ADD COLUMN IF NOT EXISTS display_item      TEXT;        -- NULL = nothing to show
ALTER TABLE device_status ADD COLUMN IF NOT EXISTS display_employee  TEXT;
ALTER TABLE device_status ADD COLUMN IF NOT EXISTS display_spoil_at  TIMESTAMPTZ; -- NULL = no USDA storage time
