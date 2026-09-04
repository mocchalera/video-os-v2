import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CaptionApproval } from "../../runtime/caption/approval.js";
import {
  buildFinalRenderReviewPack,
  inspectFinalRenderReviewPack,
} from "../../runtime/packaging/final-render-review-pack.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("final render review pack real integration", () => {
  it("renders non-mock FFmpeg, HyperFrames, Remotion, and compositor artifacts", async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "final-render-review-pack-real-"));
    tempDirs.push(projectDir);
    const sourcePath = path.join(projectDir, "source.mp4");
    execFileSync("ffmpeg", [
      "-v", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=2",
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
    const reelPath = path.join(projectDir, first.manifest.review_reel.path);
    const reelBytes = fs.readFileSync(reelPath);
    const reelStat = fs.statSync(reelPath);
    const manifestOnDisk = JSON.parse(fs.readFileSync(first.manifestPath, "utf8"));
    const temporalEvidence: {
      verdict: string;
      pass: boolean;
      skipped: boolean;
      best_offset_frames: number | null;
    } = JSON.parse(fs.readFileSync(`${reelPath}.temporal-correspondence.json`, "utf8"));
    const contentLogsDir = path.join(
      projectDir,
      "06_review",
      "final-render-review-pack",
      "work",
      "content",
      "logs",
    );
    const hyperFramesReceipt = JSON.parse(fs.readFileSync(
      path.join(contentLogsDir, "hyperframes-under-caption-layer-receipt.json"),
      "utf8",
    ));
    const remotionReceipt = JSON.parse(fs.readFileSync(
      path.join(contentLogsDir, "remotion-under-caption-layer-receipt.json"),
      "utf8",
    ));

    expect(first.reused).toBe(false);
    expect(reelBytes.byteLength).toBeGreaterThan(0);
    expect(first.manifest.review_reel.sha256).toBe(`sha256:${sha256(reelBytes)}`);
    expect(manifestOnDisk).toEqual(first.manifest);
    expect(temporalEvidence).toMatchObject({
      verdict: "pass",
      pass: true,
      skipped: false,
    });
    expect(temporalEvidence.best_offset_frames).not.toBeNull();
    expect(Math.abs(temporalEvidence.best_offset_frames!)).toBeLessThanOrEqual(1);
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
    expect(hyperFramesReceipt).toMatchObject({
      version: "hyperframes-layer-receipt/v3",
      renderer: "hyperframes",
      composite_stage: "under_caption",
      overlay_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(remotionReceipt).toMatchObject({
      version: "remotion-layer-receipt/v3",
      renderer: "remotion",
      composite_stage: "under_caption",
      overlay_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(hyperFramesReceipt.overlay_sha256).toBe(
      sha256(fs.readFileSync(hyperFramesReceipt.overlay_path)),
    );
    expect(remotionReceipt.overlay_sha256).toBe(
      sha256(fs.readFileSync(remotionReceipt.overlay_path)),
    );
    expect(inspectFinalRenderReviewPack(projectDir)).toMatchObject({
      ready: true,
      issues: [],
    });

    const second = await buildFinalRenderReviewPack({
      projectDir,
      sourcePath,
      sampleDurationSec: 2,
      createdAt: "2026-07-24T01:00:00Z",
    });
    expect(second.reused).toBe(true);
    expect(second.manifest).toEqual(first.manifest);
    expect(fs.statSync(reelPath).mtimeMs).toBe(reelStat.mtimeMs);
    expect(fs.readFileSync(reelPath)).toEqual(reelBytes);

    fs.appendFileSync(reelPath, "tampered-review-reel");
    expect(inspectFinalRenderReviewPack(projectDir)).toMatchObject({
      ready: false,
      issues: expect.arrayContaining(["final render review reel hash changed"]),
    });
    fs.writeFileSync(reelPath, reelBytes);

    const timelinePath = path.join(projectDir, "05_timeline", "timeline.json");
    const audioOnlyChange = JSON.parse(fs.readFileSync(timelinePath, "utf8"));
    audioOnlyChange.metadata = { audio_finish: { preset: "dialogue-clean" } };
    fs.writeFileSync(timelinePath, `${JSON.stringify(audioOnlyChange, null, 2)}\n`, "utf8");
    expect(inspectFinalRenderReviewPack(projectDir)).toMatchObject({
      ready: true,
      issues: [],
    });

    const visuallyStale = structuredClone(audioOnlyChange);
    visuallyStale.tracks.overlay[0].clips[0].metadata.content_element.props.title =
      "変更されたセクション";
    fs.writeFileSync(timelinePath, `${JSON.stringify(visuallyStale, null, 2)}\n`, "utf8");
    expect(inspectFinalRenderReviewPack(projectDir)).toMatchObject({
      ready: false,
      issues: expect.arrayContaining(["timeline visual projection changed"]),
    });

    const mismatchedFps = {
      ...visuallyStale,
      sequence: { ...visuallyStale.sequence, fps_num: 24 },
    };
    fs.writeFileSync(timelinePath, `${JSON.stringify(mismatchedFps, null, 2)}\n`, "utf8");
    await expect(buildFinalRenderReviewPack({
      projectDir,
      sourcePath,
      sampleDurationSec: 2,
    })).rejects.toThrow("review source FPS does not match timeline");
  }, 120_000);
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
