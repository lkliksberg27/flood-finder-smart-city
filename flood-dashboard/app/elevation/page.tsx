"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { getAllDevices } from "@/lib/queries";
import type { Device } from "@/lib/types";

const ElevationMap = dynamic(
  () => import("@/components/ElevationMap").then((m) => m.ElevationMap),
  { ssr: false }
);

export default function ElevationPage() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [showOverlay, setShowOverlay] = useState(true);

  useEffect(() => {
    getAllDevices().then(setDevices).catch(console.error);
  }, []);

  const sorted = [...devices]
    .filter((d) => d.altitude_baro != null)
    .sort((a, b) => (a.altitude_baro ?? 0) - (b.altitude_baro ?? 0))
    .slice(0, 10);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold">Elevation Map</h2>
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

        <div className="w-[280px]">
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
                {d.neighborhood && (
                  <p className="text-xs text-text-secondary mt-0.5">{d.neighborhood}</p>
                )}
              </div>
            ))}
            {sorted.length === 0 && (
              <p className="text-sm text-text-secondary">No elevation data yet.</p>
            )}
          </div>

          <div className="mt-6 bg-bg-card border border-border-card rounded p-3">
            <p className="text-xs text-text-secondary mb-2">Legend</p>
            <div className="w-full h-3 rounded" style={{
              background: "linear-gradient(to right, #f87171, #fbbf24, #3b82f6)"
            }} />
            <div className="flex justify-between text-xs text-text-secondary mt-1">
              <span>Low</span>
              <span>High</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
