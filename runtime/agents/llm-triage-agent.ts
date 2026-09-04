import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { atomicWriteJson, readJsonIfExists } from "../pipeline/stages/_util.js";
import {
  classifyTransportError,
  createEditorialStageDeadline,
  EditorialLlmError,
  type EditorialLlmErrorKind,
  type StageDeadline,
} from "../connectors/editorial-llm.js";
import {
  MARLIN_CAMERA_MOTION_CONFIDENCE_PENALTY,
  MARLIN_CAMERA_MOTION_START_FLAG,
  describesCameraSetupMotion,
} from "../analysis/camera-motion.js";
import { sanitizeStillCameraMotionIntent } from "../render/camera-motion.js";
import { classifyTranscriptQuality } from "../analysis/transcript-quality.js";
import { loadCreativeBrief } from "../artifacts/loaders.js";
import type { CreativeBrief, EditorialSummary } from "../artifacts/types.js";
import {
  assertProjectPlanningMediaKindsSupported,
  inferAudioRole,
  readAssetMediaCapabilities,
  type AssetMediaCapability,
} from "../artifacts/source-media-capabilities.js";
import type { GeminiInlineImageInput } from "../connectors/gemini-json.js";
import {
  completeEditorialJson,
  deterministicDecisionRuntime,
  injectedDecisionRuntime,
  type DecisionRuntimeRecord,
  type EditorialLlmConnectorOptions,
  type EditorialLlmJsonCompletion,
} from "../connectors/editorial-llm.js";
import type { MarlinEventsArtifact } from "../connectors/marlin-types.js";
import { contextKnowledgePromptPayload } from "../context-knowledge.js";
import { shortFormRetentionPromptLines } from "../editorial/short-form-retention.js";
import { parseLlmResponse } from "./llm-json.js";
import type {
  SelectCandidate,
  SelectsCandidates,
  TriageAgent,
  TriageAgentContext,
  TriageCoverageFeedback,
} from "../commands/triage.js";
import { sanitizeStillBackground } from "../artifacts/still-image-policy.js";

export type LlmImagePart = GeminiInlineImageInput;
export type LlmCompleter = (prompt: string, images?: LlmImagePart[]) => Promise<string>;
export { extractJsonObject } from "./llm-json.js";

// Cockpit/repo-side editorial triage should prefer Claude/Codex subscription
// agents. Gemini flash-lite remains the headless CLI automation fallback.
export const DEFAULT_TRIAGE_MODEL = "gemini-2.5-flash-lite";
export const UNRELIABLE_TRANSCRIPT_TEXT = "[unreliable — judge on visuals]";

const BRIEF_REL = "01_intent/creative_brief.yaml";
const ANALYSIS_REL = "03_analysis";
const SEGMENTS_REL = "03_analysis/segments.json";
const MARLIN_EVENTS_REL = "03_analysis/marlin_events.json";
const SOURCE_START_TOLERANCE_US = 250_000;
const FILMSTRIP_MAX_WIDTH_PX = 512;
// Bounded batch defaults for both text-only and multimodal triage. Every LLM
// call sees at most DEFAULT_TRIAGE_BATCH_SEGMENTS segments/images; explicit
// overrides (option/env) are clamped to MAX_TRIAGE_BATCH_SEGMENTS so that even
// a maxed-out knob cannot collapse a large multi-material pool (13 images or
// more) back into a single bulk call.
const DEFAULT_TRIAGE_BATCH_SEGMENTS = 8;
const MAX_TRIAGE_BATCH_SEGMENTS = 12;
const MULTIMODAL_BATCH_DELAY_MS = 5_000;
const TRIAGE_BATCH_CHECKPOINT_REL = "03_analysis/llm-triage-batches.json";
const TRIAGE_BATCH_CHECKPOINT_VERSION = "1";
// Bump when the prompt contract or batch policy changes materially so saved
// batch results are never reused across incompatible policies.
const TRIAGE_BATCH_POLICY_VERSION = "triage-batch-v1";
const MARLIN_REPORTER_METHOD = "marlin_reporter";
const MARLIN_SUMMARY_PROMPT_TEMPLATE_ID = "marlin-caption-v1";
const execFileAsync = promisify(execFile);

const VALID_ROLES = new Set<SelectCandidate["role"]>([
  "hero",
  "support",
  "transition",
  "texture",
  "dialogue",
  "reject",
]);

const VALID_STORY_ROLES = new Set<NonNullable<SelectCandidate["story_role"]>>([
  "hook",
  "setup",
  "experience",
  "payoff",
  "reaction",
  "closing",
]);

const EDITORIAL_SUMMARY_VALUES = {
  dominant_visual_mode: new Set(["talking_head", "screen_demo", "event_broll", "mixed", "unknown"]),
  speaker_topology: new Set(["solo_primary", "interviewer_guest", "multi_speaker", "unknown"]),
  motion_profile: new Set(["low", "medium", "high", "unknown"]),
  transcript_density: new Set(["sparse", "medium", "dense", "unknown"]),
} as const;

export interface CompactPeakEvidence {
  has_peak: boolean;
  types: string[];
  count: number;
}

export interface CompactVisualQuality {
  scores?: Record<string, number>;
  labels?: Record<string, string[]>;
}

export interface CompactSegmentEvidence {
  segment_id: string;
  asset_id: string;
  src_in_us: number;
  src_out_us: number;
  summary: string;
  scene_report?: string;
  tags: string[];
  peak: CompactPeakEvidence;
  transcript: string;
  filmstrip_path?: string;
  visual_quality?: CompactVisualQuality;
  quality_flags?: string[];
  confidence_penalty?: number;
  interest_point_labels?: string[];
  extracted_text?: string[];
  place_hint?: string;
  aesthetic_notes?: string[];
  media_kind?: AssetMediaCapability["media_kind"];
  source_capabilities?: AssetMediaCapability["source_capabilities"];
  audio_events?: string[];
  audio_story?: string[];
}

export interface TriageFilmstripImageRef {
  image_index: number;
  segment_id: string;
  asset_id: string;
  filmstrip_path: string;
  mime_type: string;
}

export type FilmstripImagePreparer = (imagePath: string, mimeType: string) => Promise<LlmImagePart | null>;

interface PreparedFilmstripImages {
  images: LlmImagePart[];
  refs: TriageFilmstripImageRef[];
}

interface TriageBatchInfo {
  index: number;
  count: number;
}

interface TriagePromptInput {
  brief: CreativeBrief;
  segments: CompactSegmentEvidence[];
  coverageFeedback?: TriageCoverageFeedback;
  filmstripImages?: TriageFilmstripImageRef[];
  batch?: TriageBatchInfo;
}

export interface CreateLlmTriageAgentOptions {
  llm?: LlmCompleter;
  model?: string;
  textOnlyTriage?: boolean;
  imagePreparer?: FilmstripImagePreparer;
  /** Max segments/images per LLM call. Defaults from policy/env, bounded ≥1. */
  multimodalBatchSize?: number;
  editorialLlm?: EditorialLlmConnectorOptions;
  /**
   * Whole-stage budget shared by every batch call of this agent instance,
   * including coverage-feedback retries (an exhausted deadline is never
   * regenerated while the agent lives). Each batch receives min(per-call
   * timeout, remaining budget); once exhausted no new batch is called and
   * remaining batches are recorded as skipped. Defaults from the
   * editorial-llm stage timeout configuration chain.
   */
  stageTimeoutMs?: number;
}

// ── Bounded batch checkpoint (Issue #5 M3) ──────────────────────

/**
 * Stable non-secret failure classification for one triage batch. Reuses the
 * editorial-llm error taxonomy; "stage_deadline_exhausted" marks batches that
 * were never called because the shared stage budget ran out.
 */
export type TriageBatchFailureReason =
  | EditorialLlmErrorKind
  | "stage_deadline_exhausted";

interface TriageBatchCheckpointEntry {
  index: number;
  segment_ids: string[];
  signature: string;
  parsed: Record<string, unknown>;
  /** Non-secret runtime provenance for the stored completion (e.g. "gemini"). */
  runtime?: string;
}

interface TriageBatchCheckpointFile {
  version: string;
  plan_signature: string;
  batch_size: number;
  batches: TriageBatchCheckpointEntry[];
}

function stableTriageHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

/**
 * Minimal binding signature for a batch plan: project, model, batch policy,
 * prompt contract version, brief content, and the full compact evidence
 * input. Any source/policy/model/input change invalidates saved batches so
 * stale results are never reused.
 */
function triagePlanSignature(args: {
  projectId: string;
  runtimeSnapshot: Record<string, unknown>;
  batchSize: number;
  textOnly: boolean;
  brief: CreativeBrief;
  segments: CompactSegmentEvidence[];
}): string {
  return stableTriageHash({
    project_id: args.projectId,
    runtime_snapshot: args.runtimeSnapshot,
    batch_size: args.batchSize,
    text_only: args.textOnly,
    policy_version: TRIAGE_BATCH_POLICY_VERSION,
    brief: args.brief,
    segments: args.segments,
  });
}

function triageBatchSignature(
  planSignature: string,
  index: number,
  segmentIds: string[],
  coverageFeedback: TriageCoverageFeedback | undefined,
): string {
  return stableTriageHash({
    plan_signature: planSignature,
    index,
    segment_ids: segmentIds,
    coverage_feedback: coverageFeedback ?? null,
  });
}

function triageBatchCheckpointPath(projectDir: string): string {
  return path.join(projectDir, TRIAGE_BATCH_CHECKPOINT_REL);
}

/**
 * Load completed-batch entries whose plan signature still matches. Entries
 * are keyed by index+signature so a coverage-feedback round (different
 * signatures) re-calls the LLM instead of stale-reusing round-0 results.
 */
function loadTriageBatchCheckpoint(
  projectDir: string,
  planSignature: string,
): Map<number, TriageBatchCheckpointEntry> {
  const byIndex = new Map<number, TriageBatchCheckpointEntry>();
  try {
    const parsed = readJsonIfExists<TriageBatchCheckpointFile>(triageBatchCheckpointPath(projectDir));
    if (!parsed || parsed.version !== TRIAGE_BATCH_CHECKPOINT_VERSION) return byIndex;
    if (parsed.plan_signature !== planSignature || !Array.isArray(parsed.batches)) return byIndex;
    for (const entry of parsed.batches) {
      if (
        typeof entry?.index !== "number" ||
        !Array.isArray(entry.segment_ids) ||
        typeof entry.signature !== "string" ||
        typeof entry.parsed !== "object" ||
        entry.parsed === null
      ) continue;
      byIndex.set(entry.index, entry);
    }
  } catch {
    // Fail open: an unreadable checkpoint just means every batch re-runs.
  }
  return byIndex;
}

function recordTriageBatchCheckpoint(
  projectDir: string,
  checkpoint: TriageBatchCheckpointFile,
): void {
  try {
    atomicWriteJson(triageBatchCheckpointPath(projectDir), checkpoint);
  } catch {
    // Checkpointing is best-effort resume support only.
  }
}

function classifyTriageBatchFailure(error: unknown): TriageBatchFailureReason {
  const message = error instanceof Error ? error.message : String(error);
  if (/not valid JSON|JSON parse failed|parseable/i.test(message)) return "json_parse";
  if (/schema validation failed/i.test(message)) return "schema_validation";
  return classifyTransportError(error);
}

/**
 * Reduce a batch response to canonical selects fields only, reusing the
 * existing sanitizer/pool-filter. Top-level extras and candidate extras
 * (raw provider payloads, prompts, errors) are dropped, so nothing
 * non-canonical can be persisted to or reused from the batch checkpoint.
 * Returns null when no valid in-pool candidate survives (invalid payload).
 */
function canonicalizeTriageBatchParsed(
  parsed: Record<string, unknown>,
  projectId: string,
  batchSegments: CompactSegmentEvidence[],
): Record<string, unknown> | null {
  const selects = selectsFromLlmResponse(parsed, projectId, batchSegments);
  if (!Array.isArray(selects.candidates) || selects.candidates.length === 0) return null;
  const out: Record<string, unknown> = { candidates: selects.candidates };
  const selectionNotes = stringArray((parsed as { selection_notes?: unknown }).selection_notes);
  if (selectionNotes.length > 0) out.selection_notes = selectionNotes;
  const editorialSummary = sanitizeEditorialSummary((parsed as { editorial_summary?: unknown }).editorial_summary);
  if (editorialSummary) out.editorial_summary = editorialSummary;
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function integerValue(value: unknown): number | undefined {
  const n = numberValue(value);
  if (n === undefined) return undefined;
  return Math.trunc(n);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function clamp01(value: unknown, fallback: number): number {
  const n = numberValue(value);
  if (n === undefined) return fallback;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function normalizeTranscript(raw: unknown): string {
  const transcript = typeof raw === "string" ? raw : "";
  const quality = classifyTranscriptQuality(transcript);
  return quality.quality === "ok" ? quality.usableText : UNRELIABLE_TRANSCRIPT_TEXT;
}

function mimeTypeForPath(imagePath: string): string {
  const ext = path.extname(imagePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

function resolveFilmstripPath(projectDir: string, filmstripPath: string): string {
  if (path.isAbsolute(filmstripPath)) return filmstripPath;
  const normalized = filmstripPath.replace(/\\/g, "/");
  if (normalized === ANALYSIS_REL || normalized.startsWith(`${ANALYSIS_REL}/`)) {
    return path.join(projectDir, filmstripPath);
  }
  return path.join(projectDir, ANALYSIS_REL, filmstripPath);
}

export async function defaultFilmstripImagePreparer(
  imagePath: string,
  mimeType: string,
): Promise<LlmImagePart | null> {
  let tempDir: string | undefined;
  let readPath = imagePath;
  let outputMimeType = mimeType;
  try {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-triage-filmstrip-"));
    const outPath = path.join(tempDir, `${path.basename(imagePath, path.extname(imagePath))}.png`);
    try {
      await execFileAsync("ffmpeg", [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        imagePath,
        "-vf",
        `scale=${FILMSTRIP_MAX_WIDTH_PX}:-1:force_original_aspect_ratio=decrease`,
        "-frames:v",
        "1",
        outPath,
      ]);
      if (fs.existsSync(outPath)) {
        readPath = outPath;
        outputMimeType = "image/png";
      }
    } catch {
      readPath = imagePath;
      outputMimeType = mimeType;
    }
    return {
      data: fs.readFileSync(readPath).toString("base64"),
      mimeType: outputMimeType,
    };
  } catch {
    return null;
  } finally {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export async function prepareFilmstripImages(
  segments: CompactSegmentEvidence[],
  imagePreparer: FilmstripImagePreparer = defaultFilmstripImagePreparer,
): Promise<PreparedFilmstripImages> {
  const images: LlmImagePart[] = [];
  const refs: TriageFilmstripImageRef[] = [];

  for (const segment of segments) {
    if (!segment.filmstrip_path || !fs.existsSync(segment.filmstrip_path)) continue;
    const mimeType = mimeTypeForPath(segment.filmstrip_path);
    const image = await imagePreparer(segment.filmstrip_path, mimeType);
    if (!image) continue;
    images.push(image);
    refs.push({
      image_index: images.length,
      segment_id: segment.segment_id,
      asset_id: segment.asset_id,
      filmstrip_path: segment.filmstrip_path,
      mime_type: image.mimeType,
    });
  }

  return { images, refs };
}

function extractPeakEvidence(segment: Record<string, unknown>): CompactPeakEvidence {
  const peakAnalysis = isRecord(segment.peak_analysis) ? segment.peak_analysis : {};
  const moments = Array.isArray(peakAnalysis.peak_moments) ? peakAnalysis.peak_moments : [];
  const types = new Set<string>();
  for (const moment of moments) {
    if (!isRecord(moment)) continue;
    const type = stringValue(moment.type) ?? stringValue(moment.peak_type);
    if (type) types.add(type);
  }
  return {
    has_peak: moments.length > 0,
    types: [...types].sort(),
    count: moments.length,
  };
}

function compactNumberObject(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    const n = numberValue(raw);
    if (n !== undefined) out[key] = n;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function compactStringArrayObject(value: unknown): Record<string, string[]> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string[]> = {};
  for (const [key, raw] of Object.entries(value)) {
    const items = stringArray(raw);
    if (items.length > 0) out[key] = items;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function compactVisualQuality(value: unknown): CompactVisualQuality | undefined {
  if (!isRecord(value)) return undefined;
  const scores = compactNumberObject(value.scores);
  const labels = compactStringArrayObject(value.labels);
  if (!scores && !labels) return undefined;
  return {
    ...(scores ? { scores } : {}),
    ...(labels ? { labels } : {}),
  };
}

function isTechnicallyPoorVisualQuality(visualQuality: CompactVisualQuality | undefined): boolean {
  const scores = visualQuality?.scores;
  return Boolean(
    scores &&
      scores.composition_score !== undefined &&
      scores.subject_prominence !== undefined &&
      scores.light_quality !== undefined &&
      scores.composition_score < 0.25 &&
      scores.subject_prominence < 0.25 &&
      scores.light_quality < 0.25,
  );
}

function compactInterestPointLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((point) => {
    if (!isRecord(point)) return [];
    const label = stringValue(point.label);
    return label ? [label] : [];
  });
}

function hasMarlinSummaryProvenance(segment: Record<string, unknown>): boolean {
  const provenance = isRecord(segment.provenance) ? segment.provenance : {};
  const summaryProvenance = isRecord(provenance.summary) ? provenance.summary : {};
  return (
    stringValue(summaryProvenance.method) === MARLIN_REPORTER_METHOD ||
    stringValue(summaryProvenance.source_pass) === MARLIN_REPORTER_METHOD ||
    (
      stringValue(summaryProvenance.stage) === "marlin" &&
      stringValue(summaryProvenance.prompt_template_id) === MARLIN_SUMMARY_PROMPT_TEMPLATE_ID
    )
  );
}

function compactExtractedText(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const text = stringValue(item.text);
    return text ? [text] : [];
  });
}

function compactPlaceHint(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const confidence = numberValue(value.confidence);
  if (confidence === undefined || confidence <= 0.5) return undefined;
  return stringValue(value.name);
}

export function compactSegmentEvidence(rawSegments: unknown[]): CompactSegmentEvidence[] {
  return rawSegments.flatMap((item): CompactSegmentEvidence[] => {
    if (!isRecord(item)) return [];
    const segmentId = stringValue(item.segment_id);
    const assetId = stringValue(item.asset_id);
    const srcInUs = integerValue(item.src_in_us);
    const srcOutUs = integerValue(item.src_out_us);
    if (!segmentId || !assetId || srcInUs === undefined || srcOutUs === undefined) return [];
    if (srcInUs < 0 || srcOutUs <= srcInUs) return [];
    const visualQuality = compactVisualQuality(item.visual_quality);
    const interestPointLabels = compactInterestPointLabels(item.interest_points);
    const visualAppraisal = isRecord(item.visual_appraisal) ? item.visual_appraisal : {};
    const extractedText = compactExtractedText(visualAppraisal.extracted_text);
    const placeHint = compactPlaceHint(visualAppraisal.place_hint);
    const aestheticNotes = stringArray(visualAppraisal.aesthetic_notes);
    const summary = stringValue(item.summary) ?? "";
    const sceneReport = hasMarlinSummaryProvenance(item) ? summary : undefined;
    const compactSummary = isTechnicallyPoorVisualQuality(visualQuality)
      ? `[TECHNICALLY_POOR] ${summary}`.trim()
      : summary;
    return [
      {
        segment_id: segmentId,
        asset_id: assetId,
        src_in_us: srcInUs,
        src_out_us: srcOutUs,
        summary: compactSummary,
        ...(sceneReport ? { scene_report: sceneReport } : {}),
        tags: stringArray(item.tags),
        peak: extractPeakEvidence(item),
        transcript: normalizeTranscript(item.transcript_excerpt ?? item.transcript),
        filmstrip_path: stringValue(item.filmstrip_path),
        quality_flags: stringArray(item.quality_flags),
        ...(visualQuality ? { visual_quality: visualQuality } : {}),
        ...(interestPointLabels.length > 0 ? { interest_point_labels: interestPointLabels } : {}),
        ...(extractedText.length > 0 ? { extracted_text: extractedText } : {}),
        ...(placeHint ? { place_hint: placeHint } : {}),
        ...(aestheticNotes.length > 0 ? { aesthetic_notes: aestheticNotes } : {}),
      },
    ];
  });
}

interface MarlinCameraMotionStartHint {
  description: string;
  confidencePenalty: number;
}

function loadMarlinCameraMotionStartHints(projectDir: string): Map<string, MarlinCameraMotionStartHint> {
  const marlinPath = path.join(projectDir, MARLIN_EVENTS_REL);
  if (!fs.existsSync(marlinPath)) return new Map();

  try {
    const parsed = JSON.parse(fs.readFileSync(marlinPath, "utf-8")) as MarlinEventsArtifact;
    const hints = new Map<string, MarlinCameraMotionStartHint>();
    for (const item of parsed.items ?? []) {
      const firstEvent = [...(item.events ?? [])].sort((a, b) =>
        a.start_us - b.start_us || a.end_us - b.end_us || a.event_id.localeCompare(b.event_id)
      )[0];
      if (!firstEvent || firstEvent.start_us > SOURCE_START_TOLERANCE_US) continue;
      if (!describesCameraSetupMotion(firstEvent.description)) continue;
      hints.set(item.asset_id, {
        description: firstEvent.description,
        confidencePenalty: MARLIN_CAMERA_MOTION_CONFIDENCE_PENALTY,
      });
    }
    return hints;
  } catch {
    return new Map();
  }
}

function applyMarlinCameraMotionQualityHints(
  segments: CompactSegmentEvidence[],
  hints: Map<string, MarlinCameraMotionStartHint>,
): CompactSegmentEvidence[] {
  if (hints.size === 0) return segments;
  return segments.map((segment) => {
    const hint = hints.get(segment.asset_id);
    if (!hint || segment.src_in_us > SOURCE_START_TOLERANCE_US) return segment;
    return {
      ...segment,
      quality_flags: uniqueStrings([...(segment.quality_flags ?? []), MARLIN_CAMERA_MOTION_START_FLAG]),
      confidence_penalty: Math.max(segment.confidence_penalty ?? 0, hint.confidencePenalty),
      aesthetic_notes: uniqueStrings([
        ...(segment.aesthetic_notes ?? []),
        `Marlin first event suggests camera setup/motion: ${hint.description}`,
      ]),
    };
  });
}

export function loadCompactSegmentEvidence(projectDir: string): CompactSegmentEvidence[] {
  assertProjectPlanningMediaKindsSupported(projectDir);
  const segmentsPath = path.join(projectDir, SEGMENTS_REL);
  if (!fs.existsSync(segmentsPath)) {
    throw new Error(`segments.json not found: ${segmentsPath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(segmentsPath, "utf-8")) as {
    items?: unknown;
    segments?: unknown;
  };
  const rawSegments = Array.isArray(parsed.items)
    ? parsed.items
    : Array.isArray(parsed.segments)
      ? parsed.segments
      : [];
  const segments = compactSegmentEvidence(rawSegments);
  if (segments.length === 0) {
    throw new Error(`segments.json has no valid segment evidence: ${segmentsPath}`);
  }
  const qualityHints = loadMarlinCameraMotionStartHints(projectDir);
  const capabilities = readAssetMediaCapabilities(projectDir);
  const audioEvents = loadWindowedAudioEvidence(projectDir, "audio_events.json", "items", (item) => {
    const type = stringValue(item.type);
    const label = stringValue(item.label);
    return [type, label].filter(Boolean).join(": ");
  });
  const audioStory = loadWindowedAudioEvidence(projectDir, "audio_story_graph.json", "nodes", (item) => {
    const type = stringValue(item.node_type);
    const role = stringValue(item.story_role);
    const text = stringValue(item.text);
    return [type, role, text].filter(Boolean).join(": ");
  });
  return applyMarlinCameraMotionQualityHints(segments, qualityHints).map((segment) => {
    const capability = capabilities.get(segment.asset_id);
    const audioOnly = capability?.media_kind === "audio";
    return {
      ...segment,
      ...(capability ? capability : {}),
      ...(audioOnly && segment.transcript === UNRELIABLE_TRANSCRIPT_TEXT ? { transcript: "" } : {}),
      ...(audioOnly ? { filmstrip_path: undefined, visual_quality: undefined, extracted_text: undefined, place_hint: undefined, aesthetic_notes: undefined } : {}),
      ...(!audioOnly && segment.filmstrip_path
        ? { filmstrip_path: resolveFilmstripPath(projectDir, segment.filmstrip_path) }
        : {}),
      ...(audioEvents.get(segment.segment_id)?.length ? { audio_events: audioEvents.get(segment.segment_id) } : {}),
      ...(audioStory.get(segment.segment_id)?.length ? { audio_story: audioStory.get(segment.segment_id) } : {}),
    };
  });
}

function loadWindowedAudioEvidence(
  projectDir: string,
  filename: string,
  arrayKey: string,
  describe: (item: Record<string, unknown>) => string,
): Map<string, string[]> {
  const output = new Map<string, string[]>();
  const filePath = path.join(projectDir, ANALYSIS_REL, filename);
  const segmentsPath = path.join(projectDir, SEGMENTS_REL);
  if (!fs.existsSync(filePath) || !fs.existsSync(segmentsPath)) return output;
  try {
    const artifact = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
    const segmentDoc = JSON.parse(fs.readFileSync(segmentsPath, "utf-8")) as { items?: unknown };
    const items = Array.isArray(artifact[arrayKey]) ? artifact[arrayKey] as unknown[] : [];
    const segments = Array.isArray(segmentDoc.items) ? segmentDoc.items : [];
    for (const rawSegment of segments) {
      if (!isRecord(rawSegment)) continue;
      const segmentId = stringValue(rawSegment.segment_id);
      const assetId = stringValue(rawSegment.asset_id);
      const start = integerValue(rawSegment.src_in_us);
      const end = integerValue(rawSegment.src_out_us);
      if (!segmentId || !assetId || start === undefined || end === undefined) continue;
      const descriptions = items.flatMap((rawItem) => {
        if (!isRecord(rawItem) || stringValue(rawItem.asset_id) !== assetId) return [];
        const itemStart = integerValue(rawItem.start_us);
        const itemEnd = integerValue(rawItem.end_us);
        if (itemStart === undefined || itemEnd === undefined || itemStart >= end || itemEnd <= start) return [];
        const description = describe(rawItem);
        return description ? [description] : [];
      });
      if (descriptions.length > 0) output.set(segmentId, uniqueStrings(descriptions));
    }
  } catch {
    return new Map();
  }
  return output;
}

function briefMustHave(brief: CreativeBrief): string[] {
  return stringArray((brief as { must_have?: unknown }).must_have);
}

function buildCoverageFeedbackPreamble(feedback: TriageCoverageFeedback | undefined): string[] {
  if (!feedback) return [];
  const lines = [
    `前回の選定で以下の不足が出た。必ず是正せよ: ${JSON.stringify(feedback.gaps)}。これはcoverage hard constraintである。特に未充足のsemantic cluster/must_haveを埋め、under-sampled な montage クラスタを増やし、sparse を解消せよ。前回選定数=${feedback.previous_selection_count}`,
  ];
  if (feedback.brief_alignment_gaps && feedback.brief_alignment_gaps.length > 0) {
    lines.push(
      `brief-alignment の不足も必ず是正せよ: ${JSON.stringify(feedback.brief_alignment_gaps)}。各 feedback を candidates の evidence / why_it_matches / eligible_beats / editorial_signals で具体的に満たせ。`,
    );
  }
  if (feedback.cut_count_feedback) {
    lines.push(`clip count の不足も必ず是正せよ: ${feedback.cut_count_feedback}`);
  }
  return [...lines, ""];
}

function buildFilmstripPromptLines(refs: TriageFilmstripImageRef[] | undefined, includesAudioOnly = false): string[] {
  if (!refs || refs.length === 0) {
    return [
      includesAudioOnly
        ? "No filmstrip images are attached. Audio-only segments have no visual evidence; use only transcript, audio_events, audio_story, non-visual summary, and audio quality flags for them."
        : "No filmstrip images are attached for this request. Use the text evidence: scene_report, summary, tags, extracted_text, place_hint, aesthetic_notes, peaks, and transcript quality flags.",
    ];
  }
  return [
    "You can see filmstrip images for each segment listed below. These segments ARE the entire available footage pool — select the best candidates from what is available, even if no segment is a perfect match for the brief.",
    "Use visual information (lighting, composition, subject, action) alongside the text summary to make selection decisions. Text summaries may be generic; the filmstrip gives you ground truth.",
    "The image_index field is 1-based and matches the order of attached image parts.",
    "",
    "## Attached filmstrip images",
    JSON.stringify(refs, null, 2),
  ];
}

function hasAudioOnlyEvidence(segments: CompactSegmentEvidence[]): boolean {
  return segments.some((segment) =>
    segment.media_kind === "audio" ||
    (segment.source_capabilities?.has_audio === true && segment.source_capabilities.has_video === false)
  );
}

function buildBatchPromptLines(batch: TriageBatchInfo | undefined): string[] {
  if (!batch || batch.count <= 1) return [];
  return [
    "## Batch",
    `This is segment batch ${batch.index}/${batch.count}. Select the strongest candidates from this batch only; candidates from all batches will be merged after parsing.`,
    "",
  ];
}

export function buildLlmTriagePrompt(input: TriagePromptInput): string {
  const contextKnowledge = contextKnowledgePromptPayload(input.brief);
  const retentionLines = shortFormRetentionPromptLines(input.brief);
  const includesAudioOnly = hasAudioOnlyEvidence(input.segments);
  const briefPayload = {
    project_id: input.brief.project_id,
    title: input.brief.project.title,
    strategy: input.brief.project.strategy,
    runtime_target_sec: input.brief.project.runtime_target_sec,
    message: {
      primary: input.brief.message.primary,
      secondary: input.brief.message.secondary ?? [],
    },
    must_have: briefMustHave(input.brief),
    emotion_curve: input.brief.emotion_curve,
    ...(contextKnowledge ? { context_knowledge: contextKnowledge } : {}),
  };

  return [
    ...buildCoverageFeedbackPreamble(input.coverageFeedback),
    "You are the footage-triager for Video OS. Select source segments for a rough-cut candidate board.",
    includesAudioOnly
      ? "Work from the creative brief and the segment evidence only. For audio-only sources, use transcript, audio_events, and audio_story evidence; never invent a frame, subject, composition, motion, face, place, or other visual claim."
      : "Work from the creative brief and the segment evidence only. Prefer visual evidence over unreliable transcript text.",
    ...buildFilmstripPromptLines(input.filmstripImages, includesAudioOnly),
    "",
    ...buildBatchPromptLines(input.batch),
    "",
    "## Creative brief",
    JSON.stringify(briefPayload, null, 2),
    "",
    "## Compact segment evidence",
    JSON.stringify(input.segments, null, 2),
    "",
    "## Selection guide",
    "- Cover every must_have item with explicit evidence.",
    "- Respect the emotion curve and source chronology unless the brief clearly asks for editorial reordering.",
    "- Include a clear opening and a clear ending.",
    "- Maintain enough breadth across assets, visual modes, and story beats for the target runtime.",
    ...(includesAudioOnly ? [
      "- Audio-only segments are first-class candidates. Do not reject or omit them because filmstrip, visual_quality, or visual tags are absent.",
      "- For audio-only evidence, role=dialogue is appropriate for speech; texture/support can represent ambience or natural sound. Ground why_it_matches and evidence in transcript/audio events/audio story nodes only.",
    ] : []),
    "- Use `place_hint` to identify location-specific content for the brief.",
    "- Use `extracted_text` to identify signage, menus, or labels relevant to the brief.",
    "- Use `aesthetic_notes` to prefer visually strong clips.",
    "- Use `context_knowledge` to correct likely subject, food/product, person, terminology, or place misidentifications in scene text.",
    "- Do not discard dense repetition just because shots are similar: montage clusters can be important. Sample them proportionally and avoid sparse coverage.",
    "- Reject technically unusable footage: assign role='reject' with rejection_reason for clips that are out of focus, have severe camera shake, are mostly black/overexposed, or show no identifiable subject.",
    "- If `visual_quality.scores.focus_sharpness` < 0.3, reject as technically unusable.",
    "- If `visual_quality.scores.subject_prominence` < 0.2, reject unless the clip serves a specific texture/transition role.",
    "- If `aesthetic_notes` mention 'out of focus', 'severe motion blur', or 'overexposed', lower confidence significantly.",
    `- If quality_flags include '${MARLIN_CAMERA_MOTION_START_FLAG}' or confidence_penalty is present, lower confidence because source-start camera setup/motion often contains unusable shake.`,
    "- IMPORTANT: You must select candidates. An empty candidates array is never acceptable. These segments are the only available footage — choose the best from what exists, not against an ideal.",
    "",
    ...retentionLines,
    ...(retentionLines.length > 0 ? [""] : []),
    "## Output",
    "Respond with JSON only. Markdown code fences are tolerated, but do not add prose outside JSON.",
    "Use only segment_id, asset_id, src_in_us, and src_out_us values that appear in the segment evidence.",
    'Shape: {"selection_notes":["intended emotional progression across candidates","pacing approach: mixed"],"editorial_summary":{"dominant_visual_mode":"mixed","speaker_topology":"unknown","motion_profile":"medium","transcript_density":"sparse"},"candidates":[{"segment_id":"...","asset_id":"...","src_in_us":0,"src_out_us":1,"role":"hero","story_role":"experience","why_it_matches":"...","confidence":0.8,"semantic_rank":1,"evidence":["specific_visual_fact","brief_link_fact"],"eligible_beats":["opening","landscape_scale"],"motif_tags":["mountain_landscape","aerial_scale"],"editorial_signals":{"visual_tags":["aerial","golden_hour","wide_angle"],"peak_type":"visual_peak","peak_strength_score":0.7},"trim_hint":{"preferred_duration_us":3000000}}]}',
    'Valid roles: "hero", "support", "transition", "texture", "dialogue", "reject". If unsure, use "support".',
    "- Assign a `story_role` to each candidate: hook (opening), setup (establishing context), experience (main content), payoff (emotional peak), reaction (response), or closing (ending). If unsure, use 'experience'.",
    "- For each candidate, include eligible_beats listing which brief emotion-curve terms or story phases this clip serves (e.g. wonder, discovery, hook, closing).",
    "- Include motif_tags with specific visual themes relevant to the brief, not generic tags.",
    "- If segment peak evidence exists (has_peak=true), populate editorial_signals.peak_type and peak_strength_score.",
    "- Include trim_hint.preferred_duration_us when you have a clear sense of how long this clip should be used.",
    "- For media_kind=image, still_image.hold_duration_sec/min_hold_sec/max_hold_sec are seconds. motion_mode=static is the only executable C2A truth; subtle_ken_burns remains pending EYE-070C2B. To request executable camera work, author still_image.camera_motion with preset from: push_in, pull_out, horizontal_tracking, tilt_down, diagonal_drift, pan_zoom (optional easing smoothstep|linear, optional intensity 0.02..0.6). fit_mode is contain, cover, or full_bleed.",
    "- still_image.background is a color only: black, white, transparent, #RRGGBB, or #RRGGBBAA. Never provide a path, URL, url(), gradient, or function.",
    includesAudioOnly
      ? "- Evidence must include a specific grounded media observation plus a brief-alignment justification. Visual candidates require a visual observation; audio-only candidates require transcript/audio-event/audio-story evidence and must contain no visual claim."
      : "- Evidence must include at least one specific visual observation and one brief-alignment justification. Avoid generic-only evidence like 'outdoor_scene' or 'person_standing' — add what makes this specific clip valuable.",
    "- selection_notes must include notes about intended emotional progression across candidates.",
    "- selection_notes must note the intended pacing approach (fast montage / slow holds / mixed).",
  ].join("\n");
}

export function parseLlmTriageResponse(raw: string): Record<string, unknown> {
  return parseLlmResponse(raw);
}

function normalizeRole(value: unknown): SelectCandidate["role"] | null {
  if (value === undefined || value === null || value === "") return "support";
  if (typeof value !== "string") return null;
  return VALID_ROLES.has(value as SelectCandidate["role"]) ? (value as SelectCandidate["role"]) : null;
}

function normalizeStoryRole(value: unknown): SelectCandidate["story_role"] | undefined {
  return sanitizeEnumString(value, VALID_STORY_ROLES);
}

function sameOptionalNumber(a: unknown, b: number): boolean {
  const n = integerValue(a);
  return n === undefined || n === b;
}

function sameOptionalString(a: unknown, b: string): boolean {
  const s = stringValue(a);
  return s === undefined || s === b;
}

function sanitizeSemanticRank(value: unknown): number | undefined {
  const n = integerValue(value);
  return n !== undefined && n >= 1 ? n : undefined;
}

function sanitizeEditorialSummary(value: unknown): EditorialSummary | undefined {
  if (!isRecord(value)) return undefined;
  const out: EditorialSummary = {};
  for (const key of Object.keys(EDITORIAL_SUMMARY_VALUES) as Array<keyof typeof EDITORIAL_SUMMARY_VALUES>) {
    const raw = stringValue(value[key]);
    if (raw && EDITORIAL_SUMMARY_VALUES[key].has(raw)) {
      (out as Record<string, string>)[key] = raw;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeEnumString<T extends string>(value: unknown, allowed: ReadonlySet<T>): T | undefined {
  const raw = stringValue(value);
  return raw && allowed.has(raw as T) ? (raw as T) : undefined;
}

function sanitizeOptionalScore(value: unknown): number | undefined {
  const n = numberValue(value);
  return n !== undefined && n >= 0 && n <= 1 ? n : undefined;
}

function sanitizePositiveInteger(value: unknown): number | undefined {
  const n = integerValue(value);
  return n !== undefined && n >= 1 ? n : undefined;
}

const PEAK_TYPES = new Set(["action_peak", "emotional_peak", "visual_peak"] as const);

function sanitizeEditorialSignals(value: unknown): SelectCandidate["editorial_signals"] | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, unknown> = {};
  const visualTags = stringArray(value.visual_tags);
  if (visualTags.length > 0) out.visual_tags = visualTags;
  const peakType = sanitizeEnumString(value.peak_type, PEAK_TYPES);
  if (peakType) out.peak_type = peakType;
  for (const key of [
    "peak_strength_score",
    "motion_energy_score",
    "audio_energy_score",
    "afterglow_score",
    "reaction_intensity_score",
    "surprise_signal",
    "hope_signal",
  ] as const) {
    const score = sanitizeOptionalScore(value[key]);
    if (score !== undefined) out[key] = score;
  }
  const semanticClusterId = stringValue(value.semantic_cluster_id);
  if (semanticClusterId) out.semantic_cluster_id = semanticClusterId;
  if (typeof value.face_detected === "boolean") out.face_detected = value.face_detected;
  return Object.keys(out).length > 0 ? out as SelectCandidate["editorial_signals"] : undefined;
}

function sanitizePeakSignals(value: unknown): { motion?: number; audio_rms?: number; speech_keyword?: string[] } | undefined {
  if (!isRecord(value)) return undefined;
  const out: { motion?: number; audio_rms?: number; speech_keyword?: string[] } = {};
  const motion = sanitizeOptionalScore(value.motion);
  if (motion !== undefined) out.motion = motion;
  const audioRms = sanitizeOptionalScore(value.audio_rms);
  if (audioRms !== undefined) out.audio_rms = audioRms;
  const speechKeyword = stringArray(value.speech_keyword);
  if (speechKeyword.length > 0) out.speech_keyword = speechKeyword;
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeTrimHint(value: unknown): SelectCandidate["trim_hint"] | undefined {
  if (!isRecord(value)) return undefined;
  const out: NonNullable<SelectCandidate["trim_hint"]> = {};
  for (const key of ["preferred_duration_us", "min_duration_us", "max_duration_us"] as const) {
    const duration = sanitizePositiveInteger(value[key]);
    if (duration !== undefined) out[key] = duration;
  }
  const interestPointLabel = stringValue(value.interest_point_label);
  if (interestPointLabel) out.interest_point_label = interestPointLabel;
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeStillImageIntent(value: unknown): SelectCandidate["still_image"] | undefined {
  if (!isRecord(value)) return undefined;
  const out: NonNullable<SelectCandidate["still_image"]> = {};
  for (const key of ["hold_duration_sec", "min_hold_sec", "max_hold_sec"] as const) {
    const duration = numberValue(value[key]);
    if (duration !== undefined && duration > 0) out[key] = duration;
  }
  if (value.motion_mode === "static" || value.motion_mode === "subtle_ken_burns") out.motion_mode = value.motion_mode;
  // Camera motion is carried deterministically; malformed model authoring is
  // dropped at this boundary (artifact schemas still enforce the contract).
  try {
    const cameraMotion = sanitizeStillCameraMotionIntent(value.camera_motion);
    if (cameraMotion) out.camera_motion = cameraMotion;
  } catch {
    // lenient at the model boundary
  }
  if (value.composition === "fit" || value.composition === "vertical_blur_backdrop") out.composition = value.composition;
  if (value.fit_mode === "contain" || value.fit_mode === "cover" || value.fit_mode === "full_bleed") out.fit_mode = value.fit_mode;
  const background = sanitizeStillBackground(value.background);
  if (background) out.background = background;
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeFreezeFrameHold(
  value: unknown,
  sourceInUs: number,
  sourceOutUs: number,
): SelectCandidate["freeze_frame_hold"] | undefined {
  if (!isRecord(value)) return undefined;
  const rawSourceTimeUs = integerValue(value.source_time_us);
  const sourceTimeUs = rawSourceTimeUs !== undefined && rawSourceTimeUs >= 0
    ? rawSourceTimeUs
    : undefined;
  if (sourceTimeUs === undefined || sourceTimeUs < sourceInUs || sourceTimeUs >= sourceOutUs) {
    return undefined;
  }
  const holdFrames = sanitizePositiveInteger(value.hold_frames);
  return {
    source_time_us: sourceTimeUs,
    ...(holdFrames !== undefined ? { hold_frames: holdFrames } : {}),
  };
}

export function selectsFromLlmResponse(
  parsed: Record<string, unknown>,
  projectId: string,
  segments: CompactSegmentEvidence[],
): SelectsCandidates {
  const segmentById = new Map(segments.map((segment) => [segment.segment_id, segment]));
  const rawCandidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
  const candidates: SelectCandidate[] = [];

  for (const item of rawCandidates) {
    if (!isRecord(item)) continue;
    const segmentId = stringValue(item.segment_id);
    if (!segmentId) continue;
    const segment = segmentById.get(segmentId);
    if (!segment) continue;
    if (!sameOptionalString(item.asset_id, segment.asset_id)) continue;
    if (!sameOptionalNumber(item.src_in_us, segment.src_in_us)) continue;
    if (!sameOptionalNumber(item.src_out_us, segment.src_out_us)) continue;

    const role = normalizeRole(item.role);
    if (!role) continue;

    const candidate: SelectCandidate = {
      segment_id: segment.segment_id,
      asset_id: segment.asset_id,
      src_in_us: segment.src_in_us,
      src_out_us: segment.src_out_us,
      role,
      why_it_matches: isAudioOnlySegment(segment)
        ? audioGroundedDescription(segment)
        : stringValue(item.why_it_matches) ?? segment.summary,
      risks: uniqueStrings([...stringArray(item.risks), ...(segment.quality_flags ?? [])]),
      confidence: clamp01(clamp01(item.confidence, 0.5) - (segment.confidence_penalty ?? 0), 0.5),
    };
    if (segment.media_kind) candidate.media_kind = segment.media_kind;
    if (segment.source_capabilities) candidate.source_capabilities = { ...segment.source_capabilities };
    if (segment.transcript) candidate.transcript_excerpt = segment.transcript;
    if (isAudioOnlySegment(segment)) candidate.audio_role = inferAudioRole(candidate);
    if (segment.media_kind === "image") {
      const stillImage = sanitizeStillImageIntent(item.still_image);
      if (stillImage) candidate.still_image = stillImage;
    } else if (segment.media_kind === "video") {
      const freezeFrameHold = sanitizeFreezeFrameHold(
        item.freeze_frame_hold,
        segment.src_in_us,
        segment.src_out_us,
      );
      if (freezeFrameHold) candidate.freeze_frame_hold = freezeFrameHold;
    }
    const semanticRank = sanitizeSemanticRank(item.semantic_rank);
    if (semanticRank !== undefined) candidate.semantic_rank = semanticRank;
    const evidence = isAudioOnlySegment(segment) ? audioGroundedEvidence(segment) : stringArray(item.evidence);
    if (evidence.length > 0) candidate.evidence = evidence;
    const eligibleBeats = stringArray(item.eligible_beats);
    if (eligibleBeats.length > 0) candidate.eligible_beats = eligibleBeats;
    const storyRole = normalizeStoryRole(item.story_role);
    if (storyRole) candidate.story_role = storyRole;
    const motifTags = isAudioOnlySegment(segment)
      ? uniqueStrings([...(segment.audio_events ?? []), ...(segment.audio_story ?? [])]).map(normalizeAudioTag).filter(Boolean).slice(0, 8)
      : stringArray(item.motif_tags);
    if (motifTags.length > 0) candidate.motif_tags = motifTags;
    const editorialSignals = isAudioOnlySegment(segment) ? undefined : sanitizeEditorialSignals(item.editorial_signals);
    if (editorialSignals) candidate.editorial_signals = editorialSignals;
    const peakSignals = isAudioOnlySegment(segment) ? undefined : sanitizePeakSignals(item.peak_signals);
    if (peakSignals) (candidate as SelectCandidate & { peak_signals?: typeof peakSignals }).peak_signals = peakSignals;
    const trimHint = sanitizeTrimHint(item.trim_hint);
    if (trimHint) candidate.trim_hint = trimHint;
    if (role === "reject") {
      candidate.rejection_reason =
        stringValue(item.rejection_reason) ?? stringValue(item.why_it_matches) ?? "LLM rejected this segment";
    }
    candidates.push(candidate);
  }

  const selects: SelectsCandidates = {
    version: "1",
    project_id: projectId,
    candidates,
  };
  const selectionNotes = stringArray(parsed.selection_notes);
  if (selectionNotes.length > 0) selects.selection_notes = selectionNotes;
  const editorialSummary = sanitizeEditorialSummary(parsed.editorial_summary);
  if (editorialSummary) selects.editorial_summary = editorialSummary;
  return selects;
}

function buildRepairPrompt(originalPrompt: string, raw: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return [
    originalPrompt,
    "",
    "The previous response was not parseable as the required JSON object.",
    `Parse error: ${message}`,
    `Previous response excerpt: ${raw.slice(0, 1200)}`,
    "JSON のみで再出力してください。説明文、前後テキスト、コードフェンスは不要です。",
  ].join("\n");
}

async function completeWithSingleJsonRetry(
  llm: LlmCompleter,
  prompt: string,
  images?: LlmImagePart[],
  deadline?: StageDeadline,
): Promise<Record<string, unknown>> {
  // Never start a new LLM invocation once the shared stage budget is gone.
  if (deadline?.exhausted) {
    throw new EditorialLlmError(
      "transport_timeout",
      "stage deadline exhausted before triage LLM call",
    );
  }
  const first = await llm(prompt, images);
  try {
    return parseLlmTriageResponse(first);
  } catch (firstError) {
    // The initial await may have consumed the remaining budget: a repair
    // retry is a new call and must not start after the deadline.
    if (deadline?.exhausted) {
      throw new EditorialLlmError(
        "transport_timeout",
        "stage deadline exhausted before JSON repair retry",
      );
    }
    const second = await llm(buildRepairPrompt(prompt, first, firstError), images);
    try {
      return parseLlmTriageResponse(second);
    } catch (secondError) {
      const message = secondError instanceof Error ? secondError.message : String(secondError);
      throw new Error(`LLM triage response was not valid JSON after retry: ${message}`);
    }
  }
}

function chunkSegments<T>(items: T[], batchSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    chunks.push(items.slice(i, i + batchSize));
  }
  return chunks;
}

function mergeParsedTriageResponses(responses: Array<Record<string, unknown>>): Record<string, unknown> {
  if (responses.length <= 1) return responses[0] ?? {};

  const selectionNotes = responses.flatMap((response) => stringArray(response.selection_notes));
  const candidates = responses.flatMap((response) => (
    Array.isArray(response.candidates) ? response.candidates : []
  ));
  const editorialSummary = responses
    .map((response) => sanitizeEditorialSummary(response.editorial_summary))
    .find((summary): summary is EditorialSummary => summary !== undefined);

  return {
    ...(selectionNotes.length > 0 ? { selection_notes: selectionNotes } : {}),
    ...(editorialSummary ? { editorial_summary: editorialSummary } : {}),
    candidates,
  };
}

function validateTriageJson(parsed: Record<string, unknown>): void {
  if (!Array.isArray(parsed.candidates) || parsed.candidates.length === 0) {
    throw new Error("LLM triage JSON must include a non-empty candidates array");
  }
}

function isAudioOnlySegment(segment: CompactSegmentEvidence): boolean {
  return segment.media_kind === "audio" || (
    segment.source_capabilities?.has_audio === true && segment.source_capabilities.has_video === false
  );
}

function audioGroundedEvidence(segment: CompactSegmentEvidence): string[] {
  return uniqueStrings([
    ...(segment.transcript ? [`Transcript: ${segment.transcript}`] : []),
    ...(segment.audio_events ?? []).map((value) => `Audio event: ${value}`),
    ...(segment.audio_story ?? []).map((value) => `Audio story: ${value}`),
    ...(!segment.transcript && !(segment.audio_events?.length) && !(segment.audio_story?.length) && segment.summary
      ? [`Audio segment summary: ${segment.summary}`]
      : []),
  ]);
}

function audioGroundedDescription(segment: CompactSegmentEvidence): string {
  const evidence = audioGroundedEvidence(segment);
  return evidence.length > 0
    ? evidence.join("; ")
    : "Audio-only segment retained as source-grounded program audio; no transcript or semantic audio event is available.";
}

function normalizeAudioTag(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function storyRoleForIndex(index: number, total: number): NonNullable<SelectCandidate["story_role"]> {
  if (index === 0) return "hook";
  if (index === total - 1) return "closing";
  const ratio = total <= 1 ? 0 : index / (total - 1);
  if (ratio < 0.25) return "setup";
  if (ratio < 0.78) return "experience";
  if (ratio < 0.9) return "payoff";
  return "reaction";
}

function deterministicRoleForSegment(segment: CompactSegmentEvidence, index: number): SelectCandidate["role"] {
  const tags = new Set(segment.tags.map((tag) => tag.toLowerCase()));
  if (index === 0 || segment.peak.has_peak) return "hero";
  if (segment.transcript && segment.transcript !== UNRELIABLE_TRANSCRIPT_TEXT) return "dialogue";
  if (tags.has("texture") || tags.has("detail") || tags.has("landscape")) return "texture";
  if (tags.has("transition") || tags.has("establishing")) return "transition";
  return "support";
}

function deterministicSelects(
  projectId: string,
  segments: CompactSegmentEvidence[],
  decisionRuntime: DecisionRuntimeRecord,
): SelectsCandidates {
  const ranked = [...segments].sort((a, b) => {
    const peakDelta = Number(b.peak.has_peak) - Number(a.peak.has_peak);
    if (peakDelta !== 0) return peakDelta;
    return a.asset_id.localeCompare(b.asset_id) || a.src_in_us - b.src_in_us;
  });
  const candidates = ranked.map((segment, index): SelectCandidate => {
    const storyRole = storyRoleForIndex(index, ranked.length);
    const candidate: SelectCandidate = {
      segment_id: segment.segment_id,
      asset_id: segment.asset_id,
      src_in_us: segment.src_in_us,
      src_out_us: segment.src_out_us,
      role: deterministicRoleForSegment(segment, index),
      story_role: storyRole,
      why_it_matches: isAudioOnlySegment(segment)
        ? audioGroundedDescription(segment)
        : segment.summary || "Deterministic fallback selected this valid segment.",
      risks: segment.quality_flags ?? [],
      confidence: clamp01(0.72 - (segment.confidence_penalty ?? 0), 0.5),
      semantic_rank: index + 1,
      evidence: isAudioOnlySegment(segment)
        ? audioGroundedEvidence(segment)
        : [
            segment.scene_report ? `Marlin scene: ${segment.scene_report}` : `Summary: ${segment.summary}`,
            segment.peak.has_peak
              ? `Peak evidence: ${segment.peak.types.join(", ") || "detected"}`
              : "No peak evidence available.",
          ],
      eligible_beats: [storyRole],
      motif_tags: isAudioOnlySegment(segment)
        ? uniqueStrings([...(segment.audio_events ?? []), ...(segment.audio_story ?? []), storyRole]).map(normalizeAudioTag).filter(Boolean).slice(0, 8)
        : uniqueStrings([...segment.tags, storyRole]).slice(0, 8),
      trim_hint: {
        preferred_duration_us: Math.max(1, Math.min(segment.src_out_us - segment.src_in_us, 3_000_000)),
      },
      ...(segment.media_kind ? { media_kind: segment.media_kind } : {}),
      ...(segment.source_capabilities ? { source_capabilities: { ...segment.source_capabilities } } : {}),
    };
    if (isAudioOnlySegment(segment)) candidate.audio_role = inferAudioRole(candidate);
    return candidate;
  });
  return {
    version: "1",
    project_id: projectId,
    decision_runtime: decisionRuntime,
    selection_notes: [
      "Deterministic fallback selected ranked valid segments after editorial LLM runtimes were unavailable or invalid.",
      "Pacing approach: mixed, preserving peaks and source order where possible.",
    ],
    editorial_summary: {
      dominant_visual_mode: hasAudioOnlyEvidence(segments) && segments.every(isAudioOnlySegment) ? "unknown" : "mixed",
      speaker_topology: "unknown",
      motion_profile: hasAudioOnlyEvidence(segments) && segments.every(isAudioOnlySegment) ? "unknown" : "medium",
      transcript_density: "sparse",
    },
    candidates,
  };
}

function mergeDecisionRuntime(
  completions: EditorialLlmJsonCompletion[],
  role: string,
): DecisionRuntimeRecord {
  if (completions.length === 0) return injectedDecisionRuntime(role);
  const runtime = completions[completions.length - 1].runtime;
  const warnings = uniqueStrings(completions.flatMap((completion) => completion.warnings));
  return {
    runtime,
    role,
    author: "llm",
    attempted_runtimes: completions.flatMap((completion) => completion.attempts),
    ...(warnings.length > 0 ? { fallback_warnings: warnings } : {}),
  };
}

function resumedConnectorDecisionRuntime(
  resumedRuntimes: string[],
  role: string,
): DecisionRuntimeRecord | undefined {
  const connectorRuntimes = uniqueStrings(resumedRuntimes).filter(
    (runtime) => runtime === "codex_exec" || runtime === "claude_cli" || runtime === "gemini",
  );
  if (connectorRuntimes.length === 0) return undefined;
  return {
    runtime: connectorRuntimes[0],
    role,
    author: "llm",
    attempted_runtimes: connectorRuntimes.map((runtime) => ({
      runtime,
      status: "success" as const,
      message: "resumed from triage batch checkpoint",
    })),
  };
}

export function createLlmTriageAgent(opts: CreateLlmTriageAgentOptions = {}): TriageAgent {
  const imagePreparer = opts.imagePreparer ?? defaultFilmstripImagePreparer;

  // One P0 stage budget per agent instance (the agent is this command/stage's
  // scope): the initial batch run plus its coverage-feedback retries share it.
  // An exhausted deadline stays exhausted for this agent — it is returned
  // as-is and never regenerated, so retries can never mint a fresh budget.
  const stageDeadlines = new Map<string, StageDeadline>();
  const stageDeadlineForProject = (projectDir: string): StageDeadline => {
    const existing = stageDeadlines.get(projectDir);
    if (existing) return existing;
    // Budget resolution mirrors the connector chain: top-level option wins,
    // then nested connector options (incl. their env), then analysis-defaults.
    const fresh = createEditorialStageDeadline(
      { stageTimeoutMs: opts.stageTimeoutMs ?? opts.editorialLlm?.stageTimeoutMs },
      opts.editorialLlm?.env ?? process.env,
    );
    stageDeadlines.set(projectDir, fresh);
    return fresh;
  };

  return {
    async run(ctx: TriageAgentContext) {
      const brief = loadCreativeBrief(path.join(ctx.projectDir, BRIEF_REL));
      const segments = loadCompactSegmentEvidence(ctx.projectDir);
      // Multimodal triage is explicit opt-in only (CLI --multimodal /
      // textOnlyTriage:false). The standard path never attaches images; it
      // works from Marlin scene/event/caption evidence and other text.
      const textOnlyTriage = opts.textOnlyTriage ?? true;
      // Bounded deterministic batching for both modes: every LLM call sees at
      // most batchSize segments/images; adaptive behavior is confined to
      // deadline-aware skipping and checkpoint resume (no unlimited retries).
      const batchSize = resolveTriageBatchSize(opts);
      const segmentBatches = chunkSegments(segments, batchSize);
      const totalBatches = segmentBatches.length;
      const planSignature = triagePlanSignature({
        projectId: ctx.projectId,
        runtimeSnapshot: triageRuntimeSnapshot(opts, opts.editorialLlm?.env ?? process.env),
        batchSize,
        textOnly: textOnlyTriage,
        brief,
        segments,
      });
      const completedBatches = loadTriageBatchCheckpoint(ctx.projectDir, planSignature);
      // Validate every matching completed entry up front so a batch that
      // fails or is skipped in THIS run cannot evict a batch completed by an
      // earlier run from the checkpoint. New successes union/upsert into the
      // same map and every save writes the full index-sorted set.
      const validatedCompleted = new Map<number, TriageBatchCheckpointEntry>();
      for (let i = 0; i < totalBatches; i += 1) {
        const batchSegments = segmentBatches[i];
        const segmentIds = batchSegments.map((segment) => segment.segment_id);
        const signature = triageBatchSignature(planSignature, i, segmentIds, ctx.coverageFeedback);
        const cached = completedBatches.get(i);
        if (!cached || cached.signature !== signature || !arraysEqual(cached.segment_ids, segmentIds)) continue;
        const canonicalCached = canonicalizeTriageBatchParsed(cached.parsed, ctx.projectId, batchSegments);
        if (!canonicalCached) continue;
        validatedCompleted.set(i, {
          index: i,
          segment_ids: segmentIds,
          signature,
          parsed: canonicalCached,
          ...(typeof cached.runtime === "string" ? { runtime: cached.runtime } : {}),
        });
      }
      const savedEntries = new Map<number, TriageBatchCheckpointEntry>(validatedCompleted);
      const persistCheckpoint = (): void => {
        recordTriageBatchCheckpoint(ctx.projectDir, {
          version: TRIAGE_BATCH_CHECKPOINT_VERSION,
          plan_signature: planSignature,
          batch_size: batchSize,
          batches: [...savedEntries.values()].sort((a, b) => a.index - b.index),
        });
      };
      const parsedBatches: Array<Record<string, unknown>> = [];
      const runtimeCompletions: EditorialLlmJsonCompletion[] = [];
      const resumedRuntimes: string[] = [];
      const batchFailures: Array<{ index: number; reason: TriageBatchFailureReason }> = [];
      // Whole-stage budget shared by every batch call and every coverage
      // retry of this project; each call receives only the remaining budget
      // and no new call starts after exhaustion.
      const deadline = stageDeadlineForProject(ctx.projectDir);

      for (let i = 0; i < totalBatches; i += 1) {
        const batchSegments = segmentBatches[i];
        const segmentIds = batchSegments.map((segment) => segment.segment_id);
        const batchSignature = triageBatchSignature(planSignature, i, segmentIds, ctx.coverageFeedback);

        // Resume: a validated completed entry (signature + canonical payload)
        // is never re-called.
        const cached = validatedCompleted.get(i);
        if (cached) {
          parsedBatches.push(cached.parsed);
          resumedRuntimes.push(cached.runtime ?? "unknown");
          console.error(`[triage:batch] batch=${i + 1}/${totalBatches} resumed_from_checkpoint segments=${segmentIds.length}`);
          continue;
        }

        // Deadline reached: no new calls. The batch is recorded as skipped so
        // partial results stay visible instead of silently disappearing.
        if (deadline.exhausted) {
          batchFailures.push({ index: i, reason: "stage_deadline_exhausted" });
          console.error(`[triage:batch] batch=${i + 1}/${totalBatches} skipped_after_stage_deadline segments=${segmentIds.length}`);
          continue;
        }

        if (i > 0 && !textOnlyTriage) {
          const delayCompleted = await waitForTriageBatchDelay(deadline);
          if (!delayCompleted) {
            batchFailures.push({ index: i, reason: "stage_deadline_exhausted" });
            console.error(`[triage:batch] batch=${i + 1}/${totalBatches} skipped_after_stage_deadline_during_delay segments=${segmentIds.length}`);
            continue;
          }
        }
        const prepared = textOnlyTriage
          ? { images: [], refs: [] }
          : await prepareFilmstripImages(batchSegments, imagePreparer);
        const prompt = buildLlmTriagePrompt({
          brief,
          segments: batchSegments,
          coverageFeedback: ctx.coverageFeedback,
          filmstripImages: prepared.refs,
          batch: totalBatches > 1 ? { index: i + 1, count: totalBatches } : undefined,
        });
        const hasImages = prepared.images.length > 0;
        // The inter-batch delay and image preparation above may have consumed
        // the remaining budget: never start a call once the stage deadline is
        // exhausted.
        if (deadline.exhausted) {
          batchFailures.push({ index: i, reason: "stage_deadline_exhausted" });
          console.error(`[triage:batch] batch=${i + 1}/${totalBatches} skipped_after_stage_deadline_before_call segments=${segmentIds.length}`);
          continue;
        }
        console.error(`[triage:batch] batch=${i + 1}/${totalBatches} segments=${batchSegments.length} images=${prepared.images.length} mode=${hasImages ? "multimodal" : "text-only"}`);
        let batchResult: Record<string, unknown>;
        // Non-secret runtime provenance for this batch's completion.
        let batchRuntime: string | undefined;
        try {
          if (opts.llm) {
            batchRuntime = "injected";
            batchResult = await completeWithSingleJsonRetry(
              opts.llm,
              prompt,
              hasImages ? prepared.images : undefined,
              deadline,
            );
          } else {
            const completion = await completeEditorialJson({
              role: "triage-llm",
              prompt,
              images: hasImages ? prepared.images : undefined,
              parseJson: parseLlmTriageResponse,
              validateJson: validateTriageJson,
              repairPrompt: buildRepairPrompt,
            }, {
              runtime: opts.model === undefined ? undefined : "gemini",
              geminiModel: opts.model,
              // Persist the sanitized attempt journal next to the analysis
              // artifacts unless the caller already chose a sink.
              projectDir: ctx.projectDir,
              ...opts.editorialLlm,
              // Confine this call to whatever run budget remains.
              stageTimeoutMs: Math.max(0, Math.floor(deadline.remainingMs())),
            });
            if (completion.runtime === "deterministic") {
              // No live runtime produced usable output for this batch; treat
              // it as a classified batch failure so partial results stay
              // visible instead of silently degrading to empty candidates.
              const fallbackKind = completion.warnings.length > 0
                ? classifyTriageBatchFailure(new Error(completion.warnings[0]))
                : "transport_error";
              throw new EditorialLlmError(
                fallbackKind === "stage_deadline_exhausted" ? "transport_error" : fallbackKind,
                `batch fell back to deterministic after ${completion.warnings.length} failed or skipped live attempt(s)`,
              );
            }
            runtimeCompletions.push(completion);
            batchRuntime = completion.runtime;
            batchResult = completion.parsed;
          }
        } catch (error) {
          const reason = classifyTriageBatchFailure(error);
          batchFailures.push({ index: i, reason });
          console.error(`[triage:batch] batch=${i + 1}/${totalBatches} failed reason=${reason}`);
          continue;
        }
        const batchCandidates = Array.isArray(batchResult.candidates) ? batchResult.candidates.length : 0;
        console.error(`[triage:batch] batch=${i + 1} parsed_candidates=${batchCandidates}`);
        if (batchCandidates === 0) {
          const keys = Object.keys(batchResult);
          const sample = JSON.stringify(batchResult).slice(0, 500);
          console.error(`[triage:batch] empty batch keys=${keys.join(",")} sample=${sample}`);
        }
        // Persist only canonical fields: prompts, raw provider responses,
        // error text, and unknown extras never reach the checkpoint.
        const canonicalBatchResult = canonicalizeTriageBatchParsed(batchResult, ctx.projectId, batchSegments);
        if (!canonicalBatchResult) {
          batchFailures.push({ index: i, reason: "schema_validation" });
          console.error(`[triage:batch] batch=${i + 1}/${totalBatches} failed reason=schema_validation`);
          continue;
        }
        parsedBatches.push(canonicalBatchResult);
        savedEntries.set(i, {
          index: i,
          segment_ids: segmentIds,
          signature: batchSignature,
          parsed: canonicalBatchResult,
          ...(batchRuntime ? { runtime: batchRuntime } : {}),
        });
        // Checkpoint after every completed batch so a resumed run skips it;
        // previously completed entries are preserved and the set stays
        // index-sorted.
        persistCheckpoint();
      }

      // Every batch failed or was skipped without any LLM result: keep the
      // schema-valid deterministic fallback, but never present it as LLM work.
      if (parsedBatches.length === 0) {
        return {
          selects: deterministicSelects(
            ctx.projectId,
            segments,
            deterministicDecisionRuntime("triage-llm", triageBatchFailureNotes(batchFailures, totalBatches)),
          ),
          confirmed: true,
        };
      }

      const parsed = mergeParsedTriageResponses(parsedBatches);
      const resumedConnectorRuntime = !opts.llm && runtimeCompletions.length === 0
        ? resumedConnectorDecisionRuntime(resumedRuntimes, "triage-llm")
        : undefined;
      let decisionRuntime: DecisionRuntimeRecord = resumedConnectorRuntime
        ?? (opts.llm
          ? injectedDecisionRuntime("triage-llm")
          : mergeDecisionRuntime(runtimeCompletions, "triage-llm"));
      if (resumedRuntimes.length > 0 && !resumedConnectorRuntime) {
        // Resumed batches made no live call this run. Keep their stored
        // non-secret runtime provenance instead of letting an empty live
        // completion list degrade the record to a synthetic identity.
        decisionRuntime = {
          ...decisionRuntime,
          attempted_runtimes: [
            ...decisionRuntime.attempted_runtimes,
            ...uniqueStrings(resumedRuntimes.filter((rt) => rt !== "unknown")).map((rt) => ({
              runtime: rt,
              status: "success" as const,
              message: "resumed from triage batch checkpoint",
            })),
          ] as DecisionRuntimeRecord["attempted_runtimes"],
        };
      }
      const selects: SelectsCandidates = {
        ...selectsFromLlmResponse(parsed, ctx.projectId, segments),
        decision_runtime: decisionRuntime,
      };
      if (batchFailures.length > 0) {
        // Partial failure must stay visible: record stable non-secret reasons
        // on the decision runtime, notes, and provenance of the artifact.
        const failureNotes = triageBatchFailureNotes(batchFailures, totalBatches);
        decisionRuntime = {
          ...decisionRuntime,
          attempted_runtimes: [
            ...decisionRuntime.attempted_runtimes,
            // "triage_batch" is a per-batch record, not a transport runtime;
            // the selects schema intentionally accepts any runtime string.
            ...batchFailures.map((failure) => ({
              runtime: "triage_batch",
              status: failure.reason === "stage_deadline_exhausted" ? ("skipped" as const) : ("failed" as const),
              message: `batch ${failure.index + 1}/${totalBatches}: ${failure.reason}`,
              ...(failure.reason === "stage_deadline_exhausted"
                ? {}
                : { error_kind: failure.reason as EditorialLlmErrorKind }),
            })),
          ] as DecisionRuntimeRecord["attempted_runtimes"],
          fallback_warnings: uniqueStrings([...(decisionRuntime.fallback_warnings ?? []), ...failureNotes]),
        };
        selects.decision_runtime = decisionRuntime;
        selects.selection_notes = uniqueStrings([
          ...(selects.selection_notes ?? []),
          `partial triage: ${parsedBatches.length}/${totalBatches} batches succeeded; failed batches retained no silent candidates`,
        ]);
        selects.provenance = {
          ...(selects.provenance ?? {}),
          triage_batches: {
            version: TRIAGE_BATCH_CHECKPOINT_VERSION,
            total_batches: totalBatches,
            completed_batches: parsedBatches.length,
            failed_batches: batchFailures.map((failure) => ({
              batch: failure.index + 1,
              reason: failure.reason,
            })),
          },
        };
      }
      return { selects, confirmed: true };
    },
  };
}

function resolveTriageBatchSize(opts: CreateLlmTriageAgentOptions): number {
  const raw = opts.multimodalBatchSize !== undefined
    ? Math.trunc(opts.multimodalBatchSize)
    : (() => {
      const envRaw = Number(process.env.VOS_TRIAGE_BATCH_SEGMENTS);
      return Number.isFinite(envRaw) && envRaw >= 1 ? Math.trunc(envRaw) : DEFAULT_TRIAGE_BATCH_SEGMENTS;
    })();
  // Hard bound: no option/env value can push a batch past the policy max.
  return Math.min(Math.max(1, raw), MAX_TRIAGE_BATCH_SEGMENTS);
}

/**
 * Stable non-secret snapshot of everything that selects the actual runtime
 * and model behind an undefined opts.model (connector config chain), read
 * from the SAME effective env the connector will use. Included in the
 * checkpoint plan signature so saved batches are never reused across a
 * changed runtime/model configuration.
 */
function triageRuntimeSnapshot(
  opts: CreateLlmTriageAgentOptions,
  env: NodeJS.ProcessEnv,
): Record<string, unknown> {
  return {
    // An injected completer and the connector path are incompatible
    // completion sources: their checkpoints must never cross-reuse.
    completion_path: opts.llm ? "injected" : "connector",
    model_opt: opts.model ?? null,
    runtime_opt: opts.editorialLlm?.runtime ?? null,
    runtime_env: env.VOS_EDITORIAL_LLM ?? null,
    gemini_model_opt: opts.editorialLlm?.geminiModel ?? null,
    gemini_model_env: env.EDITORIAL_LLM_GEMINI_MODEL
      ?? env.UNIFIED_EDITORIAL_MODEL
      ?? env.BLUEPRINT_MODEL
      ?? env.TRIAGE_MODEL
      ?? null,
    has_gemini_key: Boolean(env.GEMINI_API_KEY),
  };
}

function triageBatchDelayMs(): number {
  const raw = Number(process.env.VOS_TRIAGE_BATCH_DELAY_MS);
  if (Number.isFinite(raw) && raw >= 0) return Math.trunc(raw);
  return MULTIMODAL_BATCH_DELAY_MS;
}

async function waitForTriageBatchDelay(deadline: StageDeadline): Promise<boolean> {
  const delayMs = triageBatchDelayMs();
  if (delayMs <= 0) return !deadline.exhausted;
  const remainingMs = deadline.remainingMs();
  if (remainingMs <= 0) return false;
  await new Promise((resolve) => setTimeout(
    resolve,
    Math.min(delayMs, Math.max(1, Math.floor(remainingMs))),
  ));
  return !deadline.exhausted;
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function triageBatchFailureNotes(
  failures: Array<{ index: number; reason: TriageBatchFailureReason }>,
  totalBatches: number,
): string[] {
  return failures.map((failure) =>
    failure.reason === "stage_deadline_exhausted"
      ? `batch ${failure.index + 1}/${totalBatches} skipped after stage deadline`
      : `batch ${failure.index + 1}/${totalBatches} failed: ${failure.reason}`,
  );
}
