"use client";

import { useEffect, useRef } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import type { Device, FloodEvent } from "@/lib/types";

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN || "";

/** Query road features near flood-affected devices for street-level water effect */
function queryFloodRoadsAnalytics(
  map: mapboxgl.Map,
  devices: Device[],
  stats: Record<string, { count: number; maxDepth: number }>,
  maxCount: number,
): GeoJSON.Feature[] {
  const style = map.getStyle();
  if (!style?.layers) return [];

  const roadLayerIds = style.layers
    .filter((l) => {
      const sl = (l as Record<string, unknown>)["source-layer"];
      return l.type === "line" && sl === "road";
    })
    .map((l) => l.id);

  if (roadLayerIds.length === 0) return [];

  const features: GeoJSON.Feature[] = [];
  const seen = new Set<string>();

  devices.forEach((d) => {
    const s = stats[d.device_id];
    if (!s || s.count <= 0) return;

    const point = map.project([d.lng, d.lat]);
    const radius = Math.min(180, 60 + s.count * 12 + (s.maxDepth / 3));

    const bbox: [mapboxgl.PointLike, mapboxgl.PointLike] = [
      [point.x - radius, point.y - radius],
      [point.x + radius, point.y + radius],
    ];

    try {
      const roadFeatures = map.queryRenderedFeatures(bbox, { layers: roadLayerIds });
      for (const f of roadFeatures) {
        if (f.geometry.type !== "LineString" && f.geometry.type !== "MultiLineString") continue;
        const key = `${f.id ?? ""}_${JSON.stringify(f.geometry).slice(0, 100)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        features.push({
          type: "Feature",
          geometry: f.geometry,
          properties: {
            intensity: Math.min(1, s.count / Math.max(maxCount, 1)),
          },
        });
      }
    } catch {
      // can fail during transitions
    }
  });

  return features;
}

interface Props {
  devices: Device[];
  events: FloodEvent[];
  floodCounts: Record<string, number>;
  selectedArea?: string | null;
  onAreaClick?: (neighborhood: string) => void;
}

export function AnalyticsMap({ devices, events, floodCounts, selectedArea, onAreaClick }: Props) {
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const sourcesReady = useRef(false);
  const devicesRef = useRef(devices);
  const statsRef = useRef<Record<string, { count: number; maxDepth: number }>>({});
  const maxCountRef = useRef(1);
  devicesRef.current = devices;

  // Initialize map
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
      // Water depth heatmap circles (background glow)
      map.addSource("flood-water", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });

      // Sensor dots
      map.addSource("analytics-dots", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });

      // Road segments near floods — "water on streets" effect
      map.addSource("flood-roads", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });

      // Water visualization — area glow circles
      map.addLayer({
        id: "flood-water-glow",
        type: "circle",
        source: "flood-water",
        paint: {
          "circle-radius": ["get", "radius"],
          "circle-color": [
            "interpolate",
            ["linear"],
            ["get", "severity"],
            0, "rgba(59, 130, 246, 0.12)",
            0.3, "rgba(59, 130, 246, 0.2)",
            0.6, "rgba(248, 113, 113, 0.25)",
            1, "rgba(248, 113, 113, 0.35)",
          ],
          "circle-blur": 0.6,
        },
      });

      // Inner water ring
      map.addLayer({
        id: "flood-water-inner",
        type: "circle",
        source: "flood-water",
        paint: {
          "circle-radius": ["*", ["get", "radius"], 0.5],
          "circle-color": [
            "interpolate",
            ["linear"],
            ["get", "severity"],
            0, "rgba(59, 130, 246, 0.15)",
            0.5, "rgba(96, 165, 250, 0.25)",
            1, "rgba(248, 113, 113, 0.4)",
          ],
          "circle-blur": 0.3,
        },
      });

      // Road water — outer blue glow on streets
      map.addLayer({
        id: "flood-road-water",
        type: "line",
        source: "flood-roads",
        paint: {
          "line-color": "#1565c0",
          "line-width": [
            "interpolate", ["linear"], ["zoom"],
            12, 6, 14, 14, 16, 28, 18, 50,
          ],
          "line-opacity": [
            "interpolate", ["linear"], ["get", "intensity"],
            0.1, 0.2, 0.5, 0.35, 1, 0.5,
          ],
          "line-blur": [
            "interpolate", ["linear"], ["zoom"],
            12, 3, 14, 5, 16, 8, 18, 12,
          ],
        },
        layout: { "line-cap": "round", "line-join": "round" },
      });

      // Road water — brighter center
      map.addLayer({
        id: "flood-road-water-bright",
        type: "line",
        source: "flood-roads",
        paint: {
          "line-color": "#42a5f5",
          "line-width": [
            "interpolate", ["linear"], ["zoom"],
            12, 3, 14, 7, 16, 15, 18, 28,
          ],
          "line-opacity": [
            "interpolate", ["linear"], ["get", "intensity"],
            0.1, 0.15, 0.5, 0.3, 1, 0.45,
          ],
          "line-blur": [
            "interpolate", ["linear"], ["zoom"],
            12, 1, 14, 2, 16, 4, 18, 6,
          ],
        },
        layout: { "line-cap": "round", "line-join": "round" },
      });

      // Update flood roads on zoom/pan
      const updateRoads = () => {
        if (!map.isStyleLoaded()) return;
        const roads = queryFloodRoadsAnalytics(map, devicesRef.current, statsRef.current, maxCountRef.current);
        const src = map.getSource("flood-roads") as mapboxgl.GeoJSONSource | undefined;
        if (src) src.setData({ type: "FeatureCollection", features: roads });
      };
      map.on("moveend", updateRoads);
      map.on("sourcedata", (e) => {
        if (e.sourceId === "composite" && e.isSourceLoaded) updateRoads();
      });

      // Sensor dots layer
      map.addLayer({
        id: "analytics-dots-layer",
        type: "circle",
        source: "analytics-dots",
        paint: {
          "circle-radius": ["case",
            [">=", ["get", "floodCount"], 8], 10,
            [">=", ["get", "floodCount"], 3], 8,
            [">=", ["get", "floodCount"], 1], 7,
            6,
          ],
          "circle-color": ["get", "color"],
          "circle-stroke-width": 2,
          "circle-stroke-color": ["get", "strokeColor"],
          "circle-opacity": 0.9,
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

      sourcesReady.current = true;

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
        const severityColor = floodCount === 0 ? "#34d399"
          : floodCount <= 2 ? "#fbbf24"
          : floodCount <= 5 ? "#f97316"
          : "#f87171";

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
              <div>
                <span style="color:#6b7280">Floods</span><br/>
                <strong style="color:${severityColor}">${floodCount}</strong>
              </div>
              <div>
                <span style="color:#6b7280">Avg Depth</span><br/>
                <strong>${avgDepth}cm</strong>
              </div>
              <div>
                <span style="color:#6b7280">Worst</span><br/>
                <strong style="color:${maxDepth > 30 ? '#f87171' : '#d1d5db'}">${maxDepth}cm</strong>
              </div>
            </div>
            <div style="margin-top:6px;display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:11px">
              <div>
                <span style="color:#6b7280">Elevation</span><br/>
                <strong style="color:${parseFloat(props.elevation) < 1.0 ? '#fbbf24' : '#d1d5db'}">${props.elevation}m</strong>
              </div>
              <div>
                <span style="color:#6b7280">Battery</span><br/>
                <strong>${parseFloat(props.battery).toFixed(1)}V</strong>
              </div>
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
    });

    return () => {
      mapRef.current?.remove();
      mapRef.current = null;
      sourcesReady.current = false;
    };
  }, []);

  // Update data
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !sourcesReady.current) return;

    const waterSrc = map.getSource("flood-water") as mapboxgl.GeoJSONSource | undefined;
    const dotSrc = map.getSource("analytics-dots") as mapboxgl.GeoJSONSource | undefined;
    if (!waterSrc || !dotSrc) return;

    if (devices.length === 0) {
      waterSrc.setData({ type: "FeatureCollection", features: [] });
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

    const maxFloodCount = Math.max(1, ...Object.values(deviceStats).map((s) => s.count));

    // Update refs for road query function
    statsRef.current = deviceStats;
    maxCountRef.current = maxFloodCount;

    // Water features (flood depth visualization)
    const waterFeatures: GeoJSON.Feature[] = [];
    // Dot features
    const dotFeatures: GeoJSON.Feature[] = [];

    devices.forEach((d) => {
      const stats = deviceStats[d.device_id] ?? { count: 0, totalDepth: 0, maxDepth: 0, compound: 0 };
      const severity = stats.count / maxFloodCount;
      const avgDepth = stats.count > 0 ? Math.round(stats.totalDepth / stats.count) : 0;

      // Water glow — radius based on flood frequency + depth
      if (stats.count > 0) {
        const baseRadius = 25;
        const depthFactor = Math.min(avgDepth / 30, 1);
        const countFactor = Math.min(stats.count / 5, 1);
        const radius = baseRadius + (depthFactor * 30) + (countFactor * 20);

        waterFeatures.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: [d.lng, d.lat] },
          properties: { radius, severity },
        });
      }

      // Dot color: green → yellow → orange → red based on flood count
      let color: string;
      let strokeColor: string;
      if (stats.count === 0) {
        color = "#34d399";
        strokeColor = "#065f46";
      } else if (stats.count <= 2) {
        color = "#fbbf24";
        strokeColor = "#92400e";
      } else if (stats.count <= 5) {
        color = "#f97316";
        strokeColor = "#9a3412";
      } else {
        color = "#f87171";
        strokeColor = "#991b1b";
      }

      // If it has compound events, use a bright red stroke
      if (stats.compound > 0) {
        strokeColor = "#ff0000";
      }

      dotFeatures.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [d.lng, d.lat] },
        properties: {
          device_id: d.device_id,
          name: d.name ?? "",
          neighborhood: d.neighborhood ?? "",
          color,
          strokeColor,
          floodCount: stats.count,
          avgDepth,
          maxDepth: stats.maxDepth,
          elevation: (d.altitude_baro ?? 0).toFixed(2),
          battery: d.battery_v ?? 0,
          label: d.name ?? d.device_id,
        },
      });
    });

    waterSrc.setData({ type: "FeatureCollection", features: waterFeatures });
    dotSrc.setData({ type: "FeatureCollection", features: dotFeatures });

    // Update road-following flood water
    setTimeout(() => {
      if (!map.isStyleLoaded()) return;
      const roads = queryFloodRoadsAnalytics(map, devices, deviceStats, maxFloodCount);
      const roadSrc = map.getSource("flood-roads") as mapboxgl.GeoJSONSource | undefined;
      if (roadSrc) roadSrc.setData({ type: "FeatureCollection", features: roads });
    }, 300);

    // Fit bounds
    if (devices.length > 1) {
      const bounds = new mapboxgl.LngLatBounds();
      devices.forEach((d) => bounds.extend([d.lng, d.lat]));
      map.fitBounds(bounds, { padding: 60, maxZoom: 16, duration: 500 });
    } else if (devices.length === 1) {
      map.flyTo({ center: [devices[0].lng, devices[0].lat], zoom: 16, duration: 500 });
    }
  }, [devices, events, floodCounts]);

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
        <div style={{ fontWeight: 600, marginBottom: 6, color: "#d1d5db", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.5px" }}>
          Flood Activity (30d)
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
          <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#34d399", display: "inline-block" }} />
          <span>No floods</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
          <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#fbbf24", display: "inline-block" }} />
          <span>1-2 events</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
          <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#f97316", display: "inline-block" }} />
          <span>3-5 events</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
          <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#f87171", display: "inline-block" }} />
          <span>6+ events</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, paddingTop: 6, borderTop: "1px solid #1f2937" }}>
          <span style={{ width: 14, height: 4, borderRadius: 2, background: "rgba(66,165,245,0.6)", display: "inline-block" }} />
          <span>Flooded streets</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 3 }}>
          <span style={{ width: 10, height: 10, borderRadius: "50%", border: "2px solid #ff0000", display: "inline-block" }} />
          <span>Compound flooding</span>
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
