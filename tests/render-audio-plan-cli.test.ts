import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AudioRenderPlan } from "../runtime/audio/render-plan.js";
import {
  parseAudioRenderPlanArgs,
  runAudioRenderPlan,
} from "../scripts/render-audio-plan.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fakePlan(root: string): AudioRenderPlan {
  return {
    version: "audio-render-plan/v1",
    project_id: "phase3-cli",
    strategy: "explicit_music_cues_v2",
    timeline: {
      path: path.join(root, "timeline.json"),
      version: "1",
      content_hash: `sha256:${"a".repeat(64)}`,
      duration_frames: 600,
      fps: { num: 24, den: 1 },
    },
    inputs: {},
    dialogue: {
      source_track_id: "A1",
      clips: [],
      finish_scope: "none",
    },
    music: {
      enabled: true,
      source_track_id: "A2",
      cues: [],
    },
    final_mastering: {
      loudness_target_lufs: -16,
      lra_target: 7,
      true_peak_target_dbtp: -1.5,
      count: 1,
      stage: "after_mix",
    },
    expected_artifacts: {
      dialogue_stem: "raw_dialogue.wav",
      final_mix: "final_mix.wav",
      report: "audio-mix-report.json",
    },
    warnings: [],
  };
}

describe("render-audio-plan CLI", () => {
  it("keeps route labels out of plan identity and dry-run writes nothing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "audio-plan-cli-"));
    roots.push(root);
    const plan = fakePlan(root);
    const resolver = vi.fn(() => plan);
    const base = {
      projectDir: root,
      timelinePath: path.join(root, "timeline.json"),
      musicCuesPath: path.join(root, "music_cues.json"),
      dryRun: true,
      keepWork: false,
    } as const;
    const social = await runAudioRenderPlan(
      { ...base, route: "social-review" },
      { resolveSharedAudioRenderPlanImpl: resolver },
    );
    const final = await runAudioRenderPlan(
      { ...base, route: "final" },
      { resolveSharedAudioRenderPlanImpl: resolver },
    );

    expect(social.plan_hash).toBe(final.plan_hash);
    expect(social.wrote_files).toBe(false);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("refuses an existing output before executor invocation", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "audio-plan-cli-"));
    roots.push(root);
    const outputDir = path.join(root, "existing");
    fs.mkdirSync(outputDir);
    const execute = vi.fn();

    await expect(runAudioRenderPlan({
      projectDir: root,
      timelinePath: path.join(root, "timeline.json"),
      musicCuesPath: path.join(root, "music_cues.json"),
      outputDir,
      route: "final",
      dryRun: false,
      keepWork: false,
    }, {
      resolveSharedAudioRenderPlanImpl: () => fakePlan(root),
      executeAudioRenderPlanImpl: execute,
    })).rejects.toThrow(/refusing to overwrite/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("parses explicit rational-route inputs and requires output outside dry-run", () => {
    const parsed = parseAudioRenderPlanArgs([
      "node",
      "script",
      "--project", "/tmp/project",
      "--timeline", "/tmp/timeline.json",
      "--music-cues", "/tmp/music_cues.json",
      "--route", "social-review",
      "--dry-run",
    ]);
    expect(parsed).toMatchObject({
      route: "social-review",
      dryRun: true,
      outputDir: undefined,
    });
    expect(() => parseAudioRenderPlanArgs([
      "node",
      "script",
      "--project", "/tmp/project",
      "--timeline", "/tmp/timeline.json",
      "--music-cues", "/tmp/music_cues.json",
      "--route", "final",
    ])).toThrow(/--output is required/);

    const sfxOnly = parseAudioRenderPlanArgs([
      "node",
      "script",
      "--project", "/tmp/project",
      "--timeline", "/tmp/timeline.json",
      "--sfx-cues", "/tmp/sfx_cues.json",
      "--route", "final",
      "--dry-run",
    ]);
    expect(sfxOnly).toMatchObject({
      sfxCuesPath: "/tmp/sfx_cues.json",
      musicCuesPath: undefined,
      dryRun: true,
    });
  });
});
