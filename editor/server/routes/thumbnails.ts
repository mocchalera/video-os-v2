/**
 * Thumbnail generation API route.
 *
 * GET /api/projects/:id/thumbnail/:clipId — Extract a mid-frame thumbnail via ffmpeg
 */

import { Router } from "express";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  MAX_THUMBNAIL_SIZE,
  parseThumbnailDimension,
} from "../../shared/thumbnail-dimensions.js";
import { resolveAllowedSourceMapPath, safeProjectDir } from "../utils.js";

interface TimelineClip {
  clip_id: string;
  asset_id: string;
  src_in_us: number;
  src_out_us: number;
}

interface TimelineTrack {
  clips: TimelineClip[];
}

interface TimelineData {
  tracks: {
    video: TimelineTrack[];
    audio: TimelineTrack[];
    overlay?: TimelineTrack[];
    caption?: TimelineTrack[];
  };
}

interface SourceMapDoc {
  items: Array<{
    asset_id: string;
    source_locator: string;
    local_source_path: string;
    link_path?: string;
  }>;
}

const DEFAULT_THUMBNAIL_WIDTH = 160;
const DEFAULT_THUMBNAIL_HEIGHT = 90;

function execFilePromise(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(err);
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
}

function findClipById(
  timeline: TimelineData,
  clipId: string,
): TimelineClip | undefined {
  const allTracks = [
    ...timeline.tracks.video,
    ...timeline.tracks.audio,
    ...(timeline.tracks.overlay ?? []),
    ...(timeline.tracks.caption ?? []),
  ];
  for (const track of allTracks) {
    const clip = track.clips.find((c) => c.clip_id === clipId);
    if (clip) return clip;
  }
  return undefined;
}

function resolveAssetPath(
  projectDir: string,
  sourceMapPath: string,
  sourceMap: SourceMapDoc,
  assetId: string,
): string | undefined {
  const entry = sourceMap.items.find((i) => i.asset_id === assetId);
  if (!entry) return undefined;

  return resolveAllowedSourceMapPath(projectDir, sourceMapPath, entry) ?? undefined;
}

function thumbnailFilter(width: number, height: number): string {
  // ffmpeg can round force_original_aspect_ratio output one pixel above an odd
  // target size (for example 85x48), which makes the following pad fail.
  const scaleWidth = Math.max(2, width - (width % 2));
  const scaleHeight = Math.max(2, height - (height % 2));
  return `scale=${scaleWidth}:${scaleHeight}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`;
}

async function extractThumbnail(
  sourcePath: string,
  thumbPath: string,
  seekSec: number,
  width: number,
  height: number,
): Promise<void> {
  const runFfmpeg = (atSec: number) =>
    execFilePromise("ffmpeg", [
      "-y",
      "-ss",
      atSec.toFixed(6),
      "-i",
      sourcePath,
      "-vframes",
      "1",
      "-vf",
      thumbnailFilter(width, height),
      "-q:v",
      "5",
      thumbPath,
    ]);

  try {
    await runFfmpeg(seekSec);
  } catch (error) {
    if (seekSec <= 0) {
      throw error;
    }
    fs.rmSync(thumbPath, { force: true });
    await runFfmpeg(0);
  }
}

export function createThumbnailRouter(projectsDir: string): Router {
  const router = Router();

  // GET /api/projects/:id/thumbnail/by-clip/:clipId
  router.get("/:id/thumbnail/by-clip/:clipId", async (req, res) => {
    const projectDir = safeProjectDir(projectsDir, req.params.id);
    if (!projectDir) {
      res.status(400).json({ error: "Invalid project ID" });
      return;
    }
    const clipId = req.params.clipId;

    // Prevent path traversal in clipId
    if (!clipId || clipId.includes("..") || clipId.includes("/") || clipId.includes("%2F") || clipId.includes("%2f") || clipId.includes("\0")) {
      res.status(400).json({ error: "Invalid clip ID" });
      return;
    }

    const timelinePath = path.join(projectDir, "05_timeline", "timeline.json");
    const sourceMapPath = path.join(projectDir, "02_media", "source_map.json");

    if (!fs.existsSync(timelinePath)) {
      res.status(404).json({ error: "Timeline not found", project: req.params.id });
      return;
    }

    try {
      const timeline: TimelineData = JSON.parse(
        fs.readFileSync(timelinePath, "utf-8"),
      );

      const clip = findClipById(timeline, clipId);
      if (!clip) {
        res.status(404).json({
          error: "Clip not found",
          details: `No clip with id ${clipId}`,
        });
        return;
      }

      // Load source map
      let sourceMap: SourceMapDoc = { items: [] };
      if (fs.existsSync(sourceMapPath)) {
        sourceMap = JSON.parse(fs.readFileSync(sourceMapPath, "utf-8"));
      }

      const sourcePath = resolveAssetPath(projectDir, sourceMapPath, sourceMap, clip.asset_id);
      if (!sourcePath) {
        res.status(500).json({
          error: `Source file not found for asset ${clip.asset_id}`,
        });
        return;
      }

      // Use cache directory for thumbnails
      const cacheDir = path.join(projectDir, "05_timeline", ".thumbnail-cache");
      fs.mkdirSync(cacheDir, { recursive: true });

      const thumbPath = path.join(cacheDir, `${clipId}.jpg`);

      // Return cached thumbnail if available
      if (fs.existsSync(thumbPath)) {
        res.setHeader("Content-Type", "image/jpeg");
        res.setHeader("Cache-Control", "public, max-age=3600");
        fs.createReadStream(thumbPath).pipe(res);
        return;
      }

      // Extract thumbnail at the midpoint of the clip
      const midpointUs = (clip.src_in_us + clip.src_out_us) / 2;
      const seekSec = midpointUs / 1_000_000;

      await extractThumbnail(sourcePath, thumbPath, seekSec, 160, 90);

      if (!fs.existsSync(thumbPath)) {
        res.status(500).json({ error: "Thumbnail generation failed" });
        return;
      }

      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "public, max-age=3600");
      fs.createReadStream(thumbPath).pipe(res);
    } catch (err) {
      res.status(500).json({
        error: "Thumbnail generation failed",
        details: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // GET /api/projects/:id/thumbnail/by-asset/:assetId — Generate thumbnail by asset ID + frame_us
  router.get("/:id/thumbnail/by-asset/:assetId", async (req, res) => {
    const projectDir = safeProjectDir(projectsDir, req.params.id);
    if (!projectDir) {
      res.status(400).json({ error: "Invalid project ID" });
      return;
    }

    const assetId = req.params.assetId;
    if (!assetId || assetId.includes("..") || assetId.includes("/") || assetId.includes("%2F") || assetId.includes("%2f")) {
      res.status(400).json({ error: "Invalid asset ID" });
      return;
    }

    const frameUs = parseInt(req.query.frame_us as string, 10);
    if (isNaN(frameUs) || frameUs < 0) {
      res.status(400).json({ error: "frame_us query parameter is required and must be >= 0" });
      return;
    }

    const width = parseThumbnailDimension(req.query.width, DEFAULT_THUMBNAIL_WIDTH);
    const height = parseThumbnailDimension(req.query.height, DEFAULT_THUMBNAIL_HEIGHT);
    if (width === null || height === null) {
      res.status(400).json({
        error: `width and height must be integers between 1 and ${MAX_THUMBNAIL_SIZE}`,
      });
      return;
    }

    try {
      // Load source map
      const sourceMapPath = path.join(projectDir, "02_media", "source_map.json");
      let sourceMap: SourceMapDoc = { items: [] };
      if (fs.existsSync(sourceMapPath)) {
        sourceMap = JSON.parse(fs.readFileSync(sourceMapPath, "utf-8"));
      }

      const sourcePath = resolveAssetPath(projectDir, sourceMapPath, sourceMap, assetId);
      if (!sourcePath) {
        res.status(404).json({ error: `Source file not found for asset ${assetId}` });
        return;
      }

      // Cache directory per design doc: .cache/thumbs/
      const cacheDir = path.join(projectDir, ".cache", "thumbs");
      fs.mkdirSync(cacheDir, { recursive: true });

      const thumbKey = `${assetId}_${frameUs}_${width}x${height}`;
      const thumbPath = path.join(cacheDir, `${thumbKey}.jpg`);

      // Return cached thumbnail if available
      if (fs.existsSync(thumbPath)) {
        res.setHeader("Content-Type", "image/jpeg");
        res.setHeader("Cache-Control", "public, max-age=3600");
        fs.createReadStream(thumbPath).pipe(res);
        return;
      }

      // Extract thumbnail at specified frame
      const seekSec = frameUs / 1_000_000;

      await extractThumbnail(sourcePath, thumbPath, seekSec, width, height);

      if (!fs.existsSync(thumbPath)) {
        res.status(500).json({ error: "Thumbnail generation failed" });
        return;
      }

      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "public, max-age=3600");
      fs.createReadStream(thumbPath).pipe(res);
    } catch (err) {
      res.status(500).json({
        error: "Thumbnail generation failed",
        details: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return router;
}
