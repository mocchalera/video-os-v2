import { describe, expect, it } from "vitest";

import {
  hashSoundDesignRequest,
  planSoundDesign,
  type SoundDesignCandidate,
  type SoundDesignRequest,
} from "../runtime/audio/sound-design-solver.js";

const SHA_A = `sha256:${"a".repeat(64)}`;
const SHA_B = `sha256:${"b".repeat(64)}`;
const SHA_C = `sha256:${"c".repeat(64)}`;

function candidate(
  candidateId: string,
  frame: number,
  overrides: Partial<SoundDesignCandidate> = {},
): SoundDesignCandidate {
  return {
    candidate_id: candidateId,
    semantic_role: "hook_impact",
    semantic_purpose: "Reinforce the visible fracture reveal.",
    evidence_refs: [`timeline:frame:${frame}`],
    semantic_strength: 0.9,
    semantic_anchor: {
      label: `${candidateId} anchor`,
      frame,
      window: {
        earliest_frame: Math.max(0, frame - 3),
        latest_frame: frame + 3,
      },
    },
    asset_id: "sfx-soft-impact-01",
    asset_pin: {
      library_id: "video-os-test-sfx",
      library_version: "1.0.0",
      library_manifest_hash: SHA_B,
      asset_content_hash: SHA_C,
      asset_size_bytes: 128,
      rights_evidence_ref: "rights:test",
      provenance_ref: "provenance:test",
    },
    audio: {
      duration_frames: 12,
      source_range: { in_us: 0, out_us: 500_000 },
      gain_db: -18,
      fade_in_ms: 8,
      fade_out_ms: 120,
      tail: { max_frames: 3, policy: "trim_or_pad_to_limit" },
      duck_group: "dialogue",
      ducking: {
        duck_gain_db: -24,
        attack_ms: 10,
        release_ms: 180,
      },
    },
    ...overrides,
  };
}

function request(
  candidates: SoundDesignCandidate[] = [candidate("candidate-hook", 0)],
): SoundDesignRequest {
  return {
    version: "sound-design-request/v1",
    project_id: "sound-design-test",
    base_timeline_version: "7",
    timeline_fps: { num: 24_000, den: 1_000 },
    timeline_duration_frames: 600,
    timeline_ref: {
      path: "/tmp/sound-design-test/timeline.json",
      content_hash: SHA_A,
    },
    library: {
      manifest_path: "/tmp/sound-design-test/sfx-library.json",
      library_id: "video-os-test-sfx",
      library_version: "1.0.0",
      manifest_hash: SHA_B,
    },
    candidates,
    dialogue_windows: [],
    congestion_events: [],
    beat_evidence: {
      status: "unavailable",
      analysis_status: "unavailable",
      analysis_path: null,
      content_hash: null,
      bpm: null,
      confidence: null,
      beat_frames: [],
      downbeat_frames: [],
    },
    policy: {
      minimum_spacing_frames: 24,
      max_cues_per_30_seconds: 3,
      absolute_max_cues: 3,
      semantic_accept_threshold: 4,
      congestion_reject_threshold: 4,
      minimum_beat_confidence: 0.7,
      max_snap_frames: 3,
      congestion_weights: {
        dialogue: 2,
        music_entry: 3,
        lower_third: 1.5,
        section_label: 1.5,
        caption: 1,
        picture_edit: 2,
        overlay: 1,
      },
    },
  };
}

describe("semantic-first sound-design solver", () => {
  it("adopts a semantically supported cue and rejects a cue without purpose", () => {
    const input = request([
      candidate("candidate-supported", 0),
      candidate("candidate-unfounded", 120, {
        semantic_purpose: null,
        evidence_refs: [],
      }),
    ]);
    const decision = planSoundDesign(input);

    expect(decision.decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        candidate_id: "candidate-supported",
        status: "adopted",
        resolved_frame: 0,
        picture_timing_moved: false,
      }),
      expect.objectContaining({
        candidate_id: "candidate-unfounded",
        status: "rejected",
        resolved_frame: null,
        reasons: expect.arrayContaining(["semantic_purpose_or_evidence_missing"]),
      }),
    ]));
  });

  it("rejects a strong semantic cue when the anchor is too congested", () => {
    const input = request([candidate("candidate-congested", 72)]);
    input.dialogue_windows = [{
      in_frame: 60,
      out_frame: 90,
      evidence_ref: "transcript:dialogue:60-90",
    }];
    input.congestion_events = [
      {
        event_id: "music-entry",
        type: "music_entry",
        in_frame: 72,
        out_frame: 73,
        severity: 1,
        evidence_ref: "music-cue:entry",
      },
      {
        event_id: "lower-third",
        type: "lower_third",
        in_frame: 70,
        out_frame: 84,
        severity: 0.8,
        evidence_ref: "overlay:lower-third",
      },
    ];

    const decision = planSoundDesign(input);
    expect(decision.decisions[0]).toMatchObject({
      candidate_id: "candidate-congested",
      status: "rejected",
      conflicts: expect.arrayContaining([
        "dialogue:transcript:dialogue:60-90",
        "music_entry:music-entry",
      ]),
      reasons: expect.arrayContaining(["congestion_threshold_exceeded"]),
    });
  });

  it("enforces density and spacing with stable candidate ID tie-breaks", () => {
    const input = request([
      candidate("candidate-b", 100),
      candidate("candidate-a", 100),
      candidate("candidate-c", 300),
    ]);
    input.policy.absolute_max_cues = 2;
    input.policy.max_cues_per_30_seconds = 2;

    const decision = planSoundDesign(input);
    const adopted = decision.decisions.filter((item) => item.status === "adopted");
    expect(adopted.map((item) => item.candidate_id)).toEqual([
      "candidate-a",
      "candidate-c",
    ]);
    expect(decision.decisions.find(
      (item) => item.candidate_id === "candidate-b",
    )?.reasons).toContain("minimum_spacing_conflict");
    expect(decision.summary.density_limit).toBe(2);
  });

  it("uses rational FPS for duration and density calculations", () => {
    const input = request([
      candidate("candidate-a", 0),
      candidate("candidate-b", 450),
      candidate("candidate-c", 899),
    ]);
    input.timeline_fps = { num: 30_000, den: 1_001 };
    input.timeline_duration_frames = 900;
    input.policy.max_cues_per_30_seconds = 2;
    input.policy.absolute_max_cues = 4;

    const decision = planSoundDesign(input);
    expect(decision.summary).toMatchObject({
      timeline_duration_seconds: 30.03,
      density_limit: 3,
    });
  });

  it("snaps only to a verified nearby beat within the bounded window", () => {
    const input = request([candidate("candidate-snap", 100)]);
    input.beat_evidence = {
      status: "available",
      analysis_status: "ready",
      analysis_path: "/tmp/music-analysis.json",
      content_hash: SHA_C,
      bpm: 96,
      confidence: 0.92,
      beat_frames: [102],
      downbeat_frames: [],
    };

    const decision = planSoundDesign(input);
    expect(decision.beat_evidence.usable_for_snap).toBe(true);
    expect(decision.decisions[0]).toMatchObject({
      status: "adopted",
      resolved_frame: 102,
      snap: {
        applied: true,
        from_frame: 100,
        to_frame: 102,
        delta_frames: 2,
        target_kind: "beat",
      },
    });
  });

  it.each([
    ["low confidence", "degraded", 0.3, [102]],
    ["empty grid", "ready", 0.9, []],
  ] as const)("does not fabricate a snap for %s beat evidence", (
    _label,
    analysisStatus,
    confidence,
    beats,
  ) => {
    const input = request([candidate("candidate-no-snap", 100)]);
    input.beat_evidence = {
      status: analysisStatus === "ready" ? "available" : "degraded",
      analysis_status: analysisStatus,
      analysis_path: "/tmp/music-analysis.json",
      content_hash: SHA_C,
      bpm: 71.8,
      confidence,
      beat_frames: [...beats],
      downbeat_frames: [],
    };

    const decision = planSoundDesign(input);
    expect(decision.beat_evidence.usable_for_snap).toBe(false);
    expect(decision.decisions[0]).toMatchObject({
      resolved_frame: 100,
      snap: {
        applied: false,
        delta_frames: 0,
        target_kind: null,
      },
    });
    expect(decision.decisions[0].snap.reason).toMatch(
      /confidence|grid|status/,
    );
  });

  it("refuses a snap that crosses a picture edit or dialogue boundary", () => {
    const input = request([candidate("candidate-boundary", 100)]);
    input.congestion_events = [{
      event_id: "picture-cut-101",
      type: "picture_edit",
      in_frame: 101,
      out_frame: 102,
      severity: 0.1,
      evidence_ref: "timeline:picture-cut-101",
    }];
    input.beat_evidence = {
      status: "available",
      analysis_status: "ready",
      analysis_path: "/tmp/music-analysis.json",
      content_hash: SHA_C,
      bpm: 96,
      confidence: 0.92,
      beat_frames: [103],
      downbeat_frames: [],
    };

    const decision = planSoundDesign(input);
    expect(decision.decisions[0]).toMatchObject({
      resolved_frame: 100,
      snap: {
        applied: false,
        reason: "snap_crosses_picture_edit_boundary",
      },
    });
  });

  it("produces the same request and decision hashes for the same input", () => {
    const input = request([candidate("candidate-repeatable", 48)]);
    const first = planSoundDesign(input);
    const second = planSoundDesign(structuredClone(input));
    expect(hashSoundDesignRequest(input)).toBe(hashSoundDesignRequest(
      structuredClone(input),
    ));
    expect(second).toEqual(first);
    expect(second.decision_hash).toBe(first.decision_hash);
  });
});
