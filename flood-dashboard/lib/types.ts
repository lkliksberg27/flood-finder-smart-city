export interface Device {
  device_id: string;
  name: string | null;
  lat: number;
  lng: number;
  altitude_baro: number | null;
  mailbox_height_cm: number;
  baseline_distance_cm: number | null;
  status: 'online' | 'offline' | 'alert';
  battery_v: number | null;
  last_seen: string | null;
  installed_at: string | null;
  neighborhood: string | null;
  notes: string | null;
  // Set by derive_node_elevations() in the database. 'baro_relative' means
  // heights are measured up from the lowest monitored street, not surveyed.
  // Optional because demo data and older databases do not carry it.
  elevation_source?: 'survey' | 'baro' | 'baro_relative' | null;
}

export interface SensorReading {
  id: number;
  device_id: string;
  lat: number | null;
  lng: number | null;
  distance_cm: number | null;
  water_detected: boolean;
  flood_depth_cm: number;
  battery_v: number | null;
  recorded_at: string;
}

export interface FloodEvent {
  id: number;
  device_id: string;
  started_at: string;
  ended_at: string | null;
  peak_depth_cm: number;
  rainfall_mm: number | null;
  tide_level_m: number | null;
  duration_minutes: number | null;
  devices?: Device;
}

export interface Recommendation {
  id: number;
  generated_at: string;
  analysis_period_days: number;
  recommendation_text: string;
  affected_device_ids: string[];
  priority: 'high' | 'medium' | 'low';
  category: 'drainage' | 'elevation' | 'barrier' | 'other';
}
