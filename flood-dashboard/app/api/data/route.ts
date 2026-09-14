import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { demoDevices, demoEvents, demoRecommendations, demoReadings, demoFloodCounts } from "@/lib/demo-data";

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
        const neighborhood = searchParams.get("neighborhood") || "";
        let query = supabase
          .from("infrastructure_recommendations")
          .select("*")
          .order("generated_at", { ascending: false });

        // If neighborhood filter, only return recs that mention it in the text
        if (neighborhood) {
          query = query.ilike("recommendation_text", `%${neighborhood}%`);
        }

        const { data, error } = await query;
        if (error) throw error;
        return NextResponse.json(data ?? []);
      }

      case "last_analysis": {
        // Check when the last analysis was run
        const neighborhood = searchParams.get("neighborhood") || "";
        let query = supabase
          .from("infrastructure_recommendations")
          .select("generated_at")
          .order("generated_at", { ascending: false })
          .limit(1);

        if (neighborhood) {
          query = query.ilike("recommendation_text", `%[${neighborhood}]%`);
        }

        const { data, error } = await query;
        if (error) throw error;

        const lastAnalysis = data?.[0]?.generated_at ?? null;
        const daysAgo = lastAnalysis
          ? Math.floor((Date.now() - new Date(lastAnalysis).getTime()) / 86400000)
          : null;
        const daysUntilRefresh = daysAgo !== null ? Math.max(0, 14 - daysAgo) : null;
        const isCached = daysAgo !== null && daysAgo < 14;

        return NextResponse.json({
          lastAnalysis,
          daysAgo,
          daysUntilRefresh,
          isCached,
        });
      }

      case "flood_events_range": {
        const start = searchParams.get("start");
        const end = searchParams.get("end");
        const neighborhood = searchParams.get("neighborhood");
        if (!start || !end) {
          return NextResponse.json(
            { error: "start and end required" },
            { status: 400 }
          );
        }
        // Events that overlap the range: started before range ends AND (ended after range starts OR still ongoing)
        let rangeQuery = supabase
          .from("flood_events")
          .select("*, devices(*)")
          .lte("started_at", end)
          .or(`ended_at.gte.${start},ended_at.is.null`)
          .order("started_at", { ascending: true });
        // Server-side neighborhood filter for performance at scale
        if (neighborhood) {
          rangeQuery = rangeQuery.eq("devices.neighborhood", neighborhood);
        }
        const { data: rangeData, error: rangeError } = await rangeQuery;
        if (rangeError) throw rangeError;
        // If neighborhood filter was applied via join, filter out nulls
        const filtered = neighborhood
          ? (rangeData ?? []).filter((e: Record<string, unknown>) => e.devices != null)
          : (rangeData ?? []);
        return NextResponse.json(filtered);
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
    // Supabase unreachable. Rather than 500 the page, serve the generated
    // dataset so the dashboard is still usable with no database behind it.
    // The banner in the layout makes clear which one is on screen.
    const fb = demoFallback(table, searchParams);
    if (fb) {
      console.warn(`[demo] /api/data?table=${table}: live data unavailable, serving generated dataset`);
      return NextResponse.json(fb);
    }
    const msg = err instanceof Error ? err.message : "Query failed";
    console.error(`[DATA API] Error for ${table}:`, msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/** Generated stand-in for each table the dashboard asks for. */
function demoFallback(table: string | null, sp: URLSearchParams): unknown | null {
  const events = demoEvents();
  const devices = demoDevices();
  const byId = new Map(devices.map((d) => [d.device_id, d]));
  const withDevice = (e: (typeof events)[number]) => ({ ...e, devices: byId.get(e.device_id) });

  switch (table) {
    case "flood_events":
      return events.slice(0, parseInt(sp.get("limit") ?? "200")).map(withDevice);
    case "active_flood_events":
      return events.filter((e) => e.ended_at === null).map(withDevice);
    case "flood_counts":
      return demoFloodCounts();
    case "recommendations":
      return demoRecommendations();
    case "last_analysis": {
      const r = demoRecommendations()[0];
      return { generated_at: r?.generated_at ?? null, count: demoRecommendations().length };
    }
    case "flood_events_monthly": {
      const m: Record<string, number> = {};
      for (const e of events) {
        const k = e.started_at.slice(0, 7);
        m[k] = (m[k] ?? 0) + 1;
      }
      return Object.entries(m).sort().map(([month, count]) => ({ month, count }));
    }
    case "top_flooding": {
      const counts = demoFloodCounts();
      return Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, parseInt(sp.get("limit") ?? "10"))
        .map(([device_id, count]) => ({ device_id, name: byId.get(device_id)?.name ?? null, count }));
    }
    case "flood_events_range": {
      const start = sp.get("start") ?? "";
      const end = sp.get("end") ?? "";
      return events
        .filter((e) => e.started_at >= start && e.started_at <= end)
        .map(withDevice);
    }
    case "sensor_readings": {
      const id = sp.get("device_id");
      const limit = parseInt(sp.get("limit") ?? "10");
      return demoReadings().filter((r) => !id || r.device_id === id).slice(0, limit);
    }
    default:
      return null;
  }
}
