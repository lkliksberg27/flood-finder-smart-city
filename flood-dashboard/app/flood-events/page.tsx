"use client";

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import dynamic from "next/dynamic";
import { Loader2, Clock, CloudRain, MapPin } from "lucide-react";
import { getAllDevices, getFloodEventsInRange, getNeighborhoods } from "@/lib/queries";
import { computeSnapshot } from "@/lib/timeline-utils";
import type { FloodEvent, Device } from "@/lib/types";
import { TimelineControls } from "@/components/TimelineControls";
import { ConditionsPanel } from "@/components/ConditionsPanel";
import { MiniCalendar } from "@/components/MiniCalendar";
import { DayInsights } from "@/components/DayInsights";

const DeviceMap = dynamic(
  () => import("@/components/MapContainer").then((m) => m.DeviceMap),
  { ssr: false }
);

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function dayLabel(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  const today = toDateStr(new Date());
  if (dateStr === today) return "Today";
  return d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
}

export default function FloodEventsPage() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [allEvents, setAllEvents] = useState<FloodEvent[]>([]);
  const [neighborhoods, setNeighborhoods] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  // Filters
  const [selectedDate, setSelectedDate] = useState(toDateStr(new Date()));
  const [selectedNeighborhood, setSelectedNeighborhood] = useState("");

  // Timeline state
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);

  const animRef = useRef<number>(0);
  const lastFrameRef = useRef<number>(0);
  const currentTimeRef = useRef(currentTime);
  currentTimeRef.current = currentTime;

  // Compute day boundaries
  const startTime = useMemo(() => new Date(selectedDate + "T00:00:00").getTime(), [selectedDate]);
  const endTime = useMemo(() => new Date(selectedDate + "T23:59:59").getTime(), [selectedDate]);

  // Load all data once (90 days)
  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const ninetyDaysAgo = new Date();
      ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
      const [devs, evts, hoods] = await Promise.all([
        getAllDevices(),
        getFloodEventsInRange(ninetyDaysAgo.toISOString(), new Date().toISOString()),
        getNeighborhoods(),
      ]);
      setDevices(devs);
      setAllEvents(evts);
      setNeighborhoods(hoods);
    } catch (err) {
      console.error("Failed to load timeline data:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // Filter events for the selected day
  const dayEvents = useMemo(() => {
    return allEvents.filter((e) => {
      const eStart = new Date(e.started_at).getTime();
      const eEnd = e.ended_at ? new Date(e.ended_at).getTime() : Infinity;
      return eStart <= endTime && eEnd >= startTime;
    });
  }, [allEvents, startTime, endTime]);

  // Filter by neighborhood
  const filteredEvents = useMemo(() => {
    if (!selectedNeighborhood) return dayEvents;
    return dayEvents.filter((e) => {
      const dev = e.devices as Device | undefined;
      return dev?.neighborhood === selectedNeighborhood;
    });
  }, [dayEvents, selectedNeighborhood]);

  const filteredDevices = useMemo(() => {
    if (!selectedNeighborhood) return devices;
    return devices.filter((d) => d.neighborhood === selectedNeighborhood);
  }, [devices, selectedNeighborhood]);

  // Calendar data: which days have events + counts
  const { eventDays, eventCounts } = useMemo(() => {
    const days = new Set<string>();
    const counts: Record<string, number> = {};
    for (const e of allEvents) {
      const day = e.started_at.slice(0, 10);
      days.add(day);
      counts[day] = (counts[day] || 0) + 1;
    }
    return { eventDays: days, eventCounts: counts };
  }, [allEvents]);

  // Jump to first event when changing date/neighborhood
  useEffect(() => {
    setIsPlaying(false);
    if (filteredEvents.length > 0) {
      const firstEventTime = new Date(filteredEvents[0].started_at).getTime();
      setCurrentTime(Math.max(startTime, Math.min(endTime, firstEventTime - 5 * 60000)));
    } else {
      setCurrentTime(startTime);
    }
  }, [selectedDate, selectedNeighborhood, filteredEvents.length, startTime, endTime]);

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
    return () => { if (animRef.current) cancelAnimationFrame(animRef.current); };
  }, [isPlaying, playbackSpeed, endTime]);

  const snapshot = computeSnapshot(currentTime, filteredEvents);

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
    <div className="flex flex-col h-[calc(100vh-32px)] overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-3 shrink-0">
        <div className="flex items-center gap-3">
          <Clock size={20} className="text-status-blue" />
          <h2 className="text-xl font-semibold">Flood Timeline</h2>
          <span className="text-xs text-text-secondary">
            {dayLabel(selectedDate)}
            {selectedNeighborhood && ` — ${selectedNeighborhood}`}
            {" · "}
            {filteredEvents.length} event{filteredEvents.length !== 1 ? "s" : ""}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <MapPin size={14} className="text-text-secondary" />
          <select
            value={selectedNeighborhood}
            onChange={(e) => setSelectedNeighborhood(e.target.value)}
            className="bg-bg-card border border-border-card rounded-lg px-3 py-1.5 text-xs text-text-primary"
          >
            <option value="">All Neighborhoods</option>
            {neighborhoods.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Main content: Calendar + Map */}
      <div className="flex gap-3 shrink-0" style={{ minHeight: 0 }}>
        {/* Calendar sidebar */}
        <MiniCalendar
          selectedDate={selectedDate}
          onSelect={setSelectedDate}
          eventDays={eventDays}
          eventCounts={eventCounts}
        />

        {/* Map + timeline */}
        <div className="flex-1 relative rounded-lg overflow-hidden border border-border-card" style={{ minHeight: "380px" }}>
          <DeviceMap
            devices={filteredDevices}
            floodDepths={snapshot.floodDepths}
            height="100%"
          />

          <ConditionsPanel
            currentTime={currentTime}
            activeCount={snapshot.activeCount}
            totalDevices={filteredDevices.length}
            avgRainfall={snapshot.avgRainfall}
            avgTide={snapshot.avgTide}
            maxDepth={snapshot.maxDepth}
          />

          <TimelineControls
            startTime={startTime}
            endTime={endTime}
            currentTime={currentTime}
            isPlaying={isPlaying}
            playbackSpeed={playbackSpeed}
            onTimeChange={(t) => { setCurrentTime(t); setIsPlaying(false); }}
            onPlayPause={() => setIsPlaying(!isPlaying)}
            onSpeedChange={setPlaybackSpeed}
            floodEvents={filteredEvents}
          />

          {filteredEvents.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="bg-[#111827]/90 backdrop-blur-sm border border-border-card rounded-xl p-6 text-center">
                <CloudRain size={32} className="text-text-secondary mx-auto mb-3" />
                <p className="text-sm text-text-secondary">No flood events on {dayLabel(selectedDate)}</p>
                <p className="text-xs text-text-secondary mt-1">Pick a day with a colored dot on the calendar</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Day Insights — charts below the map */}
      <div className="mt-3 shrink-0 pb-4">
        <DayInsights
          dayStart={startTime}
          dayEnd={endTime}
          events={filteredEvents}
        />
      </div>
    </div>
  );
}
