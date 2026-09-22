'use client';

/**
 * The conversation. Docked rather than dominant (Decision 6a): the map is the
 * subject, this is how you interrogate it.
 *
 * What streams here is the WORK, not the answer. Decision 5e accepted that the
 * final answer cannot stream as progressive prose because complete JSON is
 * needed to parse it -- so the wait is filled with which tool is running and
 * what it returned. "Watch it check 47 stations, then the answer lands" is
 * both more honest about where the latency is and, arguably, more trustworthy
 * than text typing itself out.
 */

import { useCallback, useRef, useState } from 'react';
import type { Answer, Claim } from '@/lib/ui/types';

const EXAMPLES = [
  'Which fires are responsible for the smoke around Yosemite?',
  'Where is the air worst right now?',
  "What's the air quality in Portland?",
  // Deliberately included: a reviewer should see the system decline as well as
  // succeed, because an honest refusal is the behaviour Decision 5a chose.
  'How many people were hospitalised for asthma in Sacramento?',
];

const CONFIDENCE: Record<Claim['confidence'], string> = {
  high: 'bg-emerald-500/15 text-emerald-300',
  medium: 'bg-amber-500/15 text-amber-300',
  low: 'bg-rose-500/15 text-rose-300',
};

interface Props {
  at: string;
  pinnedToNow: boolean;
  onAnswer: (a: Answer) => void;
  onCite: (recordId: string) => void;
  /**
   * Dismisses the panel where it is an overlay. Only rendered below `lg`: at
   * wider widths the panel is docked permanently and the button that opens it
   * is itself `lg:hidden`, so a close control there would strand the user with
   * no way back.
   */
  onClose?: () => void;
}

interface Progress { tool: string; detail?: string; done: boolean }

export default function Chat({ at, pinnedToNow, onAnswer, onCite, onClose }: Props) {
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress[]>([]);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const send = useCallback(async (q: string) => {
    if (!q.trim() || busy) return;
    setBusy(true); setProgress([]); setAnswer(null); setError(null);
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;

    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // The scrub position travels with the question. This is the coupling
        // Decision 5c is for: the agent answers as the world was at the moment
        // you are looking at, not as it is now.
        body: JSON.stringify({ question: q, as_of: pinnedToNow ? undefined : at }),
        signal: ctrl.signal,
      });

      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({ error: 'The request failed.' }));
        setError(body.error ?? 'The request failed.');
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE frames are separated by a blank line; anything after the last
        // one is a partial frame and stays in the buffer.
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const event = /^event: (.+)$/m.exec(frame)?.[1];
          const raw = /^data: (.+)$/m.exec(frame)?.[1];
          if (!event || !raw) continue;
          const data = JSON.parse(raw);
          if (event === 'progress') {
            setProgress((prev) => {
              if (data.phase === 'start') return [...prev, { tool: data.tool, done: false }];
              const next = [...prev];
              for (let i = next.length - 1; i >= 0; i--) {
                if (next[i].tool === data.tool && !next[i].done) {
                  next[i] = { ...next[i], done: true, detail: data.detail };
                  break;
                }
              }
              return next;
            });
          } else if (event === 'result') {
            setAnswer(data as Answer);
            onAnswer(data as Answer);
          } else if (event === 'error') {
            setError(data.error);
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  }, [at, pinnedToNow, busy, onAnswer]);

  return (
    <div className="flex h-full flex-col bg-slate-950/95">
      <div className="flex items-start gap-2 border-b border-slate-800 px-4 py-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-semibold tracking-tight text-slate-100">Downwind</h1>
          <p className="mt-0.5 text-[11px] leading-snug text-slate-500">
            Where wildfire smoke is degrading air quality, which fires are responsible,
            and where it is heading — from five live feeds.
          </p>
        </div>
        {/*
          As an overlay this panel is full-width on a phone, so it completely
          covers the backdrop that used to be the only way out -- measured at
          375px, zero pixels of it were reachable. A visible control is the
          only thing that works at a width where the panel IS the screen.

          `-mr-2 -mt-1` pulls the 44px hit area back into the padding so the
          target is full size without the glyph drifting away from the corner.
        */}
        {onClose && (
          <button
            onClick={onClose}
            aria-label="Close chat and return to the map"
            className="-mr-2 -mt-1 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded text-slate-500 hover:bg-slate-800 hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 lg:hidden"
          >
            <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden="true">
              <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.8"
                    strokeLinecap="round" fill="none" />
            </svg>
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {!answer && !busy && !error && (
          <div className="space-y-2">
            <p className="text-[11px] uppercase tracking-wide text-slate-500">Try</p>
            {EXAMPLES.map((e) => (
              <button key={e} onClick={() => { setQuestion(e); void send(e); }}
                className="block w-full rounded border border-slate-800 bg-slate-900/60 px-3 py-2 text-left text-xs text-slate-300 hover:border-slate-700 hover:bg-slate-900">
                {e}
              </button>
            ))}
          </div>
        )}

        {progress.length > 0 && (
          <div className="mb-3 space-y-1 font-mono text-[11px]">
            {progress.map((p, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className={p.done ? 'text-emerald-400' : 'text-sky-400'}>{p.done ? '✓' : '·'}</span>
                <span className="text-slate-400">{p.tool}</span>
                <span className="text-slate-600">{p.detail ?? (p.done ? '' : 'running…')}</span>
              </div>
            ))}
          </div>
        )}

        {error && (
          <div className="rounded border border-rose-900/60 bg-rose-950/40 px-3 py-2 text-xs text-rose-200">
            {error}
          </div>
        )}

        {answer?.claims && (
          <div className="space-y-3">
            <p className="text-sm leading-relaxed text-slate-100">{answer.claims.answer}</p>

            <div className="space-y-2">
              {answer.claims.claims.map((c, i) => (
                <div key={i} className="rounded border border-slate-800 bg-slate-900/40 px-3 py-2">
                  <div className="flex items-start gap-2">
                    <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase ${CONFIDENCE[c.confidence]}`}>
                      {c.confidence}
                    </span>
                    <p className="text-xs leading-relaxed text-slate-300">{c.statement}</p>
                  </div>
                  {c.citations.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {c.citations.map((id) => (
                        <button key={id} onClick={() => onCite(id)}
                          className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-sky-300 hover:bg-slate-700">
                          {id}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Shown rather than hidden: what it cost, how hard it thought, and
                whether every citation checked out. */}
            <div className="border-t border-slate-800 pt-2 text-[10px] leading-relaxed text-slate-500">
              {answer.validation?.ok
                ? <span className="text-emerald-500">all {answer.validation.cited_count} citations verified against tool results</span>
                : <span className="text-amber-400">
                    {answer.validation?.problems.length ?? 0} citation problem(s) after {answer.compose_attempts} attempt(s)
                  </span>}
              {' · '}{answer.calls.length} tool call(s) · effort {answer.effort} ({answer.effort_reason})
              {' · '}{(answer.elapsed_ms / 1000).toFixed(1)}s · ${answer.usage.estimated_cost_usd.toFixed(3)}
            </div>
          </div>
        )}
      </div>

      <form
        onSubmit={(e) => { e.preventDefault(); void send(question); }}
        className="border-t border-slate-800 p-3"
      >
        <div className="flex gap-2">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={pinnedToNow ? 'Ask about the air, fires or smoke…' : 'Ask — answered as of the scrub position'}
            className="min-w-0 flex-1 rounded border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-100 placeholder:text-slate-600 focus:border-sky-700 focus:outline-none"
          />
          <button type="submit" disabled={busy || !question.trim()}
            className="rounded bg-sky-700 px-3 py-2 text-xs font-medium text-white disabled:bg-slate-800 disabled:text-slate-600">
            {busy ? '…' : 'Ask'}
          </button>
        </div>
        {!pinnedToNow && (
          <p className="mt-1.5 text-[10px] text-amber-400/80">
            Answering as of {new Date(at).toUTCString().replace(' GMT', ' UTC')}
          </p>
        )}
      </form>
    </div>
  );
}
