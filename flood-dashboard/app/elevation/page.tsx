"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { AlertTriangle } from "lucide-react";
import { getAllDevices, getFloodEventCount30d } from "@/lib/queries";
import type { Device } from "@/lib/types";

const ElevationMap = dynamic(
  () => import("@/components/ElevationMap").then((m) => m.ElevationMap),
  { ssr: false }
);

interface DipAnalysis {
  device_id: string;
  name: string | null;
  neighborhood: string | null;
  elevation_m: number;
  avg_neighbor_elevation_m: number;
  depth_below_neighbors_cm: number;
  flood_count_30d: number;
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

function analyzeRoadDips(devices: Device[], floodCounts: Record<string, number>): DipAnalysis[] {
  const withElev = devices.filter((d) => d.altitude_baro != null);
  if (withElev.length < 3) return [];

  return withElev.map((d) => {
    const neighbors = withElev
      .filter((n) => n.device_id !== d.device_id)
      .map((n) => ({ ...n, dist: haversineKm(d.lat, d.lng, n.lat, n.lng) }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 3);

    const avgNeighborElev = neighbors.reduce((s, n) => s + (n.altitude_baro ?? 0), 0) / neighbors.length;
    const diff = (d.altitude_baro ?? 0) - avgNeighborElev;

    return {
      device_id: d.device_id,
      name: d.name,
      neighborhood: d.neighborhood,
      elevation_m: d.altitude_baro ?? 0,
      avg_neighbor_elevation_m: parseFloat(avgNeighborElev.toFixed(2)),
      depth_below_neighbors_cm: Math.round(-diff * 100),
      flood_count_30d: floodCounts[d.device_id] ?? 0,
    };
  })
    .filter((d) => d.depth_below_neighbors_cm > 10) // At least 10cm lower
    .sort((a, b) => b.depth_below_neighbors_cm - a.depth_below_neighbors_cm);
}

export default function ElevationPage() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [floodCounts, setFloodCounts] = useState<Record<string, number>>({});
  const [showOverlay, setShowOverlay] = useState(true);

  useEffect(() => {
    getAllDevices().then(setDevices).catch(console.error);
    getFloodEventCount30d().then(setFloodCounts).catch(console.error);
  }, []);

  const sorted = [...devices]
    .filter((d) => d.altitude_baro != null)
    .sort((a, b) => (a.altitude_baro ?? 0) - (b.altitude_baro ?? 0))
    .slice(0, 10);

  const dips = analyzeRoadDips(devices, floodCounts);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold">Elevation & Road Dip Analysis</h2>
        <label className="flex items-center gap-2 text-sm text-text-secondary">
          <input
            type="checkbox"
            checked={showOverlay}
            onChange={(e) => setShowOverlay(e.target.checked)}
            className="accent-status-blue"
          />
          Show elevation overlay
        </label>
      </div>

      <div className="flex gap-6">
        <ElevationMap devices={devices} showOverlay={showOverlay} />

        <div className="w-[320px] space-y-6 overflow-y-auto max-h-[calc(100vh-140px)]">
          {/* Road dips section */}
          {dips.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                <AlertTriangle size={14} className="text-status-amber" />
                Detected Road Dips
              </h3>
              <p className="text-xs text-text-secondary mb-3">
                Sensors sitting lower than their neighbors — water naturally pools here.
              </p>
              <div className="space-y-2">
                {dips.slice(0, 8).map((d) => (
                  <div key={d.device_id} className="bg-bg-card border border-border-card rounded p-3">
                    <div className="flex justify-between items-center">
                      <span className="text-sm font-mono">{d.device_id}</span>
                      <span className="text-sm font-bold text-status-red">
                        -{d.depth_below_neighbors_cm}cm
                      </span>
                    </div>
                    <div className="flex justify-between mt-1">
                      <span className="text-xs text-text-secondary">
                        {d.name ?? d.neighborhood ?? ""}
                      </span>
                      <span className={`text-xs font-medium ${
                        d.flood_count_30d > 3 ? "text-status-red" :
                        d.flood_count_30d > 0 ? "text-status-amber" : "text-status-green"
                      }`}>
                        {d.flood_count_30d} floods/30d
                      </span>
                    </div>
                    <div className="mt-2 flex gap-2 text-xs text-text-secondary">
                      <span>Elev: {d.elevation_m.toFixed(2)}m</span>
                      <span>Avg neighbors: {d.avg_neighbor_elevation_m}m</span>
                    </div>
                    {/* Visual dip indicator */}
                    <div className="mt-2 h-2 bg-bg-primary rounded overflow-hidden">
                      <div
                        className="h-full bg-status-red/60 rounded"
                        style={{ width: `${Math.min(100, d.depth_below_neighbors_cm / 0.5)}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Lowest locations */}
          <div>
            <h3 className="text-sm font-semibold mb-3">Lowest 10 Locations</h3>
            <div className="space-y-2">
              {sorted.map((d, i) => (
                <div key={d.device_id} className="bg-bg-card border border-border-card rounded p-3">
                  <div className="flex justify-between items-center">
                    <span className="text-sm font-mono">
                      <span className="text-text-secondary mr-2">#{i + 1}</span>
                      {d.device_id}
                    </span>
                    <span className={`text-sm font-bold ${
                      (d.altitude_baro ?? 0) < 1 ? "text-status-red" : "text-status-amber"
                    }`}>
                      {d.altitude_baro?.toFixed(2)}m
                    </span>
                  </div>
                  <div className="flex justify-between mt-0.5">
                    {d.neighborhood && (
                      <p className="text-xs text-text-secondary">{d.neighborhood}</p>
                    )}
                    <span className="text-xs text-text-secondary">
                      {floodCounts[d.device_id] ?? 0} floods
                    </span>
                  </div>
                </div>
              ))}
              {sorted.length === 0 && (
                <p className="text-sm text-text-secondary">No elevation data yet.</p>
              )}
            </div>
          </div>

          {/* Legend */}
          <div className="bg-bg-card border border-border-card rounded p-3">
            <p className="text-xs text-text-secondary mb-2">Elevation Legend</p>
            <div className="w-full h-3 rounded" style={{
              background: "linear-gradient(to right, #f87171, #fbbf24, #3b82f6)"
            }} />
            <div className="flex justify-between text-xs text-text-secondary mt-1">
              <span>Low (flood risk)</span>
              <span>High (safe)</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
