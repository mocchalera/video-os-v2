import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadBlueprint,
  loadSelects,
  loadTimeline,
} from "../runtime/artifacts/loaders.js";
import type { SelectsCandidates, TimelineIR } from "../runtime/artifacts/types.js";
import {
  clamp01,
  jaccard,
  longestCommonSubsequenceLength,
  longestIncreasingSubsequenceLength,
  matchSegments,
  spearmanCorrelation,
  temporalIou,
} from "../runtime/eval/matching.js";
import { evaluateSelectsAgreement } from "../runtime/eval/selects-agreement.js";
import { evaluateTimelineAgreement } from "../runtime/eval/timeline-agreement.js";
import { evaluateBlueprintAgreement } from "../runtime/eval/blueprint-agreement.js";
import { discoverGoldenProjects } from "../runtime/eval/golden-registry.js";
import { composeEvalReport } from "../runtime/eval/report.js";
import {
  buildJudgePrompt,
  parseJudgeResponse,
  parseRetryDelayMs,
} from "../runtime/eval/llm-judge.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const demoDir = path.join(repoRoot, "projects/demo");

const demoSelects = loadSelects(path.join(demoDir, "04_plan/selects_candidates.yaml"));
const demoBlueprint = loadBlueprint(path.join(demoDir, "04_plan/edit_blueprint.yaml"));
const demoTimeline = loadTimeline(path.join(demoDir, "05_timeline/timeline.json"));

const clone = <T>(value: T): T => structuredClone(value);

// ── matching primitives ─────────────────────────────────────────────

describe("matching primitives", () => {
  it("computes temporal IoU within the same asset only", () => {
    const a = { id: "x", asset_id: "A", src_in_us: 0, src_out_us: 10 };
    const b = { id: "y", asset_id: "A", src_in_us: 5, src_out_us: 15 };
    const c = { id: "z", asset_id: "B", src_in_us: 0, src_out_us: 10 };
    expect(temporalIou(a, b)).toBeCloseTo(5 / 15);
    expect(temporalIou(a, c)).toBe(0);
    expect(temporalIou(a, a)).toBe(1);
  });

  it("matches exact ids before temporal overlap", () => {
    const golden = [
      { id: "s1", asset_id: "A", src_in_us: 0, src_out_us: 10_000_000 },
      { id: "s2", asset_id: "A", src_in_us: 20_000_000, src_out_us: 30_000_000 },
    ];
    const candidate = [
      // Different id but overlapping window of s2 → temporal match
      { id: "s2-retrimmed", asset_id: "A", src_in_us: 22_000_000, src_out_us: 30_000_000 },
      { id: "s1", asset_id: "A", src_in_us: 0, src_out_us: 10_000_000 },
    ];
    const result = matchSegments(golden, candidate);
    expect(result.pairs).toHaveLength(2);
    const kinds = result.pairs.map((p) => p.kind).sort();
    expect(kinds).toEqual(["exact", "temporal"]);
    expect(result.unmatched_golden).toHaveLength(0);
    expect(result.unmatched_candidate).toHaveLength(0);
  });

  it("computes LIS / LCS / Spearman / jaccard", () => {
    expect(longestIncreasingSubsequenceLength([1, 2, 3, 4])).toBe(4);
    expect(longestIncreasingSubsequenceLength([4, 3, 2, 1])).toBe(1);
    expect(longestIncreasingSubsequenceLength([2, 1, 3, 4])).toBe(3);
    expect(longestCommonSubsequenceLength(["a", "b", "c"], ["a", "c"])).toBe(2);
    expect(spearmanCorrelation([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
    expect(spearmanCorrelation([1, 2, 3], [3, 2, 1])).toBeCloseTo(-1);
    expect(spearmanCorrelation([1, 2], [1, 2])).toBeNull();
    expect(jaccard(new Set(["a", "b"]), new Set(["b", "c"]))).toBeCloseTo(1 / 3);
    expect(clamp01(1.5)).toBe(1);
  });
});

// ── selects agreement ───────────────────────────────────────────────

describe("selects agreement", () => {
  it("scores identical selects as perfect", () => {
    const report = evaluateSelectsAgreement(demoSelects, clone(demoSelects));
    expect(report.f1).toBe(1);
    expect(report.role_agreement).toBe(1);
    expect(report.score).toBe(1);
    expect(report.missing_from_candidate).toHaveLength(0);
  });

  it("detects dropped and role-flipped candidates", () => {
    const mutated = clone(demoSelects) as SelectsCandidates;
    const dropped = mutated.candidates.pop();
    expect(dropped).toBeDefined();
    mutated.candidates[0].role = mutated.candidates[0].role === "hero" ? "texture" : "hero";

    const report = evaluateSelectsAgreement(demoSelects, mutated);
    expect(report.recall).toBeLessThan(1);
    expect(report.role_agreement).toBeLessThan(1);
    expect(report.score).toBeLessThan(1);
    expect(report.missing_from_candidate.length).toBeGreaterThan(0);
  });
});

// ── timeline agreement ──────────────────────────────────────────────

describe("timeline agreement", () => {
  it("scores an identical timeline as perfect", () => {
    const report = evaluateTimelineAgreement(demoTimeline, clone(demoTimeline));
    expect(report.clip_usage_f1).toBe(1);
    expect(report.order_agreement).toBe(1);
    expect(report.mean_cut_in_deviation_us).toBe(0);
    expect(report.total_duration_deviation_pct).toBe(0);
    expect(report.score).toBe(1);
  });

  it("penalizes a dropped clip via usage F1", () => {
    const mutated = clone(demoTimeline) as TimelineIR;
    const v1 = mutated.tracks.video[0];
    v1.clips = v1.clips.slice(0, -1);
    const report = evaluateTimelineAgreement(demoTimeline, mutated);
    expect(report.clip_usage_f1).toBeLessThan(1);
    expect(report.score).toBeLessThan(1);
  });

  it("penalizes reordered clips via order agreement", () => {
    const mutated = clone(demoTimeline) as TimelineIR;
    const clips = mutated.tracks.video[0].clips;
    expect(clips.length).toBeGreaterThanOrEqual(2);
    // Swap the timeline positions of the first two clips.
    const a = clips[0];
    const b = clips[1];
    [a.timeline_in_frame, b.timeline_in_frame] = [b.timeline_in_frame, a.timeline_in_frame];
    const report = evaluateTimelineAgreement(demoTimeline, mutated);
    expect(report.order_agreement).toBeLessThan(1);
    expect(report.clip_usage_f1).toBe(1);
  });

  it("penalizes trim drift via cut-in deviation", () => {
    const mutated = clone(demoTimeline) as TimelineIR;
    for (const clip of mutated.tracks.video[0].clips) {
      clip.src_in_us += 500_000; // half-second trim drift on every clip
    }
    const report = evaluateTimelineAgreement(demoTimeline, mutated);
    expect(report.mean_cut_in_deviation_us).toBeGreaterThan(0);
    expect(report.score).toBeLessThan(1);
  });
});

// ── blueprint agreement ─────────────────────────────────────────────

describe("blueprint agreement", () => {
  it("scores an identical blueprint as perfect", () => {
    const report = evaluateBlueprintAgreement(demoBlueprint, clone(demoBlueprint));
    expect(report.beat_count_score).toBe(1);
    expect(report.pacing_agreement).toBe(1);
    expect(report.music_agreement).toBe(1);
    expect(report.score).toBe(1);
  });

  it("detects beat-structure drift", () => {
    const mutated = clone(demoBlueprint);
    mutated.beats = mutated.beats.slice(0, -1);
    mutated.pacing.opening_cadence = "totally-different-cadence";
    const report = evaluateBlueprintAgreement(demoBlueprint, mutated);
    expect(report.beat_count_score).toBeLessThan(1);
    expect(report.pacing_agreement).toBeLessThan(1);
    expect(report.score).toBeLessThan(1);
  });
});

// ── golden registry ─────────────────────────────────────────────────

describe("golden registry", () => {
  // Project artifacts under projects/ are mostly gitignored, so the test
  // builds a synthetic repo root instead of depending on local-only state
  // (a fresh clone or worktree has no approved projects on disk).
  it("discovers approved projects with full artifacts", () => {
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "golden-registry-"));
    try {
      const write = (rel: string, content: string) => {
        const p = path.join(fakeRoot, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content);
      };
      const projectFiles = (id: string) => {
        write(`projects/${id}/04_plan/selects_candidates.yaml`, "version: '1'");
        write(`projects/${id}/04_plan/edit_blueprint.yaml`, "version: '1'");
        write(`projects/${id}/05_timeline/timeline.json`, "{}");
      };

      // Human-approved golden.
      projectFiles("human-approved");
      write(
        "projects/human-approved/project_state.yaml",
        'approval_record:\n  approved_by: operator\n  approved_at: "2026-06-12T00:00:00Z"\n',
      );
      // Agent-approved golden.
      projectFiles("agent-approved");
      write(
        "projects/agent-approved/project_state.yaml",
        "approval_record:\n  approved_by: codex\n",
      );
      // Unapproved project and the template must not appear.
      projectFiles("unapproved");
      write("projects/unapproved/project_state.yaml", "current_state: draft\n");
      projectFiles("_template");
      write(
        "projects/_template/project_state.yaml",
        "approval_record:\n  approved_by: operator\n",
      );
      // Approved but missing timeline must not appear.
      write("projects/no-timeline/04_plan/selects_candidates.yaml", "version: '1'");
      write("projects/no-timeline/04_plan/edit_blueprint.yaml", "version: '1'");
      write(
        "projects/no-timeline/project_state.yaml",
        "approval_record:\n  approved_by: operator\n",
      );

      const goldens = discoverGoldenProjects(fakeRoot);
      const human = goldens.find((g) => g.project_id === "human-approved");
      expect(human).toBeDefined();
      expect(human?.tier).toBe("human");
      expect(human?.has_timeline).toBe(true);
      expect(goldens.find((g) => g.project_id === "agent-approved")?.tier).toBe("agent");
      expect(goldens.find((g) => g.project_id === "unapproved")).toBeUndefined();
      expect(goldens.find((g) => g.project_id === "_template")).toBeUndefined();
      expect(goldens.find((g) => g.project_id === "no-timeline")).toBeUndefined();
    } finally {
      fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
  });
});

// ── composite report ────────────────────────────────────────────────

describe("composite report", () => {
  const timelineStage = evaluateTimelineAgreement(demoTimeline, clone(demoTimeline));

  it("renormalizes weights over present stages and applies min-score", () => {
    const report = composeEvalReport({
      mode: "compare",
      goldenProject: "g",
      candidateProject: "c",
      goldenApprovedBy: "operator",
      evaluatedAt: "2026-06-12T00:00:00.000Z",
      stages: { timeline: timelineStage },
      minScore: 80,
    });
    expect(report.overall_score).toBe(100);
    expect(report.pass).toBe(true);
  });

  it("blends the LLM judge into the overall score", () => {
    const report = composeEvalReport({
      mode: "compare",
      goldenProject: "g",
      candidateProject: "c",
      goldenApprovedBy: "operator",
      evaluatedAt: "2026-06-12T00:00:00.000Z",
      stages: { timeline: timelineStage },
      llmJudge: {
        model: "test",
        scores: { emotion: 5, story: 5, rhythm: 5, agreement_with_golden: 5 },
        score: 0.5,
        rationale: "midpoint",
      },
    });
    // structural 1.0 * 0.7 + judge 0.5 * 0.3 = 0.85
    expect(report.overall_score).toBeCloseTo(85, 1);
    expect(report.pass).toBeNull();
  });
});

// ── LLM judge plumbing (no network) ─────────────────────────────────

describe("llm judge plumbing", () => {
  it("builds a prompt containing both cuts and the rubric", () => {
    const prompt = buildJudgePrompt({
      brief: null,
      golden: demoTimeline,
      candidate: demoTimeline,
    });
    expect(prompt).toContain("GOLDEN cut");
    expect(prompt).toContain("CANDIDATE cut");
    expect(prompt).toContain("agreement_with_golden");
  });

  it("frames multi-track video as layered overlay, not overlapping clips", () => {
    // Regression: the judge once scored a V1+V2 overlay edit 0/10, calling
    // it "unplayable — multiple clips at the same start time". The prompt
    // must label upper tracks as overlay and sort within a track by time.
    const multi = clone(demoTimeline) as TimelineIR;
    const base = multi.tracks.video[0];
    multi.tracks.video.push({
      track_id: "V2",
      kind: "video",
      clips: [
        { ...base.clips[0], clip_id: "OV_0001", timeline_in_frame: base.clips[0].timeline_in_frame },
      ],
    });
    const prompt = buildJudgePrompt({ brief: null, golden: demoTimeline, candidate: multi });
    expect(prompt).toContain("Video track V2");
    expect(prompt).toContain("overlay");
    // Both the description block and the rubric warn against the misread.
    expect(prompt.match(/overlay/gi)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("extracts RetryInfo delays from 429 bodies", () => {
    const body = '{"error": {"details": [{"@type": ".../RetryInfo", "retryDelay": "46s"}]}}';
    expect(parseRetryDelayMs(body)).toBe(46_000);
    expect(parseRetryDelayMs('{"retryDelay": "0.5s"}')).toBe(500);
    expect(parseRetryDelayMs('{"error": "no hint"}')).toBeNull();
  });

  it("parses and clamps judge responses", () => {
    const report = parseJudgeResponse(
      JSON.stringify({
        emotion: 8,
        story: 12,
        rhythm: -2,
        agreement_with_golden: 7,
        rationale: "solid cut",
      }),
      "test-model",
    );
    expect(report.scores.story).toBe(10);
    expect(report.scores.rhythm).toBe(0);
    expect(report.score).toBeCloseTo((8 + 10 + 0 + 7) / 40);
    expect(report.rationale).toBe("solid cut");
  });
});
