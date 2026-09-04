import { afterEach, describe, expect, it } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  AtomicArtifactValidationError,
  finalizeCompileArtifactsAtomically,
} from "../runtime/compiler/atomic-finalize.js";
import { applyPatch } from "../runtime/compiler/patch.js";
import { GapFreeTimelineError, PrimaryAudioGapError } from "../runtime/compiler/errors.js";
import type { DurationPolicy, TimelineIR } from "../runtime/compiler/types.js";
import type { LoadedSourceMap } from "../runtime/media/source-map.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function createProject(name: string): string {
  const projectDir = fs.mkdtempSync(path.join("tests", `tmp_atomic_${name}_`));
  tempDirs.push(projectDir);
  fs.mkdirSync(path.join(projectDir, "05_timeline"), { recursive: true });
  return projectDir;
}

function sourceMap(entries: LoadedSourceMap["entries"] = []): LoadedSourceMap {
  return {
    locatorMap: new Map(entries.map((entry) => [entry.asset_id, entry.source_locator])),
    entryMap: new Map(entries.map((entry) => [entry.asset_id, entry])),
    entries,
  };
}

function makeTimeline(options?: { endFrame?: number; assetId?: string; audioEndFrame?: number }): TimelineIR {
  const endFrame = options?.endFrame ?? 24;
  return {
    version: "1",
    project_id: "atomic-fixture",
    created_at: "2026-08-21T00:00:00Z",
    sequence: {
      name: "Atomic fixture",
      fps_num: 24,
      fps_den: 1,
      width: 1920,
      height: 1080,
      start_frame: 0,
    },
    tracks: {
      video: [{
        track_id: "V1",
        kind: "video",
        clips: [{
          clip_id: "CLP_001",
          segment_id: "SEG_001",
          asset_id: options?.assetId ?? "AST_001",
          src_in_us: 0,
          src_out_us: 1_000_000,
          timeline_in_frame: 0,
          timeline_duration_frames: endFrame,
          role: "hero",
          motivation: "atomic fixture",
          beat_id: "b01",
          fallback_segment_ids: [],
          confidence: 1,
          quality_flags: [],
        }],
      }],
      audio: options?.audioEndFrame === undefined ? [] : [{
        track_id: "A1",
        kind: "audio",
        clips: [{
          clip_id: "ACL_001",
          segment_id: "SEG_AUDIO_001",
          asset_id: options?.assetId ?? "AST_001",
          src_in_us: 0,
          src_out_us: 1_000_000,
          timeline_in_frame: 0,
          timeline_duration_frames: options.audioEndFrame,
          role: "nat_sound",
          motivation: "original clip audio",
          beat_id: "b01",
          fallback_segment_ids: [],
          confidence: 1,
          quality_flags: [],
          media_kind: "audio",
          source_capabilities: { has_video: false, has_audio: true },
        }],
      }],
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

const GUIDE_LONG_TARGET_POLICY: DurationPolicy = {
  mode: "guide",
  source: "explicit_brief",
  target_source: "explicit_brief",
  target_duration_sec: 73,
  min_duration_sec: 51.1,
  max_duration_sec: 94.9,
  hard_gate: false,
  protect_vlm_peaks: true,
};

const STRICT_TARGET_POLICY: DurationPolicy = {
  mode: "strict",
  source: "explicit_brief",
  target_source: "explicit_brief",
  target_duration_sec: 2,
  min_duration_sec: 1,
  max_duration_sec: 3,
  hard_gate: true,
  protect_vlm_peaks: false,
};

describe("atomic compile artifact finalization", () => {
  it("promotes verified timeline and manifest with receipts", () => {
    const projectDir = createProject("promote");
    fs.writeFileSync(path.join(projectDir, "05_timeline/timeline.json"), "old timeline\n");
    fs.writeFileSync(path.join(projectDir, "05_timeline/preview-manifest.json"), "old manifest\n");

    const result = finalizeCompileArtifactsAtomically({
      projectPath: projectDir,
      timeline: makeTimeline(),
      sourceMap: sourceMap(),
      targetEndFrame: 24,
      resolution: { target_frames: 24, duration_fit: true } as any,
      duration_policy: { mode: "guide", hard_gate: false } as any,
    });

    expect(fs.existsSync(result.outputPath)).toBe(true);
    expect(fs.existsSync(result.previewManifestPath)).toBe(true);
    expect(result.receipts).toHaveLength(2);
    expect(result.receipts.every((receipt) => /^[0-9a-f]{64}$/.test(receipt.sha256))).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(result.previewManifestPath, "utf-8")) as { base_timeline_hash?: string };
    const timelineHash = crypto.createHash("sha256")
      .update(fs.readFileSync(result.outputPath))
      .digest("hex");
    expect(manifest.base_timeline_hash).toBeTruthy();
    expect(manifest.base_timeline_hash).toBe(
      crypto.createHash("sha256").update(fs.readFileSync(result.outputPath)).digest("hex").slice(0, 16),
    );
    expect(timelineHash).toBe(result.receipts.find((receipt) => receipt.relative_path.endsWith("timeline.json"))?.sha256);
    expect(fs.readdirSync(path.join(projectDir, "05_timeline")).some((name) => name.includes("compile-staging"))).toBe(false);
  });

  it("uses the actual V1/A1 end for a guide zero-op patch and finalization", () => {
    const projectDir = createProject("guide-zero-op");
    const timeline = makeTimeline({ endFrame: 24, audioEndFrame: 24 });
    const patchResult = applyPatch(
      timeline,
      { timeline_version: "1", operations: [] },
      [],
      1_752,
      GUIDE_LONG_TARGET_POLICY,
      24,
      1,
    );

    expect(patchResult.appliedOps).toBe(0);
    expect(patchResult.resolution.target_frames).toBe(1_752);
    expect(patchResult.resolution.gap_count).toBe(0);
    expect(patchResult.resolution.audio_gap_count).toBe(0);

    const result = finalizeCompileArtifactsAtomically({
      projectPath: projectDir,
      timeline: patchResult.timeline,
      sourceMap: sourceMap(),
      targetEndFrame: patchResult.resolution.target_frames,
      resolution: patchResult.resolution,
      duration_policy: GUIDE_LONG_TARGET_POLICY,
    });

    expect(fs.existsSync(result.outputPath)).toBe(true);
    expect(fs.existsSync(result.previewManifestPath)).toBe(true);
  });

  it("still rejects an internal V1 gap when the guide target has an advisory tail", () => {
    const projectDir = createProject("guide-internal-gap");
    const timeline = makeTimeline({ endFrame: 12 });
    timeline.tracks.video[0].clips.push({
      ...timeline.tracks.video[0].clips[0],
      clip_id: "CLP_002",
      segment_id: "SEG_002",
      timeline_in_frame: 24,
      timeline_duration_frames: 12,
      beat_id: "b02",
    });

    let caught: unknown;
    try {
      finalizeCompileArtifactsAtomically({
        projectPath: projectDir,
        timeline,
        sourceMap: sourceMap(),
        targetEndFrame: 1_752,
        resolution: { target_frames: 1_752, duration_fit: true } as any,
        duration_policy: GUIDE_LONG_TARGET_POLICY,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(GapFreeTimelineError);
    expect((caught as GapFreeTimelineError).gaps).toEqual([expect.objectContaining({
      track_id: "V1",
      start_frame: 12,
      end_frame: 24,
      duration_frames: 12,
    })]);
  });

  it("rejects an A1 tail that does not cover the actual V1 end in guide mode", () => {
    const projectDir = createProject("guide-a1-tail");
    let caught: unknown;
    try {
      finalizeCompileArtifactsAtomically({
        projectPath: projectDir,
        timeline: makeTimeline({ endFrame: 24, audioEndFrame: 12 }),
        sourceMap: sourceMap(),
        targetEndFrame: 1_752,
        resolution: { target_frames: 1_752, duration_fit: true } as any,
        duration_policy: GUIDE_LONG_TARGET_POLICY,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(PrimaryAudioGapError);
    expect((caught as PrimaryAudioGapError).gaps).toEqual([expect.objectContaining({
      track_id: "A1",
      start_frame: 12,
      end_frame: 24,
      duration_frames: 12,
    })]);
  });

  it("keeps strict coverage bound to the requested target", () => {
    const projectDir = createProject("strict-target");

    expect(() => finalizeCompileArtifactsAtomically({
      projectPath: projectDir,
      timeline: makeTimeline({ endFrame: 24 }),
      sourceMap: sourceMap(),
      targetEndFrame: 48,
      resolution: { target_frames: 48, duration_fit: true } as any,
      duration_policy: STRICT_TARGET_POLICY,
    })).toThrowError(GapFreeTimelineError);
  });

  it("rolls back both canonical files when the promotion hook fails", () => {
    const projectDir = createProject("rollback");
    const timelinePath = path.join(projectDir, "05_timeline/timeline.json");
    const manifestPath = path.join(projectDir, "05_timeline/preview-manifest.json");
    fs.writeFileSync(timelinePath, "old timeline\n");
    fs.writeFileSync(manifestPath, "old manifest\n");

    expect(() => finalizeCompileArtifactsAtomically({
      projectPath: projectDir,
      timeline: makeTimeline(),
      sourceMap: sourceMap(),
      targetEndFrame: 24,
      resolution: { target_frames: 24, duration_fit: true } as any,
      duration_policy: { mode: "guide", hard_gate: false } as any,
      onPromoted: () => { throw new Error("state write failed"); },
    })).toThrow("state write failed");

    expect(fs.readFileSync(timelinePath, "utf-8")).toBe("old timeline\n");
    expect(fs.readFileSync(manifestPath, "utf-8")).toBe("old manifest\n");
  });

  it("rejects a final timeline gap before promotion", () => {
    const projectDir = createProject("gap");
    const timelinePath = path.join(projectDir, "05_timeline/timeline.json");
    fs.writeFileSync(timelinePath, "old timeline\n");

    const timeline = makeTimeline({ endFrame: 12 });
    timeline.tracks.video[0].clips.push({
      ...timeline.tracks.video[0].clips[0],
      clip_id: "CLP_002",
      segment_id: "SEG_002",
      timeline_in_frame: 24,
      timeline_duration_frames: 12,
      beat_id: "b02",
    });
    expect(() => finalizeCompileArtifactsAtomically({
      projectPath: projectDir,
      timeline,
      sourceMap: sourceMap(),
      targetEndFrame: 36,
      resolution: { target_frames: 36, duration_fit: true } as any,
      duration_policy: { mode: "guide", hard_gate: false } as any,
    })).toThrowError(GapFreeTimelineError);
    expect(fs.readFileSync(timelinePath, "utf-8")).toBe("old timeline\n");
  });

  it("requires existing source files and matching hashes when enabled", () => {
    const projectDir = createProject("source");
    const sourcePath = path.join(projectDir, "source.bin");
    fs.writeFileSync(sourcePath, "source bytes\n");
    const hash = crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex");
    const entry = {
      asset_id: "AST_001",
      source_locator: sourcePath,
      local_source_path: sourcePath,
      link_path: "source.bin",
      source_content_sha256: hash,
    };

    finalizeCompileArtifactsAtomically({
      projectPath: projectDir,
      timeline: makeTimeline(),
      sourceMap: sourceMap([entry]),
      targetEndFrame: 24,
      validateSourceArtifacts: true,
      resolution: { target_frames: 24, duration_fit: true } as any,
      duration_policy: { mode: "guide", hard_gate: false } as any,
    });

    fs.writeFileSync(sourcePath, "changed bytes\n");
    expect(() => finalizeCompileArtifactsAtomically({
      projectPath: projectDir,
      timeline: makeTimeline(),
      sourceMap: sourceMap([entry]),
      targetEndFrame: 24,
      validateSourceArtifacts: true,
      resolution: { target_frames: 24, duration_fit: true } as any,
      duration_policy: { mode: "guide", hard_gate: false } as any,
    })).toThrowError(AtomicArtifactValidationError);
  });
});
