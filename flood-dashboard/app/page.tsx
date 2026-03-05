"use client";

import { useEffect, useState, useCallback } from "react";
import dynamic from "next/dynamic";
import { Radio, AlertTriangle, Battery, Clock, CloudRain, Waves, Thermometer, Droplets } from "lucide-react";
import { getSupabase } from "@/lib/supabase";
import { getAllDevices, getActiveFloodEvents } from "@/lib/queries";
import { StatCard } from "@/components/StatCard";
import type { Device, FloodEvent } from "@/lib/types";

const DeviceMap = dynamic(
  () => import("@/components/MapContainer").then((m) => m.DeviceMap),
  { ssr: false }
);

interface WeatherData {
  temperature: number | null;
  humidity: number | null;
  rainfallMm: number;
  description: string;
  tideLevel: number | null;
  forecast: { name: string; shortForecast: string; rainChance: number | null }[];
  tideForecast: { time: string; level: number }[];
}

export default function OverviewPage() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [activeEvents, setActiveEvents] = useState<FloodEvent[]>([]);
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());
  const [selectedDevice, setSelectedDevice] = useState<string | null>(null);
  const [weather, setWeather] = useState<WeatherData | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [devs, events] = await Promise.all([
        getAllDevices(),
        getActiveFloodEvents(),
      ]);
      setDevices(devs);
      setActiveEvents(events);
      setLastUpdated(new Date());
    } catch (err) {
      console.error("Failed to fetch overview data:", err);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  // Fetch weather
  useEffect(() => {
    async function loadWeather() {
      try {
        const res = await fetch("/api/weather");
        if (res.ok) setWeather(await res.json());
      } catch {
        // weather is optional
      }
    }
    loadWeather();
    const interval = setInterval(loadWeather, 600000); // every 10 min
    return () => clearInterval(interval);
  }, []);

  // Realtime subscription
  useEffect(() => {
    const channel = getSupabase()
      .channel("overview-devices")
      .on("postgres_changes", { event: "*", schema: "public", table: "devices" }, () => fetchData())
      .on("postgres_changes", { event: "*", schema: "public", table: "flood_events" }, () => fetchData())
      .subscribe();
    return () => { getSupabase().removeChannel(channel); };
  }, [fetchData]);

  const online = devices.filter((d) => d.status !== "offline").length;
  const offline = devices.filter((d) => d.status === "offline").length;
  const avgBattery =
    devices.length > 0
      ? (devices.reduce((s, d) => s + (d.battery_v ?? 0), 0) / devices.length).toFixed(1)
      : "N/A";

  // Find upcoming rain risk from forecast
  const rainForecast = weather?.forecast?.find((f) => (f.rainChance ?? 0) > 30);

  return (
    <div className="flex gap-6 h-[calc(100vh-48px)]">
      {/* Map */}
      <div className="flex-1 rounded-lg overflow-hidden border border-border-card">
        <DeviceMap
          devices={devices}
          onDeviceClick={(d) => setSelectedDevice(d.device_id)}
          highlightDeviceId={selectedDevice}
        />
      </div>

      {/* Sidebar stats */}
      <div className="w-[320px] flex flex-col gap-4 overflow-y-auto">
        <h2 className="text-lg font-semibold">Live Overview</h2>

        <div className="grid grid-cols-2 gap-3">
          <StatCard label="Online" value={online} icon={<Radio size={16} />} color="text-status-green" />
          <StatCard label="Offline" value={offline} icon={<Radio size={16} />} color={offline > 0 ? "text-status-red" : "text-text-secondary"} />
          <StatCard label="Active Floods" value={activeEvents.length} icon={<AlertTriangle size={16} />} color={activeEvents.length > 0 ? "text-status-red" : "text-status-green"} />
          <StatCard label="Avg Battery" value={`${avgBattery}V`} icon={<Battery size={16} />} />
        </div>

        {/* Weather panel */}
        {weather && (
          <div className="bg-bg-card border border-border-card rounded-lg p-4">
            <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
              <CloudRain size={14} /> Current Weather
            </h3>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="flex items-center gap-2">
                <Thermometer size={12} className="text-status-amber" />
                <span>{weather.temperature != null ? `${weather.temperature}°F` : "—"}</span>
              </div>
              <div className="flex items-center gap-2">
                <Droplets size={12} className="text-status-blue" />
                <span>{weather.humidity != null ? `${weather.humidity}%` : "—"}</span>
              </div>
              <div className="flex items-center gap-2">
                <CloudRain size={12} className="text-status-blue" />
                <span>{weather.rainfallMm > 0 ? `${weather.rainfallMm}mm/hr` : "No rain"}</span>
              </div>
              <div className="flex items-center gap-2">
                <Waves size={12} className="text-status-green" />
                <span>{weather.tideLevel != null ? `${weather.tideLevel.toFixed(2)}m` : "—"}</span>
              </div>
            </div>
            <p className="text-xs text-text-secondary mt-2">{weather.description}</p>

            {/* Tide forecast sparkline */}
            {weather.tideForecast && weather.tideForecast.length > 2 && (() => {
              const levels = weather.tideForecast.map((t) => t.level);
              const min = Math.min(...levels);
              const max = Math.max(...levels);
              const range = max - min || 1;
              const w = 260, h = 32;
              const points = levels.map((v, i) => {
                const x = (i / (levels.length - 1)) * w;
                const y = h - ((v - min) / range) * (h - 4) - 2;
                return `${x},${y}`;
              }).join(" ");
              const peakTide = Math.max(...levels);
              return (
                <div className="mt-3">
                  <div className="flex items-center justify-between text-xs text-text-secondary mb-1">
                    <span>24h Tide Forecast</span>
                    <span>Peak: {peakTide.toFixed(2)}m</span>
                  </div>
                  <svg width={w} height={h} className="w-full">
                    {peakTide > 0.3 && (
                      <line x1="0" y1={h - ((0.3 - min) / range) * (h - 4) - 2} x2={w} y2={h - ((0.3 - min) / range) * (h - 4) - 2} stroke="#f87171" strokeWidth="0.5" strokeDasharray="3 3" opacity={0.5} />
                    )}
                    <polyline points={points} fill="none" stroke="#34d399" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
              );
            })()}

            {/* Rain alert */}
            {rainForecast && (
              <div className="mt-3 p-2 bg-status-amber/10 border border-status-amber/20 rounded text-xs">
                <span className="text-status-amber font-medium">Rain expected: </span>
                <span className="text-text-secondary">
                  {rainForecast.name} — {rainForecast.shortForecast} ({rainForecast.rainChance}% chance)
                </span>
              </div>
            )}

            {/* Compound event warning */}
            {rainForecast && weather.tideForecast && Math.max(...weather.tideForecast.map((t) => t.level)) > 0.3 && (
              <div className="mt-2 p-2 bg-status-red/10 border border-status-red/20 rounded text-xs">
                <span className="text-status-red font-medium">Compound flood risk: </span>
                <span className="text-text-secondary">
                  Rain + high tide expected simultaneously — storm drains may not discharge
                </span>
              </div>
            )}
          </div>
        )}

        {/* Active flood events */}
        {activeEvents.length > 0 && (
          <div className="bg-bg-card border border-border-card rounded-lg p-4">
            <h3 className="text-sm font-semibold text-status-red mb-3">Active Flood Events</h3>
            <div className="space-y-2">
              {activeEvents.map((event) => (
                <button
                  key={event.id}
                  onClick={() => setSelectedDevice(event.device_id)}
                  className="w-full text-left bg-status-red/10 border border-status-red/20 rounded p-2 hover:bg-status-red/20 transition-colors"
                >
                  <div className="flex justify-between text-sm">
                    <span className="font-medium">{event.device_id}</span>
                    <span className="text-status-red">{event.peak_depth_cm}cm</span>
                  </div>
                  <p className="text-xs text-text-secondary mt-0.5">
                    Started {new Date(event.started_at).toLocaleTimeString()}
                    {event.devices?.neighborhood && ` — ${event.devices.neighborhood}`}
                  </p>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Network health */}
        {devices.length > 0 && (() => {
          const staleCount = devices.filter((d) => {
            if (!d.last_seen) return true;
            return Date.now() - new Date(d.last_seen).getTime() > 2 * 3600 * 1000;
          }).length;
          const healthPct = Math.round(((devices.length - staleCount) / devices.length) * 100);
          return (
            <div className="bg-bg-card border border-border-card rounded-lg p-3">
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="text-text-secondary">Network Health</span>
                <span className={healthPct > 90 ? "text-status-green" : healthPct > 70 ? "text-status-amber" : "text-status-red"}>
                  {healthPct}%
                </span>
              </div>
              <div className="w-full h-1.5 bg-bg-primary rounded overflow-hidden">
                <div
                  className={`h-full rounded ${healthPct > 90 ? "bg-status-green" : healthPct > 70 ? "bg-status-amber" : "bg-status-red"}`}
                  style={{ width: `${healthPct}%` }}
                />
              </div>
              {staleCount > 0 && (
                <p className="text-[10px] text-text-secondary mt-1">{staleCount} sensor{staleCount > 1 ? "s" : ""} offline &gt;2h</p>
              )}
            </div>
          );
        })()}

        <div className="flex items-center gap-2 text-xs text-text-secondary mt-auto">
          <Clock size={12} />
          Updated {lastUpdated.toLocaleTimeString()}
        </div>
      </div>
    </div>
  );
}
