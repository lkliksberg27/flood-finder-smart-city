"use client";

import { useEffect, useRef } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import type { Device } from "@/lib/types";

if (typeof window !== "undefined") {
  mapboxgl.workerUrl = "https://unpkg.com/mapbox-gl@3.19.1/dist/mapbox-gl-csp-worker.js";
}

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

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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
      center: [-80.1392, 25.9565],
      zoom: 14,
      attributionControl: false,
      pitchWithRotate: false,
      dragRotate: false,
    });

    const map = mapRef.current;

    map.on("load", () => {
      // Add empty sources
      map.addSource("elev-flow-lines", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addSource("elev-circles", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });

      // Water flow arrow lines
      map.addLayer({
        id: "elev-flow-lines-layer",
        type: "line",
        source: "elev-flow-lines",
        paint: {
          "line-color": "#3b82f6",
          "line-width": 1.5,
          "line-opacity": 0.3,
          "line-dasharray": [2, 3],
        },
      });

      // Elevation circles
      map.addLayer({
        id: "elev-circles-layer",
        type: "circle",
        source: "elev-circles",
        paint: {
          "circle-radius": ["case", ["==", ["get", "isDip"], true], 22, 18],
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

        const popupHTML = `
          <div style="font-family:'DM Sans',sans-serif;min-width:160px">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <strong>${props.device_id}</strong>
              ${props.isDip ? '<span style="font-size:10px;color:#f87171;background:rgba(248,113,113,0.15);padding:1px 6px;border-radius:4px;font-weight:600">ROAD DIP</span>' : ''}
            </div>
            ${props.name ? `<div style="color:#9ca3af;font-size:12px;margin-top:2px">${props.name}</div>` : ''}
            <hr style="border-color:#1f2937;margin:6px 0"/>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:11px">
              <div><span style="color:#6b7280">Elevation</span><br/><strong>${props.elevation}m</strong></div>
              <div><span style="color:#6b7280">Avg Neighbors</span><br/><strong>${props.avgNeighborElev}m</strong></div>
            </div>
            ${props.isDip ? `<div style="margin-top:6px;font-size:11px;color:#f87171;font-weight:600">${props.dipCm}cm below surrounding road level</div>` : ''}
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

    const elevations = withElev.map((d) => d.altitude_baro!);
    const min = Math.min(...elevations);
    const max = Math.max(...elevations);

    // Build flow lines
    const lineFeatures: GeoJSON.Feature[] = [];
    withElev.forEach((d) => {
      const neighbors = withElev
        .filter((n) => n.device_id !== d.device_id)
        .map((n) => ({ ...n, dist: haversineKm(d.lat, d.lng, n.lat, n.lng) }))
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 3);

      neighbors.forEach((n) => {
        if (n.altitude_baro == null || d.altitude_baro == null) return;
        if (d.altitude_baro <= n.altitude_baro!) return;
        if (n.dist > 1) return;

        lineFeatures.push({
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates: [[d.lng, d.lat], [n.lng, n.lat]],
          },
          properties: {},
        });
      });
    });

    // Build circle features
    const circleFeatures: GeoJSON.Feature[] = withElev.map((d) => {
      const color = elevationColor(d.altitude_baro!, min, max);
      const neighbors = withElev
        .filter((n) => n.device_id !== d.device_id)
        .map((n) => ({ ...n, dist: haversineKm(d.lat, d.lng, n.lat, n.lng) }))
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 3);
      const avgNeighborElev = neighbors.reduce((s, n) => s + (n.altitude_baro ?? 0), 0) / neighbors.length;
      const isDip = (d.altitude_baro! - avgNeighborElev) < -0.1;

      return {
        type: "Feature",
        geometry: { type: "Point", coordinates: [d.lng, d.lat] },
        properties: {
          device_id: d.device_id,
          name: d.name ?? "",
          neighborhood: d.neighborhood ?? "",
          color,
          isDip,
          elevation: d.altitude_baro!.toFixed(2),
          avgNeighborElev: avgNeighborElev.toFixed(2),
          dipCm: isDip ? Math.round((avgNeighborElev - d.altitude_baro!) * 100) : 0,
        },
      };
    });

    flowSrc?.setData({ type: "FeatureCollection", features: lineFeatures });
    circSrc?.setData({ type: "FeatureCollection", features: circleFeatures });

    // Auto-fit
    if (withElev.length > 1 && map.getZoom() === 14) {
      const bounds = new mapboxgl.LngLatBounds();
      withElev.forEach((d) => bounds.extend([d.lng, d.lat]));
      map.fitBounds(bounds, { padding: 60, maxZoom: 15 });
    }
  }, [devices, showOverlay]);

  return (
    <div
      ref={containerRef}
      className="flex-1 h-[calc(100vh-140px)] rounded-lg overflow-hidden border border-border-card"
    />
  );
}
