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
import {
  safeProjectDir,
  acquireProjectLock,
  releaseProjectLock,
  getProjectLockKind,
  atomicWriteFileSync,
} from "../utils.js";
import { getReconcileStatus } from "../services/reconcile-status.js";
import { getTimelineValidator } from "../middleware/validation.js";
import type { ProjectSyncSource } from "../services/watch-hub.js";

export type NotifyWriteFn = (
  projectId: string,
  eventType: "timeline.changed" | "review.changed" | "project-state.changed" | "render.changed",
  source: ProjectSyncSource,
) => void;

/** Compute SHA-256 hash of file content, returned as `sha256:<hex16>`. */
export function computeTimelineRevision(content: string): string {
  const hash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
  return `sha256:${hash}`;
}

export type EnsureWatchFn = (projectId: string, projectDir: string) => void;

// ── Server-side normalization ─────────────────────────────────────

interface TimelineClip {
  clip_id: string;
  timeline_in_frame: number;
  timeline_duration_frames: number;
  src_in_us: number;
  src_out_us: number;
  [key: string]: unknown;
}

interface TimelineTrack {
  track_id: string;
  clips: TimelineClip[];
  [key: string]: unknown;
}

interface TimelineBody {
  sequence: { fps_num: number; fps_den: number; [key: string]: unknown };
  tracks: { video: TimelineTrack[]; audio: TimelineTrack[] };
  [key: string]: unknown;
}

function durationFramesFromSource(srcInUs: number, srcOutUs: number, fps: number): number {
  const durationUs = srcOutUs - srcInUs;
  return Math.max(1, Math.round((durationUs / 1_000_000) * fps));
}

/** Normalize a timeline: sort clips by timeline_in_frame, recalculate timeline_duration_frames. */
export function normalizeTimelineServer(timeline: TimelineBody): TimelineBody {
  const fps = timeline.sequence.fps_num / timeline.sequence.fps_den;

  for (const group of [timeline.tracks.video, timeline.tracks.audio]) {
    for (const track of group) {
      track.clips = [...track.clips]
        .map((clip) => ({
          ...clip,
          timeline_duration_frames: durationFramesFromSource(clip.src_in_us, clip.src_out_us, fps),
        }))
        .sort((a, b) => {
          if (a.timeline_in_frame !== b.timeline_in_frame) {
            return a.timeline_in_frame - b.timeline_in_frame;
          }
          return a.clip_id.localeCompare(b.clip_id);
        });
    }
  }

  return timeline;
}

export function createTimelineRouter(
  projectsDir: string,
  notifyWrite?: NotifyWriteFn,
  ensureWatch?: EnsureWatchFn,
): Router {
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

      // Lazily ensure this project is being watched
      ensureWatch?.(req.params.id as string, projDir);
    } catch (err) {
      res.status(500).json({
        error: "Failed to read timeline",
        details: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // PUT /api/projects/:id/timeline
  router.put("/:id/timeline", (req, res) => {
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

    // Per-project filesystem advisory lock
    const existingLock = getProjectLockKind(projectId, projDir);
    if (existingLock) {
      res.status(423).json({
        error: "Project is locked",
        lock_kind: existingLock,
      });
      return;
    }

    if (!acquireProjectLock(projectId, "saving", projDir)) {
      res.status(423).json({ error: "Project is locked", lock_kind: "saving" });
      return;
    }

    try {
      // Server-side Ajv validation — canonical save contract
      const validate = getTimelineValidator();
      if (!validate(req.body)) {
        releaseProjectLock(projectId, projDir);
        res.status(400).json({
          error: "Schema validation failed",
          details: validate.errors?.map((e) => ({
            path: e.instancePath,
            message: e.message,
            params: e.params,
          })),
        });
        return;
      }

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

      // Normalize: clip sort + timeline_duration_frames recalculation
      const normalized = normalizeTimelineServer(req.body as TimelineBody);

      // Create backup if file already exists
      let backupPath: string | undefined;
      if (fs.existsSync(timelinePath)) {
        backupPath = `${timelinePath}.bak`;
        fs.copyFileSync(timelinePath, backupPath);
      }

      // Write normalized timeline (atomic: temp + rename)
      const newContent = JSON.stringify(normalized, null, 2);
      atomicWriteFileSync(timelinePath, newContent);

      const persistedContent = fs.readFileSync(timelinePath, "utf-8");
      const newRevision = computeTimelineRevision(persistedContent);
      const persistedStat = fs.statSync(timelinePath);
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
        disk_updated_at: persistedStat.mtime.toISOString(),
        ...(backupPath ? { backupPath: path.basename(backupPath) } : {}),
        ...(status ? { status } : {}),
      });

      // Notify WatchHub of API-driven save (updates hash registry, broadcasts to WS clients)
      notifyWrite?.(projectId, "timeline.changed", "api-save");
    } catch (err) {
      res.status(500).json({
        error: "Failed to save timeline",
        details: err instanceof Error ? err.message : String(err),
      });
    } finally {
      releaseProjectLock(projectId, projDir);
    }
  });

  return router;
}
