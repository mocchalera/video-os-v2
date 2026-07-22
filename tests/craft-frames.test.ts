import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCraftReviewPrompt,
  reviewBlueprintCraft,
} from "../runtime/agents/editorial-craft-agent.js";
import type { CreativeBrief, EditBlueprint, SelectsCandidates } from "../runtime/artifacts/types.js";
import type { MarlinEventsArtifact } from "../runtime/connectors/marlin-types.js";
import type { MediaSourceMapEntry } from "../runtime/media/source-map.js";
import {
  extractCraftKeyFrames,
  extractRepresentativeFrames,
  type KeyFrame,
  type SelectCandidate,
} from "../runtime/pipeline/stages/craft-frames.js";

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

const tempDirs: string[] = [];

beforeEach(() => {
  execFileMock.mockReset();
  execFileMock.mockImplementation((
    _cmd: string,
    args: string[],
    optionsOrCallback: unknown,
    maybeCallback?: unknown,
  ) => {
    const callback = typeof optionsOrCallback === "function"
      ? optionsOrCallback
      : maybeCallback;
    const outputPath = args[args.length - 1];
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, "frame", "utf-8");
    if (typeof callback === "function") {
      (callback as (error: Error | null, stdout: string, stderr: string) => void)(null, "", "");
    }
  });
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createProject(): { projectDir: string; sourcePath: string } {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-os-craft-frames-"));
  tempDirs.push(projectDir);
  fs.mkdirSync(path.join(projectDir, "02_media"), { recursive: true });
  const sourcePath = path.join(projectDir, "02_media", "source.mp4");
  fs.writeFileSync(sourcePath, "source", "utf-8");
  return { projectDir, sourcePath };
}

function candidate(
  segmentId: string,
  durationUs: number,
  assetId = `AST_${segmentId}`,
  startUs = 0,
): SelectCandidate {
  return {
    candidate_id: `cand_${segmentId.toLowerCase()}`,
    segment_id: segmentId,
    asset_id: assetId,
    src_in_us: startUs,
    src_out_us: startUs + durationUs,
    role: "hero",
    why_it_matches: "test",
    risks: [],
    confidence: 0.9,
    eligible_beats: ["b01"],
  };
}

function sourceMap(sourcePath: string, assetIds: string[]): Map<string, MediaSourceMapEntry> {
  return new Map(assetIds.map((assetId) => [assetId, {
    asset_id: assetId,
    source_locator: sourcePath,
    local_source_path: sourcePath,
    link_path: "02_media/source.mp4",
    kind: "asset" as const,
  }]));
}

function marlinEvents(assetId: string): MarlinEventsArtifact {
  return {
    project_id: "craft-frames-test",
    artifact_version: "marlin-events-v1",
    model: {
      provider: "marlin",
      model_alias: "marlin-2b",
      model_snapshot: "test",
    },
    items: [
      {
        asset_id: assetId,
        source_path: "/media/source.mp4",
        scene: "Test scene.",
        events: [
          {
            event_id: "EV_low",
            start_us: 1_000_000,
            end_us: 2_000_000,
            description: "Lower confidence event.",
            confidence: 0.2,
          },
          {
            event_id: "EV_peak",
            start_us: 4_000_000,
            end_us: 6_000_000,
            description: "Best event.",
            confidence: 0.95,
          },
        ],
        find_results: [],
      },
    ],
  };
}

function brief(): CreativeBrief {
  return {
    version: "1",
    project_id: "craft-frames-test",
    project: {
      id: "craft-frames-test",
      title: "Craft frames test",
      strategy: "message-first",
      runtime_target_sec: 20,
      duration_mode: "guide",
    },
    message: { primary: "Show the strongest action." },
    emotion_curve: ["hook", "proof", "resolve"],
    must_have: ["action"],
    autonomy: { mode: "full", may_decide: ["pacing"], must_ask: [] },
    order_policy: "editorial",
    audio_policy: "bgm_only",
  } as CreativeBrief;
}

function selects(): SelectsCandidates {
  return {
    version: "1",
    project_id: "craft-frames-test",
    candidates: [
      {
        candidate_id: "cand_a",
        segment_id: "SEG_A",
        asset_id: "AST_A",
        src_in_us: 0,
        src_out_us: 5_000_000,
        role: "hero",
        why_it_matches: "Strong action.",
        risks: [],
        confidence: 0.9,
        eligible_beats: ["b01"],
      },
    ],
  };
}

function blueprint(): EditBlueprint {
  return {
    version: "1",
    project_id: "craft-frames-test",
    sequence_goals: ["Open strong."],
    beats: [
      {
        id: "b01",
        label: "hook",
        purpose: "Open on action.",
        target_duration_frames: 120,
        required_roles: ["hero"],
        story_role: "hook",
        candidate_plan: {
          primary_candidate_ref: "cand_a",
          fallback_candidate_refs: [],
        },
        craft: { rhythm: "steady" },
      },
    ],
    pacing: {
      opening_cadence: "steady",
      middle_cadence: "steady",
      ending_cadence: "steady",
      default_duration_target_sec: 20,
    },
    music_policy: {
      start_sparse: true,
      allow_release_late: true,
      entry_beat: "b01",
      bgm_duration_sec: 20,
    },
    dialogue_policy: {
      preserve_natural_breath: true,
      avoid_wall_to_wall_voiceover: true,
    },
    transition_policy: {
      prefer_match_texture_over_flashy_fx: true,
    },
    ending_policy: {
      should_feel: "resolved",
    },
    rejection_rules: ["Reject filler."],
    duration_policy: {
      mode: "guide",
      source: "explicit_brief",
      target_source: "explicit_brief",
      target_duration_sec: 20,
      min_duration_sec: 15,
      max_duration_sec: 25,
      hard_gate: false,
      protect_vlm_peaks: true,
    },
    timeline_order: "editorial",
    track_layout: "single",
  };
}

describe("craft key frame extraction", () => {
  it("skips representative and craft frame extraction for canonical audio-only assets", async () => {
    const { projectDir, sourcePath } = createProject();
    fs.mkdirSync(path.join(projectDir, "03_analysis"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, "03_analysis", "assets.json"), JSON.stringify({
      items: [{ asset_id: "AST_AUDIO", audio_stream: { codec: "aac" } }],
    }));
    const clip = { ...candidate("AUDIO", 5_000_000, "AST_AUDIO"), media_kind: "audio" as const, source_capabilities: { has_video: false, has_audio: true } };
    const sources = sourceMap(sourcePath, ["AST_AUDIO"]);

    const craft = await extractCraftKeyFrames(projectDir, [clip], null, sources);
    const representative = await extractRepresentativeFrames(projectDir, [clip], null, sources);

    expect(craft.get("AUDIO")).toEqual([]);
    expect(representative.size).toBe(0);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("extracts 2 frames for short clips, 3 for medium clips, and 4-5 for long clips", async () => {
    const { projectDir, sourcePath } = createProject();
    const clips = [
      candidate("SHORT", 2_500_000),
      candidate("MEDIUM", 5_000_000),
      candidate("LONG", 12_000_000),
    ];

    const frames = await extractCraftKeyFrames(
      projectDir,
      clips,
      null,
      sourceMap(sourcePath, clips.map((clip) => clip.asset_id)),
    );

    expect(frames.get("SHORT")?.map((frame) => frame.label)).toEqual(["in", "peak"]);
    expect(frames.get("MEDIUM")?.map((frame) => frame.label)).toEqual(["in", "peak", "out"]);
    expect(frames.get("LONG")?.map((frame) => frame.label)).toEqual(["in", "peak", "mid_1", "mid_2", "out"]);
    expect(execFileMock).toHaveBeenCalledTimes(10);
  });

  it("uses the highest-confidence Marlin event midpoint for the peak frame", async () => {
    const { projectDir, sourcePath } = createProject();
    const clip = candidate("PEAK", 10_000_000, "AST_PEAK");

    const frames = await extractCraftKeyFrames(
      projectDir,
      [clip],
      marlinEvents("AST_PEAK"),
      sourceMap(sourcePath, ["AST_PEAK"]),
    );

    const peak = frames.get("PEAK")?.find((frame) => frame.label === "peak");
    expect(peak).toMatchObject({
      timestamp_us: 5_000_000,
      source: "marlin_event",
    });
  });

  it("falls back to uniform peak sampling when Marlin events are unavailable", async () => {
    const { projectDir, sourcePath } = createProject();
    const clip = candidate("UNIFORM", 6_000_000, "AST_UNIFORM", 2_000_000);

    const frames = await extractCraftKeyFrames(
      projectDir,
      [clip],
      null,
      sourceMap(sourcePath, ["AST_UNIFORM"]),
    );

    const peak = frames.get("UNIFORM")?.find((frame) => frame.label === "peak");
    expect(peak).toMatchObject({
      timestamp_us: 5_000_000,
      source: "uniform",
    });
  });
});

describe("craft key frames in agent prompts", () => {
  const keyFrames = new Map<string, KeyFrame[]>([
    ["SEG_A", [
      {
        timestamp_us: 500_000,
        path: "03_analysis/craft_frames/SEG_A_in.jpg",
        label: "in",
        source: "in_out",
      },
      {
        timestamp_us: 2_500_000,
        path: "03_analysis/craft_frames/SEG_A_peak.jpg",
        label: "peak",
        source: "marlin_event",
      },
      {
        timestamp_us: 4_500_000,
        path: "03_analysis/craft_frames/SEG_A_out.jpg",
        label: "out",
        source: "in_out",
      },
    ]],
  ]);

  it("includes frame references for repo-side craft reviewers", async () => {
    let capturedPrompt = "";
    await reviewBlueprintCraft(
      brief(),
      selects(),
      blueprint(),
      null,
      keyFrames,
      {
        llm: async (prompt) => {
          capturedPrompt = prompt;
          return JSON.stringify({
            verdict: "accept",
            issues: [],
            revisions: [],
            summary: "Frames reviewed.",
          });
        },
      },
    );

    expect(capturedPrompt).toContain("## Candidate key frames");
    expect(capturedPrompt).toContain("Beat b01 candidates:");
    expect(capturedPrompt).toContain("cand_a (hero; SEG_A)");
    expect(capturedPrompt).toContain("[in: 03_analysis/craft_frames/SEG_A_in.jpg]");
    expect(capturedPrompt).toContain("[peak: 03_analysis/craft_frames/SEG_A_peak.jpg]");
  });

  it("skips frame references when headless text-only mode is requested", () => {
    const prompt = buildCraftReviewPrompt({
      brief: brief(),
      selects: selects(),
      blueprint: blueprint(),
      marlinEvents: null,
      keyFrames,
      includeKeyFrames: false,
    });

    expect(prompt).not.toContain("## Candidate key frames");
    expect(prompt).not.toContain("03_analysis/craft_frames/SEG_A_in.jpg");
  });
});
