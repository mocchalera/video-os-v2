import { describe, expect, it } from "vitest";
import {
  evaluateDeterministicLayoutQA,
  type RenderLayoutSnapshot,
} from "../runtime/review/deterministic-layout-qa.js";
import {
  parseSubjectOccupancyTrack,
  subjectOccupancyPayloadHash,
  type SubjectOccupancyTrack,
} from "../runtime/review/subject-occupancy.js";
import {
  parseVerticalCompositionPolicy,
  verticalCompositionPolicyContentHash,
  type VerticalCompositionPolicy,
} from "../runtime/visual/vertical-composition.js";
import { validateAgainstSchema } from "../runtime/commands/shared.js";

const generationId = `sha256:${"a".repeat(64)}`;
const rendererCapabilityHash = `sha256:${"b".repeat(64)}`;

function policy(
  platform: "unknown" | "provisional" | "measured" = "measured",
): VerticalCompositionPolicy {
  return parseVerticalCompositionPolicy({
    version: "vertical-composition-policy/v1",
    policy_id: "subject-caption-fixture-v1",
    output: {
      aspect_ratio: "9:16",
      coordinate_system: "normalized_top_left",
      width: 100,
      height: 100,
    },
    checks: {
      person_occupancy: { minimum: 0.01, maximum: 0.9 },
      headroom: { minimum_top_margin: 0, maximum_top_margin: 0.5 },
      look_room: { minimum_margin: 0 },
      hands: { mode: "protect_if_present", minimum_confidence: 0.5 },
      microphone: { mode: "protect_if_present", minimum_confidence: 0.5 },
      evidence: { mode: "required", minimum_confidence: 0.5 },
      caption_collision: {
        thresholds: { baseline: 0.1, emphasis: 0.4, title: 0.6 },
        candidate_anchors: { lower: "speech_lower", upper: "speech_upper" },
        auto_move: false,
      },
    },
    layout_anchors: {
      speech_lower: { x: 0.1, y: 0.7, width: 0.8, height: 0.2 },
      speech_upper: { x: 0.1, y: 0.1, width: 0.8, height: 0.2 },
    },
    zoom_intents: {
      emphasis: { max_zoom: 1.3, allow: true },
      reaction: { max_zoom: 1.2, allow: true },
      evidence: { max_zoom: 1.1, allow: true },
      reset: { max_zoom: 1, allow: true },
    },
    frames: {
      required_roles: ["first", "representative", "last"],
      representative_count: 1,
    },
    source: { require_identity: true, require_av_geometry: true },
    platform_geometry: platform === "measured"
      ? {
        status: "measured",
        evidence_level: "platform_measured",
        source: "synthetic-fixture",
        observed_at: "2026-08-24T00:00:00.000Z",
        device: "fixture-device",
        app: "fixture-app",
        screenshot_sha256: `sha256:${"c".repeat(64)}`,
      }
      : { status: platform, evidence_level: "policy_only" },
    degrade: {
      missing_evidence: "human_hold",
      failed_check: "human_hold",
      safe_mode: "identity",
    },
  });
}

function snapshot(
  role: "baseline" | "emphasis" | "title" = "baseline",
  withCaption = true,
): RenderLayoutSnapshot {
  return {
    version: "render-layout-snapshot/v1",
    binding: { generation_id: generationId, renderer_capability_sha256: rendererCapabilityHash },
    frame: {
      width: 100,
      height: 100,
      fps_num: 30,
      fps_den: 1,
      total_frames: 12,
      safe_area: { top: 0, right: 0, bottom: 0, left: 0 },
    },
    layers: withCaption
      ? [{
        layer_id: "CAP_MOVING",
        semantic_role: "speech_caption",
        caption_role: role,
        source: "ffmpeg-libass",
        start_frame: 0,
        end_frame: 12,
        bounds: { x: 20, y: 60, width: 60, height: 20 },
        font: {
          status: "verified",
          requested_family: "Fixture",
          resolved_family: "Fixture",
          missing_glyphs: [],
        },
      }]
      : [],
    ending: { final_frame_state: "moving_source" },
  };
}

function occupancy(
  tracks: SubjectOccupancyTrack["tracks"] = [{
    track_id: "TRACK_FACE_1",
    subject_id: "SUBJECT_TRACK_ONLY_1",
    identity_scope: "track_only_not_person_identity",
    motion: "moving",
    confidence: 0.95,
    samples: [
      { start_frame: 0, end_frame: 3, bounds: { x: 0, y: 0, width: 0.2, height: 0.2 }, evidence_roles: ["first"] },
      { start_frame: 3, end_frame: 8, bounds: { x: 0.3, y: 0.62, width: 0.4, height: 0.16 }, evidence_roles: ["representative"] },
      { start_frame: 8, end_frame: 12, bounds: { x: 0.8, y: 0.8, width: 0.2, height: 0.2 }, evidence_roles: ["last"] },
    ],
  }],
): SubjectOccupancyTrack {
  return parseSubjectOccupancyTrack({
    version: "subject-occupancy-track/v1",
    generation_id: generationId,
    source_identity: {
      asset_id: "ASSET_1",
      segment_id: "SEGMENT_1",
      source_content_hash: `sha256:${"d".repeat(64)}`,
      source_range: { src_in_us: 0, src_out_us: 400_000 },
    },
    source_av_geometry: {
      video: { width: 1920, height: 1080, fps_num: 30, fps_den: 1 },
      audio: { sample_rate: 48_000, channels: 2 },
    },
    provenance: {
      source: "manual_annotation",
      producer: "fixture-annotator",
      producer_version: "1",
      confidence: 0.95,
    },
    coverage: { start_frame: 0, end_frame: 12 },
    tracks,
  });
}

function evaluate(
  layout = snapshot(),
  track: SubjectOccupancyTrack | null | undefined = occupancy(),
  compositionPolicy: VerticalCompositionPolicy | undefined = policy(),
) {
  return evaluateDeterministicLayoutQA(layout, {
    subjectCollision: {
      generationId,
      rendererCapabilityHash,
      subjectOccupancy: track ?? undefined,
      verticalCompositionPolicy: compositionPolicy,
      policyRef: "04_plan/vertical-composition-policy.json",
      policyHash: compositionPolicy
        ? verticalCompositionPolicyContentHash(compositionPolicy)
        : undefined,
    },
  });
}

describe("generation-bound subject occupancy caption collision QA", () => {
  it("blocks the moving-face baseline caption with its exact contiguous frame range", () => {
    const result = evaluate();
    expect(result.status).toBe("blocked");
    expect(result.review_items).toEqual([
      expect.objectContaining({
        code: "caption_subject_collision",
        generation_id: generationId,
        caption_id: "CAP_MOVING",
        caption_role: "baseline",
        subject_track_id: "TRACK_FACE_1",
        start_frame: 3,
        end_frame: 8,
        collision_ratio: 0.533333,
        threshold: 0.1,
        candidate_anchors: ["speech_lower", "speech_upper"],
        evidence_status: "verified",
      }),
    ]);
  });

  it("represents static, moving, and multiple tracks deterministically without identity claims", () => {
    const staticTrack = occupancy().tracks[0];
    const multiple = occupancy([
      { ...staticTrack, track_id: "TRACK_STATIC", motion: "static", samples: [{ start_frame: 0, end_frame: 12, bounds: { x: 0.3, y: 0.62, width: 0.4, height: 0.16 }, evidence_roles: ["first", "representative", "last"] }] },
      { ...staticTrack, track_id: "TRACK_MOVING" },
    ]);
    const first = evaluate(snapshot(), multiple);
    const second = evaluate(snapshot(), structuredClone(multiple));
    expect(first).toEqual(second);
    expect(first.review_items.map((item) => item.subject_track_id).sort()).toEqual([
      "TRACK_MOVING",
      "TRACK_STATIC",
    ]);
    expect(multiple.tracks.every((track) => track.identity_scope === "track_only_not_person_identity")).toBe(true);
  });

  it("returns no false positive when there is no caption", () => {
    expect(evaluate(snapshot("baseline", false))).toMatchObject({
      status: "verified",
      issues: [],
      review_items: [],
      subject_collision_binding: { generation_id: generationId },
    });
    expect(evaluate(snapshot("baseline", false), null)).toMatchObject({
      status: "incomplete",
      issues: [],
      review_items: [],
    });
  });

  it("fails closed for missing evidence and provisional platform geometry", () => {
    const missing = evaluate(snapshot(), null, policy());
    expect(missing.status).toBe("incomplete");
    expect(missing.review_items[0]).toMatchObject({ evidence_status: "incomplete", reason: "subject_occupancy_missing" });

    const provisional = evaluate(snapshot(), occupancy(), policy("provisional"));
    expect(provisional.status).toBe("human_hold");
    expect(provisional.review_items[0]).toMatchObject({ evidence_status: "human_hold", reason: "platform_geometry_provisional" });

    const partialCoverage = occupancy();
    partialCoverage.coverage.end_frame = 11;
    expect(evaluate(snapshot(), partialCoverage).review_items[0]).toMatchObject({
      evidence_status: "incomplete",
      reason: "subject_occupancy_coverage_incomplete",
    });

    const lowConfidence = occupancy();
    lowConfidence.tracks[0].confidence = 0.49;
    expect(evaluate(snapshot(), lowConfidence).review_items[0]).toMatchObject({
      evidence_status: "incomplete",
      reason: "subject_occupancy_confidence_below_policy",
    });
  });

  it("requires the half-open union of samples to cover every caption frame", () => {
    const sample = (
      start_frame: number,
      end_frame: number,
    ): SubjectOccupancyTrack["tracks"][number]["samples"][number] => ({
      start_frame,
      end_frame,
      bounds: { x: 0, y: 0, width: 0.1, height: 0.1 },
      evidence_roles: ["first", "representative", "last"],
    });
    const track = (
      track_id: string,
      ranges: Array<[number, number]>,
    ): SubjectOccupancyTrack["tracks"][number] => ({
      track_id,
      subject_id: `SUBJECT_${track_id}`,
      identity_scope: "track_only_not_person_identity",
      motion: "moving",
      confidence: 0.95,
      samples: ranges.map(([start, end]) => sample(start, end)),
    });
    const expectIncomplete = (tracks: SubjectOccupancyTrack["tracks"]) => {
      const result = evaluate(snapshot(), occupancy(tracks));
      expect(result).toMatchObject({ status: "incomplete" });
      expect(result.review_items[0]).toMatchObject({
        caption_id: "CAP_MOVING",
        reason: "subject_occupancy_coverage_incomplete",
      });
      expect(result.subject_collision_binding).toBeUndefined();
    };

    expectIncomplete([track("EXACT_GAP", [[0, 3], [8, 12]])]);
    expectIncomplete([track("START_GAP", [[1, 12]])]);
    expectIncomplete([track("END_GAP", [[0, 11]])]);
    expectIncomplete([track("ONE_FRAME_GAP", [[0, 5], [6, 12]])]);
    expectIncomplete([
      track("MULTI_LEFT", [[0, 4], [8, 12]]),
      track("MULTI_INCOMPLETE", [[5, 8]]),
    ]);

    expect(evaluate(snapshot(), occupancy([
      track("TOUCHING", [[0, 3], [3, 12]]),
    ]))).toMatchObject({ status: "verified" });
    expect(evaluate(snapshot(), occupancy([
      track("OVERLAP_LEFT", [[0, 7]]),
      track("OVERLAP_RIGHT", [[5, 12]]),
    ]))).toMatchObject({ status: "verified" });
    expect(evaluate(snapshot(), occupancy([
      track("MULTI_OUTER", [[0, 4], [8, 12]]),
      track("MULTI_FILL", [[4, 8]]),
    ]))).toMatchObject({ status: "verified" });
  });

  it("resolves baseline versus emphasis/title thresholds from the bound project policy", () => {
    expect(evaluate(snapshot("baseline")).status).toBe("blocked");
    expect(evaluate(snapshot("emphasis")).status).toBe("blocked");
    expect(evaluate(snapshot("title")).status).toBe("verified");
    expect(evaluate(snapshot("emphasis")).review_items[0]).toMatchObject({ threshold: 0.4 });
  });

  it("rejects mixed, stale, or forged generation, policy, snapshot, and renderer bindings", () => {
    const staleSubject = occupancy();
    staleSubject.generation_id = `sha256:${"e".repeat(64)}`;
    expect(evaluate(snapshot(), staleSubject).status).toBe("human_hold");

    const staleSnapshot = snapshot();
    staleSnapshot.binding!.generation_id = `sha256:${"f".repeat(64)}`;
    expect(evaluate(staleSnapshot).status).toBe("human_hold");

    const compositionPolicy = policy();
    const forgedPolicy = evaluateDeterministicLayoutQA(snapshot(), {
      subjectCollision: {
        generationId,
        rendererCapabilityHash,
        subjectOccupancy: occupancy(),
        verticalCompositionPolicy: compositionPolicy,
        policyRef: "04_plan/vertical-composition-policy.json",
        policyHash: `sha256:${"0".repeat(64)}`,
      },
    });
    expect(forgedPolicy.status).toBe("human_hold");

    const staleRenderer = snapshot();
    staleRenderer.binding!.renderer_capability_sha256 = `sha256:${"1".repeat(64)}`;
    expect(evaluate(staleRenderer).status).toBe("human_hold");
  });

  it("keeps touching-only and frame boundaries non-colliding and rejects invalid normalized rects", () => {
    const touching = occupancy();
    touching.tracks[0].samples = [{
      start_frame: 0,
      end_frame: 12,
      bounds: { x: 0, y: 0.8, width: 1, height: 0.2 },
      evidence_roles: ["first", "representative", "last"],
    }];
    expect(evaluate(snapshot(), touching).status).toBe("verified");

    const boundaryLayout = snapshot();
    boundaryLayout.layers[0].start_frame = 5;
    const endsAtCaption = occupancy();
    endsAtCaption.tracks[0].motion = "static";
    endsAtCaption.tracks[0].samples = [
      {
        start_frame: 0,
        end_frame: 5,
        bounds: { x: 0.3, y: 0.62, width: 0.4, height: 0.16 },
        evidence_roles: ["first", "representative"],
      },
      {
        start_frame: 5,
        end_frame: 12,
        bounds: { x: 0, y: 0, width: 0.2, height: 0.2 },
        evidence_roles: ["last"],
      },
    ];
    expect(evaluate(boundaryLayout, endsAtCaption).status).toBe("verified");
    endsAtCaption.tracks[0].samples[0].start_frame = 5;
    endsAtCaption.tracks[0].samples[0].end_frame = 6;
    expect(evaluate(boundaryLayout, endsAtCaption).review_items[0]).toMatchObject({
      start_frame: 5,
      end_frame: 6,
    });

    for (const bounds of [
      { x: 0, y: 0, width: 0, height: 1 },
      { x: 0, y: 0, width: -1, height: 1 },
      { x: Number.NaN, y: 0, width: 1, height: 1 },
      { x: 0.5, y: 0, width: 0.6, height: 1 },
    ]) {
      const raw = structuredClone(occupancy()) as unknown as { tracks: Array<{ samples: Array<{ bounds: unknown }> }> };
      raw.tracks[0].samples[0].bounds = bounds;
      expect(() => parseSubjectOccupancyTrack(raw)).toThrow();
    }
    expect(validateAgainstSchema(occupancy(), "subject-occupancy-track.schema.json").valid).toBe(true);
    expect(validateAgainstSchema({ ...occupancy(), surprise: true }, "subject-occupancy-track.schema.json").valid).toBe(false);
  });

  it("does not mutate caption bytes, timing, approval, canonical timeline, or visual patch", () => {
    const layout = snapshot();
    const before = JSON.stringify(layout);
    const subjectBefore = JSON.stringify(occupancy());
    const result = evaluate(layout);
    expect(result.review_items[0].candidate_anchors).toEqual(["speech_lower", "speech_upper"]);
    expect(JSON.stringify(layout)).toBe(before);
    expect(JSON.stringify(occupancy())).toBe(subjectBefore);
    expect(subjectOccupancyPayloadHash(occupancy())).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});
