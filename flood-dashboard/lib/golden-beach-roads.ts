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
 * Flood water using BFS spread from sensor position on road.
 *
 * 1. Snap sensor to nearest road vertex within 30m
 * 2. BFS flood-fill: spread in all directions along connected roads
 * 3. Stop when H_ground > H_water or distance exceeds max
 * 4. Generate gradient sub-segments that fade with distance
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

  for (const sensor of flooding) {
    const sensorPt = [sensor.lng, sensor.lat];
    const H_water = sensor.elev + sensor.depth / 100;
    const maxWalk = Math.min(200, 40 + sensor.depth * 5);
    const depthRatio = Math.min(1, Math.max(0.2, sensor.depth / maxDepth));

    // 1. Snap sensor to nearest road vertex — within 30m
    let bestRoadIdx = -1;
    let bestVertIdx = -1;
    let bestDist = Infinity;

    for (let r = 0; r < roads.length; r++) {
      for (let v = 0; v < roads[r].length; v++) {
        const d = ptDist(sensorPt, roads[r][v]);
        if (d < bestDist) {
          bestDist = d;
          bestRoadIdx = r;
          bestVertIdx = v;
        }
      }
    }

    if (bestRoadIdx === -1 || bestDist > 30) continue;

    // 2. BFS flood-fill along road network from nearest vertex
    const endKey = (p: number[]) =>
      `${p[0].toFixed(5)},${p[1].toFixed(5)}`;
    const visitedEnds = new Set<string>();
    const startPt = roads[bestRoadIdx][bestVertIdx];

    // Queue entries: [road, startIdx, direction(1|-1), entryPoint, accumulatedDist]
    const queue: Array<[number[][], number, number, number[], number]> = [];

    // Walk forward from nearest vertex
    if (bestVertIdx < roads[bestRoadIdx].length - 1) {
      queue.push([roads[bestRoadIdx], bestVertIdx + 1, 1, startPt, 0]);
    }
    // Walk backward from nearest vertex
    if (bestVertIdx > 0) {
      queue.push([roads[bestRoadIdx], bestVertIdx - 1, -1, startPt, 0]);
    }
    // Edge case: only 1 vertex match, no direction to walk — skip
    if (queue.length === 0) continue;

    while (queue.length > 0) {
      const [road, startIdx, dir, entryPt, baseDist] = queue.shift()!;
      if (baseDist >= maxWalk) continue;

      // Walk along road vertices, building coords list
      const coords: number[][] = [entryPt];
      let dist = baseDist;
      let stoppedByElev = false;
      const end = dir === 1 ? road.length : -1;

      for (let i = startIdx; i !== end && dist < maxWalk; i += dir) {
        const prev = coords[coords.length - 1];
        const curr = road[i];
        const segLen = ptDist(prev, curr);
        dist += segLen;

        // Check elevation after walking 8m from this walk's entry
        if (dist > baseDist + 8) {
          const H_ground = estimateElevation(curr[0], curr[1], elevSensors);
          if (H_ground > H_water) {
            stoppedByElev = true;
            break;
          }
        }
        coords.push(curr);
      }

      // 3. Generate gradient sub-segments from this walk
      if (coords.length >= 2) {
        let cumDist = baseDist;
        for (let j = 0; j < coords.length - 1; j++) {
          const segLen = ptDist(coords[j], coords[j + 1]);
          const midDist = cumDist + segLen / 2;
          cumDist += segLen;

          // Fade: 1.0 at sensor → 0.15 at max distance
          const distFade = 1 - (midDist / Math.max(maxWalk, 1)) * 0.85;
          const intensity = Math.min(1, Math.max(0.08, depthRatio * distFade));

          features.push({
            type: "Feature",
            geometry: {
              type: "LineString",
              coordinates: [coords[j], coords[j + 1]],
            },
            properties: { intensity, depth: sensor.depth },
          });
        }
      }

      // 4. At road ends, find connected roads and continue spreading
      if (!stoppedByElev && coords.length >= 2 && dist < maxWalk) {
        const ep = coords[coords.length - 1];
        const ek = endKey(ep);
        if (!visitedEnds.has(ek)) {
          visitedEnds.add(ek);
          for (let r = 0; r < roads.length; r++) {
            const rd = roads[r];
            if (rd === road) continue;
            // Road starts near our endpoint → walk forward
            if (ptDist(ep, rd[0]) < 8) {
              queue.push([rd, 1, 1, rd[0], dist]);
            }
            // Road ends near our endpoint → walk backward
            if (ptDist(ep, rd[rd.length - 1]) < 8) {
              queue.push([rd, rd.length - 2, -1, rd[rd.length - 1], dist]);
            }
          }
        }
      }
    }
  }

  return features;
}
