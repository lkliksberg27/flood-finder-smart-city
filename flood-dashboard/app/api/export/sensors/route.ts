import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export async function GET() {
  try {
    const supabase = createServiceClient();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400 * 1000).toISOString();

    const [devicesRes, eventsRes] = await Promise.all([
      supabase.from("devices").select("*").order("device_id"),
      supabase.from("flood_events").select("device_id").gte("started_at", thirtyDaysAgo),
    ]);

    if (devicesRes.error) throw new Error(devicesRes.error.message);

    const floodCounts: Record<string, number> = {};
    for (const e of eventsRes.data ?? []) {
      floodCounts[e.device_id] = (floodCounts[e.device_id] || 0) + 1;
    }

    const headers = [
      "device_id", "name", "neighborhood", "status", "lat", "lng",
      "altitude_baro", "mailbox_height_cm", "baseline_distance_cm",
      "battery_v", "last_seen", "installed_at", "flood_events_30d",
    ];

    const rows = (devicesRes.data ?? []).map((d) =>
      headers.map((h) => {
        if (h === "flood_events_30d") return String(floodCounts[d.device_id] ?? 0);
        const val = d[h as keyof typeof d];
        if (val == null) return "";
        const str = String(val);
        return str.includes(",") ? `"${str}"` : str;
      }).join(",")
    );

    const csv = [headers.join(","), ...rows].join("\n");

    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="flood-finder-sensors-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
