require('dotenv').config();
const mqtt = require('mqtt');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
const Anthropic = require('@anthropic-ai/sdk');
const { getRainfall, getTideLevel } = require('./noaa');

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

  // Update device status
  const newStatus = waterDetected ? 'alert' : 'online';
  const { error: devErr } = await supabase
    .from('devices')
    .update({ last_seen: new Date().toISOString(), battery_v: data.batteryV, status: newStatus })
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
      // Update peak depth if higher
      if (floodDepth > openEvent.peak_depth_cm) {
        await supabase.from('flood_events')
          .update({ peak_depth_cm: floodDepth })
          .eq('id', openEvent.id);
      }
    } else {
      // Start new flood event, enrich with NOAA data
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
      console.log(`[EVENT] Flood started at ${deviceId} — depth=${floodDepth}cm`);
    }
  } else if (openEvent) {
    // Water gone — close the event
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

// ── Weekly AI Analysis (Sunday 6 AM) ───────────────────────
async function runAIAnalysis() {
  console.log('[AI] Starting weekly infrastructure analysis...');

  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400 * 1000).toISOString();

    const { data: events } = await supabase
      .from('flood_events')
      .select('*, devices(device_id, name, lat, lng, neighborhood, altitude_baro)')
      .gte('started_at', thirtyDaysAgo);

    if (!events || events.length === 0) {
      console.log('[AI] No flood events in last 30 days — skipping analysis.');
      return;
    }

    // Summarize for the prompt
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

    const anthropic = new Anthropic();

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 2000,
      messages: [{
        role: 'user',
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

    const content = response.content[0].text;
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      // Try extracting JSON from potential markdown wrapping
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
