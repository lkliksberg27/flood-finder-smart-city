"use client";

import { useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import {
  streetElevation,
  haversineKm,
  buildFlowNetwork,
  computeFlowAccumulation,
} from "@/lib/geo";
import type { Device } from "@/lib/types";

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN || "";

/**
 * Estimate flood depth risk for a sensor based on physics:
 * - Elevation relative to neighbors (lower = more pooling)
 * - Flow accumulation (more upstream sources = more water converges)
 * - Historical flood frequency
 *
 * Returns estimated depth in cm (0 = safe, higher = more risk)
 */
function estimateFloodDepth(
  device: Device,
  allDevices: Device[],
  accumulation: Record<string, number>,
  floodCounts: Record<string, number>,
): number {
  const elev = streetElevation(device);

  // Get neighbors for relative elevation
  const neighbors = allDevices
    .filter((n) => n.device_id !== device.device_id && n.altitude_baro != null)
    .map((n) => ({
      elev: streetElevation(n),
      dist: haversineKm(device.lat, device.lng, n.lat, n.lng),
    }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 5);

  if (neighbors.length === 0) return 0;

  // Inverse-distance weighted avg neighbor elevation
  const totalW = neighbors.reduce((s, n) => s + 1 / Math.max(n.dist, 0.01), 0);
  const avgNeighborElev =
    neighbors.reduce((s, n) => s + n.elev / Math.max(n.dist, 0.01), 0) /
    totalW;

  // How much lower is this sensor vs neighbors (in cm)
  const dipCm = Math.max(0, (avgNeighborElev - elev) * 100);

  // Flow accumulation: how many upstream sensors drain here
  const accum = accumulation[device.device_id] ?? 0;

  // Historical flood frequency
  const floods = floodCounts[device.device_id] ?? 0;

  // Estimated depth combines all factors:
  // - Each cm of dip contributes ~0.8cm of potential depth
  // - Each upstream source adds ~2cm
  // - Each historical flood adds ~1.5cm
  const estimated = dipCm * 0.8 + accum * 2 + floods * 1.5;

  return Math.round(estimated);
}

/** Color based on estimated flood depth */
function riskColor(depthCm: number): string {
  if (depthCm >= 15) return "#dc2626"; // red
  if (depthCm >= 5) return "#f59e0b"; // amber/yellow
  return "#059669"; // green
}

interface Props {
  devices: Device[];
  floodCounts: Record<string, number>;
  showOverlay: boolean;
}

export function ElevationMap({ devices, floodCounts, showOverlay }: Props) {
  const [mapReady, setMapReady] = useState(false);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Initialize map
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    mapboxgl.accessToken = MAPBOX_TOKEN;

    mapRef.current = new mapboxgl.Map({
      container: containerRef.current,
      style: "mapbox://styles/mapbox/dark-v11",
      center: [-80.1196, 25.966],
      zoom: 15,
      attributionControl: false,
      pitchWithRotate: false,
      dragRotate: false,
    });

    const map = mapRef.current;

    const resizeObserver = new ResizeObserver(() => map.resize());
    resizeObserver.observe(containerRef.current);

    map.on("load", () => {
      requestAnimationFrame(() => {
        map.resize();
        map.panBy([1, 0], { duration: 0 });
        map.panBy([-1, 0], { duration: 0 });
      });

      map.addSource("elev-dots", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });

      // Sensor dots — colored by flood risk
      map.addLayer({
        id: "elev-dots-layer",
        type: "circle",
        source: "elev-dots",
        paint: {
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["get", "estimatedDepth"],
            0, 5,
            10, 7,
            20, 9,
            40, 12,
          ],
          "circle-color": ["get", "color"],
          "circle-stroke-width": 2,
          "circle-stroke-color": ["get", "color"],
          "circle-opacity": 0.85,
          "circle-stroke-opacity": 0.4,
        },
      });

      // Labels
      map.addLayer({
        id: "elev-labels",
        type: "symbol",
        source: "elev-dots",
        layout: {
          "text-field": ["concat", "~", ["get", "estimatedDepth"], "cm"],
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

      // Click popup
      map.on("click", "elev-dots-layer", (e) => {
        if (!e.features?.[0]) return;
        const props = e.features[0].properties!;
        const coords = (
          e.features[0].geometry as GeoJSON.Point
        ).coordinates.slice() as [number, number];

        const riskLabel =
          parseFloat(props.estimatedDepth) >= 15
            ? "HIGH RISK"
            : parseFloat(props.estimatedDepth) >= 5
              ? "MODERATE"
              : "LOW RISK";
        const riskBg =
          parseFloat(props.estimatedDepth) >= 15
            ? "rgba(220,38,38,0.15)"
            : parseFloat(props.estimatedDepth) >= 5
              ? "rgba(245,158,11,0.15)"
              : "rgba(5,150,105,0.15)";

        const popupHTML = `
          <div style="font-family:'DM Sans',sans-serif;min-width:180px">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <strong>${props.device_id}</strong>
              <span style="font-size:10px;color:${props.color};background:${riskBg};padding:1px 6px;border-radius:4px;font-weight:600">${riskLabel}</span>
            </div>
            ${props.name ? `<div style="color:#9ca3af;font-size:12px;margin-top:2px">${props.name}</div>` : ""}
            <hr style="border-color:#1f2937;margin:6px 0"/>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:11px">
              <div><span style="color:#6b7280">Elevation</span><br/><strong>${props.elevation}m</strong></div>
              <div><span style="color:#6b7280">Est. Depth</span><br/><strong style="color:${props.color}">~${props.estimatedDepth}cm</strong></div>
              <div><span style="color:#6b7280">Upstream</span><br/><strong>${props.flowAccum} sources</strong></div>
              <div><span style="color:#6b7280">Floods/30d</span><br/><strong>${props.floodCount}</strong></div>
            </div>
            ${props.isDip === "true" ? `<div style="margin-top:6px;font-size:11px;color:#f87171;font-weight:600">${props.dipCm}cm below surrounding road</div>` : ""}
            ${props.neighborhood ? `<div style="margin-top:4px;font-size:10px;color:#6b7280">${props.neighborhood}</div>` : ""}
          </div>
        `;

        new mapboxgl.Popup({ closeButton: false, offset: 12 })
          .setLngLat(coords)
          .setHTML(popupHTML)
          .addTo(map);
      });

      map.on("mouseenter", "elev-dots-layer", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "elev-dots-layer", () => {
        map.getCanvas().style.cursor = "";
      });
    });

    return () => {
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

    const dotSrc = map.getSource("elev-dots") as
      | mapboxgl.GeoJSONSource
      | undefined;

    if (!showOverlay || devices.length === 0) {
      dotSrc?.setData({ type: "FeatureCollection", features: [] });
      return;
    }

    const withElev = devices.filter((d) => d.altitude_baro != null);
    if (withElev.length === 0) {
      dotSrc?.setData({ type: "FeatureCollection", features: [] });
      return;
    }

    // Build flow network for accumulation
    const edges = buildFlowNetwork(devices);
    const accumulation = computeFlowAccumulation(devices, edges);

    // Sensor dots with estimated flood depth
    const dotFeatures: GeoJSON.Feature[] = withElev.map((d) => {
      const elev = streetElevation(d);
      const estDepth = estimateFloodDepth(d, devices, accumulation, floodCounts);
      const color = riskColor(estDepth);

      // Compute neighbor avg for popup
      const neighbors = withElev
        .filter((n) => n.device_id !== d.device_id)
        .map((n) => ({
          elev: streetElevation(n),
          dist: haversineKm(d.lat, d.lng, n.lat, n.lng),
        }))
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 4);
      const totalW = neighbors.reduce(
        (s, n) => s + 1 / Math.max(n.dist, 0.01),
        0,
      );
      const avgNeighborElev =
        neighbors.length > 0
          ? neighbors.reduce(
              (s, n) => s + n.elev / Math.max(n.dist, 0.01),
              0,
            ) / totalW
          : elev;
      const isDip = elev - avgNeighborElev < -0.08;
      const dipCm = isDip ? Math.round((avgNeighborElev - elev) * 100) : 0;

      return {
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [d.lng, d.lat] },
        properties: {
          device_id: d.device_id,
          name: d.name ?? "",
          neighborhood: d.neighborhood ?? "",
          color,
          elevation: elev.toFixed(2),
          estimatedDepth: estDepth,
          flowAccum: accumulation[d.device_id] ?? 0,
          floodCount: floodCounts[d.device_id] ?? 0,
          isDip: isDip ? "true" : "false",
          dipCm,
        },
      };
    });
    dotSrc?.setData({ type: "FeatureCollection", features: dotFeatures });

    // Fit bounds
    if (withElev.length > 1) {
      const bounds = new mapboxgl.LngLatBounds();
      withElev.forEach((d) => bounds.extend([d.lng, d.lat]));
      map.fitBounds(bounds, { padding: 60, maxZoom: 16, duration: 500 });
    }
  }, [devices, floodCounts, showOverlay, mapReady]);

  return (
    <div
      className="flex-1 rounded-lg overflow-hidden border border-border-card"
      style={{ position: "relative", height: "100%", minHeight: "300px" }}
    >
      <div
        ref={containerRef}
        style={{ height: "100%", width: "100%", borderRadius: "8px" }}
      />
    </div>
  );
}
