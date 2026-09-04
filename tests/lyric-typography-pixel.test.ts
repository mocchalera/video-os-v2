import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  LYRIC_SAFE_WIDTH_PX,
  buildLyricAssDocument,
  planLyricTypography,
} from "../runtime/caption/lyric-typography.js";
import { resolveBundledFontPaths } from "../runtime/fonts/bundled-font.js";

function hasBinary(binary: string): boolean {
  try {
    execFileSync(binary, ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const HAS_FFMPEG = hasBinary("ffmpeg");

/**
 * Sol-audit pixel proof: the measured width, the safe-zone decision, and the
 * ACTUAL libass-rendered pixels must agree. The binding is forced to the
 * bundled face end-to-end (probe -> measurement -> ASS style name ->
 * fontsdir), so libass can only resolve the exact binary we measured.
 */
describe("Issue 36 rendered-pixel 80px safe-zone proof (real ffmpeg)", () => {
  it("plans, breaks, and burns the FULL audited hostile string with ZERO ink in both 80px bands", { timeout: 120_000 }, () => {
    if (!HAS_FFMPEG) {
      throw new Error("ffmpeg is required for the rendered-pixel safe-zone proof");
    }
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "lyric-pixel-"));
    try {
      // The exact audited hostile string, 11 W's — the case the retired
      // 0.5em model measured at 668px "safe". It goes through NORMAL
      // production planning: the reduced-motion card overflows the bound
      // measurement, so the planner line-breaks and auto-scales it into two
      // measured tiers instead of shipping an overflowing card. No shorter
      // substitute is used anywhere in this test.
      const HOSTILE = "WWWWWWWWWWW";
      const plan = planLyricTypography({
        lyrics: [
          { text: "[Punk]", startSec: 0, endSec: 0.01 },
          { text: HOSTILE, startSec: 0.02, endSec: 4 },
        ],
        reducedMotion: true,
        // force the bundled binding so the measured binary, the ASS family,
        // and the fontsdir handed to libass are provably the same face
        probe: () => ({ capability: "unavailable", detail: "forced bundled binding for pixel test" }),
      });
      expect(plan.violations).toEqual([]);
      expect(plan.fonts.punk.render_binding).toBe("degraded");
      expect(plan.fonts.punk.font_path).toBe(resolveBundledFontPaths().assHeavyFontPath);
      expect(plan.fonts.punk.face_index).toBe(0);
      expect(plan.fonts.punk.postscript_name).toBeTruthy();
      expect(plan.fonts.punk.font_sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
      // the hostile card was auto-broken into a measured two-tier cue
      const cue = plan.cues[0];
      expect(cue.kind).toBe("two_tier");
      expect(cue.lines).toHaveLength(2);
      expect(cue.lines!.map((l) => l.text).join("")).toBe(HOSTILE); // no loss
      for (const line of cue.lines!) {
        expect(line.fits_safe_width).toBe(true);
        expect(line.ink_width_px).toBeLessThanOrEqual(LYRIC_SAFE_WIDTH_PX);
      }
      expect(cue.position.within_safe_zone).toBe(true);

      const assPath = path.join(workDir, "lyrics.ass");
      const ass = buildLyricAssDocument(plan);
      // the styles libass will match are the families verified in the binary
      expect(ass).toContain(`Style: LyricPunk,VideoOS Noto Sans JP Black,`);
      fs.writeFileSync(assPath, ass, "utf8");

      // production compositor filter: one encode, fontsdir = the staged dir
      const fontsDir = resolveBundledFontPaths().fontsDir;
      const burnedPath = path.join(workDir, "burned.mp4");
      execFileSync("ffmpeg", [
        "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", `color=c=black:s=1080x1920:r=30:d=2`,
        "-vf", `subtitles=filename='${assPath}':fontsdir='${fontsDir}'`,
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        burnedPath,
      ], { stdio: "pipe" });

      // extract a mid-cue frame as raw gray (BT.601 limited range: black=16)
      const framePath = path.join(workDir, "frame.raw");
      execFileSync("ffmpeg", [
        "-y", "-hide_banner", "-loglevel", "error",
        "-ss", "1", "-i", burnedPath,
        "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray",
        framePath,
      ], { stdio: "pipe" });

      const frame = fs.readFileSync(framePath);
      expect(frame.length).toBe(1080 * 1920);
      const bandMax = (from: number, to: number): number => {
        let max = 0;
        for (let y = 0; y < 1920; y += 1) {
          for (let x = from; x < to; x += 1) {
            const value = frame[y * 1080 + x];
            if (value > max) max = value;
          }
        }
        return max;
      };
      // THE assertion: zero ink in the left/right 80px safe bands
      const leftBand = bandMax(0, 80);
      const rightBand = bandMax(1000, 1080);
      expect(leftBand).toBeLessThanOrEqual(24);
      expect(rightBand).toBeLessThanOrEqual(24);
      // and the burn really rendered ink (guard against a vacuous pass)
      const centerMax = bandMax(400, 680);
      expect(centerMax).toBeGreaterThan(150);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("fails closed on an unbreakable reduced-motion punk line instead of overflowing", () => {
    // a string that cannot fit even the measured two-tier breaker fails
    // BEFORE rendering: the plan reports safe_width and delivery refuses.
    const plan = planLyricTypography({
      lyrics: [
        { text: "[Punk]", startSec: 0, endSec: 0.01 },
        { text: "とても長い歌詞の行は二段組みでも入りきらないので正直に違反を報告する", startSec: 0.02, endSec: 4 },
      ],
      reducedMotion: true,
      probe: () => ({ capability: "unavailable", detail: "forced bundled binding" }),
    });
    expect(plan.violations.some((v) => v.code === "safe_width")).toBe(true);
  });
});
