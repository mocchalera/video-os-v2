import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { validateArtifact } from "../artifacts/loaders.js";
import type {
  BeatAlignmentDecision,
  MusicCueV2,
  MusicCuesDoc,
} from "../audio/music-cues.js";
import { inspectInstalledPacks, type PackRegistryOptions } from "./pack-registry.js";
import type {
  BgmPackAssetRef,
  BgmPackDataRef,
  BgmPackTrack,
} from "./pack-types.js";
import type {
  BgmSelectedTrackPin,
  BgmSelectionArtifact,
} from "./selection-service.js";

export type BgmCuePlanningErrorCode =
  | "BGM_SELECTION_INCONCLUSIVE"
  | "BGM_RENDER_PLAN_STALE"
  | "BGM_ARRANGEMENT_NO_SAFE_FIT"
  | "BGM_CUE_OUTPUT_UNSAFE"
  | "BGM_CUE_OUTPUT_EXISTS"
  | "BGM_PACK_NOT_FOUND";

export class BgmCuePlanningError extends Error {
  constructor(
    public readonly code: BgmCuePlanningErrorCode,
    message: string,
    public readonly affected_ref: string,
    public readonly recoverable = false,
  ) {
    super(message);
    this.name = "BgmCuePlanningError";
  }
}

export interface CanonicalTrackAnalysis {
  version?: string;
  track_id?: string;
  input_content_hash?: string;
  status?: "ready" | "degraded" | "failed";
  tempo?: {
    bpm?: number | null;
    meter?: string | null;
    confidence?: number | null;
  };
  structure?: {
    beats?: unknown[];
    downbeats?: unknown[];
    sections?: unknown[];
  };
  degraded_reasons?: string[];
  [key: string]: unknown;
}

export interface ResolvedPinnedBgmTrack {
  pack_id: string;
  pack_version: string;
  manifest_hash: string;
  track_id: string;
  title: string;
  duration_us: number;
  full_mix_ref: BgmPackAssetRef;
  analysis_ref: BgmPackDataRef;
  analysis: CanonicalTrackAnalysis;
  full_mix_path?: string;
  analysis_path?: string;
}

export interface LockExplicitBgmSelectionOptions {
  trackId: string;
  operatorRef: string;
  reason: string;
  decidedAt: string;
}

export interface SemanticAnchorInput {
  label: string;
  timelineFrame: number;
  sourceOnsetUs: number;
}

export interface MusicCuePlanInput {
  cueId: string;
  timelineInFrame: number;
  timelineOutFrame: number;
  sourceInUs: number;
  sourceOutUs: number;
  section: string;
  phase: string;
  semanticAnchor: SemanticAnchorInput;
  fadeInMs?: number;
  fadeOutMs?: number;
  ducking?: {
    base_gain_db: number;
    duck_gain_db: number;
    attack_ms: number;
    release_ms: number;
  };
}

export interface PlanMusicCuesV2Input {
  selection: BgmSelectionArtifact;
  resolvedTrack: ResolvedPinnedBgmTrack;
  timeline: unknown;
  selectionRef: string;
  selectionHash: string;
  cues: MusicCuePlanInput[];
}

export interface PlanMusicCuesV2Result {
  music_cues: MusicCuesDoc;
  timeline_tail_frame: number;
}

export interface BgmCueDecisionReport {
  version: "1.0.0";
  project_id: string;
  created_at: string;
  decision: "explicit_audition_candidate";
  release_status: "audition_only";
  selected_track_pin: BgmSelectedTrackPin;
  input_timeline_hash: string;
  selection_hash: string;
  music_cues_hash: string;
  projected_timeline_hash: string;
  warnings: string[];
}

export interface MaterializeBgmCuePlanOptions {
  projectPath: string;
  outputPath: string;
  selection: BgmSelectionArtifact;
  musicCues: MusicCuesDoc;
  decisionReport: BgmCueDecisionReport;
  projectedTimeline: unknown;
}

export interface MaterializedBgmCuePlan {
  output_path: string;
  files: string[];
  hashes: Record<string, string>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function contained(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function stableWarnings(values: Iterable<string>): string[] {
  return [...new Set([...values].map((value) => value.trim()).filter(Boolean))].sort();
}

function analysisStatus(analysis: CanonicalTrackAnalysis): BgmSelectedTrackPin["analysis_status"] {
  return analysis.status === "ready" || analysis.status === "degraded" || analysis.status === "failed"
    ? analysis.status
    : "unavailable";
}

export function contentHashForJson(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(value, null, 2))
    .digest("hex")}`;
}

function pinForTrack(track: ResolvedPinnedBgmTrack): BgmSelectedTrackPin {
  return {
    pack_id: track.pack_id,
    pack_version: track.pack_version,
    pack_manifest_hash: track.manifest_hash,
    track_id: track.track_id,
    full_mix_content_hash: track.full_mix_ref.content_hash,
    full_mix_size_bytes: track.full_mix_ref.size_bytes,
    full_mix_path: track.full_mix_ref.path,
    analysis_content_hash: track.analysis_ref.content_hash,
    analysis_size_bytes: track.analysis_ref.size_bytes,
    analysis_path: track.analysis_ref.path,
    analysis_status: analysisStatus(track.analysis),
    registry_status: "verified",
  };
}

export function lockExplicitBgmSelection(
  source: BgmSelectionArtifact,
  resolvedTrack: ResolvedPinnedBgmTrack,
  options: LockExplicitBgmSelectionOptions,
): BgmSelectionArtifact {
  if (options.trackId !== resolvedTrack.track_id) {
    throw new BgmCuePlanningError(
      "BGM_SELECTION_INCONCLUSIVE",
      "The resolved Pack track does not match the explicitly requested track_id.",
      options.trackId,
    );
  }
  const candidate = source.candidates.find((entry) => entry.track_id === options.trackId);
  if (!candidate || candidate.status !== "ranked" || candidate.rank === null || candidate.total_score === null) {
    throw new BgmCuePlanningError(
      "BGM_SELECTION_INCONCLUSIVE",
      "The explicitly requested track was not a ranked candidate and cannot be locked by inference.",
      options.trackId,
      true,
    );
  }
  if (candidate.content_hash !== resolvedTrack.full_mix_ref.content_hash) {
    throw new BgmCuePlanningError(
      "BGM_RENDER_PLAN_STALE",
      "The ranked candidate full-mix hash does not match the verified Pack track.",
      options.trackId,
    );
  }
  if (!options.operatorRef.trim() || !options.reason.trim()) {
    throw new BgmCuePlanningError(
      "BGM_SELECTION_INCONCLUSIVE",
      "An explicit operator reference and reason are required to lock a track.",
      options.trackId,
      true,
    );
  }
  if (Number.isNaN(Date.parse(options.decidedAt))) {
    throw new BgmCuePlanningError(
      "BGM_SELECTION_INCONCLUSIVE",
      "The explicit selection decision timestamp is invalid.",
      options.trackId,
      true,
    );
  }

  const artifact: BgmSelectionArtifact = {
    ...structuredClone(source),
    mode: "operator_locked",
    selected: {
      track_id: candidate.track_id,
      content_hash: candidate.content_hash,
      rank: candidate.rank,
      score: candidate.total_score,
      confidence: Math.min(1, Math.max(0, candidate.total_score / 100)),
      explanation: `Explicitly locked after candidate review: ${candidate.explanation}`,
    },
    selected_track_pin: pinForTrack(resolvedTrack),
    operator_override: {
      selected_track_id: options.trackId,
      reason: options.reason.trim(),
      operator_ref: options.operatorRef.trim(),
      overridden_at: new Date(options.decidedAt).toISOString(),
    },
  };
  return validateArtifact<BgmSelectionArtifact>(artifact, "bgm-selection.schema.json");
}

function mismatch(label: string, affectedRef: string): never {
  throw new BgmCuePlanningError(
    "BGM_RENDER_PLAN_STALE",
    `The selected BGM ${label} no longer matches its hash-and-size pin.`,
    affectedRef,
  );
}

export function assertSelectionPinsMatch(
  selection: BgmSelectionArtifact,
  resolvedTrack: ResolvedPinnedBgmTrack,
): void {
  const pin = selection.selected_track_pin;
  if (selection.mode !== "operator_locked" || !selection.selected || !pin) {
    throw new BgmCuePlanningError(
      "BGM_SELECTION_INCONCLUSIVE",
      "A hash-pinned operator_locked bgm_selection artifact is required.",
      selection.project_id,
      true,
    );
  }
  if (selection.selected.track_id !== pin.track_id || pin.track_id !== resolvedTrack.track_id) {
    mismatch("track identity", pin.track_id);
  }
  if (
    pin.pack_id !== resolvedTrack.pack_id
    || pin.pack_version !== resolvedTrack.pack_version
    || pin.pack_manifest_hash !== resolvedTrack.manifest_hash
  ) {
    mismatch("Pack manifest", pin.track_id);
  }
  if (
    pin.full_mix_content_hash !== resolvedTrack.full_mix_ref.content_hash
    || pin.full_mix_size_bytes !== resolvedTrack.full_mix_ref.size_bytes
    || pin.full_mix_path !== resolvedTrack.full_mix_ref.path
    || selection.selected.content_hash !== resolvedTrack.full_mix_ref.content_hash
  ) {
    mismatch("full mix", pin.track_id);
  }
  if (
    pin.analysis_content_hash !== resolvedTrack.analysis_ref.content_hash
    || pin.analysis_size_bytes !== resolvedTrack.analysis_ref.size_bytes
    || pin.analysis_path !== resolvedTrack.analysis_ref.path
  ) {
    mismatch("analysis", pin.track_id);
  }
}

function timelineFacts(timeline: unknown): {
  projectId: string;
  version: string;
  createdAt: string;
  fpsNum: number;
  fpsDen: number;
  tailFrame: number;
} {
  const root = record(timeline);
  const sequence = record(root?.sequence);
  const fpsNum = integer(sequence?.fps_num);
  const fpsDen = integer(sequence?.fps_den);
  if (!root || typeof root.project_id !== "string" || !fpsNum || !fpsDen) {
    throw new BgmCuePlanningError(
      "BGM_ARRANGEMENT_NO_SAFE_FIT",
      "The timeline must provide project_id and a positive rational fps contract.",
      "timeline",
      true,
    );
  }
  const tracks = record(root.tracks);
  const trackValues = [
    ...(Array.isArray(tracks?.video) ? tracks.video : []),
    ...(Array.isArray(tracks?.audio) ? tracks.audio : []),
  ];
  let tailFrame = 0;
  for (const trackValue of trackValues) {
    const track = record(trackValue);
    for (const clipValue of Array.isArray(track?.clips) ? track.clips : []) {
      const clip = record(clipValue);
      const start = integer(clip?.timeline_in_frame);
      const duration = integer(clip?.timeline_duration_frames);
      if (start !== undefined && duration !== undefined && duration > 0) {
        tailFrame = Math.max(tailFrame, start + duration);
      }
    }
  }
  if (tailFrame <= 0) {
    throw new BgmCuePlanningError(
      "BGM_ARRANGEMENT_NO_SAFE_FIT",
      "The timeline has no positive content tail for music placement.",
      root.project_id,
      true,
    );
  }
  return {
    projectId: root.project_id,
    version: typeof root.version === "string" ? root.version : "1",
    createdAt: typeof root.created_at === "string" && !Number.isNaN(Date.parse(root.created_at))
      ? new Date(root.created_at).toISOString()
      : "1970-01-01T00:00:00.000Z",
    fpsNum,
    fpsDen,
    tailFrame,
  };
}

function expectedSourceDurationUs(frames: number, fpsNum: number, fpsDen: number): number {
  return Math.round(frames * 1_000_000 * fpsDen / fpsNum);
}

function beatAlignment(
  track: ResolvedPinnedBgmTrack,
  sourceOnsetUs: number,
): BeatAlignmentDecision {
  const status = analysisStatus(track.analysis);
  const tempo = track.analysis.tempo;
  const rawConfidence = finite(tempo?.confidence);
  const trustedGrid = status === "ready"
    && ((track.analysis.structure?.beats?.length ?? 0) > 0
      || (track.analysis.structure?.downbeats?.length ?? 0) > 0);
  const confidence = rawConfidence === undefined
    ? null
    : Math.round(Math.min(trustedGrid ? 1 : 0.49, Math.max(0, rawConfidence)) * 10_000) / 10_000;
  const warnings = trustedGrid
    ? []
    : stableWarnings([
      "No trusted beat grid is available; the explicit source onset is retained without moving picture boundaries.",
      ...(track.analysis.degraded_reasons ?? []),
    ]);
  return {
    requested: "semantic_anchor_source_onset",
    status: trustedGrid ? "aligned" : "degraded",
    decision: "explicit_source_onset",
    analysis_status: status,
    confidence,
    grid_source: trustedGrid ? "canonical_analysis" : null,
    source_onset_us: sourceOnsetUs,
    timeline_boundaries_moved: false,
    warnings,
  };
}

function validateCueInput(
  cue: MusicCuePlanInput,
  facts: ReturnType<typeof timelineFacts>,
  track: ResolvedPinnedBgmTrack,
): void {
  const affectedRef = cue.cueId || track.track_id;
  if (!/^MC_[A-Z0-9_]+$/.test(cue.cueId)) {
    throw new BgmCuePlanningError(
      "BGM_ARRANGEMENT_NO_SAFE_FIT",
      "cue_id must use the stable MC_ uppercase identifier form.",
      affectedRef,
      true,
    );
  }
  for (const [label, value] of [
    ["timeline in", cue.timelineInFrame],
    ["timeline out", cue.timelineOutFrame],
    ["source in", cue.sourceInUs],
    ["source out", cue.sourceOutUs],
    ["semantic anchor frame", cue.semanticAnchor.timelineFrame],
    ["semantic source onset", cue.semanticAnchor.sourceOnsetUs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new BgmCuePlanningError(
        "BGM_ARRANGEMENT_NO_SAFE_FIT",
        `${label} must be a non-negative safe integer.`,
        affectedRef,
        true,
      );
    }
  }
  if (cue.timelineOutFrame <= cue.timelineInFrame) {
    throw new BgmCuePlanningError(
      "BGM_ARRANGEMENT_NO_SAFE_FIT",
      "The cue timeline range must have positive duration.",
      affectedRef,
      true,
    );
  }
  if (cue.timelineOutFrame > facts.tailFrame) {
    throw new BgmCuePlanningError(
      "BGM_ARRANGEMENT_NO_SAFE_FIT",
      "The cue timeline range exceeds the timeline tail.",
      affectedRef,
      true,
    );
  }
  if (cue.sourceOutUs <= cue.sourceInUs || cue.sourceOutUs > track.duration_us) {
    throw new BgmCuePlanningError(
      "BGM_ARRANGEMENT_NO_SAFE_FIT",
      "The cue source range exceeds the verified track duration or is empty.",
      affectedRef,
      true,
    );
  }
  const expectedUs = expectedSourceDurationUs(
    cue.timelineOutFrame - cue.timelineInFrame,
    facts.fpsNum,
    facts.fpsDen,
  );
  if (cue.sourceOutUs - cue.sourceInUs !== expectedUs) {
    throw new BgmCuePlanningError(
      "BGM_ARRANGEMENT_NO_SAFE_FIT",
      "The source window duration must equal the rational-fps timeline duration; Phase 2 does not time-stretch.",
      affectedRef,
      true,
    );
  }
  if (
    cue.semanticAnchor.timelineFrame < cue.timelineInFrame
    || cue.semanticAnchor.timelineFrame >= cue.timelineOutFrame
    || cue.semanticAnchor.sourceOnsetUs < cue.sourceInUs
    || cue.semanticAnchor.sourceOnsetUs >= cue.sourceOutUs
  ) {
    throw new BgmCuePlanningError(
      "BGM_ARRANGEMENT_NO_SAFE_FIT",
      "The semantic anchor must be contained by both the timeline and source ranges.",
      affectedRef,
      true,
    );
  }
  if (!cue.section.trim() || !cue.phase.trim() || !cue.semanticAnchor.label.trim()) {
    throw new BgmCuePlanningError(
      "BGM_ARRANGEMENT_NO_SAFE_FIT",
      "section, phase, and semantic anchor label are required.",
      affectedRef,
      true,
    );
  }
}

export function planMusicCuesV2(input: PlanMusicCuesV2Input): PlanMusicCuesV2Result {
  assertSelectionPinsMatch(input.selection, input.resolvedTrack);
  if (contentHashForJson(input.selection) !== input.selectionHash) {
    throw new BgmCuePlanningError(
      "BGM_RENDER_PLAN_STALE",
      "The bgm_selection artifact hash does not match the planner input.",
      input.selectionRef,
    );
  }
  const facts = timelineFacts(input.timeline);
  if (facts.projectId !== input.selection.project_id) {
    throw new BgmCuePlanningError(
      "BGM_RENDER_PLAN_STALE",
      "The timeline and bgm_selection project IDs do not match.",
      facts.projectId,
    );
  }
  if (!Array.isArray(input.cues) || input.cues.length === 0) {
    throw new BgmCuePlanningError(
      "BGM_ARRANGEMENT_NO_SAFE_FIT",
      "At least one explicit cue is required.",
      input.resolvedTrack.track_id,
      true,
    );
  }

  const cueIds = new Set<string>();
  const ordered = [...input.cues].sort((left, right) =>
    left.timelineInFrame - right.timelineInFrame
    || left.timelineOutFrame - right.timelineOutFrame
    || left.cueId.localeCompare(right.cueId));
  let previousOut = -1;
  const cues: MusicCueV2[] = [];
  const warnings: string[] = [];
  for (const cue of ordered) {
    validateCueInput(cue, facts, input.resolvedTrack);
    if (cueIds.has(cue.cueId)) {
      throw new BgmCuePlanningError(
        "BGM_ARRANGEMENT_NO_SAFE_FIT",
        "Cue IDs must be unique.",
        cue.cueId,
        true,
      );
    }
    cueIds.add(cue.cueId);
    if (cue.timelineInFrame < previousOut) {
      throw new BgmCuePlanningError(
        "BGM_ARRANGEMENT_NO_SAFE_FIT",
        "Music cues overlap on A2.",
        cue.cueId,
        true,
      );
    }
    previousOut = cue.timelineOutFrame;
    const alignment = beatAlignment(input.resolvedTrack, cue.semanticAnchor.sourceOnsetUs);
    warnings.push(...alignment.warnings.map((warning) => `${cue.cueId}: ${warning}`));
    cues.push({
      cue_id: cue.cueId,
      track_id: input.resolvedTrack.track_id,
      timeline_track_id: "A2",
      entry_window: {
        earliest_frame: cue.timelineInFrame,
        latest_frame: cue.timelineInFrame,
        basis: "semantic_anchor",
      },
      entry_frame: cue.timelineInFrame,
      exit_frame: cue.timelineOutFrame,
      source_offset_us: cue.sourceInUs,
      source_range: { in_us: cue.sourceInUs, out_us: cue.sourceOutUs },
      timeline_range: { in_frame: cue.timelineInFrame, out_frame: cue.timelineOutFrame },
      section: cue.section.trim(),
      phase: cue.phase.trim(),
      semantic_anchor: {
        label: cue.semanticAnchor.label.trim(),
        timeline_frame: cue.semanticAnchor.timelineFrame,
        source_onset_us: cue.semanticAnchor.sourceOnsetUs,
      },
      beat_alignment: alignment,
      fade_in_ms: cue.fadeInMs ?? 400,
      fade_out_ms: cue.fadeOutMs ?? 900,
      ducking: cue.ducking ?? {
        base_gain_db: -16,
        duck_gain_db: -24,
        attack_ms: 80,
        release_ms: 280,
      },
      beat_sync: {
        enabled: false,
        analysis_ref: input.resolvedTrack.analysis_ref.path,
        align: "entry",
        ...(finite(input.resolvedTrack.analysis.tempo?.bpm) !== undefined
          ? { bpm: finite(input.resolvedTrack.analysis.tempo?.bpm) }
          : {}),
        ...(typeof input.resolvedTrack.analysis.tempo?.meter === "string"
          ? { meter: input.resolvedTrack.analysis.tempo.meter }
          : {}),
        grid_source: "phase2_explicit_source_onset",
      },
    });
  }

  const pin = input.selection.selected_track_pin!;
  const stable = stableWarnings(warnings);
  const document: MusicCuesDoc = {
    version: "2.0.0",
    project_id: facts.projectId,
    base_timeline_version: facts.version,
    selection_ref: {
      path: input.selectionRef,
      content_hash: input.selectionHash,
    },
    timeline_fps: { num: facts.fpsNum, den: facts.fpsDen },
    planning_status: stable.length > 0 ? "verified_with_warnings" : "verified",
    warnings: stable,
    music_asset: {
      asset_id: pin.track_id,
      path: pin.full_mix_path,
      source_hash: pin.full_mix_content_hash,
      analysis_ref: pin.analysis_path,
      track_id: pin.track_id,
      pack_id: pin.pack_id,
      pack_version: pin.pack_version,
      pack_manifest_hash: pin.pack_manifest_hash,
      full_mix_content_hash: pin.full_mix_content_hash,
      full_mix_size_bytes: pin.full_mix_size_bytes,
      analysis_content_hash: pin.analysis_content_hash,
      analysis_size_bytes: pin.analysis_size_bytes,
      analysis_status: pin.analysis_status,
      duration_us: input.resolvedTrack.duration_us,
    },
    cues,
  };
  return {
    music_cues: validateArtifact<MusicCuesDoc>(document, "music-cues.schema.json"),
    timeline_tail_frame: facts.tailFrame,
  };
}

function readAnalysis(filePath: string): CanonicalTrackAnalysis {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as CanonicalTrackAnalysis;
  } catch {
    throw new BgmCuePlanningError(
      "BGM_RENDER_PLAN_STALE",
      "The pinned canonical track analysis could not be read.",
      path.basename(filePath),
    );
  }
}

function resolvedFromPack(
  pack: ReturnType<typeof inspectInstalledPacks>["packs"][number],
  track: BgmPackTrack,
): ResolvedPinnedBgmTrack {
  const verified = pack.verification.verified_assets?.[track.track_id];
  if (!pack.verification.ok || !verified?.full_mix_path || !verified.analysis_path) {
    throw new BgmCuePlanningError(
      "BGM_RENDER_PLAN_STALE",
      "The selected track is no longer fully verified by the Pack Registry.",
      track.track_id,
    );
  }
  return {
    pack_id: pack.manifest.pack_id,
    pack_version: pack.manifest.pack_version,
    manifest_hash: pack.manifest_hash,
    track_id: track.track_id,
    title: track.title,
    duration_us: track.duration_us,
    full_mix_ref: track.full_mix,
    analysis_ref: track.analysis_ref,
    analysis: readAnalysis(verified.analysis_path),
    full_mix_path: verified.full_mix_path,
    analysis_path: verified.analysis_path,
  };
}

export function resolveExplicitBgmTrack(
  trackId: string,
  expectedContentHash: string,
  options: PackRegistryOptions = {},
): ResolvedPinnedBgmTrack {
  const registry = inspectInstalledPacks(options);
  const matches = registry.packs.flatMap((pack) =>
    pack.manifest.tracks
      .filter((track) => track.track_id === trackId && track.full_mix.content_hash === expectedContentHash)
      .map((track) => ({ pack, track })));
  if (matches.length === 0) {
    throw new BgmCuePlanningError(
      "BGM_PACK_NOT_FOUND",
      "The explicitly selected track and full-mix hash are not available in a verified Pack.",
      trackId,
      true,
    );
  }
  if (matches.length > 1) {
    throw new BgmCuePlanningError(
      "BGM_SELECTION_INCONCLUSIVE",
      "The explicit track/hash pair resolves to multiple installed Packs.",
      trackId,
    );
  }
  return resolvedFromPack(matches[0].pack, matches[0].track);
}

export function resolvePinnedBgmSelection(
  selection: BgmSelectionArtifact,
  options: PackRegistryOptions = {},
): ResolvedPinnedBgmTrack {
  const pin = selection.selected_track_pin;
  if (!pin) {
    throw new BgmCuePlanningError(
      "BGM_SELECTION_INCONCLUSIVE",
      "The bgm_selection artifact has no selected Pack pin.",
      selection.project_id,
      true,
    );
  }
  const registry = inspectInstalledPacks(options);
  const pack = registry.packs.find((entry) =>
    entry.manifest.pack_id === pin.pack_id
    && entry.manifest.pack_version === pin.pack_version);
  if (!pack) {
    throw new BgmCuePlanningError(
      "BGM_PACK_NOT_FOUND",
      "The exact pinned Pack version is not installed.",
      `${pin.pack_id}@${pin.pack_version}`,
      true,
    );
  }
  if (pack.manifest_hash !== pin.pack_manifest_hash) mismatch("Pack manifest", pin.track_id);
  const track = pack.manifest.tracks.find((entry) => entry.track_id === pin.track_id);
  if (!track) mismatch("track identity", pin.track_id);
  const resolved = resolvedFromPack(pack, track);
  assertSelectionPinsMatch(selection, resolved);
  return resolved;
}

export function buildBgmCueDecisionReport(input: {
  selection: BgmSelectionArtifact;
  musicCues: MusicCuesDoc;
  inputTimeline: unknown;
  projectedTimeline: unknown;
}): BgmCueDecisionReport {
  const pin = input.selection.selected_track_pin;
  if (!pin) {
    throw new BgmCuePlanningError(
      "BGM_SELECTION_INCONCLUSIVE",
      "A selected track pin is required for the decision report.",
      input.selection.project_id,
      true,
    );
  }
  const report: BgmCueDecisionReport = {
    version: "1.0.0",
    project_id: input.selection.project_id,
    created_at: input.selection.created_at,
    decision: "explicit_audition_candidate",
    release_status: "audition_only",
    selected_track_pin: pin,
    input_timeline_hash: contentHashForJson(input.inputTimeline),
    selection_hash: contentHashForJson(input.selection),
    music_cues_hash: contentHashForJson(input.musicCues),
    projected_timeline_hash: contentHashForJson(input.projectedTimeline),
    warnings: stableWarnings([
      ...input.selection.warnings,
      ...(input.musicCues.warnings ?? []),
      "This decision is an audition/test candidate only; it is not final music selection or public-release approval.",
    ]),
  };
  return validateArtifact<BgmCueDecisionReport>(
    report,
    "bgm-cue-decision-report.schema.json",
  );
}

function pathEntryExists(value: string): boolean {
  try {
    fs.lstatSync(value);
    return true;
  } catch {
    return false;
  }
}

function resolveThroughExistingAncestor(value: string): string {
  let current = path.resolve(value);
  const suffix: string[] = [];
  while (!pathEntryExists(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    suffix.unshift(path.basename(current));
    current = parent;
  }
  return path.resolve(fs.realpathSync(current), ...suffix);
}

export function validateBgmCuePlanOutputPath(outputPath: string, projectPath: string): string {
  const output = path.resolve(outputPath);
  const project = fs.existsSync(projectPath)
    ? fs.realpathSync(projectPath)
    : path.resolve(projectPath);
  const outputExists = pathEntryExists(output);
  let projectedOutput: string;
  try {
    projectedOutput = resolveThroughExistingAncestor(output);
  } catch {
    if (outputExists) {
      throw new BgmCuePlanningError(
        "BGM_CUE_OUTPUT_EXISTS",
        "The BGM cue plan output already exists; existing artifacts are never overwritten.",
        path.basename(output),
        true,
      );
    }
    throw new BgmCuePlanningError(
      "BGM_CUE_OUTPUT_UNSAFE",
      "The BGM cue plan output path could not be resolved safely.",
      path.basename(output) || "output",
    );
  }
  if (
    output === path.parse(output).root
    || contained(project, projectedOutput)
    || contained(projectedOutput, project)
    || output.split(path.sep).some((segment) => segment === ".git" || segment === "node_modules")
  ) {
    throw new BgmCuePlanningError(
      "BGM_CUE_OUTPUT_UNSAFE",
      "The BGM cue plan output path is unsafe because it overlaps project inputs or repository internals.",
      path.basename(output) || "output",
    );
  }
  if (outputExists) {
    throw new BgmCuePlanningError(
      "BGM_CUE_OUTPUT_EXISTS",
      "The BGM cue plan output already exists; existing artifacts are never overwritten.",
      path.basename(output),
      true,
    );
  }
  return output;
}

function writeJson(filePath: string, value: unknown): string {
  const bytes = JSON.stringify(value, null, 2);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, bytes, { flag: "wx" });
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function materializeBgmCuePlan(
  options: MaterializeBgmCuePlanOptions,
): MaterializedBgmCuePlan {
  const output = validateBgmCuePlanOutputPath(options.outputPath, options.projectPath);
  const selection = validateArtifact<BgmSelectionArtifact>(
    options.selection,
    "bgm-selection.schema.json",
  );
  const musicCues = validateArtifact<MusicCuesDoc>(
    options.musicCues,
    "music-cues.schema.json",
  );
  const report = validateArtifact<BgmCueDecisionReport>(
    options.decisionReport,
    "bgm-cue-decision-report.schema.json",
  );
  validateArtifact(options.projectedTimeline, "timeline-ir.schema.json");
  const selectionHash = contentHashForJson(selection);
  if (
    report.project_id !== selection.project_id
    || musicCues.project_id !== selection.project_id
    || report.selection_hash !== selectionHash
    || musicCues.selection_ref?.content_hash !== selectionHash
    || report.music_cues_hash !== contentHashForJson(musicCues)
    || report.projected_timeline_hash !== contentHashForJson(options.projectedTimeline)
    || contentHashForJson(report.selected_track_pin)
      !== contentHashForJson(selection.selected_track_pin)
  ) {
    throw new BgmCuePlanningError(
      "BGM_RENDER_PLAN_STALE",
      "The BGM cue output artifacts do not share the same hash-pinned decision.",
      selection.project_id,
    );
  }
  const parent = path.dirname(output);
  fs.mkdirSync(parent, { recursive: true });
  const staging = path.join(parent, `.${path.basename(output)}.tmp-${process.pid}-${contentHashForJson({
    selection: options.selection,
    music_cues: options.musicCues,
  }).slice(-12)}`);
  if (fs.existsSync(staging)) {
    throw new BgmCuePlanningError(
      "BGM_CUE_OUTPUT_EXISTS",
      "A BGM cue plan staging output already exists.",
      path.basename(output),
      true,
    );
  }
  const files = [
    "04_plan/bgm_selection.json",
    "05_timeline/timeline.json",
    "07_package/bgm-cue-decision-report.json",
    "07_package/music_cues.json",
  ].sort();
  const values: Record<string, unknown> = {
    "04_plan/bgm_selection.json": options.selection,
    "05_timeline/timeline.json": options.projectedTimeline,
    "07_package/bgm-cue-decision-report.json": options.decisionReport,
    "07_package/music_cues.json": options.musicCues,
  };
  const hashes: Record<string, string> = {};
  let activated = false;
  try {
    fs.mkdirSync(staging);
    for (const relativePath of files) {
      hashes[relativePath] = writeJson(path.join(staging, relativePath), values[relativePath]);
    }
    fs.renameSync(staging, output);
    activated = true;
    return { output_path: output, files, hashes };
  } catch (error) {
    if (!activated && fs.existsSync(staging)) {
      fs.rmSync(staging, { recursive: true, force: true });
    }
    throw error;
  }
}
