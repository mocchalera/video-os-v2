import { spawnSync } from "node:child_process";

export type DeterministicOutputQAStatus = "verified" | "blocked" | "incomplete";
export type DeterministicOutputQAIssueKind =
  | "black"
  | "freeze"
  | "inset"
  | "dimensions"
  | "decode";

export interface DeterministicOutputQAIssue {
  kind: DeterministicOutputQAIssueKind;
  severity: "blocking";
  detail: string;
  start_sec?: number;
  end_sec?: number;
}

export interface DeterministicOutputQAResult {
  status: DeterministicOutputQAStatus;
  duration_sec?: number;
  scanned_duration_sec?: number;
  width?: number;
  height?: number;
  issues: DeterministicOutputQAIssue[];
  reason?: string;
}

export interface DeterministicOutputQAAllowedRange {
  kind: "black" | "freeze" | "inset";
  start_sec: number;
  end_sec: number;
  reason: string;
}

export interface DeterministicOutputQAOptions {
  expectedWidth?: number;
  expectedHeight?: number;
  allowedRanges?: DeterministicOutputQAAllowedRange[];
  commandRunner?: DeterministicOutputQACommandRunner;
}

export interface DeterministicTimelineIntent {
  sequence?: {
    fps_num?: number;
    fps_den?: number;
  };
  tracks?: {
    video?: Array<{
      clips?: Array<{
        clip_id?: string;
        media_kind?: string;
        timeline_in_frame?: number;
        timeline_duration_frames?: number;
        still_image?: {
          fit_mode?: string;
          background?: string;
        };
      }>;
    }>;
    audio?: Array<{
      clips?: Array<{
        clip_id?: string;
        timeline_in_frame?: number;
        timeline_duration_frames?: number;
      }>;
    }>;
    overlay?: Array<{
      clips?: Array<{
        clip_id?: string;
        timeline_in_frame?: number;
        timeline_duration_frames?: number;
        content_element?: {
          template_ref?: string;
        };
        metadata?: {
          content_element?: {
            template_ref?: string;
          };
        };
      }>;
    }>;
  };
  transitions?: Array<{
    transition_id?: string;
    transition_type?: string;
    start_frame?: number;
    duration_frames?: number;
    applied_skill_id?: string;
    transition_params?: {
      hold_frames?: number;
    };
  }>;
}

export interface DeterministicEndingIntent {
  video_fade_color?: "none" | "black" | "white";
  video_fade_out_sec?: number;
}

export interface DeterministicOutputQACommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export type DeterministicOutputQACommandRunner = (
  command: string,
  args: string[],
) => DeterministicOutputQACommandResult;

interface ProbeResult {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
}

interface TimedRegion {
  startSec: number;
  endSec: number;
}

interface CropSample {
  timeSec: number;
  width: number;
  height: number;
  x: number;
  y: number;
}

const MIN_BLACK_DURATION_SEC = 0.15;
const MIN_FREEZE_DURATION_SEC = 0.5;
const MIN_INSET_DURATION_SEC = 0.15;
const MIN_INSET_MARGIN_PX = 16;
const CROP_SAMPLE_GAP_SEC = 0.2;

const defaultCommandRunner: DeterministicOutputQACommandRunner = (
  command,
  args,
) => {
  const result = spawnSync(command, args, {
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error ? { error: result.error.message } : {}),
  };
};

/**
 * Convert canonical, explicit timeline intent into reasoned detector
 * exceptions. No range is inferred from detector output itself, so a visual
 * anomaly cannot self-waive.
 */
export function deriveDeterministicAllowedRanges(
  timeline: DeterministicTimelineIntent,
  endingIntent?: DeterministicEndingIntent,
): DeterministicOutputQAAllowedRange[] {
  const fpsNum = timeline.sequence?.fps_num;
  const fpsDen = timeline.sequence?.fps_den ?? 1;
  if (
    !Number.isFinite(fpsNum) ||
    !Number.isFinite(fpsDen) ||
    !fpsNum ||
    !fpsDen ||
    fpsNum <= 0 ||
    fpsDen <= 0
  ) {
    return [];
  }
  const fps = fpsNum / fpsDen;
  const ranges: DeterministicOutputQAAllowedRange[] = [];
  let timelineEndFrame = 0;
  let hasVisualIntent = false;

  for (const track of timeline.tracks?.video ?? []) {
    for (const clip of track.clips ?? []) {
      const startFrame = clip.timeline_in_frame;
      const durationFrames = clip.timeline_duration_frames;
      if (
        !Number.isFinite(startFrame) ||
        !Number.isFinite(durationFrames) ||
        startFrame === undefined ||
        durationFrames === undefined ||
        durationFrames <= 0
      ) {
        continue;
      }
      hasVisualIntent = true;
      timelineEndFrame = Math.max(timelineEndFrame, startFrame + durationFrames);
      if (clip.media_kind !== "image") continue;
      const startSec = startFrame / fps;
      const endSec = (startFrame + durationFrames) / fps;
      const clipLabel = clip.clip_id ?? "unnamed image clip";
      ranges.push({
        kind: "freeze",
        start_sec: startSec,
        end_sec: endSec,
        reason: `canonical still-image hold: ${clipLabel}`,
      });
      if (clip.still_image?.fit_mode === "contain") {
        ranges.push({
          kind: "inset",
          start_sec: startSec,
          end_sec: endSec,
          reason: `canonical contain-fit still image: ${clipLabel}`,
        });
      }
    }
  }

  for (const track of timeline.tracks?.overlay ?? []) {
    for (const clip of track.clips ?? []) {
      const startFrame = clip.timeline_in_frame;
      const durationFrames = clip.timeline_duration_frames;
      const templateRef = clip.content_element?.template_ref ??
        clip.metadata?.content_element?.template_ref;
      if (
        templateRef !== "vos:content.cta-card/v1" ||
        startFrame === undefined ||
        durationFrames === undefined ||
        !Number.isFinite(startFrame) ||
        !Number.isFinite(durationFrames) ||
        durationFrames <= 0
      ) {
        continue;
      }
      hasVisualIntent = true;
      timelineEndFrame = Math.max(timelineEndFrame, startFrame + durationFrames);
      ranges.push({
        kind: "freeze",
        start_sec: startFrame / fps,
        end_sec: (startFrame + durationFrames) / fps,
        reason: `canonical full-frame CTA card: ${clip.clip_id ?? "unnamed CTA"}`,
      });
    }
  }

  let audioEndFrame = 0;
  for (const track of timeline.tracks?.audio ?? []) {
    for (const clip of track.clips ?? []) {
      const startFrame = clip.timeline_in_frame;
      const durationFrames = clip.timeline_duration_frames;
      if (
        startFrame === undefined ||
        durationFrames === undefined ||
        !Number.isFinite(startFrame) ||
        !Number.isFinite(durationFrames) ||
        startFrame < 0 ||
        durationFrames <= 0
      ) {
        continue;
      }
      audioEndFrame = Math.max(audioEndFrame, startFrame + durationFrames);
    }
  }
  if (!hasVisualIntent && audioEndFrame > 0) {
    const endSec = audioEndFrame / fps;
    ranges.push(
      {
        kind: "black",
        start_sec: 0,
        end_sec: endSec,
        reason: "canonical audio-only canvas",
      },
      {
        kind: "freeze",
        start_sec: 0,
        end_sec: endSec,
        reason: "canonical audio-only canvas",
      },
    );
    timelineEndFrame = Math.max(timelineEndFrame, audioEndFrame);
  }

  for (const transition of timeline.transitions ?? []) {
    const startFrame = transition.start_frame;
    const durationFrames = transition.duration_frames ??
      transition.transition_params?.hold_frames;
    if (
      startFrame === undefined ||
      durationFrames === undefined ||
      !Number.isFinite(startFrame) ||
      !Number.isFinite(durationFrames) ||
      durationFrames <= 0
    ) {
      continue;
    }
    const startSec = startFrame / fps;
    const endSec = (startFrame + durationFrames) / fps;
    const transitionLabel = transition.transition_id ?? "unnamed transition";
    if (
      transition.applied_skill_id?.endsWith("freeze_hold") ||
      transition.applied_skill_id === "freeze_hold"
    ) {
      ranges.push({
        kind: "freeze",
        start_sec: startSec,
        end_sec: endSec,
        reason: `canonical freeze-hold transition: ${transitionLabel}`,
      });
    }
    if (transition.transition_type === "fade_to_black") {
      ranges.push({
        kind: "black",
        start_sec: startSec,
        end_sec: endSec,
        reason: `canonical fade-to-black transition: ${transitionLabel}`,
      });
    }
  }

  if (
    endingIntent?.video_fade_color === "black" &&
    Number.isFinite(endingIntent.video_fade_out_sec) &&
    (endingIntent.video_fade_out_sec ?? 0) > 0 &&
    timelineEndFrame > 0
  ) {
    const endSec = timelineEndFrame / fps;
    ranges.push({
      kind: "black",
      start_sec: Math.max(0, endSec - endingIntent.video_fade_out_sec!),
      end_sec: endSec,
      reason: "canonical ending_policy video fade to black",
    });
  }

  return ranges;
}

/**
 * Scan the complete rendered video with deterministic ffprobe/ffmpeg filters.
 * A failed or partial scan is never treated as approval-grade.
 */
export function runDeterministicOutputQA(
  videoPath: string,
  options: DeterministicOutputQAOptions = {},
): DeterministicOutputQAResult {
  const runner = options.commandRunner ?? defaultCommandRunner;
  const probe = runner("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height,avg_frame_rate:format=duration",
    "-of",
    "json",
    videoPath,
  ]);
  if (probe.status !== 0) {
    return incompleteResult(
      `ffprobe_failed: ${commandFailureDetail(probe)}`,
    );
  }

  const metadata = parseProbeResult(probe.stdout);
  if (!metadata) {
    return incompleteResult("ffprobe_failed: invalid or missing video metadata");
  }

  const issues: DeterministicOutputQAIssue[] = [];
  if (
    options.expectedWidth !== undefined &&
    options.expectedHeight !== undefined &&
    (
      metadata.width !== options.expectedWidth ||
      metadata.height !== options.expectedHeight
    )
  ) {
    issues.push({
      kind: "dimensions",
      severity: "blocking",
      detail:
        `rendered ${metadata.width}x${metadata.height}; expected ` +
        `${options.expectedWidth}x${options.expectedHeight}`,
    });
  }

  const scan = runner("ffmpeg", [
    "-hide_banner",
    "-nostdin",
    "-v",
    "info",
    "-xerror",
    "-i",
    videoPath,
    "-map",
    "0:v:0",
    "-map",
    "0:a?",
    "-vf",
    [
      `blackdetect=d=${MIN_BLACK_DURATION_SEC}:pic_th=0.98`,
      `freezedetect=n=-60dB:d=${MIN_FREEZE_DURATION_SEC}`,
      "cropdetect=limit=24:round=2:reset=1",
    ].join(","),
    "-progress",
    "pipe:1",
    "-nostats",
    "-f",
    "null",
    "-",
  ]);
  if (scan.status !== 0) {
    return {
      ...incompleteResult(`ffmpeg_scan_failed: ${commandFailureDetail(scan)}`),
      duration_sec: metadata.durationSec,
      width: metadata.width,
      height: metadata.height,
      issues,
    };
  }

  const scanLog = `${scan.stdout}\n${scan.stderr}`;
  if (hasDecodeFailure(scanLog)) {
    return {
      status: "incomplete",
      reason: "ffmpeg_scan_incomplete: decode errors were reported",
      duration_sec: metadata.durationSec,
      width: metadata.width,
      height: metadata.height,
      issues: [
        ...issues,
        {
          kind: "decode",
          severity: "blocking",
          detail: "ffmpeg reported a decode error during the full-output scan",
        },
      ],
    };
  }
  const scanProgress = parseScanProgress(scan.stdout);
  const completionToleranceSec = Math.max(1 / metadata.fps, 0.05);
  if (
    !scanProgress.completed ||
    scanProgress.outTimeSec === undefined ||
    Math.abs(metadata.durationSec - scanProgress.outTimeSec) > completionToleranceSec
  ) {
    return {
      status: "incomplete",
      reason:
        `ffmpeg_scan_incomplete: scanned ${scanProgress.outTimeSec?.toFixed(3) ?? "unknown"}s ` +
        `of ${metadata.durationSec.toFixed(3)}s`,
      duration_sec: metadata.durationSec,
      ...(scanProgress.outTimeSec !== undefined
        ? { scanned_duration_sec: scanProgress.outTimeSec }
        : {}),
      width: metadata.width,
      height: metadata.height,
      issues,
    };
  }

  const allowedRanges = options.allowedRanges ?? [];
  for (const region of parseBlackRegions(scanLog)) {
    if (
      region.endSec - region.startSec >= MIN_BLACK_DURATION_SEC &&
      !isAllowed("black", region, allowedRanges)
    ) {
      issues.push(timedIssue("black", region, "black output region"));
    }
  }
  for (const region of parseFreezeRegions(scanLog, metadata.durationSec)) {
    if (
      region.endSec - region.startSec >= MIN_FREEZE_DURATION_SEC &&
      !isAllowed("freeze", region, allowedRanges)
    ) {
      issues.push(timedIssue("freeze", region, "frozen output region"));
    }
  }
  for (
    const region of detectFourSidedInsets(
      parseCropSamples(scanLog),
      metadata.width,
      metadata.height,
    )
  ) {
    if (!isAllowed("inset", region, allowedRanges)) {
      issues.push(timedIssue(
        "inset",
        region,
        `persistent four-sided inset of at least ${MIN_INSET_MARGIN_PX}px`,
      ));
    }
  }

  return {
    status: issues.length > 0 ? "blocked" : "verified",
    duration_sec: metadata.durationSec,
    scanned_duration_sec: scanProgress.outTimeSec,
    width: metadata.width,
    height: metadata.height,
    issues,
  };
}

export function parseBlackRegions(log: string): TimedRegion[] {
  const regions: TimedRegion[] = [];
  const pattern =
    /black_start:(\d+(?:\.\d+)?)\s+black_end:(\d+(?:\.\d+)?)\s+black_duration:(\d+(?:\.\d+)?)/g;
  for (const match of log.matchAll(pattern)) {
    regions.push({
      startSec: Number(match[1]),
      endSec: Number(match[2]),
    });
  }
  return regions;
}

export function parseFreezeRegions(
  log: string,
  durationSec: number,
): TimedRegion[] {
  const events = [...log.matchAll(/freeze_(start|end):\s*(\d+(?:\.\d+)?)/g)]
    .map((match) => ({ kind: match[1], timeSec: Number(match[2]) }));
  const regions: TimedRegion[] = [];
  let startSec: number | undefined;
  for (const event of events) {
    if (event.kind === "start") {
      startSec = event.timeSec;
    } else if (startSec !== undefined) {
      regions.push({ startSec, endSec: event.timeSec });
      startSec = undefined;
    }
  }
  if (startSec !== undefined && durationSec >= startSec) {
    regions.push({ startSec, endSec: durationSec });
  }
  return regions;
}

export function parseCropSamples(log: string): CropSample[] {
  const samples: CropSample[] = [];
  const pattern =
    /\bt:(\d+(?:\.\d+)?)\b[^\n]*\bcrop:(\d+):(\d+):(\d+):(\d+)/g;
  for (const match of log.matchAll(pattern)) {
    samples.push({
      timeSec: Number(match[1]),
      width: Number(match[2]),
      height: Number(match[3]),
      x: Number(match[4]),
      y: Number(match[5]),
    });
  }
  return samples;
}

export function detectFourSidedInsets(
  samples: CropSample[],
  frameWidth: number,
  frameHeight: number,
): TimedRegion[] {
  const insetSamples = samples
    .filter((sample) => {
      const right = frameWidth - sample.x - sample.width;
      const bottom = frameHeight - sample.y - sample.height;
      return sample.x >= MIN_INSET_MARGIN_PX &&
        sample.y >= MIN_INSET_MARGIN_PX &&
        right >= MIN_INSET_MARGIN_PX &&
        bottom >= MIN_INSET_MARGIN_PX;
    })
    .sort((a, b) => a.timeSec - b.timeSec);
  if (insetSamples.length === 0) return [];

  const regions: TimedRegion[] = [];
  let startSec = insetSamples[0].timeSec;
  let endSec = startSec;
  for (const sample of insetSamples.slice(1)) {
    if (sample.timeSec - endSec <= CROP_SAMPLE_GAP_SEC) {
      endSec = sample.timeSec;
      continue;
    }
    if (endSec - startSec >= MIN_INSET_DURATION_SEC) {
      regions.push({ startSec, endSec });
    }
    startSec = sample.timeSec;
    endSec = sample.timeSec;
  }
  if (endSec - startSec >= MIN_INSET_DURATION_SEC) {
    regions.push({ startSec, endSec });
  }
  return regions;
}

function parseProbeResult(stdout: string): ProbeResult | null {
  try {
    const parsed = JSON.parse(stdout) as {
      streams?: Array<{
        width?: unknown;
        height?: unknown;
        avg_frame_rate?: unknown;
      }>;
      format?: { duration?: unknown };
    };
    const width = Number(parsed.streams?.[0]?.width);
    const height = Number(parsed.streams?.[0]?.height);
    const durationSec = Number(parsed.format?.duration);
    const fps = parseRate(parsed.streams?.[0]?.avg_frame_rate);
    if (
      !Number.isFinite(width) ||
      width <= 0 ||
      !Number.isFinite(height) ||
      height <= 0 ||
      !Number.isFinite(durationSec) ||
      durationSec <= 0 ||
      fps === null
    ) {
      return null;
    }
    return { width, height, durationSec, fps };
  } catch {
    return null;
  }
}

function parseScanProgress(stdout: string): {
  completed: boolean;
  outTimeSec?: number;
} {
  let outTimeSec: number | undefined;
  let completed = false;
  for (const line of stdout.split(/\r?\n/)) {
    const [key, rawValue] = line.split("=", 2);
    if (key === "out_time_us") {
      const value = Number(rawValue);
      if (Number.isFinite(value) && value >= 0) {
        outTimeSec = value / 1_000_000;
      }
    } else if (key === "progress" && rawValue === "end") {
      completed = true;
    }
  }
  return { completed, ...(outTimeSec !== undefined ? { outTimeSec } : {}) };
}

function parseRate(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const [rawNum, rawDen = "1"] = value.split("/", 2);
  const num = Number(rawNum);
  const den = Number(rawDen);
  if (!Number.isFinite(num) || !Number.isFinite(den) || num <= 0 || den <= 0) {
    return null;
  }
  return num / den;
}

function incompleteResult(reason: string): DeterministicOutputQAResult {
  return { status: "incomplete", reason, issues: [] };
}

function commandFailureDetail(
  result: DeterministicOutputQACommandResult,
): string {
  return (result.error || result.stderr || result.stdout || "unknown command failure")
    .trim()
    .split("\n")
    .slice(0, 3)
    .join(" ");
}

function hasDecodeFailure(log: string): boolean {
  return /error while decoding|invalid data found|corrupt decoded frame|decode_slice_header error/i
    .test(log);
}

function isAllowed(
  kind: DeterministicOutputQAAllowedRange["kind"],
  region: TimedRegion,
  allowedRanges: DeterministicOutputQAAllowedRange[],
): boolean {
  const toleranceSec = 0.05;
  return allowedRanges.some((allowed) =>
    allowed.kind === kind &&
    allowed.reason.trim().length > 0 &&
    region.startSec >= allowed.start_sec - toleranceSec &&
    region.endSec <= allowed.end_sec + toleranceSec
  );
}

function timedIssue(
  kind: "black" | "freeze" | "inset",
  region: TimedRegion,
  label: string,
): DeterministicOutputQAIssue {
  return {
    kind,
    severity: "blocking",
    start_sec: roundSeconds(region.startSec),
    end_sec: roundSeconds(region.endSec),
    detail: `${label} from ${region.startSec.toFixed(3)}s to ${region.endSec.toFixed(3)}s`,
  };
}

function roundSeconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}
