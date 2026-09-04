import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeNormalizedJsonHash } from "../runtime/artifacts/p1-manifest-coverage.js";
import { createDraftApproval, type CaptionApproval } from "../runtime/caption/approval.js";
import {
  appendCaptionVisualTreatmentOperations,
  approveCaptionVisualTreatment,
  canUndoCaptionVisualTreatment,
  initializeCaptionVisualTreatmentPatch,
  inspectCaptionVisualTreatment,
  previewCaptionVisualTreatment,
  undoCaptionVisualTreatment,
} from "../runtime/caption/review-service.js";
import { loadTypographyPolicy } from "../runtime/caption/typography-policy.js";
import {
  captionApprovalBindingHash,
  captionVisualTreatmentPatchHash,
  captionVisualTreatmentReceiptSummary,
  captionRendererCapabilitiesForPolicy,
  captionVisualTreatmentCanonicalInputHash,
  parseCaptionVisualTreatmentPatch,
  resolveCaptionVisualTreatmentInput,
  type CaptionVisualTreatmentPatch,
} from "../runtime/caption/visual-treatment.js";
import { resolveCanonicalCaptionVisualTreatmentInput } from "../runtime/render/canonical-render-input.js";
import {
  buildAssDocument,
  resolveCaptionStylePreset,
  type AssCaptionVisualTreatment,
} from "../editor/shared/caption-style-tokens.js";
import { loadPlatformSafeZoneProfile } from "../runtime/platform/safe-zone-profile.js";

const repoRoot = process.cwd();
const policySourcePath = path.join(repoRoot, "tests/fixtures/rfa-caption/typography-policy.json");
const temporaryProjects: string[] = [];

afterEach(() => {
  for (const project of temporaryProjects.splice(0)) fs.rmSync(project, { recursive: true, force: true });
});

function operation(overrides: Partial<CaptionVisualTreatmentPatch["operations"][number]> = {}): CaptionVisualTreatmentPatch["operations"][number] {
  return {
    caption_id: "SC_001",
    stable_root_id: "SC_001",
    anchor: "center",
    rect: { x: 0.1, y: 0.2, width: 0.8, height: 0.2 },
    style_ref: "sns-vertical-outline",
    hierarchy_role: "speech",
    fallback: "registered_fallback",
    ...overrides,
  };
}

function createVisualReviewProject(): { projectDir: string; approval: CaptionApproval; policyPath: string } {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "rfa020-visual-review-"));
  temporaryProjects.push(projectDir);
  const policyPath = path.join(projectDir, "04_plan/typography_policy.json");
  fs.mkdirSync(path.dirname(policyPath), { recursive: true });
  fs.mkdirSync(path.join(projectDir, "05_timeline"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, "07_package"), { recursive: true });
  fs.copyFileSync(policySourcePath, policyPath);

  const timeline = {
    version: "1",
    project_id: "rfa020-visual-review",
    sequence: { name: "RFA-020 anonymous review", fps_num: 24, fps_den: 1, width: 720, height: 1280, start_frame: 0 },
    tracks: { video: [], audio: [] },
  };
  const source = {
    version: "caption-draft/v1",
    project_id: "rfa020-visual-review",
    base_timeline_version: "1",
    caption_policy: { language: "ja", delivery_mode: "burn_in", source: "transcript", styling_class: "sns-vertical-outline" },
    speech_captions: [{
      caption_id: "SC_001",
      root_id: "SC_001",
      asset_id: "anonymous",
      segment_id: "SEG_001",
      timeline_in_frame: 12,
      timeline_duration_frames: 48,
      text: "承認済みの本文です",
      transcript_ref: "TR_001",
      transcript_item_ids: ["TI_001"],
      source: "transcript",
      styling_class: "sns-vertical-outline",
      metrics: { cps: 8, dwell_ms: 2000 },
    }],
    text_overlays: [],
  };
  fs.writeFileSync(path.join(projectDir, "05_timeline/timeline.json"), `${JSON.stringify(timeline, null, 2)}\n`);
  fs.writeFileSync(path.join(projectDir, "07_package/caption_draft.json"), `${JSON.stringify(source, null, 2)}\n`);
  const approval = createDraftApproval(source as never, "human-reviewer", "2026-08-21T00:00:00.000Z", {
    base_caption_draft_hash: computeNormalizedJsonHash(source),
    base_timeline_hash: computeNormalizedJsonHash(timeline),
    caption_review_patch_hash: `sha256:${"1".repeat(64)}`,
    validation_hash: `sha256:${"2".repeat(64)}`,
  });
  fs.writeFileSync(path.join(projectDir, "07_package/caption_approval.json"), `${JSON.stringify(approval, null, 2)}\n`);
  return { projectDir, approval, policyPath };
}

describe("RFA-020 visual review service and renderer boundary", () => {
  it("keeps visual treatment independent, undoable, and human-bound without changing speech text/timing", () => {
    const { projectDir, approval: approvalBefore, policyPath } = createVisualReviewProject();
    const draftBefore = fs.readFileSync(path.join(projectDir, "07_package/caption_draft.json"), "utf8");
    const timelineBefore = fs.readFileSync(path.join(projectDir, "05_timeline/timeline.json"), "utf8");
    const speechBefore = JSON.stringify(approvalBefore.speech_captions);
    initializeCaptionVisualTreatmentPatch(projectDir, "human-reviewer", {
      typographyPolicyPath: policyPath,
      now: "2026-08-21T00:01:00.000Z",
    });

    const applied = appendCaptionVisualTreatmentOperations(projectDir, "human-reviewer", [operation({
      hierarchy_role: "cta",
      emphasis_ref: "emphasis-word",
      effect_ref: "baseline-panel",
    })], { typographyPolicyPath: policyPath, updatedAt: "2026-08-21T00:02:00.000Z" });
    expect(applied.input.caption_identity[0]).toMatchObject({
      caption_id: "SC_001",
      stable_root_id: "SC_001",
      text: approvalBefore.speech_captions[0].text,
      timeline_in_frame: 12,
      timeline_duration_frames: 48,
      treatment: { effect_ref: "baseline-panel" },
      requested_treatment: { hierarchy_role: "cta", effect_ref: "baseline-panel" },
    });
    expect(applied.patch.session.action_operation_counts).toEqual([1]);
    expect(canUndoCaptionVisualTreatment(projectDir)).toBe(true);

    const undone = undoCaptionVisualTreatment(projectDir, { typographyPolicyPath: policyPath, updatedAt: "2026-08-21T00:03:00.000Z" });
    expect(undone.removedOperationCount).toBe(1);
    expect(undone.patch.session.action_operation_counts).toEqual([]);
    expect(undone.input.applied_caption_ids).toEqual([]);
    expect(JSON.stringify(undone.patch.operations)).toBe("[]");
    expect(fs.readFileSync(path.join(projectDir, "07_package/caption_draft.json"), "utf8")).toBe(draftBefore);
    expect(fs.readFileSync(path.join(projectDir, "05_timeline/timeline.json"), "utf8")).toBe(timelineBefore);
    expect(JSON.stringify(JSON.parse(fs.readFileSync(path.join(projectDir, "07_package/caption_approval.json"), "utf8")).speech_captions)).toBe(speechBefore);

    appendCaptionVisualTreatmentOperations(projectDir, "human-reviewer", [operation({ hierarchy_role: "keyword" })], { typographyPolicyPath: policyPath });
    const current = inspectCaptionVisualTreatment(projectDir, { typographyPolicyPath: policyPath });
    const candidate = previewCaptionVisualTreatment(projectDir, "human-reviewer", { typographyPolicyPath: policyPath, expectedPatchHash: current.patchHash });
    const bound = approveCaptionVisualTreatment(projectDir, "human-reviewer", { typographyPolicyPath: policyPath, expectedPatchHash: candidate.patchHash, preapprovalReceiptPath: candidate.receiptPath });
    expect(bound.approval.approval.caption_visual_treatment_patch_hash).toMatch(/^sha256:/);
    expect(bound.approval.approval.visual_treatment_input_hash).toBe(bound.inputHash);
    expect(JSON.stringify(bound.approval.speech_captions)).toBe(speechBefore);
    expect(fs.existsSync(path.join(projectDir, "07_package/caption_visual_treatment_input.json"))).toBe(true);
  });

  it("creates preapproval evidence without weakening production binding and accepts only the exact receipt", () => {
    const { projectDir, policyPath } = createVisualReviewProject();
    initializeCaptionVisualTreatmentPatch(projectDir, "human-reviewer", { typographyPolicyPath: policyPath });
    const applied = appendCaptionVisualTreatmentOperations(projectDir, "human-reviewer", [operation({ hierarchy_role: "speech" })], { typographyPolicyPath: policyPath });
    const approvalPath = path.join(projectDir, "07_package/caption_approval.json");
    const approvalBeforePreview = fs.readFileSync(approvalPath, "utf8");
    const preview = previewCaptionVisualTreatment(projectDir, "human-reviewer", {
      typographyPolicyPath: policyPath,
      expectedPatchHash: applied.patchHash,
    });
    expect(fs.readFileSync(approvalPath, "utf8")).toBe(approvalBeforePreview);
    expect(preview.receipt.expected_patch_hash).toBe(applied.patchHash);
    expect(preview.receipt.input_hash).toBe(preview.inputHash);
    expect(resolveCanonicalCaptionVisualTreatmentInput(projectDir, { typographyPolicyPath: policyPath }).status).toBe("blocked");

    const bound = approveCaptionVisualTreatment(projectDir, "human-reviewer", {
      typographyPolicyPath: policyPath,
      expectedPatchHash: applied.patchHash,
      preapprovalReceiptPath: preview.receiptPath,
    });
    expect(bound.approval.approval.visual_treatment_input_hash).toBe(bound.inputHash);

    const staleProject = createVisualReviewProject();
    initializeCaptionVisualTreatmentPatch(staleProject.projectDir, "human-reviewer", { typographyPolicyPath: staleProject.policyPath });
    const staleApplied = appendCaptionVisualTreatmentOperations(staleProject.projectDir, "human-reviewer", [operation()], { typographyPolicyPath: staleProject.policyPath });
    const stalePreview = previewCaptionVisualTreatment(staleProject.projectDir, "human-reviewer", { typographyPolicyPath: staleProject.policyPath, expectedPatchHash: staleApplied.patchHash });
    const staleApprovalPath = path.join(staleProject.projectDir, "07_package/caption_approval.json");
    const staleApprovalBefore = fs.readFileSync(staleApprovalPath, "utf8");
    const receipt = JSON.parse(fs.readFileSync(stalePreview.receiptPath, "utf8")) as Record<string, unknown>;
    receipt.expected_patch_hash = `sha256:${"f".repeat(64)}`;
    fs.writeFileSync(stalePreview.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    expect(() => approveCaptionVisualTreatment(staleProject.projectDir, "human-reviewer", {
      typographyPolicyPath: staleProject.policyPath,
      expectedPatchHash: staleApplied.patchHash,
      preapprovalReceiptPath: stalePreview.receiptPath,
    })).toThrow(/receipt/);
    expect(fs.readFileSync(staleApprovalPath, "utf8")).toBe(staleApprovalBefore);
  });

  it("fails closed for every incomplete public visual approval request without writing approval", () => {
    const prepare = () => {
      const fixture = createVisualReviewProject();
      initializeCaptionVisualTreatmentPatch(fixture.projectDir, "human-reviewer", { typographyPolicyPath: fixture.policyPath });
      appendCaptionVisualTreatmentOperations(fixture.projectDir, "human-reviewer", [operation()], { typographyPolicyPath: fixture.policyPath });
      const current = inspectCaptionVisualTreatment(fixture.projectDir, { typographyPolicyPath: fixture.policyPath });
      const preview = previewCaptionVisualTreatment(fixture.projectDir, "human-reviewer", { typographyPolicyPath: fixture.policyPath, expectedPatchHash: current.patchHash });
      return { ...fixture, current, preview, approvalPath: path.join(fixture.projectDir, "07_package/caption_approval.json") };
    };
    const unchanged = (fixture: ReturnType<typeof prepare>, action: () => unknown, message: RegExp) => {
      const before = fs.readFileSync(fixture.approvalPath, "utf8");
      expect(action).toThrow(message);
      expect(fs.readFileSync(fixture.approvalPath, "utf8")).toBe(before);
    };

    const missingExpected = prepare();
    unchanged(missingExpected, () => approveCaptionVisualTreatment(missingExpected.projectDir, "human-reviewer", {
      typographyPolicyPath: missingExpected.policyPath,
      preapprovalReceiptPath: missingExpected.preview.receiptPath,
    } as never), /expectedPatchHash/);

    const missingReceipt = prepare();
    unchanged(missingReceipt, () => approveCaptionVisualTreatment(missingReceipt.projectDir, "human-reviewer", {
      typographyPolicyPath: missingReceipt.policyPath,
      expectedPatchHash: missingReceipt.current.patchHash,
      preapprovalReceiptPath: path.join(missingReceipt.projectDir, "07_package/missing-receipt.json"),
    }), /receipt/);

    const staleHash = prepare();
    unchanged(staleHash, () => approveCaptionVisualTreatment(staleHash.projectDir, "human-reviewer", {
      typographyPolicyPath: staleHash.policyPath,
      expectedPatchHash: `sha256:${"0".repeat(64)}`,
      preapprovalReceiptPath: staleHash.preview.receiptPath,
    }), /changed since it was loaded/);

    const mismatchedReceipt = prepare();
    const receipt = JSON.parse(fs.readFileSync(mismatchedReceipt.preview.receiptPath, "utf8")) as Record<string, unknown>;
    receipt.input_hash = `sha256:${"0".repeat(64)}`;
    fs.writeFileSync(mismatchedReceipt.preview.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    unchanged(mismatchedReceipt, () => approveCaptionVisualTreatment(mismatchedReceipt.projectDir, "human-reviewer", {
      typographyPolicyPath: mismatchedReceipt.policyPath,
      expectedPatchHash: mismatchedReceipt.current.patchHash,
      preapprovalReceiptPath: mismatchedReceipt.preview.receiptPath,
    }), /receipt/);

    const valid = prepare();
    const beforeValid = fs.readFileSync(valid.approvalPath, "utf8");
    const approved = approveCaptionVisualTreatment(valid.projectDir, "human-reviewer", {
      typographyPolicyPath: valid.policyPath,
      expectedPatchHash: valid.current.patchHash,
      preapprovalReceiptPath: valid.preview.receiptPath,
    });
    expect(fs.readFileSync(valid.approvalPath, "utf8")).not.toBe(beforeValid);
    expect(approved.approval.approval.visual_treatment_input_hash).toBe(approved.inputHash);
  });

  it("records accessibility and safe-zone fallbacks, rejects stale identity, and preserves hierarchy lineage", () => {
    const { approval, policyPath } = createVisualReviewProject();
    const policy = loadTypographyPolicy(policyPath);
    const capabilities = captionRendererCapabilitiesForPolicy(policy);
    const profile = loadPlatformSafeZoneProfile(path.join(repoRoot, "delivery_profiles/platform-safe-zone/fixture/anonymous-verified-v1.yaml"));
    const patch: CaptionVisualTreatmentPatch = {
      version: "caption-visual-treatment-patch/v1",
      project_id: approval.project_id,
      base_caption_draft_hash: approval.approval.base_caption_draft_hash!,
      base_timeline_hash: approval.approval.base_timeline_hash!,
      typography_policy_hash: computeNormalizedJsonHash(policy),
      caption_approval_hash: captionApprovalBindingHash(approval),
      operations: [operation({ animation_ref: "semantic-reveal", effect_ref: "unsupported-effect", fallback: "nle_handoff" })],
      session: { reviewer: "human-reviewer", updated_at: "2026-08-21T00:04:00.000Z" },
    };
    const parsed = parseCaptionVisualTreatmentPatch(patch);
    const missingHash = resolveCaptionVisualTreatmentInput({ approval, patch: parsed, typography_policy: policy, capabilities });
    expect(missingHash.status).toBe("blocked");
    expect(missingHash.blocked_reasons).toEqual(expect.arrayContaining([expect.objectContaining({ reason: expect.stringContaining("input hash") })]));

    const safeZonePatch = structuredClone(parsed);
    safeZonePatch.operations = [operation({ rect: { x: 0.2, y: 0.86, width: 0.5, height: 0.1 }, effect_ref: undefined, fallback: "registered_fallback" })];
    const safeZone = resolveCaptionVisualTreatmentInput({
      approval,
      patch: safeZonePatch,
      typography_policy: policy,
      platform_safe_zone_profile_hash: profile.hash,
      platform_safe_zone_profile: profile.profile,
      capabilities,
      accessibility: { reduced_motion: true, high_contrast: true, audio_off: true, small_screen: true },
      require_approval_binding: false,
    });
    expect(safeZone.status).toBe("fallback");
    expect(safeZone.degraded_reasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: expect.stringContaining("safe") }),
      expect.objectContaining({ reason: expect.stringContaining("small_screen") }),
    ]));
    expect(safeZone.caption_identity[0].treatment?.rect).toBeUndefined();

    const staleIdentity = resolveCaptionVisualTreatmentInput({
      approval,
      patch: { ...parsed, operations: [operation({ caption_id: "SC_002", stable_root_id: "SC_001" })] },
      typography_policy: policy,
      capabilities,
      require_approval_binding: false,
    });
    expect(staleIdentity.status).toBe("blocked");
    expect(staleIdentity.blocked_reasons).toEqual(expect.arrayContaining([expect.objectContaining({ reason: expect.stringContaining("stable caption identity") })]));
  });

  it("persists the selected accessibility and safe-zone context for the canonical production resolver", () => {
    const { projectDir, policyPath } = createVisualReviewProject();
    const profilePath = path.join(projectDir, "delivery_profiles/platform-safe-zone/fixture/anonymous-verified-v1.yaml");
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, "delivery_profiles/platform-safe-zone/fixture/anonymous-verified-v1.yaml"), profilePath);
    initializeCaptionVisualTreatmentPatch(projectDir, "human-reviewer", { typographyPolicyPath: policyPath });
    appendCaptionVisualTreatmentOperations(projectDir, "human-reviewer", [operation({ hierarchy_role: "keyword", emphasis_ref: "emphasis-word" })], { typographyPolicyPath: policyPath });
    const current = inspectCaptionVisualTreatment(projectDir, { typographyPolicyPath: policyPath, platformSafeZoneProfilePath: profilePath, accessibility: { reduced_motion: true, high_contrast: false, audio_off: true, small_screen: false } });
    const candidate = previewCaptionVisualTreatment(projectDir, "human-reviewer", {
      typographyPolicyPath: policyPath,
      platformSafeZoneProfilePath: profilePath,
      accessibility: { reduced_motion: true, high_contrast: false, audio_off: true, small_screen: false },
      expectedPatchHash: current.patchHash,
    });
    const bound = approveCaptionVisualTreatment(projectDir, "human-reviewer", {
      typographyPolicyPath: policyPath,
      platformSafeZoneProfilePath: profilePath,
      accessibility: { reduced_motion: true, high_contrast: false, audio_off: true, small_screen: false },
      expectedPatchHash: candidate.patchHash,
      preapprovalReceiptPath: candidate.receiptPath,
    });
    expect(bound.approval.approval.visual_treatment_context).toMatchObject({
      accessibility: { reduced_motion: true, high_contrast: false, audio_off: true, small_screen: false },
      safe_zone_profile: { profile_id: "fixture-anonymous-verified-v1", path: "delivery_profiles/platform-safe-zone/fixture/anonymous-verified-v1.yaml" },
    });
    const resolved = resolveCanonicalCaptionVisualTreatmentInput(projectDir, { typographyPolicyPath: "04_plan/typography_policy.json" });
    expect(resolved.input_hash).toBe(bound.inputHash);
    expect(resolved.accessibility).toEqual({ reduced_motion: true, high_contrast: false, audio_off: true, small_screen: false });
    expect(resolved.platform_safe_zone_profile_path).toBe("delivery_profiles/platform-safe-zone/fixture/anonymous-verified-v1.yaml");
  });

  it("uses registered ASS panel styles while retaining position, emphasis, and animation tokens", () => {
    const treatment: AssCaptionVisualTreatment = operation({
      style_ref: "sns-vertical-outline",
      anchor: "center",
      emphasis_ref: "emphasis-word",
      animation_ref: "semantic-reveal",
      effect_ref: "baseline-panel",
    });
    const ass = buildAssDocument([
      { startSec: 0.5, endSec: 1.5, text: "匿名CTA", captionId: "SC_001", visualTreatment: treatment },
    ], resolveCaptionStylePreset("sns-vertical-outline"), { width: 720, height: 1280, fps: 24 });
    expect(ass).toContain("Panel_sns-vertical-outline");
    expect(ass).toMatch(/Panel_sns-vertical-outline,.*?,3,0,/);
    expect(ass).toContain("\\fad(40,80)");
    expect(ass).toContain("\\fscx110");
    expect(ass).toContain("匿名CTA");
  });

  it("emits a deterministic canonical projection whose style change changes the bound input hash", () => {
    const { approval, policyPath } = createVisualReviewProject();
    const policy = loadTypographyPolicy(policyPath);
    const capabilities = captionRendererCapabilitiesForPolicy(policy);
    const patchFor = (styleRef: string) => parseCaptionVisualTreatmentPatch({
      version: "caption-visual-treatment-patch/v1",
      project_id: approval.project_id,
      base_caption_draft_hash: approval.approval.base_caption_draft_hash!,
      base_timeline_hash: approval.approval.base_timeline_hash!,
      typography_policy_hash: computeNormalizedJsonHash(policy),
      caption_approval_hash: captionApprovalBindingHash(approval),
      operations: [operation({ style_ref: styleRef })],
      session: { reviewer: "human-reviewer", updated_at: "2026-08-21T00:06:00.000Z" },
    });
    const snsPatch = patchFor("sns-vertical-outline");
    const cleanPatch = patchFor("clean-lower-third");
    const resolve = (patch: CaptionVisualTreatmentPatch) => resolveCaptionVisualTreatmentInput({
      approval, patch, typography_policy: policy, capabilities, require_approval_binding: false,
    });
    const sns = resolve(snsPatch);
    const clean = resolve(cleanPatch);
    expect(sns.resolved_projection?.[0]).toMatchObject({ style_ref: "sns-vertical-outline", font_size_px_1080: 58 });
    expect(clean.resolved_projection?.[0]).toMatchObject({ style_ref: "clean-lower-third", font_size_px_1080: 60 });
    expect(sns.resolved_projection).not.toEqual(clean.resolved_projection);
    expect(sns.input_hash).not.toBe(clean.input_hash);
    expect(sns.visual_treatment_patch_hash).toBe(captionVisualTreatmentPatchHash(snsPatch));
    expect(clean.visual_treatment_patch_hash).toBe(captionVisualTreatmentPatchHash(cleanPatch));
    expect(captionVisualTreatmentCanonicalInputHash({
      approval, patch: snsPatch, typography_policy: policy, capabilities, require_approval_binding: false,
    })).toBe(sns.input_hash);
  });

  it.each([
    ["speech", false],
    ["keyword", true],
  ] as const)("declares hierarchy capability and emits the corresponding ASS token for %s", (hierarchyRole, hasKeywordToken) => {
    const ass = buildAssDocument([
      { startSec: 0.5, endSec: 1.5, text: "hierarchy", captionId: "SC_001", visualTreatment: operation({ hierarchy_role: hierarchyRole }) as AssCaptionVisualTreatment },
    ], resolveCaptionStylePreset("sns-vertical-outline"), { width: 720, height: 1280, fps: 24 });
    expect(ass.includes("\\fscx110")).toBe(hasKeywordToken);
  });

  it.each([
    ["reduced motion removes animation and keeps receipt context hash-bound", "reduced-motion"],
    ["approved unsupported style/effect remains an explicit capability fallback", "unsupported-style"],
  ] as const)("coverage row: %s", (_label, scenario) => {
    const { approval } = createVisualReviewProject();
    const policy = loadTypographyPolicy(policySourcePath);
    const capabilities = captionRendererCapabilitiesForPolicy(policy);
    const patch = parseCaptionVisualTreatmentPatch({
      version: "caption-visual-treatment-patch/v1",
      project_id: approval.project_id,
      base_caption_draft_hash: approval.approval.base_caption_draft_hash!,
      base_timeline_hash: approval.approval.base_timeline_hash!,
      typography_policy_hash: computeNormalizedJsonHash(policy),
      caption_approval_hash: captionApprovalBindingHash(approval),
      operations: [operation(scenario === "reduced-motion"
        ? { animation_ref: "semantic-reveal" }
        : { style_ref: "caption.keyword", effect_ref: "unregistered-effect", fallback: "nle_handoff" })],
      session: { reviewer: "human-reviewer", updated_at: "2026-08-21T00:05:00.000Z" },
    });
    const accessibility = scenario === "reduced-motion"
      ? { reduced_motion: true, high_contrast: false, audio_off: false, small_screen: false }
      : undefined;
    const unbound = resolveCaptionVisualTreatmentInput({ approval, patch, typography_policy: policy, capabilities, accessibility, require_approval_binding: false });
    approval.approval.typography_policy_hash = computeNormalizedJsonHash(policy);
    approval.approval.caption_visual_treatment_patch_hash = captionVisualTreatmentPatchHash(patch);
    approval.approval.visual_treatment_input_hash = unbound.input_hash;
    const bound = resolveCaptionVisualTreatmentInput({ approval, patch, typography_policy: policy, capabilities, accessibility, require_approval_binding: true });
    const receipt = captionVisualTreatmentReceiptSummary(bound);
    expect(receipt.input_hash).toBe(bound.input_hash);
    expect(bound.approval_hash).toBe(captionApprovalBindingHash(approval));
    if (scenario === "reduced-motion") {
      expect(bound.caption_identity[0].treatment).not.toHaveProperty("animation_ref");
      expect(bound.fallbacks).toEqual(expect.arrayContaining([expect.objectContaining({ reason: expect.stringContaining("reduced motion removes") })]));
      expect(receipt.accessibility).toEqual(accessibility);
    } else {
      expect(capabilities.style_refs).not.toContain("caption.keyword");
      expect(bound.status).toBe("human_hold");
      expect(bound.fallbacks).toEqual(expect.arrayContaining([expect.objectContaining({ reason: expect.stringContaining("style_ref=caption.keyword") })]));
      expect(bound.fallbacks).toEqual(expect.arrayContaining([expect.objectContaining({ reason: expect.stringContaining("effect_ref=unregistered-effect") })]));
    }
  });

  it("advertises only real ASS style presets and does not promote policy hierarchy labels", () => {
    const policy = loadTypographyPolicy(policySourcePath);
    const capabilities = captionRendererCapabilitiesForPolicy(policy);
    expect(capabilities.style_refs).toEqual(expect.arrayContaining(["default", "sns-vertical-outline"]));
    expect(capabilities.style_refs).not.toEqual(expect.arrayContaining(Object.values(policy.hierarchy)));
    expect(capabilities.style_refs).not.toContain("caption.keyword");
  });

  it("binds a stable split lineage and keeps distinct occurrences from concatenating", () => {
    const { approval } = createVisualReviewProject();
    const policy = loadTypographyPolicy(policySourcePath);
    const splitApproval = structuredClone(approval);
    splitApproval.speech_captions = [
      { ...approval.speech_captions[0], caption_id: "SC_001", root_id: "SC_001", text: "前半" },
      { ...approval.speech_captions[0], caption_id: "SC_002", root_id: "SC_001", parent_ids: ["SC_001"], text: "後半", timeline_in_frame: 60 },
    ];
    const splitPatch: CaptionVisualTreatmentPatch = {
      version: "caption-visual-treatment-patch/v1",
      project_id: approval.project_id,
      base_caption_draft_hash: approval.approval.base_caption_draft_hash!,
      base_timeline_hash: approval.approval.base_timeline_hash!,
      typography_policy_hash: computeNormalizedJsonHash(policy),
      caption_approval_hash: captionApprovalBindingHash(splitApproval),
      operations: [
        operation({ caption_id: "SC_001", stable_root_id: "SC_001", hierarchy_role: "speaker" }),
        operation({ caption_id: "SC_002", stable_root_id: "SC_001", hierarchy_role: "annotation" }),
      ],
      session: { reviewer: "human-reviewer", updated_at: "2026-08-21T00:05:00.000Z" },
    };
    const resolved = resolveCaptionVisualTreatmentInput({
      approval: splitApproval,
      patch: splitPatch,
      typography_policy: policy,
      capabilities: captionRendererCapabilitiesForPolicy(policy),
      require_approval_binding: false,
    });
    expect(resolved.status).toBe("fallback");
    expect(resolved.degraded_reasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ caption_id: "SC_001", reason: expect.stringContaining("hierarchy_role=speaker") }),
      expect.objectContaining({ caption_id: "SC_002", reason: expect.stringContaining("hierarchy_role=annotation") }),
    ]));
    expect(resolved.caption_identity.map((entry) => [entry.caption_id, entry.stable_root_id, entry.text])).toEqual([
      ["SC_001", "SC_001", "前半"],
      ["SC_002", "SC_001", "後半"],
    ]);
    expect(resolved.caption_identity.map((entry) => entry.requested_treatment?.hierarchy_role)).toEqual(["speaker", "annotation"]);
    expect(resolved.text_timing_hash).toBe(computeNormalizedJsonHash(resolved.caption_identity.map(({ treatment: _treatment, requested_treatment: _requested, ...identity }) => identity)));
    expect(resolved.caption_identity[0].text).not.toContain(resolved.caption_identity[1].text);
  });
});
