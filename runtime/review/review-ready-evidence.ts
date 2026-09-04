import type { RenderLayoutSnapshot } from "./deterministic-layout-qa.js";
import type { SocialReviewAudioReceipt } from "./social-review-audio.js";
import {
  canonicalJson,
  type SocialReviewGenerationReceipt,
} from "./social-review-generation.js";
import type { ReviewReadyInput } from "./review-ready-transaction.js";

type RecordValue = Record<string, unknown>;
type ReviewSample = ReviewReadyInput["framing"]["samples"][number];
type EvidenceLevel = "policy_only" | "platform_measured" | "human_verified";
type CaptionRange = { cueId: string | null; inFrame: number; outFrame: number };

export interface ReviewReadyEvidenceArtifacts {
  generationReceipt: SocialReviewGenerationReceipt;
  audioReceipt: SocialReviewAudioReceipt;
  layoutSnapshot: RenderLayoutSnapshot;
  captionPlan: { cues?: unknown[] };
  sampleSheet: unknown;
  framingPolicy: RecordValue;
  captionPolicy: RecordValue;
  verticalCompositionPolicy: RecordValue;
  deliveryPlatform: string;
  renderAudioPresent: boolean;
  renderGapFree: boolean;
}

export interface DerivedReviewReadyEvidence {
  gaps: ReviewReadyInput["gaps"];
  framing: {
    coverage: ReviewReadyInput["framing"]["coverage"];
    evidence_level: EvidenceLevel;
    samples: ReviewSample[];
  };
  captions: Pick<ReviewReadyInput["captions"], "cue_count" | "display_range" | "safe_rect" | "collision_status" | "transcript_grounding" | "evidence_level" | "platform_safety_claims">;
  coverage: ReviewReadyInput["coverage"];
  findings: ReviewReadyInput["findings"];
}

function asRecord(value: unknown, label: string): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as RecordValue;
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
}

function integerValue(value: unknown, label: string): number {
  const number = numberValue(value, label);
  if (!Number.isInteger(number)) throw new Error(`${label} must be an integer`);
  return number;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

function normalizeSample(value: unknown, index: number): ReviewSample {
  const sample = asRecord(value, `bound framing sample ${index}`);
  const exactFields = ["clip_id", "timestamp_frame", "inspection_space", "measurement", "allowed_range", "status"];
  if (Object.keys(sample).sort().join("\0") !== exactFields.sort().join("\0")) {
    throw new Error(`bound framing sample ${index} must use the exact ReviewFramingSample fields`);
  }
  const measurement = asRecord(sample.measurement, `bound framing sample ${index} measurement`);
  if (Object.keys(measurement).some((key) => key !== "face_eye_line_ratio")) {
    throw new Error(`bound framing sample ${index} measurement contains an unrepresentable field`);
  }
  const allowedRange = asRecord(sample.allowed_range, `bound framing sample ${index} allowed range`);
  if (Object.keys(allowedRange).some((key) => key !== "min" && key !== "max")) {
    throw new Error(`bound framing sample ${index} allowed range contains an unrepresentable field`);
  }
  const status = sample.status;
  if (status !== "pass" && status !== "warning" && status !== "blocker") {
    throw new Error(`bound framing sample ${index} status is invalid`);
  }
  const normalized: ReviewSample = {
    clip_id: stringValue(sample.clip_id, `bound framing sample ${index} clip_id`),
    timestamp_frame: integerValue(sample.timestamp_frame, `bound framing sample ${index} timestamp_frame`),
    inspection_space: stringValue(sample.inspection_space, `bound framing sample ${index} inspection_space`) as ReviewSample["inspection_space"],
    measurement: { face_eye_line_ratio: measurement.face_eye_line_ratio === null
      ? null
      : numberValue(measurement.face_eye_line_ratio, `bound framing sample ${index} face/eye measurement`) },
    allowed_range: {
      min: numberValue(allowedRange.min, `bound framing sample ${index} allowed range min`),
      max: numberValue(allowedRange.max, `bound framing sample ${index} allowed range max`),
    },
    status,
  };
  if (normalized.inspection_space !== "source_frame" && normalized.inspection_space !== "delivery_crop") {
    throw new Error(`bound framing sample ${index} inspection space is invalid`);
  }
  if (normalized.allowed_range.min > normalized.allowed_range.max) {
    throw new Error(`bound framing sample ${index} allowed range is inverted`);
  }
  return normalized;
}

function deriveFramingSamples(sampleSheet: unknown): ReviewSample[] {
  const document = asRecord(sampleSheet, "bound sample sheet");
  if (!Array.isArray(document.samples)) throw new Error("bound sample sheet samples are missing");
  if (document.samples.length === 0) throw new Error("bound sample sheet must contain samples");
  return document.samples.map((sample, index) => normalizeSample(sample, index));
}

function scanGap(scan: unknown, issues: unknown[], kind: "black" | "freeze", label: string): { status: "pass" | "blocker"; count: number } {
  const record = asRecord(scan, `${label} scan`);
  if (record.status !== "complete") return { status: "blocker", count: 1 };
  const blockingIssues = issues.filter((issue) => asRecord(issue, `${label} QA issue`).kind === kind);
  return blockingIssues.length === 0
    ? { status: "pass", count: 0 }
    : { status: "blocker", count: blockingIssues.length };
}

function deriveGaps(artifacts: ReviewReadyEvidenceArtifacts): ReviewReadyInput["gaps"] {
  const output = artifacts.generationReceipt.qa.output as unknown as RecordValue;
  const issues = Array.isArray(output.issues) ? output.issues : [];
  if (output.status !== "verified" && output.status !== "blocked" && output.status !== "incomplete") {
    throw new Error("verified generation output QA status is invalid");
  }
  const scans = asRecord(output.scans, "output scans");
  const primaryIssues = issues.filter((issue) => {
    const kind = asRecord(issue, "primary video QA issue").kind;
    return kind === "decode" || kind === "dimensions" || kind === "inset";
  });
  const primaryScanStatuses = [scans.decode, scans.layout_inset].map((scan, index) => {
    const record = asRecord(scan, index === 0 ? "decode scan" : "layout inset scan");
    return record.status;
  });
  const primaryVideo = primaryScanStatuses.every((status) => status === "complete") && primaryIssues.length === 0
    ? { status: "pass" as const, count: 0 }
    : { status: "blocker" as const, count: Math.max(1, primaryIssues.length) };
  const freeze = scanGap(scans.freeze, issues, "freeze", "freeze");
  const black = scanGap(scans.black, issues, "black", "black");
  const audioState = artifacts.audioReceipt.review_video_audio.state;
  if ((audioState === "present") !== artifacts.renderAudioPresent) {
    throw new Error("render report audio presence differs from bound audio receipt state");
  }
  const audioStatus = artifacts.generationReceipt.qa.audio.status;
  const audio = audioStatus === "verified"
    ? { status: "pass" as const, count: 0 }
    : { status: "blocker" as const, count: 1 };
  const canonicalGapFree = output.status === "verified" && issues.length === 0;
  if (artifacts.renderGapFree !== canonicalGapFree) {
    throw new Error("render report gap_free differs from immutable generation QA scans/status");
  }
  return { primary_video: primaryVideo, audio, freeze, black };
}

function cueRange(value: unknown, index: number): CaptionRange {
  const cue = asRecord(value, `bound caption cue ${index}`);
  const inFrame = cue.timeline_in_frame ?? cue.in_frame;
  const outFrame = cue.timeline_out_frame ?? cue.out_frame;
  const explicitId = cue.cue_id ?? cue.caption_id;
  return {
    cueId: explicitId === undefined || explicitId === null
      ? null
      : stringValue(explicitId, `bound caption cue ${index} cue_id`),
    inFrame: integerValue(inFrame, `bound caption cue ${index} in frame`),
    outFrame: integerValue(outFrame, `bound caption cue ${index} out frame`),
  };
}

function canonicalCaptionRanges(cues: unknown[]): CaptionRange[] {
  const ranges = cues.map(cueRange).sort((left, right) =>
    left.inFrame - right.inFrame || left.outFrame - right.outFrame
  );
  return ranges;
}

function transcriptGrounding(cues: unknown[]): ReviewReadyInput["captions"]["transcript_grounding"] {
  let transcriptBound = 0;
  for (const [index, value] of cues.entries()) {
    const cue = asRecord(value, `bound caption cue ${index}`);
    if (cue.source === "transcript" && typeof cue.transcript_ref === "string"
      && cue.transcript_ref.length > 0 && Array.isArray(cue.transcript_item_ids)
      && cue.transcript_item_ids.length > 0) {
      transcriptBound += 1;
    }
  }
  if (transcriptBound === cues.length && cues.length > 0) return "verified";
  return transcriptBound > 0 ? "partial" : "unverified";
}

function normalizedSafeRect(snapshot: RenderLayoutSnapshot): ReviewReadyInput["captions"]["safe_rect"] {
  const frame = snapshot.frame;
  const safe = frame.safe_area;
  if (!Number.isInteger(frame.width) || frame.width <= 0 || !Number.isInteger(frame.height) || frame.height <= 0) {
    throw new Error("layout snapshot frame dimensions are invalid");
  }
  for (const [key, value] of Object.entries(safe)) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`layout snapshot safe area ${key} is invalid`);
  }
  if (safe.left + safe.right >= frame.width || safe.top + safe.bottom >= frame.height) {
    throw new Error("layout snapshot safe area leaves no caption rectangle");
  }
  return {
    x: rounded(safe.left / frame.width),
    y: rounded(safe.top / frame.height),
    width: rounded((frame.width - safe.left - safe.right) / frame.width),
    height: rounded((frame.height - safe.top - safe.bottom) / frame.height),
  };
}

function rectFromPolicy(value: unknown): ReviewReadyInput["captions"]["safe_rect"] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as RecordValue;
  const x = record.x;
  const y = record.y;
  const width = record.width;
  const height = record.height;
  if ([x, y, width, height].every((item) => typeof item === "number")) {
    return { x: rounded(x as number), y: rounded(y as number), width: rounded(width as number), height: rounded(height as number) };
  }
  return null;
}

function assertPolicySafeRect(snapshotRect: ReviewReadyInput["captions"]["safe_rect"], ...policies: RecordValue[]): void {
  for (const policy of policies) {
    const captionPolicy = policy.caption && typeof policy.caption === "object" && !Array.isArray(policy.caption)
      ? (policy.caption as RecordValue) : null;
    const candidate = rectFromPolicy(policy.safe_rect ?? policy.caption_safe_rect ?? captionPolicy?.safe_rect);
    if (candidate && canonicalJson(candidate) !== canonicalJson(snapshotRect)) {
      throw new Error("caption safe rectangle differs from bound layout evidence");
    }
  }
}

function isNamedPlatform(platform: string): boolean {
  return platform !== "generic" && platform !== "unknown" && platform !== "";
}

function profileEvidence(policy: RecordValue): "platform_measured" | "human_verified" | null {
  const candidates = [policy.platform_safe_zone_profile, policy.safe_zone_profile, policy.platform_safe_zone_profile_ref];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const record = candidate as RecordValue;
    if (record.evidence_status === "human_verified" || record.evidence_level === "human_verified" || record.status === "human_verified") return "human_verified";
    if (record.evidence_status === "verified" || record.evidence_level === "platform_measured" || record.status === "measured") return "platform_measured";
  }
  return null;
}

function evidenceLevel(artifacts: ReviewReadyEvidenceArtifacts): EvidenceLevel {
  const geometry = artifacts.verticalCompositionPolicy.platform_geometry;
  const profile = profileEvidence(artifacts.captionPolicy) ?? profileEvidence(artifacts.verticalCompositionPolicy);
  if (!isNamedPlatform(artifacts.deliveryPlatform) || !geometry || typeof geometry !== "object" || Array.isArray(geometry)) return "policy_only";
  const geometryRecord = geometry as RecordValue;
  if (geometryRecord.status !== "measured" || !profile) return "policy_only";
  if (profile === "human_verified" && geometryRecord.evidence_level === "human_verified") return "human_verified";
  if (profile === "platform_measured" && geometryRecord.evidence_level === "platform_measured") return "platform_measured";
  return "policy_only";
}

function captionCoverage(snapshot: RenderLayoutSnapshot, ranges: CaptionRange[]): "sampled" | "full_frame" {
  for (const range of ranges) {
    const intervalLayers = snapshot.layers.filter((candidate) => candidate.semantic_role === "speech_caption"
      && candidate.start_frame === range.inFrame
      && candidate.end_frame === range.outFrame);
    const matches = range.cueId === null
      ? intervalLayers
      : intervalLayers.filter((candidate) => candidate.layer_id === range.cueId);
    if (matches.length !== 1) {
      throw new Error(`caption cue ${range.cueId ?? "without ID"} is not bound to exactly one matching layout layer`);
    }
  }
  // A cue-to-layer match proves those cue intervals only. Sparse captions do
  // not become a full-frame observation merely because every cue matched.
  return ranges.length === 0 ? "full_frame" : "sampled";
}

function deriveFindings(
  gaps: ReviewReadyInput["gaps"],
  framing: DerivedReviewReadyEvidence["framing"],
  captions: DerivedReviewReadyEvidence["captions"],
  layout: SocialReviewGenerationReceipt["qa"]["layout"],
): ReviewReadyInput["findings"] {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const humanResidual: string[] = [];
  for (const [label, gap] of Object.entries(gaps)) {
    if (gap.status !== "pass" || gap.count !== 0) blockers.push(`${label} QA failed`);
  }
  for (const sample of framing.samples) {
    if (sample.status === "blocker") blockers.push(`framing sample ${sample.clip_id} blocked`);
    if (sample.status === "warning") warnings.push(`framing sample ${sample.clip_id} needs review`);
  }
  if (captions.collision_status !== "pass") blockers.push("caption collision QA failed");
  if (layout.status !== "verified" || layout.issues.length > 0) blockers.push("layout QA failed");
  for (const item of layout.review_items) {
    if (item.evidence_status === "human_hold") humanResidual.push(item.reason ?? item.code);
  }
  if (captions.evidence_level === "policy_only") warnings.push("platform geometry not measured");
  return {
    pass: blockers.length === 0 ? ["gap-free"] : [],
    warnings,
    blockers,
    human_residual: [...new Set(humanResidual)],
  };
}

export function buildReviewReadyEvidence(artifacts: ReviewReadyEvidenceArtifacts): DerivedReviewReadyEvidence {
  const sampleSheetSamples = deriveFramingSamples(artifacts.sampleSheet);
  const captionCues = artifacts.captionPlan.cues;
  if (!Array.isArray(captionCues)) throw new Error("bound caption plan cues are missing");
  const ranges = canonicalCaptionRanges(captionCues);
  const safeRect = normalizedSafeRect(artifacts.layoutSnapshot);
  assertPolicySafeRect(safeRect, artifacts.framingPolicy, artifacts.captionPolicy, artifacts.verticalCompositionPolicy);
  const level = evidenceLevel(artifacts);
  const gaps = deriveGaps(artifacts);
  const framing = { coverage: "sampled" as const, evidence_level: level, samples: sampleSheetSamples };
  const captions = {
    cue_count: captionCues.length,
    display_range: ranges.length === 0
      ? { first_frame: 0, last_frame: 0 }
      : { first_frame: Math.min(...ranges.map((range) => range.inFrame)), last_frame: Math.max(...ranges.map((range) => range.outFrame)) },
    safe_rect: safeRect,
    collision_status: artifacts.generationReceipt.qa.layout.status === "verified" && artifacts.generationReceipt.qa.layout.issues.length === 0 ? "pass" as const : "blocker" as const,
    transcript_grounding: transcriptGrounding(captionCues),
    evidence_level: level,
    platform_safety_claims: [],
  };
  const coverage = {
    video: gaps.primary_video.status === "pass" ? "full_frame" as const : "sampled" as const,
    audio: artifacts.generationReceipt.qa.audio.status === "verified" ? "full_frame" as const : "sampled" as const,
    framing: "sampled" as const,
    captions: captionCoverage(artifacts.layoutSnapshot, ranges),
  };
  const findings = deriveFindings(gaps, framing, captions, artifacts.generationReceipt.qa.layout);
  return { gaps, framing, captions, coverage, findings };
}
