import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  executeMusicMasterMvp,
  MUSIC_MASTER_MVP_POLICY,
} from "../runtime/audio/music-master-mvp.js";
import {
  hashAudioRenderPlan,
  resolveAudioRenderPlan,
  validateAudioRenderPlanContract,
} from "../runtime/audio/render-plan.js";
import { validateAgainstSchema } from "../runtime/commands/shared.js";
import { buildEngineRenderManifest } from "../runtime/packaging/manifest.js";
import { checkMusicMasterAudioPlan } from "../runtime/packaging/qa.js";
import { runRenderPipeline } from "../runtime/render/pipeline.js";
import { runAudioRenderPlan } from "../scripts/render-audio-plan.js";
import type { AudioMixReport } from "../runtime/audio/mixer.js";

const roots: string[] = [];
const MUSIC_MASTER_FIXTURE_DURATION_SECONDS = 6;
const MUSIC_MASTER_FIXTURE_DURATION_US = MUSIC_MASTER_FIXTURE_DURATION_SECONDS * 1_000_000;

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function sha256(filePath: string): string {
  return `sha256:${createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
}

function writeMusicMasterFixture(decision: "preserve" | "mastering" = "mastering") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "music-master-mvp-"));
  roots.push(root);
  const sourcePath = path.join(root, "full-song.wav");
  execFileSync("ffmpeg", [
    "-hide_banner",
    "-loglevel", "error",
    "-y",
    "-f", "lavfi",
    "-i", `sine=frequency=220:sample_rate=48000:duration=${MUSIC_MASTER_FIXTURE_DURATION_SECONDS}`,
    "-f", "lavfi",
    "-i", `sine=frequency=440:sample_rate=48000:duration=${MUSIC_MASTER_FIXTURE_DURATION_SECONDS}`,
    "-filter_complex",
    "[0:a]volume='if(lt(t,4),0.16,if(lt(t,8),0.62,0.30))',aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=mono[left];[1:a]volume='if(lt(t,4),0.12,if(lt(t,8),0.48,0.24))',aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=mono[right];[left][right]amerge=inputs=2,pan=stereo|c0=c0|c1=c1",
    "-ar", "48000",
    "-ac", "2",
    "-c:a", "pcm_s16le",
    sourcePath,
  ]);
  const sourceSize = fs.statSync(sourcePath).size;
  const sourceHash = sha256(sourcePath);
  fs.mkdirSync(path.join(root, "05_timeline"), { recursive: true });
  const timelinePath = path.join(root, "05_timeline", "timeline.json");
  fs.writeFileSync(timelinePath, `${JSON.stringify({
    version: "38",
    project_id: "issue-38-mvp-fixture",
    sequence: { name: "music master", fps_num: 24, fps_den: 1, width: 1920, height: 1080 },
    tracks: {
      video: [],
      audio: [
        { track_id: "A1", kind: "audio", clips: [] },
        { track_id: "A2", kind: "audio", clips: [] },
        { track_id: "A3", kind: "audio", clips: [] },
      ],
    },
    markers: [],
    provenance: {
      audio_policy: {
        mode: "music_master",
        source: "explicit_brief",
        audio_decision: decision,
        music_master: {
          asset_id: "SONG_MVP_01",
          source_ref: "full-song.wav",
          source_content_hash: sourceHash,
          source_size_bytes: sourceSize,
          source_duration_us: MUSIC_MASTER_FIXTURE_DURATION_US,
          audio_decision: decision,
          channel_layout: "stereo",
          codec: "pcm_s16le",
        },
      },
    },
  }, null, 2)}\n`);
  return { root, sourcePath, timelinePath };
}

function addSyntheticFinalMux(report: AudioMixReport): AudioMixReport {
  const musicMaster = report.music_master!;
  const input = musicMaster.measurements.input!;
  const output = report.encoded_result!.loudness.raw!;
  report.music_master = {
    ...musicMaster,
    final_mux: {
      operation: "reencode",
      codec: report.encoded_result!.audio_stream.codec_name ?? "pcm_s24le",
      output_audio_hash: report.output!.content_hash,
      output_container_hash: report.encoded_result!.content_hash!,
      measurements: {
        status: "measured",
        delta: {
          integrated_lufs_db: Number(output.input_i) - Number(input.input_i),
          lra_lu: Number(output.input_lra) - Number(input.input_lra),
          true_peak_dbtp: Number(output.input_tp) - Number(input.input_tp),
        },
        tolerance: musicMaster.measurements.tolerance,
        reason: "synthetic final-mux binding for QA contract test",
      },
    },
  };
  return report;
}

describe("Issue #38 practical music-master MVP", () => {
  it("resolves an explicit fixed plan and executes the public route to WAV24/MP3-320", async () => {
    const fixture = writeMusicMasterFixture();
    const plan = resolveAudioRenderPlan({
      projectDir: fixture.root,
      timelinePath: fixture.timelinePath,
    });

    expect(plan.strategy).toBe("music_master");
    expect(plan.music_master?.audio_decision).toBe("mastering");
    expect(plan.music_master?.mastering_policy).toEqual(MUSIC_MASTER_MVP_POLICY);
    expect(plan.expected_artifacts.mastered_mp3).toBe("music_master_320.mp3");
    expect(plan.final_mastering).toMatchObject({
      loudness_target_lufs: -13.3,
      lra_target: 11,
      true_peak_target_dbtp: -1,
      count: 1,
      stage: "after_mix",
    });
    expect(validateAudioRenderPlanContract(plan)).toEqual({ valid: true, errors: [] });
    expect(validateAgainstSchema(plan, "audio-render-plan.schema.json")).toEqual({ valid: true, errors: [] });

    const outputDir = path.join(fixture.root, "rendered");
    const cliResult = await runAudioRenderPlan({
      projectDir: fixture.root,
      timelinePath: fixture.timelinePath,
      outputDir,
      route: "final",
      dryRun: false,
      keepWork: false,
    });
    expect(cliResult).toMatchObject({
      version: "audio-render-plan-cli/v1",
      route: "final",
      plan_hash: hashAudioRenderPlan(plan),
      wrote_files: true,
      final_mix_path: path.join(outputDir, "final_mix.wav"),
      mastered_mp3_path: path.join(outputDir, "music_master_320.mp3"),
    });

    const report = JSON.parse(fs.readFileSync(path.join(outputDir, "audio-mix-report.json"), "utf8")) as AudioMixReport;
    expect(validateAgainstSchema(report, "audio-mix-report.schema.json")).toEqual({ valid: true, errors: [] });
    expect(report.music_master?.mastering).toMatchObject({
      version: "music-master-mvp-receipt/v1",
      plan_hash: hashAudioRenderPlan(plan),
      policy_hash: plan.music_master?.policy_hash,
      execution_graph: {
        version: "music-master-mvp-graph/v1",
        stages: ["cleanup", "presence_air", "spatial_glue", "loudnorm_pass1", "loudnorm_pass2", "wav24", "mp3_320"],
        wav_codec: { codec: "pcm_s24le", bit_depth: 24, sample_rate_hz: 48000, channels: 2 },
        mp3_codec: { codec: "mp3", encoder: "libmp3lame", bit_rate_bps: 320000, sample_rate_hz: 48000, channels: 2 },
      },
      deliverables: {
        wav24: { codec: "pcm_s24le", bit_depth: 24, sample_rate_hz: 48000, channels: 2 },
        mp3_320: { codec: "mp3", bit_rate_bps: 320000, sample_rate_hz: 48000, channels: 2 },
      },
      human_approval: {
        stereo_width: "pending",
        tonal_balance: "pending",
        lyric_clarity: "pending",
        automated_quality_claim: "not_allowed",
      },
    });
    const mastering = report.music_master!.mastering!;
    expect(mastering.pass1.raw).not.toEqual(mastering.pass2.raw);
    expect(mastering.pass2.integrated_lufs).toBeGreaterThanOrEqual(-13.8);
    expect(mastering.pass2.integrated_lufs).toBeLessThanOrEqual(-12.8);
    expect(mastering.pass2.true_peak_dbtp).toBeLessThanOrEqual(-1);
    expect(mastering.mp3.integrated_lufs).toBeGreaterThanOrEqual(-13.8);
    expect(mastering.mp3.integrated_lufs).toBeLessThanOrEqual(-12.8);
    expect(mastering.mp3.true_peak_dbtp).toBeLessThanOrEqual(-1);
    expect(fs.statSync(path.join(outputDir, "music_master_320.mp3")).size).toBeGreaterThan(0);

    const assemblyPath = path.join(fixture.root, "assembly.mp4");
    execFileSync("ffmpeg", [
      "-hide_banner",
      "-loglevel", "error",
      "-y",
      "-f", "lavfi",
      "-i", `color=c=black:s=1920x1080:r=24:d=${MUSIC_MASTER_FIXTURE_DURATION_SECONDS}`,
      "-an",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      assemblyPath,
    ]);
    const packageOutputDir = path.join(fixture.root, "package-output");
    fs.mkdirSync(packageOutputDir, { recursive: true });
    const persistedPlanPath = path.join(packageOutputDir, "audio-render-plan.json");
    fs.writeFileSync(persistedPlanPath, `${JSON.stringify(plan, null, 2)}\n`);
    const pipelineResult = await runRenderPipeline({
      projectDir: fixture.root,
      timelinePath: fixture.timelinePath,
      assemblyPath,
      outputDir: packageOutputDir,
      audioRenderPlan: plan,
      audioRenderPlanPath: persistedPlanPath,
      fps: 24,
      captionPolicy: {
        language: "en",
        delivery_mode: "burn_in",
        source: "none",
        styling_class: "clean-lower-third",
      },
      assertMediaWriteReadyImpl: () => ({ ok: true, checks: [] }),
    });
    expect(pipelineResult.masteredMp3Path).toBe(path.join(packageOutputDir, "audio", "music_master_320.mp3"));
    const packageReport = JSON.parse(fs.readFileSync(pipelineResult.audioMixReportPath, "utf8")) as AudioMixReport;
    expect(packageReport.music_master?.final_mux).toMatchObject({ operation: "reencode", codec: "aac" });
    expect(validateAgainstSchema(packageReport, "audio-mix-report.schema.json")).toEqual({ valid: true, errors: [] });
    expect(checkMusicMasterAudioPlan(plan, packageReport, {
      projectDir: fixture.root,
      finalMixPath: pipelineResult.finalMixPath,
      masteredMp3Path: pipelineResult.masteredMp3Path,
      finalVideoPath: pipelineResult.finalVideoPath,
    })).toMatchObject({ name: "music_master_audio_contract_valid", passed: true });

    const qaReportPath = path.join(packageOutputDir, "qa-report.json");
    fs.writeFileSync(qaReportPath, JSON.stringify({ version: "qa-report/v1", passed: true }));
    const manifest = buildEngineRenderManifest({
      projectId: plan.project_id,
      baseTimelineVersion: plan.timeline.version,
      editorialTimelineHash: plan.timeline.content_hash,
      outputDir: packageOutputDir,
      finalVideoPath: pipelineResult.finalVideoPath,
      sourceInputsHash: plan.timeline.content_hash.replace(/^sha256:/, ""),
      sourceInputsAttestationStatus: "not_applicable",
      captionPolicy: { source: "none", delivery_mode: "burn_in" },
      renderRouteReceiptPath: pipelineResult.renderRouteReceiptPath,
      renderReportPath: pipelineResult.renderReportPath,
      audioRenderPlanPath: persistedPlanPath,
    });
    expect(validateAgainstSchema(manifest, "package-manifest.schema.json")).toEqual({ valid: true, errors: [] });
    expect(manifest.artifacts.mastered_mp3).toEqual({
      path: pipelineResult.masteredMp3Path,
      sha256: sha256(pipelineResult.masteredMp3Path!),
    });
  }, 45_000);

  it("fails closed for ambiguous decisions, preserve conflicts, unsupported tools, and partial output", async () => {
    const fixture = writeMusicMasterFixture("preserve");
    expect(() => resolveAudioRenderPlan({
      projectDir: fixture.root,
      timelinePath: fixture.timelinePath,
      masteringDefaults: { loudness_target_lufs: -16, lra_target: 7, true_peak_target_dbtp: -1.5 },
    })).toThrow(/cannot be combined with an explicit mastering request/);

    const timeline = JSON.parse(fs.readFileSync(fixture.timelinePath, "utf8")) as Record<string, any>;
    timeline.metadata = {
      audio_delivery_profile_ref: "delivery_profiles/audio/internal/ai-music-sns-v1.yaml",
    };
    delete timeline.provenance.audio_policy.audio_decision;
    fs.writeFileSync(fixture.timelinePath, `${JSON.stringify(timeline, null, 2)}\n`);
    expect(() => resolveAudioRenderPlan({ projectDir: fixture.root, timelinePath: fixture.timelinePath }))
      .toThrow(/missing/);

    const masteringFixture = writeMusicMasterFixture();
    const wavPath = path.join(masteringFixture.root, "out.wav");
    const mp3Path = path.join(masteringFixture.root, "out.mp3");
    await expect(executeMusicMasterMvp({
      sourcePath: masteringFixture.sourcePath,
      sourceRangeUs: { in_us: 0, out_us: MUSIC_MASTER_FIXTURE_DURATION_US },
      outputWavPath: wavPath,
      outputMp3Path: mp3Path,
      ffmpegBin: path.join(masteringFixture.root, "missing-ffmpeg"),
      ffprobeBin: path.join(masteringFixture.root, "missing-ffprobe"),
    })).rejects.toMatchObject({ code: "UNSUPPORTED_TOOLCHAIN" });
    expect(fs.existsSync(wavPath)).toBe(false);
    expect(fs.existsSync(mp3Path)).toBe(false);

    const fakeFfmpeg = path.join(masteringFixture.root, "partial-ffmpeg.cjs");
    fs.writeFileSync(fakeFfmpeg, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("-version")) process.exit(0);
if (args.includes("-filters")) { console.log(" T highpass\\n T equalizer\\n T extrastereo\\n T mcompand\\n T loudnorm"); process.exit(0); }
if (args.includes("-encoders")) { console.log(" A pcm_s24le\\n A libmp3lame"); process.exit(0); }
if (args.at(-1) === "-") { console.error('{"input_i":"-13.3","input_tp":"-2","input_lra":"4","input_thresh":"-23","target_offset":"0"}'); process.exit(0); }
fs.writeFileSync(args.at(-1), "partial WAV");
process.exit(0);
`);
    fs.chmodSync(fakeFfmpeg, 0o755);
    const partialWav = path.join(masteringFixture.root, "partial.wav");
    const partialMp3 = path.join(masteringFixture.root, "partial.mp3");
    await expect(executeMusicMasterMvp({
      sourcePath: masteringFixture.sourcePath,
      sourceRangeUs: { in_us: 0, out_us: MUSIC_MASTER_FIXTURE_DURATION_US },
      outputWavPath: partialWav,
      outputMp3Path: partialMp3,
      ffmpegBin: fakeFfmpeg,
    })).rejects.toThrow(/EXECUTION_FAILED|FORMAT_INVALID/);
    expect(fs.existsSync(partialWav)).toBe(false);
    expect(fs.existsSync(partialMp3)).toBe(false);
  }, 45_000);

  it("rejects wrong identity, pass substitution, NaN/partial/target measurements, and duplicate mastering", async () => {
    const fixture = writeMusicMasterFixture();
    const plan = resolveAudioRenderPlan({ projectDir: fixture.root, timelinePath: fixture.timelinePath });
    const outputDir = path.join(fixture.root, "rendered");
    await runAudioRenderPlan({
      projectDir: fixture.root,
      timelinePath: fixture.timelinePath,
      outputDir,
      route: "final",
      dryRun: false,
      keepWork: false,
    });
    const original = addSyntheticFinalMux(JSON.parse(
      fs.readFileSync(path.join(outputDir, "audio-mix-report.json"), "utf8"),
    ) as AudioMixReport);
    const check = (
      report: AudioMixReport,
      candidatePlan = plan,
      verifyBoundMedia = false,
    ) => checkMusicMasterAudioPlan(
      candidatePlan,
      report,
      {
        projectDir: fixture.root,
        finalMixPath: path.join(outputDir, "final_mix.wav"),
        masteredMp3Path: path.join(outputDir, "music_master_320.mp3"),
        verifyBoundMedia,
      },
    );
    expect(check(original).passed).toBe(true);

    const cases: Array<[string, (report: AudioMixReport, candidatePlan: typeof plan) => void]> = [
      ["wrong source hash", (report) => { report.music_master!.source.source_content_hash = `sha256:${"f".repeat(64)}`; }],
      ["wrong plan hash", (report) => { report.plan_hash = `sha256:${"e".repeat(64)}`; }],
      ["wrong policy hash", (report) => { report.music_master!.mastering!.policy_hash = `sha256:${"d".repeat(64)}`; }],
      ["wrong receipt plan hash", (report) => { report.music_master!.mastering!.plan_hash = `sha256:${"b".repeat(64)}`; }],
      ["wrong output hash", (report) => { report.music_master!.mastering!.deliverables.wav24.content_hash = `sha256:${"c".repeat(64)}`; }],
      ["wrong MP3 output hash", (report) => { report.music_master!.mastering!.deliverables.mp3_320.content_hash = `sha256:${"a".repeat(64)}`; }],
      ["pass1 substitution", (report) => { report.music_master!.mastering!.pass1.integrated_lufs += 1; }],
      ["NaN measurement", (report) => { report.music_master!.mastering!.pass2.integrated_lufs = Number.NaN; }],
      ["partial measurement", (report) => { report.music_master!.mastering!.pass2 = null as never; }],
      ["target exceed", (report) => { report.music_master!.mastering!.mp3.integrated_lufs = -10; }],
      ["duplicate mastering", (_report, candidatePlan) => {
        (candidatePlan.final_mastering as { count: number }).count = 2;
      }],
    ];
    for (const [label, mutate] of cases) {
      const candidate = structuredClone(original);
      const candidatePlan = structuredClone(plan);
      mutate(candidate, candidatePlan);
      expect(check(candidate, candidatePlan, label === "wrong MP3 output hash").passed, label).toBe(false);
    }
  }, 45_000);
});
