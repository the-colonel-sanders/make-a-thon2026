# FastAPI server that receives readings from the ESP32 (env_sensing/src/main.cpp)
# and stores them in Postgres (db/schema.sql).
#
# Run from anywhere on the LAN-facing machine:
#   uvicorn main:app --host 0.0.0.0 --port 8000
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from psycopg.errors import ForeignKeyViolation
from psycopg_pool import ConnectionPool
from pydantic import BaseModel, Field, model_validator

DB_DIR = Path(__file__).resolve().parent.parent / "db"
load_dotenv(DB_DIR / ".env")  # reuse DATABASE_URL

# psycopg wants a plain libpq URL; strip a SQLAlchemy-style driver suffix if present.
DATABASE_URL = os.environ["DATABASE_URL"].replace("postgresql+psycopg://", "postgresql://", 1)

# Sync pool: FastAPI runs plain `def` endpoints in a threadpool, and this avoids
# psycopg's incompatibility with the default asyncio event loop on Windows.
pool = ConnectionPool(DATABASE_URL, open=False)

# The ESP32 sends a 1970 timestamp if NTP hasn't synced yet; don't trust those.
MIN_VALID_TIME = datetime(2024, 1, 1, tzinfo=timezone.utc)


def run_migrations():
    """Apply db/migrations/*.sql in name order. Each file must be idempotent."""
    with pool.connection() as conn:
        for path in sorted((DB_DIR / "migrations").glob("*.sql")):
            conn.execute(path.read_text(encoding="utf-8"))


@asynccontextmanager
async def lifespan(app):
    pool.open(wait=True)
    run_migrations()
    yield
    pool.close()


app = FastAPI(lifespan=lifespan)


class Reading(BaseModel):
    appliance_id: int
    temperature_c: float
    recorded_at: datetime | None = None  # ISO 8601, e.g. "2026-11-14T12:00:00Z"


@app.post("/readings", status_code=201)
def add_reading(r: Reading):
    recorded_at = r.recorded_at
    if recorded_at is not None:
        if recorded_at.tzinfo is None:
            recorded_at = recorded_at.replace(tzinfo=timezone.utc)
        if recorded_at < MIN_VALID_TIME:
            recorded_at = None  # fall back to server time

    try:
        with pool.connection() as conn:
            row = conn.execute(
                """
                INSERT INTO temperature_readings (appliance_id, temperature_c, recorded_at)
                VALUES (%s, %s, COALESCE(%s, now()))
                RETURNING id, recorded_at
                """,
                (r.appliance_id, r.temperature_c, recorded_at),
            ).fetchone()
    except ForeignKeyViolation:
        raise HTTPException(404, "unknown appliance_id")

    return {"id": row[0], "recorded_at": row[1]}


@app.get("/readings")
def list_readings(appliance_id: int | None = None, limit: int = 100):
    """Most recent readings, newest first (handy for checking the ESP32 is posting)."""
    with pool.connection() as conn:
        rows = conn.execute(
            """
            SELECT id, appliance_id, recorded_at, temperature_c
            FROM temperature_readings
            WHERE %(aid)s::int IS NULL OR appliance_id = %(aid)s
            ORDER BY recorded_at DESC
            LIMIT %(limit)s
            """,
            {"aid": appliance_id, "limit": min(max(limit, 1), 1000)},
        ).fetchall()
    return [
        {"id": i, "appliance_id": a, "recorded_at": t, "temperature_c": float(c)}
        for i, a, t, c in rows
    ]


# Upper bound on rows returned by /readings/range (a month at one reading every
# 30 s is ~86k rows per appliance), so one request can't exhaust memory.
MAX_RANGE_ROWS = 200_000


@app.get("/readings/range")
def readings_in_range(start: datetime, end: datetime, appliance_id: int | None = None):
    """Every reading with start <= recorded_at < end, oldest first (used for CSV export).

    start/end are ISO 8601; values without a timezone are treated as UTC.
    """
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    if end.tzinfo is None:
        end = end.replace(tzinfo=timezone.utc)
    if end <= start:
        raise HTTPException(400, "end must be after start")

    with pool.connection() as conn:
        rows = conn.execute(
            """
            SELECT id, appliance_id, recorded_at, temperature_c
            FROM temperature_readings
            WHERE (%(aid)s::int IS NULL OR appliance_id = %(aid)s)
              AND recorded_at >= %(start)s AND recorded_at < %(end)s
            ORDER BY recorded_at
            LIMIT %(limit)s
            """,
            {"aid": appliance_id, "start": start, "end": end, "limit": MAX_RANGE_ROWS},
        ).fetchall()
    return [
        {"id": i, "appliance_id": a, "recorded_at": t, "temperature_c": float(c)}
        for i, a, t, c in rows
    ]


@app.delete("/readings")
def delete_readings(appliance_id: int | None = None):
    """Erase the temperature history (Admin page). Omit appliance_id to erase every appliance's.

    Also tells the affected ESP32s (on their next check-in) to restart their
    danger-zone timer, so their LEDs match the now-empty history.
    """
    with pool.connection() as conn:
        cur = conn.execute(
            "DELETE FROM temperature_readings WHERE %(aid)s::int IS NULL OR appliance_id = %(aid)s",
            {"aid": appliance_id},
        )
        deleted = cur.rowcount
        conn.execute(
            """
            INSERT INTO device_status (appliance_id, history_reset_pending)
            SELECT id, true FROM appliances WHERE %(aid)s::int IS NULL OR id = %(aid)s
            ON CONFLICT (appliance_id) DO UPDATE SET history_reset_pending = true
            """,
            {"aid": appliance_id},
        )
    return {"deleted": deleted}


class Thresholds(BaseModel):
    """Food-safety thresholds (edited on the dashboard's Admin page). Temperatures in °C."""

    danger_min_c: float = Field(ge=-100, le=150)
    danger_max_c: float = Field(ge=-100, le=150)
    spoil_after_seconds: int = Field(ge=1, le=30 * 24 * 3600)

    @model_validator(mode="after")
    def check_order(self):
        if self.danger_min_c >= self.danger_max_c:
            raise ValueError("danger_min_c must be below danger_max_c")
        return self


def _thresholds_json(row):
    lo, hi, secs, updated = row
    return {
        "danger_min_c": float(lo),
        "danger_max_c": float(hi),
        "spoil_after_seconds": secs,
        "updated_at": updated,
    }


@app.get("/settings/thresholds")
def get_thresholds():
    with pool.connection() as conn:
        row = conn.execute(
            "SELECT danger_min_c, danger_max_c, spoil_after_seconds, updated_at FROM safety_thresholds"
        ).fetchone()
    if row is None:
        raise HTTPException(500, "safety_thresholds has no row; restart the API to run migrations")
    return _thresholds_json(row)


@app.put("/settings/thresholds")
def put_thresholds(t: Thresholds):
    with pool.connection() as conn:
        row = conn.execute(
            """
            INSERT INTO safety_thresholds (id, danger_min_c, danger_max_c, spoil_after_seconds, updated_at)
            VALUES (true, %s, %s, %s, now())
            ON CONFLICT (id) DO UPDATE SET
                danger_min_c = EXCLUDED.danger_min_c,
                danger_max_c = EXCLUDED.danger_max_c,
                spoil_after_seconds = EXCLUDED.spoil_after_seconds,
                updated_at = EXCLUDED.updated_at
            RETURNING danger_min_c, danger_max_c, spoil_after_seconds, updated_at
            """,
            (t.danger_min_c, t.danger_max_c, t.spoil_after_seconds),
        ).fetchone()
    return _thresholds_json(row)


# ---------------------------------------------------------------------------
# Devices & "find my device"
#
# Each ESP32 POSTs /devices/{id}/checkin every few seconds. The reply tells it
# whether to flash all its LEDs (and for how much longer). The dashboard's
# Locate page lists devices and starts/stops locating.
# ---------------------------------------------------------------------------

LOCATE_DEFAULT_SECONDS = 30
LOCATE_MAX_SECONDS = 300


@app.get("/devices")
def list_devices():
    """Every appliance with its location, latest reading and check-in status."""
    with pool.connection() as conn:
        rows = conn.execute(
            """
            SELECT a.id, a.name, a.kind, a.location,
                   r.recorded_at, r.temperature_c,
                   s.last_checkin_at, s.ip, s.rssi,
                   s.locate_until, s.locate_requested_at,
                   now()
            FROM appliances a
            LEFT JOIN device_status s ON s.appliance_id = a.id
            LEFT JOIN LATERAL (
                SELECT recorded_at, temperature_c
                FROM temperature_readings
                WHERE appliance_id = a.id
                ORDER BY recorded_at DESC
                LIMIT 1
            ) r ON true
            ORDER BY a.id
            """
        ).fetchall()
    devices = []
    for (aid, name, kind, location, last_at, last_temp,
         checkin, ip, rssi, until, requested, now) in rows:
        locating = until is not None and until > now
        devices.append({
            "id": aid,
            "name": name,
            "kind": kind,
            "location": location,
            "last_reading_at": last_at,
            "last_temperature_c": float(last_temp) if last_temp is not None else None,
            "last_checkin_at": checkin,
            "ip": ip,
            "rssi": rssi,
            "locating": locating,
            "locate_until": until if locating else None,
            "locate_requested_at": requested,
            "server_time": now,
        })
    return devices


class DeviceUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    location: str | None = Field(default=None, max_length=120)


@app.patch("/devices/{appliance_id}")
def update_device(appliance_id: int, body: DeviceUpdate):
    """Rename a device or set where it is (e.g. "Kitchen, walk-in fridge")."""
    fields = body.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(400, "nothing to update")
    if "location" in fields and fields["location"] is not None:
        fields["location"] = fields["location"].strip() or None
    sets = ", ".join(f"{k} = %({k})s" for k in fields)  # keys come from the model, not the client
    with pool.connection() as conn:
        row = conn.execute(
            f"UPDATE appliances SET {sets} WHERE id = %(id)s RETURNING id, name, location",
            {**fields, "id": appliance_id},
        ).fetchone()
    if row is None:
        raise HTTPException(404, "unknown appliance_id")
    return {"id": row[0], "name": row[1], "location": row[2]}


class LocateRequest(BaseModel):
    seconds: int = Field(default=LOCATE_DEFAULT_SECONDS, ge=5, le=LOCATE_MAX_SECONDS)


def _require_appliance(conn, appliance_id):
    if conn.execute("SELECT 1 FROM appliances WHERE id = %s", (appliance_id,)).fetchone() is None:
        raise HTTPException(404, "unknown appliance_id")


@app.post("/devices/{appliance_id}/locate")
def start_locate(appliance_id: int, body: LocateRequest | None = None):
    """Ask the device to flash all its LEDs for `seconds` (picked up on its next check-in)."""
    seconds = (body or LocateRequest()).seconds
    with pool.connection() as conn:
        _require_appliance(conn, appliance_id)
        until = conn.execute(
            """
            INSERT INTO device_status (appliance_id, locate_until, locate_requested_at)
            VALUES (%(id)s, now() + make_interval(secs => %(s)s), now())
            ON CONFLICT (appliance_id) DO UPDATE SET
                locate_until = EXCLUDED.locate_until,
                locate_requested_at = EXCLUDED.locate_requested_at
            RETURNING locate_until
            """,
            {"id": appliance_id, "s": seconds},
        ).fetchone()[0]
    return {"appliance_id": appliance_id, "locating": True, "locate_until": until}


@app.delete("/devices/{appliance_id}/locate")
def stop_locate(appliance_id: int):
    with pool.connection() as conn:
        _require_appliance(conn, appliance_id)
        conn.execute("UPDATE device_status SET locate_until = NULL WHERE appliance_id = %s", (appliance_id,))
    return {"appliance_id": appliance_id, "locating": False}


class CheckIn(BaseModel):
    ip: str | None = Field(default=None, max_length=45)
    rssi: int | None = Field(default=None, ge=-127, le=0)


@app.post("/devices/{appliance_id}/checkin")
def device_checkin(appliance_id: int, body: CheckIn | None = None):
    """Called by the ESP32 every few seconds.

    Replies with whether to flash its LEDs, whether its temperature history
    was erased since the last check-in (then it restarts its danger-zone timer),
    and the current danger zone / spoil time (same as GET /settings/thresholds).
    """
    body = body or CheckIn()
    try:
        with pool.connection() as conn:
            # Read and clear the reset flag in the same transaction as the check-in.
            pending = conn.execute(
                "SELECT history_reset_pending FROM device_status WHERE appliance_id = %s FOR UPDATE",
                (appliance_id,),
            ).fetchone()
            history_reset = bool(pending and pending[0])
            remaining = conn.execute(
                """
                INSERT INTO device_status (appliance_id, last_checkin_at, ip, rssi)
                VALUES (%(id)s, now(), %(ip)s, %(rssi)s)
                ON CONFLICT (appliance_id) DO UPDATE SET
                    last_checkin_at = EXCLUDED.last_checkin_at,
                    ip = EXCLUDED.ip,
                    rssi = EXCLUDED.rssi,
                    history_reset_pending = false
                RETURNING GREATEST(EXTRACT(EPOCH FROM (locate_until - now())), 0)
                """,
                {"id": appliance_id, "ip": body.ip, "rssi": body.rssi},
            ).fetchone()[0]
            # Thresholds ride along so the device needn't make a separate request.
            thresholds = conn.execute(
                "SELECT danger_min_c, danger_max_c, spoil_after_seconds FROM safety_thresholds"
            ).fetchone()
    except ForeignKeyViolation:
        raise HTTPException(404, "unknown appliance_id")
    remaining_ms = int(float(remaining or 0) * 1000)
    reply = {"locate": remaining_ms > 0, "locate_remaining_ms": remaining_ms, "history_reset": history_reset}
    if thresholds is not None:
        lo, hi, secs = thresholds
        reply.update(danger_min_c=float(lo), danger_max_c=float(hi), spoil_after_seconds=secs)
    return reply


@app.get("/health")
def health():
    with pool.connection() as conn:
        conn.execute("SELECT 1")
    return {"status": "ok"}
