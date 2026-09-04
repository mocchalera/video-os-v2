import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { validateAgainstSchema } from "../runtime/commands/shared.js";
import {
  assertAudioDeliveryProfileFresh,
  audioDeliveryProfileContentHash,
  loadAudioDeliveryProfile,
  loadAudioDeliveryRegistry,
  selectAudioDeliveryProfile,
} from "../runtime/audio/delivery-profile.js";
import {
  assertAudioRenderPlanContract,
  hashFile,
  resolveAudioRenderPlan,
  validateAudioRenderPlanContract,
} from "../runtime/audio/render-plan.js";
import { executeAudioRenderPlan } from "../runtime/audio/render-executor.js";
import { resolveSharedAudioRenderPlan } from "../runtime/audio/render-route.js";
import {
  buildAudioDiagnosticArgs,
  buildEncodedAudioProbeArgs,
  buildMonoFoldDownArgs,
  measureEncodedAudioResult,
  parseLoudnormOutput,
} from "../runtime/audio/mastering.js";
import { projectProjectAudioPolicy } from "../runtime/compiler/index.js";
import { loadSourceMap } from "../runtime/media/source-map.js";
import { checkAudioMixPolicy } from "../runtime/packaging/qa.js";
import type { AudioMixReport } from "../runtime/audio/mixer.js";
import type { TimelineIR } from "../runtime/compiler/types.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(process.cwd());
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function minimalTimeline(root: string): { timelinePath: string; sourcePath: string } {
  const sourcePath = path.join(root, "dialogue.wav");
  const timelinePath = path.join(root, "timeline.json");
  fs.writeFileSync(sourcePath, "synthetic source placeholder");
  fs.writeFileSync(timelinePath, JSON.stringify({
    version: "1",
    project_id: "rfa-audio-contract",
    sequence: { fps_num: 24, fps_den: 1, width: 1920, height: 1080 },
    provenance: { audio_policy: { mode: "ducking" } },
    tracks: {
      video: [{ track_id: "V1", clips: [{ clip_id: "V1", timeline_in_frame: 0, timeline_duration_frames: 48 }] }],
      audio: [
        { track_id: "A1", clips: [{ clip_id: "A1", asset_id: "VOICE", src_in_us: 0, src_out_us: 1_000_000, timeline_in_frame: 0, timeline_duration_frames: 24, role: "dialogue" }] },
        { track_id: "A3", clips: [{ clip_id: "A3", asset_id: "UNPINNED_SFX", src_in_us: 0, src_out_us: 100_000, timeline_in_frame: 24, timeline_duration_frames: 2, role: "sfx" }] },
      ],
    },
  }), "utf8");
  return { timelinePath, sourcePath };
}

describe("RFA-023 audio delivery profile contracts", () => {
  it("loads every registered profile and keeps production values unknown or partial", () => {
    const registry = loadAudioDeliveryRegistry(repoRoot);
    expect(registry.malformed).toEqual([]);
    expect(registry.profiles.length).toBeGreaterThanOrEqual(8);
    expect(registry.profiles.find((item) => item.profile.profile_id === "instagram-reels-organic-audio-v1")?.profile.status).toBe("partial");
    expect(registry.profiles.find((item) => item.profile.profile_id === "tiktok-video-organic-audio-v1")?.profile.status).toBe("unknown");
    for (const item of registry.profiles) {
      expect(validateAgainstSchema(item.profile, "audio-delivery-profile.schema.json")).toEqual({ valid: true, errors: [] });
    }
  });

  it("returns human hold for partial/stale profiles and rejects an exact scope mismatch", () => {
    const partial = selectAudioDeliveryProfile({
      rootDir: repoRoot,
      platform: "instagram",
      surface: "reels",
      releaseScope: "organic",
      profileId: "instagram-reels-organic-audio-v1",
    });
    expect(partial.status).toBe("human_hold");
    expect(partial.human_preview_required).toBe(true);
    expect(partial.freshness).toBe("unknown");

    const stale = selectAudioDeliveryProfile({
      rootDir: repoRoot,
      platform: "fixture",
      surface: "fixture",
      releaseScope: "internal",
      profileId: "audio-fixture-stale-v1",
      now: new Date("2026-08-21T00:00:00Z"),
    });
    expect(stale.status).toBe("human_hold");
    expect(stale.freshness).toBe("stale");

    expect(() => selectAudioDeliveryProfile({
      rootDir: repoRoot,
      platform: "instagram",
      surface: "reels",
      releaseScope: "ads",
      profileId: "instagram-reels-organic-audio-v1",
    })).toThrow(/AUDIO_DELIVERY_PROFILE_SCOPE_MISMATCH/);
  });

  it("selects a unique exact scope or an explicit profile id without fuzzy fallback", () => {
    const scoped = selectAudioDeliveryProfile({
      rootDir: repoRoot,
      platform: "instagram",
      surface: "reels",
      releaseScope: "organic",
      deliveryVariant: "production-reference",
    });
    expect(scoped.profile?.profile.profile_id).toBe("instagram-reels-organic-audio-v1");

    const byId = selectAudioDeliveryProfile({
      rootDir: repoRoot,
      profileId: "audio-fixture-verified-internal-v1",
    });
    expect(byId.status).toBe("verified");
    expect(byId.profile?.profile.platform).toBe("fixture");
  });

  it("profile file changes invalidate the selected hash", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-audio-profile-"));
    tempRoots.push(root);
    const destination = path.join(root, "delivery_profiles/audio/fixture/verified.yaml");
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, "delivery_profiles/audio/fixture/verified-internal-v1.yaml"), destination);
    const loaded = loadAudioDeliveryProfile(destination);
    fs.appendFileSync(destination, "\n");
    expect(() => assertAudioDeliveryProfileFresh(loaded)).toThrow(/AUDIO_DELIVERY_PROFILE_STALE/);
  });

  it("carries the exact selected profile hash into the shared render plan", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-audio-profile-plan-"));
    tempRoots.push(root);
    const input = minimalTimeline(root);
    const profilePath = path.join(repoRoot, "delivery_profiles/audio/fixture/verified-internal-v1.yaml");
    const plan = resolveAudioRenderPlan({
      projectDir: root,
      timelinePath: input.timelinePath,
      sourceOverrides: { VOICE: input.sourcePath },
      audioProfilePath: profilePath,
      audioProfileRootDir: repoRoot,
      audioProfileId: "audio-fixture-verified-internal-v1",
      audioProfilePlatform: "fixture",
      audioProfileSurface: "fixture",
      audioProfileReleaseScope: "internal",
      audioProfileVariant: "synthetic-encoded",
    });
    expect(plan.audio_delivery_profile).toMatchObject({
      profile_id: "audio-fixture-verified-internal-v1",
      selection_status: "verified",
      freshness: "current",
    });
    expect(plan.audio_delivery_profile?.content_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(plan.audio_delivery_profile?.source_hash).toBe(plan.audio_delivery_profile?.content_hash);
    expect(plan.audio_delivery_profile?.profile_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("rejects a timeline profile reference whose declared hash is stale", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-audio-profile-stale-ref-"));
    tempRoots.push(root);
    const input = minimalTimeline(root);
    const profilePath = path.join(repoRoot, "delivery_profiles/audio/fixture/verified-internal-v1.yaml");
    const timeline = JSON.parse(fs.readFileSync(input.timelinePath, "utf8")) as Record<string, unknown>;
    timeline.metadata = {
      audio_delivery_profile_ref: {
        ref: profilePath,
        source_hash: `sha256:${"0".repeat(64)}`,
      },
    };
    fs.writeFileSync(input.timelinePath, `${JSON.stringify(timeline)}\n`, "utf8");
    expect(() => resolveAudioRenderPlan({
      projectDir: root,
      timelinePath: input.timelinePath,
      sourceOverrides: { VOICE: input.sourcePath },
      audioProfileRootDir: repoRoot,
    })).toThrow(/AUDIO_DELIVERY_PROFILE_STALE/);
  });

  it("keeps raw source_hash and canonical profile_hash distinct and rejects duplicate ids", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-audio-profile-identity-"));
    tempRoots.push(root);
    const sourceProfilePath = path.join(repoRoot, "delivery_profiles/audio/fixture/verified-internal-v1.yaml");
    const duplicateOne = path.join(root, "delivery_profiles/audio/fixture/one.yaml");
    const duplicateTwo = path.join(root, "delivery_profiles/audio/fixture/two.yaml");
    fs.mkdirSync(path.dirname(duplicateOne), { recursive: true });
    fs.copyFileSync(sourceProfilePath, duplicateOne);
    fs.copyFileSync(sourceProfilePath, duplicateTwo);
    expect(() => selectAudioDeliveryProfile({
      rootDir: root,
      profileId: "audio-fixture-verified-internal-v1",
    })).toThrow(/ambiguous/);

    const input = minimalTimeline(root);
    const loaded = loadAudioDeliveryProfile(sourceProfilePath);
    const timeline = JSON.parse(fs.readFileSync(input.timelinePath, "utf8")) as Record<string, unknown>;
    timeline.metadata = {
      audio_delivery_profile_ref: {
        ref: sourceProfilePath,
        source_hash: loaded.hash,
        profile_hash: audioDeliveryProfileContentHash(loaded.profile),
      },
    };
    fs.writeFileSync(input.timelinePath, `${JSON.stringify(timeline)}\n`, "utf8");
    const plan = resolveAudioRenderPlan({
      projectDir: root,
      timelinePath: input.timelinePath,
      sourceOverrides: { VOICE: input.sourcePath },
      audioProfileRootDir: repoRoot,
    });
    expect(plan.audio_delivery_profile?.source_hash).toBe(loaded.hash);
    expect(plan.audio_delivery_profile?.profile_hash).toBe(audioDeliveryProfileContentHash(loaded.profile));

    const staleCanonical = JSON.parse(fs.readFileSync(input.timelinePath, "utf8")) as Record<string, unknown>;
    staleCanonical.metadata = {
      audio_delivery_profile_ref: {
        ref: sourceProfilePath,
        source_hash: loaded.hash,
        profile_hash: loaded.hash,
      },
    };
    fs.writeFileSync(input.timelinePath, `${JSON.stringify(staleCanonical)}\n`, "utf8");
    expect(() => resolveAudioRenderPlan({
      projectDir: root,
      timelinePath: input.timelinePath,
      sourceOverrides: { VOICE: input.sourcePath },
      audioProfileRootDir: repoRoot,
    })).toThrow(/AUDIO_DELIVERY_PROFILE_STALE/);
  });
});

describe("RFA-011 audio projection and single-mastering contract", () => {
  it("records A1/A2/A3 semantics, holds unpinned SFX, and never displaces timing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-audio-plan-"));
    tempRoots.push(root);
    const input = minimalTimeline(root);
    const plan = resolveAudioRenderPlan({
      projectDir: root,
      timelinePath: input.timelinePath,
      sourceOverrides: { VOICE: input.sourcePath },
    });
    expect(plan.scene_audio_policy).toMatchObject({
      lane_semantics: { A1: "dialogue_and_natural_sound", A2: "music_bgm", A3: "texture_ambient_and_sfx" },
      dialogue: { authority: "A1", conflict_policy: "dialogue_first" },
      sfx: { permission: "human_hold", outcome: "human_hold" },
      timing: { picture_timing_immutable: true, dialogue_timing_immutable: true, caption_timing_immutable: true, audio_displacement_frames: 0 },
      single_mastering: { owner: "shared_audio_render_plan", count: 1 },
    });
    expect(validateAudioRenderPlanContract(plan)).toEqual({ valid: true, errors: [] });
    expect(validateAgainstSchema(plan, "audio-render-plan.schema.json")).toEqual({ valid: true, errors: [] });
    await expect(executeAudioRenderPlan({
      plan,
      outputDir: path.join(root, "formal-sfx-out"),
    })).rejects.toThrow(/HOLD: formal A3 SFX/);

    const before = JSON.parse(fs.readFileSync(input.timelinePath, "utf8")) as TimelineIR;
    const sourceHash = "a".repeat(64);
    fs.mkdirSync(path.join(root, "02_media"), { recursive: true });
    fs.writeFileSync(path.join(root, "02_media", "source_map.json"), JSON.stringify({
      version: "1",
      project_id: before.project_id,
      media_dir: "02_media",
      generated_at: "2026-08-21T00:00:00Z",
      items: [{
        asset_id: "VOICE",
        source_locator: input.sourcePath,
        local_source_path: input.sourcePath,
        link_path: input.sourcePath,
        source_content_sha256: sourceHash,
      }],
    }), "utf8");
    const projected = projectProjectAudioPolicy(
      before,
      { mode: "ducking", a1_loudnorm: true },
      loadSourceMap(root),
    );
    expect(projected.tracks.audio).toEqual(before.tracks.audio);
    expect(projected.provenance.audio_render_projection?.audio_displacement_frames).toBe(0);
    expect(projected.provenance.audio_render_projection?.conflict_policy).toBe("dialogue_first");
    expect(projected.provenance.audio_render_projection?.source_refs).toContainEqual(expect.objectContaining({
      asset_id: "VOICE",
      source_ref: input.sourcePath,
      source_content_hash: `sha256:${sourceHash}`,
    }));
  });

  it("rejects a stale A1 source when a compiled projection is present", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-audio-a1-stale-"));
    tempRoots.push(root);
    const input = minimalTimeline(root);
    const timeline = JSON.parse(fs.readFileSync(input.timelinePath, "utf8")) as TimelineIR;
    const projected = projectProjectAudioPolicy(
      timeline,
      { mode: "ducking", a1_loudnorm: true },
      undefined,
      new Map([["VOICE", hashFile(input.sourcePath)]]),
    );
    fs.writeFileSync(input.timelinePath, `${JSON.stringify(projected)}\n`, "utf8");

    expect(resolveAudioRenderPlan({
      projectDir: root,
      timelinePath: input.timelinePath,
      sourceOverrides: { VOICE: input.sourcePath },
    }).dialogue.clips[0].source_content_hash).toBe(hashFile(input.sourcePath));

    fs.appendFileSync(input.sourcePath, " changed after compilation");
    expect(() => resolveAudioRenderPlan({
      projectDir: root,
      timelinePath: input.timelinePath,
      sourceOverrides: { VOICE: input.sourcePath },
    })).toThrow(/AUDIO_RENDER_PLAN_STALE/);
  });

  it("preserves authored A3 ambience as a timed stem and holds before execution", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-audio-ambient-"));
    tempRoots.push(root);
    const input = minimalTimeline(root);
    const timeline = JSON.parse(fs.readFileSync(input.timelinePath, "utf8")) as TimelineIR;
    const ambientTrack = timeline.tracks.audio.find((track) => track.track_id === "A3");
    if (!ambientTrack) throw new Error("minimal timeline did not contain A3");
    ambientTrack.clips = [{
      ...ambientTrack.clips[0],
      clip_id: "A3_AMBIENT",
      asset_id: "AMBIENT",
      role: "ambient",
      audio_role: "ambient",
      metadata: { source_path: input.sourcePath, authored_ambient: true },
    }];
    fs.writeFileSync(input.timelinePath, `${JSON.stringify(timeline)}\n`, "utf8");

    const plan = resolveSharedAudioRenderPlan({
      projectDir: root,
      timelinePath: input.timelinePath,
      sourceOverrides: { VOICE: input.sourcePath, AMBIENT: input.sourcePath },
    });
    if (!plan) throw new Error("ambient timeline did not select the shared route");
    expect(plan.ambient?.clips).toHaveLength(1);
    expect(plan.ambient?.clips[0]).toMatchObject({
      clip_id: "A3_AMBIENT",
      asset_id: "AMBIENT",
      source_content_hash: hashFile(input.sourcePath),
      timeline_range: { in_frame: 24, out_frame: 26 },
    });
    expect(plan.scene_audio_policy?.ambient).toMatchObject({
      permission: "human_hold",
      outcome: "human_hold",
    });
    expect(plan.scene_audio_policy?.sfx).toMatchObject({ requested: false, outcome: "not_requested" });
    await expect(executeAudioRenderPlan({
      plan,
      outputDir: path.join(root, "out"),
    })).rejects.toThrow(/HOLD: authored A3 ambience/);
  });

  it("rejects a second final mastering pass", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-audio-plan-"));
    tempRoots.push(root);
    const input = minimalTimeline(root);
    const plan = resolveAudioRenderPlan({ projectDir: root, timelinePath: input.timelinePath, sourceOverrides: { VOICE: input.sourcePath } });
    const invalid = { ...plan, final_mastering: { ...plan.final_mastering, count: 2 } } as unknown as typeof plan;
    expect(() => assertAudioRenderPlanContract(invalid)).toThrow(/more than one final mastering pass/);

    const invalidMissingPass = {
      ...plan,
      final_mastering: { ...plan.final_mastering, count: 0, stage: "not_applied" },
    } as unknown as typeof plan;
    expect(() => assertAudioRenderPlanContract(invalidMissingPass)).toThrow(/exactly one after_mix/);

    const originalTimeline = JSON.parse(fs.readFileSync(input.timelinePath, "utf8")) as TimelineIR;
    originalTimeline.provenance = {
      ...originalTimeline.provenance,
      audio_policy: { mode: "original_only", source: "global_default" },
    };
    fs.writeFileSync(input.timelinePath, `${JSON.stringify(originalTimeline)}\n`, "utf8");
    const originalPlan = resolveAudioRenderPlan({
      projectDir: root,
      timelinePath: input.timelinePath,
      sourceOverrides: { VOICE: input.sourcePath },
    });
    expect(originalPlan.strategy).toBe("original_passthrough");
    expect(originalPlan.final_mastering).toMatchObject({ count: 0, stage: "not_applied" });
    expect(validateAudioRenderPlanContract(originalPlan)).toEqual({ valid: true, errors: [] });
  });
});

describe("RFA-023 profile-only package QA", () => {
  it("treats a profile-only shared plan as authoritative and holds missing or partial evidence", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-audio-profile-only-"));
    tempRoots.push(root);
    const input = minimalTimeline(root);
    const timeline = JSON.parse(fs.readFileSync(input.timelinePath, "utf8")) as TimelineIR;
    timeline.tracks.audio = timeline.tracks.audio.filter((track) => track.track_id !== "A3");
    const verifiedProfilePath = path.join(repoRoot, "delivery_profiles/audio/fixture/verified-internal-v1.yaml");
    timeline.metadata = {
      ...(timeline.metadata ?? {}),
      audio_delivery_profile_ref: { ref: verifiedProfilePath },
    };
    fs.writeFileSync(input.timelinePath, `${JSON.stringify(timeline)}\n`, "utf8");

    const plan = resolveSharedAudioRenderPlan({
      projectDir: root,
      timelinePath: input.timelinePath,
      sourceOverrides: { VOICE: input.sourcePath },
      audioProfilePath: verifiedProfilePath,
    });
    if (!plan) throw new Error("profile-only timeline did not select the shared route");
    expect(plan.strategy).toBe("dialogue_only");
    expect(plan.audio_delivery_profile?.profile_id).toBe("audio-fixture-verified-internal-v1");

    const report = {
      version: "audio-mix-report/v2",
      has_bgm: false,
      strategy: "shared_audio_render_plan_v1",
      mastering_count: 1,
      final_mastering: {
        applied: true,
        loudness_target_lufs: -16,
        lra_target: 7,
        true_peak_target_dbtp: -1.5,
        premaster_measurement: null,
        output_measurement: null,
        owner: "shared_audio_render_plan",
        stage: "after_mix",
      },
      audio_delivery_profile: plan.audio_delivery_profile,
    } as unknown as AudioMixReport;
    const missingEvidence = checkAudioMixPolicy(
      report,
      false,
      false,
      undefined,
      undefined,
      { ref: verifiedProfilePath },
      repoRoot,
    );
    expect(missingEvidence.passed).toBe(false);
    expect(missingEvidence.details).toMatch(/encoded-result audio evidence is required/);

    const partialProfilePath = path.join(repoRoot, "delivery_profiles/audio/fixture/partial-v1.yaml");
    timeline.metadata = {
      ...(timeline.metadata ?? {}),
      audio_delivery_profile_ref: { ref: partialProfilePath },
    };
    fs.writeFileSync(input.timelinePath, `${JSON.stringify(timeline)}\n`, "utf8");
    const partialPlan = resolveSharedAudioRenderPlan({
      projectDir: root,
      timelinePath: input.timelinePath,
      sourceOverrides: { VOICE: input.sourcePath },
      audioProfilePath: partialProfilePath,
      audioProfileId: "audio-fixture-partial-v1",
      audioProfileRootDir: repoRoot,
    });
    if (!partialPlan?.audio_delivery_profile) throw new Error("partial profile was not carried into the plan");
    const partialReport = { ...report, audio_delivery_profile: partialPlan.audio_delivery_profile } as AudioMixReport;
    const partialEvidence = checkAudioMixPolicy(
      partialReport,
      false,
      false,
      undefined,
      undefined,
      { ref: partialProfilePath },
      repoRoot,
    );
    expect(partialEvidence.passed).toBe(false);
    expect(partialEvidence.details).toMatch(/human HOLD remains required/);
  });
});

describe("RFA-012 encoded-result audio evidence", () => {
  it("parses loudnorm evidence and keeps human audition separate", () => {
    const parsed = parseLoudnormOutput(`noise\n{\n  "input_i" : "-17.25",\n  "input_tp" : "-1.42",\n  "input_lra" : "5.10",\n  "input_thresh" : "-28.00",\n  "target_offset" : "0.25"\n}`);
    expect(parsed).toMatchObject({ input_i: "-17.25", input_tp: "-1.42" });
    expect(buildEncodedAudioProbeArgs("encoded.mp4")).toContain("encoded.mp4");
    expect(buildMonoFoldDownArgs("encoded.mp4")).toContain("pan=mono|c0=0.5*c0+0.5*c1");
    expect(buildAudioDiagnosticArgs("encoded.mp4", { silenceThresholdDb: -60 })).toContain("silencedetect=noise=-60dB:d=0.5,astats=metadata=1:reset=1");
  });

  it("preserves missing ffprobe cause and does not synthesize loudness values", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-encoded-no-ffmpeg-"));
    tempRoots.push(root);
    const fixture = path.join(root, "missing-tools.wav");
    fs.writeFileSync(fixture, "not an encoded media file", "utf8");
    const emptyBin = path.join(root, "empty-bin");
    fs.mkdirSync(emptyBin);
    const previousPath = process.env.PATH;
    process.env.PATH = emptyBin;
    try {
      const result = await measureEncodedAudioResult({ path: fixture, runMonoFoldDown: true });
      expect(result.status).toBe("unavailable");
      expect(result.error).toMatchObject({ tool: "ffprobe", code: "ENOENT" });
      expect(result.loudness).toMatchObject({
        status: "unavailable",
        integrated_lufs: null,
        true_peak_dbtp: null,
      });
      expect(result.warnings.join(" ")).toMatch(/ENOENT/);
      expect(result.warnings.join(" ")).not.toMatch(/-24|-1/);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it("measures a synthetic encoded fixture when ffmpeg is available, otherwise records HOLD evidence", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-encoded-audio-"));
    tempRoots.push(root);
    const fixture = path.join(root, "fixture.wav");
    let ffmpegAvailable = true;
    try {
      await execFileAsync("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.4", "-ar", "48000", "-ac", "2", fixture]);
    } catch {
      ffmpegAvailable = false;
    }
    const result = await measureEncodedAudioResult({ path: fixture, runMonoFoldDown: true });
    expect(result.human_audition.status).toBe("pending");
    expect(result.speech_intelligibility.status).toBe("not_claimed");
    expect(result.playback.mobile.status).toBe("human_required");
    if (ffmpegAvailable) {
      expect(result.status).toBe("verified");
      expect(result.audio_stream.sample_rate_hz).toBe(48000);
      expect(result.audio_stream.channels).toBe(2);
      expect(result.loudness.status).toBe("measured");
      expect(result.loudness.integrated_lufs).not.toBeNull();
      expect(result.loudness.true_peak_dbtp).not.toBeNull();
      expect(result.duration_and_sync.status).toBe("not_applicable");

      const avFixture = path.join(root, "fixture.mp4");
      await execFileAsync("ffmpeg", [
        "-y",
        "-f", "lavfi", "-i", "color=c=black:s=160x90:r=24:d=0.4",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=0.4",
        "-shortest",
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-ar", "48000",
        "-ac", "2",
        avFixture,
      ]);
      const avResult = await measureEncodedAudioResult({ path: avFixture, runMonoFoldDown: true });
      expect(avResult.container.format_name).toContain("mp4");
      expect(avResult.audio_stream.codec_name).toBe("aac");
      expect(avResult.video_stream).not.toBeNull();
      expect(avResult.duration_and_sync.status).toBe("measured");
      expect(avResult.duration_and_sync.duration_delta_sec).not.toBeNull();
    } else {
      expect(["unavailable", "failed"]).toContain(result.status);
    }
  }, 30_000);
});
