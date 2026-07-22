/**
 * Core schema validation logic for Video OS project artifacts.
 *
 * Validates project artifacts against JSON schemas + runner-level checks.
 * Profile-specific behavior is delegated to ./profiles.ts.
 */

import { parse as parseYaml } from "yaml";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { resolvePolicy } from "../policy-resolver.js";
import { buildSchemaVariant, finalizeViolations } from "./profiles.js";
import {
  computeNormalizedJsonHash,
  validateAnalysisCoverageReport,
  validateSourceMediaManifest,
} from "../artifacts/p1-manifest-coverage.js";
import {
  validateAudioStoryGraph,
} from "../artifacts/p2-audio-story-graph.js";
import {
  validateContinuityGraph,
} from "../artifacts/p3-continuity-graph.js";
import { validateSourceLedger } from "../artifacts/source-ledger.js";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020") as new (opts: Record<string, unknown>) => {
  compile(schema: object): { (data: unknown): boolean; errors?: Array<{ instancePath: string; message?: string }> | null };
  addSchema(schema: object): void;
};
const addFormats = require("ajv-formats") as (ajv: unknown) => void;

export interface Violation {
  artifact: string;
  rule: string;
  message: string;
  details?: unknown;
  severity?: "error" | "warning";
}

export type ValidationProfile = "standard" | "manual-render" | "lenient";

export interface ValidateProjectOptions {
  profile?: ValidationProfile;
}

export interface ValidationResult {
  project: string;
  profile: ValidationProfile;
  valid: boolean;
  artifacts_checked: number;
  error_count: number;
  warning_count: number;
  violations: Violation[];
  compile_gate: "open" | "blocked";
  gate2_timeline_valid: boolean;
  gate3_no_fatal_reviews: boolean;
}

export interface ValidationBatchResult {
  profile: ValidationProfile;
  valid: boolean;
  projects_checked: number;
  artifacts_checked: number;
  error_count: number;
  warning_count: number;
  results: ValidationResult[];
}

interface ArtifactEntry {
  artifactPath: string;
  schemaFile: string;
  format: "yaml" | "json";
  optional: boolean;
  runnerChecks: string[];
}

const ARTIFACT_REGISTRY: ArtifactEntry[] = [
  {
    artifactPath: "01_intent/creative_brief.yaml",
    schemaFile: "creative-brief.schema.json",
    format: "yaml",
    optional: false,
    runnerChecks: [],
  },
  {
    artifactPath: "01_intent/unresolved_blockers.yaml",
    schemaFile: "unresolved-blockers.schema.json",
    format: "yaml",
    optional: false,
    runnerChecks: ["gate1_blockers"],
  },
  {
    artifactPath: "04_plan/selects_candidates.yaml",
    schemaFile: "selects-candidates.schema.json",
    format: "yaml",
    optional: false,
    runnerChecks: ["src_time_check", "referential_integrity", "required_roles"],
  },
  {
    artifactPath: "04_plan/edit_blueprint.yaml",
    schemaFile: "edit-blueprint.schema.json",
    format: "yaml",
    optional: false,
    runnerChecks: [],
  },
  {
    artifactPath: "04_plan/bgm_selection.json",
    schemaFile: "bgm-selection.schema.json",
    format: "json",
    optional: true,
    runnerChecks: [],
  },
  {
    artifactPath: "04_plan/uncertainty_register.yaml",
    schemaFile: "uncertainty-register.schema.json",
    format: "yaml",
    optional: false,
    runnerChecks: ["uncertainty_blocker_warning"],
  },
  {
    artifactPath: "05_timeline/timeline.json",
    schemaFile: "timeline-ir.schema.json",
    format: "json",
    optional: true,
    runnerChecks: ["timeline_semantics"],
  },
  {
    artifactPath: "06_review/review_report.yaml",
    schemaFile: "review-report.schema.json",
    format: "yaml",
    optional: true,
    runnerChecks: ["gate3_fatal_issues"],
  },
  {
    artifactPath: "06_review/review_patch.json",
    schemaFile: "review-patch.schema.json",
    format: "json",
    optional: true,
    runnerChecks: [],
  },
  {
    artifactPath: "06_review/review_metrics.json",
    schemaFile: "review-metrics.schema.json",
    format: "json",
    optional: true,
    runnerChecks: [],
  },
  {
    artifactPath: "07_package/caption_review_patch.json",
    schemaFile: "caption-review-patch.schema.json",
    format: "json",
    optional: true,
    runnerChecks: [],
  },
  {
    artifactPath: "07_package/caption_review_preview.json",
    schemaFile: "caption-review-preview.schema.json",
    format: "json",
    optional: true,
    runnerChecks: [],
  },
  {
    artifactPath: "07_package/caption_timing_report.json",
    schemaFile: "caption-timing-report.schema.json",
    format: "json",
    optional: true,
    runnerChecks: [],
  },
  {
    artifactPath: "06_review/editorial_pipeline_status.json",
    schemaFile: "editorial-pipeline-status.schema.json",
    format: "json",
    optional: true,
    runnerChecks: ["editorial_pipeline_status_blockers"],
  },
  {
    artifactPath: "07_handoff/editor_annotations.json",
    schemaFile: "editor-annotations.schema.json",
    format: "json",
    optional: true,
    runnerChecks: [],
  },
  {
    artifactPath: "07_package/release_safety_report.yaml",
    schemaFile: "release-safety-report.schema.json",
    format: "yaml",
    optional: true,
    runnerChecks: [],
  },
  {
    artifactPath: "07_package/rights_license_register.yaml",
    schemaFile: "rights-license-register.schema.json",
    format: "yaml",
    optional: true,
    runnerChecks: [],
  },
  {
    artifactPath: "07_package/qa-report.json",
    schemaFile: "package-qa-report.schema.json",
    format: "json",
    optional: true,
    runnerChecks: ["package_qa_report_passed"],
  },
  {
    artifactPath: "07_package/delivery_profiles/default.yaml",
    schemaFile: "delivery-profile.schema.json",
    format: "yaml",
    optional: true,
    runnerChecks: [],
  },
  {
    artifactPath: "08_eval/confidence_calibration_report.json",
    schemaFile: "confidence-calibration-report.schema.json",
    format: "json",
    optional: true,
    runnerChecks: [],
  },
  {
    artifactPath: "08_eval/product_outcome_metrics.json",
    schemaFile: "product-outcome-metrics.schema.json",
    format: "json",
    optional: true,
    runnerChecks: [],
  },
  {
    artifactPath: "03_analysis/search/segment_search_index_manifest.json",
    schemaFile: "segment-search-index-manifest.schema.json",
    format: "json",
    optional: true,
    runnerChecks: [],
  },
  {
    artifactPath: "03_analysis/search/segment_text_index.json",
    schemaFile: "segment-text-index.schema.json",
    format: "json",
    optional: true,
    runnerChecks: [],
  },
  {
    artifactPath: "03_analysis/assets.json",
    schemaFile: "assets.schema.json",
    format: "json",
    optional: true,
    runnerChecks: [],
  },
  {
    artifactPath: "03_analysis/source_ledger.json",
    schemaFile: "source-ledger.schema.json",
    format: "json",
    optional: true,
    runnerChecks: ["source_ledger_invariant"],
  },
  {
    artifactPath: "02_media/source_media_manifest.json",
    schemaFile: "source-media-manifest.schema.json",
    format: "json",
    optional: true,
    runnerChecks: ["source_manifest_fingerprint"],
  },
  {
    artifactPath: "03_analysis/analysis_coverage_report.json",
    schemaFile: "analysis-coverage-report.schema.json",
    format: "json",
    optional: true,
    runnerChecks: ["analysis_coverage_status"],
  },
  {
    artifactPath: "03_analysis/audio_story_graph.json",
    schemaFile: "audio-story-graph.schema.json",
    format: "json",
    optional: true,
    runnerChecks: ["audio_story_graph_integrity"],
  },
  {
    artifactPath: "03_analysis/continuity_graph.json",
    schemaFile: "continuity-graph.schema.json",
    format: "json",
    optional: true,
    runnerChecks: ["continuity_graph_integrity"],
  },
  {
    artifactPath: "03_analysis/marlin_events.json",
    schemaFile: "marlin-events.schema.json",
    format: "json",
    optional: true,
    runnerChecks: [],
  },
  {
    artifactPath: "03_analysis/segments.json",
    schemaFile: "segments.schema.json",
    format: "json",
    optional: true,
    runnerChecks: ["segment_src_time_check"],
  },
  {
    artifactPath: "02_media/source_map.json",
    schemaFile: "source-map.schema.json",
    format: "json",
    optional: true,
    runnerChecks: [],
  },
  {
    artifactPath: "analysis_policy.yaml",
    schemaFile: "analysis-policy.schema.json",
    format: "yaml",
    optional: true,
    runnerChecks: [],
  },
];

function safeParse(
  filePath: string,
  format: "yaml" | "json",
  violations: Violation[],
  artifactRel: string,
): { ok: true; data: unknown } | { ok: false } {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = format === "yaml" ? parseYaml(raw) : JSON.parse(raw);
    return { ok: true, data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    violations.push({
      artifact: artifactRel,
      rule: "parse_error",
      message: `Failed to parse ${format.toUpperCase()}: ${message}`,
    });
    return { ok: false };
  }
}

export function findRepoRoot(from: string): string {
  let dir = from;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "schemas"))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error("Could not find repo root (directory containing schemas/)");
}

export function validateProject(
  projectPath: string,
  options: ValidateProjectOptions = {},
): ValidationResult {
  const profile = options.profile ?? "standard";
  const absProject = path.resolve(projectPath);
  const repoRoot = findRepoRoot(absProject);
  const schemasDir = path.join(repoRoot, "schemas");

  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);

  for (const shared of ["analysis-common.schema.json"]) {
    const sharedPath = path.join(schemasDir, shared);
    if (!fs.existsSync(sharedPath)) continue;
    try {
      ajv.addSchema(JSON.parse(fs.readFileSync(sharedPath, "utf-8")));
    } catch {
      // Shared schema failures surface during downstream compile.
    }
  }

  const violations: Violation[] = [];
  let artifactsChecked = 0;
  const validatorCache = new Map<string, ReturnType<typeof ajv.compile>>();

  function getValidator(schemaFile: string): ReturnType<typeof ajv.compile> | null {
    const cached = validatorCache.get(schemaFile);
    if (cached) return cached;
    const schemaPath = path.join(schemasDir, schemaFile);
    const schemaParsed = safeParse(schemaPath, "json", violations, schemaFile);
    if (!schemaParsed.ok) return null;
    const validator = ajv.compile(
      buildSchemaVariant(schemaFile, schemaParsed.data as object, profile),
    );
    validatorCache.set(schemaFile, validator);
    return validator;
  }

  let gate2TimelineValid = true;
  let gate3NoFatalReviews = true;

  for (const entry of ARTIFACT_REGISTRY) {
    const artifactPath = path.join(absProject, entry.artifactPath);
    if (!fs.existsSync(artifactPath)) {
      if (!entry.optional) {
        violations.push({
          artifact: entry.artifactPath,
          rule: "missing_required_artifact",
          message: `Required artifact not found: ${entry.artifactPath}`,
        });
      }
      continue;
    }

    let parsed = safeParse(artifactPath, entry.format, violations, entry.artifactPath);
    if (!parsed.ok) continue;

    if (entry.artifactPath === "analysis_policy.yaml") {
      try {
        const { resolved } = resolvePolicy(absProject, repoRoot);
        parsed = { ok: true, data: resolved };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        violations.push({
          artifact: entry.artifactPath,
          rule: "policy_resolve",
          message: `Failed to resolve policy: ${message}`,
        });
        continue;
      }
    }

    const validate = getValidator(entry.schemaFile);
    if (!validate) continue;

    const valid = validate(parsed.data);
    artifactsChecked += 1;

    if (!valid && validate.errors) {
      for (const err of validate.errors) {
        violations.push({
          artifact: entry.artifactPath,
          rule: "schema",
          message: `${err.instancePath || "/"} ${err.message}`,
          details: err,
        });
      }
    }

    for (const check of entry.runnerChecks) {
      if (check === "source_ledger_invariant" && !valid) continue;
      switch (check) {
        case "src_time_check":
          runSrcTimeCheck(parsed.data, entry.artifactPath, violations);
          break;
        case "referential_integrity":
          runReferentialIntegrity(parsed.data, absProject, violations);
          break;
        case "required_roles":
          runRequiredRoles(parsed.data, absProject, violations);
          break;
        case "gate1_blockers":
          runGate1Blockers(parsed.data, entry.artifactPath, violations);
          break;
        case "uncertainty_blocker_warning":
          runUncertaintyBlockerWarning(parsed.data, entry.artifactPath, violations);
          break;
        case "timeline_semantics":
          runTimelineSemanticChecks(parsed.data, absProject, entry.artifactPath, violations);
          break;
        case "gate3_fatal_issues":
          runGate3FatalIssues(parsed.data, entry.artifactPath, violations);
          break;
        case "editorial_pipeline_status_blockers":
          runEditorialPipelineStatusBlockers(parsed.data, entry.artifactPath, violations);
          break;
        case "package_qa_report_passed":
          runPackageQaReportPassed(parsed.data, entry.artifactPath, violations);
          break;
        case "segment_src_time_check":
          runSegmentSrcTimeCheck(parsed.data, entry.artifactPath, violations);
          break;
        case "source_manifest_fingerprint":
          runSourceManifestFingerprintCheck(parsed.data, entry.artifactPath, violations);
          break;
        case "analysis_coverage_status":
          runAnalysisCoverageStatusCheck(parsed.data, entry.artifactPath, violations);
          break;
        case "audio_story_graph_integrity":
          runAudioStoryGraphIntegrityCheck(parsed.data, absProject, entry.artifactPath, violations);
          break;
        case "continuity_graph_integrity":
          runContinuityGraphIntegrityCheck(parsed.data, absProject, entry.artifactPath, violations);
          break;
        case "source_ledger_invariant":
          runSourceLedgerInvariantCheck(parsed.data, entry.artifactPath, violations);
          break;
      }
    }

    if (entry.artifactPath === "05_timeline/timeline.json") {
      const timelineViolations = violations.filter((violation) => violation.artifact === "05_timeline/timeline.json");
      if (timelineViolations.length > 0) {
        gate2TimelineValid = false;
      }
    }

    if (entry.artifactPath === "06_review/review_report.yaml") {
      const data = parsed.data as Record<string, unknown>;
      const fatalIssues = Array.isArray(data?.fatal_issues) ? data.fatal_issues : [];
      if (fatalIssues.length > 0) {
        gate3NoFatalReviews = false;
      }
    }
  }

  const timelineDir = path.join(absProject, "05_timeline");
  if (fs.existsSync(timelineDir)) {
    const validate = getValidator("timeline-ir.schema.json");
    if (validate) {
      for (const file of fs.readdirSync(timelineDir)) {
        if (!file.endsWith(".timeline.json")) continue;
        const relPath = `05_timeline/${file}`;
        const filePath = path.join(timelineDir, file);
        const parsed = safeParse(filePath, "json", violations, relPath);
        if (!parsed.ok) continue;

        const valid = validate(parsed.data);
        artifactsChecked += 1;
        if (!valid && validate.errors) {
          for (const err of validate.errors) {
            violations.push({
              artifact: relPath,
              rule: "schema",
              message: `${err.instancePath || "/"} ${err.message}`,
              details: err,
            });
          }
        }

        runTimelineSemanticChecks(parsed.data, absProject, relPath, violations);
      }
    }
  }

  const transcriptsDir = path.join(absProject, "03_analysis/transcripts");
  if (fs.existsSync(transcriptsDir)) {
    const validate = getValidator("transcript.schema.json");
    if (validate) {
      for (const file of fs.readdirSync(transcriptsDir)) {
        if (!file.startsWith("TR_") || !file.endsWith(".json")) continue;
        const relPath = `03_analysis/transcripts/${file}`;
        const filePath = path.join(transcriptsDir, file);
        const parsed = safeParse(filePath, "json", violations, relPath);
        if (!parsed.ok) continue;

        const valid = validate(parsed.data);
        artifactsChecked += 1;
        if (!valid && validate.errors) {
          for (const err of validate.errors) {
            violations.push({
              artifact: relPath,
              rule: "schema",
              message: `${err.instancePath || "/"} ${err.message}`,
              details: err,
            });
          }
        }

        runTranscriptPathInvariants(parsed.data, file, relPath, violations);
      }
    }
  }

  const deliveryProfilesDir = path.join(absProject, "07_package/delivery_profiles");
  if (fs.existsSync(deliveryProfilesDir)) {
    const validate = getValidator("delivery-profile.schema.json");
    if (validate) {
      for (const file of fs.readdirSync(deliveryProfilesDir).sort()) {
        if (!/\.ya?ml$/i.test(file)) continue;
        const relPath = `07_package/delivery_profiles/${file}`;
        if (relPath === "07_package/delivery_profiles/default.yaml") continue;
        const filePath = path.join(deliveryProfilesDir, file);
        const parsed = safeParse(filePath, "yaml", violations, relPath);
        if (!parsed.ok) continue;

        const valid = validate(parsed.data);
        artifactsChecked += 1;
        if (!valid && validate.errors) {
          for (const err of validate.errors) {
            violations.push({
              artifact: relPath,
              rule: "schema",
              message: `${err.instancePath || "/"} ${err.message}`,
              details: err,
            });
          }
        }
      }
    }
  }

  const compileGate: "open" | "blocked" = violations.some((violation) => violation.rule === "compile_gate")
    ? "blocked"
    : "open";
  const finalized = finalizeViolations(violations, profile);

  return {
    project: projectPath,
    profile,
    valid: finalized.errorCount === 0,
    artifacts_checked: artifactsChecked,
    error_count: finalized.errorCount,
    warning_count: finalized.warningCount,
    violations: finalized.violations,
    compile_gate: compileGate,
    gate2_timeline_valid: gate2TimelineValid,
    gate3_no_fatal_reviews: gate3NoFatalReviews,
  };
}

function runSourceLedgerInvariantCheck(
  data: unknown,
  artifactPath: string,
  violations: Violation[],
): void {
  const result = validateSourceLedger(data);
  for (const message of result.violations) {
    violations.push({
      artifact: artifactPath,
      rule: "source_ledger_invariant",
      message,
    });
  }
}

export function validateProjects(
  projectPaths: string[],
  options: ValidateProjectOptions = {},
): ValidationBatchResult {
  const profile = options.profile ?? "standard";
  const results = projectPaths.map((projectPath) => validateProject(projectPath, { profile }));

  return {
    profile,
    valid: results.every((result) => result.valid),
    projects_checked: results.length,
    artifacts_checked: results.reduce((sum, result) => sum + result.artifacts_checked, 0),
    error_count: results.reduce((sum, result) => sum + result.error_count, 0),
    warning_count: results.reduce((sum, result) => sum + result.warning_count, 0),
    results,
  };
}

function runSrcTimeCheck(
  data: unknown,
  artifactPath: string,
  violations: Violation[],
): void {
  const doc = data as Record<string, unknown>;
  const candidates = doc?.candidates;
  if (!Array.isArray(candidates)) return;

  for (const item of candidates) {
    const candidate = item as Record<string, unknown>;
    const inUs = candidate.src_in_us as number;
    const outUs = candidate.src_out_us as number;
    if (typeof inUs === "number" && typeof outUs === "number" && inUs >= outUs) {
      violations.push({
        artifact: artifactPath,
        rule: "src_in_us_lt_src_out_us",
        message: `Candidate ${candidate.segment_id}: src_in_us (${inUs}) must be < src_out_us (${outUs})`,
      });
    }
  }
}

function runReferentialIntegrity(
  data: unknown,
  absProject: string,
  violations: Violation[],
): void {
  const segmentsPath = path.join(absProject, "03_analysis/segments.json");
  const assetsPath = path.join(absProject, "03_analysis/assets.json");
  if (!fs.existsSync(segmentsPath) || !fs.existsSync(assetsPath)) return;

  const segParsed = safeParse(segmentsPath, "json", [], "03_analysis/segments.json");
  const astParsed = safeParse(assetsPath, "json", [], "03_analysis/assets.json");
  if (!segParsed.ok || !astParsed.ok) return;

  const segments = segParsed.data as Record<string, unknown>;
  const assets = astParsed.data as Record<string, unknown>;
  const segItems = segments.items;
  const astItems = assets.items;
  if (!Array.isArray(segItems) || !Array.isArray(astItems)) return;

  const segmentIds = new Set(segItems.map((item) => (item as Record<string, unknown>).segment_id as string));
  const assetIds = new Set(astItems.map((item) => (item as Record<string, unknown>).asset_id as string));
  const doc = data as Record<string, unknown>;
  const candidates = doc?.candidates;
  if (!Array.isArray(candidates)) return;

  for (const item of candidates) {
    const candidate = item as Record<string, unknown>;
    if (!segmentIds.has(candidate.segment_id as string)) {
      violations.push({
        artifact: "04_plan/selects_candidates.yaml",
        rule: "segment_id_exists",
        message: `Candidate references segment_id "${candidate.segment_id}" not found in segments.json`,
      });
    }
    if (!assetIds.has(candidate.asset_id as string)) {
      violations.push({
        artifact: "04_plan/selects_candidates.yaml",
        rule: "asset_id_exists",
        message: `Candidate references asset_id "${candidate.asset_id}" not found in assets.json`,
      });
    }
  }
}

function runRequiredRoles(
  data: unknown,
  absProject: string,
  violations: Violation[],
): void {
  const blueprintPath = path.join(absProject, "04_plan/edit_blueprint.yaml");
  if (!fs.existsSync(blueprintPath)) return;

  const bpParsed = safeParse(blueprintPath, "yaml", [], "04_plan/edit_blueprint.yaml");
  if (!bpParsed.ok) return;

  const blueprint = bpParsed.data as Record<string, unknown>;
  const beats = blueprint?.beats;
  if (!Array.isArray(beats)) return;

  const doc = data as Record<string, unknown>;
  const candidates = doc?.candidates;
  if (!Array.isArray(candidates)) return;

  const nonReject = candidates.filter((candidate) => (candidate as Record<string, unknown>).role !== "reject");

  for (const beat of beats) {
    const item = beat as Record<string, unknown>;
    const beatId = item.id as string;
    const requiredRoles = item.required_roles;
    if (!Array.isArray(requiredRoles)) continue;

    for (const role of requiredRoles) {
      const covered = nonReject.some((candidate) => {
        const candidateDoc = candidate as Record<string, unknown>;
        if (candidateDoc.role !== role) return false;
        const eligible = candidateDoc.eligible_beats;
        if (!Array.isArray(eligible)) return true;
        return eligible.includes(beatId);
      });

      if (!covered) {
        violations.push({
          artifact: "04_plan/edit_blueprint.yaml",
          rule: "required_roles_covered",
          message: `Beat "${beatId}" requires role "${role}" but no eligible non-reject candidate provides it`,
        });
      }
    }
  }
}

function runGate1Blockers(
  data: unknown,
  artifactPath: string,
  violations: Violation[],
): void {
  const doc = data as Record<string, unknown>;
  const blockers = doc?.blockers;
  if (!Array.isArray(blockers)) return;

  const hasBlocker = blockers.some((blocker) => (blocker as Record<string, unknown>).status === "blocker");
  if (!hasBlocker) return;

  violations.push({
    artifact: artifactPath,
    rule: "compile_gate",
    message: "Compile gate BLOCKED: at least one blocker with status 'blocker' exists",
  });
}

function runUncertaintyBlockerWarning(
  data: unknown,
  artifactPath: string,
  violations: Violation[],
): void {
  const doc = data as Record<string, unknown>;
  const uncertainties = doc?.uncertainties;
  if (!Array.isArray(uncertainties)) return;

  const blockerEntries = uncertainties.filter((item) => (item as Record<string, unknown>).status === "blocker");
  if (blockerEntries.length === 0) return;

  violations.push({
    artifact: artifactPath,
    rule: "uncertainty_blocker_warning",
    message: `WARNING: ${blockerEntries.length} uncertainty entries have status 'blocker'. These do NOT block Gate 1 (only unresolved_blockers.yaml does), but may indicate unresolved concerns.`,
  });
}

function runGate3FatalIssues(
  data: unknown,
  artifactPath: string,
  violations: Violation[],
): void {
  const doc = data as Record<string, unknown>;
  const fatalIssues = doc?.fatal_issues;
  if (!Array.isArray(fatalIssues) || fatalIssues.length === 0) return;

  violations.push({
    artifact: artifactPath,
    rule: "gate3_fatal_review",
    message: `Gate 3 BLOCKED: review_report contains ${fatalIssues.length} fatal issue(s)`,
  });
}

interface TimelineClipRef {
  trackType: string;
  trackId: string;
  clip: Record<string, unknown>;
}

function collectTimelineClips(timeline: Record<string, unknown>): TimelineClipRef[] {
  const tracks = timeline?.tracks;
  if (typeof tracks !== "object" || tracks === null) return [];

  const refs: TimelineClipRef[] = [];
  for (const [trackType, trackList] of Object.entries(tracks as Record<string, unknown>)) {
    if (!Array.isArray(trackList)) continue;
    for (const track of trackList) {
      const trackDoc = track as Record<string, unknown>;
      const trackId = typeof trackDoc.track_id === "string" ? trackDoc.track_id : "";
      const clips = trackDoc?.clips;
      if (!Array.isArray(clips)) continue;
      for (const clip of clips) {
        refs.push({ trackType, trackId, clip: clip as Record<string, unknown> });
      }
    }
  }
  return refs;
}

function runTimelineSemanticChecks(
  data: unknown,
  absProject: string,
  relPath: string,
  violations: Violation[],
): void {
  checkTimelineClipTimes(data, relPath, violations);

  const timeline = data as Record<string, unknown>;
  const tracks = timeline?.tracks;
  if (typeof tracks !== "object" || tracks === null) return;

  const seenTrackIds = new Set<string>();
  for (const trackList of Object.values(tracks as Record<string, unknown>)) {
    if (!Array.isArray(trackList)) continue;
    for (const track of trackList) {
      const trackDoc = track as Record<string, unknown>;
      const trackId = trackDoc.track_id;
      if (typeof trackId !== "string") continue;
      if (seenTrackIds.has(trackId)) {
        violations.push({
          artifact: relPath,
          rule: "timeline_track_id_unique",
          message: `Duplicate track_id "${trackId}" in timeline`,
        });
      }
      seenTrackIds.add(trackId);
    }
  }

  const clipRefs = collectTimelineClips(timeline);
  const seenClipIds = new Set<string>();
  const sourceMapAssetIds = readSourceMapAssetIds(absProject);
  let inferredDurationFrames = 0;

  for (const { trackType, trackId, clip } of clipRefs) {
    const clipId = clip.clip_id;
    if (typeof clipId === "string") {
      if (seenClipIds.has(clipId)) {
        violations.push({
          artifact: relPath,
          rule: "timeline_clip_id_unique",
          message: `Duplicate clip_id "${clipId}" in timeline`,
        });
      }
      seenClipIds.add(clipId);
    }

    const assetId = clip.asset_id;
    const isAuthoredOverlay =
      trackType === "overlay" &&
      assetId === "__overlay__" &&
      clip.role === "title" &&
      typeof clip.segment_id === "string" &&
      clip.segment_id.startsWith("TXT_");
    if (
      sourceMapAssetIds.size > 0 &&
      typeof assetId === "string" &&
      !isAuthoredOverlay &&
      !sourceMapAssetIds.has(assetId)
    ) {
      violations.push({
        artifact: relPath,
        rule: "timeline_asset_id_in_source_map",
        message: `Track ${trackType}/${trackId} clip ${clipId}: asset_id "${assetId}" is not present in source_map.json`,
      });
    }

    const timelineInFrame = clip.timeline_in_frame;
    const timelineDurationFrames = clip.timeline_duration_frames;
    if (typeof timelineInFrame === "number" && typeof timelineDurationFrames === "number") {
      inferredDurationFrames = Math.max(inferredDurationFrames, timelineInFrame + timelineDurationFrames);
    }

    const captions = clip.captions;
    if (Array.isArray(captions)) {
      for (const caption of captions) {
        const captionDoc = caption as Record<string, unknown>;
        const inFrame = captionDoc.in_frame;
        const outFrame = captionDoc.out_frame;
        if (typeof inFrame === "number" && typeof outFrame === "number" && inFrame >= outFrame) {
          violations.push({
            artifact: relPath,
            rule: "caption_bounds_valid",
            message: `Clip ${clipId}: caption in_frame (${inFrame}) must be < out_frame (${outFrame})`,
          });
        }
        if (
          typeof inFrame === "number" &&
          typeof outFrame === "number" &&
          typeof timelineInFrame === "number" &&
          typeof timelineDurationFrames === "number" &&
          (
            inFrame < timelineInFrame ||
            outFrame > timelineInFrame + timelineDurationFrames
          )
        ) {
          violations.push({
            artifact: relPath,
            rule: "caption_bounds_valid",
            message: `Clip ${clipId}: caption range (${inFrame}-${outFrame}) must stay within clip timeline range (${timelineInFrame}-${timelineInFrame + timelineDurationFrames})`,
          });
        }
      }
    }
  }

  const transitions = timeline.transitions;
  if (Array.isArray(transitions)) {
    const seenTransitionIds = new Set<string>();
    for (const transition of transitions) {
      const transitionDoc = transition as Record<string, unknown>;
      const transitionId = transitionDoc.transition_id;
      if (typeof transitionId === "string") {
        if (seenTransitionIds.has(transitionId)) {
          violations.push({
            artifact: relPath,
            rule: "timeline_transition_id_unique",
            message: `Duplicate transition_id "${transitionId}" in timeline`,
          });
        }
        seenTransitionIds.add(transitionId);
      }

      for (const key of ["from_clip_id", "to_clip_id"] as const) {
        const ref = transitionDoc[key];
        if (typeof ref === "string" && !seenClipIds.has(ref)) {
          violations.push({
            artifact: relPath,
            rule: "timeline_transition_clip_ref_exists",
            message: `Transition ${transitionId}: ${key} "${ref}" does not reference an existing clip_id`,
          });
        }
      }
    }
  }

  const markers = timeline.markers;
  if (Array.isArray(markers) && inferredDurationFrames > 0) {
    for (const marker of markers) {
      const markerDoc = marker as Record<string, unknown>;
      const frame = markerDoc.frame;
      if (typeof frame === "number" && frame > inferredDurationFrames) {
        violations.push({
          artifact: relPath,
          rule: "marker_bounds_valid",
          message: `Marker "${markerDoc.label ?? ""}" at frame ${frame} exceeds inferred timeline duration ${inferredDurationFrames}`,
        });
      }
    }
  }
}

function readSourceMapAssetIds(absProject: string): Set<string> {
  const assetIds = new Set<string>();
  for (const relPath of ["02_media/source_map.json", "03_analysis/source_map.json"]) {
    const sourceMapPath = path.join(absProject, relPath);
    if (!fs.existsSync(sourceMapPath)) continue;
    const parsed = safeParse(sourceMapPath, "json", [], relPath);
    if (!parsed.ok) continue;
    const doc = parsed.data as Record<string, unknown>;
    const items = doc.items;
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      const assetId = (item as Record<string, unknown>).asset_id;
      if (typeof assetId === "string") assetIds.add(assetId);
    }
  }
  return assetIds;
}

function runEditorialPipelineStatusBlockers(
  data: unknown,
  artifactPath: string,
  violations: Violation[],
): void {
  const doc = data as Record<string, unknown>;
  const blockingIssues = Array.isArray(doc.blocking_issues) ? doc.blocking_issues : [];
  const finalRender = doc.final_render as Record<string, unknown> | undefined;
  const packageState = doc.package as Record<string, unknown> | undefined;
  if (
    blockingIssues.length === 0 &&
    finalRender?.status !== "blocked" &&
    packageState?.status !== "blocked"
  ) {
    return;
  }

  violations.push({
    artifact: artifactPath,
    rule: "editorial_pipeline_status_blocked",
    message: `Editorial pipeline status blocks final/package output (${blockingIssues.length} blocking issue(s))`,
  });
}

function runPackageQaReportPassed(
  data: unknown,
  artifactPath: string,
  violations: Violation[],
): void {
  const doc = data as Record<string, unknown>;
  if (doc.passed !== false) return;

  violations.push({
    artifact: artifactPath,
    rule: "package_qa_report_failed",
    message: "Package QA report failed; final package must not be treated as approved",
  });
}

function checkTimelineClipTimes(
  data: unknown,
  relPath: string,
  violations: Violation[],
): void {
  const timeline = data as Record<string, unknown>;
  const tracks = timeline?.tracks;
  if (typeof tracks !== "object" || tracks === null) return;

  for (const [trackType, trackList] of Object.entries(tracks as Record<string, unknown>)) {
    if (!Array.isArray(trackList)) continue;
    for (const track of trackList) {
      const trackDoc = track as Record<string, unknown>;
      const clips = trackDoc?.clips;
      if (!Array.isArray(clips)) continue;

      for (const clip of clips) {
        const clipDoc = clip as Record<string, unknown>;
        const inUs = clipDoc.src_in_us as number;
        const outUs = clipDoc.src_out_us as number;
        if (typeof inUs === "number" && typeof outUs === "number" && inUs >= outUs) {
          violations.push({
            artifact: relPath,
            rule: "src_in_us_lt_src_out_us",
            message: `Track ${trackType}/${trackDoc.track_id} clip ${clipDoc.clip_id}: src_in_us (${inUs}) must be < src_out_us (${outUs})`,
          });
        }
      }
    }
  }
}

function runSegmentSrcTimeCheck(
  data: unknown,
  artifactPath: string,
  violations: Violation[],
): void {
  const doc = data as Record<string, unknown>;
  const items = doc?.items;
  if (!Array.isArray(items)) return;

  for (const item of items) {
    const segment = item as Record<string, unknown>;
    const inUs = segment.src_in_us as number;
    const outUs = segment.src_out_us as number;
    if (typeof inUs === "number" && typeof outUs === "number" && inUs >= outUs) {
      violations.push({
        artifact: artifactPath,
        rule: "src_in_us_lt_src_out_us",
        message: `Segment ${segment.segment_id}: src_in_us (${inUs}) must be < src_out_us (${outUs})`,
      });
    }
  }
}

function runTranscriptPathInvariants(
  data: unknown,
  filename: string,
  relPath: string,
  violations: Violation[],
): void {
  const doc = data as Record<string, unknown>;
  const transcriptRef = doc?.transcript_ref as string | undefined;
  const assetId = doc?.asset_id as string | undefined;
  const filenameMatch = filename.match(/^TR_(.+)\.json$/);
  if (!filenameMatch) return;

  const expectedAssetId = filenameMatch[1];
  const expectedTranscriptRef = `TR_${expectedAssetId}`;

  if (transcriptRef && transcriptRef !== expectedTranscriptRef) {
    violations.push({
      artifact: relPath,
      rule: "transcript_ref_matches_filename",
      message: `transcript_ref "${transcriptRef}" does not match filename expectation "${expectedTranscriptRef}"`,
    });
  }

  if (assetId && assetId !== expectedAssetId) {
    violations.push({
      artifact: relPath,
      rule: "asset_id_matches_filename",
      message: `asset_id "${assetId}" does not match filename expectation "${expectedAssetId}"`,
    });
  }
}

function runSourceManifestFingerprintCheck(
  data: unknown,
  artifactPath: string,
  violations: Violation[],
): void {
  const result = validateSourceMediaManifest(data);
  for (const message of result.violations) {
    violations.push({
      artifact: artifactPath,
      rule: "source_manifest_fingerprint",
      message,
    });
  }
}

function runAnalysisCoverageStatusCheck(
  data: unknown,
  artifactPath: string,
  violations: Violation[],
): void {
  const result = validateAnalysisCoverageReport(data);
  for (const message of result.violations) {
    violations.push({
      artifact: artifactPath,
      rule: "analysis_coverage_status",
      message,
    });
  }
}

function runAudioStoryGraphIntegrityCheck(
  data: unknown,
  absProject: string,
  artifactPath: string,
  violations: Violation[],
): void {
  const manifestPath = path.join(absProject, "02_media/source_media_manifest.json");
  let manifestAssetIds: string[] | undefined;
  let sourceMediaManifestHash: string | undefined;
  if (fs.existsSync(manifestPath)) {
    const parsed = safeParse(manifestPath, "json", [], "02_media/source_media_manifest.json");
    if (parsed.ok) {
      const manifest = parsed.data as { items?: Array<{ asset_id?: string }>; provenance?: { hash_policy?: { excluded_fields?: string[] } } };
      manifestAssetIds = (manifest.items ?? [])
        .map((item) => item.asset_id)
        .filter((assetId): assetId is string => typeof assetId === "string");
      const excludedFields = manifest.provenance?.hash_policy?.excluded_fields ?? [];
      sourceMediaManifestHash = computeNormalizedJsonHash(manifest, excludedFields);
    }
  }

  const result = validateAudioStoryGraph(data, { manifestAssetIds, sourceMediaManifestHash });
  for (const message of result.violations) {
    violations.push({
      artifact: artifactPath,
      rule: "audio_story_graph_integrity",
      message,
    });
  }
}

function runContinuityGraphIntegrityCheck(
  data: unknown,
  absProject: string,
  artifactPath: string,
  violations: Violation[],
): void {
  const manifestPath = path.join(absProject, "02_media/source_media_manifest.json");
  let manifestAssetIds: string[] | undefined;
  let sourceMediaManifestHash: string | undefined;
  if (fs.existsSync(manifestPath)) {
    const parsed = safeParse(manifestPath, "json", [], "02_media/source_media_manifest.json");
    if (parsed.ok) {
      const manifest = parsed.data as { items?: Array<{ asset_id?: string }>; provenance?: { hash_policy?: { excluded_fields?: string[] } } };
      manifestAssetIds = (manifest.items ?? [])
        .map((item) => item.asset_id)
        .filter((assetId): assetId is string => typeof assetId === "string");
      const excludedFields = manifest.provenance?.hash_policy?.excluded_fields ?? [];
      sourceMediaManifestHash = computeNormalizedJsonHash(manifest, excludedFields);
    }
  }

  const result = validateContinuityGraph(data, { manifestAssetIds, sourceMediaManifestHash });
  for (const message of result.violations) {
    violations.push({
      artifact: artifactPath,
      rule: "continuity_graph_integrity",
      message,
    });
  }
}
