import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import {
  audioGainFieldDisplayDb,
  canonicalLinearGainFilter,
  resolveAudioGain,
  saveAudioGainFieldAsDb,
} from "../editor/shared/audio-gain.js";
import { buildTransitionChainArgs } from "../editor/shared/filtergraph.js";
import { buildRenderSpec } from "../editor/shared/render-spec.js";
import { buildAdditionalTimelineAudioMixArgs } from "../editor/server/services/preview-job-service.js";
import {
  buildAudioTrimArgs,
  buildBgmAudioRenderArgs,
} from "../runtime/render/assembler.js";
import { buildTimelineAudioMixFilter, type RenderAudioClip } from "../scripts/render-rough-cut.js";

const require_ = createRequire(import.meta.url);
const Ajv2020 = require_("ajv/dist/2020") as new (opts: Record<string, unknown>) => {
  compile(schema: object): (data: unknown) => boolean;
};
const addFormats = require_("ajv-formats") as (ajv: unknown) => void;

describe("canonical audio gain resolver", () => {
  it.each([
    [{ gain_unit: "linear" as const, nat_gain: 1.8 }, "nat" as const, 1.8, "explicit_linear"],
    [{ gain_unit: "db" as const, nat_gain: -6 }, "nat" as const, 10 ** (-6 / 20), "explicit_db"],
    [{ gain_unit: "linear" as const, bgm_gain: 0 }, "bgm" as const, 0, "explicit_linear"],
    [{ nat_sound_gain: 0.75 }, "nat_sound" as const, 0.75, "legacy_linear_positive"],
    [{ nat_gain: 8 }, "nat" as const, 8, "legacy_linear_positive"],
    [{ bgm_gain: -12 }, "bgm" as const, 10 ** (-12 / 20), "legacy_db_non_positive"],
    [{ nat_gain: 0 }, "nat" as const, 1, "legacy_db_non_positive"],
    [undefined, "nat" as const, 1, "default_unity"],
  ])("resolves %j for %s", (policy, role, linear, provenance) => {
    const result = resolveAudioGain(policy, role);
    expect(result.gainLinear).toBeCloseTo(linear, 10);
    expect(result.provenance).toBe(provenance);
  });

  it("keeps duck_music_db in dB regardless of gain_unit", () => {
    const result = resolveAudioGain(
      { gain_unit: "linear", duck_music_db: -18 },
      "bgm",
      { fallbackToDuckMusicDb: true },
    );
    expect(result.gainDb).toBe(-18);
    expect(result.provenance).toBe("duck_music_db");
  });

  it.each([
    { gain_unit: "linear" as const, nat_gain: Number.NaN },
    { gain_unit: "linear" as const, nat_gain: Number.POSITIVE_INFINITY },
    { gain_unit: "linear" as const, nat_gain: -0.01 },
    { gain_unit: "db" as const, nat_gain: Number.NEGATIVE_INFINITY },
  ])("rejects non-finite or out-of-policy gain: %j", (policy) => {
    expect(() => resolveAudioGain(policy, "nat")).toThrow(RangeError);
  });
});

describe("gain filter parity", () => {
  it("materializes legacy positive, negative, and zero gains canonically in RenderSpec", () => {
    const clips = [
      { clip_id: "positive", nat_gain: 1.8 },
      { clip_id: "negative", nat_gain: -6 },
      { clip_id: "zero", nat_gain: 0 },
    ].map(({ clip_id, nat_gain }, index) => ({
      clip_id, asset_id: clip_id, role: "dialogue", src_in_us: 0, src_out_us: 1_000_000,
      timeline_in_frame: index * 24, timeline_duration_frames: 24,
      audio_policy: { nat_gain },
    }));
    const spec = buildRenderSpec({
      sequence: { fps_num: 24, fps_den: 1, width: 1920, height: 1080 },
      tracks: { video: [], audio: [{ track_id: "A1", kind: "audio", clips }] },
    }, "rev", (assetId) => `/tmp/${assetId}.wav`);
    expect(spec.audio.dialogueClips.map((clip) => clip.gainLinear)).toEqual([
      1.8,
      expect.closeTo(10 ** (-6 / 20), 10),
      1,
    ]);
    expect(spec.warnings).toContain("audio_gain_legacy_unit:nat_gain:positive_assumed_linear");
    expect(spec.warnings).toContain("audio_gain_legacy_unit:nat_gain:non_positive_assumed_db");
  });

  it("uses unit-aware audio_mix as the fallback for clips without a role gain", () => {
    const spec = buildRenderSpec({
      sequence: { fps_num: 24, fps_den: 1, width: 1920, height: 1080 },
      tracks: { video: [], audio: [{ track_id: "A1", kind: "audio", clips: [{
        clip_id: "nat", asset_id: "nat", role: "nat_sound", src_in_us: 0,
        src_out_us: 1_000_000, timeline_in_frame: 0, timeline_duration_frames: 24,
      }] }] },
      audio_mix: { gain_unit: "db", nat_sound_gain: -9 },
    }, "rev", () => "/tmp/nat.wav");
    expect(spec.audio.dialogueClips[0].gainDb).toBe(-9);
    expect(spec.audio.dialogueClips[0].gainLinear).toBeCloseTo(10 ** (-9 / 20), 10);
    expect(spec.audio.dialogueClips[0].gainProvenance).toBe("explicit_db");
  });

  it("uses the same canonical multiplier for explicit linear and negative dB", () => {
    const linearArgs = buildAudioTrimArgs("in.mov", "out.wav", 0, 1, 48_000, 2, {
      gain_unit: "linear",
      nat_gain: 1.8,
    });
    const dbArgs = buildAudioTrimArgs("in.mov", "out.wav", 0, 1, 48_000, 2, {
      gain_unit: "db",
      nat_gain: -6,
    });
    expect(linearArgs[linearArgs.indexOf("-af") + 1]).toBe("volume=1.8");
    expect(dbArgs[dbArgs.indexOf("-af") + 1]).toBe("volume=0.50118723");
  });

  it("preserves exact explicit mute in final, BGM, and rough-cut filters", () => {
    const finalArgs = buildAudioTrimArgs("in.mov", "out.wav", 0, 1, 48_000, 2, {
      gain_unit: "linear",
      nat_gain: 0,
    });
    const bgmArgs = buildBgmAudioRenderArgs("in.wav", "out.wav", 0, 1, 48_000, 2, 24, {
      gain_unit: "linear",
      bgm_gain: 0,
    });
    expect(finalArgs[finalArgs.indexOf("-af") + 1]).toContain("volume=0");
    expect(bgmArgs[bgmArgs.indexOf("-af") + 1]).toContain("volume=0");

    const clip: RenderAudioClip = {
      clipId: "a1",
      assetId: "asset",
      sourcePath: "/tmp/a.wav",
      startSec: 0,
      durationSec: 1,
      timelineInFrame: 0,
      timelineDurationSec: 1,
      sourceRangeDurationSec: 1,
      timelineOutFrame: 24,
      role: "dialogue",
      audioPolicy: { gain_unit: "linear", nat_gain: 0 },
    };
    expect(buildTimelineAudioMixFilter([clip], 1, 24)?.filterComplex).toContain("volume=0");

    const previewArgs = buildAdditionalTimelineAudioMixArgs(
      "/tmp/raw.wav",
      "/tmp/mixed.wav",
      [{
        clipId: "a1",
        assetId: "asset",
        sourcePath: "/tmp/a.wav",
        trackId: "A1",
        role: "dialogue",
        timelineInFrame: 0,
        durationFrames: 24,
        sourceInSec: 0,
        sourceOutSec: 1,
        gainDb: -96,
        gainLinear: 0,
        gainProvenance: "explicit_linear",
        fadeInFrames: 0,
        fadeOutFrames: 0,
      }],
      24,
      1,
    );
    expect(previewArgs[previewArgs.indexOf("-filter_complex") + 1]).toContain("volume=0");

    const transitionArgs = buildTransitionChainArgs({
      inputs: [
        { sourcePath: "/tmp/a.mov", sourceInSec: 0, durationSec: 1, videoFilter: "null", hasAudio: true, gainDb: -96, gainLinear: 0 },
        { sourcePath: "/tmp/b.mov", sourceInSec: 0, durationSec: 1, videoFilter: "null", hasAudio: true, gainDb: 0, gainLinear: 1 },
      ],
      clipDurationsSec: [1, 1],
      transitions: [],
      includeAudio: true,
      outputPath: "/tmp/out.mp4",
      videoEncodeArgs: [],
      audioCodecArgs: [],
    });
    expect(transitionArgs[transitionArgs.indexOf("-filter_complex") + 1]).toContain("[0:a]volume=0[a0]");
  });

  it("serializes one resolved negative-dB multiplier identically across filter lanes", () => {
    const gain = resolveAudioGain({ gain_unit: "db", nat_gain: -6 }, "nat");
    const expected = canonicalLinearGainFilter(gain.gainLinear);
    expect(expected).toBe("volume=0.50118723");
    expect(buildAudioTrimArgs("in", "out", 0, 1, 48_000, 2, { gain_unit: "db", nat_gain: -6 }).join(" ")).toContain(expected);

    const transitionArgs = buildTransitionChainArgs({
      inputs: [
        { sourcePath: "/tmp/a.mov", durationSec: 1, videoFilter: "null", hasAudio: true, gainDb: gain.gainDb, gainLinear: gain.gainLinear },
        { sourcePath: "/tmp/b.mov", durationSec: 1, videoFilter: "null", hasAudio: true, gainDb: 0, gainLinear: 1 },
      ],
      clipDurationsSec: [1, 1], transitions: [], includeAudio: true,
      outputPath: "/tmp/out.mp4", videoEncodeArgs: [], audioCodecArgs: [],
    });
    expect(transitionArgs.join(" ")).toContain(expected);
  });

  it("preserves legacy positive gain above 4 in final, preview, transition, and rough-cut filters", () => {
    const gain = resolveAudioGain({ nat_gain: 8 }, "nat");
    expect(gain.gainLinear).toBe(8);
    expect(canonicalLinearGainFilter(gain.gainLinear)).toBe("volume=8");
    expect(buildAudioTrimArgs("in", "out", 0, 1, 48_000, 2, { nat_gain: 8 }).join(" ")).toContain("volume=8");

    const renderClip = {
      clipId: "legacy", assetId: "asset", sourcePath: "/tmp/a.wav", trackId: "A1", role: "dialogue",
      timelineInFrame: 0, durationFrames: 24, sourceInSec: 0, sourceOutSec: 1,
      gainDb: gain.gainDb, gainLinear: gain.gainLinear, gainProvenance: gain.provenance,
      fadeInFrames: 0, fadeOutFrames: 0,
    };
    expect(buildAdditionalTimelineAudioMixArgs("raw", "out", [renderClip], 24, 1).join(" ")).toContain("volume=8");
    expect(buildTransitionChainArgs({
      inputs: [
        { sourcePath: "a", durationSec: 1, videoFilter: "null", hasAudio: true, gainDb: gain.gainDb, gainLinear: gain.gainLinear },
        { sourcePath: "b", durationSec: 1, videoFilter: "null", hasAudio: true, gainDb: 0, gainLinear: 1 },
      ],
      clipDurationsSec: [1, 1], transitions: [], includeAudio: true,
      outputPath: "out", videoEncodeArgs: [], audioCodecArgs: [],
    }).join(" ")).toContain("volume=8");

    const roughClip: RenderAudioClip = {
      clipId: "legacy", assetId: "asset", sourcePath: "/tmp/a.wav", startSec: 0,
      durationSec: 1, timelineInFrame: 0, timelineDurationSec: 1,
      sourceRangeDurationSec: 1, timelineOutFrame: 24, role: "dialogue",
      audioPolicy: { nat_gain: 8 },
    };
    expect(buildTimelineAudioMixFilter([roughClip], 1, 24)?.filterComplex).toContain("volume=8");
  });
});

describe("PropertyPanel gain display helper", () => {
  it("converts only the requested field and does not role-fallback", () => {
    const policy = { gain_unit: "linear" as const, nat_sound_gain: 0.5 };
    expect(audioGainFieldDisplayDb(policy, "nat_gain")).toBe(0);
    expect(audioGainFieldDisplayDb(policy, "nat_sound_gain")).toBeCloseTo(-6.0206, 3);
  });

  it("saves an edited field in dB without changing duck_music_db semantics", () => {
    expect(saveAudioGainFieldAsDb(
      { gain_unit: "linear", nat_gain: 1.8, nat_sound_gain: 0.5, duck_music_db: -18 },
      "nat_sound_gain",
      -9,
    )).toEqual({
      gain_unit: "db",
      nat_gain: 20 * Math.log10(1.8),
      nat_sound_gain: -9,
      duck_music_db: -18,
    });
  });
});

describe("timeline gain_unit schema", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(JSON.parse(fs.readFileSync("schemas/timeline-ir.schema.json", "utf8")));
  const timeline = {
    version: "1",
    project_id: "gain-unit",
    sequence: { name: "main", fps_num: 24, fps_den: 1, width: 1920, height: 1080, start_frame: 0 },
    tracks: {
      video: [],
      audio: [{
        track_id: "A1", kind: "audio",
        clips: [{
          clip_id: "a1", segment_id: "s1", asset_id: "asset",
          src_in_us: 0, src_out_us: 1_000_000, timeline_in_frame: 0,
          timeline_duration_frames: 24, role: "dialogue", motivation: "test",
          audio_policy: { gain_unit: "db", nat_gain: -6 },
        }],
      }],
    },
    audio_mix: { gain_unit: "linear", bgm_gain: 0.25, duck_music_db: -18 },
    provenance: { brief_path: "brief", blueprint_path: "blueprint", selects_path: "selects" },
  };

  it("accepts explicit units and keeps legacy unit omission valid", () => {
    expect(validate(timeline)).toBe(true);
    const legacy = structuredClone(timeline);
    delete (legacy.tracks.audio[0].clips[0].audio_policy as { gain_unit?: string }).gain_unit;
    delete (legacy.audio_mix as { gain_unit?: string }).gain_unit;
    expect(validate(legacy)).toBe(true);
  });

  it("rejects unsupported units", () => {
    const invalid = structuredClone(timeline) as unknown as { audio_mix: { gain_unit: string } };
    invalid.audio_mix.gain_unit = "percent";
    expect(validate(invalid)).toBe(false);
  });
});
