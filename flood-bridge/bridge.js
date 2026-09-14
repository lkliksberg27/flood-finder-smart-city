require('dotenv').config();
const mqtt = require('mqtt');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
const Anthropic = require('@anthropic-ai/sdk');
const { getRainfall, getTideLevel, getWeatherConditions } = require('./noaa');

// ── Config ──────────────────────────────────────────────────
const MQTT_URL = `mqtts://${process.env.MQTT_HOST}:8883`;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ── Validation helpers ──────────────────────────────────────
function isValid(d) {
  return (
    d.distanceCm >= 10 && d.distanceCm <= 400 &&
    d.batteryV >= 2.5 && d.batteryV <= 4.5 &&
    d.lat >= 24 && d.lat <= 27 &&
    d.lng >= -82 && d.lng <= -79
  );
}

// ── Process a single sensor message ─────────────────────────
async function handleMessage(topic, payload) {
  let data;
  try {
    data = JSON.parse(payload.toString());
  } catch {
    console.error('[BRIDGE] Bad JSON on', topic);
    return;
  }

  if (!data.deviceId) {
    console.error('[BRIDGE] Message with no deviceId on', topic);
    return;
  }

  console.log(`[BRIDGE] Received from ${data.deviceId}: distance=${data.distanceCm}cm battery=${data.batteryV}V`);

  // A node without a time fix can send 0 or a garbage timestamp. Date(NaN)
  // throws on toISOString(), and a 0 becomes 1970, which silently poisons
  // every time-series query. Fall back to arrival time instead.
  const sentMs = Number(data.timestamp) * 1000;
  const recordedAt =
    Number.isFinite(sentMs) && sentMs > 946684800000 // 2000-01-01
      ? new Date(sentMs).toISOString()
      : new Date().toISOString();

  const valid = isValid(data);
  if (!valid) {
    console.warn(
      `[BRIDGE] Reading from ${data.deviceId} failed range checks ` +
        `(distance=${data.distanceCm} battery=${data.batteryV} ` +
        `lat=${data.lat} lng=${data.lng}). Storing it flagged invalid and ` +
        'not letting it drive alerts.'
    );
  }

  // `devices` is a VIEW over `nodes` now, and a view cannot be written to, so
  // everything below targets the canonical tables. A LoRa node reaching
  // /api/uplink and a WiFi node reaching this bridge therefore land in exactly
  // the same place, which is the only way the apps can show both.
  //
  // The bridge speaks the WiFi-era JSON: deviceId, distanceCm, centimetres.
  // `readings` is in millimetres, so convert once, here.
  const devEui = data.devEui || data.deviceId;

  const { data: node, error: lookupErr } = await supabase
    .from('nodes')
    .select('dev_eui, baseline_mm')
    .eq('dev_eui', devEui)
    .single();

  if (lookupErr && lookupErr.code === 'PGRST116') {
    console.log(`[BRIDGE] Unknown device ${data.deviceId} — auto-registering`);
    const { error: regErr } = await supabase.from('nodes').insert({
      dev_eui: devEui,
      device_id: data.deviceId,
      lat: data.lat,
      lon: data.lng,
      elevation_mm: data.altitudeBaro != null ? Math.round(data.altitudeBaro * 1000) : null,
      baseline_mm: 950,
      last_seen: new Date().toISOString(),
    });
    if (regErr) {
      console.error('[DB] Auto-register failed for', data.deviceId, regErr.message);
      // readings has a foreign key onto nodes, so the insert below would fail
      // too. Stop here rather than emit a confusing second error.
      return;
    }
  }

  // Depth is derived in SQL from baseline_mm, so the bridge does not compute or
  // store it. It only needs the millimetre distance. Keeping depth out of the
  // write path is what lets a later recalibration of baseline_mm fix a node's
  // entire history rather than only its future rows.
  const distanceMm = Math.round(data.distanceCm * 10);
  const baselineMm = node?.baseline_mm ?? 950;
  const floodDepthMm = Math.max(0, baselineMm - distanceMm);

  const { error: readErr } = await supabase.from('readings').insert({
    dev_eui: devEui,
    device_id: data.deviceId,
    packet_type: 'reading',
    distance_mm: distanceMm,
    lat: data.lat,
    lon: data.lng,
    vbat_v: data.batteryV,
    baseline_mm: baselineMm,
    is_valid: valid,
    sensor_degraded: !valid,
    source: 'mqtt-bridge',
    received_at: recordedAt,
  });
  if (readErr) console.error('[DB] Insert reading error:', readErr.message);
  else console.log(`[DB] Reading saved for ${data.deviceId} | depth=${floodDepthMm}mm`);

  // No device-status update here any more. `nodes.last_seen` is maintained by
  // the touch_node trigger on every readings insert, and `devices.status` is
  // derived in the view from last_seen plus the latest depth. Writing status
  // by hand would fight the view and could not be written to it anyway.

  // Flood events are opened and closed by the maintain_flood_event trigger on
  // `readings`, with hysteresis, so both ingest paths produce identical event
  // history. The bridge's only remaining job here is to attach the NOAA
  // context, which the database cannot fetch for itself.
  if (valid && floodDepthMm >= 50) {
    await enrichOpenEvent(data.deviceId, data.lat, data.lng);
  }
}

// ── NOAA enrichment ─────────────────────────────────────────
// The trigger opens the event; this fills in the weather context once. Only
// touches rows where rainfall is still null, so it costs one NOAA call per
// event rather than one per reading.
async function enrichOpenEvent(deviceId, lat, lng) {
  const { data: open } = await supabase
    .from('flood_events')
    .select('id, rainfall_mm')
    .eq('device_id', deviceId)
    .is('ended_at', null)
    .limit(1);

  const ev = open?.[0];
  if (!ev || ev.rainfall_mm !== null) return;

  try {
    const [r, t] = await Promise.all([getRainfall(lat, lng), getTideLevel(lat, lng)]);
    await supabase.from('flood_events').update({
      rainfall_mm: r?.rainfallMm ?? null,
      tide_level_m: t?.tideM ?? null,
    }).eq('id', ev.id);
    console.log(`[EVENT] Enriched ${deviceId} — rain=${r?.rainfallMm ?? '?'}mm tide=${t?.tideM ?? '?'}m`);
  } catch (e) {
    console.error('[EVENT] NOAA enrichment failed:', e.message);
  }
}

// ── MQTT connection ─────────────────────────────────────────
const client = mqtt.connect(MQTT_URL, {
  username: process.env.MQTT_USER,
  password: process.env.MQTT_PASS,
  reconnectPeriod: 5000,
});

client.on('connect', () => {
  console.log('[MQTT] Connected to broker');
  client.subscribe('floodfinder/sensors/#', (err) => {
    if (err) console.error('[MQTT] Subscribe error:', err.message);
    else console.log('[MQTT] Subscribed to floodfinder/sensors/#');
  });
});

client.on('message', (topic, payload) => {
  handleMessage(topic, payload).catch((err) =>
    console.error('[BRIDGE] Error processing message:', err.message)
  );
});

client.on('error', (err) => console.error('[MQTT] Error:', err.message));
client.on('reconnect', () => console.log('[MQTT] Reconnecting...'));
client.on('offline', () => console.log('[MQTT] Offline'));

// ── Haversine distance (km) ─────────────────────────────────
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Elevation gradient analysis helper ──────────────────────
// Identifies road dips by finding sensors that are lower than
// their nearest neighbors — water naturally flows to these spots.
function analyzeElevationGradients(devices) {
  const withElevation = devices.filter((d) => d.altitude_baro != null);
  if (withElevation.length < 3) return [];

  return withElevation.map((d) => {
    // Find 3 nearest neighbors
    const neighbors = withElevation
      .filter((n) => n.device_id !== d.device_id)
      .map((n) => ({
        ...n,
        distance_km: haversineKm(d.lat, d.lng, n.lat, n.lng),
      }))
      .sort((a, b) => a.distance_km - b.distance_km)
      .slice(0, 3);

    const avgNeighborElev = neighbors.reduce((s, n) => s + n.altitude_baro, 0) / neighbors.length;
    const elevDiff = d.altitude_baro - avgNeighborElev;
    const slopePercent = neighbors.length > 0
      ? (elevDiff / (neighbors[0].distance_km * 1000)) * 100
      : 0;

    return {
      device_id: d.device_id,
      name: d.name,
      neighborhood: d.neighborhood,
      elevation_m: d.altitude_baro,
      avg_neighbor_elevation_m: parseFloat(avgNeighborElev.toFixed(2)),
      elevation_diff_m: parseFloat(elevDiff.toFixed(2)),
      slope_percent: parseFloat(slopePercent.toFixed(3)),
      is_dip: elevDiff < -0.15, // More than 15cm lower than neighbors
      nearest_neighbor_distance_m: Math.round(neighbors[0]?.distance_km * 1000 || 0),
    };
  });
}

// ── Water flow bearing calculation ──────────────────────────
function bearing(lat1, lng1, lat2, lng2) {
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const y = Math.sin(dLng) * Math.cos(lat2 * Math.PI / 180);
  const x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180) -
    Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

function bearingToDirection(deg) {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(deg / 45) % 8];
}

// ── Weekly AI Analysis (Sunday 6 AM) ───────────────────────
async function runAIAnalysis() {
  console.log('[AI] Starting weekly infrastructure analysis...');

  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400 * 1000).toISOString();

    const [eventsRes, devicesRes] = await Promise.all([
      supabase
        .from('flood_events')
        .select('*, devices(device_id, name, lat, lng, neighborhood, altitude_baro, battery_v)')
        .gte('started_at', thirtyDaysAgo),
      supabase.from('devices').select('*'),
    ]);

    const events = eventsRes.data;
    const allDevices = devicesRes.data || [];

    if (!events || events.length === 0) {
      console.log('[AI] No flood events in last 30 days — skipping analysis.');
      return;
    }

    // ── 1. Per-sensor flood profiles ─────────────────────────
    const sensorProfiles = {};
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
      p.totalDurationMin += e.duration_minutes || 0;
      if (e.rainfall_mm > 0) { p.rainfallEvents++; p.avgRainfallMm += e.rainfall_mm; }
      if (e.tide_level_m > 0.3) { p.tidalEvents++; p.avgTideLevelM += e.tide_level_m; }
      if (e.rainfall_mm >= 2 && e.tide_level_m > 0.3) p.compoundEvents++;

      const hour = new Date(e.started_at).getHours();
      if (hour >= 6 && hour < 12) p.timeOfDayDistribution.morning++;
      else if (hour >= 12 && hour < 17) p.timeOfDayDistribution.afternoon++;
      else if (hour >= 17 && hour < 22) p.timeOfDayDistribution.evening++;
      else p.timeOfDayDistribution.night++;
    });
    Object.values(sensorProfiles).forEach((p) => {
      p.avgDepthCm = Math.round(p.avgDepthCm / p.count);
      p.avgDurationMin = Math.round(p.totalDurationMin / p.count);
      if (p.rainfallEvents > 0) p.avgRainfallMm = +(p.avgRainfallMm / p.rainfallEvents).toFixed(1);
      if (p.tidalEvents > 0) p.avgTideLevelM = +(p.avgTideLevelM / p.tidalEvents).toFixed(2);
    });

    // ── 2. Elevation gradients with water flow direction ─────
    const gradients = analyzeElevationGradients(allDevices);
    const withElev = allDevices.filter((d) => d.altitude_baro != null);

    // Add water flow direction to gradient analysis
    const gradientsWithFlow = gradients.map((g) => {
      const d = allDevices.find((dev) => dev.device_id === g.device_id);
      if (!d) return g;
      const uphillNeighbors = withElev
        .filter((n) => n.device_id !== d.device_id && n.altitude_baro > d.altitude_baro)
        .map((n) => ({
          from: n.device_id,
          direction: bearingToDirection(bearing(d.lat, d.lng, n.lat, n.lng)),
          distance_m: Math.round(haversineKm(d.lat, d.lng, n.lat, n.lng) * 1000),
        }))
        .sort((a, b) => a.distance_m - b.distance_m)
        .slice(0, 3);
      return { ...g, water_flows_from: uphillNeighbors };
    });

    // ── 3. Neighborhood aggregation ─────────────────────────
    const neighborhoodStats = {};
    allDevices.forEach((d) => {
      const n = d.neighborhood || 'Unknown';
      if (!neighborhoodStats[n]) neighborhoodStats[n] = {
        totalEvents: 0, avgElevation: 0, sensorCount: 0,
        worstSensor: '', worstSensorEvents: 0,
      };
      neighborhoodStats[n].sensorCount++;
      neighborhoodStats[n].avgElevation += d.altitude_baro || 0;
    });
    Object.entries(sensorProfiles).forEach(([deviceId, p]) => {
      const n = p.device?.neighborhood || 'Unknown';
      if (neighborhoodStats[n]) {
        neighborhoodStats[n].totalEvents += p.count;
        if (p.count > neighborhoodStats[n].worstSensorEvents) {
          neighborhoodStats[n].worstSensor = deviceId;
          neighborhoodStats[n].worstSensorEvents = p.count;
        }
      }
    });
    Object.values(neighborhoodStats).forEach((ns) => {
      ns.avgElevation = +(ns.avgElevation / ns.sensorCount).toFixed(2);
    });

    // ── 4. Rainfall threshold analysis ──────────────────────
    const rainfallFloodPairs = events
      .filter((e) => e.rainfall_mm != null && e.rainfall_mm > 0)
      .map((e) => ({ rainfall_mm: e.rainfall_mm, depth_cm: e.peak_depth_cm, device: e.device_id }));

    const rainfallThreshold = rainfallFloodPairs.length > 2
      ? +(rainfallFloodPairs.reduce((s, p) => s + p.rainfall_mm, 0) / rainfallFloodPairs.length * 0.5).toFixed(1)
      : null;

    // ── 5. Flood risk scores ────────────────────────────────
    const riskScores = allDevices.map((d) => {
      const profile = sensorProfiles[d.device_id];
      const gradient = gradients.find((g) => g.device_id === d.device_id);
      let score = 0;
      score += Math.min(40, (profile?.count ?? 0) * 8);
      score += Math.min(25, (profile?.maxDepthCm ?? 0) * 0.5);
      if (d.altitude_baro != null && d.altitude_baro < 1.5) {
        score += Math.round((1.5 - d.altitude_baro) * 13);
      }
      if (gradient?.is_dip) score += Math.min(15, Math.abs(gradient.elevation_diff_m) * 50);
      return {
        device_id: d.device_id,
        name: d.name,
        neighborhood: d.neighborhood,
        risk_score: Math.min(100, Math.round(score)),
        risk_level: score > 60 ? 'critical' : score > 35 ? 'high' : score > 15 ? 'moderate' : 'low',
      };
    }).sort((a, b) => b.risk_score - a.risk_score);

    // ── 6. Get current weather context ──────────────────────
    const weather = await getWeatherConditions(25.9565, -80.1392);

    // ── 7. Build comprehensive AI prompt ────────────────────
    const compoundCount = events.filter((e) => e.rainfall_mm >= 2 && e.tide_level_m > 0.3).length;

    const anthropic = new Anthropic();

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: `You are a senior urban flood infrastructure engineer consulting for the City of Aventura, Florida.
You are analyzing 30 days of real-time data from ${allDevices.length} IoT flood sensors mounted on mailboxes across the city.
Each sensor uses an ultrasonic distance sensor to detect water depth, a BMP390 barometric altimeter for precision elevation (±0.25m), and GPS.
NOAA weather and tide data is automatically correlated with each flood event.

═══════════════════════════════════════════════════
SECTION 1: FLOOD RISK SCORES (top 10)
═══════════════════════════════════════════════════
${JSON.stringify(riskScores.slice(0, 10), null, 2)}

═══════════════════════════════════════════════════
SECTION 2: PER-SENSOR FLOOD PROFILES (30 days)
═══════════════════════════════════════════════════
${JSON.stringify(sensorProfiles, null, 2)}

═══════════════════════════════════════════════════
SECTION 3: ELEVATION GRADIENT & WATER FLOW ANALYSIS
═══════════════════════════════════════════════════
${JSON.stringify(gradientsWithFlow.filter((g) => g.is_dip || (sensorProfiles[g.device_id]?.count ?? 0) > 0), null, 2)}

═══════════════════════════════════════════════════
SECTION 4: NEIGHBORHOOD AGGREGATION
═══════════════════════════════════════════════════
${JSON.stringify(neighborhoodStats, null, 2)}

═══════════════════════════════════════════════════
SECTION 5: RAINFALL THRESHOLD ANALYSIS
Minimum rainfall that triggers flooding: ~${rainfallThreshold ?? 'insufficient data'}mm
Sample pairs: ${JSON.stringify(rainfallFloodPairs.slice(0, 15), null, 2)}
═══════════════════════════════════════════════════

═══════════════════════════════════════════════════
SECTION 6: COMPOUND EVENT ANALYSIS
Rain + high tide simultaneously: ${compoundCount} of ${events.length} total events
═══════════════════════════════════════════════════

WEATHER CONTEXT: ${JSON.stringify(weather, null, 2)}

ANALYSIS INSTRUCTIONS:
Produce actionable infrastructure recommendations for the Aventura City Commission. Each must:
1. IDENTIFY the problem using data evidence (sensor IDs, depths, frequencies, elevations)
2. EXPLAIN root cause by cross-referencing elevation data, water flow direction, rainfall correlation, tidal influence, and compound events
3. RECOMMEND specific infrastructure: catch basins, French drains, re-grading, bioswales, pump stations, backflow preventers, pipe upsizing, tide gates, permeable pavement
4. ESTIMATE impact: "reduce flood frequency at [sensor] from [X] to ~[Y] events/month, a [Z]% reduction"
5. ESTIMATE cost: low ($10K-50K), medium ($50K-250K), high ($250K-1M+)
6. PRIORITIZE by cost-effectiveness

Return raw JSON (no markdown fences):
{
  "recommendations": [
    {
      "priority": "high"|"medium"|"low",
      "category": "drainage"|"elevation"|"barrier"|"other",
      "affected_devices": ["FF-001"],
      "title": "Short title",
      "text": "Detailed recommendation with data citations",
      "estimated_cost": "low"|"medium"|"high",
      "estimated_reduction_pct": 65
    }
  ]
}
Generate 6-8 recommendations mixing ALL data sources.`,
      }],
    });

    const content = response.content[0].text;
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      const match = content.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : null;
    }

    if (!parsed?.recommendations) {
      console.error('[AI] Could not parse recommendations from response');
      return;
    }

    for (const rec of parsed.recommendations) {
      const fullText = rec.title
        ? `## ${rec.title}\n\n${rec.text}${rec.estimated_cost ? `\n\nEstimated cost: ${rec.estimated_cost}` : ''}${rec.estimated_reduction_pct ? ` | Estimated flood reduction: ${rec.estimated_reduction_pct}%` : ''}`
        : rec.text;
      await supabase.from('infrastructure_recommendations').insert({
        analysis_period_days: 30,
        recommendation_text: fullText,
        affected_device_ids: rec.affected_devices || [],
        priority: rec.priority || 'medium',
        category: rec.category || 'other',
      });
    }

    console.log(`[AI] Saved ${parsed.recommendations.length} recommendations.`);
  } catch (err) {
    console.error('[AI] Analysis failed:', err.message);
  }
}

// Run AI analysis every Sunday at 6:00 AM
cron.schedule('0 6 * * 0', runAIAnalysis);

// ── Stale device detection ──────────────────────────────────
// Deleted deliberately. `devices.status` is computed in the view from
// last_seen against the app_settings.stale_minutes threshold, so a node goes
// offline the moment it stops reporting, with no cron and no write. The old
// job also wrote to `devices`, which is now a view and rejects writes.


// Export for on-demand use by dashboard API
module.exports = { runAIAnalysis };

console.log('[BRIDGE] Flood Finder bridge service started.');
