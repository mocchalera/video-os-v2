/**
 * Selects Candidates API route (Phase 2b-1).
 *
 * GET /api/projects/:id/selects — Return selects_candidates.yaml as JSON
 */

import { Router } from "express";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import yaml from "js-yaml";
import { safeProjectDir } from "../utils.js";

export function createSelectsRouter(projectsDir: string): Router {
  const router = Router();

  // GET /api/projects/:id/selects
  router.get("/:id/selects", (req, res) => {
    const projDir = safeProjectDir(projectsDir, req.params.id);
    if (!projDir) {
      res.status(400).json({ error: "Invalid project ID" });
      return;
    }

    const selectsPath = path.join(projDir, "04_plan", "selects_candidates.yaml");

    if (!fs.existsSync(selectsPath)) {
      res.json({ exists: false, data: null });
      return;
    }

    try {
      const content = fs.readFileSync(selectsPath, "utf-8");
      const data = yaml.load(content);
      const hash = crypto
        .createHash("sha256")
        .update(content)
        .digest("hex")
        .slice(0, 16);

      res.json({
        exists: true,
        revision: `sha256:${hash}`,
        data,
      });
    } catch (err) {
      res.status(500).json({
        error: "Failed to read selects candidates",
        details: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return router;
}
