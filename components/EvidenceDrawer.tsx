'use client';

/**
 * The evidence drawer: claim -> record -> upstream API.
 *
 * This is the concrete form of "following evidence to its source". Clicking a
 * citation resolves the record id against the database and shows the stored
 * row, with a link out to the provider it was read from. Nothing in the chain
 * is taken on trust: the id came from a tool result, the row is what we
 * actually stored, and the link is where it came from.
 */

import { useEffect, useState } from 'react';

interface RecordResponse {
  record_id: string;
  entity: string;
  record: Record<string, unknown>;
  upstream_url?: string | null;
  note?: string;
  error?: string;
}

/** Fields that explain themselves badly in a raw dump. */
const HIDE = new Set(['value_hash', 'geom', 'geom_simple', 'hull', 'bbox', 'centroid']);

function renderValue(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (Array.isArray(v)) return v.length ? v.join(', ') : '—';
  if (typeof v === 'object') return JSON.stringify(v);
  const s = String(v);
  // ISO timestamps read better as human time in a panel about provenance.
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return new Date(s).toUTCString().replace(' GMT', ' UTC');
  return s;
}

export default function EvidenceDrawer({ recordId, onClose }: { recordId: string; onClose: () => void }) {
  const [data, setData] = useState<RecordResponse | null>(null);

  // Derived rather than a second state. Setting `loading` synchronously inside
  // the effect triggers a cascading render, and the answer is already here:
  // we are loading exactly when the data we hold is not for the record asked
  // for. One source of truth, no extra render.
  const loading = data?.record_id !== recordId;

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/record/${encodeURIComponent(recordId)}`)
      .then((r) => r.json())
      .then((d: RecordResponse) => { if (!cancelled) setData({ ...d, record_id: recordId }); })
      .catch(() => {
        if (!cancelled) {
          setData({ record_id: recordId, entity: '', record: {}, error: 'Could not load this record.' });
        }
      });
    return () => { cancelled = true; };
  }, [recordId]);

  return (
    <div className="absolute inset-y-0 right-0 z-20 flex w-[380px] max-w-full flex-col border-l border-slate-800 bg-slate-950 shadow-2xl">
      <div className="flex items-start justify-between gap-2 border-b border-slate-800 px-4 py-3">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-wide text-slate-500">Evidence</p>
          <p className="truncate font-mono text-xs text-sky-300">{recordId}</p>
        </div>
        <button onClick={onClose} className="shrink-0 rounded px-2 py-1 text-xs text-slate-400 hover:bg-slate-800">
          close
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {loading && <p className="text-xs text-slate-500">Loading…</p>}

        {data?.error && <p className="text-xs text-rose-300">{data.error}</p>}

        {data?.note && (
          <p className="mb-3 rounded border border-slate-800 bg-slate-900/60 px-2.5 py-2 text-[11px] leading-relaxed text-slate-400">
            {data.note}
          </p>
        )}

        {data && !data.error && (
          <dl className="space-y-1.5">
            {Object.entries(data.record)
              .filter(([k, v]) => !HIDE.has(k) && v !== null)
              .map(([k, v]) => (
                <div key={k} className="grid grid-cols-[minmax(0,9rem)_1fr] gap-2 text-[11px]">
                  <dt className="truncate font-mono text-slate-500">{k}</dt>
                  <dd className="break-words text-slate-300">{renderValue(v)}</dd>
                </div>
              ))}
          </dl>
        )}
      </div>

      {data?.upstream_url && (
        <div className="border-t border-slate-800 px-4 py-3">
          <a href={data.upstream_url} target="_blank" rel="noreferrer"
             className="text-[11px] text-sky-400 hover:text-sky-300">
            View at the source ↗
          </a>
          <p className="mt-1 text-[10px] leading-relaxed text-slate-600">
            This row was read from that provider and stored with the run that fetched it.
          </p>
        </div>
      )}
    </div>
  );
}
