import { getSupabase } from './supabase';
import type { Device, SensorReading, FloodEvent, Recommendation } from './types';
import { demoDevices, demoReadings } from './demo-data';

/**
 * Every read falls back to the generated dataset when Supabase cannot be
 * reached, so the dashboard stands up on Vercel with no database at all.
 *
 * This is a fallback, not a mode switch: the moment a real project is
 * reachable its data wins. The banner in the layout tells the viewer which
 * one they are looking at, because presenting generated readings as real
 * measurements is not something this project should ever do.
 */
let demoActive = false;
export const isDemoActive = () => demoActive;

async function orDemo<T>(live: () => Promise<T>, fallback: () => T, what: string): Promise<T> {
  try {
    const v = await live();
    demoActive = false;
    return v;
  } catch (e) {
    demoActive = true;
    console.warn(`[demo] ${what}: live data unavailable, using generated dataset`,
                 e instanceof Error ? e.message : e);
    return fallback();
  }
}

// ── Devices (anon key works — RLS allows SELECT) ────────────
export async function getAllDevices(): Promise<Device[]> {
  return orDemo(async () => {
    const { data, error } = await getSupabase()
      .from('devices').select('*').order('device_id');
    if (error) throw new Error(error.message);
    if (!data?.length) throw new Error('no devices');
    return data;
  }, demoDevices, 'devices');
}

export async function getDevice(deviceId: string): Promise<Device | null> {
  try {
    const { data, error } = await getSupabase()
      .from('devices').select('*').eq('device_id', deviceId).single();
    if (error) throw new Error(error.message);
    return data;
  } catch {
    return demoDevices().find((d) => d.device_id === deviceId) ?? null;
  }
}

// ── Sensor Readings ─────────────────────────────────────────
export async function getLatestReadings(deviceId: string, limit = 10): Promise<SensorReading[]> {
  const res = await fetch(`/api/data?table=sensor_readings&device_id=${encodeURIComponent(deviceId)}&limit=${limit}`);
  if (!res.ok) throw new Error('Failed to fetch');
  return res.json();
}

export async function getReadings24h(deviceId: string): Promise<Pick<SensorReading, 'distance_cm' | 'flood_depth_cm' | 'recorded_at'>[]> {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  return orDemo(async () => {
    const { data, error } = await getSupabase()
      .from('sensor_readings')
      .select('distance_cm, flood_depth_cm, recorded_at')
      .eq('device_id', deviceId).gte('recorded_at', since).order('recorded_at');
    if (error) throw new Error(error.message);
    return data ?? [];
  }, () => demoReadings()
      .filter((r) => r.device_id === deviceId && r.recorded_at >= since)
      .sort((a, b) => a.recorded_at.localeCompare(b.recorded_at))
      .map(({ distance_cm, flood_depth_cm, recorded_at }) =>
        ({ distance_cm, flood_depth_cm, recorded_at })),
    'readings 24h');
}

// ── Flood Events (use server API to bypass RLS) ─────────────
export async function getActiveFloodEvents(): Promise<FloodEvent[]> {
  const res = await fetch('/api/data?table=active_flood_events');
  if (!res.ok) throw new Error('Failed to fetch');
  return res.json();
}

export async function getAllFloodEvents(limit = 200): Promise<FloodEvent[]> {
  const res = await fetch(`/api/data?table=flood_events&limit=${limit}`);
  if (!res.ok) throw new Error('Failed to fetch');
  return res.json();
}

export async function getFloodEventsFiltered(filters: {
  neighborhood?: string;
  startDate?: string;
  endDate?: string;
  minDepth?: number;
}): Promise<FloodEvent[]> {
  const events = await getAllFloodEvents(1000);
  let results = events;

  if (filters.startDate) {
    results = results.filter((e) => e.started_at >= filters.startDate!);
  }
  if (filters.endDate) {
    results = results.filter((e) => e.started_at <= filters.endDate!);
  }
  if (filters.minDepth) {
    results = results.filter((e) => e.peak_depth_cm >= filters.minDepth!);
  }
  if (filters.neighborhood) {
    results = results.filter(
      (e) => (e.devices as unknown as Device)?.neighborhood === filters.neighborhood
    );
  }
  return results;
}

// ── Flood Events for Timeline ────────────────────────────────
export async function getFloodEventsInRange(startDate: string, endDate: string): Promise<FloodEvent[]> {
  const res = await fetch(
    `/api/data?table=flood_events_range&start=${encodeURIComponent(startDate)}&end=${encodeURIComponent(endDate)}`
  );
  if (!res.ok) throw new Error('Failed to fetch');
  return res.json();
}

// ── Stats ───────────────────────────────────────────────────
export async function getOverviewStats() {
  const [devices, activeEvents] = await Promise.all([
    getAllDevices(),
    getActiveFloodEvents(),
  ]);

  const online = devices.filter((d) => d.status !== 'offline').length;
  const offline = devices.filter((d) => d.status === 'offline').length;
  const avgBattery =
    devices.reduce((sum, d) => sum + (d.battery_v ?? 0), 0) / (devices.length || 1);

  return {
    totalDevices: devices.length,
    online,
    offline,
    activeFloodEvents: activeEvents.length,
    activeEvents,
    avgBattery: parseFloat(avgBattery.toFixed(2)),
    devices,
  };
}

export async function getFloodEventCountByMonth(): Promise<{ month: string; count: number }[]> {
  const res = await fetch('/api/data?table=flood_events_monthly');
  if (!res.ok) throw new Error('Failed to fetch');
  return res.json();
}

export async function getTopFloodingDevices(limit = 10): Promise<{ device_id: string; name: string | null; count: number }[]> {
  const res = await fetch(`/api/data?table=top_flooding&limit=${limit}`);
  if (!res.ok) throw new Error('Failed to fetch');
  return res.json();
}

// ── Recommendations (use server API to bypass RLS) ──────────
export async function getRecommendations(): Promise<Recommendation[]> {
  const res = await fetch('/api/data?table=recommendations');
  if (!res.ok) throw new Error('Failed to fetch');
  return res.json();
}

// ── Flood event counts per device (30 days) ─────────────────
export async function getFloodEventCount30d(): Promise<Record<string, number>> {
  const res = await fetch('/api/data?table=flood_counts');
  if (!res.ok) throw new Error('Failed to fetch');
  return res.json();
}

// ── Neighborhoods ───────────────────────────────────────────
export async function getNeighborhoods(): Promise<string[]> {
  return orDemo(async () => {
    const { data, error } = await getSupabase()
      .from('devices').select('neighborhood').not('neighborhood', 'is', null);
    if (error) throw new Error(error.message);
    const u = [...new Set((data ?? []).map((d) => d.neighborhood).filter(Boolean))];
    if (!u.length) throw new Error('none');
    return u.sort() as string[];
  }, () => [...new Set(demoDevices().map((d) => d.neighborhood).filter(Boolean))].sort() as string[],
    'neighborhoods');
}
