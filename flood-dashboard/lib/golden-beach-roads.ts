/**
 * Flood visualization using actual Mapbox road geometry ONLY.
 *
 * Sensor is on the sidewalk edge — snaps to nearest road within 2.5m.
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

function ptDist(a: number[], b: number[]): number {
  const lat = (a[1] + b[1]) / 2;
  const dx = (a[0] - b[0]) * 111320 * cosLat(lat);
  const dy = (a[1] - b[1]) * 111320;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Project point P onto segment A→B, return projected point + distance. */
function projectOntoSegment(
  p: number[],
  a: number[],
  b: number[],
): { point: number[]; dist: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return { point: a, dist: ptDist(p, a) };
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const proj = [a[0] + t * dx, a[1] + t * dy];
  return { point: proj, dist: ptDist(p, proj) };
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
 * 1. Snap sensor to nearest road within 2.5m (it's on the sidewalk edge)
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
    const sensorPt = [sensor.lng, sensor.lat];
    const H_water = sensor.elev + sensor.depth / 100;
    const maxWalk = Math.min(200, 40 + sensor.depth * 5);
    const depthRatio = Math.min(1, Math.max(0.2, sensor.depth / maxDepth));

    // 1. Snap sensor to nearest road edge — must be within 2.5m
    let bestRoadIdx = -1;
    let bestSegIdx = -1;
    let bestProj = sensorPt;
    let bestDist = Infinity;

    for (let r = 0; r < roads.length; r++) {
      for (let i = 0; i < roads[r].length - 1; i++) {
        const { point, dist } = projectOntoSegment(
          sensorPt,
          roads[r][i],
          roads[r][i + 1],
        );
        if (dist < bestDist) {
          bestDist = dist;
          bestRoadIdx = r;
          bestSegIdx = i;
          bestProj = point;
        }
      }
    }

    // Sensor is on sidewalk edge, road geometry is centerline
    if (bestRoadIdx === -1 || bestDist > 25) continue;

    // 2. BFS flood-fill along road network from sensor position
    const ptKey = (p: number[]) =>
      `${p[0].toFixed(5)},${p[1].toFixed(5)}`;
    const visitedEnds = new Set<string>();

    interface WalkTask {
      road: number[][];
      startIdx: number;
      direction: 1 | -1;
      entryPt: number[];
      baseDist: number;
    }

    const queue: WalkTask[] = [
      // Forward along starting road
      {
        road: roads[bestRoadIdx],
        startIdx: bestSegIdx + 1,
        direction: 1,
        entryPt: bestProj,
        baseDist: 0,
      },
      // Backward along starting road
      {
        road: roads[bestRoadIdx],
        startIdx: bestSegIdx,
        direction: -1,
        entryPt: bestProj,
        baseDist: 0,
      },
    ];

    while (queue.length > 0) {
      const task = queue.shift()!;
      if (task.baseDist >= maxWalk) continue;

      // Walk along road, building coords away from sensor
      const coords: number[][] = [task.entryPt];
      let dist = task.baseDist;
      let stoppedByElevation = false;

      const step = task.direction;
      const limit = step === 1 ? task.road.length : -1;

      for (let i = task.startIdx; i !== limit && dist < maxWalk; i += step) {
        const prev = coords[coords.length - 1];
        const curr = task.road[i];
        const segLen = ptDist(prev, curr);
        dist += segLen;

        const H_ground = estimateElevation(curr[0], curr[1], elevSensors);

        if (H_ground > H_water && dist > task.baseDist + 8) {
          // Interpolate boundary point
          const prevH = estimateElevation(prev[0], prev[1], elevSensors);
          const rise = H_ground - prevH;
          if (rise > 0.001) {
            const frac = Math.max(0, Math.min(1, (H_water - prevH) / rise));
            coords.push([
              prev[0] + (curr[0] - prev[0]) * frac,
              prev[1] + (curr[1] - prev[1]) * frac,
            ]);
          }
          stoppedByElevation = true;
          break;
        }
        coords.push(curr);
      }

      // 3. Generate gradient sub-segments from this walk
      if (coords.length >= 2) {
        let cumDist = task.baseDist;
        for (let i = 0; i < coords.length - 1; i++) {
          const segLen = ptDist(coords[i], coords[i + 1]);
          const midDist = cumDist + segLen / 2;
          cumDist += segLen;

          // Fade: 1.0 at sensor → 0.15 at max distance
          const distFade = 1 - (midDist / Math.max(maxWalk, 1)) * 0.85;
          const intensity = Math.min(1, Math.max(0.08, depthRatio * distFade));

          features.push({
            type: "Feature",
            geometry: {
              type: "LineString",
              coordinates: [coords[i], coords[i + 1]],
            },
            properties: { intensity, depth: sensor.depth },
          });
        }
      }

      // 4. At road ends, find connected roads and continue spreading
      if (!stoppedByElevation && coords.length >= 2 && dist < maxWalk) {
        const endPt = coords[coords.length - 1];
        const ek = ptKey(endPt);
        if (!visitedEnds.has(ek)) {
          visitedEnds.add(ek);
          for (let r = 0; r < roads.length; r++) {
            const rd = roads[r];
            if (rd === task.road) continue;
            // Road starts near our endpoint → walk forward
            if (ptDist(endPt, rd[0]) < 8) {
              queue.push({
                road: rd,
                startIdx: 1,
                direction: 1,
                entryPt: rd[0],
                baseDist: dist,
              });
            }
            // Road ends near our endpoint → walk backward
            if (ptDist(endPt, rd[rd.length - 1]) < 8) {
              queue.push({
                road: rd,
                startIdx: rd.length - 2,
                direction: -1,
                entryPt: rd[rd.length - 1],
                baseDist: dist,
              });
            }
          }
        }
      }
    }
  }

  return features;
}
