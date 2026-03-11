import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

/**
 * Sensor placement along real Golden Beach streets.
 * Ocean Blvd (lng ≈ -80.11960) is the main N-S road through Golden Beach.
 * Golden Beach Dr is a key E-W cross street at lat ≈ 25.96630.
 * Elevation: southern end lower (more flood-prone), northern end higher.
 */
const SENSOR_GRID = [
  // ── Ocean Blvd (main N-S road, lng -80.11960) ──
  { id: "FF-001", name: "Ocean Blvd @ North Park",      lat: 25.97400, lng: -80.11960, altBaro: 2.40, hood: "North Golden Beach" },
  { id: "FF-002", name: "Ocean Blvd @ Palermo Ave",     lat: 25.97200, lng: -80.11960, altBaro: 2.20, hood: "North Golden Beach" },
  { id: "FF-003", name: "Ocean Blvd @ NE 207th Ter",    lat: 25.97000, lng: -80.11960, altBaro: 2.00, hood: "North Golden Beach" },
  { id: "FF-004", name: "Ocean Blvd @ The Strand N",    lat: 25.96800, lng: -80.11960, altBaro: 1.80, hood: "Central Golden Beach" },
  { id: "FF-005", name: "Ocean Blvd @ Golden Beach Dr", lat: 25.96630, lng: -80.11960, altBaro: 1.60, hood: "Central Golden Beach" },
  { id: "FF-006", name: "Ocean Blvd @ The Strand S",    lat: 25.96450, lng: -80.11960, altBaro: 1.40, hood: "Central Golden Beach" },
  { id: "FF-007", name: "Ocean Blvd @ NE 199th Ter",    lat: 25.96250, lng: -80.11960, altBaro: 1.15, hood: "South Golden Beach" },
  { id: "FF-008", name: "Ocean Blvd @ Ravenna Ave",     lat: 25.96100, lng: -80.11960, altBaro: 0.90, hood: "South Golden Beach" },
  { id: "FF-009", name: "Ocean Blvd @ South Park",      lat: 25.95950, lng: -80.11960, altBaro: 0.65, hood: "South Golden Beach" },
  { id: "FF-010", name: "Ocean Blvd @ S Island Rd",     lat: 25.95800, lng: -80.11960, altBaro: 0.45, hood: "South Golden Beach" },
  { id: "FF-011", name: "Ocean Blvd South End",         lat: 25.95650, lng: -80.11960, altBaro: 0.30, hood: "South Golden Beach" },

  // ── Golden Beach Dr (E-W cross street, lat 25.96630) ──
  { id: "FF-012", name: "Golden Beach Dr West",         lat: 25.96630, lng: -80.12080, altBaro: 1.50, hood: "Central Golden Beach" },
  { id: "FF-013", name: "Golden Beach Dr Mid",          lat: 25.96630, lng: -80.12200, altBaro: 1.35, hood: "Central Golden Beach" },

  // ── The Strand / Centre Is Dr (cross streets) ──
  { id: "FF-014", name: "Centre Is Dr @ The Strand",    lat: 25.96800, lng: -80.12080, altBaro: 1.70, hood: "Central Golden Beach" },
  { id: "FF-015", name: "The Strand South",             lat: 25.96450, lng: -80.12080, altBaro: 1.30, hood: "Central Golden Beach" },

  // ── Northern cross streets ──
  { id: "FF-016", name: "Palermo Ave West",             lat: 25.97200, lng: -80.12080, altBaro: 2.10, hood: "North Golden Beach" },
  { id: "FF-017", name: "N Pkwy West",                  lat: 25.97400, lng: -80.12080, altBaro: 2.30, hood: "North Golden Beach" },

  // ── Southern cross streets ──
  { id: "FF-018", name: "Ravenna Ave West",             lat: 25.96100, lng: -80.12080, altBaro: 0.80, hood: "South Golden Beach" },
  { id: "FF-019", name: "S Island Rd West",             lat: 25.95800, lng: -80.12080, altBaro: 0.35, hood: "South Golden Beach" },
  { id: "FF-020", name: "South Park West",              lat: 25.95950, lng: -80.12080, altBaro: 0.55, hood: "South Golden Beach" },
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

    // ── 0. Clear old data ──
    await supabase.from("sensor_readings").delete().neq("id", 0);
    await supabase.from("flood_events").delete().neq("id", 0);

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
