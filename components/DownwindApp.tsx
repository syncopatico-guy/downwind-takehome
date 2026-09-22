'use client';

/**
 * The single instrument.
 *
 * The brief asks for "a single interface for exploring questions in natural
 * language, following evidence to its source, and replaying change over time",
 * and Decision 6 read the word "single" as load-bearing. So the three parts
 * are wired to each other rather than sharing a page:
 *
 *   - scrubbing the timeline changes what the map shows AND what the agent
 *     knows when you next ask (`as_of`, Decision 5c)
 *   - an answer moves the map to what it is about (`map_focus`)
 *   - a citation opens the record it rests on, and the provider it came from
 */

import { useCallback, useEffect, useState } from 'react';
import MapView from './MapView';
import Timeline from './Timeline';
import Chat from './Chat';
import EvidenceDrawer from './EvidenceDrawer';
import FreshnessStrip from './FreshnessStrip';
import type { Answer, MapFocus, MapPayload, TimelineFrame } from '@/lib/ui/types';

export default function DownwindApp() {
  const [frames, setFrames] = useState<TimelineFrame[]>([]);
  const [at, setAt] = useState<string>(new Date().toISOString());
  const [pinnedToNow, setPinnedToNow] = useState(true);
  const [mapData, setMapData] = useState<MapPayload | null>(null);
  const [focus, setFocus] = useState<MapFocus | null>(null);
  const [cited, setCited] = useState<string | null>(null);
  const [loadingMap, setLoadingMap] = useState(true);

  // The timeline is fetched once: 193 hourly frames is 58 KB, and refetching
  // it per scrub would be the network cost the whole design is avoiding.
  useEffect(() => {
    fetch('/api/timeline')
      .then((r) => r.json())
      .then((d: { frames: TimelineFrame[] }) => {
        setFrames(d.frames);
        if (d.frames.length > 0) setAt(d.frames[d.frames.length - 1].t);
      })
      .catch(() => { /* the map still works without the scrub track */ });
  }, []);

  // Map layers follow the moment. Debounced because dragging the handle emits
  // a position per frame, and 193 requests in a drag would be worse than slow.
  useEffect(() => {
    let cancelled = false;
    const id = setTimeout(() => {
      setLoadingMap(true);
      fetch(`/api/map?at=${encodeURIComponent(at)}`)
        .then((r) => r.json())
        .then((d: MapPayload) => { if (!cancelled) { setMapData(d); setLoadingMap(false); } })
        .catch(() => { if (!cancelled) setLoadingMap(false); });
    }, 180);
    return () => { cancelled = true; clearTimeout(id); };
  }, [at]);

  const onScrub = useCallback((iso: string) => {
    setAt(iso);
    setPinnedToNow(false);
  }, []);

  const onPinNow = useCallback(() => {
    setPinnedToNow(true);
    if (frames.length > 0) setAt(frames[frames.length - 1].t);
  }, [frames]);

  const onAnswer = useCallback((a: Answer) => {
    const f = a.claims?.map_focus;
    if (f) {
      setFocus(f);
      // An answer about a past moment moves the clock too, so the map and the
      // prose never describe different times.
      if (f.at) { setAt(f.at); setPinnedToNow(false); }
    }
  }, []);

  return (
    <div className="flex h-dvh flex-col bg-slate-950 text-slate-100">
      <div className="relative flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          <MapView
            data={mapData}
            focus={focus}
            onSelect={(recordId) => setCited(recordId)}
          />

          <div className="pointer-events-none absolute inset-x-3 top-3 flex items-start justify-between gap-3">
            <FreshnessStrip />
            {mapData && (
              <div className="pointer-events-auto rounded border border-slate-800 bg-slate-950/85 px-2.5 py-1.5 text-[10px] text-slate-400 backdrop-blur">
                <span className="text-rose-400">{mapData.counts.fires}</span> fires ·{' '}
                <span className="text-emerald-400">{mapData.counts.stations}</span> stations ·{' '}
                <span className="text-amber-400">{mapData.counts.alerts}</span> alerts
                {loadingMap && <span className="ml-2 text-sky-400">updating…</span>}
              </div>
            )}
          </div>

          {cited && <EvidenceDrawer recordId={cited} onClose={() => setCited(null)} />}
        </div>

        <aside className="hidden w-[400px] shrink-0 border-l border-slate-800 lg:block">
          <Chat at={at} pinnedToNow={pinnedToNow} onAnswer={onAnswer} onCite={setCited} />
        </aside>
      </div>

      <Timeline
        frames={frames}
        at={at}
        pinnedToNow={pinnedToNow}
        onScrub={onScrub}
        onPinNow={onPinNow}
      />
    </div>
  );
}
