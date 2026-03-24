/**
 * Timeline API routes.
 *
 * GET  /api/projects/:id/timeline — Read timeline.json (with ETag / timeline_revision)
 * PUT  /api/projects/:id/timeline — Validate and save timeline.json (with If-Match revision check)
 */

import { Router } from "express";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { validateTimeline } from "../middleware/validation.js";
import {
  safeProjectDir,
  acquireProjectLock,
  releaseProjectLock,
  getProjectLockKind,
  atomicWriteFileSync,
} from "../utils.js";
import { getReconcileStatus } from "../services/reconcile-status.js";

/** Compute SHA-256 hash of file content, returned as `sha256:<hex16>`. */
export function computeTimelineRevision(content: string): string {
  const hash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
  return `sha256:${hash}`;
}

export function createTimelineRouter(projectsDir: string): Router {
  const router = Router();

  // GET /api/projects/:id/timeline
  router.get("/:id/timeline", (req, res) => {
    const projDir = safeProjectDir(projectsDir, req.params.id as string);
    if (!projDir) {
      res.status(400).json({ error: "Invalid project ID" });
      return;
    }

    const timelinePath = path.join(projDir, "05_timeline", "timeline.json");

    if (!fs.existsSync(timelinePath)) {
      res.status(404).json({
        error: "Timeline not found",
        project: req.params.id,
      });
      return;
    }

    try {
      const content = fs.readFileSync(timelinePath, "utf-8");
      const timeline = JSON.parse(content);
      const revision = computeTimelineRevision(content);

      res.setHeader("ETag", `"${revision}"`);
      res.json(timeline);
    } catch (err) {
      res.status(500).json({
        error: "Failed to read timeline",
        details: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // PUT /api/projects/:id/timeline
  router.put("/:id/timeline", validateTimeline, (req, res) => {
    const projectId = req.params.id as string;
    const projDir = safeProjectDir(projectsDir, projectId);
    if (!projDir) {
      res.status(400).json({ error: "Invalid project ID" });
      return;
    }

    const timelinePath = path.join(projDir, "05_timeline", "timeline.json");
    const timelineDir = path.dirname(timelinePath);

    // Ensure timeline directory exists
    if (!fs.existsSync(timelineDir)) {
      fs.mkdirSync(timelineDir, { recursive: true });
    }

    // Per-project lock (修正4)
    const existingLock = getProjectLockKind(projectId);
    if (existingLock) {
      res.status(423).json({
        error: "Project is locked",
        lock_kind: existingLock,
      });
      return;
    }

    if (!acquireProjectLock(projectId, "saving")) {
      res.status(423).json({ error: "Project is locked", lock_kind: "saving" });
      return;
    }

    try {
      // If-Match is REQUIRED when the file already exists (修正4)
      const ifMatch = req.headers["if-match"];
      if (fs.existsSync(timelinePath)) {
        if (!ifMatch) {
          res.status(428).json({
            error: "If-Match header is required when updating an existing timeline",
          });
          return;
        }

        const currentContent = fs.readFileSync(timelinePath, "utf-8");
        const currentRevision = computeTimelineRevision(currentContent);
        const clientRevision = ifMatch.replace(/^"|"$/g, "");
        if (clientRevision !== currentRevision) {
          res.status(409).json({
            error: "Timeline revision mismatch",
            current_revision: currentRevision,
            client_revision: clientRevision,
          });
          return;
        }
      }

      // Create backup if file already exists
      let backupPath: string | undefined;
      if (fs.existsSync(timelinePath)) {
        backupPath = `${timelinePath}.bak`;
        fs.copyFileSync(timelinePath, backupPath);
      }

      // Write validated timeline (atomic: temp + rename)
      const newContent = JSON.stringify(req.body, null, 2);
      atomicWriteFileSync(timelinePath, newContent);

      const newRevision = computeTimelineRevision(newContent);
      res.setHeader("ETag", `"${newRevision}"`);

      // Reconcile project state after save
      let status: { currentState: string; staleArtifacts: string[]; gates: Record<string, string> } | undefined;
      try {
        status = getReconcileStatus(projDir);
      } catch {
        // Non-fatal
      }

      res.json({
        ok: true,
        validated: true,
        timeline_revision: newRevision,
        saved_at: new Date().toISOString(),
        ...(backupPath ? { backupPath: path.basename(backupPath) } : {}),
        ...(status ? { status } : {}),
      });
    } catch (err) {
      res.status(500).json({
        error: "Failed to save timeline",
        details: err instanceof Error ? err.message : String(err),
      });
    } finally {
      releaseProjectLock(projectId);
    }
  });

  return router;
}
