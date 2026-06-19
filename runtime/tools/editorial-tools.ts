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
  type FootageSearchResponse,
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
  parameters: Record<string, { type: string; description: string }>;
  execute: (params: Record<string, unknown>) => Promise<unknown>;
}

export type EditorialToolDefinition = Omit<EditorialTool, "execute">;

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
    description: "Search the full analyzed footage pool by natural language, semantic evidence, and structured filters. Read-only.",
    parameters: {
      query: { type: "string", description: "Natural-language search intent, such as warm indoor scenes or food preparation closeups." },
      filters: { type: "object", description: "Optional FootageSearchFilters object for date, place, type, quality, dialogue, text, or exclusion filters." },
      filters_json: { type: "string", description: "Optional JSON string matching FootageSearchFilters when object parameters are unavailable." },
      mode: { type: "string", description: "Optional: hybrid, text, semantic, or structured. Defaults to hybrid." },
      limit: { type: "number", description: "Optional result limit. Defaults to 12, max 50." },
    },
  },
  {
    name: "similar_to",
    description: "Find full-pool clips similar to a known segment while excluding that segment. Read-only.",
    parameters: {
      segment_id: { type: "string", description: "Segment id to use as the similarity anchor." },
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

function parseMode(value: unknown): FootageSearchMode | undefined {
  if (value == null || value === "") return undefined;
  if (value === "hybrid" || value === "text" || value === "semantic" || value === "structured") return value;
  throw new Error("mode must be hybrid, text, semantic, or structured");
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

function withAdditionalWarnings(response: FootageSearchResponse, warnings: string[]): FootageSearchResponse {
  if (warnings.length === 0) return response;
  return {
    ...response,
    warnings: Array.from(new Set([...warnings, ...response.warnings])),
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
        const query = stringParam(params, "query");
        return runFootageToolSearch(resolvedProjectDir, () => searchFootage(resolvedProjectDir, {
          query,
          mode: parseMode(params.mode),
          filters: parseFilters(params),
          limit: optionalNumberParam(params, "limit"),
        }));
      },
    },
    {
      ...definition("similar_to"),
      execute: async (params) => {
        const segmentId = stringParam(params, "segment_id");
        return runFootageToolSearch(resolvedProjectDir, () => similarFootage(resolvedProjectDir, {
          segment_id: segmentId,
          limit: optionalNumberParam(params, "limit"),
        }));
      },
    },
    {
      ...definition("unused_footage"),
      execute: async (params) => {
        return runFootageToolSearch(resolvedProjectDir, () => unusedFootage(resolvedProjectDir, {
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
        return runFootageToolSearch(resolvedProjectDir, () => bestForBeat(resolvedProjectDir, {
          beat_purpose: beatPurpose,
          required_visuals: emotion ? [emotion] : undefined,
          avoid_segment_ids: stringArrayParam(params, "exclude_segment_ids"),
          limit: optionalNumberParam(params, "limit"),
        }));
      },
    },
  ];
}
