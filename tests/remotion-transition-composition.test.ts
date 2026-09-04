// Issue #34 — composition-level Remotion transition tests (real renderer)
//
// These render the production VideoTimeline composition through the real
// Remotion pipeline (bundle → headless Chrome → renderMedia) and probe the
// rendered pixels with ffmpeg. Unit-level preset tests cannot catch frame
// timing regressions, so every window here starts at a NONZERO absolute
// frame (9): if useCurrentFrame()'s Sequence-local offset were subtracted
// again against the absolute windowStart, progress would be pinned to 0
// for the whole window and these tests would fail.
//
// The Remotion window geometry (resolveTransitionWindow), the compiler's
// recorded provenance [flash_start, flash_peak, flash_end], and the ffmpeg
// filtergraph envelope are asserted to agree by the dedicated agreement
// test in transition-preset-render.test.ts.

import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { ingestAsset } from "../runtime/connectors/ffprobe.js";
import { renderRemotionAssembly } from "../runtime/render/remotion/index.js";

const execFileAsync = promisify(execFile);

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function ffmpeg(args: string[]): Buffer {
  return execFileSync("ffmpeg", ["-v", "error", ...args], { maxBuffer: 100 * 1024 * 1024 });
}

function framePixel(output: string, frame: number): string {
  return ffmpeg([
    "-i", output,
    "-vf", `select=eq(n\\,${frame}),format=rgb24,crop=1:1:32:16`,
    "-frames:v", "1", "-f", "rawvideo", "-",
  ]).toString("hex");
}

function pixelChannels(pixel: string): number[] {
  return [0, 2, 4].map((offset) => Number.parseInt(pixel.slice(offset, offset + 2), 16), 10);
}

const FPS = 24;
// Hostile geometry: the transition window sits at NONZERO absolute frames.
// Blend window [9,15), seam (chorus head) = 15, flash decay tail [15,21).
const WINDOW_START = 9;
const OVERLAP = 6;
const SEAM = WINDOW_START + OVERLAP; // 15
const FLASH_END = SEAM + OVERLAP; // 21
const B_FRAMES = 30; // post-overlap: [9, 39)

interface Fixture {
  projectDir: string;
  redAssetId: string;
  blueAssetId: string;
  redPath: string;
  bluePath: string;
}

async function makeColorFixture(): Promise<Fixture> {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-remotion-composition-"));
  dirs.push(projectDir);
  const redPath = path.join(projectDir, "red.mp4");
  const bluePath = path.join(projectDir, "blue.mp4");
  ffmpeg(["-f", "lavfi", "-i", "color=c=red:s=64x32:r=24:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", redPath]);
  ffmpeg(["-f", "lavfi", "-i", "color=c=blue:s=64x32:r=24:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", bluePath]);
  const red = await ingestAsset(redPath, { projectRoot: projectDir, mediaKind: "video", ffmpegVersion: "test" });
  const blue = await ingestAsset(bluePath, { projectRoot: projectDir, mediaKind: "video", ffmpegVersion: "test" });
  fs.mkdirSync(path.join(projectDir, "02_media"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "02_media/source_map.json"), JSON.stringify({
    version: "1", project_id: "remotion-composition", media_dir: "02_media", generated_at: "2026-08-29T00:00:00Z",
    items: [
      { asset_id: red.asset_id, source_locator: redPath, local_source_path: redPath, link_path: "red.mp4", media_kind: "video" },
      { asset_id: blue.asset_id, source_locator: bluePath, local_source_path: bluePath, link_path: "blue.mp4", media_kind: "video" },
    ],
  }));
  fs.mkdirSync(path.join(projectDir, "03_analysis"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "03_analysis/assets.json"), JSON.stringify({ items: [red, blue] }));
  fs.mkdirSync(path.join(projectDir, "05_timeline"), { recursive: true });
  return { projectDir, redAssetId: red.asset_id, blueAssetId: blue.asset_id, redPath, bluePath };
}

async function makePatternFixture(): Promise<Fixture> {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-remotion-composition-"));
  dirs.push(projectDir);
  const redPath = path.join(projectDir, "a.mp4");
  const bluePath = path.join(projectDir, "b.mp4");
  // Visually complex sources so a gaussian blur provably changes pixels.
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=64x32:r=24:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", redPath]);
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=64x32:r=24:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", bluePath]);
  const red = await ingestAsset(redPath, { projectRoot: projectDir, mediaKind: "video", ffmpegVersion: "test" });
  const blue = await ingestAsset(bluePath, { projectRoot: projectDir, mediaKind: "video", ffmpegVersion: "test" });
  fs.mkdirSync(path.join(projectDir, "02_media"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "02_media/source_map.json"), JSON.stringify({
    version: "1", project_id: "remotion-composition", media_dir: "02_media", generated_at: "2026-08-29T00:00:00Z",
    items: [
      { asset_id: red.asset_id, source_locator: redPath, local_source_path: redPath, link_path: "a.mp4", media_kind: "video" },
      { asset_id: blue.asset_id, source_locator: bluePath, local_source_path: bluePath, link_path: "b.mp4", media_kind: "video" },
    ],
  }));
  fs.mkdirSync(path.join(projectDir, "03_analysis"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "03_analysis/assets.json"), JSON.stringify({ items: [red, blue] }));
  fs.mkdirSync(path.join(projectDir, "05_timeline"), { recursive: true });
  return { projectDir, redAssetId: red.asset_id, blueAssetId: blue.asset_id, redPath, bluePath };
}

/**
 * Post-overlap timeline authored directly: A [0,24), B head-extended
 * [9,39) whose ORIGINAL content starts at the seam frame 15 (the chorus
 * head). The transition window starts at absolute frame 9 — deliberately
 * nonzero so a double-subtracted windowStart cannot pass.
 */
function makeTimeline(fixture: Fixture, transitionType: string): Record<string, unknown> {
  return {
    version: "1", project_id: "remotion-composition", created_at: "2026-08-29T00:00:00Z",
    sequence: { name: "main", fps_num: FPS, fps_den: 1, width: 64, height: 32, start_frame: 0, letterbox_policy: "none" },
    tracks: {
      video: [{
        track_id: "V1", kind: "video",
        clips: [
          {
            clip_id: "CLP_A", segment_id: "SEG_A", asset_id: fixture.redAssetId, media_kind: "video",
            src_in_us: 0, src_out_us: 1_000_000,
            timeline_in_frame: 0, timeline_duration_frames: WINDOW_START + OVERLAP,
            role: "hero", motivation: "verse", beat_id: "b01",
            fallback_segment_ids: [], confidence: 1, quality_flags: [],
          },
          {
            clip_id: "CLP_B", segment_id: "SEG_B", asset_id: fixture.blueAssetId, media_kind: "video",
            src_in_us: (SEAM - OVERLAP) * 1_000_000 / FPS, src_out_us: 2_000_000,
            timeline_in_frame: WINDOW_START, timeline_duration_frames: B_FRAMES,
            role: "hero", motivation: "chorus", beat_id: "b02",
            fallback_segment_ids: [], confidence: 1, quality_flags: [],
          },
        ],
      }],
      audio: [],
    },
    markers: [],
    transitions: [{
      transition_id: "tr_0000",
      from_clip_id: "CLP_A",
      to_clip_id: "CLP_B",
      track_id: "V1",
      transition_type: transitionType,
      transition_frames: OVERLAP,
      start_frame: WINDOW_START,
      duration_frames: OVERLAP,
      transition_params: { crossfade_sec: OVERLAP / FPS, easing: "linear" },
    }],
    provenance: { brief_path: "", blueprint_path: "", selects_path: "", compiler_version: "test" },
  };
}

const sharedBundleDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-remotion-composition-bundle-"));
dirs.push(sharedBundleDir);

async function renderViaRemotion(fixture: Fixture, timeline: Record<string, unknown>, name: string): Promise<string> {
  const timelinePath = path.join(fixture.projectDir, "05_timeline/timeline.json");
  fs.writeFileSync(timelinePath, JSON.stringify(timeline));
  const output = path.join(fixture.projectDir, `05_timeline/${name}.mp4`);
  await renderRemotionAssembly({
    timelinePath,
    sourceMap: { [fixture.redAssetId]: fixture.redPath, [fixture.blueAssetId]: fixture.bluePath },
    outputPath: output,
    bundleCacheDir: sharedBundleDir,
  });
  return output;
}

describe("Issue #34 Remotion composition-level transitions (real renderer, nonzero absolute start)", () => {
  it("film_crossfade traverses progress 0→1 through the outer Sequence", async () => {
    const fixture = await makeColorFixture();
    const output = await renderViaRemotion(fixture, makeTimeline(fixture, "film_crossfade"), "film");

    // Before the window: pure red (clip A).
    const pre = pixelChannels(framePixel(output, WINDOW_START - 1));
    expect(pre[0]).toBeGreaterThan(200);
    expect(pre[2]).toBeLessThan(60);

    // Window start: progress 0 — A fully opaque. If the Sequence-local
    // frame were subtracted against the absolute windowStart, progress
    // would stay 0 for the ENTIRE window and frame 14 would still be red.
    const start = pixelChannels(framePixel(output, WINDOW_START));
    expect(start[0]).toBeGreaterThan(200);
    expect(start[2]).toBeLessThan(60);

    // Mid-window: a true blend — both colors present.
    const mid = pixelChannels(framePixel(output, WINDOW_START + 3));
    expect(mid[0]).toBeGreaterThan(60);
    expect(mid[2]).toBeGreaterThan(60);

    // Last blend frame: progress 1 — pure blue (clip B).
    const end = pixelChannels(framePixel(output, WINDOW_START + OVERLAP - 1));
    expect(end[2]).toBeGreaterThan(200);
    expect(end[0]).toBeLessThan(60);

    // After the window: blue.
    const post = pixelChannels(framePixel(output, WINDOW_START + OVERLAP + 1));
    expect(post[2]).toBeGreaterThan(200);
    expect(post[0]).toBeLessThan(60);
  }, 300_000);

  it("dreamy_focus_blur blurs only the window interior at hostile nonzero start", async () => {
    const fixture = await makePatternFixture();
    const film = await renderViaRemotion(fixture, makeTimeline(fixture, "film_crossfade"), "pattern-film");
    const dreamy = await renderViaRemotion(fixture, makeTimeline(fixture, "dreamy_focus_blur"), "pattern-blur");

    // Per-frame mean absolute RGB delta between the unstyled (film) render
    // and the dreamy render. A zero-strength CSS blur still rasterizes
    // through a different layer path, so the envelope-0 frames keep a small
    // baseline delta (~2/255 on this pattern) — but blurred frames are an
    // order of magnitude apart.
    const fullFrame = (output: string, frame: number): Buffer =>
      ffmpeg([
        "-i", output,
        "-vf", `select=eq(n\\,${frame}),format=rgb24`,
        "-frames:v", "1", "-f", "rawvideo", "-",
      ]);
    const meanDelta = (a: Buffer, b: Buffer): number => {
      expect(a.length).toBe(b.length);
      let sum = 0;
      for (let i = 0; i < a.length; i += 1) sum += Math.abs(a[i] - b[i]);
      return sum / a.length;
    };

    // Window edges: envelope exactly 0 → visually identical to unstyled.
    expect(meanDelta(fullFrame(film, WINDOW_START), fullFrame(dreamy, WINDOW_START))).toBeLessThan(8);
    expect(meanDelta(fullFrame(film, WINDOW_START + OVERLAP - 1), fullFrame(dreamy, WINDOW_START + OVERLAP - 1))).toBeLessThan(8);
    expect(meanDelta(fullFrame(film, WINDOW_START + OVERLAP + 1), fullFrame(dreamy, WINDOW_START + OVERLAP + 1))).toBeLessThan(8);

    // Window interior: blur active → an order of magnitude apart.
    for (const frame of [WINDOW_START + 1, WINDOW_START + 2, WINDOW_START + 3, WINDOW_START + 4]) {
      expect(meanDelta(fullFrame(film, frame), fullFrame(dreamy, frame)), `frame ${frame} must be blurred`).toBeGreaterThan(15);
    }
  }, 300_000);

  it("light_leak_flash ramps to its peak exactly on the seam and decays over the declared post-seam window", async () => {
    const fixture = await makeColorFixture();
    const output = await renderViaRemotion(fixture, makeTimeline(fixture, "light_leak_flash"), "leak");

    // Before the window: pure red, zero flare.
    const pre = pixelChannels(framePixel(output, WINDOW_START - 1));
    expect(pre[1]).toBeLessThan(30);

    // Window start: flare envelope 0.
    const start = pixelChannels(framePixel(output, WINDOW_START));
    expect(start[1]).toBeLessThan(30);

    // Ramp: green rises monotonically toward the seam.
    const rampEarly = pixelChannels(framePixel(output, WINDOW_START + 2))[1];
    const rampLate = pixelChannels(framePixel(output, WINDOW_START + 4))[1];
    expect(rampEarly).toBeGreaterThan(start[1]);
    expect(rampLate).toBeGreaterThan(rampEarly);

    // Peak exactly on the seam frame (chorus head) — the flare maximum.
    const peak = pixelChannels(framePixel(output, SEAM));
    expect(peak[1]).toBeGreaterThan(rampLate);
    expect(peak[1]).toBeGreaterThan(120);

    // Decay: B remains visible while the flare falls.
    const decayMid = pixelChannels(framePixel(output, SEAM + 3))[1];
    expect(decayMid).toBeLessThan(peak[1]);
    expect(decayMid).toBeGreaterThan(30);

    // Declared post-seam window end (seam + overlap): flare fully gone.
    const tail = pixelChannels(framePixel(output, FLASH_END));
    expect(tail[1]).toBeLessThan(30);

    // …and it never comes back.
    const after = pixelChannels(framePixel(output, FLASH_END + 4));
    expect(after[1]).toBeLessThan(30);
    expect(after[2]).toBeGreaterThan(200);
  }, 300_000);

  it("F1 hostile: a degenerate 1-frame dreamy window shows clip A (xfade-aligned), never black", async () => {
    // D == 1 window at the hostile nonzero start 9. ffmpeg's xfade alpha is
    // 0 on the single window frame (clip A), the filtergraph skips the
    // degenerate blur styling, and Remotion's D == 1 progress guard shows
    // clip A too — all three surfaces agree, and no NaN black frame.
    const fixture = await makeColorFixture();
    const timeline = makeTimeline(fixture, "dreamy_focus_blur");
    timeline.tracks = {
      video: [{
        track_id: "V1", kind: "video",
        clips: [
          { ...(timeline.tracks as { video: Array<{ clips: Array<Record<string, unknown>> }> }).video[0].clips[0] },
          {
            clip_id: "CLP_B", segment_id: "SEG_B", asset_id: fixture.blueAssetId, media_kind: "video",
            src_in_us: WINDOW_START * 1_000_000 / FPS, src_out_us: 2_000_000,
            timeline_in_frame: WINDOW_START, timeline_duration_frames: B_FRAMES - OVERLAP + 1,
            role: "hero", motivation: "chorus", beat_id: "b02",
            fallback_segment_ids: [], confidence: 1, quality_flags: [],
          },
        ],
      }],
      audio: [],
    } as typeof timeline.tracks;
    timeline.transitions = [{
      transition_id: "tr_0000",
      from_clip_id: "CLP_A",
      to_clip_id: "CLP_B",
      track_id: "V1",
      transition_type: "dreamy_focus_blur",
      transition_frames: 1,
      start_frame: WINDOW_START,
      duration_frames: 1,
      transition_params: { crossfade_sec: 1 / FPS, easing: "linear" },
    }];

    const output = await renderViaRemotion(fixture, timeline, "d1-blur");

    // Single window frame (9): clip A (red) — the same frame ffmpeg's
    // xfade renders, never a black/NaN frame.
    const win = pixelChannels(framePixel(output, WINDOW_START));
    expect(win[0]).toBeGreaterThan(200);
    expect(win[2]).toBeLessThan(60);

    // Before and after the degenerate window: real content, no black.
    const pre = pixelChannels(framePixel(output, WINDOW_START - 1));
    expect(pre[0]).toBeGreaterThan(200);
    const post = pixelChannels(framePixel(output, WINDOW_START + 1));
    expect(post[2]).toBeGreaterThan(200);
    expect(post[0]).toBeLessThan(60);
  }, 300_000);
});
