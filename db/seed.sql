-- Starter data, loaded by Docker right after schema.sql when the database is
-- first created (see docker-compose.yaml). Safe to run again by hand.
INSERT INTO appliances (id, name, kind, danger_threshold_c)
VALUES (1, 'Kitchen fridge', 'fridge', 4.0)
ON CONFLICT (id) DO NOTHING;

-- The explicit id above doesn't advance the SERIAL sequence; do it so the next
-- appliance added without an id gets 2 instead of clashing with 1.
SELECT setval(pg_get_serial_sequence('appliances', 'id'), (SELECT MAX(id) FROM appliances));
