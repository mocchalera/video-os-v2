import { describe, expect, it } from "vitest";
import * as path from "node:path";
import {
  buildStillHoldResolutionContext,
  resolveStillDurationPolicy,
  resolveStillImageHold,
} from "../runtime/artifacts/still-image-policy.js";
import { normalize } from "../runtime/compiler/normalize.js";
import {
  assertStillImageTimelineTruth,
} from "../runtime/compiler/still-image.js";
import type {
  CreativeBrief,
  EditBlueprint,
  StillImageTimelineMetadata,
  TimelineClip,
  TimelineIR,
} from "../runtime/compiler/types.js";
import {
  buildTimelineIR,
} from "../runtime/compiler/export.js";
import { applyIntentionalStillReuseExemptions } from "../runtime/compiler/index.js";
import {
  buildVideoAssemblyPlan,
  buildStillVideoFilter,
  resolveStillRenderMotion,
} from "../runtime/render/assembler.js";
import { resolveStillClipMotion } from "../runtime/render/remotion/still-render-capability.js";
import { loadProfiles, resolveProfileAndPolicy } from "../runtime/editorial/policy-resolver.js";

const profilesDir = path.resolve("runtime/editorial/profiles");

function lyricStill(overrides: Partial<StillImageTimelineMetadata> = {}): StillImageTimelineMetadata {
  return {
    hold_frames: 48,
    min_hold_frames: 48,
    max_hold_frames: 288,
    hold_source: "candidate_override",
    policy_clamp: "none",
    motion_mode: "static",
    fit_mode: "cover",
    background: "black",
    ...overrides,
  };
}

function imageClip(
  clipId: string,
  startFrame: number,
  still: StillImageTimelineMetadata,
): TimelineClip {
  return {
    clip_id: clipId,
    segment_id: `${clipId}_SEG`,
    asset_id: "asset-still-a",
    src_in_us: 0,
    src_out_us: 1,
    timeline_in_frame: startFrame,
    timeline_duration_frames: still.hold_frames,
    role: "hero",
    motivation: "issue43 fixture",
    beat_id: clipId,
    fallback_segment_ids: [],
    confidence: 1,
    quality_flags: [],
    media_kind: "image",
    still_image: still,
  };
}

describe("Issue #43 M1 lyric_mv profile and still-instance contract", () => {
  it("selects lyric_mv before talking-head inference for image-plus-music inputs", () => {
    const profiles = loadProfiles(profilesDir);
    const result = resolveProfileAndPolicy({
      sourceMedia: {
        mode: "mixed",
        media_kinds: ["image", "audio"],
        visual_candidate_count: 6,
        audio_only_candidate_count: 1,
      },
      audioPolicy: "bgm_only",
      editorialSummary: {
        speaker_topology: "solo_primary",
        dominant_visual_mode: "talking_head",
      } as never,
    }, profilesDir);

    expect(result.resolvedProfile.id).toBe("lyric_mv");
    expect(result.resolvedProfile.source).toBe("inferred");
    expect(result.profileDefaults?.lyric_mv_thresholds).toEqual({
      background_hold: { min_sec: 2, target_sec: 4, max_sec: 12, intentional_long_hold_sec: 8 },
      caption_cadence: { min_sec: 2, target_sec: 3, max_sec: 4 },
      music_section_cadence: { min_sec: 8, target_sec: 16, max_sec: 32 },
      motion_cadence: { min_sec: 4, target_sec: 8, max_sec: 12 },
    });
    expect(result.profileDefaults?.max_shot_length_frames).toBeUndefined();
    expect(profiles.get("lyric_mv")?.default_policy).toBe("generic");

    const talkingHead = resolveProfileAndPolicy({
      sourceMedia: {
        mode: "video",
        media_kinds: ["video", "audio"],
        visual_candidate_count: 3,
        audio_only_candidate_count: 0,
      },
      runtimeTargetSec: 60,
      briefEditorial: { aspect_ratio: "16:9" },
      editorialSummary: { speaker_topology: "solo_primary" } as never,
    }, profilesDir);
    expect(talkingHead.resolvedProfile.id).toBe("interview-highlight");
  });

  it("retains frames, seconds, beats, and section-boundary holds with boundary evidence", () => {
    const profile = loadProfiles(profilesDir).get("lyric_mv")!;
    const policy = resolveStillDurationPolicy({}, profile.defaults, 24, 1);
    const context = buildStillHoldResolutionContext({
      beats: [{ time_sec: 0 }, { time_sec: 0.5 }, { time_sec: 1 }],
      beats_sec: [0, 0.5, 1],
      sections: [
        { id: "verse-1", label: "verse", start_sec: 0, end_sec: 4, energy: 0.4 },
      ],
    }, 24, 1);

    const frames = resolveStillImageHold({ still_image: { hold: { unit: "frames", value: 72 } } }, policy, 240, context);
    expect(frames.hold_frames).toBe(72);
    expect(frames.hold_resolution).toMatchObject({ unit: "frames", requested_frames: 72, resolved_frames: 72 });

    const seconds = resolveStillImageHold({ still_image: { hold: { unit: "seconds", value: 3 } } }, policy, 240, context);
    expect(seconds.hold_resolution).toMatchObject({ unit: "seconds", requested_frames: 72, resolved_frames: 72 });

    const beats = resolveStillImageHold({ still_image: { hold: { unit: "beats", value: 4 } } }, policy, 240, context);
    expect(beats.hold_resolution).toMatchObject({ unit: "beats", requested_frames: 48, resolved_frames: 48 });

    const boundary = resolveStillImageHold({ still_image: {
      hold: { unit: "section_boundary", section_id: "verse-1", boundary: "end", reason: "hold through verse boundary" },
    } }, policy, 240, context, 24);
    expect(boundary.hold_frames).toBe(72);
    expect(boundary.hold_resolution).toMatchObject({
      unit: "section_boundary",
      section_id: "verse-1",
      boundary: "end",
      boundary_frame: 96,
      requested_frames: 72,
      resolved_frames: 72,
    });

    expect(() => resolveStillImageHold({ still_image: { hold: { unit: "beats", value: 2 } } }, policy, 240))
      .toThrow("still_hold_context_missing:beats");
    expect(() => resolveStillImageHold({ still_image: { hold: { unit: "section_boundary", section_id: "verse-1" } } }, policy, 240, context))
      .toThrow("still_hold_boundary_missing");
  });

  it("does not drop authored candidate-plan still fields during normalization", () => {
    const brief = {
      version: "1",
      project_id: "p43",
      project: { id: "p43", title: "Issue 43", strategy: "lyric_mv" },
    } as CreativeBrief;
    const blueprint = {
      version: "1",
      project_id: "p43",
      sequence_goals: [],
      beats: [{
        id: "b01",
        label: "verse",
        target_duration_frames: 96,
        required_roles: ["hero"],
        preferred_roles: [],
        purpose: "lyrics",
        candidate_plan: {
          primary_candidate_ref: "cand-a",
          still_image: {
            source_still_id: "still-a",
            still_instance_id: "inst-a",
            reuse: "intentional",
            hold: { unit: "beats", value: 4, section_id: "verse-1", boundary: "end", reason: "phrase landing" },
            transform: { crop: { x: 0.1, y: 0.1, width: 0.7, height: 0.7 }, zoom: 1.2 },
            ken_burns: { preset: "push_in", intensity: 0.1 },
          },
          freeze_frame_hold: { source_time_us: 0, hold_frames: 12 },
        },
      }],
    } as unknown as EditBlueprint;
    const normalized = normalize(brief, blueprint);
    expect(normalized.beats[0].candidate_plan).toMatchObject({
      primary_candidate_ref: "cand-a",
      still_image: {
        source_still_id: "still-a",
        still_instance_id: "inst-a",
        reuse: "intentional",
        hold: { unit: "beats", value: 4, section_id: "verse-1", boundary: "end" },
        transform: { zoom: 1.2 },
        ken_burns: { preset: "push_in" },
      },
      freeze_frame_hold: { source_time_us: 0, hold_frames: 12 },
    });
  });

  it("keeps source identity separate from unique timeline instance identity", () => {
    const first = imageClip("CLP_0001", 0, lyricStill({
      source_still_id: "still-a",
      still_instance_id: "inst-a-1",
      reuse: "unique",
      transform: { crop: { x: 0, y: 0, width: 0.8, height: 0.8 }, anchor: { x: 0.2, y: 0.2 } },
    }));
    const second = imageClip("CLP_0002", 48, lyricStill({
      source_still_id: "still-a",
      still_instance_id: "inst-a-2",
      reuse: "intentional",
      transform: { crop: { x: 0.2, y: 0.1, width: 0.7, height: 0.7 }, zoom: 1.3, pan: { x: 0.2, y: -0.1 } },
    }));
    assertStillImageTimelineTruth([first, second]);
    expect(first.asset_id).toBe(second.asset_id);
    expect(first.still_image?.source_still_id).toBe(second.still_image?.source_still_id);
    expect(first.still_image?.still_instance_id).not.toBe(second.still_image?.still_instance_id);
    expect(() => assertStillImageTimelineTruth([
      first,
      imageClip("CLP_0003", 48, lyricStill({ source_still_id: "still-a", still_instance_id: "inst-a-1" })),
    ])).toThrow("still_image_instance_identity_duplicate:inst-a-1");
  });

  it("does not turn an accidental still repeat into a continuity waiver", () => {
    const candidate = (candidateId: string, stillImage?: Record<string, unknown>) => ({
      candidate_id: candidateId,
      segment_id: candidateId,
      asset_id: "asset-still-a",
      src_in_us: 0,
      src_out_us: 1,
      role: "hero",
      why_it_matches: "issue43 fixture",
      risks: [],
      confidence: 1,
      media_kind: "image",
      ...(stillImage ? { still_image: stillImage } : {}),
    });
    const unmarkedBeats = [
      { beat_id: "b1", candidate_plan: { primary_candidate_ref: "cand-1" } },
      { beat_id: "b2", candidate_plan: { primary_candidate_ref: "cand-2" } },
    ] as never[];
    applyIntentionalStillReuseExemptions(
      unmarkedBeats as never,
      [candidate("cand-1"), candidate("cand-2")] as never,
    );
    expect(unmarkedBeats[1]).not.toHaveProperty("allow_revisit");

    const intentionalBeats = [
      { beat_id: "b1", candidate_plan: { primary_candidate_ref: "cand-1" } },
      { beat_id: "b2", candidate_plan: { primary_candidate_ref: "cand-2" } },
    ] as never[];
    applyIntentionalStillReuseExemptions(
      intentionalBeats as never,
      [candidate("cand-1"), candidate("cand-2", { reuse: "intentional" })] as never,
    );
    expect(intentionalBeats[1]).toMatchObject({
      allow_revisit: { asset_ids: ["asset-still-a"], reason: "lyric_mv intentional still instance reuse" },
    });
  });

  it("carries instance framing through assembly planning and timeline export", () => {
    const still = lyricStill({
      source_still_id: "still-a",
      still_instance_id: "inst-a-1",
      reuse: "intentional",
      transform: { crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, zoom: 1.2 },
      parallax: { amount: 0.04, axis: "horizontal" },
      hold: { unit: "beats", value: 4, section_id: "verse-1", boundary: "end", reason: "section landing" },
      hold_resolution: { unit: "beats", requested_frames: 48, resolved_frames: 48, section_id: "verse-1", boundary: "end", boundary_frame: 48, status: "resolved" },
    });
    const clip = imageClip("CLP_0001", 0, still);
    const clipTwo = imageClip("CLP_0002", 48, lyricStill({
      source_still_id: "still-a",
      still_instance_id: "inst-a-2",
      reuse: "intentional",
      transform: { crop: { x: 0.2, y: 0.2, width: 0.6, height: 0.6 }, zoom: 1.4 },
    }));
    const timeline = {
      version: "1",
      project_id: "p43",
      created_at: "2026-09-01T00:00:00.000Z",
      sequence: { name: "p43", fps_num: 24, fps_den: 1, width: 1080, height: 1920, start_frame: 0 },
      tracks: { video: [{ track_id: "V1", kind: "video", clips: [clip, clipTwo] }], audio: [] },
      markers: [],
      provenance: { brief_path: "brief.yaml", blueprint_path: "blueprint.yaml", selects_path: "selects.yaml", compiler_version: "1" },
    } as TimelineIR;
    const plan = buildVideoAssemblyPlan(timeline, new Set(["asset-still-a"]));
    expect(plan.filter((entry) => entry.still)).toHaveLength(2);
    expect(plan[0].still).toMatchObject({ source_still_id: "still-a", still_instance_id: "inst-a-1", transform: still.transform });
    expect(plan[1].still).toMatchObject({ source_still_id: "still-a", still_instance_id: "inst-a-2" });

    const exported = buildTimelineIR({ tracks: { video: [{ track_id: "V1", kind: "video", clips: [clip] }], audio: [] }, markers: [] }, {
      projectId: "p43",
      projectTitle: "Issue 43",
      projectPath: ".",
      createdAt: "2026-09-01T00:00:00.000Z",
      briefRelPath: "brief.yaml",
      blueprintRelPath: "blueprint.yaml",
      selectsRelPath: "selects.yaml",
      fpsNum: 24,
      fpsDen: 1,
      width: 1080,
      height: 1920,
    });
    expect(exported.tracks.video[0].clips[0].still_image).toMatchObject({
      source_still_id: "still-a",
      still_instance_id: "inst-a-1",
      transform: still.transform,
      hold_resolution: still.hold_resolution,
    });
  });

  it("routes Ken Burns/parallax through the #33 planner and fails unsupported Remotion paths explicitly", () => {
    const still = lyricStill({
      motion_mode: "camera_motion",
      camera_motion: {
        preset: "pan_zoom",
        easing: "linear",
        intensity: 0.12,
        frame_count: 48,
        policy: "still-camera-motion/v1",
        transform: { crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, zoom: 1.15, anchor: { x: 0.3, y: 0.4 } },
        parallax: { amount: 0.03, axis: "both" },
      },
      transform: { crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, zoom: 1.15, anchor: { x: 0.3, y: 0.4 } },
      parallax: { amount: 0.03, axis: "both" },
    });
    const resolved = resolveStillRenderMotion(still, { width: 1080, height: 1080, frameCount: 48 });
    expect(resolved.motion).toMatchObject({ frame_count: 48, transform: still.transform, parallax: still.parallax });
    expect(buildStillVideoFilter(1080, 1920, "cover", "black", still.transform)).toContain("crop=iw*0.8:ih*0.8:iw*0.1:ih*0.1");
    expect(() => resolveStillClipMotion(lyricStill({
      transform: { zoom: 1.2 },
      motion_mode: "static",
    }), 48)).toThrow("still_image_transform_remotion_unsupported");
    expect(() => resolveStillClipMotion(still, 48)).toThrow("still_camera_motion_remotion_unsupported");
  });
});
