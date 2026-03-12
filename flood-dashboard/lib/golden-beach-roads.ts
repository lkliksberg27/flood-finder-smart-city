/**
 * Flood visualization using actual Mapbox road geometry.
 *
 * Each sensor is on a mailbox ON a specific road. We query Mapbox's
 * vector tiles to get the real road geometry passing through each sensor,
 * then walk along it to show where water spreads.
 */
import type { Device } from "./types";
import type mapboxgl from "mapbox-gl";

const COS_LAT = Math.cos(25.966 * Math.PI / 180);

function ptDist(a: number[], b: number[]): number {
  const dx = (a[0] - b[0]) * 111320 * COS_LAT;
  const dy = (a[1] - b[1]) * 111320;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Overall compass direction of a polyline (degrees) */
function lineDir(coords: number[][]): number {
  const dx = (coords[coords.length - 1][0] - coords[0][0]) * 111320 * COS_LAT;
  const dy = (coords[coords.length - 1][1] - coords[0][1]) * 111320;
  return Math.atan2(dy, dx) * 180 / Math.PI;
}

/** Check if two directions are roughly collinear (same road, not a cross street) */
function collinear(d1: number, d2: number): boolean {
  let diff = Math.abs(d1 - d2) % 360;
  if (diff > 180) diff = 360 - diff;
  return diff < 50 || diff > 130; // same or opposite direction
}

/**
 * Merge road tile fragments that share endpoints AND are going in the
 * same direction. Prevents merging a N-S road with an E-W cross street
 * at an intersection.
 */
function mergeSegments(segments: number[][][]): number[][][] {
  if (segments.length === 0) return [];
  const used = new Set<number>();
  const merged: number[][][] = [];

  for (let i = 0; i < segments.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    let chain = [...segments[i]];
    let changed = true;

    while (changed) {
      changed = false;
      for (let j = 0; j < segments.length; j++) {
        if (used.has(j)) continue;
        const seg = segments[j];

        // Only merge if roughly collinear (same road)
        if (!collinear(lineDir(chain), lineDir(seg))) continue;

        const chainEnd = chain[chain.length - 1];
        const chainStart = chain[0];

        if (ptDist(chainEnd, seg[0]) < 15) {
          chain = chain.concat(seg.slice(1));
          used.add(j); changed = true;
        } else if (ptDist(chainEnd, seg[seg.length - 1]) < 15) {
          chain = chain.concat([...seg].reverse().slice(1));
          used.add(j); changed = true;
        } else if (ptDist(chainStart, seg[seg.length - 1]) < 15) {
          chain = seg.concat(chain.slice(1));
          used.add(j); changed = true;
        } else if (ptDist(chainStart, seg[0]) < 15) {
          chain = [...seg].reverse().concat(chain.slice(1));
          used.add(j); changed = true;
        }
      }
    }
    merged.push(chain);
  }
  return merged;
}

/**
 * Build fallback road geometry from sensor positions.
 * Used when Mapbox tiles haven't loaded yet so flood water is always visible.
 * Auto-detects N-S road columns and E-W cross streets from sensor layout.
 */
function buildFallbackRoads(devices: Device[]): number[][][] {
  const roads: number[][][] = [];
  if (devices.length === 0) return roads;

  // Auto-detect N-S road columns by clustering sensors by longitude
  const LNG_TOLERANCE = 0.0008; // ~70m
  const columns: { lng: number; devices: Device[] }[] = [];

  for (const d of devices) {
    const col = columns.find(c => Math.abs(c.lng - d.lng) < LNG_TOLERANCE);
    if (col) {
      col.devices.push(d);
    } else {
      columns.push({ lng: d.lng, devices: [d] });
    }
  }

  // Build a N-S road for each column with 2+ sensors
  for (const col of columns) {
    const sorted = [...col.devices].sort((a, b) => a.lat - b.lat);
    if (sorted.length >= 2) {
      roads.push([
        [col.lng, sorted[0].lat - 0.0008],
        ...sorted.map(d => [d.lng, d.lat]),
        [col.lng, sorted[sorted.length - 1].lat + 0.0008],
      ]);
    }
  }

  // Build E-W cross streets between sensors at approximately the same latitude
  const LAT_TOLERANCE = 0.0004; // ~44m
  if (columns.length >= 2) {
    for (let i = 0; i < columns.length; i++) {
      for (let j = i + 1; j < columns.length; j++) {
        for (const d1 of columns[i].devices) {
          for (const d2 of columns[j].devices) {
            if (Math.abs(d1.lat - d2.lat) < LAT_TOLERANCE) {
              const minLng = Math.min(d1.lng, d2.lng);
              const maxLng = Math.max(d1.lng, d2.lng);
              roads.push([
                [minLng - 0.0003, d1.lat],
                [d1.lng, d1.lat],
                [d2.lng, d2.lat],
                [maxLng + 0.0003, d2.lat],
              ]);
            }
          }
        }
      }
    }
  }

  return roads;
}

/**
 * Query actual road geometry from Mapbox vector tiles.
 * Queries a small area around each sensor to get the roads it's on.
 * Merges tile fragments of the same road (direction-aware).
 * Returns an array of road polylines (each is number[][]).
 */
export function queryMapboxRoads(
  map: mapboxgl.Map,
  devices: Device[],
): number[][][] {
  const style = map.getStyle();
  if (!style?.layers) return buildFallbackRoads(devices);

  const roadLayerIds = style.layers
    .filter((l) => l.type === "line" && (l as Record<string, unknown>)["source-layer"] === "road")
    .map((l) => l.id);
  if (roadLayerIds.length === 0) return buildFallbackRoads(devices);

  const allCoords: number[][][] = [];
  const seen = new Set<string>();

  for (const device of devices) {
    const point = map.project([device.lng, device.lat]);
    const size = 120; // ~180m at zoom 15
    const bbox: [mapboxgl.PointLike, mapboxgl.PointLike] = [
      [point.x - size, point.y - size],
      [point.x + size, point.y + size],
    ];

    try {
      const features = map.queryRenderedFeatures(bbox, { layers: roadLayerIds });
      for (const f of features) {
        if (f.geometry.type !== "LineString" && f.geometry.type !== "MultiLineString") continue;

        const key = JSON.stringify(f.geometry).slice(0, 150);
        if (seen.has(key)) continue;
        seen.add(key);

        const coords =
          f.geometry.type === "LineString"
            ? (f.geometry as GeoJSON.LineString).coordinates as number[][]
            : (f.geometry as GeoJSON.MultiLineString).coordinates[0] as number[][];

        if (coords && coords.length >= 2) allCoords.push(coords);
      }
    } catch {
      /* tiles not loaded yet */
    }
  }

  const merged = mergeSegments(allCoords);
  // Use real Mapbox roads when tiles are loaded; fall back to synthetic geometry only
  // when no tiles are available. Mixing both creates duplicate/inaccurate water lines.
  return merged.length > 0 ? merged : buildFallbackRoads(devices);
}

/**
 * Blue flood water on roads from sensor readings.
 *
 * Spread distance depends on:
 *  - Flood depth: shallow → short spread, deep → wider spread
 *  - Relative elevation: sensor in a LOW spot → water pools locally (less spread),
 *    sensor HIGHER than neighbors → water flows outward (more spread)
 *
 * Each flooding sensor matches its nearest road and walks along it.
 */
export function calculateFloodFeatures(
  roads: number[][][],
  devices: Device[],
  depths: Record<string, number>,
): GeoJSON.Feature[] {
  const flooding = devices
    .filter((d) => (depths[d.device_id] ?? 0) > 0)
    .map((d) => ({
      id: d.device_id,
      lng: d.lng,
      lat: d.lat,
      elev: (d.altitude_baro ?? 0) - (d.baseline_distance_cm ?? 0) / 100,
      depth: depths[d.device_id],
    }));
  if (flooding.length === 0) return [];

  // Compute average elevation for relative-elevation comparison
  const allElevs = devices.map((d) =>
    (d.altitude_baro ?? 0) - (d.baseline_distance_cm ?? 0) / 100,
  );
  const avgElev = allElevs.reduce((a, b) => a + b, 0) / allElevs.length;

  const maxDepth = Math.max(1, ...flooding.map((f) => f.depth));
  const features: GeoJSON.Feature[] = [];

  for (const sensor of flooding) {
    const sensorPt: number[] = [sensor.lng, sensor.lat];

    // --- Spread distance based on depth + relative elevation ---
    // Base spread: 5m per cm of depth (5cm→25m, 15cm→75m, 30cm→150m)
    let spread = sensor.depth * 5;

    // Relative elevation: lower than average → water pools (less spread),
    // higher than average → water flows out (more spread)
    const relElev = sensor.elev - avgElev;
    if (relElev < -0.3) {
      spread *= 0.4; // deep low spot — water stays local
    } else if (relElev < 0) {
      spread *= 0.7; // slightly low — moderate pooling
    } else if (relElev > 0.3) {
      spread *= 1.5; // higher than average — water flows outward
    } else if (relElev > 0) {
      spread *= 1.2; // slightly above — some extra spread
    }

    // Clamp to reasonable bounds
    const MAX_WALK = Math.max(20, Math.min(200, spread));

    // Find the single nearest road
    let bestRoad: number[][] | null = null;
    let bestDist = Infinity;
    let bestIdx = -1;

    for (const road of roads) {
      for (let i = 0; i < road.length; i++) {
        const d = ptDist(sensorPt, road[i]);
        if (d < bestDist) {
          bestDist = d;
          bestRoad = road;
          bestIdx = i;
        }
      }
    }

    if (!bestRoad || bestDist > 30) continue;

    // Walk forward — interpolate when tile vertices are far apart
    const seg: number[][] = [bestRoad[bestIdx]];
    let d = 0;
    for (let i = bestIdx + 1; i < bestRoad.length; i++) {
      const stepDist = ptDist(bestRoad[i - 1], bestRoad[i]);
      if (d + stepDist > MAX_WALK) {
        // Interpolate a point at MAX_WALK distance
        const remaining = MAX_WALK - d;
        const frac = remaining / stepDist;
        seg.push([
          bestRoad[i - 1][0] + (bestRoad[i][0] - bestRoad[i - 1][0]) * frac,
          bestRoad[i - 1][1] + (bestRoad[i][1] - bestRoad[i - 1][1]) * frac,
        ]);
        break;
      }
      d += stepDist;
      seg.push(bestRoad[i]);
    }

    // Walk backward — same interpolation
    d = 0;
    for (let i = bestIdx - 1; i >= 0; i--) {
      const stepDist = ptDist(bestRoad[i + 1], bestRoad[i]);
      if (d + stepDist > MAX_WALK) {
        const remaining = MAX_WALK - d;
        const frac = remaining / stepDist;
        seg.unshift([
          bestRoad[i + 1][0] + (bestRoad[i][0] - bestRoad[i + 1][0]) * frac,
          bestRoad[i + 1][1] + (bestRoad[i][1] - bestRoad[i + 1][1]) * frac,
        ]);
        break;
      }
      d += stepDist;
      seg.unshift(bestRoad[i]);
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

  return features;
}
