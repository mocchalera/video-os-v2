import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ingestAsset } from "../runtime/connectors/ffprobe.js";
import { assembleTimelineToMp4, buildStillVideoFilter } from "../runtime/render/assembler.js";
import { renderPreviewSegment } from "../runtime/preview/segment-renderer.js";
import { loadSourceMap } from "../runtime/media/source-map.js";
import { renderRoughCut } from "../scripts/render-rough-cut.js";
import { ensureFreshAssembly } from "../scripts/package.js";
import { runRenderPipeline } from "../runtime/render/pipeline.js";
import { finishPromoCut } from "../runtime/render/promo-finisher.js";
import { evaluateReviewVisualQA } from "../runtime/review/visual-qa.js";
import {
  assessRenderArtifactFreshness,
  writeRenderFreshnessMetadata,
} from "../runtime/render/source-input-attestation.js";
import { renderRemotionAssembly } from "../runtime/render/remotion/render-remotion.js";
import { produceAssembly } from "../runtime/render/assembly-orchestrator.js";

const dirs: string[] = [];
function probeHeicRoundTrip(): boolean {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-heic-codec-probe-"));
  try {
    const candidate = path.join(probeDir, "probe.heic");
    execFileSync("ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=16x16",
      "-frames:v", "1", "-y", candidate,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const decoded = execFileSync("ffprobe", [
      "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_type",
      "-of", "csv=p=0", candidate,
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    return decoded === "video";
  } catch {
    return false;
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
}
const heicAvailable = probeHeicRoundTrip();
const runRemotion = process.env.VOS_REMOTION_RENDER === "1";
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function ffmpeg(args: string[]): Buffer {
  return execFileSync("ffmpeg", ["-v", "error", ...args], { maxBuffer: 100 * 1024 * 1024 });
}

function makeTimeline(assetId: string, frames: number, fpsNum: number, fpsDen: number, fit: "contain" | "cover", background: string) {
  return {
    version: "1", project_id: "still-e2e", created_at: "2026-07-20T00:00:00Z",
    sequence: { name: "still", fps_num: fpsNum, fps_den: fpsDen, width: 64, height: 64, start_frame: 0, letterbox_policy: "none" },
    tracks: { video: [{ track_id: "V1", kind: "video", clips: [{
      clip_id: "CLP_IMG", segment_id: "SEG_IMG", asset_id: assetId,
      media_kind: "image", src_in_us: 0, src_out_us: 1, timeline_in_frame: 0,
      timeline_duration_frames: frames, role: "hero", motivation: "still", beat_id: "b01",
      fallback_segment_ids: [], confidence: 1, quality_flags: [],
      still_image: { hold_frames: frames, min_hold_frames: 1, max_hold_frames: frames, hold_source: "global_default", policy_clamp: "none", motion_mode: "static", fit_mode: fit, background },
    }] }], audio: [] }, markers: [],
    provenance: { brief_path: "", blueprint_path: "", selects_path: "", compiler_version: "test" },
  };
}

async function makeStillProject(ext: "png" | "jpg" | "heic" = "png") {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-still-render-e2e-"));
  dirs.push(projectDir);
  const sourcePath = path.join(projectDir, `source.${ext}`);
  ffmpeg(["-f", "lavfi", "-i", "color=c=red:s=64x32", "-frames:v", "1", "-y", sourcePath]);
  const asset = await ingestAsset(sourcePath, { projectRoot: projectDir, mediaKind: "image", ffmpegVersion: "test" });
  fs.mkdirSync(path.join(projectDir, "02_media"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "02_media/source_map.json"), JSON.stringify({
    version: "1", project_id: "still-e2e", media_dir: "02_media", generated_at: "2026-07-20T00:00:00Z",
    items: [{
      asset_id: asset.asset_id, source_locator: sourcePath, local_source_path: sourcePath,
      link_path: path.basename(sourcePath), media_kind: "image", source_content_sha256: asset.source_content_sha256,
    }],
  }));
  fs.mkdirSync(path.join(projectDir, "03_analysis"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "03_analysis/assets.json"), JSON.stringify({ items: [asset] }));
  fs.mkdirSync(path.join(projectDir, "05_timeline"), { recursive: true });
  return { projectDir, sourcePath, asset };
}

function probe(output: string): Array<Record<string, unknown>> {
  return JSON.parse(execFileSync("ffprobe", [
    "-v", "error", "-count_frames", "-show_entries", "stream=codec_type,nb_read_frames,duration,pix_fmt", "-of", "json", output,
  ], { encoding: "utf8" })).streams;
}

function decodedFrameHashes(output: string): string[] {
  const text = execFileSync("ffmpeg", ["-v", "error", "-i", output, "-map", "0:v:0", "-f", "framemd5", "-"], { encoding: "utf8" });
  return text.split("\n").filter((line) => line && !line.startsWith("#")).map((line) => line.split(",").at(-1)!.trim());
}

function cornerPixel(output: string): string {
  return ffmpeg(["-i", output, "-vf", "format=rgb24,crop=1:1:0:0", "-frames:v", "1", "-f", "rawvideo", "-"]).toString("hex");
}

function pixelChannels(pixel: string): number[] {
  return [0, 2, 4].map((offset) => Number.parseInt(pixel.slice(offset, offset + 2), 16));
}

function expectPixelsClose(actual: string, expected: string, tolerance: number): void {
  const actualChannels = pixelChannels(actual);
  const expectedChannels = pixelChannels(expected);
  actualChannels.forEach((channel, index) => {
    expect(Math.abs(channel - expectedChannels[index])).toBeLessThanOrEqual(tolerance);
  });
}

describe("EYE-070C2B truthful still rendering real media", () => {
  it.skipIf(!heicAvailable)("renders a probed-decodable HEIC through C1 normalization", async () => {
    const fixture = await makeStillProject("heic");
    expect(fixture.asset.still_image?.normalized_frame_path).toMatch(/frame_0\.png$/);
  });

  it("builds deterministic background/alpha/pixfmt filters for every supported token", () => {
    for (const color of ["black", "white", "transparent", "#112233", "#11223344"]) {
      const first = buildStillVideoFilter(1920, 1080, "contain", color);
      expect(buildStillVideoFilter(1920, 1080, "contain", color)).toBe(first);
      expect(first).toContain("format=rgba");
      expect(first).toContain("format=yuv420p");
    }
    expect(buildStillVideoFilter(1920, 1080, "contain", "transparent")).toContain("color=black@0");
    expect(buildStillVideoFilter(1920, 1080, "cover", "#11223344")).toContain("crop=1920:1080");
  });

  it("renders deterministic transparent, hex, and alpha-hex background pixels and hashes", async () => {
    const fixture = await makeStillProject("png");
    const timelinePath = path.join(fixture.projectDir, "05_timeline/timeline.json");
    const evidence = new Map<string, { pixel: string; hash: string }>();
    for (const background of ["transparent", "#112233", "#11223344"]) {
      let previous: { pixel: string; hash: string } | undefined;
      for (let iteration = 0; iteration < 2; iteration += 1) {
        fs.writeFileSync(timelinePath, JSON.stringify(
          makeTimeline(fixture.asset.asset_id, 4, 24, 1, "contain", background),
        ));
        const output = path.join(
          fixture.projectDir,
          "05_timeline",
          `background-${background.replace(/[^a-z0-9]/gi, "")}-${iteration}.mp4`,
        );
        await assembleTimelineToMp4({ projectDir: fixture.projectDir, timelinePath, outputPath: output });
        expect(probe(output)[0]).toMatchObject({ codec_type: "video", pix_fmt: "yuv420p" });
        const current = { pixel: cornerPixel(output), hash: decodedFrameHashes(output)[0] };
        if (previous) expect(current).toEqual(previous);
        previous = current;
      }
      evidence.set(background, previous!);
    }
    expect(evidence.get("transparent")?.pixel).not.toBe(evidence.get("#112233")?.pixel);
    expect(evidence.get("transparent")?.hash).not.toBe(evidence.get("#11223344")?.hash);
  }, 30_000);

  it.each([
    [24, 1, 37],
    [30000, 1001, 41],
  ])("renders exact static normalized holds at %s/%s", async (fpsNum, fpsDen, frames) => {
    const fixture = await makeStillProject("png");
    const timelinePath = path.join(fixture.projectDir, "05_timeline/timeline.json");
    fs.writeFileSync(timelinePath, JSON.stringify(makeTimeline(fixture.asset.asset_id, frames, fpsNum, fpsDen, "contain", "white")));
    const output = path.join(fixture.projectDir, "05_timeline/assembly.mp4");
    await assembleTimelineToMp4({ projectDir: fixture.projectDir, timelinePath, outputPath: output });
    const streams = probe(output);
    expect(streams.map((stream) => stream.codec_type)).toEqual(["video"]);
    expect(Number(streams[0].nb_read_frames)).toBe(frames);
    const hashes = decodedFrameHashes(output);
    expect(hashes).toHaveLength(frames);
    expect(new Set(hashes).size).toBe(1);
    if (fpsDen !== 1) {
      const routed = await produceAssembly({
        timelinePath,
        sourceMap: { [fixture.asset.asset_id]: fixture.sourcePath },
        outputPath: path.join(fixture.projectDir, "05_timeline/rational-routed.mp4"),
        engine: "remotion",
      });
      expect(routed.engine).toBe("ffmpeg");
    }
  }, 30_000);

  it("uses normalized JPEG input and produces deterministic contain/background vs cover pixels", async () => {
    const fixture = await makeStillProject("jpg");
    const timelinePath = path.join(fixture.projectDir, "05_timeline/timeline.json");
    const contain = path.join(fixture.projectDir, "05_timeline/contain.mp4");
    const cover = path.join(fixture.projectDir, "05_timeline/cover.mp4");
    fs.writeFileSync(timelinePath, JSON.stringify(makeTimeline(fixture.asset.asset_id, 12, 24, 1, "contain", "white")));
    await assembleTimelineToMp4({ projectDir: fixture.projectDir, timelinePath, outputPath: contain, sourceOverrides: { [fixture.asset.asset_id]: fixture.sourcePath } });
    fs.writeFileSync(timelinePath, JSON.stringify(makeTimeline(fixture.asset.asset_id, 12, 24, 1, "cover", "black")));
    await assembleTimelineToMp4({ projectDir: fixture.projectDir, timelinePath, outputPath: cover, sourceOverrides: { [fixture.asset.asset_id]: fixture.sourcePath } });
    expect(cornerPixel(contain)).not.toBe(cornerPixel(cover));
    expect(decodedFrameHashes(contain)[0]).not.toBe(decodedFrameHashes(cover)[0]);
  }, 30_000);

  it("removes a completed output when the normalized frame changes during render", async () => {
    const fixture = await makeStillProject("png");
    const timelinePath = path.join(fixture.projectDir, "05_timeline/timeline.json");
    fs.writeFileSync(timelinePath, JSON.stringify(makeTimeline(fixture.asset.asset_id, 8, 24, 1, "contain", "black")));
    const output = path.join(fixture.projectDir, "05_timeline/mutated.mp4");
    const normalized = path.join(fixture.projectDir, "03_analysis", fixture.asset.still_image!.normalized_frame_path);
    let mutated = false;
    const execFileImpl = ((file: string, args: readonly string[], options: { maxBuffer?: number }, callback: any) => {
      execFile(file, [...args], options, (error, stdout, stderr) => {
        if (!error && !mutated) {
          mutated = true;
          fs.writeFileSync(normalized, "changed-after-render");
        }
        callback(error, stdout, stderr);
      });
    }) as never;
    await expect(assembleTimelineToMp4({
      projectDir: fixture.projectDir, timelinePath, outputPath: output, execFileImpl,
    })).rejects.toThrow("still_image_normalized_hash_mismatch");
    expect(fs.existsSync(output)).toBe(false);
  }, 30_000);

  it("removes a completed output when the verified original still changes during render", async () => {
    const fixture = await makeStillProject("png");
    const timelinePath = path.join(fixture.projectDir, "05_timeline/timeline.json");
    fs.writeFileSync(timelinePath, JSON.stringify(makeTimeline(fixture.asset.asset_id, 8, 24, 1, "contain", "black")));
    const output = path.join(fixture.projectDir, "05_timeline/original-mutated.mp4");
    let mutated = false;
    const execFileImpl = ((file: string, args: readonly string[], options: { maxBuffer?: number }, callback: any) => {
      execFile(file, [...args], options, (error, stdout, stderr) => {
        if (!error && !mutated) {
          mutated = true;
          fs.writeFileSync(fixture.sourcePath, "changed-original-after-render");
        }
        callback(error, stdout, stderr);
      });
    }) as never;
    await expect(assembleTimelineToMp4({
      projectDir: fixture.projectDir, timelinePath, outputPath: output, execFileImpl,
    })).rejects.toThrow("still_image_original_hash_mismatch");
    expect(fs.existsSync(output)).toBe(false);
  }, 30_000);

  it.each(["replacement", "symlink"] as const)(
    "renders verified snapshot pixels through a post-copy normalized-frame %s and cleans the snapshot",
    async (exchange) => {
      const fixture = await makeStillProject("png");
      const timelinePath = path.join(fixture.projectDir, "05_timeline/timeline.json");
      fs.writeFileSync(timelinePath, JSON.stringify(
        makeTimeline(fixture.asset.asset_id, 8, 24, 1, "cover", "black"),
      ));
      const output = path.join(fixture.projectDir, "05_timeline", `snapshot-${exchange}.mp4`);
      const normalized = path.join(
        fixture.projectDir,
        "03_analysis",
        fixture.asset.still_image!.normalized_frame_path,
      );
      const verifiedBytes = fs.readFileSync(normalized);
      const forgedFrame = path.join(fixture.projectDir, "forged-blue.png");
      ffmpeg(["-f", "lavfi", "-i", "color=c=blue:s=64x32", "-frames:v", "1", "-y", forgedFrame]);
      let exchanged = false;
      let snapshotPath = "";
      const execFileImpl = ((file: string, args: readonly string[], options: { maxBuffer?: number }, callback: any) => {
        const rendererSnapshot = args.find((arg) => arg.includes("vos-still-render-inputs-"));
        if (!exchanged && rendererSnapshot) {
          exchanged = true;
          snapshotPath = rendererSnapshot;
          expect(rendererSnapshot).not.toBe(normalized);
          expect(fs.readFileSync(rendererSnapshot)).toEqual(verifiedBytes);
          if (exchange === "replacement") {
            fs.copyFileSync(forgedFrame, normalized);
          } else {
            fs.rmSync(normalized);
            fs.symlinkSync(forgedFrame, normalized);
          }
        }
        execFile(file, [...args], options, (error, stdout, stderr) => {
          if (rendererSnapshot) {
            fs.rmSync(normalized, { force: true });
            fs.writeFileSync(normalized, verifiedBytes);
          }
          callback(error, stdout, stderr);
        });
      }) as never;
      await assembleTimelineToMp4({
        projectDir: fixture.projectDir,
        timelinePath,
        outputPath: output,
        execFileImpl,
      });
      expect(exchanged).toBe(true);
      expect(fs.existsSync(snapshotPath)).toBe(false);
      expectPixelsClose(cornerPixel(output), "fe0000", 20);
    },
    30_000,
  );

  it("canonical preview opens a verified snapshot and disposes it", async () => {
    const fixture = await makeStillProject("png");
    const timelinePath = path.join(fixture.projectDir, "05_timeline/timeline.json");
    fs.writeFileSync(timelinePath, JSON.stringify(
      makeTimeline(fixture.asset.asset_id, 8, 24, 1, "cover", "black"),
    ));
    const normalized = path.join(
      fixture.projectDir,
      "03_analysis",
      fixture.asset.still_image!.normalized_frame_path,
    );
    const verifiedBytes = fs.readFileSync(normalized);
    const forgedFrame = path.join(fixture.projectDir, "preview-forged-blue.png");
    ffmpeg(["-f", "lavfi", "-i", "color=c=blue:s=64x32", "-frames:v", "1", "-y", forgedFrame]);
    let snapshotPath = "";
    const previewExec = ((file: string, args: readonly string[], options: { maxBuffer?: number }, callback: any) => {
      const snapshot = args.find((arg) => arg.includes("vos-still-render-inputs-"));
      if (snapshot && !snapshotPath) {
        snapshotPath = snapshot;
        fs.copyFileSync(forgedFrame, normalized);
      }
      execFile(file, [...args], options, (error, stdout, stderr) => {
        if (snapshot) fs.writeFileSync(normalized, verifiedBytes);
        callback(error, stdout, stderr);
      });
    }) as never;
    const preview = await renderPreviewSegment({
      projectDir: fixture.projectDir,
      timelinePath,
      sourceMap: loadSourceMap(fixture.projectDir),
      outputPath: path.join(fixture.projectDir, "05_timeline/snapshot-preview.mp4"),
      execFileImpl: previewExec,
    });
    expect(snapshotPath).toContain("vos-still-render-inputs-");
    expect(fs.existsSync(snapshotPath)).toBe(false);
    expectPixelsClose(cornerPixel(preview.outputPath), "fe0000", 20);
  }, 30_000);

  it("disposes the verified snapshot when renderer execution fails", async () => {
    const fixture = await makeStillProject("png");
    const timelinePath = path.join(fixture.projectDir, "05_timeline/timeline.json");
    fs.writeFileSync(timelinePath, JSON.stringify(
      makeTimeline(fixture.asset.asset_id, 8, 24, 1, "cover", "black"),
    ));
    let snapshotPath = "";
    const failingExec = ((_file: string, args: readonly string[], _options: { maxBuffer?: number }, callback: any) => {
      snapshotPath = args.find((arg) => arg.includes("vos-still-render-inputs-")) ?? snapshotPath;
      callback(new Error("intentional renderer failure"));
    }) as never;
    await expect(assembleTimelineToMp4({
      projectDir: fixture.projectDir,
      timelinePath,
      outputPath: path.join(fixture.projectDir, "05_timeline/failed.mp4"),
      execFileImpl: failingExec,
    })).rejects.toThrow("intentional renderer failure");
    expect(snapshotPath).toContain("vos-still-render-inputs-");
    expect(fs.existsSync(snapshotPath)).toBe(false);
  });

  it("renders mixed normalized image + video + explicit audio with transition and caption", async () => {
    const fixture = await makeStillProject("png");
    const video = path.join(fixture.projectDir, "video.mp4");
    ffmpeg(["-f", "lavfi", "-i", "color=c=blue:s=64x64:r=24:d=1", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-y", video]);
    const videoId = "AST_VIDEO";
    const sourceMapPath = path.join(fixture.projectDir, "02_media/source_map.json");
    const sourceMap = JSON.parse(fs.readFileSync(sourceMapPath, "utf8"));
    sourceMap.items.push({ asset_id: videoId, source_locator: video, local_source_path: video, link_path: "video.mp4", media_kind: "video" });
    fs.writeFileSync(sourceMapPath, JSON.stringify(sourceMap));
    const timeline = makeTimeline(fixture.asset.asset_id, 24, 24, 1, "contain", "black") as any;
    const imageClip = timeline.tracks.video[0].clips[0];
    imageClip.timeline_in_frame = 20;
    imageClip.captions = [{ in_frame: 21, out_frame: 30, text: "still", style: "simple-shadow" }];
    const videoClip = { ...imageClip, clip_id: "CLP_VIDEO", segment_id: "SEG_VIDEO", asset_id: videoId, media_kind: "video", src_out_us: 1_000_000, timeline_in_frame: 0, timeline_duration_frames: 24 };
    delete videoClip.still_image;
    delete videoClip.captions;
    timeline.tracks.video[0].clips.unshift(videoClip);
    timeline.tracks.audio = [{ track_id: "A1", kind: "audio", clips: [{ ...videoClip, clip_id: "AUD_VIDEO" }] }];
    timeline.transitions = [{ transition_id: "TR_1", from_clip_id: "CLP_VIDEO", to_clip_id: "CLP_IMG", transition_type: "crossfade", transition_frames: 4 }];
    const timelinePath = path.join(fixture.projectDir, "05_timeline/timeline.json");
    fs.writeFileSync(timelinePath, JSON.stringify(timeline));
    const output = path.join(fixture.projectDir, "05_timeline/mixed.mp4");
    const transitionSnapshotPaths = new Set<string>();
    const transitionExec = ((file: string, args: readonly string[], options: { maxBuffer?: number }, callback: any) => {
      for (const arg of args) if (arg.includes("vos-still-render-inputs-")) transitionSnapshotPaths.add(arg);
      execFile(file, [...args], options, callback);
    }) as never;
    await assembleTimelineToMp4({
      projectDir: fixture.projectDir,
      timelinePath,
      outputPath: output,
      execFileImpl: transitionExec,
    });
    expect(transitionSnapshotPaths.size).toBeGreaterThan(0);
    expect([...transitionSnapshotPaths].every((snapshot) => !fs.existsSync(snapshot))).toBe(true);
    const streams = probe(output);
    expect(streams.map((stream) => stream.codec_type).sort()).toEqual(["audio", "video"]);
    expect(Number(streams.find((stream) => stream.codec_type === "video")?.nb_read_frames)).toBe(44);

    const directRemotion = path.join(fixture.projectDir, "05_timeline/mixed-direct-remotion.mp4");
    await expect(renderRemotionAssembly({
      timelinePath,
      sourceMap: { [fixture.asset.asset_id]: fixture.sourcePath, [videoId]: video },
      outputPath: directRemotion,
    })).rejects.toThrow("remotion_explicit_audio_unsupported_for_still");
    expect(fs.existsSync(directRemotion)).toBe(false);

    const routedMixed = await produceAssembly({
      timelinePath,
      sourceMap: { [fixture.asset.asset_id]: fixture.sourcePath, [videoId]: video },
      outputPath: path.join(fixture.projectDir, "05_timeline/mixed-remotion-request.mp4"),
      engine: "remotion",
    });
    expect(routedMixed.engine).toBe("ffmpeg");
    expect(probe(routedMixed.assemblyPath).map((stream) => stream.codec_type).sort()).toEqual(["audio", "video"]);

    timeline.tracks.audio = [];
    fs.writeFileSync(timelinePath, JSON.stringify(timeline));
    const mixedDefaultNoAudio = path.join(fixture.projectDir, "05_timeline/mixed-default-no-audio.mp4");
    await assembleTimelineToMp4({
      projectDir: fixture.projectDir,
      timelinePath,
      outputPath: mixedDefaultNoAudio,
    });
    expect(probe(mixedDefaultNoAudio).map((stream) => stream.codec_type)).toEqual(["video"]);

    const videoOnly = path.join(fixture.projectDir, "05_timeline/mixed-video-only.mp4");
    const videoOnlyResult = await assembleTimelineToMp4({
      projectDir: fixture.projectDir, timelinePath, outputPath: videoOnly, includeAudio: false,
    });
    expect(videoOnlyResult.audioClipCount).toBe(0);
    expect(probe(videoOnly).map((stream) => stream.codec_type)).toEqual(["video"]);

    const rough = await renderRoughCut({ projectPath: fixture.projectDir, noAudio: true });
    expect(rough.clipCount).toBe(2);
    expect(rough.xfadeCount).toBe(1);
    expect(rough.durationAccounting).toMatchObject({
      timeline_span_sec: 1.833,
      timeline_content_sec: 2,
      gap_sec: 0,
      gap_count: 0,
      crossfade_overlap_sec: 0.167,
      source_clamp_sec: 0,
      expected_rendered_sec: 1.833,
      actual_rendered_sec: 1.833,
      parity_pass: true,
    });
  }, 30_000);

  it("runs canonical preview, rough-cut, pipeline, package assembly, promo, and visual-QA entries without fabricated audio", async () => {
    const fixture = await makeStillProject("png");
    const timelinePath = path.join(fixture.projectDir, "05_timeline/timeline.json");
    const timeline = makeTimeline(fixture.asset.asset_id, 12, 24, 1, "contain", "white") as any;
    timeline.tracks.video[0].clips[0].still_image.requested_motion_mode = "subtle_ken_burns";
    timeline.tracks.video[0].clips[0].still_image.motion_status = "pending_EYE-070C2B";
    fs.writeFileSync(timelinePath, JSON.stringify(timeline));

    const preview = await renderPreviewSegment({
      projectDir: fixture.projectDir, timelinePath, sourceMap: loadSourceMap(fixture.projectDir),
      outputPath: path.join(fixture.projectDir, "05_timeline/preview.mp4"),
    });
    expect(probe(preview.outputPath).map((stream) => stream.codec_type)).toEqual(["video"]);

    const rough = await renderRoughCut({ projectPath: fixture.projectDir, noAudio: false });
    expect(probe(rough.outputPath).map((stream) => stream.codec_type)).toEqual(["video"]);
    expect(JSON.parse(fs.readFileSync(timelinePath, "utf8")).tracks.video[0].clips[0].still_image)
      .toMatchObject({ motion_mode: "static", requested_motion_mode: "subtle_ken_burns", motion_status: "pending_EYE-070C2B" });

    const assembly = path.join(fixture.projectDir, "05_timeline/assembly.mp4");
    await assembleTimelineToMp4({ projectDir: fixture.projectDir, timelinePath, outputPath: assembly });
    writeRenderFreshnessMetadata(fixture.projectDir, assembly);
    expect((await ensureFreshAssembly(fixture.projectDir)).action).toBe("reused");

    const pipeline = await runRenderPipeline({
      projectDir: fixture.projectDir, timelinePath, assemblyPath: assembly,
      outputDir: path.join(fixture.projectDir, "07_package"), fps: 24,
      captionPolicy: { language: "ja", delivery_mode: "burn_in", source: "none", styling_class: "clean-lower-third" },
    });
    expect(pipeline.rawDialoguePath).toBe("");
    expect(pipeline.finalMixPath).toBe("");
    expect(pipeline.audioMixReportPath).toBe("");
    expect(probe(pipeline.finalVideoPath).map((stream) => stream.codec_type)).toEqual(["video"]);

    const promo = await finishPromoCut({ projectDir: fixture.projectDir, endingTailSec: 0, subtitles: true });
    expect(probe(promo.outputPath).map((stream) => stream.codec_type)).toEqual(["video"]);

    const visual = await evaluateReviewVisualQA(fixture.projectDir, { render: true });
    expect(visual.reason).toBe("creative_brief_missing");
    expect(fs.existsSync(path.join(fixture.projectDir, "09_output/rough-cut.mp4"))).toBe(true);
  }, 60_000);

  it.skipIf(!runRemotion)("matches integer-FPS Remotion Img holds to FFmpeg fit/background/static semantics", async () => {
    const fixture = await makeStillProject("png");
    const timelinePath = path.join(fixture.projectDir, "05_timeline/timeline.json");
    fs.writeFileSync(timelinePath, JSON.stringify(makeTimeline(fixture.asset.asset_id, 12, 24, 1, "contain", "white")));
    const ffmpegContain = path.join(fixture.projectDir, "05_timeline/ffmpeg-contain.mp4");
    const remotionContain = path.join(fixture.projectDir, "05_timeline/remotion-contain.mp4");
    await assembleTimelineToMp4({ projectDir: fixture.projectDir, timelinePath, outputPath: ffmpegContain });
    const normalized = path.join(
      fixture.projectDir,
      "03_analysis",
      fixture.asset.still_image!.normalized_frame_path,
    );
    const verifiedBytes = fs.readFileSync(normalized);
    const remotionForgedFrame = path.join(fixture.projectDir, "remotion-forged-blue.png");
    ffmpeg(["-f", "lavfi", "-i", "color=c=blue:s=64x32", "-frames:v", "1", "-y", remotionForgedFrame]);
    let remotionSnapshotPath = "";
    await renderRemotionAssembly({
      timelinePath,
      sourceMap: { [fixture.asset.asset_id]: fixture.sourcePath },
      outputPath: remotionContain,
      onStageSourceForTest: (phase, source) => {
        if (phase === "before" && source.includes("vos-still-render-inputs-")) {
          remotionSnapshotPath = source;
          fs.copyFileSync(remotionForgedFrame, normalized);
        }
        if (phase === "after" && source.includes("vos-still-render-inputs-")) {
          fs.writeFileSync(normalized, verifiedBytes);
        }
      },
    });
    expect(remotionSnapshotPath).toContain("vos-still-render-inputs-");
    expect(fs.existsSync(remotionSnapshotPath)).toBe(false);
    const validCache = await renderRemotionAssembly({
      timelinePath,
      sourceMap: { [fixture.asset.asset_id]: fixture.sourcePath },
      outputPath: remotionContain,
    });
    expect(validCache.assemblyCacheHit).toBe(true);
    const cacheReceiptPath = `${remotionContain}.remotion-cache.json`;
    expect(JSON.parse(fs.readFileSync(cacheReceiptPath, "utf8"))).toMatchObject({
      version: "remotion-assembly-cache/v2",
      output: { sizeBytes: fs.statSync(remotionContain).size },
    });
    const forgedBytes = Buffer.alloc(fs.statSync(remotionContain).size, 0x46);
    const forgedHash = createHash("sha256").update(forgedBytes).digest("hex");
    fs.writeFileSync(remotionContain, forgedBytes);
    const recovered = await produceAssembly({
      timelinePath,
      sourceMap: { [fixture.asset.asset_id]: fixture.sourcePath },
      outputPath: remotionContain,
      engine: "remotion",
    });
    expect(recovered.engine).toBe("remotion");
    expect(createHash("sha256").update(fs.readFileSync(remotionContain)).digest("hex")).not.toBe(forgedHash);
    expect(assessRenderArtifactFreshness(fixture.projectDir, remotionContain).status).toBe("fresh");
    for (const output of [ffmpegContain, remotionContain]) {
      expect(Number(probe(output)[0].nb_read_frames)).toBe(12);
      expect(probe(output).map((stream) => stream.codec_type)).toEqual(["video"]);
      expect(new Set(decodedFrameHashes(output)).size).toBe(1);
    }
    expectPixelsClose(cornerPixel(remotionContain), cornerPixel(ffmpegContain), 12);

    fs.writeFileSync(timelinePath, JSON.stringify(makeTimeline(fixture.asset.asset_id, 12, 24, 1, "cover", "#112233")));
    const ffmpegCover = path.join(fixture.projectDir, "05_timeline/ffmpeg-cover.mp4");
    const remotionCover = path.join(fixture.projectDir, "05_timeline/remotion-cover.mp4");
    await assembleTimelineToMp4({ projectDir: fixture.projectDir, timelinePath, outputPath: ffmpegCover });
    await renderRemotionAssembly({
      timelinePath,
      sourceMap: { [fixture.asset.asset_id]: fixture.sourcePath },
      outputPath: remotionCover,
    });
    expectPixelsClose(cornerPixel(remotionCover), cornerPixel(ffmpegCover), 12);
    for (const output of [ffmpegCover, remotionCover]) {
      expect(Number(probe(output)[0].nb_read_frames)).toBe(12);
      expect(new Set(decodedFrameHashes(output)).size).toBe(1);
      expectPixelsClose(cornerPixel(output), "fe0000", 20);
    }
  }, 60_000);
});
