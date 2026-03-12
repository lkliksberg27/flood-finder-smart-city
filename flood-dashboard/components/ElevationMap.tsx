"use client";

import { useEffect, useRef } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import {
  streetElevation,
  haversineKm,
  buildFlowNetwork,
  computeFlowAccumulation,
  type FlowEdge,
} from "@/lib/geo";
import type { Device } from "@/lib/types";

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN || "";

function elevationColor(elevation: number, min: number, max: number): string {
  const range = max - min || 1;
  const ratio = (elevation - min) / range;
  if (ratio < 0.5) {
    const t = ratio * 2;
    return `rgb(248,${Math.round(113 + t * 74)},${Math.round(113 - t * 77)})`;
  }
  const t = (ratio - 0.5) * 2;
  return `rgb(${Math.round(251 - t * 192)},${Math.round(191 - t * 61)},${Math.round(36 + t * 210)})`;
}

interface Props {
  devices: Device[];
  showOverlay: boolean;
}

export function ElevationMap({ devices, showOverlay }: Props) {
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const sourcesAdded = useRef(false);

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

    map.on("load", () => {
      // Force tile rendering — nudge the map to trigger first paint
      requestAnimationFrame(() => {
        map.resize();
        map.panBy([1, 0], { duration: 0 });
        map.panBy([-1, 0], { duration: 0 });
      });

      // Add empty sources
      map.addSource("elev-flow-lines", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addSource("elev-circles", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });

      // Water flow arrow lines — width varies by gradient steepness
      map.addLayer({
        id: "elev-flow-lines-layer",
        type: "line",
        source: "elev-flow-lines",
        paint: {
          "line-color": ["interpolate", ["linear"], ["get", "gradient"],
            0.0005, "#1e40af",  // gentle slope → dark blue
            0.003,  "#3b82f6",  // moderate slope → blue
            0.01,   "#60a5fa",  // steep slope → bright blue
          ],
          "line-width": ["interpolate", ["linear"], ["get", "gradient"],
            0.0005, 1,
            0.003,  2.5,
            0.01,   4,
          ],
          "line-opacity": ["interpolate", ["linear"], ["get", "gradient"],
            0.0005, 0.2,
            0.003,  0.45,
            0.01,   0.7,
          ],
          "line-dasharray": [2, 3],
        },
      });

      // Elevation circles — size varies by flow accumulation
      map.addLayer({
        id: "elev-circles-layer",
        type: "circle",
        source: "elev-circles",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["get", "accumulation"],
            0, 16,
            2, 20,
            5, 26,
            10, 32,
          ],
          "circle-color": ["get", "color"],
          "circle-opacity": 0.55,
          "circle-stroke-width": ["case", ["==", ["get", "isDip"], true], 2, 0],
          "circle-stroke-color": ["case", ["==", ["get", "isDip"], true], "#f87171", "transparent"],
        },
      });

      sourcesAdded.current = true;

      // Click handler for popups
      map.on("click", "elev-circles-layer", (e) => {
        if (!e.features?.[0]) return;
        const props = e.features[0].properties!;
        const coords = (e.features[0].geometry as GeoJSON.Point).coordinates.slice() as [number, number];

        const riskColor =
          props.drainageRisk === "critical" ? "#dc2626" :
          props.drainageRisk === "high" ? "#f59e0b" :
          props.drainageRisk === "moderate" ? "#3b82f6" : "#059669";

        const popupHTML = `
          <div style="font-family:'DM Sans',sans-serif;min-width:180px">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <strong>${props.device_id}</strong>
              ${props.isDip ? '<span style="font-size:10px;color:#f87171;background:rgba(248,113,113,0.15);padding:1px 6px;border-radius:4px;font-weight:600">ROAD DIP</span>' : ''}
            </div>
            ${props.name ? `<div style="color:#9ca3af;font-size:12px;margin-top:2px">${props.name}</div>` : ''}
            <hr style="border-color:#1f2937;margin:6px 0"/>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:11px">
              <div><span style="color:#6b7280">Street Elev.</span><br/><strong>${props.elevation}m</strong></div>
              <div><span style="color:#6b7280">Avg Neighbors</span><br/><strong>${props.avgNeighborElev}m</strong></div>
              <div><span style="color:#6b7280">Upstream Sources</span><br/><strong>${props.accumulation}</strong></div>
              <div><span style="color:#6b7280">Drainage Risk</span><br/><strong style="color:${riskColor}">${(props.drainageRisk || 'low').toUpperCase()}</strong></div>
            </div>
            ${props.isDip ? `<div style="margin-top:6px;font-size:11px;color:#f87171;font-weight:600">${props.dipCm}cm below surrounding road level</div>` : ''}
            ${Number(props.accumulation) > 0 ? `<div style="margin-top:4px;font-size:10px;color:#6b7280">${props.accumulation} sensor${Number(props.accumulation) > 1 ? 's' : ''} drain into this location</div>` : ''}
            ${props.neighborhood ? `<div style="margin-top:4px;font-size:10px;color:#6b7280">${props.neighborhood}</div>` : ''}
          </div>
        `;

        new mapboxgl.Popup({ closeButton: false, offset: 12 })
          .setLngLat(coords)
          .setHTML(popupHTML)
          .addTo(map);
      });

      map.on("mouseenter", "elev-circles-layer", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "elev-circles-layer", () => {
        map.getCanvas().style.cursor = "";
      });
    });

    return () => {
      resizeObserver.disconnect();
      mapRef.current?.remove();
      mapRef.current = null;
      sourcesAdded.current = false;
    };
  }, []);

  // Update data when devices/showOverlay change
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !sourcesAdded.current) return;

    const flowSrc = map.getSource("elev-flow-lines") as mapboxgl.GeoJSONSource | undefined;
    const circSrc = map.getSource("elev-circles") as mapboxgl.GeoJSONSource | undefined;

    if (!showOverlay || devices.length === 0) {
      flowSrc?.setData({ type: "FeatureCollection", features: [] });
      circSrc?.setData({ type: "FeatureCollection", features: [] });
      return;
    }

    const withElev = devices.filter((d) => d.altitude_baro != null);
    if (withElev.length === 0) {
      flowSrc?.setData({ type: "FeatureCollection", features: [] });
      circSrc?.setData({ type: "FeatureCollection", features: [] });
      return;
    }

    // Use streetElevation (accounts for sensor mounting height)
    const elevations = withElev.map((d) => streetElevation(d));
    const min = Math.min(...elevations);
    const max = Math.max(...elevations);

    // Build proper flow network with gradient-based routing
    const edges: FlowEdge[] = buildFlowNetwork(devices);
    const accumulation = computeFlowAccumulation(devices, edges);

    // Build flow lines from the network edges (gradient-weighted)
    const deviceMap = new Map(withElev.map((d) => [d.device_id, d]));
    const lineFeatures: GeoJSON.Feature[] = [];
    for (const edge of edges) {
      const from = deviceMap.get(edge.from);
      const to = deviceMap.get(edge.to);
      if (!from || !to) continue;
      lineFeatures.push({
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [[from.lng, from.lat], [to.lng, to.lat]],
        },
        properties: {
          gradient: edge.gradient,
          elevDrop: edge.elevDrop,
        },
      });
    }

    // Build circle features with flow accumulation and proper streetElevation
    const circleFeatures: GeoJSON.Feature[] = withElev.map((d) => {
      const elev = streetElevation(d);
      const color = elevationColor(elev, min, max);
      const accum = accumulation[d.device_id] ?? 0;

      // IDW neighbor elevation for dip detection
      const neighbors = withElev
        .filter((n) => n.device_id !== d.device_id)
        .map((n) => ({ ...n, elev: streetElevation(n), dist: haversineKm(d.lat, d.lng, n.lat, n.lng) }))
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 4);

      const totalWeight = neighbors.reduce((s, n) => s + 1 / Math.max(n.dist, 0.01), 0);
      const avgNeighborElev = neighbors.reduce((s, n) => s + (n.elev / Math.max(n.dist, 0.01)), 0) / totalWeight;
      const isDip = (elev - avgNeighborElev) < -0.08;

      // Drainage risk
      const dipCm = isDip ? Math.round((avgNeighborElev - elev) * 100) : 0;
      const riskScore = dipCm * 0.4 + accum * 8;
      const drainageRisk =
        riskScore > 40 ? 'critical' :
        riskScore > 20 ? 'high' :
        riskScore > 10 ? 'moderate' : 'low';

      return {
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [d.lng, d.lat] },
        properties: {
          device_id: d.device_id,
          name: d.name ?? "",
          neighborhood: d.neighborhood ?? "",
          color,
          isDip,
          elevation: elev.toFixed(2),
          avgNeighborElev: avgNeighborElev.toFixed(2),
          dipCm,
          accumulation: accum,
          drainageRisk,
        },
      };
    });

    flowSrc?.setData({ type: "FeatureCollection", features: lineFeatures });
    circSrc?.setData({ type: "FeatureCollection", features: circleFeatures });

    // Auto-fit
    if (withElev.length > 1 && map.getZoom() === 15) {
      const bounds = new mapboxgl.LngLatBounds();
      withElev.forEach((d) => bounds.extend([d.lng, d.lat]));
      map.fitBounds(bounds, { padding: 60, maxZoom: 16 });
    }
  }, [devices, showOverlay]);

  return (
    <div
      ref={containerRef}
      className="flex-1 h-[calc(100vh-140px)] rounded-lg overflow-hidden border border-border-card"
    />
  );
}
