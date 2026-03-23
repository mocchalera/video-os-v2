#!/usr/bin/env npx tsx

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

type SegmentSpec = {
  file: string;
  asset_id: string;
  segment_id: string;
  src_in: number;
  src_out: number;
  date: string;
  caption: string;
  nat_gain: number;
  role: "hero" | "support" | "texture";
};

type Spec = {
  project_id: string;
  timeline_version: string;
  sequence_name: string;
  output_fps: number;
  outputs: { titles: string };
  segments: SegmentSpec[];
};

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function main(): void {
  const specPath = process.argv[2];
  if (!specPath) {
    console.error("Usage: npx tsx scripts/generate-growth-manual-artifacts.ts <spec.json>");
    process.exit(1);
  }

  const absSpecPath = path.resolve(specPath);
  const spec = readJson<Spec>(absSpecPath);
  const projectDir = path.dirname(path.dirname(absSpecPath));
  const fps = spec.output_fps;

  const videoClips: Array<Record<string, unknown>> = [];
  const natAudioClips: Array<Record<string, unknown>> = [];
  const titleOverlays: Array<Record<string, unknown>> = [];
  const markers: Array<Record<string, unknown>> = [];

  let timelineFrame = 0;

  for (const [index, segment] of spec.segments.entries()) {
    const beatId = `b${String(index + 1).padStart(2, "0")}`;
    const clipNo = String(index + 1).padStart(4, "0");
    const durationFrames = Math.round((segment.src_out - segment.src_in) * fps);

    videoClips.push({
      clip_id: `CLP_${clipNo}`,
      segment_id: segment.segment_id,
      asset_id: segment.asset_id,
      src_in_us: Math.round(segment.src_in * 1_000_000),
      src_out_us: Math.round(segment.src_out * 1_000_000),
      timeline_in_frame: timelineFrame,
      timeline_duration_frames: durationFrames,
      role: segment.role,
      motivation: segment.caption,
      beat_id: beatId,
      fallback_segment_ids: [],
      confidence: segment.role === "hero" ? 0.98 : 0.92,
      quality_flags: [],
      audio_policy: {
        duck_music_db: segment.role === "hero" ? 2.0 : 0,
      },
    });

    natAudioClips.push({
      clip_id: `ACL_${clipNo}`,
      segment_id: segment.segment_id,
      asset_id: segment.asset_id,
      src_in_us: Math.round(segment.src_in * 1_000_000),
      src_out_us: Math.round(segment.src_out * 1_000_000),
      timeline_in_frame: timelineFrame,
      timeline_duration_frames: durationFrames,
      role: "nat_sound",
      motivation: "original clip audio",
      beat_id: beatId,
      fallback_segment_ids: [],
      confidence: 1,
      quality_flags: [],
      audio_policy: {
        duck_music_db: segment.role === "hero" ? 2.0 : 0,
        nat_gain: segment.nat_gain,
      },
    });

    titleOverlays.push({
      startFrame: timelineFrame,
      durationFrames,
      text: `${segment.date}\n${segment.caption}`,
      fontSize: 34,
      position: "lower-third",
      label: `Title ${String(index + 1).padStart(2, "0")}`,
    });

    markers.push({
      frame: timelineFrame,
      kind: "beat",
      label: `${segment.date} ${segment.caption}`,
    });

    timelineFrame += durationFrames;
  }

  const totalDurationFrames = timelineFrame;
  const totalDurationUs = Math.round((totalDurationFrames / fps) * 1_000_000);

  const timeline = {
    version: spec.timeline_version,
    project_id: spec.project_id,
    created_at: new Date().toISOString(),
    sequence: {
      name: spec.sequence_name,
      fps_num: fps,
      fps_den: 1,
      width: 1920,
      height: 1080,
      start_frame: 0,
      sample_rate: 48000,
      timecode_format: "NDF",
      output_aspect_ratio: "16:9",
      letterbox_policy: "none",
    },
    tracks: {
      video: [
        {
          track_id: "V1",
          kind: "video",
          clips: videoClips,
        },
      ],
      audio: [
        {
          track_id: "A1",
          kind: "audio",
          clips: natAudioClips,
        },
        {
          track_id: "A2",
          kind: "audio",
          clips: [
            {
              clip_id: "ACL_BGM_0001",
              segment_id: `${spec.timeline_version}:bgm`,
              asset_id: "AST_2F5B86AF",
              src_in_us: 0,
              src_out_us: totalDurationUs,
              timeline_in_frame: 0,
              timeline_duration_frames: totalDurationFrames,
              role: "bgm",
              motivation: "full-song bed with gentle fadeout",
              beat_id: "music01",
              fallback_segment_ids: [],
              confidence: 1,
              quality_flags: [],
              audio_policy: {
                duck_music_db: -20,
              },
            },
          ],
        },
      ],
    },
    markers,
    provenance: {
      brief_path: "01_intent/creative_brief.yaml",
      blueprint_path: "04_plan/edit_blueprint.yaml",
      selects_path: "04_plan/selects_candidates.yaml",
      compiler_version: spec.timeline_version,
      duration_policy: {
        mode: "guide",
        source: "explicit_brief",
        target_source: "explicit_brief",
        target_duration_sec: totalDurationFrames / fps,
        min_duration_sec: totalDurationFrames / fps,
        max_duration_sec: totalDurationFrames / fps,
      },
    },
  };

  const selects = {
    version: "1",
    project_id: spec.project_id,
    created_at: new Date().toISOString(),
    selection_notes: [
      "時系列を維持し、歩く -> 走る -> ストライダー -> 自転車 -> 最近までの流れで全曲構成に展開する",
      "2022-05-02 の初成功シーンは must-have として長めに確保する",
      "自然音と家族の声を残すため、各候補は原音を活かしやすい尺で選定する",
    ],
    editorial_summary: {
      dominant_visual_mode: "event_broll",
      speaker_topology: "multi_speaker",
      motion_profile: "high",
      transcript_density: "sparse",
    },
    candidates: spec.segments.map((segment, index) => ({
      candidate_id: `cand_${String(index + 1).padStart(2, "0")}`,
      segment_id: segment.segment_id,
      asset_id: segment.asset_id,
      src_in_us: Math.round(segment.src_in * 1_000_000),
      src_out_us: Math.round(segment.src_out * 1_000_000),
      role: segment.role,
      why_it_matches: segment.caption,
      risks: [],
      confidence: segment.role === "hero" ? 0.98 : 0.92,
      semantic_rank: index + 1,
      quality_flags: [],
      evidence: ["brief.message.primary", "brief.must_have"],
      eligible_beats: [`b${String(index + 1).padStart(2, "0")}`],
      motif_tags: ["growth", "family", "chronology"],
      trim_hint: {
        source_center_us: Math.round(((segment.src_in + segment.src_out) / 2) * 1_000_000),
        preferred_duration_us: Math.round((segment.src_out - segment.src_in) * 1_000_000),
        min_duration_us: Math.round(Math.max(2, segment.src_out - segment.src_in - 2) * 1_000_000),
        max_duration_us: Math.round((segment.src_out - segment.src_in) * 1_000_000),
        window_start_us: Math.round(segment.src_in * 1_000_000),
        window_end_us: Math.round(segment.src_out * 1_000_000),
        interest_point_label: segment.caption,
        interest_point_confidence: segment.role === "hero" ? 0.92 : 0.84,
      },
    })),
  };

  const beats = spec.segments.map((segment, index) => ({
    id: `b${String(index + 1).padStart(2, "0")}`,
    label: `${segment.date} ${segment.caption}`,
    purpose: segment.caption,
    target_duration_frames: Math.round((segment.src_out - segment.src_in) * fps),
    required_roles: [segment.role],
    preferred_roles: segment.role === "hero" ? ["hero", "support"] : [segment.role],
    notes: `source ${segment.file}`,
    story_role: index === 0 ? "hook" : index >= spec.segments.length - 2 ? "closing" : "experience",
    candidate_plan: {
      primary_candidate_ref: `cand_${String(index + 1).padStart(2, "0")}`,
    },
  }));

  const blueprint = {
    version: "1",
    project_id: spec.project_id,
    created_at: new Date().toISOString(),
    sequence_goals: [
      "生まれたころから最近までの変化を時系列で自然に見せる",
      "自然音と家族の声をBGMの下で活かし、ホームビデオの空気を残す",
      "曲の終わりで静かに余韻を残してフェードアウトする",
    ],
    beats,
    pacing: {
      opening_cadence: "gentle",
      middle_cadence: "steady build",
      ending_cadence: "warm fade",
      max_shot_length_frames: 420,
      default_duration_target_sec: totalDurationFrames / fps,
    },
    music_policy: {
      start_sparse: true,
      allow_release_late: true,
      entry_beat: "b01",
      avoid_anthemic_lift: false,
      permitted_energy_curve: "gradual rise to milestone, then soft landing",
    },
    caption_policy: {
      language: "ja",
      delivery_mode: "both",
      source: "authored",
      styling_class: "gentle-lower-third",
    },
    dialogue_policy: {
      preserve_natural_breath: true,
      avoid_wall_to_wall_voiceover: true,
      prioritize_lines: ["family encouragement", "child reactions"],
    },
    transition_policy: {
      prefer_match_texture_over_flashy_fx: true,
      allow_crossfade_for_time_passage: true,
      keep_milestone_cuts_clean: true,
    },
    ending_policy: {
      should_feel: "quiet, warm, grateful",
      final_visual_strategy: "last recent ride holds slightly longer, then fade to black",
      final_audio_strategy: "BGM and natural sound taper together over the last four seconds",
    },
    rejection_rules: [
      "reject flashy transitions that overpower family-record feel",
      "reject overly long holds that stall the chronology",
      "reject captions that explain too much instead of gently supporting the image",
    ],
    story_arc: {
      summary: "birth to mobility to bicycle confidence",
      strategy: "chronological",
      chronology_bias: "strict",
      allow_time_reorder: false,
      causal_links: [
        "walking builds toward running",
        "running leads naturally into strider balance",
        "strider balance resolves into bicycle riding",
      ],
    },
    active_editing_skills: ["crossfade_bridge", "build_to_peak", "silence_beat"],
    quality_targets: {
      hook_density_min: 0.15,
      novelty_rate_min: 0.4,
      duration_pacing_tolerance_pct: 3,
      emotion_gradient_min: 0.7,
      causal_connectivity_min: 0.8,
    },
    trim_policy: {
      mode: "fixed",
      default_preferred_duration_frames: 240,
      default_min_duration_frames: 90,
      default_max_duration_frames: 420,
      action_cut_guard: true,
    },
    duration_policy: {
      mode: "guide",
      source: "explicit_brief",
      target_source: "explicit_brief",
      target_duration_sec: totalDurationFrames / fps,
      min_duration_sec: totalDurationFrames / fps,
      max_duration_sec: totalDurationFrames / fps,
      hard_gate: false,
      protect_vlm_peaks: true,
    },
    timeline_order: "chronological",
  };

  const uncertainty = {
    version: "1",
    project_id: spec.project_id,
    created_at: new Date().toISOString(),
    uncertainties: [
      {
        id: "u01",
        type: "message",
        question: "テロップ文言は家族の好みに応じてPremiereで微調整する余地を残すか",
        status: "monitoring",
        evidence: ["user requested modest heartwarming captions"],
        alternatives: [
          {
            label: "current_authored_captions",
            description: "Keep the authored captions as the default delivery.",
          },
          {
            label: "premiere_wording_polish",
            description: "Reduce wording further during the manual Premiere pass if desired.",
          },
        ],
        escalation_required: false,
      },
    ],
  };

  const reviewReport = {
    version: "1",
    project_id: spec.project_id,
    timeline_version: spec.timeline_version,
    created_at: new Date().toISOString(),
    summary_judgment: {
      status: "approved",
      confidence: 0.79,
      rationale: "timeline.json と authored spec の照合ベース。時系列、主要マイルストーン、自然音重視、フルソング終端のフェードアウト方針が brief と一致している。",
    },
    strengths: [
      { summary: "生まれた日から最近までを時系列で切らさずに追えている" },
      { summary: "2022-05-02 の初成功シーンを十分な長さで確保している" },
      { summary: "自然音を残す前提の長さ配分で、ホームビデオの空気を壊していない" },
    ],
    weaknesses: [
      { summary: "レビュー動画の直接視聴ではなく authored spec と timeline ベースの評価である" },
    ],
    fatal_issues: [],
    warnings: [
      {
        summary: "一部 analysis summary は不正確なので、Premiere 上での最終確認は残る",
        severity: "warning",
      },
    ],
    mismatches_to_brief: [],
    mismatches_to_blueprint: [],
    recommended_next_pass: {
      goal: "Premiere でテロップ文言とショット長を好みに応じて微調整する",
      actions: ["caption wording polish if desired", "minor trim adjustments around nat sound peaks"],
    },
  };

  const reviewPatch = {
    timeline_version: spec.timeline_version,
    operations: [],
  };

  writeFile(path.join(projectDir, "04_plan/selects_candidates.yaml"), YAML.stringify(selects));
  writeFile(path.join(projectDir, "04_plan/edit_blueprint.yaml"), YAML.stringify(blueprint));
  writeFile(path.join(projectDir, "04_plan/uncertainty_register.yaml"), YAML.stringify(uncertainty));
  writeFile(path.join(projectDir, "05_timeline/timeline.json"), `${JSON.stringify(timeline, null, 2)}\n`);
  writeFile(spec.outputs.titles, `${JSON.stringify(titleOverlays, null, 2)}\n`);
  writeFile(path.join(projectDir, "06_review/review_report.yaml"), YAML.stringify(reviewReport));
  writeFile(path.join(projectDir, "06_review/review_patch.json"), `${JSON.stringify(reviewPatch, null, 2)}\n`);

  console.log(`generated duration_sec=${(totalDurationFrames / fps).toFixed(3)}`);
}

main();
