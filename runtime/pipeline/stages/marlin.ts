import * as fs from "node:fs";
import * as path from "node:path";
import { resolvePolicy } from "../../policy-resolver.js";
import type { MarlinAssetEvents, MarlinEventsArtifact, MarlinFn, MarlinModelRecord } from "../../connectors/marlin-types.js";
import { createMarlinWorkerClient } from "../../connectors/marlin-local.js";
import {
  createMarlinEventsArtifact,
  MARLIN_CONNECTOR_VERSION,
  normalizeMarlinAssetEvents,
} from "../../connectors/marlin-normalize.js";
import { atomicWriteJson, readJsonIfExists } from "./_util.js";
import { prepareMarlinProxy } from "./marlin-proxy.js";

export const MARLIN_EVENTS_RELATIVE_PATH = "03_analysis/marlin_events.json";

export interface MarlinPolicy {
  enabled?: boolean;
  model_alias?: string;
  model_snapshot?: string;
  connector_version?: string;
  worker_path?: string;
  mock?: boolean;
  default_find_queries?: string[];
}

export interface MarlinAnalysisOptions {
  projectDir: string;
  projectId: string;
  sourceFiles: string[];
  marlinFn: MarlinFn;
  model?: MarlinModelRecord;
  queries?: string[];
  outputPath?: string;
}

interface AssetsDoc {
  items?: AssetDocItem[];
}

interface AssetDocItem {
  asset_id?: string;
  filename?: string;
  source_locator?: string;
}

interface MarlinAssetInput {
  assetId: string;
  sourcePath: string;
}

interface SegmentsDoc {
  project_id: string;
  artifact_version: string;
  items: SegmentDocItem[];
}

interface SegmentDocItem {
  segment_id: string;
  asset_id: string;
  src_in_us: number;
  src_out_us: number;
  interest_points?: Array<{
    frame_us: number;
    label: string;
    confidence: number;
  }>;
  peak_analysis?: {
    peak_moments?: Array<{
      peak_ref?: string;
      timestamp_us?: number;
      type?: string;
      confidence?: number;
      description?: string;
      source_pass?: string;
    }>;
    recommended_in_out?: {
      best_in_us?: number;
      best_out_us?: number;
      rationale?: string;
      source_pass?: string;
    };
    visual_energy_curve?: Array<{
      timestamp_us: number;
      energy: number;
      source?: string;
    }>;
    support_signals?: {
      motion_support_score?: number;
      audio_support_score?: number;
      fused_peak_score?: number;
    };
    provenance?: {
      coarse_prompt_template_id?: string;
      refine_prompt_template_id?: string;
      precision_mode?: string;
      fusion_version?: string;
      support_signal_version?: string;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface MarlinSegmentPeak {
  peakRef: string;
  timestampUs: number;
  startUs: number;
  endUs: number;
  type: "action_peak" | "emotional_peak" | "visual_peak";
  confidence: number;
  description: string;
  sourcePass: "marlin_caption" | "marlin_find";
}

const DEFAULT_MARLIN_QUERIES = [
  "the strongest action moment",
  "the strongest emotional reaction",
  "a clear visual reveal",
  "a person enters or exits",
];

export async function runMarlinAnalysis(opts: MarlinAnalysisOptions): Promise<string> {
  const absProjectDir = path.resolve(opts.projectDir);
  const outputPath = opts.outputPath ?? path.join(absProjectDir, MARLIN_EVENTS_RELATIVE_PATH);
  const model = opts.model ?? defaultMarlinModel();
  const queries = normalizeQueries(opts.queries);
  const assetInputs = loadMarlinAssetInputs(absProjectDir, opts.sourceFiles);

  const items = [];
  for (const asset of assetInputs) {
    // Bounded proxy: never hand an unbounded-resolution source to the
    // worker (marlin-proxy.ts). Timestamps are unaffected — the proxy
    // keeps the source duration, so spans map 1:1 onto the original.
    const proxy = await prepareMarlinProxy(absProjectDir, asset.sourcePath);
    const caption = await opts.marlinFn.caption(proxy.evaluationPath);
    const findResults = [];
    for (const query of queries) {
      findResults.push(await opts.marlinFn.find(proxy.evaluationPath, query));
    }
    items.push(
      normalizeMarlinAssetEvents({
        projectId: opts.projectId,
        assetId: asset.assetId,
        sourcePath: toProjectRelativePath(absProjectDir, asset.sourcePath),
        model,
        caption,
        findResults,
      }),
    );
  }

  // Incremental evidence: merge with any existing artifact so partial
  // evaluations accumulate instead of overwriting. Items for assets
  // re-evaluated in this run replace their previous entries; items for
  // assets not in this run are preserved. Representative coverage can
  // then be built up across several bounded runs.
  const existing = readJsonIfExists<MarlinEventsArtifact>(outputPath);
  const evaluatedAssetIds = new Set(items.map((item) => item.asset_id));
  const preserved = (existing?.items ?? []).filter(
    (item) => !evaluatedAssetIds.has(item.asset_id),
  );
  const mergedItems = [...preserved, ...items];

  const artifact = createMarlinEventsArtifact({
    projectId: opts.projectId,
    model,
    items: mergedItems,
  });
  atomicWriteJson(outputPath, artifact);
  applyMarlinEventsToSegments(absProjectDir, artifact);
  return outputPath;
}

export function applyMarlinEventsToSegments(projectDir: string, artifact: MarlinEventsArtifact): boolean {
  const absProjectDir = path.resolve(projectDir);
  const segmentsPath = path.join(absProjectDir, "03_analysis/segments.json");
  const segments = readJsonIfExists<SegmentsDoc>(segmentsPath);
  if (!segments?.items || segments.items.length === 0) {
    return false;
  }

  const eventsByAsset = new Map(artifact.items.map((item) => [item.asset_id, item]));
  let changed = false;
  const nextItems = segments.items.map((segment) => {
    const assetEvents = eventsByAsset.get(segment.asset_id);
    if (!assetEvents) return segment;
    const peak = bestMarlinPeakForSegment(segment, assetEvents);
    if (!peak) return segment;

    const existing = segment.peak_analysis;
    const shouldReplacePeakAnalysis =
      !existing ||
      isMarlinPeakAnalysis(existing) ||
      (existing.support_signals?.fused_peak_score ?? 0) < peak.confidence;

    const nextSegment: SegmentDocItem = { ...segment };
    nextSegment.interest_points = mergeInterestPoints(segment.interest_points, {
      frame_us: peak.timestampUs,
      label: `${peak.type}: ${peak.description}`,
      confidence: peak.confidence,
    });

    if (shouldReplacePeakAnalysis) {
      nextSegment.peak_analysis = buildMarlinPeakAnalysis(segment, peak);
    }
    changed = true;
    return nextSegment;
  });

  if (!changed) return false;
  atomicWriteJson(segmentsPath, { ...segments, items: nextItems });
  return true;
}

export function shouldRunMarlinAnalysis(projectDir: string, repoRoot?: string): boolean {
  const policy = resolveMarlinPolicy(projectDir, repoRoot);
  const envEnabled = process.env.VOS_MARLIN_ENABLED;
  if (envEnabled !== undefined) {
    return parseBoolean(envEnabled) ?? false;
  }
  return policy.enabled === true;
}

export function createMarlinFnFromEnvironment(projectDir: string, repoRoot?: string): MarlinFn {
  const policy = resolveMarlinPolicy(projectDir, repoRoot);
  const workerPath = process.env.VOS_MARLIN_WORKER ?? policy.worker_path;
  const mockFromEnv = process.env.VOS_MARLIN_MOCK !== undefined
    ? parseBoolean(process.env.VOS_MARLIN_MOCK)
    : undefined;

  return createMarlinWorkerClient({
    cwd: repoRoot ?? findRepoRoot(projectDir),
    pythonBinary: process.env.VOS_MARLIN_PYTHON,
    workerPath,
    model: process.env.VOS_MARLIN_MODEL ?? policy.model_alias,
    device: process.env.VOS_MARLIN_DEVICE,
    mock: mockFromEnv ?? policy.mock,
  });
}

export function marlinModelFromEnvironment(projectDir: string, repoRoot?: string): MarlinModelRecord {
  const policy = resolveMarlinPolicy(projectDir, repoRoot);
  const mockFromEnv = process.env.VOS_MARLIN_MOCK !== undefined
    ? parseBoolean(process.env.VOS_MARLIN_MOCK)
    : undefined;
  const isMock = mockFromEnv ?? policy.mock ?? false;
  return {
    provider: "marlin",
    model_alias: process.env.VOS_MARLIN_MODEL ?? policy.model_alias ?? "NemoStation/Marlin-2B",
    model_snapshot: process.env.VOS_MARLIN_MODEL_SNAPSHOT ?? policy.model_snapshot ?? "required_for_canonical_runs",
    connector_version: policy.connector_version ?? MARLIN_CONNECTOR_VERSION,
    inference_mode: isMock ? "mock" : "live",
  };
}

export function marlinQueriesFromEnvironment(projectDir: string, repoRoot?: string): string[] {
  const policy = resolveMarlinPolicy(projectDir, repoRoot);
  const envQueries = process.env.VOS_MARLIN_FIND_QUERIES;
  if (envQueries) {
    return normalizeQueries(envQueries.split(/\s*\|\|\s*|\s*,\s*/));
  }
  return normalizeQueries(policy.default_find_queries);
}

export function loadMarlinAssetInputs(projectDir: string, sourceFiles: string[]): MarlinAssetInput[] {
  const absProjectDir = path.resolve(projectDir);
  const assetsPath = path.join(absProjectDir, "03_analysis/assets.json");
  const assetsDoc = readJsonIfExists<AssetsDoc>(assetsPath);
  const sourceCandidates = sourceFiles.map((source) => path.resolve(absProjectDir, source));
  const items = Array.isArray(assetsDoc?.items) ? assetsDoc.items : [];

  if (items.length === 0) {
    return sourceCandidates.map((sourcePath, index) => ({
      assetId: `AST_MARLIN_${String(index + 1).padStart(4, "0")}`,
      sourcePath,
    }));
  }

  const inputs = items
    .filter((item): item is AssetDocItem & { asset_id: string } => Boolean(item.asset_id))
    .map((item, index) => ({
      assetId: item.asset_id,
      sourcePath: resolveAssetSourcePath(absProjectDir, item, sourceCandidates[index], sourceCandidates),
    }));

  if (sourceCandidates.length === 0) {
    return inputs;
  }

  const selected = inputs.filter((input) =>
    sourceCandidates.some((candidate) => pathsReferToSameSource(input.sourcePath, candidate))
  );
  return selected.length > 0 ? selected : inputs;
}

function bestMarlinPeakForSegment(
  segment: SegmentDocItem,
  assetEvents: MarlinAssetEvents,
): MarlinSegmentPeak | null {
  const candidates: MarlinSegmentPeak[] = [];

  for (const event of assetEvents.events) {
    const overlap = overlapUs(segment.src_in_us, segment.src_out_us, event.start_us, event.end_us);
    if (overlap <= 0) continue;
    const confidence = event.confidence ?? 0.7;
    candidates.push({
      peakRef: event.event_id,
      timestampUs: clampInteger(Math.round((event.start_us + event.end_us) / 2), segment.src_in_us, segment.src_out_us),
      startUs: Math.max(segment.src_in_us, event.start_us),
      endUs: Math.min(segment.src_out_us, event.end_us),
      type: classifyPeakType(event.description, "marlin_caption"),
      confidence,
      description: event.description,
      sourcePass: "marlin_caption",
    });
  }

  assetEvents.find_results.forEach((result, index) => {
    if (result.span_start_us == null || result.span_end_us == null || !result.format_ok) return;
    const overlap = overlapUs(segment.src_in_us, segment.src_out_us, result.span_start_us, result.span_end_us);
    if (overlap <= 0) return;
    const confidence = result.confidence ?? 0.75;
    candidates.push({
      peakRef: `MFIND_${sanitizeIdPart(assetEvents.asset_id)}_${String(index + 1).padStart(4, "0")}`,
      timestampUs: clampInteger(Math.round((result.span_start_us! + result.span_end_us!) / 2), segment.src_in_us, segment.src_out_us),
      startUs: Math.max(segment.src_in_us, result.span_start_us!),
      endUs: Math.min(segment.src_out_us, result.span_end_us!),
      type: classifyPeakType(result.query, "marlin_find"),
      confidence,
      description: result.query,
      sourcePass: "marlin_find",
    });
  });

  candidates.sort((a, b) =>
    b.confidence - a.confidence ||
    a.timestampUs - b.timestampUs ||
    a.peakRef.localeCompare(b.peakRef)
  );
  return candidates[0] ?? null;
}

function buildMarlinPeakAnalysis(segment: SegmentDocItem, peak: MarlinSegmentPeak) {
  const recommendedIn = clampInteger(peak.startUs - 500_000, segment.src_in_us, segment.src_out_us);
  const recommendedOut = clampInteger(peak.endUs + 500_000, segment.src_in_us, segment.src_out_us);
  const safeOut = recommendedOut > recommendedIn
    ? recommendedOut
    : clampInteger(recommendedIn + 1, segment.src_in_us, segment.src_out_us);

  return {
    peak_moments: [
      {
        peak_ref: peak.peakRef,
        timestamp_us: peak.timestampUs,
        type: peak.type,
        confidence: clamp01(peak.confidence),
        description: peak.description,
        source_pass: peak.sourcePass,
      },
    ],
    recommended_in_out: {
      best_in_us: recommendedIn,
      best_out_us: safeOut,
      rationale: "Marlin temporal semantic event overlapped this segment.",
      source_pass: peak.sourcePass,
    },
    visual_energy_curve: [
      { timestamp_us: segment.src_in_us, energy: 0.2, source: "marlin-local-v1" },
      { timestamp_us: peak.timestampUs, energy: clamp01(peak.confidence), source: peak.sourcePass },
      { timestamp_us: segment.src_out_us, energy: 0.2, source: "marlin-local-v1" },
    ],
    support_signals: {
      motion_support_score: peak.type === "action_peak" ? clamp01(peak.confidence) : 0.5,
      audio_support_score: 0,
      fused_peak_score: clamp01(peak.confidence),
    },
    provenance: {
      coarse_prompt_template_id: "marlin-caption-find-v1",
      refine_prompt_template_id: "marlin-caption-find-v1",
      precision_mode: "marlin_temporal_semantics",
      fusion_version: "marlin-segment-peak-v1",
      support_signal_version: "marlin-confidence-v1",
    },
  };
}

function mergeInterestPoints(
  current: SegmentDocItem["interest_points"],
  point: NonNullable<SegmentDocItem["interest_points"]>[number],
) {
  const items = [...(current ?? [])];
  const exists = items.some((item) =>
    Math.abs(item.frame_us - point.frame_us) <= 1 &&
    item.label === point.label
  );
  if (!exists) items.push(point);
  items.sort((a, b) => a.frame_us - b.frame_us || a.label.localeCompare(b.label));
  return items;
}

function isMarlinPeakAnalysis(peakAnalysis: NonNullable<SegmentDocItem["peak_analysis"]>): boolean {
  const mode = peakAnalysis.provenance?.precision_mode;
  const sourcePass = peakAnalysis.peak_moments?.[0]?.source_pass;
  return mode === "marlin_temporal_semantics" || Boolean(sourcePass?.startsWith("marlin_"));
}

function classifyPeakType(text: string, sourcePass: "marlin_caption" | "marlin_find"): MarlinSegmentPeak["type"] {
  const value = text.toLowerCase();
  if (/(emotion|reaction|smile|cry|laugh|surprise|joy|sad|angry|relief|hope)/.test(value)) {
    return "emotional_peak";
  }
  if (/(action|move|run|jump|enter|exit|fall|hit|ride|dance|gesture|reveal)/.test(value)) {
    return "action_peak";
  }
  return sourcePass === "marlin_find" ? "visual_peak" : "action_peak";
}

function overlapUs(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

function sanitizeIdPart(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_-]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  return sanitized || "ASSET";
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.round(Math.max(min, Math.min(value, max)));
}

function resolveMarlinPolicy(projectDir: string, repoRoot?: string): MarlinPolicy {
  const { resolved } = resolvePolicy(projectDir, repoRoot);
  const policy = resolved.marlin;
  return isRecord(policy) ? policy as MarlinPolicy : {};
}

function resolveAssetSourcePath(
  projectDir: string,
  item: AssetDocItem,
  indexedFallback: string | undefined,
  sourceCandidates: string[],
): string {
  if (item.source_locator) {
    return path.isAbsolute(item.source_locator)
      ? item.source_locator
      : path.resolve(projectDir, item.source_locator);
  }

  if (item.filename) {
    const byBasename = sourceCandidates.find((candidate) => path.basename(candidate) === item.filename);
    if (byBasename) return byBasename;
  }

  return indexedFallback ?? path.resolve(projectDir, item.filename ?? "unknown-source");
}

function pathsReferToSameSource(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return normalizedLeft === normalizedRight || path.basename(normalizedLeft) === path.basename(normalizedRight);
}

function normalizeQueries(queries: string[] | undefined): string[] {
  const normalized = (queries ?? DEFAULT_MARLIN_QUERIES)
    .map((query) => query.trim())
    .filter((query) => query.length > 0);
  return normalized.length > 0 ? normalized : DEFAULT_MARLIN_QUERIES;
}

function defaultMarlinModel(): MarlinModelRecord {
  return {
    provider: "marlin",
    model_alias: "NemoStation/Marlin-2B",
    model_snapshot: "required_for_canonical_runs",
    connector_version: MARLIN_CONNECTOR_VERSION,
  };
}

function toProjectRelativePath(projectDir: string, sourcePath: string): string {
  const relative = path.relative(projectDir, sourcePath);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative;
  }
  return sourcePath;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function findRepoRoot(from: string): string {
  let dir = path.resolve(from);
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "schemas"))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
