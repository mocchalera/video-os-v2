import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CaptionApproval } from "../runtime/caption/approval.js";
import {
  buildFinalRenderReviewPack,
  buildReviewReelSourceArgs,
  inspectFinalRenderReviewPack,
  selectFinalRenderReviewWindows,
  type FinalRenderReviewPackOptions,
} from "../runtime/packaging/final-render-review-pack.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("final render review pack", () => {
  it("selects the full visual risk set and merges overlapping windows", () => {
    const captionApproval = approval([
      caption("SC_0001", 0, 90, "冒頭です"),
      caption("SC_0002", 580, 90, "これは問いかけですか？"),
      caption("SC_0003", 1_760, 90, "中盤の一番長い字幕テロップです"),
      caption("SC_0004", 2_900, 90, "最後の問いかけですか？"),
      caption("SC_0005", 3_300, 90, "上の行です\n下の行です"),
    ]);
    const timeline = {
      project_id: "review-pack-test",
      sequence: { fps_num: 30, fps_den: 1, width: 1920, height: 1080 },
      tracks: {
        video: [{
          track_id: "V1",
          kind: "video",
          clips: [timelineClip("V1_1", 0, 3_600)],
        }],
        audio: [],
        overlay: [{
          track_id: "O1",
          kind: "overlay",
          clips: [
            sectionClip("SECTION_01", 600, 210),
            sectionClip("SECTION_02", 2_400, 210),
          ],
        }],
      },
    };

    const windows = selectFinalRenderReviewWindows({
      timeline,
      captionApproval,
      sampleDurationSec: 8,
    });
    const reasons = new Set(windows.flatMap((window) => window.reasons));

    expect(reasons).toEqual(new Set([
      "intro",
      "middle",
      "ending",
      "question",
      "longest_caption",
      "two_line_caption",
      "section_title",
    ]));
    expect(windows.some((window) => window.overlay_ids.includes("SECTION_01"))).toBe(true);
    expect(windows.some((window) => window.caption_ids.includes("SC_0002"))).toBe(true);
    for (let index = 1; index < windows.length; index += 1) {
      expect(windows[index].start_frame)
        .toBeGreaterThan(windows[index - 1].start_frame + windows[index - 1].duration_frames);
    }
  });

  it("uses the production near-lossless video profile for bounded source extraction", () => {
    const args = buildReviewReelSourceArgs({
      sourcePath: "/tmp/source.mp4",
      outputPath: "/tmp/review-reel.mp4",
      fpsNum: 30_000,
      fpsDen: 1_001,
      windows: [
        { startSec: 600, durationSec: 8 },
        { startSec: 1_200, durationSec: 8 },
      ],
    });

    expect(args).toEqual(expect.arrayContaining([
      "-ss", "600.000000",
      "-t", "8.000000",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "14",
      "-c:a", "aac",
      "-r", "30000/1001",
      "-pix_fmt", "yuv420p",
    ]));
    expect(args).not.toContain("ultrafast");
    expect(args.filter((arg) => arg === "libx264")).toHaveLength(1);
    expect(args.join(" ")).toContain("concat=n=2:v=1:a=1");
  });

  it("keeps renderer order, deterministic bytes, manifest inputs, reuse, and stale rejection", async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "final-render-review-pack-"));
    tempDirs.push(projectDir);
    const sourcePath = path.join(projectDir, "source.mp4");
    const sourceBytes = Buffer.from("deterministic-review-source:v1\n");
    const baseReelBytes = Buffer.from("deterministic-base-reel:v1\n");
    const hyperFramesBytes = Buffer.from("deterministic-hyperframes-alpha:v1\n");
    const remotionBytes = Buffer.from("deterministic-remotion-alpha:v1\n");
    const reviewReelBytes = Buffer.from("deterministic-final-review-reel:v1\n");
    fs.writeFileSync(sourcePath, sourceBytes);
    writeJson(path.join(projectDir, "05_timeline", "timeline.json"), {
      project_id: "review-pack-test",
      sequence: {
        fps_num: 30_000,
        fps_den: 1_001,
        width: 320,
        height: 180,
        start_frame: 0,
      },
      tracks: {
        video: [{
          track_id: "V1",
          kind: "video",
          clips: [timelineClip("V1_1", 0, 60)],
        }],
        audio: [],
        overlay: [{
          track_id: "O1",
          kind: "overlay",
          clips: [
            sectionClip("SECTION_01", 0, 30),
            remotionTitleClip("TITLE_01", 20, 30),
          ],
        }],
      },
      markers: [],
    });
    writeJson(
      path.join(projectDir, "07_package", "caption_approval.json"),
      approval([caption("SC_0001", 0, 60, "字幕の確認です")]),
    );

    const events: string[] = [];
    const execCalls: Array<{ command: string; args: string[] }> = [];
    const execFileImpl = vi.fn((
      command: string,
      args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout?: string, stderr?: string) => void,
    ) => {
      execCalls.push({ command, args: [...args] });
      events.push(command);
      if (command === "ffprobe") {
        callback(null, JSON.stringify({
          streams: [
            {
              codec_type: "video",
              width: 320,
              height: 180,
              avg_frame_rate: "30000/1001",
              r_frame_rate: "30000/1001",
            },
            { codec_type: "audio" },
          ],
          format: { duration: "2.002" },
        }), "");
        return;
      }
      if (command === "ffmpeg") {
        const outputPath = args.at(-1);
        if (!outputPath) throw new Error("stubbed FFmpeg call has no output path");
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, baseReelBytes);
        callback(null, "", "");
        return;
      }
      callback(new Error(`unexpected executable: ${command}`), "", "");
    }) as unknown as NonNullable<FinalRenderReviewPackOptions["execFileImpl"]>;

    const hyperFramesCalls: Parameters<
      NonNullable<FinalRenderReviewPackOptions["renderHyperFramesImpl"]>
    >[0][] = [];
    const renderHyperFramesImpl: NonNullable<
      FinalRenderReviewPackOptions["renderHyperFramesImpl"]
    > = vi.fn(async (options) => {
      events.push("hyperframes");
      hyperFramesCalls.push(options);
      const overlayPath = path.join(
        options.outputDir,
        "video",
        "hyperframes-under-caption-overlay.webm",
      );
      const receiptPath = path.join(
        options.outputDir,
        "logs",
        "hyperframes-under-caption-layer-receipt.json",
      );
      fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
      fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
      fs.writeFileSync(overlayPath, hyperFramesBytes);
      writeJson(receiptPath, {
        version: "hyperframes-layer-receipt/v3",
        renderer: "hyperframes",
        composite_stage: options.compositeStage,
        overlay_sha256: sha256(hyperFramesBytes),
        element_ids: ["SECTION_01__review_1"],
      });
      return { overlayPath, receiptPath, elementCount: 1 };
    });

    const remotionCalls: Parameters<
      NonNullable<FinalRenderReviewPackOptions["renderRemotionImpl"]>
    >[0][] = [];
    const renderRemotionImpl: NonNullable<
      FinalRenderReviewPackOptions["renderRemotionImpl"]
    > = vi.fn(async (options) => {
      events.push("remotion");
      remotionCalls.push(options);
      const overlayPath = path.join(
        options.outputDir,
        "video",
        "remotion-under-caption-overlay.webm",
      );
      const receiptPath = path.join(
        options.outputDir,
        "logs",
        "remotion-under-caption-layer-receipt.json",
      );
      fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
      fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
      fs.writeFileSync(overlayPath, remotionBytes);
      writeJson(receiptPath, {
        version: "remotion-layer-receipt/v2",
        renderer: "remotion",
        composite_stage: options.compositeStage,
        overlay_sha256: sha256(remotionBytes),
        element_ids: options.elementIds,
      });
      return {
        overlayPath,
        receiptPath,
        durationInFrames: 60,
        fps: 30_000 / 1_001,
        fpsNum: 30_000,
        fpsDen: 1_001,
        width: 320,
        height: 180,
        elementCount: 1,
        layerCacheHit: false,
        font: {
          mode: "subset" as const,
          format: "woff2" as const,
          sha256: "stub-web-font-sha256",
          sourceSha256: "stub-source-font-sha256",
          sizeBytes: 1,
          characterCount: 1,
          cacheHit: false,
        },
      };
    });

    const compositorCalls: Parameters<
      NonNullable<FinalRenderReviewPackOptions["composeFinalVisualsImpl"]>
    >[0][] = [];
    const composeFinalVisualsImpl: NonNullable<
      FinalRenderReviewPackOptions["composeFinalVisualsImpl"]
    > = vi.fn(async (
      options: Parameters<
        NonNullable<FinalRenderReviewPackOptions["composeFinalVisualsImpl"]>
      >[0],
    ) => {
      events.push("compositor");
      compositorCalls.push(options);
      expect(fs.readFileSync(options.baseVideoPath)).toEqual(baseReelBytes);
      expect(options.layers.map((layer) => fs.readFileSync(layer.path))).toEqual([
        hyperFramesBytes,
        remotionBytes,
      ]);
      expect(options.assPath && fs.statSync(options.assPath).size).toBeGreaterThan(0);
      fs.writeFileSync(options.outputPath, reviewReelBytes);
      return options.outputPath;
    });

    const injectedRenderers = {
      execFileImpl,
      renderHyperFramesImpl,
      renderRemotionImpl,
      composeFinalVisualsImpl,
    };
    const first = await buildFinalRenderReviewPack({
      projectDir,
      sourcePath,
      sampleDurationSec: 2,
      createdAt: "2026-07-24T00:00:00Z",
      ...injectedRenderers,
    });
    const second = await buildFinalRenderReviewPack({
      projectDir,
      sourcePath,
      sampleDurationSec: 2,
      createdAt: "2026-07-24T01:00:00Z",
      ...injectedRenderers,
    });

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.manifest).toEqual(first.manifest);
    expect(first.manifest.samples).toHaveLength(1);
    expect(first.manifest.inputs).toMatchObject({
      source_path: sourcePath,
      source_sha256: `sha256:${sha256(sourceBytes)}`,
      source_stream: {
        width: 320,
        height: 180,
        fps_num: 30_000,
        fps_den: 1_001,
        duration_sec: 2.002,
        audio_present: true,
      },
    });
    expect(first.manifest.inputs.timeline_sha256).toBe(
      `sha256:${sha256(fs.readFileSync(path.join(projectDir, "05_timeline", "timeline.json")))}`,
    );
    expect(first.manifest.inputs.caption_approval_sha256).toBe(
      `sha256:${sha256(fs.readFileSync(
        path.join(projectDir, "07_package", "caption_approval.json"),
      ))}`,
    );
    expect(first.manifest.renderer_contract).toMatchObject({
      version: "final-render-review-renderer/v2",
      caption_ass_builder: "buildAssDocument",
      caption_video_profile: { preset: "veryfast", crf: 14 },
      caption_style: "longform-event",
      caption_font_family: "VideoOS Noto Sans JP Bold",
      content_renderer: "hyperframes",
      content_renderers: ["hyperframes", "remotion"],
      visual_compositor: "ffmpeg-single-pass",
      caption_font_sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    expect(first.manifest.review_reel).toEqual({
      path: "06_review/final-render-review-pack/review-reel.mp4",
      sha256: `sha256:${sha256(reviewReelBytes)}`,
      duration_sec: 2.002,
    });
    expect(fs.readFileSync(path.join(projectDir, first.manifest.review_reel.path)))
      .toEqual(reviewReelBytes);
    expect(JSON.parse(fs.readFileSync(first.manifestPath, "utf8"))).toEqual(first.manifest);
    expect(events).toEqual([
      "ffprobe",
      "ffmpeg",
      "hyperframes",
      "remotion",
      "compositor",
      "ffprobe",
    ]);
    expect(execCalls[0]).toEqual({
      command: "ffprobe",
      args: [
        "-v", "error",
        "-show_entries", "stream=codec_type,width,height,avg_frame_rate,r_frame_rate",
        "-show_entries", "format=duration",
        "-of", "json",
        sourcePath,
      ],
    });
    expect(execCalls[1]).toEqual({
      command: "ffmpeg",
      args: expect.arrayContaining([
        "-ss", "0.000000",
        "-t", "2.002000",
        "-i", sourcePath,
        "-r", "30000/1001",
        path.join(
          projectDir,
          "06_review",
          "final-render-review-pack",
          "work",
          "base-reel.mp4",
        ),
      ]),
    });
    expect(hyperFramesCalls).toEqual([{
      timelinePath: path.join(
        projectDir,
        "06_review",
        "final-render-review-pack",
        "work",
        "timeline.reel.json",
      ),
      outputDir: path.join(
        projectDir,
        "06_review",
        "final-render-review-pack",
        "work",
        "content",
      ),
      compositeStage: "under_caption",
    }]);
    expect(remotionCalls).toEqual([{
      timelinePath: hyperFramesCalls[0].timelinePath,
      outputDir: hyperFramesCalls[0].outputDir,
      compositeStage: "under_caption",
      elementIds: ["TITLE_01__review_1"],
    }]);
    expect(compositorCalls).toHaveLength(1);
    expect(compositorCalls[0]).toMatchObject({
      layers: [
        {
          renderer: "hyperframes",
          compositeStage: "under_caption",
          zIndex: 100,
          elementIds: ["SECTION_01__review_1"],
        },
        {
          renderer: "remotion",
          compositeStage: "under_caption",
          zIndex: 200,
          elementIds: ["TITLE_01__review_1"],
        },
      ],
      width: 320,
      height: 180,
      fpsNum: 30_000,
      fpsDen: 1_001,
      durationFrames: 60,
    });
    expect(JSON.parse(fs.readFileSync(
      path.join(hyperFramesCalls[0].outputDir, "logs", "hyperframes-under-caption-layer-receipt.json"),
      "utf8",
    ))).toMatchObject({
      renderer: "hyperframes",
      overlay_sha256: sha256(hyperFramesBytes),
    });
    expect(JSON.parse(fs.readFileSync(
      path.join(remotionCalls[0].outputDir, "logs", "remotion-under-caption-layer-receipt.json"),
      "utf8",
    ))).toMatchObject({
      renderer: "remotion",
      overlay_sha256: sha256(remotionBytes),
    });
    expect(inspectFinalRenderReviewPack(projectDir)).toMatchObject({
      ready: true,
      issues: [],
    });

    const timelinePath = path.join(projectDir, "05_timeline", "timeline.json");
    const audioOnlyChange = JSON.parse(fs.readFileSync(timelinePath, "utf8"));
    audioOnlyChange.metadata = { audio_finish: { preset: "dialogue-clean" } };
    fs.writeFileSync(timelinePath, `${JSON.stringify(audioOnlyChange, null, 2)}\n`, "utf8");
    expect(inspectFinalRenderReviewPack(projectDir)).toMatchObject({
      ready: true,
      issues: [],
    });

    const mismatchedFps = {
      ...audioOnlyChange,
      sequence: { ...audioOnlyChange.sequence, fps_num: 24 },
    };
    fs.writeFileSync(timelinePath, `${JSON.stringify(mismatchedFps, null, 2)}\n`, "utf8");
    expect(inspectFinalRenderReviewPack(projectDir)).toMatchObject({
      ready: false,
      issues: expect.arrayContaining(["timeline visual projection changed"]),
    });
    await expect(buildFinalRenderReviewPack({
      projectDir,
      sourcePath,
      sampleDurationSec: 2,
      ...injectedRenderers,
    })).rejects.toThrow("review source FPS does not match timeline");
  });
});

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function approval(captions: ReturnType<typeof caption>[]): CaptionApproval {
  return {
    version: "caption-source/v1",
    project_id: "review-pack-test",
    base_timeline_version: "timeline-v1",
    caption_policy: {
      language: "ja",
      delivery_mode: "both",
      source: "transcript",
      styling_class: "longform-event",
    },
    speech_captions: captions,
    text_overlays: [],
    approval: {
      status: "approved",
      approved_by: "reviewer",
      approved_at: "2026-07-24T00:00:00Z",
    },
  };
}

function caption(
  captionId: string,
  timelineInFrame: number,
  durationFrames: number,
  text: string,
) {
  return {
    caption_id: captionId,
    asset_id: "AST_1",
    segment_id: `SEG_${captionId}`,
    timeline_in_frame: timelineInFrame,
    timeline_duration_frames: durationFrames,
    text,
    transcript_ref: "TR_1",
    transcript_item_ids: [captionId],
    source: "transcript" as const,
    styling_class: "longform-event",
    metrics: { cps: 5, dwell_ms: durationFrames / 30 * 1000 },
  };
}

function timelineClip(clipId: string, startFrame: number, durationFrames: number) {
  return {
    clip_id: clipId,
    segment_id: `SEG_${clipId}`,
    asset_id: "AST_1",
    src_in_us: 0,
    src_out_us: durationFrames / 30 * 1_000_000,
    timeline_in_frame: startFrame,
    timeline_duration_frames: durationFrames,
    role: "dialogue",
    motivation: "test",
    beat_id: "B1",
    fallback_segment_ids: [],
    confidence: 1,
    quality_flags: [],
  };
}

function sectionClip(clipId: string, startFrame: number, durationFrames: number) {
  return {
    ...timelineClip(clipId, startFrame, durationFrames),
    role: "title",
    metadata: {
      content_element: {
        version: "content-element/v1",
        element_id: clipId,
        kind: "template",
        template_ref: "vos:content.section-label/v1",
        template_version: "1.0.0",
        props: { title: clipId },
        layout: {
          anchor: "top_left",
          x: 0,
          y: 0,
          scale: 1,
          rotation_deg: 0,
          opacity: 1,
          safe_area: true,
          z_index: 100,
        },
        renderer_hint: "auto",
      },
    },
  };
}

function remotionTitleClip(clipId: string, startFrame: number, durationFrames: number) {
  return {
    ...timelineClip(clipId, startFrame, durationFrames),
    role: "title",
    metadata: {
      content_element: {
        version: "content-element/v1",
        element_id: clipId,
        kind: "template",
        template_ref: "vos:content.title-card/v1",
        template_version: "1.0.0",
        props: { title: "再利用できる演出" },
        layout: {
          anchor: "top_center",
          x: 0,
          y: 0,
          scale: 1,
          rotation_deg: 0,
          opacity: 1,
          safe_area: true,
          z_index: 200,
        },
        renderer_hint: "remotion",
        creative_recipe: {
          version: "creative-recipe/v1",
          reuse_scope: "brand",
          authoring_surface: "typed_component",
          layer_mode: "alpha_overlay",
          composite_stage: "under_caption",
          requires_base_frame: false,
        },
      },
    },
  };
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
