import { describe, expect, it } from "vitest";
import { buildRenderSpec } from "../../shared/render-spec.js";

const resolver = (assetId: string) => `/dev/null/${assetId}.mov`;

describe("buildRenderSpec — dialogue cut fade metadata", () => {
  it("emits the project dialogue fade flag and audio role metadata from applied skills", () => {
    const spec = buildRenderSpec(
      {
        sequence: { fps_num: 30, fps_den: 1, width: 640, height: 360 },
        tracks: {
          video: [
            {
              track_id: "V1",
              kind: "video",
              clips: [
                makeClip("v1", "speech", "hero", "V1", true),
              ],
            },
          ],
          audio: [
            {
              track_id: "A1",
              kind: "audio",
              clips: [
                makeClip("a1", "speech", "nat_sound", "A1", true),
              ],
            },
          ],
        },
      },
      "rev-dialogue-cut-fade",
      resolver,
    );

    expect(spec.audio.dialogue_cut_fade_ms).toBe(40);
    expect(spec.audio.dialogueClips[0]).toMatchObject({
      trackId: "A1",
      role: "nat_sound",
    });
  });

  it("keeps the fade flag at zero without talking_head_pacing", () => {
    const spec = buildRenderSpec(
      {
        sequence: { fps_num: 30, fps_den: 1, width: 640, height: 360 },
        tracks: {
          video: [
            {
              track_id: "V1",
              kind: "video",
              clips: [
                makeClip("v1", "speech", "hero", "V1", false),
              ],
            },
          ],
          audio: [
            {
              track_id: "A1",
              kind: "audio",
              clips: [
                makeClip("a1", "speech", "nat_sound", "A1", false),
              ],
            },
          ],
        },
      },
      "rev-no-dialogue-cut-fade",
      resolver,
    );

    expect(spec.audio.dialogue_cut_fade_ms).toBe(0);
  });
});

function makeClip(
  clipId: string,
  assetId: string,
  role: string,
  trackId: string,
  enabled: boolean,
) {
  return {
    clip_id: clipId,
    segment_id: `SEG_${clipId}`,
    asset_id: assetId,
    src_in_us: 0,
    src_out_us: 2_000_000,
    timeline_in_frame: 0,
    timeline_duration_frames: 60,
    role,
    motivation: `dialogue cut fade ${trackId}`,
    beat_id: "b01",
    fallback_segment_ids: [],
    confidence: 0.9,
    quality_flags: [],
    ...(enabled
      ? {
        metadata: {
          editorial: {
            applied_skills: ["talking_head_pacing"],
          },
        },
      }
      : {}),
  };
}
