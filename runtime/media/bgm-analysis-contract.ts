/** Shared acceptance rules for the versioned BGM analysis contract. */

const FULL_SHA256 = /^[0-9a-f]{64}$/;

const M2_PROVENANCE_FIELDS = [
  "source_content_sha256",
  "backend_name",
  "backend_version",
  "input_sample_rate_hz",
  "processing_sample_rate_hz",
  "hop_length_samples",
  "window_length_samples",
  "time_unit",
  "evidence_classification",
  "measurement_status",
  "tempo_confidence",
  "fallback_used",
] as const;

export interface BgmAnalysisContractCheck {
  hasM2Provenance: boolean;
  readyAccepted: boolean;
  failures: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** True when the artifact opts into the M2 provenance contract. */
export function hasM2BgmProvenance(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const musicAsset = isRecord(value.music_asset) ? value.music_asset : undefined;
  if (musicAsset && hasOwn(musicAsset, "source_content_sha256")) return true;
  const provenance = isRecord(value.provenance) ? value.provenance : undefined;
  return !!provenance && M2_PROVENANCE_FIELDS.some((field) => hasOwn(provenance, field));
}

/**
 * Inspect the only state in which an M2 BGM artifact may be consumed as ready.
 * Legacy artifacts without any M2 field remain outside this predicate and are
 * handled by their existing compatibility path.
 */
export function inspectBgmAnalysisContract(value: unknown): BgmAnalysisContractCheck {
  const hasM2ProvenanceValue = hasM2BgmProvenance(value);
  if (!hasM2ProvenanceValue || !isRecord(value) || value.analysis_status !== "ready") {
    return { hasM2Provenance: hasM2ProvenanceValue, readyAccepted: false, failures: [] };
  }

  const failures: string[] = [];
  const provenance = isRecord(value.provenance) ? value.provenance : {};
  const musicAsset = isRecord(value.music_asset) ? value.music_asset : {};

  if (provenance.evidence_classification !== "measured") {
    failures.push("bgm_ready_evidence_classification_not_measured");
  }
  if (provenance.measurement_status !== "complete") {
    failures.push("bgm_ready_measurement_status_not_complete");
  }
  if (provenance.fallback_used !== false) {
    failures.push("bgm_ready_fallback_used");
  }

  const positiveInteger = (value: unknown): boolean => Number.isInteger(value) && (value as number) > 0;
  if (typeof provenance.backend_name !== "string" || provenance.backend_name.trim().length === 0) {
    failures.push("bgm_ready_backend_name_missing");
  }
  if (
    typeof provenance.backend_version !== "string"
    || provenance.backend_version.trim().length === 0
    || provenance.backend_version === "unknown"
  ) {
    failures.push("bgm_ready_backend_version_unavailable");
  }
  if (!positiveInteger(provenance.input_sample_rate_hz)) {
    failures.push("bgm_ready_input_sample_rate_missing");
  }
  if (!positiveInteger(provenance.processing_sample_rate_hz)) {
    failures.push("bgm_ready_processing_sample_rate_missing");
  }
  if (!positiveInteger(provenance.hop_length_samples)) {
    failures.push("bgm_ready_hop_length_missing");
  }
  if (!positiveInteger(provenance.window_length_samples)) {
    failures.push("bgm_ready_window_length_missing");
  }
  if (provenance.time_unit !== "seconds") {
    failures.push("bgm_ready_time_unit_invalid");
  }
  if (typeof provenance.tempo_confidence !== "number" || !Number.isFinite(provenance.tempo_confidence)) {
    failures.push("bgm_ready_tempo_confidence_missing");
  }

  const hashes = [
    musicAsset.source_hash,
    musicAsset.source_content_sha256,
    provenance.source_content_sha256,
  ];
  if (!hashes.every((hash) => typeof hash === "string" && FULL_SHA256.test(hash))) {
    failures.push("bgm_source_sha256_incomplete");
  } else if (new Set(hashes).size !== 1) {
    failures.push("bgm_source_sha256_mismatch");
  }

  const measuredCueArrays: Array<[string, unknown]> = [
    ["beats", value.beats],
    ["onsets", value.onsets],
    ["sections", value.sections],
  ];
  for (const [name, cues] of measuredCueArrays) {
    if (!Array.isArray(cues) || cues.length === 0) {
      failures.push(`bgm_${name}_missing_or_empty`);
      continue;
    }
    if (cues.some((cue) => !isRecord(cue) || cue.evidence_classification !== "measured")) {
      failures.push(`bgm_${name}_not_measured`);
    }
  }

  return {
    hasM2Provenance: true,
    readyAccepted: failures.length === 0,
    failures,
  };
}

/** Validate M2 ready semantics while leaving partial/failed evidence visible. */
export function validateBgmAnalysisContract(value: unknown): string[] {
  const check = inspectBgmAnalysisContract(value);
  return check.hasM2Provenance ? check.failures : [];
}

/**
 * Consumer admission: legacy artifacts remain compatible; M2 artifacts must
 * satisfy the shared ready predicate. Callers still apply their own status
 * checks before admitting a legacy artifact.
 */
export function isBgmAnalysisAcceptedForConsumption(value: unknown): boolean {
  const check = inspectBgmAnalysisContract(value);
  return !check.hasM2Provenance || check.readyAccepted;
}
