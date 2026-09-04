import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  draftAndPromote,
  initCommand,
  isCommandError,
  transitionState,
  validateAgainstSchema,
  validatePlainData,
  type CommandError,
  type DraftFile,
} from "../shared.js";
import { ProgressTracker } from "../../progress.js";
import type {
  ApprovalRecord,
  HumanCorrectionApprovalBinding,
  ProjectState,
} from "../../state/reconcile.js";
import {
  computeFileHash,
  snapshotArtifacts,
  writeProjectState,
  ARTIFACT_IDENTITY_HASH_KEYS,
  type ArtifactHashes,
} from "../../state/reconcile.js";
import type { CompileResult } from "../../compiler/index.js";
import type { TimelineIR } from "../../compiler/types.js";
import { readCreativeBriefAutonomyMode } from "../../autonomy.js";
import {
  runReviewMetrics,
  type ReviewMetricsArtifact,
} from "../../review/metrics.js";
import {
  HIGH_CONFIDENCE_THRESHOLD,
  UNSUPPORTED_CONFIDENCE_CEILING,
  DEGRADED_CONFIDENCE_CEILING,
  type ConfidenceBasis,
} from "../../eval/brief-alignment-types.js";
import {
  evaluateReviewVisualQA,
  isReviewVisualQAApprovalGrade,
  reviewVisualQAGateReason,
  reviewVisualQAMinScore,
  summarizeReviewVisualQAGate,
  timelineHasVisualClips,
  type EvaluateReviewVisualQAOptions,
  type ReviewVisualQA,
} from "../../review/visual-qa.js";
import {
  runReviewExistingTimelinePreflight,
  runReviewPreflight,
} from "./preflight.js";
import { readAuthoredCaptionStatus } from "../../caption/authored-lyrics.js";
import type { CreativeBrief } from "../../artifacts/types.js";
import {
  evaluateWholeCutSemantic,
  isWholeCutSemanticApprovalGrade,
  validateWholeCutSemanticIdentity,
  wholeCutSemanticGateReason,
  type WholeCutSemanticOptions,
  type WholeCutSemanticReview,
} from "../../review/whole-cut-semantic.js";
import type { MarlinQAReport } from "../../eval/marlin-qa-types.js";
import {
  normalizeHumanCorrections,
  type HumanCorrectionReason,
  type NormalizedHumanCorrection,
} from "../../review/human-corrections.js";
import {
  deriveReviewRoundsMetric,
  inspectImmutableYamlFile,
  listRevisionDiffCandidates,
} from "../../eval/review-rounds.js";
import { inspectImmutableRecordFile } from "../../review/review-rounds-ledger.js";

export interface ReviewReport {
  version: string;
  project_id: string;
  timeline_version: string;
  created_at?: string;
  summary_judgment: {
    status: "approved" | "needs_revision" | "blocked";
    rationale: string;
    confidence?: number;
    confidence_basis?: ConfidenceBasis;
  };
  strengths: Array<{
    summary: string;
    details?: string;
    evidence?: string[];
    affected_beat_ids?: string[];
    affected_clip_ids?: string[];
  }>;
  weaknesses: Array<{
    summary: string;
    details?: string;
    evidence?: string[];
    affected_beat_ids?: string[];
    affected_clip_ids?: string[];
  }>;
  fatal_issues: Array<{
    summary: string;
    severity: "fatal";
    details?: string;
    evidence?: string[];
    affected_beat_ids?: string[];
    affected_clip_ids?: string[];
  }>;
  warnings: Array<{
    summary: string;
    severity: "warning";
    details?: string;
    evidence?: string[];
    affected_beat_ids?: string[];
    affected_clip_ids?: string[];
  }>;
  mismatches_to_brief: Array<{
    expected_ref: string;
    observed_issue: string;
    why_it_matters: string;
    evidence?: string[];
    affected_beat_ids?: string[];
    affected_clip_ids?: string[];
  }>;
  mismatches_to_blueprint: Array<{
    expected_ref: string;
    observed_issue: string;
    why_it_matters: string;
    evidence?: string[];
    affected_beat_ids?: string[];
    affected_clip_ids?: string[];
  }>;
  recommended_next_pass: {
    goal: string;
    actions: string[];
    preserve?: string[];
    alternative_directions?: string[];
  };
  editorial_judgments?: EditorialJudgment[];
  preview_path?: string;
  visual_qa?: ReviewVisualQA;
  visual_qa_waiver?: boolean;
  visual_qa_waiver_reason?: string;
  visual_qa_waiver_created_at?: string;
  whole_cut_semantic?: WholeCutSemanticReview;
  normalized_human_corrections?: NormalizedHumanCorrection[];
}

export interface SourceEvidenceRef {
  kind: "source_range" | "frame" | "transcript_span" | "metadata" | "artifact_ref";
  ref: string;
  sha256?: string;
}

export interface ClarificationQuestion {
  question: string;
  observation: string;
  hypothesis: string;
}

export interface JudgmentUncertainty {
  description: string;
  impact: "high" | "low";
  clarification_question?: ClarificationQuestion;
}

export interface JudgmentAlternative {
  label?: string;
  description: string;
  grounds: string[];
  risks: string[];
}

export interface EditorialJudgment {
  observation: string;
  inference: string;
  editorial_intent: string;
  evidence: SourceEvidenceRef[];
  confidence: number;
  confidence_basis: ConfidenceBasis;
  uncertainty?: JudgmentUncertainty;
  alternatives?: JudgmentAlternative[];
  affected_beat_ids?: string[];
  affected_clip_ids?: string[];
}

/** Confidence ceiling applied to judgments whose claims are not supported. */
export const JUDGMENT_UNSUPPORTED_CONFIDENCE_CEILING = UNSUPPORTED_CONFIDENCE_CEILING;

/**
 * Canonical review report contract version. Version "2" reports are required
 * to carry a non-empty editorial_judgments envelope (schema-enforced and
 * generation-enforced). Version "1" reports without the envelope are legacy
 * and may only be consumed through the explicit migration route below.
 */
export const CANONICAL_REVIEW_REPORT_VERSION = "2";

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizedText(value: string): string {
  const tokens = value.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return tokens.sort().join("\u0000");
}

const SEMANTIC_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is",
  "it", "of", "on", "or", "that", "the", "their", "this", "to", "was", "were",
  "with", "while",
]);

function semanticToken(token: string): string {
  if (token.length > 5 && (token.endsWith("ied") || token.endsWith("ies"))) {
    return `${token.slice(0, -3)}y`;
  }
  if (token.length > 5 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith("ed")) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith("es")) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s")) return token.slice(0, -1);
  return token;
}

/**
 * Catch a short paraphrase that restates the same claim across two judgment
 * fields. This is intentionally conservative: exact normalized equality is
 * handled above; the heuristic requires at least two meaningful stemmed
 * tokens shared by most of the shorter field, so ordinary subject reuse does
 * not erase a genuinely distinct inference or intent.
 */
function semanticallyEquivalentText(left: string, right: string): boolean {
  const meaningful = (value: string): Set<string> => new Set(
    (value.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
      .filter((token) => !SEMANTIC_STOP_WORDS.has(token))
      .map(semanticToken),
  );
  const leftTokens = meaningful(left);
  const rightTokens = meaningful(right);
  if (leftTokens.size < 2 || rightTokens.size < 2) return false;
  let overlap = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) overlap += 1;
  return overlap >= 2 && overlap / Math.min(leftTokens.size, rightTokens.size) >= 2 / 3;
}

function isGroundedAlternative(alternative: JudgmentAlternative): boolean {
  return hasText(alternative.description) &&
    Array.isArray(alternative.grounds) &&
    alternative.grounds.length > 0 &&
    alternative.grounds.every((item) => hasText(item)) &&
    Array.isArray(alternative.risks) &&
    alternative.risks.length > 0 &&
    alternative.risks.every((item) => hasText(item));
}

function hasValidClarificationQuestion(uncertainty: JudgmentUncertainty): boolean {
  const question = uncertainty.clarification_question;
  return !!question &&
    hasText(question.question) &&
    hasText(question.observation) &&
    hasText(question.hypothesis);
}

function judgmentClipIds(judgment: EditorialJudgment): string[] | undefined {
  return judgment.affected_clip_ids && judgment.affected_clip_ids.length > 0
    ? judgment.affected_clip_ids
    : undefined;
}

function pushIntegrityWarning(report: ReviewReport, summary: string, details: string, evidence?: string[]): void {
  if (report.warnings.some((item) => item.summary === summary)) return;
  report.warnings.push({
    summary,
    severity: "warning",
    details,
    ...(evidence && evidence.length > 0 ? { evidence } : {}),
  });
}

function demoteJudgmentConfidence(judgment: EditorialJudgment): void {
  judgment.confidence = Math.min(judgment.confidence, JUDGMENT_UNSUPPORTED_CONFIDENCE_CEILING);
  judgment.confidence_basis = "unmeasured";
}

function sha256File(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

const EVIDENCE_TIME_RANGE_FRAGMENT = /^t=\d+(?:\.\d+)?,\d+(?:\.\d+)?$/;
const EVIDENCE_FRAME_FRAGMENT = /^frame=\d+$/;
const METADATA_EVIDENCE_PATH = /^(02_media|03_analysis)\/[A-Za-z0-9][A-Za-z0-9._-]*\.(json|ya?ml)$/i;

function evidenceKindReferenceError(
  kind: unknown,
  relative: string,
  fragment: string,
  isMedia: boolean,
): string | null {
  switch (kind) {
    case "source_range":
      if (!isMedia) return "source_range evidence must reference a media file";
      if (!EVIDENCE_TIME_RANGE_FRAGMENT.test(fragment)) {
        return "source_range evidence must use a #t=start,end fragment (media time ranges)";
      }
      return null;
    case "frame":
      if (!isMedia) return "frame evidence must reference a media file";
      if (!EVIDENCE_FRAME_FRAGMENT.test(fragment)) {
        return "frame evidence must use a #frame=index fragment on a media file";
      }
      return null;
    case "transcript_span":
      if (!/\.(json|ya?ml)$/i.test(relative) || !hasText(fragment)) {
        return "transcript_span evidence must reference a structured artifact fragment";
      }
      return null;
    case "metadata":
      if (!METADATA_EVIDENCE_PATH.test(relative) || hasText(fragment) && fragment.includes("/")) {
        return "metadata evidence must reference a canonical metadata artifact";
      }
      return null;
    case "artifact_ref":
      return null;
    default:
      return "evidence kind is not supported";
  }
}

/**
 * Contextual canonical artifacts: they exist in the canonical artifact layout
 * and can be referenced (with exact id binding), but the system does not
 * record a hash identity for them in ArtifactHashes, so they can never back a
 * measured confidence claim — only degraded/unmeasured context.
 */
const CONTEXTUAL_ARTIFACT_PATHS = new Set([
  "03_analysis/segments.json",
  "03_analysis/assets.json",
  "03_analysis/analysis_coverage_report.json",
  "03_analysis/search/footage.db",
  "02_media/source_media_manifest.json",
]);

/** Media source evidence (source_range/frame) accepted as context only. */
const MEDIA_EVIDENCE_PATH =
  /^02_media\/[A-Za-z0-9][A-Za-z0-9._-]*\.(mp4|mov|m4v|webm|mkv|avi|mp3|wav|m4a|aac|flac|ogg|oga|opus|png|jpg|jpeg|webp|bmp|tif|tiff)$/i;

const STRUCTURED_ID_KEY = /(^|_)id$/i;

export interface EvidenceValidationIssue {
  index: number;
  ref: string;
  reason: string;
}

export interface EvidenceVerificationResult {
  /** Refs bound to a tracked canonical artifact with matching recorded identity. */
  verified: SourceEvidenceRef[];
  /** Refs accepted as context (canonical but not identity-tracked); they can never back measured confidence. */
  contextual: SourceEvidenceRef[];
  /** Refs that must not be trusted at all: nonexistent, symlinked, escaping, non-allowlist, stale or foreign. */
  invalid: EvidenceValidationIssue[];
}

function collectStructuredIds(value: unknown, ids: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectStructuredIds(item, ids);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (typeof val === "string") {
        if (STRUCTURED_ID_KEY.test(key)) ids.add(val);
      } else {
        collectStructuredIds(val, ids);
      }
    }
  }
}

/**
 * Parse the artifact structure and require the fragment to be an exact id
 * contained in it. Substring containment is never accepted: "seg_001" does
 * not bind to an artifact that only carries "seg_0010".
 */
function bindFragmentExactly(resolved: string, fragment: string, relative: string): string | null {
  if (relative.endsWith(".json")) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(resolved, "utf-8"));
      const ids = new Set<string>();
      collectStructuredIds(parsed, ids);
      return ids.has(fragment) ? null : "fragment id is not exactly bound in the artifact";
    } catch {
      return "artifact is not readable for id binding";
    }
  }
  if (relative.endsWith(".yaml") || relative.endsWith(".yml")) {
    try {
      const parsed: unknown = parseYaml(fs.readFileSync(resolved, "utf-8"));
      const ids = new Set<string>();
      collectStructuredIds(parsed, ids);
      return ids.has(fragment) ? null : "fragment id is not exactly bound in the artifact";
    } catch {
      return "artifact is not readable for id binding";
    }
  }
  // Artifacts without machine-readable ids (md, db, binary) carry no fragments.
  return "artifact type carries no machine-readable fragment ids";
}

/**
 * Issue #32 M0 evidence binding (audit amendment 2): evidence must resolve to
 * a real file inside the current project via lstat/realpath (symlinks are
 * rejected outright), on an authoritative allowlist of canonical artifact
 * paths/types. Tracked canonical artifacts are additionally verified against
 * the recorded project artifact identity, so a foreign or stale copy that
 * merely self-consistently hashes itself cannot remain measured. Fragment ids
 * must match exactly against the parsed artifact structure.
 */
export function validateSourceEvidenceRefs(
  evidence: SourceEvidenceRef[],
  projectDir: string,
  identityHashes?: ArtifactHashes,
): EvidenceVerificationResult {
  const verified: SourceEvidenceRef[] = [];
  const contextual: SourceEvidenceRef[] = [];
  const invalid: EvidenceValidationIssue[] = [];
  const absProjectDir = path.resolve(projectDir);
  let realProjectDir: string;
  try {
    realProjectDir = fs.realpathSync(absProjectDir);
  } catch {
    return {
      verified: [],
      contextual: [],
      invalid: evidence.map((entry, index) => ({
        index,
        ref: String(entry?.ref ?? ""),
        reason: "project directory could not be resolved",
      })),
    };
  }

  evidence.forEach((entry, index) => {
    const reject = (reason: string) => invalid.push({ index, ref: String(entry?.ref ?? ""), reason });
    const hashIndex = hasText(entry.ref) ? entry.ref.indexOf("#") : -1;
    const rawPath = hashIndex === -1 ? entry.ref : entry.ref.slice(0, hashIndex);
    const fragment = hashIndex === -1 ? "" : entry.ref.slice(hashIndex + 1);

    if (!hasText(rawPath)) {
      reject("ref carries no artifact path");
      return;
    }
    if (path.isAbsolute(rawPath)) {
      reject("absolute path outside the project");
      return;
    }
    const relative = path.normalize(rawPath);
    if (relative.startsWith("..")) {
      reject("path escapes the project directory");
      return;
    }

    // Classify against the authoritative allowlist before touching the
    // filesystem: paths outside the canonical artifact set are rejected
    // regardless of whether a file happens to exist there.
    // Prototype-chain-safe lookup: inherited keys like "constructor",
    // "toString", "valueOf", or "hasOwnProperty" must never classify a ref.
    const identityKey = Object.hasOwn(ARTIFACT_IDENTITY_HASH_KEYS, relative)
      ? ARTIFACT_IDENTITY_HASH_KEYS[relative]
      : undefined;
    const isContextual = CONTEXTUAL_ARTIFACT_PATHS.has(relative);
    const isMedia = MEDIA_EVIDENCE_PATH.test(relative);
    if (!identityKey && !isContextual && !isMedia) {
      reject("path is not in the canonical artifact allowlist");
      return;
    }
    const kindError = evidenceKindReferenceError(entry.kind, relative, fragment, isMedia);
    if (kindError) {
      reject(kindError);
      return;
    }

    const resolved = path.resolve(absProjectDir, relative);
    if (resolved !== absProjectDir && !resolved.startsWith(absProjectDir + path.sep)) {
      reject("path escapes the project directory");
      return;
    }

    // Containment: lstat the entry (reject symlinks) and verify the fully
    // resolved target stays inside the real project directory.
    let lstat: fs.Stats;
    try {
      lstat = fs.lstatSync(resolved);
    } catch {
      reject("artifact does not exist in the project");
      return;
    }
    if (lstat.isSymbolicLink()) {
      reject("symlinked evidence is not allowed");
      return;
    }
    if (!lstat.isFile()) {
      reject("evidence ref must point to a file");
      return;
    }
    try {
      const realFile = fs.realpathSync(resolved);
      if (realFile !== realProjectDir && !realFile.startsWith(realProjectDir + path.sep)) {
        reject("resolved target is outside the project directory");
        return;
      }
    } catch {
      reject("artifact path could not be resolved");
      return;
    }

    if (hasText(fragment)) {
      if (isMedia) {
        const fragmentValid = entry.kind === "frame"
          ? EVIDENCE_FRAME_FRAGMENT.test(fragment)
          : entry.kind === "source_range" && EVIDENCE_TIME_RANGE_FRAGMENT.test(fragment);
        if (!fragmentValid) {
          reject(entry.kind === "frame"
            ? "frame evidence fragments must use the canonical frame form (frame=N)"
            : "source_range evidence fragments must be time ranges (t=start,end)");
          return;
        }
      } else {
        // Non-media fragments must bind exactly to the parsed artifact structure.
        const bindError = bindFragmentExactly(resolved, fragment, relative);
        if (bindError) {
          reject(bindError);
          return;
        }
      }
    }

    if (identityKey) {
      // Tracked canonical artifact: identity comes from the system, never from
      // the ref itself. A self-hashed stale or foreign copy fails here.
      const recorded = identityHashes?.[identityKey];
      if (!hasText(recorded)) {
        contextual.push(entry);
        return;
      }
      try {
        if (computeFileHash(resolved) !== recorded) {
          reject("artifact identity mismatch (stale or foreign copy)");
          return;
        }
      } catch {
        reject("artifact identity could not be computed");
        return;
      }
      if (hasText(entry.sha256)) {
        try {
          if (entry.sha256 !== sha256File(resolved)) {
            reject("sha256 mismatch (stale or foreign artifact)");
            return;
          }
        } catch {
          reject("sha256 could not be computed for the artifact");
          return;
        }
      }
      verified.push(entry);
      return;
    }

    if (CONTEXTUAL_ARTIFACT_PATHS.has(relative) || isMedia) {
      if (hasText(entry.sha256)) {
        try {
          if (entry.sha256 !== sha256File(resolved)) {
            reject("sha256 mismatch (stale or foreign artifact)");
            return;
          }
        } catch {
          reject("sha256 could not be computed for the artifact");
          return;
        }
      }
      contextual.push(entry);
      return;
    }

    reject("path is not in the canonical artifact allowlist");
  });

  return { verified, contextual, invalid };
}

/**
 * Issue #32 M0 canonical truth contract for editorial judgments.
 *
 * Mutates the in-memory report so that:
 * - evidence refs resolve through lstat/realpath inside the project (no
 *   symlinks), on the authoritative canonical artifact allowlist, with exact
 *   fragment id binding — tracked artifacts additionally verified against the
 *   recorded project identity so stale/foreign self-hashed copies fail;
 * - measured confidence requires every ref to be identity-verified: invalid
 *   refs demote to unmeasured, untracked-but-canonical refs demote to
 *   degraded (refs stay on the judgment for audit, flagged by warning);
 * - observation / inference / editorial intent are never conflated
 *   (identical text across the fields demotes the judgment);
 * - degraded or unmeasured claims are capped at 0.5 (provider-absence rule);
 * - high confidence (>= HIGH_CONFIDENCE_THRESHOLD, boundary inclusive)
 *   requires a measured basis and verified evidence;
 * - alternatives without grounds and risks are dropped;
 * - high-impact uncertainty without a concrete clarification question that
 *   carries an observation and a hypothesis becomes a fatal issue (blocks
 *   approval), while low-impact uncertainty stays non-blocking;
 * - summary confidence may only rise above 0.5 on verified evidence
 *   (verified visual QA or an evidence-backed measured judgment).
 */
export function enforceReviewJudgmentIntegrity(
  report: ReviewReport,
  projectDir: string,
  identityHashes?: ArtifactHashes,
): void {
  const judgments = report.editorial_judgments ?? [];

  judgments.forEach((judgment, index) => {
    const label = `Editorial judgment #${index + 1}`;

    let evidenceCheck: EvidenceVerificationResult | null = null;
    if (Array.isArray(judgment.evidence) && judgment.evidence.length > 0) {
      evidenceCheck = validateSourceEvidenceRefs(judgment.evidence, projectDir, identityHashes);
      if (evidenceCheck.invalid.length > 0) {
        // Refs stay on the judgment for audit transparency; the demotion and
        // warning are what enforce the truth contract — an unmeasured judgment
        // whose refs failed project binding can never read as supported.
        if (judgment.confidence_basis === "measured") {
          demoteJudgmentConfidence(judgment);
        }
        pushIntegrityWarning(
          report,
          `${label} referenced evidence that could not be verified in the project`,
          "Nonexistent, symlinked, escaping, non-allowlist, stale, or foreign evidence refs were detected. The judgment can no longer claim measured confidence until its evidence binds to a current project artifact.",
          evidenceCheck.invalid.map((item) => `${item.ref} (${item.reason})`),
        );
      } else if (evidenceCheck.contextual.length > 0 && judgment.confidence_basis === "measured") {
        // Context-only evidence (canonical but not identity-tracked) cannot
        // carry a measured claim: demote to the degraded ceiling.
        judgment.confidence = Math.min(judgment.confidence, DEGRADED_CONFIDENCE_CEILING);
        judgment.confidence_basis = "degraded";
        pushIntegrityWarning(
          report,
          `${label} evidence is not bound to recorded project artifact identity`,
          "Evidence on canonical artifacts without a recorded project identity (analysis artifacts, media) can only support degraded confidence. Measured claims require identity-verified tracked artifacts.",
          evidenceCheck.contextual.map((item) => item.ref),
        );
      }
    }

    const sameClaim = (left: unknown, right: unknown): boolean =>
      hasText(left) && hasText(right) &&
      (normalizedText(left) === normalizedText(right) || semanticallyEquivalentText(left, right));
    const conflated =
      sameClaim(judgment.observation, judgment.inference) ||
      sameClaim(judgment.inference, judgment.editorial_intent) ||
      sameClaim(judgment.observation, judgment.editorial_intent);
    if (conflated) {
      demoteJudgmentConfidence(judgment);
      pushIntegrityWarning(
        report,
        `${label} conflates observation, inference, and editorial intent`,
        "Observation, inference, and editorial intent must be stated separately. The judgment confidence was demoted to unmeasured because the fields do not separate what was seen from what was concluded.",
      );
    }

    if ((judgment.confidence_basis === "degraded" || judgment.confidence_basis === "unmeasured") &&
      judgment.confidence > DEGRADED_CONFIDENCE_CEILING) {
      judgment.confidence = DEGRADED_CONFIDENCE_CEILING;
      pushIntegrityWarning(
        report,
        `${label} claimed confidence above the degraded ceiling`,
        "Degraded or unmeasured confidence claims must stay at or below 0.5. The claim was capped.",
      );
    }

    const verifiedBacked = !!evidenceCheck &&
      evidenceCheck.invalid.length === 0 &&
      evidenceCheck.contextual.length === 0 &&
      evidenceCheck.verified.length > 0;
    if (judgment.confidence >= HIGH_CONFIDENCE_THRESHOLD &&
      (judgment.confidence_basis !== "measured" || !verifiedBacked)) {
      demoteJudgmentConfidence(judgment);
      pushIntegrityWarning(
        report,
        `${label} claimed high confidence without measured evidence`,
        "High confidence (0.70 or above) requires a measured basis and identity-verified source evidence. The claim was demoted to unmeasured instead of being presented as supported.",
      );
    }

    if (judgment.confidence >= 1) {
      // Interpretive judgment (observation + inference + intent) is never
      // absolutely certain, even with verified evidence: absolute confidence
      // claims are capped and flagged instead of promoted unchanged.
      judgment.confidence = 0.99;
      pushIntegrityWarning(
        report,
        `${label} claimed absolute confidence`,
        "Editorial judgment is interpretive; absolute confidence (1.0) is not attainable even on verified evidence. The claim was capped at 0.99.",
      );
    }

    if (Array.isArray(judgment.alternatives)) {
      const grounded = judgment.alternatives.filter(isGroundedAlternative);
      const dropped = judgment.alternatives.length - grounded.length;
      if (dropped > 0) {
        judgment.alternatives = grounded;
        pushIntegrityWarning(
          report,
          `${label} dropped ${dropped} alternative(s) without grounds and risks`,
          "Alternatives must state their grounds and their risks. Entries without both were removed rather than compared as if they were grounded.",
        );
      }
    }

    const uncertainty = judgment.uncertainty;
    if (uncertainty && hasText(uncertainty.description) && uncertainty.impact !== "low") {
      // Fail-safe: only an explicit low impact is non-blocking. High-impact
      // (or unclassified) uncertainty requires a concrete, answerable
      // clarification question anchored to an observation and a hypothesis.
      if (!hasValidClarificationQuestion(uncertainty)) {
        if (!report.fatal_issues.some((item) => item.summary === `${label} has high-impact uncertainty without an actionable clarification question`)) {
          report.fatal_issues.push({
            summary: `${label} has high-impact uncertainty without an actionable clarification question`,
            severity: "fatal",
            details: "High-impact uncertainty must produce a concrete clarification question that states the observed fact and the hypothesis to confirm or refute. Resolve the uncertainty or downgrade its impact before approval.",
            evidence: [uncertainty.description],
            ...(judgmentClipIds(judgment) ? { affected_clip_ids: judgmentClipIds(judgment) } : {}),
          });
        }
        demoteJudgmentConfidence(judgment);
      }
    }
  });

  const summary = report.summary_judgment;
  if (typeof summary.confidence === "number" && summary.confidence > DEGRADED_CONFIDENCE_CEILING) {
    const explicitBasis = summary.confidence_basis;
    const measuredJudgment = judgments.some((judgment) => {
      if (judgment.confidence_basis !== "measured" ||
        !Array.isArray(judgment.evidence) || judgment.evidence.length === 0) return false;
      const { verified, contextual, invalid } = validateSourceEvidenceRefs(judgment.evidence, projectDir, identityHashes);
      return invalid.length === 0 && contextual.length === 0 && verified.length > 0;
    });
    const visualVerified = report.visual_qa?.status === "verified";
    const unsupportedByBasis = explicitBasis === "degraded" || explicitBasis === "unmeasured";
    if (unsupportedByBasis || (!visualVerified && !measuredJudgment)) {
      summary.confidence = DEGRADED_CONFIDENCE_CEILING;
      if (!summary.confidence_basis) {
        summary.confidence_basis = "degraded";
      }
      summary.rationale = appendRationale(
        summary.rationale,
        "Summary confidence capped at 0.50: no verified visual evaluation or evidence-backed measured judgment supports a higher claim.",
      );
    }
  }
}

export interface ReviewReportReadResult {
  report: ReviewReport;
  /**
   * True when the report predates the version 2 canonical contract and was
   * accepted through this explicit legacy migration path. Legacy reports keep
   * version "1": they are read-compatible only and can never be re-promoted
   * as canonical without regenerating the judgment envelope.
   */
  legacy: boolean;
}

/** Authoritative identity a canonical (version 2) report must exactly match. */
export interface CanonicalReportIdentity {
  project_id: string;
  timeline_version: string;
}

/**
 * Explicit legacy read/migration route for review reports. Fails closed:
 * - non-object input, unknown versions, and schema-invalid reports are
 *   rejected outright;
 * - version "1" is accepted only when fully schema-valid (explicit legacy);
 * - version "2" is accepted only when fully schema-valid including the
 *   non-empty editorial judgment envelope;
 * - when an authoritative identity is supplied, the report's project_id and
 *   timeline_version must exactly match it — foreign or stale identity is
 *   rejected and never rewritten.
 */
export function migrateReviewReport(
  input: unknown,
  expectedIdentity?: CanonicalReportIdentity,
): ReviewReportReadResult | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const plainData = validatePlainData(input);
  if (!plainData.valid) return null;
  const version = (input as Record<string, unknown>).version;
  if (version !== "1" && version !== CANONICAL_REVIEW_REPORT_VERSION) return null;
  const validation = validateAgainstSchema(input, "review-report.schema.json");
  if (!validation.valid) return null;
  if (expectedIdentity) {
    const report = input as ReviewReport;
    if (!hasText(report.project_id) || report.project_id !== expectedIdentity.project_id) return null;
    if (!hasText(report.timeline_version) || report.timeline_version !== expectedIdentity.timeline_version) return null;
  }
  if (version === CANONICAL_REVIEW_REPORT_VERSION) {
    // Belt-and-braces: schema already enforces this for version 2.
    const judgments = (input as { editorial_judgments?: unknown }).editorial_judgments;
    if (!Array.isArray(judgments) || judgments.length === 0) return null;
    return { report: input as ReviewReport, legacy: false };
  }
  return { report: input as ReviewReport, legacy: true };
}

export class CanonicalReviewReportGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalReviewReportGateError";
  }
}

/**
 * The single shared canonicalization/acceptance gate for every door that can
 * move a review report into canonical state (runReview generation, reentry
 * promotion). It validates structure and schema, requires the canonical
 * version and a non-empty judgment envelope, and requires the report identity
 * to exactly match the authoritative project/timeline identity — untrusted
 * output is never rewritten.
 *
 * Report-supplied visual QA context is stripped here: only the executing door
 * may attach visual QA truth after its own evaluation. Soft truth-contract
 * violations (conflation, unverified evidence, unsupported confidence,
 * ungrounded alternatives, unactionable high-impact uncertainty) are not hard
 * failures — both doors then normalize them through the shared
 * enforceReviewJudgmentIntegrity and persist the demotions and warnings.
 */
export function enforceCanonicalReviewReportGate(
  input: unknown,
  expectedIdentity: CanonicalReportIdentity,
): ReviewReport {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new CanonicalReviewReportGateError("review report must be an object");
  }
  const plainData = validatePlainData(input);
  if (!plainData.valid) {
    throw new CanonicalReviewReportGateError(
      `review report must contain plain own-property data: ${plainData.errors.join("; ")}`,
    );
  }
  const report = input as ReviewReport;
  if (report.version !== CANONICAL_REVIEW_REPORT_VERSION) {
    throw new CanonicalReviewReportGateError(
      `review report must declare version "${CANONICAL_REVIEW_REPORT_VERSION}" (canonical review contract); got ${JSON.stringify(report.version ?? null)}`,
    );
  }
  const validation = validateAgainstSchema(report, "review-report.schema.json");
  if (!validation.valid) {
    throw new CanonicalReviewReportGateError(
      `review report failed schema validation: ${validation.errors.join("; ")}`,
    );
  }
  if (!Array.isArray(report.editorial_judgments) || report.editorial_judgments.length === 0) {
    throw new CanonicalReviewReportGateError(
      "editorial_judgments must contain at least one grounded judgment (canonical review contract v2). Agents must observe, infer, and state editorial intent with source evidence before a review can be promoted.",
    );
  }
  if (!hasText(expectedIdentity.project_id) || report.project_id !== expectedIdentity.project_id) {
    throw new CanonicalReviewReportGateError(
      "review report project_id does not exactly match the canonical project identity; untrusted report identity is never rewritten",
    );
  }
  if (!hasText(expectedIdentity.timeline_version) || expectedIdentity.timeline_version === "unknown" ||
    String(report.timeline_version ?? "") !== String(expectedIdentity.timeline_version)) {
    throw new CanonicalReviewReportGateError(
      "review report timeline_version does not exactly match the current canonical timeline version; stale or foreign timeline identity fails closed",
    );
  }
  // Report-supplied visual QA is never trusted.
  const untrusted = report as unknown as Record<string, unknown>;
  delete untrusted.visual_qa;
  delete untrusted.visual_qa_waiver;
  delete untrusted.visual_qa_waiver_reason;
  delete untrusted.visual_qa_waiver_created_at;
  return report;
}

export interface PatchOperation {
  op: "replace_segment" | "trim_segment" | "move_segment" | "insert_segment"
    | "remove_segment" | "change_audio_policy" | "add_marker" | "add_note";
  target_clip_id?: string;
  with_segment_id?: string;
  new_src_in_us?: number;
  new_src_out_us?: number;
  new_timeline_in_frame?: number;
  new_duration_frames?: number;
  reason: string;
  confidence?: number;
  evidence?: string[];
  audio_policy?: {
    duck_music_db?: number;
    preserve_nat_sound?: boolean;
    fade_in_frames?: number;
    fade_out_frames?: number;
  };
  beat_id?: string;
  role?: string;
  label?: string;
}

export interface ReviewPatch {
  timeline_version: string;
  operations: PatchOperation[];
}

export interface HumanNote {
  id: string;
  timestamp: string;
  reviewer: string;
  observation: string;
  severity: "observation" | "suggestion" | "concern";
  correction_reason?: HumanCorrectionReason;
  directive_type?: "observation" | "replace_segment" | "insert_segment"
    | "remove_segment" | "move_segment" | "trim_segment";
  clip_ids?: string[];
  clip_refs?: string[];
  evidence_refs?: string[];
  approved_segment_ids?: string[];
  timeline_in_frame?: number;
  timeline_us?: number;
  timeline_tc?: string;
}

export interface HumanNotes {
  version: string | number;
  project_id: string;
  notes: HumanNote[];
}

export interface ReviewAgent {
  run(ctx: ReviewAgentContext): Promise<ReviewAgentResult>;
}

export interface ReviewAgentContext {
  projectDir: string;
  projectId: string;
  currentState: ProjectState;
  timelineVersion: string;
  humanNotes: HumanNotes | null;
  normalizedHumanCorrections: NormalizedHumanCorrection[];
  styleMd: string | null;
  /** Canonical full rough output; preview-first30s.mp4 is never semantic authority. */
  wholeCutRenderPath: string;
  /** Whole-cut semantic result evaluated by the command, never agent-supplied. */
  wholeCutSemantic: WholeCutSemanticReview;
  /** Brief-derived minimum/work-specific axes the critic must cover. */
  briefDerivedAxes: WholeCutSemanticReview["brief"]["axes"];
  /** Full scene report emitted by visual QA when available. */
  visualQA: ReviewVisualQA;
  visualQASceneReport: MarlinQAReport["scene_descriptions"];
}

export interface ReviewAgentResult {
  report: ReviewReport;
  patch: ReviewPatch;
}

export interface PatchSafetyResult {
  safe: boolean;
  rejectedOps: Array<{
    opIndex: number;
    op: string;
    reason: string;
  }>;
  filteredPatch: ReviewPatch;
}

interface HumanInsertDirective {
  segmentId: string;
  clipIds: string[];
  timelineInFrame?: number;
  timelineUs?: number;
}

export interface ReviewCommandResult {
  success: boolean;
  error?: CommandError;
  report?: ReviewReport;
  patch?: ReviewPatch;
  patchSafety?: PatchSafetyResult;
  reviewMetrics?: ReviewMetricsArtifact;
  wholeCutSemantic?: WholeCutSemanticReview;
  compileResult?: CompileResult;
  preflight?: ReviewPreflightResult;
  previousState?: ProjectState;
  newState?: ProjectState;
  promoted?: string[];
  approvalRecord?: ApprovalRecord;
}

export interface ReviewPreflightStep {
  step: "compile" | "preview" | "qc" | "metrics" | "visual_qa" | "whole_cut_semantic";
  status: "completed" | "skipped";
  detail: string;
  artifactPath?: string;
}

export interface ReviewPreflightResult {
  steps: ReviewPreflightStep[];
  gapReport: string[];
  previewPath?: string;
  overviewPath?: string;
  qcSummaryPath: string;
  metricsPath?: string;
  wholeCutRenderPath?: string;
}

export interface ReviewOperatorDecision {
  accepted: boolean;
  approvedBy?: string;
}

export type ReviewOperatorAccept = (ctx: {
  projectDir: string;
  projectId: string;
  report: ReviewReport;
  patch: ReviewPatch;
  patchSafety: PatchSafetyResult;
  preflight: ReviewPreflightResult;
}) => Promise<ReviewOperatorDecision> | ReviewOperatorDecision;

export interface ReviewCommandOptions {
  creativeOverride?: boolean;
  approvedBy?: string;
  overrideReason?: string;
  createdAt?: string;
  operatorAccept?: ReviewOperatorAccept;
  requireCompiledTimeline?: boolean;
  skipPreview?: boolean;
  render?: boolean;
  allowUnverifiedVisual?: boolean;
  visualQaWaiverReason?: string;
  visualQaMinScore?: number;
  visualQA?: Omit<EvaluateReviewVisualQAOptions, "render" | "minScore" | "createdAt">;
  wholeCutSemantic?: WholeCutSemanticOptions;
}

function isReviewApprovalEligible(report: ReviewReport, visualApplicable: boolean): boolean {
  return report.fatal_issues.length === 0 &&
    report.summary_judgment.status === "approved" &&
    isReviewVisualQAApprovalGrade(report, visualApplicable);
}

function enforceVisualQAVerdict(report: ReviewReport, visualApplicable: boolean): void {
  const visual = report.visual_qa;
  const gateReason = reviewVisualQAGateReason(report, visualApplicable);
  const gateSummary = visual ? summarizeReviewVisualQAGate(visual) : gateReason;

  if (gateReason && report.summary_judgment.status === "approved") {
    report.summary_judgment.status = visual?.status === "verified" ? "needs_revision" : "blocked";
  }

  if (gateSummary) {
    report.summary_judgment.rationale = appendRationale(
      report.summary_judgment.rationale,
      `Visual QA gate: ${gateSummary}.`,
    );
  }

  if (report.visual_qa_waiver && report.visual_qa_waiver_reason) {
    report.summary_judgment.rationale = appendRationale(
      report.summary_judgment.rationale,
      `Visual QA waiver: ${report.visual_qa_waiver_reason}.`,
    );
  }
}

function enforceWholeCutSemanticVerdict(
  report: ReviewReport,
  wholeCutSemantic: WholeCutSemanticReview,
): void {
  const gateReason = wholeCutSemanticGateReason(wholeCutSemantic);
  if (!gateReason) return;

  if (report.summary_judgment.status === "approved") {
    report.summary_judgment.status = wholeCutSemantic.status === "verified" ? "needs_revision" : "blocked";
  }
  const shouldCapConfidence = report.summary_judgment.confidence === undefined ||
    report.summary_judgment.confidence > DEGRADED_CONFIDENCE_CEILING ||
    report.summary_judgment.confidence_basis === "measured";
  if (shouldCapConfidence) {
    report.summary_judgment.confidence = DEGRADED_CONFIDENCE_CEILING;
    report.summary_judgment.confidence_basis = "degraded";
    report.summary_judgment.rationale = appendRationale(
      report.summary_judgment.rationale,
      "Summary confidence capped at 0.50: no whole-cut semantic evidence supports a higher claim.",
    );
  }
  report.summary_judgment.rationale = appendRationale(
    report.summary_judgment.rationale,
    `Whole-cut semantic gate: ${gateReason}. Visual QA status and scene counts cannot substitute for unsupported semantic evidence.`,
  );
}

export function enforceReviewMetricVerdict(
  report: ReviewReport,
  metrics: ReviewMetricsArtifact | undefined,
): void {
  const dialogue = metrics?.checks.find((check) => check.id === "story.dialogue_completeness");
  if (!dialogue || dialogue.status === "pass" || dialogue.status === "skipped") return;

  const summary = dialogue.status === "fail"
    ? "Dialogue selection contains an incomplete assertion"
    : "Dialogue selection may depend on missing context";
  const evidence = dialogue.evidence.slice(0, 12);
  const affectedClipIds = dialogueClipIds(dialogue.measured);

  if (dialogue.status === "fail") {
    if (!report.fatal_issues.some((item) => item.summary === summary)) {
      report.fatal_issues.push({
        summary,
        severity: "fatal",
        details: "Deterministic transcript review found a dependent opening or unfinished ending. Expand or replace the source window before approval.",
        evidence,
        ...(affectedClipIds.length > 0 ? { affected_clip_ids: affectedClipIds } : {}),
      });
    }
    if (report.summary_judgment.status === "approved") {
      report.summary_judgment.status = "needs_revision";
    }
  } else if (!report.warnings.some((item) => item.summary === summary)) {
    report.warnings.push({
      summary,
      severity: "warning",
      details: "The line may omit an antecedent or use a conversational continuation. Confirm it remains understandable in sequence.",
      evidence,
      ...(affectedClipIds.length > 0 ? { affected_clip_ids: affectedClipIds } : {}),
    });
  }

  report.summary_judgment.rationale = appendRationale(
    report.summary_judgment.rationale,
    `Dialogue completeness gate: ${dialogue.status}.`,
  );
}

function dialogueClipIds(measured: unknown): string[] {
  if (!measured || typeof measured !== "object" || Array.isArray(measured)) return [];
  const findings = (measured as Record<string, unknown>).findings;
  if (!Array.isArray(findings)) return [];
  return [...new Set(findings.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const clipId = (item as Record<string, unknown>).clip_id;
    return typeof clipId === "string" && clipId ? [clipId] : [];
  }))];
}

function appendRationale(current: string, addition: string): string {
  return current.includes(addition) ? current : `${current} ${addition}`.trim();
}

/**
 * Context passed to a critic is read-only command evidence. Keep the helper
 * local to this route so command-owned values cannot be changed through a
 * shared nested reference after the agent returns.
 */
function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object") return value;
  const objectValue = value as object;
  if (seen.has(objectValue)) return value;
  seen.add(objectValue);
  for (const key of Reflect.ownKeys(objectValue)) {
    deepFreeze(Reflect.get(objectValue, key), seen);
  }
  return Object.freeze(value);
}

function cloneAndFreeze<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

export function validatePatchSafety(
  patch: ReviewPatch,
  timelineJson: unknown,
  humanNotes: HumanNotes | null,
): PatchSafetyResult {
  const rejectedOps: PatchSafetyResult["rejectedOps"] = [];
  const safeOps: PatchOperation[] = [];
  const fallbackMap = buildFallbackMap(timelineJson);
  const humanApprovedSegments = buildHumanApprovedSegments(humanNotes);
  const humanInsertDirectives = buildHumanInsertDirectives(humanNotes);

  for (let i = 0; i < patch.operations.length; i++) {
    const op = patch.operations[i];
    if (op.op === "replace_segment") {
      const isValid = validateReplaceSegment(op, fallbackMap, humanApprovedSegments);
      if (!isValid) {
        rejectedOps.push({
          opIndex: i,
          op: op.op,
          reason: `with_segment_id "${op.with_segment_id}" is not in fallback_segment_ids of "${op.target_clip_id}" and not in human_notes approved_segment_ids`,
        });
        continue;
      }
    }

    if (op.op === "insert_segment") {
      const isValid = validateInsertSegment(op, humanInsertDirectives);
      if (!isValid) {
        rejectedOps.push({
          opIndex: i,
          op: op.op,
          reason: `insert_segment for "${op.with_segment_id}" has no human_notes directive with directive_type: insert_segment and machine-readable timeline anchor`,
        });
        continue;
      }
    }

    safeOps.push(op);
  }

  return {
    safe: rejectedOps.length === 0,
    rejectedOps,
    filteredPatch: {
      timeline_version: patch.timeline_version,
      operations: safeOps,
    },
  };
}

function buildFallbackMap(timelineJson: unknown): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (!timelineJson || typeof timelineJson !== "object") return map;

  const timeline = timelineJson as {
    tracks?: {
      video?: Array<{ clips?: Array<{ clip_id?: string; fallback_segment_ids?: string[] }> }>;
      audio?: Array<{ clips?: Array<{ clip_id?: string; fallback_segment_ids?: string[] }> }>;
    };
  };

  const trackGroups = [timeline.tracks?.video, timeline.tracks?.audio].filter(Boolean);
  for (const group of trackGroups) {
    for (const track of group!) {
      for (const clip of track.clips ?? []) {
        if (clip.clip_id) {
          map.set(clip.clip_id, clip.fallback_segment_ids ?? []);
        }
      }
    }
  }

  return map;
}

function buildHumanApprovedSegments(
  humanNotes: HumanNotes | null,
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  if (!humanNotes) return map;

  for (const note of humanNotes.notes) {
    if (note.directive_type === "replace_segment" && note.approved_segment_ids) {
      for (const clipId of note.clip_ids ?? []) {
        if (!map.has(clipId)) map.set(clipId, new Set());
        for (const segmentId of note.approved_segment_ids) {
          map.get(clipId)!.add(segmentId);
        }
      }
    }
  }

  return map;
}

function buildHumanInsertDirectives(
  humanNotes: HumanNotes | null,
): Map<string, HumanInsertDirective[]> {
  const directives = new Map<string, HumanInsertDirective[]>();
  if (!humanNotes) return directives;

  for (const note of humanNotes.notes) {
    if (
      note.directive_type === "insert_segment" &&
      note.approved_segment_ids &&
      (
        note.timeline_in_frame !== undefined ||
        note.timeline_us !== undefined ||
        (note.clip_ids?.length ?? 0) > 0
      )
    ) {
      for (const segmentId of note.approved_segment_ids) {
        const entry: HumanInsertDirective = {
          segmentId,
          clipIds: note.clip_ids ?? [],
          timelineInFrame: note.timeline_in_frame,
          timelineUs: note.timeline_us,
        };
        if (!directives.has(segmentId)) directives.set(segmentId, []);
        directives.get(segmentId)!.push(entry);
      }
    }
  }

  return directives;
}

function validateReplaceSegment(
  op: PatchOperation,
  fallbackMap: Map<string, string[]>,
  humanApprovedSegments: Map<string, Set<string>>,
): boolean {
  if (!op.target_clip_id || !op.with_segment_id) return false;
  const fallbacks = fallbackMap.get(op.target_clip_id);
  if (fallbacks?.includes(op.with_segment_id)) {
    return true;
  }
  return humanApprovedSegments.get(op.target_clip_id)?.has(op.with_segment_id) ?? false;
}

function validateInsertSegment(
  op: PatchOperation,
  humanInsertDirectives: Map<string, HumanInsertDirective[]>,
): boolean {
  if (!op.with_segment_id) return false;
  const directives = humanInsertDirectives.get(op.with_segment_id) ?? [];
  return directives.some((directive) => {
    const frameMatches = directive.timelineInFrame !== undefined &&
      op.new_timeline_in_frame === directive.timelineInFrame;
    const clipMatches = directive.clipIds.length > 0 &&
      !!op.target_clip_id &&
      directive.clipIds.includes(op.target_clip_id);
    return frameMatches || clipMatches;
  });
}

const ALLOWED_STATES: ProjectState[] = [
  "blueprint_ready",
  "timeline_drafted",
  "critique_ready",
];

export async function runReview(
  projectDir: string,
  agent: ReviewAgent,
  options?: ReviewCommandOptions,
): Promise<ReviewCommandResult> {
  const pt = new ProgressTracker(projectDir, "review", 6);
  const ctx = initCommand(projectDir, "/review", ALLOWED_STATES);
  if (isCommandError(ctx)) {
    pt.fail("init", ctx.message);
    return { success: false, error: ctx };
  }
  pt.advance();

  const { projectDir: absDir, reconcileResult, doc } = ctx;
  const previousState = doc.current_state;
  const projectId = doc.project_id || "";
  const gates = reconcileResult.gates;
  const fail = (
    stage: string,
    error: CommandError,
    extras: Omit<ReviewCommandResult, "success" | "error"> = {},
  ): ReviewCommandResult => {
    pt.fail(stage, error.message);
    return {
      success: false,
      error,
      previousState,
      ...extras,
    };
  };

  const autonomyMode = readCreativeBriefAutonomyMode(absDir);
  if (!autonomyMode) {
    return fail("brief", {
      code: "GATE_CHECK_FAILED",
      message: "creative_brief.yaml not found. Run /intent first.",
    });
  }
  const creativeBriefResult = readCreativeBrief(absDir);
  if (creativeBriefResult.error || !creativeBriefResult.brief) {
    return fail("brief", creativeBriefResult.error ?? {
      code: "VALIDATION_FAILED",
      message: "creative_brief.yaml could not be loaded for whole-cut semantic review.",
    });
  }
  const creativeBrief = creativeBriefResult.brief;

  const authoredCaptionStatus = readAuthoredCaptionStatus(absDir);
  if (authoredCaptionStatus.detected && authoredCaptionStatus.status !== "ready") {
    return fail("caption", {
      code: "GATE_CHECK_FAILED",
      message: `Authored caption gate is ${authoredCaptionStatus.status}: ${authoredCaptionStatus.reason}. Run the displayed caption command and keep human caption approval explicit before review.`,
      details: {
        unmatched_line_ids: authoredCaptionStatus.unmatched_line_ids,
        low_confidence_line_ids: authoredCaptionStatus.low_confidence_line_ids,
        preview_path: authoredCaptionStatus.preview_path,
        next_command: authoredCaptionStatus.next_command,
      },
    });
  }
  const authoredCaptionReady = authoredCaptionStatus.detected && authoredCaptionStatus.status === "ready";

  if (gates.compile_gate === "blocked") {
    return fail("gate", {
      code: "GATE_CHECK_FAILED",
      message: "Compile gate is blocked — unresolved blockers with status 'blocker' exist. Resolve blockers before running /review.",
      details: { compile_gate: gates.compile_gate },
    });
  }

  if (gates.planning_gate === "blocked") {
    return fail("gate", {
      code: "GATE_CHECK_FAILED",
      message: "Planning gate is blocked — uncertainty_register has status 'blocker' entries. Resolve planning blockers before running /review.",
      details: { planning_gate: gates.planning_gate },
    });
  }

  const createdAt = options?.createdAt ?? new Date().toISOString();
  let compileResult: CompileResult;
  let timelineJson: unknown;
  let timelineVersion = "unknown";
  let preflight: ReviewPreflightResult;
  let reviewMetrics: ReviewMetricsArtifact | undefined;
  let wholeCutSemantic: WholeCutSemanticReview;
  const skipPreview = options?.skipPreview ?? false;
  const visualQaMinScore = options?.visualQaMinScore ?? reviewVisualQAMinScore(options?.visualQA?.repoRoot);
  if (options?.allowUnverifiedVisual && !options.visualQaWaiverReason?.trim()) {
    return fail("visual_qa", {
      code: "VALIDATION_FAILED",
      message: "--allow-unverified-visual requires visual_qa_waiver_reason",
    });
  }

  try {
    if (options?.requireCompiledTimeline || authoredCaptionReady) {
      if (gates.timeline_gate === "blocked") {
        return fail("preflight", {
          code: "GATE_CHECK_FAILED",
          message: "Timeline gate is blocked — run /compile before running /review.",
          details: { timeline_gate: gates.timeline_gate },
        });
      }
      const preflightResult = await runReviewExistingTimelinePreflight(absDir, createdAt, skipPreview);
      compileResult = preflightResult.compileResult;
      timelineJson = preflightResult.timelineJson;
      timelineVersion = preflightResult.timelineVersion;
      preflight = preflightResult.preflight;
    } else {
      const preflightResult = await runReviewPreflight(absDir, createdAt, skipPreview);
      compileResult = preflightResult.compileResult;
      timelineJson = preflightResult.timelineJson;
      timelineVersion = preflightResult.timelineVersion;
      preflight = preflightResult.preflight;
    }
  } catch (err) {
    return fail("preflight", {
      code: "GATE_CHECK_FAILED",
      message: `Deterministic preflight failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  if (authoredCaptionReady) {
    const projectedStatus = readAuthoredCaptionStatus(absDir);
    if (projectedStatus.status !== "ready") {
      return fail("caption", {
        code: "GATE_CHECK_FAILED",
        message: `Authored caption projection became stale before review: ${projectedStatus.reason}. Run ${projectedStatus.next_command}.`,
        details: {
          projected_timeline_hash: projectedStatus.projected_timeline_hash,
          current_timeline_hash: projectedStatus.current_timeline_hash,
          next_command: projectedStatus.next_command,
        },
      }, { compileResult, preflight });
    }
  }

  try {
    const metricsResult = runReviewMetrics(absDir, {
      timeline: compileResult.timeline as TimelineIR,
    });
    reviewMetrics = metricsResult.metrics;
    preflight.metricsPath = metricsResult.outputPath;
    preflight.steps.push({
      step: "metrics",
      status: "completed",
      detail: "Generated deterministic review_metrics.json before critic review.",
      artifactPath: metricsResult.outputPath,
    });
  } catch (err) {
    return fail("metrics", {
      code: "GATE_CHECK_FAILED",
      message: `Deterministic review metrics failed: ${err instanceof Error ? err.message : String(err)}`,
    }, {
      compileResult,
      preflight,
    });
  }
  pt.advance("review_metrics.json");

  const visualQA = await evaluateReviewVisualQA(absDir, {
    ...options?.visualQA,
    render: options?.render === true,
    minScore: visualQaMinScore,
    createdAt,
  });
  const visualQaApplicable = timelineHasVisualClips(
    path.join(absDir, "05_timeline/timeline.json"),
  );
  preflight.steps.push({
    step: "visual_qa",
    status: visualQA.status === "verified" ? "completed" : "skipped",
    detail: `Visual QA ${summarizeReviewVisualQAGate(visualQA)}.`,
    ...(visualQA.marlin_report_path ? { artifactPath: path.join(absDir, visualQA.marlin_report_path) } : {}),
  });
  pt.advance("visual_qa");

  try {
    wholeCutSemantic = await evaluateWholeCutSemantic(
      absDir,
      creativeBrief,
      timelineJson,
      {
        ...options?.wholeCutSemantic,
        createdAt,
        // A production review with render enabled must make the full rough
        // output available. The first-30-second preview remains a visual
        // orientation artifact only.
        renderIfMissing: options?.wholeCutSemantic?.renderIfMissing ?? options?.render === true,
        assembleTimelineToMp4Impl: options?.wholeCutSemantic?.assembleTimelineToMp4Impl ?? options?.visualQA?.assembleTimelineToMp4Impl,
      },
    );
  } catch (err) {
    return fail("whole_cut_semantic", {
      code: "GATE_CHECK_FAILED",
      message: `Whole-cut semantic evaluation failed: ${err instanceof Error ? err.message : String(err)}`,
    }, {
      compileResult,
      preflight,
      reviewMetrics,
    });
  }
  // Keep one immutable command-owned result. The critic receives a separate
  // frozen clone and can never rewrite the evidence later used for report
  // attachment, semantic gating, or approval.
  wholeCutSemantic = cloneAndFreeze(wholeCutSemantic);
  const agentWholeCutSemantic = cloneAndFreeze(wholeCutSemantic);
  const wholeCutRenderPath = path.join(absDir, wholeCutSemantic.render.path);
  preflight.wholeCutRenderPath = wholeCutRenderPath;
  preflight.steps.push({
    step: "whole_cut_semantic",
    status: wholeCutSemantic.status === "verified" ? "completed" : "skipped",
    detail: `Whole-cut semantic review ${wholeCutSemantic.status}; coverage ${wholeCutSemantic.coverage.status}; provider ${wholeCutSemantic.provider.capability}.`,
    artifactPath: wholeCutRenderPath,
  });
  pt.advance("whole_cut_semantic");

  const humanNotesResult = readHumanNotes(absDir);
  if (humanNotesResult.error) {
    return fail("human_notes", humanNotesResult.error, {
      compileResult,
      preflight,
      reviewMetrics,
    });
  }
  const humanNotes = humanNotesResult.humanNotes;
  const commandOwnedHumanNotes = humanNotes ? cloneAndFreeze(humanNotes) : null;
  const normalizedHumanCorrections = humanNotes
    ? normalizeHumanCorrections(humanNotes, {
        sourcePath: "06_review/human_notes.yaml",
        sourceSha256: humanNotesResult.sourceSha256 ?? "",
      })
    : [];
  const commandOwnedNormalizedHumanCorrections = cloneAndFreeze(normalizedHumanCorrections);
  const agentNormalizedHumanCorrections = cloneAndFreeze(commandOwnedNormalizedHumanCorrections);
  const commandOwnedVisualQA = cloneAndFreeze(visualQA);
  const agentVisualQA = cloneAndFreeze(commandOwnedVisualQA);
  const agentBriefDerivedAxes = cloneAndFreeze(wholeCutSemantic.brief.axes);
  const agentVisualQASceneReport = cloneAndFreeze(commandOwnedVisualQA.scene_report ?? []);
  const styleMd = readStyleMd(absDir);
  const promoteGuardHashes = snapshotArtifacts(absDir).hashes;

  const agentContext: ReviewAgentContext = cloneAndFreeze({
    projectDir: absDir,
    projectId,
    currentState: previousState,
    timelineVersion,
    humanNotes: commandOwnedHumanNotes,
    normalizedHumanCorrections: agentNormalizedHumanCorrections,
    styleMd,
    wholeCutRenderPath,
    wholeCutSemantic: agentWholeCutSemantic,
    briefDerivedAxes: agentBriefDerivedAxes,
    visualQA: agentVisualQA,
    visualQASceneReport: agentVisualQASceneReport,
  });
  const agentResult = await agent.run(agentContext);
  pt.advance();

  const patchSafety = validatePatchSafety(
    agentResult.patch,
    timelineJson,
    commandOwnedHumanNotes,
  );
  const safePatch = patchSafety.filteredPatch;

  // Canonical report identity gate — shared with the reentry promotion route.
  // The report must declare version 2, pass full schema validation, carry a
  // non-empty judgment envelope, and exactly match the authoritative project
  // identity and the current canonical timeline version. Untrusted agent
  // output is never rewritten; mismatch or missing identity fails closed
  // before integrity normalization or any promotion, leaving prior canonical
  // artifacts untouched.
  const canonicalReportIdentity = {
    project_id: projectId,
    timeline_version: String(timelineVersion ?? ""),
  };
  // Agents may describe their findings, but cannot supply or forge the
  // command-evaluated whole-cut evidence. The command attaches its own result
  // after the shared v2 report identity gate.
  delete (agentResult.report as unknown as Record<string, unknown>).whole_cut_semantic;
  delete (agentResult.report as unknown as Record<string, unknown>).normalized_human_corrections;
  try {
    agentResult.report = enforceCanonicalReviewReportGate(agentResult.report, canonicalReportIdentity);
  } catch (err) {
    return fail("review", {
      code: "VALIDATION_FAILED",
      message: err instanceof Error ? err.message : String(err),
    }, {
      compileResult,
      preflight,
      reviewMetrics,
    });
  }
  agentResult.report.whole_cut_semantic = wholeCutSemantic;
  agentResult.report.normalized_human_corrections = commandOwnedNormalizedHumanCorrections;

  if (preflight.previewPath) {
    agentResult.report.preview_path = path.relative(absDir, preflight.previewPath);
  }
  agentResult.report.visual_qa = commandOwnedVisualQA;
  if (options?.allowUnverifiedVisual) {
    agentResult.report.visual_qa_waiver = true;
    agentResult.report.visual_qa_waiver_reason = options.visualQaWaiverReason!.trim();
    agentResult.report.visual_qa_waiver_created_at = createdAt;
  }
  enforceReviewMetricVerdict(agentResult.report, reviewMetrics);
  enforceVisualQAVerdict(agentResult.report, visualQaApplicable);
  try {
    enforceWholeCutSemanticReportGate(wholeCutSemantic, absDir);
  } catch (err) {
    return fail("whole_cut_semantic", {
      code: "VALIDATION_FAILED",
      message: err instanceof Error ? err.message : String(err),
    }, {
      compileResult,
      preflight,
      reviewMetrics,
    });
  }
  enforceWholeCutSemanticVerdict(agentResult.report, wholeCutSemantic);
  // Evidence identity binds to the post-compile artifact snapshot (the same
  // snapshot that guards promotion), not the pre-compile recorded state: a
  // freshly compiled timeline is the current canonical timeline and must be
  // able to support measured evidence. Race-guard semantics are unchanged.
  enforceReviewJudgmentIntegrity(agentResult.report, absDir, promoteGuardHashes);

  const drafts: DraftFile[] = [
    {
      relativePath: "06_review/review_report.yaml",
      schemaFile: "review-report.schema.json",
      content: agentResult.report,
      format: "yaml",
      serializedContentGate: (parsed) => {
        enforceCanonicalReviewReportGate(parsed, canonicalReportIdentity);
        const nested = (parsed as ReviewReport).whole_cut_semantic;
        if (!nested) throw new Error("whole_cut_semantic is required on the canonical /review path");
        enforceWholeCutSemanticReportGate(nested, absDir);
      },
    },
    {
      relativePath: "06_review/review_patch.json",
      schemaFile: "review-patch.schema.json",
      content: safePatch,
      format: "json",
    },
  ];

  const promoteResult = draftAndPromote(absDir, drafts, {
    preflightHashes: promoteGuardHashes,
    guardKeys: [
      "brief_hash",
      "blockers_hash",
      "selects_hash",
      "blueprint_hash",
      "uncertainty_hash",
      "timeline_version",
      "human_notes_hash",
      "style_hash",
      "review_report_version",
      "review_patch_hash",
    ],
  });
  pt.advance("review_report.yaml");
  if (!promoteResult.success) {
    const code = promoteResult.failure_kind === "validation"
      ? "VALIDATION_FAILED"
      : "PROMOTE_FAILED";
    const message = promoteResult.failure_kind === "concurrent_edit"
      ? `Artifact promote aborted due to concurrent edits: ${promoteResult.errors.join("; ")}`
      : promoteResult.failure_kind === "promote"
        ? `Artifact promote failed: ${promoteResult.errors.join("; ")}`
        : `Artifact validation failed: ${promoteResult.errors.join("; ")}`;
    return fail("promote", {
      code,
      message,
      details: promoteResult.errors,
    }, {
      compileResult,
      preflight,
      reviewMetrics,
    });
  }

  // The promoted review artifacts are part of the approval binding. Refresh
  // the persisted snapshot before recording approval so the next reconcile
  // does not mistake this command's own review update for an external edit
  // and immediately mark the new approval stale.
  doc.artifact_hashes = snapshotArtifacts(absDir).hashes;

  const hasFatal = agentResult.report.fatal_issues.length > 0;
  const approvalEligible = isReviewApprovalEligible(agentResult.report, visualQaApplicable) &&
    isWholeCutSemanticApprovalGrade(wholeCutSemantic);
  const visualGateReason = reviewVisualQAGateReason(agentResult.report, visualQaApplicable);
  const semanticGateReason = wholeCutSemanticGateReason(wholeCutSemantic);
  let newState: ProjectState;
  let approvalRecord: ApprovalRecord | undefined;

  if (hasFatal && options?.creativeOverride && (!options.approvedBy || !options.overrideReason)) {
    return fail("approval", {
      code: "VALIDATION_FAILED",
      message: "Creative override requires approved_by and override_reason",
    });
  }

  if (semanticGateReason) {
    newState = "critique_ready";
  } else if (hasFatal && !options?.creativeOverride) {
    newState = "critique_ready";
  } else if (hasFatal && options?.creativeOverride) {
    if (!options.approvedBy || !options.overrideReason) {
      return fail("approval", {
        code: "VALIDATION_FAILED",
        message: "Creative override requires approved_by and override_reason",
      });
    }
    if (visualGateReason || semanticGateReason) {
      newState = "critique_ready";
    } else {
      newState = "approved";
      approvalRecord = buildApprovalRecord(
        "creative_override",
        absDir,
        options.approvedBy,
        options.overrideReason,
      );
    }
  } else if (visualGateReason) {
    newState = "critique_ready";
  } else if (!approvalEligible) {
    newState = "critique_ready";
  } else {
    const operatorDecision = autonomyMode === "full"
      ? (() => {
          console.log("[auto:full_autonomy] /review auto-approved clean review.");
          return {
            accepted: true,
            approvedBy: "auto:full_autonomy",
          };
        })()
      : options?.operatorAccept
        ? await options.operatorAccept({
          projectDir: absDir,
          projectId,
          report: agentResult.report,
          patch: safePatch,
          patchSafety,
          preflight,
        })
        : { accepted: false };

    if (operatorDecision.accepted) {
      const approvedBy = operatorDecision.approvedBy ?? options?.approvedBy;
      if (!approvedBy) {
        return fail("approval", {
          code: "VALIDATION_FAILED",
          message: "Operator acceptance requires approvedBy",
        }, {
          compileResult,
          preflight,
          reviewMetrics,
        });
      }
      newState = "approved";
      approvalRecord = buildApprovalRecord("clean", absDir, approvedBy);
    } else {
      newState = "critique_ready";
    }
  }

  if (approvalRecord) {
    doc.approval_record = approvalRecord;
    writeProjectState(absDir, doc);
  }

  const note = semanticGateReason
    ? `critique ready — ${semanticGateReason}`
    : hasFatal && options?.creativeOverride && visualGateReason
    ? `critique ready — ${visualGateReason}`
    : hasFatal && options?.creativeOverride
    ? `creative override: ${options.overrideReason}`
    : hasFatal
      ? "critique ready — fatal issues found"
      : visualGateReason
        ? `critique ready — ${visualGateReason}`
      : !approvalEligible
        ? `critique ready — review status is ${agentResult.report.summary_judgment.status}`
      : approvalRecord
        ? autonomyMode === "full"
          ? "approved — clean review auto-approved"
          : "approved — operator accepted review"
        : "critique ready — awaiting operator acceptance";
  const updatedDoc = transitionState(
    absDir,
    doc,
    newState,
    "/review",
    "roughcut-critic",
    note,
  );

  pt.complete(["review_metrics.json", "review_report.yaml", "review_patch.json"]);
  return {
    success: true,
    report: agentResult.report,
    patch: safePatch,
    patchSafety,
    reviewMetrics,
    wholeCutSemantic,
    compileResult,
    preflight,
    previousState,
    newState: updatedDoc.current_state,
    promoted: promoteResult.promoted,
    approvalRecord,
  };
}

export function readHumanNotes(projectDir: string, expectedProjectId?: string): {
  humanNotes: HumanNotes | null;
  sourceSha256?: string;
  error?: CommandError;
} {
  const notesPath = path.join(projectDir, HUMAN_NOTES_PATH);
  try {
    const stats = fs.lstatSync(notesPath);
    if (stats.isSymbolicLink()) {
      return {
        humanNotes: null,
        error: { code: "VALIDATION_FAILED", message: "human_notes.yaml must not be a symlink" },
      };
    }
    if (!stats.isFile()) {
      return {
        humanNotes: null,
        error: { code: "VALIDATION_FAILED", message: "human_notes.yaml must be a regular file" },
      };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { humanNotes: null };
    return {
      humanNotes: null,
      error: {
        code: "VALIDATION_FAILED",
        message: `human_notes.yaml could not be inspected: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  const inspected = inspectImmutableYamlFile(projectDir, HUMAN_NOTES_PATH);
  if ("error" in inspected) {
    const message = inspected.error.startsWith("unparseable YAML: ")
      ? `Failed to parse human_notes.yaml: ${inspected.error.slice("unparseable YAML: ".length)}`
      : `human_notes.yaml is not a stable contained file: ${inspected.error}`;
    return {
      humanNotes: null,
      error: {
        code: "VALIDATION_FAILED",
        message,
      },
    };
  }

  const parsed = inspected.document;
  const validation = validateAgainstSchema(parsed, "human-notes.schema.json");
  if (!validation.valid) {
    return {
      humanNotes: null,
      error: {
        code: "VALIDATION_FAILED",
        message: `human_notes.yaml failed schema validation: ${validation.errors.join("; ")}`,
        details: validation.errors,
      },
    };
  }

  if (expectedProjectId !== undefined
    && (!isRecord(parsed) || parsed.project_id !== expectedProjectId)) {
    return {
      humanNotes: null,
      error: {
        code: "VALIDATION_FAILED",
        message: "human_notes.yaml project_id does not match the canonical timeline project_id",
      },
    };
  }

  return {
    humanNotes: parsed as HumanNotes,
    sourceSha256: inspected.sha256.slice("sha256:".length),
  };
}

function readStyleMd(projectDir: string): string | null {
  const stylePath = path.join(projectDir, "STYLE.md");
  if (!fs.existsSync(stylePath)) return null;
  try {
    return fs.readFileSync(stylePath, "utf-8");
  } catch {
    return null;
  }
}

function readCreativeBrief(projectDir: string): {
  brief: CreativeBrief | null;
  error?: CommandError;
} {
  const briefPath = path.join(projectDir, "01_intent/creative_brief.yaml");
  if (!fs.existsSync(briefPath)) {
    return {
      brief: null,
      error: {
        code: "GATE_CHECK_FAILED",
        message: "creative_brief.yaml not found. Run /intent first.",
      },
    };
  }
  try {
    const parsed = parseYaml(fs.readFileSync(briefPath, "utf-8"));
    const validation = validateAgainstSchema(parsed, "creative-brief.schema.json");
    if (!validation.valid) {
      return {
        brief: null,
        error: {
          code: "VALIDATION_FAILED",
          message: `creative_brief.yaml failed schema validation: ${validation.errors.join("; ")}`,
          details: validation.errors,
        },
      };
    }
    return { brief: parsed as CreativeBrief };
  } catch (error) {
    return {
      brief: null,
      error: {
        code: "VALIDATION_FAILED",
        message: `Failed to parse creative_brief.yaml: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}

function enforceWholeCutSemanticReportGate(
  review: WholeCutSemanticReview,
  projectDir: string,
): void {
  const validation = validateAgainstSchema(review, "whole-cut-semantic-review.schema.json");
  if (!validation.valid) {
    throw new Error(`whole-cut semantic review failed schema validation: ${validation.errors.join("; ")}`);
  }
  const identityErrors = validateWholeCutSemanticIdentity(projectDir, review);
  if (identityErrors.length > 0) {
    throw new Error(`whole-cut semantic review identity validation failed: ${identityErrors.join("; ")}`);
  }
}

const APPROVED_TIMELINE_PATH = "05_timeline/approved.timeline.json";
const HUMAN_NOTES_PATH = "06_review/human_notes.yaml";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readApprovalPointer(projectDir: string, relativePath: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(projectDir, relativePath), "utf-8")) as unknown;
  } catch {
    return null;
  }
}

function materializeApprovedTimelineSnapshot(
  projectDir: string,
  bytes: string,
): { path: string; version: string; sha256: string } | null {
  const timelineDir = path.join(projectDir, "05_timeline");
  const targetPath = path.join(projectDir, APPROVED_TIMELINE_PATH);
  try {
    const parentStats = fs.lstatSync(timelineDir);
    if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) return null;
    const current = inspectImmutableRecordFile(targetPath, projectDir);
    if (current.ok && current.bytes === bytes && isRecord(current.document)
      && (typeof current.document.version === "string" || typeof current.document.version === "number")) {
      return { path: APPROVED_TIMELINE_PATH, version: String(current.document.version), sha256: current.sha256 };
    }
    const tempPath = `${targetPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
    try {
      fs.writeFileSync(tempPath, bytes, { encoding: "utf-8", flag: "wx" });
      fs.renameSync(tempPath, targetPath);
    } finally {
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch {
        // The rename succeeded; a failed best-effort temp cleanup must not
        // replace the canonical approval result.
      }
    }
    const captured = inspectImmutableRecordFile(targetPath, projectDir);
    if (!captured.ok || captured.bytes !== bytes || !isRecord(captured.document)
      || (typeof captured.document.version !== "string" && typeof captured.document.version !== "number")) return null;
    return { path: APPROVED_TIMELINE_PATH, version: String(captured.document.version), sha256: captured.sha256 };
  } catch {
    return null;
  }
}

/**
 * Capture the single approval evidence record used by product metrics.  The
 * normal /review approval route calls this while recording project state;
 * missing or unmeasurable review evidence simply leaves the ordinary
 * approval record without a correction binding, which the projection treats
 * as unavailable.
 */
export function buildHumanCorrectionApprovalBinding(
  projectDirInput: string,
): HumanCorrectionApprovalBinding | undefined {
  try {
    const projectDir = fs.realpathSync(path.resolve(projectDirInput));
    const timelinePath = path.join(projectDir, "05_timeline/timeline.json");
    const timelineInspection = inspectImmutableRecordFile(timelinePath, projectDir);
    if (!timelineInspection.ok || !isRecord(timelineInspection.document)
      || typeof timelineInspection.document.project_id !== "string"
      || (typeof timelineInspection.document.version !== "string"
        && typeof timelineInspection.document.version !== "number")) return undefined;

    const projectId = timelineInspection.document.project_id;
    const approvedTimeline = materializeApprovedTimelineSnapshot(projectDir, timelineInspection.bytes);
    if (!approvedTimeline) return undefined;

    const notesInspection = inspectImmutableYamlFile(projectDir, HUMAN_NOTES_PATH);
    if ("error" in notesInspection || !isRecord(notesInspection.document)
      || notesInspection.document.project_id !== projectId) return undefined;
    const notesValidation = validateAgainstSchema(notesInspection.document, "human-notes.schema.json");
    if (!notesValidation.valid) return undefined;

    let revisionDiffDiscoveryComplete = true;
    const revisionDiffCandidates = listRevisionDiffCandidates(projectDir, (code) => {
      if (code.includes("revision_diff")) revisionDiffDiscoveryComplete = false;
    });
    if (!revisionDiffDiscoveryComplete) return undefined;
    const derivation = deriveReviewRoundsMetric({
      projectDir,
      projectId,
      timeline: {
        path: "05_timeline/timeline.json",
        version: String(timelineInspection.document.version),
        hash: timelineInspection.sha256,
      },
      askPointer: readApprovalPointer(projectDir, "06_review/review-ask.json"),
      responsePointer: readApprovalPointer(projectDir, "06_review/review-response.json"),
      revisionDiffCandidates,
    });
    const selectedDiff = derivation.validatedRevisionDiff;
    const selectedRound = selectedDiff && derivation.metric.value
      ? derivation.metric.value.rounds.find((round) =>
        round.round_identity === selectedDiff.round.round_identity)
      : undefined;
    if (derivation.metric.status !== "measured" || !selectedDiff || !selectedRound
      || selectedRound.response.decision !== "approve") return undefined;

    return {
      version: "human-correction-approval/v1",
      approved_timeline: approvedTimeline,
      human_notes: { path: HUMAN_NOTES_PATH, sha256: notesInspection.sha256 },
      review_generation: {
        generation_id: selectedRound.generation_id,
        review_identity: selectedRound.review_identity,
        output: selectedRound.output,
        review_ready_receipt: selectedRound.review_ready_receipt,
      },
      review_round: {
        round_index: selectedRound.round_index,
        round_identity: selectedRound.round_identity,
      },
      human_revision_diff: {
        path: selectedDiff.relativePath,
        sha256: selectedDiff.sha256,
        version: 2,
      },
    };
  } catch {
    return undefined;
  }
}

export function buildApprovalRecord(
  status: "clean" | "creative_override",
  projectDir: string,
  approvedBy: string,
  overrideReason?: string,
  options?: { includeHumanCorrectionBinding?: boolean },
): ApprovalRecord {
  const hashes: ApprovalRecord["artifact_versions"] = {};

  const timelinePath = path.join(projectDir, "05_timeline/timeline.json");
  if (fs.existsSync(timelinePath)) {
    hashes.timeline_version = computeFileHash(timelinePath);
  }

  const reportPath = path.join(projectDir, "06_review/review_report.yaml");
  if (fs.existsSync(reportPath)) {
    hashes.review_report_version = computeFileHash(reportPath);
  }

  const patchPath = path.join(projectDir, "06_review/review_patch.json");
  if (fs.existsSync(patchPath)) {
    hashes.review_patch_hash = computeFileHash(patchPath);
  }

  const notesPath = path.join(projectDir, "06_review/human_notes.yaml");
  if (fs.existsSync(notesPath)) {
    hashes.human_notes_hash = computeFileHash(notesPath);
  }

  const stylePath = path.join(projectDir, "STYLE.md");
  if (fs.existsSync(stylePath)) {
    hashes.style_hash = computeFileHash(stylePath);
  }

  if (options?.includeHumanCorrectionBinding !== false) {
    const correctionBinding = buildHumanCorrectionApprovalBinding(projectDir);
    if (correctionBinding) hashes.human_correction_approval = correctionBinding;
  }

  const record: ApprovalRecord = {
    status,
    approved_by: approvedBy,
    approved_at: new Date().toISOString(),
    artifact_versions: hashes,
  };

  if (overrideReason) {
    record.override_reason = overrideReason;
  }

  return record;
}

export {
  runReviewExistingTimelinePreflight,
  runReviewPreflight,
} from "./preflight.js";
