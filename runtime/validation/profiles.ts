/**
 * Validation profile definitions and profile-specific logic.
 *
 * Profiles control schema variant construction and violation severity.
 * - standard:      strict validation, all rules enforced
 * - manual-render:  allows manual_render fields in timeline schema
 * - lenient:       all violations downgraded to warnings
 */

import type { Violation, ValidationProfile } from "./schema-validator.js";

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function buildSchemaVariant(
  schemaFile: string,
  schema: object,
  profile: ValidationProfile,
): object {
  if (schemaFile !== "timeline-ir.schema.json" || profile !== "manual-render") {
    return schema;
  }

  const variant = cloneJson(schema) as Record<string, unknown>;
  const properties = variant.properties as Record<string, unknown> | undefined;
  if (!properties) return variant;

  properties.manual_render = { "$ref": "#/$defs/manualRender" };

  const provenance = properties.provenance as Record<string, unknown> | undefined;
  const provenanceProperties = provenance?.properties as Record<string, unknown> | undefined;
  if (provenanceProperties) {
    provenanceProperties.manual_render_spec_path = { type: "string" };
    provenanceProperties.render_script_path = { type: "string" };
    provenanceProperties.render_profile = {
      type: "string",
      enum: ["manual-render"],
    };
  }

  return variant;
}

export function violationSeverity(
  rule: string,
  profile: ValidationProfile,
): "error" | "warning" {
  if (profile === "lenient") return "warning";
  if (rule === "uncertainty_blocker_warning") return "warning";
  return "error";
}

export function finalizeViolations(
  violations: Violation[],
  profile: ValidationProfile,
): { violations: Violation[]; errorCount: number; warningCount: number } {
  let errorCount = 0;
  let warningCount = 0;

  const finalized = violations.map((violation) => {
    const severity = violationSeverity(violation.rule, profile);
    if (severity === "warning") warningCount += 1;
    else errorCount += 1;
    return { ...violation, severity };
  });

  return { violations: finalized, errorCount, warningCount };
}
