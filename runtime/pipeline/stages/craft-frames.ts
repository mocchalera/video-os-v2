import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type { Candidate as SelectCandidate } from "../../artifacts/types.js";
import type { MarlinEvent, MarlinEventsArtifact } from "../../connectors/marlin-types.js";
import type { MediaSourceMapEntry } from "../../media/source-map.js";

const execFileAsync = promisify(execFile);
const IN_OUT_OFFSET_US = 500_000;
const LONG_CLIP_US = 8_000_000;
const VERY_LONG_CLIP_US = 12_000_000;

export type { SelectCandidate };

export interface KeyFrame {
  timestamp_us: number;
  path: string;
  label: string;
  source: "marlin_event" | "uniform" | "in_out";
}

function isUsableCandidate(candidate: SelectCandidate): boolean {
  return candidate.role !== "reject"
    && typeof candidate.segment_id === "string"
    && candidate.segment_id.length > 0
    && typeof candidate.asset_id === "string"
    && candidate.asset_id.length > 0
    && Number.isFinite(candidate.src_in_us)
    && Number.isFinite(candidate.src_out_us)
    && candidate.src_out_us > candidate.src_in_us;
}

function eventMidpoint(event: MarlinEvent): number {
  return Math.trunc((event.start_us + event.end_us) / 2);
}

function eventOverlapsCandidate(candidate: SelectCandidate, event: MarlinEvent): boolean {
  return event.start_us < candidate.src_out_us && event.end_us > candidate.src_in_us;
}

function bestMarlinEvent(
  candidate: SelectCandidate,
  events: MarlinEvent[],
): MarlinEvent | undefined {
  const validEvents = events.filter((event) =>
    Number.isFinite(event.start_us)
    && Number.isFinite(event.end_us)
    && event.end_us > event.start_us
  );
  if (validEvents.length === 0) return undefined;
  const overlapping = validEvents.filter((event) => eventOverlapsCandidate(candidate, event));
  const pool = overlapping.length > 0 ? overlapping : validEvents;
  return [...pool].sort((a, b) => (b.confidence ?? -1) - (a.confidence ?? -1))[0];
}

function clampToCandidate(candidate: SelectCandidate, timestampUs: number): number {
  const min = Math.trunc(candidate.src_in_us);
  const max = Math.trunc(candidate.src_out_us);
  if (max <= min) return min;
  return Math.max(min, Math.min(max, Math.trunc(timestampUs)));
}

function uniformBetween(candidate: SelectCandidate, fraction: number): number {
  const start = clampToCandidate(candidate, candidate.src_in_us + IN_OUT_OFFSET_US);
  const end = clampToCandidate(candidate, candidate.src_out_us - IN_OUT_OFFSET_US);
  const low = Math.min(start, end);
  const high = Math.max(start, end);
  return clampToCandidate(candidate, low + (high - low) * fraction);
}

function marlinEventsByAsset(
  marlinEvents: MarlinEventsArtifact | null,
): Map<string, MarlinEvent[]> {
  const byAsset = new Map<string, MarlinEvent[]>();
  for (const item of marlinEvents?.items ?? []) {
    byAsset.set(item.asset_id, item.events ?? []);
  }
  return byAsset;
}

export function determineCraftKeyFrames(
  candidate: SelectCandidate,
  marlinEvents: MarlinEventsArtifact | null,
): KeyFrame[] {
  const durationUs = candidate.src_out_us - candidate.src_in_us;
  const assetEvents = marlinEventsByAsset(marlinEvents).get(candidate.asset_id) ?? [];
  const peakEvent = bestMarlinEvent(candidate, assetEvents);
  const peakTimestampUs = peakEvent
    ? eventMidpoint(peakEvent)
    : candidate.src_in_us + durationUs / 2;

  const frames: KeyFrame[] = [
    {
      timestamp_us: clampToCandidate(candidate, candidate.src_in_us + IN_OUT_OFFSET_US),
      path: "",
      label: "in",
      source: "in_out",
    },
    {
      timestamp_us: clampToCandidate(candidate, peakTimestampUs),
      path: "",
      label: "peak",
      source: peakEvent ? "marlin_event" : "uniform",
    },
  ];

  if (durationUs >= LONG_CLIP_US) {
    const fractions = durationUs >= VERY_LONG_CLIP_US ? [1 / 3, 2 / 3] : [2 / 3];
    fractions.forEach((fraction, index) => {
      frames.push({
        timestamp_us: uniformBetween(candidate, fraction),
        path: "",
        label: `mid_${index + 1}`,
        source: "uniform",
      });
    });
  }

  if (durationUs >= 3_000_000) {
    frames.push({
      timestamp_us: clampToCandidate(candidate, candidate.src_out_us - IN_OUT_OFFSET_US),
      path: "",
      label: "out",
      source: "in_out",
    });
  }

  return frames;
}

function toPosixRelative(projectDir: string, targetPath: string): string {
  return path.relative(projectDir, targetPath).split(path.sep).join("/");
}

function safePathPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "segment";
}

function outputPathFor(projectDir: string, segmentId: string, label: string): string {
  return path.join(
    projectDir,
    "03_analysis",
    "craft_frames",
    `${safePathPart(segmentId)}_${safePathPart(label)}.jpg`,
  );
}

function representativeOutputPathFor(projectDir: string, assetId: string): string {
  return path.join(
    projectDir,
    "03_analysis",
    "representative_frames",
    `${safePathPart(assetId)}.jpg`,
  );
}

function resolveSourcePath(projectDir: string, entry: MediaSourceMapEntry): string {
  const sourcePath = entry.local_source_path || entry.source_locator || entry.link_path;
  return path.isAbsolute(sourcePath) ? sourcePath : path.resolve(projectDir, sourcePath);
}

function statIfExists(filePath: string): fs.Stats | undefined {
  try {
    return fs.statSync(filePath);
  } catch {
    return undefined;
  }
}

function isCacheFresh(outputPath: string, sourcePath: string): boolean {
  const outputStat = statIfExists(outputPath);
  if (!outputStat?.isFile()) return false;
  const sourceStat = statIfExists(sourcePath);
  if (!sourceStat?.isFile()) return true;
  return outputStat.mtimeMs >= sourceStat.mtimeMs;
}

function secondsString(timestampUs: number): string {
  return (timestampUs / 1_000_000).toFixed(6);
}

async function extractFrame(sourcePath: string, timestampUs: number, outputPath: string): Promise<void> {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  await execFileAsync("ffmpeg", [
    "-y",
    "-ss",
    secondsString(timestampUs),
    "-i",
    sourcePath,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    outputPath,
  ], { maxBuffer: 1024 * 1024 * 4 });
}

export async function extractCraftKeyFrames(
  projectDir: string,
  candidates: SelectCandidate[],
  marlinEvents: MarlinEventsArtifact | null,
  sourceMap: Map<string, MediaSourceMapEntry>,
): Promise<Map<string, KeyFrame[]>> {
  const absProjectDir = path.resolve(projectDir);
  const result = new Map<string, KeyFrame[]>();

  for (const candidate of candidates) {
    if (!isUsableCandidate(candidate)) continue;

    const sourceEntry = sourceMap.get(candidate.asset_id);
    if (!sourceEntry) {
      result.set(candidate.segment_id, []);
      continue;
    }

    const sourcePath = resolveSourcePath(absProjectDir, sourceEntry);
    const sourceExists = Boolean(statIfExists(sourcePath)?.isFile());
    const plannedFrames = determineCraftKeyFrames(candidate, marlinEvents);
    const extractedFrames: KeyFrame[] = [];

    for (const frame of plannedFrames) {
      const outputPath = outputPathFor(absProjectDir, candidate.segment_id, frame.label);
      const relativePath = toPosixRelative(absProjectDir, outputPath);

      if (!isCacheFresh(outputPath, sourcePath)) {
        if (!sourceExists) continue;
        await extractFrame(sourcePath, frame.timestamp_us, outputPath);
      }

      extractedFrames.push({
        ...frame,
        path: relativePath,
      });
    }

    result.set(candidate.segment_id, extractedFrames);
  }

  return result;
}

function representativeTimestampUs(
  assetId: string,
  segments: Array<{
    asset_id: string;
    src_in_us: number;
    src_out_us: number;
    rep_frame_us?: number;
  }>,
  marlinEvents: MarlinEventsArtifact | null,
): number | undefined {
  const assetEvents = marlinEventsByAsset(marlinEvents).get(assetId) ?? [];
  const bestEvent = [...assetEvents]
    .filter((event) =>
      Number.isFinite(event.start_us)
      && Number.isFinite(event.end_us)
      && event.end_us > event.start_us
    )
    .sort((a, b) => (b.confidence ?? -1) - (a.confidence ?? -1))[0];
  if (bestEvent) return eventMidpoint(bestEvent);

  const segment = segments
    .filter((item) => item.asset_id === assetId)
    .sort((a, b) => a.src_in_us - b.src_in_us)[0];
  if (!segment) return undefined;
  if (Number.isFinite(segment.rep_frame_us)) return Math.trunc(segment.rep_frame_us!);
  if (Number.isFinite(segment.src_in_us) && Number.isFinite(segment.src_out_us) && segment.src_out_us > segment.src_in_us) {
    return Math.trunc((segment.src_in_us + segment.src_out_us) / 2);
  }
  return undefined;
}

export async function extractRepresentativeFrames(
  projectDir: string,
  segments: Array<{
    asset_id: string;
    src_in_us: number;
    src_out_us: number;
    rep_frame_us?: number;
  }>,
  marlinEvents: MarlinEventsArtifact | null,
  sourceMap: Map<string, MediaSourceMapEntry>,
): Promise<Map<string, string>> {
  const absProjectDir = path.resolve(projectDir);
  const result = new Map<string, string>();
  const assetIds = [...new Set(segments.map((segment) => segment.asset_id).filter(Boolean))].sort((a, b) => a.localeCompare(b));

  for (const assetId of assetIds) {
    const sourceEntry = sourceMap.get(assetId);
    const timestampUs = representativeTimestampUs(assetId, segments, marlinEvents);
    if (!sourceEntry || timestampUs === undefined) continue;

    const sourcePath = resolveSourcePath(absProjectDir, sourceEntry);
    const sourceExists = Boolean(statIfExists(sourcePath)?.isFile());
    const outputPath = representativeOutputPathFor(absProjectDir, assetId);
    const relativePath = toPosixRelative(absProjectDir, outputPath);

    if (!isCacheFresh(outputPath, sourcePath)) {
      if (!sourceExists) continue;
      await extractFrame(sourcePath, timestampUs, outputPath);
    }

    result.set(assetId, relativePath);
  }

  return result;
}
