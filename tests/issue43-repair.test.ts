// Issue #43 repair regressions.
// These assertions intentionally fail against the M2 candidate until the
// variable-tempo hold and still-overlap synchronization fixes are applied.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ingestAsset } from "../runtime/connectors/ffprobe.js";
import {
  buildStillHoldResolutionContext,
  resolveStillDurationPolicy,
  resolveStillImageHold,
} from "../runtime/artifacts/still-image-policy.js";
import { assemble } from "../runtime/compiler/assemble.js";
import { buildTimelineIR } from "../runtime/compiler/export.js";
import { normalize } from "../runtime/compiler/normalize.js";
import { assertStillImageTimelineTruth } from "../runtime/compiler/still-image.js";
import type { Candidate, CreativeBrief, EditBlueprint, TimelineClip, Track } from "../runtime/compiler/types.js";
import type { TimelineTransition } from "../runtime/compiler/transition-types.js";
import { applyTransitionOverlaps } from "../runtime/compiler/transition-overlap.js";
import { validateAgainstSchema } from "../runtime/commands/shared.js";
import { assembleTimelineToMp4, buildVideoAssemblyPlan } from "../runtime/render/assembler.js";

const repairTempDirs: string[] = [];
const ISSUE43_TEST_STILL_CAMERA = {
  pythonBinary: process.execPath,
  workerPath: path.resolve("tests/fixtures/still-camera-test-worker.mjs"),
};

afterEach(() => {
  for (const dir of repairTempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function ffmpeg(args: string[]): void {
  execFileSync("ffmpeg", ["-v", "error", ...args], { stdio: ["ignore", "pipe", "pipe"] });
}

function ffprobeFrameCount(outputPath: string): number {
  const value = execFileSync("ffprobe", [
    "-v", "error", "-count_frames", "-select_streams", "v:0",
    "-show_entries", "stream=nb_read_frames", "-of", "default=nw=1:nk=1", outputPath,
  ], { encoding: "utf8" }).trim();
  return Number(value);
}

function repairCandidate(
  candidateId: string,
  beatId: string,
  mediaKind: "image" | "video",
): Candidate {
  return {
    candidate_id: candidateId,
    segment_id: `SEG_${candidateId}`,
    asset_id: `AST_${candidateId}`,
    src_in_us: 0,
    src_out_us: mediaKind === "image" ? 1 : 2_000_000,
    role: "hero",
    why_it_matches: "Issue #43 repair fixture",
    risks: [],
    confidence: 1,
    semantic_rank: 1,
    eligible_beats: [beatId],
    media_kind: mediaKind,
    // Image candidates are visual timeline material even though their source
    // has no temporal video stream.
    source_capabilities: { has_video: true, has_audio: false },
    ...(mediaKind === "image"
      ? { still_image: { hold: { unit: "beats" as const, value: 1 } } }
      : {}),
  };
}

async function createOverlapRenderProject(): Promise<{
  projectDir: string;
  fromAsset: Awaited<ReturnType<typeof ingestAsset>>;
  stillAsset: Awaited<ReturnType<typeof ingestAsset>>;
}> {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-issue43-repair-render-"));
  repairTempDirs.push(projectDir);
  const fromPath = path.join(projectDir, "02_media/from.mp4");
  const stillPath = path.join(projectDir, "02_media/still.png");
  fs.mkdirSync(path.dirname(fromPath), { recursive: true });
  ffmpeg(["-f", "lavfi", "-i", "color=c=red:s=64x64:r=24:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", fromPath]);
  ffmpeg(["-f", "lavfi", "-i", "color=c=blue:s=64x64", "-frames:v", "1", "-y", stillPath]);
  const fromAsset = await ingestAsset(fromPath, { projectRoot: projectDir, mediaKind: "video", ffmpegVersion: "issue43-repair" });
  const stillAsset = await ingestAsset(stillPath, { projectRoot: projectDir, mediaKind: "image", ffmpegVersion: "issue43-repair" });
  fs.writeFileSync(path.join(projectDir, "02_media/source_map.json"), JSON.stringify({
    version: "1",
    project_id: "issue43-repair-render",
    media_dir: "02_media",
    generated_at: "2026-09-01T00:00:00.000Z",
    items: [
      { asset_id: fromAsset.asset_id, source_locator: "02_media/from.mp4", local_source_path: "02_media/from.mp4", link_path: "from.mp4", media_kind: "video", source_content_sha256: fromAsset.source_content_sha256 },
      { asset_id: stillAsset.asset_id, source_locator: "02_media/still.png", local_source_path: "02_media/still.png", link_path: "still.png", media_kind: "image", source_content_sha256: stillAsset.source_content_sha256 },
    ],
  }, null, 2));
  fs.mkdirSync(path.join(projectDir, "03_analysis"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "03_analysis/assets.json"), JSON.stringify({ items: [fromAsset, stillAsset] }, null, 2));
  fs.mkdirSync(path.join(projectDir, "05_timeline"), { recursive: true });
  return { projectDir, fromAsset, stillAsset };
}

describe("Issue #43 boundary repairs", () => {
  it("uses the next real variable-tempo beat boundary from an off-grid clip start", () => {
    const context = buildStillHoldResolutionContext({
      // 24fps => [0, 12, 24, 48] frames; the final interval is intentionally
      // twice the preceding interval so a median-duration shortcut is wrong.
      beats: [0, 0.5, 1, 2].map((time_sec) => ({ time_sec })),
      beats_sec: [0, 0.5, 1, 2],
      sections: [{ id: "verse-1", label: "verse", start_sec: 0, end_sec: 2.5, energy: 0.5 }],
    }, 24, 1);
    const policy = resolveStillDurationPolicy({
      still_image_intent: { min_hold_sec: 0.25, default_hold_sec: 1, max_hold_sec: 10 },
    }, undefined, 24, 1);

    const resolved = resolveStillImageHold(
      { still_image: { hold: { unit: "beats", value: 1 } } },
      policy,
      240,
      context,
      24,
    );

    expect(context?.beat_frames).toEqual([0, 12, 24, 48]);
    expect(resolved.hold_resolution).toMatchObject({
      unit: "beats",
      requested_frames: 24,
      resolved_frames: 24,
      boundary_frame: 48,
      status: "resolved",
    });
  });

  it("fails closed when a variable beat boundary is unavailable or frame-ambiguous", () => {
    const policy = resolveStillDurationPolicy({
      still_image_intent: { min_hold_sec: 0.25, default_hold_sec: 1, max_hold_sec: 10 },
    }, undefined, 24, 1);
    const incomplete = buildStillHoldResolutionContext({
      beats: [0, 0.5, 1.5].map((time_sec) => ({ time_sec })),
      beats_sec: [0, 0.5, 1.5],
      sections: [],
    }, 24, 1);
    expect(() => resolveStillImageHold(
      { still_image: { hold: { unit: "beats", value: 1 } } },
      policy,
      240,
      incomplete,
      36,
    )).toThrow("still_hold_beat_boundary_unresolvable");

    const ambiguous = buildStillHoldResolutionContext({
      beats: [0, 0.01, 0.5].map((time_sec) => ({ time_sec })),
      beats_sec: [0, 0.01, 0.5],
      sections: [],
    }, 24, 1);
    expect(() => resolveStillImageHold(
      { still_image: { hold: { unit: "beats", value: 1 } } },
      policy,
      240,
      ambiguous,
      0,
    )).toThrow("still_hold_beat_boundary_unresolvable");
  });

  it("preserves an off-grid variable-tempo hold through assembly and render-plan receipts", () => {
    const brief = {
      project: { id: "issue43-repair-compile", title: "Issue 43 repair" },
    } as CreativeBrief;
    const blueprint = {
      beats: [
        { id: "b01", label: "opening", target_duration_frames: 26, required_roles: ["hero"], preferred_roles: [], purpose: "opening" },
        { id: "b02", label: "variable beat hold", target_duration_frames: 48, required_roles: ["hero"], preferred_roles: [], purpose: "hold" },
      ],
    } as unknown as EditBlueprint;
    const normalized = normalize(brief, blueprint);
    const first = repairCandidate("VIDEO", "b01", "video");
    const second = repairCandidate("STILL", "b02", "image");
    const ranked = new Map([
      ["b01", [{ candidate: first, beat_id: "b01", score: 1, breakdown: {} }]],
      ["b02", [{ candidate: second, beat_id: "b02", score: 1, breakdown: {} }]],
    ]) as never;
    const policy = resolveStillDurationPolicy({
      still_image_intent: { min_hold_sec: 0.25, default_hold_sec: 1, max_hold_sec: 10 },
    }, undefined, 24, 1);
    const context = buildStillHoldResolutionContext({
      beats: [0, 0.5, 1, 2].map((time_sec) => ({ time_sec })),
      beats_sec: [0, 0.5, 1, 2],
      sections: [{ id: "verse-1", label: "verse", start_sec: 0, end_sec: 2.5, energy: 0.5 }],
    }, 24, 1);
    const assembled = assemble(normalized, ranked, {
      motif_reuse_max: 3,
      adjacency_penalty: 0,
      beat_alignment_tolerance_frames: 12,
      duration_fit_tolerance_frames: 0,
      quality_flag_penalty: 0,
    }, 24, 1, undefined, { stillDurationPolicy: policy, stillHoldContext: context });
    const timeline = buildTimelineIR(assembled, {
      projectId: "issue43-repair-compile",
      projectTitle: "Issue 43 repair",
      projectPath: path.resolve("tests"),
      createdAt: "2026-09-01T00:00:00.000Z",
      briefRelPath: "01_intent/creative_brief.yaml",
      blueprintRelPath: "04_plan/edit_blueprint.yaml",
      selectsRelPath: "04_plan/selects_candidates.yaml",
      fpsNum: 24,
      fpsDen: 1,
      stillDurationPolicy: policy,
    });
    const stillClip = timeline.tracks.video[0].clips.find((clip) => clip.asset_id === "AST_STILL")!;
    expect(stillClip).toMatchObject({ timeline_in_frame: 26, timeline_duration_frames: 22 });
    expect(stillClip.still_image?.hold_resolution).toMatchObject({
      unit: "beats",
      requested_frames: 22,
      resolved_frames: 22,
      boundary_frame: 48,
      status: "resolved",
    });
    const renderPlan = buildVideoAssemblyPlan(timeline, new Set(["AST_STILL"]));
    expect(renderPlan.find((entry) => entry.clip_id === stillClip.clip_id)?.still?.hold_resolution)
      .toMatchObject({ unit: "beats", resolved_frames: 22, boundary_frame: 48 });
    expect(validateAgainstSchema(timeline, "timeline-ir.schema.json")).toMatchObject({ valid: true, errors: [] });
  });

  it("keeps moving-still hold and motion receipts synchronized after physical overlap", () => {
    const from: TimelineClip = {
      clip_id: "clip_from",
      segment_id: "SEG_FROM",
      asset_id: "AST_FROM",
      src_in_us: 0,
      src_out_us: 2_000_000,
      timeline_in_frame: 0,
      timeline_duration_frames: 48,
      role: "hero",
      motivation: "test",
      beat_id: "B_FROM",
      fallback_segment_ids: [],
      confidence: 1,
      quality_flags: [],
    };
    const movingStill: TimelineClip = {
      clip_id: "clip_still",
      segment_id: "SEG_STILL",
      asset_id: "AST_STILL",
      src_in_us: 0,
      src_out_us: 1,
      timeline_in_frame: 48,
      timeline_duration_frames: 48,
      role: "hero",
      motivation: "test",
      beat_id: "B_STILL",
      fallback_segment_ids: [],
      confidence: 1,
      quality_flags: [],
      media_kind: "image",
      still_image: {
        hold_frames: 48,
        min_hold_frames: 12,
        max_hold_frames: 96,
        hold_source: "candidate_override",
        policy_clamp: "none",
        hold_resolution: {
          unit: "section_boundary",
          section_id: "chorus-1",
          boundary: "end",
          boundary_frame: 96,
          requested_frames: 48,
          resolved_frames: 48,
          status: "resolved",
        },
        motion_mode: "camera_motion",
        camera_motion: {
          preset: "push_in",
          easing: "linear",
          intensity: 0.06,
          frame_count: 48,
          policy: "still-camera-motion/v1",
        },
        ken_burns: {
          preset: "push_in",
          easing: "linear",
          intensity: 0.06,
          frame_count: 48,
          policy: "still-camera-motion/v1",
        },
        fit_mode: "cover",
        background: "black",
      },
    };
    const track: Track = { track_id: "V1", kind: "video", clips: [from, movingStill] };
    const transition: TimelineTransition = {
      transition_id: "tr_still_overlap",
      from_clip_id: "clip_from",
      to_clip_id: "clip_still",
      track_id: "V1",
      transition_type: "film_crossfade",
      transition_params: { crossfade_sec: 6 / 24 },
    };

    const result = applyTransitionOverlaps(track, [transition], { fpsNum: 24, fpsDen: 1 });

    expect(result.applied).toHaveLength(1);
    expect(movingStill.timeline_in_frame).toBe(42);
    expect(movingStill.timeline_duration_frames).toBe(54);
    expect(movingStill.still_image?.hold_frames).toBe(54);
    expect(movingStill.still_image?.hold_resolution).toMatchObject({
      resolved_frames: 54,
      boundary_frame: 96,
      status: "clamped",
    });
    expect(movingStill.still_image?.camera_motion?.frame_count).toBe(54);
    expect(movingStill.still_image?.ken_burns?.frame_count).toBe(54);
    expect(() => assertStillImageTimelineTruth([from, movingStill])).not.toThrow();
  });

  it("carries moving-still overlap truth through canonical export and bounded render receipts", async () => {
    const fixture = await createOverlapRenderProject();
    const from: TimelineClip = {
      clip_id: "clip_from_render",
      segment_id: "SEG_FROM_RENDER",
      asset_id: fixture.fromAsset.asset_id,
      src_in_us: 0,
      src_out_us: 2_000_000,
      timeline_in_frame: 0,
      timeline_duration_frames: 48,
      role: "hero",
      motivation: "test",
      beat_id: "B_FROM_RENDER",
      fallback_segment_ids: [],
      confidence: 1,
      quality_flags: [],
      media_kind: "video",
    };
    const still: TimelineClip = {
      clip_id: "clip_still_render",
      segment_id: "SEG_STILL_RENDER",
      asset_id: fixture.stillAsset.asset_id,
      src_in_us: 0,
      src_out_us: 1,
      timeline_in_frame: 48,
      timeline_duration_frames: 48,
      role: "hero",
      motivation: "test",
      beat_id: "B_STILL_RENDER",
      fallback_segment_ids: [],
      confidence: 1,
      quality_flags: [],
      media_kind: "image",
      still_image: {
        source_still_id: "repair-still-source",
        still_instance_id: "repair-still-instance",
        hold_frames: 48,
        min_hold_frames: 12,
        max_hold_frames: 96,
        hold_source: "candidate_override",
        policy_clamp: "none",
        hold_resolution: {
          unit: "section_boundary",
          section_id: "chorus-1",
          boundary: "end",
          boundary_frame: 96,
          requested_frames: 48,
          resolved_frames: 48,
          status: "resolved",
        },
        motion_mode: "camera_motion",
        camera_motion: {
          preset: "push_in",
          easing: "linear",
          intensity: 0.06,
          frame_count: 48,
          policy: "still-camera-motion/v1",
        },
        ken_burns: {
          preset: "push_in",
          easing: "linear",
          intensity: 0.06,
          frame_count: 48,
          policy: "still-camera-motion/v1",
        },
        fit_mode: "cover",
        background: "black",
      },
    };
    const track: Track = { track_id: "V1", kind: "video", clips: [from, still] };
    const transition: TimelineTransition = {
      transition_id: "tr_still_render",
      from_clip_id: from.clip_id,
      to_clip_id: still.clip_id,
      track_id: "V1",
      transition_type: "film_crossfade",
      transition_params: { crossfade_sec: 6 / 24 },
    };
    const overlap = applyTransitionOverlaps(track, [transition], { fpsNum: 24, fpsDen: 1 });
    expect(overlap.applied).toHaveLength(1);

    const timeline = buildTimelineIR({ tracks: { video: [track], audio: [] }, markers: [] }, {
      projectId: "issue43-repair-render",
      projectTitle: "Issue 43 repair render",
      projectPath: fixture.projectDir,
      createdAt: "2026-09-01T00:00:00.000Z",
      briefRelPath: "01_intent/creative_brief.yaml",
      blueprintRelPath: "04_plan/edit_blueprint.yaml",
      selectsRelPath: "04_plan/selects_candidates.yaml",
      fpsNum: 24,
      fpsDen: 1,
      transitions: [transition],
    });
    const exportedStill = timeline.tracks.video[0].clips[1];
    expect(exportedStill).toMatchObject({ timeline_in_frame: 42, timeline_duration_frames: 54 });
    expect(exportedStill.still_image).toMatchObject({
      hold_frames: 54,
      hold_resolution: { resolved_frames: 54, boundary_frame: 96, status: "clamped" },
      camera_motion: { frame_count: 54 },
      ken_burns: { frame_count: 54 },
    });
    expect(validateAgainstSchema(timeline, "timeline-ir.schema.json")).toMatchObject({ valid: true, errors: [] });
    const renderPlan = buildVideoAssemblyPlan(timeline, new Set([fixture.stillAsset.asset_id]));
    expect(renderPlan.find((entry) => entry.clip_id === still.clip_id)?.still).toMatchObject({
      hold_resolution: { resolved_frames: 54, boundary_frame: 96, status: "clamped" },
      camera_motion: { frame_count: 54 },
    });

    const timelinePath = path.join(fixture.projectDir, "05_timeline/timeline.json");
    const outputPath = path.join(fixture.projectDir, "05_timeline/repair-overlap.mp4");
    fs.writeFileSync(timelinePath, JSON.stringify(timeline, null, 2));
    const render = await assembleTimelineToMp4({
      projectDir: fixture.projectDir,
      timelinePath,
      outputPath,
      includeAudio: false,
      stillCamera: ISSUE43_TEST_STILL_CAMERA,
    });
    expect(ffprobeFrameCount(render.outputPath)).toBe(96);
    expect(render.still_camera_motion).toEqual(expect.arrayContaining([
      expect.objectContaining({
        clip_id: still.clip_id,
        duration_frames: 54,
        hold: expect.objectContaining({
          unit: "section_boundary",
          resolved_frames: 54,
          boundary_frame: 96,
        }),
      }),
    ]));
  });
});
