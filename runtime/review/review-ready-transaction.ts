import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { validateArtifact } from "../artifacts/loaders.js";
import { evaluateStaleness } from "./editorial-storyboard/manifest.js";
import type { ProjectionManifest } from "./editorial-storyboard/types.js";
import {
  canonicalJson,
  hashCanonical,
  sha256Bytes,
  sha256File,
  verifyLatestGeneration,
  type BoundGenerationArtifact,
  type SocialReviewGenerationReceipt,
} from "./social-review-generation.js";
import {
  buildReviewReadyEvidence,
  type DerivedReviewReadyEvidence,
} from "./review-ready-evidence.js";
import type { SocialReviewAudioReceipt } from "./social-review-audio.js";
import { readAuthoredCaptionIdentity } from "../caption/authored-lyrics.js";
import {
  appendReviewRoundEvent,
  appendReviewRoundResponseArtifact,
  buildReviewRoundAskEvent,
  buildReviewRoundResponseArtifact,
  buildReviewRoundResponseEvent,
  buildReviewRoundSupersededEvent,
  readReviewRoundLedger,
  REVIEW_ROUND_RESPONSES_DIR,
  reviewRoundEventIdentity,
  reviewRoundLedgerHead,
  reviewRoundResponseArtifactIdentity,
  reviewRoundResponseArtifactPath,
  reviewRoundResponseHash,
  sweepReviewRoundTemporaries,
  withReviewRoundHealLock,
  type ReviewRoundAskEvent,
  type ReviewRoundResponseEvent,
  type VerifiedRoundEvent,
} from "./review-rounds-ledger.js";

const SHA256 = /^sha256:[a-f0-9]{64}$/;

type Verdict = "pass" | "warning" | "blocker";
type Coverage = "sampled" | "manual" | "full_frame";
type EvidenceLevel = "policy_only" | "platform_measured" | "human_verified";

export interface ReviewReadyInput {
  projectDir: string;
  generationId: string;
  artifacts: {
    timeline: string;
    source_map: string;
    delivery: string;
    framing_policy: string;
    caption_policy: string;
    caption_plan: string;
    render_report: string;
    sample_sheet: string;
    storyboard_manifest: string;
  };
  technical: {
    duration_frames: number;
    duration_seconds: number;
    fps: { num: number; den: number };
    resolution: { width: number; height: number };
    audio_stream: "present" | "absent";
    bgm: "present" | "absent";
  };
  gaps: {
    primary_video: { status: Verdict; count: number };
    audio: { status: Verdict; count: number };
    freeze: { status: Verdict; count: number };
    black: { status: Verdict; count: number };
  };
  source: { attestation_status: "verified" | "incomplete" | "blocked"; unresolved_media: string[] };
  framing: {
    coverage: Coverage;
    evidence_level?: EvidenceLevel;
    samples: Array<{
      clip_id: string;
      timestamp_frame: number;
      inspection_space: "source_frame" | "delivery_crop";
      measurement: { face_eye_line_ratio: number | null };
      allowed_range: { min: number; max: number };
      status: Verdict;
    }>;
  };
  captions: {
    cue_count: number;
    display_range: { first_frame: number; last_frame: number };
    safe_rect: { x: number; y: number; width: number; height: number };
    collision_status: Verdict;
    transcript_grounding: "verified" | "partial" | "unverified";
    evidence_level: EvidenceLevel;
    platform_safety_claims: string[];
  };
  coverage: { video: Coverage; audio: Coverage; framing: Coverage; captions: Coverage };
  findings: { pass: string[]; warnings: string[]; blockers: string[]; human_residual: string[] };
  reviewSummary: { projection_id: string; trims: string[]; crops: string[]; captions: string[] };
}

export interface ReviewTransactionTestOptions {
  /** Failure injection only; never serialized into review evidence. */
  failAtCommitPoint?: number;
  /** Simulates an uncatchable process death immediately after a rename. */
  interruptAfterCommitPoint?: number;
}

export interface ReviewIdentityFields {
  generation_id: string;
  delivery_id: string;
  timeline_sha256: string;
  source_map_sha256: string;
  delivery_sha256: string;
  framing_policy_sha256: string;
  caption_policy_sha256: string;
  caption_plan_sha256: string;
  video_sha256: string;
  caption_text_sha256?: string;
  caption_timing_sha256?: string;
  caption_approval_sha256?: string;
  caption_projection_receipt_sha256?: string;
}

type ReviewBoundArtifacts = Record<keyof ReviewReadyInput["artifacts"] | "review_video" | "generation_receipt" | "source_input_attestation", BoundGenerationArtifact> & {
  caption_approval?: BoundGenerationArtifact;
  caption_projection_receipt?: BoundGenerationArtifact;
};

export interface ReviewQaReceipt {
  version: "review-qa-receipt/v1";
  project_id: string;
  review_identity: string;
  identity: ReviewIdentityFields;
  artifacts: ReviewBoundArtifacts;
  technical: ReviewReadyInput["technical"];
  gaps: ReviewReadyInput["gaps"];
  source: ReviewReadyInput["source"];
  framing: ReviewReadyInput["framing"] & { evidence_level: EvidenceLevel };
  captions: ReviewReadyInput["captions"];
  coverage: ReviewReadyInput["coverage"];
  findings: ReviewReadyInput["findings"];
  review_summary: ReviewReadyInput["reviewSummary"];
  status: Verdict;
  review_only: true;
}

interface LatestPointer {
  version: "social-review-latest/v1";
  project_id: string;
  generation_id: string;
  receipt_path: string;
  receipt_sha256: string;
  output_path: string;
  output_sha256: string;
}

interface ReviewReadyState {
  version: "review-ready-state/v1";
  project_id: string;
  review_identity: string;
  generation_id: string;
  status: "pending" | "ready" | "failed" | "stale";
  artifacts: { preview: "CURRENT" | "STALE"; qa_receipt: "CURRENT" | "STALE"; unanswered_ask: "CURRENT" | "STALE" };
  qa_receipt: BoundGenerationArtifact | null;
  ask_payload_sha256: string | null;
  reason: string | null;
}

export interface ReviewAskPayload {
  review_identity: string;
  generation_id: string;
  media: { locator: string; sha256: string };
  duration_seconds: number;
  bgm: "present" | "absent";
  caption_count: number;
  qa_warnings: string[];
  unresolved_items: string[];
  choices: ["approve", "request_changes", "free_text"];
  storyboard: { projection_id: string; manifest: BoundGenerationArtifact; diff_summary: { trims: string[]; crops: string[]; captions: string[] } };
}

export interface ReviewAskState {
  version: "review-ask-dispatch/v1";
  project_id: string;
  review_identity: string;
  generation_id: string;
  video_sha256: string;
  timeline_sha256: string;
  idempotency_key: string;
  payload_sha256: string | null;
  status: "blocked" | "pending" | "dispatch_failed" | "dispatched" | "responded" | "stale";
  attempts: number;
  ask_id: string | null;
  error: string | null;
  payload: ReviewAskPayload | null;
  round_event_sha256?: string | null;
}

export interface ReviewAskAdapter {
  dispatch(request: { idempotencyKey: string; payload: ReviewAskPayload }): Promise<{ ask_id: string }>;
}

export interface ReviewResponseInput {
  review_identity: string;
  generation_id: string;
  video_sha256: string;
  timeline_sha256: string;
  ask_id: string;
  decision: "approve" | "request_changes" | "free_text";
  text: string | null;
}

export interface ReviewResponseReceipt extends ReviewResponseInput {
  version: "review-response/v1";
  project_id: string;
  status: "current" | "stale";
  invalid_for_current: boolean;
  stale_reason: string | null;
  round_event_sha256?: string | null;
}

interface TechnicalEvidence {
  version: "social-review-render/v3";
  generation_id: string;
  output_sha256: string;
  duration_frames: number;
  duration_sec: number;
  fps_num: number;
  fps_den: number;
  width: number;
  height: number;
  audio_present: boolean;
  bgm_present: boolean;
  gap_free: boolean;
}

interface ReviewJournal {
  version: "review-transaction-journal/v1";
  transaction_id: string;
  project_id: string;
  generation_id: string;
  review_identity: string;
  status: "prepared";
  targets: Array<{ target: string; temp: string; sha256: string }>;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function resolveContainedFile(projectDir: string, relativePath: string, label: string): string {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) {
    throw new Error(`${label} path must be project-relative and contained`);
  }
  const root = fs.realpathSync(path.resolve(projectDir));
  const candidate = path.resolve(root, relativePath);
  let real: string;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    throw new Error(`${label} artifact is missing: ${relativePath}`);
  }
  if (!real.startsWith(`${root}${path.sep}`) || !fs.statSync(real).isFile()) {
    throw new Error(`${label} artifact path is not contained in the project`);
  }
  return real;
}

function bind(projectDir: string, relativePath: string, label: string): BoundGenerationArtifact {
  const filePath = resolveContainedFile(projectDir, relativePath, label);
  const root = fs.realpathSync(path.resolve(projectDir));
  return { path: path.relative(root, filePath).split(path.sep).join("/"), sha256: sha256File(filePath) };
}

function readLatest(projectDir: string): LatestPointer {
  verifyLatestGeneration(projectDir);
  return JSON.parse(fs.readFileSync(path.join(projectDir, "09_output/social-review/latest.json"), "utf8")) as LatestPointer;
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function readDocument<T extends Record<string, unknown>>(filePath: string): T {
  const bytes = fs.readFileSync(filePath, "utf8");
  try {
    return JSON.parse(bytes) as T;
  } catch {
    return parseYaml(bytes) as T;
  }
}

function pendingIdentity(input: ReviewReadyInput): string {
  return hashCanonical({ version: "review-identity-pending/v1", generation_id: input.generationId, artifact_paths: input.artifacts });
}

function statePath(projectDir: string): string { return path.join(projectDir, "06_review/review-ready-state.json"); }
function askPath(projectDir: string): string { return path.join(projectDir, "06_review/review-ask.json"); }
function responsePath(projectDir: string): string { return path.join(projectDir, "06_review/review-response.json"); }
function journalPath(projectDir: string): string { return path.join(projectDir, "06_review/review-transaction-journal.json"); }

function projectStateDocument(projectDir: string): Record<string, unknown> {
  const filePath = path.join(projectDir, "project_state.yaml");
  return fs.existsSync(filePath) ? parseYaml(fs.readFileSync(filePath, "utf8")) as Record<string, unknown> : {};
}

function progressDocument(projectDir: string): Record<string, unknown> {
  const filePath = path.join(projectDir, "progress.json");
  return fs.existsSync(filePath) ? readJson<Record<string, unknown>>(filePath) : {};
}

function buildProjectState(projectDir: string, projectId: string, reviewIdentity: string, status: "pending" | "ready" | "failed" | "stale", reason: string | null): Record<string, unknown> {
  const current = projectStateDocument(projectDir);
  const previousState = typeof current.current_state === "string" ? current.current_state : "timeline_drafted";
  const currentState = status === "ready" ? "review_ready" : status === "failed" ? "review_failed" : "review_pending";
  const gates = current.gates && typeof current.gates === "object" && !Array.isArray(current.gates) ? current.gates as Record<string, unknown> : {};
  const history = Array.isArray(current.history) ? current.history : [];
  return {
    ...current,
    version: current.version ?? 1,
    project_id: projectId,
    current_state: currentState,
    gates: { ...gates, review_gate: status === "ready" ? "open" : "blocked" },
    review_transaction: { version: "review-transaction/v1", review_identity: reviewIdentity, status, reason },
    history: previousState === currentState ? history : [...history, { from_state: previousState, to_state: currentState, trigger: "review-ready-transaction", actor: "runtime", timestamp: new Date().toISOString(), note: reason ?? `review identity ${reviewIdentity}` }],
  };
}

function buildProgress(projectDir: string, projectId: string, reviewIdentity: string, status: "pending" | "ready" | "failed" | "stale", reason: string | null): Record<string, unknown> {
  const current = progressDocument(projectDir);
  const now = new Date().toISOString();
  return {
    ...current,
    project_id: projectId,
    phase: "review",
    gate: 5,
    status: status === "ready" ? "completed" : status === "pending" ? "running" : status === "failed" ? "failed" : "blocked",
    completed: status === "ready" ? 1 : 0,
    total: 1,
    eta_sec: status === "ready" ? 0 : null,
    artifacts_created: Array.isArray(current.artifacts_created) ? current.artifacts_created : [],
    errors: reason ? [{ stage: "review-ready", message: reason, timestamp: now, retriable: status !== "ready" }] : [],
    started_at: typeof current.started_at === "string" ? current.started_at : now,
    updated_at: now,
    review_identity: reviewIdentity,
    review_status: status,
  };
}

function blockedAsk(projectId: string, generationId: string, reviewIdentity: string): ReviewAskState {
  return { version: "review-ask-dispatch/v1", project_id: projectId, review_identity: reviewIdentity, generation_id: generationId, video_sha256: `sha256:${"0".repeat(64)}`, timeline_sha256: `sha256:${"0".repeat(64)}`, idempotency_key: reviewIdentity, payload_sha256: null, status: "blocked", attempts: 0, ask_id: null, error: null, payload: null };
}

function validateProjectedState(progress: Record<string, unknown>, projectState: Record<string, unknown>, readyState: ReviewReadyState, ask: ReviewAskState): void {
  validateArtifact(progress, "progress.schema.json");
  validateArtifact(projectState, "project-state.schema.json");
  validateArtifact(readyState, "review-ready-state.schema.json");
  validateArtifact(ask, "review-ask-dispatch.schema.json");
}

interface BundleEntry { target: string; bytes: string }
interface DurableCommitOptions {
  failAt?: number;
  interruptAfter?: number;
  journal?: Pick<ReviewJournal, "project_id" | "generation_id" | "review_identity"> & { projectDir: string };
}

function durableWrite(filePath: string, bytes: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const descriptor = fs.openSync(filePath, "wx");
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function removeIfPresent(filePath: string): void {
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

function commitBundle(entries: BundleEntry[], options: DurableCommitOptions = {}): void {
  const id = `${process.pid}-${randomUUID()}`;
  const originals = new Map<string, Buffer | null>();
  const temps: string[] = [];
  for (const entry of entries) {
    fs.mkdirSync(path.dirname(entry.target), { recursive: true });
    originals.set(entry.target, fs.existsSync(entry.target) ? fs.readFileSync(entry.target) : null);
    const temp = `${entry.target}.tmp-review-${id}`;
    durableWrite(temp, entry.bytes);
    temps.push(temp);
  }
  const durableJournal = options.journal ? {
    version: "review-transaction-journal/v1" as const,
    transaction_id: id,
    project_id: options.journal.project_id,
    generation_id: options.journal.generation_id,
    review_identity: options.journal.review_identity,
    status: "prepared" as const,
    targets: entries.map((entry, index) => ({
      target: path.relative(options.journal!.projectDir, entry.target).split(path.sep).join("/"),
      temp: path.relative(options.journal!.projectDir, temps[index]).split(path.sep).join("/"),
      sha256: sha256Bytes(entry.bytes),
    })),
  } : null;
  if (durableJournal && options.journal) {
    validateArtifact(durableJournal, "review-transaction-journal.schema.json");
    const marker = journalPath(options.journal.projectDir);
    removeIfPresent(marker);
    durableWrite(marker, json(durableJournal));
  }
  let committed = 0;
  try {
    for (let index = 0; index < entries.length; index += 1) {
      if (options.failAt === index) throw new Error(`injected commit failure at point ${index}`);
      fs.renameSync(temps[index], entries[index].target);
      committed += 1;
      if (options.interruptAfter === index) process.kill(process.pid, "SIGKILL");
    }
    if (options.journal) removeIfPresent(journalPath(options.journal.projectDir));
  } catch (error) {
    for (let index = committed - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      const original = originals.get(entry.target) ?? null;
      if (original === null) {
        if (fs.existsSync(entry.target)) fs.unlinkSync(entry.target);
      } else {
        const restore = `${entry.target}.restore-review-${id}`;
        durableWrite(restore, original.toString());
        fs.renameSync(restore, entry.target);
      }
    }
    for (const temp of temps) if (fs.existsSync(temp)) fs.unlinkSync(temp);
    if (options.journal) removeIfPresent(journalPath(options.journal.projectDir));
    throw error;
  }
}

function closedBundle(projectDir: string, projectId: string, generationId: string, reviewIdentity: string, status: "pending" | "failed", reason: string | null): BundleEntry[] {
  const readyState: ReviewReadyState = { version: "review-ready-state/v1", project_id: projectId, review_identity: reviewIdentity, generation_id: generationId, status, artifacts: { preview: "STALE", qa_receipt: "STALE", unanswered_ask: "STALE" }, qa_receipt: null, ask_payload_sha256: null, reason };
  const progress = buildProgress(projectDir, projectId, reviewIdentity, status, reason);
  const projectState = buildProjectState(projectDir, projectId, reviewIdentity, status, reason);
  const ask = blockedAsk(projectId, generationId, reviewIdentity);
  validateProjectedState(progress, projectState, readyState, ask);
  return [
    { target: path.join(projectDir, "progress.json"), bytes: json(progress) },
    { target: path.join(projectDir, "project_state.yaml"), bytes: stringifyYaml(projectState) },
    { target: statePath(projectDir), bytes: json(readyState) },
    { target: askPath(projectDir), bytes: json(ask) },
  ];
}

function recoverInterruptedTransaction(projectDir: string): void {
  const marker = journalPath(projectDir);
  if (!fs.existsSync(marker)) return;
  const raw = fs.readFileSync(marker, "utf8");
  let parsed: Partial<ReviewJournal> | null = null;
  let validJournal: ReviewJournal | null = null;
  try {
    parsed = JSON.parse(raw) as Partial<ReviewJournal>;
    validateArtifact(parsed, "review-transaction-journal.schema.json");
    validJournal = parsed as ReviewJournal;
  } catch {
    // Torn or schema-invalid journals are themselves evidence of an interrupted
    // commit. Only recover identity fields; never trust their target list.
  }
  const rawField = (name: string): string | null => {
    const match = raw.match(new RegExp(`"${name}"\\s*:\\s*"([^"]+)"`));
    return match?.[1] ?? null;
  };
  const readSurface = (filePath: string, yaml = false): Record<string, unknown> | null => {
    try {
      return (yaml ? parseYaml(fs.readFileSync(filePath, "utf8")) : readJson(filePath)) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  const ready = readSurface(statePath(projectDir));
  const ask = readSurface(askPath(projectDir));
  const progress = readSurface(path.join(projectDir, "progress.json"));
  const projectState = readSurface(path.join(projectDir, "project_state.yaml"), true);
  const stateTransaction = projectState?.review_transaction && typeof projectState.review_transaction === "object"
    ? projectState.review_transaction as Record<string, unknown> : null;
  const identities = [ready?.review_identity, ask?.review_identity, progress?.review_identity, stateTransaction?.review_identity]
    .filter((value): value is string => typeof value === "string" && SHA256.test(value));
  const identityCounts = new Map<string, number>();
  for (const identity of identities) identityCounts.set(identity, (identityCounts.get(identity) ?? 0) + 1);
  const recoveredIdentity = [parsed?.review_identity, rawField("review_identity")]
    .find((value): value is string => typeof value === "string" && SHA256.test(value))
    ?? [...identityCounts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "en"))[0]?.[0]
    ?? hashCanonical({ version: "review-recovery-failure/v1", project_dir: path.resolve(projectDir), journal_sha256: sha256Bytes(raw) });
  let latest: { project_id?: unknown; generation_id?: unknown } | null = null;
  try {
    latest = readJson(path.join(projectDir, "09_output/social-review/latest.json"));
  } catch {
    latest = null;
  }
  const recoveredGeneration = [parsed?.generation_id, rawField("generation_id"), ready?.generation_id, ask?.generation_id, latest?.generation_id]
    .find((value): value is string => typeof value === "string" && SHA256.test(value))
    ?? `sha256:${"0".repeat(64)}`;
  const recoveredProject = [parsed?.project_id, rawField("project_id"), ready?.project_id, ask?.project_id, progress?.project_id, projectState?.project_id, latest?.project_id]
    .find((value): value is string => typeof value === "string" && value.length > 0)
    ?? path.basename(projectDir);
  const transactionId = validJournal?.transaction_id ?? rawField("transaction_id") ?? "unreadable-journal";
  const reason = `recovered interrupted review transaction ${transactionId}; journal was ${validJournal ? "valid" : "partial or schema-invalid"}`;
  commitBundle(closedBundle(projectDir, recoveredProject, recoveredGeneration, recoveredIdentity, "failed", reason), {
    journal: { projectDir, project_id: recoveredProject, generation_id: recoveredGeneration, review_identity: recoveredIdentity },
  });
  const root = path.resolve(projectDir);
  for (const entry of validJournal?.targets ?? []) {
    const temp = path.resolve(root, entry.temp);
    if (temp.startsWith(`${root}${path.sep}`)) removeIfPresent(temp);
  }
  const cleanupDirs = [projectDir, path.join(projectDir, "06_review"), path.join(projectDir, "09_output/social-review/generations", recoveredGeneration.slice(7))];
  for (const directory of cleanupDirs) {
    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) continue;
    for (const name of fs.readdirSync(directory)) if (name.includes(".tmp-review-")) removeIfPresent(path.join(directory, name));
  }
  removeIfPresent(marker);
}

function captionTextTimingHash(plan: { cues?: unknown[] }): string {
  if (!Array.isArray(plan.cues)) throw new Error("caption plan cues are missing");
  const normalized = plan.cues.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`caption cue ${index} is invalid`);
    const cue = raw as Record<string, unknown>;
    const text = cue.text;
    const inFrame = cue.timeline_in_frame ?? cue.in_frame;
    const outFrame = cue.timeline_out_frame ?? cue.out_frame;
    if (typeof text !== "string" || !Number.isInteger(inFrame) || !Number.isInteger(outFrame)) throw new Error(`caption cue ${index} lacks canonical text/timing`);
    return { text, in_frame: inFrame, out_frame: outFrame };
  });
  return hashCanonical(normalized);
}

function technicalFromReport(report: TechnicalEvidence, latest: LatestPointer): ReviewReadyInput["technical"] {
  if (report.version !== "social-review-render/v3" || report.generation_id !== latest.generation_id || report.output_sha256 !== latest.output_sha256) {
    throw new Error("render report identity differs from the verified generation/video");
  }
  if (!Number.isInteger(report.duration_frames) || report.duration_frames <= 0 || report.duration_sec <= 0 || !Number.isInteger(report.fps_num) || report.fps_num <= 0 || !Number.isInteger(report.fps_den) || report.fps_den <= 0 || !Number.isInteger(report.width) || report.width <= 0 || !Number.isInteger(report.height) || report.height <= 0 || typeof report.audio_present !== "boolean" || typeof report.bgm_present !== "boolean") {
    throw new Error("render report lacks verified technical values");
  }
  return {
    duration_frames: report.duration_frames,
    duration_seconds: report.duration_sec,
    fps: { num: report.fps_num, den: report.fps_den },
    resolution: { width: report.width, height: report.height },
    audio_stream: report.audio_present ? "present" : "absent",
    bgm: report.bgm_present ? "present" : "absent",
  };
}

function assertGenerationInputBinding(generationReceipt: { input_files: Array<{ locator: string; sha256: string }> }, artifact: BoundGenerationArtifact, label: string): void {
  const locator = `project:${artifact.path}`;
  if (!generationReceipt.input_files.some((entry) => entry.locator === locator && entry.sha256 === artifact.sha256)) {
    throw new Error(`${label} is not bound by the verified generation input files`);
  }
}

function canonicalReviewSummary(
  storyboard: ProjectionManifest & { review_diff_summary?: { trims?: unknown; crops?: unknown } },
  captionCount: number,
): ReviewReadyInput["reviewSummary"] {
  const trims = storyboard.review_diff_summary?.trims;
  const crops = storyboard.review_diff_summary?.crops;
  if (!Array.isArray(trims) || trims.some((value) => typeof value !== "string") || !Array.isArray(crops) || crops.some((value) => typeof value !== "string")) {
    throw new Error("storyboard canonical diff summary is missing");
  }
  return {
    projection_id: storyboard.projection_id,
    trims: trims as string[],
    crops: crops as string[],
    captions: [`${captionCount} review-only cues`],
  };
}

function validateReviewEvidence(input: ReviewReadyInput, latest: LatestPointer, artifacts: ReviewQaReceipt["artifacts"]): { deliveryId: string; technical: ReviewReadyInput["technical"]; source: ReviewReadyInput["source"]; reviewSummary: ReviewReadyInput["reviewSummary"]; evidence: DerivedReviewReadyEvidence } {
  if (latest.generation_id !== input.generationId) throw new Error("requested generation ID is not the currently verified immutable generation");
  const generationReceipt = readJson<SocialReviewGenerationReceipt>(resolveContainedFile(input.projectDir, latest.receipt_path, "generation receipt"));
  if (!generationReceipt.review_ready) throw new Error("immutable generation is not review-ready");
  if (artifacts.timeline.sha256 !== generationReceipt.inputs.canonical_timeline_sha256) throw new Error("canonical timeline hash differs from the verified generation");
  const captionPlan = readDocument<{ base_timeline_hash?: string; review_only_unapproved?: boolean; cues?: unknown[] }>(resolveContainedFile(input.projectDir, input.artifacts.caption_plan, "caption plan"));
  if (captionPlan.base_timeline_hash !== artifacts.timeline.sha256) throw new Error("caption plan canonical timeline hash binding is stale");
  if (captionPlan.review_only_unapproved !== true) throw new Error("caption plan must be explicitly review_only_unapproved");
  if (!Array.isArray(captionPlan.cues)) throw new Error("caption plan cues are missing");
  if (captionTextTimingHash(captionPlan) !== generationReceipt.inputs.caption_text_timing_sha256) throw new Error("caption plan text/timing hash differs from the verified generation");
  const renderReport = readJson<TechnicalEvidence>(resolveContainedFile(input.projectDir, input.artifacts.render_report, "render report"));
  if (canonicalJson(generationReceipt.render_report) !== canonicalJson(artifacts.render_report)) throw new Error("render report path/hash differs from the verified generation receipt");
  const technical = technicalFromReport(renderReport, latest);
  if (canonicalJson(input.technical) !== canonicalJson(technical)) throw new Error("caller technical values differ from verified render report technical evidence");
  const verifiedOutput = generationReceipt.qa.output;
  if (verifiedOutput.duration_sec !== undefined && Math.abs(verifiedOutput.duration_sec - technical.duration_seconds) > 0.001) throw new Error("render report duration differs from immutable generation QA");
  if (verifiedOutput.width !== undefined && verifiedOutput.width !== technical.resolution.width) throw new Error("render report width differs from immutable generation QA");
  if (verifiedOutput.height !== undefined && verifiedOutput.height !== technical.resolution.height) throw new Error("render report height differs from immutable generation QA");
  const sourceAttestation = readJson<Record<string, unknown>>(resolveContainedFile(input.projectDir, artifacts.source_input_attestation.path, "source input attestation"));
  validateArtifact(sourceAttestation, "source-input-attestation.schema.json");
  const sourceInputs = sourceAttestation.source_inputs as Array<{ asset_id: string; identity_status: string }>;
  const sourceCount = sourceAttestation.source_input_count as number;
  const persistedCount = sourceAttestation.persisted_source_input_count as number;
  const warnings = sourceAttestation.warnings as string[];
  if (persistedCount !== sourceInputs.length || sourceCount < persistedCount
    || (sourceAttestation.source_inputs_truncated === false) !== (sourceCount === persistedCount)
    || sourceAttestation.warning_count !== warnings.length + (sourceAttestation.warnings_suppressed as number)
    || (sourceAttestation.status === "verified" && sourceInputs.some((entry) => entry.identity_status !== "verified"))
    || (sourceAttestation.status === "not_applicable" && sourceCount !== 0)) {
    throw new Error("source attestation counts/status are internally inconsistent");
  }
  const unresolvedMedia = sourceInputs.filter((entry) => entry.identity_status !== "verified").map((entry) => entry.asset_id).sort();
  const acceptedStatus = sourceAttestation.status === "verified" || (sourceAttestation.status === "not_applicable" && sourceCount === 0);
  const actualSource = { attestation_status: acceptedStatus ? "verified" as const : "incomplete" as const, unresolved_media: unresolvedMedia };
  const timelineShortHash = artifacts.timeline.sha256.slice("sha256:".length, "sha256:".length + 16);
  if (sourceAttestation.timeline_hash !== timelineShortHash || actualSource.attestation_status !== "verified" || actualSource.unresolved_media.length > 0 || canonicalJson(input.source) !== canonicalJson(actualSource)) throw new Error("source attestation status, unresolved media, or timeline binding is invalid");
  if (input.captions.evidence_level === "policy_only" && input.captions.platform_safety_claims.length > 0) throw new Error("policy_only evidence cannot make platform safety claims");
  const storyboard = readJson<ProjectionManifest & { review_diff_summary?: { trims?: unknown; crops?: unknown } }>(resolveContainedFile(input.projectDir, input.artifacts.storyboard_manifest, "storyboard manifest"));
  validateArtifact(storyboard, "editorial-storyboard-projection.schema.json");
  if (storyboard.version !== "editorial-storyboard-projection/v1" || storyboard.generator !== "render-editorial-storyboard" || storyboard.project_id !== latest.project_id) throw new Error("storyboard manifest schema or provenance is invalid");
  const storyboardFreshness = evaluateStaleness({ projectDir: input.projectDir, manifest: storyboard });
  if (storyboardFreshness.status !== "CURRENT") throw new Error(`storyboard manifest is ${storyboardFreshness.status.toLowerCase()}: required inputs are missing, stale, or invalid`);
  if (storyboard.artifact_hashes?.timeline !== artifacts.timeline.sha256 || storyboard.approval_identity?.artifact_hashes?.timeline !== artifacts.timeline.sha256) throw new Error("storyboard canonical timeline identity is stale");
  const delivery = readJson<{ id?: string; profile_id?: string }>(resolveContainedFile(input.projectDir, input.artifacts.delivery, "delivery"));
  const deliveryId = delivery.id ?? delivery.profile_id;
  if (!deliveryId) throw new Error("delivery artifact must declare an id or profile_id");
  if (!storyboard.delivery?.ids?.includes(deliveryId)) throw new Error("storyboard delivery identity differs from the review delivery");
  const storyboardDelivery = storyboard.delivery.profiles?.find((profile) => profile.profile_id === deliveryId);
  if (!storyboardDelivery || storyboardDelivery.path !== artifacts.delivery.path || storyboardDelivery.hash !== artifacts.delivery.sha256) throw new Error("storyboard delivery profile path/hash differs from the bound review delivery");
  const layoutEvidence = generationReceipt.qa.layout_evidence;
  if (!layoutEvidence?.snapshot || !layoutEvidence.vertical_composition_policy) throw new Error("verified generation layout evidence is incomplete");
  const layoutSnapshotPath = resolveContainedFile(input.projectDir, layoutEvidence.snapshot.path, "layout snapshot evidence");
  if (sha256File(layoutSnapshotPath) !== layoutEvidence.snapshot.sha256) throw new Error("layout snapshot evidence hash mismatch");
  const audioEvidence = generationReceipt.qa.audio.evidence;
  if (!audioEvidence) throw new Error("verified generation audio evidence is missing");
  const audioReceiptPath = resolveContainedFile(input.projectDir, audioEvidence.path, "audio evidence");
  if (sha256File(audioReceiptPath) !== audioEvidence.sha256) throw new Error("audio evidence hash mismatch");
  const policyPath = resolveContainedFile(input.projectDir, layoutEvidence.vertical_composition_policy.path, "vertical composition policy evidence");
  if (sha256File(policyPath) !== layoutEvidence.vertical_composition_policy.sha256) throw new Error("vertical composition policy evidence hash mismatch");
  const evidence = buildReviewReadyEvidence({
    generationReceipt,
    audioReceipt: readJson<SocialReviewAudioReceipt>(audioReceiptPath),
    layoutSnapshot: readJson(layoutSnapshotPath),
    captionPlan,
    sampleSheet: readDocument(resolveContainedFile(input.projectDir, input.artifacts.sample_sheet, "sample sheet")),
    framingPolicy: readDocument(resolveContainedFile(input.projectDir, input.artifacts.framing_policy, "framing policy")),
    captionPolicy: readDocument(resolveContainedFile(input.projectDir, input.artifacts.caption_policy, "caption policy")),
    verticalCompositionPolicy: readDocument(policyPath),
    deliveryPlatform: storyboardDelivery.platform,
    renderAudioPresent: technical.audio_stream === "present",
    renderGapFree: renderReport.gap_free,
  });
  if (evidence.findings.blockers.length > 0
    || Object.values(evidence.gaps).some((gap) => gap.status !== "pass" || gap.count !== 0)
    || evidence.captions.collision_status === "blocker"
    || evidence.framing.samples.some((sample) => sample.status === "blocker")) {
    throw new Error("derived review QA has blockers");
  }
  const spaces = new Set(evidence.framing.samples.map((sample) => sample.inspection_space));
  if (!spaces.has("source_frame") || !spaces.has("delivery_crop")) throw new Error("framing QA must distinguish source_frame and delivery_crop samples");
  if (input.framing.coverage !== evidence.framing.coverage || canonicalJson(input.framing.samples) !== canonicalJson(evidence.framing.samples)
    || (input.framing.evidence_level !== undefined && input.framing.evidence_level !== evidence.framing.evidence_level)) {
    throw new Error("framing evidence differs from the bound sample sheet and policy evidence");
  }
  for (const field of ["cue_count", "display_range", "safe_rect", "collision_status", "transcript_grounding", "evidence_level", "platform_safety_claims"] as const) {
    if (canonicalJson(input.captions[field]) !== canonicalJson(evidence.captions[field])) {
      throw new Error(`caption ${field} differs from bound caption/layout evidence`);
    }
  }
  if (canonicalJson(input.coverage) !== canonicalJson(evidence.coverage)) throw new Error("coverage differs from immutable QA and bound evidence");
  if (canonicalJson(input.gaps) !== canonicalJson(evidence.gaps)) throw new Error("gap, freeze, black, or audio QA differs from immutable generation scans/status");
  if (canonicalJson(input.findings) !== canonicalJson(evidence.findings)) throw new Error("findings differ from immutable QA and bound evidence");
  assertGenerationInputBinding(generationReceipt, artifacts.storyboard_manifest, "storyboard manifest");
  assertGenerationInputBinding(generationReceipt, artifacts.delivery, "delivery artifact");
  const canonicalSummary = canonicalReviewSummary(storyboard, evidence.captions.cue_count);
  if (canonicalJson(input.reviewSummary) !== canonicalJson(canonicalSummary)) throw new Error("caller review diff summary differs from canonical storyboard/caption artifacts");
  return { deliveryId, technical, source: actualSource, reviewSummary: canonicalSummary, evidence };
}

function buildAskPayload(receipt: ReviewQaReceipt): ReviewAskPayload {
  return {
    review_identity: receipt.review_identity,
    generation_id: receipt.identity.generation_id,
    media: { locator: `project:${receipt.artifacts.review_video.path}`, sha256: receipt.identity.video_sha256 },
    duration_seconds: receipt.technical.duration_seconds,
    bgm: receipt.technical.bgm,
    caption_count: receipt.captions.cue_count,
    qa_warnings: receipt.findings.warnings,
    unresolved_items: receipt.findings.human_residual,
    choices: ["approve", "request_changes", "free_text"],
    storyboard: { projection_id: receipt.review_summary.projection_id, manifest: receipt.artifacts.storyboard_manifest, diff_summary: { trims: receipt.review_summary.trims, crops: receipt.review_summary.crops, captions: receipt.review_summary.captions } },
  };
}

export function finalizeReviewReady(input: ReviewReadyInput, testOptions: ReviewTransactionTestOptions = {}): { reviewIdentity: string; receipt: ReviewQaReceipt } {
  const projectDir = path.resolve(input.projectDir);
  // Before any Ask/state overwrite: heal every pending stale intent and
  // supersede one outstanding unanswered Ask. If healing cannot complete,
  // abort the finalize and preserve the evidence — an unanswered Ask must
  // never be silently orphaned as Ask(old)->Ask(new).
  withReviewRoundHealLock(projectDir, () => {
    sweepReviewRoundTemporaries(projectDir);
    healSupersededRoundEvent(projectDir);
    supersedeOutstandingAskBeforeFinalize(projectDir);
  });
  recoverInterruptedTransaction(projectDir);
  const provisional = pendingIdentity(input);
  let projectId = path.basename(projectDir);
  commitBundle(closedBundle(projectDir, projectId, input.generationId, provisional, "pending", null));
  let reviewIdentity = provisional;
  try {
    const latest = readLatest(projectDir);
    projectId = latest.project_id;
    const bound = Object.fromEntries(Object.entries(input.artifacts).map(([key, relative]) => [key, bind(projectDir, relative, key)])) as unknown as ReviewQaReceipt["artifacts"];
    bound.review_video = bind(projectDir, latest.output_path, "review video");
    bound.generation_receipt = bind(projectDir, latest.receipt_path, "generation receipt");
    const generationReceiptDocument = readJson<{ source_input_attestation: BoundGenerationArtifact }>(resolveContainedFile(projectDir, latest.receipt_path, "generation receipt"));
    bound.source_input_attestation = bind(projectDir, generationReceiptDocument.source_input_attestation.path, "source input attestation");
    const authoredCaptionIdentity = readAuthoredCaptionIdentity(projectDir);
    if (authoredCaptionIdentity) {
      bound.caption_approval = bind(projectDir, "07_package/caption_approval.json", "authored caption approval");
      bound.caption_projection_receipt = bind(projectDir, "07_package/caption_projection_receipt.json", "authored caption projection receipt");
    }
    const validated = validateReviewEvidence(input, latest, bound);
    const identity: ReviewIdentityFields = {
      generation_id: latest.generation_id,
      delivery_id: validated.deliveryId,
      timeline_sha256: bound.timeline.sha256,
      source_map_sha256: bound.source_map.sha256,
      delivery_sha256: bound.delivery.sha256,
      framing_policy_sha256: bound.framing_policy.sha256,
      caption_policy_sha256: bound.caption_policy.sha256,
      caption_plan_sha256: bound.caption_plan.sha256,
      video_sha256: bound.review_video.sha256,
      ...(authoredCaptionIdentity ? {
        caption_text_sha256: authoredCaptionIdentity.caption_text_sha256,
        caption_timing_sha256: authoredCaptionIdentity.caption_timing_sha256,
        caption_approval_sha256: authoredCaptionIdentity.caption_approval_sha256,
        caption_projection_receipt_sha256: authoredCaptionIdentity.caption_projection_receipt_sha256,
      } : {}),
    };
    reviewIdentity = hashCanonical({ version: "review-identity/v1", ...identity });
    const receipt: ReviewQaReceipt = {
      version: "review-qa-receipt/v1",
      project_id: latest.project_id,
      review_identity: reviewIdentity,
      identity,
      artifacts: bound,
      technical: validated.technical,
      gaps: validated.evidence.gaps,
      source: validated.source,
      framing: validated.evidence.framing,
      captions: { ...input.captions, ...validated.evidence.captions },
      coverage: validated.evidence.coverage,
      findings: validated.evidence.findings,
      review_summary: validated.reviewSummary,
      status: validated.evidence.findings.warnings.length > 0 || validated.evidence.captions.collision_status === "warning" || validated.evidence.framing.samples.some((sample) => sample.status === "warning") ? "warning" : "pass",
      review_only: true,
    };
    validateArtifact<ReviewQaReceipt>(receipt, "review-qa-receipt.schema.json");
    const receiptPath = path.join(projectDir, "09_output/social-review/generations", input.generationId.slice(7), "review-qa-receipt.json");
    if (fs.existsSync(receiptPath) && fs.readFileSync(receiptPath, "utf8") !== json(receipt)) throw new Error("immutable review QA receipt overwrite refused");
    const receiptBinding = { path: path.relative(projectDir, receiptPath).split(path.sep).join("/"), sha256: sha256Bytes(json(receipt)) };
    const askPayload = buildAskPayload(receipt);
    const askPayloadSha256 = hashCanonical(askPayload);
    const readyState: ReviewReadyState = { version: "review-ready-state/v1", project_id: latest.project_id, review_identity: reviewIdentity, generation_id: latest.generation_id, status: "ready", artifacts: { preview: "CURRENT", qa_receipt: "CURRENT", unanswered_ask: "CURRENT" }, qa_receipt: receiptBinding, ask_payload_sha256: askPayloadSha256, reason: null };
    const ask: ReviewAskState = { version: "review-ask-dispatch/v1", project_id: latest.project_id, review_identity: reviewIdentity, generation_id: latest.generation_id, video_sha256: identity.video_sha256, timeline_sha256: identity.timeline_sha256, idempotency_key: reviewIdentity, payload_sha256: askPayloadSha256, status: "pending", attempts: 0, ask_id: null, error: null, payload: askPayload };
    const progress = buildProgress(projectDir, latest.project_id, reviewIdentity, "ready", null);
    const projectState = buildProjectState(projectDir, latest.project_id, reviewIdentity, "ready", null);
    validateProjectedState(progress, projectState, readyState, ask);
    const bundle: BundleEntry[] = [
      { target: receiptPath, bytes: json(receipt) },
      { target: path.join(projectDir, "progress.json"), bytes: json(progress) },
      { target: path.join(projectDir, "project_state.yaml"), bytes: stringifyYaml(projectState) },
      { target: statePath(projectDir), bytes: json(readyState) },
      { target: askPath(projectDir), bytes: json(ask) },
    ];
    commitBundle(bundle, {
      failAt: testOptions.failAtCommitPoint,
      interruptAfter: testOptions.interruptAfterCommitPoint,
      journal: { projectDir, project_id: latest.project_id, generation_id: latest.generation_id, review_identity: reviewIdentity },
    });
    return { reviewIdentity, receipt };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    commitBundle(closedBundle(projectDir, projectId, input.generationId, reviewIdentity, "failed", message));
    throw error;
  }
}

function currentReceipt(projectDir: string, state: ReviewReadyState): ReviewQaReceipt {
  if (!state.qa_receipt) throw new Error("review QA receipt is unavailable");
  const filePath = resolveContainedFile(projectDir, state.qa_receipt.path, "review QA receipt");
  if (sha256File(filePath) !== state.qa_receipt.sha256) throw new Error("review QA receipt hash mismatch");
  const receipt = readJson<ReviewQaReceipt>(filePath);
  validateArtifact<ReviewQaReceipt>(receipt, "review-qa-receipt.schema.json");
  return receipt;
}

export interface CurrentReviewVerification {
  state: ReviewReadyState;
  receipt: ReviewQaReceipt;
  receipt_sha256: string;
  timeline_sha256: string;
  geometry_evidence_level: EvidenceLevel;
}

function evidenceLevelFromBoundPolicy(projectDir: string, artifact: BoundGenerationArtifact): EvidenceLevel {
  const document = readJson<{ evidence_level?: unknown }>(resolveContainedFile(projectDir, artifact.path, "geometry policy"));
  return document.evidence_level === "platform_measured" || document.evidence_level === "human_verified"
    ? document.evidence_level
    : "policy_only";
}

/** Pure, read-only validation of the current canonical review identity and its immutable generation bindings. */
export function verifyCurrentReviewReady(projectDirInput: string): CurrentReviewVerification {
  const projectDir = path.resolve(projectDirInput);
  const state = readJson<ReviewReadyState>(statePath(projectDir));
  validateArtifact<ReviewReadyState>(state, "review-ready-state.schema.json");
  if (state.status !== "ready" || Object.values(state.artifacts).some((value) => value !== "CURRENT")) {
    throw new Error("review-ready state is not current");
  }
  const receipt = currentReceipt(projectDir, state);
  const latest = readLatest(projectDir);
  if (state.project_id !== latest.project_id || state.generation_id !== latest.generation_id
    || state.review_identity !== receipt.review_identity || receipt.project_id !== latest.project_id
    || receipt.identity.generation_id !== latest.generation_id) {
    throw new Error("review state/receipt identity differs from current immutable generation");
  }
  const canonicalIdentity = hashCanonical({ version: "review-identity/v1", ...receipt.identity });
  if (canonicalIdentity !== receipt.review_identity) throw new Error("canonical review identity hash mismatch");
  for (const [label, artifact] of Object.entries(receipt.artifacts)) {
    const current = bind(projectDir, artifact.path, label);
    if (current.sha256 !== artifact.sha256) throw new Error(`${label} hash changed`);
  }
  const identityBindings: Array<[keyof ReviewIdentityFields, "timeline" | "source_map" | "delivery" | "framing_policy" | "caption_policy" | "caption_plan" | "review_video"]> = [
    ["timeline_sha256", "timeline"], ["source_map_sha256", "source_map"], ["delivery_sha256", "delivery"],
    ["framing_policy_sha256", "framing_policy"], ["caption_policy_sha256", "caption_policy"],
    ["caption_plan_sha256", "caption_plan"], ["video_sha256", "review_video"],
  ];
  for (const [identityKey, artifactKey] of identityBindings) {
    if (receipt.identity[identityKey] !== receipt.artifacts[artifactKey].sha256) throw new Error(`${String(identityKey)} differs from bound artifact`);
  }
  const authoredIdentityBindings: Array<[keyof ReviewIdentityFields, "caption_approval" | "caption_projection_receipt"]> = [
    ["caption_approval_sha256", "caption_approval"],
    ["caption_projection_receipt_sha256", "caption_projection_receipt"],
  ];
  for (const [identityKey, artifactKey] of authoredIdentityBindings) {
    const identityValue = receipt.identity[identityKey];
    const artifact = receipt.artifacts[artifactKey];
    if (identityValue !== undefined && (!artifact || identityValue !== artifact.sha256)) {
      throw new Error(`${String(identityKey)} differs from bound authored caption artifact`);
    }
  }
  if (receipt.identity.caption_text_sha256 !== undefined || receipt.identity.caption_timing_sha256 !== undefined) {
    const authored = readAuthoredCaptionIdentity(projectDir);
    if (!authored || receipt.identity.caption_text_sha256 !== authored.caption_text_sha256 || receipt.identity.caption_timing_sha256 !== authored.caption_timing_sha256) {
      throw new Error("authored caption text/timing identity is stale");
    }
  }
  const generationReceipt = readJson<{ inputs: { canonical_timeline_sha256: string }; output: BoundGenerationArtifact }>(resolveContainedFile(projectDir, latest.receipt_path, "generation receipt"));
  if (receipt.artifacts.generation_receipt.path !== latest.receipt_path
    || receipt.artifacts.generation_receipt.sha256 !== latest.receipt_sha256
    || receipt.artifacts.review_video.path !== latest.output_path
    || receipt.artifacts.review_video.sha256 !== latest.output_sha256
    || generationReceipt.output.path !== latest.output_path
    || generationReceipt.output.sha256 !== latest.output_sha256
    || receipt.identity.timeline_sha256 !== generationReceipt.inputs.canonical_timeline_sha256) {
    throw new Error("review timeline/output differs from verified immutable generation receipt");
  }
  const levels = [
    evidenceLevelFromBoundPolicy(projectDir, receipt.artifacts.framing_policy),
    evidenceLevelFromBoundPolicy(projectDir, receipt.artifacts.caption_policy),
  ];
  const geometryEvidence = levels.includes("policy_only") ? "policy_only"
    : levels.includes("platform_measured") ? "platform_measured" : "human_verified";
  return {
    state,
    receipt,
    receipt_sha256: state.qa_receipt!.sha256,
    timeline_sha256: generationReceipt.inputs.canonical_timeline_sha256,
    geometry_evidence_level: geometryEvidence,
  };
}

/** Read and validate the one current dispatched Ask used by response ingestion. */
export function readCurrentReviewAsk(projectDirInput: string): ReviewAskState {
  const projectDir = path.resolve(projectDirInput);
  const freshness = refreshReviewFreshness(projectDir);
  if (freshness.status !== "ready") throw new Error("current review Ask is stale or unavailable");
  const verification = verifyCurrentReviewReady(projectDir);
  const ask = readJson<ReviewAskState>(askPath(projectDir));
  validateArtifact<ReviewAskState>(ask, "review-ask-dispatch.schema.json");
  if (ask.project_id !== verification.state.project_id
    || ask.review_identity !== verification.state.review_identity
    || ask.generation_id !== verification.state.generation_id
    || ask.payload_sha256 !== verification.state.ask_payload_sha256
    || ask.video_sha256 !== verification.receipt.identity.video_sha256
    || ask.timeline_sha256 !== verification.receipt.identity.timeline_sha256) {
    throw new Error("current review Ask identity differs from the current review transaction");
  }
  if (ask.status !== "dispatched" && ask.status !== "responded") {
    throw new Error("current review Ask is not dispatched");
  }
  return ask;
}

export function refreshReviewFreshness(projectDirInput: string): ReviewReadyState {
  const projectDir = path.resolve(projectDirInput);
  recoverInterruptedTransaction(projectDir);
  const state = readJson<ReviewReadyState>(statePath(projectDir));
  if (state.status !== "ready") {
    // Rerun after an interrupted run: complete any supersession whose durable
    // intent (stale Ask + bound ask event + reason) survived the crash.
    healSupersededRoundEvent(projectDir);
    return state;
  }
  let staleReason: string | null = null;
  let receipt: ReviewQaReceipt | null = null;
  try {
    receipt = currentReceipt(projectDir, state);
  } catch (error) {
    staleReason = error instanceof Error ? error.message : String(error);
  }
  try {
    if (receipt && !staleReason) {
      const latest = readLatest(projectDir);
      if (latest.generation_id !== receipt.identity.generation_id) throw new Error("currently verified generation changed");
      for (const [label, artifact] of Object.entries(receipt.artifacts)) {
        const current = bind(projectDir, artifact.path, label);
        if (current.sha256 !== artifact.sha256) throw new Error(`${label} hash changed`);
      }
      if (receipt.identity.caption_text_sha256 !== undefined || receipt.identity.caption_timing_sha256 !== undefined) {
        const authored = readAuthoredCaptionIdentity(projectDir);
        if (!authored || authored.caption_text_sha256 !== receipt.identity.caption_text_sha256 || authored.caption_timing_sha256 !== receipt.identity.caption_timing_sha256) {
          throw new Error("authored caption text/timing identity changed");
        }
      }
    }
  } catch (error) {
    staleReason = error instanceof Error ? error.message : String(error);
  }
  if (!staleReason) {
    // Not stale: heal any supersession intent left incomplete by a previous
    // interrupted run before reporting the ready state.
    healSupersededRoundEvent(projectDir);
    return state;
  }
  const ask = readJson<ReviewAskState>(askPath(projectDir));
  const staleAsk: ReviewAskState = { ...ask, status: "stale", error: staleReason };
  const stale: ReviewReadyState = { ...state, status: "stale", artifacts: { preview: "STALE", qa_receipt: "STALE", unanswered_ask: "STALE" }, reason: staleReason };
  const progress = buildProgress(projectDir, state.project_id, state.review_identity, "stale", staleReason);
  const projectState = buildProjectState(projectDir, state.project_id, state.review_identity, "stale", staleReason);
  validateProjectedState(progress, projectState, stale, staleAsk);
  const entries: BundleEntry[] = [
    { target: path.join(projectDir, "progress.json"), bytes: json(progress) },
    { target: path.join(projectDir, "project_state.yaml"), bytes: stringifyYaml(projectState) },
    { target: statePath(projectDir), bytes: json(stale) },
    // The stale Ask file is the durable supersession intent: it binds the ask
    // history event (round_event_sha256) and the reason, and commits
    // atomically with the stale state so a crash can never leave stale state
    // without recoverable intent.
    { target: askPath(projectDir), bytes: json(staleAsk) },
  ];
  if (fs.existsSync(responsePath(projectDir))) {
    const response = readJson<ReviewResponseReceipt>(responsePath(projectDir));
    const staleResponse: ReviewResponseReceipt = { ...response, status: "stale", invalid_for_current: true, stale_reason: staleReason };
    validateArtifact(staleResponse, "review-response.schema.json");
    entries.push({ target: responsePath(projectDir), bytes: json(staleResponse) });
  }
  commitBundle(entries);
  recordSupersededRoundEvent(projectDir, staleAsk, staleReason);
  return stale;
}

/**
 * Complete a superseded history event for a stale Ask whose durable intent
 * (status "stale" + bound ask event + reason) survived an interrupted run.
 * Idempotent; conflicts fail closed.
 */
function healSupersededRoundEvent(projectDir: string): void {
  if (!fs.existsSync(askPath(projectDir))) return;
  const ask = readJson<ReviewAskState>(askPath(projectDir));
  if (ask.status !== "stale" || !ask.ask_id || !ask.round_event_sha256 || !ask.error) return;
  recordSupersededRoundEvent(projectDir, ask, ask.error);
}

function roundTimelineVersion(projectDir: string, timelinePath: string): string {
  const real = resolveContainedFile(projectDir, timelinePath, "canonical timeline");
  const parsed = JSON.parse(fs.readFileSync(real, "utf8")) as { version?: unknown };
  return typeof parsed.version === "string" || typeof parsed.version === "number" ? String(parsed.version) : "unknown";
}

function buildRoundAskEvent(
  projectDir: string,
  state: ReviewReadyState,
  receipt: ReviewQaReceipt,
  ask: ReviewAskState,
  predecessor: string | null,
): ReviewRoundAskEvent {
  if (!ask.ask_id || !ask.payload_sha256) throw new Error("dispatched review Ask lacks a durable ask identity");
  return buildReviewRoundAskEvent({
    project_id: receipt.project_id,
    generation_id: receipt.identity.generation_id,
    review_identity: receipt.review_identity,
    review_ready_receipt: receipt.artifacts.generation_receipt,
    qa_receipt: {
      path: state.qa_receipt!.path,
      sha256: state.qa_receipt!.sha256,
      status: receipt.status,
    },
    output: receipt.artifacts.review_video,
    timeline: {
      path: receipt.artifacts.timeline.path,
      version: roundTimelineVersion(projectDir, receipt.artifacts.timeline.path),
      hash: receipt.identity.timeline_sha256,
    },
    ask_id: ask.ask_id,
    ask_payload_sha256: ask.payload_sha256,
    predecessor,
  });
}

function findRoundAskEvent(projectDir: string, generationId: string, askId: string): VerifiedRoundEvent | null {
  sweepReviewRoundTemporaries(projectDir);
  const ledger = readReviewRoundLedger(projectDir);
  if (ledger.malformed.length > 0) throw new Error(`review round history is malformed: ${ledger.malformed[0]!.reason}`);
  if (ledger.conflicts.length > 0) throw new Error(`review round history conflict: ${ledger.conflicts[0]}`);
  const matches = ledger.chain.filter((entry) => {
    if (entry.event.version !== "review-round-ask/v1") return false;
    const askEvent = entry.event as ReviewRoundAskEvent;
    return askEvent.generation_id === generationId && askEvent.ask_id === askId;
  });
  if (matches.length > 1) throw new Error(`duplicate review round Ask events for ask ${askId}`);
  return matches[0] ?? null;
}

/**
 * Guarantee the durable ask event exists for a dispatched/reopened Ask.
 * Idempotent: an existing identical event is reused; a conflicting duplicate
 * fails closed.
 */
function ensureReviewRoundAskEvent(
  projectDir: string,
  state: ReviewReadyState,
  receipt: ReviewQaReceipt,
  ask: ReviewAskState,
): { identity: string; event: ReviewRoundAskEvent } {
  const existing = findRoundAskEvent(projectDir, state.generation_id, ask.ask_id!);
  if (existing) return { identity: existing.identity, event: existing.event as ReviewRoundAskEvent };
  const event = buildRoundAskEvent(projectDir, state, receipt, ask, reviewRoundLedgerHead(projectDir));
  const appended = appendReviewRoundEvent(projectDir, event);
  return { identity: appended.identity, event };
}

function ensureReviewRoundResponseEvent(
  projectDir: string,
  askEvent: ReviewRoundAskEvent,
  response: { project_id: string; generation_id: string; ask_id: string; decision: string; text: string | null; review_identity: string; output: { path: string; sha256: string } },
): { identity: string } {
  return withReviewRoundHealLock(projectDir, () => {
    sweepReviewRoundTemporaries(projectDir);
    const ledger = readReviewRoundLedger(projectDir);
    if (ledger.malformed.length > 0) throw new Error(`review round history is malformed: ${ledger.malformed[0]!.reason}`);
    if (ledger.conflicts.length > 0) throw new Error(`review round history conflict: ${ledger.conflicts[0]}`);
    const askEventIdentity = reviewRoundEventIdentity(askEvent);
    const existing = ledger.chain.find((entry) => entry.event.version === "review-round-response/v1"
      && (entry.event as { ask_event: string }).ask_event === askEventIdentity);
    if (existing) {
      const prior = existing.event as ReviewRoundResponseEvent;
      const expectedHash = reviewRoundResponseHash({ ask_id: response.ask_id, decision: response.decision, text: response.text });
      if (prior.ask_id !== response.ask_id || prior.decision !== response.decision
        || prior.text !== response.text || prior.response_sha256 !== expectedHash) {
        throw new Error("review round response event conflicts with the recorded human decision");
      }
      // Heal the durable response artifact if an interrupted run lost it.
      const artifact = buildReviewRoundResponseArtifact({
        project_id: prior.project_id,
        generation_id: prior.generation_id,
        review_identity: prior.review_identity,
        ask_event: prior.ask_event,
        ask_id: prior.ask_id,
        decision: prior.decision,
        text: prior.text,
        output: response.output,
      });
      appendReviewRoundResponseArtifact(projectDir, artifact);
      if (prior.artifact.sha256 !== sha256File(reviewRoundResponseArtifactPath(projectDir, reviewRoundResponseArtifactIdentity(artifact)))) {
        throw new Error("review round response artifact does not match the bound hash");
      }
      return { identity: existing.identity };
    }
    // The immutable durable response artifact is written BEFORE the event so
    // an event always references an existing artifact.
    const artifact = buildReviewRoundResponseArtifact({
      project_id: response.project_id,
      generation_id: response.generation_id,
      review_identity: response.review_identity,
      ask_event: askEventIdentity,
      ask_id: response.ask_id,
      decision: response.decision as "approve" | "request_changes" | "free_text",
      text: response.text,
      output: response.output,
    });
    const artifactWritten = appendReviewRoundResponseArtifact(projectDir, artifact);
    const appended = appendReviewRoundEvent(projectDir, buildReviewRoundResponseEvent({
      project_id: response.project_id,
      generation_id: response.generation_id,
      review_identity: response.review_identity,
      ask_event: askEventIdentity,
      ask_id: response.ask_id,
      decision: response.decision as "approve" | "request_changes" | "free_text",
      text: response.text,
      response_sha256: reviewRoundResponseHash({ ask_id: response.ask_id, decision: response.decision, text: response.text }),
      artifact: { path: `${REVIEW_ROUND_RESPONSES_DIR}/${artifactWritten.identity.slice("sha256:".length)}.json`, sha256: sha256File(artifactWritten.file) },
      predecessor: askEventIdentity,
    }));
    return { identity: appended.identity };
  });
}

/**
 * Supersede one outstanding (unanswered) Ask. The superseded event's
 * predecessor must be exactly the ask event it supersedes, and every bound
 * axis (project, generation, review identity, Ask) must match. Serialized by
 * the heal lock; idempotent for an already-superseded Ask.
 */
function supersedeRoundAskEvent(projectDir: string, askEvent: ReviewRoundAskEvent, askEventIdentity: string, reason: string): void {
  withReviewRoundHealLock(projectDir, () => {
    sweepReviewRoundTemporaries(projectDir);
    const ledger = readReviewRoundLedger(projectDir);
    if (ledger.malformed.length > 0) throw new Error(`review round history is malformed: ${ledger.malformed[0]!.reason}`);
    if (ledger.conflicts.length > 0) throw new Error(`review round history conflict: ${ledger.conflicts[0]}`);
    const alreadySuperseded = ledger.chain.some((entry) => entry.event.version === "review-round-superseded/v1"
      && (entry.event as { ask_event: string }).ask_event === askEventIdentity);
    if (alreadySuperseded) return;
    // A supersession may only target one unresolved Ask: the ask event must
    // still be the chain head (no response, no later ask recorded after it).
    const head = ledger.chain[ledger.chain.length - 1]!.identity;
    if (head !== askEventIdentity) {
      throw new Error("supersession target is no longer the outstanding Ask");
    }
    appendReviewRoundEvent(projectDir, buildReviewRoundSupersededEvent({
      project_id: askEvent.project_id,
      generation_id: askEvent.generation_id,
      review_identity: askEvent.review_identity,
      ask_event: askEventIdentity,
      ask_id: askEvent.ask_id,
      reason,
      predecessor: askEventIdentity,
    }));
  });
}

function recordSupersededRoundEvent(projectDir: string, staleAsk: ReviewAskState, reason: string): void {
  if (!staleAsk.ask_id || !staleAsk.round_event_sha256) return;
  sweepReviewRoundTemporaries(projectDir);
  const ledger = readReviewRoundLedger(projectDir);
  if (ledger.malformed.length > 0) throw new Error(`review round history is malformed: ${ledger.malformed[0]!.reason}`);
  if (ledger.conflicts.length > 0) throw new Error(`review round history conflict: ${ledger.conflicts[0]}`);
  const existing = ledger.chain.find((entry) => entry.identity === staleAsk.round_event_sha256);
  if (!existing) return; // the bound ask event is gone; nothing durable to supersede
  if (existing.event.version !== "review-round-ask/v1") {
    throw new Error("stale Ask binds a round history event that is not an Ask");
  }
  const askEvent = existing.event as ReviewRoundAskEvent;
  if (askEvent.project_id !== staleAsk.project_id
    || askEvent.generation_id !== staleAsk.generation_id
    || askEvent.ask_id !== staleAsk.ask_id) {
    throw new Error("stale Ask does not bind the round history event it supersedes");
  }
  // A completed round (its Ask already has a durable response) is never
  // superseded; the stale transition only marks the review state stale.
  const ledgerHasResponse = ledger.chain.some((entry) => entry.event.version === "review-round-response/v1"
    && (entry.event as { ask_event: string }).ask_event === existing.identity);
  if (ledgerHasResponse) return;
  supersedeRoundAskEvent(projectDir, askEvent, existing.identity, reason);
}

/**
 * Before a finalize overwrites Ask/state: if the durable Ask still binds an
 * outstanding ask history event (pending or dispatched, never responded),
 * supersede it so the chain can never become Ask(old)->Ask(new) with the old
 * round left unanswered.
 */
function supersedeOutstandingAskBeforeFinalize(projectDir: string): void {
  if (!fs.existsSync(askPath(projectDir))) return;
  const ask = readJson<ReviewAskState>(askPath(projectDir));
  if (ask.status !== "pending" && ask.status !== "dispatched") return;
  if (!ask.ask_id) return;
  sweepReviewRoundTemporaries(projectDir);
  const ledger = readReviewRoundLedger(projectDir);
  if (ledger.malformed.length > 0) throw new Error(`review round history is malformed: ${ledger.malformed[0]!.reason}`);
  if (ledger.conflicts.length > 0) throw new Error(`review round history conflict: ${ledger.conflicts[0]}`);
  const existing = findRoundAskEvent(projectDir, ask.generation_id, ask.ask_id);
  if (!existing) return; // Ask was never durably dispatched; nothing to supersede
  supersedeRoundAskEvent(projectDir, existing.event as ReviewRoundAskEvent, existing.identity, "superseded by a newer review generation finalize");
}

export async function dispatchReviewAsk(projectDirInput: string, adapter: ReviewAskAdapter): Promise<ReviewAskState> {
  const projectDir = path.resolve(projectDirInput);
  const freshness = refreshReviewFreshness(projectDir);
  if (freshness.status !== "ready") throw new Error(`stale or closed review identity cannot dispatch an Ask: ${freshness.reason ?? freshness.status}`);
  const state = readJson<ReviewAskState>(askPath(projectDir));
  if (!state.payload || !SHA256.test(state.idempotency_key)) throw new Error("review Ask payload is not dispatchable");
  const payloadSha256 = hashCanonical(state.payload);
  if (payloadSha256 !== state.payload_sha256 || payloadSha256 !== freshness.ask_payload_sha256) throw new Error("review Ask payload hash differs for this idempotency key");
  if (state.status === "dispatched" || state.status === "responded") {
    // Idempotent re-dispatch: heal the durable round history if a previous
    // append was interrupted, then return the already-dispatched state.
    ensureReviewRoundAskEvent(projectDir, freshness, currentReceipt(projectDir, freshness), state);
    return state;
  }
  try {
    const result = await adapter.dispatch({ idempotencyKey: state.idempotency_key, payload: state.payload });
    const dispatched = { ...state, status: "dispatched" as const, attempts: state.attempts + 1, ask_id: result.ask_id, error: null };
    const roundEvent = buildRoundAskEvent(projectDir, freshness, currentReceipt(projectDir, freshness), dispatched, reviewRoundLedgerHead(projectDir));
    const withBinding: ReviewAskState = { ...dispatched, round_event_sha256: reviewRoundEventIdentity(roundEvent) };
    validateArtifact(withBinding, "review-ask-dispatch.schema.json");
    commitBundle([{ target: askPath(projectDir), bytes: json(withBinding) }]);
    appendReviewRoundEvent(projectDir, roundEvent);
    return withBinding;
  } catch (error) {
    const failed = { ...state, status: "dispatch_failed" as const, attempts: state.attempts + 1, error: error instanceof Error ? error.message : String(error) };
    validateArtifact(failed, "review-ask-dispatch.schema.json");
    commitBundle([{ target: askPath(projectDir), bytes: json(failed) }]);
    throw error;
  }
}

export async function recordReviewResponse(projectDirInput: string, response: ReviewResponseInput): Promise<ReviewResponseReceipt> {
  const projectDir = path.resolve(projectDirInput);
  const freshness = refreshReviewFreshness(projectDir);
  if (freshness.status !== "ready") throw new Error("stale review Ask response cannot be accepted");
  const receipt = currentReceipt(projectDir, freshness);
  const ask = readJson<ReviewAskState>(askPath(projectDir));
  const expected = { review_identity: receipt.review_identity, generation_id: receipt.identity.generation_id, video_sha256: receipt.identity.video_sha256, timeline_sha256: receipt.identity.timeline_sha256, ask_id: ask.ask_id };
  if (canonicalJson({ review_identity: response.review_identity, generation_id: response.generation_id, video_sha256: response.video_sha256, timeline_sha256: response.timeline_sha256, ask_id: response.ask_id }) !== canonicalJson(expected)) {
    throw new Error("human response identity binding mismatch");
  }
  if (ask.status !== "dispatched" || !ask.ask_id) {
    // Idempotent healing: if the response was already recorded durably but a
    // history append was interrupted, complete the immutable history now.
    if (ask.status === "responded" && fs.existsSync(responsePath(projectDir))) {
      const stored = readJson<ReviewResponseReceipt>(responsePath(projectDir));
      if (stored.ask_id !== response.ask_id || stored.decision !== response.decision
        || (stored.text ?? null) !== (response.text ?? null)) {
        throw new Error("recorded review response conflicts with the offered response");
      }
      const askEvent = ensureReviewRoundAskEvent(projectDir, freshness, receipt, ask);
      ensureReviewRoundResponseEvent(projectDir, askEvent.event, {
        project_id: receipt.project_id,
        generation_id: response.generation_id,
        ask_id: response.ask_id,
        decision: response.decision,
        text: response.text,
        review_identity: receipt.review_identity,
        output: { path: receipt.artifacts.review_video.path, sha256: receipt.identity.video_sha256 },
      });
      return stored;
    }
    throw new Error("human response requires a dispatched current Ask");
  }
  const askEvent = ensureReviewRoundAskEvent(projectDir, freshness, receipt, ask);
  const responseEvent = buildReviewRoundResponseEvent({
    project_id: receipt.project_id,
    generation_id: response.generation_id,
    review_identity: receipt.review_identity,
    ask_event: askEvent.identity,
    ask_id: response.ask_id,
    decision: response.decision,
    text: response.text,
    response_sha256: reviewRoundResponseHash({ ask_id: response.ask_id, decision: response.decision, text: response.text }),
    artifact: { path: "", sha256: "sha256:" },
    predecessor: askEvent.identity,
  });
  // The immutable durable response artifact is written before the event and
  // pointer bundle, so every event always references an existing artifact.
  const responseArtifact = buildReviewRoundResponseArtifact({
    project_id: receipt.project_id,
    generation_id: response.generation_id,
    review_identity: receipt.review_identity,
    ask_event: askEvent.identity,
    ask_id: response.ask_id,
    decision: response.decision,
    text: response.text,
    output: { path: receipt.artifacts.review_video.path, sha256: receipt.identity.video_sha256 },
  });
  const artifactWritten = appendReviewRoundResponseArtifact(projectDir, responseArtifact);
  const withArtifact: ReviewRoundResponseEvent = {
    ...responseEvent,
    artifact: {
      path: `${REVIEW_ROUND_RESPONSES_DIR}/${artifactWritten.identity.slice("sha256:".length)}.json`,
      sha256: sha256File(artifactWritten.file),
    },
  };
  const responseReceipt: ReviewResponseReceipt = {
    version: "review-response/v1",
    project_id: receipt.project_id,
    ...response,
    status: "current",
    invalid_for_current: false,
    stale_reason: null,
    round_event_sha256: reviewRoundEventIdentity(withArtifact),
  };
  validateArtifact<ReviewResponseReceipt>(responseReceipt, "review-response.schema.json");
  commitBundle([
    { target: path.join(projectDir, "06_review/review-response.json"), bytes: json(responseReceipt) },
    { target: askPath(projectDir), bytes: json({ ...ask, status: "responded", error: null }) },
  ]);
  appendReviewRoundEvent(projectDir, withArtifact);
  return responseReceipt;
}

export function readCurrentReviewResponse(projectDirInput: string): ReviewResponseReceipt {
  const projectDir = path.resolve(projectDirInput);
  const freshness = refreshReviewFreshness(projectDir);
  if (freshness.status !== "ready") throw new Error("review response is stale or invalid for current identity");
  const response = readJson<ReviewResponseReceipt>(responsePath(projectDir));
  validateArtifact(response, "review-response.schema.json");
  if (response.status !== "current" || response.invalid_for_current) throw new Error("review response is stale or invalid for current identity");
  const receipt = currentReceipt(projectDir, freshness);
  if (response.review_identity !== receipt.review_identity || response.generation_id !== receipt.identity.generation_id || response.video_sha256 !== receipt.identity.video_sha256 || response.timeline_sha256 !== receipt.identity.timeline_sha256) throw new Error("review response identity is invalid for current review");
  return response;
}

export class FakeReviewAskAdapter implements ReviewAskAdapter {
  readonly requests: Array<{ idempotencyKey: string; payload: ReviewAskPayload }> = [];
  private readonly asks = new Map<string, { ask_id: string; payload_sha256: string }>();
  private failAfterCreateOnce: boolean;

  constructor(options: { failAfterCreateOnce?: boolean } = {}) {
    this.failAfterCreateOnce = options.failAfterCreateOnce ?? false;
  }

  get createdCount(): number { return this.asks.size; }

  async dispatch(request: { idempotencyKey: string; payload: ReviewAskPayload }): Promise<{ ask_id: string }> {
    this.requests.push(request);
    const existing = this.asks.get(request.idempotencyKey);
    const payloadSha256 = hashCanonical(request.payload);
    if (existing) {
      if (existing.payload_sha256 !== payloadSha256) throw new Error("idempotency key was reused with a different payload hash");
      return { ask_id: existing.ask_id };
    }
    const created = { ask_id: `fake-ask-${this.asks.size + 1}`, payload_sha256: payloadSha256 };
    this.asks.set(request.idempotencyKey, created);
    if (this.failAfterCreateOnce) {
      this.failAfterCreateOnce = false;
      throw new Error("synthetic dispatch failure after create");
    }
    return { ask_id: created.ask_id };
  }
}
