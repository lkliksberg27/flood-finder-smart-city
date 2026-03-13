"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import type { Device } from "@/lib/types";
import { getReadings24h } from "@/lib/queries";
import { getSupabase } from "@/lib/supabase";
import { queryMapboxRoads, calculateFloodFeatures } from "@/lib/golden-beach-roads";

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN || "";

function sensorColor(status: string, floodDepth: number): string {
  if (status === "offline") return "#4b5563"; // grey
  if (floodDepth > 10) return "#dc2626";      // red — severe flooding
  if (floodDepth > 0) return "#f59e0b";        // orange/amber — moderate flooding
  return "#059669";                             // green — no flooding
}

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
  devicesRef.current = devices;
  onDeviceClickRef.current = onDeviceClick;

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

        const depths = readings.map((r) => r.flood_depth_cm ?? 0);
        if (depths.some((d) => d > 0)) {
          html += buildSparklineSVG(depths, "#f87171", "24h Flood Depth (cm)");
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

    // Fix grey-map-on-load: resize whenever container dimensions change
    const resizeObserver = new ResizeObserver(() => map.resize());
    resizeObserver.observe(containerRef.current);

    const initSources = () => {
      // Prevent double-init
      if (map.getSource("device-dots")) return;

      // Force tile rendering — nudge the map to trigger first paint
      requestAnimationFrame(() => {
        map.resize();
        map.panBy([1, 0], { duration: 0 });
        map.panBy([-1, 0], { duration: 0 });
      });
      map.addSource("device-alerts", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addSource("device-dots", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addSource("flood-roads", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });

      // Flood water glow (soft outer halo for smooth gradient)
      map.addLayer({
        id: "flood-road-glow",
        type: "line",
        source: "flood-roads",
        paint: {
          "line-color": ["interpolate", ["linear"], ["get", "intensity"],
            0.1, "#1a4a7a", 0.5, "#2874a6", 1, "#3498db"],
          "line-width": ["interpolate", ["linear"], ["get", "intensity"],
            0.08, 10, 0.3, 16, 0.6, 22, 1, 30],
          "line-opacity": ["interpolate", ["linear"], ["get", "intensity"],
            0.08, 0.04, 0.2, 0.08, 0.5, 0.12, 1, 0.18],
          "line-blur": 8,
        },
        layout: { "line-cap": "round", "line-join": "round" },
      });

      // Flood water main line (smooth gradient)
      map.addLayer({
        id: "flood-road-water",
        type: "line",
        source: "flood-roads",
        paint: {
          "line-color": ["interpolate", ["linear"], ["get", "intensity"],
            0.08, "#1a5276", 0.25, "#2180a8", 0.5, "#3498db", 0.75, "#5dade2", 1, "#85c1e9"],
          "line-width": ["interpolate", ["linear"], ["get", "intensity"],
            0.08, 2, 0.25, 3.5, 0.5, 5, 0.75, 7, 1, 10],
          "line-opacity": ["interpolate", ["linear"], ["get", "intensity"],
            0.08, 0.25, 0.25, 0.4, 0.5, 0.55, 0.75, 0.65, 1, 0.8],
          "line-blur": 1.5,
        },
        layout: { "line-cap": "round", "line-join": "round" },
      });

      // Alert rings
      map.addLayer({
        id: "device-alert-rings",
        type: "circle",
        source: "device-alerts",
        paint: {
          "circle-radius": 16,
          "circle-color": "#b91c1c",
          "circle-opacity": 0.1,
        },
      });

      // Device dots
      map.addLayer({
        id: "device-dots-layer",
        type: "circle",
        source: "device-dots",
        paint: {
          "circle-radius": ["case",
            ["==", ["get", "highlighted"], true], 9,
            ["==", ["get", "status"], "alert"], 7,
            5
          ],
          "circle-color": ["get", "color"],
          "circle-stroke-width": ["case",
            ["==", ["get", "highlighted"], true], 2,
            1
          ],
          "circle-stroke-color": ["case",
            ["==", ["get", "highlighted"], true], "#d1d5db",
            ["get", "color"]
          ],
          "circle-opacity": 0.8,
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
        const battColor = battPct > 60 ? "#059669" : battPct > 25 ? "#d97706" : "#dc2626";

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

      map.on("mouseenter", "device-dots-layer", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "device-dots-layer", () => {
        map.getCanvas().style.cursor = "";
      });

      setMapReady(true);
    };

    map.on("load", initSources);

    // Fallback: poll every 1s — resize + nudge until style loads, then force init
    const fallbackTimer = setInterval(() => {
      if (map.getSource("device-dots")) {
        clearInterval(fallbackTimer);
        return;
      }
      map.resize();
      map.panBy([1, 0], { duration: 0 });
      map.panBy([-1, 0], { duration: 0 });
      if (map.isStyleLoaded()) {
        clearInterval(fallbackTimer);
        initSources();
      }
    }, 1000);

    return () => {
      clearInterval(fallbackTimer);
      resizeObserver.disconnect();
      mapRef.current?.remove();
      mapRef.current = null;
      setMapReady(false);
    };
  }, [loadPopupData]);

  // Update sources when devices/flood data change
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const alerts: GeoJSON.Feature[] = [];
    const dots: GeoJSON.Feature[] = [];

    const depths = floodDepths ?? {};
    devices.forEach((device) => {
      const depth = depths[device.device_id] ?? 0;
      const color = sensorColor(device.status, depth);
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

      if (depth > 10) {
        alerts.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: [device.lng, device.lat] },
          properties: {},
        });
      }

      dots.push({
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
    const roadSrc = map.getSource("flood-roads") as mapboxgl.GeoJSONSource | undefined;

    if (alertSrc) alertSrc.setData({ type: "FeatureCollection", features: alerts });
    if (dotSrc) dotSrc.setData({ type: "FeatureCollection", features: dots });

    // Fit bounds
    if (devices.length > 0 && map.getZoom() === 15) {
      const bounds = new mapboxgl.LngLatBounds();
      devices.forEach((d) => bounds.extend([d.lng, d.lat]));
      map.fitBounds(bounds, { padding: 60, maxZoom: 16 });
    }

    // Query road geometry and calculate flood water
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    const updateFlood = () => {
      if (cancelled) return;
      try {
        const roads = queryMapboxRoads(map, devices);
        if (roads.length === 0) return;
        const features = calculateFloodFeatures(roads, devices, depths);
        if (roadSrc) roadSrc.setData({ type: "FeatureCollection", features });
      } catch (err) {
        console.error("[FloodViz] updateFlood error:", err);
      }
    };

    // Run immediately with fallback roads, then re-run when tiles load
    updateFlood();
    const onIdle = () => { if (!cancelled) updateFlood(); };
    map.once("idle", onIdle);
    // One more retry after tiles have had time to fully load
    timers.push(setTimeout(() => { if (!cancelled) updateFlood(); }, 3000));

    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
      map.off("idle", onIdle);
    };
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
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#059669", display: "inline-block" }} />
          <span>No Flooding</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#f59e0b", display: "inline-block" }} />
          <span>Moderate Flood</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#dc2626", display: "inline-block" }} />
          <span>Severe Flood</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#4b5563", display: "inline-block" }} />
          <span>Offline</span>
        </div>
        <hr style={{ border: "none", borderTop: "1px solid #374151", margin: "4px 0" }} />
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
          <span style={{ width: 14, height: 3, borderRadius: 2, background: "linear-gradient(to right, #1a6fa0, #5cc8f0)", display: "inline-block" }} />
          <span>Flood Water</span>
        </div>
      </div>
    </div>
  );
}
