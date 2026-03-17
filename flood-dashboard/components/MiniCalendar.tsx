"use client";

import { useMemo, useState, useRef, useEffect } from "react";
import { ChevronLeft, ChevronRight, Calendar } from "lucide-react";

interface Props {
  selectedDate: string;
  onSelect: (date: string) => void;
  eventDays: Set<string>;
  eventCounts?: Record<string, number>;
}

const DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function toStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function dayLabel(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  const today = toStr(new Date());
  if (dateStr === today) return "Today";
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

export function MiniCalendar({ selectedDate, onSelect, eventDays, eventCounts }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const selParts = selectedDate.split("-").map(Number);
  const [viewYear, setViewYear] = useState(selParts[0]);
  const [viewMonth, setViewMonth] = useState(selParts[1] - 1);

  const today = toStr(new Date());

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Sync view when selectedDate changes externally
  useEffect(() => {
    const parts = selectedDate.split("-").map(Number);
    setViewYear(parts[0]);
    setViewMonth(parts[1] - 1);
  }, [selectedDate]);

  const cells = useMemo(() => {
    const first = new Date(viewYear, viewMonth, 1);
    const startDay = first.getDay();
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const out: { date: string; day: number; inMonth: boolean }[] = [];
    for (let i = 0; i < startDay; i++) {
      const d = new Date(viewYear, viewMonth, -startDay + i + 1);
      out.push({ date: toStr(d), day: d.getDate(), inMonth: false });
    }
    for (let d = 1; d <= daysInMonth; d++) {
      out.push({ date: toStr(new Date(viewYear, viewMonth, d)), day: d, inMonth: true });
    }
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
    month: "long", year: "numeric",
  });

  function dotColor(date: string): string | null {
    if (!eventDays.has(date)) return null;
    const count = eventCounts?.[date] ?? 1;
    if (count >= 5) return "#f87171";
    if (count >= 2) return "#fbbf24";
    return "#34d399";
  }

  const handleSelect = (date: string) => {
    onSelect(date);
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      {/* Trigger button */}
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-3 py-1.5 bg-bg-card border border-border-card rounded-lg text-sm hover:bg-bg-card-hover transition-colors"
      >
        <Calendar size={14} className="text-status-blue" />
        <span className="font-medium">{dayLabel(selectedDate)}</span>
        <ChevronLeft size={12} className={`text-text-secondary transition-transform ${open ? "rotate-90" : "-rotate-90"}`} />
      </button>

      {/* Dropdown calendar */}
      {open && (
        <div className="absolute top-full left-0 mt-1 z-[2000] bg-bg-card border border-border-card rounded-xl p-3 shadow-2xl w-[250px]">
          {/* Month nav */}
          <div className="flex items-center justify-between mb-2">
            <button onClick={prevMonth} className="p-1 rounded hover:bg-bg-card-hover text-text-secondary hover:text-text-primary">
              <ChevronLeft size={14} />
            </button>
            <span className="text-xs font-semibold">{monthLabel}</span>
            <button onClick={nextMonth} className="p-1 rounded hover:bg-bg-card-hover text-text-secondary hover:text-text-primary">
              <ChevronRight size={14} />
            </button>
          </div>

          {/* Day headers */}
          <div className="grid grid-cols-7 gap-0.5 mb-1">
            {DAYS.map((d) => (
              <div key={d} className="text-center text-[10px] text-text-secondary font-medium py-0.5">{d}</div>
            ))}
          </div>

          {/* Cells */}
          <div className="grid grid-cols-7 gap-0.5">
            {cells.map((cell) => {
              const isSelected = cell.date === selectedDate;
              const isToday = cell.date === today;
              const isFuture = cell.date > today;
              const dot = dotColor(cell.date);
              return (
                <button
                  key={cell.date}
                  onClick={() => !isFuture && handleSelect(cell.date)}
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
                  {dot && !isSelected && (
                    <span className="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full" style={{ background: dot }} />
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
              <span className="text-[9px] text-text-secondary">1</span>
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
      )}
    </div>
  );
}
