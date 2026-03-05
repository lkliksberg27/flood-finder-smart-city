"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { getAllFloodEvents, getNeighborhoods } from "@/lib/queries";
import type { FloodEvent, Device } from "@/lib/types";

const DeviceMap = dynamic(
  () => import("@/components/MapContainer").then((m) => m.DeviceMap),
  { ssr: false }
);

export default function FloodEventsPage() {
  const [events, setEvents] = useState<FloodEvent[]>([]);
  const [neighborhoods, setNeighborhoods] = useState<string[]>([]);
  const [filterNeighborhood, setFilterNeighborhood] = useState("");
  const [filterStartDate, setFilterStartDate] = useState("");
  const [filterEndDate, setFilterEndDate] = useState("");
  const [selectedEvent, setSelectedEvent] = useState<FloodEvent | null>(null);

  useEffect(() => {
    getAllFloodEvents(500).then(setEvents).catch(console.error);
    getNeighborhoods().then(setNeighborhoods).catch(console.error);
  }, []);

  const filtered = events.filter((e) => {
    if (filterNeighborhood && (e.devices as Device | undefined)?.neighborhood !== filterNeighborhood) return false;
    if (filterStartDate && e.started_at < filterStartDate) return false;
    if (filterEndDate && e.started_at > filterEndDate) return false;
    return true;
  });

  const thisMonth = events.filter((e) => {
    const d = new Date(e.started_at);
    const now = new Date();
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  });

  const avgDuration = thisMonth.length
    ? Math.round(thisMonth.reduce((s, e) => s + (e.duration_minutes ?? 0), 0) / thisMonth.length)
    : 0;

  // Device with most events this month
  const deviceCounts: Record<string, number> = {};
  thisMonth.forEach((e) => { deviceCounts[e.device_id] = (deviceCounts[e.device_id] || 0) + 1; });
  const worstDevice = Object.entries(deviceCounts).sort((a, b) => b[1] - a[1])[0];

  return (
    <div>
      <h2 className="text-xl font-semibold mb-4">Flood Event History</h2>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-bg-card border border-border-card rounded-lg p-4">
          <p className="text-xs text-text-secondary uppercase">Events This Month</p>
          <p className="text-2xl font-bold text-status-amber mt-1">{thisMonth.length}</p>
        </div>
        <div className="bg-bg-card border border-border-card rounded-lg p-4">
          <p className="text-xs text-text-secondary uppercase">Avg Duration</p>
          <p className="text-2xl font-bold mt-1">{avgDuration} min</p>
        </div>
        <div className="bg-bg-card border border-border-card rounded-lg p-4">
          <p className="text-xs text-text-secondary uppercase">Worst Location</p>
          <p className="text-2xl font-bold text-status-red mt-1">
            {worstDevice ? `${worstDevice[0]} (${worstDevice[1]}x)` : "—"}
          </p>
        </div>
      </div>

      {/* Mini map for selected event */}
      {selectedEvent && selectedEvent.devices && (
        <div className="mb-6 h-[250px] rounded-lg overflow-hidden border border-border-card">
          <DeviceMap
            devices={[selectedEvent.devices as Device]}
            highlightDeviceId={selectedEvent.device_id}
          />
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
        <input
          type="date"
          value={filterStartDate}
          onChange={(e) => setFilterStartDate(e.target.value)}
          className="bg-bg-card border border-border-card rounded px-3 py-1.5 text-sm text-text-primary"
          placeholder="Start date"
        />
        <input
          type="date"
          value={filterEndDate}
          onChange={(e) => setFilterEndDate(e.target.value)}
          className="bg-bg-card border border-border-card rounded px-3 py-1.5 text-sm text-text-primary"
          placeholder="End date"
        />
      </div>

      {/* Events table */}
      <div className="bg-bg-card border border-border-card rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border-card text-text-secondary text-left">
              <th className="px-4 py-3">Device</th>
              <th className="px-4 py-3">Location</th>
              <th className="px-4 py-3">Started</th>
              <th className="px-4 py-3">Ended</th>
              <th className="px-4 py-3">Duration</th>
              <th className="px-4 py-3">Peak Depth</th>
              <th className="px-4 py-3">Rainfall</th>
              <th className="px-4 py-3">Tide</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((e) => {
              const dev = e.devices as Device | undefined;
              return (
                <tr
                  key={e.id}
                  onClick={() => setSelectedEvent(e)}
                  className={`border-b border-border-card cursor-pointer hover:bg-bg-card-hover transition-colors ${
                    selectedEvent?.id === e.id ? "bg-status-blue/10" : ""
                  }`}
                >
                  <td className="px-4 py-3 font-mono text-xs">{e.device_id}</td>
                  <td className="px-4 py-3 text-text-secondary">{dev?.neighborhood ?? "—"}</td>
                  <td className="px-4 py-3">{new Date(e.started_at).toLocaleString()}</td>
                  <td className="px-4 py-3">
                    {e.ended_at ? new Date(e.ended_at).toLocaleString() : (
                      <span className="text-status-red">Ongoing</span>
                    )}
                  </td>
                  <td className="px-4 py-3">{e.duration_minutes ? `${e.duration_minutes} min` : "—"}</td>
                  <td className="px-4 py-3">
                    <span className={
                      e.peak_depth_cm > 30 ? "text-status-red" :
                      e.peak_depth_cm > 10 ? "text-status-amber" : ""
                    }>
                      {e.peak_depth_cm}cm
                    </span>
                  </td>
                  <td className="px-4 py-3">{e.rainfall_mm != null ? `${e.rainfall_mm}mm` : "—"}</td>
                  <td className="px-4 py-3">{e.tide_level_m != null ? `${e.tide_level_m.toFixed(2)}m` : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <p className="text-center text-text-secondary py-8">No flood events found.</p>
        )}
      </div>
    </div>
  );
}
