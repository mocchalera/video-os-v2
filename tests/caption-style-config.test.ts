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
    expect(DEFAULT_CAPTION_STYLE_PRESET.fontId).toBe("noto-sans-jp");
    expect(DEFAULT_CAPTION_STYLE_PRESET.fontFamily).toBe("Noto Sans JP");
  });

  it("registers the default and clean-lower-third presets", () => {
    expect(CAPTION_STYLE_PRESETS.default).toBe(DEFAULT_CAPTION_STYLE_PRESET);
    expect(CAPTION_STYLE_PRESETS["clean-lower-third"].presetId).toBe("clean-lower-third");
  });

  it("resolves clean-lower-third to a lower, larger, no-wrap lower-third", () => {
    const p = resolveCaptionStylePreset("clean-lower-third");
    expect(p.presetId).toBe("clean-lower-third");
    expect(p.alignment).toBe("bottom_center");
    expect(p.fontSizePx1080).toBe(60); // speech-led: readable on phone-sized playback
    expect(p.outlinePx1080).toBe(3);
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
    expect(resolveCaptionStylePreset("longform-event")).toMatchObject({
      presetId: "longform-event",
      fontSizePx1080: 56,
      marginV1080: 48,
      wrapStyle: 2,
    });
  });

  it("resolves the approved SNS style to large outline-only subtitles", () => {
    const preset = resolveCaptionStylePreset("single-layer-speaker-separated-safe-area-ja");
    expect(preset.fontSizePx1080).toBeGreaterThanOrEqual(58);
    expect(preset.outlinePx1080).toBeGreaterThanOrEqual(3.5);
    expect(preset.shadowPx1080).toBe(0);
    expect(preset.speakerSeparation).toMatchObject({
      offscreenLabels: expect.arrayContaining(["AI"]),
      offscreen: { alignment: "top_center" },
      onscreen: { alignment: "bottom_center" },
    });
  });

  it("supports the explicit bold-outline speaker-separated alias", () => {
    const preset = resolveCaptionStylePreset(
      "single-layer-speaker-separated-bold-outline-safe-area-ja",
    );
    expect(preset.presetId).toBe(
      "single-layer-speaker-separated-bold-outline-safe-area-ja",
    );
    expect(preset.fontSizePx1080).toBe(50);
    expect(preset.maxWidthRatio).toBe(0.9);
    expect(preset.outlinePx1080).toBe(4.5);
    expect(preset.fontWeight).toBe(900);
    expect(preset.assFontFamily).toBe("VideoOS Noto Sans JP Black");
    expect(preset.assSynthesizeBold).toBe(false);
    expect(preset.speakerSeparation?.stackedLabel).toMatchObject({
      fontSizePx1080: 19,
      outlinePx1080: 1.5,
    });
    expect(preset.speakerSeparation?.offscreenLabels).toContain("AI");
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
    // clean-lower-third at 1080p: 60px, alignment 2, MarginL/R 96, MarginV 36
    expect(ass).toMatch(/Style: Default,Noto Sans JP,60,[^\n]*,2,96,96,36,1/);
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

  it("routes the approved dialogue-short preset to speaker-specific outline styles", () => {
    const ass = buildAssDocument(
      [
        { startSec: 0, endSec: 1, text: "AI｜ビートを始める" },
        { startSec: 1, endSec: 2, text: "坂本｜もっと本気で" },
      ],
      resolveCaptionStylePreset("single-layer-speaker-separated-safe-area-ja"),
      { width: 1080, height: 1920, fps: 24 },
    );

    expect(ass).toMatch(/Style: Offscreen,Noto Sans JP,103,[^\n]*,8,65,65,389,1/);
    expect(ass).toMatch(/Style: Onscreen,Noto Sans JP,103,[^\n]*,2,65,65,235,1/);
    expect(ass).toContain("Dialogue: 0,0:00:00.00,0:00:01.00,Offscreen,,0,0,0,,AI｜ビートを始める");
    expect(ass).toContain("Dialogue: 0,0:00:01.00,0:00:02.00,Onscreen,,0,0,0,,坂本｜もっと本気で");
  });

  it("renders the bold dialogue-short alias with stacked speaker labels", () => {
    const ass = buildAssDocument(
      [
        { startSec: 0, endSec: 1, text: "AI｜ちょっと待って、今の\nプリキュアなんだっけ？" },
        { startSec: 1, endSec: 2, text: "坂本｜今のプリキュア\n何か知ってる？" },
      ],
      resolveCaptionStylePreset(
        "single-layer-speaker-separated-bold-outline-safe-area-ja",
      ),
      { width: 1080, height: 1920, fps: 30 },
    );

    expect(ass).toMatch(/Style: Offscreen,VideoOS Noto Sans JP Black,89,&H00FFFFFF/);
    expect(ass).toMatch(/Style: Onscreen,VideoOS Noto Sans JP Black,89,&H00FFFFFF/);
    expect(ass).toMatch(/Style: OffscreenLabel,VideoOS Noto Sans JP Black,34,&H00FFE76E/);
    expect(ass).toMatch(/Style: OnscreenLabel,VideoOS Noto Sans JP Black,34,&H004FD6FF/);
    expect(ass).toMatch(/Style: Offscreen,VideoOS Noto Sans JP Black,89,[^\n]*,0,0,0,0,100/);
    expect(ass).toContain("OffscreenLabel,,0,0,0,,{\\an2\\pos(540,371)}AI");
    expect(ass).toContain("OnscreenLabel,,0,0,0,,{\\an2\\pos(540,1464)}坂本");
    expect(ass).toContain("Offscreen,,0,0,0,,ちょっと待って、今の\\Nプリキュアなんだっけ？");
    expect(ass).toContain("Onscreen,,0,0,0,,今のプリキュア\\N何か知ってる？");
    expect(ass).not.toContain("AI｜ちょっと待って");
    expect(ass).not.toContain("坂本｜今のプリキュア");
  });

  it("animates social questions and protected reveals without moving cue timing", () => {
    const ass = buildAssDocument(
      [
        { startSec: 1, endSec: 2, text: "坂本｜本当に知ってる？", semanticRole: "question" },
        { startSec: 2, endSec: 3, text: "AI｜実は調べました", semanticRole: "reveal" },
      ],
      resolveCaptionStylePreset(
        "single-layer-speaker-separated-bold-outline-safe-area-ja",
      ),
      { width: 1080, height: 1920, fps: 30 },
    );

    expect(ass).toContain(
      "0:00:01.00,0:00:02.00,Onscreen,,0,0,0,,{\\fad(80,100)\\fscx105",
    );
    expect(ass).toContain(
      "0:00:02.00,0:00:03.00,Offscreen,,0,0,0,,{\\fad(40,80)\\fscx115",
    );
  });

  it("keeps semantic motion disabled for non-social caption presets", () => {
    const ass = buildAssDocument(
      [{ startSec: 1, endSec: 2, text: "本当に？", semanticRole: "question" }],
      resolveCaptionStylePreset("clean-lower-third"),
      { width: 1920, height: 1080, fps: 30 },
    );
    expect(ass).not.toContain("\\fscx105");
  });
});
