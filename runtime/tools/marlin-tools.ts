import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MarlinEvent, MarlinFn, MarlinRawEvent } from "../connectors/marlin-types.js";
import { normalizeMarlinEvent, sanitizeIdPart } from "../connectors/marlin-normalize.js";
import { createMarlinFnFromEnvironment } from "../pipeline/stages/marlin.js";
import { prepareMarlinProxy } from "../pipeline/stages/marlin-proxy.js";

export const MARLIN_TOOL_CACHE_DIRNAME = ".marlin-tool-cache";

let workerClient: MarlinFn | null = null;
let workerProjectDir: string | null = null;

function execFilePromise(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 100 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

function findRepoRoot(from: string): string {
  for (const start of [from, process.cwd()]) {
    let dir = path.resolve(start);
    while (dir !== path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, "schemas"))) return dir;
      dir = path.dirname(dir);
    }
  }
  return process.cwd();
}

function activeProjectDir(): string {
  return workerProjectDir ?? process.cwd();
}

function assertFiniteSeconds(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number of seconds`);
  }
}

function resolveExistingSource(sourcePath: string): string {
  const resolved = path.resolve(sourcePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Source file does not exist: ${resolved}`);
  }
  return resolved;
}

function secondsToUs(value: number): number {
  return Math.max(0, Math.round(value * 1_000_000));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function rangeCacheKey(sourcePath: string, startSec: number, endSec: number): string {
  const stat = fs.statSync(sourcePath);
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({
      sourcePath,
      size: stat.size,
      mtimeMs: Math.floor(stat.mtimeMs),
      startSec,
      endSec,
    }))
    .digest("hex")
    .slice(0, 16);
}

async function createRangeProxy(
  projectDir: string,
  sourcePath: string,
  startSec: number,
  endSec: number,
): Promise<string> {
  assertFiniteSeconds(startSec, "startSec");
  assertFiniteSeconds(endSec, "endSec");
  if (startSec < 0) {
    throw new Error("startSec must be non-negative");
  }
  if (endSec <= startSec) {
    throw new Error("endSec must be greater than startSec");
  }

  const key = rangeCacheKey(sourcePath, startSec, endSec);
  const rangeDir = path.join(projectDir, MARLIN_TOOL_CACHE_DIRNAME, "ranges");
  const proxyPath = path.join(rangeDir, `${key}-${startSec.toFixed(3)}-${endSec.toFixed(3)}.mp4`);
  if (fs.existsSync(proxyPath) && fs.statSync(proxyPath).size > 0) {
    return proxyPath;
  }

  fs.mkdirSync(rangeDir, { recursive: true });
  const tmpPath = `${proxyPath}.tmp-${process.pid}.mp4`;
  try {
    await execFilePromise("ffmpeg", [
      "-y",
      "-ss", startSec.toFixed(6),
      "-t", (endSec - startSec).toFixed(6),
      "-i", sourcePath,
      "-map", "0:v:0",
      "-an",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "28",
      "-pix_fmt", "yuv420p",
      tmpPath,
    ]);
    fs.renameSync(tmpPath, proxyPath);
    return proxyPath;
  } catch (error) {
    fs.rmSync(tmpPath, { force: true });
    throw error;
  }
}

function normalizeRangeEvents(
  rawEvents: MarlinRawEvent[] | undefined,
  sourcePath: string,
  startSec: number,
  endSec: number,
): MarlinEvent[] {
  const rangeStartUs = secondsToUs(startSec);
  const rangeEndUs = secondsToUs(endSec);
  const assetId = `RANGE_${sanitizeIdPart(path.parse(sourcePath).name)}`;

  const events: MarlinEvent[] = [];
  for (const [index, raw] of (rawEvents ?? []).entries()) {
    const normalized = normalizeMarlinEvent(raw, assetId, index, rangeStartUs, index);
    if (!normalized) continue;
    const event: MarlinEvent = {
      ...normalized,
      start_us: Math.max(rangeStartUs, normalized.start_us),
      end_us: Math.min(rangeEndUs, normalized.end_us),
    };
    if (event.end_us > event.start_us) {
      events.push(event);
    }
  }
  return events;
}

function validSpan(span: unknown): [number, number] | null {
  if (!Array.isArray(span) || span.length !== 2) return null;
  const start = Number(span[0]);
  const end = Number(span[1]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return [Math.max(0, start), Math.max(0, end)];
}

export async function ensureMarlinWorker(projectDir: string): Promise<MarlinFn> {
  const resolvedProjectDir = path.resolve(projectDir);
  if (workerClient && workerProjectDir === resolvedProjectDir) {
    return workerClient;
  }

  if (workerClient?.close) {
    await workerClient.close();
  }

  const repoRoot = findRepoRoot(resolvedProjectDir);
  workerClient = createMarlinFnFromEnvironment(resolvedProjectDir, repoRoot);
  workerProjectDir = resolvedProjectDir;

  // Keep the lazy worker contract: createMarlinFnFromEnvironment constructs
  // the client, while the Python process starts only on caption/find.
  return workerClient;
}

export async function shutdownMarlinWorker(): Promise<void> {
  const client = workerClient;
  workerClient = null;
  workerProjectDir = null;
  if (client?.close) {
    await client.close();
  }
}

export async function marlinAnalyzeRange(
  sourcePath: string,
  startSec: number,
  endSec: number,
): Promise<{ events: MarlinEvent[]; scene: string }> {
  const absSource = resolveExistingSource(sourcePath);
  const projectDir = activeProjectDir();
  const rangeProxy = await createRangeProxy(projectDir, absSource, startSec, endSec);
  const evaluationProxy = await prepareMarlinProxy(projectDir, rangeProxy);
  const marlin = await ensureMarlinWorker(projectDir);
  const caption = await marlin.caption(evaluationProxy.evaluationPath);

  return {
    scene: caption.scene?.trim() || caption.caption?.trim() || "",
    events: normalizeRangeEvents(caption.events, absSource, startSec, endSec),
  };
}

export async function marlinFindMoment(
  sourcePath: string,
  query: string,
): Promise<{ span: [number, number] | null; confidence: number; description: string }> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    throw new Error("query must not be empty");
  }

  const absSource = resolveExistingSource(sourcePath);
  const projectDir = activeProjectDir();
  const evaluationProxy = await prepareMarlinProxy(projectDir, absSource);
  const marlin = await ensureMarlinWorker(projectDir);
  const result = await marlin.find(evaluationProxy.evaluationPath, trimmedQuery);
  const span = result.format_ok === false ? null : validSpan(result.span);
  const confidence = clamp01(result.confidence ?? (span ? 0.7 : 0));

  return {
    span,
    confidence,
    description: result.raw?.trim()
      || (span
        ? `Found "${result.query?.trim() || trimmedQuery}" from ${span[0].toFixed(2)}s to ${span[1].toFixed(2)}s.`
        : `No matching span found for "${result.query?.trim() || trimmedQuery}".`),
  };
}

export async function marlinExtractFrame(
  sourcePath: string,
  timestampSec: number,
  outputPath: string,
): Promise<string> {
  assertFiniteSeconds(timestampSec, "timestampSec");
  if (timestampSec < 0) {
    throw new Error("timestampSec must be non-negative");
  }

  const absSource = resolveExistingSource(sourcePath);
  const absOutput = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(absOutput), { recursive: true });

  await execFilePromise("ffmpeg", [
    "-y",
    "-ss", timestampSec.toFixed(6),
    "-i", absSource,
    "-frames:v", "1",
    "-q:v", "2",
    absOutput,
  ]);

  if (!fs.existsSync(absOutput) || fs.statSync(absOutput).size === 0) {
    throw new Error(`ffmpeg did not create a frame: ${absOutput}`);
  }

  return absOutput;
}
