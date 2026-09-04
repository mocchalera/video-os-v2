import type { ClipOutput, TimelineIR } from "../compiler/types.js";
import { evaluateFramingPolicy, type FramingPolicyDocument, type FramingPolicyResult } from "./framing-policy.js";
import { verifyReframeCandidateEvidence, type ReframeCandidateEvidence } from "./reframe.js";
import type {
  AppliedVisualIntent,
  RegisteredVisualIntent,
  SourceEvidencePin,
  VisualIntentRef,
} from "./types.js";
import type { ShotAnchorSourceIdentity } from "../compiler/shot-anchor-resolver.js";

export interface VisualProjectionOptions {
  framing_policy: FramingPolicyDocument;
  framing_policy_ref: string;
  source_identities: ReadonlyMap<string, ShotAnchorSourceIdentity>;
  reframe_candidates?: ReadonlyMap<string, ReframeCandidateEvidence>;
}

export class VisualIntentProjectionError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Visual intent projection failed: ${issues.join("; ")}`);
    this.name = "VisualIntentProjectionError";
  }
}

/**
 * Project only registered intents into the existing timeline/Studio contract.
 * A continuous intent changes the existing per-clip transform metadata. A
 * discrete intent emits an ordinary `cut` with provenance; no new transition
 * type or renderer is introduced.
 */
export function projectRegisteredVisualIntents(
  timeline: TimelineIR,
  intents: RegisteredVisualIntent[] | undefined,
  options: VisualProjectionOptions,
): TimelineIR {
  if (!intents || intents.length === 0) return timeline;
  if (options.framing_policy.version !== "framing-policy/v1") {
    throw new VisualIntentProjectionError(["framing policy version must be framing-policy/v1"]);
  }

  const orderedIntents = [...intents].sort((left, right) => left.intent_id.localeCompare(right.intent_id));
  const seenIntentIds = new Set<string>();
  const seenClipIds = new Set<string>();
  const plans = orderedIntents.map((intent) => {
    if (seenIntentIds.has(intent.intent_id)) {
      throw new VisualIntentProjectionError([`duplicate visual intent_id: ${intent.intent_id}`]);
    }
    seenIntentIds.add(intent.intent_id);
    const plan = preparePlan(timeline, intent, options);
    for (const clip of plan.transformedClips) {
      if (seenClipIds.has(clip.clip.clip_id)) {
        throw new VisualIntentProjectionError([`multiple visual intents target clip ${clip.clip.clip_id}; split the intent or register one transform`]);
      }
      seenClipIds.add(clip.clip.clip_id);
    }
    return plan;
  });

  for (const plan of plans) {
    for (const { clip, intent, framingResult } of plan.transformedClips) applyTransform(clip, intent, framingResult);
    if (plan.transition) {
      const transitions = timeline.transitions ?? [];
      const index = transitions.findIndex((transition) => transition.transition_id === plan.transition!.transition_id);
      if (index < 0) {
        throw new VisualIntentProjectionError([`visual intent transition ${plan.transition.transition_id} disappeared during projection`]);
      }
      transitions[index] = plan.transition;
      timeline.transitions = transitions;
    }
  }

  const applied: AppliedVisualIntent[] = plans.map((plan) => plan.applied);
  timeline.provenance.visual_framing = {
    policy: "registered-visual-intents/v1",
    framing_policy_ref: options.framing_policy_ref,
    framing_policy_id: options.framing_policy.policy_id,
    applied_intents: applied,
    source_av_preserved: true,
  };
  return timeline;
}

interface ProjectionPlan {
  transformedClips: Array<{ clip: ClipOutput; intent: RegisteredVisualIntent; framingResult: FramingPolicyResult }>;
  transition?: NonNullable<TimelineIR["transitions"]>[number];
  applied: AppliedVisualIntent;
}

interface ResolvedVisualClip {
  clip: ClipOutput;
  track_id: string;
}

function preparePlan(
  timeline: TimelineIR,
  intent: RegisteredVisualIntent,
  options: VisualProjectionOptions,
): ProjectionPlan {
  validateIntent(intent);
  if (intent.mode === "continuous_transform") {
    const target = resolveVisualRef(timeline, intent.target!, intent.intent_id, "target");
    assertVideoClip(target, intent.intent_id, "target");
    assertEvidenceForClip(intent.source_evidence, target, options, intent.intent_id);
    const framingResult = resolveFramingResult(timeline, intent, target, options);
    return {
      transformedClips: [{ clip: target.clip, intent, framingResult }],
      applied: appliedRecord(intent, [target.clip.clip_id], framingResult),
    };
  }

  const from = resolveVisualRef(timeline, intent.from!, intent.intent_id, "from");
  const to = resolveVisualRef(timeline, intent.to!, intent.intent_id, "to");
  assertVideoClip(from, intent.intent_id, "from");
  assertVideoClip(to, intent.intent_id, "to");
  if (from.clip.clip_id === to.clip.clip_id) {
    throw new VisualIntentProjectionError([`${intent.intent_id}: discrete_cut requires two distinct clips`]);
  }
  if (from.track_id !== to.track_id) {
    throw new VisualIntentProjectionError([`${intent.intent_id}: discrete_cut requires clips on the same video track`]);
  }
  const fromEnd = from.clip.timeline_in_frame + from.clip.timeline_duration_frames;
  if (fromEnd !== to.clip.timeline_in_frame) {
    throw new VisualIntentProjectionError([
      `${intent.intent_id}: discrete_cut requires an existing adjacent boundary; arbitrary intervals are not allowed`,
    ]);
  }
  assertEvidenceForClip(intent.source_evidence, from, options, intent.intent_id);
  assertEvidenceForClip(intent.source_evidence, to, options, intent.intent_id);
  const framingResult = resolveFramingResult(timeline, intent, to, options);
  const audioClipIds = timeline.tracks.audio.flatMap((track) => track.clips.map((clip) => clip.clip_id)).sort();
  const existingTransition = (timeline.transitions ?? []).find((transition) =>
    transition.from_clip_id === from.clip.clip_id &&
    transition.to_clip_id === to.clip.clip_id &&
    transition.track_id === from.track_id,
  );
  if (existingTransition && existingTransition.transition_type.toLowerCase() !== "cut") {
    throw new VisualIntentProjectionError([
      `${intent.intent_id}: existing transition ${existingTransition.transition_type} is not replaceable by a registered discrete cut`,
    ]);
  }
  const visualIntentMetadata = {
    policy: "registered-jump-cut/v1",
    intent_id: intent.intent_id,
    mode: "discrete_cut" as const,
    framing_mode: intent.framing_mode,
    reason: intent.reason,
    framing_result: structuredClone(framingResult),
    degraded: framingResult.degraded,
    ...(framingResult.degrade_reason ? { degrade_reason: framingResult.degrade_reason } : {}),
    climax: intent.climax,
    source_evidence: intent.source_evidence,
    source_av_identity: {
      from: sourceAvIdentity(from.clip, intent.source_evidence, options.source_identities),
      to: sourceAvIdentity(to.clip, intent.source_evidence, options.source_identities),
      audio_clip_ids_before_projection: audioClipIds,
      preserved: true,
    },
  };
  const transition = existingTransition
    ? {
        ...existingTransition,
        metadata: {
          ...(existingTransition.metadata ?? {}),
          visual_intent: visualIntentMetadata,
        },
      }
    : undefined;
  return {
    transformedClips: [{ clip: to.clip, intent, framingResult }],
    transition,
    applied: appliedRecord(
      intent,
      [from.clip.clip_id, to.clip.clip_id],
      framingResult,
      existingTransition ? "existing_cut" : "implicit_hard_cut",
    ),
  };
}

function validateIntent(intent: RegisteredVisualIntent): void {
  const issues: string[] = [];
  if (!intent || typeof intent !== "object") issues.push("intent must be an object");
  if (!intent?.intent_id?.trim()) issues.push("intent_id must be a non-empty string");
  if (intent?.policy !== "registered-visual-intent/v1") issues.push(`${intent?.intent_id ?? "intent"}: unsupported visual intent policy`);
  if (intent?.mode !== "continuous_transform" && intent?.mode !== "discrete_cut") issues.push(`${intent?.intent_id ?? "intent"}: mode must be continuous_transform or discrete_cut`);
  if (!intent?.reason?.trim()) issues.push(`${intent?.intent_id ?? "intent"}: reason must be non-empty`);
  if (!intent?.framing_mode || !["wide", "punch", "hold"].includes(intent.framing_mode)) issues.push(`${intent?.intent_id ?? "intent"}: framing_mode is required`);
  if (!Array.isArray(intent?.source_evidence) || intent.source_evidence.length === 0) issues.push(`${intent?.intent_id ?? "intent"}: source_evidence is required`);
  if (Array.isArray(intent?.source_evidence)) {
    intent.source_evidence.forEach((evidence, index) => validateSourceEvidence(evidence, `${intent.intent_id ?? "intent"}.source_evidence[${index}]`, issues));
  }
  if (intent?.mode === "continuous_transform" && (!intent.target || intent.from || intent.to)) issues.push(`${intent.intent_id}: continuous_transform requires target only`);
  if (intent?.mode === "discrete_cut" && (!intent.from || !intent.to || intent.target || !intent.climax)) issues.push(`${intent?.intent_id ?? "intent"}: discrete_cut requires from, to, and climax only`);
  if (intent?.mode === "discrete_cut" && intent.climax) validateClimax(intent.climax, `${intent.intent_id}.climax`, issues);
  if (intent?.confidence !== undefined && (!Number.isFinite(intent.confidence) || intent.confidence < 0 || intent.confidence > 1)) issues.push(`${intent.intent_id}: confidence must be between 0 and 1`);
  const hasCandidateRef = typeof intent?.reframe_candidate_ref === "string" && intent.reframe_candidate_ref.trim() !== "";
  const hasCandidateHash = typeof intent?.reframe_candidate_hash === "string" && intent.reframe_candidate_hash.trim() !== "";
  if (hasCandidateRef !== hasCandidateHash) issues.push(`${intent?.intent_id ?? "intent"}: reframe candidate ref and hash must be supplied together`);
  if (hasCandidateRef && intent?.framing_input) issues.push(`${intent.intent_id}: candidate adoption cannot also provide framing_input`);
  if (hasCandidateRef && intent?.transform) issues.push(`${intent.intent_id}: candidate adoption cannot also provide a raw transform`);
  if (!hasCandidateRef && !intent?.framing_input) issues.push(`${intent?.intent_id ?? "intent"}: framing_input is required when no candidate is adopted`);
  if (issues.length > 0) throw new VisualIntentProjectionError(issues);
}

function resolveVisualRef(
  timeline: TimelineIR,
  ref: VisualIntentRef,
  intentId: string,
  label: string,
): ResolvedVisualClip {
  const keys = [ref.clip_id, ref.candidate_ref, ref.segment_id].filter((value): value is string => typeof value === "string" && value.trim() !== "");
  if (keys.length !== 1) throw new VisualIntentProjectionError([`${intentId}: ${label} must contain exactly one clip_id, candidate_ref, or segment_id`]);
  const [key] = keys;
  const matches = timeline.tracks.video.flatMap((track) => track.clips
    .filter((clip) => (ref.clip_id && clip.clip_id === key) ||
      (ref.candidate_ref && clip.candidate_ref === key) ||
      (ref.segment_id && clip.segment_id === key))
    .map((clip) => ({ ...clip, track_id: track.track_id })));
  if (matches.length === 0) throw new VisualIntentProjectionError([`${intentId}: unknown ${label} reference ${key}`]);
  if (matches.length > 1) throw new VisualIntentProjectionError([`${intentId}: ambiguous ${label} reference ${key}`]);
  const [match] = matches;
  const original = timeline.tracks.video.flatMap((track) => track.clips).find((clip) => clip.clip_id === match.clip_id);
  if (!original) throw new VisualIntentProjectionError([`${intentId}: ${label} reference ${key} resolved to a missing clip`]);
  return { clip: original, track_id: match.track_id };
}

function assertVideoClip(clip: ResolvedVisualClip, intentId: string, label: string): void {
  if (clip.clip.media_kind === "audio" || clip.clip.source_capabilities?.has_video === false) {
    throw new VisualIntentProjectionError([`${intentId}: ${label} reference ${clip.clip.clip_id} is not video-capable`]);
  }
}

function assertEvidenceForClip(
  evidence: SourceEvidencePin[],
  clip: ResolvedVisualClip,
  options: VisualProjectionOptions,
  intentId: string,
): void {
  const candidateEvidence = evidence.filter((item) =>
    item.asset_id === clip.clip.asset_id && item.segment_id === clip.clip.segment_id &&
    item.source_range.src_in_us >= clip.clip.src_in_us && item.source_range.src_out_us <= clip.clip.src_out_us,
  );
  if (candidateEvidence.length === 0) {
    throw new VisualIntentProjectionError([`${intentId}: source evidence does not cover clip ${clip.clip.clip_id} identity/range`]);
  }
  const identity = options.source_identities.get(clip.clip.asset_id);
  if (!identity) throw new VisualIntentProjectionError([`${intentId}: source identity is unavailable for asset ${clip.clip.asset_id}`]);
  const matchingEvidence = candidateEvidence.filter((item) => item.source_content_hash === identity.source_content_hash);
  if (matchingEvidence.length === 0) {
    throw new VisualIntentProjectionError([`${intentId}: source content hash mismatch for asset ${clip.clip.asset_id}`]);
  }
  if (identity.source_fingerprint && !matchingEvidence.some((item) => item.source_fingerprint === identity.source_fingerprint)) {
    throw new VisualIntentProjectionError([`${intentId}: source fingerprint mismatch for asset ${clip.clip.asset_id}`]);
  }
}

function resolveFramingResult(
  timeline: TimelineIR,
  intent: RegisteredVisualIntent,
  clip: ResolvedVisualClip,
  options: VisualProjectionOptions,
): FramingPolicyResult {
  if (intent.reframe_candidate_ref) {
    const candidate = options.reframe_candidates?.get(intent.reframe_candidate_ref);
    if (!candidate) {
      throw new VisualIntentProjectionError([
        `${intent.intent_id}: unknown reframe candidate artifact ${intent.reframe_candidate_ref}`,
      ]);
    }
    let verified: ReframeCandidateEvidence;
    try {
      verified = verifyReframeCandidateEvidence(candidate);
    } catch (error) {
      throw new VisualIntentProjectionError([
        `${intent.intent_id}: reframe candidate verification failed: ${error instanceof Error ? error.message : "unknown evidence error"}`,
      ]);
    }
    if (verified.candidate_hash !== intent.reframe_candidate_hash) {
      throw new VisualIntentProjectionError([`${intent.intent_id}: reframe candidate hash does not match the Blueprint adoption pin`]);
    }
    if (verified.framing_policy.id !== options.framing_policy.policy_id || verified.framing_policy.version !== options.framing_policy.version) {
      throw new VisualIntentProjectionError([`${intent.intent_id}: reframe candidate policy does not match the compiler policy artifact`]);
    }
    if (verified.result.requested_mode !== intent.framing_mode) {
      throw new VisualIntentProjectionError([`${intent.intent_id}: reframe candidate requested_mode does not match the Blueprint framing_mode`]);
    }
    if (verified.framing_output.width !== timeline.sequence.width || verified.framing_output.height !== timeline.sequence.height) {
      throw new VisualIntentProjectionError([`${intent.intent_id}: reframe candidate output dimensions do not match the canonical sequence`]);
    }
    assertCandidateSourceMatchesClip(verified, clip, options, intent.intent_id);
    return structuredClone(verified.result);
  }

  const framingInput = intent.framing_input;
  if (!framingInput) {
    throw new VisualIntentProjectionError([`${intent.intent_id}: framing_input is required before compiler projection`]);
  }
  if (framingInput.output.width !== timeline.sequence.width || framingInput.output.height !== timeline.sequence.height) {
    throw new VisualIntentProjectionError([`${intent.intent_id}: framing_input output dimensions do not match the canonical sequence`]);
  }
  return evaluateFramingPolicy({
    observations: framingInput.observations,
    output: framingInput.output,
    mode: intent.framing_mode!,
    ...(intent.transform ? { requested_transform: intent.transform } : {}),
  }, options.framing_policy);
}

function assertCandidateSourceMatchesClip(
  candidate: ReframeCandidateEvidence,
  clip: ResolvedVisualClip,
  options: VisualProjectionOptions,
  intentId: string,
): void {
  const source = candidate.source_identity;
  if (source.asset_id !== clip.clip.asset_id || source.segment_id !== clip.clip.segment_id ||
      source.source_range.src_in_us !== clip.clip.src_in_us || source.source_range.src_out_us !== clip.clip.src_out_us) {
    throw new VisualIntentProjectionError([`${intentId}: reframe candidate source identity/range does not exactly match clip ${clip.clip.clip_id}`]);
  }
  const identity = options.source_identities.get(clip.clip.asset_id);
  if (!identity || source.source_content_hash !== identity.source_content_hash) {
    throw new VisualIntentProjectionError([`${intentId}: reframe candidate source content hash does not match the canonical source identity`]);
  }
  if (identity.source_fingerprint && source.source_fingerprint !== identity.source_fingerprint) {
    throw new VisualIntentProjectionError([`${intentId}: reframe candidate source fingerprint does not match the canonical source identity`]);
  }
}

function applyTransform(clip: ClipOutput, intent: RegisteredVisualIntent, framingResult: FramingPolicyResult): void {
  const transform = framingResult.transform;
  const metadata = clip.metadata ?? {};
  delete metadata.zoom;
  delete metadata.crop;
  delete metadata.position;
  if (transform.zoom !== undefined) metadata.zoom = transform.zoom;
  if (transform.crop !== undefined) metadata.crop = { ...transform.crop };
  if (transform.position !== undefined) metadata.position = { ...transform.position };
  metadata.visual_framing = {
    policy: "registered-visual-intents/v1",
    intent_id: intent.intent_id,
    mode: intent.mode,
    framing_mode: intent.framing_mode,
    reason: intent.reason,
    confidence: framingResult.confidence,
    degraded: framingResult.degraded,
    framing_result: structuredClone(framingResult),
    ...(framingResult.degrade_reason ? { degrade_reason: framingResult.degrade_reason } : {}),
    source_evidence: intent.source_evidence,
    ...(intent.reframe_candidate_ref ? { reframe_candidate_ref: intent.reframe_candidate_ref } : {}),
    ...(intent.reframe_candidate_hash ? { reframe_candidate_hash: intent.reframe_candidate_hash } : {}),
    ...(intent.climax ? { climax: intent.climax } : {}),
  };
  clip.metadata = metadata;
}

function sourceAvIdentity(
  clip: ClipOutput,
  evidence: SourceEvidencePin[],
  sourceIdentities: ReadonlyMap<string, ShotAnchorSourceIdentity>,
): Record<string, unknown> {
  const expectedHash = sourceIdentities.get(clip.asset_id)?.source_content_hash;
  const matching = evidence.find((item) =>
    item.asset_id === clip.asset_id && item.segment_id === clip.segment_id &&
    (!expectedHash || item.source_content_hash === expectedHash),
  );
  return {
    asset_id: clip.asset_id,
    segment_id: clip.segment_id,
    source_content_hash: matching?.source_content_hash,
    ...(matching?.source_fingerprint ? { source_fingerprint: matching.source_fingerprint } : {}),
    source_range: { src_in_us: clip.src_in_us, src_out_us: clip.src_out_us },
    ...(clip.source_capabilities ? { source_capabilities: clip.source_capabilities } : {}),
    source_capabilities_status: clip.source_capabilities ? "known" : "unknown_legacy",
  };
}

function validateSourceEvidence(value: unknown, path: string, issues: string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  const evidence = value as Partial<SourceEvidencePin>;
  if (typeof evidence.asset_id !== "string" || !evidence.asset_id.trim()) issues.push(`${path}.asset_id must be a non-empty string`);
  if (typeof evidence.segment_id !== "string" || !evidence.segment_id.trim()) issues.push(`${path}.segment_id must be a non-empty string`);
  if (typeof evidence.source_content_hash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(evidence.source_content_hash)) {
    issues.push(`${path}.source_content_hash must be sha256:<64 lowercase hex characters>`);
  }
  const range = evidence.source_range;
  if (!range || !Number.isSafeInteger(range.src_in_us) || !Number.isSafeInteger(range.src_out_us) ||
      range.src_in_us < 0 || range.src_out_us <= range.src_in_us) {
    issues.push(`${path}.source_range must be a non-empty non-negative range`);
  }
  if (evidence.source_fingerprint !== undefined && (typeof evidence.source_fingerprint !== "string" || !evidence.source_fingerprint.trim())) {
    issues.push(`${path}.source_fingerprint must be a non-empty string when supplied`);
  }
}

function validateClimax(value: unknown, path: string, issues: string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  const climax = value as { basis?: unknown; evidence_refs?: unknown };
  if (climax.basis !== "person_size" && climax.basis !== "composition" && climax.basis !== "meaning") {
    issues.push(`${path}.basis must be person_size, composition, or meaning`);
  }
  if (!Array.isArray(climax.evidence_refs) || climax.evidence_refs.length === 0 || climax.evidence_refs.some((ref) => typeof ref !== "string" || !ref.trim())) {
    issues.push(`${path}.evidence_refs must contain non-empty strings`);
  }
}

function appliedRecord(
  intent: RegisteredVisualIntent,
  clipIds: string[],
  framingResult: FramingPolicyResult,
  transitionEffect?: AppliedVisualIntent["transition_effect"],
): AppliedVisualIntent {
  return {
    intent_id: intent.intent_id,
    mode: intent.mode,
    clip_ids: [...clipIds],
    source_evidence: structuredClone(intent.source_evidence),
    framing_result: structuredClone(framingResult),
    confidence: framingResult.confidence,
    degraded: framingResult.degraded,
    reason: intent.reason,
    ...(intent.reframe_candidate_ref ? { reframe_candidate_ref: intent.reframe_candidate_ref } : {}),
    ...(intent.reframe_candidate_hash ? { reframe_candidate_hash: intent.reframe_candidate_hash } : {}),
    ...(intent.climax ? { climax: structuredClone(intent.climax) } : {}),
    ...(transitionEffect ? { transition_effect: transitionEffect } : {}),
  };
}
