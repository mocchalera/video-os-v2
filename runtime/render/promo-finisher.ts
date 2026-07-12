import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type { CaptionOverlay, ClipOutput, TimelineIR, TrackOutput } from "../compiler/types.js";
import {
  assembleTimelineToMp4,
  getTimelineDurationFrames,
  getTimelineFps,
  readTimeline,
  type AssemblerOptions,
  type AssemblyResult,
  type ExecFileLike,
} from "./assembler.js";

const DEFAULT_CAPTION_MAX_CHARS = 26;
const DEFAULT_MIN_CAPTION_FRAMES = 8;
const DEFAULT_MIN_TRANSCRIPT_OVERLAP_RATIO = 0.45;
const DEFAULT_ENDING_TAIL_SEC = 0.8;
const DEFAULT_ENDING_FADE_SEC = 0.8;

const execFileAsync = promisify(execFile);

interface TranscriptItem {
  start_us: number;
  end_us: number;
  text: string;
}

interface TranscriptJson {
  asset_id?: string;
  items?: TranscriptItem[];
}

interface AssetsJson {
  assets?: Array<{
    asset_id?: string;
    duration_us?: number;
  }>;
  items?: Array<{
    asset_id?: string;
    duration_us?: number;
  }>;
}

export interface CaptionGenerationOptions {
  maxChars?: number;
  minCaptionFrames?: number;
  minTranscriptOverlapRatio?: number;
  style?: CaptionOverlay["style"];
}

export interface CaptionGenerationSummary {
  captionCount: number;
  transcriptAssets: number;
  clipsWithCaptions: number;
}

export interface EndingTailOptions {
  tailSec?: number;
}

export interface EndingTailSummary {
  extended: boolean;
  assetId?: string;
  clipId?: string;
  oldSrcOutUs?: number;
  newSrcOutUs?: number;
  addedFrames: number;
  updatedAudioClipIds: string[];
  reason?: string;
}

export interface AssSubtitleStyleOptions {
  fontName?: string;
  fontSize?: number;
  bold?: boolean;
  outline?: number;
  marginV?: number;
  primaryColor?: string;
  outlineColor?: string;
  playResX?: number;
  playResY?: number;
}

export interface PromoFinalizeFfmpegArgsOptions {
  inputPath: string;
  outputPath: string;
  assPath: string;
  durationSec: number;
  fadeSec?: number;
  fontsDir?: string;
  videoCodec?: string;
  audioCodec?: string;
}

export interface PromoFinishOptions {
  projectDir: string;
  timelinePath?: string;
  outputPath?: string;
  workDir?: string;
  endingTailSec?: number;
  endingFadeSec?: number;
  captionMaxChars?: number;
  captionMinFrames?: number;
  subtitles?: boolean;
  ffmpegBin?: string;
  ffprobeBin?: string;
  fontsDir?: string;
  execFileImpl?: ExecFileLike;
  assembleTimelineToMp4Impl?: (options: AssemblerOptions) => Promise<AssemblyResult>;
}

export interface PromoFinishResult {
  outputPath: string;
  basePath: string;
  assPath: string;
  adjustedTimelinePath: string;
  renderTimelinePath: string;
  captionSummary: CaptionGenerationSummary;
  tailSummary: EndingTailSummary;
  durationSec: number;
}

export function cloneTimeline(timeline: TimelineIR): TimelineIR {
  return JSON.parse(JSON.stringify(timeline)) as TimelineIR;
}

export function splitCaptionText(text: string, maxChars = DEFAULT_CAPTION_MAX_CHARS): string[] {
  const normalized = normalizeCaptionText(text);
  if (!normalized) {
    return [];
  }
  if (normalized.length <= maxChars) {
    return [normalized];
  }

  const chunks: string[] = [];
  const phrases = normalized.split(/(?<=[、。！？!?])/u).map((part) => part.trim()).filter(Boolean);
  for (const phrase of phrases.length > 0 ? phrases : [normalized]) {
    let rest = phrase;
    while (rest.length > maxChars) {
      const cut = chooseCaptionCut(rest, maxChars);
      const head = trimCaptionBoundary(rest.slice(0, cut));
      if (head) {
        chunks.push(head);
      }
      rest = rest.slice(cut).trim();
    }
    const tail = trimCaptionBoundary(rest);
    if (tail) {
      chunks.push(tail);
    }
  }

  return mergeDependentCaptionChunks(
    chunks.length > 0 ? chunks : [normalized.slice(0, maxChars)],
    maxChars,
  );
}

export function attachTranscriptAlignedCaptions(
  timeline: TimelineIR,
  projectDir: string,
  options: CaptionGenerationOptions = {},
): CaptionGenerationSummary {
  const fps = getTimelineFps(timeline);
  const transcripts = loadTranscriptsByAsset(projectDir);
  const maxChars = options.maxChars ?? DEFAULT_CAPTION_MAX_CHARS;
  const minCaptionFrames = options.minCaptionFrames ?? DEFAULT_MIN_CAPTION_FRAMES;
  const minTranscriptOverlapRatio = options.minTranscriptOverlapRatio ?? DEFAULT_MIN_TRANSCRIPT_OVERLAP_RATIO;
  const captionStyle = options.style ?? "simple-shadow";
  let captionCount = 0;
  let clipsWithCaptions = 0;

  for (const track of timeline.tracks.video) {
    for (const clip of track.clips) {
      const items = transcripts.get(clip.asset_id);
      if (!items || items.length === 0) {
        continue;
      }
      const captions = buildCaptionsForClip(clip, items, fps, {
        maxChars,
        minCaptionFrames,
        minTranscriptOverlapRatio,
        style: captionStyle,
      });
      if (captions.length === 0) {
        continue;
      }
      clip.captions = captions;
      captionCount += captions.length;
      clipsWithCaptions += 1;
    }
  }

  return {
    captionCount,
    transcriptAssets: transcripts.size,
    clipsWithCaptions,
  };
}

export function extendFinalClipTail(
  timeline: TimelineIR,
  projectDir: string,
  options: EndingTailOptions = {},
): EndingTailSummary {
  const tailSec = options.tailSec ?? DEFAULT_ENDING_TAIL_SEC;
  if (tailSec <= 0) {
    return { extended: false, addedFrames: 0, updatedAudioClipIds: [], reason: "tail disabled" };
  }

  const fps = getTimelineFps(timeline);
  const finalRef = findFinalVideoClip(timeline);
  if (!finalRef) {
    return { extended: false, addedFrames: 0, updatedAudioClipIds: [], reason: "no video clips" };
  }

  const assetDurations = loadAssetDurations(projectDir);
  const sourceDurationUs = assetDurations.get(finalRef.clip.asset_id);
  if (!sourceDurationUs || sourceDurationUs <= finalRef.clip.src_out_us) {
    return {
      extended: false,
      assetId: finalRef.clip.asset_id,
      clipId: finalRef.clip.clip_id,
      addedFrames: 0,
      updatedAudioClipIds: [],
      reason: "source tail unavailable",
    };
  }

  const tailUs = Math.round(tailSec * 1_000_000);
  const oldSrcOutUs = finalRef.clip.src_out_us;
  const speechTailTargetUs = resolveSpeechTailTargetUs(projectDir, finalRef.clip, tailUs);
  const desiredSrcOutUs = speechTailTargetUs ?? oldSrcOutUs + tailUs;
  const frameToleranceUs = Math.round((1_000_000 / fps) / 2);
  if (oldSrcOutUs + frameToleranceUs >= desiredSrcOutUs) {
    return {
      extended: false,
      assetId: finalRef.clip.asset_id,
      clipId: finalRef.clip.clip_id,
      oldSrcOutUs,
      newSrcOutUs: oldSrcOutUs,
      addedFrames: 0,
      updatedAudioClipIds: [],
      reason: "speech tail already present",
    };
  }

  const newSrcOutUs = Math.min(sourceDurationUs, desiredSrcOutUs);
  const addedFrames = Math.max(0, Math.round(((newSrcOutUs - oldSrcOutUs) / 1_000_000) * fps));
  if (addedFrames <= 0) {
    return {
      extended: false,
      assetId: finalRef.clip.asset_id,
      clipId: finalRef.clip.clip_id,
      oldSrcOutUs,
      newSrcOutUs,
      addedFrames: 0,
      updatedAudioClipIds: [],
      reason: "tail shorter than one frame",
    };
  }

  const oldDurationFrames = finalRef.clip.timeline_duration_frames;
  finalRef.clip.src_out_us = newSrcOutUs;
  finalRef.clip.timeline_duration_frames = oldDurationFrames + addedFrames;
  finalRef.clip.metadata = {
    ...finalRef.clip.metadata,
    promo_finish: {
      ...(isRecord(finalRef.clip.metadata?.promo_finish) ? finalRef.clip.metadata.promo_finish : {}),
      ending_tail_frames: addedFrames,
      ending_tail_sec: tailSec,
    },
  };

  const updatedAudioClipIds: string[] = [];
  for (const track of timeline.tracks.audio) {
    if (track.track_id === "A2") {
      continue;
    }
    for (const clip of track.clips) {
      if (!isMatchingFinalSpeechAudioClip(clip, finalRef.clip, oldSrcOutUs, oldDurationFrames)) {
        continue;
      }
      clip.src_out_us = newSrcOutUs;
      clip.timeline_duration_frames = oldDurationFrames + addedFrames;
      clip.metadata = {
        ...clip.metadata,
        promo_finish: {
          ...(isRecord(clip.metadata?.promo_finish) ? clip.metadata.promo_finish : {}),
          ending_tail_frames: addedFrames,
          ending_tail_sec: tailSec,
        },
      };
      updatedAudioClipIds.push(clip.clip_id);
    }
  }

  return {
    extended: true,
    assetId: finalRef.clip.asset_id,
    clipId: finalRef.clip.clip_id,
    oldSrcOutUs,
    newSrcOutUs,
    addedFrames,
    updatedAudioClipIds,
  };
}

export function stripTimelineCaptions(timeline: TimelineIR): TimelineIR {
  const cloned = cloneTimeline(timeline);
  for (const track of cloned.tracks.video) {
    for (const clip of track.clips) {
      delete clip.captions;
    }
  }
  return cloned;
}

export function collectTimelineCaptions(timeline: TimelineIR): CaptionOverlay[] {
  return timeline.tracks.video
    .flatMap((track) => track.clips.flatMap((clip) => clip.captions ?? []))
    .sort((a, b) => a.in_frame - b.in_frame || a.out_frame - b.out_frame);
}

export function buildAssSubtitleFile(
  captions: CaptionOverlay[],
  fps: number,
  styleOptions: AssSubtitleStyleOptions = {},
): string {
  const style = {
    fontName: styleOptions.fontName ?? "Hiragino Sans",
    fontSize: styleOptions.fontSize ?? 66,
    bold: styleOptions.bold ?? true,
    outline: styleOptions.outline ?? 6,
    marginV: styleOptions.marginV ?? 72,
    primaryColor: styleOptions.primaryColor ?? "&H00FFFFFF",
    outlineColor: styleOptions.outlineColor ?? "&H00000000",
    playResX: styleOptions.playResX ?? 1920,
    playResY: styleOptions.playResY ?? 1080,
  };
  const bold = style.bold ? -1 : 0;
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${style.playResX}`,
    `PlayResY: ${style.playResY}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: TV.709",
    "",
    "[V4+ Styles]",
    "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    `Style: Default,${style.fontName},${style.fontSize},${style.primaryColor},&H000000FF,${style.outlineColor},&H64000000,${bold},0,0,0,100,100,0,0,1,${style.outline},0,2,90,90,${style.marginV},1`,
    "",
    "[Events]",
    "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
  ];
  const events = captions.map((caption) => {
    const start = formatAssTime(caption.in_frame / fps);
    const end = formatAssTime(caption.out_frame / fps);
    return `Dialogue: 0,${start},${end},Default,,0,0,0,,${escapeAssText(caption.text)}`;
  });
  return [...header, ...events, ""].join("\n");
}

export function buildPromoFinalizeFfmpegArgs(options: PromoFinalizeFfmpegArgsOptions): string[] {
  const fadeSec = Math.max(0, options.fadeSec ?? DEFAULT_ENDING_FADE_SEC);
  const fadeStart = Math.max(0, options.durationSec - fadeSec);
  const fontsDir = options.fontsDir ?? "/System/Library/Fonts";
  const subtitleFilter = `subtitles=filename='${escapeFfmpegFilterValue(options.assPath)}':fontsdir='${escapeFfmpegFilterValue(fontsDir)}'`;
  const videoFilters = [
    subtitleFilter,
    `fade=t=out:st=${formatFilterNumber(fadeStart)}:d=${formatFilterNumber(fadeSec)}`,
  ];
  const audioFilters = [`afade=t=out:st=${formatFilterNumber(fadeStart)}:d=${formatFilterNumber(fadeSec)}`];
  return [
    "-y",
    "-i",
    options.inputPath,
    "-filter_complex",
    `[0:v]${videoFilters.join(",")}[v];[0:a]${audioFilters.join(",")}[a]`,
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-c:v",
    options.videoCodec ?? "libx264",
    "-preset",
    "medium",
    "-crf",
    "18",
    "-c:a",
    options.audioCodec ?? "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    options.outputPath,
  ];
}

export async function finishPromoCut(options: PromoFinishOptions): Promise<PromoFinishResult> {
  const projectDir = path.resolve(options.projectDir);
  const timelinePath = path.resolve(options.timelinePath ?? path.join(projectDir, "05_timeline", "timeline.json"));
  const outputPath = path.resolve(options.outputPath ?? path.join(projectDir, "09_output", "promo-finished.mp4"));
  const workDir = path.resolve(options.workDir ?? path.join(projectDir, "09_output", "promo-finish"));
  const ffmpegBin = options.ffmpegBin ?? "ffmpeg";
  const ffprobeBin = options.ffprobeBin ?? "ffprobe";
  const subtitles = options.subtitles ?? true;
  const execFileImpl = options.execFileImpl ?? execFile;
  const assembleImpl = options.assembleTimelineToMp4Impl ?? assembleTimelineToMp4;

  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const timeline = cloneTimeline(readTimeline(timelinePath));
  const tailSummary = extendFinalClipTail(timeline, projectDir, {
    tailSec: options.endingTailSec ?? DEFAULT_ENDING_TAIL_SEC,
  });
  const captionSummary = subtitles
    ? attachTranscriptAlignedCaptions(timeline, projectDir, {
        maxChars: options.captionMaxChars ?? DEFAULT_CAPTION_MAX_CHARS,
        minCaptionFrames: options.captionMinFrames ?? DEFAULT_MIN_CAPTION_FRAMES,
      })
    : { captionCount: 0, transcriptAssets: 0, clipsWithCaptions: 0 };

  const fps = getTimelineFps(timeline);
  const adjustedTimelinePath = path.join(workDir, "timeline.adjusted.json");
  const renderTimelinePath = path.join(workDir, "timeline.render.json");
  const assPath = path.join(workDir, "subtitles.ass");
  const basePath = path.join(workDir, "base.mp4");

  writeJson(adjustedTimelinePath, timeline);
  if (subtitles) {
    fs.writeFileSync(assPath, buildAssSubtitleFile(collectTimelineCaptions(timeline), fps), "utf-8");
  } else {
    fs.writeFileSync(assPath, buildAssSubtitleFile([], fps), "utf-8");
  }
  writeJson(renderTimelinePath, stripTimelineCaptions(timeline));

  await assembleImpl({
    projectDir,
    timelinePath: renderTimelinePath,
    outputPath: basePath,
    ffmpegBin,
    execFileImpl,
  });

  const durationSec = await probeMediaDurationSec(basePath, ffprobeBin, execFileImpl);
  await runExecFile(execFileImpl, ffmpegBin, buildPromoFinalizeFfmpegArgs({
    inputPath: basePath,
    outputPath,
    assPath,
    durationSec,
    fadeSec: options.endingFadeSec ?? DEFAULT_ENDING_FADE_SEC,
    fontsDir: options.fontsDir,
  }));

  return {
    outputPath,
    basePath,
    assPath,
    adjustedTimelinePath,
    renderTimelinePath,
    captionSummary,
    tailSummary,
    durationSec,
  };
}

function buildCaptionsForClip(
  clip: ClipOutput,
  items: TranscriptItem[],
  fps: number,
  options: Required<CaptionGenerationOptions>,
): CaptionOverlay[] {
  const clipStartFrame = clip.timeline_in_frame;
  const clipEndFrame = clip.timeline_in_frame + clip.timeline_duration_frames;
  const captions: CaptionOverlay[] = [];
  for (const item of items) {
    if (!isValidTranscriptItem(item)) {
      continue;
    }
    const overlapStartUs = Math.max(item.start_us, clip.src_in_us);
    const overlapEndUs = Math.min(item.end_us, clip.src_out_us);
    if (overlapEndUs <= overlapStartUs) {
      continue;
    }
    const overlapDurationUs = overlapEndUs - overlapStartUs;
    const itemDurationUs = item.end_us - item.start_us;
    const overlapStartFrame = clampFrame(
      clip.timeline_in_frame + Math.round(((overlapStartUs - clip.src_in_us) / 1_000_000) * fps),
      clipStartFrame,
      clipEndFrame,
    );
    const overlapEndFrame = clampFrame(
      clip.timeline_in_frame + Math.round(((overlapEndUs - clip.src_in_us) / 1_000_000) * fps),
      clipStartFrame,
      clipEndFrame,
    );
    if (
      overlapEndFrame <= overlapStartFrame
      || overlapEndFrame - overlapStartFrame < options.minCaptionFrames
      || overlapDurationUs / itemDurationUs < options.minTranscriptOverlapRatio
    ) {
      continue;
    }
    const textChunks = fitChunksToFrames(
      splitCaptionText(item.text, options.maxChars),
      overlapEndFrame - overlapStartFrame,
      options.minCaptionFrames,
    );
    if (textChunks.length === 0) {
      continue;
    }
    captions.push(...spreadCaptionChunks(textChunks, overlapStartFrame, overlapEndFrame, options.style));
  }
  return normalizeCaptionOverlaps(captions, clipStartFrame, clipEndFrame, options.minCaptionFrames);
}

function normalizeCaptionOverlaps(
  captions: CaptionOverlay[],
  clipStartFrame: number,
  clipEndFrame: number,
  minCaptionFrames: number,
): CaptionOverlay[] {
  const normalized: CaptionOverlay[] = [];
  let cursor = clipStartFrame;
  for (const caption of captions.sort((a, b) => a.in_frame - b.in_frame || a.out_frame - b.out_frame)) {
    const inFrame = Math.max(cursor, clampFrame(caption.in_frame, clipStartFrame, clipEndFrame));
    const outFrame = clampFrame(caption.out_frame, clipStartFrame, clipEndFrame);
    if (outFrame - inFrame < minCaptionFrames) {
      continue;
    }
    normalized.push({
      ...caption,
      in_frame: inFrame,
      out_frame: outFrame,
    });
    cursor = outFrame;
  }
  return normalized;
}

function spreadCaptionChunks(
  chunks: string[],
  startFrame: number,
  endFrame: number,
  style: CaptionOverlay["style"],
): CaptionOverlay[] {
  const durationFrames = endFrame - startFrame;
  const weights = chunks.map((chunk) => Math.max(1, chunk.length));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let cursor = startFrame;
  let weightCursor = 0;
  return chunks.map((chunk, index) => {
    weightCursor += weights[index] ?? 1;
    const outFrame = index === chunks.length - 1
      ? endFrame
      : Math.max(cursor + 1, startFrame + Math.round((durationFrames * weightCursor) / totalWeight));
    const caption = {
      text: chunk,
      in_frame: cursor,
      out_frame: Math.min(outFrame, endFrame),
      style,
    };
    cursor = caption.out_frame;
    return caption;
  }).filter((caption) => caption.out_frame > caption.in_frame);
}

function fitChunksToFrames(chunks: string[], durationFrames: number, minCaptionFrames: number): string[] {
  const maxChunks = Math.max(1, Math.floor(durationFrames / Math.max(1, minCaptionFrames)));
  if (chunks.length <= maxChunks) {
    return chunks;
  }
  const result: string[] = [];
  for (let i = 0; i < maxChunks; i += 1) {
    const start = Math.floor((i * chunks.length) / maxChunks);
    const end = Math.floor(((i + 1) * chunks.length) / maxChunks);
    result.push(chunks.slice(start, Math.max(start + 1, end)).join(""));
  }
  return result;
}

function normalizeCaptionText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/[。．]+$/u, "")
    .trim();
}

function trimCaptionBoundary(text: string): string {
  return text.replace(/^[、。！？!?]+/u, "").replace(/[、。]+$/u, "").trim();
}

function chooseCaptionCut(text: string, maxChars: number): number {
  const minTailChars = 6;
  const upper = Math.min(text.length - minTailChars, maxChars + 6);
  const lower = Math.max(4, Math.floor(Math.min(maxChars, text.length) * 0.4));
  const target = Math.min(maxChars, text.length - minTailChars);
  const preferred = findPreferredCaptionBoundary(text, lower, upper, target);
  if (preferred !== undefined) {
    return preferred;
  }
  if (text.length <= maxChars + minTailChars) {
    return avoidBadCaptionBoundary(text, Math.ceil(text.length / 2));
  }
  return avoidBadCaptionBoundary(text, Math.min(maxChars, text.length - minTailChars));
}

function findPreferredCaptionBoundary(text: string, lower: number, upper: number, target: number): number | undefined {
  if (upper <= lower) {
    return undefined;
  }
  let best: { index: number; score: number } | undefined;
  for (let i = upper; i >= lower; i -= 1) {
    const score = scoreCaptionBreak(text, i, target);
    if (score === Number.NEGATIVE_INFINITY) {
      continue;
    }
    if (!best || score > best.score) {
      best = { index: i, score };
    }
  }
  if (!best || best.score < 20) {
    return undefined;
  }
  return best.index;
}

function scoreCaptionBreak(text: string, index: number, target: number): number {
  if (isForbiddenCaptionBreak(text, index)) {
    return Number.NEGATIVE_INFINITY;
  }

  const left = text.slice(0, index);
  const right = text.slice(index);
  let score = 100 - Math.abs(index - target) * 2.2;
  score -= Math.max(0, 7 - right.length) * 18;
  score -= Math.max(0, 8 - left.length) * 10;

  if (/[、。！？!? ]/u.test(text[index - 1] ?? "")) {
    score += 140;
  }

  for (const boundary of STRONG_CAPTION_BOUNDARIES) {
    if (left.endsWith(boundary)) {
      score += 90 + Math.min(20, boundary.length * 2);
    }
  }
  for (const boundary of MID_CAPTION_BOUNDARIES) {
    if (left.endsWith(boundary)) {
      score += 62 + Math.min(14, boundary.length * 2);
    }
  }
  if (/[はがをにもでと]/u.test(text[index - 1] ?? "") && !startsWithAny(right, DEPENDENT_CAPTION_PREFIXES)) {
    score += 22;
  }

  if (startsWithAny(right, DEPENDENT_CAPTION_PREFIXES) || startsWithAny(right, DISCOURAGED_CAPTION_PREFIXES)) {
    score -= 120;
  }
  if (endsWithAny(left, CONTINUING_CAPTION_SUFFIXES) && startsWithAny(right, CONTINUING_CAPTION_PREFIXES)) {
    score -= 120;
  }
  if (isLikelyJapaneseWordMiddle(text, index)) {
    score -= 55;
  }
  return score;
}

function avoidBadCaptionBoundary(text: string, cut: number): number {
  let adjusted = Math.min(Math.max(1, cut), text.length - 1);
  while (adjusted > 1 && /[ゃゅょぁぃぅぇぉっー、。！？!?」』）)]/u.test(text[adjusted] ?? "")) {
    adjusted -= 1;
  }
  return adjusted;
}

const STRONG_CAPTION_BOUNDARIES = [
  "なんですけど",
  "たんですけど",
  "なんですね",
  "と思います",
  "と思っています",
  "思っています",
  "感じました",
  "なりました",
  "できました",
  "しました",
  "いただきました",
  "持って",
  "ました",
  "ます",
  "です",
  "ですね",
  "けど",
  "なので",
  "ので",
  "から",
];

const MID_CAPTION_BOUNDARIES = [
  "みたいな",
  "という",
  "ことを",
  "ことが",
  "ものを",
  "ところを",
  "ために",
  "学んで",
  "考えて",
  "使って",
  "やって",
  "できるよ",
  "のを",
  "には",
  "では",
  "とは",
];

const DEPENDENT_CAPTION_PREFIXES = [
  "たん",
  "です",
  "ます",
  "けど",
  "けでは",
  "だけ",
  "ではなく",
  "ので",
  "から",
  "という",
  "っていう",
  "んじゃ",
  "んです",
  "ゃ",
  "ゅ",
  "ょ",
  "ぁ",
  "ぃ",
  "ぅ",
  "ぇ",
  "ぉ",
  "っ",
  "ー",
];

const DISCOURAGED_CAPTION_PREFIXES = [
  "思って",
  "思います",
  "思っています",
];

const CONTINUING_CAPTION_SUFFIXES = [
  "思って",
  "言って",
  "なって",
  "やって",
  "入って",
  "使って",
  "知って",
];

const CONTINUING_CAPTION_PREFIXES = [
  "た",
  "いる",
  "いく",
  "しま",
  "くる",
];

function isForbiddenCaptionBreak(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) {
    return true;
  }
  const prev = text[index - 1] ?? "";
  const next = text[index] ?? "";
  if (/[「『（([]/u.test(prev) || /[、。！？!?」』）)\]ゃゅょぁぃぅぇぉっー]/u.test(next)) {
    return true;
  }
  if (/[A-Za-z0-9]/.test(prev) && /[A-Za-z0-9]/.test(next)) {
    return true;
  }
  return false;
}

function isLikelyJapaneseWordMiddle(text: string, index: number): boolean {
  const prev = text[index - 1] ?? "";
  const next = text[index] ?? "";
  return /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(prev)
    && /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(next)
    && !/[はがをにもでと]/u.test(prev);
}

function mergeDependentCaptionChunks(chunks: string[], maxChars: number): string[] {
  const merged: string[] = [];
  const softMaxChars = maxChars + 8;
  for (const chunk of chunks) {
    const previous = merged[merged.length - 1];
    if (
      previous
      && shouldMergeWithPreviousCaptionChunk(previous, chunk)
      && previous.length + chunk.length <= softMaxChars
    ) {
      merged[merged.length - 1] = `${previous}${chunk}`;
      continue;
    }
    merged.push(chunk);
  }
  return merged;
}

function shouldMergeWithPreviousCaptionChunk(previous: string, chunk: string): boolean {
  return chunk.length <= 3
    || startsWithAny(chunk, DEPENDENT_CAPTION_PREFIXES)
    || (endsWithAny(previous, CONTINUING_CAPTION_SUFFIXES) && startsWithAny(chunk, CONTINUING_CAPTION_PREFIXES));
}

function startsWithAny(value: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => value.startsWith(prefix));
}

function endsWithAny(value: string, suffixes: readonly string[]): boolean {
  return suffixes.some((suffix) => value.endsWith(suffix));
}

function loadTranscriptsByAsset(projectDir: string): Map<string, TranscriptItem[]> {
  const transcriptDir = path.join(projectDir, "03_analysis", "transcripts");
  const transcripts = new Map<string, TranscriptItem[]>();
  if (!fs.existsSync(transcriptDir)) {
    return transcripts;
  }
  for (const entry of fs.readdirSync(transcriptDir)) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const fullPath = path.join(transcriptDir, entry);
    const parsed = JSON.parse(fs.readFileSync(fullPath, "utf-8")) as TranscriptJson;
    const assetId = parsed.asset_id ?? path.basename(entry, ".json").replace(/^TR_/, "");
    if (!assetId || !Array.isArray(parsed.items)) {
      continue;
    }
    transcripts.set(assetId, parsed.items.filter(isValidTranscriptItem).sort((a, b) => a.start_us - b.start_us));
  }
  return transcripts;
}

function loadAssetDurations(projectDir: string): Map<string, number> {
  const assetsPath = path.join(projectDir, "03_analysis", "assets.json");
  const durations = new Map<string, number>();
  if (!fs.existsSync(assetsPath)) {
    return durations;
  }
  const parsed = JSON.parse(fs.readFileSync(assetsPath, "utf-8")) as AssetsJson;
  for (const asset of parsed.assets ?? parsed.items ?? []) {
    if (asset.asset_id && typeof asset.duration_us === "number" && asset.duration_us > 0) {
      durations.set(asset.asset_id, asset.duration_us);
    }
  }
  return durations;
}

function findFinalVideoClip(timeline: TimelineIR): { track: TrackOutput; clip: ClipOutput } | null {
  let best: { track: TrackOutput; clip: ClipOutput; endFrame: number } | null = null;
  for (const track of timeline.tracks.video) {
    for (const clip of track.clips) {
      const endFrame = clip.timeline_in_frame + clip.timeline_duration_frames;
      if (!best || endFrame > best.endFrame) {
        best = { track, clip, endFrame };
      }
    }
  }
  return best ? { track: best.track, clip: best.clip } : null;
}

function isMatchingFinalSpeechAudioClip(
  audioClip: ClipOutput,
  finalVideoClip: ClipOutput,
  oldSrcOutUs: number,
  oldDurationFrames: number,
): boolean {
  if (audioClip.asset_id !== finalVideoClip.asset_id) {
    return false;
  }
  if (audioClip.src_in_us !== finalVideoClip.src_in_us || audioClip.src_out_us !== oldSrcOutUs) {
    return false;
  }
  if (audioClip.timeline_in_frame !== finalVideoClip.timeline_in_frame) {
    return false;
  }
  if (audioClip.timeline_duration_frames !== oldDurationFrames) {
    return false;
  }
  const mode = audioClip.audio_policy?.mode;
  return mode !== "bgm_only" && audioClip.role !== "bgm" && audioClip.role !== "music";
}

function resolveSpeechTailTargetUs(projectDir: string, clip: ClipOutput, tailUs: number): number | undefined {
  const items = loadTranscriptsByAsset(projectDir).get(clip.asset_id);
  if (!items || items.length === 0) {
    return undefined;
  }
  let lastSpeechEndUs = -1;
  for (const item of items) {
    if (!isValidTranscriptItem(item)) {
      continue;
    }
    if (item.end_us <= clip.src_in_us || item.start_us >= clip.src_out_us) {
      continue;
    }
    lastSpeechEndUs = Math.max(lastSpeechEndUs, item.end_us);
  }
  return lastSpeechEndUs > 0 ? lastSpeechEndUs + tailUs : undefined;
}

function isValidTranscriptItem(item: TranscriptItem): boolean {
  return (
    typeof item?.start_us === "number"
    && typeof item?.end_us === "number"
    && item.end_us > item.start_us
    && typeof item.text === "string"
    && item.text.trim().length > 0
  );
}

function clampFrame(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function formatAssTime(seconds: number): string {
  const normalized = Math.max(0, seconds);
  const totalCentiseconds = Math.round(normalized * 100);
  const centiseconds = totalCentiseconds % 100;
  const totalSeconds = Math.floor(totalCentiseconds / 100);
  const wholeSeconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}:${pad2(minutes)}:${pad2(wholeSeconds)}.${pad2(centiseconds)}`;
}

function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/{/g, "\\{")
    .replace(/}/g, "\\}")
    .replace(/\n/g, "\\N");
}

function escapeFfmpegFilterValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/:/g, "\\:");
}

function formatFilterNumber(value: number): string {
  return Number(value.toFixed(3)).toString();
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function probeMediaDurationSec(
  filePath: string,
  ffprobeBin: string,
  execFileImpl: ExecFileLike,
): Promise<number> {
  const result = execFileImpl === execFile
    ? await execFileAsync(ffprobeBin, [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=nokey=1:noprint_wrappers=1",
        filePath,
      ], { maxBuffer: 1024 * 1024 })
    : await runExecFile(execFileImpl, ffprobeBin, [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=nokey=1:noprint_wrappers=1",
        filePath,
      ]);
  const stdout = String(result.stdout);
  const parsed = Number(stdout.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Unable to probe media duration for ${filePath}`);
  }
  return parsed;
}

function runExecFile(
  execFileImpl: ExecFileLike,
  file: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFileImpl(file, args, { maxBuffer: 1024 * 1024 * 64 }, (error, stdout = "", stderr = "") => {
      if (error) {
        reject(error);
        return;
      }
      resolve({
        stdout: stdout.toString(),
        stderr: stderr.toString(),
      });
    });
  });
}

export function estimateTimelineDurationSec(timeline: TimelineIR): number {
  return getTimelineDurationFrames(timeline) / getTimelineFps(timeline);
}
