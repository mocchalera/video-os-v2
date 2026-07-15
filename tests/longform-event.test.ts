import * as fs from "node:fs";
import * as path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { afterAll, describe, expect, it } from "vitest";
import { validateArtifact } from "../runtime/artifacts/loaders.js";
import { compile } from "../runtime/compiler/index.js";
import {
  buildDurationPolicy,
  resolveTimelineOrder,
} from "../runtime/compiler/duration-helpers.js";
import type {
  CreativeBrief,
  EditBlueprint,
  SelectsCandidates,
} from "../runtime/artifacts/types.js";
import {
  buildLongformBlueprint,
  planLongformEvent,
  type LongformTranscriptItem,
  type LongformSource,
} from "../runtime/editorial/longform-event.js";
import {
  clearRegistryCache,
  resolveProfileAndPolicy,
} from "../runtime/editorial/policy-resolver.js";
import { loadSkills } from "../runtime/editorial/skill-registry.js";
import { CANONICAL_PIPELINE_STAGES } from "../runtime/pipeline/plan.js";
import { buildLongformEditorialPass } from "../scripts/editorial-pipeline.js";

const TMP_DIRS: string[] = [];

afterAll(() => {
  for (const dir of TMP_DIRS) fs.rmSync(dir, { recursive: true, force: true });
});

function makeBrief(runtimeTargetSec = 65): CreativeBrief {
  return {
    version: "1",
    project_id: "longform-test",
    project: {
      id: "longform-test",
      title: "Longform event",
      strategy: "retain the complete event arc while removing dead time",
      runtime_target_sec: runtimeTargetSec,
      duration_mode: "strict",
    },
    message: { primary: "Experience the full event arc" },
    emotion_curve: ["opening", "development", "resolution"],
    order_policy: "chronological",
    audio_policy: "original_only",
    editorial: {
      distribution_channel: "event_recap",
      aspect_ratio: "16:9",
      profile_hint: "longform-event",
      policy_hint: "longform-documentary",
      allow_inference: false,
    },
    autonomy: {
      mode: "full",
      may_decide: ["transcript reduction", "chapter allocation"],
      must_ask: [],
      skip_confirmations: true,
    },
    longform: {
      mode: "reduction",
      source_selection: "auto_primary_lane",
      min_window_sec: 5,
      max_window_sec: 10,
      silence_gap_cut_sec: 3,
      chapter_max_sec: 600,
      coverage_interval_sec: 900,
    },
  };
}

function source(assetId: string, displayName: string, prefix: string): LongformSource {
  const items: LongformTranscriptItem[] = [];
  for (let index = 0; index < 8; index += 1) {
    const text = index === 2
      ? "少々お待ちください。マイクを確認します。"
      : index === 3
        ? `${prefix} substantive explanation 1 because this is an exact duplicate`
        : index === 4
          ? `${prefix} substantive explanation 1 because this is an exact duplicate`
          : `${prefix} substantive explanation ${index} with an important event detail`;
    items.push({
      item_id: `${assetId}_${index + 1}`,
      speaker: "S1",
      start_us: index * 10_000_000,
      end_us: index * 10_000_000 + 8_000_000,
      text,
    });
  }
  items.push({
    item_id: `${assetId}_filler`,
    speaker: "S1",
    start_us: 8_200_000,
    end_us: 8_800_000,
    text: "えーと",
  });
  return {
    asset_id: assetId,
    display_name: displayName,
    duration_us: 80_000_000,
    items,
  };
}

function makeSources(): LongformSource[] {
  return [
    source("AST_A1", "01_camA_clip", "P1"),
    source("AST_A2", "02_camA_clip", "P2"),
    source("AST_B1", "03_camB_clip", "P1"),
    source("AST_B2", "04_camB_clip", "P2"),
  ];
}

describe("longform-event profile contract", () => {
  it("adds a strict chronological mode without changing event-recap", () => {
    clearRegistryCache();
    const longform = resolveProfileAndPolicy(
      { briefEditorial: { profile_hint: "longform-event", allow_inference: false } },
      "runtime/editorial/profiles",
      "runtime/editorial/policies",
    );
    const shortEvent = resolveProfileAndPolicy(
      { briefEditorial: { profile_hint: "event-recap", allow_inference: false } },
      "runtime/editorial/profiles",
      "runtime/editorial/policies",
    );

    expect(longform.resolvedPolicy.id).toBe("longform-documentary");
    expect(longform.profileDefaults?.target_duration_sec).toBe(3600);
    expect(longform.profileDefaults?.default_transition).toBe("cut");
    expect(longform.profileDefaults?.max_shot_length_frames).toBe(1080);
    expect(longform.profileDefaults?.active_editing_skills).toEqual([
      "longform_reduction",
      "talking_head_pacing",
    ]);
    expect(shortEvent.resolvedPolicy.id).toBe("highlight");
    expect(shortEvent.profileDefaults?.target_duration_sec).toBe(60);
    expect(shortEvent.profileDefaults?.max_shot_length_frames).toBe(72);
    expect(resolveTimelineOrder({} as EditBlueprint, "longform-event", makeBrief())).toBe("chronological");
    expect(buildDurationPolicy(makeBrief(), "longform-event", 120)).toMatchObject({
      mode: "strict",
      target_duration_sec: 65,
      hard_gate: true,
    });
    expect(loadSkills().has("longform_reduction")).toBe(true);
    expect(CANONICAL_PIPELINE_STAGES).toEqual([
      "ingest", "analyze", "stt", "marlin", "visualQuality", "peak", "embeddings",
      "footageDb", "triage", "blueprint", "compile", "review", "render", "qa", "package",
    ]);
  });
});

describe("longform transcript reduction", () => {
  it("is connected to the canonical editorial-pipeline entrypoint", () => {
    const tempDir = path.join("tests", `tmp_longform_entry_${process.pid}_${Date.now()}`);
    TMP_DIRS.push(tempDir);
    fs.mkdirSync(path.join(tempDir, "02_media"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "03_analysis", "transcripts"), { recursive: true });
    const sources = makeSources();
    fs.writeFileSync(path.join(tempDir, "02_media", "source_map.json"), JSON.stringify({
      version: "1",
      project_id: "longform-test",
      media_dir: "02_media",
      generated_at: "2026-07-13T00:00:00.000Z",
      items: sources.map((item) => ({
        asset_id: item.asset_id,
        source_locator: `source/${item.asset_id}.mp4`,
        local_source_path: `source/${item.asset_id}.mp4`,
        link_path: `02_media/source/${item.asset_id}.mp4`,
        display_name: item.display_name,
        kind: "asset",
      })),
    }));
    for (const item of sources) {
      fs.writeFileSync(
        path.join(tempDir, "03_analysis", "transcripts", `${item.asset_id}.json`),
        JSON.stringify({ asset_id: item.asset_id, items: item.items }),
      );
    }
    fs.writeFileSync(path.join(tempDir, "03_analysis", "segments.json"), JSON.stringify({
      project_id: "longform-test",
      items: sources.map((item) => ({
        segment_id: `SEG_${item.asset_id}_0001`,
        asset_id: item.asset_id,
        src_in_us: 0,
        src_out_us: item.duration_us,
      })),
    }));

    const result = buildLongformEditorialPass(tempDir, makeBrief());
    expect(result.plan.coverage_status).toBe("ready");
    expect(result.selects.longform_plan?.selected_asset_ids).toEqual(["AST_A1", "AST_A2"]);
    expect(result.selects.candidates.every((candidate) =>
      candidate.segment_id === `SEG_${candidate.asset_id}_0001`
    )).toBe(true);
    expect(result.blueprint.beats).toHaveLength(result.selects.candidates.length);
  });

  it("selects one primary camera lane and records inspectable exclusions", () => {
    const result = planLongformEvent("longform-test", makeBrief(), makeSources());
    const plan = result.plan;

    expect(plan.coverage_status).toBe("ready");
    expect(plan.selected_asset_ids).toEqual(["AST_A1", "AST_A2"]);
    expect(plan.excluded_asset_ids).toEqual(["AST_B1", "AST_B2"]);
    expect(plan.selected_duration_us).toBeGreaterThanOrEqual(55_250_000);
    expect(plan.selected_duration_us).toBeLessThanOrEqual(74_750_000);
    expect(plan.chapters).toHaveLength(2);
    expect(plan.chapters.every((chapter) => chapter.candidate_refs.length > 0)).toBe(true);
    expect(new Set(result.selects.candidates.map((candidate) => candidate.candidate_id)).size)
      .toBe(result.selects.candidates.length);
    expect(result.selects.candidates.every((candidate) =>
      candidate.role === "dialogue" && candidate.eligible_beats?.length === 1
    )).toBe(true);
    expect(plan.exclusions.map((item) => item.reason)).toEqual(expect.arrayContaining([
      "alternate_angle_lane",
      "filler_only",
      "housekeeping",
      "duplicate_utterance",
      "low_priority_for_target",
    ]));
    expect(() => validateArtifact<SelectsCandidates>(result.selects, "selects-candidates.schema.json"))
      .not.toThrow();
  });

  it("keeps every filename lane when transcripts do not prove alternate coverage", () => {
    const sources = [
      source("AST_JAN1", "01_jan_clip", "January topic one"),
      source("AST_JAN2", "02_jan_clip", "January topic two"),
      source("AST_JUN1", "03_jun_clip", "June topic one"),
      source("AST_JUN2", "04_jun_clip", "June topic two"),
    ];
    const result = planLongformEvent("longform-test", makeBrief(), sources);
    expect(result.plan.selected_asset_ids).toEqual([
      "AST_JAN1", "AST_JAN2", "AST_JUN1", "AST_JUN2",
    ]);
    expect(result.plan.excluded_asset_ids).toEqual([]);
    expect(result.plan.exclusions.some((item) => item.reason === "alternate_angle_lane")).toBe(false);
  });

  it("builds one chronological beat per retained transcript window", () => {
    const result = planLongformEvent("longform-test", makeBrief(), makeSources());
    const blueprint = buildLongformBlueprint(
      "longform-test",
      makeBrief(),
      result.selects,
      "2026-07-13T00:00:00.000Z",
    );

    expect(blueprint.timeline_order).toBe("chronological");
    expect(blueprint.track_layout).toBe("single");
    expect(blueprint.active_editing_skills).toEqual(["longform_reduction", "talking_head_pacing"]);
    expect(blueprint.caption_policy).toMatchObject({
      delivery_mode: "both",
      source: "transcript",
      styling_class: "longform-event",
    });
    expect(blueprint.beats).toHaveLength(result.selects.candidates.length);
    expect(blueprint.beats.map((beat) => beat.candidate_plan?.primary_candidate_ref))
      .toEqual(result.selects.candidates.map((candidate) => candidate.candidate_id));
    expect(blueprint.longform_plan?.chapters.every((chapter) =>
      chapter.beat_ids?.length === chapter.candidate_refs.length
    )).toBe(true);
    expect(() => validateArtifact<EditBlueprint>(blueprint, "edit-blueprint.schema.json"))
      .not.toThrow();
  });

  it("fails closed when the requested duration cannot be covered", () => {
    const result = planLongformEvent("longform-test", makeBrief(600), makeSources());
    expect(result.plan.coverage_status).toBe("insufficient");
    expect(() => buildLongformBlueprint("longform-test", makeBrief(600), result.selects))
      .toThrow(/coverage cannot satisfy target duration/);
  });

  it("compiles the deterministic chapter plan through the existing timeline compiler", () => {
    const result = planLongformEvent("longform-test", makeBrief(), makeSources());
    const blueprint = buildLongformBlueprint(
      "longform-test",
      makeBrief(),
      result.selects,
      "2026-07-13T00:00:00.000Z",
    );
    const tempDir = path.join("tests", `tmp_longform_${process.pid}_${Date.now()}`);
    TMP_DIRS.push(tempDir);
    fs.mkdirSync(path.join(tempDir, "01_intent"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "04_plan"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "05_timeline"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "01_intent", "creative_brief.yaml"), stringifyYaml(makeBrief()));
    fs.writeFileSync(path.join(tempDir, "04_plan", "selects_candidates.yaml"), stringifyYaml(result.selects));
    fs.writeFileSync(path.join(tempDir, "04_plan", "edit_blueprint.yaml"), stringifyYaml(blueprint));

    const compiled = compile({
      projectPath: tempDir,
      repoRoot: process.cwd(),
      createdAt: "2026-07-13T00:00:00.000Z",
      fpsNum: 24,
    });
    const videoClips = compiled.timeline.tracks.video.flatMap((track) => track.clips);
    expect(videoClips).toHaveLength(result.selects.candidates.length);
    expect(videoClips.map((clip) => clip.beat_id)).toEqual(blueprint.beats.map((beat) => beat.id));
    expect(videoClips.every((clip, index) =>
      clip.candidate_ref === result.selects.candidates[index]?.candidate_id
    )).toBe(true);
    const durationFrames = Math.max(...videoClips.map((clip) =>
      clip.timeline_in_frame + clip.timeline_duration_frames
    ));
    expect(durationFrames).toBeGreaterThanOrEqual(Math.floor(65 * 24 * 0.85));
    expect(durationFrames).toBeLessThanOrEqual(Math.ceil(65 * 24 * 1.15));
  });
});
