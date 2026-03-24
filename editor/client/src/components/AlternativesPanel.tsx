import type { AlternativeCandidate } from '../hooks/useAlternatives';

interface AlternativesPanelProps {
  clipId: string | null;
  alternatives: AlternativeCandidate[];
  loading: boolean;
  onSwap: (candidate: AlternativeCandidate) => void;
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
  if (confidence >= 0.85) {
    bg = '#16a34a';
  } else if (confidence >= 0.65) {
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

export default function AlternativesPanel({
  clipId,
  alternatives,
  loading,
  onSwap,
}: AlternativesPanelProps) {
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
              {/* Thumbnail */}
              <div className="shrink-0">
                <div
                  className="overflow-hidden rounded border border-white/[0.08] bg-black"
                  style={{ width: 120, height: 68 }}
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
                </div>
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

                <button
                  type="button"
                  className="mt-2 rounded border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-0.5 font-mono text-[9px] font-semibold uppercase text-cyan-400 transition hover:bg-cyan-500/20"
                  onClick={() => onSwap(candidate)}
                >
                  Swap
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
