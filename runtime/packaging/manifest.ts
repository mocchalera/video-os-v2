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
import type { RenderRouteReceipt } from "../render/route-resolver.js";

export interface PackageRenderProvenance {
  contract_version: "render-provenance/v1";
  route_receipt: { path: string; sha256: string };
  renderer_versions: RenderRouteReceipt["renderer_versions"];
  layer_receipts: RenderRouteReceipt["layer_receipts"];
  font_receipt?: RenderRouteReceipt["font_receipt"];
  delivery_execution: RenderRouteReceipt["delivery_execution"];
  inputs: RenderRouteReceipt["inputs"];
  outputs: RenderRouteReceipt["outputs"];
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
  createdAt?: string;
}): PackageManifest {
  const { outputDir, captionPolicy } = opts;
  const routeReceipt = JSON.parse(
    fs.readFileSync(opts.renderRouteReceiptPath, "utf8"),
  ) as RenderRouteReceipt;
  if (routeReceipt.receipt_version !== "render-route-receipt/v3") {
    throw new Error("render_route_receipt_version_invalid");
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
  };

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
  sidecarPaths?: string[];
  derivedVideoProvenancePath?: string;
  layoutSnapshotPath?: string;
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
    ...(derivedVideoProvenance
      ? { derived_video_provenance: derivedVideoProvenance }
      : {}),
    ...(layoutSnapshot ? { layout_snapshot: layoutSnapshot } : {}),
  };

  if (captions.length > 0) artifacts.captions = captions;

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
    },
  };
}
