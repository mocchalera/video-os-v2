import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { main, parseArgs } from "../scripts/analyze.js";
import { validateArtifact } from "../runtime/artifacts/loaders.js";
import { sha256FileHex } from "../runtime/source-content-identity.js";
import { runPipeline, type PipelineOptions } from "../runtime/pipeline/ingest.js";
import {
  parseEbur128Profile,
  type BgmMeasuredBackend,
} from "../runtime/media/bgm-analyzer.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `issue39-m2-${name}-`));
  tempDirs.push(dir);
  return dir;
}

function makeAudio(dir: string, name: string, frequency = 440): string {
  const output = path.join(dir, name);
  execFileSync("ffmpeg", [
    "-v", "error",
    "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono:d=0.6",
    "-f", "lavfi", "-i", `sine=frequency=${frequency}:sample_rate=16000:duration=1.2`,
    "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono:d=0.6",
    "-filter_complex", "[0:a][1:a][2:a]concat=n=3:v=0:a=1[out]",
    "-map", "[out]", output,
  ]);
  return output;
}

function makePulsedAudio(dir: string, name: string): string {
  const output = path.join(dir, name);
  // Keep quiet frames finite for ebur128: the pinned Linux build preserves
  // exact zero here while some host encoders add dither, changing beat coverage.
  execFileSync("ffmpeg", [
    "-v", "error",
    "-f", "lavfi", "-i",
    "aevalsrc=if(lt(mod(t\\,0.8)\\,0.1)\\,0.95*sin(2*PI*440*t)\\,0.001*sin(2*PI*30*t)):s=16000:d=12",
    "-ar", "16000",
    "-ac", "1",
    "-y", output,
  ]);
  return output;
}

function measuredBackend(confidence = 0.92): BgmMeasuredBackend {
  const beats = [0, 0.5, 1, 1.5, 2].map((time_sec) => ({ time_sec, strength: 0.9 }));
  const onsets = [0.08, 0.5, 1.02, 1.5, 2.01].map((time_sec) => ({ time_sec, strength: 0.8 }));
  return {
    name: "issue39-fixture-backend",
    version: "fixture-1",
    sampleRateHz: 16_000,
    inputSampleRateHz: 16_000,
    processingSampleRateHz: 16_000,
    hopLengthSamples: 512,
    windowLengthSamples: 1024,
    analyze: () => ({
      bpm: 123,
      bpmConfidence: confidence,
      meter: "unknown",
      beats,
      onsets,
      downbeats: [],
      sections: [{
        id: "S1",
        label: "measured",
        start_sec: 0,
        end_sec: 2.4,
        energy: 0.8,
      }],
    }),
  };
}

function failingMeasuredBackend(): BgmMeasuredBackend {
  return {
    ...measuredBackend(),
    analyze: () => { throw new Error("fixture backend failed"); },
  };
}

function pipelineOptions(
  projectDir: string,
  sourceFiles: string[],
  overrides: Partial<PipelineOptions> = {},
): PipelineOptions {
  return {
    sourceFiles,
    projectDir,
    repoRoot: REPO_ROOT,
    skipStt: true,
    skipVlm: true,
    skipAppraiser: true,
    skipMarlin: true,
    skipPeak: true,
    skipDiarize: true,
    skipMediaLink: true,
    noCache: true,
    ...overrides,
  };
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

function coverageLane(projectDir: string): {
  lane_id: string;
  status: string;
  required: boolean;
  reason: string | null;
  consumer_impact: string;
  asset_ids: string[];
  artifact_hash?: string | null;
} {
  const coverage = readJson<{ lanes: Array<ReturnType<typeof coverageLane>> }>(
    path.join(projectDir, "03_analysis/analysis_coverage_report.json"),
  );
  return coverage.lanes.find((lane) => lane.lane_id === "bgm_analysis")!;
}

describe("Issue #39 M2 close-readiness contract", () => {
  it("parses finite ebur128 frames from pinned FFmpeg stderr", () => {
    const stderr = [
      "[Parsed_ebur128_0 @ 0x1] t: 0.100000 TARGET:-23 LUFS M:-120.7 S:-120.7 I:-120.7 LRA:0.0",
      "[Parsed_ebur128_0 @ 0x1] t: 0.200000 TARGET:-23 LUFS M: -10.1 S:-10.1 I:-10.1 LRA:0.0",
      "[Parsed_ebur128_0 @ 0x1] t: +0.300000 TARGET:-23 LUFS M: +0.0 S: +0.0 I:-10.0 LRA:0.0",
      "[Parsed_ebur128_0 @ 0x1] t: 0.400000 TARGET:-23 LUFS M:-inf S:-inf I:-inf LRA:0.0",
    ].join("\r\n");

    expect(parseEbur128Profile(stderr)).toEqual([
      { time_sec: 0.1, lufs: -120.7 },
      { time_sec: 0.2, lufs: -10.1 },
      { time_sec: 0.3, lufs: 0 },
    ]);
  });

  it("exposes an explicit BGM source on the public analyze CLI", () => {
    const parsed = parseArgs([
      "node",
      "scripts/analyze.ts",
      "video.mp4",
      "music.mp3",
      "--project",
      "projects/test",
      "--bgm-source",
      "music.mp3",
      "--bgm-backend",
      "ffmpeg",
    ]);

    expect(parsed.sourceFiles).toEqual(["video.mp4", "music.mp3"]);
    expect(parsed.bgmSourceFiles).toEqual(["music.mp3"]);
    expect(parsed.bgmForceBackend).toBe("ffmpeg");
  });

  it("binds one canonical source, records measured provenance, and does not auto-promote other audio", async () => {
    const sourceDir = tempDir("one-source");
    const projectDir = tempDir("one-source-project");
    const music = makeAudio(sourceDir, "music.wav", 440);
    const voice = makeAudio(sourceDir, "voice.wav", 220);
    const result = await runPipeline(pipelineOptions(projectDir, [music, voice], {
      bgmSourceFiles: [music],
      bgmBackend: measuredBackend(),
    }));

    const analysis = readJson<Record<string, any>>(path.join(projectDir, "03_analysis/bgm_analysis.json"));
    validateArtifact(analysis, "bgm-analysis.schema.json");
    const musicAsset = result.assetsJson.items.find((asset) => asset.filename === "music.wav")!;
    const voiceAsset = result.assetsJson.items.find((asset) => asset.filename === "voice.wav")!;
    expect(analysis.analysis_status).toBe("ready");
    expect(analysis.music_asset.asset_id).toBe(musicAsset.asset_id);
    expect(analysis.music_asset.source_hash).toBe(sha256FileHex(music));
    expect(analysis.music_asset.source_content_sha256).toBe(analysis.music_asset.source_hash);
    expect(analysis.music_asset.source_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(analysis.provenance).toMatchObject({
      backend_name: "issue39-fixture-backend",
      backend_version: "fixture-1",
      input_sample_rate_hz: 16_000,
      processing_sample_rate_hz: 16_000,
      sample_rate_hz: 16_000,
      hop_length_samples: 512,
      window_length_samples: 1024,
      time_unit: "seconds",
      evidence_classification: "measured",
      measurement_status: "complete",
      fallback_used: false,
    });
    expect(analysis.provenance.source_content_sha256).toBe(analysis.music_asset.source_hash);
    expect(analysis.onsets).toHaveLength(5);
    expect(analysis.beats.every((cue: { evidence_classification?: string }) => cue.evidence_classification === "measured")).toBe(true);
    expect(analysis.onsets.every((cue: { evidence_classification?: string }) => cue.evidence_classification === "measured")).toBe(true);
    expect(analysis.sections.every((cue: { evidence_classification?: string }) => cue.evidence_classification === "measured")).toBe(true);

    const lane = coverageLane(projectDir);
    expect(lane).toMatchObject({ status: "ready", required: true, asset_ids: [musicAsset.asset_id] });
    expect(lane.asset_ids).not.toContain(voiceAsset.asset_id);
    expect(lane.artifact_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  }, 120_000);

  it("uses the built-in FFmpeg backend through the public CLI and records measured coverage", async () => {
    const sourceDir = tempDir("public-ffmpeg-source");
    const projectDir = tempDir("public-ffmpeg-project");
    const music = makePulsedAudio(sourceDir, "music.wav");

    const exitCode = await main([
      "node",
      "scripts/analyze.ts",
      music,
      "--project",
      projectDir,
      "--bgm-source",
      music,
      "--bgm-backend",
      "ffmpeg",
      "--skip-preflight",
      "--skip-stt",
      "--skip-vlm",
      "--skip-diarize",
      "--skip-peak",
      "--skip-marlin",
      "--skip-appraiser",
      "--skip-media-link",
      "--no-cache",
    ]);

    expect(exitCode).toBe(0);
    const analysis = readJson<Record<string, any>>(path.join(projectDir, "03_analysis/bgm_analysis.json"));
    validateArtifact(analysis, "bgm-analysis.schema.json");
    expect(analysis.analysis_status).toBe("ready");
    expect(analysis.provenance).toMatchObject({
      backend_name: "ffmpeg_ebur128",
      input_sample_rate_hz: 16_000,
      processing_sample_rate_hz: 16_000,
      sample_rate_hz: 16_000,
      hop_length_samples: 1_600,
      window_length_samples: 6_400,
      time_unit: "seconds",
      evidence_classification: "measured",
      measurement_status: "complete",
      fallback_used: false,
    });
    expect(analysis.provenance.backend_version).toMatch(/^[^\s]+$/);
    expect(analysis.provenance.backend_version).not.toBe("unknown");
    expect(analysis.beats.length).toBeGreaterThan(0);
    expect(analysis.onsets.length).toBeGreaterThan(0);
    expect(analysis.sections.length).toBeGreaterThan(0);
    expect(analysis.beats.every((cue: { evidence_classification?: string }) => cue.evidence_classification === "measured")).toBe(true);
    expect(analysis.onsets.every((cue: { evidence_classification?: string }) => cue.evidence_classification === "measured")).toBe(true);
    expect(analysis.sections.every((cue: { evidence_classification?: string }) => cue.evidence_classification === "measured")).toBe(true);
    expect(coverageLane(projectDir)).toMatchObject({ status: "ready", required: true });
  }, 180_000);

  it.each([
    ["unmatched", (sourceDir: string, music: string) => [path.join(sourceDir, "not-in-source-set.wav")]],
    ["multiple", (sourceDir: string, music: string) => [music, makeAudio(sourceDir, "second.wav", 660)]],
  ] as const)("fails closed for %s explicit BGM role binding", async (kind, requestedSources) => {
    const sourceDir = tempDir(`${kind}-source`);
    const projectDir = tempDir(`${kind}-project`);
    const music = makeAudio(sourceDir, "music.wav");
    const requested = requestedSources(sourceDir, music);
    const sourceFiles = kind === "multiple" ? requested : [music];
    await runPipeline(pipelineOptions(projectDir, sourceFiles, {
      bgmSourceFiles: requested,
      bgmBackend: measuredBackend(),
    }));

    expect(fs.existsSync(path.join(projectDir, "03_analysis/bgm_analysis.json"))).toBe(false);
    const lane = coverageLane(projectDir);
    expect(lane).toMatchObject({ status: "failed", required: true, consumer_impact: "planning_block" });
    const coverage = readJson<{ summary: { status: string } }>(path.join(projectDir, "03_analysis/analysis_coverage_report.json"));
    expect(coverage.summary.status).toBe("blocked");
    const coverageText = JSON.stringify(coverage);
    expect(coverageText).not.toContain("not-in-source-set.wav");
  }, 120_000);

  it("fails closed when the bound source hash is stale", async () => {
    const sourceDir = tempDir("stale-source");
    const projectDir = tempDir("stale-project");
    const music = makeAudio(sourceDir, "music.wav");
    let mutated = false;
    await runPipeline(pipelineOptions(projectDir, [music], {
      skipStt: false,
      transcribeFn: async () => {
        if (!mutated) {
          fs.appendFileSync(music, Buffer.from("stale-content"));
          mutated = true;
        }
        return { utterances: [], language: "en" };
      },
      bgmSourceFiles: [music],
      bgmBackend: measuredBackend(),
    }));

    expect(mutated).toBe(true);
    expect(fs.existsSync(path.join(projectDir, "03_analysis/bgm_analysis.json"))).toBe(false);
    expect(coverageLane(projectDir)).toMatchObject({
      status: "failed",
      required: true,
      reason: "explicit BGM role binding failed closed",
      consumer_impact: "planning_block",
    });
  }, 120_000);

  it.each([
    ["unavailable", (): BgmMeasuredBackend | null => null],
    ["failed", failingMeasuredBackend],
  ] as const)("records backend %s as non-ready canonical evidence without synthetic cues", async (_kind, backendFactory) => {
    const sourceDir = tempDir("backend-failure-source");
    const projectDir = tempDir("backend-failure-project");
    const music = makeAudio(sourceDir, "music.wav");
    await runPipeline(pipelineOptions(projectDir, [music], {
      bgmSourceFiles: [music],
      bgmBackend: backendFactory(),
    }));

    const analysis = readJson<Record<string, any>>(path.join(projectDir, "03_analysis/bgm_analysis.json"));
    validateArtifact(analysis, "bgm-analysis.schema.json");
    expect(analysis.analysis_status).toBe("partial");
    expect(analysis.bpm).toBe(0);
    expect(analysis.meter).toBe("unknown");
    expect(analysis.beats).toEqual([]);
    expect(analysis.onsets).toEqual([]);
    expect(analysis.sections).toEqual([]);
    expect(analysis.provenance).toMatchObject({
      evidence_classification: "unavailable",
      measurement_status: "unavailable",
      fallback_used: false,
      tempo_confidence: 0,
    });
    expect(analysis.provenance).not.toHaveProperty("sample_rate_hz");
    expect(analysis.provenance).not.toHaveProperty("hop_length_samples");
    expect(analysis.provenance).not.toHaveProperty("window_length_samples");
    expect(coverageLane(projectDir)).toMatchObject({ status: "failed", required: true, consumer_impact: "planning_block" });
  }, 120_000);

  it("keeps low-confidence measured cues distinguishable but never ready", async () => {
    const sourceDir = tempDir("low-confidence-source");
    const projectDir = tempDir("low-confidence-project");
    const music = makeAudio(sourceDir, "music.wav");
    await runPipeline(pipelineOptions(projectDir, [music], {
      bgmSourceFiles: [music],
      bgmBackend: measuredBackend(0.2),
    }));

    const analysis = readJson<Record<string, any>>(path.join(projectDir, "03_analysis/bgm_analysis.json"));
    validateArtifact(analysis, "bgm-analysis.schema.json");
    expect(analysis.analysis_status).toBe("partial");
    expect(analysis.bpm).toBe(0);
    expect(analysis.meter).toBe("unknown");
    expect(analysis.provenance).toMatchObject({
      evidence_classification: "measured",
      measurement_status: "partial",
      tempo_confidence: 0.2,
      fallback_used: false,
    });
    expect(analysis.sections.length).toBeGreaterThan(0);
    expect(analysis.sections.every((section: { evidence_classification?: string }) => section.evidence_classification === "measured")).toBe(true);
    expect(analysis.sections.map((section: { label: string }) => section.label)).not.toEqual(
      expect.arrayContaining(["intro", "verse", "chorus", "outro"]),
    );
    expect(coverageLane(projectDir)).toMatchObject({ status: "failed", required: true, consumer_impact: "planning_block" });
  }, 120_000);
});
