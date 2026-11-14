# Food Saver

A temperature-tracking system for small restaurants, built for SEC Make-A-Thon 2026.

## Mission

Small restaurants rarely have the staff or budget for commercial food-safety systems, yet they still have to know what is in each fridge, how long it has been there, and whether it has spent too long in the temperature danger zone. Food Saver helps small kitchens **organize their stock by appliance and manage it safely**. An ESP32 sensor in each fridge logs its temperature. Staff log items into the fridge they're stored in, and the dashboard flags any item that has spent too long in the danger zone, before it reaches a customer.

## How it fits together

```
ESP32 + DHT11 (env_sensing/)  ──POST /readings──▶  FastAPI (api/)  ◀──/api proxy──  React dashboard (public/)
   status LEDs: green/yellow/red                       │
                                                       ▼
                                             PostgreSQL (db/, Docker)
```

| Folder | What it is |
| --- | --- |
| [env_sensing/](env_sensing/) | ESP32 firmware (PlatformIO). Reads the sensor, sends readings, and drives the status LEDs. |
| [api/](api/) | FastAPI server for readings, food-safety thresholds and device check-ins. |
| [db/](db/) | Postgres schema, migrations and Docker Compose file. |
| [public/](public/) | React + Vite dashboard. |

## Installation

### Prerequisites

- [Docker](https://www.docker.com/) (runs Postgres)
- Python 3.12+
- Node.js 20+
- [PlatformIO](https://platformio.org/) (the VS Code extension or the CLI)
- An ESP32 dev board, a DHT11 sensor, and red, yellow and green LEDs with 220–330 Ω resistors

### 1. Database

Create `db/.env`. This file is git-ignored, and the API reads it too:

```env
POSTGRES_USER=envsense
POSTGRES_PASSWORD=changeme
POSTGRES_DB=envsense
DATABASE_URL=postgresql+psycopg://envsense:changeme@localhost:5432/envsense
```

Start Postgres:

```bash
cd db
docker compose up -d
```

The first time the database is created, Docker automatically loads `schema.sql` and then `seed.sql`, which adds appliance #1, "Kitchen fridge". This only happens when the data volume is empty. To start over from scratch, run `docker compose down -v` and then `docker compose up -d`.

To add more fridges, insert rows into the `appliances` table. You don't need to run the files in `db/migrations/` yourself, because the API applies them every time it starts.

### 2. API

```bash
cd api
python -m venv .venv
.venv\Scripts\activate          # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

`--host 0.0.0.0` lets the ESP32 reach the API over the LAN. Interactive API docs are at http://localhost:8000/docs.

### 3. Dashboard

```bash
cd public
npm install
npm run dev                     # http://localhost:5173
```

To use an API running on a different machine, copy `public/.env.example` to `public/.env` and set `API_TARGET`.

### 4. Sensor (ESP32)

1. Wire the DHT11 data pin to GPIO 4. Wire the red, yellow and green LEDs to GPIO 25, 26 and 27, each through a resistor to ground.
2. Copy [env_sensing/include/secrets.example.h](env_sensing/include/secrets.example.h) to `env_sensing/include/secrets.h` and fill in your Wi-Fi name and password. `secrets.h` is git-ignored, and the build stops with an error if it is missing.
3. In the configuration block at the top of [env_sensing/src/main.cpp](env_sensing/src/main.cpp), set:
   - `API_BASE`: the LAN IP of the computer running the API, e.g. `http://192.168.1.20:8000`
   - `APPLIANCE_ID`: the `id` of this fridge in the `appliances` table
4. Build and upload with PlatformIO (`pio run -t upload`), then open the serial monitor at 115200 baud to confirm readings are being sent.

The LEDs follow the same rule as the dashboard:

- **Green:** the fridge is outside the danger zone.
- **Yellow:** it is in the danger zone, but not yet for the full spoil time.
- **Red:** it has stayed in the danger zone for at least the spoil time.

## Admin tools

The dashboard's navigation bar has pages for managing the system as well as using it day to day.

### Admin (`#/admin`)

- **Danger zone.** Set the lower and upper temperature bounds, in °F, that count as unsafe.
- **Time until spoiled.** Set how long an item can spend in total in the danger zone before it is marked spoiled (red). The same value also controls the fridge's red status.

  These thresholds are saved in the database and shared by every dashboard and every sensor, and they take effect within about a minute. **Reset to defaults** restores the factory values.
- **Reset temperature history.** Permanently delete the stored readings for one fridge or for all appliances. Because items' danger-zone time is calculated from these readings, it resets too. You confirm before anything is deleted.

### Locate (`#/locate`)

- See every sensor's connection status, last reading, IP address and Wi-Fi signal.
- Give each sensor a name and location.
- Use **Find my device** to make a sensor's three LEDs flash together for 15 seconds to 2 minutes, so you can spot it in a crowded kitchen.

### Settings (`#/settings`)

- **Appearance:** choose the theme and layout density.
- **Units & sensor:** choose the temperature unit, and set how many seconds can pass without a reading before a sensor counts as offline.
- **Notifications:** turn alert popups on or off, and choose whether you're alerted when a sensor goes offline.
- **Employees:** manage employee profiles (Staff, Manager, Kitchen lead, Cleaner), so you can see who logged each item.
- **Data & storage:** choose which fridge the dashboard opens to, export or import a JSON backup, reset settings, or erase local data.

> **Note:** Food items, employee profiles and notifications are currently stored in each browser's local storage, not in the database. Use **Export backup** on the Settings page to move them to another computer.

## License

[MIT](LICENSE)
