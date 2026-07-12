import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import { buildCandidateBrowserDocument, readCandidateBrowserDocument } from "./read-candidates.js";
import type { EditBlueprint, SelectsCandidates } from "../runtime/artifacts/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("read-candidates", () => {
  it("converts the demo planning artifacts into Swift-decodable JSON shape", () => {
    const document = readCandidateBrowserDocument("projects/demo");

    expect(document.project_id).toBe("sample-mountain-reset");
    expect(document.candidates.length).toBeGreaterThan(0);
    expect(document.beat_plans.length).toBeGreaterThan(0);

    const candidate = document.candidates[0];
    expect(candidate).toMatchObject({
      candidate_id: "SEG_0025",
      segment_id: "SEG_0025",
      asset_id: "AST_005",
      src_in_us: 1_400_000,
      src_out_us: 6_000_000,
      role: "hero",
      confidence: 0.93,
      why_it_matches: expect.any(String),
      risks: expect.any(Array),
      eligible_beats: expect.arrayContaining(["b01"]),
      story_role: null,
      evidence: expect.any(Array),
      motif_tags: expect.any(Array),
      trim_hint: null,
      editorial_signals: null,
    });

    const beat = document.beat_plans[0];
    expect(beat).toMatchObject({
      beat_id: "b01",
      label: "hook",
      target_duration_frames: 96,
      primary_candidate_ref: null,
      fallback_candidate_refs: [],
    });
  });

  it("includes candidate plan fallbacks and normalizes optional signal fields", () => {
    const selects: SelectsCandidates = {
      version: "1",
      project_id: "fixture",
      candidates: [
        {
          candidate_id: "cand_a",
          segment_id: "SEG_A",
          asset_id: "AST_A",
          src_in_us: 100,
          src_out_us: 900,
          role: "support",
          confidence: 0.82,
          why_it_matches: "matches the beat",
          risks: [],
          eligible_beats: ["beat_a"],
          evidence: ["retrieval score 0.82"],
          motif_tags: ["texture"],
          trim_hint: {
            recommended_in_us: 200,
            recommended_out_us: 800,
            peak_ref: "peak_1",
            key_frame_path: "03_analysis/frames/SEG_A/representative.jpg",
          } as SelectsCandidates["candidates"][number]["trim_hint"] & { key_frame_path: string },
          editorial_signals: {
            peak_ref: "peak_1",
            peak_type: "visual_peak",
            peak_strength_score: 0.7,
          },
        },
      ],
    };
    const blueprint = {
      version: "1",
      project_id: "fixture",
      sequence_goals: [],
      beats: [
        {
          id: "beat_a",
          label: "Beat A",
          target_duration_frames: 120,
          required_roles: ["support"],
          candidate_plan: {
            primary_candidate_ref: "cand_a",
            fallback_candidate_refs: ["SEG_B", "cand_c"],
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
        allow_release_late: false,
        entry_beat: "beat_a",
      },
      dialogue_policy: {
        preserve_natural_breath: true,
        avoid_wall_to_wall_voiceover: true,
      },
    } satisfies EditBlueprint;

    const document = buildCandidateBrowserDocument(selects, blueprint);

    expect(document.beat_plans[0].primary_candidate_ref).toBe("cand_a");
    expect(document.beat_plans[0].fallback_candidate_refs).toEqual(["SEG_B", "cand_c"]);
    expect(document.candidates[0].key_frame_path).toBe("03_analysis/frames/SEG_A/representative.jpg");
    expect(document.candidates[0].trim_hint).toEqual({
      source_center_us: 500,
      preferred_duration_us: 600,
      recommended_in_us: 200,
      recommended_out_us: 800,
      peak_ref: "peak_1",
      rationale: null,
    });
    expect(document.candidates[0].editorial_signals?.peak_strength_score).toBe(0.7);
  });

  it("prints JSON from the CLI", () => {
    const fixture = makeProjectFixture();
    const output = execFileSync("npx", ["tsx", "scripts/read-candidates.ts", "--project", fixture, "--json"], {
      cwd: path.resolve("."),
      encoding: "utf-8",
    });

    const parsed = JSON.parse(output) as ReturnType<typeof readCandidateBrowserDocument>;
    expect(parsed.project_id).toBe("cli-fixture");
    expect(parsed.candidates[0].candidate_id).toBe("SEG_CLI");
    expect(parsed.beat_plans[0].fallback_candidate_refs).toEqual(["SEG_ALT"]);
  });
});

function makeProjectFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "videoos-read-candidates-"));
  tempDirs.push(dir);
  const planDir = path.join(dir, "04_plan");
  fs.mkdirSync(planDir, { recursive: true });
  fs.writeFileSync(
    path.join(planDir, "selects_candidates.yaml"),
    stringifyYaml({
      version: "1",
      project_id: "cli-fixture",
      candidates: [
        {
          segment_id: "SEG_CLI",
          asset_id: "AST_CLI",
          src_in_us: 0,
          src_out_us: 1_000_000,
          role: "hero",
          confidence: 0.9,
          why_it_matches: "cli fixture",
          risks: [],
          eligible_beats: ["beat_cli"],
        },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(planDir, "edit_blueprint.yaml"),
    stringifyYaml({
      version: "1",
      project_id: "cli-fixture",
      sequence_goals: [],
      beats: [
        {
          id: "beat_cli",
          label: "CLI",
          target_duration_frames: 48,
          required_roles: ["hero"],
          candidate_plan: {
            fallback_candidate_refs: ["SEG_ALT"],
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
        allow_release_late: false,
        entry_beat: "beat_cli",
      },
      dialogue_policy: {
        preserve_natural_breath: true,
        avoid_wall_to_wall_voiceover: true,
      },
    }),
  );
  return dir;
}
