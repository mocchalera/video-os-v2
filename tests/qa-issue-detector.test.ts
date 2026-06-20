import { describe, expect, it } from "vitest";
import type { BriefAlignmentAxis, BriefAlignmentReport, StageResult } from "../runtime/eval/brief-alignment-types.js";
import type { MarlinQAReport } from "../runtime/eval/marlin-qa-types.js";
import {
  detectIssues,
  type Timeline,
} from "../runtime/eval/qa-issue-detector.js";

function timeline(
  clips: Array<{
    clip_id: string;
    segment_id: string;
    start: number;
    duration: number;
    beat_id?: string;
    role?: string;
  }>,
): Timeline {
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
            timeline_duration_frames: clip.duration,
            role: clip.role ?? "support",
            motivation: "fixture",
            beat_id: clip.beat_id ?? "b1",
            fallback_segment_ids: [],
            confidence: 0.8,
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

function marlinReport(issues: MarlinQAReport["issues"] = []): MarlinQAReport {
  return {
    version: "1",
    project_id: "qa-fixture",
    video_path: "rough-cut.mp4",
    video_duration_sec: 10,
    overall_assessment: "fixture",
    scene_descriptions: [],
    issues,
    pacing_assessment: { too_fast: false, too_slow: false, notes: "" },
    emotion_arc_assessment: { follows_brief: true, notes: "" },
    score: 100,
  };
}

function briefReport(overrides: Partial<Record<BriefAlignmentAxis, { score: number; gaps?: string[] }>> = {}): BriefAlignmentReport {
  const axes = Object.fromEntries(
    ([
      "intent_message_alignment",
      "must_have_coverage",
      "emotion_curve_alignment",
      "narrative_structure",
      "pacing_coherence",
      "visual_variety_and_focus",
    ] as BriefAlignmentAxis[]).map((axisName) => {
      const override = overrides[axisName];
      return [axisName, {
        score: override?.score ?? 1,
        confidence: 0.8,
        judge_source: "deterministic",
        evidence: ["fixture"],
        gaps: override?.gaps ?? [],
      }];
    }),
  ) as StageResult["axes"];

  return {
    version: "1",
    project: "qa-fixture",
    evaluated_at: "2026-06-20T00:00:00.000Z",
    brief_hash: "sha256:test",
    stages: {
      selects: { score: 1, axes },
    },
    composite: 1,
    notes: [],
  };
}

describe("detectIssues", () => {
  it("maps camera_shake to a quality issue on the correct clip", () => {
    const issues = detectIssues(
      marlinReport([
        {
          timestamp_sec: 2,
          duration_sec: 1,
          category: "camera_shake",
          severity: "warning",
          description: "Camera shakes during the opening action.",
          suggestion: "Swap with a steadier shot.",
        },
      ]),
      briefReport(),
      timeline([{ clip_id: "CLP_A", segment_id: "SEG_A", start: 0, duration: 96 }]),
    );

    expect(issues).toEqual([
      expect.objectContaining({
        type: "quality",
        clip_id: "CLP_A",
        beat_id: "b1",
        fixable: true,
        suggested_fix_type: "swap",
      }),
    ]);
  });

  it("maps continuity breaks to the correct adjacent clip pair", () => {
    const issues = detectIssues(
      marlinReport([
        {
          timestamp_sec: 4,
          duration_sec: 1,
          category: "continuity",
          severity: "warning",
          description: "Scene appears to repeat after a non-adjacent cut.",
          suggestion: "Bridge the cut.",
        },
      ]),
      briefReport(),
      timeline([
        { clip_id: "CLP_A", segment_id: "SEG_A", start: 0, duration: 96 },
        { clip_id: "CLP_B", segment_id: "SEG_B", start: 96, duration: 96 },
      ]),
    );

    expect(issues[0]).toMatchObject({
      type: "continuity",
      adjacent_clip_ids: { before: "CLP_A", after: "CLP_B" },
      fixable: true,
      suggested_fix_type: "insert",
    });
  });

  it("detects timeline micro-clips as pacing issues", () => {
    const issues = detectIssues(
      marlinReport(),
      briefReport(),
      timeline([
        { clip_id: "CLP_MICRO", segment_id: "SEG_MICRO", start: 0, duration: 12 },
        { clip_id: "CLP_OK", segment_id: "SEG_OK", start: 12, duration: 72 },
      ]),
    );

    expect(issues).toEqual([
      expect.objectContaining({
        type: "pacing",
        clip_id: "CLP_MICRO",
        source_category: "micro_clip",
        suggested_fix_type: "trim",
      }),
    ]);
  });

  it("maps low must_have coverage to a must_have issue", () => {
    const issues = detectIssues(
      marlinReport(),
      briefReport({
        must_have_coverage: {
          score: 0.4,
          gaps: ["must_have 'closing smile' has no matching candidate evidence"],
        },
      }),
      timeline([{ clip_id: "CLP_A", segment_id: "SEG_A", start: 0, duration: 96 }]),
    );

    expect(issues).toEqual([
      expect.objectContaining({
        type: "must_have",
        fixable: true,
        suggested_fix_type: "swap",
        search_query: "closing smile",
      }),
    ]);
  });

  it("returns an empty list when QA, brief alignment, and timeline have no issues", () => {
    expect(detectIssues(
      marlinReport(),
      briefReport(),
      timeline([{ clip_id: "CLP_OK", segment_id: "SEG_OK", start: 0, duration: 72 }]),
    )).toEqual([]);
  });

  it("sorts issues by severity", () => {
    const issues = detectIssues(
      marlinReport([
        {
          timestamp_sec: 1,
          duration_sec: 1,
          category: "weak_content",
          severity: "info",
          description: "Little happens.",
          suggestion: "Shorten.",
        },
        {
          timestamp_sec: 2,
          duration_sec: 1,
          category: "dark_exposure",
          severity: "critical",
          description: "Black screen.",
          suggestion: "Replace.",
        },
        {
          timestamp_sec: 0,
          duration_sec: 1,
          category: "camera_shake",
          severity: "warning",
          description: "Camera shake.",
          suggestion: "Replace.",
        },
      ]),
      briefReport(),
      timeline([{ clip_id: "CLP_A", segment_id: "SEG_A", start: 0, duration: 96 }]),
    );

    expect(issues.map((issue) => issue.severity)).toEqual([1, 0.65, 0.25]);
  });
});
