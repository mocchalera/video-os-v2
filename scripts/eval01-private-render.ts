#!/usr/bin/env npx tsx

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { hasCaptionStylePreset } from "../editor/shared/caption-style-tokens.js";
import { readProjectCaptionStylingClass } from "../editor/shared/project-caption-settings.js";
import {
  measureQaMedia,
  type QaMeasurements,
} from "../runtime/packaging/qa-measure.js";
import type { AssSubtitleStyleOptions } from "../runtime/render/promo-finisher.js";
import { resolveSocialReviewCaptionStyle } from "../runtime/render/review-caption-style.js";
import { deriveDeterministicAllowedRanges } from "../runtime/review/deterministic-output-qa.js";

const require_ = createRequire(import.meta.url);
const SHA256 = /^[0-9a-f]{64}$/;
const QA_DOMAIN = "eval01-private-render-qa/v1";
const RECEIPT_DOMAIN = "eval01-private-render-receipt/v2";
const REQUIRED_INPUT_ORDER = [
  "base_plan",
  "timeline_current",
  "caption_plan_v2",
  "caption_provenance_v2",
  "authoring_receipt_v2",
  "independent_authoring_audit_v2",
  "source_media",
  "render_social_review_source",
  "render_rough_cut_source",
  "future_v2_native_runner_source",
] as const;

export const EVAL01_OUTPUT_HASH_ORDER = [
  "project/05_timeline/video-assembly-timing.json",
  "project/06_review/useful-private-v2.mp4",
  "project/06_review/useful-private-v2-work/base-dialogue.mp4",
  "project/06_review/useful-private-v2-work/captions.ass",
  "project/06_review/useful-private-v2-work/mastered-dialogue.wav",
  "project/06_review/useful-private-v2-work/render-report.json",
  "project/06_review/useful-private-v2-work/social-review-report.json",
  "project/06_review/useful-private-v2-work/visual.mp4",
  "project/06_review/useful-private-v2-qa.json",
  "project/06_review/useful-private-v2-representative-frames/frame-000000.png",
  "project/06_review/useful-private-v2-representative-frames/frame-001350.png",
  "project/06_review/useful-private-v2-representative-frames/frame-002699.png",
  "logs/private-render-v2-render.stdout.log",
  "logs/private-render-v2-render.stderr.log",
  "logs/private-render-v2-qa.stdout.log",
  "logs/private-render-v2-qa.stderr.log",
] as const;

const RECEIPT_RELATIVE_PATH = "evidence/private-render-v2.json";
const FULL_PERSISTENT_ALLOWLIST = [...EVAL01_OUTPUT_HASH_ORDER, RECEIPT_RELATIVE_PATH];
const EXIT_STAGE_ORDER = [
  "pre_render_project_schema",
  "render",
  "post_render_targeted_media_qa",
  "receipt_publication",
] as const;

type JsonRecord = Record<string, unknown>;

export interface ExactInputBinding {
  id: string;
  path: string;
  bytes: number;
  sha256: string;
}

export interface VerifiedInputHash extends ExactInputBinding {
  verified_before: boolean;
  verified_after: boolean;
}

export interface BoundRange {
  in: number;
  out: number;
}

export interface RendererInvocationResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  signal: string | null;
  mocked?: boolean;
  skipped?: boolean;
}

export interface Eval01QaEvidence {
  createdAt: string;
  videoPath: string;
  captionPlanSha256: string;
  provenanceSha256: string;
  cueCount: number;
  burnedCaptionCount: number;
  rawAsrOverlapCount: number;
  displaySourceOverlapCount: number;
  displayTimelineOverlapCount: number;
  maxLinesObserved: number;
  safeAreaPass: boolean;
  captionStyleFailures: string[];
  captionFontFamily: string;
  captionFontSha256: string;
  audioStreamPresent: boolean;
  audioPreset: string;
  beforeIntegratedLufs: number;
  beforeTruePeakDbtp: number;
  afterIntegratedLufs: number;
  afterTruePeakDbtp: number;
  targetIntegratedLufs: number;
  audioMixPolicyValid: boolean;
  fullDecode: boolean;
  width: number;
  height: number;
  fpsNum: number;
  fpsDen: number;
  frameCount: number;
  durationMs: number;
  audioDurationMs: number;
  avStartDeltaMs: number;
  avEndDeltaMs: number;
  representativeFrames: Array<{ frame: number; path: string; sha256: string }>;
  assemblyTimingValid: boolean;
}

export interface ClosedQaReport {
  schema_version: "eval01-private-render-qa/v1";
  status: "PASS" | "NONPASS_STOP";
  created_at: string;
  source: {
    video_path: string;
    caption_plan_sha256: string;
    provenance_sha256: string;
  };
  caption: {
    cue_count: number;
    burned_caption_count: number;
    raw_asr_overlap_count: number;
    display_source_overlap_count: number;
    display_timeline_overlap_count: number;
    max_lines_observed: number;
    safe_area_pass: boolean;
    caption_font_family: string;
    caption_font_sha256: string;
  };
  audio: {
    stream_present: boolean;
    preset: string;
    before_measurement: { integrated_lufs: number; true_peak_dbtp: number };
    after_measurement: { integrated_lufs: number; true_peak_dbtp: number };
    target_integrated_lufs: number;
    audio_mix_policy_valid: boolean;
  };
  decode: {
    full_decode: boolean;
    width: number;
    height: number;
    fps_num: number;
    fps_den: number;
    frame_count: number;
    duration_ms: number;
    audio_duration_ms: number;
    av_start_delta_ms: number;
    av_end_delta_ms: number;
    representative_frames: Array<{ frame: number; path: string; sha256: string }>;
  };
  assembly_timing_valid: boolean;
  failures: string[];
  body_sha256: string;
}

interface NonpassQaReport {
  schema_version: "eval01-private-render-qa/v1";
  status: "NONPASS_STOP";
  created_at: string;
  source: {
    video_path: string;
    caption_plan_sha256: string | null;
    provenance_sha256: string | null;
  };
  caption: null;
  audio: null;
  decode: null;
  assembly_timing_valid: false;
  failures: string[];
  body_sha256: string;
}

type AnyClosedQaReport = ClosedQaReport | NonpassQaReport;

interface ReceiptAuthority {
  base_plan_sha256: string;
  overlay_sha256: string;
  pcl_task_id: string;
  pcl_evidence_id: string;
  human_render_ask_id: string;
  human_render_decision_sha256: string;
}

interface InvocationRecord {
  cwd: string;
  executable: string;
  argv: string[];
  env: Record<string, string>;
  started_at: string;
  ended_at: string;
  timed_out: boolean;
  signal: string | null;
  retry_count: 0;
  workaround_count: 0;
}

interface SymlinkProof {
  pre: { path: string; state: "absent" | "present" };
  during: {
    path: string;
    lstat_type: "symlink";
    mode_octal: string;
    nlink: number;
    readlink_target: string;
    realpath_target: string;
    tsx_cli_sha256: string;
  } | null;
  post: { path: string; state: "absent" | "present" };
}

type ExitStage = typeof EXIT_STAGE_ORDER[number];
interface ExitRecord {
  stage: ExitStage;
  invoked: boolean;
  exit_code: number | null;
  not_invoked_reason: string | null;
}

interface OutputHashEntry {
  path: string;
  state: "present" | "absent";
  regular_file: boolean | null;
  bytes: number | null;
  sha256: string | null;
  mode_octal: string | null;
  nlink: number | null;
}

export interface Eval01ReceiptEvidence {
  status: "PASS" | "NONPASS_STOP";
  createdAt: string;
  authority: ReceiptAuthority;
  invocationCount?: number;
  invocation: InvocationRecord;
  inputHashes: VerifiedInputHash[];
  symlinkProof: SymlinkProof;
  exitRecords: ExitRecord[];
  outputHashes: OutputHashEntry[];
  qa: AnyClosedQaReport | null;
  outsideOwnedChanges: string[];
  failureReasons: string[];
}

export interface ClosedReceipt {
  schema_version: "eval01-private-render-receipt/v2";
  status: "PASS" | "NONPASS_STOP";
  created_at: string;
  authority: ReceiptAuthority;
  invocation_count: number;
  invocation: InvocationRecord;
  input_hashes: VerifiedInputHash[];
  symlink_proof: SymlinkProof;
  privacy: {
    visibility: "private";
    network_call_count: 0;
    external_write_count: 0;
    source_upload_count: 0;
    public_share_count: 0;
    git_command_count: 0;
    pcl_mutation_count: 0;
    dashboard_read_or_render_count: 0;
  };
  exit_records: ExitRecord[];
  output_hashes: OutputHashEntry[];
  metrics: {
    caption: ClosedQaReport["caption"] | null;
    audio: ClosedQaReport["audio"] | null;
    decode: ClosedQaReport["decode"] | null;
  };
  nonpass_stop: {
    active: boolean;
    failure_reasons: string[];
    retry_allowed: false;
    success_claimed: boolean;
  };
  self_check: {
    schema_closed_valid: boolean;
    hash_order_valid: boolean;
    owned_paths_valid: boolean;
    pass_equivalence_valid: boolean;
    domain_separated_body_sha256: string;
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readJson(filePath: string): JsonRecord {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error(`json_object_required:${filePath}`);
  return parsed;
}

function sha256Bytes(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(filePath: string): string {
  return sha256Bytes(fs.readFileSync(filePath));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value).sort((left, right) => left.localeCompare(right, "en"))
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function withoutPath(value: unknown, dottedPath: string): unknown {
  const clone = JSON.parse(JSON.stringify(value)) as unknown;
  const keys = dottedPath.split(".");
  let cursor: unknown = clone;
  for (const key of keys.slice(0, -1)) {
    if (!isRecord(cursor)) return clone;
    cursor = cursor[key];
  }
  if (isRecord(cursor)) delete cursor[keys.at(-1)!];
  return clone;
}

export function domainSeparatedBodyHash(
  domain: string,
  value: unknown,
  excludedPath: string,
): string {
  const canonicalBody = JSON.stringify(stableValue(withoutPath(value, excludedPath)));
  return sha256Bytes(`${domain}\0${canonicalBody}`);
}

export interface ParsedAssDefaultStyle {
  fontName: string;
  fontSize: number;
  borderStyle: number;
  outline: number;
  marginV: number;
  playResX: number;
  playResY: number;
}

export interface AssCaptionStyleEvaluation {
  pass: boolean;
  failures: string[];
  actual: ParsedAssDefaultStyle | null;
  expected: AssSubtitleStyleOptions | null;
}

function numericStyleValue(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseAssDefaultStyle(ass: string): ParsedAssDefaultStyle | null {
  const playResX = Number.parseInt(ass.match(/^PlayResX:\s*(\d+)\s*$/m)?.[1] ?? "", 10);
  const playResY = Number.parseInt(ass.match(/^PlayResY:\s*(\d+)\s*$/m)?.[1] ?? "", 10);
  const styleLine = ass.split(/\r?\n/).find((line) => line.startsWith("Style: Default,"));
  if (!styleLine || !Number.isFinite(playResX) || !Number.isFinite(playResY)) return null;
  const fields = styleLine.slice("Style: ".length).split(",");
  // Name, Fontname, Fontsize, Primary, Secondary, OutlineColour, BackColour,
  // Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle,
  // BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
  if (fields.length < 23) return null;
  const fontSize = numericStyleValue(fields[2]);
  const borderStyle = numericStyleValue(fields[15]);
  const outline = numericStyleValue(fields[16]);
  const marginV = numericStyleValue(fields[21]);
  if (
    !fields[1]
    || fontSize === null
    || borderStyle === null
    || outline === null
    || marginV === null
  ) return null;
  return {
    fontName: fields[1],
    fontSize,
    borderStyle,
    outline,
    marginV,
    playResX,
    playResY,
  };
}

export function evaluateAssCaptionStyle(args: {
  ass: string;
  stylingClass?: string;
  width: number;
  height: number;
  requireExplicitStyle?: boolean;
}): AssCaptionStyleEvaluation {
  const failures: string[] = [];
  const explicit = Boolean(args.stylingClass && hasCaptionStylePreset(args.stylingClass));
  if (args.requireExplicitStyle && !explicit) {
    return { pass: false, failures: ["caption_style_unresolved"], actual: parseAssDefaultStyle(args.ass), expected: null };
  }
  const expected = resolveSocialReviewCaptionStyle(args.stylingClass, args.width, args.height);
  const actual = parseAssDefaultStyle(args.ass);
  if (!actual) {
    return { pass: false, failures: ["caption_style_unparsed"], actual: null, expected };
  }
  if (actual.fontName !== expected.fontName) failures.push("caption_style_font_family");
  if (actual.fontSize !== expected.fontSize) failures.push("caption_style_font_size");
  if (actual.outline !== expected.outline) failures.push("caption_style_outline");
  if (actual.borderStyle !== expected.borderStyle) failures.push("caption_style_border");
  if (actual.marginV !== expected.marginV) failures.push("caption_style_margin_v");
  if (actual.playResX !== args.width || actual.playResY !== args.height) {
    failures.push("caption_style_play_res");
  }
  return { pass: failures.length === 0, failures, actual, expected };
}

export function countBoundOverlaps(bounds: BoundRange[]): number {
  const sorted = [...bounds].sort((left, right) => left.in - right.in || left.out - right.out);
  let overlaps = 0;
  for (let left = 0; left < sorted.length; left += 1) {
    for (let right = left + 1; right < sorted.length; right += 1) {
      if (sorted[right].in >= sorted[left].out) break;
      if (sorted[right].out > sorted[left].in) overlaps += 1;
    }
  }
  return overlaps;
}

function inspectInputBindings(bindings: ExactInputBinding[]): VerifiedInputHash[] {
  return bindings.map((binding) => {
    let actualBytes = -1;
    let actualSha = "";
    try {
      const stat = fs.statSync(binding.path);
      if (!stat.isFile()) throw new Error("not_regular");
      actualBytes = stat.size;
      actualSha = sha256File(binding.path);
    } catch {
      // The false verification flags retain the fixed expected binding without
      // inventing an observed hash for a missing or non-regular input.
    }
    const verified = actualBytes === binding.bytes && actualSha === binding.sha256;
    return { ...binding, verified_before: verified, verified_after: false };
  });
}

export function validateExactInputBindings(bindings: ExactInputBinding[]): VerifiedInputHash[] {
  const inspected = inspectInputBindings(bindings);
  const mismatch = inspected.find((entry) => !entry.verified_before);
  if (mismatch) throw new Error(`input_hash_drift:${mismatch.id}`);
  return inspected;
}

export async function invokeRendererExactlyOnce(
  invoke: () => Promise<RendererInvocationResult>,
): Promise<RendererInvocationResult> {
  const result = await invoke();
  if (result.mocked) throw new Error("mock_render_forbidden");
  if (result.skipped) throw new Error("skip_render_forbidden");
  return result;
}

function qaFailureReasons(evidence: Eval01QaEvidence): string[] {
  const failures: string[] = [];
  const requireValue = (condition: boolean, name: string): void => {
    if (!condition) failures.push(name);
  };
  requireValue(evidence.cueCount === 21, "cue_count");
  requireValue(evidence.burnedCaptionCount === 21, "burned_caption_count");
  requireValue(evidence.rawAsrOverlapCount === 3, "raw_asr_overlap_count");
  requireValue(evidence.displaySourceOverlapCount === 0, "display_source_overlap_count");
  requireValue(evidence.displayTimelineOverlapCount === 0, "display_timeline_overlap_count");
  requireValue(evidence.maxLinesObserved <= 2, "max_lines_observed");
  if (evidence.captionStyleFailures.length > 0) {
    failures.push(...evidence.captionStyleFailures);
  }
  requireValue(evidence.safeAreaPass, "safe_area_pass");
  requireValue(Boolean(evidence.captionFontFamily), "caption_font_family");
  requireValue(SHA256.test(evidence.captionFontSha256), "caption_font_sha256");
  requireValue(evidence.audioStreamPresent, "audio_stream_present");
  requireValue(evidence.audioPreset === "dialogue-clean", "audio_preset");
  requireValue(Number.isFinite(evidence.beforeIntegratedLufs), "before_measurement_present");
  requireValue(Number.isFinite(evidence.beforeTruePeakDbtp), "before_true_peak_present");
  requireValue(evidence.afterIntegratedLufs >= -17 && evidence.afterIntegratedLufs <= -15, "after_integrated_lufs");
  requireValue(evidence.afterTruePeakDbtp <= -1.2, "after_true_peak_dbtp");
  requireValue(evidence.targetIntegratedLufs === -16, "target_integrated_lufs");
  requireValue(evidence.audioMixPolicyValid, "audio_mix_policy_valid");
  requireValue(evidence.fullDecode, "full_decode");
  requireValue(evidence.width === 1920 && evidence.height === 1080, "dimensions");
  requireValue(evidence.fpsNum === 30 && evidence.fpsDen === 1, "fps");
  requireValue(evidence.frameCount === 2700, "frame_count");
  requireValue(evidence.durationMs === 90_000, "duration_ms");
  requireValue(evidence.avStartDeltaMs < 100, "av_start_delta_ms");
  requireValue(evidence.avEndDeltaMs < 100, "av_end_delta_ms");
  requireValue(evidence.representativeFrames.length === 3, "representative_frame_count");
  requireValue(
    evidence.representativeFrames.map((entry) => entry.frame).join(",") === "0,1350,2699" &&
      evidence.representativeFrames.every((entry) => SHA256.test(entry.sha256)),
    "representative_frames",
  );
  requireValue(evidence.assemblyTimingValid, "assembly_timing_valid");
  return failures;
}

export function buildClosedQaReport(evidence: Eval01QaEvidence): ClosedQaReport {
  const failures = qaFailureReasons(evidence);
  if (failures.length > 0) throw new Error(`targeted_qa_failed:${failures.join(",")}`);
  const report: ClosedQaReport = {
    schema_version: "eval01-private-render-qa/v1",
    status: "PASS",
    created_at: evidence.createdAt,
    source: {
      video_path: evidence.videoPath,
      caption_plan_sha256: evidence.captionPlanSha256,
      provenance_sha256: evidence.provenanceSha256,
    },
    caption: {
      cue_count: evidence.cueCount,
      burned_caption_count: evidence.burnedCaptionCount,
      raw_asr_overlap_count: evidence.rawAsrOverlapCount,
      display_source_overlap_count: evidence.displaySourceOverlapCount,
      display_timeline_overlap_count: evidence.displayTimelineOverlapCount,
      max_lines_observed: evidence.maxLinesObserved,
      safe_area_pass: evidence.safeAreaPass,
      caption_font_family: evidence.captionFontFamily,
      caption_font_sha256: evidence.captionFontSha256,
    },
    audio: {
      stream_present: evidence.audioStreamPresent,
      preset: evidence.audioPreset,
      before_measurement: {
        integrated_lufs: evidence.beforeIntegratedLufs,
        true_peak_dbtp: evidence.beforeTruePeakDbtp,
      },
      after_measurement: {
        integrated_lufs: evidence.afterIntegratedLufs,
        true_peak_dbtp: evidence.afterTruePeakDbtp,
      },
      target_integrated_lufs: evidence.targetIntegratedLufs,
      audio_mix_policy_valid: evidence.audioMixPolicyValid,
    },
    decode: {
      full_decode: evidence.fullDecode,
      width: evidence.width,
      height: evidence.height,
      fps_num: evidence.fpsNum,
      fps_den: evidence.fpsDen,
      frame_count: evidence.frameCount,
      duration_ms: evidence.durationMs,
      audio_duration_ms: evidence.audioDurationMs,
      av_start_delta_ms: evidence.avStartDeltaMs,
      av_end_delta_ms: evidence.avEndDeltaMs,
      representative_frames: evidence.representativeFrames,
    },
    assembly_timing_valid: evidence.assemblyTimingValid,
    failures: [],
    body_sha256: "",
  };
  report.body_sha256 = domainSeparatedBodyHash(QA_DOMAIN, report, "body_sha256");
  return report;
}

function buildNonpassQaReport(
  createdAt: string,
  videoPath: string,
  captionPlanSha256: string | null,
  provenanceSha256: string | null,
  failures: string[],
): NonpassQaReport {
  const report: NonpassQaReport = {
    schema_version: "eval01-private-render-qa/v1",
    status: "NONPASS_STOP",
    created_at: createdAt,
    source: { video_path: videoPath, caption_plan_sha256: captionPlanSha256, provenance_sha256: provenanceSha256 },
    caption: null,
    audio: null,
    decode: null,
    assembly_timing_valid: false,
    failures: failures.length > 0 ? [...new Set(failures)] : ["qa_not_completed"],
    body_sha256: "",
  };
  report.body_sha256 = domainSeparatedBodyHash(QA_DOMAIN, report, "body_sha256");
  return report;
}

function hashOrderValid(entries: OutputHashEntry[]): boolean {
  return entries.map((entry) => entry.path).join("\0") === EVAL01_OUTPUT_HASH_ORDER.join("\0");
}

function receiptPassFailures(evidence: Eval01ReceiptEvidence, invocationCount: number): string[] {
  const failures = [...evidence.failureReasons];
  if (invocationCount !== 1) failures.push("invocation_count");
  if (evidence.invocation.retry_count !== 0) failures.push("retry_count");
  if (evidence.invocation.workaround_count !== 0) failures.push("workaround_count");
  if (evidence.invocation.timed_out) failures.push("timeout");
  if (evidence.invocation.signal !== null) failures.push("signal");
  if (evidence.exitRecords.length !== EXIT_STAGE_ORDER.length ||
    evidence.exitRecords.some((entry, index) =>
      entry.stage !== EXIT_STAGE_ORDER[index] || !entry.invoked || entry.exit_code !== 0
    )) failures.push("exit_records");
  if (evidence.inputHashes.length !== REQUIRED_INPUT_ORDER.length ||
    evidence.inputHashes.some((entry, index) =>
      entry.id !== REQUIRED_INPUT_ORDER[index] || !entry.verified_before || !entry.verified_after
    )) failures.push("input_hashes");
  if (!hashOrderValid(evidence.outputHashes) || evidence.outputHashes.some((entry) =>
    entry.state !== "present" || entry.regular_file !== true || entry.bytes === null ||
    (!entry.path.includes(".log") && entry.bytes <= 0) || !entry.sha256 || entry.nlink !== 1
  )) failures.push("output_hashes");
  if (!evidence.qa || evidence.qa.status !== "PASS") failures.push("qa");
  if (evidence.symlinkProof.pre.state !== "absent" ||
    evidence.symlinkProof.during?.lstat_type !== "symlink" ||
    evidence.symlinkProof.post.state !== "absent") failures.push("symlink_proof");
  if (evidence.outsideOwnedChanges.length > 0) failures.push("outside_owned_change");
  return [...new Set(failures)];
}

export function buildClosedReceipt(evidence: Eval01ReceiptEvidence): ClosedReceipt {
  const invocationCount = evidence.invocationCount ??
    (evidence.exitRecords.find((entry) => entry.stage === "render")?.invoked ? 1 : 0);
  const passFailures = receiptPassFailures(evidence, invocationCount);
  const equivalentStatus = passFailures.length === 0 ? "PASS" : "NONPASS_STOP";
  if (evidence.status !== equivalentStatus) {
    throw new Error(`receipt_status_not_equivalent:${equivalentStatus}`);
  }
  const receipt: ClosedReceipt = {
    schema_version: "eval01-private-render-receipt/v2",
    status: evidence.status,
    created_at: evidence.createdAt,
    authority: evidence.authority,
    invocation_count: invocationCount,
    invocation: evidence.invocation,
    input_hashes: evidence.inputHashes,
    symlink_proof: evidence.symlinkProof,
    privacy: {
      visibility: "private",
      network_call_count: 0,
      external_write_count: 0,
      source_upload_count: 0,
      public_share_count: 0,
      git_command_count: 0,
      pcl_mutation_count: 0,
      dashboard_read_or_render_count: 0,
    },
    exit_records: evidence.exitRecords,
    output_hashes: evidence.outputHashes,
    metrics: {
      caption: evidence.qa?.status === "PASS" ? evidence.qa.caption : null,
      audio: evidence.qa?.status === "PASS" ? evidence.qa.audio : null,
      decode: evidence.qa?.status === "PASS" ? evidence.qa.decode : null,
    },
    nonpass_stop: {
      active: evidence.status === "NONPASS_STOP",
      failure_reasons: evidence.status === "NONPASS_STOP" ? passFailures : [],
      retry_allowed: false,
      success_claimed: evidence.status === "PASS",
    },
    self_check: {
      schema_closed_valid: true,
      hash_order_valid: hashOrderValid(evidence.outputHashes),
      owned_paths_valid: evidence.outsideOwnedChanges.length === 0,
      pass_equivalence_valid: true,
      domain_separated_body_sha256: "",
    },
  };
  receipt.self_check.domain_separated_body_sha256 = domainSeparatedBodyHash(
    RECEIPT_DOMAIN,
    receipt,
    "self_check.domain_separated_body_sha256",
  );
  return receipt;
}

export function validateJsonSchema(schemaPath: string, value: unknown): string[] {
  const Ajv2020 = require_("ajv/dist/2020") as new (options: Record<string, unknown>) => {
    compile(schema: object): ((input: unknown) => boolean) & {
      errors?: Array<{ instancePath?: string; message?: string }> | null;
    };
  };
  const schema = JSON.parse(fs.readFileSync(path.resolve(schemaPath), "utf8")) as object;
  const validate = new Ajv2020({ strict: false, allErrors: true }).compile(schema);
  if (validate(value)) return [];
  return (validate.errors ?? []).map((entry) =>
    `${entry.instancePath || "/"} ${entry.message ?? "schema validation failed"}`
  );
}

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function modeOctal(mode: number): string {
  return `0${(mode & 0o7777).toString(8).padStart(3, "0")}`;
}

function outputHashes(artifactRoot: string): OutputHashEntry[] {
  return EVAL01_OUTPUT_HASH_ORDER.map((relativePath) => {
    const filePath = path.join(artifactRoot, relativePath);
    try {
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile()) {
        return { path: relativePath, state: "present", regular_file: false, bytes: stat.size, sha256: null, mode_octal: modeOctal(stat.mode), nlink: stat.nlink };
      }
      return { path: relativePath, state: "present", regular_file: true, bytes: stat.size, sha256: sha256File(filePath), mode_octal: modeOctal(stat.mode), nlink: stat.nlink };
    } catch {
      return { path: relativePath, state: "absent", regular_file: null, bytes: null, sha256: null, mode_octal: null, nlink: null };
    }
  });
}

interface ExactProbe {
  width: number;
  height: number;
  fpsNum: number;
  fpsDen: number;
  frameCount: number;
  videoStartMs: number;
  audioStartMs: number;
  videoDurationMs: number;
  audioDurationMs: number;
}

function parseNumber(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value));
  if (!Number.isFinite(parsed)) throw new Error(`media_probe_missing:${label}`);
  return parsed;
}

function probeExactMedia(videoPath: string): ExactProbe {
  const result = spawnSync("ffprobe", [
    "-v", "error", "-count_frames", "-show_entries",
    "stream=codec_type,width,height,avg_frame_rate,nb_read_frames,start_time,duration:format=duration",
    "-of", "json", videoPath,
  ], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 60_000 });
  if (result.status !== 0 || result.error) {
    throw new Error(`exact_media_probe_failed:${result.stderr || result.error?.message || result.status}`);
  }
  const parsed = JSON.parse(result.stdout) as { streams?: JsonRecord[]; format?: JsonRecord };
  const video = parsed.streams?.find((stream) => stream.codec_type === "video");
  const audio = parsed.streams?.find((stream) => stream.codec_type === "audio");
  if (!video || !audio) throw new Error("media_stream_missing");
  const rate = String(video.avg_frame_rate ?? "").match(/^(\d+)\/(\d+)$/);
  if (!rate) throw new Error("media_probe_missing:rational_fps");
  return {
    width: parseNumber(video.width, "width"),
    height: parseNumber(video.height, "height"),
    fpsNum: Number.parseInt(rate[1], 10),
    fpsDen: Number.parseInt(rate[2], 10),
    frameCount: parseNumber(video.nb_read_frames, "frame_count"),
    videoStartMs: Math.round(parseNumber(video.start_time ?? 0, "video_start") * 1000),
    audioStartMs: Math.round(parseNumber(audio.start_time ?? 0, "audio_start") * 1000),
    videoDurationMs: Math.round(parseNumber(video.duration ?? parsed.format?.duration, "video_duration") * 1000),
    audioDurationMs: Math.round(parseNumber(audio.duration ?? parsed.format?.duration, "audio_duration") * 1000),
  };
}

function extractRepresentativeFrame(videoPath: string, frame: number, outputPath: string): void {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const result = spawnSync("ffmpeg", [
    "-hide_banner", "-nostdin", "-v", "error", "-n", "-i", videoPath,
    "-vf", `select=eq(n\\,${frame})`, "-vsync", "0", "-frames:v", "1", outputPath,
  ], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 120_000 });
  if (result.status !== 0 || result.error) {
    throw new Error(`representative_frame_failed:${frame}:${result.stderr || result.error?.message || result.status}`);
  }
  const stat = fs.statSync(outputPath);
  if (!stat.isFile() || stat.size === 0) throw new Error(`representative_frame_empty:${frame}`);
}

function numericMeasurement(value: unknown, label: string): number {
  const parsed = Number.parseFloat(String(value));
  if (!Number.isFinite(parsed)) throw new Error(`audio_measurement_missing:${label}`);
  return parsed;
}

interface TargetedQaArgs {
  artifactRoot: string;
  projectDir: string;
  captionPlanPath: string;
  provenancePath: string;
  createdAt: string;
}

export async function runTargetedQa(args: TargetedQaArgs): Promise<ClosedQaReport> {
  const videoPath = path.join(args.artifactRoot, "project/06_review/useful-private-v2.mp4");
  const qaPath = path.join(args.artifactRoot, "project/06_review/useful-private-v2-qa.json");
  const workDir = path.join(args.artifactRoot, "project/06_review/useful-private-v2-work");
  const report = readJson(path.join(workDir, "social-review-report.json"));
  const captionPlan = readJson(args.captionPlanPath);
  const provenance = readJson(args.provenancePath);
  const timelinePath = path.join(args.projectDir, "05_timeline/timeline.json");
  const timeline = readJson(timelinePath);
  const timing = readJson(path.join(args.projectDir, "05_timeline/video-assembly-timing.json"));
  const { normalizeCaptionPlan } = await import("./render-social-review.js");
  const normalized = normalizeCaptionPlan(captionPlan);
  const adapter = report.caption_adapter;
  if (!isRecord(adapter) || adapter.source_schema !== "private-caption-plan/v2" ||
    adapter.display_bounds_source !== "cues[].timeline_in_frame/timeline_out_frame" ||
    JSON.stringify(adapter.rendered_cues) !== JSON.stringify(normalized)) {
    throw new Error("v2_adapter_mismatch");
  }
  const rawBounds = Array.isArray(provenance.raw_word_bounds) ? provenance.raw_word_bounds : [];
  const cues = Array.isArray(captionPlan.cues) ? captionPlan.cues : [];
  const range = (value: unknown, inKey: string, outKey: string): BoundRange => {
    if (!isRecord(value)) throw new Error("caption_bound_invalid");
    return { in: parseNumber(value[inKey], inKey), out: parseNumber(value[outKey], outKey) };
  };
  const rawOverlap = countBoundOverlaps(rawBounds.map((value) => range(value, "source_in_us", "source_out_us")));
  const displaySourceOverlap = countBoundOverlaps(cues.map((value) => range(value, "source_in_us", "source_out_us")));
  const displayTimelineOverlap = countBoundOverlaps(cues.map((value) => range(value, "timeline_in_frame", "timeline_out_frame")));
  const ass = fs.readFileSync(path.join(workDir, "captions.ass"), "utf8");
  const burnedCaptionCount = ass.split(/\r?\n/).filter((line) => line.startsWith("Dialogue:")).length;
  const maxLines = Math.max(...normalized.map((cue) => cue.text.split(/\n|\\N/).length));
  const sequence = isRecord(timeline.sequence) ? timeline.sequence : {};
  const styleEval = evaluateAssCaptionStyle({
    ass,
    stylingClass: readProjectCaptionStylingClass(args.projectDir),
    width: parseNumber(sequence.width, "sequence.width"),
    height: parseNumber(sequence.height, "sequence.height"),
    requireExplicitStyle: true,
  });
  const safeAreaPass = styleEval.pass;
  const captionFont = report.caption_font;
  if (!isRecord(captionFont) || typeof captionFont.family !== "string" ||
    typeof captionFont.sha256 !== "string" || typeof captionFont.path !== "string" ||
    !ass.includes(captionFont.family) || sha256File(captionFont.path) !== captionFont.sha256) {
    throw new Error("caption_font_proof_invalid");
  }
  const timelineHash = sha256File(timelinePath);
  const assemblyTimingValid = timing.version === "1" && timing.timeline_hash === timelineHash &&
    Number(timing.fps) === 30 && Number(timing.assembly_duration_sec) === 90 && Array.isArray(timing.clips);
  const measurements: QaMeasurements = await measureQaMedia({
    videoPath,
    outputPath: qaPath,
    createdAt: args.createdAt,
    deterministicAllowedRanges: deriveDeterministicAllowedRanges(
      timeline as Parameters<typeof deriveDeterministicAllowedRanges>[0],
    ),
  });
  const exact = probeExactMedia(videoPath);
  const frames = [0, 1350, 2699].map((frame) => {
    const relativePath = `project/06_review/useful-private-v2-representative-frames/frame-${String(frame).padStart(6, "0")}.png`;
    const outputPath = path.join(args.artifactRoot, relativePath);
    extractRepresentativeFrame(videoPath, frame, outputPath);
    return { frame, path: relativePath, sha256: sha256File(outputPath) };
  });
  const audioFinish = report.audio_finish;
  if (!isRecord(audioFinish) || !isRecord(audioFinish.before) || !isRecord(audioFinish.after)) {
    throw new Error("audio_finish_receipt_missing");
  }
  const evidence: Eval01QaEvidence = {
    createdAt: args.createdAt,
    videoPath,
    captionPlanSha256: sha256File(args.captionPlanPath),
    provenanceSha256: sha256File(args.provenancePath),
    cueCount: normalized.length,
    burnedCaptionCount,
    rawAsrOverlapCount: rawOverlap,
    displaySourceOverlapCount: displaySourceOverlap,
    displayTimelineOverlapCount: displayTimelineOverlap,
    maxLinesObserved: maxLines,
    safeAreaPass,
    captionStyleFailures: styleEval.failures,
    captionFontFamily: String(captionFont.family),
    captionFontSha256: String(captionFont.sha256),
    audioStreamPresent: exact.audioDurationMs > 0,
    audioPreset: String(audioFinish.preset ?? ""),
    beforeIntegratedLufs: numericMeasurement(audioFinish.before.input_i, "before_integrated_lufs"),
    beforeTruePeakDbtp: numericMeasurement(audioFinish.before.input_tp, "before_true_peak_dbtp"),
    afterIntegratedLufs: measurements.loudness_integrated,
    afterTruePeakDbtp: measurements.loudness_true_peak,
    targetIntegratedLufs: Number(audioFinish.target_lufs),
    audioMixPolicyValid: Number(audioFinish.target_lufs) === -16 && Number(audioFinish.target_true_peak_dbtp) === -1.5,
    fullDecode: measurements.deterministic_output_qa?.status === "verified",
    width: exact.width,
    height: exact.height,
    fpsNum: exact.fpsNum,
    fpsDen: exact.fpsDen,
    frameCount: exact.frameCount,
    durationMs: exact.videoDurationMs,
    audioDurationMs: exact.audioDurationMs,
    avStartDeltaMs: Math.abs(exact.videoStartMs - exact.audioStartMs),
    avEndDeltaMs: Math.abs(
      exact.videoStartMs + exact.videoDurationMs - exact.audioStartMs - exact.audioDurationMs,
    ),
    representativeFrames: frames,
    assemblyTimingValid,
  };
  const closed = buildClosedQaReport(evidence);
  const schemaErrors = validateJsonSchema("schemas/eval01-private-render-qa.schema.json", closed);
  if (schemaErrors.length > 0) throw new Error(`qa_schema_invalid:${schemaErrors.join(";")}`);
  atomicWriteJson(qaPath, closed);
  return closed;
}

interface Eval01PrivateRenderArgs {
  overlayPath: string;
  overlaySha256: string;
  humanDecisionPath: string;
  humanDecisionSha256: string;
  projectDir: string;
  nodeModulesTarget: string;
  /** Isolated link path for tests. Production keeps repo-root node_modules. */
  nodeModulesPath?: string;
  /** Isolated snapshot root for tests. Production audits the real repo root. */
  repoAuditRoot?: string;
}

interface TreeSnapshotEntry { kind: "file" | "symlink"; identity: string }

function snapshotTree(root: string, excludedNames = new Set<string>()): Map<string, TreeSnapshotEntry> {
  const snapshot = new Map<string, TreeSnapshotEntry>();
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (excludedNames.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isSymbolicLink()) snapshot.set(relative, { kind: "symlink", identity: fs.readlinkSync(absolute) });
      else if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) snapshot.set(relative, { kind: "file", identity: sha256File(absolute) });
    }
  };
  visit(root);
  return snapshot;
}

function changedTreePaths(before: Map<string, TreeSnapshotEntry>, after: Map<string, TreeSnapshotEntry>): string[] {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((key) => JSON.stringify(before.get(key)) !== JSON.stringify(after.get(key)))
    .sort((left, right) => left.localeCompare(right, "en"));
}

function runChild(executable: string, argv: string[], cwd: string, env: Record<string, string>, timeout: number): RendererInvocationResult {
  const result = spawnSync(executable, argv, { cwd, env, encoding: "utf8", timeout, maxBuffer: 100 * 1024 * 1024 });
  return {
    exitCode: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    timedOut: Boolean(result.error && "code" in result.error && result.error.code === "ETIMEDOUT"),
    signal: result.signal,
  };
}

function assertExactStringArray(actual: unknown, expected: readonly string[], label: string): void {
  if (!Array.isArray(actual) || actual.some((value) => typeof value !== "string") || actual.join("\0") !== expected.join("\0")) {
    throw new Error(`${label}_mismatch`);
  }
}

function ensureAbsentOutputs(artifactRoot: string): void {
  for (const relativePath of FULL_PERSISTENT_ALLOWLIST) {
    const absolute = path.join(artifactRoot, relativePath);
    if (fs.lstatSync(absolute, { throwIfNoEntry: false })) {
      throw new Error(`render_output_preexists:${relativePath}`);
    }
    let ancestor = path.dirname(absolute);
    while (ancestor.startsWith(`${artifactRoot}${path.sep}`)) {
      const stat = fs.lstatSync(ancestor, { throwIfNoEntry: false });
      if (stat?.isSymbolicLink()) throw new Error(`render_output_ancestor_symlink:${relativePath}`);
      ancestor = path.dirname(ancestor);
    }
  }
}

function parseArgs(argv: string[]): Eval01PrivateRenderArgs {
  const values = argv.slice(2);
  const found = new Map<string, string>();
  const allowed = new Set(["--overlay", "--overlay-sha256", "--human-decision", "--human-decision-sha256", "--project", "--node-modules-target"]);
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!allowed.has(flag) || !value || value.startsWith("--")) throw new Error(`invalid_argument:${flag ?? "missing"}`);
    found.set(flag, value);
  }
  for (const flag of allowed) if (!found.has(flag)) throw new Error(`missing_argument:${flag}`);
  return {
    overlayPath: path.resolve(found.get("--overlay")!),
    overlaySha256: found.get("--overlay-sha256")!,
    humanDecisionPath: path.resolve(found.get("--human-decision")!),
    humanDecisionSha256: found.get("--human-decision-sha256")!,
    projectDir: path.resolve(found.get("--project")!),
    nodeModulesTarget: path.resolve(found.get("--node-modules-target")!),
  };
}

function notInvoked(stage: ExitStage, reason = "prior_stage_failed"): ExitRecord {
  return { stage, invoked: false, exit_code: null, not_invoked_reason: reason };
}

export async function runEval01PrivateRender(args: Eval01PrivateRenderArgs): Promise<ClosedReceipt> {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  if (path.basename(args.projectDir) !== "project") throw new Error("project_path_must_end_in_project");
  const artifactRoot = path.dirname(args.projectDir);
  const nodeModulesPath = args.nodeModulesPath ?? path.join(repoRoot, "node_modules");
  const repoAuditRoot = args.repoAuditRoot ?? repoRoot;
  const renderStdout = path.join(artifactRoot, "logs/private-render-v2-render.stdout.log");
  const renderStderr = path.join(artifactRoot, "logs/private-render-v2-render.stderr.log");
  const qaStdout = path.join(artifactRoot, "logs/private-render-v2-qa.stdout.log");
  const qaStderr = path.join(artifactRoot, "logs/private-render-v2-qa.stderr.log");
  const receiptPath = path.join(artifactRoot, RECEIPT_RELATIVE_PATH);
  const overlay = readJson(args.overlayPath);
  const decision = readJson(args.humanDecisionPath);
  const createdAt = new Date().toISOString();
  const failures: string[] = [];
  let qa: AnyClosedQaReport | null = null;
  let invocationCount = 0;
  let inputHashes: VerifiedInputHash[] = [];
  let artifactBefore = new Map<string, TreeSnapshotEntry>();
  let repoBefore = new Map<string, TreeSnapshotEntry>();
  let symlinkCreated = false;
  const symlinkProof: SymlinkProof = {
    pre: { path: nodeModulesPath, state: fs.lstatSync(nodeModulesPath, { throwIfNoEntry: false }) ? "present" : "absent" },
    during: null,
    post: { path: nodeModulesPath, state: "present" },
  };
  const exitRecords: ExitRecord[] = EXIT_STAGE_ORDER.map((stage) => notInvoked(stage));
  const emptyInvocation: InvocationRecord = {
    cwd: repoRoot, executable: process.execPath, argv: [], env: {}, started_at: createdAt, ended_at: createdAt,
    timed_out: false, signal: null, retry_count: 0, workaround_count: 0,
  };
  let invocation = emptyInvocation;
  let authority: ReceiptAuthority = {
    base_plan_sha256: "0".repeat(64), overlay_sha256: args.overlaySha256,
    pcl_task_id: String(isRecord(overlay.authority) ? overlay.authority.pcl_task_id ?? "" : ""),
    pcl_evidence_id: String(isRecord(overlay.authority) ? overlay.authority.pcl_evidence_id ?? "" : ""),
    human_render_ask_id: String(decision.ask_id ?? ""), human_render_decision_sha256: args.humanDecisionSha256,
  };

  try {
    if (!SHA256.test(args.overlaySha256) || sha256File(args.overlayPath) !== args.overlaySha256) throw new Error("overlay_hash_drift");
    if (!SHA256.test(args.humanDecisionSha256) || sha256File(args.humanDecisionPath) !== args.humanDecisionSha256) throw new Error("human_decision_hash_drift");
    if (decision.schema_version !== "eval01-private-render-decision/v1" || decision.status !== "APPROVED" ||
      decision.overlay_sha256 !== args.overlaySha256 || decision.invocation_count !== 1 ||
      decision.retry_count !== 0 || decision.workaround_count !== 0) throw new Error("human_exact1_decision_invalid");
    const renderGate = isRecord(overlay.human_gates) && isRecord(overlay.human_gates.render_exact1)
      ? overlay.human_gates.render_exact1 : null;
    if (!renderGate || !["satisfied", "approved"].includes(String(renderGate.status))) throw new Error("overlay_render_gate_unsatisfied");
    const owned = isRecord(overlay.owned_paths) && isRecord(overlay.owned_paths.later_render_exact_allowlist)
      ? overlay.owned_paths.later_render_exact_allowlist : null;
    assertExactStringArray(owned?.files_in_hash_order, FULL_PERSISTENT_ALLOWLIST, "overlay_allowlist");
    assertExactStringArray(decision.persistent_allowlist, FULL_PERSISTENT_ALLOWLIST, "decision_allowlist");
    if (symlinkProof.pre.state !== "absent") throw new Error("node_modules_prestate_not_absent");
    const targetStat = fs.lstatSync(args.nodeModulesTarget);
    if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) throw new Error("node_modules_target_not_real_directory");
    const dependency = isRecord(decision.dependency) ? decision.dependency : null;
    const targetParent = path.dirname(args.nodeModulesTarget);
    const packageJson = path.join(targetParent, "package.json");
    const packageLock = path.join(targetParent, "package-lock.json");
    const tsxCli = path.join(args.nodeModulesTarget, "tsx/dist/cli.mjs");
    if (!dependency || dependency.node_modules_target !== args.nodeModulesTarget ||
      dependency.package_json_sha256 !== sha256File(packageJson) ||
      dependency.package_lock_sha256 !== sha256File(packageLock) ||
      dependency.tsx_cli_sha256 !== sha256File(tsxCli)) throw new Error("dependency_identity_mismatch");
    ensureAbsentOutputs(artifactRoot);
    artifactBefore = snapshotTree(artifactRoot);
    repoBefore = snapshotTree(repoAuditRoot, new Set([".git", "node_modules"]));
    const overlayInputs = Array.isArray(overlay.current_input_bindings)
      ? overlay.current_input_bindings as unknown[] : [];
    if (overlayInputs.length !== 7) throw new Error("overlay_input_bindings_invalid");
    const bindings: ExactInputBinding[] = overlayInputs.map((value) => {
      if (!isRecord(value)) throw new Error("overlay_input_binding_invalid");
      return { id: String(value.id), path: String(value.path), bytes: Number(value.bytes), sha256: String(value.sha256) };
    });
    bindings.push(
      { id: "render_social_review_source", path: path.join(repoRoot, "scripts/render-social-review.ts"), bytes: fs.statSync(path.join(repoRoot, "scripts/render-social-review.ts")).size, sha256: sha256File(path.join(repoRoot, "scripts/render-social-review.ts")) },
      { id: "render_rough_cut_source", path: path.join(repoRoot, "scripts/render-rough-cut.ts"), bytes: fs.statSync(path.join(repoRoot, "scripts/render-rough-cut.ts")).size, sha256: sha256File(path.join(repoRoot, "scripts/render-rough-cut.ts")) },
      { id: "future_v2_native_runner_source", path: path.join(repoRoot, "scripts/eval01-private-render.ts"), bytes: fs.statSync(path.join(repoRoot, "scripts/eval01-private-render.ts")).size, sha256: sha256File(path.join(repoRoot, "scripts/eval01-private-render.ts")) },
    );
    assertExactStringArray(bindings.map((entry) => entry.id), REQUIRED_INPUT_ORDER, "input_hash_order");
    const decisionHashes = isRecord(decision.input_hashes) ? decision.input_hashes : null;
    if (!decisionHashes || bindings.some((entry) => decisionHashes[entry.id] !== entry.sha256)) throw new Error("decision_input_hashes_mismatch");
    inputHashes = validateExactInputBindings(bindings);
    authority = {
      ...authority,
      base_plan_sha256: bindings[0].sha256,
    };
    fs.symlinkSync(args.nodeModulesTarget, nodeModulesPath);
    symlinkCreated = true;
    const linkStat = fs.lstatSync(nodeModulesPath);
    symlinkProof.during = {
      path: nodeModulesPath, lstat_type: "symlink", mode_octal: modeOctal(linkStat.mode), nlink: linkStat.nlink,
      readlink_target: fs.readlinkSync(nodeModulesPath), realpath_target: fs.realpathSync(nodeModulesPath), tsx_cli_sha256: sha256File(path.join(nodeModulesPath, "tsx/dist/cli.mjs")),
    };
    const renderEnv = isRecord(decision.render_env)
      ? Object.fromEntries(Object.entries(decision.render_env).map(([key, value]) => [key, String(value)]))
      : null;
    if (!renderEnv || Object.keys(renderEnv).sort().join(",") !== "CI,NODE_ENV,NO_COLOR,PATH" ||
      renderEnv.CI !== "1" || renderEnv.NODE_ENV !== "production" || renderEnv.NO_COLOR !== "1") {
      throw new Error("render_env_invalid");
    }
    invocation = {
      ...invocation,
      env: {
        CI: renderEnv.CI,
        NODE_ENV: renderEnv.NODE_ENV,
        NO_COLOR: renderEnv.NO_COLOR,
        PATH: renderEnv.PATH,
      },
    };
    const schemaResult = runChild(process.execPath, [
      path.join(nodeModulesPath, "tsx/dist/cli.mjs"), "scripts/validate-schemas.ts", "--profile", "manual-render", args.projectDir,
    ], repoRoot, renderEnv, 120_000);
    exitRecords[0] = { stage: "pre_render_project_schema", invoked: true, exit_code: schemaResult.exitCode, not_invoked_reason: null };
    if (schemaResult.exitCode !== 0 || schemaResult.timedOut || schemaResult.signal) throw new Error("pre_render_schema_failed");
    const captionPlanPath = bindings.find((entry) => entry.id === "caption_plan_v2")!.path;
    const outputPath = path.join(artifactRoot, "project/06_review/useful-private-v2.mp4");
    const workDir = path.join(artifactRoot, "project/06_review/useful-private-v2-work");
    const argv = [
      path.join(nodeModulesPath, "tsx/dist/cli.mjs"), "scripts/render-social-review.ts",
      "--project", args.projectDir, "--captions", captionPlanPath, "--output", outputPath, "--work-dir", workDir,
    ];
    const startedAt = new Date().toISOString();
    const renderResult = await invokeRendererExactlyOnce(async () => runChild(process.execPath, argv, repoRoot, renderEnv, 30 * 60_000));
    invocationCount = 1;
    invocation = {
      cwd: repoRoot, executable: process.execPath, argv, env: renderEnv, started_at: startedAt,
      ended_at: new Date().toISOString(), timed_out: renderResult.timedOut, signal: renderResult.signal,
      retry_count: 0, workaround_count: 0,
    };
    fs.mkdirSync(path.dirname(renderStdout), { recursive: true });
    fs.writeFileSync(renderStdout, renderResult.stdout, { encoding: "utf8", mode: 0o600 });
    fs.writeFileSync(renderStderr, renderResult.stderr, { encoding: "utf8", mode: 0o600 });
    exitRecords[1] = { stage: "render", invoked: true, exit_code: renderResult.exitCode, not_invoked_reason: null };
    if (renderResult.exitCode !== 0 || renderResult.timedOut || renderResult.signal) throw new Error("render_failed");
    exitRecords[2] = { stage: "post_render_targeted_media_qa", invoked: true, exit_code: 1, not_invoked_reason: null };
    try {
      qa = await runTargetedQa({
        artifactRoot, projectDir: args.projectDir, captionPlanPath,
        provenancePath: bindings.find((entry) => entry.id === "caption_provenance_v2")!.path,
        createdAt: new Date().toISOString(),
      });
      fs.writeFileSync(qaStdout, `${JSON.stringify({ status: qa.status, body_sha256: qa.body_sha256 })}\n`, { encoding: "utf8", mode: 0o600 });
      fs.writeFileSync(qaStderr, "", { encoding: "utf8", mode: 0o600 });
      exitRecords[2] = { stage: "post_render_targeted_media_qa", invoked: true, exit_code: 0, not_invoked_reason: null };
    } catch (error) {
      fs.mkdirSync(path.dirname(qaStderr), { recursive: true });
      fs.writeFileSync(qaStdout, "", { encoding: "utf8", mode: 0o600 });
      fs.writeFileSync(qaStderr, `${error instanceof Error ? error.message : String(error)}\n`, { encoding: "utf8", mode: 0o600 });
      throw error;
    }
    const after = inspectInputBindings(bindings);
    const afterMismatch = after.find((entry) => !entry.verified_before);
    inputHashes = inputHashes.map((entry, index) => ({ ...entry, verified_after: after[index]?.verified_before ?? false }));
    if (afterMismatch) throw new Error(`input_hash_drift_after:${afterMismatch.id}`);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  } finally {
    if (symlinkCreated) fs.unlinkSync(nodeModulesPath);
    symlinkProof.post = {
      path: nodeModulesPath,
      state: fs.lstatSync(nodeModulesPath, { throwIfNoEntry: false }) ? "present" : "absent",
    };
  }

  fs.mkdirSync(path.dirname(renderStdout), { recursive: true });
  if (!fs.existsSync(renderStdout)) fs.writeFileSync(renderStdout, "", { encoding: "utf8", mode: 0o600 });
  if (!fs.existsSync(renderStderr)) fs.writeFileSync(renderStderr, "", { encoding: "utf8", mode: 0o600 });
  if (!fs.existsSync(qaStdout)) fs.writeFileSync(qaStdout, "", { encoding: "utf8", mode: 0o600 });
  if (!fs.existsSync(qaStderr)) fs.writeFileSync(qaStderr, `${failures.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  if (symlinkProof.post.state !== "absent") failures.push("symlink_residue");
  if (!qa) {
    qa = buildNonpassQaReport(
      new Date().toISOString(),
      path.join(artifactRoot, "project/06_review/useful-private-v2.mp4"),
      inputHashes.find((entry) => entry.id === "caption_plan_v2")?.sha256 ?? null,
      inputHashes.find((entry) => entry.id === "caption_provenance_v2")?.sha256 ?? null,
      failures,
    );
    const qaSchemaErrors = validateJsonSchema("schemas/eval01-private-render-qa.schema.json", qa);
    if (qaSchemaErrors.length > 0) throw new Error(`qa_schema_invalid:${qaSchemaErrors.join(";")}`);
    atomicWriteJson(path.join(artifactRoot, "project/06_review/useful-private-v2-qa.json"), qa);
  }
  const allowed = new Set(FULL_PERSISTENT_ALLOWLIST);
  const artifactAfter = snapshotTree(artifactRoot);
  const outsideArtifact = artifactBefore.size === 0 ? [] : changedTreePaths(artifactBefore, artifactAfter).filter((relative) => !allowed.has(relative));
  const repoAfter = snapshotTree(repoAuditRoot, new Set([".git", "node_modules"]));
  const outsideRepo = repoBefore.size === 0 ? [] : changedTreePaths(repoBefore, repoAfter).map((relative) => `repo:${relative}`);
  const outsideOwnedChanges = [...outsideArtifact, ...outsideRepo];
  if (outsideOwnedChanges.length > 0) failures.push("outside_owned_change");
  const hashes = outputHashes(artifactRoot);
  exitRecords[3] = { stage: "receipt_publication", invoked: true, exit_code: 0, not_invoked_reason: null };
  const prospective: Eval01ReceiptEvidence = {
    status: "NONPASS_STOP", createdAt: new Date().toISOString(), authority, invocationCount, invocation,
    inputHashes, symlinkProof, exitRecords, outputHashes: hashes, qa, outsideOwnedChanges,
    failureReasons: [...new Set(failures)],
  };
  const passFailures = receiptPassFailures(prospective, invocationCount);
  prospective.status = passFailures.length === 0 ? "PASS" : "NONPASS_STOP";
  const receipt = buildClosedReceipt(prospective);
  const receiptSchemaErrors = validateJsonSchema("schemas/eval01-private-render-receipt.schema.json", receipt);
  if (receiptSchemaErrors.length > 0) throw new Error(`receipt_schema_invalid:${receiptSchemaErrors.join(";")}`);
  atomicWriteJson(receiptPath, receipt);
  return receipt;
}

async function main(): Promise<void> {
  try {
    const receipt = await runEval01PrivateRender(parseArgs(process.argv));
    console.log(JSON.stringify(receipt, null, 2));
    if (receipt.status !== "PASS") process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isMain) void main();
