/**
 * Media streaming API route with Range header support.
 * Automatically transcodes browser-incompatible codecs (e.g. pcm_s16be)
 * via ffmpeg and caches the result for subsequent requests.
 *
 * GET /api/projects/:id/media/:filename — Stream source media files
 */

import { Router } from "express";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { resolveAllowedSourceMapPath, safeProjectDir } from "../utils.js";

const execFileAsync = promisify(execFile);

const MIME_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mxf": "application/mxf",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".aac": "audio/aac",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".aif": "audio/aiff",
  ".aiff": "audio/aiff",
};

/** Audio codecs that browsers can natively decode. */
const BROWSER_COMPATIBLE_AUDIO_CODECS = new Set([
  "aac",
  "mp3",
  "opus",
  "vorbis",
  "flac",
  "pcm_s16le", // WAV little-endian
  "pcm_f32le",
]);

/** Video codecs that browsers can natively decode in the containers we serve directly. */
const BROWSER_COMPATIBLE_VIDEO_CODECS = new Set([
  "h264",
  "vp8",
  "vp9",
  "av1",
]);

const DIRECT_PLAYBACK_CONTAINERS = new Set([
  ".mp4",
  ".webm",
  ".mp3",
  ".wav",
  ".aac",
  ".m4a",
  ".flac",
]);

const TRANSCODE_CACHE_VERSION = "h264-aac-v2";

/** In-flight transcoding promises keyed by cache path — prevents duplicate jobs. */
const inflightTranscodes = new Map<string, Promise<string>>();

/** Resolve asset_id to a local file path using source_map. */
function resolveAssetPath(
  projectDir: string,
  assetId: string,
): string | null {
  for (const smName of [
    "02_media/source_map.json",
    "03_analysis/source_map.json",
  ]) {
    const smPath = path.join(projectDir, smName);
    if (!fs.existsSync(smPath)) continue;
    try {
      const sm = JSON.parse(fs.readFileSync(smPath, "utf-8"));
      const entry = (sm.items || []).find(
        (i: { asset_id?: string }) => i.asset_id === assetId,
      );
      if (!entry) continue;
      const srcPath = resolveAllowedSourceMapPath(projectDir, smPath, entry);
      if (srcPath) return srcPath;
      // Fallback: resolve filename in 02_media/
      const filename =
        entry.filename ??
        entry.link_path?.split("/").pop() ??
        entry.local_source_path?.split("/").pop() ??
        entry.source_locator?.split("/").pop() ??
        entry.link_path?.split("\\").pop() ??
        entry.local_source_path?.split("\\").pop() ??
        entry.source_locator?.split("\\").pop();
      if (filename) {
        const mediaDir = path.join(projectDir, "02_media");
        const filePath = path.join(mediaDir, filename);
        if (fs.existsSync(filePath)) return filePath;
        const found = findFileInDir(mediaDir, filename);
        if (found) return found;
      }
    } catch {
      /* ignore parse errors */
    }
  }
  return null;
}

/** Generate a collision-resistant cache key from realPath + mtime + codec info. */
function getCacheKeyPath(
  projectDir: string,
  realPath: string,
): string {
  const stat = fs.statSync(realPath);
  const hash = crypto
    .createHash("sha256")
    .update(`${TRANSCODE_CACHE_VERSION}:${realPath}:${stat.mtimeMs}`)
    .digest("hex")
    .slice(0, 16);
  const cacheDir = path.join(projectDir, ".proxy-cache");
  return path.join(cacheDir, `${hash}.mp4`);
}

export function createMediaRouter(projectsDir: string): Router {
  const router = Router();

  // GET /api/projects/:id/media/by-asset/:assetId
  // v3 canonical endpoint: resolve asset_id → source file → stream
  router.get("/:id/media/by-asset/:assetId", async (req, res) => {
    try {
      const projectDir = safeProjectDir(projectsDir, req.params.id);
      if (!projectDir) {
        res.status(400).json({ error: "Invalid project ID" });
        return;
      }

      const assetId = req.params.assetId;
      const resolvedPath = resolveAssetPath(projectDir, assetId);
      if (!resolvedPath || !fs.existsSync(resolvedPath)) {
        res.status(404).json({ error: "Asset not found", asset_id: assetId });
        return;
      }

      const realPath = fs.realpathSync(resolvedPath);

      // Force transcode when ?transcode=1 is set (MEDIA_ERR_SRC_NOT_SUPPORTED fallback)
      const forceTranscode = req.query.transcode === "1";
      const compatibility = await analyzePlaybackCompatibility(realPath);
      const needsTranscode =
        forceTranscode ||
        (compatibility.needsTranscode && compatibility.reason !== "audio");

      if (needsTranscode) {
        if (forceTranscode && isTooLargeForFullTranscode(realPath)) {
          rejectLargeFullTranscode(res, realPath);
          return;
        }
        await serveTranscodedV3(req, res, realPath, projectDir);
      } else {
        serveDirect(req, res, realPath, path.basename(realPath));
      }
    } catch (err) {
      console.error("[media] Error serving asset:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  });

  // GET /api/projects/:id/media/probe/:assetId
  // Returns { has_video, has_audio } via ffprobe — cross-browser reliable topology detection
  router.get("/:id/media/probe/:assetId", async (req, res) => {
    try {
      const projectDir = safeProjectDir(projectsDir, req.params.id);
      if (!projectDir) {
        res.status(400).json({ error: "Invalid project ID" });
        return;
      }

      const assetId = req.params.assetId;
      const resolvedPath = resolveAssetPath(projectDir, assetId);
      if (!resolvedPath || !fs.existsSync(resolvedPath)) {
        res.status(404).json({ error: "Asset not found", asset_id: assetId });
        return;
      }

      const realPath = fs.realpathSync(resolvedPath);
      const { audioCodec, videoCodec } = await probeCodecs(realPath);

      res.json({
        asset_id: assetId,
        has_video: videoCodec !== null,
        has_audio: audioCodec !== null,
      });
    } catch (err) {
      console.error("[media] Error probing asset:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Probe failed" });
      }
    }
  });

  // GET /api/projects/:id/media/:filename (backward-compat)
  router.get("/:id/media/:filename", async (req, res) => {
    try {
      const projectDir = safeProjectDir(projectsDir, req.params.id);
      if (!projectDir) {
        res.status(400).json({ error: "Invalid project ID" });
        return;
      }

      const filename = req.params.filename;

      // Prevent path traversal (including %2F decode attacks)
      if (filename.includes("..") || filename.includes("/") || filename.includes("%2F") || filename.includes("%2f") || filename.includes("\0")) {
        res.status(400).json({ error: "Invalid filename" });
        return;
      }

      // Resolve file: check source_map first, then 02_media/
      let resolvedPath: string | null = null;

      // 1. Try source_map (local_source_path by filename match)
      for (const smName of ["02_media/source_map.json", "03_analysis/source_map.json"]) {
        const smPath = path.join(projectDir, smName);
        if (fs.existsSync(smPath)) {
          try {
            const sm = JSON.parse(fs.readFileSync(smPath, "utf-8"));
            const entry = (sm.items || []).find((i: { filename?: string }) => i.filename === filename);
            if (entry) {
              const srcPath = resolveAllowedSourceMapPath(projectDir, smPath, entry);
              if (srcPath) {
                resolvedPath = srcPath;
                break;
              }
            }
          } catch { /* ignore parse errors */ }
        }
      }

      // 2. Fallback: look in 02_media/ directory
      if (!resolvedPath) {
        const mediaDir = path.join(projectDir, "02_media");
        const filePath = path.join(mediaDir, filename);
        if (fs.existsSync(filePath)) {
          resolvedPath = filePath;
        } else {
          const found = findFileInDir(mediaDir, filename);
          if (found) resolvedPath = found;
        }
      }

      if (!resolvedPath || !fs.existsSync(resolvedPath)) {
        res.status(404).json({ error: "Media file not found" });
        return;
      }

      const realPath = fs.realpathSync(resolvedPath);

      // Check if transcoding is needed
      const forceTranscode = req.query.transcode === "1";
      const compatibility = await analyzePlaybackCompatibility(realPath);
      const needsTranscode =
        forceTranscode ||
        (compatibility.needsTranscode && compatibility.reason !== "audio");

      if (needsTranscode) {
        if (forceTranscode && isTooLargeForFullTranscode(realPath)) {
          rejectLargeFullTranscode(res, realPath);
          return;
        }
        await serveTranscoded(req, res, realPath, projectDir, filename);
      } else {
        serveDirect(req, res, realPath, filename);
      }
    } catch (err) {
      console.error("[media] Error serving media:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  });

  return router;
}

// ── Codec detection ─────────────────────────────────────────────────

interface ProbeResult {
  audioCodec: string | null;
  videoCodec: string | null;
}

type TranscodeReason = "container" | "video" | "audio";

interface CompatibilityResult extends ProbeResult {
  needsTranscode: boolean;
  reason: TranscodeReason | null;
}

const MAX_FULL_TRANSCODE_BYTES = 1 * 1024 * 1024 * 1024;

async function probeCodecs(filePath: string): Promise<ProbeResult> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "quiet",
    "-print_format", "json",
    "-show_streams",
    filePath,
  ]);

  const data = JSON.parse(stdout);
  let audioCodec: string | null = null;
  let videoCodec: string | null = null;

  for (const stream of data.streams ?? []) {
    if (stream.codec_type === "audio" && !audioCodec) {
      audioCodec = stream.codec_name;
    }
    if (stream.codec_type === "video" && !videoCodec) {
      videoCodec = stream.codec_name;
    }
  }

  return { audioCodec, videoCodec };
}

async function analyzePlaybackCompatibility(filePath: string): Promise<CompatibilityResult> {
  try {
    const ext = path.extname(filePath).toLowerCase();
    const { audioCodec, videoCodec } = await probeCodecs(filePath);

    if (videoCodec && !DIRECT_PLAYBACK_CONTAINERS.has(ext)) {
      return { audioCodec, videoCodec, needsTranscode: true, reason: "container" };
    }
    if (videoCodec && !BROWSER_COMPATIBLE_VIDEO_CODECS.has(videoCodec)) {
      return { audioCodec, videoCodec, needsTranscode: true, reason: "video" };
    }
    if (audioCodec && !BROWSER_COMPATIBLE_AUDIO_CODECS.has(audioCodec)) {
      return { audioCodec, videoCodec, needsTranscode: true, reason: "audio" };
    }

    return { audioCodec, videoCodec, needsTranscode: false, reason: null };
  } catch {
    // If ffprobe fails, fall back to direct serving.
    return { audioCodec: null, videoCodec: null, needsTranscode: false, reason: null };
  }
}

async function checkNeedsTranscode(filePath: string): Promise<boolean> {
  return (await analyzePlaybackCompatibility(filePath)).needsTranscode;
}

function isTooLargeForFullTranscode(filePath: string): boolean {
  try {
    return fs.statSync(filePath).size > MAX_FULL_TRANSCODE_BYTES;
  } catch {
    return false;
  }
}

function rejectLargeFullTranscode(
  res: import("express").Response,
  realPath: string,
): void {
  res.status(422).json({
    error: "Source transcode is too large for interactive preview. Use exact preview render instead.",
    code: "source_transcode_too_large",
    max_bytes: MAX_FULL_TRANSCODE_BYTES,
    size_bytes: fs.statSync(realPath).size,
  });
}

// ── Direct serving (browser-compatible) ─────────────────────────────

function serveDirect(
  req: import("express").Request,
  res: import("express").Response,
  realPath: string,
  filename: string,
): void {
  const stat = fs.statSync(realPath);
  const fileSize = stat.size;
  const ext = path.extname(filename).toLowerCase();
  const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

  const rangeHeader = req.headers.range;

  if (rangeHeader) {
    const parts = rangeHeader.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    if (start >= fileSize || end >= fileSize || start > end) {
      res.status(416).json({ error: "Range not satisfiable" });
      return;
    }

    const chunkSize = end - start + 1;

    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunkSize,
      "Content-Type": contentType,
    });

    const stream = fs.createReadStream(realPath, { start, end });
    stream.pipe(res);
  } else {
    res.writeHead(200, {
      "Content-Length": fileSize,
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
    });

    const stream = fs.createReadStream(realPath);
    stream.pipe(res);
  }
}

// ── Transcoded serving (browser-incompatible codecs) ────────────────

function getCachePath(projectDir: string, filename: string): string {
  const cacheDir = path.join(projectDir, ".proxy-cache");
  const baseName = path.parse(filename).name;
  return path.join(cacheDir, `${baseName}.${TRANSCODE_CACHE_VERSION}.mp4`);
}

async function serveTranscoded(
  req: import("express").Request,
  res: import("express").Response,
  realPath: string,
  projectDir: string,
  filename: string,
): Promise<void> {
  const cachePath = getCachePath(projectDir, filename);

  // If cache exists, serve it directly with Range support
  if (fs.existsSync(cachePath)) {
    serveDirect(req, res, cachePath, path.basename(cachePath));
    return;
  }

  // Check for in-flight transcode of the same file
  let transcodePromise = inflightTranscodes.get(cachePath);
  if (!transcodePromise) {
    transcodePromise = transcode(realPath, cachePath);
    inflightTranscodes.set(cachePath, transcodePromise);
  }

  try {
    const cached = await transcodePromise;
    serveDirect(req, res, cached, path.basename(cached));
  } finally {
    inflightTranscodes.delete(cachePath);
  }
}

/** v3 transcode serving with collision-resistant cache keys. */
async function serveTranscodedV3(
  req: import("express").Request,
  res: import("express").Response,
  realPath: string,
  projectDir: string,
): Promise<void> {
  const cachePath = getCacheKeyPath(projectDir, realPath);

  if (fs.existsSync(cachePath)) {
    serveDirect(req, res, cachePath, path.basename(cachePath));
    return;
  }

  let transcodePromise = inflightTranscodes.get(cachePath);
  if (!transcodePromise) {
    transcodePromise = transcode(realPath, cachePath);
    inflightTranscodes.set(cachePath, transcodePromise);
  }

  try {
    const cached = await transcodePromise;
    serveDirect(req, res, cached, path.basename(cached));
  } finally {
    inflightTranscodes.delete(cachePath);
  }
}

function transcode(inputPath: string, outputPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const cacheDir = path.dirname(outputPath);
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }

    // Write to a temp file first, then rename — prevents serving partial files
    const tmpPath = `${outputPath}.tmp`;

    const proc = spawn("ffmpeg", [
      "-y",
      "-i", inputPath,
      "-map", "0:v:0?",
      "-map", "0:a:0?",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "128k",
      "-movflags", "+faststart",
      "-f", "mp4",
      tmpPath,
    ], { stdio: ["ignore", "ignore", "pipe"] });

    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      if (code === 0 && fs.existsSync(tmpPath)) {
        fs.renameSync(tmpPath, outputPath);
        resolve(outputPath);
      } else {
        // Clean up partial temp file
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`));
      }
    });

    proc.on("error", (err) => {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      reject(err);
    });
  });
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Find a file by name in a directory and its immediate subdirectories.
 */
function findFileInDir(dir: string, filename: string): string | undefined {
  if (!fs.existsSync(dir)) return undefined;

  // Check root
  const rootPath = path.join(dir, filename);
  if (fs.existsSync(rootPath)) return rootPath;

  // Check subdirectories (one level deep)
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const subPath = path.join(dir, entry.name, filename);
        if (fs.existsSync(subPath)) return subPath;
      }
    }
  } catch {
    // Ignore errors during directory scan
  }

  return undefined;
}
