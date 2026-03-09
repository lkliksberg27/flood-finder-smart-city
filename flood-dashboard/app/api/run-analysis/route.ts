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
  battery_v: number | null;
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

// Compute bearing from one point to another (degrees, 0=north)
function bearing(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const y = Math.sin(dLng) * Math.cos(lat2 * Math.PI / 180);
  const x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180) -
    Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

function bearingToDirection(deg: number): string {
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return dirs[Math.round(deg / 45) % 8];
}

function analyzeGradients(devices: DeviceRow[]) {
  const withElev = devices.filter((d) => d.altitude_baro != null);
  if (withElev.length < 3) return [];

  return withElev.map((d) => {
    const neighbors = withElev
      .filter((n) => n.device_id !== d.device_id)
      .map((n) => ({
        device_id: n.device_id,
        name: n.name,
        dist_m: Math.round(haversineKm(d.lat, d.lng, n.lat, n.lng) * 1000),
        elevation_m: n.altitude_baro!,
        bearing_deg: bearing(d.lat, d.lng, n.lat, n.lng),
      }))
      .sort((a, b) => a.dist_m - b.dist_m)
      .slice(0, 4);

    const avgNeighborElev = neighbors.reduce((s, n) => s + n.elevation_m, 0) / neighbors.length;
    const diff = (d.altitude_baro ?? 0) - avgNeighborElev;

    // Determine which direction water would flow FROM (uphill neighbors toward this sensor)
    const uphillNeighbors = neighbors
      .filter((n) => n.elevation_m > (d.altitude_baro ?? 0))
      .map((n) => ({
        from: n.device_id,
        direction: bearingToDirection(n.bearing_deg),
        slope_pct: parseFloat((((n.elevation_m - (d.altitude_baro ?? 0)) / n.dist_m) * 100).toFixed(2)),
        distance_m: n.dist_m,
      }));

    return {
      device_id: d.device_id,
      name: d.name,
      neighborhood: d.neighborhood,
      elevation_m: d.altitude_baro,
      avg_neighbor_elevation_m: parseFloat(avgNeighborElev.toFixed(2)),
      elevation_diff_m: parseFloat(diff.toFixed(2)),
      is_dip: diff < -0.15,
      water_flows_from: uphillNeighbors,
      nearest_neighbor_m: neighbors[0]?.dist_m ?? 0,
    };
  });
}

export async function POST(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const neighborhoodFilter = searchParams.get("neighborhood") || "";

    const supabase = createServiceClient();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400 * 1000).toISOString();

    const [eventsRes, devicesRes] = await Promise.all([
      supabase
        .from("flood_events")
        .select("*, devices(device_id, name, lat, lng, neighborhood, altitude_baro, battery_v)")
        .gte("started_at", thirtyDaysAgo),
      supabase.from("devices").select("device_id, name, lat, lng, neighborhood, altitude_baro, battery_v"),
    ]);

    if (eventsRes.error) throw new Error(eventsRes.error.message);

    let events = (eventsRes.data ?? []) as unknown as EventRow[];
    let allDevices = (devicesRes.data ?? []) as DeviceRow[];

    // Filter by neighborhood if specified
    if (neighborhoodFilter) {
      allDevices = allDevices.filter((d) => d.neighborhood === neighborhoodFilter);
      const deviceIds = new Set(allDevices.map((d) => d.device_id));
      events = events.filter((e) => deviceIds.has(e.device_id));
    }

    if (events.length === 0) {
      const msg = neighborhoodFilter
        ? `No flood events in ${neighborhoodFilter} in the last 30 days`
        : "No flood events in last 30 days";
      return NextResponse.json({ message: msg }, { status: 200 });
    }

    // ── 1. Per-sensor flood profile ─────────────────────────────
    const sensorProfiles: Record<string, {
      count: number;
      avgDepthCm: number;
      maxDepthCm: number;
      totalDurationMin: number;
      avgDurationMin: number;
      rainfallEvents: number;
      avgRainfallMm: number;
      tidalEvents: number;
      avgTideLevelM: number;
      compoundEvents: number; // rain + high tide
      timeOfDayDistribution: Record<string, number>;
      device: DeviceRow | null;
    }> = {};

    events.forEach((e) => {
      if (!sensorProfiles[e.device_id]) {
        sensorProfiles[e.device_id] = {
          count: 0, avgDepthCm: 0, maxDepthCm: 0,
          totalDurationMin: 0, avgDurationMin: 0,
          rainfallEvents: 0, avgRainfallMm: 0,
          tidalEvents: 0, avgTideLevelM: 0,
          compoundEvents: 0,
          timeOfDayDistribution: { morning: 0, afternoon: 0, evening: 0, night: 0 },
          device: e.devices,
        };
      }
      const p = sensorProfiles[e.device_id];
      p.count++;
      p.avgDepthCm += e.peak_depth_cm;
      p.maxDepthCm = Math.max(p.maxDepthCm, e.peak_depth_cm);
      p.totalDurationMin += e.duration_minutes ?? 0;

      if (e.rainfall_mm != null && e.rainfall_mm > 0) {
        p.rainfallEvents++;
        p.avgRainfallMm += e.rainfall_mm;
      }
      if (e.tide_level_m != null && e.tide_level_m > 0.3) {
        p.tidalEvents++;
        p.avgTideLevelM += e.tide_level_m;
      }
      if ((e.rainfall_mm ?? 0) > 0 && (e.tide_level_m ?? 0) > 0.3) {
        p.compoundEvents++;
      }

      const hour = new Date(e.started_at).getHours();
      if (hour >= 6 && hour < 12) p.timeOfDayDistribution.morning++;
      else if (hour >= 12 && hour < 17) p.timeOfDayDistribution.afternoon++;
      else if (hour >= 17 && hour < 22) p.timeOfDayDistribution.evening++;
      else p.timeOfDayDistribution.night++;
    });

    // Compute averages
    Object.values(sensorProfiles).forEach((p) => {
      p.avgDepthCm = Math.round(p.avgDepthCm / p.count);
      p.avgDurationMin = Math.round(p.totalDurationMin / p.count);
      if (p.rainfallEvents > 0) p.avgRainfallMm = parseFloat((p.avgRainfallMm / p.rainfallEvents).toFixed(1));
      if (p.tidalEvents > 0) p.avgTideLevelM = parseFloat((p.avgTideLevelM / p.tidalEvents).toFixed(2));
    });

    // ── 2. Elevation gradient + water flow analysis ─────────────
    const gradients = analyzeGradients(allDevices);
    const dips = gradients.filter((g) => g.is_dip);

    // ── 3. Neighborhood-level aggregation ───────────────────────
    const neighborhoodStats: Record<string, {
      totalEvents: number;
      avgElevation: number;
      sensorCount: number;
      worstSensor: string;
      worstSensorEvents: number;
    }> = {};

    allDevices.forEach((d) => {
      const n = d.neighborhood ?? "Unknown";
      if (!neighborhoodStats[n]) {
        neighborhoodStats[n] = { totalEvents: 0, avgElevation: 0, sensorCount: 0, worstSensor: "", worstSensorEvents: 0 };
      }
      neighborhoodStats[n].sensorCount++;
      neighborhoodStats[n].avgElevation += d.altitude_baro ?? 0;
    });
    Object.entries(sensorProfiles).forEach(([deviceId, p]) => {
      const n = p.device?.neighborhood ?? "Unknown";
      if (neighborhoodStats[n]) {
        neighborhoodStats[n].totalEvents += p.count;
        if (p.count > neighborhoodStats[n].worstSensorEvents) {
          neighborhoodStats[n].worstSensor = deviceId;
          neighborhoodStats[n].worstSensorEvents = p.count;
        }
      }
    });
    Object.values(neighborhoodStats).forEach((ns) => {
      ns.avgElevation = parseFloat((ns.avgElevation / ns.sensorCount).toFixed(2));
    });

    // ── 4. Rainfall threshold analysis ──────────────────────────
    const rainfallFloodPairs = events
      .filter((e) => e.rainfall_mm != null && e.rainfall_mm > 0)
      .map((e) => ({ rainfall_mm: e.rainfall_mm!, depth_cm: e.peak_depth_cm, elevation_m: e.devices?.altitude_baro }));

    const rainfallThreshold = rainfallFloodPairs.length > 2
      ? parseFloat((rainfallFloodPairs.reduce((s, p) => s + p.rainfall_mm, 0) / rainfallFloodPairs.length * 0.5).toFixed(1))
      : null;

    // ── 5. Flood risk score per sensor ──────────────────────────
    const riskScores = allDevices.map((d) => {
      const profile = sensorProfiles[d.device_id];
      const gradient = gradients.find((g) => g.device_id === d.device_id);

      let score = 0;
      // Frequency (0-40 points)
      score += Math.min(40, (profile?.count ?? 0) * 8);
      // Severity (0-25 points)
      score += Math.min(25, (profile?.maxDepthCm ?? 0) * 0.5);
      // Low elevation (0-20 points)
      if (d.altitude_baro != null && d.altitude_baro < 1.5) {
        score += Math.round((1.5 - d.altitude_baro) * 13);
      }
      // Road dip (0-15 points)
      if (gradient?.is_dip) {
        score += Math.min(15, Math.abs(gradient.elevation_diff_m) * 50);
      }

      return {
        device_id: d.device_id,
        name: d.name,
        neighborhood: d.neighborhood,
        risk_score: Math.min(100, Math.round(score)),
        risk_level: score > 60 ? "critical" : score > 35 ? "high" : score > 15 ? "moderate" : "low",
        factors: {
          flood_frequency: profile?.count ?? 0,
          max_depth_cm: profile?.maxDepthCm ?? 0,
          elevation_m: d.altitude_baro,
          is_road_dip: gradient?.is_dip ?? false,
          compound_event_prone: (profile?.compoundEvents ?? 0) > 0,
        },
      };
    }).sort((a, b) => b.risk_score - a.risk_score);

    // ── 6. Build the comprehensive AI prompt ────────────────────
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4000,
      messages: [{
        role: "user",
        content: `You are a senior urban flood infrastructure engineer consulting for the City of Aventura, Florida (Miami-Dade County).
${neighborhoodFilter
  ? `You are analyzing 30 days of data SPECIFICALLY for the ${neighborhoodFilter} neighborhood — ${allDevices.length} sensors in this area.
Focus all recommendations on this neighborhood's specific conditions, drainage patterns, and infrastructure needs.`
  : `You are analyzing 30 days of real-time data from ${allDevices.length} IoT flood sensors mounted on mailboxes across the city.`}
Each sensor uses an ultrasonic distance sensor to detect water depth, a BMP390 barometric altimeter for precision elevation (±0.25m), and GPS.
NOAA weather and tide data is automatically correlated with each flood event.

═══════════════════════════════════════════════════
REFERENCE: ENGINEERING STANDARDS & REGIONAL CONTEXT
Use these real-world benchmarks to ground your recommendations.
═══════════════════════════════════════════════════
AVENTURA CONTEXT:
- Storm sewers discharge to Intracoastal Waterway / Biscayne Bay (tidal)
- Most of Aventura is FEMA Special Flood Hazard Area (AE Zone)
- CRS Class 7 rating — ~$600K/year in community flood insurance discounts
- Poorly to moderately drained soils, heavily modified by development
- SE Florida sea level rise projections: +10-17in by 2040, +17-31in by 2060 (SE FL Climate Compact)
- South Florida annual rainfall: 52-53in, ~75% in wet season (June-October)
- Intense thunderstorms can produce 3in/hr; 100-year storm = 12+in/24hrs (SFWMD)

FEMA / NATIONAL STANDARDS:
- Every $1 in FEMA hazard mitigation saves $6 on average (NIBS/FEMA 23-year study)
- Standard storm drains designed for 5-10 year storms (ASCE MOP 77); anything beyond causes surcharge
- Urban runoff is 5x+ greater than pre-development due to impervious surfaces
- At 15cm (6in) water depth: small vehicles stall. At 60cm (2ft): emergency vehicles stall (FEMA)
- New construction must be 12in above Base Flood Elevation (FFRMS 2024)

SFWMD DESIGN CRITERIA:
- Post-development discharge must equal or be less than pre-development rates
- Treatment volume: 0.5in of runoff (or 1.88in × impervious area)
- Swale systems must percolate 80% of runoff from 3-year/1-hour storm
- Treatment volume recovery required within 72 hours

PROVEN INFRASTRUCTURE EFFECTIVENESS (EPA/ASCE data):
- Bioswales: capture up to 90% of sediment, 80% of metals/oils, 65% of phosphorus
- Rain gardens / bioretention: 56% average runoff volume reduction
- Permeable pavement: 50-90% peak flow reduction, 40-90% volume reduction
- Green roofs: 49-83% rainfall retention depending on vegetation
- Backflow preventers / tide gates: eliminate tidal backflow flooding (proven in Charleston SC)

COST BENCHMARKS:
- Pump stations: $150K (20 gpm) to $1.5M (100K gpm); planning estimate $30-40K per CFS capacity
- Retention/detention ponds: $10K-$21K per acre served; O&M 1-6% of construction cost/year
- Seawalls (South FL): $700-$1,200 per linear foot (vinyl)
- Bioswales: can reduce infrastructure costs from $850K (concrete vault) to $350K
- Permeable pavement: porous asphalt ~$1/sqft, pervious concrete ~$5/sqft
- Backflow preventers: ~$350 per installation (simple sewer)

═══════════════════════════════════════════════════
SECTION 1: FLOOD RISK SCORES (computed from all data sources)
Top 10 highest risk sensors:
═══════════════════════════════════════════════════
${JSON.stringify(riskScores.slice(0, 10), null, 2)}

═══════════════════════════════════════════════════
SECTION 2: PER-SENSOR FLOOD PROFILES (30 days)
Shows frequency, depth, duration, rainfall/tide correlation
═══════════════════════════════════════════════════
${JSON.stringify(sensorProfiles, null, 2)}

═══════════════════════════════════════════════════
SECTION 3: ELEVATION GRADIENT & WATER FLOW ANALYSIS
Each sensor compared to nearest neighbors. "water_flows_from" shows
uphill neighbors with slope percentage — water runs downhill toward dips.
═══════════════════════════════════════════════════
${JSON.stringify(gradients.filter((g) => g.is_dip || (sensorProfiles[g.device_id]?.count ?? 0) > 0), null, 2)}

═══════════════════════════════════════════════════
SECTION 4: NEIGHBORHOOD AGGREGATION
═══════════════════════════════════════════════════
${JSON.stringify(neighborhoodStats, null, 2)}

═══════════════════════════════════════════════════
SECTION 5: RAINFALL THRESHOLD ANALYSIS
Minimum rainfall that triggers flooding: ~${rainfallThreshold ?? "insufficient data"}mm
Rainfall-flood data pairs:
═══════════════════════════════════════════════════
${JSON.stringify(rainfallFloodPairs.slice(0, 20), null, 2)}

═══════════════════════════════════════════════════
SECTION 6: COMPOUND EVENT ANALYSIS
Events where BOTH rainfall >0mm AND tide >0.3m NAVD occurred simultaneously.
These compound events cause the worst flooding because storm drains can't
discharge into already-elevated tidal waterways.
Total compound events: ${events.filter((e) => (e.rainfall_mm ?? 0) > 0 && (e.tide_level_m ?? 0) > 0.3).length} of ${events.length} total
═══════════════════════════════════════════════════

ANALYSIS INSTRUCTIONS:
You must produce actionable infrastructure recommendations that a city engineer could present to the Aventura City Commission. Each recommendation must:

1. IDENTIFY the specific problem using data evidence (cite sensor IDs, depths, frequencies, elevations)
2. EXPLAIN the root cause by cross-referencing multiple data sources:
   - Elevation data → road dips, natural drainage basins
   - Water flow direction → which uphill areas drain into the problem spot
   - Rainfall correlation → what mm threshold triggers flooding at this location
   - Tidal influence → does high tide prevent storm drain outfall discharge
   - Compound events → rain + tide combinations that overwhelm the system
3. RECOMMEND a specific infrastructure improvement, citing the engineering standards above:
   - For road dips: catch basins, inlet capacity upgrades, road crown re-grading
   - For low elevation: bioswales (90% sediment capture per EPA), retention ponds ($10-21K/acre), French drains, pump stations
   - For tidal backflow: backflow preventers ($350/unit), tide gates, check valves on outfalls
   - For overwhelmed drainage: pipe upsizing, parallel relief pipes, new outfall locations
   - For neighborhood-wide issues: green infrastructure corridors, permeable pavement (50-90% peak flow reduction per ASCE)
   - Always note the FEMA $6:$1 mitigation ROI when justifying investment
4. ESTIMATE the impact quantitatively: "Based on the data, this would reduce flood frequency at [sensor] from [X] events/month to approximately [Y], a [Z]% reduction"
5. ESTIMATE cost using the real benchmarks above — not generic ranges
6. CONSIDER sea level rise: note that SE Florida projects +10-17in by 2040, so solutions must have 50+ year design life
7. CITE specific standards (FEMA, SFWMD, EPA, ASCE) when recommending solutions — this gives city commissioners confidence

Return a JSON object (no markdown fences, raw JSON only):
{
  "summary": "2-3 sentence executive summary of the overall flood situation, referencing Aventura's specific risk context",
  "recommendations": [
    {
      "priority": "high" | "medium" | "low",
      "category": "drainage" | "elevation" | "barrier" | "other",
      "affected_devices": ["FF-001", "FF-003"],
      "title": "Short title for the recommendation",
      "text": "Detailed multi-paragraph recommendation with data citations, engineering standard references, and impact estimates",
      "estimated_cost": "low" | "medium" | "high",
      "estimated_reduction_pct": 65
    }
  ]
}

Generate 6-8 recommendations ordered by priority. Each must cite at least one engineering standard or data source from the reference section above.`,
      }],
    });

    const content = response.content[0].type === "text" ? response.content[0].text : "";
    let parsed: {
      summary?: string;
      recommendations: Array<{
        priority: string;
        category: string;
        affected_devices: string[];
        title?: string;
        text: string;
        estimated_cost?: string;
        estimated_reduction_pct?: number;
      }>;
    };

    try {
      parsed = JSON.parse(content);
    } catch {
      const match = content.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("Could not parse AI response");
      parsed = JSON.parse(match[0]);
    }

    for (const rec of parsed.recommendations) {
      const neighborhoodTag = neighborhoodFilter ? `[${neighborhoodFilter}] ` : "";
      const fullText = rec.title
        ? `## ${neighborhoodTag}${rec.title}\n\n${rec.text}${rec.estimated_cost ? `\n\nEstimated cost: ${rec.estimated_cost}` : ""}${rec.estimated_reduction_pct ? ` | Estimated flood reduction: ${rec.estimated_reduction_pct}%` : ""}`
        : `${neighborhoodTag}${rec.text}`;

      await supabase.from("infrastructure_recommendations").insert({
        analysis_period_days: 30,
        recommendation_text: fullText,
        affected_device_ids: rec.affected_devices || [],
        priority: rec.priority || "medium",
        category: rec.category || "other",
      });
    }

    const scope = neighborhoodFilter ? ` for ${neighborhoodFilter}` : "";
    return NextResponse.json({
      message: `Generated ${parsed.recommendations.length} recommendations${scope}`,
      summary: parsed.summary ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[API] Run analysis error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
