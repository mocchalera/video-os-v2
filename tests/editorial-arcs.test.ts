import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  clearNarrativeArcCache,
  loadNarrativeArcs,
  narrativeArcForMode,
} from "../runtime/editorial/arc-registry.js";
import { normalize } from "../runtime/compiler/normalize.js";
import { compile } from "../runtime/compiler/index.js";
import type {
  CreativeBrief,
  EditBlueprint,
  NarrativeMode,
  SelectsCandidates,
} from "../runtime/compiler/types.js";
import {
  assertNarrativeArcBlueprintContract,
  evaluateNarrativeArcBlueprintContract,
  evaluateNormalizedNarrativeArcContract,
  NarrativeArcContractError,
} from "../runtime/eval/narrative-arc-contract.js";
import { evaluateBlueprintAgreement } from "../runtime/eval/blueprint-agreement.js";

const tempDirs: string[] = [];

function creatorBrief(mode?: NarrativeMode): CreativeBrief {
  return {
    version: "1",
    project_id: "creator-arc-test",
    project: {
      id: "creator-arc-test",
      title: "Creator arc test",
      strategy: "creator-short",
      runtime_target_sec: 100,
    },
    message: { primary: "A source-grounded challenge" },
    emotion_curve: ["hook", "struggle", "recovery"],
    ...(mode ? { narrative_mode: mode } : {}),
  };
}

function arcBlueprint(mode: NarrativeMode): EditBlueprint {
  const arc = narrativeArcForMode(mode);
  return {
    version: "1",
    project_id: "creator-arc-test",
    sequence_goals: ["Follow the selected creator arc"],
    beats: arc.beats.map((beat) => ({
      id: beat.id,
      label: beat.id,
      purpose: `Fulfil ${beat.id}`,
      target_duration_frames: beat.ratio * 10_000,
      required_roles: beat.required_roles,
      story_role: beat.story_role,
      emotional_valence: beat.valence,
      evidence_required: beat.evidence_required ?? false,
      candidate_plan: { primary_candidate_ref: "C_EVIDENCE" },
    })),
    pacing: {
      opening_cadence: "arc-defined",
      middle_cadence: "arc-defined",
      ending_cadence: "arc-defined",
    },
    music_policy: {
      start_sparse: true,
      allow_release_late: true,
      entry_beat: arc.beats[1].id,
    },
    dialogue_policy: {
      preserve_natural_breath: true,
      avoid_wall_to_wall_voiceover: true,
    },
    transition_policy: { prefer_match_texture_over_flashy_fx: true },
    ending_policy: { should_feel: "truthful" },
    rejection_rules: ["Do not invent evidence"],
  };
}

function evidencedSelects(): SelectsCandidates {
  return {
    version: "1",
    project_id: "creator-arc-test",
    candidates: [{
      candidate_id: "C_EVIDENCE",
      segment_id: "SEG_EVIDENCE",
      asset_id: "AST_EVIDENCE",
      src_in_us: 0,
      src_out_us: 1_000_000,
      role: "hero",
      why_it_matches: "Source evidence for the challenge",
      risks: [],
      confidence: 1,
      evidence: ["source frame and transcript"],
    }],
  };
}

afterEach(() => {
  clearNarrativeArcCache();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("narrative arc registry", () => {
  it("loads both provisional creator-short arcs with normalized ratios", () => {
    const arcs = loadNarrativeArcs();

    expect([...arcs.keys()].sort()).toEqual([
      "personal-challenge-comeback",
      "vlog-day-log",
    ]);
    for (const arc of arcs.values()) {
      expect(arc.status).toBe("provisional");
      expect(arc.beats).toHaveLength(7);
      expect(arc.beats.reduce((sum, beat) => sum + beat.ratio, 0)).toBeCloseTo(1, 12);
      for (const beat of arc.beats) {
        expect(beat).toEqual(expect.objectContaining({
          id: expect.any(String),
          ratio: expect.any(Number),
          story_role: expect.any(String),
          required_roles: expect.any(Array),
          tempo: expect.any(String),
          valence: expect.any(Number),
        }));
      }
    }

    expect(narrativeArcForMode("personal_challenge").id).toBe("personal-challenge-comeback");
    expect(narrativeArcForMode("day_log").id).toBe("vlog-day-log");
  });

  it("preserves and deterministically validates selected arc semantics after compiler normalization", () => {
    const brief = creatorBrief("personal_challenge");
    const blueprint = arcBlueprint("personal_challenge");
    const selects = evidencedSelects();

    expect(evaluateNarrativeArcBlueprintContract(brief, blueprint, selects)).toMatchObject({
      status: "pass",
      narrative_mode: "personal_challenge",
      arc_id: "personal-challenge-comeback",
      issues: [],
    });

    const normalized = normalize(brief, blueprint);
    expect(normalized.beats.map((beat) => ({
      id: beat.beat_id,
      emotional_valence: beat.emotional_valence,
      evidence_required: beat.evidence_required,
    }))).toEqual(blueprint.beats.map((beat) => ({
      id: beat.id,
      emotional_valence: beat.emotional_valence,
      evidence_required: beat.evidence_required,
    })));
    expect(evaluateNormalizedNarrativeArcContract(brief, normalized, selects)).toMatchObject({
      status: "pass",
      issues: [],
    });

    const valenceDrift = structuredClone(normalized);
    valenceDrift.beats[4].emotional_valence = 0.1;
    expect(evaluateNormalizedNarrativeArcContract(brief, valenceDrift, selects)).toMatchObject({
      status: "fail",
      issues: [expect.objectContaining({ code: "emotional_valence_mismatch" })],
    });

    const orderDrift = structuredClone(normalized);
    [orderDrift.beats[0], orderDrift.beats[1]] = [orderDrift.beats[1], orderDrift.beats[0]];
    expect(evaluateNormalizedNarrativeArcContract(brief, orderDrift, selects).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "beat_id_mismatch" })]),
    );

    const durationDrift = structuredClone(normalized);
    durationDrift.beats[0].target_duration_frames += 100;
    expect(evaluateNormalizedNarrativeArcContract(brief, durationDrift, selects).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "beat_ratio_mismatch" })]),
    );

    const missingEvidence = evidencedSelects();
    missingEvidence.candidates[0].evidence = [];
    expect(evaluateNormalizedNarrativeArcContract(brief, normalized, missingEvidence).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "evidence_candidate_missing" })]),
    );
  });

  it("keeps legacy unspecified-mode normalization and eval behavior non-applicable", () => {
    const brief = creatorBrief();
    const blueprint = arcBlueprint("day_log");
    for (const beat of blueprint.beats) {
      delete beat.story_role;
      delete beat.emotional_valence;
      delete beat.evidence_required;
    }

    const normalized = normalize(brief, blueprint);

    expect(normalized.beats.map((beat) => ({
      id: beat.beat_id,
      duration: beat.target_duration_frames,
    }))).toEqual(blueprint.beats.map((beat) => ({
      id: beat.id,
      duration: beat.target_duration_frames,
    })));
    expect(evaluateNormalizedNarrativeArcContract(brief, normalized, evidencedSelects())).toEqual({
      status: "not_applicable",
      issues: [],
    });
    const legacyAgreement = evaluateBlueprintAgreement(blueprint, structuredClone(blueprint));
    expect(legacyAgreement.emotional_valence_agreement).toBeNull();
    expect(legacyAgreement.evidence_required_agreement).toBeNull();
    expect(legacyAgreement.score).toBe(1);
  });

  it("includes valence and evidence-required drift in deterministic blueprint eval", () => {
    const golden = arcBlueprint("personal_challenge");
    const candidate = structuredClone(golden);
    candidate.beats[4].emotional_valence = 0;
    candidate.beats[4].evidence_required = false;

    const report = evaluateBlueprintAgreement(golden, candidate);

    expect(report.beat_id_agreement).toBe(1);
    expect(report.emotional_valence_agreement).toBeLessThan(1);
    expect(report.evidence_required_agreement).toBeLessThan(1);
    expect(report.score).toBeLessThan(1);
  });

  it("rejects a ten-beat draft against the registered seven-beat profile with an expected diff", () => {
    const brief = creatorBrief("day_log");
    const blueprint = arcBlueprint("day_log");
    blueprint.beats.push(
      structuredClone(blueprint.beats[0]),
      structuredClone(blueprint.beats[1]),
      structuredClone(blueprint.beats[2]),
    );
    blueprint.beats[7].id = "unregistered_08";
    blueprint.beats[8].id = "unregistered_09";
    blueprint.beats[9].id = "unregistered_10";

    const result = evaluateNarrativeArcBlueprintContract(brief, blueprint, evidencedSelects());
    expect(result.status).toBe("fail");
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "beat_count_mismatch",
        expected: expect.arrayContaining(["double_hook", "finish_cta"]),
        actual: expect.arrayContaining(["unregistered_10"]),
      }),
    ]));
    expect(() => assertNarrativeArcBlueprintContract(brief, blueprint, evidencedSelects()))
      .toThrow(NarrativeArcContractError);
  });

  it("reports selects eligible_beats drift against the approved blueprint IDs", () => {
    const brief = creatorBrief("day_log");
    const blueprint = arcBlueprint("day_log");
    const selects = evidencedSelects();
    selects.candidates[0].eligible_beats = ["legacy_setup"];

    const result = evaluateNarrativeArcBlueprintContract(brief, blueprint, selects);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "eligible_beat_id_mismatch",
        candidate_ref: "C_EVIDENCE",
        diff: expect.objectContaining({ unexpected: ["legacy_setup"] }),
      }),
    ]));
  });

  it("rejects arc semantic drift on the real compiler path", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-os-arc-compile-"));
    tempDirs.push(projectDir);
    fs.cpSync(path.resolve("projects/sample"), projectDir, {
      recursive: true,
      filter: (source) => path.basename(source) !== ".DS_Store",
    });
    fs.rmSync(path.join(projectDir, "05_timeline"), { recursive: true, force: true });
    const briefPath = path.join(projectDir, "01_intent/creative_brief.yaml");
    const brief = parseYaml(fs.readFileSync(briefPath, "utf-8")) as CreativeBrief;
    brief.narrative_mode = "personal_challenge";
    fs.writeFileSync(briefPath, stringifyYaml(brief), "utf-8");

    const blueprint = arcBlueprint("personal_challenge");
    blueprint.project_id = brief.project_id;
    blueprint.beats[4].emotional_valence = 0.1;

    expect(() => compile({
      projectPath: projectDir,
      repoRoot: path.resolve("."),
      blueprintOverride: blueprint,
      createdAt: "2026-08-20T00:00:00.000Z",
    })).toThrow(/Narrative arc contract failed:.*emotional_valence/);
    expect(fs.existsSync(path.join(projectDir, "05_timeline/timeline.json"))).toBe(false);
  });

  it("rejects an arc whose beat ratios do not sum to 1.0", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "video-os-arcs-"));
    tempDirs.push(dir);
    fs.writeFileSync(path.join(dir, "invalid.yaml"), [
      "id: invalid",
      "narrative_mode: day_log",
      "status: provisional",
      "beats:",
      "  - id: one",
      "    ratio: 0.4",
      "    story_role: hook",
      "    tempo: medium",
      "    valence: 0.5",
      "  - id: two",
      "    ratio: 0.4",
      "    story_role: closing",
      "    tempo: medium",
      "    valence: 0.2",
      "",
    ].join("\n"));

    expect(() => loadNarrativeArcs(dir)).toThrow(/beat ratios must sum to 1\.0/);
  });

  it("scales the same normalized arc to 45 and 90 seconds", () => {
    for (const arc of loadNarrativeArcs().values()) {
      const seconds45 = arc.beats.map((beat) => beat.ratio * 45);
      const seconds90 = arc.beats.map((beat) => beat.ratio * 90);

      expect(seconds45.reduce((sum, seconds) => sum + seconds, 0)).toBeCloseTo(45, 10);
      expect(seconds90.reduce((sum, seconds) => sum + seconds, 0)).toBeCloseTo(90, 10);
      expect(seconds90).toEqual(seconds45.map((seconds) => seconds * 2));
    }
  });
});
