-- Flood Finder Smart City — Supabase Schema
-- Run this in the Supabase SQL Editor to set up all tables.
-- Project: City-wide flood monitoring for Aventura, FL
-- Hardware: Heltec ESP32 LoRa + HC-SR04 + BMP390 + GPS on mailboxes

-- ============================================================
-- DEVICES — one row per physical sensor
-- ============================================================
CREATE TABLE IF NOT EXISTS devices (
  device_id    TEXT PRIMARY KEY,
  name         TEXT,
  lat          DOUBLE PRECISION NOT NULL,
  lng          DOUBLE PRECISION NOT NULL,
  altitude_baro DOUBLE PRECISION,          -- BMP390 calibrated elevation (m NAVD88)
  mailbox_height_cm INTEGER NOT NULL DEFAULT 95,
  baseline_distance_cm INTEGER,            -- calibrated dry ultrasonic reading
  status       TEXT NOT NULL DEFAULT 'offline'
                 CHECK (status IN ('online', 'offline', 'alert')),
  battery_v    DOUBLE PRECISION,
  last_seen    TIMESTAMPTZ,
  installed_at TIMESTAMPTZ DEFAULT NOW(),
  neighborhood TEXT,
  notes        TEXT
);

-- ============================================================
-- SENSOR READINGS — time-series, will have millions of rows
-- ============================================================
CREATE TABLE IF NOT EXISTS sensor_readings (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id     TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  lat           DOUBLE PRECISION,
  lng           DOUBLE PRECISION,
  altitude_gps  DOUBLE PRECISION,
  altitude_baro DOUBLE PRECISION,
  distance_cm   INTEGER,
  water_detected BOOLEAN NOT NULL DEFAULT FALSE,
  flood_depth_cm INTEGER NOT NULL DEFAULT 0,
  battery_v     DOUBLE PRECISION,
  rssi          INTEGER,
  is_valid      BOOLEAN NOT NULL DEFAULT TRUE,
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- FLOOD EVENTS — aggregated from raw readings
-- An event starts when water_detected goes true and ends when
-- it goes false. NOAA data is attached at event start.
-- ============================================================
CREATE TABLE IF NOT EXISTS flood_events (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id        TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at         TIMESTAMPTZ,           -- NULL = ongoing
  peak_depth_cm    INTEGER NOT NULL DEFAULT 0,
  rainfall_mm      DOUBLE PRECISION,      -- NOAA rainfall at time of event
  tide_level_m     DOUBLE PRECISION,      -- NOAA tide (NAVD) at time of event
  duration_minutes INTEGER GENERATED ALWAYS AS (
    CASE
      WHEN ended_at IS NOT NULL
        THEN EXTRACT(EPOCH FROM (ended_at - started_at))::INTEGER / 60
      ELSE NULL
    END
  ) STORED
);

-- ============================================================
-- INFRASTRUCTURE RECOMMENDATIONS — AI-generated analysis
-- Each row is one recommendation from a Claude analysis run.
-- ============================================================
CREATE TABLE IF NOT EXISTS infrastructure_recommendations (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  generated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  analysis_period_days INTEGER NOT NULL DEFAULT 30,
  recommendation_text  TEXT NOT NULL,
  affected_device_ids  TEXT[] DEFAULT '{}',
  priority             TEXT NOT NULL DEFAULT 'medium'
                         CHECK (priority IN ('high', 'medium', 'low')),
  category             TEXT NOT NULL DEFAULT 'other'
                         CHECK (category IN ('drainage', 'elevation', 'barrier', 'other'))
);

-- ============================================================
-- INDEXES — optimized for dashboard queries
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_readings_device     ON sensor_readings(device_id);
CREATE INDEX IF NOT EXISTS idx_readings_time       ON sensor_readings(recorded_at);
CREATE INDEX IF NOT EXISTS idx_readings_water      ON sensor_readings(water_detected);
CREATE INDEX IF NOT EXISTS idx_readings_device_time ON sensor_readings(device_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_devices_status      ON devices(status);
CREATE INDEX IF NOT EXISTS idx_devices_neighborhood ON devices(neighborhood);
CREATE INDEX IF NOT EXISTS idx_flood_events_dev    ON flood_events(device_id);
CREATE INDEX IF NOT EXISTS idx_flood_events_time   ON flood_events(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_flood_events_open   ON flood_events(device_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_recs_time           ON infrastructure_recommendations(generated_at DESC);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE devices                       ENABLE ROW LEVEL SECURITY;
ALTER TABLE sensor_readings               ENABLE ROW LEVEL SECURITY;
ALTER TABLE flood_events                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE infrastructure_recommendations ENABLE ROW LEVEL SECURITY;

-- Service-role full access (bridge service writes)
CREATE POLICY "Service role full access" ON devices
  FOR ALL USING (TRUE) WITH CHECK (TRUE);

CREATE POLICY "Service role full access" ON sensor_readings
  FOR ALL USING (TRUE) WITH CHECK (TRUE);

CREATE POLICY "Service role full access" ON flood_events
  FOR ALL USING (TRUE) WITH CHECK (TRUE);

CREATE POLICY "Service role full access" ON infrastructure_recommendations
  FOR ALL USING (TRUE) WITH CHECK (TRUE);

-- Anon read-only access (dashboard frontend)
CREATE POLICY "Anon read access" ON devices
  FOR SELECT USING (TRUE);

CREATE POLICY "Anon read access" ON sensor_readings
  FOR SELECT USING (TRUE);

CREATE POLICY "Anon read access" ON flood_events
  FOR SELECT USING (TRUE);

CREATE POLICY "Anon read access" ON infrastructure_recommendations
  FOR SELECT USING (TRUE);

-- ============================================================
-- REALTIME — enable for live dashboard updates
-- ============================================================
ALTER PUBLICATION supabase_realtime ADD TABLE devices;
ALTER PUBLICATION supabase_realtime ADD TABLE sensor_readings;
ALTER PUBLICATION supabase_realtime ADD TABLE flood_events;
