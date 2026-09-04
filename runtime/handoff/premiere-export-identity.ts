import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { computeNormalizedJsonHash } from "../artifacts/p1-manifest-coverage.js";
import {
  hashAudioRenderPlan,
  validateAudioRenderPlanContract,
  type AudioRenderPlan,
} from "../audio/render-plan.js";
import { assertAudioRenderPlanFresh } from "../audio/render-executor.js";
import { resolveSharedAudioRenderPlan } from "../audio/render-route.js";
import { loadSourceMap, type LoadedSourceMap } from "../media/source-map.js";
import { validateAgainstSchema } from "../commands/shared.js";
import { assertCaptionApprovalForExport } from "../caption/review-service.js";
import {
  resolveAndVerifyCanonicalCaptionVisualTreatmentInput,
  shouldPreflightCanonicalCaptionVisualTreatment,
} from "../render/canonical-render-input.js";
import {
  routeCapabilityHash,
  type RenderArtifactRef,
  type RenderRouteDecision,
} from "../render/route-resolver.js";
import { resolveReviewCutIdentity } from "../review/edit-identity.js";

export class PremiereExportIdentityBlockedError extends Error {
  readonly code = "PREMIERE_EXPORT_IDENTITY_BLOCKED" as const;

  constructor(
    readonly reason: string,
    readonly issues: string[],
  ) {
    super(`${reason}: ${issues.join("; ")}`);
    this.name = "PremiereExportIdentityBlockedError";
  }
}

export interface PremiereExportIdentity {
  version: "premiere-export-identity/v1";
  project_id: string;
  export_kind: "fcp7_xml";
  timeline: RenderArtifactRef;
  review_edit_identity?: {
    mode: "derived" | "legacy_canonical";
    cut_identity: string;
    receipt: RenderArtifactRef | null;
  };
  caption: {
    owner: "caption_runtime_review_core_studio";
    status: "approved" | "not_applicable" | "missing" | "stale";
    approval: RenderArtifactRef | null;
    approval_hash: string | null;
    text_timing_hash: string | null;
  };
  visual_treatment: {
    owner: "ffmpeg-libass" | "not_applicable";
    status: "resolved" | "not_applicable" | "blocked";
    input_hash: string | null;
    input: RenderArtifactRef | null;
    typography_policy_hash: string | null;
    visual_treatment_patch_hash: string | null;
    capability_hash: string | null;
  };
  audio: {
    owner: "shared_audio_render_plan" | "legacy_dialogue_route" | "not_applicable";
    status: "resolved" | "not_applicable" | "missing";
    plan: RenderArtifactRef | null;
    plan_hash: string | null;
    profile_id: string | null;
    profile_hash: string | null;
  };
  source_identity: {
    status: "verified" | "declared_reference";
    source_map: RenderArtifactRef | null;
    source_inputs_hash: string;
    assets: Array<{ asset_id: string; locator: string; content_sha256: string }>;
  };
  route_capability: {
    id: string;
    hash: string;
    assembly_engine: "ffmpeg" | "remotion";
    caption_renderer: "ffmpeg-libass" | "none";
    content_renderers: string[];
  };
  visual_effects: {
    status: "editable" | "baked" | "none" | "blocked";
    unsupported: Array<{ clip_id: string; status: string; reason: string }>;
    baked_clip_ids: string[];
  };
  human_approval: {
    caption_status: "approved" | "not_applicable" | "missing" | "stale";
    export_status: "not_requested";
  };
  export_identity_hash: string;
}

function fileRef(filePath: string): RenderArtifactRef {
  return {
    path: path.resolve(filePath),
    sha256: `sha256:${createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`,
  };
}

function normalizeHash(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return /^sha256:[a-f0-9]{64}$/.test(value)
    ? value
    : /^[a-f0-9]{64}$/.test(value) ? `sha256:${value}` : value;
}

function sourceAssets(sourceMap: LoadedSourceMap | undefined, fallback: Map<string, string>): PremiereExportIdentity["source_identity"]["assets"] {
  const entries = sourceMap?.entries?.length
    ? sourceMap.entries
    : [...fallback.entries()].map(([asset_id, source_locator]) => ({ asset_id, source_locator }));
  return entries
    .filter((entry) => typeof entry.asset_id === "string" && typeof entry.source_locator === "string")
    .map((entry) => ({
      asset_id: entry.asset_id,
      locator: entry.source_locator,
      content_sha256: normalizeHash(
        "source_content_sha256" in entry ? entry.source_content_sha256 : undefined,
      )
        ?? computeNormalizedJsonHash({ asset_id: entry.asset_id, source_locator: entry.source_locator }),
    }))
    .sort((left, right) => left.asset_id.localeCompare(right.asset_id));
}

function readApproval(projectDir: string, pathname: string | undefined): PremiereExportIdentity["caption"] {
  if (!pathname || !fs.existsSync(pathname)) {
    return {
      owner: "caption_runtime_review_core_studio",
      status: "missing",
      approval: null,
      approval_hash: null,
      text_timing_hash: null,
    };
  }
  const approval = fileRef(pathname);
  const checked = assertCaptionApprovalForExport(projectDir, pathname);
  return {
    owner: "caption_runtime_review_core_studio",
    status: "approved",
    approval,
    approval_hash: approval.sha256,
    text_timing_hash: checked.textTimingHash,
  };
}

function findFirst(projectDir: string, candidates: string[]): string | undefined {
  return candidates.map((candidate) => path.resolve(projectDir, candidate)).find((candidate) => fs.existsSync(candidate));
}

function timelineHasFormalAudio(timeline: Record<string, unknown>): boolean {
  const tracks = timeline.tracks as Record<string, Array<{ track_id?: unknown; clips?: unknown[] }>> | undefined;
  const a2OrA3HasClip = (tracks?.audio ?? []).some((track) =>
    (track.track_id === "A2" || track.track_id === "A3") && (track.clips ?? []).length > 0,
  );
  const metadata = timeline.metadata as Record<string, unknown> | undefined;
  const provenance = timeline.provenance as Record<string, unknown> | undefined;
  const hasAudioProfileReference = [metadata?.audio_delivery_profile_ref, provenance?.audio_delivery_profile_ref]
    .some((reference) => reference !== undefined && reference !== null);
  const policy = (provenance?.audio_policy as Record<string, unknown> | undefined)?.mode;
  if (policy === "original_only" && (a2OrA3HasClip || hasAudioProfileReference)) {
    throw new PremiereExportIdentityBlockedError("audio_plan_blocked", [
      "audio_policy original_only contradicts formal A2/A3 clip or audio profile evidence",
    ]);
  }
  return a2OrA3HasClip || hasAudioProfileReference;
}

function resolveAudioIdentity(
  projectDir: string,
  timelinePath: string,
  timeline: Record<string, unknown>,
): PremiereExportIdentity["audio"] {
  if (!timelineHasFormalAudio(timeline)) {
    return { owner: "legacy_dialogue_route", status: "not_applicable", plan: null, plan_hash: null, profile_id: null, profile_hash: null };
  }
  const planPath = findFirst(projectDir, [
    "07_package/audio-render-plan.json",
    "07_package/audio_render_plan.json",
    "07_package/logs/audio-render-plan.json",
  ]);
  let storedPlan: AudioRenderPlan | undefined;
  if (planPath) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(planPath, "utf8"));
    } catch (error) {
      throw new PremiereExportIdentityBlockedError("audio_plan_blocked", [
        `audio-render-plan JSON is invalid: ${error instanceof Error ? error.message : String(error)}`,
      ]);
    }
    const schema = validateAgainstSchema(parsed, "audio-render-plan.schema.json");
    if (!schema.valid) {
      throw new PremiereExportIdentityBlockedError("audio_plan_blocked", schema.errors);
    }
    const candidate = parsed as AudioRenderPlan;
    const contract = validateAudioRenderPlanContract(candidate);
    if (!contract.valid) {
      throw new PremiereExportIdentityBlockedError("audio_plan_blocked", contract.errors);
    }
    try {
      assertAudioRenderPlanFresh(candidate);
    } catch (error) {
      throw new PremiereExportIdentityBlockedError("audio_plan_stale", [
        error instanceof Error ? error.message : String(error),
      ]);
    }
    storedPlan = candidate;
  }
  if (!storedPlan) {
    throw new PremiereExportIdentityBlockedError("audio_plan_missing", [
      "formal A2/A3/profile audio requires a persisted audio-render-plan",
    ]);
  }

  let sourceOverrides: Record<string, string> | undefined;
  try {
    const sourceMap = loadSourceMap(projectDir);
    sourceOverrides = Object.fromEntries(sourceMap.locatorMap.entries());
  } catch {
    // The canonical resolver will report a missing source map/source as a
    // structured audio-plan block below. Do not invent source identity here.
  }
  const musicCuesPath = findFirst(projectDir, [
    "07_package/music_cues.json",
    "04_plan/music_cues.json",
  ]);
  const sfxCuesPath = findFirst(projectDir, [
    "07_package/sfx_cues.json",
    "04_plan/sfx_cues.json",
  ]);
  let livePlan: AudioRenderPlan | undefined;
  try {
    livePlan = resolveSharedAudioRenderPlan({
      projectDir,
      timelinePath,
      ...(musicCuesPath ? { musicCuesPath } : {}),
      ...(sfxCuesPath ? { sfxCuesPath } : {}),
      ...(sourceOverrides ? { sourceOverrides } : {}),
    });
  } catch (error) {
    throw new PremiereExportIdentityBlockedError("audio_plan_blocked", [
      error instanceof Error ? error.message : String(error),
    ]);
  }
  if (!livePlan) {
    throw new PremiereExportIdentityBlockedError("audio_plan_missing", [
      "canonical audio resolver did not produce an audio-render-plan",
    ]);
  }
  const liveSchema = validateAgainstSchema(livePlan, "audio-render-plan.schema.json");
  if (!liveSchema.valid) {
    throw new PremiereExportIdentityBlockedError("audio_plan_blocked", liveSchema.errors);
  }
  const liveContract = validateAudioRenderPlanContract(livePlan);
  if (!liveContract.valid) {
    throw new PremiereExportIdentityBlockedError("audio_plan_blocked", liveContract.errors);
  }
  try {
    assertAudioRenderPlanFresh(livePlan);
  } catch (error) {
    throw new PremiereExportIdentityBlockedError("audio_plan_stale", [
      error instanceof Error ? error.message : String(error),
    ]);
  }
  if (storedPlan && hashAudioRenderPlan(storedPlan) !== hashAudioRenderPlan(livePlan)) {
    throw new PremiereExportIdentityBlockedError("audio_plan_stale", [
      `stored plan hash=${hashAudioRenderPlan(storedPlan)} live plan hash=${hashAudioRenderPlan(livePlan)}`,
    ]);
  }
  const planRef = planPath ? fileRef(planPath) : null;
  return {
    owner: "shared_audio_render_plan",
    status: "resolved",
    plan: planRef,
    plan_hash: hashAudioRenderPlan(livePlan),
    profile_id: livePlan.audio_delivery_profile?.profile_id ?? null,
    profile_hash: normalizeHash(livePlan.audio_delivery_profile?.profile_hash),
  };
}

export function buildPremiereExportIdentity(input: Omit<PremiereExportIdentity, "export_identity_hash">): PremiereExportIdentity {
  const export_identity_hash = computeNormalizedJsonHash(input);
  return { ...input, export_identity_hash };
}

export function resolvePremiereExportIdentity(input: {
  projectDir: string;
  projectId: string;
  timelinePath: string;
  sourceMapPath?: string;
  sourceMap: Map<string, string>;
  sourceMapDoc?: LoadedSourceMap;
  routeDecision: RenderRouteDecision;
  bakedClipIds?: string[];
  visualEffectIssues?: Array<{ clip_id: string; status: string; reason: string }>;
}): PremiereExportIdentity {
  const timelineRaw = fs.readFileSync(input.timelinePath);
  const timelineRef: RenderArtifactRef = {
    path: path.resolve(input.timelinePath),
    sha256: `sha256:${createHash("sha256").update(timelineRaw).digest("hex")}`,
  };
  const timeline = JSON.parse(timelineRaw.toString("utf8")) as Record<string, unknown>;
  const reviewCutIdentity = resolveReviewCutIdentity({
    projectDir: input.projectDir,
    timelinePath: input.timelinePath,
  });
  const captionsEnabled = input.routeDecision.caption_layer.engine !== "none";
  const approvalPath = findFirst(input.projectDir, ["07_package/caption_approval.json", "07_package/caption-approval.json"]);
  let caption: PremiereExportIdentity["caption"];
  try {
    caption = captionsEnabled
      ? readApproval(input.projectDir, approvalPath)
    : { owner: "caption_runtime_review_core_studio" as const, status: "not_applicable" as const, approval: null, approval_hash: null, text_timing_hash: null };
  } catch (error) {
    throw new PremiereExportIdentityBlockedError("caption_approval_blocked", [
      error instanceof Error ? error.message : String(error),
    ]);
  }
  if (captionsEnabled && caption.status !== "approved") {
    throw new PremiereExportIdentityBlockedError("caption_approval_blocked", [
      `caption approval status=${caption.status}`,
    ]);
  }

  let visualTreatment: PremiereExportIdentity["visual_treatment"] = {
    owner: "not_applicable",
    status: "not_applicable",
    input_hash: null,
    input: null,
    typography_policy_hash: null,
    visual_treatment_patch_hash: null,
    capability_hash: null,
  };
  if (captionsEnabled && shouldPreflightCanonicalCaptionVisualTreatment(input.projectDir, {
    approval: caption.approval ? JSON.parse(fs.readFileSync(caption.approval.path, "utf8")).approval : undefined,
  })) {
    const resolved = resolveAndVerifyCanonicalCaptionVisualTreatmentInput(input.projectDir, {
      approvalPath,
      typographyPolicyPath: "04_plan/typography_policy.json",
      visualTreatmentPatchPath: findFirst(input.projectDir, ["07_package/caption_visual_treatment_patch.json", "07_package/caption-visual-treatment-patch.json"]),
    });
    if (resolved.status === "blocked" || resolved.status === "human_hold") {
      throw new PremiereExportIdentityBlockedError("visual_treatment_blocked", [
        `canonical visual-treatment status=${resolved.status}`,
      ]);
    }
    const inputPath = findFirst(input.projectDir, ["07_package/caption_visual_treatment_input.json"]);
    visualTreatment = {
      owner: "ffmpeg-libass",
      status: "resolved",
      input_hash: resolved.input_hash,
      input: inputPath ? fileRef(inputPath) : null,
      typography_policy_hash: resolved.typography_policy_hash,
      visual_treatment_patch_hash: resolved.visual_treatment_patch_hash,
      capability_hash: resolved.capability_hash,
    };
  }

  const assets = sourceAssets(input.sourceMapDoc, input.sourceMap);
  const source_inputs_hash = computeNormalizedJsonHash({ version: "premiere-export-source-identity/v1", assets });
  const sourceMapFilePath = input.sourceMapPath ?? input.sourceMapDoc?.filePath;
  const sourceMap = sourceMapFilePath && fs.existsSync(sourceMapFilePath) ? fileRef(sourceMapFilePath) : null;
  const sourceStatus = assets.every((asset) => /^sha256:[a-f0-9]{64}$/.test(asset.content_sha256)) && Boolean(input.sourceMapDoc?.entries?.every((entry) => entry.source_content_sha256))
    ? "verified" as const
    : "declared_reference" as const;
  const audio = resolveAudioIdentity(input.projectDir, input.timelinePath, timeline);
  if (audio.status === "missing") {
    throw new PremiereExportIdentityBlockedError("audio_plan_missing", [
      "audio-render-plan is required for formal audio",
    ]);
  }
  const capabilityHash = routeCapabilityHash({
    decision: input.routeDecision,
    visualTreatmentInputHash: visualTreatment.input_hash,
    visualTreatmentProfileHash: visualTreatment.typography_policy_hash,
    audioPlanHash: audio.plan_hash,
  });
  const contentRenderers = [...new Set(input.routeDecision.visual_layers.map((layer) => layer.renderer))].sort();
  return buildPremiereExportIdentity({
    version: "premiere-export-identity/v1",
    project_id: input.projectId,
    export_kind: "fcp7_xml",
    timeline: timelineRef,
    review_edit_identity: {
      mode: reviewCutIdentity.mode,
      cut_identity: reviewCutIdentity.cut_identity,
      receipt: reviewCutIdentity.receipt
        ? fileRef(path.join(input.projectDir, "05_timeline/review-edit-identity.json"))
        : null,
    },
    caption,
    visual_treatment: visualTreatment,
    audio,
    source_identity: {
      status: sourceStatus,
      source_map: sourceMap,
      source_inputs_hash,
      assets,
    },
    route_capability: {
      id: "video-os-canonical-export-route/v1",
      hash: capabilityHash,
      assembly_engine: input.routeDecision.assembly_engine,
      caption_renderer: input.routeDecision.caption_layer.engine,
      content_renderers: contentRenderers,
    },
    visual_effects: {
      status: input.bakedClipIds?.length ? "baked" : input.visualEffectIssues?.length ? "blocked" : "none",
      unsupported: input.visualEffectIssues ?? [],
      baked_clip_ids: [...(input.bakedClipIds ?? [])].sort(),
    },
    human_approval: {
      caption_status: caption.status,
      export_status: "not_requested",
    },
  });
}

export function validatePremiereExportIdentity(value: unknown): { valid: boolean; errors: string[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: false, errors: ["identity must be an object"] };
  const identity = value as PremiereExportIdentity;
  const errors: string[] = [];
  if (identity.version !== "premiere-export-identity/v1") errors.push("version");
  if (!identity.project_id) errors.push("project_id");
  if (!/^sha256:[a-f0-9]{64}$/.test(identity.export_identity_hash ?? "")) errors.push("export_identity_hash");
  const withoutHash = { ...identity } as Record<string, unknown>;
  delete withoutHash.export_identity_hash;
  if (computeNormalizedJsonHash(withoutHash) !== identity.export_identity_hash) errors.push("export_identity_hash_mismatch");
  if (identity.caption?.status === "approved" && (!identity.caption.approval || !identity.caption.approval_hash)) errors.push("approved_caption_missing_approval_evidence");
  if (identity.visual_treatment?.status === "resolved" && (!identity.visual_treatment.input || !identity.visual_treatment.input_hash)) errors.push("resolved_visual_treatment_missing_input_evidence");
  if (identity.source_identity?.status === "verified" && !identity.source_identity.source_map) errors.push("verified_source_identity_missing_source_map");
  if (identity.review_edit_identity && identity.review_edit_identity.cut_identity !== identity.timeline?.sha256) {
    errors.push("review_edit_cut_identity_mismatch");
  }
  const boundRefs: Array<[string, RenderArtifactRef | null | undefined]> = [
    ["timeline", identity.timeline],
    ["review_edit_identity.receipt", identity.review_edit_identity?.receipt],
    ["caption.approval", identity.caption?.approval],
    ["visual_treatment.input", identity.visual_treatment?.input],
    ["audio.plan", identity.audio?.plan],
    ["source_identity.source_map", identity.source_identity?.source_map],
  ];
  for (const [label, ref] of boundRefs) {
    // Synthetic metadata identities may intentionally use non-local paths.
    // Export-produced absolute refs are always re-hashed here so a stale
    // approval, treatment input, or source map cannot be reused silently.
    if (!ref || !path.isAbsolute(ref.path)) continue;
    if (!fs.existsSync(ref.path)) {
      errors.push(`${label}_missing`);
      continue;
    }
    if (fileRef(ref.path).sha256 !== ref.sha256) errors.push(`${label}_hash_mismatch`);
  }
  return { valid: errors.length === 0, errors };
}
