import { describe, expect, it } from "vitest";
import type {
  EditBlueprint,
  SelectsCandidates,
  TimelineIR,
} from "../runtime/artifacts/types.js";
import type { SegmentItem } from "../runtime/connectors/ffmpeg-segmenter.js";
import { applyFixes } from "../runtime/eval/qa-fix-applier.js";
import type { QAIssue } from "../runtime/eval/qa-issue-detector.js";
import type { QAFix } from "../runtime/eval/qa-fix-proposer.js";

function candidate(segmentId: string, beatId = "b1"): SelectsCandidates["candidates"][number] {
  return {
    segment_id: segmentId,
    asset_id: `AST_${segmentId}`,
    src_in_us: 0,
    src_out_us: 5_000_000,
    role: "support",
    why_it_matches: `candidate ${segmentId}`,
    risks: [],
    confidence: 0.7,
    eligible_beats: [beatId],
    evidence: [segmentId],
  };
}

function selects(extra: string[] = ["SEG_R"]): SelectsCandidates {
  return {
    version: "1",
    project_id: "qa-fixture",
    candidates: [
      candidate("SEG_A"),
      candidate("SEG_B"),
      ...extra.map((segmentId) => candidate(segmentId)),
      candidate("SEG_C", "b2"),
      candidate("SEG_D", "b2"),
    ],
  };
}

function blueprint(): EditBlueprint {
  return {
    version: "1",
    project_id: "qa-fixture",
    sequence_goals: ["fixture"],
    beats: [
      {
        id: "b1",
        label: "Beat 1",
        target_duration_frames: 120,
        required_roles: ["support"],
        candidate_plan: {
          primary_candidate_ref: "SEG_A",
          fallback_candidate_refs: ["SEG_B", "SEG_R"],
        },
      },
      {
        id: "b2",
        label: "Beat 2",
        target_duration_frames: 120,
        required_roles: ["support"],
        candidate_plan: {
          primary_candidate_ref: "SEG_C",
          fallback_candidate_refs: ["SEG_D"],
        },
      },
    ],
    pacing: {
      opening_cadence: "steady",
      middle_cadence: "steady",
      ending_cadence: "steady",
    },
    music_policy: {
      start_sparse: true,
      allow_release_late: true,
      entry_beat: "b1",
    },
    dialogue_policy: {
      preserve_natural_breath: true,
      avoid_wall_to_wall_voiceover: true,
    },
  };
}

function timeline(): TimelineIR {
  return {
    version: "1",
    project_id: "qa-fixture",
    created_at: "2026-06-20T00:00:00.000Z",
    sequence: {
      name: "qa-fixture",
      fps_num: 24,
      fps_den: 1,
      width: 1920,
      height: 1080,
      start_frame: 0,
    },
    tracks: {
      video: [
        {
          track_id: "V1",
          kind: "video",
          clips: [
            clip("CLP_A", "SEG_A", "b1", 0),
            clip("CLP_C", "SEG_C", "b2", 120),
          ],
        },
      ],
      audio: [],
    },
    markers: [],
    provenance: {
      brief_path: "",
      blueprint_path: "",
      selects_path: "",
      compiler_version: "test",
    },
  };
}

function clip(clipId: string, segmentId: string, beatId: string, start: number): TimelineIR["tracks"]["video"][number]["clips"][number] {
  return {
    clip_id: clipId,
    segment_id: segmentId,
    asset_id: `AST_${segmentId}`,
    src_in_us: 0,
    src_out_us: 5_000_000,
    timeline_in_frame: start,
    timeline_duration_frames: 120,
    role: "support",
    motivation: "fixture",
    beat_id: beatId,
    fallback_segment_ids: [],
    confidence: 0.7,
    quality_flags: [],
  };
}

function issue(overrides: Partial<QAIssue> = {}): QAIssue {
  return {
    issue_id: overrides.issue_id ?? "QAISSUE_1",
    type: overrides.type ?? "quality",
    severity: overrides.severity ?? 0.8,
    timestamp_sec: overrides.timestamp_sec ?? 1,
    clip_id: overrides.clip_id ?? "CLP_A",
    beat_id: overrides.beat_id ?? "b1",
    description: overrides.description ?? "fixture issue",
    fixable: overrides.fixable ?? true,
    suggested_fix_type: overrides.suggested_fix_type ?? "swap",
    ...overrides,
  };
}

function fix(overrides: Partial<QAFix> = {}): QAFix {
  return {
    issue_id: overrides.issue_id ?? "QAISSUE_1",
    issue: overrides.issue ?? issue(),
    fix_type: overrides.fix_type ?? "swap",
    target_clip_id: overrides.target_clip_id ?? "CLP_A",
    target_beat_id: overrides.target_beat_id ?? "b1",
    replacement: overrides.replacement ?? {
      segment_id: "SEG_R",
      search_mode: "visual",
      search_score: 0.9,
      reason: "better replacement",
    },
    expected_improvement: overrides.expected_improvement ?? 0.4,
    risk: overrides.risk ?? "low",
  };
}

function segment(segmentId: string): Pick<SegmentItem, "segment_id" | "asset_id" | "src_in_us" | "src_out_us" | "summary" | "quality_flags" | "transcript_excerpt"> {
  return {
    segment_id: segmentId,
    asset_id: `AST_${segmentId}`,
    src_in_us: 1_000_000,
    src_out_us: 7_000_000,
    summary: `segment ${segmentId}`,
    quality_flags: [],
    transcript_excerpt: "",
  };
}

describe("applyFixes", () => {
  it("applies a swap to selects and the beat candidate_plan without touching other beats", () => {
    const s = selects();
    const b = blueprint();
    const untouchedBeat = structuredClone(b.beats[1]);

    const result = applyFixes([fix()], s, b, timeline(), {
      segments: [segment("SEG_R")],
    });

    expect(result.applied).toHaveLength(1);
    expect(result.selects_modified).toBe(true);
    expect(result.blueprint_modified).toBe(true);
    expect(s.candidates[0]).toMatchObject({
      segment_id: "SEG_R",
      asset_id: "AST_SEG_R",
      eligible_beats: ["b1"],
    });
    expect(b.beats[0].candidate_plan).toMatchObject({
      primary_candidate_ref: "SEG_R",
      fallback_candidate_refs: ["SEG_B", "SEG_R"],
    });
    expect(b.beats[1]).toEqual(untouchedBeat);
    expect(result.modified_beat_ids).toEqual(["b1"]);
  });

  it("reorders candidates inside the beat candidate_plan", () => {
    const s = selects();
    const b = blueprint();
    const reorderFix = {
      ...fix({ fix_type: "reorder", replacement: undefined }),
      candidate_order: ["SEG_B", "SEG_A", "SEG_R"],
    } as QAFix & { candidate_order: string[] };

    const result = applyFixes([reorderFix], s, b, timeline());

    expect(result.applied).toHaveLength(1);
    expect(result.selects_modified).toBe(false);
    expect(b.beats[0].candidate_plan).toEqual({
      primary_candidate_ref: "SEG_B",
      fallback_candidate_refs: ["SEG_A", "SEG_R"],
    });
  });

  it("adjusts trim_hint on the target candidate", () => {
    const s = selects();
    const b = blueprint();

    const result = applyFixes([fix({ fix_type: "trim", replacement: undefined })], s, b, timeline());

    expect(result.applied).toHaveLength(1);
    expect(s.candidates[0].trim_hint).toMatchObject({
      window_start_us: 0,
      window_end_us: 5_000_000,
      rationale: "QA trim for QAISSUE_1",
    });
    expect(s.candidates[0].trim_hint?.recommended_out_us).toBeGreaterThan(s.candidates[0].trim_hint?.recommended_in_us ?? 0);
  });

  it("inserts a new candidate and adds it to the beat fallback list", () => {
    const s = selects([]);
    const b = blueprint();

    const result = applyFixes([
      fix({
        fix_type: "insert",
        replacement: {
          segment_id: "SEG_X",
          search_mode: "visual",
          search_score: 0.8,
          reason: "bridge shot",
        },
      }),
    ], s, b, timeline(), {
      segments: [segment("SEG_X")],
    });

    expect(result.applied).toHaveLength(1);
    expect(s.candidates.some((candidateItem) => candidateItem.segment_id === "SEG_X")).toBe(true);
    expect(b.beats[0].candidate_plan?.fallback_candidate_refs).toContain("SEG_X");
  });

  it("marks a removed candidate as reject and removes it from candidate_plan", () => {
    const s = selects();
    const b = blueprint();

    const result = applyFixes([fix({ fix_type: "remove", replacement: undefined })], s, b, timeline());

    expect(result.applied).toHaveLength(1);
    expect(s.candidates[0].role).toBe("reject");
    expect(b.beats[0].candidate_plan).toEqual({
      fallback_candidate_refs: ["SEG_B", "SEG_R"],
    });
  });

  it("supports dry-run without mutating inputs", () => {
    const s = selects();
    const b = blueprint();
    const beforeSelects = structuredClone(s);
    const beforeBlueprint = structuredClone(b);

    const result = applyFixes([fix()], s, b, timeline(), {
      dryRun: true,
      segments: [segment("SEG_R")],
    });

    expect(result.applied).toHaveLength(1);
    expect(result.selects_modified).toBe(true);
    expect(s).toEqual(beforeSelects);
    expect(b).toEqual(beforeBlueprint);
  });

  it("skips invalid replacement segment_ids with a warning", () => {
    const s = selects([]);
    const b = blueprint();

    const result = applyFixes([
      fix({
        replacement: {
          segment_id: "SEG_MISSING",
          search_mode: "visual",
          search_score: 0.8,
          reason: "missing",
        },
      }),
    ], s, b, timeline(), {
      segmentIds: ["SEG_A", "SEG_B"],
    });

    expect(result.applied).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.warnings[0]).toContain("SEG_MISSING");
    expect(s.candidates[0].segment_id).toBe("SEG_A");
  });
});
