/**
 * Policy Resolver — merges repo defaults + project override into a resolved policy.
 *
 * Merge order (per milestone-2-design.md §Analysis Policy):
 *   1. runtime/analysis-defaults.yaml  (repo defaults)
 *   2. projects/<id>/analysis_policy.yaml  (optional project override)
 *   3. explicit runtime flags (future — not wired yet)
 *
 * The merged result is what gets schema-validated; the raw override may be partial.
 */

import { parse as parseYaml } from "yaml";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Deep merge ──────────────────────────────────────────────────────

export function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof result[key] === "object" &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ── Defaults loader ─────────────────────────────────────────────────

function findRepoRoot(from: string): string {
  let dir = from;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "schemas"))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error("Could not find repo root (directory containing schemas/)");
}

export function loadDefaults(repoRoot?: string): Record<string, unknown> {
  const root = repoRoot ?? findRepoRoot(process.cwd());
  const defaultsPath = path.join(root, "runtime/analysis-defaults.yaml");
  const raw = fs.readFileSync(defaultsPath, "utf-8");
  return parseYaml(raw) as Record<string, unknown>;
}

// ── Resolver ────────────────────────────────────────────────────────

export interface ResolveResult {
  resolved: Record<string, unknown>;
  hasOverride: boolean;
}

/**
 * Resolve the analysis policy for a project directory.
 *
 * @param projectPath  absolute or relative path to the project directory
 * @param repoRoot     optional repo root override (for testing)
 * @returns merged policy and whether an override was found
 */
export function resolvePolicy(
  projectPath: string,
  repoRoot?: string,
): ResolveResult {
  const absProject = path.resolve(projectPath);
  const root = repoRoot ?? findRepoRoot(absProject);
  const defaults = loadDefaults(root);

  const overridePath = path.join(absProject, "analysis_policy.yaml");
  if (!fs.existsSync(overridePath)) {
    return { resolved: defaults, hasOverride: false };
  }

  const overrideRaw = fs.readFileSync(overridePath, "utf-8");
  const override = parseYaml(overrideRaw) as Record<string, unknown>;
  const resolved = deepMerge(defaults, override);

  return { resolved, hasOverride: true };
}
