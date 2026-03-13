/**
 * Flood visualization on actual Mapbox roads ONLY.
 *
 * For each flooding sensor:
 * 1. Find the single closest point on any road (snap point)
 * 2. BFS from that road through connected streets at intersections
 * 3. Clip each segment to the coverage radius around the snap point
 * 4. Water only travels along connected roads — never jumps gaps
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

/** Find the closest point on a road polyline, returns the [lng,lat] of that point. */
function snapToRoad(p: number[], road: number[][]): number[] {
  let bestDist = Infinity;
  let bestT = 0;
  let bestSeg = 0;
  const lat0 = p[1];
  const cL = cosLat(lat0);
  const S = 111320;
  const px = p[0] * S * cL, py = p[1] * S;

  for (let i = 0; i < road.length - 1; i++) {
    const ax = road[i][0] * S * cL, ay = road[i][1] * S;
    const bx = road[i + 1][0] * S * cL, by = road[i + 1][1] * S;
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    let t = 0;
    if (lenSq >= 0.01) {
      t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
    }
    const cx = ax + t * dx, cy = ay + t * dy;
    const dist = Math.sqrt((px - cx) ** 2 + (py - cy) ** 2);
    if (dist < bestDist) {
      bestDist = dist;
      bestT = t;
      bestSeg = i;
    }
  }

  const a = road[bestSeg], b = road[bestSeg + 1];
  return [a[0] + bestT * (b[0] - a[0]), a[1] + bestT * (b[1] - a[1])];
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

  if (A2 < 0.01) return C2 <= 0 ? [a, b] : null;

  const disc = B2 * B2 - 4 * A2 * C2;
  if (disc < 0) return C2 <= 0 ? [a, b] : null;

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

/** Direction unit vector of a road (start→end), in projected coords. */
function roadDir(road: number[][]): [number, number] {
  const s = road[0], e = road[road.length - 1];
  const lat = (s[1] + e[1]) / 2;
  const cL = cosLat(lat);
  const dx = (e[0] - s[0]) * cL;
  const dy = e[1] - s[1];
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-10) return [1, 0];
  return [dx / len, dy / len];
}

/** Angle between two road directions in degrees (0-90, direction-agnostic). */
function turnAngle(d1: [number, number], d2: [number, number]): number {
  const dot = Math.abs(d1[0] * d2[0] + d1[1] * d2[1]);
  return Math.acos(Math.min(1, dot)) * (180 / Math.PI);
}

/** Query real road geometry from Mapbox vector tiles. */
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
    const size = 150;
    const bbox: [mapboxgl.PointLike, mapboxgl.PointLike] = [
      [point.x - size, point.y - size],
      [point.x + size, point.y + size],
    ];
    try {
      const features = map.queryRenderedFeatures(bbox, { layers: roadLayerIds });
      for (const f of features) {
        if (f.geometry.type === "LineString") {
          const coords = (f.geometry as GeoJSON.LineString).coordinates as number[][];
          if (!coords || coords.length < 2) continue;
          const key = dedupKey(coords);
          if (seen.has(key)) continue;
          seen.add(key);
          allCoords.push(coords);
        } else if (f.geometry.type === "MultiLineString") {
          for (const coords of (f.geometry as GeoJSON.MultiLineString).coordinates as number[][][]) {
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
 * Flood water spreads FROM the snap point THROUGH connected streets.
 *
 * 1. Find snap point (closest point on any road)
 * 2. BFS along connected roads — turns penalise spread distance
 * 3. Clip each connected road to the (turn-adjusted) coverage radius
 * 4. Subdivide into ~5 m pieces for a smooth intensity gradient
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
      elevation: (d.altitude_baro ?? 0) - (d.baseline_distance_cm ?? 0) / 100,
    }));
  if (flooding.length === 0 || roads.length === 0) return [];

  // Build road connectivity graph: endpoints within 10 m = intersection
  const adj: number[][] = roads.map(() => []);
  for (let i = 0; i < roads.length; i++) {
    const iStart = roads[i][0];
    const iEnd = roads[i][roads[i].length - 1];
    for (let j = i + 1; j < roads.length; j++) {
      const jStart = roads[j][0];
      const jEnd = roads[j][roads[j].length - 1];
      if (
        ptDist(iStart, jStart) < 10 || ptDist(iStart, jEnd) < 10 ||
        ptDist(iEnd, jStart) < 10 || ptDist(iEnd, jEnd) < 10
      ) {
        adj[i].push(j);
        adj[j].push(i);
      }
    }
  }

  // Precompute road direction vectors for turn detection
  const dirs = roads.map(roadDir);

  // Best result per road segment across all sensors
  const best = new Map<string, {
    intensity: number;
    depth: number;
    coords: [number[], number[]];
    snapPt: number[];
    maxDist: number;
    turnCost: number;
  }>();

  for (const sensor of flooding) {
    const sensorPt = [sensor.lng, sensor.lat];

    // Find snap road
    let snapRi = -1;
    let snapDist = Infinity;
    for (let ri = 0; ri < roads.length; ri++) {
      for (let si = 0; si < roads[ri].length - 1; si++) {
        const d = ptSegDist(sensorPt, roads[ri][si], roads[ri][si + 1]);
        if (d < snapDist) { snapDist = d; snapRi = ri; }
      }
    }
    if (snapRi < 0 || snapDist > 30) continue;

    const snapPt = snapToRoad(sensorPt, roads[snapRi]);

    // Coverage radius: depth + elevation bonus (higher ground → more spread)
    const elevBonus = Math.max(0, Math.min(15, sensor.elevation * 2));
    const maxDist = Math.min(75, 20 + sensor.depth * 1.5 + elevBonus);

    // BFS with turn-cost tracking
    const reachable = new Map<number, number>(); // road index → accumulated turn cost
    reachable.set(snapRi, 0);
    const queue: number[] = [snapRi];

    while (queue.length > 0) {
      const ri = queue.shift()!;
      const parentCost = reachable.get(ri)!;

      for (const nri of adj[ri]) {
        if (reachable.has(nri)) continue;

        const angle = turnAngle(dirs[ri], dirs[nri]);
        const penalty = angle < 20 ? 0 : angle < 50 ? angle * 0.3 : angle * 0.6;
        const newCost = parentCost + penalty;

        // Too many turns — water won't reach
        if (newCost > maxDist * 0.7) continue;

        // Effective radius shrinks with accumulated turns
        const effRadius = maxDist - newCost * 0.4;
        let nearEnough = false;
        for (let si = 0; si < roads[nri].length - 1; si++) {
          if (ptSegDist(snapPt, roads[nri][si], roads[nri][si + 1]) <= effRadius) {
            nearEnough = true;
            break;
          }
        }
        if (nearEnough) {
          reachable.set(nri, newCost);
          queue.push(nri);
        }
      }
    }

    // Clip reachable roads and record best per segment
    for (const [ri, turnCost] of reachable) {
      const road = roads[ri];
      const effRadius = maxDist - turnCost * 0.4;

      for (let si = 0; si < road.length - 1; si++) {
        const clipped = clipSegment(snapPt, road[si], road[si + 1], effRadius);
        if (!clipped) continue;

        const dist = ptSegDist(snapPt, clipped[0], clipped[1]);
        const turnFade = Math.max(0.5, 1 - turnCost / maxDist);
        const intensity = Math.max(0.1, (1 - (dist / maxDist) * 0.9) * turnFade);

        const key = `${ri}|${si}`;
        const existing = best.get(key);
        if (!existing || intensity > existing.intensity) {
          best.set(key, { intensity, depth: sensor.depth, coords: clipped, snapPt, maxDist, turnCost });
        }
      }
    }
  }

  // Subdivide winning segments into ~5 m pieces for smooth gradient
  const features: GeoJSON.Feature[] = [];
  for (const [, entry] of best) {
    const [a, b] = entry.coords;
    const segLen = ptDist(a, b);
    const numPieces = Math.max(1, Math.ceil(segLen / 5));

    for (let p = 0; p < numPieces; p++) {
      const t0 = p / numPieces;
      const t1 = (p + 1) / numPieces;
      const p0 = [a[0] + t0 * (b[0] - a[0]), a[1] + t0 * (b[1] - a[1])];
      const p1 = [a[0] + t1 * (b[0] - a[0]), a[1] + t1 * (b[1] - a[1])];
      const mid = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];

      const dist = ptDist(entry.snapPt, mid);
      const turnFade = Math.max(0.5, 1 - entry.turnCost / entry.maxDist);
      const intensity = Math.max(0.1, (1 - (dist / entry.maxDist) * 0.9) * turnFade);

      features.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: [p0, p1] },
        properties: { intensity, depth: entry.depth },
      });
    }
  }

  return features;
}
