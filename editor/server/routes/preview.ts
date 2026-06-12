/**
 * Preview API route — Phase 1: exact preview via RenderSpec.
 *
 * POST /api/projects/:id/preview — Queue exact preview render job
 * GET  /api/projects/:id/preview/status — Get current preview state
 * GET  /api/projects/:id/preview/previews/:filename — Serve preview artifacts
 * GET  /api/projects/:id/preview/:filename — Serve legacy preview files (backward compat)
 */

import { Router } from "express";
import * as fs from "node:fs";
import * as path from "node:path";
import { safeProjectDir } from "../utils.js";
import { computeTimelineRevision } from "./timeline.js";
import {
  buildRenderSpec,
  type AssetPathResolver,
} from "../../shared/render-spec.js";
import type { PreviewJobService } from "../services/preview-job-service.js";

// ── Source map types ─────────────────────────────────────────────────

interface SourceMapDoc {
  items: Array<{
    asset_id: string;
    source_locator: string;
    local_source_path: string;
  }>;
}

type PlaybackContractModule = {
  evaluatePlaybackContract: (projectPath: string) => unknown;
};

async function evaluateRuntimePlaybackContract(projectPath: string): Promise<unknown> {
  const runtimeModuleUrl = new URL(
    "../../../runtime/preview/playback-contract.js",
    import.meta.url,
  ).href;
  const mod = await import(runtimeModuleUrl) as PlaybackContractModule;
  return mod.evaluatePlaybackContract(projectPath);
}

// ── Route factory ────────────────────────────────────────────────────

export function createPreviewRouter(
  projectsDir: string,
  previewJobService: PreviewJobService,
): Router {
  const router = Router();

  /**
   * Resolve asset path from source_map.json.
   */
  function buildAssetResolver(
    sourceMap: SourceMapDoc,
  ): AssetPathResolver {
    return (assetId: string) => {
      const entry = sourceMap.items.find((i) => i.asset_id === assetId);
      if (!entry) return undefined;
      if (entry.local_source_path && fs.existsSync(entry.local_source_path)) {
        return entry.local_source_path;
      }
      if (entry.source_locator && fs.existsSync(entry.source_locator)) {
        return entry.source_locator;
      }
      return undefined;
    };
  }

  // ── POST /api/projects/:id/preview ─────────────────────────────────
  router.post("/:id/preview", async (req, res) => {
    const projectId = req.params.id;
    const projectDir = safeProjectDir(projectsDir, projectId);
    if (!projectDir) {
      res.status(400).json({ error: "Invalid project ID" });
      return;
    }

    const timelinePath = path.join(projectDir, "05_timeline", "timeline.json");
    const sourceMapPath = path.join(projectDir, "02_media", "source_map.json");

    if (!fs.existsSync(timelinePath)) {
      res.status(404).json({ error: "Timeline not found", project: projectId });
      return;
    }

    const body = req.body as {
      mode?: string;
      timelineRevision?: string;
    };
    const mode = body.mode ?? "full";

    if (!["full", "range", "clip"].includes(mode)) {
      res.status(400).json({
        error: "Invalid request",
        details: 'mode must be "full", "range", or "clip"',
      });
      return;
    }

    try {
      const timelineContent = fs.readFileSync(timelinePath, "utf-8");
      const timelineRevision = computeTimelineRevision(timelineContent);

      if (body.timelineRevision && body.timelineRevision !== timelineRevision) {
        res.status(409).json({
          error: "Timeline revision mismatch",
          current_revision: timelineRevision,
          client_revision: body.timelineRevision,
        });
        return;
      }

      const timeline = JSON.parse(timelineContent);

      // Load source map
      let sourceMap: SourceMapDoc = { items: [] };
      if (fs.existsSync(sourceMapPath)) {
        sourceMap = JSON.parse(fs.readFileSync(sourceMapPath, "utf-8"));
      }

      // Build RenderSpec
      // MAJOR-4: Look for caption_approval.json in project directory
      const captionApprovalPath = path.join(projectDir, "caption_approval.json");
      const hasCaptionApproval = fs.existsSync(captionApprovalPath);
      const resolveAssetPath = buildAssetResolver(sourceMap);
      const renderSpec = buildRenderSpec(
        timeline,
        timelineRevision,
        resolveAssetPath,
        hasCaptionApproval
          ? { captionApprovalPath }
          : undefined,
      );

      // Queue render job (returns immediately)
      const jobState = previewJobService.request(projectId, projectDir, renderSpec);

      // MAJOR-3 (Phase 5 review R1): include `error` so the client can read
      // `feature_disabled` when the flag is off and fall back to source.
      res.json({
        status: jobState.status,
        timelineRevision,
        renderSpecHash: renderSpec.renderSpecHash,
        previewUrl: jobState.previewUrl,
        warnings: jobState.warnings,
        error: jobState.error,
      });
    } catch (err) {
      res.status(500).json({
        error: "Preview request failed",
        details: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ── GET /api/projects/:id/preview/status ───────────────────────────
  router.get("/:id/preview/status", (req, res) => {
    const projectId = req.params.id;
    const projDir = safeProjectDir(projectsDir, projectId);
    if (!projDir) {
      res.status(400).json({ error: "Invalid project ID" });
      return;
    }

    const state = previewJobService.getState(projectId);

    // Compute currentRenderSpecHash from the on-disk timeline so the client
    // can verify whether the cached preview still matches the current state.
    let currentRenderSpecHash: string | null = null;
    try {
      const timelinePath = path.join(projDir, "05_timeline", "timeline.json");
      const sourceMapPath = path.join(projDir, "02_media", "source_map.json");
      if (fs.existsSync(timelinePath)) {
        const timelineContent = fs.readFileSync(timelinePath, "utf-8");
        const timeline = JSON.parse(timelineContent);
        let sourceMap: SourceMapDoc = { items: [] };
        if (fs.existsSync(sourceMapPath)) {
          sourceMap = JSON.parse(fs.readFileSync(sourceMapPath, "utf-8"));
        }
        const captionApprovalPath = path.join(projDir, "caption_approval.json");
        const hasCaptionApproval = fs.existsSync(captionApprovalPath);
        const resolveAssetPath = buildAssetResolver(sourceMap);
        const currentRevision = computeTimelineRevision(timelineContent);
        const currentSpec = buildRenderSpec(
          timeline,
          currentRevision,
          resolveAssetPath,
          hasCaptionApproval ? { captionApprovalPath } : undefined,
        );
        currentRenderSpecHash = currentSpec.renderSpecHash;
      }
    } catch {
      // Non-critical — currentRenderSpecHash stays null
    }

    res.json({
      timelineRevision: state.timelineRevision,
      renderSpecHash: state.renderSpecHash,
      currentRenderSpecHash,
      status: state.status,
      previewUrl: state.previewUrl,
      warnings: state.warnings,
      error: state.error,
    });
  });

  // ── GET /api/projects/:id/preview/contract ────────────────────────
  router.get("/:id/preview/contract", async (req, res) => {
    const projectId = req.params.id;
    const projDir = safeProjectDir(projectsDir, projectId);
    if (!projDir) {
      res.status(400).json({ error: "Invalid project ID" });
      return;
    }

    try {
      res.json(await evaluateRuntimePlaybackContract(projDir));
    } catch (err) {
      res.status(500).json({
        error: "Playback contract evaluation failed",
        details: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ── GET /api/projects/:id/preview/previews/:filename ───────────────
  router.get("/:id/preview/previews/:filename", (req, res) => {
    const projDir = safeProjectDir(projectsDir, req.params.id);
    if (!projDir) {
      res.status(400).json({ error: "Invalid project ID" });
      return;
    }

    const filename = req.params.filename;
    if (
      filename.includes("..") ||
      filename.includes("/") ||
      filename.includes("%2F") ||
      filename.includes("%2f") ||
      filename.includes("\0")
    ) {
      res.status(400).json({ error: "Invalid filename" });
      return;
    }

    const filePath = path.join(projDir, "05_timeline", "previews", filename);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: "Preview file not found" });
      return;
    }

    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.sendFile(filePath);
  });

  // ── GET /api/projects/:id/preview/:filename (legacy compat) ────────
  router.get("/:id/preview/:filename", (req, res) => {
    const projDir = safeProjectDir(projectsDir, req.params.id);
    if (!projDir) {
      res.status(400).json({ error: "Invalid project ID" });
      return;
    }

    const filename = req.params.filename;

    // "status", "contract", and "previews" are handled by other routes
    if (filename === "status" || filename === "contract" || filename === "previews") {
      res.status(404).json({ error: "Not found" });
      return;
    }

    if (
      filename.includes("..") ||
      filename.includes("/") ||
      filename.includes("%2F") ||
      filename.includes("%2f") ||
      filename.includes("\0")
    ) {
      res.status(400).json({ error: "Invalid filename" });
      return;
    }

    const filePath = path.join(projDir, "05_timeline", filename);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: "Preview file not found" });
      return;
    }

    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.sendFile(filePath);
  });

  return router;
}
