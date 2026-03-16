import { getSupabase } from './supabase';
import type { Device, SensorReading, FloodEvent, Recommendation } from './types';

// ── Devices (anon key works — RLS allows SELECT) ────────────
export async function getAllDevices(): Promise<Device[]> {
  const { data, error } = await getSupabase()
    .from('devices')
    .select('*')
    .order('device_id');
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function getDevice(deviceId: string): Promise<Device | null> {
  const { data, error } = await getSupabase()
    .from('devices')
    .select('*')
    .eq('device_id', deviceId)
    .single();
  if (error) return null;
  return data;
}

// ── Sensor Readings ─────────────────────────────────────────
export async function getLatestReadings(deviceId: string, limit = 10): Promise<SensorReading[]> {
  const res = await fetch(`/api/data?table=sensor_readings&device_id=${encodeURIComponent(deviceId)}&limit=${limit}`);
  if (!res.ok) throw new Error('Failed to fetch readings');
  return res.json();
}

export async function getReadings24h(deviceId: string): Promise<Pick<SensorReading, 'distance_cm' | 'flood_depth_cm' | 'recorded_at'>[]> {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data, error } = await getSupabase()
    .from('sensor_readings')
    .select('distance_cm, flood_depth_cm, recorded_at')
    .eq('device_id', deviceId)
    .gte('recorded_at', since)
    .order('recorded_at');
  if (error) throw new Error(error.message);
  return data ?? [];
}

// ── Flood Events (use server API to bypass RLS) ─────────────
export async function getActiveFloodEvents(): Promise<FloodEvent[]> {
  const res = await fetch('/api/data?table=active_flood_events');
  if (!res.ok) throw new Error('Failed to fetch active flood events');
  return res.json();
}

export async function getAllFloodEvents(limit = 200): Promise<FloodEvent[]> {
  const res = await fetch(`/api/data?table=flood_events&limit=${limit}`);
  if (!res.ok) throw new Error('Failed to fetch flood events');
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
  if (!res.ok) throw new Error('Failed to fetch flood events in range');
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
  if (!res.ok) throw new Error('Failed to fetch flood event counts');
  return res.json();
}

export async function getTopFloodingDevices(limit = 10): Promise<{ device_id: string; name: string | null; count: number }[]> {
  const res = await fetch(`/api/data?table=top_flooding&limit=${limit}`);
  if (!res.ok) throw new Error('Failed to fetch top flooding devices');
  return res.json();
}

// ── Recommendations (use server API to bypass RLS) ──────────
export async function getRecommendations(): Promise<Recommendation[]> {
  const res = await fetch('/api/data?table=recommendations');
  if (!res.ok) throw new Error('Failed to fetch recommendations');
  return res.json();
}

// ── Flood event counts per device (30 days) ─────────────────
export async function getFloodEventCount30d(): Promise<Record<string, number>> {
  const res = await fetch('/api/data?table=flood_counts');
  if (!res.ok) throw new Error('Failed to fetch flood counts');
  return res.json();
}

// ── Neighborhoods ───────────────────────────────────────────
export async function getNeighborhoods(): Promise<string[]> {
  const { data, error } = await getSupabase()
    .from('devices')
    .select('neighborhood')
    .not('neighborhood', 'is', null);
  if (error) throw new Error(error.message);
  const unique = [...new Set((data ?? []).map((d) => d.neighborhood).filter(Boolean))];
  return unique.sort() as string[];
}
