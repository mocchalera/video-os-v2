import { describe, expect, it } from "vitest";
import { planSocialHookOverlay } from "../runtime/caption/social-finishing.js";

function brief(overrides: Record<string, unknown> = {}) {
  return {
    project: { title: "AIと縦動画の編集会議", format: "vertical-short", runtime_target_sec: 65 },
    editorial: { distribution_channel: "social_feed", hook_priority: "aggressive" },
    ...overrides,
  };
}

describe("planSocialHookOverlay", () => {
  it("creates an explicit hook-title for aggressive short social work", () => {
    expect(planSocialHookOverlay({
      brief: brief(),
      fps: 30,
      width: 1080,
      height: 1920,
    })).toEqual([expect.objectContaining({
      overlay_id: "OVL_SOCIAL_HOOK_TITLE",
      styling_class: "vos:overlay.hook-title",
      timeline_in_frame: 0,
      timeline_duration_frames: 48,
      anchor: "top_left",
    })]);
  });

  it("promotes an authored opening title without duplicating it", () => {
    const result = planSocialHookOverlay({
      brief: brief(),
      overlays: [{
        overlay_id: "OPEN",
        timeline_in_frame: 5,
        timeline_duration_frames: 45,
        text: "結果はこうなった",
        styling_class: "vos:overlay.title-card",
      }],
      fps: 30,
      width: 1080,
      height: 1920,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ overlay_id: "OPEN", styling_class: "vos:overlay.hook-title" });
  });

  it("leaves non-social and credibility-first work unchanged", () => {
    const authored = [{
      overlay_id: "OPEN",
      timeline_in_frame: 0,
      timeline_duration_frames: 45,
      text: "記録映像",
      styling_class: "vos:overlay.title-card",
    }];
    const longform = planSocialHookOverlay({
      brief: brief({
        project: { title: "イベント", format: "event", runtime_target_sec: 600 },
        editorial: { distribution_channel: "presentation", hook_priority: "balanced" },
      }),
      overlays: authored,
      fps: 30,
      width: 1920,
      height: 1080,
    });
    const credibility = planSocialHookOverlay({
      brief: brief({
        editorial: { distribution_channel: "social_feed", hook_priority: "credibility_first" },
      }),
      overlays: authored,
      fps: 30,
      width: 1080,
      height: 1920,
    });
    expect(longform).toEqual(authored);
    expect(credibility).toEqual(authored);
  });
});
