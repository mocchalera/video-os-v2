import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import {
  createSourceInputAttestation,
  writeRenderFreshnessMetadata,
} from "../runtime/render/source-input-attestation.js";
import {
  evaluateWholeCutSemantic,
  type WholeCutSemanticProvider,
  type WholeCutSemanticProviderObservation,
} from "../runtime/review/whole-cut-semantic.js";
import {
  normalizeHumanCorrection,
  normalizeHumanCorrections,
  type HumanCorrectionNote,
} from "../runtime/review/human-corrections.js";
import type { CreativeBrief } from "../runtime/artifacts/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeFixture(): {
  projectDir: string;
  brief: CreativeBrief;
  timeline: Record<string, unknown>;
} {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue32-m2-"));
  tempDirs.push(projectDir);
  fs.mkdirSync(path.join(projectDir, "01_intent"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, "02_media"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, "05_timeline"), { recursive: true });
  const brief: CreativeBrief = {
    version: "1",
    project_id: "issue32-m2-fixture",
    project: { id: "issue32-m2-fixture", title: "Generic fixture", strategy: "message-first" },
    message: { primary: "A deliberate change becomes understandable through observed action." },
    audience: { primary: "people evaluating a change" },
    emotion_curve: ["curiosity", "understanding", "release"],
    must_have: ["the initiating action", "the resulting change"],
    must_avoid: ["unexplained jumps"],
    autonomy: { may_decide: [], must_ask: ["semantic ambiguity"] },
    resolved_assumptions: ["The full cut is the review authority."],
  };
  fs.writeFileSync(path.join(projectDir, "01_intent/creative_brief.yaml"), stringifyYaml(brief));

  const clipIds = ["clip_alpha", "clip_beta"];
  const sourceItems = clipIds.map((assetId) => {
    const sourcePath = path.join(projectDir, "02_media", `${assetId}.mp4`);
    fs.writeFileSync(sourcePath, `source-${assetId}`);
    return {
      asset_id: assetId,
      source_locator: sourcePath,
      local_source_path: sourcePath,
      link_path: `02_media/${assetId}.mp4`,
    };
  });
  fs.writeFileSync(path.join(projectDir, "02_media/source_map.json"), JSON.stringify({
    version: "1",
    project_id: brief.project_id,
    media_dir: "02_media",
    generated_at: "2026-09-01T00:00:00.000Z",
    items: sourceItems,
  }));

  const clips = clipIds.map((assetId, index) => ({
    clip_id: assetId,
    segment_id: `segment_${index}`,
    asset_id: assetId,
    src_in_us: 0,
    src_out_us: 20_000_000,
    timeline_in_frame: index * 30,
    timeline_duration_frames: 30,
    role: "hero",
    motivation: "fixture",
    beat_id: `beat_${index}`,
    fallback_segment_ids: [],
    confidence: 0.8,
    quality_flags: [],
  }));
  const timeline = {
    version: "timeline-issue32-m2",
    project_id: brief.project_id,
    sequence: { name: "fixture", fps_num: 1, fps_den: 1, width: 1920, height: 1080, start_frame: 0 },
    tracks: { video: [{ track_id: "V1", kind: "video", clips }], audio: [] },
    markers: [],
    provenance: {},
  };
  fs.writeFileSync(path.join(projectDir, "05_timeline/timeline.json"), JSON.stringify(timeline, null, 2));
  const renderPath = path.join(projectDir, "09_output/rough-cut.mp4");
  fs.mkdirSync(path.dirname(renderPath), { recursive: true });
  fs.writeFileSync(renderPath, "whole-cut-render");
  writeRenderFreshnessMetadata(projectDir, renderPath, {
    sourceInputsBefore: createSourceInputAttestation(projectDir),
  });
  return { projectDir, brief, timeline };
}

function lowConfidenceProvider(
  alternativeMode: "none" | "distinct" | "duplicate",
): WholeCutSemanticProvider {
  return {
    id: `m2-${alternativeMode}`,
    capability: "available",
    async observeWindow(input) {
      const firstAxis = input.axes[0];
      const observation: WholeCutSemanticProviderObservation = {
        observation_id: `observation-${input.start_sec}`,
        start_sec: input.start_sec,
        end_sec: input.end_sec,
        observation: "The interval contains an observable action and an observable result.",
        inference: "The interval may support the stated change, but the central identity remains uncertain.",
        confidence: 0.82,
        confidence_basis: "measured",
        evidence: {
          render: {
            path: input.render_path,
            start_sec: input.start_sec,
            end_sec: input.end_sec,
            sha256: input.render_sha256,
          },
          source_clip_ids: input.active_clip_ids,
        },
        axis_results: input.axes.map((axis, index) => ({
          axis_id: axis.axis_id,
          outcome: "pass" as const,
          confidence: index === 0 ? 0.55 : 0.82,
          confidence_basis: "measured" as const,
          brief_refs: axis.brief_refs,
          rationale: index === 0 ? "The central identity is not fully resolved." : "The axis is supported by the interval.",
        })),
        story_progression: {
          score: 0.82,
          confidence: 0.82,
          confidence_basis: "measured",
        },
      };
      const makeAlternative = (suffix: string, interpretation: string, editDirection: string) => ({
        alternative_id: `alternative-${input.start_sec}-${suffix}`,
        axis_id: firstAxis.axis_id,
        interpretation,
        edit_direction: editDirection,
        evidence: {
          render: {
            path: input.render_path,
            start_sec: input.start_sec,
            end_sec: input.end_sec,
            sha256: input.render_sha256,
          },
          source_clip_ids: input.active_clip_ids,
        },
        risk: `Risk ${suffix} is carried forward for comparison.`,
        brief_fit: "partial" as const,
        whole_cut_outcome: `Whole-cut outcome ${suffix} remains observable but not conclusive.`,
        decision: suffix === "a" ? "selected" as const : "rejected" as const,
        decision_reason: `Explicit ${suffix} decision reason with evidence and risk comparison.`,
      });
      const alternatives = alternativeMode === "none"
        ? []
        : alternativeMode === "duplicate"
          ? [makeAlternative("a", "The same unresolved identity interpretation.", "Reframe the same unresolved identity."), makeAlternative("b", "The same unresolved identity interpretation.", "Reframe the same unresolved identity.")]
          : [makeAlternative("a", "The visible subject is the narrative anchor.", "Open with the anchor and keep the action order."), makeAlternative("b", "The surrounding action is the narrative anchor.", "Open with the action and defer identity resolution.")];
      return { observations: [observation], alternatives, problem_ranges: [] };
    },
  };
}

function note(overrides: Partial<HumanCorrectionNote> = {}): HumanCorrectionNote {
  return {
    id: "note-1",
    timestamp: "2026-09-01T00:00:00Z",
    reviewer: "reviewer",
    observation: "The full cut does not establish who carries the action.",
    severity: "concern",
    clip_ids: ["clip_alpha"],
    evidence_refs: ["05_timeline/timeline.json#clip_alpha"],
    ...overrides,
  };
}

describe("Issue #32 M2 alternatives and correction normalization", () => {
  it("requires multiple distinct interpretation/edit alternatives for a low-confidence axis", async () => {
    const fixture = makeFixture();
    const result = await evaluateWholeCutSemantic(fixture.projectDir, fixture.brief, fixture.timeline, {
      provider: lowConfidenceProvider("none"),
      durationSec: 60,
      probeRenderDurationImpl: async () => 60,
    });

    expect(result.status).toBe("degraded");
    expect(result.alternative_evaluation.status).toBe("missing");
    expect(result.alternative_evaluation.required_axis_ids).toContain("protagonist_story_identity");
    expect(result.human_hold?.reason).toMatch(/alternative/i);
    expect(result.semantic_outcome.status).not.toBe("pass");
  });

  it("accepts two distinct alternatives and preserves explicit comparison decisions", async () => {
    const fixture = makeFixture();
    const result = await evaluateWholeCutSemantic(fixture.projectDir, fixture.brief, fixture.timeline, {
      provider: lowConfidenceProvider("distinct"),
      durationSec: 60,
      probeRenderDurationImpl: async () => 60,
    });

    expect(result.alternative_evaluation.status).toBe("satisfied");
    expect(result.alternatives).toHaveLength(6);
    expect(result.alternatives?.filter((alternative) => alternative.axis_id === "protagonist_story_identity")).toHaveLength(6);
    expect(result.alternatives?.some((alternative) => alternative.decision === "selected")).toBe(true);
    expect(result.alternatives?.some((alternative) => alternative.decision === "rejected")).toBe(true);
    expect(result.alternatives?.every((alternative) => alternative.decision_reason.length > 0)).toBe(true);
    expect(result.semantic_outcome.status).not.toBe("pass");
  });

  it("rejects alternatives that only recut the same interpretation", async () => {
    const fixture = makeFixture();
    const result = await evaluateWholeCutSemantic(fixture.projectDir, fixture.brief, fixture.timeline, {
      provider: lowConfidenceProvider("duplicate"),
      durationSec: 60,
      probeRenderDurationImpl: async () => 60,
    });

    expect(result.alternative_evaluation.status).toBe("missing");
    expect(result.alternative_evaluation.distinct_alternative_count).toBe(1);
    expect(result.alternative_evaluation.rationale).toMatch(/distinct/i);
  });

  it("normalizes generic correction reasons while preserving original feedback and provenance", () => {
    const explicit = normalizeHumanCorrection(note({
      id: "explicit",
      correction_reason: "identity_confusion",
      observation: "The identity is unclear even though the frame is sharp.",
    }), {
      sourcePath: "06_review/human_notes.yaml",
      sourceSha256: "a".repeat(64),
    });
    const inferred = normalizeHumanCorrection(note({
      id: "inferred",
      correction_reason: undefined,
      observation: "The edit guesses that the later action happened before the opening context.",
      clip_ids: [],
      clip_refs: ["timeline:clip_alpha"],
      evidence_refs: ["03_analysis/segments.json#segment_0"],
    }), {
      sourcePath: "06_review/human_notes.yaml",
      sourceSha256: "b".repeat(64),
    });

    expect(explicit.reason).toBe("identity_confusion");
    expect(explicit.original_feedback).toBe("The identity is unclear even though the frame is sharp.");
    expect(explicit.evidence_provenance.clip_ids).toEqual(["clip_alpha"]);
    expect(explicit.evidence_provenance.source_artifact_sha256).toBe("a".repeat(64));
    expect(inferred.reason).toBe("chronology_context_confusion");
    expect(inferred.original_feedback).toContain("guesses");
    expect(inferred.evidence_provenance.evidence_refs).toEqual(["03_analysis/segments.json#segment_0"]);

    const normalized = normalizeHumanCorrections({ notes: [explicit.source_note, inferred.source_note] }, {
      sourcePath: "06_review/human_notes.yaml",
      sourceSha256: "c".repeat(64),
    });
    expect(normalized).toHaveLength(2);
    expect(normalized.map((item) => item.reason)).toEqual([
      "identity_confusion",
      "chronology_context_confusion",
    ]);
  });
});
