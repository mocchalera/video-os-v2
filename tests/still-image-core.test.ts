import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import {
  resolveStillDurationPolicy,
  resolveStillImageHold,
  sanitizeStillBackground,
} from "../runtime/artifacts/still-image-policy.js";
import {
  assertStillImageCandidateGrounding,
  assertStillImageSegmentGrounding,
  readValidatedStillImageFrames,
  StillImageGroundingError,
} from "../runtime/artifacts/still-image-grounding.js";
import { applyPatch, type ReviewPatch } from "../runtime/compiler/patch.js";
import { computeBgmBonus, scoreCandidates } from "../runtime/compiler/score.js";
import { assemble } from "../runtime/compiler/assemble.js";
import { buildTimelineIR } from "../runtime/compiler/export.js";
import { applyDurationAdjust } from "../runtime/compiler/duration-adjust.js";
import { applyBeatSnap } from "../runtime/compiler/adjacency.js";
import { applyCutBreathTreatment } from "../runtime/compiler/cut-breath-treatment.js";
import { assertStillImageTimelineTruthForTimeline } from "../runtime/compiler/still-image.js";
import type {
  Candidate,
  NormalizedData,
  ScoringParams,
  StillDurationPolicy,
  TimelineIR,
} from "../runtime/compiler/types.js";

const policy: StillDurationPolicy = {
  source: "global_default",
  fps_num: 24,
  fps_den: 1,
  min_hold_frames: 24,
  default_hold_frames: 72,
  max_hold_frames: 240,
  motion_mode: "static",
  fit_mode: "contain",
  background: "black",
};
const require_ = createRequire(import.meta.url);

function imageCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    candidate_id: "C_IMG",
    segment_id: "SEG_IMG",
    asset_id: "AST_IMG",
    src_in_us: 0,
    src_out_us: 1,
    role: "hero",
    why_it_matches: "grounded still",
    risks: [],
    confidence: 0.9,
    semantic_rank: 1,
    eligible_beats: ["b01"],
    media_kind: "image",
    source_capabilities: { has_video: true, has_audio: false },
    still_image: { hold_duration_sec: 100 },
    ...overrides,
  };
}

function imageTimeline(): TimelineIR {
  return {
    version: "1",
    project_id: "P",
    created_at: "2026-01-01T00:00:00Z",
    sequence: { name: "still", fps_num: 24, fps_den: 1, width: 1920, height: 1080, start_frame: 0 },
    tracks: {
      video: [{
        track_id: "V1",
        kind: "video",
        clips: [{
          clip_id: "CLP_IMG",
          segment_id: "SEG_IMG",
          asset_id: "AST_IMG",
          src_in_us: 0,
          src_out_us: 1,
          timeline_in_frame: 0,
          timeline_duration_frames: 120,
          role: "hero",
          motivation: "still",
          beat_id: "b01",
          fallback_segment_ids: ["SEG_IMG_FALLBACK"],
          confidence: 0.9,
          quality_flags: [],
          media_kind: "image",
          source_capabilities: { has_video: true, has_audio: false },
          still_image: {
            hold_frames: 120,
            min_hold_frames: 24,
            max_hold_frames: 240,
            hold_source: "candidate_override",
            policy_clamp: "beat_budget",
            motion_mode: "static",
            fit_mode: "contain",
            background: "black",
          },
        }],
      }],
      audio: [],
    },
    markers: [],
    provenance: { brief_path: "", blueprint_path: "", selects_path: "", compiler_version: "test" },
    metadata: { still_duration_policy: policy },
  };
}

describe("still-image resolved duration truth", () => {
  it("resolves explicit brief over profile defaults over deterministic globals", () => {
    const global = resolveStillDurationPolicy({}, undefined, 24, 1);
    expect(global).toMatchObject({
      source: "global_default", min_hold_frames: 24, default_hold_frames: 72, max_hold_frames: 240,
    });

    const profile = resolveStillDurationPolicy({}, { still_image_intent: {
      min_hold_sec: 2, default_hold_sec: 4, max_hold_sec: 8,
      motion_mode: "static", fit_mode: "cover", background: "white",
    } }, 24, 1);
    expect(profile).toMatchObject({
      source: "profile_default", min_hold_frames: 48, default_hold_frames: 96,
      max_hold_frames: 192, fit_mode: "cover", background: "white",
    });

    const explicit = resolveStillDurationPolicy({ still_image_intent: {
      min_hold_sec: 1.5, default_hold_sec: 2.5, max_hold_sec: 5,
      motion_mode: "static", fit_mode: "contain", background: "#aabbcc",
    } }, { still_image_intent: {
      min_hold_sec: 2, default_hold_sec: 4, max_hold_sec: 8,
      motion_mode: "static", fit_mode: "cover", background: "white",
    } }, 24, 1);
    expect(explicit).toMatchObject({
      source: "explicit_brief", min_hold_frames: 36, default_hold_frames: 60,
      max_hold_frames: 120, fit_mode: "contain", background: "#aabbcc",
    });
  });

  it("converts policy seconds to exact rational-rate frames", () => {
    const resolved = resolveStillDurationPolicy({ still_image_intent: {
      min_hold_sec: 1.25, default_hold_sec: 2.5, max_hold_sec: 4.75,
      motion_mode: "static", fit_mode: "contain", background: "black",
    } }, undefined, 30000, 1001);
    expect(resolved.fps_num).toBe(30000);
    expect(resolved.fps_den).toBe(1001);
    expect(resolved.min_hold_frames).toBe(Math.round(1.25 * 30000 / 1001));
    expect(resolved.default_hold_frames).toBe(Math.round(2.5 * 30000 / 1001));
    expect(resolved.max_hold_frames).toBe(Math.round(4.75 * 30000 / 1001));
  });

  it("records subtle Ken Burns as pending while executing static motion only", () => {
    const resolved = resolveStillDurationPolicy({ still_image_intent: {
      min_hold_sec: 1, default_hold_sec: 3, max_hold_sec: 10,
      motion_mode: "subtle_ken_burns", fit_mode: "cover", background: "#01020304",
    } }, undefined, 24, 1);
    expect(resolved).toMatchObject({
      motion_mode: "static",
      requested_motion_mode: "subtle_ken_burns",
      motion_status: "pending_EYE-070C2B",
      background: "#01020304",
    });
  });

  it("accepts color tokens and strict hex while rejecting paths, URLs, and functions", () => {
    expect(sanitizeStillBackground("BLACK")).toBe("black");
    expect(sanitizeStillBackground("#AABBCCDD")).toBe("#aabbccdd");
    for (const invalid of ["/tmp/bg.png", "../bg.png", "folder\\bg.png", "https://example.test/bg", "url(bg.png)", "linear-gradient(red, blue)"]) {
      expect(sanitizeStillBackground(invalid)).toBeUndefined();
    }
  });

  it("records the final beat constraint ahead of an intermediate max clamp", () => {
    const hold = resolveStillImageHold(imageCandidate(), policy, 120);
    expect(hold.hold_frames).toBe(120);
    expect(hold.policy_clamp).toBe("beat_budget");
    expect(hold.hold_source).toBe("candidate_override");
  });

  it("scores the clamped beat hold, never raw override seconds or source epsilon", () => {
    const normalized: NormalizedData = {
      project_id: "P",
      project_title: "P",
      total_duration_frames: 120,
      role_quotas: { hero: 1, support: 0, transition: 0, texture: 0, dialogue: 0 },
      beats: [{
        beat_id: "b01",
        label: "still",
        target_duration_frames: 120,
        required_roles: ["hero"],
        preferred_roles: [],
        purpose: "hold",
      }],
    };
    const params: ScoringParams = {
      motif_reuse_max: 3,
      adjacency_penalty: 0,
      beat_alignment_tolerance_frames: 24,
      duration_fit_tolerance_frames: 0,
      quality_flag_penalty: 0,
    };
    const scored = scoreCandidates(normalized, [imageCandidate()], params, 24, 1, undefined, undefined, undefined, policy);
    expect(scored.get("b01")?.[0].breakdown.duration_fit_score).toBe(1);
  });

  it("uses resolved hold duration for BGM proximity instead of the image epsilon", () => {
    const beat = { beat_id: "b01", label: "still", target_duration_frames: 72, required_roles: ["hero"], preferred_roles: [], purpose: "hold" } as any;
    const bgm = { downbeats_sec: [1], sections: [], fpsNum: 24 };
    const imageBonus = computeBgmBonus(imageCandidate(), beat, bgm, 1_000_000 / 24, 72);
    const videoBonus = computeBgmBonus(imageCandidate({ media_kind: "video", still_image: undefined, src_out_us: 3_000_000 }), beat, bgm, 1_000_000 / 24, 72);
    expect(imageBonus).toBe(videoBonus);
    expect(imageBonus).toBe(0);
  });

  it("falls back to legal video when a still minimum cannot fit the beat", () => {
    const normalized: NormalizedData = {
      project_id: "P", project_title: "P", total_duration_frames: 12,
      role_quotas: { hero: 1, support: 0, transition: 0, texture: 0, dialogue: 0 },
      beats: [{ beat_id: "b01", label: "short", target_duration_frames: 12, required_roles: ["hero"], preferred_roles: [], purpose: "short" }],
    };
    const video = imageCandidate({
      candidate_id: "C_VIDEO", segment_id: "SEG_VIDEO", asset_id: "AST_VIDEO",
      media_kind: "video", src_out_us: 1_000_000, still_image: undefined,
    });
    const ranked = new Map([["b01", [
      { candidate: imageCandidate(), beat_id: "b01", score: 2, breakdown: {} },
      { candidate: video, beat_id: "b01", score: 1, breakdown: {} },
    ]]]) as unknown as ReturnType<typeof scoreCandidates>;
    const params: ScoringParams = { motif_reuse_max: 3, adjacency_penalty: 0, beat_alignment_tolerance_frames: 12, duration_fit_tolerance_frames: 0, quality_flag_penalty: 0 };
    const result = assemble(normalized, ranked, params, 24, 1, undefined, { stillDurationPolicy: policy });
    expect(result.tracks.video.flatMap((track) => track.clips).map((clip) => clip.segment_id)).toEqual(["SEG_VIDEO"]);
  });

  it("blocks before clip generation when image-only beat or duration cap is below min", () => {
    const normalized: NormalizedData = {
      project_id: "P", project_title: "P", total_duration_frames: 24,
      role_quotas: { hero: 1, support: 0, transition: 0, texture: 0, dialogue: 0 },
      beats: [{ beat_id: "b01", label: "short", target_duration_frames: 12, required_roles: ["hero"], preferred_roles: [], purpose: "short" }],
    };
    const ranked = new Map([["b01", [{ candidate: imageCandidate(), beat_id: "b01", score: 2, breakdown: {} }]]]) as unknown as ReturnType<typeof scoreCandidates>;
    const params: ScoringParams = { motif_reuse_max: 3, adjacency_penalty: 0, beat_alignment_tolerance_frames: 12, duration_fit_tolerance_frames: 0, quality_flag_penalty: 0 };
    expect(() => assemble(normalized, ranked, params, 24, 1, undefined, { stillDurationPolicy: policy })).toThrow(/still_image_hold_cannot_fit_beat/);
    const capNormalized = structuredClone(normalized);
    capNormalized.beats[0].target_duration_frames = 48;
    expect(() => assemble(capNormalized, ranked, params, 24, 1, undefined, {
      stillDurationPolicy: policy,
      maxDurationFrames: 12,
    })).toThrow(/still_image_hold_cannot_fit_beat/);
  });

  it("requires an explicit resolved policy for image assembly but preserves legacy video assembly", () => {
    const normalized: NormalizedData = {
      project_id: "P", project_title: "P", total_duration_frames: 72,
      role_quotas: { hero: 1, support: 0, transition: 0, texture: 0, dialogue: 0 },
      beats: [{ beat_id: "b01", label: "hold", target_duration_frames: 72, required_roles: ["hero"], preferred_roles: [], purpose: "hold" }],
    };
    const params: ScoringParams = { motif_reuse_max: 3, adjacency_penalty: 0, beat_alignment_tolerance_frames: 12, duration_fit_tolerance_frames: 0, quality_flag_penalty: 0 };
    const imageRanked = new Map([["b01", [{ candidate: imageCandidate(), beat_id: "b01", score: 1, breakdown: {} }]]]) as unknown as ReturnType<typeof scoreCandidates>;
    expect(() => assemble(normalized, imageRanked, params)).toThrowError("still_image_duration_policy_missing");

    const video = imageCandidate({ media_kind: "video", still_image: undefined, src_out_us: 3_000_000 });
    const videoRanked = new Map([["b01", [{ candidate: video, beat_id: "b01", score: 1, breakdown: {} }]]]) as unknown as ReturnType<typeof scoreCandidates>;
    const legacy = assemble(normalized, videoRanked, params);
    expect(legacy.tracks.video.flatMap((track) => track.clips)).toHaveLength(1);
  });

  it("merges a beat hold override without discarding selects still intent fields", () => {
    const normalized: NormalizedData = {
      project_id: "P", project_title: "P", total_duration_frames: 72,
      role_quotas: { hero: 1, support: 0, transition: 0, texture: 0, dialogue: 0 },
      beats: [{
        beat_id: "b01", label: "hold", target_duration_frames: 72,
        required_roles: ["hero"], preferred_roles: [], purpose: "hold",
        candidate_plan: {
          primary_candidate_ref: "C_IMG", fallback_candidate_refs: [],
          still_image: { hold_duration_sec: 3 },
        },
      }],
    };
    const candidate = imageCandidate({ still_image: {
      hold_duration_sec: 4,
      min_hold_sec: 2,
      max_hold_sec: 8,
      motion_mode: "subtle_ken_burns",
      fit_mode: "cover",
      background: "white",
    } });
    const ranked = new Map([["b01", [{ candidate, beat_id: "b01", score: 1, breakdown: {} }]]]) as unknown as ReturnType<typeof scoreCandidates>;
    const params: ScoringParams = { motif_reuse_max: 3, adjacency_penalty: 0, beat_alignment_tolerance_frames: 12, duration_fit_tolerance_frames: 0, quality_flag_penalty: 0 };
    const result = assemble(normalized, ranked, params, 24, 1, undefined, { stillDurationPolicy: policy });
    const still = result.tracks.video.flatMap((track) => track.clips)[0].still_image;
    expect(still).toMatchObject({
      hold_frames: 72,
      min_hold_frames: 48,
      max_hold_frames: 192,
      fit_mode: "cover",
      background: "white",
      motion_mode: "static",
      requested_motion_mode: "subtle_ken_burns",
      motion_status: "pending_EYE-070C2B",
    });
  });

  it("uses rational output fps for direct assemble and preserves still metadata through export", () => {
    const normalized: NormalizedData = {
      project_id: "P", project_title: "P", total_duration_frames: 90,
      role_quotas: { hero: 1, support: 0, transition: 0, texture: 0, dialogue: 0 },
      beats: [{ beat_id: "b01", label: "still", target_duration_frames: 90, required_roles: ["hero"], preferred_roles: [], purpose: "hold" }],
    };
    const ranked = new Map([["b01", [{ candidate: imageCandidate({ still_image: undefined }), beat_id: "b01", score: 1, breakdown: {} }]]]) as unknown as ReturnType<typeof scoreCandidates>;
    const params: ScoringParams = { motif_reuse_max: 3, adjacency_penalty: 0, beat_alignment_tolerance_frames: 12, duration_fit_tolerance_frames: 0, quality_flag_penalty: 0 };
    const directPolicy = resolveStillDurationPolicy({}, undefined, 30_000, 1_001);
    const assembled = assemble(normalized, ranked, params, 30_000, 1_001, undefined, {
      stillDurationPolicy: directPolicy,
    });
    const clip = assembled.tracks.video.flatMap((track) => track.clips)[0];
    expect(clip).toMatchObject({ media_kind: "image", src_in_us: 0, src_out_us: 1, timeline_duration_frames: 90 });
    expect(clip.still_image?.hold_frames).toBe(90);
    const rationalPolicy = {
      ...policy, fps_num: 30_000, fps_den: 1_001,
      min_hold_frames: 30, default_hold_frames: 90, max_hold_frames: 300,
    };
    const timeline = buildTimelineIR(assembled, {
      projectId: "P", projectTitle: "P", createdAt: "2026-01-01T00:00:00Z",
      projectPath: "/tmp/test-project",
      briefRelPath: "01_intent/creative_brief.yaml", blueprintRelPath: "04_plan/edit_blueprint.yaml",
      selectsRelPath: "04_plan/selects_candidates.yaml", fpsNum: 30_000, fpsDen: 1_001,
      stillDurationPolicy: rationalPolicy,
    });
    const output = timeline.tracks.video.flatMap((track) => track.clips)[0];
    expect(output.still_image).toEqual(clip.still_image);
    expect(output.timeline_duration_frames).toBe(output.still_image?.hold_frames);
    expect(timeline.provenance.still_duration_policy).toEqual(rationalPolicy);
  });

  it("leaves image-only underfill short and never inserts or extends images", () => {
    const existing = imageTimeline().tracks.video[0].clips[0] as any;
    existing.timeline_duration_frames = 48;
    existing.still_image.hold_frames = 48;
    const timeline = {
      tracks: { video: [{ track_id: "V1", kind: "video", clips: [existing] }, { track_id: "V2", kind: "video", clips: [] }], audio: [] },
      markers: [],
    } as any;
    const strict = { mode: "strict", source: "explicit_brief", target_source: "explicit_brief", target_duration_sec: 3, min_duration_sec: 3, max_duration_sec: 3, hard_gate: true, protect_vlm_peaks: true } as const;
    const result = applyDurationAdjust(timeline, [], [imageCandidate(), imageCandidate({ segment_id: "SEG_UNUSED", asset_id: "AST_UNUSED" })], strict, 24, 1, policy);
    expect(result).toMatchObject({ adjusted: false, extensions: 0, insertions: 0 });
    expect(existing.timeline_duration_frames).toBe(48);
    expect(existing.still_image.hold_frames).toBe(48);
    expect(timeline.tracks.video[1].clips).toEqual([]);
  });

  it("recovers the same underfill with a legal unused video fallback", () => {
    const existing = imageTimeline().tracks.video[0].clips[0] as any;
    existing.timeline_duration_frames = 48;
    existing.still_image.hold_frames = 48;
    const timeline = {
      tracks: { video: [{ track_id: "V1", kind: "video", clips: [existing] }, { track_id: "V2", kind: "video", clips: [] }], audio: [] },
      markers: [],
    } as any;
    const fallback = imageCandidate({
      segment_id: "SEG_VIDEO_FILL", asset_id: "AST_VIDEO_FILL", media_kind: "video",
      src_in_us: 0, src_out_us: 2_000_000, role: "support", still_image: undefined,
    });
    const strict = { mode: "strict", source: "explicit_brief", target_source: "explicit_brief", target_duration_sec: 3, min_duration_sec: 3, max_duration_sec: 3, hard_gate: true, protect_vlm_peaks: true } as const;
    const result = applyDurationAdjust(timeline, [], [imageCandidate(), fallback], strict, 24, 1, policy);
    expect(result).toMatchObject({ adjusted: true, extensions: 0, insertions: 1 });
    expect(timeline.tracks.video[1].clips[0]).toMatchObject({ segment_id: "SEG_VIDEO_FILL", timeline_duration_frames: 24 });
    expect(existing.timeline_duration_frames).toBe(48);
  });

  it.each(["pure", "mixed"] as const)("routes %s multi-layout image dialogue only to visual tracks", (mode) => {
    const normalized: NormalizedData = {
      project_id: "P", project_title: "P", total_duration_frames: 72,
      role_quotas: { hero: mode === "mixed" ? 1 : 0, support: 0, transition: 0, texture: 0, dialogue: 1 },
      beats: [{
        beat_id: "b01", label: "dialogue still", target_duration_frames: 72,
        required_roles: ["dialogue"], preferred_roles: [], purpose: "visual dialogue",
      }],
    };
    const stillDialogue = imageCandidate({ role: "dialogue" });
    const candidates = [{ candidate: stillDialogue, beat_id: "b01", score: 1, breakdown: {} }];
    if (mode === "mixed") {
      candidates.unshift({
        candidate: imageCandidate({
          candidate_id: "C_VIDEO", segment_id: "SEG_VIDEO", asset_id: "AST_VIDEO", role: "hero",
          media_kind: "video", source_capabilities: { has_video: true, has_audio: true },
          src_in_us: 0, src_out_us: 3_000_000, still_image: undefined,
        }),
        beat_id: "b01", score: 2, breakdown: {},
      });
    }
    const ranked = new Map([["b01", candidates]]) as unknown as ReturnType<typeof scoreCandidates>;
    const params: ScoringParams = {
      motif_reuse_max: 3, adjacency_penalty: 0, beat_alignment_tolerance_frames: 12,
      duration_fit_tolerance_frames: 0, quality_flag_penalty: 0,
    };
    const result = assemble(normalized, ranked, params, 24, 1, undefined, {
      trackLayout: "multi", stillDurationPolicy: policy,
    });
    const v1 = result.tracks.video.find((track) => track.track_id === "V1")!.clips;
    const v2 = result.tracks.video.find((track) => track.track_id === "V2")!.clips;
    const audio = result.tracks.audio.flatMap((track) => track.clips);
    expect(mode === "pure" ? v1 : v2).toContainEqual(expect.objectContaining({
      asset_id: "AST_IMG", media_kind: "image", src_in_us: 0, src_out_us: 1,
    }));
    expect(audio.filter((clip) => clip.asset_id === "AST_IMG")).toHaveLength(0);
  });
});

describe("still-image C1 identity grounding", () => {
  function groundingProject(segmentCount: number, sourceSha = "a".repeat(64)): string {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "vos-grounding-"));
    const analysis = path.join(project, "03_analysis");
    const frameDir = path.join(analysis, "still_frames", "AST_IMG");
    fs.mkdirSync(frameDir, { recursive: true });
    const frame = path.join(frameDir, "frame_0.png");
    fs.writeFileSync(frame, Buffer.from("normalized-still"));
    const frameSha = createHash("sha256").update(fs.readFileSync(frame)).digest("hex");
    fs.writeFileSync(path.join(analysis, "assets.json"), JSON.stringify({ items: [{
      asset_id: "AST_IMG",
      media_kind: "image",
      source_content_sha256: sourceSha,
      still_image: {
        normalized_frame_path: "still_frames/AST_IMG/frame_0.png",
        normalized_frame_content_sha256: frameSha,
      },
    }] }));
    const items = Array.from({ length: segmentCount }, (_, index) => {
      const evidenceRef = `vlm:AST_IMG:${index}`;
      const producer = {
        producer: "grounded_vlm",
        actual_verified_frame_count: 1,
        source_content_sha256: sourceSha,
        cache_identity: "cache:AST_IMG",
        evidence_refs: [evidenceRef],
      };
      const evidence = {
        evidence_ref: evidenceRef,
        producer: "grounded_vlm",
        evidence_type: "verified_frame",
        artifact_ref: frame,
        frame_us: 0,
      };
      return {
        segment_id: `SEG_IMG_${index}`,
        asset_id: "AST_IMG",
        src_in_us: 0,
        src_out_us: 1,
        provenance: { tags: {
          source_content_sha256: sourceSha,
          frame_content_sha256: [frameSha],
          frame_count: 1,
          cache_identity: "cache:AST_IMG",
        } },
        editorial_observation: {
          status: "ready",
          warnings: [],
          evidence: [evidence],
          provenance: { producers: [producer] },
          producer_snapshots: { grounded_vlm: { producer, evidence: [evidence] } },
        },
      };
    });
    fs.writeFileSync(path.join(analysis, "segments.json"), JSON.stringify({ items }));
    return project;
  }

  it("accepts one grounded identity segment and rejects duplicate identities", () => {
    const valid = groundingProject(1);
    const duplicate = groundingProject(2);
    try {
      expect(readValidatedStillImageFrames(valid).get("AST_IMG")).toBe("03_analysis/still_frames/AST_IMG/frame_0.png");
      expect(() => readValidatedStillImageFrames(duplicate)).toThrowError(StillImageGroundingError);
      expect(() => readValidatedStillImageFrames(duplicate)).toThrow(/image_identity_segment_count_2/);
    } finally {
      fs.rmSync(valid, { recursive: true, force: true });
      fs.rmSync(duplicate, { recursive: true, force: true });
    }
  });

  it("rejects non-lowercase or malformed source SHA identities", () => {
    const malformed = groundingProject(1, "A".repeat(64));
    try {
      expect(() => readValidatedStillImageFrames(malformed)).toThrow(/source_content_sha256_invalid/);
    } finally {
      fs.rmSync(malformed, { recursive: true, force: true });
    }
  });

  it.each([
    ["partial observation", (segment: any) => { segment.editorial_observation.status = "partial"; }],
    ["undefined observation status", (segment: any) => { delete segment.editorial_observation.status; }],
    ["missing canonical evidence ref", (segment: any) => { delete segment.editorial_observation.evidence[0].evidence_ref; }],
    ["missing snapshot evidence", (segment: any) => { segment.editorial_observation.producer_snapshots.grounded_vlm.evidence = []; }],
    ["empty producer evidence refs", (segment: any) => { segment.editorial_observation.provenance.producers[0].evidence_refs = []; }],
  ])("rejects %s", (_label, mutate) => {
    const project = groundingProject(1);
    try {
      const segmentsPath = path.join(project, "03_analysis", "segments.json");
      const doc = JSON.parse(fs.readFileSync(segmentsPath, "utf8"));
      mutate(doc.items[0]);
      fs.writeFileSync(segmentsPath, JSON.stringify(doc));
      expect(() => readValidatedStillImageFrames(project)).toThrow(StillImageGroundingError);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it.each([
    ["different existing file", (project: string, evidence: any) => {
      const other = path.join(project, "03_analysis", "other.png");
      fs.writeFileSync(other, "other-frame");
      evidence.artifact_ref = other;
    }],
    ["missing absolute file", (project: string, evidence: any) => {
      evidence.artifact_ref = path.join(project, "03_analysis", "missing.png");
    }],
    ["relative path", (_project: string, evidence: any) => {
      evidence.artifact_ref = "still_frames/AST_IMG/frame_0.png";
    }],
  ])("rejects snapshot evidence artifact_ref using a %s", (_label, mutate) => {
    const project = groundingProject(1);
    try {
      const segmentsPath = path.join(project, "03_analysis", "segments.json");
      const doc = JSON.parse(fs.readFileSync(segmentsPath, "utf8"));
      mutate(project, doc.items[0].editorial_observation.producer_snapshots.grounded_vlm.evidence[0]);
      fs.writeFileSync(segmentsPath, JSON.stringify(doc));
      expect(() => readValidatedStillImageFrames(project)).toThrow(/snapshot_verified_frame_artifact_mismatch/);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it("rejects top-level and snapshot evidence identity mismatches", () => {
    const project = groundingProject(1);
    try {
      const segmentsPath = path.join(project, "03_analysis", "segments.json");
      const doc = JSON.parse(fs.readFileSync(segmentsPath, "utf8"));
      doc.items[0].editorial_observation.producer_snapshots.grounded_vlm.evidence[0].frame_us = 1;
      fs.writeFileSync(segmentsPath, JSON.stringify(doc));
      expect(() => readValidatedStillImageFrames(project)).toThrow(/verified_frame_evidence_identity_mismatch/);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it("constructs the image universe from still markers, extensions, and source_map while rejecting contradictions", () => {
    const markerOnly = groundingProject(1);
    const stripped = groundingProject(1);
    const sourceOnly = fs.mkdtempSync(path.join(os.tmpdir(), "vos-grounding-source-only-"));
    try {
      const markerAssetsPath = path.join(markerOnly, "03_analysis", "assets.json");
      const markerAssets = JSON.parse(fs.readFileSync(markerAssetsPath, "utf8"));
      delete markerAssets.items[0].media_kind;
      markerAssets.items[0].filename = "still-without-kind.jpg";
      fs.writeFileSync(markerAssetsPath, JSON.stringify(markerAssets));
      expect(readValidatedStillImageFrames(markerOnly).has("AST_IMG")).toBe(true);

      const strippedAssetsPath = path.join(stripped, "03_analysis", "assets.json");
      const strippedAssets = JSON.parse(fs.readFileSync(strippedAssetsPath, "utf8"));
      delete strippedAssets.items[0].media_kind;
      delete strippedAssets.items[0].still_image;
      delete strippedAssets.items[0].duration_semantics;
      delete strippedAssets.items[0].frame_rate_mode;
      strippedAssets.items[0].filename = "still-all-markers-stripped.png";
      fs.writeFileSync(strippedAssetsPath, JSON.stringify(strippedAssets));
      expect(() => readValidatedStillImageFrames(stripped)).toThrow(/normalized_frame_path_not_project_relative/);

      fs.mkdirSync(path.join(sourceOnly, "02_media"), { recursive: true });
      fs.writeFileSync(path.join(sourceOnly, "02_media", "source_map.json"), JSON.stringify({ items: [{
        asset_id: "AST_SOURCE_IMAGE", source_locator: "02_media/source-only.jpg",
      }] }));
      expect(() => readValidatedStillImageFrames(sourceOnly)).toThrow(/authoritative_image_asset_missing_from_assets/);

      const conflictingAssets = JSON.parse(fs.readFileSync(markerAssetsPath, "utf8"));
      conflictingAssets.items[0].media_kind = "video";
      fs.writeFileSync(markerAssetsPath, JSON.stringify(conflictingAssets));
      expect(() => readValidatedStillImageFrames(markerOnly)).toThrow(/authoritative_media_kind_conflict/);
    } finally {
      fs.rmSync(markerOnly, { recursive: true, force: true });
      fs.rmSync(stripped, { recursive: true, force: true });
      fs.rmSync(sourceOnly, { recursive: true, force: true });
    }
  });

  it("rejects image consumers absent from authoritative grounded assets", () => {
    const missingAssets = fs.mkdtempSync(path.join(os.tmpdir(), "vos-grounding-missing-"));
    fs.mkdirSync(path.join(missingAssets, "03_analysis"), { recursive: true });
    fs.writeFileSync(path.join(missingAssets, "03_analysis", "segments.json"), JSON.stringify({ items: [{
      segment_id: "SEG_UNKNOWN", asset_id: "AST_UNKNOWN", media_kind: "image",
      source_interval: { semantics: "schema_compatible_single_frame_interval" },
      provenance: { boundary: { method: "still_image_single_frame" } },
    }] }));
    const nonImage = groundingProject(1);
    try {
      const assetsPath = path.join(nonImage, "03_analysis", "assets.json");
      const assetsDoc = JSON.parse(fs.readFileSync(assetsPath, "utf8"));
      assetsDoc.items.push({ asset_id: "AST_VIDEO", media_kind: "video", source_content_sha256: "b".repeat(64) });
      fs.writeFileSync(assetsPath, JSON.stringify(assetsDoc));
      expect(() => assertStillImageSegmentGrounding(missingAssets)).toThrow(/segment_image_asset_not_grounded/);
      expect(() => assertStillImageCandidateGrounding(nonImage, [{ asset_id: "AST_UNKNOWN", media_kind: "image" }])).toThrow(/candidate_image_asset_not_grounded/);
      expect(() => assertStillImageCandidateGrounding(nonImage, [{ asset_id: "AST_VIDEO", media_kind: "image" }])).toThrow(/candidate_image_asset_not_grounded/);
      expect(() => assertStillImageCandidateGrounding(nonImage, [{ asset_id: "AST_IMG", media_kind: "image" }])).not.toThrow();
    } finally {
      fs.rmSync(missingAssets, { recursive: true, force: true });
      fs.rmSync(nonImage, { recursive: true, force: true });
    }
  });
});

describe("still-image patch safety", () => {
  it("rejects an in-policy hold that crosses its beat and safely applies a budgeted hold", () => {
    const timeline = imageTimeline();
    timeline.markers = [
      { frame: 0, kind: "beat", label: "b01: still" },
      { frame: 100, kind: "beat", label: "b02: next" },
    ];
    const tooLong: ReviewPatch = {
      timeline_version: "1",
      operations: [{ op: "move_segment", target_clip_id: "CLP_IMG", new_duration_frames: 110, reason: "cross beat" }],
    };
    const rejected = applyPatch(timeline, tooLong, [], 200);
    expect(rejected.appliedOps).toBe(0);
    expect(rejected.errors[0]?.message).toContain("exceeds beat boundary 100");
    expect(rejected.timeline.tracks.video[0].clips[0]).toMatchObject({
      src_in_us: 0, src_out_us: 1, timeline_duration_frames: 120,
      still_image: { hold_frames: 120 },
    });

    const withinBudget: ReviewPatch = {
      timeline_version: "1",
      operations: [{ op: "move_segment", target_clip_id: "CLP_IMG", new_duration_frames: 80, reason: "fit beat" }],
    };
    const applied = applyPatch(timeline, withinBudget, [], 200);
    expect(applied.errors).toEqual([]);
    expect(applied.timeline.tracks.video[0].clips[0]).toMatchObject({
      src_in_us: 0, src_out_us: 1, timeline_duration_frames: 80,
      still_image: { hold_frames: 80 },
    });
  });

  it("rejects image moves before the owning beat or across a same-track clip", () => {
    const timeline = imageTimeline();
    timeline.markers = [
      { frame: 0, kind: "beat", label: "b01: still" },
      { frame: 100, kind: "beat", label: "b02: next" },
    ];
    const beforeBeat = applyPatch(timeline, {
      timeline_version: "1",
      operations: [{
        op: "move_segment", target_clip_id: "CLP_IMG",
        new_timeline_in_frame: -1, new_duration_frames: 80, reason: "before beat",
      }],
    }, [], 200);
    expect(beforeBeat.appliedOps).toBe(0);
    expect(beforeBeat.errors[0]?.message).toContain("precedes beat boundary 0");
    expect(beforeBeat.timeline.tracks.video[0].clips[0]).toMatchObject({
      timeline_in_frame: 0, timeline_duration_frames: 120,
      src_in_us: 0, src_out_us: 1, still_image: { hold_frames: 120 },
    });

    const overlapTimeline = imageTimeline();
    overlapTimeline.markers = structuredClone(timeline.markers);
    overlapTimeline.tracks.video[0].clips.push({
      ...structuredClone(overlapTimeline.tracks.video[0].clips[0]),
      clip_id: "CLP_VIDEO", segment_id: "SEG_VIDEO", asset_id: "AST_VIDEO",
      timeline_in_frame: 80, timeline_duration_frames: 20,
      media_kind: "video", still_image: undefined, src_out_us: 1_000_000,
    });
    const overlap = applyPatch(overlapTimeline, {
      timeline_version: "1",
      operations: [{
        op: "move_segment", target_clip_id: "CLP_IMG",
        new_timeline_in_frame: 20, new_duration_frames: 70, reason: "overlap",
      }],
    }, [], 200);
    expect(overlap.appliedOps).toBe(0);
    expect(overlap.errors[0]?.message).toContain("overlaps another clip");
    expect(overlap.timeline.tracks.video[0].clips.find((clip) => clip.clip_id === "CLP_IMG")).toMatchObject({
      timeline_in_frame: 0, timeline_duration_frames: 120,
      src_in_us: 0, src_out_us: 1, still_image: { hold_frames: 120 },
    });
  });

  it("allows removal but rejects an image audio policy without mutation", () => {
    const remove: ReviewPatch = {
      timeline_version: "1",
      operations: [{ op: "remove_segment", target_clip_id: "CLP_IMG", reason: "remove still" }],
    };
    const removed = applyPatch(imageTimeline(), remove, []);
    expect(removed.errors).toEqual([]);
    expect(removed.timeline.tracks.video[0].clips).toEqual([]);

    const audio: ReviewPatch = {
      timeline_version: "1",
      operations: [{
        op: "change_audio_policy",
        target_clip_id: "CLP_IMG",
        reason: "must reject",
        audio_policy: { preserve_nat_sound: true },
      }],
    };
    const rejected = applyPatch(imageTimeline(), audio, []);
    expect(rejected.appliedOps).toBe(0);
    expect(rejected.errors[0]?.message).toContain("no audio policy");
    expect(rejected.timeline.tracks.video[0].clips[0].audio_policy).toBeUndefined();
  });

  it("does not synthesize an image fallback during post-patch Phase 4", () => {
    const timeline = imageTimeline();
    timeline.tracks.video[0].clips.push({
      ...timeline.tracks.video[0].clips[0],
      clip_id: "CLP_VIDEO_DUP_1",
      segment_id: "SEG_VIDEO",
      asset_id: "AST_VIDEO",
      src_in_us: 0,
      src_out_us: 1_000_000,
      media_kind: "video",
      still_image: undefined,
      fallback_segment_ids: ["SEG_IMG_FALLBACK"],
    });
    timeline.tracks.video[0].clips.push({
      ...timeline.tracks.video[0].clips[1],
      clip_id: "CLP_VIDEO_DUP_2",
    });
    const fallback = imageCandidate({ segment_id: "SEG_IMG_FALLBACK" });
    const result = applyPatch(timeline, { timeline_version: "1", operations: [] }, [fallback]);
    const clips = result.timeline.tracks.video.flatMap((track) => track.clips);
    expect(clips.filter((clip) => clip.media_kind === "image")).toHaveLength(1);
    expect(clips.some((clip) => clip.segment_id === "SEG_IMG_FALLBACK")).toBe(false);
  });
});

describe("still-image direct mutation guards", () => {
  it.each(["overlay", "caption"] as const)("asserts still-image truth on the %s lane", (lane) => {
    const timeline = imageTimeline();
    const clip = structuredClone(timeline.tracks.video[0].clips[0]);
    clip.still_image!.hold_frames -= 1;
    timeline.tracks.video = [];
    timeline.tracks[lane] = [{ track_id: lane === "overlay" ? "O1" : "C1", kind: lane, clips: [clip] }];
    expect(() => assertStillImageTimelineTruthForTimeline(timeline)).toThrow(/still_image_hold_mismatch/);
  });

  it.each(["left", "right"] as const)("rejects beat snap with an image on the %s", (side) => {
    const image = imageTimeline().tracks.video[0].clips[0] as any;
    const video = { ...structuredClone(image), clip_id: "CLP_VIDEO", segment_id: "SEG_VIDEO", asset_id: "AST_VIDEO", media_kind: "video", still_image: undefined, src_out_us: 1_000_000 };
    const left = side === "left" ? image : video;
    const right = side === "right" ? image : video;
    right.timeline_in_frame = left.timeline_in_frame + left.timeline_duration_frames;
    const before = structuredClone({ left, right });
    expect(applyBeatSnap(left, right, 4, 24)).toBe(false);
    expect({ left, right }).toEqual(before);
  });

  it("excludes images from cut-breath treatment regardless of source handle", () => {
    const timeline = imageTimeline();
    const image = timeline.tracks.video[0].clips[0];
    timeline.tracks.video[0].clips.push({
      ...structuredClone(image), clip_id: "CLP_VIDEO", segment_id: "SEG_VIDEO", asset_id: "AST_VIDEO",
      media_kind: "video", still_image: undefined, src_out_us: 1_000_000, timeline_in_frame: 120,
    });
    const before = structuredClone(timeline);
    const result = applyCutBreathTreatment(timeline, { preserve_natural_breath: true, cut_tail_hold_sec: 1 }, [{
      segment_id: "SEG_IMG", asset_id: "AST_IMG", src_in_us: 0, src_out_us: 10_000_000,
    } as any], new Map(), 24);
    expect(result).toEqual({ extendedCuts: 0, totalExtendedFrames: 0, fadedCuts: 0 });
    expect(timeline).toEqual(before);
  });
});

describe("still-image schema conditionals", () => {
  it("rejects missing metadata, changed epsilon, and video+still metadata while preserving legacy clips", () => {
    const Ajv2020 = require_("ajv/dist/2020").default as new (options: object) => {
      compile(schema: object): ((value: unknown) => boolean) & { errors?: unknown[] | null };
    };
    const schema = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../schemas/timeline-ir.schema.json"), "utf8"));
    const validate = new Ajv2020({ strict: false, allErrors: true }).compile(schema);
    const valid = imageTimeline();
    expect(validate(valid), JSON.stringify(validate.errors)).toBe(true);

    const missing = structuredClone(valid);
    delete missing.tracks.video[0].clips[0].still_image;
    expect(validate(missing)).toBe(false);

    const wrongRange = structuredClone(valid);
    wrongRange.tracks.video[0].clips[0].src_out_us = 2;
    expect(validate(wrongRange)).toBe(false);

    const videoWithStill = structuredClone(valid);
    videoWithStill.tracks.video[0].clips[0].media_kind = "video";
    expect(validate(videoWithStill)).toBe(false);

    const legacy = structuredClone(valid);
    delete legacy.tracks.video[0].clips[0].media_kind;
    delete legacy.tracks.video[0].clips[0].still_image;
    expect(validate(legacy), JSON.stringify(validate.errors)).toBe(true);
  });

  it("requires image media_kind for reverse still semantics without changing genuine legacy assets", () => {
    const Ajv2020 = require_("ajv/dist/2020").default as new (options: object) => {
      addSchema(schema: object): unknown;
      compile(schema: object): ((value: unknown) => boolean) & { errors?: unknown[] | null };
    };
    const schema = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../schemas/assets.schema.json"), "utf8"));
    const common = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../schemas/analysis-common.schema.json"), "utf8"));
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    ajv.addSchema(common);
    const validate = ajv.compile(schema);
    const legacy = {
      project_id: "P", artifact_version: "1", items: [{
        asset_id: "AST_LEGACY", filename: "legacy.mov", duration_us: 1_000_000,
        has_transcript: false, transcript_ref: null, segments: 1, segment_ids: ["SEG_1"],
        quality_flags: [], tags: [],
      }],
    };
    expect(validate(legacy), JSON.stringify(validate.errors)).toBe(true);

    const zeroDurationStill = structuredClone(legacy);
    zeroDurationStill.items[0].duration_us = 0;
    (zeroDurationStill.items[0] as any).duration_semantics = "single_frame_zero_duration";
    expect(validate(zeroDurationStill)).toBe(false);

    const stillFrameMode = structuredClone(legacy);
    (stillFrameMode.items[0] as any).frame_rate_mode = "still_image";
    expect(validate(stillFrameMode)).toBe(false);

    const disguisedVideo = structuredClone(zeroDurationStill);
    (disguisedVideo.items[0] as any).media_kind = "video";
    expect(validate(disguisedVideo)).toBe(false);
  });
});
