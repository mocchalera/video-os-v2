import * as fs from "node:fs";
import * as path from "node:path";
import { generateCandidateId } from "../compiler/candidate-ref.js";
import type {
  Beat,
  Candidate,
  CreativeBrief,
  EditBlueprint,
  LongformChapter,
  LongformEditConfig,
  LongformExclusion,
  LongformExclusionReason,
  LongformPlan,
  SelectsCandidates,
} from "../compiler/types.js";
import { loadSourceMap } from "../media/source-map.js";

const SECOND_US = 1_000_000;
const DEFAULT_MIN_WINDOW_SEC = 6;
const DEFAULT_MAX_WINDOW_SEC = 45;
const DEFAULT_SILENCE_GAP_SEC = 3;
const DEFAULT_CHAPTER_MAX_SEC = 12 * 60;
const DEFAULT_COVERAGE_INTERVAL_SEC = 4 * 60;
const DEFAULT_TARGET_SEC = 60 * 60;
const DEFAULT_FPS = 24;

const FILLER_ONLY = /^(?:えー+|えっと|えーと|あの+|その+|まあ+|なんか|うーん|んー+|um+|uh+|erm+)$/iu;
const HOUSEKEEPING = /(?:少々お待ち|準備(?:は|よろしい|でき)|マイク(?:の|を|が|テスト)|聞こえますか|音声(?:の|を|が)|録画(?:の|を|が)|休憩(?:に|を|です|します)|お手洗い|席をお立ち|配信(?:の|を|が)|接続(?:の|を|が)|スタッフ(?:さん)?(?:を|に)|開始まで)/u;
const STRUCTURAL_CUE = /(?:第[一二三四五六七八九十0-9]+部|続いて|次の(?:テーマ|話題|セッション)|ここから|最後に|まとめ|質疑応答|質問(?:です|があります|を)|Q\s*[&＆]\s*A)/iu;

export interface LongformTranscriptItem {
  item_id: string;
  speaker?: string;
  speaker_key?: string;
  start_us: number;
  end_us: number;
  text: string;
}

export interface LongformSource {
  asset_id: string;
  display_name?: string;
  duration_us: number;
  segments?: LongformSourceSegment[];
  items: LongformTranscriptItem[];
}

export interface LongformSourceSegment {
  segment_id: string;
  src_in_us: number;
  src_out_us: number;
}

export interface LongformPlanningResult {
  selects: SelectsCandidates;
  plan: LongformPlan;
}

interface ResolvedConfig {
  sourceSelection: "auto_primary_lane" | "all" | "explicit";
  primaryAssetIds: string[];
  minWindowUs: number;
  maxWindowUs: number;
  silenceGapUs: number;
  chapterMaxUs: number;
  coverageIntervalUs: number;
  targetDurationUs: number;
}

interface WindowDraft {
  assetId: string;
  segmentId: string;
  sourceOrder: number;
  startUs: number;
  endUs: number;
  items: LongformTranscriptItem[];
  text: string;
  importance: number;
  chapterId?: string;
  beatId?: string;
}

interface ChapterDraft {
  id: string;
  label: string;
  sourceOrder: number;
  assetId: string;
  startUs: number;
  endUs: number;
  windows: WindowDraft[];
  selected: WindowDraft[];
  budgetUs: number;
}

interface ClassifiedItem {
  keep: boolean;
  reason?: LongformExclusionReason;
}

export function isLongformEventBrief(brief: unknown): brief is CreativeBrief {
  if (!brief || typeof brief !== "object") return false;
  const editorial = (brief as { editorial?: unknown }).editorial;
  if (!editorial || typeof editorial !== "object") return false;
  return (editorial as { profile_hint?: unknown }).profile_hint === "longform-event";
}

export function buildLongformSelectsFromProject(
  projectDir: string,
  brief: CreativeBrief,
): LongformPlanningResult {
  return planLongformEvent(brief.project.id || brief.project_id, brief, loadLongformSources(projectDir));
}

export function loadLongformSources(projectDir: string): LongformSource[] {
  const transcriptDir = path.join(projectDir, "03_analysis", "transcripts");
  if (!fs.existsSync(transcriptDir)) {
    throw new Error("longform-event requires 03_analysis/transcripts/*.json");
  }

  const sourceMap = loadSourceMap(projectDir);
  const sourceEntryByAsset = sourceMap.entryMap;
  const durationByAsset = loadAssetDurations(projectDir);
  const segmentsByAsset = loadSourceSegments(projectDir);
  const sources: LongformSource[] = [];

  for (const filename of fs.readdirSync(transcriptDir).sort()) {
    if (!filename.endsWith(".json")) continue;
    const filePath = path.join(transcriptDir, filename);
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch {
      continue;
    }
    if (!raw || typeof raw !== "object") continue;
    const doc = raw as { asset_id?: unknown; items?: unknown };
    if (typeof doc.asset_id !== "string" || !Array.isArray(doc.items)) continue;
    const items = doc.items.flatMap((item): LongformTranscriptItem[] => {
      if (!item || typeof item !== "object") return [];
      const value = item as Record<string, unknown>;
      if (
        typeof value.item_id !== "string" ||
        typeof value.start_us !== "number" ||
        typeof value.end_us !== "number" ||
        typeof value.text !== "string" ||
        !Number.isFinite(value.start_us) ||
        !Number.isFinite(value.end_us)
      ) return [];
      return [{
        item_id: value.item_id,
        ...(typeof value.speaker === "string" ? { speaker: value.speaker } : {}),
        ...(typeof value.speaker_key === "string" ? { speaker_key: value.speaker_key } : {}),
        start_us: Math.max(0, Math.round(value.start_us)),
        end_us: Math.max(0, Math.round(value.end_us)),
        text: value.text,
      }];
    }).sort((a, b) => a.start_us - b.start_us || a.end_us - b.end_us || a.item_id.localeCompare(b.item_id));
    if (items.length === 0) continue;
    const transcriptEndUs = Math.max(...items.map((item) => item.end_us));
    sources.push({
      asset_id: doc.asset_id,
      display_name: sourceEntryByAsset.get(doc.asset_id)?.display_name,
      duration_us: Math.max(durationByAsset.get(doc.asset_id) ?? 0, transcriptEndUs),
      segments: segmentsByAsset.get(doc.asset_id),
      items,
    });
  }

  if (sources.length === 0) {
    throw new Error("longform-event found no usable transcript items");
  }
  return sources;
}

export function planLongformEvent(
  projectId: string,
  brief: CreativeBrief,
  inputSources: LongformSource[],
): LongformPlanningResult {
  if (!isLongformEventBrief(brief)) {
    throw new Error('longform planner requires editorial.profile_hint="longform-event"');
  }
  const sources = inputSources
    .map(normalizeSource)
    .filter((source) => source.items.length > 0);
  if (sources.length === 0) throw new Error("longform-event requires at least one transcript source");

  const config = resolveConfig(brief.longform, brief.project.runtime_target_sec);
  const sourceSelection = selectSources(sources, config);
  const selectedAssetIds = sourceSelection.selected.map((source) => source.asset_id);
  const excludedAssetIds = sourceSelection.excluded.map((source) => source.asset_id);
  const exclusions: LongformExclusion[] = sourceSelection.excluded.map((source) => ({
    asset_id: source.asset_id,
    src_in_us: 0,
    src_out_us: source.duration_us,
    reason: "alternate_angle_lane",
  }));

  const seenText = new Set<string>();
  const allWindows: WindowDraft[] = [];
  let speechDurationUs = 0;
  sourceSelection.selected.forEach((source, sourceOrder) => {
    const result = buildSourceWindows(source, sourceOrder, config, seenText);
    allWindows.push(...result.windows);
    exclusions.push(...result.exclusions);
    speechDurationUs += result.speechDurationUs;
  });
  if (allWindows.length === 0) {
    throw new Error("longform-event rejected every transcript window");
  }

  const chapters = buildChapters(allWindows, config);
  allocateChapterBudgets(chapters, config.targetDurationUs);
  for (const chapter of chapters) {
    const selected = selectChapterWindows(chapter, config.coverageIntervalUs);
    chapter.selected = selected;
    const selectedKeys = new Set(selected.map(windowKey));
    for (const window of chapter.windows) {
      if (selectedKeys.has(windowKey(window))) continue;
      exclusions.push(windowExclusion(window, "low_priority_for_target"));
    }
  }

  const selectedWindows = chapters
    .flatMap((chapter) => chapter.selected)
    .sort(compareWindows);
  const candidates = selectedWindows.map((window, index) =>
    windowToCandidate(projectId, window, index, selectedWindows.length)
  );
  const candidateRefByWindow = new Map<string, string>();
  candidates.forEach((candidate, index) => {
    candidateRefByWindow.set(windowKey(selectedWindows[index]!), candidate.candidate_id!);
  });

  const chapterArtifacts: LongformChapter[] = chapters.flatMap((chapter) => {
    const refs = chapter.selected
      .map((window) => candidateRefByWindow.get(windowKey(window)))
      .filter((value): value is string => Boolean(value));
    if (refs.length === 0) return [];
    return [{
      id: chapter.id,
      label: chapter.label,
      asset_ids: [chapter.assetId],
      source_in_us: chapter.startUs,
      source_out_us: chapter.endUs,
      available_duration_us: sumWindowDuration(chapter.windows),
      selected_duration_us: sumWindowDuration(chapter.selected),
      candidate_refs: refs,
    }];
  });
  const selectedDurationUs = sumWindowDuration(selectedWindows);
  const sourceDurationUs = sourceSelection.selected.reduce((sum, source) => sum + source.duration_us, 0);
  const coverageStatus =
    chapterArtifacts.length === chapters.length &&
    selectedDurationUs >= config.targetDurationUs * 0.85 &&
    selectedDurationUs <= config.targetDurationUs * 1.15
      ? "ready"
      : "insufficient";
  const plan: LongformPlan = {
    version: "1",
    mode: "reduction",
    source_selection: config.sourceSelection,
    selected_asset_ids: selectedAssetIds,
    excluded_asset_ids: excludedAssetIds,
    source_duration_us: sourceDurationUs,
    speech_duration_us: speechDurationUs,
    target_duration_us: config.targetDurationUs,
    selected_duration_us: selectedDurationUs,
    keep_ratio: roundRatio(selectedDurationUs / Math.max(1, sourceDurationUs)),
    coverage_status: coverageStatus,
    chapters: chapterArtifacts,
    exclusions: compactExclusions(exclusions),
  };
  const errors = validateLongformPlan(plan);
  if (errors.length > 0) throw new Error(`invalid longform plan: ${errors.join("; ")}`);

  return {
    plan,
    selects: {
      version: "1",
      project_id: projectId,
      decision_runtime: {
        runtime: "deterministic-longform-v1",
        role: "longform-reduction",
        attempted_runtimes: [{ runtime: "deterministic-longform-v1", status: "success" }],
      },
      candidates,
      editorial_summary: {
        dominant_visual_mode: "talking_head",
        speaker_topology: inferSpeakerTopology(sourceSelection.selected),
        motion_profile: "low",
        transcript_density: "dense",
      },
      longform_plan: plan,
    },
  };
}

export function buildLongformBlueprint(
  projectId: string,
  brief: CreativeBrief,
  selects: SelectsCandidates,
  now = new Date().toISOString(),
): EditBlueprint {
  const plan = selects.longform_plan;
  if (!plan || plan.mode !== "reduction") {
    throw new Error("longform blueprint requires selects.longform_plan");
  }
  if (plan.coverage_status !== "ready") {
    throw new Error("longform blueprint blocked: selected transcript coverage cannot satisfy target duration");
  }
  const chapterByCandidateRef = new Map<string, LongformChapter>();
  for (const chapter of plan.chapters) {
    for (const ref of chapter.candidate_refs) chapterByCandidateRef.set(ref, chapter);
  }
  const candidates = selects.candidates
    .filter((candidate) => candidate.role !== "reject" && candidate.candidate_id)
    .sort((a, b) => {
      const beatA = a.eligible_beats?.[0] ?? "";
      const beatB = b.eligible_beats?.[0] ?? "";
      return beatA.localeCompare(beatB) || a.asset_id.localeCompare(b.asset_id) || a.src_in_us - b.src_in_us;
    });
  if (candidates.length === 0) throw new Error("longform blueprint found no active candidates");

  const beats: Beat[] = candidates.map((candidate, index) => {
    const ref = candidate.candidate_id!;
    const chapter = chapterByCandidateRef.get(ref);
    const durationFrames = Math.max(1, Math.round((candidate.src_out_us - candidate.src_in_us) * DEFAULT_FPS / SECOND_US));
    const storyRole: Beat["story_role"] = index === 0
      ? "setup"
      : index === candidates.length - 1
        ? "closing"
        : "experience";
    return {
      id: candidate.eligible_beats?.[0] ?? `LF_B${String(index + 1).padStart(3, "0")}`,
      label: chapter?.label ?? `Longform section ${index + 1}`,
      purpose: `Retain approved transcript window in ${chapter?.id ?? "longform chapter"}`,
      target_duration_frames: durationFrames,
      required_roles: ["dialogue"],
      preferred_roles: [],
      story_role: storyRole,
      craft: {
        in_point: "clean_in_clean_out",
        out_point: "clean_in_clean_out",
        transition_in: "hard_cut",
        transition_out: "hard_cut",
        rhythm: "steady",
        shot_progression: "free",
      },
      skill_hints: ["longform_reduction", "talking_head_pacing"],
      candidate_plan: { primary_candidate_ref: ref, fallback_candidate_refs: [] },
      allow_revisit: false,
      candidate_constraints: {
        allow_interviewer_support: true,
        force_unique_utterances: true,
      },
    };
  });
  const beatIdsByCandidate = new Map(candidates.map((candidate, index) => [candidate.candidate_id!, beats[index]!.id]));
  const blueprintPlan: LongformPlan = {
    ...plan,
    chapters: plan.chapters.map((chapter) => ({
      ...chapter,
      candidate_refs: [...chapter.candidate_refs],
      beat_ids: chapter.candidate_refs
        .map((ref) => beatIdsByCandidate.get(ref))
        .filter((value): value is string => Boolean(value)),
    })),
    exclusions: plan.exclusions.map((item) => ({ ...item, utterance_ids: item.utterance_ids ? [...item.utterance_ids] : undefined })),
  };
  const targetSec = plan.target_duration_us / SECOND_US;
  const maxShotFrames = Math.max(...beats.map((beat) => beat.target_duration_frames));
  const autonomyMode = brief.autonomy && typeof brief.autonomy === "object" &&
      (brief.autonomy as { mode?: unknown }).mode === "collaborative"
    ? "collaborative"
    : "full";

  return {
    version: "1",
    project_id: projectId,
    created_at: now,
    decision_runtime: {
      runtime: "deterministic-longform-v1",
      role: "longform-chapter-planner",
      attempted_runtimes: [{ runtime: "deterministic-longform-v1", status: "success" }],
    },
    sequence_goals: [
      "Preserve the event chronology and chapter coverage",
      "Remove setup, waiting, duplicate, filler-only, and long-silence spans",
      "Keep every retained cut on transcript utterance boundaries",
    ],
    beats,
    pacing: {
      opening_cadence: "natural",
      middle_cadence: "chaptered-longform",
      ending_cadence: "resolved",
      max_shot_length_frames: maxShotFrames,
      default_duration_target_sec: targetSec,
      confirmed_preferences: {
        mode: autonomyMode,
        source: autonomyMode === "full" ? "ai_autonomous" : "human_confirmed",
        duration_target_sec: targetSec,
        confirmed_at: now,
        structure_choice: "chronological transcript reduction",
        pacing_notes: "hard cuts on utterance boundaries; retain representative coverage per chapter",
      },
    },
    music_policy: {
      start_sparse: true,
      allow_release_late: false,
      entry_beat: beats[0]!.id,
      avoid_anthemic_lift: true,
    },
    caption_policy: {
      language: "ja",
      delivery_mode: "both",
      source: "transcript",
      styling_class: "longform-event",
    },
    dialogue_policy: {
      preserve_natural_breath: true,
      avoid_wall_to_wall_voiceover: false,
      cut_tail_hold_sec: 0.35,
      cut_audio_fade_out_sec: 0.2,
    },
    transition_policy: {
      prefer_match_texture_over_flashy_fx: true,
      allow_hard_cuts: true,
      allow_crossfade_for_time_passage: false,
      avoid_speed_ramps: true,
      dissolve_overlap_frames: 0,
      keep_milestone_cuts_clean: true,
    },
    ending_policy: {
      should_feel: "complete and chronological",
      final_line_strategy: "retain the final substantive statement",
      avoid_cta: false,
      final_hold_min_frames: 12,
      final_visual_strategy: "hold the final speaker frame, then fade to black",
      final_audio_strategy: "preserve original room tone, then fade out",
      tail_hold_sec: 3,
      audio_fade_out_sec: 2,
      video_fade_out_sec: 1.5,
      video_fade_color: "black",
    },
    rejection_rules: [
      "exclude alternate camera lanes unless explicitly selected",
      "exclude filler-only and housekeeping utterances",
      "exclude exact duplicate utterances",
      "exclude long silence gaps",
      "exclude lowest-priority windows only after chapter coverage anchors are protected",
    ],
    story_arc: {
      summary: "Chronological event experience reduced chapter by chapter",
      strategy: "chronological",
      chronology_bias: "strict",
      allow_time_reorder: false,
    },
    resolved_profile: {
      id: "longform-event",
      source: "explicit_hint",
      rationale: "creative brief requested longform-event reduction mode",
    },
    resolved_policy: {
      id: "longform-documentary",
      source: "inferred",
      rationale: "longform-event defaults to chronological documentary policy",
    },
    active_editing_skills: ["longform_reduction", "talking_head_pacing"],
    dedupe_rules: {
      utterance_consumption: "unique",
      semantic_similarity_threshold: 0.94,
      allow_intentional_repetition: false,
    },
    quality_targets: {
      hook_density_min: 0,
      novelty_rate_min: 0.5,
      duration_pacing_tolerance_pct: 15,
      emotion_gradient_min: 0,
      causal_connectivity_min: 0.5,
    },
    trim_policy: {
      mode: "fixed",
      default_preferred_duration_frames: Math.round(30 * DEFAULT_FPS),
      default_min_duration_frames: Math.round(DEFAULT_MIN_WINDOW_SEC * DEFAULT_FPS),
      default_max_duration_frames: maxShotFrames,
      action_cut_guard: true,
    },
    duration_policy: {
      mode: "strict",
      source: "explicit_brief",
      target_source: "explicit_brief",
      target_duration_sec: targetSec,
      min_duration_sec: targetSec * 0.85,
      max_duration_sec: targetSec * 1.15,
      hard_gate: true,
      protect_vlm_peaks: false,
    },
    timeline_order: "chronological",
    track_layout: "single",
    longform_plan: blueprintPlan,
  };
}

export function validateLongformPlan(plan: LongformPlan): string[] {
  const errors: string[] = [];
  if (plan.selected_asset_ids.length === 0) errors.push("selected_asset_ids must not be empty");
  if (plan.source_duration_us <= 0) errors.push("source_duration_us must be positive");
  if (plan.speech_duration_us <= 0) errors.push("speech_duration_us must be positive");
  if (plan.target_duration_us <= 0) errors.push("target_duration_us must be positive");
  if (plan.selected_duration_us <= 0) errors.push("selected_duration_us must be positive");
  if (plan.chapters.length === 0) errors.push("chapters must not be empty");
  const refs = new Set<string>();
  for (const chapter of plan.chapters) {
    if (chapter.source_in_us >= chapter.source_out_us) errors.push(`${chapter.id} has invalid source range`);
    if (chapter.candidate_refs.length === 0) errors.push(`${chapter.id} has no selected candidates`);
    for (const ref of chapter.candidate_refs) {
      if (refs.has(ref)) errors.push(`candidate ref repeated across chapters: ${ref}`);
      refs.add(ref);
    }
  }
  return errors;
}

function loadAssetDurations(projectDir: string): Map<string, number> {
  const assetsPath = path.join(projectDir, "03_analysis", "assets.json");
  const result = new Map<string, number>();
  if (!fs.existsSync(assetsPath)) return result;
  try {
    const raw = JSON.parse(fs.readFileSync(assetsPath, "utf-8")) as { items?: unknown; assets?: unknown };
    const items = Array.isArray(raw.items) ? raw.items : Array.isArray(raw.assets) ? raw.assets : [];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const value = item as { asset_id?: unknown; duration_us?: unknown };
      if (typeof value.asset_id === "string" && typeof value.duration_us === "number" && value.duration_us > 0) {
        result.set(value.asset_id, Math.round(value.duration_us));
      }
    }
  } catch {
    return result;
  }
  return result;
}

function loadSourceSegments(projectDir: string): Map<string, LongformSourceSegment[]> {
  const segmentsPath = path.join(projectDir, "03_analysis", "segments.json");
  const result = new Map<string, LongformSourceSegment[]>();
  if (!fs.existsSync(segmentsPath)) return result;
  try {
    const raw = JSON.parse(fs.readFileSync(segmentsPath, "utf-8")) as { items?: unknown; segments?: unknown };
    const items = Array.isArray(raw.items) ? raw.items : Array.isArray(raw.segments) ? raw.segments : [];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const value = item as Record<string, unknown>;
      if (
        typeof value.segment_id !== "string" ||
        typeof value.asset_id !== "string" ||
        typeof value.src_in_us !== "number" ||
        typeof value.src_out_us !== "number" ||
        value.src_out_us <= value.src_in_us
      ) continue;
      const group = result.get(value.asset_id) ?? [];
      group.push({
        segment_id: value.segment_id,
        src_in_us: Math.max(0, Math.round(value.src_in_us)),
        src_out_us: Math.max(0, Math.round(value.src_out_us)),
      });
      result.set(value.asset_id, group);
    }
    for (const group of result.values()) {
      group.sort((a, b) => a.src_in_us - b.src_in_us || a.src_out_us - b.src_out_us || a.segment_id.localeCompare(b.segment_id));
    }
  } catch {
    return result;
  }
  return result;
}

function normalizeSource(source: LongformSource): LongformSource {
  return {
    ...source,
    duration_us: Math.max(1, Math.round(source.duration_us)),
    segments: source.segments
      ?.filter((segment) => segment.src_out_us > segment.src_in_us)
      .map((segment) => ({
        ...segment,
        src_in_us: Math.max(0, Math.round(segment.src_in_us)),
        src_out_us: Math.max(0, Math.round(segment.src_out_us)),
      }))
      .sort((a, b) => a.src_in_us - b.src_in_us || a.src_out_us - b.src_out_us || a.segment_id.localeCompare(b.segment_id)),
    items: source.items
      .filter((item) => Number.isFinite(item.start_us) && Number.isFinite(item.end_us))
      .map((item) => ({
        ...item,
        start_us: Math.max(0, Math.round(item.start_us)),
        end_us: Math.max(0, Math.round(item.end_us)),
        text: item.text.normalize("NFKC").trim(),
      }))
      .sort((a, b) => a.start_us - b.start_us || a.end_us - b.end_us || a.item_id.localeCompare(b.item_id)),
  };
}

function resolveConfig(config: LongformEditConfig | undefined, runtimeTargetSec: number | undefined): ResolvedConfig {
  const sourceSelection = config?.source_selection ?? "auto_primary_lane";
  const primaryAssetIds = [...new Set(config?.primary_asset_ids ?? [])];
  if (sourceSelection === "explicit" && primaryAssetIds.length === 0) {
    throw new Error("longform.source_selection=explicit requires primary_asset_ids");
  }
  const minWindowSec = bounded(config?.min_window_sec, DEFAULT_MIN_WINDOW_SEC, 2, 30);
  const maxWindowSec = bounded(config?.max_window_sec, DEFAULT_MAX_WINDOW_SEC, Math.max(10, minWindowSec), 180);
  return {
    sourceSelection,
    primaryAssetIds,
    minWindowUs: Math.round(minWindowSec * SECOND_US),
    maxWindowUs: Math.round(maxWindowSec * SECOND_US),
    silenceGapUs: Math.round(bounded(config?.silence_gap_cut_sec, DEFAULT_SILENCE_GAP_SEC, 0.5, 30) * SECOND_US),
    chapterMaxUs: Math.round(bounded(config?.chapter_max_sec, DEFAULT_CHAPTER_MAX_SEC, 60, 3600) * SECOND_US),
    coverageIntervalUs: Math.round(bounded(config?.coverage_interval_sec, DEFAULT_COVERAGE_INTERVAL_SEC, 30, 900) * SECOND_US),
    targetDurationUs: Math.round(Math.max(1, runtimeTargetSec ?? DEFAULT_TARGET_SEC) * SECOND_US),
  };
}

function selectSources(
  sources: LongformSource[],
  config: ResolvedConfig,
): { selected: LongformSource[]; excluded: LongformSource[] } {
  const ordered = [...sources].sort(compareSources);
  if (config.sourceSelection === "all") return { selected: ordered, excluded: [] };
  if (config.sourceSelection === "explicit") {
    const byId = new Map(ordered.map((source) => [source.asset_id, source]));
    const missing = config.primaryAssetIds.filter((id) => !byId.has(id));
    if (missing.length > 0) throw new Error(`longform primary_asset_ids missing transcripts: ${missing.join(", ")}`);
    const selected = config.primaryAssetIds.map((id) => byId.get(id)!);
    const selectedIds = new Set(config.primaryAssetIds);
    return { selected, excluded: ordered.filter((source) => !selectedIds.has(source.asset_id)) };
  }

  const laneGroups = new Map<string, LongformSource[]>();
  for (const source of ordered) {
    const lane = inferLaneKey(source.display_name);
    if (!lane) continue;
    const group = laneGroups.get(lane) ?? [];
    group.push(source);
    laneGroups.set(lane, group);
  }
  const groups = [...laneGroups.entries()]
    .filter(([, group]) => group.length >= 2)
    .map(([lane, group]) => ({ lane, group, durationUs: sumSourceDuration(group) }));
  if (groups.length < 2) return { selected: ordered, excluded: [] };
  const coveredCount = groups.reduce((sum, group) => sum + group.group.length, 0);
  if (coveredCount < Math.ceil(ordered.length * 0.75)) return { selected: ordered, excluded: [] };
  const longest = Math.max(...groups.map((group) => group.durationUs));
  const shortest = Math.min(...groups.map((group) => group.durationUs));
  if (shortest / Math.max(1, longest) < 0.55) return { selected: ordered, excluded: [] };
  groups.sort((a, b) => b.durationUs - a.durationUs || a.lane.localeCompare(b.lane));
  const primaryGroup = groups[0]!;
  const alternateGroups = groups.slice(1);
  if (alternateGroups.some((group) => transcriptGroupOverlap(primaryGroup.group, group.group) < 0.35)) {
    return { selected: ordered, excluded: [] };
  }
  const selected = [...primaryGroup.group].sort(compareSources);
  const selectedIds = new Set(selected.map((source) => source.asset_id));
  return { selected, excluded: ordered.filter((source) => !selectedIds.has(source.asset_id)) };
}

function buildSourceWindows(
  source: LongformSource,
  sourceOrder: number,
  config: ResolvedConfig,
  seenText: Set<string>,
): { windows: WindowDraft[]; exclusions: LongformExclusion[]; speechDurationUs: number } {
  const windows: WindowDraft[] = [];
  const exclusions: LongformExclusion[] = [];
  let current: LongformTranscriptItem[] = [];
  let previousEndUs = 0;

  const flush = (): void => {
    if (current.length === 0) return;
    const window = makeWindow(source, sourceOrder, current);
    if (window.endUs - window.startUs < config.minWindowUs && normalizeText(window.text).length < 8) {
      exclusions.push(windowExclusion(window, "short_fragment"));
    } else {
      windows.push(window);
    }
    current = [];
  };

  for (const item of source.items) {
    const classification = classifyItem(item, seenText);
    if (previousEndUs > 0 && item.start_us - previousEndUs >= config.silenceGapUs) {
      flush();
      exclusions.push({
        asset_id: source.asset_id,
        src_in_us: previousEndUs,
        src_out_us: item.start_us,
        reason: "silence_gap",
      });
    }
    previousEndUs = Math.max(previousEndUs, item.end_us);
    if (!classification.keep) {
      flush();
      exclusions.push({
        asset_id: source.asset_id,
        src_in_us: item.start_us,
        src_out_us: item.end_us,
        reason: classification.reason ?? "invalid_transcript",
        utterance_ids: [item.item_id],
      });
      continue;
    }

    const nextStart = current[0]?.start_us ?? item.start_us;
    const prior = current[current.length - 1];
    const gap = prior ? item.start_us - prior.end_us : 0;
    if (
      current.length > 0 &&
      (item.end_us - nextStart > config.maxWindowUs || gap >= config.silenceGapUs || STRUCTURAL_CUE.test(item.text))
    ) {
      flush();
    }
    current.push(item);
  }
  flush();
  return {
    windows: mergeShortAdjacentWindows(windows, config),
    exclusions,
    speechDurationUs: unionDurationUs(source.items),
  };
}

function classifyItem(item: LongformTranscriptItem, seenText: Set<string>): ClassifiedItem {
  const text = item.text.normalize("NFKC").trim();
  const normalized = normalizeText(text);
  if (item.end_us <= item.start_us || normalized.length === 0 || /\[(?:unreliable|inaudible|無音|聞き取れ)/iu.test(text)) {
    return { keep: false, reason: "invalid_transcript" };
  }
  if (FILLER_ONLY.test(normalized)) return { keep: false, reason: "filler_only" };
  if (HOUSEKEEPING.test(text)) return { keep: false, reason: "housekeeping" };
  if (normalized.length >= 10 && seenText.has(normalized)) {
    return { keep: false, reason: "duplicate_utterance" };
  }
  if (normalized.length >= 10) seenText.add(normalized);
  return { keep: true };
}

function makeWindow(source: LongformSource, sourceOrder: number, items: LongformTranscriptItem[]): WindowDraft {
  const startUs = items[0]!.start_us;
  const endUs = Math.max(...items.map((item) => item.end_us));
  const text = items.map((item) => item.text).join(" ").replace(/\s+/g, " ").trim();
  return {
    assetId: source.asset_id,
    segmentId: resolveWindowSegmentId(source, startUs, endUs),
    sourceOrder,
    startUs,
    endUs,
    items: [...items],
    text,
    importance: scoreWindow(text, endUs - startUs),
  };
}

function resolveWindowSegmentId(source: LongformSource, startUs: number, endUs: number): string {
  const segments = source.segments ?? [];
  const midpointUs = startUs + (endUs - startUs) / 2;
  const containing = segments.find((segment) =>
    segment.src_in_us <= startUs && segment.src_out_us >= endUs
  ) ?? segments.find((segment) =>
    segment.src_in_us <= midpointUs && segment.src_out_us >= midpointUs
  );
  return containing?.segment_id ?? `LF_SEG_${source.asset_id}_${String(startUs).padStart(12, "0")}`;
}

function mergeShortAdjacentWindows(windows: WindowDraft[], config: ResolvedConfig): WindowDraft[] {
  if (windows.length <= 1) return windows;
  const merged: WindowDraft[] = [];
  for (const window of windows) {
    const previous = merged[merged.length - 1];
    const short = window.endUs - window.startUs < config.minWindowUs;
    if (
      short && previous && previous.assetId === window.assetId &&
      window.startUs - previous.endUs < config.silenceGapUs &&
      window.endUs - previous.startUs <= config.maxWindowUs
    ) {
      previous.endUs = window.endUs;
      previous.items.push(...window.items);
      previous.text = `${previous.text} ${window.text}`.trim();
      previous.importance = scoreWindow(previous.text, previous.endUs - previous.startUs);
    } else {
      merged.push({ ...window, items: [...window.items] });
    }
  }
  return merged;
}

function buildChapters(windows: WindowDraft[], config: ResolvedConfig): ChapterDraft[] {
  const ordered = [...windows].sort(compareWindows);
  const chapters: ChapterDraft[] = [];
  let current: ChapterDraft | undefined;
  for (const window of ordered) {
    const shouldBreak = !current || current.assetId !== window.assetId ||
      window.endUs - current.startUs > config.chapterMaxUs ||
      (STRUCTURAL_CUE.test(window.text) && window.startUs - current.startUs >= 2 * 60 * SECOND_US);
    if (shouldBreak) {
      current = {
        id: `CH_${String(chapters.length + 1).padStart(3, "0")}`,
        label: chapterLabel(window.text, chapters.length + 1),
        sourceOrder: window.sourceOrder,
        assetId: window.assetId,
        startUs: window.startUs,
        endUs: window.endUs,
        windows: [],
        selected: [],
        budgetUs: 0,
      };
      chapters.push(current);
    }
    const activeChapter = current!;
    window.chapterId = activeChapter.id;
    activeChapter.windows.push(window);
    activeChapter.endUs = Math.max(activeChapter.endUs, window.endUs);
  }
  return chapters;
}

function allocateChapterBudgets(chapters: ChapterDraft[], targetUs: number): void {
  const totalAvailable = chapters.reduce((sum, chapter) => sum + sumWindowDuration(chapter.windows), 0);
  if (targetUs >= totalAvailable) {
    for (const chapter of chapters) chapter.budgetUs = sumWindowDuration(chapter.windows);
    return;
  }
  const minimumPerChapter = Math.min(45 * SECOND_US, targetUs / Math.max(1, chapters.length));
  const raw = chapters.map((chapter) => Math.max(
    minimumPerChapter,
    targetUs * sumWindowDuration(chapter.windows) / Math.max(1, totalAvailable),
  ));
  const scale = targetUs / raw.reduce((sum, value) => sum + value, 0);
  chapters.forEach((chapter, index) => {
    chapter.budgetUs = Math.min(sumWindowDuration(chapter.windows), Math.max(1, Math.round(raw[index]! * scale)));
  });
}

function selectChapterWindows(chapter: ChapterDraft, coverageIntervalUs: number): WindowDraft[] {
  const availableUs = sumWindowDuration(chapter.windows);
  if (availableUs <= chapter.budgetUs * 1.02) return [...chapter.windows];
  const mandatory = new Map<string, WindowDraft>();
  const spanStart = chapter.startUs;
  for (const window of chapter.windows) {
    const bucket = Math.floor(((window.startUs + window.endUs) / 2 - spanStart) / coverageIntervalUs);
    const key = String(bucket);
    const existing = mandatory.get(key);
    if (!existing || window.importance > existing.importance) mandatory.set(key, window);
  }
  mandatory.set(`first:${windowKey(chapter.windows[0]!)}`, chapter.windows[0]!);
  mandatory.set(`last:${windowKey(chapter.windows[chapter.windows.length - 1]!)}`, chapter.windows[chapter.windows.length - 1]!);
  const selectedByKey = new Map<string, WindowDraft>();
  for (const window of mandatory.values()) selectedByKey.set(windowKey(window), window);
  let selectedUs = sumWindowDuration([...selectedByKey.values()]);
  const remaining = chapter.windows
    .filter((window) => !selectedByKey.has(windowKey(window)))
    .sort((a, b) => b.importance - a.importance || a.startUs - b.startUs);
  for (const window of remaining) {
    const durationUs = window.endUs - window.startUs;
    if (selectedUs + durationUs > chapter.budgetUs * 1.03) continue;
    selectedByKey.set(windowKey(window), window);
    selectedUs += durationUs;
  }
  if (selectedUs < chapter.budgetUs * 0.9) {
    const candidate = remaining
      .filter((window) => !selectedByKey.has(windowKey(window)))
      .sort((a, b) =>
        Math.abs(chapter.budgetUs - (selectedUs + (a.endUs - a.startUs))) -
          Math.abs(chapter.budgetUs - (selectedUs + (b.endUs - b.startUs))) ||
        b.importance - a.importance
      )[0];
    if (candidate) selectedByKey.set(windowKey(candidate), candidate);
  }
  return [...selectedByKey.values()].sort(compareWindows);
}

function windowToCandidate(
  projectId: string,
  window: WindowDraft,
  index: number,
  total: number,
): Candidate {
  const beatId = `LF_B${String(index + 1).padStart(3, "0")}`;
  window.beatId = beatId;
  const durationUs = window.endUs - window.startUs;
  const candidate: Candidate = {
    segment_id: window.segmentId,
    asset_id: window.assetId,
    src_in_us: window.startUs,
    src_out_us: window.endUs,
    role: "dialogue",
    why_it_matches: `Retained by longform reduction for ${window.chapterId ?? "chronological coverage"}`,
    risks: ["transcript_only_longform_selection"],
    confidence: Number((0.6 + window.importance * 0.35).toFixed(3)),
    semantic_rank: index + 1,
    evidence: window.items.map((item) => `transcript:${item.item_id}`),
    eligible_beats: [beatId],
    story_role: index === 0 ? "setup" : index === total - 1 ? "closing" : "experience",
    transcript_excerpt: window.text.slice(0, 600),
    motif_tags: window.chapterId ? [window.chapterId] : [],
    utterance_ids: window.items.map((item) => item.item_id),
    speaker_role: "unknown",
    semantic_dedupe_key: normalizeText(window.text).slice(0, 160),
    editorial_signals: {
      silence_ratio: 0,
      speech_intensity_score: window.importance,
      semantic_cluster_id: window.chapterId,
    },
    trim_hint: {
      source_center_us: Math.round((window.startUs + window.endUs) / 2),
      preferred_duration_us: durationUs,
      min_duration_us: durationUs,
      max_duration_us: durationUs,
      window_start_us: window.startUs,
      window_end_us: window.endUs,
      interest_point_label: "longform transcript window",
      interest_point_confidence: window.importance,
      rationale: "utterance-bounded reduction window",
      recommended_in_us: window.startUs,
      recommended_out_us: window.endUs,
    },
    quality_confidence: "low",
  };
  candidate.candidate_id = generateCandidateId(projectId, candidate);
  return candidate;
}

function compactExclusions(exclusions: LongformExclusion[]): LongformExclusion[] {
  const ordered = exclusions
    .filter((item) => item.src_out_us >= item.src_in_us)
    .sort((a, b) => a.asset_id.localeCompare(b.asset_id) || a.src_in_us - b.src_in_us || a.reason.localeCompare(b.reason));
  const result: LongformExclusion[] = [];
  for (const item of ordered) {
    const previous = result[result.length - 1];
    if (
      previous && previous.asset_id === item.asset_id && previous.reason === item.reason &&
      item.src_in_us - previous.src_out_us <= 250_000
    ) {
      previous.src_out_us = Math.max(previous.src_out_us, item.src_out_us);
      previous.utterance_ids = [...new Set([...(previous.utterance_ids ?? []), ...(item.utterance_ids ?? [])])];
    } else {
      result.push({ ...item, utterance_ids: item.utterance_ids ? [...item.utterance_ids] : undefined });
    }
  }
  return result;
}

function inferSpeakerTopology(sources: LongformSource[]): "solo_primary" | "interviewer_guest" | "multi_speaker" | "unknown" {
  const speakers = new Set<string>();
  for (const source of sources) {
    for (const item of source.items) {
      const speaker = item.speaker_key ?? item.speaker;
      if (speaker) speakers.add(speaker);
    }
  }
  if (speakers.size === 0) return "unknown";
  if (speakers.size === 1) return "solo_primary";
  if (speakers.size === 2) return "interviewer_guest";
  return "multi_speaker";
}

function transcriptGroupOverlap(a: LongformSource[], b: LongformSource[]): number {
  const aTexts = transcriptTextSet(a);
  const bTexts = transcriptTextSet(b);
  if (aTexts.size === 0 || bTexts.size === 0) return 0;
  let shared = 0;
  for (const text of aTexts) {
    if (bTexts.has(text)) shared += 1;
  }
  return shared / Math.max(1, Math.min(aTexts.size, bTexts.size));
}

function transcriptTextSet(sources: LongformSource[]): Set<string> {
  const result = new Set<string>();
  for (const source of sources) {
    for (const item of source.items) {
      const normalized = normalizeText(item.text);
      if (normalized.length >= 10) result.add(normalized);
    }
  }
  return result;
}

function inferLaneKey(displayName: string | undefined): string | undefined {
  if (!displayName) return undefined;
  const normalized = displayName.normalize("NFKC").toLowerCase()
    .replace(/^\s*\d+[-_.\s]*/u, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  const token = normalized.split(/\s+/u)[0];
  if (!token || /^(?:clip|part|segment|video|movie|take)$/u.test(token)) return undefined;
  return token;
}

function compareSources(a: LongformSource, b: LongformSource): number {
  const ordinalA = leadingOrdinal(a.display_name);
  const ordinalB = leadingOrdinal(b.display_name);
  return ordinalA - ordinalB || (a.display_name ?? a.asset_id).localeCompare(b.display_name ?? b.asset_id) || a.asset_id.localeCompare(b.asset_id);
}

function leadingOrdinal(displayName: string | undefined): number {
  const match = displayName?.match(/^\s*(\d+)/u);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function compareWindows(a: WindowDraft, b: WindowDraft): number {
  return a.sourceOrder - b.sourceOrder || a.startUs - b.startUs || a.endUs - b.endUs;
}

function normalizeText(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{S}\s]/gu, "");
}

function scoreWindow(text: string, durationUs: number): number {
  const normalizedLength = normalizeText(text).length;
  const durationSec = Math.max(1, durationUs / SECOND_US);
  const density = Math.min(1, normalizedLength / durationSec / 6);
  const structural = STRUCTURAL_CUE.test(text) ? 0.15 : 0;
  const substantive = /(?:なぜ|理由|結果|経験|思う|感じ|大切|課題|でき|変わ|学|気づ|つまり|例えば|具体的)/u.test(text) ? 0.12 : 0;
  const question = /[?？]/u.test(text) ? 0.05 : 0;
  return Math.min(1, Number((0.45 + density * 0.28 + structural + substantive + question).toFixed(3)));
}

function chapterLabel(text: string, index: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return `Chapter ${index}`;
  return clean.length <= 42 ? clean : `${clean.slice(0, 42)}…`;
}

function windowKey(window: WindowDraft): string {
  return `${window.assetId}:${window.startUs}:${window.endUs}`;
}

function windowExclusion(window: WindowDraft, reason: LongformExclusionReason): LongformExclusion {
  return {
    asset_id: window.assetId,
    src_in_us: window.startUs,
    src_out_us: window.endUs,
    reason,
    utterance_ids: window.items.map((item) => item.item_id),
  };
}

function sumWindowDuration(windows: WindowDraft[]): number {
  return windows.reduce((sum, window) => sum + Math.max(0, window.endUs - window.startUs), 0);
}

function sumSourceDuration(sources: LongformSource[]): number {
  return sources.reduce((sum, source) => sum + source.duration_us, 0);
}

function unionDurationUs(items: LongformTranscriptItem[]): number {
  const ranges = items
    .filter((item) => item.end_us > item.start_us)
    .map((item) => ({ start: item.start_us, end: item.end_us }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  let total = 0;
  let start = -1;
  let end = -1;
  for (const range of ranges) {
    if (start < 0) {
      start = range.start;
      end = range.end;
      continue;
    }
    if (range.start <= end) {
      end = Math.max(end, range.end);
      continue;
    }
    total += end - start;
    start = range.start;
    end = range.end;
  }
  if (start >= 0) total += end - start;
  return total;
}

function roundRatio(value: number): number {
  return Number(Math.min(1, Math.max(0, value)).toFixed(4));
}

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
