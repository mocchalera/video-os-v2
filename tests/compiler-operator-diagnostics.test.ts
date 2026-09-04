import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { compile } from "../runtime/compiler/index.js";
import {
  buildBeatAllocationReport,
  classifyRemedy,
  formatBeatAllocationReport,
  suggestRecoveryGate,
} from "../runtime/compiler/diagnostics.js";
import { GapFreeTimelineError, InsufficientContentError, PrimaryAudioGapError } from "../runtime/compiler/errors.js";
import { RenderSourceUnresolvedError } from "../runtime/compiler/render-readiness.js";
import { resolve } from "../runtime/compiler/resolve.js";
import type { AssembledTimeline, TimelineClip } from "../runtime/compiler/types.js";

const FIXED_CREATED_AT = "2026-03-21T00:00:00Z";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function clip(
  clipId: string,
  beatId: string,
  timelineInFrame: number,
  timelineDurationFrames: number,
): TimelineClip {
  return {
    clip_id: clipId,
    segment_id: `SEG_${clipId}`,
    asset_id: `AST_${clipId}`,
    src_in_us: timelineInFrame * 41_667,
    src_out_us: (timelineInFrame + timelineDurationFrames) * 41_667,
    timeline_in_frame: timelineInFrame,
    timeline_duration_frames: timelineDurationFrames,
    role: "hero",
    motivation: "diagnostics fixture",
    beat_id: beatId,
    fallback_segment_ids: [],
    confidence: 1,
    quality_flags: [],
  };
}

/**
 * The Issue #6 regression shape: strict 1,650f plan where the second setup
 * clip was shortened by 65f at a speech boundary and the next clip stayed at
 * its authored position, leaving a 65-frame hole.
 */
function gapTimeline(): AssembledTimeline {
  return {
    tracks: {
      video: [{
        track_id: "V1",
        kind: "video",
        clips: [
          clip("CLP_PREV", "b01", 0, 100),
          clip("CLP_NEXT", "b03", 165, 1_485),
        ],
      }],
      audio: [],
    },
    markers: [
      { frame: 0, kind: "beat", label: "b01: hook" },
      { frame: 100, kind: "beat", label: "b02: setup" },
      { frame: 165, kind: "beat", label: "b03: body" },
    ],
  };
}

describe("beat allocation report", () => {
  it("explains a 65-frame gap without reading timeline.json by hand", () => {
    const timeline = gapTimeline();
    const resolution = resolve(timeline, 1_650);
    const report = buildBeatAllocationReport({
      projectId: "diagnostics-fixture",
      timeline,
      resolution,
    });

    expect(report.target_frames).toBe(1_650);
    expect(report.gap_frames).toBe(65);

    const shortBeat = report.beats.find((beat) => beat.beat_id === "b02");
    expect(shortBeat).toEqual(expect.objectContaining({
      beat_id: "b02",
      target_frames: 65,
      resolved_frames: 0,
      delta_frames: -65,
      status: "short",
    }));

    const coveredBeat = report.beats.find((beat) => beat.beat_id === "b01");
    expect(coveredBeat).toEqual(expect.objectContaining({
      target_frames: 100,
      resolved_frames: 100,
      delta_frames: 0,
      status: "exact",
    }));

    expect(report.gaps).toEqual([expect.objectContaining({
      track_id: "V1",
      start_frame: 100,
      end_frame: 165,
      duration_frames: 65,
      previous_clip_id: "CLP_PREV",
      next_clip_id: "CLP_NEXT",
      previous_beat_id: "b01",
      next_beat_id: "b03",
      remedy_class: "auto_fix",
    })]);
  });

  it("lists per-beat source ranges and trim adjustments", () => {
    const timeline = gapTimeline();
    const resolution = resolve(timeline, 1_650);
    const report = buildBeatAllocationReport({
      projectId: "diagnostics-fixture",
      timeline,
      resolution,
      trimRangeReport: [{
        beat_id: "b01",
        clip_id: "CLP_PREV",
        requested: { src_in_us: 0, src_out_us: 5_000_000, duration_us: 5_000_000 },
        resolved: { src_in_us: 0, src_out_us: 4_166_700, duration_us: 4_166_700 },
        delta: { src_in_us: 0, src_out_us: -833_300, duration_us: -833_300 },
        reason: "speech boundary snap shortened the approved range",
      }],
    });

    const sourceRange = report.beats
      .find((beat) => beat.beat_id === "b01")!
      .source_ranges.find((range) => range.clip_id === "CLP_PREV");
    expect(sourceRange).toEqual(expect.objectContaining({
      asset_id: "AST_CLP_PREV",
      src_in_us: 0,
      timeline_in_frame: 0,
      duration_frames: 100,
    }));
    expect(sourceRange?.trim_adjustment).toEqual({
      requested_duration_us: 5_000_000,
      resolved_duration_us: 4_166_700,
      reason: "speech boundary snap shortened the approved range",
    });
  });

  it("splits auto-fixable gap fixes from changes needing re-approval", () => {
    expect(classifyRemedy({
      recommended_fix: "Place the next approved clip at the previous coverage end or authorize an explicit gap/hold operation.",
    })).toBe("auto_fix");
    expect(classifyRemedy({
      recommended_fix: "Extend or replace the final approved source range, or authorize an explicit gap/hold operation.",
    })).toBe("human_reapproval");
  });

  it("renders an operator-readable summary", () => {
    const timeline = gapTimeline();
    const report = buildBeatAllocationReport({
      projectId: "diagnostics-fixture",
      timeline,
      resolution: resolve(timeline, 1_650),
    });
    const lines = formatBeatAllocationReport(report).join("\n");
    expect(lines).toContain("target=1650f resolved=1585f gap=65f");
    expect(lines).toContain("b02: target=65f resolved=0f delta=-65f (short)");
    expect(lines).toContain("GAP V1 frames 100-165 (65f) after CLP_PREV before CLP_NEXT");
    expect(lines).toContain("[auto_fix]");
  });

  it("lists primary-audio gaps alongside video gaps in the report", () => {
    const timeline = gapTimeline();
    const audioGap = {
      track_id: "A1" as const,
      start_frame: 100,
      end_frame: 165,
      duration_frames: 65,
      previous_clip: { clip_id: "ACL_PREV", beat_id: "b01", timeline_in_frame: 0, timeline_end_frame: 100 },
      next_clip: { clip_id: "ACL_NEXT", beat_id: "b03", timeline_in_frame: 165, timeline_end_frame: 1_650 },
      previous_beat_id: "b01",
      next_beat_id: "b03",
      recommended_fix: "Extend or replace the final approved audio source range, or authorize an explicit silence/ambient-continuation operation or a declared primary-audio mix policy.",
    };
    const report = buildBeatAllocationReport({
      projectId: "diagnostics-fixture",
      timeline,
      resolution: {
        ...resolve(timeline, 1_650),
        audio_gap_frames: 65,
        audio_gap_count: 1,
        audio_gap_details: [audioGap],
      },
    });

    const reportedAudioGap = report.gaps.find((gap) => gap.track_id === "A1");
    expect(reportedAudioGap).toEqual(expect.objectContaining({
      start_frame: 100,
      end_frame: 165,
      duration_frames: 65,
      previous_clip_id: "ACL_PREV",
      next_clip_id: "ACL_NEXT",
      remedy_class: "human_reapproval",
    }));
    expect(report.gap_frames).toBe(130);
    expect(formatBeatAllocationReport(report).join("\n")).toContain("GAP A1 frames 100-165 (65f)");
  });
});

describe("recovery gate suggestions", () => {
  it("sends insufficient content back to selects for human re-approval", () => {
    const suggestion = suggestRecoveryGate(new InsufficientContentError({
      target_frames: 1_650,
      available_frames: 1_585,
      shortfall_frames: 65,
      reason: "approved_range",
      beat_id: "b02",
    }));
    expect(suggestion).toEqual(expect.objectContaining({
      gate: "selects",
      remedy_class: "human_reapproval",
      error_code: "INSUFFICIENT_CONTENT",
    }));
    expect(suggestion.action).toContain("b02");
    expect(suggestion.action).toContain("65f");
  });

  it("keeps primary video gaps at compile as an auto-fix", () => {
    const timeline = gapTimeline();
    const gaps = resolve(timeline, 1_650).gap_details ?? [];
    const suggestion = suggestRecoveryGate(new GapFreeTimelineError(gaps));
    expect(suggestion).toEqual(expect.objectContaining({
      gate: "compile",
      remedy_class: "auto_fix",
      error_code: "PRIMARY_VIDEO_GAP",
    }));
  });

  it("keeps primary audio gaps at compile with a human re-approval remedy", () => {
    const suggestion = suggestRecoveryGate(new PrimaryAudioGapError([{
      track_id: "A1",
      start_frame: 96,
      end_frame: 192,
      duration_frames: 96,
      recommended_fix: "Place the next approved audio clip at the previous coverage end, or authorize an explicit silence/ambient-continuation operation or a declared primary-audio mix policy.",
    }]));
    expect(suggestion).toEqual(expect.objectContaining({
      gate: "compile",
      remedy_class: "human_reapproval",
      error_code: "PRIMARY_AUDIO_GAP",
    }));
    expect(suggestion.action).toContain("96-192");
  });

  it("returns blueprint contract mismatches to blueprint approval", () => {
    const suggestion = suggestRecoveryGate(
      { code: "BLUEPRINT_CONTRACT_MISMATCH", message: "beat contract mismatch" },
    );
    expect(suggestion).toEqual(expect.objectContaining({
      gate: "blueprint",
      remedy_class: "human_reapproval",
      error_code: "BLUEPRINT_CONTRACT_MISMATCH",
    }));
  });

  it("routes unresolved render sources to media relink without re-approval", () => {
    const report = {
      version: "1" as const,
      project_id: "p",
      generated_at: FIXED_CREATED_AT,
      source_mapping_hash: "0123456789abcdef",
      status: "blocked" as const,
      resolved_count: 0,
      blocked_count: 1,
      resolutions: [{
        asset_id: "AST_001",
        status: "unresolved" as const,
        issue: "no source-map entry for asset",
      }],
      external_sources: [],
    };
    const suggestion = suggestRecoveryGate(new RenderSourceUnresolvedError(report));
    expect(suggestion).toEqual(expect.objectContaining({
      gate: "media",
      remedy_class: "auto_fix",
      error_code: "RENDER_SOURCE_UNRESOLVED",
    }));
  });

  it("keeps unknown failures at compile pending inspection", () => {
    const suggestion = suggestRecoveryGate(new Error("something unexpected"));
    expect(suggestion.gate).toBe("compile");
    expect(suggestion.remedy_class).toBe("human_reapproval");
    expect(suggestion.error_code).toBeUndefined();
  });
});

describe("compile emits the operator report artifact", () => {
  it("promotes beat-allocation-report.json alongside the timeline", () => {
    const projectDir = path.resolve("tests", `tmp_diag_compile_${Date.now()}`);
    tempDirs.push(projectDir);
    fs.cpSync(path.resolve("projects/sample"), projectDir, { recursive: true });
    fs.rmSync(path.join(projectDir, "05_timeline/timeline.json"), { force: true });
    const mediaDir = path.join(projectDir, "02_media");
    fs.mkdirSync(mediaDir, { recursive: true });
    const assetIds = ["AST_001", "AST_002", "AST_003", "AST_004", "AST_005", "AST_006"];
    fs.writeFileSync(path.join(mediaDir, "source_map.json"), JSON.stringify({
      version: "1",
      project_id: "sample-mountain-reset",
      media_dir: "02_media",
      generated_at: FIXED_CREATED_AT,
      items: assetIds.map((assetId) => {
        const filename = `${assetId.toLowerCase()}.mov`;
        fs.writeFileSync(path.join(mediaDir, filename), `source ${assetId}\n`);
        return {
          asset_id: assetId,
          source_locator: `02_media/${filename}`,
          local_source_path: `02_media/${filename}`,
          link_path: `02_media/${filename}`,
          kind: "asset",
          link_type: "symlink",
        };
      }),
    }));

    const result = compile({ projectPath: projectDir, createdAt: FIXED_CREATED_AT, validateSourceArtifacts: true });

    expect(result.beat_allocation_report).toBeTruthy();
    expect(result.beat_allocation_report?.beats.length).toBe(
      result.resolution.beat_fill?.length ?? 0,
    );
    const reportPath = path.join(projectDir, "05_timeline/beat-allocation-report.json");
    expect(fs.existsSync(reportPath)).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(reportPath, "utf-8")) as {
      project_id: string;
      beats: Array<{ beat_id: string; target_frames: number; resolved_frames: number }>;
      gaps: unknown[];
    };
    expect(persisted.project_id).toBe("sample-mountain-reset");
    expect(persisted.beats.length).toBe(result.beat_allocation_report?.beats.length);
    expect(result.artifact_receipts?.some((receipt) =>
      receipt.relative_path === "05_timeline/beat-allocation-report.json",
    )).toBe(true);
  });
});
