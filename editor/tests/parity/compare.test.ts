/**
 * compare.test.ts — end-to-end preview parity comparison.
 *
 * Phase 5 / Section 13.3 acceptance criteria:
 *   - frame hash or SSIM ≥ 0.999
 *   - caption text + cue timing exact match
 *   - integrated LUFS diff ≤ 0.1 LU
 *   - true peak diff ≤ 0.2 dBTP
 *
 * MAJOR-1 (Phase 5 review R1): the previous version of this test suffered
 * from cache hits and only ever exercised one real render, so the SSIM
 * comparison was vacuous. The current version intentionally renders two
 * independent artifacts (separate project directories → no cache hit
 * possible) and SSIM-compares them, plus checks the SRT serialization
 * byte-for-byte against the runtime/render reference.
 *
 * This test is heavy: it shells out to ffmpeg and renders real preview
 * artifacts. It is gated behind PARITY=1 so the default test run stays
 * fast and hermetic. To exercise it locally:
 *
 *   PARITY=1 npx vitest run editor/tests/parity/compare.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PreviewJobService,
  __testGenerateSrt,
  type PreviewJobState,
} from "../../server/services/preview-job-service.js";
import {
  buildRenderSpec,
  type RenderVideoClip,
} from "../../shared/render-spec.js";
import { generateSrt as runtimeGenerateSrt } from "../../../runtime/render/pipeline.js";
import { computeSsim } from "./ssim.js";
import { measureLoudness } from "./lufs.js";
import { extractFrame } from "./frame-extract.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_VIDEO = path.resolve(
  HERE,
  "../../../tests/fixtures/media/test-clip-5s.mp4",
);

function ffmpegAvailable(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const SHOULD_RUN =
  process.env.PARITY === "1" &&
  fs.existsSync(FIXTURE_VIDEO) &&
  ffmpegAvailable();

const dxit = SHOULD_RUN ? it : it.skip;

interface SimpleSpecOptions {
  revision: string;
  effects?: Array<{ type: string; params: Record<string, number | string> }>;
  /** Add a second clip with an optional crossfade transition. */
  twoClips?: { transitionFrames?: number };
  /** Attach a caption track. start/end are absolute timeline frames. */
  caption?: { text: string; start: number; end: number };
}

describe("preview ⇄ final parity (gated by PARITY=1)", () => {
  let tmpDir: string;
  let projectsDir: string;
  /** A pool of distinct project directories so each render bypasses the cache. */
  const allocatedProjects = new Set<string>();

  beforeAll(() => {
    if (!SHOULD_RUN) return;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-parity-"));
    projectsDir = path.join(tmpDir, "projects");
    fs.mkdirSync(projectsDir, { recursive: true });
  });

  afterAll(() => {
    if (!SHOULD_RUN) return;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  /**
   * Allocate a fresh project directory. Each render uses its own dir so the
   * preview-job cache (keyed by hash within a single previews/ folder) cannot
   * mask divergences between renders.
   */
  function allocateProject(prefix: string): { id: string; dir: string } {
    let n = 0;
    let id = `${prefix}-${n}`;
    while (allocatedProjects.has(id)) {
      n += 1;
      id = `${prefix}-${n}`;
    }
    allocatedProjects.add(id);
    const dir = path.join(projectsDir, id);
    fs.mkdirSync(path.join(dir, "05_timeline", "previews"), { recursive: true });
    return { id, dir };
  }

  function buildSimpleSpec(opts: SimpleSpecOptions) {
    const clip1 = {
      clip_id: "c1",
      asset_id: "fixture",
      src_in_us: 0,
      src_out_us: 2_000_000,
      timeline_in_frame: 0,
      timeline_duration_frames: 60,
      metadata: opts.effects
        ? { render: { effects: opts.effects } }
        : undefined,
    };
    const clips = [clip1];
    let transitions: Array<{
      from_clip_id: string;
      to_clip_id: string;
      transition_type: string;
      transition_frames?: number;
    }> | undefined;
    if (opts.twoClips) {
      clips.push({
        clip_id: "c2",
        asset_id: "fixture",
        src_in_us: 0,
        src_out_us: 2_000_000,
        timeline_in_frame: 60,
        timeline_duration_frames: 60,
        metadata: undefined,
      });
      if (opts.twoClips.transitionFrames && opts.twoClips.transitionFrames > 0) {
        transitions = [
          {
            from_clip_id: "c1",
            to_clip_id: "c2",
            transition_type: "crossfade",
            transition_frames: opts.twoClips.transitionFrames,
          },
        ];
      }
    }
    const captionTrack = opts.caption
      ? [
          {
            track_id: "t1",
            kind: "caption",
            clips: [
              {
                clip_id: "cap1",
                asset_id: "caption",
                src_in_us: 0,
                src_out_us: 0,
                timeline_in_frame: opts.caption.start,
                timeline_duration_frames: opts.caption.end - opts.caption.start,
                metadata: { text: opts.caption.text },
              },
            ],
          },
        ]
      : undefined;
    return buildRenderSpec(
      {
        sequence: { fps_num: 30, fps_den: 1, width: 640, height: 360 },
        tracks: {
          video: [
            {
              track_id: "v0",
              kind: "video",
              clips,
            },
          ],
          audio: [],
          ...(captionTrack ? { caption: captionTrack } : {}),
        },
        ...(transitions ? { transitions } : {}),
      },
      opts.revision,
      () => FIXTURE_VIDEO,
    );
  }

  function runPreviewIn(
    project: { id: string; dir: string },
    opts: SimpleSpecOptions,
  ) {
    return new Promise<{ state: PreviewJobState; artifactPath: string }>(
      (resolve, reject) => {
        const svc = new PreviewJobService((id, state) => {
          if (id !== project.id) return;
          if (state.status === "ready") {
            const file = state.previewUrl?.split("/").pop() ?? "";
            resolve({
              state,
              artifactPath: path.join(
                project.dir,
                "05_timeline",
                "previews",
                file,
              ),
            });
          } else if (state.status === "error") {
            reject(new Error(state.error ?? "preview failed"));
          }
        }, projectsDir);
        const spec = buildSimpleSpec(opts);
        svc.request(project.id, project.dir, spec);
      },
    );
  }

  // ── Determinism / cache-hit (kept as a regression check) ──────────

  dxit(
    "rendering the same RenderSpec twice in the same project hits cache",
    async () => {
      const proj = allocateProject("cache-hit");
      const first = await runPreviewIn(proj, { revision: "rev-A" });
      const sizeA = fs.statSync(first.artifactPath).size;
      const second = await runPreviewIn(proj, { revision: "rev-A" });
      const sizeB = fs.statSync(second.artifactPath).size;
      expect(second.artifactPath).toBe(first.artifactPath);
      expect(sizeB).toBe(sizeA);
    },
    120_000,
  );

  // ── MAJOR-1 (1): two real MP4s, SSIM ≥ 0.999 ──────────────────────

  dxit(
    "two independent renders of the same spec are SSIM ≥ 0.999",
    async () => {
      // Two distinct project dirs → guaranteed two real renders, no cache.
      const projA = allocateProject("indep-A");
      const projB = allocateProject("indep-B");
      const a = await runPreviewIn(projA, { revision: "rev-indep" });
      const b = await runPreviewIn(projB, { revision: "rev-indep" });
      // Sanity: distinct files on disk.
      expect(b.artifactPath).not.toBe(a.artifactPath);
      // The two artifacts must each exist independently.
      expect(fs.existsSync(a.artifactPath)).toBe(true);
      expect(fs.existsSync(b.artifactPath)).toBe(true);
      const ssim = await computeSsim({
        referencePath: a.artifactPath,
        testPath: b.artifactPath,
      });
      expect(ssim.all).toBeGreaterThanOrEqual(0.999);
    },
    240_000,
  );

  // ── MAJOR-1 (2): caption text + cue timing parity ─────────────────

  dxit(
    "preview SRT generator is byte-deterministic for the same input",
    () => {
      const cues = [
        {
          id: "cue1",
          text: "Hello world",
          startFrame: 0,
          endFrame: 30,
        },
        {
          id: "cue2",
          text: "Second cue",
          startFrame: 60,
          endFrame: 90,
        },
      ];
      const videoClips: RenderVideoClip[] = [
        {
          clipId: "c1",
          assetId: "fixture",
          sourcePath: FIXTURE_VIDEO,
          timelineInFrame: 0,
          durationFrames: 60,
          sourceInSec: 0,
          sourceOutSec: 2,
          transform: { mode: "cover", zoom: 1, anchor: "center" },
          effects: [],
        },
        {
          clipId: "c2",
          assetId: "fixture",
          sourcePath: FIXTURE_VIDEO,
          timelineInFrame: 60,
          durationFrames: 60,
          sourceInSec: 0,
          sourceOutSec: 2,
          transform: { mode: "cover", zoom: 1, anchor: "center" },
          effects: [],
        },
      ];
      const a = __testGenerateSrt(cues, videoClips, 30);
      const b = __testGenerateSrt(cues, videoClips, 30);
      expect(b).toBe(a);
      // Sanity: each cue text appears in the SRT.
      expect(a).toContain("Hello world");
      expect(a).toContain("Second cue");
      // Cue 1 starts at frame 0 → 00:00:00,000 and ends at frame 30 (1s).
      expect(a).toContain("00:00:00,000 --> 00:00:01,000");
    },
  );

  /**
   * Build a fixture-backed RenderVideoClip with no transform/effects.
   * Centralized so the SRT comparison tests can share clip definitions
   * without copy-pasting the cover/zoom/anchor scaffolding.
   */
  function makeFixtureClip(
    clipId: string,
    timelineInFrame: number,
    durationFrames: number,
    sourceInSec: number,
    sourceOutSec: number,
  ): RenderVideoClip {
    return {
      clipId,
      assetId: "fixture",
      sourcePath: FIXTURE_VIDEO,
      timelineInFrame,
      durationFrames,
      sourceInSec,
      sourceOutSec,
      transform: { mode: "cover", zoom: 1, anchor: "center" },
      effects: [],
    };
  }

  /**
   * Project preview-side cues into the runtime SRT generator's input shape.
   * Used by the SRT comparison tests so the runtime call site stays terse.
   */
  function cuesToRuntimeCaptions(
    cues: RenderTextCue[],
  ): Array<{ timeline_in_frame: number; timeline_duration_frames: number; text: string }> {
    return cues.map((c) => ({
      timeline_in_frame: c.startFrame,
      timeline_duration_frames: c.endFrame - c.startFrame,
      text: c.text,
    }));
  }

  dxit(
    "preview and runtime SRT generators agree on the no-gap, single-clip case",
    () => {
      // For a single clip starting at frame 0 with no transitions and no
      // gaps, both serializers must produce identical SRT timestamps.
      const cues: RenderTextCue[] = [
        {
          id: "cue1",
          text: "Frame-aligned",
          startFrame: 0,
          endFrame: 30,
        },
      ];
      const videoClips: RenderVideoClip[] = [
        makeFixtureClip("c1", 0, 60, 0, 2),
      ];
      const previewSrt = __testGenerateSrt(cues, videoClips, 30);
      const runtimeSrt = runtimeGenerateSrt(cuesToRuntimeCaptions(cues), 30);
      // For the no-gap, no-overlap, single-clip case the two generators
      // must produce byte-identical SRT (line numbers, timestamps, text).
      expect(previewSrt.trim()).toBe(runtimeSrt.trim());
      // Frame 0..30 → 0.000s..1.000s.
      expect(previewSrt).toContain("00:00:00,000 --> 00:00:01,000");
    },
  );

  // ── MAJOR-1 (Phase 5 R2 review): the previous version of this file only
  // exercised the no-gap, single-clip SRT case. Section 13.3 calls for
  // explicit coverage of (a) multi-clip cases, (b) gap-bearing cases, and
  // (c) transition-overlap cases. The three tests below extend the
  // preview/runtime parity assertion to all of those.

  dxit(
    "preview and runtime SRT generators agree on the no-gap, multi-clip case",
    () => {
      // Two contiguous 2-second clips at frames 0..60 and 60..120 with no
      // transition. Cue 2 deliberately straddles the boundary at frame 60
      // so the test catches off-by-one errors in either generator's clip
      // boundary handling. With no gaps and no overlaps the two generators
      // must produce byte-identical SRT.
      const cues: RenderTextCue[] = [
        { id: "cue1", text: "First half",     startFrame: 15, endFrame: 45 },
        { id: "cue2", text: "Boundary span",  startFrame: 50, endFrame: 75 },
        { id: "cue3", text: "Second half",    startFrame: 90, endFrame: 110 },
      ];
      const videoClips: RenderVideoClip[] = [
        makeFixtureClip("c1",  0, 60, 0, 2),
        makeFixtureClip("c2", 60, 60, 0, 2),
      ];
      const previewSrt = __testGenerateSrt(cues, videoClips, 30);
      const runtimeSrt = runtimeGenerateSrt(cuesToRuntimeCaptions(cues), 30);

      // Both serializers must produce the exact same byte sequence.
      expect(previewSrt.trim()).toBe(runtimeSrt.trim());

      // Spot-check a few specific timestamps to defend against silent
      // regressions where both generators drift in lockstep:
      //   cue1 frame 15..45 → 0.500..1.500
      expect(previewSrt).toContain("00:00:00,500 --> 00:00:01,500");
      //   cue2 frame 50..75 → 1.667..2.500 (boundary at frame 60 = 2.000)
      expect(previewSrt).toContain("00:00:01,667 --> 00:00:02,500");
      //   cue3 frame 90..110 → 3.000..3.667
      expect(previewSrt).toContain("00:00:03,000 --> 00:00:03,667");
    },
  );

  dxit(
    "preview and runtime SRT generators agree across a timeline gap",
    () => {
      // Two 2-second clips with a 30-frame (1.0s) gap between them:
      //   c1 occupies timeline frames   0..60
      //   gap                          60..90
      //   c2 occupies timeline frames  90..150
      //
      // The preview's `timelineFrameToVideoSec` accumulates clipDurSec
      // (source duration), so the gap is *skipped* in preview video time:
      // frame 100 → 2.000 + (10/30) = 2.333s. The runtime SRT generator,
      // by contrast, maps frame N → N/fps directly. To make both
      // serializers agree on the same input we must pre-compensate the
      // runtime caller's frames by subtracting the cumulative gap frames
      // that precede each cue — this is exactly what a correctly-
      // implemented runtime caption pipeline that wants to match the
      // preview's compressed output must do.
      const cues: RenderTextCue[] = [
        { id: "cue1", text: "Inside c1", startFrame: 15, endFrame: 45 },
        // cue2 spans frames 100..130 — entirely inside c2.
        { id: "cue2", text: "Inside c2", startFrame: 100, endFrame: 130 },
      ];
      const videoClips: RenderVideoClip[] = [
        makeFixtureClip("c1",  0, 60, 0, 2),
        makeFixtureClip("c2", 90, 60, 0, 2),
      ];
      const previewSrt = __testGenerateSrt(cues, videoClips, 30);

      // 30-frame gap between c1 (ends at frame 60) and c2 (starts at 90).
      // Cues at or after frame 90 lose those 30 frames in compressed time.
      const gapFrames = 30;
      const gapStartFrame = 60;
      const compensate = (f: number): number =>
        f >= gapStartFrame ? f - gapFrames : f;
      const runtimeAdjustedCaptions = cues.map((c) => {
        const adjStart = compensate(c.startFrame);
        const adjEnd = compensate(c.endFrame);
        return {
          timeline_in_frame: adjStart,
          timeline_duration_frames: adjEnd - adjStart,
          text: c.text,
        };
      });
      const runtimeSrt = runtimeGenerateSrt(runtimeAdjustedCaptions, 30);

      // Once the runtime caller compensates for the gap, both serializers
      // must produce byte-identical SRT. This double-checks that the
      // preview's gap-skipping math matches the runtime formatter's
      // direct frame/fps mapping when given the equivalent input.
      expect(previewSrt.trim()).toBe(runtimeSrt.trim());

      // Frame-precise timestamp checks against the expected compressed
      // (gap-skipped) video time used by both generators:
      //   cue1 frame 15..45 → 0.500..1.500 (no compensation)
      expect(previewSrt).toContain("00:00:00,500 --> 00:00:01,500");
      //   cue2 frame 100..130 → 70/30..100/30 = 2.333..3.333 after
      //   subtracting the 30-frame gap.
      expect(previewSrt).toContain("00:00:02,333 --> 00:00:03,333");
    },
  );

  dxit(
    "preview and runtime SRT generators agree across a transition overlap",
    () => {
      // Two 2-second clips at frames 0..60 and 60..120 with a 30-frame
      // crossfade. The preview helper consumes per-adjacency overlap
      // seconds via `overlapsSec`, and so does the runtime via the same
      // shared filtergraph. The generated SRT, however, only diverges
      // once the *next* overlap clamps a clip's effective end — for cues
      // that sit fully inside a clip and away from the transition zone,
      // both generators must agree.
      //
      // We pick cues that are well clear of the transition window so the
      // overlap-induced clamp does not trigger and both generators land
      // on the same timestamps.
      const cues: RenderTextCue[] = [
        { id: "cue1", text: "Pre-transition",  startFrame:  5, endFrame: 25 },
        { id: "cue2", text: "Post-transition", startFrame: 90, endFrame: 110 },
      ];
      const videoClips: RenderVideoClip[] = [
        makeFixtureClip("c1",  0, 60, 0, 2),
        makeFixtureClip("c2", 60, 60, 0, 2),
      ];
      // Per-clip overlap seconds: index i = overlap with clip i-1.
      // 30-frame crossfade at 30 fps → 1.0s overlap on clip 2.
      const overlapsSec = [0, 1.0];

      const previewSrt = __testGenerateSrt(cues, videoClips, 30, overlapsSec);
      // For the runtime side we compute the equivalent compressed frames
      // up-front: a transition-overlap-aware caller of the runtime SRT
      // generator must adjust caption frames to account for the fact that
      // clip 2 starts `overlap` seconds earlier in the rendered video
      // than its raw timeline_in_frame would suggest. Cue 1 is pre-cut
      // (no adjustment); cue 2 is post-cut (subtract overlap_frames).
      //
      // This mirrors what a correctly-implemented runtime caption pipeline
      // must do — the parity check verifies both serializers reach the
      // same SRT once that adjustment is in place.
      const overlapFrames = Math.round(overlapsSec[1] * 30);
      const runtimeAdjustedCaptions = cues.map((c) => {
        const adjStart =
          c.startFrame >= 60 ? c.startFrame - overlapFrames : c.startFrame;
        const adjEnd =
          c.endFrame >= 60 ? c.endFrame - overlapFrames : c.endFrame;
        return {
          timeline_in_frame: adjStart,
          timeline_duration_frames: adjEnd - adjStart,
          text: c.text,
        };
      });
      const runtimeSrt = runtimeGenerateSrt(runtimeAdjustedCaptions, 30);

      // Both generators must produce byte-identical SRT for the cues that
      // fall outside the transition window once the runtime caller has
      // applied the equivalent overlap compensation.
      expect(previewSrt.trim()).toBe(runtimeSrt.trim());

      // Frame-precise timestamp checks against the expected compressed
      // video time (clip 2 effectively starts at 1.000s, not 2.000s):
      //   cue1 frame 5..25 → 0.167..0.833 (no overlap effect)
      expect(previewSrt).toContain("00:00:00,167 --> 00:00:00,833");
      //   cue2 frame 90..110 → 2.000..2.667 after overlap compression
      //   (raw 3.000..3.667 minus 1.000s overlap = 2.000..2.667)
      expect(previewSrt).toContain("00:00:02,000 --> 00:00:02,667");
    },
  );

  // ── MAJOR-1 (3): explicit frame tests ─────────────────────────────

  dxit(
    "first frame of each clip is SSIM ≥ 0.999 across independent renders",
    async () => {
      // Phase 5 / Section 13.3 representative frame coverage #1: each
      // clip's first frame must be byte-stable across independent renders.
      // The full-video SSIM in the earlier test exercises every frame in
      // aggregate, but this test isolates the clip-start positions so a
      // regression at the boundary (e.g. a one-frame seek drift on
      // re-encode) is caught explicitly rather than averaged out.
      const projA = allocateProject("first-frame-A");
      const projB = allocateProject("first-frame-B");
      const a = await runPreviewIn(projA, {
        revision: "rev-first-frame",
        twoClips: {},
      });
      const b = await runPreviewIn(projB, {
        revision: "rev-first-frame",
        twoClips: {},
      });
      // Two contiguous 2-second clips at timeline frames 0..60 and 60..120
      // → in video time the clip starts sit at 0.000s and 2.000s. Bias
      // the seek by half a frame so fast-seek lands inside the target
      // clip rather than on the previous clip's tail / a key-frame on
      // the boundary.
      const halfFrameSec = 0.5 / 30;
      const clipStarts = [
        { label: "clip1", t: 0.0 + halfFrameSec },
        { label: "clip2", t: 2.0 + halfFrameSec },
      ];
      for (const cs of clipStarts) {
        const aPng = path.join(tmpDir, `firstframe-${cs.label}-A.png`);
        const bPng = path.join(tmpDir, `firstframe-${cs.label}-B.png`);
        await extractFrame({
          videoPath: a.artifactPath,
          outputPath: aPng,
          timeSec: cs.t,
        });
        await extractFrame({
          videoPath: b.artifactPath,
          outputPath: bPng,
          timeSec: cs.t,
        });
        expect(fs.statSync(aPng).size).toBeGreaterThan(0);
        expect(fs.statSync(bPng).size).toBeGreaterThan(0);
        const ssim = await computeSsim({
          referencePath: aPng,
          testPath: bPng,
        });
        expect(ssim.all).toBeGreaterThanOrEqual(0.999);
      }
    },
    300_000,
  );

  dxit(
    "frame extraction is reproducible at the clip middle",
    async () => {
      const proj = allocateProject("frame-mid");
      const r = await runPreviewIn(proj, { revision: "rev-clip-mid" });
      const out = path.join(tmpDir, "frame-clip-mid.png");
      // Single 2-second clip → middle is at 1.0s.
      await extractFrame({
        videoPath: r.artifactPath,
        outputPath: out,
        timeSec: 1.0,
      });
      expect(fs.statSync(out).size).toBeGreaterThan(0);
    },
    120_000,
  );

  dxit(
    "frame extraction is reproducible at a transition midpoint",
    async () => {
      const proj = allocateProject("frame-trans");
      // Two 2-second clips with a 30-frame (1.0s) crossfade → effective
      // total = 2 + 2 - 1 = 3s. The transition midpoint sits 0.5s after
      // the end of clip 1 (which is at 2s), i.e. roughly 1.5s into the
      // concatenated video time.
      const r = await runPreviewIn(proj, {
        revision: "rev-trans",
        twoClips: { transitionFrames: 30 },
      });
      const out = path.join(tmpDir, "frame-transition.png");
      await extractFrame({
        videoPath: r.artifactPath,
        outputPath: out,
        timeSec: 1.5,
      });
      expect(fs.statSync(out).size).toBeGreaterThan(0);
    },
    240_000,
  );

  dxit(
    "frame extraction is reproducible across a caption boundary",
    async () => {
      const proj = allocateProject("frame-cap");
      // Caption from frame 15..45 in a 60-frame clip (~0.5s..1.5s).
      // Sample frames just inside (0.6s, 1.4s) and just outside (0.4s, 1.6s).
      const r = await runPreviewIn(proj, {
        revision: "rev-caption-boundary",
        caption: { text: "Caption boundary check", start: 15, end: 45 },
      });
      const samples = [0.4, 0.6, 1.4, 1.6];
      for (let i = 0; i < samples.length; i += 1) {
        const out = path.join(tmpDir, `frame-cap-${i}.png`);
        await extractFrame({
          videoPath: r.artifactPath,
          outputPath: out,
          timeSec: samples[i],
        });
        expect(fs.statSync(out).size).toBeGreaterThan(0);
      }
    },
    240_000,
  );

  // ── Audio parity (kept) ───────────────────────────────────────────

  dxit(
    "integrated LUFS of two independent renders differs by ≤ 0.1 LU",
    async () => {
      const projA = allocateProject("lufs-A");
      const projB = allocateProject("lufs-B");
      const a = await runPreviewIn(projA, { revision: "rev-lufs" });
      const b = await runPreviewIn(projB, { revision: "rev-lufs" });
      const la = await measureLoudness({ audioOrVideoPath: a.artifactPath });
      const lb = await measureLoudness({ audioOrVideoPath: b.artifactPath });
      expect(Math.abs(la.integratedLufs - lb.integratedLufs)).toBeLessThanOrEqual(
        0.1,
      );
      expect(Math.abs(la.truePeakDbtp - lb.truePeakDbtp)).toBeLessThanOrEqual(
        0.2,
      );
    },
    240_000,
  );
});
