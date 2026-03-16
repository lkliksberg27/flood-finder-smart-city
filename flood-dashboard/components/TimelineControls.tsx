"use client";

import { useMemo } from "react";
import { Play, Pause, SkipBack, SkipForward } from "lucide-react";
import type { FloodEvent } from "@/lib/types";
import { generateTimelineTicks, formatTimestamp } from "@/lib/timeline-utils";

interface Props {
  startTime: number;
  endTime: number;
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

  const { date, time } = formatTimestamp(currentTime);
  const progress = ((currentTime - startTime) / (endTime - startTime)) * 100;

  // Date labels for the timeline axis
  const range = endTime - startTime;
  const labelCount = range > 7 * 86400000 ? 5 : range > 86400000 ? 4 : 6;
  const labels = useMemo(() => {
    const out: { pos: number; label: string }[] = [];
    for (let i = 0; i <= labelCount; i++) {
      const t = startTime + (range / labelCount) * i;
      const d = new Date(t);
      const label = range > 2 * 86400000
        ? d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
        : d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
      out.push({ pos: (i / labelCount) * 100, label });
    }
    return out;
  }, [startTime, range, labelCount]);

  return (
    <div className="absolute bottom-4 left-4 right-4 z-[1000]">
      <div className="bg-[#111827]/95 backdrop-blur-sm border border-border-card rounded-xl px-4 py-3 shadow-2xl">
        <div className="flex items-center gap-3">
          {/* Play controls */}
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={() => onTimeChange(startTime)}
              className="p-1.5 rounded-lg hover:bg-bg-card-hover transition-colors text-text-secondary hover:text-text-primary"
              title="Jump to start"
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
              title="Jump to end"
            >
              <SkipForward size={14} />
            </button>
          </div>

          {/* Timeline slider */}
          <div className="flex-1 min-w-0">
            {/* Slider track with event ticks */}
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
                    opacity: 0.6,
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

            {/* Date labels */}
            <div className="relative h-4 mt-0.5">
              {labels.map((l, i) => (
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

          {/* Current timestamp */}
          <div className="text-right shrink-0 min-w-[80px]">
            <p className="text-xs font-medium text-text-primary">{date}</p>
            <p className="text-[11px] text-text-secondary">{time}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
