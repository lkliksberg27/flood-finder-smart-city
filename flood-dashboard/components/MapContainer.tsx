"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import type { Device } from "@/lib/types";
import { getReadings24h } from "@/lib/queries";
import { getSupabase } from "@/lib/supabase";
import { queryMapboxRoads, calculateFloodFeatures, type FloodConditions } from "@/lib/golden-beach-roads";

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
  floodConditions?: FloodConditions;
}

export function DeviceMap({ devices, onDeviceClick, highlightDeviceId, height = "100%", searchLocation, floodDepths, floodCounts, floodConditions }: Props) {
  const [mapReady, setMapReady] = useState(false);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const popupRef = useRef<mapboxgl.Popup | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const searchMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const cachedRoadsRef = useRef<number[][][]>([]);
  const devicesRef = useRef<Device[]>(devices);
  const onDeviceClickRef = useRef(onDeviceClick);
  const floodDepthsRef = useRef<Record<string, number>>({});
  const floodConditionsRef = useRef<FloodConditions | undefined>(undefined);
  devicesRef.current = devices;
  onDeviceClickRef.current = onDeviceClick;
  floodDepthsRef.current = floodDepths ?? {};
  floodConditionsRef.current = floodConditions;

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
          const compound = (e.rainfall_mm ?? 0) >= 2 && (e.tide_level_m ?? 0) > 0.3;
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

      // Force tile loading: Mapbox GL in Next.js dynamic imports stalls on
      // initial render. We aggressively kick the render loop + dispatch
      // synthetic mouse events on the canvas to wake up the tile pipeline.
      const kickTiles = () => {
        map.resize();
        map.panBy([1, 0], { duration: 0 });
        map.panBy([-1, 0], { duration: 0 });
        // Synthetic mousemove on canvas wakes Mapbox's internal render loop
        const canvas = map.getCanvas();
        if (canvas) {
          const rect = canvas.getBoundingClientRect();
          const cx = rect.width / 2, cy = rect.height / 2;
          canvas.dispatchEvent(new MouseEvent("mousemove", {
            clientX: rect.left + cx, clientY: rect.top + cy, bubbles: true,
          }));
        }
      };
      requestAnimationFrame(kickTiles);
      // Repeat kicks for 15s to handle slow tile loading
      let kickCount = 0;
      const kickInterval = setInterval(() => {
        kickCount++;
        try { kickTiles(); map.triggerRepaint(); } catch {}
        if (kickCount > 30) clearInterval(kickInterval);
      }, 500);
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
        tolerance: 0,
      });

      // Subtle glow underneath flood water
      map.addLayer({
        id: "flood-road-glow",
        type: "line",
        source: "flood-roads",
        paint: {
          "line-color": "#3498db",
          "line-width": ["interpolate", ["linear"], ["get", "intensity"],
            0.1, 10, 0.5, 16, 1, 22],
          "line-opacity": ["interpolate", ["linear"], ["get", "intensity"],
            0.1, 0.06, 0.4, 0.14, 1, 0.28],
          "line-blur": 6,
        },
        layout: { "line-cap": "round", "line-join": "round" },
      });

      // Flood water on the road
      map.addLayer({
        id: "flood-road-water",
        type: "line",
        source: "flood-roads",
        paint: {
          "line-color": ["interpolate", ["linear"], ["get", "intensity"],
            0.1, "#1a5276", 0.4, "#2471a3", 0.7, "#2e86c1", 1, "#5dade2"],
          "line-width": ["interpolate", ["linear"], ["get", "intensity"],
            0.1, 2, 0.3, 4, 0.6, 6, 1, 8],
          "line-opacity": ["interpolate", ["linear"], ["get", "intensity"],
            0.1, 0.4, 0.3, 0.65, 0.6, 0.8, 1, 0.92],
          "line-blur": 0,
        },
        layout: { "line-cap": "round", "line-join": "round" },
      });

      // Alert rings — outer warning glow around severe flooding sensors
      map.addLayer({
        id: "device-alert-rings",
        type: "circle",
        source: "device-alerts",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 14, 15, 22, 18, 30],
          "circle-color": "#dc2626",
          "circle-opacity": 0.15,
          "circle-blur": 0.6,
        },
      });

      // Inner alert ring — tighter, brighter
      map.addLayer({
        id: "device-alert-rings-inner",
        type: "circle",
        source: "device-alerts",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 8, 15, 14, 18, 20],
          "circle-color": "#ef4444",
          "circle-opacity": 0.1,
        },
      });

      // Device dots
      map.addLayer({
        id: "device-dots-layer",
        type: "circle",
        source: "device-dots",
        paint: {
          "circle-radius": [
            "interpolate", ["linear"], ["zoom"],
            12, ["case",
              ["==", ["get", "highlighted"], true], 7,
              ["==", ["get", "status"], "alert"], 6,
              4
            ],
            15, ["case",
              ["==", ["get", "highlighted"], true], 10,
              ["==", ["get", "status"], "alert"], 8,
              5
            ],
            18, ["case",
              ["==", ["get", "highlighted"], true], 14,
              ["==", ["get", "status"], "alert"], 11,
              7
            ]
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
          <div style="font-family:'DM Sans',sans-serif;min-width:220px;background:#111827;color:#e5e7eb;padding:12px;border-radius:8px;border:1px solid #1f2937">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <strong style="font-size:14px;color:#f9fafb">${props.device_id}</strong>
              <span style="font-size:10px;color:${color};background:${color}22;padding:1px 6px;border-radius:4px;font-weight:600">${(props.status || "").toUpperCase()}</span>
            </div>
            ${props.name ? `<div style="color:#9ca3af;font-size:12px;margin-top:2px">${props.name}</div>` : ""}
            <hr style="border-color:#374151;margin:8px 0"/>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:11px">
              <div>
                <span style="color:#9ca3af">Street Elev.</span><br/>
                <span style="font-weight:600;color:#f3f4f6">${streetElev}m</span>
              </div>
              <div>
                <span style="color:#9ca3af">Last Seen</span><br/>
                <span style="font-weight:600;color:#f3f4f6">${lastSeenText}</span>
              </div>
              <div>
                <span style="color:#9ca3af">Battery</span><br/>
                <div style="display:flex;align-items:center;gap:4px;margin-top:2px">
                  <div style="flex:1;height:4px;background:#374151;border-radius:2px;overflow:hidden">
                    <div style="width:${battPct}%;height:100%;background:${battColor};border-radius:2px"></div>
                  </div>
                  <span style="font-size:10px;font-weight:600;color:#f3f4f6">${Number(battV).toFixed(1)}V</span>
                </div>
              </div>
              ${props.neighborhood ? `<div>
                <span style="color:#9ca3af">Area</span><br/>
                <span style="font-weight:600;color:#f3f4f6">${props.neighborhood}</span>
              </div>` : ""}
            </div>
            <div data-popup-data="${props.device_id}" style="margin-top:4px">
              <div style="font-size:10px;color:#9ca3af;margin-top:6px;display:flex;align-items:center;gap:4px">
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

    // Flood visualization: query Mapbox vector tiles for road geometry
    // This works for ANY location worldwide — no static data files needed
    const refreshFloodFromTiles = () => {
      try {
        const roadSrc = map.getSource("flood-roads") as mapboxgl.GeoJSONSource;
        if (!roadSrc) return;
        const currentDevices = devicesRef.current;
        const currentDepths = floodDepthsRef.current;
        if (currentDevices.length === 0) return;

        // Query road geometry from Mapbox's vector tiles
        const newRoads = queryMapboxRoads(map, currentDevices, currentDepths);

        // Merge new roads into cache (tiles load progressively)
        if (newRoads.length > 0) {
          const existingKeys = new Set(cachedRoadsRef.current.map(r => {
            const s = r[0], e = r[r.length - 1];
            return `${s[0].toFixed(6)},${s[1].toFixed(6)}|${e[0].toFixed(6)},${e[1].toFixed(6)}`;
          }));
          for (const road of newRoads) {
            const s = road[0], e = road[road.length - 1];
            const key = `${s[0].toFixed(6)},${s[1].toFixed(6)}|${e[0].toFixed(6)},${e[1].toFixed(6)}`;
            if (!existingKeys.has(key)) {
              cachedRoadsRef.current.push(road);
              existingKeys.add(key);
            }
          }
        }

        if (cachedRoadsRef.current.length === 0) return;

        const features = calculateFloodFeatures(cachedRoadsRef.current, currentDevices, currentDepths, floodConditionsRef.current);
        roadSrc.setData({ type: "FeatureCollection", features });
      } catch (err) { console.error(`[flood-refresh] error:`, err); }
    };

    // idle fires when map finishes rendering all tiles — perfect time to query features
    map.on("idle", refreshFloodFromTiles);

    // Also refresh on moveend for responsiveness during pan/zoom
    let floodRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    map.on('moveend', () => {
      if (floodRefreshTimer) clearTimeout(floodRefreshTimer);
      floodRefreshTimer = setTimeout(refreshFloodFromTiles, 200);
    });

    // Aggressive retry for first 30s — tiles load progressively
    let floodRetryCount = 0;
    const floodRetryTimer = setInterval(() => {
      floodRetryCount++;
      refreshFloodFromTiles();
      if (floodRetryCount >= 15) clearInterval(floodRetryTimer); // stop after 30s
    }, 2000);

    // --- Render-loop kick for Next.js dynamic imports ---
    // Mapbox tiles can stall on initial load in Next.js. The base map eventually
    // loads on its own, but we kick the render loop to speed it up.

    // Early source init: poll for style readiness
    const earlyInitTimer = setInterval(() => {
      if (map.getSource("device-dots")) { clearInterval(earlyInitTimer); return; }
      try {
        const s = (map as unknown as { style?: { _loaded?: boolean } }).style;
        if (s?._loaded || map.isStyleLoaded()) {
          initSources();
          clearInterval(earlyInitTimer);
        }
      } catch {}
    }, 200);

    map.once("style.load", () => {
      if (!map.getSource("device-dots")) initSources();
      // Kick render loop for 10s to help base map tiles load
      let ticks = 0;
      const kickTimer = setInterval(() => {
        ticks++;
        try { map.triggerRepaint(); } catch {}
        if (ticks > 100) clearInterval(kickTimer);
      }, 100);
    });

    const lastResortTimer = setTimeout(() => {
      if (!map.getSource("device-dots")) {
        try { initSources(); } catch {}
      }
    }, 5000);

    return () => {
      clearInterval(earlyInitTimer);
      clearInterval(floodRetryTimer);
      clearTimeout(lastResortTimer);
      if (floodRefreshTimer) clearTimeout(floodRefreshTimer);
      map.off("idle", refreshFloodFromTiles);
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

    // Center on flooding sensors at zoom 15+ (road tiles load at this level)
    // Only auto-center once on initial load
    const dotSource = map.getSource("device-dots") as (mapboxgl.GeoJSONSource & { _hasAutoFit?: boolean }) | undefined;
    if (devices.length > 0 && dotSource && !dotSource._hasAutoFit) {
      const floodingDevices = devices.filter(d => (floodDepths?.[d.device_id] ?? 0) > 0);
      if (floodingDevices.length > 0) {
        // Center on flood zone centroid
        const avgLng = floodingDevices.reduce((s, d) => s + d.lng, 0) / floodingDevices.length;
        const avgLat = floodingDevices.reduce((s, d) => s + d.lat, 0) / floodingDevices.length;
        map.jumpTo({ center: [avgLng, avgLat], zoom: 15.2 });
      } else {
        const bounds = new mapboxgl.LngLatBounds();
        devices.forEach((d) => bounds.extend([d.lng, d.lat]));
        map.fitBounds(bounds, { padding: 60, maxZoom: 16 });
      }
      dotSource._hasAutoFit = true;
    }

    // Flood water: use cached roads from idle event, or query now if available
    if (roadSrc) {
      const roads = cachedRoadsRef.current.length > 0
        ? cachedRoadsRef.current
        : queryMapboxRoads(map, devices, depths);
      if (roads.length > 0) {
        cachedRoadsRef.current = roads;
        const features = calculateFloodFeatures(roads, devices, depths, floodConditionsRef.current);
        roadSrc.setData({ type: "FeatureCollection", features });
      }
      // If no roads yet, the idle event will pick them up once tiles load
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
