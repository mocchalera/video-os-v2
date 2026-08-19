/**
 * CLI entry point for schema validation.
 *
 * Usage:
 *   npx tsx scripts/validate-schemas.ts [--profile standard|manual-render|lenient] [project-path ...]
 *
 * Core validation logic lives in runtime/validation/schema-validator.ts.
 * This file is a thin CLI adapter + re-exports for backward compatibility.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateProject as validateProjectInRepoContext,
  findRepoRoot,
  type Violation,
  type ValidationProfile,
  type ValidateProjectOptions,
  type ValidationResult,
  type ValidationBatchResult,
} from "../runtime/validation/schema-validator.js";

// ── Re-exports for backward compatibility ──────────────────────────
export {
  findRepoRoot,
  type Violation,
  type ValidationProfile,
  type ValidateProjectOptions,
  type ValidationResult,
  type ValidationBatchResult,
};

function validatorRepoRoot(): string {
  return findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
}

function isWithinDirectory(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function validateProjectWithRepoContext(
  projectPath: string,
  options: ValidateProjectOptions,
  repoRoot: string,
): ValidationResult {
  const absoluteProject = path.resolve(projectPath);
  if (isWithinDirectory(repoRoot, absoluteProject)) {
    return validateProjectInRepoContext(projectPath, options);
  }

  const contextRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "video-os-schema-validator-"),
  );
  const contextProject = path.join(contextRoot, "project");

  try {
    fs.symlinkSync(path.join(repoRoot, "schemas"), path.join(contextRoot, "schemas"), "dir");
    fs.symlinkSync(path.join(repoRoot, "runtime"), path.join(contextRoot, "runtime"), "dir");
    fs.symlinkSync(absoluteProject, contextProject, "dir");
    return {
      ...validateProjectInRepoContext(contextProject, options),
      project: projectPath,
    };
  } finally {
    fs.rmSync(contextRoot, { recursive: true, force: true });
  }
}

export function validateProject(
  projectPath: string,
  options: ValidateProjectOptions = {},
): ValidationResult {
  return validateProjectWithRepoContext(projectPath, options, validatorRepoRoot());
}

export function validateProjects(
  projectPaths: string[],
  options: ValidateProjectOptions = {},
): ValidationBatchResult {
  const profile = options.profile ?? "standard";
  const repoRoot = validatorRepoRoot();
  const results = projectPaths.map((projectPath) =>
    validateProjectWithRepoContext(projectPath, { profile }, repoRoot)
  );

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

// ── CLI Arg Parsing ────────────────────────────────────────────────

export function parseValidationCliArgs(argv: string[]): {
  profile: ValidationProfile;
  projectPaths: string[];
} {
  const projectPaths: string[] = [];
  let profile: ValidationProfile = "standard";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--profile") {
      const next = argv[i + 1];
      if (!next) {
        throw new Error("Missing value for --profile");
      }
      if (next !== "standard" && next !== "manual-render" && next !== "lenient") {
        throw new Error(`Unknown profile: ${next}`);
      }
      profile = next;
      i += 1;
      continue;
    }

    if (arg.startsWith("--profile=")) {
      const value = arg.slice("--profile=".length);
      if (value !== "standard" && value !== "manual-render" && value !== "lenient") {
        throw new Error(`Unknown profile: ${value}`);
      }
      profile = value;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      throw new Error("help");
    }

    projectPaths.push(arg);
  }

  return { profile, projectPaths };
}

// ── Project Discovery ──────────────────────────────────────────────

function discoverProjectPaths(repoRoot: string): string[] {
  const projectsDir = path.join(repoRoot, "projects");
  if (!fs.existsSync(projectsDir)) return [];

  return fs.readdirSync(projectsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .map((entry) => path.join(projectsDir, entry.name))
    .filter((projectDir) => {
      const hasIntentArtifacts = fs.existsSync(path.join(projectDir, "01_intent", "creative_brief.yaml"));
      const hasPlanArtifacts = fs.existsSync(path.join(projectDir, "04_plan", "selects_candidates.yaml")) ||
        fs.existsSync(path.join(projectDir, "04_plan", "edit_blueprint.yaml"));
      return hasIntentArtifacts || hasPlanArtifacts;
    })
    .sort();
}

// ── CLI Entry Point ────────────────────────────────────────────────

function main(): void {
  let parsed: ReturnType<typeof parseValidationCliArgs>;
  try {
    parsed = parseValidationCliArgs(process.argv.slice(2));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const usage =
      "Usage: npx tsx scripts/validate-schemas.ts [--profile standard|manual-render|lenient] [project-path ...]";
    if (message === "help") {
      console.error(usage);
      process.exit(0);
    }
    console.error(message);
    console.error(usage);
    process.exit(1);
  }

  let repoRoot: string;
  try {
    repoRoot = validatorRepoRoot();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({
      valid: false,
      profile: parsed.profile,
      violations: [],
      runner_error: {
        stage: "schema_repository_root_discovery",
        message,
        hint: "Run the validator from a checkout that contains its schemas/ directory.",
      },
    }, null, 2));
    process.exit(1);
  }

  const projectPaths = parsed.projectPaths.length > 0
    ? parsed.projectPaths
    : discoverProjectPaths(repoRoot);

  if (projectPaths.length === 0) {
    console.error("No projects found to validate.");
    process.exit(1);
  }

  if (projectPaths.length === 1 && parsed.projectPaths.length === 1) {
    const result = validateProjectWithRepoContext(
      projectPaths[0],
      { profile: parsed.profile },
      repoRoot,
    );
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.valid ? 0 : 1);
  }

  const results = projectPaths.map((projectPath) =>
    validateProjectWithRepoContext(projectPath, { profile: parsed.profile }, repoRoot)
  );
  const batch: ValidationBatchResult = {
    profile: parsed.profile,
    valid: results.every((result) => result.valid),
    projects_checked: results.length,
    artifacts_checked: results.reduce((sum, result) => sum + result.artifacts_checked, 0),
    error_count: results.reduce((sum, result) => sum + result.error_count, 0),
    warning_count: results.reduce((sum, result) => sum + result.warning_count, 0),
    results,
  };
  console.log(JSON.stringify(batch, null, 2));
  process.exit(batch.valid ? 0 : 1);
}

// Only run CLI when executed directly, not when imported
const isDirectRun =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("validate-schemas.ts");

if (isDirectRun) {
  main();
}
