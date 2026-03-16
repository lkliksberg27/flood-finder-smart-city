"use client";

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

interface Props {
  selectedDate: string; // "YYYY-MM-DD"
  onSelect: (date: string) => void;
  eventDays: Set<string>; // set of "YYYY-MM-DD" that have flood events
  eventCounts?: Record<string, number>; // "YYYY-MM-DD" → event count (for intensity)
}

const DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function toStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function MiniCalendar({ selectedDate, onSelect, eventDays, eventCounts }: Props) {
  const selParts = selectedDate.split("-").map(Number);
  const [viewYear, setViewYear] = useState(selParts[0]);
  const [viewMonth, setViewMonth] = useState(selParts[1] - 1); // 0-indexed

  const today = toStr(new Date());

  const cells = useMemo(() => {
    const first = new Date(viewYear, viewMonth, 1);
    const startDay = first.getDay(); // 0=Sun
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();

    const out: { date: string; day: number; inMonth: boolean }[] = [];

    // Padding from previous month
    for (let i = 0; i < startDay; i++) {
      const d = new Date(viewYear, viewMonth, -startDay + i + 1);
      out.push({ date: toStr(d), day: d.getDate(), inMonth: false });
    }
    // This month
    for (let d = 1; d <= daysInMonth; d++) {
      out.push({ date: toStr(new Date(viewYear, viewMonth, d)), day: d, inMonth: true });
    }
    // Pad to fill last row
    const remaining = 7 - (out.length % 7);
    if (remaining < 7) {
      for (let i = 1; i <= remaining; i++) {
        const d = new Date(viewYear, viewMonth + 1, i);
        out.push({ date: toStr(d), day: d.getDate(), inMonth: false });
      }
    }
    return out;
  }, [viewYear, viewMonth]);

  const prevMonth = () => {
    if (viewMonth === 0) { setViewYear(viewYear - 1); setViewMonth(11); }
    else setViewMonth(viewMonth - 1);
  };

  const nextMonth = () => {
    if (viewMonth === 11) { setViewYear(viewYear + 1); setViewMonth(0); }
    else setViewMonth(viewMonth + 1);
  };

  const monthLabel = new Date(viewYear, viewMonth).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });

  function dotColor(date: string): string | null {
    if (!eventDays.has(date)) return null;
    const count = eventCounts?.[date] ?? 1;
    if (count >= 5) return "#f87171"; // red — heavy
    if (count >= 2) return "#fbbf24"; // amber — moderate
    return "#34d399"; // green — light
  }

  return (
    <div className="bg-bg-card border border-border-card rounded-xl p-3 w-[260px] shrink-0">
      {/* Month nav */}
      <div className="flex items-center justify-between mb-2">
        <button onClick={prevMonth} className="p-1 rounded hover:bg-bg-card-hover transition-colors text-text-secondary hover:text-text-primary">
          <ChevronLeft size={14} />
        </button>
        <span className="text-xs font-semibold text-text-primary">{monthLabel}</span>
        <button onClick={nextMonth} className="p-1 rounded hover:bg-bg-card-hover transition-colors text-text-secondary hover:text-text-primary">
          <ChevronRight size={14} />
        </button>
      </div>

      {/* Day headers */}
      <div className="grid grid-cols-7 gap-0.5 mb-1">
        {DAYS.map((d) => (
          <div key={d} className="text-center text-[10px] text-text-secondary font-medium py-0.5">
            {d}
          </div>
        ))}
      </div>

      {/* Date cells */}
      <div className="grid grid-cols-7 gap-0.5">
        {cells.map((cell) => {
          const isSelected = cell.date === selectedDate;
          const isToday = cell.date === today;
          const isFuture = cell.date > today;
          const dot = dotColor(cell.date);

          return (
            <button
              key={cell.date}
              onClick={() => !isFuture && onSelect(cell.date)}
              disabled={isFuture}
              className={`
                relative h-7 rounded text-[11px] font-medium transition-all
                ${!cell.inMonth ? "text-text-secondary/30" : ""}
                ${cell.inMonth && !isSelected && !isFuture ? "text-text-primary hover:bg-bg-card-hover" : ""}
                ${isSelected ? "bg-status-blue text-white" : ""}
                ${isToday && !isSelected ? "ring-1 ring-status-blue/50" : ""}
                ${isFuture ? "opacity-20 cursor-not-allowed" : "cursor-pointer"}
              `}
            >
              {cell.day}
              {/* Event indicator dot */}
              {dot && !isSelected && (
                <span
                  className="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full"
                  style={{ background: dot }}
                />
              )}
              {dot && isSelected && (
                <span className="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-white/80" />
              )}
            </button>
          );
        })}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-3 mt-2 pt-2 border-t border-border-card justify-center">
        <div className="flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-[#34d399]" />
          <span className="text-[9px] text-text-secondary">1 event</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-[#fbbf24]" />
          <span className="text-[9px] text-text-secondary">2-4</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-[#f87171]" />
          <span className="text-[9px] text-text-secondary">5+</span>
        </div>
      </div>
    </div>
  );
}
