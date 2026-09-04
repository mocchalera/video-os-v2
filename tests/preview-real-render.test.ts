import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { computeSha256 } from "../runtime/packaging/manifest.js";
import { renderBaselineFastPreview } from "../runtime/preview/baseline-fast-preview.js";
import type { LoadedSourceMap } from "../runtime/media/source-map.js";

const execFileAsync = promisify(execFile);
const require_ = createRequire(import.meta.url);
const Ajv2020 = require_("ajv/dist/2020") as new (opts: Record<string, unknown>) => {
  compile(schema: object): ((value: unknown) => boolean) & { errors?: unknown[] | null };
};
const addFormats = require_("ajv-formats") as (ajv: unknown) => void;
const tempProjects: string[] = [];

afterEach(() => {
  for (const project of tempProjects.splice(0)) {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

describe("RFA-007 canonical baseline fast preview", () => {
  it("renders a real canonical video+audio fixture, applies an actual range/fast encode, and records ffprobe parity", async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-rfa007-real-"));
    tempProjects.push(projectDir);
    const timelineDir = path.join(projectDir, "05_timeline");
    const mediaDir = path.join(projectDir, "02_media");
    fs.mkdirSync(timelineDir, { recursive: true });
    fs.mkdirSync(mediaDir, { recursive: true });

    const sourcePath = path.join(mediaDir, "anonymous-fixture.mp4");
    await execFileAsync("ffmpeg", [
      "-y",
      "-f", "lavfi", "-i", "testsrc=size=160x90:rate=24:duration=1",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-c:v", "libx264", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest", sourcePath,
    ]);

    const timelinePath = path.join(timelineDir, "timeline.json");
    fs.writeFileSync(timelinePath, `${JSON.stringify({
      version: "1",
      project_id: "anonymous-rfa007-fixture",
      created_at: "2026-08-21T00:00:00Z",
      sequence: {
        name: "Anonymous RFA-007 fixture",
        fps_num: 24,
        fps_den: 1,
        width: 160,
        height: 90,
        start_frame: 0,
      },
      tracks: {
        video: [{
          track_id: "V1",
          kind: "video",
          clips: [{
            clip_id: "CLP_VIDEO",
            segment_id: "SEG_VIDEO",
            asset_id: "AST_FIXTURE",
            src_in_us: 0,
            src_out_us: 1_000_000,
            timeline_in_frame: 0,
            timeline_duration_frames: 24,
            beat_id: "b01",
            role: "hero",
            motivation: "anonymous real media fixture",
            fallback_segment_ids: [],
            confidence: 1,
            quality_flags: [],
          }],
        }],
        audio: [{
          track_id: "A1",
          kind: "audio",
          role: "dialogue",
          clips: [{
            clip_id: "CLP_AUDIO",
            segment_id: "SEG_AUDIO",
            asset_id: "AST_FIXTURE",
            src_in_us: 0,
            src_out_us: 1_000_000,
            timeline_in_frame: 0,
            timeline_duration_frames: 24,
            beat_id: "b01",
            role: "dialogue",
            motivation: "anonymous real media fixture",
            fallback_segment_ids: [],
            confidence: 1,
            quality_flags: [],
          }],
        }],
      },
      markers: [],
      provenance: {
        compiler_version: "anonymous-fixture",
      },
    }, null, 2)}\n`, "utf8");

    const sourceMapEntry = {
      asset_id: "AST_FIXTURE",
      source_locator: sourcePath,
      local_source_path: sourcePath,
      link_path: "02_media/anonymous-fixture.mp4",
      source_content_sha256: computeSha256(sourcePath),
    };
    const sourceMap: LoadedSourceMap = {
      locatorMap: new Map([[sourceMapEntry.asset_id, sourcePath]]),
      entryMap: new Map([[sourceMapEntry.asset_id, sourceMapEntry]]),
      entries: [sourceMapEntry],
    };

    const result = await renderBaselineFastPreview({
      projectDir,
      timelinePath,
      sourceMap,
      firstNSec: 0.75,
    });
    const receipt = JSON.parse(fs.readFileSync(result.receiptPath, "utf8")) as Record<string, any>;
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    const validateReceipt = ajv.compile(JSON.parse(fs.readFileSync(
      path.resolve("schemas/timeline-preview-receipt.schema.json"),
      "utf8",
    )) as object);
    expect(validateReceipt(receipt), JSON.stringify(validateReceipt.errors, null, 2)).toBe(true);

    expect(receipt.render_scope.video).toBe("canonical_render");
    expect(receipt.render_range).toEqual({ start_frame: 0, end_frame: 18, expected_frames: 18 });
    expect(receipt.actual_output.ffprobe).toMatchObject({
      width: 160,
      height: 90,
      fps_num: 24,
      fps_den: 1,
      video_frame_count: 18,
      video_stream_count: 1,
      audio_stream_count: 1,
    });
    expect(receipt.parity.frame_geometry.matches).toBe(true);
    expect(receipt.parity.duration).toMatchObject({ rendered_frames: 18, matches: true });
    expect(receipt.applied_layers.audio).toMatchObject({
      expected_clip_ids: ["CLP_AUDIO"],
      applied_clip_ids: [],
      status: "partial",
    });
    expect(receipt.parity.audio).toMatchObject({
      expected_clip_ids: ["CLP_AUDIO"],
      applied_clip_ids: [],
      matches: false,
      verification: "render_layer_receipt",
    });
    expect(receipt.applied_layers.audio.evidence).toContain("audio_mix_report");
    expect(receipt.applied_layers.captions.status).toBe("not_requested");
    expect(receipt.applied_layers.content_overlays.status).toBe("not_requested");
    expect(receipt.parity.status).toBe("partial");
    expect(fs.existsSync(path.join(projectDir, receipt.canonical_route_receipt.path))).toBe(true);
  }, 120_000);
});
