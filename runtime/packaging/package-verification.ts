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
import { resolveDeliveryArtifactPaths } from "./active-delivery.js";
import {
  resolveProjectRenderRoute,
  type RenderRouteDecision,
  type RenderRouteReceipt,
} from "../render/route-resolver.js";
import { HYPERFRAMES_RENDERER_VERSION } from "../content/hyperframes-renderer.js";
import { REMOTION_RENDERER_VERSION } from "../render/remotion/render-remotion.js";
import {
  captionFontContractForReceipt,
} from "../caption/font-contract.js";
import { execFileSync } from "node:child_process";
import {
  assertAlphaLayerMediaContract,
  probeAlphaLayerMediaSync,
  type AlphaLayerMediaContract,
} from "../render/alpha-layer-contract.js";
import { loadContentRenderPlan } from "../content/render-plan.js";
import { verifyDerivedVideoProvenance } from "./derived-video-provenance.js";

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

export function verifyExistingPackage(projectDir: string): PackageVerificationResult {
  const absDir = path.resolve(projectDir);
  try {
    const delivery = resolveDeliveryArtifactPaths(absDir, { verifyHashes: true });
    return verifyExistingPackageInternal(absDir, {
      qaReportPath: delivery.qaReportPath,
      packageManifestPath: delivery.packageManifestPath,
      finalVideoPath: delivery.finalVideoPath,
      captionApprovalPath: delivery.captionApprovalPath,
      allowApprovedState: delivery.source === "active_delivery",
    });
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
  const absDir = path.resolve(projectDir);
  try {
    return verifyExistingPackageInternal(absDir, paths);
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
  if (manifest.source_of_truth === "engine_render") {
    verifyRenderProvenance(checks, absDir, manifest, finalVideoPath);
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
  }) === JSON.stringify({
    renderer_versions: render.renderer_versions,
    layer_receipts: render.layer_receipts,
    font_receipt: render.font_receipt,
    delivery_execution: render.delivery_execution,
    inputs: render.inputs,
    outputs: render.outputs,
  });
  addCheck(
    checks,
    "render_provenance_summary_matches_receipt",
    summaryMatches,
    summaryMatches ? "manifest summary is receipt-derived" : "manifest render summary drifted",
  );

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

  const currentFfmpeg = execFileSync("ffmpeg", ["-version"], {
    encoding: "utf8",
  }).split(/\r?\n/, 1)[0].trim();
  const expectedRendererVersions = {
    ffmpeg: currentFfmpeg,
    ...(receipt.visual_layers.some((layer) => layer.renderer === "hyperframes")
      ? { hyperframes: HYPERFRAMES_RENDERER_VERSION }
      : {}),
    ...(receipt.base_engine === "remotion"
      || receipt.visual_layers.some((layer) => layer.renderer === "remotion")
      ? { remotion: REMOTION_RENDERER_VERSION }
      : {}),
  };
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

function resolveArtifactPath(projectDir: string, declaredPath: string): string {
  return path.isAbsolute(declaredPath)
    ? path.resolve(declaredPath)
    : path.resolve(projectDir, declaredPath);
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
