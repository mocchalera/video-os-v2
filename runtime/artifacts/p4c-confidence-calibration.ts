import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { computeNormalizedJsonHash } from "./p1-manifest-coverage.js";
import { validateAgainstSchema } from "../commands/shared.js";
import type { DeliveryProfile, LoadedDeliveryProfile } from "./p4b-delivery-profile.js";
import type { ReleaseSafetyCheck } from "./p4a-release-safety.js";

export type ConfidenceBucket = "very_low" | "low" | "medium" | "high" | "very_high";

export interface ConfidenceCalibrationReport {
  version: string;
  project_id: string;
  artifact_version: "calibration-report-v1";
  created_at: string;
  report_id: string;
  eval_set_id: string;
  calibration_model_id: string;
  artifact_versions: Record<string, { version: string; hash: string }>;
  metrics: Record<string, number>;
  buckets: Array<{
    bucket: ConfidenceBucket;
    sample_count: number;
    observed_accuracy: number;
    expected_accuracy: number;
  }>;
  failures: Array<{
    failure_id: string;
    severity: "info" | "warning" | "blocker";
    message: string;
    artifact_refs: Array<{ path: string; hash: string }>;
  }>;
  recommendations: string[];
  provenance: {
    producer: "scripts/eval-confidence-calibration.ts";
    inputs: Array<{ path: string; hash: string; required?: boolean }>;
    hash_policy: {
      algorithm: "sha256";
      canonicalization: "normalized-json-v1";
      excluded_fields: string[];
    };
  };
}

export interface LoadedConfidenceCalibrationReport {
  path: string;
  hash: string;
  report: ConfidenceCalibrationReport;
}

export interface MalformedConfidenceCalibrationReport {
  path: string;
  hash: string | null;
  errors: string[];
}

export interface LoadConfidenceCalibrationReportResult {
  report: LoadedConfidenceCalibrationReport | null;
  malformed: MalformedConfidenceCalibrationReport[];
}

const REPORT_REL_PATH = "08_eval/confidence_calibration_report.json";
const BUCKET_TOLERANCE = 0.15;

const ARTIFACT_VERSION_PATHS: Record<string, string> = {
  audio_story_graph_version: "03_analysis/audio_story_graph.json",
  continuity_graph_version: "03_analysis/continuity_graph.json",
  assets_version: "03_analysis/assets.json",
  release_safety_report_version: "07_package/release_safety_report.yaml",
};

export function isP4cConfidenceCalibrationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.ENABLE_P4C_CONFIDENCE_CALIBRATION ?? "");
}

export function computeConfidenceCalibrationReportHash(report: unknown): string {
  return computeNormalizedJsonHash(report, ["created_at"]);
}

export function loadCalibrationReport(projectPath: string): LoadConfidenceCalibrationReportResult {
  const reportPath = path.join(projectPath, REPORT_REL_PATH);
  if (!fs.existsSync(reportPath)) return { report: null, malformed: [] };
  let hash: string | null = null;
  try {
    hash = sha256File(reportPath);
    const parsed = JSON.parse(fs.readFileSync(reportPath, "utf-8")) as ConfidenceCalibrationReport;
    const schema = validateAgainstSchema(parsed, "confidence-calibration-report.schema.json");
    const integrity = validateConfidenceCalibrationReportIntegrity(parsed);
    const errors = [...schema.errors, ...integrity.violations];
    if (!schema.valid || !integrity.valid) {
      return { report: null, malformed: [{ path: reportPath, hash, errors }] };
    }
    return { report: { path: reportPath, hash, report: parsed }, malformed: [] };
  } catch (err) {
    return {
      report: null,
      malformed: [{
        path: reportPath,
        hash,
        errors: [err instanceof Error ? err.message : String(err)],
      }],
    };
  }
}

export function readCalibrationReportStatus(projectPath: string): {
  enabled: boolean;
  exists: boolean;
  path: string;
  eval_set_id?: string;
  calibration_model_id?: string;
  valid?: boolean;
  errors?: string[];
} {
  const reportPath = path.join(projectPath, REPORT_REL_PATH);
  const loaded = loadCalibrationReport(projectPath);
  if (loaded.report) {
    return {
      enabled: true,
      exists: true,
      path: loaded.report.path,
      eval_set_id: loaded.report.report.eval_set_id,
      calibration_model_id: loaded.report.report.calibration_model_id,
      valid: true,
    };
  }
  if (loaded.malformed.length > 0) {
    return {
      enabled: true,
      exists: true,
      path: reportPath,
      valid: false,
      errors: loaded.malformed.flatMap((item) => item.errors),
    };
  }
  return { enabled: true, exists: false, path: reportPath };
}

export function validateConfidenceCalibrationReportIntegrity(data: unknown): { valid: boolean; violations: string[] } {
  const report = data as Partial<ConfidenceCalibrationReport>;
  const violations: string[] = [];
  const seenBuckets = new Set<string>();
  for (const bucket of report.buckets ?? []) {
    if (seenBuckets.has(bucket.bucket)) violations.push(`duplicate bucket ${bucket.bucket}`);
    seenBuckets.add(bucket.bucket);
    if (Math.abs(bucket.observed_accuracy - bucket.expected_accuracy) > BUCKET_TOLERANCE) {
      violations.push(`bucket calibration drift ${bucket.bucket}: observed_accuracy differs from expected_accuracy by more than ${BUCKET_TOLERANCE}`);
    }
  }
  if (report.provenance?.hash_policy?.canonicalization !== "normalized-json-v1") {
    violations.push("hash_policy.canonicalization must be normalized-json-v1");
  }
  if (!report.provenance?.hash_policy?.excluded_fields?.includes("created_at")) {
    violations.push("hash_policy.excluded_fields must include created_at");
  }
  return { valid: violations.length === 0, violations };
}

export function currentCalibrationArtifactVersions(projectDir: string): Record<string, { version: string; hash: string }> {
  const versions: Record<string, { version: string; hash: string }> = {};
  for (const [key, relPath] of Object.entries(ARTIFACT_VERSION_PATHS)) {
    const filePath = path.join(projectDir, relPath);
    if (!fs.existsSync(filePath)) continue;
    versions[key] = {
      version: readArtifactVersion(filePath),
      hash: sha256File(filePath),
    };
  }
  return versions;
}

export function isStale(
  report: ConfidenceCalibrationReport,
  currentArtifactVersions: Record<string, { version: string; hash: string }>,
): boolean {
  return staleArtifactVersionKeys(report, currentArtifactVersions).length > 0;
}

export function staleArtifactVersionKeys(
  report: ConfidenceCalibrationReport,
  currentArtifactVersions: Record<string, { version: string; hash: string }>,
): string[] {
  return Object.entries(report.artifact_versions)
    .filter(([key, ref]) => currentArtifactVersions[key] && currentArtifactVersions[key].hash !== ref.hash)
    .map(([key]) => key);
}

export function generateCalibrationCheck(
  profileInput: DeliveryProfile | LoadedDeliveryProfile,
  loadedReport: LoadConfidenceCalibrationReportResult,
  projectDir: string,
): ReleaseSafetyCheck | null {
  const profile = "profile" in profileInput ? profileInput.profile : profileInput;
  const profilePath = "profile" in profileInput ? profileInput.path : path.join("07_package/delivery_profiles", `${profile.profile_id}.yaml`);
  const profileHash = "profile" in profileInput ? profileInput.hash : null;
  if (profile.requires_calibrated_confidence !== true) return null;

  const reportPath = path.join(projectDir, REPORT_REL_PATH);
  const refs = [
    { path: profilePath, hash: profileHash, required: true },
    { path: reportPath, hash: loadedReport.report?.hash ?? loadedReport.malformed[0]?.hash ?? null, required: true },
  ];
  const checkId = `RSCHK_delivery_profile_${slug(profile.profile_id)}_confidence_calibration`;
  const publicFacing = profile.release_mode === "public" || profile.release_mode === "external";
  if (loadedReport.malformed.length > 0) {
    return makeCheck(checkId, publicFacing ? "blocker" : "warning", "fail", `${profile.profile_id}: confidence calibration report malformed: ${loadedReport.malformed.flatMap((item) => item.errors).join("; ")}`, refs);
  }
  if (!loadedReport.report) {
    return makeCheck(checkId, publicFacing ? "blocker" : "warning", "fail", `${profile.profile_id}: requires calibrated confidence but confidence_calibration_report.json is absent`, refs);
  }

  const current = currentCalibrationArtifactVersions(projectDir);
  const staleKeys = staleArtifactVersionKeys(loadedReport.report.report, current);
  if (staleKeys.length > 0) {
    return makeCheck(checkId, "warning", "fail", `${profile.profile_id}: confidence calibration report stale for ${staleKeys.join(", ")}`, refs);
  }

  return makeCheck(checkId, "info", "pass", `${profile.profile_id}: confidence calibration report is present and fresh`, refs);
}

function makeCheck(
  checkId: string,
  severity: ReleaseSafetyCheck["severity"],
  status: ReleaseSafetyCheck["status"],
  message: string,
  artifactRefs: ReleaseSafetyCheck["artifact_refs"],
): ReleaseSafetyCheck {
  return {
    check_id: checkId,
    category: "delivery_profile",
    severity,
    status,
    message,
    artifact_refs: artifactRefs,
  };
}

function readArtifactVersion(filePath: string): string {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as { artifact_version?: unknown; version?: unknown };
    if (typeof parsed.artifact_version === "string") return parsed.artifact_version;
    if (typeof parsed.version === "string") return parsed.version;
  } catch {
    return "unknown";
  }
  return "unknown";
}

function sha256File(filePath: string): string {
  return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
}

function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}
