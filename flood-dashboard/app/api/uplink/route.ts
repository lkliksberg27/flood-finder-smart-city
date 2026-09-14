import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { decodePayload, normalise } from "@/lib/uplink-decoder";

/**
 * LoRaWAN uplink receiver. THE endpoint a gateway or network server posts to.
 *
 * Until this existed the chain had a hole in the middle: firmware, gateway,
 * ChirpStack, database, views and both apps were all built, but nothing was
 * deployed at a URL a gateway could reach, so no reading could ever arrive.
 * `02_backend/api/gw.js` had the logic and no deployment target; the dashboard
 * has a deployment target and had no receiver.
 *
 * Point the network server here:
 *   ChirpStack  Applications -> your app -> Integrations -> HTTP
 *               Event endpoint URL: https://<dashboard>/api/uplink
 *   WisGateOS   Applications -> floodfinder -> Configuration -> Uplink data URL
 *   TTN         Integrations -> Webhooks -> custom, uplink message
 *
 * Env:
 *   SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_KEY   service_role. Server side only, never shipped.
 *   UPLINK_SECRET          optional. If set, requests must carry it as
 *                          ?key=... or X-Uplink-Key. Without it, anyone who
 *                          finds the URL can inject fake flood readings.
 *
 * Always answers 200 for anything that is merely unrecognised, because a
 * network server that does not get a 2xx retries, and retries turn one real
 * reading into duplicates. Only genuine server faults return 5xx.
 */

export const dynamic = "force-dynamic";

function reject(code: number, error: string) {
  console.error("uplink rejected:", error);
  return NextResponse.json({ ok: false, error }, { status: code });
}

/** Best effort forensic log. Never allowed to break ingest. */
async function logRaw(row: Record<string, unknown>) {
  try {
    const supabase = createServiceClient();
    await supabase.from("gw_raw").insert(row);
  } catch (e) {
    console.error("gw_raw log failed (ignored):", (e as Error).message);
  }
}

export async function POST(request: Request) {
  const url = new URL(request.url);

  const want = process.env.UPLINK_SECRET;
  if (want) {
    const got = request.headers.get("x-uplink-key") ?? url.searchParams.get("key");
    if (got !== want) return reject(401, "bad or missing key");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return reject(400, "body is not valid JSON");
  }

  const n = normalise(body);

  // Unknown envelope: log the whole thing rather than guess. The first real
  // packet from a new gateway is exactly how you learn its shape.
  if (!n) {
    console.log("uplink: UNRECOGNISED ENVELOPE >>>", JSON.stringify(body).slice(0, 2000));
    await logRaw({ source: "unknown", decoded: false, note: "unrecognised envelope shape", envelope: body });
    return NextResponse.json({ ok: true, note: "unrecognised envelope, logged" });
  }

  // Join / ack / device-status events share this endpoint and carry no payload.
  if (!n.raw_b64 && !n.predecoded) {
    await logRaw({
      source: n.source, device_id: n.device_id, dev_eui: n.dev_eui,
      f_port: n.f_port, f_cnt: n.f_cnt, rssi: n.rssi, snr: n.snr,
      gateway: n.gateway, decoded: false,
      note: "join / ack / status event, no payload", envelope: body,
    });
    return NextResponse.json({ ok: true, note: "no payload, ignored" });
  }

  const base: Record<string, unknown> = {
    source: n.source, device_id: n.device_id, dev_eui: n.dev_eui,
    f_port: n.f_port, f_cnt: n.f_cnt, rssi: n.rssi, snr: n.snr,
    gateway: n.gateway, raw_b64: n.raw_b64,
  };

  let d = null as ReturnType<typeof decodePayload>["data"] | null;
  let warnings: string[] = [];

  if (n.raw_b64) {
    const bytes = Buffer.from(n.raw_b64, "base64");
    base.raw_hex = bytes.toString("hex");
    base.len = bytes.length;

    const r = decodePayload(bytes, n.f_port);

    if (r.fuota) {
      await logRaw({ ...base, decoded: false, note: `FUOTA frame on fPort ${n.f_port}` });
      return NextResponse.json({ ok: true, note: "fuota control frame" });
    }
    if (r.errors) {
      console.error(`uplink: decode failed fPort=${n.f_port} len=${bytes.length}`, r.errors, bytes.toString("hex"));
      await logRaw({ ...base, decoded: false, note: "DECODE FAILED: " + r.errors.join("; ") });
      return NextResponse.json({ ok: false, note: "decode failed", errors: r.errors });
    }
    d = r.data ?? null;
    warnings = r.warnings ?? [];
    await logRaw({ ...base, decoded: true, note: (d?.type ?? "?") + (warnings.length ? " · " + warnings.join("; ") : "") });
  } else {
    d = n.predecoded as unknown as typeof d;
    await logRaw({ ...base, decoded: true, note: "pre-decoded by network server" });
  }

  if (!d) return NextResponse.json({ ok: true, note: "nothing to store" });

  const f = d.flags ?? ({} as Record<string, boolean>);

  const row = {
    device_id: n.device_id,
    dev_eui: n.dev_eui,
    packet_type: d.type ?? null,
    seq: d.seq ?? null,
    fw_version: d.fw_version ?? null,

    distance_mm: d.distance_mm ?? null,
    distances_mm: d.distances_mm ?? null,
    pressure_pa: d.pressure_pa ?? null,
    temp_c: d.temp_c ?? null,
    vbat_v: d.vbat_v ?? null,

    node_state: d.state ?? null,
    power_tier: d.power_tier ?? null,
    valid_pings: d.valid_pings ?? null,
    spread_mm: d.spread_mm ?? null,

    buffered: !!f.buffered,
    low_battery: !!f.low_battery,
    sensor_degraded: !!f.sensor_degraded,
    threshold_alert: !!f.threshold_alert,
    rate_alert: !!f.rate_alert,
    commissioned: !!f.commissioned,

    boot_count: d.boot_count ?? null,
    reset_reason: d.reset_reason ?? null,

    // commissioning-only
    lat: d.lat ?? null,
    lon: d.lon ?? null,
    tilt_deg: d.tilt_deg ?? null,
    baseline_mm: d.baseline_mm ?? null,
    link_margin_db: d.link_margin_db ?? null,
    gateway_count: d.gateway_count ?? null,

    rssi: n.rssi,
    snr: n.snr,
    gateway: n.gateway,
    spreading_factor: n.sf,
    f_port: n.f_port,
    f_cnt: n.f_cnt,
    source: n.source,
    received_at: n.received ?? new Date().toISOString(),
  };

  if (warnings.length) console.warn(`uplink: ${n.dev_eui} seq=${row.seq}:`, warnings.join("; "));

  const supabase = createServiceClient();
  const { error } = await supabase.from("readings").insert(row);
  if (error) return reject(500, `supabase insert failed: ${error.message}`);

  return NextResponse.json({ ok: true, seq: row.seq, type: row.packet_type, warnings });
}

/** Convenience probe so you can confirm the route is deployed from a browser. */
export async function GET() {
  return NextResponse.json({
    ok: true,
    endpoint: "flood finder uplink receiver",
    accepts: "POST, TTN v3 / ChirpStack v4 / ChirpStack v3 (WisGateOS)",
    secured: !!process.env.UPLINK_SECRET,
  });
}
