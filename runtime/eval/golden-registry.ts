// Golden registry — discovers approved projects under projects/ that
// can serve as ground truth for agreement evals.
//
// A project qualifies when project_state.yaml carries an
// approval_record with approved_by set, and the canonical artifacts
// (selects, blueprint, timeline) exist. approved_by === "operator"
// marks human-tier ground truth; agent approvals are kept but tagged.

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import type { GoldenProject } from "./types.js";

interface ProjectStateApproval {
  approval_record?: {
    approved_by?: string | null;
    approved_at?: string | null;
    status?: string | null;
  };
}

const EXCLUDED_DIRS = new Set(["_template"]);

export function discoverGoldenProjects(repoRoot: string): GoldenProject[] {
  const projectsDir = path.join(repoRoot, "projects");
  if (!fs.existsSync(projectsDir)) return [];

  const goldens: GoldenProject[] = [];
  for (const entry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || EXCLUDED_DIRS.has(entry.name)) continue;
    const projectDir = path.join(projectsDir, entry.name);
    const statePath = path.join(projectDir, "project_state.yaml");
    if (!fs.existsSync(statePath)) continue;

    let state: ProjectStateApproval;
    try {
      state = parseYaml(fs.readFileSync(statePath, "utf-8")) as ProjectStateApproval;
    } catch {
      continue;
    }
    const approval = state?.approval_record;
    if (!approval?.approved_by) continue;

    const hasSelects = fs.existsSync(path.join(projectDir, "04_plan/selects_candidates.yaml"));
    const hasBlueprint = fs.existsSync(path.join(projectDir, "04_plan/edit_blueprint.yaml"));
    const hasTimeline = fs.existsSync(path.join(projectDir, "05_timeline/timeline.json"));
    const hasAnalysis = fs.existsSync(path.join(projectDir, "03_analysis/assets.json"));
    if (!hasTimeline || !hasSelects || !hasBlueprint) continue;

    goldens.push({
      project_id: entry.name,
      project_dir: projectDir,
      approved_by: approval.approved_by,
      approved_at: approval.approved_at ?? null,
      tier: approval.approved_by === "operator" ? "human" : "agent",
      has_selects: hasSelects,
      has_blueprint: hasBlueprint,
      has_timeline: hasTimeline,
      has_analysis: hasAnalysis,
    });
  }

  goldens.sort((a, b) => a.project_id.localeCompare(b.project_id));
  return goldens;
}
