import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { createServiceClient } from "@/lib/supabase";

interface DeviceRow {
  device_id: string;
  name: string | null;
  lat: number;
  lng: number;
  neighborhood: string | null;
  altitude_baro: number | null;
}

interface EventRow {
  device_id: string;
  started_at: string;
  ended_at: string | null;
  peak_depth_cm: number;
  duration_minutes: number | null;
  rainfall_mm: number | null;
  tide_level_m: number | null;
  devices: DeviceRow | null;
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function analyzeGradients(devices: DeviceRow[]) {
  const withElev = devices.filter((d) => d.altitude_baro != null);
  if (withElev.length < 3) return [];

  return withElev.map((d) => {
    const neighbors = withElev
      .filter((n) => n.device_id !== d.device_id)
      .map((n) => ({ ...n, dist: haversineKm(d.lat, d.lng, n.lat, n.lng) }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 3);

    const avgNeighborElev = neighbors.reduce((s, n) => s + (n.altitude_baro ?? 0), 0) / neighbors.length;
    const diff = (d.altitude_baro ?? 0) - avgNeighborElev;

    return {
      device_id: d.device_id,
      name: d.name,
      neighborhood: d.neighborhood,
      elevation_m: d.altitude_baro,
      avg_neighbor_elevation_m: parseFloat(avgNeighborElev.toFixed(2)),
      elevation_diff_m: parseFloat(diff.toFixed(2)),
      is_dip: diff < -0.15,
    };
  });
}

export async function POST() {
  try {
    const supabase = createServiceClient();

    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400 * 1000).toISOString();

    const [eventsRes, devicesRes] = await Promise.all([
      supabase
        .from("flood_events")
        .select("*, devices(device_id, name, lat, lng, neighborhood, altitude_baro)")
        .gte("started_at", thirtyDaysAgo),
      supabase.from("devices").select("device_id, name, lat, lng, neighborhood, altitude_baro"),
    ]);

    if (eventsRes.error) throw new Error(eventsRes.error.message);

    const events = (eventsRes.data ?? []) as unknown as EventRow[];
    const allDevices = (devicesRes.data ?? []) as DeviceRow[];

    if (events.length === 0) {
      return NextResponse.json({ message: "No flood events in last 30 days" }, { status: 200 });
    }

    const eventSummary = events.map((e) => ({
      device: e.device_id,
      name: e.devices?.name,
      neighborhood: e.devices?.neighborhood,
      lat: e.devices?.lat,
      lng: e.devices?.lng,
      elevation_m: e.devices?.altitude_baro,
      started: e.started_at,
      ended: e.ended_at,
      peak_depth_cm: e.peak_depth_cm,
      duration_min: e.duration_minutes,
      rainfall_mm: e.rainfall_mm,
      tide_m: e.tide_level_m,
    }));

    const gradients = analyzeGradients(allDevices);
    const dips = gradients.filter((g) => g.is_dip);

    const floodFrequency: Record<string, { count: number; avgDepth: number; totalDuration: number }> = {};
    events.forEach((e) => {
      if (!floodFrequency[e.device_id]) {
        floodFrequency[e.device_id] = { count: 0, avgDepth: 0, totalDuration: 0 };
      }
      floodFrequency[e.device_id].count++;
      floodFrequency[e.device_id].avgDepth += e.peak_depth_cm;
      floodFrequency[e.device_id].totalDuration += e.duration_minutes || 0;
    });
    Object.values(floodFrequency).forEach((v) => {
      v.avgDepth = Math.round(v.avgDepth / v.count);
    });

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-5-20250514",
      max_tokens: 3000,
      messages: [{
        role: "user",
        content: `You are an urban flood infrastructure analyst working with the city of Aventura, Florida.

FLOOD EVENTS (last 30 days):
${JSON.stringify(eventSummary, null, 2)}

FLOOD FREQUENCY PER SENSOR:
${JSON.stringify(floodFrequency, null, 2)}

ELEVATION GRADIENT ANALYSIS (road dip detection):
${JSON.stringify(gradients, null, 2)}

IDENTIFIED ROAD DIPS:
${JSON.stringify(dips, null, 2)}

Return a JSON object (no markdown, raw JSON only):
{
  "recommendations": [
    {
      "priority": "high" | "medium" | "low",
      "category": "drainage" | "elevation" | "barrier" | "other",
      "affected_devices": ["FF-001"],
      "text": "Detailed recommendation..."
    }
  ]
}

REQUIREMENTS:
1. Identify top 5 locations with most frequent/severe flooding
2. Cross-reference with elevation data — which sensors sit in road dips?
3. Analyze rainfall/tide correlation
4. Recommend SPECIFIC infrastructure: catch basins, french drains, road re-grading, swales, pump stations, backflow preventers, pipe upsizing
5. Estimate impact: "Would reduce flood frequency by approximately X%"
6. Prioritize cost-effective improvements that help multiple sensors
Limit to 5-8 recommendations.`,
      }],
    });

    const content = response.content[0].type === "text" ? response.content[0].text : "";
    let parsed: { recommendations: Array<{
      priority: string;
      category: string;
      affected_devices: string[];
      text: string;
    }> };

    try {
      parsed = JSON.parse(content);
    } catch {
      const match = content.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("Could not parse AI response");
      parsed = JSON.parse(match[0]);
    }

    for (const rec of parsed.recommendations) {
      await supabase.from("infrastructure_recommendations").insert({
        analysis_period_days: 30,
        recommendation_text: rec.text,
        affected_device_ids: rec.affected_devices || [],
        priority: rec.priority || "medium",
        category: rec.category || "other",
      });
    }

    return NextResponse.json({
      message: `Generated ${parsed.recommendations.length} recommendations`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[API] Run analysis error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
