import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

const NEIGHBORHOODS = [
  "Aventura North", "Aventura South", "Aventura West",
  "Country Club", "Turnberry", "Biscayne Yacht Club",
  "Mystic Pointe", "Williams Island",
];

const STREET_NAMES = [
  "NE 213th St", "NE 207th St", "NE 199th St", "Aventura Blvd",
  "Biscayne Blvd", "Country Club Dr", "Yacht Club Way", "Mystic Pointe Dr",
  "Island Blvd", "NE 190th St", "Turnberry Way", "NE 203rd St",
  "Waterways Blvd", "NE 195th St", "NE 185th St", "Lehman Causeway",
  "William Lehman Causeway", "NE 29th Ave", "NE 34th Ave", "NE 188th St",
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

    // ── 1. Seed 20 devices ─────────────────────────────
    const devices = Array.from({ length: 20 }, (_, i) => {
      const id = `FF-${String(i + 1).padStart(3, "0")}`;
      // Cluster devices realistically around Aventura
      const baseLat = 25.94;
      const baseLng = -80.14;
      const lat = baseLat + (i % 5) * 0.005 + randomBetween(-0.002, 0.002);
      const lng = baseLng + Math.floor(i / 5) * 0.006 + randomBetween(-0.002, 0.002);
      const altBaro = parseFloat(randomBetween(0.4, 2.2).toFixed(2));

      return {
        device_id: id,
        name: STREET_NAMES[i],
        lat: parseFloat(lat.toFixed(6)),
        lng: parseFloat(lng.toFixed(6)),
        altitude_baro: altBaro,
        mailbox_height_cm: 95,
        baseline_distance_cm: 90 + Math.floor(Math.random() * 6),
        status: i < 16 ? "online" : i < 18 ? "alert" : "offline",
        battery_v: parseFloat(randomBetween(2.9, 4.2).toFixed(2)),
        last_seen: i < 18
          ? new Date(Date.now() - Math.random() * 600000).toISOString()
          : new Date(Date.now() - 5 * 3600000).toISOString(),
        installed_at: randomDate(90),
        neighborhood: NEIGHBORHOODS[i % NEIGHBORHOODS.length],
      };
    });

    for (const dev of devices) {
      await supabase.from("devices").upsert(dev, { onConflict: "device_id" });
    }

    // ── 2. Seed flood events (60-80 events over 30 days) ────
    const eventCount = 60 + Math.floor(Math.random() * 20);
    const floodEvents = [];

    for (let i = 0; i < eventCount; i++) {
      const dev = devices[Math.floor(Math.random() * devices.length)];
      // Lower elevation devices flood more
      const elevBias = dev.altitude_baro < 1.2 ? 0.4 : dev.altitude_baro < 1.6 ? 0.25 : 0.1;
      if (Math.random() > elevBias && dev.altitude_baro > 1.0) {
        // Skip some events for high-elevation sensors
        if (Math.random() > 0.3) continue;
      }

      const startedAt = new Date(Date.now() - Math.random() * 28 * 86400 * 1000);
      const durationMin = Math.floor(randomBetween(8, 180));
      const endedAt = new Date(startedAt.getTime() + durationMin * 60000);
      const peakDepth = Math.floor(randomBetween(3, 55));
      const hasRain = Math.random() < 0.65;
      const hasTide = Math.random() < 0.4;

      floodEvents.push({
        device_id: dev.device_id,
        started_at: startedAt.toISOString(),
        ended_at: endedAt.toISOString(),
        peak_depth_cm: peakDepth,
        duration_minutes: durationMin,
        rainfall_mm: hasRain ? parseFloat(randomBetween(2, 45).toFixed(1)) : null,
        tide_level_m: hasTide ? parseFloat(randomBetween(0.1, 0.8).toFixed(2)) : null,
      });
    }

    // Insert in batches
    for (let i = 0; i < floodEvents.length; i += 20) {
      const batch = floodEvents.slice(i, i + 20);
      const { error } = await supabase.from("flood_events").insert(batch);
      if (error) console.error("[SEED] Flood events batch error:", error.message);
    }

    // ── 3. Seed some sensor readings for recent 24h ────
    const readings = [];
    for (const dev of devices.slice(0, 16)) {
      for (let h = 0; h < 24; h += 2) {
        const recordedAt = new Date(Date.now() - h * 3600000);
        const isFlooding = Math.random() < 0.08;
        const distanceCm = isFlooding
          ? Math.floor(randomBetween(40, 80))
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

    for (let i = 0; i < readings.length; i += 50) {
      const batch = readings.slice(i, i + 50);
      await supabase.from("sensor_readings").insert(batch);
    }

    return NextResponse.json({
      message: `Seeded ${devices.length} devices, ${floodEvents.length} flood events, ${readings.length} readings`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Seed failed";
    console.error("[SEED] Error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
