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
import { resolveDeliveryArtifactPathsStrict } from "./active-delivery.js";
import {
  resolveProjectRenderRoute,
  routeCapabilityHash,
  type RenderRouteEvidence,
  type RenderRouteReceipt,
  type RenderRouteDecision,
} from "../render/route-resolver.js";
import { resolveCanonicalCaptionVisualTreatmentInput } from "../render/canonical-render-input.js";
import { computeNormalizedJsonHash } from "../artifacts/p1-manifest-coverage.js";
import type { CaptionVisualTreatmentInput } from "../caption/visual-treatment.js";
import { HYPERFRAMES_RENDERER_VERSION } from "../content/hyperframes-renderer.js";
import { REMOTION_RENDERER_VERSION } from "../render/remotion/render-remotion.js";
import {
  captionFontContractForReceipt,
} from "../caption/font-contract.js";
import {
  assertAlphaLayerMediaContract,
  probeAlphaLayerMediaSync,
  type AlphaLayerMediaContract,
  validateAlphaOverlayExportReceipt,
} from "../render/alpha-layer-contract.js";
import { loadContentRenderPlan } from "../content/render-plan.js";
import { verifyDerivedVideoProvenance } from "./derived-video-provenance.js";
import {
  liveRendererVersionProvider,
  type RendererVersionProvider,
} from "./renderer-version-provider.js";
import { checkMusicMasterAudioPlan } from "./qa.js";
import {
  hashAudioRenderPlan,
  type AudioRenderPlan,
} from "../audio/render-plan.js";
import { resolveSharedAudioRenderPlan } from "../audio/render-route.js";
import type { AudioMixReport } from "../audio/mixer.js";

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
  artifacts?: {
    layout_snapshot?: string;
  };
}

type ReadinessLabel = PackageVerificationResult["readinessLabel"];

export interface PackageVerificationPaths {
  qaReportPath: string;
  packageManifestPath: string;
  finalVideoPath: string;
  captionApprovalPath: string;
  allowApprovedState?: boolean;
}

export interface PackageArtifactClosureFailure {
  kind: "missing" | "empty" | "path_escape" | "hash_mismatch";
  artifact: string;
  path: string;
}

/** Verifies every manifest artifact reference, including caption arrays, against contained current bytes. */
export function verifyPackageArtifactClosure(projectDirInput: string, manifest: PackageManifest): PackageArtifactClosureFailure[] {
  const projectDir = fs.realpathSync(path.resolve(projectDirInput));
  const entries: Array<[string, { path: string; sha256: string }]> = [];
  for (const [name, value] of Object.entries(manifest.artifacts)) {
    if (Array.isArray(value)) value.forEach((artifact, index) => entries.push([`${name}[${index}]`, artifact]));
    else if (value) entries.push([name, value]);
  }
  const failures: PackageArtifactClosureFailure[] = [];
  for (const [name, artifact] of entries) {
    const lexical = path.isAbsolute(artifact.path) ? path.resolve(artifact.path) : path.resolve(projectDir, artifact.path);
    if (!fs.existsSync(lexical)) {
      failures.push({ kind: "missing", artifact: name, path: artifact.path });
      continue;
    }
    let real: string;
    try { real = fs.realpathSync(lexical); } catch { failures.push({ kind: "missing", artifact: name, path: artifact.path }); continue; }
    if (!real.startsWith(`${projectDir}${path.sep}`) || !fs.statSync(real).isFile()) {
      failures.push({ kind: "path_escape", artifact: name, path: artifact.path });
      continue;
    }
    if (fs.statSync(real).size === 0) failures.push({ kind: "empty", artifact: name, path: artifact.path });
    if (computeSha256(real) !== artifact.sha256) failures.push({ kind: "hash_mismatch", artifact: name, path: artifact.path });
  }
  return failures;
}

export function verifyExistingPackage(projectDir: string): PackageVerificationResult {
  return verifyExistingPackageWithRendererVersionProvider(
    projectDir,
    liveRendererVersionProvider,
  );
}

export function verifyExistingPackageWithRendererVersionProvider(
  projectDir: string,
  rendererVersionProvider: RendererVersionProvider,
): PackageVerificationResult {
  const absDir = path.resolve(projectDir);
  try {
    const delivery = resolveDeliveryArtifactPathsStrict(absDir);
    return verifyExistingPackageInternal(absDir, {
      qaReportPath: delivery.qaReportPath,
      packageManifestPath: delivery.packageManifestPath,
      finalVideoPath: delivery.finalVideoPath,
      captionApprovalPath: delivery.captionApprovalPath,
      allowApprovedState: delivery.source === "active_delivery",
    }, rendererVersionProvider);
  } catch (error) {
    return finish(absDir, [{
      name: "package_verification_completed",
      passed: false,
      details: errorMessage(error),
    }], "package contract mismatch");
  }
}

export function verifyPackageGeneration(
  projectDir: string,
  paths: PackageVerificationPaths,
): PackageVerificationResult {
  return verifyPackageGenerationWithRendererVersionProvider(
    projectDir,
    paths,
    liveRendererVersionProvider,
  );
}

export function verifyPackageGenerationWithRendererVersionProvider(
  projectDir: string,
  paths: PackageVerificationPaths,
  rendererVersionProvider: RendererVersionProvider,
): PackageVerificationResult {
  const absDir = path.resolve(projectDir);
  try {
    return verifyExistingPackageInternal(absDir, paths, rendererVersionProvider);
  } catch (error) {
    return finish(absDir, [{
      name: "package_verification_completed",
      passed: false,
      details: errorMessage(error),
    }], "package contract mismatch");
  }
}

function verifyExistingPackageInternal(
  projectDir: string,
  paths: PackageVerificationPaths,
  rendererVersionProvider: RendererVersionProvider,
): PackageVerificationResult {
  const absDir = path.resolve(projectDir);
  const timelinePath = path.join(absDir, "05_timeline", "timeline.json");
  const qaPath = path.resolve(paths.qaReportPath);
  const manifestPath = path.resolve(paths.packageManifestPath);
  const finalVideoPath = path.resolve(paths.finalVideoPath);
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
  const closureFailures = verifyPackageArtifactClosure(absDir, manifest);
  addCheck(
    checks,
    "package_artifact_closure_valid",
    closureFailures.length === 0,
    closureFailures.length === 0 ? "all declared package artifact bytes are present, non-empty, contained, and hash-bound" : closureFailures.map((failure) => `${failure.artifact}:${failure.kind}:${failure.path}`).join("; "),
  );

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
  if (timelineDeclaresMusicMaster(timelineRead.value)) {
    verifyMusicMasterPackageContract(
      checks,
      absDir,
      timelinePath,
      manifestPath,
      finalVideoPath,
    );
  }

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
  const stateCompatible = state?.current_state === "packaged"
    || (paths.allowApprovedState === true && state?.current_state === "approved");
  addCheck(
    checks,
    paths.allowApprovedState ? "project_state_is_delivery_compatible" : "project_state_is_packaged",
    stateCompatible,
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
  const derivedProvenanceRequired =
    manifest.version === "1.1.0" || manifest.version === "1.2.0";
  const derivedProvenanceRef = manifest.artifacts.derived_video_provenance;
  if (derivedProvenanceRequired || derivedProvenanceRef) {
    if (!derivedProvenanceRef) {
      addCheck(
        checks,
        "derived_video_provenance_present",
        false,
        `package_manifest/v${manifest.version} requires derived_video_provenance`,
      );
    } else {
      const derivedProvenancePath = resolveArtifactPath(absDir, derivedProvenanceRef.path);
      verifyCanonicalArtifact(
        checks,
        absDir,
        derivedProvenanceRef,
        derivedProvenancePath,
        "derived_video_provenance",
      );
      const verification = verifyDerivedVideoProvenance({
        projectDir: absDir,
        provenancePath: derivedProvenancePath,
        expectedFinalVideoPath: finalVideoPath,
        ...(timelineDeclaresMusicMaster(timelineRead.value)
          ? {
              sourceInputs: createSourceInputAttestation(absDir, {
                timelinePath,
                includeAudio: false,
              }),
            }
          : {}),
      });
      addCheck(
        checks,
        "derived_video_provenance_matches_live_artifacts",
        verification.valid,
        verification.valid ? "all provenance bindings match" : verification.errors.join("; "),
      );
    }
  }
  const layoutSnapshotRequired = manifest.version === "1.2.0";
  const layoutSnapshotRef = manifest.artifacts.layout_snapshot;
  if (layoutSnapshotRequired || layoutSnapshotRef) {
    if (!layoutSnapshotRef) {
      addCheck(
        checks,
        "layout_snapshot_present",
        false,
        "package_manifest/v1.2 requires layout_snapshot",
      );
    } else {
      const qaLayoutPath = qa.artifacts?.layout_snapshot;
      const canonicalLayoutPath = qaLayoutPath
        ? resolveArtifactPath(absDir, qaLayoutPath)
        : path.join(path.dirname(qaPath), "layout-qa-snapshot.json");
      addCheck(
        checks,
        "layout_snapshot_qa_reference_matches",
        Boolean(qaLayoutPath) &&
          path.resolve(resolveArtifactPath(absDir, layoutSnapshotRef.path)) ===
            path.resolve(canonicalLayoutPath),
        qaLayoutPath
          ? `manifest=${layoutSnapshotRef.path} qa=${qaLayoutPath}`
          : "QA report is missing artifacts.layout_snapshot",
      );
      verifyCanonicalArtifact(
        checks,
        absDir,
        layoutSnapshotRef,
        canonicalLayoutPath,
        "layout_snapshot",
      );
    }
  }
  const actualTimelineHash = computeFileHash(timelinePath);
  addCheck(
    checks,
    "editorial_timeline_hash_matches",
    manifest.provenance.editorial_timeline_hash === actualTimelineHash,
    `manifest=${manifest.provenance.editorial_timeline_hash} actual=${actualTimelineHash}`,
  );

  const captionApprovalHash = optionalFileHash(path.resolve(paths.captionApprovalPath));
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
    if (manifest.provenance.nle_receipt_required === true
      || manifest.provenance.route_receipt
      || manifest.provenance.route_evidence) {
      verifyNleRouteEvidence(checks, absDir, manifest, finalVideoPath);
    }
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
        const attestation = createSourceInputAttestation(absDir, {
          includeAudio: !timelineDeclaresMusicMaster(timelineRead.value),
        });
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
  if (manifest.source_of_truth === "engine_render") {
    verifyRenderProvenance(
      checks,
      absDir,
      manifest,
      finalVideoPath,
      rendererVersionProvider,
    );
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

function verifyRenderProvenance(
  checks: PackageVerificationCheck[],
  projectDir: string,
  manifest: PackageManifest,
  canonicalFinalVideoPath: string,
  rendererVersionProvider: RendererVersionProvider,
): void {
  const render = manifest.provenance.render;
  if (!render) {
    addCheck(checks, "render_provenance_present", false, "engine_render requires provenance.render");
    return;
  }
  addCheck(checks, "render_provenance_present", true, render.contract_version);
  const receiptPath = resolveArtifactPath(projectDir, render.route_receipt.path);
  const receiptPresent = fs.existsSync(receiptPath);
  addCheck(
    checks,
    "render_route_receipt_hash_matches",
    receiptPresent && computeSha256(receiptPath) === render.route_receipt.sha256,
    receiptPresent
      ? hashDetails(render.route_receipt.sha256, computeSha256(receiptPath))
      : `missing=${receiptPath}`,
  );

  if (!receiptPresent) return;
  const read = readJson(receiptPath);
  if (!read.ok) {
    addCheck(checks, "render_route_receipt_readable", false, read.error);
    return;
  }
  const receipt = read.value as RenderRouteReceipt;
  const routeSchema = receipt.route_evidence
    ? validateAgainstSchema(receipt, "render-route-receipt.schema.json")
    : { valid: true, errors: [] as string[] };
  addCheck(
    checks,
    "render_route_receipt_schema_valid",
    routeSchema.valid,
    routeSchema.valid
      ? receipt.route_evidence ? "schema=render-route-receipt" : "legacy receipt schema compatibility path"
      : routeSchema.errors.join("; "),
  );
  if (render.caption_visual_treatment) {
    verifyCaptionVisualTreatmentFreshness(checks, projectDir, render, receipt);
  } else if (
    receipt.inputs.typography_policy
    || receipt.inputs.visual_treatment_patch
    || receipt.inputs.caption_visual_treatment_input
  ) {
    addCheck(
      checks,
      "caption_visual_treatment_provenance_complete",
      false,
      "visual-treatment artifacts are referenced without a canonical visual-treatment summary",
    );
  }
  addCheck(
    checks,
    "render_route_receipt_version_valid",
    receipt.receipt_version === "render-route-receipt/v3",
    `version=${String(receipt.receipt_version)}`,
  );
  const summaryMatches = JSON.stringify({
    renderer_versions: receipt.renderer_versions,
    layer_receipts: receipt.layer_receipts,
    font_receipt: receipt.font_receipt,
    delivery_execution: receipt.delivery_execution,
    inputs: receipt.inputs,
    outputs: receipt.outputs,
    route_evidence: receipt.route_evidence,
  }) === JSON.stringify({
    renderer_versions: render.renderer_versions,
    layer_receipts: render.layer_receipts,
    font_receipt: render.font_receipt,
    delivery_execution: render.delivery_execution,
    inputs: render.inputs,
    outputs: render.outputs,
    route_evidence: render.route_evidence,
  });
  addCheck(
    checks,
    "render_provenance_summary_matches_receipt",
    summaryMatches,
    summaryMatches ? "manifest summary is receipt-derived" : "manifest render summary drifted",
  );
  if (receipt.route_evidence) {
    verifyRenderRouteEvidence(
      checks,
      projectDir,
      manifest,
      receipt,
      canonicalFinalVideoPath,
    );
  } else {
    // Older package-v1 fixtures remain readable. New pipeline receipts always
    // carry this evidence, and the summary comparison above prevents a newer
    // manifest from silently dropping it.
    addCheck(
      checks,
      "render_route_evidence_legacy_compatibility",
      true,
      "legacy render-route receipt has no RFA-013/014/024 evidence",
    );
  }

  try {
    const current = resolveProjectRenderRoute(
      projectDir,
      receipt.requested_assembly_engine,
    );
    const routeFields = (value: RenderRouteDecision) => ({
      version: value.version,
      requested_assembly_engine: value.requested_assembly_engine,
      assembly_engine: value.assembly_engine,
      base_engine: value.base_engine,
      visual_layers: value.visual_layers,
      caption_layer: value.caption_layer,
      delivery: value.delivery,
      style_family: value.style_family,
      genre: value.genre,
    });
    const matches = JSON.stringify(routeFields(current))
      === JSON.stringify(routeFields(receipt));
    addCheck(
      checks,
      "render_route_matches_canonical_inputs",
      matches,
      matches ? "route re-resolved from canonical artifacts" : "render route drift detected",
    );
  } catch (error) {
    addCheck(checks, "render_route_matches_canonical_inputs", false, errorMessage(error));
  }

  const expectedRendererVersions = rendererVersionProvider.rendererVersionsFor(receipt);
  addCheck(
    checks,
    "renderer_versions_match_runtime",
    JSON.stringify(receipt.renderer_versions) === JSON.stringify(expectedRendererVersions),
    `receipt=${JSON.stringify(receipt.renderer_versions)} runtime=${JSON.stringify(expectedRendererVersions)}`,
  );

  const h264Generations = receipt.delivery_execution.operations.filter(
    (operation) => operation.kind === "lossy_video_generation"
      && operation.codec === "h264",
  ).length;
  addCheck(
    checks,
    "lossy_video_encode_passes_match_execution",
    receipt.delivery_execution.definition === "sequential_h264_generations/v1"
      && receipt.delivery_execution.lossy_video_encode_passes === h264Generations
      && h264Generations >= receipt.delivery.lossy_video_encode_passes,
    `declared=${receipt.delivery_execution.lossy_video_encode_passes} `
      + `operations=${h264Generations} planned_minimum=${receipt.delivery.lossy_video_encode_passes}`,
  );

  verifyReceiptArtifact(checks, projectDir, receipt.inputs.timeline, "render_input_timeline");
  addCheck(
    checks,
    "render_input_timeline_is_canonical",
    computeSha256(path.join(projectDir, "05_timeline", "timeline.json"))
      === receipt.inputs.timeline.sha256,
    hashDetails(
      receipt.inputs.timeline.sha256,
      computeSha256(path.join(projectDir, "05_timeline", "timeline.json")),
    ),
  );
  if (receipt.inputs.caption_approval) {
    verifyReceiptArtifact(
      checks,
      projectDir,
      receipt.inputs.caption_approval,
      "render_input_caption_approval",
    );
  }
  const finalHash = computeSha256(canonicalFinalVideoPath);
  addCheck(
    checks,
    "render_output_final_video_hash_matches",
    receipt.outputs.final_video.sha256 === finalHash,
    hashDetails(receipt.outputs.final_video.sha256, finalHash),
  );
  for (const [index, layer] of receipt.layer_receipts.entries()) {
    verifyReceiptArtifact(checks, projectDir, layer, `render_layer_receipt_${index}`);
    const layerPath = resolveArtifactPath(projectDir, layer.path);
    if (!fs.existsSync(layerPath)) continue;
    const layerRead = readJson(layerPath);
    const layerValue = layerRead.ok ? layerRead.value as Record<string, unknown> & {
      media?: AlphaLayerMediaContract;
      overlay_path?: string;
      overlay_sha256?: string;
      composite_stage?: string;
    } : {};
    const expectedVersion = layer.renderer === "hyperframes"
      ? HYPERFRAMES_RENDERER_VERSION
      : REMOTION_RENDERER_VERSION;
    addCheck(
      checks,
      `render_layer_receipt_${index}_renderer_version_matches`,
      layerValue.renderer === layer.renderer
        && layerValue.renderer_version === expectedVersion,
      `renderer=${String(layerValue.renderer)} version=${String(layerValue.renderer_version)}`,
    );
    try {
      const overlayPath = resolveArtifactPath(projectDir, String(layerValue.overlay_path ?? ""));
      const overlayHash = computeSha256(overlayPath).replace(/^sha256:/, "");
      const plan = loadContentRenderPlan(path.join(projectDir, "05_timeline", "timeline.json"));
      const liveMedia = probeAlphaLayerMediaSync(overlayPath);
      assertAlphaLayerMediaContract(liveMedia, {
        width: plan.width,
        height: plan.height,
        fpsNum: plan.fps_num,
        fpsDen: plan.fps_den,
        durationFrames: plan.duration_frames,
      });
      addCheck(
        checks,
        `render_layer_receipt_${index}_media_matches`,
        layerValue.overlay_sha256 === overlayHash
          && Boolean(layerValue.media)
          && JSON.stringify(layerValue.media) === JSON.stringify(liveMedia),
        `overlay_hash=${overlayHash} receipt_hash=${String(layerValue.overlay_sha256)}`,
      );
    } catch (error) {
      addCheck(
        checks,
        `render_layer_receipt_${index}_media_matches`,
        false,
        errorMessage(error),
      );
    }
  }
  const expectedLayerKeys = receipt.visual_layers
    .filter((layer) => !layer.embedded_in_base)
    .map((layer) => `${layer.renderer}:${layer.composite_stage}`)
    .filter((key, index, values) => values.indexOf(key) === index)
    .sort();
  const actualLayerKeys = receipt.layer_receipts.map((layer, index) => {
    const layerPath = resolveArtifactPath(projectDir, layer.path);
    const layerRead = readJson(layerPath);
    const value = layerRead.ok ? layerRead.value as { composite_stage?: unknown } : {};
    return `${layer.renderer}:${String(value.composite_stage ?? "")}`;
  }).sort();
  addCheck(
    checks,
    "render_layer_receipts_complete",
    JSON.stringify(expectedLayerKeys) === JSON.stringify(actualLayerKeys),
    `expected=${expectedLayerKeys.join(",") || "-"} actual=${actualLayerKeys.join(",") || "-"}`,
  );
  addCheck(
    checks,
    "render_font_receipt_presence_matches_route",
    (receipt.caption_layer.engine === "ffmpeg-libass") === Boolean(receipt.font_receipt),
    `caption_engine=${receipt.caption_layer.engine} font_receipt=${Boolean(receipt.font_receipt)}`,
  );
  if (receipt.font_receipt) {
    verifyReceiptArtifact(checks, projectDir, receipt.font_receipt, "render_font_receipt");
    const fontPath = resolveArtifactPath(projectDir, receipt.font_receipt.path);
    try {
      const fontReceipt = JSON.parse(fs.readFileSync(fontPath, "utf8")) as {
        version?: unknown;
        styling_class?: unknown;
        contract?: unknown;
        staged_font_manifest?: { path?: unknown; sha256?: unknown };
      };
      const currentContract = captionFontContractForReceipt(
        String(fontReceipt.styling_class ?? ""),
      );
      addCheck(
        checks,
        "render_font_receipt_matches_runtime_contract",
        fontReceipt.version === "caption-font-receipt/v1"
          && JSON.stringify(fontReceipt.contract) === JSON.stringify(currentContract),
        `styling_class=${String(fontReceipt.styling_class)}`,
      );
      if (fontReceipt.staged_font_manifest) {
        const stagedPath = resolveArtifactPath(
          projectDir,
          String(fontReceipt.staged_font_manifest.path ?? ""),
        );
        addCheck(
          checks,
          "render_staged_font_manifest_hash_matches",
          fs.existsSync(stagedPath)
            && computeSha256(stagedPath) === fontReceipt.staged_font_manifest.sha256,
          fs.existsSync(stagedPath)
            ? hashDetails(
                String(fontReceipt.staged_font_manifest.sha256),
                computeSha256(stagedPath),
              )
            : `missing=${stagedPath}`,
        );
      }
    } catch (error) {
      addCheck(checks, "render_font_receipt_matches_runtime_contract", false, errorMessage(error));
    }
  }
}

function verifyRenderRouteEvidence(
  checks: PackageVerificationCheck[],
  projectDir: string,
  manifest: PackageManifest,
  receipt: RenderRouteReceipt,
  canonicalFinalVideoPath: string,
): void {
  const evidence = receipt.route_evidence;
  if (!evidence) return;
  const canonical = evidence.route_kind === "canonical_engine_render";
  addCheck(
    checks,
    "render_route_is_canonical_engine_for_engine_package",
    canonical
      && evidence.ownership === "canonical"
      && evidence.canonical_claim === true,
    `route_kind=${evidence.route_kind} ownership=${evidence.ownership} canonical_claim=${evidence.canonical_claim}`,
  );
  addCheck(
    checks,
    "render_route_status_allows_engine_package",
    evidence.status !== "blocked" && (!canonical || evidence.handoff.required === false),
    `status=${evidence.status} handoff_required=${evidence.handoff.required}`,
  );

  const timelineMatches = JSON.stringify(evidence.source_identity.timeline)
    === JSON.stringify(receipt.inputs.timeline);
  addCheck(
    checks,
    "render_route_source_timeline_matches_receipt",
    timelineMatches,
    timelineMatches ? "route source identity is receipt-bound" : "route source timeline drifted",
  );
  if (canonical) {
    verifyReceiptArtifact(
      checks,
      projectDir,
      evidence.source_identity.timeline,
      "render_route_source_timeline",
    );
    const canonicalTimelinePath = path.join(projectDir, "05_timeline", "timeline.json");
    addCheck(
      checks,
      "render_route_source_timeline_is_canonical",
      path.resolve(evidence.source_identity.timeline.path) === path.resolve(canonicalTimelinePath),
      `route=${path.resolve(evidence.source_identity.timeline.path)} canonical=${path.resolve(canonicalTimelinePath)}`,
    );
  }

  const manifestSourceHash = normalizeSha256(manifest.provenance.source_inputs_hash);
  const routeSourceHash = normalizeSha256(evidence.source_identity.source_inputs_hash);
  addCheck(
    checks,
    "render_route_source_inputs_hash_matches_manifest",
    !canonical || (manifestSourceHash !== null && routeSourceHash === manifestSourceHash),
    `manifest=${manifestSourceHash ?? "-"} route=${routeSourceHash ?? "-"}`,
  );

  const capabilityHash = canonical
    ? routeCapabilityHash({
        decision: receipt,
        visualTreatmentInputHash: evidence.visual_treatment.input_hash,
        visualTreatmentProfileHash: evidence.visual_treatment.profile_hash,
        audioPlanHash: evidence.audio.plan_hash,
      })
    : null;
  addCheck(
    checks,
    "render_route_capability_hash_matches",
    !canonical || capabilityHash === evidence.route_capability.hash,
    `declared=${evidence.route_capability.hash} actual=${capabilityHash ?? "external-route"}`,
  );

  const captionsEnabled = receipt.caption_layer.engine !== "none";
  const caption = evidence.caption_ownership;
  const captionOwnerValid = captionsEnabled
    ? caption.approval_status === "approved"
      && caption.burn_render_owner === "ffmpeg-libass"
      && caption.burn_render_claim === "canonical"
      && caption.renderer_count === 1
      && Boolean(caption.approval)
      && caption.approval_hash === receipt.inputs.caption_approval?.sha256
    : caption.approval_status === "not_applicable"
      && caption.renderer_count === 0
      && caption.burn_render_claim === "not_applicable";
  addCheck(
    checks,
    "render_route_caption_ownership_is_single_canonical_owner",
    !canonical || captionOwnerValid,
    `enabled=${captionsEnabled} approval=${caption.approval_status} burn_owner=${caption.burn_render_owner} claim=${caption.burn_render_claim} renderer_count=${caption.renderer_count}`,
  );
  if (caption.approval) {
    verifyReceiptArtifact(checks, projectDir, caption.approval, "render_route_caption_approval");
    addCheck(
      checks,
      "render_route_caption_approval_matches_receipt",
      JSON.stringify(caption.approval) === JSON.stringify(receipt.inputs.caption_approval),
      "route caption approval is bound to render receipt input",
    );
  }

  if (evidence.visual_treatment.input) {
    verifyReceiptArtifact(checks, projectDir, evidence.visual_treatment.input, "render_route_visual_treatment_input");
    addCheck(
      checks,
      "render_route_visual_treatment_input_matches_receipt",
      JSON.stringify(evidence.visual_treatment.input) === JSON.stringify(receipt.inputs.caption_visual_treatment_input),
      "route visual-treatment input is bound to render receipt input",
    );
  }

  const unsupportedAnimations = evidence.ass_capability.unsupported_animations;
  const unsupportedDecisionRegistered = unsupportedAnimations.length === 0
    || ["registered_fallback", "nle_handoff", "blocked"].includes(evidence.ass_capability.decision);
  const unsupportedHasRecord = unsupportedAnimations.length === 0
    || evidence.degradation.some((item) => item.code === "unsupported_ass_animation");
  addCheck(
    checks,
    "render_route_unsupported_ass_animation_is_explicit",
    unsupportedDecisionRegistered && unsupportedHasRecord,
    unsupportedAnimations.length === 0
      ? "no unsupported ASS animation declared"
      : `decision=${evidence.ass_capability.decision} degradation_recorded=${unsupportedHasRecord}`,
  );

  const alphaReceipts = [
    ...(evidence.alpha ? [evidence.alpha] : []),
    ...evidence.alpha_overlays.filter((candidate) => candidate !== evidence.alpha),
  ];
  alphaReceipts.forEach((alpha, index) => {
    const validation = validateAlphaOverlayExportReceipt(alpha);
    addCheck(
      checks,
      `render_alpha_receipt_${index}_valid`,
      validation.valid,
      validation.valid ? "alpha overlay receipt is structurally valid" : validation.errors.join(","),
    );
    const canonicalAlpha = alpha.status === "canonical";
    addCheck(
      checks,
      `render_alpha_receipt_${index}_ownership_truthful`,
      alpha.canonical_claim === canonicalAlpha
        && (!canonicalAlpha || (alpha.ownership === "canonical" && alpha.output !== null))
        && (!canonical || canonicalAlpha),
      `status=${alpha.status} ownership=${alpha.ownership} canonical_claim=${alpha.canonical_claim}`,
    );
    if (canonicalAlpha) {
      verifyReceiptArtifact(checks, projectDir, alpha.source, `render_alpha_receipt_${index}_source`);
      if (alpha.output) verifyReceiptArtifact(checks, projectDir, alpha.output, `render_alpha_receipt_${index}_output`);
    }
  });
  addCheck(
    checks,
    "render_alpha_receipt_presence_matches_route",
    evidence.alpha === null
      ? receipt.visual_layers.every((layer) => layer.embedded_in_base)
      : evidence.alpha_overlays.length >= receipt.visual_layers.filter((layer) => !layer.embedded_in_base).length,
    evidence.alpha === null
      ? "no alpha overlay declared"
      : `alpha_overlays=${evidence.alpha_overlays.length}`,
  );

  addCheck(
    checks,
    "render_route_agent_qa_separate_from_human_approval",
    evidence.agent_qa.status !== undefined && evidence.human_approval.status !== undefined,
    `agent_qa=${evidence.agent_qa.status} human_approval=${evidence.human_approval.status}`,
  );

  addCheck(
    checks,
    "render_route_final_output_is_canonical",
    !canonical || receipt.outputs.final_video.sha256 === computeSha256(canonicalFinalVideoPath),
    `route=${receipt.outputs.final_video.path} final=${canonicalFinalVideoPath}`,
  );
}

function normalizeSha256(value: string | undefined | null): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (/^sha256:[a-f0-9]{64}$/.test(normalized)) return normalized;
  if (/^[a-f0-9]{64}$/.test(normalized)) return `sha256:${normalized}`;
  return null;
}

function verifyNleRouteEvidence(
  checks: PackageVerificationCheck[],
  projectDir: string,
  manifest: PackageManifest,
  finalVideoPath: string,
): void {
  const receiptRef = manifest.provenance.route_receipt;
  const evidence = manifest.provenance.route_evidence;
  addCheck(
    checks,
    "nle_route_evidence_present",
    Boolean(receiptRef && evidence),
    receiptRef && evidence ? "supplied/external route receipt and evidence are present" : "route receipt and evidence must be supplied together",
  );
  if (!receiptRef || !evidence) return;
  const receiptPath = resolveArtifactPath(projectDir, receiptRef.path);
  const present = fs.existsSync(receiptPath);
  addCheck(
    checks,
    "nle_route_receipt_hash_matches",
    present && computeSha256(receiptPath) === receiptRef.sha256,
    present ? hashDetails(receiptRef.sha256, computeSha256(receiptPath)) : `missing=${receiptPath}`,
  );
  if (!present) return;
  const read = readJson(receiptPath);
  if (!read.ok) {
    addCheck(checks, "nle_route_receipt_readable", false, read.error);
    return;
  }
  const receipt = read.value as RenderRouteReceipt;
  const schema = validateAgainstSchema(receipt, "render-route-receipt.schema.json");
  addCheck(
    checks,
    "nle_route_receipt_schema_valid",
    schema.valid,
    schema.valid ? "schema=render-route-receipt" : schema.errors.join("; "),
  );
  addCheck(
    checks,
    "nle_route_receipt_matches_manifest_evidence",
    JSON.stringify(receipt.route_evidence) === JSON.stringify(evidence),
    "manifest route evidence is receipt-derived",
  );
  addCheck(
    checks,
    "nle_route_is_explicit_external_or_supplied",
    (evidence.route_kind === "supplied_final" || evidence.route_kind === "external_manual_nle")
      && evidence.ownership !== "canonical"
      && evidence.canonical_claim === false,
    `route_kind=${evidence.route_kind} ownership=${evidence.ownership} canonical_claim=${evidence.canonical_claim}`,
  );
  const actualFinalHash = computeSha256(finalVideoPath);
  const routeOutputHash = receipt.outputs?.final_video?.sha256;
  addCheck(
    checks,
    "nle_route_output_matches_packaged_final",
    (evidence.route_kind === "supplied_final" || evidence.route_kind === "external_manual_nle")
      && routeOutputHash === actualFinalHash,
    hashDetails(routeOutputHash, actualFinalHash),
  );
  addCheck(
    checks,
    "nle_route_handoff_status_recorded",
    evidence.handoff.required === true
      && evidence.handoff.status !== "not_required"
      && evidence.human_approval.status !== undefined
      && evidence.agent_qa.status !== undefined,
    `handoff=${evidence.handoff.status} agent_qa=${evidence.agent_qa.status} human_approval=${evidence.human_approval.status}`,
  );
  for (const [index, alpha] of evidence.alpha_overlays.entries()) {
    const validation = validateAlphaOverlayExportReceipt(alpha);
    addCheck(
      checks,
      `nle_alpha_receipt_${index}_valid`,
      validation.valid,
      validation.valid ? "alpha overlay receipt is structurally valid" : validation.errors.join(","),
    );
    addCheck(
      checks,
      `nle_alpha_receipt_${index}_never_canonical`,
      alpha.canonical_claim === false && alpha.ownership !== "canonical",
      `ownership=${alpha.ownership} canonical_claim=${alpha.canonical_claim}`,
    );
  }
}

function visualTreatmentSummary(value: {
  status: CaptionVisualTreatmentInput["status"];
  approval_hash: string;
  visual_treatment_patch_hash: string | null;
  typography_policy_hash: string;
  platform_safe_zone_profile_id?: string | null;
  platform_safe_zone_profile_path?: string | null;
  platform_safe_zone_profile_hash?: string | null;
  accessibility?: CaptionVisualTreatmentInput["accessibility"] | null;
  text_timing_hash: string;
  capability_hash: string;
  input_hash: string;
  applied_caption_ids: string[];
  degraded_reasons: Array<{ caption_id: string; reason: string }>;
  blocked_reasons: Array<{ caption_id: string; reason: string }>;
}) {
  return {
    status: value.status,
    approval_hash: value.approval_hash,
    visual_treatment_patch_hash: value.visual_treatment_patch_hash,
    typography_policy_hash: value.typography_policy_hash,
    platform_safe_zone_profile_id: value.platform_safe_zone_profile_id ?? null,
    platform_safe_zone_profile_path: value.platform_safe_zone_profile_path ?? null,
    platform_safe_zone_profile_hash: value.platform_safe_zone_profile_hash ?? null,
    accessibility: value.accessibility ?? null,
    text_timing_hash: value.text_timing_hash,
    capability_hash: value.capability_hash,
    input_hash: value.input_hash,
    applied_caption_ids: value.applied_caption_ids,
    degraded_reasons: value.degraded_reasons,
    blocked_reasons: value.blocked_reasons,
  };
}

function verifyCaptionVisualTreatmentFreshness(
  checks: PackageVerificationCheck[],
  projectDir: string,
  render: NonNullable<PackageManifest["provenance"]["render"]>,
  receipt: RenderRouteReceipt,
): void {
  const summary = render.caption_visual_treatment;
  if (!summary) return;
  const inputRef = receipt.inputs.caption_visual_treatment_input;
  const typographyRef = receipt.inputs.typography_policy;
  const patchRef = receipt.inputs.visual_treatment_patch;
  const reportRef = render.render_report;
  addCheck(
    checks,
    "caption_visual_treatment_provenance_complete",
    Boolean(inputRef && typographyRef && patchRef && reportRef),
    inputRef && typographyRef && patchRef && reportRef
      ? "all visual-treatment artifacts and render report are referenced"
      : "visual-treatment input, typography policy, patch, and render report references are required",
  );
  if (!inputRef || !typographyRef || !patchRef || !reportRef) return;

  verifyReceiptArtifact(checks, projectDir, typographyRef, "caption_visual_treatment_typography_policy");
  verifyReceiptArtifact(checks, projectDir, patchRef, "caption_visual_treatment_patch");
  verifyReceiptArtifact(checks, projectDir, inputRef, "caption_visual_treatment_input");
  verifyReceiptArtifact(checks, projectDir, reportRef, "render_report");

  const inputPath = resolveArtifactPath(projectDir, inputRef.path);
  const inputRead = readJson(inputPath);
  const inputSchema = inputRead.ok
    ? validateAgainstSchema(inputRead.value, "caption-visual-treatment-input.schema.json")
    : { valid: false, errors: [inputRead.error] };
  addCheck(
    checks,
    "caption_visual_treatment_input_schema_valid",
    inputSchema.valid,
    inputSchema.valid ? "schema=caption-visual-treatment-input" : inputSchema.errors.join("; "),
  );

  let canonical: CaptionVisualTreatmentInput | undefined;
  try {
    canonical = resolveCanonicalCaptionVisualTreatmentInput(projectDir, {
      approvalPath: receipt.inputs.caption_approval?.path,
      typographyPolicyPath: typographyRef.path,
      visualTreatmentPatchPath: patchRef.path,
    });
    addCheck(
      checks,
      "caption_visual_treatment_live_canonical_matches",
      inputRead.ok && computeNormalizedJsonHash(inputRead.value) === computeNormalizedJsonHash(canonical),
      inputRead.ok
        ? `artifact=${(inputRead.value as { input_hash?: string }).input_hash ?? "-"} canonical=${canonical.input_hash}`
        : "caption visual-treatment input is unreadable",
    );
    const expectedSummary = visualTreatmentSummary({
      ...canonical,
      input_hash: canonical.input_hash,
    });
    const receiptSummary = receipt.caption_visual_treatment
      ? visualTreatmentSummary(receipt.caption_visual_treatment)
      : undefined;
    addCheck(
      checks,
      "caption_visual_treatment_receipt_matches_canonical",
      JSON.stringify(expectedSummary) === JSON.stringify(receiptSummary),
      "route receipt visual-treatment summary matches the live canonical resolver",
    );
    addCheck(
      checks,
      "caption_visual_treatment_summary_matches_canonical",
      JSON.stringify(expectedSummary) === JSON.stringify(visualTreatmentSummary({ ...summary, input_hash: summary.resolved_input_hash })),
      "manifest visual-treatment summary matches the live canonical resolver",
    );
  } catch (error) {
    addCheck(checks, "caption_visual_treatment_live_canonical_matches", false, errorMessage(error));
    addCheck(checks, "caption_visual_treatment_summary_matches_canonical", false, "canonical visual-treatment input was not available");
  }

  const reportPath = resolveArtifactPath(projectDir, reportRef.path);
  const reportRead = readJson(reportPath);
  const reportSchema = reportRead.ok
    ? validateAgainstSchema(reportRead.value, "render-report.schema.json")
    : { valid: false, errors: [reportRead.error] };
  addCheck(
    checks,
    "render_report_schema_valid",
    reportSchema.valid,
    reportSchema.valid ? "schema=render-report" : reportSchema.errors.join("; "),
  );
  if (reportRead.ok && canonical && reportSchema.valid) {
    const report = reportRead.value as { caption_visual_treatment?: Omit<CaptionVisualTreatmentInput, "input_hash"> & { resolved_input_hash?: string; input_hash?: string } };
    const reportSummary = report.caption_visual_treatment
      ? visualTreatmentSummary({ ...report.caption_visual_treatment, input_hash: report.caption_visual_treatment.resolved_input_hash ?? "" })
      : undefined;
    const expectedReportSummary = visualTreatmentSummary({ ...canonical, input_hash: canonical.input_hash });
    addCheck(
      checks,
      "render_report_visual_treatment_matches_canonical",
      JSON.stringify(reportSummary) === JSON.stringify(expectedReportSummary),
      "render report visual-treatment summary matches the live canonical input",
    );
  }
}

function resolveArtifactPath(projectDir: string, declaredPath: string): string {
  return path.isAbsolute(declaredPath)
    ? path.resolve(declaredPath)
    : path.resolve(projectDir, declaredPath);
}

function timelineDeclaresMusicMaster(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const timeline = value as {
    metadata?: Record<string, unknown>;
    provenance?: Record<string, unknown>;
  };
  const policy = timeline.provenance?.audio_policy;
  return Boolean((policy && typeof policy === "object" && !Array.isArray(policy)
    && ((policy as Record<string, unknown>).mode === "music_master"
      || (policy as Record<string, unknown>).music_master !== undefined))
    || timeline.provenance?.music_master !== undefined
    || timeline.metadata?.music_master !== undefined);
}

function verifyMusicMasterPackageContract(
  checks: PackageVerificationCheck[],
  projectDir: string,
  timelinePath: string,
  manifestPath: string,
  finalVideoPath: string,
): void {
  let plan: AudioRenderPlan | undefined;
  try {
    const resolved = resolveSharedAudioRenderPlan({
      projectDir,
      timelinePath,
      musicCuesPath: fs.existsSync(path.join(projectDir, "07_package", "music_cues.json"))
        ? path.join(projectDir, "07_package", "music_cues.json")
        : undefined,
      sfxCuesPath: fs.existsSync(path.join(projectDir, "07_package", "sfx_cues.json"))
        ? path.join(projectDir, "07_package", "sfx_cues.json")
        : undefined,
    });
    plan = resolved?.strategy === "music_master" ? resolved : undefined;
    if (!plan) {
      addCheck(checks, "music_master_audio_contract_valid", false, "timeline declares music_master but no canonical music_master plan was resolved");
      return;
    }
  } catch (error) {
    addCheck(checks, "music_master_audio_contract_valid", false, `canonical music_master plan resolution failed: ${errorMessage(error)}`);
    return;
  }

  const packageRoot = path.dirname(manifestPath);
  const manifestRead = readJson(manifestPath);
  const manifest = manifestRead.ok ? manifestRead.value as PackageManifest : undefined;
  const planRef = (manifest
    ? manifest.provenance.render?.inputs.audio_render_plan
    : undefined);
  if (!planRef) {
    addCheck(checks, "music_master_audio_plan_receipt_binding_valid", false, "package manifest render receipt is missing audio_render_plan identity");
  } else {
    const planPath = resolveArtifactPath(projectDir, planRef.path);
    const planRead = readJson(planPath);
    const schema = planRead.ok
      ? validateAgainstSchema(planRead.value, "audio-render-plan.schema.json")
      : { valid: false, errors: [planRead.error] };
    const planHashMatches = planRead.ok
      && schema.valid
      && hashAudioRenderPlan(planRead.value as AudioRenderPlan) === hashAudioRenderPlan(plan)
      && computeSha256(planPath) === planRef.sha256;
    addCheck(
      checks,
      "music_master_audio_plan_receipt_binding_valid",
      planHashMatches,
      planHashMatches
        ? `package render receipt binds canonical AudioRenderPlan ${hashAudioRenderPlan(plan)}`
        : `package render receipt audio plan is stale or hash-mismatched path=${planRef.path}`,
    );
  }

  const reportPath = path.join(packageRoot, "logs", "audio-mix-report.json");
  const manifestReportRef = manifest?.artifacts.audio_mix_report;
  const routeReportRef = manifest?.provenance.render?.inputs.audio_mix_report;
  const reportRefCheck = (
    ref: { path: string; sha256: string } | undefined,
  ): { pathMatches: boolean; hashMatches: boolean } => {
    if (!ref || typeof ref.path !== "string" || typeof ref.sha256 !== "string") {
      return { pathMatches: false, hashMatches: false };
    }
    let declaredPath: string;
    try {
      declaredPath = resolveArtifactPath(projectDir, ref.path);
    } catch {
      return { pathMatches: false, hashMatches: false };
    }
    return {
      pathMatches: declaredPath === path.resolve(reportPath),
      hashMatches: fs.existsSync(reportPath) && computeSha256(reportPath) === ref.sha256,
    };
  };
  const manifestReportCheck = reportRefCheck(manifestReportRef);
  const routeReportCheck = reportRefCheck(routeReportRef);
  addCheck(
    checks,
    "music_master_audio_report_manifest_artifact_binding_valid",
    manifestReportCheck.pathMatches && manifestReportCheck.hashMatches,
    manifestReportRef
      ? `manifest audio-mix-report path=${manifestReportCheck.pathMatches} hash=${manifestReportCheck.hashMatches}`
      : "package manifest is missing the canonical audio_mix_report artifact",
  );
  addCheck(
    checks,
    "music_master_audio_report_route_binding_valid",
    routeReportCheck.pathMatches && routeReportCheck.hashMatches,
    routeReportRef
      ? `route audio-mix-report path=${routeReportCheck.pathMatches} hash=${routeReportCheck.hashMatches}`
      : "package render receipt is missing the canonical audio_mix_report input",
  );
  addCheck(
    checks,
    "music_master_audio_report_manifest_route_identity_matches",
    manifestReportCheck.pathMatches && manifestReportCheck.hashMatches
      && routeReportCheck.pathMatches && routeReportCheck.hashMatches
      && manifestReportRef?.path === routeReportRef?.path
      && manifestReportRef?.sha256 === routeReportRef?.sha256,
    manifestReportRef && routeReportRef
      ? "manifest and render route bind the same audio-mix-report path and hash"
      : "manifest and render route must both bind audio-mix-report",
  );
  const reportRead = readJson(reportPath);
  const reportSchema = reportRead.ok
    ? validateAgainstSchema(reportRead.value, "audio-mix-report.schema.json")
    : { valid: false, errors: [reportRead.error] };
  addCheck(
    checks,
    "music_master_audio_receipt_schema_valid",
    reportSchema.valid,
    reportSchema.valid ? "schema=audio-mix-report" : reportSchema.errors.join("; "),
  );
  const audioContractCheck = reportRead.ok && reportSchema.valid
    ? checkMusicMasterAudioPlan(plan, reportRead.value as AudioMixReport, {
        finalMixPath: path.join(packageRoot, "audio", "final_mix.wav"),
        masteredMp3Path: path.join(packageRoot, "audio", "music_master_320.mp3"),
        finalVideoPath,
        projectDir,
      })
    : undefined;
  addCheck(
    checks,
    "music_master_audio_contract_valid",
    audioContractCheck?.passed === true,
    audioContractCheck?.details ?? "music_master audio-mix-report is missing or schema-invalid",
  );
}

function verifyReceiptArtifact(
  checks: PackageVerificationCheck[],
  projectDir: string,
  artifact: { path: string; sha256: string },
  name: string,
): void {
  const filePath = resolveArtifactPath(projectDir, artifact.path);
  const exists = fs.existsSync(filePath);
  addCheck(
    checks,
    `${name}_hash_matches`,
    exists && computeSha256(filePath) === artifact.sha256,
    exists ? hashDetails(artifact.sha256, computeSha256(filePath)) : `missing=${filePath}`,
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
