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

interface Props {
  devices: Device[];
  showOverlay: boolean;
}

export function ElevationMap({ devices, showOverlay }: Props) {
  const mapRef = useRef<L.Map | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<L.CircleMarker[]>([]);

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

    const elevations = devices.map((d) => d.altitude_baro).filter((e): e is number => e != null);
    if (elevations.length === 0) return;
    const min = Math.min(...elevations);
    const max = Math.max(...elevations);

    devices.forEach((d) => {
      if (d.altitude_baro == null) return;
      const color = elevationColor(d.altitude_baro, min, max);
      const marker = L.circleMarker([d.lat, d.lng], {
        radius: 18, fillColor: color, color, weight: 0, fillOpacity: 0.55,
      }).addTo(mapRef.current!);
      marker.bindPopup(`
        <div style="font-family:'DM Sans',sans-serif">
          <strong>${d.device_id}</strong><br/>
          Elevation: <strong>${d.altitude_baro.toFixed(2)}m</strong><br/>
          ${d.neighborhood ? `Area: ${d.neighborhood}` : ""}
        </div>
      `);
      overlayRef.current.push(marker);
    });
  }, [devices, showOverlay]);

  return (
    <div
      ref={containerRef}
      className="flex-1 h-[calc(100vh-140px)] rounded-lg overflow-hidden border border-border-card"
    />
  );
}
