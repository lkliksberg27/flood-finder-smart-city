"use client";

import { useEffect, useState, useMemo } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ScatterChart, Scatter, LineChart, Line,
  ResponsiveContainer, Cell, Legend,
} from "recharts";
import { Loader2, Filter } from "lucide-react";
import { getAllDevices, getAllFloodEvents, getFloodEventCount30d, getNeighborhoods } from "@/lib/queries";
import type { Device, FloodEvent } from "@/lib/types";

const CHART_COLORS = {
  blue: "#3b82f6",
  green: "#34d399",
  amber: "#fbbf24",
  red: "#f87171",
  purple: "#a78bfa",
};

const tooltipStyle = {
  background: "#111827",
  border: "1px solid #1f2937",
  borderRadius: 8,
  color: "#f3f4f6",
};

export default function AnalyticsPage() {
  const [allDevices, setAllDevices] = useState<Device[]>([]);
  const [allEvents, setAllEvents] = useState<FloodEvent[]>([]);
  const [floodCounts, setFloodCounts] = useState<Record<string, number>>({});
  const [neighborhoods, setNeighborhoods] = useState<string[]>([]);
  const [selectedNeighborhood, setSelectedNeighborhood] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      getAllDevices().then(setAllDevices),
      getAllFloodEvents(1000).then(setAllEvents),
      getFloodEventCount30d().then(setFloodCounts),
      getNeighborhoods().then(setNeighborhoods),
    ]).catch(console.error).finally(() => setLoading(false));
  }, []);

  // Filter devices and events by selected neighborhood
  const devices = useMemo(() => {
    if (!selectedNeighborhood) return allDevices;
    return allDevices.filter((d) => d.neighborhood === selectedNeighborhood);
  }, [allDevices, selectedNeighborhood]);

  const events = useMemo(() => {
    if (!selectedNeighborhood) return allEvents;
    return allEvents.filter((e) => {
      const dev = e.devices as Device | undefined;
      return dev?.neighborhood === selectedNeighborhood;
    });
  }, [allEvents, selectedNeighborhood]);

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

  // 6. Elevation vs Flood Frequency
  const elevationFloodData = devices
    .filter((d) => d.altitude_baro != null)
    .map((d) => ({
      device: d.device_id,
      elevation: parseFloat((d.altitude_baro ?? 0).toFixed(2)),
      floods: floodCounts[d.device_id] ?? 0,
    }))
    .sort((a, b) => a.elevation - b.elevation);

  // 7. Tide level vs flood depth correlation
  const tideFloodData = events
    .filter((e) => e.tide_level_m != null)
    .map((e) => ({
      tide: parseFloat((e.tide_level_m ?? 0).toFixed(2)),
      depth: e.peak_depth_cm,
    }));

  // Summary stats
  const totalEvents = events.length;
  const avgDepth = totalEvents > 0
    ? Math.round(events.reduce((s, e) => s + e.peak_depth_cm, 0) / totalEvents)
    : 0;
  const avgDuration = totalEvents > 0
    ? Math.round(events.reduce((s, e) => s + (e.duration_minutes ?? 0), 0) / totalEvents)
    : 0;
  const rainfallCorrelation = events.filter((e) => (e.rainfall_mm ?? 0) > 0).length;
  const compoundEvents = events.filter((e) => (e.rainfall_mm ?? 0) > 0 && (e.tide_level_m ?? 0) > 0.3).length;

  // 8. Neighborhood flood comparison
  const neighborhoodData: Record<string, { events: number; avgDepth: number; sensors: number }> = {};
  devices.forEach((d) => {
    const n = d.neighborhood ?? "Unknown";
    if (!neighborhoodData[n]) neighborhoodData[n] = { events: 0, avgDepth: 0, sensors: 0 };
    neighborhoodData[n].sensors++;
  });
  events.forEach((e) => {
    const dev = e.devices as Device | undefined;
    const n = dev?.neighborhood ?? "Unknown";
    if (!neighborhoodData[n]) neighborhoodData[n] = { events: 0, avgDepth: 0, sensors: 0 };
    neighborhoodData[n].events++;
    neighborhoodData[n].avgDepth += e.peak_depth_cm;
  });
  const neighborhoodChart = Object.entries(neighborhoodData)
    .map(([name, d]) => ({
      name: name.length > 12 ? name.slice(0, 12) + "..." : name,
      events: d.events,
      avgDepth: d.events > 0 ? Math.round(d.avgDepth / d.events) : 0,
    }))
    .sort((a, b) => b.events - a.events)
    .slice(0, 8);

  // 9. Duration vs depth scatter
  const durationDepthData = events
    .filter((e) => e.duration_minutes != null && e.duration_minutes > 0)
    .map((e) => ({
      duration: e.duration_minutes!,
      depth: e.peak_depth_cm,
    }));

  // 10. Compound events breakdown
  const compoundBreakdown = [
    { type: "Rain Only", count: events.filter((e) => (e.rainfall_mm ?? 0) > 0 && (e.tide_level_m ?? 0) <= 0.3).length, color: CHART_COLORS.blue },
    { type: "High Tide Only", count: events.filter((e) => (e.rainfall_mm ?? 0) <= 0 && (e.tide_level_m ?? 0) > 0.3).length, color: CHART_COLORS.green },
    { type: "Rain + Tide", count: compoundEvents, color: CHART_COLORS.red },
    { type: "Neither", count: events.filter((e) => (e.rainfall_mm ?? 0) <= 0 && (e.tide_level_m ?? 0) <= 0.3).length, color: CHART_COLORS.amber },
  ];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-120px)]">
        <div className="text-center">
          <Loader2 size={32} className="animate-spin text-status-blue mx-auto mb-3" />
          <p className="text-sm text-text-secondary">Crunching flood data...</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-semibold">Analytics & Patterns</h2>
          <p className="text-sm text-text-secondary mt-1">
            {selectedNeighborhood
              ? `Flood analysis for ${selectedNeighborhood} — ${devices.length} sensors, ${totalEvents} events`
              : `Data-driven flood pattern analysis across ${allDevices.length} sensors`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Filter size={16} className="text-text-secondary" />
          <select
            value={selectedNeighborhood}
            onChange={(e) => setSelectedNeighborhood(e.target.value)}
            className="bg-bg-card border border-border-card rounded-lg px-3 py-2 text-sm text-text-primary min-w-[180px]"
          >
            <option value="">All Neighborhoods</option>
            {neighborhoods.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
          {selectedNeighborhood && (
            <button
              onClick={() => setSelectedNeighborhood("")}
              className="text-xs text-text-secondary hover:text-text-primary transition-colors"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-5 gap-4 mb-6">
        <div className="bg-bg-card border border-border-card rounded-lg p-4">
          <p className="text-xs text-text-secondary uppercase">Total Events</p>
          <p className="text-2xl font-bold text-status-blue mt-1">{totalEvents}</p>
        </div>
        <div className="bg-bg-card border border-border-card rounded-lg p-4">
          <p className="text-xs text-text-secondary uppercase">Avg Depth</p>
          <p className="text-2xl font-bold text-status-amber mt-1">{avgDepth}cm</p>
        </div>
        <div className="bg-bg-card border border-border-card rounded-lg p-4">
          <p className="text-xs text-text-secondary uppercase">Avg Duration</p>
          <p className="text-2xl font-bold mt-1">{avgDuration} min</p>
        </div>
        <div className="bg-bg-card border border-border-card rounded-lg p-4">
          <p className="text-xs text-text-secondary uppercase">Rain-Linked</p>
          <p className="text-2xl font-bold text-status-green mt-1">
            {totalEvents > 0 ? Math.round((rainfallCorrelation / totalEvents) * 100) : 0}%
          </p>
        </div>
        <div className="bg-bg-card border border-border-card rounded-lg p-4">
          <p className="text-xs text-text-secondary uppercase">Compound Events</p>
          <p className="text-2xl font-bold text-status-red mt-1">
            {compoundEvents}
          </p>
        </div>
      </div>

      {/* Auto-generated insights */}
      {totalEvents > 0 && (
        <div className="bg-bg-card border border-status-blue/20 rounded-lg p-4 mb-6">
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-status-blue" />
            Auto-Generated Key Insights
          </h3>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs text-text-secondary">
            {(() => {
              const insights: string[] = [];
              // Worst neighborhood
              const worstN = neighborhoodChart[0];
              if (worstN) insights.push(`${worstN.name} has the most flood events (${worstN.events}) with avg depth ${worstN.avgDepth}cm`);
              // Compound percentage
              if (compoundEvents > 0) insights.push(`${Math.round((compoundEvents / totalEvents) * 100)}% of floods are compound events (rain + high tide simultaneously)`);
              // Rain correlation
              if (rainfallCorrelation > 0) insights.push(`${Math.round((rainfallCorrelation / totalEvents) * 100)}% of flood events correlate with measurable rainfall`);
              // Peak hour
              const peakHour = hourCounts.reduce((max, h) => h.count > max.count ? h : max, hourCounts[0]);
              if (peakHour.count > 0) insights.push(`Most floods occur at ${peakHour.hour} — ${peakHour.count} events recorded at this hour`);
              // Elevation correlation
              const lowSensors = elevationFloodData.filter((d) => d.elevation < 1.0);
              const highSensors = elevationFloodData.filter((d) => d.elevation >= 1.5);
              if (lowSensors.length > 0 && highSensors.length > 0) {
                const lowAvgFloods = lowSensors.reduce((s, d) => s + d.floods, 0) / lowSensors.length;
                const highAvgFloods = highSensors.reduce((s, d) => s + d.floods, 0) / highSensors.length;
                if (lowAvgFloods > highAvgFloods) insights.push(`Sensors below 1.0m elevation flood ${lowAvgFloods.toFixed(1)}x vs ${highAvgFloods.toFixed(1)}x for sensors above 1.5m`);
              }
              // Trend analysis — compare first half vs second half of data
              const sorted = [...events].sort((a, b) => a.started_at.localeCompare(b.started_at));
              const mid = Math.floor(sorted.length / 2);
              if (sorted.length >= 10) {
                const firstHalf = sorted.slice(0, mid);
                const secondHalf = sorted.slice(mid);
                const firstAvgDepth = firstHalf.reduce((s, e) => s + e.peak_depth_cm, 0) / firstHalf.length;
                const secondAvgDepth = secondHalf.reduce((s, e) => s + e.peak_depth_cm, 0) / secondHalf.length;
                const changePct = Math.round(((secondAvgDepth - firstAvgDepth) / firstAvgDepth) * 100);
                if (Math.abs(changePct) > 10) {
                  insights.push(changePct > 0
                    ? `Flood severity is increasing — avg depth rose ${changePct}% in recent events compared to earlier data`
                    : `Flood severity is decreasing — avg depth dropped ${Math.abs(changePct)}% in recent events`
                  );
                }
              }
              // Worst time of day
              const afternoonFloods = hourCounts.slice(12, 17).reduce((s, h) => s + h.count, 0);
              const morningFloods = hourCounts.slice(6, 12).reduce((s, h) => s + h.count, 0);
              if (afternoonFloods > morningFloods * 1.5 && afternoonFloods > 5) {
                insights.push(`Afternoon floods (12-5pm) outnumber morning floods ${afternoonFloods} to ${morningFloods} — likely driven by daily rain pattern`);
              }
              // Severity distribution
              const highSeverity = events.filter((e) => e.peak_depth_cm > 30).length;
              if (highSeverity > 0) insights.push(`${highSeverity} events (${Math.round((highSeverity / totalEvents) * 100)}%) reached HIGH severity (>30cm) — these pose road safety risks`);
              // Battery health
              const lowBatt = devices.filter((d) => (d.battery_v ?? 4) < 3.3).length;
              if (lowBatt > 0) insights.push(`${lowBatt} sensor${lowBatt > 1 ? "s" : ""} have low battery (<3.3V) — replace soon to avoid data gaps`);

              return insights.map((insight, i) => (
                <p key={i} className="py-1">
                  <span className="text-status-blue mr-1.5">&#x2022;</span>
                  {insight}
                </p>
              ));
            })()}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-6">
        {/* Weekly flood events */}
        <div className="bg-bg-card border border-border-card rounded-lg p-4">
          <h3 className="text-sm font-semibold mb-4">Flood Events per Week</h3>
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={weeklyChart}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis dataKey="week" tick={{ fill: "#9ca3af", fontSize: 11 }} />
              <YAxis tick={{ fill: "#9ca3af", fontSize: 11 }} />
              <Tooltip contentStyle={tooltipStyle} />
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
              <Tooltip contentStyle={tooltipStyle} />
              <Bar dataKey="count" fill={CHART_COLORS.red} radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Elevation vs Flood Frequency — KEY INSIGHT */}
        <div className="bg-bg-card border border-border-card rounded-lg p-4">
          <h3 className="text-sm font-semibold mb-1">Elevation vs Flood Frequency</h3>
          <p className="text-xs text-text-secondary mb-3">Lower sensors flood more — identifies road dips</p>
          <ResponsiveContainer width="100%" height={250}>
            <ScatterChart>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis dataKey="elevation" name="Elevation (m)" tick={{ fill: "#9ca3af", fontSize: 11 }} />
              <YAxis dataKey="floods" name="Flood Events" tick={{ fill: "#9ca3af", fontSize: 11 }} />
              <Tooltip contentStyle={tooltipStyle} />
              <Scatter data={elevationFloodData} fill={CHART_COLORS.purple}>
                {elevationFloodData.map((d, i) => (
                  <Cell key={i} fill={d.floods > 3 ? CHART_COLORS.red : d.floods > 0 ? CHART_COLORS.amber : CHART_COLORS.green} />
                ))}
              </Scatter>
            </ScatterChart>
          </ResponsiveContainer>
        </div>

        {/* Depth vs Rainfall scatter */}
        <div className="bg-bg-card border border-border-card rounded-lg p-4">
          <h3 className="text-sm font-semibold mb-1">Flood Depth vs Rainfall</h3>
          <p className="text-xs text-text-secondary mb-3">NOAA rainfall data correlated with sensor depth</p>
          <ResponsiveContainer width="100%" height={250}>
            <ScatterChart>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis dataKey="rainfall" name="Rainfall (mm)" tick={{ fill: "#9ca3af", fontSize: 11 }} />
              <YAxis dataKey="depth" name="Depth (cm)" tick={{ fill: "#9ca3af", fontSize: 11 }} />
              <Tooltip contentStyle={tooltipStyle} />
              <Scatter data={scatterData} fill={CHART_COLORS.amber} />
            </ScatterChart>
          </ResponsiveContainer>
        </div>

        {/* Tide vs Flood Depth */}
        <div className="bg-bg-card border border-border-card rounded-lg p-4">
          <h3 className="text-sm font-semibold mb-1">Tide Level vs Flood Depth</h3>
          <p className="text-xs text-text-secondary mb-3">NOAA tide data — high tides compound flooding</p>
          <ResponsiveContainer width="100%" height={250}>
            <ScatterChart>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis dataKey="tide" name="Tide Level (m)" tick={{ fill: "#9ca3af", fontSize: 11 }} />
              <YAxis dataKey="depth" name="Flood Depth (cm)" tick={{ fill: "#9ca3af", fontSize: 11 }} />
              <Tooltip contentStyle={tooltipStyle} />
              <Scatter data={tideFloodData} fill={CHART_COLORS.blue} />
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
              <Tooltip contentStyle={tooltipStyle} />
              <Bar dataKey="count" fill={CHART_COLORS.blue}>
                {hourCounts.map((entry, i) => (
                  <Cell key={i} fill={entry.count > 5 ? CHART_COLORS.red : CHART_COLORS.blue} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Compound events breakdown */}
        <div className="bg-bg-card border border-border-card rounded-lg p-4">
          <h3 className="text-sm font-semibold mb-1">Flood Trigger Breakdown</h3>
          <p className="text-xs text-text-secondary mb-3">Rain + high tide compound events cause the worst flooding</p>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={compoundBreakdown}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis dataKey="type" tick={{ fill: "#9ca3af", fontSize: 10 }} />
              <YAxis tick={{ fill: "#9ca3af", fontSize: 11 }} />
              <Tooltip contentStyle={tooltipStyle} />
              <Bar dataKey="count" name="Events" radius={[4, 4, 0, 0]}>
                {compoundBreakdown.map((b, i) => (
                  <Cell key={i} fill={b.color} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Neighborhood comparison */}
        <div className="bg-bg-card border border-border-card rounded-lg p-4">
          <h3 className="text-sm font-semibold mb-1">Flooding by Neighborhood</h3>
          <p className="text-xs text-text-secondary mb-3">Identifies areas needing city-wide infrastructure investment</p>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={neighborhoodChart}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis dataKey="name" tick={{ fill: "#9ca3af", fontSize: 9 }} angle={-20} textAnchor="end" height={40} />
              <YAxis tick={{ fill: "#9ca3af", fontSize: 11 }} />
              <Tooltip contentStyle={tooltipStyle} />
              <Bar dataKey="events" name="Flood Events" fill={CHART_COLORS.red} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Duration vs Depth */}
        <div className="bg-bg-card border border-border-card rounded-lg p-4">
          <h3 className="text-sm font-semibold mb-1">Flood Duration vs Depth</h3>
          <p className="text-xs text-text-secondary mb-3">Deeper floods tend to last longer — identifies persistent problem areas</p>
          <ResponsiveContainer width="100%" height={250}>
            <ScatterChart>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis dataKey="depth" name="Depth (cm)" tick={{ fill: "#9ca3af", fontSize: 11 }} />
              <YAxis dataKey="duration" name="Duration (min)" tick={{ fill: "#9ca3af", fontSize: 11 }} />
              <Tooltip contentStyle={tooltipStyle} />
              <Scatter data={durationDepthData} fill={CHART_COLORS.purple}>
                {durationDepthData.map((d, i) => (
                  <Cell key={i} fill={d.depth > 30 ? CHART_COLORS.red : d.depth > 10 ? CHART_COLORS.amber : CHART_COLORS.green} />
                ))}
              </Scatter>
            </ScatterChart>
          </ResponsiveContainer>
        </div>

        {/* Battery health */}
        <div className="bg-bg-card border border-border-card rounded-lg p-4">
          <h3 className="text-sm font-semibold mb-4">Fleet Battery Health</h3>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={batteryBuckets}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis dataKey="label" tick={{ fill: "#9ca3af", fontSize: 12 }} />
              <YAxis tick={{ fill: "#9ca3af", fontSize: 11 }} />
              <Tooltip contentStyle={tooltipStyle} />
              <Legend />
              <Bar dataKey="count" name="Sensors" radius={[4, 4, 0, 0]}>
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
