import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { computeNormalizedJsonHash } from "../artifacts/p1-manifest-coverage.js";
import {
  loadContentRenderPlan,
  type ContentRenderPlan,
  type ContentVisualElementPlan,
} from "../content/render-plan.js";
import type { AssemblyEngine } from "./assembly-orchestrator.js";
import type {
  ContentRendererId,
  CreativeCompositeStage,
  CreativeLayerMode,
  CreativeReuseScope,
} from "../content/types.js";
import { captionVisualTreatmentReceiptSummary, type CaptionVisualTreatmentInput } from "../caption/visual-treatment.js";
import {
  createAlphaOverlayExportReceipt,
  type AlphaOverlayArtifactRef,
  type AlphaOverlayExportReceipt,
} from "./alpha-layer-contract.js";
import type { SourceInputAttestation } from "./source-input-attestation.js";
import type { AudioRenderPlan } from "../audio/render-plan.js";
import type { StillCameraMotionReceipt } from "./camera-motion.js";

export type AssemblyEngineRequest = AssemblyEngine | "auto";

export type RenderRouteKind =
  | "canonical_engine_render"
  | "supplied_final"
  | "external_manual_nle";

export type RenderRouteOwnership = "canonical" | "supplied" | "external";
export type RenderRouteStatus = "ready" | "degraded" | "handoff_required" | "blocked";

export interface RenderArtifactRef {
  path: string;
  sha256: string;
}

export interface RenderRouteEvidence {
  route_kind: RenderRouteKind;
  ownership: RenderRouteOwnership;
  canonical_claim: boolean;
  status: RenderRouteStatus;
  route_capability: {
    id: string;
    hash: string;
    caption_renderer: "ffmpeg-libass" | "external_manual_nle" | "none";
    content_renderers: string[];
    visual_treatment_input_hash: string | null;
    visual_treatment_profile_hash: string | null;
    audio_plan_hash: string | null;
  };
  source_identity: {
    status: "verified" | "live_only" | "declared_reference" | "missing";
    timeline: RenderArtifactRef;
    source_inputs_hash: string;
    source_assets: Array<{ asset_id: string; content_sha256: string }>;
  };
  caption_ownership: {
    approval_owner: "caption_runtime_review_core_studio";
    approval_status: "approved" | "missing" | "stale" | "not_applicable";
    approval?: RenderArtifactRef;
    approval_hash: string | null;
    text_timing_hash: string | null;
    burn_render_owner: "ffmpeg-libass" | "external_manual_nle" | "none";
    burn_render_claim: "canonical" | "supplied" | "external" | "not_applicable";
    renderer_count: number;
  };
  audio: {
    owner: "shared_audio_render_plan" | "external_manual_nle" | "not_applicable";
    status: "resolved" | "missing" | "not_applicable";
    plan?: RenderArtifactRef;
    plan_hash: string | null;
    report?: RenderArtifactRef;
    measurement_status?: "measured" | "degraded" | "hold";
    profile_id: string | null;
    profile_hash: string | null;
  };
  visual_treatment: {
    owner: "ffmpeg-libass" | "registered_content" | "external_manual_nle" | "not_applicable";
    input?: RenderArtifactRef;
    input_hash: string | null;
    profile_hash: string | null;
    capability_hash: string | null;
  };
  alpha: AlphaOverlayExportReceipt | null;
  alpha_overlays: AlphaOverlayExportReceipt[];
  ass_capability: {
    renderer: "ffmpeg-libass" | "external_manual_nle" | "none";
    status: "supported" | "registered_fallback" | "nle_handoff" | "blocked" | "not_applicable";
    requested_animations: string[];
    unsupported_animations: string[];
    decision: "canonical" | "registered_fallback" | "nle_handoff" | "blocked" | "not_applicable";
    evidence?: RenderArtifactRef;
  };
  required_handoff_artifacts: RenderArtifactRef[];
  degradation: Array<{
    code: string;
    reason: string;
    action: "registered_fallback" | "nle_handoff" | "block";
  }>;
  handoff: {
    required: boolean;
    status: "not_required" | "pending" | "confirmed" | "blocked";
    human_owner: string | null;
    human_approval_status: "not_requested" | "pending" | "approved" | "rejected";
    artifacts: RenderArtifactRef[];
  };
  agent_qa: {
    status: "not_run" | "passed" | "failed";
    receipt?: RenderArtifactRef;
  };
  human_approval: {
    status: "not_requested" | "pending" | "approved" | "rejected";
    owner: string | null;
    receipt?: RenderArtifactRef;
  };
}

export type PostproductionStyleFamily =
  | "clean_editorial"
  | "bold_kinetic"
  | "human_notes"
  | "data_clarity"
  | "cinematic_minimal"
  | "pop_maximal";

export type ProjectGenre =
  | "social_talking_head"
  | "interview"
  | "event"
  | "longform"
  | "cinematic"
  | "general";

export interface RenderVisualLayerDecision {
  renderer: ContentRendererId;
  mode: CreativeLayerMode;
  composite_stage: CreativeCompositeStage;
  reuse_scopes: CreativeReuseScope[];
  element_ids: string[];
  z_index_min: number;
  z_index_max: number;
  embedded_in_base: boolean;
}

export interface RenderRouteDecision {
  version: "render-route/v2";
  requested_assembly_engine: AssemblyEngineRequest;
  /** Compatibility alias for v1 consumers; identical to base_engine. */
  assembly_engine: AssemblyEngine;
  base_engine: AssemblyEngine;
  visual_layers: RenderVisualLayerDecision[];
  caption_layer: {
    engine: "ffmpeg-libass" | "none";
    composite_stage: "caption";
  };
  delivery: {
    compositor: "ffmpeg";
    video_encoder: "ffmpeg";
    /**
     * Sequential H.264 generations carried by the delivered picture.
     * Stream copies, decodes, VP9 alpha intermediates, and lossless audio
     * intermediates are not lossy-video generations.
     */
    definition: "sequential_h264_generations/v1";
    lossy_video_encode_passes: number;
  };
  /** Compatibility fields retained from render-route/v1. */
  hyperframes_overlay: boolean;
  remotion_overlay_count: number;
  hyperframes_element_count: number;
  speech_caption_engine: "ffmpeg-libass" | "none";
  style_family: PostproductionStyleFamily;
  genre: ProjectGenre;
  reasons: string[];
}

export type DeliveryVideoOperationKind =
  | "lossy_video_generation"
  | "stream_copy"
  | "decode"
  | "alpha_intermediate"
  | "lossless_intermediate";

export interface DeliveryVideoOperation {
  id: string;
  kind: DeliveryVideoOperationKind;
  codec?: string;
}

export interface RenderRouteReceipt extends RenderRouteDecision {
  receipt_version: "render-route-receipt/v3";
  renderer_versions: {
    ffmpeg: string;
    hyperframes?: string;
    remotion?: string;
  };
  inputs: {
    timeline: { path: string; sha256: string };
    caption_approval?: { path: string; sha256: string };
    typography_policy?: { path: string; sha256: string };
    visual_treatment_patch?: { path: string; sha256: string };
    caption_visual_treatment_input?: { path: string; sha256: string };
    audio_render_plan?: { path: string; sha256: string };
    audio_mix_report?: { path: string; sha256: string };
  };
  outputs: {
    final_video: { path: string; sha256: string };
  };
  layer_receipts: Array<{
    renderer: "hyperframes" | "remotion";
    path: string;
    sha256: string;
  }>;
  font_receipt?: { path: string; sha256: string };
  delivery_execution: {
    definition: "sequential_h264_generations/v1";
    measurement_source: "runtime_trace" | "execution_plan";
    lossy_video_encode_passes: number;
    operations: DeliveryVideoOperation[];
  };
  /** Measured worker evidence for motion-bearing still segments. */
  still_camera_motion?: StillCameraMotionReceipt[];
  base_assembly_path: string;
  effective_assembly_path: string;
  hyperframes_receipt_path?: string;
  remotion_overlay_receipt_path?: string;
  visual_layer_receipt_paths?: string[];
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
    input_hash: string;
    applied_caption_ids: string[];
    degraded_reasons: Array<{ caption_id: string; reason: string }>;
    blocked_reasons: Array<{ caption_id: string; reason: string }>;
  };
  /** RFA-013/014/024 bridge evidence. Legacy v3 receipts may omit this field. */
  route_evidence?: RenderRouteEvidence;
}

export interface ExternalRouteMetadata {
  version: "external-route-metadata/v1";
  project_id: string;
  route_kind: "supplied_final" | "external_manual_nle";
  source_identity: {
    timeline: RenderArtifactRef;
    source_inputs_hash: string;
    source_assets?: Array<{ asset_id: string; content_sha256: string }>;
  };
  output: RenderArtifactRef;
  geometry: { width: number; height: number; fps_num: number; fps_den: number };
  caption?: {
    approval?: RenderArtifactRef;
    approval_status?: "approved" | "missing" | "stale";
    text_timing_hash?: string | null;
    burn_render_owner: "external_manual_nle" | "ffmpeg-libass" | "none";
    ass_path?: RenderArtifactRef;
    requested_animations?: string[];
    unsupported_animations?: string[];
    capability_status?: "supported" | "registered_fallback" | "nle_handoff" | "blocked" | "not_applicable";
    decision?: "canonical" | "registered_fallback" | "nle_handoff" | "blocked" | "not_applicable";
  };
  visual_treatment?: {
    input?: RenderArtifactRef;
    input_hash?: string | null;
    profile_hash?: string | null;
    capability_hash?: string | null;
  };
  audio?: {
    plan?: RenderArtifactRef;
    plan_hash?: string | null;
    profile_id?: string | null;
    profile_hash?: string | null;
  };
  alpha?: {
    status?: "supplied_external" | "metadata_only";
    source: RenderArtifactRef;
    output?: RenderArtifactRef | null;
    width: number;
    height: number;
    fps_num: number;
    fps_den: number;
    codec_name: string;
    pixel_format: string;
    alpha_mode: string | null;
    visual_treatment?: {
      input_hash?: string | null;
      profile_hash?: string | null;
      capability_hash?: string | null;
    };
    human_approval?: AlphaOverlayExportReceipt["human_approval"];
  };
  required_handoff_artifacts?: RenderArtifactRef[];
  degradation?: RenderRouteEvidence["degradation"];
  handoff?: {
    status: "pending" | "confirmed" | "blocked";
    human_owner?: string | null;
    human_approval_status?: RenderRouteEvidence["handoff"]["human_approval_status"];
    artifacts?: RenderArtifactRef[];
  };
  human_approval?: RenderRouteEvidence["human_approval"];
  agent_qa?: RenderRouteEvidence["agent_qa"];
  renderer_versions?: { ffmpeg?: string };
  reasons?: string[];
}

export interface ResolveRenderRouteInput {
  requestedEngine?: AssemblyEngineRequest;
  contentPlan: ContentRenderPlan;
  distributionChannel?: string;
  aspectRatio?: string;
  profileHint?: string;
  audioPolicy?: "ducking" | "bgm_only" | "original_only" | "music_master";
  audioDecision?: "preserve" | "mastering";
  captionStylingClass?: string;
  captionsEnabled?: boolean;
}

interface CreativeBriefRouteFields {
  audio_policy?: "ducking" | "bgm_only" | "original_only" | "music_master";
  music_master?: { audio_decision?: "preserve" | "mastering" };
  editorial?: {
    distribution_channel?: string;
    aspect_ratio?: string;
    profile_hint?: string;
  };
}

interface BlueprintRouteFields {
  resolved_profile?: { id?: string };
  caption_policy?: {
    source?: string;
    styling_class?: string;
  };
}

function readYamlIfExists<T>(filePath: string): T | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  return parseYaml(fs.readFileSync(filePath, "utf8")) as T;
}

export function classifyProjectGenre(input: {
  distributionChannel?: string;
  aspectRatio?: string;
  profileHint?: string;
  audioPolicy?: "ducking" | "bgm_only" | "original_only" | "music_master";
  audioDecision?: "preserve" | "mastering";
}): ProjectGenre {
  const profile = input.profileHint?.toLowerCase() ?? "";
  const distribution = input.distributionChannel?.toLowerCase() ?? "";
  if (input.audioPolicy === "music_master" && (input.audioDecision ?? "preserve") === "preserve") {
    return "longform";
  }
  if (profile.includes("longform")) return "longform";
  if (profile.includes("event") || distribution.includes("event")) return "event";
  if (profile.includes("cinematic") || distribution.includes("cinema")) return "cinematic";
  if (
    input.aspectRatio === "9:16" &&
    (distribution.includes("social") || distribution.includes("short"))
  ) {
    return "social_talking_head";
  }
  if (profile.includes("interview") || profile.includes("testimonial")) return "interview";
  return "general";
}

export function resolveStyleFamily(input: {
  captionStylingClass?: string;
  genre: ProjectGenre;
}): PostproductionStyleFamily {
  const stylingClass = input.captionStylingClass?.toLowerCase() ?? "";
  if (stylingClass.includes("cinematic") || input.genre === "cinematic") {
    return "cinematic_minimal";
  }
  // Protect restrained formats from a stale SNS caption/style alias. Renderer
  // ownership is capability-based, but a prior project's visual family must
  // never leak merely because the same template engine is selected.
  if (input.genre === "longform" || input.genre === "event") {
    return "clean_editorial";
  }
  if (stylingClass.includes("sns") || stylingClass.includes("safe-area-ja")) {
    return "bold_kinetic";
  }
  if (input.genre === "social_talking_head") return "bold_kinetic";
  return "clean_editorial";
}

export function resolveRenderRoute(input: ResolveRenderRouteInput): RenderRouteDecision {
  if (input.contentPlan.issues.length > 0) {
    throw new Error(
      `Content render route is invalid: ${input.contentPlan.issues
        .map((issue) => `${issue.clip_id}: ${issue.message}`)
        .join("; ")}`,
    );
  }

  const requestedEngine = input.requestedEngine ?? "auto";
  const remotionOverlayCount = input.contentPlan.remotion_clip_ids.length;
  const hyperframesElementCount = input.contentPlan.hyperframes_elements.length;
  const remotionBaseRequiredClipIds =
    input.contentPlan.remotion_base_required_clip_ids ?? [];
  if (requestedEngine === "ffmpeg" && remotionBaseRequiredClipIds.length > 0) {
    throw new Error(
      `At least one visual treatment requires Remotion base assembly ` +
        `(${remotionBaseRequiredClipIds.length}): ` +
        remotionBaseRequiredClipIds.join(", "),
    );
  }

  const assemblyEngine: AssemblyEngine = requestedEngine === "auto"
    ? remotionBaseRequiredClipIds.length > 0 ? "remotion" : "ffmpeg"
    : requestedEngine;
  const visualElements = contentVisualElements(input.contentPlan);
  assertVisualElementZOrderSupported(visualElements);
  const visualLayers = groupVisualLayers(visualElements, assemblyEngine);
  assertVisualLayerZOrderSupported(visualLayers);
  const genre = classifyProjectGenre(input);
  const reasons: string[] = [];
  if (input.audioPolicy === "music_master" && (input.audioDecision ?? "preserve") === "preserve") {
    reasons.push("music_master preserve full-song routing takes precedence over short social loudness profiles");
  }
  if (requestedEngine !== "auto") {
    reasons.push(`assembly engine explicitly requested as ${requestedEngine}`);
  } else if (remotionBaseRequiredClipIds.length > 0) {
    reasons.push(
      `${remotionBaseRequiredClipIds.length} base-frame treatment(s) require Remotion assembly`,
    );
  } else {
    reasons.push("visual overlays stay separate; preserving the FFmpeg base assembly path");
  }
  if (hyperframesElementCount > 0) {
    reasons.push(`${hyperframesElementCount} HyperFrames-owned content element(s) require transparent compositing`);
  } else {
    reasons.push("no HyperFrames-owned content elements; HyperFrames stays disabled");
  }
  if (remotionOverlayCount > 0) {
    reasons.push(
      `${remotionOverlayCount} Remotion-owned overlay clip(s) use a renderer-owned visual layer`,
    );
  }
  const needsFinalVisualEncode = Boolean(input.captionsEnabled)
    || visualLayers.some((layer) => !layer.embedded_in_base);
  const plannedLossyGenerations = needsFinalVisualEncode ? 2 : 1;
  reasons.push(
    `${plannedLossyGenerations} sequential H.264 generation(s): base assembly`
      + (needsFinalVisualEncode ? " plus final visual composite" : ""),
  );

  return {
    version: "render-route/v2",
    requested_assembly_engine: requestedEngine,
    assembly_engine: assemblyEngine,
    base_engine: assemblyEngine,
    visual_layers: visualLayers,
    caption_layer: {
      engine: input.captionsEnabled ? "ffmpeg-libass" : "none",
      composite_stage: "caption",
    },
    delivery: {
      compositor: "ffmpeg",
      video_encoder: "ffmpeg",
      definition: "sequential_h264_generations/v1",
      lossy_video_encode_passes: plannedLossyGenerations,
    },
    hyperframes_overlay: hyperframesElementCount > 0,
    remotion_overlay_count: remotionOverlayCount,
    hyperframes_element_count: hyperframesElementCount,
    speech_caption_engine: input.captionsEnabled ? "ffmpeg-libass" : "none",
    style_family: resolveStyleFamily({
      captionStylingClass: input.captionStylingClass,
      genre,
    }),
    genre,
    reasons,
  };
}

export function assertVisualElementZOrderSupported(
  elements: ContentVisualElementPlan[],
): void {
  for (const stage of ["under_caption", "over_caption"] as const) {
    const embedded = elements
      .filter((element) => element.composite_stage === stage && element.requires_base_frame);
    const ordered = elements
      .filter((element) => element.composite_stage === stage && !element.requires_base_frame)
      .sort((left, right) =>
        left.z_index - right.z_index
        || left.element_id.localeCompare(right.element_id, "en")
      );
    const runs: ContentRendererId[] = [];
    for (const element of ordered) {
      if (runs.at(-1) !== element.renderer) runs.push(element.renderer);
    }
    if (new Set(runs).size !== runs.length) {
      throw new Error(
        `renderer_z_order_interleaving_unsupported: stage=${stage} order=${
          ordered.map((element) =>
            `${element.renderer}:${element.element_id}@${element.z_index}`
          ).join(",")
        }`,
      );
    }
    if (
      embedded.length > 0
      && ordered.some((element) =>
        element.z_index <= Math.max(...embedded.map((entry) => entry.z_index))
      )
    ) {
      const all = [...embedded, ...ordered].sort((left, right) =>
        left.z_index - right.z_index
        || left.element_id.localeCompare(right.element_id, "en")
      );
      throw new Error(
        `renderer_z_order_interleaving_unsupported: stage=${stage} order=${
          all.map((element) =>
            `${element.renderer}:${element.element_id}@${element.z_index}`
          ).join(",")
        } base_frame_layer_cannot_cover_later_composite`,
      );
    }
  }
}

export function assertVisualLayerZOrderSupported(
  layers: RenderVisualLayerDecision[],
): void {
  for (const stage of ["under_caption", "over_caption"] as const) {
    const embedded = layers.filter((layer) =>
      layer.composite_stage === stage && layer.embedded_in_base
    );
    const ordered = layers
      .filter((layer) => layer.composite_stage === stage && !layer.embedded_in_base)
      .sort((left, right) => left.z_index_min - right.z_index_min);
    for (let index = 1; index < ordered.length; index++) {
      const previous = ordered[index - 1];
      const current = ordered[index];
      if (
        previous.renderer !== current.renderer
        && previous.z_index_max >= current.z_index_min
      ) {
        throw new Error(
          `renderer_z_order_interleaving_unsupported: stage=${stage} `
            + `ranges=${previous.renderer}:${previous.z_index_min}-${previous.z_index_max},`
            + `${current.renderer}:${current.z_index_min}-${current.z_index_max}`,
        );
      }
    }
    if (
      embedded.length > 0
      && ordered.some((layer) =>
        layer.z_index_min < Math.max(...embedded.map((entry) => entry.z_index_max))
      )
    ) {
      throw new Error(
        `renderer_z_order_interleaving_unsupported: stage=${stage} `
          + "base_frame_layer_cannot_cover_later_composite",
      );
    }
  }
}

function contentVisualElements(plan: ContentRenderPlan): ContentVisualElementPlan[] {
  if (plan.visual_elements) return plan.visual_elements;
  return [
    ...plan.hyperframes_elements.map((entry) => ({
      clip_id: entry.element.element_id,
      element_id: entry.element.element_id,
      renderer: "hyperframes" as const,
      layer_mode: entry.element.creative_recipe?.layer_mode ?? "alpha_overlay",
      composite_stage:
        entry.element.creative_recipe?.composite_stage ?? "under_caption",
      reuse_scope: entry.element.creative_recipe?.reuse_scope ?? "project",
      requires_base_frame:
        entry.element.creative_recipe?.requires_base_frame ?? false,
      z_index: entry.element.layout.z_index,
    })),
    ...plan.remotion_clip_ids.map((clipId) => ({
      clip_id: clipId,
      element_id: clipId,
      renderer: "remotion" as const,
      layer_mode: "alpha_overlay" as const,
      composite_stage: "under_caption" as const,
      reuse_scope: "project" as const,
      requires_base_frame:
        (plan.remotion_base_required_clip_ids ?? []).includes(clipId),
      z_index: 100,
    })),
  ];
}

function groupVisualLayers(
  elements: ContentVisualElementPlan[],
  baseEngine: AssemblyEngine,
): RenderVisualLayerDecision[] {
  const groups = new Map<string, RenderVisualLayerDecision>();
  for (const element of elements) {
    const embeddedInBase = element.renderer === "remotion"
      && baseEngine === "remotion"
      && element.requires_base_frame;
    const key = [
      element.renderer,
      element.layer_mode,
      element.composite_stage,
      embeddedInBase ? "embedded" : "separate",
    ].join(":");
    const current = groups.get(key);
    if (current) {
      current.element_ids.push(element.element_id);
      if (!current.reuse_scopes.includes(element.reuse_scope)) {
        current.reuse_scopes.push(element.reuse_scope);
      }
      current.z_index_min = Math.min(current.z_index_min, element.z_index);
      current.z_index_max = Math.max(current.z_index_max, element.z_index);
      continue;
    }
    groups.set(key, {
      renderer: element.renderer,
      mode: element.layer_mode,
      composite_stage: element.composite_stage,
      reuse_scopes: [element.reuse_scope],
      element_ids: [element.element_id],
      z_index_min: element.z_index,
      z_index_max: element.z_index,
      embedded_in_base: embeddedInBase,
    });
  }
  const stageOrder: Record<CreativeCompositeStage, number> = {
    under_caption: 0,
    over_caption: 1,
  };
  return [...groups.values()]
    .map((layer) => ({
      ...layer,
      reuse_scopes: [...layer.reuse_scopes].sort(),
      element_ids: [...layer.element_ids],
    }))
    .sort((left, right) =>
      stageOrder[left.composite_stage] - stageOrder[right.composite_stage]
      || left.z_index_min - right.z_index_min
      || left.renderer.localeCompare(right.renderer, "en"),
    );
}

function fileArtifactRef(filePath: string): RenderArtifactRef {
  const resolved = path.resolve(filePath);
  return {
    path: resolved,
    sha256: `sha256:${createHash("sha256").update(fs.readFileSync(resolved)).digest("hex")}`,
  };
}

function metadataArtifactRef(value: unknown, label: string): RenderArtifactRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`external_route_metadata_invalid:${label}`);
  }
  const ref = value as Record<string, unknown>;
  if (typeof ref.path !== "string" || ref.path.trim().length === 0 ||
    typeof ref.sha256 !== "string" || !/^sha256:[a-f0-9]{64}$/.test(ref.sha256)) {
    throw new Error(`external_route_metadata_invalid:${label}`);
  }
  return { path: ref.path, sha256: ref.sha256 };
}

function normalizedHash(value: string | null | undefined): string | null {
  if (!value) return null;
  if (/^sha256:[a-f0-9]{64}$/.test(value)) return value;
  if (/^[a-f0-9]{64}$/.test(value)) return `sha256:${value}`;
  return value;
}

function readCaptionApproval(pathname: string | undefined): {
  ref?: RenderArtifactRef;
  status: "approved" | "missing" | "stale" | "not_applicable";
  textTimingHash: string | null;
} {
  if (!pathname || !fs.existsSync(pathname)) {
    return { status: "missing", textTimingHash: null };
  }
  const ref = fileArtifactRef(pathname);
  try {
    const approval = JSON.parse(fs.readFileSync(pathname, "utf8")) as {
      approval?: { status?: unknown };
      speech_captions?: unknown;
    };
    const status = approval.approval?.status === "approved" ? "approved" : "stale";
    const captions = Array.isArray(approval.speech_captions)
      ? approval.speech_captions.map((caption) => {
          if (!caption || typeof caption !== "object" || Array.isArray(caption)) return caption;
          const { treatment: _treatment, requested_treatment: _requestedTreatment, ...identity } = caption as Record<string, unknown>;
          return identity;
        })
      : [];
    return {
      ref,
      status,
      textTimingHash: computeNormalizedJsonHash(captions),
    };
  } catch {
    return { ref, status: "stale", textTimingHash: null };
  }
}

function sourceIdentityForRoute(
  timeline: RenderArtifactRef,
  sourceInputs?: SourceInputAttestation,
): RenderRouteEvidence["source_identity"] {
  if (!sourceInputs) {
    return {
      status: "live_only",
      timeline,
      source_inputs_hash: timeline.sha256,
      source_assets: [],
    };
  }
  return {
    status: sourceInputs.status === "verified" || sourceInputs.status === "live_only"
      ? sourceInputs.status
      : "missing",
    timeline,
    source_inputs_hash: normalizedHash(sourceInputs.source_inputs_hash) ?? timeline.sha256,
    source_assets: sourceInputs.source_inputs.map((source) => ({
      asset_id: source.asset_id,
      content_sha256: normalizedHash(source.content_sha256) ?? source.content_sha256,
    })),
  };
}

function canonicalAlphaReceipts(
  layerReceiptPaths: string[],
  visualTreatment: RenderRouteEvidence["visual_treatment"],
  capabilityHash: string,
): AlphaOverlayExportReceipt[] {
  const receipts: AlphaOverlayExportReceipt[] = [];
  for (const receiptPath of layerReceiptPaths) {
    try {
      const raw = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as {
        overlay_path?: unknown;
        media?: AlphaLayerMediaContractLike;
      };
      const media = raw.media;
      if (typeof raw.overlay_path !== "string" || !media) continue;
      const output = fileArtifactRef(raw.overlay_path);
      receipts.push(createAlphaOverlayExportReceipt({
        status: "canonical",
        ownership: "canonical",
        geometry: { width: media.width, height: media.height },
        fpsNum: media.fps_num,
        fpsDen: media.fps_den,
        codec: {
          name: media.codec_name,
          pixel_format: media.pixel_format,
          alpha_mode: media.alpha_mode,
        },
        source: fileArtifactRef(receiptPath),
        output,
        visualTreatment: {
          inputHash: visualTreatment.input_hash,
          profileHash: visualTreatment.profile_hash,
          capabilityHash,
        },
      }));
    } catch (error) {
      throw new Error(
        `alpha_overlay_receipt_invalid:${receiptPath}:${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return receipts;
}

interface AlphaLayerMediaContractLike {
  codec_name: string;
  pixel_format: string;
  alpha_mode: string | null;
  width: number;
  height: number;
  fps_num: number;
  fps_den: number;
}

export function routeCapabilityHash(input: {
  decision: RenderRouteDecision;
  visualTreatmentInputHash?: string | null;
  visualTreatmentProfileHash?: string | null;
  audioPlanHash?: string | null;
}): string {
  return computeNormalizedJsonHash({
    version: "render-route-capability/v1",
    decision: {
      version: input.decision.version,
      assembly_engine: input.decision.assembly_engine,
      base_engine: input.decision.base_engine,
      visual_layers: input.decision.visual_layers,
      caption_layer: input.decision.caption_layer,
      delivery: input.decision.delivery,
      style_family: input.decision.style_family,
      genre: input.decision.genre,
    },
    visual_treatment_input_hash: input.visualTreatmentInputHash ?? null,
    visual_treatment_profile_hash: input.visualTreatmentProfileHash ?? null,
    audio_plan_hash: input.audioPlanHash ?? null,
  });
}

function buildCanonicalRouteEvidence(
  decision: RenderRouteDecision,
  details: {
    timelinePath: string;
    captionApprovalPath?: string;
    sourceInputs?: SourceInputAttestation;
    audioRenderPlan?: AudioRenderPlan;
    audioRenderPlanPath?: string;
    audioMixReportPath?: string;
    captionVisualTreatment?: {
      inputPath: string;
      input: CaptionVisualTreatmentInput;
      typographyPolicyPath?: string;
      visualTreatmentPatchPath?: string;
    };
    visualLayerReceiptPaths?: string[];
    requiredHandoffArtifacts?: RenderArtifactRef[];
  },
): RenderRouteEvidence {
  const timeline = fileArtifactRef(details.timelinePath);
  const approval = readCaptionApproval(details.captionApprovalPath);
  const captionEnabled = decision.caption_layer.engine !== "none";
  const treatmentInput = details.captionVisualTreatment?.input;
  const treatmentInputRef = details.captionVisualTreatment?.inputPath && fs.existsSync(details.captionVisualTreatment.inputPath)
    ? fileArtifactRef(details.captionVisualTreatment.inputPath)
    : undefined;
  const audioPlanHash = details.audioRenderPlan
    ? computeNormalizedJsonHash(details.audioRenderPlan)
    : null;
  const audioMixReport = details.audioMixReportPath && fs.existsSync(details.audioMixReportPath)
    ? JSON.parse(fs.readFileSync(details.audioMixReportPath, "utf8")) as {
        music_master?: { measurements?: { status?: unknown } };
      }
    : undefined;
  const audioMeasurementStatus = details.audioRenderPlan?.strategy === "music_master"
    && audioMixReport?.music_master?.measurements?.status;
  const profile = details.audioRenderPlan?.audio_delivery_profile;
  const visualTreatment: RenderRouteEvidence["visual_treatment"] = {
    owner: treatmentInput ? "ffmpeg-libass" : "not_applicable",
    ...(treatmentInputRef ? { input: treatmentInputRef } : {}),
    input_hash: treatmentInput?.input_hash ?? null,
    profile_hash: treatmentInput?.typography_policy_hash ?? null,
    capability_hash: treatmentInput?.capability_hash ?? null,
  };
  const capabilityHash = routeCapabilityHash({
    decision,
    visualTreatmentInputHash: visualTreatment.input_hash,
    visualTreatmentProfileHash: visualTreatment.profile_hash,
    audioPlanHash,
  });
  const alphaOverlays = canonicalAlphaReceipts(
    details.visualLayerReceiptPaths ?? [],
    visualTreatment,
    capabilityHash,
  );
  const captionApprovalStatus = captionEnabled
    ? approval.status
    : "not_applicable";
  const degradation: RenderRouteEvidence["degradation"] = [];
  if (treatmentInput?.status === "fallback") {
    degradation.push({
      code: "caption_visual_treatment_registered_fallback",
      reason: "Resolved caption visual treatment contains registered fallback decisions.",
      action: "registered_fallback",
    });
  }
  if (captionEnabled && captionApprovalStatus !== "approved") {
    degradation.push({
      code: "caption_approval_evidence_missing_or_stale",
      reason: `Canonical speech caption route requires approved caption evidence; status=${captionApprovalStatus}.`,
      action: "block",
    });
  }
  const routeStatus: RenderRouteStatus = degradation.some((item) => item.action === "block")
    ? "blocked"
    : degradation.length > 0
      ? "degraded"
      : "ready";
  const routeCapability: RenderRouteEvidence["route_capability"] = {
    id: "video-os-canonical-render-route/v1",
    hash: capabilityHash,
    caption_renderer: decision.caption_layer.engine,
    content_renderers: [...new Set(decision.visual_layers.map((layer) => layer.renderer))].sort(),
    visual_treatment_input_hash: visualTreatment.input_hash,
    visual_treatment_profile_hash: visualTreatment.profile_hash,
    audio_plan_hash: audioPlanHash,
  };
  return {
    route_kind: "canonical_engine_render",
    ownership: "canonical",
    canonical_claim: true,
    status: routeStatus,
    route_capability: routeCapability,
    source_identity: sourceIdentityForRoute(timeline, details.sourceInputs),
    caption_ownership: {
      approval_owner: "caption_runtime_review_core_studio",
      approval_status: captionApprovalStatus,
      ...(approval.ref ? { approval: approval.ref } : {}),
      approval_hash: approval.ref?.sha256 ?? null,
      text_timing_hash: treatmentInput?.text_timing_hash ?? approval.textTimingHash,
      burn_render_owner: decision.caption_layer.engine,
      burn_render_claim: captionEnabled ? "canonical" : "not_applicable",
      renderer_count: captionEnabled ? 1 : 0,
    },
    audio: {
      owner: details.audioRenderPlan ? "shared_audio_render_plan" : "not_applicable",
      status: details.audioRenderPlan ? "resolved" : "not_applicable",
      ...(details.audioRenderPlanPath && fs.existsSync(details.audioRenderPlanPath)
        ? { plan: fileArtifactRef(details.audioRenderPlanPath) }
        : {}),
      ...(details.audioRenderPlan?.strategy === "music_master"
        && details.audioMixReportPath && fs.existsSync(details.audioMixReportPath)
        ? { report: fileArtifactRef(details.audioMixReportPath) }
        : {}),
      ...(audioMeasurementStatus === "measured" || audioMeasurementStatus === "degraded" || audioMeasurementStatus === "hold"
        ? { measurement_status: audioMeasurementStatus }
        : {}),
      plan_hash: audioPlanHash,
      profile_id: profile?.profile_id ?? null,
      profile_hash: profile?.profile_hash ?? null,
    },
    visual_treatment: visualTreatment,
    alpha: alphaOverlays[0] ?? null,
    alpha_overlays: alphaOverlays,
    ass_capability: {
      renderer: decision.caption_layer.engine,
      status: captionEnabled ? "supported" : "not_applicable",
      requested_animations: [],
      unsupported_animations: [],
      decision: captionEnabled ? "canonical" : "not_applicable",
    },
    required_handoff_artifacts: details.requiredHandoffArtifacts ?? [],
    degradation,
    handoff: {
      required: false,
      status: "not_required",
      human_owner: null,
      human_approval_status: "not_requested",
      artifacts: [],
    },
    agent_qa: { status: "not_run" },
    human_approval: { status: "not_requested", owner: null },
  };
}

export function buildExternalRenderRouteReceipt(
  metadata: ExternalRouteMetadata,
): RenderRouteReceipt {
  if (metadata.version !== "external-route-metadata/v1") {
    throw new Error("external_route_metadata_version_invalid");
  }
  const timeline = metadataArtifactRef(metadata.source_identity.timeline, "source_identity.timeline");
  const output = metadataArtifactRef(metadata.output, "output");
  const caption = metadata.caption;
  const captionEngine = caption?.burn_render_owner === "ffmpeg-libass" ? "ffmpeg-libass" : "none";
  const decision: RenderRouteDecision = {
    version: "render-route/v2",
    requested_assembly_engine: "auto",
    assembly_engine: "ffmpeg",
    base_engine: "ffmpeg",
    visual_layers: [],
    caption_layer: { engine: captionEngine, composite_stage: "caption" },
    delivery: {
      compositor: "ffmpeg",
      video_encoder: "ffmpeg",
      definition: "sequential_h264_generations/v1",
      lossy_video_encode_passes: 0,
    },
    hyperframes_overlay: false,
    remotion_overlay_count: 0,
    hyperframes_element_count: 0,
    speech_caption_engine: captionEngine,
    style_family: "clean_editorial",
    genre: "general",
    reasons: metadata.reasons ?? ["external/manual NLE route supplied as metadata-only evidence"],
  };
  const requestedAnimations = caption?.requested_animations ?? [];
  const unsupportedAnimations = caption?.unsupported_animations ?? [];
  const assDecision = caption?.decision ?? (unsupportedAnimations.length > 0 ? "nle_handoff" : "not_applicable");
  if (unsupportedAnimations.length > 0 && !["registered_fallback", "nle_handoff", "blocked"].includes(assDecision)) {
    throw new Error("external_route_metadata_unsupported_ass_animation_decision_missing");
  }
  const alpha = metadata.alpha
    ? createAlphaOverlayExportReceipt({
        status: metadata.alpha.status ?? "metadata_only",
        ownership: "external",
        geometry: { width: metadata.alpha.width, height: metadata.alpha.height },
        fpsNum: metadata.alpha.fps_num,
        fpsDen: metadata.alpha.fps_den,
        codec: {
          name: metadata.alpha.codec_name,
          pixel_format: metadata.alpha.pixel_format,
          alpha_mode: metadata.alpha.alpha_mode,
        },
        source: metadataArtifactRef(metadata.alpha.source, "alpha.source"),
        output: metadata.alpha.output == null ? null : metadataArtifactRef(metadata.alpha.output, "alpha.output"),
        visualTreatment: {
          inputHash: metadata.alpha.visual_treatment?.input_hash,
          profileHash: metadata.alpha.visual_treatment?.profile_hash,
          capabilityHash: metadata.alpha.visual_treatment?.capability_hash,
        },
        humanApproval: metadata.alpha.human_approval,
      })
    : null;
  const visualTreatment: RenderRouteEvidence["visual_treatment"] = {
    owner: metadata.visual_treatment ? "external_manual_nle" : "not_applicable",
    ...(metadata.visual_treatment?.input ? { input: metadataArtifactRef(metadata.visual_treatment.input, "visual_treatment.input") } : {}),
    input_hash: normalizedHash(metadata.visual_treatment?.input_hash),
    profile_hash: normalizedHash(metadata.visual_treatment?.profile_hash),
    capability_hash: normalizedHash(metadata.visual_treatment?.capability_hash),
  };
  const audioPlan = metadata.audio?.plan ? metadataArtifactRef(metadata.audio.plan, "audio.plan") : undefined;
  const audioPlanHash = normalizedHash(metadata.audio?.plan_hash);
  const routeCapability: RenderRouteEvidence["route_capability"] = {
    id: metadata.route_kind === "external_manual_nle"
      ? "external-manual-nle-route/v1"
      : "supplied-final-route/v1",
    hash: computeNormalizedJsonHash({
      version: "render-route-capability/v1",
      route_kind: metadata.route_kind,
      geometry: metadata.geometry,
      caption,
      visual_treatment: visualTreatment,
      alpha,
      audio_plan_hash: audioPlanHash,
    }),
    caption_renderer: caption?.burn_render_owner ?? "none",
    content_renderers: [],
    visual_treatment_input_hash: visualTreatment.input_hash,
    visual_treatment_profile_hash: visualTreatment.profile_hash,
    audio_plan_hash: audioPlanHash,
  };
  const degradation = metadata.degradation ?? (unsupportedAnimations.length > 0
    ? [{
        code: "unsupported_ass_animation",
        reason: "External ASS animation is outside the registered canonical libass capability.",
        action: assDecision === "blocked"
          ? "block" as const
          : assDecision === "registered_fallback"
            ? "registered_fallback" as const
            : "nle_handoff" as const,
      }]
    : []);
  const handoffStatus = metadata.handoff?.status ?? (metadata.route_kind === "external_manual_nle" ? "pending" : "confirmed");
  const evidence: RenderRouteEvidence = {
    route_kind: metadata.route_kind,
    ownership: metadata.route_kind === "external_manual_nle" ? "external" : "supplied",
    canonical_claim: false,
    status: assDecision === "blocked" || handoffStatus === "blocked"
      ? "blocked"
      : assDecision === "nle_handoff" || metadata.route_kind === "external_manual_nle"
        ? "handoff_required"
        : assDecision === "registered_fallback" || degradation.length > 0 ? "degraded" : "ready",
    route_capability: routeCapability,
    source_identity: {
      status: "declared_reference",
      timeline,
      source_inputs_hash: normalizedHash(metadata.source_identity.source_inputs_hash) ?? metadata.source_identity.source_inputs_hash,
      source_assets: (metadata.source_identity.source_assets ?? []).map((source) => ({
        asset_id: source.asset_id,
        content_sha256: normalizedHash(source.content_sha256) ?? source.content_sha256,
      })),
    },
    caption_ownership: {
      approval_owner: "caption_runtime_review_core_studio",
      approval_status: caption?.approval_status ?? (caption ? "missing" : "not_applicable"),
      ...(caption?.approval ? { approval: metadataArtifactRef(caption.approval, "caption.approval") } : {}),
      approval_hash: caption?.approval?.sha256 ?? null,
      text_timing_hash: normalizedHash(caption?.text_timing_hash),
      burn_render_owner: caption?.burn_render_owner ?? "none",
      burn_render_claim: caption?.burn_render_owner === "none" ? "not_applicable" : "external",
      renderer_count: caption?.burn_render_owner && caption.burn_render_owner !== "none" ? 1 : 0,
    },
    audio: {
      owner: audioPlan ? "shared_audio_render_plan" : "not_applicable",
      status: audioPlan ? "resolved" : "not_applicable",
      ...(audioPlan ? { plan: audioPlan } : {}),
      plan_hash: audioPlanHash,
      profile_id: metadata.audio?.profile_id ?? null,
      profile_hash: normalizedHash(metadata.audio?.profile_hash),
    },
    visual_treatment: visualTreatment,
    alpha,
    alpha_overlays: alpha ? [alpha] : [],
    ass_capability: {
      renderer: caption?.burn_render_owner ?? "none",
      status: caption?.capability_status ?? (caption ? "nle_handoff" : "not_applicable"),
      requested_animations: requestedAnimations,
      unsupported_animations: unsupportedAnimations,
      decision: assDecision,
      ...(caption?.ass_path ? { evidence: metadataArtifactRef(caption.ass_path, "caption.ass_path") } : {}),
    },
    required_handoff_artifacts: (metadata.required_handoff_artifacts ?? []).map((artifact, index) => metadataArtifactRef(artifact, `required_handoff_artifacts[${index}]`)),
    degradation,
    handoff: {
      required: true,
      status: handoffStatus,
      human_owner: metadata.handoff?.human_owner ?? null,
      human_approval_status: metadata.handoff?.human_approval_status ?? "pending",
      artifacts: (metadata.handoff?.artifacts ?? []).map((artifact, index) => metadataArtifactRef(artifact, `handoff.artifacts[${index}]`)),
    },
    agent_qa: metadata.agent_qa ?? { status: "not_run" },
    human_approval: metadata.human_approval ?? { status: "pending", owner: null },
  };
  return {
    ...decision,
    renderer_versions: { ffmpeg: metadata.renderer_versions?.ffmpeg ?? "external-metadata-only" },
    receipt_version: "render-route-receipt/v3",
    inputs: { timeline },
    outputs: { final_video: output },
    layer_receipts: [],
    delivery_execution: {
      definition: "sequential_h264_generations/v1",
      measurement_source: "execution_plan",
      lossy_video_encode_passes: 0,
      operations: [{ id: "external_manual_nle_handoff", kind: "stream_copy" }],
    },
    base_assembly_path: output.path,
    effective_assembly_path: output.path,
    route_evidence: evidence,
  };
}

export function resolveProjectRenderRoute(
  projectDir: string,
  requestedEngine: AssemblyEngineRequest = "auto",
): RenderRouteDecision {
  const absDir = path.resolve(projectDir);
  const timelinePath = path.join(absDir, "05_timeline", "timeline.json");
  const brief = readYamlIfExists<CreativeBriefRouteFields>(
    path.join(absDir, "01_intent", "creative_brief.yaml"),
  );
  const blueprint = readYamlIfExists<BlueprintRouteFields>(
    path.join(absDir, "04_plan", "edit_blueprint.yaml"),
  );
  const profileHint = blueprint?.resolved_profile?.id ?? brief?.editorial?.profile_hint;
  return resolveRenderRoute({
    requestedEngine,
    contentPlan: loadContentRenderPlan(timelinePath),
    distributionChannel: brief?.editorial?.distribution_channel,
    aspectRatio: brief?.editorial?.aspect_ratio,
    profileHint,
    audioPolicy: brief?.audio_policy,
    audioDecision: brief?.music_master?.audio_decision,
    captionStylingClass: blueprint?.caption_policy?.styling_class,
    captionsEnabled: !!blueprint?.caption_policy?.source && blueprint.caption_policy.source !== "none",
  });
}

export function writeRenderRouteReceipt(
  outputDir: string,
  decision: RenderRouteDecision,
  details: {
    baseAssemblyPath: string;
    effectiveAssemblyPath: string;
    hyperframesReceiptPath?: string;
    remotionOverlayReceiptPath?: string;
    visualLayerReceiptPaths?: string[];
    timelinePath: string;
    captionApprovalPath?: string;
    finalVideoPath: string;
    fontReceiptPath?: string;
    operations: DeliveryVideoOperation[];
    measurementSource?: "runtime_trace" | "execution_plan";
    rendererVersions?: { hyperframes?: string; remotion?: string };
    captionVisualTreatment?: {
      inputPath: string;
      input: CaptionVisualTreatmentInput;
      typographyPolicyPath?: string;
      visualTreatmentPatchPath?: string;
    };
    sourceInputs?: SourceInputAttestation;
    audioRenderPlan?: AudioRenderPlan;
    audioRenderPlanPath?: string;
    audioMixReportPath?: string;
    routeEvidence?: RenderRouteEvidence;
    stillCameraMotion?: StillCameraMotionReceipt[];
  },
): string {
  const logsDir = path.join(outputDir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const receiptPath = path.join(logsDir, "render-route.json");
  const fileRef = (filePath: string) => ({
    path: path.resolve(filePath),
    sha256: `sha256:${createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`,
  });
  const layerReceipts = (details.visualLayerReceiptPaths ?? []).map((receiptPath) => {
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as {
      renderer?: unknown;
    };
    if (receipt.renderer !== "hyperframes" && receipt.renderer !== "remotion") {
      throw new Error(`render_layer_receipt_renderer_invalid:${receiptPath}`);
    }
    const renderer: "hyperframes" | "remotion" = receipt.renderer;
    return { renderer, ...fileRef(receiptPath) };
  });
  const lossyVideoEncodePasses = details.operations.filter(
    (operation) => operation.kind === "lossy_video_generation"
      && operation.codec === "h264",
  ).length;
  const ffmpegVersion = execFileSync("ffmpeg", ["-version"], {
    encoding: "utf8",
  }).split(/\r?\n/, 1)[0].trim();
  const receipt: RenderRouteReceipt = {
    ...decision,
    receipt_version: "render-route-receipt/v3",
    renderer_versions: {
      ffmpeg: ffmpegVersion,
      ...details.rendererVersions,
    },
    inputs: {
      timeline: fileRef(details.timelinePath),
      ...(details.captionApprovalPath && fs.existsSync(details.captionApprovalPath)
        ? { caption_approval: fileRef(details.captionApprovalPath) }
        : {}),
      ...(details.captionVisualTreatment?.typographyPolicyPath && fs.existsSync(details.captionVisualTreatment.typographyPolicyPath)
        ? { typography_policy: fileRef(details.captionVisualTreatment.typographyPolicyPath) }
        : {}),
      ...(details.captionVisualTreatment?.visualTreatmentPatchPath && fs.existsSync(details.captionVisualTreatment.visualTreatmentPatchPath)
        ? { visual_treatment_patch: fileRef(details.captionVisualTreatment.visualTreatmentPatchPath) }
        : {}),
      ...(details.captionVisualTreatment && fs.existsSync(details.captionVisualTreatment.inputPath)
        ? { caption_visual_treatment_input: fileRef(details.captionVisualTreatment.inputPath) }
        : {}),
      ...(details.audioRenderPlanPath && fs.existsSync(details.audioRenderPlanPath)
        ? { audio_render_plan: fileRef(details.audioRenderPlanPath) }
        : {}),
      ...(details.audioMixReportPath && fs.existsSync(details.audioMixReportPath)
        ? { audio_mix_report: fileRef(details.audioMixReportPath) }
        : {}),
    },
    outputs: { final_video: fileRef(details.finalVideoPath) },
    layer_receipts: layerReceipts,
    ...(details.fontReceiptPath
      ? { font_receipt: fileRef(details.fontReceiptPath) }
      : {}),
    delivery_execution: {
      definition: "sequential_h264_generations/v1",
      measurement_source: details.measurementSource ?? "runtime_trace",
      lossy_video_encode_passes: lossyVideoEncodePasses,
      operations: details.operations,
    },
    ...(details.stillCameraMotion && details.stillCameraMotion.length > 0
      ? { still_camera_motion: details.stillCameraMotion }
      : {}),
    base_assembly_path: path.resolve(details.baseAssemblyPath),
    effective_assembly_path: path.resolve(details.effectiveAssemblyPath),
    ...(details.hyperframesReceiptPath
      ? { hyperframes_receipt_path: path.resolve(details.hyperframesReceiptPath) }
      : {}),
    ...(details.remotionOverlayReceiptPath
      ? { remotion_overlay_receipt_path: path.resolve(details.remotionOverlayReceiptPath) }
      : {}),
    ...(details.visualLayerReceiptPaths && details.visualLayerReceiptPaths.length > 0
      ? {
          visual_layer_receipt_paths: details.visualLayerReceiptPaths.map((receiptPath) =>
            path.resolve(receiptPath)
          ),
        }
      : {}),
    ...(details.captionVisualTreatment ? {
      caption_visual_treatment: captionVisualTreatmentReceiptSummary(details.captionVisualTreatment.input),
    } : {}),
    route_evidence: details.routeEvidence ?? buildCanonicalRouteEvidence(decision, {
      timelinePath: details.timelinePath,
      captionApprovalPath: details.captionApprovalPath,
      sourceInputs: details.sourceInputs,
      audioRenderPlan: details.audioRenderPlan,
      audioRenderPlanPath: details.audioRenderPlanPath,
      audioMixReportPath: details.audioMixReportPath,
      captionVisualTreatment: details.captionVisualTreatment,
      visualLayerReceiptPaths: details.visualLayerReceiptPaths,
    }),
  };
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return receiptPath;
}
