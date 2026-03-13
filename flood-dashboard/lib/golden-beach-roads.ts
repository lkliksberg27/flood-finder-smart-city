/**
 * Flood visualization using actual Mapbox road geometry ONLY.
 *
 * Sensor is on the sidewalk edge — snaps to nearest road vertex.
 * Water spreads from that point in ALL directions along connected roads.
 * BFS flood-fill at intersections. Gradient fades with distance.
 *
 * Physics: H_water = H_sensor + depth.
 * Walk along roads while H_ground <= H_water.
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

function dedupKey(coords: number[][]): string {
  const s = coords[0];
  const e = coords[coords.length - 1];
  return `${s[0].toFixed(6)},${s[1].toFixed(6)}-${e[0].toFixed(6)},${e[1].toFixed(6)}`;
}

/**
 * Query real road geometry from Mapbox vector tiles.
 * Returns raw tile segments — NO merging.
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
    const size = 120;
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

/** Estimate ground elevation at a point via IDW from sensor data. */
function estimateElevation(
  lng: number,
  lat: number,
  elevSensors: { lng: number; lat: number; elev: number }[],
): number {
  if (elevSensors.length === 0) return 0;
  let totalW = 0;
  let totalE = 0;
  for (const s of elevSensors) {
    const dx = (s.lng - lng) * 111320 * cosLat(lat);
    const dy = (s.lat - lat) * 111320;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const w = 1 / Math.max(dist, 3);
    totalW += w;
    totalE += w * s.elev;
  }
  return totalW > 0 ? totalE / totalW : 0;
}

/**
 * Flood water on roads within range of each flooding sensor.
 *
 * Mapbox tile segments typically have only 2 vertices, making BFS-walk
 * impractical. Instead, we use a distance-based approach:
 *
 * For each flooding sensor:
 * 1. Compute H_water = sensor_elev + depth
 * 2. Check every road segment: include if midpoint is within maxDist
 *    AND estimated ground elevation <= H_water
 * 3. Gradient intensity fades with distance from sensor
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
      elev: (d.altitude_baro ?? 0) - (d.baseline_distance_cm ?? 0) / 100,
      depth: depths[d.device_id] ?? 0,
    }));
  if (flooding.length === 0 || roads.length === 0) return [];

  const elevSensors = devices
    .filter((d) => d.altitude_baro != null)
    .map((d) => ({
      lng: d.lng,
      lat: d.lat,
      elev: (d.altitude_baro ?? 0) - (d.baseline_distance_cm ?? 0) / 100,
    }));

  const maxDepth = Math.max(1, ...flooding.map((f) => f.depth));
  const features: GeoJSON.Feature[] = [];
  // Track best intensity per segment to avoid duplicates
  const segKey = (a: number[], b: number[]) =>
    `${a[0].toFixed(6)},${a[1].toFixed(6)}-${b[0].toFixed(6)},${b[1].toFixed(6)}`;
  const bestIntensity = new Map<string, { intensity: number; depth: number }>();

  for (const sensor of flooding) {
    const sensorPt = [sensor.lng, sensor.lat];
    const H_water = sensor.elev + sensor.depth / 100;
    const maxDist = Math.min(200, 40 + sensor.depth * 5);
    const depthRatio = Math.min(1, Math.max(0.2, sensor.depth / maxDepth));

    for (const road of roads) {
      for (let i = 0; i < road.length - 1; i++) {
        const a = road[i];
        const b = road[i + 1];

        // Use closest distance to sensor: min of vertex A, vertex B, midpoint
        const dA = ptDist(sensorPt, a);
        const dB = ptDist(sensorPt, b);
        const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const dMid = ptDist(sensorPt, mid);
        const distToSensor = Math.min(dA, dB, dMid);

        if (distToSensor > maxDist) continue;

        // Skip segments very far above water (but allow close ones through)
        if (distToSensor > 15) {
          const H_ground = estimateElevation(mid[0], mid[1], elevSensors);
          if (H_ground > H_water) continue;
        }

        // Gradient: 1.0 at sensor → 0.15 at max distance
        const distFade = 1 - (distToSensor / Math.max(maxDist, 1)) * 0.85;
        const intensity = Math.min(1, Math.max(0.08, depthRatio * distFade));

        // Keep the highest intensity per segment
        const key = segKey(a, b);
        const existing = bestIntensity.get(key);
        if (!existing || intensity > existing.intensity) {
          bestIntensity.set(key, { intensity, depth: sensor.depth });
        }
      }
    }
  }

  // Convert to GeoJSON features
  for (const [key, props] of bestIntensity) {
    const [aStr, bStr] = key.split("-");
    const [aLng, aLat] = aStr.split(",").map(Number);
    const [bLng, bLat] = bStr.split(",").map(Number);

    features.push({
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: [[aLng, aLat], [bLng, bLat]],
      },
      properties: props,
    });
  }

  return features;
}
