/**
 * Issue #38 — AI-music dedicated mastering chain.
 *
 * Unit tests cover the policy (fail-closed resolution, including the
 * separated loudnorm processing true-peak target vs the -1.0 dBTP
 * acceptance ceiling), the real ffmpeg filter-path construction (3-stage
 * tone chain + 2-pass loudnorm), the fail-closed receipt schema contract,
 * and CLI argument parsing.
 *
 * Integration tests execute the chain with a real ffmpeg build when one
 * is available and verify the Issue #38 acceptance band numerically:
 * integrated -13.3 ± 0.5 LUFS, true peak <= -1.0 dBTP, 24-bit WAV and
 * 320 kbps MP3 deliveries — including a deterministic hot-crest success
 * run where the loudnorm limiter genuinely engages. Machines without the
 * required tooling fail into the explicit capability branch instead of
 * running the numbers.
 */

import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  AI_MUSIC_MULTIBAND_COMPAND_ARGS,
  AiMusicMasteringPolicyError,
  DEFAULT_AI_MUSIC_MASTERING,
  type AiMusicMasteringReceipt,
  buildAiMusicApplyFilter,
  buildAiMusicMasteringPass1Args,
  buildAiMusicMasteringPass2Args,
  buildAiMusicMeasurementFilter,
  buildAiMusicToneFilterChain,
  buildAiMusicToneFilters,
  buildVerification,
  detectAiMusicMasteringCapability,
  masterAiMusic,
  parseToolListingAvailability,
  resolveAiMusicMasteringPolicy,
  validateAiMusicMasteringReceipt,
  validateAiMusicMasteringReceiptIntegrity,
} from "../runtime/audio/ai-music-mastering.js";
import { validateAgainstSchema } from "../runtime/commands/shared.js";
import { loadAudioDeliveryProfile } from "../runtime/audio/delivery-profile.js";
import { computeSha256 } from "../runtime/packaging/manifest.js";
import {
  parseAiMusicMasterArgs,
  runAiMusicMasterCli,
} from "../scripts/ai-music-master.js";

const execFileAsync = promisify(execFile);

function ffmpegAvailable(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const capabilityPromise = detectAiMusicMasteringCapability();
const chainRuns = ffmpegAvailable() ? it : it.skip;
/**
 * Numeric verification bodies must never pass silently when ffmpeg runs on
 * this machine but the chain capability is incomplete: that is an
 * environment defect and fails the test loudly. (When ffmpeg itself is
 * missing, `chainRuns` already skips with an explicit marker.)
 */
async function requireFullCapability() {
  const capability = await capabilityPromise;
  if (!capability.available) {
    throw new Error(
      `ffmpeg is present but AI music mastering capability is incomplete: ${capability.missing.join(", ")}`,
    );
  }
  return capability;
}

describe("Issue #38 AI music mastering policy", () => {
  it("defaults to the Issue #38 chain values", () => {
    expect(DEFAULT_AI_MUSIC_MASTERING.route).toBe("standalone_sns_master");
    expect(DEFAULT_AI_MUSIC_MASTERING.loudness_target_lufs).toBe(-13.3);
    expect(DEFAULT_AI_MUSIC_MASTERING.loudness_tolerance_lufs).toBe(0.5);
    expect(DEFAULT_AI_MUSIC_MASTERING.true_peak_target_dbtp).toBe(-1.0);
    expect(DEFAULT_AI_MUSIC_MASTERING.processing_true_peak_target_dbtp).toBe(-2.0);
    expect(DEFAULT_AI_MUSIC_MASTERING.highpass_hz).toBe(35);
    expect(DEFAULT_AI_MUSIC_MASTERING.mud_cut_hz).toBe(280);
    expect(DEFAULT_AI_MUSIC_MASTERING.mud_cut_q).toBe(1.5);
    expect(DEFAULT_AI_MUSIC_MASTERING.mud_cut_gain_db).toBe(-2.0);
    expect(DEFAULT_AI_MUSIC_MASTERING.low_tight_hz).toBe(100);
    expect(DEFAULT_AI_MUSIC_MASTERING.low_tight_q).toBe(1.2);
    expect(DEFAULT_AI_MUSIC_MASTERING.low_tight_gain_db).toBe(1.8);
    expect(DEFAULT_AI_MUSIC_MASTERING.presence_hz).toBe(3_200);
    expect(DEFAULT_AI_MUSIC_MASTERING.presence_q).toBe(1.2);
    expect(DEFAULT_AI_MUSIC_MASTERING.presence_gain_db).toBe(2.5);
    expect(DEFAULT_AI_MUSIC_MASTERING.air_hz).toBe(12_000);
    expect(DEFAULT_AI_MUSIC_MASTERING.air_q).toBe(1.0);
    expect(DEFAULT_AI_MUSIC_MASTERING.air_gain_db).toBe(2.2);
    expect(DEFAULT_AI_MUSIC_MASTERING.stereo_width).toBe(1.2);
    expect(DEFAULT_AI_MUSIC_MASTERING.encode_mp3_320).toBe(true);
  });

  it("fills absent fields with the Issue #38 defaults", () => {
    const resolved = resolveAiMusicMasteringPolicy({});
    expect(resolved).toEqual(DEFAULT_AI_MUSIC_MASTERING);
    expect(resolveAiMusicMasteringPolicy()).toEqual(DEFAULT_AI_MUSIC_MASTERING);
  });

  it("accepts explicit in-range overrides", () => {
    const resolved = resolveAiMusicMasteringPolicy({
      route: "source_premaster",
      loudness_target_lufs: -14,
      stereo_width: 1.5,
      encode_mp3_320: false,
    });
    expect(resolved.route).toBe("source_premaster");
    expect(resolved.loudness_target_lufs).toBe(-14);
    expect(resolved.stereo_width).toBe(1.5);
    expect(resolved.encode_mp3_320).toBe(false);
    // Unspecified fields keep the issue defaults (fail-closed, not clamped).
    expect(resolved.presence_gain_db).toBe(2.5);
  });

  it("throws on out-of-range explicit values instead of clamping", () => {
    expect(() => resolveAiMusicMasteringPolicy({ loudness_target_lufs: -30 })).toThrow(
      /loudness_target_lufs must be within/,
    );
    expect(() => resolveAiMusicMasteringPolicy({ true_peak_target_dbtp: 0 })).toThrow(
      /true_peak_target_dbtp must be within/,
    );
    expect(() => resolveAiMusicMasteringPolicy({ processing_true_peak_target_dbtp: 0 })).toThrow(
      /processing_true_peak_target_dbtp must be within/,
    );
    // Cross-field fail-closed check: the processing target may never sit
    // above the acceptance ceiling.
    expect(() => resolveAiMusicMasteringPolicy({ true_peak_target_dbtp: -3.0 })).toThrow(
      /processing_true_peak_target_dbtp \(-2\) must be at or below the acceptance ceiling true_peak_target_dbtp \(-3\)/,
    );
    expect(() =>
      resolveAiMusicMasteringPolicy({
        true_peak_target_dbtp: -0.5,
        processing_true_peak_target_dbtp: -1.0,
      }),
    ).not.toThrow();
    expect(() => resolveAiMusicMasteringPolicy({ stereo_width: 4 })).toThrow(
      /stereo_width must be within/,
    );
    expect(() => resolveAiMusicMasteringPolicy({ mud_cut_q: "wide" })).toThrow(
      /mud_cut_q must be a finite number/,
    );
    expect(() => resolveAiMusicMasteringPolicy({ route: "master_loud" })).toThrow(
      /route must be standalone_sns_master or source_premaster/,
    );
    expect(() => resolveAiMusicMasteringPolicy([1, 2])).toThrow(
      /policy must be an object/,
    );
  });
});

describe("Issue #38 AI music mastering filter chain", () => {
  it("builds the three-stage tone chain with the exact issue EQ values", () => {
    const filters = buildAiMusicToneFilters(DEFAULT_AI_MUSIC_MASTERING);
    expect(filters[0]).toBe("highpass=f=35:p=2");
    expect(filters[1]).toBe("equalizer=f=280:t=q:w=1.5:g=-2");
    expect(filters[2]).toBe("equalizer=f=100:t=q:w=1.2:g=1.8");
    expect(filters[3]).toBe("equalizer=f=3200:t=q:w=1.2:g=2.5");
    expect(filters[4]).toBe("equalizer=f=12000:t=q:w=1:g=2.2");
    expect(filters[5]).toBe("extrastereo=m=1.2:c=false");
    expect(filters[6]).toBe(`mcompand='${AI_MUSIC_MULTIBAND_COMPAND_ARGS}'`);
    expect(AI_MUSIC_MULTIBAND_COMPAND_ARGS).toContain("-30/-27.5");
    expect(AI_MUSIC_MULTIBAND_COMPAND_ARGS.split("|")).toHaveLength(3);
    expect(AI_MUSIC_MULTIBAND_COMPAND_ARGS).toContain(" 3 -60/-60");
  });

  it("keeps the source premaster route free of any loudnorm stage", () => {
    // The shared post-mix mastering pass owns loudness normalization;
    // premaster tone conditioning must never normalize loudness.
    const chain = buildAiMusicToneFilterChain(DEFAULT_AI_MUSIC_MASTERING);
    expect(chain).not.toContain("loudnorm");
    expect(chain).toContain("highpass=f=35");
    expect(chain).toContain("extrastereo=m=1.2:c=false");
    expect(chain).toContain("mcompand=");
  });

  it("measures loudness after the tone chain in pass 1", () => {
    const filter = buildAiMusicMeasurementFilter(DEFAULT_AI_MUSIC_MASTERING);
    const loudnormIndex = filter.indexOf("loudnorm");
    expect(loudnormIndex).toBeGreaterThan(0);
    expect(filter.slice(0, loudnormIndex)).toContain("highpass=f=35");
    expect(filter.slice(0, loudnormIndex)).toContain("mcompand=");
    // loudnorm processes at the separate -2.0 dBTP processing target;
    // the -1.0 dBTP acceptance ceiling is enforced by verification only.
    expect(filter).toContain("loudnorm=I=-13.3:LRA=11:TP=-2:print_format=json");
    expect(filter).not.toContain("TP=-1");
  });

  it("replays the tone chain with measured values and linear mode in pass 2", () => {
    const filter = buildAiMusicApplyFilter(DEFAULT_AI_MUSIC_MASTERING, {
      input_i: "-16.55",
      input_tp: "-2.46",
      input_lra: "4.20",
      input_thresh: "-26.55",
      target_offset: "0.31",
    });
    expect(filter).toContain("loudnorm=I=-13.3:LRA=11:TP=-2:measured_I=-16.55:measured_LRA=4.20:measured_TP=-2.46:measured_thresh=-26.55:offset=0.31:linear=true");
    expect(filter.indexOf("mcompand=")).toBeLessThan(filter.indexOf("loudnorm"));
    expect(filter).toContain("extrastereo=m=1.2:c=false");
  });

  it("pins pass 2 output to the shared 48 kHz delivery rate and 24-bit PCM", () => {
    const args = buildAiMusicMasteringPass2Args(
      "in.wav",
      "out.wav",
      {
        input_i: "-16.55",
        input_tp: "-2.46",
        input_lra: "4.20",
        input_thresh: "-26.55",
        target_offset: "0.31",
      },
      DEFAULT_AI_MUSIC_MASTERING,
    );
    expect(args).toContain("-ar");
    expect(args).toContain("48000");
    expect(args).toContain("-c:a");
    expect(args).toContain("pcm_s24le");
  });

  it("builds pass 1 as a null measurement run", () => {
    const args = buildAiMusicMasteringPass1Args("in.wav", DEFAULT_AI_MUSIC_MASTERING);
    expect(args).toContain("-f");
    expect(args).toContain("null");
    expect(args).toContain("-");
    expect(args.some((value) => value.includes("print_format=json"))).toBe(true);
  });
});

describe("Issue #38 AI music mastering verification (fail-closed)", () => {
  it("passes inside the Issue #38 acceptance band", () => {
    const verification = buildVerification(
      { integrated_lufs: -13.31, true_peak_dbtp: -1.02 },
      DEFAULT_AI_MUSIC_MASTERING,
      "no_clipping",
    );
    expect(verification.status).toBe("passed");
    expect(verification.integrated_lufs_within_target).toBe(true);
    expect(verification.true_peak_within_limit).toBe(true);
    expect(verification.true_peak_limit_dbtp).toBe(-1.0);
  });

  it("fails when integrated loudness leaves -13.3 ± 0.5 LUFS", () => {
    const inside = buildVerification(
      { integrated_lufs: -12.8, true_peak_dbtp: -1.0 },
      DEFAULT_AI_MUSIC_MASTERING,
      "no_clipping",
    );
    expect(inside.status).toBe("passed");
    const outside = buildVerification(
      { integrated_lufs: -12.79, true_peak_dbtp: -1.0 },
      DEFAULT_AI_MUSIC_MASTERING,
      "no_clipping",
    );
    expect(outside.status).toBe("failed");
    expect(outside.integrated_lufs_within_target).toBe(false);
  });

  it("fails when true peak exceeds -1.0 dBTP", () => {
    const verification = buildVerification(
      { integrated_lufs: -13.3, true_peak_dbtp: -0.99 },
      DEFAULT_AI_MUSIC_MASTERING,
      "no_clipping",
    );
    expect(verification.status).toBe("failed");
    expect(verification.true_peak_within_limit).toBe(false);
  });

  it("fails when full-scale samples are present in a deliverable", () => {
    const verification = buildVerification(
      { integrated_lufs: -13.3, true_peak_dbtp: -1.0 },
      DEFAULT_AI_MUSIC_MASTERING,
      "full_scale_samples_present",
      "mastered WAV output carries full-scale samples",
    );
    expect(verification.status).toBe("failed");
    expect(verification.notes).toContain("mastered WAV output carries full-scale samples");
    const clean = buildVerification(
      { integrated_lufs: -13.3, true_peak_dbtp: -1.0 },
      DEFAULT_AI_MUSIC_MASTERING,
      "no_clipping",
    );
    expect(clean.status).toBe("passed");
  });

  it("fails closed when clipping evidence is unavailable or missing (M-a)", () => {
    for (const clippingStatus of ["unavailable", undefined] as const) {
      const verification = buildVerification(
        { integrated_lufs: -13.3, true_peak_dbtp: -1.0 },
        DEFAULT_AI_MUSIC_MASTERING,
        clippingStatus,
      );
      expect(verification.status, `status=${clippingStatus}`).toBe("failed");
      expect(verification.notes.join(" ")).toContain("fails closed");
    }
  });
});

describe("Issue #38 ffmpeg listing parser (ffmpeg 4 through 8)", () => {
  it("detects required filters and encoders across ffmpeg version layouts", () => {
    // ffmpeg 8.x style: flags, name, A->A column, description.
    const ffmpeg8Filters = [
      " Filters:",
      "  .. acompressor       A->A       Audio compressor.",
      "  T. alimiter          A->A       Audio lookahead limiter.",
      "  .. mcompand          A->A       Multiband Compress or expand audio dynamic range.",
      " T.C extrastereo       A->A       Increase difference between stereo audio channels.",
      "  .. loudnorm          A->A       EBU R128 loudness normalization",
      " TS anequalizer        A->N       Apply high-order audio parametric multi band equalizer.",
      " TS equalizer          A->A       Apply two-pole peaking equalization (EQ) filter.",
      " TS highpass           A->A       Apply a high-pass filter with 3dB point frequency.",
    ].join("\n");
    // ffmpeg 4.x style: flags, name, description (no A->A column).
    const ffmpeg4Filters = [
      " .. mcompand            Multiband Compress or expand audio dynamic range.",
      " T.C extrastereo        Increase difference between stereo audio channels.",
      "  .. loudnorm           EBU R128 loudness normalization",
      " TS anequalizer         Apply high-order audio parametric multi band equalizer.",
      " TS equalizer           Apply two-pole peaking equalization (EQ) filter.",
      " TS highpass            Apply a high-pass filter with 3dB point frequency.",
    ].join("\n");
    const ffmpeg8Encoders = [
      " A.....D aac                 AAC (Advanced Audio Coding)",
      " A....D libmp3lame           libmp3lame MP3 (MPEG audio layer 3) (codec mp3)",
      " A....D pcm_s24le            PCM signed 24-bit little-endian",
      " A....D pcm_s24le_planar     PCM signed 24-bit little-endian planar",
    ].join("\n");
    const ffmpeg4Encoders = [
      " A.....D aac                  AAC (Advanced Audio Coding)",
      " A....D libmp3lame            libmp3lame MP3 (codec mp3)",
      " A....D pcm_s24le             PCM signed 24-bit little-endian",
      " A....D pcm_s24le_planar      PCM signed 24-bit little-endian planar",
    ].join("\n");

    for (const [filters, encoders, version] of [
      [ffmpeg8Filters, ffmpeg8Encoders, "8.x"],
      [ffmpeg4Filters, ffmpeg4Encoders, "4.x"],
    ] as const) {
      const parsed = parseToolListingAvailability(filters, encoders);
      for (const filter of ["mcompand", "extrastereo", "loudnorm", "equalizer", "highpass"] as const) {
        expect(parsed.filters[filter], `${version}: ${filter}`).toBe("available");
      }
      for (const encoder of ["pcm_s24le", "libmp3lame"] as const) {
        expect(parsed.encoders[encoder], `${version}: ${encoder}`).toBe("available");
      }
    }
  });

  it("never confuses name prefixes with the required names", () => {
    const parsed = parseToolListingAvailability(
      " TS anequalizer        A->N       Apply high-order audio parametric multi band equalizer.",
      " A....D pcm_s24le_planar     PCM signed 24-bit little-endian planar",
    );
    expect(parsed.filters.equalizer).toBe("unavailable");
    expect(parsed.encoders.pcm_s24le).toBe("unavailable");
  });
});

// ── Receipt schema contract ────────────────────────────────────────

const SCHEMA = "ai-music-mastering-receipt.schema.json";
const HASH = "sha256:" + "a".repeat(64);

function toolAvailability() {
  return {
    available: true,
    ffmpeg: "available",
    ffprobe: "available",
    filters: {
      mcompand: "available",
      extrastereo: "available",
      loudnorm: "available",
      equalizer: "available",
      highpass: "available",
    },
    encoders: { pcm_s24le: "available", libmp3lame: "available" },
    missing: [],
  };
}

function audioEvidence(overrides: Record<string, unknown> = {}) {
  return {
    path: "/tmp/fixture.wav",
    sha256: HASH,
    duration_ms: 3000,
    channel_count: 2,
    sample_rate_hz: 48000,
    codec_name: "pcm_s24le",
    bit_depth: 24,
    bit_rate_bps: 2_304_000,
    ...overrides,
  };
}

function rawMeasurement() {
  return {
    input_i: "-16.55",
    input_tp: "-2.46",
    input_lra: "4.20",
    input_thresh: "-26.55",
    target_offset: "0.31",
  };
}

function clippingEvidence(overrides: Record<string, unknown> = {}) {
  return {
    status: "no_clipping",
    peak_sample_db: -7.7,
    basis: "astats Peak level dB on the decoded deliverable; peak <= -0.01 dBFS proves no full-scale samples",
    method: "ffmpeg_astats_peak_level" as const,
    ...overrides,
  };
}

function premasterHeadroom(overrides: Record<string, unknown> = {}) {
  return {
    pre_limiter_true_peak_dbtp: -2.46,
    full_scale_exceeded_pre_limiter: false,
    note: "true peak handed to loudnorm",
    ...overrides,
  };
}

function verification(status: "passed" | "failed", integrated = -13.31) {
  return {
    method: "ffmpeg_loudnorm_pass1_on_output" as const,
    integrated_lufs_target: -13.3,
    integrated_lufs_tolerance: 0.5,
    true_peak_limit_dbtp: -1.0,
    integrated_lufs: integrated,
    true_peak_dbtp: -1.02,
    integrated_lufs_within_target: status === "passed",
    true_peak_within_limit: true,
    status,
    notes: [],
  };
}

function baseReceipt(
  state: AiMusicMasteringReceipt["state"],
  options: { mp3?: boolean } = {},
) {
  const mastered = state !== "tone_conditioned";
  const mp3Enabled = options.mp3 ?? false;
  const policy = {
    ...DEFAULT_AI_MUSIC_MASTERING,
    encode_mp3_320: mp3Enabled,
  };
  return {
    version: "ai-music-mastering-receipt/v1" as const,
    state,
    route: mastered ? ("standalone_sns_master" as const) : ("source_premaster" as const),
    policy,
    filter_chain: buildAiMusicToneFilterChain(DEFAULT_AI_MUSIC_MASTERING),
    measurement_filter_chain: mastered
      ? buildAiMusicMeasurementFilter(DEFAULT_AI_MUSIC_MASTERING)
      : null,
    apply_filter_chain: mastered
      ? buildAiMusicApplyFilter(DEFAULT_AI_MUSIC_MASTERING, rawMeasurement())
      : null,
    tool_availability: toolAvailability(),
    input_audio: audioEvidence(),
    output_audio: audioEvidence({ path: "/tmp/mastered.wav" }),
    mp3_output_audio: null,
    premaster_raw_measurement: mastered ? rawMeasurement() : null,
    output_raw_measurement: mastered ? rawMeasurement() : null,
    mp3_raw_measurement: null,
    output_measurement: mastered
      ? { integrated_lufs: -13.31, true_peak_dbtp: -1.02, lra_lu: 4.2 }
      : null,
    mp3_measurement: null,
    premaster_headroom: mastered ? premasterHeadroom() : null,
    output_clipping: mastered ? clippingEvidence() : null,
    mp3_output_clipping: null,
    verification: mastered
      ? verification(state === "verification_failed" ? "failed" : "passed")
      : null,
    mp3_verification: null,
    shared_mastering: {
      single_final_mastering_owner: "shared_audio_render_plan" as const,
      note: "note",
    },
    human_audition: {
      required: true as const,
      status: "pending" as const,
      method: "human_audition" as const,
      note: "note",
    },
    warnings: [],
  };
}

function mp3EvidenceFields(status: "passed" | "failed") {
  return {
    mp3_output_audio: audioEvidence({
      path: "/tmp/mastered-320k.mp3",
      codec_name: "mp3",
      bit_depth: null,
      bit_rate_bps: 320_000,
    }),
    mp3_raw_measurement: rawMeasurement(),
    mp3_measurement: {
      integrated_lufs: status === "failed" ? -16.29 : -13.29,
      true_peak_dbtp: -1.02,
      lra_lu: 4.2,
    },
    mp3_output_clipping: clippingEvidence(),
    mp3_verification: {
      // verification true peak matches the measured MP3 deliverable.
      ...verification(status, status === "failed" ? -16.29 : -13.29),
      true_peak_dbtp: -1.02,
    },
  };
}

describe("Issue #38 AI music mastering receipt schema", () => {
  it("accepts a mastered receipt with all Issue #38 evidence (mp3 disabled)", () => {
    const receipt = baseReceipt("mastered");
    expect(validateAgainstSchema(receipt, SCHEMA)).toEqual({ valid: true, errors: [] });
  });

  it("accepts a mastered receipt with the 320 kbps MP3 delivery", () => {
    const receipt = {
      ...baseReceipt("mastered", { mp3: true }),
      ...mp3EvidenceFields("passed"),
    };
    expect(validateAgainstSchema(receipt, SCHEMA)).toEqual({ valid: true, errors: [] });
  });

  it("accepts a tone_conditioned premaster receipt without loudness evidence", () => {
    const receipt = baseReceipt("tone_conditioned");
    expect(validateAgainstSchema(receipt, SCHEMA)).toEqual({ valid: true, errors: [] });
  });

  it("accepts a verification_failed receipt (evidence is kept, process failed closed)", () => {
    const receipt = {
      ...baseReceipt("verification_failed"),
      output_measurement: { integrated_lufs: -16.31, true_peak_dbtp: -1.02, lra_lu: 4.2 },
    };
    const result = validateAgainstSchema(receipt, SCHEMA);
    expect(result.valid).toBe(true);
  });

  it("state must be verification_failed when only the MP3 verification fails", () => {
    const receipt = {
      ...baseReceipt("verification_failed", { mp3: true }),
      ...mp3EvidenceFields("failed"),
    };
    // WAV passed; MP3 failed. The state stays verification_failed and the
    // schema enforces this without requiring the WAV verification to fail.
    expect(receipt.verification?.status).toBe("failed");
    const result = validateAgainstSchema(receipt, SCHEMA);
    expect(result.valid).toBe(true);
  });

  it("rejects forged or inconsistent receipts", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["unknown version", { ...baseReceipt("mastered"), version: "ai-music-mastering-receipt/v2" }],
      ["additional property", { ...baseReceipt("mastered"), forged: true }],
      [
        "mastered with failed verification",
        {
          ...baseReceipt("mastered"),
          verification: verification("failed"),
        },
      ],
      ["mastered without premaster measurement", { ...baseReceipt("mastered"), premaster_raw_measurement: null }],
      ["mastered without output measurement", { ...baseReceipt("mastered"), output_measurement: null }],
      ["mastered without clipping evidence", { ...baseReceipt("mastered"), output_clipping: null }],
      ["mastered without premaster headroom", { ...baseReceipt("mastered"), premaster_headroom: null }],
      ["mastered with premaster route", { ...baseReceipt("mastered"), route: "source_premaster" }],
      [
        "mastered with mp3 enabled but no mp3 evidence",
        {
          ...baseReceipt("mastered"),
          policy: { ...DEFAULT_AI_MUSIC_MASTERING, encode_mp3_320: true },
        },
      ],
      [
        "mastered with mp3 verification failed",
        {
          ...baseReceipt("mastered", { mp3: true }),
          ...mp3EvidenceFields("failed"),
        },
      ],
      [
        "mastered with mp3 disabled but mp3 evidence present",
        {
          ...baseReceipt("mastered"),
          ...mp3EvidenceFields("passed"),
        },
      ],
      [
        "mastered with full-scale samples in WAV",
        {
          ...baseReceipt("mastered"),
          output_clipping: clippingEvidence({ status: "full_scale_samples_present", peak_sample_db: 0.0 }),
        },
      ],
      [
        "mastered with unavailable WAV clipping evidence (M-a)",
        {
          ...baseReceipt("mastered"),
          output_clipping: clippingEvidence({ status: "unavailable", peak_sample_db: null }),
        },
      ],
      [
        "mastered with unavailable MP3 clipping evidence (M-a)",
        {
          ...baseReceipt("mastered", { mp3: true }),
          ...mp3EvidenceFields("passed"),
          mp3_output_clipping: clippingEvidence({ status: "unavailable", peak_sample_db: null }),
        },
      ],
      ["tone_conditioned with loudness evidence", { ...baseReceipt("tone_conditioned"), output_measurement: { integrated_lufs: -13.3, true_peak_dbtp: -1.0, lra_lu: 4.2 } }],
      ["tone_conditioned with loudnorm chain", { ...baseReceipt("tone_conditioned"), measurement_filter_chain: "loudnorm=I=-13.3" }],
      ["tone_conditioned with premaster measurement", { ...baseReceipt("tone_conditioned"), premaster_raw_measurement: rawMeasurement() }],
      [
        "verification_failed with passing verification and clean mp3",
        {
          ...baseReceipt("verification_failed"),
          verification: verification("passed"),
        },
      ],
      ["unknown state", { ...baseReceipt("mastered"), state: "skipped" }],
      ["unknown route", { ...baseReceipt("mastered"), route: "loud" }],
      ["non-human audition claim", { ...baseReceipt("mastered"), human_audition: { required: false, status: "accepted", method: "astats", note: "n" } }],
      ["shared mastering owner override", { ...baseReceipt("mastered"), shared_mastering: { single_final_mastering_owner: "legacy_mixer", note: "n" } }],
      ["mp3 verification without mp3 evidence", { ...baseReceipt("mastered"), mp3_verification: verification("passed") }],
      ["bad sha256", { ...baseReceipt("mastered"), input_audio: audioEvidence({ sha256: "md5:deadbeef" }) }],
    ];
    for (const [name, receipt] of cases) {
      const result = validateAgainstSchema(receipt, SCHEMA);
      expect(result.valid, `${name} should be rejected: ${result.errors.join("; ")}`).toBe(false);
    }
  });

  it("binds the delivery profile values to the runtime mastering defaults", () => {
    const profile = loadAudioDeliveryProfile(
      path.join(import.meta.dirname, "../delivery_profiles/audio/internal/ai-music-sns-v1.yaml"),
    ).profile;
    const requirements = profile.measurement_requirements;
    expect(requirements.integrated_loudness.value).toBe(
      DEFAULT_AI_MUSIC_MASTERING.loudness_target_lufs,
    );
    // The ± tolerance is bound numerically through the acceptance band
    // edges, not just prose: band = target ± loudness_tolerance_lufs.
    expect(requirements.integrated_loudness.minimum).toBe(
      DEFAULT_AI_MUSIC_MASTERING.loudness_target_lufs
        - DEFAULT_AI_MUSIC_MASTERING.loudness_tolerance_lufs,
    );
    expect(requirements.integrated_loudness.maximum).toBe(
      DEFAULT_AI_MUSIC_MASTERING.loudness_target_lufs
        + DEFAULT_AI_MUSIC_MASTERING.loudness_tolerance_lufs,
    );
    expect(requirements.true_peak.value).toBe(
      DEFAULT_AI_MUSIC_MASTERING.true_peak_target_dbtp,
    );
    expect(requirements.true_peak.maximum).toBe(
      DEFAULT_AI_MUSIC_MASTERING.true_peak_target_dbtp,
    );
    expect(requirements.lra.value).toBe(DEFAULT_AI_MUSIC_MASTERING.lra_target);
    expect(requirements.integrated_loudness.notes).toContain(
      "Acceptance band is -13.3 ± 0.5 LUFS per Issue #38; minimum/maximum are the band edges bound to the runtime loudness_tolerance_lufs.",
    );
    expect(profile.encoding_requirements.true_peak_margin_dbtp.value).toBe(
      -DEFAULT_AI_MUSIC_MASTERING.true_peak_target_dbtp,
    );
    // The separated loudnorm processing target is bound like every other
    // policy value, and must sit below the acceptance ceiling.
    const processingTarget = profile.encoding_requirements.true_peak_processing_target_dbtp;
    expect(processingTarget?.value).toBe(
      DEFAULT_AI_MUSIC_MASTERING.processing_true_peak_target_dbtp,
    );
    expect(processingTarget?.value).toBeLessThan(
      profile.measurement_requirements.true_peak.value!,
    );
    expect(profile.encoding_requirements.container.value).toBe("wav");
    expect(profile.encoding_requirements.codec.value).toBe("pcm_s24le");
    expect(profile.encoding_requirements.sample_rate_hz.value).toBe(48000);
    expect(profile.encoding_requirements.channels.value).toBe(2);
    expect(profile.dialogue_processing.single_mastering_owner).toBe("shared_audio_render_plan");
    expect(profile.fallback.on_missing_tool).toBe("hold");
    // The fixture 2099 sentinel must not leak into the internal profile.
    expect(profile.verification.review_due_at).not.toContain("2099");
  });
});

// ── Receipt integrity (semantic validator) ─────────────────────────

/** Genuine schema-valid mastered receipt with the MP3 delivery. */
function genuineMasteredReceipt(): Record<string, unknown> {
  return {
    ...baseReceipt("mastered", { mp3: true }),
    ...mp3EvidenceFields("passed"),
  };
}

describe("Issue #38 AI music mastering receipt integrity (semantic validator)", () => {
  it("accepts genuine receipts (mastered with MP3, mp3-only failure, tone_conditioned)", () => {
    const mastered = genuineMasteredReceipt();
    expect(validateAiMusicMasteringReceiptIntegrity(mastered)).toEqual({ valid: true, errors: [] });
    expect(validateAiMusicMasteringReceipt(mastered)).toEqual({ valid: true, errors: [] });

    // Real-world verification_failed shape: WAV passed, MP3 failed.
    const mp3OnlyFailure = {
      ...baseReceipt("mastered", { mp3: true }),
      ...mp3EvidenceFields("failed"),
      state: "verification_failed",
    };
    expect(validateAiMusicMasteringReceiptIntegrity(mp3OnlyFailure).valid).toBe(true);
    expect(validateAiMusicMasteringReceipt(mp3OnlyFailure).valid).toBe(true);

    expect(validateAiMusicMasteringReceiptIntegrity(baseReceipt("tone_conditioned")).valid).toBe(true);
  });

  it("rejects the exact hostile counterexample: measurements tampered to -30 LUFS / +4 dBTP with booleans left stale (measurement-only)", () => {
    const receipt = genuineMasteredReceipt() as Record<string, any>;
    receipt.output_measurement = { integrated_lufs: -30, true_peak_dbtp: 4, lra_lu: 4.2 };
    // The verification block is untouched and still claims a pass.

    // Schema: mastered-branch acceptance band rejects the numbers.
    expect(validateAgainstSchema(receipt, SCHEMA).valid).toBe(false);

    // Integrity: booleans recomputed from the measured deliverable, and
    // the verification copy no longer matches the evidence.
    const integrity = validateAiMusicMasteringReceiptIntegrity(receipt);
    expect(integrity.valid).toBe(false);
    expect(integrity.errors.join(" ")).toContain("but recomputed");
    expect(integrity.errors.join(" ")).toContain("does not match the measured deliverable");

    expect(validateAiMusicMasteringReceipt(receipt).valid).toBe(false);
  });

  it("rejects measurement tampering even when the booleans are forged back to passed (measurement-plus-boolean)", () => {
    for (const deliverable of ["wav", "mp3"] as const) {
      const receipt = genuineMasteredReceipt() as Record<string, any>;
      const forgedVerification = {
        ...verification("passed"),
        integrated_lufs: -30,
        true_peak_dbtp: 4,
        integrated_lufs_within_target: true,
        true_peak_within_limit: true,
        status: "passed",
      };
      if (deliverable === "wav") {
        receipt.output_measurement = { integrated_lufs: -30, true_peak_dbtp: 4, lra_lu: 4.2 };
        receipt.verification = forgedVerification;
      } else {
        receipt.mp3_measurement = { integrated_lufs: -30, true_peak_dbtp: 4, lra_lu: 4.2 };
        receipt.mp3_verification = forgedVerification;
      }
      const integrity = validateAiMusicMasteringReceiptIntegrity(receipt);
      expect(integrity.valid, `${deliverable}: forged booleans must be detected`).toBe(false);
      expect(integrity.errors.join(" ")).toContain("but recomputed false");
      // The schema's mastered-branch acceptance band also rejects -30/+4.
      expect(validateAgainstSchema(receipt, SCHEMA).valid).toBe(false);
      expect(validateAiMusicMasteringReceipt(receipt).valid).toBe(false);
    }
  });

  it("rejects tampering where the booleans are re-derived from the hostile numbers but the state still claims mastered", () => {
    const receipt = genuineMasteredReceipt() as Record<string, any>;
    receipt.output_measurement = { integrated_lufs: -30, true_peak_dbtp: 4, lra_lu: 4.2 };
    receipt.verification = {
      ...verification("failed", -30),
      true_peak_dbtp: 4,
      true_peak_within_limit: false,
      status: "failed",
    };
    // Booleans are internally consistent with the tampered numbers, so
    // only the state/status coupling exposes the forgery.
    const integrity = validateAiMusicMasteringReceiptIntegrity(receipt);
    expect(integrity.valid).toBe(false);
    expect(integrity.errors.join(" ")).toContain("state=mastered requires");
    expect(validateAgainstSchema(receipt, SCHEMA).valid).toBe(false);
    expect(validateAiMusicMasteringReceipt(receipt).valid).toBe(false);
  });

  it("flags a stale verification status the schema alone accepts (failed status over in-band numbers)", () => {
    const receipt = {
      ...baseReceipt("verification_failed", { mp3: true }),
      ...mp3EvidenceFields("failed"),
    } as Record<string, any>;
    // Schema-valid: verification_failed with a failed verification entry.
    expect(validateAgainstSchema(receipt, SCHEMA).valid).toBe(true);
    // But the WAV verification claims "failed" while its own numbers are
    // in-band and clean; the semantic validator recomputes "passed".
    const integrity = validateAiMusicMasteringReceiptIntegrity(receipt);
    expect(integrity.valid).toBe(false);
    expect(integrity.errors.join(" ")).toContain("WAV: verification.status=failed but recomputed passed");
  });

  it("emits the true-peak mismatch diagnostic exactly once for the CLI hostile fixture", async () => {
    // Same measurement-only tamper the --verify-receipt CLI test uses:
    // deliverable numbers -30 LUFS / +4 dBTP, verification block untouched.
    const hostile = genuineMasteredReceipt() as Record<string, any>;
    hostile.output_measurement = { integrated_lufs: -30, true_peak_dbtp: 4, lra_lu: 4.2 };

    const integrity = validateAiMusicMasteringReceiptIntegrity(hostile);
    const validatorCount = integrity.errors.filter(
      (error) => error.startsWith("WAV: verification.true_peak_dbtp")
        && error.includes("does not match the measured deliverable"),
    ).length;
    expect(validatorCount, "validator must report the mismatch exactly once").toBe(1);

    // The public CLI prints the same diagnostic exactly once.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-music-count-"));
      try {
        const hostilePath = path.join(dir, "hostile.json");
        fs.writeFileSync(hostilePath, JSON.stringify(hostile, null, 2));
        await expect(
          runAiMusicMasterCli(["node", "script", "--verify-receipt", hostilePath]),
        ).resolves.toBe(4);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      const printed = errorSpy.mock.calls.flat().join("\n");
      expect(printed.split("WAV: verification.true_peak_dbtp").length - 1, "CLI must print the mismatch exactly once").toBe(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("rejects forged no_clipping status when the recorded peak proves full-scale samples (WAV and MP3)", () => {
    for (const deliverable of ["wav", "mp3"] as const) {
      for (const peak of [0, 0.5, 12, 999]) {
        const receipt = genuineMasteredReceipt() as Record<string, any>;
        const forgedClipping = {
          status: "no_clipping",
          peak_sample_db: peak,
          basis: "forged",
          method: "ffmpeg_astats_peak_level",
        };
        if (deliverable === "wav") receipt.output_clipping = forgedClipping;
        else receipt.mp3_output_clipping = forgedClipping;
        const integrity = validateAiMusicMasteringReceiptIntegrity(receipt);
        expect(integrity.valid, `${deliverable} peak ${peak} must be caught`).toBe(false);
        expect(integrity.errors.join(" ")).toContain(
          `but recomputed full_scale_samples_present from peak_sample_db ${peak} dBFS`,
        );
      }
    }
  });

  it("rejects the inverse mismatch: full_scale status over a provably clean peak (WAV and MP3)", () => {
    for (const deliverable of ["wav", "mp3"] as const) {
      const receipt = genuineMasteredReceipt() as Record<string, any>;
      const forgedClipping = {
        status: "full_scale_samples_present",
        peak_sample_db: -12,
        basis: "forged",
        method: "ffmpeg_astats_peak_level",
      };
      if (deliverable === "wav") receipt.output_clipping = forgedClipping;
      else receipt.mp3_output_clipping = forgedClipping;
      const integrity = validateAiMusicMasteringReceiptIntegrity(receipt);
      expect(integrity.valid, `${deliverable} overclaimed failure must be caught`).toBe(false);
      expect(integrity.errors.join(" ")).toContain(
        "but recomputed no_clipping from peak_sample_db -12 dBFS",
      );
    }
  });

  it("treats the exact -0.01 dBFS boundary as no_clipping and anything hotter as full-scale", () => {
    // Exactly at the production threshold: consistent no_clipping receipt
    // stays semantically valid.
    const boundary = genuineMasteredReceipt() as Record<string, any>;
    boundary.output_clipping = {
      status: "no_clipping",
      peak_sample_db: -0.01,
      basis: "boundary",
      method: "ffmpeg_astats_peak_level",
    };
    expect(validateAiMusicMasteringReceiptIntegrity(boundary).valid).toBe(true);

    // Just inside the full-scale side of the boundary is rejected.
    const justOver = genuineMasteredReceipt() as Record<string, any>;
    justOver.output_clipping = {
      status: "no_clipping",
      peak_sample_db: -0.009,
      basis: "boundary",
      method: "ffmpeg_astats_peak_level",
    };
    const integrity = validateAiMusicMasteringReceiptIntegrity(justOver);
    expect(integrity.valid).toBe(false);
    expect(integrity.errors.join(" ")).toContain(
      "but recomputed full_scale_samples_present from peak_sample_db -0.009 dBFS",
    );
  });

  it("treats a missing peak as unavailable and rejects any status claiming otherwise", () => {
    for (const status of ["no_clipping", "full_scale_samples_present"] as const) {
      const receipt = genuineMasteredReceipt() as Record<string, any>;
      receipt.output_clipping = {
        status,
        peak_sample_db: null,
        basis: "forged",
        method: "ffmpeg_astats_peak_level",
      };
      const integrity = validateAiMusicMasteringReceiptIntegrity(receipt);
      expect(integrity.valid, `status=${status} over a missing peak must be caught`).toBe(false);
      expect(integrity.errors.join(" ")).toContain(
        "but recomputed unavailable from peak_sample_db null dBFS",
      );
    }
  });

  it("CLI --verify-receipt accepts a genuine receipt and rejects a tampered one (exit 4)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-music-verify-"));
    try {
      const validPath = path.join(dir, "valid.json");
      fs.writeFileSync(validPath, JSON.stringify(genuineMasteredReceipt(), null, 2));
      await expect(
        runAiMusicMasterCli(["node", "script", "--verify-receipt", validPath]),
      ).resolves.toBe(0);

      const hostile = genuineMasteredReceipt() as Record<string, any>;
      hostile.output_measurement = { integrated_lufs: -30, true_peak_dbtp: 4, lra_lu: 4.2 };
      const hostilePath = path.join(dir, "hostile.json");
      fs.writeFileSync(hostilePath, JSON.stringify(hostile, null, 2));
      await expect(
        runAiMusicMasterCli(["node", "script", "--verify-receipt", hostilePath]),
      ).resolves.toBe(4);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Issue #38 ai-music-master CLI args", () => {
  it("parses the required flags", () => {
    const args = parseAiMusicMasterArgs([
      "node", "script",
      "--input", "in.wav",
      "--output-dir", "out",
      "--route", "source_premaster",
      "--no-mp3",
      "--json",
    ]);
    expect(args.inputPath).toBe(path.resolve("in.wav"));
    expect(args.outputDir).toBe(path.resolve("out"));
    expect(args.route).toBe("source_premaster");
    expect(args.noMp3).toBe(true);
    expect(args.json).toBe(true);
  });

  it("parses the verify-receipt mode without requiring mastering flags", () => {
    const args = parseAiMusicMasterArgs([
      "node", "script",
      "--verify-receipt", "receipt.json",
    ]);
    expect(args.verifyReceiptPath).toBe(path.resolve("receipt.json"));
    expect(args.inputPath).toBeUndefined();
    expect(args.outputDir).toBeUndefined();
  });

  it("rejects unknown arguments and missing flags", () => {
    expect(() => parseAiMusicMasterArgs(["node", "script", "--wat"])).toThrow(/unknown argument/);
    expect(() => parseAiMusicMasterArgs(["node", "script", "--input", "a.wav"])).toThrow(/--output-dir is required/);
    expect(() => parseAiMusicMasterArgs(["node", "script"])).toThrow(/--input is required/);
    expect(() => parseAiMusicMasterArgs(["node", "script", "--route"])).toThrow(/--route requires a value/);
  });
});

// ── ffmpeg-executed integration (explicit capability branch) ───────

describe("Issue #38 AI music mastering chain (ffmpeg executed)", () => {
  let workRoot: string;
  let fixturePath: string;

  beforeAll(async () => {
    const capability = await capabilityPromise;
    if (!capability.available || !ffmpegAvailable()) return;
    workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-music-master-"));
    fixturePath = path.join(workRoot, "ai-music-fixture.wav");
    // Synthetic AI-generated-music-like fixture: bass fundamental,
    // vocal-band partials, high sparkle, slightly narrow stereo image.
    await execFileAsync("ffmpeg", [
      "-y",
      "-f", "lavfi", "-i", "sine=frequency=110:sample_rate=48000:duration=3",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3",
      "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000:duration=3",
      "-f", "lavfi", "-i", "sine=frequency=12000:sample_rate=48000:duration=3",
      "-filter_complex",
      "[0:a]volume=-12dB[b];[1:a]volume=-16dB[v1];[2:a]volume=-22dB[v2];[3:a]volume=-30dB[air];" +
        "[b][v1][v2][air]amix=inputs=4:duration=longest:normalize=0,pan=stereo|c0=c0|c1=0.85*c0[a]",
      "-map", "[a]",
      "-ar", "48000",
      fixturePath,
    ]);
  }, 30_000);

  afterAll(() => {
    if (workRoot) fs.rmSync(workRoot, { recursive: true, force: true });
  });

  chainRuns("masters to -13.3 ± 0.5 LUFS with true peak <= -1.0 dBTP (Issue #38 AC)", async () => {
    await requireFullCapability();
    {
      const outputDir = path.join(workRoot, "sns");
      const receipt = await masterAiMusic({
        inputPath: fixturePath,
        outputDir,
      });

      expect(receipt.state).toBe("mastered");
      expect(receipt.verification?.status).toBe("passed");
      expect(receipt.output_measurement?.integrated_lufs).toBeGreaterThanOrEqual(-13.8);
      expect(receipt.output_measurement?.integrated_lufs).toBeLessThanOrEqual(-12.8);
      expect(receipt.output_measurement?.true_peak_dbtp).toBeLessThanOrEqual(-1.0);

      // 24-bit WAV delivery format (Issue #38 AC).
      expect(receipt.output_audio?.codec_name).toBe("pcm_s24le");
      expect(receipt.output_audio?.bit_depth).toBe(24);
      expect(receipt.output_audio?.sample_rate_hz).toBe(48000);
      expect(receipt.output_audio?.channel_count).toBe(2);

      // 320 kbps MP3 delivery (Issue #38 AC).
      expect(receipt.mp3_output_audio?.codec_name).toBe("mp3");
      expect(receipt.mp3_output_audio?.bit_rate_bps).toBe(320_000);
      expect(receipt.mp3_verification?.status).toBe("passed");
      expect(receipt.mp3_measurement?.integrated_lufs).toBeGreaterThanOrEqual(-13.8);
      expect(receipt.mp3_measurement?.integrated_lufs).toBeLessThanOrEqual(-12.8);
      expect(receipt.mp3_measurement?.true_peak_dbtp).toBeLessThanOrEqual(-1.0);

      // Receipt binds the exact bytes it measured.
      expect(receipt.input_audio.sha256).toBe(computeSha256(fixturePath));
      expect(receipt.output_audio?.sha256).toBe(
        computeSha256(receipt.output_audio!.path),
      );
      expect(receipt.mp3_output_audio?.sha256).toBe(
        computeSha256(receipt.mp3_output_audio!.path),
      );

      // Receipt on disk is schema-valid.
      const receiptPath = path.join(outputDir, "ai-music-mastering-receipt.json");
      expect(fs.existsSync(receiptPath)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as AiMusicMasteringReceipt;
      expect(
        validateAgainstSchema(parsed, "ai-music-mastering-receipt.schema.json").valid,
      ).toBe(true);
      expect(parsed.tool_availability.available).toBe(true);
      expect(parsed.human_audition.required).toBe(true);
    }
  }, 60_000);

  chainRuns("keeps the tone chain free of loudness normalization on the premaster route", async () => {
    await requireFullCapability();
    {
      const outputDir = path.join(workRoot, "premaster");
      const receipt = await masterAiMusic({
        inputPath: fixturePath,
        outputDir,
        policy: resolveAiMusicMasteringPolicy({ route: "source_premaster" }),
      });
      expect(receipt.state).toBe("tone_conditioned");
      expect(receipt.route).toBe("source_premaster");
      expect(receipt.filter_chain).not.toContain("loudnorm");
      expect(receipt.measurement_filter_chain).toBeNull();
      expect(receipt.apply_filter_chain).toBeNull();
      expect(receipt.verification).toBeNull();
      expect(receipt.output_measurement).toBeNull();
      expect(receipt.output_audio?.codec_name).toBe("pcm_s24le");
      expect(receipt.shared_mastering.single_final_mastering_owner).toBe("shared_audio_render_plan");
    }
  }, 30_000);

  chainRuns("widens the stereo image measurably (side energy)", async () => {
    await requireFullCapability();
    {
      const measureSideEnergy = async (filters: string): Promise<number> => {
        const { stderr } = await execFileAsync("ffmpeg", [
          "-i", fixturePath,
          "-af", `${filters},pan=mono|c0=0.5*c0-0.5*c1,volumedetect`,
          "-f", "null", "-",
        ]);
        const match = stderr.match(/mean_volume:\s*(-?[\d.]+) dB/);
        expect(match, `volumedetect output missing: ${stderr.slice(-400)}`).toBeTruthy();
        return Number(match![1]);
      };
      const toneChain = buildAiMusicToneFilterChain(DEFAULT_AI_MUSIC_MASTERING);
      const withoutWidener = toneChain.replace(/extrastereo=[^,]+,?/, "");
      const sideWithout = await measureSideEnergy(withoutWidener);
      const sideWith = await measureSideEnergy(toneChain);
      // 120 % width adds ~+1.58 dB of side energy; require a clear increase.
      expect(sideWith).toBeGreaterThan(sideWithout + 0.5);
    }
  }, 60_000);

  chainRuns("fails closed and keeps evidence when the master leaves the acceptance band", async () => {
    await requireFullCapability();
    {
      const outputDir = path.join(workRoot, "failclosed");
      // ffmpeg wrapper: pass 2 is silently retargeted to -16.3 LUFS so the
      // real re-measurement must reject the result.
      const wrapperPath = path.join(workRoot, "offtarget-ffmpeg.sh");
      fs.writeFileSync(wrapperPath, [
        "#!/bin/bash",
        'REAL_FFMPEG="$(command -v ffmpeg)"',
        'args=()',
        'for a in "$@"; do',
        '  if [[ "$a" == *measured_I* ]]; then',
        '    a="${a//I=-13.3/I=-16.3}"',
        "  fi",
        '  args+=("$a")',
        "done",
        'exec "$REAL_FFMPEG" "${args[@]}"',
        "",
      ].join("\n"));
      fs.chmodSync(wrapperPath, 0o755);

      let captured: unknown;
      try {
        await masterAiMusic({ inputPath: fixturePath, outputDir, ffmpegBin: wrapperPath });
      } catch (error) {
        captured = error;
      }
      expect(captured, "off-target master must fail closed").toBeInstanceOf(Error);
      expect((captured as Error).name).toBe("AiMusicMasteringVerificationError");
      expect((captured as Error).message).toContain("-13.3");

      const receiptPath = path.join(outputDir, "ai-music-mastering-receipt.json");
      expect(fs.existsSync(receiptPath)).toBe(true);
      const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as AiMusicMasteringReceipt;
      expect(receipt.state).toBe("verification_failed");
      expect(receipt.verification?.status).toBe("failed");
      expect(receipt.verification?.integrated_lufs).toBeLessThan(-13.8);
      expect(validateAgainstSchema(receipt, "ai-music-mastering-receipt.schema.json").valid).toBe(true);

      // Rejected outputs: canonical deliverable paths are freed so the
      // off-target master can never be consumed; the measured bytes stay
      // as *.rejected evidence referenced by the receipt.
      const canonicalWav = path.join(outputDir, "ai-music-fixture-ai-mastered.wav");
      const rejectedWav = `${canonicalWav}.rejected`;
      expect(fs.existsSync(canonicalWav)).toBe(false);
      expect(fs.existsSync(rejectedWav)).toBe(true);
      expect(receipt.output_audio?.path).toBe(rejectedWav);
      expect(fs.existsSync(`${canonicalWav.replace(/\.wav$/, "-320k.mp3")}.rejected`)).toBe(true);
      expect(receipt.warnings.join(" ")).toContain("rejected deliverable");
    }
  }, 60_000);

  chainRuns("masters hot crest material whose limiter engages into the acceptance band (deterministic)", async () => {
    await requireFullCapability();
    {
      // Hot-crest fixture: brief band-limited 1 kHz transients over a loud
      // continuous bed (low LRA, true peak pushed above full scale). The
      // loudnorm limiter genuinely engages; with the separated -2.0 dBTP
      // processing target the deliverables deterministically land inside
      // the -1.0 dBTP acceptance ceiling and the -13.3 ± 0.5 LUFS band —
      // this is a success test, not an either-outcome assertion.
      const hotCrestPath = path.join(workRoot, "hot-crest.wav");
      await execFileAsync("ffmpeg", [
        "-y",
        "-f", "lavfi", "-i", "sine=frequency=110:sample_rate=48000:duration=4",
        "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=4",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=4",
        "-f", "lavfi", "-i", "sine=frequency=1320:sample_rate=48000:duration=4",
        "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000:duration=4",
        "-filter_complex",
        "[0:a]volume=-14dB[b];[1:a]volume=-18dB[c];[2:a]volume=-22dB[d];[3:a]volume=-30dB[e];" +
          "[b][c][d][e]amix=inputs=4:duration=longest:normalize=0[bed];" +
          "[4:a]volume=-1.5dB,volume='if(lt(mod(t\\,0.5)\\,0.003)\\,1\\,0)':eval=frame[clk];" +
          "[bed][clk]amix=inputs=2:duration=longest:normalize=0,volume=16.9dB," +
          "pan=stereo|c0=c0|c1=0.85*c0[a]",
        "-map", "[a]",
        "-ar", "48000",
        "-c:a", "pcm_f32le",
        hotCrestPath,
      ]);
      const outputDir = path.join(workRoot, "hot-crest");
      const receipt = await masterAiMusic({ inputPath: hotCrestPath, outputDir });

      // Limiter engagement is proven, not assumed: the tone chain handed
      // loudnorm over-full-scale true peak (carried in the float domain).
      expect(receipt.premaster_headroom?.full_scale_exceeded_pre_limiter).toBe(true);
      expect(receipt.premaster_headroom?.pre_limiter_true_peak_dbtp).toBeGreaterThan(0);
      expect(receipt.warnings.join(" ")).toContain("limiter engaged");

      // Deterministic success inside the Issue #38 acceptance band.
      expect(receipt.state).toBe("mastered");
      expect(receipt.verification?.status).toBe("passed");
      expect(receipt.output_measurement?.integrated_lufs).toBeGreaterThanOrEqual(-13.8);
      expect(receipt.output_measurement?.integrated_lufs).toBeLessThanOrEqual(-12.8);
      expect(receipt.output_measurement?.true_peak_dbtp).toBeLessThanOrEqual(-1.0);
      expect(receipt.mp3_verification?.status).toBe("passed");
      expect(receipt.mp3_measurement?.integrated_lufs).toBeGreaterThanOrEqual(-13.8);
      expect(receipt.mp3_measurement?.integrated_lufs).toBeLessThanOrEqual(-12.8);
      expect(receipt.mp3_measurement?.true_peak_dbtp).toBeLessThanOrEqual(-1.0);

      // Deliverables stay free of full-scale samples and are not rejected.
      expect(receipt.output_clipping?.status).toBe("no_clipping");
      expect(receipt.output_clipping?.peak_sample_db).toBeLessThanOrEqual(-0.01);
      expect(receipt.mp3_output_clipping?.status).toBe("no_clipping");
      expect(fs.existsSync(path.join(outputDir, "hot-crest-ai-mastered.wav"))).toBe(true);
      expect(fs.existsSync(path.join(outputDir, "hot-crest-ai-mastered.wav.rejected"))).toBe(false);

      const parsed = JSON.parse(
        fs.readFileSync(path.join(outputDir, "ai-music-mastering-receipt.json"), "utf8"),
      ) as AiMusicMasteringReceipt;
      expect(validateAgainstSchema(parsed, "ai-music-mastering-receipt.schema.json").valid).toBe(true);
    }
  }, 90_000);

  chainRuns("fails closed with rejected outputs on extreme hot material the limiter cannot band (deterministic)", async () => {
    await requireFullCapability();
    {
      // Extreme crest fixture: full-scale 55 Hz bursts over a near-silent
      // bed. True-peak limiting cannot reach the loudness band for this
      // material, so the run must fail closed, keep the evidence receipt,
      // and never leave a deliverable under its canonical name.
      const extremePath = path.join(workRoot, "hot-peaky.wav");
      await execFileAsync("ffmpeg", [
        "-y",
        "-f", "lavfi", "-i", "sine=frequency=55:sample_rate=48000:duration=4",
        "-af",
        "volume=20dB,volume='if(lt(mod(t,1),0.05),1,0.03)':eval=frame,pan=stereo|c0=c0|c1=0.7*c0",
        extremePath,
      ]);
      const outputDir = path.join(workRoot, "extreme-failclosed");
      let captured: unknown;
      let receipt: AiMusicMasteringReceipt | null = null;
      try {
        receipt = await masterAiMusic({ inputPath: extremePath, outputDir });
      } catch (error) {
        captured = error;
        receipt = (error as { receipt?: AiMusicMasteringReceipt }).receipt ?? null;
      }

      expect(captured, "extreme hot material must fail closed").toBeInstanceOf(Error);
      expect((captured as Error).name).toBe("AiMusicMasteringVerificationError");
      expect(receipt!.state).toBe("verification_failed");
      expect(receipt!.premaster_headroom!.full_scale_exceeded_pre_limiter).toBe(true);
      expect(receipt!.premaster_headroom!.pre_limiter_true_peak_dbtp).toBeGreaterThan(0);
      // Integrated loudness lands far below the band floor (huge margin).
      expect(receipt!.output_measurement!.integrated_lufs).toBeLessThan(-14.8);
      // The deliverable itself stays free of full-scale samples.
      expect(receipt!.output_clipping!.status).toBe("no_clipping");
      expect(receipt!.output_clipping!.peak_sample_db).toBeLessThanOrEqual(-0.01);

      // Rejected outputs: canonical names freed, bytes kept as evidence.
      expect(fs.existsSync(path.join(outputDir, "hot-peaky-ai-mastered.wav"))).toBe(false);
      expect(fs.existsSync(path.join(outputDir, "hot-peaky-ai-mastered.wav.rejected"))).toBe(true);
      expect(fs.existsSync(path.join(outputDir, "hot-peaky-ai-mastered-320k.mp3"))).toBe(false);
      expect(fs.existsSync(path.join(outputDir, "hot-peaky-ai-mastered-320k.mp3.rejected"))).toBe(true);
      expect(receipt!.output_audio?.path).toBe(
        path.join(outputDir, "hot-peaky-ai-mastered.wav.rejected"),
      );
      expect(receipt!.mp3_output_audio?.path).toBe(
        path.join(outputDir, "hot-peaky-ai-mastered-320k.mp3.rejected"),
      );
      expect(receipt!.warnings.join(" ")).toContain("rejected deliverable");

      const parsed = JSON.parse(
        fs.readFileSync(path.join(outputDir, "ai-music-mastering-receipt.json"), "utf8"),
      ) as AiMusicMasteringReceipt;
      expect(validateAgainstSchema(parsed, "ai-music-mastering-receipt.schema.json").valid).toBe(true);
    }
  }, 90_000);

  chainRuns("rejects a -14 LUFS contract override fail-fast with zero output (real ffmpeg)", async () => {
    await requireFullCapability();
    {
      // In-range per POLICY_BOUNDS, but the dedicated Issue #38 contract
      // ships its acceptance policy: the override must be rejected before
      // any ffmpeg work, leaving no output directory and no receipt.
      const outputDir = path.join(workRoot, "override-failfast");
      let captured: unknown;
      try {
        await masterAiMusic({
          inputPath: fixturePath,
          outputDir,
          policy: resolveAiMusicMasteringPolicy({ loudness_target_lufs: -14 }),
        });
      } catch (error) {
        captured = error;
      }
      expect(captured, "-14 LUFS override must fail fast").toBeInstanceOf(AiMusicMasteringPolicyError);
      expect((captured as Error).message).toContain("shipped policy");
      expect((captured as Error).message).toContain("loudness_target_lufs=-14");
      expect(fs.existsSync(outputDir)).toBe(false);
    }
  }, 30_000);

  chainRuns("CLI rejects a -14 LUFS policy override with exit 1 and zero output (real ffmpeg)", async () => {
    await requireFullCapability();
    {
      const outputDir = path.join(workRoot, "override-cli");
      const policyPath = path.join(workRoot, "override-policy.json");
      fs.writeFileSync(policyPath, JSON.stringify({ loudness_target_lufs: -14 }));
      const code = await runAiMusicMasterCli([
        "node", "script",
        "--input", fixturePath,
        "--output-dir", outputDir,
        "--policy", policyPath,
      ]);
      expect(code).toBe(1);
      expect(fs.existsSync(outputDir)).toBe(false);
      expect(fs.existsSync(path.join(workRoot, "ai-music-mastering-receipt.json"))).toBe(false);
    }
  }, 30_000);

  chainRuns("keeps no canonical deliverable when receipt persistence fails (real ffmpeg)", async () => {
    await requireFullCapability();
    {
      const outputDir = path.join(workRoot, "persist-failure");
      // Deterministic persistence failure: the receipt parent is a file,
      // so persistReceipt's mkdir fails after the run has mastered.
      const blockerPath = path.join(workRoot, "receipt-parent-blocker");
      fs.writeFileSync(blockerPath, "not a directory");
      const receiptPath = path.join(blockerPath, "receipt.json");
      let captured: unknown;
      try {
        await masterAiMusic({ inputPath: fixturePath, outputDir, receiptPath });
      } catch (error) {
        captured = error;
      }
      expect(captured, "persistence failure must propagate").toBeInstanceOf(Error);
      // Canonical WAV/MP3 are rejected, never left consumable.
      expect(fs.existsSync(path.join(outputDir, "ai-music-fixture-ai-mastered.wav"))).toBe(false);
      expect(fs.existsSync(path.join(outputDir, "ai-music-fixture-ai-mastered.wav.rejected"))).toBe(true);
      expect(fs.existsSync(path.join(outputDir, "ai-music-fixture-ai-mastered-320k.mp3"))).toBe(false);
      expect(fs.existsSync(path.join(outputDir, "ai-music-fixture-ai-mastered-320k.mp3.rejected"))).toBe(true);
      // The failure receipt bytes are kept for debugging.
      const invalidReceiptPath = path.join(outputDir, "ai-music-mastering-receipt.invalid.json");
      expect(fs.existsSync(invalidReceiptPath)).toBe(true);
      const invalidReceipt = JSON.parse(fs.readFileSync(invalidReceiptPath, "utf8")) as AiMusicMasteringReceipt;
      expect(invalidReceipt.state).toBe("mastered");
    }
  }, 60_000);

  chainRuns("probes evidence exclusively through the injected ffprobe binary", async () => {
    await requireFullCapability();
    {
      const outputDir = path.join(workRoot, "ffprobe-injection");
      const markerPath = path.join(workRoot, "ffprobe-wrapper-invoked");
      const wrapperPath = path.join(workRoot, "ffprobe-wrapper.sh");
      fs.writeFileSync(wrapperPath, [
        "#!/bin/bash",
        `touch ${JSON.stringify(markerPath)}`,
        'exec "$(command -v ffprobe)" "$@"',
        "",
      ].join("\n"));
      fs.chmodSync(wrapperPath, 0o755);

      // Premaster route keeps the run short while still probing both the
      // input and the output through the injected binary.
      const receipt = await masterAiMusic({
        inputPath: fixturePath,
        outputDir,
        policy: resolveAiMusicMasteringPolicy({ route: "source_premaster" }),
        ffprobeBin: wrapperPath,
      });
      expect(fs.existsSync(markerPath), "injected ffprobe must be executed").toBe(true);
      expect(receipt.input_audio.sha256).toBe(computeSha256(fixturePath));
      expect(receipt.output_audio?.codec_name).toBe("pcm_s24le");
    }
  }, 30_000);

  chainRuns("creates missing parent directories for a custom receipt path", async () => {
    await requireFullCapability();
    {
      const outputDir = path.join(workRoot, "receipt-mkdir");
      const receiptPath = path.join(workRoot, "receipts", "nested", "dir", "ai-music-receipt.json");
      const receipt = await masterAiMusic({
        inputPath: fixturePath,
        outputDir,
        policy: resolveAiMusicMasteringPolicy({ route: "source_premaster" }),
        receiptPath,
      });
      expect(receipt.state).toBe("tone_conditioned");
      expect(fs.existsSync(receiptPath)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as AiMusicMasteringReceipt;
      expect(validateAgainstSchema(parsed, "ai-music-mastering-receipt.schema.json").valid).toBe(true);
    }
  }, 30_000);

  it("treats missing tooling as an explicit capability and refuses to run", async () => {
    const unavailableCapability = {
      available: false,
      ffmpeg: "unavailable" as const,
      ffprobe: "unavailable" as const,
      filters: {
        mcompand: "unavailable" as const,
        extrastereo: "unavailable" as const,
        loudnorm: "unavailable" as const,
        equalizer: "unavailable" as const,
        highpass: "unavailable" as const,
      },
      encoders: { pcm_s24le: "unavailable" as const, libmp3lame: "unavailable" as const },
      missing: ["ffmpeg", "ffprobe"],
    };
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-music-cap-"));
    try {
      await expect(masterAiMusic({
        inputPath: fixturePath ?? "whatever.wav",
        outputDir,
        capability: unavailableCapability,
      })).rejects.toThrow(/explicit capability.*missing ffmpeg, ffprobe/);
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("detects capability explicitly on a machine without ffmpeg (PATH stripped)", async () => {
    const capability = await detectAiMusicMasteringCapability({
      env: { PATH: "", HOME: process.env.HOME ?? "" },
    });
    expect(capability.available).toBe(false);
    expect(capability.ffmpeg).toBe("unavailable");
    expect(capability.error?.code).toBe("ENOENT");
    expect(capability.missing).toContain("ffmpeg");
  });

  it("CLI exits non-zero with an explicit capability error under an actually empty PATH", async () => {
    // PATH is genuinely empty (not just stripped of ffmpeg): spawning node
    // uses the absolute execPath, tsx resolves from repo node_modules, and
    // the in-process ffmpeg probe must fail with ENOENT -> exit code 2.
    const { spawnSync } = await import("node:child_process");
    const repoRoot = path.resolve(import.meta.dirname, "..");
    const run = spawnSync(
      process.execPath,
      [
        "--import", "tsx", "scripts/ai-music-master.ts",
        "--input", path.join(repoRoot, "package.json"),
        "--output-dir", path.join(workRoot, "cli-cap"),
      ],
      {
        cwd: repoRoot,
        env: { PATH: "", HOME: process.env.HOME ?? "", LANG: "C" },
        encoding: "utf8",
      },
    );
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/capability unavailable.*ffmpeg/);
  }, 30_000);
});
