import { describe, expect, it } from "vitest";
import { shouldPreserveOriginalAudioLevel } from "../runtime/audio/preservation.js";

describe("original audio preservation policy", () => {
  it("requires original_only and explicit loudnorm opt-out on every dialogue clip", () => {
    expect(shouldPreserveOriginalAudioLevel({
      provenance: { audio_policy: { mode: "original_only" } },
      tracks: {
        audio: [{
          track_id: "A1",
          clips: [
            { role: "dialogue", audio_policy: { a1_loudnorm: false } },
            { role: "nat_sound", audio_policy: { a1_loudnorm: false } },
          ],
        }],
      },
    })).toBe(true);

    expect(shouldPreserveOriginalAudioLevel({
      provenance: { audio_policy: { mode: "original_only" } },
      tracks: {
        audio: [{
          track_id: "A1",
          clips: [{ role: "dialogue", audio_policy: { a1_loudnorm: true } }],
        }],
      },
    })).toBe(false);
  });

  it("does not claim preservation when timeline music is present", () => {
    expect(shouldPreserveOriginalAudioLevel({
      provenance: { audio_policy: { mode: "original_only" } },
      tracks: {
        audio: [
          { track_id: "A1", clips: [{ audio_policy: { a1_loudnorm: false } }] },
          { track_id: "A2", clips: [{ role: "music" }] },
        ],
      },
    })).toBe(false);
  });
});
