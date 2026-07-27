import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CaptionApproval } from "../runtime/caption/approval.js";
import {
  buildFinalRenderReviewPack,
  buildReviewReelSourceArgs,
  inspectFinalRenderReviewPack,
  selectFinalRenderReviewWindows,
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

  it("renders once, records exact caption/font inputs, and reuses an unchanged pack", async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "final-render-review-pack-"));
    tempDirs.push(projectDir);
    const sourcePath = path.join(projectDir, "source.mp4");
    execFileSync("ffmpeg", [
      "-v", "error", "-y",
      "-f", "lavfi", "-i", "color=c=black:s=320x180:r=30:d=2",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      sourcePath,
    ]);
    writeJson(path.join(projectDir, "05_timeline", "timeline.json"), {
      project_id: "review-pack-test",
      sequence: {
        fps_num: 30,
        fps_den: 1,
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

    const first = await buildFinalRenderReviewPack({
      projectDir,
      sourcePath,
      sampleDurationSec: 2,
      createdAt: "2026-07-24T00:00:00Z",
    });
    const second = await buildFinalRenderReviewPack({
      projectDir,
      sourcePath,
      sampleDurationSec: 2,
      createdAt: "2026-07-24T01:00:00Z",
    });

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(first.manifest.samples).toHaveLength(1);
    expect(first.manifest.renderer_contract).toMatchObject({
      version: "final-render-review-renderer/v2",
      caption_ass_builder: "buildAssDocument",
      caption_video_profile: { preset: "veryfast", crf: 14 },
      caption_style: "longform-event",
      caption_font_family: "VideoOS Noto Sans JP Bold",
      content_renderer: "hyperframes",
      content_renderers: ["hyperframes", "remotion"],
      visual_compositor: "ffmpeg-single-pass",
    });
    expect(fs.existsSync(path.join(projectDir, first.manifest.review_reel.path))).toBe(true);
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
    await expect(buildFinalRenderReviewPack({
      projectDir,
      sourcePath,
      sampleDurationSec: 2,
    })).rejects.toThrow("review source FPS does not match timeline");
  }, 30_000);
});

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
