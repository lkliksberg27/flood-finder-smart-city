/**
 * Flood visualization using actual Mapbox road geometry.
 *
 * Each sensor is on a mailbox ON a specific road. We query Mapbox's
 * vector tiles to get the real road geometry passing through each sensor,
 * then walk along it to show where water spreads.
 */
import type { Device } from "./types";
import type mapboxgl from "mapbox-gl";

function cosLat(lat: number): number {
  return Math.cos((lat * Math.PI) / 180);
}

function ptDist(a: number[], b: number[]): number {
  const lat = (a[1] + b[1]) / 2;
  const dx = (a[0] - b[0]) * 111320 * cosLat(lat);
  const dy = (a[1] - b[1]) * 111320;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Overall compass direction of a polyline (degrees) */
function lineDir(coords: number[][]): number {
  const lat = (coords[0][1] + coords[coords.length - 1][1]) / 2;
  const dx =
    (coords[coords.length - 1][0] - coords[0][0]) * 111320 * cosLat(lat);
  const dy = (coords[coords.length - 1][1] - coords[0][1]) * 111320;
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

/** Check if two directions are roughly collinear */
function collinear(d1: number, d2: number): boolean {
  let diff = Math.abs(d1 - d2) % 360;
  if (diff > 180) diff = 360 - diff;
  return diff < 50 || diff > 130;
}

/**
 * Merge road tile fragments that share endpoints AND go in the same direction.
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
        if (!collinear(lineDir(chain), lineDir(seg))) continue;

        const chainEnd = chain[chain.length - 1];
        const chainStart = chain[0];

        if (ptDist(chainEnd, seg[0]) < 20) {
          chain = chain.concat(seg.slice(1));
          used.add(j);
          changed = true;
        } else if (ptDist(chainEnd, seg[seg.length - 1]) < 20) {
          chain = chain.concat([...seg].reverse().slice(1));
          used.add(j);
          changed = true;
        } else if (ptDist(chainStart, seg[seg.length - 1]) < 20) {
          chain = seg.concat(chain.slice(1));
          used.add(j);
          changed = true;
        } else if (ptDist(chainStart, seg[0]) < 20) {
          chain = [...seg].reverse().concat(chain.slice(1));
          used.add(j);
          changed = true;
        }
      }
    }
    merged.push(chain);
  }
  return merged;
}

/**
 * Build fallback road geometry from sensor positions.
 */
function buildFallbackRoads(devices: Device[]): number[][][] {
  const roads: number[][][] = [];
  if (devices.length === 0) return roads;

  const LNG_TOLERANCE = 0.0008;
  const columns: { lng: number; devices: Device[] }[] = [];

  for (const d of devices) {
    const col = columns.find((c) => Math.abs(c.lng - d.lng) < LNG_TOLERANCE);
    if (col) {
      col.devices.push(d);
    } else {
      columns.push({ lng: d.lng, devices: [d] });
    }
  }

  for (const col of columns) {
    const sorted = [...col.devices].sort((a, b) => a.lat - b.lat);
    if (sorted.length >= 2) {
      roads.push([
        [col.lng, sorted[0].lat - 0.001],
        ...sorted.map((d) => [d.lng, d.lat]),
        [col.lng, sorted[sorted.length - 1].lat + 0.001],
      ]);
    }
  }

  const LAT_TOLERANCE = 0.0004;
  if (columns.length >= 2) {
    for (let i = 0; i < columns.length; i++) {
      for (let j = i + 1; j < columns.length; j++) {
        for (const d1 of columns[i].devices) {
          for (const d2 of columns[j].devices) {
            if (Math.abs(d1.lat - d2.lat) < LAT_TOLERANCE) {
              const minLng = Math.min(d1.lng, d2.lng);
              const maxLng = Math.max(d1.lng, d2.lng);
              roads.push([
                [minLng - 0.0005, d1.lat],
                [d1.lng, d1.lat],
                [d2.lng, d2.lat],
                [maxLng + 0.0005, d2.lat],
              ]);
            }
          }
        }
      }
    }
  }

  // For isolated sensors (not in any column with 2+), create a short N-S stub
  for (const col of columns) {
    if (col.devices.length === 1) {
      const d = col.devices[0];
      roads.push([
        [d.lng, d.lat - 0.0006],
        [d.lng, d.lat],
        [d.lng, d.lat + 0.0006],
      ]);
    }
  }

  return roads;
}

/**
 * Query actual road geometry from Mapbox vector tiles.
 * Uses a larger query area and better deduplication.
 */
export function queryMapboxRoads(
  map: mapboxgl.Map,
  devices: Device[],
): number[][][] {
  const style = map.getStyle();
  if (!style?.layers) return buildFallbackRoads(devices);

  const roadLayerIds = style.layers
    .filter(
      (l) =>
        l.type === "line" &&
        (l as Record<string, unknown>)["source-layer"] === "road",
    )
    .map((l) => l.id);
  if (roadLayerIds.length === 0) return buildFallbackRoads(devices);

  const allCoords: number[][][] = [];
  const seen = new Set<string>();

  for (const device of devices) {
    const point = map.project([device.lng, device.lat]);
    const size = 250; // larger query area
    const bbox: [mapboxgl.PointLike, mapboxgl.PointLike] = [
      [point.x - size, point.y - size],
      [point.x + size, point.y + size],
    ];

    try {
      const features = map.queryRenderedFeatures(bbox, {
        layers: roadLayerIds,
      });
      for (const f of features) {
        if (
          f.geometry.type !== "LineString" &&
          f.geometry.type !== "MultiLineString"
        )
          continue;

        const coords =
          f.geometry.type === "LineString"
            ? ((f.geometry as GeoJSON.LineString).coordinates as number[][])
            : ((f.geometry as GeoJSON.MultiLineString)
                .coordinates[0] as number[][]);

        if (!coords || coords.length < 2) continue;

        // Better dedup: use rounded start+end coords
        const s = coords[0];
        const e = coords[coords.length - 1];
        const key = `${s[0].toFixed(6)},${s[1].toFixed(6)}-${e[0].toFixed(6)},${e[1].toFixed(6)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        allCoords.push(coords);
      }
    } catch {
      /* tiles not loaded yet */
    }
  }

  const merged = mergeSegments(allCoords);
  return merged.length > 0 ? merged : buildFallbackRoads(devices);
}

/**
 * Extend a line segment in a given direction (forward or backward)
 * by extrapolating the last two points.
 */
function extrapolate(
  seg: number[][],
  direction: "forward" | "backward",
  meters: number,
): void {
  if (seg.length < 2) return;
  const a =
    direction === "forward" ? seg[seg.length - 2] : seg[1];
  const b =
    direction === "forward" ? seg[seg.length - 1] : seg[0];
  const dist = ptDist(a, b);
  if (dist < 0.5) return;
  const ratio = meters / dist;
  const ext = [
    b[0] + (b[0] - a[0]) * ratio,
    b[1] + (b[1] - a[1]) * ratio,
  ];
  if (direction === "forward") {
    seg.push(ext);
  } else {
    seg.unshift(ext);
  }
}

/**
 * Blue flood water on roads from sensor readings.
 *
 * Physics model:
 * - Base spread scales with flood depth
 * - Low elevation relative to neighbors → water pools (deeper, less spread)
 * - High elevation relative to neighbors → water drains (shallower, more spread)
 * - Minimum 50m visible water guaranteed for any flooding sensor
 * - If road geometry is shorter than desired spread, extrapolate the line
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

  // Compute average elevation for relative comparison
  const allElevs = devices
    .filter((d) => d.altitude_baro != null)
    .map((d) => (d.altitude_baro ?? 0) - (d.baseline_distance_cm ?? 0) / 100);
  const avgElev =
    allElevs.length > 0
      ? allElevs.reduce((a, b) => a + b, 0) / allElevs.length
      : 0;

  const maxDepth = Math.max(1, ...flooding.map((f) => f.depth));
  const features: GeoJSON.Feature[] = [];

  for (const sensor of flooding) {
    const sensorPt: number[] = [sensor.lng, sensor.lat];

    // --- Physics-based spread ---
    // Base: 4m per cm of depth (e.g. 10cm → 40m, 30cm → 120m)
    let spread = sensor.depth * 4;

    // Relative elevation modifier
    const relElev = sensor.elev - avgElev;

    // Low elevation: water pools here — deeper but doesn't spread far
    // High elevation: water drains away — less accumulation but spreads further
    let intensityBoost = 0;
    if (relElev < -0.3) {
      // Significantly lower than average — major pooling
      spread *= 0.5;
      intensityBoost = 0.2;
    } else if (relElev < -0.1) {
      // Slightly lower — moderate pooling
      spread *= 0.7;
      intensityBoost = 0.1;
    } else if (relElev > 0.3) {
      // Significantly higher — water drains away fast
      spread *= 1.4;
      intensityBoost = -0.1;
    } else if (relElev > 0.1) {
      // Slightly higher — some drainage
      spread *= 1.2;
    }

    // Clamp spread: minimum 50m so it's always visible, max 250m
    const MAX_WALK = Math.max(50, Math.min(250, spread));

    // Find nearest road
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

    // If no road within 50m, create a small N-S segment through the sensor
    if (!bestRoad || bestDist > 50) {
      const halfWalk = MAX_WALK / 111320;
      features.push({
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [sensor.lng, sensor.lat - halfWalk],
            [sensor.lng, sensor.lat],
            [sensor.lng, sensor.lat + halfWalk],
          ],
        },
        properties: {
          intensity: Math.min(1, sensor.depth / maxDepth + intensityBoost),
          depth: sensor.depth,
        },
      });
      continue;
    }

    // Walk forward along road
    const seg: number[][] = [bestRoad[bestIdx]];
    let walked = 0;
    for (let i = bestIdx + 1; i < bestRoad.length; i++) {
      const stepDist = ptDist(bestRoad[i - 1], bestRoad[i]);
      if (walked + stepDist > MAX_WALK) {
        const remaining = MAX_WALK - walked;
        const frac = remaining / stepDist;
        seg.push([
          bestRoad[i - 1][0] + (bestRoad[i][0] - bestRoad[i - 1][0]) * frac,
          bestRoad[i - 1][1] + (bestRoad[i][1] - bestRoad[i - 1][1]) * frac,
        ]);
        walked = MAX_WALK;
        break;
      }
      walked += stepDist;
      seg.push(bestRoad[i]);
    }
    // If road ended before MAX_WALK, extrapolate forward
    if (walked < MAX_WALK && seg.length >= 2) {
      extrapolate(seg, "forward", MAX_WALK - walked);
    }

    // Walk backward along road
    walked = 0;
    for (let i = bestIdx - 1; i >= 0; i--) {
      const stepDist = ptDist(bestRoad[i + 1], bestRoad[i]);
      if (walked + stepDist > MAX_WALK) {
        const remaining = MAX_WALK - walked;
        const frac = remaining / stepDist;
        seg.unshift([
          bestRoad[i + 1][0] + (bestRoad[i][0] - bestRoad[i + 1][0]) * frac,
          bestRoad[i + 1][1] + (bestRoad[i][1] - bestRoad[i + 1][1]) * frac,
        ]);
        walked = MAX_WALK;
        break;
      }
      walked += stepDist;
      seg.unshift(bestRoad[i]);
    }
    // If road ended before MAX_WALK, extrapolate backward
    if (walked < MAX_WALK && seg.length >= 2) {
      extrapolate(seg, "backward", MAX_WALK - walked);
    }

    if (seg.length < 2) continue;

    // Intensity: depth-based + elevation pooling boost
    const intensity = Math.min(
      1,
      Math.max(0.15, sensor.depth / maxDepth + intensityBoost),
    );

    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: seg },
      properties: { intensity, depth: sensor.depth },
    });
  }

  return features;
}
