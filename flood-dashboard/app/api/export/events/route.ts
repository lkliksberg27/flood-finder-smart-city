import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export async function GET() {
  try {
    const supabase = createServiceClient();

    const { data, error } = await supabase
      .from("flood_events")
      .select("*, devices(name, neighborhood, lat, lng, altitude_baro)")
      .order("started_at", { ascending: false })
      .limit(1000);

    if (error) throw new Error(error.message);

    const headers = [
      "id", "device_id", "device_name", "neighborhood", "lat", "lng",
      "elevation_m", "started_at", "ended_at", "duration_minutes",
      "peak_depth_cm", "severity", "rainfall_mm", "tide_level_m", "compound_event",
    ];

    const rows = (data ?? []).map((e) => {
      const dev = e.devices as { name: string | null; neighborhood: string | null; lat: number; lng: number; altitude_baro: number | null } | null;
      const severity = e.peak_depth_cm > 30 ? "high" : e.peak_depth_cm > 10 ? "medium" : "low";
      const compound = (e.rainfall_mm ?? 0) > 0 && (e.tide_level_m ?? 0) > 0.3 ? "yes" : "no";
      return [
        e.id,
        e.device_id,
        dev?.name ?? "",
        dev?.neighborhood ?? "",
        dev?.lat ?? "",
        dev?.lng ?? "",
        dev?.altitude_baro?.toFixed(2) ?? "",
        e.started_at,
        e.ended_at ?? "",
        e.duration_minutes ?? "",
        e.peak_depth_cm,
        severity,
        e.rainfall_mm ?? "",
        e.tide_level_m ?? "",
        compound,
      ].join(",");
    });

    const csv = [headers.join(","), ...rows].join("\n");

    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="flood-finder-events-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Export failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
