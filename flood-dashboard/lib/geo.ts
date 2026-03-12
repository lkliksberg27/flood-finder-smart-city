import type { Device } from './types';

/** Haversine distance in km between two lat/lng points */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Street elevation = sensor altitude minus distance to ground (baseline) */
export function streetElevation(d: Device): number {
  if (d.altitude_baro == null) return 0;
  return d.altitude_baro - (d.baseline_distance_cm ?? 0) / 100;
}

/** Format distance for display */
export function formatDistance(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)}m`;
  return `${km.toFixed(1)}km`;
}

// ─── Hydraulic gradient & flow network ───────────────────────────

/**
 * Hydraulic gradient (dimensionless slope) between two sensors.
 * Positive means water flows from a → b (a is higher).
 * Uses horizontal haversine distance as the run.
 */
export function hydraulicGradient(a: Device, b: Device): number {
  const elevA = streetElevation(a);
  const elevB = streetElevation(b);
  const distKm = haversineKm(a.lat, a.lng, b.lat, b.lng);
  const distM = distKm * 1000;
  if (distM < 1) return 0;
  return (elevA - elevB) / distM;
}

/** A directed edge in the sensor flow network */
export interface FlowEdge {
  from: string;        // device_id of upstream sensor (higher)
  to: string;          // device_id of downstream sensor (lower)
  gradient: number;    // slope magnitude (always positive)
  distKm: number;      // horizontal distance
  elevDrop: number;    // elevation difference in meters
}

/**
 * Build a sparse flow network using steepest-descent routing.
 *
 * For each sensor, find the neighboring sensor with the steepest
 * downhill gradient (analogous to D8 on a DEM but for irregular points).
 * Also includes secondary flow paths where gradient > 50% of the
 * steepest, capturing flow divergence on flat terrain (D-infinity style).
 *
 * maxNeighborDist: only consider neighbors within this distance (km).
 * For a dense urban network, 0.8km works well.
 */
export function buildFlowNetwork(
  devices: Device[],
  maxNeighborDist = 0.8,
): FlowEdge[] {
  const withElev = devices.filter((d) => d.altitude_baro != null);
  if (withElev.length < 2) return [];

  const edges: FlowEdge[] = [];
  const edgeSet = new Set<string>();

  for (const d of withElev) {
    const elev = streetElevation(d);
    // Find all downhill neighbors within range
    const downhill = withElev
      .filter((n) => n.device_id !== d.device_id)
      .map((n) => {
        const nElev = streetElevation(n);
        const distKm = haversineKm(d.lat, d.lng, n.lat, n.lng);
        const distM = distKm * 1000;
        const grad = distM > 1 ? (elev - nElev) / distM : 0;
        return { device: n, elev: nElev, distKm, grad, elevDrop: elev - nElev };
      })
      .filter((n) => n.grad > 0.0001 && n.distKm <= maxNeighborDist)
      .sort((a, b) => b.grad - a.grad);

    if (downhill.length === 0) continue;

    const steepest = downhill[0].grad;

    // Primary flow: steepest descent (D8)
    // Secondary flows: any path with gradient > 65% of steepest (D-infinity approx)
    for (const n of downhill) {
      if (n.grad < steepest * 0.65) break;
      const key = `${d.device_id}->${n.device.device_id}`;
      if (edgeSet.has(key)) continue;
      edgeSet.add(key);
      edges.push({
        from: d.device_id,
        to: n.device.device_id,
        gradient: n.grad,
        distKm: n.distKm,
        elevDrop: n.elevDrop,
      });
    }
  }

  return edges;
}

/**
 * Flow accumulation: count how many upstream sensors drain into each sensor.
 *
 * Uses the flow network to trace upstream. A sensor that sits at the
 * bottom of a hill where 5 other sensors drain into it gets accumulation=5.
 * This correlates strongly with flood risk — convergence zones pool water.
 */
export function computeFlowAccumulation(
  devices: Device[],
  edges: FlowEdge[],
): Record<string, number> {
  // Build adjacency: for each device, which devices drain INTO it
  const inbound: Record<string, string[]> = {};
  for (const d of devices) inbound[d.device_id] = [];
  for (const e of edges) {
    if (!inbound[e.to]) inbound[e.to] = [];
    inbound[e.to].push(e.from);
  }

  // Count unique upstream sensors (not flow paths) to avoid exponential counts
  function collectUpstream(id: string, visited: Set<string>): void {
    for (const upstream of (inbound[id] ?? [])) {
      if (!visited.has(upstream)) {
        visited.add(upstream);
        collectUpstream(upstream, visited);
      }
    }
  }

  const result: Record<string, number> = {};
  for (const d of devices) {
    const upstream = new Set<string>();
    collectUpstream(d.device_id, upstream);
    result[d.device_id] = upstream.size;
  }
  return result;
}

// ─── Road dip analysis ───────────────────────────────────────────

/** Analyze road dips — sensors sitting lower than their neighbors */
export interface DipInfo {
  device_id: string;
  name: string | null;
  neighborhood: string | null;
  elevation_m: number;
  avgNeighborElev: number;
  dipCm: number;
  floodCount: number;
  flowAccumulation: number;
  drainageRisk: 'critical' | 'high' | 'moderate' | 'low';
}

export function findRoadDips(devices: Device[], floodCounts: Record<string, number>): DipInfo[] {
  const withElev = devices.filter((d) => d.altitude_baro != null);
  if (withElev.length < 3) return [];

  const edges = buildFlowNetwork(devices);
  const accumulation = computeFlowAccumulation(devices, edges);

  return withElev.map((d) => {
    const elev = streetElevation(d);

    // Use distance-weighted neighbor elevation (closer neighbors matter more)
    const neighbors = withElev
      .filter((n) => n.device_id !== d.device_id)
      .map((n) => ({ ...n, elev: streetElevation(n), dist: haversineKm(d.lat, d.lng, n.lat, n.lng) }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 4);

    if (neighbors.length === 0) return null;

    // Inverse-distance weighted average: closer neighbors influence more
    const totalWeight = neighbors.reduce((s, n) => s + 1 / Math.max(n.dist, 0.01), 0);
    const weightedAvgElev = neighbors.reduce(
      (s, n) => s + (n.elev / Math.max(n.dist, 0.01)),
      0,
    ) / totalWeight;

    const diff = elev - weightedAvgElev;
    const dipCm = Math.round(-diff * 100);
    const accum = accumulation[d.device_id] ?? 0;
    const floods = floodCounts[d.device_id] ?? 0;

    // Drainage risk: combines dip depth, flow accumulation, and flood history
    const riskScore = dipCm * 0.4 + accum * 8 + floods * 3;
    const drainageRisk: DipInfo['drainageRisk'] =
      riskScore > 40 ? 'critical' :
      riskScore > 20 ? 'high' :
      riskScore > 10 ? 'moderate' : 'low';

    return {
      device_id: d.device_id,
      name: d.name,
      neighborhood: d.neighborhood,
      elevation_m: parseFloat(elev.toFixed(2)),
      avgNeighborElev: parseFloat(weightedAvgElev.toFixed(2)),
      dipCm,
      floodCount: floods,
      flowAccumulation: accum,
      drainageRisk,
    };
  })
    .filter((d): d is DipInfo => d != null && d.dipCm > 8) // 8cm threshold (more sensitive than before)
    .sort((a, b) => b.dipCm - a.dipCm);
}
