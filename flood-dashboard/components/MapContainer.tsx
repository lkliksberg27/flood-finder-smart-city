"use client";

import { useEffect, useRef, useCallback } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { Device } from "@/lib/types";
import { getReadings24h } from "@/lib/queries";

const STATUS_COLORS: Record<string, string> = {
  online: "#34d399",
  alert: "#f87171",
  offline: "#6b7280",
};

function buildSparklineSVG(values: number[]): string {
  if (values.length < 2) return "";
  const w = 160, h = 36;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const points = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - ((v - min) / range) * (h - 4) - 2;
    return `${x},${y}`;
  }).join(" ");
  return `<svg width="${w}" height="${h}" style="display:block;margin-top:6px">
    <polyline points="${points}" fill="none" stroke="#3b82f6" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

interface Props {
  devices: Device[];
  onDeviceClick?: (device: Device) => void;
  highlightDeviceId?: string | null;
  height?: string;
}

export function DeviceMap({ devices, onDeviceClick, highlightDeviceId, height = "100%" }: Props) {
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<L.CircleMarker[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    mapRef.current = L.map(containerRef.current, {
      center: [25.9565, -80.1392],
      zoom: 14,
      zoomControl: true,
    });

    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      attribution: '&copy; <a href="https://carto.com/">CARTO</a>',
      maxZoom: 19,
    }).addTo(mapRef.current);

    return () => {
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  const loadSparkline = useCallback(async (deviceId: string, popup: L.Popup) => {
    try {
      const readings = await getReadings24h(deviceId);
      if (readings.length < 2) return;
      const values = readings.map((r) => r.distance_cm ?? 0);
      const container = popup.getElement()?.querySelector(`[data-sparkline="${deviceId}"]`);
      if (container) {
        container.innerHTML = `
          <p style="font-size:10px;color:#9ca3af;margin:6px 0 2px">24h Distance (cm)</p>
          ${buildSparklineSVG(values)}
        `;
      }
    } catch {
      // sparkline is optional, fail silently
    }
  }, []);

  useEffect(() => {
    if (!mapRef.current) return;

    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];

    devices.forEach((device) => {
      const color = STATUS_COLORS[device.status] ?? "#6b7280";
      const isAlert = device.status === "alert";
      const isHighlighted = device.device_id === highlightDeviceId;

      const marker = L.circleMarker([device.lat, device.lng], {
        radius: isHighlighted ? 12 : isAlert ? 10 : 7,
        fillColor: color,
        color: isHighlighted ? "#ffffff" : color,
        weight: isHighlighted ? 3 : 1,
        fillOpacity: 0.85,
        className: isAlert ? "marker-alert" : "",
      }).addTo(mapRef.current!);

      const popup = L.popup().setContent(`
        <div style="font-family: 'DM Sans', sans-serif; min-width: 180px;">
          <strong>${device.device_id}</strong>
          ${device.name ? `<br/><span style="color:#9ca3af">${device.name}</span>` : ""}
          <hr style="border-color:#374151; margin:6px 0"/>
          <div style="font-size:12px">
            <div>Status: <span style="color:${color}">${device.status.toUpperCase()}</span></div>
            <div>Battery: ${device.battery_v?.toFixed(1) ?? "N/A"}V</div>
            <div>Elevation: ${device.altitude_baro?.toFixed(1) ?? "N/A"}m</div>
            ${device.neighborhood ? `<div>Area: ${device.neighborhood}</div>` : ""}
            ${device.last_seen ? `<div>Seen: ${new Date(device.last_seen).toLocaleTimeString()}</div>` : ""}
          </div>
          <div data-sparkline="${device.device_id}">
            <p style="font-size:10px;color:#6b7280;margin-top:6px">Loading sparkline...</p>
          </div>
        </div>
      `);

      marker.bindPopup(popup);

      marker.on("popupopen", () => {
        loadSparkline(device.device_id, popup);
      });

      marker.on("click", () => onDeviceClick?.(device));
      markersRef.current.push(marker);
    });
  }, [devices, onDeviceClick, highlightDeviceId, loadSparkline]);

  return <div ref={containerRef} style={{ height, width: "100%", borderRadius: "8px" }} />;
}
