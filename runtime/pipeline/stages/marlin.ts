import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { resolvePolicy } from "../../policy-resolver.js";
import type { MarlinAssetEvents, MarlinEventsArtifact, MarlinFn, MarlinModelRecord } from "../../connectors/marlin-types.js";
import { createMarlinWorkerClient } from "../../connectors/marlin-local.js";
import {
  createMarlinEventsArtifact,
  MARLIN_CONNECTOR_VERSION,
  normalizeMarlinAssetEvents,
} from "../../connectors/marlin-normalize.js";
import {
  applyContextKnowledgeToSummary,
  contextKnowledgeFromBrief,
  type ContextKnowledge,
} from "../../context-knowledge.js";
import { atomicWriteJson, readJsonIfExists } from "./_util.js";
import { createMarlinRangeProxy, prepareMarlinProxy, probeVideoDurationSeconds } from "./marlin-proxy.js";
import { loadSourceMap, type MediaSourceMapEntry } from "../../media/source-map.js";

export const MARLIN_EVENTS_RELATIVE_PATH = "03_analysis/marlin_events.json";
export const MARLIN_REPORTER_METHOD = "marlin_reporter";
export const MARLIN_SUMMARY_MODEL_ID = "marlin-2b";
export const MARLIN_SUMMARY_PROMPT_TEMPLATE_ID = "marlin-caption-v1";

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
  skipExisting?: boolean;
  maxSources?: number;
  captionOnly?: boolean;
  chunkSeconds?: number;
  chunkOverlapSeconds?: number;
  maxChunks?: number;
}

interface AssetsDoc {
  items?: AssetDocItem[];
}

interface AssetDocItem {
  asset_id?: string;
  filename?: string;
  source_locator?: string;
}

export interface MarlinAssetInput {
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
  summary?: string;
  tags?: string[];
  confidence?: Record<string, unknown>;
  provenance?: Record<string, unknown>;
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

interface MarlinChunkBoundary {
  index: number;
  startSec: number;
  endSec: number;
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
  const chunkingEnabled = opts.chunkSeconds !== undefined;
  const assetInputs = selectMarlinAssetInputsForRun(
    loadMarlinAssetInputs(absProjectDir, opts.sourceFiles),
    {
      outputPath,
      skipExisting: opts.skipExisting && !chunkingEnabled,
      maxSources: opts.maxSources,
    },
  );

  const items: MarlinAssetEvents[] = [];
  for (const asset of assetInputs) {
    const assetItem = chunkingEnabled
      ? await runMarlinAssetChunks({
        opts,
        projectDir: absProjectDir,
        outputPath,
        model,
        queries,
        asset,
        items,
      })
      : await runMarlinWholeAsset({
        opts,
        projectDir: absProjectDir,
        model,
        queries,
        asset,
      });

    if (assetItem) {
      upsertAssetItem(items, assetItem);
      writeMarlinArtifactCheckpoint({
        projectDir: absProjectDir,
        projectId: opts.projectId,
        outputPath,
        model,
        items,
      });
    }
  }

  return writeMarlinArtifactCheckpoint({
    projectDir: absProjectDir,
    projectId: opts.projectId,
    outputPath,
    model,
    items,
  });
}

async function runMarlinWholeAsset(args: {
  opts: MarlinAnalysisOptions;
  projectDir: string;
  model: MarlinModelRecord;
  queries: string[];
  asset: MarlinAssetInput;
}): Promise<MarlinAssetEvents> {
  // Bounded proxy: never hand an unbounded-resolution source to the
  // worker (marlin-proxy.ts). Timestamps are unaffected — the proxy
  // keeps the source duration, so spans map 1:1 onto the original.
  const proxy = await prepareMarlinProxy(args.projectDir, args.asset.sourcePath);
  const caption = await args.opts.marlinFn.caption(proxy.evaluationPath);
  const findResults = [];
  if (!args.opts.captionOnly) {
    for (const query of args.queries) {
      findResults.push(await args.opts.marlinFn.find(proxy.evaluationPath, query));
    }
  }
  return normalizeMarlinAssetEvents({
    projectId: args.opts.projectId,
    assetId: args.asset.assetId,
    sourcePath: toProjectRelativePath(args.projectDir, args.asset.sourcePath),
    model: args.model,
    caption,
    findResults,
  });
}

async function runMarlinAssetChunks(args: {
  opts: MarlinAnalysisOptions;
  projectDir: string;
  outputPath: string;
  model: MarlinModelRecord;
  queries: string[];
  asset: MarlinAssetInput;
  items: MarlinAssetEvents[];
}): Promise<MarlinAssetEvents | null> {
  const existingArtifact = readJsonIfExists<MarlinEventsArtifact>(args.outputPath);
  let assetItem = cloneAssetItem(
    existingArtifact?.items.find((item) => item.asset_id === args.asset.assetId),
    args.asset,
    args.projectDir,
  );
  const chunks = await marlinChunksForAsset(args.asset.sourcePath, {
    chunkSeconds: args.opts.chunkSeconds,
    chunkOverlapSeconds: args.opts.chunkOverlapSeconds,
  });
  if (chunks === null) {
    return runMarlinWholeAsset({
      opts: args.opts,
      projectDir: args.projectDir,
      model: args.model,
      queries: args.queries,
      asset: args.asset,
    });
  }

  const completed = args.opts.skipExisting ? completedChunkIndices(assetItem) : new Set<number>();
  let selectedChunks = chunks.filter((chunk) => !completed.has(chunk.index));
  if (args.opts.maxChunks !== undefined) {
    selectedChunks = selectedChunks.slice(0, args.opts.maxChunks);
  }
  if (selectedChunks.length === 0) {
    return null;
  }

  for (const chunk of selectedChunks) {
    const range = await createMarlinRangeProxy(
      args.projectDir,
      args.asset.sourcePath,
      chunk.startSec,
      chunk.endSec,
    );
    const proxy = await prepareMarlinProxy(args.projectDir, range.rangePath);
    const caption = await args.opts.marlinFn.caption(proxy.evaluationPath);
    const findResults = [];
    if (!args.opts.captionOnly) {
      for (const query of args.queries) {
        findResults.push(await args.opts.marlinFn.find(proxy.evaluationPath, query));
      }
    }
    const chunkItem = normalizeMarlinAssetEvents({
      projectId: args.opts.projectId,
      assetId: args.asset.assetId,
      sourcePath: toProjectRelativePath(args.projectDir, args.asset.sourcePath),
      model: args.model,
      caption,
      findResults,
      chunkOffsetUs: Math.round(chunk.startSec * 1_000_000),
      chunkIndex: chunk.index,
    });
    assetItem = mergeMarlinChunkItem(assetItem, chunkItem, chunk);
    upsertAssetItem(args.items, assetItem);
    writeMarlinArtifactCheckpoint({
      projectDir: args.projectDir,
      projectId: args.opts.projectId,
      outputPath: args.outputPath,
      model: args.model,
      items: args.items,
    });
  }

  return assetItem;
}

export function computeMarlinChunkBoundaries(
  durationSec: number,
  chunkSeconds: number,
  chunkOverlapSeconds = 0,
): MarlinChunkBoundary[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    return [];
  }
  if (!Number.isFinite(chunkSeconds) || chunkSeconds <= 0) {
    throw new Error("--chunk-seconds requires a positive number");
  }
  if (!Number.isFinite(chunkOverlapSeconds) || chunkOverlapSeconds < 0) {
    throw new Error("--chunk-overlap-seconds requires a non-negative number");
  }
  if (chunkOverlapSeconds >= chunkSeconds) {
    throw new Error("--chunk-overlap-seconds must be smaller than --chunk-seconds");
  }
  if (durationSec <= chunkSeconds) {
    return [{ index: 0, startSec: 0, endSec: durationSec }];
  }

  const chunks: MarlinChunkBoundary[] = [];
  const step = chunkSeconds - chunkOverlapSeconds;
  let startSec = 0;
  let index = 0;
  while (startSec < durationSec) {
    const endSec = Math.min(durationSec, startSec + chunkSeconds);
    chunks.push({ index, startSec, endSec });
    if (endSec >= durationSec) break;
    startSec += step;
    index += 1;
  }
  return chunks;
}

async function marlinChunksForAsset(
  sourcePath: string,
  options: {
    chunkSeconds?: number;
    chunkOverlapSeconds?: number;
  },
): Promise<MarlinChunkBoundary[] | null> {
  if (options.chunkSeconds === undefined) {
    return null;
  }
  const durationSec = await probeVideoDurationSeconds(sourcePath);
  if (durationSec === null || durationSec <= options.chunkSeconds) {
    return null;
  }
  return computeMarlinChunkBoundaries(
    durationSec,
    options.chunkSeconds,
    options.chunkOverlapSeconds ?? 0,
  );
}

function cloneAssetItem(
  item: MarlinAssetEvents | undefined,
  asset: MarlinAssetInput,
  projectDir: string,
): MarlinAssetEvents {
  if (!item) {
    return {
      asset_id: asset.assetId,
      source_path: toProjectRelativePath(projectDir, asset.sourcePath),
      scene: "",
      events: [],
      find_results: [],
    };
  }
  return {
    ...item,
    events: [...item.events],
    find_results: [...item.find_results],
  };
}

function completedChunkIndices(item: MarlinAssetEvents): Set<number> {
  const indices = new Set<number>();
  for (const event of item.events) {
    if (event.chunk_index !== undefined) {
      indices.add(event.chunk_index);
    }
  }
  return indices;
}

function mergeMarlinChunkItem(
  existing: MarlinAssetEvents,
  chunkItem: MarlinAssetEvents,
  chunk: MarlinChunkBoundary,
): MarlinAssetEvents {
  const chunkStartUs = Math.round(chunk.startSec * 1_000_000);
  const chunkEndUs = Math.round(chunk.endSec * 1_000_000);
  const events = [
    ...existing.events.filter((event) => event.chunk_index !== chunk.index),
    ...chunkItem.events,
  ].sort((a, b) => a.start_us - b.start_us || a.event_id.localeCompare(b.event_id));
  const findResults = [
    ...existing.find_results.filter((result) =>
      result.span_start_us === null ||
      result.span_start_us < chunkStartUs ||
      result.span_start_us >= chunkEndUs
    ),
    ...chunkItem.find_results,
  ];

  return {
    ...existing,
    scene: appendUniqueText(existing.scene, chunkItem.scene, " / "),
    caption: appendOptionalText(existing.caption, chunkItem.caption),
    events,
    find_results: findResults,
  };
}

function appendUniqueText(existing: string | undefined, next: string | undefined, separator: string): string {
  const trimmedExisting = existing?.trim() ?? "";
  const trimmedNext = next?.trim() ?? "";
  if (!trimmedNext) return trimmedExisting;
  if (!trimmedExisting) return trimmedNext;
  if (trimmedExisting.includes(trimmedNext)) return trimmedExisting;
  return `${trimmedExisting}${separator}${trimmedNext}`;
}

function appendOptionalText(existing: string | undefined, next: string | undefined): string | undefined {
  const value = appendUniqueText(existing, next, "\n");
  return value || undefined;
}

function upsertAssetItem(items: MarlinAssetEvents[], item: MarlinAssetEvents): void {
  const index = items.findIndex((candidate) => candidate.asset_id === item.asset_id);
  if (index >= 0) {
    items[index] = item;
  } else {
    items.push(item);
  }
}

function writeMarlinArtifactCheckpoint(args: {
  projectDir: string;
  projectId: string;
  outputPath: string;
  model: MarlinModelRecord;
  items: MarlinAssetEvents[];
}): string {
  // Incremental evidence: merge with any existing artifact so partial
  // evaluations accumulate instead of overwriting. Items for assets
  // re-evaluated in this run replace their previous entries; items for
  // assets not in this run are preserved. Representative coverage can
  // then be built up across several bounded runs.
  const existing = readJsonIfExists<MarlinEventsArtifact>(args.outputPath);
  const evaluatedAssetIds = new Set(args.items.map((item) => item.asset_id));
  const preserved = (existing?.items ?? []).filter(
    (item) => !evaluatedAssetIds.has(item.asset_id),
  );
  const mergedItems = [...preserved, ...args.items];

  const artifact = createMarlinEventsArtifact({
    projectId: args.projectId,
    model: args.model,
    items: mergedItems,
  });
  atomicWriteJson(args.outputPath, artifact);
  applyMarlinEventsToSegments(args.projectDir, artifact);
  return args.outputPath;
}

export function applyMarlinEventsToSegments(projectDir: string, artifact: MarlinEventsArtifact): boolean {
  const absProjectDir = path.resolve(projectDir);
  const segmentsPath = path.join(absProjectDir, "03_analysis/segments.json");
  const segments = readJsonIfExists<SegmentsDoc>(segmentsPath);
  if (!segments?.items || segments.items.length === 0) {
    return false;
  }
  const contextKnowledge = loadBriefContextKnowledge(absProjectDir);

  const eventsByAsset = new Map(artifact.items.map((item) => [item.asset_id, item]));
  let changed = false;
  const nextItems = segments.items.map((segment) => {
    const assetEvents = eventsByAsset.get(segment.asset_id);
    if (!assetEvents) return segment;

    const scene = applyContextKnowledgeToSummary(normalizeScene(assetEvents.scene), contextKnowledge);
    const peaks = marlinPeaksForSegment(segment, assetEvents);
    const peak = peaks[0] ?? null;
    if (!scene && !peak) return segment;

    const nextSegment: SegmentDocItem = { ...segment };

    if (scene) {
      nextSegment.summary = scene;
      nextSegment.tags = mergeTags(segment.tags, extractTagsFromScene(scene));
      nextSegment.confidence = {
        ...(isRecord(segment.confidence) ? segment.confidence : {}),
        summary: {
          score: marlinSummaryConfidence(peaks),
          source: MARLIN_SUMMARY_MODEL_ID,
          status: "ready",
        },
      };
      nextSegment.provenance = {
        ...(isRecord(segment.provenance) ? segment.provenance : {}),
        summary: buildMarlinSummaryProvenance(artifact, assetEvents, segment, scene),
      };
      changed = true;
    }

    if (peak) {
      const existing = segment.peak_analysis;
      const shouldReplacePeakAnalysis =
        !existing ||
        isMarlinPeakAnalysis(existing) ||
        isDegradedPeakAnalysis(existing) ||
        (existing.support_signals?.fused_peak_score ?? 0) < peak.confidence;

      let interestPoints = nextSegment.interest_points ?? segment.interest_points;
      for (const relevantPeak of peaks.slice(0, 3)) {
        interestPoints = mergeInterestPoints(interestPoints, {
          frame_us: relevantPeak.timestampUs,
          label: `${relevantPeak.type}: ${relevantPeak.description}`,
          confidence: relevantPeak.confidence,
        });
      }
      nextSegment.interest_points = interestPoints;

      if (shouldReplacePeakAnalysis) {
        nextSegment.peak_analysis = buildMarlinPeakAnalysis(segment, peak);
      }
      changed = true;
    }
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

export function createMarlinFnFromEnvironment(
  projectDir: string,
  repoRoot?: string,
  overrides: { requestTimeoutMs?: number } = {},
): MarlinFn {
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
    requestTimeoutMs: overrides.requestTimeoutMs,
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
  const sourceMap = loadSourceMap(absProjectDir);

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
      sourcePath: resolveAssetSourcePath(
        absProjectDir,
        item,
        sourceMap.entryMap.get(item.asset_id),
        sourceCandidates[index],
        sourceCandidates,
      ),
    }));

  if (sourceCandidates.length === 0) {
    return inputs;
  }

  const selected = inputs.filter((input) =>
    sourceCandidates.some((candidate) => pathsReferToSameSource(input.sourcePath, candidate))
  );
  return selected.length > 0 ? selected : inputs;
}

export function selectMarlinAssetInputsForRun(
  inputs: MarlinAssetInput[],
  options: {
    outputPath: string;
    skipExisting?: boolean;
    maxSources?: number;
  },
): MarlinAssetInput[] {
  let selected = inputs;
  if (options.skipExisting) {
    const existing = readJsonIfExists<MarlinEventsArtifact>(options.outputPath);
    const existingAssetIds = new Set((existing?.items ?? []).map((item) => item.asset_id));
    selected = selected.filter((input) => !existingAssetIds.has(input.assetId));
  }
  if (options.maxSources !== undefined) {
    selected = selected.slice(0, options.maxSources);
  }
  return selected;
}

function marlinPeaksForSegment(
  segment: SegmentDocItem,
  assetEvents: MarlinAssetEvents,
): MarlinSegmentPeak[] {
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
  return candidates;
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

export function extractTagsFromScene(scene: string): string[] {
  const normalized = scene.toLowerCase().replace(/['']/g, "");
  const tags: string[] = [];

  const phrasePatterns: Array<[RegExp, string]> = [
    [/\bgrape\s+vineyards?\b/, "grape_vineyard"],
    [/\bsoba\s+noodles?\b/, "soba_noodles"],
    [/\btraditional\s+(?:wooden\s+)?buildings?\b/, "traditional_building"],
    [/\bwooden\s+buildings?\b/, "wooden_building"],
    [/\brice\s+fields?\b/, "rice_field"],
    [/\bmountain\s+trails?\b/, "mountain_trail"],
    [/\btea\s+ceremony\b/, "tea_ceremony"],
    [/\bcraft\s+workshops?\b/, "craft_workshop"],
  ];
  for (const [pattern, tag] of phrasePatterns) {
    if (pattern.test(normalized)) tags.push(tag);
  }

  const words = normalized
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((word) => word.replace(/^-+|-+$/g, ""))
    .filter((word) => word.length >= 3 && !SCENE_TAG_STOPWORDS.has(word));

  for (const chunk of sceneChunks(words)) {
    if (chunk.length < 2) continue;
    const compact = compactSceneChunk(chunk);
    if (compact.length < 2) continue;
    tags.push(compact.slice(0, 3).join("_"));
  }

  return uniqueTags(tags).slice(0, 8);
}

const SCENE_TAG_STOPWORDS = new Set([
  "the", "and", "with", "while", "into", "onto", "from", "that", "this",
  "there", "their", "over", "under", "near", "inside", "outside", "across",
  "through", "during", "before", "after", "being", "been", "are", "was",
  "were", "has", "have", "had", "show", "shows", "showing", "scene", "shot",
  "video", "clip", "camera", "view", "visible", "background", "foreground",
  "person", "people", "someone", "object", "objects", "area", "prepared",
  "preparing", "standing", "sitting", "walking", "holding", "looking",
]);

const SCENE_CHUNK_BREAKERS = new Set([
  "in", "on", "at", "by", "for", "to", "of", "as", "is", "a", "an",
  "or", "but", "then", "where", "when",
]);

const WEAK_SCENE_MODIFIERS = new Set([
  "clear", "wide", "close", "small", "large", "simple", "several", "many",
  "various", "local", "outdoor", "indoor",
]);

function sceneChunks(words: string[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  for (const word of words) {
    if (SCENE_CHUNK_BREAKERS.has(word)) {
      if (current.length > 0) chunks.push(current);
      current = [];
      continue;
    }
    current.push(word);
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function compactSceneChunk(chunk: string[]): string[] {
  const compact = chunk.filter((word) => !WEAK_SCENE_MODIFIERS.has(word));
  if (compact.length >= 2) return compact;
  return chunk;
}

function mergeTags(current: string[] | undefined, additions: string[]): string[] {
  return uniqueTags([...(current ?? []), ...additions]);
}

function uniqueTags(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const tag = normalizeTag(value);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    result.push(tag);
  }
  return result;
}

function normalizeTag(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

function normalizeScene(scene: string | undefined): string {
  return scene?.trim().replace(/\s+/g, " ") ?? "";
}

function loadBriefContextKnowledge(projectDir: string): ContextKnowledge | undefined {
  const briefPath = path.join(projectDir, "01_intent", "creative_brief.yaml");
  if (!fs.existsSync(briefPath)) return undefined;
  try {
    const parsed = parseYaml(fs.readFileSync(briefPath, "utf-8"));
    return contextKnowledgeFromBrief(parsed);
  } catch {
    return undefined;
  }
}

function marlinSummaryConfidence(peaks: MarlinSegmentPeak[]): number {
  const bestPeak = peaks[0];
  if (!bestPeak) return 0.8;
  return clamp01(Math.max(0.8, bestPeak.confidence));
}

function buildMarlinSummaryProvenance(
  artifact: MarlinEventsArtifact,
  assetEvents: MarlinAssetEvents,
  segment: SegmentDocItem,
  scene: string,
): Record<string, string> {
  const modelSnapshot = artifact.model.model_snapshot || "unknown";
  const promptHash = stableHash({
    prompt_template_id: MARLIN_SUMMARY_PROMPT_TEMPLATE_ID,
    method: MARLIN_REPORTER_METHOD,
  });
  return {
    stage: "marlin",
    method: MARLIN_REPORTER_METHOD,
    connector_version: artifact.model.connector_version ?? MARLIN_CONNECTOR_VERSION,
    policy_hash: stableHash({
      model_alias: artifact.model.model_alias,
      model_snapshot: modelSnapshot,
      prompt_template_id: MARLIN_SUMMARY_PROMPT_TEMPLATE_ID,
    }),
    request_hash: stableHash({
      asset_id: assetEvents.asset_id,
      segment_id: segment.segment_id,
      scene,
      event_ids: assetEvents.events.map((event) => event.event_id),
    }),
    model_alias: MARLIN_SUMMARY_MODEL_ID,
    model_snapshot: modelSnapshot,
    prompt_template_id: MARLIN_SUMMARY_PROMPT_TEMPLATE_ID,
    prompt_hash: promptHash,
    response_format: "marlin_events_v1",
  };
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function isMarlinPeakAnalysis(peakAnalysis: NonNullable<SegmentDocItem["peak_analysis"]>): boolean {
  const mode = peakAnalysis.provenance?.precision_mode;
  const sourcePass = peakAnalysis.peak_moments?.[0]?.source_pass;
  return mode === "marlin_temporal_semantics" || Boolean(sourcePass?.startsWith("marlin_"));
}

function isDegradedPeakAnalysis(peakAnalysis: NonNullable<SegmentDocItem["peak_analysis"]>): boolean {
  const mode = peakAnalysis.provenance?.precision_mode;
  const fusionVersion = peakAnalysis.provenance?.fusion_version;
  const sourcePass = peakAnalysis.peak_moments?.[0]?.source_pass;
  return mode === "never" ||
    Boolean(fusionVersion?.startsWith("degraded-")) ||
    Boolean(sourcePass?.startsWith("degraded_"));
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
  sourceMapEntry: MediaSourceMapEntry | undefined,
  indexedFallback: string | undefined,
  sourceCandidates: string[],
): string {
  if (item.source_locator) {
    return path.isAbsolute(item.source_locator)
      ? item.source_locator
      : path.resolve(projectDir, item.source_locator);
  }

  if (sourceMapEntry?.local_source_path) {
    return path.resolve(sourceMapEntry.local_source_path);
  }
  if (sourceMapEntry?.source_locator) {
    return path.resolve(sourceMapEntry.source_locator);
  }
  if (sourceMapEntry?.link_path) {
    return path.resolve(projectDir, sourceMapEntry.link_path);
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
