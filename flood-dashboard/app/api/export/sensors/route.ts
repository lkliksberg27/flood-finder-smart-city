import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export async function GET() {
  try {
    const supabase = createServiceClient();
    const { data, error } = await supabase
      .from("devices")
      .select("*")
      .order("device_id");

    if (error) throw new Error(error.message);

    const headers = [
      "device_id", "name", "neighborhood", "status", "lat", "lng",
      "altitude_baro", "mailbox_height_cm", "baseline_distance_cm",
      "battery_v", "last_seen", "installed_at",
    ];

    const rows = (data ?? []).map((d) =>
      headers.map((h) => {
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
