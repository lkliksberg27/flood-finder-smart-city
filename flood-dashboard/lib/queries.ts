import { getSupabase } from './supabase';
import type { Device, SensorReading, FloodEvent, Recommendation } from './types';

// ── Devices ─────────────────────────────────────────────────
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
  const { data, error } = await getSupabase()
    .from('sensor_readings')
    .select('*')
    .eq('device_id', deviceId)
    .order('recorded_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return data ?? [];
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

// ── Flood Events ────────────────────────────────────────────
export async function getActiveFloodEvents(): Promise<FloodEvent[]> {
  const { data, error } = await getSupabase()
    .from('flood_events')
    .select('*, devices(*)')
    .is('ended_at', null)
    .order('started_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function getAllFloodEvents(limit = 200): Promise<FloodEvent[]> {
  const { data, error } = await getSupabase()
    .from('flood_events')
    .select('*, devices(*)')
    .order('started_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function getFloodEventsFiltered(filters: {
  neighborhood?: string;
  startDate?: string;
  endDate?: string;
  minDepth?: number;
}): Promise<FloodEvent[]> {
  let query = getSupabase()
    .from('flood_events')
    .select('*, devices(*)')
    .order('started_at', { ascending: false });

  if (filters.startDate) query = query.gte('started_at', filters.startDate);
  if (filters.endDate) query = query.lte('started_at', filters.endDate);
  if (filters.minDepth) query = query.gte('peak_depth_cm', filters.minDepth);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  let results = data ?? [];
  if (filters.neighborhood) {
    results = results.filter(
      (e) => e.devices?.neighborhood === filters.neighborhood
    );
  }
  return results;
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
  const sixMonthsAgo = new Date(Date.now() - 180 * 86400 * 1000).toISOString();
  const { data, error } = await getSupabase()
    .from('flood_events')
    .select('started_at')
    .gte('started_at', sixMonthsAgo);
  if (error) throw new Error(error.message);

  const counts: Record<string, number> = {};
  for (const e of data ?? []) {
    const week = e.started_at.slice(0, 10);
    counts[week] = (counts[week] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([month, count]) => ({ month, count }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

export async function getTopFloodingDevices(limit = 10): Promise<{ device_id: string; name: string | null; count: number }[]> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
  const { data, error } = await getSupabase()
    .from('flood_events')
    .select('device_id, devices(name)')
    .gte('started_at', thirtyDaysAgo);
  if (error) throw new Error(error.message);

  const counts: Record<string, { name: string | null; count: number }> = {};
  for (const e of data ?? []) {
    const dev = e.device_id;
    if (!counts[dev]) counts[dev] = { name: (e.devices as unknown as Device)?.name ?? null, count: 0 };
    counts[dev].count++;
  }

  return Object.entries(counts)
    .map(([device_id, v]) => ({ device_id, ...v }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

// ── Recommendations ─────────────────────────────────────────
export async function getRecommendations(): Promise<Recommendation[]> {
  const { data, error } = await getSupabase()
    .from('infrastructure_recommendations')
    .select('*')
    .order('generated_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}

// ── Flood event counts per device (30 days) ─────────────────
export async function getFloodEventCount30d(): Promise<Record<string, number>> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
  const { data, error } = await getSupabase()
    .from('flood_events')
    .select('device_id')
    .gte('started_at', thirtyDaysAgo);
  if (error) throw new Error(error.message);

  const counts: Record<string, number> = {};
  for (const e of data ?? []) {
    counts[e.device_id] = (counts[e.device_id] || 0) + 1;
  }
  return counts;
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
