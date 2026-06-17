// Rough-cut renderer CLI.
// Usage:
//   npx tsx scripts/render-rough-cut.ts --project <project-dir> [--output <path>] [--bgm <path>] [--no-audio]

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  loadSourceMap,
  type MediaSourceMapDoc,
  type MediaSourceMapEntry,
} from "../runtime/media/source-map.js";

const execFileAsync = promisify(execFile);

const USAGE =
  "Usage: npx tsx scripts/render-rough-cut.ts --project <project-dir> [--output <path>] [--bgm <path>] [--no-audio]";

const VIDEO_EXTENSIONS = new Set([".mov", ".mp4"]);
const BGM_EXTENSIONS = new Set([".mp3", ".wav"]);

export interface RenderArgs {
  projectPath: string;
  outputPath?: string;
  bgmPath?: string;
  noAudio: boolean;
}

export interface TimelineClip {
  clip_id?: string;
  asset_id: string;
  src_in_us: number;
  timeline_in_frame?: number;
  timeline_duration_frames: number;
}

export interface RenderClip {
  clipId: string;
  assetId: string;
  sourcePath: string;
  startSec: number;
  durationSec: number;
  timelineInFrame: number;
}

export interface BgmCandidate {
  path: string;
  durationSec: number;
}

export interface RenderSummary {
  outputPath: string;
  clipCount: number;
  durationSec: number;
  fileSizeBytes: number;
}

interface TimelineDoc {
  project_id?: string;
  sequence?: {
    fps_num?: number;
    fps_den?: number;
  };
  tracks?: {
    video?: Array<{
      clips?: unknown[];
    }>;
  };
}

interface AssetDoc {
  project_id?: string;
  items?: Array<{
    asset_id?: unknown;
    filename?: unknown;
    display_name?: unknown;
  }>;
}

export function parseArgs(argv: string[]): RenderArgs {
  const args = argv.slice(2);
  let projectPath: string | undefined;
  let outputPath: string | undefined;
  let bgmPath: string | undefined;
  let noAudio = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else if (arg === "--project" && i + 1 < args.length) {
      projectPath = args[++i];
    } else if (arg === "--output" && i + 1 < args.length) {
      outputPath = args[++i];
    } else if (arg === "--bgm" && i + 1 < args.length) {
      bgmPath = args[++i];
    } else if (arg === "--no-audio") {
      noAudio = true;
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!projectPath) throw new Error("--project is required");
  return { projectPath, outputPath, bgmPath, noAudio };
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

function atomicWriteJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, filePath);
}

function toPosixRel(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join("/");
}

function fileStem(filePath: string): string {
  return path.basename(filePath, path.extname(filePath));
}

function scanFiles(dir: string, extensions: Set<string>): string[] {
  if (!fs.existsSync(dir)) return [];

  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...scanFiles(entryPath, extensions));
    } else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
      found.push(entryPath);
    }
  }
  return found.sort((a, b) => a.localeCompare(b));
}

export function generateSourceMapFromAssets(projectPath: string): MediaSourceMapDoc {
  const absProject = path.resolve(projectPath);
  const assetsPath = path.join(absProject, "03_analysis", "assets.json");
  if (!fs.existsSync(assetsPath)) {
    throw new Error(`source_map.json is missing and assets.json was not found: ${assetsPath}`);
  }

  const assets = readJson<AssetDoc>(assetsPath);
  const mediaDir = path.join(absProject, "02_media");
  const mediaByStem = new Map(
    scanFiles(mediaDir, VIDEO_EXTENSIONS).map((filePath) => [fileStem(filePath).toLowerCase(), filePath]),
  );

  const items: MediaSourceMapEntry[] = [];
  for (const asset of assets.items ?? []) {
    if (typeof asset.asset_id !== "string" || typeof asset.filename !== "string") continue;

    const sourcePath = mediaByStem.get(fileStem(asset.filename).toLowerCase());
    if (!sourcePath) continue;

    items.push({
      asset_id: asset.asset_id,
      source_locator: sourcePath,
      local_source_path: sourcePath,
      link_path: toPosixRel(absProject, sourcePath),
      display_name: typeof asset.display_name === "string" ? asset.display_name : asset.filename,
      kind: "asset",
    });
  }

  const doc: MediaSourceMapDoc = {
    version: "1",
    project_id: assets.project_id ?? path.basename(absProject),
    media_dir: "02_media",
    generated_at: new Date().toISOString(),
    items,
  };

  atomicWriteJson(path.join(absProject, "02_media", "source_map.json"), doc);
  return doc;
}

export function ensureSourceMap(projectPath: string): Map<string, MediaSourceMapEntry> {
  const absProject = path.resolve(projectPath);
  const sourceMapPath = path.join(absProject, "02_media", "source_map.json");
  if (!fs.existsSync(sourceMapPath)) {
    generateSourceMapFromAssets(absProject);
  }
  return loadSourceMap(absProject).entryMap;
}

export function getTimelineFps(timeline: TimelineDoc): number {
  const fpsNum = timeline.sequence?.fps_num;
  const fpsDen = timeline.sequence?.fps_den;
  if (!fpsNum || !fpsDen || fpsDen === 0) {
    throw new Error("timeline.json sequence.fps_num / sequence.fps_den are required");
  }
  return fpsNum / fpsDen;
}

export function extractVideoClips(timeline: TimelineDoc): TimelineClip[] {
  return (timeline.tracks?.video ?? [])
    .flatMap((track, trackIndex) =>
      (track.clips ?? []).map((rawClip, clipIndex) => ({ rawClip, trackIndex, clipIndex })),
    )
    .filter(({ rawClip }) => {
      const clip = rawClip as Partial<TimelineClip>;
      return (
        typeof clip.asset_id === "string" &&
        typeof clip.src_in_us === "number" &&
        typeof clip.timeline_duration_frames === "number" &&
        clip.timeline_duration_frames > 0
      );
    })
    .sort((a, b) => {
      const aClip = a.rawClip as Partial<TimelineClip>;
      const bClip = b.rawClip as Partial<TimelineClip>;
      return (
        (aClip.timeline_in_frame ?? 0) - (bClip.timeline_in_frame ?? 0) ||
        a.trackIndex - b.trackIndex ||
        a.clipIndex - b.clipIndex
      );
    })
    .map(({ rawClip }) => {
      const clip = rawClip as TimelineClip;
      return {
        clip_id: clip.clip_id,
        asset_id: clip.asset_id,
        src_in_us: clip.src_in_us,
        timeline_in_frame: clip.timeline_in_frame,
        timeline_duration_frames: clip.timeline_duration_frames,
      };
    });
}

export function buildRenderClips(
  clips: TimelineClip[],
  sourceMap: Map<string, MediaSourceMapEntry>,
  fps: number,
  warn: (message: string) => void = console.warn,
): RenderClip[] {
  const renderClips: RenderClip[] = [];

  for (const clip of clips) {
    const entry = sourceMap.get(clip.asset_id);
    const sourcePath = entry?.source_locator;
    if (!sourcePath) {
      warn(`Warning: skipping ${clip.clip_id ?? clip.asset_id}; missing source_map entry for ${clip.asset_id}`);
      continue;
    }
    if (!fs.existsSync(sourcePath)) {
      warn(`Warning: skipping ${clip.clip_id ?? clip.asset_id}; source file not found: ${sourcePath}`);
      continue;
    }

    renderClips.push({
      clipId: clip.clip_id ?? `${clip.asset_id}_${renderClips.length + 1}`,
      assetId: clip.asset_id,
      sourcePath,
      startSec: clip.src_in_us / 1_000_000,
      durationSec: clip.timeline_duration_frames / fps,
      timelineInFrame: clip.timeline_in_frame ?? 0,
    });
  }

  return renderClips;
}

function concatEscape(filePath: string): string {
  return filePath.replace(/'/g, "'\\''");
}

export function writeConcatList(listPath: string, clipPaths: string[]): void {
  const body = clipPaths.map((clipPath) => `file '${concatEscape(path.resolve(clipPath))}'`).join("\n");
  fs.writeFileSync(listPath, `${body}\n`, "utf-8");
}

export async function probeDurationSec(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);
  const duration = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`ffprobe returned invalid duration for ${filePath}`);
  }
  return duration;
}

export async function findBgmCandidates(
  projectPath: string,
  probeDuration: (filePath: string) => Promise<number> = probeDurationSec,
): Promise<BgmCandidate[]> {
  const mediaDir = path.join(path.resolve(projectPath), "02_media");
  const bgmFiles = scanFiles(mediaDir, BGM_EXTENSIONS)
    .filter((filePath) => path.basename(filePath).toLowerCase().startsWith("bgm"));
  const candidates: BgmCandidate[] = [];

  for (const filePath of bgmFiles) {
    try {
      candidates.push({ path: filePath, durationSec: await probeDuration(filePath) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`Warning: skipping BGM candidate ${filePath}: ${message}`);
    }
  }

  return candidates.sort((a, b) => a.path.localeCompare(b.path));
}

export function selectBgmCandidate(
  candidates: BgmCandidate[],
  targetDurationSec: number,
): BgmCandidate | undefined {
  return candidates
    .filter((candidate) => candidate.durationSec >= targetDurationSec)
    .sort((a, b) => (a.durationSec - targetDurationSec) - (b.durationSec - targetDurationSec))[0];
}

function resolveUserPath(projectPath: string, userPath: string): string {
  if (path.isAbsolute(userPath)) return userPath;

  const cwdPath = path.resolve(userPath);
  if (fs.existsSync(cwdPath)) return cwdPath;

  return path.resolve(projectPath, userPath);
}

async function runFfmpeg(args: string[]): Promise<void> {
  await execFileAsync("ffmpeg", ["-y", ...args], { maxBuffer: 1024 * 1024 * 16 });
}

async function renderRoughCut(args: RenderArgs): Promise<RenderSummary> {
  const projectPath = path.resolve(args.projectPath);
  const timelinePath = path.join(projectPath, "05_timeline", "timeline.json");
  if (!fs.existsSync(timelinePath)) throw new Error(`Timeline not found: ${timelinePath}`);

  const timeline = readJson<TimelineDoc>(timelinePath);
  const fps = getTimelineFps(timeline);
  const sourceMap = ensureSourceMap(projectPath);
  const clips = buildRenderClips(extractVideoClips(timeline), sourceMap, fps);
  if (clips.length === 0) throw new Error("No renderable video clips found");

  const totalDurationSec = clips.reduce((sum, clip) => sum + clip.durationSec, 0);
  const outputPath = args.outputPath
    ? resolveUserPath(projectPath, args.outputPath)
    : path.join(projectPath, "09_output", "rough-cut.mp4");

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rough-cut-"));
  try {
    const tmpClipPaths: string[] = [];
    for (let index = 0; index < clips.length; index++) {
      const clip = clips[index];
      const tmpClip = path.join(tempDir, `clip-${String(index + 1).padStart(4, "0")}.mp4`);
      await runFfmpeg([
        "-ss",
        String(clip.startSec),
        "-i",
        clip.sourcePath,
        "-t",
        String(clip.durationSec),
        "-vf",
        `fps=${fps},scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2`,
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "18",
        tmpClip,
      ]);
      tmpClipPaths.push(tmpClip);
    }

    const concatListPath = path.join(tempDir, "concat.txt");
    const tmpVideoPath = path.join(tempDir, "rough-cut-video.mp4");
    writeConcatList(concatListPath, tmpClipPaths);
    await runFfmpeg(["-f", "concat", "-safe", "0", "-i", concatListPath, "-c", "copy", tmpVideoPath]);

    let bgmPath: string | undefined;
    if (!args.noAudio) {
      if (args.bgmPath) {
        bgmPath = resolveUserPath(projectPath, args.bgmPath);
      } else {
        bgmPath = selectBgmCandidate(await findBgmCandidates(projectPath), totalDurationSec)?.path;
      }
    }

    if (bgmPath) {
      if (!fs.existsSync(bgmPath)) throw new Error(`BGM file not found: ${bgmPath}`);
      await runFfmpeg([
        "-i",
        tmpVideoPath,
        "-i",
        bgmPath,
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-shortest",
        outputPath,
      ]);
    } else {
      fs.copyFileSync(tmpVideoPath, outputPath);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  return {
    outputPath,
    clipCount: clips.length,
    durationSec: totalDurationSec,
    fileSizeBytes: fs.statSync(outputPath).size,
  };
}

async function main(): Promise<void> {
  const summary = await renderRoughCut(parseArgs(process.argv));
  console.log(`Rendered rough cut: ${summary.outputPath}`);
  console.log(`  Clips: ${summary.clipCount}`);
  console.log(`  Duration: ${summary.durationSec.toFixed(1)}s`);
  console.log(`  File size: ${(summary.fileSizeBytes / 1024 / 1024).toFixed(2)} MB`);
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Render failed: ${message}`);
    console.error(USAGE);
    process.exit(1);
  });
}
