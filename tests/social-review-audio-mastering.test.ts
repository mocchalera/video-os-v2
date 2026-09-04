import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSocialReviewAudioReceipt,
  verifySocialReviewAudioReceipt,
  type SocialReviewAudioReceipt,
} from "../runtime/review/social-review-audio.js";
import {
  findProjectLocalLoudnormDuplicates,
} from "../runtime/audio/project-local-mastering-guard.js";
import { masterAudio } from "../runtime/audio/mastering.js";
import {
  writeReviewAudioIdentityMedia,
  type ReviewAudioMismatchKind,
} from "./helpers/social-review-audio-media.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempFixture(audioPresent = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "social-review-audio-"));
  roots.push(root);
  const input = path.join(root, "premaster.wav");
  const output = path.join(root, "mastered.wav");
  const video = path.join(root, "review.mp4");
  for (const file of [input, output]) {
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1", "-ac", "2", "-y", file]);
  }
  const videoArgs = ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=25:d=1"];
  if (audioPresent) videoArgs.push("-i", output, "-shortest", "-c:a", "aac");
  execFileSync("ffmpeg", [...videoArgs, "-c:v", "libx264", "-y", video]);
  return { root, input, output, video };
}

function realMediaFixture(videoFrequency = 440) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "social-review-audio-real-"));
  roots.push(root);
  const input = path.join(root, "premaster.wav");
  const output = path.join(root, "mastered.wav");
  const videoAudio = path.join(root, "video-audio.wav");
  const video = path.join(root, "review.mp4");
  for (const [file, frequency] of [[input, 440], [output, 440], [videoAudio, videoFrequency]] as const) {
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `sine=frequency=${frequency}:sample_rate=48000:duration=1`, "-ac", "2", "-y", file]);
  }
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=25:d=1", "-i", videoAudio, "-shortest", "-c:v", "libx264", "-c:a", "aac", "-y", video]);
  return { root, input, output, video };
}

function decodedSummary(filePath: string, channelCount = 1) {
  const pcm = execFileSync("ffmpeg", [
    "-v", "error", "-i", filePath, "-map", "0:a:0", "-ac", String(channelCount), "-ar", "8000", "-f", "s16le", "-",
  ], { encoding: null });
  const samples = Math.floor(pcm.length / (channelCount * 2));
  let crossings = 0;
  let previous = pcm.readInt16LE(0);
  for (let offset = 0; offset < samples * 2; offset += 2) {
    const sample = pcm.readInt16LE(offset);
    if ((previous < 0 && sample >= 0) || (previous >= 0 && sample < 0)) crossings += 1;
    previous = sample;
  }
  return { samples, frequency: Math.round(((crossings / 2) / (samples / 8000)) / 5) * 5 };
}

async function pcmToAacFixture(kind: "single-tone" | "dialogue-like", durationSeconds = 10) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "social-review-audio-aac-"));
  roots.push(root);
  const input = path.join(root, "premaster.wav");
  const output = path.join(root, "mastered.wav");
  const video = path.join(root, "review.mp4");
  const source = kind === "single-tone"
    ? `aevalsrc=if(between(t\\,1\\,5.0075)\\,0.7*sin(2*PI*440*t)\\,0):s=48000:d=${durationSeconds}`
    : `aevalsrc=if(between(t\\,1\\,7)\\,0.12*(sin(2*PI*180*t)+0.6*sin(2*PI*420*t)+0.3*sin(2*PI*900*t))*if(lt(mod(t\\,1.2)\\,0.85)\\,1\\,0)\\,0):s=48000:d=${durationSeconds}`;
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", source, "-ac", "2", "-c:a", "pcm_s24le", "-y", input]);
  await masterAudio(input, output, policy);
  execFileSync("ffmpeg", [
    "-v", "error", "-f", "lavfi", "-i", `color=c=black:s=64x64:r=25:d=${durationSeconds}`,
    "-i", output,
    "-filter_complex", `[1:a]apad,atrim=duration=${durationSeconds.toFixed(9)}[a]`,
    "-map", "0:v:0", "-map", "[a]",
    "-c:v", "libx264", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-y", video,
  ]);
  return { root, input, output, video };
}

function mismatchedPcmToAacFixture(kind: ReviewAudioMismatchKind) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "social-review-audio-mismatch-"));
  roots.push(root);
  const input = path.join(root, "premaster.wav");
  const media = writeReviewAudioIdentityMedia({ root, kind, durationSeconds: 2 });
  fs.copyFileSync(media.outputAudioPath, input);
  return { root, input, output: media.outputAudioPath, video: media.mismatchedVideoPath };
}

const policy = {
  loudness_target_lufs: -16,
  lra_target: 7,
  true_peak_target_dbtp: -1.5,
};

const measurement = {
  input_i: "-16.1",
  input_tp: "-1.8",
  input_lra: "4.2",
  input_thresh: "-26.4",
  target_offset: "0.1",
};
const sharedAudioPlanHash = `sha256:${"9".repeat(64)}`;

function fileHash(filePath: string): string {
  return `sha256:${createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
}

function musicMasterReceiptPlan(inputPath: string, audioDecision: "preserve" | "mastering" = "preserve") {
  const sourceHash = fileHash(inputPath);
  return {
    enabled: true as const,
    source: {
      role: "music_master" as const,
      asset_id: "SONG_FULL_01",
      source_ref: "premaster.wav",
      source_content_hash: sourceHash,
      source_size_bytes: fs.statSync(inputPath).size,
      source_duration_us: 1_000_000,
      source_range_us: { in_us: 0, out_us: 1_000_000 },
      timeline_range: { in_frame: 0, out_frame: 24 },
      gain_linear: 1 as const,
      channel_layout: "stereo",
      codec: "pcm_s16le",
    },
    audio_decision: audioDecision,
    input_audio_hash: sourceHash,
    policy_hash: `sha256:${"a".repeat(64)}`,
    processing_graph: {
      version: "audio-processing-graph/v1" as const,
      operations: [audioDecision === "preserve" ? "stream_copy" as const : "shared_final_mastering" as const],
    },
    codec: {
      input: "pcm_s16le",
      output: audioDecision === "preserve" ? "pcm_s16le" : "pcm_s24le",
      operation: audioDecision === "preserve" ? "stream_copy" as const : "reencode" as const,
    },
    measurement_tolerance: {
      integrated_lufs_db: 0.5,
      lra_lu: 0.5,
      true_peak_dbtp: 0.5,
    },
  };
}

describe("Issue #23 social-review audio mastering receipt", () => {
  it("accepts only plan-bound music_master preserve at count zero and binds the final mux evidence", () => {
    const fixture = tempFixture();
    fs.copyFileSync(fixture.input, fixture.output);
    const musicMaster = musicMasterReceiptPlan(fixture.input);
    const receipt = buildSocialReviewAudioReceipt({
      projectDir: fixture.root,
      state: "mastered",
      generationId: `sha256:${"0".repeat(64)}`,
      sharedAudioPlanHash,
      inputAudioPath: fixture.input,
      outputAudioPath: fixture.output,
      reviewVideoPath: fixture.video,
      policy,
      masteringCount: 0,
      inputKind: "premaster",
      musicMaster,
    });
    expect(receipt).toMatchObject({
      reason: "shared_audio_render_plan_preserve",
      mastering_count: 0,
      music_master: {
        audio_decision: "preserve",
        input_audio_hash: fileHash(fixture.input),
        source: { source_content_hash: fileHash(fixture.input), gain_linear: 1 },
        final_mux: { operation: "reencode", codec: "aac" },
      },
    });
    expect(() => verifySocialReviewAudioReceipt(receipt, {
      projectDir: fixture.root,
      generationId: receipt.generation_id,
      expectedAudioPlanHash: receipt.audio_plan_sha256,
      expectedSharedAudioPlanHash: sharedAudioPlanHash,
      reviewVideoPath: fixture.video,
    })).not.toThrow();

    const mastering = musicMasterReceiptPlan(fixture.input, "mastering");
    for (const masteringCount of [0, 2]) {
      expect(() => buildSocialReviewAudioReceipt({
        projectDir: fixture.root,
        state: "mastered",
        generationId: `sha256:${"0".repeat(63)}${masteringCount}`,
        sharedAudioPlanHash,
        inputAudioPath: fixture.input,
        outputAudioPath: fixture.output,
        reviewVideoPath: fixture.video,
        policy,
        masteringCount,
        inputKind: "premaster",
        musicMaster: mastering,
      })).toThrow(/exactly once|count/);
    }
  });

  it("binds a shared exactly-once mastering result through input, policy, measurement, output, generation, and review video", () => {
    const fixture = tempFixture();
    const receipt = buildSocialReviewAudioReceipt({
      projectDir: fixture.root,
      state: "mastered",
      generationId: `sha256:${"a".repeat(64)}`,
      sharedAudioPlanHash,
      inputAudioPath: fixture.input,
      outputAudioPath: fixture.output,
      reviewVideoPath: fixture.video,
      policy,
      masteringCount: 1,
      inputKind: "premaster",
    });

    expect(receipt.state).toBe("mastered");
    expect(receipt.mastering_count).toBe(1);
    expect(receipt.measurement).toEqual({
      integrated_lufs: Number(receipt.measurement_raw!.input_i),
      true_peak_dbtp: Number(receipt.measurement_raw!.input_tp),
    });
    expect(() => verifySocialReviewAudioReceipt(receipt, {
      projectDir: fixture.root,
      generationId: receipt.generation_id,
      expectedAudioPlanHash: receipt.audio_plan_sha256,
      reviewVideoPath: fixture.video,
    })).not.toThrow();
    const wrongCurrentPlan = {
      generationId: receipt.generation_id,
      expectedAudioPlanHash: receipt.audio_plan_sha256,
      expectedSharedAudioPlanHash: `sha256:${"8".repeat(64)}`,
      reviewVideoPath: fixture.video,
    } as Parameters<typeof verifySocialReviewAudioReceipt>[1];
    expect(() => verifySocialReviewAudioReceipt(receipt, wrongCurrentPlan))
      .toThrow(/current|canonical|shared.*plan/i);

    for (const [label, mutate] of [
      ["generation", (value: SocialReviewAudioReceipt) => { value.generation_id = `sha256:${"b".repeat(64)}`; }],
      ["audio plan", (value: SocialReviewAudioReceipt) => { value.shared_audio_plan_sha256 = `sha256:${"b".repeat(64)}`; }],
      ["input", (value: SocialReviewAudioReceipt) => { value.input_audio!.sha256 = `sha256:${"b".repeat(64)}`; }],
      ["policy", (value: SocialReviewAudioReceipt) => { value.policy.sha256 = `sha256:${"b".repeat(64)}`; }],
      ["method", (value: SocialReviewAudioReceipt) => { value.measurement_method = "manual" as never; }],
      ["measurement", (value: SocialReviewAudioReceipt) => { value.measurement!.integrated_lufs += 0.1; }],
      ["output", (value: SocialReviewAudioReceipt) => { value.output_audio!.sha256 = `sha256:${"b".repeat(64)}`; }],
      ["output channels", (value: SocialReviewAudioReceipt) => { value.output_audio!.channel_count = 1; }],
      ["video", (value: SocialReviewAudioReceipt) => { value.review_video.sha256 = `sha256:${"b".repeat(64)}`; }],
      ["video audio", (value: SocialReviewAudioReceipt) => { value.review_video_audio.content_fingerprint_sha256 = `sha256:${"b".repeat(64)}`; }],
      ["video channel", (value: SocialReviewAudioReceipt) => {
        if (value.review_video_audio.state === "present") {
          value.review_video_audio.channel_fingerprint_sha256[0] = `sha256:${"b".repeat(64)}`;
        }
      }],
    ] as Array<[string, (value: SocialReviewAudioReceipt) => void]>) {
      const forged = structuredClone(receipt);
      mutate(forged);
      expect(() => verifySocialReviewAudioReceipt(forged, {
        projectDir: fixture.root,
        generationId: receipt.generation_id,
        expectedAudioPlanHash: receipt.audio_plan_sha256,
        reviewVideoPath: fixture.video,
      }), label).toThrow();
    }

    fs.appendFileSync(fixture.input, "x");
    expect(() => verifySocialReviewAudioReceipt(receipt, {
      projectDir: fixture.root,
      generationId: receipt.generation_id,
      expectedAudioPlanHash: receipt.audio_plan_sha256,
      reviewVideoPath: fixture.video,
    })).toThrow(/input audio.*hash/i);
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1", "-ac", "2", "-y", fixture.input]);
    fs.appendFileSync(fixture.output, "x");
    expect(() => verifySocialReviewAudioReceipt(receipt, {
      projectDir: fixture.root,
      generationId: receipt.generation_id,
      expectedAudioPlanHash: receipt.audio_plan_sha256,
      reviewVideoPath: fixture.video,
    })).toThrow(/output audio.*hash/i);
  });

  it("uses explicit not_applicable state for a video without audio and carries no fictional measurement", () => {
    const fixture = tempFixture(false);
    const receipt = buildSocialReviewAudioReceipt({
      projectDir: fixture.root,
      state: "not_applicable",
      reason: "review_video_has_no_audio_stream",
      generationId: `sha256:${"c".repeat(64)}`,
      reviewVideoPath: fixture.video,
      policy,
    });
    expect(receipt).toMatchObject({
      state: "not_applicable",
      reason: "review_video_has_no_audio_stream",
      mastering_count: 0,
      input_audio: null,
      output_audio: null,
      measurement_method: "not_applicable",
      measurement: null,
    });
    expect(() => verifySocialReviewAudioReceipt(receipt, {
      projectDir: fixture.root,
      generationId: receipt.generation_id,
      expectedAudioPlanHash: receipt.audio_plan_sha256,
      reviewVideoPath: fixture.video,
    })).not.toThrow();
  });

  it("rejects mixed, already-mastered, and repeated mastering before receipt/write", () => {
    const fixture = tempFixture();
    for (const inputKind of ["mixed", "already_mastered"] as const) {
      expect(() => buildSocialReviewAudioReceipt({
        projectDir: fixture.root,
        state: "mastered",
        generationId: `sha256:${"d".repeat(64)}`,
        sharedAudioPlanHash,
        inputAudioPath: fixture.input,
        outputAudioPath: fixture.output,
        reviewVideoPath: fixture.video,
        policy,
        masteringCount: 1,
        inputKind,
      })).toThrow(/mixed|already.mastered|double/i);
    }
    expect(() => buildSocialReviewAudioReceipt({
      projectDir: fixture.root,
      state: "mastered",
      generationId: `sha256:${"e".repeat(64)}`,
      sharedAudioPlanHash,
      inputAudioPath: fixture.input,
      outputAudioPath: fixture.output,
      reviewVideoPath: fixture.video,
      policy,
      masteringCount: 2,
      inputKind: "premaster",
    })).toThrow(/exactly once|mastering count/i);
  });

  it("changes policy identity and rejects stale policy or caller-authored report measurements", () => {
    const fixture = tempFixture();
    const first = buildSocialReviewAudioReceipt({
      projectDir: fixture.root,
      state: "mastered",
      generationId: `sha256:${"f".repeat(64)}`,
      sharedAudioPlanHash,
      inputAudioPath: fixture.input,
      outputAudioPath: fixture.output,
      reviewVideoPath: fixture.video,
      policy,
      masteringCount: 1,
      inputKind: "premaster",
    });
    const changed = buildSocialReviewAudioReceipt({
      projectDir: fixture.root,
      state: "mastered",
      generationId: first.generation_id,
      sharedAudioPlanHash,
      inputAudioPath: fixture.input,
      outputAudioPath: fixture.output,
      reviewVideoPath: fixture.video,
      policy: { ...policy, loudness_target_lufs: -18 },
      masteringCount: 1,
      inputKind: "premaster",
    });
    expect(changed.policy.sha256).not.toBe(first.policy.sha256);
    expect(changed.audio_plan_sha256).not.toBe(first.audio_plan_sha256);
    expect(() => verifySocialReviewAudioReceipt(changed, {
      projectDir: fixture.root,
      generationId: first.generation_id,
      expectedAudioPlanHash: first.audio_plan_sha256,
      reviewVideoPath: fixture.video,
    })).toThrow(/plan|policy|generation/i);
    expect(() => verifySocialReviewAudioReceipt(first, {
      projectDir: fixture.root,
      generationId: first.generation_id,
      expectedAudioPlanHash: changed.audio_plan_sha256,
      reviewVideoPath: fixture.video,
      expectedPolicy: { ...policy, loudness_target_lufs: -18 },
    })).toThrow(/policy/i);
    expect(() => verifySocialReviewAudioReceipt(first, {
      projectDir: fixture.root,
      generationId: first.generation_id,
      expectedAudioPlanHash: first.audio_plan_sha256,
      reviewVideoPath: fixture.video,
      reportMeasurement: { integrated_lufs: -14, true_peak_dbtp: -0.5 },
    })).toThrow(/report|measurement/i);
  });

  it("rejects self-consistent forged loudness metadata after remeasuring bound output bytes", () => {
    const fixture = realMediaFixture();
    const receipt = buildSocialReviewAudioReceipt({
      projectDir: fixture.root,
      state: "mastered", generationId: `sha256:${"1".repeat(64)}`, sharedAudioPlanHash,
      inputAudioPath: fixture.input, outputAudioPath: fixture.output, reviewVideoPath: fixture.video,
      policy, masteringCount: 1, inputKind: "premaster",
    });
    receipt.measurement_raw!.input_i = String(Number(receipt.measurement_raw!.input_i) + 6);
    receipt.measurement_raw!.input_tp = String(Number(receipt.measurement_raw!.input_tp) + 6);
    receipt.measurement!.integrated_lufs = Number(receipt.measurement_raw!.input_i);
    receipt.measurement!.true_peak_dbtp = Number(receipt.measurement_raw!.input_tp);
    expect(() => verifySocialReviewAudioReceipt(receipt, {
      projectDir: fixture.root,
      generationId: receipt.generation_id,
      expectedAudioPlanHash: receipt.audio_plan_sha256,
      reviewVideoPath: fixture.video,
    })).toThrow(/remeasure|loudness|true peak|output audio/i);
  });

  it("keeps the independent loudness comparison tolerance bounded at 0.1", () => {
    const fixture = realMediaFixture();
    const receipt = buildSocialReviewAudioReceipt({
      projectDir: fixture.root,
      state: "mastered", generationId: `sha256:${"5".repeat(64)}`, sharedAudioPlanHash,
      inputAudioPath: fixture.input, outputAudioPath: fixture.output, reviewVideoPath: fixture.video,
      policy, masteringCount: 1, inputKind: "premaster",
    });
    const within = structuredClone(receipt);
    within.measurement_raw!.input_i = String(Number(receipt.measurement_raw!.input_i) + 0.099);
    within.measurement!.integrated_lufs = Number(within.measurement_raw!.input_i);
    expect(() => verifySocialReviewAudioReceipt(within, {
      projectDir: fixture.root,
      generationId: receipt.generation_id,
      expectedAudioPlanHash: receipt.audio_plan_sha256,
      reviewVideoPath: fixture.video,
    })).not.toThrow();

    const outside = structuredClone(receipt);
    outside.measurement_raw!.input_i = String(Number(receipt.measurement_raw!.input_i) + 0.101);
    outside.measurement!.integrated_lufs = Number(outside.measurement_raw!.input_i);
    expect(() => verifySocialReviewAudioReceipt(outside, {
      projectDir: fixture.root,
      generationId: receipt.generation_id,
      expectedAudioPlanHash: receipt.audio_plan_sha256,
      reviewVideoPath: fixture.video,
    })).toThrow(/remeasure|loudness|output audio/i);
  });

  it("rejects a zero-byte mastered output before creating a receipt", () => {
    const fixture = realMediaFixture();
    fs.writeFileSync(fixture.output, "");
    expect(() => buildSocialReviewAudioReceipt({
      projectDir: fixture.root,
      state: "mastered", generationId: `sha256:${"6".repeat(64)}`, sharedAudioPlanHash,
      inputAudioPath: fixture.input, outputAudioPath: fixture.output, reviewVideoPath: fixture.video,
      policy, masteringCount: 1, inputKind: "premaster",
    })).toThrow(/ffmpeg|audio|decode|remeasure/i);
  });

  it("rejects A/B mastered audio mixing and false not_applicable against the final video stream", () => {
    const mixed = realMediaFixture(880);
    expect(() => buildSocialReviewAudioReceipt({
      projectDir: mixed.root,
      state: "mastered", generationId: `sha256:${"2".repeat(64)}`, sharedAudioPlanHash,
      inputAudioPath: mixed.input, outputAudioPath: mixed.output, reviewVideoPath: mixed.video,
      policy, masteringCount: 1, inputKind: "premaster",
    })).toThrow(/video audio|content|fingerprint|mux/i);
    expect(() => buildSocialReviewAudioReceipt({
      projectDir: mixed.root,
      state: "not_applicable", reason: "review_video_has_no_audio_stream",
      generationId: `sha256:${"3".repeat(64)}`, reviewVideoPath: mixed.video, policy,
    })).toThrow(/audio stream|not_applicable/i);
  });

  it.each(["single-tone", "dialogue-like"] as const)(
    "accepts valid %s PCM to normal AAC review mux without weakening byte bindings",
    async (kind) => {
      const fixture = await pcmToAacFixture(kind);
      const outputSummary = decodedSummary(fixture.output);
      const videoSummary = decodedSummary(fixture.video);
      expect(videoSummary.samples - outputSummary.samples).toBeGreaterThan(0);
      if (kind === "single-tone") expect(videoSummary.frequency).not.toBe(outputSummary.frequency);
      const receipt = buildSocialReviewAudioReceipt({
        projectDir: fixture.root,
        state: "mastered", generationId: `sha256:${"4".repeat(64)}`, sharedAudioPlanHash,
        inputAudioPath: fixture.input, outputAudioPath: fixture.output, reviewVideoPath: fixture.video,
        policy, masteringCount: 1, inputKind: "premaster",
      });
      expect(() => verifySocialReviewAudioReceipt(receipt, {
        projectDir: fixture.root,
        generationId: receipt.generation_id,
        expectedAudioPlanHash: receipt.audio_plan_sha256,
        reviewVideoPath: fixture.video,
      })).not.toThrow();
    },
  );

  it("accepts a valid 4-second stereo PCM to production-equivalent AAC review mux", async () => {
    const fixture = await pcmToAacFixture("dialogue-like", 4);
    const outputSummary = decodedSummary(fixture.output, 2);
    const videoSummary = decodedSummary(fixture.video, 2);
    expect(outputSummary.samples).toBe(32_000);
    expect(videoSummary.samples).toBe(32_086);
    expect(videoSummary.samples - outputSummary.samples).toBe(86);

    const receipt = buildSocialReviewAudioReceipt({
      projectDir: fixture.root,
      state: "mastered", generationId: `sha256:${"9".repeat(64)}`, sharedAudioPlanHash,
      inputAudioPath: fixture.input, outputAudioPath: fixture.output, reviewVideoPath: fixture.video,
      policy, masteringCount: 1, inputKind: "premaster",
    });
    expect(receipt.output_audio?.channel_count).toBe(2);
    expect(receipt.review_video_audio.state).toBe("present");
    if (receipt.review_video_audio.state === "present") {
      expect(receipt.review_video_audio.channel_count).toBe(2);
    }
    expect(() => verifySocialReviewAudioReceipt(receipt, {
      projectDir: fixture.root,
      generationId: receipt.generation_id,
      expectedAudioPlanHash: receipt.audio_plan_sha256,
      reviewVideoPath: fixture.video,
    })).not.toThrow();
  });

  it("accepts valid stereo PCM to normal AAC without swapping channel identity", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "social-review-audio-stereo-aac-"));
    roots.push(root);
    const media = writeReviewAudioIdentityMedia({ root, kind: "stereo-swap", durationSeconds: 2 });
    const receipt = buildSocialReviewAudioReceipt({
      projectDir: root,
      state: "mastered", generationId: `sha256:${"5".repeat(64)}`, sharedAudioPlanHash,
      inputAudioPath: media.outputAudioPath, outputAudioPath: media.outputAudioPath,
      reviewVideoPath: media.matchingVideoPath,
      policy, masteringCount: 1, inputKind: "premaster",
    });
    expect(receipt.output_audio?.channel_count).toBe(2);
    expect(receipt.output_audio?.channel_fingerprint_sha256).toHaveLength(2);
    expect(() => verifySocialReviewAudioReceipt(receipt, {
      projectDir: root,
      generationId: receipt.generation_id,
      expectedAudioPlanHash: receipt.audio_plan_sha256,
      reviewVideoPath: media.matchingVideoPath,
    })).not.toThrow();
  });

  it.each(["near-tone", "truncated", "near-speech", "level-plus-1.5db", "stereo-swap"] as const)(
    "rejects decoded-content mismatch %s despite codec-tolerant aggregate summaries",
    (kind) => {
      const fixture = mismatchedPcmToAacFixture(kind);
      expect(() => buildSocialReviewAudioReceipt({
        projectDir: fixture.root,
        state: "mastered", generationId: `sha256:${"7".repeat(64)}`, sharedAudioPlanHash,
        inputAudioPath: fixture.input, outputAudioPath: fixture.output, reviewVideoPath: fixture.video,
        policy, masteringCount: 1, inputKind: "premaster",
      })).toThrow(/video audio|content|decoded|duration|fingerprint/i);
    },
  );

  it.each(["duration-300ms", "level-minus-6db", "envelope-change", "offset-50ms"] as const)(
    "keeps prior decoded-content rejection %s",
    (kind) => {
      const fixture = mismatchedPcmToAacFixture(kind);
      expect(() => buildSocialReviewAudioReceipt({
        projectDir: fixture.root,
        state: "mastered", generationId: `sha256:${"8".repeat(64)}`, sharedAudioPlanHash,
        inputAudioPath: fixture.input, outputAudioPath: fixture.output, reviewVideoPath: fixture.video,
        policy, masteringCount: 1, inputKind: "premaster",
      })).toThrow(/video audio|content|decoded|duration|level|envelope|fingerprint/i);
    },
  );
});

describe("Issue #23 project-local duplicate loudnorm guard", () => {
  it("detects executable project-local two-pass loudnorm but ignores documentation strings", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-local-mastering-"));
    roots.push(root);
    const reviewDir = path.join(root, "projects", "sample", "06_review");
    fs.mkdirSync(reviewDir, { recursive: true });
    fs.writeFileSync(path.join(reviewDir, "safe.ts"), [
      "// loudnorm linear=true JSON.parse(stderr) belongs in shared runtime",
      "export const documentation = 'measured_I is described here';",
      "",
    ].join("\n"));
    expect(findProjectLocalLoudnormDuplicates(root)).toEqual([]);

    fs.writeFileSync(path.join(reviewDir, "duplicate.mjs"), [
      "import { execFileSync } from 'node:child_process';",
      "const first = execFileSync('ffmpeg', ['-af', 'loudnorm=I=-16:print_format=json']);",
      "const measured = JSON.parse(first.toString());",
      "execFileSync('ffmpeg', ['-af', `loudnorm=I=-16:measured_I=${measured.input_i}:linear=true`]);",
      "",
    ].join("\n"));
    expect(findProjectLocalLoudnormDuplicates(root)).toMatchObject([
      { file: "projects/sample/06_review/duplicate.mjs" },
    ]);

    fs.unlinkSync(path.join(reviewDir, "duplicate.mjs"));
    fs.writeFileSync(path.join(reviewDir, "aliased.ts"), [
      "import { spawnSync as run } from 'node:child_process';",
      "const bin = 'ffmpeg';",
      "const pass1 = ['-af', 'loudnorm=I=-16:print_format=json'];",
      "const first = run(bin, pass1);",
      "const measured = JSON.parse(first.stderr.toString());",
      "const pass2 = ['-af', `loudnorm=I=-16:measured_I=${measured.input_i}:linear=true`];",
      "run(bin, pass2);",
      "",
    ].join("\n"));
    expect(findProjectLocalLoudnormDuplicates(root)).toMatchObject([
      { file: "projects/sample/06_review/aliased.ts" },
    ]);

    fs.writeFileSync(path.join(reviewDir, "direct.js"), [
      "const { spawnSync } = require('node:child_process');",
      "spawnSync('ffmpeg', ['-af', 'loudnorm=I=-16:print_format=json']);",
      "JSON.parse('{}');",
      "spawnSync('ffmpeg', ['-af', 'loudnorm=I=-16:measured_I=-20:linear=true']);",
      "",
    ].join("\n"));
    expect(findProjectLocalLoudnormDuplicates(root).map((item) => item.file)).toEqual([
      "projects/sample/06_review/aliased.ts",
      "projects/sample/06_review/direct.js",
    ]);
    expect(findProjectLocalLoudnormDuplicates(path.resolve("."))).toEqual([]);
  });
});
