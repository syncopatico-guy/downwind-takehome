/** Shapes shared between the client components and the API routes. */

export interface FirePoint {
  cluster_key: string;
  record_id: string;
  label: string | null;
  source_character: string;
  lat: number;
  lon: number;
  total_frp_mw: number | null;
  frp_24h: number | null;
  detection_count: number;
  last_event_time: string;
}

export interface StationPoint {
  station_id: string;
  record_id: string;
  name: string | null;
  lat: number;
  lon: number;
  instrument_tier: string;
  pm25: number | null;
  event_time: string;
  age_hours: number;
}

export interface AlertShape {
  record_id: string;
  event_type: string;
  severity: string | null;
  headline: string | null;
  geometry: GeoJSON.Geometry;
}

export interface MapPayload {
  at: string;
  fires: FirePoint[];
  stations: StationPoint[];
  alerts: AlertShape[];
  counts: { fires: number; stations: number; alerts: number };
  elapsed_ms: number;
}

export interface TimelineFrame {
  t: string;
  fires: number;
  fires_confident: number;
  frp: number | null;
  stations: number;
  pm25_p50: number | null;
  pm25_p90: number | null;
  pm25_p99: number | null;
  pm25_worst_cell: number | null;
  pm25_model_p50: number | null;
  aqi_p50: number | null;
  aqi_p90: number | null;
  aqi_worst_cell: number | null;
  attribution: number | null;
  cells_with_attribution: number;
  cells: number;
  partial_cells: number;
}

export interface Claim {
  statement: string;
  citations: string[];
  confidence: 'high' | 'medium' | 'low';
}

export interface MapFocus {
  min_lat: number; max_lat: number; min_lon: number; max_lon: number;
  at: string | null;
  label: string | null;
}

export interface Answer {
  question: string;
  model: string;
  claims: { answer: string; claims: Claim[]; map_focus: MapFocus | null } | null;
  validation: { ok: boolean; cited_count: number; problems: { detail: string }[] } | null;
  evidence: string[];
  calls: { tool: string; row_count: number; elapsed_ms: number; error?: string }[];
  usage: { estimated_cost_usd: number; input_tokens: number; output_tokens: number };
  effort: string;
  effort_reason: string;
  compose_attempts: number;
  elapsed_ms: number;
  error?: string;
}

/**
 * The PM2.5 colour ramp follows US AQI breakpoints rather than a smooth
 * gradient, because the categories are what people actually act on -- "unhealthy
 * for sensitive groups" is a decision boundary, not a shade.
 */
export function pm25Colour(v: number | null): string {
  if (v == null) return '#4b5563';
  if (v <= 9) return '#22c55e';
  if (v <= 35.4) return '#eab308';
  if (v <= 55.4) return '#f97316';
  if (v <= 125.4) return '#ef4444';
  if (v <= 225.4) return '#a855f7';
  return '#7f1d1d';
}

export function pm25Label(v: number | null): string {
  if (v == null) return 'no reading';
  if (v <= 9) return 'good';
  if (v <= 35.4) return 'moderate';
  if (v <= 55.4) return 'unhealthy for sensitive groups';
  if (v <= 125.4) return 'unhealthy';
  if (v <= 225.4) return 'very unhealthy';
  return 'hazardous';
}
