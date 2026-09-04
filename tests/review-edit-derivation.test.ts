import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyPatch, type ReviewPatch } from "../runtime/compiler/patch.js";
import type { Candidate, TimelineIR } from "../runtime/compiler/types.js";
import {
  buildDerivedMappingReceipt,
  computeArtifactSha256,
  stampReviewDerivation,
  verifyReviewEditIdentity,
  writeReviewEditIdentityReceipt,
} from "../runtime/review/edit-identity.js";
import { validateAgainstSchema } from "../runtime/commands/shared.js";
import {
  preflightSocialReviewEditIdentity,
  renderSocialReview,
  resolveProjectSocialReviewCaptionStyle,
} from "../scripts/render-social-review.js";
import { evaluateCandidateAgainstGolden } from "../runtime/eval/index.js";
import { resolvePremiereExportIdentity } from "../runtime/handoff/premiere-export-identity.js";
import { runPatch } from "../scripts/compile-timeline.js";
import { DEFAULT_MASTERING } from "../runtime/audio/mastering.js";
import { loadContentRenderPlan } from "../runtime/content/render-plan.js";
import { verifyBundledFont } from "../runtime/fonts/bundled-font.js";
import { loadSourceMap } from "../runtime/media/source-map.js";
import { createSourceInputAttestation } from "../runtime/render/source-input-attestation.js";
import { REMOTION_RENDERER_VERSION } from "../runtime/render/remotion/render-remotion.js";
import { remotionCapabilityIdentityHash } from "../runtime/render/remotion/overlay-capability.js";
import {
  captureSocialReviewGeneration,
  hashCanonical,
  sha256File,
} from "../runtime/review/social-review-generation.js";
import { deriveSocialReviewAudioPlanIdentity } from "../runtime/review/social-review-audio.js";
import {
  parseSubjectOccupancyTrack,
  subjectOccupancyPayloadHash,
  type SubjectOccupancyTrack,
} from "../runtime/review/subject-occupancy.js";
import {
  loadVerticalCompositionPolicy,
  verticalCompositionPolicyContentHash,
} from "../runtime/visual/vertical-composition.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function clip(clipId: string, start: number, duration: number, role = "hero") {
  return {
    clip_id: clipId,
    segment_id: `SEG_${clipId}`,
    asset_id: `AST_${clipId}`,
    src_in_us: 0,
    src_out_us: duration * 40_000,
    timeline_in_frame: start,
    timeline_duration_frames: duration,
    role,
    motivation: "fixture",
    beat_id: "b1",
    fallback_segment_ids: [],
    confidence: 1,
    quality_flags: [],
  };
}

function timeline(): TimelineIR {
  return {
    version: "1",
    project_id: "day3-equivalent",
    created_at: "2026-08-23T00:00:00.000Z",
    sequence: { name: "DAY3", fps_num: 25, fps_den: 1, width: 1080, height: 1920, start_frame: 0 },
    tracks: {
      video: [{ track_id: "V1", kind: "video", clips: [clip("V1_A", 0, 100), clip("V1_B", 100, 100)] }],
      audio: [{ track_id: "A2", kind: "audio", role: "music", clips: [clip("BGM", 100, 100, "music")] }],
      overlay: [{ track_id: "O1", kind: "overlay", clips: [{
        ...clip("HOOK_EXISTING", 100, 40, "title"),
        asset_id: "__overlay__",
        metadata: { content_element: contentElement("hook-existing", "既存タイトル") },
      }] }],
    },
    markers: [{ frame: 100, kind: "beat", label: "b2: body" }],
    provenance: { brief_path: "01_intent/creative_brief.yaml", blueprint_path: "04_plan/edit_blueprint.yaml", selects_path: "04_plan/selects_candidates.yaml", compiler_version: "test" },
  };
}

function contentElement(id: string, title: string) {
  return {
    version: "content-element/v1" as const,
    element_id: id,
    kind: "template" as const,
    template_ref: "vos:overlay.hook-title",
    props: { title },
    layout: { anchor: "top_center" as const, x: 0.5, y: 0.08, width: 0.9, height: 0.2, scale: 1, rotation_deg: 0, opacity: 1, safe_area: true, z_index: 100 },
    renderer_hint: "remotion" as const,
  };
}

const intro: Candidate = {
  candidate_id: "intro",
  segment_id: "SEG_INTRO",
  asset_id: "AST_INTRO",
  src_in_us: 0,
  src_out_us: 1_200_000,
  role: "hero",
  why_it_matches: "intro restore",
  risks: [],
  confidence: 1,
  quality_flags: [],
};
const cutaways: Candidate[] = [1, 2, 3].map((index) => ({
  ...intro,
  candidate_id: `cutaway-${index}`,
  segment_id: `SEG_CUTAWAY_${index}`,
  asset_id: `AST_CUTAWAY_${index}`,
  role: "support",
  why_it_matches: `cutaway ${index}`,
}));

describe("Issue #21 canonical review derivation", () => {
  it("schema accepts hash-bound v2 overlay/ripple ops and rejects an unbound v2 patch", () => {
    const valid = {
      patch_version: "review-patch/v2",
      timeline_version: "1",
      base_timeline_sha256: `sha256:${"a".repeat(64)}`,
      status: "accepted",
      operations: [{
        op: "add_overlay",
        reason: "hook title",
        overlay: { clip_id: "HOOK_1", timeline_in_frame: 0, timeline_duration_frames: 50, beat_id: "b1", content_element: contentElement("hook-1", "挑戦") },
      }],
    };
    expect(validateAgainstSchema(valid, "review-patch.schema.json").valid).toBe(true);
    const invalid = structuredClone(valid) as Record<string, unknown>;
    delete invalid.base_timeline_sha256;
    expect(validateAgainstSchema(invalid, "review-patch.schema.json").valid).toBe(false);
  });

  it("deterministically ripples captions, markers, overlays and pinned audio while authoring overlays", () => {
    const base = timeline();
    base.tracks.video[0].clips[1].captions = [{ text: "body", in_frame: 110, out_frame: 140, style: "simple-shadow" }];
    const patch: ReviewPatch = {
      patch_version: "review-patch/v2",
      timeline_version: "1",
      base_timeline_sha256: `sha256:${"a".repeat(64)}`,
      status: "accepted",
      operations: [
        { op: "insert_segment", with_segment_id: "SEG_INTRO", target_track_id: "V1", new_timeline_in_frame: 0, new_duration_frames: 30, beat_id: "b0", ripple: true, reason: "restore intro" },
        { op: "insert_segment", with_segment_id: "SEG_CUTAWAY_1", target_track_id: "V2", new_timeline_in_frame: 50, new_duration_frames: 15, beat_id: "b1", reason: "cutaway 1" },
        { op: "insert_segment", with_segment_id: "SEG_CUTAWAY_2", target_track_id: "V2", new_timeline_in_frame: 80, new_duration_frames: 15, beat_id: "b1", reason: "cutaway 2" },
        { op: "insert_segment", with_segment_id: "SEG_CUTAWAY_3", target_track_id: "V2", new_timeline_in_frame: 110, new_duration_frames: 15, beat_id: "b1", reason: "cutaway 3" },
        { op: "add_overlay", reason: "first hook", overlay: { clip_id: "HOOK_1", timeline_in_frame: 0, timeline_duration_frames: 20, beat_id: "b0", content_element: contentElement("hook-1", "挑戦") } },
        { op: "add_overlay", reason: "second hook", overlay: { clip_id: "HOOK_2", timeline_in_frame: 30, timeline_duration_frames: 20, beat_id: "b1", content_element: contentElement("hook-2", "再起") } },
        {
          op: "update_overlay",
          target_clip_id: "HOOK_2",
          new_timeline_in_frame: 35,
          new_duration_frames: 25,
          overlay: {
            clip_id: "HOOK_2",
            timeline_in_frame: 35,
            timeline_duration_frames: 25,
            beat_id: "b1",
            content_element: {
              ...contentElement("hook-2", "再挑戦"),
              animation: { in: { preset: "fade-rise", duration_frames: 5 } },
              creative_recipe: {
                version: "creative-recipe/v1",
                reuse_scope: "project",
                authoring_surface: "typed_component",
                layer_mode: "alpha_overlay",
                composite_stage: "under_caption",
                requires_base_frame: false,
              },
            },
          },
          reason: "content and timing polish",
        },
        { op: "remove_overlay", target_clip_id: "HOOK_1", reason: "counterexample removal" },
      ],
    };
    const first = applyPatch(base, patch, [intro, ...cutaways]);
    const second = applyPatch(base, patch, [intro, ...cutaways]);
    expect(first.errors).toEqual([]);
    expect(first.timeline).toEqual(second.timeline);
    expect(first.timeline.tracks.video[0].clips.map((item) => [item.clip_id, item.timeline_in_frame])).toEqual([
      ["CLP_0001", 0], ["V1_A", 30], ["V1_B", 130],
    ]);
    expect(first.timeline.tracks.video[0].clips[2].captions).toEqual([{ text: "body", in_frame: 140, out_frame: 170, style: "simple-shadow" }]);
    expect(first.timeline.markers[0].frame).toBe(130);
    expect(first.timeline.tracks.overlay?.[0].clips.find((item) => item.clip_id === "HOOK_EXISTING")?.timeline_in_frame).toBe(130);
    expect(first.timeline.tracks.audio[0].clips[0].timeline_in_frame).toBe(130);
    const updatedHook = first.timeline.tracks.overlay?.[0].clips.find((item) => item.clip_id === "HOOK_2");
    expect(updatedHook?.metadata?.content_element).toMatchObject({
      props: { title: "再挑戦" },
      animation: { in: { preset: "fade-rise", duration_frames: 5 } },
    });
    expect(first.timeline.tracks.overlay?.[0].clips.map((item) => item.clip_id)).not.toContain("HOOK_1");
    expect(first.timeline.tracks.video.find((track) => track.track_id === "V2")?.clips).toHaveLength(3);
  });

  it("binds a derived timeline to canonical+patch+mapping and rejects handwritten or tampered variants", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-identity-"));
    tempDirs.push(projectDir);
    fs.mkdirSync(path.join(projectDir, "05_timeline"), { recursive: true });
    fs.mkdirSync(path.join(projectDir, "06_review"), { recursive: true });
    const base = timeline();
    const canonicalTimelinePath = path.join(projectDir, "05_timeline/canonical-timeline.json");
    fs.writeFileSync(canonicalTimelinePath, JSON.stringify(base, null, 2));
    const canonicalTimelineSha = computeArtifactSha256(canonicalTimelinePath);
    const patchPath = path.join(projectDir, "06_review/review_patch.json");
    const patch = { patch_version: "review-patch/v2", timeline_version: "1", base_timeline_sha256: canonicalTimelineSha, status: "accepted", operations: [] };
    fs.writeFileSync(patchPath, JSON.stringify(patch, null, 2));
    const mapping = buildDerivedMappingReceipt(base, base, patch.operations);
    base.version = "2";
    stampReviewDerivation(base, patch.base_timeline_sha256, computeArtifactSha256(patchPath), mapping);
    const timelinePath = path.join(projectDir, "05_timeline/timeline.json");
    fs.writeFileSync(timelinePath, JSON.stringify(base, null, 2));
    fs.writeFileSync(path.join(projectDir, "05_timeline/derived-frame-mapping.json"), `${JSON.stringify(mapping, null, 2)}\n`);
    const identity = writeReviewEditIdentityReceipt({ projectDir, timelinePath, patchPath, mapping });
    expect(validateAgainstSchema(mapping, "derived-frame-mapping.schema.json").valid).toBe(true);
    expect(validateAgainstSchema(identity, "review-edit-identity.schema.json").valid).toBe(true);

    const verified = verifyReviewEditIdentity({ projectDir, timelinePath, requireDerived: true });
    expect(verified.cut_identity).toBe(computeArtifactSha256(timelinePath));

    const withUnexpressedOverlay = JSON.parse(fs.readFileSync(timelinePath, "utf8")) as TimelineIR;
    withUnexpressedOverlay.tracks.overlay?.[0].clips.push({
      ...withUnexpressedOverlay.tracks.overlay[0].clips[0],
      clip_id: "HANDWRITTEN_OVERLAY",
    });
    fs.writeFileSync(timelinePath, JSON.stringify(withUnexpressedOverlay, null, 2));
    expect(() => verifyReviewEditIdentity({ projectDir, timelinePath, requireDerived: true })).toThrow(/cut identity mismatch/i);
    fs.writeFileSync(timelinePath, JSON.stringify(base, null, 2));

    const handwritten = path.join(projectDir, "05_timeline/handwritten.json");
    fs.writeFileSync(handwritten, JSON.stringify({ ...base, provenance: { ...base.provenance, review_derivation: undefined } }, null, 2));
    expect(() => verifyReviewEditIdentity({ projectDir, timelinePath: handwritten, requireDerived: true })).toThrow(/underivable/i);

    fs.writeFileSync(patchPath, `${fs.readFileSync(patchPath, "utf8")}\n`);
    expect(() => verifyReviewEditIdentity({ projectDir, timelinePath, requireDerived: true })).toThrow(/patch hash mismatch/i);
  });

  it("rejects canonical hash mismatch and unaccepted v2 before patch compilation", async () => {
    const projectDir = fs.mkdtempSync(path.join(path.resolve("tests"), ".tmp-patch-binding-"));
    tempDirs.push(projectDir);
    fs.mkdirSync(path.join(projectDir, "05_timeline"), { recursive: true });
    fs.mkdirSync(path.join(projectDir, "06_review"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, "05_timeline/timeline.json"), JSON.stringify(timeline(), null, 2));
    const patchPath = path.join(projectDir, "06_review/review_patch.json");
    const patch = {
      patch_version: "review-patch/v2",
      timeline_version: "1",
      base_timeline_sha256: `sha256:${"0".repeat(64)}`,
      status: "accepted",
      operations: [],
    };
    fs.writeFileSync(patchPath, JSON.stringify(patch, null, 2));
    await expect(runPatch(projectDir, patchPath)).rejects.toThrow(/canonical timeline hash mismatch/i);
    patch.base_timeline_sha256 = computeArtifactSha256(path.join(projectDir, "05_timeline/timeline.json"));
    patch.status = "proposed";
    fs.writeFileSync(patchPath, JSON.stringify(patch, null, 2));
    await expect(runPatch(projectDir, patchPath)).rejects.toThrow(/status=accepted/i);
  });

  it("ripple remove closes the primary gap and deterministically maps surviving semantic anchors", () => {
    const base = timeline();
    base.tracks.video[0].clips[1].captions = [{ text: "survives", in_frame: 110, out_frame: 140, style: "simple-shadow" }];
    const patch: ReviewPatch = {
      patch_version: "review-patch/v2",
      timeline_version: "1",
      base_timeline_sha256: `sha256:${"b".repeat(64)}`,
      status: "accepted",
      operations: [{ op: "remove_segment", target_clip_id: "V1_A", ripple: true, reason: "remove intro" }],
    };
    const result = applyPatch(base, patch, []);
    expect(result.errors).toEqual([]);
    const v1 = result.timeline.tracks.video[0].clips;
    expect(v1.map((item) => [item.clip_id, item.timeline_in_frame, item.timeline_duration_frames])).toEqual([["V1_B", 0, 100]]);
    expect(v1[0].captions).toEqual([{ text: "survives", in_frame: 10, out_frame: 40, style: "simple-shadow" }]);
    expect(result.timeline.markers[0].frame).toBe(0);
    expect(result.timeline.tracks.overlay?.[0].clips[0].timeline_in_frame).toBe(0);
    expect(result.timeline.tracks.audio[0].clips[0].timeline_in_frame).toBe(0);
  });

  it("splits an intersected clip on ripple insert without overlap and preserves source slices", () => {
    const base = timeline();
    const patch: ReviewPatch = {
      patch_version: "review-patch/v2",
      timeline_version: "1",
      base_timeline_sha256: `sha256:${"c".repeat(64)}`,
      status: "accepted",
      operations: [{
        op: "insert_segment",
        with_segment_id: "SEG_INTRO",
        target_track_id: "V1",
        new_timeline_in_frame: 50,
        new_duration_frames: 20,
        ripple: true,
        reason: "insert inside first clip",
      }],
    };
    const result = applyPatch(base, patch, [intro]);
    expect(result.errors).toEqual([]);
    const v1 = result.timeline.tracks.video[0].clips;
    expect(v1.map((item) => [item.timeline_in_frame, item.timeline_duration_frames])).toEqual([
      [0, 50], [50, 20], [70, 50], [120, 100],
    ]);
    expect(v1[0]).toMatchObject({ src_in_us: 0, src_out_us: 2_000_000 });
    expect(v1[2]).toMatchObject({ src_in_us: 2_000_000, src_out_us: 4_000_000 });
    expect(v1.every((item, index) => index === 0 || v1[index - 1].timeline_in_frame + v1[index - 1].timeline_duration_frames <= item.timeline_in_frame)).toBe(true);
  });

  it("splits clips crossing a ripple removal and advances every retained source anchor", () => {
    const base = timeline();
    base.tracks.video[0].clips = [clip("KEEP", 0, 50), clip("CUT", 50, 50), clip("NEXT", 100, 100)];
    base.tracks.audio[0].clips = [{ ...clip("PINNED", 0, 200, "music"), src_in_us: 0, src_out_us: 8_000_000 }];
    const patch: ReviewPatch = {
      patch_version: "review-patch/v2",
      timeline_version: "1",
      base_timeline_sha256: `sha256:${"d".repeat(64)}`,
      status: "accepted",
      operations: [{ op: "remove_segment", target_clip_id: "CUT", ripple: true, reason: "remove middle range" }],
    };
    const result = applyPatch(base, patch, []);
    expect(result.errors).toEqual([]);
    expect(result.timeline.tracks.video[0].clips.map((item) => [item.clip_id, item.timeline_in_frame, item.timeline_duration_frames])).toEqual([
      ["KEEP", 0, 50], ["NEXT", 50, 100],
    ]);
    const pinned = result.timeline.tracks.audio[0].clips;
    expect(pinned.map((item) => [item.timeline_in_frame, item.timeline_duration_frames, item.src_in_us, item.src_out_us])).toEqual([
      [0, 50, 0, 2_000_000],
      [50, 100, 4_000_000, 8_000_000],
    ]);
  });

  it("faithfully updates overlay id, timing, duration, beat, track and content", () => {
    const base = timeline();
    const patch: ReviewPatch = {
      patch_version: "review-patch/v2",
      timeline_version: "1",
      base_timeline_sha256: `sha256:${"e".repeat(64)}`,
      status: "accepted",
      operations: [{
        op: "update_overlay",
        target_clip_id: "HOOK_EXISTING",
        reason: "move and rewrite hook",
        overlay: {
          clip_id: "HOOK_RENAMED",
          timeline_in_frame: 12,
          timeline_duration_frames: 36,
          beat_id: "b2",
          track_id: "O2",
          content_element: contentElement("hook-renamed", "更新済み"),
        },
      }],
    };
    const result = applyPatch(base, patch, []);
    expect(result.errors).toEqual([]);
    expect(result.timeline.tracks.overlay?.find((track) => track.track_id === "O1")?.clips).toEqual([]);
    expect(result.timeline.tracks.overlay?.find((track) => track.track_id === "O2")?.clips).toEqual([expect.objectContaining({
      clip_id: "HOOK_RENAMED",
      segment_id: "TXT_hook-renamed",
      timeline_in_frame: 12,
      timeline_duration_frames: 36,
      beat_id: "b2",
      src_in_us: 0,
      src_out_us: 1_440_000,
      metadata: { content_element: expect.objectContaining({ element_id: "hook-renamed", props: { title: "更新済み" } }) },
    })]);
  });

  it("fails closed before mutation when top-level and nested overlay beats conflict", () => {
    const base = timeline();
    const patch: ReviewPatch = {
      patch_version: "review-patch/v2",
      timeline_version: "1",
      base_timeline_sha256: `sha256:${"f".repeat(64)}`,
      status: "accepted",
      operations: [{
        op: "update_overlay",
        target_clip_id: "HOOK_EXISTING",
        beat_id: "top-beat",
        reason: "conflicting beat declarations",
        overlay: {
          clip_id: "HOOK_CHANGED",
          timeline_in_frame: 12,
          timeline_duration_frames: 36,
          beat_id: "nested-beat",
          track_id: "O2",
          content_element: contentElement("hook-changed", "変更禁止"),
        },
      }],
    };
    expect(validateAgainstSchema(patch, "review-patch.schema.json").valid).toBe(true);
    const result = applyPatch(base, patch, []);
    expect(result.errors).toEqual([expect.objectContaining({ op_index: 0, op: "update_overlay", message: expect.stringMatching(/conflicting overlay beat/i) })]);
    expect(result.timeline.tracks).toEqual(base.tracks);
    expect(result.timeline.markers).toEqual(base.markers);
    expect(result.timeline.provenance).toEqual(base.provenance);
  });

  it("accepts equal and one-sided overlay beat declarations", () => {
    const applyBeat = (topBeat: string | undefined, nestedBeat: string | undefined) => applyPatch(timeline(), {
      patch_version: "review-patch/v2",
      timeline_version: "1",
      base_timeline_sha256: `sha256:${"9".repeat(64)}`,
      status: "accepted",
      operations: [{
        op: "update_overlay",
        target_clip_id: "HOOK_EXISTING",
        ...(topBeat ? { beat_id: topBeat } : {}),
        reason: "valid beat declaration",
        ...(nestedBeat ? { overlay: {
          clip_id: "HOOK_EXISTING",
          timeline_in_frame: 100,
          timeline_duration_frames: 40,
          beat_id: nestedBeat,
          content_element: contentElement("hook-existing", "既存タイトル"),
        } } : {}),
      }],
    }, []);

    for (const [topBeat, nestedBeat, expected] of [
      ["same", "same", "same"],
      ["top-only", undefined, "top-only"],
      [undefined, "nested-only", "nested-only"],
    ] as const) {
      const result = applyBeat(topBeat, nestedBeat);
      expect(result.errors).toEqual([]);
      expect(result.timeline.tracks.overlay?.[0].clips[0].beat_id).toBe(expected);
    }
  });

  it("atomically leaves canonical v2 artifacts unpromoted on a schema-valid overlay beat conflict", async () => {
    const projectDir = fs.mkdtempSync(path.join(path.resolve("tests"), ".tmp-overlay-beat-conflict-"));
    tempDirs.push(projectDir);
    fs.mkdirSync(path.join(projectDir, "04_plan"), { recursive: true });
    fs.mkdirSync(path.join(projectDir, "05_timeline"), { recursive: true });
    fs.mkdirSync(path.join(projectDir, "06_review"), { recursive: true });
    const timelinePath = path.join(projectDir, "05_timeline/timeline.json");
    const originalTimelineBytes = JSON.stringify(timeline(), null, 2);
    fs.writeFileSync(timelinePath, originalTimelineBytes);
    fs.writeFileSync(path.join(projectDir, "04_plan/selects_candidates.yaml"), JSON.stringify({ candidates: [] }));
    fs.writeFileSync(path.join(projectDir, "04_plan/edit_blueprint.yaml"), JSON.stringify({
      beats: [{ target_duration_frames: 200 }],
      duration_policy: {
        mode: "guide",
        source: "global_default",
        target_source: "material_total",
        target_duration_sec: 8,
        min_duration_sec: 0,
        max_duration_sec: null,
        hard_gate: false,
        protect_vlm_peaks: true,
      },
    }));
    const patchPath = path.join(projectDir, "06_review/review_patch.json");
    const patch: ReviewPatch = {
      patch_version: "review-patch/v2",
      timeline_version: "1",
      base_timeline_sha256: computeArtifactSha256(timelinePath),
      status: "accepted",
      operations: [
        {
          op: "add_overlay",
          reason: "valid operation must not be partially promoted",
          overlay: {
            clip_id: "HOOK_PARTIAL",
            timeline_in_frame: 0,
            timeline_duration_frames: 10,
            beat_id: "b1",
            content_element: contentElement("hook-partial", "部分適用禁止"),
          },
        },
        {
          op: "update_overlay",
          target_clip_id: "HOOK_EXISTING",
          beat_id: "top-beat",
          reason: "must not promote",
          overlay: {
            clip_id: "HOOK_CHANGED",
            timeline_in_frame: 12,
            timeline_duration_frames: 36,
            beat_id: "nested-beat",
            track_id: "O2",
            content_element: contentElement("hook-changed", "変更禁止"),
          },
        },
      ],
    };
    expect(validateAgainstSchema(patch, "review-patch.schema.json").valid).toBe(true);
    const mixedResult = applyPatch(JSON.parse(originalTimelineBytes) as TimelineIR, patch, []);
    expect(mixedResult.appliedOps).toBe(1);
    expect(mixedResult.errors).toHaveLength(1);
    fs.writeFileSync(patchPath, JSON.stringify(patch, null, 2));

    await expect(runPatch(projectDir, patchPath)).rejects.toThrow(/patch failed/i);
    expect(fs.readFileSync(timelinePath, "utf8")).toBe(originalTimelineBytes);
    expect(fs.existsSync(path.join(projectDir, "05_timeline/derived-frame-mapping.json"))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, "05_timeline/review-edit-identity.json"))).toBe(false);
  });

  it("fails closed at social-review, evaluate and export when a review variant lacks accepted derivation receipts", async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "underivable-review-"));
    const goldenDir = fs.mkdtempSync(path.join(os.tmpdir(), "underivable-golden-"));
    tempDirs.push(projectDir, goldenDir);
    for (const root of [projectDir, goldenDir]) fs.mkdirSync(path.join(root, "05_timeline"), { recursive: true });
    fs.mkdirSync(path.join(projectDir, "06_review"), { recursive: true });
    const timelinePath = path.join(projectDir, "05_timeline/timeline.json");
    fs.writeFileSync(timelinePath, JSON.stringify(timeline(), null, 2));
    fs.writeFileSync(path.join(goldenDir, "05_timeline/timeline.json"), JSON.stringify(timeline(), null, 2));
    fs.writeFileSync(path.join(projectDir, "06_review/review_patch.json"), JSON.stringify({
      patch_version: "review-patch/v2",
      timeline_version: "1",
      base_timeline_sha256: computeArtifactSha256(timelinePath),
      status: "accepted",
      operations: [],
    }, null, 2));
    const captions = path.join(projectDir, "captions.json");
    fs.writeFileSync(captions, JSON.stringify({ captions: [{ text: "x", in_frame: 0, out_frame: 10, style: "simple-shadow" }] }));

    await expect(renderSocialReview({ projectDir, timelinePath, captionPlanPath: captions })).rejects.toThrow(/underivable review variant/i);
    await expect(evaluateCandidateAgainstGolden(projectDir, goldenDir)).rejects.toThrow(/underivable review variant/i);
    expect(() => resolvePremiereExportIdentity({
      projectDir,
      projectId: "day3-equivalent",
      timelinePath,
      sourceMap: new Map(),
      routeDecision: {} as never,
    })).toThrow(/underivable review variant/i);

    fs.writeFileSync(path.join(projectDir, "06_review/review_patch.json"), JSON.stringify({ timeline_version: "1", operations: [] }));
    const handwritten = path.join(projectDir, "05_timeline/handwritten.json");
    fs.writeFileSync(handwritten, JSON.stringify(timeline(), null, 2));
    await expect(renderSocialReview({ projectDir, timelinePath: handwritten, captionPlanPath: captions })).rejects.toThrow(/accepted review-patch\/v2/i);
  });

  it.each([
    ["v1", { timeline_version: "1", operations: [] }],
    ["proposed v2", { patch_version: "review-patch/v2", timeline_version: "1", base_timeline_sha256: `sha256:${"1".repeat(64)}`, status: "proposed", operations: [] }],
    ["rejected v2", { patch_version: "review-patch/v2", timeline_version: "1", base_timeline_sha256: `sha256:${"2".repeat(64)}`, status: "rejected", operations: [] }],
  ])("fails closed for %s patches at all review-variant consumers", async (_label, patch) => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "unaccepted-review-"));
    const goldenDir = fs.mkdtempSync(path.join(os.tmpdir(), "unaccepted-golden-"));
    tempDirs.push(projectDir, goldenDir);
    for (const root of [projectDir, goldenDir]) fs.mkdirSync(path.join(root, "05_timeline"), { recursive: true });
    fs.mkdirSync(path.join(projectDir, "06_review"), { recursive: true });
    const timelinePath = path.join(projectDir, "05_timeline/timeline.json");
    fs.writeFileSync(timelinePath, JSON.stringify(timeline(), null, 2));
    fs.writeFileSync(path.join(goldenDir, "05_timeline/timeline.json"), JSON.stringify(timeline(), null, 2));
    fs.writeFileSync(path.join(projectDir, "06_review/review_patch.json"), JSON.stringify(patch, null, 2));

    expect(() => preflightSocialReviewEditIdentity({ projectDir })).toThrow(/accepted review-patch\/v2/i);
    await expect(evaluateCandidateAgainstGolden(projectDir, goldenDir)).rejects.toThrow(/accepted review-patch\/v2/i);
    expect(() => resolvePremiereExportIdentity({
      projectDir,
      projectId: "day3-equivalent",
      timelinePath,
      sourceMap: new Map(),
      routeDecision: {} as never,
    })).toThrow(/accepted review-patch\/v2/i);
  });

  it("binds social-review, evaluate-edit and export-premiere to one derived cut identity", async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "consumer-identity-"));
    const goldenDir = fs.mkdtempSync(path.join(os.tmpdir(), "consumer-golden-"));
    tempDirs.push(projectDir, goldenDir);
    fs.mkdirSync(path.join(projectDir, "05_timeline"), { recursive: true });
    fs.mkdirSync(path.join(projectDir, "06_review"), { recursive: true });
    fs.mkdirSync(path.join(goldenDir, "05_timeline"), { recursive: true });
    const derived = timeline();
    derived.tracks.audio = [];
    const basePath = path.join(projectDir, "05_timeline/base.json");
    fs.writeFileSync(basePath, JSON.stringify(derived, null, 2));
    const baseSha = computeArtifactSha256(basePath);
    fs.copyFileSync(basePath, path.join(projectDir, "05_timeline/canonical-timeline.json"));
    const patchPath = path.join(projectDir, "06_review/review_patch.json");
    const patch = { patch_version: "review-patch/v2", timeline_version: "1", base_timeline_sha256: baseSha, status: "accepted", operations: [] };
    fs.writeFileSync(patchPath, JSON.stringify(patch, null, 2));
    const mapping = buildDerivedMappingReceipt(derived, derived, []);
    derived.version = "2";
    stampReviewDerivation(derived, baseSha, computeArtifactSha256(patchPath), mapping);
    const timelinePath = path.join(projectDir, "05_timeline/timeline.json");
    fs.writeFileSync(timelinePath, JSON.stringify(derived, null, 2));
    fs.writeFileSync(path.join(projectDir, "05_timeline/derived-frame-mapping.json"), `${JSON.stringify(mapping, null, 2)}\n`);
    writeReviewEditIdentityReceipt({ projectDir, timelinePath, patchPath, mapping });
    fs.writeFileSync(path.join(goldenDir, "05_timeline/timeline.json"), JSON.stringify(derived, null, 2));

    const social = preflightSocialReviewEditIdentity({ projectDir, timelinePath });
    const evaluation = await evaluateCandidateAgainstGolden(projectDir, goldenDir);
    const premiere = resolvePremiereExportIdentity({
      projectDir,
      projectId: derived.project_id,
      timelinePath,
      sourceMap: new Map(),
      routeDecision: {
        version: "render-route/v2",
        requested_assembly_engine: "ffmpeg",
        assembly_engine: "ffmpeg",
        base_engine: "ffmpeg",
        visual_layers: [],
        caption_layer: { engine: "none", composite_stage: "caption" },
        delivery: { compositor: "ffmpeg", video_encoder: "ffmpeg", definition: "sequential_h264_generations/v1", lossy_video_encode_passes: 1 },
        hyperframes_overlay: false,
        remotion_overlay_count: 0,
        hyperframes_element_count: 0,
        speech_caption_engine: "none",
        style_family: "clean_editorial",
        genre: "general",
        reasons: ["identity fixture"],
      },
    });
    expect(evaluation.timeline_identity?.candidate_cut_identity).toBe(social.cut_identity);
    expect(premiere.review_edit_identity?.cut_identity).toBe(social.cut_identity);
    expect(premiere.timeline.sha256).toBe(social.cut_identity);
  });

  it("keeps policy-absent canonical zero-op resolve diagnostics aligned with atomic finalization", async () => {
    const projectDir = fs.mkdtempSync(path.join(path.resolve("tests"), ".tmp-day3-guide-default-patch-"));
    tempDirs.push(projectDir);
    fs.cpSync(path.resolve("tests/fixtures/day3-equivalent"), projectDir, { recursive: true });
    execFileSync("ffmpeg", [
      "-v", "error", "-y", "-f", "lavfi",
      "-i", "testsrc2=size=320x180:rate=25:duration=2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p",
      path.join(projectDir, "02_media/day3-source.mp4"),
    ]);

    const blueprintPath = path.join(projectDir, "04_plan/edit_blueprint.yaml");
    const blueprint = parseYaml(fs.readFileSync(blueprintPath, "utf8")) as Record<string, unknown>;
    delete blueprint.duration_policy;
    fs.writeFileSync(blueprintPath, stringifyYaml(blueprint), "utf8");

    const timelinePath = path.join(projectDir, "05_timeline/timeline.json");
    const patchPath = path.join(projectDir, "06_review/review_patch.json");
    fs.writeFileSync(patchPath, JSON.stringify({
      patch_version: "review-patch/v2",
      timeline_version: "1",
      base_timeline_sha256: computeArtifactSha256(timelinePath),
      status: "accepted",
      operations: [],
    }, null, 2));

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let resolutionLine: string | undefined;
    try {
      await runPatch(projectDir, patchPath, undefined, {
        defaultsOverride: { rhythm_sync: { parity_gate: "off" } },
      });
      resolutionLine = log.mock.calls
        .map(([message]) => message)
        .find((message): message is string => typeof message === "string" && message.startsWith("  Resolution: "));
    } finally {
      log.mockRestore();
    }

    expect(resolutionLine).toBeDefined();
    const resolution = JSON.parse(resolutionLine!.slice("  Resolution: ".length)) as {
      target_frames: number;
      duration_mode?: string;
      target_source?: string;
      duration_delta_frames?: number;
      gap_frames: number;
      gap_count: number;
    };
    expect(resolution).toMatchObject({
      target_frames: 50,
      duration_mode: "guide",
      target_source: "material_total",
      duration_delta_frames: -10,
      gap_frames: 0,
      gap_count: 0,
    });
    expect(fs.existsSync(path.join(projectDir, "05_timeline/timeline.json"))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, "05_timeline/preview-manifest.json"))).toBe(true);
  });

  it("completes the static DAY3-equivalent fixture through patch, derive and social-review", async () => {
    const projectDir = fs.mkdtempSync(path.join(path.resolve("tests"), ".tmp-day3-equivalent-e2e-"));
    tempDirs.push(projectDir);
    fs.cpSync(path.resolve("tests/fixtures/day3-equivalent"), projectDir, { recursive: true });
    execFileSync("ffmpeg", [
      "-v", "error", "-y", "-f", "lavfi",
      "-i", "testsrc2=size=320x180:rate=25:duration=2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p",
      path.join(projectDir, "02_media/day3-source.mp4"),
    ]);

    const patchPath = path.join(projectDir, "06_review/review_patch.json");
    await runPatch(projectDir, patchPath, undefined, {
      defaultsOverride: { rhythm_sync: { parity_gate: "off" } },
    });

    const timelinePath = path.join(projectDir, "05_timeline/timeline.json");
    const derived = JSON.parse(fs.readFileSync(timelinePath, "utf8")) as TimelineIR;
    const mapping = JSON.parse(fs.readFileSync(path.join(projectDir, "05_timeline/derived-frame-mapping.json"), "utf8")) as {
      mapping_sha256: string;
      operations: Array<{ op: string; ripple: boolean }>;
    };
    expect(derived.version).toBe("2");
    expect(derived.tracks.video.find((track) => track.track_id === "V2")?.clips).toHaveLength(3);
    expect(derived.tracks.overlay?.[0].clips).toHaveLength(2);
    expect(mapping.operations).toContainEqual(expect.objectContaining({ op: "insert_segment", ripple: true }));
    expect(fs.existsSync(path.join(projectDir, "05_timeline/canonical-timeline.json"))).toBe(true);

    const canonicalHash = computeArtifactSha256(path.join(projectDir, "05_timeline/canonical-timeline.json"));
    const captionPlanPath = path.join(projectDir, "06_review/caption_plan.json");
    fs.writeFileSync(captionPlanPath, JSON.stringify({
      version: "1",
      base_timeline_hash: canonicalHash,
      derived_mapping_sha256: mapping.mapping_sha256,
      captions: [{ text: "DAY3", in_frame: 0, out_frame: 8, style: "simple-shadow" }],
    }, null, 2));
    const receipt = preflightSocialReviewEditIdentity({ projectDir, timelinePath });
    const reviewIdentity = receipt.receipt;
    if (!reviewIdentity) throw new Error("DAY3 fixture did not produce a derived review identity");
    const subjectPath = path.join(projectDir, "06_review/subject-occupancy-track.json");
    const subject = JSON.parse(fs.readFileSync(subjectPath, "utf8")) as SubjectOccupancyTrack;
    subject.source_identity.source_content_hash = computeArtifactSha256(
      path.join(projectDir, "02_media/day3-source.mp4"),
    );
    subject.generation_id = `sha256:${"1".repeat(64)}`;
    fs.writeFileSync(subjectPath, `${JSON.stringify(subject, null, 2)}\n`);
    const parsedSubject = parseSubjectOccupancyTrack(subject);
    const policyPath = path.join(projectDir, "04_plan/vertical-composition-policy.json");
    const policy = loadVerticalCompositionPolicy(policyPath);
    const fonts = verifyBundledFont();
    const projectFontPath = path.join(
      projectDir,
      "06_review/renderer-fonts",
      path.basename(fonts.assHeavyFontPath),
    );
    fs.mkdirSync(path.dirname(projectFontPath), { recursive: true });
    fs.copyFileSync(fonts.assHeavyFontPath, projectFontPath);
    const sourceMap = loadSourceMap(projectDir);
    const sourceInputAttestation = createSourceInputAttestation(projectDir, {
      timelinePath,
      includeVideo: true,
      includeAudio: true,
    });
    const contentPlan = loadContentRenderPlan(timelinePath);
    const captions = [{ text: "DAY3", in_frame: 0, out_frame: 8, style: "simple-shadow" }];
    const captionStyle = resolveProjectSocialReviewCaptionStyle(
      projectDir,
      derived.sequence.width,
      derived.sequence.height,
    );
    const inputFiles: Array<string | { logicalPath: string; filePath: string }> = [
      "05_timeline/timeline.json",
      reviewIdentity.canonical_timeline.path,
      reviewIdentity.accepted_patch.path,
      reviewIdentity.derived_mapping.path,
      "05_timeline/review-edit-identity.json",
      "06_review/caption_plan.json",
      { logicalPath: "policy/vertical-composition", filePath: policyPath },
      "04_plan/edit_blueprint.yaml",
      { logicalPath: "source-map", filePath: sourceMap.filePath! },
      { logicalPath: "analysis/assets", filePath: path.join(projectDir, "03_analysis/assets.json") },
      { logicalPath: "renderer/font/ass-heavy", filePath: projectFontPath },
    ];
    const sourceAssetIds = new Set(
      [...derived.tracks.video, ...derived.tracks.audio]
        .flatMap((track) => track.clips.map((clip) => clip.asset_id)),
    );
    for (const assetId of [...sourceAssetIds].sort((left, right) => left.localeCompare(right, "en"))) {
      const sourcePath = sourceMap.entryMap.get(assetId)?.source_locator;
      if (sourcePath) {
        inputFiles.push({
          logicalPath: `source-media/${assetId.replace(/[^A-Za-z0-9._-]/g, "_")}/render`,
          filePath: sourcePath,
        });
      }
    }
    const rendererCapabilityHash = hashCanonical({
      version: "social-review-renderer-capability/v1",
      render_contract: "social-review-render/v3",
      output_qa: "deterministic-output-qa/v1",
      layout_qa: "deterministic-layout-qa/v2",
      subject_collision: "subject-occupancy-track/v1",
      remotion_renderer_version: REMOTION_RENDERER_VERSION,
      remotion_overlay_capability_sha256: remotionCapabilityIdentityHash(),
      font_sha256: sha256File(fonts.assHeavyFontPath),
    });
    const generation = captureSocialReviewGeneration({
      projectDir,
      projectId: derived.project_id,
      canonicalTimelineHash: reviewIdentity.canonical_timeline.sha256,
      acceptedPatchHash: reviewIdentity.accepted_patch.sha256,
      derivedMappingReceiptHash: reviewIdentity.derived_mapping.sha256,
      reviewTimelineHash: reviewIdentity.review_timeline.sha256,
      captionTextTimingHash: hashCanonical(captions.map(({ text, in_frame, out_frame }) => ({ text, in_frame, out_frame }))),
      visualTreatmentHash: hashCanonical({ caption_style: captionStyle }),
      contentPlanHash: hashCanonical(contentPlan),
      audioPlanHash: deriveSocialReviewAudioPlanIdentity({
        state: "not_applicable",
        sharedAudioPlanHash: null,
        policy: DEFAULT_MASTERING,
        policyProfileHash: null,
      }),
      rendererCapabilityHash,
      subjectOccupancyPayloadHash: subjectOccupancyPayloadHash(parsedSubject),
      verticalCompositionPolicyHash: verticalCompositionPolicyContentHash(policy),
      sourceInputAttestation,
      files: inputFiles,
    });
    subject.generation_id = generation.generation_id;
    fs.writeFileSync(subjectPath, `${JSON.stringify(subject, null, 2)}\n`);
    expect(receipt.mode).toBe("derived");
    const social = await renderSocialReview({ projectDir, timelinePath, captionPlanPath });
    expect(social).toMatchObject({ review_only: true });
    expect(fs.existsSync(path.join(projectDir, "09_output/social-review/latest.json"))).toBe(true);
  }, 120_000);
});
