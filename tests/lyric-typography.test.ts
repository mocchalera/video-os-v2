import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  LYRIC_ARTWORK_RECT,
  LYRIC_BOUNDARY_Y,
  LYRIC_FRAME,
  LYRIC_SAFE_WIDTH_PX,
  POSTER_MARGIN_V_RANGE,
  breakLyricTwoTier,
  buildLyricAssDocument,
  consumeSectionTags,
  expandKineticStaccato,
  measureLyricWidthPx,
  planLyricTypography,
  resolveLyricFont,
  resolvePosterPosition,
  resolveHorizontalBounds,
  sanitizeLyricLine,
  sanitizeLyrics,
} from "../runtime/caption/lyric-typography.js";
import {
  normalizeFontFamily,
  probeInstalledFontFamily,
  readFontFamilyNames,
  resetFontProbeCaches,
} from "../runtime/fonts/system-font-probe.js";
import { resolveBundledFontPaths } from "../runtime/fonts/bundled-font.js";
import { validateAgainstSchema } from "../runtime/commands/shared.js";
import { ASS_HEAVY_VIDEO_FONT } from "../editor/shared/font-contract.js";

const fakeProbe = (capability: "available" | "unavailable" | "unknown", detail = "fake probe") =>
  () => ({ capability, detail });

describe("Issue 36 strict pure-lyrics sanitizer", () => {
  it("strips `//` comments so they can never render as subtitles", () => {
    expect(sanitizeLyricLine("泣いてる // TODO: check")).toEqual({
      text: "泣いてる",
      removedTokens: ["// TODO: check"],
      isPureLyric: true,
    });
    expect(sanitizeLyricLine("// comment only").isPureLyric).toBe(false);
    expect(sanitizeLyricLine("/// triple slash").isPureLyric).toBe(false);
  });

  it("preserves metadata-free authored text and normalizes only a metadata-derived display line", () => {
    const authored = "  夢  の  中  ";
    expect(sanitizeLyricLine(authored)).toEqual({
      text: authored,
      removedTokens: [],
      isPureLyric: true,
    });
    const plan = planLyricTypography({
      lyrics: [{ text: authored, startSec: 0, endSec: 2 }],
      probe: fakeProbe("unavailable", "source-preservation"),
    });
    expect(plan.cues[0]?.raw_text).toBe(authored);
    expect(plan.cues[0]?.sanitized_text).toBe(authored);
    expect(sanitizeLyricLine(`${authored}// display note`)).toEqual({
      text: "夢 の 中",
      removedTokens: ["// display note"],
      isPureLyric: true,
    });
  });

  it("strips `[Verse]`/`[Chorus]` tags and full-width brackets entirely", () => {
    expect(sanitizeLyricLine("[Chorus] 光の中へ").text).toBe("光の中へ");
    expect(sanitizeLyricLine("【サビ】 君と走る").text).toBe("君と走る");
    expect(sanitizeLyricLine("［Bridge］").isPureLyric).toBe(false);
  });

  it("strips numbered and attributed section tags without losing the lyric", () => {
    expect(sanitizeLyricLine("[Verse 1] 夜が降る").text).toBe("夜が降る");
    expect(sanitizeLyricLine("[Chorus glow=amber] 光の中へ").text).toBe("光の中へ");
    expect(sanitizeLyricLine("【Aメロ 2】 君と走る").text).toBe("君と走る");

    const plan = planLyricTypography({
      lyrics: [{ text: "[Verse 1] 夜が降る", startSec: 0, endSec: 2 }],
      probe: fakeProbe("unavailable", "ci"),
    });
    expect(plan.violations).toEqual([]);
    expect(plan.cues[0]?.sanitized_text).toBe("夜が降る");
    const ass = buildLyricAssDocument(plan);
    expect(ass).toContain("夜が降る");
    expect(ass).not.toContain("Verse 1");
  });

  it("strips metadata parens like `(BGM)` in half- and full-width form", () => {
    expect(sanitizeLyricLine("(BGM)").isPureLyric).toBe(false);
    expect(sanitizeLyricLine("（BGM）").isPureLyric).toBe(false);
    expect(sanitizeLyricLine("(Instrumental)").isPureLyric).toBe(false);
    expect(sanitizeLyricLine("（間奏）").isPureLyric).toBe(false);
    expect(sanitizeLyricLine("[00:12.00] 涙がこぼれる").text).toBe("涙がこぼれる");
  });

  it("keeps parenthetical lyrics that are not metadata vocabulary", () => {
    // Backing vocals written in parens are sung lyrics, not annotations.
    expect(sanitizeLyricLine("（あーーー）").text).toBe("（あーーー）");
    expect(sanitizeLyricLine("夢の中 (dreaming) へ").text).toBe("夢の中 (dreaming) へ");
  });

  it("removes directive, comment, decoration, and separator lines", () => {
    const script = [
      "作詞：誰か",
      "BPM: 128",
      "# encode note",
      "※この歌詞は参考です",
      "♪♪♪",
      "―――――",
      "夜が降る",
    ].join("\n");
    const result = sanitizeLyrics(script);
    expect(result.lines).toEqual(["夜が降る"]);
    expect(result.removed.map((entry) => entry.reason)).toEqual([
      "directive line",
      "directive line",
      "comment/annotation line",
      "comment/annotation line",
      "metadata-only line",
      "separator line",
    ]);
  });

  it("never rewrites lyric characters while stripping metadata", () => {
    const line = "笑っていた//note";
    const result = sanitizeLyricLine(line);
    expect("笑っていた".split("").every((char) => result.text.includes(char))).toBe(true);
  });
});

describe("Issue 36 section tag consumption", () => {
  it("parses ONLY standalone tags as sections and reads glow attributes", () => {
    expect(consumeSectionTags("[Aメロ]")).toMatchObject({
      sections: [{ role: "verse" }],
      text: "",
    });
    expect(consumeSectionTags("[Chorus glow=amber]")).toMatchObject({
      sections: [{ role: "chorus", glowColor: "amber" }],
    });
    // recognized tags declare sections only when standalone
    expect(consumeSectionTags("[サビ]")).toMatchObject({
      sections: [{ role: "chorus" }],
    });
    expect(consumeSectionTags("[Punk]")).toMatchObject({
      sections: [{ role: "punk" }],
    });
    expect(consumeSectionTags("[間奏]")).toMatchObject({
      sections: [{ role: "instrumental" }],
    });
  });

  it("leaves inline bracketed text for the sanitizer: lyrics preserved, metadata stripped", () => {
    // inline recognized tag: no section switch, but the sanitizer strips it
    const inline = consumeSectionTags("[サビ] 光れ");
    expect(inline.sections).toEqual([]);
    expect(inline.text).toBe("[サビ] 光れ");
    expect(sanitizeLyricLine(inline.text).text).toBe("光れ");
    // legitimate bracketed lyric text survives the sanitizer untouched
    expect(sanitizeLyricLine("君の手 [F] を引いて").text).toBe("君の手 [F] を引いて");
    // inline metadata vocabulary (Guitar Solo) never renders
    expect(sanitizeLyricLine("あの [Guitar Solo] 日").text).not.toContain("Guitar Solo");
  });

  it("reports unrecognized standalone tags instead of rendering them", () => {
    const result = consumeSectionTags("[Guitar Solo 2]");
    expect(result.unknownTags).toEqual(["[Guitar Solo 2]"]);
    expect(result.sections).toEqual([]);
    expect(result.text).toBe("");
    // ...and inline non-metadata brackets are preserved as lyric text
    expect(consumeSectionTags("夢の中 [夢的小屋] へ").text).toBe("夢の中 [夢的小屋] へ");
  });

  it("drops standalone LRC timestamps without declaring sections", () => {
    const result = consumeSectionTags("[00:45.00]");
    expect(result.sections).toEqual([]);
    expect(result.unknownTags).toEqual([]);
    expect(result.text).toBe("");
    // inline timestamps are removed by the sanitizer, not the tag parser
    const inline = consumeSectionTags("[00:45.00] 涙");
    expect(inline.text).toBe("[00:45.00] 涙");
    expect(sanitizeLyricLine(inline.text).text).toBe("涙");
  });
});

describe("Issue 36 measured two-tier line breaking", () => {
  it("measures CJK at 1em and Latin at 0.5em", () => {
    expect(measureLyricWidthPx("夜夜", 100)).toBe(200);
    expect(measureLyricWidthPx("AB", 100)).toBe(100);
    expect(measureLyricWidthPx("夜A", 100)).toBe(150);
  });

  it("keeps a short line on one main tier", () => {
    const result = breakLyricTwoTier("夜が降る", { role: "verse" });
    expect(result.selection_reason).toBe("single_main");
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toMatchObject({
      tier: "main",
      font_size_px: 100,
      measured_width_px: 400,
      fits_safe_width: true,
    });
    expect(result.violation).toBeUndefined();
  });

  it("splits a 16-char line into two measured tiers within 920px", () => {
    const line = "写真の中の二人はあの日のまま笑ってる"; // 18 chars
    const result = breakLyricTwoTier(line, { role: "chorus" });
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0].tier).toBe("main");
    expect(result.lines[1].tier).toBe("sub");
    for (const tier of result.lines) {
      expect(tier.measured_width_px).toBeLessThanOrEqual(LYRIC_SAFE_WIDTH_PX);
      expect(tier.fits_safe_width).toBe(true);
    }
    // Break must be at a word boundary (no torn reading unit).
    const joined = result.lines.map((l) => l.text).join("");
    expect(joined).toBe(line);
    expect(result.lines[0].text.endsWith(result.lines[1].text[0])).toBe(false);
  });

  it("flags an unbreakable 34-char line instead of silently overflowing", () => {
    const line = "とても長い歌詞の行は二段組みでも入りきらないので正直に違反を報告する"; // 34 chars
    const result = breakLyricTwoTier(line, { role: "verse" });
    expect(result.violation).toBeTruthy();
    expect(result.violation).toContain("920px");
    expect(result.lines.some((l) => !l.fits_safe_width)).toBe(true);
  });

  it("never starts the sub tier with a forbidden particle or closing punctuation", () => {
    const line = "届け届けと声を枯らして叫んだあの日";
    const result = breakLyricTwoTier(line, { role: "verse" });
    if (result.lines.length === 2) {
      const sub = result.lines[1];
      expect(["は", "が", "を", "に", "で", "と", "も", "の", "。", "、"]).not.toContain(sub.text[0]);
    }
  });

  it("honors authored manual breaks with main/sub tier sizing", () => {
    const result = breakLyricTwoTier("夜の靄が\n静かに降りてくる", { role: "verse" });
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0].tier).toBe("main");
    expect(result.lines[1].tier).toBe("sub");
    expect(result.lines.every((l) => l.fits_safe_width)).toBe(true);
  });
});

describe("Issue 36 poster boundary-cross positioning", () => {
  it("resolves MarginV inside the 450–480 band and crosses Y=1400", () => {
    const position = resolvePosterPosition(100, 120);
    expect(position.margin_v_px).toBeGreaterThanOrEqual(POSTER_MARGIN_V_RANGE.min);
    expect(position.margin_v_px).toBeLessThanOrEqual(POSTER_MARGIN_V_RANGE.max);
    expect(position.crosses_boundary).toBe(true);
    expect(position.text_top_y).toBeLessThan(LYRIC_BOUNDARY_Y);
    expect(position.text_bottom_y).toBeGreaterThan(LYRIC_BOUNDARY_Y);
    // 1920 - 1400 - 100/2 = 470
    expect(resolvePosterPosition(100, 120).margin_v_px).toBe(470);
    expect(resolvePosterPosition(116, 139).margin_v_px).toBe(462);
  });

  it("computes horizontal bounds strictly inside the 80px side safe zones", () => {
    const bounds = resolveHorizontalBounds(920);
    expect(bounds).toMatchObject({ left_x: 80, right_x: 1000, within_safe_zone: true });
    expect(resolveHorizontalBounds(921).within_safe_zone).toBe(false);
  });

  it("pins the artwork geometry to the issue's constants", () => {
    expect(LYRIC_ARTWORK_RECT).toMatchObject({ y: 320, height: 1080 });
    expect(LYRIC_BOUNDARY_Y).toBe(1400);
    expect(LYRIC_FRAME).toMatchObject({ width: 1080, height: 1920 });
  });
});

describe("Issue 36 glyph-advance measurement (hostile Latin)", () => {
  // Hostile Latin probes for the retired 0.5em-per-Latin model: wide caps
  // (W/M ~0.9em), narrow letters (i/l ~0.25em), ambiguous-height glyphs,
  // ellipsis and em-dash runs.
  const HOSTILE_LATIN = [
    "WWWWWWWWWW", "MMMMMMMMMM", "AVATARWORLD", "iiiiiiiiii", "llllllllll",
    "l1Il1Il1I", "!!!!!!!!!!", "?????????", "......", "———", "……",
  ] as const;

  it("measures from the resolved font binary, not the 0.5em estimate", () => {
    const plan = planLyricTypography({
      lyrics: [
        // 8 W's: ~0.914em each on the bundled bold face; the naive model
        // would claim 400px and call it safe.
        { text: "WWWWWWWW", startSec: 0, endSec: 2 },
        { text: "iiiiiiiiii", startSec: 2, endSec: 4 },
      ],
      probe: fakeProbe("available", "probe"),
    });
    expect(plan.measurement.method).toBe("glyph_advance/v1");
    expect(plan.violations).toEqual([]);
    const wide = plan.cues[0].lines![0].measured_width_px;
    const narrow = plan.cues[1].lines![0].measured_width_px;
    expect(wide).toBeGreaterThan(700);
    expect(narrow).toBeLessThan(450);
    expect(wide).toBeGreaterThan(narrow * 2);
  });

  it("keeps every hostile string inside the safe zone or fails closed", () => {
    for (const text of HOSTILE_LATIN) {
      const plan = planLyricTypography({
        lyrics: [{ text, startSec: 0, endSec: 2 }],
        probe: fakeProbe("available", "probe"),
      });
      if (plan.violations.length > 0) {
        expect(plan.violations.some((v) => v.code === "safe_width")).toBe(true);
      } else {
        for (const cue of plan.cues) {
          expect(cue.position.within_safe_zone).toBe(true);
          for (const line of cue.lines ?? []) {
            expect(line.fits_safe_width).toBe(true);
            expect(line.ink_width_px).toBeGreaterThanOrEqual(line.measured_width_px);
          }
        }
      }
    }
  });

  it("includes outline and glow blur in the ink width", () => {
    const plan = planLyricTypography({
      lyrics: [{ text: "光の中へ", startSec: 0, endSec: 2 }],
      sections: [{ role: "chorus", startSec: 0, endSec: 4 }],
      probe: fakeProbe("available", "probe"),
    });
    expect(plan.violations).toEqual([]);
    const line = plan.cues[0].lines![0];
    // chorus: outline 5 + glow blur 5 per side -> 20px ink padding
    expect(line.ink_width_px - line.measured_width_px).toBeGreaterThanOrEqual(19.9);
    expect(line.fits_safe_width).toBe(true);
  });

  it("keeps CJK at one em per glyph with real measurement", () => {
    const plan = planLyricTypography({
      lyrics: [{ text: "夜々々々", startSec: 0, endSec: 2 }],
      probe: fakeProbe("available", "probe"),
    });
    const line = plan.cues[0].lines![0];
    expect(line.measured_width_px).toBeCloseTo(400, 0);
  });
});

describe("Issue 36 kinetic staccato", () => {
  it("emits one character per back-to-back slot exactly covering the line", () => {
    const expansion = expandKineticStaccato("右左橋坂息", 16, 18, {});
    expect(expansion.chars).toHaveLength(5);
    expect(expansion.chars.map((c) => c.char)).toEqual(["右", "左", "橋", "坂", "息"]);
    expect(expansion.chars[0].start_sec).toBe(16);
    expect(expansion.chars[4].end_sec).toBe(18);
    for (let i = 1; i < expansion.chars.length; i += 1) {
      expect(expansion.chars[i].start_sec).toBe(expansion.chars[i - 1].end_sec);
    }
    expect(expansion.chars.every((c) => c.font_size_px === 120)).toBe(true);
    expect(expansion.chars.every((c) => c.measured_width_px <= LYRIC_SAFE_WIDTH_PX)).toBe(true);
  });

  it("bounds every character slot including the final hold", () => {
    const expansion = expandKineticStaccato("左右", 10, 20, { maxPerCharSec: 0.5 });
    for (const char of expansion.chars) {
      // the final character may no longer absorb the whole remainder
      expect(char.end_sec - char.start_sec).toBeLessThanOrEqual(0.5);
    }
    expect(expansion.chars[0].start_sec).toBe(10);
    expect(expansion.chars[expansion.chars.length - 1].end_sec).toBeLessThanOrEqual(11);
  });

  it("supports an explicit final-hold cap and a reduced-motion static card", () => {
    const capped = expandKineticStaccato("右左橋坂息", 0, 10, { maxPerCharSec: 0.4, maxHoldSec: 0.2 });
    const duration = (c: { start_sec: number; end_sec: number }) => Math.round((c.end_sec - c.start_sec) * 1000) / 1000;
    expect(capped.chars.every((c) => duration(c) <= 0.4)).toBe(true);
    const last = capped.chars[capped.chars.length - 1];
    expect(duration(last)).toBeLessThanOrEqual(0.2);
    const reduced = expandKineticStaccato("右左橋坂息", 3, 7, { reducedMotion: true });
    expect(reduced.chars).toHaveLength(1);
    expect(reduced.chars[0]).toMatchObject({ char: "右左橋坂息", start_sec: 3, end_sec: 7 });
  });
});

describe("Issue 36 font capability receipts", () => {
  it("reports native only when the probe verified the installed family binary", () => {
    // a real (synthesized) binary whose name table contains the family is
    // REQUIRED: an "available" claim without a binary cannot bind rendering
    const dir = mkdtempSync(path.join(tmpdir(), "vos-font-bind-"));
    try {
      const binaryPath = path.join(dir, "Hiragino.ttf");
      writeFileSync(binaryPath, makeSfntWithFamily("Hiragino Mincho ProN"));
      const resolution = resolveLyricFont(
        { requestedFamily: "Hiragino Mincho ProN", fallbackFamily: "VideoOS Noto Sans JP Bold" },
        () => ({ capability: "available", detail: "fixture binary", filePath: binaryPath }),
      );
      expect(resolution).toMatchObject({
        requested_family: "Hiragino Mincho ProN",
        resolved_family: "Hiragino Mincho ProN",
        capability: "native",
        fallback_used: false,
        render_binding: "binary_bound",
      });
      expect(resolution.font_path).toBe(binaryPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("downgrades to an explicit degraded bundled binding without a binary", () => {
    // "available" claimed WITHOUT a filePath: rendering could not be bound
    // to the native face, so the bundled face is used and recorded honestly.
    const resolution = resolveLyricFont(
      { requestedFamily: "Hiragino Sans W8", fallbackFamily: ASS_HEAVY_VIDEO_FONT.family },
      fakeProbe("available", "fontconfig hit without a file"),
    );
    expect(resolution.capability).toBe("bundled_fallback");
    expect(resolution.fallback_used).toBe(true);
    expect(resolution.render_binding).toBe("degraded");
    expect(resolution.resolved_family).toBe(ASS_HEAVY_VIDEO_FONT.family);
    expect(resolution.reason).toContain("could not be bound");
    expect(resolution.reason).toContain("bundled face");
    expect(resolution.font_path).toBeTruthy();
  });

  it("fails open to the bundled face when the probe cannot determine", () => {
    const resolution = resolveLyricFont(
      { requestedFamily: "Hiragino Mincho ProN W6", fallbackFamily: "VideoOS Noto Sans JP Black" },
      fakeProbe("unknown", "fontconfig unavailable"),
    );
    expect(resolution.capability).toBe("bundled_fallback");
    expect(resolution.render_binding).toBe("degraded");
    expect(resolution.reason).toContain("could not be bound");
    expect(resolution.reason).toContain("fontconfig unavailable");
  });

  it("fails open when the probe itself throws", () => {
    const resolution = resolveLyricFont(
      { requestedFamily: "Hiragino Mincho ProN", fallbackFamily: "VideoOS Noto Sans JP Bold" },
      () => {
        throw new Error("probe exploded");
      },
    );
    expect(resolution.capability).toBe("bundled_fallback");
    expect(resolution.reason).toContain("probe exploded");
  });
});

describe("Issue 36 canonical plan", () => {
  const baseLyrics = [
    { text: "// mixer note", startSec: 0, endSec: 2 },
    { text: "[Aメロ]", startSec: 2, endSec: 2.01 },
    { text: "夜の靄が静かに降りてくる", startSec: 2, endSec: 6 },
    { text: "[Chorus glow=amber]", startSec: 6, endSec: 6.01 },
    { text: "（BGM）", startSec: 6, endSec: 7 },
    { text: "光の中へ 君と走る", startSec: 7, endSec: 11 },
    { text: "[Punk]", startSec: 11, endSec: 11.01 },
    { text: "右左橋坂息", startSec: 11, endSec: 13 },
  ];

  it("produces a schema-valid plan with sanitized cues and no violations", () => {
    const plan = planLyricTypography({ lyrics: baseLyrics, probe: fakeProbe("unavailable", "ci") });
    const validation = validateAgainstSchema(JSON.parse(JSON.stringify(plan)), "lyric-typography-plan.schema.json");
    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);
    expect(plan.violations).toEqual([]);
    // metadata never becomes a cue
    expect(plan.cues.every((cue) => !/BGM|mixer|Aメロ|Chorus|Punk/.test(cue.sanitized_text))).toBe(true);
    expect(plan.removed_metadata.map((entry) => entry.reason)).toEqual([
      "metadata-only line: // mixer note",
      "section tag line",
      "section tag line",
      "metadata-only line: （BGM）",
      "section tag line",
    ]);
  });

  it("switches style, size, and glow per section attribute", () => {
    const plan = planLyricTypography({ lyrics: baseLyrics, probe: fakeProbe("available", "probe") });
    const verse = plan.cues.find((cue) => cue.section_role === "verse");
    const chorus = plan.cues.find((cue) => cue.section_role === "chorus");
    const punk = plan.cues.find((cue) => cue.section_role === "punk");
    expect(verse?.style_name).toBe("LyricVerse");
    expect(chorus?.style_name).toBe("LyricChorus");
    expect(chorus?.glow_color).toBe("amber");
    expect(punk?.style_name).toBe("LyricPunk");
    expect(chorus?.lines?.[0]?.font_size_px).toBe(116);
    expect(verse?.lines?.[0]?.font_size_px).toBe(100);
    expect(punk?.chars?.every((c) => c.font_size_px === 120)).toBe(true);
  });

  it("measures every cue inside the safe zone and crossing the boundary", () => {
    const plan = planLyricTypography({ lyrics: baseLyrics, probe: fakeProbe("available", "probe") });
    for (const cue of plan.cues) {
      if (cue.kind === "two_tier") {
        expect(cue.position.within_safe_zone).toBe(true);
        expect(cue.position.crosses_boundary).toBe(true);
        for (const line of cue.lines ?? []) {
          expect(line.measured_width_px).toBeLessThanOrEqual(LYRIC_SAFE_WIDTH_PX);
          expect(line.fits_safe_width).toBe(true);
        }
      } else {
        expect(cue.position.within_safe_zone).toBe(true);
      }
    }
  });

  it("lets explicit timed sections override lyric tags", () => {
    const plan = planLyricTypography({
      lyrics: [
        { text: "[Chorus] タグは無視される", startSec: 0, endSec: 4 },
      ],
      sections: [{ role: "verse", startSec: 0, endSec: 100 }],
      probe: fakeProbe("available", "probe"),
    });
    expect(plan.cues).toHaveLength(1);
    expect(plan.cues[0].section_role).toBe("verse");
    expect(plan.cues[0].glow_color).toBeUndefined();
  });

  it("suppresses cues inside instrumental ranges", () => {
    const plan = planLyricTypography({
      lyrics: [{ text: "歌じゃない", startSec: 0, endSec: 4 }],
      sections: [{ role: "instrumental", startSec: 0, endSec: 100 }],
      probe: fakeProbe("available", "probe"),
    });
    expect(plan.cues).toHaveLength(0);
  });

  it("reports invalid timing and unknown tags as violations", () => {
    const plan = planLyricTypography({
      lyrics: [
        // standalone unknown tag: removed, reported, never rendered
        { text: "[Mystery]", startSec: 0, endSec: 2 },
        { text: "逆転している", startSec: 5, endSec: 4 },
      ],
      probe: fakeProbe("available", "probe"),
    });
    expect(plan.violations.map((v) => v.code).sort()).toEqual(["invalid_timing", "unknown_section_tag"]);
    expect(plan.cues.some((cue) => cue.sanitized_text.includes("Mystery"))).toBe(false);
  });

  it("normalizes more than two authored lines into two tiers without loss", () => {
    const plan = planLyricTypography({
      lyrics: [
        { text: "夜の靄が\n静かに\n降りてくる", startSec: 0, endSec: 4 },
      ],
      probe: fakeProbe("available", "probe"),
    });
    expect(plan.violations).toEqual([]);
    expect(plan.cues).toHaveLength(1);
    const lines = plan.cues[0].lines!;
    expect(lines).toHaveLength(2);
    // no characters dropped: the joined sub tier preserves every authored line
    expect(lines[0].text).toBe("夜の靄が");
    expect(lines[1].text).toBe("静かに降りてくる");
  });
});

// ── System font probe (name-table verification) ──────────────────────────

/** Minimal sfnt (TTF) with a single UTF-16BE family name record. */
function makeSfntWithFamily(family: string): Buffer {
  const familyUtf16 = Buffer.from(family, "utf16le").swap16();
  const nameHeader = Buffer.alloc(6);
  nameHeader.writeUInt16BE(0, 0); // format
  nameHeader.writeUInt16BE(1, 2); // one record
  nameHeader.writeUInt16BE(6 + 12, 4); // string storage offset
  const record = Buffer.alloc(12);
  record.writeUInt16BE(3, 0); // Windows platform
  record.writeUInt16BE(1, 2); // UTF-16
  record.writeUInt16BE(0x409, 4); // en-US
  record.writeUInt16BE(1, 6); // name ID 1 = family
  record.writeUInt16BE(familyUtf16.length, 8);
  record.writeUInt16BE(0, 10);
  const nameTable = Buffer.concat([nameHeader, record, familyUtf16]);
  const header = Buffer.alloc(12);
  header.writeUInt32BE(0x00010000, 0);
  header.writeUInt16BE(1, 4); // numTables
  const dir = Buffer.alloc(16);
  dir.write("name", 0, "latin1");
  dir.writeUInt32BE(0, 4);
  dir.writeUInt32BE(28, 8); // table offset
  dir.writeUInt32BE(nameTable.length, 12);
  return Buffer.concat([header, dir, nameTable]);
}

/** Minimal TTC wrapping one sfnt. */
function makeTtcWithFamily(family: string): Buffer {
  const font = makeSfntWithFamily(family);
  const header = Buffer.alloc(12);
  header.write("ttcf", 0, "latin1");
  header.writeUInt32BE(0x00010000, 4);
  header.writeUInt32BE(1, 8); // numFonts
  const offset = Buffer.alloc(4);
  offset.writeUInt32BE(16, 0);
  return Buffer.concat([header, offset, font]);
}

describe("system font probe honesty", () => {
  it("confirms a family only via the real name table", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vos-font-probe-"));
    try {
      writeFileSync(path.join(dir, "Test Mincho.ttf"), makeSfntWithFamily("Test Mincho"));
      resetFontProbeCaches();
      const hit = probeInstalledFontFamily("Test Mincho", { searchPaths: [dir], skipFontconfig: true, noCache: true });
      expect(hit.capability).toBe("available");
      expect(hit.source).toBe("font_name_table");
      const miss = probeInstalledFontFamily("Test Gothic", { searchPaths: [dir], skipFontconfig: true, noCache: true });
      expect(miss.capability).toBe("unavailable");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("supports TTC collections and normalizes family matching", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vos-font-probe-"));
    try {
      writeFileSync(path.join(dir, "Collection.ttc"), makeTtcWithFamily("Hiragino Fake Sans W8"));
      resetFontProbeCaches();
      const result = probeInstalledFontFamily("hiragino  fake sans  W8", { searchPaths: [dir], skipFontconfig: true, noCache: true });
      expect(result.capability).toBe("available");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats malformed font binaries as not-available instead of crashing", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vos-font-probe-"));
    try {
      writeFileSync(path.join(dir, "broken.ttf"), Buffer.from("not a font at all"));
      resetFontProbeCaches();
      const result = probeInstalledFontFamily("Broken Family", { searchPaths: [dir], skipFontconfig: true, noCache: true });
      expect(["unavailable", "unknown"]).toContain(result.capability);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads family names from the bundled repo font binary", () => {
    const names = readFontFamilyNames(resolveBundledFontPaths().fontPath);
    expect(names).toContain("noto sans jp");
  });

  it("normalizes width variants for family comparison", () => {
    expect(normalizeFontFamily("Ｈｉｒａｇｉｎｏ   Mincho ")).toBe("hiragino mincho");
  });
});
