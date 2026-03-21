/**
 * Gap Projection — transforms gap_report.yaml into analysis_gaps strings
 * and derives qc_status for media.project_summary.
 *
 * Per milestone-2-design.md §Partial Failure Handling:
 * - Sort: blocking desc, severity desc, stage asc, asset_id asc, segment_id asc
 * - Format: "<severity>/<stage>/<asset_id>[/<segment_id>]: <reason>"
 * - qc_status crosswalk: ready | partial | blocked
 */

// ── Types ──────────────────────────────────────────────────────────

export interface GapEntry {
  stage: string;
  asset_id: string;
  segment_id?: string;
  severity: "warning" | "error";
  blocking?: boolean;
  retriable?: boolean;
  reason?: string;
  issue?: string;
  attempted_at?: string;
}

export interface GapReport {
  version: string;
  entries: GapEntry[];
}

export type QcStatus = "ready" | "partial" | "blocked";

// ── Helpers ────────────────────────────────────────────────────────

/** Normalize: design doc uses both `reason` and `issue` fields across phases. */
function getReasonText(entry: GapEntry): string {
  return entry.reason || entry.issue || "unknown";
}

/** Severity rank for sorting: error > warning */
function severityRank(s: string): number {
  return s === "error" ? 1 : 0;
}

/** Blocking rank for sorting: blocking > non-blocking */
function blockingRank(entry: GapEntry): number {
  // Infer blocking from severity if not explicitly set
  if (entry.blocking !== undefined) return entry.blocking ? 1 : 0;
  // error-severity in ingest/segment stages is blocking by default
  if (entry.severity === "error" && (entry.stage === "ingest" || entry.stage === "segment")) {
    return 1;
  }
  return 0;
}

// ── Projection ─────────────────────────────────────────────────────

/**
 * Project gap_report entries into analysis_gaps strings for media.project_summary.
 *
 * Sort order: blocking desc → severity desc → stage asc → asset_id asc → segment_id asc
 * Format: "<severity>/<stage>/<asset_id>[/<segment_id>]: <reason>"
 */
export function projectAnalysisGaps(report: GapReport): string[] {
  if (!report.entries || report.entries.length === 0) return [];

  const sorted = [...report.entries].sort((a, b) => {
    // blocking desc
    const blockDiff = blockingRank(b) - blockingRank(a);
    if (blockDiff !== 0) return blockDiff;

    // severity desc
    const sevDiff = severityRank(b.severity) - severityRank(a.severity);
    if (sevDiff !== 0) return sevDiff;

    // stage asc
    const stageCmp = a.stage.localeCompare(b.stage);
    if (stageCmp !== 0) return stageCmp;

    // asset_id asc
    const assetCmp = a.asset_id.localeCompare(b.asset_id);
    if (assetCmp !== 0) return assetCmp;

    // segment_id asc (undefined sorts before defined)
    const segA = a.segment_id ?? "";
    const segB = b.segment_id ?? "";
    return segA.localeCompare(segB);
  });

  return sorted.map((entry) => {
    const segPart = entry.segment_id ? `/${entry.segment_id}` : "";
    return `${entry.severity}/${entry.stage}/${entry.asset_id}${segPart}: ${getReasonText(entry)}`;
  });
}

// ── QC Status Crosswalk ────────────────────────────────────────────

/**
 * Derive project-level qc_status from gap_report entries and asset information.
 *
 * Crosswalk per design doc:
 * - ready: no blocking gaps
 * - partial: at least one non-blocking gap remains
 * - blocked: ingest or segmentation failed such that asset set is unusable
 */
export function deriveQcStatus(
  report: GapReport,
  totalAssets: number,
): QcStatus {
  if (!report.entries || report.entries.length === 0) {
    return "ready";
  }

  // Check for blocking gaps
  const hasBlockingGaps = report.entries.some((entry) => {
    if (entry.blocking) return true;
    // Infer blocking: error in ingest/segment stages
    return entry.severity === "error" &&
      (entry.stage === "ingest" || entry.stage === "segment");
  });

  if (hasBlockingGaps) {
    // Count assets with blocking failures
    const blockedAssets = new Set<string>();
    for (const entry of report.entries) {
      const isBlocking = entry.blocking ||
        (entry.severity === "error" &&
          (entry.stage === "ingest" || entry.stage === "segment"));
      if (isBlocking) {
        blockedAssets.add(entry.asset_id);
      }
    }

    // If ALL assets are blocked (or zero assets) → blocked
    // If some assets survived → partial
    if (totalAssets === 0 || blockedAssets.size >= totalAssets) {
      return "blocked";
    }
    // Some assets ready, some failed with blocking gaps → partial
    return "partial";
  }

  // Only non-blocking gaps remain
  return "partial";
}
