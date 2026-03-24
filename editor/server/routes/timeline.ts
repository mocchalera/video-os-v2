/**
 * Timeline API routes.
 *
 * GET  /api/projects/:id/timeline — Read timeline.json
 * PUT  /api/projects/:id/timeline — Validate and save timeline.json (with .bak backup)
 */

import { Router } from "express";
import * as fs from "node:fs";
import * as path from "node:path";
import { validateTimeline } from "../middleware/validation.js";

export function createTimelineRouter(projectsDir: string): Router {
  const router = Router();

  function resolveTimelinePath(projectId: string): string {
    return path.join(projectsDir, projectId, "05_timeline", "timeline.json");
  }

  // GET /api/projects/:id/timeline
  router.get("/:id/timeline", (req, res) => {
    const timelinePath = resolveTimelinePath(req.params.id);

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
    const timelinePath = resolveTimelinePath(req.params.id as string);
    const projectDir = path.dirname(timelinePath);

    // Ensure project directory exists
    if (!fs.existsSync(projectDir)) {
      fs.mkdirSync(projectDir, { recursive: true });
    }

    try {
      // Create backup if file already exists
      let backupPath: string | undefined;
      if (fs.existsSync(timelinePath)) {
        backupPath = `${timelinePath}.bak`;
        fs.copyFileSync(timelinePath, backupPath);
      }

      // Write validated timeline
      fs.writeFileSync(
        timelinePath,
        JSON.stringify(req.body, null, 2),
        "utf-8",
      );

      res.json({
        ok: true,
        validated: true,
        ...(backupPath ? { backupPath: path.basename(backupPath) } : {}),
      });
    } catch (err) {
      res.status(500).json({
        error: "Failed to save timeline",
        details: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return router;
}
