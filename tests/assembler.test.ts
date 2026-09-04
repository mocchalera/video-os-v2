import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  assembleTimelineToMp4,
  buildAudioAssemblyPlan,
  buildBgmAudioRenderArgs,
  buildAudioTrimArgs,
  buildFinalAssemblyMuxArgs,
  buildVideoTrimArgs,
  buildVideoAssemblyPlan,
  type ExecFileLike,
  formatFfmpegTimestamp,
  readTimeline,
  extractEndingVideoFade,
  hasPinnedMusicCueA2,
} from "../runtime/render/assembler.js";
import { buildAspectRatioFitFilter } from "../runtime/render/pipeline.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDemoProject(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-assembler-test-"));
  tempDirs.push(tmpDir);

  for (const relPath of [
    "03_analysis/assets.json",
    "05_timeline/timeline.json",
    "05_timeline/preview-manifest.json",
  ]) {
    const src = path.resolve("projects/demo", relPath);
    const dest = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }

  const assets = JSON.parse(
    fs.readFileSync(path.join(tmpDir, "03_analysis/assets.json"), "utf-8"),
  ) as { items: Array<{ filename: string }> };
  const sourcesDir = path.join(tmpDir, "00_sources");
  fs.mkdirSync(sourcesDir, { recursive: true });
  for (const asset of assets.items) {
    fs.writeFileSync(path.join(sourcesDir, asset.filename), "stub-media", "utf-8");
  }

  return tmpDir;
}

function createExecMock(calls: Array<{ cmd: string; args: string[] }>): ExecFileLike {
  return (
    cmd,
    args,
    _opts,
    cb,
  ) => {
    calls.push({ cmd, args: [...args] });
    const outputPath = args[args.length - 1];
    if (typeof outputPath === "string" && !outputPath.startsWith("-")) {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, "stub-output", "utf-8");
    }
    cb(null, "", "");
  };
}

describe("ffmpeg assembler", () => {
  it("identifies pinned A2 that must bypass embedded assembly audio", () => {
    const timeline = readTimeline(
      path.join(createTempDemoProject(), "05_timeline", "timeline.json"),
    );
    timeline.tracks.audio.push({
      track_id: "A2",
      kind: "audio",
      clips: [{
        ...timeline.tracks.audio[0].clips[0],
        clip_id: "A2_MC_MAIN",
        role: "music",
        metadata: {
          music_cue: { cue_id: "MC_MAIN" },
          music_asset: {
            pack_manifest_hash: `sha256:${"a".repeat(64)}`,
            full_mix_content_hash: `sha256:${"b".repeat(64)}`,
          },
        },
      }],
    });
    expect(hasPinnedMusicCueA2(timeline)).toBe(true);
    timeline.provenance.audio_policy = {
      mode: "original_only",
      source: "explicit_brief",
    };
    expect(hasPinnedMusicCueA2(timeline)).toBe(false);
  });

  it("builds deterministic video/audio plans from projects/demo timeline", () => {
    const timeline = readTimeline(path.resolve("projects/demo/05_timeline/timeline.json"));

    const videoPlans = buildVideoAssemblyPlan(timeline);
    const audioPlans = buildAudioAssemblyPlan(timeline);

    expect(videoPlans[0]).toMatchObject({
      kind: "clip",
      track_id: "V1",
      clip_id: "CLP_0001",
      asset_id: "AST_005",
      start_frame: 0,
      end_frame: 92,
      source_in_sec: 2,
      source_out_sec: 5.5,
    });
    expect(videoPlans.some((plan) => plan.kind === "gap")).toBe(true);

    expect(audioPlans).toHaveLength(4);
    expect(audioPlans[0]).toMatchObject({
      track_id: "A1",
      clip_id: "CLP_0005",
      asset_id: "AST_001",
      source_in_sec: 6.4,
      source_out_sec: 11,
      delay_ms: 4000,
    });
  });

  it("generates trim, concat, and audio mix ffmpeg arguments", async () => {
    const projectDir = createTempDemoProject();
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const timeline = readTimeline(path.join(projectDir, "05_timeline", "timeline.json"));
    const firstVideoPlan = buildVideoAssemblyPlan(timeline)[0];
    const firstAudioPlan = buildAudioAssemblyPlan(timeline)[0];

    const result = await assembleTimelineToMp4({
      projectDir,
      cleanupTemp: false,
      workingDirRoot: projectDir,
      execFileImpl: createExecMock(calls),
    });

    const trimCall = calls.find((call) =>
      call.args.includes("-vf") &&
      call.args.some((arg) => arg.includes(buildAspectRatioFitFilter(1920, 1080))) &&
      call.args.some((arg) => arg.endsWith("video-segment-0001.mp4"))
    );
    expect(trimCall).toBeDefined();
    expect(trimCall!.args).not.toContain("-ss");
    expect(trimCall!.args).not.toContain("-to");
    const videoFilter = trimCall!.args[trimCall!.args.indexOf("-vf") + 1];
    expect(videoFilter).toContain(
      `trim=start=${formatFfmpegTimestamp(firstVideoPlan.source_in_sec!)}:end=${formatFfmpegTimestamp(firstVideoPlan.source_out_sec!)}`,
    );

    const audioTrimCall = calls.find((call) =>
      call.args.includes("-vn") &&
      call.args.some((arg) => arg.endsWith("audio-segment-0001.wav"))
    );
    expect(audioTrimCall).toBeDefined();
    expect(audioTrimCall!.args).not.toContain("-ss");
    expect(audioTrimCall!.args).not.toContain("-to");
    const audioFilter = audioTrimCall!.args[audioTrimCall!.args.indexOf("-af") + 1];
    expect(audioFilter).toContain(
      `atrim=start=${formatFfmpegTimestamp(firstAudioPlan.source_in_sec)}:end=${formatFfmpegTimestamp(firstAudioPlan.source_out_sec)}`,
    );

    const concatList = fs.readFileSync(
      path.join(result.workingDir, "video.concat.txt"),
      "utf-8",
    ).trim().split("\n");
    expect(concatList[0]).toContain("video-segment-0001.mp4");
    expect(concatList[1]).toContain("video-segment-0002.mp4");

    const audioMixCall = calls.find((call) =>
      call.args.includes("-filter_complex") &&
      call.args.some((arg) => arg.endsWith("assembly.audio.m4a"))
    );
    expect(audioMixCall).toBeDefined();
    const filter = audioMixCall!.args[audioMixCall!.args.indexOf("-filter_complex") + 1];
    expect(filter).toContain("adelay=4000|4000");
    expect(filter).toContain("amix=inputs=5:duration=longest:dropout_transition=0:normalize=0[aout]");

    expect(result.outputPath).toBe(path.join(projectDir, "05_timeline", "assembly.mp4"));
    expect(fs.existsSync(result.outputPath)).toBe(true);
  });

  it("keeps legacy clip captions preview-only and rejects them at the production assembly boundary", async () => {
    const projectDir = createTempDemoProject();
    const timelinePath = path.join(projectDir, "05_timeline", "timeline.json");
    const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf-8")) as {
      tracks: { video: Array<{ clips: Array<Record<string, unknown>> }> };
    };
    timeline.tracks.video[0].clips[0].captions = [{
      text: "legacy",
      in_frame: 0,
      out_frame: 24,
      style: "simple-shadow",
    }];
    fs.writeFileSync(timelinePath, JSON.stringify(timeline), "utf-8");
    const calls: Array<{ cmd: string; args: string[] }> = [];

    await expect(assembleTimelineToMp4({
      projectDir,
      timelinePath,
      legacyCaptionMode: "reject",
      execFileImpl: createExecMock(calls),
    })).rejects.toThrow(
      "legacy_clip_captions_forbidden_in_package: clip_ids=CLP_0001",
    );
    expect(calls).toEqual([]);

    await assembleTimelineToMp4({
      projectDir,
      timelinePath,
      legacyCaptionMode: "preview_burn",
      execFileImpl: createExecMock(calls),
    });
    expect(calls.some((call) =>
      call.args.includes("-vf") &&
      call.args.some((arg) => arg.includes("drawtext="))
    )).toBe(true);

    calls.length = 0;
    await assembleTimelineToMp4({
      projectDir,
      timelinePath,
      legacyCaptionMode: "omit",
      execFileImpl: createExecMock(calls),
    });
    expect(calls.some((call) =>
      call.args.includes("-vf") &&
      call.args.some((arg) => arg.includes("drawtext="))
    )).toBe(false);
  });

  it("runs measured dialogue-clean finishing and caps the final mux to timeline duration", async () => {
    const projectDir = createTempDemoProject();
    const timelinePath = path.join(projectDir, "05_timeline", "timeline.json");
    const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf-8")) as {
      metadata?: Record<string, unknown>;
    };
    timeline.metadata = {
      ...(timeline.metadata ?? {}),
      audio_finish: { preset: "dialogue-clean" },
    };
    fs.writeFileSync(timelinePath, JSON.stringify(timeline), "utf-8");

    const calls: Array<{ cmd: string; args: string[] }> = [];
    const execWithMeasurement: ExecFileLike = (cmd, args, _opts, cb) => {
      calls.push({ cmd, args: [...args] });
      const outputPath = args[args.length - 1];
      if (typeof outputPath === "string" && !outputPath.startsWith("-")) {
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, "stub-output", "utf-8");
      }
      const isMeasurement = args.some((arg) => arg.includes("print_format=json"));
      cb(null, "", isMeasurement ? `
        {
          "input_i": "-33.37",
          "input_tp": "-13.77",
          "input_lra": "6.90",
          "input_thresh": "-44.07",
          "target_offset": "-0.27"
        }
      ` : "");
    };

    await assembleTimelineToMp4({
      projectDir,
      cleanupTemp: false,
      workingDirRoot: projectDir,
      execFileImpl: execWithMeasurement,
    });

    const measurementCall = calls.find((call) =>
      call.args.some((arg) => arg.includes("print_format=json"))
    );
    expect(measurementCall).toBeDefined();
    expect(measurementCall!.args.join(" ")).toContain("afftdn=nr=8:nf=-50:tn=1");

    const muxCall = calls.find((call) =>
      call.args.some((arg) => arg.endsWith("assembly.mp4")) &&
      call.args.includes("-c:v") &&
      call.args.includes("copy")
    );
    expect(muxCall).toBeDefined();
    const audioFilter = muxCall!.args[muxCall!.args.indexOf("-af") + 1];
    expect(audioFilter).toContain("measured_I=-33.37");
    expect(audioFilter).toContain("TP=-1.8");
    expect(muxCall!.args).toContain("-shortest");
    expect(muxCall!.args).toContain("-t");
  });

  it("renders BGM clips with loop-to-picture duration and an ending fade", () => {
    const args = buildBgmAudioRenderArgs(
      "/music/theme.mp3",
      "/tmp/bgm.wav",
      0,
      42,
      48_000,
      2,
      24,
      { bgm_fade_out_frames: 48 },
    );

    expect(args).toContain("-stream_loop");
    expect(args).toContain("-1");
    expect(args).toContain("-t");
    expect(args).toContain("42");
    const filter = args[args.indexOf("-af") + 1];
    expect(filter).toContain("afade=t=out:st=40.0000:d=2.0000");
  });

  it("applies clip-level ending fades to source audio and video", () => {
    const audioArgs = buildAudioTrimArgs(
      "/tmp/source.mov",
      "/tmp/audio.wav",
      0,
      6,
      48_000,
      2,
      { fade_out_frames: 48 },
      undefined,
      24,
    );
    expect(audioArgs[audioArgs.indexOf("-af") + 1]).toContain(
      "afade=t=out:st=4.000000:d=2.000000",
    );

    const clip = {
      metadata: {
        ending_treatment: {
          video_fade_color: "white",
          video_fade_out_frames: 36,
        },
      },
    } as unknown as Parameters<typeof extractEndingVideoFade>[0];
    const fade = extractEndingVideoFade(clip, 24);
    const videoArgs = buildVideoTrimArgs(
      "/tmp/source.mov",
      "/tmp/video.mp4",
      0,
      6,
      1920,
      1080,
      24,
      undefined,
      fade,
    );
    expect(videoArgs[videoArgs.indexOf("-vf") + 1]).toContain(
      "fade=t=out:st=4.5:d=1.5:color=white",
    );
  });

  it("normalizes VFR source clips to the authored timeline duration", () => {
    const args = buildVideoTrimArgs(
      "/tmp/source.mov",
      "/tmp/video.mp4",
      14.32,
      53.732249,
      1920,
      1080,
      24,
      undefined,
      undefined,
      946 / 24,
      "24/1",
      946,
    );
    const filter = args[args.indexOf("-vf") + 1];

    expect(filter).toContain("setpts=PTS-STARTPTS,trim=start=14.32:end=53.732249,setpts=PTS-STARTPTS");
    expect(filter).toContain("fps=24/1");
    expect(filter.indexOf("fps=24/1")).toBeLessThan(filter.indexOf("trim=end_frame=946"));
    expect(filter).toContain("tpad=stop_mode=clone:stop_duration=1");
    expect(filter).toContain("trim=end_frame=946");
    expect(args[args.indexOf("-frames:v") + 1]).toBe("946");
  });

  it("masters final audio with loudnorm during mux", () => {
    const args = buildFinalAssemblyMuxArgs(
      "/tmp/video.mp4",
      "/tmp/audio.m4a",
      "/tmp/final.mp4",
    );

    expect(args).toContain("-af");
    expect(args[args.indexOf("-af") + 1]).toBe("loudnorm=I=-16:LRA=11:TP=-1.5");
    expect(args).toContain("-ar");
    expect(args[args.indexOf("-ar") + 1]).toBe("48000");
    expect(args).toContain("-c:a");
    expect(args[args.indexOf("-c:a") + 1]).toBe("aac");
  });

  it("accepts a measured finishing filter and explicit timeline duration", () => {
    const args = buildFinalAssemblyMuxArgs(
      "/tmp/video.mp4",
      "/tmp/audio.m4a",
      "/tmp/final.mp4",
      { audioFilter: "custom-dialogue-filter", durationSec: 12.5 },
    );

    expect(args[args.indexOf("-af") + 1]).toBe("custom-dialogue-filter");
    expect(args[args.indexOf("-t") + 1]).toBe("12.5");
    expect(args).toContain("-shortest");
  });

  it("omits final loudness normalization when original audio explicitly disables it", () => {
    const args = buildFinalAssemblyMuxArgs(
      "/tmp/video.mp4",
      "/tmp/audio.m4a",
      "/tmp/final.mp4",
      { audioFilter: null, durationSec: 12.5 },
    );

    expect(args).not.toContain("-af");
    expect(args).toContain("-c:a");
    expect(args).toContain("-shortest");
  });

  it("preserves original-only audio level through the final mux", async () => {
    const projectDir = createTempDemoProject();
    const timelinePath = path.join(projectDir, "05_timeline", "timeline.json");
    const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf-8")) as {
      provenance?: { audio_policy?: { mode?: string } };
      tracks: { audio: Array<{ clips: Array<{ audio_policy?: Record<string, unknown> }> }> };
    };
    timeline.provenance = {
      ...(timeline.provenance ?? {}),
      audio_policy: { mode: "original_only" },
    };
    for (const track of timeline.tracks.audio) {
      for (const clip of track.clips) {
        clip.audio_policy = { ...(clip.audio_policy ?? {}), a1_loudnorm: false };
      }
    }
    fs.writeFileSync(timelinePath, JSON.stringify(timeline), "utf-8");

    const calls: Array<{ cmd: string; args: string[] }> = [];
    await assembleTimelineToMp4({
      projectDir,
      cleanupTemp: false,
      workingDirRoot: projectDir,
      execFileImpl: createExecMock(calls),
    });

    const muxCall = calls.find((call) =>
      call.args.some((arg) => arg.endsWith("assembly.mp4")) &&
      call.args.includes("-c:v") &&
      call.args.includes("copy")
    );
    expect(muxCall).toBeDefined();
    expect(muxCall!.args).not.toContain("-af");
  });

  it("throws a clear error when ffmpeg is not available", async () => {
    const projectDir = createTempDemoProject();
    const execMissing: ExecFileLike = (_cmd, _args, _opts, cb) => {
      const err = new Error("spawn ffmpeg ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      cb(err);
    };

    await expect(
      assembleTimelineToMp4({
        projectDir,
        execFileImpl: execMissing,
      }),
    ).rejects.toThrow("ffmpeg is not installed or not available on PATH");
  });
});
