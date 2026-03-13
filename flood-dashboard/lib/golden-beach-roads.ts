/**
 * Flood visualization using actual Mapbox road geometry ONLY.
 *
 * For each flooding sensor:
 * 1. Find exact closest point on any road (snap point, must be <30m)
 * 2. Clip each road segment to only the portion within the flood radius
 * 3. Tight spread: 20m base + 1.5m/cm depth, max 60m
 */
import type { Device } from "./types";
import type mapboxgl from "mapbox-gl";

function cosLat(lat: number): number {
  return Math.cos((lat * Math.PI) / 180);
}

/** Distance from point p to the closest point on segment [a, b] in meters. */
function ptSegDist(p: number[], a: number[], b: number[]): number {
  const lat = (p[1] + a[1] + b[1]) / 3;
  const cL = cosLat(lat);
  const S = 111320;
  const px = p[0] * S * cL, py = p[1] * S;
  const ax = a[0] * S * cL, ay = a[1] * S;
  const bx = b[0] * S * cL, by = b[1] * S;
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 0.01) return Math.sqrt((px - ax) ** 2 + (py - ay) ** 2);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.sqrt((px - cx) ** 2 + (py - cy) ** 2);
}

/**
 * Clip segment [a,b] to the portion within `radius` meters of `center`.
 * Returns [clippedA, clippedB] or null if fully outside.
 */
function clipSegment(
  center: number[], a: number[], b: number[], radius: number,
): [number[], number[]] | null {
  const lat = (center[1] + a[1] + b[1]) / 3;
  const cL = cosLat(lat);
  const S = 111320;

  const cx = center[0] * S * cL, cy = center[1] * S;
  const ax = a[0] * S * cL, ay = a[1] * S;
  const bx = b[0] * S * cL, by = b[1] * S;

  const dx = bx - ax, dy = by - ay;
  const fx = ax - cx, fy = ay - cy;

  const A2 = dx * dx + dy * dy;
  const B2 = 2 * (fx * dx + fy * dy);
  const C2 = fx * fx + fy * fy - radius * radius;

  if (A2 < 0.01) {
    // Degenerate (zero-length) segment
    return C2 <= 0 ? [a, b] : null;
  }

  const disc = B2 * B2 - 4 * A2 * C2;

  if (disc < 0) {
    // No circle intersection — segment is entirely inside or outside
    return C2 <= 0 ? [a, b] : null;
  }

  const sqrtDisc = Math.sqrt(disc);
  const t1 = (-B2 - sqrtDisc) / (2 * A2);
  const t2 = (-B2 + sqrtDisc) / (2 * A2);

  const tMin = Math.max(0, t1);
  const tMax = Math.min(1, t2);

  if (tMin >= tMax) return null;

  return [
    [a[0] + tMin * (b[0] - a[0]), a[1] + tMin * (b[1] - a[1])],
    [a[0] + tMax * (b[0] - a[0]), a[1] + tMax * (b[1] - a[1])],
  ];
}

function dedupKey(coords: number[][]): string {
  const s = coords[0];
  const e = coords[coords.length - 1];
  return `${s[0].toFixed(6)},${s[1].toFixed(6)}|${e[0].toFixed(6)},${e[1].toFixed(6)}`;
}

/**
 * Query real road geometry from Mapbox vector tiles.
 */
export function queryMapboxRoads(
  map: mapboxgl.Map,
  devices: Device[],
): number[][][] {
  const style = map.getStyle();
  if (!style?.layers) return [];

  const roadLayerIds = style.layers
    .filter(
      (l) =>
        l.type === "line" &&
        (l as Record<string, unknown>)["source-layer"] === "road",
    )
    .map((l) => l.id);
  if (roadLayerIds.length === 0) return [];

  const allCoords: number[][][] = [];
  const seen = new Set<string>();

  for (const device of devices) {
    const point = map.project([device.lng, device.lat]);
    const size = 80;
    const bbox: [mapboxgl.PointLike, mapboxgl.PointLike] = [
      [point.x - size, point.y - size],
      [point.x + size, point.y + size],
    ];

    try {
      const features = map.queryRenderedFeatures(bbox, {
        layers: roadLayerIds,
      });
      for (const f of features) {
        if (f.geometry.type === "LineString") {
          const coords = (f.geometry as GeoJSON.LineString)
            .coordinates as number[][];
          if (!coords || coords.length < 2) continue;
          const key = dedupKey(coords);
          if (seen.has(key)) continue;
          seen.add(key);
          allCoords.push(coords);
        } else if (f.geometry.type === "MultiLineString") {
          const multi = (f.geometry as GeoJSON.MultiLineString)
            .coordinates as number[][][];
          for (const coords of multi) {
            if (!coords || coords.length < 2) continue;
            const key = dedupKey(coords);
            if (seen.has(key)) continue;
            seen.add(key);
            allCoords.push(coords);
          }
        }
      }
    } catch {
      /* tiles not loaded yet */
    }
  }

  return allCoords;
}

/**
 * Flood water on roads — clips each road segment to the flood radius.
 *
 * For each flooding sensor:
 * 1. Find closest road (must be within 30m)
 * 2. Clip each road segment to the circle of radius maxDist
 * 3. Only the clipped portion is colored
 */
export function calculateFloodFeatures(
  roads: number[][][],
  devices: Device[],
  depths: Record<string, number>,
): GeoJSON.Feature[] {
  const flooding = devices
    .filter((d) => (depths[d.device_id] ?? 0) > 0)
    .map((d) => ({
      lng: d.lng,
      lat: d.lat,
      depth: depths[d.device_id] ?? 0,
    }));
  if (flooding.length === 0 || roads.length === 0) return [];

  // Best intensity per road segment (road index | segment index)
  const best = new Map<string, {
    intensity: number;
    depth: number;
    coords: [number[], number[]];
  }>();

  for (const sensor of flooding) {
    const sensorPt = [sensor.lng, sensor.lat];

    // Find snap distance — sensor must be within 30m of a road
    let snapDist = Infinity;
    for (const road of roads) {
      for (let i = 0; i < road.length - 1; i++) {
        const d = ptSegDist(sensorPt, road[i], road[i + 1]);
        if (d < snapDist) snapDist = d;
      }
    }
    if (snapDist > 30) continue;

    // Tight spread: 20m base + 1.5m per cm depth, max 60m
    const maxDist = Math.min(60, 20 + sensor.depth * 1.5);

    for (let ri = 0; ri < roads.length; ri++) {
      const road = roads[ri];
      for (let si = 0; si < road.length - 1; si++) {
        // Clip this segment to the flood radius circle
        const clipped = clipSegment(sensorPt, road[si], road[si + 1], maxDist);
        if (!clipped) continue;

        // Intensity based on closest point distance
        const dist = ptSegDist(sensorPt, clipped[0], clipped[1]);
        const intensity = Math.max(0.3, 1 - (dist / maxDist) * 0.7);

        const key = `${ri}|${si}`;
        const existing = best.get(key);
        if (!existing || intensity > existing.intensity) {
          best.set(key, { intensity, depth: sensor.depth, coords: clipped });
        }
      }
    }
  }

  const features: GeoJSON.Feature[] = [];
  for (const [, entry] of best) {
    features.push({
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: entry.coords,
      },
      properties: { intensity: entry.intensity, depth: entry.depth },
    });
  }

  return features;
}
