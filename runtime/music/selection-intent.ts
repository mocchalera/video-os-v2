/**
 * Deterministic normalization of canonical planning artifacts into the small,
 * typed intent surface consumed by BGM selection. This module is deliberately
 * dependency-free and fail-open: malformed or absent optional evidence yields
 * explicit diagnostics and conservative defaults instead of throwing.
 */

export const BGM_EDITORIAL_FAMILIES = [
  "trust_clarity",
  "warm_human",
  "reflective_emotional",
  "problem_tension",
  "future_technology",
  "progress_uplift",
  "premium_minimal",
  "playful_bold",
] as const;

export type BgmEditorialFamily = (typeof BGM_EDITORIAL_FAMILIES)[number];
export type BgmIntensity = "low" | "high";
export type BgmSpeechDensity = "sparse" | "mixed" | "dense";
export type BgmOutputMode = "preview_internal" | "external" | "public_redistribution";
export type BgmRightsScope =
  | "preview_internal"
  | "external"
  | "public_redistribution"
  | "commercial"
  | "modification";

export interface BgmEnergyPoint {
  /** Normalized position in the finished edit. */
  position: number;
  /** Desired perceived energy in [0, 1]. */
  value: number;
}

export interface BgmSelectionIntent {
  version: "bgm-selection-intent/v1";
  bgm_enabled: boolean;
  families: BgmEditorialFamily[];
  intensities: BgmIntensity[];
  use_cases: string[];
  target_energy: number;
  target_bpm: number;
  energy_curve: BgmEnergyPoint[];
  speech_ratio: number;
  speech_density: BgmSpeechDensity;
  minimum_speech_friendliness: number;
  duration_us: number;
  cut_density_per_minute: number | null;
  vocal_presence_allowed: Array<"none" | "texture">;
  start_sparse: boolean;
  allow_looping: boolean;
  allow_release_late: boolean;
  require_resolved_ending: boolean;
  output_mode: BgmOutputMode;
  required_rights_scopes: BgmRightsScope[];
  require_licensed_rights: boolean;
  require_verified_hash: true;
  explicit_exclusions: string[];
  semantic_text: string;
}

export type BgmIntentDiagnosticSeverity = "info" | "warning";

export interface BgmIntentDiagnostic {
  code: string;
  severity: BgmIntentDiagnosticSeverity;
  field: string;
  source: "creative_brief" | "edit_blueprint" | "timeline" | "request" | "normalizer";
  message: string;
  default_applied?: string | number | boolean;
}

export interface NormalizeBgmSelectionIntentInput {
  creativeBrief?: unknown;
  editBlueprint?: unknown;
  /** A derived timeline summary. Unknown extra fields are ignored. */
  timeline?: unknown;
  /** Accepts canonical rights scopes and delivery aliases: internal/public. */
  outputMode?: unknown;
  commercial?: unknown;
}

export interface NormalizeBgmSelectionIntentResult {
  intent: BgmSelectionIntent;
  diagnostics: BgmIntentDiagnostic[];
}

type UnknownRecord = Record<string, unknown>;

const FAMILY_TERMS: Readonly<Record<BgmEditorialFamily, readonly string[]>> = {
  trust_clarity: [
    "interview", "testimonial", "case study", "company story", "explain", "education",
    "インタビュー", "事例", "企業", "会社", "経営", "信頼", "説明", "解説",
  ],
  warm_human: [
    "customer", "recruit", "documentary", "human", "people", "family", "empathy",
    "顧客", "採用", "ドキュメンタリー", "人物", "人間", "家族", "共感", "温か",
  ],
  reflective_emotional: [
    "before", "reflection", "reflective", "memory", "quiet", "afterglow",
    "以前", "振り返", "内省", "記憶", "静か", "余韻", "過去",
  ],
  problem_tension: [
    "problem", "challenge", "tension", "investigation", "crisis", "obstacle",
    "課題", "問題", "緊張", "危機", "障害", "転換前",
  ],
  future_technology: [
    " ai ", "ax-1", "technology", " saas ", "software", "innovation", "digital",
    "人工知能", "テクノロジー", "技術", "革新", "未来", "デジタル",
  ],
  progress_uplift: [
    "after", "result", "growth", "outcome", "change", "success", "transformation", "progress",
    "成果", "変化", "成長", "成功", "改善", "前進", "導入", "展開", "実践",
  ],
  premium_minimal: [
    "lp hero", "landing page", "premium", "brand", "product page", "minimal",
    "ファーストビュー", "高級", "洗練", "ブランド", "ミニマル",
  ],
  playful_bold: [
    "social", "hook", "event", "tutorial", "playful", "bold", "energetic",
    "sns", "ソーシャル", "フック", "イベント", "チュートリアル", "楽しい", "軽快",
  ],
};

const USE_CASE_RULES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["interview", ["interview", "インタビュー", "対談"]],
  ["case_study", ["case study", "testimonial", "事例", "導入事例"]],
  ["company_story", ["company story", "企業", "会社", "組織"]],
  ["explainer", ["explain", "education", "説明", "解説"]],
  ["customer_story", ["customer", "顧客"]],
  ["recruiting", ["recruit", "採用"]],
  ["documentary", ["documentary", "ドキュメンタリー"]],
  ["technology", [" ai ", "ax-1", "technology", " saas ", "人工知能", "技術"]],
  ["product", ["product", "プロダクト", "製品"]],
  ["social_hook", ["social", "sns", "ソーシャル", "フック"]],
  ["event", ["event", "イベント", "セミナー"]],
  ["lp_hero", ["lp hero", "landing page", "ファーストビュー"]],
];

const ENERGY_HIGH_TERMS = [
  "fast", "rapid", "energetic", "aggressive", "accelerando", "bold", "uplift", "dynamic",
  "速", "軽快", "勢い", "力強", "高揚", "加速", "ダイナミック",
];
const ENERGY_LOW_TERMS = [
  "slow", "calm", "quiet", "reflective", "restrained", "sparse", "breath", "ritardando",
  "遅", "穏やか", "静か", "内省", "抑制", "余白", "呼吸", "余韻",
];
const RESOLVED_ENDING_TERMS = [
  "resolve", "complete", "conclusive", "land", "afterglow", "fade", "release",
  "解決", "完結", "締め", "着地", "余韻", "フェード", "収束",
];

const FAMILY_BPM_RANGE: Readonly<Record<BgmEditorialFamily, readonly [number, number]>> = {
  trust_clarity: [82, 100],
  warm_human: [70, 94],
  reflective_emotional: [64, 84],
  problem_tension: [76, 104],
  future_technology: [96, 120],
  progress_uplift: [104, 126],
  premium_minimal: [84, 112],
  playful_bold: [116, 138],
};

function record(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function at(value: unknown, ...path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    const next = record(current);
    if (!next) return undefined;
    current = next[key];
  }
  return current;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : undefined;
}

function textArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(text).filter((item): item is string => item !== undefined);
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positive(value: unknown): number | undefined {
  const parsed = finite(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function rounded(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function canonicalSort(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}

function includesAny(haystack: string, needles: readonly string[]): boolean {
  return needles.some((needle) => {
    const token = needle.trim();
    if (token === "ai" || token === "saas") {
      // ASCII word boundaries do not treat Japanese text as a delimiter in a
      // useful way here. This also avoids matching "ai" inside "explain".
      return new RegExp(`(?:^|[^a-z0-9])${token}(?:$|[^a-z0-9])`).test(haystack);
    }
    return haystack.includes(needle);
  });
}

function diagnostic(
  diagnostics: BgmIntentDiagnostic[],
  code: string,
  field: string,
  source: BgmIntentDiagnostic["source"],
  message: string,
  defaultApplied?: string | number | boolean,
): void {
  diagnostics.push({
    code,
    severity: code.includes("DEFAULT") || code.includes("INVALID") ? "warning" : "info",
    field,
    source,
    message,
    ...(defaultApplied !== undefined ? { default_applied: defaultApplied } : {}),
  });
}

function collectSemanticParts(brief: unknown, blueprint: unknown): string[] {
  const parts: string[] = [];
  const append = (value: unknown): void => {
    const item = text(value);
    if (item) parts.push(item);
  };
  const appendArray = (value: unknown): void => textArray(value).forEach((item) => parts.push(item));

  append(at(brief, "project", "title"));
  append(at(brief, "project", "strategy"));
  append(at(brief, "project", "format"));
  append(at(brief, "message", "primary"));
  appendArray(at(brief, "message", "secondary"));
  append(at(brief, "audience", "primary"));
  appendArray(at(brief, "audience", "secondary"));
  appendArray(at(brief, "emotion_curve"));
  appendArray(at(brief, "must_have"));
  append(at(brief, "content_hint"));
  append(at(brief, "editorial", "distribution_channel"));
  append(at(brief, "editorial", "embed_context"));
  append(at(brief, "editorial", "profile_hint"));

  appendArray(at(blueprint, "sequence_goals"));
  const beats = at(blueprint, "beats");
  if (Array.isArray(beats)) {
    for (const beat of beats) {
      append(at(beat, "label"));
      append(at(beat, "purpose"));
      append(at(beat, "notes"));
      append(at(beat, "story_role"));
    }
  }
  append(at(blueprint, "story_arc", "summary"));
  append(at(blueprint, "story_arc", "strategy"));
  appendArray(at(blueprint, "story_arc", "causal_links"));
  append(at(blueprint, "pacing", "opening_cadence"));
  append(at(blueprint, "pacing", "middle_cadence"));
  append(at(blueprint, "pacing", "ending_cadence"));
  append(at(blueprint, "music_policy", "permitted_energy_curve"));
  append(at(blueprint, "ending_policy", "should_feel"));
  append(at(blueprint, "ending_policy", "final_audio_strategy"));

  return parts;
}

function familyRequirements(semanticHaystack: string): BgmEditorialFamily[] {
  const termWeight = (family: BgmEditorialFamily, term: string): number => {
    if (!includesAny(semanticHaystack, [term])) return 0;
    return family === "future_technology" && (term.trim() === "ai" || term === "ax-1") ? 2 : 1;
  };
  const ranked = BGM_EDITORIAL_FAMILIES.map((family, order) => ({
    family,
    order,
    score: FAMILY_TERMS[family].reduce((sum, term) => sum + termWeight(family, term), 0),
  }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, 3)
    .map((entry) => entry.family);
  return ranked;
}

function useCaseRequirements(semanticHaystack: string, distribution: string | undefined): string[] {
  const useCases = new Set<string>();
  for (const [useCase, terms] of USE_CASE_RULES) {
    if (includesAny(semanticHaystack, terms)) useCases.add(useCase);
  }
  if (distribution === "social_feed") useCases.add("social_hook");
  if (distribution === "event_recap") useCases.add("event");
  if (distribution === "web_lp") useCases.add("lp_hero");
  if (distribution === "product_page") useCases.add("product");
  return canonicalSort(useCases);
}

function resolveDurationUs(
  brief: unknown,
  blueprint: unknown,
  timeline: unknown,
  diagnostics: BgmIntentDiagnostic[],
): number {
  const timelineUs = positive(at(timeline, "duration_us")) ?? positive(at(timeline, "total_duration_us"));
  if (timelineUs !== undefined) return Math.round(timelineUs);
  const timelineSec = positive(at(timeline, "duration_sec")) ?? positive(at(timeline, "total_duration_sec"));
  if (timelineSec !== undefined) return Math.round(timelineSec * 1_000_000);

  const bgmSec = positive(at(blueprint, "music_policy", "bgm_duration_sec"));
  if (bgmSec !== undefined) return Math.round(bgmSec * 1_000_000);
  const policySec = positive(at(blueprint, "duration_policy", "target_duration_sec"));
  if (policySec !== undefined) return Math.round(policySec * 1_000_000);
  const paceSec = positive(at(blueprint, "pacing", "default_duration_target_sec"));
  if (paceSec !== undefined) return Math.round(paceSec * 1_000_000);
  const briefSec = positive(at(brief, "project", "runtime_target_sec"));
  if (briefSec !== undefined) return Math.round(briefSec * 1_000_000);

  diagnostic(
    diagnostics,
    "BGM_INTENT_DURATION_DEFAULT",
    "duration_us",
    "normalizer",
    "No positive timeline or planning duration was available; using the deterministic audition default.",
    60_000_000,
  );
  return 60_000_000;
}

function resolveSpeechRatio(
  brief: unknown,
  blueprint: unknown,
  timeline: unknown,
  durationUs: number,
  semanticHaystack: string,
  diagnostics: BgmIntentDiagnostic[],
): number {
  const explicit = finite(at(timeline, "speech_ratio")) ?? finite(at(timeline, "dialogue_ratio"));
  if (explicit !== undefined) {
    if (explicit < 0 || explicit > 1) {
      diagnostic(diagnostics, "BGM_INTENT_INVALID_SPEECH_RATIO", "speech_ratio", "timeline", "Timeline speech ratio was outside [0, 1] and was clamped.");
    }
    return rounded(clamp(explicit));
  }
  const speechDurationUs = finite(at(timeline, "speech_duration_us"));
  if (speechDurationUs !== undefined && speechDurationUs >= 0) {
    return rounded(clamp(speechDurationUs / durationUs));
  }
  if (at(brief, "audio_policy") === "bgm_only") return 0;

  const beats = at(blueprint, "beats");
  if (Array.isArray(beats) && beats.length > 0) {
    const dialogueBeats = beats.filter((beat) => {
      const roles = at(beat, "required_roles");
      return Array.isArray(roles) && roles.includes("dialogue");
    }).length;
    if (dialogueBeats > 0) return rounded(clamp(0.35 + 0.55 * dialogueBeats / beats.length));
  }

  const inferred = includesAny(semanticHaystack, ["interview", "testimonial", "インタビュー", "対談", "事例"])
    ? 0.75
    : 0.35;
  diagnostic(
    diagnostics,
    "BGM_INTENT_SPEECH_RATIO_DEFAULT",
    "speech_ratio",
    "normalizer",
    "No timeline speech evidence was available; inferred a conservative ratio from the editorial intent.",
    inferred,
  );
  return inferred;
}

function normalizeExplicitEnergyCurve(value: unknown): BgmEnergyPoint[] {
  if (!Array.isArray(value) || value.length === 0) return [];
  const points: BgmEnergyPoint[] = [];
  for (let index = 0; index < value.length; index++) {
    const item = value[index];
    const numericValue = finite(item) ?? finite(at(item, "value")) ?? finite(at(item, "energy"));
    if (numericValue === undefined) continue;
    const impliedPosition = value.length === 1 ? 0.5 : index / (value.length - 1);
    const position = finite(at(item, "position")) ?? finite(at(item, "at")) ?? impliedPosition;
    points.push({ position: rounded(clamp(position)), value: rounded(clamp(numericValue)) });
  }
  points.sort((a, b) => a.position - b.position || a.value - b.value);
  const deduplicated = new Map<number, BgmEnergyPoint>();
  points.forEach((point) => deduplicated.set(point.position, point));
  return [...deduplicated.values()];
}

function resolveEnergy(
  blueprint: unknown,
  timeline: unknown,
  distribution: string | undefined,
  semanticHaystack: string,
  diagnostics: BgmIntentDiagnostic[],
): { target: number; curve: BgmEnergyPoint[] } {
  const explicitTarget = finite(at(timeline, "target_energy")) ?? finite(at(timeline, "mean_energy"));
  const explicitCurve = normalizeExplicitEnergyCurve(at(timeline, "energy_curve"));
  let target: number;
  if (explicitTarget !== undefined) target = clamp(explicitTarget);
  else if (explicitCurve.length > 0) {
    target = explicitCurve.reduce((sum, point) => sum + point.value, 0) / explicitCurve.length;
  } else {
    target = distribution === "social_feed" ? 0.72
      : distribution === "event_recap" ? 0.68
        : distribution === "web_lp" || distribution === "product_page" ? 0.52
          : 0.45;
    if (includesAny(semanticHaystack, ENERGY_HIGH_TERMS)) target += 0.18;
    if (includesAny(semanticHaystack, ENERGY_LOW_TERMS)) target -= 0.18;
    target = clamp(target);
    diagnostic(
      diagnostics,
      "BGM_INTENT_ENERGY_DEFAULT",
      "target_energy",
      "normalizer",
      "No numeric energy evidence was available; inferred energy from pacing and distribution metadata.",
      rounded(target),
    );
  }

  if (explicitTarget !== undefined && (explicitTarget < 0 || explicitTarget > 1)) {
    diagnostic(diagnostics, "BGM_INTENT_INVALID_ENERGY", "target_energy", "timeline", "Timeline target energy was outside [0, 1] and was clamped.");
  }
  target = rounded(target);
  if (explicitCurve.length > 0) return { target, curve: explicitCurve };

  const curveText = text(at(blueprint, "music_policy", "permitted_energy_curve"))?.toLowerCase() ?? "";
  const startSparse = at(blueprint, "music_policy", "start_sparse") === true;
  const endingText = [
    text(at(blueprint, "ending_policy", "should_feel")),
    text(at(blueprint, "ending_policy", "final_audio_strategy")),
  ].filter((item): item is string => item !== undefined).join(" ").toLowerCase();
  const rising = includesAny(curveText, ["rise", "build", "uplift", "上昇", "高揚", "ビルド"]);
  const releases = includesAny(curveText + " " + endingText, ["release", "fade", "resolve", "余韻", "フェード", "収束"]);
  const opening = clamp(startSparse ? target - 0.22 : rising ? target - 0.12 : target);
  const middle = clamp(rising ? target + 0.08 : target);
  const ending = clamp(releases ? target - 0.2 : rising ? target + 0.12 : target);
  return {
    target,
    curve: [
      { position: 0, value: rounded(opening) },
      { position: 0.55, value: rounded(middle) },
      { position: 1, value: rounded(ending) },
    ],
  };
}

function resolveCutDensity(timeline: unknown, durationUs: number): number | null {
  const explicit = finite(at(timeline, "cut_density_per_minute"));
  if (explicit !== undefined && explicit >= 0) return rounded(explicit, 3);
  const cutCount = finite(at(timeline, "cut_count"));
  if (cutCount !== undefined && cutCount >= 0) return rounded(cutCount / (durationUs / 60_000_000), 3);
  const clipCount = finite(at(timeline, "clip_count"));
  if (clipCount !== undefined && clipCount >= 0) return rounded(clipCount / (durationUs / 60_000_000), 3);
  return null;
}

function resolveTargetBpm(
  timeline: unknown,
  primaryFamily: BgmEditorialFamily,
  targetEnergy: number,
  diagnostics: BgmIntentDiagnostic[],
): number {
  const explicit = finite(at(timeline, "target_bpm")) ?? finite(at(timeline, "bpm"));
  if (explicit !== undefined) {
    if (explicit < 40 || explicit > 240) {
      diagnostic(diagnostics, "BGM_INTENT_INVALID_BPM", "target_bpm", "timeline", "Timeline target BPM was outside the supported 40-240 range and was clamped.");
    }
    return rounded(clamp(explicit, 40, 240), 2);
  }
  const [minimum, maximum] = FAMILY_BPM_RANGE[primaryFamily];
  return rounded(minimum + (maximum - minimum) * targetEnergy, 2);
}

function resolveOutputMode(
  requested: unknown,
  distribution: string | undefined,
  diagnostics: BgmIntentDiagnostic[],
): BgmOutputMode {
  const raw = text(requested)?.toLowerCase();
  if (raw === "preview_internal" || raw === "internal" || raw === "preview") return "preview_internal";
  if (raw === "external") return "external";
  if (raw === "public_redistribution" || raw === "public") return "public_redistribution";
  if (requested !== undefined) {
    diagnostic(diagnostics, "BGM_INTENT_INVALID_OUTPUT_MODE", "output_mode", "request", "Unsupported output mode was ignored; applying the safe external default.", "external");
    return "external";
  }
  if (distribution === "presentation" || distribution === "unknown" || distribution === undefined) {
    diagnostic(diagnostics, "BGM_INTENT_OUTPUT_MODE_DEFAULT", "output_mode", "normalizer", "Release intent was not explicit; applying the safe external rights policy.", "external");
  }
  return "external";
}

function rightsScopes(outputMode: BgmOutputMode, commercial: unknown): BgmRightsScope[] {
  const scopes = new Set<BgmRightsScope>([outputMode, "modification"]);
  if (commercial === true) scopes.add("commercial");
  return canonicalSort(scopes) as BgmRightsScope[];
}

/** Normalize selection evidence without mutating any input artifact. */
export function normalizeBgmSelectionIntent(
  input: NormalizeBgmSelectionIntentInput = {},
): NormalizeBgmSelectionIntentResult {
  const diagnostics: BgmIntentDiagnostic[] = [];
  const brief = record(input.creativeBrief);
  const blueprint = record(input.editBlueprint);
  const timeline = record(input.timeline);
  if (input.creativeBrief !== undefined && !brief) {
    diagnostic(diagnostics, "BGM_INTENT_INVALID_BRIEF", "creative_brief", "creative_brief", "Creative brief was not an object and was ignored.");
  }
  if (input.editBlueprint !== undefined && !blueprint) {
    diagnostic(diagnostics, "BGM_INTENT_INVALID_BLUEPRINT", "edit_blueprint", "edit_blueprint", "Edit blueprint was not an object and was ignored.");
  }
  if (input.timeline !== undefined && !timeline) {
    diagnostic(diagnostics, "BGM_INTENT_INVALID_TIMELINE", "timeline", "timeline", "Timeline summary was not an object and was ignored.");
  }

  const semanticParts = collectSemanticParts(brief, blueprint);
  const semanticText = semanticParts.join(" | ");
  // Surrounding spaces let short ASCII acronyms (for example AI) match without
  // accidentally matching an arbitrary word fragment.
  const semanticHaystack = ` ${semanticText.normalize("NFKC").toLowerCase()} `;
  const distribution = text(at(brief, "editorial", "distribution_channel"));

  let families = familyRequirements(semanticHaystack);
  if (families.length === 0) {
    families = ["trust_clarity"];
    diagnostic(diagnostics, "BGM_INTENT_FAMILY_DEFAULT", "families", "normalizer", "No supported editorial family was found; using the dialogue-safe general family.", "trust_clarity");
  }
  let useCases = useCaseRequirements(semanticHaystack, distribution);
  if (useCases.length === 0) {
    useCases = ["general_editorial"];
    diagnostic(diagnostics, "BGM_INTENT_USE_CASE_DEFAULT", "use_cases", "normalizer", "No supported use case was found; using a neutral editorial use case.", "general_editorial");
  }

  const durationUs = resolveDurationUs(brief, blueprint, timeline, diagnostics);
  const speechRatio = resolveSpeechRatio(brief, blueprint, timeline, durationUs, semanticHaystack, diagnostics);
  const energy = resolveEnergy(blueprint, timeline, distribution, semanticHaystack, diagnostics);
  const curveValues = energy.curve.map((point) => point.value);
  const intensitySet = new Set<BgmIntensity>();
  if (Math.min(...curveValues, energy.target) < 0.62) intensitySet.add("low");
  if (Math.max(...curveValues, energy.target) >= 0.62) intensitySet.add("high");
  const intensities = (["low", "high"] as const).filter((item) => intensitySet.has(item));

  const audioPolicy = at(brief, "audio_policy");
  const bgmEnabled = audioPolicy !== "original_only";
  if (!bgmEnabled) {
    diagnostic(diagnostics, "BGM_INTENT_BGM_DISABLED", "bgm_enabled", "creative_brief", "The canonical audio policy requests original audio only; selector should not choose BGM.", false);
  }

  const outputMode = resolveOutputMode(input.outputMode, distribution, diagnostics);
  const endingText = [
    text(at(blueprint, "ending_policy", "should_feel")),
    text(at(blueprint, "ending_policy", "final_audio_strategy")),
  ].filter((item): item is string => item !== undefined).join(" ").toLowerCase();
  const explicitExclusions = canonicalSort([
    ...textArray(at(brief, "must_avoid")),
    ...textArray(at(brief, "forbidden_interpretations")),
    ...textArray(at(blueprint, "rejection_rules")),
  ]);

  return {
    intent: {
      version: "bgm-selection-intent/v1",
      bgm_enabled: bgmEnabled,
      families,
      intensities,
      use_cases: useCases,
      target_energy: energy.target,
      target_bpm: resolveTargetBpm(timeline, families[0], energy.target, diagnostics),
      energy_curve: energy.curve,
      speech_ratio: speechRatio,
      speech_density: speechRatio < 0.25 ? "sparse" : speechRatio < 0.65 ? "mixed" : "dense",
      minimum_speech_friendliness: rounded(clamp(0.5 + speechRatio * 0.45, 0.5, 0.95)),
      duration_us: durationUs,
      cut_density_per_minute: resolveCutDensity(timeline, durationUs),
      vocal_presence_allowed: speechRatio >= 0.25 ? ["none"] : ["none", "texture"],
      start_sparse: at(blueprint, "music_policy", "start_sparse") !== false,
      allow_looping: durationUs > 150_000_000,
      allow_release_late: at(blueprint, "music_policy", "allow_release_late") === true,
      require_resolved_ending: includesAny(endingText, RESOLVED_ENDING_TERMS) || outputMode !== "preview_internal",
      output_mode: outputMode,
      required_rights_scopes: rightsScopes(outputMode, input.commercial),
      require_licensed_rights: outputMode !== "preview_internal",
      require_verified_hash: true,
      explicit_exclusions: explicitExclusions,
      semantic_text: semanticText,
    },
    diagnostics,
  };
}
