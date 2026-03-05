import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export async function GET() {
  try {
    const supabase = createServiceClient();

    const [devicesRes, activeEventsRes, totalEventsRes] = await Promise.all([
      supabase.from("devices").select("device_id, status, battery_v"),
      supabase.from("flood_events").select("id").is("ended_at", null),
      supabase.from("flood_events").select("id", { count: "exact", head: true }),
    ]);

    if (devicesRes.error) throw new Error(devicesRes.error.message);

    const devices = devicesRes.data ?? [];
    const online = devices.filter((d) => d.status !== "offline").length;
    const offline = devices.filter((d) => d.status === "offline").length;
    const avgBattery = devices.length
      ? devices.reduce((s, d) => s + (d.battery_v ?? 0), 0) / devices.length
      : 0;

    return NextResponse.json({
      totalDevices: devices.length,
      online,
      offline,
      activeFloodEvents: activeEventsRes.data?.length ?? 0,
      totalFloodEvents: totalEventsRes.count ?? 0,
      avgBattery: parseFloat(avgBattery.toFixed(2)),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
