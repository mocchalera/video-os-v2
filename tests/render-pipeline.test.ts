import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

import {
  buildAspectRatioFitFilter,
  buildAudioDurationNormalizationArgs,
  buildApprovedCaptionAssCues,
  buildFinalMuxArgs,
  readTimelineDurationSeconds,
  runRenderPipeline,
} from "../runtime/render/pipeline.js";
import { timelineEmbeddedMusicAssetIds } from "../runtime/audio/timeline-music.js";

describe("timeline embedded music ownership", () => {
  it("detects selected A2 music without music_cues and keeps multiple asset identities deterministic", () => {
    expect(timelineEmbeddedMusicAssetIds({
      tracks: { audio: [
        { track_id: "A2", clips: [{ asset_id: "AST_B" }, { asset_id: "AST_A" }] },
        { track_id: "A3", clips: [{ asset_id: "AST_C", role: "music" }, { asset_id: "AST_A", role: "bgm" }] },
        { track_id: "A1", clips: [{ asset_id: "AST_DIALOGUE", role: "dialogue" }] },
      ] },
    })).toEqual(["AST_A", "AST_B", "AST_C"]);
  });
});

describe("semantic caption burn cues", () => {
  it("keeps canonical speech timing and classifies question/reveal motion", () => {
    expect(buildApprovedCaptionAssCues([
      {
        timeline_in_frame: 30,
        timeline_duration_frames: 15,
        text: "坂本｜知ってる？",
      },
      {
        timeline_in_frame: 60,
        timeline_duration_frames: 30,
        text: "AI｜調べました",
        reveal_timing: { status: "protected", role: "punchline" },
      },
    ], 30)).toEqual([
      { startSec: 1, endSec: 1.5, text: "坂本｜知ってる？", semanticRole: "question" },
      { startSec: 2, endSec: 3, text: "AI｜調べました", semanticRole: "reveal" },
    ]);
  });
});

describe("render pipeline aspect ratio fitting", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-render-pipeline-"));
    execFileMock.mockReset();
    execFileMock.mockImplementation((
      _cmd: string,
      args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout?: string, stderr?: string) => void,
    ) => {
      if (args.some((arg) => arg.includes("loudnorm")) && args.includes("null")) {
        cb(null, "", JSON.stringify({
          input_i: "-22.00",
          input_tp: "-4.00",
          input_lra: "3.00",
          input_thresh: "-32.00",
          target_offset: "0.00",
        }));
        return;
      }
      const outputPath = args[args.length - 1];
      if (typeof outputPath === "string" && !outputPath.startsWith("-")) {
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, "stub", "utf-8");
      }
      cb(null, "", "");
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("buildAspectRatioFitFilter delegates to the shared filtergraph builder", () => {
    // FATAL-1 fix (Phase 5 review R1): preview and final must serialize the
    // video filter chain through the same shared builder. The legacy bespoke
    // string `scale=...,pad=...:black` has been replaced with the shared
    // builder's no-transform output, which uses ffmpeg's default pad colour
    // (black) and appends format/setsar to keep concat streams uniform.
    expect(buildAspectRatioFitFilter(1920, 1080)).toBe(
      "scale=1920:1080:force_original_aspect_ratio=decrease," +
        "pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p,setsar=1",
    );
  });

  it("pins final mux to timeline duration, frame count, and 48 kHz delivery audio", () => {
    expect(buildFinalMuxArgs("video.mp4", "audio.wav", "final.mp4", 91.333333, 2192)).toEqual([
      "-y",
      "-i", "video.mp4",
      "-i", "audio.wav",
      "-t", "91.333333",
      "-frames:v", "2192",
      "-c:v", "copy",
      "-c:a", "aac",
      "-b:a", "192k",
      "-ar", "48000",
      "final.mp4",
    ]);
  });

  it("normalizes final-mix duration to the canonical timeline duration", () => {
    expect(buildAudioDurationNormalizationArgs("mix.wav", "trimmed.wav", 62.233333)).toEqual([
      "-y",
      "-i", "mix.wav",
      "-af", "apad=pad_dur=62.233333,atrim=duration=62.233333",
      "-ar", "48000",
      "-c:a", "pcm_s24le",
      "trimmed.wav",
    ]);
  });

  it("uses shortest-stream fallback when timeline duration is unavailable", () => {
    expect(buildFinalMuxArgs("video.mp4", "audio.wav", "final.mp4")).toContain("-shortest");
  });

  it("derives sequence duration from the latest clip out point", () => {
    const timelinePath = path.join(tmpDir, "timeline-duration.json");
    fs.writeFileSync(timelinePath, JSON.stringify({
      sequence: { fps_num: 24, fps_den: 1 },
      tracks: {
        video: [{ clips: [{ timeline_in_frame: 0, timeline_duration_frames: 120 }] }],
        audio: [{ clips: [{ timeline_in_frame: 120, timeline_duration_frames: 72 }] }],
      },
    }));

    expect(readTimelineDurationSeconds(timelinePath)).toBe(8);
  });

  it("runRenderPipeline fits raw video to timeline dimensions before final mux", async () => {
    const timelinePath = path.join(tmpDir, "05_timeline", "timeline.json");
    const assemblyPath = path.join(tmpDir, "05_timeline", "assembly.mp4");
    const outputDir = path.join(tmpDir, "07_package");

    fs.mkdirSync(path.dirname(timelinePath), { recursive: true });
    fs.writeFileSync(
      timelinePath,
      JSON.stringify({
        sequence: {
          fps_num: 30,
          fps_den: 1,
          width: 1920,
          height: 1080,
          output_aspect_ratio: "16:9",
        },
      }, null, 2),
      "utf-8",
    );
    fs.writeFileSync(assemblyPath, "stub-assembly", "utf-8");

    const result = await runRenderPipeline({
      projectDir: tmpDir,
      timelinePath,
      assemblyPath,
      captionPolicy: {
        language: "ja",
        delivery_mode: "sidecar",
        source: "none",
        styling_class: "clean-lower-third",
      },
      outputDir,
      fps: 30,
    });

    const ffmpegCalls = execFileMock.mock.calls.map((call) => call[1] as string[]);
    const fitCall = ffmpegCalls.find((args) =>
      args.includes("-vf") && args.includes(buildAspectRatioFitFilter(1920, 1080))
    );

    expect(fitCall).toBeDefined();
    expect(result.rawVideoPath).toBe(path.join(outputDir, "video", "raw_video.mp4"));
    expect(fs.existsSync(result.rawVideoPath)).toBe(true);
    expect(fs.existsSync(result.finalVideoPath)).toBe(true);
    expect(result.renderRouteReceiptPath).toBe(path.join(outputDir, "logs", "render-route.json"));
    expect(JSON.parse(fs.readFileSync(result.renderRouteReceiptPath, "utf8"))).toMatchObject({
      version: "render-route/v1",
      assembly_engine: "ffmpeg",
      hyperframes_overlay: false,
    });
  });

  it("regenerates burn-in SRT from caption approval instead of reusing stale text", async () => {
    const timelinePath = path.join(tmpDir, "05_timeline", "timeline.json");
    const assemblyPath = path.join(tmpDir, "05_timeline", "assembly.mp4");
    const approvalPath = path.join(tmpDir, "07_package", "caption_approval.json");
    const captionsDir = path.join(tmpDir, "07_package", "captions");

    fs.mkdirSync(path.dirname(timelinePath), { recursive: true });
    fs.mkdirSync(captionsDir, { recursive: true });
    fs.writeFileSync(timelinePath, JSON.stringify({
      sequence: {
        fps_num: 30,
        fps_den: 1,
        width: 1080,
        height: 1920,
        output_aspect_ratio: "9:16",
      },
      tracks: {
        video: [{ track_id: "V1", clips: [{ timeline_in_frame: 0, timeline_duration_frames: 60 }] }],
        audio: [],
      },
    }), "utf-8");
    fs.writeFileSync(assemblyPath, "stub-assembly", "utf-8");
    fs.writeFileSync(approvalPath, JSON.stringify({
      speech_captions: [{
        caption_id: "SC_0001",
        timeline_in_frame: 0,
        timeline_duration_frames: 60,
        text: "坂本｜新しい字幕\n安全な改行",
      }],
    }), "utf-8");
    fs.writeFileSync(
      path.join(captionsDir, "speech.approved.srt"),
      "1\n00:00:00,000 --> 00:00:02,000\n古い字幕\n",
      "utf-8",
    );

    const result = await runRenderPipeline({
      projectDir: tmpDir,
      timelinePath,
      assemblyPath,
      captionApprovalPath: approvalPath,
      captionPolicy: {
        language: "ja",
        delivery_mode: "burn_in",
        source: "transcript",
        styling_class: "single-layer-speaker-separated-bold-outline-safe-area-ja",
      },
      outputDir: path.join(tmpDir, "07_package"),
      fps: 30,
    });

    const srt = fs.readFileSync(
      path.join(captionsDir, "speech.approved.srt"),
      "utf-8",
    );
    expect(srt).toContain("坂本｜新しい字幕\n安全な改行");
    expect(srt).not.toContain("古い字幕");
  });

  it("passes the music asset and A1 speech intervals into the BGM mix", async () => {
    const timelinePath = path.join(tmpDir, "05_timeline", "timeline.json");
    const assemblyPath = path.join(tmpDir, "05_timeline", "assembly.mp4");
    const musicPath = path.join(tmpDir, "07_package", "audio", "bgm.wav");
    const musicCuesPath = path.join(tmpDir, "07_package", "music_cues.json");
    const outputDir = path.join(tmpDir, "07_package");

    fs.mkdirSync(path.dirname(timelinePath), { recursive: true });
    fs.mkdirSync(path.dirname(musicPath), { recursive: true });
    fs.writeFileSync(timelinePath, JSON.stringify({
      sequence: {
        fps_num: 30,
        fps_den: 1,
        width: 1080,
        height: 1920,
        output_aspect_ratio: "9:16",
      },
      tracks: {
        video: [{ track_id: "V1", clips: [{ timeline_in_frame: 0, timeline_duration_frames: 60 }] }],
        audio: [{
          track_id: "A1",
          clips: [{ timeline_in_frame: 0, timeline_duration_frames: 45 }],
        }],
      },
    }, null, 2), "utf-8");
    fs.writeFileSync(assemblyPath, "stub-assembly", "utf-8");
    fs.writeFileSync(musicPath, "stub-bgm", "utf-8");
    fs.writeFileSync(musicCuesPath, JSON.stringify({
      version: "1",
      project_id: "bgm-test",
      base_timeline_version: "1",
      music_asset: {
        asset_id: "BGM_TEST",
        path: "07_package/audio/bgm.wav",
        source_hash: "sha256:test",
      },
      cues: [{
        cue_id: "MC_MAIN",
        track_id: "A2",
        entry_window: { earliest_frame: 0, latest_frame: 0 },
        entry_frame: 0,
        exit_frame: 60,
        fade_in_ms: 50,
        fade_out_ms: 200,
        ducking: {
          base_gain_db: -4,
          duck_gain_db: -11,
          attack_ms: 15,
          release_ms: 280,
        },
      }],
    }, null, 2), "utf-8");

    const result = await runRenderPipeline({
      projectDir: tmpDir,
      timelinePath,
      assemblyPath,
      musicCuesPath,
      captionPolicy: {
        language: "ja",
        delivery_mode: "sidecar",
        source: "none",
        styling_class: "clean-lower-third",
      },
      outputDir,
      fps: 30,
    });

    const ffmpegCalls = execFileMock.mock.calls.map((call) => call[1] as string[]);
    const bgmMixCall = ffmpegCalls.find((args) =>
      args.some((arg) => arg.includes("sidechaincompress=threshold=0.03"))
      && args.some((arg) => arg.includes("volume=-4dB"))
      && args.some((arg) => arg.includes("amix=inputs=2:duration=first")),
    );
    expect(bgmMixCall).toBeDefined();
    const bgmReferenceCall = ffmpegCalls.find((args) =>
      args.includes(musicPath)
      && args.some((arg) => arg.includes("loudnorm=I=-23")),
    );
    expect(bgmReferenceCall).toBeDefined();
    expect(fs.existsSync(result.audioMixReportPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(result.audioMixReportPath, "utf-8"))).toMatchObject({
      version: "audio-mix-report/v1",
      has_bgm: true,
      strategy: "waveform_sidechain_v1",
      bgm_reference_mastering: { loudness_target_lufs: -23 },
      final_mastering: {
        loudness_target_lufs: -16,
        true_peak_target_dbtp: -1.5,
      },
      sidechain: {
        detector: "dialogue_waveform_rms",
        attack_ms: 15,
        release_ms: 280,
      },
    });
  });

  it("records timeline-owned A2 music without music_cues as BGM without re-adding it", async () => {
    const timelinePath = path.join(tmpDir, "05_timeline", "timeline.json");
    const assemblyPath = path.join(tmpDir, "05_timeline", "assembly.mp4");
    const outputDir = path.join(tmpDir, "07_package");
    fs.mkdirSync(path.dirname(timelinePath), { recursive: true });
    fs.writeFileSync(timelinePath, JSON.stringify({
      sequence: { fps_num: 30, fps_den: 1, width: 1920, height: 1080 },
      tracks: {
        video: [],
        audio: [
          { track_id: "A1", clips: [{ asset_id: "AST_VOICE", timeline_in_frame: 0, timeline_duration_frames: 60 }] },
          { track_id: "A2", clips: [{ asset_id: "AST_MUSIC_A", timeline_in_frame: 0, timeline_duration_frames: 60 }] },
          { track_id: "A2", clips: [{ asset_id: "AST_MUSIC_B", timeline_in_frame: 30, timeline_duration_frames: 30 }] },
        ],
      },
    }), "utf-8");
    fs.writeFileSync(assemblyPath, "stub-assembly", "utf-8");

    const result = await runRenderPipeline({
      projectDir: tmpDir,
      timelinePath,
      assemblyPath,
      captionPolicy: { language: "ja", delivery_mode: "sidecar", source: "none", styling_class: "clean-lower-third" },
      outputDir,
      fps: 30,
    });

    expect(JSON.parse(fs.readFileSync(result.audioMixReportPath, "utf-8"))).toMatchObject({
      has_bgm: true,
      strategy: "timeline_embedded_bgm_mastering_v1",
      bgm_ownership: {
        owner: "timeline_assembler",
        asset_ids: ["AST_MUSIC_A", "AST_MUSIC_B"],
      },
    });
  });

  it("does not add a music_cues asset a second time when the assembler already owns it", async () => {
    const timelinePath = path.join(tmpDir, "05_timeline", "timeline.json");
    const assemblyPath = path.join(tmpDir, "05_timeline", "assembly.mp4");
    const musicPath = path.join(tmpDir, "07_package", "audio", "bgm.wav");
    const musicCuesPath = path.join(tmpDir, "07_package", "music_cues.json");
    fs.mkdirSync(path.dirname(timelinePath), { recursive: true });
    fs.mkdirSync(path.dirname(musicPath), { recursive: true });
    fs.writeFileSync(timelinePath, JSON.stringify({
      sequence: { fps_num: 30, fps_den: 1, width: 1920, height: 1080 },
      tracks: {
        video: [],
        audio: [
          { track_id: "A1", clips: [{ asset_id: "AST_VOICE", timeline_in_frame: 0, timeline_duration_frames: 60 }] },
          { track_id: "A2", clips: [{ asset_id: "AST_MUSIC", timeline_in_frame: 0, timeline_duration_frames: 60 }] },
        ],
      },
    }), "utf-8");
    fs.writeFileSync(assemblyPath, "stub-assembly", "utf-8");
    fs.writeFileSync(musicPath, "stub-bgm", "utf-8");
    fs.writeFileSync(musicCuesPath, JSON.stringify({
      version: "1",
      project_id: "embedded-bgm-test",
      base_timeline_version: "1",
      music_asset: { asset_id: "AST_MUSIC", path: "07_package/audio/bgm.wav", source_hash: "sha256:test" },
      cues: [{
        cue_id: "MC_MAIN",
        track_id: "A2",
        entry_window: { earliest_frame: 0, latest_frame: 0 },
        entry_frame: 0,
        exit_frame: 60,
        fade_in_ms: 50,
        fade_out_ms: 200,
        ducking: { base_gain_db: -4, duck_gain_db: -11, attack_ms: 15, release_ms: 280 },
      }],
    }), "utf-8");

    const result = await runRenderPipeline({
      projectDir: tmpDir,
      timelinePath,
      assemblyPath,
      musicCuesPath,
      captionPolicy: { language: "ja", delivery_mode: "sidecar", source: "none", styling_class: "clean-lower-third" },
      outputDir: path.join(tmpDir, "07_package"),
      fps: 30,
    });
    const ffmpegCalls = execFileMock.mock.calls.map((call) => call[1] as string[]);
    expect(ffmpegCalls.some((args) => args.includes(musicPath))).toBe(false);
    expect(JSON.parse(fs.readFileSync(result.audioMixReportPath, "utf-8"))).toMatchObject({
      has_bgm: true,
      strategy: "timeline_embedded_bgm_mastering_v1",
      bgm_ownership: { owner: "timeline_assembler", asset_ids: ["AST_MUSIC"] },
    });
  });
});
