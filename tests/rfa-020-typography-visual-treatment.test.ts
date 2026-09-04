import * as path from "node:path";
import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import { computeNormalizedJsonHash } from "../runtime/artifacts/p1-manifest-coverage.js";
import { parseTypographyPolicy, resolveTypographyAccessibility, resolveTypographyLayout, loadTypographyPolicy } from "../runtime/caption/typography-policy.js";
import { captionApprovalBindingHash, captionVisualTreatmentCanonicalInputHash, captionVisualTreatmentPatchHash, parseCaptionVisualTreatmentPatch, resolveCaptionVisualTreatmentInput, type CaptionVisualTreatmentPatch } from "../runtime/caption/visual-treatment.js";
import type { CaptionApproval } from "../runtime/caption/approval.js";
import { validateAgainstSchema } from "../runtime/commands/shared.js";
import {
  resolveCanonicalCaptionVisualTreatmentInput,
  shouldPreflightCanonicalCaptionVisualTreatment,
} from "../runtime/render/canonical-render-input.js";
import { breakLines } from "../runtime/caption/line-breaker.js";
import { runRenderPipeline } from "../runtime/render/pipeline.js";

const root = process.cwd();
const typography = loadTypographyPolicy(path.join(root, "tests/fixtures/rfa-caption/typography-policy.json"));

function approval(status: "approved" | "stale" = "approved"): CaptionApproval {
  return {
    version: "caption-draft/v1",
    project_id: "rfa-020-fixture",
    base_timeline_version: "timeline-fixture-v1",
    caption_policy: { language: "ja", delivery_mode: "burn_in", source: "transcript", styling_class: "sns-vertical-outline" },
    speech_captions: [{
      caption_id: "SC_0001",
      root_id: "SC_0001",
      asset_id: "AS_fixture",
      segment_id: "SEG_fixture",
      timeline_in_frame: 10,
      timeline_duration_frames: 48,
      text: "RoughCut Agentのタイムラインを確認",
      transcript_ref: "TR_fixture",
      transcript_item_ids: ["TRI_fixture"],
      source: "transcript",
      styling_class: "sns-vertical-outline",
      metrics: { cps: 8, dwell_ms: 2000 },
    }],
    text_overlays: [],
    approval: {
      status,
      approved_by: "fixture-reviewer",
      approved_at: "2026-08-21T00:00:00Z",
      base_caption_draft_hash: `sha256:${"b".repeat(64)}`,
      base_timeline_hash: `sha256:${"c".repeat(64)}`,
      typography_policy_hash: computeNormalizedJsonHash(typography),
    },
  };
}

function patchFor(currentApproval: CaptionApproval): CaptionVisualTreatmentPatch {
  return {
    version: "caption-visual-treatment-patch/v1",
    project_id: currentApproval.project_id,
    base_caption_draft_hash: currentApproval.approval.base_caption_draft_hash!,
    base_timeline_hash: currentApproval.approval.base_timeline_hash!,
    typography_policy_hash: computeNormalizedJsonHash(typography),
    caption_approval_hash: captionApprovalBindingHash(currentApproval),
    operations: [{
      caption_id: "SC_0001",
      stable_root_id: "SC_0001",
      anchor: "bottom_center",
      style_ref: "baseline-outline",
      hierarchy_role: "speech",
      emphasis_ref: "emphasis-word",
      animation_ref: "semantic-reveal",
      effect_ref: "outline",
      fallback: "nle_handoff",
    }],
    session: { reviewer: "fixture-reviewer", updated_at: "2026-08-21T00:00:00Z" },
  };
}

describe("RFA-020 typography approval and visual-treatment input foundation", () => {
  it("measures mixed Japanese/Latin text and preserves protected terms through human line override", () => {
    const layout = resolveTypographyLayout({
      text: "RoughCut Agentのタイムラインを確認",
      language: "ja",
      manual_lines: ["RoughCut Agent", "のタイムラインを確認"],
      policy: typography,
    });
    expect(layout.manual_override_applied).toBe(true);
    expect(layout.lines).toEqual(["RoughCut Agent", "のタイムラインを確認"]);
    expect(layout.issues).not.toEqual(expect.arrayContaining([expect.objectContaining({ code: "protected_term", severity: "block" })]));
    expect(layout.display_units[0]).toBeGreaterThan(0);
    expect(resolveTypographyAccessibility(typography, { reduced_motion: true, high_contrast: true, audio_off: true, small_screen: true }).status).toBe("fallback");
  });

  it("blocks a human line override that changes the caption text", () => {
    const layout = resolveTypographyLayout({
      text: "RoughCut Agentのタイムラインを確認",
      language: "ja",
      manual_lines: ["RoughCut Agent", "別の文"],
      policy: typography,
    });
    expect(layout.status).toBe("blocked");
    expect(layout.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "text_integrity", severity: "block" })]));
  });

  it("requires approved hashes, preserves caption identity/timing, and records existing renderer routes", () => {
    const currentApproval = approval();
    const patch = parseCaptionVisualTreatmentPatch(patchFor(currentApproval));
    currentApproval.approval.caption_visual_treatment_patch_hash = captionVisualTreatmentPatchHash(patch);
    currentApproval.approval.visual_treatment_input_hash = captionVisualTreatmentCanonicalInputHash({
      approval: currentApproval,
      patch,
      typography_policy: typography,
      capabilities: { style_refs: ["baseline-outline"], emphasis_refs: ["emphasis-word"], animation_refs: [], effect_refs: [] },
    });
    const result = resolveCaptionVisualTreatmentInput({
      approval: currentApproval,
      patch,
      typography_policy: typography,
      capabilities: { style_refs: ["baseline-outline"], emphasis_refs: ["emphasis-word"], animation_refs: [], effect_refs: [] },
    });
    expect(result.status).toBe("human_hold");
    expect(result.fallbacks).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "nle_handoff" })]));
    expect(result.caption_identity[0]).toMatchObject({ caption_id: "SC_0001", stable_root_id: "SC_0001", text: currentApproval.speech_captions[0].text, timeline_in_frame: 10, timeline_duration_frames: 48 });
    expect(result.renderer_route).toEqual({ speech_captions: "ffmpeg-libass", graphical_content: { available: ["remotion", "hyperframes"], selected: "not_selected", status: "deferred_to_next_milestone" } });
    expect(validateAgainstSchema(result, "caption-visual-treatment-input.schema.json").valid).toBe(true);
  });

  it("blocks stale caption approval rather than changing text or timing", () => {
    const stale = approval("stale");
    const result = resolveCaptionVisualTreatmentInput({ approval: stale, typography_policy: typography, capabilities: { style_refs: [], emphasis_refs: [], animation_refs: [], effect_refs: [] } });
    expect(result.status).toBe("blocked");
    expect(result.fallbacks).toEqual(expect.arrayContaining([expect.objectContaining({ caption_id: "__approval__", kind: "blocker" })]));
    expect(result.caption_identity[0].text).toBe(stale.speech_captions[0].text);
  });

  it("blocks an approval whose platform safe-zone profile hash is unavailable or stale", () => {
    const current = approval();
    current.approval.platform_safe_zone_profile_hash = `sha256:${"a".repeat(64)}`;
    const result = resolveCaptionVisualTreatmentInput({
      approval: current,
      typography_policy: typography,
      platform_safe_zone_profile_hash: `sha256:${"b".repeat(64)}`,
      capabilities: { style_refs: [], emphasis_refs: [], animation_refs: [], effect_refs: [] },
    });
    expect(result.status).toBe("blocked");
    expect(result.fallbacks).toEqual(expect.arrayContaining([expect.objectContaining({ reason: expect.stringContaining("safe-zone") })]));
  });

  it("fails closed for an unregistered baseline and does not invent punctuation warnings", () => {
    const unregistered = structuredClone(typography);
    unregistered.baseline_style_ref = "unregistered-style";
    expect(() => parseTypographyPolicy(unregistered)).toThrow(/not registered/);
    const policyWithoutPunctuation = structuredClone(typography);
    policyWithoutPunctuation.wrapping.line_start_punctuation = [];
    policyWithoutPunctuation.wrapping.orphan_tokens = [];
    const layout = resolveTypographyLayout({ text: "。確認", language: "ja", manual_lines: ["。確認"], policy: policyWithoutPunctuation });
    expect(layout.issues).not.toEqual(expect.arrayContaining([expect.objectContaining({ code: "punctuation" })]));
  });

  it("lets declared break priorities choose punctuation versus balanced midpoint", () => {
    const base = {
      maxCharsPerLine: 8, maxLines: 2, maxCps: 20, language: "ja",
      measurement_mode: "unicode_display_units" as const, full_width_unit: 1, latin_unit: 1, maxLineUnits: 8,
      line_start_punctuation: ["。"], line_end_punctuation: [], break_after: ["。"],
    };
    const text = "短。これは説明です";
    const punctuation = breakLines(text, { ...base, break_priorities: ["punctuation"] }, []);
    const balanced = breakLines(text, { ...base, break_priorities: ["balanced_midpoint"] }, []);
    expect(punctuation.lines).not.toEqual(balanced.lines);
    expect(punctuation.selection_reason).toBe("punctuation");
    expect(balanced.selection_reason).toBe("balanced_midpoint");
  });

  it("uses the canonical render-input route and blocks a missing visual-treatment patch", () => {
    const project = fs.mkdtempSync(path.join(root, "tests/tmp-rfa020-render-input-"));
    try {
      fs.mkdirSync(path.join(project, "07_package"), { recursive: true });
      fs.mkdirSync(path.join(project, "04_plan"), { recursive: true });
      const currentApproval = approval();
      const patch = parseCaptionVisualTreatmentPatch(patchFor(currentApproval));
      currentApproval.approval.caption_visual_treatment_patch_hash = captionVisualTreatmentPatchHash(patch);
      fs.writeFileSync(path.join(project, "07_package/caption_approval.json"), JSON.stringify(currentApproval));
      fs.writeFileSync(path.join(project, "04_plan/typography_policy.json"), JSON.stringify(typography));
      const blocked = resolveCanonicalCaptionVisualTreatmentInput(project, { typographyPolicyPath: "04_plan/typography_policy.json" });
      expect(blocked.status).toBe("blocked");
      expect(blocked.visual_treatment_patch_hash).toBeNull();
      expect(blocked.input_hash).toMatch(/^sha256:/);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it("preflights the default canonical profile with legacy approval and preserves pure legacy routing", async () => {
    const project = fs.mkdtempSync(path.join(root, "tests/tmp-rfa020-default-profile-preflight-"));
    try {
      fs.mkdirSync(path.join(project, "07_package"), { recursive: true });
      fs.mkdirSync(path.join(project, "04_plan"), { recursive: true });
      const legacyApproval = approval();
      delete legacyApproval.approval.typography_policy_hash;
      delete legacyApproval.approval.caption_visual_treatment_patch_hash;
      delete legacyApproval.approval.visual_treatment_input_hash;
      fs.writeFileSync(path.join(project, "07_package/caption_approval.json"), JSON.stringify(legacyApproval));
      fs.writeFileSync(path.join(project, "04_plan/typography_policy.json"), JSON.stringify(typography));

      expect(shouldPreflightCanonicalCaptionVisualTreatment(project, {
        approval: legacyApproval.approval,
      })).toBe(true);
      await expect(runRenderPipeline({
        projectDir: project,
        timelinePath: path.join(project, "05_timeline/missing.json"),
        captionApprovalPath: path.join(project, "07_package/caption_approval.json"),
        assemblyPath: path.join(project, "assembly.mp4"),
        captionPolicy: { language: "ja", delivery_mode: "sidecar", source: "authored", styling_class: "sns-vertical-outline" },
        outputDir: path.join(project, "07_package"),
        fps: 30,
        assertMediaWriteReadyImpl: () => ({ ok: true, checks: [] }),
      })).rejects.toThrow(/Canonical caption visual-treatment input is not renderable: blocked/);

      fs.rmSync(path.join(project, "04_plan/typography_policy.json"));
      expect(shouldPreflightCanonicalCaptionVisualTreatment(project, {
        approval: legacyApproval.approval,
      })).toBe(false);
      await expect(runRenderPipeline({
        projectDir: project,
        timelinePath: path.join(project, "05_timeline/missing.json"),
        assemblyPath: path.join(project, "assembly.mp4"),
        captionPolicy: { language: "ja", delivery_mode: "sidecar", source: "authored", styling_class: "sns-vertical-outline" },
        outputDir: path.join(project, "07_package"),
        fps: 30,
        assertMediaWriteReadyImpl: () => ({ ok: true, checks: [] }),
      })).rejects.toThrow(/Assembly file not found/);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it("blocks a missing approval input hash at the render entry when RFA-020 artifacts are present", async () => {
    const project = fs.mkdtempSync(path.join(root, "tests/tmp-rfa020-render-preflight-"));
    try {
      fs.mkdirSync(path.join(project, "07_package"), { recursive: true });
      fs.mkdirSync(path.join(project, "04_plan"), { recursive: true });
      const currentApproval = approval();
      const patch = parseCaptionVisualTreatmentPatch(patchFor(currentApproval));
      currentApproval.approval.caption_visual_treatment_patch_hash = captionVisualTreatmentPatchHash(patch);
      fs.writeFileSync(path.join(project, "07_package/caption_approval.json"), JSON.stringify(currentApproval));
      fs.writeFileSync(path.join(project, "04_plan/typography_policy.json"), JSON.stringify(typography));
      fs.writeFileSync(path.join(project, "04_plan/visual-treatment-patch.json"), JSON.stringify(patch));
      await expect(runRenderPipeline({
        projectDir: project,
        timelinePath: path.join(project, "05_timeline/missing.json"),
        captionApprovalPath: path.join(project, "07_package/caption_approval.json"),
        typographyPolicyPath: "04_plan/typography_policy.json",
        visualTreatmentPatchPath: "04_plan/visual-treatment-patch.json",
        assemblyPath: path.join(project, "assembly.mp4"),
        captionPolicy: { language: "ja", delivery_mode: "sidecar", source: "authored", styling_class: "sns-vertical-outline" },
        outputDir: path.join(project, "07_package"),
        fps: 30,
        assertMediaWriteReadyImpl: () => ({ ok: true, checks: [] }),
      })).rejects.toThrow(/Canonical caption visual-treatment input is not renderable: blocked/);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});
