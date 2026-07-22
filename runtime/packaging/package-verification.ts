import * as fs from "node:fs";
import * as path from "node:path";
import { validateAgainstSchema } from "../commands/shared.js";
import { createSourceInputAttestation } from "../render/source-input-attestation.js";
import { computeFileHash, readProjectState } from "../state/reconcile.js";
import {
  computePackagingProjectionHash,
  computeSha256,
  type PackageManifest,
} from "./manifest.js";

export interface PackageVerificationCheck {
  name: string;
  passed: boolean;
  details: string;
}

export interface PackageVerificationResult {
  ready: boolean;
  projectDir: string;
  readinessLabel:
    | "render packaged"
    | "not rendered"
    | "package incomplete"
    | "qa report unreadable"
    | "package manifest unreadable"
    | "qa failed"
    | "package contract mismatch";
  issues: string[];
  checks: PackageVerificationCheck[];
  projectId?: string;
  sourceOfTruth?: "engine_render" | "nle_finishing";
}

interface PackageQAReport {
  version: string;
  project_id: string;
  source_of_truth: "engine_render" | "nle_finishing";
  qa_profile: "engine_render" | "nle_finishing";
  passed: boolean;
  checks: Array<{ name: string; passed: boolean; details: string }>;
}

type ReadinessLabel = PackageVerificationResult["readinessLabel"];

export function verifyExistingPackage(projectDir: string): PackageVerificationResult {
  const absDir = path.resolve(projectDir);
  try {
    return verifyExistingPackageInternal(absDir);
  } catch (error) {
    return finish(absDir, [{
      name: "package_verification_completed",
      passed: false,
      details: errorMessage(error),
    }], "package contract mismatch");
  }
}

function verifyExistingPackageInternal(projectDir: string): PackageVerificationResult {
  const absDir = path.resolve(projectDir);
  const timelinePath = path.join(absDir, "05_timeline", "timeline.json");
  const qaPath = path.join(absDir, "07_package", "qa-report.json");
  const manifestPath = path.join(absDir, "07_package", "package_manifest.json");
  const finalVideoPath = path.join(absDir, "09_output", "final.mp4");
  const statePath = path.join(absDir, "project_state.yaml");
  const checks: PackageVerificationCheck[] = [];

  const packageArtifacts = [qaPath, manifestPath, finalVideoPath];
  const requiredFiles = [timelinePath, ...packageArtifacts, statePath];
  const present = requiredFiles.filter((filePath) => fs.existsSync(filePath));
  addCheck(
    checks,
    "required_artifacts_present",
    present.length === requiredFiles.length,
    present.length === requiredFiles.length
      ? "timeline, QA report, manifest, final video, and project state are present"
      : `missing=${requiredFiles.filter((filePath) => !fs.existsSync(filePath)).map((filePath) => path.relative(absDir, filePath)).join(",")}`,
  );
  if (packageArtifacts.every((filePath) => !fs.existsSync(filePath))) {
    return finish(absDir, checks, "not rendered");
  }
  if (present.length !== requiredFiles.length) {
    return finish(absDir, checks, "package incomplete");
  }

  const qaRead = readJson(qaPath);
  addCheck(checks, "qa_report_json_readable", qaRead.ok, qaRead.ok ? "JSON parsed" : qaRead.error);
  if (!qaRead.ok) return finish(absDir, checks, "qa report unreadable");
  const qaSchema = validateAgainstSchema(qaRead.value, "package-qa-report.schema.json");
  addCheck(
    checks,
    "qa_report_schema_valid",
    qaSchema.valid,
    qaSchema.valid ? "schema=package-qa-report" : qaSchema.errors.join("; "),
  );
  if (!qaSchema.valid) return finish(absDir, checks, "qa report unreadable");
  const qa = qaRead.value as PackageQAReport;

  const manifestRead = readJson(manifestPath);
  addCheck(
    checks,
    "package_manifest_json_readable",
    manifestRead.ok,
    manifestRead.ok ? "JSON parsed" : manifestRead.error,
  );
  if (!manifestRead.ok) {
    return finish(absDir, checks, "package manifest unreadable", qa.project_id, qa.source_of_truth);
  }
  const manifestSchema = validateAgainstSchema(manifestRead.value, "package-manifest.schema.json");
  addCheck(
    checks,
    "package_manifest_schema_valid",
    manifestSchema.valid,
    manifestSchema.valid ? "schema=package-manifest" : manifestSchema.errors.join("; "),
  );
  if (!manifestSchema.valid) {
    return finish(absDir, checks, "package manifest unreadable", qa.project_id, qa.source_of_truth);
  }
  const manifest = manifestRead.value as PackageManifest;

  const timelineRead = readJson(timelinePath);
  addCheck(
    checks,
    "timeline_json_readable",
    timelineRead.ok,
    timelineRead.ok ? "JSON parsed" : timelineRead.error,
  );
  if (!timelineRead.ok) {
    return finish(absDir, checks, "package contract mismatch", qa.project_id, qa.source_of_truth);
  }
  const timelineSchema = validateAgainstSchema(timelineRead.value, "timeline-ir.schema.json");
  addCheck(
    checks,
    "timeline_schema_valid",
    timelineSchema.valid,
    timelineSchema.valid ? "schema=timeline-ir" : timelineSchema.errors.join("; "),
  );

  let state: ReturnType<typeof readProjectState>;
  try {
    state = readProjectState(absDir);
    addCheck(checks, "project_state_readable", state !== null, state ? "YAML parsed" : "project_state.yaml is missing");
  } catch (error) {
    addCheck(checks, "project_state_readable", false, errorMessage(error));
    state = null;
  }
  const stateSchema = state === null
    ? { valid: false, errors: ["project_state.yaml did not decode to a document"] }
    : validateAgainstSchema(state, "project-state.schema.json");
  addCheck(
    checks,
    "project_state_schema_valid",
    stateSchema.valid,
    stateSchema.valid ? "schema=project-state" : stateSchema.errors.join("; "),
  );

  const timeline = timelineRead.value as { version?: unknown; project_id?: unknown };
  const timelineProjectId = typeof timeline.project_id === "string" ? timeline.project_id : undefined;
  const timelineVersion = typeof timeline.version === "string" ? timeline.version : undefined;
  const stateSource = state?.handoff_resolution?.source_of_truth_decision;
  const projectIds = [timelineProjectId, state?.project_id, qa.project_id, manifest.project_id];
  addCheck(
    checks,
    "project_identity_matches",
    projectIds.every((value) => value === timelineProjectId) && Boolean(timelineProjectId),
    `timeline=${timelineProjectId ?? "-"} state=${state?.project_id ?? "-"} qa=${qa.project_id} manifest=${manifest.project_id}`,
  );
  addCheck(
    checks,
    "source_of_truth_matches",
    qa.source_of_truth === qa.qa_profile
      && qa.source_of_truth === manifest.source_of_truth
      && qa.source_of_truth === stateSource,
    `state=${stateSource ?? "-"} qa=${qa.source_of_truth} profile=${qa.qa_profile} manifest=${manifest.source_of_truth}`,
  );
  addCheck(
    checks,
    "project_state_is_packaged",
    state?.current_state === "packaged",
    `current_state=${state?.current_state ?? "-"}`,
  );
  addCheck(
    checks,
    "base_timeline_version_matches",
    Boolean(timelineVersion) && manifest.base_timeline_version === timelineVersion,
    `timeline=${timelineVersion ?? "-"} manifest=${manifest.base_timeline_version}`,
  );

  const qaHasChecks = qa.checks.length > 0;
  const allQAChecksPassed = qaHasChecks && qa.checks.every((check) => check.passed);
  addCheck(
    checks,
    "qa_has_checks",
    qaHasChecks,
    qaHasChecks ? `${qa.checks.length} QA checks declared` : "QA report has no checks",
  );
  addCheck(
    checks,
    "qa_result_consistent",
    qa.passed === allQAChecksPassed,
    `passed=${qa.passed} all_checks_passed=${allQAChecksPassed}`,
  );
  addCheck(
    checks,
    "qa_passed",
    qa.passed && allQAChecksPassed,
    qa.passed && allQAChecksPassed
      ? `${qa.checks.length} QA checks passed`
      : `failed=${qa.checks.filter((check) => !check.passed).map((check) => check.name).join(",") || "aggregate_result"}`,
  );

  verifyCanonicalArtifact(checks, absDir, manifest.artifacts.final_video, finalVideoPath, "final_video");
  verifyCanonicalArtifact(checks, absDir, manifest.artifacts.qa_report, qaPath, "qa_report");
  const actualTimelineHash = computeFileHash(timelinePath);
  addCheck(
    checks,
    "editorial_timeline_hash_matches",
    manifest.provenance.editorial_timeline_hash === actualTimelineHash,
    `manifest=${manifest.provenance.editorial_timeline_hash} actual=${actualTimelineHash}`,
  );

  const captionApprovalHash = optionalFileHash(path.join(absDir, "07_package", "caption_approval.json"));
  const musicCuesHash = manifest.source_of_truth === "engine_render"
    ? optionalFileHash(path.join(absDir, "07_package", "music_cues.json"))
    : undefined;
  const renderDefaultsHash = optionalFileHash(path.join(absDir, "runtime", "render-pipeline-defaults.yaml"));
  addCheck(
    checks,
    "caption_approval_provenance_matches",
    manifest.provenance.caption_approval_hash === captionApprovalHash,
    hashDetails(manifest.provenance.caption_approval_hash, captionApprovalHash),
  );
  addCheck(
    checks,
    "music_cues_provenance_matches",
    manifest.provenance.music_cues_hash === musicCuesHash,
    hashDetails(manifest.provenance.music_cues_hash, musicCuesHash),
  );
  addCheck(
    checks,
    "render_defaults_provenance_matches",
    manifest.provenance.render_defaults_hash === renderDefaultsHash,
    hashDetails(manifest.provenance.render_defaults_hash, renderDefaultsHash),
  );
  const projectionHash = computePackagingProjectionHash({
    captionApprovalHash,
    musicCuesHash,
    renderDefaultsHash,
  });
  addCheck(
    checks,
    "packaging_projection_hash_matches",
    manifest.packaging_projection_hash === projectionHash,
    `manifest=${manifest.packaging_projection_hash} actual=${projectionHash}`,
  );

  if (manifest.source_of_truth === "nle_finishing") {
    addCheck(
      checks,
      "handoff_provenance_matches",
      Boolean(state?.handoff_resolution?.handoff_id)
        && manifest.provenance.handoff_id === state?.handoff_resolution?.handoff_id,
      `manifest=${manifest.provenance.handoff_id ?? "-"} state=${state?.handoff_resolution?.handoff_id ?? "-"}`,
    );
  }
  const sourceInputsRequired = manifest.source_of_truth === "engine_render";
  const sourceInputsDeclared = Boolean(
    manifest.provenance.source_inputs_hash || manifest.provenance.source_inputs_attestation_status,
  );
  if (sourceInputsRequired || sourceInputsDeclared) {
    if (!manifest.provenance.source_inputs_hash || !manifest.provenance.source_inputs_attestation_status) {
      addCheck(
        checks,
        "source_inputs_provenance_matches",
        false,
        sourceInputsRequired
          ? "engine_render requires source_inputs_hash and source_inputs_attestation_status"
          : "source_inputs_hash and source_inputs_attestation_status must be present together",
      );
    } else {
      try {
        const attestation = createSourceInputAttestation(absDir);
        addCheck(
          checks,
          "source_inputs_provenance_matches",
          manifest.provenance.source_inputs_hash === attestation.source_inputs_hash
            && manifest.provenance.source_inputs_attestation_status === attestation.status,
          `manifest=${manifest.provenance.source_inputs_hash}/${manifest.provenance.source_inputs_attestation_status ?? "-"} actual=${attestation.source_inputs_hash}/${attestation.status}`,
        );
      } catch (error) {
        addCheck(checks, "source_inputs_provenance_matches", false, errorMessage(error));
      }
    }
  }

  const qaFailed = !qa.passed || !allQAChecksPassed;
  const ready = timelineSchema.valid && checks.every((check) => check.passed);
  return finish(
    absDir,
    checks,
    ready ? "render packaged" : qaFailed ? "qa failed" : "package contract mismatch",
    timelineProjectId ?? qa.project_id,
    qa.source_of_truth,
  );
}

function verifyCanonicalArtifact(
  checks: PackageVerificationCheck[],
  projectDir: string,
  artifact: { path: string; sha256: string },
  canonicalPath: string,
  name: string,
): void {
  const declaredPath = path.isAbsolute(artifact.path)
    ? path.resolve(artifact.path)
    : path.resolve(projectDir, artifact.path);
  addCheck(
    checks,
    `${name}_path_is_canonical`,
    declaredPath === canonicalPath,
    `manifest=${declaredPath} canonical=${canonicalPath}`,
  );
  const actualHash = computeSha256(canonicalPath);
  addCheck(
    checks,
    `${name}_hash_matches`,
    artifact.sha256 === actualHash,
    `manifest=${artifact.sha256} actual=${actualHash}`,
  );
}

function readJson(filePath: string):
  | { ok: true; value: unknown }
  | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(filePath, "utf8")) };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

function optionalFileHash(filePath: string): string | undefined {
  return fs.existsSync(filePath) ? computeFileHash(filePath) : undefined;
}

function addCheck(
  checks: PackageVerificationCheck[],
  name: string,
  passed: boolean,
  details: string,
): void {
  checks.push({ name, passed, details });
}

function finish(
  projectDir: string,
  checks: PackageVerificationCheck[],
  readinessLabel: ReadinessLabel,
  projectId?: string,
  sourceOfTruth?: "engine_render" | "nle_finishing",
): PackageVerificationResult {
  return {
    ready: readinessLabel === "render packaged" && checks.every((check) => check.passed),
    projectDir,
    readinessLabel,
    issues: checks.filter((check) => !check.passed).map((check) => `${check.name}: ${check.details}`),
    checks,
    ...(projectId ? { projectId } : {}),
    ...(sourceOfTruth ? { sourceOfTruth } : {}),
  };
}

function hashDetails(declared: string | undefined, actual: string | undefined): string {
  return `manifest=${declared ?? "-"} actual=${actual ?? "-"}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
