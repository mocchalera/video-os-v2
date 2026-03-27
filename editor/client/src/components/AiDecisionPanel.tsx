import type { Clip, ReviewReportResponse } from '../types';
import { CONFIDENCE_HIGH, CONFIDENCE_MEDIUM } from '../types';
import type { BlueprintResponse } from '../hooks/useReview';

interface AiDecisionPanelProps {
  clip: Clip | null;
  reviewReport: ReviewReportResponse | null;
  blueprint: BlueprintResponse | null;
  /** Render as a collapsible section inside NLE Inspector */
  collapsible?: boolean;
}

function confidenceBadge(confidence: number | undefined) {
  if (confidence == null) return null;
  const pct = (confidence * 100).toFixed(0);
  let bg: string;
  if (confidence >= CONFIDENCE_HIGH) bg = '#16a34a';
  else if (confidence >= CONFIDENCE_MEDIUM) bg = '#ca8a04';
  else bg = '#dc2626';
  return (
    <span
      className="inline-flex items-center rounded-sm px-1.5 py-0.5 text-[10px] font-bold"
      style={{ background: bg, color: '#fff' }}
    >
      {pct}%
    </span>
  );
}

function confidenceBar(confidence: number | undefined) {
  if (confidence == null) return null;
  const pct = Math.round(confidence * 100);
  let barColor: string;
  if (confidence >= CONFIDENCE_HIGH) barColor = '#16a34a';
  else if (confidence >= CONFIDENCE_MEDIUM) barColor = '#ca8a04';
  else barColor = '#dc2626';
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.08]">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${pct}%`, background: barColor }}
        />
      </div>
      <span className="font-mono text-[10px] text-neutral-300">{pct}%</span>
    </div>
  );
}

export default function AiDecisionPanel({
  clip,
  reviewReport,
  blueprint,
  collapsible = false,
}: AiDecisionPanelProps) {
  if (!clip) {
    if (collapsible) return null;
    return (
      <div className="flex h-full items-center justify-center px-5 py-8">
        <div className="text-center">
          <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-[color:var(--text-subtle)]">
            AI Decision
          </div>
          <p className="mt-2 text-[12px] text-[color:var(--text-muted)]">
            Select a clip to see AI rationale.
          </p>
        </div>
      </div>
    );
  }

  const clipWeaknesses =
    reviewReport?.data?.weaknesses?.filter((w) => w.clip_id === clip.clip_id) ?? [];
  const clipWarnings =
    reviewReport?.data?.warnings?.filter((w) => w.clip_id === clip.clip_id) ?? [];
  const beatInfo = clip.beat_id
    ? blueprint?.data?.beats?.find((b) => b.beat_id === clip.beat_id)
    : null;
  const hasLowConfidence = clip.confidence != null && clip.confidence < CONFIDENCE_MEDIUM;

  const content = (
    <div className="space-y-4">
      {/* Motivation */}
      <div>
        <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-[color:var(--text-subtle)]">
          Motivation
        </div>
        <div className="mt-1 text-[13px] leading-relaxed text-neutral-100">
          {clip.motivation}
        </div>
      </div>

      {/* Confidence */}
      <div>
        <div className="flex items-center justify-between">
          <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-[color:var(--text-subtle)]">
            Confidence
          </span>
          {confidenceBadge(clip.confidence)}
        </div>
        <div className="mt-1.5">{confidenceBar(clip.confidence)}</div>
      </div>

      {/* Quality Flags */}
      {clip.quality_flags && clip.quality_flags.length > 0 && (
        <div>
          <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-[color:var(--text-subtle)]">
            Quality Flags
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {clip.quality_flags.map((flag) => (
              <span
                key={flag}
                className="rounded-sm border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[9px] text-amber-300"
              >
                {flag}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Beat / Purpose */}
      {(clip.beat_id || beatInfo) && (
        <div>
          <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-[color:var(--text-subtle)]">
            Beat / Purpose
          </div>
          <div className="mt-1 space-y-1 text-[12px]">
            {clip.beat_id && (
              <div className="flex justify-between">
                <span className="text-[color:var(--text-muted)]">Beat</span>
                <span className="font-mono text-neutral-100">{clip.beat_id}</span>
              </div>
            )}
            {beatInfo?.purpose && (
              <div className="text-[12px] leading-relaxed text-neutral-200">
                {beatInfo.purpose}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Why Selected */}
      {clip.candidate_ref && (
        <div>
          <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-[color:var(--text-subtle)]">
            Source Candidate
          </div>
          <div className="mt-1 font-mono text-[11px] text-neutral-300">
            {clip.candidate_ref}
          </div>
        </div>
      )}

      {/* Fallback candidates */}
      {clip.fallback_candidate_refs && clip.fallback_candidate_refs.length > 0 && (
        <div>
          <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-[color:var(--text-subtle)]">
            Fallback Candidates
          </div>
          <div className="mt-1 space-y-0.5">
            {clip.fallback_candidate_refs.map((ref) => (
              <div key={ref} className="font-mono text-[10px] text-[color:var(--text-muted)]">
                {ref}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Review Weaknesses */}
      {clipWeaknesses.length > 0 && (
        <div>
          <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-[color:var(--text-subtle)]">
            Review Weaknesses
          </div>
          <div className="mt-1.5 space-y-1.5">
            {clipWeaknesses.map((w, i) => (
              <div
                key={i}
                className="rounded border border-red-500/20 bg-red-500/5 px-3 py-2 text-[11px]"
              >
                <span
                  className="rounded-sm px-1 py-px text-[8px] font-bold uppercase"
                  style={{
                    background:
                      w.severity === 'critical' ? '#dc2626' : w.severity === 'major' ? '#ea580c' : '#ca8a04',
                    color: '#fff',
                  }}
                >
                  {w.severity}
                </span>
                <div className="mt-1 text-neutral-200">{w.description}</div>
                {w.suggestion && (
                  <div className="mt-1 text-[color:var(--text-muted)]">
                    {w.suggestion}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Review Warnings */}
      {clipWarnings.length > 0 && (
        <div>
          <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-[color:var(--text-subtle)]">
            Warnings
          </div>
          <div className="mt-1.5 space-y-1.5">
            {clipWarnings.map((w, i) => (
              <div
                key={i}
                className="rounded border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-[11px]"
              >
                <span className="font-mono text-[9px] uppercase text-amber-400">
                  {w.category}
                </span>
                <div className="mt-1 text-neutral-200">{w.description}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );

  // Collapsible mode for NLE Inspector
  if (collapsible) {
    return (
      <CollapsibleSection
        key={clip.clip_id}
        title="AI Decision"
        defaultOpen={hasLowConfidence || clipWeaknesses.length > 0}
      >
        {content}
      </CollapsibleSection>
    );
  }

  // Standalone mode for AI Workspace tab
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-white/[0.06] px-4 py-2">
        <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-[color:var(--text-subtle)]">
          AI Decision
        </div>
      </div>
      <div className="editor-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {content}
      </div>
    </div>
  );
}

// ── Collapsible section helper ──────────────────────────────────────

import { useState } from 'react';

function CollapsibleSection({
  title,
  defaultOpen,
  children,
}: {
  title: string;
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className="border-b border-white/[0.06]">
      <button
        type="button"
        className="flex w-full items-center justify-between px-5 py-3 text-left transition hover:bg-white/[0.02]"
        onClick={() => setOpen(!open)}
      >
        <span className="font-mono text-[10px] uppercase tracking-[0.24em] text-[color:var(--text-subtle)]">
          {title}
        </span>
        <svg
          className={`h-3 w-3 text-[color:var(--text-subtle)] transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && <div className="px-5 pb-4">{children}</div>}
    </section>
  );
}
