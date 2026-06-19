import * as fs from "node:fs";
import * as path from "node:path";
import { buildFootageDb } from "../artifacts/footage-db-builder.js";
import { readFootageDbStatus } from "../artifacts/footage-db.js";
import type { MediaSourceMapEntry } from "../media/source-map.js";
import {
  bestForBeat,
  searchFootage,
  similarFootage,
  unusedFootage,
  type FootageSearchFilters,
  type FootageSearchMode,
  type FootageSearchResult,
  type FootageSearchResponse,
  type VisualFrameType,
} from "./footage-search.js";
import {
  ensureMarlinWorker,
  marlinAnalyzeRange,
  marlinExtractFrame,
  marlinFindMoment,
} from "./marlin-tools.js";

export interface EditorialTool {
  name: string;
  description: string;
  parameters: Record<string, EditorialToolParameterDefinition>;
  execute: (params: Record<string, unknown>) => Promise<unknown>;
}

export interface EditorialToolParameterDefinition {
  type: string;
  description: string;
  enum?: string[];
  default?: string | number | boolean;
  required?: boolean;
}

export type EditorialToolDefinition = Omit<EditorialTool, "execute">;

export interface ToolSearchResult extends FootageSearchResult {
  score_breakdown?: {
    e5_text?: number;
    qwen_visual?: number;
    lexical?: number;
    final: number;
  };
  matched_frame_path?: string;
  matched_embedding_type?: string;
  unavailable_channels?: string[];
}

type ToolSearchResponse = Omit<FootageSearchResponse, "results"> & {
  results: ToolSearchResult[];
};

export const EDITORIAL_TOOL_DEFINITIONS: EditorialToolDefinition[] = [
  {
    name: "analyze_clip_range",
    description: "Analyze what happens in a clip between source timestamps A and B using Marlin.",
    parameters: {
      asset_id: { type: "string", description: "Asset id from the selected clip evidence." },
      start_sec: { type: "number", description: "Source timestamp where the analysis range starts, in seconds." },
      end_sec: { type: "number", description: "Source timestamp where the analysis range ends, in seconds." },
    },
  },
  {
    name: "find_moment",
    description: "Find where a specific action, camera state, or visual moment occurs in a clip.",
    parameters: {
      asset_id: { type: "string", description: "Asset id from the selected clip evidence." },
      query: { type: "string", description: "Natural-language moment to locate, such as camera shake or smile." },
    },
  },
  {
    name: "extract_frame",
    description: "Extract a single source frame at a timestamp for visual inspection.",
    parameters: {
      asset_id: { type: "string", description: "Asset id from the selected clip evidence." },
      timestamp_sec: { type: "number", description: "Source timestamp to inspect, in seconds." },
    },
  },
  {
    name: "compare_frames",
    description: "Extract two source frames from one clip so they can be compared side by side by the calling agent.",
    parameters: {
      asset_id: { type: "string", description: "Asset id from the selected clip evidence." },
      timestamp_a_sec: { type: "number", description: "First source timestamp to inspect, in seconds." },
      timestamp_b_sec: { type: "number", description: "Second source timestamp to inspect, in seconds." },
    },
  },
  {
    name: "search_footage",
    description: "Search the full analyzed footage pool by text, structured filters, visual frame similarity, or mixed text+image evidence. Use mode=visual with image_query_path or a visual anchor for Qwen3-VL search. Read-only.",
    parameters: {
      query: { type: "string", description: "Text search query. Empty string for image-only search." },
      mode: { type: "string", description: "Search mode. Defaults to hybrid.", enum: ["hybrid", "text", "semantic", "structured", "visual", "multimodal"], default: "hybrid" },
      filters_json: { type: "string", description: "JSON filters object" },
      limit: { type: "number", description: "Optional result limit. Defaults to 10.", default: 10 },
      image_query_path: { type: "string", description: "Absolute path to query frame for visual/multimodal search" },
      visual_anchor_segment_id: { type: "string", description: "Segment ID to use as visual anchor" },
      visual_anchor_frame_type: { type: "string", description: "Stored frame type to use for visual anchor", enum: ["visual_representative", "visual_keyframe_in", "visual_keyframe_peak", "visual_keyframe_out"] },
      visual_goal: { type: "string", description: "Visual retrieval goal", enum: ["similarity", "palette", "shot_scale", "match_cut"] },
    },
  },
  {
    name: "visual_search",
    description: "Find clips visually similar to a frame. Uses Qwen3-VL embedding.",
    parameters: {
      query_frame_path: { type: "string", required: true, description: "Absolute path to the query frame" },
      text_hint: { type: "string", description: "Optional text to combine with visual search" },
      exclude_segment_ids: { type: "string", description: "Comma-separated segment IDs to exclude" },
      limit: { type: "number", description: "Optional result limit. Defaults to 5.", default: 5 },
    },
  },
  {
    name: "similar_to",
    description: "Find full-pool clips similar to a known segment while excluding that segment. Defaults to visual similarity via the segment's representative frame when Qwen3-VL embeddings are available, with text fallback. Read-only.",
    parameters: {
      segment_id: { type: "string", description: "Segment id to use as the similarity anchor." },
      use_visual: { type: "boolean", description: "Use visual similarity when available. Defaults to true.", default: true },
      limit: { type: "number", description: "Optional result limit." },
    },
  },
  {
    name: "unused_footage",
    description: "Find strong clips that are not already selected. Read-only.",
    parameters: {
      exclude_segment_ids: { type: "array", description: "Segment ids already used or rejected." },
      min_quality: { type: "number", description: "Optional minimum composition quality threshold from 0 to 1." },
      limit: { type: "number", description: "Optional result limit." },
    },
  },
  {
    name: "best_for_beat",
    description: "Search for the strongest clip for a beat purpose and emotional target. Read-only.",
    parameters: {
      beat_purpose: { type: "string", description: "Editorial need for the beat, such as establish place or show payoff reaction." },
      emotion: { type: "string", description: "Optional emotional keyword or visual mood to combine with the beat purpose." },
      exclude_segment_ids: { type: "array", description: "Segment ids to avoid when proposing a replacement." },
      limit: { type: "number", description: "Optional result limit." },
    },
  },
];

function stringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value.trim();
}

function numberParam(params: Record<string, unknown>, key: string): number {
  const value = params[key];
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(number)) {
    throw new Error(`${key} must be a finite number`);
  }
  return number;
}

function optionalStringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalNumberParam(params: Record<string, unknown>, key: string): number | undefined {
  if (!(key in params) || params[key] == null) return undefined;
  return numberParam(params, key);
}

function stringArrayParam(params: Record<string, unknown>, key: string): string[] {
  const value = params[key];
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${key} must be an array of strings`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function commaSeparatedStringParam(params: Record<string, unknown>, key: string): string[] {
  const value = params[key];
  if (value == null) return [];
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value.map((item) => item.trim()).filter(Boolean);
  }
  if (typeof value !== "string") {
    throw new Error(`${key} must be a comma-separated string`);
  }
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function optionalBooleanParam(params: Record<string, unknown>, key: string): boolean | undefined {
  if (!(key in params) || params[key] == null || params[key] === "") return undefined;
  const value = params[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0") return false;
  }
  throw new Error(`${key} must be a boolean`);
}

function parseMode(value: unknown): FootageSearchMode | undefined {
  if (value == null || value === "") return undefined;
  if (
    value === "hybrid"
    || value === "text"
    || value === "semantic"
    || value === "structured"
    || value === "visual"
    || value === "multimodal"
  ) {
    return value;
  }
  throw new Error("mode must be hybrid, text, semantic, structured, visual, or multimodal");
}

function parseFilters(params: Record<string, unknown>): FootageSearchFilters | undefined {
  const objectValue = params.filters;
  if (objectValue && typeof objectValue === "object" && !Array.isArray(objectValue)) {
    return objectValue as FootageSearchFilters;
  }
  const jsonValue = optionalStringParam(params, "filters_json");
  if (!jsonValue) return undefined;
  const parsed = JSON.parse(jsonValue) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("filters_json must be a JSON object");
  }
  return parsed as FootageSearchFilters;
}

function searchToolQueryParam(params: Record<string, unknown>, mode: FootageSearchMode | undefined): string {
  if (mode === "visual" || mode === "multimodal") {
    const value = params.query;
    return typeof value === "string" ? value.trim() : "";
  }
  return stringParam(params, "query");
}

function parseVisualFrameType(value: unknown): VisualFrameType | undefined {
  if (value == null || value === "") return undefined;
  if (
    value === "visual_representative"
    || value === "visual_keyframe_in"
    || value === "visual_keyframe_peak"
    || value === "visual_keyframe_out"
  ) {
    return value;
  }
  throw new Error("visual_anchor_frame_type must be visual_representative, visual_keyframe_in, visual_keyframe_peak, or visual_keyframe_out");
}

function parseVisualAnchor(params: Record<string, unknown>): { segment_id: string; frame_type?: VisualFrameType } | undefined {
  const frameType = parseVisualFrameType(params.visual_anchor_frame_type);
  const segmentId = optionalStringParam(params, "visual_anchor_segment_id");
  if (!segmentId) return undefined;
  return {
    segment_id: segmentId,
    frame_type: frameType,
  };
}

function parseVisualGoal(value: unknown): "similarity" | "palette" | "shot_scale" | "match_cut" | undefined {
  if (value == null || value === "") return undefined;
  if (value === "similarity" || value === "palette" || value === "shot_scale" || value === "match_cut") {
    return value;
  }
  throw new Error("visual_goal must be similarity, palette, shot_scale, or match_cut");
}

function withAdditionalWarnings(response: FootageSearchResponse, warnings: string[]): FootageSearchResponse {
  if (warnings.length === 0) return response;
  return {
    ...response,
    warnings: Array.from(new Set([...warnings, ...response.warnings])),
  };
}

function formatToolSearchResponse(response: FootageSearchResponse): ToolSearchResponse {
  return {
    ...response,
    results: response.results.map(formatToolSearchResult),
  };
}

function formatToolSearchResult(result: FootageSearchResult): ToolSearchResult {
  const visualMatch = [...(result.scores.embedding_matches ?? [])]
    .filter((match) => match.embedding_type.startsWith("visual_") && match.source_ref)
    .sort((a, b) => b.score - a.score || a.embedding_type.localeCompare(b.embedding_type))[0];
  return {
    ...result,
    score_breakdown: {
      e5_text: result.scores.e5_text ?? result.scores.semantic,
      qwen_visual: result.scores.qwen_visual,
      lexical: result.scores.lexical,
      final: result.scores.final,
    },
    matched_frame_path: visualMatch?.source_ref,
    matched_embedding_type: visualMatch?.embedding_type,
    unavailable_channels: result.scores.unavailable_channels,
  };
}

async function ensureSearchDatabase(projectDir: string): Promise<string[]> {
  const status = readFootageDbStatus(projectDir);
  if (status.status === "ready") return [];

  try {
    await buildFootageDb({ projectDir, embeddingPolicy: "auto" });
    return [`footage DB was ${status.status}; rebuilt before search`];
  } catch (error) {
    return [
      `footage DB was ${status.status}; build failed, using available search fallback: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ];
  }
}

async function runFootageToolSearch(
  projectDir: string,
  search: () => Promise<FootageSearchResponse>,
): Promise<FootageSearchResponse> {
  const buildWarnings = await ensureSearchDatabase(projectDir);
  const response = await search();
  return withAdditionalWarnings(response, buildWarnings);
}

async function runFormattedFootageToolSearch(
  projectDir: string,
  search: () => Promise<FootageSearchResponse>,
): Promise<ToolSearchResponse> {
  return formatToolSearchResponse(await runFootageToolSearch(projectDir, search));
}

function shouldFallbackFromVisualSimilarity(response: FootageSearchResponse): boolean {
  const hasVisualScore = response.results.some((result) =>
    result.scores.qwen_visual != null
    || (result.scores.embedding_matches ?? []).some((match) => match.embedding_type.startsWith("visual_"))
  );
  if (hasVisualScore) return false;
  const warnings = response.warnings.join("\n").toLowerCase();
  return warnings.includes("visual") || warnings.includes("qwen3vl");
}

function resolveCandidatePath(projectDir: string, candidate: string | undefined): string | undefined {
  if (!candidate) return undefined;
  const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(projectDir, candidate);
  return fs.existsSync(resolved) ? resolved : undefined;
}

function sourcePathForAsset(
  projectDir: string,
  sourceMap: Map<string, MediaSourceMapEntry>,
  assetId: string,
): string {
  const entry = sourceMap.get(assetId);
  if (!entry) {
    throw new Error(`Unknown asset_id: ${assetId}`);
  }

  const sourcePath = resolveCandidatePath(projectDir, entry.local_source_path)
    ?? resolveCandidatePath(projectDir, entry.source_locator)
    ?? resolveCandidatePath(projectDir, entry.link_path);

  if (!sourcePath) {
    throw new Error(`No readable source path found for asset_id ${assetId}`);
  }

  return sourcePath;
}

function sanitizeFilenamePart(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "") || "asset";
}

function frameOutputPath(
  projectDir: string,
  assetId: string,
  timestampSec: number,
  suffix?: string,
): string {
  const timestampMs = Math.max(0, Math.round(timestampSec * 1000));
  const fileName = [
    sanitizeFilenamePart(assetId),
    `${timestampMs}ms`,
    suffix ? sanitizeFilenamePart(suffix) : undefined,
  ].filter(Boolean).join("_");
  return path.join(projectDir, "03_analysis", "editorial_tool_frames", `${fileName}.jpg`);
}

function definition(name: EditorialToolDefinition["name"]): EditorialToolDefinition {
  const found = EDITORIAL_TOOL_DEFINITIONS.find((tool) => tool.name === name);
  if (!found) throw new Error(`Missing editorial tool definition: ${name}`);
  return found;
}

export function createEditorialToolkit(
  projectDir: string,
  sourceMap: Map<string, MediaSourceMapEntry>,
): EditorialTool[] {
  const resolvedProjectDir = path.resolve(projectDir);

  return [
    {
      ...definition("analyze_clip_range"),
      execute: async (params) => {
        const assetId = stringParam(params, "asset_id");
        const sourcePath = sourcePathForAsset(resolvedProjectDir, sourceMap, assetId);
        await ensureMarlinWorker(resolvedProjectDir);
        return marlinAnalyzeRange(
          sourcePath,
          numberParam(params, "start_sec"),
          numberParam(params, "end_sec"),
        );
      },
    },
    {
      ...definition("find_moment"),
      execute: async (params) => {
        const assetId = stringParam(params, "asset_id");
        const sourcePath = sourcePathForAsset(resolvedProjectDir, sourceMap, assetId);
        await ensureMarlinWorker(resolvedProjectDir);
        return marlinFindMoment(sourcePath, stringParam(params, "query"));
      },
    },
    {
      ...definition("extract_frame"),
      execute: async (params) => {
        const assetId = stringParam(params, "asset_id");
        const timestampSec = numberParam(params, "timestamp_sec");
        const sourcePath = sourcePathForAsset(resolvedProjectDir, sourceMap, assetId);
        const outputPath = await marlinExtractFrame(
          sourcePath,
          timestampSec,
          frameOutputPath(resolvedProjectDir, assetId, timestampSec),
        );
        return { asset_id: assetId, timestamp_sec: timestampSec, path: outputPath };
      },
    },
    {
      ...definition("compare_frames"),
      execute: async (params) => {
        const assetId = stringParam(params, "asset_id");
        const timestampASec = numberParam(params, "timestamp_a_sec");
        const timestampBSec = numberParam(params, "timestamp_b_sec");
        const sourcePath = sourcePathForAsset(resolvedProjectDir, sourceMap, assetId);
        const frameA = await marlinExtractFrame(
          sourcePath,
          timestampASec,
          frameOutputPath(resolvedProjectDir, assetId, timestampASec, "a"),
        );
        const frameB = await marlinExtractFrame(
          sourcePath,
          timestampBSec,
          frameOutputPath(resolvedProjectDir, assetId, timestampBSec, "b"),
        );
        return {
          asset_id: assetId,
          frames: [
            { label: "a", timestamp_sec: timestampASec, path: frameA },
            { label: "b", timestamp_sec: timestampBSec, path: frameB },
          ],
        };
      },
    },
    {
      ...definition("search_footage"),
      execute: async (params) => {
        const mode = parseMode(params.mode);
        const query = searchToolQueryParam(params, mode);
        return runFormattedFootageToolSearch(resolvedProjectDir, () => searchFootage(resolvedProjectDir, {
          query,
          mode,
          filters: parseFilters(params),
          limit: optionalNumberParam(params, "limit"),
          image_query_path: optionalStringParam(params, "image_query_path"),
          visual_anchor: parseVisualAnchor(params),
          visual_goal: parseVisualGoal(params.visual_goal),
        }));
      },
    },
    {
      ...definition("visual_search"),
      execute: async (params) => {
        const textHint = optionalStringParam(params, "text_hint");
        const excludeSegmentIds = commaSeparatedStringParam(params, "exclude_segment_ids");
        return runFormattedFootageToolSearch(resolvedProjectDir, () => searchFootage(resolvedProjectDir, {
          query: textHint ?? "",
          semantic: textHint,
          mode: textHint ? "multimodal" : "visual",
          image_query_path: optionalStringParam(params, "query_frame_path"),
          filters: excludeSegmentIds.length > 0 ? { exclude_segment_ids: excludeSegmentIds } : undefined,
          limit: optionalNumberParam(params, "limit"),
        }));
      },
    },
    {
      ...definition("similar_to"),
      execute: async (params) => {
        const segmentId = stringParam(params, "segment_id");
        const limit = optionalNumberParam(params, "limit");
        const useVisual = optionalBooleanParam(params, "use_visual") ?? true;
        return runFormattedFootageToolSearch(resolvedProjectDir, async () => {
          if (!useVisual) {
            return similarFootage(resolvedProjectDir, {
              segment_id: segmentId,
              limit,
            });
          }

          const visualResponse = await searchFootage(resolvedProjectDir, {
            query: "",
            mode: "visual",
            visual_anchor: {
              segment_id: segmentId,
              frame_type: "visual_representative",
            },
            visual_goal: "similarity",
            filters: {
              exclude_segment_ids: [segmentId],
            },
            limit,
          });

          if (!shouldFallbackFromVisualSimilarity(visualResponse)) {
            return visualResponse;
          }

          const textResponse = await similarFootage(resolvedProjectDir, {
            segment_id: segmentId,
            limit,
          });
          return withAdditionalWarnings(textResponse, [
            "visual similarity unavailable; fell back to text-based similar_to",
            ...visualResponse.warnings,
          ]);
        });
      },
    },
    {
      ...definition("unused_footage"),
      execute: async (params) => {
        return runFormattedFootageToolSearch(resolvedProjectDir, () => unusedFootage(resolvedProjectDir, {
          selected_segment_ids: stringArrayParam(params, "exclude_segment_ids"),
          min_quality: optionalNumberParam(params, "min_quality"),
          limit: optionalNumberParam(params, "limit"),
        }));
      },
    },
    {
      ...definition("best_for_beat"),
      execute: async (params) => {
        const beatPurpose = stringParam(params, "beat_purpose");
        const emotion = optionalStringParam(params, "emotion");
        return runFormattedFootageToolSearch(resolvedProjectDir, () => bestForBeat(resolvedProjectDir, {
          beat_purpose: beatPurpose,
          required_visuals: emotion ? [emotion] : undefined,
          avoid_segment_ids: stringArrayParam(params, "exclude_segment_ids"),
          limit: optionalNumberParam(params, "limit"),
        }));
      },
    },
  ];
}
