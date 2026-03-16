"use client";

import { useMemo } from "react";
import { Play, Pause, SkipBack, SkipForward } from "lucide-react";
import type { FloodEvent } from "@/lib/types";
import { generateTimelineTicks } from "@/lib/timeline-utils";

interface Props {
  startTime: number;
  endTime: number;
  isToday?: boolean;
  currentTime: number;
  isPlaying: boolean;
  playbackSpeed: number;
  onTimeChange: (time: number) => void;
  onPlayPause: () => void;
  onSpeedChange: (speed: number) => void;
  floodEvents: FloodEvent[];
}

const SPEEDS = [1, 2, 5, 10];

export function TimelineControls({
  startTime,
  endTime,
  currentTime,
  isPlaying,
  isToday,
  playbackSpeed,
  onTimeChange,
  onPlayPause,
  onSpeedChange,
  floodEvents,
}: Props) {
  const ticks = useMemo(
    () => generateTimelineTicks(startTime, endTime, floodEvents),
    [startTime, endTime, floodEvents]
  );

  const progress = ((currentTime - startTime) / (endTime - startTime)) * 100;
  const currentDate = new Date(currentTime);
  const timeStr = currentDate.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  // Hour labels — adapts to the actual range (handles "today" ending before midnight)
  const hourLabels = useMemo(() => {
    const rangeMs = endTime - startTime;
    const rangeHours = rangeMs / 3600000;
    const step = rangeHours > 18 ? 3 : rangeHours > 8 ? 2 : 1;
    const startHour = new Date(startTime).getHours();
    const endHour = startHour + rangeHours;
    const out: { pos: number; label: string }[] = [];
    for (let h = startHour; h <= endHour; h += step) {
      const pos = ((h - startHour) / rangeHours) * 100;
      if (pos > 95) break; // leave room for "Now" label
      const hr = h % 24;
      const ampm = hr === 0 ? "12 AM" : hr === 12 ? "12 PM" : hr < 12 ? `${hr} AM` : `${hr - 12} PM`;
      out.push({ pos, label: ampm });
    }
    // Add "Now" at the end if today
    if (isToday) {
      out.push({ pos: 100, label: "Now" });
    }
    return out;
  }, [startTime, endTime, isToday]);

  return (
    <div className="absolute bottom-4 left-4 right-4 z-[1000]">
      <div className="bg-[#111827]/95 backdrop-blur-sm border border-border-card rounded-xl px-4 py-3 shadow-2xl">
        <div className="flex items-center gap-3">
          {/* Play controls */}
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={() => onTimeChange(startTime)}
              className="p-1.5 rounded-lg hover:bg-bg-card-hover transition-colors text-text-secondary hover:text-text-primary"
              title="Jump to midnight"
            >
              <SkipBack size={14} />
            </button>
            <button
              onClick={onPlayPause}
              className="p-2 rounded-lg bg-status-blue/20 text-status-blue hover:bg-status-blue/30 transition-colors"
              title={isPlaying ? "Pause" : "Play"}
            >
              {isPlaying ? <Pause size={16} /> : <Play size={16} />}
            </button>
            <button
              onClick={() => onTimeChange(endTime)}
              className="p-1.5 rounded-lg hover:bg-bg-card-hover transition-colors text-text-secondary hover:text-text-primary"
              title="Jump to end of day"
            >
              <SkipForward size={14} />
            </button>
          </div>

          {/* Timeline slider — 24 hour range */}
          <div className="flex-1 min-w-0">
            <div className="relative h-6 flex items-center">
              {/* Track background */}
              <div className="absolute inset-x-0 h-1.5 bg-[#1f2937] rounded-full">
                {/* Progress fill */}
                <div
                  className="h-full bg-status-blue/40 rounded-full transition-[width] duration-75"
                  style={{ width: `${progress}%` }}
                />
              </div>

              {/* Event tick marks */}
              {ticks.map((tick, i) => (
                <div
                  key={i}
                  className="absolute w-1 h-3 rounded-sm -translate-x-0.5"
                  style={{
                    left: `${tick.position * 100}%`,
                    top: "50%",
                    marginTop: "-6px",
                    background:
                      tick.severity === "high" ? "#f87171" :
                      tick.severity === "medium" ? "#fbbf24" : "#34d399",
                    opacity: 0.7,
                  }}
                />
              ))}

              {/* Range input */}
              <input
                type="range"
                min={startTime}
                max={endTime}
                value={currentTime}
                onChange={(e) => onTimeChange(Number(e.target.value))}
                className="timeline-slider absolute inset-x-0 w-full cursor-pointer"
                step={60000}
              />
            </div>

            {/* Hour labels */}
            <div className="relative h-4 mt-0.5">
              {hourLabels.map((l, i) => (
                <span
                  key={i}
                  className="absolute text-[10px] text-text-secondary -translate-x-1/2 select-none"
                  style={{ left: `${l.pos}%` }}
                >
                  {l.label}
                </span>
              ))}
            </div>
          </div>

          {/* Speed selector */}
          <div className="flex items-center gap-1 shrink-0">
            {SPEEDS.map((s) => (
              <button
                key={s}
                onClick={() => onSpeedChange(s)}
                className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                  playbackSpeed === s
                    ? "bg-status-blue/20 text-status-blue"
                    : "text-text-secondary hover:text-text-primary hover:bg-bg-card-hover"
                }`}
              >
                {s}x
              </button>
            ))}
          </div>

          {/* Current time display */}
          <div className="text-right shrink-0 min-w-[70px]">
            <p className="text-sm font-bold text-text-primary">{timeStr}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
