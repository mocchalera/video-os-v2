import { describe, expect, it } from "vitest";
import {
  DEFAULT_CAPTION_STYLE_PRESET,
  CAPTION_STYLE_PRESETS,
  resolveCaptionStylePreset,
  buildAssForceStyle,
  buildAssDocument,
  parseSrtCues,
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

  it("resolves clean-lower-third to a lower, larger, no-wrap lower-third", () => {
    const p = resolveCaptionStylePreset("clean-lower-third");
    expect(p.presetId).toBe("clean-lower-third");
    expect(p.alignment).toBe("bottom_center");
    expect(p.fontSizePx1080).toBe(48); // talking-head: read-the-quote large
    expect(p.marginV1080).toBe(36);
    expect(p.wrapStyle).toBe(2);
  });

  it("offers genre presets with size scaling to match the medium", () => {
    // The user's insight: appropriate caption size is genre-dependent.
    const digest = resolveCaptionStylePreset("clean-lower-third").fontSizePx1080;
    const cinematic = resolveCaptionStylePreset("cinematic").fontSizePx1080;
    const sns = resolveCaptionStylePreset("sns-vertical").fontSizePx1080;
    expect(cinematic).toBeLessThan(digest); // film captions stay restrained
    expect(sns).toBeGreaterThan(digest); // vertical short-form is oversized
    expect(resolveCaptionStylePreset("sns-vertical").fontWeight).toBe(700);
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

describe("ASS document generation (burn-in)", () => {
  it("pins PlayRes to the frame and carries preset style + WrapStyle", () => {
    const ass = buildAssDocument(
      [{ startSec: 1, endSec: 3.5, text: "行1\n行2" }],
      resolveCaptionStylePreset("clean-lower-third"),
      { width: 1920, height: 1080, fps: 30 },
    );
    expect(ass).toContain("PlayResX: 1920");
    expect(ass).toContain("PlayResY: 1080");
    expect(ass).toContain("WrapStyle: 2");
    // Style row ends with ...,Alignment,MarginL,MarginR,MarginV,Encoding
    // clean-lower-third at 1080p: 48px, alignment 2, MarginL/R 96, MarginV 36
    expect(ass).toMatch(/Style: Default,Arial,48,[^\n]*,2,96,96,36,1/);
    expect(ass).toContain(
      "Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,行1\\N行2",
    );
  });

  it("parseSrtCues round-trips timing and manual line breaks", () => {
    const srt =
      "1\n00:00:01,000 --> 00:00:03,500\nA\nB\n\n2\n00:00:04,000 --> 00:00:05,000\nC\n";
    const cues = parseSrtCues(srt);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({ startSec: 1, endSec: 3.5, text: "A\nB" });
    expect(cues[1]).toMatchObject({ startSec: 4, endSec: 5, text: "C" });
  });
});
