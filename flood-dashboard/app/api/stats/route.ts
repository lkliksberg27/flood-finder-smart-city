import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export async function GET() {
  try {
    const supabase = createServiceClient();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400 * 1000).toISOString();

    const [devicesRes, activeEventsRes, totalEventsRes, recentEventsRes] = await Promise.all([
      supabase.from("devices").select("device_id, status, battery_v, last_seen"),
      supabase.from("flood_events").select("id, device_id, peak_depth_cm, started_at").is("ended_at", null),
      supabase.from("flood_events").select("id", { count: "exact", head: true }),
      supabase.from("flood_events").select("id", { count: "exact", head: true }).gte("started_at", thirtyDaysAgo),
    ]);

    if (devicesRes.error) throw new Error(devicesRes.error.message);

    const devices = devicesRes.data ?? [];
    const now = Date.now();
    const online = devices.filter((d) => d.status !== "offline").length;
    const offline = devices.filter((d) => d.status === "offline").length;
    const alerting = devices.filter((d) => d.status === "alert").length;
    const lowBattery = devices.filter((d) => (d.battery_v ?? 4) < 3.3).length;
    const avgBattery = devices.length
      ? devices.reduce((s, d) => s + (d.battery_v ?? 0), 0) / devices.length
      : 0;
    const stale = devices.filter((d) => {
      if (!d.last_seen) return true;
      return now - new Date(d.last_seen).getTime() > 2 * 3600 * 1000;
    }).length;
    const healthPct = devices.length > 0
      ? Math.round(((devices.length - stale) / devices.length) * 100)
      : 0;

    const activeEvents = activeEventsRes.data ?? [];

    return NextResponse.json({
      system: {
        totalDevices: devices.length,
        online,
        offline,
        alerting,
        lowBattery,
        avgBattery: parseFloat(avgBattery.toFixed(2)),
        networkHealthPct: healthPct,
      },
      flooding: {
        activeFloodEvents: activeEvents.length,
        activeDevices: activeEvents.map((e) => ({
          device_id: e.device_id,
          depth_cm: e.peak_depth_cm,
          started: e.started_at,
        })),
        totalFloodEvents: totalEventsRes.count ?? 0,
        eventsLast30Days: recentEventsRes.count ?? 0,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
