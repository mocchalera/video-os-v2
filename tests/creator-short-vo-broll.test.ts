import { describe, expect, it } from "vitest";
import {
  detectCreatorShortKickoffAnchor,
  loadCreatorShortKickoffPhrases,
  resolveCreatorShortVoBrollPreset,
} from "../runtime/compiler/creator-short-vo-broll.js";
import { buildTimelineIR } from "../runtime/compiler/export.js";
import type { Candidate, SelectsCandidates } from "../runtime/compiler/types.js";
import { validateArtifact } from "../runtime/artifacts/loaders.js";

function candidate(
  segmentId: string,
  role: Candidate["role"],
  capabilities: Candidate["source_capabilities"],
): Candidate {
  return {
    segment_id: segmentId,
    asset_id: `AST_${segmentId}`,
    src_in_us: 0,
    src_out_us: 10_000_000,
    role,
    why_it_matches: "test",
    risks: [],
    confidence: 1,
    media_kind: "video",
    source_capabilities: capabilities,
  };
}

const socialBrief = {
  project: { format: "vertical-short", runtime_target_sec: 45 },
  editorial: { distribution_channel: "reels", aspect_ratio: "9:16" },
};

const selects: Pick<SelectsCandidates, "candidates" | "editorial_summary"> = {
  editorial_summary: { dominant_visual_mode: "talking_head" },
  candidates: [
    candidate("TALK", "dialogue", { has_video: true, has_audio: true }),
    candidate("RUN", "support", { has_video: true, has_audio: true }),
  ],
};

describe("creator short VO/B-roll preset", () => {
  it("activates 1.5-3.0 second inserts for short-social talking-head inputs", () => {
    expect(resolveCreatorShortVoBrollPreset(
      socialBrief,
      { track_layout: "single" },
      selects,
      30,
      1,
      false,
    )).toMatchObject({
      policy: "creator-short-vo-broll/v1",
      minInsertFrames: 45,
      maxInsertFrames: 90,
      kickoffAnchor: null,
      provenance: {
        anchor_status: "degraded_no_kickoff_phrase",
        degraded: true,
        degrade_reason: "kickoff_phrase_not_detected",
      },
    });
  });

  it("loads kickoff vocabulary from editorial YAML and finds transcript timing", () => {
    const anchoredSelects = {
      candidates: [{
        ...selects.candidates[0],
        candidate_id: "CAND_TALK",
        src_in_us: 1_000_000,
        src_out_us: 5_000_000,
        transcript_excerpt: "それでは、行ってきます！",
      }],
    };
    const anchor = detectCreatorShortKickoffAnchor(
      anchoredSelects,
      new Map([["AST_TALK", [{
        start_us: 2_200_000,
        end_us: 2_800_000,
        text: "行ってきます",
      }]]]),
    );

    expect(loadCreatorShortKickoffPhrases().phrases).toContain("始めます");
    expect(anchor).toMatchObject({
      matchedPhrase: "行ってきます",
      candidateRef: "CAND_TALK",
      sourceTimeUs: 2_200_000,
      detectionSource: "transcript_item",
    });
  });

  it("records an anchored, non-degraded preset from candidate dialogue text", () => {
    const anchored = {
      ...selects,
      candidates: [
        { ...selects.candidates[0], transcript_excerpt: "DAY 1、スタート。" },
        selects.candidates[1],
      ],
    };
    const preset = resolveCreatorShortVoBrollPreset(
      socialBrief,
      { track_layout: "single" },
      anchored,
      30,
      1,
      false,
    );

    expect(preset?.provenance).toMatchObject({
      anchor_status: "detected",
      degraded: false,
      matched_phrase: "スタート",
      source_time_us: 0,
      detection_source: "candidate_transcript_excerpt",
    });
  });

  it("round-trips degraded anchor provenance through the timeline schema", () => {
    const preset = resolveCreatorShortVoBrollPreset(
      socialBrief,
      { track_layout: "single" },
      selects,
      30,
      1,
      false,
    )!;
    const timeline = buildTimelineIR(
      { tracks: { video: [], audio: [] }, markers: [] },
      {
        projectId: "creator-short",
        projectTitle: "Creator Short",
        projectPath: ".",
        createdAt: "2026-08-20T00:00:00.000Z",
        briefRelPath: "01_intent/creative_brief.yaml",
        blueprintRelPath: "04_plan/edit_blueprint.yaml",
        selectsRelPath: "04_plan/selects_candidates.yaml",
        fpsNum: 30,
        fpsDen: 1,
        creatorShortVoBrollProvenance: preset.provenance,
      },
    );
    const roundTrip = JSON.parse(JSON.stringify(timeline)) as typeof timeline;

    expect(roundTrip.provenance.creator_short_vo_broll).toMatchObject({
      anchor_status: "degraded_no_kickoff_phrase",
      degraded: true,
      degrade_reason: "kickoff_phrase_not_detected",
    });
    expect(() => validateArtifact(roundTrip, "timeline-ir.schema.json")).not.toThrow();
  });

  it("does not rewrite non-social or human-authored exact plans", () => {
    expect(resolveCreatorShortVoBrollPreset(
      { project: { format: "interview", runtime_target_sec: 600 }, editorial: {} },
      { track_layout: "single" },
      selects,
      24,
      1,
      false,
    )).toBeNull();
    expect(resolveCreatorShortVoBrollPreset(
      socialBrief,
      { track_layout: "single" },
      selects,
      24,
      1,
      true,
    )).toBeNull();
  });
});
