"use client";

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import dynamic from "next/dynamic";
import { Loader2, Clock, CloudRain, MapPin, ChevronLeft, ChevronRight } from "lucide-react";
import { getAllDevices, getFloodEventsInRange, getNeighborhoods } from "@/lib/queries";
import { computeSnapshot } from "@/lib/timeline-utils";
import type { FloodEvent, Device } from "@/lib/types";
import { TimelineControls } from "@/components/TimelineControls";
import { ConditionsPanel } from "@/components/ConditionsPanel";
import { MiniCalendar } from "@/components/MiniCalendar";
import { DayInsights } from "@/components/DayInsights";
import { OverallTrends } from "@/components/OverallTrends";

const DeviceMap = dynamic(
  () => import("@/components/MapContainer").then((m) => m.DeviceMap),
  { ssr: false }
);

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function shiftDay(dateStr: string, delta: number): string {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + delta);
  return toDateStr(d);
}

export default function FloodEventsPage() {
  useEffect(() => { document.title = "Flood Events — Flood Finder"; }, []);
  const [devices, setDevices] = useState<Device[]>([]);
  const [allEvents, setAllEvents] = useState<FloodEvent[]>([]);
  const [neighborhoods, setNeighborhoods] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  const [selectedDate, setSelectedDate] = useState(toDateStr(new Date()));
  const [selectedNeighborhood, setSelectedNeighborhood] = useState("");

  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);

  const animRef = useRef<number>(0);
  const lastFrameRef = useRef<number>(0);
  const currentTimeRef = useRef(currentTime);
  currentTimeRef.current = currentTime;

  const today = toDateStr(new Date());
  const isToday = selectedDate === today;
  const startTime = useMemo(() => new Date(selectedDate + "T00:00:00").getTime(), [selectedDate]);
  const endTime = useMemo(() => {
    if (selectedDate === today) return Date.now();
    return new Date(selectedDate + "T23:59:59").getTime();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDate]);

  // Load all data once
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

  const dayEvents = useMemo(() => {
    return allEvents.filter((e) => {
      const eStart = new Date(e.started_at).getTime();
      const eEnd = e.ended_at ? new Date(e.ended_at).getTime() : Infinity;
      return eStart <= endTime && eEnd >= startTime;
    });
  }, [allEvents, startTime, endTime]);

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

  useEffect(() => {
    setIsPlaying(false);
    if (filteredEvents.length > 0) {
      const firstEventTime = new Date(filteredEvents[0].started_at).getTime();
      setCurrentTime(Math.max(startTime, Math.min(endTime, firstEventTime - 5 * 60000)));
    } else {
      setCurrentTime(startTime);
    }
  }, [selectedDate, selectedNeighborhood, filteredEvents.length, startTime, endTime]);

  // Animation
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
      if (next >= endTime) { setCurrentTime(endTime); setIsPlaying(false); return; }
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
      {/* Compact header: title + calendar + day nav + neighborhood */}
      <div className="flex items-center gap-3 mb-2 shrink-0 flex-wrap">
        <Clock size={18} className="text-status-blue shrink-0" />
        <h2 className="text-lg font-semibold shrink-0">Flood Timeline</h2>

        {/* Calendar dropdown */}
        <MiniCalendar
          selectedDate={selectedDate}
          onSelect={setSelectedDate}
          eventDays={eventDays}
          eventCounts={eventCounts}
        />

        {/* Prev/next day */}
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => setSelectedDate(shiftDay(selectedDate, -1))}
            className="p-1 rounded hover:bg-bg-card-hover text-text-secondary hover:text-text-primary"
          >
            <ChevronLeft size={14} />
          </button>
          <button
            onClick={() => { if (shiftDay(selectedDate, 1) <= today) setSelectedDate(shiftDay(selectedDate, 1)); }}
            disabled={selectedDate >= today}
            className="p-1 rounded hover:bg-bg-card-hover text-text-secondary hover:text-text-primary disabled:opacity-30"
          >
            <ChevronRight size={14} />
          </button>
        </div>

        <span className="text-xs text-text-secondary">
          {filteredEvents.length} event{filteredEvents.length !== 1 ? "s" : ""}
        </span>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Neighborhood filter */}
        <div className="flex items-center gap-1.5 shrink-0">
          <MapPin size={13} className="text-text-secondary" />
          <select
            value={selectedNeighborhood}
            onChange={(e) => setSelectedNeighborhood(e.target.value)}
            className="bg-bg-card border border-border-card rounded-lg px-2.5 py-1 text-xs text-text-primary"
          >
            <option value="">All Areas</option>
            {neighborhoods.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Full-width map */}
      <div className="flex-1 relative rounded-lg overflow-hidden border border-border-card shrink-0" style={{ minHeight: "400px" }}>
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
          isToday={isToday}
          playbackSpeed={playbackSpeed}
          onTimeChange={(t) => { setCurrentTime(t); setIsPlaying(false); }}
          onPlayPause={() => setIsPlaying(!isPlaying)}
          onSpeedChange={setPlaybackSpeed}
          floodEvents={filteredEvents}
        />

        {filteredEvents.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="bg-[#111827]/90 backdrop-blur-sm border border-border-card rounded-xl p-6 text-center">
              <CloudRain size={28} className="text-text-secondary mx-auto mb-2" />
              <p className="text-sm text-text-secondary">No floods on this day</p>
              <p className="text-xs text-text-secondary mt-1">Pick a day with a dot on the calendar</p>
            </div>
          </div>
        )}
      </div>

      {/* Day Insights */}
      <div className="mt-3 shrink-0">
        <DayInsights dayStart={startTime} dayEnd={endTime} events={filteredEvents} />
      </div>

      {/* Overall Trends */}
      <div className="mt-3 shrink-0 pb-4">
        <OverallTrends
          events={selectedNeighborhood
            ? allEvents.filter((e) => (e.devices as Device | undefined)?.neighborhood === selectedNeighborhood)
            : allEvents
          }
          neighborhood={selectedNeighborhood}
        />
      </div>
    </div>
  );
}
