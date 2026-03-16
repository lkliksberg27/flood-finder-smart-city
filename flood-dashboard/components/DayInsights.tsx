"use client";

import { useMemo } from "react";
import {
  AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, Tooltip, ResponsiveContainer,
} from "recharts";
import { Droplets, CloudRain, Waves, AlertTriangle } from "lucide-react";
import type { FloodEvent, Device } from "@/lib/types";

const tooltipStyle = {
  background: "#111827",
  border: "1px solid #1f2937",
  borderRadius: 8,
  color: "#f3f4f6",
  fontSize: 12,
};

interface Props {
  dayStart: number; // ms
  dayEnd: number;
  events: FloodEvent[];
}

export function DayInsights({ dayStart, dayEnd, events }: Props) {
  // ── Chart 1: Flood Activity per Hour ──
  const activityData = useMemo(() => {
    const hours = Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      label: h === 0 ? "12a" : h === 12 ? "12p" : h < 12 ? `${h}a` : `${h - 12}p`,
      floods: 0,
      peakDepth: 0,
    }));

    for (let h = 0; h < 24; h++) {
      const mid = dayStart + (h + 0.5) * 3600000;
      for (const evt of events) {
        const eStart = new Date(evt.started_at).getTime();
        const eEnd = evt.ended_at ? new Date(evt.ended_at).getTime() : Infinity;
        if (mid >= eStart && mid <= eEnd) {
          hours[h].floods++;
          hours[h].peakDepth = Math.max(hours[h].peakDepth, evt.peak_depth_cm);
        }
      }
    }
    return hours;
  }, [dayStart, events]);

  const peakHour = activityData.reduce((max, h) => h.floods > max.floods ? h : max, activityData[0]);

  // ── Chart 2: Worst Sensors ──
  const sensorData = useMemo(() => {
    const map: Record<string, { name: string; depth: number; neighborhood: string }> = {};
    for (const evt of events) {
      const dev = evt.devices as Device | undefined;
      const key = evt.device_id;
      if (!map[key] || evt.peak_depth_cm > map[key].depth) {
        map[key] = {
          name: dev?.name ?? evt.device_id,
          depth: evt.peak_depth_cm,
          neighborhood: dev?.neighborhood ?? "",
        };
      }
    }
    return Object.entries(map)
      .map(([id, v]) => ({ id, ...v }))
      .sort((a, b) => b.depth - a.depth)
      .slice(0, 8);
  }, [events]);

  // ── Chart 3: Cause breakdown ──
  const causes = useMemo(() => {
    let rainOnly = 0, tideOnly = 0, compound = 0, dry = 0;
    let totalRain = 0, totalTide = 0, rainCount = 0, tideCount = 0;

    for (const evt of events) {
      const hasRain = (evt.rainfall_mm ?? 0) > 0;
      const hasTide = (evt.tide_level_m ?? 0) > 0.3;
      if (hasRain && hasTide) compound++;
      else if (hasRain) rainOnly++;
      else if (hasTide) tideOnly++;
      else dry++;

      if (evt.rainfall_mm != null) { totalRain += evt.rainfall_mm; rainCount++; }
      if (evt.tide_level_m != null) { totalTide += evt.tide_level_m; tideCount++; }
    }

    return {
      rainOnly, tideOnly, compound, dry,
      avgRain: rainCount > 0 ? totalRain / rainCount : 0,
      avgTide: tideCount > 0 ? totalTide / tideCount : 0,
      total: events.length,
    };
  }, [events]);

  if (events.length === 0) {
    return (
      <div className="grid grid-cols-3 gap-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="bg-bg-card border border-border-card rounded-lg p-4 flex items-center justify-center h-[180px]">
            <p className="text-xs text-text-secondary">No flood data for this day</p>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-3 gap-3">
      {/* Chart 1: 24h Flood Activity */}
      <div className="bg-bg-card border border-border-card rounded-lg p-3">
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-semibold text-text-primary">Flood Activity</p>
          <p className="text-[10px] text-text-secondary">
            Peak: {peakHour.floods} at {peakHour.label}
          </p>
        </div>
        <ResponsiveContainer width="100%" height={130}>
          <AreaChart data={activityData} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
            <defs>
              <linearGradient id="floodGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="label"
              tick={{ fill: "#6b7280", fontSize: 9 }}
              axisLine={false}
              tickLine={false}
              interval={5}
            />
            <YAxis
              tick={{ fill: "#6b7280", fontSize: 9 }}
              axisLine={false}
              tickLine={false}
              allowDecimals={false}
            />
            <Tooltip contentStyle={tooltipStyle} />
            <Area
              type="monotone"
              dataKey="floods"
              stroke="#3b82f6"
              strokeWidth={2}
              fill="url(#floodGrad)"
              name="Active Floods"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Chart 2: Worst Sensors */}
      <div className="bg-bg-card border border-border-card rounded-lg p-3">
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-semibold text-text-primary">Sensors Hit</p>
          <p className="text-[10px] text-text-secondary">{sensorData.length} sensor{sensorData.length !== 1 ? "s" : ""}</p>
        </div>
        <ResponsiveContainer width="100%" height={130}>
          <BarChart data={sensorData} layout="vertical" margin={{ top: 0, right: 4, bottom: 0, left: 0 }}>
            <XAxis type="number" tick={{ fill: "#6b7280", fontSize: 9 }} axisLine={false} tickLine={false} unit="cm" />
            <YAxis
              type="category"
              dataKey="id"
              tick={{ fill: "#9ca3af", fontSize: 9 }}
              axisLine={false}
              tickLine={false}
              width={50}
            />
            <Tooltip contentStyle={tooltipStyle} formatter={(v) => [`${v}cm`, "Peak Depth"]} />
            <Bar dataKey="depth" radius={[0, 4, 4, 0]} name="Peak Depth">
              {sensorData.map((entry, i) => (
                <rect key={i} fill={entry.depth > 30 ? "#f87171" : entry.depth > 10 ? "#fbbf24" : "#34d399"} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Chart 3: Flood Causes */}
      <div className="bg-bg-card border border-border-card rounded-lg p-3">
        <p className="text-xs font-semibold text-text-primary mb-3">Flood Causes</p>

        <div className="space-y-2.5">
          {/* Compound events */}
          {causes.compound > 0 && (
            <div className="flex items-center gap-2 px-2 py-1.5 bg-status-red/10 border border-status-red/20 rounded-lg">
              <AlertTriangle size={13} className="text-status-red shrink-0" />
              <div className="flex-1">
                <p className="text-[11px] font-semibold text-status-red">
                  {causes.compound} Compound
                </p>
                <p className="text-[9px] text-text-secondary">Rain + high tide</p>
              </div>
              <span className="text-xs font-bold text-status-red">
                {Math.round((causes.compound / causes.total) * 100)}%
              </span>
            </div>
          )}

          {/* Rain only */}
          <div className="flex items-center gap-2 px-2 py-1.5">
            <CloudRain size={13} className="text-status-blue shrink-0" />
            <div className="flex-1">
              <p className="text-[11px] font-medium text-text-primary">{causes.rainOnly} Rain Only</p>
              <p className="text-[9px] text-text-secondary">Avg: {causes.avgRain.toFixed(1)}mm</p>
            </div>
            <span className="text-xs text-text-secondary">{causes.total > 0 ? Math.round((causes.rainOnly / causes.total) * 100) : 0}%</span>
          </div>

          {/* Tide only */}
          <div className="flex items-center gap-2 px-2 py-1.5">
            <Waves size={13} className="text-status-amber shrink-0" />
            <div className="flex-1">
              <p className="text-[11px] font-medium text-text-primary">{causes.tideOnly} High Tide</p>
              <p className="text-[9px] text-text-secondary">Avg: {causes.avgTide.toFixed(2)}m</p>
            </div>
            <span className="text-xs text-text-secondary">{causes.total > 0 ? Math.round((causes.tideOnly / causes.total) * 100) : 0}%</span>
          </div>

          {/* Dry flooding */}
          {causes.dry > 0 && (
            <div className="flex items-center gap-2 px-2 py-1.5">
              <Droplets size={13} className="text-text-secondary shrink-0" />
              <div className="flex-1">
                <p className="text-[11px] font-medium text-text-primary">{causes.dry} Other</p>
                <p className="text-[9px] text-text-secondary">No rain or tide data</p>
              </div>
              <span className="text-xs text-text-secondary">{Math.round((causes.dry / causes.total) * 100)}%</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
