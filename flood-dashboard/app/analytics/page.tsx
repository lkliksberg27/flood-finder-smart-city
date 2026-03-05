"use client";

import { useEffect, useState } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ScatterChart, Scatter, LineChart, Line,
  ResponsiveContainer, Cell,
} from "recharts";
import { getAllDevices, getAllFloodEvents } from "@/lib/queries";
import type { Device, FloodEvent } from "@/lib/types";

const CHART_COLORS = {
  blue: "#3b82f6",
  green: "#34d399",
  amber: "#fbbf24",
  red: "#f87171",
};

export default function AnalyticsPage() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [events, setEvents] = useState<FloodEvent[]>([]);

  useEffect(() => {
    getAllDevices().then(setDevices).catch(console.error);
    getAllFloodEvents(1000).then(setEvents).catch(console.error);
  }, []);

  // 1. Flood events per week (last 6 months)
  const sixMonthsAgo = Date.now() - 180 * 86400 * 1000;
  const weeklyData: Record<string, number> = {};
  events
    .filter((e) => new Date(e.started_at).getTime() > sixMonthsAgo)
    .forEach((e) => {
      const d = new Date(e.started_at);
      const weekStart = new Date(d);
      weekStart.setDate(d.getDate() - d.getDay());
      const key = weekStart.toISOString().slice(0, 10);
      weeklyData[key] = (weeklyData[key] || 0) + 1;
    });
  const weeklyChart = Object.entries(weeklyData)
    .map(([week, count]) => ({ week: week.slice(5), count }))
    .sort((a, b) => a.week.localeCompare(b.week));

  // 2. Top 10 flooding sensors
  const deviceCounts: Record<string, { name: string; count: number }> = {};
  events.forEach((e) => {
    if (!deviceCounts[e.device_id]) {
      const dev = e.devices as Device | undefined;
      deviceCounts[e.device_id] = { name: dev?.name ?? e.device_id, count: 0 };
    }
    deviceCounts[e.device_id].count++;
  });
  const topDevices = Object.entries(deviceCounts)
    .map(([id, v]) => ({ device: v.name || id, count: v.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // 3. Flood depth vs rainfall scatter
  const scatterData = events
    .filter((e) => e.rainfall_mm != null && e.rainfall_mm > 0)
    .map((e) => ({ rainfall: e.rainfall_mm, depth: e.peak_depth_cm }));

  // 4. Flood events by hour of day
  const hourCounts = Array.from({ length: 24 }, (_, i) => ({ hour: `${i}:00`, count: 0 }));
  events.forEach((e) => {
    const h = new Date(e.started_at).getHours();
    hourCounts[h].count++;
  });

  // 5. Battery distribution
  const batteryBuckets = [
    { label: ">3.8V", min: 3.8, max: 5, count: 0, color: CHART_COLORS.green },
    { label: "3.5-3.8V", min: 3.5, max: 3.8, count: 0, color: CHART_COLORS.blue },
    { label: "3.2-3.5V", min: 3.2, max: 3.5, count: 0, color: CHART_COLORS.amber },
    { label: "<3.2V", min: 0, max: 3.2, count: 0, color: CHART_COLORS.red },
  ];
  devices.forEach((d) => {
    const v = d.battery_v ?? 0;
    const bucket = batteryBuckets.find((b) => v >= b.min && v < b.max) ?? batteryBuckets[3];
    bucket.count++;
  });

  return (
    <div>
      <h2 className="text-xl font-semibold mb-6">Analytics & Patterns</h2>

      <div className="grid grid-cols-2 gap-6">
        {/* Weekly flood events */}
        <div className="bg-bg-card border border-border-card rounded-lg p-4">
          <h3 className="text-sm font-semibold mb-4">Flood Events per Week</h3>
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={weeklyChart}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis dataKey="week" tick={{ fill: "#9ca3af", fontSize: 11 }} />
              <YAxis tick={{ fill: "#9ca3af", fontSize: 11 }} />
              <Tooltip contentStyle={{ background: "#111827", border: "1px solid #1f2937", borderRadius: 8 }} />
              <Line type="monotone" dataKey="count" stroke={CHART_COLORS.blue} strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Top flooding sensors */}
        <div className="bg-bg-card border border-border-card rounded-lg p-4">
          <h3 className="text-sm font-semibold mb-4">Most Frequent Flooding Sensors</h3>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={topDevices} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis type="number" tick={{ fill: "#9ca3af", fontSize: 11 }} />
              <YAxis dataKey="device" type="category" width={80} tick={{ fill: "#9ca3af", fontSize: 10 }} />
              <Tooltip contentStyle={{ background: "#111827", border: "1px solid #1f2937", borderRadius: 8 }} />
              <Bar dataKey="count" fill={CHART_COLORS.red} radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Depth vs Rainfall scatter */}
        <div className="bg-bg-card border border-border-card rounded-lg p-4">
          <h3 className="text-sm font-semibold mb-4">Flood Depth vs Rainfall</h3>
          <ResponsiveContainer width="100%" height={250}>
            <ScatterChart>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis dataKey="rainfall" name="Rainfall (mm)" tick={{ fill: "#9ca3af", fontSize: 11 }} />
              <YAxis dataKey="depth" name="Depth (cm)" tick={{ fill: "#9ca3af", fontSize: 11 }} />
              <Tooltip contentStyle={{ background: "#111827", border: "1px solid #1f2937", borderRadius: 8 }} />
              <Scatter data={scatterData} fill={CHART_COLORS.amber} />
            </ScatterChart>
          </ResponsiveContainer>
        </div>

        {/* Events by hour of day */}
        <div className="bg-bg-card border border-border-card rounded-lg p-4">
          <h3 className="text-sm font-semibold mb-4">Flood Events by Time of Day</h3>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={hourCounts}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis dataKey="hour" tick={{ fill: "#9ca3af", fontSize: 10 }} interval={2} />
              <YAxis tick={{ fill: "#9ca3af", fontSize: 11 }} />
              <Tooltip contentStyle={{ background: "#111827", border: "1px solid #1f2937", borderRadius: 8 }} />
              <Bar dataKey="count" fill={CHART_COLORS.blue}>
                {hourCounts.map((entry, i) => (
                  <Cell key={i} fill={entry.count > 5 ? CHART_COLORS.red : CHART_COLORS.blue} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Battery health */}
        <div className="bg-bg-card border border-border-card rounded-lg p-4 col-span-2">
          <h3 className="text-sm font-semibold mb-4">Battery Health Distribution</h3>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={batteryBuckets}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis dataKey="label" tick={{ fill: "#9ca3af", fontSize: 12 }} />
              <YAxis tick={{ fill: "#9ca3af", fontSize: 11 }} />
              <Tooltip contentStyle={{ background: "#111827", border: "1px solid #1f2937", borderRadius: 8 }} />
              <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                {batteryBuckets.map((b, i) => (
                  <Cell key={i} fill={b.color} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
