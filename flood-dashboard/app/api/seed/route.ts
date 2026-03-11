import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

/**
 * Sensor placement along residential Golden Beach streets.
 * Sensors at real intersections along A1A, cross streets, and Ocean Dr.
 * Elevation: lower along A1A (Intracoastal side), higher near beach (east).
 * Southern sensors are lower than northern (natural coastal gradient).
 */
const SENSOR_GRID = [
  // ── Row 1: NE 209th St (northernmost) ──
  { id: "FF-001", name: "A1A & NE 209th St",        lat: 25.97380, lng: -80.12220, altBaro: 2.15, hood: "North Golden Beach" },
  { id: "FF-002", name: "Ocean Dr & NE 209th St",   lat: 25.97380, lng: -80.11950, altBaro: 2.40, hood: "North Golden Beach" },

  // ── Row 2: NE 206th St ──
  { id: "FF-003", name: "A1A & NE 206th St",        lat: 25.97150, lng: -80.12200, altBaro: 1.95, hood: "North Golden Beach" },
  { id: "FF-004", name: "Terrace Dr & NE 206th St", lat: 25.97150, lng: -80.12050, altBaro: 2.10, hood: "North Golden Beach" },

  // ── Row 3: NE 203rd St ──
  { id: "FF-005", name: "A1A & NE 203rd St",        lat: 25.96920, lng: -80.12180, altBaro: 1.75, hood: "Central Golden Beach" },
  { id: "FF-006", name: "Ocean Dr & NE 203rd St",   lat: 25.96920, lng: -80.11920, altBaro: 2.05, hood: "Central Golden Beach" },

  // ── Row 4: Golden Beach Dr (main E-W road) ──
  { id: "FF-007", name: "A1A & Golden Beach Dr",        lat: 25.96750, lng: -80.12160, altBaro: 1.50, hood: "Central Golden Beach" },
  { id: "FF-008", name: "Terrace Dr & Golden Beach Dr", lat: 25.96750, lng: -80.12020, altBaro: 1.72, hood: "Central Golden Beach" },
  { id: "FF-009", name: "Ocean Dr & Golden Beach Dr",   lat: 25.96750, lng: -80.11900, altBaro: 1.90, hood: "Central Golden Beach" },

  // ── Row 5: NE 199th St ──
  { id: "FF-010", name: "A1A & NE 199th St",        lat: 25.96550, lng: -80.12140, altBaro: 1.30, hood: "South Golden Beach" },
  { id: "FF-011", name: "Terrace Dr & NE 199th St", lat: 25.96550, lng: -80.12000, altBaro: 1.55, hood: "South Golden Beach" },

  // ── Row 6: NE 197th St ──
  { id: "FF-012", name: "A1A & NE 197th St",        lat: 25.96380, lng: -80.12120, altBaro: 1.05, hood: "South Golden Beach" },
  { id: "FF-013", name: "Ocean Dr & NE 197th St",   lat: 25.96380, lng: -80.11880, altBaro: 1.40, hood: "South Golden Beach" },

  // ── Row 7: NE 195th St ──
  { id: "FF-014", name: "A1A & NE 195th St",        lat: 25.96220, lng: -80.12100, altBaro: 0.80, hood: "South Golden Beach" },
  { id: "FF-015", name: "Terrace Dr & NE 195th St", lat: 25.96220, lng: -80.11980, altBaro: 1.10, hood: "South Golden Beach" },
  { id: "FF-016", name: "Ocean Dr & NE 195th St",   lat: 25.96220, lng: -80.11870, altBaro: 1.30, hood: "South Golden Beach" },

  // ── Row 8: NE 193rd St (southernmost) ──
  { id: "FF-017", name: "A1A & NE 193rd St",        lat: 25.96050, lng: -80.12080, altBaro: 0.55, hood: "South Golden Beach" },
  { id: "FF-018", name: "Terrace Dr & NE 193rd St", lat: 25.96050, lng: -80.11960, altBaro: 0.85, hood: "South Golden Beach" },

  // ── Extra sensors ──
  { id: "FF-019", name: "A1A & NE 201st St",  lat: 25.96730, lng: -80.12170, altBaro: 1.62, hood: "Central Golden Beach" },
  { id: "FF-020", name: "A1A & NE 192nd St",  lat: 25.95980, lng: -80.12070, altBaro: 0.40, hood: "South Golden Beach" },
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

    // ── 1. Seed 20 devices at residential intersections ──
    const devices = SENSOR_GRID.map((s, i) => {
      const baselineCm = 90 + Math.floor(Math.random() * 6);
      return {
        device_id: s.id,
        name: s.name,
        lat: s.lat,
        lng: s.lng,
        altitude_baro: s.altBaro,
        mailbox_height_cm: 95,
        baseline_distance_cm: baselineCm,
        status: s.altBaro < 0.6 ? "alert" : i < 19 ? "online" : "offline" as const,
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
    const floodEvents = [];

    // Active floods on lowest-elevation sensors
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
