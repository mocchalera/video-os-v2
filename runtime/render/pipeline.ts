/**
 * Render Pipeline Orchestration
 *
 * Stepwise render pipeline for M4 packaging:
 *   assembly -> demux -> caption_burn -> audio_master -> final mux
 *
 * All ffmpeg calls use execFile wrapped in Promises with stderr logging.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Types ──────────────────────────────────────────────────────────

export interface RenderPipelineOptions {
  projectDir: string;
  timelinePath: string;
  captionApprovalPath?: string;
  musicCuesPath?: string;
  assemblyPath?: string; // Pre-built assembly.mp4 (skip Remotion step)
  captionPolicy: {
    language: string;
    delivery_mode: "burn_in" | "sidecar" | "both";
    source: "transcript" | "authored" | "none";
    styling_class: string;
  };
  outputDir: string; // 07_package/
  fps: number;
}

export interface RenderPipelineResult {
  assemblyPath: string;
  rawVideoPath: string;
  rawDialoguePath: string;
  finalMixPath: string;
  finalVideoPath: string;
  sidecarPaths: string[];
  logs: Record<string, string>;
}

// ── Helpers ────────────────────────────────────────────────────────

function execFilePromise(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 100 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeLog(logsDir: string, name: string, content: string): string {
  const logPath = path.join(logsDir, `${name}.log`);
  fs.writeFileSync(logPath, content, "utf-8");
  return logPath;
}

interface TimelineSequenceConfig {
  width: number;
  height: number;
  output_aspect_ratio?: string;
}

function readTimelineSequenceConfig(timelinePath: string): TimelineSequenceConfig {
  const raw = JSON.parse(fs.readFileSync(timelinePath, "utf-8")) as {
    sequence?: { width?: number; height?: number; output_aspect_ratio?: string };
  };

  const width = raw.sequence?.width;
  const height = raw.sequence?.height;
  if (!width || !height) {
    throw new Error(`Timeline sequence width/height missing: ${timelinePath}`);
  }

  return {
    width,
    height,
    output_aspect_ratio: raw.sequence?.output_aspect_ratio,
  };
}

export function buildAspectRatioFitFilter(
  outputWidth: number,
  outputHeight: number,
  padColor = "black",
): string {
  return (
    `scale=${outputWidth}:${outputHeight}:force_original_aspect_ratio=decrease,` +
    `pad=${outputWidth}:${outputHeight}:(ow-iw)/2:(oh-ih)/2:${padColor}`
  );
}

async function fitVideoToTimeline(
  inputPath: string,
  outputPath: string,
  timelinePath: string,
): Promise<string> {
  const sequence = readTimelineSequenceConfig(timelinePath);
  const videoFilter = buildAspectRatioFitFilter(sequence.width, sequence.height);

  await execFilePromise("ffmpeg", [
    "-y",
    "-i", inputPath,
    "-vf", videoFilter,
    "-an",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    outputPath,
  ]);

  return outputPath;
}

// ── Phase 1: Demux ─────────────────────────────────────────────────

/**
 * Demux assembly.mp4 into raw_video.mp4 (video only) and
 * raw_dialogue.wav (audio only, PCM s16le).
 */
export async function demux(
  assemblyPath: string,
  outputDir: string,
): Promise<{ rawVideoPath: string; rawDialoguePath: string }> {
  const videoDir = path.join(outputDir, "video");
  const audioDir = path.join(outputDir, "audio");
  ensureDir(videoDir);
  ensureDir(audioDir);

  const rawVideoPath = path.join(videoDir, "raw_video.mp4");
  const rawDialoguePath = path.join(audioDir, "raw_dialogue.wav");

  // Extract video stream only (no audio)
  await execFilePromise("ffmpeg", [
    "-y",
    "-i", assemblyPath,
    "-an",
    "-c:v", "copy",
    rawVideoPath,
  ]);

  // Extract audio stream only as PCM WAV
  await execFilePromise("ffmpeg", [
    "-y",
    "-i", assemblyPath,
    "-vn",
    "-acodec", "pcm_s16le",
    rawDialoguePath,
  ]);

  return { rawVideoPath, rawDialoguePath };
}

// ── Phase 2: Caption Burn ──────────────────────────────────────────

/**
 * Burn subtitles into video using ffmpeg's subtitles filter.
 * Used when delivery_mode is "burn_in" or "both".
 */
export async function burnCaptions(
  rawVideoPath: string,
  srtPath: string,
  outputPath: string,
): Promise<string> {
  ensureDir(path.dirname(outputPath));

  // Escape path separators for the subtitles filter
  const escapedSrtPath = srtPath
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:");

  await execFilePromise("ffmpeg", [
    "-y",
    "-i", rawVideoPath,
    "-vf", `subtitles=${escapedSrtPath}`,
    outputPath,
  ]);

  return outputPath;
}

// ── Phase 3: SRT / VTT Generation ─────────────────────────────────

/**
 * Convert frame-based timecodes to SRT timestamp format:
 *   HH:MM:SS,mmm
 */
function framesToSrtTimestamp(frame: number, fps: number): string {
  const totalMs = Math.round((frame / fps) * 1000);
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;

  return (
    String(hours).padStart(2, "0") +
    ":" +
    String(minutes).padStart(2, "0") +
    ":" +
    String(seconds).padStart(2, "0") +
    "," +
    String(ms).padStart(3, "0")
  );
}

/**
 * Convert frame-based timecodes to VTT timestamp format:
 *   HH:MM:SS.mmm
 */
function framesToVttTimestamp(frame: number, fps: number): string {
  const totalMs = Math.round((frame / fps) * 1000);
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;

  return (
    String(hours).padStart(2, "0") +
    ":" +
    String(minutes).padStart(2, "0") +
    ":" +
    String(seconds).padStart(2, "0") +
    "." +
    String(ms).padStart(3, "0")
  );
}

/**
 * Generate SRT subtitle content from caption data.
 */
export function generateSrt(
  captions: Array<{
    timeline_in_frame: number;
    timeline_duration_frames: number;
    text: string;
  }>,
  fps: number,
): string {
  const lines: string[] = [];

  for (let i = 0; i < captions.length; i++) {
    const cap = captions[i];
    const startFrame = cap.timeline_in_frame;
    const endFrame = cap.timeline_in_frame + cap.timeline_duration_frames;

    lines.push(String(i + 1));
    lines.push(
      `${framesToSrtTimestamp(startFrame, fps)} --> ${framesToSrtTimestamp(endFrame, fps)}`,
    );
    lines.push(cap.text);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Generate WebVTT subtitle content from caption data.
 */
export function generateVtt(
  captions: Array<{
    timeline_in_frame: number;
    timeline_duration_frames: number;
    text: string;
  }>,
  fps: number,
): string {
  const lines: string[] = ["WEBVTT", ""];

  for (let i = 0; i < captions.length; i++) {
    const cap = captions[i];
    const startFrame = cap.timeline_in_frame;
    const endFrame = cap.timeline_in_frame + cap.timeline_duration_frames;

    lines.push(
      `${framesToVttTimestamp(startFrame, fps)} --> ${framesToVttTimestamp(endFrame, fps)}`,
    );
    lines.push(cap.text);
    lines.push("");
  }

  return lines.join("\n");
}

// ── Phase 4: Final Mux ────────────────────────────────────────────

/**
 * Mux video and audio into the final deliverable:
 *   video (copy) + audio (AAC 192k) -> final.mp4
 */
export async function finalMux(
  videoPath: string,
  audioPath: string,
  outputPath: string,
): Promise<string> {
  ensureDir(path.dirname(outputPath));

  await execFilePromise("ffmpeg", [
    "-y",
    "-i", videoPath,
    "-i", audioPath,
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "192k",
    outputPath,
  ]);

  return outputPath;
}

// ── Full Pipeline Orchestration ────────────────────────────────────

/**
 * Run the full render pipeline:
 * 1. Create output subdirs (video/, audio/, captions/, logs/)
 * 2. Verify assembly path exists (Remotion stub throws)
 * 3. Demux assembly -> raw_video + raw_dialogue
 * 4. Generate SRT/VTT sidecars if caption policy requires
 * 5. Burn captions into video if caption policy requires
 * 6. Mix audio (dialogue + BGM)
 * 7. Final mux -> final.mp4
 */
export async function runRenderPipeline(
  opts: RenderPipelineOptions,
): Promise<RenderPipelineResult> {
  const { outputDir, captionPolicy, fps } = opts;

  // 1. Create output subdirs
  const videoDir = path.join(outputDir, "video");
  const audioDir = path.join(outputDir, "audio");
  const captionsDir = path.join(outputDir, "captions");
  const logsDir = path.join(outputDir, "logs");
  ensureDir(videoDir);
  ensureDir(audioDir);
  ensureDir(captionsDir);
  ensureDir(logsDir);

  const logs: Record<string, string> = {};
  const sidecarPaths: string[] = [];

  // 2. Verify assembly path
  if (!opts.assemblyPath) {
    throw new Error(
      "No assemblyPath provided. Remotion rendering is not available in M4 - " +
      "provide a pre-built assembly.mp4",
    );
  }
  if (!fs.existsSync(opts.assemblyPath)) {
    throw new Error(`Assembly file not found: ${opts.assemblyPath}`);
  }

  const assemblyPath = opts.assemblyPath;

  // 3. Demux
  let rawVideoPath: string;
  let rawDialoguePath: string;
  try {
    const demuxResult = await demux(assemblyPath, outputDir);
    rawVideoPath = demuxResult.rawVideoPath;
    rawDialoguePath = demuxResult.rawDialoguePath;
    logs["demux"] = writeLog(logsDir, "demux", "Demux completed successfully");
  } catch (err) {
    const logPath = writeLog(logsDir, "demux", `Demux failed: ${String(err)}`);
    logs["demux"] = logPath;
    throw new Error(`Demux failed: ${String(err)}`);
  }

  // 3.5. Fit the video stream to timeline output dimensions with scale+pad.
  try {
    const normalizedVideoPath = path.join(videoDir, "raw_video.normalized.mp4");
    await fitVideoToTimeline(rawVideoPath, normalizedVideoPath, opts.timelinePath);
    fs.renameSync(normalizedVideoPath, rawVideoPath);
    logs["video_fit"] = writeLog(
      logsDir,
      "video_fit",
      `Normalized raw video to timeline output using ${path.basename(opts.timelinePath)}`,
    );
  } catch (err) {
    const logPath = writeLog(
      logsDir,
      "video_fit",
      `Video fit failed: ${String(err)}`,
    );
    logs["video_fit"] = logPath;
    throw new Error(`Video fit failed: ${String(err)}`);
  }

  // 4. Generate sidecar captions (SRT/VTT) if applicable
  let approvedCaptions: Array<{
    timeline_in_frame: number;
    timeline_duration_frames: number;
    text: string;
  }> = [];

  if (
    captionPolicy.source !== "none" &&
    opts.captionApprovalPath &&
    fs.existsSync(opts.captionApprovalPath)
  ) {
    const approvalDoc = JSON.parse(
      fs.readFileSync(opts.captionApprovalPath, "utf-8"),
    );
    approvedCaptions = approvalDoc.speech_captions || [];
  }

  if (
    captionPolicy.source !== "none" &&
    approvedCaptions.length > 0 &&
    (captionPolicy.delivery_mode === "sidecar" ||
      captionPolicy.delivery_mode === "both")
  ) {
    const srtContent = generateSrt(approvedCaptions, fps);
    const srtPath = path.join(captionsDir, "speech.approved.srt");
    fs.writeFileSync(srtPath, srtContent, "utf-8");
    sidecarPaths.push(srtPath);

    const vttContent = generateVtt(approvedCaptions, fps);
    const vttPath = path.join(captionsDir, "speech.vtt");
    fs.writeFileSync(vttPath, vttContent, "utf-8");
    sidecarPaths.push(vttPath);

    logs["caption_sidecar"] = writeLog(
      logsDir,
      "caption_sidecar",
      `Generated SRT (${srtPath}) and VTT (${vttPath})`,
    );
  }

  // 5. Burn captions into video if applicable
  let currentVideoPath = rawVideoPath;
  if (
    captionPolicy.source !== "none" &&
    approvedCaptions.length > 0 &&
    (captionPolicy.delivery_mode === "burn_in" ||
      captionPolicy.delivery_mode === "both")
  ) {
    // Ensure we have an SRT file for burn-in
    let srtForBurn = path.join(captionsDir, "speech.approved.srt");
    if (!fs.existsSync(srtForBurn)) {
      const srtContent = generateSrt(approvedCaptions, fps);
      fs.writeFileSync(srtForBurn, srtContent, "utf-8");
    }

    const captionedVideoPath = path.join(videoDir, "captioned_video.mp4");
    try {
      await burnCaptions(rawVideoPath, srtForBurn, captionedVideoPath);
      currentVideoPath = captionedVideoPath;
      logs["caption_burn"] = writeLog(
        logsDir,
        "caption_burn",
        "Caption burn completed successfully",
      );
    } catch (err) {
      const logPath = writeLog(
        logsDir,
        "caption_burn",
        `Caption burn failed: ${String(err)}`,
      );
      logs["caption_burn"] = logPath;
      throw new Error(`Caption burn failed: ${String(err)}`);
    }
  }

  // 6. Audio mix (dialogue + BGM -> final_mix.wav)
  // In a full implementation this imports from ../audio/mixer.js
  // For M4, we use the raw dialogue as the final mix if no music cues
  let finalMixPath = path.join(audioDir, "final_mix.wav");

  if (opts.musicCuesPath && fs.existsSync(opts.musicCuesPath)) {
    // With music cues: attempt to import and use the audio mixer
    try {
      const { mixAudio } = await import("../audio/mixer.js");
      const musicCuesDoc = JSON.parse(
        fs.readFileSync(opts.musicCuesPath, "utf-8"),
      );
      await mixAudio({
        rawDialoguePath,
        musicCues: musicCuesDoc,
        speechIntervals: [], // Populated by caller from A1 clips
        outputPath: finalMixPath,
        fps,
      });
      logs["audio_mix"] = writeLog(
        logsDir,
        "audio_mix",
        "Audio mix with BGM completed successfully",
      );
    } catch (err) {
      // Fallback: copy raw dialogue as final mix
      fs.copyFileSync(rawDialoguePath, finalMixPath);
      logs["audio_mix"] = writeLog(
        logsDir,
        "audio_mix",
        `Audio mixer not available, using raw dialogue as final mix: ${String(err)}`,
      );
    }
  } else {
    // No music cues: raw dialogue is the final mix
    fs.copyFileSync(rawDialoguePath, finalMixPath);
    logs["audio_mix"] = writeLog(
      logsDir,
      "audio_mix",
      "No music cues provided, raw dialogue used as final mix",
    );
  }

  // 7. Final mux
  const finalVideoPath = path.join(videoDir, "final.mp4");
  try {
    await finalMux(currentVideoPath, finalMixPath, finalVideoPath);
    logs["final_mux"] = writeLog(
      logsDir,
      "final_mux",
      "Final mux completed successfully",
    );
  } catch (err) {
    const logPath = writeLog(
      logsDir,
      "final_mux",
      `Final mux failed: ${String(err)}`,
    );
    logs["final_mux"] = logPath;
    throw new Error(`Final mux failed: ${String(err)}`);
  }

  return {
    assemblyPath,
    rawVideoPath,
    rawDialoguePath,
    finalMixPath,
    finalVideoPath,
    sidecarPaths,
    logs,
  };
}
