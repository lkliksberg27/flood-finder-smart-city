import type { Device, SensorReading, FloodEvent, Recommendation } from './types';

/**
 * Demo dataset. Generated, not measured.
 *
 * The dashboard falls back to this whenever Supabase is unreachable, so the
 * whole thing stands up on Vercel with no database behind it. Every number
 * comes out of the same storm and terrain model the real simulator uses, so
 * what you see here is the shape real hardware produces, not filler.
 *
 * Two things it deliberately gets right, because getting them wrong is what
 * makes demo data look fake:
 *
 *  - `altitude_baro` is the SENSOR's altitude, ground plus mounting height,
 *    because that is what a barometer on a pole actually measures. Street
 *    level is derived by subtracting the dry drop to the road. Writing ground
 *    level here would subtract the mount twice and the flow arrows would point
 *    uphill.
 *  - Baselines vary per install (1.80 to 2.50 m). A fleet where every node has
 *    an identical mounting height is the clearest tell that data was invented.
 *
 * It is labelled in the UI. Presenting generated readings as real measurements
 * is not something this project should do.
 */

export const IS_DEMO = true;

/** Verified Golden Beach intersections. Elevation falls heading south. */
const SITES = [
  { id: 'FF-001', name: 'Ocean Blvd @ Holiday Dr', lat: 25.97510, lng: -80.11960, groundM: 2.40, hood: 'North Golden Beach' },
  { id: 'FF-002', name: 'Ocean Blvd @ Navona Ave', lat: 25.97230, lng: -80.11950, groundM: 2.20, hood: 'North Golden Beach' },
  { id: 'FF-003', name: 'Ocean Blvd @ N Parkway', lat: 25.97100, lng: -80.11950, groundM: 2.00, hood: 'North Golden Beach' },
  { id: 'FF-004', name: 'Ocean Blvd @ Palermo Ave', lat: 25.96940, lng: -80.11950, groundM: 1.80, hood: 'Central Golden Beach' },
  { id: 'FF-005', name: 'Ocean Blvd @ Golden Beach Dr', lat: 25.96630, lng: -80.11970, groundM: 1.60, hood: 'Central Golden Beach' },
  { id: 'FF-006', name: 'Ocean Blvd @ S Parkway', lat: 25.96500, lng: -80.11970, groundM: 1.40, hood: 'Central Golden Beach' },
  { id: 'FF-007', name: 'Ocean Blvd @ Ravenna Ave', lat: 25.96330, lng: -80.11980, groundM: 1.15, hood: 'South Golden Beach' },
  { id: 'FF-008', name: 'Ocean Blvd @ Verona Ave', lat: 25.96020, lng: -80.11990, groundM: 0.90, hood: 'South Golden Beach' },
  { id: 'FF-009', name: 'Ocean Blvd @ S Island Rd', lat: 25.95870, lng: -80.11990, groundM: 0.65, hood: 'South Golden Beach' },
  { id: 'FF-010', name: 'Ocean Blvd @ Terracina Ave', lat: 25.95710, lng: -80.12000, groundM: 0.45, hood: 'South Golden Beach' },
  { id: 'FF-011', name: 'Ocean Blvd @ 194th Ln', lat: 25.95600, lng: -80.12000, groundM: 0.30, hood: 'South Golden Beach' },
  { id: 'FF-012', name: 'Golden Beach Dr @ Centre Is', lat: 25.96630, lng: -80.12090, groundM: 1.50, hood: 'Central Golden Beach' },
  { id: 'FF-013', name: 'Golden Beach Dr @ S Parkway', lat: 25.96500, lng: -80.12090, groundM: 1.35, hood: 'Central Golden Beach' },
  { id: 'FF-014', name: 'Golden Beach Dr @ Palermo Ave', lat: 25.96940, lng: -80.12080, groundM: 1.70, hood: 'Central Golden Beach' },
  { id: 'FF-015', name: 'Golden Beach Dr @ Ravenna Ave', lat: 25.96330, lng: -80.12100, groundM: 1.30, hood: 'South Golden Beach' },
  { id: 'FF-016', name: 'Golden Beach Dr @ Navona Ave', lat: 25.97230, lng: -80.12070, groundM: 2.10, hood: 'North Golden Beach' },
  { id: 'FF-017', name: 'Golden Beach Dr @ Holiday Dr', lat: 25.97510, lng: -80.12060, groundM: 2.30, hood: 'North Golden Beach' },
  { id: 'FF-018', name: 'Golden Beach Dr @ Verona Ave', lat: 25.96020, lng: -80.12120, groundM: 0.80, hood: 'South Golden Beach' },
  { id: 'FF-019', name: 'Golden Beach Dr @ Terracina Ave', lat: 25.95710, lng: -80.12120, groundM: 0.35, hood: 'South Golden Beach' },
  { id: 'FF-020', name: 'Golden Beach Dr @ S Island Rd', lat: 25.95870, lng: -80.12120, groundM: 0.55, hood: 'South Golden Beach' },
];

const DAYS = 14;
const HOURS = DAYS * 24;
const WATER_MM = 50;      // a reading counts as water above this
const CLOSE_MM = 30;      // an event closes below this. Hysteresis, or one
                          // flood flickers into a dozen fake ones.

function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

interface Storm { start: number; peak: number; end: number; intensity: number }

function buildStorms(rng: () => number): Storm[] {
  const out: Storm[] = [];
  let t = HOURS - 6;
  while (t > 8) {
    t -= 34 + rng() * 60;
    if (t <= 8) break;
    const dur = 3 + rng() * 7;
    out.push({ start: t + dur, peak: t + dur * 0.45, end: t, intensity: 0.35 + rng() * 0.65 });
  }
  return out;
}

function stormFactor(storms: Storm[], h: number) {
  let f = 0;
  for (const s of storms) {
    if (h <= s.start && h >= s.end) {
      const span = h > s.peak ? s.start - s.peak : s.peak - s.end;
      const shape = span > 0 ? Math.max(0, 1 - Math.abs(h - s.peak) / span) : 0;
      f = Math.max(f, shape * s.intensity);
    }
  }
  return f;
}

/** Everything is derived once and memoised, so every page agrees. */
function generate() {
  const rng = makeRng(20260901);
  const storms = buildStorms(rng);
  const now = Date.now();

  const SILENT = SITES.length - 1;   // one node offline, so that path renders
  const DEGRADED = 6;                // one with a failing transducer

  const devices: Device[] = [];
  const readings: SensorReading[] = [];
  const events: FloodEvent[] = [];
  const floodCounts: Record<string, number> = {};
  let readingId = 1, eventId = 1;

  for (let i = 0; i < SITES.length; i++) {
    const s = SITES[i];
    const baselineCm = 180 + Math.round(rng() * 70);          // 1.80 to 2.50 m
    const exposure = Math.max(0.12, 1 - (s.groundM - 0.3) / 2.3);
    let vbat = 4.05 + rng() * 0.15;

    let openEvent: FloodEvent | null = null;
    let lastDepth = 0, lastSeen = '', lastAt = 0;
    floodCounts[s.id] = 0;

    // 20 min in the quiet, 5 min once water is on the road
    for (let h = HOURS; h > 0;) {
      const f = stormFactor(storms, h);
      const depthMm = Math.max(0, Math.round(f * exposure * 520 - 25 + (rng() - 0.5) * 18));
      const depthCm = Math.round(depthMm / 10);
      const at = new Date(now - h * 3600000);

      const hourOfDay = (24 - (h % 24)) % 24;
      const sun = hourOfDay > 8 && hourOfDay < 18 ? (1 - f) * 0.02 : 0;
      vbat = Math.min(4.2, Math.max(3.3, vbat + sun - (depthMm >= 300 ? 0.006 : 0.0022)));

      const degraded = i === DEGRADED && h < 30;
      const silent = i === SILENT && h < 48;

      if (!silent) {
        readings.push({
          id: readingId++,
          device_id: s.id,
          lat: s.lat,
          lng: s.lng,
          distance_cm: degraded && rng() < 0.25 ? null : baselineCm - depthCm,
          water_detected: depthMm >= WATER_MM,
          flood_depth_cm: depthCm,
          battery_v: Math.round(vbat * 100) / 100,
          recorded_at: at.toISOString(),
        });
        lastSeen = at.toISOString();
        lastAt = at.getTime();
        lastDepth = depthCm;

        // events, with hysteresis, exactly as the database trigger does it
        if (depthMm >= WATER_MM && !openEvent) {
          openEvent = {
            id: eventId++, device_id: s.id, started_at: at.toISOString(), ended_at: null,
            peak_depth_cm: depthCm,
            rainfall_mm: Math.round((8 + rng() * 34) * 10) / 10,
            tide_level_m: Math.round((0.2 + rng() * 0.5) * 100) / 100,
            duration_minutes: null,
          };
          events.push(openEvent);
          floodCounts[s.id]++;
        } else if (openEvent) {
          openEvent.peak_depth_cm = Math.max(openEvent.peak_depth_cm, depthCm);
          if (depthMm < CLOSE_MM) {
            openEvent.ended_at = at.toISOString();
            openEvent.duration_minutes = Math.round(
              (at.getTime() - new Date(openEvent.started_at).getTime()) / 60000);
            openEvent = null;
          }
        }
      }
      h -= depthMm >= 300 ? 5 / 60 : 20 / 60;
    }

    const minutesSilent = (now - lastAt) / 60000;
    devices.push({
      device_id: s.id,
      name: s.name,
      lat: s.lat,
      lng: s.lng,
      // sensor altitude: the ground plus how high the node is mounted
      altitude_baro: Math.round((s.groundM + baselineCm / 100) * 100) / 100,
      mailbox_height_cm: baselineCm,
      baseline_distance_cm: baselineCm,
      status: minutesSilent > 120 ? 'offline' : lastDepth >= 30 ? 'alert' : 'online',
      battery_v: Math.round(vbat * 100) / 100,
      last_seen: lastSeen,
      installed_at: new Date(now - (60 + rng() * 120) * 86400000).toISOString(),
      neighborhood: s.hood,
      notes: null,
    });
  }

  readings.sort((a, b) => b.recorded_at.localeCompare(a.recorded_at));
  events.sort((a, b) => b.started_at.localeCompare(a.started_at));

  const worst = [...devices].sort(
    (a, b) => (floodCounts[b.device_id] ?? 0) - (floodCounts[a.device_id] ?? 0)).slice(0, 3);

  const recommendations: Recommendation[] = [
    {
      id: 1, generated_at: new Date(now - 2 * 86400000).toISOString(), analysis_period_days: 30,
      priority: 'high', category: 'drainage',
      affected_device_ids: worst.map((d) => d.device_id),
      recommendation_text:
        `${worst[0]?.name ?? 'The southern end of Ocean Blvd'} records the deepest and longest ` +
        `standing water in the network, and the relative elevation map places several ` +
        `monitored locations upstream of it. Adding catch basin capacity here relieves more ` +
        `of the network per dollar than anywhere else measured.`,
    },
    {
      id: 2, generated_at: new Date(now - 2 * 86400000).toISOString(), analysis_period_days: 30,
      priority: 'medium', category: 'elevation',
      affected_device_ids: worst.slice(1, 3).map((d) => d.device_id),
      recommendation_text:
        `Terracina Ave and 194th Ln sit at the low end of the barometric elevation profile, ` +
        `roughly 2 m below the northern intersections. Regrading the crown of the road here ` +
        `would move water toward the existing outfall instead of ponding across the lane.`,
    },
    {
      id: 3, generated_at: new Date(now - 2 * 86400000).toISOString(), analysis_period_days: 30,
      priority: 'low', category: 'other',
      affected_device_ids: [devices[6]?.device_id ?? 'FF-007'],
      recommendation_text:
        `One node is returning a reduced valid-ping count, which usually means a fouled or ` +
        `misaimed transducer rather than a genuine reading. Worth a visual check before its ` +
        `data is used in any funding submission.`,
    },
  ];

  return { devices, readings, events, recommendations, floodCounts, storms: storms.length };
}

let cache: ReturnType<typeof generate> | null = null;
export function demo() {
  if (!cache) cache = generate();
  return cache;
}

export const demoDevices = () => demo().devices;
export const demoReadings = () => demo().readings;
export const demoEvents = () => demo().events;
export const demoRecommendations = () => demo().recommendations;
export const demoFloodCounts = () => demo().floodCounts;
