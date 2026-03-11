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
]);

/**
 * Query road geometry from Mapbox vector tiles ONCE and cache.
 * Called after fitBounds + idle so the viewport covers all sensors.
 */
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
  const pad = 0.002;
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
    for (const f of features) {
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
  } catch { /* tiles not ready */ }

  return roads;
}

/**
 * Calculate flood water on cached road geometry using elevation physics.
 * Water level = sensor_street_elevation + flood_depth.
 * Road segments below the water level get flooded; those above stay dry.
 * Elevation at each road point is estimated via IDW from ALL sensors.
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
      lat: d.lat, lng: d.lng,
      elev: (d.altitude_baro ?? 0) - (d.baseline_distance_cm ?? 0) / 100,
      depth: depths[d.device_id],
    }));
  if (floodingSensors.length === 0) return [];

  // All sensors for ground-elevation interpolation
  const allSensors = devices.map((d) => ({
    lat: d.lat, lng: d.lng,
    elev: (d.altitude_baro ?? 0) - (d.baseline_distance_cm ?? 0) / 100,
  }));

  const maxDepth = Math.max(1, ...floodingSensors.map((s) => s.depth));
  const SPREAD_RADIUS = 150; // meters
  const features: GeoJSON.Feature[] = [];

  for (const road of cachedRoads) {
    const cosLat = Math.cos(road.midLat * Math.PI / 180);

    // Find flooding sensors within spread radius, IDW depth
    let closestDist = Infinity;
    let closestSensor: (typeof floodingSensors)[0] | null = null;
    let wDepth = 0, wTotal = 0;

    for (const s of floodingSensors) {
      const dx = (s.lng - road.midLng) * 111320 * cosLat;
      const dy = (s.lat - road.midLat) * 111320;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > SPREAD_RADIUS) continue;
      if (dist < closestDist) { closestDist = dist; closestSensor = s; }
      const w = 1 / (Math.max(dist, 8) ** 2);
      wDepth += s.depth * w;
      wTotal += w;
    }
    if (!closestSensor || wTotal === 0) continue;

    // Estimate ground elevation at road midpoint via IDW from ALL sensors
    let wElev = 0, wElevTotal = 0;
    for (const s of allSensors) {
      const dx = (s.lng - road.midLng) * 111320 * cosLat;
      const dy = (s.lat - road.midLat) * 111320;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const w = 1 / (Math.max(dist, 5) ** 2);
      wElev += s.elev * w;
      wElevTotal += w;
    }
    const roadElev = wElev / wElevTotal;

    // Water level at the sensor = street elevation + flood depth (cm → m)
    const interpDepth = wDepth / wTotal;
    const waterLevel = closestSensor.elev + interpDepth / 100;

    // Road must be below the water level to be flooded
    if (roadElev > waterLevel) continue;

    // Water depth at this road point
    const waterDepthAtRoad = (waterLevel - roadElev) * 100; // cm
    const distFade = 1 - (closestDist / SPREAD_RADIUS) ** 0.6;
    const intensity = Math.min(1, (waterDepthAtRoad / (maxDepth * 1.2)) * distFade);
    if (intensity < 0.05) continue;

    features.push({
      type: "Feature",
      geometry: road.geometry,
      properties: { intensity },
    });
  }

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
      center: [-80.1205, 25.9670],
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

    const alertFeatures: GeoJSON.Feature[] = [];
    const dotFeatures: GeoJSON.Feature[] = [];

    devices.forEach((device) => {
      const color = STATUS_COLORS[device.status] ?? "#6b7280";
      const isHighlighted = device.device_id === highlightDeviceId;

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
        alertFeatures.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: [device.lng, device.lat] },
          properties: {},
        });
      }

      dotFeatures.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [device.lng, device.lat] },
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

    const alertSrc = map.getSource("device-alerts") as mapboxgl.GeoJSONSource | undefined;
    const dotSrc = map.getSource("device-dots") as mapboxgl.GeoJSONSource | undefined;

    if (alertSrc) alertSrc.setData({ type: "FeatureCollection", features: alertFeatures });
    if (dotSrc) dotSrc.setData({ type: "FeatureCollection", features: dotFeatures });

    // Update flood water using cached road geometry + elevation physics
    const updateFloodRoads = () => {
      if (cachedRoadsRef.current.length === 0) {
        cachedRoadsRef.current = queryRoadsNearDevices(map, devices);
      }
      const roads = calculateFloodWater(cachedRoadsRef.current, devices, floodDepths ?? {});
      const roadSrc = map.getSource("flood-roads") as mapboxgl.GeoJSONSource | undefined;
      if (roadSrc) roadSrc.setData({ type: "FeatureCollection", features: roads });
    };

    if (cachedRoadsRef.current.length > 0) {
      // Roads already cached — update immediately
      updateFloodRoads();
    } else {
      // First load — wait for tiles to render, then cache roads and calculate
      map.once("idle", updateFloodRoads);
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
