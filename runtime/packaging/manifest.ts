/**
 * Package manifest generation.
 *
 * Builds the package_manifest.json for both engine_render and
 * nle_finishing paths, computing SHA-256 hashes for all artifacts
 * and assembling provenance records.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { RenderRouteEvidence, RenderRouteReceipt } from "../render/route-resolver.js";
import { captionVisualTreatmentReceiptSummary, type CaptionVisualTreatmentInput } from "../caption/visual-treatment.js";
import { validateAgainstSchema } from "../commands/shared.js";
import { hashAudioRenderPlan, type AudioRenderPlan } from "../audio/render-plan.js";

export interface PackageRenderProvenance {
  contract_version: "render-provenance/v1";
  route_receipt: { path: string; sha256: string };
  renderer_versions: RenderRouteReceipt["renderer_versions"];
  layer_receipts: RenderRouteReceipt["layer_receipts"];
  font_receipt?: RenderRouteReceipt["font_receipt"];
  delivery_execution: RenderRouteReceipt["delivery_execution"];
  inputs: RenderRouteReceipt["inputs"];
  outputs: RenderRouteReceipt["outputs"];
  route_evidence: NonNullable<RenderRouteReceipt["route_evidence"]>;
  caption_visual_treatment?: {
    status: CaptionVisualTreatmentInput["status"];
    approval_hash: string;
    visual_treatment_patch_hash: string | null;
    typography_policy_hash: string;
    platform_safe_zone_profile_id: string | null;
    platform_safe_zone_profile_path: string | null;
    platform_safe_zone_profile_hash: string | null;
    accessibility: CaptionVisualTreatmentInput["accessibility"] | null;
    text_timing_hash: string;
    capability_hash: string;
    resolved_input_hash: string;
    applied_caption_ids: string[];
    degraded_reasons: Array<{ caption_id: string; reason: string }>;
    blocked_reasons: Array<{ caption_id: string; reason: string }>;
  };
  render_report?: { path: string; sha256: string };
}

// ── Types ──────────────────────────────────────────────────────────

export interface PackageManifest {
  version: string;
  project_id: string;
  source_of_truth: "engine_render" | "nle_finishing";
  base_timeline_version: string;
  packaging_projection_hash: string;
  created_at: string;
  artifacts: {
    final_video: { path: string; sha256: string };
    raw_video?: { path: string; sha256: string };
    raw_dialogue?: { path: string; sha256: string };
    final_mix?: { path: string; sha256: string };
    mastered_mp3?: { path: string; sha256: string };
    audio_mix_report?: { path: string; sha256: string };
    captions?: Array<{
      kind: string;
      delivery: string;
      path: string;
      sha256: string;
    }>;
    qa_report: { path: string; sha256: string };
    derived_video_provenance?: { path: string; sha256: string };
    layout_snapshot?: { path: string; sha256: string };
  };
  provenance: {
    editorial_timeline_hash: string;
    caption_approval_hash?: string;
    music_cues_hash?: string;
    ffmpeg_version?: string;
    remotion_bundle_hash?: string;
    render_defaults_hash?: string;
    handoff_id?: string;
    source_inputs_hash?: string;
    source_inputs_attestation_status?: "verified" | "live_only" | "not_applicable";
    source_inputs_freshness_reason?: string;
    /** New NLE manifests must carry an explicit route receipt. */
    nle_receipt_required?: true;
    route_receipt?: { path: string; sha256: string };
    route_evidence?: RenderRouteEvidence;
    render?: PackageRenderProvenance;
  };
}

// ── Hash Functions ─────────────────────────────────────────────────

/**
 * Compute SHA-256 hash of a file.
 * Returns the full hex digest prefixed with "sha256:".
 */
export function computeSha256(filePath: string): string {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
  try {
    for (;;) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return `sha256:${hash.digest("hex")}`;
}

/**
 * Compute packaging projection hash from caption/music/render state.
 * This is a hash of the concatenation of all provided component hashes.
 */
export function computePackagingProjectionHash(components: {
  captionApprovalHash?: string;
  musicCuesHash?: string;
  renderDefaultsHash?: string;
}): string {
  const parts = [
    components.captionApprovalHash ?? "",
    components.musicCuesHash ?? "",
    components.renderDefaultsHash ?? "",
  ].join("+");

  return crypto.createHash("sha256").update(parts).digest("hex");
}

// ── Artifact Helpers ───────────────────────────────────────────────

function artifactEntry(
  filePath: string,
): { path: string; sha256: string } | null {
  if (!fs.existsSync(filePath)) return null;
  return {
    path: filePath,
    sha256: computeSha256(filePath),
  };
}

function planRequiresMasteredMp3(planPath: string | undefined): boolean {
  if (!planPath || !fs.existsSync(planPath)) return false;
  try {
    const plan = JSON.parse(fs.readFileSync(planPath, "utf8")) as Partial<AudioRenderPlan>;
    return plan.strategy === "music_master" && plan.music_master?.audio_decision === "mastering";
  } catch {
    return false;
  }
}

// ── Engine Render Manifest ─────────────────────────────────────────

/**
 * Build manifest for the engine_render path.
 * Scans the output directory for expected artifacts, computes hashes,
 * and assembles the manifest with full provenance.
 */
export function buildEngineRenderManifest(opts: {
  projectId: string;
  baseTimelineVersion: string;
  editorialTimelineHash: string;
  outputDir: string; // 07_package/
  finalVideoPath?: string;
  captionApprovalHash?: string;
  musicCuesHash?: string;
  ffmpegVersion?: string;
  renderDefaultsHash?: string;
  sourceInputsHash: string;
  sourceInputsAttestationStatus: "verified" | "live_only" | "not_applicable";
  sourceInputsFreshnessReason?: string;
  captionPolicy: { source: string; delivery_mode: string };
  renderRouteReceiptPath: string;
  derivedVideoProvenancePath?: string;
  layoutSnapshotPath?: string;
  captionVisualTreatmentInput?: CaptionVisualTreatmentInput;
  renderReportPath?: string;
  /** Persist the canonical plan reference in the render route receipt. */
  audioRenderPlanPath?: string;
  createdAt?: string;
}): PackageManifest {
  const { outputDir, captionPolicy } = opts;
  const routeReceipt = JSON.parse(
    fs.readFileSync(opts.renderRouteReceiptPath, "utf8"),
  ) as RenderRouteReceipt;
  if (routeReceipt.receipt_version !== "render-route-receipt/v3") {
    throw new Error("render_route_receipt_version_invalid");
  }
  if (!routeReceipt.route_evidence) {
    throw new Error("render_route_receipt_evidence_missing");
  }
  const renderProvenance: PackageRenderProvenance = {
    contract_version: "render-provenance/v1",
    route_receipt: {
      path: path.resolve(opts.renderRouteReceiptPath),
      sha256: computeSha256(opts.renderRouteReceiptPath),
    },
    renderer_versions: routeReceipt.renderer_versions,
    layer_receipts: routeReceipt.layer_receipts,
    ...(routeReceipt.font_receipt ? { font_receipt: routeReceipt.font_receipt } : {}),
    delivery_execution: routeReceipt.delivery_execution,
    inputs: routeReceipt.inputs,
    outputs: routeReceipt.outputs,
    route_evidence: routeReceipt.route_evidence,
    ...(opts.captionVisualTreatmentInput ? {
      caption_visual_treatment: (() => {
        const summary = captionVisualTreatmentReceiptSummary(opts.captionVisualTreatmentInput);
        return {
          status: summary.status,
          approval_hash: summary.approval_hash,
          visual_treatment_patch_hash: summary.visual_treatment_patch_hash,
          typography_policy_hash: summary.typography_policy_hash,
          platform_safe_zone_profile_id: summary.platform_safe_zone_profile_id,
          platform_safe_zone_profile_path: summary.platform_safe_zone_profile_path,
          platform_safe_zone_profile_hash: summary.platform_safe_zone_profile_hash,
          accessibility: summary.accessibility,
          text_timing_hash: summary.text_timing_hash,
          capability_hash: summary.capability_hash,
          resolved_input_hash: summary.input_hash,
          applied_caption_ids: summary.applied_caption_ids,
          degraded_reasons: summary.degraded_reasons,
          blocked_reasons: summary.blocked_reasons,
        };
      })(),
    } : {}),
    ...(opts.renderReportPath && fs.existsSync(opts.renderReportPath)
      ? { render_report: { path: path.resolve(opts.renderReportPath), sha256: computeSha256(opts.renderReportPath) } }
      : {}),
  };
  if (opts.renderReportPath && !fs.existsSync(opts.renderReportPath)) {
    throw new Error(`Required artifact not found: ${opts.renderReportPath}`);
  }
  if (opts.audioRenderPlanPath && !fs.existsSync(opts.audioRenderPlanPath)) {
    throw new Error(`Required artifact not found: ${opts.audioRenderPlanPath}`);
  }

  // Final video
  const finalVideoPath = opts.finalVideoPath ?? path.join(outputDir, "video", "final.mp4");
  const finalVideo = artifactEntry(finalVideoPath);
  if (!finalVideo) {
    throw new Error(`Required artifact not found: ${finalVideoPath}`);
  }

  // QA report
  const qaReportPath = path.join(outputDir, "qa-report.json");
  const qaReport = artifactEntry(qaReportPath);
  if (!qaReport) {
    throw new Error(`Required artifact not found: ${qaReportPath}`);
  }
  const derivedVideoProvenance = opts.derivedVideoProvenancePath
    ? artifactEntry(opts.derivedVideoProvenancePath)
    : null;
  if (opts.derivedVideoProvenancePath && !derivedVideoProvenance) {
    throw new Error(`Required artifact not found: ${opts.derivedVideoProvenancePath}`);
  }
  const layoutSnapshot = opts.layoutSnapshotPath
    ? artifactEntry(opts.layoutSnapshotPath)
    : null;
  if (opts.layoutSnapshotPath && !layoutSnapshot) {
    throw new Error(`Required artifact not found: ${opts.layoutSnapshotPath}`);
  }

  // Optional stems
  const rawVideo = artifactEntry(
    path.join(outputDir, "video", "raw_video.mp4"),
  );
  const rawDialogue = artifactEntry(
    path.join(outputDir, "audio", "raw_dialogue.wav"),
  );
  const finalMix = artifactEntry(
    path.join(outputDir, "audio", "final_mix.wav"),
  );
  const masteredMp3 = planRequiresMasteredMp3(opts.audioRenderPlanPath)
    ? artifactEntry(path.join(outputDir, "audio", "music_master_320.mp3"))
    : null;
  const audioMixReport = artifactEntry(
    path.join(outputDir, "logs", "audio-mix-report.json"),
  );

  // Caption sidecars
  const captions: Array<{
    kind: string;
    delivery: string;
    path: string;
    sha256: string;
  }> = [];

  if (captionPolicy.source !== "none") {
    if (
      captionPolicy.delivery_mode === "sidecar" ||
      captionPolicy.delivery_mode === "both"
    ) {
      const srtPath = path.join(outputDir, "captions", "speech.approved.srt");
      const srt = artifactEntry(srtPath);
      if (srt) {
        captions.push({ kind: "srt", delivery: "sidecar", ...srt });
      }

      const vttPath = path.join(outputDir, "captions", "speech.vtt");
      const vtt = artifactEntry(vttPath);
      if (vtt) {
        captions.push({ kind: "vtt", delivery: "sidecar", ...vtt });
      }
    }
  }

  // Packaging projection hash
  const packagingProjectionHash = computePackagingProjectionHash({
    captionApprovalHash: opts.captionApprovalHash,
    musicCuesHash: opts.musicCuesHash,
    renderDefaultsHash: opts.renderDefaultsHash,
  });

  const artifacts: PackageManifest["artifacts"] = {
    final_video: finalVideo,
    qa_report: qaReport,
    ...(derivedVideoProvenance
      ? { derived_video_provenance: derivedVideoProvenance }
      : {}),
    ...(layoutSnapshot ? { layout_snapshot: layoutSnapshot } : {}),
  };

  if (rawVideo) artifacts.raw_video = rawVideo;
  if (rawDialogue) artifacts.raw_dialogue = rawDialogue;
  if (finalMix) artifacts.final_mix = finalMix;
  if (masteredMp3) artifacts.mastered_mp3 = masteredMp3;
  if (audioMixReport) artifacts.audio_mix_report = audioMixReport;
  if (captions.length > 0) artifacts.captions = captions;

  return {
    version: derivedVideoProvenance && layoutSnapshot
        ? "1.2.0"
        : derivedVideoProvenance
          ? "1.1.0"
          : "1.0.0",
    project_id: opts.projectId,
    source_of_truth: "engine_render",
    base_timeline_version: opts.baseTimelineVersion,
    packaging_projection_hash: packagingProjectionHash,
    created_at: opts.createdAt ?? new Date().toISOString(),
    artifacts,
    provenance: {
      editorial_timeline_hash: opts.editorialTimelineHash,
      ...(opts.captionApprovalHash
        ? { caption_approval_hash: opts.captionApprovalHash }
        : {}),
      ...(opts.musicCuesHash
        ? { music_cues_hash: opts.musicCuesHash }
        : {}),
      ...(opts.ffmpegVersion
        ? { ffmpeg_version: opts.ffmpegVersion }
        : {}),
      ...(opts.renderDefaultsHash
        ? { render_defaults_hash: opts.renderDefaultsHash }
        : {}),
      source_inputs_hash: opts.sourceInputsHash,
      source_inputs_attestation_status: opts.sourceInputsAttestationStatus,
      ...(opts.sourceInputsFreshnessReason
        ? { source_inputs_freshness_reason: opts.sourceInputsFreshnessReason }
        : {}),
      render: renderProvenance,
    },
  };
}

// ── NLE Finishing Manifest ─────────────────────────────────────────

/**
 * Build manifest for the nle_finishing path.
 * Uses the operator-provided NLE export as the final video rather
 * than engine-rendered stems.
 */
export function buildNleFinishingManifest(opts: {
  projectId: string;
  baseTimelineVersion: string;
  editorialTimelineHash: string;
  outputDir: string;
  handoffId: string;
  captionApprovalHash?: string;
  ffmpegVersion?: string;
  renderDefaultsHash?: string;
  captionPolicy: { source: string; delivery_mode: string };
  finalVideoPath: string;
  qaReportPath: string;
  audioRenderPlanPath?: string;
  audioMixReportPath?: string;
  audioFinalMixPath?: string;
  audioMasteredMp3Path?: string;
  sidecarPaths?: string[];
  derivedVideoProvenancePath?: string;
  layoutSnapshotPath?: string;
  routeReceiptPath?: string;
  createdAt?: string;
}): PackageManifest {
  const { captionPolicy } = opts;

  // Final video (operator-provided)
  const finalVideo = artifactEntry(opts.finalVideoPath);
  if (!finalVideo) {
    throw new Error(
      `Required artifact not found: ${opts.finalVideoPath}`,
    );
  }

  // QA report
  const qaReport = artifactEntry(opts.qaReportPath);
  if (!qaReport) {
    throw new Error(
      `Required artifact not found: ${opts.qaReportPath}`,
    );
  }
  const derivedVideoProvenance = opts.derivedVideoProvenancePath
    ? artifactEntry(opts.derivedVideoProvenancePath)
    : null;
  if (opts.derivedVideoProvenancePath && !derivedVideoProvenance) {
    throw new Error(`Required artifact not found: ${opts.derivedVideoProvenancePath}`);
  }
  const layoutSnapshot = opts.layoutSnapshotPath
    ? artifactEntry(opts.layoutSnapshotPath)
    : null;
  if (opts.layoutSnapshotPath && !layoutSnapshot) {
    throw new Error(`Required artifact not found: ${opts.layoutSnapshotPath}`);
  }

  if (!opts.routeReceiptPath) {
    throw new Error("nle_route_receipt_required");
  }
  const routeReceipt = artifactEntry(opts.routeReceiptPath);
  if (!routeReceipt) {
    throw new Error(`Required artifact not found: ${opts.routeReceiptPath}`);
  }
  let routeDocument: RenderRouteReceipt;
  try {
    routeDocument = JSON.parse(fs.readFileSync(opts.routeReceiptPath, "utf8")) as RenderRouteReceipt;
  } catch (error) {
    throw new Error(`nle_route_receipt_invalid_json:${error instanceof Error ? error.message : String(error)}`);
  }
  const routeSchema = validateAgainstSchema(routeDocument, "render-route-receipt.schema.json");
  if (!routeSchema.valid) {
    throw new Error(`nle_route_receipt_schema_invalid:${routeSchema.errors.join("; ")}`);
  }
  const routeEvidence = routeDocument.route_evidence;
  if (!routeEvidence
    || (routeEvidence.route_kind !== "supplied_final" && routeEvidence.route_kind !== "external_manual_nle")
    || routeEvidence.ownership === "canonical"
    || routeEvidence.canonical_claim
    || routeDocument.outputs.final_video.sha256 !== finalVideo.sha256) {
    throw new Error("nle_route_receipt_must_bind_supplied_or_external_final");
  }

  const audioRenderPlan = opts.audioRenderPlanPath
    ? artifactEntry(opts.audioRenderPlanPath)
    : null;
  if (opts.audioRenderPlanPath && !audioRenderPlan) {
    throw new Error(`Required artifact not found: ${opts.audioRenderPlanPath}`);
  }
  const audioMixReport = opts.audioMixReportPath
    ? artifactEntry(opts.audioMixReportPath)
    : null;
  if (opts.audioMixReportPath && !audioMixReport) {
    throw new Error(`Required artifact not found: ${opts.audioMixReportPath}`);
  }
  if (Boolean(audioRenderPlan) !== Boolean(audioMixReport)) {
    throw new Error("nle_music_master_receipt_requires_plan_and_audio_mix_report");
  }
  const audioFinalMix = opts.audioFinalMixPath
    ? artifactEntry(opts.audioFinalMixPath)
    : null;
  if (opts.audioFinalMixPath && !audioFinalMix) {
    throw new Error(`Required artifact not found: ${opts.audioFinalMixPath}`);
  }
  const audioMasteredMp3 = opts.audioMasteredMp3Path
    ? artifactEntry(opts.audioMasteredMp3Path)
    : null;
  if (opts.audioMasteredMp3Path && !audioMasteredMp3) {
    throw new Error(`Required artifact not found: ${opts.audioMasteredMp3Path}`);
  }
  if (audioRenderPlan && !audioFinalMix) {
    throw new Error("nle_music_master_receipt_requires_final_mix");
  }
  if (audioRenderPlan && audioMixReport) {
    let planDocument: AudioRenderPlan;
    let reportDocument: Record<string, unknown>;
    try {
      planDocument = JSON.parse(fs.readFileSync(opts.audioRenderPlanPath!, "utf8")) as AudioRenderPlan;
      reportDocument = JSON.parse(fs.readFileSync(opts.audioMixReportPath!, "utf8")) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`nle_music_master_receipt_invalid_json:${error instanceof Error ? error.message : String(error)}`);
    }
    const planSchema = validateAgainstSchema(planDocument, "audio-render-plan.schema.json");
    const reportSchema = validateAgainstSchema(reportDocument, "audio-mix-report.schema.json");
    const reportMaster = reportDocument.music_master;
    const reportMeasurements = reportMaster && typeof reportMaster === "object" && !Array.isArray(reportMaster)
      ? (reportMaster as Record<string, unknown>).measurements
      : undefined;
    const reportFinalMux = reportMaster && typeof reportMaster === "object" && !Array.isArray(reportMaster)
      ? (reportMaster as Record<string, unknown>).final_mux
      : undefined;
    const measurementStatus = reportMeasurements && typeof reportMeasurements === "object" && !Array.isArray(reportMeasurements)
      ? (reportMeasurements as Record<string, unknown>).status
      : undefined;
    const finalMuxStatus = reportFinalMux && typeof reportFinalMux === "object" && !Array.isArray(reportFinalMux)
      ? ((reportFinalMux as Record<string, unknown>).measurements as Record<string, unknown> | undefined)?.status
      : undefined;
    if (!planSchema.valid || !reportSchema.valid
      || planDocument.strategy !== "music_master"
      || reportDocument.version !== "audio-mix-report/v2"
      || reportDocument.plan_hash !== hashAudioRenderPlan(planDocument)
      || measurementStatus !== "measured"
      || finalMuxStatus !== "measured") {
      throw new Error("nle_music_master_receipt_must_bind_a_measured_canonical_plan");
    }
  }

  // Caption sidecars
  const captions: Array<{
    kind: string;
    delivery: string;
    path: string;
    sha256: string;
  }> = [];

  if (
    captionPolicy.source !== "none" &&
    opts.sidecarPaths
  ) {
    for (const sidecarPath of opts.sidecarPaths) {
      const entry = artifactEntry(sidecarPath);
      if (entry) {
        const ext = path.extname(sidecarPath).toLowerCase().replace(".", "");
        captions.push({
          kind: ext === "vtt" ? "vtt" : "srt",
          delivery: "sidecar",
          ...entry,
        });
      }
    }
  }

  // Packaging projection hash (no music cues for NLE finishing)
  const packagingProjectionHash = computePackagingProjectionHash({
    captionApprovalHash: opts.captionApprovalHash,
    renderDefaultsHash: opts.renderDefaultsHash,
  });

  const artifacts: PackageManifest["artifacts"] = {
    final_video: finalVideo,
    qa_report: qaReport,
    ...(audioFinalMix ? { final_mix: audioFinalMix } : {}),
    ...(audioMasteredMp3 ? { mastered_mp3: audioMasteredMp3 } : {}),
    ...(audioMixReport ? { audio_mix_report: audioMixReport } : {}),
    ...(derivedVideoProvenance
      ? { derived_video_provenance: derivedVideoProvenance }
      : {}),
    ...(layoutSnapshot ? { layout_snapshot: layoutSnapshot } : {}),
  };

  if (captions.length > 0) artifacts.captions = captions;

  const render = audioRenderPlan && audioMixReport
    ? {
        contract_version: "render-provenance/v1" as const,
        route_receipt: routeReceipt,
        renderer_versions: routeDocument.renderer_versions,
        layer_receipts: routeDocument.layer_receipts,
        ...(routeDocument.font_receipt ? { font_receipt: routeDocument.font_receipt } : {}),
        delivery_execution: routeDocument.delivery_execution,
        inputs: {
          ...routeDocument.inputs,
          audio_render_plan: audioRenderPlan,
          audio_mix_report: audioMixReport,
        },
        outputs: routeDocument.outputs,
        route_evidence: routeEvidence,
      } satisfies PackageRenderProvenance
    : undefined;

  return {
    version: derivedVideoProvenance && layoutSnapshot
      ? "1.2.0"
      : derivedVideoProvenance
      ? "1.1.0"
      : "1.0.0",
    project_id: opts.projectId,
    source_of_truth: "nle_finishing",
    base_timeline_version: opts.baseTimelineVersion,
    packaging_projection_hash: packagingProjectionHash,
    created_at: opts.createdAt ?? new Date().toISOString(),
    artifacts,
    provenance: {
      editorial_timeline_hash: opts.editorialTimelineHash,
      ...(opts.captionApprovalHash
        ? { caption_approval_hash: opts.captionApprovalHash }
        : {}),
      ...(opts.ffmpegVersion
        ? { ffmpeg_version: opts.ffmpegVersion }
        : {}),
      ...(opts.renderDefaultsHash
        ? { render_defaults_hash: opts.renderDefaultsHash }
        : {}),
      handoff_id: opts.handoffId,
      nle_receipt_required: true,
      route_receipt: routeReceipt,
      route_evidence: routeEvidence,
      ...(render ? { render } : {}),
    },
  };
}
