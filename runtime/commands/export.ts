/**
 * /export Command
 *
 * Generates an export bundle (review handoff inventory) without changing state.
 * Allowed start states: critique_ready, approved.
 *
 * Outputs:
 * - 07_export/export_manifest.yaml
 *
 * Bundle includes:
 * - project_id, exported_at, approval_status, current_state
 * - timeline_version, review_report_version
 * - included_files list
 * - artifact_hashes
 * - analysis_override_status (clean / override / degraded)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  initCommand,
  isCommandError,
  type CommandError,
} from "./shared.js";
import type { ProjectState } from "../state/reconcile.js";
import { computeFileHash } from "../state/reconcile.js";

// ── Types ────────────────────────────────────────────────────────

export interface ExportManifest {
  project_id: string;
  exported_at: string;
  current_state: ProjectState;
  approval_status: "clean" | "creative_override" | "pending" | "stale";
  analysis_override_status: "clean" | "override" | "degraded";
  timeline_version: string;
  review_report_version: string;
  included_files: Array<{
    path: string;
    hash: string;
    size_bytes: number;
  }>;
  artifact_hashes: Record<string, string>;
}

export interface ExportCommandResult {
  success: boolean;
  error?: CommandError;
  manifest?: ExportManifest;
  manifestPath?: string;
}

export interface ExportCommandOptions {
  /** Deterministic timestamp for testing */
  exportedAt?: string;
}

// ── Bundle File Definitions ──────────────────────────────────────

const BUNDLE_FILES = [
  "05_timeline/timeline.json",
  "06_review/review_report.yaml",
  "06_review/review_patch.json",
  "STYLE.md",
] as const;

// ── Command Implementation ───────────────────────────────────────

const ALLOWED_STATES: ProjectState[] = [
  "critique_ready",
  "approved",
];

export function runExport(
  projectDir: string,
  options?: ExportCommandOptions,
): ExportCommandResult {
  // 1. Init command (reconcile + state check)
  const ctx = initCommand(projectDir, "/export", ALLOWED_STATES);
  if (isCommandError(ctx)) {
    return { success: false, error: ctx };
  }

  const { projectDir: absDir, doc } = ctx;
  const projectId = doc.project_id || "";
  const exportedAt = options?.exportedAt ?? new Date().toISOString();

  // 2. Determine approval_status from approval_record
  const approvalStatus = doc.approval_record?.status ?? "pending";

  // 3. Determine analysis_override_status
  let analysisOverrideStatus: ExportManifest["analysis_override_status"];
  if (!doc.analysis_override || doc.analysis_override.status === "none") {
    analysisOverrideStatus = "clean";
  } else if (doc.analysis_override.status === "active") {
    analysisOverrideStatus = "override";
  } else {
    // stale
    analysisOverrideStatus = "degraded";
  }

  // 4. Collect included files
  const includedFiles: ExportManifest["included_files"] = [];
  const artifactHashes: Record<string, string> = {};

  for (const relPath of BUNDLE_FILES) {
    const absPath = path.join(absDir, relPath);
    if (fs.existsSync(absPath)) {
      const hash = computeFileHash(absPath);
      const stat = fs.statSync(absPath);
      includedFiles.push({
        path: relPath,
        hash,
        size_bytes: stat.size,
      });
      artifactHashes[relPath] = hash;
    }
  }

  // 5. Extract timeline_version and review_report_version
  let timelineVersion = "unknown";
  const timelinePath = path.join(absDir, "05_timeline/timeline.json");
  if (fs.existsSync(timelinePath)) {
    try {
      const tl = JSON.parse(fs.readFileSync(timelinePath, "utf-8"));
      timelineVersion = tl.version ?? "unknown";
    } catch { /* use default */ }
  }

  let reviewReportVersion = "unknown";
  const reportPath = path.join(absDir, "06_review/review_report.yaml");
  if (fs.existsSync(reportPath)) {
    try {
      const raw = fs.readFileSync(reportPath, "utf-8");
      const report = parseYaml(raw) as { version?: string };
      reviewReportVersion = report?.version ?? "unknown";
    } catch { /* use default */ }
  }

  // 6. Build manifest
  const manifest: ExportManifest = {
    project_id: projectId,
    exported_at: exportedAt,
    current_state: doc.current_state,
    approval_status: approvalStatus,
    analysis_override_status: analysisOverrideStatus,
    timeline_version: timelineVersion,
    review_report_version: reviewReportVersion,
    included_files: includedFiles,
    artifact_hashes: artifactHashes,
  };

  // 7. Write manifest to 07_export/export_manifest.yaml
  const exportDir = path.join(absDir, "07_export");
  fs.mkdirSync(exportDir, { recursive: true });

  const manifestPath = path.join(exportDir, "export_manifest.yaml");
  fs.writeFileSync(manifestPath, stringifyYaml(manifest), "utf-8");

  // State is NOT changed (read-only export)

  return {
    success: true,
    manifest,
    manifestPath,
  };
}
