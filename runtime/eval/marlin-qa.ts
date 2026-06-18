import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { CreativeBrief } from "../artifacts/types.js";
import type { MarlinFn, MarlinRawCaption, MarlinRawEvent } from "../connectors/marlin-types.js";
import { extractDurationUs, runFfprobe } from "../connectors/ffprobe.js";
import { createMarlinFnFromEnvironment } from "../pipeline/stages/marlin.js";
import { prepareMarlinProxy } from "../pipeline/stages/marlin-proxy.js";
import type { MarlinQAIssue, MarlinQAReport } from "./marlin-qa-types.js";

const DEFAULT_VIDEO_RELATIVE_PATH = "09_output/rough-cut.mp4";
const DEFAULT_CHUNK_DURATION_SEC = 30;
const DEFAULT_CHUNK_OVERLAP_SEC = 3;
const DEFAULT_SHORT_VIDEO_THRESHOLD_SEC = 20;
const DEFAULT_QA_PROXY_MAX_WIDTH = 384;
const MIN_RENDERABLE_TIMELINE_FRAMES = 12;
const MICRO_CLIP_EVENT_THRESHOLD_SEC = 0.5;
const execFileAsync = promisify(execFile);

export interface MarlinQAEvent {
  start_sec: number;
  end_sec: number;
  description: string;
  confidence?: number;
}

export interface RunMarlinQAOptions {
  marlinFn?: MarlinFn;
  durationSec?: number;
  repoRoot?: string;
  reportDir?: string;
  writeReport?: boolean;
  now?: () => Date;
  onReportPath?: (reportPath: string) => void;
  chunkDurationSec?: number;
  chunkOverlapSec?: number;
  shortVideoThresholdSec?: number;
  proxyMaxWidth?: number;
  createChunkClip?: CreateMarlinQAChunkClip;
  prepareEvaluationClip?: PrepareMarlinQAEvaluationClip;
}

export interface BuildMarlinQAReportInput {
  projectDir: string;
  videoPath: string;
  videoDurationSec: number;
  brief: CreativeBrief;
  caption: MarlinRawCaption;
}

export interface MarlinQAChunk {
  index: number;
  start_sec: number;
  end_sec: number;
  duration_sec: number;
}

export interface MarlinQAChunkCaption {
  chunk: MarlinQAChunk;
  caption: MarlinRawCaption;
}

export interface CreateMarlinQAChunkClipInput {
  videoPath: string;
  outputPath: string;
  chunk: MarlinQAChunk;
}

export type CreateMarlinQAChunkClip = (input: CreateMarlinQAChunkClipInput) => Promise<void>;

export interface PrepareMarlinQAEvaluationClipInput {
  projectDir: string;
  videoPath: string;
}

export type PrepareMarlinQAEvaluationClip = (input: PrepareMarlinQAEvaluationClipInput) => Promise<string>;

export function defaultMarlinQAVideoPath(projectDir: string): string {
  return path.join(projectDir, DEFAULT_VIDEO_RELATIVE_PATH);
}

export async function runMarlinQA(
  projectDir: string,
  videoPath: string,
  brief: CreativeBrief,
  options: RunMarlinQAOptions = {},
): Promise<MarlinQAReport> {
  const absProjectDir = path.resolve(projectDir);
  const absVideoPath = resolveVideoPath(absProjectDir, videoPath);
  if (!fs.existsSync(absVideoPath)) {
    throw new Error(`Rendered video not found: ${absVideoPath}`);
  }

  const durationSec = options.durationSec ?? await readVideoDurationSec(absVideoPath);
  const restoreProxyEnv = applyMarlinQAProxyMaxWidth(options.proxyMaxWidth);
  const ownsMarlinFn = options.marlinFn === undefined;
  let marlinFn: MarlinFn | undefined;

  try {
    marlinFn = options.marlinFn ?? createMarlinFnFromEnvironment(absProjectDir, options.repoRoot, {
      requestTimeoutMs: 300_000,
    });
    const caption = await captionMarlinQAWithChunks(absVideoPath, durationSec, marlinFn, {
      projectDir: absProjectDir,
      chunkDurationSec: options.chunkDurationSec,
      chunkOverlapSec: options.chunkOverlapSec,
      shortVideoThresholdSec: options.shortVideoThresholdSec,
      createChunkClip: options.createChunkClip,
      prepareEvaluationClip: options.prepareEvaluationClip,
    });
    const report = buildMarlinQAReport({
      projectDir: absProjectDir,
      videoPath: absVideoPath,
      videoDurationSec: durationSec,
      brief,
      caption,
    });

    if (options.writeReport !== false) {
      const reportPath = writeMarlinQAReport(absProjectDir, report, {
        reportDir: options.reportDir,
        now: options.now,
      });
      options.onReportPath?.(reportPath);
    }

    return report;
  } finally {
    if (ownsMarlinFn) {
      await marlinFn?.close?.();
    }
    restoreProxyEnv();
  }
}

export async function captionMarlinQAWithChunks(
  videoPath: string,
  videoDurationSec: number,
  marlinFn: MarlinFn,
  options: Pick<
    RunMarlinQAOptions,
    "chunkDurationSec" | "chunkOverlapSec" | "shortVideoThresholdSec" | "createChunkClip" | "prepareEvaluationClip"
  > & { projectDir?: string } = {},
): Promise<MarlinRawCaption> {
  const durationSec = round3(Math.max(0, videoDurationSec));
  const projectDir = options.projectDir ?? path.dirname(videoPath);
  const prepareEvaluationClip = options.prepareEvaluationClip ?? prepareMarlinQAEvaluationClip;
  const shortVideoThresholdSec = positiveOrDefault(
    options.shortVideoThresholdSec,
    DEFAULT_SHORT_VIDEO_THRESHOLD_SEC,
  );

  if (durationSec <= 0 || durationSec < shortVideoThresholdSec) {
    return captionMarlinQAClip(projectDir, videoPath, marlinFn, prepareEvaluationClip);
  }

  const chunks = splitMarlinQAVideoChunks(durationSec, {
    chunkDurationSec: options.chunkDurationSec,
    overlapSec: options.chunkOverlapSec,
  });
  if (chunks.length <= 1) {
    return captionMarlinQAClip(projectDir, videoPath, marlinFn, prepareEvaluationClip);
  }

  const createChunkClip = options.createChunkClip ?? createFfmpegMarlinQAChunkClip;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-os-marlin-qa-chunks-"));
  const captions: MarlinQAChunkCaption[] = [];

  try {
    for (const chunk of chunks) {
      const outputPath = path.join(tempDir, `chunk_${String(chunk.index).padStart(3, "0")}.mp4`);
      await createChunkClip({ videoPath, outputPath, chunk });
      captions.push({
        chunk,
        caption: await captionMarlinQAClip(projectDir, outputPath, marlinFn, prepareEvaluationClip),
      });
    }

    return mergeMarlinQAChunkCaptions(captions, durationSec);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export function splitMarlinQAVideoChunks(
  videoDurationSec: number,
  options: { chunkDurationSec?: number; overlapSec?: number } = {},
): MarlinQAChunk[] {
  const durationSec = round3(Math.max(0, videoDurationSec));
  if (durationSec <= 0) return [];

  const chunkDurationSec = positiveOrDefault(options.chunkDurationSec, DEFAULT_CHUNK_DURATION_SEC);
  const overlapSec = clamp(
    positiveOrDefault(options.overlapSec, DEFAULT_CHUNK_OVERLAP_SEC),
    0,
    Math.max(0, chunkDurationSec - 0.001),
  );
  const stepSec = Math.max(0.001, chunkDurationSec - overlapSec);
  const chunks: MarlinQAChunk[] = [];

  let index = 0;
  let startSec = 0;
  while (startSec < durationSec) {
    const endSec = round3(Math.min(durationSec, startSec + chunkDurationSec));
    const start = round3(startSec);
    chunks.push({
      index,
      start_sec: start,
      end_sec: endSec,
      duration_sec: round3(endSec - start),
    });

    if (endSec >= durationSec) break;
    index += 1;
    startSec += stepSec;
  }

  return chunks;
}

export function mergeMarlinQAChunkCaptions(
  chunkCaptions: MarlinQAChunkCaption[],
  videoDurationSec: number,
): MarlinRawCaption {
  const durationSec = round3(Math.max(0, videoDurationSec));
  const events: MarlinQAEvent[] = [];
  const sceneParts: string[] = [];
  const captionParts: string[] = [];

  for (const { chunk, caption } of chunkCaptions) {
    const localEvents = parseMarlinQAEvents(caption, chunk.duration_sec);
    for (const event of localEvents) {
      const startSec = round3(clamp(chunk.start_sec + event.start_sec, 0, durationSec));
      const endSec = round3(clamp(chunk.start_sec + event.end_sec, startSec, durationSec));
      if (endSec <= startSec) continue;
      events.push({
        start_sec: startSec,
        end_sec: endSec,
        description: event.description,
        ...(isFiniteNumber(event.confidence) ? { confidence: event.confidence } : {}),
      });
    }

    const scene = caption.scene?.trim();
    if (scene) {
      sceneParts.push(`[${formatSeconds(chunk.start_sec)}-${formatSeconds(chunk.end_sec)}] ${scene}`);
    }
    const captionText = caption.caption?.trim();
    if (captionText) {
      captionParts.push(`[${formatSeconds(chunk.start_sec)}-${formatSeconds(chunk.end_sec)}] ${captionText}`);
    }
  }

  return {
    ...(sceneParts.length > 0 ? { scene: sceneParts.join("\n") } : {}),
    ...(captionParts.length > 0 ? { caption: captionParts.join("\n") } : {}),
    events: mergeMarlinQAEvents(events).map((event) => ({
      start_sec: event.start_sec,
      end_sec: event.end_sec,
      description: event.description,
      ...(isFiniteNumber(event.confidence) ? { confidence: event.confidence } : {}),
    })),
  };
}

export function mergeMarlinQAEvents(events: MarlinQAEvent[]): MarlinQAEvent[] {
  const merged: MarlinQAEvent[] = [];
  const sorted = [...events].sort((left, right) =>
    left.start_sec - right.start_sec ||
    left.end_sec - right.end_sec ||
    left.description.localeCompare(right.description)
  );

  for (const event of sorted) {
    const duplicateIndex = merged.findIndex((existing) => areDuplicateMarlinQAEvents(existing, event));
    if (duplicateIndex >= 0) {
      merged[duplicateIndex] = preferMarlinQAEvent(merged[duplicateIndex], event);
    } else {
      merged.push(event);
    }
  }

  return merged.sort((left, right) => left.start_sec - right.start_sec || left.end_sec - right.end_sec);
}

export function buildMarlinQAReport(input: BuildMarlinQAReportInput): MarlinQAReport {
  const projectId = projectIdFromBrief(input.brief, input.projectDir);
  const durationSec = round3(Math.max(0, input.videoDurationSec));
  const events = parseMarlinQAEvents(input.caption, durationSec);
  const sceneDescriptions = events.map((event) => ({
    start_sec: event.start_sec,
    end_sec: event.end_sec,
    description: event.description,
  }));
  const pacing = assessPacing(events, durationSec);
  const issues = sortMarlinQAIssues([
    ...detectMarlinQAIssues(events, durationSec, pacing),
    ...detectTimelineMicroClipIssues(input.projectDir),
  ]);
  const emotionArc = assessEmotionArc(input.brief, sceneDescriptions);

  return {
    version: "1",
    project_id: projectId,
    video_path: input.videoPath,
    video_duration_sec: durationSec,
    overall_assessment: buildOverallAssessment(issues, emotionArc.follows_brief),
    scene_descriptions: sceneDescriptions,
    issues,
    pacing_assessment: pacing,
    emotion_arc_assessment: emotionArc,
    score: scoreReport(issues),
  };
}

export function parseMarlinQAEvents(caption: MarlinRawCaption, videoDurationSec: number): MarlinQAEvent[] {
  const events = (caption.events ?? [])
    .map((event) => normalizeRawEvent(event, videoDurationSec))
    .filter((event): event is MarlinQAEvent => event !== null)
    .sort((left, right) => left.start_sec - right.start_sec || left.end_sec - right.end_sec);

  if (events.length > 0) {
    return events;
  }

  const fallbackDescription = [caption.scene, caption.caption]
    .map((value) => value?.trim())
    .find((value): value is string => Boolean(value));
  if (!fallbackDescription) {
    return [];
  }

  return [
    {
      start_sec: 0,
      end_sec: round3(Math.max(0, videoDurationSec)),
      description: fallbackDescription,
    },
  ];
}

export function assessPacing(
  events: MarlinQAEvent[],
  videoDurationSec: number,
): MarlinQAReport["pacing_assessment"] {
  const durations = events
    .map((event) => event.end_sec - event.start_sec)
    .filter((duration) => Number.isFinite(duration) && duration > 0);

  if (durations.length === 0) {
    return {
      too_fast: false,
      too_slow: false,
      notes: "Marlin returned no usable temporal events, so pacing could not be measured.",
    };
  }

  const average = durations.reduce((sum, duration) => sum + duration, 0) / durations.length;
  const tooFast = average < 1;
  const tooSlow = average > 8;
  const totalText = videoDurationSec > 0 ? ` over ${round1(videoDurationSec)}s` : "";
  const verdict = tooFast
    ? "too fast"
    : tooSlow
      ? "too slow"
      : "within expected range";

  return {
    too_fast: tooFast,
    too_slow: tooSlow,
    notes: `Average Marlin event duration is ${round1(average)}s across ${durations.length} events${totalText}; pacing reads as ${verdict}.`,
  };
}

export function detectMarlinQAIssues(
  events: MarlinQAEvent[],
  videoDurationSec: number,
  pacing: MarlinQAReport["pacing_assessment"] = assessPacing(events, videoDurationSec),
): MarlinQAIssue[] {
  const issues: MarlinQAIssue[] = [];

  for (const event of events) {
    const searchable = normalizeSearchText(event.description);
    const duration = issueDuration(event);

    if (/\b(camera moves?|camera movement|camera shake|shaky|unstable|wobbly|jittery)\b/.test(searchable)) {
      issues.push({
        timestamp_sec: event.start_sec,
        duration_sec: duration,
        category: "camera_shake",
        severity: /\b(severe|severely|unusable|unreadable|unstable)\b/.test(searchable) ? "critical" : "warning",
        description: `Possible camera stability issue: ${event.description}`,
        suggestion: "Replace with a steadier source moment, shorten the hold, or stabilize this section before the next render.",
      });
    }

    if (/\b(dimly lit|overexposed|underexposed|too dark|very dark|dark|black screen|blown out)\b/.test(searchable)) {
      issues.push({
        timestamp_sec: event.start_sec,
        duration_sec: duration,
        category: "dark_exposure",
        severity: /\b(black screen|unreadable|too dark|very dark|severe|severely)\b/.test(searchable) ? "critical" : "warning",
        description: `Possible exposure/readability issue: ${event.description}`,
        suggestion: "Replace this section with a clearer shot or adjust exposure before using the moment as a long hold.",
      });
    }

    if (/\b(static shot|nothing happens|little happens|no significant action|empty shot|dead zone|no movement)\b/.test(searchable)) {
      issues.push({
        timestamp_sec: event.start_sec,
        duration_sec: duration,
        category: "weak_content",
        severity: duration >= 4 ? "warning" : "info",
        description: `Weak or low-information section: ${event.description}`,
        suggestion: "Swap in a more specific action, reaction, or context shot, or shorten this section substantially.",
      });
    }

    if (duration > 0 && duration < MICRO_CLIP_EVENT_THRESHOLD_SEC && looksLikeBriefFlashEvent(searchable)) {
      issues.push({
        timestamp_sec: event.start_sec,
        duration_sec: duration,
        category: "micro_clip",
        severity: "warning",
        description: `Possible unintended micro-clip visible in Marlin event: ${event.description}`,
        suggestion: "Check the timeline around this timestamp and remove the flash unless it is explicitly marked as an intentional flash_cut.",
      });
    }
  }

  issues.push(...detectContinuityIssues(events));

  if (pacing.too_fast || pacing.too_slow) {
    issues.push({
      timestamp_sec: 0,
      duration_sec: round3(Math.max(0, videoDurationSec)),
      category: "pacing",
      severity: "warning",
      description: pacing.too_fast
        ? "Average Marlin event duration is under 1s, so the edit may cut too quickly for viewers to read."
        : "Average Marlin event duration is over 8s, so the edit may hold shots too long.",
      suggestion: pacing.too_fast
        ? "Lengthen key beats or reduce support cuts so the viewer can understand the action."
        : "Shorten long holds or introduce more progression through action, reaction, or place-setting shots.",
    });
  }

  return sortMarlinQAIssues(issues);
}

export function detectTimelineMicroClipIssues(projectDir: string): MarlinQAIssue[] {
  const timelinePath = path.join(projectDir, "05_timeline/timeline.json");
  if (!fs.existsSync(timelinePath)) return [];

  let timeline: unknown;
  try {
    timeline = JSON.parse(fs.readFileSync(timelinePath, "utf-8"));
  } catch {
    return [];
  }

  const doc = recordValue(timeline);
  const tracks = recordValue(doc?.tracks);
  const videoTracks = Array.isArray(tracks?.video) ? tracks.video : [];
  const fps = timelineFps(doc);
  const issues: MarlinQAIssue[] = [];

  for (const rawTrack of videoTracks) {
    const track = recordValue(rawTrack);
    const trackId = typeof track?.track_id === "string" ? track.track_id : "video";
    const clips = Array.isArray(track?.clips) ? track.clips : [];
    for (const rawClip of clips) {
      const clip = recordValue(rawClip);
      if (!clip) continue;
      const durationFrames = finiteNumber(clip.timeline_duration_frames);
      if (durationFrames === undefined || durationFrames >= MIN_RENDERABLE_TIMELINE_FRAMES) continue;
      if (isIntentionalTimelineMicroClip(clip)) continue;

      const startFrame = finiteNumber(clip.timeline_in_frame) ?? 0;
      const clipId = typeof clip.clip_id === "string" ? clip.clip_id : "unknown";
      const assetId = typeof clip.asset_id === "string" ? clip.asset_id : "unknown asset";
      issues.push({
        timestamp_sec: round3(startFrame / fps),
        duration_sec: round3(Math.max(0, durationFrames) / fps),
        category: "micro_clip",
        severity: "critical",
        description: `Timeline clip ${clipId} (${assetId}) on ${trackId} is ${durationFrames} frame(s), below the ${MIN_RENDERABLE_TIMELINE_FRAMES}-frame minimum renderable duration.`,
        suggestion: "Remove this clip and retime the sequence, or add an explicit flash_cut marker if the sub-0.5s cut is intentional.",
      });
    }
  }

  return sortMarlinQAIssues(issues);
}

export function detectContinuityIssues(events: MarlinQAEvent[]): MarlinQAIssue[] {
  const issues: MarlinQAIssue[] = [];
  const lastByScene = new Map<string, { index: number; event: MarlinQAEvent }>();
  const reported = new Set<string>();

  events.forEach((event, index) => {
    const keys = continuitySceneKeys(event.description);
    if (keys.length === 0) return;

    const repeated = keys
      .map((key) => ({ key, previous: lastByScene.get(key) }))
      .find(({ key, previous }) => previous && index - previous.index > 1 && !reported.has(key));
    if (repeated?.previous) {
      reported.add(repeated.key);
      issues.push({
        timestamp_sec: event.start_sec,
        duration_sec: issueDuration(event),
        category: "continuity",
        severity: "warning",
        description: `Scene appears to repeat non-adjacently after ${formatSeconds(repeated.previous.event.start_sec)}: ${shorten(event.description, 120)}`,
        suggestion: "Bridge the return with a clear progression beat, reorder the repeated shot next to its pair, or replace one instance.",
      });
    }

    for (const key of keys) {
      lastByScene.set(key, { index, event });
    }
  });

  return issues;
}

export function assessEmotionArc(
  brief: CreativeBrief,
  scenes: MarlinQAReport["scene_descriptions"],
): MarlinQAReport["emotion_arc_assessment"] {
  const curve = Array.isArray(brief.emotion_curve)
    ? brief.emotion_curve.map((item) => String(item).trim()).filter(Boolean)
    : [];

  if (curve.length === 0) {
    return {
      follows_brief: true,
      notes: "Brief has no emotion_curve entries to compare.",
    };
  }

  if (scenes.length === 0) {
    return {
      follows_brief: false,
      notes: `No Marlin scene descriptions were available to compare against the brief emotion curve: ${curve.join(" -> ")}.`,
    };
  }

  const distinctSceneTypes = distinctSceneTypeCount(scenes);
  if (distinctSceneTypes >= 3) {
    return {
      follows_brief: true,
      notes: `Marlin detected ${distinctSceneTypes} distinct scene types, so the emotion arc is treated as partial without exact term matching.`,
    };
  }

  return {
    follows_brief: false,
    notes: `Marlin detected only ${distinctSceneTypes} distinct scene type${distinctSceneTypes === 1 ? "" : "s"}, so the emotion arc needs review for monotony.`,
  };
}

export function writeMarlinQAReport(
  projectDir: string,
  report: MarlinQAReport,
  options: { reportDir?: string; now?: () => Date } = {},
): string {
  const root = findRepoRoot(projectDir);
  const outDir = path.resolve(root, options.reportDir ?? "reports/eval");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = (options.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, "-");
  const project = sanitizeFilePart(report.project_id);
  const reportPath = path.join(outDir, `marlin-qa-${project}_${stamp}.json`);
  const tmp = `${reportPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  fs.renameSync(tmp, reportPath);
  return reportPath;
}

export function summarizeMarlinQAReport(report: MarlinQAReport): string[] {
  const counts = issueCounts(report.issues);
  return [
    `Score: ${report.score}/100`,
    `Issues: ${report.issues.length} (critical ${counts.critical}, warning ${counts.warning}, info ${counts.info})`,
    `Pacing: ${report.pacing_assessment.too_fast ? "too fast" : report.pacing_assessment.too_slow ? "too slow" : "ok"}`,
    `Emotion arc: ${report.emotion_arc_assessment.follows_brief ? "matches brief" : "needs review"}`,
    `Overall: ${report.overall_assessment}`,
  ];
}

async function readVideoDurationSec(videoPath: string): Promise<number> {
  const probe = await runFfprobe(videoPath);
  return round3(Math.max(0, extractDurationUs(probe) / 1_000_000));
}

async function createFfmpegMarlinQAChunkClip(input: CreateMarlinQAChunkClipInput): Promise<void> {
  fs.mkdirSync(path.dirname(input.outputPath), { recursive: true });
  await execFileAsync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-ss",
    formatFfmpegSeconds(input.chunk.start_sec),
    "-i",
    input.videoPath,
    "-t",
    formatFfmpegSeconds(input.chunk.duration_sec),
    "-c",
    "copy",
    input.outputPath,
  ]);
}

async function captionMarlinQAClip(
  projectDir: string,
  videoPath: string,
  marlinFn: MarlinFn,
  prepareEvaluationClip: PrepareMarlinQAEvaluationClip,
): Promise<MarlinRawCaption> {
  const evaluationPath = await prepareEvaluationClip({ projectDir, videoPath });
  return marlinFn.caption(evaluationPath);
}

async function prepareMarlinQAEvaluationClip(input: PrepareMarlinQAEvaluationClipInput): Promise<string> {
  const proxy = await prepareMarlinProxy(input.projectDir, input.videoPath);
  return proxy.evaluationPath;
}

function applyMarlinQAProxyMaxWidth(proxyMaxWidth: number | undefined): () => void {
  const previous = process.env.VOS_MARLIN_PROXY_MAX_WIDTH;
  const requested = isFiniteNumber(proxyMaxWidth) && proxyMaxWidth > 0
    ? Math.floor(proxyMaxWidth)
    : undefined;
  process.env.VOS_MARLIN_PROXY_MAX_WIDTH = String(requested ?? previous ?? DEFAULT_QA_PROXY_MAX_WIDTH);

  return () => {
    if (previous === undefined) {
      delete process.env.VOS_MARLIN_PROXY_MAX_WIDTH;
    } else {
      process.env.VOS_MARLIN_PROXY_MAX_WIDTH = previous;
    }
  };
}

function normalizeRawEvent(raw: MarlinRawEvent, videoDurationSec: number): MarlinQAEvent | null {
  const description = raw.description?.trim().replace(/\s+/g, " ");
  if (!description) return null;

  const rawStart = raw.start_sec ?? raw.start;
  const rawEnd = raw.end_sec ?? raw.end;
  if (!isFiniteNumber(rawStart) || !isFiniteNumber(rawEnd)) return null;

  const maxEnd = videoDurationSec > 0 ? videoDurationSec : rawEnd;
  const start = round3(clamp(rawStart, 0, maxEnd));
  const end = round3(clamp(rawEnd, start, maxEnd));
  if (end <= start) return null;

  return {
    start_sec: start,
    end_sec: end,
    description,
    ...(isFiniteNumber(raw.confidence) ? { confidence: clamp(raw.confidence, 0, 1) } : {}),
  };
}

function buildOverallAssessment(issues: MarlinQAIssue[], followsBrief: boolean): string {
  const counts = issueCounts(issues);
  if (counts.critical > 0) {
    return `Needs revision: Marlin QA found ${counts.critical} critical issue${counts.critical === 1 ? "" : "s"} and ${issues.length} total issue${issues.length === 1 ? "" : "s"}.`;
  }
  if (counts.warning > 0) {
    return `Usable rough cut with revisions recommended: Marlin QA found ${counts.warning} warning${counts.warning === 1 ? "" : "s"}.`;
  }
  if (!followsBrief) {
    return "No obvious visual quality issues, but the observed scene descriptions do not clearly follow the brief emotion curve.";
  }
  return "No obvious Marlin QA issues detected in the rendered rough cut.";
}

function scoreReport(issues: MarlinQAIssue[]): number {
  let score = 100;
  for (const issue of issues) {
    score -= issueScoreDeduction(issue);
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

function issueScoreDeduction(issue: MarlinQAIssue): number {
  if (issue.severity === "critical") return 25;
  if (issue.severity === "info") return 2;

  switch (issue.category) {
    case "camera_shake":
      return 15;
    case "continuity":
      return 8;
    case "pacing":
      return 10;
    case "micro_clip":
      return 12;
    case "weak_content":
      return 5;
    default:
      return 10;
  }
}

function issueCounts(issues: MarlinQAIssue[]): Record<MarlinQAIssue["severity"], number> {
  return issues.reduce(
    (counts, issue) => {
      counts[issue.severity] += 1;
      return counts;
    },
    { critical: 0, warning: 0, info: 0 },
  );
}

function issueDuration(event: MarlinQAEvent): number {
  return round3(Math.max(0, event.end_sec - event.start_sec));
}

function severityRank(severity: MarlinQAIssue["severity"]): number {
  if (severity === "critical") return 3;
  if (severity === "warning") return 2;
  return 1;
}

function areDuplicateMarlinQAEvents(left: MarlinQAEvent, right: MarlinQAEvent): boolean {
  const overlapSec = Math.min(left.end_sec, right.end_sec) - Math.max(left.start_sec, right.start_sec);
  if (overlapSec <= 0) return false;

  const shorterDurationSec = Math.min(issueDuration(left), issueDuration(right));
  if (overlapSec < Math.min(1, shorterDurationSec * 0.5)) return false;

  return descriptionsAreSimilar(left.description, right.description);
}

function descriptionsAreSimilar(left: string, right: string): boolean {
  const leftText = normalizeSearchText(left).replace(/[^\p{L}\p{N}\s]+/gu, " ");
  const rightText = normalizeSearchText(right).replace(/[^\p{L}\p{N}\s]+/gu, " ");
  if (!leftText || !rightText) return false;
  if (leftText === rightText) return true;
  if (leftText.length >= 10 && rightText.includes(leftText)) return true;
  if (rightText.length >= 10 && leftText.includes(rightText)) return true;

  const leftTokens = meaningfulTokens(leftText);
  const rightTokens = meaningfulTokens(rightText);
  if (leftTokens.length === 0 || rightTokens.length === 0) return false;

  const leftSet = new Set(leftTokens);
  const rightSet = new Set(rightTokens);
  const shared = [...leftSet].filter((token) => rightSet.has(token)).length;
  const union = new Set([...leftSet, ...rightSet]).size;
  return shared >= 2 && shared / union >= 0.5;
}

function preferMarlinQAEvent(left: MarlinQAEvent, right: MarlinQAEvent): MarlinQAEvent {
  const leftConfidence = left.confidence ?? -1;
  const rightConfidence = right.confidence ?? -1;
  if (leftConfidence !== rightConfidence) {
    return rightConfidence > leftConfidence ? right : left;
  }

  if (left.description.length !== right.description.length) {
    return right.description.length > left.description.length ? right : left;
  }

  const leftDuration = issueDuration(left);
  const rightDuration = issueDuration(right);
  if (leftDuration !== rightDuration) {
    return rightDuration > leftDuration ? right : left;
  }

  return left.start_sec <= right.start_sec ? left : right;
}

function projectIdFromBrief(brief: CreativeBrief, projectDir: string): string {
  return brief.project_id || brief.project?.id || path.basename(path.resolve(projectDir));
}

function resolveVideoPath(projectDir: string, videoPath: string): string {
  return path.isAbsolute(videoPath) ? videoPath : path.resolve(projectDir, videoPath);
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function sortMarlinQAIssues(issues: MarlinQAIssue[]): MarlinQAIssue[] {
  return issues.sort((left, right) =>
    left.timestamp_sec - right.timestamp_sec ||
    severityRank(right.severity) - severityRank(left.severity) ||
    left.category.localeCompare(right.category)
  );
}

function looksLikeBriefFlashEvent(searchable: string): boolean {
  return /\b(flash|flashes|brief|briefly|sudden|suddenly|momentary|blink|single[- ]frame|one[- ]frame|split[- ]second|quick image|brief image|sudden image|image appears briefly)\b/.test(searchable);
}

function timelineFps(doc: Record<string, unknown> | undefined): number {
  const sequence = recordValue(doc?.sequence);
  const fpsNum = finiteNumber(sequence?.fps_num);
  const fpsDen = finiteNumber(sequence?.fps_den);
  const fps = (fpsNum && fpsNum > 0 ? fpsNum : 24) / (fpsDen && fpsDen > 0 ? fpsDen : 1);
  return fps > 0 ? fps : 24;
}

function isIntentionalTimelineMicroClip(clip: Record<string, unknown>): boolean {
  if (hasTimelineShortClipMarker(clip)) return true;
  const metadata = recordValue(clip.metadata);
  if (!metadata) return false;
  return hasTimelineShortClipMarker(metadata) ||
    hasTimelineShortClipMarker(recordValue(metadata.craft)) ||
    hasTimelineShortClipMarker(recordValue(metadata.editorial)) ||
    hasTimelineShortClipMarker(recordValue(metadata.trim));
}

function hasTimelineShortClipMarker(value: Record<string, unknown> | undefined): boolean {
  return value?.flash_cut === true ||
    value?.intentional_flash_cut === true ||
    value?.intentional_short_clip === true ||
    value?.intentional_micro_clip === true;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return isFiniteNumber(value) ? value : undefined;
}

const CONTINUITY_STOPWORDS = new Set([
  "the",
  "and",
  "with",
  "from",
  "into",
  "onto",
  "that",
  "this",
  "there",
  "scene",
  "shot",
  "video",
  "clip",
  "camera",
  "view",
  "shows",
  "showing",
  "visible",
  "person",
  "people",
  "someone",
  "static",
  "wide",
  "close",
  "closeup",
  "medium",
  "slow",
  "quick",
  "cuts",
  "cut",
]);

const GENERIC_CONTINUITY_DESCRIPTIONS = new Set([
  "subjects hold a static pose",
  "static shot",
  "camera remains stationary",
  "remains stationary",
  "static pose",
].map(normalizeGenericContinuityDescription));

function continuitySceneKeys(description: string): string[] {
  if (isGenericContinuityDescription(description)) return [];

  const tokens = meaningfulTokens(description);

  if (tokens.length < 2) return [];
  const keys = [tokens.slice(0, 8).join(" ")];
  for (const token of tokens) {
    if (token.length >= 6) keys.push(token);
  }
  return [...new Set(keys)];
}

function meaningfulTokens(description: string): string[] {
  return normalizeSearchText(description)
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !CONTINUITY_STOPWORDS.has(token));
}

function isGenericContinuityDescription(description: string): boolean {
  return GENERIC_CONTINUITY_DESCRIPTIONS.has(normalizeGenericContinuityDescription(description));
}

function normalizeGenericContinuityDescription(description: string): string {
  return normalizeSearchText(description)
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function distinctSceneTypeCount(scenes: MarlinQAReport["scene_descriptions"]): number {
  const keys = scenes
    .map((scene) => normalizeSearchText(scene.description).slice(0, 30).trim())
    .filter(Boolean);
  return new Set(keys).size;
}

function shorten(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}...`;
}

function sanitizeFilePart(value: string): string {
  return value.replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "") || "project";
}

function formatSeconds(value: number): string {
  return `${round1(value)}s`;
}

function formatFfmpegSeconds(value: number): string {
  return round3(Math.max(0, value)).toFixed(3);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return isFiniteNumber(value) && value > 0 ? value : fallback;
}

function findRepoRoot(from: string): string {
  let dir = path.resolve(from);
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "package.json")) && fs.existsSync(path.join(dir, "schemas"))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return process.cwd();
}
