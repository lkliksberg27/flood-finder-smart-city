/**
 * Golden Beach, FL — hardcoded road network and flood calculation.
 * Uses known street geometry so flood visualization works immediately
 * without depending on Mapbox vector tile loading timing.
 */
import type { Device } from "./types";

const COS_LAT = Math.cos(25.966 * Math.PI / 180);
const STEP_M = 8; // densify roads with a point every ~8 meters

// ── Road waypoints based on actual Golden Beach street layout ──
// Ocean Blvd is the main N-S road; E-W cross streets connect to A1A corridor
const RAW_ROADS: [number, number][][] = [
  // Ocean Blvd — main N-S arterial (lng ≈ -80.11960)
  [
    [-80.11960, 25.95500],
    [-80.11960, 25.95650], // FF-011 South End
    [-80.11960, 25.95800], // FF-010 S Island Rd
    [-80.11960, 25.95950], // FF-009 South Park
    [-80.11960, 25.96100], // FF-008 Ravenna Ave
    [-80.11960, 25.96250], // FF-007 NE 199th Ter
    [-80.11960, 25.96450], // FF-006 The Strand S
    [-80.11960, 25.96630], // FF-005 Golden Beach Dr
    [-80.11960, 25.96800], // FF-004 The Strand N
    [-80.11960, 25.97000], // FF-003 NE 207th Ter
    [-80.11960, 25.97200], // FF-002 Palermo Ave
    [-80.11960, 25.97400], // FF-001 North Park
    [-80.11960, 25.97550],
  ],
  // A1A Corridor — western parallel road (lng ≈ -80.12110)
  [
    [-80.12110, 25.95650],
    [-80.12110, 25.95800], // FF-019
    [-80.12110, 25.95950], // FF-020
    [-80.12110, 25.96100], // FF-018
    [-80.12110, 25.96450], // FF-015
    [-80.12110, 25.96630], // FF-012
    [-80.12110, 25.96800], // FF-014
    [-80.12110, 25.97200], // FF-016
    [-80.12110, 25.97400], // FF-017
    [-80.12110, 25.97550],
  ],
  // ── E-W cross streets ──
  [[-80.11960, 25.95800], [-80.12110, 25.95800]],   // S Island Rd
  [[-80.11960, 25.95950], [-80.12110, 25.95950]],   // South Park
  [[-80.11960, 25.96100], [-80.12110, 25.96100]],   // Ravenna Ave
  [[-80.11960, 25.96450], [-80.12110, 25.96450]],   // The Strand S
  [[-80.11960, 25.96630], [-80.12110, 25.96630], [-80.12200, 25.96630]], // Golden Beach Dr
  [[-80.11960, 25.96800], [-80.12110, 25.96800]],   // Centre Is Dr
  [[-80.11960, 25.97200], [-80.12110, 25.97200]],   // Palermo Ave
  [[-80.11960, 25.97400], [-80.12110, 25.97400]],   // N Pkwy
];

/** Interpolate between waypoints to create dense road coordinates */
function densify(pts: [number, number][]): [number, number][] {
  const out: [number, number][] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const dx = (x1 - x0) * 111320 * COS_LAT;
    const dy = (y1 - y0) * 111320;
    const d = Math.sqrt(dx * dx + dy * dy);
    const n = Math.max(1, Math.ceil(d / STEP_M));
    for (let s = 1; s <= n; s++) {
      const t = s / n;
      out.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]);
    }
  }
  return out;
}

// Pre-compute densified road coordinates (done once at module load)
const ROADS = RAW_ROADS.map(densify);

function ptDist(a: [number, number], b: [number, number]): number {
  const dx = (a[0] - b[0]) * 111320 * COS_LAT;
  const dy = (a[1] - b[1]) * 111320;
  return Math.sqrt(dx * dx + dy * dy);
}

/** IDW elevation estimate at a point using the sensor network */
function idwElev(
  lng: number, lat: number,
  sensors: { lng: number; lat: number; elev: number }[],
): number {
  let wE = 0, wT = 0;
  for (const s of sensors) {
    const dx = (s.lng - lng) * 111320 * COS_LAT;
    const dy = (s.lat - lat) * 111320;
    const w = 1 / Math.max(dx * dx + dy * dy, 25);
    wE += s.elev * w;
    wT += w;
  }
  return wT > 0 ? wE / wT : 0;
}

/**
 * Generate flood water GeoJSON features on actual road geometry.
 *
 * For each flooding sensor:
 *   1. Find all roads within 30m
 *   2. Walk along each road in both directions
 *   3. Walk distance based on depth (deeper = more spread) and elevation
 *      (water flows further downhill)
 *   4. At intersections, water naturally spreads onto cross streets
 *
 * @param devices All sensor devices
 * @param depths  device_id → flood depth (cm), only for flooding sensors
 */
export function calculateFloodFeatures(
  devices: Device[],
  depths: Record<string, number>,
): GeoJSON.Feature[] {
  const flooding = devices
    .filter((d) => (depths[d.device_id] ?? 0) > 0)
    .map((d) => ({
      id: d.device_id,
      pos: [d.lng, d.lat] as [number, number],
      elev: (d.altitude_baro ?? 0) - (d.baseline_distance_cm ?? 0) / 100,
      depth: depths[d.device_id],
    }));
  if (flooding.length === 0) return [];

  const allSensors = devices.map((d) => ({
    lng: d.lng, lat: d.lat,
    elev: (d.altitude_baro ?? 0) - (d.baseline_distance_cm ?? 0) / 100,
  }));

  const maxDepth = Math.max(1, ...flooding.map((f) => f.depth));
  const features: GeoJSON.Feature[] = [];

  for (const sensor of flooding) {
    // Walk distance: 30m base + 4m per cm depth, max 250m
    const walkMax = Math.min(30 + sensor.depth * 4, 250);

    for (const road of ROADS) {
      // Find nearest point on this road
      let nearIdx = -1, nearDist = Infinity;
      for (let i = 0; i < road.length; i++) {
        const d = ptDist(sensor.pos, road[i]);
        if (d < nearDist) { nearDist = d; nearIdx = i; }
      }
      if (nearDist > 30) continue; // sensor not on this road

      // Walk forward along road
      const seg: [number, number][] = [road[nearIdx]];
      let d = 0;
      for (let i = nearIdx + 1; i < road.length; i++) {
        d += ptDist(road[i - 1], road[i]);
        const elev = idwElev(road[i][0], road[i][1], allSensors);
        if (d > (elev < sensor.elev ? walkMax * 1.5 : walkMax)) break;
        seg.push(road[i]);
      }

      // Walk backward along road
      d = 0;
      for (let i = nearIdx - 1; i >= 0; i--) {
        d += ptDist(road[i + 1], road[i]);
        const elev = idwElev(road[i][0], road[i][1], allSensors);
        if (d > (elev < sensor.elev ? walkMax * 1.5 : walkMax)) break;
        seg.unshift(road[i]);
      }

      if (seg.length < 2) continue;

      features.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: seg },
        properties: {
          intensity: Math.min(1, sensor.depth / maxDepth),
          depth: sensor.depth,
        },
      });
    }
  }

  return features;
}
