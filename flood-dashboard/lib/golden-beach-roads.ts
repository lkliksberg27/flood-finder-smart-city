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
 * Flood water strictly on actual road geometry.
 *
 * For each flooding sensor, walk along EVERY nearby road segment
 * independently. Never jump between segments. Water stays on
 * exactly the Mapbox tile geometry it came from.
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
  const MAX_WALK = 300;

  for (const sensor of flooding) {
    const sensorPt: number[] = [sensor.lng, sensor.lat];
    const H_water = sensor.elev + sensor.depth / 100;

    // Walk each nearby road INDEPENDENTLY — never cross between roads
    for (const road of roads) {
      // Find closest vertex on THIS specific road
      let closestIdx = -1;
      let closestDist = Infinity;
      for (let i = 0; i < road.length; i++) {
        const d = ptDist(sensorPt, road[i]);
        if (d < closestDist) {
          closestDist = d;
          closestIdx = i;
        }
      }

      // Skip roads more than 30m from sensor
      if (closestDist > 30) continue;

      // Walk forward along THIS road only
      const seg: number[][] = [road[closestIdx]];
      let fwdDist = 0;
      for (let i = closestIdx + 1; i < road.length && fwdDist < MAX_WALK; i++) {
        const stepDist = ptDist(road[i - 1], road[i]);
        fwdDist += stepDist;

        const H_ground = estimateElevation(
          road[i][0],
          road[i][1],
          elevSensors,
        );

        // Stop at flood boundary — but always include at least 40m
        if (H_ground > H_water && fwdDist > 40) {
          const prevH = estimateElevation(
            road[i - 1][0],
            road[i - 1][1],
            elevSensors,
          );
          const rise = H_ground - prevH;
          if (rise > 0.001) {
            const frac = Math.max(0, Math.min(1, (H_water - prevH) / rise));
            seg.push([
              road[i - 1][0] + (road[i][0] - road[i - 1][0]) * frac,
              road[i - 1][1] + (road[i][1] - road[i - 1][1]) * frac,
            ]);
          }
          break;
        }
        seg.push(road[i]);
      }

      // Walk backward along THIS road only
      let bwdDist = 0;
      for (let i = closestIdx - 1; i >= 0 && bwdDist < MAX_WALK; i--) {
        const stepDist = ptDist(road[i + 1], road[i]);
        bwdDist += stepDist;

        const H_ground = estimateElevation(
          road[i][0],
          road[i][1],
          elevSensors,
        );

        if (H_ground > H_water && bwdDist > 40) {
          const prevH = estimateElevation(
            road[i + 1][0],
            road[i + 1][1],
            elevSensors,
          );
          const rise = H_ground - prevH;
          if (rise > 0.001) {
            const frac = Math.max(0, Math.min(1, (H_water - prevH) / rise));
            seg.unshift([
              road[i + 1][0] + (road[i][0] - road[i + 1][0]) * frac,
              road[i + 1][1] + (road[i][1] - road[i + 1][1]) * frac,
            ]);
          }
          break;
        }
        seg.unshift(road[i]);
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
  }

  return features;
}
