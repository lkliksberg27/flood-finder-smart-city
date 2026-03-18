import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

/**
 * Sensor placement at verified Golden Beach intersections.
 *
 * Coordinates sourced from OpenStreetMap + US Census geocoding:
 * - Ocean Blvd (A1A): lng -80.1196 (north) to -80.1200 (south)
 * - Golden Beach Dr:  lng -80.1206 (north) to -80.1212 (south)
 *
 * Each sensor is at a real cross-street intersection on one of these
 * two N-S roads. Paired sensors share the same cross street so flood
 * water visualisation naturally connects across the road network.
 *
 * Elevation decreases south → more flood-prone near Terracina/194th.
 */
const SENSOR_GRID = [
  // ── Ocean Blvd (A1A — main coastal N-S road) ──
  { id: "FF-001", name: "Ocean Blvd @ Holiday Dr",      lat: 25.97510, lng: -80.11960, altBaro: 2.40, hood: "North Golden Beach" },
  { id: "FF-002", name: "Ocean Blvd @ Navona Ave",      lat: 25.97230, lng: -80.11950, altBaro: 2.20, hood: "North Golden Beach" },
  { id: "FF-003", name: "Ocean Blvd @ N Parkway",       lat: 25.97100, lng: -80.11950, altBaro: 2.00, hood: "North Golden Beach" },
  { id: "FF-004", name: "Ocean Blvd @ Palermo Ave",     lat: 25.96940, lng: -80.11950, altBaro: 1.80, hood: "Central Golden Beach" },
  { id: "FF-005", name: "Ocean Blvd @ Golden Beach Dr", lat: 25.96630, lng: -80.11970, altBaro: 1.60, hood: "Central Golden Beach" },
  { id: "FF-006", name: "Ocean Blvd @ S Parkway",       lat: 25.96500, lng: -80.11970, altBaro: 1.40, hood: "Central Golden Beach" },
  { id: "FF-007", name: "Ocean Blvd @ Ravenna Ave",     lat: 25.96330, lng: -80.11980, altBaro: 1.15, hood: "South Golden Beach" },
  { id: "FF-008", name: "Ocean Blvd @ Verona Ave",      lat: 25.96020, lng: -80.11990, altBaro: 0.90, hood: "South Golden Beach" },
  { id: "FF-009", name: "Ocean Blvd @ S Island Rd",     lat: 25.95870, lng: -80.11990, altBaro: 0.65, hood: "South Golden Beach" },
  { id: "FF-010", name: "Ocean Blvd @ Terracina Ave",   lat: 25.95710, lng: -80.12000, altBaro: 0.45, hood: "South Golden Beach" },
  { id: "FF-011", name: "Ocean Blvd @ 194th Ln",        lat: 25.95600, lng: -80.12000, altBaro: 0.30, hood: "South Golden Beach" },

  // ── Golden Beach Dr (parallel N-S road, one block west) ──
  { id: "FF-012", name: "Golden Beach Dr @ Centre Is",     lat: 25.96630, lng: -80.12090, altBaro: 1.50, hood: "Central Golden Beach" },
  { id: "FF-013", name: "Golden Beach Dr @ S Parkway",     lat: 25.96500, lng: -80.12090, altBaro: 1.35, hood: "Central Golden Beach" },
  { id: "FF-014", name: "Golden Beach Dr @ Palermo Ave",   lat: 25.96940, lng: -80.12080, altBaro: 1.70, hood: "Central Golden Beach" },
  { id: "FF-015", name: "Golden Beach Dr @ Ravenna Ave",   lat: 25.96330, lng: -80.12100, altBaro: 1.30, hood: "South Golden Beach" },
  { id: "FF-016", name: "Golden Beach Dr @ Navona Ave",    lat: 25.97230, lng: -80.12070, altBaro: 2.10, hood: "North Golden Beach" },
  { id: "FF-017", name: "Golden Beach Dr @ Holiday Dr",    lat: 25.97510, lng: -80.12060, altBaro: 2.30, hood: "North Golden Beach" },
  { id: "FF-018", name: "Golden Beach Dr @ Verona Ave",    lat: 25.96020, lng: -80.12120, altBaro: 0.80, hood: "South Golden Beach" },
  { id: "FF-019", name: "Golden Beach Dr @ Terracina Ave", lat: 25.95710, lng: -80.12120, altBaro: 0.35, hood: "South Golden Beach" },
  { id: "FF-020", name: "Golden Beach Dr @ S Island Rd",   lat: 25.95870, lng: -80.12120, altBaro: 0.55, hood: "South Golden Beach" },
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
        status: (i < 19 ? "online" : "offline") as "online" | "offline" | "alert",
        battery_v: parseFloat(randomBetween(3.0, 4.2).toFixed(2)),
        last_seen: i < 19
          ? new Date(Date.now() - Math.random() * 600000).toISOString()
          : new Date(Date.now() - 5 * 3600000).toISOString(),
        installed_at: randomDate(90),
        neighborhood: s.hood,
      };
    });

    // ── 2. Seed flood events — biased toward low-elevation sensors ──
    const floodEvents = [];

    // Active floods on lowest-elevation sensors
    const lowestSensors = [...devices]
      .sort((a, b) => (a.altitude_baro - a.baseline_distance_cm / 100) - (b.altitude_baro - b.baseline_distance_cm / 100))
      .slice(0, 6);

    // Mark flooding devices as "alert"
    const floodingIds = new Set(lowestSensors.map(d => d.device_id));
    devices.forEach(d => {
      if (floodingIds.has(d.device_id)) d.status = "alert";
    });

    for (const dev of devices) {
      await supabase.from("devices").upsert(dev, { onConflict: "device_id" });
    }

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
          distance_cm: distanceCm,
          water_detected: floodDepth > 0,
          flood_depth_cm: floodDepth,
          battery_v: dev.battery_v,
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
