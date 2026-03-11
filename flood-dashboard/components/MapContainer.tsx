"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import type { Device } from "@/lib/types";
import { getReadings24h } from "@/lib/queries";
import { getSupabase } from "@/lib/supabase";

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN || "";

const STATUS_COLORS: Record<string, string> = {
  online: "#34d399",
  alert: "#f87171",
  offline: "#6b7280",
};

function buildSparklineSVG(values: number[], color = "#3b82f6", label = ""): string {
  if (values.length < 2) return "";
  const w = 200, h = 40;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const points = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - ((v - min) / range) * (h - 4) - 2;
    return `${x},${y}`;
  }).join(" ");

  const firstX = 0;
  const lastX = w;
  const fillPoints = `${firstX},${h} ${points} ${lastX},${h}`;

  return `
    <div style="margin-top:4px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px">
        <span style="font-size:10px;color:#9ca3af">${label}</span>
        <span style="font-size:10px;color:#6b7280">${Math.round(min)}-${Math.round(max)}</span>
      </div>
      <svg width="${w}" height="${h}" style="display:block;width:100%">
        <polygon points="${fillPoints}" fill="${color}" opacity="0.1"/>
        <polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </div>`;
}

type CachedRoad = { midLat: number; midLng: number; geometry: GeoJSON.Geometry };

const STREET_CLASSES = new Set([
  "motorway", "motorway_link", "trunk", "trunk_link",
  "primary", "primary_link", "secondary", "secondary_link",
  "tertiary", "tertiary_link", "street", "street_limited",
  "service", "pedestrian", "track",
]);

/** Merge road features that share endpoints into longer polylines. */
function mergeRoadSegments(roads: CachedRoad[]): CachedRoad[] {
  const cosLat = Math.cos(25.966 * Math.PI / 180);
  const MERGE_THRESHOLD = 15; // meters

  const segments: number[][][] = [];
  for (const r of roads) {
    const coords =
      r.geometry.type === "LineString" ? (r.geometry as GeoJSON.LineString).coordinates :
      r.geometry.type === "MultiLineString" ? (r.geometry as GeoJSON.MultiLineString).coordinates[0] : null;
    if (coords && coords.length >= 2) segments.push(coords);
  }

  const ptDist = (a: number[], b: number[]): number => {
    const dx = (a[0] - b[0]) * 111320 * cosLat;
    const dy = (a[1] - b[1]) * 111320;
    return Math.sqrt(dx * dx + dy * dy);
  };

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
        const chainEnd = chain[chain.length - 1];
        const chainStart = chain[0];

        if (ptDist(chainEnd, seg[0]) < MERGE_THRESHOLD) {
          chain = chain.concat(seg.slice(1));
          used.add(j); changed = true;
        } else if (ptDist(chainEnd, seg[seg.length - 1]) < MERGE_THRESHOLD) {
          chain = chain.concat([...seg].reverse().slice(1));
          used.add(j); changed = true;
        } else if (ptDist(chainStart, seg[seg.length - 1]) < MERGE_THRESHOLD) {
          chain = seg.concat(chain.slice(1));
          used.add(j); changed = true;
        } else if (ptDist(chainStart, seg[0]) < MERGE_THRESHOLD) {
          chain = [...seg].reverse().concat(chain.slice(1));
          used.add(j); changed = true;
        }
      }
    }

    merged.push(chain);
  }

  return merged.map((coords) => {
    const mid = Math.floor(coords.length / 2);
    return {
      midLat: coords[mid][1],
      midLng: coords[mid][0],
      geometry: { type: "LineString" as const, coordinates: coords } as GeoJSON.Geometry,
    };
  });
}

/** Query road geometry from Mapbox vector tiles ONCE, merge tile fragments, and cache. */
function queryRoadsNearDevices(map: mapboxgl.Map, devices: Device[]): CachedRoad[] {
  const style = map.getStyle();
  if (!style?.layers) return [];
  const roadLayerIds = style.layers
    .filter((l) => l.type === "line" && (l as Record<string, unknown>)["source-layer"] === "road")
    .map((l) => l.id);
  if (roadLayerIds.length === 0) return [];

  let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
  for (const d of devices) {
    minLat = Math.min(minLat, d.lat);
    maxLat = Math.max(maxLat, d.lat);
    minLng = Math.min(minLng, d.lng);
    maxLng = Math.max(maxLng, d.lng);
  }
  const pad = 0.003;
  const sw = map.project([minLng - pad, minLat - pad]);
  const ne = map.project([maxLng + pad, maxLat + pad]);
  const bbox: [mapboxgl.PointLike, mapboxgl.PointLike] = [
    [Math.min(sw.x, ne.x), Math.min(sw.y, ne.y)],
    [Math.max(sw.x, ne.x), Math.max(sw.y, ne.y)],
  ];

  const roads: CachedRoad[] = [];
  const seen = new Set<string>();

  try {
    const features = map.queryRenderedFeatures(bbox, { layers: roadLayerIds });
    const classCounts: Record<string, number> = {};
    for (const f of features) {
      const cls = (f.properties?.class ?? "unknown") as string;
      classCounts[cls] = (classCounts[cls] ?? 0) + 1;
      if (f.geometry.type !== "LineString" && f.geometry.type !== "MultiLineString") continue;
      const cls = (f.properties?.class ?? "") as string;
      if (!STREET_CLASSES.has(cls)) continue;
      const key = JSON.stringify(f.geometry).slice(0, 120);
      if (seen.has(key)) continue;
      seen.add(key);
      const coords = f.geometry.type === "LineString" ? f.geometry.coordinates : f.geometry.coordinates[0];
      if (!coords || coords.length === 0) continue;
      const mid = Math.floor(coords.length / 2);
      roads.push({ midLat: coords[mid][1], midLng: coords[mid][0], geometry: f.geometry });
    }
    console.log(`[ROADS] classes found:`, classCounts, `features: ${features.length}, kept: ${roads.length}`);
  } catch { /* tiles not ready */ }

  // Merge tile fragments into longer polylines (e.g. all of Ocean Blvd)
  const merged = mergeRoadSegments(roads);
  console.log(`[ROADS] merged ${roads.length} segments → ${merged.length} polylines`);
  return merged;
}

/** Minimum distance (meters) from a point to any vertex of a LineString. */
function pointToLineDist(
  p: { lat: number; lng: number },
  geom: GeoJSON.Geometry,
  cosLat: number,
): number {
  const coords =
    geom.type === "LineString" ? geom.coordinates :
    geom.type === "MultiLineString" ? geom.coordinates[0] : null;
  if (!coords) return Infinity;
  let best = Infinity;
  for (const c of coords) {
    const dx = (c[0] - p.lng) * 111320 * cosLat;
    const dy = (c[1] - p.lat) * 111320;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < best) best = d;
  }
  return best;
}

/** Snap a point to the nearest vertex on any cached road. */
function snapToRoad(
  p: { lat: number; lng: number },
  roads: CachedRoad[],
  cosLat: number,
  maxDist = 60,
): [number, number] | null {
  let best: [number, number] | null = null;
  let bestDist = Infinity;
  for (const road of roads) {
    const coords =
      road.geometry.type === "LineString" ? road.geometry.coordinates :
      road.geometry.type === "MultiLineString" ? road.geometry.coordinates[0] : null;
    if (!coords) continue;
    for (const c of coords) {
      const dx = (c[0] - p.lng) * 111320 * cosLat;
      const dy = (c[1] - p.lat) * 111320;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < bestDist) { bestDist = dist; best = [c[0], c[1]]; }
    }
  }
  return bestDist <= maxDist ? best : null;
}

/** Estimate ground elevation at a point using IDW from all sensors. */
function idwElevation(
  lat: number, lng: number,
  sensors: Array<{ lat: number; lng: number; elev: number }>,
  cosLat: number,
): number {
  let wElev = 0, wTotal = 0;
  for (const s of sensors) {
    const dx = (s.lng - lng) * 111320 * cosLat;
    const dy = (s.lat - lat) * 111320;
    const w = 1 / (Math.max(Math.sqrt(dx * dx + dy * dy), 5) ** 2);
    wElev += s.elev * w;
    wTotal += w;
  }
  return wTotal > 0 ? wElev / wTotal : 0;
}

/**
 * For each flooding sensor: find nearest road, walk along it
 * in both directions. Water extends further downhill (elevation-based).
 * Returns localized flood line segments on actual road geometry.
 */
function calculateFloodWater(
  cachedRoads: CachedRoad[],
  devices: Device[],
  depths: Record<string, number>,
): GeoJSON.Feature[] {
  if (cachedRoads.length === 0) return [];

  const floodingSensors = devices
    .filter((d) => (depths[d.device_id] ?? 0) > 0)
    .map((d) => ({
      id: d.device_id,
      lat: d.lat, lng: d.lng,
      elev: (d.altitude_baro ?? 0) - (d.baseline_distance_cm ?? 0) / 100,
      depth: depths[d.device_id],
    }));
  if (floodingSensors.length === 0) return [];
  console.log(`[FLOOD] ${floodingSensors.length} flooding sensors, ${cachedRoads.length} merged roads`);

  const allSensors = devices.map((d) => ({
    lat: d.lat, lng: d.lng,
    elev: (d.altitude_baro ?? 0) - (d.baseline_distance_cm ?? 0) / 100,
  }));

  const maxDepth = Math.max(1, ...floodingSensors.map((s) => s.depth));
  const features: GeoJSON.Feature[] = [];

  for (const sensor of floodingSensors) {
    const cosLat = Math.cos(sensor.lat * Math.PI / 180);

    // Find nearest road (within 60m)
    let bestRoad: CachedRoad | null = null;
    let bestDist = Infinity;
    for (const road of cachedRoads) {
      const dist = pointToLineDist(sensor, road.geometry, cosLat);
      if (dist < bestDist) { bestDist = dist; bestRoad = road; }
    }
    if (!bestRoad || bestDist > 80) {
      console.log(`[FLOOD] ${sensor.id}: no road within 80m (best=${bestDist.toFixed(0)}m)`);
      continue;
    }

    const coords =
      bestRoad.geometry.type === "LineString" ? (bestRoad.geometry as GeoJSON.LineString).coordinates :
      bestRoad.geometry.type === "MultiLineString" ? (bestRoad.geometry as GeoJSON.MultiLineString).coordinates[0] : null;
    if (!coords || coords.length < 2) {
      console.log(`[FLOOD] ${sensor.id}: road has <2 coords`);
      continue;
    }

    // Find nearest vertex on road
    let nearIdx = 0, nearDist = Infinity;
    for (let i = 0; i < coords.length; i++) {
      const dx = (coords[i][0] - sensor.lng) * 111320 * cosLat;
      const dy = (coords[i][1] - sensor.lat) * 111320;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < nearDist) { nearDist = d; nearIdx = i; }
    }

    // Walk distance: 40m base + 3m per cm of depth (max 200m)
    const baseWalk = Math.min(40 + sensor.depth * 3, 200);

    // Walk forward along road
    const segment: number[][] = [coords[nearIdx]];
    let dist = 0;
    for (let i = nearIdx + 1; i < coords.length; i++) {
      const dx = (coords[i][0] - coords[i - 1][0]) * 111320 * cosLat;
      const dy = (coords[i][1] - coords[i - 1][1]) * 111320;
      dist += Math.sqrt(dx * dx + dy * dy);
      const ptElev = idwElevation(coords[i][1], coords[i][0], allSensors, cosLat);
      const maxDist = ptElev < sensor.elev ? baseWalk * 1.5 : baseWalk;
      if (dist > maxDist) break;
      segment.push(coords[i]);
    }

    // Walk backward along road
    dist = 0;
    for (let i = nearIdx - 1; i >= 0; i--) {
      const dx = (coords[i][0] - coords[i + 1][0]) * 111320 * cosLat;
      const dy = (coords[i][1] - coords[i + 1][1]) * 111320;
      dist += Math.sqrt(dx * dx + dy * dy);
      const ptElev = idwElevation(coords[i][1], coords[i][0], allSensors, cosLat);
      const maxDist = ptElev < sensor.elev ? baseWalk * 1.5 : baseWalk;
      if (dist > maxDist) break;
      segment.unshift(coords[i]);
    }

    console.log(`[FLOOD] ${sensor.id}: dist=${bestDist.toFixed(0)}m, roadCoords=${coords.length}, nearIdx=${nearIdx}, segment=${segment.length}, walk=${baseWalk.toFixed(0)}m`);
    if (segment.length < 2) continue;

    const intensity = Math.min(1, sensor.depth / maxDepth);
    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: segment },
      properties: { intensity, depth: sensor.depth },
    });
  }

  console.log(`[FLOOD] Generated ${features.length}/${floodingSensors.length} flood lines`);
  return features;
}

interface Props {
  devices: Device[];
  onDeviceClick?: (device: Device) => void;
  highlightDeviceId?: string | null;
  height?: string;
  searchLocation?: { lng: number; lat: number } | null;
  floodDepths?: Record<string, number>;
  floodCounts?: Record<string, number>;
}

export function DeviceMap({ devices, onDeviceClick, highlightDeviceId, height = "100%", searchLocation, floodDepths, floodCounts }: Props) {
  const [mapReady, setMapReady] = useState(false);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const popupRef = useRef<mapboxgl.Popup | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const searchMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const devicesRef = useRef<Device[]>(devices);
  const onDeviceClickRef = useRef(onDeviceClick);

  const floodDepthsRef = useRef<Record<string, number>>({});
  const cachedRoadsRef = useRef<CachedRoad[]>([]);
  devicesRef.current = devices;
  onDeviceClickRef.current = onDeviceClick;
  floodDepthsRef.current = floodDepths ?? {};

  const loadPopupData = useCallback(async (deviceId: string) => {
    try {
      const [readings, floodRes] = await Promise.all([
        getReadings24h(deviceId),
        getSupabase()
          .from("flood_events")
          .select("started_at, peak_depth_cm, duration_minutes, rainfall_mm, tide_level_m")
          .eq("device_id", deviceId)
          .order("started_at", { ascending: false })
          .limit(5),
      ]);

      const container = document.querySelector(`[data-popup-data="${deviceId}"]`);
      if (!container) return;

      let html = "";

      if (readings.length >= 2) {
        const distances = readings.map((r) => r.distance_cm ?? 0);
        html += buildSparklineSVG(distances, "#3b82f6", "24h Distance (cm)");

        const floodDepths = readings.map((r) => r.flood_depth_cm ?? 0);
        if (floodDepths.some((d) => d > 0)) {
          html += buildSparklineSVG(floodDepths, "#f87171", "24h Flood Depth (cm)");
        }
      }

      const events = floodRes.data ?? [];
      if (events.length > 0) {
        html += `<div style="margin-top:8px;border-top:1px solid #1f2937;padding-top:6px">`;
        html += `<span style="font-size:10px;color:#9ca3af">Recent Floods (${events.length})</span>`;
        events.slice(0, 3).forEach((e) => {
          const date = new Date(e.started_at).toLocaleDateString();
          const compound = (e.rainfall_mm ?? 0) > 0 && (e.tide_level_m ?? 0) > 0.3;
          html += `<div style="font-size:11px;margin-top:3px;display:flex;justify-content:space-between">
            <span style="color:#d1d5db">${date}</span>
            <span>
              <span style="color:#f87171;font-weight:600">${e.peak_depth_cm}cm</span>
              ${e.duration_minutes ? `<span style="color:#6b7280;margin-left:4px">${e.duration_minutes}min</span>` : ""}
              ${compound ? `<span style="color:#f87171;margin-left:4px;font-size:9px;background:rgba(248,113,113,0.15);padding:1px 4px;border-radius:3px">COMPOUND</span>` : ""}
            </span>
          </div>`;
        });
        html += `</div>`;
      } else {
        html += `<div style="margin-top:6px;font-size:10px;color:#6b7280">No floods in recent history</div>`;
      }

      container.innerHTML = html;
    } catch {
      // popup data is optional
    }
  }, []);

  // Initialize map once
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    mapboxgl.accessToken = MAPBOX_TOKEN;

    mapRef.current = new mapboxgl.Map({
      container: containerRef.current,
      style: "mapbox://styles/mapbox/dark-v11",
      center: [-80.1196, 25.9660],
      zoom: 15,
      attributionControl: false,
      pitchWithRotate: false,
      dragRotate: false,
    });

    const map = mapRef.current;

    map.on("load", () => {
      // Add empty GeoJSON sources for devices
      map.addSource("device-alerts", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addSource("device-dots", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });

      // ── Flood water on streets (no circles — road geometry only) ──
      map.addSource("flood-roads", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });

      // Solid flood water on streets — width scales with depth intensity
      map.addLayer({
        id: "flood-road-water",
        type: "line",
        source: "flood-roads",
        paint: {
          "line-color": [
            "interpolate", ["linear"], ["get", "intensity"],
            0.1, "#1976d2",
            0.4, "#2196f3",
            0.7, "#42a5f5",
            1, "#64b5f6",
          ],
          "line-width": [
            "interpolate", ["linear"], ["zoom"],
            12, ["interpolate", ["linear"], ["get", "intensity"], 0.1, 1.5, 0.5, 3, 1, 5],
            14, ["interpolate", ["linear"], ["get", "intensity"], 0.1, 3, 0.5, 6, 1, 10],
            16, ["interpolate", ["linear"], ["get", "intensity"], 0.1, 4, 0.5, 8, 1, 14],
            18, ["interpolate", ["linear"], ["get", "intensity"], 0.1, 6, 0.5, 12, 1, 20],
          ],
          "line-opacity": [
            "interpolate", ["linear"], ["get", "intensity"],
            0.08, 0.45,
            0.3, 0.6,
            0.6, 0.75,
            1, 0.85,
          ],
          "line-blur": 0,
        },
        layout: { "line-cap": "round", "line-join": "round" },
      });

      // Alert rings (larger semi-transparent circles for alerting sensors)
      map.addLayer({
        id: "device-alert-rings",
        type: "circle",
        source: "device-alerts",
        paint: {
          "circle-radius": 22,
          "circle-color": "#f87171",
          "circle-opacity": 0.15,
        },
      });

      // Device dots
      map.addLayer({
        id: "device-dots-layer",
        type: "circle",
        source: "device-dots",
        paint: {
          "circle-radius": ["case",
            ["==", ["get", "highlighted"], true], 12,
            ["==", ["get", "status"], "alert"], 10,
            7
          ],
          "circle-color": ["get", "color"],
          "circle-stroke-width": ["case",
            ["==", ["get", "highlighted"], true], 3,
            1
          ],
          "circle-stroke-color": ["case",
            ["==", ["get", "highlighted"], true], "#ffffff",
            ["get", "color"]
          ],
          "circle-opacity": 0.85,
        },
      });

      // Click handler for device dots
      map.on("click", "device-dots-layer", (e) => {
        if (!e.features?.[0]) return;
        const props = e.features[0].properties;
        if (!props) return;
        const deviceId = props.device_id;
        const device = devicesRef.current.find((d) => d.device_id === deviceId);
        if (device) onDeviceClickRef.current?.(device);

        const color = props.color;
        const lastSeenText = props.last_seen_text;
        const battV = props.battery_v ?? 0;
        const battPct = Math.max(0, Math.min(100, ((battV - 2.8) / 1.4) * 100));
        const battColor = battPct > 60 ? "#34d399" : battPct > 25 ? "#fbbf24" : "#f87171";

        // Street elevation = sensor altitude - distance to ground
        const altBaro = parseFloat(props.altitude_baro) || 0;
        const baselineCm = parseFloat(props.baseline_distance_cm) || 0;
        const streetElev = altBaro > 0
          ? (baselineCm > 0 ? (altBaro - baselineCm / 100).toFixed(2) : altBaro.toFixed(2))
          : "—";

        const popupHTML = `
          <div style="font-family:'DM Sans',sans-serif;min-width:220px">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <strong style="font-size:14px">${props.device_id}</strong>
              <span style="font-size:10px;color:${color};background:${color}22;padding:1px 6px;border-radius:4px;font-weight:600">${(props.status || "").toUpperCase()}</span>
            </div>
            ${props.name ? `<div style="color:#9ca3af;font-size:12px;margin-top:2px">${props.name}</div>` : ""}
            <hr style="border-color:#1f2937;margin:8px 0"/>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:11px">
              <div>
                <span style="color:#6b7280">Street Elev.</span><br/>
                <span style="font-weight:600">${streetElev}m</span>
              </div>
              <div>
                <span style="color:#6b7280">Last Seen</span><br/>
                <span style="font-weight:600">${lastSeenText}</span>
              </div>
              <div>
                <span style="color:#6b7280">Battery</span><br/>
                <div style="display:flex;align-items:center;gap:4px;margin-top:2px">
                  <div style="flex:1;height:4px;background:#1f2937;border-radius:2px;overflow:hidden">
                    <div style="width:${battPct}%;height:100%;background:${battColor};border-radius:2px"></div>
                  </div>
                  <span style="font-size:10px;font-weight:600">${Number(battV).toFixed(1)}V</span>
                </div>
              </div>
              ${props.neighborhood ? `<div>
                <span style="color:#6b7280">Area</span><br/>
                <span style="font-weight:600">${props.neighborhood}</span>
              </div>` : ""}
            </div>
            <div data-popup-data="${props.device_id}" style="margin-top:4px">
              <div style="font-size:10px;color:#6b7280;margin-top:6px;display:flex;align-items:center;gap:4px">
                <div style="width:12px;height:12px;border:2px solid #3b82f6;border-top-color:transparent;border-radius:50%;animation:spin 1s linear infinite"></div>
                Loading data...
              </div>
            </div>
          </div>
          <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
        `;

        if (popupRef.current) popupRef.current.remove();
        const coords = (e.features[0].geometry as GeoJSON.Point).coordinates.slice() as [number, number];
        popupRef.current = new mapboxgl.Popup({ closeButton: false, offset: 12 })
          .setLngLat(coords)
          .setHTML(popupHTML)
          .addTo(map);

        loadPopupData(deviceId);
      });

      // Cursor pointer on hover
      map.on("mouseenter", "device-dots-layer", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "device-dots-layer", () => {
        map.getCanvas().style.cursor = "";
      });

      // Signal that map is ready for data
      setMapReady(true);
    });

    return () => {
      mapRef.current?.remove();
      mapRef.current = null;
      setMapReady(false);
    };
  }, [loadPopupData]);

  // Update sources when devices change or map becomes ready
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const cosLat = Math.cos(25.966 * Math.PI / 180);

    const buildDotFeatures = (snap: boolean) => {
      const alerts: GeoJSON.Feature[] = [];
      const dots: GeoJSON.Feature[] = [];

      devices.forEach((device) => {
        const color = STATUS_COLORS[device.status] ?? "#6b7280";
        const isHighlighted = device.device_id === highlightDeviceId;

        // Snap to nearest road for display if roads are cached
        const snapped = snap ? snapToRoad(device, cachedRoadsRef.current, cosLat) : null;
        const dLng = snapped ? snapped[0] : device.lng;
        const dLat = snapped ? snapped[1] : device.lat;

        const lastSeenText = device.last_seen
          ? (() => {
              const ms = Date.now() - new Date(device.last_seen).getTime();
              if (ms < 60000) return "just now";
              if (ms < 3600000) return `${Math.round(ms / 60000)}m ago`;
              if (ms < 86400000) return `${Math.round(ms / 3600000)}h ago`;
              return `${Math.round(ms / 86400000)}d ago`;
            })()
          : "never";

        if (device.status === "alert") {
          alerts.push({
            type: "Feature",
            geometry: { type: "Point", coordinates: [dLng, dLat] },
            properties: {},
          });
        }

        dots.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: [dLng, dLat] },
          properties: {
            device_id: device.device_id,
            name: device.name ?? "",
            status: device.status,
            color,
            highlighted: isHighlighted,
            altitude_baro: device.altitude_baro ?? 0,
            baseline_distance_cm: device.baseline_distance_cm ?? 0,
            battery_v: device.battery_v ?? 0,
            neighborhood: device.neighborhood ?? "",
            last_seen_text: lastSeenText,
          },
        });
      });

      return { alerts, dots };
    };

    const alertSrc = map.getSource("device-alerts") as mapboxgl.GeoJSONSource | undefined;
    const dotSrc = map.getSource("device-dots") as mapboxgl.GeoJSONSource | undefined;

    const updateAll = () => {
      if (cachedRoadsRef.current.length === 0) {
        cachedRoadsRef.current = queryRoadsNearDevices(map, devices);
      }

      // Snap dots to roads and update
      const { alerts, dots } = buildDotFeatures(true);
      if (alertSrc) alertSrc.setData({ type: "FeatureCollection", features: alerts });
      if (dotSrc) dotSrc.setData({ type: "FeatureCollection", features: dots });

      // Calculate flood water
      const roads = calculateFloodWater(cachedRoadsRef.current, devices, floodDepths ?? {});
      const roadSrc = map.getSource("flood-roads") as mapboxgl.GeoJSONSource | undefined;
      if (roadSrc) roadSrc.setData({ type: "FeatureCollection", features: roads });
    };

    if (cachedRoadsRef.current.length > 0) {
      updateAll();
    } else {
      // Show dots at original positions immediately
      const { alerts, dots } = buildDotFeatures(false);
      if (alertSrc) alertSrc.setData({ type: "FeatureCollection", features: alerts });
      if (dotSrc) dotSrc.setData({ type: "FeatureCollection", features: dots });
      // Then snap + flood on idle
      map.once("idle", updateAll);
    }

    // Fit bounds if we have devices
    if (devices.length > 0 && map.getZoom() === 14) {
      const bounds = new mapboxgl.LngLatBounds();
      devices.forEach((d) => bounds.extend([d.lng, d.lat]));
      map.fitBounds(bounds, { padding: 60, maxZoom: 15 });
    }
  }, [devices, highlightDeviceId, floodDepths, floodCounts, mapReady]);

  // Search location marker
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (searchMarkerRef.current) {
      searchMarkerRef.current.remove();
      searchMarkerRef.current = null;
    }

    if (searchLocation) {
      const el = document.createElement("div");
      el.innerHTML = `
        <div style="position:relative;width:32px;height:42px;cursor:pointer">
          <svg viewBox="0 0 32 42" width="32" height="42">
            <path d="M16 0C7.16 0 0 7.16 0 16c0 12 16 26 16 26s16-14 16-26C32 7.16 24.84 0 16 0z" fill="#3b82f6"/>
            <circle cx="16" cy="16" r="6" fill="white"/>
          </svg>
          <div style="position:absolute;top:8px;left:50%;width:48px;height:48px;margin-left:-24px;border-radius:50%;background:rgba(59,130,246,0.2);animation:searchPulse 2s ease-out infinite;pointer-events:none"></div>
        </div>`;

      searchMarkerRef.current = new mapboxgl.Marker({
        element: el,
        anchor: "bottom",
      })
        .setLngLat([searchLocation.lng, searchLocation.lat])
        .addTo(map);

      map.flyTo({
        center: [searchLocation.lng, searchLocation.lat],
        zoom: 13,
        duration: 1500,
      });
    } else if (devicesRef.current.length > 0) {
      // Fly back to sensor network bounds when search is cleared
      const bounds = new mapboxgl.LngLatBounds();
      devicesRef.current.forEach((d) => bounds.extend([d.lng, d.lat]));
      map.fitBounds(bounds, { padding: 60, maxZoom: 15, duration: 1200 });
    }
  }, [searchLocation]);

  return (
    <div style={{ position: "relative", height, width: "100%" }}>
      <div ref={containerRef} style={{ height: "100%", width: "100%", borderRadius: "8px" }} />
      {/* Map legend */}
      <div style={{
        position: "absolute",
        bottom: 12,
        left: 12,
        background: "rgba(17,24,39,0.9)",
        borderRadius: 8,
        padding: "8px 12px",
        fontSize: 11,
        color: "#9ca3af",
        zIndex: 1000,
        backdropFilter: "blur(4px)",
        border: "1px solid #1f2937",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
          <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#34d399", display: "inline-block" }} />
          <span>Online</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
          <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#f87171", display: "inline-block" }} />
          <span>Flood Alert</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
          <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#6b7280", display: "inline-block" }} />
          <span>Offline</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 10, height: 4, borderRadius: 2, background: "rgba(66,165,245,0.6)", display: "inline-block" }} />
          <span>Flooded Streets</span>
        </div>
      </div>
    </div>
  );
}
