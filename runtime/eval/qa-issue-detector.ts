import * as crypto from "node:crypto";
import type { ClipOutput, TimelineIR } from "../artifacts/types.js";
import type { BriefAlignmentAxis, BriefAlignmentReport, AxisScore } from "./brief-alignment-types.js";
import type { ReviewMetricId, ReviewMetricsArtifact } from "../review/metrics.js";
import {
  isMarlinQAReportVerified,
  marlinQAStatus,
  type MarlinQAIssue,
  type MarlinQAReport,
} from "./marlin-qa-types.js";

export type MarlinQAResult = MarlinQAReport;
export type BriefAlignmentResult = BriefAlignmentReport;
export type Timeline = TimelineIR;

export type QAIssueType = "quality" | "continuity" | "pacing" | "variety" | "must_have" | "micro_clip";
export type QAIssueFixType = "swap" | "reorder" | "trim" | "insert" | "remove";

export interface QAIssue {
  issue_id: string;
  type: QAIssueType;
  severity: number;
  timestamp_sec: number;
  clip_id?: string;
  beat_id?: string;
  description: string;
  fixable: boolean;
  suggested_fix_type?: QAIssueFixType;
  source?: "marlin_qa" | "brief_alignment" | "timeline" | "review_metrics";
  source_category?: string;
  source_axis?: BriefAlignmentAxis;
  adjacent_clip_ids?: {
    before?: string;
    after?: string;
  };
  search_query?: string;
  non_fixable_reason?: string;
}

interface TimestampMapping {
  targetFrame: number;
  clip?: ClipOutput;
  adjacent?: {
    before?: ClipOutput;
    after?: ClipOutput;
  };
}

const MICRO_CLIP_THRESHOLD_SEC = 1;

export function detectIssues(
  marlinQaResult: MarlinQAResult,
  briefAlignmentResult: BriefAlignmentResult,
  timeline: Timeline,
  reviewMetrics?: ReviewMetricsArtifact,
): QAIssue[] {
  const issues: QAIssue[] = [];

  const visualQAIssue = isAudioOnlyTimeline(timeline)
    ? null
    : detectVisualQAStateIssue(marlinQaResult);
  if (visualQAIssue) {
    issues.push(visualQAIssue);
  } else {
    marlinQaResult.issues.forEach((issue, index) => {
      const mapped = mapTimestampToTimeline(timeline, issue.timestamp_sec);
      const issueType = marlinCategoryToIssueType(issue.category);
      if (!issueType) return;

      if (issueType === "continuity") {
        const adjacent = adjacentPairAtTimestamp(timeline, mapped.targetFrame) ?? mapped.adjacent;
        const targetClip = adjacent?.after ?? mapped.clip ?? adjacent?.before;
        const fixable = Boolean(adjacent?.before && adjacent?.after);
        issues.push({
          issue_id: issueId([
            "marlin",
            index,
            issue.category,
            issue.timestamp_sec,
            adjacent?.before?.clip_id,
            adjacent?.after?.clip_id,
            issue.description,
          ]),
          type: "continuity",
          severity: severityFromMarlin(issue.severity),
          timestamp_sec: round3(issue.timestamp_sec),
          ...(targetClip ? { clip_id: targetClip.clip_id, beat_id: targetClip.beat_id } : {}),
          description: issue.description,
          fixable,
          suggested_fix_type: fixable ? "insert" : undefined,
          source: "marlin_qa",
          source_category: issue.category,
          adjacent_clip_ids: {
            ...(adjacent?.before ? { before: adjacent.before.clip_id } : {}),
            ...(adjacent?.after ? { after: adjacent.after.clip_id } : {}),
          },
          ...(fixable ? {} : { non_fixable_reason: "continuity issue could not be mapped to an adjacent clip pair" }),
        });
        return;
      }

      const targetClip = mapped.clip;
      const fixable = Boolean(targetClip);
      issues.push({
        issue_id: issueId([
          "marlin",
          index,
          issue.category,
          issue.timestamp_sec,
          targetClip?.clip_id,
          issue.description,
        ]),
        type: issueType,
        severity: severityFromMarlin(issue.severity),
        timestamp_sec: round3(issue.timestamp_sec),
        ...(targetClip ? { clip_id: targetClip.clip_id, beat_id: targetClip.beat_id } : {}),
        description: issue.description,
        fixable,
        suggested_fix_type: suggestedFixTypeForMarlin(issue),
        source: "marlin_qa",
        source_category: issue.category,
        ...(fixable ? {} : { non_fixable_reason: "timestamp could not be mapped to a timeline clip" }),
      });
    });
  }

  issues.push(...detectTimelineMicroClips(timeline, issues));
  issues.push(...detectBriefAlignmentIssues(briefAlignmentResult));
  issues.push(...detectReviewMetricIssues(reviewMetrics, timeline));

  return issues.sort(compareIssues);
}

export function isAudioOnlyTimeline(timeline: Timeline): boolean {
  const videoClips = timeline.tracks?.video?.flatMap((track) => track.clips ?? []) ?? [];
  const audioClips = timeline.tracks?.audio?.flatMap((track) => track.clips ?? []) ?? [];
  return videoClips.length === 0 && audioClips.length > 0;
}

const REVIEW_CONTINUITY_METRIC_IDS = new Set<ReviewMetricId>([
  "eye_trace.same_asset_adjacency",
  "eye_trace.attention_jump",
  "eye_trace.motion_flow",
  "plane_2d.framing_jump",
  "plane_2d.luma_color_jump",
  "space_3d.direction_axis",
]);

function detectReviewMetricIssues(
  reviewMetrics: ReviewMetricsArtifact | undefined,
  timeline: Timeline,
): QAIssue[] {
  if (!reviewMetrics) return [];
  if (reviewMetrics.project_id !== timeline.project_id || reviewMetrics.timeline_version !== timeline.version) return [];
  const clips = primaryVideoClips(timeline);
  const fps = timelineFps(timeline);
  const issues: QAIssue[] = [];

  for (const metric of reviewMetrics.checks) {
    if (!REVIEW_CONTINUITY_METRIC_IDS.has(metric.id)) continue;
    if (metric.status !== "fail" && metric.status !== "warn") continue;
    const measured = recordValue(metric.measured);
    if (!measured) continue;
    const findings = [
      ...reviewMetricFindings(measured.violations, "fail"),
      ...reviewMetricFindings(measured.warnings, "warn"),
    ];
    for (const finding of findings) {
      const relationship = typeof finding.value.relationship === "string"
        ? finding.value.relationship
        : "unknown";
      if (relationship === "intentional_contrast" || finding.value.outcome === "intentional") continue;
      const leftClipId = stringValue(finding.value.left_clip_id);
      const rightClipId = stringValue(finding.value.right_clip_id);
      if (!leftClipId || !rightClipId) continue;
      const leftIndex = clips.findIndex((clip) => clip.clip_id === leftClipId);
      if (leftIndex < 0 || clips[leftIndex + 1]?.clip_id !== rightClipId) continue;
      const right = clips[leftIndex + 1];
      const description = stringValue(finding.value.description) ??
        `${metric.id} reports an advisory continuity finding for ${leftClipId}->${rightClipId}.`;
      issues.push({
        issue_id: issueId([
          "review_metrics",
          metric.id,
          finding.kind,
          leftClipId,
          rightClipId,
          stringValue(finding.value.pair_id),
          description,
        ]),
        type: "continuity",
        severity: finding.kind === "fail" ? 0.8 : 0.4,
        timestamp_sec: round3(right.timeline_in_frame / fps),
        clip_id: right.clip_id,
        beat_id: right.beat_id,
        description,
        fixable: false,
        source: "review_metrics",
        source_category: metric.id,
        adjacent_clip_ids: { before: leftClipId, after: rightClipId },
        non_fixable_reason: "Advisory review metric before profile calibration; excluded from automatic proposal and application.",
      });
    }
  }
  return issues;
}

function reviewMetricFindings(
  value: unknown,
  kind: "fail" | "warn",
): Array<{ value: Record<string, unknown>; kind: "fail" | "warn" }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => recordValue(item))
    .filter((item): item is Record<string, unknown> => item !== undefined)
    .map((item) => ({ value: item, kind }));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function detectVisualQAStateIssue(report: MarlinQAResult): QAIssue | null {
  if (isMarlinQAReportVerified(report)) return null;
  const status = marlinQAStatus(report);
  const sourceCategory = report.mock === true ? "visual_qa_mock" : `visual_qa_${status}`;
  const description = report.mock === true
    ? "Marlin visual QA was produced in mock mode and is not acceptable as a passing visual evaluation."
    : `Marlin visual QA is ${status}; ${report.visual_qa_reason ?? "no verified rendered-video evaluation is available"}.`;
  return {
    issue_id: issueId(["marlin_visual_qa", status, report.mock === true, report.video_path, report.visual_qa_reason]),
    type: "quality",
    severity: 1,
    timestamp_sec: 0,
    description,
    fixable: false,
    source: "marlin_qa",
    source_category: sourceCategory,
    non_fixable_reason: "A live rendered-video Marlin QA pass is required before visual QA can be counted as passing.",
  };
}

export function timelineFps(timeline: Timeline): number {
  const fpsNum = finiteNumber(timeline.sequence?.fps_num) ?? 24;
  const fpsDen = finiteNumber(timeline.sequence?.fps_den) ?? 1;
  if (fpsNum <= 0 || fpsDen <= 0) return 24;
  return fpsNum / fpsDen;
}

export function primaryVideoClips(timeline: Timeline): ClipOutput[] {
  const videoTracks = timeline.tracks?.video ?? [];
  const primaryTrack = videoTracks.find((track) => track.track_id === "V1") ?? videoTracks[0];
  return [...(primaryTrack?.clips ?? [])].sort(compareClips);
}

export function mapTimestampToTimeline(timeline: Timeline, timestampSec: number): TimestampMapping {
  const fps = timelineFps(timeline);
  const targetFrame = Math.round(Math.max(0, timestampSec) * fps);
  const clips = primaryVideoClips(timeline);
  const clipIndex = clips.findIndex((clip) => {
    const start = clip.timeline_in_frame;
    const end = start + Math.max(0, clip.timeline_duration_frames);
    return start <= targetFrame && targetFrame < end;
  });

  if (clipIndex >= 0) {
    return {
      targetFrame,
      clip: clips[clipIndex],
      adjacent: {
        before: clips[clipIndex - 1],
        after: clips[clipIndex + 1],
      },
    };
  }

  const before = clips
    .filter((clip) => clip.timeline_in_frame + Math.max(0, clip.timeline_duration_frames) <= targetFrame)
    .at(-1);
  const after = clips.find((clip) => clip.timeline_in_frame >= targetFrame);
  return {
    targetFrame,
    adjacent: { before, after },
  };
}

function detectTimelineMicroClips(timeline: Timeline, existingIssues: QAIssue[]): QAIssue[] {
  const fps = timelineFps(timeline);
  const existingMicroKeys = new Set(
    existingIssues
      .filter((issue) => issue.source_category === "micro_clip" && issue.clip_id)
      .map((issue) => issue.clip_id),
  );

  return primaryVideoClips(timeline)
    .filter((clip) => {
      const durationSec = clip.timeline_duration_frames / fps;
      return durationSec > 0
        && durationSec < MICRO_CLIP_THRESHOLD_SEC
        && !existingMicroKeys.has(clip.clip_id)
        && !isIntentionalFlashCut(clip);
    })
    .map((clip) => {
      const durationSec = clip.timeline_duration_frames / fps;
      return {
        issue_id: issueId(["timeline", "micro_clip", clip.clip_id, clip.timeline_in_frame, clip.timeline_duration_frames]),
        type: "pacing" as const,
        severity: round3(clamp01(1 - durationSec / MICRO_CLIP_THRESHOLD_SEC)),
        timestamp_sec: round3(clip.timeline_in_frame / fps),
        clip_id: clip.clip_id,
        beat_id: clip.beat_id,
        description: `Timeline clip ${clip.clip_id} is ${round3(durationSec)}s, below the ${MICRO_CLIP_THRESHOLD_SEC}s micro-clip threshold.`,
        fixable: true,
        suggested_fix_type: "trim" as const,
        source: "timeline" as const,
        source_category: "micro_clip",
      };
    });
}

function detectBriefAlignmentIssues(report: BriefAlignmentResult): QAIssue[] {
  const issues: QAIssue[] = [];

  for (const stageName of ["selects", "blueprint"] as const) {
    const stage = report.stages[stageName];
    if (!stage) continue;
    for (const [axis, score] of Object.entries(stage.axes) as Array<[BriefAlignmentAxis, AxisScore]>) {
      if (score.score >= 0.5) continue;
      const mapped = briefAxisToIssue(axis);
      if (!mapped) continue;
      const texts = [...score.gaps, ...score.evidence].filter(Boolean);
      const searchQuery = searchQueryFromBriefTexts(texts, mapped.fallbackQuery);
      const beatId = extractBeatId(texts);
      issues.push({
        issue_id: issueId(["brief_alignment", stageName, axis, score.score, searchQuery]),
        type: mapped.type,
        severity: round3(clamp01(1 - score.score)),
        timestamp_sec: 0,
        ...(beatId ? { beat_id: beatId } : {}),
        description: `${stageName} ${axis} scored ${round3(score.score)}. ${texts.slice(0, 3).join(" ")}`.trim(),
        fixable: true,
        suggested_fix_type: mapped.fixType,
        source: "brief_alignment",
        source_axis: axis,
        search_query: searchQuery,
      });
    }
  }

  return issues;
}

function briefAxisToIssue(axis: BriefAlignmentAxis): { type: QAIssueType; fixType: QAIssueFixType; fallbackQuery: string } | null {
  if (axis === "must_have_coverage") {
    return { type: "must_have", fixType: "swap", fallbackQuery: "must have coverage" };
  }
  if (axis === "visual_variety_and_focus") {
    return { type: "variety", fixType: "swap", fallbackQuery: "visual variety" };
  }
  if (axis === "pacing_coherence") {
    return { type: "pacing", fixType: "trim", fallbackQuery: "pacing coherence" };
  }
  return null;
}

function marlinCategoryToIssueType(category: MarlinQAIssue["category"]): QAIssueType | null {
  switch (category) {
    case "camera_shake":
    case "dark_exposure":
    case "weak_content":
      return "quality";
    case "continuity":
      return "continuity";
    case "pacing":
    case "micro_clip":
      return "pacing";
    default:
      return null;
  }
}

function suggestedFixTypeForMarlin(issue: MarlinQAIssue): QAIssueFixType {
  switch (issue.category) {
    case "camera_shake":
    case "dark_exposure":
    case "weak_content":
      return "swap";
    case "micro_clip":
      return "trim";
    case "pacing":
      return "trim";
    case "continuity":
      return "insert";
    default:
      return "swap";
  }
}

function adjacentPairAtTimestamp(timeline: Timeline, targetFrame: number): TimestampMapping["adjacent"] | undefined {
  const clips = primaryVideoClips(timeline);
  let best:
    | {
      distance: number;
      before: ClipOutput;
      after: ClipOutput;
    }
    | undefined;

  for (let index = 1; index < clips.length; index += 1) {
    const before = clips[index - 1];
    const after = clips[index];
    const beforeEnd = before.timeline_in_frame + Math.max(0, before.timeline_duration_frames);
    const cutFrame = Math.round((beforeEnd + after.timeline_in_frame) / 2);
    const distance = Math.abs(targetFrame - cutFrame);
    if (!best || distance < best.distance) {
      best = { distance, before, after };
    }
  }

  return best ? { before: best.before, after: best.after } : undefined;
}

function severityFromMarlin(severity: MarlinQAIssue["severity"]): number {
  if (severity === "critical") return 1;
  if (severity === "warning") return 0.65;
  return 0.25;
}

function searchQueryFromBriefTexts(texts: string[], fallback: string): string {
  const quotedTerms = texts
    .flatMap((text) => Array.from(text.matchAll(/['"]([^'"]{2,})['"]/g)).map((match) => match[1].trim()))
    .filter(Boolean);
  if (quotedTerms.length > 0) {
    return Array.from(new Set(quotedTerms)).join(" ");
  }
  const compact = texts.join(" ").replace(/\s+/g, " ").trim();
  return compact || fallback;
}

function extractBeatId(texts: string[]): string | undefined {
  const joined = texts.join(" ");
  const match = joined.match(/\b(b\d[\w-]*)\b/i);
  return match?.[1];
}

function isIntentionalFlashCut(clip: ClipOutput): boolean {
  const metadata = recordValue(clip.metadata);
  if (!metadata) return false;
  if (metadata.flash_cut === true || metadata.intentional_micro_clip === true) return true;
  const craft = recordValue(metadata.craft);
  return craft?.flash_cut === true || craft?.intentional_micro_clip === true;
}

function compareIssues(left: QAIssue, right: QAIssue): number {
  return right.severity - left.severity
    || left.timestamp_sec - right.timestamp_sec
    || (left.clip_id ?? "").localeCompare(right.clip_id ?? "")
    || left.issue_id.localeCompare(right.issue_id);
}

function compareClips(left: ClipOutput, right: ClipOutput): number {
  return left.timeline_in_frame - right.timeline_in_frame
    || left.clip_id.localeCompare(right.clip_id);
}

function issueId(parts: unknown[]): string {
  const hash = crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 12);
  return `QAISSUE_${hash}`;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
