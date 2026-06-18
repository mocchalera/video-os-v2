import type { SegmentItem } from "../connectors/ffmpeg-segmenter.js";
import type { MarlinEvent, MarlinEventsArtifact } from "../connectors/marlin-types.js";
import type { Candidate, CraftDirective, CreativeBrief } from "../compiler/types.js";

export type SelectCandidate = Candidate;
export type ClipTrimPlanSource = "marlin_event" | "beat_craft_fallback";

export interface ClipTrimPlan {
  segment_id: string;
  best_in_us: number;
  best_out_us: number;
  rationale: string;
  technique: string;
  source: ClipTrimPlanSource;
  event_id?: string;
  score?: number;
}

export interface ClipTrimPlanningContext {
  usPerFrame: number;
  beatTargetDurationFramesById: Map<string, number>;
  clipsInBeatById: Map<string, number>;
  selectedBeatBySegmentId?: Map<string, string>;
}

interface TimeRange {
  startUs: number;
  endUs: number;
}

interface TermIndex {
  required: Map<string, Set<string>>;
  emotion: Map<string, Set<string>>;
  general: Map<string, Set<string>>;
  hasTerms: boolean;
}

interface RelevanceResult {
  score: number;
  matchedBriefTerms: string[];
}

interface ScoredEvent {
  event: MarlinEvent;
  inUs: number;
  outUs: number;
  score: number;
  relevance: RelevanceResult;
}

const MIN_EVENT_DURATION_US = 500_000;
const PREFERRED_MIN_DURATION_US = 2_000_000;
const PREFERRED_MAX_DURATION_US = 5_000_000;
const DEFAULT_PREFERRED_DURATION_US = 5_000_000;
const DEFAULT_EVENT_CONFIDENCE = 0.7;

const STOP_WORDS = new Set([
  "the", "and", "with", "while", "into", "onto", "from", "that", "this",
  "there", "their", "over", "under", "near", "inside", "outside", "across",
  "through", "during", "before", "after", "being", "been", "are", "was",
  "were", "has", "have", "had", "for", "you", "your", "our", "his", "her",
  "its", "they", "them", "then", "than", "but", "not", "all", "clip",
  "video", "shot", "scene", "person", "people", "someone", "subject",
]);

const TERM_AFFINITY: Record<string, string[]> = {
  action: ["act", "move", "gesture", "hand", "walk", "run", "ride", "pedal", "enter", "exit", "reveal", "start"],
  calm: ["quiet", "soft", "gentle", "pause", "still", "slow", "breathe"],
  confidence: ["steady", "clear", "proud", "answer", "explain", "demonstrate"],
  credibility: ["proof", "process", "detail", "expert", "work", "craft", "hands", "explain"],
  delight: ["smile", "laugh", "joy", "happy", "surprise"],
  emotion: ["smile", "laugh", "cry", "hug", "reaction", "relief", "hope"],
  hopeful: ["hope", "smile", "forward", "relief", "bright"],
  hope: ["hope", "smile", "forward", "relief", "bright"],
  human: ["face", "smile", "hands", "gesture", "reaction", "voice"],
  joy: ["smile", "laugh", "happy", "delight", "bright"],
  relief: ["relief", "smile", "exhale", "relax", "laugh"],
  trust: ["steady", "clear", "honest", "explain", "proof", "detail"],
  warm: ["smile", "laugh", "gentle", "soft", "hug", "care", "family", "connection"],
  warmth: ["smile", "laugh", "gentle", "soft", "hug", "care", "family", "connection"],
};

/**
 * Deterministically choose clip-level trim ranges from Marlin temporal events.
 * No network, model, or randomness is used here.
 */
export function planClipTrims(
  candidates: SelectCandidate[],
  segments: SegmentItem[],
  marlinEvents: MarlinEventsArtifact,
  brief: CreativeBrief,
  beatCraft: Map<string, CraftDirective>,
  planningContext?: ClipTrimPlanningContext,
): ClipTrimPlan[] {
  const segmentsById = new Map(segments.map((segment) => [segment.segment_id, segment]));
  const eventsByAsset = new Map(marlinEvents.items.map((item) => [item.asset_id, item.events]));
  const terms = buildBriefTermIndex(brief);
  const plans: ClipTrimPlan[] = [];

  for (const candidate of candidates) {
    if (candidate.role === "reject") continue;

    const segment = segmentsById.get(candidate.segment_id);
    const range = candidateSegmentRange(candidate, segment);
    if (!range) continue;

    const events = eventsByAsset.get(candidate.asset_id) ?? [];
    const scoredEvents = events
      .map((event) => scoreEvent(event, range, terms))
      .filter((event): event is ScoredEvent => event !== undefined)
      .sort((a, b) =>
        b.score - a.score ||
        a.inUs - b.inUs ||
        a.event.event_id.localeCompare(b.event.event_id)
      );

    const best = scoredEvents[0];
    if (best) {
      const centerUs = resolveEventCenterUs(best, range);
      const preferredDuration = resolvePreferredDurationUs(candidate, planningContext);
      const trimRange = centeredRange(centerUs, preferredDuration.durationUs, range);
      plans.push({
        segment_id: candidate.segment_id,
        best_in_us: trimRange.startUs,
        best_out_us: trimRange.endUs,
        rationale: buildEventRationale(best, trimRange),
        technique: inferTechnique(best.event.description),
        source: "marlin_event",
        event_id: best.event.event_id,
        score: roundScore(best.score),
      });
      continue;
    }

    const fallbackTechnique = resolveFallbackTechnique(candidate, beatCraft);
    if (fallbackTechnique) {
      plans.push({
        segment_id: candidate.segment_id,
        best_in_us: candidate.src_in_us,
        best_out_us: candidate.src_out_us,
        rationale: `fallback to beat-level craft: ${fallbackTechnique}; no usable Marlin event overlapped this segment`,
        technique: fallbackTechnique,
        source: "beat_craft_fallback",
      });
    }
  }

  return plans;
}

export function isMarlinEventClipTrimPlan(plan: ClipTrimPlan): boolean {
  return plan.source === "marlin_event";
}

function candidateSegmentRange(candidate: SelectCandidate, segment: SegmentItem | undefined): TimeRange | undefined {
  const candidateStart = candidate.src_in_us;
  const candidateEnd = candidate.src_out_us;
  const segmentStart = typeof segment?.src_in_us === "number" ? segment.src_in_us : candidateStart;
  const segmentEnd = typeof segment?.src_out_us === "number" ? segment.src_out_us : candidateEnd;
  const startUs = Math.max(candidateStart, segmentStart);
  const endUs = Math.min(candidateEnd, segmentEnd);
  return startUs < endUs ? { startUs, endUs } : undefined;
}

interface PreferredDurationResolution {
  durationUs: number;
  source: "trim_hint" | "beat_allocation" | "default";
}

function resolvePreferredDurationUs(
  candidate: SelectCandidate,
  planningContext: ClipTrimPlanningContext | undefined,
): PreferredDurationResolution {
  const hintDurationUs = positiveFiniteNumber(candidate.trim_hint?.preferred_duration_us);
  if (hintDurationUs !== undefined) {
    return { durationUs: hintDurationUs, source: "trim_hint" };
  }

  const beatDurationUs = resolveBeatPreferredDurationUs(candidate, planningContext);
  if (beatDurationUs !== undefined) {
    return { durationUs: beatDurationUs, source: "beat_allocation" };
  }

  return { durationUs: DEFAULT_PREFERRED_DURATION_US, source: "default" };
}

function resolveBeatPreferredDurationUs(
  candidate: SelectCandidate,
  planningContext: ClipTrimPlanningContext | undefined,
): number | undefined {
  if (!planningContext) return undefined;
  const usPerFrame = positiveFiniteNumber(planningContext.usPerFrame);
  if (usPerFrame === undefined) return undefined;

  for (const beatId of candidateBeatIds(candidate, planningContext)) {
    const targetFrames = positiveFiniteNumber(planningContext.beatTargetDurationFramesById.get(beatId));
    if (targetFrames === undefined) continue;

    const clipsInBeat = Math.max(
      1,
      Math.floor(positiveFiniteNumber(planningContext.clipsInBeatById.get(beatId)) ?? 1),
    );
    const durationUs = targetFrames * usPerFrame / clipsInBeat;
    if (Number.isFinite(durationUs) && durationUs > 0) return durationUs;
  }

  return undefined;
}

function candidateBeatIds(
  candidate: SelectCandidate,
  planningContext: ClipTrimPlanningContext,
): string[] {
  const selectedBeatId = planningContext.selectedBeatBySegmentId?.get(candidate.segment_id);
  const eligible = candidate.eligible_beats ?? [];
  if (!selectedBeatId) return eligible;
  return [
    selectedBeatId,
    ...eligible.filter((beatId) => beatId !== selectedBeatId),
  ];
}

function resolveEventCenterUs(scored: ScoredEvent, range: TimeRange): number {
  const eventCenterUs = Math.round((scored.event.start_us + scored.event.end_us) / 2);
  return clampNumber(eventCenterUs, range.startUs, range.endUs);
}

function centeredRange(centerUs: number, preferredDurationUs: number, bounds: TimeRange): TimeRange {
  const availableDurationUs = bounds.endUs - bounds.startUs;
  const durationUs = Math.min(Math.round(preferredDurationUs), availableDurationUs);
  let startUs = centerUs - durationUs / 2;
  let endUs = centerUs + durationUs / 2;

  if (startUs < bounds.startUs) {
    endUs += bounds.startUs - startUs;
    startUs = bounds.startUs;
  }
  if (endUs > bounds.endUs) {
    startUs -= endUs - bounds.endUs;
    endUs = bounds.endUs;
  }

  return {
    startUs: Math.round(clampNumber(startUs, bounds.startUs, bounds.endUs)),
    endUs: Math.round(clampNumber(endUs, bounds.startUs, bounds.endUs)),
  };
}

function scoreEvent(
  event: MarlinEvent,
  range: TimeRange,
  terms: TermIndex,
): ScoredEvent | undefined {
  const inUs = Math.max(range.startUs, event.start_us);
  const outUs = Math.min(range.endUs, event.end_us);
  const durationUs = outUs - inUs;
  if (durationUs < MIN_EVENT_DURATION_US) return undefined;

  const durationScore = durationPreferenceScore(durationUs);
  const relevance = scoreDescriptionRelevance(event.description, terms);
  const confidenceScore = clamp01(event.confidence ?? DEFAULT_EVENT_CONFIDENCE);
  const positionScore = positionPreferenceScore(Math.round((inUs + outUs) / 2), range);
  const score =
    durationScore * 0.30 +
    relevance.score * 0.35 +
    confidenceScore * 0.25 +
    positionScore * 0.10;

  return {
    event,
    inUs,
    outUs,
    score,
    relevance,
  };
}

function durationPreferenceScore(durationUs: number): number {
  if (durationUs >= PREFERRED_MIN_DURATION_US && durationUs <= PREFERRED_MAX_DURATION_US) {
    return 1;
  }
  if (durationUs < PREFERRED_MIN_DURATION_US) {
    const t = (durationUs - MIN_EVENT_DURATION_US) / (PREFERRED_MIN_DURATION_US - MIN_EVENT_DURATION_US);
    return 0.4 + clamp01(t) * 0.6;
  }
  const longDurationUs = 8_000_000;
  if (durationUs <= longDurationUs) {
    const t = (durationUs - PREFERRED_MAX_DURATION_US) / (longDurationUs - PREFERRED_MAX_DURATION_US);
    return 1 - clamp01(t) * 0.5;
  }
  const veryLongUs = 15_000_000;
  const t = (durationUs - longDurationUs) / (veryLongUs - longDurationUs);
  return Math.max(0.15, 0.5 - clamp01(t) * 0.35);
}

function positionPreferenceScore(centerUs: number, range: TimeRange): number {
  const duration = range.endUs - range.startUs;
  if (duration <= 0) return 0.5;
  const ratio = (centerUs - range.startUs) / duration;
  const edgeDistance = Math.min(ratio, 1 - ratio);
  if (edgeDistance >= 0.2) return 1;
  if (edgeDistance >= 0.1) return 0.7;
  return 0.35;
}

function scoreDescriptionRelevance(description: string, terms: TermIndex): RelevanceResult {
  if (!terms.hasTerms) return { score: 0.2, matchedBriefTerms: [] };

  const eventTerms = tokenize(description);
  const matched = new Set<string>();
  let score = 0;

  for (const term of eventTerms) {
    score += addMatches(term, terms.required, matched, 0.42);
    score += addMatches(term, terms.emotion, matched, 0.34);
    score += addMatches(term, terms.general, matched, 0.18);
  }

  return {
    score: clamp01(score),
    matchedBriefTerms: [...matched],
  };
}

function addMatches(
  eventTerm: string,
  index: Map<string, Set<string>>,
  matched: Set<string>,
  weight: number,
): number {
  const sources = index.get(eventTerm);
  if (!sources) return 0;
  let added = 0;
  for (const source of sources) {
    if (matched.has(source)) continue;
    matched.add(source);
    added += weight;
  }
  return added;
}

function buildBriefTermIndex(brief: CreativeBrief): TermIndex {
  const record = brief as Record<string, unknown>;
  const requiredTexts = [
    ...collectStringValues(record.must_have),
    ...collectStringValues(record.must_haves),
    ...collectStringValues(record.must_have_elements),
    ...collectStringValues(record.required_content),
    ...collectStringValues(record.key_moments),
  ];
  const emotionTexts = collectStringValues(brief.emotion_curve);
  const generalTexts = [
    ...collectStringValues(brief.message),
    ...collectStringValues(brief.project?.strategy),
    ...collectStringValues(brief.editorial),
  ];

  const required = buildTermMap(requiredTexts);
  const emotion = buildTermMap(emotionTexts);
  const general = buildTermMap(generalTexts);

  return {
    required,
    emotion,
    general,
    hasTerms: required.size > 0 || emotion.size > 0 || general.size > 0,
  };
}

function buildTermMap(texts: string[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const text of texts) {
    for (const term of tokenize(text)) {
      addTerm(index, term, term);
      for (const related of TERM_AFFINITY[term] ?? []) {
        addTerm(index, stemToken(related), term);
      }
    }
  }
  return index;
}

function addTerm(index: Map<string, Set<string>>, term: string, source: string): void {
  if (!term) return;
  const current = index.get(term) ?? new Set<string>();
  current.add(source);
  index.set(term, current);
}

function collectStringValues(value: unknown, depth = 0): string[] {
  if (depth > 3 || value == null) return [];
  if (typeof value === "string") return [value];
  if (typeof value === "number" || typeof value === "boolean") return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectStringValues(item, depth + 1));
  }
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap((item) =>
      collectStringValues(item, depth + 1)
    );
  }
  return [];
}

function tokenize(text: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of text.toLowerCase().replace(/[_-]/g, " ").replace(/[^a-z0-9\s]/g, " ").split(/\s+/)) {
    const term = stemToken(raw);
    if (!term || term.length < 3 || STOP_WORDS.has(term) || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
  }
  return terms;
}

function stemToken(raw: string): string {
  let term = raw.trim().toLowerCase();
  if (term.length > 5 && term.endsWith("ing")) term = term.slice(0, -3);
  else if (term.length > 4 && term.endsWith("ed")) term = term.slice(0, -2);
  else if (term.length > 4 && /(ches|shes|sses|xes|zes)$/.test(term)) term = term.slice(0, -2);
  else if (term.length > 3 && term.endsWith("s")) term = term.slice(0, -1);
  return term;
}

function inferTechnique(description: string): string {
  const value = description.toLowerCase();
  if (/(action|move|moving|run|jump|enter|exit|fall|hit|ride|riding|pedal|dance|gesture|hand|reveal|start|pour|prepare|turn|open|close)/.test(value)) {
    return "cut_on_action";
  }
  if (/(smile|laugh|cry|hug|reaction|surprise|relief|hope|pause|look|nod)/.test(value)) {
    return "peak_hold";
  }
  return "peak_hold";
}

function resolveFallbackTechnique(
  candidate: SelectCandidate,
  beatCraft: Map<string, CraftDirective>,
): string | undefined {
  for (const beatId of candidate.eligible_beats ?? []) {
    const craft = beatCraft.get(beatId);
    const technique = craft?.in_point ?? craft?.out_point;
    if (technique) return technique;
  }
  if (beatCraft.size === 1) {
    const craft = [...beatCraft.values()][0];
    return craft?.in_point ?? craft?.out_point;
  }
  return undefined;
}

function buildEventRationale(scored: ScoredEvent, trimRange: TimeRange): string {
  const match = scored.relevance.matchedBriefTerms.length > 0
    ? `; matches ${scored.relevance.matchedBriefTerms[0]} in brief`
    : "; best scored Marlin event for this clip";
  const trimDurationUs = trimRange.endUs - trimRange.startUs;
  return `centered on Marlin event '${scored.event.description}' (${formatRange(scored.event.start_us, scored.event.end_us)}), trimmed to ${formatSeconds(trimDurationUs)}s${match}`;
}

function formatRange(inUs: number, outUs: number): string {
  return `${formatSeconds(inUs)}-${formatSeconds(outUs)}s`;
}

function formatSeconds(us: number): string {
  const fixed = (us / 1_000_000).toFixed(3).replace(/0+$/g, "").replace(/\.$/, "");
  return fixed || "0";
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function positiveFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function roundScore(score: number): number {
  return Math.round(score * 1000) / 1000;
}
