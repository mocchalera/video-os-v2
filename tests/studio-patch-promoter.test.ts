import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { EditBlueprint, SelectsCandidates, TimelineIR } from "../runtime/artifacts/types.js";
import type { ReviewPatch } from "../runtime/compiler/patch.js";
import { promoteStudioPatch, promoteStudioPatchFiles } from "../runtime/eval/studio-patch-promoter.js";

function selects(): SelectsCandidates {
  return {
    version: "1",
    project_id: "studio-promote",
    candidates: [
      candidate("SEG_A"),
      candidate("SEG_B"),
      candidate("SEG_R"),
      candidate("SEG_C", "b2"),
    ],
  };
}

function candidate(segmentID: string, beatID = "b1"): SelectsCandidates["candidates"][number] {
  return {
    segment_id: segmentID,
    asset_id: `AST_${segmentID}`,
    src_in_us: 0,
    src_out_us: 5_000_000,
    role: "support",
    why_it_matches: segmentID,
    risks: [],
    confidence: 0.7,
    eligible_beats: [beatID],
    evidence: [segmentID],
  };
}

function blueprint(): EditBlueprint {
  return {
    version: "1",
    project_id: "studio-promote",
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
          fallback_candidate_refs: [],
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

function timeline(segmentID = "SEG_A"): TimelineIR {
  return {
    version: "1",
    project_id: "studio-promote",
    created_at: "2026-06-23T00:00:00.000Z",
    sequence: {
      name: "studio-promote",
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
            {
              clip_id: "CLP_A",
              segment_id: segmentID,
              asset_id: `AST_${segmentID}`,
              src_in_us: 0,
              src_out_us: 5_000_000,
              timeline_in_frame: 0,
              timeline_duration_frames: 120,
              role: "support",
              beat_id: "b1",
              motivation: "fixture",
              fallback_segment_ids: [],
              confidence: 0.7,
              quality_flags: [],
            },
            {
              clip_id: "CLP_C",
              segment_id: "SEG_C",
              asset_id: "AST_SEG_C",
              src_in_us: 0,
              src_out_us: 5_000_000,
              timeline_in_frame: 120,
              timeline_duration_frames: 120,
              role: "support",
              beat_id: "b2",
              motivation: "fixture",
              fallback_segment_ids: [],
              confidence: 0.7,
              quality_flags: [],
            },
          ],
        },
      ],
      audio: [],
    },
    markers: [],
    provenance: {
      brief_path: "01_intent/creative_brief.yaml",
      blueprint_path: "04_plan/edit_blueprint.yaml",
      selects_path: "04_plan/selects_candidates.yaml",
      compiler_version: "test",
    },
  };
}

describe("promoteStudioPatch", () => {
  it("promotes a replace_segment op into the beat candidate_plan", () => {
    const s = selects();
    const b = blueprint();
    const patch: ReviewPatch = {
      timeline_version: "1",
      operations: [
        { op: "replace_segment", target_clip_id: "CLP_A", with_segment_id: "SEG_R", reason: "better" },
      ],
    };

    const { result } = promoteStudioPatch({
      patch,
      selects: s,
      blueprint: b,
      currentTimeline: timeline("SEG_R"),
      backupTimeline: timeline("SEG_A"),
    });

    expect(result.applied_ops).toBe(1);
    expect(result.blueprint_modified).toBe(true);
    expect(result.selects_modified).toBe(false);
    expect(result.modified_beat_ids).toEqual(["b1"]);
    expect(b.beats[0].candidate_plan).toEqual({
      primary_candidate_ref: "SEG_R",
      fallback_candidate_refs: ["SEG_A", "SEG_B"],
    });
    expect(b.beats[1].candidate_plan?.primary_candidate_ref).toBe("SEG_C");
  });

  it("promotes a remove_segment op by rejecting the candidate and removing beat refs", () => {
    const s = selects();
    const b = blueprint();
    const current = timeline("SEG_C");
    current.tracks.video[0].clips = [current.tracks.video[0].clips[1]];
    const patch: ReviewPatch = {
      timeline_version: "1",
      operations: [
        { op: "remove_segment", target_clip_id: "CLP_A", reason: "remove" },
      ],
    };

    const { result } = promoteStudioPatch({
      patch,
      selects: s,
      blueprint: b,
      currentTimeline: current,
      backupTimeline: timeline("SEG_A"),
    });

    expect(result.applied_ops).toBe(1);
    expect(result.selects_modified).toBe(true);
    expect(result.blueprint_modified).toBe(true);
    expect(s.candidates[0].role).toBe("reject");
    expect(b.beats[0].candidate_plan).toEqual({
      fallback_candidate_refs: ["SEG_B", "SEG_R"],
    });
  });

  it("supports dry-run without mutating artifacts", () => {
    const s = selects();
    const b = blueprint();
    const originalSelects = structuredClone(s);
    const originalBlueprint = structuredClone(b);
    const patch: ReviewPatch = {
      timeline_version: "1",
      operations: [
        { op: "replace_segment", target_clip_id: "CLP_A", with_segment_id: "SEG_R", reason: "better" },
      ],
    };

    const { result, blueprint: dryRunBlueprint } = promoteStudioPatch({
      patch,
      selects: s,
      blueprint: b,
      currentTimeline: timeline("SEG_R"),
      backupTimeline: timeline("SEG_A"),
      dryRun: true,
    });

    expect(result.applied_ops).toBe(1);
    expect(dryRunBlueprint.beats[0].candidate_plan?.primary_candidate_ref).toBe("SEG_R");
    expect(s).toEqual(originalSelects);
    expect(b).toEqual(originalBlueprint);
  });

  it("documents unsupported patch ops as skipped", () => {
    const patch: ReviewPatch = {
      timeline_version: "1",
      operations: [
        { op: "trim_segment", target_clip_id: "CLP_A", new_src_in_us: 10, new_src_out_us: 100, reason: "trim" },
      ],
    };

    const { result } = promoteStudioPatch({
      patch,
      selects: selects(),
      blueprint: blueprint(),
      currentTimeline: timeline(),
    });

    expect(result.applied_ops).toBe(0);
    expect(result.skipped_ops).toBe(1);
    expect(result.warnings[0]).toContain("replace_segment and remove_segment");
  });

  it("updates planning artifacts through the file-level promotion path", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-promote-files-"));
    try {
      fs.mkdirSync(path.join(projectDir, "04_plan"), { recursive: true });
      fs.mkdirSync(path.join(projectDir, "05_timeline"), { recursive: true });
      fs.mkdirSync(path.join(projectDir, "06_review", "patch_history"), { recursive: true });
      fs.writeFileSync(
        path.join(projectDir, "04_plan", "selects_candidates.yaml"),
        stringifyYaml(selects()),
        "utf-8",
      );
      fs.writeFileSync(
        path.join(projectDir, "04_plan", "edit_blueprint.yaml"),
        stringifyYaml(blueprint()),
        "utf-8",
      );
      fs.writeFileSync(
        path.join(projectDir, "05_timeline", "timeline.json"),
        JSON.stringify(timeline("SEG_R")),
        "utf-8",
      );
      fs.writeFileSync(
        path.join(projectDir, "06_review", "patch_history", "timeline_backup_1.json"),
        JSON.stringify(timeline("SEG_A")),
        "utf-8",
      );
      fs.writeFileSync(
        path.join(projectDir, "06_review", "patch_history", "index.json"),
        JSON.stringify({
          version: "1",
          project_id: "studio-promote",
          records: [
            {
              patch_path: "06_review/studio_patch_1.json",
              base_timeline_hash: "base",
              result_timeline_hash: "result",
              timeline_backup_path: "06_review/patch_history/timeline_backup_1.json",
              created_at: "2026-06-23T00:00:00Z",
              source: "studio_ui",
              changed_clip_ids: ["CLP_A"],
              op_count: 1,
            },
          ],
        }),
        "utf-8",
      );
      const patchPath = path.join(projectDir, "06_review", "studio_patch_1.json");
      fs.writeFileSync(
        patchPath,
        JSON.stringify({
          timeline_version: "1",
          operations: [
            { op: "replace_segment", target_clip_id: "CLP_A", with_segment_id: "SEG_R", reason: "better" },
          ],
        } satisfies ReviewPatch),
        "utf-8",
      );

      const preferenceMemoryPath = path.join(projectDir, "00_project/editorial_preference_memory.jsonl");
      const dryRunResult = promoteStudioPatchFiles(projectDir, patchPath, { dryRun: true });
      expect(dryRunResult.applied_ops).toBe(1);
      expect(fs.existsSync(preferenceMemoryPath)).toBe(false);

      fs.mkdirSync(path.dirname(preferenceMemoryPath), { recursive: true });
      fs.writeFileSync(preferenceMemoryPath, "pre-existing-memory-bytes\n");
      const result = promoteStudioPatchFiles(projectDir, patchPath);
      const promotedBlueprint = parseYaml(
        fs.readFileSync(path.join(projectDir, "04_plan", "edit_blueprint.yaml"), "utf-8"),
      ) as EditBlueprint;

      expect(result.applied_ops).toBe(1);
      expect(fs.readFileSync(preferenceMemoryPath, "utf-8")).toBe("pre-existing-memory-bytes\n");
      expect(promotedBlueprint.beats[0].candidate_plan).toEqual({
        primary_candidate_ref: "SEG_R",
        fallback_candidate_refs: ["SEG_A", "SEG_B"],
      });
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
