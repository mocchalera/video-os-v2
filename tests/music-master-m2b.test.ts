import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { validateAgainstSchema } from "../runtime/commands/shared.js";
import { hashAudioRenderPlan, resolveAudioRenderPlan } from "../runtime/audio/render-plan.js";
import { classifyProjectGenre } from "../runtime/render/route-resolver.js";
import { projectPremiereFinishReview } from "../runtime/handoff/premiere-finish-review.js";
import { checkLoudnessTargetForAudioPolicy } from "../runtime/packaging/qa.js";
import type { TimelineIR } from "../runtime/compiler/types.js";

const repoRoot = path.resolve(import.meta.dirname, "..");

function hash(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function musicMasterBrief(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: "1",
    project_id: "m2b-brief",
    project: { title: "M2b brief", strategy: "lyric-mv" },
    message: { primary: "full song" },
    audience: { primary: "listeners" },
    emotion_curve: ["start", "peak", "end"],
    must_have: ["song"],
    must_avoid: ["mute"],
    autonomy: { may_decide: [], must_ask: [] },
    resolved_assumptions: ["music master is explicit"],
    audio_policy: "music_master",
    music_master: {
      source_ref: "00_sources/song.wav",
      source_content_hash: `sha256:${"a".repeat(64)}`,
      source_size_bytes: 4,
      source_duration_us: 5_000_000,
      audio_decision: "preserve",
      gain_linear: 1,
    },
    ...extra,
  };
}

function writeMusicMasterTimeline(root: string): string {
  const bytes = Buffer.from("M2b deterministic song fixture\n");
  fs.mkdirSync(path.join(root, "00_sources"), { recursive: true });
  fs.writeFileSync(path.join(root, "00_sources/song.wav"), bytes);
  const timelinePath = path.join(root, "timeline.json");
  fs.writeFileSync(timelinePath, JSON.stringify({
    version: "1",
    project_id: "m2b-profile",
    created_at: "2026-09-01T00:00:00Z",
    sequence: { fps_num: 24, fps_den: 1 },
    tracks: {
      video: [],
      audio: [
        { track_id: "A1", kind: "audio", clips: [] },
        { track_id: "A2", kind: "audio", clips: [] },
        { track_id: "A3", kind: "audio", clips: [] },
      ],
    },
    markers: [],
    provenance: {
      audio_policy: {
        mode: "music_master",
        source: "explicit_brief",
        audio_decision: "preserve",
        music_master: {
          asset_id: "SONG_PROFILE_01",
          source_ref: "00_sources/song.wav",
          source_content_hash: hash(bytes),
          source_size_bytes: bytes.length,
          source_duration_us: 5_000_000,
          audio_decision: "preserve",
        },
      },
    },
  }, null, 2));
  return timelinePath;
}

function writeFinishFixture(root: string): { timelinePath: string; planPath: string; reportPath: string; timeline: TimelineIR } {
  const fixture = JSON.parse(fs.readFileSync(
    path.join(repoRoot, "tests/fixtures/premiere/finish-surfaces-rich-v1.json"),
    "utf8",
  )) as { timeline: TimelineIR };
  const timeline = structuredClone(fixture.timeline);
  timeline.project_id = "m2b-finish";
  timeline.tracks.audio = [
    { track_id: "A1", kind: "audio", clips: [] },
    { track_id: "A2", kind: "audio", clips: [] },
    { track_id: "A3", kind: "audio", clips: [] },
  ];
  timeline.tracks.video = [];
  timeline.tracks.overlay = [];
  timeline.tracks.caption = [];
  timeline.transitions = [];
  const bytes = Buffer.from("M2b NLE song fixture\n");
  fs.mkdirSync(path.join(root, "00_sources"), { recursive: true });
  fs.mkdirSync(path.join(root, "05_timeline"), { recursive: true });
  fs.mkdirSync(path.join(root, "07_package", "logs"), { recursive: true });
  fs.writeFileSync(path.join(root, "00_sources/song.wav"), bytes);
  timeline.provenance = {
    ...timeline.provenance,
    audio_policy: {
      mode: "music_master",
      source: "explicit_brief",
      audio_decision: "preserve",
      music_master: {
        asset_id: "SONG_NLE_01",
        source_ref: "00_sources/song.wav",
        source_content_hash: hash(bytes),
        source_size_bytes: bytes.length,
        source_duration_us: 5_000_000,
        audio_decision: "preserve",
      },
    },
  };
  const timelinePath = path.join(root, "05_timeline/timeline.json");
  fs.writeFileSync(timelinePath, `${JSON.stringify(timeline, null, 2)}\n`);
  const plan = resolveAudioRenderPlan({ projectDir: root, timelinePath });
  const planPath = path.join(root, "07_package/audio-render-plan.json");
  fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  const measurement = {
    input_i: "-16",
    input_tp: "-1",
    input_lra: "5",
    input_thresh: "-26",
    target_offset: "0",
  };
  const zeroDelta = { integrated_lufs_db: 0, lra_lu: 0, true_peak_dbtp: 0 };
  const encodedContainerHash = hash(Buffer.from("M2b encoded container fixture\n"));
  const encodedAudioHash = hash(Buffer.from("M2b encoded audio fixture\n"));
  const report = {
    version: "audio-mix-report/v2",
    project_id: timeline.project_id,
    plan_hash: hashAudioRenderPlan(plan),
    has_bgm: false,
    strategy: "shared_audio_render_plan_v1",
    input_hashes: {
      timeline: plan.timeline.content_hash,
      dialogue_sources: [],
      cue_sources: [],
      music_master: {
        asset_id: plan.music_master!.source.asset_id,
        content_hash: plan.music_master!.source.source_content_hash,
        size_bytes: plan.music_master!.source.source_size_bytes,
      },
    },
    output: {
      content_hash: plan.music_master!.source.source_content_hash,
      size_bytes: plan.music_master!.source.source_size_bytes,
      sample_rate_hz: 48_000,
      channels: 2,
    },
    encoded_result: {
      version: "encoded-audio-measurement/v1",
      status: "verified",
      path: "07_package/video/final.mp4",
      content_hash: encodedContainerHash,
      container: {
        format_name: "mov,mp4,m4a,3gp,3g2,mj2",
        format_long_name: "MPEG-4",
      },
      audio_stream: {
        codec_name: "aac",
        codec_long_name: "AAC",
        sample_rate_hz: 48_000,
        channels: 2,
        channel_layout: "stereo",
        bit_rate: 128_000,
        duration_sec: 5,
        start_time_sec: 0,
      },
      video_stream: {
        codec_name: "h264",
        duration_sec: 5,
        start_time_sec: 0,
      },
      duration_and_sync: {
        audio_duration_sec: 5,
        video_duration_sec: 5,
        duration_delta_sec: 0,
        audio_start_time_sec: 0,
        video_start_time_sec: 0,
        start_time_delta_sec: 0,
        status: "measured",
      },
      loudness: {
        status: "measured",
        method: "ffmpeg_loudnorm_pass1",
        integrated_lufs: -16,
        short_term_lufs: null,
        lra_lu: 5,
        true_peak_dbtp: -1,
        raw: measurement,
        notes: [],
      },
      diagnostics: {
        clipping: { status: "measured", reason: "deterministic fixture" },
        silence: { status: "measured", reason: "deterministic fixture" },
        dropout: { status: "measured", reason: "deterministic fixture" },
        channel: { status: "measured", reason: "deterministic fixture" },
        phase: { status: "measured", reason: "deterministic fixture" },
      },
      playback: {
        mono_fold_down: { status: "verified", method: "deterministic fixture", evidence: "fixture" },
        mobile: { status: "human_required", method: "human_audition", evidence: null },
      },
      speech_intelligibility: {
        status: "not_claimed",
        proxies: [],
        human_audition_required: true,
      },
      human_audition: { required: true, status: "pending" },
      mastering: {
        owner: "shared_audio_render_plan",
        stage: "not_applied",
        pass_count: 0,
        applied_processing: [],
      },
      tool_availability: { ffprobe: "available", ffmpeg: "available" },
      warnings: [],
    },
    music_master: {
      role: "music_master",
      audio_decision: "preserve",
      source: plan.music_master!.source,
      input_audio_hash: plan.music_master!.input_audio_hash,
      output_audio_hash: plan.music_master!.source.source_content_hash,
      source_bytes_preserved: true,
      processing_graph: plan.music_master!.processing_graph,
      codec: plan.music_master!.codec,
      measurements: {
        status: "measured",
        input: measurement,
        output: measurement,
        delta: zeroDelta,
        tolerance: plan.music_master!.measurement_tolerance,
        reason: "deterministic fixture measurement",
      },
      final_mux: {
        operation: "reencode",
        codec: "aac",
        output_audio_hash: encodedAudioHash,
        output_container_hash: encodedContainerHash,
        measurements: {
          status: "measured",
          delta: zeroDelta,
          tolerance: plan.music_master!.measurement_tolerance,
          reason: "deterministic fixture measurement",
        },
      },
    },
    stems: [{
      stem_id: "music_master",
      role: "music_master",
      source_track_id: "music_master",
      content_hash: plan.music_master!.source.source_content_hash,
      size_bytes: plan.music_master!.source.source_size_bytes,
      finish_applied: false,
    }],
    cues: [],
    dialogue_finish_scope: "none",
    mastering_count: 0,
    execution_strategy: {
      id: "shared_audio_render_plan_executor_v1",
      stages: ["bind_music_master", "stream_copy_source"],
      deterministic_input_order: ["music_master"],
    },
    final_mastering: {
      applied: false,
      loudness_target_lufs: -16,
      lra_target: 7,
      true_peak_target_dbtp: -1.5,
      premaster_measurement: null,
      output_measurement: null,
      owner: "shared_audio_render_plan",
      stage: "not_applied",
    },
    warnings: [],
  };
  const reportPath = path.join(root, "07_package/logs/audio-mix-report.json");
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return { timelinePath, planPath, reportPath, timeline };
}

describe("Issue #42 M2b compiler/profile contract", () => {
  it("accepts the canonical brief declaration and rejects non-canonical loudness keys", () => {
    expect(validateAgainstSchema(musicMasterBrief(), "creative-brief.schema.json")).toEqual({ valid: true, errors: [] });
    expect(validateAgainstSchema(musicMasterBrief({ music_master: {
      ...(musicMasterBrief().music_master as Record<string, unknown>),
      normalization: { enabled: true },
    } }), "creative-brief.schema.json").valid).toBe(false);
    const missingDeclaration = musicMasterBrief();
    delete missingDeclaration.music_master;
    expect(validateAgainstSchema(missingDeclaration, "creative-brief.schema.json").valid).toBe(false);
    const missingPolicy = musicMasterBrief();
    delete missingPolicy.audio_policy;
    expect(validateAgainstSchema(missingPolicy, "creative-brief.schema.json").valid).toBe(false);
  });

  it("routes music_master preserve ahead of a 9:16 social profile", () => {
    expect(classifyProjectGenre({
      aspectRatio: "9:16",
      distributionChannel: "social",
      profileHint: "short-social",
      audioPolicy: "music_master",
      audioDecision: "preserve",
    })).toBe("longform");
  });

  it("fails closed when an SNS loudness profile is forced onto preserve", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vos-m2b-profile-"));
    const timelinePath = writeMusicMasterTimeline(root);
    try {
      expect(() => resolveAudioRenderPlan({
        projectDir: root,
        timelinePath,
        audioProfilePath: path.join(repoRoot, "delivery_profiles/audio/internal/ai-music-sns-v1.yaml"),
        audioProfileRootDir: repoRoot,
      })).toThrow(/short-social|normalization policy/);
      const plan = resolveAudioRenderPlan({ projectDir: root, timelinePath });
      expect(plan.music_master?.audio_decision).toBe("preserve");
      expect(plan.final_mastering.count).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not force SNS loudness onto music_master preserve while retaining non-preserve QA", () => {
    expect(checkLoudnessTargetForAudioPolicy(true, -12, -2)).toMatchObject({
      name: "loudness_target_valid",
      passed: true,
    });
    expect(checkLoudnessTargetForAudioPolicy(false, -12, -2)).toMatchObject({
      name: "loudness_target_valid",
      passed: false,
    });
  });

  it("exposes an identity-bound measured music_master receipt on NLE finish review", () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "vos-m2b-finish-"));
    try {
      const fixture = writeFinishFixture(root);
      const projection = projectPremiereFinishReview(root, {
        repoRoot,
        preflightRunner: (invocation) => {
          const shaIndex = invocation.args.indexOf("--expected-timeline-sha256");
          const identityIndex = invocation.args.indexOf("--expected-timeline-identity-json");
          return {
            status: 0,
            signal: null,
            stdout: JSON.stringify({
              mode: "preflight",
              project_id: fixture.timeline.project_id,
              hardware_verified: false,
              clips: [],
              child_used_timeline_sha256: invocation.args[shaIndex + 1],
              child_used_timeline_identity: JSON.parse(Buffer.from(invocation.args[identityIndex + 1], "base64url").toString("utf8")),
            }),
            stderr: "",
          };
        },
      });
      expect(projection.audio_master_receipt).toMatchObject({
        role: "music_master",
        audio_decision: "preserve",
        plan: { path: "07_package/audio-render-plan.json" },
        report: { path: "07_package/logs/audio-mix-report.json", measurement_status: "measured" },
      });

      const originalReport = JSON.parse(fs.readFileSync(fixture.reportPath, "utf8")) as Record<string, any>;
      for (const [label, mutation] of [
        ["forged receipt output hash", (candidate: Record<string, any>) => {
          candidate.music_master.output_audio_hash = hash(Buffer.from("forged receipt output\n"));
        }],
        ["forged final mux container hash", (candidate: Record<string, any>) => {
          candidate.music_master.final_mux.output_container_hash = hash(Buffer.from("forged mux\n"));
        }],
        ["forged delta", (candidate: Record<string, any>) => {
          candidate.music_master.measurements.delta.integrated_lufs_db = 999;
        }],
        ["forged tolerance", (candidate: Record<string, any>) => {
          candidate.music_master.measurements.tolerance.integrated_lufs_db = 1000;
        }],
        ["NaN raw measurement", (candidate: Record<string, any>) => {
          candidate.music_master.measurements.input.input_i = "NaN";
        }],
        ["partial raw measurement", (candidate: Record<string, any>) => {
          candidate.music_master.measurements.input = null;
        }],
        ["degraded measurement", (candidate: Record<string, any>) => {
          candidate.music_master.measurements.status = "degraded";
        }],
      ] as Array<[string, (candidate: Record<string, any>) => void]>) {
        const tampered = structuredClone(originalReport);
        mutation(tampered);
        fs.writeFileSync(fixture.reportPath, `${JSON.stringify(tampered, null, 2)}\n`);
        expect(() => projectPremiereFinishReview(root, {
          repoRoot,
          preflightRunner: () => { throw new Error(`${label} must fail before preflight`); },
        }), label).toThrow(/invalid_projection/);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
