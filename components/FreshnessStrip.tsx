'use client';

/**
 * Per-feed freshness (Decision 6). Deliberately compact and secondary: it is
 * the honest state of the pipeline, not the headline.
 *
 * It will often show amber. GitHub delivers roughly 10% of the declared cron
 * cadence (4n), so feeds drift past their staleness thresholds between runs.
 * That is the health model working -- "stale" reported accurately is the
 * feature, and the four states are kept distinct because "never scheduled"
 * and "overdue" are different facts (4g).
 */

import { useEffect, useState } from 'react';

interface SourceHealth {
  source_id: string;
  display_name: string;
  freshness: string;
  freshness_meaning: string;
  seconds_since_ok: number | null;
}

const DOT: Record<string, string> = {
  fresh: 'bg-emerald-400',
  stale: 'bg-amber-400',
  one_off: 'bg-slate-500',
  not_scheduled: 'bg-slate-500',
  never_succeeded: 'bg-rose-500',
};

function age(seconds: number | null): string {
  if (seconds == null) return 'never';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

export default function FreshnessStrip() {
  const [sources, setSources] = useState<SourceHealth[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch('/api/tools/get_data_health', { method: 'POST', body: '{}' })
        .then((r) => r.json())
        .then((d) => { if (!cancelled) setSources(d.data ?? []); })
        .catch(() => { /* the strip is context; its absence is not an error */ });
    };
    load();
    const id = setInterval(load, 120_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  if (sources.length === 0) return null;

  return (
    <div className="pointer-events-auto flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-slate-800 bg-slate-950/85 px-2.5 py-1.5 text-[10px] backdrop-blur">
      {sources.map((s) => (
        <span key={s.source_id} className="flex items-center gap-1.5" title={`${s.display_name}: ${s.freshness_meaning}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${DOT[s.freshness] ?? 'bg-slate-600'}`} />
          <span className="text-slate-400">{s.source_id.replace(/_/g, ' ')}</span>
          <span className="font-mono text-slate-600">{age(s.seconds_since_ok)}</span>
        </span>
      ))}
    </div>
  );
}
