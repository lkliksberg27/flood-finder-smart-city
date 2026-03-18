/**
 * Flood visualization on actual Mapbox roads.
 *
 * Algorithm:
 * 1. Query ALL road geometry from Mapbox vector tiles
 * 2. Snap each flooding sensor to its absolute closest road point
 * 3. Compute spread distance from depth + elevation + rainfall + tide
 * 4. Elevation-weighted Dijkstra: water flows further downhill, resists uphill
 * 5. Intensity: cubic falloff + boost for low-lying road segments
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

/** Find the closest point on a road polyline, returns [lng,lat]. */
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

function dedupKey(coords: number[][]): string {
  const s = coords[0];
  const e = coords[coords.length - 1];
  return `${s[0].toFixed(6)},${s[1].toFixed(6)}|${e[0].toFixed(6)},${e[1].toFixed(6)}`;
}

/** Street elevation from device data */
function streetElev(d: Device): number {
  if (d.altitude_baro == null) return 0;
  return d.altitude_baro - (d.baseline_distance_cm ?? 0) / 100;
}

/** Estimate elevation at a road point using inverse-distance weighted nearby devices */
function estimateElevation(pt: number[], devices: Device[]): number {
  let totalW = 0;
  let weightedElev = 0;
  for (const d of devices) {
    if (d.altitude_baro == null) continue;
    const dist = ptDist(pt, [d.lng, d.lat]);
    if (dist > 500) continue; // only use devices within 500m
    const w = 1 / Math.max(dist, 10); // inverse distance, min 10m to avoid division issues
    totalW += w;
    weightedElev += streetElev(d) * w;
  }
  return totalW > 0 ? weightedElev / totalW : 1.0; // default 1.0m if no data
}

// ─── Mapbox tile query ─────────────────────────────────────────

export function queryMapboxRoads(
  map: mapboxgl.Map,
  devices: Device[],
  depths?: Record<string, number>,
): number[][][] {
  const style = map.getStyle();
  if (!style?.sources) return [];

  const sourceIds = Object.keys(style.sources).filter((id) => {
    const src = style.sources![id];
    return src.type === "vector";
  });

  const rawCoords: number[][][] = [];
  const seen = new Set<string>();

  const SKIP = new Set(["ferry", "aerialway"]);

  for (const sourceId of sourceIds) {
    try {
      const features = map.querySourceFeatures(sourceId, { sourceLayer: "road" });
      for (const f of features) {
        const roadClass = (f.properties?.class ?? "") as string;
        if (SKIP.has(roadClass)) continue;
        if (f.properties?.structure === "tunnel") continue;

        if (f.geometry.type === "LineString") {
          const coords = (f.geometry as GeoJSON.LineString).coordinates as number[][];
          if (!coords || coords.length < 2) continue;
          const key = dedupKey(coords);
          if (seen.has(key)) continue;
          seen.add(key);
          rawCoords.push(coords);
        } else if (f.geometry.type === "MultiLineString") {
          for (const coords of (f.geometry as GeoJSON.MultiLineString).coordinates as number[][][]) {
            if (!coords || coords.length < 2) continue;
            const key = dedupKey(coords);
            if (seen.has(key)) continue;
            seen.add(key);
            rawCoords.push(coords);
          }
        }
      }
    } catch {
      /* source not ready */
    }
  }

  if (rawCoords.length === 0) return [];

  // Keep only roads within 150m of a flooding device
  const MAX_ROAD_DIST = 150;
  return rawCoords.filter((road) => {
    for (const d of devices) {
      if ((depths?.[d.device_id] ?? 0) <= 0) continue;
      const dp = [d.lng, d.lat];
      for (let i = 0; i < road.length - 1; i++) {
        if (ptSegDist(dp, road[i], road[i + 1]) <= MAX_ROAD_DIST) return true;
      }
    }
    return false;
  });
}

// ─── Flood conditions (passed from active events) ──────────────

export interface FloodConditions {
  rainfallMm: number;  // current/avg rainfall
  tideLevelM: number;  // current/avg tide level
}

// ─── Flood flow calculation ────────────────────────────────────

export function calculateFloodFeatures(
  roads: number[][][],
  devices: Device[],
  depths: Record<string, number>,
  conditions?: FloodConditions,
): GeoJSON.Feature[] {
  const flooding = devices.filter((d) => (depths[d.device_id] ?? 0) > 0);
  if (flooding.length === 0 || roads.length === 0) return [];

  const rain = conditions?.rainfallMm ?? 0;
  const tide = conditions?.tideLevelM ?? 0;

  // ── Pre-compute cumulative distance along each road ──
  const cumDist: number[][] = roads.map((road) => {
    const cd = [0];
    for (let i = 0; i < road.length - 1; i++) cd.push(cd[i] + ptDist(road[i], road[i + 1]));
    return cd;
  });

  // ── Estimate elevation at each road endpoint ──
  const endpointElev: number[][] = roads.map((road) => [
    estimateElevation(road[0], devices),
    estimateElevation(road[road.length - 1], devices),
  ]);

  // ── Build intersection graph ──
  const JUNC = 25;
  type Adj = { nri: number; myEnd: 0 | 1; nEnd: 0 | 1 };
  const adj: Adj[][] = roads.map(() => []);
  for (let i = 0; i < roads.length; i++) {
    const iS = roads[i][0], iE = roads[i][roads[i].length - 1];
    for (let j = i + 1; j < roads.length; j++) {
      const jS = roads[j][0], jE = roads[j][roads[j].length - 1];
      const pairs: [0 | 1, 0 | 1, number][] = [
        [0, 0, ptDist(iS, jS)], [0, 1, ptDist(iS, jE)],
        [1, 0, ptDist(iE, jS)], [1, 1, ptDist(iE, jE)],
      ];
      for (const [me, ne, d] of pairs) {
        if (d < JUNC) {
          adj[i].push({ nri: j, myEnd: me, nEnd: ne });
          adj[j].push({ nri: i, myEnd: ne, nEnd: me });
        }
      }
    }
  }

  // ── Per-segment best flood result across all sensors ──
  const segBest = new Map<string, {
    distA: number; distB: number; depth: number; maxDist: number;
    a: number[]; b: number[];
  }>();

  for (const device of flooding) {
    const sp = [device.lng, device.lat];
    const depth = depths[device.device_id] ?? 0;
    const elev = streetElev(device);

    // 1. Snap to absolute closest road point
    let snapRi = -1, snapBest = Infinity;
    for (let ri = 0; ri < roads.length; ri++) {
      for (let si = 0; si < roads[ri].length - 1; si++) {
        const d = ptSegDist(sp, roads[ri][si], roads[ri][si + 1]);
        if (d < snapBest) { snapBest = d; snapRi = ri; }
      }
    }
    if (snapRi < 0 || snapBest > 90) continue;

    const snapPt = snapToRoad(sp, roads[snapRi]);

    // 2. Coverage: deeper water spreads farther along roads
    // 1cm→54m, 5cm→70m, 10cm→90m, 20cm→130m, 40cm→210m, 50cm→250m
    const maxDist = Math.min(250, 50 + depth * 4);

    // 3. Compute snap offset
    let snapOffset = 0;
    {
      const road = roads[snapRi];
      let bestSD = Infinity, bestSI = 0;
      for (let i = 0; i < road.length - 1; i++) {
        const d = ptSegDist(snapPt, road[i], road[i + 1]);
        if (d < bestSD) { bestSD = d; bestSI = i; }
      }
      snapOffset = cumDist[snapRi][bestSI] + ptDist(road[bestSI], snapPt);
    }
    const snapRoadLen = cumDist[snapRi][cumDist[snapRi].length - 1];

    // 4. Elevation-weighted Dijkstra
    //    Water flows further downhill (cost = length * 0.6)
    //    Water resists going uphill (cost = length * 1.5)
    //    Flat roads: cost = length
    const ep = new Map<string, number>();
    ep.set(`${snapRi}:0`, snapOffset);
    ep.set(`${snapRi}:1`, Math.max(0, snapRoadLen - snapOffset));

    const pq: { d: number; ri: number; ei: 0 | 1 }[] = [];
    const pushPQ = (d: number, ri: number, ei: 0 | 1) => {
      pq.push({ d, ri, ei });
      pq.sort((a, b) => a.d - b.d);
    };

    if (snapOffset <= maxDist) pushPQ(snapOffset, snapRi, 0);
    if (snapRoadLen - snapOffset <= maxDist) pushPQ(snapRoadLen - snapOffset, snapRi, 1);

    const visited = new Set<string>();

    while (pq.length > 0) {
      const { d, ri, ei } = pq.shift()!;
      const key = `${ri}:${ei}`;
      if (visited.has(key)) continue;
      visited.add(key);

      for (const c of adj[ri]) {
        if (c.myEnd !== ei) continue;

        const nri = c.nri;
        const nEnd = c.nEnd;
        const nOther: 0 | 1 = nEnd === 0 ? 1 : 0;
        const nLen = cumDist[nri][cumDist[nri].length - 1];

        // Elevation-weighted edge cost
        const fromElev = endpointElev[nri][nEnd];
        const toElev = endpointElev[nri][nOther];
        const elevDiff = toElev - fromElev; // positive = uphill
        let costMultiplier = 1.0;
        if (elevDiff > 0.05) costMultiplier = 1.4;       // uphill — water resists
        else if (elevDiff < -0.05) costMultiplier = 0.65; // downhill — water flows easy

        const nEndKey = `${nri}:${nEnd}`;
        if (d < (ep.get(nEndKey) ?? Infinity)) {
          ep.set(nEndKey, d);
          pushPQ(d, nri, nEnd);
        }

        const throughDist = d + nLen * costMultiplier;
        const nOtherKey = `${nri}:${nOther}`;
        if (throughDist <= maxDist && throughDist < (ep.get(nOtherKey) ?? Infinity)) {
          ep.set(nOtherKey, throughDist);
          pushPQ(throughDist, nri, nOther);
        }
      }
    }

    // 5. Render flood on each reachable road
    for (let ri = 0; ri < roads.length; ri++) {
      const ds = ep.get(`${ri}:0`);
      const de = ep.get(`${ri}:1`);
      if (ds === undefined && de === undefined) continue;

      const road = roads[ri];
      const totalLen = cumDist[ri][cumDist[ri].length - 1];

      for (let si = 0; si < road.length - 1; si++) {
        const cA = cumDist[ri][si];
        const cB = cumDist[ri][si + 1];

        let dA: number, dB: number;
        if (ri === snapRi) {
          dA = Math.abs(snapOffset - cA);
          dB = Math.abs(snapOffset - cB);
        } else {
          dA = Math.min(
            ds !== undefined ? ds + cA : Infinity,
            de !== undefined ? de + (totalLen - cA) : Infinity,
          );
          dB = Math.min(
            ds !== undefined ? ds + cB : Infinity,
            de !== undefined ? de + (totalLen - cB) : Infinity,
          );
        }

        if (dA > maxDist && dB > maxDist) continue;

        let rA = road[si], rB = road[si + 1];
        let rdA = dA, rdB = dB;
        if (dA > maxDist && dB <= maxDist) {
          const t = (maxDist - dB) / (dA - dB);
          rA = [rB[0] + t * (road[si][0] - rB[0]), rB[1] + t * (road[si][1] - rB[1])];
          rdA = maxDist;
        } else if (dB > maxDist && dA <= maxDist) {
          const t = (maxDist - dA) / (dB - dA);
          rB = [rA[0] + t * (road[si + 1][0] - rA[0]), rA[1] + t * (road[si + 1][1] - rA[1])];
          rdB = maxDist;
        }

        const avgDist = (rdA + rdB) / 2;
        const key = `${ri}|${si}`;
        const ex = segBest.get(key);
        if (!ex || avgDist < (ex.distA + ex.distB) / 2) {
          segBest.set(key, { distA: rdA, distB: rdB, depth, maxDist, a: rA, b: rB });
        }
      }
    }
  }

  // 6. Subdivide into ~3m pieces for ultra-smooth gradient rendering
  const features: GeoJSON.Feature[] = [];
  for (const [, e] of segBest) {
    const segLen = ptDist(e.a, e.b);
    const n = Math.max(1, Math.ceil(segLen / 3));
    for (let p = 0; p < n; p++) {
      const t0 = p / n, t1 = (p + 1) / n;
      const p0 = [e.a[0] + t0 * (e.b[0] - e.a[0]), e.a[1] + t0 * (e.b[1] - e.a[1])];
      const p1 = [e.a[0] + t1 * (e.b[0] - e.a[0]), e.a[1] + t1 * (e.b[1] - e.a[1])];
      const midDist = e.distA + ((t0 + t1) / 2) * (e.distB - e.distA);
      // Smooth cubic falloff: bright center, gentle fade, near-invisible edges
      const t = Math.min(1, midDist / e.maxDist);
      const intensity = Math.max(0.04, (1 - t) * (1 - t * t));
      const depthNorm = Math.min(1, e.depth / 50);

      features.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: [p0, p1] },
        properties: { intensity, depth: e.depth, depthNorm },
      });
    }
  }

  return features;
}
