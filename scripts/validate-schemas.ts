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
import * as path from "node:path";
import {
  validateProject,
  validateProjects,
  findRepoRoot,
  type Violation,
  type ValidationProfile,
  type ValidateProjectOptions,
  type ValidationResult,
  type ValidationBatchResult,
} from "../runtime/validation/schema-validator.js";

// ── Re-exports for backward compatibility ──────────────────────────
export {
  validateProject,
  validateProjects,
  findRepoRoot,
  type Violation,
  type ValidationProfile,
  type ValidateProjectOptions,
  type ValidationResult,
  type ValidationBatchResult,
};

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

  const repoRoot = findRepoRoot(process.cwd());
  const projectPaths = parsed.projectPaths.length > 0
    ? parsed.projectPaths
    : discoverProjectPaths(repoRoot);

  if (projectPaths.length === 0) {
    console.error("No projects found to validate.");
    process.exit(1);
  }

  if (projectPaths.length === 1 && parsed.projectPaths.length === 1) {
    const result = validateProject(projectPaths[0], { profile: parsed.profile });
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.valid ? 0 : 1);
  }

  const batch = validateProjects(projectPaths, { profile: parsed.profile });
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
