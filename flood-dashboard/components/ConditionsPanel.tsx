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
  const severityColor = maxDepth > 30 ? "text-status-red" : maxDepth > 10 ? "text-status-amber" : "text-status-green";

  return (
    <div className="absolute top-4 right-4 z-[1000]">
      <div className="bg-[#111827]/95 backdrop-blur-sm border border-border-card rounded-xl p-4 shadow-2xl min-w-[220px]">
        {/* Timestamp */}
        <p className="text-xs text-text-secondary mb-3">{full}</p>

        {/* Active floods */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <AlertTriangle size={14} className={activeCount > 0 ? "text-status-amber" : "text-text-secondary"} />
            <span className="text-sm text-text-primary">Flooding</span>
          </div>
          <span className={`text-sm font-bold ${activeCount > 0 ? severityColor : "text-text-secondary"}`}>
            {activeCount}/{totalDevices}
          </span>
        </div>

        {activeCount > 0 && (
          <>
            {/* Peak depth */}
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <Droplets size={14} className="text-status-blue" />
                <span className="text-xs text-text-secondary">Peak Depth</span>
              </div>
              <span className={`text-xs font-semibold ${severityColor}`}>
                {Math.round(maxDepth)}cm
              </span>
            </div>

            {/* Rainfall */}
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <CloudRain size={14} className="text-status-blue" />
                <span className="text-xs text-text-secondary">Rainfall</span>
              </div>
              <span className="text-xs font-semibold text-text-primary">
                {avgRainfall > 0 ? `${avgRainfall.toFixed(1)}mm` : "None"}
              </span>
            </div>

            {/* Tide */}
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <Waves size={14} className="text-status-blue" />
                <span className="text-xs text-text-secondary">Tide Level</span>
              </div>
              <span className="text-xs font-semibold text-text-primary">
                {avgTide !== 0 ? `${avgTide.toFixed(2)}m` : "—"}
              </span>
            </div>

            {/* Compound event warning */}
            {isCompound && (
              <div className="mt-2 px-2 py-1.5 bg-status-red/10 border border-status-red/20 rounded-lg">
                <p className="text-[10px] font-semibold text-status-red uppercase tracking-wider">
                  Compound Event
                </p>
                <p className="text-[10px] text-text-secondary mt-0.5">
                  Rain + high tide simultaneously
                </p>
              </div>
            )}
          </>
        )}

        {activeCount === 0 && (
          <p className="text-xs text-text-secondary">No flooding at this time</p>
        )}
      </div>
    </div>
  );
}
