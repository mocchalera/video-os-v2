// Issue #34 — semantic preset rendering through the shared transition engine
//
// Covers:
// - buildTransitionSpec mapping for film_crossfade / light_leak_flash /
//   dreamy_focus_blur (xfade fade join + acrossfade audio + preset tag)
// - buildVideoTransitionGraph frame-exact styling windows (flash flare /
//   gaussian blur) and fail-closed context validation
// - Audio duration neutrality under overlap geometry (acrossfade math)
// - timeline-ir schema acceptance of the new transition fields

import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
const Ajv2020 = require("ajv/dist/2020") as new (
  opts?: Record<string, unknown>,
) => import("ajv").default;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const addFormats = require("ajv-formats") as (ajv: import("ajv").default) => void;
type Ajv = import("ajv").default;
import {
  buildTransitionSpec,
  buildVideoTransitionGraph,
  buildAudioTransitionGraph,
  buildTransitionChainArgs,
  type TransitionGraphContext,
} from "../editor/shared/filtergraph.js";
import { applyTransitionOverlaps } from "../runtime/compiler/transition-overlap.js";
import { resolveTransitionWindow } from "../runtime/render/remotion/transition-window.js";
import type { RenderTransition } from "../editor/shared/render-spec.js";

const SCHEMAS_DIR = path.resolve("schemas");

const context: TransitionGraphContext = { width: 1920, height: 1080, fps: 24 };

// ── buildTransitionSpec mapping ───────────────────────────────────────

describe("buildTransitionSpec (Issue #34 presets)", () => {
  const cases = [
    { type: "film_crossfade", preset: "film_crossfade" },
    { type: "light_leak_flash", preset: "light_leak_flash" },
    { type: "dreamy_focus_blur", preset: "dreamy_focus_blur" },
  ] as const;

  for (const { type, preset } of cases) {
    it(`maps ${type} to a linear A/B xfade with acrossfade audio`, () => {
      const transition: RenderTransition = {
        fromClipId: "c1",
        toClipId: "c2",
        type,
        durationFrames: 6, // 0.25s at 24fps
      };
      const spec = buildTransitionSpec(transition, 24);
      expect(spec.video.method).toBe("xfade");
      expect(spec.video.xfadeTransition).toBe("fade");
      expect(spec.video.xfadeDurationSec).toBeCloseTo(6 / 24, 9);
      expect(spec.video.preset).toBe(preset);
      expect(spec.audio.method).toBe("acrossfade");
      expect(spec.audio.crossfadeDurationSec).toBeCloseTo(6 / 24, 9);
    });
  }
});

// ── Video graph styling windows ───────────────────────────────────────

describe("buildVideoTransitionGraph preset windows", () => {
  const clipDurationsSec = [24 / 24, 30 / 24]; // overlap geometry: B head-extended
  const transitions = [
    { fromIndex: 0, toIndex: 1, spec: buildTransitionSpec({ fromClipId: "c1", toClipId: "c2", type: "light_leak_flash", durationFrames: 6 }, 24) },
  ];

  it("emits the xfade at the overlap start and a flash window peaking on the seam", () => {
    const { filterChain, outputLabel } = buildVideoTransitionGraph(2, clipDurationsSec, transitions, context);
    // xfade lands at frame 18 (= B.timeline_in_frame for head-extended B).
    expect(filterChain).toContain("xfade=transition=fade:duration=0.250000:offset=0.750000");
    // Flash post-pass window: split → trim [18,30) (blend + one-window decay
    // tail) → screen blend with the procedural flare → concat back. Frame
    // indices must be exact.
    expect(filterChain).toContain("trim=start_frame=18:end_frame=30");
    expect(filterChain).toContain("blend=all_mode=screen:shortest=1");
    expect(filterChain).toContain("geq=");
    // Triangle envelope: ramp in across the blend [18,24), peak at the seam
    // frame 24 (the chorus head), decay to zero at frame 30.
    expect(filterChain).toContain("fade=t=in:st=0:d=0.250000");
    expect(filterChain).toContain("fade=t=out:st=0.250000:d=0.250000");
    expect(filterChain).toContain("concat=n=3:v=1:a=0[vout1]");
    expect(outputLabel).toBe("[vout1]");
  });

  it("scopes the gaussian blur to exactly the transition window", () => {
    const blurTransitions = [
      { fromIndex: 0, toIndex: 1, spec: buildTransitionSpec({ fromClipId: "c1", toClipId: "c2", type: "dreamy_focus_blur", durationFrames: 6 }, 24) },
    ];
    const { filterChain, outputLabel } = buildVideoTransitionGraph(2, clipDurationsSec, blurTransitions, context);
    expect(filterChain).toContain("xfade=transition=fade:duration=0.250000:offset=0.750000");
    expect(filterChain).toContain("trim=start_frame=18:end_frame=24");
    expect(filterChain).toContain("gblur=sigma=8.000");
    // Triangle mix over N in [1, D]: blend's N starts at 1, so the expr
    // offsets by one — exactly 0 at both window-edge frames, 1 mid-window.
    expect(filterChain).toContain("(1-abs(2*(N-1)/5-1))");
    expect(filterChain).toContain("blend=all_expr=");
    expect(filterChain).not.toContain("blend=all_mode=screen");
    expect(outputLabel).toBe("[vout1]");
  });

  it("applies no styling pass for film_crossfade", () => {
    const filmTransitions = [
      { fromIndex: 0, toIndex: 1, spec: buildTransitionSpec({ fromClipId: "c1", toClipId: "c2", type: "film_crossfade", durationFrames: 6 }, 24) },
    ];
    const { filterChain, outputLabel } = buildVideoTransitionGraph(2, clipDurationsSec, filmTransitions, context);
    expect(filterChain).toContain("xfade=transition=fade:duration=0.250000:offset=0.750000");
    expect(filterChain).not.toContain("gblur");
    expect(filterChain).not.toContain("geq");
    expect(outputLabel).toBe("[vout]");
  });

  it("fails closed when a preset window is requested without graph context", () => {
    expect(() => buildVideoTransitionGraph(2, clipDurationsSec, transitions)).toThrow(
      /graph context .* required to render the light_leak_flash preset/,
    );
  });

  it("fails closed when the preset window cannot fit the overlap", () => {
    // 0 duration-ish overlap: clip A long enough but xfade window bigger than
    // the accumulated offset — start frame would go negative.
    const badDurations = [2 / 24, 30 / 24];
    expect(() => buildVideoTransitionGraph(2, badDurations, transitions, context)).toThrow(
      /invalid light_leak_flash window/,
    );
  });

  it("chains multiple preset windows sequentially", () => {
    const threeClips = [24 / 24, 30 / 24, 24 / 24];
    const multi = [
      { fromIndex: 0, toIndex: 1, spec: buildTransitionSpec({ fromClipId: "c1", toClipId: "c2", type: "light_leak_flash", durationFrames: 6 }, 24) },
      { fromIndex: 1, toIndex: 2, spec: buildTransitionSpec({ fromClipId: "c2", toClipId: "c3", type: "dreamy_focus_blur", durationFrames: 6 }, 24) },
    ];
    const { filterChain, outputLabel } = buildVideoTransitionGraph(3, threeClips, multi, context);
    // Flash window is extended to [18, 30) by the decay tail.
    expect(filterChain).toContain("trim=start_frame=18:end_frame=30");
    // Second window: offset = (0.75 + 1.25) - 0.25 = 1.75s → frame 42;
    // window [42, 48) = third clip's head-extended overlap.
    expect(filterChain).toContain("trim=start_frame=42:end_frame=48");
    expect(outputLabel).toBe("[vout2]");
  });

  // ── Degenerate windows (D < 2) ────────────────────────────────────────

  it("degrades a degenerate 1-frame dreamy window to the unstyled crossfade (no NaN, no black frames)", () => {
    // The triangle ramp divides by (D - 1) == 0 for D == 1; the graph must
    // not emit it. NaN mix expressions render as black frames in ffmpeg.
    const oneFrame = [
      { fromIndex: 0, toIndex: 1, spec: buildTransitionSpec({ fromClipId: "c1", toClipId: "c2", type: "dreamy_focus_blur", durationFrames: 1 }, 24) },
    ];
    const { filterChain, outputLabel } = buildVideoTransitionGraph(2, [24 / 24, 30 / 24], oneFrame, context);
    expect(filterChain).toContain("xfade=transition=fade:duration=0.041667:offset=0.958333");
    expect(filterChain).not.toContain("gblur");
    expect(filterChain).not.toContain("blend=all_expr");
    expect(filterChain).not.toContain("/0");
    expect(outputLabel).toBe("[vout]");
  });

  it("keeps a 1-frame light_leak_flash styling window valid", () => {
    // The flash envelope (chained fades) is well-defined for D == 1: the
    // single blend frame carries zero flare and the seam frame peaks.
    const oneFrame = [
      { fromIndex: 0, toIndex: 1, spec: buildTransitionSpec({ fromClipId: "c1", toClipId: "c2", type: "light_leak_flash", durationFrames: 1 }, 24) },
    ];
    const { filterChain, outputLabel } = buildVideoTransitionGraph(2, [24 / 24, 30 / 24], oneFrame, context);
    expect(filterChain).toContain("trim=start_frame=23:end_frame=25");
    expect(filterChain).toContain("fade=t=in:st=0:d=0.041667");
    expect(filterChain).toContain("fade=t=out:st=0.041667:d=0.041667");
    expect(filterChain).not.toContain("/0");
    expect(outputLabel).toBe("[vout1]");
  });
});

// ── Audio duration neutrality ─────────────────────────────────────────

describe("audio graph under overlap geometry", () => {
  it("keeps the audio output duration equal to the timeline duration", () => {
    // Overlap geometry: A 24f, B head-extended 30f, D 6f.
    const clipDurationsSec = [24 / 24, 30 / 24];
    const audioGraph = buildAudioTransitionGraph(
      2,
      clipDurationsSec,
      [
        {
          fromIndex: 0,
          toIndex: 1,
          spec: buildTransitionSpec({ fromClipId: "c1", toClipId: "c2", type: "light_leak_flash", durationFrames: 6 }, 24),
        },
      ],
    );
    expect(audioGraph.filterChain).toContain("acrossfade=d=0.250000:c1=tri:c2=tri");
    // acc = 1.0 - 0.25 + 1.25 = 2.0s = 48 frames = timeline total (Gap/Overrun 0).
    const totalAfter = 24 / 24 - 6 / 24 + 30 / 24;
    expect(totalAfter).toBeCloseTo(48 / 24, 9);
    expect(audioGraph.outputLabel).toBe("[aout]");
  });
});

// ── Chain args integration ────────────────────────────────────────────

describe("buildTransitionChainArgs with graphContext", () => {
  it("embeds the styled preset windows into the single-generation graph", () => {
    const args = buildTransitionChainArgs({
      inputs: [
        { kind: "source", sourcePath: "/tmp/a.mp4", sourceInSec: 0, durationSec: 1, videoFilter: "format=yuv420p,setsar=1", hasAudio: false },
        { kind: "source", sourcePath: "/tmp/b.mp4", sourceInSec: 1, durationSec: 1.25, videoFilter: "format=yuv420p,setsar=1", hasAudio: false },
      ],
      clipDurationsSec: [1, 1.25],
      transitions: [
        { fromIndex: 0, toIndex: 1, spec: buildTransitionSpec({ fromClipId: "c1", toClipId: "c2", type: "light_leak_flash", durationFrames: 6 }, 24) },
      ],
      includeAudio: false,
      videoEncodeArgs: ["-c:v", "libx264"],
      outputFps: "24/1",
      graphContext: context,
      outputPath: "/tmp/out.mp4",
    });
    const filterIndex = args.indexOf("-filter_complex");
    expect(filterIndex).toBeGreaterThan(0);
    const graph = args[filterIndex + 1];
    expect(graph).toContain("xfade=transition=fade:duration=0.250000:offset=0.750000");
    expect(graph).toContain("trim=start_frame=18:end_frame=30");
    expect(graph).toContain("blend=all_mode=screen:shortest=1");
    expect(args[args.length - 1]).toBe("/tmp/out.mp4");
  });
});

// ── Three-way window agreement ────────────────────────────────────────
// The Remotion Sequence span (resolveTransitionWindow), the compiler's
// post-overlap provenance (chorus_entry flash frames), and the ffmpeg
// filtergraph envelope (trim + chained fades) must all describe the same
// absolute frames — ramp to the seam, decay after it.

describe("Remotion window == compiler metadata == ffmpeg envelope", () => {
  const fps = 24;
  const overlap = 6;

  const compileFlash = () => {
    const clipA = {
      clip_id: "CLP_A", segment_id: "SEG_A", asset_id: "AST_A",
      src_in_us: 0, src_out_us: 1_000_000,
      timeline_in_frame: 0, timeline_duration_frames: 24,
      role: "hero", motivation: "verse", beat_id: "b01",
      fallback_segment_ids: [], confidence: 1, quality_flags: [],
    };
    const clipB = {
      clip_id: "CLP_B", segment_id: "SEG_B", asset_id: "AST_B",
      src_in_us: 1_000_000, src_out_us: 3_000_000,
      timeline_in_frame: 24, timeline_duration_frames: 48,
      role: "hero", motivation: "chorus", beat_id: "b02",
      fallback_segment_ids: [], confidence: 1, quality_flags: [],
    };
    const transition = {
      transition_id: "tr_0000",
      from_clip_id: "CLP_A",
      to_clip_id: "CLP_B",
      track_id: "V1",
      transition_type: "light_leak_flash" as const,
      transition_params: { crossfade_sec: overlap / fps, easing: "linear" as const },
      metadata: { chorus_entry: { section_id: "S2", flash_start_frame: 24 } },
    };
    const track = { track_id: "V1", kind: "video", clips: [clipA, clipB] };
    const result = applyTransitionOverlaps(track as never, [transition as never], { fpsNum: fps, fpsDen: 1 });
    expect(result.applied).toHaveLength(1);
    return { clipB, transition };
  };

  it("agrees for a light_leak_flash at a hostile nonzero start", () => {
    const { clipB, transition } = compileFlash();
    const metadata = transition.metadata as unknown as {
      overlap_applied: { overlap_frames: number; seam_frame: number };
      chorus_entry: Record<string, number>;
    };
    const seam = metadata.overlap_applied.seam_frame;
    const startFrame = clipB.timeline_in_frame; // what export.ts records as start_frame
    expect(seam).toBe(startFrame + overlap); // seam = window start + blend

    // Remotion: two-sided Sequence spanning [start, start + 2·blend).
    const win = resolveTransitionWindow(
      { transition_type: "light_leak_flash", start_frame: startFrame, duration_frames: overlap },
      clipB,
    );
    expect(win.startFrame).toBe(metadata.chorus_entry.flash_start_frame);
    expect(win.startFrame + win.blendFrames).toBe(metadata.chorus_entry.flash_peak_frame);
    expect(win.startFrame + win.durationInFrames).toBe(metadata.chorus_entry.flash_end_frame);
    expect(win.durationInFrames).toBe(overlap * 2);

    // ffmpeg: same trim window, chained fades split exactly at the seam.
    const graph = buildVideoTransitionGraph(
      2,
      [1, (48 + overlap) / fps],
      [{ fromIndex: 0, toIndex: 1, spec: buildTransitionSpec({ fromClipId: "CLP_A", toClipId: "CLP_B", type: "light_leak_flash", durationFrames: overlap }, fps) }],
      { width: 64, height: 32, fps },
    );
    expect(graph.filterChain).toContain(
      `trim=start_frame=${win.startFrame}:end_frame=${win.startFrame + win.durationInFrames}`,
    );
    expect(graph.filterChain).toContain(`fade=t=in:st=0:d=${(overlap / fps).toFixed(6)}`);
    expect(graph.filterChain).toContain(`fade=t=out:st=${(overlap / fps).toFixed(6)}:d=${(overlap / fps).toFixed(6)}`);
  });

  it("keeps non-flash presets at a single blend window", () => {
    const win = resolveTransitionWindow(
      { transition_type: "film_crossfade", start_frame: 18, duration_frames: 6 },
      { timeline_in_frame: 18 },
    );
    expect(win).toEqual({ startFrame: 18, blendFrames: 6, durationInFrames: 6 });
  });
});

// ── Schema acceptance ─────────────────────────────────────────────────

describe("timeline-ir schema (Issue #34 transition fields)", () => {
  let validate: ReturnType<Ajv["compile"]>;

  beforeAll(() => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const schema = JSON.parse(
      fs.readFileSync(path.join(SCHEMAS_DIR, "timeline-ir.schema.json"), "utf-8"),
    );
    validate = ajv.compile(schema);
  });

  const timelineWithTransition = (transition: Record<string, unknown>) => ({
    version: "1",
    project_id: "test",
    created_at: "2025-01-01T00:00:00Z",
    sequence: { name: "test", fps_num: 24, fps_den: 1, width: 1920, height: 1080, start_frame: 0 },
    tracks: {
      video: [{
        track_id: "V1",
        kind: "video",
        clips: [
          { clip_id: "c1", segment_id: "s1", asset_id: "a1", src_in_us: 500000, src_out_us: 1500000, timeline_in_frame: 0, timeline_duration_frames: 24, role: "hero", motivation: "test" },
          { clip_id: "c2", segment_id: "s2", asset_id: "a2", src_in_us: 1500000, src_out_us: 2750000, timeline_in_frame: 18, timeline_duration_frames: 30, role: "hero", motivation: "test" },
        ],
      }],
      audio: [],
    },
    markers: [],
    transitions: [transition],
    provenance: {
      brief_path: "brief.yaml",
      blueprint_path: "blueprint.yaml",
      selects_path: "selects.yaml",
    },
  });

  it("accepts light_leak_flash with start_frame, duration_frames and linear easing", () => {
    const timeline = timelineWithTransition({
      transition_id: "tr_0000",
      from_clip_id: "c1",
      to_clip_id: "c2",
      track_id: "V1",
      transition_type: "light_leak_flash",
      transition_frames: 6,
      start_frame: 18,
      duration_frames: 6,
      transition_params: {
        crossfade_sec: 0.25,
        easing: "linear",
        cut_frame_before_snap: 24,
        cut_frame_after_snap: 24,
        snap_delta_frames: 0,
      },
      metadata: {
        chorus_entry: { section_id: "S2", flash_start_frame: 24 },
      },
    });
    expect(validate(timeline)).toBe(true);
  });

  it("accepts dreamy_focus_blur and film_crossfade types", () => {
    for (const type of ["dreamy_focus_blur", "film_crossfade"]) {
      const timeline = timelineWithTransition({
        transition_id: "tr_0000",
        from_clip_id: "c1",
        to_clip_id: "c2",
        track_id: "V1",
        transition_type: type,
        transition_frames: 6,
        transition_params: { crossfade_sec: 0.25, easing: "linear" },
      });
      expect(validate(timeline)).toBe(true);
    }
  });

  it("accepts overlap provenance metadata on an applied flash transition", () => {
    // The schema route must accept the post-geometry provenance the compiler
    // records: the physical overlap plus the rendered flash window.
    const timeline = timelineWithTransition({
      transition_id: "tr_0000",
      from_clip_id: "c1",
      to_clip_id: "c2",
      track_id: "V1",
      transition_type: "light_leak_flash",
      transition_frames: 6,
      start_frame: 18,
      duration_frames: 6,
      transition_params: { crossfade_sec: 0.25, easing: "linear" },
      metadata: {
        overlap_applied: { overlap_frames: 6, seam_frame: 24 },
        chorus_entry: {
          section_id: "S2",
          flash_start_frame: 18,
          flash_peak_frame: 24,
          flash_end_frame: 30,
        },
      },
    });
    expect(validate(timeline)).toBe(true);
  });

  it("accepts a degraded preset with its recorded fallback provenance", () => {
    const timeline = timelineWithTransition({
      transition_id: "tr_0000",
      from_clip_id: "c1",
      to_clip_id: "c2",
      track_id: "V1",
      transition_type: "cut",
      transition_params: { cut_frame_before_snap: 24, cut_frame_after_snap: 24, snap_delta_frames: 0 },
      fallback: { type: "cut", reason: "overlap_preset_unrenderable:insufficient_source_head_handle" },
      metadata: { degraded_reason: "transition_overlap_insufficient_source_head_handle" },
    });
    expect(validate(timeline)).toBe(true);
  });

  it("rejects an unknown easing law", () => {
    const timeline = timelineWithTransition({
      transition_id: "tr_0000",
      from_clip_id: "c1",
      to_clip_id: "c2",
      track_id: "V1",
      transition_type: "light_leak_flash",
      transition_params: { crossfade_sec: 0.25, easing: "elastic" },
    });
    expect(validate(timeline)).toBe(false);
  });
});
