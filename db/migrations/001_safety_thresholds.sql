-- Food-safety thresholds edited on the dashboard's Admin page.
-- Idempotent: api/main.py runs every file in db/migrations/ at startup, so an
-- existing database picks this up without being recreated.

-- Single-row table (id is always true), so there is exactly one set of thresholds.
CREATE TABLE IF NOT EXISTS safety_thresholds (
    id                   BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
    danger_min_c         NUMERIC(6,3) NOT NULL,              -- lower bound of the danger zone, inclusive
    danger_max_c         NUMERIC(6,3) NOT NULL,              -- upper bound, inclusive
    spoil_after_seconds  INT          NOT NULL CHECK (spoil_after_seconds > 0),
    updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CHECK (danger_min_c < danger_max_c)
);

-- Defaults match public/src/config.js: 4–50 °C (39.2–122 °F), spoiled after 2 minutes.
INSERT INTO safety_thresholds (danger_min_c, danger_max_c, spoil_after_seconds)
VALUES (4, 50, 120)
ON CONFLICT (id) DO NOTHING;

-- The view now uses the shared danger zone range instead of each appliance's
-- single danger_threshold_c, so the database agrees with the dashboard.
-- New columns go at the end so CREATE OR REPLACE works on the old view.
CREATE OR REPLACE VIEW food_item_status AS
WITH intervals AS (
    -- Each reading counts until the next reading arrives
    SELECT appliance_id,
           temperature_c,
           recorded_at AS start_at,
           COALESCE(LEAD(recorded_at) OVER (PARTITION BY appliance_id ORDER BY recorded_at),
                    now()) AS end_at
    FROM temperature_readings
),
item_exposure AS (
    SELECT f.id,
           f.name,
           f.appliance_id,
           f.placed_at,
           COALESCE(f.removed_at, now()) - f.placed_at AS time_in_storage,
           COALESCE(
               SUM(LEAST(i.end_at, COALESCE(f.removed_at, now()))
                   - GREATEST(i.start_at, f.placed_at))
               FILTER (WHERE i.temperature_c BETWEEN s.danger_min_c AND s.danger_max_c),
               INTERVAL '0'
           ) AS danger_zone_time,
           s.spoil_after_seconds
    FROM food_items f
    CROSS JOIN safety_thresholds s
    LEFT JOIN intervals i
           ON i.appliance_id = f.appliance_id
          AND i.start_at < COALESCE(f.removed_at, now())
          AND i.end_at   > f.placed_at
    GROUP BY f.id, s.id
)
SELECT id,
       name,
       appliance_id,
       placed_at,
       time_in_storage,
       danger_zone_time,
       danger_zone_time >= make_interval(secs => spoil_after_seconds) AS spoiled
FROM item_exposure;
