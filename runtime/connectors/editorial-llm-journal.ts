/**
 * Sanitized attempt journal for editorial LLM calls.
 *
 * The journal is an append-only JSONL file persisted from the moment an
 * attempt starts, so interrupted runs still leave evidence of which
 * transport runtime / provider / model was being tried and why it fell back.
 *
 * Sanitization is structural: the API only accepts typed metadata fields and
 * has no parameter that could carry a prompt body. Free-text reasons are
 * length-capped and scrubbed of credential-looking substrings before they
 * touch disk. API keys, tokens, environment values, and prompt text are never
 * recorded.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { EditorialLlmErrorKind } from "./editorial-llm.js";

export const EDITORIAL_ATTEMPT_JOURNAL_SCHEMA_VERSION = "1";

export type EditorialAttemptStatus = "running" | "success" | "failed" | "skipped" | "aborted";

export interface EditorialAttemptStartInput {
  role: string;
  /** "text" or "multimodal" depending on whether images were attached. */
  mode: "text" | "multimodal";
  /** Concrete transport runtime, e.g. codex_exec, claude_cli, gemini, deterministic. */
  transport_runtime: string;
  requested_provider: string;
  requested_model: string;
  effective_provider: string;
  /**
   * Effective model as far as the pipeline can prove it. codex_exec /
   * claude_cli internal models are NOT observable, so they stay "unknown"
   * and must never be backfilled with a Gemini alias.
   */
  effective_model: string;
  model_confirmed: boolean;
  /** 0-based attempt number within the same runtime (0 = first call, 1 = repair retry). */
  retry_index: number;
}

export interface EditorialAttemptJournalEntry extends EditorialAttemptStartInput {
  schema_version: string;
  attempt_id: string;
  pid: number;
  started_at: string;
  ended_at?: string;
  elapsed_ms?: number;
  status: EditorialAttemptStatus;
  error_kind?: EditorialLlmErrorKind;
  /** Sanitized, length-capped reason (e.g. fallback reason). Never contains prompts. */
  note?: string;
}

export interface EditorialAttemptFinishUpdate {
  status: Exclude<EditorialAttemptStatus, "running">;
  endedAtMs?: number;
  errorKind?: EditorialLlmErrorKind;
  note?: string;
}

export interface EditorialAttemptJournal {
  /** Persists a running entry immediately; returns its attempt id. */
  start(input: EditorialAttemptStartInput): string;
  /** Appends the terminal record for a previously started attempt. */
  finish(attemptId: string, update: EditorialAttemptFinishUpdate): void;
}

const MAX_NOTE_CHARS = 300;

/** Control-char strip + hard length cap so notes stay one JSONL-safe line. */
function capNoteLength(note: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = note.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return clean.length <= MAX_NOTE_CHARS ? clean : `${clean.slice(0, MAX_NOTE_CHARS)}…`;
}

const CREDENTIAL_PATTERNS: RegExp[] = [
  /(sk-[A-Za-z0-9_-]{8,})/g,
  /(AIza[A-Za-z0-9_-]{10,})/g,
  /(Bearer\s+[A-Za-z0-9._~+/=-]{8,})/gi,
  /((?:api[_-]?key|token|secret|password|authorization)\s*[=:]\s*)(["']?)[^\s"']+\2/gi,
];

/** Redact credential-shaped substrings from free text before persisting. */
export function sanitizeJournalNote(note: string): string {
  let clean = capNoteLength(note);
  for (const pattern of CREDENTIAL_PATTERNS) {
    clean = clean.replace(pattern, (...args: unknown[]) => {
      // args = [match, ...captureGroups, offset, string]. Only the key=value
      // pattern (two groups) keeps its prefix; everything else is fully
      // replaced so group/offset mix-ups can never leak secrets.
      const groups = args.slice(1, args.length - 2) as Array<string | undefined>;
      if (groups.length === 2 && groups[0] !== undefined && groups[1] !== undefined) {
        return `${groups[0]}${groups[1]}[redacted]${groups[1]}`;
      }
      return "[redacted]";
    });
  }
  return clean;
}

let attemptCounter = 0;

function nextAttemptId(startedAtIso: string): string {
  attemptCounter += 1;
  return `attempt_${startedAtIso.replace(/[-:.]/g, "")}_${process.pid}_${attemptCounter}`;
}

function appendEntry(journalPath: string, entry: EditorialAttemptJournalEntry): void {
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  fs.appendFileSync(journalPath, `${JSON.stringify(entry)}\n`, "utf-8");
}

export function editorialAttemptJournalPath(projectDir: string): string {
  return path.join(path.resolve(projectDir), "03_analysis", "editorial-llm-attempts.jsonl");
}

/** File-backed journal. Appends one line per state change (start/finish). */
export function createFileEditorialAttemptJournal(
  projectDir: string,
  options: { now?: () => Date } = {},
): EditorialAttemptJournal {
  const journalPath = editorialAttemptJournalPath(projectDir);
  const now = options.now ?? (() => new Date());
  const startedById = new Map<string, { input: EditorialAttemptStartInput; startedAtMs: number; startedAtIso: string }>();

  return {
    start(input: EditorialAttemptStartInput): string {
      const startedAt = now();
      const attemptId = nextAttemptId(startedAt.toISOString());
      startedById.set(attemptId, {
        input,
        startedAtMs: startedAt.getTime(),
        startedAtIso: startedAt.toISOString(),
      });
      appendEntry(journalPath, {
        ...input,
        schema_version: EDITORIAL_ATTEMPT_JOURNAL_SCHEMA_VERSION,
        attempt_id: attemptId,
        pid: process.pid,
        started_at: startedAt.toISOString(),
        status: "running",
      });
      return attemptId;
    },
    finish(attemptId: string, update: EditorialAttemptFinishUpdate): void {
      const started = startedById.get(attemptId);
      if (!started) return;
      const endedAt = update.endedAtMs !== undefined ? new Date(update.endedAtMs) : now();
      startedById.delete(attemptId);
      appendEntry(journalPath, {
        ...started.input,
        schema_version: EDITORIAL_ATTEMPT_JOURNAL_SCHEMA_VERSION,
        attempt_id: attemptId,
        pid: process.pid,
        started_at: started.startedAtIso,
        ended_at: endedAt.toISOString(),
        elapsed_ms: Math.max(0, endedAt.getTime() - started.startedAtMs),
        status: update.status,
        ...(update.errorKind ? { error_kind: update.errorKind } : {}),
        ...(update.note ? { note: sanitizeJournalNote(update.note) } : {}),
      });
    },
  };
}

export function readEditorialAttemptJournal(projectDir: string): EditorialAttemptJournalEntry[] {
  const journalPath = editorialAttemptJournalPath(projectDir);
  if (!fs.existsSync(journalPath)) return [];
  const entries: EditorialAttemptJournalEntry[] = [];
  for (const line of fs.readFileSync(journalPath, "utf-8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as EditorialAttemptJournalEntry);
    } catch {
      // Torn trailing line from a killed writer is expected evidence-wise.
    }
  }
  return entries;
}
