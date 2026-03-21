import { parse as parseYaml } from "yaml";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

// CJS packages — use createRequire for clean interop with NodeNext
const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020") as new (opts: Record<string, unknown>) => {
  compile(schema: object): { (data: unknown): boolean; errors?: Array<{ instancePath: string; message?: string }> | null };
};
const addFormats = require("ajv-formats") as (ajv: unknown) => void;

// ── Types ──────────────────────────────────────────────────────────

export interface Violation {
  artifact: string;
  rule: string;
  message: string;
  details?: unknown;
}

export interface ValidationResult {
  project: string;
  valid: boolean;
  artifacts_checked: number;
  violations: Violation[];
  compile_gate: "open" | "blocked";
  /** Gate 2: canonical timeline.json passes schema + runner checks */
  gate2_timeline_valid: boolean;
  /** Gate 3: no fatal issues in review_report */
  gate3_no_fatal_reviews: boolean;
}

// ── Artifact Registry ──────────────────────────────────────────────
//
// NOTE 2 fix: manifest-based registry. To add a new artifact, append
// one entry here — no other code changes needed for basic schema validation.

interface ArtifactEntry {
  /** Relative path inside the project directory */
  artifactPath: string;
  /** Schema filename inside schemas/ */
  schemaFile: string;
  /** File format: determines parser */
  format: "yaml" | "json";
  /** If true, missing file is silently skipped */
  optional: boolean;
  /** Runner-level checks to apply after schema validation */
  runnerChecks: string[];
}

const ARTIFACT_REGISTRY: ArtifactEntry[] = [
  // 01_intent
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
  // 04_plan
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
    artifactPath: "04_plan/uncertainty_register.yaml",
    schemaFile: "uncertainty-register.schema.json",
    format: "yaml",
    optional: false,
    runnerChecks: ["uncertainty_blocker_warning"],
  },
  // 05_timeline — canonical timeline.json (Gate 2)
  {
    artifactPath: "05_timeline/timeline.json",
    schemaFile: "timeline-ir.schema.json",
    format: "json",
    optional: true,
    runnerChecks: ["timeline_clip_times"],
  },
  // 06_review — review artifacts (Gate 3). Optional because review
  // doesn't exist before the first compile pass.
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
];

// ── Helpers ─────────────────────────────────────────────────────────

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
    const msg = err instanceof Error ? err.message : String(err);
    violations.push({
      artifact: artifactRel,
      rule: "parse_error",
      message: `Failed to parse ${format.toUpperCase()}: ${msg}`,
    });
    return { ok: false };
  }
}

function findRepoRoot(from: string): string {
  let dir = from;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "schemas"))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error("Could not find repo root (directory containing schemas/)");
}

// ── Core validator ──────────────────────────────────────────────────

export function validateProject(projectPath: string): ValidationResult {
  const absProject = path.resolve(projectPath);
  const repoRoot = findRepoRoot(absProject);
  const schemasDir = path.join(repoRoot, "schemas");

  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);

  const violations: Violation[] = [];
  let artifactsChecked = 0;

  // Cache compiled validators by schema file to avoid AJV duplicate $id errors
  const validatorCache = new Map<string, ReturnType<typeof ajv.compile>>();

  function getValidator(schemaFile: string): ReturnType<typeof ajv.compile> | null {
    const cached = validatorCache.get(schemaFile);
    if (cached) return cached;
    const schemaPath = path.join(schemasDir, schemaFile);
    const schemaParsed = safeParse(schemaPath, "json", violations, schemaFile);
    if (!schemaParsed.ok) return null;
    const validator = ajv.compile(schemaParsed.data as object);
    validatorCache.set(schemaFile, validator);
    return validator;
  }

  // Gate state
  let gate2TimelineValid = true; // default true if timeline doesn't exist yet
  let gate3NoFatalReviews = true; // default true if review doesn't exist yet

  // ── 1. Registry-driven schema validation ──────────────────────────

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

    const parsed = safeParse(artifactPath, entry.format, violations, entry.artifactPath);
    if (!parsed.ok) continue; // parse_error already recorded

    const validate = getValidator(entry.schemaFile);
    if (!validate) continue;

    const valid = validate(parsed.data);
    artifactsChecked++;

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

    // ── Runner-level checks driven by registry ────────────────────

    for (const check of entry.runnerChecks) {
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
          // WARNING 2 fix: uncertainty_register.yaml status:blocker is NOT
          // a Gate 1 material. ARCHITECTURE.md uses unresolved_blockers.yaml
          // for the hard gate. However, we surface a WARNING if uncertainty_register
          // contains blocker entries, as it may indicate unresolved concerns.
          runUncertaintyBlockerWarning(parsed.data, entry.artifactPath, violations);
          break;
        case "timeline_clip_times":
          checkTimelineClipTimes(parsed.data, entry.artifactPath, violations);
          break;
        case "gate3_fatal_issues":
          runGate3FatalIssues(parsed.data, entry.artifactPath, violations);
          break;
      }
    }

    // Track gate2 status for timeline.json
    if (entry.artifactPath === "05_timeline/timeline.json") {
      const timelineViolations = violations.filter(
        (v) => v.artifact === "05_timeline/timeline.json",
      );
      if (timelineViolations.length > 0) {
        gate2TimelineValid = false;
      }
    }

    // Track gate3 status for review_report
    if (entry.artifactPath === "06_review/review_report.yaml") {
      const data = parsed.data as Record<string, unknown>;
      const fatalIssues = Array.isArray(data?.fatal_issues) ? data.fatal_issues : [];
      if (fatalIssues.length > 0) {
        gate3NoFatalReviews = false;
      }
    }
  }

  // ── 2. Versioned timeline files (*.timeline.json) ─────────────────

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
        artifactsChecked++;

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

        checkTimelineClipTimes(parsed.data, relPath, violations);
      }
    }
  }

  // ── 3. Compile gate (blocker-based, from gate1 runner) ────────────

  const hasBlockerViolation = violations.some(
    (v) => v.rule === "compile_gate",
  );
  const compileGate: "open" | "blocked" = hasBlockerViolation ? "blocked" : "open";

  return {
    project: projectPath,
    valid: violations.length === 0,
    artifacts_checked: artifactsChecked,
    violations,
    compile_gate: compileGate,
    gate2_timeline_valid: gate2TimelineValid,
    gate3_no_fatal_reviews: gate3NoFatalReviews,
  };
}

// ── Runner: src_in_us < src_out_us (selects_candidates) ─────────────

function runSrcTimeCheck(
  data: unknown,
  artifactPath: string,
  violations: Violation[],
): void {
  const doc = data as Record<string, unknown>;
  const candidates = doc?.candidates;
  if (!Array.isArray(candidates)) return;

  for (const c of candidates) {
    const candidate = c as Record<string, unknown>;
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

// ── Runner: referential integrity ───────────────────────────────────

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

  const segmentIds = new Set(segItems.map((s: Record<string, unknown>) => s.segment_id as string));
  const assetIds = new Set(astItems.map((a: Record<string, unknown>) => a.asset_id as string));

  const doc = data as Record<string, unknown>;
  const candidates = doc?.candidates;
  if (!Array.isArray(candidates)) return;

  for (const c of candidates) {
    const candidate = c as Record<string, unknown>;
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

// ── Runner: required_roles coverage ─────────────────────────────────

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

  const nonReject = candidates.filter(
    (c: Record<string, unknown>) => c.role !== "reject",
  );

  for (const beat of beats) {
    const b = beat as Record<string, unknown>;
    const beatId = b.id as string;
    const requiredRoles = b.required_roles;
    if (!Array.isArray(requiredRoles)) continue;

    for (const role of requiredRoles) {
      const covered = nonReject.some((c: Record<string, unknown>) => {
        if (c.role !== role) return false;
        const eligible = c.eligible_beats;
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

// ── Runner: Gate 1 blockers ─────────────────────────────────────────

function runGate1Blockers(
  data: unknown,
  artifactPath: string,
  violations: Violation[],
): void {
  const doc = data as Record<string, unknown>;
  const blockers = doc?.blockers;
  if (!Array.isArray(blockers)) return;

  const hasBlocker = blockers.some(
    (b: Record<string, unknown>) => b.status === "blocker",
  );
  if (hasBlocker) {
    violations.push({
      artifact: artifactPath,
      rule: "compile_gate",
      message:
        "Compile gate BLOCKED: at least one blocker with status 'blocker' exists",
    });
  }
}

// ── Runner: uncertainty_register blocker warning ────────────────────
//
// WARNING 2 fix: Per ARCHITECTURE.md, Gate 1 uses unresolved_blockers.yaml only.
// uncertainty_register.yaml is a separate artifact. Its status:blocker entries
// do NOT block compilation, but we emit a WARNING so users are aware.

function runUncertaintyBlockerWarning(
  data: unknown,
  artifactPath: string,
  violations: Violation[],
): void {
  const doc = data as Record<string, unknown>;
  const uncertainties = doc?.uncertainties;
  if (!Array.isArray(uncertainties)) return;

  const blockerEntries = uncertainties.filter(
    (u: Record<string, unknown>) => u.status === "blocker",
  );
  if (blockerEntries.length > 0) {
    violations.push({
      artifact: artifactPath,
      rule: "uncertainty_blocker_warning",
      message: `WARNING: ${blockerEntries.length} uncertainty entries have status 'blocker'. These do NOT block Gate 1 (only unresolved_blockers.yaml does), but may indicate unresolved concerns.`,
    });
  }
}

// ── Runner: Gate 3 fatal issues ─────────────────────────────────────

function runGate3FatalIssues(
  data: unknown,
  artifactPath: string,
  violations: Violation[],
): void {
  const doc = data as Record<string, unknown>;
  const fatalIssues = doc?.fatal_issues;
  if (!Array.isArray(fatalIssues)) return;

  if (fatalIssues.length > 0) {
    violations.push({
      artifact: artifactPath,
      rule: "gate3_fatal_review",
      message: `Gate 3 BLOCKED: review_report contains ${fatalIssues.length} fatal issue(s)`,
    });
  }
}

// ── Timeline clip time check ────────────────────────────────────────

function checkTimelineClipTimes(
  data: unknown,
  relPath: string,
  violations: Violation[],
): void {
  const tl = data as Record<string, unknown>;
  const tracks = tl?.tracks;
  if (typeof tracks !== "object" || tracks === null) return;

  for (const [trackType, trackList] of Object.entries(tracks as Record<string, unknown>)) {
    if (!Array.isArray(trackList)) continue;
    for (const track of trackList) {
      const t = track as Record<string, unknown>;
      const clips = t?.clips;
      if (!Array.isArray(clips)) continue;

      for (const clip of clips) {
        const c = clip as Record<string, unknown>;
        const inUs = c.src_in_us as number;
        const outUs = c.src_out_us as number;
        if (typeof inUs === "number" && typeof outUs === "number" && inUs >= outUs) {
          violations.push({
            artifact: relPath,
            rule: "src_in_us_lt_src_out_us",
            message: `Track ${trackType}/${t.track_id} clip ${c.clip_id}: src_in_us (${inUs}) must be < src_out_us (${outUs})`,
          });
        }
      }
    }
  }
}

// ── CLI entry point ─────────────────────────────────────────────────

function main(): void {
  const projectPath = process.argv[2];
  if (!projectPath) {
    console.error(
      "Usage: npx tsx scripts/validate-schemas.ts <project-path>",
    );
    process.exit(1);
  }

  const result = validateProject(projectPath);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.valid ? 0 : 1);
}

// Only run CLI when executed directly, not when imported
const isDirectRun =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("validate-schemas.ts");

if (isDirectRun) {
  main();
}
