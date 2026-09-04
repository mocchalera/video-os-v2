import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import type { CreativeBrief } from "../runtime/artifacts/types.js";
import {
  evaluateSelectionCoverage,
  requiredCandidatesForCluster,
  type SelectionCoverageSegment,
} from "../runtime/editorial/coverage.js";
import { runTriage, type SelectCandidate, type SelectsCandidates, type TriageAgentContext } from "../runtime/commands/triage.js";
import { writeProjectState } from "../runtime/state/reconcile.js";

const tempDirs: string[] = [];
const SAMPLE_PROJECT = "projects/sample";
const TRIAGE_PROJECT_ID = "sample-mountain-reset";

afterAll(() => {
  for (const dir of tempDirs) {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("selection hard coverage", () => {
  it("raises dense cluster targets with sqrt scaling capped by max_candidates_per_cluster", () => {
    expect(requiredCandidatesForCluster(18)).toBe(4);
    expect(requiredCandidatesForCluster(6)).toBe(3);
    expect(requiredCandidatesForCluster(1)).toBe(1);
  });

  it("records all-rejected cluster exemption after the quality gate", () => {
    const report = evaluateSelectionCoverage(
      {
        version: "1",
        project_id: "coverage-test",
        candidates: [
          rejectedCandidate("SEG_A1", "cluster_a"),
          rejectedCandidate("SEG_A2", "cluster_a"),
        ],
      },
      brief([]),
      [
        segment("SEG_A1", "cluster_a"),
        segment("SEG_A2", "cluster_a"),
      ],
    );

    expect(report.status).toBe("met");
    expect(report.clusters[0]).toMatchObject({
      cluster_id: "cluster_a",
      status: "exempt_all_rejected",
      quality_rejected_segment_ids: ["SEG_A1", "SEG_A2"],
    });
    expect(report.notes?.[0]).toContain("exempted");
  });

  it("detects unmatched must_have items with quality-gate matching semantics", () => {
    const report = evaluateSelectionCoverage(
      {
        version: "1",
        project_id: "coverage-test",
        candidates: [candidate("SEG_A1", "cluster_a", { why: "wide forest texture" })],
      },
      brief(["hero sunrise"]),
      [segment("SEG_A1", "cluster_a", { summary: "wide forest texture" })],
    );

    expect(report.status).toBe("failed");
    expect(report.must_have).toEqual([
      { item: "hero sunrise", status: "unmet", matched_segment_ids: [] },
    ]);
    expect(report.unmet.some((item) => item.type === "must_have")).toBe(true);
  });

  it("does not ground must_have coverage in a candidate for a missing canonical segment", () => {
    const mustHave = "one source-grounded hook";
    const stale = candidate("SEG_STALE", "cluster_a", { role: "hero", why: "hook opening source" });
    stale.story_role = "hook";
    stale.eligible_beats = ["b01_hook"];
    stale.evidence = ["brief.must_have"];
    const canonical = candidate("SEG_A1", "cluster_a", { role: "hero", why: "hook opening source" });
    canonical.story_role = "hook";
    canonical.eligible_beats = ["b01_hook"];
    canonical.evidence = ["brief.must_have"];
    const segments = [segment("SEG_A1", "cluster_a", { summary: "hook opening source" })];

    const staleReport = evaluateSelectionCoverage(
      { version: "1", project_id: "coverage-test", candidates: [stale] },
      brief([mustHave]),
      segments,
    );
    const canonicalReport = evaluateSelectionCoverage(
      { version: "1", project_id: "coverage-test", candidates: [canonical] },
      brief([mustHave]),
      segments,
    );

    expect(staleReport.must_have).toEqual([
      { item: mustHave, status: "unmet", matched_segment_ids: [] },
    ]);
    expect(canonicalReport.must_have).toEqual([
      { item: mustHave, status: "met", matched_segment_ids: ["SEG_A1"] },
    ]);
  });

  it("keeps duplicate, rejected, and stale candidates out of cluster counts", () => {
    const report = evaluateSelectionCoverage(
      {
        version: "1",
        project_id: "coverage-test",
        candidates: [
          candidate("SEG_A1", "outdoor_landscape"),
          candidate("SEG_A1", "outdoor_landscape"),
          rejectedCandidate("SEG_A2", "outdoor_landscape"),
          candidate("SEG_STALE", "outdoor_landscape"),
        ],
      },
      brief([]),
      [
        segment("SEG_A1", "outdoor_landscape"),
        segment("SEG_A2", "outdoor_landscape"),
        segment("SEG_A3", "outdoor_landscape"),
      ],
      {
        config: {
          min_candidates_per_cluster: 3,
          cluster_sampling_scale: "none",
          max_candidates_per_cluster: 3,
        },
      },
    );

    expect(report.status).toBe("failed");
    expect(report.clusters[0]).toMatchObject({
      selected_count: 1,
      selected_segment_ids: ["SEG_A1"],
      quality_rejected_segment_ids: ["SEG_A2"],
    });
    expect(report.unmet[0]).toMatchObject({
      type: "cluster_minimum",
      unused_segment_ids: ["SEG_A3"],
    });
  });

  it.each([
    "全編でStrava UIが映るスマホ画面を使う",
    "現地の環境音が入った素材を選ぶ",
    "音楽を演奏する人物が画面に映る",
    "既存の本人発話またはユーザー承認済みテロップ",
  ])("keeps source-dependent and mixed requirements in hard coverage: %s", (mustHave) => {
    const report = evaluateSelectionCoverage(
      { version: "1", project_id: "coverage-test", candidates: [] },
      brief([mustHave]),
      [],
    );

    expect(report.status).toBe("failed");
    expect(report.must_have).toEqual([
      { item: mustHave, status: "unmet", matched_segment_ids: [] },
    ]);
    expect(report.unmet).toContainEqual(expect.objectContaining({
      type: "must_have",
      must_have: mustHave,
    }));
  });

  it("defers production directives instead of treating them as clip-selection gaps", () => {
    const report = evaluateSelectionCoverage(
      {
        version: "1",
        project_id: "coverage-test",
        candidates: [candidate("SEG_A1", "cluster_a")],
      },
      brief([
        "走行中に短いテロップを入れる",
        "BGMを焼き込まない",
        "動画の声・環境音のミックス",
        "フェードアウトで終わる",
      ]),
      [segment("SEG_A1", "cluster_a")],
    );

    expect(report.status).toBe("met");
    expect(report.must_have.every((item) => item.status === "met")).toBe(true);
    expect(report.must_have.every((item) => item.matched_segment_ids.length === 0)).toBe(true);
    expect(report.notes).toContain(
      "4 production directive must_have items deferred to blueprint/timeline validation",
    );
  });
});

describe("triage hard coverage integration", () => {
  it("supplements two deterministic non-rejected unused segments to a minimum of two", async () => {
    const projectDir = createCoverageProject("deterministic-supplement", [], 2);
    const calls: TriageAgentContext[] = [];
    const agent = {
      async run(ctx: TriageAgentContext) {
        calls.push(copyContext(ctx));
        return {
          confirmed: true,
          selects: selects([], "no initial selection"),
        };
      },
    };

    const result = await runTriage(projectDir, agent);
    expect(result.success, JSON.stringify(result.error)).toBe(true);
    const artifact = readSelects(projectDir);
    expect(calls).toHaveLength(2);
    expect(artifact.coverage?.status).toBe("met");
    expect(artifact.candidates).toHaveLength(2);
    expect(artifact.candidates.map((item) => item.segment_id)).toEqual(["SEG_0001", "SEG_0002"]);
    expect(new Set(artifact.candidates.map((item) => item.candidate_id)).size).toBe(2);
  });

  it("keeps a cluster shortage blocked when every unused segment is rejected", async () => {
    const projectDir = createCoverageProject("rejected-shortage", [], 2);
    const allSegmentIds = analysisSegmentIds(projectDir);
    const agent = {
      async run() {
        return {
          confirmed: true,
          selects: {
            version: "1",
            project_id: TRIAGE_PROJECT_ID,
            candidates: allSegmentIds.map((segmentId, index) => index === 0
              ? candidate(segmentId, "outdoor_landscape")
              : rejectedCandidate(segmentId, "outdoor_landscape")),
          },
        };
      },
    };

    const result = await runTriage(projectDir, agent);
    const artifact = readSelects(projectDir);

    expect(result.success).toBe(false);
    expect(artifact.coverage?.status).toBe("failed");
    expect(artifact.coverage?.unmet).toContainEqual(expect.objectContaining({
      type: "cluster_minimum",
      unused_segment_ids: [],
    }));
    expect(result.error?.code).toBe("GATE_CHECK_FAILED");
  });

  it("feeds unmet clusters back once and accepts the repaired selection", async () => {
    const projectDir = createCoverageProject("retry-met");
    const calls: TriageAgentContext[] = [];
    const agent = {
      async run(ctx: TriageAgentContext) {
        calls.push(copyContext(ctx));
        return {
          confirmed: true,
          selects: ctx.coverageFeedback
            ? selects(["SEG_0001", "SEG_0002", "SEG_0003", "SEG_0004"], "hero sunrise")
            : selects(["SEG_0001"], "opening texture"),
        };
      },
    };

    const result = await runTriage(projectDir, agent);
    const artifact = readSelects(projectDir);

    expect(result.success, JSON.stringify(result.error)).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1].coverageFeedback?.gaps.join("\n")).toContain("selected 1/4 required");
    expect(calls[1].coverageFeedback?.gaps.join("\n")).toContain("unused_segment_ids");
    expect(artifact.coverage?.status).toBe("met");
  });

  it("records coverage failed and fails the triage gate when retry remains unmet", async () => {
    const projectDir = createCoverageProject("retry-failed");
    const agent = {
      async run() {
        return {
          confirmed: true,
          selects: selects(["SEG_0001"], "opening texture"),
        };
      },
    };

    const result = await runTriage(projectDir, agent);
    const artifact = readSelects(projectDir);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("GATE_CHECK_FAILED");
    expect(result.promoted?.some((item) => item.endsWith("04_plan/selects_candidates.yaml"))).toBe(true);
    expect(artifact.coverage?.status).toBe("failed");
    expect(artifact.coverage?.unmet.some((item) => item.type === "cluster_minimum")).toBe(false);
    expect(artifact.coverage?.unmet.some((item) => item.type === "must_have")).toBe(true);
  });
});

function createCoverageProject(name: string, mustHaves = ["hero sunrise"], clusterMinimum?: number): string {
  const projectDir = fs.mkdtempSync(path.resolve(`test-selection-coverage-${name}-`));
  tempDirs.push(projectDir);
  fs.mkdirSync(path.join(projectDir, "01_intent"), { recursive: true });
  copyDirSync(path.resolve(SAMPLE_PROJECT, "03_analysis"), path.join(projectDir, "03_analysis"));
  fs.writeFileSync(
    path.join(projectDir, "01_intent/creative_brief.yaml"),
    stringifyYaml(brief(mustHaves)),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(projectDir, "01_intent/unresolved_blockers.yaml"),
    stringifyYaml({ version: "1", project_id: TRIAGE_PROJECT_ID, blockers: [] }),
    "utf-8",
  );
  rewriteSampleSegmentsAsOneDenseCluster(projectDir);
  if (clusterMinimum !== undefined) {
    fs.writeFileSync(
      path.join(projectDir, "analysis_policy.yaml"),
      stringifyYaml({
        selection: {
          min_candidates_per_cluster: clusterMinimum,
          cluster_sampling_scale: "none",
          max_candidates_per_cluster: clusterMinimum,
        },
      }),
      "utf-8",
    );
  }
  writeProjectState(projectDir, {
    version: 1,
    project_id: TRIAGE_PROJECT_ID,
    current_state: "media_analyzed",
    history: [],
  });
  return projectDir;
}

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function rewriteSampleSegmentsAsOneDenseCluster(projectDir: string): void {
  const segmentsPath = path.join(projectDir, "03_analysis/segments.json");
  const parsed = JSON.parse(fs.readFileSync(segmentsPath, "utf-8")) as {
    items?: Array<Record<string, unknown>>;
  };
  parsed.items = (parsed.items ?? []).map((item, index) => ({
    ...item,
    summary: `dense cluster shot ${index + 1}`,
    tags: ["outdoor", "landscape"],
  }));
  fs.writeFileSync(segmentsPath, JSON.stringify(parsed, null, 2), "utf-8");
}

function readSelects(projectDir: string): {
  candidates: Array<{ segment_id: string; candidate_id?: string }>;
  coverage?: {
    status: string;
    unmet: Array<{ type: string; unused_segment_ids?: string[] }>;
  };
} {
  return parseYaml(fs.readFileSync(path.join(projectDir, "04_plan/selects_candidates.yaml"), "utf-8")) as {
    candidates: Array<{ segment_id: string; candidate_id?: string }>;
    coverage?: {
      status: string;
      unmet: Array<{ type: string; unused_segment_ids?: string[] }>;
    };
  };
}

function analysisSegmentIds(projectDir: string): string[] {
  const parsed = JSON.parse(
    fs.readFileSync(path.join(projectDir, "03_analysis/segments.json"), "utf-8"),
  ) as { items?: Array<{ segment_id?: string }> };
  return (parsed.items ?? [])
    .map((item) => item.segment_id)
    .filter((item): item is string => typeof item === "string" && item.length > 0)
    .sort();
}

function brief(mustHave: string[]): CreativeBrief {
  return {
    version: "1",
    project_id: TRIAGE_PROJECT_ID,
    project: {
      id: TRIAGE_PROJECT_ID,
      title: "Coverage Test",
      strategy: "test recall constraints",
      runtime_target_sec: 30,
    },
    message: { primary: "Cover the full camp story." },
    audience: { primary: "Test audience" },
    emotion_curve: ["setup", "build", "release"],
    must_have: mustHave,
    must_avoid: ["off-brief filler"],
    autonomy: { mode: "full", may_decide: [], must_ask: [] },
    resolved_assumptions: ["Analysis fixture is valid."],
  } as CreativeBrief;
}

function segment(
  segmentId: string,
  clusterId: string,
  overrides: { summary?: string } = {},
): SelectionCoverageSegment {
  return {
    segment_id: segmentId,
    asset_id: `AST_${segmentId}`,
    summary: overrides.summary ?? `${clusterId} shot`,
    transcript_excerpt: "",
    tags: [clusterId],
    quality_flags: [],
    editorial_signals: { semantic_cluster_id: clusterId },
  };
}

function selects(segmentIds: string[], evidence: string): SelectsCandidates {
  return {
    version: "1",
    project_id: TRIAGE_PROJECT_ID,
    candidates: segmentIds.map((segmentId, index) =>
      candidate(segmentId, "cluster_a", {
        role: index === 0 ? "hero" : "support",
        why: evidence,
      }),
    ),
  };
}

function candidate(
  segmentId: string,
  clusterId: string,
  overrides: { role?: SelectCandidate["role"]; why?: string } = {},
): SelectCandidate {
  return {
    segment_id: segmentId,
    asset_id: `AST_${segmentId}`,
    src_in_us: 0,
    src_out_us: 3_000_000,
    role: overrides.role ?? "support",
    why_it_matches: overrides.why ?? `${clusterId} coverage`,
    risks: [],
    confidence: 0.8,
  };
}

function rejectedCandidate(segmentId: string, clusterId: string): SelectCandidate {
  return {
    ...candidate(segmentId, clusterId, { role: "reject" }),
    rejection_reason: "auto-rejected: test",
    quality_gate: {
      segment_id: segmentId,
      decision: "reject",
      confidence: "measured",
      reasons: ["test_reject"],
      measurements: {},
      thresholds: {
        shake_reject_above: 0.45,
        shake_warn_above: 0.35,
        sharpness_reject_below: 0.2,
        sharpness_warn_below: 0.35,
        exposure_crush_reject_above: 0.8,
        exposure_crush_warn_above: 0.3,
        exposure_clip_reject_above: 0.8,
        exposure_clip_warn_above: 0.3,
        appraiser_composition_reject_below: 0.2,
        appraiser_subject_prominence_reject_below: 0.2,
        appraiser_composition_warn_below: 0.35,
        appraiser_subject_prominence_warn_below: 0.35,
      },
    },
  };
}

function copyContext(ctx: TriageAgentContext): TriageAgentContext {
  return {
    ...ctx,
    coverageFeedback: ctx.coverageFeedback
      ? {
          ...ctx.coverageFeedback,
          gaps: [...ctx.coverageFeedback.gaps],
        }
      : undefined,
  };
}
