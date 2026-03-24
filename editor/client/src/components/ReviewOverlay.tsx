import type { ReviewReportResponse } from '../types';

interface ReviewOverlayProps {
  reviewReport: ReviewReportResponse | null;
  pxPerFrame: number;
  totalFrames: number;
  viewportWidth: number;
}

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  approved: { bg: 'rgba(22,163,74,0.18)', text: '#4ade80' },
  needs_revision: { bg: 'rgba(202,138,4,0.18)', text: '#facc15' },
  blocked: { bg: 'rgba(220,38,38,0.18)', text: '#f87171' },
};

export default function ReviewOverlay({
  reviewReport,
  pxPerFrame,
  totalFrames,
  viewportWidth,
}: ReviewOverlayProps) {
  if (!reviewReport?.exists || !reviewReport.data) {
    return null;
  }

  const report = reviewReport.data;
  const status = report.summary_judgment?.status ?? 'needs_revision';
  const colors = STATUS_COLORS[status] ?? STATUS_COLORS.needs_revision;
  const bandWidth = Math.max(viewportWidth, totalFrames * pxPerFrame);

  const weaknessCount = report.weaknesses?.length ?? 0;
  const warningCount = report.warnings?.length ?? 0;

  return (
    <div className="relative shrink-0 border-b border-white/[0.06]" style={{ height: 28 }}>
      {/* Status band */}
      <div
        className="absolute inset-y-0 left-0"
        style={{ width: bandWidth, background: colors.bg }}
      />

      {/* Label */}
      <div className="relative flex h-full items-center gap-3 px-3">
        <span
          className="rounded-sm px-1.5 py-px font-mono text-[9px] font-bold uppercase"
          style={{ background: colors.text, color: '#000' }}
        >
          {status.replace('_', ' ')}
        </span>

        {report.summary_judgment?.rationale ? (
          <span className="truncate text-[11px] text-neutral-300">
            {report.summary_judgment.rationale}
          </span>
        ) : null}

        <div className="flex-1" />

        {weaknessCount > 0 ? (
          <span className="font-mono text-[10px] text-red-400">
            {weaknessCount} weakness{weaknessCount !== 1 ? 'es' : ''}
          </span>
        ) : null}

        {warningCount > 0 ? (
          <span className="font-mono text-[10px] text-amber-400">
            {warningCount} warning{warningCount !== 1 ? 's' : ''}
          </span>
        ) : null}
      </div>
    </div>
  );
}
