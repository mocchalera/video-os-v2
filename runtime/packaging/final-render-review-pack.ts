import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CaptionApproval } from "../caption/approval.js";
import { inspectCaptionFontContract } from "../caption/font-contract.js";
import { renderHyperFramesContentLayer } from "../content/hyperframes-renderer.js";
import { renderRemotionContentLayer } from "../render/remotion/render-remotion.js";
import { buildContentRenderPlan } from "../content/render-plan.js";
import { materializeFileSync } from "../filesystem/materialize-file.js";
import { computeSha256 } from "./manifest.js";
import {
  buildApprovedCaptionAssCues,
  prepareCaptionBurnAsset,
} from "../render/pipeline.js";
import { composeFinalVisuals } from "../render/final-visual-compositor.js";
import { INTERMEDIATE_X264, x264Args } from "../../editor/shared/encode-profiles.js";
import {
  frameRateValue,
  rationalFrameRate,
} from "../../editor/shared/rational-timebase.js";
import type { AssCaptionCue } from "../../editor/shared/caption-style-tokens.js";

export const FINAL_RENDER_REVIEW_PACK_VERSION = "final-render-review-pack/v1" as const;
export const FINAL_RENDER_REVIEW_RENDERER_CONTRACT_VERSION =
  "final-render-review-renderer/v2" as const;
export const FINAL_RENDER_REVIEW_PACK_RELATIVE_PATH =
  "06_review/final-render-review-pack/manifest.json";

interface TimelineClipLike {
  clip_id: string;
  timeline_in_frame: number;
  timeline_duration_frames: number;
  metadata?: Record<string, unknown>;
  content_element?: unknown;
  [key: string]: unknown;
}

interface TimelineTrackLike {
  track_id: string;
  kind: string;
  clips: TimelineClipLike[];
  [key: string]: unknown;
}

interface TimelineLike {
  project_id: string;
  sequence: {
    fps_num: number;
    fps_den: number;
    width: number;
    height: number;
    start_frame?: number;
    [key: string]: unknown;
  };
  tracks: {
    video?: TimelineTrackLike[];
    audio?: TimelineTrackLike[];
    overlay?: TimelineTrackLike[];
    caption?: TimelineTrackLike[];
    [key: string]: TimelineTrackLike[] | undefined;
  };
  markers?: unknown[];
  [key: string]: unknown;
}

export type FinalRenderReviewReason =
  | "intro"
  | "middle"
  | "ending"
  | "question"
  | "longest_caption"
  | "two_line_caption"
  | "section_title";

export interface FinalRenderReviewWindow {
  start_frame: number;
  duration_frames: number;
  reasons: FinalRenderReviewReason[];
  caption_ids: string[];
  overlay_ids: string[];
}

export interface FinalRenderReviewPackSample extends FinalRenderReviewWindow {
  sample_id: string;
  start_sec: number;
  duration_sec: number;
  reel_in_frame: number;
  reel_in_sec: number;
}

export interface FinalRenderReviewPackManifest {
  version: typeof FINAL_RENDER_REVIEW_PACK_VERSION;
  project_id: string;
  created_at: string;
  contract_key: string;
  inputs: {
    source_path: string;
    source_sha256: string;
    source_stream: {
      width: number;
      height: number;
      fps_num: number;
      fps_den: number;
      duration_sec: number;
      audio_present: true;
    };
    timeline_path: string;
    timeline_sha256: string;
    timeline_visual_projection_sha256: string;
    caption_approval_path: string;
    caption_approval_sha256: string;
  };
  renderer_contract: {
    version: typeof FINAL_RENDER_REVIEW_RENDERER_CONTRACT_VERSION;
    caption_ass_builder: "buildAssDocument";
    caption_video_profile: typeof INTERMEDIATE_X264;
    caption_style: string;
    caption_font_family: string;
    caption_font_sha256: string;
    content_renderer: "hyperframes";
    content_renderers: ["hyperframes", "remotion"];
    visual_compositor: "ffmpeg-single-pass";
  };
  sample_duration_sec: number;
  total_sample_duration_sec: number;
  review_reel: {
    path: string;
    sha256: string;
    duration_sec: number;
  };
  samples: FinalRenderReviewPackSample[];
}

export interface FinalRenderReviewPackResult {
  manifestPath: string;
  manifest: FinalRenderReviewPackManifest;
  reused: boolean;
}

export interface FinalRenderReviewPackPlan {
  project_id: string;
  sample_duration_sec: number;
  total_sample_duration_sec: number;
  window_count: number;
  windows: Array<FinalRenderReviewWindow & {
    start_sec: number;
    duration_sec: number;
  }>;
}

export interface FinalRenderReviewPackOptions {
  projectDir: string;
  sourcePath: string;
  outputDir?: string;
  sampleDurationSec?: number;
  createdAt?: string;
  execFileImpl?: typeof execFile;
  renderHyperFramesImpl?: typeof renderHyperFramesContentLayer;
  renderRemotionImpl?: typeof renderRemotionContentLayer;
  composeFinalVisualsImpl?: typeof composeFinalVisuals;
}

interface CandidateWindow {
  start_frame: number;
  end_frame: number;
  reason: FinalRenderReviewReason;
}

export function selectFinalRenderReviewWindows(input: {
  timeline: TimelineLike;
  captionApproval: CaptionApproval;
  sampleDurationSec?: number;
}): FinalRenderReviewWindow[] {
  const { timeline, captionApproval } = input;
  const fps = timeline.sequence.fps_num / timeline.sequence.fps_den;
  if (!Number.isFinite(fps) || fps <= 0) throw new Error("timeline frame rate is invalid");
  const sampleFrames = Math.max(1, Math.round((input.sampleDurationSec ?? 8) * fps));
  const durationFrames = timelineDurationFrames(timeline, captionApproval);
  const candidates: CandidateWindow[] = [];
  const addCentered = (frame: number, reason: FinalRenderReviewReason, leadFrames = Math.floor(sampleFrames / 3)): void => {
    const start = clamp(Math.round(frame) - leadFrames, 0, Math.max(0, durationFrames - sampleFrames));
    candidates.push({
      start_frame: start,
      end_frame: Math.min(durationFrames, start + sampleFrames),
      reason,
    });
  };

  addCentered(0, "intro", 0);
  addCentered(Math.floor(durationFrames / 2), "middle");
  addCentered(durationFrames, "ending", sampleFrames);

  const captions = captionApproval.speech_captions ?? [];
  if (captions.length > 0) {
    const questions = captions.filter((caption) => /[?？][」』）】]?$/u.test(caption.text.trim()));
    for (const caption of representativeItems(questions, 3)) {
      addCentered(caption.timeline_in_frame, "question");
    }
    const longest = [...captions].sort((left, right) =>
      visibleLength(right.text) - visibleLength(left.text)
      || left.timeline_in_frame - right.timeline_in_frame
    )[0];
    if (longest) addCentered(longest.timeline_in_frame, "longest_caption");
    const twoLine = captions.find((caption) => caption.text.includes("\n"));
    if (twoLine) addCentered(twoLine.timeline_in_frame, "two_line_caption");
  }

  for (const track of timeline.tracks.overlay ?? []) {
    for (const clip of track.clips ?? []) {
      if (contentTemplateRef(clip) === "vos:content.section-label/v1") {
        addCentered(clip.timeline_in_frame, "section_title", Math.round(fps * 0.5));
      }
    }
  }

  const merged = mergeCandidateWindows(candidates);
  return merged.map((window) => ({
    start_frame: window.start_frame,
    duration_frames: window.end_frame - window.start_frame,
    reasons: window.reasons,
    caption_ids: captions
      .filter((caption) => intervalsOverlap(
        window.start_frame,
        window.end_frame,
        caption.timeline_in_frame,
        caption.timeline_in_frame + caption.timeline_duration_frames,
      ))
      .map((caption) => caption.caption_id),
    overlay_ids: (timeline.tracks.overlay ?? [])
      .flatMap((track) => track.clips ?? [])
      .filter((clip) => intervalsOverlap(
        window.start_frame,
        window.end_frame,
        clip.timeline_in_frame,
        clip.timeline_in_frame + clip.timeline_duration_frames,
      ))
      .map((clip) => clip.clip_id),
  }));
}

export function planFinalRenderReviewPack(
  projectDir: string,
  sampleDurationSec = 8,
): FinalRenderReviewPackPlan {
  assertSampleDuration(sampleDurationSec);
  const absProject = path.resolve(projectDir);
  const timeline = JSON.parse(
    fs.readFileSync(path.join(absProject, "05_timeline", "timeline.json"), "utf8"),
  ) as TimelineLike;
  const captionApproval = JSON.parse(
    fs.readFileSync(path.join(absProject, "07_package", "caption_approval.json"), "utf8"),
  ) as CaptionApproval;
  const fps = timeline.sequence.fps_num / timeline.sequence.fps_den;
  const windows = selectFinalRenderReviewWindows({
    timeline,
    captionApproval,
    sampleDurationSec,
  }).map((window) => ({
    ...window,
    start_sec: roundMillis(window.start_frame / fps),
    duration_sec: roundMillis(window.duration_frames / fps),
  }));
  return {
    project_id: timeline.project_id,
    sample_duration_sec: sampleDurationSec,
    total_sample_duration_sec: roundMillis(
      windows.reduce((total, window) => total + window.duration_frames / fps, 0),
    ),
    window_count: windows.length,
    windows,
  };
}

export function buildReviewReelSourceArgs(input: {
  sourcePath: string;
  outputPath: string;
  fpsNum: number;
  fpsDen: number;
  windows: Array<{ startSec: number; durationSec: number }>;
}): string[] {
  if (input.windows.length === 0) throw new Error("review reel requires at least one window");
  const args = ["-v", "error", "-y"];
  for (const window of input.windows) {
    args.push(
      "-ss", window.startSec.toFixed(6),
      "-t", window.durationSec.toFixed(6),
      "-i", input.sourcePath,
    );
  }
  const parts = input.windows.flatMap((_window, index) => [
    `[${index}:v]setpts=PTS-STARTPTS[v${index}]`,
    `[${index}:a]asetpts=PTS-STARTPTS[a${index}]`,
  ]);
  const concatInputs = input.windows
    .map((_window, index) => `[v${index}][a${index}]`)
    .join("");
  parts.push(
    `${concatInputs}concat=n=${input.windows.length}:v=1:a=1[v][a]`,
  );
  args.push(
    "-filter_complex", parts.join(";"),
    "-map", "[v]",
    "-map", "[a]",
    ...x264Args(INTERMEDIATE_X264),
    "-c:a", "aac",
    "-b:a", "192k",
    "-r", `${input.fpsNum}/${input.fpsDen}`,
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    input.outputPath,
  );
  return args;
}

export async function buildFinalRenderReviewPack(
  options: FinalRenderReviewPackOptions,
): Promise<FinalRenderReviewPackResult> {
  const projectDir = path.resolve(options.projectDir);
  const sourcePath = path.resolve(options.sourcePath);
  const timelinePath = path.join(projectDir, "05_timeline", "timeline.json");
  const captionApprovalPath = path.join(projectDir, "07_package", "caption_approval.json");
  const outputDir = path.resolve(
    options.outputDir ?? path.join(projectDir, "06_review", "final-render-review-pack"),
  );
  assertProjectContained(projectDir, outputDir);
  for (const requiredPath of [sourcePath, timelinePath, captionApprovalPath]) {
    if (!fs.existsSync(requiredPath)) throw new Error(`review pack input is missing: ${requiredPath}`);
  }

  const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf8")) as TimelineLike;
  const captionApproval = JSON.parse(
    fs.readFileSync(captionApprovalPath, "utf8"),
  ) as CaptionApproval;
  if (captionApproval.approval?.status !== "approved") {
    throw new Error("caption approval must be approved before generating the final render review pack");
  }
  if (timeline.project_id !== captionApproval.project_id) {
    throw new Error("timeline and caption approval project_id do not match");
  }
  const execFileImpl = options.execFileImpl ?? execFile;
  const sourceStream = await inspectReviewSourceStream(sourcePath, execFileImpl);
  assertReviewSourceMatchesTimeline(
    sourceStream,
    timeline,
    timelineDurationFrames(timeline, captionApproval),
  );
  const styleClass = captionApproval.caption_policy.styling_class;
  const fontContract = inspectCaptionFontContract(styleClass);
  if (
    fontContract.status !== "ready"
    || fontContract.fallback_used
    || !fontContract.selected_asset
  ) {
    throw new Error(
      `caption font contract is blocked: ${fontContract.diagnostics.map((item) => item.message).join("; ")}`,
    );
  }

  const sampleDurationSec = options.sampleDurationSec ?? 8;
  assertSampleDuration(sampleDurationSec);
  const inputHashes = {
    source_path: sourcePath,
    source_sha256: computeSha256(sourcePath),
    source_stream: sourceStream,
    timeline_path: timelinePath,
    timeline_sha256: computeSha256(timelinePath),
    timeline_visual_projection_sha256: timelineVisualProjectionHash(timeline),
    caption_approval_path: captionApprovalPath,
    caption_approval_sha256: computeSha256(captionApprovalPath),
  };
  const contractKey = hashJson({
    version: FINAL_RENDER_REVIEW_PACK_VERSION,
    project_id: timeline.project_id,
    inputs: {
      source_path: inputHashes.source_path,
      source_sha256: inputHashes.source_sha256,
      source_stream: inputHashes.source_stream,
      timeline_visual_projection_sha256: inputHashes.timeline_visual_projection_sha256,
      caption_approval_path: inputHashes.caption_approval_path,
      caption_approval_sha256: inputHashes.caption_approval_sha256,
    },
    sample_duration_sec: sampleDurationSec,
    caption_style: styleClass,
    caption_font_sha256: fontContract.selected_asset.sha256,
    caption_video_profile: INTERMEDIATE_X264,
    renderer_contract_version: FINAL_RENDER_REVIEW_RENDERER_CONTRACT_VERSION,
    content_renderers: ["hyperframes", "remotion"],
  });
  const manifestPath = path.join(outputDir, "manifest.json");
  const cached = readCurrentManifest(manifestPath, contractKey, projectDir);
  if (cached) return { manifestPath, manifest: cached, reused: true };

  const windows = selectFinalRenderReviewWindows({
    timeline,
    captionApproval,
    sampleDurationSec,
  });
  if (windows.length === 0) throw new Error("review pack selection produced no samples");

  fs.mkdirSync(outputDir, { recursive: true });
  const workRoot = path.join(outputDir, "work");
  fs.rmSync(workRoot, { recursive: true, force: true });
  fs.mkdirSync(workRoot, { recursive: true });
  const frameRate = rationalFrameRate(
    timeline.sequence.fps_num,
    timeline.sequence.fps_den,
  );
  const fps = frameRateValue(frameRate);
  const allCues = buildApprovedCaptionAssCues(
    captionApproval.speech_captions,
    frameRate,
  );
  const renderHyperFramesImpl =
    options.renderHyperFramesImpl ?? renderHyperFramesContentLayer;
  const renderRemotionImpl =
    options.renderRemotionImpl ?? renderRemotionContentLayer;
  const composeFinalVisualsImpl =
    options.composeFinalVisualsImpl ?? composeFinalVisuals;
  const basePath = path.join(workRoot, "base-reel.mp4");
  const reelTimelinePath = path.join(workRoot, "timeline.reel.json");
  const srtPath = path.join(workRoot, "captions.srt");
  const outputPath = path.join(outputDir, "review-reel.mp4");
  await execFilePromise(
    "ffmpeg",
    buildReviewReelSourceArgs({
      sourcePath,
      outputPath: basePath,
      fpsNum: timeline.sequence.fps_num,
      fpsDen: timeline.sequence.fps_den,
      windows: windows.map((window) => ({
        startSec: window.start_frame / fps,
        durationSec: window.duration_frames / fps,
      })),
    }),
    execFileImpl,
  );

  const reelTimeline = buildReelTimeline(timeline, windows);
  fs.writeFileSync(reelTimelinePath, `${JSON.stringify(reelTimeline, null, 2)}\n`, "utf8");
  const contentPlan = buildContentRenderPlan(
    reelTimeline as unknown as Parameters<typeof buildContentRenderPlan>[0],
  );
  if (contentPlan.issues.length > 0) {
    throw new Error(
      `review reel content render plan is invalid: ${contentPlan.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  const visualLayers = [];
  const stages = [...new Set(contentPlan.hyperframes_elements.map((entry) =>
    entry.element.creative_recipe?.composite_stage ?? "under_caption"
  ))];
  for (const compositeStage of stages) {
    const contentResult = await renderHyperFramesImpl({
      timelinePath: reelTimelinePath,
      outputDir: path.join(workRoot, "content"),
      compositeStage,
    });
    if (!contentResult) continue;
    const stageElements = contentPlan.hyperframes_elements.filter((entry) =>
      (entry.element.creative_recipe?.composite_stage ?? "under_caption") === compositeStage
    );
    visualLayers.push({
      path: contentResult.overlayPath,
      renderer: "hyperframes" as const,
      compositeStage,
      zIndex: Math.min(...stageElements.map((entry) => entry.element.layout.z_index)),
      elementIds: stageElements.map((entry) => entry.element.element_id),
    });
  }
  const remotionStages = [...new Set((contentPlan.visual_elements ?? [])
    .filter((entry) => entry.renderer === "remotion" && !entry.requires_base_frame)
    .map((entry) => entry.composite_stage))];
  for (const compositeStage of remotionStages) {
    const stageElements = (contentPlan.visual_elements ?? []).filter((entry) =>
      entry.renderer === "remotion" &&
      !entry.requires_base_frame &&
      entry.composite_stage === compositeStage
    );
    const contentResult = await renderRemotionImpl({
      timelinePath: reelTimelinePath,
      outputDir: path.join(workRoot, "content"),
      compositeStage,
      elementIds: stageElements.map((entry) => entry.element_id),
    });
    if (!contentResult) continue;
    visualLayers.push({
      path: contentResult.overlayPath,
      renderer: "remotion" as const,
      compositeStage,
      zIndex: Math.min(...stageElements.map((entry) => entry.z_index)),
      elementIds: stageElements.map((entry) => entry.element_id),
    });
  }
  const reelCues = buildReelCues(allCues, windows, fps);
  fs.writeFileSync(srtPath, "", "utf8");
  const assPath = reelCues.length > 0
    ? prepareCaptionBurnAsset(
      srtPath,
      {
        width: timeline.sequence.width,
        height: timeline.sequence.height,
        fps,
      },
      styleClass,
      reelCues,
    )
    : undefined;
  if (visualLayers.length > 0 || assPath) {
    await composeFinalVisualsImpl({
      baseVideoPath: basePath,
      layers: visualLayers,
      assPath,
      fontsDir: assPath ? path.dirname(fontContract.selected_asset.path) : undefined,
      outputPath,
      width: timeline.sequence.width,
      height: timeline.sequence.height,
      fpsNum: timeline.sequence.fps_num,
      fpsDen: timeline.sequence.fps_den,
      durationFrames: windows.reduce((sum, window) => sum + window.duration_frames, 0),
    });
  } else {
    materializeFileSync(basePath, outputPath);
  }

  let reelFrame = 0;
  const samples: FinalRenderReviewPackSample[] = windows.map((window, index) => {
    const sample = {
      ...window,
      sample_id: `sample-${String(index + 1).padStart(2, "0")}`,
      start_sec: roundMillis(window.start_frame / fps),
      duration_sec: roundMillis(window.duration_frames / fps),
      reel_in_frame: reelFrame,
      reel_in_sec: roundMillis(reelFrame / fps),
    };
    reelFrame += window.duration_frames;
    return sample;
  });
  const totalSampleDurationSec = roundMillis(reelFrame / fps);

  const manifest: FinalRenderReviewPackManifest = {
    version: FINAL_RENDER_REVIEW_PACK_VERSION,
    project_id: timeline.project_id,
    created_at: options.createdAt ?? new Date().toISOString(),
    contract_key: contractKey,
    inputs: inputHashes,
    renderer_contract: {
      version: FINAL_RENDER_REVIEW_RENDERER_CONTRACT_VERSION,
      caption_ass_builder: "buildAssDocument",
      caption_video_profile: INTERMEDIATE_X264,
      caption_style: styleClass,
      caption_font_family: fontContract.selected_asset.family,
      caption_font_sha256: fontContract.selected_asset.sha256,
      content_renderer: "hyperframes",
      content_renderers: ["hyperframes", "remotion"],
      visual_compositor: "ffmpeg-single-pass",
    },
    sample_duration_sec: sampleDurationSec,
    total_sample_duration_sec: totalSampleDurationSec,
    review_reel: {
      path: projectRelative(projectDir, outputPath),
      sha256: computeSha256(outputPath),
      duration_sec: totalSampleDurationSec,
    },
    samples,
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { manifestPath, manifest, reused: false };
}

export function inspectFinalRenderReviewPack(
  projectDir: string,
  manifestRelativePath = FINAL_RENDER_REVIEW_PACK_RELATIVE_PATH,
): { ready: boolean; manifestPath: string; manifest?: FinalRenderReviewPackManifest; issues: string[] } {
  const absProject = path.resolve(projectDir);
  const manifestPath = path.resolve(absProject, manifestRelativePath);
  try {
    assertProjectContained(absProject, manifestPath);
  } catch (error) {
    return {
      ready: false,
      manifestPath,
      issues: [error instanceof Error ? error.message : String(error)],
    };
  }
  if (!fs.existsSync(manifestPath)) {
    return { ready: false, manifestPath, issues: ["final render review pack is missing"] };
  }
  let manifest: FinalRenderReviewPackManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as FinalRenderReviewPackManifest;
  } catch {
    return { ready: false, manifestPath, issues: ["final render review pack is malformed"] };
  }
  const issues: string[] = [];
  if (manifest.version !== FINAL_RENDER_REVIEW_PACK_VERSION) {
    issues.push("final render review pack version is invalid");
  }
  if (
    !manifest.inputs?.source_stream
    || manifest.inputs.source_stream.audio_present !== true
    || !Number.isInteger(manifest.inputs.source_stream.width)
    || !Number.isInteger(manifest.inputs.source_stream.height)
    || !Number.isInteger(manifest.inputs.source_stream.fps_num)
    || !Number.isInteger(manifest.inputs.source_stream.fps_den)
    || !Number.isFinite(manifest.inputs.source_stream.duration_sec)
  ) {
    issues.push("source stream contract is missing or invalid");
  }
  if (
    manifest.renderer_contract?.version
    !== FINAL_RENDER_REVIEW_RENDERER_CONTRACT_VERSION
  ) {
    issues.push("review renderer contract changed");
  }
  const timelinePath = path.join(absProject, "05_timeline", "timeline.json");
  const captionApprovalPath = path.join(absProject, "07_package", "caption_approval.json");
  for (const [label, filePath, expected] of [
    ["caption approval", captionApprovalPath, manifest.inputs?.caption_approval_sha256],
    ["source", manifest.inputs?.source_path, manifest.inputs?.source_sha256],
  ] as Array<[string, string | undefined, string | undefined]>) {
    if (!filePath || !fs.existsSync(filePath)) {
      issues.push(`${label} input is missing`);
    } else if (computeSha256(filePath) !== expected) {
      issues.push(`${label} input hash changed`);
    }
  }
  const captionApproval = fs.existsSync(captionApprovalPath)
    ? JSON.parse(fs.readFileSync(captionApprovalPath, "utf8")) as CaptionApproval
    : null;
  if (fs.existsSync(timelinePath)) {
    try {
      const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf8")) as TimelineLike;
      if (
        timelineVisualProjectionHash(timeline)
        !== manifest.inputs?.timeline_visual_projection_sha256
      ) {
        issues.push("timeline visual projection changed");
      }
    } catch {
      issues.push("timeline is malformed");
    }
  } else {
    issues.push("timeline input is missing");
  }
  if (captionApproval) {
    const font = inspectCaptionFontContract(captionApproval.caption_policy.styling_class);
    if (
      font.status !== "ready"
      || !font.selected_asset
      || font.selected_asset.sha256 !== manifest.renderer_contract?.caption_font_sha256
    ) {
      issues.push("caption font contract changed");
    }
  }
  if (!Array.isArray(manifest.samples) || manifest.samples.length === 0) {
    issues.push("final render review pack has no samples");
  }
  const reelPath = path.resolve(absProject, manifest.review_reel?.path ?? "");
  try {
    assertProjectContained(absProject, reelPath);
    if (!manifest.review_reel?.path || !fs.existsSync(reelPath)) {
      issues.push("final render review reel is missing");
    } else if (computeSha256(reelPath) !== manifest.review_reel.sha256) {
      issues.push("final render review reel hash changed");
    }
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }
  return { ready: issues.length === 0, manifestPath, manifest, issues };
}

function buildReelTimeline(
  timeline: TimelineLike,
  windows: FinalRenderReviewWindow[],
): TimelineLike {
  const reelOffsets: number[] = [];
  let reelFrame = 0;
  for (const window of windows) {
    reelOffsets.push(reelFrame);
    reelFrame += window.duration_frames;
  }
  const overlay = (timeline.tracks.overlay ?? []).map((track) => {
    const clips: TimelineClipLike[] = [];
    for (const [index, window] of windows.entries()) {
      const windowEnd = window.start_frame + window.duration_frames;
      for (const clip of track.clips ?? []) {
        if (!intervalsOverlap(
          window.start_frame,
          windowEnd,
          clip.timeline_in_frame,
          clip.timeline_in_frame + clip.timeline_duration_frames,
        )) continue;
        const clippedStart = Math.max(window.start_frame, clip.timeline_in_frame);
        const clippedEnd = Math.min(
          windowEnd,
          clip.timeline_in_frame + clip.timeline_duration_frames,
        );
        const cloned = structuredClone(clip);
        cloned.clip_id = `${clip.clip_id}__review_${index + 1}`;
        const directContent = asRecord(cloned.content_element);
        const metadata = asRecord(cloned.metadata);
        const nestedContent = asRecord(metadata?.content_element);
        const contentElement = directContent ?? nestedContent;
        if (contentElement && typeof contentElement.element_id === "string") {
          contentElement.element_id = `${contentElement.element_id}__review_${index + 1}`;
        }
        cloned.timeline_in_frame =
          reelOffsets[index] + clippedStart - window.start_frame;
        cloned.timeline_duration_frames = clippedEnd - clippedStart;
        clips.push(cloned);
      }
    }
    return { ...track, clips };
  });
  return {
    ...timeline,
    sequence: { ...timeline.sequence, start_frame: 0 },
    tracks: {
      video: [],
      audio: [],
      overlay,
      caption: [],
    },
    markers: [],
  };
}

function buildReelCues(
  cues: AssCaptionCue[],
  windows: FinalRenderReviewWindow[],
  fps: number,
): AssCaptionCue[] {
  const output: AssCaptionCue[] = [];
  let reelStartSec = 0;
  for (const window of windows) {
    const startSec = window.start_frame / fps;
    const durationSec = window.duration_frames / fps;
    output.push(...cues
      .filter((cue) => cue.endSec > startSec && cue.startSec < startSec + durationSec)
      .map((cue) => ({
        ...cue,
        startSec: reelStartSec + Math.max(0, cue.startSec - startSec),
        endSec: reelStartSec + Math.min(durationSec, cue.endSec - startSec),
      }))
      .filter((cue) => cue.endSec > cue.startSec));
    reelStartSec += durationSec;
  }
  return output;
}

function timelineDurationFrames(
  timeline: TimelineLike,
  captionApproval: CaptionApproval,
): number {
  let duration = 1;
  for (const tracks of Object.values(timeline.tracks)) {
    for (const track of tracks ?? []) {
      for (const clip of track.clips ?? []) {
        duration = Math.max(
          duration,
          clip.timeline_in_frame + clip.timeline_duration_frames,
        );
      }
    }
  }
  for (const caption of captionApproval.speech_captions ?? []) {
    duration = Math.max(
      duration,
      caption.timeline_in_frame + caption.timeline_duration_frames,
    );
  }
  return duration;
}

export function timelineVisualProjectionHash(timeline: TimelineLike): string {
  return hashJson({
    project_id: timeline.project_id,
    sequence: {
      fps_num: timeline.sequence.fps_num,
      fps_den: timeline.sequence.fps_den,
      width: timeline.sequence.width,
      height: timeline.sequence.height,
      start_frame: timeline.sequence.start_frame ?? 0,
    },
    video: timeline.tracks.video ?? [],
    overlay: timeline.tracks.overlay ?? [],
    transitions: timeline.transitions ?? [],
  });
}

function mergeCandidateWindows(candidates: CandidateWindow[]): Array<{
  start_frame: number;
  end_frame: number;
  reasons: FinalRenderReviewReason[];
}> {
  const sorted = [...candidates]
    .filter((candidate) => candidate.end_frame > candidate.start_frame)
    .sort((left, right) =>
      left.start_frame - right.start_frame
      || left.end_frame - right.end_frame
      || left.reason.localeCompare(right.reason, "en")
    );
  const merged: Array<{
    start_frame: number;
    end_frame: number;
    reasons: FinalRenderReviewReason[];
  }> = [];
  for (const candidate of sorted) {
    const last = merged.at(-1);
    if (last && candidate.start_frame <= last.end_frame) {
      last.end_frame = Math.max(last.end_frame, candidate.end_frame);
      if (!last.reasons.includes(candidate.reason)) last.reasons.push(candidate.reason);
    } else {
      merged.push({
        start_frame: candidate.start_frame,
        end_frame: candidate.end_frame,
        reasons: [candidate.reason],
      });
    }
  }
  return merged;
}

function representativeItems<T>(items: T[], limit: number): T[] {
  if (items.length <= limit) return items;
  const indices = new Set<number>();
  for (let index = 0; index < limit; index += 1) {
    indices.add(Math.round(index * (items.length - 1) / (limit - 1)));
  }
  return [...indices].map((index) => items[index]);
}

function contentTemplateRef(clip: TimelineClipLike): string | null {
  const direct = asRecord(clip.content_element);
  const metadata = asRecord(clip.metadata);
  const nested = asRecord(metadata?.content_element);
  const value = direct?.template_ref ?? nested?.template_ref;
  return typeof value === "string" ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function visibleLength(text: string): number {
  return [...text.replace(/\s/gu, "")].length;
}

function intervalsOverlap(
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
): boolean {
  return leftStart < rightEnd && rightStart < leftEnd;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function roundMillis(value: number): number {
  return Math.round(value * 1000) / 1000;
}

interface ReviewSourceStream {
  width: number;
  height: number;
  fps_num: number;
  fps_den: number;
  duration_sec: number;
  audio_present: true;
}

async function inspectReviewSourceStream(
  sourcePath: string,
  execFileImpl: typeof execFile,
): Promise<ReviewSourceStream> {
  const result = await execFilePromise("ffprobe", [
    "-v", "error",
    "-show_entries", "stream=codec_type,width,height,avg_frame_rate,r_frame_rate",
    "-show_entries", "format=duration",
    "-of", "json",
    sourcePath,
  ], execFileImpl);
  let probe: {
    streams?: Array<{
      codec_type?: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      r_frame_rate?: string;
    }>;
    format?: { duration?: string };
  };
  try {
    probe = JSON.parse(result.stdout);
  } catch {
    throw new Error("review source ffprobe output is malformed");
  }
  const video = probe.streams?.find((stream) => stream.codec_type === "video");
  const audioPresent = probe.streams?.some((stream) => stream.codec_type === "audio") ?? false;
  if (!video || !Number.isInteger(video.width) || !Number.isInteger(video.height)) {
    throw new Error("review source has no valid video stream");
  }
  if (!audioPresent) throw new Error("review source has no audio stream");
  const frameRate = parseFrameRate(video.avg_frame_rate ?? video.r_frame_rate ?? "");
  const durationSec = Number(probe.format?.duration);
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error("review source duration is invalid");
  }
  return {
    width: video.width!,
    height: video.height!,
    fps_num: frameRate.num,
    fps_den: frameRate.den,
    duration_sec: roundMillis(durationSec),
    audio_present: true,
  };
}

function assertReviewSourceMatchesTimeline(
  source: ReviewSourceStream,
  timeline: TimelineLike,
  durationFrames: number,
): void {
  if (
    source.width !== timeline.sequence.width
    || source.height !== timeline.sequence.height
  ) {
    throw new Error(
      `review source dimensions do not match timeline: source=${source.width}x${source.height} timeline=${timeline.sequence.width}x${timeline.sequence.height}`,
    );
  }
  if (
    BigInt(source.fps_num) * BigInt(timeline.sequence.fps_den)
    !== BigInt(timeline.sequence.fps_num) * BigInt(source.fps_den)
  ) {
    throw new Error(
      `review source FPS does not match timeline: source=${source.fps_num}/${source.fps_den} timeline=${timeline.sequence.fps_num}/${timeline.sequence.fps_den}`,
    );
  }
  const fps = timeline.sequence.fps_num / timeline.sequence.fps_den;
  const expectedDurationSec = durationFrames / fps;
  const toleranceSec = Math.max(2 / fps, 0.05);
  if (Math.abs(source.duration_sec - expectedDurationSec) > toleranceSec) {
    throw new Error(
      `review source duration does not match timeline: source=${source.duration_sec.toFixed(3)}s timeline=${expectedDurationSec.toFixed(3)}s tolerance=${toleranceSec.toFixed(3)}s`,
    );
  }
}

function parseFrameRate(value: string): { num: number; den: number } {
  const match = /^(\d+)\/(\d+)$/.exec(value);
  if (!match) throw new Error(`review source frame rate is invalid: ${value}`);
  const num = Number(match[1]);
  const den = Number(match[2]);
  if (!Number.isInteger(num) || !Number.isInteger(den) || num <= 0 || den <= 0) {
    throw new Error(`review source frame rate is invalid: ${value}`);
  }
  return { num, den };
}

function assertSampleDuration(value: number): void {
  if (!Number.isFinite(value) || value < 2 || value > 30) {
    throw new Error("sampleDurationSec must be between 2 and 30 seconds");
  }
}

function hashJson(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function readCurrentManifest(
  manifestPath: string,
  contractKey: string,
  projectDir: string,
): FinalRenderReviewPackManifest | null {
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(
      fs.readFileSync(manifestPath, "utf8"),
    ) as FinalRenderReviewPackManifest;
    if (manifest.contract_key !== contractKey) return null;
    const reelPath = path.resolve(projectDir, manifest.review_reel.path);
    assertProjectContained(projectDir, reelPath);
    if (!fs.existsSync(reelPath) || computeSha256(reelPath) !== manifest.review_reel.sha256) return null;
    return manifest;
  } catch {
    return null;
  }
}

function execFilePromise(
  command: string,
  args: string[],
  execFileImpl: typeof execFile,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFileImpl(command, args, { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${command} failed: ${stderr || error.message}`));
        return;
      }
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

function assertProjectContained(projectDir: string, candidate: string): void {
  const relative = path.relative(path.resolve(projectDir), path.resolve(candidate));
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new Error(`final render review pack path escapes project root: ${candidate}`);
}

function projectRelative(projectDir: string, filePath: string): string {
  return path.relative(projectDir, filePath).split(path.sep).join("/");
}
