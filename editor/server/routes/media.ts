/**
 * Media streaming API route with Range header support.
 *
 * GET /api/projects/:id/media/:filename — Stream source media files
 */

import { Router } from "express";
import * as fs from "node:fs";
import * as path from "node:path";

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

export function createMediaRouter(projectsDir: string): Router {
  const router = Router();

  // GET /api/projects/:id/media/:filename
  router.get("/:id/media/:filename", (req, res) => {
    const projectId = req.params.id;
    const filename = req.params.filename;

    // Prevent path traversal
    if (filename.includes("..") || filename.includes("/")) {
      res.status(400).json({ error: "Invalid filename" });
      return;
    }

    // Look for file in 02_media/ directory
    const mediaDir = path.join(projectsDir, projectId, "02_media");
    const filePath = path.join(mediaDir, filename);

    // Also check subdirectories (e.g. 02_media/bgm/)
    let resolvedPath = filePath;
    if (!fs.existsSync(resolvedPath)) {
      // Search subdirectories
      const found = findFileInDir(mediaDir, filename);
      if (found) {
        resolvedPath = found;
      } else {
        res.status(404).json({ error: "Media file not found" });
        return;
      }
    }

    // Verify the resolved path is within the project directory
    const projectDir = path.join(projectsDir, projectId);
    const realPath = fs.realpathSync(resolvedPath);
    // Allow symlinks that point outside the project (source media files)
    // but verify the media directory entry itself is within the project
    if (!resolvedPath.startsWith(projectDir)) {
      res.status(403).json({ error: "Access denied" });
      return;
    }

    const stat = fs.statSync(realPath);
    const fileSize = stat.size;
    const ext = path.extname(filename).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

    const rangeHeader = req.headers.range;

    if (rangeHeader) {
      // Parse Range header
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
  });

  return router;
}

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
