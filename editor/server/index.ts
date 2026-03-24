/**
 * Video OS v2 — Editor Backend Server
 *
 * Express server that provides API endpoints for the Web timeline editor.
 *
 * Usage:
 *   npx tsx editor/server/index.ts --project projects/demo --port 3100
 */

import express from "express";
import cors from "cors";
import * as fs from "node:fs";
import * as path from "node:path";
import { createTimelineRouter } from "./routes/timeline.js";
import { createPreviewRouter } from "./routes/preview.js";
import { createMediaRouter } from "./routes/media.js";
import { createThumbnailRouter } from "./routes/thumbnails.js";
import { createReviewRouter } from "./routes/review.js";
import { createSelectsRouter } from "./routes/selects.js";
import { createAiJobsRouter } from "./routes/ai-jobs.js";
import { safeProjectDir } from "./utils.js";

// ── CLI argument parsing ──────────────────────────────────────────

function parseArgs(argv: string[]): { projectsDir: string; port: number } {
  let projectsDir = "projects";
  let port = 3100;

  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--project" && argv[i + 1]) {
      projectsDir = argv[++i];
    } else if (argv[i] === "--port" && argv[i + 1]) {
      port = parseInt(argv[++i], 10);
    }
  }

  return { projectsDir: path.resolve(projectsDir), port };
}

const { projectsDir, port } = parseArgs(process.argv);

// ── Validate projects directory ───────────────────────────────────

// --project may point to either a projects container directory (projects/)
// or a specific project (projects/demo). Detect which case by checking for
// 05_timeline/ in the path.
let resolvedProjectsDir = projectsDir;
if (
  fs.existsSync(path.join(projectsDir, "05_timeline")) ||
  fs.existsSync(path.join(projectsDir, "02_media"))
) {
  // --project points to a specific project, use its parent as container
  resolvedProjectsDir = path.dirname(projectsDir);
}

if (!fs.existsSync(resolvedProjectsDir)) {
  console.error(`Projects directory not found: ${resolvedProjectsDir}`);
  process.exit(1);
}

// ── Express setup ─────────────────────────────────────────────────

const app = express();

// CORS — allow localhost Vite dev server
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "http://localhost:5555",
      "http://127.0.0.1:5173",
      "http://127.0.0.1:5555",
    ],
    methods: ["GET", "PUT", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Range", "If-Match"],
    exposedHeaders: ["Content-Range", "Accept-Ranges", "Content-Length", "ETag"],
  }),
);

// JSON body parser (50MB limit for large timelines)
app.use(express.json({ limit: "50mb" }));

// ── Routes ────────────────────────────────────────────────────────

// GET /api/projects — list available projects
app.get("/api/projects", (_req, res) => {
  try {
    const entries = fs.readdirSync(resolvedProjectsDir, {
      withFileTypes: true,
    });
    const projects = entries
      .filter((e) => e.isDirectory())
      .map((e) => {
        const projectPath = path.join(resolvedProjectsDir, e.name);
        const timelinePath = path.join(
          projectPath,
          "05_timeline",
          "timeline.json",
        );
        return {
          id: e.name,
          name: e.name,
          hasTimeline: fs.existsSync(timelinePath),
          path: projectPath,
        };
      })
      .filter((p) => p.hasTimeline);

    res.json({ projects });
  } catch (err) {
    res.status(500).json({
      error: "Failed to list projects",
      details: err instanceof Error ? err.message : String(err),
    });
  }
});

// GET /api/projects/:id/source-map
app.get("/api/projects/:id/source-map", (req, res) => {
  const projDir = safeProjectDir(resolvedProjectsDir, req.params.id);
  if (!projDir) {
    res.status(400).json({ error: "Invalid project ID" });
    return;
  }

  const sourceMapPath = path.join(projDir, "02_media", "source_map.json");

  if (!fs.existsSync(sourceMapPath)) {
    res.status(404).json({ error: "Source map not found" });
    return;
  }

  try {
    const content = fs.readFileSync(sourceMapPath, "utf-8");
    res.json(JSON.parse(content));
  } catch (err) {
    res.status(500).json({
      error: "Failed to read source map",
      details: err instanceof Error ? err.message : String(err),
    });
  }
});

// Mount route modules
app.use("/api/projects", createTimelineRouter(resolvedProjectsDir));
app.use("/api/projects", createPreviewRouter(resolvedProjectsDir));
app.use("/api/projects", createMediaRouter(resolvedProjectsDir));
app.use("/api/projects", createThumbnailRouter(resolvedProjectsDir));
app.use("/api/projects", createReviewRouter(resolvedProjectsDir));
app.use("/api/projects", createSelectsRouter(resolvedProjectsDir));
app.use("/api/projects", createAiJobsRouter(resolvedProjectsDir));

// ── Health check ──────────────────────────────────────────────────

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    projectsDir: resolvedProjectsDir,
    timestamp: new Date().toISOString(),
  });
});

// ── Error handler ─────────────────────────────────────────────────

app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error("Unhandled error:", err);
    res.status(500).json({
      error: "Internal server error",
      details: err.message,
    });
  },
);

// ── Start server ──────────────────────────────────────────────────

app.listen(port, () => {
  console.log(`\n  Video OS Editor Server`);
  console.log(`  ─────────────────────`);
  console.log(`  URL:         http://localhost:${port}`);
  console.log(`  Projects:    ${resolvedProjectsDir}`);
  console.log(`  Health:      http://localhost:${port}/api/health`);
  console.log(`  API:         http://localhost:${port}/api/projects\n`);
});
