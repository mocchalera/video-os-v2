import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildRenderSpec } from "../../shared/render-spec.js";
import {
  buildAdditionalTimelineAudioMixArgs,
  isMirroredTimelineAudioClip,
  previewBgmFadeOutStartSec,
  timelineOwnsBgmAsset,
  PreviewJobService,
  type PreviewJobState,
} from "../../server/services/preview-job-service.js";
import type { RenderAudioClip, RenderVideoClip } from "../../shared/render-spec.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function available(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const ffIt = available() ? it : it.skip;

function timeline() {
  return {
    sequence: { fps_num: 24, fps_den: 1, width: 320, height: 180, sample_rate: 48_000 },
    tracks: {
      video: [{ track_id: "V1", kind: "video", clips: [] }],
      audio: [{
        track_id: "A3",
        kind: "audio",
        clips: [{
          clip_id: "ACL_001",
          asset_id: "AST_AUDIO",
          role: "ambient",
          src_in_us: 0,
          src_out_us: 1_000_000,
          timeline_in_frame: 0,
          timeline_duration_frames: 24,
          audio_policy: { nat_gain: 0.5, fade_in_frames: 2, fade_out_frames: 2 },
        }],
      }],
      caption: [{
        track_id: "C1",
        kind: "caption",
        clips: [{
          clip_id: "CAP_001",
          asset_id: "AST_AUDIO",
          src_in_us: 0,
          src_out_us: 1_000_000,
          timeline_in_frame: 0,
          timeline_duration_frames: 24,
          metadata: { text: "audio caption" },
        }],
      }],
    },
  };
}

ffIt("renders exact audio-only preview on a black canvas with audio and captions", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vos-audio-preview-"));
  tempDirs.push(root);
  const projectId = "audio-preview";
  const projectDir = path.join(root, projectId);
  fs.mkdirSync(path.join(projectDir, "05_timeline/previews"), { recursive: true });
  const wav = path.join(projectDir, "voice.wav");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=660:duration=1", wav]);
  const spec = buildRenderSpec(
    timeline() as Parameters<typeof buildRenderSpec>[0],
    "audio-rev-1",
    () => wav,
  );

  const outputPath = await new Promise<string>((resolve, reject) => {
    const service = new PreviewJobService((id, state: PreviewJobState) => {
      if (id !== projectId) return;
      if (state.status === "ready") {
        resolve(path.join(projectDir, "05_timeline/previews", state.previewUrl!.split("/").pop()!));
      } else if (state.status === "error") {
        reject(new Error(state.error ?? "preview failed"));
      }
    }, root);
    service.request(projectId, projectDir, spec);
  });

  const streams = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", outputPath], { encoding: "utf-8" });
  expect(streams).toContain("video");
  expect(streams).toContain("audio");
  const volume = spawnSync("ffmpeg", ["-hide_banner", "-i", outputPath, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf-8" });
  expect(volume.status).toBe(0);
  const meanVolume = /mean_volume:\s*(-?[\d.]+) dB/.exec(volume.stderr);
  expect(meanVolume).not.toBeNull();
  expect(Number(meanVolume?.[1])).toBeGreaterThan(-50);
  const captionFrame = spawnSync("ffmpeg", ["-hide_banner", "-ss", "0.5", "-i", outputPath, "-frames:v", "1", "-vf", "signalstats,metadata=print:file=-", "-f", "null", "-"], { encoding: "utf-8" });
  expect(captionFrame.status).toBe(0);
  const ymax = /lavfi\.signalstats\.YMAX=([\d.]+)/.exec(`${captionFrame.stdout}\n${captionFrame.stderr}`);
  expect(ymax).not.toBeNull();
  expect(Number(ymax?.[1])).toBeGreaterThan(100);
  expect(fs.readFileSync(path.join(projectDir, "05_timeline/previews/preview.json"), "utf-8")).toContain('"status": "ready"');
});

describe("audio preview source failures", () => {
  it("reports unresolved audio sources as an error instead of a ready preview", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vos-audio-preview-missing-"));
    tempDirs.push(root);
    const projectId = "audio-preview-missing";
    const projectDir = path.join(root, projectId);
    fs.mkdirSync(path.join(projectDir, "05_timeline/previews"), { recursive: true });
    const spec = buildRenderSpec(
      timeline() as Parameters<typeof buildRenderSpec>[0],
      "audio-rev-missing",
      () => undefined,
    );
    const state = await new Promise<PreviewJobState>((resolve) => {
      const service = new PreviewJobService((id, next) => {
        if (id === projectId && next.status === "error") resolve(next);
      }, root);
      service.request(projectId, projectDir, spec);
    });
    expect(state.error).toContain("unresolved required sources");
    expect(state.previewUrl).toBeNull();
  });
});

describe("audio preview parity contract", () => {
  const baseAudio: RenderAudioClip = {
    clipId: "A1",
    assetId: "AST_SHARED",
    sourcePath: "/tmp/shared.wav",
    trackId: "A1",
    role: "dialogue",
    timelineInFrame: 0,
    durationFrames: 48,
    sourceInSec: 1,
    sourceOutSec: 3,
    gainDb: 20 * Math.log10(1.8),
    gainLinear: 1.8,
    gainProvenance: "explicit_linear",
    fadeInFrames: 3,
    fadeOutFrames: 6,
  };

  it("requires source range identity before dropping mirrored source audio", () => {
    const video = {
      assetId: "AST_SHARED",
      timelineInFrame: 0,
      durationFrames: 48,
      sourceInSec: 0,
      sourceOutSec: 2,
    } as RenderVideoClip;
    expect(isMirroredTimelineAudioClip(baseAudio, [video])).toBe(false);
    expect(isMirroredTimelineAudioClip(
      { ...baseAudio, sourceInSec: 0, sourceOutSec: 2 },
      [video],
    )).toBe(true);
  });

  it("uses canonical linear gain, authored fades, and assembler-equivalent A1 sidechain ducking for A2", () => {
    const args = buildAdditionalTimelineAudioMixArgs(
      "/tmp/raw.wav",
      "/tmp/mixed.wav",
      [
        baseAudio,
        {
          ...baseAudio,
          clipId: "A2",
          assetId: "AST_BGM",
          sourcePath: "/tmp/bgm.wav",
          trackId: "A2",
          role: "music",
          gainDb: 20 * Math.log10(0.25),
          gainLinear: 0.25,
        },
      ],
      24,
      2,
    );
    const graph = args[args.indexOf("-filter_complex") + 1];
    expect(graph).toContain("volume=1.8");
    expect(graph).toContain("volume=0.25");
    expect(graph).toContain("afade=t=in:st=0:d=0.125000");
    expect(graph).toContain("afade=t=out:st=1.750000:d=0.250000");
    expect(graph).toContain("sidechaincompress=threshold=0.05:ratio=4:attack=20:release=400");
    expect(graph).toContain("[origout][ducked]amix");
  });

  it("positions BGM fade-out from max-out span without subtracting overlap twice", () => {
    expect(previewBgmFadeOutStartSec(216, 24, 24)).toBe(8);
  });

  it("preserves explicit linear zero as a complete mute", () => {
    const args = buildAdditionalTimelineAudioMixArgs(
      "/tmp/raw.wav",
      "/tmp/mixed.wav",
      [{ ...baseAudio, gainDb: -96, gainLinear: 0 }],
      24,
      2,
    );
    const graph = args[args.indexOf("-filter_complex") + 1];
    expect(graph).toContain("volume=0");
  });

  it("suppresses external BGM only when the matching asset is timeline-owned music", () => {
    expect(timelineOwnsBgmAsset([baseAudio], "AST_SHARED")).toBe(false);
    expect(timelineOwnsBgmAsset([
      { ...baseAudio, trackId: "A2" },
    ], "AST_SHARED")).toBe(true);
    expect(timelineOwnsBgmAsset([
      { ...baseAudio, trackId: "A3", role: "music" },
    ], "AST_SHARED")).toBe(true);
  });
});
