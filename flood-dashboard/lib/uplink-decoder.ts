/**
 * Flood Finder uplink decoder, dashboard runtime copy.
 *
 * WHY THIS FILE EXISTS HERE
 * ------------------------
 * The receiver has to be deployed somewhere a gateway can POST to. The
 * dashboard is already on Vercel, so `app/api/uplink/route.ts` is the natural
 * home and this is the logic it runs.
 *
 * THERE ARE THREE COPIES OF THIS DECODER AND THAT IS DELIBERATE:
 *   1. this file                      runtime, what actually ingests packets
 *   2. 02_backend/payload_decoder.js  pasted into the ChirpStack console codec
 *   3. 02_backend/api/gw.js           standalone receiver + the e2e test target
 *
 * They exist because WisGateOS offers no custom-JavaScript codec slot and a
 * console codec cannot be imported by a serverless function. The risk is drift:
 * a stale `PING_COUNT` of 20 survived in two of them after the firmware moved
 * to 40, and made a health warning fire on every healthy burst.
 * `02_backend/test_decoder_sync.mjs` guards the constants that actually bit us.
 *
 * Everything is little-endian, matching the packed structs in ff_lora.h.
 */

// MUST match PING_COUNT in ff_sensors.h. The packet reports how many pings came
// back, never how many were attempted, so the denominator lives in the decoder.
export const PING_COUNT = 40;
export const PING_WARN_BELOW = Math.round(PING_COUNT * 0.7); // 28 of 40

export const NO_READING = -32768; // sensor saw no echo. NOT the same as "dry".

const u8 = (b: Uint8Array, i: number) => b[i];
const u16 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const i16 = (b: Uint8Array, i: number) => {
  const v = u16(b, i);
  return v > 32767 ? v - 65536 : v;
};
const u32 = (b: Uint8Array, i: number) =>
  (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)) + b[i + 3] * 16777216;
const i32 = (b: Uint8Array, i: number) => {
  const v = u32(b, i);
  return v > 2147483647 ? v - 4294967296 : v;
};
const i8 = (b: Uint8Array, i: number) => {
  const v = b[i];
  return v > 127 ? v - 256 : v;
};

export interface Flags {
  buffered: boolean;
  low_battery: boolean;
  sensor_degraded: boolean;
  threshold_alert: boolean;
  rate_alert: boolean;
  commissioned: boolean;
  config_ack: boolean;
}

function decodeFlags(f: number): Flags {
  return {
    buffered: !!(f & 0x01),
    low_battery: !!(f & 0x02),
    sensor_degraded: !!(f & 0x04),
    threshold_alert: !!(f & 0x08),
    rate_alert: !!(f & 0x10),
    commissioned: !!(f & 0x20),
    config_ack: !!(f & 0x40),
  };
}

const STATES = ["BASELINE", "WATCH", "EVENT", "STANDING", "RECOVERY"];
const TIERS = ["FULL", "ECO", "LOW", "CRITICAL", "SURVIVAL"];
const RESET_REASONS: Record<number, string> = {
  1: "POWERON", 3: "SW", 4: "PANIC", 5: "INT_WDT", 6: "TASK_WDT",
  7: "WDT", 8: "DEEPSLEEP", 9: "BROWNOUT", 10: "SDIO",
};

export interface Decoded {
  type: string;
  seq: number;
  fw_version: number;
  flags: Flags;
  distance_mm?: number | null;
  distances_mm?: (number | null)[];
  pressure_pa?: number;
  temp_c?: number;
  vbat_v?: number;
  boot_count?: number;
  reset_reason?: string;
  state?: string;
  power_tier?: string;
  n_samples?: number;
  sample_interval_s?: number;
  valid_pings?: number;
  spread_mm?: number;
  lat?: number;
  lon?: number;
  tilt_deg?: number;
  baseline_mm?: number;
  link_margin_db?: number;
  gateway_count?: number;
}

export interface DecodeResult {
  data?: Decoded;
  warnings?: string[];
  errors?: string[];
  fuota?: boolean;
}

export function decodePayload(b: Uint8Array, port: number | null): DecodeResult {
  if (!b || !b.length) return { errors: ["empty payload"] };

  // ---- fPort 1: single reading, 16 bytes ----
  if (port === 1) {
    if (b.length !== 16) return { errors: [`fPort 1 expects 16 bytes, got ${b.length}`] };
    const dist = i16(b, 4);
    return {
      data: {
        type: "reading",
        seq: u16(b, 0),
        fw_version: u8(b, 2),
        flags: decodeFlags(u8(b, 3)),
        distance_mm: dist === NO_READING ? null : dist,
        pressure_pa: u32(b, 6),
        temp_c: i16(b, 10) / 10.0,
        vbat_v: u16(b, 12) / 1000.0,
        boot_count: u8(b, 14),
        reset_reason: RESET_REASONS[u8(b, 15)] ?? `code ${u8(b, 15)}`,
      },
      warnings: dist === NO_READING ? ["no echo returned - not the same as 'dry'"] : [],
    };
  }

  // ---- fPort 2: packed burst. 10 + (n-1) + 10 bytes ----
  if (port === 2) {
    if (b.length < 20) return { errors: [`fPort 2 too short: ${b.length}`] };
    const n = u8(b, 6);
    if (n < 1 || n > 10) return { errors: [`bad sample count ${n}`] };
    const expect = 10 + (n - 1) + 10;
    if (b.length !== expect) {
      return { errors: [`fPort 2 expected ${expect} bytes for n=${n}, got ${b.length}`] };
    }

    // First sample is absolute, the rest are int8 deltas off the running value.
    const first = i16(b, 8);
    const samples: (number | null)[] = [first === NO_READING ? null : first];
    let run = first;
    for (let k = 0; k < n - 1; k++) {
      if (run === NO_READING) { samples.push(null); continue; }
      run = run + i8(b, 10 + k);
      samples.push(run);
    }

    const p = 10 + (n - 1);
    const data: Decoded = {
      type: "burst",
      seq: u16(b, 0),
      fw_version: u8(b, 2),
      flags: decodeFlags(u8(b, 3)),
      state: STATES[u8(b, 4)] ?? `state ${u8(b, 4)}`,
      power_tier: TIERS[u8(b, 5)] ?? `tier ${u8(b, 5)}`,
      n_samples: n,
      sample_interval_s: u8(b, 7) * 10,
      distances_mm: samples,
      distance_mm: samples[samples.length - 1],
      pressure_pa: u32(b, p),
      temp_c: i16(b, p + 4) / 10.0,
      vbat_v: u16(b, p + 6) / 1000.0,
      valid_pings: u8(b, p + 8),
      spread_mm: u8(b, p + 9),
    };

    const warnings: string[] = [];
    if ((data.valid_pings ?? 0) < PING_WARN_BELOW) {
      warnings.push(`only ${data.valid_pings}/${PING_COUNT} pings returned`);
    }
    if ((data.spread_mm ?? 0) > 80) {
      warnings.push(`wide spread (${data.spread_mm}mm) - choppy water`);
    }
    return { data, warnings };
  }

  // ---- fPort 3: commissioning report, 20 bytes ----
  if (port === 3) {
    if (b.length !== 20) return { errors: [`fPort 3 expects 20 bytes, got ${b.length}`] };
    const data: Decoded = {
      type: "commissioning",
      seq: u16(b, 0),
      fw_version: u8(b, 2),
      flags: decodeFlags(u8(b, 3)),
      lat: i32(b, 4) / 1e7,
      lon: i32(b, 8) / 1e7,
      tilt_deg: i16(b, 12) / 100.0,
      baseline_mm: i16(b, 14),
      link_margin_db: u8(b, 16),
      gateway_count: u8(b, 17),
      vbat_v: u16(b, 18) / 1000.0,
    };
    const warnings: string[] = [];
    if ((data.link_margin_db ?? 0) < 10) {
      warnings.push("link margin below 10 dB - consider relocating");
    }
    if ((data.gateway_count ?? 0) < 2) {
      warnings.push(`only ${data.gateway_count} gateway hearing this node`);
    }
    return { data, warnings };
  }

  // FUOTA control and fragments. Real traffic, but not database rows.
  if (port === 20 || port === 21) return { fuota: true };

  return { errors: [`unknown fPort ${port}`] };
}

// ---------------------------------------------------------------------------
// Envelope normalisation: TTN v3, ChirpStack v4, ChirpStack v3 / WisGateOS.
// ---------------------------------------------------------------------------
export interface Normalised {
  source: string;
  device_id: string;
  dev_eui: string | null;
  f_port: number | null;
  f_cnt: number | null;
  raw_b64: string | null;
  predecoded: Record<string, unknown> | null;
  rssi: number | null;
  snr: number | null;
  gateway: string | null;
  sf: number | null;
  received: string | null;
}

// EUIs arrive hex or base64 depending on the server build.
export function toHexEui(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return String(v);
  if (/^[0-9a-fA-F]+$/.test(v)) return v.toLowerCase();
  try {
    return Buffer.from(v, "base64").toString("hex");
  } catch {
    return v;
  }
}

// US915 uplink data rates. DR4 is 500 kHz, the rest 125 kHz.
export function drToSf(dr: unknown): number | null {
  const map: Record<number, number> = { 0: 10, 1: 9, 2: 8, 3: 7, 4: 8 };
  return typeof dr === "number" && map[dr] !== undefined ? map[dr] : null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function normalise(body: any): Normalised | null {
  // ---- The Things Network v3 ----
  if (body?.uplink_message) {
    const up = body.uplink_message;
    const meta = (up.rx_metadata && up.rx_metadata[0]) || {};
    return {
      source: "ttn",
      device_id: body.end_device_ids?.device_id ?? "unknown",
      dev_eui: body.end_device_ids?.dev_eui ?? null,
      f_port: up.f_port ?? null,
      f_cnt: up.f_cnt ?? null,
      raw_b64: up.frm_payload ?? null,
      predecoded: up.decoded_payload ?? null,
      rssi: meta.rssi ?? null,
      snr: meta.snr ?? null,
      gateway: meta.gateway_ids?.gateway_id ?? null,
      sf: up.settings?.data_rate?.lora?.spreading_factor ?? null,
      received: up.received_at ?? body.received_at ?? null,
    };
  }

  // ---- ChirpStack v4 ----
  if (body?.deviceInfo) {
    const meta = (body.rxInfo && body.rxInfo[0]) || {};
    return {
      source: "chirpstack",
      device_id: body.deviceInfo.deviceName ?? "unknown",
      dev_eui: body.deviceInfo.devEui ?? null,
      f_port: body.fPort ?? null,
      f_cnt: body.fCnt ?? null,
      raw_b64: body.data ?? null,
      predecoded: body.object ?? null,
      rssi: meta.rssi ?? null,
      snr: meta.snr ?? null,
      gateway: meta.gatewayId ?? null,
      sf: body.txInfo?.modulation?.lora?.spreadingFactor ?? null,
      received: body.time ?? null,
    };
  }

  // ---- ChirpStack v3 / RAK WisGateOS built-in server ----
  // Flat shape, no deviceInfo wrapper, and SNR is spelled loRaSNR.
  if (body?.devEUI || body?.devEui) {
    const meta = (body.rxInfo && body.rxInfo[0]) || {};
    return {
      source: "wisgate",
      device_id: body.deviceName ?? "unknown",
      dev_eui: toHexEui(body.devEUI ?? body.devEui),
      f_port: body.fPort ?? null,
      f_cnt: body.fCnt ?? null,
      raw_b64: body.data ?? null,
      predecoded: body.object ?? null,
      rssi: meta.rssi ?? null,
      snr: meta.loRaSNR ?? meta.snr ?? null,
      gateway: toHexEui(meta.gatewayID ?? meta.gatewayId),
      sf: drToSf(body.txInfo?.dr ?? body.txInfo?.dataRate),
      received: body.time ?? body.publishedAt ?? null,
    };
  }

  return null;
}
