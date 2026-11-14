-- One row per fridge/freezer (each one has its own ESP32 sensor)
CREATE TABLE appliances (
    id                  SERIAL PRIMARY KEY,
    name                TEXT NOT NULL,                       -- e.g. 'Kitchen fridge'
    kind                TEXT NOT NULL CHECK (kind IN ('fridge', 'freezer')),
    danger_threshold_c  NUMERIC(5,2) NOT NULL                -- e.g. 4.0 for fridge, -18.0 for freezer
);

-- #4: temperature of the environment, one row per sensor reading
CREATE TABLE temperature_readings (
    id             BIGSERIAL PRIMARY KEY,
    appliance_id   INT NOT NULL REFERENCES appliances(id) ON DELETE CASCADE,
    recorded_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    temperature_c  NUMERIC(5,2) NOT NULL
);
CREATE INDEX ON temperature_readings (appliance_id, recorded_at);

-- #1 and #2: food items logged by the user on the website
CREATE TABLE food_items (
    id            SERIAL PRIMARY KEY,
    appliance_id  INT NOT NULL REFERENCES appliances(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    placed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    removed_at    TIMESTAMPTZ                                -- NULL = still in the fridge
);
-- Original view. db/migrations/001_safety_thresholds.sql (run by the API at
-- startup) replaces it with one that uses the safety_thresholds table and adds
-- a `spoiled` column.
CREATE VIEW food_item_status AS
WITH intervals AS (
    -- Each reading counts until the next reading arrives
    SELECT appliance_id,
           temperature_c,
           recorded_at AS start_at,
           COALESCE(LEAD(recorded_at) OVER (PARTITION BY appliance_id ORDER BY recorded_at),
                    now()) AS end_at
    FROM temperature_readings
)
SELECT f.id,
       f.name,
       f.appliance_id,
       f.placed_at,
       COALESCE(f.removed_at, now()) - f.placed_at AS time_in_storage,      -- #2
       COALESCE(
           SUM(LEAST(i.end_at, COALESCE(f.removed_at, now()))
               - GREATEST(i.start_at, f.placed_at))
           FILTER (WHERE i.temperature_c > a.danger_threshold_c),
           INTERVAL '0'
       ) AS danger_zone_time                                                -- #3
FROM food_items f
JOIN appliances a ON a.id = f.appliance_id
LEFT JOIN intervals i
       ON i.appliance_id = f.appliance_id
      AND i.start_at < COALESCE(f.removed_at, now())
      AND i.end_at   > f.placed_at
GROUP BY f.id, a.id;