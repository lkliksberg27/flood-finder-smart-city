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

/**
 * Smart flood water simulation on streets.
 * Uses elevation interpolation (IDW) to estimate water depth on each road segment.
 * Water fills lowest streets first and rises with flood severity.
 */
function calculateFloodWater(
  map: mapboxgl.Map,
  devices: Device[],
  depths: Record<string, number>,
  counts: Record<string, number>,
): GeoJSON.Feature[] {
  // Pre-compute sensor elevation and flood severity
  const sensors = devices.map((d) => {
    const streetElev = (d.altitude_baro ?? 0) - (d.baseline_distance_cm ?? 0) / 100;
    const activeDepth = depths[d.device_id] ?? 0;
    const count = counts[d.device_id] ?? 0;
    return {
      lat: d.lat, lng: d.lng,
      elev: streetElev,
      score: activeDepth * 2 + count * 3, // flood severity score
    };
  });

  // No flood data → no water
  if (sensors.every((s) => s.score === 0)) return [];

  const maxScore = Math.max(1, ...sensors.map((s) => s.score));
  const minElev = Math.min(...sensors.map((s) => s.elev));
  const maxElev = Math.max(...sensors.map((s) => s.elev));
  const elevRange = maxElev - minElev || 1;

  // Water line: the elevation threshold below which streets flood.
  // Rises with overall flood severity across the network.
  const avgSeverity = sensors.reduce((s, d) => s + d.score / maxScore, 0) / sensors.length;
  const waterLine = minElev + (0.15 + avgSeverity * 0.5) * elevRange;

  // Get road line layer IDs from the mapbox style
  const style = map.getStyle();
  if (!style?.layers) return [];
  const roadLayerIds = style.layers
    .filter((l) => l.type === "line" && (l as Record<string, unknown>)["source-layer"] === "road")
    .map((l) => l.id);
  if (roadLayerIds.length === 0) return [];

  // Query ALL roads within the sensor cluster bounding box (+padding)
  let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
  for (const s of sensors) {
    if (s.lat < minLat) minLat = s.lat;
    if (s.lat > maxLat) maxLat = s.lat;
    if (s.lng < minLng) minLng = s.lng;
    if (s.lng > maxLng) maxLng = s.lng;
  }
  const pad = 0.004; // ~400m padding
  const sw = map.project([minLng - pad, minLat - pad]);
  const ne = map.project([maxLng + pad, maxLat + pad]);
  const bbox: [mapboxgl.PointLike, mapboxgl.PointLike] = [
    [Math.min(sw.x, ne.x), Math.min(sw.y, ne.y)],
    [Math.max(sw.x, ne.x), Math.max(sw.y, ne.y)],
  ];

  const features: GeoJSON.Feature[] = [];
  const seen = new Set<string>();

  try {
    const roadFeatures = map.queryRenderedFeatures(bbox, { layers: roadLayerIds });

    for (const f of roadFeatures) {
      if (f.geometry.type !== "LineString" && f.geometry.type !== "MultiLineString") continue;
      const key = `${f.id ?? ""}_${JSON.stringify(f.geometry).slice(0, 100)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Get road segment center for elevation interpolation
      const coords = f.geometry.type === "LineString"
        ? f.geometry.coordinates
        : f.geometry.coordinates[0];
      if (!coords || coords.length === 0) continue;
      const mid = Math.floor(coords.length / 2);
      const cLng = coords[mid][0];
      const cLat = coords[mid][1];

      // IDW interpolation of elevation and flood score from nearest sensors
      let wElev = 0, wScore = 0, wTotal = 0;
      const cosLat = Math.cos(cLat * Math.PI / 180);
      for (const s of sensors) {
        const dx = (s.lng - cLng) * 111320 * cosLat;
        const dy = (s.lat - cLat) * 111320;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const w = 1 / (Math.max(dist, 5) ** 2);
        wElev += s.elev * w;
        wScore += (s.score / maxScore) * w;
        wTotal += w;
      }
      if (wTotal === 0) continue;

      const roadElev = wElev / wTotal;
      const floodScore = wScore / wTotal;
      const waterDepth = waterLine - roadElev;

      // Only show water on streets below the water line with nearby flood activity
      if (waterDepth <= 0 || floodScore < 0.02) continue;

      const depthFactor = Math.min(1, waterDepth / 0.5);
      const intensity = Math.min(1, depthFactor * 0.55 + floodScore * 0.45);
      if (intensity < 0.05) continue;

      features.push({
        type: "Feature",
        geometry: f.geometry,
        properties: { intensity, depth: waterDepth },
      });
    }
  } catch {
    // queryRenderedFeatures can fail during style transitions
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
  const floodCountsRef = useRef<Record<string, number>>({});

  devicesRef.current = devices;
  onDeviceClickRef.current = onDeviceClick;
  floodDepthsRef.current = floodDepths ?? {};
  floodCountsRef.current = floodCounts ?? {};

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
      center: [-80.1392, 25.9565],
      zoom: 14,
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

      // Outer water glow on streets
      map.addLayer({
        id: "flood-road-water",
        type: "line",
        source: "flood-roads",
        paint: {
          "line-color": [
            "interpolate", ["linear"], ["get", "intensity"],
            0.1, "#1565c0",
            0.5, "#1976d2",
            1, "#1e88e5",
          ],
          "line-width": [
            "interpolate", ["linear"], ["zoom"],
            12, 6, 14, 16, 16, 32, 18, 56,
          ],
          "line-opacity": [
            "interpolate", ["linear"], ["get", "intensity"],
            0.05, 0.15,
            0.3, 0.35,
            0.7, 0.5,
            1, 0.65,
          ],
          "line-blur": [
            "interpolate", ["linear"], ["zoom"],
            12, 3, 14, 5, 16, 8, 18, 14,
          ],
        },
        layout: { "line-cap": "round", "line-join": "round" },
      });

      // Brighter center stream on streets
      map.addLayer({
        id: "flood-road-water-bright",
        type: "line",
        source: "flood-roads",
        paint: {
          "line-color": [
            "interpolate", ["linear"], ["get", "intensity"],
            0.1, "#42a5f5",
            0.5, "#64b5f6",
            1, "#90caf9",
          ],
          "line-width": [
            "interpolate", ["linear"], ["zoom"],
            12, 2, 14, 7, 16, 16, 18, 30,
          ],
          "line-opacity": [
            "interpolate", ["linear"], ["get", "intensity"],
            0.05, 0.1,
            0.3, 0.25,
            0.7, 0.4,
            1, 0.55,
          ],
          "line-blur": [
            "interpolate", ["linear"], ["zoom"],
            12, 1, 14, 2, 16, 4, 18, 7,
          ],
        },
        layout: { "line-cap": "round", "line-join": "round" },
      });

      // Update flood water on zoom/pan
      const updateWater = () => {
        try {
          const roads = calculateFloodWater(map, devicesRef.current, floodDepthsRef.current, floodCountsRef.current);
          const src = map.getSource("flood-roads") as mapboxgl.GeoJSONSource | undefined;
          if (src) src.setData({ type: "FeatureCollection", features: roads });
        } catch {
          // queryRenderedFeatures can fail during transitions
        }
      };
      map.on("moveend", updateWater);
      map.on("idle", updateWater);

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

    // Update flood water after map finishes rendering tiles
    const updateFloodRoads = () => {
      try {
        const roads = calculateFloodWater(map, devices, floodDepths ?? {}, floodCounts ?? {});
        const roadSrc = map.getSource("flood-roads") as mapboxgl.GeoJSONSource | undefined;
        if (roadSrc) roadSrc.setData({ type: "FeatureCollection", features: roads });
      } catch {
        // can fail during transitions
      }
    };
    map.once("idle", updateFloodRoads);

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
