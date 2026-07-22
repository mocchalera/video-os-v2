import * as fs from "node:fs";
import * as path from "node:path";
import { assertTimelineRenderSupported } from "../render/media-kind-guard.js";
import { parse as parseYaml } from "yaml";
import type { CreativeBrief } from "../artifacts/types.js";
import type { MarlinQAReport } from "../eval/marlin-qa-types.js";
import {
  isMarlinQAReportVerified,
  marlinQAStatus,
  type VisualQAStatus,
} from "../eval/marlin-qa-types.js";
import {
  defaultMarlinQAVideoPath,
  runMarlinQA,
  type RunMarlinQAOptions,
} from "../eval/marlin-qa.js";
import {
  assembleTimelineToMp4,
  type AssemblyResult,
  type AssemblerOptions,
} from "../render/assembler.js";
import { computeFileHash } from "../state/reconcile.js";
import {
  assessRenderArtifactFreshness,
  createSourceInputAttestation,
  writeRenderFreshnessMetadata as writeSharedRenderFreshnessMetadata,
  type SourceInputAttestationStatus,
} from "../render/source-input-attestation.js";

export const DEFAULT_REVIEW_VISUAL_QA_MIN_SCORE = 70;

export type ReviewVisualQAStatus = VisualQAStatus | "stale" | "not_applicable";

export interface ReviewVisualQAIssueSummary {
  total: number;
  critical: number;
  warning: number;
  info: number;
}

export interface ReviewVisualQA {
  status: ReviewVisualQAStatus;
  reason?: string;
  score?: number;
  min_score: number;
  issues: ReviewVisualQAIssueSummary;
  issue_summaries: string[];
  video_path?: string;
  video_hash?: string;
  timeline_path?: string;
  timeline_hash?: string;
  timeline_version?: string;
  source_inputs_hash?: string;
  source_inputs_status?: SourceInputAttestationStatus;
  source_input_warnings?: string[];
  render_meta_path?: string;
  marlin_report_path?: string;
}

export interface ReviewVisualQAGateReport {
  visual_qa?: ReviewVisualQA;
  visual_qa_waiver?: boolean;
  visual_qa_waiver_reason?: string;
}

export type RunMarlinQAForReview = (
  projectDir: string,
  videoPath: string,
  brief: CreativeBrief,
  options?: RunMarlinQAOptions,
) => Promise<MarlinQAReport>;

export type AssembleTimelineForReview = (
  options: AssemblerOptions,
) => Promise<AssemblyResult>;

export interface EvaluateReviewVisualQAOptions {
  render?: boolean;
  writeReport?: boolean;
  minScore?: number;
  createdAt?: string;
  repoRoot?: string;
  marlinReportDir?: string;
  runMarlinQAImpl?: RunMarlinQAForReview;
  assembleTimelineToMp4Impl?: AssembleTimelineForReview;
  now?: () => Date;
}

interface RenderFreshness {
  timelinePath: string;
  timelineHash: string;
  timelineVersion: string;
  videoHash?: string;
  renderMetaPath?: string;
  sourceInputsHash?: string;
  sourceInputsStatus?: SourceInputAttestationStatus;
  sourceInputWarnings?: string[];
}

type RenderFreshnessEvaluation = (RenderFreshness & { status: "fresh" }) | {
  status: "missing_timeline" | "stale";
  reason: string;
  timelinePath: string;
  timelineHash?: string;
  timelineVersion?: string;
  videoHash?: string;
  renderMetaPath?: string;
  sourceInputsHash?: string;
  sourceInputsStatus?: SourceInputAttestationStatus;
  sourceInputWarnings?: string[];
};

export function reviewVisualQAMinScore(repoRoot = process.cwd()): number {
  const defaultsPath = path.join(repoRoot, "runtime/compiler-defaults.yaml");
  if (!fs.existsSync(defaultsPath)) return DEFAULT_REVIEW_VISUAL_QA_MIN_SCORE;

  try {
    const parsed = parseYaml(fs.readFileSync(defaultsPath, "utf-8")) as {
      scoring?: { visual_qa_min_score?: unknown };
    } | null;
    const value = parsed?.scoring?.visual_qa_min_score;
    if (typeof value === "number" && Number.isFinite(value)) {
      return clampScore(value);
    }
  } catch {
    return DEFAULT_REVIEW_VISUAL_QA_MIN_SCORE;
  }

  return DEFAULT_REVIEW_VISUAL_QA_MIN_SCORE;
}

export async function evaluateReviewVisualQA(
  projectDir: string,
  options: EvaluateReviewVisualQAOptions = {},
): Promise<ReviewVisualQA> {
  const absDir = path.resolve(projectDir);
  const minScore = options.minScore ?? reviewVisualQAMinScore(options.repoRoot);
  const videoPath = defaultMarlinQAVideoPath(absDir);
  const timelinePath = path.join(absDir, "05_timeline/timeline.json");
  if (fs.existsSync(timelinePath)) {
    assertTimelineRenderSupported(JSON.parse(fs.readFileSync(timelinePath, "utf8")), {
      projectDir: absDir,
      timelinePath,
    });
  }
  const visualApplicable = timelineHasVisualClips(timelinePath);
  let freshness = evaluateRenderFreshness(absDir, videoPath);

  if (!visualApplicable) {
    if (options.render === true && (!fs.existsSync(videoPath) || freshness.status === "stale")) {
      const renderResult = await renderReviewVisualQAVideo(absDir, videoPath, options);
      if (renderResult) return renderResult;
      freshness = evaluateRenderFreshness(absDir, videoPath);
    }
    return notApplicableVisualQA(minScore, { videoPath, timelinePath, freshness });
  }

  if ((!fs.existsSync(videoPath) || freshness.status === "stale") && options.render) {
    const renderResult = await renderReviewVisualQAVideo(absDir, videoPath, options);
    if (renderResult) return renderResult;
    freshness = evaluateRenderFreshness(absDir, videoPath);
  }

  if (!fs.existsSync(videoPath)) {
    return blockedVisualQA("blocked", "render_missing", minScore, {
      videoPath,
      timelinePath,
      freshness,
    });
  }

  if (freshness.status === "missing_timeline") {
    return blockedVisualQA("blocked", "timeline_missing", minScore, {
      videoPath,
      timelinePath,
      freshness,
    });
  }

  if (freshness.status === "stale") {
    return blockedVisualQA("stale", freshness.reason, minScore, {
      videoPath,
      timelinePath,
      freshness,
    });
  }
  if (freshness.status !== "fresh") {
    return blockedVisualQA("blocked", freshness.reason, minScore, {
      videoPath,
      timelinePath,
      freshness,
    });
  }

  const brief = readCreativeBrief(absDir);
  if (!brief) {
    return blockedVisualQA("blocked", "creative_brief_missing", minScore, {
      videoPath,
      timelinePath,
      freshness,
    });
  }

  const runQA = options.runMarlinQAImpl ?? runMarlinQA;
  let reportPath: string | undefined;
  try {
    const report = await runQA(absDir, videoPath, brief, {
      now: options.now,
      reportDir: options.marlinReportDir,
      writeReport: options.writeReport,
      onReportPath: (writtenPath) => {
        reportPath = writtenPath;
      },
    });
    return visualQAFromMarlinReport(report, minScore, {
      projectDir: absDir,
      videoPath,
      timelinePath,
      freshness,
      reportPath,
    });
  } catch (err) {
    return blockedVisualQA("blocked", `marlin_qa_failed: ${errorMessage(err)}`, minScore, {
      videoPath,
      timelinePath,
      freshness,
    });
  }
}

export function visualQAFromMarlinReport(
  report: MarlinQAReport,
  minScore: number,
  context: {
    projectDir: string;
    videoPath: string;
    timelinePath: string;
    freshness: RenderFreshness;
    reportPath?: string;
  },
): ReviewVisualQA {
  const verified = isMarlinQAReportVerified(report);
  const status = verified ? "verified" : marlinQAStatus(report);
  return {
    status,
    ...(report.visual_qa_reason ? { reason: report.visual_qa_reason } : {}),
    score: report.score,
    min_score: minScore,
    issues: summarizeIssues(report),
    issue_summaries: report.issues.slice(0, 5).map((issue) =>
      `${issue.severity}:${issue.category}@${issue.timestamp_sec}s ${issue.description}`
    ),
    video_path: path.relative(context.projectDir, context.videoPath),
    video_hash: context.freshness.videoHash ?? computeExistingHash(context.videoPath),
    timeline_path: path.relative(context.projectDir, context.timelinePath),
    timeline_hash: context.freshness.timelineHash,
    timeline_version: context.freshness.timelineVersion,
    ...(context.freshness.sourceInputsHash ? { source_inputs_hash: context.freshness.sourceInputsHash } : {}),
    ...(context.freshness.sourceInputsStatus ? { source_inputs_status: context.freshness.sourceInputsStatus } : {}),
    ...(context.freshness.sourceInputWarnings?.length
      ? { source_input_warnings: context.freshness.sourceInputWarnings }
      : {}),
    ...(context.freshness.renderMetaPath
      ? { render_meta_path: path.relative(context.projectDir, context.freshness.renderMetaPath) }
      : {}),
    ...(context.reportPath
      ? { marlin_report_path: path.relative(context.projectDir, context.reportPath) }
      : {}),
  };
}

export const writeRenderFreshnessMetadata = writeSharedRenderFreshnessMetadata;

export function isReviewVisualQAApprovalGrade(
  report: ReviewVisualQAGateReport,
  visualApplicable = true,
): boolean {
  if (hasReviewVisualQAWaiver(report)) return true;
  const visual = report.visual_qa;
  if (!visualApplicable) {
    return visual?.status === "not_applicable" && visual.reason === "audio_only_timeline";
  }
  if (!visual || visual.status !== "verified") return false;
  return typeof visual.score === "number" && visual.score >= visual.min_score;
}

export function hasReviewVisualQAWaiver(report: ReviewVisualQAGateReport): boolean {
  return report.visual_qa_waiver === true &&
    typeof report.visual_qa_waiver_reason === "string" &&
    report.visual_qa_waiver_reason.trim().length > 0;
}

export function reviewVisualQAGateReason(
  report: ReviewVisualQAGateReport,
  visualApplicable = true,
): string | null {
  if (hasReviewVisualQAWaiver(report)) {
    return null;
  }
  const visual = report.visual_qa;
  if (!visual) return "review_report.visual_qa is missing";
  if (!visualApplicable) {
    return visual.status === "not_applicable" && visual.reason === "audio_only_timeline"
      ? null
      : `audio-only timeline requires review_report.visual_qa status \"not_applicable\" with reason \"audio_only_timeline\", got \"${visual.status}\"`;
  }
  if (visual.status !== "verified") {
    return `review_report.visual_qa.status must be "verified", got "${visual.status}"`;
  }
  if (typeof visual.score !== "number") {
    return "review_report.visual_qa.score is missing";
  }
  if (visual.score < visual.min_score) {
    return `review_report.visual_qa.score ${visual.score} is below threshold ${visual.min_score}`;
  }
  return null;
}

export function summarizeReviewVisualQAGate(visual: ReviewVisualQA): string {
  const score = typeof visual.score === "number" ? ` score ${visual.score}/${visual.min_score}` : "";
  const reason = visual.reason ? ` reason=${visual.reason}` : "";
  return `status=${visual.status}${score}${reason}`;
}

export function evaluateRenderFreshness(
  projectDir: string,
  videoPath: string,
): RenderFreshnessEvaluation {
  const assessed = assessRenderArtifactFreshness(projectDir, videoPath);
  return {
    status: assessed.status === "missing" ? "stale" : assessed.status,
    ...(assessed.reason ? { reason: assessed.reason } : {}),
    timelinePath: assessed.timelinePath,
    ...(assessed.timelineHash ? { timelineHash: assessed.timelineHash } : {}),
    ...(assessed.timelineVersion ? { timelineVersion: assessed.timelineVersion } : {}),
    ...(assessed.artifactHash ? { videoHash: assessed.artifactHash } : {}),
    ...(assessed.metaPath ? { renderMetaPath: assessed.metaPath } : {}),
    ...(assessed.sourceInputsHash ? { sourceInputsHash: assessed.sourceInputsHash } : {}),
    ...(assessed.sourceInputsStatus ? { sourceInputsStatus: assessed.sourceInputsStatus } : {}),
    ...(assessed.sourceInputWarnings ? { sourceInputWarnings: assessed.sourceInputWarnings } : {}),
  } as RenderFreshnessEvaluation;
}

async function renderReviewVisualQAVideo(
  projectDir: string,
  videoPath: string,
  options: EvaluateReviewVisualQAOptions,
): Promise<ReviewVisualQA | null> {
  const render = options.assembleTimelineToMp4Impl ?? assembleTimelineToMp4;
  const minScore = options.minScore ?? reviewVisualQAMinScore(options.repoRoot);
  const timelinePath = path.join(projectDir, "05_timeline/timeline.json");
  try {
    const sourceInputsBefore = createSourceInputAttestation(projectDir, { timelinePath });
    await render({
      projectDir,
      timelinePath,
      outputPath: videoPath,
    });
    writeRenderFreshnessMetadata(projectDir, videoPath, {
      createdAt: options.createdAt,
      sourceInputsBefore,
    });
    return null;
  } catch (err) {
    const freshness = evaluateRenderFreshness(projectDir, videoPath);
    return blockedVisualQA("blocked", `render_failed: ${errorMessage(err)}`, minScore, {
      videoPath,
      timelinePath,
      freshness,
    });
  }
}

function blockedVisualQA(
  status: "blocked" | "stale" | "unverified",
  reason: string,
  minScore: number,
  context: {
    videoPath: string;
    timelinePath: string;
    freshness?: Partial<RenderFreshness> & { renderMetaPath?: string };
  },
): ReviewVisualQA {
  const projectDir = path.dirname(path.dirname(context.timelinePath));
  return {
    status,
    reason,
    min_score: minScore,
    issues: { total: 0, critical: 0, warning: 0, info: 0 },
    issue_summaries: [],
    video_path: path.relative(projectDir, context.videoPath),
    ...(context.freshness?.videoHash ? { video_hash: context.freshness.videoHash } : {}),
    timeline_path: path.relative(projectDir, context.timelinePath),
    ...(context.freshness?.timelineHash ? { timeline_hash: context.freshness.timelineHash } : {}),
    ...(context.freshness?.timelineVersion ? { timeline_version: context.freshness.timelineVersion } : {}),
    ...(context.freshness?.sourceInputsHash ? { source_inputs_hash: context.freshness.sourceInputsHash } : {}),
    ...(context.freshness?.sourceInputsStatus ? { source_inputs_status: context.freshness.sourceInputsStatus } : {}),
    ...(context.freshness?.sourceInputWarnings?.length
      ? { source_input_warnings: context.freshness.sourceInputWarnings }
      : {}),
    ...(context.freshness?.renderMetaPath
      ? { render_meta_path: path.relative(projectDir, context.freshness.renderMetaPath) }
      : {}),
  };
}

function notApplicableVisualQA(
  minScore: number,
  context: {
    videoPath: string;
    timelinePath: string;
    freshness?: Partial<RenderFreshness> & { renderMetaPath?: string };
  },
): ReviewVisualQA {
  const projectDir = path.dirname(path.dirname(context.timelinePath));
  return {
    status: "not_applicable",
    reason: "audio_only_timeline",
    min_score: minScore,
    issues: { total: 0, critical: 0, warning: 0, info: 0 },
    issue_summaries: [],
    ...(fs.existsSync(context.videoPath)
      ? { video_path: path.relative(projectDir, context.videoPath) }
      : {}),
    ...(context.freshness?.videoHash ? { video_hash: context.freshness.videoHash } : {}),
    timeline_path: path.relative(projectDir, context.timelinePath),
    ...(context.freshness?.timelineHash ? { timeline_hash: context.freshness.timelineHash } : {}),
    ...(context.freshness?.timelineVersion ? { timeline_version: context.freshness.timelineVersion } : {}),
    ...(context.freshness?.sourceInputsHash ? { source_inputs_hash: context.freshness.sourceInputsHash } : {}),
    ...(context.freshness?.sourceInputsStatus ? { source_inputs_status: context.freshness.sourceInputsStatus } : {}),
    ...(context.freshness?.sourceInputWarnings?.length
      ? { source_input_warnings: context.freshness.sourceInputWarnings }
      : {}),
    ...(context.freshness?.renderMetaPath
      ? { render_meta_path: path.relative(projectDir, context.freshness.renderMetaPath) }
      : {}),
  };
}

export function timelineHasVisualClips(timelinePath: string): boolean {
  if (!fs.existsSync(timelinePath)) return true;
  try {
    const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf-8")) as {
      tracks?: {
        video?: Array<{ clips?: unknown[] }>;
        audio?: Array<{ clips?: unknown[] }>;
      };
    };
    const hasVideo = (timeline.tracks?.video ?? []).some(
      (track) => (track.clips?.length ?? 0) > 0,
    );
    if (hasVideo) return true;
    const hasAudio = (timeline.tracks?.audio ?? []).some(
      (track) => (track.clips?.length ?? 0) > 0,
    );
    // Empty/malformed timelines are not eligible for the audio-only exemption.
    return !hasAudio;
  } catch {
    return true;
  }
}

function summarizeIssues(report: MarlinQAReport): ReviewVisualQAIssueSummary {
  return report.issues.reduce(
    (summary, issue) => {
      summary.total += 1;
      summary[issue.severity] += 1;
      return summary;
    },
    { total: 0, critical: 0, warning: 0, info: 0 },
  );
}

function readCreativeBrief(projectDir: string): CreativeBrief | null {
  const briefPath = path.join(projectDir, "01_intent/creative_brief.yaml");
  if (!fs.existsSync(briefPath)) return null;
  try {
    return parseYaml(fs.readFileSync(briefPath, "utf-8")) as CreativeBrief;
  } catch {
    return null;
  }
}

function computeExistingHash(filePath: string): string | undefined {
  return fs.existsSync(filePath) ? computeFileHash(filePath) : undefined;
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
