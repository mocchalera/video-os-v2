import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { writeHyperFramesProject } from "../runtime/content/hyperframes-project.js";
import type { ContentElementV1 } from "../runtime/content/types.js";
import { DEFAULT_VIDEO_FONT } from "../editor/shared/font-contract.js";

interface CommandResult {
  command: string;
  status: number | null;
  duration_ms: number;
  stdout: string;
  stderr: string;
}

function run(command: string, args: string[]): CommandResult {
  const started = performance.now();
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: { ...process.env, HYPERFRAMES_NO_TELEMETRY: "1" },
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    command: [command, ...args].join(" "),
    status: result.status,
    duration_ms: Math.round(performance.now() - started),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function requireSuccess(result: CommandResult): void {
  if (result.status !== 0) {
    throw new Error(`${result.command} failed (${result.status})\n${result.stdout}\n${result.stderr}`);
  }
}

function sha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function decodedFrameHash(filePath: string): string {
  const result = run("ffmpeg", [
    "-v", "error",
    "-c:v", "libvpx-vp9",
    "-i", filePath,
    "-map", "0:v:0",
    "-pix_fmt", "rgba",
    "-f", "hash",
    "-hash", "sha256",
    "-",
  ]);
  requireSuccess(result);
  return result.stdout.trim();
}

function backgroundSSIM(base: string, composite: string): number {
  const result = run("ffmpeg", [
    "-v", "info",
    "-i", base,
    "-i", composite,
    "-filter_complex",
    "[0:v]crop=640:540:1280:540[base];[1:v]crop=640:540:1280:540[composite];[base][composite]ssim",
    "-f", "null",
    "-",
  ]);
  requireSuccess(result);
  const match = result.stderr.match(/All:([0-9.]+)/);
  if (!match) throw new Error("Unable to read FFmpeg SSIM result");
  return Number(match[1]);
}

function contentElement(
  elementId: string,
  templateRef: "vos:content.section-label/v1" | "vos:content.question-card/v1",
  props: Record<string, string>,
  anchor: "top_left" | "center",
  zIndex: number,
): ContentElementV1 {
  return {
    version: "content-element/v1",
    element_id: elementId,
    kind: "template",
    template_ref: templateRef,
    template_version: "1.0.0",
    props,
    layout: {
      anchor,
      x: 0,
      y: 0,
      scale: 1,
      rotation_deg: 0,
      opacity: 1,
      safe_area: true,
      z_index: zIndex,
    },
    animation: { in: { preset: "fade-rise", duration_frames: 14 } },
    renderer_hint: "auto",
  };
}

const projectDir = mkdtempSync(path.join(tmpdir(), "video-os-hyperframes-phase0-"));
const keep = process.env.KEEP_HYPERFRAMES_SPIKE === "1";

try {
  const stagedFont = writeHyperFramesProject(projectDir, {
    composition_id: "video_os_phase0",
    width: 1920,
    height: 1080,
    fps: 30,
    duration_frames: 150,
    elements: [
      {
        element: contentElement(
          "section_01",
          "vos:content.section-label/v1",
          { eyebrow: "AX-1 INTERVIEW", title: "経営者本人がAIを使う意味" },
          "top_left",
          100,
        ),
        start_frame: 0,
        duration_frames: 75,
        track_index: 100,
      },
      {
        element: contentElement(
          "question_01",
          "vos:content.question-card/v1",
          { label: "QUESTION", question: "会社は、どのように変わりましたか？" },
          "center",
          110,
        ),
        start_frame: 75,
        duration_frames: 75,
        track_index: 110,
      },
    ],
  }).font;

  const hyperframes = path.resolve("node_modules/.bin/hyperframes");
  if (!existsSync(hyperframes)) throw new Error("Pinned HyperFrames CLI is not installed");

  const lint = run(hyperframes, ["lint", projectDir, "--json"]);
  requireSuccess(lint);

  const first = path.join(projectDir, "first.webm");
  const second = path.join(projectDir, "second.webm");
  const renderArgs = (output: string) => [
    "render", projectDir,
    "--format", "webm",
    "--output", output,
    "--fps", "30",
    "--quality", "draft",
    "--workers", "1",
    "--strict",
    "--no-browser-gpu",
    "--quiet",
  ];
  const render1 = run(hyperframes, renderArgs(first));
  requireSuccess(render1);
  const render2 = run(hyperframes, renderArgs(second));
  requireSuccess(render2);

  const probe = run("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=codec_name,pix_fmt,width,height,r_frame_rate:stream_tags=alpha_mode",
    "-of", "json",
    first,
  ]);
  requireSuccess(probe);

  const base = path.join(projectDir, "base.mp4");
  const composite = path.join(projectDir, "composite.mp4");
  const sample = path.join(projectDir, "composite-sample.png");
  const baseResult = run("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", "color=c=0x24405f:s=1920x1080:r=30:d=5",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", base,
  ]);
  requireSuccess(baseResult);
  const compositeResult = run("ffmpeg", [
    "-v", "error", "-y",
    "-i", base, "-c:v", "libvpx-vp9", "-i", first,
    "-filter_complex", "[0:v]format=rgba[base];[1:v]format=rgba[overlay];[base][overlay]overlay=format=rgb:shortest=1,format=yuv420p",
    "-c:v", "libx264", composite,
  ]);
  requireSuccess(compositeResult);
  const sampleResult = run("ffmpeg", [
    "-v", "error", "-y", "-i", composite,
    "-vf", "select=eq(n\\,37)", "-fps_mode", "vfr", "-frames:v", "1", sample,
  ]);
  requireSuccess(sampleResult);

  const firstDecodedHash = decodedFrameHash(first);
  const secondDecodedHash = decodedFrameHash(second);
  const transparentBackgroundSSIM = backgroundSSIM(base, composite);
  const report = {
    version: "hyperframes-phase0/v1",
    hyperframes_version: "0.7.60",
    node_version: process.version,
    bundled_font: {
      font_id: DEFAULT_VIDEO_FONT.id,
      family: DEFAULT_VIDEO_FONT.family,
      mode: stagedFont.mode,
      format: stagedFont.format,
      subset_cache_key: stagedFont.cacheKey,
      subset_cache_hit: stagedFont.cacheHit,
      character_count: stagedFont.characterCount,
      source_sha256: stagedFont.sourceSha256,
      staged_sha256: sha256(stagedFont.fontPath),
      staged_size_bytes: statSync(stagedFont.fontPath).size,
      license_present: existsSync(stagedFont.licensePath),
    },
    project_dir: projectDir,
    kept: keep,
    lint: JSON.parse(lint.stdout),
    render_1_ms: render1.duration_ms,
    render_2_ms: render2.duration_ms,
    first_size_bytes: statSync(first).size,
    first_file_sha256: sha256(first),
    second_file_sha256: sha256(second),
    first_decoded_frame_hash: firstDecodedHash,
    second_decoded_frame_hash: secondDecodedHash,
    decoded_frames_match: firstDecodedHash === secondDecodedHash,
    probe: JSON.parse(probe.stdout),
    ffmpeg_alpha_composite: {
      status: transparentBackgroundSSIM >= 0.95 ? "passed" : "failed",
      required_vp9_decoder: "libvpx-vp9",
      required_filtergraph: "explicit RGBA inputs before overlay",
      transparent_background_ssim: transparentBackgroundSSIM,
      output: composite,
      sample,
    },
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.decoded_frames_match || report.ffmpeg_alpha_composite.status !== "passed") {
    process.exitCode = 2;
  }
} finally {
  if (!keep) rmSync(projectDir, { recursive: true, force: true });
}
