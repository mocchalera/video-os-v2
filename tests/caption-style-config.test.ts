import { describe, expect, it } from "vitest";
import {
  DEFAULT_CAPTION_STYLE_PRESET,
  CAPTION_STYLE_PRESETS,
  resolveCaptionStylePreset,
  buildAssForceStyle,
} from "../editor/shared/caption-style-tokens.js";

/**
 * Per-project caption styling: caption_policy.styling_class selects a preset
 * (position/width/wrap) so operators tune subtitles without code changes,
 * and the ASS force_style carries WrapStyle so ffmpeg keeps the approved
 * line layout instead of re-wrapping. See runtime/render/pipeline.burnCaptions
 * (original_size pins PlayRes) and the matching preview-job-service burn.
 */
describe("caption style preset registry", () => {
  it("default preset suppresses auto-wrap (WrapStyle=2)", () => {
    expect(DEFAULT_CAPTION_STYLE_PRESET.wrapStyle).toBe(2);
  });

  it("registers the default and clean-lower-third presets", () => {
    expect(CAPTION_STYLE_PRESETS.default).toBe(DEFAULT_CAPTION_STYLE_PRESET);
    expect(CAPTION_STYLE_PRESETS["clean-lower-third"].presetId).toBe("clean-lower-third");
  });

  it("resolves clean-lower-third to a lower, no-wrap lower-third", () => {
    const p = resolveCaptionStylePreset("clean-lower-third");
    expect(p.presetId).toBe("clean-lower-third");
    expect(p.alignment).toBe("bottom_center");
    expect(p.marginV1080).toBe(36);
    expect(p.wrapStyle).toBe(2);
  });

  it("falls back to default for unknown or undefined styling_class", () => {
    expect(resolveCaptionStylePreset(undefined).presetId).toBe("default");
    expect(resolveCaptionStylePreset("nonexistent").presetId).toBe("default");
    expect(resolveCaptionStylePreset("").presetId).toBe("default");
  });

  it("emits WrapStyle, bottom alignment, and scaled MarginV in force_style", () => {
    const style = buildAssForceStyle(
      resolveCaptionStylePreset("clean-lower-third"),
      { width: 1920, height: 1080, fps: 30 },
    );
    expect(style).toContain("WrapStyle=2");
    expect(style).toContain("Alignment=2"); // ASS bottom-center
    expect(style).toContain("MarginV=36"); // 36px at 1080p reference
  });

  it("scales MarginV with resolution", () => {
    const style720 = buildAssForceStyle(
      resolveCaptionStylePreset("clean-lower-third"),
      { width: 1280, height: 720, fps: 30 },
    );
    // 36 * (720/1080) = 24
    expect(style720).toContain("MarginV=24");
  });
});
