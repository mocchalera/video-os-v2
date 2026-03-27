import type { AlternativeCandidate } from '../hooks/useAlternatives';
import { CONFIDENCE_HIGH, CONFIDENCE_MEDIUM } from '../types';

interface AlternativesPanelProps {
  clipId: string | null;
  alternatives: AlternativeCandidate[];
  loading: boolean;
  onSwap: (candidate: AlternativeCandidate) => void;
  onPreview?: (candidate: AlternativeCandidate) => void;
  /** Enable staged replace flow: double-click shows diff summary before swap */
  enableStagedReplace?: boolean;
  /** Current clip data for diff summary in staged replace modal */
  currentClip?: import('../types').Clip | null;
}

const RANK_LABELS: Record<string, string> = {
  candidate_ref_match: 'Ref Match',
  fallback_segment: 'Fallback',
  eligible_beat_match: 'Beat Match',
  same_role: 'Same Role',
  fallback: 'Ranked',
};

function confidenceBadge(confidence: number) {
  const pct = (confidence * 100).toFixed(0);
  let bg: string;
  if (confidence >= CONFIDENCE_HIGH) {
    bg = '#16a34a';
  } else if (confidence >= CONFIDENCE_MEDIUM) {
    bg = '#ca8a04';
  } else {
    bg = '#dc2626';
  }
  return (
    <span
      className="inline-flex items-center rounded-sm px-1.5 py-0.5 text-[9px] font-bold"
      style={{ background: bg, color: '#fff' }}
    >
      {pct}%
    </span>
  );
}

import { useState } from 'react';

export default function AlternativesPanel({
  clipId,
  alternatives,
  loading,
  onSwap,
  onPreview,
  enableStagedReplace = false,
  currentClip,
}: AlternativesPanelProps) {
  const [stagedCandidate, setStagedCandidate] = useState<AlternativeCandidate | null>(null);
  if (!clipId) {
    return (
      <div className="flex h-full items-center justify-center px-5 py-8">
        <div className="text-center">
          <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-[color:var(--text-subtle)]">
            Alternatives
          </div>
          <p className="mt-2 text-[12px] text-[color:var(--text-muted)]">
            Select a clip to see alternatives.
          </p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center px-5 py-8">
        <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-[color:var(--text-subtle)]">
          Loading alternatives...
        </div>
      </div>
    );
  }

  if (alternatives.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-5 py-8">
        <div className="text-center">
          <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-[color:var(--text-subtle)]">
            No Alternatives
          </div>
          <p className="mt-2 text-[12px] text-[color:var(--text-muted)]">
            No candidate alternatives found for this clip.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-white/[0.06] px-4 py-2">
        <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-[color:var(--text-subtle)]">
          Alternatives ({alternatives.length})
        </div>
      </div>

      <div className="editor-scrollbar min-h-0 flex-1 overflow-y-auto">
        {alternatives.map((candidate) => (
          <div
            key={candidate.segment_id}
            className="border-b border-white/[0.04] px-4 py-3"
          >
            <div className="flex gap-3">
              {/* Thumbnail (click to preview in Source Monitor) */}
              <div className="shrink-0">
                <button
                  type="button"
                  className="overflow-hidden rounded border border-white/[0.08] bg-black transition hover:border-[var(--accent)]/40"
                  style={{ width: 120, height: 68 }}
                  onClick={() => onPreview?.(candidate)}
                  title="Preview in Source Monitor"
                >
                  <img
                    src={candidate.thumbnail_url}
                    alt={candidate.segment_id}
                    className="h-full w-full object-cover"
                    loading="lazy"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none';
                    }}
                  />
                </button>
              </div>

              {/* Metadata */}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[10px] text-neutral-200">
                    {candidate.segment_id}
                  </span>
                  {confidenceBadge(candidate.confidence)}
                  <span className="rounded-sm border border-white/[0.12] px-1 py-px font-mono text-[8px] uppercase text-[color:var(--text-subtle)]">
                    {RANK_LABELS[candidate.rank_reason] ?? candidate.rank_reason}
                  </span>
                </div>

                <div className="mt-1 font-mono text-[9px] uppercase text-[color:var(--text-subtle)]">
                  {candidate.role} · {candidate.asset_id}
                </div>

                {candidate.why_it_matches ? (
                  <div className="mt-1 text-[11px] leading-snug text-neutral-300">
                    {candidate.why_it_matches}
                  </div>
                ) : null}

                {candidate.risks && candidate.risks.length > 0 ? (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {candidate.risks.map((risk) => (
                      <span
                        key={risk}
                        className="rounded-sm border border-amber-500/20 bg-amber-500/5 px-1 py-px text-[9px] text-amber-300"
                      >
                        {risk}
                      </span>
                    ))}
                  </div>
                ) : null}

                {candidate.quality_flags && candidate.quality_flags.length > 0 ? (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {candidate.quality_flags.map((flag) => (
                      <span
                        key={flag}
                        className="rounded-sm border border-white/[0.08] px-1 py-px font-mono text-[8px] text-[color:var(--text-subtle)]"
                      >
                        {flag}
                      </span>
                    ))}
                  </div>
                ) : null}

                <div className="mt-2 flex items-center gap-2">
                  {onPreview && (
                    <button
                      type="button"
                      className="rounded border border-white/[0.12] bg-white/[0.04] px-2.5 py-0.5 font-mono text-[9px] font-semibold uppercase text-neutral-300 transition hover:bg-white/[0.08]"
                      onClick={() => onPreview(candidate)}
                    >
                      Preview
                    </button>
                  )}
                  {enableStagedReplace ? (
                    <button
                      type="button"
                      className="rounded border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-0.5 font-mono text-[9px] font-semibold uppercase text-cyan-400 transition hover:bg-cyan-500/20"
                      onClick={() => setStagedCandidate(candidate)}
                    >
                      Stage
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="rounded border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-0.5 font-mono text-[9px] font-semibold uppercase text-cyan-400 transition hover:bg-cyan-500/20"
                      onClick={() => onSwap(candidate)}
                    >
                      Swap
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Staged replace confirmation dialog */}
      {stagedCandidate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setStagedCandidate(null)}>
          <div
            className="w-full max-w-sm rounded-lg border border-white/[0.08] bg-[#1a1a1a] p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-[color:var(--text-subtle)]">
              Confirm Replace
            </div>
            <div className="mt-3 space-y-2 text-[12px]">
              {/* Diff summary: fields that will change */}
              {currentClip && (
                <div className="rounded border border-white/[0.08] bg-white/[0.02] px-3 py-2">
                  <div className="mb-1.5 font-mono text-[9px] uppercase tracking-[0.15em] text-[color:var(--text-subtle)]">
                    Changes
                  </div>
                  <div className="space-y-1 font-mono text-[10px]">
                    {currentClip.segment_id !== stagedCandidate.segment_id && (
                      <div className="flex justify-between">
                        <span className="text-[color:var(--text-muted)]">segment</span>
                        <span><span className="text-red-400 line-through">{currentClip.segment_id}</span> → <span className="text-green-400">{stagedCandidate.segment_id}</span></span>
                      </div>
                    )}
                    {currentClip.asset_id !== stagedCandidate.asset_id && (
                      <div className="flex justify-between">
                        <span className="text-[color:var(--text-muted)]">asset</span>
                        <span><span className="text-red-400 line-through">{currentClip.asset_id}</span> → <span className="text-green-400">{stagedCandidate.asset_id}</span></span>
                      </div>
                    )}
                    {currentClip.src_in_us !== stagedCandidate.src_in_us && (
                      <div className="flex justify-between">
                        <span className="text-[color:var(--text-muted)]">src_in</span>
                        <span><span className="text-red-400">{(currentClip.src_in_us / 1e6).toFixed(2)}s</span> → <span className="text-green-400">{(stagedCandidate.src_in_us / 1e6).toFixed(2)}s</span></span>
                      </div>
                    )}
                    {currentClip.src_out_us !== stagedCandidate.src_out_us && (
                      <div className="flex justify-between">
                        <span className="text-[color:var(--text-muted)]">src_out</span>
                        <span><span className="text-red-400">{(currentClip.src_out_us / 1e6).toFixed(2)}s</span> → <span className="text-green-400">{(stagedCandidate.src_out_us / 1e6).toFixed(2)}s</span></span>
                      </div>
                    )}
                    {currentClip.confidence !== stagedCandidate.confidence && (
                      <div className="flex justify-between">
                        <span className="text-[color:var(--text-muted)]">confidence</span>
                        <span><span className="text-red-400">{((currentClip.confidence ?? 0) * 100).toFixed(0)}%</span> → <span className="text-green-400">{(stagedCandidate.confidence * 100).toFixed(0)}%</span></span>
                      </div>
                    )}
                  </div>
                </div>
              )}
              <div className="flex justify-between gap-2">
                <span className="text-[color:var(--text-muted)]">Segment</span>
                <span className="font-mono text-neutral-100">{stagedCandidate.segment_id}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-[color:var(--text-muted)]">Confidence</span>
                <span>{confidenceBadge(stagedCandidate.confidence)}</span>
              </div>
              {stagedCandidate.why_it_matches && (
                <div className="mt-1 text-[11px] leading-snug text-neutral-300">
                  {stagedCandidate.why_it_matches}
                </div>
              )}
              {stagedCandidate.risks && stagedCandidate.risks.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {stagedCandidate.risks.map((risk) => (
                    <span key={risk} className="rounded-sm border border-amber-500/20 bg-amber-500/5 px-1 py-px text-[9px] text-amber-300">
                      {risk}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="rounded border border-white/[0.12] bg-white/[0.04] px-3 py-1.5 text-[11px] font-medium text-neutral-300 transition hover:bg-white/[0.08]"
                onClick={() => setStagedCandidate(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded border border-cyan-500/30 bg-cyan-500/10 px-3 py-1.5 text-[11px] font-semibold text-cyan-400 transition hover:bg-cyan-500/20"
                onClick={() => {
                  onSwap(stagedCandidate);
                  setStagedCandidate(null);
                }}
              >
                Apply Replace
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
