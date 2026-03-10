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

/** Analyze road dips — sensors sitting lower than their neighbors */
export interface DipInfo {
  device_id: string;
  name: string | null;
  neighborhood: string | null;
  elevation_m: number;
  avgNeighborElev: number;
  dipCm: number;
  floodCount: number;
}

export function findRoadDips(devices: Device[], floodCounts: Record<string, number>): DipInfo[] {
  const withElev = devices.filter((d) => d.altitude_baro != null);
  if (withElev.length < 3) return [];

  return withElev.map((d) => {
    const elev = streetElevation(d);
    const neighbors = withElev
      .filter((n) => n.device_id !== d.device_id)
      .map((n) => ({ ...n, elev: streetElevation(n), dist: haversineKm(d.lat, d.lng, n.lat, n.lng) }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 3);

    if (neighbors.length === 0) return { device_id: d.device_id, name: d.name, neighborhood: d.neighborhood, elevation_m: elev, avgNeighborElev: 0, dipCm: 0, floodCount: 0 };
    const avgNeighborElev = neighbors.reduce((s, n) => s + n.elev, 0) / neighbors.length;
    const diff = elev - avgNeighborElev;

    return {
      device_id: d.device_id,
      name: d.name,
      neighborhood: d.neighborhood,
      elevation_m: parseFloat(elev.toFixed(2)),
      avgNeighborElev: parseFloat(avgNeighborElev.toFixed(2)),
      dipCm: Math.round(-diff * 100),
      floodCount: floodCounts[d.device_id] ?? 0,
    };
  })
    .filter((d) => d.dipCm > 10)
    .sort((a, b) => b.dipCm - a.dipCm);
}
