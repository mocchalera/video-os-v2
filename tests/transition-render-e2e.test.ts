// Issue #34 — real-ffmpeg e2e for the A/B roll transition engine
//
// Acceptance criteria verified against rendered pixels/frames:
// - AC1: clip A's tail and clip B's head melt smoothly (film_crossfade)
// - AC2: the light-leak flash fires exactly on the chorus head frame with
//   1-frame precision (no emission before, no bleed after)
// - AC3: the program duration is unchanged by transition application
//   (Gap 0 / Overrun 0: declared frames == rendered frames)
// - Bonus: gaussian blur window is frame-exact (lossless graph comparison)

import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ingestAsset } from "../runtime/connectors/ffprobe.js";
import { assembleTimelineToMp4 } from "../runtime/render/assembler.js";
import { renderRoughCut } from "../scripts/render-rough-cut.js";
import {
  buildTransitionChainArgs,
  buildTransitionSpec,
  buildVideoTransitionGraph,
  type TransitionGraphContext,
} from "../editor/shared/filtergraph.js";
import { applyTransitionOverlaps } from "../runtime/compiler/transition-overlap.js";
import type { TimelineClip, Track } from "../runtime/compiler/types.js";
import type { TimelineTransition } from "../runtime/compiler/transition-types.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function ffmpeg(args: string[]): Buffer {
  return execFileSync("ffmpeg", ["-v", "error", ...args], { maxBuffer: 100 * 1024 * 1024 });
}

function probeFrameCount(output: string): number {
  const streams = JSON.parse(execFileSync("ffprobe", [
    "-v", "error", "-count_frames", "-show_entries", "stream=codec_type,nb_read_frames", "-of", "json", output,
  ], { encoding: "utf8" })).streams as Array<Record<string, unknown>>;
  const video = streams.find((s) => s.codec_type === "video");
  return Number(video?.nb_read_frames);
}

function framePixel(output: string, frame: number): string {
  return ffmpeg([
    "-i", output,
    "-vf", `select=eq(n\\,${frame}),format=rgb24,crop=1:1:32:16`,
    "-frames:v", "1", "-f", "rawvideo", "-",
  ]).toString("hex");
}

function pixelChannels(pixel: string): number[] {
  return [0, 2, 4].map((offset) => Number.parseInt(pixel.slice(offset, offset + 2), 16));
}

function decodedFrameHashes(output: string): string[] {
  const text = execFileSync("ffmpeg", ["-v", "error", "-i", output, "-map", "0:v:0", "-f", "framemd5", "-"], { encoding: "utf8" });
  return text.split("\n").filter((line) => line && !line.startsWith("#")).map((line) => line.split(",").at(-1)!.trim());
}

const FPS = 24;
const OVERLAP = 6;
// Timeline geometry (what the compiler emits after applyTransitionOverlaps):
// A [0,24) 24f red; B head-extended [18,48) 30f blue (src head extends 6f).
const A_FRAMES = 24;
const B_IN = A_FRAMES - OVERLAP; // 18 = overlap window start; chorus head (seam) = 24
const B_FRAMES = 30;
const TOTAL_FRAMES = B_IN + B_FRAMES; // 48 = unchanged by the transition

interface Fixture {
  projectDir: string;
  redAssetId: string;
  blueAssetId: string;
}

async function makeProject(): Promise<Fixture> {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-transition-e2e-"));
  dirs.push(projectDir);
  const redPath = path.join(projectDir, "red.mp4");
  const bluePath = path.join(projectDir, "blue.mp4");
  ffmpeg(["-f", "lavfi", "-i", "color=c=red:s=64x32:r=24:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", redPath]);
  // 2s so the extended head (0.75s..) has real source material.
  ffmpeg(["-f", "lavfi", "-i", "color=c=blue:s=64x32:r=24:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", bluePath]);
  const red = await ingestAsset(redPath, { projectRoot: projectDir, mediaKind: "video", ffmpegVersion: "test" });
  const blue = await ingestAsset(bluePath, { projectRoot: projectDir, mediaKind: "video", ffmpegVersion: "test" });
  fs.mkdirSync(path.join(projectDir, "02_media"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "02_media/source_map.json"), JSON.stringify({
    version: "1", project_id: "transition-e2e", media_dir: "02_media", generated_at: "2026-08-29T00:00:00Z",
    items: [
      { asset_id: red.asset_id, source_locator: redPath, local_source_path: redPath, link_path: "red.mp4", media_kind: "video" },
      { asset_id: blue.asset_id, source_locator: bluePath, local_source_path: bluePath, link_path: "blue.mp4", media_kind: "video" },
    ],
  }));
  fs.mkdirSync(path.join(projectDir, "03_analysis"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "03_analysis/assets.json"), JSON.stringify({ items: [red, blue] }));
  fs.mkdirSync(path.join(projectDir, "05_timeline"), { recursive: true });
  return { projectDir, redAssetId: red.asset_id, blueAssetId: blue.asset_id };
}

function makeTimeline(fixture: Fixture, transitionType: string): Record<string, unknown> {
  return makeTimelineWithOverlap(fixture, transitionType, OVERLAP);
}

/**
 * Timeline in post-overlap geometry with a configurable (hostile) overlap:
 * A [0, A_FRAMES) red; B head-extended [A_FRAMES - overlap, ...) blue.
 */
function makeTimelineWithOverlap(
  fixture: Fixture,
  transitionType: string,
  overlap: number,
): Record<string, unknown> {
  const bIn = A_FRAMES - overlap;
  const bFrames = B_FRAMES - OVERLAP + overlap;
  return {
    version: "1", project_id: "transition-e2e", created_at: "2026-08-29T00:00:00Z",
    sequence: { name: "main", fps_num: FPS, fps_den: 1, width: 64, height: 32, start_frame: 0, letterbox_policy: "none" },
    tracks: {
      video: [{
        track_id: "V1", kind: "video",
        clips: [
          {
            clip_id: "CLP_A", segment_id: "SEG_A", asset_id: fixture.redAssetId, media_kind: "video",
            src_in_us: 0, src_out_us: A_FRAMES * 1_000_000 / FPS,
            timeline_in_frame: 0, timeline_duration_frames: A_FRAMES,
            role: "hero", motivation: "verse", beat_id: "b01",
            fallback_segment_ids: [], confidence: 1, quality_flags: [],
          },
          {
            clip_id: "CLP_B", segment_id: "SEG_B", asset_id: fixture.blueAssetId, media_kind: "video",
            // Head-extended: source starts `overlap` frames earlier, placement shifted.
            src_in_us: bIn * 1_000_000 / FPS, src_out_us: 2_000_000,
            timeline_in_frame: bIn, timeline_duration_frames: bFrames,
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
      transition_frames: overlap,
      start_frame: bIn,
      duration_frames: overlap,
      transition_params: { crossfade_sec: overlap / FPS, easing: "linear" },
    }],
    provenance: { brief_path: "", blueprint_path: "", selects_path: "", compiler_version: "test" },
  };
}

async function render(fixture: Fixture, timeline: Record<string, unknown>, name: string): Promise<string> {
  const timelinePath = path.join(fixture.projectDir, "05_timeline/timeline.json");
  fs.writeFileSync(timelinePath, JSON.stringify(timeline));
  const output = path.join(fixture.projectDir, `05_timeline/${name}.mp4`);
  await assembleTimelineToMp4({
    projectDir: fixture.projectDir,
    timelinePath,
    outputPath: output,
    includeAudio: false,
  });
  return output;
}

describe("Issue #34 A/B roll transition engine (real ffmpeg)", () => {
  it("AC3+AC1: film_crossfade keeps the program at 48 frames and melts A into B", async () => {
    const fixture = await makeProject();
    const output = await render(fixture, makeTimeline(fixture, "film_crossfade"), "film");

    // AC3: declared total (48) == rendered total. Gap 0 / Overrun 0.
    expect(probeFrameCount(output)).toBe(TOTAL_FRAMES);

    // AC1: A's tail and B's head melt. Frame 17 pure red (before window),
    // mid-window frames carry both red and blue, frame 24 pure blue.
    const before = pixelChannels(framePixel(output, 17));
    expect(before[0]).toBeGreaterThan(240); // red
    expect(before[2]).toBeLessThan(15);

    const mid = pixelChannels(framePixel(output, 21)); // alpha ≈ 0.5
    expect(mid[0]).toBeGreaterThan(80); // red survives
    expect(mid[2]).toBeGreaterThan(80); // blue arrived — true blend, not a fade

    const after = pixelChannels(framePixel(output, 25));
    expect(after[0]).toBeLessThan(15); // no red residue
    expect(after[2]).toBeGreaterThan(240); // blue
  }, 60_000);

  it("AC2+AC3: light_leak_flash peaks exactly on the chorus head (1-frame precision)", async () => {
    const fixture = await makeProject();
    const output = await render(fixture, makeTimeline(fixture, "light_leak_flash"), "leak");

    // AC3: duration untouched.
    expect(probeFrameCount(output)).toBe(TOTAL_FRAMES);

    // Chorus head = seam frame 24 = first frame of B's ORIGINAL content
    // (to_clip.timeline_in_frame 18 + overlap 6). The flash ramps up across
    // the blend [18,24), peaks exactly on the seam, and decays to zero one
    // window later (frame 30) — zero flare before the ramp and after decay.
    const pre = pixelChannels(framePixel(output, 17));
    expect(pre[0]).toBeGreaterThan(240); // pure red — zero flare before the window
    expect(pre[1]).toBeLessThan(12);
    expect(pre[2]).toBeLessThan(12);

    const windowStart = pixelChannels(framePixel(output, 18));
    expect(windowStart[1]).toBeLessThan(12); // envelope is 0 on the first window frame

    // The flare ramps up across the blend window…
    const ramp = pixelChannels(framePixel(output, 21));
    expect(ramp[1]).toBeGreaterThan(40);
    expect(ramp[1]).toBeLessThan(120);

    // …and peaks exactly on the chorus head frame.
    const head = pixelChannels(framePixel(output, 24));
    expect(head[0]).toBeGreaterThan(200); // amber flare red component
    expect(head[1]).toBeGreaterThan(120); // amber flare green component (peak)
    expect(head[2]).toBeGreaterThan(240); // flare blue screened onto blue

    // Decay across the tail.
    const tail = pixelChannels(framePixel(output, 27));
    expect(tail[1]).toBeLessThan(head[1]);

    // No flash bleed past the decay end (frame 30).
    const post = pixelChannels(framePixel(output, 30));
    expect(post[1]).toBeLessThan(12); // pure blue has no green
    expect(post[2]).toBeGreaterThan(240);
  }, 60_000);

  it("AC3: dreamy_focus_blur keeps the program at 48 frames", async () => {
    const fixture = await makeProject();
    const output = await render(fixture, makeTimeline(fixture, "dreamy_focus_blur"), "blur");
    expect(probeFrameCount(output)).toBe(TOTAL_FRAMES);
  }, 60_000);

  it("F1 hostile: a 1-frame dreamy window renders real frames (no NaN black) and matches film", async () => {
    // D == 1 divides the triangle ramp by zero. The graph must degrade
    // deterministically to the unstyled crossfade: the styled render must
    // be byte-identical to the film render (a NaN mix would paint the
    // window frame black) and every frame must carry real content.
    const fixture = await makeProject();
    const timeline = makeTimelineWithOverlap(fixture, "dreamy_focus_blur", 1);
    const output = await render(fixture, timeline, "blur-d1");
    const filmOutput = await render(fixture, makeTimelineWithOverlap(fixture, "film_crossfade", 1), "film-d1");

    // Duration parity: Gap 0 / Overrun 0 at the degenerate window too.
    expect(probeFrameCount(output)).toBe(TOTAL_FRAMES);

    // No black frame, no NaN: the styled render is frame-identical to the
    // unstyled crossfade across the whole program.
    const styledHashes = decodedFrameHashes(output);
    const filmHashes = decodedFrameHashes(filmOutput);
    expect(styledHashes).toHaveLength(TOTAL_FRAMES);
    for (let frame = 0; frame < TOTAL_FRAMES; frame += 1) {
      expect(styledHashes[frame], `frame ${frame} must match the unstyled render`).toBe(filmHashes[frame]);
    }

    // Pixel truth at the degenerate window [23,24): the single blend frame
    // carries xfade alpha 0 → clip A (red), never black.
    const win = pixelChannels(framePixel(output, 23));
    expect(win[0]).toBeGreaterThan(200); // red content, not a black/NaN frame
    const after = pixelChannels(framePixel(output, 24));
    expect(after[2]).toBeGreaterThan(240); // pure blue after the window
  }, 60_000);

  it("scopes the gaussian blur to exactly frames [18,24) (lossless graph check)", () => {
    const context: TransitionGraphContext = { width: 64, height: 32, fps: FPS };
    const build = (type: "film_crossfade" | "dreamy_focus_blur") =>
      buildVideoTransitionGraph(
        2,
        [A_FRAMES / FPS, B_FRAMES / FPS],
        [{ fromIndex: 0, toIndex: 1, spec: { video: { method: "xfade", xfadeDurationSec: OVERLAP / FPS, xfadeTransition: "fade", preset: type }, audio: { method: "acrossfade", crossfadeDurationSec: OVERLAP / FPS } } }],
        context,
      );
    const styled = build("dreamy_focus_blur");
    const plain = build("film_crossfade");
    const inputs = [
      "-f", "lavfi", "-i", "testsrc2=s=64x32:r=24:d=2",
      "-f", "lavfi", "-i", "testsrc2=s=64x32:r=24:d=2",
    ];
    const bind = "[0:v]format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS[v0];[1:v]format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS[v1]";
    const renderGraph = (graph: { filterChain: string; outputLabel: string }): string[] => {
      const out = fs.mkdtempSync(path.join(os.tmpdir(), "vos-blur-scope-"));
      dirs.push(out);
      const target = path.join(out, "scope.mp4");
      execFileSync("ffmpeg", [
        "-v", "error", ...inputs, "-filter_complex", `${bind};${graph.filterChain}`,
        "-map", graph.outputLabel, "-frames:v", String(TOTAL_FRAMES), "-r", "24", "-qp", "0", "-y", target,
      ], { maxBuffer: 100 * 1024 * 1024 });
      return decodedFrameHashes(target);
    };
    const styledHashes = renderGraph(styled);
    const plainHashes = renderGraph(plain);
    expect(styledHashes).toHaveLength(TOTAL_FRAMES);
    for (let frame = 0; frame < TOTAL_FRAMES; frame += 1) {
      const same = styledHashes[frame] === plainHashes[frame];
      if (frame < B_IN || frame >= B_IN + OVERLAP) {
        expect(same, `frame ${frame} outside the blur window must be untouched`).toBe(true);
      } else if (frame === B_IN || frame === B_IN + OVERLAP - 1) {
        // The triangle envelope is exactly 0 on the first and last window
        // frames, so they match the unstyled graph — no boundary pop.
        expect(same, `frame ${frame} at the window edge must be sharp`).toBe(true);
      } else {
        expect(same, `frame ${frame} inside the blur window must be blurred`).toBe(false);
      }
    }
  }, 60_000);

  it("rough-cut tier dissolves the preset boundary with explicit accounting", async () => {
    const fixture = await makeProject();
    const timelinePath = path.join(fixture.projectDir, "05_timeline/timeline.json");
    fs.writeFileSync(timelinePath, JSON.stringify(makeTimeline(fixture, "film_crossfade")));
    const rough = await renderRoughCut({ projectPath: fixture.projectDir, noAudio: true });
    expect(rough.xfadeCount).toBe(1);
    expect(rough.durationAccounting).toMatchObject({
      gap_sec: 0,
      gap_count: 0,
      crossfade_overlap_sec: 0.25,
      parity_pass: true,
    });
  }, 60_000);

  // ── Canonical compiler-through-render counterexample ────────────────
  // Regression for the flash misalignment: the overlap engine shifts clip B
  // earlier, so the chorus head is the SEAM (B's original content start),
  // not the first overlap window frame. The full path must agree:
  // compiler geometry → recorded metadata (flash_peak_frame) → shared
  // filtergraph window → rendered pixels.
  it("counterexample: the compiler-recorded flash peak frame is the frame the render peaks on", async () => {
    const fixture = await makeProject();

    // Compiler input: hand-authored PRE-overlap geometry — B starts exactly
    // where A ends (the chorus cut), with source headroom for the overlap.
    const clipA: TimelineClip = {
      clip_id: "CLP_A", segment_id: "SEG_A", asset_id: fixture.redAssetId, media_kind: "video",
      src_in_us: 0, src_out_us: A_FRAMES * 1_000_000 / FPS,
      timeline_in_frame: 0, timeline_duration_frames: A_FRAMES,
      role: "hero", motivation: "verse", beat_id: "b01",
      fallback_segment_ids: [], confidence: 1, quality_flags: [],
    };
    const clipB: TimelineClip = {
      clip_id: "CLP_B", segment_id: "SEG_B", asset_id: fixture.blueAssetId, media_kind: "video",
      src_in_us: 1_000_000, src_out_us: 2_000_000,
      timeline_in_frame: A_FRAMES, timeline_duration_frames: A_FRAMES,
      role: "hero", motivation: "chorus", beat_id: "b02",
      fallback_segment_ids: [], confidence: 1, quality_flags: [],
    };
    const transition: TimelineTransition = {
      transition_id: "tr_0000",
      from_clip_id: "CLP_A",
      to_clip_id: "CLP_B",
      track_id: "V1",
      transition_type: "light_leak_flash",
      transition_params: { crossfade_sec: OVERLAP / FPS, easing: "linear" },
      metadata: { chorus_entry: { section_id: "S2", flash_start_frame: A_FRAMES } },
    };

    // Compiler pass: physical overlap geometry + provenance metadata.
    const track: Track = { track_id: "V1", kind: "video", clips: [clipA, clipB] };
    const overlap = applyTransitionOverlaps(track, [transition], { fpsNum: FPS, fpsDen: 1 });
    expect(overlap.applied).toHaveLength(1);
    const seam = overlap.applied[0].seam_frame;
    expect(seam).toBe(A_FRAMES); // chorus head = B's original content start
    expect(transition.metadata?.overlap_applied).toEqual({
      overlap_frames: OVERLAP,
      seam_frame: A_FRAMES,
    });
    expect((transition.metadata?.chorus_entry as Record<string, unknown>)?.flash_peak_frame).toBe(seam);

    // Render through the same shared single-generation graph the final
    // assembler uses (post-overlap geometry: A 24f, B head-extended 30f).
    const output = path.join(fixture.projectDir, "counterexample.mp4");
    execFileSync("ffmpeg", [
      "-v", "error",
      ...buildTransitionChainArgs({
        inputs: [
          { kind: "source", sourcePath: path.join(fixture.projectDir, "red.mp4"), sourceInSec: 0, durationSec: A_FRAMES / FPS, videoFilter: "format=yuv420p,setsar=1", hasAudio: false },
          { kind: "source", sourcePath: path.join(fixture.projectDir, "blue.mp4"), sourceInSec: (1_000_000 - OVERLAP * 1_000_000 / FPS) / 1_000_000, durationSec: (A_FRAMES + OVERLAP) / FPS, videoFilter: "format=yuv420p,setsar=1", hasAudio: false },
        ],
        clipDurationsSec: [A_FRAMES / FPS, (A_FRAMES + OVERLAP) / FPS],
        transitions: [
          { fromIndex: 0, toIndex: 1, spec: buildTransitionSpec({ fromClipId: "CLP_A", toClipId: "CLP_B", type: "light_leak_flash", durationFrames: OVERLAP }, FPS) },
        ],
        includeAudio: false,
        videoEncodeArgs: ["-c:v", "libx264", "-preset", "fast", "-qp", "0"],
        outputFps: `${FPS}/1`,
        graphContext: { width: 64, height: 32, fps: FPS },
        outputPath: output,
      }),
    ], { maxBuffer: 100 * 1024 * 1024 });

    // Pixel truth: the green channel peaks EXACTLY on the recorded seam —
    // not on the first window frame (the pre-fix behavior this test pins).
    const greens: number[] = [];
    for (let frame = seam - OVERLAP - 1; frame <= seam + OVERLAP; frame += 1) {
      greens.push(pixelChannels(framePixel(output, frame))[1]);
    }
    const peakOffset = greens.reduce((best, value, index) => (value > greens[best] ? index : best), 0);
    expect(seam - OVERLAP - 1 + peakOffset).toBe(seam);

    // Triangle envelope: zero at both boundaries, monotonic up before the
    // seam and monotonic down after it.
    expect(greens[0]).toBeLessThan(12);                    // frame 17: no early emission
    expect(greens[1]).toBeLessThan(12);                    // frame 18: envelope 0 at window start
    expect(greens[greens.length - 1]).toBeLessThan(12);    // frame 30: envelope 0 at decay end
    for (let i = 2; i <= OVERLAP + 1; i += 1) {
      expect(greens[i]).toBeGreaterThanOrEqual(greens[i - 1]); // ramp [18..24]
    }
    for (let i = OVERLAP + 2; i < greens.length; i += 1) {
      expect(greens[i]).toBeLessThanOrEqual(greens[i - 1]);    // decay [24..30]
    }
  }, 60_000);
});
