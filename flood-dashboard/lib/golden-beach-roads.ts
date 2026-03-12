/**
 * Flood visualization using actual Mapbox road geometry ONLY.
 *
 * No synthetic roads. No merging across gaps. No extrapolation.
 * Each road segment from Mapbox tiles is walked independently.
 * Water NEVER crosses non-road areas.
 *
 * Physics: H_water = H_sensor + depth.
 * Walk along each tile road segment while H_ground <= H_water.
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

function dedupKey(coords: number[][]): string {
  const s = coords[0];
  const e = coords[coords.length - 1];
  return `${s[0].toFixed(6)},${s[1].toFixed(6)}-${e[0].toFixed(6)},${e[1].toFixed(6)}`;
}

/**
 * Query real road geometry from Mapbox vector tiles.
 * Returns raw tile segments — NO merging, so lines never jump across water.
 * Returns empty array if tiles aren't loaded yet — caller should retry.
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
    // Tight bbox — only roads actually near the sensor, not across waterways
    const size = 100;
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
          // Handle ALL parts, not just the first
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

  // Return raw segments — NO merging. Each tile segment is a valid road piece.
  return allCoords;
}

/**
 * Estimate ground elevation at a point via IDW from sensor data.
 */
function estimateElevation(
  lng: number,
  lat: number,
  elevSensors: { lng: number; lat: number; elev: number }[],
): number {
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
 * Flood water strictly on the ONE road the sensor sits on.
 *
 * For each flooding sensor:
 * 1. Find the single closest road (the one it's physically on)
 * 2. Walk along that road using WSE model
 * 3. Spread distance scales with depth — shallow floods stay local
 *
 * H_water = H_sensor + depth.
 * Walk while H_ground <= H_water.
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

  for (const sensor of flooding) {
    const sensorPt: number[] = [sensor.lng, sensor.lat];
    const H_water = sensor.elev + sensor.depth / 100;

    // Spread scales with depth: shallow (<10cm) ~60m, moderate ~120m, deep ~200m
    const maxWalk = Math.min(200, 40 + sensor.depth * 5);

    // Find the ONE closest road — the road this sensor is sitting on
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

    // Must be within 25m of an actual road
    if (!bestRoad || bestDist > 25) continue;

    // Walk forward along this road
    const seg: number[][] = [bestRoad[bestIdx]];
    let fwdDist = 0;
    for (let i = bestIdx + 1; i < bestRoad.length && fwdDist < maxWalk; i++) {
      const stepDist = ptDist(bestRoad[i - 1], bestRoad[i]);
      fwdDist += stepDist;

      const H_ground = estimateElevation(
        bestRoad[i][0],
        bestRoad[i][1],
        elevSensors,
      );

      if (H_ground > H_water && fwdDist > 20) {
        const prevH = estimateElevation(
          bestRoad[i - 1][0],
          bestRoad[i - 1][1],
          elevSensors,
        );
        const rise = H_ground - prevH;
        if (rise > 0.001) {
          const frac = Math.max(0, Math.min(1, (H_water - prevH) / rise));
          seg.push([
            bestRoad[i - 1][0] + (bestRoad[i][0] - bestRoad[i - 1][0]) * frac,
            bestRoad[i - 1][1] + (bestRoad[i][1] - bestRoad[i - 1][1]) * frac,
          ]);
        }
        break;
      }
      seg.push(bestRoad[i]);
    }

    // Walk backward along this road
    let bwdDist = 0;
    for (let i = bestIdx - 1; i >= 0 && bwdDist < maxWalk; i--) {
      const stepDist = ptDist(bestRoad[i + 1], bestRoad[i]);
      bwdDist += stepDist;

      const H_ground = estimateElevation(
        bestRoad[i][0],
        bestRoad[i][1],
        elevSensors,
      );

      if (H_ground > H_water && bwdDist > 20) {
        const prevH = estimateElevation(
          bestRoad[i + 1][0],
          bestRoad[i + 1][1],
          elevSensors,
        );
        const rise = H_ground - prevH;
        if (rise > 0.001) {
          const frac = Math.max(0, Math.min(1, (H_water - prevH) / rise));
          seg.unshift([
            bestRoad[i + 1][0] + (bestRoad[i][0] - bestRoad[i + 1][0]) * frac,
            bestRoad[i + 1][1] + (bestRoad[i][1] - bestRoad[i + 1][1]) * frac,
          ]);
        }
        break;
      }
      seg.unshift(bestRoad[i]);
    }

    if (seg.length < 2) continue;

    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: seg },
      properties: {
        intensity: Math.min(1, Math.max(0.15, sensor.depth / maxDepth)),
        depth: sensor.depth,
      },
    });
  }

  return features;
}
