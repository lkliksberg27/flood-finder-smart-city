"use client";

import { useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import type { Device, FloodEvent } from "@/lib/types";
import { queryMapboxRoads, calculateFloodFeatures } from "@/lib/golden-beach-roads";

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN || "";

function sensorColor(status: string, floodDepth: number): string {
  if (status === "offline") return "#4b5563";
  if (floodDepth > 10) return "#dc2626";
  if (floodDepth > 0) return "#f59e0b";
  return "#059669";
}

interface Props {
  devices: Device[];
  events: FloodEvent[];
  floodCounts: Record<string, number>;
  selectedArea?: string | null;
  onAreaClick?: (neighborhood: string) => void;
}

export function AnalyticsMap({ devices, events, floodCounts, selectedArea, onAreaClick }: Props) {
  const [mapReady, setMapReady] = useState(false);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const devicesRef = useRef(devices);
  devicesRef.current = devices;

  // Initialize map
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
      if (map.getSource("analytics-dots")) return;
      requestAnimationFrame(() => {
        map.resize();
        map.panBy([1, 0], { duration: 0 });
        map.panBy([-1, 0], { duration: 0 });
      });
      map.addSource("flood-roads", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addSource("analytics-dots", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addSource("analytics-alerts", {
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
        id: "analytics-alert-rings",
        type: "circle",
        source: "analytics-alerts",
        paint: {
          "circle-radius": 16,
          "circle-color": "#b91c1c",
          "circle-opacity": 0.1,
        },
      });

      // Sensor dots
      map.addLayer({
        id: "analytics-dots-layer",
        type: "circle",
        source: "analytics-dots",
        paint: {
          "circle-radius": ["case",
            ["==", ["get", "status"], "alert"], 7,
            5,
          ],
          "circle-color": ["get", "color"],
          "circle-stroke-width": 1,
          "circle-stroke-color": ["get", "color"],
          "circle-opacity": 0.8,
        },
      });

      // Labels
      map.addLayer({
        id: "analytics-labels",
        type: "symbol",
        source: "analytics-dots",
        layout: {
          "text-field": ["get", "label"],
          "text-size": 10,
          "text-offset": [0, 1.8],
          "text-anchor": "top",
          "text-allow-overlap": false,
        },
        paint: {
          "text-color": "#9ca3af",
          "text-halo-color": "#111827",
          "text-halo-width": 1,
        },
      });

      setMapReady(true);

      // Click handler
      map.on("click", "analytics-dots-layer", (e) => {
        if (!e.features?.[0]) return;
        const props = e.features[0].properties!;
        const coords = (e.features[0].geometry as GeoJSON.Point).coordinates.slice() as [number, number];

        const floodCount = props.floodCount ?? 0;
        const avgDepth = props.avgDepth ?? 0;
        const maxDepth = props.maxDepth ?? 0;

        const severityLabel = floodCount === 0 ? "No Floods"
          : floodCount <= 2 ? "Low Activity"
          : floodCount <= 5 ? "Moderate"
          : "High Activity";
        const severityColor = floodCount === 0 ? "#059669"
          : floodCount <= 2 ? "#d97706"
          : floodCount <= 5 ? "#c2410c"
          : "#b91c1c";

        const popupHTML = `
          <div style="font-family:'DM Sans',sans-serif;min-width:200px">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <strong style="font-size:13px">${props.device_id}</strong>
              <span style="font-size:10px;color:${severityColor};background:${severityColor}22;padding:1px 6px;border-radius:4px;font-weight:600">${severityLabel}</span>
            </div>
            ${props.name ? `<div style="color:#9ca3af;font-size:11px;margin-top:2px">${props.name}</div>` : ""}
            ${props.neighborhood ? `<div style="color:#6b7280;font-size:10px;margin-top:1px">${props.neighborhood}</div>` : ""}
            <hr style="border-color:#1f2937;margin:6px 0"/>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;font-size:11px">
              <div><span style="color:#6b7280">Floods</span><br/><strong style="color:${severityColor}">${floodCount}</strong></div>
              <div><span style="color:#6b7280">Avg Depth</span><br/><strong>${avgDepth}cm</strong></div>
              <div><span style="color:#6b7280">Worst</span><br/><strong style="color:${maxDepth > 30 ? '#b91c1c' : '#d1d5db'}">${maxDepth}cm</strong></div>
            </div>
            <div style="margin-top:6px;display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:11px">
              <div><span style="color:#6b7280">Elevation</span><br/><strong style="color:${parseFloat(props.elevation) < 1.0 ? '#d97706' : '#d1d5db'}">${props.elevation}m</strong></div>
              <div><span style="color:#6b7280">Battery</span><br/><strong>${parseFloat(props.battery).toFixed(1)}V</strong></div>
            </div>
          </div>
        `;

        new mapboxgl.Popup({ closeButton: false, offset: 12 })
          .setLngLat(coords)
          .setHTML(popupHTML)
          .addTo(map);
      });

      map.on("mouseenter", "analytics-dots-layer", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "analytics-dots-layer", () => {
        map.getCanvas().style.cursor = "";
      });
    };

    map.on("load", initSources);

    // Fallback: poll every 1s — if style loaded but load event never fired, force init
    const fallbackTimer = setInterval(() => {
      if (map.getSource("analytics-dots")) {
        clearInterval(fallbackTimer);
        return;
      }
      map.resize();
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
  }, []);

  // Update data
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const dotSrc = map.getSource("analytics-dots") as mapboxgl.GeoJSONSource | undefined;
    const alertSrc = map.getSource("analytics-alerts") as mapboxgl.GeoJSONSource | undefined;
    if (!dotSrc) return;

    if (devices.length === 0) {
      dotSrc.setData({ type: "FeatureCollection", features: [] });
      return;
    }

    // Compute per-device flood stats
    const deviceStats: Record<string, { count: number; totalDepth: number; maxDepth: number; compound: number }> = {};
    events.forEach((e) => {
      const id = e.device_id;
      if (!deviceStats[id]) deviceStats[id] = { count: 0, totalDepth: 0, maxDepth: 0, compound: 0 };
      deviceStats[id].count++;
      deviceStats[id].totalDepth += e.peak_depth_cm;
      deviceStats[id].maxDepth = Math.max(deviceStats[id].maxDepth, e.peak_depth_cm);
      if ((e.rainfall_mm ?? 0) > 0 && (e.tide_level_m ?? 0) > 0.3) deviceStats[id].compound++;
    });

    // Dot features
    const dotFeatures: GeoJSON.Feature[] = [];

    devices.forEach((d) => {
      const stats = deviceStats[d.device_id] ?? { count: 0, totalDepth: 0, maxDepth: 0, compound: 0 };
      const avgDepth = stats.count > 0 ? Math.round(stats.totalDepth / stats.count) : 0;

      const color = sensorColor(d.status, stats.maxDepth);

      dotFeatures.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [d.lng, d.lat] },
        properties: {
          device_id: d.device_id,
          name: d.name ?? "",
          neighborhood: d.neighborhood ?? "",
          status: d.status,
          color,
          floodCount: stats.count,
          avgDepth,
          maxDepth: stats.maxDepth,
          elevation: ((d.altitude_baro ?? 0) - (d.baseline_distance_cm ?? 0) / 100).toFixed(2),
          battery: d.battery_v ?? 0,
          label: d.name ?? d.device_id,
        },
      });
    });

    dotSrc.setData({ type: "FeatureCollection", features: dotFeatures });

    // Alert rings for alert devices
    const alertFeatures: GeoJSON.Feature[] = devices
      .filter(d => d.status === "alert")
      .map(d => ({
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [d.lng, d.lat] },
        properties: {},
      }));
    if (alertSrc) alertSrc.setData({ type: "FeatureCollection", features: alertFeatures });

    // Build depth map from stats
    const depthMap: Record<string, number> = {};
    for (const [id, stat] of Object.entries(deviceStats)) {
      if (stat.count > 0) depthMap[id] = stat.maxDepth;
    }

    // Fit bounds
    if (devices.length > 1) {
      const bounds = new mapboxgl.LngLatBounds();
      devices.forEach((d) => bounds.extend([d.lng, d.lat]));
      map.fitBounds(bounds, { padding: 60, maxZoom: 16, duration: 500 });
    } else if (devices.length === 1) {
      map.flyTo({ center: [devices[0].lng, devices[0].lat], zoom: 16, duration: 500 });
    }

    // Query road geometry and calculate flood water
    const roadSrc = map.getSource("flood-roads") as mapboxgl.GeoJSONSource | undefined;
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    const updateFlood = () => {
      if (cancelled) return;
      try {
        const roads = queryMapboxRoads(map, devices);
        if (roads.length === 0) return;
        const features = calculateFloodFeatures(roads, devices, depthMap);
        if (roadSrc) roadSrc.setData({ type: "FeatureCollection", features });
      } catch (err) {
        console.error("[FloodViz] updateFlood error:", err);
      }
    };

    // Run immediately with fallback roads, then re-run when tiles load
    updateFlood();
    const onIdle = () => { if (!cancelled) updateFlood(); };
    map.once("idle", onIdle);
    timers.push(setTimeout(() => { if (!cancelled) updateFlood(); }, 3000));

    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
      map.off("idle", onIdle);
    };
  }, [devices, events, floodCounts, mapReady]);

  return (
    <div style={{ position: "relative", height: "100%", width: "100%" }}>
      <div ref={containerRef} style={{ height: "100%", width: "100%", borderRadius: "8px" }} />
      {/* Legend */}
      <div style={{
        position: "absolute",
        bottom: 12,
        left: 12,
        background: "rgba(17,24,39,0.92)",
        borderRadius: 8,
        padding: "10px 14px",
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
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 14, height: 3, borderRadius: 2, background: "linear-gradient(to right, #1a5276, #85c1e9)", display: "inline-block" }} />
          <span>Flood Water</span>
        </div>
      </div>

      {/* Area label */}
      {selectedArea && (
        <div style={{
          position: "absolute",
          top: 12,
          left: 12,
          background: "rgba(17,24,39,0.92)",
          borderRadius: 8,
          padding: "6px 12px",
          fontSize: 12,
          color: "#d1d5db",
          zIndex: 1000,
          backdropFilter: "blur(4px)",
          border: "1px solid #1f2937",
          fontWeight: 600,
        }}>
          {selectedArea}
        </div>
      )}
    </div>
  );
}
