import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ASS_HEAVY_VIDEO_FONT } from "../editor/shared/font-contract.js";
import type { TimelineIR } from "../runtime/compiler/types.js";
import type { ContentRenderPlan } from "../runtime/content/render-plan.js";
import {
  parseSocialReviewArgs,
  planSocialVisualLayers,
  normalizeCaptionPlan,
  resolveProjectSocialReviewCaptionStyle,
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
  it("accepts an explicit projected timeline without changing the legacy default", () => {
    expect(parseSocialReviewArgs([
      "node",
      "script",
      "--project",
      "/tmp/project",
      "--timeline",
      "/tmp/project/05_timeline/timeline-phase5.json",
      "--captions",
      "/tmp/project/06_review/captions.json",
    ])).toMatchObject({
      projectDir: "/tmp/project",
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
