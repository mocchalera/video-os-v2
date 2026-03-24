/**
 * Preview generation API route.
 *
 * POST /api/projects/:id/preview — Generate preview MP4 via ffmpeg
 * GET  /api/projects/:id/preview/:filename — Serve generated preview files
 */

import { Router } from "express";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

interface TimelineClip {
  clip_id: string;
  asset_id: string;
  src_in_us: number;
  src_out_us: number;
  timeline_in_frame: number;
  timeline_duration_frames: number;
}

interface TimelineTrack {
  track_id: string;
  kind: string;
  clips: TimelineClip[];
}

interface TimelineData {
  sequence: {
    fps_num: number;
    fps_den: number;
    width: number;
    height: number;
  };
  tracks: {
    video: TimelineTrack[];
    audio: TimelineTrack[];
  };
}

interface SourceMapDoc {
  items: Array<{
    asset_id: string;
    source_locator: string;
    local_source_path: string;
  }>;
}

interface PreviewRequest {
  mode: "range" | "clip" | "full";
  startFrame?: number;
  endFrame?: number;
  clipId?: string;
  resolution?: string;
}

function execFilePromise(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { maxBuffer: 100 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(err);
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
}

function resolveAssetPath(
  sourceMap: SourceMapDoc,
  assetId: string,
): string | undefined {
  const entry = sourceMap.items.find((i) => i.asset_id === assetId);
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

export function createPreviewRouter(projectsDir: string): Router {
  const router = Router();

  // POST /api/projects/:id/preview
  router.post("/:id/preview", async (req, res) => {
    const projectId = req.params.id;
    const projectDir = path.join(projectsDir, projectId);
    const timelinePath = path.join(projectDir, "05_timeline", "timeline.json");
    const sourceMapPath = path.join(projectDir, "02_media", "source_map.json");

    if (!fs.existsSync(timelinePath)) {
      res.status(404).json({ error: "Timeline not found", project: projectId });
      return;
    }

    const body = req.body as PreviewRequest;
    if (!body.mode || !["range", "clip", "full"].includes(body.mode)) {
      res.status(400).json({
        error: "Invalid request",
        details: 'mode must be "range", "clip", or "full"',
      });
      return;
    }

    try {
      const timeline: TimelineData = JSON.parse(
        fs.readFileSync(timelinePath, "utf-8"),
      );
      const fps = timeline.sequence.fps_num / timeline.sequence.fps_den;

      // Load source map
      let sourceMap: SourceMapDoc = { items: [] };
      if (fs.existsSync(sourceMapPath)) {
        sourceMap = JSON.parse(fs.readFileSync(sourceMapPath, "utf-8"));
      }

      // Get V1 video clips sorted by timeline position
      const v1 = timeline.tracks.video[0];
      if (!v1 || v1.clips.length === 0) {
        res.status(400).json({ error: "No video clips in timeline" });
        return;
      }

      let clips = [...v1.clips].sort(
        (a, b) => a.timeline_in_frame - b.timeline_in_frame,
      );

      // Apply mode filter
      if (body.mode === "clip") {
        if (!body.clipId) {
          res
            .status(400)
            .json({ error: "clipId required for mode=clip" });
          return;
        }
        clips = clips.filter((c) => c.clip_id === body.clipId);
        if (clips.length === 0) {
          res.status(404).json({
            error: "Clip not found",
            details: `No clip with id ${body.clipId}`,
          });
          return;
        }
      } else if (body.mode === "range") {
        const startFrame = body.startFrame ?? 0;
        const endFrame = body.endFrame ?? Infinity;
        clips = clips
          .filter(
            (c) =>
              c.timeline_in_frame + c.timeline_duration_frames > startFrame &&
              c.timeline_in_frame < endFrame,
          )
          .map((c) => {
            // Trim clips to the requested range
            const clipEnd =
              c.timeline_in_frame + c.timeline_duration_frames;
            const trimStart = Math.max(0, startFrame - c.timeline_in_frame);
            const trimEnd = Math.max(
              0,
              clipEnd - endFrame,
            );
            if (trimStart === 0 && trimEnd === 0) return c;

            const srcDuration = c.src_out_us - c.src_in_us;
            const frameRatio = srcDuration / c.timeline_duration_frames;
            return {
              ...c,
              src_in_us: c.src_in_us + Math.round(trimStart * frameRatio),
              src_out_us: c.src_out_us - Math.round(trimEnd * frameRatio),
              timeline_in_frame: c.timeline_in_frame + trimStart,
              timeline_duration_frames:
                c.timeline_duration_frames - trimStart - trimEnd,
            };
          });

        if (clips.length === 0) {
          res.status(400).json({
            error: "No clips in specified range",
          });
          return;
        }
      }

      // Prepare output
      const outputDir = path.join(projectDir, "05_timeline");
      fs.mkdirSync(outputDir, { recursive: true });

      const timestamp = Date.now();
      const outputFilename = `preview-editor-${timestamp}.mp4`;
      const outputPath = path.join(outputDir, outputFilename);

      // Create temp directory for clip extraction
      const tmpDir = path.join(outputDir, `.preview-tmp-${timestamp}`);
      fs.mkdirSync(tmpDir, { recursive: true });

      try {
        const clipPaths: string[] = [];

        // Extract each clip via ffmpeg
        for (let i = 0; i < clips.length; i++) {
          const clip = clips[i];
          const sourcePath = resolveAssetPath(sourceMap, clip.asset_id);
          if (!sourcePath) {
            res.status(500).json({
              error: `Source file not found for asset ${clip.asset_id}`,
            });
            return;
          }

          const startSec = clip.src_in_us / 1_000_000;
          const durationSec =
            (clip.src_out_us - clip.src_in_us) / 1_000_000;
          const clipOutPath = path.join(
            tmpDir,
            `clip_${String(i).padStart(4, "0")}.mp4`,
          );

          await execFilePromise("ffmpeg", [
            "-y",
            "-ss",
            startSec.toFixed(6),
            "-i",
            sourcePath,
            "-t",
            durationSec.toFixed(6),
            "-vf",
            "scale=-2:720",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-crf",
            "28",
            "-an",
            "-pix_fmt",
            "yuv420p",
            clipOutPath,
          ]);
          clipPaths.push(clipOutPath);
        }

        // Concatenate clips
        if (clipPaths.length === 1) {
          fs.renameSync(clipPaths[0], outputPath);
        } else {
          const concatFilePath = path.join(tmpDir, "concat.txt");
          const concatContent = clipPaths
            .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
            .join("\n");
          fs.writeFileSync(concatFilePath, concatContent, "utf-8");

          await execFilePromise("ffmpeg", [
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            concatFilePath,
            "-c",
            "copy",
            outputPath,
          ]);
        }

        // Calculate total duration
        const totalFrames = clips.reduce(
          (sum, c) => sum + c.timeline_duration_frames,
          0,
        );
        const durationSec = totalFrames / fps;

        res.json({
          previewUrl: `/api/projects/${projectId}/preview/${outputFilename}`,
          clipCount: clips.length,
          durationSec,
        });
      } finally {
        // Clean up temp directory
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch (err) {
      res.status(500).json({
        error: "Preview generation failed",
        details: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // GET /api/projects/:id/preview/:filename — serve generated preview
  router.get("/:id/preview/:filename", (req, res) => {
    const projectId = req.params.id;
    const filename = req.params.filename;

    // Prevent path traversal
    if (filename.includes("..") || filename.includes("/")) {
      res.status(400).json({ error: "Invalid filename" });
      return;
    }

    const filePath = path.join(
      projectsDir,
      projectId,
      "05_timeline",
      filename,
    );

    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: "Preview file not found" });
      return;
    }

    res.sendFile(filePath);
  });

  return router;
}
