import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

/**
 * Dense sensor placement along real Aventura streets.
 * Sensors are positioned at actual intersections for realistic flood mapping.
 * Elevation gradient: lower near Biscayne Blvd (east), higher inland (west).
 * Southern sensors are lower than northern ones (natural drainage toward coast).
 */
const SENSOR_GRID = [
  // ── Row 1: NE 199th St (northernmost) ──
  { id: "FF-001", name: "NE 199th & Biscayne Blvd",  lat: 25.95965, lng: -80.14250, altBaro: 1.58, hood: "Biscayne Corridor" },
  { id: "FF-002", name: "NE 199th & NE 29th Ave",    lat: 25.95945, lng: -80.13680, altBaro: 1.82, hood: "Central Aventura" },
  { id: "FF-003", name: "NE 199th & NE 30th Ave",    lat: 25.95930, lng: -80.13200, altBaro: 2.05, hood: "West Aventura" },

  // ── Row 2: NE 197th St ──
  { id: "FF-004", name: "NE 197th & Biscayne Blvd",  lat: 25.95750, lng: -80.14220, altBaro: 1.32, hood: "Biscayne Corridor" },
  { id: "FF-005", name: "NE 197th & NE 29th Ct",     lat: 25.95730, lng: -80.13650, altBaro: 1.55, hood: "Central Aventura" },

  // ── Row 3: W Country Club Dr / NE 195th St ──
  { id: "FF-006", name: "Country Club & Biscayne",    lat: 25.95545, lng: -80.14180, altBaro: 0.88, hood: "Biscayne Corridor" },
  { id: "FF-007", name: "Country Club & NE 29th Ave", lat: 25.95530, lng: -80.13620, altBaro: 1.18, hood: "Central Aventura" },
  { id: "FF-008", name: "Country Club & NE 30th Ave", lat: 25.95510, lng: -80.13150, altBaro: 1.68, hood: "West Aventura" },

  // ── Row 4: NE 193rd St ──
  { id: "FF-009", name: "NE 193rd & Biscayne Blvd",  lat: 25.95340, lng: -80.14160, altBaro: 0.72, hood: "Biscayne Corridor" },
  { id: "FF-010", name: "NE 193rd & NE 29th Ave",    lat: 25.95320, lng: -80.13580, altBaro: 1.08, hood: "Central Aventura" },
  { id: "FF-011", name: "NE 193rd & NE 30th Ave",    lat: 25.95300, lng: -80.13120, altBaro: 1.42, hood: "West Aventura" },

  // ── Row 5: NE 191st St ──
  { id: "FF-012", name: "NE 191st & Biscayne Blvd",  lat: 25.95160, lng: -80.14130, altBaro: 0.52, hood: "Biscayne Corridor" },
  { id: "FF-013", name: "NE 191st & NE 29th Pl",     lat: 25.95145, lng: -80.13600, altBaro: 0.82, hood: "Central Aventura" },
  { id: "FF-014", name: "NE 191st & NE 30th Ave",    lat: 25.95125, lng: -80.13180, altBaro: 1.28, hood: "West Aventura" },

  // ── Row 6: NE 190th St ──
  { id: "FF-015", name: "NE 190th & Biscayne Blvd",  lat: 25.95060, lng: -80.14100, altBaro: 0.38, hood: "Biscayne Corridor" },
  { id: "FF-016", name: "NE 190th & NE 29th Ave",    lat: 25.95040, lng: -80.13560, altBaro: 0.68, hood: "Central Aventura" },

  // ── Row 7: NE 188th St ──
  { id: "FF-017", name: "NE 188th & Biscayne Blvd",  lat: 25.94860, lng: -80.14080, altBaro: 0.30, hood: "Biscayne Corridor" },
  { id: "FF-018", name: "NE 188th & NE 29th Ave",    lat: 25.94840, lng: -80.13520, altBaro: 0.58, hood: "Central Aventura" },
  { id: "FF-019", name: "NE 188th & NE 30th Ave",    lat: 25.94820, lng: -80.13100, altBaro: 1.12, hood: "West Aventura" },

  // ── Row 8: NE 187th Ter (southernmost) ──
  { id: "FF-020", name: "NE 187th & Biscayne Blvd",  lat: 25.94760, lng: -80.14060, altBaro: 0.22, hood: "Biscayne Corridor" },
];

function randomBetween(min: number, max: number) {
  return min + Math.random() * (max - min);
}

function randomDate(daysAgo: number) {
  return new Date(Date.now() - Math.random() * daysAgo * 86400 * 1000).toISOString();
}

export async function POST() {
  try {
    const supabase = createServiceClient();

    // ── 1. Seed 20 devices at exact street intersections ──
    const devices = SENSOR_GRID.map((s, i) => {
      const baselineCm = 90 + Math.floor(Math.random() * 6);
      // Street elevation = altBaro - baseline/100
      // Low-elev sensors near Biscayne Blvd are most flood-prone
      return {
        device_id: s.id,
        name: s.name,
        lat: s.lat,
        lng: s.lng,
        altitude_baro: s.altBaro,
        mailbox_height_cm: 95,
        baseline_distance_cm: baselineCm,
        status: s.altBaro < 0.5 ? "alert" : i < 19 ? "online" : "offline" as const,
        battery_v: parseFloat(randomBetween(3.0, 4.2).toFixed(2)),
        last_seen: i < 19
          ? new Date(Date.now() - Math.random() * 600000).toISOString()
          : new Date(Date.now() - 5 * 3600000).toISOString(),
        installed_at: randomDate(90),
        neighborhood: s.hood,
      };
    });

    for (const dev of devices) {
      await supabase.from("devices").upsert(dev, { onConflict: "device_id" });
    }

    // ── 2. Seed flood events — biased toward low-elevation sensors ──
    // Includes 4-6 ACTIVE floods (no ended_at) on the lowest sensors
    const floodEvents = [];

    // Active floods on lowest-elevation sensors (Biscayne Corridor)
    const lowestSensors = [...devices]
      .sort((a, b) => (a.altitude_baro - a.baseline_distance_cm / 100) - (b.altitude_baro - b.baseline_distance_cm / 100))
      .slice(0, 6);
    for (const dev of lowestSensors) {
      const streetElev = dev.altitude_baro - dev.baseline_distance_cm / 100;
      const elevFactor = Math.max(0.3, 1 - (streetElev + 0.7));
      const peakDepth = Math.floor(randomBetween(8, 30) * elevFactor + 5);
      floodEvents.push({
        device_id: dev.device_id,
        started_at: new Date(Date.now() - Math.floor(randomBetween(10, 90)) * 60000).toISOString(),
        ended_at: null, // ACTIVE — not ended yet
        peak_depth_cm: peakDepth,
        rainfall_mm: parseFloat(randomBetween(8, 35).toFixed(1)),
        tide_level_m: parseFloat(randomBetween(0.2, 0.55).toFixed(2)),
      });
    }

    // Historical floods (ended)
    for (let i = 0; i < 74; i++) {
      const weights = devices.map(d => {
        const streetElev = d.altitude_baro - d.baseline_distance_cm / 100;
        return Math.max(0.1, 1 - (streetElev + 0.7));
      });
      const totalWeight = weights.reduce((a, b) => a + b, 0);
      let rand = Math.random() * totalWeight;
      let devIdx = 0;
      for (let j = 0; j < weights.length; j++) {
        rand -= weights[j];
        if (rand <= 0) { devIdx = j; break; }
      }
      const dev = devices[devIdx];

      const startedAt = new Date(Date.now() - Math.random() * 28 * 86400 * 1000);
      const streetElev = dev.altitude_baro - dev.baseline_distance_cm / 100;
      const elevFactor = Math.max(0.2, 1 - (streetElev + 0.7));
      const durationMin = Math.floor(randomBetween(10, 120) * elevFactor + 15);
      const endedAt = new Date(startedAt.getTime() + durationMin * 60000);
      const peakDepth = Math.floor(randomBetween(5, 35) * elevFactor + 5);
      const hasRain = Math.random() < 0.7;
      const hasTide = Math.random() < 0.45;

      floodEvents.push({
        device_id: dev.device_id,
        started_at: startedAt.toISOString(),
        ended_at: endedAt.toISOString(),
        peak_depth_cm: peakDepth,
        rainfall_mm: hasRain ? parseFloat(randomBetween(5, 50).toFixed(1)) : null,
        tide_level_m: hasTide ? parseFloat(randomBetween(0.15, 0.7).toFixed(2)) : null,
      });
    }

    // Insert flood events in batches
    const floodErrors: string[] = [];
    let floodInserted = 0;
    for (let i = 0; i < floodEvents.length; i += 20) {
      const batch = floodEvents.slice(i, i + 20);
      const { error, data: inserted } = await supabase.from("flood_events").insert(batch).select("id");
      if (error) {
        floodErrors.push(error.message);
        console.error("[SEED] Flood events batch error:", error.message);
      } else {
        floodInserted += inserted?.length ?? batch.length;
      }
    }

    // ── 3. Seed sensor readings for recent 24h ──
    const readings = [];
    for (const dev of devices.filter(d => d.status !== "offline")) {
      const streetElev = dev.altitude_baro - dev.baseline_distance_cm / 100;
      for (let h = 0; h < 24; h += 2) {
        const recordedAt = new Date(Date.now() - h * 3600000);
        // Low-elevation sensors more likely to show water
        const floodChance = Math.max(0.02, 0.15 - streetElev * 0.1);
        const isFlooding = Math.random() < floodChance;
        const distanceCm = isFlooding
          ? Math.floor(randomBetween(45, 80))
          : Math.floor(randomBetween(88, 96));
        const floodDepth = Math.max(0, 95 - distanceCm - 5);

        readings.push({
          device_id: dev.device_id,
          lat: dev.lat,
          lng: dev.lng,
          altitude_gps: dev.altitude_baro + randomBetween(-0.5, 0.5),
          altitude_baro: dev.altitude_baro,
          distance_cm: distanceCm,
          water_detected: floodDepth > 0,
          flood_depth_cm: floodDepth,
          battery_v: dev.battery_v,
          rssi: Math.floor(randomBetween(-90, -50)),
          is_valid: true,
          recorded_at: recordedAt.toISOString(),
        });
      }
    }

    const readingErrors: string[] = [];
    let readingsInserted = 0;
    for (let i = 0; i < readings.length; i += 50) {
      const batch = readings.slice(i, i + 50);
      const { error, data: inserted } = await supabase.from("sensor_readings").insert(batch).select("id");
      if (error) {
        readingErrors.push(error.message);
      } else {
        readingsInserted += inserted?.length ?? batch.length;
      }
    }

    return NextResponse.json({
      message: `Seeded ${devices.length} devices, ${floodInserted}/${floodEvents.length} flood events, ${readingsInserted}/${readings.length} readings`,
      floodErrors: floodErrors.length > 0 ? floodErrors : undefined,
      readingErrors: readingErrors.length > 0 ? readingErrors : undefined,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Seed failed";
    console.error("[SEED] Error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
