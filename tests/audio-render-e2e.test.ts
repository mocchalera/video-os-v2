import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assembleTimelineToMp4 } from "../runtime/render/assembler.js";
import { renderRoughCut } from "../scripts/render-rough-cut.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function ffmpegAvailable(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const ffIt = ffmpegAvailable() ? it : it.skip;

function project(timeline: Record<string, unknown>, sources: Record<string, string>): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-audio-render-e2e-"));
  tempDirs.push(projectDir);
  fs.mkdirSync(path.join(projectDir, "02_media"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, "05_timeline"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "05_timeline/timeline.json"), JSON.stringify(timeline));
  fs.writeFileSync(path.join(projectDir, "02_media/source_map.json"), JSON.stringify({
    version: "1",
    project_id: timeline.project_id,
    media_dir: "02_media",
    generated_at: "2026-07-20T00:00:00.000Z",
    items: Object.entries(sources).map(([assetId, sourcePath]) => ({
      asset_id: assetId,
      source_locator: sourcePath,
      local_source_path: sourcePath,
      link_path: path.relative(projectDir, sourcePath),
      kind: "asset",
    })),
  }));
  return projectDir;
}

function timeline(videoClips: unknown[], audioTracks: Array<{ track_id: string; clips: unknown[] }>) {
  return {
    version: "1",
    project_id: "audio-render-e2e",
    created_at: "2026-07-20T00:00:00.000Z",
    sequence: {
      name: "audio-render-e2e",
      fps_num: 24,
      fps_den: 1,
      width: 320,
      height: 180,
      start_frame: 0,
      output_aspect_ratio: "16:9",
    },
    tracks: {
      video: [{ track_id: "V1", kind: "video", clips: videoClips }],
      audio: audioTracks.map((track) => ({ ...track, kind: "audio" })),
    },
    markers: [],
    transitions: [],
    provenance: {
      brief_path: "01_intent/creative_brief.yaml",
      blueprint_path: "04_plan/edit_blueprint.yaml",
      selects_path: "04_plan/selects_candidates.yaml",
      compiler_version: "audio-render-e2e",
      audio_policy: { mode: "ducking" },
    },
  };
}

function clip(id: string, assetId: string, frames = 48, role = "dialogue") {
  return {
    clip_id: id,
    asset_id: assetId,
    src_in_us: 0,
    src_out_us: 2_000_000,
    timeline_in_frame: 0,
    timeline_duration_frames: frames,
    role,
    motivation: "real ffmpeg fixture",
    beat_id: "b01",
    fallback_segment_ids: [],
    confidence: 1,
    quality_flags: [],
  };
}

function probe(filePath: string) {
  return JSON.parse(execFileSync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_type,width,height,r_frame_rate",
    "-of", "json",
    filePath,
  ], { encoding: "utf-8" })) as {
    format: { duration: string };
    streams: Array<{ codec_type: string; width?: number; height?: number; r_frame_rate?: string }>;
  };
}

ffIt("renders a pure WAV timeline as a black MP4 with audible audio", async () => {
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-audio-source-"));
  tempDirs.push(sourceDir);
  const wav = path.join(sourceDir, "voice.wav");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=880:duration=2", wav]);
  const doc = timeline([], [{ track_id: "A1", clips: [clip("ACL_001", "AST_AUDIO")] }]);
  const projectDir = project(doc, { AST_AUDIO: wav });
  const outputPath = path.join(projectDir, "09_output/pure-audio.mp4");

  const result = await assembleTimelineToMp4({ projectDir, outputPath });
  const media = probe(outputPath);

  expect(result.videoSegmentCount).toBe(1);
  expect(media.streams).toEqual(expect.arrayContaining([
    expect.objectContaining({ codec_type: "video", width: 320, height: 180, r_frame_rate: "24/1" }),
    expect.objectContaining({ codec_type: "audio" }),
  ]));
  expect(Number(media.format.duration)).toBeCloseTo(2, 1);
  const detect = spawnSync("ffmpeg", ["-hide_banner", "-i", outputPath, "-af", "silencedetect=noise=-50dB:d=0.5", "-f", "null", "-"], { encoding: "utf-8" });
  expect(detect.status).toBe(0);
  expect(detect.stderr).not.toContain("silence_start: 0");
  const volume = spawnSync("ffmpeg", ["-hide_banner", "-i", outputPath, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf-8" });
  expect(volume.status).toBe(0);
  const meanVolume = /mean_volume:\s*(-?[\d.]+) dB/.exec(volume.stderr);
  expect(meanVolume).not.toBeNull();
  expect(Number(meanVolume?.[1])).toBeGreaterThan(-50);
  const frame = spawnSync("ffmpeg", ["-hide_banner", "-i", outputPath, "-frames:v", "1", "-vf", "signalstats,metadata=print:file=-", "-f", "null", "-"], { encoding: "utf-8" });
  expect(frame.status).toBe(0);
  const yavg = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(`${frame.stdout}\n${frame.stderr}`);
  expect(yavg).not.toBeNull();
  expect(Number(yavg?.[1])).toBeLessThanOrEqual(17);
});

ffIt("renders the canonical rough-cut entrypoint for a pure audio timeline", async () => {
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-audio-rough-cut-source-"));
  tempDirs.push(sourceDir);
  const wav = path.join(sourceDir, "voice.wav");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=700:duration=2", wav]);
  const doc = timeline([], [{ track_id: "A1", clips: [clip("ACL_001", "AST_AUDIO")] }]);
  const projectDir = project(doc, { AST_AUDIO: wav });

  const summary = await renderRoughCut({ projectPath: projectDir, noAudio: false });
  const media = probe(summary.outputPath);
  const report = JSON.parse(fs.readFileSync(path.join(projectDir, "09_output/render-report.json"), "utf-8"));

  expect(summary.clipCount).toBe(0);
  expect(summary.audioClipCount).toBe(1);
  expect(media.streams.some((stream) => stream.codec_type === "video")).toBe(true);
  expect(media.streams.some((stream) => stream.codec_type === "audio")).toBe(true);
  expect(Number(media.format.duration)).toBeCloseTo(2, 1);
  expect(report).toMatchObject({
    render_mode: "audio_only_timeline_assembler",
    placeholder_video: "black",
    audio_rendered: true,
    parity_pass: true,
    timeline_hash: expect.any(String),
    video_hash: expect.any(String),
  });
});

ffIt("reports leading and internal gaps truthfully for an audio-only rough cut", async () => {
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-audio-gaps-source-"));
  tempDirs.push(sourceDir);
  const wav = path.join(sourceDir, "voice.wav");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=620:duration=2", wav]);
  const first = { ...clip("ACL_001", "AST_AUDIO", 24), timeline_in_frame: 24 };
  const second = { ...clip("ACL_002", "AST_AUDIO", 24), timeline_in_frame: 72 };
  const doc = timeline([], [{ track_id: "A1", clips: [first, second] }]);
  const projectDir = project(doc, { AST_AUDIO: wav });

  const summary = await renderRoughCut({ projectPath: projectDir, noAudio: false });
  const report = JSON.parse(fs.readFileSync(path.join(projectDir, "09_output/render-report.json"), "utf-8"));

  expect(summary.durationAccounting).toMatchObject({
    timeline_span_sec: 4,
    timeline_content_sec: 2,
    gap_sec: 2,
    gap_count: 2,
    expected_rendered_sec: 4,
    parity_pass: true,
  });
  expect(report).toMatchObject(summary.durationAccounting);
  expect(Number(probe(summary.outputPath).format.duration)).toBeCloseTo(4, 1);
  const silence = spawnSync("ffmpeg", [
    "-hide_banner",
    "-i", summary.outputPath,
    "-af", "silencedetect=noise=-50dB:d=0.1",
    "-f", "null",
    "-",
  ], { encoding: "utf-8" });
  expect(silence.status).toBe(0);
  expect(silence.stderr).toContain("silence_start: 0");
  const firstSilenceEnd = /silence_end:\s*([\d.]+)/.exec(silence.stderr);
  expect(Number(firstSilenceEnd?.[1])).toBeCloseTo(1, 1);
});

ffIt("renders mixed video plus independent A3 audio without treating WAV as video", async () => {
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-mixed-source-"));
  tempDirs.push(sourceDir);
  const video = path.join(sourceDir, "picture.mp4");
  const ambient = path.join(sourceDir, "ambient.wav");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=24:d=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", video]);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=1200:duration=2", ambient]);
  const doc = timeline(
    [clip("VCL_001", "AST_VIDEO")],
    [
      { track_id: "A1", clips: [clip("ACL_001", "AST_VIDEO")] },
      { track_id: "A3", clips: [{ ...clip("ACL_002", "AST_AMBIENT", 48, "ambient"), audio_policy: { nat_gain: 0.25, fade_in_frames: 6, fade_out_frames: 6 } }] },
    ],
  );
  const projectDir = project(doc, { AST_VIDEO: video, AST_AMBIENT: ambient });
  const outputPath = path.join(projectDir, "09_output/mixed.mp4");

  const result = await assembleTimelineToMp4({ projectDir, outputPath });
  const media = probe(outputPath);

  expect(result.audioClipCount).toBe(2);
  expect(media.streams.filter((stream) => stream.codec_type === "audio")).toHaveLength(1);
  expect(media.streams.some((stream) => stream.codec_type === "video")).toBe(true);
  expect(Number(media.format.duration)).toBeCloseTo(2, 1);
});

ffIt("fails explicitly for missing and corrupt audio sources", async () => {
  const doc = timeline([], [{ track_id: "A1", clips: [clip("ACL_001", "AST_AUDIO")] }]);
  const missingProject = project(doc, { AST_AUDIO: path.join(os.tmpdir(), "definitely-missing-eye-070b2b.wav") });
  await expect(assembleTimelineToMp4({ projectDir: missingProject })).rejects.toThrow(/Source file not found/);

  const corrupt = path.join(missingProject, "00_sources/corrupt.wav");
  fs.mkdirSync(path.dirname(corrupt), { recursive: true });
  fs.writeFileSync(corrupt, "not audio");
  const corruptProject = project(doc, { AST_AUDIO: corrupt });
  await expect(assembleTimelineToMp4({ projectDir: corruptProject })).rejects.toThrow(/Invalid data found when processing input/);
});

ffIt("preserves explicit missing-source failure through the canonical rough-cut entrypoint", async () => {
  const doc = timeline([], [{ track_id: "A1", clips: [clip("ACL_001", "AST_AUDIO")] }]);
  const projectDir = project(doc, {
    AST_AUDIO: path.join(os.tmpdir(), "definitely-missing-eye-070b2b-rough-cut.wav"),
  });
  await expect(renderRoughCut({ projectPath: projectDir, noAudio: false })).rejects.toThrow(
    /source_missing/,
  );
});
