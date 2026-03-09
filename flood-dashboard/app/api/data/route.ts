import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

/**
 * Unified data API that uses the service client to bypass RLS.
 * Accepts ?table=flood_events|sensor_readings|recommendations|flood_counts
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const table = searchParams.get("table");
  const supabase = createServiceClient();

  try {
    switch (table) {
      case "flood_events": {
        const limit = parseInt(searchParams.get("limit") ?? "200");
        const { data, error } = await supabase
          .from("flood_events")
          .select("*, devices(*)")
          .order("started_at", { ascending: false })
          .limit(limit);
        if (error) throw error;
        return NextResponse.json(data ?? []);
      }

      case "active_flood_events": {
        const { data, error } = await supabase
          .from("flood_events")
          .select("*, devices(*)")
          .is("ended_at", null)
          .order("started_at", { ascending: false });
        if (error) throw error;
        return NextResponse.json(data ?? []);
      }

      case "flood_counts": {
        const thirtyDaysAgo = new Date(
          Date.now() - 30 * 86400 * 1000
        ).toISOString();
        const { data, error } = await supabase
          .from("flood_events")
          .select("device_id")
          .gte("started_at", thirtyDaysAgo);
        if (error) throw error;

        const counts: Record<string, number> = {};
        for (const e of data ?? []) {
          counts[e.device_id] = (counts[e.device_id] || 0) + 1;
        }
        return NextResponse.json(counts);
      }

      case "flood_events_monthly": {
        const sixMonthsAgo = new Date(
          Date.now() - 180 * 86400 * 1000
        ).toISOString();
        const { data, error } = await supabase
          .from("flood_events")
          .select("started_at")
          .gte("started_at", sixMonthsAgo);
        if (error) throw error;

        const counts: Record<string, number> = {};
        for (const e of data ?? []) {
          const week = e.started_at.slice(0, 10);
          counts[week] = (counts[week] || 0) + 1;
        }
        const result = Object.entries(counts)
          .map(([month, count]) => ({ month, count }))
          .sort((a, b) => a.month.localeCompare(b.month));
        return NextResponse.json(result);
      }

      case "top_flooding": {
        const limit = parseInt(searchParams.get("limit") ?? "10");
        const thirtyDaysAgo = new Date(
          Date.now() - 30 * 86400 * 1000
        ).toISOString();
        const { data, error } = await supabase
          .from("flood_events")
          .select("device_id, devices(name)")
          .gte("started_at", thirtyDaysAgo);
        if (error) throw error;

        const counts: Record<string, { name: string | null; count: number }> =
          {};
        for (const e of data ?? []) {
          const dev = e.device_id;
          if (!counts[dev])
            counts[dev] = {
              name: (e.devices as unknown as { name: string })?.name ?? null,
              count: 0,
            };
          counts[dev].count++;
        }
        const result = Object.entries(counts)
          .map(([device_id, v]) => ({ device_id, ...v }))
          .sort((a, b) => b.count - a.count)
          .slice(0, limit);
        return NextResponse.json(result);
      }

      case "recommendations": {
        const { data, error } = await supabase
          .from("infrastructure_recommendations")
          .select("*")
          .order("generated_at", { ascending: false });
        if (error) throw error;
        return NextResponse.json(data ?? []);
      }

      case "sensor_readings": {
        const deviceId = searchParams.get("device_id");
        const limit = parseInt(searchParams.get("limit") ?? "10");
        if (!deviceId)
          return NextResponse.json(
            { error: "device_id required" },
            { status: 400 }
          );

        const { data, error } = await supabase
          .from("sensor_readings")
          .select("*")
          .eq("device_id", deviceId)
          .order("recorded_at", { ascending: false })
          .limit(limit);
        if (error) throw error;
        return NextResponse.json(data ?? []);
      }

      default:
        return NextResponse.json(
          { error: `Unknown table: ${table}` },
          { status: 400 }
        );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Query failed";
    console.error(`[DATA API] Error for ${table}:`, msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
