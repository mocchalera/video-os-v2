import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import {
  applyCraftRevisions,
  detectCraftProblems,
  reviewBlueprintCraft,
} from "../runtime/agents/editorial-craft-agent.js";
import type { CraftDecision } from "../runtime/agents/editorial-craft-types.js";
import type { CreativeBrief, EditBlueprint, SelectsCandidates } from "../runtime/artifacts/types.js";
import type { MarlinEventsArtifact } from "../runtime/connectors/marlin-types.js";
import { runBlueprint, type BlueprintAgent } from "../runtime/commands/blueprint.js";
import { readProjectState, writeProjectState } from "../runtime/state/reconcile.js";
import { parseArgs } from "../scripts/blueprint-llm.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function brief(projectId = "craft-test"): CreativeBrief {
  return {
    version: "1",
    project_id: projectId,
    project: {
      id: projectId,
      title: "Craft test",
      strategy: "message-first",
      runtime_target_sec: 30,
      duration_mode: "guide",
    },
    message: {
      primary: "Open with effort, build to proof, end with warmth.",
    },
    emotion_curve: ["curiosity", "effort", "release"],
    must_have: ["effort", "warm ending"],
    autonomy: {
      mode: "full",
      may_decide: ["pacing"],
      must_ask: [],
    },
    order_policy: "editorial",
    audio_policy: "bgm_only",
  } as CreativeBrief;
}

function selects(projectId = "craft-test"): SelectsCandidates {
  return {
    version: "1",
    project_id: projectId,
    editorial_summary: {
      dominant_visual_mode: "event_broll",
      speaker_topology: "unknown",
      motion_profile: "medium",
      transcript_density: "sparse",
    },
    candidates: [
      {
        candidate_id: "cand_a",
        segment_id: "SEG_A",
        asset_id: "AST_A",
        src_in_us: 0,
        src_out_us: 4_000_000,
        role: "hero",
        why_it_matches: "Strong opening action.",
        risks: [],
        confidence: 0.92,
        eligible_beats: ["b01", "b02"],
        evidence: ["visible effort"],
      },
      {
        candidate_id: "cand_b",
        segment_id: "SEG_B",
        asset_id: "AST_B",
        src_in_us: 4_000_000,
        src_out_us: 8_000_000,
        role: "support",
        why_it_matches: "Proof moment with warm reaction.",
        risks: [],
        confidence: 0.88,
        eligible_beats: ["b02", "b03"],
        evidence: ["warm ending"],
      },
    ],
  };
}

function blueprint(projectId = "craft-test"): EditBlueprint {
  return {
    version: "1",
    project_id: projectId,
    sequence_goals: ["Open on action.", "Build proof.", "Resolve warmly."],
    beats: [
      {
        id: "b01",
        label: "hook",
        purpose: "Open on effort.",
        target_duration_frames: 240,
        required_roles: ["hero"],
        story_role: "hook",
        candidate_plan: {
          primary_candidate_ref: "cand_a",
          fallback_candidate_refs: ["cand_b"],
        },
        craft: {
          rhythm: "steady",
        },
      },
      {
        id: "b02",
        label: "proof",
        purpose: "Build proof.",
        target_duration_frames: 240,
        required_roles: ["support"],
        story_role: "experience",
        candidate_plan: {
          primary_candidate_ref: "cand_a",
          fallback_candidate_refs: ["cand_b"],
        },
        craft: {
          rhythm: "steady",
        },
      },
      {
        id: "b03",
        label: "close",
        purpose: "End warmly.",
        target_duration_frames: 240,
        required_roles: ["support"],
        story_role: "closing",
        candidate_plan: {
          primary_candidate_ref: "cand_b",
          fallback_candidate_refs: ["cand_a"],
        },
        craft: {
          rhythm: "steady",
        },
      },
    ],
    pacing: {
      opening_cadence: "steady",
      middle_cadence: "steady",
      ending_cadence: "steady",
      default_duration_target_sec: 30,
    },
    music_policy: {
      start_sparse: true,
      allow_release_late: true,
      entry_beat: "b01",
      bgm_duration_sec: 30,
    },
    dialogue_policy: {
      preserve_natural_breath: true,
      avoid_wall_to_wall_voiceover: true,
    },
    transition_policy: {
      prefer_match_texture_over_flashy_fx: true,
    },
    ending_policy: {
      should_feel: "warm and resolved",
    },
    rejection_rules: ["Reject off-brief filler."],
    duration_policy: {
      mode: "guide",
      source: "explicit_brief",
      target_source: "explicit_brief",
      target_duration_sec: 30,
      min_duration_sec: 20,
      max_duration_sec: 40,
      hard_gate: false,
      protect_vlm_peaks: true,
    },
    timeline_order: "editorial",
    track_layout: "single",
  };
}

function marlinEvents(projectId = "craft-test"): MarlinEventsArtifact {
  return {
    project_id: projectId,
    artifact_version: "marlin-events-v1",
    model: {
      provider: "marlin",
      model_alias: "marlin-2b",
      model_snapshot: "test",
    },
    items: [
      {
        asset_id: "AST_A",
        source_path: "/media/a.mp4",
        scene: "A person starts moving with clear effort.",
        events: [
          {
            event_id: "EV_A_01",
            start_us: 0,
            end_us: 3_000_000,
            description: "Action starts and peaks.",
          },
        ],
        find_results: [],
      },
    ],
  };
}

function uncertainty(projectId: string) {
  return {
    version: "1",
    project_id: projectId,
    uncertainties: [],
  };
}

function createProject(projectId = "craft-test"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "video-os-craft-"));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, "01_intent"), { recursive: true });
  fs.mkdirSync(path.join(dir, "04_plan"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "01_intent", "creative_brief.yaml"),
    stringifyYaml(brief(projectId)),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(dir, "01_intent", "unresolved_blockers.yaml"),
    stringifyYaml({ version: "1", project_id: projectId, blockers: [] }),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(dir, "04_plan", "selects_candidates.yaml"),
    stringifyYaml(selects(projectId)),
    "utf-8",
  );
  writeProjectState(dir, {
    version: 1,
    project_id: projectId,
    current_state: "selects_ready",
    history: [],
  });
  return dir;
}

function blueprintAgent(): BlueprintAgent {
  return {
    async run(ctx) {
      return {
        blueprint: blueprint(ctx.projectId),
        uncertaintyRegister: uncertainty(ctx.projectId),
        confirmed: true,
      };
    },
  };
}

describe("editorial craft agent", () => {
  it("catches monotonous rhythm in the craft review prompt and normalizes a revision", async () => {
    let capturedPrompt = "";
    const decision = await reviewBlueprintCraft(
      brief(),
      selects(),
      blueprint(),
      marlinEvents(),
      {
        llm: async (prompt) => {
          capturedPrompt = prompt;
          return JSON.stringify({
            verdict: "revise",
            issues: [
              {
                beat_id: "b02",
                issue: "All beats sit on steady rhythm, so the middle feels assembled.",
                suggestion: "Use accelerando in b02 and let b03 breathe.",
                severity: "improvement",
              },
            ],
            revisions: [
              {
                beat_id: "b02",
                field: "craft.rhythm",
                old_value: "steady",
                new_value: "accelerando",
                rationale: "The proof beat should build energy.",
              },
            ],
            summary: "Revise rhythm variation before compile.",
          });
        },
      },
    );

    expect(capturedPrompt).toContain("All 3 beats use rhythm");
    expect(capturedPrompt).toContain("BGM and duration constraints");
    expect(detectCraftProblems(blueprint()).some((issue) => issue.issue.includes("All 3 beats"))).toBe(true);
    expect(decision.verdict).toBe("revise");
    expect(decision.revisions).toEqual([
      {
        beat_id: "b02",
        field: "craft.rhythm",
        old_value: "steady",
        new_value: "accelerando",
        rationale: "The proof beat should build energy.",
      },
    ]);
  });

  it("applies craft revisions to schema-known beat fields", () => {
    const original = blueprint();
    const decision: CraftDecision = {
      verdict: "revise",
      issues: [],
      revisions: [
        {
          beat_id: "b02",
          field: "craft.rhythm",
          old_value: "steady",
          new_value: "accelerando",
          rationale: "Build energy.",
        },
        {
          beat_id: "b02",
          field: "candidate_plan.primary_candidate_ref",
          old_value: "cand_a",
          new_value: "cand_b",
          rationale: "Front-load warmer proof.",
        },
      ],
      summary: "Apply revisions.",
    };

    const revised = applyCraftRevisions(original, decision);

    expect(original.beats[1].craft?.rhythm).toBe("steady");
    expect(revised.beats[1].craft?.rhythm).toBe("accelerando");
    expect(revised.beats[1].candidate_plan).toEqual({
      primary_candidate_ref: "cand_b",
      fallback_candidate_refs: ["cand_a"],
    });
  });

  it("passes an accepted blueprint through unchanged", () => {
    const original = blueprint();
    const revised = applyCraftRevisions(original, {
      verdict: "accept",
      issues: [],
      revisions: [
        {
          beat_id: "b01",
          field: "craft.rhythm",
          old_value: "steady",
          new_value: "accelerando",
          rationale: "Should not apply on accept.",
        },
      ],
      summary: "Accepted.",
    });

    expect(revised).toEqual(original);
  });

  it("ignores invalid revisions for nonexistent beat ids", () => {
    const original = blueprint();
    const revised = applyCraftRevisions(original, {
      verdict: "revise",
      issues: [],
      revisions: [
        {
          beat_id: "missing",
          field: "craft.rhythm",
          old_value: "steady",
          new_value: "accelerando",
          rationale: "Invalid beat id.",
        },
      ],
      summary: "Invalid revision ignored.",
    });

    expect(revised).toEqual(original);
  });

  it("prevents blueprint promotion when the craft reviewer blocks", async () => {
    const projectDir = createProject();
    const result = await runBlueprint(projectDir, blueprintAgent(), {
      iterativeEngine: false,
      craftReviewer: async () => ({
        verdict: "block",
        issues: [
          {
            beat_id: "b03",
            issue: "Closing beat does not resolve the stated emotion curve.",
            suggestion: "Choose a closing proof moment or rerun selects.",
            severity: "critical",
          },
        ],
        revisions: [],
        summary: "Closing beat is unresolved.",
      }),
    });

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("blocked promotion");
    expect(fs.existsSync(path.join(projectDir, "04_plan", "edit_blueprint.yaml"))).toBe(false);
    expect(fs.readFileSync(path.join(projectDir, "04_plan", "editorial_craft_review.md"), "utf-8"))
      .toContain("Closing beat is unresolved.");
    expect(readProjectState(projectDir)?.current_state).toBe("blocked");
  });

  it("parses --skip-craft-review for the headless CLI", () => {
    expect(parseArgs(["node", "blueprint-llm.ts", "/tmp/project", "--skip-craft-review"])).toEqual({
      projectDir: "/tmp/project",
      model: undefined,
      skipCraftReview: true,
      skipCraftFrames: false,
    });
  });

  it("parses --skip-craft-frames for the headless CLI", () => {
    expect(parseArgs(["node", "blueprint-llm.ts", "/tmp/project", "--skip-craft-frames"])).toEqual({
      projectDir: "/tmp/project",
      model: undefined,
      skipCraftReview: false,
      skipCraftFrames: true,
    });
  });
});
