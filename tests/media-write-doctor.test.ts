import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  assertMediaWriteReady,
  checkCapacityReservations,
  inspectMediaWriteReadiness,
  MediaWriteReadinessError,
} from "../runtime/system/media-write-doctor.js";
import { assembleTimelineToMp4 } from "../runtime/render/assembler.js";
import { renderPreviewSegment } from "../runtime/preview/segment-renderer.js";
import { runRenderPipeline } from "../runtime/render/pipeline.js";

describe("media write doctor", () => {
  it("groups output and scratch reservations by filesystem device", () => {
    const checks = checkCapacityReservations([
      { label: "output", path: "/output/final.mp4", requiredBytes: 400 },
      { label: "scratch", path: "/scratch/cache", requiredBytes: 700 },
    ], {
      findExistingParent: (target) => target,
      deviceId: () => "device-1",
      availableBytes: () => 1_099,
    });
    expect(checks).toEqual([expect.objectContaining({
      name: "media_write_capacity:device-1",
      status: "fail",
    })]);
  });

  it("detects installed-but-unstartable binaries before any media write", () => {
    const result = inspectMediaWriteReadiness({
      reservations: [],
      requireFfmpeg: true,
      requireFfprobe: false,
    }, {
      nodeVersion: "22.23.1",
      runCommand: () => {
        const error = new Error("command failed") as Error & { stderr?: string };
        error.stderr = "dyld: Library not loaded: libharfbuzz.0.dylib";
        throw error;
      },
    });
    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.name === "ffmpeg")?.detail)
      .toContain("found but failed to start");
  });

  it("checks caption filters and fails closed through the assertion API", () => {
    expect(() => assertMediaWriteReady({
      reservations: [],
      requireFfmpeg: false,
      requireFfprobe: false,
      requireCaptionFilters: true,
    }, {
      nodeVersion: "22.23.1",
      runCommand: () => ({
        stdout: " ... subtitles V->V Render subtitles",
      }),
    })).toThrow(MediaWriteReadinessError);
  });

  it("recognizes caption filters when ffmpeg prints blank capability columns", () => {
    const result = inspectMediaWriteReadiness({
      reservations: [],
      requireFfmpeg: false,
      requireFfprobe: false,
      requireCaptionFilters: true,
    }, {
      nodeVersion: "22.23.1",
      runCommand: () => ({
        stdout: [
          "Filters:",
          " .. ass               V->V       Render ASS subtitles",
          " .. subtitles         V->V       Render text subtitles",
        ].join("\n"),
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.checks).toContainEqual({
      name: "ffmpeg_caption_filters",
      status: "pass",
      detail: "ffmpeg subtitles and ass filters are available",
    });
  });

  it("runs the shared gate before assembler, preview, or pipeline media writes", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "vos-media-doctor-"));
    try {
      const timelinePath = path.join(project, "05_timeline", "timeline.json");
      const sourcePath = path.join(project, "02_media", "source.mp4");
      const assemblyPath = path.join(project, "input-assembly.mp4");
      fs.mkdirSync(path.dirname(timelinePath), { recursive: true });
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.writeFileSync(sourcePath, "source");
      fs.writeFileSync(assemblyPath, "assembly");
      fs.writeFileSync(timelinePath, JSON.stringify({
        version: "1",
        project_id: "P",
        created_at: "2026-01-01T00:00:00Z",
        sequence: {
          name: "vertical",
          fps_num: 30,
          fps_den: 1,
          width: 1080,
          height: 1920,
          start_frame: 0,
        },
        tracks: {
          video: [{
            track_id: "V1",
            kind: "video",
            clips: [{
              clip_id: "CLP_1",
              segment_id: "SEG_1",
              asset_id: "AST_1",
              src_in_us: 0,
              src_out_us: 1_000_000,
              timeline_in_frame: 0,
              timeline_duration_frames: 30,
              role: "hero",
              motivation: "test",
              beat_id: "b01",
              fallback_segment_ids: [],
              confidence: 1,
              quality_flags: [],
              media_kind: "video",
            }],
          }],
          audio: [],
        },
        markers: [],
        provenance: {
          brief_path: "",
          blueprint_path: "",
          selects_path: "",
          compiler_version: "test",
        },
      }));

      const readinessFailure = () => {
        throw new Error("doctor blocked");
      };
      const assemblerOutput = path.join(project, "assembler", "out.mp4");
      await expect(assembleTimelineToMp4({
        projectDir: project,
        timelinePath,
        outputPath: assemblerOutput,
        sourceOverrides: { AST_1: sourcePath },
        execFileImpl: (() => undefined) as never,
        assertMediaWriteReadyImpl: readinessFailure as never,
      })).rejects.toThrow("doctor blocked");
      expect(fs.existsSync(path.dirname(assemblerOutput))).toBe(false);

      const previewOutput = path.join(project, "preview", "out.mp4");
      await expect(renderPreviewSegment({
        projectDir: project,
        timelinePath,
        outputPath: previewOutput,
        sourceMap: {
          path: "",
          document: { version: "1", project_id: "P", items: [] },
          entryMap: new Map(),
          locatorMap: new Map([["AST_1", sourcePath]]),
        } as never,
        assertMediaWriteReadyImpl: readinessFailure as never,
      })).rejects.toThrow("doctor blocked");
      expect(fs.existsSync(path.dirname(previewOutput))).toBe(false);

      const pipelineOutput = path.join(project, "pipeline");
      await expect(runRenderPipeline({
        projectDir: project,
        timelinePath,
        assemblyPath,
        outputDir: pipelineOutput,
        fps: 30,
        captionPolicy: {
          language: "ja",
          delivery_mode: "burn_in",
          source: "none",
          styling_class: "social-short",
        },
        assertMediaWriteReadyImpl: readinessFailure as never,
      })).rejects.toThrow("doctor blocked");
      expect(fs.existsSync(pipelineOutput)).toBe(false);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});
