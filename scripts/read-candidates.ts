#!/usr/bin/env tsx

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import type { Candidate, EditBlueprint, SelectsCandidates } from "../runtime/artifacts/types.js";

export interface BrowserCandidatesDocument {
  project_id: string;
  candidates: BrowserCandidate[];
  beat_plans: BrowserBeatPlan[];
}

export interface BrowserCandidate {
  candidate_id: string;
  segment_id: string;
  asset_id: string;
  key_frame_path: string | null;
  src_in_us: number;
  src_out_us: number;
  role: string;
  confidence: number;
  why_it_matches: string;
  risks: string[];
  eligible_beats: string[];
  story_role: string | null;
  evidence: string[];
  motif_tags: string[];
  trim_hint: BrowserTrimHint | null;
  editorial_signals: BrowserEditorialSignals | null;
}

export interface BrowserTrimHint {
  source_center_us: number;
  preferred_duration_us: number;
  recommended_in_us: number;
  recommended_out_us: number;
  peak_ref: string | null;
  rationale: string | null;
}

export interface BrowserEditorialSignals {
  peak_ref: string | null;
  peak_type: string | null;
  peak_strength_score: number;
}

export interface BrowserBeatPlan {
  beat_id: string;
  label: string;
  target_duration_frames: number;
  primary_candidate_ref: string | null;
  fallback_candidate_refs: string[];
}

interface CLIArgs {
  projectPath: string;
  json: boolean;
}

const USAGE = "Usage: npx tsx scripts/read-candidates.ts --project <path> --json";

function parseArgs(argv: string[] = process.argv): CLIArgs {
  const args = argv.slice(2);
  let projectPath: string | undefined;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      throw new Error(USAGE);
    }
    if (arg === "--project" && index + 1 < args.length) {
      projectPath = args[++index];
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}\n${USAGE}`);
  }

  if (!projectPath) {
    throw new Error(`Missing --project.\n${USAGE}`);
  }
  if (!json) {
    throw new Error(`Missing --json.\n${USAGE}`);
  }

  return { projectPath, json };
}

export function readCandidateBrowserDocument(projectPath: string): BrowserCandidatesDocument {
  const absProject = path.resolve(projectPath);
  const planDir = path.join(absProject, "04_plan");
  const selects = readYaml<SelectsCandidates>(path.join(planDir, "selects_candidates.yaml"));
  const blueprint = readYaml<EditBlueprint>(path.join(planDir, "edit_blueprint.yaml"));
  return buildCandidateBrowserDocument(selects, blueprint);
}

export function buildCandidateBrowserDocument(
  selects: SelectsCandidates,
  blueprint: EditBlueprint,
): BrowserCandidatesDocument {
  const projectID = selects.project_id || blueprint.project_id;
  if (!projectID) {
    throw new Error("Missing project_id in selects_candidates.yaml and edit_blueprint.yaml.");
  }

  return {
    project_id: projectID,
    candidates: (selects.candidates ?? []).map(normalizeCandidate),
    beat_plans: (blueprint.beats ?? []).map((beat) => ({
      beat_id: beat.id,
      label: beat.label,
      target_duration_frames: safeNumber(beat.target_duration_frames),
      primary_candidate_ref: beat.candidate_plan?.primary_candidate_ref ?? null,
      fallback_candidate_refs: normalizeStrings(beat.candidate_plan?.fallback_candidate_refs),
    })),
  };
}

function readYaml<T>(filePath: string): T {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Artifact file not found: ${filePath}`);
  }
  return parseYaml(fs.readFileSync(filePath, "utf-8")) as T;
}

function normalizeCandidate(candidate: Candidate): BrowserCandidate {
  return {
    candidate_id: candidate.candidate_id ?? candidate.segment_id,
    segment_id: candidate.segment_id,
    asset_id: candidate.asset_id,
    key_frame_path: normalizeKeyFramePath(candidate),
    src_in_us: safeNumber(candidate.src_in_us),
    src_out_us: safeNumber(candidate.src_out_us),
    role: candidate.role,
    confidence: safeNumber(candidate.confidence),
    why_it_matches: candidate.why_it_matches ?? "",
    risks: normalizeStrings(candidate.risks),
    eligible_beats: normalizeStrings(candidate.eligible_beats),
    story_role: candidate.story_role ?? null,
    evidence: normalizeStrings(candidate.evidence),
    motif_tags: normalizeStrings(candidate.motif_tags),
    trim_hint: normalizeTrimHint(candidate),
    editorial_signals: normalizeEditorialSignals(candidate),
  };
}

function normalizeKeyFramePath(candidate: Candidate): string | null {
  const rawCandidate = candidate as Candidate & Record<string, unknown>;
  return (
    normalizeString(rawCandidate.key_frame_path) ??
    normalizeStringFromObject(candidate.trim_hint, "key_frame_path") ??
    normalizeStringFromObject(candidate.editorial_signals, "key_frame_path") ??
    null
  );
}

function normalizeTrimHint(candidate: Candidate): BrowserTrimHint | null {
  const trim = candidate.trim_hint;
  if (!trim) return null;

  const recommendedIn = safeNumber(trim.recommended_in_us ?? trim.window_start_us ?? candidate.src_in_us);
  const recommendedOut = safeNumber(trim.recommended_out_us ?? trim.window_end_us ?? candidate.src_out_us);
  const duration = Math.max(0, recommendedOut - recommendedIn);

  return {
    source_center_us: safeNumber(trim.source_center_us ?? Math.round((recommendedIn + recommendedOut) / 2)),
    preferred_duration_us: safeNumber(trim.preferred_duration_us ?? duration),
    recommended_in_us: recommendedIn,
    recommended_out_us: recommendedOut,
    peak_ref: trim.peak_ref ?? null,
    rationale: trim.rationale ?? null,
  };
}

function normalizeEditorialSignals(candidate: Candidate): BrowserEditorialSignals | null {
  const signals = candidate.editorial_signals;
  if (!signals) return null;
  return {
    peak_ref: signals.peak_ref ?? null,
    peak_type: signals.peak_type ?? null,
    peak_strength_score: safeNumber(signals.peak_strength_score),
  };
}

function normalizeStrings(values: string[] | undefined): string[] {
  return Array.isArray(values) ? values.filter((value): value is string => typeof value === "string") : [];
}

function normalizeStringFromObject(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return normalizeString((value as Record<string, unknown>)[key]);
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function safeNumber(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function main(): void {
  const args = parseArgs();
  const document = readCandidateBrowserDocument(args.projectPath);
  process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}
