import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { createServiceClient } from "@/lib/supabase";

export async function POST() {
  try {
    const supabase = createServiceClient();

    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400 * 1000).toISOString();

    const { data: events, error } = await supabase
      .from("flood_events")
      .select("*, devices(device_id, name, lat, lng, neighborhood, altitude_baro)")
      .gte("started_at", thirtyDaysAgo);

    if (error) throw new Error(error.message);

    if (!events || events.length === 0) {
      return NextResponse.json(
        { message: "No flood events in last 30 days" },
        { status: 200 }
      );
    }

    const summary = events.map((e) => ({
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

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const response = await anthropic.messages.create({
      model: "claude-opus-4-6",
      max_tokens: 2000,
      messages: [{
        role: "user",
        content: `You are an urban flood infrastructure analyst for Aventura, Florida.
Analyze the following flood event data from the last 30 days collected by IoT sensors mounted on mailboxes.

DATA:
${JSON.stringify(summary, null, 2)}

Return a JSON object (no markdown, raw JSON only) with this structure:
{
  "recommendations": [
    {
      "priority": "high" | "medium" | "low",
      "category": "drainage" | "elevation" | "barrier" | "other",
      "affected_devices": ["FF-001", "FF-003"],
      "text": "Detailed recommendation with reasoning and estimated impact..."
    }
  ]
}

Requirements:
1. Identify the top 5 locations with most frequent/severe flooding
2. Analyze likely causes (low elevation, poor drainage, tidal influence, etc.)
3. Suggest specific infrastructure improvements with reasoning
4. Estimate impact if each improvement were made
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
