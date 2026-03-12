/**
 * Flood visualization using actual Mapbox road geometry ONLY.
 *
 * No synthetic/fallback roads. No extrapolation past road ends.
 * Water stays strictly on real road geometry from Mapbox vector tiles.
 *
 * Physics: H_water = H_sensor + depth.
 * Walk along actual road while H_ground <= H_water.
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

function lineDir(coords: number[][]): number {
  const lat = (coords[0][1] + coords[coords.length - 1][1]) / 2;
  const dx =
    (coords[coords.length - 1][0] - coords[0][0]) * 111320 * cosLat(lat);
  const dy = (coords[coords.length - 1][1] - coords[0][1]) * 111320;
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

function collinear(d1: number, d2: number): boolean {
  let diff = Math.abs(d1 - d2) % 360;
  if (diff > 180) diff = 360 - diff;
  return diff < 50 || diff > 130;
}

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
 * Query ONLY real road geometry from Mapbox vector tiles.
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
    const size = 300;
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

        // Dedup by rounded start+end coords
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

  return mergeSegments(allCoords);
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
 * Flood water strictly on actual road geometry.
 *
 * H_water = H_sensor + depth.
 * Walk along real road while H_ground <= H_water.
 * No fallbacks, no extrapolation, no synthetic lines.
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

  const MAX_WALK = 300;

  for (const sensor of flooding) {
    const sensorPt: number[] = [sensor.lng, sensor.lat];
    const H_water = sensor.elev + sensor.depth / 100;

    // Find nearest road vertex
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

    // Must be within 50m of an actual road — otherwise skip
    if (!bestRoad || bestDist > 50) continue;

    // Walk forward along actual road geometry
    const seg: number[][] = [bestRoad[bestIdx]];
    let fwdDist = 0;
    for (let i = bestIdx + 1; i < bestRoad.length && fwdDist < MAX_WALK; i++) {
      const stepDist = ptDist(bestRoad[i - 1], bestRoad[i]);
      fwdDist += stepDist;

      const H_ground = estimateElevation(
        bestRoad[i][0],
        bestRoad[i][1],
        elevSensors,
      );

      // Stop at flood boundary — but always include at least 40m
      if (H_ground > H_water && fwdDist > 40) {
        // Interpolate boundary point on this road segment
        const prevH = estimateElevation(
          bestRoad[i - 1][0],
          bestRoad[i - 1][1],
          elevSensors,
        );
        const rise = H_ground - prevH;
        if (rise > 0.001) {
          const frac = Math.max(0, Math.min(1, (H_water - prevH) / rise));
          seg.push([
            bestRoad[i - 1][0] +
              (bestRoad[i][0] - bestRoad[i - 1][0]) * frac,
            bestRoad[i - 1][1] +
              (bestRoad[i][1] - bestRoad[i - 1][1]) * frac,
          ]);
        }
        break;
      }
      seg.push(bestRoad[i]);
    }

    // Walk backward along actual road geometry
    let bwdDist = 0;
    for (let i = bestIdx - 1; i >= 0 && bwdDist < MAX_WALK; i--) {
      const stepDist = ptDist(bestRoad[i + 1], bestRoad[i]);
      bwdDist += stepDist;

      const H_ground = estimateElevation(
        bestRoad[i][0],
        bestRoad[i][1],
        elevSensors,
      );

      if (H_ground > H_water && bwdDist > 40) {
        const prevH = estimateElevation(
          bestRoad[i + 1][0],
          bestRoad[i + 1][1],
          elevSensors,
        );
        const rise = H_ground - prevH;
        if (rise > 0.001) {
          const frac = Math.max(0, Math.min(1, (H_water - prevH) / rise));
          seg.unshift([
            bestRoad[i + 1][0] +
              (bestRoad[i][0] - bestRoad[i + 1][0]) * frac,
            bestRoad[i + 1][1] +
              (bestRoad[i][1] - bestRoad[i + 1][1]) * frac,
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
