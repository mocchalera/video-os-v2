/**
 * Shared fixture builders for the editorial storyboard projection tests.
 * All fixtures live in temp directories; canonical artifacts are minimal
 * but schema-shaped, and no ffmpeg run is required.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stringify as stringifyYaml } from "yaml";

export interface FixtureBeatOptions {
  id: string;
  label: string;
  frames?: number;
  primaryRef?: string;
  fallbackRefs?: string[];
  purpose?: string;
  storyRole?: string;
}

export interface FixtureCandidateOptions {
  candidateId: string;
  segmentId: string;
  assetId: string;
  srcInUs?: number;
  srcOutUs?: number;
  mediaKind?: "video" | "audio" | "image";
  transcriptExcerpt?: string;
  trimHintSourceCenterUs?: number;
  qualityFlags?: string[];
  risks?: string[];
}

export interface FixtureProjectOptions {
  beats: FixtureBeatOptions[];
  candidates: FixtureCandidateOptions[];
  withTimeline?: boolean;
  timelineOverrunBeatId?: string;
  deliveryProfiles?: Array<{
    profileId: string;
    platform: string;
    aspectRatio: string;
    width?: number;
    height?: number;
    fpsMode?: string;
  }>;
}

function yamlDoc(value: unknown): string {
  return stringifyYaml(value, { lineWidth: 0 });
}

export function createFixtureProject(options: FixtureProjectOptions): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "storyboard-fixture-"));
  fs.mkdirSync(path.join(projectDir, "01_intent"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, "04_plan"), { recursive: true });

  const brief = {
    version: "1",
    project_id: "fixture-storyboard",
    project: { id: "fixture-storyboard", title: "Storyboard Fixture", format: "short-brand-film" },
    message: { primary: "fixture message" },
  };
  fs.writeFileSync(path.join(projectDir, "01_intent/creative_brief.yaml"), yamlDoc(brief));

  const blueprintBeats = options.beats.map((beat) => ({
    id: beat.id,
    label: beat.label,
    purpose: beat.purpose ?? `${beat.label} purpose`,
    target_duration_frames: beat.frames ?? 100,
    required_roles: ["hero"],
    ...(beat.storyRole ? { story_role: beat.storyRole } : {}),
    ...((beat.primaryRef || beat.fallbackRefs)
      ? {
          candidate_plan: {
            ...(beat.primaryRef ? { primary_candidate_ref: beat.primaryRef } : {}),
            ...(beat.fallbackRefs ? { fallback_candidate_refs: beat.fallbackRefs } : {}),
          },
        }
      : {}),
  }));

  const blueprint = {
    version: "1",
    project_id: "fixture-storyboard",
    sequence_goals: ["fixture goal"],
    beats: blueprintBeats,
    pacing: { opening_cadence: "brisk", middle_cadence: "steady", ending_cadence: "warm" },
    music_policy: { start_sparse: true, allow_release_late: false, entry_beat: options.beats[0]?.id ?? "b01", avoid_anthemic_lift: true },
    caption_policy: { language: "ja", delivery_mode: "burn_in", source: "transcript", styling_class: "clean-lower-third" },
    dialogue_policy: { preserve_natural_breath: true, avoid_wall_to_wall_voiceover: true },
    transition_policy: { prefer_match_texture_over_flashy_fx: true },
    ending_policy: { should_feel: "restorative" },
    rejection_rules: ["fixture rejection rule"],
    source_media: { mode: "video", media_kinds: ["video"], visual_candidate_count: options.candidates.length, audio_only_candidate_count: 0 },
  };
  fs.writeFileSync(path.join(projectDir, "04_plan/edit_blueprint.yaml"), yamlDoc(blueprint));

  const selects = {
    version: "1",
    project_id: "fixture-storyboard",
    candidates: options.candidates.map((candidate) => ({
      candidate_id: candidate.candidateId,
      segment_id: candidate.segmentId,
      asset_id: candidate.assetId,
      src_in_us: candidate.srcInUs ?? 1_000_000,
      src_out_us: candidate.srcOutUs ?? 5_000_000,
      role: "hero",
      why_it_matches: "fixture",
      risks: candidate.risks ?? [],
      confidence: 0.9,
      ...(candidate.mediaKind ? { media_kind: candidate.mediaKind } : {}),
      ...(candidate.transcriptExcerpt ? { transcript_excerpt: candidate.transcriptExcerpt } : {}),
      ...(candidate.trimHintSourceCenterUs !== undefined
        ? { trim_hint: { source_center_us: candidate.trimHintSourceCenterUs } }
        : {}),
      ...(candidate.qualityFlags ? { quality_flags: candidate.qualityFlags } : {}),
    })),
    source_media: { mode: "video", media_kinds: ["video"], visual_candidate_count: options.candidates.length, audio_only_candidate_count: 0 },
  };
  fs.writeFileSync(path.join(projectDir, "04_plan/selects_candidates.yaml"), yamlDoc(selects));

  const uncertainty = {
    version: "1",
    project_id: "fixture-storyboard",
    uncertainties: [
      {
        id: "U001",
        type: "ending",
        question: `should ${options.beats[options.beats.length - 1]?.id ?? "b01"} end on speech or silence?`,
        status: "monitoring",
        evidence: [`${options.beats[options.beats.length - 1]?.id ?? "b01"} is affected`],
        alternatives: [{ label: "a", description: "a", impact: "i" }],
        escalation_required: false,
      },
    ],
  };
  fs.writeFileSync(path.join(projectDir, "04_plan/uncertainty_register.yaml"), yamlDoc(uncertainty));

  if (options.withTimeline) {
    let cursor = 0;
    const clips = options.beats.map((beat, index) => {
      const start = cursor;
      const overrun = options.timelineOverrunBeatId === beat.id ? 20 : 0;
      const duration = (beat.frames ?? 100) + overrun;
      cursor += duration;
      return {
        clip_id: `CLP_${String(index + 1).padStart(4, "0")}`,
        segment_id: `${beat.id.toUpperCase()}_SEG`,
        asset_id: `AST_${index + 1}`,
        src_in_us: 1_000_000,
        src_out_us: 4_000_000,
        timeline_in_frame: start,
        timeline_duration_frames: duration,
        role: "hero",
        motivation: "fixture motivation",
        beat_id: beat.id,
        fallback_segment_ids: [],
        candidate_ref: beat.primaryRef ?? undefined,
      };
    });
    const timeline = {
      version: "2",
      project_id: "fixture-storyboard",
      sequence: {
        name: "Storyboard Fixture",
        fps_num: 24,
        fps_den: 1,
        width: 1920,
        height: 1080,
        start_frame: 0,
        output_aspect_ratio: "16:9",
      },
      tracks: { video: [{ track_id: "V1", kind: "video", clips }] },
    };
    fs.mkdirSync(path.join(projectDir, "05_timeline"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, "05_timeline/timeline.json"), JSON.stringify(timeline, null, 2));
  }

  for (const profile of options.deliveryProfiles ?? []) {
    const dir = path.join(projectDir, "07_package/delivery_profiles");
    fs.mkdirSync(dir, { recursive: true });
    const doc = {
      version: "1.0.0",
      project_id: "fixture-storyboard",
      artifact_version: "delivery-profile-v1",
      created_at: "2026-08-01T00:00:00Z",
      profile_id: profile.profileId,
      profile_name: profile.profileId,
      platform: profile.platform,
      release_mode: "internal",
      video_constraints: {
        aspect_ratio: profile.aspectRatio,
        resolution: { width: profile.width ?? 1080, height: profile.height ?? 1920 },
        frame_rate_mode: profile.fpsMode ?? "cfr_30",
        color_space: "rec709",
      },
      audio_constraints: { loudness_lufs: -14, true_peak_dbtp: -1, sample_rate_hz: 48000, channel_layout: "stereo" },
      caption_constraints: { mode: "burned_in", sidecar_format: null, language_required: ["ja"] },
      duration_constraints: { min_seconds: 5, max_seconds: 90 },
      file_naming: { pattern: "x", allowed_extensions: [".mp4"] },
      metadata_requirements: { title_required: false, description_required: false, tags_required: false, thumbnail_required: false, custom_fields: [] },
      privacy_strictness: "internal_only",
      rights_strictness: "internal_only",
      provenance: { producer: "operator-command", inputs: [], hash_policy: { algorithm: "sha256", canonicalization: "yaml-to-normalized-json-v1", excluded_fields: [] } },
    };
    fs.writeFileSync(path.join(dir, `${profile.profileId}.yaml`), yamlDoc(doc));
  }

  return projectDir;
}
