/**
 * Flood visualization using actual Mapbox road geometry.
 *
 * Physics model: Water Surface Elevation (WSE) flood-fill.
 *   H_water = H_road + h  (ground elevation + measured depth)
 *   Flood spreads along road until: H_point > H_water
 *   i.e. terrain rises above the water surface → flood boundary.
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

/** Overall compass direction of a polyline (degrees) */
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
 * Build fallback road geometry from sensor positions.
 */
function buildFallbackRoads(devices: Device[]): number[][][] {
  const roads: number[][][] = [];
  if (devices.length === 0) return roads;

  const LNG_TOLERANCE = 0.0008;
  const columns: { lng: number; devices: Device[] }[] = [];

  for (const d of devices) {
    const col = columns.find((c) => Math.abs(c.lng - d.lng) < LNG_TOLERANCE);
    if (col) {
      col.devices.push(d);
    } else {
      columns.push({ lng: d.lng, devices: [d] });
    }
  }

  for (const col of columns) {
    const sorted = [...col.devices].sort((a, b) => a.lat - b.lat);
    if (sorted.length >= 2) {
      roads.push([
        [col.lng, sorted[0].lat - 0.001],
        ...sorted.map((d) => [d.lng, d.lat]),
        [col.lng, sorted[sorted.length - 1].lat + 0.001],
      ]);
    }
  }

  const LAT_TOLERANCE = 0.0004;
  if (columns.length >= 2) {
    for (let i = 0; i < columns.length; i++) {
      for (let j = i + 1; j < columns.length; j++) {
        for (const d1 of columns[i].devices) {
          for (const d2 of columns[j].devices) {
            if (Math.abs(d1.lat - d2.lat) < LAT_TOLERANCE) {
              const minLng = Math.min(d1.lng, d2.lng);
              const maxLng = Math.max(d1.lng, d2.lng);
              roads.push([
                [minLng - 0.0005, d1.lat],
                [d1.lng, d1.lat],
                [d2.lng, d2.lat],
                [maxLng + 0.0005, d2.lat],
              ]);
            }
          }
        }
      }
    }
  }

  // Isolated sensors get a short N-S stub
  for (const col of columns) {
    if (col.devices.length === 1) {
      const d = col.devices[0];
      roads.push([
        [d.lng, d.lat - 0.0006],
        [d.lng, d.lat],
        [d.lng, d.lat + 0.0006],
      ]);
    }
  }

  return roads;
}

/**
 * Query actual road geometry from Mapbox vector tiles.
 */
export function queryMapboxRoads(
  map: mapboxgl.Map,
  devices: Device[],
): number[][][] {
  const style = map.getStyle();
  if (!style?.layers) return buildFallbackRoads(devices);

  const roadLayerIds = style.layers
    .filter(
      (l) =>
        l.type === "line" &&
        (l as Record<string, unknown>)["source-layer"] === "road",
    )
    .map((l) => l.id);
  if (roadLayerIds.length === 0) return buildFallbackRoads(devices);

  const allCoords: number[][][] = [];
  const seen = new Set<string>();

  for (const device of devices) {
    const point = map.project([device.lng, device.lat]);
    const size = 250;
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

  const merged = mergeSegments(allCoords);
  return merged.length > 0 ? merged : buildFallbackRoads(devices);
}

/**
 * Estimate ground elevation at any point using IDW interpolation
 * from nearby sensors that have elevation data.
 */
function estimateElevation(
  lng: number,
  lat: number,
  elevSensors: { lng: number; lat: number; elev: number }[],
): number {
  let totalW = 0;
  let totalE = 0;
  const midLat = lat;
  for (const s of elevSensors) {
    const dx = (s.lng - lng) * 111320 * cosLat(midLat);
    const dy = (s.lat - lat) * 111320;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const w = 1 / Math.max(dist, 3); // IDW, min 3m to avoid division spikes
    totalW += w;
    totalE += w * s.elev;
  }
  return totalW > 0 ? totalE / totalW : 0;
}

/**
 * Blue flood water on roads from sensor readings.
 *
 * Uses the Water Surface Elevation (WSE) model:
 *   1. H_water = H_sensor + depth   (water surface elevation)
 *   2. Walk along road from sensor in both directions
 *   3. At each vertex, estimate ground elevation via IDW
 *   4. Flood continues while H_ground <= H_water
 *   5. Flood boundary = where terrain rises above water surface
 *
 * This naturally produces:
 *   - Low-lying sensors: lots of water but contained (terrain around is also low)
 *   - High sensors: water drains quickly (terrain drops away)
 *   - Deep floods: higher H_water overcomes more terrain → wider spread
 *   - Shallow floods: stopped by small rises → narrow spread
 *
 * Minimum 40m visible water guaranteed so flooding is always visible.
 * Maximum 300m walk to keep it realistic.
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
  if (flooding.length === 0) return [];

  // Build elevation lookup from all sensors with baro data
  const elevSensors = devices
    .filter((d) => d.altitude_baro != null)
    .map((d) => ({
      lng: d.lng,
      lat: d.lat,
      elev: (d.altitude_baro ?? 0) - (d.baseline_distance_cm ?? 0) / 100,
    }));

  const maxDepth = Math.max(1, ...flooding.map((f) => f.depth));
  const features: GeoJSON.Feature[] = [];

  const MIN_WALK = 40; // always show at least 40m of water
  const MAX_WALK = 300; // never exceed 300m

  for (const sensor of flooding) {
    const sensorPt: number[] = [sensor.lng, sensor.lat];

    // H_water = ground elevation at sensor + measured flood depth (in meters)
    const H_water = sensor.elev + sensor.depth / 100;

    // Find nearest road
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

    // If no road within 50m, create a small N-S segment through sensor
    if (!bestRoad || bestDist > 50) {
      const halfWalk = MIN_WALK / 111320;
      features.push({
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [sensor.lng, sensor.lat - halfWalk],
            [sensor.lng, sensor.lat],
            [sensor.lng, sensor.lat + halfWalk],
          ],
        },
        properties: {
          intensity: Math.min(1, sensor.depth / maxDepth),
          depth: sensor.depth,
        },
      });
      continue;
    }

    // --- Walk forward along road using WSE flood-fill ---
    const seg: number[][] = [bestRoad[bestIdx]];
    let fwdDist = 0;
    for (let i = bestIdx + 1; i < bestRoad.length && fwdDist < MAX_WALK; i++) {
      const stepDist = ptDist(bestRoad[i - 1], bestRoad[i]);
      fwdDist += stepDist;

      // Estimate ground elevation at this road vertex
      const H_ground = estimateElevation(
        bestRoad[i][0],
        bestRoad[i][1],
        elevSensors,
      );

      // Flood condition: H_ground <= H_water
      if (H_ground > H_water && fwdDist > MIN_WALK) {
        // Terrain rose above water surface — this is the flood boundary
        // Interpolate the exact boundary point
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
    // If road ended before MIN_WALK, extrapolate
    if (fwdDist < MIN_WALK && seg.length >= 2) {
      const a = seg[seg.length - 2];
      const b = seg[seg.length - 1];
      const d = ptDist(a, b);
      if (d > 0.5) {
        const ratio = (MIN_WALK - fwdDist) / d;
        seg.push([
          b[0] + (b[0] - a[0]) * ratio,
          b[1] + (b[1] - a[1]) * ratio,
        ]);
      }
    }

    // --- Walk backward along road using WSE flood-fill ---
    let bwdDist = 0;
    for (let i = bestIdx - 1; i >= 0 && bwdDist < MAX_WALK; i--) {
      const stepDist = ptDist(bestRoad[i + 1], bestRoad[i]);
      bwdDist += stepDist;

      const H_ground = estimateElevation(
        bestRoad[i][0],
        bestRoad[i][1],
        elevSensors,
      );

      if (H_ground > H_water && bwdDist > MIN_WALK) {
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
    // If road ended before MIN_WALK, extrapolate
    if (bwdDist < MIN_WALK && seg.length >= 2) {
      const a = seg[1];
      const b = seg[0];
      const d = ptDist(a, b);
      if (d > 0.5) {
        const ratio = (MIN_WALK - bwdDist) / d;
        seg.unshift([
          b[0] + (b[0] - a[0]) * ratio,
          b[1] + (b[1] - a[1]) * ratio,
        ]);
      }
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
