/**
 * PreviewJobService — single-flight preview render queue.
 *
 * Each project can have at most one active preview job. When a new render is
 * requested while one is in-flight, the old result is discarded on completion.
 *
 * Generates preview MP4 via ffmpeg from a RenderSpec, writes preview.json
 * metadata, and notifies via callback.
 */

import { execFile, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { RenderSpec, RenderTextCue, RenderVideoClip, RenderTransition, PreviewArtifactMeta } from "../../shared/render-spec.js";
import {
  buildVideoClipFilterString,
  buildTransitionSpec,
  buildVideoTransitionGraph,
  buildAudioTransitionGraph,
  type TransitionSpec,
} from "../../shared/filtergraph.js";
import { buildAssForceStyle } from "../../shared/caption-style-tokens.js";
import { INTERMEDIATE_X264, x264Args } from "../../shared/encode-profiles.js";

// ── Types ────────────────────────────────────────────────────────────

export type PreviewJobStatus = "idle" | "queued" | "rendering" | "ready" | "error";

export interface PreviewJobState {
  status: PreviewJobStatus;
  timelineRevision: string | null;
  renderSpecHash: string | null;
  previewUrl: string | null;
  warnings: string[];
  error: string | null;
}

interface ActiveJob {
  projectId: string;
  renderSpecHash: string;
  aborted: boolean;
  /** Currently running child process (ffmpeg/ffprobe) — killed on abort. */
  activeChild: ChildProcess | null;
}

type OnCompleteFn = (
  projectId: string,
  state: PreviewJobState,
) => void;

// ── Helpers ──────────────────────────────────────────────────────────

interface ExecFileResult {
  child: ChildProcess;
  promise: Promise<{ stdout: string; stderr: string }>;
}

function execFileWithChild(
  cmd: string,
  args: string[],
): ExecFileResult {
  let child!: ChildProcess;
  const promise = new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    child = execFile(
      cmd,
      args,
      { maxBuffer: 100 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(err);
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
  return { child, promise };
}

async function hasAudioStream(filePath: string, job?: ActiveJob): Promise<boolean> {
  try {
    const { child, promise } = execFileWithChild("ffprobe", [
      "-v", "error",
      "-select_streams", "a",
      "-show_entries", "stream=codec_type",
      "-of", "csv=p=0",
      filePath,
    ]);
    if (job) job.activeChild = child;
    const { stdout } = await promise;
    if (job) job.activeChild = null;
    return stdout.trim().includes("audio");
  } catch {
    if (job) job.activeChild = null;
    return false;
  }
}

// ── Audio Mastering (Phase 4: Audio Parity) ─────────────────────────

interface LoudnormMeasurement {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

function parseLoudnormOutput(stderr: string): LoudnormMeasurement {
  const jsonMatch = stderr.match(/\{[^{}]*"input_i"\s*:[^{}]*\}/s);
  if (!jsonMatch) {
    throw new Error("Could not find loudnorm JSON in ffmpeg output");
  }
  const parsed = JSON.parse(jsonMatch[0]);
  return {
    input_i: String(parsed.input_i),
    input_tp: String(parsed.input_tp),
    input_lra: String(parsed.input_lra),
    input_thresh: String(parsed.input_thresh),
    target_offset: String(parsed.target_offset),
  };
}

/**
 * Run 2-pass loudnorm mastering on an audio file.
 * Same algorithm as runtime/audio/mastering.ts — duplicated here because
 * the editor tsconfig cannot import from runtime/.
 */
async function masterAudioTwoPass(
  inputPath: string,
  outputPath: string,
  mastering: { targetLufs: number; truePeakDbtp: number; lra: number },
  job?: ActiveJob,
): Promise<void> {
  const { targetLufs, truePeakDbtp, lra } = mastering;

  // Pass 1: Measure
  const pass1 = execFileWithChild("ffmpeg", [
    "-i", inputPath,
    "-af", `loudnorm=I=${targetLufs}:LRA=${lra}:TP=${truePeakDbtp}:print_format=json`,
    "-f", "null", "-",
  ]);
  if (job) job.activeChild = pass1.child;
  const { stderr } = await pass1.promise.catch((err) => {
    // ffmpeg may exit non-zero for -f null but still produce measurement
    if (err && err.stderr) return { stdout: "", stderr: err.stderr as string };
    throw err;
  });
  if (job) job.activeChild = null;

  const m = parseLoudnormOutput(stderr);

  // Pass 2: Apply
  const filterStr = [
    `loudnorm=I=${targetLufs}`,
    `LRA=${lra}`,
    `TP=${truePeakDbtp}`,
    `measured_I=${m.input_i}`,
    `measured_LRA=${m.input_lra}`,
    `measured_TP=${m.input_tp}`,
    `measured_thresh=${m.input_thresh}`,
    `offset=${m.target_offset}`,
    "linear=true",
  ].join(":");

  const pass2 = execFileWithChild("ffmpeg", [
    "-y", "-i", inputPath,
    "-af", filterStr,
    "-ar", "48000", "-ac", "2",
    outputPath,
  ]);
  if (job) job.activeChild = pass2.child;
  await pass2.promise;
  if (job) job.activeChild = null;
}

// ── Transition Helpers (Phase 4) ────────────────────────────────────

/**
 * Build a clip-index lookup for transitions.
 */
function resolveTransitionIndexes(
  transitions: RenderTransition[],
  videoClips: RenderVideoClip[],
  fps: number,
): Array<{ spec: TransitionSpec; fromIndex: number; toIndex: number }> {
  const clipIdToIndex = new Map<string, number>();
  videoClips.forEach((c, i) => clipIdToIndex.set(c.clipId, i));

  const result: Array<{ spec: TransitionSpec; fromIndex: number; toIndex: number }> = [];
  for (const t of transitions) {
    if (t.type === "cut") continue;
    const fromIdx = clipIdToIndex.get(t.fromClipId);
    const toIdx = clipIdToIndex.get(t.toClipId);
    if (fromIdx === undefined || toIdx === undefined) continue;
    result.push({
      spec: buildTransitionSpec(t, fps),
      fromIndex: fromIdx,
      toIndex: toIdx,
    });
  }
  return result;
}

/**
 * Compute per-adjacency overlap seconds for timeline-to-video-time mapping.
 * Index i holds the overlap between clip i-1 and clip i (0 for first clip).
 */
function computeOverlapsSec(
  clipCount: number,
  transitions: Array<{ spec: TransitionSpec; toIndex: number }>,
): number[] {
  const overlaps = new Array<number>(clipCount).fill(0);
  for (const t of transitions) {
    if (t.spec.video.method === "xfade" && t.spec.video.xfadeDurationSec) {
      overlaps[t.toIndex] = t.spec.video.xfadeDurationSec;
    } else if (t.spec.video.method === "fade_in_out") {
      const out = t.spec.video.fadeOutDurationSec ?? 0;
      const ins = t.spec.video.fadeInDurationSec ?? 0;
      overlaps[t.toIndex] = out + ins;
    }
  }
  return overlaps;
}

// ── SRT Generation (Phase 3: Caption Parity) ────────────────────────

/**
 * Format seconds as SRT timestamp: HH:MM:SS,mmm
 */
function formatSrtTime(totalSec: number): string {
  // Round to milliseconds first, then decompose — avoids ms=1000 overflow
  const totalMs = Math.round(totalSec * 1000);
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return (
    String(h).padStart(2, "0") + ":" +
    String(m).padStart(2, "0") + ":" +
    String(s).padStart(2, "0") + "," +
    String(ms).padStart(3, "0")
  );
}

/**
 * Build a mapping from timeline frames to video time (seconds) in the
 * concatenated preview. Clips may have gaps in the timeline that don't
 * exist in the concatenated video.
 *
 * @param overlapsSec Per-clip overlap array (index i = overlap with previous clip).
 *                    Defaults to no overlaps for backward compat.
 */
function timelineFrameToVideoSec(
  frame: number,
  videoClips: RenderVideoClip[],
  fps: number,
  overlapsSec?: number[],
): number | null {
  let videoOffsetSec = 0;
  for (let i = 0; i < videoClips.length; i++) {
    const clip = videoClips[i];
    const clipDurSec = clip.sourceOutSec - clip.sourceInSec;
    const clipStartFrame = clip.timelineInFrame;
    const clipEndFrame = clipStartFrame + clip.durationFrames;

    // Account for transition overlap with previous clip
    if (i > 0 && overlapsSec && overlapsSec[i]) {
      videoOffsetSec -= overlapsSec[i];
    }

    // MAJOR-4: Effective clip end in video time excludes overlap with the
    // next clip so that outgoing cue end == incoming cue start (no double-count).
    const nextOverlap =
      (overlapsSec && i + 1 < videoClips.length)
        ? (overlapsSec[i + 1] ?? 0) : 0;

    if (frame >= clipStartFrame && frame < clipEndFrame) {
      const posInClip = (frame - clipStartFrame) / fps;
      return videoOffsetSec + Math.min(posInClip, clipDurSec - nextOverlap);
    }
    // Cue endFrame lands exactly on clip boundary (exclusive end) —
    // clamp to the compressed position.
    if (frame === clipEndFrame) {
      return videoOffsetSec + clipDurSec - nextOverlap;
    }
    videoOffsetSec += clipDurSec;
  }
  return null;
}

/**
 * Generate an SRT subtitle file from RenderTextCue[].
 *
 * Timestamps are mapped from absolute timeline frames to video time in
 * the concatenated preview (which may skip timeline gaps).
 *
 * MAJOR-1 (Phase 5 review R1): exported as `__testGenerateSrt` so parity
 * tests can compare cue text/timing across preview and final paths
 * without re-implementing the gap-aware mapping.
 */
export function __testGenerateSrt(
  cues: RenderTextCue[],
  videoClips: RenderVideoClip[],
  fps: number,
  overlapsSec?: number[],
): string {
  return generateSrt(cues, videoClips, fps, overlapsSec);
}

function generateSrt(
  cues: RenderTextCue[],
  videoClips: RenderVideoClip[],
  fps: number,
  overlapsSec?: number[],
): string {
  const lines: string[] = [];
  let index = 1;
  for (const cue of cues) {
    const startSec = timelineFrameToVideoSec(cue.startFrame, videoClips, fps, overlapsSec);
    const endSec = timelineFrameToVideoSec(cue.endFrame, videoClips, fps, overlapsSec);
    if (startSec == null || endSec == null || endSec <= startSec) continue;
    lines.push(
      String(index),
      `${formatSrtTime(startSec)} --> ${formatSrtTime(endSec)}`,
      cue.text,
      "",
    );
    index++;
  }
  return lines.join("\n");
}

// ── Cache cleanup config (Phase 5 / Section 15.2) ───────────────────

/** Maximum number of preview-*.mp4 artifacts retained per project. */
const PREVIEW_CACHE_KEEP = 3;

/**
 * Programmatic feature flag for ProgramMonitor exact preview rendering
 * (Section 15.3). When false, the service refuses preview requests so the
 * client falls back to source_approx playback.
 *
 * Default: enabled. Disable by exporting
 *   PROGRAM_MONITOR_EXACT_PREVIEW=false
 * before starting the editor server.
 */
function isExactPreviewEnabled(): boolean {
  const v = process.env.PROGRAM_MONITOR_EXACT_PREVIEW;
  if (v === undefined) return true;
  return !["0", "false", "no", "off"].includes(v.toLowerCase());
}

// ── Service ──────────────────────────────────────────────────────────

export class PreviewJobService {
  private jobs = new Map<string, ActiveJob>();
  private states = new Map<string, PreviewJobState>();
  private onComplete: OnCompleteFn;
  private projectsDir: string;
  private exactPreviewEnabled: boolean;

  constructor(onComplete: OnCompleteFn, projectsDir?: string) {
    this.onComplete = onComplete;
    this.projectsDir = projectsDir ?? "";
    this.exactPreviewEnabled = isExactPreviewEnabled();

    if (!this.exactPreviewEnabled) {
      console.log(
        JSON.stringify({
          tag: "preview-job",
          event: "feature_disabled",
          flag: "programMonitorExactPreview",
          fallback: "source_approx",
        }),
      );
    } else if (this.projectsDir) {
      // Section 15.2: prune existing artifact directories at startup so the
      // cache stays bounded across restarts.
      this.pruneOldArtifacts();
    }
  }

  /** Whether exact preview rendering is currently enabled (Section 15.3). */
  isEnabled(): boolean {
    return this.exactPreviewEnabled;
  }

  /**
   * MINOR-1 (Phase 5 review R1): walk the configured projects directory and
   * prune surplus preview-*.mp4 artifacts in each project so the cache stays
   * bounded after a restart.
   *
   * The original `cleanupOrphans()` name implied we removed files that were
   * unreferenced by any preview.json — but the underlying helper actually
   * keeps the *current* artifact plus the (PREVIEW_CACHE_KEEP - 1) newest
   * peers, irrespective of metadata orphan status. The new name describes
   * what the routine actually does. Best-effort — never throws.
   */
  private pruneOldArtifacts(): void {
    if (!this.projectsDir || !fs.existsSync(this.projectsDir)) return;
    let removed = 0;
    try {
      const entries = fs.readdirSync(this.projectsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const previewsDir = path.join(
          this.projectsDir,
          entry.name,
          "05_timeline",
          "previews",
        );
        if (!fs.existsSync(previewsDir)) continue;
        removed += this.pruneProjectPreviews(previewsDir);
      }
    } catch (err) {
      console.warn(
        JSON.stringify({
          tag: "preview-job",
          event: "prune_failed",
          reason: err instanceof Error ? err.message : String(err),
        }),
      );
      return;
    }
    if (removed > 0) {
      console.log(
        JSON.stringify({
          tag: "preview-job",
          event: "prune_old_artifacts",
          removed,
        }),
      );
    }
  }

  /**
   * Within a single project's previews/ directory, keep only the
   * artifact referenced by preview.json plus the (PREVIEW_CACHE_KEEP - 1)
   * newest other preview-*.mp4 files. Returns the number of files removed.
   */
  private pruneProjectPreviews(previewsDir: string): number {
    let removed = 0;
    try {
      // Determine which file is "current" per preview.json
      let currentFile: string | null = null;
      const metaPath = path.join(previewsDir, "preview.json");
      if (fs.existsSync(metaPath)) {
        try {
          const meta: PreviewArtifactMeta = JSON.parse(
            fs.readFileSync(metaPath, "utf-8"),
          );
          currentFile = meta.videoPath ?? null;
        } catch {
          currentFile = null;
        }
      }

      const all = fs
        .readdirSync(previewsDir)
        .filter((name) => /^preview-[0-9a-f]+\.mp4$/.test(name));

      // Sort newest first (by mtime)
      const stamped = all.map((name) => {
        const full = path.join(previewsDir, name);
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(full).mtimeMs;
        } catch {
          // ignore
        }
        return { name, full, mtimeMs };
      });
      stamped.sort((a, b) => b.mtimeMs - a.mtimeMs);

      const keep = new Set<string>();
      if (currentFile) keep.add(currentFile);
      for (const f of stamped) {
        if (keep.size >= PREVIEW_CACHE_KEEP) break;
        keep.add(f.name);
      }

      for (const f of stamped) {
        if (keep.has(f.name)) continue;
        try {
          fs.unlinkSync(f.full);
          removed++;
        } catch {
          // ignore — best-effort
        }
      }
    } catch {
      // ignore — best-effort
    }
    return removed;
  }

  /** Get current state for a project, restoring from disk if needed. */
  getState(projectId: string): PreviewJobState {
    const cached = this.states.get(projectId);
    if (cached) return cached;

    // NEW-MAJOR-1: Restore from disk preview.json after server restart
    if (this.projectsDir) {
      const restored = this.restoreFromDisk(projectId);
      if (restored) return restored;
    }

    return {
      status: "idle",
      timelineRevision: null,
      renderSpecHash: null,
      previewUrl: null,
      warnings: [],
      error: null,
    };
  }

  /**
   * Attempt to restore preview state from 05_timeline/previews/preview.json.
   * Returns null if the file doesn't exist or is invalid.
   */
  private restoreFromDisk(projectId: string): PreviewJobState | null {
    try {
      const metaPath = path.join(
        this.projectsDir, projectId, "05_timeline", "previews", "preview.json",
      );
      if (!fs.existsSync(metaPath)) return null;

      const meta: PreviewArtifactMeta = JSON.parse(
        fs.readFileSync(metaPath, "utf-8"),
      );
      if (meta.status !== "ready" || !meta.videoPath) return null;

      // Verify the video file actually exists
      const videoPath = path.join(
        this.projectsDir, projectId, "05_timeline", "previews", meta.videoPath,
      );
      if (!fs.existsSync(videoPath)) return null;

      const state: PreviewJobState = {
        status: "ready",
        timelineRevision: meta.timelineRevision ?? null,
        renderSpecHash: meta.renderSpecHash ?? null,
        previewUrl: `/api/projects/${projectId}/preview/previews/${meta.videoPath}`,
        warnings: meta.warnings ?? [],
        error: null,
      };
      this.states.set(projectId, state);
      return state;
    } catch {
      return null;
    }
  }

  /**
   * Request a preview render. Returns immediately with queued status.
   * If a job is already running for this project, it will be superseded.
   *
   * If exact preview is disabled (Section 15.3 feature flag), the request
   * is rejected — the returned state has status="idle" so the client
   * stays in source_approx mode.
   */
  request(
    projectId: string,
    projectDir: string,
    renderSpec: RenderSpec,
  ): PreviewJobState {
    if (!this.exactPreviewEnabled) {
      // MAJOR-3 (Phase 5 review R1): the feature flag (Section 15.3) is
      // designed so the client can fall back to source_approx instantly.
      // We surface a machine-readable `feature_disabled` reason in `error`
      // — the client treats status='idle' as "no exact preview, use source"
      // and does NOT show a generic error toast.
      const idleState: PreviewJobState = {
        status: "idle",
        timelineRevision: renderSpec.timelineRevision,
        renderSpecHash: renderSpec.renderSpecHash,
        previewUrl: null,
        warnings: ["exact preview disabled by programMonitorExactPreview=false"],
        error: "feature_disabled",
      };
      this.states.set(projectId, idleState);
      return idleState;
    }

    // Cancel any in-flight job for this project
    const existing = this.jobs.get(projectId);
    if (existing) {
      existing.aborted = true;
      if (existing.activeChild) {
        try { existing.activeChild.kill("SIGTERM"); } catch { /* ignore */ }
        existing.activeChild = null;
      }
    }

    const state: PreviewJobState = {
      status: "rendering",
      timelineRevision: renderSpec.timelineRevision,
      renderSpecHash: renderSpec.renderSpecHash,
      previewUrl: null,
      warnings: renderSpec.warnings ?? [],
      error: null,
    };
    this.states.set(projectId, state);

    const job: ActiveJob = {
      projectId,
      renderSpecHash: renderSpec.renderSpecHash,
      aborted: false,
      activeChild: null,
    };
    this.jobs.set(projectId, job);

    // Run async — do not await
    void this.runJob(job, projectDir, renderSpec);

    return { ...state, status: "rendering" };
  }

  // ── Internal ─────────────────────────────────────────────────────

  private async runJob(
    job: ActiveJob,
    projectDir: string,
    spec: RenderSpec,
  ): Promise<void> {
    const { projectId, renderSpecHash } = job;
    const previewsDir = path.join(projectDir, "05_timeline", "previews");
    fs.mkdirSync(previewsDir, { recursive: true });

    const outputFilename = `preview-${renderSpecHash}.mp4`;
    const outputPath = path.join(previewsDir, outputFilename);
    const metaPath = path.join(previewsDir, "preview.json");
    const tmpDir = path.join(previewsDir, `.tmp-${renderSpecHash}`);

    // Phase 5: telemetry — bracket the entire job with timing.
    // MINOR-1 (Phase 5 review R1): emit structured JSON so logs can be
    // ingested by JSON-aware log shippers without ad-hoc parsing.
    const startedAt = Date.now();
    console.log(
      JSON.stringify({
        tag: "preview-job",
        event: "start",
        projectId,
        renderSpecHash,
        clips: spec.video.clips.length,
      }),
    );

    try {
      // Skip if artifact already exists with matching hash
      if (fs.existsSync(outputPath) && fs.existsSync(metaPath)) {
        try {
          const existingMeta: PreviewArtifactMeta = JSON.parse(
            fs.readFileSync(metaPath, "utf-8"),
          );
          if (existingMeta.renderSpecHash === renderSpecHash && existingMeta.status === "ready") {
            // MAJOR-2 (Phase 5 review R1): warnings are runtime-derived and
            // intentionally excluded from computeRenderSpecHash, which means
            // the on-disk preview.json may carry a stale `warnings` array.
            // On a cache hit we surface the freshly built spec.warnings so
            // the UI sees current degrade notices, and we also persist the
            // refreshed list back to preview.json so the artifact is
            // self-describing for the next consumer.
            const freshWarnings = [...(spec.warnings ?? [])];
            const state: PreviewJobState = {
              status: "ready",
              timelineRevision: spec.timelineRevision,
              renderSpecHash,
              previewUrl: `/api/projects/${projectId}/preview/previews/${outputFilename}`,
              warnings: freshWarnings,
              error: null,
            };
            this.states.set(projectId, state);
            if (this.jobs.get(projectId) === job) this.jobs.delete(projectId);

            // Persist refreshed warnings into preview.json (best-effort).
            try {
              const refreshedMeta: PreviewArtifactMeta = {
                ...existingMeta,
                warnings: freshWarnings,
              };
              fs.writeFileSync(
                metaPath,
                JSON.stringify(refreshedMeta, null, 2),
                "utf-8",
              );
            } catch {
              // ignore — UI state already carries the fresh warnings
            }

            console.log(
              JSON.stringify({
                tag: "preview-job",
                event: "cache_hit",
                projectId,
                renderSpecHash,
                durationMs: Date.now() - startedAt,
                warnings: freshWarnings.length,
              }),
            );
            this.onComplete(projectId, state);
            return;
          }
        } catch {
          // Corrupt meta — regenerate
        }
      }

      fs.mkdirSync(tmpDir, { recursive: true });

      const videoClips = spec.video.clips;
      if (videoClips.length === 0) {
        throw new Error("No video clips in RenderSpec");
      }

      const clipPaths: string[] = [];
      // Merge build-time warnings from RenderSpec with runtime warnings
      const warnings: string[] = [...(spec.warnings ?? [])];
      const { width, height, fps } = spec.sequence;

      for (let i = 0; i < videoClips.length; i++) {
        if (job.aborted) { if (this.jobs.get(projectId) === job) this.jobs.delete(projectId); return; }

        const clip = videoClips[i];
        const durationSec = clip.sourceOutSec - clip.sourceInSec;
        // Intermediates use PCM audio in .mov: AAC's 1024-sample priming
        // delay becomes an edit list that the concat demuxer turns into a
        // ~21ms video start offset, breaking A/V parity with the final
        // render. PCM has no encoder delay, and it saves an AAC generation.
        const clipOutPath = path.join(tmpDir, `clip_${String(i).padStart(4, "0")}.mov`);

        const sourceHasAudio = await hasAudioStream(clip.sourcePath, job);
        const ffmpegArgs: string[] = ["-y"];

        // Input
        ffmpegArgs.push(
          "-ss", clip.sourceInSec.toFixed(6),
          "-i", clip.sourcePath,
          "-t", durationSec.toFixed(6),
        );

        if (!sourceHasAudio) {
          ffmpegArgs.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
        }

        // Video: Phase 2 — use shared filter builder for zoom/crop/position parity
        const vf = buildVideoClipFilterString(clip, { width, height });
        ffmpegArgs.push("-vf", vf, ...x264Args(INTERMEDIATE_X264));

        if (!sourceHasAudio) {
          ffmpegArgs.push("-map", "0:v:0", "-map", "1:a:0");
        }

        // Audio: Phase 1 = source pass-through (no loudnorm)
        // Only apply per-clip gain if specified
        if (sourceHasAudio) {
          const audioClip = spec.audio.dialogueClips.find(
            (ac) => ac.clipId === clip.clipId || ac.assetId === clip.assetId,
          );
          const gainDb = audioClip?.gainDb;
          if (gainDb !== null && gainDb !== undefined && gainDb !== 0) {
            ffmpegArgs.push("-af", `volume=${gainDb}dB`);
          }
        }

        ffmpegArgs.push(
          "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2",
        );

        if (!sourceHasAudio) {
          ffmpegArgs.push("-shortest");
        }

        ffmpegArgs.push("-pix_fmt", "yuv420p", clipOutPath);

        const clipExec = execFileWithChild("ffmpeg", ffmpegArgs);
        job.activeChild = clipExec.child;
        await clipExec.promise;
        job.activeChild = null;
        clipPaths.push(clipOutPath);
      }

      if (job.aborted) { if (this.jobs.get(projectId) === job) this.jobs.delete(projectId); return; }

      // ── Phase 4: Resolve transitions ──
      const transitionIndexes = resolveTransitionIndexes(
        spec.video.transitions, videoClips, fps,
      );
      const useTransitionGraph = transitionIndexes.length > 0;
      const overlapsSec = useTransitionGraph
        ? computeOverlapsSec(videoClips.length, transitionIndexes)
        : undefined;
      const clipDurationsSec = videoClips.map(
        (c) => c.sourceOutSec - c.sourceInSec,
      );

      // ── Concatenate clips (transition-aware) ──
      const concatPath = path.join(tmpDir, "concat_raw.mov");

      if (clipPaths.length === 1) {
        fs.copyFileSync(clipPaths[0], concatPath);
      } else if (useTransitionGraph) {
        // filter_complex: video + audio transition graphs
        const inputArgs: string[] = ["-y"];
        for (const p of clipPaths) {
          inputArgs.push("-i", p);
        }

        const { filterChain: videoChain, outputLabel: videoOut } =
          buildVideoTransitionGraph(
            clipPaths.length, clipDurationsSec, transitionIndexes,
          );
        const { filterChain: audioChain, outputLabel: audioOut } =
          buildAudioTransitionGraph(
            clipPaths.length, clipDurationsSec, transitionIndexes,
          );

        const filterComplex = [videoChain, audioChain]
          .filter(Boolean)
          .join(";");

        inputArgs.push(
          "-filter_complex", filterComplex,
          "-map", videoOut,
          "-map", audioOut,
          ...x264Args(INTERMEDIATE_X264),
          "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2",
          "-pix_fmt", "yuv420p",
          concatPath,
        );

        const concatExec = execFileWithChild("ffmpeg", inputArgs);
        job.activeChild = concatExec.child;
        await concatExec.promise;
        job.activeChild = null;
      } else {
        // Fast path: concat demuxer (stream copy, no transitions)
        const concatFilePath = path.join(tmpDir, "concat.txt");
        const concatContent = clipPaths
          .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
          .join("\n");
        fs.writeFileSync(concatFilePath, concatContent, "utf-8");

        const concatExec = execFileWithChild("ffmpeg", [
          "-y", "-f", "concat", "-safe", "0",
          "-i", concatFilePath,
          "-c", "copy",
          concatPath,
        ]);
        job.activeChild = concatExec.child;
        await concatExec.promise;
        job.activeChild = null;
      }

      if (job.aborted) { if (this.jobs.get(projectId) === job) this.jobs.delete(projectId); return; }

      // ── Phase 4: Audio mastering (2-pass loudnorm) ──
      // Extract audio → optional BGM mix → 2-pass loudnorm → mastered wav
      const audioRawPath = path.join(tmpDir, "audio_raw.wav");
      const audioMasteredPath = path.join(tmpDir, "audio_mastered.wav");
      let hasMasteredAudio = false;

      // Extract raw audio from concat
      {
        const extractExec = execFileWithChild("ffmpeg", [
          "-y", "-i", concatPath,
          "-vn", "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2",
          audioRawPath,
        ]);
        job.activeChild = extractExec.child;
        await extractExec.promise;
        job.activeChild = null;
      }

      if (job.aborted) { if (this.jobs.get(projectId) === job) this.jobs.delete(projectId); return; }

      // Mix BGM if present
      let masterInputPath = audioRawPath;
      if (spec.audio.bgm) {
        const bgmMixedPath = path.join(tmpDir, "audio_bgm_mixed.wav");
        const bgm = spec.audio.bgm;

        // Compute total video duration for fade-out position
        let totalDurSec = clipDurationsSec.reduce((sum, d) => sum + d, 0);
        if (overlapsSec) {
          for (let oi = 1; oi < overlapsSec.length; oi++) {
            totalDurSec -= overlapsSec[oi];
          }
        }

        // Build BGM filter: gain + optional fade in/out
        const bgmFilters: string[] = [];
        bgmFilters.push(`volume=${bgm.gainDb}dB`);
        if (bgm.fadeInFrames > 0) {
          const fadeInSec = bgm.fadeInFrames / fps;
          bgmFilters.push(`afade=t=in:d=${fadeInSec.toFixed(4)}`);
        }
        if (bgm.fadeOutFrames > 0) {
          const fadeOutSec = bgm.fadeOutFrames / fps;
          const fadeOutStart = Math.max(0, totalDurSec - fadeOutSec);
          bgmFilters.push(`afade=t=out:st=${fadeOutStart.toFixed(4)}:d=${fadeOutSec.toFixed(4)}`);
        }
        const bgmFilterStr = bgmFilters.join(",");

        // Build filter_complex — with or without ducking
        let filterComplex: string;
        if (bgm.duckMusicDb !== undefined && bgm.duckMusicDb < 0) {
          // Ducking: use sidechaincompress driven by dialogue audio
          const duckDb = Math.abs(bgm.duckMusicDb);
          const ratio = Math.max(2, Math.round(duckDb / 3));
          filterComplex =
            `[0:a]asplit=2[dial][sc];` +
            `[1:a]${bgmFilterStr}[bgm_pre];` +
            `[bgm_pre][sc]sidechaincompress=threshold=0.02:ratio=${ratio}:attack=200:release=1000:level_sc=0.5[bgm];` +
            `[dial][bgm]amix=inputs=2:duration=first:dropout_transition=2`;
        } else {
          filterComplex =
            `[1:a]${bgmFilterStr}[bgm];[0:a][bgm]amix=inputs=2:duration=first:dropout_transition=2`;
        }

        const bgmExec = execFileWithChild("ffmpeg", [
          "-y",
          "-i", audioRawPath,
          "-i", bgm.sourcePath,
          "-filter_complex", filterComplex,
          "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2",
          bgmMixedPath,
        ]);
        job.activeChild = bgmExec.child;
        await bgmExec.promise;
        job.activeChild = null;
        masterInputPath = bgmMixedPath;
      }

      if (job.aborted) { if (this.jobs.get(projectId) === job) this.jobs.delete(projectId); return; }

      // 2-pass loudnorm mastering
      await masterAudioTwoPass(
        masterInputPath,
        audioMasteredPath,
        spec.audio.mastering,
        job,
      );
      hasMasteredAudio = true;

      if (job.aborted) { if (this.jobs.get(projectId) === job) this.jobs.delete(projectId); return; }

      // ── Final assembly: video + mastered audio + optional subtitles ──
      const hasCaptions = spec.text.speechCaptions.length > 0;
      const finalArgs: string[] = ["-y", "-i", concatPath];

      if (hasMasteredAudio) {
        finalArgs.push("-i", audioMasteredPath);
      }

      // Stream mapping must come before codec specs
      if (hasMasteredAudio) {
        finalArgs.push("-map", "0:v:0", "-map", "1:a:0");
      }

      // Video filter: subtitles if present, otherwise copy
      if (hasCaptions) {
        const srtContent = generateSrt(
          spec.text.speechCaptions, videoClips, fps, overlapsSec,
        );
        const srtPath = path.join(tmpDir, "captions.srt");
        fs.writeFileSync(srtPath, srtContent, "utf-8");

        const forceStyle = buildAssForceStyle(
          spec.text.stylePreset, { width, height, fps },
        );
        const escapedSrt = srtPath
          .replace(/\\/g, "\\\\")
          .replace(/:/g, "\\:")
          .replace(/'/g, "'\\''");

        finalArgs.push(
          "-vf", `subtitles='${escapedSrt}':force_style='${forceStyle}'`,
          "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
        );
      } else {
        finalArgs.push("-c:v", "copy");
      }

      // Audio codec
      if (hasMasteredAudio) {
        finalArgs.push(
          "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
        );
      } else {
        finalArgs.push("-c:a", "copy");
      }

      finalArgs.push("-pix_fmt", "yuv420p", outputPath);

      const finalExec = execFileWithChild("ffmpeg", finalArgs);
      job.activeChild = finalExec.child;
      await finalExec.promise;
      job.activeChild = null;

      if (job.aborted) { if (this.jobs.get(projectId) === job) this.jobs.delete(projectId); return; }

      // Write preview.json
      const meta: PreviewArtifactMeta = {
        renderSpecHash,
        timelineRevision: spec.timelineRevision,
        sequence: { width, height, fps },
        generatedAt: new Date().toISOString(),
        status: "ready",
        warnings,
        videoPath: outputFilename,
      };
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");

      const state: PreviewJobState = {
        status: "ready",
        timelineRevision: spec.timelineRevision,
        renderSpecHash,
        previewUrl: `/api/projects/${projectId}/preview/previews/${outputFilename}`,
        warnings,
        error: null,
      };
      this.states.set(projectId, state);
      if (this.jobs.get(projectId) === job) this.jobs.delete(projectId);

      // Phase 5: prune old artifacts (keep latest N)
      this.pruneProjectPreviews(previewsDir);

      // Phase 5: telemetry — success
      console.log(
        JSON.stringify({
          tag: "preview-job",
          event: "success",
          projectId,
          renderSpecHash,
          durationMs: Date.now() - startedAt,
          warnings: warnings.length,
        }),
      );

      this.onComplete(projectId, state);
    } catch (err) {
      if (job.aborted) {
        if (this.jobs.get(projectId) === job) this.jobs.delete(projectId);
        console.log(
          JSON.stringify({
            tag: "preview-job",
            event: "aborted",
            projectId,
            renderSpecHash,
            durationMs: Date.now() - startedAt,
          }),
        );
        return;
      }

      const errorMsg = err instanceof Error ? err.message : String(err);
      const state: PreviewJobState = {
        status: "error",
        timelineRevision: spec.timelineRevision,
        renderSpecHash,
        previewUrl: null,
        warnings: [],
        error: errorMsg,
      };
      this.states.set(projectId, state);
      if (this.jobs.get(projectId) === job) this.jobs.delete(projectId);

      // Phase 5: telemetry — failure
      console.error(
        JSON.stringify({
          tag: "preview-job",
          event: "failure",
          projectId,
          renderSpecHash,
          durationMs: Date.now() - startedAt,
          error: errorMsg,
        }),
      );

      this.onComplete(projectId, state);
    } finally {
      // Clean up temp directory
      try {
        if (fs.existsSync(tmpDir)) {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      } catch {
        // ignore cleanup errors
      }
    }
  }
}
