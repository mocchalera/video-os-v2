/**
 * Preview Segment Renderer (M4-1)
 *
 * Renders a low-res (720p) preview of specific beats or the first N seconds
 * from a compiled timeline. Uses ffmpeg to extract and concatenate clips
 * from source media files.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { LoadedSourceMap } from "../media/source-map.js";
import { assertTimelineRenderSupported } from "../render/media-kind-guard.js";
import {
  materializeVerifiedStillSnapshots,
  resolveCanonicalRenderInputs,
  type CanonicalRenderInputSet,
} from "../render/canonical-render-input.js";
import { assertSourceInputsUnchanged, createSourceInputAttestation } from "../render/source-input-attestation.js";
import {
  assembleTimelineToMp4,
  buildStillVideoArgs,
  resolveStillRenderMotion,
  type ExecFileLike as AssemblerExecFileLike,
} from "../render/assembler.js";
import {
  renderStillMotionSegment,
  buildStillVerticalStaticArgs,
  type ExecFileLike,
} from "../render/still-motion-render.js";
import { computeSha256 } from "../packaging/manifest.js";
import { assertMediaWriteReady } from "../system/media-write-doctor.js";
import type { CaptionVisualTreatmentInput } from "../caption/visual-treatment.js";
import type { StillImageTimelineMetadata } from "../compiler/types.js";

// ── Types ──────────────────────────────────────────────────────────

export interface PreviewClip {
  clip_id: string;
  asset_id: string;
  src_in_us: number;
  src_out_us: number;
  timeline_in_frame: number;
  timeline_duration_frames: number;
  beat_id: string;
  media_kind?: string;
  still_image?: Partial<StillImageTimelineMetadata>;
  /** Original plan duration kept when firstNSec trims this clip's output. */
  motion_frame_count?: number;
}

export interface PreviewSegmentOptions {
  projectDir: string;
  timelinePath: string;
  sourceMap: LoadedSourceMap;
  /** Render only clips belonging to this beat */
  beatId?: string;
  /** Render only the first N seconds of the timeline */
  firstNSec?: number;
  /** Output file path override */
  outputPath?: string;
  execFileImpl?: typeof execFile;
  /** Test/host seam for the fail-closed toolchain and capacity gate. */
  assertMediaWriteReadyImpl?: typeof assertMediaWriteReady;
  /** Optional output geometry for the canonical baseline path. */
  outputGeometry?: { width: number; height: number };
  /** Pre-resolved RFA-020 input shared with final/package rendering. */
  captionVisualTreatmentInput?: CaptionVisualTreatmentInput;
  /** Narrow review-only seam for a hash-bound input before production visual approval. */
  captionVisualTreatmentReviewOnlyPreapproval?: boolean;
}

export interface PreviewSegmentResult {
  outputPath: string;
  clipCount: number;
  durationSec: number;
  receiptPath: string;
}

interface TimelineData {
  sequence: {
    fps_num: number;
    fps_den: number;
    width: number;
    height: number;
  };
  tracks: {
    video: Array<{
      clips: Array<{
        clip_id: string;
        segment_id: string;
        asset_id: string;
        src_in_us: number;
        src_out_us: number;
        timeline_in_frame: number;
        timeline_duration_frames: number;
        beat_id: string;
        media_kind?: string;
        still_image?: Partial<StillImageTimelineMetadata>;
      }>;
    }>;
  };
  markers: Array<{ frame: number; kind: string; label: string }>;
  transitions?: Array<{
    transition_id: string;
    from_clip_id: string;
    to_clip_id: string;
    transition_type: string;
    transition_frames?: number;
  }>;
}

// ── Helpers ────────────────────────────────────────────────────────

function execFilePromise(
  cmd: string,
  args: string[],
  execFileImpl: typeof execFile = execFile,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFileImpl(cmd, args, { maxBuffer: 100 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

/**
 * Extract V1 (hero track) clips from timeline, sorted by timeline position.
 */
export function extractVideoClips(timeline: TimelineData): PreviewClip[] {
  const allClips: PreviewClip[] = [];

  // Use only the first video track (V1 = hero) for preview
  const v1 = timeline.tracks.video[0];
  if (!v1) return allClips;

  for (const clip of v1.clips) {
    allClips.push({
      clip_id: clip.clip_id,
      asset_id: clip.asset_id,
      src_in_us: clip.src_in_us,
      src_out_us: clip.src_out_us,
      timeline_in_frame: clip.timeline_in_frame,
      timeline_duration_frames: clip.timeline_duration_frames,
      beat_id: clip.beat_id,
      ...(clip.media_kind ? { media_kind: clip.media_kind } : {}),
      ...(clip.still_image ? { still_image: clip.still_image } : {}),
    });
  }

  return allClips.sort((a, b) => a.timeline_in_frame - b.timeline_in_frame);
}

/**
 * Filter clips by beat ID.
 */
export function filterByBeat(clips: PreviewClip[], beatId: string): PreviewClip[] {
  return clips.filter((c) => c.beat_id === beatId);
}

/**
 * Filter clips to include only those within the first N seconds.
 */
export function filterByDuration(
  clips: PreviewClip[],
  maxSec: number,
  fpsNum: number,
  fpsDen: number,
  imageAssetIds: ReadonlySet<string> = new Set(),
): PreviewClip[] {
  const fps = fpsNum / fpsDen;
  const maxFrame = Math.ceil(maxSec * fps);

  return clips.filter((c) => c.timeline_in_frame < maxFrame).map((c) => {
    const clipEndFrame = c.timeline_in_frame + c.timeline_duration_frames;
    if (clipEndFrame <= maxFrame) return c;
    // Truncate the clip to fit within maxFrame
    const trimmedDuration = maxFrame - c.timeline_in_frame;
    const srcDurationUs = c.src_out_us - c.src_in_us;
    const ratio = trimmedDuration / c.timeline_duration_frames;
    return {
      ...c,
      timeline_duration_frames: trimmedDuration,
      src_out_us: imageAssetIds.has(c.asset_id) || c.media_kind === "image" || c.still_image
        ? c.src_out_us
        : c.src_in_us + Math.round(srcDurationUs * ratio),
      ...(imageAssetIds.has(c.asset_id) || c.media_kind === "image" || c.still_image
        ? { motion_frame_count: c.timeline_duration_frames }
        : {}),
    };
  });
}

/**
 * Resolve the source file path for an asset ID using the source map.
 */
export function resolveSourcePath(
  sourceMap: LoadedSourceMap,
  assetId: string,
  canonicalInputs?: CanonicalRenderInputSet,
): string | undefined {
  const canonical = canonicalInputs?.byAssetId.get(assetId);
  if (canonical) return canonical.renderInputPath;
  const entry = sourceMap.entryMap.get(assetId);
  if (!entry) return undefined;

  // Try local_source_path first, then source_locator
  if (entry.local_source_path && fs.existsSync(entry.local_source_path)) {
    return entry.local_source_path;
  }
  if (entry.source_locator && fs.existsSync(entry.source_locator)) {
    return entry.source_locator;
  }
  return undefined;
}

/**
 * Build ffmpeg arguments for a single clip extraction at 720p.
 */
export function buildClipExtractArgs(
  sourcePath: string,
  srcInUs: number,
  srcOutUs: number,
  outputPath: string,
  targetDurationSec?: number,
  outputGeometry?: { width: number; height: number },
): string[] {
  const startSec = srcInUs / 1_000_000;
  const sourceDurationSec = Math.max(0, (srcOutUs - srcInUs) / 1_000_000);
  const durationSec = Number.isFinite(targetDurationSec) && targetDurationSec !== undefined
    ? Math.min(sourceDurationSec, Math.max(0, targetDurationSec))
    : sourceDurationSec;

  return [
    "-y",
    "-ss", startSec.toFixed(6),
    "-i", sourcePath,
    "-t", durationSec.toFixed(6),
    "-vf", outputGeometry
      ? `scale=${outputGeometry.width}:${outputGeometry.height}:force_original_aspect_ratio=decrease,pad=${outputGeometry.width}:${outputGeometry.height}:(ow-iw)/2:(oh-ih)/2`
      : "scale=-2:720",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-crf", "28",
    "-an",
    "-pix_fmt", "yuv420p",
    outputPath,
  ];
}

/**
 * Build ffmpeg concat demuxer file content from a list of clip file paths.
 */
export function buildConcatFileContent(clipPaths: string[]): string {
  return clipPaths
    .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
    .join("\n");
}

export function clipTimelineDurationSec(
  clip: PreviewClip,
  fpsNum: number,
  fpsDen: number,
): number {
  const fps = fpsNum / fpsDen;
  if (!Number.isFinite(fps) || fps <= 0) return 0;
  return clip.timeline_duration_frames / fps;
}

/**
 * Compute the default output path for a preview.
 */
export function defaultOutputPath(
  projectDir: string,
  beatId?: string,
  firstNSec?: number,
): string {
  const dir = path.join(projectDir, "05_timeline");
  if (beatId) {
    return path.join(dir, `preview-${beatId}.mp4`);
  }
  if (firstNSec) {
    return path.join(dir, `preview-first${firstNSec}s.mp4`);
  }
  return path.join(dir, "preview-full.mp4");
}

function hasRenderableTransitions(
  timeline: TimelineData,
  clips: PreviewClip[],
): boolean {
  const clipIds = new Set(clips.map((clip) => clip.clip_id));
  return (timeline.transitions ?? []).some((transition) =>
    clipIds.has(transition.from_clip_id)
    && clipIds.has(transition.to_clip_id)
    && transition.transition_type !== "cut",
  );
}

function buildPreviewSourceOverrides(
  clips: PreviewClip[],
  sourceMap: LoadedSourceMap,
  canonicalInputs: CanonicalRenderInputSet,
): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const clip of clips) {
    const sourcePath = resolveSourcePath(sourceMap, clip.asset_id, canonicalInputs);
    if (!sourcePath) {
      throw new Error(
        `Source file not found for asset ${clip.asset_id}. `
        + "Ensure source_map.json exists in 02_media/ with valid paths.",
      );
    }
    overrides[clip.asset_id] = sourcePath;
  }
  return overrides;
}

/**
 * Render a transitioned preview through the exact final assembler chain, then
 * take a prefix by frame copy when firstNSec is requested. Rendering the full
 * canonical chain first keeps overlap/xfade timing intact at the preview
 * boundary and makes preview/final frame hashes comparable.
 */
async function renderCanonicalTransitionPreview(
  opts: PreviewSegmentOptions,
  timelinePath: string,
  timeline: TimelineData,
  outputPath: string,
  tmpDir: string,
  canonicalInputs: CanonicalRenderInputSet,
): Promise<number> {
  const allClips = extractVideoClips(timeline);
  const fullPath = path.join(tmpDir, "canonical-transition-full.mp4");
  const sourceOverrides = buildPreviewSourceOverrides(allClips, opts.sourceMap, canonicalInputs);
  const assembly = await assembleTimelineToMp4({
    projectDir: opts.projectDir,
    timelinePath,
    outputPath: fullPath,
    includeAudio: false,
    sourceOverrides,
    ...(opts.execFileImpl
      ? { execFileImpl: opts.execFileImpl as unknown as AssemblerExecFileLike }
      : {}),
  });
  const fps = timeline.sequence.fps_num / timeline.sequence.fps_den;
  const requestedFrames = opts.firstNSec === undefined
    ? assembly.timelineDurationFrames
    : Math.min(assembly.timelineDurationFrames, Math.max(1, Math.ceil(opts.firstNSec * fps)));

  if (requestedFrames === assembly.timelineDurationFrames) {
    fs.copyFileSync(fullPath, outputPath);
  } else {
    await execFilePromise("ffmpeg", [
      "-y", "-i", fullPath,
      "-map", "0:v:0", "-frames:v", String(requestedFrames),
      "-c:v", "copy", "-an", outputPath,
    ], opts.execFileImpl);
  }
  return requestedFrames;
}

// ── Main Render Function ───────────────────────────────────────────

/**
 * Render a preview segment from the timeline.
 *
 * 1. Load timeline and extract V1 clips
 * 2. Filter by beat or duration
 * 3. For each clip, extract from source at 720p via ffmpeg
 * 4. Concatenate all extracted clips into a single preview MP4
 */
export async function renderPreviewSegment(
  opts: PreviewSegmentOptions,
): Promise<PreviewSegmentResult> {
  const timeline: TimelineData = JSON.parse(
    fs.readFileSync(opts.timelinePath, "utf-8"),
  );
  assertTimelineRenderSupported(timeline, {
    projectDir: opts.projectDir,
    timelinePath: opts.timelinePath,
    sourceLocators: opts.sourceMap,
  });
  const outputPath = opts.outputPath ??
    defaultOutputPath(opts.projectDir, opts.beatId, opts.firstNSec);
  (opts.assertMediaWriteReadyImpl ?? assertMediaWriteReady)({
    reservations: [{
      label: "preview output and scratch",
      path: path.dirname(outputPath),
      requiredBytes: 512 * 1024 * 1024,
    }],
    requireFfmpeg: opts.execFileImpl === undefined,
    requireFfprobe: false,
    requireCaptionFilters: false,
  });
  const canonicalInputs = materializeVerifiedStillSnapshots(
    resolveCanonicalRenderInputs(timeline as never, {
      projectDir: opts.projectDir,
      timelinePath: opts.timelinePath,
    }),
  );
  try {
  const sourceInputsBefore = canonicalInputs.imageAssetIds.size > 0 || canonicalInputs.sequenceAssetIds.size > 0
    ? createSourceInputAttestation(opts.projectDir, {
        timelinePath: opts.timelinePath,
        includeAudio: false,
      })
    : undefined;

  const fps = timeline.sequence.fps_num / timeline.sequence.fps_den;
  let clips = extractVideoClips(timeline);

  // Apply filters
  if (opts.beatId) {
    clips = filterByBeat(clips, opts.beatId);
    if (clips.length === 0) {
      throw new Error(`No clips found for beat: ${opts.beatId}`);
    }
  }
  if (opts.firstNSec) {
    clips = filterByDuration(
      clips,
      opts.firstNSec,
      timeline.sequence.fps_num,
      timeline.sequence.fps_den,
      canonicalInputs.imageAssetIds,
    );
    if (clips.length === 0) {
      throw new Error(`No clips within the first ${opts.firstNSec} seconds`);
    }
  }

  // Prepare output directory
  const outputDir = path.dirname(outputPath);
  fs.mkdirSync(outputDir, { recursive: true });

  // Create a temp directory for intermediate clip files
  const tmpDir = path.join(outputDir, `.preview-tmp-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const clipPaths: string[] = [];

    let durationSec: number;
    if (!opts.beatId && hasRenderableTransitions(timeline, extractVideoClips(timeline))) {
      const renderedFrames = await renderCanonicalTransitionPreview(
        opts,
        opts.timelinePath,
        timeline,
        outputPath,
        tmpDir,
        canonicalInputs,
      );
      durationSec = renderedFrames / fps;
    } else {
      // Extract each clip
      for (let i = 0; i < clips.length; i++) {
        const clip = clips[i];
        const sourcePath = resolveSourcePath(opts.sourceMap, clip.asset_id, canonicalInputs);
        if (!sourcePath) {
          throw new Error(
            `Source file not found for asset ${clip.asset_id}. `
            + "Ensure source_map.json exists in 02_media/ with valid paths.",
          );
        }

        const clipOutPath = path.join(tmpDir, `clip_${String(i).padStart(4, "0")}.mp4`);
        const targetDurationSec = clipTimelineDurationSec(
          clip,
          timeline.sequence.fps_num,
          timeline.sequence.fps_den,
        );
        const isStill = canonicalInputs.imageAssetIds.has(clip.asset_id);
        const fpsRational = `${timeline.sequence.fps_num}/${timeline.sequence.fps_den}`;
        if (isStill) {
          // Canonical preview uses the exact same still-render lane as final
          // assembly: the NumPy Float64 Lanczos worker for camera motion
          // (fail-closed on missing capability), the static composite for the
          // vertical blur-backdrop, and the plain filter otherwise.
          const render = resolveStillRenderMotion(clip.still_image, {
            width: timeline.sequence.width,
            height: timeline.sequence.height,
            frameCount: clip.motion_frame_count ?? clip.timeline_duration_frames,
          });
          if (render.motion) {
            await renderStillMotionSegment({
              execFileImpl: opts.execFileImpl as unknown as ExecFileLike,
              inputPath: sourcePath, outputPath: clipOutPath,
              frameCount: clip.timeline_duration_frames,
              width: timeline.sequence.width,
              height: timeline.sequence.height,
              fpsRational,
              motion: render.motion,
              composition: render.composition,
              fitMode: render.fitMode,
              background: render.background,
              clipId: clip.clip_id,
              sourceStillId: clip.still_image?.source_still_id,
              stillInstanceId: clip.still_image?.still_instance_id,
              hold: clip.still_image?.hold_resolution
                ? {
                    unit: clip.still_image.hold_resolution.unit,
                    resolved_frames: clip.still_image.hold_resolution.resolved_frames,
                    ...(clip.still_image.hold_resolution.section_id
                      ? { section_id: clip.still_image.hold_resolution.section_id }
                      : {}),
                    ...(clip.still_image.hold_resolution.boundary
                      ? { boundary: clip.still_image.hold_resolution.boundary }
                      : {}),
                    ...(clip.still_image.hold_resolution.boundary_frame !== undefined
                      ? { boundary_frame: clip.still_image.hold_resolution.boundary_frame }
                      : {}),
                  }
                : undefined,
            });
          } else if (render.composition) {
            await execFilePromise("ffmpeg", buildStillVerticalStaticArgs(
              sourcePath, clipOutPath, clip.timeline_duration_frames,
              render.composition, fpsRational,
            ), opts.execFileImpl);
          } else {
            await execFilePromise("ffmpeg", buildStillVideoArgs(
              sourcePath, clipOutPath, clip.timeline_duration_frames,
              timeline.sequence.width, timeline.sequence.height,
              fpsRational,
              clip.still_image?.fit_mode ?? "contain", clip.still_image?.background ?? "black",
              clip.still_image?.transform,
            ), opts.execFileImpl);
          }
        } else {
          await execFilePromise("ffmpeg", buildClipExtractArgs(
            sourcePath,
            clip.src_in_us,
            clip.src_out_us,
            clipOutPath,
            targetDurationSec,
            opts.outputGeometry,
          ), opts.execFileImpl);
        }
        clipPaths.push(clipOutPath);
      }

      // Concatenate clips
      if (clipPaths.length === 1) {
        // Single clip — just move it
        fs.renameSync(clipPaths[0], outputPath);
      } else {
        // Multiple clips — use concat demuxer
        const concatFilePath = path.join(tmpDir, "concat.txt");
        fs.writeFileSync(concatFilePath, buildConcatFileContent(clipPaths), "utf-8");

        await execFilePromise("ffmpeg", [
          "-y",
          "-f", "concat",
          "-safe", "0",
          "-i", concatFilePath,
          "-c", "copy",
          outputPath,
        ], opts.execFileImpl);
      }

      const totalFrames = clips.reduce((sum, c) => sum + c.timeline_duration_frames, 0);
      durationSec = totalFrames / fps;
    }

    if (sourceInputsBefore) try {
      const sourceInputsAfter = createSourceInputAttestation(opts.projectDir, {
        timelinePath: opts.timelinePath,
        includeAudio: false,
      });
      assertSourceInputsUnchanged(sourceInputsBefore, sourceInputsAfter);
    } catch (error) {
      fs.rmSync(outputPath, { force: true });
      throw error;
    }
    const receiptPath = `${outputPath}.receipt.json`;
    const previewStat = fs.statSync(outputPath);
    const approvalPath = path.join(opts.projectDir, "07_package/caption_approval.json");
    const draftPath = path.join(opts.projectDir, "07_package/caption_draft.json");
    const captionInputPath = fs.existsSync(approvalPath)
      ? approvalPath
      : fs.existsSync(draftPath) ? draftPath : undefined;
    const receipt = {
      version: "timeline-preview-receipt/v1",
      preview_path: path.relative(opts.projectDir, outputPath),
      preview_sha256: computeSha256(outputPath),
      preview_size_bytes: previewStat.size,
      preview_mtime_ms: Math.round(previewStat.mtimeMs),
      timeline_path: path.relative(opts.projectDir, opts.timelinePath),
      timeline_sha256: computeSha256(opts.timelinePath),
      caption_input: captionInputPath ? {
        path: path.relative(opts.projectDir, captionInputPath),
        sha256: computeSha256(captionInputPath),
      } : null,
      created_at: new Date().toISOString(),
    };
    const temporaryReceiptPath = `${receiptPath}.tmp-${process.pid}`;
    fs.writeFileSync(temporaryReceiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    fs.renameSync(temporaryReceiptPath, receiptPath);
    return {
      outputPath,
      clipCount: clips.length,
      durationSec,
      receiptPath,
    };
  } finally {
    // Clean up temp directory
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  } finally {
    canonicalInputs.dispose();
  }
}
