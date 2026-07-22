import type {
  BgmAudioFormat,
  BgmPackTrack,
  CatalogTrack,
} from "./pack-types.js";

export const BGM_SCORE_WEIGHTS = {
  semantic_fit: 30,
  editorial_family_arc_fit: 20,
  speech_friendliness: 15,
  energy_tempo_fit: 15,
  duration_edit_ending_fit: 10,
  beat_downbeat_confidence: 5,
  diversity_recent_use: 5,
} as const;

export type BgmScoreComponent = keyof typeof BGM_SCORE_WEIGHTS;
export type DeterministicBgmScoreComponent = Exclude<
  BgmScoreComponent,
  "semantic_fit" | "diversity_recent_use"
>;
export type BgmSemanticStatus = "available" | "degraded" | "unavailable";
export type BgmSelectionRequestMode = "auto" | "suggest";
export type BgmVocalPresence = BgmPackTrack["vocal_presence"];

export interface BgmSelectorRequirements {
  families: string[];
  intensities: Array<"low" | "high">;
  use_cases: string[];
  minimum_speech_friendliness: number;
  vocal_presence_allowed: BgmVocalPresence[];
  duration_us: number;
  target_energy?: number;
  target_bpm?: number;
  speech_ratio?: number;
  required_rights_scopes?: string[];
  require_licensed_rights?: boolean;
  require_verified_hash?: boolean;
  explicit_exclusions?: string[];
}

export interface BgmSelectorAnalysis {
  status: "ready" | "degraded" | "failed" | "unavailable";
  input_content_hash?: string;
  duration_us?: number;
  bpm?: number | null;
  beat_confidence?: number | null;
  downbeat_confidence?: number | null;
  speech_band_masking_score?: number | null;
  speech_friendliness?: number | null;
  energy?: number | null;
  ending_resolution?: number | null;
}

export interface BgmSelectorCandidateInput {
  track: CatalogTrack;
  expected_content_hash?: string;
  integrity_ok?: boolean;
  installed?: boolean;
  readable?: boolean;
  codec_supported?: boolean;
  rights_allowed?: boolean;
  licensed_rights?: boolean;
  rights_hash_verified?: boolean;
  permitted_rights_scopes?: string[];
  explicit_exclusion_matches?: string[];
  has_sufficient_authored_metadata?: boolean;
  analysis?: BgmSelectorAnalysis;
  semantic_similarity?: number | null;
  usage_count_90d?: number;
  usage_penalty?: number;
}

export interface BgmSemanticChannel {
  status: BgmSemanticStatus;
  model_revision?: string | null;
  warnings?: string[];
}

export interface BgmSelectorInput {
  requirements: BgmSelectorRequirements;
  candidates: BgmSelectorCandidateInput[];
  semantic_channel: BgmSemanticChannel;
  selection_mode?: BgmSelectionRequestMode;
  suggestion_limit?: number;
}

export type BgmHardGateId =
  | "installed"
  | "pack_integrity"
  | "content_hash"
  | "rights_permission"
  | "rights_license"
  | "rights_hash"
  | "vocal_policy"
  | "codec_support"
  | "audio_readable"
  | "duration_fit"
  | "brief_exclusion"
  | "analysis_fallback";

export interface BgmHardGateEvidence {
  gate: BgmHardGateId;
  passed: boolean;
  reason: string;
}

export interface BgmScoreBreakdown {
  semantic_fit: number;
  editorial_family_arc_fit: number;
  speech_friendliness: number;
  energy_tempo_fit: number;
  duration_edit_ending_fit: number;
  beat_downbeat_confidence: number;
  diversity_recent_use: number;
}

export interface BgmScoreEvidence {
  component: BgmScoreComponent;
  base_weight: number;
  raw_fit: number;
  awarded_points: number;
  redistributed_points: number;
  reason: string;
}

export interface BgmSelectorCandidateResult {
  track_id: string;
  content_hash: string;
  pack_id: string;
  pack_version: string;
  status: "ranked" | "rejected";
  rank: number | null;
  total_score: number | null;
  score_breakdown: BgmScoreBreakdown;
  hard_gate_evidence: BgmHardGateEvidence[];
  score_evidence: BgmScoreEvidence[];
  rejection_reasons: string[];
  explanation: string;
}

export interface BgmRedistributionAllocation {
  component: DeterministicBgmScoreComponent;
  added_points: number;
}

export interface BgmRedistributionTrace {
  applied: boolean;
  source_component: "semantic_fit";
  source_weight: 30;
  reason: string | null;
  allocations: BgmRedistributionAllocation[];
}

export interface BgmSelectionDecision {
  mode: "auto" | "suggest";
  selected: BgmSelectorCandidateResult | null;
  suggestions: BgmSelectorCandidateResult[];
  minimum_score: number;
  minimum_margin: number;
  reason: string;
}

export interface BgmSelectorResult {
  strategy_id: "bgm-score-v1";
  candidates: BgmSelectorCandidateResult[];
  ranked: BgmSelectorCandidateResult[];
  rejected: BgmSelectorCandidateResult[];
  top_two_margin: number | null;
  redistribution_trace: BgmRedistributionTrace;
  semantic_channel: BgmSemanticChannel;
  decision: BgmSelectionDecision;
  warnings: string[];
}

const ZERO_BREAKDOWN: BgmScoreBreakdown = {
  semantic_fit: 0,
  editorial_family_arc_fit: 0,
  speech_friendliness: 0,
  energy_tempo_fit: 0,
  duration_edit_ending_fit: 0,
  beat_downbeat_confidence: 0,
  diversity_recent_use: 0,
};

const REDISTRIBUTED_COMPONENTS: DeterministicBgmScoreComponent[] = [
  "editorial_family_arc_fit",
  "speech_friendliness",
  "energy_tempo_fit",
  "duration_edit_ending_fit",
  "beat_downbeat_confidence",
];

const SUPPORTED_FORMATS = new Set<BgmAudioFormat>([
  "wav",
  "flac",
  "aiff",
  "mp3",
  "m4a",
  "ogg",
]);

function clamp01(value: number | null | undefined, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function normalizeLabel(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\s/_-]+/g, " ")
    .trim();
}

function overlapRatio(required: string[], actual: string[]): number {
  if (required.length === 0) return 1;
  const actualLabels = new Set(actual.map(normalizeLabel));
  const uniqueRequired = [...new Set(required.map(normalizeLabel))];
  const matches = uniqueRequired.filter((value) => actualLabels.has(value)).length;
  return matches / uniqueRequired.length;
}

function axis(track: BgmPackTrack, name: string, fallback = 0): number {
  return clamp01(track.axes[name]?.value, fallback);
}

function hasAuthoredFallback(track: BgmPackTrack): boolean {
  return Boolean(
    track.family
      && track.intensity
      && track.duration_us > 0
      && track.axes.energy
      && track.axes.speech_friendliness
      && track.axes.ending_resolution,
  );
}

function durationCanFit(track: BgmPackTrack, targetDurationUs: number): boolean {
  if (track.duration_us >= targetDurationUs) return true;
  const availableExtension = track.loop_windows.reduce((largest, loop) => {
    const repetitions = Math.max(0, loop.max_repetitions ?? 1);
    return Math.max(largest, Math.max(0, loop.out_us - loop.in_us) * repetitions);
  }, 0);
  return track.duration_us + availableExtension >= targetDurationUs;
}

function explicitExclusionHits(
  requirements: BgmSelectorRequirements,
  candidate: BgmSelectorCandidateInput,
): string[] {
  if (candidate.explicit_exclusion_matches?.length) {
    return [...new Set(candidate.explicit_exclusion_matches)].sort();
  }
  const terms = requirements.explicit_exclusions ?? [];
  if (terms.length === 0) return [];
  const track = candidate.track.track;
  const descriptors = [
    track.track_id,
    track.title,
    track.family,
    track.intensity,
    track.vocal_presence,
    ...track.use_cases,
    ...track.instruments,
  ].map(normalizeLabel);
  return [...new Set(terms.filter((term) => {
    const normalized = normalizeLabel(term);
    return normalized.length > 0 && descriptors.some((descriptor) => descriptor.includes(normalized));
  }))].sort();
}

function buildHardGateEvidence(
  requirements: BgmSelectorRequirements,
  candidate: BgmSelectorCandidateInput,
): BgmHardGateEvidence[] {
  const track = candidate.track.track;
  const actualHash = track.full_mix.content_hash;
  const expectedHash = candidate.expected_content_hash;
  const requiredScopes = requirements.required_rights_scopes ?? [];
  const permittedScopes = new Set(candidate.permitted_rights_scopes ?? []);
  const missingScopes = requiredScopes.filter((scope) => !permittedScopes.has(scope));
  const requirePermission = requiredScopes.length > 0
    || requirements.require_licensed_rights === true
    || requirements.require_verified_hash === true;
  const exclusionHits = explicitExclusionHits(requirements, candidate);
  const analysisFailed = candidate.analysis?.status === "failed"
    || candidate.analysis?.status === "unavailable";
  const fallbackAvailable = candidate.has_sufficient_authored_metadata
    ?? hasAuthoredFallback(track);
  const codecSupported = candidate.codec_supported
    ?? SUPPORTED_FORMATS.has(track.full_mix.format);
  const rightsPermitted = candidate.rights_allowed
    ?? (!requirePermission && missingScopes.length === 0);

  return [
    {
      gate: "installed",
      passed: candidate.installed !== false,
      reason: candidate.installed === false ? "track is not installed" : "track is installed",
    },
    {
      gate: "pack_integrity",
      passed: candidate.integrity_ok !== false,
      reason: candidate.integrity_ok === false ? "pack or audio integrity verification failed" : "pack integrity is verified",
    },
    {
      gate: "content_hash",
      passed: (!expectedHash || expectedHash === actualHash)
        && (!candidate.analysis?.input_content_hash || candidate.analysis.input_content_hash === actualHash),
      reason: expectedHash && expectedHash !== actualHash
        ? "full-mix content hash does not match the requested hash"
        : candidate.analysis?.input_content_hash && candidate.analysis.input_content_hash !== actualHash
          ? "analysis input hash does not match the full mix"
          : "content hashes match",
    },
    {
      gate: "rights_permission",
      passed: rightsPermitted && missingScopes.length === 0,
      reason: !rightsPermitted
        ? "rights evaluation did not permit this output"
        : missingScopes.length > 0
          ? `required rights scopes are missing: ${missingScopes.slice().sort().join(", ")}`
          : "required rights scopes are permitted",
    },
    {
      gate: "rights_license",
      passed: requirements.require_licensed_rights !== true || candidate.licensed_rights === true,
      reason: requirements.require_licensed_rights === true && candidate.licensed_rights !== true
        ? "licensed rights evidence is required"
        : "license requirement passes",
    },
    {
      gate: "rights_hash",
      passed: requirements.require_verified_hash !== true || candidate.rights_hash_verified === true,
      reason: requirements.require_verified_hash === true && candidate.rights_hash_verified !== true
        ? "hash-verified rights evidence is required"
        : "rights hash requirement passes",
    },
    {
      gate: "vocal_policy",
      passed: requirements.vocal_presence_allowed.includes(track.vocal_presence),
      reason: requirements.vocal_presence_allowed.includes(track.vocal_presence)
        ? `vocal presence ${track.vocal_presence} is allowed`
        : `vocal presence ${track.vocal_presence} conflicts with the brief`,
    },
    {
      gate: "codec_support",
      passed: codecSupported,
      reason: codecSupported ? `codec ${track.full_mix.format} is supported` : `codec ${track.full_mix.format} is unsupported`,
    },
    {
      gate: "audio_readable",
      passed: candidate.readable !== false,
      reason: candidate.readable === false ? "audio file is unreadable" : "audio file is readable",
    },
    {
      gate: "duration_fit",
      passed: durationCanFit(track, requirements.duration_us),
      reason: durationCanFit(track, requirements.duration_us)
        ? "duration is covered by the master or approved loop windows"
        : "duration is insufficient and no approved loop path can cover it",
    },
    {
      gate: "brief_exclusion",
      passed: exclusionHits.length === 0,
      reason: exclusionHits.length === 0
        ? "no explicit brief exclusion matched"
        : `explicit brief exclusions matched: ${exclusionHits.join(", ")}`,
    },
    {
      gate: "analysis_fallback",
      passed: !analysisFailed || fallbackAvailable,
      reason: analysisFailed && !fallbackAvailable
        ? "analysis failed and authored fallback metadata is insufficient"
        : analysisFailed
          ? "analysis is unavailable but authored fallback metadata is sufficient"
          : "analysis is usable",
    },
  ];
}

function scoreEditorial(requirements: BgmSelectorRequirements, track: BgmPackTrack): { fit: number; reason: string } {
  const family = overlapRatio(requirements.families, [track.family]);
  const useCase = overlapRatio(requirements.use_cases, track.use_cases);
  const intensity = requirements.intensities.length === 0
    ? 1
    : requirements.intensities.includes(track.intensity) ? 1 : 0;
  const fit = 0.55 * family + 0.25 * useCase + 0.2 * intensity;
  return {
    fit,
    reason: `family ${round(family)}, use-case ${round(useCase)}, intensity ${round(intensity)} fit`,
  };
}

function scoreSpeech(
  requirements: BgmSelectorRequirements,
  track: BgmPackTrack,
  analysis?: BgmSelectorAnalysis,
): { fit: number; reason: string } {
  const authored = axis(track, "speech_friendliness");
  const analyzed = analysis?.speech_friendliness;
  const maskingDerived = typeof analysis?.speech_band_masking_score === "number"
    ? 1 - clamp01(analysis.speech_band_masking_score)
    : undefined;
  const values = [authored, analyzed, maskingDerived]
    .filter((value): value is number => typeof value === "number")
    .map((value) => clamp01(value));
  const friendliness = values.reduce((sum, value) => sum + value, 0) / values.length;
  const dialogueImportance = 0.5 + 0.5 * clamp01(requirements.speech_ratio, 1);
  const fit = friendliness * dialogueImportance + (1 - dialogueImportance);
  return {
    fit,
    reason: `speech friendliness ${round(friendliness)} for speech ratio ${round(clamp01(requirements.speech_ratio, 1))}; requested minimum ${round(requirements.minimum_speech_friendliness)}`,
  };
}

function scoreEnergyTempo(
  requirements: BgmSelectorRequirements,
  track: BgmPackTrack,
  analysis?: BgmSelectorAnalysis,
): { fit: number; reason: string } {
  const targetEnergy = clamp01(requirements.target_energy, 0.5);
  const analyzedEnergy = typeof analysis?.energy === "number" ? clamp01(analysis.energy) : null;
  const actualEnergy = analyzedEnergy === null
    ? axis(track, "energy", 0.5)
    : (axis(track, "energy", analyzedEnergy) + analyzedEnergy) / 2;
  const energyFit = 1 - Math.abs(targetEnergy - actualEnergy);
  const hasTempo = typeof requirements.target_bpm === "number"
    && typeof analysis?.bpm === "number";
  const tempoFit = hasTempo
    ? clamp01(1 - Math.abs(requirements.target_bpm! - analysis!.bpm!) / 60)
    : energyFit;
  const fit = hasTempo ? energyFit * 0.7 + tempoFit * 0.3 : energyFit;
  return {
    fit,
    reason: hasTempo
      ? `energy fit ${round(energyFit)} and tempo fit ${round(tempoFit)}`
      : `energy fit ${round(energyFit)}; tempo target unavailable`,
  };
}

function nearestEditFit(track: BgmPackTrack, targetDurationUs: number): number {
  if (track.edit_points_us.length === 0) return 0;
  const nearest = Math.min(...track.edit_points_us.map((point) => Math.abs(point - targetDurationUs)));
  return clamp01(1 - nearest / Math.max(1, targetDurationUs));
}

function scoreDurationEnding(
  requirements: BgmSelectorRequirements,
  track: BgmPackTrack,
  analysis?: BgmSelectorAnalysis,
): { fit: number; reason: string } {
  const directCoverage = Math.min(1, track.duration_us / requirements.duration_us);
  const loopCoverage = durationCanFit(track, requirements.duration_us) ? 1 : directCoverage;
  const editFit = nearestEditFit(track, requirements.duration_us);
  const authoredEnding = axis(track, "ending_resolution");
  const ending = typeof analysis?.ending_resolution === "number"
    ? (authoredEnding + clamp01(analysis.ending_resolution)) / 2
    : authoredEnding;
  const fit = 0.45 * loopCoverage + 0.2 * editFit + 0.35 * ending;
  return {
    fit,
    reason: `coverage ${round(loopCoverage)}, edit-point fit ${round(editFit)}, ending resolution ${round(ending)}`,
  };
}

function scoreBeat(track: BgmPackTrack, analysis?: BgmSelectorAnalysis): { fit: number; reason: string } {
  const values = [analysis?.beat_confidence, analysis?.downbeat_confidence]
    .filter((value): value is number => typeof value === "number")
    .map((value) => clamp01(value));
  const fit = values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : axis(track, "beat_prominence") * 0.5;
  return {
    fit,
    reason: values.length > 0
      ? `mean beat/downbeat confidence ${round(fit)}`
      : `analysis confidence unavailable; conservative authored beat fallback ${round(fit)}`,
  };
}

function redistributionTrace(status: BgmSemanticStatus): BgmRedistributionTrace {
  if (status !== "unavailable") {
    return {
      applied: false,
      source_component: "semantic_fit",
      source_weight: 30,
      reason: null,
      allocations: [],
    };
  }
  const deterministicWeight = REDISTRIBUTED_COMPONENTS.reduce(
    (sum, component) => sum + BGM_SCORE_WEIGHTS[component],
    0,
  );
  let allocated = 0;
  const allocations = REDISTRIBUTED_COMPONENTS.map((component, index) => {
    const addedPoints = index === REDISTRIBUTED_COMPONENTS.length - 1
      ? round(30 - allocated)
      : round(30 * BGM_SCORE_WEIGHTS[component] / deterministicWeight);
    allocated = round(allocated + addedPoints);
    return { component, added_points: addedPoints };
  });
  return {
    applied: true,
    source_component: "semantic_fit",
    source_weight: 30,
    reason: "semantic channel unavailable; weight redistributed proportionally across deterministic fit components",
    allocations,
  };
}

function scoreCandidate(
  requirements: BgmSelectorRequirements,
  candidate: BgmSelectorCandidateInput,
  semanticStatus: BgmSemanticStatus,
  trace: BgmRedistributionTrace,
): Pick<BgmSelectorCandidateResult, "total_score" | "score_breakdown" | "score_evidence" | "explanation"> {
  const track = candidate.track.track;
  const semanticFit = semanticStatus === "unavailable"
    ? 0
    : clamp01(candidate.semantic_similarity);
  const editorial = scoreEditorial(requirements, track);
  const speech = scoreSpeech(requirements, track, candidate.analysis);
  const energyTempo = scoreEnergyTempo(requirements, track, candidate.analysis);
  const durationEnding = scoreDurationEnding(requirements, track, candidate.analysis);
  const beat = scoreBeat(track, candidate.analysis);
  const usagePenalty = clamp01(
    candidate.usage_penalty,
    Math.min(1, Math.max(0, candidate.usage_count_90d ?? 0) * 0.2),
  );
  const fits: Record<BgmScoreComponent, { fit: number; reason: string }> = {
    semantic_fit: {
      fit: semanticFit,
      reason: semanticStatus === "unavailable"
        ? "semantic channel unavailable"
        : candidate.semantic_similarity == null
          ? "semantic score missing"
          : `brief-to-track semantic similarity ${round(semanticFit)}`,
    },
    editorial_family_arc_fit: editorial,
    speech_friendliness: speech,
    energy_tempo_fit: energyTempo,
    duration_edit_ending_fit: durationEnding,
    beat_downbeat_confidence: beat,
    diversity_recent_use: {
      fit: 1 - usagePenalty,
      reason: `90-day usage count ${Math.max(0, candidate.usage_count_90d ?? 0)}; penalty ${round(usagePenalty)}`,
    },
  };

  const breakdown = Object.fromEntries(
    (Object.keys(BGM_SCORE_WEIGHTS) as BgmScoreComponent[]).map((component) => [
      component,
      round(clamp01(fits[component].fit) * BGM_SCORE_WEIGHTS[component]),
    ]),
  ) as unknown as BgmScoreBreakdown;

  const allocationMap = new Map(trace.allocations.map((allocation) => [allocation.component, allocation.added_points]));
  const evidence = (Object.keys(BGM_SCORE_WEIGHTS) as BgmScoreComponent[]).map((component): BgmScoreEvidence => {
    const rawFit = clamp01(fits[component].fit);
    const redistributedPoints = round(rawFit * (allocationMap.get(component as DeterministicBgmScoreComponent) ?? 0));
    return {
      component,
      base_weight: BGM_SCORE_WEIGHTS[component],
      raw_fit: round(rawFit),
      awarded_points: breakdown[component],
      redistributed_points: redistributedPoints,
      reason: fits[component].reason,
    };
  });
  const total = round(evidence.reduce(
    (sum, component) => sum + component.awarded_points + component.redistributed_points,
    0,
  ));
  const strongest = [...evidence]
    .sort((left, right) => right.raw_fit - left.raw_fit || left.component.localeCompare(right.component))[0];
  const weakest = [...evidence]
    .filter((item) => item.component !== "semantic_fit" || semanticStatus !== "unavailable")
    .sort((left, right) => left.raw_fit - right.raw_fit || left.component.localeCompare(right.component))[0];
  const explanation = `${strongest.component} is strongest (${strongest.reason}); ${weakest.component} is the main limitation (${weakest.reason}).`;
  return { total_score: total, score_breakdown: breakdown, score_evidence: evidence, explanation };
}

function compareRanked(left: BgmSelectorCandidateResult, right: BgmSelectorCandidateResult): number {
  return (right.total_score ?? 0) - (left.total_score ?? 0)
    || left.track_id.localeCompare(right.track_id)
    || left.content_hash.localeCompare(right.content_hash)
    || left.pack_id.localeCompare(right.pack_id)
    || left.pack_version.localeCompare(right.pack_version);
}

function makeRejected(
  candidate: BgmSelectorCandidateInput,
  gates: BgmHardGateEvidence[],
): BgmSelectorCandidateResult {
  const failed = gates.filter((gate) => !gate.passed);
  return {
    track_id: candidate.track.track.track_id,
    content_hash: candidate.track.track.full_mix.content_hash,
    pack_id: candidate.track.pack_id,
    pack_version: candidate.track.pack_version,
    status: "rejected",
    rank: null,
    total_score: null,
    score_breakdown: { ...ZERO_BREAKDOWN },
    hard_gate_evidence: gates,
    score_evidence: [],
    rejection_reasons: failed.map((gate) => `${gate.gate}: ${gate.reason}`),
    explanation: `Rejected before scoring: ${failed.map((gate) => gate.reason).join("; ")}.`,
  };
}

function makeRanked(
  requirements: BgmSelectorRequirements,
  candidate: BgmSelectorCandidateInput,
  semanticStatus: BgmSemanticStatus,
  trace: BgmRedistributionTrace,
  gates: BgmHardGateEvidence[],
): BgmSelectorCandidateResult {
  const score = scoreCandidate(requirements, candidate, semanticStatus, trace);
  return {
    track_id: candidate.track.track.track_id,
    content_hash: candidate.track.track.full_mix.content_hash,
    pack_id: candidate.track.pack_id,
    pack_version: candidate.track.pack_version,
    status: "ranked",
    rank: null,
    total_score: score.total_score,
    score_breakdown: score.score_breakdown,
    hard_gate_evidence: gates,
    score_evidence: score.score_evidence,
    rejection_reasons: [],
    explanation: score.explanation,
  };
}

/**
 * Ranks verified catalog tracks without filesystem, network, time, or random inputs.
 * Callers retain authority over artifact timestamps and legal rights evaluation.
 */
export function selectBgmDeterministically(input: BgmSelectorInput): BgmSelectorResult {
  if (!Number.isSafeInteger(input.requirements.duration_us) || input.requirements.duration_us <= 0) {
    throw new Error("BGM selector duration_us must be a positive safe integer");
  }
  const trace = redistributionTrace(input.semantic_channel.status);
  const ranked: BgmSelectorCandidateResult[] = [];
  const rejected: BgmSelectorCandidateResult[] = [];

  for (const candidate of input.candidates) {
    const gates = buildHardGateEvidence(input.requirements, candidate);
    if (gates.some((gate) => !gate.passed)) {
      rejected.push(makeRejected(candidate, gates));
    } else {
      ranked.push(makeRanked(
        input.requirements,
        candidate,
        input.semantic_channel.status,
        trace,
        gates,
      ));
    }
  }

  ranked.sort(compareRanked);
  ranked.forEach((candidate, index) => {
    candidate.rank = index + 1;
  });
  rejected.sort((left, right) => left.track_id.localeCompare(right.track_id)
    || left.content_hash.localeCompare(right.content_hash)
    || left.pack_id.localeCompare(right.pack_id));
  const topTwoMargin = ranked.length >= 2
    ? round((ranked[0].total_score ?? 0) - (ranked[1].total_score ?? 0))
    : null;
  const strictThreshold = input.semantic_channel.status !== "available";
  const minimumScore = strictThreshold ? 78 : 70;
  const minimumMargin = strictThreshold ? 12 : 8;
  const requestedMode = input.selection_mode ?? "suggest";
  const top = ranked[0] ?? null;
  const enoughMargin = ranked.length >= 2 && (topTwoMargin ?? 0) >= minimumMargin;
  const qualifies = top !== null
    && (top.total_score ?? 0) >= minimumScore
    && enoughMargin;
  const autoSelected = requestedMode === "auto" && qualifies ? top : null;
  const mode: "auto" | "suggest" = autoSelected ? "auto" : "suggest";
  const requestedSuggestionLimit = input.suggestion_limit ?? 3;
  const suggestionLimit = Number.isFinite(requestedSuggestionLimit)
    ? Math.max(1, Math.floor(requestedSuggestionLimit))
    : 3;
  const reason = requestedMode !== "auto"
    ? "suggest mode requested"
    : top === null
      ? "no candidate passed all hard gates"
      : (top.total_score ?? 0) < minimumScore
        ? `top score ${top.total_score} is below ${minimumScore}`
        : !enoughMargin
          ? ranked.length < 2
            ? "auto selection requires at least two ranked candidates to establish a margin"
            : `top-two margin ${topTwoMargin} is below ${minimumMargin}`
          : `top score and margin meet ${minimumScore}/${minimumMargin} auto thresholds`;
  const warnings = [...new Set([
    ...(input.semantic_channel.warnings ?? []),
    ...(input.semantic_channel.status === "unavailable"
      ? ["semantic channel unavailable; deterministic weights redistributed"]
      : []),
    ...(input.semantic_channel.status === "degraded"
      ? ["semantic channel degraded; stricter auto thresholds applied"]
      : []),
  ])].sort();

  return {
    strategy_id: "bgm-score-v1",
    candidates: [...ranked, ...rejected],
    ranked,
    rejected,
    top_two_margin: topTwoMargin,
    redistribution_trace: trace,
    semantic_channel: {
      status: input.semantic_channel.status,
      model_revision: input.semantic_channel.model_revision ?? null,
      warnings: [...new Set(input.semantic_channel.warnings ?? [])].sort(),
    },
    decision: {
      mode,
      selected: autoSelected,
      suggestions: ranked.slice(0, suggestionLimit),
      minimum_score: minimumScore,
      minimum_margin: minimumMargin,
      reason,
    },
    warnings,
  };
}
