/**
 * Flood visualization using actual Mapbox road geometry ONLY.
 *
 * For each flooding sensor:
 * 1. Find the exact closest point on any road (snap point)
 * 2. Color nearby road polylines within a tight radius
 * 3. Full road polylines — no choppy 2-point segments
 */
import type { Device } from "./types";
import type mapboxgl from "mapbox-gl";

function cosLat(lat: number): number {
  return Math.cos((lat * Math.PI) / 180);
}

/** Distance between two [lng,lat] points in meters. */
function ptDist(a: number[], b: number[]): number {
  const lat = (a[1] + b[1]) / 2;
  const dx = (a[0] - b[0]) * 111320 * cosLat(lat);
  const dy = (a[1] - b[1]) * 111320;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Perpendicular distance from point p to segment [a, b] in meters.
 * Uses proper projection onto the segment (not just endpoint/midpoint).
 */
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

/** Minimum distance from point p to any part of a road polyline. */
function ptRoadDist(p: number[], road: number[][]): number {
  let min = Infinity;
  for (let i = 0; i < road.length - 1; i++) {
    const d = ptSegDist(p, road[i], road[i + 1]);
    if (d < min) min = d;
  }
  return min;
}

function dedupKey(coords: number[][]): string {
  const s = coords[0];
  const e = coords[coords.length - 1];
  return `${s[0].toFixed(6)},${s[1].toFixed(6)}|${e[0].toFixed(6)},${e[1].toFixed(6)}`;
}

/**
 * Query real road geometry from Mapbox vector tiles.
 * Returns full road polylines from tiles.
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
 * Flood water on roads — tight radius, full road polylines.
 *
 * For each flooding sensor:
 * 1. Find closest point on any road (must be within 30m)
 * 2. Include full road polylines within a tight radius scaled by depth
 * 3. Intensity fades with distance from sensor
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

  // Track best intensity per road polyline (by index)
  const bestPerRoad = new Map<number, { intensity: number; depth: number }>();

  for (const sensor of flooding) {
    const sensorPt = [sensor.lng, sensor.lat];

    // Find snap distance: closest point on ANY road to this sensor
    let snapDist = Infinity;
    for (const road of roads) {
      const d = ptRoadDist(sensorPt, road);
      if (d < snapDist) snapDist = d;
    }

    // Sensor must be within 30m of a road
    if (snapDist > 30) continue;

    // Tight spread: 20m base + 1.5m per cm depth, max 60m
    const maxDist = Math.min(60, 20 + sensor.depth * 1.5);

    // Check each road polyline
    for (let ri = 0; ri < roads.length; ri++) {
      const road = roads[ri];
      const dist = ptRoadDist(sensorPt, road);

      if (dist > maxDist) continue;

      // Intensity: 1.0 at sensor → 0.3 at max distance
      const intensity = Math.max(0.3, 1 - (dist / maxDist) * 0.7);

      const existing = bestPerRoad.get(ri);
      if (!existing || intensity > existing.intensity) {
        bestPerRoad.set(ri, { intensity, depth: sensor.depth });
      }
    }
  }

  // Convert to GeoJSON features using FULL road polylines
  const features: GeoJSON.Feature[] = [];
  for (const [ri, props] of bestPerRoad) {
    features.push({
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: roads[ri],
      },
      properties: props,
    });
  }

  return features;
}
