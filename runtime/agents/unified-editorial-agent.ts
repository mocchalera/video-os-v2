import * as path from "node:path";
import {
  completeEditorialJson,
  decisionRuntimeRecord,
  deterministicDecisionRuntime,
  injectedDecisionRuntime,
  type DecisionRuntimeRecord,
  type EditorialLlmConnectorOptions,
} from "../connectors/editorial-llm.js";
import type { MarlinAssetEvents, MarlinEvent, MarlinEventsArtifact } from "../connectors/marlin-types.js";
import type { SegmentItem } from "../connectors/ffmpeg-segmenter.js";
import type {
  Beat,
  Candidate,
  CreativeBrief,
  EditBlueprint,
  Role,
  SelectStoryRole,
  SelectsCandidates,
  TrimHint,
} from "../artifacts/types.js";
import { validateArtifact } from "../artifacts/loaders.js";
import { ensureCandidateIds, getCandidateRef } from "../compiler/candidate-ref.js";
import { contextKnowledgePromptPayload } from "../context-knowledge.js";
import type { CraftDirective } from "../compiler/types.js";
import type { KeyFrame } from "../pipeline/stages/craft-frames.js";
import {
  EDITORIAL_TOOL_DEFINITIONS,
  type EditorialToolDefinition,
} from "../tools/editorial-tools.js";
import {
  blueprintFromLlmResponse,
  buildCandidateIndex,
  type CandidateIndex,
} from "./llm-blueprint-agent.js";
import {
  selectsFromLlmResponse,
  type CompactPeakEvidence,
  type CompactSegmentEvidence,
  type LlmCompleter,
} from "./llm-triage-agent.js";
import { parseLlmResponse } from "./llm-json.js";
import {
  formatAudioEvidenceForPrompt,
  formatEvidenceForPrompt,
  type AudioRetrievalEvidence,
  type AudioRetrievalResult,
  type VisualRetrievalEvidence,
  type VisualRetrievalResult,
} from "./visual-retrieval-evidence.js";
import {
  applyQualityGateToSelects,
  loadQualityGateConfig,
} from "../editorial/quality-gate.js";
import {
  attachSelectionCoverage,
  coverageFeedbackGaps,
  loadSelectionCoverageConfig,
} from "../editorial/coverage.js";
import {
  loadClusterAssetMetadata,
  refineClusters,
  type ClusterAssetMetadata,
} from "../editorial/clustering.js";

// Cockpit/repo-side editorial planning should prefer Claude/Codex
// subscription agents. Gemini flash-lite is only the headless automation
// fallback, and this module keeps that fallback text-only by default.
export const DEFAULT_UNIFIED_EDITORIAL_MODEL = "gemini-2.5-flash-lite";

const FPS = 24;
const MIN_FINE_DURATION_US = 500_000;
const DEFAULT_CLIP_DURATION_US = 3_000_000;

const VALID_ROLES = new Set<Role>(["hero", "support", "transition", "texture", "dialogue"]);
const VALID_SELECT_STORY_ROLES = new Set<SelectStoryRole>([
  "hook",
  "setup",
  "experience",
  "payoff",
  "reaction",
  "closing",
]);
const VALID_BLUEPRINT_STORY_ROLES = new Set<NonNullable<Beat["story_role"]>>([
  "hook",
  "setup",
  "experience",
  "closing",
]);
const VALID_CRAFT_IN_POINT = new Set<NonNullable<CraftDirective["in_point"]>>([
  "cut_on_action",
  "peak_hold",
  "pre_roll_enter",
  "post_action_hold",
  "clean_in_clean_out",
]);
const VALID_CRAFT_OUT_POINT = new Set<NonNullable<CraftDirective["out_point"]>>([
  "cut_on_action",
  "peak_hold",
  "post_action_hold",
  "clean_in_clean_out",
]);
const VALID_CRAFT_TRANSITION = new Set<NonNullable<CraftDirective["transition_out"]>>([
  "hard_cut",
  "dissolve",
  "dip_to_black",
  "j_cut",
  "l_cut",
  "match_cut",
]);
const VALID_CRAFT_RHYTHM = new Set<NonNullable<CraftDirective["rhythm"]>>([
  "accelerando",
  "ritardando",
  "steady",
  "syncopated",
  "breath",
]);
const VALID_PEAK_TYPES = new Set<NonNullable<TrimHint["peak_type"]>>([
  "action_peak",
  "emotional_peak",
  "visual_peak",
]);

interface AssetRoughEvidence {
  asset_id: string;
  scene?: string;
  representative_frame?: string;
  segment_count: number;
  segments: Array<{
    segment_id: string;
    src_in_us: number;
    src_out_us: number;
    summary: string;
    transcript: string;
    tags: string[];
  }>;
  events: Array<{
    event_id: string;
    start_us: number;
    end_us: number;
    description: string;
    confidence?: number;
  }>;
}

interface FineClipEvidence {
  segment_id: string;
  asset_id: string;
  candidate_ref: string;
  role: string;
  story_role?: string;
  src_in_us: number;
  src_out_us: number;
  why_it_matches: string;
  transcript_excerpt?: string;
  key_frames: KeyFrame[];
  marlin_scene?: string;
  marlin_events: Array<{
    event_id: string;
    start_us: number;
    end_us: number;
    description: string;
    confidence?: number;
  }>;
}

export type EditorialAgentMode = "headless" | "interactive";

export interface EditorialAgentOptions {
  mode: EditorialAgentMode;
  editorialLlm?: EditorialLlmConnectorOptions;
  /**
   * Used only for interactive prompt packets. Extractors store frame paths
   * relative to the project; repo-side agents need absolute paths for Read.
   */
  projectDir?: string;
  visualEvidence?: VisualRetrievalEvidence[];
  audioEvidence?: AudioRetrievalEvidence[];
  clusterAssets?: ClusterAssetMetadata[];
}

export interface RoughCutPlanningInput {
  brief: CreativeBrief;
  marlinEvents: MarlinEventsArtifact;
  representativeFrames: Map<string, string>;
  segments: SegmentItem[];
  bgmDurationSec: number | null;
  projectDir?: string;
  visualEvidence?: VisualRetrievalEvidence[];
  audioEvidence?: AudioRetrievalEvidence[];
  clusterAssets?: ClusterAssetMetadata[];
}

export interface FineCutRefinementInput {
  brief: CreativeBrief;
  selects: SelectsCandidates;
  blueprint: EditBlueprint;
  marlinEvents: MarlinEventsArtifact;
  keyFrames: Map<string, KeyFrame[]>;
  bgmDurationSec: number | null;
}

export interface EditorialFrameReference {
  pass: "rough" | "fine";
  kind: "representative" | "key_frame";
  path: string;
  asset_id?: string;
  segment_id?: string;
  candidate_ref?: string;
  beat_id?: string;
  label?: string;
  timestamp_us?: number;
  marlin?: string;
}

export interface EditorialInteractivePrompt {
  mode: "interactive";
  pass: "rough" | "fine";
  prompt: string;
  frame_refs: EditorialFrameReference[];
  frame_reference_markdown: string;
  tools?: EditorialToolDefinition[];
}

export interface RoughCutPlanningResult {
  selects: SelectsCandidates;
  blueprint: EditBlueprint;
}

interface FrameReferenceBundle {
  markdown: string;
  refs: EditorialFrameReference[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function integerValue(value: unknown): number | undefined {
  const n = numberValue(value);
  return n === undefined ? undefined : Math.trunc(n);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function enumValue<T extends string>(value: unknown, allowed: ReadonlySet<T>): T | undefined {
  const raw = stringValue(value);
  return raw && allowed.has(raw as T) ? (raw as T) : undefined;
}

function clamp01(value: unknown, fallback = 0.5): number {
  const n = numberValue(value);
  if (n === undefined) return fallback;
  return Math.max(0, Math.min(1, n));
}

function positiveInteger(value: unknown): number | undefined {
  const n = integerValue(value);
  return n !== undefined && n > 0 ? n : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const n = integerValue(value);
  return n !== undefined && n >= 0 ? n : undefined;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function resolveFramePath(framePath: string | undefined, projectDir?: string): string | undefined {
  if (!framePath) return undefined;
  return path.isAbsolute(framePath) ? framePath : path.resolve(projectDir ?? ".", framePath);
}

function absoluteRepresentativeFrames(
  representativeFrames: Map<string, string>,
  projectDir?: string,
): Map<string, string> {
  return new Map(
    [...representativeFrames.entries()]
      .map(([assetId, framePath]) => {
        const resolved = resolveFramePath(framePath, projectDir);
        return resolved ? [assetId, resolved] as const : undefined;
      })
      .filter((entry): entry is readonly [string, string] => Boolean(entry)),
  );
}

function absoluteKeyFrames(
  keyFrames: Map<string, KeyFrame[]>,
  projectDir?: string,
): Map<string, KeyFrame[]> {
  return new Map(
    [...keyFrames.entries()].map(([segmentId, frames]) => [
      segmentId,
      frames.map((frame) => ({
        ...frame,
        path: resolveFramePath(frame.path, projectDir) ?? frame.path,
      })),
    ]),
  );
}

function secondsFromUs(timestampUs: number): string {
  return `${(timestampUs / 1_000_000).toFixed(1)}s`;
}

function projectIdFromBrief(brief: CreativeBrief): string {
  return brief.project_id || brief.project?.id || "video-os-project";
}

function targetDurationSec(brief: CreativeBrief, bgmDurationSec: number | null): number {
  const briefTarget = numberValue(brief.project?.runtime_target_sec);
  if (briefTarget && briefTarget > 0) return briefTarget;
  if (bgmDurationSec && bgmDurationSec > 0) return bgmDurationSec;
  return 60;
}

function compactBrief(brief: CreativeBrief, bgmDurationSec: number | null): Record<string, unknown> {
  const record = brief as Record<string, unknown>;
  const contextKnowledge = contextKnowledgePromptPayload(brief);
  return {
    project_id: projectIdFromBrief(brief),
    title: brief.project?.title,
    strategy: brief.project?.strategy,
    runtime_target_sec: brief.project?.runtime_target_sec,
    bgm_duration_sec: bgmDurationSec,
    message: brief.message,
    emotion_curve: brief.emotion_curve,
    must_have: stringArray(record.must_have),
    must_avoid: stringArray(record.must_avoid),
    order_policy: brief.order_policy,
    caption_policy: brief.caption_policy,
    audio_policy: brief.audio_policy,
    editorial: brief.editorial,
    ...(contextKnowledge ? { context_knowledge: contextKnowledge } : {}),
  };
}

function marlinByAsset(marlinEvents: MarlinEventsArtifact | null | undefined): Map<string, MarlinAssetEvents> {
  return new Map((marlinEvents?.items ?? []).map((item) => [item.asset_id, item]));
}

function marlinEventsForAsset(marlinEvents: MarlinEventsArtifact | null | undefined): Map<string, MarlinEvent[]> {
  const byAsset = new Map<string, MarlinEvent[]>();
  for (const item of marlinEvents?.items ?? []) {
    byAsset.set(item.asset_id, item.events ?? []);
  }
  return byAsset;
}

function overlapsSegment(segment: Pick<SegmentItem, "src_in_us" | "src_out_us">, event: MarlinEvent): boolean {
  return event.start_us < segment.src_out_us && event.end_us > segment.src_in_us;
}

function eventToPrompt(event: MarlinEvent): FineClipEvidence["marlin_events"][number] {
  return {
    event_id: event.event_id,
    start_us: event.start_us,
    end_us: event.end_us,
    description: event.description,
    ...(event.confidence !== undefined ? { confidence: event.confidence } : {}),
  };
}

function segmentPeakEvidence(segment: SegmentItem): CompactPeakEvidence {
  const moments = segment.peak_analysis?.peak_moments ?? [];
  return {
    has_peak: moments.length > 0,
    types: uniqueStrings(moments.map((moment) => String(moment.type ?? "")).filter(Boolean)),
    count: moments.length,
  };
}

function compactSegmentsForSelects(
  segments: SegmentItem[],
  marlinEvents: MarlinEventsArtifact,
  representativeFrames?: Map<string, string>,
): CompactSegmentEvidence[] {
  const byAsset = marlinByAsset(marlinEvents);
  return segments.map((segment) => {
    const marlin = byAsset.get(segment.asset_id);
    return {
      segment_id: segment.segment_id,
      asset_id: segment.asset_id,
      src_in_us: Math.max(0, Math.trunc(segment.src_in_us)),
      src_out_us: Math.max(0, Math.trunc(segment.src_out_us)),
      summary: segment.summary || marlin?.scene || "No scene summary available.",
      scene_report: marlin?.scene,
      tags: segment.tags ?? [],
      peak: segmentPeakEvidence(segment),
      transcript: segment.transcript_excerpt || "",
      ...(representativeFrames?.get(segment.asset_id)
        ? { filmstrip_path: representativeFrames.get(segment.asset_id) }
        : {}),
      ...(segment.quality_flags?.length ? { visual_quality: { labels: { quality_flags: segment.quality_flags } } } : {}),
      ...(segment.interest_points?.length
        ? { interest_point_labels: segment.interest_points.map((point) => point.label) }
        : {}),
    };
  });
}

function buildRoughAssetEvidence(
  marlinEvents: MarlinEventsArtifact,
  representativeFrames: Map<string, string>,
  segments: SegmentItem[],
): AssetRoughEvidence[] {
  const segmentsByAsset = new Map<string, SegmentItem[]>();
  for (const segment of segments) {
    const items = segmentsByAsset.get(segment.asset_id) ?? [];
    items.push(segment);
    segmentsByAsset.set(segment.asset_id, items);
  }

  const assetIds = uniqueStrings([
    ...marlinEvents.items.map((item) => item.asset_id),
    ...segments.map((segment) => segment.asset_id),
  ]).sort((a, b) => a.localeCompare(b));
  const marlin = marlinByAsset(marlinEvents);

  return assetIds.map((assetId) => {
    const assetEvents = marlin.get(assetId);
    const assetSegments = (segmentsByAsset.get(assetId) ?? []).sort((a, b) => a.src_in_us - b.src_in_us);
    return {
      asset_id: assetId,
      scene: assetEvents?.scene,
      representative_frame: representativeFrames.get(assetId),
      segment_count: assetSegments.length,
      segments: assetSegments.slice(0, 12).map((segment) => ({
        segment_id: segment.segment_id,
        src_in_us: segment.src_in_us,
        src_out_us: segment.src_out_us,
        summary: segment.summary,
        transcript: segment.transcript_excerpt ?? "",
        tags: segment.tags ?? [],
      })),
      events: (assetEvents?.events ?? []).slice(0, 8).map(eventToPrompt),
    };
  });
}

function roughFrameReferenceBundle(input: {
  marlinEvents: MarlinEventsArtifact;
  representativeFrames: Map<string, string>;
  projectDir?: string;
}): FrameReferenceBundle {
  const marlin = marlinByAsset(input.marlinEvents);
  const refs: EditorialFrameReference[] = [];
  const lines = ["## Representative frames for rough pass"];
  const entries = [...input.representativeFrames.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  if (entries.length === 0) {
    lines.push("_No representative frames were available._");
    return { markdown: lines.join("\n"), refs };
  }

  for (const [assetId, framePath] of entries) {
    const absolutePath = resolveFramePath(framePath, input.projectDir);
    if (!absolutePath) continue;
    const scene = marlin.get(assetId)?.scene;
    refs.push({
      pass: "rough",
      kind: "representative",
      asset_id: assetId,
      path: absolutePath,
      ...(scene ? { marlin: scene } : {}),
    });
    lines.push(`Asset ${assetId}: ${absolutePath}`);
    lines.push(`  Marlin: "${scene ?? "No Marlin scene report available."}"`);
    lines.push("");
  }

  return { markdown: lines.join("\n").trimEnd(), refs };
}

export function formatRoughFrameReferences(input: {
  marlinEvents: MarlinEventsArtifact;
  representativeFrames: Map<string, string>;
  projectDir?: string;
}): string {
  return roughFrameReferenceBundle(input).markdown;
}

function buildRoughPrompt(input: RoughCutPlanningInput): string {
  const assetEvidence = buildRoughAssetEvidence(
    input.marlinEvents,
    input.representativeFrames,
    input.segments,
  );
  const briefProject = (input.brief as Record<string, unknown>).project as Record<string, unknown> | undefined;
  const targetSec = Number(briefProject?.runtime_target_sec ?? input.bgmDurationSec ?? 120);
  const fps = 24;
  const totalFrames = Math.round(targetSec * fps);
  const beatCount = 5;
  const visualEvidenceSection = formatEvidenceForPrompt(input.visualEvidence ?? []);
  const audioEvidenceSection = formatAudioEvidenceForPrompt(input.audioEvidence ?? []);
  return [
    "You are the unified Claude/Codex editorial agent for Video OS.",
    "Pass 1 is rough-cut planning: see all available material, select the best clips, and decide what goes where.",
    "Use only the provided segment ids, asset ids, source ranges, Marlin facts, and representative frame paths.",
    "Headless fallback runs are text-only; frame paths are evidence references, not new canonical data.",
    "",
    "## Creative brief",
    JSON.stringify(compactBrief(input.brief, input.bgmDurationSec), null, 2),
    "",
    ...(visualEvidenceSection ? [visualEvidenceSection, ""] : []),
    ...(audioEvidenceSection ? [audioEvidenceSection, ""] : []),
    "## All Marlin asset reports plus representative frames",
    JSON.stringify(assetEvidence, null, 2),
    "",
    "## Task",
    "- Select the best 30-50 clips for this PV when enough material exists; otherwise select the strongest available clips.",
    "- Assign each selected clip to one or more exact beat ids.",
    "- Choose rhythm per beat and explain why each clip was selected.",
    "- Cite Marlin event ids or representative frame paths as evidence.",
    "- Use context_knowledge to correct likely subject, food/product, person, terminology, or place misidentifications in Marlin text.",
    "- For every dialogue candidate, select a semantically complete assertion: the subject or antecedent must be recoverable inside the selected line, and the speaker must reach the conclusion before src_out_us.",
    "- An ASR item boundary is not proof of editorial completeness. Expand to neighboring transcript items when a line begins with a dependent continuation or ends on an unfinished clause; otherwise reject it.",
    "- Never use an interviewer question card to repair a missing subject, and never rely on post-roll or fade-out to finish the selected assertion.",
    "- Post-roll is presentation-only: it may retain breath or room tone after a complete assertion, but it must not introduce the next assertion.",
    "- Do not invent clips, visual facts, source ranges, or new schema fields.",
    "",
    "## CRITICAL: Beat duration rules",
    `- Target runtime is ${targetSec}s (${totalFrames} frames at ${fps}fps).`,
    `- The SUM of all beat target_duration_frames MUST equal approximately ${totalFrames}.`,
    `- With ${beatCount} beats, each beat averages ${Math.round(totalFrames / beatCount)} frames (${Math.round(targetSec / beatCount)}s).`,
    "- Do NOT use small values like 90 or 120 for target_duration_frames — those are only 3-5 seconds.",
    `- Opening beat: ~${Math.round(totalFrames * 0.1)} frames. Middle beats: ~${Math.round(totalFrames * 0.25)} each. Closing: ~${Math.round(totalFrames * 0.15)} frames.`,
    "",
    "## JSON output",
    "Return JSON only with this top-level shape:",
    JSON.stringify({
      selects: {
        selection_notes: ["emotional progression", "pacing approach"],
        editorial_summary: {
          dominant_visual_mode: "mixed",
          speaker_topology: "unknown",
          motion_profile: "medium",
          transcript_density: "sparse",
        },
        candidates: [
          {
            segment_id: "SEG_001",
            asset_id: "AST_001",
            src_in_us: 0,
            src_out_us: 3000000,
            role: "hero",
            story_role: "hook",
            why_it_matches: "specific reason tied to the brief",
            risks: [],
            confidence: 0.82,
            semantic_rank: 1,
            evidence: ["Marlin evt_001: visible action", "representative frame shows readable subject"],
            transcript_excerpt: "exact complete transcript assertion for dialogue candidates",
            eligible_beats: ["b01_hook"],
            motif_tags: ["specific_visual_theme"],
          },
        ],
      },
      blueprint: {
        version: "1",
        project_id: projectIdFromBrief(input.brief),
        sequence_goals: ["Open with the strongest visual hook."],
        beats: [
          {
            id: "b01_hook",
            label: "hook",
            purpose: "establish the promise quickly",
            target_duration_frames: Math.round(totalFrames * 0.1),
            required_roles: ["hero"],
            preferred_roles: ["support", "texture"],
            story_role: "hook",
            candidate_plan: {
              primary_candidate_ref: "SEG_001",
              fallback_candidate_refs: [],
            },
            craft: {
              in_point: "cut_on_action",
              out_point: "peak_hold",
              transition_out: "hard_cut",
              rhythm: "accelerando",
              beat_sync: true,
            },
          },
        ],
        pacing: {
          opening_cadence: "brisk",
          middle_cadence: "varied",
          ending_cadence: "resolved",
        },
        music_policy: {
          start_sparse: true,
          allow_release_late: true,
          entry_beat: "b01_hook",
          bgm_duration_sec: input.bgmDurationSec ?? undefined,
        },
        caption_policy: {
          language: "ja",
          delivery_mode: "burn_in",
          source: "transcript",
          styling_class: "clean-lower-third",
        },
        dialogue_policy: {
          preserve_natural_breath: true,
          avoid_wall_to_wall_voiceover: true,
          cut_tail_hold_sec: 0.25,
          cut_audio_fade_out_sec: 0.16,
        },
        transition_policy: {
          prefer_match_texture_over_flashy_fx: true,
          allow_hard_cuts: true,
          avoid_speed_ramps: true,
        },
        ending_policy: {
          should_feel: "resolved",
          final_hold_min_frames: 12,
        },
        rejection_rules: ["Reject material that cannot be tied to the brief."],
        duration_policy: {
          mode: "guide",
          source: "explicit_brief",
          target_source: "explicit_brief",
          target_duration_sec: targetDurationSec(input.brief, input.bgmDurationSec),
          min_duration_sec: 1,
          max_duration_sec: input.bgmDurationSec ?? null,
          hard_gate: false,
          protect_vlm_peaks: true,
        },
        timeline_order: "editorial",
        track_layout: "single",
      },
    }, null, 2),
  ].join("\n");
}

function buildFineClipEvidence(
  selects: SelectsCandidates,
  marlinEvents: MarlinEventsArtifact,
  keyFrames: Map<string, KeyFrame[]>,
): FineClipEvidence[] {
  const byAsset = marlinByAsset(marlinEvents);
  const eventsByAsset = marlinEventsForAsset(marlinEvents);
  return (selects.candidates ?? [])
    .filter((candidate) => candidate.role !== "reject")
    .map((candidate) => {
      const events = (eventsByAsset.get(candidate.asset_id) ?? [])
        .filter((event) => overlapsSegment(candidate, event))
        .slice(0, 6)
        .map(eventToPrompt);
      return {
        segment_id: candidate.segment_id,
        asset_id: candidate.asset_id,
        candidate_ref: getCandidateRef(candidate),
        role: candidate.role,
        ...(candidate.story_role ? { story_role: candidate.story_role } : {}),
        src_in_us: candidate.src_in_us,
        src_out_us: candidate.src_out_us,
        why_it_matches: candidate.why_it_matches,
        ...(candidate.transcript_excerpt ? { transcript_excerpt: candidate.transcript_excerpt } : {}),
        key_frames: keyFrames.get(candidate.segment_id) ?? [],
        marlin_scene: byAsset.get(candidate.asset_id)?.scene,
        marlin_events: events,
      };
    });
}

function frameEventDescription(
  candidate: Candidate,
  frame: KeyFrame,
  eventsByAsset: Map<string, MarlinEvent[]>,
): string | undefined {
  return (eventsByAsset.get(candidate.asset_id) ?? [])
    .filter((event) =>
      frame.timestamp_us >= event.start_us
      && frame.timestamp_us <= event.end_us
      && overlapsSegment(candidate, event)
    )
    .sort((a, b) => (b.confidence ?? 0.6) - (a.confidence ?? 0.6))[0]?.description;
}

function fineFrameReferenceBundle(input: {
  selects: SelectsCandidates;
  marlinEvents: MarlinEventsArtifact;
  keyFrames: Map<string, KeyFrame[]>;
  projectDir?: string;
}): FrameReferenceBundle {
  const refs: EditorialFrameReference[] = [];
  const lines = ["## Key frames for fine pass"];
  const eventsByAsset = marlinEventsForAsset(input.marlinEvents);
  const activeCandidates = input.selects.candidates.filter((candidate) => candidate.role !== "reject");

  if (activeCandidates.length === 0) {
    lines.push("_No selected clips were available for fine-cut key frames._");
    return { markdown: lines.join("\n"), refs };
  }

  for (const candidate of activeCandidates) {
    const candidateRef = getCandidateRef(candidate);
    const beatId = candidate.eligible_beats?.[0] ?? beatIdForStoryRole(candidate.story_role ?? "experience");
    const frames = input.keyFrames.get(candidate.segment_id) ?? [];
    lines.push(`## Key frames for clip ${candidateRef} (${beatId})`);

    if (frames.length === 0) {
      lines.push("_No key frames were extracted for this clip._");
      lines.push("");
      continue;
    }

    for (const frame of frames) {
      const absolutePath = resolveFramePath(frame.path, input.projectDir);
      if (!absolutePath) continue;
      const label = frame.label.toUpperCase();
      const description = frameEventDescription(candidate, frame, eventsByAsset);
      refs.push({
        pass: "fine",
        kind: "key_frame",
        segment_id: candidate.segment_id,
        asset_id: candidate.asset_id,
        candidate_ref: candidateRef,
        beat_id: beatId,
        label: frame.label,
        timestamp_us: frame.timestamp_us,
        path: absolutePath,
        ...(description ? { marlin: description } : {}),
      });
      const paddedLabel = `${label}:`.padEnd(6, " ");
      lines.push(`${paddedLabel}${absolutePath} (${secondsFromUs(frame.timestamp_us)})${description ? ` - "${description}"` : ""}`);
    }

    lines.push("-> Suggest in/out adjustment if any frame shows camera issues.");
    lines.push("");
  }

  return { markdown: lines.join("\n").trimEnd(), refs };
}

export function formatFineFrameReferences(input: {
  selects: SelectsCandidates;
  marlinEvents: MarlinEventsArtifact;
  keyFrames: Map<string, KeyFrame[]>;
  projectDir?: string;
}): string {
  return fineFrameReferenceBundle(input).markdown;
}

function buildFinePrompt(input: FineCutRefinementInput): string {
  const clipEvidence = buildFineClipEvidence(input.selects, input.marlinEvents, input.keyFrames);
  return [
    "You are the unified Claude/Codex editorial agent for Video OS.",
    "Pass 2 is fine-cut refinement: default to selected clips, inspect them in detail, and decide exactly how they should cut.",
    "Default to existing selected and fallback candidates. Search the full footage pool only when a beat gap, QA issue, or inspected weakness justifies it, and cite the search result evidence before recommending a replacement.",
    "Use Marlin event ids for in/out rationale whenever possible.",
    "Use context_knowledge to resolve ambiguous visual subjects or local terminology before changing selections or craft.",
    "",
    "## Creative brief",
    JSON.stringify(compactBrief(input.brief, input.bgmDurationSec), null, 2),
    "",
    "## Current beat structure",
    JSON.stringify(input.blueprint, null, 2),
    "",
    "## Selected clips with key frames and Marlin temporal events",
    JSON.stringify(clipEvidence, null, 2),
    "",
    "## Task",
    "- For each selected clip, choose the best in/out point by referencing a specific Marlin event.",
    "- For dialogue, verify semantic boundaries before visual craft: retain the subject or antecedent and the complete conclusion, even when that requires neighboring ASR items.",
    "- Do not approve a line that only becomes understandable from a question card. Post-roll may preserve breath or room tone only after the assertion is complete and must stop before the next assertion.",
    "- Choose beat-level transition_in / transition_out, rhythm, and in_point / out_point craft.",
    "- Adjust pacing and duration policy for the BGM duration when needed.",
    "- If a selected clip is weak, repetitive, too short, technically poor, or mismatched to its beat, use search_footage or best_for_beat to find a replacement candidate and cite the query, result segment_id, evidence_refs, and key_frame_path in revision_notes.",
    "- Keep the output schema-compatible: per-clip in/out belongs in clip_craft; beat craft belongs in blueprint.beats[].craft.",
    "",
    "## JSON output",
    "Return JSON only with this shape:",
    JSON.stringify({
      blueprint: input.blueprint,
      clip_craft: [
        {
          segment_id: "SEG_001",
          event_id: "evt_001",
          recommended_in_us: 1000000,
          recommended_out_us: 3600000,
          preferred_duration_us: 2600000,
          peak_type: "action_peak",
          rationale: "Enter before the action and hold through the peak.",
        },
      ],
      revision_notes: ["what changed and why"],
    }, null, 2),
  ].join("\n");
}

function fineToolPromptSection(passLabel: "rough" | "fine" = "fine"): string {
  const lines = [
    "## Available tools",
    passLabel === "rough"
      ? "You can call these optional tools to inspect representative frames or search for mood, lighting, texture, and visual tone matches during the rough pass:"
      : "You can call these optional tools to inspect selected clips or search for justified full-pool alternatives during the fine pass:",
  ];
  for (const tool of EDITORIAL_TOOL_DEFINITIONS) {
    const signature = Object.keys(tool.parameters).join(", ");
    lines.push(`- ${tool.name}(${signature}): ${tool.description}`);
  }
  lines.push("For frame-based retrieval, use visual_search for direct frame similarity, search_footage with mode=visual and image_query_path for custom visual queries, or similar_to with use_visual=true for segment-anchor similarity.");
  lines.push("If tool calls are unavailable, continue using the provided key frames and Marlin temporal events.");
  return lines.join("\n");
}

function buildRoughInteractivePrompt(
  input: RoughCutPlanningInput,
  options: EditorialAgentOptions,
): EditorialInteractivePrompt {
  const representativeFrames = absoluteRepresentativeFrames(input.representativeFrames, options.projectDir);
  const interactiveInput = { ...input, representativeFrames };
  const bundle = roughFrameReferenceBundle({
    marlinEvents: input.marlinEvents,
    representativeFrames,
    projectDir: options.projectDir,
  });
  const prompt = [
    buildRoughPrompt(interactiveInput),
    "",
    fineToolPromptSection("rough"),
    "",
    bundle.markdown,
    "",
    "## Repo-side agent instructions",
    "- Use the Read tool on the absolute frame paths above before deciding.",
    "- Use search_footage, visual_search, or best_for_beat when mood, lighting, texture, or visual tone needs evidence beyond the provided representative frames.",
    "- Return the JSON object requested in the prompt. Do not write timeline.json.",
  ].join("\n");
  return {
    mode: "interactive",
    pass: "rough",
    prompt,
    frame_refs: bundle.refs,
    frame_reference_markdown: bundle.markdown,
    tools: EDITORIAL_TOOL_DEFINITIONS,
  };
}

function buildFineInteractivePrompt(
  input: FineCutRefinementInput,
  options: EditorialAgentOptions,
): EditorialInteractivePrompt {
  const keyFrames = absoluteKeyFrames(input.keyFrames, options.projectDir);
  const interactiveInput = { ...input, keyFrames };
  const bundle = fineFrameReferenceBundle({
    selects: input.selects,
    marlinEvents: input.marlinEvents,
    keyFrames,
    projectDir: options.projectDir,
  });
  const prompt = [
    buildFinePrompt(interactiveInput),
    "",
    fineToolPromptSection(),
    "",
    bundle.markdown,
    "",
    "## Repo-side agent instructions",
    "- Use the Read tool on the absolute key-frame paths above before setting in/out points.",
    "- Use the available inspection tools when a key frame is ambiguous, blurred, shaky, or misses the action boundary.",
    "- Use search_footage or best_for_beat when inspection shows a weak clip and cite returned evidence before recommending a replacement.",
    "- Return the JSON object requested in the prompt. Do not write timeline.json.",
  ].join("\n");
  return {
    mode: "interactive",
    pass: "fine",
    prompt,
    frame_refs: bundle.refs,
    frame_reference_markdown: bundle.markdown,
    tools: EDITORIAL_TOOL_DEFINITIONS,
  };
}

function repairPrompt(originalPrompt: string, raw: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return [
    originalPrompt,
    "",
    "The previous response was not parseable as the required JSON object.",
    `Parse error: ${message}`,
    `Previous response excerpt: ${raw.slice(0, 1200)}`,
    "Return JSON only. No prose, no markdown fences.",
  ].join("\n");
}

function roughCoverageRetryPrompt(
  originalPrompt: string,
  coverage: NonNullable<SelectsCandidates["coverage"]>,
  previousSelectionCount: number,
): string {
  return [
    originalPrompt,
    "",
    "## Coverage hard constraint retry",
    `The previous rough selection failed hard coverage: ${JSON.stringify(coverageFeedbackGaps(coverage))}.`,
    `Previous selected candidate count: ${previousSelectionCount}.`,
    "Add or replace candidates so every under-sampled semantic cluster and every must_have item is covered.",
    "Return JSON only with the same requested top-level shape.",
  ].join("\n");
}

function storyRoleForIndex(index: number, total: number): SelectStoryRole {
  if (index === 0) return "hook";
  if (index === total - 1) return "closing";
  const ratio = total <= 1 ? 0 : index / (total - 1);
  if (ratio < 0.22) return "setup";
  if (ratio < 0.72) return "experience";
  if (ratio < 0.88) return "payoff";
  return "reaction";
}

function beatIdForStoryRole(role: SelectStoryRole): string {
  if (role === "hook") return "b01_hook";
  if (role === "setup") return "b02_setup";
  if (role === "experience") return "b03_experience";
  if (role === "payoff" || role === "reaction") return "b04_payoff";
  return "b05_closing";
}

function roleForSegment(segment: SegmentItem, index: number): Role {
  const tags = new Set((segment.tags ?? []).map((tag) => tag.toLowerCase()));
  if (index === 0) return "hero";
  if (segment.transcript_excerpt && segment.transcript_excerpt.trim().length > 12) return "dialogue";
  if (tags.has("texture") || tags.has("landscape") || tags.has("detail")) return "texture";
  if (tags.has("transition") || tags.has("establishing")) return "transition";
  return "support";
}

function segmentScore(segment: SegmentItem, events: MarlinEvent[]): number {
  const durationUs = Math.max(0, segment.src_out_us - segment.src_in_us);
  const overlapping = events.filter((event) => overlapsSegment(segment, event));
  const confidence = overlapping.reduce((sum, event) => sum + (event.confidence ?? 0.6), 0);
  const peakBonus = (segment.peak_analysis?.peak_moments?.length ?? 0) * 0.4;
  const qualityPenalty = (segment.quality_flags ?? []).length * 0.25;
  const durationScore = Math.min(1, durationUs / 5_000_000);
  return confidence + peakBonus + durationScore - qualityPenalty;
}

function fallbackSelects(
  brief: CreativeBrief,
  marlinEvents: MarlinEventsArtifact,
  representativeFrames: Map<string, string>,
  segments: SegmentItem[],
): SelectsCandidates {
  const projectId = projectIdFromBrief(brief);
  const eventsByAsset = marlinEventsForAsset(marlinEvents);
  const ranked = [...segments]
    .filter((segment) =>
      segment.segment_id
      && segment.asset_id
      && Number.isFinite(segment.src_in_us)
      && Number.isFinite(segment.src_out_us)
      && segment.src_out_us > segment.src_in_us
    )
    .sort((a, b) =>
      segmentScore(b, eventsByAsset.get(b.asset_id) ?? []) - segmentScore(a, eventsByAsset.get(a.asset_id) ?? []) ||
      a.asset_id.localeCompare(b.asset_id) ||
      a.src_in_us - b.src_in_us
    )
    .slice(0, Math.min(50, Math.max(1, segments.length)));

  const candidates: Candidate[] = ranked.map((segment, index) => {
    const storyRole = storyRoleForIndex(index, ranked.length);
    const events = eventsByAsset.get(segment.asset_id) ?? [];
    const event = events.find((item) => overlapsSegment(segment, item)) ?? events[0];
    const role = roleForSegment(segment, index);
    return {
      segment_id: segment.segment_id,
      asset_id: segment.asset_id,
      src_in_us: Math.max(0, Math.trunc(segment.src_in_us)),
      src_out_us: Math.max(0, Math.trunc(segment.src_out_us)),
      role,
      story_role: storyRole,
      why_it_matches: segment.summary || event?.description || "Selected as the strongest available visual evidence.",
      risks: segment.quality_flags ?? [],
      confidence: clamp01((event?.confidence ?? 0.7) - (segment.quality_flags?.length ?? 0) * 0.08, 0.7),
      semantic_rank: index + 1,
      evidence: [
        event ? `Marlin ${event.event_id}: ${event.description}` : "No Marlin event overlapped this segment.",
        representativeFrames.get(segment.asset_id)
          ? `Representative frame: ${representativeFrames.get(segment.asset_id)}`
          : "No representative frame was available.",
      ],
      eligible_beats: [beatIdForStoryRole(storyRole)],
      motif_tags: uniqueStrings([...(segment.tags ?? []), storyRole]).slice(0, 8),
      ...(segment.transcript_excerpt ? { transcript_excerpt: segment.transcript_excerpt } : {}),
      trim_hint: {
        preferred_duration_us: Math.min(
          Math.max(MIN_FINE_DURATION_US, segment.src_out_us - segment.src_in_us),
          DEFAULT_CLIP_DURATION_US,
        ),
      },
    };
  });
  ensureCandidateIds(projectId, candidates);

  return {
    version: "1",
    project_id: projectId,
    selection_notes: [
      "Deterministic rough fallback selected high-confidence Marlin-backed clips.",
      "Pacing approach: mixed, with a faster opening and more resolved closing.",
    ],
    editorial_summary: {
      dominant_visual_mode: "mixed",
      speaker_topology: "unknown",
      motion_profile: "medium",
      transcript_density: "sparse",
    },
    candidates,
  };
}

function candidatesByBeat(selects: SelectsCandidates): Map<string, Candidate[]> {
  const byBeat = new Map<string, Candidate[]>();
  for (const candidate of selects.candidates.filter((item) => item.role !== "reject")) {
    const beatIds = candidate.eligible_beats?.length
      ? candidate.eligible_beats
      : [beatIdForStoryRole(candidate.story_role ?? "experience")];
    for (const beatId of beatIds) {
      const items = byBeat.get(beatId) ?? [];
      items.push(candidate);
      byBeat.set(beatId, items);
    }
  }
  return byBeat;
}

function roleArrayForCandidates(candidates: Candidate[]): Role[] {
  const roles = uniqueStrings(
    candidates
      .map((candidate) => candidate.role)
      .filter((role): role is Role => VALID_ROLES.has(role as Role)),
  ) as Role[];
  return roles.length > 0 ? roles : ["support"];
}

function blueprintStoryRoleForBeatId(beatId: string): Beat["story_role"] {
  if (beatId.includes("hook")) return "hook";
  if (beatId.includes("setup")) return "setup";
  if (beatId.includes("closing")) return "closing";
  return "experience";
}

function fallbackBlueprint(
  brief: CreativeBrief,
  selects: SelectsCandidates,
  bgmDurationSec: number | null,
): EditBlueprint {
  const projectId = projectIdFromBrief(brief);
  const active = selects.candidates.filter((candidate) => candidate.role !== "reject");
  const byBeat = candidatesByBeat(selects);
  const defaultBeatIds = ["b01_hook", "b02_setup", "b03_experience", "b04_payoff", "b05_closing"];
  const beatIds = defaultBeatIds.filter((beatId) => byBeat.has(beatId) || active.length === 0);
  if (beatIds.length === 0) beatIds.push(...defaultBeatIds);

  const targetSec = targetDurationSec(brief, bgmDurationSec);
  const framesPerBeat = Math.max(1, Math.round((targetSec * FPS) / beatIds.length));
  const fallbackCandidates = active.slice(0, 4);
  const beats: Beat[] = beatIds.map((beatId, index) => {
    const candidates = byBeat.get(beatId) ?? fallbackCandidates;
    const primary = candidates[0];
    const fallbacks = candidates.slice(1, 4);
    const storyRole = blueprintStoryRoleForBeatId(beatId);
    const beat: Beat = {
      id: beatId,
      label: beatId.replace(/^b\d+_/, ""),
      purpose: index === 0
        ? "Open with the clearest visual promise."
        : index === beatIds.length - 1
          ? "Resolve on the warmest available ending."
          : "Build the story with selected evidence.",
      target_duration_frames: framesPerBeat,
      required_roles: roleArrayForCandidates(candidates),
      preferred_roles: ["support", "texture"],
      story_role: storyRole,
      craft: {
        in_point: index === 0 ? "cut_on_action" : "clean_in_clean_out",
        out_point: index === beatIds.length - 1 ? "post_action_hold" : "peak_hold",
        transition_out: index === beatIds.length - 1 ? "dissolve" : "hard_cut",
        rhythm: index === 0 ? "accelerando" : index === beatIds.length - 1 ? "breath" : "steady",
        beat_sync: index !== beatIds.length - 1,
      },
    };
    if (primary) {
      beat.candidate_plan = {
        primary_candidate_ref: getCandidateRef(primary),
        fallback_candidate_refs: fallbacks.map(getCandidateRef),
      };
    }
    return beat;
  });

  return {
    version: "1",
    project_id: projectId,
    sequence_goals: [
      brief.message?.primary ?? "Build a clear promotional rough cut from the selected material.",
      "Use Marlin-backed visual moments and preserve a readable emotional arc.",
    ],
    beats,
    pacing: {
      opening_cadence: "brisk",
      middle_cadence: "varied",
      ending_cadence: "resolved",
      default_duration_target_sec: targetSec,
      confirmed_preferences: {
        mode: "full",
        source: "ai_autonomous",
        duration_target_sec: targetSec,
        confirmed_at: "unified-editorial-fallback",
      },
    },
    music_policy: {
      start_sparse: true,
      allow_release_late: true,
      entry_beat: beats[0]?.id ?? "b01_hook",
      ...(bgmDurationSec !== null ? { bgm_duration_sec: bgmDurationSec } : {}),
    },
    caption_policy: {
      language: "ja",
      delivery_mode: "burn_in",
      source: brief.caption_policy === "off" ? "none" : "transcript",
      styling_class: "clean-lower-third",
    },
    dialogue_policy: {
      preserve_natural_breath: true,
      avoid_wall_to_wall_voiceover: true,
      cut_tail_hold_sec: 0.25,
      cut_audio_fade_out_sec: 0.16,
    },
    transition_policy: {
      prefer_match_texture_over_flashy_fx: true,
      allow_hard_cuts: true,
      avoid_speed_ramps: true,
    },
    ending_policy: {
      should_feel: "resolved",
      final_hold_min_frames: 12,
    },
    rejection_rules: ["Reject material that cannot be tied to the brief or selected evidence."],
    story_arc: {
      summary: brief.message?.primary ?? "Message-first promotional arc.",
      strategy: brief.order_policy === "chronological" ? "chronological" : "peak_first",
      chronology_bias: brief.order_policy === "chronological" ? "respect source chronology" : "brief-led editorial order",
      allow_time_reorder: brief.order_policy !== "chronological",
      causal_links: [],
    },
    duration_policy: {
      mode: brief.project?.duration_mode ?? "guide",
      source: brief.project?.runtime_target_sec ? "explicit_brief" : "global_default",
      target_source: brief.project?.runtime_target_sec ? "explicit_brief" : "material_total",
      target_duration_sec: targetSec,
      min_duration_sec: Math.max(1, Math.round(targetSec * 0.7)),
      max_duration_sec: bgmDurationSec ?? Math.round(targetSec * 1.3),
      hard_gate: brief.project?.duration_mode === "strict",
      protect_vlm_peaks: true,
    },
    timeline_order: brief.order_policy ?? "editorial",
    track_layout: "single",
  };
}

function selectSourceObject(parsed: Record<string, unknown>): Record<string, unknown> {
  return recordValue(parsed.selects) ?? parsed;
}

interface SelectedVisualRetrievalEvidence {
  queryId: string;
  result: VisualRetrievalResult;
}

interface SelectedAudioRetrievalEvidence {
  queryId: string;
  result: AudioRetrievalResult;
}

function visualScoreText(value: number | undefined): string {
  return value === undefined ? "n/a" : value.toFixed(3);
}

function audioScoreText(value: number | undefined): string {
  return value === undefined ? "n/a" : value.toFixed(3);
}

function bestVisualRetrievalBySegment(
  evidence: VisualRetrievalEvidence[] | undefined,
): Map<string, SelectedVisualRetrievalEvidence> {
  const best = new Map<string, SelectedVisualRetrievalEvidence>();
  for (const entry of evidence ?? []) {
    for (const result of entry.results) {
      const previous = best.get(result.segment_id);
      if (!previous || result.score_breakdown.final > previous.result.score_breakdown.final) {
        best.set(result.segment_id, { queryId: entry.query_id, result });
      }
    }
  }
  return best;
}

function bestAudioRetrievalBySegment(
  evidence: AudioRetrievalEvidence[] | undefined,
): Map<string, SelectedAudioRetrievalEvidence> {
  const best = new Map<string, SelectedAudioRetrievalEvidence>();
  for (const entry of evidence ?? []) {
    for (const result of entry.results) {
      const previous = best.get(result.segment_id);
      const nextAudio = result.score_breakdown.audio_similarity ?? Number.NEGATIVE_INFINITY;
      const previousAudio = previous?.result.score_breakdown.audio_similarity ?? Number.NEGATIVE_INFINITY;
      if (
        !previous
        || nextAudio > previousAudio
        || (nextAudio === previousAudio && result.score_breakdown.final > previous.result.score_breakdown.final)
      ) {
        best.set(result.segment_id, { queryId: entry.query_id, result });
      }
    }
  }
  return best;
}

function formatSelectedVisualRetrievalEvidence(match: SelectedVisualRetrievalEvidence): string {
  const parts = [
    "Qwen visual retrieval:",
    `query=${match.queryId}`,
    `qwen_visual=${visualScoreText(match.result.score_breakdown.qwen_visual)}`,
    `final=${visualScoreText(match.result.score_breakdown.final)}`,
  ];
  if (match.result.matched_frame_path) {
    parts.push(`matched_frame=${match.result.matched_frame_path}`);
  }
  return parts.join(" ");
}

function formatSelectedAudioRetrievalEvidence(match: SelectedAudioRetrievalEvidence): string {
  const parts = [
    "CLAP audio retrieval:",
    `query=${match.queryId}`,
    `audio_similarity=${audioScoreText(match.result.score_breakdown.audio_similarity)}`,
    `final=${audioScoreText(match.result.score_breakdown.final)}`,
  ];
  if (match.result.matched_embedding_type) {
    parts.push(`matched_embedding=${match.result.matched_embedding_type}`);
  }
  if (match.result.matched_audio_ref) {
    parts.push(`matched_audio=${match.result.matched_audio_ref}`);
  }
  return parts.join(" ");
}

function enrichSelectedCandidatesWithVisualEvidence(
  selects: SelectsCandidates,
  evidence: VisualRetrievalEvidence[] | undefined,
): void {
  const bySegment = bestVisualRetrievalBySegment(evidence);
  if (bySegment.size === 0) return;

  for (const candidate of selects.candidates) {
    const match = bySegment.get(candidate.segment_id);
    if (!match) continue;
    const evidenceLine = formatSelectedVisualRetrievalEvidence(match);
    const existing = candidate.evidence ?? [];
    if (!existing.includes(evidenceLine)) {
      candidate.evidence = [...existing, evidenceLine];
    }
  }
}

function enrichSelectedCandidatesWithAudioEvidence(
  selects: SelectsCandidates,
  evidence: AudioRetrievalEvidence[] | undefined,
): void {
  const bySegment = bestAudioRetrievalBySegment(evidence);
  if (bySegment.size === 0) return;

  for (const candidate of selects.candidates) {
    const match = bySegment.get(candidate.segment_id);
    if (!match) continue;
    const evidenceLine = formatSelectedAudioRetrievalEvidence(match);
    const existing = candidate.evidence ?? [];
    if (!existing.includes(evidenceLine)) {
      candidate.evidence = [...existing, evidenceLine];
    }
  }
}

function normalizeRoughSelects(
  parsed: Record<string, unknown> | undefined,
  input: {
    brief: CreativeBrief;
    marlinEvents: MarlinEventsArtifact;
    representativeFrames: Map<string, string>;
    segments: SegmentItem[];
    bgmDurationSec: number | null;
    projectDir?: string;
    visualEvidence?: VisualRetrievalEvidence[];
    audioEvidence?: AudioRetrievalEvidence[];
  },
  decisionRuntime: DecisionRuntimeRecord = injectedDecisionRuntime("unified-editorial-rough"),
): SelectsCandidates {
  const projectId = projectIdFromBrief(input.brief);
  let selects: SelectsCandidates;
  try {
    const compactSegments = compactSegmentsForSelects(input.segments, input.marlinEvents, input.representativeFrames);
    selects = parsed
      ? selectsFromLlmResponse(selectSourceObject(parsed), projectId, compactSegments) as SelectsCandidates
      : fallbackSelects(input.brief, input.marlinEvents, input.representativeFrames, input.segments);
    if (selects.candidates.length === 0) {
      selects = fallbackSelects(input.brief, input.marlinEvents, input.representativeFrames, input.segments);
    }
  } catch {
    selects = fallbackSelects(input.brief, input.marlinEvents, input.representativeFrames, input.segments);
  }
  selects.decision_runtime = decisionRuntime;
  ensureCandidateIds(projectId, selects.candidates);
  enrichSelectedCandidatesWithVisualEvidence(selects, input.visualEvidence);
  enrichSelectedCandidatesWithAudioEvidence(selects, input.audioEvidence);
  return selects;
}

function applyRoughQualityGate(
  selects: SelectsCandidates,
  input: {
    brief: CreativeBrief;
    segments: SegmentItem[];
    projectDir?: string;
  },
): SelectsCandidates {
  const qualityGateConfig = loadQualityGateConfig(input.projectDir);
  return applyQualityGateToSelects(selects, input.segments, {
    brief: input.brief,
    thresholds: qualityGateConfig.thresholds,
    policyName: qualityGateConfig.policyName,
  });
}

function applyRoughCoverage(
  selects: SelectsCandidates,
  input: {
    brief: CreativeBrief;
    segments: SegmentItem[];
    projectDir?: string;
  },
): SelectsCandidates {
  const coverageConfig = loadSelectionCoverageConfig(input.projectDir);
  return attachSelectionCoverage(selects, input.brief, input.segments, {
    config: coverageConfig.config,
    policyName: coverageConfig.policyName,
  });
}

function normalizeRoughBlueprint(
  parsed: Record<string, unknown> | undefined,
  input: {
    brief: CreativeBrief;
    bgmDurationSec: number | null;
  },
  projectId: string,
  selects: SelectsCandidates,
  decisionRuntime: DecisionRuntimeRecord,
): EditBlueprint {
  let blueprint: EditBlueprint;
  try {
    blueprint = parsed
      ? blueprintFromLlmResponse(parsed, {
        projectId,
        autonomyMode: "full",
        briefContent: input.brief,
        selectsContent: selects,
      })
      : fallbackBlueprint(input.brief, selects, input.bgmDurationSec);
    if (!blueprint.beats?.length) {
      blueprint = fallbackBlueprint(input.brief, selects, input.bgmDurationSec);
    }
  } catch {
    blueprint = fallbackBlueprint(input.brief, selects, input.bgmDurationSec);
  }
  blueprint.decision_runtime = decisionRuntime;
  blueprint = enforceSelectedCandidatePool(blueprint, selects);
  validateArtifact<EditBlueprint>(blueprint, "edit-blueprint.schema.json");
  return blueprint;
}

function clusterAssetsForRough(input: {
  projectDir?: string;
  clusterAssets?: ClusterAssetMetadata[];
}): ClusterAssetMetadata[] | undefined {
  return input.clusterAssets ?? (input.projectDir ? loadClusterAssetMetadata(input.projectDir) : undefined);
}

async function normalizeRoughResult(
  parsed: Record<string, unknown> | undefined,
  input: {
    brief: CreativeBrief;
    marlinEvents: MarlinEventsArtifact;
    representativeFrames: Map<string, string>;
    segments: SegmentItem[];
    bgmDurationSec: number | null;
    projectDir?: string;
    visualEvidence?: VisualRetrievalEvidence[];
    audioEvidence?: AudioRetrievalEvidence[];
    clusterAssets?: ClusterAssetMetadata[];
  },
  decisionRuntime: DecisionRuntimeRecord = injectedDecisionRuntime("unified-editorial-rough"),
): Promise<{ selects: SelectsCandidates; blueprint: EditBlueprint }> {
  const projectId = projectIdFromBrief(input.brief);
  let selects = normalizeRoughSelects(parsed, input, decisionRuntime);
  selects = await refineClusters(selects, input.segments, {
    assets: clusterAssetsForRough(input),
    projectDir: input.projectDir,
  });
  selects = applyRoughQualityGate(selects, input);
  selects = applyRoughCoverage(selects, input);
  validateArtifact<SelectsCandidates>(selects, "selects-candidates.schema.json");

  const blueprint = normalizeRoughBlueprint(parsed, input, projectId, selects, decisionRuntime);

  return { selects, blueprint };
}

function normalizeRoughResultSync(
  parsed: Record<string, unknown> | undefined,
  input: RoughCutPlanningInput,
  decisionRuntime: DecisionRuntimeRecord = injectedDecisionRuntime("unified-editorial-rough"),
): { selects: SelectsCandidates; blueprint: EditBlueprint } {
  const projectId = projectIdFromBrief(input.brief);
  let selects = normalizeRoughSelects(parsed, input, decisionRuntime);
  selects = applyRoughQualityGate(selects, input);
  selects = applyRoughCoverage(selects, input);
  validateArtifact<SelectsCandidates>(selects, "selects-candidates.schema.json");
  const blueprint = normalizeRoughBlueprint(parsed, input, projectId, selects, decisionRuntime);
  return { selects, blueprint };
}

function parseAgentJsonResponse(response: string | Record<string, unknown>): Record<string, unknown> {
  if (typeof response === "string") return parseLlmResponse(response);
  if (isRecord(response)) return response;
  throw new Error("Interactive editorial response must be a JSON string or object");
}

export function parseRoughCutPlanningResponse(
  response: string | Record<string, unknown>,
  input: RoughCutPlanningInput,
): RoughCutPlanningResult {
  return normalizeRoughResultSync(parseAgentJsonResponse(response), input);
}

export async function parseRoughCutPlanningResponseWithClusters(
  response: string | Record<string, unknown>,
  input: RoughCutPlanningInput,
): Promise<RoughCutPlanningResult> {
  return normalizeRoughResult(parseAgentJsonResponse(response), input);
}

export function roughCutPlanning(
  brief: CreativeBrief,
  marlinEvents: MarlinEventsArtifact,
  representativeFrames: Map<string, string>,
  segments: SegmentItem[],
  bgmDurationSec: number | null,
  options: EditorialAgentOptions & { mode: "interactive" },
): Promise<EditorialInteractivePrompt>;
export function roughCutPlanning(
  brief: CreativeBrief,
  marlinEvents: MarlinEventsArtifact,
  representativeFrames: Map<string, string>,
  segments: SegmentItem[],
  bgmDurationSec: number | null,
  options?: EditorialAgentOptions,
): Promise<RoughCutPlanningResult>;
export async function roughCutPlanning(
  brief: CreativeBrief,
  marlinEvents: MarlinEventsArtifact,
  representativeFrames: Map<string, string>,
  segments: SegmentItem[],
  bgmDurationSec: number | null,
  options?: EditorialAgentOptions,
): Promise<RoughCutPlanningResult | EditorialInteractivePrompt> {
  const input: RoughCutPlanningInput = {
    brief,
    marlinEvents,
    representativeFrames,
    segments,
    bgmDurationSec,
    ...(options?.projectDir ? { projectDir: options.projectDir } : {}),
    ...(options?.visualEvidence ? { visualEvidence: options.visualEvidence } : {}),
    ...(options?.audioEvidence ? { audioEvidence: options.audioEvidence } : {}),
    ...(options?.clusterAssets ? { clusterAssets: options.clusterAssets } : {}),
  };
  if (options?.mode === "interactive") {
    return buildRoughInteractivePrompt(input, options);
  }

  const prompt = buildRoughPrompt(input);
  let parsed: Record<string, unknown> | undefined;
  let decisionRuntime: DecisionRuntimeRecord = deterministicDecisionRuntime("unified-editorial-rough");
  let usedLiveRuntime = false;
  const validateRoughJson = (candidate: Record<string, unknown>): void => {
    const compactSegments = compactSegmentsForSelects(input.segments, input.marlinEvents, input.representativeFrames);
    const selects = selectsFromLlmResponse(
      selectSourceObject(candidate),
      projectIdFromBrief(input.brief),
      compactSegments,
    ) as SelectsCandidates;
    if (selects.candidates.length === 0) {
      throw new Error("unified rough JSON produced no usable selects candidates");
    }
    blueprintFromLlmResponse(candidate, {
      projectId: projectIdFromBrief(input.brief),
      autonomyMode: "full",
      briefContent: input.brief,
      selectsContent: selects,
    });
  };
  const completeRoughJson = (promptText: string) =>
    completeEditorialJson({
      role: "unified-editorial-rough",
      prompt: promptText,
      parseJson: parseLlmResponse,
      validateJson: validateRoughJson,
      repairPrompt,
    }, options?.editorialLlm ?? {});
  try {
    const completion = await completeRoughJson(prompt);
    usedLiveRuntime = completion.runtime !== "deterministic";
    decisionRuntime = decisionRuntimeRecord(completion, "unified-editorial-rough");
    parsed = completion.runtime === "deterministic" ? undefined : completion.parsed;
  } catch {
    parsed = undefined;
    decisionRuntime = deterministicDecisionRuntime("unified-editorial-rough");
  }
  let result = await normalizeRoughResult(parsed, input, decisionRuntime);
  if (usedLiveRuntime && result.selects.coverage?.status === "failed") {
    try {
      const retryCompletion = await completeRoughJson(
        roughCoverageRetryPrompt(
          prompt,
          result.selects.coverage,
          result.selects.candidates.filter((candidate) =>
            candidate.role !== "reject" && candidate.quality_gate?.decision !== "reject"
          ).length,
        ),
      );
      decisionRuntime = decisionRuntimeRecord(retryCompletion, "unified-editorial-rough");
      parsed = retryCompletion.runtime === "deterministic" ? undefined : retryCompletion.parsed;
      result = await normalizeRoughResult(parsed, input, decisionRuntime);
    } catch {
      // Keep the first normalized artifact with coverage.status=failed.
    }
  }
  return result;
}

function allowedCanonicalRefs(index: CandidateIndex): Set<string> {
  return new Set(index.candidates.map((candidate) => candidate.candidate_ref));
}

function canonicalizePlanRef(ref: unknown, index: CandidateIndex, allowed: Set<string>): string | undefined {
  const raw = stringValue(ref);
  if (!raw) return undefined;
  const canonical = index.canonicalByAlias.get(raw) ?? raw;
  return allowed.has(canonical) ? canonical : undefined;
}

function enforceSelectedCandidatePool(blueprint: EditBlueprint, selects: SelectsCandidates): EditBlueprint {
  const next = clone(blueprint);
  const index = buildCandidateIndex(selects);
  const allowed = allowedCanonicalRefs(index);
  const defaultRef = index.candidates[0]?.candidate_ref;

  for (const beat of next.beats ?? []) {
    const plan = beat.candidate_plan;
    if (!plan) continue;
    const fallbacks = uniqueStrings(
      (plan.fallback_candidate_refs ?? [])
        .map((ref) => canonicalizePlanRef(ref, index, allowed))
        .filter((ref): ref is string => Boolean(ref)),
    );
    const primary = canonicalizePlanRef(plan.primary_candidate_ref, index, allowed)
      ?? fallbacks.shift()
      ?? defaultRef;
    if (!primary) {
      delete beat.candidate_plan;
      continue;
    }
    beat.candidate_plan = {
      primary_candidate_ref: primary,
      fallback_candidate_refs: fallbacks.filter((ref) => ref !== primary),
    };
  }

  return next;
}

function sanitizeCraft(value: unknown): CraftDirective | undefined {
  const raw = recordValue(value);
  if (!raw) return undefined;
  const out: CraftDirective = {};
  const inPoint = enumValue(raw.in_point, VALID_CRAFT_IN_POINT);
  if (inPoint) out.in_point = inPoint;
  const outPoint = enumValue(raw.out_point, VALID_CRAFT_OUT_POINT);
  if (outPoint) out.out_point = outPoint;
  const transitionIn = enumValue(raw.transition_in, VALID_CRAFT_TRANSITION);
  if (transitionIn) out.transition_in = transitionIn;
  const transitionOut = enumValue(raw.transition_out, VALID_CRAFT_TRANSITION);
  if (transitionOut) out.transition_out = transitionOut;
  const rhythm = enumValue(raw.rhythm, VALID_CRAFT_RHYTHM);
  if (rhythm) out.rhythm = rhythm;
  const beatSync = typeof raw.beat_sync === "boolean" ? raw.beat_sync : undefined;
  if (beatSync !== undefined) out.beat_sync = beatSync;
  const holdDurationBias = numberValue(raw.hold_duration_bias);
  if (holdDurationBias !== undefined && holdDurationBias > 0) out.hold_duration_bias = holdDurationBias;
  const flashCut = typeof raw.flash_cut === "boolean" ? raw.flash_cut : undefined;
  if (flashCut !== undefined) out.flash_cut = flashCut;
  return Object.keys(out).length > 0 ? out : undefined;
}

function fallbackCraftForBeat(index: number, count: number): CraftDirective {
  return {
    in_point: index === 0 ? "cut_on_action" : "clean_in_clean_out",
    out_point: index === count - 1 ? "post_action_hold" : "peak_hold",
    transition_out: index === count - 1 ? "dissolve" : "hard_cut",
    rhythm: index === 0 ? "accelerando" : index === count - 1 ? "breath" : "steady",
    beat_sync: index !== count - 1,
  };
}

function mergeFineCraft(blueprint: EditBlueprint): EditBlueprint {
  const next = clone(blueprint);
  const count = next.beats.length;
  next.beats = next.beats.map((beat, index) => {
    const craft = {
      ...fallbackCraftForBeat(index, count),
      ...(sanitizeCraft(beat.craft) ?? {}),
    };
    return { ...beat, craft };
  });
  return next;
}

function bestEventForCandidate(candidate: Candidate, events: MarlinEvent[]): MarlinEvent | undefined {
  const valid = events
    .filter((event) =>
      Number.isFinite(event.start_us)
      && Number.isFinite(event.end_us)
      && event.end_us > event.start_us
    )
    .filter((event) => overlapsSegment(candidate, event));
  return valid.sort((a, b) =>
    (b.confidence ?? 0.6) - (a.confidence ?? 0.6) ||
    (b.end_us - b.start_us) - (a.end_us - a.start_us) ||
    a.start_us - b.start_us
  )[0];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function recommendedRangeFromEvent(candidate: Candidate, event: MarlinEvent | undefined): {
  inUs: number;
  outUs: number;
} {
  if (event) {
    const inUs = clamp(Math.trunc(event.start_us), candidate.src_in_us, candidate.src_out_us);
    const outUs = clamp(Math.trunc(event.end_us), candidate.src_in_us, candidate.src_out_us);
    if (outUs - inUs >= MIN_FINE_DURATION_US) return { inUs, outUs };
  }

  const duration = candidate.src_out_us - candidate.src_in_us;
  const preferred = Math.min(Math.max(MIN_FINE_DURATION_US, duration), DEFAULT_CLIP_DURATION_US);
  const center = Math.trunc((candidate.src_in_us + candidate.src_out_us) / 2);
  const inUs = clamp(Math.trunc(center - preferred / 2), candidate.src_in_us, candidate.src_out_us);
  const outUs = clamp(inUs + preferred, candidate.src_in_us, candidate.src_out_us);
  return outUs > inUs ? { inUs, outUs } : { inUs: candidate.src_in_us, outUs: candidate.src_out_us };
}

function inferPeakTypeFromText(text: string): NonNullable<TrimHint["peak_type"]> {
  const lower = text.toLowerCase();
  if (lower.includes("smile") || lower.includes("reaction") || lower.includes("laugh")) return "emotional_peak";
  if (lower.includes("move") || lower.includes("walk") || lower.includes("action") || lower.includes("hand")) return "action_peak";
  return "visual_peak";
}

function applyDeterministicFineTrimHints(selects: SelectsCandidates, marlinEvents: MarlinEventsArtifact): void {
  const eventsByAsset = marlinEventsForAsset(marlinEvents);
  for (const candidate of selects.candidates) {
    if (candidate.role === "reject") continue;
    const event = bestEventForCandidate(candidate, eventsByAsset.get(candidate.asset_id) ?? []);
    const range = recommendedRangeFromEvent(candidate, event);
    if (range.outUs <= range.inUs) continue;
    const peakType = event ? inferPeakTypeFromText(event.description) : candidate.trim_hint?.peak_type;
    candidate.trim_hint = {
      ...(candidate.trim_hint ?? {}),
      source_center_us: Math.round((range.inUs + range.outUs) / 2),
      preferred_duration_us: range.outUs - range.inUs,
      window_start_us: range.inUs,
      window_end_us: range.outUs,
      recommended_in_us: range.inUs,
      recommended_out_us: range.outUs,
      center_source: "precision_proxy_clip",
      rationale: event
        ? `Fine pass uses Marlin ${event.event_id}: ${event.description}`
        : "Fine pass fallback uses the strongest centered range in the selected clip.",
      ...(event ? { peak_ref: event.event_id } : {}),
      ...(peakType ? { peak_type: peakType } : {}),
    };
    if (event) {
      candidate.editorial_signals ??= {};
      candidate.editorial_signals.peak_ref = event.event_id;
      candidate.editorial_signals.peak_type = peakType;
      candidate.editorial_signals.peak_strength_score = clamp01(event.confidence, 0.7);
      candidate.editorial_signals.peak_source_pass = "marlin_caption";
    }
  }
}

function clipCraftItems(parsed: Record<string, unknown> | undefined): unknown[] {
  if (!parsed) return [];
  const direct = parsed.clip_craft;
  if (Array.isArray(direct)) return direct;
  const nested = recordValue(parsed.fine_cut)?.clip_craft;
  if (Array.isArray(nested)) return nested;
  const refinements = parsed.clip_refinements;
  if (Array.isArray(refinements)) return refinements;
  return [];
}

function applyLlmClipCraft(selects: SelectsCandidates, parsed: Record<string, unknown> | undefined): void {
  const bySegment = new Map(selects.candidates.map((candidate) => [candidate.segment_id, candidate]));
  for (const rawItem of clipCraftItems(parsed)) {
    const item = recordValue(rawItem);
    if (!item) continue;
    const segmentId = stringValue(item.segment_id);
    if (!segmentId) continue;
    const candidate = bySegment.get(segmentId);
    if (!candidate || candidate.role === "reject") continue;

    const inUs = nonNegativeInteger(item.recommended_in_us);
    const outUs = nonNegativeInteger(item.recommended_out_us);
    if (inUs === undefined || outUs === undefined || outUs <= inUs) continue;
    const clampedIn = clamp(inUs, candidate.src_in_us, candidate.src_out_us);
    const clampedOut = clamp(outUs, candidate.src_in_us, candidate.src_out_us);
    if (clampedOut <= clampedIn) continue;

    const preferredDuration = positiveInteger(item.preferred_duration_us) ?? clampedOut - clampedIn;
    const peakType = enumValue(item.peak_type, VALID_PEAK_TYPES);
    const eventId = stringValue(item.event_id) ?? stringValue(item.peak_ref);
    const rationale = stringValue(item.rationale);
    candidate.trim_hint = {
      ...(candidate.trim_hint ?? {}),
      source_center_us: Math.round((clampedIn + clampedOut) / 2),
      preferred_duration_us: preferredDuration,
      window_start_us: clampedIn,
      window_end_us: clampedOut,
      recommended_in_us: clampedIn,
      recommended_out_us: clampedOut,
      center_source: "precision_proxy_clip",
      ...(rationale ? { rationale, interest_point_label: rationale } : {}),
      ...(eventId ? { peak_ref: eventId } : {}),
      ...(peakType ? { peak_type: peakType } : {}),
    };
  }
}

function normalizeFineBlueprint(
  parsed: Record<string, unknown> | undefined,
  input: {
    brief: CreativeBrief;
    selects: SelectsCandidates;
    blueprint: EditBlueprint;
    marlinEvents: MarlinEventsArtifact;
    bgmDurationSec: number | null;
  },
  decisionRuntime: DecisionRuntimeRecord = injectedDecisionRuntime("unified-editorial-fine"),
): EditBlueprint {
  applyDeterministicFineTrimHints(input.selects, input.marlinEvents);
  applyLlmClipCraft(input.selects, parsed);
  input.selects.decision_runtime = decisionRuntime;

  let next: EditBlueprint;
  try {
    next = parsed
      ? blueprintFromLlmResponse(parsed, {
        projectId: projectIdFromBrief(input.brief),
        autonomyMode: "full",
        briefContent: input.brief,
        selectsContent: input.selects,
      })
      : clone(input.blueprint);
  } catch {
    next = clone(input.blueprint);
  }

  next = enforceSelectedCandidatePool(next, input.selects);
  next = mergeFineCraft(next);
  next.decision_runtime = decisionRuntime;
  if (input.bgmDurationSec !== null) {
    next.music_policy = {
      ...next.music_policy,
      bgm_duration_sec: input.bgmDurationSec,
    };
    next.duration_policy = {
      ...(next.duration_policy ?? fallbackBlueprint(input.brief, input.selects, input.bgmDurationSec).duration_policy!),
      max_duration_sec: input.bgmDurationSec,
    };
  }
  validateArtifact<SelectsCandidates>(input.selects, "selects-candidates.schema.json");
  validateArtifact<EditBlueprint>(next, "edit-blueprint.schema.json");
  return next;
}

export function parseFineCutRefinementResponse(
  response: string | Record<string, unknown>,
  input: FineCutRefinementInput,
): EditBlueprint {
  return normalizeFineBlueprint(parseAgentJsonResponse(response), input);
}

export function fineCutRefinement(
  brief: CreativeBrief,
  selects: SelectsCandidates,
  blueprint: EditBlueprint,
  marlinEvents: MarlinEventsArtifact,
  keyFrames: Map<string, KeyFrame[]>,
  bgmDurationSec: number | null,
  options: EditorialAgentOptions & { mode: "interactive" },
): Promise<EditorialInteractivePrompt>;
export function fineCutRefinement(
  brief: CreativeBrief,
  selects: SelectsCandidates,
  blueprint: EditBlueprint,
  marlinEvents: MarlinEventsArtifact,
  keyFrames: Map<string, KeyFrame[]>,
  bgmDurationSec: number | null,
  options?: EditorialAgentOptions,
): Promise<EditBlueprint>;
export async function fineCutRefinement(
  brief: CreativeBrief,
  selects: SelectsCandidates,
  blueprint: EditBlueprint,
  marlinEvents: MarlinEventsArtifact,
  keyFrames: Map<string, KeyFrame[]>,
  bgmDurationSec: number | null,
  options?: EditorialAgentOptions,
): Promise<EditBlueprint | EditorialInteractivePrompt> {
  const input: FineCutRefinementInput = { brief, selects, blueprint, marlinEvents, keyFrames, bgmDurationSec };
  if (options?.mode === "interactive") {
    return buildFineInteractivePrompt(input, options);
  }

  const prompt = buildFinePrompt(input);
  let parsed: Record<string, unknown> | undefined;
  let decisionRuntime: DecisionRuntimeRecord = deterministicDecisionRuntime("unified-editorial-fine");
  try {
    const completion = await completeEditorialJson({
      role: "unified-editorial-fine",
      prompt,
      parseJson: parseLlmResponse,
      validateJson: (candidate) => {
        blueprintFromLlmResponse(candidate, {
          projectId: projectIdFromBrief(input.brief),
          autonomyMode: "full",
          briefContent: input.brief,
          selectsContent: input.selects,
        });
      },
      repairPrompt,
    }, options?.editorialLlm ?? {});
    decisionRuntime = decisionRuntimeRecord(completion, "unified-editorial-fine");
    parsed = completion.runtime === "deterministic" ? undefined : completion.parsed;
  } catch {
    parsed = undefined;
    decisionRuntime = deterministicDecisionRuntime("unified-editorial-fine");
  }
  return normalizeFineBlueprint(parsed, { brief, selects, blueprint, marlinEvents, bgmDurationSec }, decisionRuntime);
}
