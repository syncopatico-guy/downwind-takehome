'use client';

/**
 * The timeline. Permanently visible, because replaying change is a stated
 * requirement rather than a feature behind a button (Decision 6a).
 *
 * It plots PERCENTILES, with the worst cell as a separate faint line. The
 * first version of this view plotted the maximum across every cell and sat
 * flat at "Hazardous" every hour while the regional median AQI was 39
 * (Decision 4i) -- so the distinction is drawn on screen rather than only
 * fixed in the query.
 */

import { useCallback, useMemo, useRef } from 'react';
import type { TimelineFrame } from '@/lib/ui/types';

interface Props {
  frames: TimelineFrame[];
  at: string;
  pinnedToNow: boolean;
  onScrub: (iso: string) => void;
  onPinNow: () => void;
}

const H = 68;

export default function Timeline({ frames, at, pinnedToNow, onScrub, onPinNow }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  const { paths, index, span } = useMemo(() => {
    if (frames.length === 0) {
      return { paths: null, index: 0, span: null };
    }
    const t0 = new Date(frames[0].t).getTime();
    const t1 = new Date(frames[frames.length - 1].t).getTime();
    const x = (t: string) => ((new Date(t).getTime() - t0) / Math.max(t1 - t0, 1)) * 100;

    // Log scale: the worst cell reaches 985 µg/m³ while the median sits at 4-6.
    // Linear would render every percentile line as the same flat trace.
    const ymax = Math.max(...frames.map((f) => f.pm25_worst_cell ?? 0), 50);
    const y = (v: number | null) => {
      if (v == null) return null;
      const frac = Math.log10(Math.max(v, 0.5) + 1) / Math.log10(ymax + 1);
      return H - frac * (H - 6) - 3;
    };

    const line = (pick: (f: TimelineFrame) => number | null) => {
      let d = '';
      let open = false;
      for (const f of frames) {
        const yy = y(pick(f));
        // A break in the line where there is no observation: a gap is not a
        // value of zero, and the chart should not draw through it.
        if (yy == null) { open = false; continue; }
        d += `${open ? 'L' : 'M'}${x(f.t).toFixed(2)},${yy.toFixed(2)} `;
        open = true;
      }
      return d.trim();
    };

    const maxFires = Math.max(...frames.map((f) => f.fires), 1);
    const bars = frames.map((f) => ({
      x: x(f.t),
      h: (f.fires / maxFires) * 14,
      partial: f.partial_cells > 0,
    }));

    const cur = new Date(at).getTime();
    let best = 0;
    let bestDiff = Infinity;
    frames.forEach((f, i) => {
      const d = Math.abs(new Date(f.t).getTime() - cur);
      if (d < bestDiff) { bestDiff = d; best = i; }
    });

    return {
      paths: {
        p50: line((f) => f.pm25_p50),
        p90: line((f) => f.pm25_p90),
        p99: line((f) => f.pm25_p99),
        worst: line((f) => f.pm25_worst_cell),
        bars,
      },
      index: best,
      span: { t0, t1 },
    };
  }, [frames, at]);

  const scrubTo = useCallback((clientX: number) => {
    if (!ref.current || !span || frames.length === 0) return;
    const rect = ref.current.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const t = span.t0 + frac * (span.t1 - span.t0);
    // Snap to a real frame: offering positions with no data behind them would
    // be a slider that lies about its resolution.
    let nearest = frames[0];
    let diff = Infinity;
    for (const f of frames) {
      const d = Math.abs(new Date(f.t).getTime() - t);
      if (d < diff) { diff = d; nearest = f; }
    }
    onScrub(nearest.t);
  }, [frames, span, onScrub]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    scrubTo(e.clientX);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.buttons === 1) scrubTo(e.clientX);
  };

  /**
   * Keyboard scrubbing, by frame rather than by pixel.
   *
   * The pointer path snaps to the nearest real frame, so the keyboard path
   * moves between frames directly -- which makes arrow keys strictly more
   * precise than dragging, not a degraded substitute for it.
   */
  const stepBy = useCallback((delta: number) => {
    if (frames.length === 0) return;
    const next = Math.min(frames.length - 1, Math.max(0, index + delta));
    if (next !== index) onScrub(frames[next].t);
  }, [frames, index, onScrub]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (frames.length === 0) return;
    // A day either way, for a series that is hours long and days wide.
    const page = 24;
    const moves: Record<string, number> = {
      ArrowLeft: -1, ArrowRight: 1, ArrowDown: -1, ArrowUp: 1,
      PageDown: -page, PageUp: page,
    };
    if (e.key in moves) {
      e.preventDefault();
      stepBy(moves[e.key]);
      return;
    }
    if (e.key === 'Home') { e.preventDefault(); onScrub(frames[0].t); return; }
    if (e.key === 'End') { e.preventDefault(); onScrub(frames[frames.length - 1].t); }
  };

  const frame = frames[index];
  const pct = paths && span && frames.length > 0
    ? ((new Date(frames[index].t).getTime() - span.t0) / Math.max(span.t1 - span.t0, 1)) * 100
    : 0;

  return (
    <div className="border-t border-slate-800 bg-slate-950/90 px-4 py-2 select-none">
      {/*
        At 375px this row wrapped to four lines -- the full UTC date, the live
        badge, the partial count and five percentile readouts all competing --
        and spent roughly 130px of an 812px screen on chrome before the chart.
        The date goes short and the percentiles hide below `sm`; the fire count
        stays, because it is the one number the map cannot show at a glance.
      */}
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-[11px]">
        <div className="flex items-center gap-3">
          <span className="font-mono text-slate-200">
            {frame
              ? <>
                  <span className="sm:hidden">
                    {new Date(frame.t).toUTCString().slice(5, 22)} UTC
                  </span>
                  <span className="hidden sm:inline">
                    {new Date(frame.t).toUTCString().replace(' GMT', ' UTC')}
                  </span>
                </>
              : '—'}
          </span>
          {pinnedToNow
            ? <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-emerald-300">live</span>
            : <button
                onClick={onPinNow}
                // ~20px tall before this: the control that undoes scrubbing was
                // the hardest thing on the strip to hit. Full touch size on
                // small screens, compact again where there is a pointer.
                className="inline-flex min-h-[44px] items-center rounded bg-slate-800 px-3 text-slate-300 hover:bg-slate-700 sm:min-h-0 sm:px-1.5 sm:py-0.5"
              >
                back to now
              </button>}
          {frame && frame.partial_cells > 0 && (
            <span className="text-amber-400/80" title="Cells where a normally-present feed reported nothing this hour">
              {frame.partial_cells} partial
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 font-mono text-slate-400">
          {frame && (
            <>
              <span className="hidden sm:inline"><span className="text-slate-500">p50</span> {frame.pm25_p50 ?? '—'}</span>
              <span className="hidden sm:inline"><span className="text-slate-500">p90</span> {frame.pm25_p90 ?? '—'}</span>
              <span className="hidden sm:inline"><span className="text-slate-500">p99</span> {frame.pm25_p99 ?? '—'}</span>
              <span className="hidden text-slate-500 sm:inline" title="The single worst cell — not the regional condition">
                worst {frame.pm25_worst_cell ?? '—'}
              </span>
              {/* Kept at every width: the median is what the chart already
                  draws, but the fire count is not plotted as a number. */}
              <span className="whitespace-nowrap text-rose-400/80">{frame.fires} fires</span>
            </>
          )}
        </div>
      </div>

      {/*
        A slider, declared as one. It was a bare div with pointer handlers,
        which failed twice over: no tab stop and no key handling made replay --
        a stated requirement -- unreachable by keyboard entirely, and the
        default `touch-action` let the browser claim a horizontal drag for
        panning before pointermove ever fired, so the gesture was unreliable on
        exactly the devices that only have gestures.

        `touch-action: none` is what makes the drag ours on a touch screen.
      */}
      <div
        ref={ref}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onKeyDown={onKeyDown}
        tabIndex={0}
        role="slider"
        aria-label="Replay timeline — arrow keys move one hour, Page Up and Page Down move one day"
        aria-valuemin={0}
        aria-valuemax={Math.max(frames.length - 1, 0)}
        aria-valuenow={index}
        aria-valuetext={
          frame
            ? `${new Date(frame.t).toUTCString().replace(' GMT', ' UTC')} — ` +
              `median ${frame.pm25_p50 ?? 'no data'}, ${frame.fires} fires`
            : 'no data'
        }
        style={{ touchAction: 'none' }}
        className="relative h-[68px] cursor-ew-resize rounded bg-slate-900/60
                   focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400
                   focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
      >
        {paths && (
          <svg viewBox={`0 0 100 ${H}`} preserveAspectRatio="none" className="h-full w-full">
            {paths.bars.map((b, i) => (
              <rect key={i} x={b.x - 0.12} width={0.24} y={H - b.h} height={b.h}
                    fill={b.partial ? '#78350f' : '#7f1d1d'} opacity={0.75} />
            ))}
            <path d={paths.worst} fill="none" stroke="#7f1d1d" strokeWidth={0.4} opacity={0.55}
                  vectorEffect="non-scaling-stroke" />
            <path d={paths.p99} fill="none" stroke="#f97316" strokeWidth={0.6} opacity={0.75}
                  vectorEffect="non-scaling-stroke" />
            <path d={paths.p90} fill="none" stroke="#eab308" strokeWidth={0.8} opacity={0.85}
                  vectorEffect="non-scaling-stroke" />
            <path d={paths.p50} fill="none" stroke="#22c55e" strokeWidth={1.1}
                  vectorEffect="non-scaling-stroke" />
          </svg>
        )}
        <div className="pointer-events-none absolute inset-y-0 w-px bg-sky-400" style={{ left: `${pct}%` }}>
          <div className="absolute -top-0.5 -left-[3px] h-1.5 w-1.5 rounded-full bg-sky-400" />
        </div>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-slate-500">
        <span className="whitespace-nowrap text-emerald-500">— median</span>
        <span className="whitespace-nowrap text-yellow-500">— p90</span>
        <span className="whitespace-nowrap text-orange-500">— p99</span>
        <span className="whitespace-nowrap text-red-900">— worst cell</span>
        {/* The hint now names the keyboard path too: arrow keys are the more
            precise way to scrub, and nothing on screen would otherwise say so. */}
        <span className="ml-auto whitespace-nowrap sm:hidden">drag to replay</span>
        <span className="ml-auto hidden whitespace-nowrap sm:inline">
          drag or press ← → to replay · the agent answers as of this moment
        </span>
      </div>
    </div>
  );
}
