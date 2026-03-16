"use client";

import { useEffect, useState, useMemo } from "react";
import dynamic from "next/dynamic";
import { AlertTriangle, Loader2, Mountain, TrendingDown } from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  ReferenceLine, Cell,
} from "recharts";
import { getAllDevices, getFloodEventCount30d } from "@/lib/queries";
import { streetElevation, findRoadDips } from "@/lib/geo";
import type { Device } from "@/lib/types";

const ElevationMap = dynamic(
  () => import("@/components/ElevationMap").then((m) => m.ElevationMap),
  { ssr: false }
);

const tooltipStyle = {
  background: "#111827",
  border: "1px solid #1f2937",
  borderRadius: 8,
  color: "#f3f4f6",
  fontSize: 12,
};

function elevColor(elev: number): string {
  if (elev < 0) return "#dc2626";
  if (elev < 0.5) return "#f87171";
  if (elev < 1.0) return "#fbbf24";
  return "#34d399";
}

export default function ElevationPage() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [floodCounts, setFloodCounts] = useState<Record<string, number>>({});
  const [showOverlay, setShowOverlay] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      getAllDevices().then(setDevices),
      getFloodEventCount30d().then(setFloodCounts),
    ]).catch(console.error).finally(() => setLoading(false));
  }, []);

  const dips = useMemo(() => findRoadDips(devices, floodCounts), [devices, floodCounts]);

  // Elevation profile data — sorted from lowest to highest
  const profileData = useMemo(() => {
    return devices
      .filter((d) => d.altitude_baro != null)
      .map((d) => ({
        id: d.device_id,
        name: d.name ?? d.device_id,
        neighborhood: d.neighborhood ?? "",
        elevation: parseFloat(streetElevation(d).toFixed(2)),
        floods: floodCounts[d.device_id] ?? 0,
      }))
      .sort((a, b) => a.elevation - b.elevation);
  }, [devices, floodCounts]);

  // Elevation vs flood count scatter data
  const scatterData = useMemo(() => {
    return devices
      .filter((d) => d.altitude_baro != null)
      .map((d) => ({
        id: d.device_id,
        elevation: parseFloat(streetElevation(d).toFixed(2)),
        floods: floodCounts[d.device_id] ?? 0,
      }))
      .sort((a, b) => a.elevation - b.elevation);
  }, [devices, floodCounts]);

  // Summary stats
  const stats = useMemo(() => {
    if (profileData.length === 0) return null;
    const elevs = profileData.map((d) => d.elevation);
    const min = Math.min(...elevs);
    const max = Math.max(...elevs);
    const avg = elevs.reduce((s, e) => s + e, 0) / elevs.length;
    const belowOne = profileData.filter((d) => d.elevation < 1.0).length;
    return { min, max, avg, belowOne, total: profileData.length };
  }, [profileData]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-120px)]">
        <div className="text-center">
          <Loader2 size={32} className="animate-spin text-status-blue mx-auto mb-3" />
          <p className="text-sm text-text-secondary">Loading elevation data...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[calc(100vh-32px)] overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-3 shrink-0">
        <div className="flex items-center gap-3">
          <Mountain size={20} className="text-status-amber" />
          <h2 className="text-xl font-semibold">Elevation & Road Dip Analysis</h2>
        </div>
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

      {/* Summary stats row */}
      {stats && (
        <div className="grid grid-cols-5 gap-2 mb-3 shrink-0">
          <div className="bg-bg-card border border-border-card rounded-lg p-2.5">
            <p className="text-[10px] text-text-secondary uppercase">Lowest</p>
            <p className={`text-lg font-bold ${stats.min < 0.5 ? "text-status-red" : "text-status-amber"}`}>
              {stats.min.toFixed(2)}m
            </p>
          </div>
          <div className="bg-bg-card border border-border-card rounded-lg p-2.5">
            <p className="text-[10px] text-text-secondary uppercase">Average</p>
            <p className="text-lg font-bold">{stats.avg.toFixed(2)}m</p>
          </div>
          <div className="bg-bg-card border border-border-card rounded-lg p-2.5">
            <p className="text-[10px] text-text-secondary uppercase">Highest</p>
            <p className="text-lg font-bold text-status-green">{stats.max.toFixed(2)}m</p>
          </div>
          <div className="bg-bg-card border border-border-card rounded-lg p-2.5">
            <p className="text-[10px] text-text-secondary uppercase">Road Dips</p>
            <p className={`text-lg font-bold ${dips.length > 0 ? "text-status-red" : "text-status-green"}`}>
              {dips.length}
            </p>
          </div>
          <div className="bg-bg-card border border-border-card rounded-lg p-2.5">
            <p className="text-[10px] text-text-secondary uppercase">Below 1m</p>
            <p className={`text-lg font-bold ${stats.belowOne > 0 ? "text-status-amber" : "text-status-green"}`}>
              {stats.belowOne}/{stats.total}
            </p>
          </div>
        </div>
      )}

      {/* Map + Road dips sidebar */}
      <div className="flex gap-3 shrink-0" style={{ minHeight: "340px" }}>
        <div className="flex-1">
          <ElevationMap devices={devices} floodCounts={floodCounts} showOverlay={showOverlay} />
        </div>

        {/* Road dips panel */}
        <div className="w-[260px] bg-bg-card border border-border-card rounded-lg p-3 overflow-y-auto" style={{ maxHeight: "340px" }}>
          <h3 className="text-xs font-semibold mb-2 flex items-center gap-1.5">
            <AlertTriangle size={12} className="text-status-amber" />
            Road Dips
          </h3>
          {dips.length > 0 ? (
            <div className="space-y-2">
              {dips.slice(0, 8).map((d) => (
                <div key={d.device_id} className="border-b border-border-card pb-2 last:border-b-0">
                  <div className="flex justify-between text-xs">
                    <span className="font-mono text-text-secondary">{d.device_id}</span>
                    <span className="font-bold text-status-red">-{d.dipCm}cm</span>
                  </div>
                  <div className="flex justify-between text-[10px] text-text-secondary mt-0.5">
                    <span>{d.neighborhood ?? ""}</span>
                    <span className={d.floodCount > 0 ? "text-status-red" : "text-status-green"}>
                      {d.floodCount} floods
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 bg-bg-primary rounded overflow-hidden">
                    <div
                      className="h-full bg-status-red/60 rounded"
                      style={{ width: `${Math.min(100, d.dipCm * 4)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-text-secondary py-4 text-center">No road dips detected</p>
          )}
        </div>
      </div>

      {/* Elevation Profile + Elevation vs Floods charts */}
      <div className="grid grid-cols-2 gap-3 mt-3 shrink-0 pb-4">
        {/* Elevation Profile */}
        <div className="bg-bg-card border border-border-card rounded-lg p-4">
          <div className="flex items-center gap-2 mb-1">
            <TrendingDown size={14} className="text-status-amber" />
            <h3 className="text-xs font-semibold">Elevation Profile</h3>
          </div>
          <p className="text-[10px] text-text-secondary mb-3">
            All sensors sorted from lowest to highest — red zones are most vulnerable
          </p>
          {profileData.length > 0 ? (
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={profileData} margin={{ top: 4, right: 4, bottom: 4, left: -10 }}>
                <XAxis
                  dataKey="id"
                  tick={{ fill: "#6b7280", fontSize: 8 }}
                  axisLine={false}
                  tickLine={false}
                  angle={-45}
                  textAnchor="end"
                  height={40}
                />
                <YAxis
                  tick={{ fill: "#6b7280", fontSize: 9 }}
                  axisLine={false}
                  tickLine={false}
                  unit="m"
                />
                <ReferenceLine y={1.0} stroke="#fbbf24" strokeDasharray="4 4" label={{ value: "1.0m", fill: "#fbbf24", fontSize: 9, position: "right" }} />
                <Tooltip
                  contentStyle={tooltipStyle}
                  formatter={(v) => [`${v}m`, "Elevation"]}
                  labelFormatter={(label) => {
                    const d = profileData.find((p) => p.id === label);
                    return d ? `${d.id} — ${d.name}` : String(label);
                  }}
                />
                <Bar dataKey="elevation" name="Elevation" radius={[2, 2, 0, 0]}>
                  {profileData.map((entry, i) => (
                    <Cell key={i} fill={elevColor(entry.elevation)} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-xs text-text-secondary py-12 text-center">No elevation data</p>
          )}
        </div>

        {/* Elevation vs Flood Count */}
        <div className="bg-bg-card border border-border-card rounded-lg p-4">
          <div className="flex items-center gap-2 mb-1">
            <AlertTriangle size={14} className="text-status-red" />
            <h3 className="text-xs font-semibold">Elevation vs Flood Frequency</h3>
          </div>
          <p className="text-[10px] text-text-secondary mb-3">
            Lower elevation sensors should flood more — if not, drainage is the issue
          </p>
          {scatterData.length > 0 ? (
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={scatterData} margin={{ top: 4, right: 4, bottom: 4, left: -10 }}>
                <XAxis
                  dataKey="id"
                  tick={{ fill: "#6b7280", fontSize: 8 }}
                  axisLine={false}
                  tickLine={false}
                  angle={-45}
                  textAnchor="end"
                  height={40}
                />
                <YAxis
                  tick={{ fill: "#6b7280", fontSize: 9 }}
                  axisLine={false}
                  tickLine={false}
                  allowDecimals={false}
                />
                <Tooltip
                  contentStyle={tooltipStyle}
                  labelFormatter={(label) => {
                    const d = scatterData.find((p) => p.id === label);
                    return d ? `${d.id} (${d.elevation}m)` : String(label);
                  }}
                />
                <Bar dataKey="floods" name="Floods (30d)" radius={[2, 2, 0, 0]}>
                  {scatterData.map((entry, i) => (
                    <Cell key={i} fill={entry.floods > 3 ? "#f87171" : entry.floods > 0 ? "#fbbf24" : "#1f2937"} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-xs text-text-secondary py-12 text-center">No data</p>
          )}
        </div>
      </div>
    </div>
  );
}
