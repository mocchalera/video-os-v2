import * as fs from "node:fs";
import * as path from "node:path";
import type { MediaSourceMapEntry } from "../media/source-map.js";
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
  ];
}
