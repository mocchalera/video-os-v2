import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { checkSocialRetentionFinishing, resolveCompilerRetentionPolicy } from "../runtime/packaging/social-retention-qa.js";
import { loadRetentionPolicy, retentionPolicyContentHash } from "../runtime/editorial/short-form-retention.js";
import type { TimelineIR } from "../runtime/compiler/types.js";

function brief(format = "social_vertical", overrides: Record<string, unknown> = {}): unknown {
  return {
    project: { format, runtime_target_sec: 60 },
    editorial: { distribution_channel: "shorts", hook_priority: "aggressive" },
    must_have: ["冒頭0〜2秒で結果を先出し"],
    audio_policy: "original_only",
    ...overrides,
  };
}

function timeline(withHook: boolean, splitFrames = [0, 300, 600, 900, 1200, 1500]): TimelineIR {
  const overlays = withHook ? [{
    clip_id: "HOOK",
    segment_id: "HOOK",
    asset_id: "__overlay__",
    src_in_us: 0,
    src_out_us: 1_600_000,
    timeline_in_frame: 0,
    timeline_duration_frames: 48,
    role: "title",
    motivation: "hook",
    beat_id: "b01",
    fallback_segment_ids: [],
    confidence: 1,
    quality_flags: [],
    metadata: { overlay: { styling_class: "vos:overlay.hook-title", text: "結果" } },
  }] : [];
  const clips = splitFrames.map((frame, index) => ({
    clip_id: `C${index}`,
    segment_id: `S${index}`,
    asset_id: "A1",
    src_in_us: index * 10_000_000,
    src_out_us: (index + 1) * 10_000_000,
    timeline_in_frame: frame,
    timeline_duration_frames: 300,
    role: "dialogue",
    motivation: "speech",
    beat_id: `b${index}`,
    fallback_segment_ids: [],
    confidence: 1,
    quality_flags: [],
  }));
  return {
    version: "1", project_id: "qa", created_at: "2026-07-18T00:00:00Z",
    sequence: { fps_num: 30, fps_den: 1, width: 1080, height: 1920, pixel_aspect: "1:1", audio_sample_rate_hz: 48000, channel_layout: "stereo", start_timecode: "00:00:00:00", drop_frame: false, letterbox_policy: "none" },
    tracks: { video: [{ track_id: "V1", kind: "video", clips }], audio: [], overlay: [{ track_id: "V2", kind: "overlay", clips: overlays }] },
    transitions: [], markers: [], provenance: {},
  } as unknown as TimelineIR;
}

describe("social retention finishing QA", () => {
  it("passes a registered cold open with regular meaningful cuts", () => {
    const checks = checkSocialRetentionFinishing(timeline(true), brief());
    expect(checks.filter((check) => check.name !== "social_retention_truth_bound").every((check) => check.passed)).toBe(true);
    expect(checks.find((check) => check.name === "social_retention_truth_bound")?.details).toMatch(/receipt=sha256:[a-f0-9]{64} input=sha256:[a-f0-9]{64}/);
  });

  it("fails a missing hook and a long static interval", () => {
    const checks = checkSocialRetentionFinishing(timeline(false, [0, 600, 1200]), brief());
    expect(checks.find((check) => check.name === "social_hook_treatment_valid")?.passed).toBe(false);
    expect(checks.find((check) => check.name === "social_visual_refresh_valid")?.passed).toBe(false);
  });

  it("does not add genre-spanning checks for non-social work", () => {
    expect(checkSocialRetentionFinishing(timeline(false), {
      project: { format: "documentary", runtime_target_sec: 600 },
      editorial: { distribution_channel: "broadcast" },
    })).toEqual([]);
  });

  it("requires an explicit short-form audio policy", () => {
    const checks = checkSocialRetentionFinishing(timeline(true), brief("social_vertical", { audio_policy: undefined }));
    expect(checks.find((check) => check.name === "social_audio_policy_valid")?.passed).toBe(false);
  });

  it("requires a music clip when short-form audio policy asks for BGM", () => {
    const withoutMusic = checkSocialRetentionFinishing(timeline(true), brief("social_vertical", { audio_policy: "ducking" }));
    expect(withoutMusic.find((check) => check.name === "social_audio_policy_valid")?.passed).toBe(false);

    const withMusicTimeline = timeline(true);
    withMusicTimeline.tracks.audio = [{
      track_id: "A2",
      kind: "audio",
      clips: [{
        clip_id: "BGM", segment_id: "BGM", asset_id: "MUSIC", src_in_us: 0, src_out_us: 60_000_000,
        timeline_in_frame: 0, timeline_duration_frames: 1_800, role: "bgm", motivation: "music",
        beat_id: "b01", fallback_segment_ids: [], confidence: 1, quality_flags: [],
      }],
    }];
    const withMusic = checkSocialRetentionFinishing(withMusicTimeline, brief("social_vertical", { audio_policy: "ducking" }));
    expect(withMusic.find((check) => check.name === "social_audio_policy_valid")?.passed).toBe(true);
  });

  it("requires a held final CTA when the brief asks for one", () => {
    const ctaBrief = brief("social_vertical", { must_have: ["最後に無料相談CTAを表示"] });
    const missing = checkSocialRetentionFinishing(timeline(true), ctaBrief);
    expect(missing.find((check) => check.name === "social_cta_treatment_valid")?.passed).toBe(false);

    const withCta = timeline(true);
    const overlayTracks = (withCta.tracks as TimelineIR["tracks"] & { overlay: TimelineIR["tracks"]["video"] }).overlay;
    overlayTracks[0].clips.push({
      clip_id: "CTA", segment_id: "CTA", asset_id: "__overlay__", src_in_us: 0, src_out_us: 3_000_000,
      timeline_in_frame: 1_200, timeline_duration_frames: 300, role: "title", motivation: "cta",
      beat_id: "b99", fallback_segment_ids: [], confidence: 1, quality_flags: [],
      metadata: { overlay: { styling_class: "vos:overlay.cta-card", text: "無料相談へ" } },
    });
    const accepted = checkSocialRetentionFinishing(withCta, ctaBrief);
    expect(accepted.find((check) => check.name === "social_cta_treatment_valid")?.passed).toBe(true);
  });

  it("rejects hook copy that exceeds the renderer contract", () => {
    const longTitle = timeline(true);
    const overlayTracks = (longTitle.tracks as TimelineIR["tracks"] & { overlay: TimelineIR["tracks"]["video"] }).overlay;
    overlayTracks[0].clips[0].metadata = { overlay: { styling_class: "vos:overlay.hook-title", text: "長".repeat(81) } };
    const checks = checkSocialRetentionFinishing(longTitle, brief());
    expect(checks.find((check) => check.name === "social_title_copy_fit_valid")?.passed).toBe(false);
  });

  it("uses the compiler retention policy ref/hash for the QA receipt", () => {
    const policyRef = "tests/fixtures/rfa-retention/retention-policy.json";
    const policy = loadRetentionPolicy(path.join(process.cwd(), policyRef));
    const policyHash = retentionPolicyContentHash(policy);
    const compiled = timeline(true);
    compiled.provenance = {
      retention_policy: {
        policy: "retention-policy/v1",
        policy_ref: policyRef,
        policy_id: policy.policy_id,
        policy_hash: policyHash,
        degrade_order: policy.degrade_order,
      },
    } as typeof compiled.provenance;
    compiled.metadata = {
      retention_evidence: { producer: "compiler", policy_ref: policyRef, policy_hash: policyHash },
    };
    const resolved = resolveCompilerRetentionPolicy(process.cwd(), compiled);
    expect(resolved && retentionPolicyContentHash(resolved)).toBe(policyHash);
    const receiptCheck = checkSocialRetentionFinishing(compiled, brief(), resolved)
      .find((check) => check.name === "social_retention_truth_bound");
    expect(receiptCheck?.details).toContain(`policy=sha256:${policyHash.slice("sha256:".length)}`);
  });
});
