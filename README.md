# Flood Finder — Smart City Flood Monitoring System

Real-time city-wide flood detection network for Aventura, Florida.
Sensors mounted on mailboxes measure water levels using ultrasonic distance
sensors and communicate via LoRa to a cloud backend.

## System Architecture

```
  ┌──────────────┐     LoRa 915MHz     ┌──────────────┐
  │  Mailbox     │ ──────────────────►  │  Gateway     │
  │  Sensor x N  │                      │  (LoRa→WiFi) │
  │  ESP32+HC-SR04                      └──────┬───────┘
  │  +BMP390+GPS │                             │ MQTT
  │  +Solar      │                             ▼
  └──────────────┘                   ┌──────────────────┐
                                     │  HiveMQ Cloud    │
                                     │  MQTT Broker     │
                                     └────────┬─────────┘
                                              │ mqtts://
                                              ▼
                                     ┌──────────────────┐
                                     │  flood-bridge    │    ┌───────────┐
                                     │  (Node.js)       │───►│  NOAA API │
                                     │  Railway         │    └───────────┘
                                     └────────┬─────────┘
                                              │           ┌─────────────┐
                                              ▼           │ Claude API  │
                                     ┌──────────────────┐ │ (weekly AI  │
                                     │  Supabase        │◄┤  analysis)  │
                                     │  PostgreSQL      │ └─────────────┘
                                     └────────┬─────────┘
                                              │ Realtime
                                              ▼
                                     ┌──────────────────┐
                                     │  flood-dashboard │
                                     │  (Next.js)       │
                                     │  Vercel          │
                                     └──────────────────┘
```

## Folder Structure

```
flood-finder-smart-city/
├── supabase/
│   └── schema.sql              # Database tables, indexes, RLS
├── flood-bridge/
│   ├── bridge.js               # MQTT → Supabase bridge + AI cron
│   ├── simulate.js             # Test simulator (20 fake devices)
│   ├── noaa.js                 # NOAA weather & tide API client
│   ├── package.json
│   ├── .env.example
│   └── railway.json
├── flood-dashboard/
│   ├── app/                    # Next.js app router pages
│   ├── components/             # Sidebar, Map, StatCard
│   ├── lib/                    # Supabase client, queries, types
│   └── .env.example
├── firmware/
│   └── flood_sensor/
│       └── flood_sensor.ino    # ESP32 Arduino sketch
└── README.md
```

## Setup Instructions

### 1. Supabase Setup

1. Create a project at [supabase.com](https://supabase.com)
2. Go to SQL Editor and paste the contents of `supabase/schema.sql`
3. Run the query to create all tables, indexes, and policies
4. Go to Settings → API to get your project URL, anon key, and service role key

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

# Terminal 2: Start simulator
node simulate.js
```

**Deploy to Railway:**
1. Push to a GitHub repo
2. Connect to Railway, point at the `flood-bridge/` directory
3. Set all environment variables in Railway dashboard
4. Deploy

### 4. Dashboard Setup

```bash
cd flood-dashboard
cp .env.example .env.local
# Fill in NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY
npm install
npm run dev
```

**Deploy to Vercel:**
1. Connect GitHub repo to Vercel
2. Set root directory to `flood-dashboard`
3. Add environment variables in Vercel dashboard
4. Deploy

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
6. On first boot, sensor auto-calibrates (keep road surface clear)

## Environment Variables Reference

| Variable | Used By | Description |
|----------|---------|-------------|
| `MQTT_HOST` | Bridge | HiveMQ cluster hostname |
| `MQTT_USER` | Bridge | MQTT username |
| `MQTT_PASS` | Bridge | MQTT password |
| `SUPABASE_URL` | Bridge, Dashboard API | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Bridge, Dashboard API | Service role key (full access) |
| `SUPABASE_ANON_KEY` | — | Anon key (used in NEXT_PUBLIC_ form) |
| `ANTHROPIC_API_KEY` | Bridge, Dashboard API | Claude API key for AI analysis |
| `NEXT_PUBLIC_SUPABASE_URL` | Dashboard frontend | Same as SUPABASE_URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Dashboard frontend | Supabase anon key |

## Adding a New Sensor

1. Flash firmware with a unique `DEVICE_ID` (format: `FF-XXX`)
2. Insert device record into Supabase:
   ```sql
   INSERT INTO devices (device_id, name, lat, lng, neighborhood)
   VALUES ('FF-042', 'Main St & 191st', 25.9571, -80.1385, 'Aventura North');
   ```
3. Mount on mailbox, power on — sensor auto-calibrates
4. Verify data appears in dashboard within 10 minutes

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Bridge won't connect to MQTT | Check MQTT_HOST doesn't include `mqtts://` prefix. Verify credentials. |
| No data in dashboard | Check bridge logs. Verify Supabase URL and keys. Check RLS policies. |
| Sensor shows offline | Check battery. Verify LoRa gateway is powered and in range. |
| GPS "No fix" | Normal indoors. GPS needs clear sky view. Uses last known position. |
| AI analysis returns empty | Need at least 1 flood event in last 30 days. Run simulator first. |
| Map not loading | Leaflet CSS must be imported. Check for ad-blockers blocking tile server. |
| Readings seem wrong | Re-calibrate sensor: clear EEPROM byte at address 0, reboot device. |
