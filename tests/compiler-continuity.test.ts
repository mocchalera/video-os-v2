import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { compile, ContinuityConstraintError } from "../runtime/compiler/index.js";
import type { Candidate, EditBlueprint } from "../runtime/compiler/types.js";

const repoRoot = path.resolve(".");
const createdAt = "2026-03-21T00:00:00Z";
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("compiler continuity constraints", () => {
  it("orders beat clips by semantic cluster, earliest source time, then src_in_us", () => {
    const projectDir = createProject({
      beats: [beat("b01", { target_duration_frames: 72, required_roles: ["support"] })],
      candidates: [
        candidate("SEG_A1", "AST_A", "support", ["b01"], {
          src_in_us: 50_000_000,
          semantic_rank: 1,
          semantic_cluster_id: "cluster-late",
        }),
        candidate("SEG_B", "AST_B", "support", ["b01"], {
          src_in_us: 10_000_000,
          semantic_rank: 2,
          semantic_cluster_id: "cluster-early",
        }),
        candidate("SEG_A2", "AST_C", "support", ["b01"], {
          src_in_us: 60_000_000,
          semantic_rank: 3,
          semantic_cluster_id: "cluster-late",
        }),
      ],
    });

    const result = compile({ projectPath: projectDir, repoRoot, createdAt });
    const v1 = result.timeline.tracks.video.find((track) => track.track_id === "V1")!;

    expect(v1.clips.map((clip) => clip.segment_id)).toEqual(["SEG_B", "SEG_A1", "SEG_A2"]);
    expect(result.continuity.reorders).toEqual([
      expect.objectContaining({
        code: "beat_semantic_cluster_order",
        beat_id: "b01",
        track_id: "V1",
      }),
    ]);
  });

  it("coalesces same-asset repeats inside one beat before hard validation", () => {
    const projectDir = createProject({
      beats: [beat("b01", { target_duration_frames: 72, required_roles: ["support"] })],
      candidates: [
        candidate("SEG_A1", "AST_REPEAT", "support", ["b01"], {
          src_in_us: 0,
          semantic_rank: 1,
          semantic_cluster_id: "a-open",
        }),
        candidate("SEG_B", "AST_BREAK", "support", ["b01"], {
          src_in_us: 10_000_000,
          semantic_rank: 2,
          semantic_cluster_id: "break",
        }),
        candidate("SEG_A2", "AST_REPEAT", "support", ["b01"], {
          src_in_us: 20_000_000,
          semantic_rank: 3,
          semantic_cluster_id: "a-close",
        }),
      ],
    });

    const result = compile({ projectPath: projectDir, repoRoot, createdAt });
    const v1 = result.timeline.tracks.video.find((track) => track.track_id === "V1")!;

    expect(v1.clips.map((clip) => clip.segment_id)).toEqual(["SEG_A1", "SEG_A2", "SEG_B"]);
    expect(result.continuity.errors).toEqual([]);
    expect(result.continuity.reorders).toContainEqual(expect.objectContaining({
      code: "beat_same_asset_coalesce",
      beat_id: "b01",
    }));
  });

  it("fails compilation when same-asset repeats are non-adjacent across beats", () => {
    const projectDir = createProject({
      beats: [beat("b01"), beat("b02"), beat("b03")],
      candidates: [
        candidate("SEG_A1", "AST_REPEAT", "hero", ["b01"], { semantic_rank: 1 }),
        candidate("SEG_B", "AST_BREAK", "hero", ["b02"], { semantic_rank: 1 }),
        candidate("SEG_A2", "AST_REPEAT", "hero", ["b03"], { semantic_rank: 1 }),
      ],
    });

    expect(() => compile({ projectPath: projectDir, repoRoot, createdAt })).toThrow(
      /source asset AST_REPEAT appears in 2 non-adjacent timeline blocks/,
    );

    try {
      compile({ projectPath: projectDir, repoRoot, createdAt });
    } catch (error) {
      expect(error).toBeInstanceOf(ContinuityConstraintError);
      const continuity = (error as ContinuityConstraintError).continuity;
      expect(continuity.errors[0]).toMatchObject({
        code: "same_asset_non_adjacent",
        asset_id: "AST_REPEAT",
        severity: "error",
      });
      expect(continuity.errors[0].suggested_fix).toContain("beat.allow_revisit");
    }
  });

  it("records same-cluster non-adjacent repeats as warnings in result and timeline metadata", () => {
    const projectDir = createProject({
      beats: [beat("b01"), beat("b02"), beat("b03")],
      candidates: [
        candidate("SEG_A1", "AST_A", "hero", ["b01"], {
          semantic_rank: 1,
          semantic_cluster_id: "callback",
        }),
        candidate("SEG_B", "AST_B", "hero", ["b02"], {
          semantic_rank: 1,
          semantic_cluster_id: "middle",
        }),
        candidate("SEG_A2", "AST_C", "hero", ["b03"], {
          semantic_rank: 1,
          semantic_cluster_id: "callback",
        }),
      ],
    });

    const result = compile({ projectPath: projectDir, repoRoot, createdAt });
    const metadata = result.timeline.metadata?.continuity as typeof result.continuity;

    expect(result.continuity.errors).toEqual([]);
    expect(result.continuity.warnings).toHaveLength(1);
    expect(result.continuity.warnings[0]).toMatchObject({
      code: "same_cluster_non_adjacent",
      semantic_cluster_id: "callback",
      severity: "warning",
    });
    expect(metadata.warnings).toEqual(result.continuity.warnings);
  });

  it("exempts declared allow_revisit callbacks from repeat constraints", () => {
    const projectDir = createProject({
      beats: [
        beat("b01"),
        beat("b02"),
        beat("b03", {
          allow_revisit: {
            semantic_cluster_ids: ["callback"],
            asset_ids: ["AST_REPEAT"],
            reason: "intentional closing callback",
          },
        }),
      ],
      candidates: [
        candidate("SEG_A1", "AST_REPEAT", "hero", ["b01"], {
          semantic_rank: 1,
          semantic_cluster_id: "callback",
        }),
        candidate("SEG_B", "AST_BREAK", "hero", ["b02"], {
          semantic_rank: 1,
          semantic_cluster_id: "middle",
        }),
        candidate("SEG_A2", "AST_REPEAT", "hero", ["b03"], {
          semantic_rank: 1,
          semantic_cluster_id: "callback",
        }),
      ],
    });

    const result = compile({ projectPath: projectDir, repoRoot, createdAt });

    expect(result.continuity.errors).toEqual([]);
    expect(result.continuity.warnings).toEqual([]);
    expect(result.continuity.exemptions).toEqual([
      expect.objectContaining({
        beat_id: "b03",
        semantic_cluster_ids: ["callback"],
        asset_ids: ["AST_REPEAT"],
        reason: "intentional closing callback",
      }),
    ]);
  });

  it("treats repeated exact candidate_plan refs as intentional reprises", () => {
    const projectDir = createProject({
      activeEditingSkills: ["human_golden_order"],
      beats: [
        beat("b01", {
          target_duration_frames: 48,
          candidate_plan: {
            primary_candidate_ref: "SEG_A",
            fallback_candidate_refs: ["SEG_B"],
          },
        }),
        beat("b02", {
          candidate_plan: { primary_candidate_ref: "SEG_MIDDLE" },
        }),
        beat("b03", {
          target_duration_frames: 72,
          candidate_plan: {
            primary_candidate_ref: "SEG_B",
            fallback_candidate_refs: ["SEG_A", "SEG_CLOSE"],
          },
        }),
      ],
      candidates: [
        candidate("SEG_A", "AST_A", "hero", ["b01", "b03"]),
        candidate("SEG_B", "AST_B", "hero", ["b01", "b03"]),
        candidate("SEG_MIDDLE", "AST_MIDDLE", "hero", ["b02"]),
        candidate("SEG_CLOSE", "AST_CLOSE", "hero", ["b03"]),
      ],
    });

    const result = compile({ projectPath: projectDir, repoRoot, createdAt });
    const v1 = result.timeline.tracks.video.find((track) => track.track_id === "V1")!;

    expect(v1.clips.map((clip) => clip.segment_id)).toEqual([
      "SEG_A",
      "SEG_B",
      "SEG_MIDDLE",
      "SEG_B",
      "SEG_A",
      "SEG_CLOSE",
    ]);
    expect(result.resolution.total_frames).toBe(144);
    expect(result.continuity.errors).toEqual([]);
    expect(result.continuity.exemptions).toContainEqual(expect.objectContaining({
      beat_id: "b03",
      asset_ids: ["AST_A", "AST_B"],
      reason: "explicit candidate_plan reprise under human_golden_order",
    }));
  });

  it("treats distinct authored occurrences from the same asset as intentional revisits", () => {
    const projectDir = createProject({
      activeEditingSkills: ["human_golden_order"],
      beats: [
        beat("b01", {
          candidate_plan: { primary_candidate_ref: "cand_first" },
        }),
        beat("b02", {
          candidate_plan: { primary_candidate_ref: "cand_return" },
        }),
      ],
      candidates: [
        candidate("SEG_SHARED", "AST_SHARED", "hero", ["b01"], {
          candidate_id: "cand_first",
          src_in_us: 0,
        }),
        candidate("SEG_SHARED", "AST_SHARED", "hero", ["b02"], {
          candidate_id: "cand_return",
          src_in_us: 2_000_000,
        }),
      ],
    });

    const result = compile({ projectPath: projectDir, repoRoot, createdAt });

    expect(result.timeline.tracks.video[0].clips.map((clip) => clip.candidate_ref)).toEqual([
      "cand_first",
      "cand_return",
    ]);
    expect(result.continuity.errors).toEqual([]);
    expect(result.continuity.exemptions).toContainEqual(expect.objectContaining({
      beat_id: "b02",
      asset_ids: ["AST_SHARED"],
      reason: "explicit candidate_plan reprise under human_golden_order",
    }));
  });

  it("keeps intentional-short metadata on an authored 11-frame placement", () => {
    const projectDir = createProject({
      activeEditingSkills: ["human_golden_order"],
      beats: [beat("b01", {
        target_duration_frames: 11,
        candidate_plan: { primary_candidate_ref: "cand_short" },
      })],
      candidates: [candidate("SEG_SHORT", "AST_SHORT", "hero", ["b01"], {
        candidate_id: "cand_short",
        duration_us: 458_333,
      })],
    });

    const result = compile({ projectPath: projectDir, repoRoot, createdAt });
    const clip = result.timeline.tracks.video[0].clips[0];

    expect(clip.timeline_duration_frames).toBe(11);
    expect(clip.metadata?.editorial).toEqual(expect.objectContaining({
      intentional_short_clip: true,
      reason: "human_golden_order",
      applied_skills: ["human_golden_order"],
    }));
  });

  it("blocks an exact candidate_plan when an authored placement is missing", () => {
    const projectDir = createProject({
      activeEditingSkills: ["human_golden_order"],
      beats: [beat("b01", {
        candidate_plan: {
          primary_candidate_ref: "SEG_PRESENT",
          fallback_candidate_refs: ["SEG_MISSING"],
        },
      })],
      candidates: [candidate("SEG_PRESENT", "AST_PRESENT", "hero", ["b01"])],
    });

    expect(() => compile({ projectPath: projectDir, repoRoot, createdAt })).toThrow(
      /human_golden_order constraint failed: candidate_plan expected 2 placements but compiled 1/,
    );
  });

  it("blocks an exact candidate_plan when duration drift exceeds its rubric tolerance", () => {
    const projectDir = createProject({
      activeEditingSkills: ["human_golden_order"],
      qualityTargets: { duration_pacing_tolerance_pct: 5 },
      runtimeTargetSec: 2,
      beats: [beat("b01", {
        target_duration_frames: 48,
        candidate_plan: { primary_candidate_ref: "SEG_SHORT" },
      })],
      candidates: [candidate("SEG_SHORT", "AST_SHORT", "hero", ["b01"])],
    });

    expect(() => compile({ projectPath: projectDir, repoRoot, createdAt })).toThrow(
      /duration drift 50% exceeds 5% tolerance/,
    );
  });

  it("keeps compiling projects without semantic cluster information", () => {
    const projectDir = createProject({
      beats: [beat("b01"), beat("b02")],
      candidates: [
        candidate("SEG_A", "AST_A", "hero", ["b01"], { semantic_rank: 1 }),
        candidate("SEG_B", "AST_B", "hero", ["b02"], { semantic_rank: 1 }),
      ],
    });

    const result = compile({ projectPath: projectDir, repoRoot, createdAt });

    expect(result.timeline.tracks.video[0].clips.map((clip) => clip.segment_id)).toEqual(["SEG_A", "SEG_B"]);
    expect(result.continuity.errors).toEqual([]);
    expect(result.continuity.warnings).toEqual([]);
  });

  it("emits byte-identical timeline.json for repeated compiles of the same input", () => {
    const projectDir = createProject({
      beats: [beat("b01"), beat("b02")],
      candidates: [
        candidate("SEG_A", "AST_A", "hero", ["b01"], {
          semantic_rank: 1,
          semantic_cluster_id: "a",
        }),
        candidate("SEG_B", "AST_B", "hero", ["b02"], {
          semantic_rank: 1,
          semantic_cluster_id: "b",
        }),
      ],
    });

    const first = compile({ projectPath: projectDir, repoRoot, createdAt });
    const firstBytes = fs.readFileSync(first.outputPath, "utf-8");
    const second = compile({ projectPath: projectDir, repoRoot, createdAt });
    const secondBytes = fs.readFileSync(second.outputPath, "utf-8");

    expect(secondBytes).toBe(firstBytes);
  });

  it("repairs incomplete dialogue during compile and keeps original audio in sync", () => {
    const projectDir = createProject({
      activeEditingSkills: ["talking_head_pacing"],
      audioPolicy: "original_only",
      beats: [beat("b01", {
        target_duration_frames: 144,
        required_roles: ["dialogue"],
        candidate_plan: { primary_candidate_ref: "SEG_DIALOGUE" },
      })],
      candidates: [candidate("SEG_DIALOGUE", "AST_INTERVIEW", "dialogue", ["b01"], {
        src_in_us: 2_100_000,
        duration_us: 1_900_000,
      })],
    });
    fs.mkdirSync(path.join(projectDir, "03_analysis", "transcripts"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, "03_analysis", "segments.json"), JSON.stringify({
      items: [{
        segment_id: "SEG_DIALOGUE",
        asset_id: "AST_INTERVIEW",
        src_in_us: 0,
        src_out_us: 10_000_000,
        duration_us: 10_000_000,
        rep_frame_us: 5_000_000,
      }],
    }), "utf-8");
    fs.writeFileSync(
      path.join(projectDir, "03_analysis", "transcripts", "TR_AST_INTERVIEW.json"),
      JSON.stringify({
        asset_id: "AST_INTERVIEW",
        items: [
          {
            start_us: 0,
            end_us: 2_000_000,
            speaker: "guest",
            text: "受講前はAIを資料作成に使っていました",
          },
          {
            start_us: 2_100_000,
            end_us: 4_000_000,
            speaker: "guest",
            text: "ってことは僕も変わらなかったと思いますけど",
          },
          {
            start_us: 4_100_000,
            end_us: 6_000_000,
            speaker: "guest",
            text: "実際に受講して使い方が変わりました",
          },
        ],
      }),
      "utf-8",
    );

    const messages: string[] = [];
    const result = compile({
      projectPath: projectDir,
      repoRoot,
      createdAt,
      log: (message) => messages.push(message),
    });
    const video = result.timeline.tracks.video
      .find((track) => track.track_id === "V1")!.clips[0];
    const audio = result.timeline.tracks.audio
      .flatMap((track) => track.clips)
      .find((clip) => clip.segment_id === "SEG_DIALOGUE");

    expect(video).toMatchObject({
      src_in_us: 0,
      src_out_us: 6_000_000,
      timeline_duration_frames: 144,
      metadata: {
        dialogue_semantic_repair: {
          status: "repaired",
          added_utterance_count: 2,
          issues_after: [],
        },
      },
    });
    expect(audio).toMatchObject({
      src_in_us: 0,
      src_out_us: 6_000_000,
      timeline_duration_frames: 144,
    });
    expect(messages).toContainEqual(expect.stringContaining(
      "[dialogue-semantic-repair] attempted=1 repaired=1 unresolved=0",
    ));
  });
});

function createProject(input: {
  beats: EditBlueprint["beats"];
  candidates: Candidate[];
  activeEditingSkills?: string[];
  audioPolicy?: "ducking" | "bgm_only" | "original_only";
  qualityTargets?: EditBlueprint["quality_targets"];
  runtimeTargetSec?: number;
}): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughcut-continuity-"));
  tempDirs.push(projectDir);
  fs.mkdirSync(path.join(projectDir, "01_intent"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, "04_plan"), { recursive: true });

  writeYaml(path.join(projectDir, "01_intent", "creative_brief.yaml"), {
    version: "1",
    project_id: "continuity-fixture",
    created_at: createdAt,
    project: {
      id: "continuity-fixture",
      title: "Continuity Fixture",
      strategy: "test continuity constraints",
      duration_mode: "guide",
      runtime_target_sec: input.runtimeTargetSec,
    },
    message: { primary: "test" },
    emotion_curve: ["start", "end"],
    caption_policy: "off",
    audio_policy: input.audioPolicy ?? "bgm_only",
  });

  writeYaml(path.join(projectDir, "04_plan", "edit_blueprint.yaml"), {
    version: "1",
    project_id: "continuity-fixture",
    sequence_goals: ["test continuity"],
    beats: input.beats,
    pacing: {
      opening_cadence: "steady",
      middle_cadence: "steady",
      ending_cadence: "steady",
      max_shot_length_frames: 96,
    },
    music_policy: {
      start_sparse: true,
      allow_release_late: false,
      entry_beat: input.beats[0]?.id ?? "b01",
    },
    dialogue_policy: {
      preserve_natural_breath: false,
      avoid_wall_to_wall_voiceover: true,
    },
    transition_policy: {
      prefer_match_texture_over_flashy_fx: true,
      allow_hard_cuts: true,
    },
    ending_policy: {
      should_feel: "complete",
    },
    rejection_rules: ["reject accidental repetition"],
    active_editing_skills: input.activeEditingSkills,
    quality_targets: input.qualityTargets,
  } satisfies EditBlueprint);

  writeYaml(path.join(projectDir, "04_plan", "selects_candidates.yaml"), {
    version: "1",
    project_id: "continuity-fixture",
    candidates: input.candidates,
  });

  return projectDir;
}

function beat(
  id: string,
  overrides: Partial<EditBlueprint["beats"][number]> = {},
): EditBlueprint["beats"][number] {
  return {
    id,
    label: id,
    purpose: `purpose ${id}`,
    target_duration_frames: 24,
    required_roles: ["hero"],
    preferred_roles: [],
    ...overrides,
  };
}

function candidate(
  segmentId: string,
  assetId: string,
  role: Candidate["role"],
  eligibleBeats: string[],
  overrides: {
    candidate_id?: string;
    duration_us?: number;
    src_in_us?: number;
    semantic_rank?: number;
    semantic_cluster_id?: string;
  } = {},
): Candidate {
  const srcInUs = overrides.src_in_us ?? 0;
  return {
    candidate_id: overrides.candidate_id,
    segment_id: segmentId,
    asset_id: assetId,
    src_in_us: srcInUs,
    src_out_us: srcInUs + (overrides.duration_us ?? 1_000_000),
    role,
    why_it_matches: segmentId,
    risks: [],
    confidence: 0.9,
    semantic_rank: overrides.semantic_rank ?? 1,
    quality_flags: [],
    eligible_beats: eligibleBeats,
    editorial_signals: overrides.semantic_cluster_id
      ? { semantic_cluster_id: overrides.semantic_cluster_id }
      : undefined,
  };
}

function writeYaml(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, stringifyYaml(value), "utf-8");
}
