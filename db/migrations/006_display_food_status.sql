-- Food-safety status of the item on each ESP32's OLED, sent by the dashboard
-- with the rest of the display info (PUT /devices/{id}/display):
--   display_item_id      the item's id, so the device can tell a re-added item
--                        with the same name from the old one
--   display_spoiled      true once the item has spoiled from danger-zone time;
--                        it stays spoiled even after the fridge cools down
--   display_exposure_ms  danger-zone time so far; the device keeps counting it
--                        on its own while the fridge is in the zone
-- Idempotent (runs on API start).

ALTER TABLE device_status ADD COLUMN IF NOT EXISTS display_item_id     TEXT;
ALTER TABLE device_status ADD COLUMN IF NOT EXISTS display_spoiled     BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE device_status ADD COLUMN IF NOT EXISTS display_exposure_ms BIGINT  NOT NULL DEFAULT 0;
