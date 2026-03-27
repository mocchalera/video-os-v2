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
import * as http from "node:http";
import * as path from "node:path";
import { createTimelineRouter } from "./routes/timeline.js";
import { createPreviewRouter } from "./routes/preview.js";
import { createMediaRouter } from "./routes/media.js";
import { createThumbnailRouter } from "./routes/thumbnails.js";
import { createReviewRouter } from "./routes/review.js";
import { createSelectsRouter } from "./routes/selects.js";
import { createAiJobsRouter } from "./routes/ai-jobs.js";
import { createWaveformRouter } from "./routes/waveforms.js";
import { safeProjectDir } from "./utils.js";
import { TimelineWatchHub } from "./services/watch-hub.js";
import { ProjectSocketHub } from "./services/project-socket-hub.js";

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
// v3: returns normalized { items: [...], assets: { asset_id -> { media_id, playback_strategy } } }
app.get("/api/projects/:id/source-map", (req, res) => {
  const projDir = safeProjectDir(resolvedProjectsDir, req.params.id);
  if (!projDir) {
    res.status(400).json({ error: "Invalid project ID" });
    return;
  }

  // Try multiple source_map locations
  let sourceMapPath = path.join(projDir, "02_media", "source_map.json");
  if (!fs.existsSync(sourceMapPath)) {
    sourceMapPath = path.join(projDir, "03_analysis", "source_map.json");
  }

  if (!fs.existsSync(sourceMapPath)) {
    res.status(404).json({ error: "Source map not found" });
    return;
  }

  try {
    const content = fs.readFileSync(sourceMapPath, "utf-8");
    const raw = JSON.parse(content) as {
      items?: Array<{
        asset_id?: string;
        filename?: string;
        local_source_path?: string;
        link_path?: string;
        source_locator?: string;
        [key: string]: unknown;
      }>;
    };

    // Build v3 normalized assets map alongside raw items
    const projectId = req.params.id;
    const assets: Record<
      string,
      { media_id: string; playback_strategy: { kind: string; url: string } }
    > = {};
    for (const item of raw.items ?? []) {
      if (!item.asset_id) continue;
      const mediaId = `media_${item.asset_id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
      assets[item.asset_id] = {
        media_id: mediaId,
        playback_strategy: {
          kind: "direct",
          url: `/api/projects/${projectId}/media/by-asset/${encodeURIComponent(item.asset_id)}`,
        },
      };
    }

    res.json({ ...raw, assets });
  } catch (err) {
    res.status(500).json({
      error: "Failed to read source map",
      details: err instanceof Error ? err.message : String(err),
    });
  }
});

// Notify callback — wired to watchHub after server starts.
// Uses a late-binding function ref so route modules don't depend on initialization order.
let notifyWriteImpl: (
  projectId: string,
  eventType: "timeline.changed" | "review.changed" | "project-state.changed" | "render.changed",
  source: "external" | "api-save" | "patch-apply" | "ai-job",
) => void = () => {};
const notifyWrite: typeof notifyWriteImpl = (...args) => notifyWriteImpl(...args);

// Mount route modules
// ensureWatch is a late-binding ref like notifyWrite
let ensureWatchImpl: (projectId: string, projectDir: string) => void = () => {};
const ensureWatch: typeof ensureWatchImpl = (...args) => ensureWatchImpl(...args);

app.use("/api/projects", createTimelineRouter(resolvedProjectsDir, notifyWrite, ensureWatch));
app.use("/api/projects", createPreviewRouter(resolvedProjectsDir));
app.use("/api/projects", createMediaRouter(resolvedProjectsDir));
app.use("/api/projects", createThumbnailRouter(resolvedProjectsDir));
app.use("/api/projects", createReviewRouter(resolvedProjectsDir, notifyWrite));
app.use("/api/projects", createSelectsRouter(resolvedProjectsDir));
app.use("/api/projects", createAiJobsRouter(resolvedProjectsDir));
app.use("/api/projects", createWaveformRouter(resolvedProjectsDir));

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

// ── Start server with WebSocket support ───────────────────────────

const server = http.createServer(app);

// Initialize WebSocket hub (handles upgrade via server "upgrade" event)
const socketHub = new ProjectSocketHub(server, resolvedProjectsDir);

// Initialize file watcher hub — broadcasts via socketHub
const watchHub = new TimelineWatchHub((event) => {
  socketHub.broadcast(event);
});

// Wire the notify callback now that watchHub exists
notifyWriteImpl = (projectId, eventType, source) => {
  watchHub.notifyWrite(projectId, eventType, source);
};

// Wire the ensureWatch callback
ensureWatchImpl = (projectId, projectDir) => {
  watchHub.watchProject(projectId, projectDir);
};

// Export hubs for use by route modules
export { watchHub, socketHub };

server.listen(port, () => {
  console.log(`\n  Video OS Editor Server`);
  console.log(`  ─────────────────────`);
  console.log(`  URL:         http://localhost:${port}`);
  console.log(`  WebSocket:   ws://localhost:${port}/api/ws?projectId=<id>`);
  console.log(`  Projects:    ${resolvedProjectsDir}`);
  console.log(`  Health:      http://localhost:${port}/api/health`);
  console.log(`  API:         http://localhost:${port}/api/projects\n`);

  // Start watching projects that have timelines
  try {
    const entries = fs.readdirSync(resolvedProjectsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const projectPath = path.join(resolvedProjectsDir, entry.name);
      const timelinePath = path.join(projectPath, "05_timeline", "timeline.json");
      if (fs.existsSync(timelinePath)) {
        watchHub.watchProject(entry.name, projectPath);
        console.log(`  Watching:    ${entry.name}`);
      }
    }
  } catch {
    console.warn("  Warning: Could not scan projects for watching");
  }

  console.log();
});
