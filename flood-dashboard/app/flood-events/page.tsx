"use client";

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import dynamic from "next/dynamic";
import { Loader2, Clock, CloudRain, ChevronLeft, ChevronRight, MapPin } from "lucide-react";
import { getAllDevices, getFloodEventsInRange, getNeighborhoods } from "@/lib/queries";
import { computeSnapshot } from "@/lib/timeline-utils";
import type { FloodEvent, Device } from "@/lib/types";
import { TimelineControls } from "@/components/TimelineControls";
import { ConditionsPanel } from "@/components/ConditionsPanel";

const DeviceMap = dynamic(
  () => import("@/components/MapContainer").then((m) => m.DeviceMap),
  { ssr: false }
);

/** Get midnight-to-midnight range for a given date string "YYYY-MM-DD" */
function dayRange(dateStr: string): { start: Date; end: Date } {
  const start = new Date(dateStr + "T00:00:00");
  const end = new Date(dateStr + "T23:59:59");
  return { start, end };
}

/** Format Date to "YYYY-MM-DD" for input[type=date] */
function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Shift a date string by N days */
function shiftDay(dateStr: string, delta: number): string {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + delta);
  return toDateStr(d);
}

/** Human-readable day label */
function dayLabel(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  const today = toDateStr(new Date());
  const yesterday = shiftDay(today, -1);
  if (dateStr === today) return "Today";
  if (dateStr === yesterday) return "Yesterday";
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
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
  const { start: dayStart, end: dayEnd } = useMemo(() => dayRange(selectedDate), [selectedDate]);
  const startTime = dayStart.getTime();
  const endTime = dayEnd.getTime();

  // Load all events for a wide range (90 days) once, plus devices and neighborhoods
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

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Filter events for the selected day
  const dayEvents = useMemo(() => {
    return allEvents.filter((e) => {
      const eStart = new Date(e.started_at).getTime();
      const eEnd = e.ended_at ? new Date(e.ended_at).getTime() : Infinity;
      // Event overlaps this day
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

  // Filter devices by neighborhood for map display
  const filteredDevices = useMemo(() => {
    if (!selectedNeighborhood) return devices;
    return devices.filter((d) => d.neighborhood === selectedNeighborhood);
  }, [devices, selectedNeighborhood]);

  // Build set of days that have flood events (for the dot indicators)
  const daysWithEvents = useMemo(() => {
    const days = new Set<string>();
    for (const e of allEvents) {
      days.add(e.started_at.slice(0, 10));
    }
    return days;
  }, [allEvents]);

  // When selected date changes, jump to first event of the day (or midnight)
  useEffect(() => {
    setIsPlaying(false);
    if (filteredEvents.length > 0) {
      const firstEventTime = new Date(filteredEvents[0].started_at).getTime();
      const clampedStart = Math.max(startTime, Math.min(endTime, firstEventTime - 5 * 60000));
      setCurrentTime(clampedStart);
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

    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current);
    };
  }, [isPlaying, playbackSpeed, endTime]);

  // Compute snapshot at current time
  const snapshot = computeSnapshot(currentTime, filteredEvents);

  // Nearby days with events for quick navigation
  const nearbyDays = useMemo(() => {
    const days: string[] = [];
    for (let i = -3; i <= 3; i++) {
      const d = shiftDay(selectedDate, i);
      if (d <= toDateStr(new Date())) days.push(d);
    }
    return days;
  }, [selectedDate]);

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
      {/* Header: date selector + neighborhood filter */}
      <div className="flex items-center justify-between mb-3 shrink-0 flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <Clock size={20} className="text-status-blue" />
          <h2 className="text-xl font-semibold">Flood Timeline</h2>
        </div>

        <div className="flex items-center gap-3">
          {/* Neighborhood filter */}
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

          {/* Date navigation */}
          <div className="flex items-center gap-1">
            <button
              onClick={() => setSelectedDate(shiftDay(selectedDate, -1))}
              className="p-1.5 rounded-lg hover:bg-bg-card-hover transition-colors text-text-secondary hover:text-text-primary"
              title="Previous day"
            >
              <ChevronLeft size={16} />
            </button>
            <input
              type="date"
              value={selectedDate}
              max={toDateStr(new Date())}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="bg-bg-card border border-border-card rounded-lg px-3 py-1.5 text-xs text-text-primary"
            />
            <button
              onClick={() => {
                const next = shiftDay(selectedDate, 1);
                if (next <= toDateStr(new Date())) setSelectedDate(next);
              }}
              disabled={selectedDate >= toDateStr(new Date())}
              className="p-1.5 rounded-lg hover:bg-bg-card-hover transition-colors text-text-secondary hover:text-text-primary disabled:opacity-30"
              title="Next day"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      </div>

      {/* Day chips: quick navigation with event indicators */}
      <div className="flex items-center gap-1.5 mb-3 shrink-0 overflow-x-auto">
        {nearbyDays.map((d) => {
          const hasEvents = daysWithEvents.has(d);
          const isSelected = d === selectedDate;
          const label = dayLabel(d);
          return (
            <button
              key={d}
              onClick={() => setSelectedDate(d)}
              className={`relative px-3 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
                isSelected
                  ? "bg-status-blue/20 text-status-blue"
                  : "text-text-secondary hover:text-text-primary hover:bg-bg-card-hover"
              }`}
            >
              {label}
              {hasEvents && (
                <span
                  className={`absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full ${
                    isSelected ? "bg-status-blue" : "bg-status-amber"
                  }`}
                />
              )}
            </button>
          );
        })}
        <span className="text-[10px] text-text-secondary ml-2">
          {dayEvents.length} event{dayEvents.length !== 1 ? "s" : ""} this day
          {selectedNeighborhood && ` in ${selectedNeighborhood}`}
        </span>
      </div>

      {/* Map + overlays */}
      <div className="flex-1 relative rounded-lg overflow-hidden border border-border-card">
        <DeviceMap
          devices={filteredDevices}
          floodDepths={snapshot.floodDepths}
          height="100%"
        />

        {/* Conditions panel overlay */}
        <ConditionsPanel
          currentTime={currentTime}
          activeCount={snapshot.activeCount}
          totalDevices={filteredDevices.length}
          avgRainfall={snapshot.avgRainfall}
          avgTide={snapshot.avgTide}
          maxDepth={snapshot.maxDepth}
        />

        {/* Timeline controls overlay — always 24h for the selected day */}
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
          floodEvents={filteredEvents}
        />

        {/* No events hint */}
        {filteredEvents.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="bg-[#111827]/90 backdrop-blur-sm border border-border-card rounded-xl p-6 text-center">
              <CloudRain size={32} className="text-text-secondary mx-auto mb-3" />
              <p className="text-sm text-text-secondary">No flood events on {dayLabel(selectedDate)}</p>
              <p className="text-xs text-text-secondary mt-1">
                Try a day with a dot indicator, or change the neighborhood filter
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
