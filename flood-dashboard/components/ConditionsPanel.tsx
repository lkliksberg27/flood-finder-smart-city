"use client";

import { Droplets, Waves, AlertTriangle, CloudRain } from "lucide-react";
import { formatTimestamp } from "@/lib/timeline-utils";

interface Props {
  currentTime: number;
  activeCount: number;
  totalDevices: number;
  avgRainfall: number;
  avgTide: number;
  maxDepth: number;
}

export function ConditionsPanel({
  currentTime,
  activeCount,
  totalDevices,
  avgRainfall,
  avgTide,
  maxDepth,
}: Props) {
  const { full } = formatTimestamp(currentTime);
  const isCompound = avgRainfall > 0 && avgTide > 0.3;

  if (activeCount === 0) {
    return (
      <div className="absolute top-3 right-3 z-[1000]">
        <div className="bg-[#111827]/90 backdrop-blur-sm border border-border-card rounded-lg px-3 py-2 shadow-lg">
          <p className="text-[10px] text-text-secondary">{full}</p>
          <p className="text-xs text-text-secondary mt-0.5">No flooding</p>
        </div>
      </div>
    );
  }

  return (
    <div className="absolute top-3 right-3 z-[1000]">
      <div className="bg-[#111827]/90 backdrop-blur-sm border border-border-card rounded-lg px-3 py-2 shadow-lg min-w-[180px]">
        <p className="text-[10px] text-text-secondary mb-1.5">{full}</p>

        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs text-text-primary flex items-center gap-1.5">
            <AlertTriangle size={11} className="text-status-amber" />
            Flooding
          </span>
          <span className="text-xs font-bold text-status-amber">{activeCount}/{totalDevices}</span>
        </div>

        <div className="grid grid-cols-3 gap-2 text-[10px]">
          <div>
            <Droplets size={10} className="text-status-blue mb-0.5" />
            <p className="font-semibold">{Math.round(maxDepth)}cm</p>
          </div>
          <div>
            <CloudRain size={10} className="text-status-blue mb-0.5" />
            <p className="font-semibold">{avgRainfall > 0 ? `${avgRainfall.toFixed(1)}mm` : "—"}</p>
          </div>
          <div>
            <Waves size={10} className="text-status-blue mb-0.5" />
            <p className="font-semibold">{avgTide !== 0 ? `${avgTide.toFixed(2)}m` : "—"}</p>
          </div>
        </div>

        {isCompound && (
          <div className="mt-1.5 px-1.5 py-1 bg-status-red/10 border border-status-red/20 rounded text-[9px] font-semibold text-status-red text-center">
            COMPOUND EVENT
          </div>
        )}
      </div>
    </div>
  );
}
