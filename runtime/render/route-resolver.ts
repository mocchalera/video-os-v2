import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
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

export type AssemblyEngineRequest = AssemblyEngine | "auto";

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
  base_assembly_path: string;
  effective_assembly_path: string;
  hyperframes_receipt_path?: string;
  remotion_overlay_receipt_path?: string;
  visual_layer_receipt_paths?: string[];
}

export interface ResolveRenderRouteInput {
  requestedEngine?: AssemblyEngineRequest;
  contentPlan: ContentRenderPlan;
  distributionChannel?: string;
  aspectRatio?: string;
  profileHint?: string;
  captionStylingClass?: string;
  captionsEnabled?: boolean;
}

interface CreativeBriefRouteFields {
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
}): ProjectGenre {
  const profile = input.profileHint?.toLowerCase() ?? "";
  const distribution = input.distributionChannel?.toLowerCase() ?? "";
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
  };
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return receiptPath;
}
