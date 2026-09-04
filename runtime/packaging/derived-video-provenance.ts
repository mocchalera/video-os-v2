import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadSourceMap } from "../media/source-map.js";
import {
  assertCaptionCleanSourceEligibility,
  type CleanBaseAttestationRef,
} from "../render/clean-source-policy.js";
import {
  createSourceInputAttestation,
  type SourceInputAttestation,
} from "../render/source-input-attestation.js";

export const DERIVED_VIDEO_PROVENANCE_VERSION = "derived-video-provenance/v1" as const;

interface ArtifactRef {
  path: string;
  sha256: string;
}

interface SourceAssetMetadata {
  asset_id?: unknown;
  duration_us?: unknown;
  video_stream?: {
    width?: unknown;
    height?: unknown;
  };
  audio_stream?: {
    channels?: unknown;
    sample_rate?: unknown;
    codec?: unknown;
  };
  still_image?: {
    source_width?: unknown;
    source_height?: unknown;
  };
  image_sequence?: {
    source_width?: unknown;
    source_height?: unknown;
  };
}

export interface DerivedVideoSourceRecord {
  asset_id: string;
  media_kind: string;
  content_sha256: string;
  identity_status: "verified" | "live_only";
  render_input_identity: SourceInputAttestation["source_inputs"][number]["render_input_identity"];
  source_origin: "original_source" | "verified_caption_free_proxy";
  caption_cleanliness:
    | "original_source"
    | "independently_attested_caption_free"
    | "not_applicable";
  generated_output_detected: boolean;
  clean_base_attestation?: CleanBaseAttestationRef;
  technical: {
    metadata_status: "complete" | "incomplete";
    duration_us: number | null;
    dimensions: {
      width: number;
      height: number;
    } | null;
    audio_layout: {
      kind: "channels";
      channels: number;
      sample_rate: number;
      codec: string;
    } | {
      kind: "none";
    } | null;
  };
}

export interface DerivedVideoProvenance {
  version: typeof DERIVED_VIDEO_PROVENANCE_VERSION;
  project_id: string;
  created_at: string;
  source_inputs: {
    attestation_version: string;
    attestation_status: SourceInputAttestation["status"];
    aggregate_sha256: string;
    items: DerivedVideoSourceRecord[];
  };
  transformation_chain: {
    producer: "engine_render" | "nle_finishing";
    timeline: ArtifactRef;
    render_route_receipt?: ArtifactRef;
    handoff_id?: string;
    chain_sha256: string;
  };
  captions: {
    mode: "burn_in" | "sidecar" | "both" | "none";
    approval?: ArtifactRef;
  };
  final_output: ArtifactRef;
  verification: {
    status: "verified" | "live_only";
    warnings: string[];
  };
}

export interface BuildDerivedVideoProvenanceOptions {
  projectDir: string;
  projectId: string;
  producer: "engine_render" | "nle_finishing";
  timelinePath: string;
  finalVideoPath: string;
  captionMode: "burn_in" | "sidecar" | "both" | "none";
  captionApprovalPath?: string;
  renderRouteReceiptPath?: string;
  handoffId?: string;
  sourceInputs?: SourceInputAttestation;
  createdAt?: string;
}

export class DerivedVideoProvenanceError extends Error {
  constructor(
    public readonly reason:
      | "source_inputs_truncated"
      | "source_map_entry_missing"
      | "artifact_path_invalid"
      | "artifact_missing"
      | "caption_approval_required"
      | "render_route_receipt_required"
      | "handoff_id_required",
    message: string,
  ) {
    super(`${reason}: ${message}`);
    this.name = "DerivedVideoProvenanceError";
  }
}

function sha256File(filePath: string): string {
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

function stableHash(value: unknown): string {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function artifactRef(projectDir: string, filePath: string): ArtifactRef {
  const root = path.resolve(projectDir);
  const absolute = path.resolve(filePath);
  const relative = path.relative(root, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new DerivedVideoProvenanceError(
      "artifact_path_invalid",
      `Artifact must be inside the project: ${filePath}`,
    );
  }
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    throw new DerivedVideoProvenanceError("artifact_missing", `Artifact not found: ${filePath}`);
  }
  return {
    path: relative.split(path.sep).join("/"),
    sha256: sha256File(absolute),
  };
}

function readAssets(projectDir: string): Map<string, SourceAssetMetadata> {
  const assetsPath = path.join(projectDir, "03_analysis/assets.json");
  if (!fs.existsSync(assetsPath)) return new Map();
  const value = JSON.parse(fs.readFileSync(assetsPath, "utf8")) as {
    items?: SourceAssetMetadata[];
  };
  return new Map(
    (value.items ?? [])
      .filter((item): item is SourceAssetMetadata & { asset_id: string } =>
        typeof item.asset_id === "string")
      .map((item) => [item.asset_id, item]),
  );
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function technicalProfile(
  mediaKind: string,
  asset: SourceAssetMetadata | undefined,
): DerivedVideoSourceRecord["technical"] {
  const durationUs = nonNegativeInteger(asset?.duration_us) ?? null;
  const width = positiveInteger(asset?.video_stream?.width)
    ?? positiveInteger(asset?.still_image?.source_width)
    ?? positiveInteger(asset?.image_sequence?.source_width);
  const height = positiveInteger(asset?.video_stream?.height)
    ?? positiveInteger(asset?.still_image?.source_height)
    ?? positiveInteger(asset?.image_sequence?.source_height);
  const dimensions = width && height ? { width, height } : null;
  const channels = positiveInteger(asset?.audio_stream?.channels);
  const sampleRate = positiveInteger(asset?.audio_stream?.sample_rate);
  const codec = typeof asset?.audio_stream?.codec === "string"
    && asset.audio_stream.codec.trim().length > 0
    ? asset.audio_stream.codec
    : undefined;
  const audioLayout = channels && sampleRate && codec
    ? { kind: "channels" as const, channels, sample_rate: sampleRate, codec }
    : ["video", "image", "sequence"].includes(mediaKind)
      ? { kind: "none" as const }
      : null;
  const requiresDimensions = ["video", "mixed", "image", "sequence"].includes(mediaKind);
  const requiresAudio = ["audio", "bgm", "mixed"].includes(mediaKind);
  const complete = durationUs !== null
    && (!requiresDimensions || dimensions !== null)
    && (!requiresAudio || audioLayout?.kind === "channels");
  return {
    metadata_status: complete ? "complete" : "incomplete",
    duration_us: durationUs,
    dimensions,
    audio_layout: audioLayout,
  };
}

export function buildDerivedVideoProvenance(
  options: BuildDerivedVideoProvenanceOptions,
): DerivedVideoProvenance {
  const projectDir = path.resolve(options.projectDir);
  const sourceInputs = options.sourceInputs ?? createSourceInputAttestation(projectDir, {
    timelinePath: options.timelinePath,
  });
  if (sourceInputs.source_inputs_truncated) {
    throw new DerivedVideoProvenanceError(
      "source_inputs_truncated",
      "A deliverable provenance artifact cannot omit source inputs",
    );
  }
  const sourceMap = loadSourceMap(projectDir);
  const assets = readAssets(projectDir);
  const warnings = [...sourceInputs.warnings];
  const items = sourceInputs.source_inputs.map((source): DerivedVideoSourceRecord => {
    const mapEntry = sourceMap.entryMap.get(source.asset_id);
    if (!mapEntry) {
      throw new DerivedVideoProvenanceError(
        "source_map_entry_missing",
        `Missing source map entry for ${source.asset_id}`,
      );
    }
    const policy = assertCaptionCleanSourceEligibility({
      projectDir,
      assetId: source.asset_id,
      sourcePath: mapEntry.source_locator,
      contentSha256: source.content_sha256,
      mediaKind: source.media_kind,
      declaredOrigin: mapEntry.source_origin,
      cleanBaseAttestation: mapEntry.clean_base_attestation,
    });
    const technical = technicalProfile(source.media_kind, assets.get(source.asset_id));
    if (technical.metadata_status === "incomplete") {
      warnings.push(`source_technical_metadata_incomplete:${source.asset_id}`);
    }
    return {
      asset_id: source.asset_id,
      media_kind: source.media_kind,
      content_sha256: `sha256:${source.content_sha256}`,
      identity_status: source.identity_status,
      render_input_identity: source.render_input_identity,
      source_origin: policy.source_origin === "rendered_output"
        ? "verified_caption_free_proxy"
        : policy.source_origin,
      caption_cleanliness: policy.caption_cleanliness,
      generated_output_detected: policy.generated_output_detected,
      ...(policy.clean_base_attestation
        ? { clean_base_attestation: policy.clean_base_attestation }
        : {}),
      technical,
    };
  });
  const timeline = artifactRef(projectDir, options.timelinePath);
  const finalOutput = artifactRef(projectDir, options.finalVideoPath);
  const captions: DerivedVideoProvenance["captions"] = {
    mode: options.captionMode,
  };
  if (options.captionMode !== "none") {
    if (!options.captionApprovalPath) {
      throw new DerivedVideoProvenanceError(
        "caption_approval_required",
        `Caption mode ${options.captionMode} requires an approval artifact`,
      );
    }
    captions.approval = artifactRef(projectDir, options.captionApprovalPath);
  }
  const chainInputs: Omit<DerivedVideoProvenance["transformation_chain"], "chain_sha256"> = {
    producer: options.producer,
    timeline,
  };
  if (options.producer === "engine_render") {
    if (!options.renderRouteReceiptPath) {
      throw new DerivedVideoProvenanceError(
        "render_route_receipt_required",
        "Engine renders require the execution-derived route receipt",
      );
    }
    chainInputs.render_route_receipt = artifactRef(projectDir, options.renderRouteReceiptPath);
  } else {
    if (!options.handoffId) {
      throw new DerivedVideoProvenanceError(
        "handoff_id_required",
        "NLE-finished outputs require the approved handoff identity",
      );
    }
    chainInputs.handoff_id = options.handoffId;
  }
  const chainHashInput = {
    source_inputs_sha256: `sha256:${sourceInputs.source_inputs_hash}`,
    ...chainInputs,
    captions,
  };
  warnings.sort();
  return {
    version: DERIVED_VIDEO_PROVENANCE_VERSION,
    project_id: options.projectId,
    created_at: options.createdAt ?? new Date().toISOString(),
    source_inputs: {
      attestation_version: sourceInputs.version,
      attestation_status: sourceInputs.status,
      aggregate_sha256: `sha256:${sourceInputs.source_inputs_hash}`,
      items,
    },
    transformation_chain: {
      ...chainInputs,
      chain_sha256: stableHash(chainHashInput),
    },
    captions,
    final_output: finalOutput,
    verification: {
      status: sourceInputs.status === "verified"
        && items.every((item) => item.technical.metadata_status === "complete")
        ? "verified"
        : "live_only",
      warnings,
    },
  };
}

export interface VerifyDerivedVideoProvenanceOptions {
  projectDir: string;
  provenancePath: string;
  expectedFinalVideoPath: string;
  sourceInputs?: SourceInputAttestation;
}

export interface DerivedVideoProvenanceVerification {
  valid: boolean;
  errors: string[];
}

function resolveRef(projectDir: string, reference: ArtifactRef): string {
  return path.resolve(projectDir, reference.path);
}

export function verifyDerivedVideoProvenance(
  options: VerifyDerivedVideoProvenanceOptions,
): DerivedVideoProvenanceVerification {
  const errors: string[] = [];
  let value: DerivedVideoProvenance;
  try {
    value = JSON.parse(fs.readFileSync(options.provenancePath, "utf8")) as DerivedVideoProvenance;
  } catch (error) {
    return { valid: false, errors: [`provenance_unreadable:${error instanceof Error ? error.message : String(error)}`] };
  }
  if (value.version !== DERIVED_VIDEO_PROVENANCE_VERSION) {
    return { valid: false, errors: ["provenance_version_invalid"] };
  }
  try {
    const rebuilt = buildDerivedVideoProvenance({
      projectDir: options.projectDir,
      projectId: value.project_id,
      producer: value.transformation_chain.producer,
      timelinePath: resolveRef(options.projectDir, value.transformation_chain.timeline),
      finalVideoPath: options.expectedFinalVideoPath,
      captionMode: value.captions.mode,
      captionApprovalPath: value.captions.approval
        ? resolveRef(options.projectDir, value.captions.approval)
        : undefined,
      renderRouteReceiptPath: value.transformation_chain.render_route_receipt
        ? resolveRef(options.projectDir, value.transformation_chain.render_route_receipt)
        : undefined,
      handoffId: value.transformation_chain.handoff_id,
      sourceInputs: options.sourceInputs,
      createdAt: value.created_at,
    });
    if (JSON.stringify(value) !== JSON.stringify(rebuilt)) {
      errors.push("provenance_does_not_match_live_artifacts");
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return { valid: errors.length === 0, errors };
}
