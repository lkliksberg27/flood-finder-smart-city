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

  console.log(`[BRIDGE] Received from ${data.deviceId}: distance=${data.distanceCm}cm battery=${data.batteryV}V`);

  const valid = isValid(data);

  // Look up device to get calibration values
  const { data: device } = await supabase
    .from('devices')
    .select('mailbox_height_cm, baseline_distance_cm')
    .eq('device_id', data.deviceId)
    .single();

  const mailboxHeight = device?.mailbox_height_cm ?? 95;
  const floodDepth = Math.max(0, mailboxHeight - data.distanceCm);
  const waterDetected = floodDepth > 5;

  // Insert reading
  const { error: readErr } = await supabase.from('sensor_readings').insert({
    device_id: data.deviceId,
    lat: data.lat,
    lng: data.lng,
    altitude_gps: data.altitudeGPS,
    altitude_baro: data.altitudeBaro,
    distance_cm: data.distanceCm,
    water_detected: waterDetected,
    flood_depth_cm: floodDepth,
    battery_v: data.batteryV,
    rssi: data.rssi,
    is_valid: valid,
    recorded_at: new Date(data.timestamp * 1000).toISOString(),
  });
  if (readErr) console.error('[DB] Insert reading error:', readErr.message);
  else console.log(`[DB] Reading saved for ${data.deviceId} | flood_depth=${floodDepth}cm`);

  // Update device status + altitude from barometric sensor
  const newStatus = waterDetected ? 'alert' : 'online';
  const updateData = {
    last_seen: new Date().toISOString(),
    battery_v: data.batteryV,
    status: newStatus,
  };
  // Update device elevation from BMP390 if available
  if (data.altitudeBaro != null) {
    updateData.altitude_baro = data.altitudeBaro;
  }
  const { error: devErr } = await supabase
    .from('devices')
    .update(updateData)
    .eq('device_id', data.deviceId);
  if (devErr) console.error('[DB] Update device error:', devErr.message);

  // Manage flood events
  await manageFloodEvent(data.deviceId, waterDetected, floodDepth);
}

// ── Flood event tracking ────────────────────────────────────
async function manageFloodEvent(deviceId, waterDetected, floodDepth) {
  // Find open event (no ended_at)
  const { data: openEvents } = await supabase
    .from('flood_events')
    .select('id, peak_depth_cm')
    .eq('device_id', deviceId)
    .is('ended_at', null)
    .limit(1);

  const openEvent = openEvents?.[0];

  if (waterDetected) {
    if (openEvent) {
      if (floodDepth > openEvent.peak_depth_cm) {
        await supabase.from('flood_events')
          .update({ peak_depth_cm: floodDepth })
          .eq('id', openEvent.id);
      }
    } else {
      // Start new flood event — enrich with NOAA weather + tide data
      const { data: dev } = await supabase
        .from('devices')
        .select('lat, lng')
        .eq('device_id', deviceId)
        .single();

      let rainfall = null, tide = null;
      if (dev) {
        const [r, t] = await Promise.all([
          getRainfall(dev.lat, dev.lng),
          getTideLevel(dev.lat, dev.lng),
        ]);
        rainfall = r?.rainfallMm ?? null;
        tide = t?.tideM ?? null;
      }

      await supabase.from('flood_events').insert({
        device_id: deviceId,
        peak_depth_cm: floodDepth,
        rainfall_mm: rainfall,
        tide_level_m: tide,
      });
      console.log(`[EVENT] Flood started at ${deviceId} — depth=${floodDepth}cm rain=${rainfall}mm tide=${tide}m`);
    }
  } else if (openEvent) {
    await supabase.from('flood_events')
      .update({ ended_at: new Date().toISOString() })
      .eq('id', openEvent.id);
    console.log(`[EVENT] Flood ended at ${deviceId}`);
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

// ── Elevation gradient analysis helper ──────────────────────
// Identifies road dips by finding sensors that are lower than
// their nearest neighbors — water naturally flows to these spots.
function analyzeElevationGradients(devices) {
  const withElevation = devices.filter((d) => d.altitude_baro != null);
  if (withElevation.length < 3) return [];

  function haversineKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

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

// ── Weekly AI Analysis (Sunday 6 AM) ───────────────────────
async function runAIAnalysis() {
  console.log('[AI] Starting weekly infrastructure analysis...');

  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400 * 1000).toISOString();

    const [eventsRes, devicesRes] = await Promise.all([
      supabase
        .from('flood_events')
        .select('*, devices(device_id, name, lat, lng, neighborhood, altitude_baro)')
        .gte('started_at', thirtyDaysAgo),
      supabase.from('devices').select('*'),
    ]);

    const events = eventsRes.data;
    const allDevices = devicesRes.data;

    if (!events || events.length === 0) {
      console.log('[AI] No flood events in last 30 days — skipping analysis.');
      return;
    }

    // Build event summary
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

    // Analyze elevation gradients to find road dips
    const gradients = analyzeElevationGradients(allDevices || []);
    const dips = gradients.filter((g) => g.is_dip);

    // Get current weather context
    const weather = await getWeatherConditions(25.9565, -80.1392);

    // Count floods per device for frequency analysis
    const floodFrequency = {};
    events.forEach((e) => {
      if (!floodFrequency[e.device_id]) {
        floodFrequency[e.device_id] = {
          count: 0, totalDepth: 0, totalDuration: 0,
          device: e.devices,
        };
      }
      floodFrequency[e.device_id].count++;
      floodFrequency[e.device_id].totalDepth += e.peak_depth_cm;
      floodFrequency[e.device_id].totalDuration += e.duration_minutes || 0;
    });

    const anthropic = new Anthropic();

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250514',
      max_tokens: 3000,
      messages: [{
        role: 'user',
        content: `You are an urban flood infrastructure analyst working with the city of Aventura, Florida.
You have access to real sensor data from IoT devices mounted on mailboxes across the city.

FLOOD EVENTS (last 30 days):
${JSON.stringify(eventSummary, null, 2)}

FLOOD FREQUENCY PER SENSOR:
${JSON.stringify(floodFrequency, null, 2)}

ELEVATION GRADIENT ANALYSIS (identifies road dips where water pools):
${JSON.stringify(gradients, null, 2)}

IDENTIFIED ROAD DIPS (sensors lower than surrounding neighbors):
${JSON.stringify(dips, null, 2)}

CURRENT WEATHER CONDITIONS:
${JSON.stringify(weather, null, 2)}

Analyze this data and return a JSON object (no markdown, raw JSON only) with this structure:
{
  "recommendations": [
    {
      "priority": "high" | "medium" | "low",
      "category": "drainage" | "elevation" | "barrier" | "other",
      "affected_devices": ["FF-001", "FF-003"],
      "text": "Detailed recommendation..."
    }
  ]
}

ANALYSIS REQUIREMENTS:
1. Identify the top 5 locations with most frequent/severe flooding
2. Cross-reference flood locations with elevation data:
   - Which sensors sit in road dips (negative elevation_diff)?
   - Do low-elevation sensors flood more often? Quantify the correlation.
   - Which road segments slope toward flood-prone areas?
3. Analyze NOAA data correlation:
   - Do floods correlate with rainfall amounts? What threshold triggers flooding?
   - Do tidal events compound flooding at low-elevation coastal sensors?
   - Are certain sensors only affected during high-tide + rain combinations?
4. Infrastructure recommendations must be SPECIFIC:
   - For road dips: recommend catch basins, french drains, or road re-grading with exact locations
   - For low elevation areas: recommend swales, retention ponds, or pump stations
   - For tidal flooding: recommend backflow preventers or tide gates
   - For drainage: recommend pipe upsizing or new outfall locations
5. Estimate impact: "Would reduce flood frequency at [location] by approximately X%"
6. Consider cost-effectiveness: prioritize improvements that help multiple sensors

Limit to 5-8 recommendations, ordered by priority.`,
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
      await supabase.from('infrastructure_recommendations').insert({
        analysis_period_days: 30,
        recommendation_text: rec.text,
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

// Run every Sunday at 6:00 AM
cron.schedule('0 6 * * 0', runAIAnalysis);

// Export for on-demand use by dashboard API
module.exports = { runAIAnalysis };

console.log('[BRIDGE] Flood Finder bridge service started.');
