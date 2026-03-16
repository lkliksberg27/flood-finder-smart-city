"use client";

import { useMemo } from "react";
import {
  BarChart, Bar, LineChart, Line,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";
import { TrendingUp, MapPin, AlertTriangle } from "lucide-react";
import type { FloodEvent, Device } from "@/lib/types";

const tooltipStyle = {
  background: "#111827",
  border: "1px solid #1f2937",
  borderRadius: 8,
  color: "#f3f4f6",
  fontSize: 12,
};

interface Props {
  events: FloodEvent[];
  neighborhood: string; // "" = all
}

export function OverallTrends({ events, neighborhood }: Props) {
  // ── Weekly trend ──
  const weeklyData = useMemo(() => {
    const weeks: Record<string, number> = {};
    for (const e of events) {
      const d = new Date(e.started_at);
      const weekStart = new Date(d);
      weekStart.setDate(d.getDate() - d.getDay());
      const key = weekStart.toISOString().slice(0, 10);
      weeks[key] = (weeks[key] || 0) + 1;
    }
    return Object.entries(weeks)
      .map(([week, count]) => ({
        week: new Date(week + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        count,
      }))
      .sort((a, b) => a.week.localeCompare(b.week));
  }, [events]);

  // ── Neighborhood comparison ──
  const neighborhoodData = useMemo(() => {
    const map: Record<string, { events: number; avgDepth: number; compound: number }> = {};
    for (const e of events) {
      const dev = e.devices as Device | undefined;
      const n = dev?.neighborhood ?? "Other";
      if (!map[n]) map[n] = { events: 0, avgDepth: 0, compound: 0 };
      map[n].events++;
      map[n].avgDepth += e.peak_depth_cm;
      if ((e.rainfall_mm ?? 0) > 0 && (e.tide_level_m ?? 0) > 0.3) map[n].compound++;
    }
    return Object.entries(map)
      .map(([name, v]) => ({
        name,
        events: v.events,
        avgDepth: Math.round(v.avgDepth / v.events),
        compound: v.compound,
      }))
      .sort((a, b) => b.events - a.events);
  }, [events]);

  // ── Top flooding sensors ──
  const topSensors = useMemo(() => {
    const map: Record<string, { name: string; count: number; maxDepth: number }> = {};
    for (const e of events) {
      const dev = e.devices as Device | undefined;
      if (!map[e.device_id]) {
        map[e.device_id] = { name: dev?.name ?? e.device_id, count: 0, maxDepth: 0 };
      }
      map[e.device_id].count++;
      map[e.device_id].maxDepth = Math.max(map[e.device_id].maxDepth, e.peak_depth_cm);
    }
    return Object.entries(map)
      .map(([id, v]) => ({ id, ...v }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
  }, [events]);

  // ── Summary stats ──
  const stats = useMemo(() => {
    const total = events.length;
    if (total === 0) return null;
    const avgDepth = Math.round(events.reduce((s, e) => s + e.peak_depth_cm, 0) / total);
    const maxDepth = Math.max(...events.map((e) => e.peak_depth_cm));
    const compound = events.filter((e) => (e.rainfall_mm ?? 0) > 0 && (e.tide_level_m ?? 0) > 0.3).length;
    const compoundPct = Math.round((compound / total) * 100);
    const avgDuration = Math.round(events.reduce((s, e) => s + (e.duration_minutes ?? 0), 0) / total);
    return { total, avgDepth, maxDepth, compound, compoundPct, avgDuration };
  }, [events]);

  const label = neighborhood || "All Neighborhoods";

  return (
    <div>
      {/* Section header */}
      <div className="flex items-center gap-2 mb-3">
        <TrendingUp size={16} className="text-status-amber" />
        <h3 className="text-sm font-semibold">Overall Trends</h3>
        <span className="text-xs text-text-secondary">— {label} (90 days)</span>
      </div>

      {/* Summary stat cards */}
      {stats && (
        <div className="grid grid-cols-5 gap-2 mb-3">
          <div className="bg-bg-card border border-border-card rounded-lg p-2.5">
            <p className="text-[10px] text-text-secondary uppercase">Total Events</p>
            <p className="text-lg font-bold text-status-blue">{stats.total}</p>
          </div>
          <div className="bg-bg-card border border-border-card rounded-lg p-2.5">
            <p className="text-[10px] text-text-secondary uppercase">Avg Depth</p>
            <p className="text-lg font-bold text-status-amber">{stats.avgDepth}cm</p>
          </div>
          <div className="bg-bg-card border border-border-card rounded-lg p-2.5">
            <p className="text-[10px] text-text-secondary uppercase">Worst Flood</p>
            <p className="text-lg font-bold text-status-red">{stats.maxDepth}cm</p>
          </div>
          <div className="bg-bg-card border border-border-card rounded-lg p-2.5">
            <p className="text-[10px] text-text-secondary uppercase">Avg Duration</p>
            <p className="text-lg font-bold">{stats.avgDuration} min</p>
          </div>
          <div className="bg-bg-card border border-border-card rounded-lg p-2.5">
            <p className="text-[10px] text-text-secondary uppercase">Compound</p>
            <p className="text-lg font-bold text-status-red">{stats.compoundPct}%</p>
          </div>
        </div>
      )}

      {/* Charts row */}
      <div className="grid grid-cols-3 gap-3">
        {/* Weekly trend */}
        <div className="bg-bg-card border border-border-card rounded-lg p-3">
          <p className="text-xs font-semibold text-text-primary mb-2">Weekly Trend</p>
          {weeklyData.length > 0 ? (
            <ResponsiveContainer width="100%" height={130}>
              <LineChart data={weeklyData} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                <XAxis dataKey="week" tick={{ fill: "#6b7280", fontSize: 9 }} axisLine={false} tickLine={false} interval={Math.max(0, weeklyData.length - 4)} />
                <YAxis tick={{ fill: "#6b7280", fontSize: 9 }} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip contentStyle={tooltipStyle} />
                <Line type="monotone" dataKey="count" stroke="#3b82f6" strokeWidth={2} dot={{ r: 3, fill: "#3b82f6" }} name="Events" />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-xs text-text-secondary py-12 text-center">No trend data</p>
          )}
        </div>

        {/* Neighborhood comparison */}
        <div className="bg-bg-card border border-border-card rounded-lg p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <MapPin size={12} className="text-status-blue" />
            <p className="text-xs font-semibold text-text-primary">By Neighborhood</p>
          </div>
          {neighborhoodData.length > 0 ? (
            <ResponsiveContainer width="100%" height={130}>
              <BarChart data={neighborhoodData} layout="vertical" margin={{ top: 0, right: 4, bottom: 0, left: 0 }}>
                <XAxis type="number" tick={{ fill: "#6b7280", fontSize: 9 }} axisLine={false} tickLine={false} />
                <YAxis type="category" dataKey="name" tick={{ fill: "#9ca3af", fontSize: 9 }} axisLine={false} tickLine={false} width={65} />
                <Tooltip contentStyle={tooltipStyle} />
                <Bar dataKey="events" fill="#3b82f6" radius={[0, 4, 4, 0]} name="Events" />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-xs text-text-secondary py-12 text-center">No data</p>
          )}
        </div>

        {/* Top flooding sensors */}
        <div className="bg-bg-card border border-border-card rounded-lg p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <AlertTriangle size={12} className="text-status-red" />
            <p className="text-xs font-semibold text-text-primary">Most Affected Sensors</p>
          </div>
          {topSensors.length > 0 ? (
            <div className="space-y-1.5 max-h-[130px] overflow-y-auto">
              {topSensors.map((s, i) => (
                <div key={s.id} className="flex items-center gap-2 text-xs">
                  <span className={`w-4 text-right font-bold ${i === 0 ? "text-status-red" : i < 3 ? "text-status-amber" : "text-text-secondary"}`}>
                    #{i + 1}
                  </span>
                  <span className="flex-1 text-text-secondary truncate">{s.id}</span>
                  <span className="font-medium text-text-primary">{s.count}x</span>
                  <span className={`text-[10px] ${s.maxDepth > 30 ? "text-status-red" : s.maxDepth > 10 ? "text-status-amber" : "text-text-secondary"}`}>
                    max {s.maxDepth}cm
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-text-secondary py-12 text-center">No data</p>
          )}
        </div>
      </div>
    </div>
  );
}
