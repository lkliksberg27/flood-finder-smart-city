"use client";

import { useEffect, useRef, useCallback } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { Device } from "@/lib/types";
import { getReadings24h } from "@/lib/queries";
import { getSupabase } from "@/lib/supabase";

const STATUS_COLORS: Record<string, string> = {
  online: "#34d399",
  alert: "#f87171",
  offline: "#6b7280",
};

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

  // Fill area under curve
  const firstX = 0;
  const lastX = (values.length - 1) / (values.length - 1) * w;
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
}

export function DeviceMap({ devices, onDeviceClick, highlightDeviceId, height = "100%" }: Props) {
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<L.Layer[]>([]);
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

  const loadPopupData = useCallback(async (deviceId: string, popup: L.Popup) => {
    try {
      // Fetch 24h readings and recent flood events in parallel
      const [readings, floodRes] = await Promise.all([
        getReadings24h(deviceId),
        getSupabase()
          .from("flood_events")
          .select("started_at, peak_depth_cm, duration_minutes, rainfall_mm, tide_level_m")
          .eq("device_id", deviceId)
          .order("started_at", { ascending: false })
          .limit(5),
      ]);

      const container = popup.getElement()?.querySelector(`[data-popup-data="${deviceId}"]`);
      if (!container) return;

      let html = "";

      // Distance + flood depth sparklines
      if (readings.length >= 2) {
        const distances = readings.map((r) => r.distance_cm ?? 0);
        html += buildSparklineSVG(distances, "#3b82f6", "24h Distance (cm)");

        // Show flood depth sparkline if any flooding detected
        const floodDepths = readings.map((r) => (r as { flood_depth_cm?: number }).flood_depth_cm ?? 0);
        if (floodDepths.some((d) => d > 0)) {
          html += buildSparklineSVG(floodDepths, "#f87171", "24h Flood Depth (cm)");
        }
      }

      // Recent flood events
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

  useEffect(() => {
    if (!mapRef.current) return;

    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];

    devices.forEach((device) => {
      const color = STATUS_COLORS[device.status] ?? "#6b7280";
      const isAlert = device.status === "alert";
      const isHighlighted = device.device_id === highlightDeviceId;

      // Add a larger semi-transparent ring for alert sensors
      if (isAlert) {
        const ring = L.circleMarker([device.lat, device.lng], {
          radius: 18,
          fillColor: "#f87171",
          color: "transparent",
          fillOpacity: 0.15,
        }).addTo(mapRef.current!);
        markersRef.current.push(ring);
      }

      const marker = L.circleMarker([device.lat, device.lng], {
        radius: isHighlighted ? 12 : isAlert ? 10 : 7,
        fillColor: color,
        color: isHighlighted ? "#ffffff" : color,
        weight: isHighlighted ? 3 : 1,
        fillOpacity: 0.85,
        className: isAlert ? "marker-alert" : "",
      }).addTo(mapRef.current!);

      // Time since last seen
      const lastSeenText = device.last_seen
        ? (() => {
            const ms = Date.now() - new Date(device.last_seen).getTime();
            if (ms < 60000) return "just now";
            if (ms < 3600000) return `${Math.round(ms / 60000)}m ago`;
            if (ms < 86400000) return `${Math.round(ms / 3600000)}h ago`;
            return `${Math.round(ms / 86400000)}d ago`;
          })()
        : "never";

      // Battery bar color
      const battV = device.battery_v ?? 0;
      const battPct = Math.max(0, Math.min(100, ((battV - 2.8) / 1.4) * 100));
      const battColor = battPct > 60 ? "#34d399" : battPct > 25 ? "#fbbf24" : "#f87171";

      const popup = L.popup({ maxWidth: 260 }).setContent(`
        <div style="font-family:'DM Sans',sans-serif;min-width:220px">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <strong style="font-size:14px">${device.device_id}</strong>
            <span style="font-size:10px;color:${color};background:${color}22;padding:1px 6px;border-radius:4px;font-weight:600">${device.status.toUpperCase()}</span>
          </div>
          ${device.name ? `<div style="color:#9ca3af;font-size:12px;margin-top:2px">${device.name}</div>` : ""}

          <hr style="border-color:#1f2937;margin:8px 0"/>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:11px">
            <div>
              <span style="color:#6b7280">Elevation</span><br/>
              <span style="font-weight:600">${device.altitude_baro?.toFixed(2) ?? "—"}m</span>
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
                <span style="font-size:10px;font-weight:600">${battV.toFixed(1)}V</span>
              </div>
            </div>
            ${device.neighborhood ? `<div>
              <span style="color:#6b7280">Area</span><br/>
              <span style="font-weight:600">${device.neighborhood}</span>
            </div>` : ""}
          </div>

          <div data-popup-data="${device.device_id}" style="margin-top:4px">
            <div style="font-size:10px;color:#6b7280;margin-top:6px;display:flex;align-items:center;gap:4px">
              <div style="width:12px;height:12px;border:2px solid #3b82f6;border-top-color:transparent;border-radius:50%;animation:spin 1s linear infinite"></div>
              Loading data...
            </div>
          </div>
        </div>
        <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
      `);

      marker.bindPopup(popup);

      marker.on("popupopen", () => {
        loadPopupData(device.device_id, popup);
      });

      marker.on("click", () => onDeviceClick?.(device));
      markersRef.current.push(marker);
    });

    // Fit bounds if we have devices and map is at default
    if (devices.length > 0 && mapRef.current.getZoom() === 14) {
      const bounds = L.latLngBounds(devices.map((d) => [d.lat, d.lng]));
      if (bounds.isValid()) {
        mapRef.current.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
      }
    }
  }, [devices, onDeviceClick, highlightDeviceId, loadPopupData]);

  return <div ref={containerRef} style={{ height, width: "100%", borderRadius: "8px" }} />;
}
