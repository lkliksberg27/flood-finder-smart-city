"use client";

import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { Device } from "@/lib/types";

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
  const mapRef = useRef<L.Map | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<L.Layer[]>([]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    mapRef.current = L.map(containerRef.current, {
      center: [25.9565, -80.1392],
      zoom: 14,
    });
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      attribution: "&copy; CARTO",
      maxZoom: 19,
    }).addTo(mapRef.current);
    return () => { mapRef.current?.remove(); mapRef.current = null; };
  }, []);

  useEffect(() => {
    if (!mapRef.current || devices.length === 0) return;
    overlayRef.current.forEach((m) => m.remove());
    overlayRef.current = [];
    if (!showOverlay) return;

    const withElev = devices.filter((d) => d.altitude_baro != null);
    if (withElev.length === 0) return;

    const elevations = withElev.map((d) => d.altitude_baro!);
    const min = Math.min(...elevations);
    const max = Math.max(...elevations);

    // Draw water flow arrows from higher to lower nearby sensors
    withElev.forEach((d) => {
      const neighbors = withElev
        .filter((n) => n.device_id !== d.device_id)
        .map((n) => ({ ...n, dist: haversineKm(d.lat, d.lng, n.lat, n.lng) }))
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 3);

      neighbors.forEach((n) => {
        if (n.altitude_baro == null || d.altitude_baro == null) return;
        // Only draw arrow from higher to lower
        if (d.altitude_baro <= n.altitude_baro!) return;
        // Only show arrows within 1km
        if (n.dist > 1) return;

        const line = L.polyline(
          [[d.lat, d.lng], [n.lat, n.lng]],
          {
            color: "#3b82f6",
            weight: 1.5,
            opacity: 0.3,
            dashArray: "4 6",
          }
        ).addTo(mapRef.current!);
        overlayRef.current.push(line);
      });
    });

    // Draw elevation circles on top
    withElev.forEach((d) => {
      const color = elevationColor(d.altitude_baro!, min, max);

      // Find if this is a dip
      const neighbors = withElev
        .filter((n) => n.device_id !== d.device_id)
        .map((n) => ({ ...n, dist: haversineKm(d.lat, d.lng, n.lat, n.lng) }))
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 3);
      const avgNeighborElev = neighbors.reduce((s, n) => s + (n.altitude_baro ?? 0), 0) / neighbors.length;
      const isDip = (d.altitude_baro! - avgNeighborElev) < -0.1;

      const marker = L.circleMarker([d.lat, d.lng], {
        radius: isDip ? 22 : 18,
        fillColor: color,
        color: isDip ? "#f87171" : color,
        weight: isDip ? 2 : 0,
        fillOpacity: 0.55,
      }).addTo(mapRef.current!);

      marker.bindPopup(`
        <div style="font-family:'DM Sans',sans-serif;min-width:160px">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <strong>${d.device_id}</strong>
            ${isDip ? '<span style="font-size:10px;color:#f87171;background:rgba(248,113,113,0.15);padding:1px 6px;border-radius:4px;font-weight:600">ROAD DIP</span>' : ''}
          </div>
          ${d.name ? `<div style="color:#9ca3af;font-size:12px;margin-top:2px">${d.name}</div>` : ''}
          <hr style="border-color:#1f2937;margin:6px 0"/>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:11px">
            <div><span style="color:#6b7280">Elevation</span><br/><strong>${d.altitude_baro!.toFixed(2)}m</strong></div>
            <div><span style="color:#6b7280">Avg Neighbors</span><br/><strong>${avgNeighborElev.toFixed(2)}m</strong></div>
          </div>
          ${isDip ? `<div style="margin-top:6px;font-size:11px;color:#f87171;font-weight:600">${Math.round((avgNeighborElev - d.altitude_baro!) * 100)}cm below surrounding road level</div>` : ''}
          ${d.neighborhood ? `<div style="margin-top:4px;font-size:10px;color:#6b7280">${d.neighborhood}</div>` : ''}
        </div>
      `);
      overlayRef.current.push(marker);
    });

    // Auto-fit map to show all sensors
    if (withElev.length > 1 && mapRef.current.getZoom() === 14) {
      const bounds = L.latLngBounds(withElev.map((d) => [d.lat, d.lng]));
      if (bounds.isValid()) {
        mapRef.current.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
      }
    }
  }, [devices, showOverlay]);

  return (
    <div
      ref={containerRef}
      className="flex-1 h-[calc(100vh-140px)] rounded-lg overflow-hidden border border-border-card"
    />
  );
}
