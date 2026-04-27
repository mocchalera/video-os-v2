import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeJsonValue } from "./p1-manifest-coverage.js";

export type PreferenceType =
  | "pacing"
  | "chronology"
  | "transition_style"
  | "repetition_tolerance"
  | "bgm_loudness"
  | "caption_density"
  | "override_rationale"
  | "delivery_preference"
  | "redaction";

export interface EditorialPreferenceMemoryEntry {
  version: string;
  project_id: string;
  entry_id: string;
  created_at: string;
  actor: { type: "human" | "runtime_command" | "import_premiere" | "package_preflight"; id: string };
  source_event: {
    event_type: "operator_command" | "blueprint_acceptance" | "review_patch_acceptance" | "review_patch_rejection" | "premiere_import" | "package_approval" | "redaction";
    event_ref: string;
  };
  preference_type: PreferenceType;
  value: { kind: "string" | "number" | "boolean" | "enum" | "json"; data: unknown };
  scope: "project" | "series" | "profile" | "delivery" | "temporary";
  confidence: { score: number; source: string; status: string; label?: string };
  status: "active" | "superseded" | "rejected" | "expired" | "redacted";
  supersedes_entry_id?: string | null;
  expires_at?: string | null;
  provenance: {
    producer: "operator-command" | "blueprint" | "review" | "import-premiere" | "package";
    inputs: Array<Record<string, unknown>>;
    hash_policy: Record<string, unknown>;
  };
}

export interface PreferenceEntryRecord {
  entry: EditorialPreferenceMemoryEntry;
  lineNumber: number;
  byteOffset: number;
}

export interface MalformedPreferenceLine {
  lineNumber: number;
  byteOffset: number;
  raw: string;
  error: string;
}

export interface ReadPreferenceEntriesOptions {
  validateEntry?: (entry: unknown) => boolean;
}

export interface PreferenceReadResult {
  entries: PreferenceEntryRecord[];
  malformedLines: MalformedPreferenceLine[];
  lastKnownGoodOffset: number;
}

export interface PreferenceConsumedReadResult extends PreferenceReadResult {
  errorsInConsumed: MalformedPreferenceLine[];
  warningsAfterConsumed: MalformedPreferenceLine[];
}

export function readPreferenceEntries(filePath: string, options: ReadPreferenceEntriesOptions = {}): PreferenceReadResult {
  if (!fs.existsSync(filePath)) {
    return { entries: [], malformedLines: [], lastKnownGoodOffset: 0 };
  }

  const raw = fs.readFileSync(filePath, "utf-8");
  const lines = raw.split("\n");
  const entries: PreferenceEntryRecord[] = [];
  const malformedLines: MalformedPreferenceLine[] = [];
  let byteOffset = 0;
  let lastKnownGoodOffset = 0;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const hasTerminator = index < lines.length - 1;
    const byteLength = Buffer.byteLength(line + (hasTerminator ? "\n" : ""), "utf-8");
    if (line.length === 0 && index === lines.length - 1) break;
    if (line.trim().length === 0) {
      malformedLines.push({ lineNumber: index + 1, byteOffset, raw: line, error: "empty JSONL line" });
      byteOffset += byteLength;
      continue;
    }

    try {
      const entry = JSON.parse(line) as EditorialPreferenceMemoryEntry;
      if (options.validateEntry && !options.validateEntry(entry)) {
        malformedLines.push({ lineNumber: index + 1, byteOffset, raw: line, error: "schema validation failed" });
      } else {
        entries.push({ entry, lineNumber: index + 1, byteOffset });
        lastKnownGoodOffset = byteOffset + byteLength;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      malformedLines.push({ lineNumber: index + 1, byteOffset, raw: line, error: message });
    }
    byteOffset += byteLength;
  }

  return { entries, malformedLines, lastKnownGoodOffset };
}

export function readPreferenceEntriesWithConsumedOffset(
  filePath: string,
  consumedOffset: number,
  options: ReadPreferenceEntriesOptions = {},
): PreferenceConsumedReadResult {
  const result = readPreferenceEntries(filePath, options);
  const errorsInConsumed = result.malformedLines.filter((line) => line.byteOffset < consumedOffset);
  const warningsAfterConsumed = result.malformedLines.filter((line) => line.byteOffset >= consumedOffset);
  return { ...result, errorsInConsumed, warningsAfterConsumed };
}

export function resolveActivePreference(
  entries: EditorialPreferenceMemoryEntry[],
  preferenceType: PreferenceType,
): {
  active: EditorialPreferenceMemoryEntry | null;
  conflicts: EditorialPreferenceMemoryEntry[];
  errors: string[];
} {
  const relevant = entries.filter((entry) => entry.preference_type === preferenceType);
  const errors: string[] = [];
  const byId = new Map(relevant.map((entry) => [entry.entry_id, entry]));

  for (const entry of relevant) {
    const seen = new Set<string>();
    let cursor: EditorialPreferenceMemoryEntry | undefined = entry;
    while (cursor?.supersedes_entry_id) {
      if (seen.has(cursor.entry_id)) {
        errors.push(`supersession cycle detected at ${cursor.entry_id}`);
        break;
      }
      seen.add(cursor.entry_id);
      cursor = byId.get(cursor.supersedes_entry_id);
    }
  }

  const active = relevant.filter((entry) => entry.status === "active");
  if (active.length === 0) return { active: null, conflicts: [], errors };
  if (active.length > 1) {
    errors.push(`unresolved active preference conflict for ${preferenceType}`);
    return { active: null, conflicts: active, errors };
  }
  return { active: active[0], conflicts: [], errors };
}

export function appendPreferenceEntry(
  filePath: string,
  entry: EditorialPreferenceMemoryEntry,
  options: ReadPreferenceEntriesOptions = {},
): { consumedOffset: number; consumedHash: string } {
  if (options.validateEntry && !options.validateEntry(entry)) {
    throw new Error("editorial_preference_memory entry failed schema validation");
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf-8");
  const raw = fs.readFileSync(filePath, "utf-8");
  return {
    consumedOffset: Buffer.byteLength(raw, "utf-8"),
    consumedHash: computePreferenceMemoryHash(raw),
  };
}

export function computePreferenceMemoryHash(rawJsonl: string): string {
  const normalizedRecords = rawJsonl.split("\n")
    .filter((line, index, lines) => !(line === "" && index === lines.length - 1))
    .map((line) => JSON.stringify(normalizeJsonValue(JSON.parse(line))));
  const stream = normalizedRecords.length > 0 ? `${normalizedRecords.join("\n")}\n` : "";
  return `sha256:${crypto.createHash("sha256").update(stream, "utf-8").digest("hex")}`;
}
