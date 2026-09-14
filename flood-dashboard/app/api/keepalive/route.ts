import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

// Daily Vercel Cron that does a no-op read on Supabase so the free-tier
// project never crosses the 7-day inactivity threshold and gets paused.
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
  }

  try {
    const supabase = createServiceClient();
    const { count, error } = await supabase
      .from("devices")
      .select("device_id", { count: "exact", head: true });
    if (error) throw new Error(error.message);

    // Refresh barometric elevations while we are here. Nothing in a packet
    // carries elevation, so this is what keeps the flow map, the elevation page
    // and road-dip analysis populated for real nodes. It updates nothing until
    // the barometers are calibrated and enough readings exist, and a failure
    // here must not fail the keepalive itself.
    const { data: elev, error: elevErr } = await supabase.rpc("derive_node_elevations");
    const elevation = elevErr
      ? { error: elevErr.message }
      : { updated: Array.isArray(elev) ? elev.length : 0 };

    return NextResponse.json({
      ok: true,
      devices: count ?? 0,
      elevation,
      at: new Date().toISOString(),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
