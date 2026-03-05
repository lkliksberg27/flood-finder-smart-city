"use client";

import { useEffect, useState } from "react";
import { Download, ChevronDown, ChevronUp } from "lucide-react";
import { getAllDevices, getLatestReadings, getNeighborhoods, getFloodEventCount30d } from "@/lib/queries";
import type { Device, SensorReading } from "@/lib/types";

export default function SensorsPage() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [neighborhoods, setNeighborhoods] = useState<string[]>([]);
  const [floodCounts, setFloodCounts] = useState<Record<string, number>>({});
  const [filterNeighborhood, setFilterNeighborhood] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [filterLowBattery, setFilterLowBattery] = useState(false);
  const [sortCol, setSortCol] = useState<string>("device_id");
  const [sortAsc, setSortAsc] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedReadings, setExpandedReadings] = useState<SensorReading[]>([]);

  useEffect(() => {
    getAllDevices().then(setDevices).catch(console.error);
    getNeighborhoods().then(setNeighborhoods).catch(console.error);
    getFloodEventCount30d().then(setFloodCounts).catch(console.error);
  }, []);

  const toggleSort = (col: string) => {
    if (sortCol === col) setSortAsc(!sortAsc);
    else { setSortCol(col); setSortAsc(true); }
  };

  const handleExpand = async (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    try {
      const readings = await getLatestReadings(id, 10);
      setExpandedReadings(readings);
    } catch (err) {
      console.error("Failed to load readings:", err);
    }
  };

  const isOffline = (d: Device) => {
    if (!d.last_seen) return true;
    return Date.now() - new Date(d.last_seen).getTime() > 2 * 3600 * 1000;
  };

  let filtered = devices.filter((d) => {
    if (filterNeighborhood && d.neighborhood !== filterNeighborhood) return false;
    if (filterStatus && d.status !== filterStatus) return false;
    if (filterLowBattery && (d.battery_v ?? 4) >= 3.3) return false;
    return true;
  });

  filtered.sort((a, b) => {
    let av: string | number | null, bv: string | number | null;
    if (sortCol === "flood_events_30d") {
      av = floodCounts[a.device_id] ?? 0;
      bv = floodCounts[b.device_id] ?? 0;
    } else {
      av = a[sortCol as keyof Device] as string | number | null ?? "";
      bv = b[sortCol as keyof Device] as string | number | null ?? "";
    }
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return sortAsc ? cmp : -cmp;
  });

  const exportCSV = () => {
    window.open("/api/export/sensors", "_blank");
  };

  const SortIcon = ({ col }: { col: string }) =>
    sortCol === col ? (sortAsc ? <ChevronUp size={14} /> : <ChevronDown size={14} />) : null;

  const columns: [string, string][] = [
    ["device_id", "Device ID"],
    ["name", "Name"],
    ["neighborhood", "Neighborhood"],
    ["status", "Status"],
    ["battery_v", "Battery"],
    ["last_seen", "Last Seen"],
    ["altitude_baro", "Elevation"],
    ["flood_events_30d", "Floods (30d)"],
  ];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold">Sensor Management</h2>
        <button
          onClick={exportCSV}
          className="flex items-center gap-2 px-4 py-2 bg-status-blue/20 text-status-blue rounded-lg hover:bg-status-blue/30 transition-colors text-sm"
        >
          <Download size={16} /> Export CSV
        </button>
      </div>

      {/* Fleet summary */}
      {devices.length > 0 && (
        <div className="grid grid-cols-5 gap-4 mb-6">
          <div className="bg-bg-card border border-border-card rounded-lg p-4">
            <p className="text-xs text-text-secondary uppercase">Total Sensors</p>
            <p className="text-2xl font-bold mt-1">{devices.length}</p>
          </div>
          <div className="bg-bg-card border border-border-card rounded-lg p-4">
            <p className="text-xs text-text-secondary uppercase">Online</p>
            <p className="text-2xl font-bold text-status-green mt-1">
              {devices.filter((d) => d.status === "online").length}
            </p>
          </div>
          <div className="bg-bg-card border border-border-card rounded-lg p-4">
            <p className="text-xs text-text-secondary uppercase">Alerting</p>
            <p className="text-2xl font-bold text-status-red mt-1">
              {devices.filter((d) => d.status === "alert").length}
            </p>
          </div>
          <div className="bg-bg-card border border-border-card rounded-lg p-4">
            <p className="text-xs text-text-secondary uppercase">Low Battery</p>
            <p className="text-2xl font-bold text-status-amber mt-1">
              {devices.filter((d) => (d.battery_v ?? 4) < 3.3).length}
            </p>
          </div>
          <div className="bg-bg-card border border-border-card rounded-lg p-4">
            <p className="text-xs text-text-secondary uppercase">Neighborhoods</p>
            <p className="text-2xl font-bold text-status-blue mt-1">{neighborhoods.length}</p>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-3 mb-4">
        <select
          value={filterNeighborhood}
          onChange={(e) => setFilterNeighborhood(e.target.value)}
          className="bg-bg-card border border-border-card rounded px-3 py-1.5 text-sm text-text-primary"
        >
          <option value="">All Neighborhoods</option>
          {neighborhoods.map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="bg-bg-card border border-border-card rounded px-3 py-1.5 text-sm text-text-primary"
        >
          <option value="">All Statuses</option>
          <option value="online">Online</option>
          <option value="offline">Offline</option>
          <option value="alert">Alert</option>
        </select>
        <label className="flex items-center gap-2 text-sm text-text-secondary">
          <input
            type="checkbox"
            checked={filterLowBattery}
            onChange={(e) => setFilterLowBattery(e.target.checked)}
            className="accent-status-amber"
          />
          Low Battery (&lt;20%)
        </label>
      </div>

      {/* Table */}
      <div className="bg-bg-card border border-border-card rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border-card text-text-secondary text-left">
              {columns.map(([col, label]) => (
                <th
                  key={col}
                  className="px-4 py-3 cursor-pointer hover:text-text-primary select-none"
                  onClick={() => toggleSort(col)}
                >
                  <span className="flex items-center gap-1">
                    {label} <SortIcon col={col} />
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.flatMap((d) => {
              const mainRow = (
                <tr
                  key={d.device_id}
                  onClick={() => handleExpand(d.device_id)}
                  className={`border-b border-border-card cursor-pointer transition-colors hover:bg-bg-card-hover ${
                    isOffline(d) ? "bg-status-red/5" : ""
                  }`}
                >
                  <td className="px-4 py-3 font-mono text-xs">{d.device_id}</td>
                  <td className="px-4 py-3">{d.name ?? "—"}</td>
                  <td className="px-4 py-3">{d.neighborhood ?? "—"}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                      d.status === "online" ? "bg-status-green/20 text-status-green" :
                      d.status === "alert" ? "bg-status-red/20 text-status-red" :
                      "bg-gray-500/20 text-gray-400"
                    }`}>
                      {d.status.toUpperCase()}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={
                      (d.battery_v ?? 4) < 3.3 ? "text-status-amber" : ""
                    }>
                      {d.battery_v?.toFixed(1) ?? "—"}V
                    </span>
                  </td>
                  <td className="px-4 py-3 text-text-secondary text-xs">
                    {d.last_seen ? new Date(d.last_seen).toLocaleString() : "Never"}
                  </td>
                  <td className="px-4 py-3">{d.altitude_baro?.toFixed(1) ?? "—"}m</td>
                  <td className="px-4 py-3">
                    <span className={
                      (floodCounts[d.device_id] ?? 0) > 5 ? "text-status-red font-medium" :
                      (floodCounts[d.device_id] ?? 0) > 0 ? "text-status-amber" : ""
                    }>
                      {floodCounts[d.device_id] ?? 0}
                    </span>
                  </td>
                </tr>
              );

              if (expandedId !== d.device_id) return [mainRow];

              // Build mini sparkline from readings
              const sparklineValues = expandedReadings.map((r) => r.distance_cm ?? 0).reverse();
              const sparklineSvg = sparklineValues.length >= 2 ? (() => {
                const w = 200, h = 30;
                const min = Math.min(...sparklineValues);
                const max = Math.max(...sparklineValues);
                const range = max - min || 1;
                const points = sparklineValues.map((v, i) => {
                  const x = (i / (sparklineValues.length - 1)) * w;
                  const y = h - ((v - min) / range) * (h - 4) - 2;
                  return `${x},${y}`;
                }).join(" ");
                return (
                  <svg width={w} height={h} className="block">
                    <polyline points={points} fill="none" stroke="#3b82f6" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                );
              })() : null;

              const expandRow = (
                <tr key={`${d.device_id}-expand`}>
                  <td colSpan={8} className="px-4 py-4 bg-bg-primary">
                    <div className="flex gap-6">
                      <div className="flex-1">
                        <p className="text-xs text-text-secondary mb-2">Last 10 Readings</p>
                        <div className="grid grid-cols-5 gap-2 text-xs font-mono">
                          <span className="text-text-secondary">Time</span>
                          <span className="text-text-secondary">Distance</span>
                          <span className="text-text-secondary">Flood Depth</span>
                          <span className="text-text-secondary">Battery</span>
                          <span className="text-text-secondary">RSSI</span>
                          {expandedReadings.map((r) => [
                            <span key={`${r.id}-t`}>{new Date(r.recorded_at).toLocaleTimeString()}</span>,
                            <span key={`${r.id}-d`}>{r.distance_cm}cm</span>,
                            <span key={`${r.id}-f`} className={r.flood_depth_cm > 0 ? "text-status-red" : ""}>
                              {r.flood_depth_cm}cm
                            </span>,
                            <span key={`${r.id}-b`}>{r.battery_v?.toFixed(1)}V</span>,
                            <span key={`${r.id}-r`}>{r.rssi}dBm</span>,
                          ])}
                        </div>
                      </div>
                      <div className="w-[220px] space-y-3">
                        {sparklineSvg && (
                          <div>
                            <p className="text-xs text-text-secondary mb-1">Distance Trend</p>
                            {sparklineSvg}
                          </div>
                        )}
                        <div className="grid grid-cols-2 gap-2 text-xs">
                          <div className="bg-bg-card rounded p-2">
                            <p className="text-text-secondary">Elevation</p>
                            <p className="font-medium">{d.altitude_baro?.toFixed(2) ?? "—"}m</p>
                          </div>
                          <div className="bg-bg-card rounded p-2">
                            <p className="text-text-secondary">Floods/30d</p>
                            <p className={`font-medium ${(floodCounts[d.device_id] ?? 0) > 3 ? "text-status-red" : ""}`}>
                              {floodCounts[d.device_id] ?? 0}
                            </p>
                          </div>
                          <div className="bg-bg-card rounded p-2">
                            <p className="text-text-secondary">Coordinates</p>
                            <p className="font-mono text-[10px]">{d.lat.toFixed(4)}, {d.lng.toFixed(4)}</p>
                          </div>
                          <div className="bg-bg-card rounded p-2">
                            <p className="text-text-secondary">Installed</p>
                            <p className="font-medium">{d.installed_at ? new Date(d.installed_at).toLocaleDateString() : "—"}</p>
                          </div>
                        </div>
                      </div>
                    </div>
                  </td>
                </tr>
              );

              return [mainRow, expandRow];
            })}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <p className="text-center text-text-secondary py-8">No sensors match filters.</p>
        )}
      </div>
    </div>
  );
}
