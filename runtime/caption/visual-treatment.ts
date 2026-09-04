import * as fs from "node:fs";
import * as path from "node:path";
import { validateArtifact } from "../artifacts/loaders.js";
import { computeNormalizedJsonHash } from "../artifacts/p1-manifest-coverage.js";
import type { CaptionApproval } from "./approval.js";
import type { TypographyPolicyDocument, TypographyAccessibilityResolution } from "./typography-policy.js";
import { resolveTypographyAccessibility } from "./typography-policy.js";
import { CAPTION_HIERARCHY_CAPABILITY_REGISTRY, CAPTION_STYLE_PRESETS, hasCaptionStylePreset, resolveCaptionStylePreset } from "../../editor/shared/caption-style-tokens.js";
import type { PlatformSafeZoneProfile } from "../platform/safe-zone-profile.js";

export interface CaptionVisualTreatmentPatch {
  version: "caption-visual-treatment-patch/v1";
  project_id: string;
  base_caption_draft_hash: string;
  base_timeline_hash: string;
  typography_policy_hash: string;
  caption_approval_hash: string;
  platform_safe_zone_profile_hash?: string;
  operations: Array<{
    caption_id: string;
    stable_root_id: string;
    /** Hash of the patch state the author saw before this atomic append. */
    expected_current_hash?: string;
    anchor: "top_left" | "top_center" | "top_right" | "center" | "bottom_left" | "bottom_center" | "bottom_right";
    rect?: { x: number; y: number; width: number; height: number };
    style_ref: string;
    reference_scale?: number;
    hierarchy_role?: "speech" | "keyword" | "annotation" | "speaker" | "cta";
    emphasis_ref?: string;
    animation_ref?: string;
    effect_ref?: string;
    fallback: "registered_fallback" | "nle_handoff" | "blocker";
  }>;
  session: { reviewer: string; updated_at: string; started_at?: string; last_action_operation_count?: number; action_operation_counts?: number[] };
}

export interface CaptionRendererCapabilities {
  style_refs: string[];
  emphasis_refs: string[];
  animation_refs: string[];
  effect_refs: string[];
  hierarchy_roles?: string[];
}

export interface CaptionVisualTreatmentReceiptSummary {
  status: CaptionVisualTreatmentInput["status"];
  approval_hash: string;
  visual_treatment_patch_hash: string | null;
  typography_policy_hash: string;
  platform_safe_zone_profile_id: string | null;
  platform_safe_zone_profile_path: string | null;
  platform_safe_zone_profile_hash: string | null;
  accessibility: {
    reduced_motion: boolean;
    high_contrast: boolean;
    audio_off: boolean;
    small_screen: boolean;
  } | null;
  text_timing_hash: string;
  capability_hash: string;
  input_hash: string;
  applied_caption_ids: string[];
  degraded_reasons: Array<{ caption_id: string; reason: string }>;
  blocked_reasons: Array<{ caption_id: string; reason: string }>;
}

/** Human evidence for a candidate visual patch before approval binding exists. */
export interface CaptionVisualTreatmentPreapprovalReceipt extends CaptionVisualTreatmentReceiptSummary {
  version: "caption-visual-treatment-preapproval-receipt/v1";
  project_id: string;
  expected_patch_hash: string;
  preview_output?: {
    path: string;
    sha256: string;
    content_type: "video/mp4";
    receipt_path: string;
    receipt_sha256: string;
  };
  receipt_hash: string;
}

export function captionVisualTreatmentPreapprovalReceiptHash(
  receipt: CaptionVisualTreatmentPreapprovalReceipt | Omit<CaptionVisualTreatmentPreapprovalReceipt, "receipt_hash">,
): string {
  const unsigned = structuredClone(receipt) as Partial<CaptionVisualTreatmentPreapprovalReceipt>;
  delete unsigned.receipt_hash;
  return computeNormalizedJsonHash(unsigned);
}

function normalizeReceiptProfilePath(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = value.replaceAll("\\", "/");
  if (path.isAbsolute(value) || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").includes("..")) {
    throw new Error("caption visual-treatment receipt safe-zone path must be project-relative");
  }
  return normalized.replace(/^\.\//, "");
}

export function captionVisualTreatmentReceiptSummary(
  input: CaptionVisualTreatmentInput,
): CaptionVisualTreatmentReceiptSummary {
  return {
    status: input.status,
    approval_hash: input.approval_hash,
    visual_treatment_patch_hash: input.visual_treatment_patch_hash,
    typography_policy_hash: input.typography_policy_hash,
    platform_safe_zone_profile_id: input.platform_safe_zone_profile_id ?? null,
    platform_safe_zone_profile_path: normalizeReceiptProfilePath(input.platform_safe_zone_profile_path),
    platform_safe_zone_profile_hash: input.platform_safe_zone_profile_hash ?? null,
    accessibility: input.accessibility ? {
      reduced_motion: input.accessibility.reduced_motion,
      high_contrast: input.accessibility.high_contrast,
      audio_off: input.accessibility.audio_off,
      small_screen: input.accessibility.small_screen,
    } : null,
    text_timing_hash: input.text_timing_hash,
    capability_hash: input.capability_hash,
    input_hash: input.input_hash,
    applied_caption_ids: input.applied_caption_ids,
    degraded_reasons: input.degraded_reasons,
    blocked_reasons: input.blocked_reasons,
  };
}
export function captionRendererCapabilitiesHash(capabilities: CaptionRendererCapabilities): string {
  return computeNormalizedJsonHash({
    style_refs: [...new Set(capabilities.style_refs)].sort(),
    emphasis_refs: [...new Set(capabilities.emphasis_refs)].sort(),
    animation_refs: [...new Set(capabilities.animation_refs)].sort(),
    effect_refs: [...new Set(capabilities.effect_refs)].sort(),
    hierarchy_roles: [...new Set(capabilities.hierarchy_roles ?? ["speech", "keyword"])].sort(),
  });
}

/**
 * The production caption route is deliberately derived from the approved
 * typography profile and the existing caption-style registry. Callers may
 * still supply a narrower capability set (for example a test adapter or an
 * explicitly selected NLE handoff), which is then checked as-is.
 */
export function captionRendererCapabilitiesForPolicy(
  policy: TypographyPolicyDocument,
): CaptionRendererCapabilities {
  return {
    style_refs: [...new Set([
      ...Object.keys(CAPTION_STYLE_PRESETS),
    ])].sort(),
    emphasis_refs: [...new Set(policy.fallback.registered_emphasis)].sort(),
    animation_refs: [...new Set(policy.fallback.registered_animation)].sort(),
    effect_refs: [...new Set([
      ...policy.fallback.registered_effect,
      policy.visual.outline.style_ref,
      policy.visual.shadow.style_ref,
      policy.visual.panel.style_ref,
    ])].sort(),
    hierarchy_roles: Object.keys(CAPTION_HIERARCHY_CAPABILITY_REGISTRY).sort(),
  };
}

export interface CaptionVisualTreatmentResolutionOptions {
  approval: CaptionApproval;
  approval_hash?: string;
  patch?: CaptionVisualTreatmentPatch;
  typography_policy: TypographyPolicyDocument;
  typography_policy_hash?: string;
  platform_safe_zone_profile_hash?: string;
  platform_safe_zone_profile_id?: string;
  platform_safe_zone_profile_path?: string;
  platform_safe_zone_profile?: PlatformSafeZoneProfile;
  capabilities: CaptionRendererCapabilities;
  accessibility?: { reduced_motion?: boolean; high_contrast?: boolean; audio_off?: boolean; small_screen?: boolean };
  /** Draft review can resolve a patch before a human binds it to approval. */
  require_approval_binding?: boolean;
}
export interface CaptionVisualTreatmentInput {
  version: "caption-visual-treatment-input/v1";
  project_id: string;
  approval_hash: string;
  typography_policy_hash: string;
  visual_treatment_patch_hash: string | null;
  platform_safe_zone_profile_id?: string;
  platform_safe_zone_profile_path?: string;
  platform_safe_zone_profile_hash?: string;
  /** Exact values resolved by the canonical caption-style registry for Studio projection only. */
  resolved_projection?: Array<{
    caption_id: string;
    stable_root_id: string;
    style_ref: string;
    font_family: string;
    font_weight: number;
    font_size_px_1080: number;
    line_height_px_1080: number;
    fill_rgba: string;
    outline_rgba: string;
    outline_px_1080: number;
    shadow_px_1080: number;
    max_width_ratio: number;
    alignment: string;
    emphasis_scale: number;
    effect_ref?: string;
    animation_ref?: string;
    hierarchy_role?: "speech" | "keyword" | "annotation" | "speaker" | "cta";
    effect_supported: boolean;
    animation_supported: boolean;
    /** Canonical renderer support is distinct from exact Studio projection support. */
    hierarchy_supported: boolean;
    hierarchy_preview_supported: boolean;
    animation_preview_supported: boolean;
    outline_enabled: boolean;
    shadow_enabled: boolean;
    panel_enabled: boolean;
  }>;
  caption_identity: Array<{ caption_id: string; stable_root_id: string; parent_ids?: string[]; lineage_hash?: string; text: string; timeline_in_frame: number; timeline_duration_frames: number; treatment?: CaptionVisualTreatmentPatch["operations"][number]; requested_treatment?: CaptionVisualTreatmentPatch["operations"][number] }>;
  graphical_content_identity: Array<{ overlay_id: string; text: string; timeline_in_frame: number; timeline_duration_frames: number; styling_class: string; anchor: string }>;
  status: "ready" | "fallback" | "human_hold" | "blocked";
  fallbacks: Array<{ caption_id: string; kind: "registered_fallback" | "nle_handoff" | "blocker"; reason: string }>;
  renderer_route: {
    speech_captions: "ffmpeg-libass";
    graphical_content: { available: Array<"remotion" | "hyperframes">; selected: "not_selected"; status: "deferred_to_next_milestone" };
  };
  text_timing_hash: string;
  capability_hash: string;
  accessibility?: Pick<TypographyAccessibilityResolution, "reduced_motion" | "high_contrast" | "audio_off" | "small_screen">;
  applied_caption_ids: string[];
  degraded_reasons: Array<{ caption_id: string; reason: string }>;
  blocked_reasons: Array<{ caption_id: string; reason: string }>;
  input_hash: string;
}

export type CaptionVisualTreatmentApplyResult =
  | { success: true; input: CaptionVisualTreatmentInput; text_timing_hash: string; operation_count: number }
  | { success: false; errors: string[]; input?: CaptionVisualTreatmentInput };

export function parseCaptionVisualTreatmentPatch(input: unknown): CaptionVisualTreatmentPatch {
  return structuredClone(validateArtifact<CaptionVisualTreatmentPatch>(input, "caption-visual-treatment-patch.schema.json"));
}
export function loadCaptionVisualTreatmentPatch(filePath: string): CaptionVisualTreatmentPatch {
  return parseCaptionVisualTreatmentPatch(JSON.parse(fs.readFileSync(filePath, "utf8")));
}
export function captionVisualTreatmentPatchHash(patch: CaptionVisualTreatmentPatch): string { return computeNormalizedJsonHash(patch); }

/** Hash the approval fields that precede visual-treatment patch approval. */
export function captionApprovalBindingHash(approval: CaptionApproval): string {
  const binding = structuredClone(approval);
  // Visual approval is a second, reversible stream. Keep its profile/safe-zone
  // fields out of the text/timing approval binding so a visual bind can be
  // added after the existing human caption approval without rebasing the
  // patch or changing speech content.
  delete binding.approval.typography_policy_hash;
  delete binding.approval.platform_safe_zone_profile_hash;
  delete binding.approval.caption_visual_treatment_patch_hash;
  delete binding.approval.visual_treatment_input_hash;
  delete binding.approval.visual_treatment_context;
  return computeNormalizedJsonHash(binding);
}

function stableRoot(caption: CaptionApproval["speech_captions"][number]): string {
  const candidate = caption as CaptionApproval["speech_captions"][number] & { root_id?: string };
  return candidate.root_id ?? caption.caption_id;
}

function captionIdentity(caption: CaptionApproval["speech_captions"][number]) {
  const source = caption as CaptionApproval["speech_captions"][number] & {
    root_id?: string;
    parent_ids?: string[];
    lineage_hash?: string;
  };
  return {
    caption_id: caption.caption_id,
    stable_root_id: stableRoot(caption),
    ...(source.parent_ids ? { parent_ids: [...source.parent_ids] } : {}),
    ...(source.lineage_hash ? { lineage_hash: source.lineage_hash } : {}),
    text: caption.text,
    timeline_in_frame: caption.timeline_in_frame,
    timeline_duration_frames: caption.timeline_duration_frames,
  };
}

function operationFallback(
  operation: CaptionVisualTreatmentPatch["operations"][number],
  policy: TypographyPolicyDocument,
  missing: string[],
): CaptionVisualTreatmentPatch["operations"][number] {
  if (operation.fallback !== "registered_fallback") return structuredClone(operation);
  const resolved = structuredClone(operation);
  if (missing.some((value) => value.startsWith("style_ref="))) resolved.style_ref = policy.baseline_style_ref;
  if (missing.some((value) => value.startsWith("emphasis_ref="))) delete resolved.emphasis_ref;
  if (missing.some((value) => value.startsWith("animation_ref="))) delete resolved.animation_ref;
  if (missing.some((value) => value.startsWith("effect_ref="))) delete resolved.effect_ref;
  if (missing.some((value) => value.startsWith("hierarchy_role="))) delete resolved.hierarchy_role;
  return resolved;
}

function safeZoneConflict(
  operation: CaptionVisualTreatmentPatch["operations"][number],
  profile?: PlatformSafeZoneProfile,
): string | undefined {
  const rect = operation.rect;
  if (!rect || !profile) return undefined;
  if (profile.geometry.status !== "verified" || profile.geometry.safe_regions.unknown) {
    return "safe-zone geometry is not verified";
  }
  const contained = profile.geometry.safe_regions.regions.some((region) =>
    rect.x >= region.rect.x
    && rect.y >= region.rect.y
    && rect.x + rect.width <= region.rect.x + region.rect.width
    && rect.y + rect.height <= region.rect.y + region.rect.height,
  );
  if (!contained) return "visual treatment rect is outside every verified safe region";
  const overlapsUi = profile.geometry.ui_regions.regions.some((region) =>
    rect.x < region.rect.x + region.rect.width
    && rect.x + rect.width > region.rect.x
    && rect.y < region.rect.y + region.rect.height
    && rect.y + rect.height > region.rect.y,
  );
  return overlapsUi ? "visual treatment rect overlaps a verified platform UI region" : undefined;
}

/** Resolve renderer input only. This function never edits caption text or timing. */
export function resolveCaptionVisualTreatmentInput(options: CaptionVisualTreatmentResolutionOptions): CaptionVisualTreatmentInput {
  // The binding hash excludes patch/input fields, so the completed input hash
  // can be computed before those fields are written back to approval.
  const approvalHash = options.approval_hash ?? captionApprovalBindingHash(options.approval);
  const typographyHash = options.typography_policy_hash ?? computeNormalizedJsonHash(options.typography_policy);
  const patchHash = options.patch ? captionVisualTreatmentPatchHash(options.patch) : null;
  const textTimingHash = computeNormalizedJsonHash(options.approval.speech_captions.map((caption) => captionIdentity(caption)));
  const fallbacks: CaptionVisualTreatmentInput["fallbacks"] = [];
  const identities = options.approval.speech_captions.map((caption) => captionIdentity(caption));
  const accessibility = options.accessibility
    ? resolveTypographyAccessibility(options.typography_policy, options.accessibility)
    : undefined;
  const capabilityHash = captionRendererCapabilitiesHash(options.capabilities);
  const requireApprovalBinding = options.require_approval_binding !== false;
  const graphicalContent = options.approval.text_overlays.map((overlay) => ({ overlay_id: overlay.overlay_id, text: overlay.text, timeline_in_frame: overlay.timeline_in_frame, timeline_duration_frames: overlay.timeline_duration_frames, styling_class: overlay.styling_class, anchor: overlay.anchor }));
  if (options.approval.approval.status !== "approved") fallbacks.push({ caption_id: "__approval__", kind: "blocker", reason: "caption approval is stale or not approved" });
  if (!options.approval.approval.typography_policy_hash) {
    if (requireApprovalBinding) fallbacks.push({ caption_id: "__approval__", kind: "blocker", reason: "approved typography profile hash is missing" });
  } else if (options.approval.approval.typography_policy_hash !== typographyHash) fallbacks.push({ caption_id: "__approval__", kind: "blocker", reason: "approved typography profile hash is stale" });
  if (options.approval.approval.platform_safe_zone_profile_hash && options.approval.approval.platform_safe_zone_profile_hash !== options.platform_safe_zone_profile_hash) fallbacks.push({ caption_id: "__approval__", kind: "blocker", reason: "approved platform safe-zone profile hash is stale or unavailable" });
  if (requireApprovalBinding && !options.approval.approval.caption_visual_treatment_patch_hash) fallbacks.push({ caption_id: "__approval__", kind: "blocker", reason: "approved visual-treatment patch hash is missing" });
  else if (requireApprovalBinding && (!options.patch || options.approval.approval.caption_visual_treatment_patch_hash !== patchHash)) fallbacks.push({ caption_id: "__approval__", kind: "blocker", reason: "approved visual-treatment patch hash is stale or unavailable" });
  if (accessibility) {
    const accessibilityModes: Array<[boolean, string, "registered_fallback" | "nle_handoff" | "none"]> = [
      [accessibility.reduced_motion, "reduced_motion", options.typography_policy.accessibility.reduced_motion === "human_review" ? "nle_handoff" : options.typography_policy.accessibility.reduced_motion === "registered_fallback" ? "registered_fallback" : "none"],
      [accessibility.high_contrast, "high_contrast", options.typography_policy.accessibility.high_contrast === "human_review" ? "nle_handoff" : options.typography_policy.accessibility.high_contrast === "registered_fallback" ? "registered_fallback" : "none"],
      [accessibility.audio_off, "audio_off", options.typography_policy.accessibility.audio_off === "human_review" ? "nle_handoff" : options.typography_policy.accessibility.audio_off === "registered_fallback" ? "registered_fallback" : "none"],
      [accessibility.small_screen, "small_screen", options.typography_policy.accessibility.small_screen === "human_review" ? "nle_handoff" : "registered_fallback"],
    ];
    for (const [active, modeName, kind] of accessibilityModes) {
      if (active && kind !== "none") {
        const policyMode = options.typography_policy.accessibility[modeName as keyof TypographyPolicyDocument["accessibility"]];
        fallbacks.push({ caption_id: "__accessibility__", kind, reason: `${modeName} uses profile mode ${policyMode}` });
      }
    }
  }
  if (options.patch) {
    if (options.patch.project_id !== options.approval.project_id) fallbacks.push({ caption_id: "__patch__", kind: "blocker", reason: "visual treatment patch project_id mismatch" });
    if (options.patch.caption_approval_hash !== approvalHash && options.patch.caption_approval_hash !== captionApprovalBindingHash(options.approval)) fallbacks.push({ caption_id: "__patch__", kind: "blocker", reason: "visual treatment patch approval hash is stale" });
    if (options.patch.typography_policy_hash !== typographyHash) fallbacks.push({ caption_id: "__patch__", kind: "blocker", reason: "visual treatment patch typography hash is stale" });
    if (options.patch.platform_safe_zone_profile_hash && options.patch.platform_safe_zone_profile_hash !== options.platform_safe_zone_profile_hash) fallbacks.push({ caption_id: "__patch__", kind: "blocker", reason: "visual treatment patch safe-zone profile hash is stale or unavailable" });
    if (options.approval.approval.base_caption_draft_hash && options.patch.base_caption_draft_hash !== options.approval.approval.base_caption_draft_hash) fallbacks.push({ caption_id: "__patch__", kind: "blocker", reason: "visual treatment patch caption draft hash is stale" });
    if (options.approval.approval.base_timeline_hash && options.patch.base_timeline_hash !== options.approval.approval.base_timeline_hash) fallbacks.push({ caption_id: "__patch__", kind: "blocker", reason: "visual treatment patch timeline hash is stale" });
    for (const operation of options.patch.operations) {
      const identity = identities.find((item) => item.caption_id === operation.caption_id);
      if (!identity || identity.stable_root_id !== operation.stable_root_id) {
        fallbacks.push({ caption_id: operation.caption_id, kind: "blocker", reason: "visual treatment operation does not match stable caption identity" });
        continue;
      }
      const missing: string[] = [];
      if (!options.capabilities.style_refs.includes(operation.style_ref)) missing.push(`style_ref=${operation.style_ref}`);
      if (operation.emphasis_ref && !options.capabilities.emphasis_refs.includes(operation.emphasis_ref)) missing.push(`emphasis_ref=${operation.emphasis_ref}`);
      if (operation.animation_ref && !options.capabilities.animation_refs.includes(operation.animation_ref)) missing.push(`animation_ref=${operation.animation_ref}`);
      if (operation.effect_ref && !options.capabilities.effect_refs.includes(operation.effect_ref)) missing.push(`effect_ref=${operation.effect_ref}`);
      const hierarchyRoles = options.capabilities.hierarchy_roles ?? Object.keys(CAPTION_HIERARCHY_CAPABILITY_REGISTRY);
      if (operation.hierarchy_role && !hierarchyRoles.includes(operation.hierarchy_role)) missing.push(`hierarchy_role=${operation.hierarchy_role}`);
      const safeConflict = safeZoneConflict(operation, options.platform_safe_zone_profile);
      if (missing.length > 0) fallbacks.push({ caption_id: operation.caption_id, kind: operation.fallback, reason: `renderer capability is missing: ${missing.join(", ")}` });
      if (safeConflict) fallbacks.push({ caption_id: operation.caption_id, kind: operation.fallback === "nle_handoff" ? "nle_handoff" : operation.fallback === "blocker" ? "blocker" : "registered_fallback", reason: safeConflict });
      const target = identities.find((item) => item.caption_id === operation.caption_id);
      if (target) {
        (target as typeof target & { treatment?: typeof operation; requested_treatment?: typeof operation }).requested_treatment = structuredClone(operation);
        const degraded = missing.length > 0 || Boolean(safeConflict);
        let resolved = degraded ? operationFallback(operation, options.typography_policy, missing) : structuredClone(operation);
        if (safeConflict && operation.fallback === "registered_fallback") {
          // A registered safe-zone fallback returns ownership to the profile's
          // baseline layout; the requested rect remains in the patch/receipt.
          delete resolved.rect;
          resolved.style_ref = options.typography_policy.baseline_style_ref;
        }
        if (accessibility?.reduced_motion && resolved.animation_ref) {
          const mode = options.typography_policy.accessibility.reduced_motion;
          if (mode === "static" || mode === "registered_fallback" || mode === "human_review") {
            fallbacks.push({ caption_id: operation.caption_id, kind: mode === "human_review" ? "nle_handoff" : "registered_fallback", reason: `reduced motion removes animation_ref=${resolved.animation_ref}` });
            delete resolved.animation_ref;
          }
        }
        if (accessibility?.high_contrast) {
          const mode = options.typography_policy.accessibility.high_contrast;
          if (mode === "human_review") {
            fallbacks.push({ caption_id: operation.caption_id, kind: "nle_handoff", reason: "high contrast requires human review" });
          } else if (mode === "registered_fallback") {
            fallbacks.push({ caption_id: operation.caption_id, kind: "registered_fallback", reason: "high contrast uses the typography profile contrast fallback" });
            resolved.style_ref = options.typography_policy.baseline_style_ref;
          }
        }
        if (accessibility?.audio_off) {
          const mode = options.typography_policy.accessibility.audio_off;
          if (mode === "human_review") {
            fallbacks.push({ caption_id: operation.caption_id, kind: "nle_handoff", reason: "audio-off requires human review for visual treatment" });
          } else if (mode === "registered_fallback") {
            fallbacks.push({ caption_id: operation.caption_id, kind: "registered_fallback", reason: "audio-off uses the typography profile visual fallback" });
            resolved.style_ref = options.typography_policy.baseline_style_ref;
          }
        }
        (target as typeof target & { treatment?: typeof operation }).treatment = resolved;
      }
    }
  }
  const resolvedProjection = () => identities.flatMap((identity) => {
    const treatment = (identity as typeof identity & { treatment?: CaptionVisualTreatmentPatch["operations"][number] }).treatment
      ?? {
        caption_id: identity.caption_id,
        stable_root_id: identity.stable_root_id,
        anchor: "bottom_center" as const,
        style_ref: options.approval.caption_policy.styling_class,
        fallback: "registered_fallback" as const,
      };
    if (!treatment || !hasCaptionStylePreset(treatment.style_ref)) return [];
    const preset = resolveCaptionStylePreset(treatment.style_ref);
    const effectRef = treatment.effect_ref;
    const animationRef = treatment.animation_ref;
    return [{
      caption_id: identity.caption_id,
      stable_root_id: identity.stable_root_id,
      style_ref: treatment.style_ref,
      font_family: preset.fontFamily,
      font_weight: preset.fontWeight,
      font_size_px_1080: preset.fontSizePx1080,
      line_height_px_1080: preset.lineHeightPx1080,
      fill_rgba: preset.fillRgba,
      outline_rgba: preset.outlineRgba,
      outline_px_1080: preset.outlinePx1080,
      shadow_px_1080: preset.shadowPx1080,
      max_width_ratio: preset.maxWidthRatio,
      alignment: preset.alignment,
      emphasis_scale: treatment.emphasis_ref ? 1.1 : 1,
      ...(effectRef ? { effect_ref: effectRef } : {}),
      ...(animationRef ? { animation_ref: animationRef } : {}),
      ...(treatment.hierarchy_role ? { hierarchy_role: treatment.hierarchy_role } : {}),
      effect_supported: !effectRef || options.capabilities.effect_refs.includes(effectRef),
      animation_supported: !animationRef || options.capabilities.animation_refs.includes(animationRef),
      hierarchy_supported: !treatment.hierarchy_role || (options.capabilities.hierarchy_roles ?? Object.keys(CAPTION_HIERARCHY_CAPABILITY_REGISTRY)).includes(treatment.hierarchy_role),
      // Studio has no canonical animation or hierarchy renderer. Reduced motion
      // removes animation_ref above, making the remaining static projection exact.
      hierarchy_preview_supported: !treatment.hierarchy_role,
      animation_preview_supported: !animationRef,
      outline_enabled: !effectRef || effectRef.includes("outline"),
      shadow_enabled: effectRef?.includes("shadow") ?? false,
      panel_enabled: effectRef?.includes("panel") ?? false,
    }];
  });
  const buildResult = (currentFallbacks: CaptionVisualTreatmentInput["fallbacks"]): Omit<CaptionVisualTreatmentInput, "input_hash"> => ({
    version: "caption-visual-treatment-input/v1",
    project_id: options.approval.project_id,
    approval_hash: approvalHash,
    typography_policy_hash: typographyHash,
    visual_treatment_patch_hash: patchHash,
    ...(options.platform_safe_zone_profile_id ? { platform_safe_zone_profile_id: options.platform_safe_zone_profile_id } : {}),
    ...(options.platform_safe_zone_profile_path ? { platform_safe_zone_profile_path: options.platform_safe_zone_profile_path } : {}),
    ...(options.platform_safe_zone_profile_hash ? { platform_safe_zone_profile_hash: options.platform_safe_zone_profile_hash } : {}),
    resolved_projection: resolvedProjection(),
    caption_identity: identities,
    graphical_content_identity: graphicalContent,
    status: currentFallbacks.some((item) => item.kind === "blocker") ? "blocked" : currentFallbacks.some((item) => item.kind === "nle_handoff") ? "human_hold" : currentFallbacks.length > 0 ? "fallback" : "ready",
    fallbacks: currentFallbacks,
    renderer_route: {
      speech_captions: "ffmpeg-libass",
      graphical_content: { available: ["remotion", "hyperframes"], selected: "not_selected", status: "deferred_to_next_milestone" },
    },
    text_timing_hash: textTimingHash,
    capability_hash: capabilityHash,
    ...(accessibility ? { accessibility: { reduced_motion: accessibility.reduced_motion, high_contrast: accessibility.high_contrast, audio_off: accessibility.audio_off, small_screen: accessibility.small_screen } } : {}),
    applied_caption_ids: identities.filter((identity) => Boolean((identity as typeof identity & { treatment?: unknown }).treatment)).map((identity) => identity.caption_id),
    degraded_reasons: currentFallbacks.filter((item) => item.kind === "registered_fallback").map((item) => ({ caption_id: item.caption_id, reason: item.reason })),
    blocked_reasons: currentFallbacks.filter((item) => item.kind === "blocker" || item.kind === "nle_handoff").map((item) => ({ caption_id: item.caption_id, reason: item.reason })),
  });
  const canonicalResult = buildResult(fallbacks);
  const canonicalInputHash = computeNormalizedJsonHash(canonicalResult);
  if (requireApprovalBinding && !options.approval.approval.visual_treatment_input_hash) {
    fallbacks.push({ caption_id: "__approval__", kind: "blocker", reason: "approved visual-treatment input hash is missing" });
  } else if (requireApprovalBinding && options.approval.approval.visual_treatment_input_hash !== canonicalInputHash) {
    fallbacks.push({ caption_id: "__approval__", kind: "blocker", reason: "approved visual-treatment input hash is stale" });
  }
  const result = buildResult(fallbacks);
  const resolved = { ...result, input_hash: computeNormalizedJsonHash(result) };
  return validateArtifact<CaptionVisualTreatmentInput>(resolved, "caption-visual-treatment-input.schema.json");
}

/**
 * Apply is intentionally a pure, reversible boundary. The returned identity
 * list is the only thing downstream renderers consume; the approval's speech
 * text/timing array is never mutated.
 */
export function applyCaptionVisualTreatmentPatch(
  options: CaptionVisualTreatmentResolutionOptions,
): CaptionVisualTreatmentApplyResult {
  const input = resolveCaptionVisualTreatmentInput(options);
  if (input.status === "blocked" || input.status === "human_hold") {
    return { success: false, errors: input.blocked_reasons.map((item) => `${item.caption_id}: ${item.reason}`).concat(input.fallbacks.filter((item) => item.kind === "nle_handoff").map((item) => `${item.caption_id}: ${item.reason}`)), input };
  }
  return { success: true, input, text_timing_hash: input.text_timing_hash, operation_count: input.applied_caption_ids.length };
}

/** Compute the non-circular input hash used to bind approval to the resolved input. */
export function captionVisualTreatmentCanonicalInputHash(options: CaptionVisualTreatmentResolutionOptions): string {
  const approval = structuredClone(options.approval);
  delete approval.approval.visual_treatment_input_hash;
  const provisional = resolveCaptionVisualTreatmentInput({ ...options, approval });
  const fallbacks = provisional.fallbacks.filter((item) => item.reason !== "approved visual-treatment input hash is missing");
  const canonical = {
    ...provisional,
    status: fallbacks.some((item) => item.kind === "blocker") ? "blocked" : fallbacks.some((item) => item.kind === "nle_handoff") ? "human_hold" : fallbacks.length > 0 ? "fallback" : "ready",
    fallbacks,
    degraded_reasons: fallbacks.filter((item) => item.kind === "registered_fallback").map((item) => ({ caption_id: item.caption_id, reason: item.reason })),
    blocked_reasons: fallbacks.filter((item) => item.kind === "blocker" || item.kind === "nle_handoff").map((item) => ({ caption_id: item.caption_id, reason: item.reason })),
  };
  delete (canonical as Partial<CaptionVisualTreatmentInput>).input_hash;
  return computeNormalizedJsonHash(canonical);
}
