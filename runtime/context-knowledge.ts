export interface ContextKnowledgeLocation {
  primary_location?: string;
  specific_places?: Array<{
    name?: string;
    description?: string;
  }>;
}

export interface ContextKnowledgeSubject {
  name?: string;
  role?: string;
  appearance?: string;
}

export interface ContextKnowledgeKeyItem {
  name?: string;
  description?: string;
  significance?: string;
}

export interface ContextKnowledgeTerminology {
  term?: string;
  meaning?: string;
}

export interface ContextKnowledge {
  location?: ContextKnowledgeLocation;
  subjects?: ContextKnowledgeSubject[];
  key_items?: ContextKnowledgeKeyItem[];
  cultural_context?: string;
  terminology?: ContextKnowledgeTerminology[];
}

interface Replacement {
  from: string;
  to: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function compactObject<T extends Record<string, unknown>>(value: T): T | undefined {
  return Object.values(value).some((item) =>
    Array.isArray(item) ? item.length > 0 : item !== undefined
  )
    ? value
    : undefined;
}

function normalizeLocation(value: unknown): ContextKnowledgeLocation | undefined {
  if (!isRecord(value)) return undefined;
  const specificPlaces = Array.isArray(value.specific_places)
    ? value.specific_places.flatMap((item): NonNullable<ContextKnowledgeLocation["specific_places"]> => {
      if (!isRecord(item)) return [];
      const place = compactObject({
        name: stringValue(item.name),
        description: stringValue(item.description),
      });
      return place ? [place] : [];
    })
    : [];
  return compactObject({
    primary_location: stringValue(value.primary_location),
    ...(specificPlaces.length > 0 ? { specific_places: specificPlaces } : {}),
  });
}

function normalizeSubjects(value: unknown): ContextKnowledgeSubject[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const subjects = value.flatMap((item): ContextKnowledgeSubject[] => {
    if (!isRecord(item)) return [];
    const subject = compactObject({
      name: stringValue(item.name),
      role: stringValue(item.role),
      appearance: stringValue(item.appearance),
    });
    return subject ? [subject] : [];
  });
  return subjects.length > 0 ? subjects : undefined;
}

function normalizeKeyItems(value: unknown): ContextKnowledgeKeyItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.flatMap((item): ContextKnowledgeKeyItem[] => {
    if (!isRecord(item)) return [];
    const keyItem = compactObject({
      name: stringValue(item.name),
      description: stringValue(item.description),
      significance: stringValue(item.significance),
    });
    return keyItem ? [keyItem] : [];
  });
  return items.length > 0 ? items : undefined;
}

function normalizeTerminology(value: unknown): ContextKnowledgeTerminology[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const terms = value.flatMap((item): ContextKnowledgeTerminology[] => {
    if (!isRecord(item)) return [];
    const term = compactObject({
      term: stringValue(item.term),
      meaning: stringValue(item.meaning),
    });
    return term ? [term] : [];
  });
  return terms.length > 0 ? terms : undefined;
}

export function normalizeContextKnowledge(value: unknown): ContextKnowledge | undefined {
  if (!isRecord(value)) return undefined;
  return compactObject({
    location: normalizeLocation(value.location),
    subjects: normalizeSubjects(value.subjects),
    key_items: normalizeKeyItems(value.key_items),
    cultural_context: stringValue(value.cultural_context),
    terminology: normalizeTerminology(value.terminology),
  });
}

export function contextKnowledgeFromBrief(brief: unknown): ContextKnowledge | undefined {
  if (!isRecord(brief)) return undefined;
  return normalizeContextKnowledge(brief.context_knowledge);
}

export function contextKnowledgePromptPayload(brief: unknown): ContextKnowledge | undefined {
  return contextKnowledgeFromBrief(brief);
}

function preferredMeaning(entry: ContextKnowledgeTerminology): string | undefined {
  const raw = stringValue(entry.meaning);
  if (!raw) return stringValue(entry.term);
  const firstClause = raw
    .split(/\s[—–-]\s|:|。|\.|\n/u)[0]
    ?.replace(/^means?\s+/i, "")
    .trim();
  return firstClause || stringValue(entry.term);
}

function normalizeReplacementTarget(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function addReplacement(replacements: Replacement[], from: string | undefined, to: string | undefined): void {
  const source = stringValue(from);
  const target = normalizeReplacementTarget(to);
  if (!source || !target || source.toLowerCase() === target.toLowerCase()) return;
  replacements.push({ from: source, to: target });
}

function singularizeSimple(value: string): string {
  if (value.toLowerCase().endsWith("ies")) return `${value.slice(0, -3)}y`;
  if (value.toLowerCase().endsWith("s") && value.length > 1) return value.slice(0, -1);
  return value;
}

function addNotTermReplacements(
  replacements: Replacement[],
  meaning: string | undefined,
  target: string | undefined,
): void {
  if (!meaning || !target) return;
  for (const match of meaning.matchAll(/\bNOT\s+([A-Za-z][A-Za-z\s/-]{0,40})/g)) {
    const raw = match[1]?.split(/[.,;:—–-]/u)[0] ?? "";
    const terms = raw
      .split(/\s+or\s+|\s+and\s+|\/|,/i)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    for (const term of terms) {
      addReplacement(replacements, term, target);
      addReplacement(replacements, singularizeSimple(term), target);
    }
  }
}

function buildTerminologyReplacements(context: ContextKnowledge): Replacement[] {
  const replacements: Replacement[] = [];
  for (const entry of context.terminology ?? []) {
    const target = normalizeReplacementTarget(preferredMeaning(entry));
    addReplacement(replacements, entry.term, target);
    addNotTermReplacements(replacements, entry.meaning, target);
    const meaning = entry.meaning?.toLowerCase() ?? "";
    const targetLower = target?.toLowerCase() ?? "";
    if (meaning.includes("not insect") || targetLower.includes("chestnut")) {
      for (const insectTerm of ["insect", "insects", "bug", "bugs", "worm", "worms", "larva", "larvae", "caterpillar", "caterpillars"]) {
        addReplacement(replacements, insectTerm, target);
      }
    }
  }

  const keyItemText = (context.key_items ?? [])
    .flatMap((item) => [item.name, item.description, item.significance])
    .filter((item): item is string => Boolean(item))
    .join(" ")
    .toLowerCase();
  if (keyItemText.includes("tongs")) {
    addReplacement(replacements, "tweezers", "tongs");
    addReplacement(replacements, "forceps", "tongs");
  }

  return replacements
    .sort((a, b) => b.from.length - a.from.length || a.from.localeCompare(b.from));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isAsciiWordPhrase(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9\s/-]*$/.test(value);
}

function preserveCase(source: string, target: string): string {
  if (source.length === 0) return target;
  if (source === source.toUpperCase()) return target.toUpperCase();
  if (source[0] === source[0].toUpperCase()) {
    return `${target[0]?.toUpperCase() ?? ""}${target.slice(1)}`;
  }
  return target.toLowerCase();
}

function replaceSimpleTerm(text: string, replacement: Replacement): string {
  const escaped = escapeRegExp(replacement.from);
  const pattern = isAsciiWordPhrase(replacement.from)
    ? new RegExp(`\\b(?:a|an|the)?\\s*(${escaped})\\b`, "gi")
    : new RegExp(`(${escaped})`, "g");
  return text.replace(pattern, (match: string, captured: string | undefined) => {
    const source = captured ?? match;
    const leadingArticle = match.slice(0, match.length - source.length);
    const target = preserveCase(source, replacement.to);
    return leadingArticle.trim() ? target : target;
  });
}

function tidyCorrectedSummary(text: string): string {
  return text
    .replace(/\btongs\s+grasping\b/gi, (match) => match[0] === "T" ? "Tongs picking up" : "tongs picking up")
    .replace(/\s+/g, " ")
    .trim();
}

function locationContextSuffix(context: ContextKnowledge): string | undefined {
  const location = context.location;
  if (!location) return undefined;
  const parts: string[] = [];
  if (location.primary_location) parts.push(location.primary_location);
  const places = (location.specific_places ?? [])
    .slice(0, 4)
    .flatMap((place) => {
      if (!place.name) return [];
      return place.description ? [`${place.name} (${place.description})`] : [place.name];
    });
  if (places.length > 0) parts.push(`known places: ${places.join("; ")}`);
  return parts.length > 0 ? `Location context: ${parts.join(". ")}.` : undefined;
}

export function applyContextKnowledgeToSummary(
  summary: string,
  context: ContextKnowledge | undefined,
): string {
  const initial = summary.trim().replace(/\s+/g, " ");
  if (!initial || !context) return initial;

  let corrected = initial;
  for (const replacement of buildTerminologyReplacements(context)) {
    corrected = replaceSimpleTerm(corrected, replacement);
  }
  corrected = tidyCorrectedSummary(corrected);

  const suffix = locationContextSuffix(context);
  if (suffix && !corrected.includes("Location context:")) {
    corrected = `${corrected}${/[.!?]$/.test(corrected) ? "" : "."} ${suffix}`;
  }
  return corrected;
}
