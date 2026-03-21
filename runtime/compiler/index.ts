// Timeline Compiler — Main entry point
// Orchestrates Phase 1-5 to produce timeline.json from project artifacts.
// Pure, deterministic. No LLM calls. No randomness.

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { normalize } from "./normalize.js";
import { scoreCandidates } from "./score.js";
import { assemble } from "./assemble.js";
import { resolve } from "./resolve.js";
import { buildTimelineIR, exportOtio, writePreviewManifest, writeTimeline } from "./export.js";
import type {
  CompileOptions,
  CompilerDefaults,
  CreativeBrief,
  EditBlueprint,
  SelectsCandidates,
  TimelineIR,
} from "./types.js";

export type { TimelineIR, CompileOptions };

export interface CompileResult {
  timeline: TimelineIR;
  outputPath: string;
  otioPath: string;
  previewManifestPath: string;
  resolution: {
    resolved_overlaps: number;
    resolved_duplicates: number;
    resolved_invalid_ranges: number;
    duration_fit: boolean;
    total_frames: number;
    target_frames: number;
  };
}

function findRepoRoot(from: string): string {
  let dir = path.resolve(from);
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "schemas"))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error("Could not find repo root (directory containing schemas/)");
}

function readYaml<T>(filePath: string): T {
  const raw = fs.readFileSync(filePath, "utf-8");
  return parseYaml(raw) as T;
}

export function compile(opts: CompileOptions): CompileResult {
  const projectPath = path.resolve(opts.projectPath);
  const repoRoot = findRepoRoot(projectPath);

  // ── Read input artifacts ──────────────────────────────────────────

  const briefPath = path.join(projectPath, "01_intent/creative_brief.yaml");
  const blueprintPath = path.join(projectPath, "04_plan/edit_blueprint.yaml");
  const selectsPath = path.join(projectPath, "04_plan/selects_candidates.yaml");
  const defaultsPath = path.join(repoRoot, "runtime/compiler-defaults.yaml");

  const brief = readYaml<CreativeBrief>(briefPath);
  const blueprint = readYaml<EditBlueprint>(blueprintPath);
  const selects = readYaml<SelectsCandidates>(selectsPath);
  const defaults = readYaml<CompilerDefaults>(defaultsPath);

  // ── Phase 1: Normalize ────────────────────────────────────────────

  const normalized = normalize(brief, blueprint);

  // ── Phase 2: Score ────────────────────────────────────────────────

  const fpsNum = 24;
  const fpsDen = 1;
  const rankedTable = scoreCandidates(
    normalized,
    selects.candidates,
    defaults.scoring,
    fpsNum,
    fpsDen,
  );

  // ── Phase 3: Assemble ─────────────────────────────────────────────

  const assembled = assemble(normalized, rankedTable, defaults.scoring);

  // ── Phase 4: Resolve constraints ──────────────────────────────────

  const resolution = resolve(assembled, normalized.total_duration_frames, selects.candidates);

  // ── Phase 5: Export ───────────────────────────────────────────────

  const createdAt = opts.createdAt;

  const timelineIR = buildTimelineIR(assembled, {
    projectId: normalized.project_id,
    projectTitle: normalized.project_title,
    projectPath,
    createdAt,
    briefRelPath: "01_intent/creative_brief.yaml",
    blueprintRelPath: "04_plan/edit_blueprint.yaml",
    selectsRelPath: "04_plan/selects_candidates.yaml",
  });

  const outputPath = writeTimeline(timelineIR, projectPath);
  const otioPath = exportOtio(timelineIR, projectPath);
  const previewManifestPath = writePreviewManifest(timelineIR, projectPath);

  return { timeline: timelineIR, outputPath, otioPath, previewManifestPath, resolution };
}
