import { createHash } from "node:crypto";

import type {
  SfxCue,
  SfxCueAssetPin,
  SfxCuesDoc,
  SfxSemanticRole,
} from "./sfx-cues.js";

export type SoundDesignCongestionType =
  | "dialogue"
  | "music_entry"
  | "lower_third"
  | "section_label"
  | "caption"
  | "picture_edit"
  | "overlay";

export interface SoundDesignCandidate {
  candidate_id: string;
  semantic_role: SfxSemanticRole;
  semantic_purpose: string | null;
  evidence_refs: string[];
  semantic_strength: number;
  semantic_anchor: {
    label: string;
    frame: number;
    window: {
      earliest_frame: number;
      latest_frame: number;
    };
  };
  asset_id: string;
  asset_pin: SfxCueAssetPin;
  audio: Pick<
    SfxCue,
    | "duration_frames"
    | "source_range"
    | "gain_db"
    | "fade_in_ms"
    | "fade_out_ms"
    | "tail"
    | "duck_group"
    | "ducking"
  >;
}

export interface SoundDesignBeatEvidence {
  status: "available" | "degraded" | "unavailable";
  analysis_status: "ready" | "degraded" | "failed" | "unavailable";
  analysis_path: string | null;
  content_hash: string | null;
  bpm: number | null;
  confidence: number | null;
  beat_frames: number[];
  downbeat_frames: number[];
}

export interface SoundDesignPolicy {
  minimum_spacing_frames: number;
  max_cues_per_30_seconds: number;
  absolute_max_cues: number;
  semantic_accept_threshold: number;
  congestion_reject_threshold: number;
  minimum_beat_confidence: number;
  max_snap_frames: number;
  congestion_weights: Record<SoundDesignCongestionType, number>;
}

export interface SoundDesignRequest {
  version: "sound-design-request/v1";
  project_id: string;
  base_timeline_version: string;
  timeline_fps: { num: number; den: number };
  timeline_duration_frames: number;
  timeline_ref: {
    path: string;
    content_hash: string;
  };
  library: {
    manifest_path: string;
    library_id: string;
    library_version: string;
    manifest_hash: string;
  };
  candidates: SoundDesignCandidate[];
  dialogue_windows: Array<{
    in_frame: number;
    out_frame: number;
    evidence_ref: string;
  }>;
  congestion_events: Array<{
    event_id: string;
    type: SoundDesignCongestionType;
    in_frame: number;
    out_frame: number;
    severity: number;
    evidence_ref: string;
  }>;
  beat_evidence: SoundDesignBeatEvidence;
  policy: SoundDesignPolicy;
}

export interface SoundDesignCandidateDecision {
  candidate_id: string;
  status: "adopted" | "rejected";
  semantic_role: SfxSemanticRole;
  asset_id: string;
  semantic_anchor: SoundDesignCandidate["semantic_anchor"];
  resolved_frame: number | null;
  picture_timing_moved: false;
  snap: {
    applied: boolean;
    from_frame: number;
    to_frame: number;
    delta_frames: number;
    target_kind: "beat" | "downbeat" | null;
    reason: string;
  };
  congestion: {
    events: Array<{
      event_id: string;
      type: SoundDesignCongestionType;
      severity: number;
      weighted_penalty: number;
      evidence_ref: string;
    }>;
    total_penalty: number;
    reject_threshold: number;
  };
  score_breakdown: {
    semantic_score: number;
    congestion_penalty: number;
    total_score: number;
  };
  conflicts: string[];
  reasons: string[];
}

export interface SoundDesignDecision {
  version: "sound-design-decision/v1";
  project_id: string;
  base_timeline_version: string;
  timeline_fps: { num: number; den: number };
  solver: {
    id: "semantic-first-tempo-secondary";
    version: "1.0.0";
  };
  input_hashes: {
    request: string;
    timeline: string;
    library_manifest: string;
    music_analysis: string | null;
  };
  policy: SoundDesignPolicy;
  beat_evidence: SoundDesignBeatEvidence & {
    usable_for_snap: boolean;
    decision_reason: string;
  };
  decisions: SoundDesignCandidateDecision[];
  summary: {
    candidate_count: number;
    adopted_count: number;
    rejected_count: number;
    timeline_duration_seconds: number;
    density_limit: number;
  };
  decision_hash: string;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right, "en"))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function hashCanonicalJson(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex")}`;
}

export function hashSoundDesignRequest(request: SoundDesignRequest): string {
  return hashCanonicalJson(request);
}

export function hashSoundDesignDecision(
  decision: Omit<SoundDesignDecision, "decision_hash"> | SoundDesignDecision,
): string {
  const { decision_hash: _ignored, ...core } =
    decision as SoundDesignDecision;
  return hashCanonicalJson(core);
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function containsFrame(
  range: { in_frame: number; out_frame: number },
  frame: number,
): boolean {
  return frame >= range.in_frame && frame < range.out_frame;
}

function evaluateBeatEvidence(
  beat: SoundDesignBeatEvidence,
  policy: SoundDesignPolicy,
): { usable: boolean; reason: string } {
  if (beat.status !== "available" || beat.analysis_status !== "ready") {
    return {
      usable: false,
      reason: `beat_status_${beat.status}_${beat.analysis_status}`,
    };
  }
  if (!beat.analysis_path || !beat.content_hash) {
    return { usable: false, reason: "beat_analysis_hash_or_path_missing" };
  }
  if (
    beat.confidence === null
    || beat.confidence < policy.minimum_beat_confidence
  ) {
    return { usable: false, reason: "beat_confidence_below_threshold" };
  }
  if (beat.beat_frames.length === 0 && beat.downbeat_frames.length === 0) {
    return { usable: false, reason: "beat_grid_empty" };
  }
  return { usable: true, reason: "verified_beat_grid_available" };
}

function nearestBeat(
  frame: number,
  beat: SoundDesignBeatEvidence,
  maxDelta: number,
): { frame: number; kind: "beat" | "downbeat" } | undefined {
  return [
    ...beat.downbeat_frames.map((value) => ({
      frame: value,
      kind: "downbeat" as const,
    })),
    ...beat.beat_frames.map((value) => ({
      frame: value,
      kind: "beat" as const,
    })),
  ]
    .filter((item) => Math.abs(item.frame - frame) <= maxDelta)
    .sort((left, right) =>
      Math.abs(left.frame - frame) - Math.abs(right.frame - frame)
      || (left.kind === right.kind ? 0 : left.kind === "downbeat" ? -1 : 1)
      || left.frame - right.frame
    )[0];
}

function crossedBoundaryReason(
  request: SoundDesignRequest,
  fromFrame: number,
  toFrame: number,
): string | undefined {
  if (fromFrame === toFrame) return undefined;
  const low = Math.min(fromFrame, toFrame);
  const high = Math.max(fromFrame, toFrame);
  const pictureBoundary = request.congestion_events
    .filter((event) => event.type === "picture_edit")
    .flatMap((event) => [event.in_frame, event.out_frame])
    .some((frame) => frame > low && frame <= high);
  if (pictureBoundary) return "snap_crosses_picture_edit_boundary";
  const dialogueBoundary = request.dialogue_windows
    .flatMap((window) => [window.in_frame, window.out_frame])
    .some((frame) => frame > low && frame <= high);
  if (dialogueBoundary) return "snap_crosses_dialogue_boundary";
  return undefined;
}

function initialDecision(
  request: SoundDesignRequest,
  candidate: SoundDesignCandidate,
  beatUsable: { usable: boolean; reason: string },
): SoundDesignCandidateDecision {
  const anchorFrame = candidate.semantic_anchor.frame;
  const eventCongestion = request.congestion_events
    .filter((event) => containsFrame(event, anchorFrame))
    .map((event) => ({
      event_id: event.event_id,
      type: event.type,
      severity: event.severity,
      weighted_penalty: round(
        event.severity * request.policy.congestion_weights[event.type],
      ),
      evidence_ref: event.evidence_ref,
    }));
  const dialogueCongestion = request.dialogue_windows
    .filter((window) => containsFrame(window, anchorFrame))
    .map((window, index) => ({
      event_id: `dialogue-window-${String(index + 1).padStart(3, "0")}`,
      type: "dialogue" as const,
      severity: 1,
      weighted_penalty: request.policy.congestion_weights.dialogue,
      evidence_ref: window.evidence_ref,
    }));
  const congestionEvents = [...eventCongestion, ...dialogueCongestion]
    .sort((left, right) =>
      left.event_id.localeCompare(right.event_id, "en")
      || left.type.localeCompare(right.type, "en")
    );
  const congestionPenalty = round(
    congestionEvents.reduce(
      (total, event) => total + event.weighted_penalty,
      0,
    ),
  );
  const semanticScore = round(candidate.semantic_strength * 10);
  const totalScore = round(semanticScore - congestionPenalty);
  const conflicts = congestionEvents.map((event) =>
    event.type === "dialogue"
      ? `dialogue:${event.evidence_ref}`
      : `${event.type}:${event.event_id}`
  );
  const reasons: string[] = [];
  const hasSemanticPurpose = Boolean(candidate.semantic_purpose?.trim())
    && candidate.evidence_refs.length > 0;
  if (!hasSemanticPurpose) reasons.push("semantic_purpose_or_evidence_missing");
  if (
    hasSemanticPurpose
    && congestionPenalty >= request.policy.congestion_reject_threshold
  ) {
    reasons.push("congestion_threshold_exceeded");
  }
  if (
    hasSemanticPurpose
    && totalScore < request.policy.semantic_accept_threshold
  ) {
    reasons.push("semantic_score_below_threshold");
  }

  let resolvedFrame = anchorFrame;
  let snap: SoundDesignCandidateDecision["snap"] = {
    applied: false,
    from_frame: anchorFrame,
    to_frame: anchorFrame,
    delta_frames: 0,
    target_kind: null,
    reason: beatUsable.reason,
  };
  if (beatUsable.usable) {
    const target = nearestBeat(
      anchorFrame,
      request.beat_evidence,
      request.policy.max_snap_frames,
    );
    if (!target) {
      snap = { ...snap, reason: "no_beat_within_snap_bound" };
    } else if (
      target.frame < candidate.semantic_anchor.window.earliest_frame
      || target.frame > candidate.semantic_anchor.window.latest_frame
    ) {
      snap = { ...snap, reason: "snap_outside_semantic_window" };
    } else {
      const boundaryReason = crossedBoundaryReason(
        request,
        anchorFrame,
        target.frame,
      );
      if (boundaryReason) {
        snap = { ...snap, reason: boundaryReason };
      } else if (target.frame === anchorFrame) {
        snap = {
          ...snap,
          target_kind: target.kind,
          reason: "semantic_anchor_already_on_verified_grid",
        };
      } else {
        resolvedFrame = target.frame;
        snap = {
          applied: true,
          from_frame: anchorFrame,
          to_frame: target.frame,
          delta_frames: target.frame - anchorFrame,
          target_kind: target.kind,
          reason: "bounded_snap_to_verified_grid",
        };
      }
    }
  }

  const rejected = reasons.length > 0;
  return {
    candidate_id: candidate.candidate_id,
    status: rejected ? "rejected" : "adopted",
    semantic_role: candidate.semantic_role,
    asset_id: candidate.asset_id,
    semantic_anchor: structuredClone(candidate.semantic_anchor),
    resolved_frame: rejected ? null : resolvedFrame,
    picture_timing_moved: false,
    snap,
    congestion: {
      events: congestionEvents,
      total_penalty: congestionPenalty,
      reject_threshold: request.policy.congestion_reject_threshold,
    },
    score_breakdown: {
      semantic_score: semanticScore,
      congestion_penalty: congestionPenalty,
      total_score: totalScore,
    },
    conflicts,
    reasons,
  };
}

function densityLimit(request: SoundDesignRequest): {
  durationSeconds: number;
  limit: number;
} {
  const durationSeconds = round(
    request.timeline_duration_frames
    * request.timeline_fps.den
    / request.timeline_fps.num,
  );
  const scaled = Math.ceil(
    durationSeconds / 30 * request.policy.max_cues_per_30_seconds,
  );
  return {
    durationSeconds,
    limit: Math.max(
      0,
      Math.min(request.policy.absolute_max_cues, scaled),
    ),
  };
}

export function planSoundDesign(
  request: SoundDesignRequest,
): SoundDesignDecision {
  const candidateIds = new Set<string>();
  for (const candidate of request.candidates) {
    if (candidateIds.has(candidate.candidate_id)) {
      throw new Error(
        `sound-design candidate_id must be unique: ${candidate.candidate_id}`,
      );
    }
    candidateIds.add(candidate.candidate_id);
    if (
      candidate.semantic_anchor.frame
        < candidate.semantic_anchor.window.earliest_frame
      || candidate.semantic_anchor.frame
        > candidate.semantic_anchor.window.latest_frame
    ) {
      throw new Error(
        `${candidate.candidate_id} anchor is outside its semantic window`,
      );
    }
  }

  const beatUsable = evaluateBeatEvidence(
    request.beat_evidence,
    request.policy,
  );
  const initial = request.candidates.map((candidate) =>
    initialDecision(request, candidate, beatUsable)
  );
  const density = densityLimit(request);
  const selected: SoundDesignCandidateDecision[] = [];
  for (const item of initial
    .filter((candidate) => candidate.status === "adopted")
    .sort((left, right) =>
      right.score_breakdown.total_score - left.score_breakdown.total_score
      || left.candidate_id.localeCompare(right.candidate_id, "en")
    )) {
    if (selected.length >= density.limit) {
      item.status = "rejected";
      item.resolved_frame = null;
      item.reasons.push("duration_density_limit");
      continue;
    }
    const frame = item.resolved_frame!;
    const spacingConflict = selected.some((accepted) =>
      Math.abs(accepted.resolved_frame! - frame)
        < request.policy.minimum_spacing_frames
    );
    if (spacingConflict) {
      item.status = "rejected";
      item.resolved_frame = null;
      item.reasons.push("minimum_spacing_conflict");
      continue;
    }
    selected.push(item);
  }

  const decisions = initial.sort((left, right) =>
    left.candidate_id.localeCompare(right.candidate_id, "en")
  );
  const core = {
    version: "sound-design-decision/v1" as const,
    project_id: request.project_id,
    base_timeline_version: request.base_timeline_version,
    timeline_fps: structuredClone(request.timeline_fps),
    solver: {
      id: "semantic-first-tempo-secondary" as const,
      version: "1.0.0" as const,
    },
    input_hashes: {
      request: hashSoundDesignRequest(request),
      timeline: request.timeline_ref.content_hash,
      library_manifest: request.library.manifest_hash,
      music_analysis: request.beat_evidence.content_hash,
    },
    policy: structuredClone(request.policy),
    beat_evidence: {
      ...structuredClone(request.beat_evidence),
      usable_for_snap: beatUsable.usable,
      decision_reason: beatUsable.reason,
    },
    decisions,
    summary: {
      candidate_count: decisions.length,
      adopted_count: decisions.filter((item) => item.status === "adopted").length,
      rejected_count: decisions.filter((item) => item.status === "rejected").length,
      timeline_duration_seconds: density.durationSeconds,
      density_limit: density.limit,
    },
  };
  return {
    ...core,
    decision_hash: hashSoundDesignDecision(core),
  };
}

export interface SoundDesignDecisionFilePin {
  path: string;
  content_hash: string;
}

function cueIdForDecision(
  candidateId: string,
  resolvedFrame: number,
): string {
  return `SFX_${candidateId.toUpperCase().replaceAll("-", "_")}_${String(
    resolvedFrame,
  ).padStart(6, "0")}`;
}

export function projectSoundDesignDecisionToSfxCues(
  request: SoundDesignRequest,
  decision: SoundDesignDecision,
  decisionFile: SoundDesignDecisionFilePin,
): SfxCuesDoc {
  const requestHash = hashSoundDesignRequest(request);
  if (decision.input_hashes.request !== requestHash) {
    throw new Error(
      "sound-design decision input request hash does not match the request",
    );
  }
  if (decision.decision_hash !== hashSoundDesignDecision(decision)) {
    throw new Error("sound-design decision semantic hash has drifted");
  }
  for (const [label, expected, actual] of [
    ["project_id", request.project_id, decision.project_id],
    [
      "base_timeline_version",
      request.base_timeline_version,
      decision.base_timeline_version,
    ],
    ["timeline_fps.num", request.timeline_fps.num, decision.timeline_fps.num],
    ["timeline_fps.den", request.timeline_fps.den, decision.timeline_fps.den],
    [
      "timeline content hash",
      request.timeline_ref.content_hash,
      decision.input_hashes.timeline,
    ],
    [
      "library manifest hash",
      request.library.manifest_hash,
      decision.input_hashes.library_manifest,
    ],
  ] as Array<[string, unknown, unknown]>) {
    if (expected !== actual) {
      throw new Error(
        `sound-design ${label} drift expected=${String(expected)} actual=${String(actual)}`,
      );
    }
  }
  const candidates = new Map(
    request.candidates.map((candidate) => [candidate.candidate_id, candidate]),
  );
  const cues = decision.decisions
    .filter((item) => item.status === "adopted")
    .map((item): SfxCue => {
      if (item.resolved_frame === null) {
        throw new Error(
          `adopted sound-design candidate has no resolved frame: ${item.candidate_id}`,
        );
      }
      const candidate = candidates.get(item.candidate_id);
      if (!candidate) {
        throw new Error(
          `sound-design candidate is missing from request: ${item.candidate_id}`,
        );
      }
      if (
        candidate.semantic_role !== item.semantic_role
        || candidate.asset_id !== item.asset_id
      ) {
        throw new Error(
          `sound-design decision role/asset drift for ${item.candidate_id}`,
        );
      }
      return {
        cue_id: cueIdForDecision(item.candidate_id, item.resolved_frame),
        semantic_role: item.semantic_role,
        asset_id: item.asset_id,
        trigger_frame: item.resolved_frame,
        duration_frames: candidate.audio.duration_frames,
        source_range: structuredClone(candidate.audio.source_range),
        gain_db: candidate.audio.gain_db,
        fade_in_ms: candidate.audio.fade_in_ms,
        fade_out_ms: candidate.audio.fade_out_ms,
        tail: structuredClone(candidate.audio.tail),
        duck_group: candidate.audio.duck_group,
        ducking: structuredClone(candidate.audio.ducking),
        asset_pin: structuredClone(candidate.asset_pin),
        intent: candidate.semantic_purpose!,
        decision_pin: {
          candidate_id: item.candidate_id,
          decision_hash: decision.decision_hash,
          resolved_frame: item.resolved_frame,
          semantic_role: item.semantic_role,
          asset_id: item.asset_id,
        },
      };
    })
    .sort((left, right) =>
      left.trigger_frame - right.trigger_frame
      || left.cue_id.localeCompare(right.cue_id, "en")
    );
  if (cues.length === 0) {
    throw new Error("sound-design decision adopted no formal SFX cues");
  }
  return {
    version: "sfx-cues/v1",
    project_id: request.project_id,
    base_timeline_version: request.base_timeline_version,
    timeline_fps: structuredClone(request.timeline_fps),
    required: true,
    library: structuredClone(request.library),
    decision_ref: {
      path: decisionFile.path,
      content_hash: decisionFile.content_hash,
      decision_hash: decision.decision_hash,
      solver_id: decision.solver.id,
      solver_version: decision.solver.version,
    },
    cues,
  };
}
