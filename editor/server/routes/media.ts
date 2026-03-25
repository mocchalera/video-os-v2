/**
 * Media streaming API route with Range header support.
 * Automatically transcodes browser-incompatible codecs (e.g. pcm_s16be)
 * via ffmpeg and caches the result for subsequent requests.
 *
 * GET /api/projects/:id/media/:filename — Stream source media files
 */

import { Router } from "express";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { safeProjectDir } from "../utils.js";

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

/** Video codecs that browsers can natively decode. */
const BROWSER_COMPATIBLE_VIDEO_CODECS = new Set([
  "h264",
  "hevc",
  "vp8",
  "vp9",
  "av1",
]);

/** In-flight transcoding promises keyed by cache path — prevents duplicate jobs. */
const inflightTranscodes = new Map<string, Promise<string>>();

export function createMediaRouter(projectsDir: string): Router {
  const router = Router();

  // GET /api/projects/:id/media/:filename
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
              const srcPath = entry.local_source_path || entry.link_path || entry.source_locator;
              if (srcPath && fs.existsSync(srcPath)) {
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
      const needsTranscode = await checkNeedsTranscode(realPath);

      if (needsTranscode) {
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

async function probeCodecs(filePath: string): Promise<ProbeResult> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "quiet",
    "-print_format", "json",
    "-show_streams",
    "-select_streams", "v:0,a:0",
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

async function checkNeedsTranscode(filePath: string): Promise<boolean> {
  try {
    const { audioCodec, videoCodec } = await probeCodecs(filePath);

    if (audioCodec && !BROWSER_COMPATIBLE_AUDIO_CODECS.has(audioCodec)) {
      return true;
    }
    if (videoCodec && !BROWSER_COMPATIBLE_VIDEO_CODECS.has(videoCodec)) {
      return true;
    }

    return false;
  } catch {
    // If ffprobe fails, fall back to direct serving
    return false;
  }
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
  return path.join(cacheDir, `${baseName}.mp4`);
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
      "-c:v", "copy",
      "-c:a", "aac",
      "-b:a", "128k",
      "-movflags", "frag_keyframe+empty_moov",
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
