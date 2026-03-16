/**
 * Flood visualization on actual Mapbox roads ONLY.
 *
 * For each flooding sensor:
 * 1. Snap sensor to nearest road → snap point
 * 2. Dijkstra outward along the road network through intersections
 * 3. Water flows along every connected street, branching at intersections
 * 4. Intensity fades by ALONG-ROAD distance (not straight-line)
 * 5. At intersections water splits into ALL branches evenly
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

// ─── Mapbox tile query ─────────────────────────────────────────

export function queryMapboxRoads(
  map: mapboxgl.Map,
  devices: Device[],
): number[][][] {
  const style = map.getStyle();
  if (!style?.sources) return [];

  const sourceIds = Object.keys(style.sources).filter((id) => {
    const src = style.sources![id];
    return src.type === "vector";
  });

  const rawCoords: number[][][] = [];
  const seen = new Set<string>();

  for (const sourceId of sourceIds) {
    try {
      const features = map.querySourceFeatures(sourceId, { sourceLayer: "road" });
      for (const f of features) {
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

  // console.log(`[flood] queryMapboxRoads: ${rawCoords.length} raw roads`);

  // Keep only roads within 250m of any flooding device
  const MAX_DIST = 250;
  return rawCoords.filter((road) => {
    for (const d of devices) {
      const dp = [d.lng, d.lat];
      for (let i = 0; i < road.length - 1; i++) {
        if (ptSegDist(dp, road[i], road[i + 1]) <= MAX_DIST) return true;
      }
    }
    return false;
  });
}

// ─── Flood flow calculation (Dijkstra along-road) ──────────────

/**
 * Calculate flood water features using along-road distance.
 *
 * Water flows outward from each sensor ALONG the road network:
 * - At every intersection, water branches into ALL connected streets
 * - Intensity fades by how far water has traveled through the network
 * - More water depth = farther spread along roads
 */
export function calculateFloodFeatures(
  roads: number[][][],
  devices: Device[],
  depths: Record<string, number>,
): GeoJSON.Feature[] {
  const flooding = devices
    .filter((d) => (depths[d.device_id] ?? 0) > 0)
    .map((d) => ({ lng: d.lng, lat: d.lat, depth: depths[d.device_id] ?? 0 }));
  // Removed verbose logging for production performance
  if (flooding.length === 0 || roads.length === 0) return [];

  // ── Pre-compute cumulative distance along each road ──
  const cumDist: number[][] = roads.map((road) => {
    const cd = [0];
    for (let i = 0; i < road.length - 1; i++) cd.push(cd[i] + ptDist(road[i], road[i + 1]));
    return cd;
  });

  // ── Build intersection graph ──
  // Two road endpoints within 15m = same intersection
  // (Mapbox tile boundaries can create gaps between road segment endpoints)
  const JUNC = 25; // 25m junction merge — catches Mapbox tile boundary gaps
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

  for (const sensor of flooding) {
    const sp = [sensor.lng, sensor.lat];

    // 1. Snap sensor to nearest road
    let snapRi = -1, snapBest = Infinity;
    for (let ri = 0; ri < roads.length; ri++) {
      for (let si = 0; si < roads[ri].length - 1; si++) {
        const d = ptSegDist(sp, roads[ri][si], roads[ri][si + 1]);
        if (d < snapBest) { snapBest = d; snapRi = ri; }
      }
    }
    if (snapRi < 0 || snapBest > 60) continue; // 60m snap radius

    const snapPt = snapToRoad(sp, roads[snapRi]);
    // Coverage: deeper water spreads farther along roads
    // 1cm→43m, 5cm→55m, 10cm→70m, 20cm→100m, 30cm→130m, 50cm→150m
    const maxDist = Math.min(150, 40 + sensor.depth * 3);
    // sensor snapped

    // 2. Compute snapOffset = along-road distance from road-start to snap point
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

    // 3. Dijkstra: compute along-road distance from sensor to every road endpoint
    //    Water flows outward from snap point, branching at every intersection
    const ep = new Map<string, number>(); // "ri:0"|"ri:1" → along-road dist
    ep.set(`${snapRi}:0`, snapOffset);
    ep.set(`${snapRi}:1`, Math.max(0, snapRoadLen - snapOffset));

    // Simple priority queue (small graph, sort is fine)
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

      // At this endpoint (intersection), water flows into ALL connected roads
      for (const c of adj[ri]) {
        if (c.myEnd !== ei) continue;

        const nri = c.nri;
        const nEnd = c.nEnd;
        const nOther: 0 | 1 = nEnd === 0 ? 1 : 0;
        const nLen = cumDist[nri][cumDist[nri].length - 1];

        // Water arrives at the connected endpoint of the neighbor road
        const nEndKey = `${nri}:${nEnd}`;
        if (d < (ep.get(nEndKey) ?? Infinity)) {
          ep.set(nEndKey, d);
          pushPQ(d, nri, nEnd); // process this endpoint to find more connections
        }

        // Water flows through the neighbor road to the other endpoint
        const throughDist = d + nLen;
        const nOtherKey = `${nri}:${nOther}`;
        if (throughDist <= maxDist && throughDist < (ep.get(nOtherKey) ?? Infinity)) {
          ep.set(nOtherKey, throughDist);
          pushPQ(throughDist, nri, nOther);
        }
      }
    }

    // 4. Render flood on each reachable road
    for (let ri = 0; ri < roads.length; ri++) {
      const ds = ep.get(`${ri}:0`); // along-road dist at road start
      const de = ep.get(`${ri}:1`); // along-road dist at road end
      if (ds === undefined && de === undefined) continue;

      const road = roads[ri];
      const totalLen = cumDist[ri][cumDist[ri].length - 1];

      for (let si = 0; si < road.length - 1; si++) {
        const cA = cumDist[ri][si];
        const cB = cumDist[ri][si + 1];

        // Along-road distance from sensor at each vertex of this segment
        let dA: number, dB: number;
        if (ri === snapRi) {
          // Snap road: distance = |snapOffset - vertexPosition|
          dA = Math.abs(snapOffset - cA);
          dB = Math.abs(snapOffset - cB);
        } else {
          // Other roads: min of path-via-start and path-via-end
          dA = Math.min(
            ds !== undefined ? ds + cA : Infinity,
            de !== undefined ? de + (totalLen - cA) : Infinity,
          );
          dB = Math.min(
            ds !== undefined ? ds + cB : Infinity,
            de !== undefined ? de + (totalLen - cB) : Infinity,
          );
        }

        // Skip segments fully outside coverage
        if (dA > maxDist && dB > maxDist) continue;

        // Clip at maxDist boundary
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

        // Keep the best (closest) result per segment across sensors
        const avgDist = (rdA + rdB) / 2;
        const key = `${ri}|${si}`;
        const ex = segBest.get(key);
        if (!ex || avgDist < (ex.distA + ex.distB) / 2) {
          segBest.set(key, { distA: rdA, distB: rdB, depth: sensor.depth, maxDist, a: rA, b: rB });
        }
      }
    }
  }

  // segBest computed

  // 5. Subdivide into ~5m pieces for smooth gradient rendering
  const features: GeoJSON.Feature[] = [];
  for (const [, e] of segBest) {
    const segLen = ptDist(e.a, e.b);
    const n = Math.max(1, Math.ceil(segLen / 5));
    for (let p = 0; p < n; p++) {
      const t0 = p / n, t1 = (p + 1) / n;
      const p0 = [e.a[0] + t0 * (e.b[0] - e.a[0]), e.a[1] + t0 * (e.b[1] - e.a[1])];
      const p1 = [e.a[0] + t1 * (e.b[0] - e.a[0]), e.a[1] + t1 * (e.b[1] - e.a[1])];
      const midDist = e.distA + ((t0 + t1) / 2) * (e.distB - e.distA);
      const intensity = Math.max(0.2, 1 - (midDist / e.maxDist) * 0.8);

      features.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: [p0, p1] },
        properties: { intensity, depth: e.depth },
      });
    }
  }

  // features computed
  return features;
}
