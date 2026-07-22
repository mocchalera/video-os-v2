import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { loadContentRenderPlan, type ContentRenderPlan } from "../content/render-plan.js";
import type { AssemblyEngine } from "./assembly-orchestrator.js";

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

export interface RenderRouteDecision {
  version: "render-route/v1";
  requested_assembly_engine: AssemblyEngineRequest;
  assembly_engine: AssemblyEngine;
  hyperframes_overlay: boolean;
  remotion_overlay_count: number;
  hyperframes_element_count: number;
  speech_caption_engine: "ffmpeg-libass" | "none";
  style_family: PostproductionStyleFamily;
  genre: ProjectGenre;
  reasons: string[];
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
  if (requestedEngine === "ffmpeg" && remotionOverlayCount > 0) {
    throw new Error(
      `FFmpeg assembly cannot render ${remotionOverlayCount} Remotion-owned overlay clip(s). ` +
        "Use --assembly-engine auto or remotion.",
    );
  }

  const assemblyEngine: AssemblyEngine = requestedEngine === "auto"
    ? remotionOverlayCount > 0 ? "remotion" : "ffmpeg"
    : requestedEngine;
  const genre = classifyProjectGenre(input);
  const reasons: string[] = [];
  if (requestedEngine !== "auto") {
    reasons.push(`assembly engine explicitly requested as ${requestedEngine}`);
  } else if (remotionOverlayCount > 0) {
    reasons.push(`${remotionOverlayCount} Remotion-owned overlay clip(s) require Remotion assembly`);
  } else {
    reasons.push("no Remotion-owned overlays; preserving the FFmpeg assembly path");
  }
  if (hyperframesElementCount > 0) {
    reasons.push(`${hyperframesElementCount} HyperFrames-owned content element(s) require transparent compositing`);
  } else {
    reasons.push("no HyperFrames-owned content elements; HyperFrames stays disabled");
  }

  return {
    version: "render-route/v1",
    requested_assembly_engine: requestedEngine,
    assembly_engine: assemblyEngine,
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
  },
): string {
  const logsDir = path.join(outputDir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const receiptPath = path.join(logsDir, "render-route.json");
  fs.writeFileSync(receiptPath, `${JSON.stringify({
    ...decision,
    base_assembly_path: path.resolve(details.baseAssemblyPath),
    effective_assembly_path: path.resolve(details.effectiveAssemblyPath),
    ...(details.hyperframesReceiptPath
      ? { hyperframes_receipt_path: path.resolve(details.hyperframesReceiptPath) }
      : {}),
  }, null, 2)}\n`, "utf8");
  return receiptPath;
}
