/**
 * Lightweight reconcile-status for editor server.
 *
 * Reads project_state.yaml and compares artifact hashes to detect stale
 * artifacts after save or patch apply. This avoids importing the full
 * runtime reconcile engine while still providing status feedback to the UI.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import yaml from "js-yaml";
import { atomicWriteFileSync } from "../utils.js";

// ── Types ─────────────────────────────────────────────────────────

export interface ReconcileStatus {
  currentState: string;
  staleArtifacts: string[];
  gates: Record<string, string>;
}

interface ProjectStateDoc {
  current_state?: string;
  artifact_hashes?: Record<string, string>;
  gates?: Record<string, string>;
  [key: string]: unknown;
}

// ── Artifact paths (same as runtime/state/reconcile.ts) ──────────

const ARTIFACT_PATHS: Record<string, string> = {
  brief: "01_intent/creative_brief.yaml",
  selects: "04_plan/selects_candidates.yaml",
  blueprint: "04_plan/edit_blueprint.yaml",
  timeline: "05_timeline/timeline.json",
  review_report: "06_review/review_report.yaml",
  review_patch: "06_review/review_patch.json",
};

/** Downstream artifacts that become stale when upstream changes. */
const INVALIDATION_DOWNSTREAM: Record<string, string[]> = {
  timeline: ["review_report", "review_patch"],
  blueprint: ["timeline"],
  selects: ["timeline"],
  brief: ["selects", "blueprint"],
};

// ── Hash helper ───────────────────────────────────────────────────

function hashFile(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, "utf-8");
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

// ── Main function ─────────────────────────────────────────────────

/**
 * Read project_state.yaml, compute current artifact hashes, detect
 * stale artifacts, and return a status summary for the UI.
 */
export function getReconcileStatus(projectDir: string): ReconcileStatus {
  const statePath = path.join(projectDir, "project_state.yaml");

  // Default status if no project_state.yaml
  if (!fs.existsSync(statePath)) {
    return {
      currentState: "unknown",
      staleArtifacts: [],
      gates: {},
    };
  }

  let doc: ProjectStateDoc;
  try {
    const content = fs.readFileSync(statePath, "utf-8");
    doc = (yaml.load(content) as ProjectStateDoc) ?? {};
  } catch {
    return { currentState: "unknown", staleArtifacts: [], gates: {} };
  }

  const storedHashes = doc.artifact_hashes ?? {};

  // Compute current hashes and detect stale artifacts
  const currentHashes: Record<string, string | null> = {};
  for (const [key, relPath] of Object.entries(ARTIFACT_PATHS)) {
    currentHashes[key] = hashFile(path.join(projectDir, relPath));
  }

  const staleSet = new Set<string>();

  // An artifact is stale if its upstream has changed since the stored hash
  for (const [upstream, downstreamList] of Object.entries(INVALIDATION_DOWNSTREAM)) {
    const storedHash = storedHashes[upstream];
    const currentHash = currentHashes[upstream];

    // If upstream changed (hash differs or was newly created)
    if (currentHash && storedHash && currentHash !== storedHash) {
      for (const ds of downstreamList) {
        if (currentHashes[ds]) {
          staleSet.add(ds);
        }
      }
    }
  }

  // Also: if timeline changed, review artifacts are stale
  const timelineStored = storedHashes["timeline"];
  const timelineCurrent = currentHashes["timeline"];
  if (timelineCurrent && timelineStored && timelineCurrent !== timelineStored) {
    if (currentHashes["review_report"]) staleSet.add("review_report");
    if (currentHashes["review_patch"]) staleSet.add("review_patch");
  }

  // Determine gates
  const gates: Record<string, string> = {};
  if (staleSet.has("review_report") || staleSet.has("review_patch")) {
    gates["review_gate"] = "blocked";
  }
  if (!currentHashes["timeline"]) {
    gates["compile_gate"] = "blocked";
  }

  // Update project_state.yaml with current hashes
  try {
    const updatedDoc: ProjectStateDoc = {
      ...doc,
      artifact_hashes: {},
    };
    for (const [key, hash] of Object.entries(currentHashes)) {
      if (hash) {
        updatedDoc.artifact_hashes![key] = hash;
      }
    }
    updatedDoc.last_agent = "editor-server";
    updatedDoc.updated_at = new Date().toISOString();

    const yamlContent = yaml.dump(updatedDoc, { lineWidth: -1 });
    atomicWriteFileSync(statePath, yamlContent);
  } catch {
    // Non-fatal: status was still computed
  }

  return {
    currentState: doc.current_state ?? "unknown",
    staleArtifacts: [...staleSet],
    gates,
  };
}
