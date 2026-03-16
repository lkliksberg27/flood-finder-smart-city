"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import { Calendar, Loader2, Clock, CloudRain } from "lucide-react";
import { getAllDevices, getFloodEventsInRange } from "@/lib/queries";
import { computeSnapshot } from "@/lib/timeline-utils";
import type { FloodEvent, Device } from "@/lib/types";
import { TimelineControls } from "@/components/TimelineControls";
import { ConditionsPanel } from "@/components/ConditionsPanel";

const DeviceMap = dynamic(
  () => import("@/components/MapContainer").then((m) => m.DeviceMap),
  { ssr: false }
);

type Preset = "24h" | "7d" | "30d" | "all";

function getPresetRange(preset: Preset): { start: Date; end: Date } {
  const end = new Date();
  const start = new Date();
  switch (preset) {
    case "24h":
      start.setHours(start.getHours() - 24);
      break;
    case "7d":
      start.setDate(start.getDate() - 7);
      break;
    case "30d":
      start.setDate(start.getDate() - 30);
      break;
    case "all":
      start.setDate(start.getDate() - 90);
      break;
  }
  return { start, end };
}

export default function FloodEventsPage() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [floodEvents, setFloodEvents] = useState<FloodEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [preset, setPreset] = useState<Preset>("7d");

  const [startTime, setStartTime] = useState(0);
  const [endTime, setEndTime] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);

  const animRef = useRef<number>(0);
  const lastFrameRef = useRef<number>(0);
  const currentTimeRef = useRef(currentTime);
  currentTimeRef.current = currentTime;

  // Load data when preset changes
  const loadData = useCallback(async (p: Preset) => {
    setLoading(true);
    setIsPlaying(false);
    try {
      const { start, end } = getPresetRange(p);
      const [devs, evts] = await Promise.all([
        getAllDevices(),
        getFloodEventsInRange(start.toISOString(), end.toISOString()),
      ]);
      setDevices(devs);
      setFloodEvents(evts);
      setStartTime(start.getTime());
      setEndTime(end.getTime());

      // Start at the first flood event if one exists, otherwise at the start
      if (evts.length > 0) {
        const firstEventTime = new Date(evts[0].started_at).getTime();
        // Go 5 minutes before the first event
        setCurrentTime(Math.max(start.getTime(), firstEventTime - 5 * 60000));
      } else {
        setCurrentTime(start.getTime());
      }
    } catch (err) {
      console.error("Failed to load timeline data:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData(preset);
  }, [preset, loadData]);

  // Animation loop
  useEffect(() => {
    if (!isPlaying) {
      if (animRef.current) cancelAnimationFrame(animRef.current);
      return;
    }

    const animate = (timestamp: number) => {
      if (lastFrameRef.current === 0) lastFrameRef.current = timestamp;
      const deltaMs = timestamp - lastFrameRef.current;
      lastFrameRef.current = timestamp;

      // Each real second advances playbackSpeed minutes of simulation time
      const advance = (deltaMs / 1000) * playbackSpeed * 60000;
      const next = currentTimeRef.current + advance;

      if (next >= endTime) {
        setCurrentTime(endTime);
        setIsPlaying(false);
        return;
      }

      setCurrentTime(next);
      animRef.current = requestAnimationFrame(animate);
    };

    lastFrameRef.current = 0;
    animRef.current = requestAnimationFrame(animate);

    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current);
    };
  }, [isPlaying, playbackSpeed, endTime]);

  // Compute snapshot at current time
  const snapshot = computeSnapshot(currentTime, floodEvents);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-120px)]">
        <div className="text-center">
          <Loader2 size={32} className="animate-spin text-status-blue mx-auto mb-3" />
          <p className="text-sm text-text-secondary">Loading timeline data...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[calc(100vh-32px)]">
      {/* Header with date presets */}
      <div className="flex items-center justify-between mb-3 shrink-0">
        <div className="flex items-center gap-3">
          <Clock size={20} className="text-status-blue" />
          <h2 className="text-xl font-semibold">Flood Timeline</h2>
          <span className="text-xs text-text-secondary bg-bg-card border border-border-card rounded-full px-3 py-1">
            {floodEvents.length} event{floodEvents.length !== 1 ? "s" : ""} in range
          </span>
        </div>

        <div className="flex items-center gap-2">
          <Calendar size={14} className="text-text-secondary" />
          {(["24h", "7d", "30d", "all"] as Preset[]).map((p) => (
            <button
              key={p}
              onClick={() => setPreset(p)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                preset === p
                  ? "bg-status-blue/20 text-status-blue"
                  : "text-text-secondary hover:text-text-primary hover:bg-bg-card-hover"
              }`}
            >
              {p === "24h" ? "24 Hours" : p === "7d" ? "7 Days" : p === "30d" ? "30 Days" : "All Time"}
            </button>
          ))}
        </div>
      </div>

      {/* Map + overlays */}
      <div className="flex-1 relative rounded-lg overflow-hidden border border-border-card">
        <DeviceMap
          devices={devices}
          floodDepths={snapshot.floodDepths}
          height="100%"
        />

        {/* Conditions panel overlay */}
        <ConditionsPanel
          currentTime={currentTime}
          activeCount={snapshot.activeCount}
          totalDevices={devices.length}
          avgRainfall={snapshot.avgRainfall}
          avgTide={snapshot.avgTide}
          maxDepth={snapshot.maxDepth}
        />

        {/* Timeline controls overlay */}
        <TimelineControls
          startTime={startTime}
          endTime={endTime}
          currentTime={currentTime}
          isPlaying={isPlaying}
          playbackSpeed={playbackSpeed}
          onTimeChange={(t) => {
            setCurrentTime(t);
            setIsPlaying(false);
          }}
          onPlayPause={() => setIsPlaying(!isPlaying)}
          onSpeedChange={setPlaybackSpeed}
          floodEvents={floodEvents}
        />

        {/* No events hint */}
        {floodEvents.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="bg-[#111827]/90 backdrop-blur-sm border border-border-card rounded-xl p-6 text-center">
              <CloudRain size={32} className="text-text-secondary mx-auto mb-3" />
              <p className="text-sm text-text-secondary">No flood events in this time range</p>
              <p className="text-xs text-text-secondary mt-1">Try selecting a wider date range</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
