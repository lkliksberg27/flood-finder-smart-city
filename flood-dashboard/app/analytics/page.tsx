"use client";

import { useEffect, useState, useMemo } from "react";
import dynamic from "next/dynamic";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ScatterChart, Scatter, LineChart, Line,
  ResponsiveContainer, Cell, Legend,
} from "recharts";
import { Loader2, ArrowLeft, MapPin, AlertTriangle, Droplets, Clock, TrendingUp } from "lucide-react";
import { getAllDevices, getAllFloodEvents, getFloodEventCount30d } from "@/lib/queries";
import type { Device, FloodEvent } from "@/lib/types";

const AnalyticsMap = dynamic(
  () => import("@/components/AnalyticsMap").then((m) => m.AnalyticsMap),
  { ssr: false }
);

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

interface AreaSummary {
  name: string;
  sensors: number;
  events: number;
  avgDepth: number;
  maxDepth: number;
  compoundEvents: number;
  avgElevation: number;
  riskLevel: "critical" | "high" | "moderate" | "low";
}

function computeRisk(events: number, avgDepth: number, compoundEvents: number): "critical" | "high" | "moderate" | "low" {
  const score = events * 3 + avgDepth * 0.5 + compoundEvents * 5;
  if (score > 50) return "critical";
  if (score > 25) return "high";
  if (score > 10) return "moderate";
  return "low";
}

const RISK_STYLES = {
  critical: { bg: "bg-status-red/15", border: "border-status-red/40", text: "text-status-red", label: "CRITICAL" },
  high: { bg: "bg-status-amber/15", border: "border-status-amber/40", text: "text-status-amber", label: "HIGH RISK" },
  moderate: { bg: "bg-status-blue/15", border: "border-status-blue/40", text: "text-status-blue", label: "MODERATE" },
  low: { bg: "bg-status-green/15", border: "border-status-green/40", text: "text-status-green", label: "LOW RISK" },
};

export default function AnalyticsPage() {
  const [allDevices, setAllDevices] = useState<Device[]>([]);
  const [allEvents, setAllEvents] = useState<FloodEvent[]>([]);
  const [floodCounts, setFloodCounts] = useState<Record<string, number>>({});
  const [selectedArea, setSelectedArea] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      getAllDevices().then(setAllDevices),
      getAllFloodEvents(1000).then(setAllEvents),
      getFloodEventCount30d().then(setFloodCounts),
    ]).catch(console.error).finally(() => setLoading(false));
  }, []);

  // Build area summaries for landing page
  const areas = useMemo<AreaSummary[]>(() => {
    const map: Record<string, { sensors: Device[]; events: FloodEvent[] }> = {};
    allDevices.forEach((d) => {
      const n = d.neighborhood ?? "Other";
      if (!map[n]) map[n] = { sensors: [], events: [] };
      map[n].sensors.push(d);
    });
    allEvents.forEach((e) => {
      const dev = e.devices as Device | undefined;
      const n = dev?.neighborhood ?? "Other";
      if (!map[n]) map[n] = { sensors: [], events: [] };
      map[n].events.push(e);
    });

    return Object.entries(map)
      .map(([name, { sensors, events }]) => {
        const avgDepth = events.length > 0
          ? Math.round(events.reduce((s, e) => s + e.peak_depth_cm, 0) / events.length)
          : 0;
        const maxDepth = events.length > 0
          ? Math.max(...events.map((e) => e.peak_depth_cm))
          : 0;
        const compoundEvents = events.filter(
          (e) => (e.rainfall_mm ?? 0) > 0 && (e.tide_level_m ?? 0) > 0.3
        ).length;
        const elevations = sensors.filter((d) => d.altitude_baro != null).map((d) => d.altitude_baro!);
        const avgElevation = elevations.length > 0
          ? parseFloat((elevations.reduce((s, e) => s + e, 0) / elevations.length).toFixed(2))
          : 0;

        return {
          name,
          sensors: sensors.length,
          events: events.length,
          avgDepth,
          maxDepth,
          compoundEvents,
          avgElevation,
          riskLevel: computeRisk(events.length, avgDepth, compoundEvents),
        };
      })
      .sort((a, b) => {
        const order = { critical: 0, high: 1, moderate: 2, low: 3 };
        return order[a.riskLevel] - order[b.riskLevel] || b.events - a.events;
      });
  }, [allDevices, allEvents]);

  // Filtered data for drilled-in view
  const devices = useMemo(() => {
    if (!selectedArea) return allDevices;
    return allDevices.filter((d) => (d.neighborhood ?? "Other") === selectedArea);
  }, [allDevices, selectedArea]);

  const events = useMemo(() => {
    if (!selectedArea) return allEvents;
    return allEvents.filter((e) => {
      const dev = e.devices as Device | undefined;
      return (dev?.neighborhood ?? "Other") === selectedArea;
    });
  }, [allEvents, selectedArea]);

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

  // ═══════════════════════════════════════════════════
  // LANDING VIEW — Pick an area
  // ═══════════════════════════════════════════════════
  if (!selectedArea) {
    return (
      <div>
        <h2 className="text-xl font-semibold mb-1">Flood Analytics</h2>
        <p className="text-sm text-text-secondary mb-6">
          Select a neighborhood to view detailed flood patterns, risk factors, and infrastructure insights for that area.
        </p>

        {/* City-wide quick stats */}
        <div className="grid grid-cols-4 gap-4 mb-8">
          <div className="bg-bg-card border border-border-card rounded-lg p-4">
            <p className="text-xs text-text-secondary uppercase">Total Flood Events</p>
            <p className="text-2xl font-bold text-status-blue mt-1">{allEvents.length}</p>
          </div>
          <div className="bg-bg-card border border-border-card rounded-lg p-4">
            <p className="text-xs text-text-secondary uppercase">Active Sensors</p>
            <p className="text-2xl font-bold text-status-green mt-1">{allDevices.length}</p>
          </div>
          <div className="bg-bg-card border border-border-card rounded-lg p-4">
            <p className="text-xs text-text-secondary uppercase">Neighborhoods Monitored</p>
            <p className="text-2xl font-bold mt-1">{areas.length}</p>
          </div>
          <div className="bg-bg-card border border-border-card rounded-lg p-4">
            <p className="text-xs text-text-secondary uppercase">High Risk Areas</p>
            <p className="text-2xl font-bold text-status-red mt-1">
              {areas.filter((a) => a.riskLevel === "critical" || a.riskLevel === "high").length}
            </p>
          </div>
        </div>

        {/* City-wide flood map */}
        <div className="h-[380px] rounded-lg overflow-hidden border border-border-card mb-6">
          <AnalyticsMap
            devices={allDevices}
            events={allEvents}
            floodCounts={floodCounts}
            onAreaClick={(n) => setSelectedArea(n)}
          />
        </div>

        {/* Area cards */}
        <div className="grid grid-cols-2 gap-4">
          {areas.map((area) => {
            const style = RISK_STYLES[area.riskLevel];
            return (
              <button
                key={area.name}
                onClick={() => setSelectedArea(area.name)}
                className={`${style.bg} border ${style.border} rounded-lg p-5 text-left hover:brightness-110 transition-all group`}
              >
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <MapPin size={16} className={style.text} />
                    <h3 className="text-base font-semibold">{area.name}</h3>
                  </div>
                  <span className={`px-2 py-0.5 rounded text-xs font-bold ${style.text}`}>
                    {style.label}
                  </span>
                </div>

                <div className="grid grid-cols-4 gap-3 text-xs">
                  <div>
                    <p className="text-text-secondary">Sensors</p>
                    <p className="text-base font-bold mt-0.5">{area.sensors}</p>
                  </div>
                  <div>
                    <p className="text-text-secondary">Flood Events</p>
                    <p className={`text-base font-bold mt-0.5 ${area.events > 5 ? "text-status-red" : ""}`}>
                      {area.events}
                    </p>
                  </div>
                  <div>
                    <p className="text-text-secondary">Avg Depth</p>
                    <p className={`text-base font-bold mt-0.5 ${area.avgDepth > 20 ? "text-status-red" : area.avgDepth > 10 ? "text-status-amber" : ""}`}>
                      {area.avgDepth}cm
                    </p>
                  </div>
                  <div>
                    <p className="text-text-secondary">Avg Elevation</p>
                    <p className={`text-base font-bold mt-0.5 ${area.avgElevation < 1.0 ? "text-status-amber" : ""}`}>
                      {area.avgElevation}m
                    </p>
                  </div>
                </div>

                {area.compoundEvents > 0 && (
                  <div className="mt-3 flex items-center gap-1.5 text-xs text-status-red">
                    <AlertTriangle size={12} />
                    {area.compoundEvents} compound flood event{area.compoundEvents > 1 ? "s" : ""} (rain + high tide)
                  </div>
                )}

                <p className="text-xs text-text-secondary mt-3 group-hover:text-text-primary transition-colors">
                  Click to view full analysis →
                </p>
              </button>
            );
          })}
        </div>

        {areas.length === 0 && (
          <div className="text-center py-16 text-text-secondary">
            <MapPin size={48} className="mx-auto mb-4 opacity-20" />
            <p className="text-lg mb-2">No neighborhoods found</p>
            <p className="text-sm">Add sensors with neighborhood data to see area analytics.</p>
          </div>
        )}
      </div>
    );
  }

  // ═══════════════════════════════════════════════════
  // DRILLED-IN VIEW — Full analytics for one area
  // ═══════════════════════════════════════════════════

  const totalEvents = events.length;
  const avgDepth = totalEvents > 0
    ? Math.round(events.reduce((s, e) => s + e.peak_depth_cm, 0) / totalEvents)
    : 0;
  const avgDuration = totalEvents > 0
    ? Math.round(events.reduce((s, e) => s + (e.duration_minutes ?? 0), 0) / totalEvents)
    : 0;
  const rainfallCorrelation = events.filter((e) => (e.rainfall_mm ?? 0) > 0).length;
  const compoundEvents = events.filter((e) => (e.rainfall_mm ?? 0) > 0 && (e.tide_level_m ?? 0) > 0.3).length;
  const highSeverityCount = events.filter((e) => e.peak_depth_cm > 30).length;
  const maxDepth = totalEvents > 0 ? Math.max(...events.map((e) => e.peak_depth_cm)) : 0;

  // Weekly trend
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

  // Top sensors in this area
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

  // Rainfall scatter
  const scatterData = events
    .filter((e) => e.rainfall_mm != null && e.rainfall_mm > 0)
    .map((e) => ({ rainfall: e.rainfall_mm, depth: e.peak_depth_cm }));

  // Hour distribution
  const hourCounts = Array.from({ length: 24 }, (_, i) => ({ hour: `${i}:00`, count: 0 }));
  events.forEach((e) => {
    const h = new Date(e.started_at).getHours();
    hourCounts[h].count++;
  });

  // Elevation vs floods
  const elevationFloodData = devices
    .filter((d) => d.altitude_baro != null)
    .map((d) => ({
      device: d.device_id,
      elevation: parseFloat((d.altitude_baro ?? 0).toFixed(2)),
      floods: floodCounts[d.device_id] ?? 0,
    }))
    .sort((a, b) => a.elevation - b.elevation);

  // Tide scatter
  const tideFloodData = events
    .filter((e) => e.tide_level_m != null)
    .map((e) => ({
      tide: parseFloat((e.tide_level_m ?? 0).toFixed(2)),
      depth: e.peak_depth_cm,
    }));

  // Compound breakdown
  const compoundBreakdown = [
    { type: "Rain Only", count: events.filter((e) => (e.rainfall_mm ?? 0) > 0 && (e.tide_level_m ?? 0) <= 0.3).length, color: CHART_COLORS.blue },
    { type: "High Tide Only", count: events.filter((e) => (e.rainfall_mm ?? 0) <= 0 && (e.tide_level_m ?? 0) > 0.3).length, color: CHART_COLORS.green },
    { type: "Rain + Tide", count: compoundEvents, color: CHART_COLORS.red },
    { type: "Neither", count: events.filter((e) => (e.rainfall_mm ?? 0) <= 0 && (e.tide_level_m ?? 0) <= 0.3).length, color: CHART_COLORS.amber },
  ];

  // Duration vs depth
  const durationDepthData = events
    .filter((e) => e.duration_minutes != null && e.duration_minutes > 0)
    .map((e) => ({ duration: e.duration_minutes!, depth: e.peak_depth_cm }));

  // Battery
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

  // Peak hour
  const peakHour = hourCounts.reduce((max, h) => h.count > max.count ? h : max, hourCounts[0]);

  // Area summary for the selected area
  const areaInfo = areas.find((a) => a.name === selectedArea);
  const riskStyle = areaInfo ? RISK_STYLES[areaInfo.riskLevel] : RISK_STYLES.low;

  return (
    <div>
      {/* Header with back button */}
      <button
        onClick={() => setSelectedArea(null)}
        className="flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary transition-colors mb-4"
      >
        <ArrowLeft size={16} /> Back to all neighborhoods
      </button>

      <div className="flex items-center gap-3 mb-1">
        <MapPin size={20} className={riskStyle.text} />
        <h2 className="text-xl font-semibold">{selectedArea}</h2>
        <span className={`px-2.5 py-0.5 rounded text-xs font-bold ${riskStyle.text} ${riskStyle.bg}`}>
          {riskStyle.label}
        </span>
      </div>
      <p className="text-sm text-text-secondary mb-6">
        {devices.length} sensors monitoring this area — {totalEvents} flood events recorded
      </p>

      {/* Area-specific summary */}
      <div className="grid grid-cols-6 gap-3 mb-6">
        <div className="bg-bg-card border border-border-card rounded-lg p-4">
          <div className="flex items-center gap-1.5 mb-1">
            <Droplets size={12} className="text-status-blue" />
            <p className="text-xs text-text-secondary">Flood Events</p>
          </div>
          <p className="text-2xl font-bold text-status-blue">{totalEvents}</p>
        </div>
        <div className="bg-bg-card border border-border-card rounded-lg p-4">
          <div className="flex items-center gap-1.5 mb-1">
            <TrendingUp size={12} className="text-status-amber" />
            <p className="text-xs text-text-secondary">Avg Depth</p>
          </div>
          <p className="text-2xl font-bold text-status-amber">{avgDepth}cm</p>
        </div>
        <div className="bg-bg-card border border-border-card rounded-lg p-4">
          <div className="flex items-center gap-1.5 mb-1">
            <AlertTriangle size={12} className="text-status-red" />
            <p className="text-xs text-text-secondary">Worst Flood</p>
          </div>
          <p className="text-2xl font-bold text-status-red">{maxDepth}cm</p>
        </div>
        <div className="bg-bg-card border border-border-card rounded-lg p-4">
          <div className="flex items-center gap-1.5 mb-1">
            <Clock size={12} className="text-text-secondary" />
            <p className="text-xs text-text-secondary">Avg Duration</p>
          </div>
          <p className="text-2xl font-bold">{avgDuration} min</p>
        </div>
        <div className="bg-bg-card border border-border-card rounded-lg p-4">
          <p className="text-xs text-text-secondary mb-1">Rain-Linked</p>
          <p className="text-2xl font-bold text-status-green">
            {totalEvents > 0 ? Math.round((rainfallCorrelation / totalEvents) * 100) : 0}%
          </p>
        </div>
        <div className="bg-bg-card border border-border-card rounded-lg p-4">
          <p className="text-xs text-text-secondary mb-1">Compound Events</p>
          <p className="text-2xl font-bold text-status-red">{compoundEvents}</p>
        </div>
      </div>

      {/* Plain-language area assessment */}
      {totalEvents > 0 && (
        <div className={`${riskStyle.bg} border ${riskStyle.border} rounded-lg p-5 mb-6`}>
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${riskStyle.text === "text-status-red" ? "bg-status-red" : riskStyle.text === "text-status-amber" ? "bg-status-amber" : riskStyle.text === "text-status-blue" ? "bg-status-blue" : "bg-status-green"}`} />
            Area Assessment — {selectedArea}
          </h3>
          <div className="space-y-2 text-sm text-text-primary/90">
            {(() => {
              const lines: string[] = [];

              // Flooding frequency assessment
              if (totalEvents > 10) {
                lines.push(`This area has experienced ${totalEvents} flood events — it is one of the most flood-prone locations in the network and requires priority infrastructure attention.`);
              } else if (totalEvents > 3) {
                lines.push(`This area has experienced ${totalEvents} flood events, indicating recurring drainage issues that should be addressed.`);
              } else if (totalEvents > 0) {
                lines.push(`This area has had ${totalEvents} flood event${totalEvents > 1 ? "s" : ""} — relatively low frequency but still worth monitoring.`);
              }

              // Severity
              if (highSeverityCount > 0) {
                lines.push(`${highSeverityCount} of these events were HIGH severity (over 30cm) — deep enough to stall vehicles and endanger pedestrians. The worst recorded flood here reached ${maxDepth}cm.`);
              } else if (avgDepth > 15) {
                lines.push(`Average flood depth of ${avgDepth}cm is significant — enough to block low-lying roads and cause property damage.`);
              }

              // Compound events
              if (compoundEvents > 0) {
                const pct = Math.round((compoundEvents / totalEvents) * 100);
                lines.push(`${pct}% of floods here are compound events (rain + high tide simultaneously). This means storm drains cannot discharge because tidal waterways are already elevated. Backflow preventers or tide gates on outfalls would directly address this.`);
              }

              // Peak time
              if (peakHour.count > 0) {
                lines.push(`Flooding peaks at ${peakHour.hour} — scheduling road closures or maintenance crews around this time would reduce risk to drivers.`);
              }

              // Elevation
              const lowElev = devices.filter((d) => (d.altitude_baro ?? 99) < 1.0);
              if (lowElev.length > 0) {
                lines.push(`${lowElev.length} sensor${lowElev.length > 1 ? "s" : ""} in this area sit below 1.0m elevation — these low-lying points are natural water collection zones and are the highest priority for drainage upgrades.`);
              }

              // Rainfall threshold
              const rainEvents = events.filter((e) => (e.rainfall_mm ?? 0) > 0);
              if (rainEvents.length >= 3) {
                const avgRain = rainEvents.reduce((s, e) => s + (e.rainfall_mm ?? 0), 0) / rainEvents.length;
                const minRain = Math.min(...rainEvents.map((e) => e.rainfall_mm ?? 0));
                lines.push(`Flooding in this area triggers at as little as ${minRain.toFixed(1)}mm of rainfall (average: ${avgRain.toFixed(1)}mm). The current drainage capacity cannot handle even moderate rain events.`);
              }

              return lines.map((line, i) => (
                <p key={i} className="leading-relaxed">{line}</p>
              ));
            })()}
          </div>
        </div>
      )}

      {/* Neighborhood flood map */}
      <div className="h-[350px] rounded-lg overflow-hidden border border-border-card mb-6">
        <AnalyticsMap
          devices={devices}
          events={events}
          floodCounts={floodCounts}
          selectedArea={selectedArea}
        />
      </div>

      {/* Charts grid */}
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
          <h3 className="text-sm font-semibold mb-1">Worst Flooding Locations</h3>
          <p className="text-xs text-text-secondary mb-3">Sensors with the most flood events in this area</p>
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

        {/* Elevation vs Flood Frequency */}
        <div className="bg-bg-card border border-border-card rounded-lg p-4">
          <h3 className="text-sm font-semibold mb-1">Elevation vs Flood Frequency</h3>
          <p className="text-xs text-text-secondary mb-3">Low-elevation sensors flood more — identifies road dips needing infrastructure</p>
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
          <p className="text-xs text-text-secondary mb-3">How much rain triggers how deep a flood in this area</p>
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
          <p className="text-xs text-text-secondary mb-3">High tides prevent drain outfall — compounds flooding in this area</p>
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
          <h3 className="text-sm font-semibold mb-1">When Flooding Happens</h3>
          <p className="text-xs text-text-secondary mb-3">Time-of-day distribution — helps schedule maintenance and closures</p>
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
          <h3 className="text-sm font-semibold mb-1">What Causes Flooding Here</h3>
          <p className="text-xs text-text-secondary mb-3">Rain + high tide compound events are the most dangerous</p>
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

        {/* Duration vs Depth */}
        <div className="bg-bg-card border border-border-card rounded-lg p-4">
          <h3 className="text-sm font-semibold mb-1">How Long Floods Last</h3>
          <p className="text-xs text-text-secondary mb-3">Deeper floods persist longer — identifies areas with poor drainage</p>
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
          <h3 className="text-sm font-semibold mb-1">Sensor Battery Health</h3>
          <p className="text-xs text-text-secondary mb-3">Low batteries cause data gaps — replace before they die</p>
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
