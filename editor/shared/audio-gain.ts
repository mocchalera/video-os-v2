/** Canonical audio gain-unit contract shared by compiler, renderers, Studio, and FCP7. */

export type GainUnit = "linear" | "db";
export type AudioGainRole = "nat" | "nat_sound" | "bgm";
export type AudioGainField = "nat_gain" | "nat_sound_gain" | "bgm_gain" | "duck_music_db";
export type EditableAudioGainField = Exclude<AudioGainField, "duck_music_db">;

export interface AudioGainPolicyLike {
  gain_unit?: GainUnit;
  nat_gain?: number;
  nat_sound_gain?: number;
  bgm_gain?: number;
  /** Always dB, independent of gain_unit. */
  duck_music_db?: number;
}

export type AudioGainProvenance =
  | "explicit_linear"
  | "explicit_db"
  | "legacy_linear_positive"
  | "legacy_db_non_positive"
  | "duck_music_db"
  | "default_unity";

export interface ResolvedAudioGain {
  gainDb: number;
  gainLinear: number;
  sourceField: AudioGainField | null;
  unit: GainUnit;
  provenance: AudioGainProvenance;
  warning?: string;
}

export interface ResolveAudioGainOptions {
  /** FCP7 historically used duck_music_db as the BGM base-gain fallback. */
  fallbackToDuckMusicDb?: boolean;
}

export const AUDIO_GAIN_MIN_DB = -96;
export const AUDIO_GAIN_WARNING_LIMIT = 20;

export function dbToLinearGain(db: number): number {
  assertFiniteGain(db, "dB");
  const linear = 10 ** (db / 20);
  if (!Number.isFinite(linear)) throw new RangeError(`dB gain ${db} cannot be represented as linear`);
  return linear;
}

export function linearGainToDb(linear: number): number {
  assertFiniteGain(linear, "linear");
  if (linear < 0) throw new RangeError(`linear gain ${linear} must be non-negative`);
  return linear === 0
    ? AUDIO_GAIN_MIN_DB
    : Math.max(AUDIO_GAIN_MIN_DB, 20 * Math.log10(linear));
}

/** Byte-identical ffmpeg volume filter used by every render lane. */
export function canonicalLinearGainFilter(gainLinear: number): string | undefined {
  assertFiniteGain(gainLinear, "linear");
  if (gainLinear < 0) throw new RangeError(`linear gain ${gainLinear} must be non-negative`);
  if (gainLinear === 1) return undefined;
  return `volume=${Number(gainLinear.toFixed(8)).toString()}`;
}

export function resolveAudioGain(
  policy: AudioGainPolicyLike | null | undefined,
  role: AudioGainRole,
  options: ResolveAudioGainOptions = {},
): ResolvedAudioGain {
  const selected = selectRoleGain(policy, role, options.fallbackToDuckMusicDb === true);
  if (!selected) {
    return {
      gainDb: 0,
      gainLinear: 1,
      sourceField: null,
      unit: "linear",
      provenance: "default_unity",
    };
  }

  const { field, value } = selected;
  assertFiniteGain(value, field);

  if (field === "duck_music_db") {
    return resolveDb(value, field, "duck_music_db");
  }
  if (policy?.gain_unit === "db") {
    return resolveDb(value, field, "explicit_db");
  }
  if (policy?.gain_unit === "linear") {
    return resolveLinear(value, field, "explicit_linear");
  }
  if (policy?.gain_unit !== undefined) {
    throw new RangeError(`Unsupported gain_unit: ${String(policy.gain_unit)}`);
  }

  if (value > 0) {
    return {
      ...resolveLinear(value, field, "legacy_linear_positive"),
      warning: `audio_gain_legacy_unit:${field}:positive_assumed_linear`,
    };
  }
  return {
    ...resolveDb(value, field, "legacy_db_non_positive"),
    warning: `audio_gain_legacy_unit:${field}:non_positive_assumed_db`,
  };
}

export function resolveAudioGainWithFallback(
  policy: AudioGainPolicyLike | null | undefined,
  fallbackPolicy: AudioGainPolicyLike | null | undefined,
  role: AudioGainRole,
  options: ResolveAudioGainOptions = {},
): ResolvedAudioGain {
  const primary = resolveAudioGain(policy, role, options);
  return primary.sourceField === null
    ? resolveAudioGain(fallbackPolicy, role, options)
    : primary;
}

/** Studio displays every editable role gain in dB, regardless of stored unit. */
export function audioGainFieldDisplayDb(
  policy: AudioGainPolicyLike | null | undefined,
  field: EditableAudioGainField,
): number {
  const value = policy?.[field];
  if (value === undefined) return 0;
  const isolatedPolicy: AudioGainPolicyLike = {
    gain_unit: policy?.gain_unit,
    [field]: value,
  };
  const role: AudioGainRole = field === "bgm_gain"
    ? "bgm"
    : field === "nat_sound_gain"
      ? "nat_sound"
      : "nat";
  return resolveAudioGain(isolatedPolicy, role).gainDb;
}

export function saveAudioGainFieldAsDb<T extends AudioGainPolicyLike>(
  policy: T | null | undefined,
  field: EditableAudioGainField,
  valueDb: number,
): T & AudioGainPolicyLike {
  assertFiniteGain(valueDb, field);
  const next: T & AudioGainPolicyLike = {
    ...(policy ?? {} as T),
    gain_unit: "db",
  };
  for (const existingField of ["nat_gain", "nat_sound_gain", "bgm_gain"] as const) {
    if (policy?.[existingField] !== undefined) {
      next[existingField] = audioGainFieldDisplayDb(policy, existingField);
    }
  }
  next[field] = valueDb;
  return next;
}

export function appendAudioGainWarning(
  warnings: string[],
  warning: string | undefined,
  limit = AUDIO_GAIN_WARNING_LIMIT,
): void {
  if (!warning || warnings.includes(warning)) return;
  const gainWarnings = warnings.filter((item) => item.startsWith("audio_gain_legacy_unit:"));
  if (gainWarnings.length < limit) {
    warnings.push(warning);
  } else if (!warnings.includes("audio_gain_legacy_unit:additional_warnings_suppressed")) {
    warnings.push("audio_gain_legacy_unit:additional_warnings_suppressed");
  }
}

function selectRoleGain(
  policy: AudioGainPolicyLike | null | undefined,
  role: AudioGainRole,
  fallbackToDuckMusicDb: boolean,
): { field: AudioGainField; value: number } | null {
  if (!policy) return null;
  if (role === "bgm") {
    if (policy.bgm_gain !== undefined) return { field: "bgm_gain", value: policy.bgm_gain };
    if (fallbackToDuckMusicDb && policy.duck_music_db !== undefined) {
      return { field: "duck_music_db", value: policy.duck_music_db };
    }
    return null;
  }
  if (role === "nat_sound" && policy.nat_sound_gain !== undefined) {
    return { field: "nat_sound_gain", value: policy.nat_sound_gain };
  }
  if (policy.nat_gain !== undefined) return { field: "nat_gain", value: policy.nat_gain };
  if (policy.nat_sound_gain !== undefined) return { field: "nat_sound_gain", value: policy.nat_sound_gain };
  return null;
}

function resolveDb(
  value: number,
  field: AudioGainField,
  provenance: AudioGainProvenance,
): ResolvedAudioGain {
  return {
    gainDb: value,
    gainLinear: dbToLinearGain(value),
    sourceField: field,
    unit: "db",
    provenance,
  };
}

function resolveLinear(
  value: number,
  field: AudioGainField,
  provenance: AudioGainProvenance,
): ResolvedAudioGain {
  return {
    gainDb: linearGainToDb(value),
    gainLinear: value,
    sourceField: field,
    unit: "linear",
    provenance,
  };
}

function assertFiniteGain(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${label} gain must be finite`);
}
