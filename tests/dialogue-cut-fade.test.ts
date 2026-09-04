import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DIALOGUE_CUT_FADE_DEFAULT_MS,
  dialogueCutFadeSec,
} from "../editor/shared/dialogue-cut-fade.js";
import { buildTransitionChainArgs } from "../editor/shared/filtergraph.js";
import {
  assembleTimelineToMp4,
  buildAudioTrimArgs,
  type ExecFileLike,
} from "../runtime/render/assembler.js";

describe("dialogue cut audio fade", () => {
  it("computes deterministic 40ms fades only when enabled", () => {
    expect(dialogueCutFadeSec(4, false)).toBe(0);
    expect(dialogueCutFadeSec(4, true)).toBe(DIALOGUE_CUT_FADE_DEFAULT_MS / 1000);
    expect(dialogueCutFadeSec(0.08, true)).toBeCloseTo(0.02, 6);
  });

  it("adds afade in/out to non-BGM trim args when requested", () => {
    const args = buildAudioTrimArgs(
      "/tmp/source.mov",
      "/tmp/a1.wav",
      10,
      14,
      48_000,
      2,
      undefined,
      { dialogueCutFadeSec: dialogueCutFadeSec(4, true) },
    );

    const filter = args[args.indexOf("-af") + 1];
    expect(filter).toContain("afade=t=in:st=0:d=0.040000");
    expect(filter).toContain("afade=t=out:st=3.960000:d=0.040000");
  });

  it("omits dialogue afade when disabled", () => {
    const args = buildAudioTrimArgs(
      "/tmp/source.mov",
      "/tmp/a1.wav",
      0,
      4,
      48_000,
      2,
      undefined,
      { dialogueCutFadeSec: dialogueCutFadeSec(4, false) },
    );

    expect(args).toContain("-af");
    expect(args[args.indexOf("-af") + 1]).not.toContain("afade=");
    expect(args[args.indexOf("-af") + 1]).toContain("atrim=start=0:end=4");
  });

  it("shrinks fade duration for very short clips", () => {
    const args = buildAudioTrimArgs(
      "/tmp/source.mov",
      "/tmp/a1.wav",
      0,
      0.08,
      48_000,
      2,
      undefined,
      { dialogueCutFadeSec: dialogueCutFadeSec(0.08, true) },
    );

    const filter = args[args.indexOf("-af") + 1];
    expect(filter).toContain("afade=t=in:st=0:d=0.020000");
    expect(filter).toContain("afade=t=out:st=0.060000:d=0.020000");
  });

  it("max-merges with transition fades instead of stacking a second afade", () => {
    const args = buildAudioTrimArgs(
      "/tmp/source.mov",
      "/tmp/a1.wav",
      0,
      4,
      48_000,
      2,
      undefined,
      {
        fadeInSec: 0.2,
        fadeOutSec: 0.3,
        dialogueCutFadeSec: dialogueCutFadeSec(4, true),
      },
    );

    const filter = args[args.indexOf("-af") + 1];
    expect(filter).toContain("afade=t=in:st=0:d=0.200000");
    expect(filter).toContain("afade=t=out:st=3.700000:d=0.300000");
    expect(filter.match(/afade=t=in/g)).toHaveLength(1);
    expect(filter.match(/afade=t=out/g)).toHaveLength(1);
    expect(filter).not.toContain("d=0.040000");
  });

  it("does not apply dialogue cut fades to BGM plans in the final assembler", async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-dialogue-fade-"));
    const timelinePath = path.join(projectDir, "05_timeline", "timeline.json");
    fs.mkdirSync(path.dirname(timelinePath), { recursive: true });
    fs.writeFileSync(timelinePath, JSON.stringify(makeTimelineWithBgm(), null, 2));
    const speechSource = path.join(projectDir, "speech.mov");
    const musicSource = path.join(projectDir, "music.wav");
    fs.writeFileSync(speechSource, "");
    fs.writeFileSync(musicSource, "");

    const calls: string[][] = [];
    const execFileImpl: ExecFileLike = (_file, args, _options, callback) => {
      calls.push([...args]);
      callback(null, "", "");
    };

    await assembleTimelineToMp4({
      projectDir,
      timelinePath,
      outputPath: path.join(projectDir, "out.mp4"),
      sourceOverrides: {
        speech: speechSource,
        music: musicSource,
      },
      execFileImpl,
      cleanupTemp: true,
    });

    const speechArgs = calls.find((args) => args.at(-1)?.endsWith("audio-segment-0001.wav"));
    const bgmArgs = calls.find((args) => args.at(-1)?.endsWith("audio-segment-0002.wav"));
    expect(speechArgs).toBeDefined();
    expect(bgmArgs).toBeDefined();
    expect(speechArgs?.[speechArgs.indexOf("-af") + 1]).toContain("d=0.040000");
    expect(bgmArgs).not.toContain("-af");

    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it("serializes preview transition-chain input fades through filter_complex", () => {
    const args = buildTransitionChainArgs({
      inputs: [
        {
          kind: "source",
          sourcePath: "/tmp/a.mov",
          sourceInSec: 0,
          durationSec: 1,
          videoFilter: "format=yuv420p,setsar=1",
          hasAudio: true,
          audioFadeInSec: 0.04,
          audioFadeOutSec: 0.04,
        },
      ],
      clipDurationsSec: [1],
      transitions: [],
      includeAudio: true,
      videoEncodeArgs: ["-c:v", "libx264"],
      audioCodecArgs: ["-c:a", "pcm_s16le"],
      outputPath: "/tmp/out.mov",
    });

    const filter = args[args.indexOf("-filter_complex") + 1];
    expect(filter).toContain("[0:a]afade=t=in:st=0:d=0.040000,afade=t=out:st=0.960000:d=0.040000[a0]");
  });
});

function makeTimelineWithBgm(): Record<string, unknown> {
  const editorial = {
    applied_skills: ["talking_head_pacing"],
  };
  return {
    version: "1",
    project_id: "dialogue-cut-fade-test",
    created_at: "2026-06-15T00:00:00.000Z",
    sequence: {
      fps_num: 30,
      fps_den: 1,
      width: 640,
      height: 360,
      sample_rate: 48_000,
      start_frame: 0,
    },
    tracks: {
      video: [
        {
          track_id: "V1",
          kind: "video",
          clips: [
            makeClip("v1", "speech", "hero", 0, editorial),
          ],
        },
      ],
      audio: [
        {
          track_id: "A1",
          kind: "audio",
          clips: [
            makeClip("a1", "speech", "nat_sound", 0, editorial),
          ],
        },
        {
          track_id: "A2",
          kind: "audio",
          clips: [
            {
              ...makeClip("a2", "music", "bgm", 0, editorial),
              audio_policy: {
                bgm_gain: 1,
                bgm_fade_in_frames: 0,
                bgm_fade_out_frames: 0,
              },
            },
          ],
        },
      ],
    },
    provenance: {
      audio_policy: { mode: "ducking" },
    },
  };
}

function makeClip(
  clipId: string,
  assetId: string,
  role: string,
  timelineInFrame: number,
  editorial: Record<string, unknown>,
): Record<string, unknown> {
  return {
    clip_id: clipId,
    segment_id: `SEG_${clipId}`,
    asset_id: assetId,
    src_in_us: 0,
    src_out_us: 2_000_000,
    timeline_in_frame: timelineInFrame,
    timeline_duration_frames: 60,
    role,
    motivation: "dialogue cut fade fixture",
    beat_id: "b01",
    fallback_segment_ids: [],
    confidence: 0.9,
    quality_flags: [],
    metadata: { editorial },
  };
}
