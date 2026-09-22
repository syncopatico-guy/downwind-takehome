/**
 * GET /api/timeline -- the scrub track.
 *
 * Percentiles, not maxima. Decision 4i: the first version of this plotted
 * max(us_aqi) across every cell and sat flat at "Hazardous" every hour while
 * the regional median AQI was 39 -- technically true, practically a lie. The
 * worst cell is still returned, named as such.
 *
 * This is the server-backed path. Decision 4c intends to replace it with a
 * Parquet file queried client-side by DuckDB-WASM so scrubbing never touches
 * the network; building this first means that swap has something to fall back
 * to rather than being load-bearing on the last day.
 */

import { tq } from '@/lib/tools/sql';

export const maxDuration = 30;

export async function GET() {
  const started = Date.now();
  const rows = await tq<Record<string, unknown>>(
    `SELECT frame_time, fire_count, fire_count_confident, total_frp_mw,
            station_count, pm25_p50, pm25_p90, pm25_p99, pm25_worst_cell,
            pm25_model_p50, us_aqi_p50, us_aqi_p90, us_aqi_worst_cell,
            top_attribution_score, cells_with_attribution, cells, partial_cells
       FROM v_timeline_series
      ORDER BY frame_time`,
  );

  const num = (v: unknown) => (v == null ? null : Number(v));

  return Response.json(
    {
      frames: rows.map((r) => ({
        t: new Date(r.frame_time as string).toISOString(),
        fires: Number(r.fire_count ?? 0),
        fires_confident: Number(r.fire_count_confident ?? 0),
        frp: num(r.total_frp_mw),
        stations: Number(r.station_count ?? 0),
        pm25_p50: num(r.pm25_p50), pm25_p90: num(r.pm25_p90), pm25_p99: num(r.pm25_p99),
        pm25_worst_cell: num(r.pm25_worst_cell),
        pm25_model_p50: num(r.pm25_model_p50),
        aqi_p50: num(r.us_aqi_p50), aqi_p90: num(r.us_aqi_p90),
        aqi_worst_cell: num(r.us_aqi_worst_cell),
        attribution: num(r.top_attribution_score),
        cells_with_attribution: Number(r.cells_with_attribution ?? 0),
        cells: Number(r.cells ?? 0),
        partial_cells: Number(r.partial_cells ?? 0),
      })),
      elapsed_ms: Date.now() - started,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
