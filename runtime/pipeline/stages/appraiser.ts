/**
 * Stage 10.5: Gemini appraiser - single high-resolution frame appraisal.
 *
 * The appraiser writes quality/OCR/place evidence only. It never mutates the
 * Marlin-owned segment summary.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SegmentItem } from "../../connectors/ffmpeg-segmenter.js";
import { computeRequestHash } from "../../connectors/ffprobe.js";
import {
  APPRAISER_CONNECTOR_VERSION,
  APPRAISER_PROMPT_TEMPLATE_ID,
  APPRAISER_RESPONSE_FORMAT,
  DEFAULT_APPRAISER_MODEL,
  buildAppraiserPrompt,
  computeAppraiserPromptHash,
  normalizeAppraiserResult,
  parseAppraiserJson,
  type AppraiserResult,
  type AppraiserVisualQuality,
} from "../../connectors/gemini-appraiser.js";
import type { VisualQualityMeasurements } from "../../connectors/ffmpeg-motion.js";
import {
  availableEditorialLlmRuntimes,
  completeEditorialJson,
  decisionRuntimeRecord,
  injectedDecisionRuntime,
  type CompleteEditorialJsonRequest,
  type DecisionRuntimeRecord,
  type EditorialLlmConnectorOptions,
  type EditorialLlmJsonCompletion,
} from "../../connectors/editorial-llm.js";
import { atomicWriteJson } from "./_util.js";
import type { SegmentsJson } from "../pipeline-types.js";
import { mapWithConcurrency } from "./vlm.js";

export const DEFAULT_APPRAISER_CONCURRENCY = 3;
export const APPRAISER_FRAME_CACHE_VERSION = "appraiser-frame-v1";

export type AppraiserFn = (
  framePath: string,
  marlinScene: string,
  model?: string,
) => Promise<AppraiserResult>;
export type CompleteEditorialJsonLike = (
  request: CompleteEditorialJsonRequest,
  opts?: EditorialLlmConnectorOptions,
) => Promise<EditorialLlmJsonCompletion>;

export type ExecFileLike = (
  command: string,
  args: string[],
  options: { maxBuffer: number },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => void;

export interface ExtractAppraiserFrameOptions {
  segment: SegmentItem;
  sourcePath: string;
  outputDir: string;
  execFileImpl?: ExecFileLike;
  now?: () => string;
}

export interface ExtractedAppraiserFrame {
  framePath: string;
  frameRelPath: string;
  frameUs: number;
  cacheHash: string;
  cached: boolean;
}

export interface AppraiserStageOptions {
  segmentsJson: SegmentsJson;
  sourceFileMap: Map<string, string>;
  outputDir: string;
  segmentsOutputPath: string;
  policyHash: string;
  skip?: boolean;
  model?: string;
  concurrency?: number;
  appraiserFn?: AppraiserFn;
  completeEditorialJsonImpl?: CompleteEditorialJsonLike;
  editorialLlmOptions?: EditorialLlmConnectorOptions;
  execFileImpl?: ExecFileLike;
}

export interface AppraiserSegmentFailure {
  segment_id: string;
  asset_id: string;
  error: string;
}

export interface AppraiserStageSummary {
  totalSegments: number;
  appraisedSegments: number;
  cachedFrames: number;
  cachedAppraisals: number;
  skippedSegments: number;
  skippedNoApiKey: boolean;
  skippedNoRuntime: boolean;
  skipReason?: string;
  failedSegments: AppraiserSegmentFailure[];
}

interface AppraiserFrameManifest {
  version: string;
  segment_id: string;
  frame_us: number;
  source_path: string;
  cache_hash: string;
  frame_path: string;
  extracted_at: string;
}

interface AppraiserShard {
  segment_id: string;
  asset_id: string;
  frame?: ExtractedAppraiserFrame;
  result?: AppraiserResult;
  requestHash?: string;
  promptHash?: string;
  model: string;
  runtimeRecord?: DecisionRuntimeRecord;
  cachedAppraisal?: boolean;
  skipReason?: string;
  error?: string;
}

type SegmentWithAppraisal = SegmentItem & {
  visual_quality?: CanonicalVisualQuality;
  visual_appraisal?: SegmentVisualAppraisal;
  confidence: SegmentItem["confidence"] & {
    visual_appraisal?: { score: number; source: string; status: string };
  };
  provenance: SegmentItem["provenance"] & {
    visual_quality?: Record<string, string>;
    visual_appraisal?: Record<string, string>;
  };
};

interface CanonicalVisualQuality {
  scores: {
    light_quality?: number;
    subject_prominence?: number;
    emotional_expression?: number;
    composition_score?: number;
    motion_quality?: number;
  };
  score_measurements?: Record<string, VisualQualityScoreMeasurement>;
  labels: {
    lighting_style: string[];
    composition_tags: string[];
    expression_tags: string[];
    motion_tags: string[];
  };
}

interface VisualQualityScoreMeasurement {
  measured: boolean;
  source: string;
  reason?: string;
}

interface SegmentVisualAppraisal {
  status?: "ready" | "skipped";
  frame_us?: number;
  frame_path?: string;
  extracted_text?: AppraiserResult["extracted_text"];
  place_hint?: AppraiserResult["place_hint"];
  aesthetic_notes?: string[];
  skipped_reason?: string;
  appraisal_runtime?: DecisionRuntimeRecord;
}

const APPRAISER_JSON_SCHEMA = {
  type: "object",
  required: ["visual_quality", "extracted_text", "place_hint", "aesthetic_notes"],
  additionalProperties: false,
  properties: {
    visual_quality: {
      type: "object",
      required: ["composition_score", "light_quality", "focus_sharpness", "subject_prominence"],
      additionalProperties: false,
      properties: {
        composition_score: { type: "number", minimum: 0, maximum: 1 },
        light_quality: { type: "number", minimum: 0, maximum: 1 },
        focus_sharpness: { type: "number", minimum: 0, maximum: 1 },
        subject_prominence: { type: "number", minimum: 0, maximum: 1 },
      },
    },
    extracted_text: {
      type: "array",
      items: {
        type: "object",
        required: ["text", "language", "confidence"],
        additionalProperties: false,
        properties: {
          text: { type: "string" },
          language: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
      },
    },
    place_hint: {
      type: "object",
      required: ["name", "category", "confidence", "evidence"],
      additionalProperties: false,
      properties: {
        name: { type: ["string", "null"] },
        category: { type: "string" },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        evidence: { type: "array", items: { type: "string" } },
      },
    },
    aesthetic_notes: { type: "array", items: { type: "string" } },
  },
} as const;

export async function extractAppraiserFrame(
  options: ExtractAppraiserFrameOptions,
): Promise<ExtractedAppraiserFrame> {
  const frameUs = selectAppraiserFrameUs(options.segment);
  const frameDir = path.join(options.outputDir, "appraiser_frames");
  const filename = `${safeSegmentFilename(options.segment.segment_id)}.jpg`;
  const framePath = path.join(frameDir, filename);
  const frameRelPath = toPosixPath(path.relative(options.outputDir, framePath));
  const manifestPath = `${framePath}.json`;
  const cacheHash = computeFrameCacheHash(options.sourcePath, options.segment.segment_id, frameUs);
  const manifest = readFrameManifest(manifestPath);

  if (
    fs.existsSync(framePath) &&
    manifest?.version === APPRAISER_FRAME_CACHE_VERSION &&
    manifest.cache_hash === cacheHash
  ) {
    return { framePath, frameRelPath, frameUs, cacheHash, cached: true };
  }

  fs.mkdirSync(frameDir, { recursive: true });
  fs.rmSync(framePath, { force: true });

  await execFilePromise(options.execFileImpl ?? (execFile as unknown as ExecFileLike), "ffmpeg", [
    "-ss",
    formatSeconds(frameUs),
    "-i",
    options.sourcePath,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    framePath,
  ]);

  const nextManifest: AppraiserFrameManifest = {
    version: APPRAISER_FRAME_CACHE_VERSION,
    segment_id: options.segment.segment_id,
    frame_us: frameUs,
    source_path: path.resolve(options.sourcePath),
    cache_hash: cacheHash,
    frame_path: frameRelPath,
    extracted_at: options.now?.() ?? new Date().toISOString(),
  };
  atomicWriteJson(manifestPath, nextManifest);

  return { framePath, frameRelPath, frameUs, cacheHash, cached: false };
}

export async function runAppraiserStage(
  options: AppraiserStageOptions,
): Promise<AppraiserStageSummary> {
  const summary: AppraiserStageSummary = {
    totalSegments: options.segmentsJson.items.length,
    appraisedSegments: 0,
    cachedFrames: 0,
    cachedAppraisals: 0,
    skippedSegments: 0,
    skippedNoApiKey: false,
    skippedNoRuntime: false,
    failedSegments: [],
  };

  if (options.skip) {
    summary.skippedSegments = options.segmentsJson.items.length;
    return summary;
  }

  if (!hasImageCapableAppraiserRuntime(options)) {
    const reason = "no_image_capable_editorial_llm_runtime";
    summary.skippedSegments = options.segmentsJson.items.length;
    summary.skippedNoRuntime = true;
    summary.skipReason = reason;
    const changed = applyAppraiserSkipped(
      options.segmentsJson,
      reason,
      options.policyHash,
    );
    if (changed) {
      atomicWriteJson(options.segmentsOutputPath, options.segmentsJson);
    }
    console.log("[appraiser] no image-capable editorial LLM runtime available; skipping appraiser stage");
    return summary;
  }

  const candidates = options.segmentsJson.items.filter((segment) =>
    options.sourceFileMap.has(segment.asset_id)
  );
  summary.skippedSegments = options.segmentsJson.items.length - candidates.length;
  if (candidates.length === 0) {
    return summary;
  }

  const model = options.model ?? DEFAULT_APPRAISER_MODEL;
  const promptHash = computeAppraiserPromptHash();

  const shards = await mapWithConcurrency(
    candidates,
    options.concurrency ?? DEFAULT_APPRAISER_CONCURRENCY,
    async (segment): Promise<AppraiserShard> => {
      const sourcePath = options.sourceFileMap.get(segment.asset_id);
      if (!sourcePath) {
        return {
          segment_id: segment.segment_id,
          asset_id: segment.asset_id,
          model,
          error: "source_file_missing",
        };
      }

      try {
        const frame = await extractAppraiserFrame({
          segment,
          sourcePath,
          outputDir: options.outputDir,
          execFileImpl: options.execFileImpl,
        });
        const marlinScene = marlinSceneContext(segment);
        const requestHash = computeAppraiserRequestHash({
          segment_id: segment.segment_id,
          frame_cache_hash: frame.cacheHash,
          marlin_scene_hash: shortHash(marlinScene),
          model_snapshot: model,
          prompt_hash: promptHash,
          response_format: APPRAISER_RESPONSE_FORMAT,
        });

        if (hasReusableAppraisal(segment, frame, requestHash)) {
          return {
            segment_id: segment.segment_id,
            asset_id: segment.asset_id,
            frame,
            model,
            promptHash,
            requestHash,
            cachedAppraisal: true,
          };
        }

        const completion = await runAppraiserCompletion({
          framePath: frame.framePath,
          marlinScene,
          model,
          appraiserFn: options.appraiserFn,
          completeEditorialJsonImpl: options.completeEditorialJsonImpl,
          editorialLlmOptions: options.editorialLlmOptions,
        });
        if (completion.skipReason) {
          return {
            segment_id: segment.segment_id,
            asset_id: segment.asset_id,
            frame,
            model,
            promptHash,
            requestHash,
            runtimeRecord: completion.runtimeRecord,
            skipReason: completion.skipReason,
          };
        }
        return {
          segment_id: segment.segment_id,
          asset_id: segment.asset_id,
          frame,
          result: completion.result,
          model,
          promptHash,
          requestHash,
          runtimeRecord: completion.runtimeRecord,
        };
      } catch (error) {
        return {
          segment_id: segment.segment_id,
          asset_id: segment.asset_id,
          model,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  for (const shard of shards) {
    if (shard.frame?.cached) summary.cachedFrames += 1;
    if (shard.cachedAppraisal) {
      summary.cachedAppraisals += 1;
      continue;
    }
    if (shard.result && shard.frame && shard.requestHash && shard.promptHash) {
      summary.appraisedSegments += 1;
      continue;
    }
    if (shard.skipReason) {
      summary.skippedSegments += 1;
      continue;
    }
    if (shard.error) {
      summary.failedSegments.push({
        segment_id: shard.segment_id,
        asset_id: shard.asset_id,
        error: shard.error,
      });
    }
  }

  const changed = applyAppraiserShards(
    options.segmentsJson,
    shards,
    options.policyHash,
  );
  if (changed) {
    atomicWriteJson(options.segmentsOutputPath, options.segmentsJson);
  }

  return summary;
}

export function mergeAppraiserVisualQuality(
  current: CanonicalVisualQuality | undefined,
  appraiserQuality: AppraiserVisualQuality,
  visualQualityMeasurements?: VisualQualityMeasurements,
): CanonicalVisualQuality {
  const currentLabels = current?.labels;
  const motionQuality = measuredMotionQuality(visualQualityMeasurements);
  const scoreMeasurements: Record<string, VisualQualityScoreMeasurement> = {
    light_quality: {
      measured: true,
      source: "appraiser.visual_quality.light_quality",
    },
    subject_prominence: {
      measured: true,
      source: "appraiser.visual_quality.subject_prominence",
    },
    emotional_expression: {
      measured: false,
      source: "appraiser",
      reason: "not_measured_by_single_frame_appraiser",
    },
    composition_score: {
      measured: true,
      source: "appraiser.visual_quality.composition_score",
    },
    motion_quality: motionQuality === undefined
      ? {
        measured: false,
        source: "visual_quality_measurements",
        reason: "motion_metric_unavailable",
      }
      : {
        measured: true,
        source: "visual_quality_measurements.shake.average_energy",
      },
  };
  return {
    scores: {
      light_quality: appraiserQuality.light_quality,
      subject_prominence: appraiserQuality.subject_prominence,
      composition_score: appraiserQuality.composition_score,
      ...(motionQuality === undefined ? {} : { motion_quality: motionQuality }),
    },
    score_measurements: scoreMeasurements,
    labels: {
      lighting_style: [...(currentLabels?.lighting_style ?? [])],
      composition_tags: [...(currentLabels?.composition_tags ?? [])],
      expression_tags: [...(currentLabels?.expression_tags ?? [])],
      motion_tags: [...(currentLabels?.motion_tags ?? [])],
    },
  };
}

export function computeFrameCacheHash(
  sourcePath: string,
  segmentId: string,
  frameUs: number,
): string {
  const stat = fs.statSync(sourcePath);
  return shortHash(JSON.stringify({
    version: APPRAISER_FRAME_CACHE_VERSION,
    source_path: path.resolve(sourcePath),
    source_size: stat.size,
    source_mtime_ms: Math.round(stat.mtimeMs),
    segment_id: segmentId,
    frame_us: frameUs,
  }));
}

export function computeAppraiserRequestHash(params: {
  segment_id: string;
  frame_cache_hash: string;
  marlin_scene_hash: string;
  model_snapshot: string;
  prompt_hash: string;
  response_format: string;
}): string {
  return computeRequestHash({
    connector_version: APPRAISER_CONNECTOR_VERSION,
    ...params,
  });
}

interface RunAppraiserCompletionOptions {
  framePath: string;
  marlinScene: string;
  model: string;
  appraiserFn?: AppraiserFn;
  completeEditorialJsonImpl?: CompleteEditorialJsonLike;
  editorialLlmOptions?: EditorialLlmConnectorOptions;
}

interface AppraiserCompletionResult {
  result?: AppraiserResult;
  runtimeRecord: DecisionRuntimeRecord;
  skipReason?: string;
}

async function runAppraiserCompletion(
  options: RunAppraiserCompletionOptions,
): Promise<AppraiserCompletionResult> {
  if (options.appraiserFn) {
    return {
      result: await options.appraiserFn(options.framePath, options.marlinScene, options.model),
      runtimeRecord: injectedDecisionRuntime("appraiser"),
    };
  }

  const request: CompleteEditorialJsonRequest = {
    role: "appraiser",
    prompt: buildAppraiserPrompt(options.marlinScene),
    responseSchema: APPRAISER_JSON_SCHEMA,
    images: [{ path: options.framePath, mimeType: mimeTypeForPath(options.framePath) }],
    parseJson: (text) => parseAppraiserJson(text) as Record<string, unknown>,
    validateJson: (parsed) => {
      normalizeAppraiserResult(parsed);
    },
  };
  const completion = await (options.completeEditorialJsonImpl ?? completeEditorialJson)(
    request,
    {
      ...options.editorialLlmOptions,
      geminiModel: options.editorialLlmOptions?.geminiModel ?? options.model,
    },
  );
  const runtimeRecord = decisionRuntimeRecord(completion, "appraiser");
  if (completion.runtime === "deterministic") {
    return {
      runtimeRecord,
      skipReason: completion.warnings.length > 0
        ? "editorial_llm_appraiser_fallback_exhausted"
        : "no_image_capable_editorial_llm_runtime",
    };
  }
  return {
    result: normalizeAppraiserResult(completion.parsed),
    runtimeRecord,
  };
}

function hasImageCapableAppraiserRuntime(options: AppraiserStageOptions): boolean {
  if (options.appraiserFn || options.completeEditorialJsonImpl) return true;
  return availableEditorialLlmRuntimes(
    { images: [{ path: "__appraiser_frame__.jpg", mimeType: "image/jpeg" }] },
    options.editorialLlmOptions,
  ).length > 0;
}

function applyAppraiserSkipped(
  segmentsJson: SegmentsJson,
  reason: string,
  policyHash: string,
): boolean {
  let changed = false;
  const runtimeRecord = skippedRuntimeRecord(reason);
  for (const segment of segmentsJson.items as SegmentWithAppraisal[]) {
    segment.visual_appraisal = skippedVisualAppraisal(reason, runtimeRecord);
    segment.confidence = {
      ...segment.confidence,
      visual_appraisal: {
        score: 0,
        source: "appraiser",
        status: "unsupported",
      },
    };
    segment.provenance = {
      ...segment.provenance,
      visual_appraisal: buildSkippedAppraiserProvenance({
        policyHash,
        reason,
        runtimeRecord,
      }),
    };
    changed = true;
  }
  return changed;
}

function applyAppraiserShards(
  segmentsJson: SegmentsJson,
  shards: AppraiserShard[],
  policyHash: string,
): boolean {
  const shardBySegmentId = new Map(shards.map((shard) => [shard.segment_id, shard]));
  let changed = false;

  for (const segment of segmentsJson.items as SegmentWithAppraisal[]) {
    const shard = shardBySegmentId.get(segment.segment_id);
    if (shard?.skipReason) {
      segment.visual_appraisal = skippedVisualAppraisal(
        shard.skipReason,
        shard.runtimeRecord ?? skippedRuntimeRecord(shard.skipReason),
      );
      segment.confidence = {
        ...segment.confidence,
        visual_appraisal: {
          score: 0,
          source: "appraiser",
          status: "unsupported",
        },
      };
      segment.provenance = {
        ...segment.provenance,
        visual_appraisal: buildSkippedAppraiserProvenance({
          policyHash,
          reason: shard.skipReason,
          runtimeRecord: shard.runtimeRecord,
        }),
      };
      changed = true;
      continue;
    }
    if (!shard?.result || !shard.frame || !shard.requestHash || !shard.promptHash) continue;

    segment.visual_appraisal = {
      status: "ready",
      frame_us: shard.frame.frameUs,
      frame_path: shard.frame.frameRelPath,
      extracted_text: shard.result.extracted_text,
      place_hint: shard.result.place_hint,
      aesthetic_notes: shard.result.aesthetic_notes,
      appraisal_runtime: shard.runtimeRecord,
    };
    segment.visual_quality = mergeAppraiserVisualQuality(
      segment.visual_quality,
      shard.result.visual_quality,
      segment.visual_quality_measurements,
    );

    segment.confidence = {
      ...segment.confidence,
      visual_appraisal: {
        score: computeAppraisalConfidence(shard.result),
        source: shard.runtimeRecord?.runtime ?? shard.model,
        status: "ready",
      },
    };

    const provenance = buildAppraiserProvenance({
      policyHash,
      requestHash: shard.requestHash,
      model: shard.model,
      promptHash: shard.promptHash,
      runtimeRecord: shard.runtimeRecord,
    });
    segment.provenance = {
      ...segment.provenance,
      visual_quality: provenance,
      visual_appraisal: provenance,
    };
    changed = true;
  }

  return changed;
}

function buildAppraiserProvenance(options: {
  policyHash: string;
  requestHash: string;
  model: string;
  promptHash: string;
  runtimeRecord?: DecisionRuntimeRecord;
}): Record<string, string> {
  return {
    stage: "appraiser",
    method: "editorial_llm_single_frame_appraisal",
    connector_version: APPRAISER_CONNECTOR_VERSION,
    policy_hash: options.policyHash,
    request_hash: options.requestHash,
    ...(options.runtimeRecord?.runtime ? { runtime: options.runtimeRecord.runtime } : {}),
    model_alias: options.model,
    model_snapshot: options.model,
    prompt_template_id: APPRAISER_PROMPT_TEMPLATE_ID,
    prompt_hash: options.promptHash,
    response_format: APPRAISER_RESPONSE_FORMAT,
  };
}

function buildSkippedAppraiserProvenance(options: {
  policyHash: string;
  reason: string;
  runtimeRecord?: DecisionRuntimeRecord;
}): Record<string, string> {
  return {
    stage: "appraiser",
    method: "editorial_llm_single_frame_appraisal",
    connector_version: APPRAISER_CONNECTOR_VERSION,
    policy_hash: options.policyHash,
    request_hash: `skipped:${shortReason(options.reason)}`,
    runtime: options.runtimeRecord?.runtime ?? "skipped",
    prompt_template_id: APPRAISER_PROMPT_TEMPLATE_ID,
    prompt_hash: computeAppraiserPromptHash(),
    response_format: APPRAISER_RESPONSE_FORMAT,
    skipped_reason: options.reason,
  };
}

function skippedVisualAppraisal(
  reason: string,
  runtimeRecord: DecisionRuntimeRecord,
): SegmentVisualAppraisal {
  return {
    status: "skipped",
    skipped_reason: reason,
    appraisal_runtime: runtimeRecord,
  };
}

function skippedRuntimeRecord(reason: string): DecisionRuntimeRecord {
  return {
    runtime: "skipped",
    role: "appraiser",
    attempted_runtimes: [
      {
        runtime: "deterministic",
        status: "skipped",
        message: reason,
      },
    ],
    fallback_warnings: [reason],
  };
}

function measuredMotionQuality(
  measurements: VisualQualityMeasurements | undefined,
): number | undefined {
  const value = measurements?.metrics_measured.shake === true
    ? measurements.shake?.average_energy
    : undefined;
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : undefined;
}

function hasReusableAppraisal(
  segment: SegmentItem,
  frame: ExtractedAppraiserFrame,
  requestHash: string,
): boolean {
  const record = segment as SegmentWithAppraisal;
  return record.visual_appraisal?.frame_us === frame.frameUs &&
    record.visual_appraisal?.frame_path === frame.frameRelPath &&
    record.provenance?.visual_appraisal?.request_hash === requestHash;
}

function computeAppraisalConfidence(result: AppraiserResult): number {
  const values = [
    result.visual_quality.composition_score,
    result.visual_quality.light_quality,
    result.visual_quality.focus_sharpness,
    result.visual_quality.subject_prominence,
    result.place_hint.confidence,
    ...result.extracted_text.map((item) => item.confidence),
  ].filter((value) => Number.isFinite(value));

  if (values.length === 0) return 0.5;
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.max(0, Math.min(1, average));
}

function marlinSceneContext(segment: SegmentItem): string {
  return segment.summary?.trim() || "";
}

function selectAppraiserFrameUs(segment: SegmentItem): number {
  if (Number.isInteger(segment.rep_frame_us) && segment.rep_frame_us >= 0) {
    return segment.rep_frame_us;
  }
  return Math.max(0, Math.floor((segment.src_in_us + segment.src_out_us) / 2));
}

function formatSeconds(frameUs: number): string {
  return (frameUs / 1_000_000).toFixed(6).replace(/\.?0+$/, "") || "0";
}

function safeSegmentFilename(segmentId: string): string {
  return segmentId.replace(/[^A-Za-z0-9_-]+/g, "_");
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}

function mimeTypeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

function readFrameManifest(filePath: string): AppraiserFrameManifest | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as AppraiserFrameManifest;
  } catch {
    return null;
  }
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function shortReason(reason: string): string {
  return reason.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 48) || "unknown";
}

function execFilePromise(
  execFileImpl: ExecFileLike,
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFileImpl(command, args, { maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}
