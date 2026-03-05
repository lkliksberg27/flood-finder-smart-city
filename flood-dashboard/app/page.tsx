"use client";

import { useEffect, useState, useCallback } from "react";
import dynamic from "next/dynamic";
import { Radio, AlertTriangle, Battery, Clock } from "lucide-react";
import { getSupabase } from "@/lib/supabase";
import { getAllDevices, getActiveFloodEvents } from "@/lib/queries";
import { StatCard } from "@/components/StatCard";
import type { Device, FloodEvent } from "@/lib/types";

const DeviceMap = dynamic(
  () => import("@/components/MapContainer").then((m) => m.DeviceMap),
  { ssr: false }
);

export default function OverviewPage() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [activeEvents, setActiveEvents] = useState<FloodEvent[]>([]);
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());
  const [selectedDevice, setSelectedDevice] = useState<string | null>(null);

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

  // Realtime subscription for device changes
  useEffect(() => {
    const channel = getSupabase()
      .channel("overview-devices")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "devices" },
        () => fetchData()
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "flood_events" },
        () => fetchData()
      )
      .subscribe();

    return () => {
      getSupabase().removeChannel(channel);
    };
  }, [fetchData]);

  const online = devices.filter((d) => d.status !== "offline").length;
  const offline = devices.filter((d) => d.status === "offline").length;
  const avgBattery =
    devices.length > 0
      ? (devices.reduce((s, d) => s + (d.battery_v ?? 0), 0) / devices.length).toFixed(1)
      : "N/A";

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
          <StatCard
            label="Online"
            value={online}
            icon={<Radio size={16} />}
            color="text-status-green"
          />
          <StatCard
            label="Offline"
            value={offline}
            icon={<Radio size={16} />}
            color={offline > 0 ? "text-status-red" : "text-text-secondary"}
          />
          <StatCard
            label="Active Floods"
            value={activeEvents.length}
            icon={<AlertTriangle size={16} />}
            color={activeEvents.length > 0 ? "text-status-red" : "text-status-green"}
          />
          <StatCard
            label="Avg Battery"
            value={`${avgBattery}V`}
            icon={<Battery size={16} />}
          />
        </div>

        {/* Active flood events list */}
        {activeEvents.length > 0 && (
          <div className="bg-bg-card border border-border-card rounded-lg p-4">
            <h3 className="text-sm font-semibold text-status-red mb-3">
              Active Flood Events
            </h3>
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

        <div className="flex items-center gap-2 text-xs text-text-secondary mt-auto">
          <Clock size={12} />
          Updated {lastUpdated.toLocaleTimeString()}
        </div>
      </div>
    </div>
  );
}
