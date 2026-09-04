import type {
  BlueprintPolicyReference,
  BlueprintPolicyRefs,
  BlueprintSequence,
  BlueprintShot,
  BlueprintShotAnchor,
  EditBlueprint,
} from "../compiler/types.js";
import type {
  RegisteredVisualIntent,
  SourceEvidencePin,
  VisualClimax,
  VisualIntentRef,
  VisualTransform,
} from "../visual/types.js";
import type { FramingBox, FramingObservation, FramingPoint } from "../visual/framing-policy.js";

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const POLICY_KEYS = [
  "composition_policy_ref",
  "vertical_composition_policy_ref",
  "retention_policy_ref",
  "caption_policy_ref",
  "platform_safe_zone_profile_ref",
  "audio_delivery_profile_ref",
  "sfx_library_ref",
] as const;
const V2_ROOT_KEYS = new Set([
  "version", "project_id", "created_at", "decision_runtime", "source_media",
  "sequence_goals", "beats", "pacing", "music_policy", "caption_policy",
  "dialogue_policy", "transition_policy", "ending_policy", "rejection_rules",
  "story_arc", "resolved_profile", "resolved_policy", "active_editing_skills",
  "dedupe_rules", "quality_targets", "trim_policy", "duration_policy",
  "still_duration_policy", "timeline_order", "track_layout", "longform_plan",
  "policy_refs", "visual_intents", "hook_sequence", "body_sequence", "hook", "body",
  "timeline_operations", "audio_mix_policy",
]);

export class BlueprintSanitizationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Blueprint sanitization failed: ${issues.join("; ")}`);
    this.name = "BlueprintSanitizationError";
  }
}

export interface BlueprintSanitizationResult {
  blueprint: EditBlueprint;
  migrated_from?: "1";
}

export function sanitizeBlueprint(input: unknown): BlueprintSanitizationResult {
  if (!isRecord(input)) throw new BlueprintSanitizationError(["blueprint must be an object"]);
  const version = input.version;
  if (version !== "2") {
    // v1 remains intentionally untouched. In particular, it must not acquire a
    // locked Hook or inferred source anchor merely by being loaded.
    return { blueprint: structuredClone(input) as EditBlueprint };
  }

  const issues: string[] = [];
  const output = structuredClone(input) as Record<string, unknown>;
  for (const key of Object.keys(input)) if (!V2_ROOT_KEYS.has(key)) issues.push(`${key} is unknown`);
  const refs = sanitizePolicyRefs(input.policy_refs, issues);
  if (refs) output.policy_refs = refs;
  const visualIntents = sanitizeVisualIntents(input.visual_intents, issues);
  if (visualIntents) output.visual_intents = visualIntents;
  normalizeSequenceAlias(output, "hook_sequence", "hook", issues);
  normalizeSequenceAlias(output, "body_sequence", "body", issues);
  if (issues.length > 0) throw new BlueprintSanitizationError(issues);
  return { blueprint: output as EditBlueprint };
}

export const sanitizeBlueprintV2 = sanitizeBlueprint;

function normalizeSequenceAlias(
  output: Record<string, unknown>,
  canonicalKey: "hook_sequence" | "body_sequence",
  aliasKey: "hook" | "body",
  issues: string[],
): void {
  const canonicalInput = output[canonicalKey];
  const aliasInput = output[aliasKey];
  if (canonicalInput === undefined && aliasInput === undefined) return;
  const canonical = canonicalInput === undefined
    ? sanitizeSequence(aliasInput, aliasKey, issues)
    : sanitizeSequence(canonicalInput, canonicalKey, issues);
  const alias = canonicalInput !== undefined && aliasInput !== undefined
    ? sanitizeSequence(aliasInput, aliasKey, issues)
    : undefined;
  if (canonicalInput !== undefined && aliasInput !== undefined && canonical && alias && !sameJson(canonical, alias)) {
    issues.push(`${canonicalKey} conflicts with alias ${aliasKey}`);
  }
  if (canonical) output[canonicalKey] = canonical;
  delete output[aliasKey];
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sanitizePolicyRefs(value: unknown, issues: string[]): BlueprintPolicyRefs | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    issues.push("policy_refs must be an object");
    return undefined;
  }
  const unknown = Object.keys(value).filter((key) => !POLICY_KEYS.includes(key as typeof POLICY_KEYS[number]));
  for (const key of unknown) issues.push(`policy_refs.${key} is unknown`);
  const result: BlueprintPolicyRefs = {};
  for (const key of POLICY_KEYS) {
    if (value[key] === undefined) continue;
    const ref = sanitizePolicyReference(value[key], `policy_refs.${key}`, issues);
    if (ref) result[key] = ref;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function sanitizePolicyReference(value: unknown, path: string, issues: string[]): BlueprintPolicyReference | undefined {
  if (typeof value === "string" && value.trim()) return { ref: value.trim() };
  if (!isRecord(value)) {
    issues.push(`${path} must be a non-empty reference or reference object`);
    return undefined;
  }
  const allowed = new Set(["ref", "version", "source_hash", "profile_hash"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) issues.push(`${path}.${key} is unknown`);
  if (typeof value.ref !== "string" || !value.ref.trim()) issues.push(`${path}.ref must be a non-empty string`);
  const out: BlueprintPolicyReference = { ref: String(value.ref ?? "").trim() };
  for (const key of ["version", "source_hash", "profile_hash"] as const) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== "string" || !value[key].trim()) issues.push(`${path}.${key} must be a non-empty string`);
    else if ((key === "source_hash" || key === "profile_hash") && !SHA256.test(value[key])) issues.push(`${path}.${key} must be sha256:<64 lowercase hex characters>`);
    else out[key] = value[key].trim();
  }
  return out.ref ? out : undefined;
}

function sanitizeVisualIntents(value: unknown, issues: string[]): RegisteredVisualIntent[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    issues.push("visual_intents must be an array");
    return undefined;
  }
  return value.flatMap((item, index) => sanitizeVisualIntent(item, `visual_intents[${index}]`, issues) ?? []);
}

function sanitizeVisualIntent(value: unknown, path: string, issues: string[]): RegisteredVisualIntent | undefined {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return undefined;
  }
  const allowed = new Set([
    "intent_id", "policy", "mode", "framing_mode", "reason", "target", "from", "to",
    "transform", "framing_input", "reframe_candidate_ref", "reframe_candidate_hash",
    "source_evidence", "climax", "confidence", "degraded", "degrade_reason",
  ]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) issues.push(`${path}.${key} is unknown`);
  if (typeof value.intent_id !== "string" || !value.intent_id.trim()) issues.push(`${path}.intent_id must be a non-empty string`);
  if (value.policy !== "registered-visual-intent/v1") issues.push(`${path}.policy must be registered-visual-intent/v1`);
  if (value.mode !== "continuous_transform" && value.mode !== "discrete_cut") issues.push(`${path}.mode must be continuous_transform or discrete_cut`);
  if (value.framing_mode !== undefined && !["wide", "punch", "hold"].includes(String(value.framing_mode))) issues.push(`${path}.framing_mode must be wide, punch, or hold`);
  if (value.framing_mode === undefined) issues.push(`${path}.framing_mode is required for policy evaluation`);
  if (typeof value.reason !== "string" || !value.reason.trim()) issues.push(`${path}.reason must be a non-empty string`);
  const target = value.target === undefined ? undefined : sanitizeVisualIntentRef(value.target, `${path}.target`, issues);
  const from = value.from === undefined ? undefined : sanitizeVisualIntentRef(value.from, `${path}.from`, issues);
  const to = value.to === undefined ? undefined : sanitizeVisualIntentRef(value.to, `${path}.to`, issues);
  if (value.mode === "continuous_transform" && (!target || from || to)) issues.push(`${path} continuous_transform requires target only`);
  if (value.mode === "discrete_cut" && (!from || !to || target !== undefined)) {
    if (!from || !to) issues.push(`${path} discrete_cut requires from and to`);
    if (target !== undefined) issues.push(`${path} discrete_cut cannot contain target`);
  }
  const transform = value.transform === undefined ? undefined : sanitizeVisualTransform(value.transform, `${path}.transform`, issues);
  const framingInput = value.framing_input === undefined
    ? undefined
    : sanitizeVisualFramingInput(value.framing_input, `${path}.framing_input`, issues);
  const candidateRef = value.reframe_candidate_ref === undefined
    ? undefined
    : sanitizeCandidateReference(value.reframe_candidate_ref, `${path}.reframe_candidate_ref`, issues);
  const candidateHash = value.reframe_candidate_hash === undefined
    ? undefined
    : sanitizeCandidateHash(value.reframe_candidate_hash, `${path}.reframe_candidate_hash`, issues);
  if (candidateRef && !candidateHash) issues.push(`${path}.reframe_candidate_hash is required when reframe_candidate_ref is supplied`);
  if (candidateHash && !candidateRef) issues.push(`${path}.reframe_candidate_ref is required when reframe_candidate_hash is supplied`);
  if (candidateRef && framingInput) issues.push(`${path} cannot combine a vision candidate with framing_input`);
  if (!candidateRef && !framingInput) issues.push(`${path} requires framing_input unless a vision candidate is adopted`);
  if (candidateRef && transform) issues.push(`${path}.transform cannot override an adopted vision candidate result`);
  if (!Array.isArray(value.source_evidence) || value.source_evidence.length === 0) {
    issues.push(`${path}.source_evidence must contain at least one item`);
  }
  const sourceEvidence = Array.isArray(value.source_evidence)
    ? value.source_evidence.flatMap((item, index) => sanitizeSourceEvidence(item, `${path}.source_evidence[${index}]`, issues) ?? [])
    : [];
  const climax = value.climax === undefined ? undefined : sanitizeVisualClimax(value.climax, `${path}.climax`, issues);
  if (value.mode === "discrete_cut" && !climax) issues.push(`${path}.climax is required for discrete_cut`);
  if (value.confidence !== undefined && (typeof value.confidence !== "number" || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1)) issues.push(`${path}.confidence must be between 0 and 1`);
  if (value.degraded !== undefined && typeof value.degraded !== "boolean") issues.push(`${path}.degraded must be boolean`);
  if (value.degrade_reason !== undefined && (typeof value.degrade_reason !== "string" || !value.degrade_reason.trim())) issues.push(`${path}.degrade_reason must be a non-empty string`);
  return {
    intent_id: String(value.intent_id ?? "").trim(),
    policy: "registered-visual-intent/v1",
    mode: value.mode as RegisteredVisualIntent["mode"],
    ...(value.framing_mode === undefined ? {} : { framing_mode: value.framing_mode as RegisteredVisualIntent["framing_mode"] }),
    reason: String(value.reason ?? "").trim(),
    ...(target ? { target } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(transform ? { transform } : {}),
    ...(framingInput ? { framing_input: framingInput } : {}),
    ...(candidateRef ? { reframe_candidate_ref: candidateRef } : {}),
    ...(candidateHash ? { reframe_candidate_hash: candidateHash } : {}),
    source_evidence: sourceEvidence,
    ...(climax ? { climax } : {}),
    ...(value.confidence === undefined ? {} : { confidence: Number(value.confidence) }),
    ...(value.degraded === undefined ? {} : { degraded: value.degraded as boolean }),
    ...(value.degrade_reason === undefined ? {} : { degrade_reason: String(value.degrade_reason).trim() }),
  };
}

function sanitizeCandidateReference(value: unknown, path: string, issues: string[]): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    issues.push(`${path} must be a non-empty project-relative path`);
    return undefined;
  }
  if (value.includes("\\") || pathIsAbsolute(value) || value.split("/").includes("..")) {
    issues.push(`${path} must be a contained project-relative path`);
  }
  return value.trim();
}

function sanitizeCandidateHash(value: unknown, path: string, issues: string[]): string | undefined {
  if (typeof value !== "string" || !SHA256.test(value)) issues.push(`${path} must be sha256:<64 lowercase hex characters>`);
  return typeof value === "string" ? value.trim() : undefined;
}

function pathIsAbsolute(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

function sanitizeVisualFramingInput(value: unknown, path: string, issues: string[]): { observations: FramingObservation[]; output: { width: number; height: number } } | undefined {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return undefined;
  }
  for (const key of Object.keys(value)) if (!["observations", "output"].includes(key)) issues.push(`${path}.${key} is unknown`);
  if (!Array.isArray(value.observations) || value.observations.length === 0) issues.push(`${path}.observations must contain at least one observation`);
  const observations = Array.isArray(value.observations)
    ? value.observations.flatMap((item, index) => sanitizeFramingObservation(item, `${path}.observations[${index}]`, issues) ?? [])
    : [];
  const output = isRecord(value.output) ? value.output : undefined;
  if (!output) issues.push(`${path}.output must be an object`);
  if (!isPositiveInteger(output?.width)) issues.push(`${path}.output.width must be a positive integer`);
  if (!isPositiveInteger(output?.height)) issues.push(`${path}.output.height must be a positive integer`);
  return {
    observations,
    output: { width: Number(output?.width ?? 0), height: Number(output?.height ?? 0) },
  };
}

function sanitizeFramingObservation(value: unknown, path: string, issues: string[]): FramingObservation | undefined {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return undefined;
  }
  for (const key of Object.keys(value)) if (!["time_us", "time_seconds", "person", "head", "hands"].includes(key)) issues.push(`${path}.${key} is unknown`);
  for (const key of ["time_us", "time_seconds"] as const) if (value[key] !== undefined && !isFiniteNumber(value[key])) issues.push(`${path}.${key} must be finite`);
  const person = value.person === undefined ? undefined : sanitizeFramingBox(value.person, `${path}.person`, issues);
  const head = value.head === undefined ? undefined : sanitizeFramingBox(value.head, `${path}.head`, issues);
  if (value.hands !== undefined && !Array.isArray(value.hands)) issues.push(`${path}.hands must be an array`);
  const hands = Array.isArray(value.hands)
    ? value.hands.flatMap((item, index) => sanitizeFramingPoint(item, `${path}.hands[${index}]`, issues) ?? [])
    : [];
  return {
    ...(value.time_us === undefined ? {} : { time_us: Number(value.time_us) }),
    ...(value.time_seconds === undefined ? {} : { time_seconds: Number(value.time_seconds) }),
    ...(person ? { person } : {}),
    ...(head ? { head } : {}),
    hands,
  };
}

function sanitizeFramingBox(value: unknown, path: string, issues: string[]): FramingBox | undefined {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return undefined;
  }
  const allowed = ["x", "y", "width", "height", "confidence", "yaw_radians", "eye_x", "eye_y"];
  for (const key of Object.keys(value)) if (!allowed.includes(key)) issues.push(`${path}.${key} is unknown`);
  for (const key of ["x", "y", "width", "height", "confidence"] as const) if (!isFiniteNumber(value[key])) issues.push(`${path}.${key} must be finite`);
  if (isFiniteNumber(value.x) && (value.x < 0 || value.x > 1)) issues.push(`${path}.x must be between 0 and 1`);
  if (isFiniteNumber(value.y) && (value.y < 0 || value.y > 1)) issues.push(`${path}.y must be between 0 and 1`);
  if (isFiniteNumber(value.width) && (value.width <= 0 || value.width > 1)) issues.push(`${path}.width must be greater than 0 and at most 1`);
  if (isFiniteNumber(value.height) && (value.height <= 0 || value.height > 1)) issues.push(`${path}.height must be greater than 0 and at most 1`);
  if (isFiniteNumber(value.confidence) && (value.confidence < 0 || value.confidence > 1)) issues.push(`${path}.confidence must be between 0 and 1`);
  for (const key of ["yaw_radians", "eye_x", "eye_y"] as const) if (value[key] !== undefined && !isFiniteNumber(value[key])) issues.push(`${path}.${key} must be finite`);
  return {
    x: Number(value.x ?? 0), y: Number(value.y ?? 0), width: Number(value.width ?? 0), height: Number(value.height ?? 0), confidence: Number(value.confidence ?? 0),
    ...(value.yaw_radians === undefined ? {} : { yaw_radians: Number(value.yaw_radians) }),
    ...(value.eye_x === undefined ? {} : { eye_x: Number(value.eye_x) }),
    ...(value.eye_y === undefined ? {} : { eye_y: Number(value.eye_y) }),
  };
}

function sanitizeFramingPoint(value: unknown, path: string, issues: string[]): FramingPoint | undefined {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return undefined;
  }
  for (const key of Object.keys(value)) if (!["x", "y", "confidence"].includes(key)) issues.push(`${path}.${key} is unknown`);
  for (const key of ["x", "y", "confidence"] as const) if (!isFiniteNumber(value[key])) issues.push(`${path}.${key} must be finite`);
  if (isFiniteNumber(value.x) && (value.x < 0 || value.x > 1)) issues.push(`${path}.x must be between 0 and 1`);
  if (isFiniteNumber(value.y) && (value.y < 0 || value.y > 1)) issues.push(`${path}.y must be between 0 and 1`);
  if (isFiniteNumber(value.confidence) && (value.confidence < 0 || value.confidence > 1)) issues.push(`${path}.confidence must be between 0 and 1`);
  return { x: Number(value.x ?? 0), y: Number(value.y ?? 0), confidence: Number(value.confidence ?? 0) };
}

function sanitizeVisualIntentRef(value: unknown, path: string, issues: string[]): VisualIntentRef | undefined {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return undefined;
  }
  const allowed = new Set(["clip_id", "candidate_ref", "segment_id"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) issues.push(`${path}.${key} is unknown`);
  const keys = ["clip_id", "candidate_ref", "segment_id"] as const;
  const present = keys.filter((key) => typeof value[key] === "string" && value[key].trim());
  if (present.length !== 1) issues.push(`${path} must contain exactly one of clip_id, candidate_ref, or segment_id`);
  return present.length === 1 ? { [present[0]]: String(value[present[0]]).trim() } as VisualIntentRef : undefined;
}

function sanitizeVisualTransform(value: unknown, path: string, issues: string[]): VisualTransform | undefined {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return undefined;
  }
  const allowed = new Set(["zoom", "crop", "position"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) issues.push(`${path}.${key} is unknown`);
  if (Object.keys(value).length === 0) issues.push(`${path} must contain zoom, crop, or position`);
  if (value.zoom !== undefined && (typeof value.zoom !== "number" || !Number.isFinite(value.zoom) || value.zoom < 0.1 || value.zoom > 8)) issues.push(`${path}.zoom must be between 0.1 and 8`);
  const crop = value.crop === undefined ? undefined : sanitizeTransformBox(value.crop, `${path}.crop`, issues, true);
  const position = value.position === undefined ? undefined : sanitizeTransformPosition(value.position, `${path}.position`, issues);
  return {
    ...(value.zoom === undefined ? {} : { zoom: Number(value.zoom) }),
    ...(crop ? { crop } : {}),
    ...(position ? { position } : {}),
  };
}

function sanitizeTransformBox(value: unknown, path: string, issues: string[], requireNonNegative: boolean): VisualTransform["crop"] | undefined {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return undefined;
  }
  for (const key of Object.keys(value)) if (!["x", "y", "width", "height"].includes(key)) issues.push(`${path}.${key} is unknown`);
  for (const key of ["x", "y", "width", "height"] as const) if (typeof value[key] !== "number" || !Number.isFinite(value[key])) issues.push(`${path}.${key} must be finite`);
  if (requireNonNegative && (Number(value.x) < 0 || Number(value.y) < 0)) issues.push(`${path}.x and y must be non-negative`);
  if (Number(value.width) <= 0 || Number(value.height) <= 0) issues.push(`${path}.width and height must be positive`);
  return { x: Number(value.x), y: Number(value.y), width: Number(value.width), height: Number(value.height) };
}

function sanitizeTransformPosition(value: unknown, path: string, issues: string[]): VisualTransform["position"] | undefined {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return undefined;
  }
  for (const key of Object.keys(value)) if (!["x", "y"].includes(key)) issues.push(`${path}.${key} is unknown`);
  if (typeof value.x !== "number" || !Number.isFinite(value.x) || typeof value.y !== "number" || !Number.isFinite(value.y)) issues.push(`${path}.x and y must be finite`);
  return { x: Number(value.x), y: Number(value.y) };
}

function sanitizeSourceEvidence(value: unknown, path: string, issues: string[]): SourceEvidencePin | undefined {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return undefined;
  }
  const allowed = new Set(["asset_id", "segment_id", "source_content_hash", "source_range", "source_fingerprint"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) issues.push(`${path}.${key} is unknown`);
  for (const key of ["asset_id", "segment_id"] as const) if (typeof value[key] !== "string" || !value[key].trim()) issues.push(`${path}.${key} must be a non-empty string`);
  if (typeof value.source_content_hash !== "string" || !SHA256.test(value.source_content_hash)) issues.push(`${path}.source_content_hash must be sha256:<64 lowercase hex characters>`);
  const range = isRecord(value.source_range) ? value.source_range : undefined;
  if (!range) issues.push(`${path}.source_range must be an object`);
  for (const key of ["src_in_us", "src_out_us"] as const) if (!isNonNegativeInteger(range?.[key])) issues.push(`${path}.source_range.${key} must be a non-negative integer`);
  if (isNonNegativeInteger(range?.src_in_us) && isNonNegativeInteger(range?.src_out_us) && range.src_out_us <= range.src_in_us) issues.push(`${path}.source_range must be non-empty`);
  if (value.source_fingerprint !== undefined && (typeof value.source_fingerprint !== "string" || !value.source_fingerprint.trim())) issues.push(`${path}.source_fingerprint must be a non-empty string`);
  return {
    asset_id: String(value.asset_id ?? "").trim(),
    segment_id: String(value.segment_id ?? "").trim(),
    source_content_hash: String(value.source_content_hash ?? ""),
    source_range: { src_in_us: Number(range?.src_in_us ?? 0), src_out_us: Number(range?.src_out_us ?? 0) },
    ...(value.source_fingerprint === undefined ? {} : { source_fingerprint: String(value.source_fingerprint).trim() }),
  };
}

function sanitizeVisualClimax(value: unknown, path: string, issues: string[]): VisualClimax | undefined {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return undefined;
  }
  for (const key of Object.keys(value)) if (!["basis", "evidence_refs"].includes(key)) issues.push(`${path}.${key} is unknown`);
  if (!["person_size", "composition", "meaning"].includes(String(value.basis))) issues.push(`${path}.basis must be person_size, composition, or meaning`);
  if (!Array.isArray(value.evidence_refs) || value.evidence_refs.length === 0 || value.evidence_refs.some((item) => typeof item !== "string" || !item.trim())) issues.push(`${path}.evidence_refs must contain non-empty strings`);
  return {
    basis: value.basis as VisualClimax["basis"],
    evidence_refs: Array.isArray(value.evidence_refs) ? value.evidence_refs.map((item) => String(item).trim()) : [],
  };
}

function sanitizeSequence(value: unknown, path: string, issues: string[]): BlueprintSequence | undefined {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return undefined;
  }
  for (const key of Object.keys(value)) {
    if (!["sequence_id", "locked", "lock_revision", "shots"].includes(key)) issues.push(`${path}.${key} is unknown`);
  }
  if (typeof value.sequence_id !== "string" || !value.sequence_id.trim()) issues.push(`${path}.sequence_id must be a non-empty string`);
  if (value.locked !== undefined && typeof value.locked !== "boolean") issues.push(`${path}.locked must be boolean`);
  if (value.lock_revision !== undefined && !isNonNegativeInteger(value.lock_revision)) issues.push(`${path}.lock_revision must be a non-negative integer`);
  if (!Array.isArray(value.shots)) {
    issues.push(`${path}.shots must be an array`);
    return undefined;
  }
  const shots = value.shots.flatMap((shot, index) => sanitizeShot(shot, `${path}.shots[${index}]`, issues) ?? []);
  return {
    sequence_id: String(value.sequence_id ?? "").trim(),
    ...(value.locked === undefined ? {} : { locked: value.locked }),
    ...(value.lock_revision === undefined ? {} : { lock_revision: value.lock_revision }),
    shots,
  };
}

function sanitizeShot(value: unknown, path: string, issues: string[]): BlueprintShot | undefined {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return undefined;
  }
  for (const key of Object.keys(value)) {
    if (!["shot_id", "beat_id", "scene_type", "shot_anchor", "candidate_ref"].includes(key)) issues.push(`${path}.${key} is unknown`);
  }
  if (typeof value.shot_id !== "string" || !value.shot_id.trim()) issues.push(`${path}.shot_id must be a non-empty string`);
  const hasAnchor = value.shot_anchor !== undefined;
  const hasCandidate = value.candidate_ref !== undefined;
  if (hasAnchor === hasCandidate) issues.push(`${path} must contain exactly one of shot_anchor or candidate_ref`);
  const anchor = hasAnchor ? sanitizeAnchor(value.shot_anchor, `${path}.shot_anchor`, issues) : undefined;
  if (hasCandidate && (typeof value.candidate_ref !== "string" || !value.candidate_ref.trim())) issues.push(`${path}.candidate_ref must be a non-empty string`);
  return {
    shot_id: String(value.shot_id ?? "").trim(),
    ...(typeof value.beat_id === "string" ? { beat_id: value.beat_id.trim() } : {}),
    ...(typeof value.scene_type === "string" ? { scene_type: value.scene_type.trim() } : {}),
    ...(anchor ? { shot_anchor: anchor } : {}),
    ...(typeof value.candidate_ref === "string" ? { candidate_ref: value.candidate_ref.trim() } : {}),
  };
}

function sanitizeAnchor(value: unknown, path: string, issues: string[]): BlueprintShotAnchor | undefined {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return undefined;
  }
  const required = ["anchor_id", "asset_id", "source_content_hash", "segment_id", "src_in_us", "src_out_us"];
  const allowed = new Set([...required, "transcript_item_ids", "source_start_us", "source_end_us"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) issues.push(`${path}.${key} is unknown`);
  for (const key of ["anchor_id", "asset_id", "segment_id"] as const) if (typeof value[key] !== "string" || !value[key].trim()) issues.push(`${path}.${key} must be a non-empty string`);
  if (typeof value.source_content_hash !== "string" || !SHA256.test(value.source_content_hash)) issues.push(`${path}.source_content_hash must be sha256:<64 lowercase hex characters>`);
  for (const key of ["src_in_us", "src_out_us", "source_start_us", "source_end_us"] as const) if (value[key] !== undefined && !isNonNegativeInteger(value[key])) issues.push(`${path}.${key} must be a non-negative integer`);
  if (!isNonNegativeInteger(value.src_in_us) || !isNonNegativeInteger(value.src_out_us) || Number(value.src_out_us) <= Number(value.src_in_us)) issues.push(`${path} source range must be non-empty`);
  const hasSourceStart = value.source_start_us !== undefined;
  const hasSourceEnd = value.source_end_us !== undefined;
  if (hasSourceStart !== hasSourceEnd) issues.push(`${path} source evidence range must provide both source_start_us and source_end_us`);
  if (hasSourceStart && hasSourceEnd && isNonNegativeInteger(value.source_start_us) && isNonNegativeInteger(value.source_end_us)) {
    if (value.source_end_us <= value.source_start_us) issues.push(`${path} source evidence range must be non-empty`);
    if (isNonNegativeInteger(value.src_in_us) && value.source_start_us < value.src_in_us) issues.push(`${path}.source_start_us must be within the shot range`);
    if (isNonNegativeInteger(value.src_out_us) && value.source_end_us > value.src_out_us) issues.push(`${path}.source_end_us must be within the shot range`);
  }
  if (value.transcript_item_ids !== undefined && (!Array.isArray(value.transcript_item_ids) || value.transcript_item_ids.some((item) => typeof item !== "string" || !item.trim()))) issues.push(`${path}.transcript_item_ids must contain only non-empty strings`);
  return {
    anchor_id: String(value.anchor_id ?? "").trim(),
    asset_id: String(value.asset_id ?? "").trim(),
    source_content_hash: String(value.source_content_hash ?? ""),
    segment_id: String(value.segment_id ?? "").trim(),
    src_in_us: Number(value.src_in_us ?? 0),
    src_out_us: Number(value.src_out_us ?? 0),
    ...(Array.isArray(value.transcript_item_ids) ? { transcript_item_ids: [...value.transcript_item_ids] as string[] } : {}),
    ...(value.source_start_us === undefined ? {} : { source_start_us: Number(value.source_start_us) }),
    ...(value.source_end_us === undefined ? {} : { source_end_us: Number(value.source_end_us) }),
  };
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
