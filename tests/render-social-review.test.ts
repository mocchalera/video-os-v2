import { describe, expect, it } from "vitest";
import { ASS_HEAVY_VIDEO_FONT } from "../editor/shared/font-contract.js";
import type { TimelineIR } from "../runtime/compiler/types.js";
import type { ContentRenderPlan } from "../runtime/content/render-plan.js";
import {
  planSocialVisualLayers,
  socialReviewCaptionStyle,
  timelineVisualDurationFrames,
  validateCaptionPlan,
} from "../scripts/render-social-review.js";

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

  it("uses the verified static heavy face for social captions", () => {
    expect(socialReviewCaptionStyle(1080, 1920)).toMatchObject({
      fontName: ASS_HEAVY_VIDEO_FONT.family,
      fontSize: 64,
      borderStyle: 3,
      marginV: 300,
    });
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
