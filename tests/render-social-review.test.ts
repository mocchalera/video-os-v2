import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ASS_HEAVY_VIDEO_FONT } from "../editor/shared/font-contract.js";
import type { TimelineIR } from "../runtime/compiler/types.js";
import type { ContentRenderPlan } from "../runtime/content/render-plan.js";
import type { CaptionVisualTreatmentInput } from "../runtime/caption/visual-treatment.js";
import type { SubjectOccupancyTrack } from "../runtime/review/subject-occupancy.js";
import type { SourceInputAttestation } from "../runtime/render/source-input-attestation.js";
import {
  assertSocialReviewAudioPlan,
  assertCaptionPlanCanonicalFreshness,
  assertCaptionPlanDerivedMapping,
  assertSubjectOccupancySourceBinding,
  parseSocialReviewArgs,
  planSocialVisualLayers,
  normalizeCaptionPlan,
  resolveProjectSocialReviewCaptionStyle,
  resolveSocialCaptionCollisionIdentity,
  resolveSocialReviewCaptionStyle,
  socialReviewCaptionStyle,
  timelineVisualDurationFrames,
  validateCaptionPlan,
} from "../scripts/render-social-review.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function timeline(): TimelineIR {
  return {
    version: "1",
    project_id: "social-review-test",
    created_at: "2026-07-26T00:00:00.000Z",
    sequence: {
      name: "Social review",
      fps_num: 24,
      fps_den: 1,
      width: 1080,
      height: 1920,
      start_frame: 0,
      letterbox_policy: "letterbox",
    },
    tracks: {
      video: [{
        track_id: "V1",
        kind: "video",
        clips: [{
          clip_id: "v1",
          segment_id: "s1",
          asset_id: "a1",
          src_in_us: 0,
          src_out_us: 4_000_000,
          timeline_in_frame: 0,
          timeline_duration_frames: 96,
          role: "hero",
          motivation: "test",
          beat_id: "b1",
          fallback_segment_ids: [],
          confidence: 1,
          quality_flags: [],
        }],
      }],
      audio: [],
    },
    markers: [],
    provenance: {
      brief_path: "01_intent/creative_brief.yaml",
      blueprint_path: "04_plan/edit_blueprint.yaml",
      selects_path: "04_plan/selects_candidates.yaml",
      compiler_version: "test",
    },
  };
}

describe("social review renderer planning", () => {
  it("rejects mixed, already-mastered, and repeated mastering routes before render writes", () => {
    const finalMastering = {
      loudness_target_lufs: -16,
      lra_target: 7,
      true_peak_target_dbtp: -1.5,
      count: 1 as const,
      stage: "after_mix" as const,
      owner: "shared_audio_render_plan" as const,
    };
    expect(() => assertSocialReviewAudioPlan({
      strategy: "dialogue_only",
      final_mastering: finalMastering,
    })).not.toThrow();
    expect(() => assertSocialReviewAudioPlan({
      strategy: "legacy_embedded_bgm",
      final_mastering: finalMastering,
    })).toThrow(/mixed audio/i);
    expect(() => assertSocialReviewAudioPlan({
      strategy: "original_passthrough",
      final_mastering: { ...finalMastering, count: 0, stage: "not_applied" },
    })).toThrow(/already.mastered|original.passthrough/i);
    expect(() => assertSocialReviewAudioPlan({
      strategy: "dialogue_only",
      final_mastering: { ...finalMastering, count: 2 as never },
    })).toThrow(/exactly once/i);
  });

  it("allows count-zero only for a plan-bound music_master preserve decision", () => {
    const finalMastering = {
      loudness_target_lufs: -16,
      lra_target: 7,
      true_peak_target_dbtp: -1.5,
      count: 1 as const,
      stage: "after_mix" as const,
      owner: "shared_audio_render_plan" as const,
    };
    const preserveMaster = { audio_decision: "preserve" } as never;
    const masteringMaster = { audio_decision: "mastering" } as never;
    expect(() => assertSocialReviewAudioPlan({
      strategy: "music_master",
      music_master: preserveMaster,
      final_mastering: { ...finalMastering, count: 0, stage: "not_applied" },
    })).not.toThrow();
    for (const count of [0, 2] as const) {
      expect(() => assertSocialReviewAudioPlan({
        strategy: "music_master",
        music_master: masteringMaster,
        final_mastering: { ...finalMastering, count: count as never },
      })).toThrow(/exactly once|zero mastering/i);
    }
  });

  it("binds caption/edit-plan freshness to canonical timeline hash, not version text", () => {
    const canonical = `sha256:${"a".repeat(64)}`;
    const plan = { version: "1", base_timeline_hash: canonical, captions: [{ text: "x", in_frame: 0, out_frame: 1, style: "simple-shadow" as const }] };
    expect(() => assertCaptionPlanCanonicalFreshness(plan, canonical)).not.toThrow();
    expect(() => assertCaptionPlanCanonicalFreshness({ ...plan, version: "1", base_timeline_hash: `sha256:${"b".repeat(64)}` }, canonical)).toThrow(/canonical timeline hash/i);
  });

  it("fails closed for an external caption plan that is not projected across a ripple", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "social-review-caption-mapping-"));
    tempDirs.push(projectDir);
    fs.mkdirSync(path.join(projectDir, "05_timeline"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, "05_timeline", "derived-frame-mapping.json"), JSON.stringify({
      version: "derived-frame-mapping/v1",
      policy: "ripple-semantic-anchor/v1",
      operations: [{ index: 0, op: "insert_segment", ripple: true }],
      entities: [],
      mapping_sha256: "sha256:ignored-by-unit-fixture",
    }));
    const identity = {
      derived_mapping: {
        path: "05_timeline/derived-frame-mapping.json",
        version: "derived-frame-mapping/v1" as const,
        sha256: "sha256:mapping",
      },
    };
    const plan = {
      version: "1",
      base_timeline_hash: "sha256:canonical",
      captions: [{ text: "caption", in_frame: 0, out_frame: 12, style: "simple-shadow" as const }],
    };
    expect(() => assertCaptionPlanDerivedMapping(plan, identity, projectDir)).toThrow(/unprojected.*ripple/i);
    expect(() => assertCaptionPlanDerivedMapping({ ...plan, derived_mapping_sha256: identity.derived_mapping.sha256 }, identity, projectDir)).not.toThrow();
  });

  it("accepts an explicit projected timeline without changing the legacy default", () => {
    expect(parseSocialReviewArgs([
      "node",
      "script",
      "--project",
      "/tmp/project",
      "--repo-sfx-root",
      "/tmp/repo/resources/sfx",
      "--timeline",
      "/tmp/project/05_timeline/timeline-phase5.json",
      "--captions",
      "/tmp/project/06_review/captions.json",
    ])).toMatchObject({
      projectDir: "/tmp/project",
      repoSfxRoot: "/tmp/repo/resources/sfx",
      timelinePath: "/tmp/project/05_timeline/timeline-phase5.json",
    });
    expect(parseSocialReviewArgs([
      "node",
      "script",
      "--project",
      "/tmp/project",
      "--captions",
      "/tmp/project/06_review/captions.json",
    ]).timelinePath).toBeUndefined();

    const renderSource = fs.readFileSync("scripts/render-social-review.ts", "utf8");
    expect(renderSource).toMatch(/resolveSharedAudioRenderPlan\(\{[\s\S]*repoSfxRoot[\s\S]*\}\);/);
  });

  it("includes a CTA that extends beyond the speaker footage", () => {
    const value = timeline();
    (value.tracks as TimelineIR["tracks"] & {
      overlay: TimelineIR["tracks"]["video"];
    }).overlay = [{
      track_id: "OV1",
      kind: "overlay",
      clips: [{
        ...value.tracks.video[0].clips[0],
        clip_id: "cta",
        asset_id: "__overlay__",
        timeline_in_frame: 96,
        timeline_duration_frames: 53,
      }],
    }];

    expect(timelineVisualDurationFrames(value)).toBe(149);
  });

  it("accepts ordered captions and rejects overlap", () => {
    expect(validateCaptionPlan({
      captions: [
        { text: "挑戦する", in_frame: 0, out_frame: 24, style: "simple-shadow" },
        { text: "失敗する", in_frame: 24, out_frame: 48, style: "simple-shadow" },
      ],
    }, 96)).toHaveLength(2);

    expect(() => validateCaptionPlan({
      captions: [
        { text: "挑戦する", in_frame: 0, out_frame: 30, style: "simple-shadow" },
        { text: "失敗する", in_frame: 24, out_frame: 48, style: "simple-shadow" },
      ],
    }, 96)).toThrow("overlaps");
  });

  it("adapts private-caption-plan/v2 display bounds without reading raw word bounds", () => {
    const plan = {
      schema_version: "private-caption-plan/v2",
      cues: [
        {
          text: "表示境界だけを使う",
          timeline_in_frame: 12,
          timeline_out_frame: 30,
          source_in_us: 400_000,
          source_out_us: 1_000_000,
          style: "simple-shadow",
        },
        {
          text: "raw境界は描画しない",
          timeline_in_frame: 30,
          timeline_out_frame: 48,
          source_in_us: 999_000,
          source_out_us: 1_600_000,
          style: "simple-shadow",
        },
      ],
      raw_word_bounds: [
        { text: "overlap", timeline_in_frame: 12, timeline_out_frame: 36 },
        { text: "overlap", timeline_in_frame: 35, timeline_out_frame: 48 },
      ],
    };

    expect(normalizeCaptionPlan(plan)).toEqual([
      { text: "表示境界だけを使う", in_frame: 12, out_frame: 30, style: "simple-shadow" },
      { text: "raw境界は描画しない", in_frame: 30, out_frame: 48, style: "simple-shadow" },
    ]);
    expect(validateCaptionPlan(plan, 96)).toHaveLength(2);
  });

  it("preserves canonical caption IDs and resolves collision roles from visual treatment without changing cue bytes", () => {
    const captions = [
      { text: "baseline", in_frame: 0, out_frame: 10, style: "simple-shadow" as const },
      { text: "keyword", in_frame: 10, out_frame: 20, style: "simple-shadow" as const },
      { text: "title", in_frame: 20, out_frame: 30, style: "simple-shadow" as const },
    ];
    const before = JSON.stringify(captions);
    const visual = {
      caption_identity: captions.map((caption, index) => ({
        caption_id: `SC_${index + 1}`,
        stable_root_id: `SC_${index + 1}`,
        text: caption.text,
        timeline_in_frame: caption.in_frame,
        timeline_duration_frames: caption.out_frame - caption.in_frame,
        treatment: {
          caption_id: `SC_${index + 1}`,
          stable_root_id: `SC_${index + 1}`,
          anchor: "bottom_center",
          style_ref: "sns-vertical",
          hierarchy_role: index === 1 ? "keyword" : index === 2 ? "annotation" : "speech",
          fallback: "registered_fallback",
        },
      })),
    } as unknown as CaptionVisualTreatmentInput;

    expect(resolveSocialCaptionCollisionIdentity(captions, visual)).toEqual([
      { caption_id: "SC_1", role: "baseline" },
      { caption_id: "SC_2", role: "emphasis" },
      { caption_id: "SC_3", role: "title" },
    ]);
    expect(JSON.stringify(captions)).toBe(before);
  });

  it("rejects stale or forged subject source asset/hash/segment/range before rendering", () => {
    const subject = {
      source_identity: {
        asset_id: "a1",
        segment_id: "s1",
        source_content_hash: `sha256:${"a".repeat(64)}`,
        source_range: { src_in_us: 0, src_out_us: 4_000_000 },
      },
    } as SubjectOccupancyTrack;
    const attestation = {
      source_inputs: [{ asset_id: "a1", content_sha256: "a".repeat(64) }],
    } as SourceInputAttestation;
    expect(() => assertSubjectOccupancySourceBinding(subject, timeline(), attestation)).not.toThrow();
    const forged = structuredClone(subject);
    forged.source_identity.source_content_hash = `sha256:${"b".repeat(64)}`;
    expect(() => assertSubjectOccupancySourceBinding(forged, timeline(), attestation)).toThrow(/stale|absent/i);
    const staleRange = structuredClone(subject);
    staleRange.source_identity.source_range.src_out_us += 1;
    expect(() => assertSubjectOccupancySourceBinding(staleRange, timeline(), attestation)).toThrow(/segment\/range.*stale/i);
  });

  it("uses the verified static heavy face for social captions", () => {
    expect(socialReviewCaptionStyle(1080, 1920)).toMatchObject({
      fontName: ASS_HEAVY_VIDEO_FONT.family,
      fontSize: 64,
      borderStyle: 3,
      marginV: 300,
    });
  });

  it("resolves a 1920x1080 clean-lower-third project to restrained blueprint values", () => {
    const style = resolveSocialReviewCaptionStyle("clean-lower-third", 1920, 1080);
    expect(style).toMatchObject({
      fontName: ASS_HEAVY_VIDEO_FONT.family,
      fontSize: 60,
      outline: 3,
      marginV: 36,
      borderStyle: 1,
      playResX: 1920,
      playResY: 1080,
    });
    expect(style).not.toMatchObject({
      fontSize: 114,
      outline: 21,
      marginV: 169,
    });
    expect(socialReviewCaptionStyle(1920, 1080)).toMatchObject({
      fontSize: 114,
      outline: 21,
      marginV: 169,
    });
  });

  it("retains SNS values for an explicit vertical SNS project", () => {
    expect(resolveSocialReviewCaptionStyle("sns-vertical", 1080, 1920)).toEqual(
      socialReviewCaptionStyle(1080, 1920),
    );
    expect(resolveSocialReviewCaptionStyle(
      "single-layer-speaker-separated-safe-area-ja",
      1080,
      1920,
    )).toMatchObject({
      fontName: ASS_HEAVY_VIDEO_FONT.family,
      fontSize: 64,
      outline: 12,
      borderStyle: 3,
      marginV: 300,
    });
  });

  it("keeps the social-review default when no explicit style exists", () => {
    expect(resolveSocialReviewCaptionStyle(undefined, 1920, 1080)).toEqual(
      socialReviewCaptionStyle(1920, 1080),
    );
    expect(resolveSocialReviewCaptionStyle("not-a-registered-style", 1080, 1920)).toEqual(
      socialReviewCaptionStyle(1080, 1920),
    );
  });

  it("reads blueprint styling_class and ignores stale caption-plan presentation", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "social-review-style-"));
    tempDirs.push(projectDir);
    fs.mkdirSync(path.join(projectDir, "04_plan"), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "04_plan", "edit_blueprint.yaml"),
      [
        "caption_policy:",
        "  source: transcript",
        "  styling_class: clean-lower-third",
        "",
      ].join("\n"),
      "utf8",
    );
    const stalePlan = {
      schema_version: "private-caption-plan/v2",
      styling_class: "sns-vertical",
      presentation: { fontSize: 114, outline: 21, marginV: 169, bottom_margin_px: 300 },
      cues: [{
        text: "社内報告",
        timeline_in_frame: 0,
        timeline_out_frame: 24,
        style: "simple-shadow",
        safe_area: { bottom_margin_px: 300, max_lines: 2 },
      }],
    };

    expect(normalizeCaptionPlan(stalePlan)).toEqual([
      { text: "社内報告", in_frame: 0, out_frame: 24, style: "simple-shadow" },
    ]);
    expect(resolveProjectSocialReviewCaptionStyle(projectDir, 1920, 1080)).toMatchObject({
      fontSize: 60,
      outline: 3,
      marginV: 36,
      borderStyle: 1,
    });
  });

  it("still normalizes v2 caption text and timing without using raw word bounds", () => {
    const plan = {
      schema_version: "private-caption-plan/v2",
      styling_class: "sns-vertical",
      presentation: { fontSize: 114 },
      cues: [
        {
          text: "表示境界だけを使う",
          timeline_in_frame: 12,
          timeline_out_frame: 30,
          source_in_us: 400_000,
          source_out_us: 1_000_000,
        },
        {
          text: "raw境界は描画しない",
          timeline_in_frame: 30,
          timeline_out_frame: 48,
          source_in_us: 999_000,
          source_out_us: 1_600_000,
        },
      ],
    };
    expect(normalizeCaptionPlan(plan)).toEqual([
      { text: "表示境界だけを使う", in_frame: 12, out_frame: 30, style: "simple-shadow" },
      { text: "raw境界は描画しない", in_frame: 30, out_frame: 48, style: "simple-shadow" },
    ]);
    expect(validateCaptionPlan(plan, 96)).toHaveLength(2);
  });

  it("plans HyperFrames and Remotion as separate receipt-bearing layers", () => {
    const plan: ContentRenderPlan = {
      width: 1080,
      height: 1920,
      fps: 24,
      fps_num: 24,
      fps_den: 1,
      duration_frames: 149,
      hyperframes_elements: [],
      remotion_clip_ids: [],
      remotion_elements: [],
      remotion_base_required_clip_ids: [],
      visual_elements: [
        {
          clip_id: "lower-third",
          element_id: "speaker",
          renderer: "hyperframes",
          layer_mode: "alpha_overlay",
          composite_stage: "under_caption",
          reuse_scope: "project",
          requires_base_frame: false,
          z_index: 110,
        },
        {
          clip_id: "section",
          element_id: "retry",
          renderer: "hyperframes",
          layer_mode: "alpha_overlay",
          composite_stage: "under_caption",
          reuse_scope: "project",
          requires_base_frame: false,
          z_index: 120,
        },
        {
          clip_id: "cta",
          element_id: "cta",
          renderer: "remotion",
          layer_mode: "full_frame",
          composite_stage: "under_caption",
          reuse_scope: "project",
          requires_base_frame: false,
          z_index: 200,
        },
      ],
      issues: [],
    };

    expect(planSocialVisualLayers(plan)).toEqual([
      {
        renderer: "hyperframes",
        compositeStage: "under_caption",
        zIndex: 110,
        elementIds: ["retry", "speaker"],
      },
      {
        renderer: "remotion",
        compositeStage: "under_caption",
        zIndex: 200,
        elementIds: ["cta"],
      },
    ]);
  });
});
