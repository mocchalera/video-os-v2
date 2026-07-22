import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { computeFileHash } from "../runtime/state/reconcile.js";
import { assessAssemblyFreshness, runPackageCli } from "../scripts/package.js";

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

ffIt("packages a canonical audio-only timeline with real media QA and visual N/A", async () => {
  const projectDir = fs.mkdtempSync(path.resolve("tests", "tmp-audio-package-e2e-"));
  tempDirs.push(projectDir);
  fs.cpSync(path.resolve("projects/sample"), projectDir, { recursive: true });
  const sourcePath = path.join(projectDir, "00_sources", "voice.wav");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  execFileSync("ffmpeg", [
    "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=520:duration=2",
    "-ar", "48000", sourcePath,
  ]);

  const timelinePath = path.join(projectDir, "05_timeline", "timeline.json");
  const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf-8"));
  const audioClip = structuredClone(timeline.tracks.audio[0].clips[0]);
  Object.assign(audioClip, {
    clip_id: "ACL_AUDIO_ONLY",
    segment_id: "SEG_AUDIO_ONLY",
    asset_id: "AST_AUDIO_ONLY",
    src_in_us: 0,
    src_out_us: 2_000_000,
    timeline_in_frame: 0,
    timeline_duration_frames: 48,
    role: "dialogue",
    candidate_ref: "audio:AST_AUDIO_ONLY:0:2000000",
    media_kind: "audio",
    source_capabilities: { has_video: false, has_audio: true },
    audio_role: "dialogue",
  });
  timeline.sequence.width = 320;
  timeline.sequence.height = 180;
  timeline.sequence.output_aspect_ratio = "16:9";
  timeline.tracks.video = [{ track_id: "V1", kind: "video", clips: [] }];
  timeline.tracks.audio = [{ track_id: "A1", kind: "audio", clips: [audioClip] }];
  timeline.transitions = [];
  fs.writeFileSync(timelinePath, `${JSON.stringify(timeline, null, 2)}\n`, "utf-8");

  fs.mkdirSync(path.join(projectDir, "02_media"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "02_media", "source_map.json"), `${JSON.stringify({
    version: "1",
    project_id: timeline.project_id,
    media_dir: "02_media",
    generated_at: "2026-07-20T00:00:00.000Z",
    items: [{
      asset_id: "AST_AUDIO_ONLY",
      source_locator: sourcePath,
      local_source_path: sourcePath,
      link_path: "00_sources/voice.wav",
      kind: "asset",
    }],
  }, null, 2)}\n`, "utf-8");

  const blueprintPath = path.join(projectDir, "04_plan", "edit_blueprint.yaml");
  const blueprint = parseYaml(fs.readFileSync(blueprintPath, "utf-8"));
  blueprint.caption_policy = {
    language: "ja",
    delivery_mode: "both",
    source: "none",
    styling_class: "clean-lower-third",
  };
  fs.writeFileSync(blueprintPath, stringifyYaml(blueprint), "utf-8");

  const reviewReportPath = path.join(projectDir, "06_review", "review_report.yaml");
  const reviewReport = parseYaml(fs.readFileSync(reviewReportPath, "utf-8"));
  reviewReport.fatal_issues = [];
  reviewReport.visual_qa = {
    status: "not_applicable",
    reason: "audio_only_timeline",
    min_score: 70,
    issues: { total: 0, critical: 0, warning: 0, info: 0 },
    issue_summaries: [],
  };
  fs.writeFileSync(reviewReportPath, stringifyYaml(reviewReport), "utf-8");

  const reviewPatchPath = path.join(projectDir, "06_review", "review_patch.json");
  const state = {
    version: 1,
    project_id: timeline.project_id,
    current_state: "approved",
    gates: {
      review_gate: "open",
      analysis_gate: "ready",
      compile_gate: "open",
      planning_gate: "open",
      timeline_gate: "open",
    },
    approval_record: {
      status: "clean",
      approved_by: "operator",
      approved_at: "2026-07-20T00:00:00.000Z",
      artifact_versions: {
        timeline_version: computeFileHash(timelinePath),
        editorial_timeline_hash: computeFileHash(timelinePath),
        review_report_version: computeFileHash(reviewReportPath),
        review_patch_hash: computeFileHash(reviewPatchPath),
      },
    },
    handoff_resolution: {
      handoff_id: "HND_AUDIO_ONLY",
      status: "decided",
      source_of_truth_decision: "engine_render",
      decided_by: "operator",
      decided_at: "2026-07-20T00:00:00.000Z",
    },
  };
  fs.writeFileSync(path.join(projectDir, "project_state.yaml"), stringifyYaml(state), "utf-8");

  const staleAssemblyPath = path.join(projectDir, "05_timeline", "assembly.mp4");
  execFileSync("ffmpeg", [
    "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=320x180:r=24:d=2",
    "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", staleAssemblyPath,
  ]);
  fs.writeFileSync(path.join(projectDir, "05_timeline", "render-report.json"), `${JSON.stringify({
    timeline_hash: "previous-video-timeline-hash",
    video_hash: computeFileHash(staleAssemblyPath),
    video_path: "05_timeline/assembly.mp4",
  }, null, 2)}\n`, "utf-8");
  expect(assessAssemblyFreshness(projectDir)).toMatchObject({
    status: "stale",
    reason: "render_timeline_hash_mismatch",
  });

  const exitCode = await runPackageCli([
    "node",
    "scripts/package.ts",
    projectDir,
    "--created-at",
    "2026-07-20T00:00:00.000Z",
  ]);
  expect(exitCode).toBe(0);
  expect(assessAssemblyFreshness(projectDir)).toMatchObject({ status: "fresh" });
  const renderMeta = JSON.parse(fs.readFileSync(path.join(projectDir, "05_timeline", "render-report.json"), "utf-8"));
  expect(renderMeta.timeline_hash).toBe(computeFileHash(timelinePath));

  const finalPath = path.join(projectDir, "07_package", "video", "final.mp4");
  const finalMixPath = path.join(projectDir, "07_package", "audio", "final_mix.wav");
  const probe = JSON.parse(execFileSync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height,r_frame_rate",
    "-of", "json", finalPath,
  ], { encoding: "utf-8" }));
  expect(probe.streams).toEqual(expect.arrayContaining([
    expect.objectContaining({ codec_type: "video", width: 320, height: 180, r_frame_rate: "24/1" }),
    expect.objectContaining({ codec_type: "audio" }),
  ]));
  expect(Number(probe.format.duration)).toBeCloseTo(2, 1);
  const volume = spawnSync("ffmpeg", ["-hide_banner", "-i", finalMixPath, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf-8" });
  expect(volume.status).toBe(0);
  const meanVolume = /mean_volume:\s*(-?[\d.]+) dB/.exec(volume.stderr);
  expect(meanVolume).not.toBeNull();
  expect(Number(meanVolume?.[1])).toBeGreaterThan(-30);

  const measurements = JSON.parse(fs.readFileSync(path.join(projectDir, "07_package", "qa-measurements.json"), "utf-8"));
  const qa = JSON.parse(fs.readFileSync(path.join(projectDir, "07_package", "qa-report.json"), "utf-8"));
  expect(measurements).toMatchObject({
    measurement_source: "media_probe",
    video_frame: { width: 320, height: 180 },
  });
  expect(measurements.observed_non_silent_ms).toBeGreaterThan(1_000);
  expect(measurements.av_drift_ms).toBeLessThanOrEqual(42);
  expect(qa.passed).toBe(true);
  expect(qa.checks).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "resolution_valid", passed: true }),
    expect.objectContaining({ name: "dialogue_occupancy_valid", passed: true }),
    expect.objectContaining({ name: "av_drift_valid", passed: true }),
    expect.objectContaining({ name: "loudness_target_valid", passed: true }),
  ]));
  expect(fs.existsSync(path.join(projectDir, "07_package", "package_manifest.json"))).toBe(true);
  expect(fs.existsSync(path.join(projectDir, "09_output", "final.mp4"))).toBe(true);
});
