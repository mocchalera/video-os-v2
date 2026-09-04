import { describe, expect, it } from "vitest";
import {
  escapeAssCaptionText,
  sanitizeCaptionTextForRendering,
} from "../editor/shared/caption-text-sanitizer.js";
import {
  buildAssDocument,
  DEFAULT_CAPTION_STYLE_PRESET,
} from "../editor/shared/caption-style-tokens.js";
import { buildCaptionDrawtextFilter } from "../runtime/render/assembler.js";
import { buildAssSubtitleFile } from "../runtime/render/promo-finisher.js";

describe("caption emoji render sanitization", () => {
  it("removes complete emoji clusters while preserving readable caption text", () => {
    expect(sanitizeCaptionTextForRendering("走るぞ🔥  強くなる💪🏽"))
      .toBe("走るぞ 強くなる");
    expect(sanitizeCaptionTextForRendering("🔥💪"))
      .toBe("…");
  });

  it("sanitizes and escapes canonical ASS cues", () => {
    const ass = buildAssDocument([
      { startSec: 0, endSec: 2, text: "本気🔥 {now}\\go" },
    ], DEFAULT_CAPTION_STYLE_PRESET, { width: 1080, height: 1920, fps: 30 });

    expect(ass).toContain("本気 \\{now\\}\\\\go");
    expect(ass).not.toContain("🔥");
    expect(ass).not.toContain("□");
    expect(escapeAssCaptionText("💪")).toBe("…");
  });

  it("uses the same safe text for legacy ASS and drawtext paths", () => {
    const legacyAss = buildAssSubtitleFile([
      { text: "燃える🔥\nいける💪", in_frame: 0, out_frame: 48, style: "simple-shadow" },
    ], 24);
    const drawtext = buildCaptionDrawtextFilter([
      { text: "燃える🔥", in_frame: 0, out_frame: 48, style: "simple-shadow" },
    ], 24, 1080, 1920, "/tmp/font.ttf");

    expect(legacyAss).toContain("燃える\\Nいける");
    expect(legacyAss).not.toMatch(/[🔥💪□]/u);
    expect(drawtext).toContain("text='燃える'");
    expect(drawtext).not.toMatch(/[🔥💪□]/u);
  });
});
