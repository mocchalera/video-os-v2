import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateArtifact } from "../runtime/artifacts/loaders.js";
import {
  BgmCuePlanningError,
  assertSelectionPinsMatch,
  buildBgmCueDecisionReport,
  contentHashForJson,
  lockExplicitBgmSelection,
  materializeBgmCuePlan,
  planMusicCuesV2,
  type ResolvedPinnedBgmTrack,
} from "../runtime/music/cue-planner.js";
import type { BgmSelectionArtifact } from "../runtime/music/selection-service.js";
import { projectMusicToTimeline, type MusicCuesDoc } from "../runtime/audio/music-cues.js";

const tempDirectories: string[] = [];

afterEach(() => {
  tempDirectories.splice(0).forEach((directory) => {
    fs.rmSync(directory, { recursive: true, force: true });
  });
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "video-os-bgm-cue-plan-"));
  tempDirectories.push(root);
  return root;
}

function sha(char: string): string {
  return `sha256:${char.repeat(64)}`;
}

function baseSelection(): BgmSelectionArtifact {
  return JSON.parse(fs.readFileSync(
    path.resolve("tests/fixtures/bgm_contracts/valid_selection.json"),
    "utf8",
  )) as BgmSelectionArtifact;
}

function resolvedTrack(overrides: Partial<ResolvedPinnedBgmTrack> = {}): ResolvedPinnedBgmTrack {
  return {
    pack_id: "fixture-core-bgm",
    pack_version: "1.2.3",
    manifest_hash: sha("d"),
    track_id: "synthetic-calm-low-01",
    title: "Synthetic Calm",
    duration_us: 90_000_000,
    full_mix_ref: {
      path: "audio/synthetic-calm-low-01.wav",
      content_hash: sha("a"),
      size_bytes: 1024,
      format: "wav",
    },
    analysis_ref: {
      path: "analysis/synthetic-calm-low-01.json",
      content_hash: sha("c"),
      size_bytes: 512,
      format: "json",
    },
    analysis: {
      version: "1.0.0",
      track_id: "synthetic-calm-low-01",
      input_content_hash: sha("a"),
      status: "degraded",
      tempo: { bpm: 84, meter: "4/4", confidence: 0.3 },
      structure: { beats: [], downbeats: [], sections: [] },
      degraded_reasons: ["fixture has no trusted beat grid"],
    },
    ...overrides,
  };
}

function baseTimeline(fpsNum = 24, fpsDen = 1): Record<string, unknown> {
  return {
    version: "1",
    project_id: "synthetic-bgm-contract",
    created_at: "2026-07-16T00:00:00.000Z",
    sequence: {
      name: "Cue fixture",
      fps_num: fpsNum,
      fps_den: fpsDen,
      width: 1080,
      height: 1920,
      start_frame: 0,
    },
    tracks: {
      video: [{
        track_id: "V1",
        kind: "video",
        clips: [{
          clip_id: "V1_001",
          segment_id: "SEG_001",
          asset_id: "AST_001",
          src_in_us: 0,
          src_out_us: 25_000_000,
          timeline_in_frame: 0,
          timeline_duration_frames: 600,
          role: "hero",
          motivation: "fixture",
          beat_id: "b01",
          fallback_segment_ids: [],
          confidence: 1,
          quality_flags: [],
        }],
      }],
      audio: [
        { track_id: "A1", kind: "audio", clips: [] },
        { track_id: "A2", kind: "audio", clips: [] },
      ],
    },
    markers: [],
    provenance: {
      brief_path: "01_intent/creative_brief.yaml",
      blueprint_path: "04_plan/edit_blueprint.yaml",
      selects_path: "04_plan/selects_candidates.yaml",
      compiler_version: "1.0.0",
    },
  };
}

function lockedSelection() {
  return lockExplicitBgmSelection(baseSelection(), resolvedTrack(), {
    trackId: "synthetic-calm-low-01",
    operatorRef: "fixture:human",
    reason: "Explicit audition fixture choice.",
    decidedAt: "2026-07-16T00:00:00.000Z",
  });
}

function plan(overrides: Partial<Parameters<typeof planMusicCuesV2>[0]> = {}) {
  const timeline = baseTimeline();
  const selection = lockedSelection();
  return planMusicCuesV2({
    selection,
    resolvedTrack: resolvedTrack(),
    timeline,
    selectionRef: "04_plan/bgm_selection.json",
    selectionHash: contentHashForJson(selection),
    cues: [{
      cueId: "MC_SYNTHETIC_CALM_000072",
      timelineInFrame: 72,
      timelineOutFrame: 600,
      sourceInUs: 3_000_000,
      sourceOutUs: 25_000_000,
      section: "opening",
      phase: "dialogue-bed",
      semanticAnchor: {
        label: "first grounded assertion",
        timelineFrame: 72,
        sourceOnsetUs: 3_000_000,
      },
    }],
    ...overrides,
  });
}

describe("explicit BGM cue v2 planner", () => {
  it("locks only the explicitly named ranked track and pins Pack/full-mix/analysis identity", () => {
    const selection = lockedSelection();

    expect(selection.mode).toBe("operator_locked");
    expect(selection.selected?.track_id).toBe("synthetic-calm-low-01");
    expect(selection.operator_override).toMatchObject({
      selected_track_id: "synthetic-calm-low-01",
      operator_ref: "fixture:human",
    });
    expect(selection.selected_track_pin).toEqual({
      pack_id: "fixture-core-bgm",
      pack_version: "1.2.3",
      pack_manifest_hash: sha("d"),
      track_id: "synthetic-calm-low-01",
      full_mix_content_hash: sha("a"),
      full_mix_size_bytes: 1024,
      full_mix_path: "audio/synthetic-calm-low-01.wav",
      analysis_content_hash: sha("c"),
      analysis_size_bytes: 512,
      analysis_path: "analysis/synthetic-calm-low-01.json",
      analysis_status: "degraded",
      registry_status: "verified",
    });
    expect(() => validateArtifact(selection, "bgm-selection.schema.json")).not.toThrow();
  });

  it("rejects an explicit track that was not ranked instead of choosing the top candidate", () => {
    expect(() => lockExplicitBgmSelection(baseSelection(), resolvedTrack(), {
      trackId: "synthetic-progress-high-01",
      operatorRef: "fixture:human",
      reason: "Explicit fixture choice.",
      decidedAt: "2026-07-16T00:00:00.000Z",
    })).toThrowError(BgmCuePlanningError);
  });

  it("rejects manifest, audio, and analysis drift against the selection pin", () => {
    const selection = lockedSelection();
    expect(() => assertSelectionPinsMatch(selection, resolvedTrack({ manifest_hash: sha("e") })))
      .toThrowError(/manifest/i);
    expect(() => assertSelectionPinsMatch(selection, resolvedTrack({
      full_mix_ref: { ...resolvedTrack().full_mix_ref, content_hash: sha("b") },
    }))).toThrowError(/full.mix/i);
    expect(() => assertSelectionPinsMatch(selection, resolvedTrack({
      analysis_ref: { ...resolvedTrack().analysis_ref, content_hash: sha("b") },
    }))).toThrowError(/analysis/i);
  });

  it("emits schema-valid cue v2 with explicit source/timeline/semantic fields and degraded beat truth", () => {
    const result = plan();
    const cue = result.music_cues.cues[0];

    expect(result.music_cues.version).toBe("2.0.0");
    expect(result.music_cues.music_asset).toMatchObject({
      track_id: "synthetic-calm-low-01",
      pack_id: "fixture-core-bgm",
      pack_version: "1.2.3",
      pack_manifest_hash: sha("d"),
      full_mix_content_hash: sha("a"),
      analysis_content_hash: sha("c"),
      analysis_status: "degraded",
    });
    expect(cue).toMatchObject({
      cue_id: "MC_SYNTHETIC_CALM_000072",
      track_id: "synthetic-calm-low-01",
      timeline_track_id: "A2",
      source_offset_us: 3_000_000,
      source_range: { in_us: 3_000_000, out_us: 25_000_000 },
      timeline_range: { in_frame: 72, out_frame: 600 },
      section: "opening",
      phase: "dialogue-bed",
      semantic_anchor: {
        label: "first grounded assertion",
        timeline_frame: 72,
        source_onset_us: 3_000_000,
      },
      beat_alignment: {
        status: "degraded",
        decision: "explicit_source_onset",
        analysis_status: "degraded",
        confidence: 0.3,
        timeline_boundaries_moved: false,
      },
      beat_sync: { enabled: false },
    });
    expect(result.music_cues.warnings).toContainEqual(expect.stringMatching(/trusted beat grid/i));
    expect(() => validateArtifact(result.music_cues, "music-cues.schema.json")).not.toThrow();
  });

  it("projects the exact source offset to A2 and is idempotent", () => {
    const result = plan();
    const once = projectMusicToTimeline(
      baseTimeline(),
      result.music_cues,
      { fpsNum: 24, fpsDen: 1 },
    );
    const twice = projectMusicToTimeline(
      once,
      result.music_cues,
      { fpsNum: 24, fpsDen: 1 },
    );
    const a2 = (twice as any).tracks.audio.find((track: any) => track.track_id === "A2");

    expect(a2.clips).toHaveLength(1);
    expect(a2.clips[0]).toMatchObject({
      asset_id: "synthetic-calm-low-01",
      src_in_us: 3_000_000,
      src_out_us: 25_000_000,
      timeline_in_frame: 72,
      timeline_duration_frames: 528,
      role: "music",
      metadata: {
        music_asset: {
          pack_id: "fixture-core-bgm",
          pack_manifest_hash: sha("d"),
          full_mix_content_hash: sha("a"),
        },
      },
    });
  });

  it("supports multiple non-overlapping cues and rejects overlap/tail/source overflow", () => {
    const selection = lockedSelection();
    const timeline = baseTimeline();
    const common = {
      selection,
      resolvedTrack: resolvedTrack(),
      timeline,
      selectionRef: "04_plan/bgm_selection.json",
      selectionHash: contentHashForJson(selection),
    };
    const result = planMusicCuesV2({
      ...common,
      cues: [
        {
          cueId: "MC_ONE",
          timelineInFrame: 0,
          timelineOutFrame: 240,
          sourceInUs: 0,
          sourceOutUs: 10_000_000,
          section: "opening",
          phase: "intro",
          semanticAnchor: { label: "opening", timelineFrame: 0, sourceOnsetUs: 0 },
        },
        {
          cueId: "MC_TWO",
          timelineInFrame: 300,
          timelineOutFrame: 600,
          sourceInUs: 10_000_000,
          sourceOutUs: 22_500_000,
          section: "middle",
          phase: "proof",
          semanticAnchor: { label: "proof", timelineFrame: 300, sourceOnsetUs: 10_000_000 },
        },
      ],
    });
    expect(result.music_cues.cues).toHaveLength(2);

    expect(() => planMusicCuesV2({
      ...common,
      cues: [
        {
          cueId: "MC_ONE",
          timelineInFrame: 0,
          timelineOutFrame: 360,
          sourceInUs: 0,
          sourceOutUs: 15_000_000,
          section: "opening",
          phase: "intro",
          semanticAnchor: { label: "opening", timelineFrame: 0, sourceOnsetUs: 0 },
        },
        {
          cueId: "MC_TWO",
          timelineInFrame: 300,
          timelineOutFrame: 600,
          sourceInUs: 10_000_000,
          sourceOutUs: 22_500_000,
          section: "middle",
          phase: "proof",
          semanticAnchor: { label: "proof", timelineFrame: 300, sourceOnsetUs: 10_000_000 },
        },
      ],
    })).toThrowError(/overlap/i);

    expect(() => plan({
      cues: [{
        cueId: "MC_TAIL",
        timelineInFrame: 72,
        timelineOutFrame: 601,
        sourceInUs: 3_000_000,
        sourceOutUs: 25_041_667,
        section: "opening",
        phase: "dialogue-bed",
        semanticAnchor: { label: "anchor", timelineFrame: 72, sourceOnsetUs: 3_000_000 },
      }],
    })).toThrowError(/tail/i);
    expect(() => plan({
      cues: [{
        cueId: "MC_SOURCE",
        timelineInFrame: 72,
        timelineOutFrame: 600,
        sourceInUs: 80_000_000,
        sourceOutUs: 100_000_000,
        section: "ending",
        phase: "close",
        semanticAnchor: { label: "anchor", timelineFrame: 72, sourceOnsetUs: 80_000_000 },
      }],
    })).toThrowError(/duration/i);
  });

  it("rejects a v2 source duration that drifts from the rational timeline range", () => {
    const planned = plan().music_cues;
    const drifted = structuredClone(planned);
    drifted.cues[0].source_range!.out_us += 1;

    expect(() => projectMusicToTimeline(
      baseTimeline(),
      drifted,
      { fpsNum: 24, fpsDen: 1 },
    )).toThrowError(/rational-fps timeline duration/i);
  });

  it("uses the rational fps contract for legacy cue source timing", () => {
    const legacy: MusicCuesDoc = {
      version: "1",
      project_id: "synthetic-bgm-contract",
      base_timeline_version: "1",
      music_asset: {
        asset_id: "LEGACY",
        path: "audio/legacy.wav",
        source_hash: sha("a"),
      },
      cues: [{
        cue_id: "MC_LEGACY",
        track_id: "A2",
        entry_window: { earliest_frame: 30_000, latest_frame: 30_000 },
        entry_frame: 30_000,
        exit_frame: 60_000,
        fade_in_ms: 0,
        fade_out_ms: 0,
        ducking: { base_gain_db: -16, duck_gain_db: -24, attack_ms: 80, release_ms: 180 },
      }],
    };
    const timeline = baseTimeline(30_000, 1001);
    (timeline.tracks as any).video[0].clips[0].timeline_duration_frames = 60_000;
    const projected = projectMusicToTimeline(timeline, legacy, {
      fpsNum: 30_000,
      fpsDen: 1001,
    }) as any;
    const clip = projected.tracks.audio.find((track: any) => track.track_id === "A2").clips[0];

    expect(clip.src_in_us).toBe(1_001_000_000);
    expect(clip.src_out_us).toBe(2_002_000_000);
  });

  it("preserves the legacy positive decimal fps API", () => {
    const legacy: MusicCuesDoc = {
      version: "1",
      project_id: "synthetic-bgm-contract",
      base_timeline_version: "1",
      music_asset: {
        asset_id: "LEGACY",
        path: "audio/legacy.wav",
        source_hash: sha("a"),
      },
      cues: [{
        cue_id: "MC_LEGACY_DECIMAL",
        track_id: "A2",
        entry_window: { earliest_frame: 24, latest_frame: 24 },
        entry_frame: 24,
        exit_frame: 48,
        fade_in_ms: 0,
        fade_out_ms: 0,
        ducking: { base_gain_db: -16, duck_gain_db: -24, attack_ms: 80, release_ms: 180 },
      }],
    };
    const projected = projectMusicToTimeline(baseTimeline(), legacy, 23.976) as any;
    const clip = projected.tracks.audio.find((track: any) => track.track_id === "A2").clips[0];

    expect(clip.src_in_us).toBe(Math.round(24 * 1_000_000 / 23.976));
  });

  it("leaves the input byte/semantic value unchanged when no cues are projected", () => {
    const timeline = baseTimeline();
    const before = JSON.stringify(timeline);
    expect(JSON.stringify(timeline)).toBe(before);
  });

  it("writes a new output tree atomically and rejects unsafe or existing outputs", () => {
    const root = tempRoot();
    const projectPath = path.join(root, "project");
    fs.mkdirSync(projectPath);
    const outputPath = path.join(root, "tmp", "cue-plan-v1");
    const planned = plan();
    const projectedTimeline = projectMusicToTimeline(
      baseTimeline(),
      planned.music_cues,
      { fpsNum: 24, fpsDen: 1 },
    );
    const decisionReport = {
      version: "1.0.0",
      project_id: "synthetic-bgm-contract",
      created_at: "2026-07-16T00:00:00.000Z",
      decision: "explicit_audition_candidate",
      release_status: "audition_only",
      selected_track_pin: lockedSelection().selected_track_pin!,
      input_timeline_hash: contentHashForJson(baseTimeline()),
      selection_hash: contentHashForJson(lockedSelection()),
      music_cues_hash: contentHashForJson(planned.music_cues),
      projected_timeline_hash: contentHashForJson(projectedTimeline),
      warnings: planned.music_cues.warnings ?? [],
    } as const;
    expect(() => validateArtifact(
      decisionReport,
      "bgm-cue-decision-report.schema.json",
    )).not.toThrow();

    const written = materializeBgmCuePlan({
      projectPath,
      outputPath,
      selection: lockedSelection(),
      musicCues: planned.music_cues,
      decisionReport,
      projectedTimeline,
    });
    expect(written.files).toEqual([
      "04_plan/bgm_selection.json",
      "05_timeline/timeline.json",
      "07_package/bgm-cue-decision-report.json",
      "07_package/music_cues.json",
    ]);
    expect(fs.existsSync(path.join(outputPath, "07_package", "music_cues.json"))).toBe(true);

    expect(() => materializeBgmCuePlan({
      projectPath,
      outputPath,
      selection: lockedSelection(),
      musicCues: planned.music_cues,
      decisionReport,
      projectedTimeline,
    })).toThrowError(/already exists/i);
    expect(() => materializeBgmCuePlan({
      projectPath,
      outputPath: projectPath,
      selection: lockedSelection(),
      musicCues: planned.music_cues,
      decisionReport,
      projectedTimeline,
    })).toThrowError(/unsafe/i);

    const projectAlias = path.join(root, "project-alias");
    fs.symlinkSync(projectPath, projectAlias, "dir");
    expect(() => materializeBgmCuePlan({
      projectPath,
      outputPath: path.join(projectAlias, "nested-output"),
      selection: lockedSelection(),
      musicCues: planned.music_cues,
      decisionReport,
      projectedTimeline,
    })).toThrowError(/unsafe/i);

    expect(() => materializeBgmCuePlan({
      projectPath,
      outputPath: path.join(root, "tmp", "stale-report"),
      selection: lockedSelection(),
      musicCues: planned.music_cues,
      decisionReport: {
        ...decisionReport,
        projected_timeline_hash: sha("f"),
      },
      projectedTimeline,
    })).toThrowError(/hash-pinned decision/i);
  });

  it("hashes exactly the deterministic JSON bytes written to artifacts", () => {
    const value = lockedSelection();
    const expected = `sha256:${createHash("sha256")
      .update(JSON.stringify(value, null, 2))
      .digest("hex")}`;
    expect(contentHashForJson(value)).toBe(expected);
  });

  it("emits a schema-valid audition-only decision report", () => {
    const planned = plan();
    const timeline = baseTimeline();
    const projectedTimeline = projectMusicToTimeline(
      timeline,
      planned.music_cues,
      { fpsNum: 24, fpsDen: 1 },
    );
    const report = buildBgmCueDecisionReport({
      selection: lockedSelection(),
      musicCues: planned.music_cues,
      inputTimeline: timeline,
      projectedTimeline,
    });

    expect(report).toMatchObject({
      decision: "explicit_audition_candidate",
      release_status: "audition_only",
      selected_track_pin: { track_id: "synthetic-calm-low-01" },
    });
    expect(report.warnings).toContainEqual(expect.stringMatching(/not final music selection/i));
  });
});
