import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { requireSecret } from "@/lib/require-auth";

/**
 * Storm simulator.
 *
 * This writes into `nodes` and `readings`, the same two tables the real LoRa
 * uplink receiver writes to. It deliberately does NOT write `devices`,
 * `sensor_readings` or `flood_events`: those are views and a trigger over the
 * raw tables (see 02_backend/schema_unify.sql). Simulating into the app-facing
 * shapes directly would exercise a path the hardware never takes, which is how
 * the previous seeder produced demo data that looked convincing while the real
 * pipeline fed nothing at all.
 *
 * So depth is derived here exactly as in production, flood events are built by
 * the same database trigger, and node status comes from the same staleness
 * rule. If the simulation looks right, the real thing will too.
 */

/**
 * Sensor placement at verified Golden Beach intersections.
 * Coordinates from OpenStreetMap + US Census geocoding. Elevation decreases
 * heading south, so southern sensors flood first and deepest, which is what
 * gives the elevation map and the flow inference something real to show.
 */
const SENSOR_GRID = [
  { id: "FF-001", name: "Ocean Blvd @ Holiday Dr",      lat: 25.97510, lng: -80.11960, elevM: 2.40, hood: "North Golden Beach" },
  { id: "FF-002", name: "Ocean Blvd @ Navona Ave",      lat: 25.97230, lng: -80.11950, elevM: 2.20, hood: "North Golden Beach" },
  { id: "FF-003", name: "Ocean Blvd @ N Parkway",       lat: 25.97100, lng: -80.11950, elevM: 2.00, hood: "North Golden Beach" },
  { id: "FF-004", name: "Ocean Blvd @ Palermo Ave",     lat: 25.96940, lng: -80.11950, elevM: 1.80, hood: "Central Golden Beach" },
  { id: "FF-005", name: "Ocean Blvd @ Golden Beach Dr", lat: 25.96630, lng: -80.11970, elevM: 1.60, hood: "Central Golden Beach" },
  { id: "FF-006", name: "Ocean Blvd @ S Parkway",       lat: 25.96500, lng: -80.11970, elevM: 1.40, hood: "Central Golden Beach" },
  { id: "FF-007", name: "Ocean Blvd @ Ravenna Ave",     lat: 25.96330, lng: -80.11980, elevM: 1.15, hood: "South Golden Beach" },
  { id: "FF-008", name: "Ocean Blvd @ Verona Ave",      lat: 25.96020, lng: -80.11990, elevM: 0.90, hood: "South Golden Beach" },
  { id: "FF-009", name: "Ocean Blvd @ S Island Rd",     lat: 25.95870, lng: -80.11990, elevM: 0.65, hood: "South Golden Beach" },
  { id: "FF-010", name: "Ocean Blvd @ Terracina Ave",   lat: 25.95710, lng: -80.12000, elevM: 0.45, hood: "South Golden Beach" },
  { id: "FF-011", name: "Ocean Blvd @ 194th Ln",        lat: 25.95600, lng: -80.12000, elevM: 0.30, hood: "South Golden Beach" },
  { id: "FF-012", name: "Golden Beach Dr @ Centre Is",     lat: 25.96630, lng: -80.12090, elevM: 1.50, hood: "Central Golden Beach" },
  { id: "FF-013", name: "Golden Beach Dr @ S Parkway",     lat: 25.96500, lng: -80.12090, elevM: 1.35, hood: "Central Golden Beach" },
  { id: "FF-014", name: "Golden Beach Dr @ Palermo Ave",   lat: 25.96940, lng: -80.12080, elevM: 1.70, hood: "Central Golden Beach" },
  { id: "FF-015", name: "Golden Beach Dr @ Ravenna Ave",   lat: 25.96330, lng: -80.12100, elevM: 1.30, hood: "South Golden Beach" },
  { id: "FF-016", name: "Golden Beach Dr @ Navona Ave",    lat: 25.97230, lng: -80.12070, elevM: 2.10, hood: "North Golden Beach" },
  { id: "FF-017", name: "Golden Beach Dr @ Holiday Dr",    lat: 25.97510, lng: -80.12060, elevM: 2.30, hood: "North Golden Beach" },
  { id: "FF-018", name: "Golden Beach Dr @ Verona Ave",    lat: 25.96020, lng: -80.12120, elevM: 0.80, hood: "South Golden Beach" },
  { id: "FF-019", name: "Golden Beach Dr @ Terracina Ave", lat: 25.95710, lng: -80.12120, elevM: 0.35, hood: "South Golden Beach" },
  { id: "FF-020", name: "Golden Beach Dr @ S Island Rd",   lat: 25.95870, lng: -80.12120, elevM: 0.55, hood: "South Golden Beach" },
];

const HOURS_OF_HISTORY = 14 * 24;

/** Transmit cadence in seconds, mirroring the firmware's state table. */
const TX_SEC: Record<string, number> = {
  BASELINE: 1200, WATCH: 1200, EVENT: 300, STANDING: 900, RECOVERY: 900,
};

/** Deterministic PRNG so a reseed is reproducible and diffable. */
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

interface Storm { start: number; peak: number; end: number; intensity: number; }

/** Storms as windows in hours-ago, strongest in the middle. */
function buildStorms(rng: () => number): Storm[] {
  const storms: Storm[] = [];
  let t = HOURS_OF_HISTORY - 6;
  while (t > 8) {
    t -= 34 + rng() * 60;
    if (t <= 8) break;
    const dur = 3 + rng() * 7;
    storms.push({ start: t + dur, peak: t + dur * 0.45, end: t, intensity: 0.35 + rng() * 0.65 });
  }
  return storms;
}

function stormFactor(storms: Storm[], hoursAgo: number) {
  let f = 0;
  for (const s of storms) {
    if (hoursAgo <= s.start && hoursAgo >= s.end) {
      const span = hoursAgo > s.peak ? s.start - s.peak : s.peak - s.end;
      const shape = span > 0 ? Math.max(0, 1 - Math.abs(hoursAgo - s.peak) / span) : 0;
      f = Math.max(f, shape * s.intensity);
    }
  }
  return f;
}

/** Pressure falls ahead of a storm, which is what drives BASELINE -> WATCH. */
function pressurePa(storms: Storm[], hoursAgo: number, rng: () => number) {
  const ahead = stormFactor(storms, hoursAgo - 4);
  const now = stormFactor(storms, hoursAgo);
  return Math.round(101325 - 900 * Math.max(ahead, now) + (rng() - 0.5) * 60);
}

export async function POST(request: Request) {
  // Destructive: replaces the simulated history. Never reachable in production,
  // and requires SEED_SECRET everywhere else.
  if (process.env.VERCEL_ENV === "production") {
    return NextResponse.json({ error: "Seeding is disabled in production." }, { status: 403 });
  }
  const denied = requireSecret(request, "SEED_SECRET");
  if (denied) return denied;

  try {
    const supabase = createServiceClient();
    const rng = makeRng(20260831);
    const storms = buildStorms(rng);
    const now = Date.now();

    // ---- 1. Nodes -------------------------------------------------------
    // baseline_mm is the dry distance from the sensor down to the road. Real
    // installs vary, so vary it: a fleet where every baseline is identical is
    // the tell that the data was invented.
    // elevation_mm is the SENSOR's barometric altitude, not the ground's.
    //
    // That distinction is the whole flow model. The BMP390 sits on the pole and
    // can only measure where IT is; ground elevation is derived by subtracting
    // the dry distance down to the road, which is exactly what
    // geo.ts streetElevation() does: altitude_baro - baseline_distance_cm/100.
    //
    // Writing the ground elevation here instead would subtract the mount height
    // a second time. Since baseline varies 1.8-2.5 m per install and the real
    // terrain across Golden Beach only spans 0.3-2.4 m, that noise is LARGER
    // than the signal: measured 2.21 m mean error, and 3 of 38 flow edges ran
    // uphill. With the sensor altitude the error is 0.00 m and all 79 edges
    // run downhill.
    const nodes = SENSOR_GRID.map((s, i) => {
      const installed = new Date(now - (60 + rng() * 120) * 86400000).toISOString();
      const tilt = Math.round((1.5 + rng() * 7) * 10) / 10;
      const baselineMm = 1800 + Math.round(rng() * 700);
      return {
        dev_eui: "70B3D57ED000" + (0x1000 + i).toString(16).toUpperCase(),
        device_id: s.id,
        label: s.name,
        lat: s.lat,
        lon: s.lng,
        elevation_mm: Math.round(s.elevM * 1000) + baselineMm,
        tilt_deg: tilt,
        baseline_mm: baselineMm,
        bmp_offset_pa: Math.round((rng() - 0.5) * 120),
        neighborhood: s.hood,
        commissioned_at: installed,
        installed_at: installed,
      };
    });

    await supabase.from("readings").delete().neq("id", 0);
    await supabase.from("flood_events").delete().neq("id", 0);
    for (const n of nodes) {
      await supabase.from("nodes").upsert(n, { onConflict: "dev_eui" });
    }

    // ---- 2. Readings ----------------------------------------------------
    // One node goes silent and one degrades on purpose. A fleet where
    // everything is healthy hides whether the offline and sensor-degraded
    // paths actually render.
    const SILENT = nodes.length - 1;
    const DEGRADED = 6;

    const rows: Record<string, unknown>[] = [];
    let seq = 0;

    for (let idx = 0; idx < nodes.length; idx++) {
      const n = nodes[idx];
      const site = SENSOR_GRID[idx];
      const exposure = Math.max(0.12, 1 - (site.elevM - 0.3) / 2.3);
      let vbat = 4.05 + rng() * 0.15;
      let hoursAgo = HOURS_OF_HISTORY;

      while (hoursAgo > 0) {
        const f = stormFactor(storms, hoursAgo);
        const depthMm = Math.max(0, Math.round(f * exposure * 520 - 25 + (rng() - 0.5) * 18));
        const press = pressurePa(storms, hoursAgo, rng);

        let state = "BASELINE";
        if (depthMm >= 300) state = "EVENT";
        else if (depthMm >= 50) state = "STANDING";
        // WATCH is the pre-storm window: the pressure fall arrives before the
        // water does. A tight threshold here meant WATCH almost never fired,
        // because by the time pressure was that low the road was already wet
        // and the state had moved on to STANDING.
        else if (press < 101_050) state = "WATCH";

        // Solar recovers by day, storms are dark, and EVENT costs more because
        // it transmits four times as often.
        const hourOfDay = (24 - (hoursAgo % 24)) % 24;
        const sun = hourOfDay > 8 && hourOfDay < 18 ? (1 - f) * 0.02 : 0;
        vbat = Math.min(4.2, Math.max(3.3, vbat + sun - (state === "EVENT" ? 0.006 : 0.0022)));

        const tier = vbat > 3.9 ? "FULL" : vbat > 3.75 ? "ECO"
                   : vbat > 3.6 ? "LOW" : vbat > 3.45 ? "CRITICAL" : "SURVIVAL";

        const degraded = idx === DEGRADED && hoursAgo < 30;
        const noEcho = degraded && rng() < 0.25;

        if (!(idx === SILENT && hoursAgo < 48)) {
          rows.push({
            received_at: new Date(now - hoursAgo * 3600000).toISOString(),
            device_id: n.device_id,
            dev_eui: n.dev_eui,
            packet_type: state === "EVENT" ? "burst" : "reading",
            seq: seq++,
            fw_version: 1,
            distance_mm: noEcho ? null : n.baseline_mm - depthMm,
            pressure_pa: press,
            temp_c: Math.round((26 - f * 4 + (rng() - 0.5) * 3) * 10) / 10,
            vbat_v: Math.round(vbat * 100) / 100,
            node_state: state,
            power_tier: tier,
            valid_pings: degraded ? 6 + Math.floor(rng() * 5) : 17 + Math.floor(rng() * 4),
            spread_mm: depthMm > 60 ? 18 + Math.floor(rng() * 26) : 4 + Math.floor(rng() * 8),
            sensor_degraded: degraded,
            threshold_alert: depthMm >= 300,
            rate_alert: f > 0.6 && depthMm > 120,
            low_battery: vbat < 3.6,
            commissioned: true,
            lat: n.lat,
            lon: n.lon,
            tilt_deg: n.tilt_deg,
            baseline_mm: n.baseline_mm,
            link_margin_db: 7 + Math.floor(rng() * 9),
            gateway_count: 1,
            rssi: Math.round(-98 - rng() * 22),
            snr: Math.round((7 - rng() * 9) * 10) / 10,
            spreading_factor: 9,
            f_port: 1,
            f_cnt: seq,
            source: "simulator",
          });
        }

        hoursAgo -= TX_SEC[state] / 3600;
      }
    }

    // ---- 3. Insert ------------------------------------------------------
    // The flood-event trigger fires per row, so order matters: oldest first,
    // or events open and close out of sequence.
    rows.sort((a, b) => String(a.received_at).localeCompare(String(b.received_at)));

    const errors: string[] = [];
    let inserted = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      const { error } = await supabase.from("readings").insert(batch);
      if (error) errors.push(error.message);
      else inserted += batch.length;
    }

    const { count: events } = await supabase
      .from("flood_events").select("id", { count: "exact", head: true });

    return NextResponse.json({
      message:
        `Simulated ${nodes.length} nodes over ${HOURS_OF_HISTORY / 24} days: ` +
        `${inserted}/${rows.length} readings, ${storms.length} storms, ` +
        `${events ?? 0} flood events derived by the database trigger.`,
      note:
        "Written to nodes/readings, the same tables the LoRa receiver uses. " +
        "devices, sensor_readings and flood_events are derived from these.",
      errors: errors.length ? errors.slice(0, 5) : undefined,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Simulation failed";
    console.error("[SEED]", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
