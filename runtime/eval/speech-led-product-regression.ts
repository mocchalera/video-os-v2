import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  loadBlueprint,
  loadCreativeBrief,
  loadTimeline,
  validateArtifact,
} from "../artifacts/loaders.js";
import type {
  CreativeBrief,
  EditBlueprint,
  TimelineIR,
} from "../artifacts/types.js";
import {
  isMarlinQAReportVerified,
  marlinQAStatus,
  type MarlinQAReport,
} from "./marlin-qa-types.js";

export const SPEECH_LED_REGRESSION_VERSION = "speech-led-product-regression/v1";
export const SPEECH_LED_MIN_DURATION_SEC = 60;
export const SPEECH_LED_MAX_DURATION_SEC = 180;

export interface SpeechLedGateCheck {
  id: string;
  passed: boolean;
  detail: string;
}

export interface SpeechLedArtifactGateReport {
  version: typeof SPEECH_LED_REGRESSION_VERSION;
  mode: "artifact_contract";
  project_id: string;
  passed: boolean;
  duration_sec: number | null;
  visual_qa_status: string | null;
  checks: SpeechLedGateCheck[];
}

export interface SpeechLedRealMediaEvidence {
  video_exists: boolean;
  render_duration_sec: number;
  render_parity_pass: boolean;
  marlin_report: MarlinQAReport;
  min_score?: number;
}

export interface SpeechLedRealMediaGateReport {
  version: typeof SPEECH_LED_REGRESSION_VERSION;
  mode: "real_media";
  project_id: string;
  passed: boolean;
  render_duration_sec: number;
  marlin_status: string;
  marlin_score: number;
  checks: SpeechLedGateCheck[];
}

interface ProjectStateArtifact {
  project_id: string;
  current_state: string;
  approval_record?: {
    status?: string;
    approved_by?: string;
  };
  handoff_resolution?: {
    status?: string;
    source_of_truth_decision?: string;
  };
}

interface ReviewReportArtifact {
  project_id: string;
  timeline_version: string;
  summary_judgment: {
    status: string;
  };
  fatal_issues: unknown[];
  visual_qa?: {
    status?: string;
  };
  visual_qa_waiver?: boolean;
}

interface LoadedSpeechLedArtifacts {
  brief: CreativeBrief;
  blueprint: EditBlueprint;
  timeline: TimelineIR;
  state: ProjectStateArtifact;
  review: ReviewReportArtifact;
}

export function evaluateSpeechLedArtifactContract(
  projectDir: string,
): SpeechLedArtifactGateReport {
  const checks: SpeechLedGateCheck[] = [];
  let artifacts: LoadedSpeechLedArtifacts | null = null;

  try {
    artifacts = loadSpeechLedArtifacts(projectDir);
    addCheck(checks, "canonical_artifacts_schema_valid", true,
      "creative brief, blueprint, timeline, project state, and review report validate");
  } catch (error) {
    addCheck(checks, "canonical_artifacts_schema_valid", false, errorMessage(error));
  }

  if (!artifacts) {
    return artifactReport(path.basename(path.resolve(projectDir)), null, null, checks);
  }

  const { brief, blueprint, timeline, state, review } = artifacts;
  const projectId = brief.project_id;
  const identities = [
    brief.project_id,
    brief.project.id,
    blueprint.project_id,
    timeline.project_id,
    state.project_id,
    review.project_id,
  ];
  addCheck(
    checks,
    "project_identity_consistent",
    identities.every((value) => value === projectId),
    identities.join(" = "),
  );

  addCheck(
    checks,
    "profile_interview_highlight",
    brief.editorial?.profile_hint === "interview-highlight",
    `profile_hint=${brief.editorial?.profile_hint ?? "missing"}`,
  );
  addCheck(
    checks,
    "policy_interview",
    brief.editorial?.policy_hint === "interview",
    `policy_hint=${brief.editorial?.policy_hint ?? "missing"}`,
  );
  addCheck(
    checks,
    "profile_inference_disabled",
    brief.editorial?.allow_inference === false,
    `allow_inference=${String(brief.editorial?.allow_inference)}`,
  );
  addCheck(
    checks,
    "editorial_order",
    brief.order_policy === "editorial" && blueprint.timeline_order === "editorial",
    `brief=${brief.order_policy ?? "missing"}, blueprint=${String(blueprint.timeline_order ?? "missing")}`,
  );

  const targetDuration = brief.project.runtime_target_sec ?? SPEECH_LED_MIN_DURATION_SEC;
  addCheck(
    checks,
    "brief_duration_in_product_range",
    inProductDurationRange(targetDuration),
    `runtime_target_sec=${targetDuration}`,
  );

  const durationSec = timelineDurationSec(timeline);
  addCheck(
    checks,
    "timeline_duration_in_product_range",
    inProductDurationRange(durationSec),
    `duration_sec=${durationSec.toFixed(3)}`,
  );

  const captionSource = blueprint.caption_policy?.source;
  addCheck(
    checks,
    "speech_captions_enabled",
    captionSource === "transcript" || captionSource === "authored",
    `caption_source=${captionSource ?? "missing"}`,
  );
  addCheck(
    checks,
    "speech_caption_style_readable",
    blueprint.caption_policy?.styling_class === "clean-lower-third",
    `styling_class=${blueprint.caption_policy?.styling_class ?? "missing"}; clean-lower-third resolves to the approved 60px 1080p preset`,
  );

  addCheck(
    checks,
    "operator_approved",
    state.approval_record?.approved_by === "operator" &&
      (state.approval_record.status === "clean" || state.approval_record.status === "creative_override"),
    `approved_by=${state.approval_record?.approved_by ?? "missing"}, status=${state.approval_record?.status ?? "missing"}`,
  );
  addCheck(
    checks,
    "approved_or_packaged_state",
    state.current_state === "approved" || state.current_state === "packaged",
    `current_state=${state.current_state}`,
  );
  addCheck(
    checks,
    "handoff_decision_recorded",
    state.handoff_resolution?.status === "decided" &&
      (state.handoff_resolution.source_of_truth_decision === "engine_render" ||
        state.handoff_resolution.source_of_truth_decision === "nle_finishing"),
    `status=${state.handoff_resolution?.status ?? "missing"}, source_of_truth=${state.handoff_resolution?.source_of_truth_decision ?? "missing"}`,
  );
  addCheck(
    checks,
    "review_approved_without_fatal_issues",
    review.summary_judgment.status === "approved" && review.fatal_issues.length === 0,
    `summary=${review.summary_judgment.status}, fatal_issues=${review.fatal_issues.length}`,
  );

  const visualStatus = review.visual_qa?.status ?? null;
  addCheck(
    checks,
    "visual_qa_state_is_explicit",
    visualStatus !== null,
    `status=${visualStatus ?? "missing"}; waiver=${review.visual_qa_waiver === true}; contract gate does not promote a waiver to verified`,
  );

  return artifactReport(projectId, durationSec, visualStatus, checks);
}

export function evaluateSpeechLedRealMediaRegression(
  artifactReport: SpeechLedArtifactGateReport,
  evidence: SpeechLedRealMediaEvidence,
): SpeechLedRealMediaGateReport {
  const checks: SpeechLedGateCheck[] = [];
  const minScore = evidence.min_score ?? 70;
  const marlin = evidence.marlin_report;
  const visualStatus = marlinQAStatus(marlin);

  addCheck(checks, "artifact_contract_passed", artifactReport.passed,
    `artifact_contract=${artifactReport.passed ? "passed" : "failed"}`);
  addCheck(checks, "rendered_video_exists", evidence.video_exists,
    `video_exists=${evidence.video_exists}`);
  addCheck(
    checks,
    "render_duration_in_product_range",
    inProductDurationRange(evidence.render_duration_sec),
    `duration_sec=${evidence.render_duration_sec.toFixed(3)}`,
  );
  addCheck(checks, "render_duration_parity", evidence.render_parity_pass,
    `parity_pass=${evidence.render_parity_pass}`);
  addCheck(
    checks,
    "marlin_visual_qa_verified",
    isMarlinQAReportVerified(marlin),
    `status=${visualStatus}, reason=${marlin.visual_qa_reason ?? "none"}`,
  );
  addCheck(checks, "marlin_not_mocked", marlin.mock !== true,
    `mock=${marlin.mock === true}`);
  addCheck(checks, "marlin_score_meets_threshold", marlin.score >= minScore,
    `score=${marlin.score}, min_score=${minScore}`);
  const criticalIssues = marlin.issues.filter((issue) => issue.severity === "critical").length;
  addCheck(checks, "marlin_has_no_critical_issues", criticalIssues === 0,
    `critical_issues=${criticalIssues}`);
  addCheck(
    checks,
    "marlin_evaluated_current_render_duration",
    Math.abs(marlin.video_duration_sec - evidence.render_duration_sec) <= 1,
    `marlin_duration_sec=${marlin.video_duration_sec}, render_duration_sec=${evidence.render_duration_sec}`,
  );

  return {
    version: SPEECH_LED_REGRESSION_VERSION,
    mode: "real_media",
    project_id: artifactReport.project_id,
    passed: checks.every((check) => check.passed),
    render_duration_sec: evidence.render_duration_sec,
    marlin_status: visualStatus,
    marlin_score: marlin.score,
    checks,
  };
}

export function formatSpeechLedGateReport(
  report: SpeechLedArtifactGateReport | SpeechLedRealMediaGateReport,
): string {
  const lines = [
    `[speech-led-regression] ${report.passed ? "PASS" : "FAIL"}`,
    `  mode=${report.mode}`,
    `  project=${report.project_id}`,
  ];
  for (const check of report.checks) {
    lines.push(`  ${check.passed ? "PASS" : "FAIL"} ${check.id}: ${check.detail}`);
  }
  return lines.join("\n");
}

function loadSpeechLedArtifacts(projectDir: string): LoadedSpeechLedArtifacts {
  const absDir = path.resolve(projectDir);
  const brief = loadCreativeBrief(path.join(absDir, "01_intent", "creative_brief.yaml"));
  const blueprint = loadBlueprint(path.join(absDir, "04_plan", "edit_blueprint.yaml"));
  const timeline = loadTimeline(path.join(absDir, "05_timeline", "timeline.json"));
  const state = validateArtifact<ProjectStateArtifact>(
    readYaml(path.join(absDir, "project_state.yaml")),
    "project-state.schema.json",
  );
  const review = validateArtifact<ReviewReportArtifact>(
    readYaml(path.join(absDir, "06_review", "review_report.yaml")),
    "review-report.schema.json",
  );
  return { brief, blueprint, timeline, state, review };
}

function readYaml(filePath: string): unknown {
  if (!fs.existsSync(filePath)) throw new Error(`Artifact file not found: ${filePath}`);
  return parseYaml(fs.readFileSync(filePath, "utf-8"));
}

function timelineDurationSec(timeline: TimelineIR): number {
  const fps = timeline.sequence.fps_num / timeline.sequence.fps_den;
  const endFrame = timeline.tracks.video
    .flatMap((track) => track.clips)
    .reduce(
      (max, clip) => Math.max(max, clip.timeline_in_frame + clip.timeline_duration_frames),
      timeline.sequence.start_frame,
    );
  return fps > 0 ? (endFrame - timeline.sequence.start_frame) / fps : 0;
}

function inProductDurationRange(durationSec: number): boolean {
  return Number.isFinite(durationSec) &&
    durationSec >= SPEECH_LED_MIN_DURATION_SEC &&
    durationSec <= SPEECH_LED_MAX_DURATION_SEC;
}

function addCheck(
  checks: SpeechLedGateCheck[],
  id: string,
  passed: boolean,
  detail: string,
): void {
  checks.push({ id, passed, detail });
}

function artifactReport(
  projectId: string,
  durationSec: number | null,
  visualStatus: string | null,
  checks: SpeechLedGateCheck[],
): SpeechLedArtifactGateReport {
  return {
    version: SPEECH_LED_REGRESSION_VERSION,
    mode: "artifact_contract",
    project_id: projectId,
    passed: checks.every((check) => check.passed),
    duration_sec: durationSec,
    visual_qa_status: visualStatus,
    checks,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
