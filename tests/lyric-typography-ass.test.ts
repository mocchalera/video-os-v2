import { describe, expect, it } from "vitest";
import {
  LYRIC_BOUNDARY_Y,
  POSTER_MARGIN_V_RANGE,
  buildLyricAssDocument,
  planLyricTypography,
  type LyricCuePlan,
  type LyricTypographyPlan,
} from "../runtime/caption/lyric-typography.js";

// ── Independent ASS parsing helpers (adversarial: do not reuse engine logic) ──

interface ParsedDialogue {
  style: string;
  startSec: number;
  endSec: number;
  marginL: number;
  marginR: number;
  marginV: number;
  text: string;
}

function assSeconds(stamp: string): number {
  const m = stamp.match(/^(\d+):(\d{2}):(\d{2})\.(\d{2})$/);
  if (!m) throw new Error(`bad ASS timestamp: ${stamp}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 100;
}

function parseAssDialogues(ass: string): ParsedDialogue[] {
  return ass.split("\n")
    .filter((line) => line.startsWith("Dialogue:"))
    .map((line) => {
      const columns = line.slice("Dialogue:".length).trim().split(",");
      return {
        style: columns[3],
        startSec: assSeconds(columns[1]),
        endSec: assSeconds(columns[2]),
        marginL: Number(columns[5]),
        marginR: Number(columns[6]),
        marginV: Number(columns[7]),
        text: columns.slice(9).join(","),
      };
    });
}

function parseAssStyles(ass: string): Map<string, { fontFamily: string; fontSize: number; marginV: number; marginL: number; marginR: number; outline: number }> {
  const styles = new Map<string, { fontFamily: string; fontSize: number; marginV: number; marginL: number; marginR: number; outline: number }>();
  for (const line of ass.split("\n")) {
    if (!line.startsWith("Style:")) continue;
    const columns = line.slice("Style:".length).trim().split(",");
    styles.set(columns[0], {
      fontFamily: columns[1],
      fontSize: Number(columns[2]),
      outline: Number(columns[16]),
      marginL: Number(columns[19]),
      marginR: Number(columns[20]),
      marginV: Number(columns[21]),
    });
  }
  return styles;
}

/** Independent width model: full-width = 1 em, ASCII = 0.5 em (code points). */
function independentWidthPx(text: string, fontSizePx: number): number {
  let units = 0;
  for (const char of text) {
    if (/[\u0000-\u007f]/.test(char)) units += /\s/.test(char) ? 0.5 : 0.5;
    else units += 1;
  }
  return units * fontSizePx;
}

/** Visible text of a Dialogue with all ASS override blocks removed. */
function visibleText(dialogueText: string): string {
  return dialogueText
    .replace(/\\\{/g, "{")
    .replace(/\\\}/g, "}")
    .replace(/\{[^}]*\}/g, "")
    .split("\\N")
    .join("\n");
}

function visibleLines(dialogueText: string): string[] {
  return visibleText(dialogueText).split("\n");
}

function overrideFontSizes(dialogueText: string): number[] {
  return [...dialogueText.matchAll(/\\fs(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
}

const probeOf = (plan: LyricTypographyPlan) => (role: "verse" | "chorus" | "punk") => plan.fonts[role];

// ── Shared fixture ───────────────────────────────────────────────────────

const LYRICS = [
  { text: "// studio comment", startSec: 0, endSec: 1 },
  { text: "[Aメロ]", startSec: 1, endSec: 1.01 },
  { text: "夜の靄が静かに降りてくる", startSec: 1, endSec: 5 },
  { text: "長い歌詞の行は画面からはみ出すので二段へ", startSec: 5, endSec: 9 },
  { text: "壊れ{\\b1}た", startSec: 9, endSec: 10 },
  { text: "[Chorus glow=amber]", startSec: 10, endSec: 10.01 },
  { text: "（BGM）", startSec: 10, endSec: 11 },
  { text: "光の中へ 君と走る", startSec: 11, endSec: 14 },
  { text: "[Punk]", startSec: 14, endSec: 14.01 },
  { text: "右左橋坂息", startSec: 14, endSec: 16 },
];

function buildFixture(): { plan: LyricTypographyPlan; ass: string } {
  const plan = planLyricTypography({ lyrics: LYRICS, probe: () => ({ capability: "available", detail: "fixture" }) });
  return { plan, ass: buildLyricAssDocument(plan) };
}

describe("Issue 36 ASS render output", () => {
  const { plan, ass } = buildFixture();

  it("pins PlayRes to the lyric frame and disables auto re-wrap", () => {
    expect(ass).toContain("PlayResX: 1080");
    expect(ass).toContain("PlayResY: 1920");
    expect(ass).toContain("WrapStyle: 2");
    expect(ass).toContain("ScaledBorderAndShadow: yes");
  });

  it("declares one style per section with the capability-resolved family", () => {
    const styles = parseAssStyles(ass);
    expect([...styles.keys()].sort()).toEqual(["LyricChorus", "LyricPunk", "LyricVerse"]);
    expect(styles.get("LyricVerse")?.fontFamily).toBe(probeOf(plan)("verse").resolved_family);
    expect(styles.get("LyricChorus")?.fontFamily).toBe(probeOf(plan)("chorus").resolved_family);
    expect(styles.get("LyricPunk")?.fontFamily).toBe(probeOf(plan)("punk").resolved_family);
    expect(styles.get("LyricVerse")?.fontSize).toBe(100);
    expect(styles.get("LyricChorus")?.fontSize).toBe(116);
    expect(styles.get("LyricPunk")?.fontSize).toBe(120);
    // side safe zones are enforced by style margins
    for (const style of styles.values()) {
      expect(style.marginL).toBe(80);
      expect(style.marginR).toBe(80);
    }
    // poster boundary-cross margins live inside the issue's band
    expect(styles.get("LyricVerse")?.marginV).toBeGreaterThanOrEqual(POSTER_MARGIN_V_RANGE.min);
    expect(styles.get("LyricVerse")?.marginV).toBeLessThanOrEqual(POSTER_MARGIN_V_RANGE.max);
    expect(styles.get("LyricChorus")?.marginV).toBeGreaterThanOrEqual(POSTER_MARGIN_V_RANGE.min);
    expect(styles.get("LyricChorus")?.marginV).toBeLessThanOrEqual(POSTER_MARGIN_V_RANGE.max);
  });

  it("renders zero metadata: every Dialogue is pure lyric text", () => {
    const dialogues = parseAssDialogues(ass);
    expect(dialogues.length).toBeGreaterThan(0);
    for (const dialogue of dialogues) {
      const text = visibleText(dialogue.text);
      expect(text).not.toMatch(/\/\/|BGM|\[Verse\]|\[Chorus\]|\[Aメロ\]|\[Punk\]|（間奏）|studio comment/);
      expect(text).not.toMatch(/^\s*$/);
    }
    // the metadata-only lines produced no Dialogue at all
    const all = dialogues.map((d) => visibleText(d.text)).join("\n");
    expect(all).not.toContain("studio comment");
    expect(all).not.toContain("BGM");
  });

  it("escapes ASS override-tag injection attempts in lyric text", () => {
    const dialogues = parseAssDialogues(ass);
    const injection = dialogues.find((d) => visibleText(d.text) === "壊れた");
    expect(injection).toBeTruthy();
    // braces and backslashes must be escaped, never parsed as override tags
    expect(injection!.text).toContain("\\{");
    expect(injection!.text).toContain("\\}");
    expect(injection!.text).toContain("\\\\b1");
  });

  it("renders main and sub tiers as separate events with per-event margins", () => {
    const dialogues = parseAssDialogues(ass).filter((d) => d.style !== "LyricPunk");
    const twoTierCues = plan.cues.filter((cue): cue is LyricCuePlan & { lines: NonNullable<LyricCuePlan["lines"]> } => cue.kind === "two_tier");
    // one main event per two-tier cue, one sub event per two-line cue
    const expectedEvents = twoTierCues.reduce((sum, cue) => sum + (cue.lines.length > 1 ? 2 : 1), 0);
    expect(dialogues.length).toBe(expectedEvents);
    for (const cue of twoTierCues) {
      const cueEvents = dialogues.filter((d) => d.style === cue.style_name
        && d.startSec === cue.start_sec && d.endSec === cue.end_sec);
      expect(cueEvents.length).toBe(cue.lines.length > 1 ? 2 : 1);
      // the MAIN event carries the main-tier margin from the plan
      const mainEvent = cueEvents[0];
      const mainMargin = Number(mainEvent.marginV);
      expect(mainMargin).toBe(Math.round(cue.position.margin_v_main_px));
      expect(mainMargin).toBeGreaterThanOrEqual(POSTER_MARGIN_V_RANGE.min);
      expect(mainMargin).toBeLessThanOrEqual(POSTER_MARGIN_V_RANGE.max);
      // and the sub event, when present, renders directly below the main tier
      if (cue.lines.length > 1) {
        const subEvent = cueEvents[1];
        expect(Number(subEvent.marginV)).toBe(Math.round(cue.position.margin_v_sub_px));
        expect(Number(subEvent.marginV)).toBeLessThan(mainMargin);
      }
      // per-event side margins keep the 80px safe zones
      for (const event of cueEvents) {
        expect(Number(event.marginL)).toBe(80);
        expect(Number(event.marginR)).toBe(80);
      }
    }
  });

  it("keeps measured two-tier bounds within the 920px safe width (re-measured independently)", () => {
    const styles = parseAssStyles(ass);
    const dialogues = parseAssDialogues(ass).filter((d) => d.style !== "LyricPunk");
    for (const dialogue of dialogues) {
      const lines = visibleLines(dialogue.text);
      expect(lines.length).toBe(1); // split events: one visible line per Dialogue
      const style = styles.get(dialogue.style)!;
      const sizes = overrideFontSizes(dialogue.text);
      const fontSize = sizes[0] ?? style.fontSize;
      expect(independentWidthPx(lines[0], fontSize)).toBeLessThanOrEqual(920);
    }
  });

  it("sizes the sub tier smaller than the main tier across the two-tier event pair", () => {
    const twoTierCues = plan.cues.filter((cue) => cue.kind === "two_tier");
    for (const cue of twoTierCues) {
      const lines = cue.lines ?? [];
      if (lines.length < 2) continue;
      const [main, sub] = lines;
      expect(main.font_size_px).toBeLessThanOrEqual(116);
      expect(main.font_size_px).toBeGreaterThanOrEqual(100);
      expect(sub.font_size_px).toBeLessThan(main.font_size_px);
      expect(sub.font_size_px).toBeGreaterThanOrEqual(75);
      // and both sizes appear in the rendered event pair
      const events = parseAssDialogues(ass)
        .filter((d) => d.style === cue.style_name && d.startSec === cue.start_sec && d.endSec === cue.end_sec)
        .map((d) => overrideFontSizes(d.text)[0]);
      expect(events).toEqual([main.font_size_px, sub.font_size_px]);
    }
  });

  it("crosses the artwork/background boundary with the MAIN tier of every composition", () => {
    for (const cue of plan.cues.filter((c) => c.kind === "two_tier")) {
      const marginMain = cue.position.margin_v_main_px;
      const subLineHeight = (cue.lines ?? []).length > 1 ? (cue.lines ?? [])[1].line_height_px : 0;
      const mainLineHeight = (cue.lines ?? [])[0].line_height_px;
      // rendered main tier: bottom edge at 1920 - marginV(main), height = main line
      const mainBottom = 1920 - marginMain;
      const mainTop = mainBottom - mainLineHeight;
      expect(mainTop).toBeLessThan(LYRIC_BOUNDARY_Y);
      expect(mainBottom).toBeGreaterThan(LYRIC_BOUNDARY_Y);
      // the main tier's em-center sits on the boundary by construction
      expect(Math.abs((mainTop + mainBottom) / 2 - (LYRIC_BOUNDARY_Y - 0.1 * (cue.lines ?? [])[0].font_size_px)))
        .toBeLessThan(1);
      // the sub event renders below the main tier, margin strictly smaller
      if (subLineHeight > 0) {
        const subBottom = 1920 - cue.position.margin_v_sub_px;
        expect(subBottom).toBeGreaterThan(mainBottom);
      }
      expect(cue.position.crosses_boundary).toBe(true);
    }
  });

  it("switches style and effect per section in the actual events", () => {
    const dialogues = parseAssDialogues(ass);
    const verse = dialogues.find((d) => d.style === "LyricVerse" && visibleText(d.text).startsWith("夜の靄が"));
    expect(verse).toBeTruthy();
    expect(verse!.text).not.toContain("\\3c");
    expect(verse!.text).not.toContain("\\blur");

    const chorus = dialogues.find((d) => d.style === "LyricChorus");
    expect(chorus).toBeTruthy();
    expect(chorus!.text).toContain("\\3c&H00BFFF&"); // amber glow BGR
    expect(chorus!.text).toContain("\\blur5");
    expect(chorus!.text).toContain("\\t(0,120,"); // bounce-in
    expect(chorus!.text).toContain("\\t(120,240,\\fscx100\\fscy100)");
    // the glow halo extends over the sub tier event too
    const chorusEvents = dialogues.filter((d) => d.style === "LyricChorus"
      && d.startSec === chorus!.startSec && d.endSec === chorus!.endSec);
    expect(chorusEvents.length).toBe(2);
    expect(chorusEvents[1].text).toContain("\\3c&H00BFFF&");
    expect(chorusEvents[1].text).not.toContain("\\t("); // bounce stays main-only

    const punk = dialogues.filter((d) => d.style === "LyricPunk");
    expect(punk.map((d) => visibleText(d.text))).toEqual(["右", "左", "橋", "坂", "息"]);
    for (const dialogue of punk) {
      expect(dialogue.text).toContain("\\an5\\pos(540,960)");
    }
  });

  it("covers the staccato line back-to-back with one Dialogue per character", () => {
    const punk = parseAssDialogues(ass).filter((d) => d.style === "LyricPunk");
    expect(punk).toHaveLength(5);
    expect(punk[0].startSec).toBe(14);
    expect(punk[punk.length - 1].endSec).toBe(16);
    for (let i = 1; i < punk.length; i += 1) {
      expect(punk[i].startSec).toBe(punk[i - 1].endSec);
    }
    for (const dialogue of punk) {
      expect(dialogue.endSec - dialogue.startSec).toBeLessThanOrEqual(0.5);
      expect(visibleText(dialogue.text)).toHaveLength(1);
    }
  });

  it("drops bounce and staccato flicker under reduced motion while keeping text and timing", () => {
    const reducedPlan = planLyricTypography({
      lyrics: LYRICS,
      probe: () => ({ capability: "available", detail: "fixture" }),
      reducedMotion: true,
    });
    const reducedAss = buildLyricAssDocument(reducedPlan);
    const chorus = parseAssDialogues(reducedAss).find((d) => d.style === "LyricChorus");
    expect(chorus).toBeTruthy();
    expect(chorus!.text).not.toContain("\\t(");
    expect(chorus!.text).toContain("\\3c&H00BFFF&"); // glow is style, not motion
    // staccato collapses to ONE static Dialogue (no per-character flicker)
    const punk = parseAssDialogues(reducedAss).filter((d) => d.style === "LyricPunk");
    expect(punk).toHaveLength(1);
    expect(visibleText(punk[0].text)).toBe("右左橋坂息");
    expect(punk[0].startSec).toBe(14);
    expect(punk[0].endSec).toBe(16);
    expect(punk[0].text).not.toContain("\\t(");
    expect(punk[0].text).toContain("\\an5\\pos(540,960)");
  });

  it("resolves fonts honestly: on macOS the Hiragino pairing is native, elsewhere bundled fallback", () => {
    // REAL probe + binding: the style names libass will match must be the
    // families verified inside the measured binaries.
    const realPlan = planLyricTypography({ lyrics: LYRICS });
    for (const role of ["verse", "chorus", "punk"] as const) {
      const font = realPlan.fonts[role];
      if (process.platform === "darwin") {
        expect(font.capability).toBe("native");
        expect(font.fallback_used).toBe(false);
        expect(font.resolved_family).toBe(font.requested_family);
        expect(font.render_binding).toBe("binary_bound");
        expect(font.font_path).toBeTruthy();
      } else {
        expect(font.capability).toBe("bundled_fallback");
        expect(font.fallback_used).toBe(true);
        expect(font.resolved_family).not.toBe(font.requested_family);
        expect(font.render_binding).toBe("degraded");
        expect(font.reason).toBeTruthy();
      }
    }
    const styles = parseAssStyles(buildLyricAssDocument(realPlan));
    for (const role of ["verse", "chorus", "punk"] as const) {
      const styleName = role === "verse" ? "LyricVerse" : role === "chorus" ? "LyricChorus" : "LyricPunk";
      // the rendered style family == the receipt family == the measured binary
      expect(styles.get(styleName)?.fontFamily).toBe(realPlan.fonts[role].resolved_family);
    }
  });
});
