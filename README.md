# Flood Finder — Smart City Flood Monitoring System

Real-time city-wide flood detection and infrastructure analysis network for
Aventura, Florida. IoT sensors mounted on mailboxes measure water levels using
ultrasonic distance sensors and communicate via LoRa to a cloud backend.
NOAA weather and tide data is automatically correlated with each flood event.
AI-powered analysis identifies road dips, drainage deficiencies, and specific
infrastructure improvements.

## System Architecture

```
  +--------------+     LoRa 915MHz     +--------------+
  |  Mailbox     | ------------------> |  Gateway     |
  |  Sensor x N  |                     |  (LoRa>WiFi) |
  |  ESP32+HC-SR04                     +------+-------+
  |  +BMP390+GPS |                            | MQTT
  |  +Solar      |                            v
  +--------------+                   +------------------+
                                     |  HiveMQ Cloud    |
                                     |  MQTT Broker     |
                                     +--------+---------+
                                              | mqtts://
                                              v
                                     +------------------+
                                     |  flood-bridge    |    +-----------+
                                     |  (Node.js)       |--->|  NOAA API |
                                     |  Railway         |    | Weather + |
                                     +--------+---------+    | Tides    |
                                              |              +-----------+
                                              v           +-------------+
                                     +------------------+ | Claude API  |
                                     |  Supabase        |<| Infrastructure|
                                     |  PostgreSQL      | | Analysis    |
                                     +--------+---------+ +-------------+
                                              | Realtime
                                              v
                                     +------------------+
                                     |  flood-dashboard |
                                     |  (Next.js)       |
                                     |  Vercel          |
                                     +------------------+
```

## Key Features

- **Real-time flood detection** — ultrasonic sensors detect water within seconds
- **Precision elevation mapping** — BMP390 barometric altimeters (+-0.25m accuracy)
- **NOAA data correlation** — rainfall and tide data automatically attached to each flood event
- **Road dip detection** — elevation gradient analysis identifies natural water pooling locations
- **Compound event analysis** — identifies when rain + high tide combine to overwhelm drainage
- **AI infrastructure recommendations** — Claude analyzes all data sources to suggest specific improvements with cost estimates and flood reduction percentages
- **Live dashboard** — real-time map with Supabase realtime subscriptions
- **Water flow visualization** — directional flow lines on elevation map showing drainage patterns
- **Network health monitoring** — real-time fleet health percentage, stale sensor detection
- **Fleet management** — battery monitoring, offline detection, CSV export for sensors and events
- **Data freshness monitoring** — tracks sensor reporting recency (10min/1hr buckets)
- **Per-page loading states** — professional loading spinners on all pages
- **Supabase Realtime** — live updates on overview, sensors, flood events, and sidebar without page refresh
- **Browser tab titles** — per-page metadata for easy tab management

## Folder Structure

```
flood-finder-smart-city/
+-- supabase/
|   +-- schema.sql              # Database tables, indexes, RLS policies
+-- flood-bridge/
|   +-- bridge.js               # MQTT > Supabase bridge + AI cron job
|   +-- simulate.js             # Test simulator (20 fake Aventura devices)
|   +-- noaa.js                 # NOAA weather, rainfall, tide API client
|   +-- package.json
|   +-- .env.example
|   +-- railway.json
+-- flood-dashboard/
|   +-- app/                    # Next.js App Router pages
|   |   +-- page.tsx            # Live overview with map + weather
|   |   +-- sensors/            # Sensor management table
|   |   +-- flood-events/       # Flood event history + filters
|   |   +-- elevation/          # Elevation map + road dip analysis
|   |   +-- analytics/          # 9 charts including NOAA correlations
|   |   +-- ai-recommendations/ # AI infrastructure analysis
|   |   +-- api/                # Server routes (weather, analysis, export)
|   +-- components/             # Sidebar, Map, ElevationMap, StatCard, Sparkline
|   +-- lib/                    # Supabase client, typed queries, types
|   +-- .env.example
+-- firmware/
|   +-- flood_sensor/
|       +-- flood_sensor.ino    # Complete ESP32 Arduino sketch
+-- README.md
```

## Dashboard Pages

| Page | Description |
|------|-------------|
| **Overview** | Full-screen map with live sensor markers, weather panel (NOAA) with wind speed, 3-period forecast with rain probability, 24h tide forecast sparkline, compound flood risk alerts, network health indicator, data freshness panel, neighborhood quick-status, active flood events. Supabase realtime updates. |
| **Sensors** | Fleet summary stats, sortable/filterable data table with flood counts, expandable rows with distance and flood depth sparklines and detailed sensor info. CSV export with 30-day flood counts. Realtime device status updates. |
| **Flood Events** | Timeline with severity badges and COMPOUND event tags. Ongoing floods banner with pulsing elapsed time. Filters: neighborhood, severity, date range with clear button. Mini map for selected events. CSV export with all NOAA correlation data. Realtime updates. |
| **Elevation** | Elevation heatmap with water flow direction lines between sensors. Road dip detection with red-bordered markers. Neighborhood summary panel with per-area flood counts and dip detection. |
| **Analytics** | 10 charts: weekly trends, top flooding sensors, elevation vs flood frequency, depth vs rainfall, tide vs depth, time-of-day distribution, compound event breakdown, neighborhood comparison, duration vs depth, battery health. Auto-generated Key Insights panel with trend analysis. Summary stats row. |
| **AI Analysis** | On-demand Claude analysis with executive summary. Cross-references elevation gradients, water flow direction, NOAA data, flood frequency, risk scores, compound events. Titled recommendations with priority, category, cost estimate, and flood reduction percentage. |

## AI Analysis Engine

The analysis system computes derived metrics before sending to Claude:

1. **Per-sensor flood profiles** — frequency, avg/max depth, duration, rainfall correlation, tidal correlation, compound event count
2. **Flood risk scores** (0-100) — combines frequency, severity, low elevation, and road dip factors
3. **Elevation gradient analysis** — compares each sensor to its nearest neighbors using haversine distance, identifies road dips (>15cm below neighbors)
4. **Water flow direction** — bearing calculation shows which uphill sensors drain toward low points
5. **Neighborhood aggregation** — area-wide patterns for city planning
6. **Rainfall threshold analysis** — identifies minimum precipitation that triggers flooding
7. **Compound event detection** — flags events where rain + high tide occurred simultaneously (worst-case flooding because storm drains can't discharge into elevated tidal waterways)

## Setup Instructions

### 1. Supabase Setup

1. Create a project at [supabase.com](https://supabase.com)
2. Go to SQL Editor and paste the contents of `supabase/schema.sql`
3. Run the query to create all tables, indexes, and policies
4. Go to Settings > API to get your project URL, anon key, and service role key
5. Under Database > Replication, verify that `devices`, `sensor_readings`, and `flood_events` tables have realtime enabled

### 2. HiveMQ Setup

1. Create a free cluster at [hivemq.com/cloud](https://www.hivemq.com/mqtt-cloud-broker/)
2. Create MQTT credentials (username + password)
3. Note the cluster URL (e.g., `abc123.s1.eu.hivemq.cloud`)

### 3. Bridge Service Setup

```bash
cd flood-bridge
cp .env.example .env
# Fill in all values in .env
npm install
```

**Test with simulator:**
```bash
# Terminal 1: Start bridge
node bridge.js

# Terminal 2: Start simulator (seeds 20 devices into Supabase automatically)
node simulate.js
```

**Deploy to Railway:**
1. Push to a GitHub repo
2. Connect to Railway, set root directory to `flood-bridge`
3. Set all environment variables in Railway dashboard
4. Deploy

### 4. Dashboard Setup

```bash
cd flood-dashboard
cp .env.example .env.local
# Fill in all env vars (see reference below)
npm install
npm run dev
```

**Deploy to Vercel:**
1. Connect GitHub repo to Vercel
2. Set root directory to `flood-dashboard`
3. Add environment variables in Vercel dashboard
4. Deploy — auto-deploys on every push to main

### 5. Gateway Configuration

The LoRa gateway receives packets from sensors and publishes them to
HiveMQ via MQTT. Configure your gateway to:

- Listen on 915 MHz (US frequency)
- Publish received payloads to topic `floodfinder/sensors/{deviceId}`
- Connect to HiveMQ using TLS on port 8883

### 6. Firmware Flashing

1. Install Arduino IDE with Heltec ESP32 board package
2. Install libraries: TinyGPS++, Adafruit BMP3XX
3. Open `firmware/flood_sensor/flood_sensor.ino`
4. Change `DEVICE_ID` to the sensor's unique ID (e.g., "FF-042")
5. Flash to the Heltec board
6. On first boot, sensor auto-calibrates (keep road surface clear for 10 seconds)

## Environment Variables Reference

| Variable | Used By | Description |
|----------|---------|-------------|
| `MQTT_HOST` | Bridge | HiveMQ cluster hostname (no protocol prefix) |
| `MQTT_USER` | Bridge | MQTT username |
| `MQTT_PASS` | Bridge | MQTT password |
| `SUPABASE_URL` | Bridge | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Bridge, Dashboard API | Service role key (full access) |
| `ANTHROPIC_API_KEY` | Bridge, Dashboard API | Claude API key for AI analysis |
| `NEXT_PUBLIC_SUPABASE_URL` | Dashboard frontend | Same as SUPABASE_URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Dashboard frontend | Supabase anon key (read-only) |

## Adding a New Sensor

1. Flash firmware with a unique `DEVICE_ID` (format: `FF-XXX`)
2. Insert device record into Supabase:
   ```sql
   INSERT INTO devices (device_id, name, lat, lng, neighborhood)
   VALUES ('FF-042', 'Main St & 191st', 25.9571, -80.1385, 'Aventura North');
   ```
3. Mount on mailbox, power on — sensor auto-calibrates baseline distance
4. Verify data appears in dashboard within 10 minutes
5. Run AI analysis to include new sensor in infrastructure recommendations

## Data Flow

```
Sensor reads ultrasonic distance every 10 min (30 sec if flooding)
  -> LoRa packet to gateway
    -> Gateway publishes to HiveMQ MQTT
      -> Bridge service receives, validates, computes flood depth
        -> Inserts reading into sensor_readings table
        -> Updates device status and battery
        -> If flooding: creates/updates flood_event with NOAA data
        -> If flood ended: closes flood_event with ended_at timestamp
          -> Dashboard picks up changes via Supabase Realtime
            -> Map markers update in real-time without page refresh
```

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Bridge won't connect to MQTT | Check MQTT_HOST doesn't include `mqtts://` prefix. Verify credentials. |
| No data in dashboard | Check bridge logs. Verify Supabase URL and keys. Check RLS policies are created. |
| Sensor shows offline | Check battery. Verify LoRa gateway is powered and in range. No ping in 2 hours = offline. |
| GPS "No fix" | Normal indoors. GPS needs clear sky view. Uses last known position as fallback. |
| AI analysis returns empty | Need at least 1 flood event in last 30 days. Run simulator to generate test data. |
| Map not loading | Leaflet CSS must be imported. Check for ad-blockers blocking CARTO tile server. |
| Readings seem wrong | Re-calibrate: clear EEPROM byte at address 0, reboot. Sensor takes 20 new baseline readings. |
| Weather API returns null | NOAA API may be temporarily down. Data is cached 10 min. Non-critical — system works without it. |
| Simulator FK errors | Simulator auto-seeds devices on connect. If DB was reset, restart simulator. |
