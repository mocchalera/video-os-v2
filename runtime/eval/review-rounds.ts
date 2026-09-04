import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { validateAgainstSchema } from "../commands/shared.js";
import {
  hashCanonical,
  verifyImmutableGenerationIdentity,
  verifyLatestGeneration,
} from "../review/social-review-generation.js";
import {
  verifyCurrentReviewReady,
} from "../review/review-ready-transaction.js";
import {
  REVIEW_ROUNDS_DIR,
  REVIEW_ROUND_RESPONSES_DIR,
  inspectImmutableRecordFile,
  readReviewRoundLedger,
  reviewRoundIdentity,
  reviewRoundResponseHash,
  type ReviewRoundAskEvent,
  type ReviewRoundResponseEvent,
  type ReviewRoundSupersededEvent,
  type VerifiedRoundEvent,
} from "../review/review-rounds-ledger.js";
import type { DegradedRunFlag } from "./product-outcome-metrics.js";

/**
 * Deterministic review_rounds measurement over the durable review-round
 * history (Issue #29 Phase 6).
 *
 * Truth source: the append-only, chain-verified round ledger under
 * `06_review/review-rounds/` plus the immutable generation evidence it binds.
 * A completed verified round requires BOTH a durable Ask dispatch event and a
 * durable human response event for the same immutable review-ready
 * generation. Semantic uniqueness is enforced across the whole ledger: one
 * ask_id, generation, review identity, Ask payload, and response decision may
 * participate in exactly one completed round. Any conflict, malformed entry,
 * or unverifiable current identity makes the metric unavailable — never a
 * measured zero, never warning-only counting.
 */

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const DIFF_FILE_NAME = "human_revision_diff.yaml";
const DIFF_SEARCH_ROOTS = ["exports/handoffs", "07_handoff"];

export interface ReviewRoundsEvidence {
  projectDir: string;
  projectId: string;
  timeline: { path: string; version: string; hash: string };
  askPointer: unknown | null;
  responsePointer: unknown | null;
  /** Canonical relative paths of discovered human_revision_diff candidates. */
  revisionDiffCandidates: string[];
  /** @internal hostile-test seam; production callers leave this unset. */
  onResponseArtifactCaptured?: (artifact: { path: string; sha256: string }) => void;
}

export interface ValidatedRevisionDiff {
  relativePath: string;
  absolutePath: string;
  sha256: string;
  document: Record<string, unknown>;
  round: { round_index: number; round_identity: string; generation_id: string };
}

export interface ReviewRoundEvidence {
  round_index: number;
  round_identity: string;
  review_identity: string;
  generation_id: string;
  timeline: { path: string; version: string; hash: string };
  output: { path: string; sha256: string };
  qa_receipt: { path: string; sha256: string; status: string };
  review_ready_receipt: { path: string; sha256: string };
  ask: { event_identity: string; event_path: string; ask_id: string; ask_payload_sha256: string };
  response: {
    event_identity: string;
    event_path: string;
    decision: string;
    /** Logical decision hash; distinct from artifact.sha256 below. */
    response_sha256: string;
    artifact: { path: string; sha256: string };
  };
}

export interface ReviewRoundsMetricValue {
  rounds: ReviewRoundEvidence[];
  history: {
    ledger_path: string;
    event_count: number;
    unanswered_rounds: number;
    superseded_rounds: number;
    scope: "complete";
  };
  human_revision_diff: { path: string; sha256: string; round_identity: string } | null;
  completeness: "complete";
}

export interface ReviewRoundsMetric {
  status: "measured" | "unavailable";
  value: ReviewRoundsMetricValue | null;
  unit: "rounds";
  method: "verified_ask_response_review_rounds";
  evidence: string[];
  limitations: string[];
}

export interface ReviewRoundsDerivation {
  metric: ReviewRoundsMetric;
  flags: DegradedRunFlag[];
  validatedRevisionDiff: ValidatedRevisionDiff | null;
  revisionDiffUnavailableReason: string | null;
  /** Every history and generation evidence file consumed by this derivation. */
  provenanceArtifacts: Array<{ relativePath: string; absolutePath: string; sha256?: string }>;
}

export function listRevisionDiffCandidates(
  projectDir: string,
  pushFlag?: (code: string, message: string, evidence: string[]) => void,
): string[] {
  const matches: string[] = [];
  const projectRoot = fs.realpathSync(path.resolve(projectDir));
  for (const searchRoot of DIFF_SEARCH_ROOTS) {
    const absoluteRoot = path.join(projectRoot, searchRoot);
    if (!fs.existsSync(absoluteRoot)) continue;
    const rootStats = fs.lstatSync(absoluteRoot);
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
      pushFlag?.("review_rounds_malformed_revision_diff", `${searchRoot} is not a real directory; symlinked discovery roots are rejected`, [searchRoot]);
      continue;
    }
    walkDiffRoot(absoluteRoot, projectRoot, pushFlag, matches);
  }
  return [...new Set(matches)].sort((left, right) => left.localeCompare(right, "en"));
}

function walkDiffRoot(
  directory: string,
  projectRoot: string,
  pushFlag: ((code: string, message: string, evidence: string[]) => void) | undefined,
  matches: string[],
): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const entryPath = path.join(directory, entry.name);
    const stats = fs.lstatSync(entryPath);
    if (stats.isSymbolicLink()) {
      pushFlag?.("review_rounds_malformed_revision_diff", `diff discovery entry is a symlink: ${entry.name}`, [entryPath]);
      continue;
    }
    if (stats.isDirectory()) {
      const real = fs.realpathSync(entryPath);
      if (real !== projectRoot && !real.startsWith(`${projectRoot}${path.sep}`)) {
        pushFlag?.("review_rounds_malformed_revision_diff", `diff discovery escapes the project: ${entry.name}`, [entryPath]);
        continue;
      }
      walkDiffRoot(entryPath, projectRoot, pushFlag, matches);
    } else if (stats.isFile()) {
      if (path.basename(entryPath) === DIFF_FILE_NAME) {
        matches.push(path.relative(projectRoot, entryPath).split(path.sep).join("/"));
      }
    }
  }
}

export interface ImmutableYamlSnapshot {
  bytes: string;
  sha256: string;
  document: unknown;
}

/**
 * ONE immutable read snapshot for diff evidence: plain regular single-link
 * file, contained in the project, inode identity (dev/ino/type/nlink/size)
 * unchanged across the read, YAML parsed and hashed from the exact bytes.
 */
export function inspectImmutableYamlFile(projectDir: string, relativePath: string): ImmutableYamlSnapshot | { error: string } {
  const absolutePath = path.join(path.resolve(projectDir), relativePath);
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(absolutePath);
  } catch (error) {
    return { error: `not statable: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (stats.isSymbolicLink()) return { error: "symlinked diff file" };
  if (!stats.isFile()) return { error: "not a regular file" };
  if (stats.nlink !== 1) return { error: `hardlinked evidence (nlink=${stats.nlink})` };
  const projectRoot = fs.realpathSync(path.resolve(projectDir));
  let real: string;
  try {
    real = fs.realpathSync(absolutePath);
  } catch (error) {
    return { error: `not resolvable: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (real !== projectRoot && !real.startsWith(`${projectRoot}${path.sep}`)) {
    return { error: "escapes the project" };
  }
  const parentPath = path.dirname(absolutePath);
  const parentBefore = fs.lstatSync(parentPath);
  const before = { dev: stats.dev, ino: stats.ino, nlink: stats.nlink, mode: stats.mode, size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs };
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(absolutePath);
  } catch (error) {
    return { error: `unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
  const afterStats = fs.lstatSync(absolutePath);
  const after = { dev: afterStats.dev, ino: afterStats.ino, nlink: afterStats.nlink, mode: afterStats.mode, size: afterStats.size, mtimeMs: afterStats.mtimeMs, ctimeMs: afterStats.ctimeMs };
  if (before.dev !== after.dev || before.ino !== after.ino || before.nlink !== after.nlink
    || before.mode !== after.mode || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    return { error: "changed during the read" };
  }
  const parentAfter = fs.lstatSync(parentPath);
  if (parentBefore.dev !== parentAfter.dev || parentBefore.ino !== parentAfter.ino || parentBefore.mode !== parentAfter.mode) {
    return { error: "parent directory changed during the read" };
  }
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  try {
    const document = parseYaml(bytes.toString("utf8"));
    return { bytes: bytes.toString("utf8"), sha256: digest, document };
  } catch (error) {
    return { error: `unparseable YAML: ${error instanceof Error ? error.message : String(error)}` };
  }
}

const RESPONSE_ARTIFACT_NAME = /^[0-9a-f]{64}\.json$/;

/**
 * Validate a response-artifact reference lexically BEFORE any filesystem use:
 * canonical project-relative spelling exactly under
 * 06_review/review-round-responses with one 64-hex basename. Rejects dot,
 * dot-dot, absolute, backslash, repeated-separator, and normalized-mismatch
 * forms (traversal and alias spellings never reach path.join).
 */
function validateCanonicalResponseArtifactPath(relativePath: unknown): string | null {
  if (typeof relativePath !== "string" || relativePath.length === 0) return null;
  if (relativePath.includes("\\")) return null;
  if (relativePath.startsWith("/")) return null;
  if (relativePath.includes("//")) return null;
  if (relativePath.includes("/./") || relativePath.endsWith("/.") || relativePath.includes("/../") || relativePath.endsWith("/..")) return null;
  if (!relativePath.startsWith(`${REVIEW_ROUND_RESPONSES_DIR}/`)) return null;
  const normalized = path.posix.normalize(relativePath);
  if (normalized !== relativePath) return null;
  const basename = normalized.slice(REVIEW_ROUND_RESPONSES_DIR.length + 1);
  if (basename.includes("/")) return null;
  if (!RESPONSE_ARTIFACT_NAME.test(basename)) return null;
  return normalized;
}

function relativeify(projectDir: string, absolutePath: string): string {
  const root = fs.realpathSync(path.resolve(projectDir));
  return path.relative(root, fs.realpathSync(path.resolve(absolutePath))).split(path.sep).join("/");
}

const DEFINITION_LIMITATION = "A round is counted only when the immutable round history contains both a durable Ask dispatch event and a durable human response event for the same review-ready generation whose canonical identity, receipt, artifact, and QA bindings verify, and no ledger-wide semantic conflict exists.";
const ZERO_VS_UNAVAILABLE_LIMITATION = "Zero completed rounds is measured only when a valid complete history scope proves it; missing, untrusted, or conflicting history is unavailable.";

export function deriveReviewRoundsMetric(input: ReviewRoundsEvidence): ReviewRoundsDerivation {
  const projectDir = path.resolve(input.projectDir);
  const flags: DegradedRunFlag[] = [];
  const pushFlag = (code: string, message: string, evidence: string[]): void => {
    flags.push({ code, severity: "warning", message, evidence });
  };
  const provenanceArtifacts: Array<{ relativePath: string; absolutePath: string; sha256?: string }> = [];
  const addProvenance = (relativePath: string, sha256?: string): void => {
    const absolutePath = path.join(projectDir, relativePath);
    // A hashOverride is the byte hash captured by the immutable inspection
    // that produced the evidence. The artifact may be deleted or atomically
    // replaced by a hostile callback after that inspection; retaining the
    // captured path/hash is required, and re-opening it would mix generations.
    // Uncaptured paths keep the existing fail-closed existence requirement.
    if (sha256 === undefined && !fs.existsSync(absolutePath)) return;
    const existing = provenanceArtifacts.find((artifact) => artifact.relativePath === relativePath);
    if (existing) {
      // Keep one canonical input per path and never lose a captured hash when
      // another consumer contributes the same artifact without an override.
      if (existing.sha256 === undefined && sha256 !== undefined) existing.sha256 = sha256;
      return;
    }
    provenanceArtifacts.push({ relativePath, absolutePath, sha256 });
  };

  const unavailable = (reason: string, diffSelection: DiffSelection | null): ReviewRoundsDerivation => ({
    metric: {
      status: "unavailable",
      value: null,
      unit: "rounds",
      method: "verified_ask_response_review_rounds",
      evidence: unavailableEvidence(input, provenanceArtifacts),
      limitations: [reason, DEFINITION_LIMITATION, ZERO_VS_UNAVAILABLE_LIMITATION],
    },
    flags,
    validatedRevisionDiff: null,
    revisionDiffUnavailableReason: diffSelection?.reason ?? null,
    provenanceArtifacts,
  });

  const ledgerAbsolute = path.join(projectDir, REVIEW_ROUNDS_DIR);
  const ledgerExists = fs.existsSync(ledgerAbsolute) && fs.statSync(ledgerAbsolute).isDirectory();
  if (!ledgerExists) {
    const diffSelection = selectRevisionDiff(input, projectDir, pushFlag, new Set([input.timeline.hash]), new Map());
    return unavailable(
      "No durable review-round history exists; absent history is never guessed and compatibility pointers are not a source of truth.",
      diffSelection,
    );
  }

  const ledger = readReviewRoundLedger(projectDir);
  for (const event of ledger.chain) addProvenance(`${REVIEW_ROUNDS_DIR}/${event.file}`, event.sha256);
  for (const malformed of ledger.malformed) {
    pushFlag(
      "review_rounds_malformed_history",
      `${REVIEW_ROUNDS_DIR}/${malformed.file}: ${malformed.reason}`,
      [`${REVIEW_ROUNDS_DIR}/${malformed.file}`],
    );
  }
  for (const conflict of ledger.conflicts) {
    pushFlag("review_rounds_history_conflict", conflict, [REVIEW_ROUNDS_DIR]);
  }
  if (ledger.malformed.length > 0 || ledger.conflicts.length > 0) {
    const diffSelection = selectRevisionDiff(input, projectDir, pushFlag, new Set([input.timeline.hash]), new Map());
    return unavailable(
      "Review-round history is malformed or conflicting; observation completeness cannot be proven, so no rounds are counted and the scope is not complete.",
      diffSelection,
    );
  }
  if (ledger.chain.length === 0) {
    const diffSelection = selectRevisionDiff(input, projectDir, pushFlag, new Set([input.timeline.hash]), new Map());
    return unavailable(
      "The review-round history scope is empty; an empty ledger proves no observation and is never guessed into a count.",
      diffSelection,
    );
  }

  for (const conflict of checkPointerBindings(input, ledger.chain)) {
    pushFlag("review_rounds_pointer_binding_conflict", conflict.message, conflict.evidence);
  }

  // The response-artifact namespace is censored with the same strictness as
  // the ledger: copies, foreign files, symlinks, hardlinks, or directories
  // make the history unavailable (copied/aliased evidence never coexists
  // silently). The census runs before AND after round verification so a
  // hardlink introduced between checks is detected.
  const censusConflicts = censusResponseNamespace(projectDir, input.projectId, ledger.chain);
  for (const conflict of censusConflicts) {
    pushFlag("review_rounds_history_conflict", conflict.message, conflict.evidence);
  }
  if (censusConflicts.length > 0) {
    const diffSelection = selectRevisionDiff(input, projectDir, pushFlag, new Set([input.timeline.hash]), new Map());
    return unavailable(
      "The durable response artifact namespace is malformed or contains copied evidence; observation completeness cannot be proven.",
      diffSelection,
    );
  }

  // Ledger-wide semantic integrity: response events must continue their Ask,
  // a pointer-bound durable response artifact must match its event decision
  // and hash, and superseded events must bind the exact project, generation,
  // review identity, and Ask they supersede with predecessor === ask_event.
  const eventsByIdentity = new Map(ledger.chain.map((entry) => [entry.identity, entry]));
  let semanticConflict = false;
  const responsePointerArtifact = input.responsePointer
  && typeof input.responsePointer === "object"
  && !Array.isArray(input.responsePointer)
    ? input.responsePointer as { round_event_sha256?: unknown; ask_id?: unknown; decision?: unknown; text?: unknown }
    : null;
  for (const entry of ledger.chain) {
    if (entry.event.version === "review-round-response/v1") {
      const response = entry.event as ReviewRoundResponseEvent;
      const askEntry = eventsByIdentity.get(response.predecessor);
      if (!askEntry || askEntry.event.version !== "review-round-ask/v1") {
        pushFlag("review_rounds_history_conflict", `response event ${entry.identity} does not follow a durable Ask event`, [`${REVIEW_ROUNDS_DIR}/${entry.file}`]);
        semanticConflict = true;
        continue;
      }
      if (response.ask_event !== response.predecessor) {
        pushFlag("review_rounds_history_conflict", `response event ${entry.identity} does not bind its predecessor Ask event`, [`${REVIEW_ROUNDS_DIR}/${entry.file}`]);
        semanticConflict = true;
      }
      const askEvent = askEntry.event as ReviewRoundAskEvent;
      if (response.project_id !== askEvent.project_id
        || response.generation_id !== askEvent.generation_id
        || response.review_identity !== askEvent.review_identity
        || response.ask_id !== askEvent.ask_id) {
        pushFlag("review_rounds_history_conflict", `response event ${entry.identity} binds a different project, generation, review identity, or Ask than its predecessor`, [`${REVIEW_ROUNDS_DIR}/${entry.file}`]);
        semanticConflict = true;
      }
      if (responsePointerArtifact && responsePointerArtifact.round_event_sha256 === entry.identity) {
        const artifactDecision = typeof responsePointerArtifact.decision === "string" ? responsePointerArtifact.decision : null;
        const artifactText = responsePointerArtifact.text === null ? null : typeof responsePointerArtifact.text === "string" ? responsePointerArtifact.text : undefined;
        if (artifactDecision === undefined || artifactText === undefined
          || artifactDecision !== response.decision
          || responsePointerArtifact.ask_id !== response.ask_id
          || reviewRoundResponseHash({ ask_id: response.ask_id, decision: response.decision, text: artifactText }) !== response.response_sha256) {
          pushFlag("review_rounds_history_conflict", `durable response artifact bound to event ${entry.identity} contradicts the recorded decision or hash`, [`${REVIEW_ROUNDS_DIR}/${entry.file}`, "06_review/review-response.json"]);
          semanticConflict = true;
        }
      }
    } else if (entry.event.version === "review-round-superseded/v1") {
      const superseded = entry.event as ReviewRoundSupersededEvent;
      const askEntry = eventsByIdentity.get(superseded.ask_event);
      if (!askEntry || askEntry.event.version !== "review-round-ask/v1") {
        pushFlag("review_rounds_history_conflict", `superseded event ${entry.identity} does not bind a durable Ask event`, [`${REVIEW_ROUNDS_DIR}/${entry.file}`]);
        semanticConflict = true;
        continue;
      }
      const askEvent = askEntry.event as ReviewRoundAskEvent;
      if (superseded.predecessor !== superseded.ask_event) {
        pushFlag("review_rounds_history_conflict", `superseded event ${entry.identity} predecessor does not equal the Ask event it supersedes`, [`${REVIEW_ROUNDS_DIR}/${entry.file}`]);
        semanticConflict = true;
      }
      if (superseded.project_id !== askEvent.project_id
        || superseded.generation_id !== askEvent.generation_id
        || superseded.review_identity !== askEvent.review_identity
        || superseded.ask_id !== askEvent.ask_id) {
        pushFlag("review_rounds_history_conflict", `superseded event ${entry.identity} does not bind the exact project, generation, review identity, and Ask it supersedes`, [`${REVIEW_ROUNDS_DIR}/${entry.file}`]);
        semanticConflict = true;
      }
    }
  }

  const askIdentities = new Set(
    ledger.chain.filter((entry) => entry.event.version === "review-round-ask/v1").map((entry) => entry.identity),
  );
  const responsesByPredecessor = new Map<string, VerifiedRoundEvent>();
  const supersededAskIdentities = new Set<string>();
  const supersededSeen = new Set<string>();
  for (const entry of ledger.chain) {
    if (entry.event.version === "review-round-response/v1") {
      const response = entry.event as ReviewRoundResponseEvent;
      if (!askIdentities.has(response.predecessor)) continue; // already flagged above
      responsesByPredecessor.set(response.predecessor, entry);
    } else if (entry.event.version === "review-round-superseded/v1") {
      const superseded = entry.event as ReviewRoundSupersededEvent;
      supersededAskIdentities.add(superseded.ask_event);
      if (supersededSeen.has(superseded.ask_event)) {
        pushFlag("review_rounds_history_conflict", `duplicate supersession for Ask event ${superseded.ask_event}`, [`${REVIEW_ROUNDS_DIR}/${entry.file}`]);
        semanticConflict = true;
      }
      supersededSeen.add(superseded.ask_event);
    }
  }

  interface CandidatePair {
    round_index: number;
    ask: VerifiedRoundEvent;
    response: VerifiedRoundEvent;
  }
  const completed: CandidatePair[] = [];
  let unanswered = 0;
  let supersededUnanswered = 0;
  let askIndex = 0;
  for (const entry of ledger.chain) {
    if (entry.event.version !== "review-round-ask/v1") continue;
    askIndex += 1;
    const response = responsesByPredecessor.get(entry.identity);
    if (!response) {
      if (supersededAskIdentities.has(entry.identity)) supersededUnanswered += 1;
      else unanswered += 1;
      continue;
    }
    completed.push({ round_index: askIndex, ask: entry, response });
  }

  // Ledger-wide semantic uniqueness over EVERY event — not only completed
  // pairs: one ask_id, generation, review identity, and Ask payload per Ask
  // (even unanswered); one response decision/artifact identity per response.
  const uniqueness: Array<[string, string, string]> = [];
  for (const entry of ledger.chain) {
    if (entry.event.version === "review-round-ask/v1") {
      const askEvent = entry.event as ReviewRoundAskEvent;
      uniqueness.push(["ask_id", askEvent.ask_id, entry.file]);
      uniqueness.push(["generation", askEvent.generation_id, entry.file]);
      uniqueness.push(["review identity", askEvent.review_identity, entry.file]);
      uniqueness.push(["Ask payload", askEvent.ask_payload_sha256, entry.file]);
    } else if (entry.event.version === "review-round-response/v1") {
      const response = entry.event as ReviewRoundResponseEvent;
      uniqueness.push(["response decision", response.response_sha256, entry.file]);
      uniqueness.push(["response artifact", response.artifact.sha256, entry.file]);
    }
  }
  const byUniquenessKey = new Map<string, string>();
  for (const [kind, key, file] of uniqueness) {
    const mapKey = `${kind}:${key}`;
    const prior = byUniquenessKey.get(mapKey);
    if (prior && prior !== file) {
      pushFlag(
        "review_rounds_history_conflict",
        `ledger-wide semantic conflict: the same ${kind} appears in more than one event`,
        [`${REVIEW_ROUNDS_DIR}/${prior}`, `${REVIEW_ROUNDS_DIR}/${file}`],
      );
      semanticConflict = true;
    }
    byUniquenessKey.set(mapKey, file);
  }
  if (semanticConflict) {
    const diffSelection = selectRevisionDiff(input, projectDir, pushFlag, new Set([input.timeline.hash]), new Map());
    return unavailable(
      "Review-round history is malformed or conflicting; observation completeness cannot be proven, so no rounds are counted and the scope is not complete.",
      diffSelection,
    );
  }

  // Canonical transition rule: an Ask event may never be followed directly by
  // another Ask event — the prior Ask must have been canonically responded or
  // superseded first.
  for (let index = 0; index < ledger.chain.length - 1; index += 1) {
    const current = ledger.chain[index]!;
    const next = ledger.chain[index + 1]!;
    if (current.event.version === "review-round-ask/v1" && next.event.version === "review-round-ask/v1") {
      pushFlag(
        "review_rounds_history_conflict",
        `Ask event ${current.identity} is followed directly by another Ask without a canonical response or supersession`,
        [`${REVIEW_ROUNDS_DIR}/${current.file}`, `${REVIEW_ROUNDS_DIR}/${next.file}`],
      );
      const diffSelection = selectRevisionDiff(input, projectDir, pushFlag, new Set([input.timeline.hash]), new Map());
      return unavailable(
        "Invalid Ask-to-Ask transition in the canonical history; observation completeness cannot be proven.",
        diffSelection,
      );
    }
  }

  // Every Ask — answered, unanswered, or superseded — must fully verify
  // against the canonical project, generation, timeline, output, receipt, and
  // artifact identity. A schema-valid but foreign or fabricated unanswered
  // Ask makes the history UNAVAILABLE, never a measured zero.
  const completedAskIdentities = new Set(completed.map((pair) => pair.ask.identity));
  for (const entry of ledger.chain) {
    if (entry.event.version !== "review-round-ask/v1") continue;
    if (completedAskIdentities.has(entry.identity)) continue; // verified with its round
    try {
      verifyAskAgainstGeneration(projectDir, input.projectId, input.timeline, entry, pushFlag);
    } catch (error) {
      const diffSelection = selectRevisionDiff(input, projectDir, pushFlag, new Set([input.timeline.hash]), new Map());
      return unavailable(
        `An unanswered or superseded Ask failed canonical verification: ${error instanceof Error ? error.message : String(error)}`,
        diffSelection,
      );
    }
  }

  // Current identity must be establishable UNCONDITIONALLY whenever the
  // ledger identifies a current generation: a malformed or failed latest
  // generation pointer, or a failed/stale/unverifiable current review-ready
  // state, makes the whole metric unavailable — an older chain is never
  // counted instead, whether or not the current Ask has a response.
  let latest: { generation_id: string } | null = null;
  try {
    latest = verifyLatestGeneration(projectDir);
  } catch (error) {
    pushFlag(
      "review_rounds_latest_pointer_invalid",
      `canonical latest generation pointer could not be verified: ${error instanceof Error ? error.message : String(error)}`,
      ["09_output/social-review/latest.json"],
    );
    const diffSelection = selectRevisionDiff(input, projectDir, pushFlag, new Set([input.timeline.hash]), new Map());
    return unavailable(
      "The current review identity cannot be established because the canonical latest generation pointer failed verification; no rounds are counted.",
      diffSelection,
    );
  }
  try {
    const current = verifyCurrentReviewReady(projectDir);
    if (current.state.generation_id !== latest.generation_id) throw new Error("review-ready state generation mismatch");
  } catch (error) {
    pushFlag(
      "review_rounds_current_state_invalid",
      `the current generation failed verifyCurrentReviewReady: ${error instanceof Error ? error.message : String(error)}`,
      ["06_review/review-ready-state.json"],
    );
    const diffSelection = selectRevisionDiff(input, projectDir, pushFlag, new Set([input.timeline.hash]), new Map());
    return unavailable(
      "The current review identity cannot be established because the current review-ready verification failed; no rounds are counted.",
      diffSelection,
    );
  }

  const provenanceTimelineHashes = new Set<string>([input.timeline.hash]);
  for (const entry of ledger.chain) {
    if (entry.event.version === "review-round-ask/v1") {
      provenanceTimelineHashes.add((entry.event as ReviewRoundAskEvent).timeline.hash);
    }
  }

  // Any completed Ask/response pair that fails verification of ANY axis makes
  // the entire history unavailable — invalid pairs are never silently
  // filtered into a measured zero or a partial count.
  const verifiedRounds: ReviewRoundEvidence[] = [];
  for (const pair of completed) {
    let round: ReviewRoundEvidence | null = null;
    try {
      round = verifyCompletedRound(projectDir, input.projectId, input.timeline, pair, latest, pushFlag);
    } catch (error) {
      pushFlag(
        "review_rounds_history_conflict",
        `completed round ${pair.round_index} failed verification: ${error instanceof Error ? error.message : String(error)}`,
        [`${REVIEW_ROUNDS_DIR}/${pair.ask.file}`],
      );
      const diffSelection = selectRevisionDiff(input, projectDir, pushFlag, provenanceTimelineHashes, new Map());
      return unavailable(
        "A completed review round failed canonical verification; the history cannot be trusted, so no rounds are counted.",
        diffSelection,
      );
    }
    if (round) {
      input.onResponseArtifactCaptured?.(round.response.artifact);
      verifiedRounds.push(round);
      addProvenance(round.response.artifact.path, round.response.artifact.sha256);
      const generationDir = path.join("09_output/social-review/generations", round.generation_id.slice("sha256:".length));
      // Provenance hashes come from captured single-snapshot reads: the
      // ready/qa hashes were captured during verification; the remaining
      // receipts are inspected exactly once here and never re-opened.
      const capturedReceiptHashes: Array<[string, string | undefined]> = [
        [`${generationDir}/review-ready-receipt.json`, round.review_ready_receipt.sha256],
        [`${generationDir}/review-qa-receipt.json`, round.qa_receipt.sha256],
      ];
      for (const receipt of ["social-review-report.json", "audio-mastering-receipt.json", "source-input-attestation.json"]) {
        const relativePath = `${generationDir}/${receipt}`;
        const inspection = inspectImmutableRecordFile(path.join(projectDir, relativePath));
        capturedReceiptHashes.push([relativePath, inspection.ok ? inspection.sha256 : undefined]);
      }
      for (const [relativePath, sha256] of capturedReceiptHashes) addProvenance(relativePath, sha256);
    }
  }
  // The rounds array is the sole count truth: duplicate round identities or
  // indices can never appear in a measured value.
  const seenRoundIdentities = new Set<string>();
  const seenRoundIndices = new Set<number>();
  for (const round of verifiedRounds) {
    if (seenRoundIdentities.has(round.round_identity) || seenRoundIndices.has(round.round_index)) {
      const diffSelection = selectRevisionDiff(input, projectDir, pushFlag, provenanceTimelineHashes, new Map());
      return unavailable(
        "Duplicate round identity or index in the verified history; the rounds array is the sole count source and must be unique.",
        diffSelection,
      );
    }
    seenRoundIdentities.add(round.round_identity);
    seenRoundIndices.add(round.round_index);
  }

  // Re-census after verification: a hardlink, swap, or mutation introduced
  // between the snapshot, per-round verification, and this final pass must
  // fail closed instead of reporting a count.
  const reLedger = readReviewRoundLedger(projectDir);
  const reCensus = censusResponseNamespace(projectDir, input.projectId, reLedger.chain);
  const reIdentified = new Set(reLedger.chain.map((entry) => entry.identity));
  const previousIdentified = new Set(ledger.chain.map((entry) => entry.identity));
  let betweenChecksConflict = reCensus.length > 0 || reLedger.malformed.length > 0 || reLedger.conflicts.length > 0
    || reIdentified.size !== previousIdentified.size
    || [...previousIdentified].some((identity) => !reIdentified.has(identity));
  if (betweenChecksConflict) {
    for (const conflict of reCensus) pushFlag("review_rounds_history_conflict", conflict.message, conflict.evidence);
    for (const malformed of reLedger.malformed) {
      pushFlag("review_rounds_history_conflict", `evidence changed during measurement: ${REVIEW_ROUNDS_DIR}/${malformed.file}: ${malformed.reason}`, [`${REVIEW_ROUNDS_DIR}/${malformed.file}`]);
    }
    for (const conflict of reLedger.conflicts) pushFlag("review_rounds_history_conflict", conflict, [REVIEW_ROUNDS_DIR]);
    const diffSelection = selectRevisionDiff(input, projectDir, pushFlag, provenanceTimelineHashes, new Map());
    return unavailable(
      "Review-round evidence changed or failed re-census during measurement; observation completeness cannot be proven, so no rounds are counted.",
      diffSelection,
    );
  }
  verifiedRounds.sort((left, right) => left.round_index - right.round_index);
  const roundByRoundIdentity = new Map(verifiedRounds.map((round) => [round.round_identity, round]));
  const diffSelection = selectRevisionDiff(input, projectDir, pushFlag, provenanceTimelineHashes, roundByRoundIdentity);
  const diff = diffSelection.diff;
  if (diff) addProvenance(diff.relativePath, diff.sha256);

  const metric: ReviewRoundsMetric = {
    status: "measured",
    value: {
      rounds: verifiedRounds,
      history: {
        ledger_path: REVIEW_ROUNDS_DIR,
        event_count: ledger.chain.length,
        unanswered_rounds: unanswered,
        superseded_rounds: supersededUnanswered,
        scope: "complete",
      },
      human_revision_diff: diff
        ? { path: diff.relativePath, sha256: diff.sha256, round_identity: diff.round.round_identity }
        : null,
      completeness: "complete",
    },
    unit: "rounds",
    method: "verified_ask_response_review_rounds",
    evidence: uniqueSorted([
      REVIEW_ROUNDS_DIR,
      ...verifiedRounds.flatMap((round) => [round.ask.event_path, round.response.event_path, round.response.artifact.path]),
      diff ? diff.relativePath : null,
    ]),
    limitations: [
      DEFINITION_LIMITATION,
      "Single-slot Ask and response files are compatibility pointers bound to this history; they never contribute rounds on their own. The rounds array is the sole serialized count source.",
      diff
        ? "human_revision_diff is bound to one exact verified round for linkage to post_export_edit_distance only; this metric does not alter correction-distance semantics."
        : "No identity-bound human_revision_diff is available; linkage to post_export_edit_distance is not established.",
    ],
  };
  return {
    metric,
    flags,
    validatedRevisionDiff: diff,
    revisionDiffUnavailableReason: diff ? null : diffSelection.reason,
    provenanceArtifacts,
  };
}

function censusResponseNamespace(
  projectDir: string,
  projectId: string,
  chain: VerifiedRoundEvent[],
): Array<{ message: string; evidence: string[] }> {
  const conflicts: Array<{ message: string; evidence: string[] }> = [];
  const responsesDir = path.join(projectDir, REVIEW_ROUND_RESPONSES_DIR);
  // Closed world: the set of response artifacts in the namespace must EXACTLY
  // equal the set referenced by the canonical event chain — every artifact
  // schema-valid, referenced exactly once, bound to this project and one of
  // its generations; no extra, stale, foreign, or duplicate evidence.
  const referencedHashes = new Map<string, number>();
  for (const entry of chain) {
    if (entry.event.version !== "review-round-response/v1") continue;
    const response = entry.event as ReviewRoundResponseEvent;
    if (!SHA256.test(response.artifact.sha256)) {
      conflicts.push({ message: `response event ${entry.identity} binds a malformed artifact hash`, evidence: [`${REVIEW_ROUNDS_DIR}/${entry.file}`] });
      continue;
    }
    referencedHashes.set(response.artifact.sha256, (referencedHashes.get(response.artifact.sha256) ?? 0) + 1);
  }
  const namespaceHashes = new Set<string>();
  if (!fs.existsSync(responsesDir)) {
    if (referencedHashes.size > 0) {
      conflicts.push({ message: "response artifact namespace is missing while response events reference durable artifacts", evidence: [REVIEW_ROUND_RESPONSES_DIR] });
    }
    return conflicts;
  }
  if (fs.lstatSync(responsesDir).isSymbolicLink()) {
    conflicts.push({ message: "response artifact namespace is a symlink; external storage is forbidden", evidence: [REVIEW_ROUND_RESPONSES_DIR] });
    return conflicts;
  }
  for (const entry of fs.readdirSync(responsesDir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const entryPath = path.join(responsesDir, entry.name);
    if (!entry.isFile() || entry.isSymbolicLink() || !RESPONSE_ARTIFACT_NAME.test(entry.name)) {
      conflicts.push({ message: `unexpected entry in the response artifact namespace: ${entry.name}`, evidence: [`${REVIEW_ROUND_RESPONSES_DIR}/${entry.name}`] });
      continue;
    }
    const inspection = inspectImmutableRecordFile(entryPath);
    if (!inspection.ok) {
      conflicts.push({ message: `response artifact ${entry.name}: ${inspection.reason}`, evidence: [`${REVIEW_ROUND_RESPONSES_DIR}/${entry.name}`] });
      continue;
    }
    const artifact = inspection.document as Record<string, unknown>;
    const artifactIdentity = hashCanonical(artifact);
    if (`${artifactIdentity.slice("sha256:".length)}.json` !== entry.name) {
      conflicts.push({ message: `response artifact ${entry.name} identity does not match its immutable filename (copied artifact)`, evidence: [`${REVIEW_ROUND_RESPONSES_DIR}/${entry.name}`] });
      continue;
    }
    // Reference matching uses the bound file-byte hash (artifact.sha256 in
    // the response event), while the filename carries the canonical identity.
    const fileHash = inspection.sha256;
    if (namespaceHashes.has(fileHash)) {
      conflicts.push({ message: `duplicate response artifact content under multiple names: ${entry.name}`, evidence: [`${REVIEW_ROUND_RESPONSES_DIR}/${entry.name}`] });
      continue;
    }
    namespaceHashes.add(fileHash);
    if (artifact.project_id !== projectId) {
      conflicts.push({ message: `response artifact ${entry.name} binds a foreign project identity`, evidence: [`${REVIEW_ROUND_RESPONSES_DIR}/${entry.name}`] });
      continue;
    }
    const references = referencedHashes.get(fileHash) ?? 0;
    if (references === 0) {
      conflicts.push({ message: `unreferenced response artifact ${entry.name} is not bound by any canonical response event (stale, foreign, or extra evidence)`, evidence: [`${REVIEW_ROUND_RESPONSES_DIR}/${entry.name}`] });
    } else if (references > 1) {
      conflicts.push({ message: `response artifact ${entry.name} is referenced by more than one response event`, evidence: [`${REVIEW_ROUND_RESPONSES_DIR}/${entry.name}`] });
    }
  }
  for (const [hash, references] of referencedHashes) {
    if (!namespaceHashes.has(hash)) {
      conflicts.push({ message: `referenced response artifact ${hash} is missing from the namespace`, evidence: [REVIEW_ROUND_RESPONSES_DIR] });
    } else if (references > 1) {
      conflicts.push({ message: `response artifact ${hash} is referenced ${references} times; artifacts participate in exactly one round`, evidence: [REVIEW_ROUND_RESPONSES_DIR] });
    }
  }
  return conflicts;
}

function unavailableEvidence(
  input: ReviewRoundsEvidence,
  provenanceArtifacts: Array<{ relativePath: string; absolutePath: string }>,
): string[] {
  return uniqueSorted([
    REVIEW_ROUNDS_DIR,
    ...provenanceArtifacts.map((artifact) => artifact.relativePath),
    ...input.revisionDiffCandidates,
  ]);
}

function checkPointerBindings(
  input: ReviewRoundsEvidence,
  chain: VerifiedRoundEvent[],
): Array<{ message: string; evidence: string[] }> {
  const conflicts: Array<{ message: string; evidence: string[] }> = [];
  const identities = new Set(chain.map((entry) => entry.identity));
  const pointers: Array<[string, unknown]> = [
    ["06_review/review-ask.json", input.askPointer],
    ["06_review/review-response.json", input.responsePointer],
  ];
  for (const [pointerPath, pointer] of pointers) {
    if (!pointer || typeof pointer !== "object" || Array.isArray(pointer)) continue;
    const binding = (pointer as { round_event_sha256?: unknown }).round_event_sha256;
    if (typeof binding !== "string" || !SHA256.test(binding)) continue;
    if (!identities.has(binding)) {
      conflicts.push({
        message: `${pointerPath} binds round history event ${binding} which does not exist in the immutable history`,
        evidence: [pointerPath],
      });
    }
  }
  return conflicts;
}

export interface VerifiedAskEvidence {
  askEvent: ReviewRoundAskEvent;
  generation_id: string;
  review_identity: string;
  timeline: { path: string; version: string; hash: string };
  output: { path: string; sha256: string };
  qa_receipt: { path: string; sha256: string; status: string };
  review_ready_receipt: { path: string; sha256: string };
}

/**
 * Canonical verification of ONE ask event — answered or unanswered alike:
 * project, generation identity, receipt/output/artifact bindings, timeline
 * identity, and non-blocker QA. Any failure throws (whole history
 * unavailable). Path bindings are enforced, not only hashes.
 */
function verifyAskAgainstGeneration(
  projectDir: string,
  projectId: string,
  timeline: { path: string; version: string; hash: string },
  ask: VerifiedRoundEvent,
  pushFlag: (code: string, message: string, evidence: string[]) => void,
): VerifiedAskEvidence {
  const askEvent = ask.event as ReviewRoundAskEvent;
  const askEventPath = `${REVIEW_ROUNDS_DIR}/${ask.file}`;
  const reject = (code: string, message: string, evidence: string[]): never => {
    pushFlag(code, message, evidence);
    throw new Error(message);
  };
  if (askEvent.project_id !== projectId) {
    return reject("review_rounds_foreign_round", `ask event binds a foreign project identity`, [askEventPath]);
  }
  let verified;
  try {
    verified = verifyImmutableGenerationIdentity(projectDir, askEvent.generation_id);
  } catch (error) {
    return reject(
      "review_rounds_generation_verification_failed",
      `ask event generation evidence failed canonical verification: ${error instanceof Error ? error.message : String(error)}`,
      [askEventPath],
    );
  }
  if (verified.project_id !== projectId) {
    return reject("review_rounds_foreign_round", "ask event generation belongs to another project", [askEventPath]);
  }
  const expectedReceiptPath = `09_output/social-review/generations/${askEvent.generation_id.slice("sha256:".length)}/review-ready-receipt.json`;
  if (askEvent.review_ready_receipt.sha256 !== verified.receipt_sha256
    || askEvent.review_ready_receipt.path !== expectedReceiptPath) {
    return reject("review_rounds_generation_verification_failed", "ask event review-ready receipt binding does not match the immutable generation", [askEventPath]);
  }
  if (askEvent.output.path !== verified.receipt.output.path || askEvent.output.sha256 !== verified.receipt.output.sha256) {
    return reject("review_rounds_generation_verification_failed", "ask event output path or hash does not bind the canonical generation output", [askEventPath]);
  }
  const canonicalQaReceiptPath = `09_output/social-review/generations/${askEvent.generation_id.slice("sha256:".length)}/review-qa-receipt.json`;
  if (askEvent.qa_receipt.path !== canonicalQaReceiptPath) {
    return reject("review_rounds_generation_verification_failed", "ask event QA receipt path does not bind the canonical generation QA location", [askEventPath]);
  }
  const qaReceiptPath = path.join(verified.generation_dir, "review-qa-receipt.json");
  // ONE immutable snapshot: hash and parsed document come from the same bytes.
  const qaInspection = inspectImmutableRecordFile(qaReceiptPath);
  if (!qaInspection.ok) {
    return reject("review_rounds_generation_verification_failed", `integrated QA receipt failed immutable inspection: ${qaInspection.reason}`, [qaReceiptPath]);
  }
  const qaReceiptSha256 = qaInspection.sha256;
  if (askEvent.qa_receipt.sha256 !== qaReceiptSha256) {
    return reject("review_rounds_generation_verification_failed", "integrated QA receipt hash differs from the durable Ask event binding", [qaReceiptPath]);
  }
  const integrated = qaInspection.document as Record<string, unknown> | null;
  const validation = integrated
    ? validateAgainstSchema(integrated, "review-qa-receipt.schema.json")
    : { valid: false, errors: [] };
  if (!integrated || !validation.valid) {
    return reject("review_rounds_generation_verification_failed", "integrated QA receipt is schema-invalid or unreadable", [qaReceiptPath]);
  }
  const identity = integrated.identity as Record<string, string> | undefined;
  const integratedStatus = integrated.status as string | undefined;
  if (!identity || !integratedStatus) {
    return reject("review_rounds_generation_verification_failed", "integrated QA receipt lacks identity or status", [qaReceiptPath]);
  }
  if (integratedStatus === "blocker" || askEvent.qa_receipt.status === "blocker") {
    return reject("review_rounds_qa_blocked", "QA status is blocker", [qaReceiptPath]);
  }
  const rehash = hashCanonical({ version: "review-identity/v1", ...identity });
  if (rehash !== integrated.review_identity || integrated.review_identity !== askEvent.review_identity) {
    return reject("review_rounds_generation_verification_failed", "integrated review identity does not rederive or match the Ask event", [qaReceiptPath]);
  }
  if (identity.generation_id !== askEvent.generation_id) {
    return reject("review_rounds_generation_mismatch", "integrated QA receipt binds a different generation", [qaReceiptPath]);
  }
  const artifacts = integrated.artifacts as Record<string, { path?: string; sha256?: string }> | undefined;
  if (!artifacts
    || identity.timeline_sha256 !== verified.receipt.inputs.canonical_timeline_sha256
    || identity.video_sha256 !== verified.receipt.output.sha256
    || artifacts.timeline?.sha256 !== identity.timeline_sha256
    || artifacts.review_video?.sha256 !== identity.video_sha256) {
    return reject("review_rounds_generation_verification_failed", "integrated QA receipt timeline/output bindings are inconsistent", [qaReceiptPath]);
  }
  if (askEvent.timeline.hash !== verified.receipt.inputs.canonical_timeline_sha256) {
    return reject("review_rounds_timeline_mismatch", "ask event timeline hash differs from the generation input identity", [askEventPath]);
  }
  if (askEvent.timeline.path !== timeline.path) {
    return reject("review_rounds_timeline_mismatch", "ask event binds a foreign timeline path", [askEventPath]);
  }
  if (askEvent.timeline.hash === timeline.hash && askEvent.timeline.version !== timeline.version) {
    return reject("review_rounds_timeline_mismatch", "ask event timeline version contradicts the canonical timeline", [askEventPath]);
  }
  return {
    askEvent,
    generation_id: askEvent.generation_id,
    review_identity: askEvent.review_identity,
    timeline: askEvent.timeline,
    output: askEvent.output,
    qa_receipt: { path: relativeify(projectDir, qaReceiptPath), sha256: qaReceiptSha256, status: integratedStatus },
    review_ready_receipt: askEvent.review_ready_receipt,
  };
}

function verifyCompletedRound(
  projectDir: string,
  projectId: string,
  timeline: { path: string; version: string; hash: string },
  pair: { round_index: number; ask: VerifiedRoundEvent; response: VerifiedRoundEvent },
  latest: { generation_id: string } | null,
  pushFlag: (code: string, message: string, evidence: string[]) => void,
): ReviewRoundEvidence {
  const reject = (code: string, message: string, evidence: string[]): never => {
    pushFlag(code, message, evidence);
    throw new Error(message);
  };
  const askEvent = pair.ask.event as ReviewRoundAskEvent;
  const responseEvent = pair.response.event as ReviewRoundResponseEvent;
  const askEventPath = `${REVIEW_ROUNDS_DIR}/${pair.ask.file}`;
  const responseEventPath = `${REVIEW_ROUNDS_DIR}/${pair.response.file}`;
  if (askEvent.project_id !== projectId || responseEvent.project_id !== projectId) {
    return reject("review_rounds_foreign_round", `round ${pair.round_index} binds a foreign project identity`, [askEventPath]);
  }
  if (responseEvent.ask_event !== pair.ask.identity) {
    return reject("review_rounds_history_conflict", `round ${pair.round_index} response does not bind its Ask event`, [responseEventPath]);
  }
  if (responseEvent.generation_id !== askEvent.generation_id || responseEvent.ask_id !== askEvent.ask_id) {
    return reject("review_rounds_generation_mismatch", `round ${pair.round_index} Ask and response bind different generations or Ask identities`, [responseEventPath]);
  }

  let verified;
  try {
    verified = verifyImmutableGenerationIdentity(projectDir, askEvent.generation_id);
  } catch (error) {
    return reject(
      "review_rounds_generation_verification_failed",
      `round ${pair.round_index} generation evidence failed canonical verification: ${error instanceof Error ? error.message : String(error)}`,
      [askEventPath],
    );
  }
  if (verified.project_id !== projectId) {
    return reject("review_rounds_foreign_round", `round ${pair.round_index} generation belongs to another project`, [askEventPath]);
  }
  const expectedReceiptPath = `09_output/social-review/generations/${askEvent.generation_id.slice("sha256:".length)}/review-ready-receipt.json`;
  if (askEvent.review_ready_receipt.sha256 !== verified.receipt_sha256
    || askEvent.review_ready_receipt.path !== expectedReceiptPath) {
    return reject("review_rounds_generation_verification_failed", `round ${pair.round_index} review-ready receipt binding does not match the immutable generation`, [askEventPath]);
  }
  // Path identity: hashes alone are insufficient — the Ask must bind the
  // canonical generation output and QA receipt locations.
  if (askEvent.output.path !== verified.receipt.output.path) {
    return reject("review_rounds_generation_verification_failed", `round ${pair.round_index} Ask output path does not bind the canonical generation output`, [askEventPath]);
  }
  const canonicalQaReceiptPath = `09_output/social-review/generations/${askEvent.generation_id.slice("sha256:".length)}/review-qa-receipt.json`;
  if (askEvent.qa_receipt.path !== canonicalQaReceiptPath) {
    return reject("review_rounds_generation_verification_failed", `round ${pair.round_index} Ask QA receipt path does not bind the canonical generation QA location`, [askEventPath]);
  }

  // The current generation must pass the full current review-ready gate.
  if (latest && latest.generation_id === askEvent.generation_id) {
    try {
      const current = verifyCurrentReviewReady(projectDir);
      if (current.state.generation_id !== askEvent.generation_id) throw new Error("review-ready state generation mismatch");
    } catch (error) {
      return reject(
        "review_rounds_current_state_invalid",
        `round ${pair.round_index} is the current generation but failed verifyCurrentReviewReady: ${error instanceof Error ? error.message : String(error)}`,
        ["06_review/review-ready-state.json"],
      );
    }
  }

  const qaReceiptPath = path.join(verified.generation_dir, "review-qa-receipt.json");
  // ONE immutable snapshot: hash and parsed document come from the same bytes.
  const qaInspection = inspectImmutableRecordFile(qaReceiptPath);
  if (!qaInspection.ok) {
    return reject("review_rounds_generation_verification_failed", `round ${pair.round_index} integrated QA receipt failed immutable inspection: ${qaInspection.reason}`, [qaReceiptPath]);
  }
  const integrated = qaInspection.document as Record<string, unknown>;
  const qaReceiptSha256 = qaInspection.sha256;
  if (askEvent.qa_receipt.sha256 !== qaReceiptSha256) {
    return reject("review_rounds_generation_verification_failed", `round ${pair.round_index} integrated QA receipt hash differs from the durable Ask event binding`, [qaReceiptPath]);
  }
  const validation = validateAgainstSchema(integrated, "review-qa-receipt.schema.json");
  if (!validation.valid) {
    return reject("review_rounds_generation_verification_failed", `round ${pair.round_index} integrated QA receipt is schema-invalid`, [qaReceiptPath]);
  }
  const identity = integrated.identity as Record<string, string> | undefined;
  const integratedStatus = integrated.status as string | undefined;
  if (!identity || !integratedStatus) {
    return reject("review_rounds_generation_verification_failed", `round ${pair.round_index} integrated QA receipt lacks identity or status`, [qaReceiptPath]);
  }
  if (integratedStatus === "blocker" || askEvent.qa_receipt.status === "blocker") {
    return reject("review_rounds_qa_blocked", `round ${pair.round_index} QA status is blocker`, [qaReceiptPath]);
  }
  const rehash = hashCanonical({ version: "review-identity/v1", ...identity });
  if (rehash !== integrated.review_identity || integrated.review_identity !== askEvent.review_identity) {
    return reject("review_rounds_generation_verification_failed", `round ${pair.round_index} integrated review identity does not rederive or match the Ask event`, [qaReceiptPath]);
  }
  if (identity.generation_id !== askEvent.generation_id) {
    return reject("review_rounds_generation_mismatch", `round ${pair.round_index} integrated QA receipt binds a different generation`, [qaReceiptPath]);
  }
  const artifacts = integrated.artifacts as Record<string, { path?: string; sha256?: string }> | undefined;
  if (!artifacts
    || identity.timeline_sha256 !== verified.receipt.inputs.canonical_timeline_sha256
    || identity.video_sha256 !== verified.receipt.output.sha256
    || artifacts.timeline?.sha256 !== identity.timeline_sha256
    || artifacts.review_video?.sha256 !== identity.video_sha256) {
    return reject("review_rounds_generation_verification_failed", `round ${pair.round_index} integrated QA receipt timeline/output bindings are inconsistent`, [qaReceiptPath]);
  }
  if (askEvent.output.sha256 !== identity.video_sha256) {
    return reject("review_rounds_generation_verification_failed", `round ${pair.round_index} Ask event output hash differs from the generation`, [askEventPath]);
  }
  if (askEvent.timeline.hash !== verified.receipt.inputs.canonical_timeline_sha256) {
    return reject("review_rounds_timeline_mismatch", `round ${pair.round_index} Ask event timeline hash differs from the generation input identity`, [askEventPath]);
  }
  if (askEvent.timeline.path !== timeline.path) {
    return reject("review_rounds_timeline_mismatch", `round ${pair.round_index} binds a foreign timeline path`, [askEventPath]);
  }
  if (askEvent.timeline.hash === timeline.hash && askEvent.timeline.version !== timeline.version) {
    return reject("review_rounds_timeline_mismatch", `round ${pair.round_index} timeline version contradicts the canonical timeline`, [askEventPath]);
  }
  // The response event must bind its own immutable durable response artifact;
  // detached/overwritten compatibility pointers are irrelevant.
  const artifactHash = responseEvent.artifact?.sha256;
  const artifactRelativePath = validateCanonicalResponseArtifactPath(responseEvent.artifact?.path);
  if (!artifactRelativePath
    || typeof artifactHash !== "string" || !SHA256.test(artifactHash)) {
    return reject("review_rounds_response_artifact_invalid", `round ${pair.round_index} response artifact reference is not canonical or lacks the durable binding`, [responseEventPath]);
  }
  const artifactPath = path.join(projectDir, artifactRelativePath);
  const artifactInspection = inspectImmutableRecordFile(artifactPath);
  if (!artifactInspection.ok) {
    return reject("review_rounds_response_artifact_invalid", `round ${pair.round_index} response artifact failed immutable-file inspection: ${artifactInspection.reason}`, [artifactRelativePath]);
  }
  if (artifactInspection.sha256 !== artifactHash) {
    return reject("review_rounds_response_artifact_invalid", `round ${pair.round_index} response artifact bytes/hash mismatch`, [artifactRelativePath]);
  }
  const artifact = artifactInspection.document as Record<string, unknown>;
  const artifactValidation = validateAgainstSchema(artifact, "review-round-response-artifact.schema.json");
  if (!artifactValidation.valid) {
    return reject("review_rounds_response_artifact_invalid", `round ${pair.round_index} response artifact is schema-invalid`, [artifactRelativePath]);
  }
  const artifactIdentity = hashCanonical(artifact);
  if (`${artifactIdentity.slice("sha256:".length)}.json` !== path.basename(artifactPath)) {
    return reject("review_rounds_response_artifact_invalid", `round ${pair.round_index} response artifact identity does not match its immutable filename`, [artifactRelativePath]);
  }
  const artifactDecision = artifact.decision as string | undefined;
  const artifactText = artifact.text === null ? null : typeof artifact.text === "string" ? artifact.text : undefined;
  if (artifact.project_id !== responseEvent.project_id
    || artifact.generation_id !== responseEvent.generation_id
    || artifact.review_identity !== responseEvent.review_identity
    || artifact.ask_event !== responseEvent.ask_event
    || artifact.ask_id !== responseEvent.ask_id
    || artifactDecision !== responseEvent.decision
    || artifactText === undefined || artifactText !== responseEvent.text
    || reviewRoundResponseHash({ ask_id: responseEvent.ask_id, decision: responseEvent.decision, text: artifactText }) !== responseEvent.response_sha256) {
    return reject("review_rounds_response_artifact_invalid", `round ${pair.round_index} response artifact contradicts the response event decision, text, or identity`, [artifactRelativePath]);
  }
  const artifactOutput = artifact.output as { path?: string; sha256?: string } | undefined;
  if (!artifactOutput
    || artifactOutput.sha256 !== verified.receipt.output.sha256
    || artifactOutput.path !== verified.receipt.output.path) {
    return reject("review_rounds_response_artifact_invalid", `round ${pair.round_index} response artifact output binding is relabeled or mismatched`, [artifactRelativePath]);
  }
  return {
    round_index: pair.round_index,
    round_identity: reviewRoundIdentity(pair.ask.identity, pair.response.identity),
    review_identity: askEvent.review_identity,
    generation_id: askEvent.generation_id,
    timeline: askEvent.timeline,
    output: askEvent.output,
    qa_receipt: { path: relativeify(projectDir, qaReceiptPath), sha256: qaReceiptSha256, status: integratedStatus },
    review_ready_receipt: askEvent.review_ready_receipt,
    ask: {
      event_identity: pair.ask.identity,
      event_path: askEventPath,
      ask_id: askEvent.ask_id,
      ask_payload_sha256: askEvent.ask_payload_sha256,
    },
    response: {
      event_identity: pair.response.identity,
      event_path: responseEventPath,
      decision: responseEvent.decision,
      response_sha256: responseEvent.response_sha256,
      artifact: {
        path: artifactRelativePath,
        sha256: artifactInspection.sha256,
      },
    },
  };
}

interface DiffSelection {
  diff: ValidatedRevisionDiff | null;
  reason: string | null;
}

function selectRevisionDiff(
  input: ReviewRoundsEvidence,
  projectDir: string,
  pushFlag: (code: string, message: string, evidence: string[]) => void,
  provenanceTimelineHashes: Set<string>,
  roundByRoundIdentity: Map<string, ReviewRoundEvidence>,
): DiffSelection {
  const candidates = [...input.revisionDiffCandidates]
    .sort((left, right) => left.localeCompare(right, "en"));
  if (candidates.length === 0) {
    return { diff: null, reason: "No human_revision_diff.yaml exists; dry-run exports are not treated as observed NLE edits." };
  }
  const valid: ValidatedRevisionDiff[] = [];
  for (const candidatePath of candidates) {
    const reject = (code: string, message: string): void => {
      pushFlag(code, message, [candidatePath]);
    };
    // ONE immutable read snapshot: parse and hash come from the exact same
    // bytes; symlink, hardlink, device, escape, and between-read changes are
    // rejected before any measurement use.
    const snapshot = inspectImmutableYamlFile(projectDir, candidatePath);
    if ("error" in snapshot) {
      reject("review_rounds_malformed_revision_diff", `${candidatePath} failed immutable-file inspection: ${snapshot.error}`);
      continue;
    }
    if (!snapshot.document || typeof snapshot.document !== "object" || Array.isArray(snapshot.document)) {
      reject("review_rounds_malformed_revision_diff", `${candidatePath} is not a mapping document`);
      continue;
    }
    const document = snapshot.document as Record<string, unknown>;
    const validation = validateAgainstSchema(document, "human-revision-diff.schema.json");
    if (!validation.valid) {
      reject("review_rounds_malformed_revision_diff", `${candidatePath} failed human-revision-diff schema validation: ${validation.errors.slice(0, 2).join("; ")}`);
      continue;
    }
    if (document.project_id !== input.projectId) {
      reject("review_rounds_foreign_revision_diff", `${candidatePath} binds a foreign project identity and cannot be measured`);
      continue;
    }
    const identity = document.identity as Record<string, unknown> | undefined;
    // Legacy version 1 diffs remain schema-valid but are never measured.
    if (document.version !== 2) {
      reject("review_rounds_unbound_revision_diff", `${candidatePath} is not a version 2 identity-bound diff; legacy artifacts are not measured`);
      continue;
    }
    // The handoff folder must equal the bound handoff identity.
    const handoffFolder = candidatePath.split("/").slice(-2, -1)[0];
    if (handoffFolder !== document.handoff_id) {
      reject("review_rounds_stale_revision_diff", `${candidatePath} handoff folder does not match its handoff identity`);
      continue;
    }
    // The top-level base timeline version must agree with the nested binding.
    const identityBaseTimeline = identity?.base_timeline as { version?: string } | undefined;
    if (document.base_timeline_version !== undefined && identityBaseTimeline
      && document.base_timeline_version !== identityBaseTimeline.version) {
      reject("review_rounds_stale_revision_diff", `${candidatePath} top-level base_timeline_version contradicts the identity binding`);
      continue;
    }
    if (!identity || typeof identity !== "object") {
      reject("review_rounds_unbound_revision_diff", `${candidatePath} lacks the immutable identity bindings required for measurement`);
      continue;
    }
    const baseTimeline = identity.base_timeline as { path?: string; version?: string; sha256?: string } | undefined;
    const reviewGeneration = identity.review_generation as { generation_id?: string; review_identity?: string; output?: { path?: string; sha256?: string }; review_ready_receipt?: { path?: string; sha256?: string } } | undefined;
    const reviewRound = identity.review_round as { round_index?: number; round_identity?: string } | undefined;
    if (!reviewRound?.round_identity || !SHA256.test(reviewRound.round_identity)
      || typeof reviewRound.round_index !== "number" || !Number.isInteger(reviewRound.round_index) || reviewRound.round_index < 1) {
      reject("review_rounds_unbound_revision_diff", `${candidatePath} lacks a resolvable review round identity`);
      continue;
    }
    const boundRound = roundByRoundIdentity.get(reviewRound.round_identity);
    if (!boundRound || boundRound.round_index !== reviewRound.round_index) {
      reject("review_rounds_stale_revision_diff", `${candidatePath} review round identity does not resolve to a verified round`);
      continue;
    }
    // The diff must bind ONE exact resolved round across every identity axis;
    // cross-round mixtures fail closed.
    if (!baseTimeline?.sha256 || !SHA256.test(baseTimeline.sha256) || baseTimeline.sha256 !== boundRound.timeline.hash) {
      reject("review_rounds_stale_revision_diff", `${candidatePath} base timeline identity does not match its resolved round`);
      continue;
    }
    // Path identity: hashes alone are insufficient — the recorded locations
    // must be the canonical ones for the resolved round.
    if (baseTimeline.path !== boundRound.timeline.path || baseTimeline.path !== input.timeline.path) {
      reject("review_rounds_stale_revision_diff", `${candidatePath} base timeline path is not the canonical timeline location`);
      continue;
    }
    if (baseTimeline.version !== undefined && baseTimeline.version !== boundRound.timeline.version) {
      reject("review_rounds_stale_revision_diff", `${candidatePath} base timeline version contradicts its resolved round`);
      continue;
    }
    if (!reviewGeneration?.generation_id || reviewGeneration.generation_id !== boundRound.generation_id) {
      reject("review_rounds_stale_revision_diff", `${candidatePath} generation binding does not match its resolved round`);
      continue;
    }
    const canonicalGenerationDir = `09_output/social-review/generations/${boundRound.generation_id.slice("sha256:".length)}`;
    if (reviewGeneration.output?.path !== `${canonicalGenerationDir}/review.mp4`
      || reviewGeneration.review_ready_receipt?.path !== `${canonicalGenerationDir}/review-ready-receipt.json`) {
      reject("review_rounds_stale_revision_diff", `${candidatePath} output or receipt path is not the canonical generation location`);
      continue;
    }
    if (!reviewGeneration.review_identity || reviewGeneration.review_identity !== boundRound.review_identity
      || !reviewGeneration.output?.sha256 || reviewGeneration.output.sha256 !== boundRound.output.sha256
      || !reviewGeneration.review_ready_receipt?.sha256 || reviewGeneration.review_ready_receipt.sha256 !== boundRound.review_ready_receipt.sha256) {
      reject("review_rounds_stale_revision_diff", `${candidatePath} review identity, output, or receipt binding does not match its resolved round`);
      continue;
    }
    try {
      const verified = verifyImmutableGenerationIdentity(projectDir, reviewGeneration.generation_id);
      if (verified.project_id !== input.projectId) throw new Error("generation belongs to another project");
      if (verified.receipt_sha256 !== reviewGeneration.review_ready_receipt.sha256) throw new Error("generation receipt hash binding mismatch");
      const integrated = JSON.parse(
        fs.readFileSync(path.join(verified.generation_dir, "review-qa-receipt.json"), "utf8"),
      ) as { review_identity?: string };
      if (integrated.review_identity !== reviewGeneration.review_identity) throw new Error("review identity binding mismatch");
    } catch (error) {
      reject("review_rounds_stale_revision_diff", `${candidatePath} generation binding failed verification: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    valid.push({
      relativePath: candidatePath,
      absolutePath: path.join(projectDir, candidatePath),
      sha256: snapshot.sha256,
      document,
      round: {
        round_index: boundRound.round_index,
        round_identity: reviewRound.round_identity,
        generation_id: reviewGeneration.generation_id,
      },
    });
  }
  if (valid.length === 0) {
    return { diff: null, reason: "Every human_revision_diff candidate is foreign, stale, or unbound; none may be measured." };
  }
  const distinctContents = new Set(valid.map((candidate) => candidate.sha256));
  if (distinctContents.size > 1) {
    pushFlag(
      "review_rounds_ambiguous_revision_diff",
      `multiple distinct identity-bound human_revision_diff candidates exist: ${valid.map((entry) => entry.relativePath).join(", ")}`,
      valid.map((entry) => entry.relativePath),
    );
    return { diff: null, reason: "Multiple distinct identity-bound human_revision_diff candidates exist; selection fails closed." };
  }
  valid.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));
  return { diff: valid[0]!, reason: null };
}

function uniqueSorted(paths: Array<string | null>): string[] {
  return [...new Set(paths.filter((item): item is string => Boolean(item)))].sort((left, right) => left.localeCompare(right, "en"));
}

export interface ResolvedDiffRound {
  round_index: number;
  round_identity: string;
  generation_id: string;
  review_identity: string;
  timeline: { path: string; version: string; hash: string };
  output: { path: string; sha256: string };
  review_ready_receipt: { path: string; sha256: string };
}

/**
 * Resolve a canonical human_revision_diff identity against the actual project
 * ledger: the bound round_identity must resolve to a VERIFIED round whose
 * generation, review identity, output, receipt, and timeline all match the
 * bound axes. Forged digits, round_index 999, or nonexistent hashes throw.
 */
export function resolveCanonicalDiffIdentity(
  projectDir: string,
  projectId: string,
  identity: {
    base_timeline: { path?: string; version?: string; sha256?: string };
    review_generation: { generation_id?: string; review_identity?: string; output?: { path?: string; sha256?: string }; review_ready_receipt?: { path?: string; sha256?: string } };
    review_round: { round_index?: number; round_identity?: string };
  },
): ResolvedDiffRound {
  const derivation = deriveReviewRoundsMetric({
    projectDir,
    projectId,
    timeline: readCanonicalTimelineIdentity(projectDir, projectId),
    askPointer: loadPointerJson(projectDir, "06_review/review-ask.json"),
    responsePointer: loadPointerJson(projectDir, "06_review/review-response.json"),
    revisionDiffCandidates: [],
  });
  if (derivation.metric.status !== "measured" || !derivation.metric.value) {
    throw new Error(`human_revision_diff identity cannot resolve: review history is not measurable (${derivation.metric.limitations[0]})`);
  }
  const rounds = derivation.metric.value.rounds;
  const bound = rounds.find((round) => round.round_identity === identity.review_round?.round_identity);
  if (!bound) {
    throw new Error(`human_revision_diff round identity does not resolve to a verified round: ${String(identity.review_round?.round_identity)}`);
  }
  if (identity.review_round?.round_index !== bound.round_index) {
    throw new Error(`human_revision_diff round_index ${String(identity.review_round?.round_index)} does not match the resolved round ${bound.round_index}`);
  }
  const resolvedGenerationDir = `09_output/social-review/generations/${bound.generation_id.slice("sha256:".length)}`;
  if (identity.review_generation?.generation_id !== bound.generation_id
    || identity.review_generation?.review_identity !== bound.review_identity
    || identity.review_generation?.output?.sha256 !== bound.output.sha256
    || identity.review_generation?.output?.path !== bound.output.path
    || identity.review_generation?.review_ready_receipt?.sha256 !== bound.review_ready_receipt.sha256
    || identity.review_generation?.review_ready_receipt?.path !== bound.review_ready_receipt.path
    || identity.base_timeline?.sha256 !== bound.timeline.hash
    || identity.base_timeline?.version !== bound.timeline.version
    || identity.base_timeline?.path !== bound.timeline.path) {
    throw new Error("human_revision_diff identity axes do not match the resolved round");
  }
  if (identity.review_generation?.output?.path !== `${resolvedGenerationDir}/review.mp4`
    || identity.review_generation?.review_ready_receipt?.path !== `${resolvedGenerationDir}/review-ready-receipt.json`
    || identity.base_timeline?.path !== "05_timeline/timeline.json") {
    throw new Error("human_revision_diff identity paths are not the canonical generation locations");
  }
  return {
    round_index: bound.round_index,
    round_identity: bound.round_identity,
    generation_id: bound.generation_id,
    review_identity: bound.review_identity,
    timeline: bound.timeline,
    output: bound.output,
    review_ready_receipt: bound.review_ready_receipt,
  };
}

function readCanonicalTimelineIdentity(projectDir: string, projectId: string): { path: string; version: string; hash: string } {
  const absolutePath = path.join(projectDir, "05_timeline/timeline.json");
  // ONE read: parse and hash come from the same captured bytes.
  const bytes = fs.readFileSync(absolutePath);
  const timeline = JSON.parse(bytes.toString("utf8")) as { project_id?: string; version?: unknown };
  if (timeline.project_id !== projectId) {
    throw new Error(`canonical timeline project ${String(timeline.project_id)} does not match ${projectId}`);
  }
  return {
    path: "05_timeline/timeline.json",
    version: String(timeline.version ?? "unknown"),
    hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

function loadPointerJson(projectDir: string, relativePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(path.join(projectDir, relativePath), "utf8"));
  } catch {
    return null;
  }
}
