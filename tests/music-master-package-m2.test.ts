import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { ingestAsset } from "../runtime/connectors/ffprobe.js";
import { approveFinalRenderChecklist } from "../runtime/packaging/final-render-approval.js";
import { verifyExistingPackage } from "../runtime/packaging/package-verification.js";
import { computeFileHash } from "../runtime/state/reconcile.js";
import { packageCommand } from "../runtime/commands/package.js";
import {
  buildExternalRenderRouteReceipt,
  type ExternalRouteMetadata,
} from "../runtime/render/route-resolver.js";
import { runPackageCli } from "../scripts/package.js";

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

function fileHash(filePath: string): string {
  return `sha256:${createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
}

ffIt("packages still-only music_master preserve with a plan-bound final mux receipt", async () => {
  const projectDir = fs.mkdtempSync(path.resolve("tests", "tmp-music-master-package-m2-"));
  tempDirs.push(projectDir);
  fs.cpSync(path.resolve("projects/sample"), projectDir, { recursive: true });

  const stillPath = path.join(projectDir, "00_sources", "still.png");
  const songPath = path.join(projectDir, "00_sources", "full-song.wav");
  fs.mkdirSync(path.dirname(stillPath), { recursive: true });
  execFileSync("ffmpeg", [
    "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=320x180",
    "-frames:v", "1", stillPath,
  ]);
  execFileSync("ffmpeg", [
    "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=5",
    "-ac", "2", "-c:a", "pcm_s16le", songPath,
  ]);
  const stillAsset = await ingestAsset(stillPath, {
    projectRoot: projectDir,
    mediaKind: "image",
    ffmpegVersion: "test",
  });

  const timelinePath = path.join(projectDir, "05_timeline", "timeline.json");
  const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf8")) as Record<string, any>;
  timeline.sequence = {
    ...timeline.sequence,
    width: 320,
    height: 180,
    fps_num: 24,
    fps_den: 1,
    start_frame: 0,
    output_aspect_ratio: "16:9",
  };
  timeline.metadata = { audio_finish: { preset: "preserve" } };
  timeline.tracks = {
    video: [{
      track_id: "V1",
      kind: "video",
      clips: [{
        clip_id: "STILL_M2",
        segment_id: "SEG_STILL_M2",
        asset_id: stillAsset.asset_id,
        media_kind: "image",
        src_in_us: 0,
        src_out_us: 1,
        timeline_in_frame: 0,
        timeline_duration_frames: 120,
        role: "hero",
        motivation: "still fixture",
        beat_id: "b01",
        fallback_segment_ids: [],
        confidence: 1,
        quality_flags: [],
        still_image: {
          hold_frames: 120,
          min_hold_frames: 1,
          max_hold_frames: 120,
          hold_source: "global_default",
          policy_clamp: "none",
          motion_mode: "static",
          fit_mode: "cover",
          background: "black",
        },
      }],
    }],
    audio: [
      { track_id: "A1", kind: "audio", clips: [] },
      { track_id: "A2", kind: "audio", clips: [] },
      { track_id: "A3", kind: "audio", clips: [] },
    ],
  };
  timeline.provenance = {
    ...timeline.provenance,
    audio_policy: {
      mode: "music_master",
      source: "explicit_brief",
      audio_decision: "preserve",
      music_master: {
        asset_id: "SONG_FULL_01",
        source_ref: "00_sources/full-song.wav",
        source_content_hash: fileHash(songPath),
        source_size_bytes: fs.statSync(songPath).size,
        source_duration_us: 5_000_000,
        gain_linear: 1,
        channel_layout: "stereo",
        codec: "pcm_s16le",
        audio_decision: "preserve",
      },
    },
  };
  timeline.markers = [];
  fs.writeFileSync(timelinePath, `${JSON.stringify(timeline, null, 2)}\n`, "utf8");

  fs.mkdirSync(path.join(projectDir, "02_media"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "02_media", "source_map.json"), `${JSON.stringify({
    version: "1",
    project_id: timeline.project_id,
    media_dir: "02_media",
    generated_at: "2026-09-01T00:00:00.000Z",
    items: [{
      asset_id: stillAsset.asset_id,
      source_locator: stillPath,
      local_source_path: stillPath,
      link_path: "00_sources/still.png",
      media_kind: "image",
      source_content_sha256: stillAsset.source_content_sha256,
    }],
  }, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(projectDir, "03_analysis", "assets.json"), `${JSON.stringify({ items: [stillAsset] }, null, 2)}\n`, "utf8");

  const blueprintPath = path.join(projectDir, "04_plan", "edit_blueprint.yaml");
  const blueprint = parseYaml(fs.readFileSync(blueprintPath, "utf8")) as Record<string, any>;
  blueprint.caption_policy = {
    language: "en",
    delivery_mode: "burn_in",
    source: "none",
    styling_class: "clean-lower-third",
  };
  fs.writeFileSync(blueprintPath, stringifyYaml(blueprint), "utf8");

  const reviewReportPath = path.join(projectDir, "06_review", "review_report.yaml");
  const reviewReport = parseYaml(fs.readFileSync(reviewReportPath, "utf8")) as Record<string, any>;
  reviewReport.fatal_issues = [];
  reviewReport.visual_qa = {
    status: "verified",
    score: 90,
    min_score: 70,
    issues: { total: 0, critical: 0, warning: 0, info: 0 },
    issue_summaries: [],
    deterministic_scan: {
      status: "verified",
      scans: {
        decode: { status: "complete" },
        black: { status: "complete", detections: [] },
        freeze: { status: "complete", detections: [] },
        layout_inset: { status: "complete", detections: [] },
      },
    },
  };
  fs.writeFileSync(reviewReportPath, stringifyYaml(reviewReport), "utf8");

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
      approved_at: "2026-09-01T00:00:00.000Z",
      artifact_versions: {
        timeline_version: computeFileHash(timelinePath),
        editorial_timeline_hash: computeFileHash(timelinePath),
        review_report_version: computeFileHash(reviewReportPath),
        review_patch_hash: computeFileHash(reviewPatchPath),
      },
    },
    handoff_resolution: {
      handoff_id: "HND_M2_MUSIC_MASTER",
      status: "decided",
      source_of_truth_decision: "engine_render",
      decided_by: "operator",
      decided_at: "2026-09-01T00:00:00.000Z",
    },
  };
  fs.writeFileSync(path.join(projectDir, "project_state.yaml"), stringifyYaml(state), "utf8");
  approveFinalRenderChecklist(projectDir, {
    approvedBy: "operator",
    approvedAt: "2026-09-01T00:00:00.000Z",
    checklist: {
      captions: "not_applicable",
      caption_typography: "not_applicable",
      section_titles: "not_applicable",
      audio: { decision: "preserve", preview_reviewed: false, bgm: "none" },
      output_spec: "approved",
    },
  });

  const exitCode = await runPackageCli([
    "node",
    "scripts/package.ts",
    projectDir,
    "--created-at",
    "2026-09-01T00:00:00.000Z",
  ]);
  if (exitCode !== 0) {
    const qaPath = path.join(projectDir, "07_package", "qa-report.json");
    const detail = fs.existsSync(qaPath)
      ? JSON.parse(fs.readFileSync(qaPath, "utf8")).checks.filter((check: { passed: boolean }) => !check.passed)
      : "qa-report missing";
    throw new Error(`music_master package failed: ${JSON.stringify(detail)}`);
  }
  expect(exitCode).toBe(0);

  const packageDir = path.join(projectDir, "07_package");
  const plan = JSON.parse(fs.readFileSync(path.join(packageDir, "audio-render-plan.json"), "utf8"));
  const report = JSON.parse(fs.readFileSync(path.join(packageDir, "logs", "audio-mix-report.json"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, "package_manifest.json"), "utf8"));
  expect(plan).toMatchObject({ strategy: "music_master", music_master: { audio_decision: "preserve" } });
  expect(report).toMatchObject({
    strategy: "shared_audio_render_plan_v1",
    mastering_count: 0,
    music_master: {
      audio_decision: "preserve",
      source_bytes_preserved: true,
      final_mux: { operation: "reencode", codec: "aac" },
    },
  });
  expect(report.music_master.output_audio_hash).toBe(report.output.content_hash);
  expect(report.music_master.final_mux.output_container_hash).toBe(fileHash(path.join(packageDir, "video", "final.mp4")));
  expect(manifest.provenance.render.inputs.audio_render_plan.path).toContain("07_package/audio-render-plan.json");
  expect(manifest.provenance.render.inputs.audio_render_plan.sha256).toBe(fileHash(path.join(packageDir, "audio-render-plan.json")));
  expect(manifest.artifacts.audio_mix_report).toEqual({
    path: path.join(packageDir, "logs", "audio-mix-report.json"),
    sha256: fileHash(path.join(packageDir, "logs", "audio-mix-report.json")),
  });
  expect(manifest.provenance.render.inputs.audio_mix_report).toEqual(manifest.artifacts.audio_mix_report);
  expect(manifest.provenance.render.route_evidence.audio).toMatchObject({
    report: manifest.artifacts.audio_mix_report,
    measurement_status: "measured",
  });
  const qa = JSON.parse(fs.readFileSync(path.join(packageDir, "qa-report.json"), "utf8"));
  expect(qa.checks).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "music_master_audio_contract_valid", passed: true }),
  ]));

  const initialVerification = verifyExistingPackage(projectDir);
  if (!initialVerification.ready) {
    throw new Error(`music_master package verification failed: ${JSON.stringify(initialVerification.checks.filter((check) => !check.passed))}`);
  }
  expect(initialVerification.ready).toBe(true);
  const originalReport = JSON.parse(fs.readFileSync(
    path.join(packageDir, "logs", "audio-mix-report.json"),
    "utf8",
  ));
  for (const [label, mutation] of [
    ["plan hash", (candidate: any) => { candidate.plan_hash = `sha256:${"f".repeat(64)}`; }],
    ["final mux audio hash", (candidate: any) => { candidate.music_master.final_mux.output_audio_hash = `sha256:${"e".repeat(64)}`; }],
    ["NaN raw measurement", (candidate: any) => { candidate.music_master.measurements.input.input_i = "NaN"; }],
    ["forged delta", (candidate: any) => { candidate.music_master.measurements.delta.integrated_lufs_db = 999; }],
    ["forged tolerance", (candidate: any) => { candidate.music_master.measurements.tolerance.integrated_lufs_db = 1000; }],
  ] as Array<[string, (candidate: any) => void]>) {
    const reportPath = path.join(packageDir, "logs", "audio-mix-report.json");
    const tampered = structuredClone(originalReport);
    mutation(tampered);
    fs.writeFileSync(reportPath, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");
    const verification = verifyExistingPackage(projectDir);
    expect(verification.ready, label).toBe(false);
    expect(verification.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "music_master_audio_contract_valid", passed: false }),
      expect.objectContaining({ name: "music_master_audio_report_manifest_artifact_binding_valid", passed: false }),
    ]));
  }

  // Reuse the real encoded fixture as an NLE supplied final. The precomputed
  // values intentionally sit outside the SNS fixed-loudness window; the
  // canonical encoded receipt remains the source of truth for this route.
  fs.writeFileSync(
    path.join(packageDir, "logs", "audio-mix-report.json"),
    `${JSON.stringify(originalReport, null, 2)}\n`,
    "utf8",
  );
  const nleState = parseYaml(fs.readFileSync(path.join(projectDir, "project_state.yaml"), "utf8")) as Record<string, any>;
  nleState.current_state = "approved";
  nleState.handoff_resolution.source_of_truth_decision = "nle_finishing";
  delete nleState.artifact_hashes;
  fs.writeFileSync(path.join(projectDir, "project_state.yaml"), stringifyYaml(nleState), "utf8");
  const nleFinalPath = path.join(packageDir, "video", "final.mp4");
  const handoffNotePath = path.join(projectDir, "handoff", "nle-notes.md");
  fs.mkdirSync(path.dirname(handoffNotePath), { recursive: true });
  fs.writeFileSync(handoffNotePath, "M2b NLE supplied-final fixture\n", "utf8");
  const handoffNote = { path: "handoff/nle-notes.md", sha256: fileHash(handoffNotePath) };
  const nleRoute: ExternalRouteMetadata = {
    version: "external-route-metadata/v1",
    project_id: timeline.project_id,
    route_kind: "supplied_final",
    source_identity: {
      timeline: { path: "05_timeline/timeline.json", sha256: fileHash(timelinePath) },
      source_inputs_hash: fileHash(timelinePath),
      source_assets: [],
    },
    output: { path: "07_package/video/final.mp4", sha256: fileHash(nleFinalPath) },
    geometry: { width: 320, height: 180, fps_num: 24, fps_den: 1 },
    required_handoff_artifacts: [handoffNote],
    handoff: {
      status: "confirmed",
      human_owner: "operator",
      human_approval_status: "approved",
      artifacts: [handoffNote],
    },
    agent_qa: { status: "passed" },
    human_approval: { status: "approved", owner: "operator" },
    audio: {
      plan: { path: "07_package/audio-render-plan.json", sha256: fileHash(path.join(packageDir, "audio-render-plan.json")) },
      plan_hash: originalReport.plan_hash,
    },
  };
  fs.writeFileSync(
    path.join(packageDir, "logs", "render-route.json"),
    `${JSON.stringify(buildExternalRenderRouteReceipt(nleRoute), null, 2)}\n`,
    "utf8",
  );
  const nleResult = await packageCommand(projectDir, {
    skipRender: true,
    suppliedFinalPath: nleFinalPath,
    precomputedMetrics: {
      integratedLufs: -12,
      truePeakDbtp: -2,
      videoDurationMs: 5_000,
      audioDurationMs: 5_000,
      videoFrame: { width: 320, height: 180, sar: "1:1", dar: "16:9", fps_num: 24, fps_den: 1, fps: 24 },
    },
    createdAt: "2026-09-01T00:00:00.000Z",
  });
  expect(nleResult.success).toBe(true);
  expect(nleResult.sourceOfTruth).toBe("nle_finishing");
  const nleIntegratedLufs = nleResult.qaReport?.metrics.integrated_lufs;
  expect(
    typeof nleIntegratedLufs === "number"
      && (nleIntegratedLufs < -17 || nleIntegratedLufs > -15),
  ).toBe(true);
  expect(nleResult.qaReport?.checks).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "loudness_target_valid", passed: true }),
    expect.objectContaining({ name: "music_master_audio_contract_valid", passed: true }),
  ]));
}, 60_000);
