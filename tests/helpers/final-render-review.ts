import * as fs from "node:fs";
import * as path from "node:path";
import { inspectCaptionFontContract } from "../../runtime/caption/font-contract.js";
import {
  FINAL_RENDER_REVIEW_PACK_RELATIVE_PATH,
  FINAL_RENDER_REVIEW_PACK_VERSION,
  FINAL_RENDER_REVIEW_RENDERER_CONTRACT_VERSION,
  timelineVisualProjectionHash,
} from "../../runtime/packaging/final-render-review-pack.js";
import { computeSha256 } from "../../runtime/packaging/manifest.js";

export function writeValidFinalRenderReviewPack(projectDir: string): {
  reviewed: true;
  manifest_path: string;
  manifest_sha256: string;
} {
  const timelinePath = path.join(projectDir, "05_timeline", "timeline.json");
  const captionApprovalPath = path.join(projectDir, "07_package", "caption_approval.json");
  const captionApproval = JSON.parse(fs.readFileSync(captionApprovalPath, "utf8")) as {
    caption_policy?: { styling_class?: string };
  };
  const stylingClass = captionApproval.caption_policy?.styling_class ?? "clean-lower-third";
  const font = inspectCaptionFontContract(stylingClass);
  if (font.status !== "ready" || !font.selected_asset) {
    throw new Error("test caption font contract is not ready");
  }
  const sourcePath = path.join(projectDir, "06_review", "review-source.mp4");
  const samplePath = path.join(projectDir, "06_review", "final-render-review-pack", "sample-01.mp4");
  fs.mkdirSync(path.dirname(samplePath), { recursive: true });
  fs.writeFileSync(sourcePath, "test review source");
  fs.writeFileSync(samplePath, "test review sample");
  const manifestPath = path.join(projectDir, FINAL_RENDER_REVIEW_PACK_RELATIVE_PATH);
  const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf8"));
  const manifest = {
    version: FINAL_RENDER_REVIEW_PACK_VERSION,
    project_id: timeline.project_id,
    created_at: "2026-07-24T00:00:00Z",
    contract_key: `sha256:${"1".repeat(64)}`,
    inputs: {
      source_path: sourcePath,
      source_sha256: computeSha256(sourcePath),
      source_stream: {
        width: timeline.sequence.width,
        height: timeline.sequence.height,
        fps_num: timeline.sequence.fps_num,
        fps_den: timeline.sequence.fps_den,
        duration_sec: 8,
        audio_present: true,
      },
      timeline_path: timelinePath,
      timeline_sha256: computeSha256(timelinePath),
      timeline_visual_projection_sha256: timelineVisualProjectionHash(timeline),
      caption_approval_path: captionApprovalPath,
      caption_approval_sha256: computeSha256(captionApprovalPath),
    },
    renderer_contract: {
      version: FINAL_RENDER_REVIEW_RENDERER_CONTRACT_VERSION,
      caption_ass_builder: "buildAssDocument",
      caption_video_profile: { preset: "veryfast", crf: 14 },
      caption_style: stylingClass,
      caption_font_family: font.selected_asset.family,
      caption_font_sha256: font.selected_asset.sha256,
      content_renderer: "hyperframes",
      content_renderers: ["hyperframes", "remotion"],
      visual_compositor: "ffmpeg-single-pass",
    },
    sample_duration_sec: 8,
    total_sample_duration_sec: 8,
    review_reel: {
      path: path.relative(projectDir, samplePath).split(path.sep).join("/"),
      sha256: computeSha256(samplePath),
      duration_sec: 8,
    },
    samples: [{
      sample_id: "sample-01",
      start_frame: 0,
      duration_frames: 240,
      start_sec: 0,
      duration_sec: 8,
      reasons: ["intro"],
      caption_ids: [],
      overlay_ids: [],
      reel_in_frame: 0,
      reel_in_sec: 0,
    }],
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return {
    reviewed: true,
    manifest_path: FINAL_RENDER_REVIEW_PACK_RELATIVE_PATH,
    manifest_sha256: computeSha256(manifestPath),
  };
}
