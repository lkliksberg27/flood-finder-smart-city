import type { FloodEvent } from "./types";

export interface TimelineSnapshot {
  floodDepths: Record<string, number>;
  activeEvents: FloodEvent[];
  avgRainfall: number;
  avgTide: number;
  activeCount: number;
  maxDepth: number;
}

/**
 * Interpolate flood depth at a given time within an event.
 * Uses a triangle wave: rises to peak at 40% of duration, then falls.
 */
export function depthAtTime(event: FloodEvent, timeMs: number): number {
  const startMs = new Date(event.started_at).getTime();
  const endMs = event.ended_at
    ? new Date(event.ended_at).getTime()
    : startMs + (event.duration_minutes ?? 30) * 60000;
  const duration = endMs - startMs;
  if (duration <= 0) return 0;

  const elapsed = timeMs - startMs;
  const progress = Math.max(0, Math.min(1, elapsed / duration));

  const peakAt = 0.4;
  if (progress <= peakAt) {
    return event.peak_depth_cm * (progress / peakAt);
  }
  return event.peak_depth_cm * (1 - (progress - peakAt) / (1 - peakAt));
}

/**
 * Compute the full flood state at a given timestamp.
 * Returns which sensors are flooding and at what depth,
 * plus aggregate weather conditions.
 */
export function computeSnapshot(
  timeMs: number,
  events: FloodEvent[]
): TimelineSnapshot {
  const floodDepths: Record<string, number> = {};
  const activeEvents: FloodEvent[] = [];
  let totalRain = 0;
  let totalTide = 0;
  let rainCount = 0;
  let tideCount = 0;
  let maxDepth = 0;

  for (const event of events) {
    const startMs = new Date(event.started_at).getTime();
    const endMs = event.ended_at
      ? new Date(event.ended_at).getTime()
      : startMs + (event.duration_minutes ?? 30) * 60000;

    if (timeMs >= startMs && timeMs <= endMs) {
      const depth = depthAtTime(event, timeMs);
      if (depth > 0) {
        // Keep the max depth if multiple events overlap on same device
        floodDepths[event.device_id] = Math.max(
          floodDepths[event.device_id] ?? 0,
          depth
        );
        activeEvents.push(event);
        if (depth > maxDepth) maxDepth = depth;

        if (event.rainfall_mm != null) {
          totalRain += event.rainfall_mm;
          rainCount++;
        }
        if (event.tide_level_m != null) {
          totalTide += event.tide_level_m;
          tideCount++;
        }
      }
    }
  }

  // Count unique devices flooding
  const activeCount = Object.keys(floodDepths).length;

  return {
    floodDepths,
    activeEvents,
    avgRainfall: rainCount > 0 ? totalRain / rainCount : 0,
    avgTide: tideCount > 0 ? totalTide / tideCount : 0,
    activeCount,
    maxDepth,
  };
}

/**
 * Generate tick marks for the timeline showing where flood events occurred.
 * Each tick has a position (0-1) and severity color.
 */
export function generateTimelineTicks(
  startMs: number,
  endMs: number,
  events: FloodEvent[]
): { position: number; severity: "low" | "medium" | "high"; deviceId: string }[] {
  const range = endMs - startMs;
  if (range <= 0) return [];

  const ticks: { position: number; severity: "low" | "medium" | "high"; deviceId: string }[] = [];

  for (const event of events) {
    const eventStart = new Date(event.started_at).getTime();
    const pos = (eventStart - startMs) / range;
    if (pos < 0 || pos > 1) continue;

    const severity: "low" | "medium" | "high" =
      event.peak_depth_cm > 30 ? "high" :
      event.peak_depth_cm > 10 ? "medium" : "low";

    ticks.push({ position: pos, severity, deviceId: event.device_id });
  }

  return ticks;
}

/**
 * Format a timestamp for display.
 */
export function formatTimestamp(ms: number): { date: string; time: string; full: string } {
  const d = new Date(ms);
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  const full = d.toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
  });
  return { date, time, full };
}
