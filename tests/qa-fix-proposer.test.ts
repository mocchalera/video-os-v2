import { describe, expect, it, vi } from "vitest";
import type { SelectsCandidates, TimelineIR } from "../runtime/artifacts/types.js";
import type {
  FootageSearchResponse,
  FootageSearchResult,
  SearchFootageInput,
} from "../runtime/tools/footage-search.js";
import {
  proposeFixes,
  type QAFixSearchFn,
} from "../runtime/eval/qa-fix-proposer.js";
import type { QAIssue } from "../runtime/eval/qa-issue-detector.js";

function timeline(
  clips: Array<{
    clip_id: string;
    segment_id: string;
    start: number;
    duration?: number;
    beat_id?: string;
    role?: string;
  }>,
): TimelineIR {
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
          clips: clips.map((clip) => ({
            clip_id: clip.clip_id,
            segment_id: clip.segment_id,
            asset_id: `AST_${clip.segment_id}`,
            src_in_us: 0,
            src_out_us: 5_000_000,
            timeline_in_frame: clip.start,
            timeline_duration_frames: clip.duration ?? 96,
            role: clip.role ?? "support",
            motivation: `motivation ${clip.segment_id}`,
            beat_id: clip.beat_id ?? "b1",
            fallback_segment_ids: [],
            confidence: 0.7,
            quality_flags: [],
          })),
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

function selects(extraSegments: string[] = ["SEG_R"]): SelectsCandidates {
  return {
    version: "1",
    project_id: "qa-fixture",
    candidates: [
      candidate("SEG_A", 0.6),
      candidate("SEG_B", 0.6),
      candidate("SEG_C", 0.6),
      ...extraSegments.map((segmentId, index) => candidate(segmentId, 0.9 - index * 0.02)),
    ],
  };
}

function candidate(segmentId: string, confidence: number): SelectsCandidates["candidates"][number] {
  return {
    segment_id: segmentId,
    asset_id: `AST_${segmentId}`,
    src_in_us: 0,
    src_out_us: 6_000_000,
    role: "support",
    why_it_matches: `candidate ${segmentId}`,
    risks: [],
    confidence,
    eligible_beats: ["b1"],
    evidence: [segmentId],
  };
}

function issue(overrides: Partial<QAIssue> = {}): QAIssue {
  return {
    issue_id: overrides.issue_id ?? "QAISSUE_1",
    type: overrides.type ?? "quality",
    severity: overrides.severity ?? 0.8,
    timestamp_sec: overrides.timestamp_sec ?? 0,
    clip_id: overrides.clip_id ?? "CLP_A",
    beat_id: overrides.beat_id ?? "b1",
    description: overrides.description ?? "fixture issue",
    fixable: overrides.fixable ?? true,
    suggested_fix_type: overrides.suggested_fix_type ?? "swap",
    ...overrides,
  };
}

function result(segmentId: string, score = 0.9): FootageSearchResult {
  return {
    segment_id: segmentId,
    asset_id: `AST_${segmentId}`,
    src_in_us: 0,
    src_out_us: 6_000_000,
    duration_us: 6_000_000,
    score,
    scores: {
      final: score,
      qwen_visual: score,
      quality: 0.85,
    },
    match_reason: `matched ${segmentId}`,
    summary: `summary ${segmentId}`,
    key_frame_path: `03_analysis/frames/${segmentId}.jpg`,
    tags: [],
    quality_flags: [],
    quality: {
      composition_score: 0.85,
      subject_prominence: 0.85,
    },
    evidence_refs: [],
  };
}

function response(input: SearchFootageInput, results: FootageSearchResult[]): FootageSearchResponse {
  return {
    query: input,
    db_status: "ready",
    mode_used: input.mode ?? "hybrid",
    results,
    warnings: [],
  };
}

function searchReturning(results: FootageSearchResult[]): { search: QAFixSearchFn; calls: SearchFootageInput[] } {
  const calls: SearchFootageInput[] = [];
  const search = vi.fn(async (_projectDir: string, input: SearchFootageInput) => {
    calls.push(input);
    return response(input, results);
  });
  return { search, calls };
}

describe("proposeFixes", () => {
  it("proposes a swap by searching with the visual anchor of the target clip", async () => {
    const { search, calls } = searchReturning([result("SEG_R")]);

    const fixes = await proposeFixes(
      [issue()],
      timeline([
        { clip_id: "CLP_A", segment_id: "SEG_A", start: 0 },
        { clip_id: "CLP_B", segment_id: "SEG_B", start: 96 },
      ]),
      selects(),
      "/tmp/project",
      { search },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      mode: "visual",
      visual_anchor: { segment_id: "SEG_A" },
      filters: { exclude_segment_ids: ["SEG_A", "SEG_B"] },
    });
    expect(fixes[0]).toMatchObject({
      fix_type: "swap",
      target_clip_id: "CLP_A",
      replacement: { segment_id: "SEG_R", search_mode: "visual" },
    });
  });

  it("proposes a continuity bridge by searching with both adjacent visual anchors", async () => {
    const { search, calls } = searchReturning([result("SEG_R")]);

    const fixes = await proposeFixes(
      [
        issue({
          type: "continuity",
          suggested_fix_type: "insert",
          adjacent_clip_ids: { before: "CLP_A", after: "CLP_B" },
        }),
      ],
      timeline([
        { clip_id: "CLP_A", segment_id: "SEG_A", start: 0 },
        { clip_id: "CLP_B", segment_id: "SEG_B", start: 96 },
      ]),
      selects(),
      "/tmp/project",
      { search },
    );

    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.visual_anchor?.segment_id)).toEqual(["SEG_A", "SEG_B"]);
    expect(fixes[0]).toMatchObject({
      fix_type: "insert",
      target_clip_id: "CLP_A",
      replacement: { segment_id: "SEG_R", search_mode: "visual" },
    });
  });

  it("proposes must_have fixes by searching with the issue text", async () => {
    const { search, calls } = searchReturning([result("SEG_R")]);

    await proposeFixes(
      [
        issue({
          type: "must_have",
          search_query: "closing smile",
          suggested_fix_type: "swap",
        }),
      ],
      timeline([{ clip_id: "CLP_A", segment_id: "SEG_A", start: 0 }]),
      selects(),
      "/tmp/project",
      { search },
    );

    expect(calls[0]).toMatchObject({
      mode: "hybrid",
      query: "closing smile",
      semantic: "closing smile",
    });
  });

  it("excludes replacements that are already in the timeline", async () => {
    const { search } = searchReturning([result("SEG_A", 0.99), result("SEG_R", 0.8)]);

    const fixes = await proposeFixes(
      [issue()],
      timeline([{ clip_id: "CLP_A", segment_id: "SEG_A", start: 0 }]),
      selects(),
      "/tmp/project",
      { search },
    );

    expect(fixes[0].replacement?.segment_id).toBe("SEG_R");
  });

  it("respects the max fixes limit", async () => {
    const replacements = new Map([
      ["SEG_A", "SEG_R1"],
      ["SEG_B", "SEG_R2"],
      ["SEG_C", "SEG_R3"],
    ]);
    const search = vi.fn(async (_projectDir: string, input: SearchFootageInput) => {
      const anchor = input.visual_anchor?.segment_id ?? "";
      const segmentId = replacements.get(anchor) ?? "SEG_R1";
      return response(input, [result(segmentId, 0.9)]);
    });

    const fixes = await proposeFixes(
      [
        issue({ issue_id: "QAISSUE_A", clip_id: "CLP_A" }),
        issue({ issue_id: "QAISSUE_B", clip_id: "CLP_B" }),
        issue({ issue_id: "QAISSUE_C", clip_id: "CLP_C" }),
      ],
      timeline([
        { clip_id: "CLP_A", segment_id: "SEG_A", start: 0 },
        { clip_id: "CLP_B", segment_id: "SEG_B", start: 96 },
        { clip_id: "CLP_C", segment_id: "SEG_C", start: 192 },
      ]),
      selects(["SEG_R1", "SEG_R2", "SEG_R3"]),
      "/tmp/project",
      { search, maxFixes: 2 },
    );

    expect(fixes).toHaveLength(2);
  });

  it("filters fixes below the minimum expected improvement", async () => {
    const { search } = searchReturning([result("SEG_R", 0.05)]);

    const fixes = await proposeFixes(
      [issue({ severity: 0.1 })],
      timeline([{ clip_id: "CLP_A", segment_id: "SEG_A", start: 0 }]),
      selects(),
      "/tmp/project",
      { search, minImprovement: 0.2, minQualityScore: 0 },
    );

    expect(fixes).toEqual([]);
  });

  it("skips gracefully when no replacement is found", async () => {
    const { search } = searchReturning([]);

    const fixes = await proposeFixes(
      [issue()],
      timeline([{ clip_id: "CLP_A", segment_id: "SEG_A", start: 0 }]),
      selects(),
      "/tmp/project",
      { search },
    );

    expect(fixes).toEqual([]);
  });
});
