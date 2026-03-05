require('dotenv').config();
const mqtt = require('mqtt');

const MQTT_URL = `mqtts://${process.env.MQTT_HOST}:8883`;

const client = mqtt.connect(MQTT_URL, {
  username: process.env.MQTT_USER,
  password: process.env.MQTT_PASS,
});

// ── Generate 20 fake devices across Aventura, FL ────────────
const NEIGHBORHOODS = [
  'Aventura North', 'Aventura South', 'Aventura West',
  'Country Club', 'Turnberry', 'Biscayne Yacht Club',
  'Mystic Pointe', 'Williams Island',
];

const devices = Array.from({ length: 20 }, (_, i) => {
  const id = `FF-${String(i + 1).padStart(3, '0')}`;
  return {
    deviceId: id,
    lat: 25.93 + Math.random() * 0.04,
    lng: -80.16 + Math.random() * 0.04,
    altitudeGPS: 1.0 + Math.random() * 2.5,
    altitudeBaro: 0.8 + Math.random() * 2.0,
    mailboxHeightCm: 95,
    baselineDistanceCm: 90 + Math.floor(Math.random() * 6),
    battery: 3.6 + Math.random() * 0.6,
    flooding: false,
    floodStart: 0,
    floodDuration: 0,
    neighborhood: NEIGHBORHOODS[i % NEIGHBORHOODS.length],
  };
});

// ── State tracking ──────────────────────────────────────────
let cycle = 0;

function buildPayload(dev) {
  let distanceCm;

  if (dev.flooding) {
    // Simulate water rising then falling
    const elapsed = (Date.now() - dev.floodStart) / 1000;
    const progress = elapsed / dev.floodDuration;
    if (progress >= 1) {
      // Flood ended
      dev.flooding = false;
      distanceCm = dev.baselineDistanceCm;
    } else {
      // Bell-curve flood: peaks at 50% progress
      const intensity = Math.sin(progress * Math.PI);
      const maxFloodDepth = 20 + Math.random() * 40; // 20-60cm flood
      distanceCm = Math.max(10, dev.baselineDistanceCm - Math.floor(intensity * maxFloodDepth));
    }
  } else {
    // Normal reading with slight noise (±2cm)
    distanceCm = dev.baselineDistanceCm + Math.floor(Math.random() * 5 - 2);
  }

  // Battery slowly drains
  dev.battery = Math.max(2.8, dev.battery - 0.001);

  return {
    deviceId: dev.deviceId,
    lat: dev.lat,
    lng: dev.lng,
    altitudeGPS: dev.altitudeGPS,
    altitudeBaro: dev.altitudeBaro,
    distanceCm,
    waterDetected: (dev.mailboxHeightCm - distanceCm) > 5,
    batteryV: parseFloat(dev.battery.toFixed(2)),
    rssi: -50 - Math.floor(Math.random() * 40),
    timestamp: Math.floor(Date.now() / 1000),
  };
}

function publishCycle() {
  cycle++;
  console.log(`\n--- Cycle ${cycle} ---`);

  for (const dev of devices) {
    // 15% chance non-flooding device starts flooding
    if (!dev.flooding && Math.random() < 0.15) {
      dev.flooding = true;
      dev.floodStart = Date.now();
      dev.floodDuration = (180 + Math.random() * 300) * 1000; // 3-8 minutes
      console.log(`[SIM] ${dev.deviceId} FLOOD STARTED (duration: ${Math.round(dev.floodDuration / 1000)}s)`);
    }

    const payload = buildPayload(dev);
    const topic = `floodfinder/sensors/${dev.deviceId}`;
    client.publish(topic, JSON.stringify(payload));

    const status = dev.flooding ? '🌊 FLOODING' : '✅ OK';
    console.log(`[SIM] ${dev.deviceId} ${status} dist=${payload.distanceCm}cm batt=${payload.batteryV}V`);
  }
}

// ── Main loop ───────────────────────────────────────────────
client.on('connect', () => {
  console.log('[SIM] Connected to MQTT broker');
  console.log(`[SIM] Simulating ${devices.length} devices`);

  // Normal cycle every 15 seconds
  setInterval(() => {
    publishCycle();
  }, 15000);

  // Flooding devices get extra updates every 5 seconds
  setInterval(() => {
    for (const dev of devices) {
      if (dev.flooding) {
        const payload = buildPayload(dev);
        client.publish(`floodfinder/sensors/${dev.deviceId}`, JSON.stringify(payload));
      }
    }
  }, 5000);

  // Publish first cycle immediately
  publishCycle();
});

client.on('error', (err) => console.error('[SIM] MQTT error:', err.message));
