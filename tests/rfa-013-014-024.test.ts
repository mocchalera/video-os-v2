import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildExternalRenderRouteReceipt,
  type RenderRouteReceipt,
  type ExternalRouteMetadata,
} from "../runtime/render/route-resolver.js";
import {
  createAlphaOverlayExportReceipt,
  validateAlphaOverlayExportReceipt,
} from "../runtime/render/alpha-layer-contract.js";
import {
  buildPremiereExportIdentity,
  resolvePremiereExportIdentity,
  validatePremiereExportIdentity,
} from "../runtime/handoff/premiere-export-identity.js";
import { createDraftApproval } from "../runtime/caption/approval.js";
import type { CaptionDraft } from "../runtime/caption/editorial.js";
import {
  initializeCaptionReviewPatch,
  validateCaptionReview,
} from "../runtime/caption/review-service.js";
import { computeCaptionDraftHash } from "../runtime/caption/review-core.js";
import { computeNormalizedJsonHash } from "../runtime/artifacts/p1-manifest-coverage.js";
import { computeSha256 } from "../runtime/packaging/manifest.js";
import type { RenderRouteDecision } from "../runtime/render/route-resolver.js";
import { validateAgainstSchema } from "../runtime/commands/shared.js";
import { runRenderRouteCli } from "../scripts/render-route.js";

const fixturePath = path.resolve("tests/fixtures/external-route-metadata/day1-external-nle.json");
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as ExternalRouteMetadata;

function captionEnabledRouteDecision(): RenderRouteDecision {
  return {
    version: "render-route/v2",
    requested_assembly_engine: "ffmpeg",
    assembly_engine: "ffmpeg",
    base_engine: "ffmpeg",
    visual_layers: [],
    caption_layer: { engine: "ffmpeg-libass", composite_stage: "caption" },
    delivery: {
      compositor: "ffmpeg",
      video_encoder: "ffmpeg",
      definition: "sequential_h264_generations/v1",
      lossy_video_encode_passes: 1,
    },
    hyperframes_overlay: false,
    remotion_overlay_count: 0,
    hyperframes_element_count: 0,
    speech_caption_engine: "ffmpeg-libass",
    style_family: "clean_editorial",
    genre: "general",
    reasons: ["fixture"],
  };
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeCaptionReviewExportFixture(): { projectDir: string; timelinePath: string; approvalPath: string } {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-rfa013-caption-"));
  const projectId = "caption-export-gate";
  const timelinePath = path.join(projectDir, "05_timeline/timeline.json");
  const timeline = JSON.parse(fs.readFileSync("projects/sample/05_timeline/timeline.json", "utf8")) as Record<string, any>;
  timeline.project_id = projectId;
  timeline.provenance = {
    ...(timeline.provenance ?? {}),
    audio_policy: { mode: "original_only", source: "fixture" },
  };
  writeJson(timelinePath, timeline);
  const draft: CaptionDraft = {
    version: "caption-draft/v1",
    project_id: projectId,
    base_timeline_version: timeline.version,
    caption_policy: {
      language: "ja",
      delivery_mode: "both",
      source: "none",
      styling_class: "clean-lower-third",
    },
    speech_captions: [],
    text_overlays: [],
    draft_status: "ready_for_human_approval",
    degraded_count: 0,
  };
  const draftPath = path.join(projectDir, "07_package/caption_draft.json");
  writeJson(draftPath, draft);
  const patchResult = initializeCaptionReviewPatch(projectDir, "reviewer", {
    now: "2026-08-21T00:00:00Z",
  });
  const validation = validateCaptionReview(projectDir);
  if (!validation.valid || !validation.preview || !validation.patch) {
    throw new Error(`fixture caption review invalid: ${validation.errors.join("; ")}`);
  }
  const approval = createDraftApproval({
    version: draft.version,
    project_id: projectId,
    base_timeline_version: timeline.version,
    caption_policy: draft.caption_policy,
    speech_captions: [],
    text_overlays: [],
  }, "reviewer", "2026-08-21T00:01:00Z", {
    base_caption_draft_hash: computeCaptionDraftHash(draft),
    caption_review_patch_hash: computeNormalizedJsonHash(validation.patch),
    validation_hash: computeNormalizedJsonHash(validation.preview.validation),
    base_timeline_hash: computeNormalizedJsonHash(timeline),
  });
  const approvalPath = path.join(projectDir, "07_package/caption_approval.json");
  writeJson(approvalPath, approval);
  if (!fs.existsSync(patchResult.patchPath)) throw new Error("fixture caption review patch missing");
  return { projectDir, timelinePath, approvalPath };
}

function writeFormalA2Timeline(projectDir: string): string {
  const timelinePath = path.join(projectDir, "05_timeline/timeline.json");
  const timeline = JSON.parse(fs.readFileSync("projects/sample/05_timeline/timeline.json", "utf8")) as Record<string, any>;
  const audioTracks = timeline.tracks.audio as Array<Record<string, any>>;
  const a2 = audioTracks.find((track) => track.track_id === "A2");
  if (!a2) throw new Error("fixture A2 track missing");
  const hash = `sha256:${"a".repeat(64)}`;
  a2.clips = [{
    clip_id: "A2_MC_0001",
    asset_id: "MUSIC_001",
    role: "music",
    timeline_in_frame: 0,
    timeline_duration_frames: 24,
    metadata: {
      music_cue: { cue_id: "MC_0001" },
      music_asset: { pack_manifest_hash: hash, full_mix_content_hash: hash },
    },
  }];
  writeJson(timelinePath, timeline);
  return timelinePath;
}

function writeA2RoleOnlyTimeline(projectDir: string, originalOnly = false): string {
  const timelinePath = path.join(projectDir, "05_timeline/timeline.json");
  const timeline = JSON.parse(fs.readFileSync("projects/sample/05_timeline/timeline.json", "utf8")) as Record<string, any>;
  const audioTracks = timeline.tracks.audio as Array<Record<string, any>>;
  const a2 = audioTracks.find((track) => track.track_id === "A2");
  if (!a2) throw new Error("fixture A2 track missing");
  a2.clips = [{
    clip_id: "A2_ROLE_ONLY",
    asset_id: "MUSIC_001",
    role: "music",
    timeline_in_frame: 0,
    timeline_duration_frames: 24,
  }];
  if (originalOnly) {
    timeline.provenance = {
      ...(timeline.provenance ?? {}),
      audio_policy: { mode: "original_only", source: "fixture" },
    };
  }
  writeJson(timelinePath, timeline);
  return timelinePath;
}

function writeLegacyAudioPlan(projectDir: string, timelinePath: string): string {
  const planPath = path.join(projectDir, "07_package/audio-render-plan.json");
  writeJson(planPath, {
    version: "audio-render-plan/v1",
    project_id: "sample-mountain-reset",
    strategy: "original_passthrough",
    timeline: {
      path: timelinePath,
      version: "1",
      content_hash: computeSha256(timelinePath),
      duration_frames: 672,
      fps: { num: 24, den: 1 },
    },
    inputs: {},
    dialogue: { source_track_id: "A1", clips: [], finish_scope: "none_original_passthrough" },
    music: { enabled: false, source_track_id: "A2", cues: [] },
    final_mastering: { loudness_target_lufs: -16, lra_target: 7, true_peak_target_dbtp: -1, count: 0, stage: "not_applied", owner: "shared_audio_render_plan" },
    expected_artifacts: { dialogue_stem: "raw_dialogue.wav", final_mix: "final_mix.wav", report: "audio-mix-report.json" },
    warnings: [],
  });
  return planPath;
}

describe("Milestone 5A RFA-013/RFA-014/RFA-024 receipts", () => {
  it("blocks a minimal status-only caption approval at the export boundary", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-rfa013-caption-minimal-"));
    const timelinePath = path.join(projectDir, "05_timeline/timeline.json");
    writeJson(timelinePath, { version: "1", project_id: "caption-export-gate" });
    writeJson(path.join(projectDir, "07_package/caption_approval.json"), {
      approval: { status: "approved" },
    });
    try {
      expect(() => resolvePremiereExportIdentity({
        projectDir,
        projectId: "caption-export-gate",
        timelinePath,
        sourceMap: new Map(),
        routeDecision: captionEnabledRouteDecision(),
      })).toThrow(/caption_approval_blocked/);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("blocks a schema-valid approval whose current timeline hash is stale", () => {
    const fixture = writeCaptionReviewExportFixture();
    const timeline = JSON.parse(fs.readFileSync(fixture.timelinePath, "utf8")) as Record<string, any>;
    timeline.markers[0].label = `${timeline.markers[0].label} (stale)`;
    writeJson(fixture.timelinePath, timeline);
    try {
      expect(() => resolvePremiereExportIdentity({
        projectDir: fixture.projectDir,
        projectId: "caption-export-gate",
        timelinePath: fixture.timelinePath,
        sourceMap: new Map(),
        routeDecision: captionEnabledRouteDecision(),
      })).toThrow(/caption_approval_blocked/);
    } finally {
      fs.rmSync(fixture.projectDir, { recursive: true, force: true });
    }
  });

  it("blocks a hash-pinned A2 export when the persisted audio plan is empty", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-rfa013-a2-empty-"));
    const timelinePath = writeFormalA2Timeline(projectDir);
    writeJson(path.join(projectDir, "07_package/audio-render-plan.json"), {});
    try {
      expect(() => resolvePremiereExportIdentity({
        projectDir,
        projectId: "sample-mountain-reset",
        timelinePath,
        sourceMap: new Map(),
        routeDecision: { ...captionEnabledRouteDecision(), caption_layer: { engine: "none", composite_stage: "caption" }, speech_caption_engine: "none" },
      })).toThrow(/audio_plan_blocked/);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("treats any A2 music clip as formal audio even without cue metadata or a plan", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-rfa013-a2-role-only-"));
    const timelinePath = writeA2RoleOnlyTimeline(projectDir);
    try {
      expect(() => resolvePremiereExportIdentity({
        projectDir,
        projectId: "sample-mountain-reset",
        timelinePath,
        sourceMap: new Map(),
        routeDecision: { ...captionEnabledRouteDecision(), caption_layer: { engine: "none", composite_stage: "caption" }, speech_caption_engine: "none" },
      })).toThrow(/audio_plan_missing/);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("blocks contradictory original_only when A2 evidence is present", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-rfa013-a2-policy-conflict-"));
    const timelinePath = writeA2RoleOnlyTimeline(projectDir, true);
    try {
      expect(() => resolvePremiereExportIdentity({
        projectDir,
        projectId: "sample-mountain-reset",
        timelinePath,
        sourceMap: new Map(),
        routeDecision: { ...captionEnabledRouteDecision(), caption_layer: { engine: "none", composite_stage: "caption" }, speech_caption_engine: "none" },
      })).toThrow(/audio_plan_blocked/);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("keeps empty A2/A3 tracks without an audio profile on the legacy no-audio route", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-rfa013-audio-empty-"));
    const timelinePath = path.join(projectDir, "05_timeline/timeline.json");
    const timeline = JSON.parse(fs.readFileSync("projects/sample/05_timeline/timeline.json", "utf8")) as Record<string, any>;
    timeline.project_id = "sample-mountain-reset";
    writeJson(timelinePath, timeline);
    try {
      const identity = resolvePremiereExportIdentity({
        projectDir,
        projectId: "sample-mountain-reset",
        timelinePath,
        sourceMap: new Map(),
        routeDecision: { ...captionEnabledRouteDecision(), caption_layer: { engine: "none", composite_stage: "caption" }, speech_caption_engine: "none" },
      });
      expect(identity.audio).toEqual({
        owner: "legacy_dialogue_route",
        status: "not_applicable",
        plan: null,
        plan_hash: null,
        profile_id: null,
        profile_hash: null,
      });
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("blocks a schema-valid A2 export when the persisted audio plan timeline hash is stale", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-rfa013-a2-stale-"));
    const timelinePath = writeFormalA2Timeline(projectDir);
    writeLegacyAudioPlan(projectDir, timelinePath);
    const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf8")) as Record<string, any>;
    timeline.markers[0].label = `${timeline.markers[0].label} (stale)`;
    writeJson(timelinePath, timeline);
    try {
      expect(() => resolvePremiereExportIdentity({
        projectDir,
        projectId: "sample-mountain-reset",
        timelinePath,
        sourceMap: new Map(),
        routeDecision: { ...captionEnabledRouteDecision(), caption_layer: { engine: "none", composite_stage: "caption" }, speech_caption_engine: "none" },
      })).toThrow(/audio_plan_stale/);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("keeps alpha geometry, reduced rational fps, codec, hashes, and ownership explicit", () => {
    const canonical = createAlphaOverlayExportReceipt({
      status: "canonical",
      ownership: "canonical",
      geometry: { width: 1080, height: 1920 },
      fpsNum: 30000,
      fpsDen: 1001,
      codec: { name: "vp9", pixel_format: "yuva420p", alpha_mode: "1" },
      source: { path: "layer-receipt.json", sha256: `sha256:${"1".repeat(64)}` },
      output: { path: "layer.webm", sha256: `sha256:${"2".repeat(64)}` },
      visualTreatment: {
        inputHash: `sha256:${"3".repeat(64)}`,
        profileHash: `sha256:${"4".repeat(64)}`,
        capabilityHash: `sha256:${"5".repeat(64)}`,
      },
    });
    expect(canonical.fps).toEqual({ num: 30000, den: 1001 });
    expect(validateAlphaOverlayExportReceipt(canonical).valid).toBe(true);
    expect(validateAgainstSchema(canonical, "alpha-overlay-export-receipt.schema.json").valid).toBe(true);

    const supplied = { ...canonical, status: "supplied_external" as const, ownership: "external" as const, canonical_claim: true };
    expect(validateAlphaOverlayExportReceipt(supplied).valid).toBe(false);
    expect(validateAgainstSchema(supplied, "alpha-overlay-export-receipt.schema.json").valid).toBe(false);

    expect(() => createAlphaOverlayExportReceipt({
      status: "canonical",
      ownership: "canonical",
      geometry: { width: 0, height: 1920 },
      fpsNum: 30,
      fpsDen: 1,
      codec: { name: "h264", pixel_format: "yuv420p", alpha_mode: null },
      source: canonical.source,
      output: canonical.output,
      visualTreatment: {
        inputHash: canonical.visual_treatment.input_hash,
        profileHash: canonical.visual_treatment.profile_hash,
        capabilityHash: canonical.visual_treatment.capability_hash,
      },
    })).toThrow(/alpha_overlay_receipt_invalid/);
    expect(validateAgainstSchema({
      ...canonical,
      geometry: { width: 0, height: 1920 },
      codec: { name: "h264", pixel_format: "yuv420p", alpha_mode: null },
    }, "alpha-overlay-export-receipt.schema.json").valid).toBe(false);

    expect(() => createAlphaOverlayExportReceipt({
      status: "supplied_external",
      ownership: "external",
      geometry: canonical.geometry,
      fpsNum: 30,
      fpsDen: 1,
      codec: canonical.codec,
      source: canonical.source,
      output: null,
      visualTreatment: {
        inputHash: canonical.visual_treatment.input_hash,
        profileHash: canonical.visual_treatment.profile_hash,
        capabilityHash: canonical.visual_treatment.capability_hash,
      },
    })).toThrow(/alpha_overlay_receipt_invalid/);
  });

  it("builds a metadata-only DAY1 external/NLE route without a canonical claim", () => {
    const receipt = buildExternalRenderRouteReceipt(fixture);
    expect(receipt.route_evidence).toMatchObject({
      route_kind: "external_manual_nle",
      ownership: "external",
      canonical_claim: false,
      status: "handoff_required",
      ass_capability: {
        decision: "nle_handoff",
        unsupported_animations: ["\\t"],
      },
      alpha: {
        status: "metadata_only",
        ownership: "external",
        canonical_claim: false,
        output: null,
        fps: { num: 30000, den: 1001 },
      },
      handoff: { required: true, status: "pending" },
    });
    expect(validateAgainstSchema(receipt, "render-route-receipt.schema.json").valid).toBe(true);
    const invalidEmbeddedAlpha = structuredClone(receipt);
    invalidEmbeddedAlpha.route_evidence!.alpha = {
      ...invalidEmbeddedAlpha.route_evidence!.alpha!,
      status: "canonical",
      ownership: "canonical",
      canonical_claim: true,
      geometry: { width: 0, height: 1920 },
      codec: { name: "h264", pixel_format: "yuv420p", alpha_mode: null },
      output: null,
    };
    expect(validateAgainstSchema(invalidEmbeddedAlpha, "render-route-receipt.schema.json").valid).toBe(false);
    const missingEvidence = structuredClone(receipt) as unknown as Record<string, unknown>;
    delete missingEvidence.route_evidence;
    expect(validateAgainstSchema(missingEvidence, "render-route-receipt.schema.json").valid).toBe(false);
    const missingHandoffArtifacts = structuredClone(fixture);
    missingHandoffArtifacts.required_handoff_artifacts = [];
    expect(validateAgainstSchema(buildExternalRenderRouteReceipt(missingHandoffArtifacts), "render-route-receipt.schema.json").valid).toBe(false);
    const ambiguousOwnership = structuredClone(receipt);
    ambiguousOwnership.route_evidence!.ownership = "canonical";
    expect(validateAgainstSchema(ambiguousOwnership, "render-route-receipt.schema.json").valid).toBe(false);

    const ambiguous = structuredClone(fixture);
    ambiguous.caption = { ...fixture.caption!, unsupported_animations: ["\\t"], decision: "canonical" as never };
    expect(() => buildExternalRenderRouteReceipt(ambiguous)).toThrow("unsupported_ass_animation_decision_missing");

    const suppliedFallback = structuredClone(fixture);
    suppliedFallback.route_kind = "supplied_final";
    suppliedFallback.degradation = undefined;
    suppliedFallback.caption = {
      ...fixture.caption!,
      capability_status: "registered_fallback",
      decision: "registered_fallback",
    };
    suppliedFallback.handoff = {
      ...fixture.handoff!,
      status: "confirmed",
      human_approval_status: "approved",
    };
    const suppliedReceipt = buildExternalRenderRouteReceipt(suppliedFallback);
    expect(suppliedReceipt.route_evidence).toMatchObject({
      route_kind: "supplied_final",
      ownership: "supplied",
      status: "degraded",
      degradation: [{ action: "registered_fallback" }],
    });
    expect(validateAgainstSchema(suppliedReceipt, "render-route-receipt.schema.json").valid).toBe(true);
  });

  it("threads the external metadata fixture through the route CLI receipt writer", () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-rfa024-route-"));
    const receiptPath = path.join(outputDir, "render-route.json");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const result = runRenderRouteCli([
        "node",
        "scripts/render-route.ts",
        outputDir,
        "--route-kind",
        "external_manual_nle",
        "--metadata",
        fixturePath,
        "--write-receipt",
        receiptPath,
        "--json",
      ]);
      expect((result as RenderRouteReceipt).route_evidence?.route_kind).toBe("external_manual_nle");
      expect(JSON.parse(fs.readFileSync(receiptPath, "utf8"))).toMatchObject({
        receipt_version: "render-route-receipt/v3",
        route_evidence: { canonical_claim: false },
      });
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("binds Premiere export identity to the approved caption and route capability", () => {
    const hash = (digit: string) => `sha256:${digit.repeat(64)}`;
    const identity = buildPremiereExportIdentity({
      version: "premiere-export-identity/v1",
      project_id: "rfa013-fixture",
      export_kind: "fcp7_xml",
      timeline: { path: "timeline.json", sha256: hash("1") },
      caption: {
        owner: "caption_runtime_review_core_studio",
        status: "approved",
        approval: { path: "caption_approval.json", sha256: hash("2") },
        approval_hash: hash("2"),
        text_timing_hash: hash("3"),
      },
      visual_treatment: {
        owner: "ffmpeg-libass",
        status: "resolved",
        input_hash: hash("4"),
        input: { path: "caption_visual_treatment_input.json", sha256: hash("5") },
        typography_policy_hash: hash("6"),
        visual_treatment_patch_hash: hash("7"),
        capability_hash: hash("8"),
      },
      audio: {
        owner: "not_applicable",
        status: "not_applicable",
        plan: null,
        plan_hash: null,
        profile_id: null,
        profile_hash: null,
      },
      source_identity: {
        status: "declared_reference",
        source_map: null,
        source_inputs_hash: hash("9"),
        assets: [{ asset_id: "AST_1", locator: "fixture.mov", content_sha256: hash("a") }],
      },
      route_capability: {
        id: "video-os-canonical-export-route/v1",
        hash: hash("b"),
        assembly_engine: "ffmpeg",
        caption_renderer: "ffmpeg-libass",
        content_renderers: [],
      },
      visual_effects: { status: "none", unsupported: [], baked_clip_ids: [] },
      human_approval: { caption_status: "approved", export_status: "not_requested" },
    });
    expect(validatePremiereExportIdentity(identity).valid).toBe(true);
    expect(validateAgainstSchema(identity, "premiere-export-identity.schema.json").valid).toBe(true);
    const stale = structuredClone(identity);
    stale.caption.approval_hash = hash("c");
    expect(validatePremiereExportIdentity(stale).valid).toBe(false);
  });
});
