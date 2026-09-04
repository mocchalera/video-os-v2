import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { sha256File } from "./social-review-generation.js";
import {
  readCurrentReviewAsk,
  recordReviewResponse,
  type ReviewAskAdapter,
  type ReviewAskPayload,
  type ReviewAskState,
  type ReviewResponseReceipt,
} from "./review-ready-transaction.js";

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const REVIEW_VIDEO_RELATIVE = "09_output/social-review/generations";

export interface CockpitCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface CockpitCommandOptions {
  cwd: string;
  stdin?: string;
}

export type CockpitCommandRunner = (
  args: string[],
  options: CockpitCommandOptions,
) => CockpitCommandResult | Promise<CockpitCommandResult>;

export interface CockpitReviewAskAdapterOptions {
  projectDir: string;
  command?: string;
  runner?: CockpitCommandRunner;
}

interface CommandEnvelope {
  ok?: unknown;
  data?: unknown;
}

interface CreateAskData {
  askId?: unknown;
  status?: unknown;
}

interface OpenAskRecord {
  askId: string;
  text: string;
}

export interface CockpitAskResolvedV1 {
  event: "cockpit.ask.resolved";
  version: 1;
  ask_id: string;
  outcome: "answered";
  answered_by: "user";
  answers: [{ type: "choice" | "input"; value: string }];
}

export interface MappedReviewResponse {
  ask_id: string;
  decision: "approve" | "request_changes" | "free_text";
  text: string | null;
}

/**
 * Execute a first-party Cockpit command without a shell. The only input sent
 * to stdin is the caller-provided summary; argv never contains the summary.
 */
export function runCockpitCommand(
  command: string,
  args: string[],
  options: CockpitCommandOptions,
): Promise<CockpitCommandResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let commandError: string | undefined;
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.stdin.on("error", (error: Error) => {
      commandError = error.message;
    });
    child.on("error", (error: Error) => {
      commandError = error.message;
    });
    child.on("close", (status: number | null) => {
      resolve({
        status,
        stdout,
        stderr,
        ...(commandError ? { error: commandError } : {}),
      });
    });
    child.stdin.end(options.stdin ?? "");
  });
};

export function reviewIdentityMarker(reviewIdentity: string): string {
  return `review_identity=${reviewIdentity}`;
}

function listLines(label: string, values: string[]): string[] {
  return values.length > 0 ? [label, ...values.map((value) => `- ${value}`)] : [label, "- none"];
}

/** Build the exact summary bytes passed to `cockpit ask --stdin`. */
export function buildReviewAskSummary(payload: ReviewAskPayload): string {
  const lines = [
    "Video OS review-ready generation review",
    reviewIdentityMarker(payload.review_identity),
    `generation_id=${payload.generation_id}`,
    `duration_seconds=${payload.duration_seconds}`,
    `bgm=${payload.bgm}`,
    `caption_count=${payload.caption_count}`,
    "",
    ...listLines("QA warnings:", payload.qa_warnings),
    "",
    ...listLines("Human residual items:", payload.unresolved_items),
    "",
    "Storyboard diff:",
    `projection_id=${payload.storyboard.projection_id}`,
    ...listLines("trims:", payload.storyboard.diff_summary.trims),
    ...listLines("crops:", payload.storyboard.diff_summary.crops),
    ...listLines("captions:", payload.storyboard.diff_summary.captions),
    "",
    "Approve records review approval only; it does not authorize publication or external sharing.",
  ];
  return `${lines.join("\n")}\n`;
}

function projectRoot(projectDir: string): string {
  return fs.realpathSync(path.resolve(projectDir));
}

function resolveVerifiedReviewVideo(projectDir: string, payload: ReviewAskPayload): string {
  if (!SHA256.test(payload.review_identity) || !SHA256.test(payload.generation_id)
    || !SHA256.test(payload.media.sha256)) {
    throw new Error("review Ask payload contains an invalid identity");
  }
  if (!payload.media.locator.startsWith("project:")) {
    throw new Error("review Ask media must use a project-contained locator");
  }
  const relative = payload.media.locator.slice("project:".length);
  const expected = `${REVIEW_VIDEO_RELATIVE}/${payload.generation_id.slice("sha256:".length)}/review.mp4`;
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..") || relative !== expected) {
    throw new Error("review Ask media must be the canonical immutable generation review.mp4");
  }
  const root = projectRoot(projectDir);
  const lexical = path.resolve(root, relative);
  if (!lexical.startsWith(`${root}${path.sep}`) || fs.lstatSync(lexical).isSymbolicLink()) {
    throw new Error("review Ask media path is not a real project-contained file");
  }
  const real = fs.realpathSync(lexical);
  if (real !== lexical || !fs.statSync(real).isFile()) {
    throw new Error("review Ask media path is not a canonical regular file");
  }
  if (sha256File(real) !== payload.media.sha256) {
    throw new Error("review Ask media hash differs from the bound immutable output");
  }
  return real;
}

function parseJson(stdout: string, label: string): CommandEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`${label} returned malformed JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} returned a malformed response envelope`);
  }
  return parsed as CommandEnvelope;
}

function runResultOrThrow(result: CockpitCommandResult, label: string): CommandEnvelope {
  if (result.error || result.status !== 0) {
    throw new Error(`${label} failed`);
  }
  return parseJson(result.stdout, label);
}

function askId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`${label} did not return a non-empty Ask ID`);
  }
  return value;
}

function extractAskText(record: Record<string, unknown>): string {
  const values: string[] = [];
  for (const key of ["summary", "question", "text"]) {
    if (typeof record[key] === "string") values.push(record[key] as string);
  }
  if (Array.isArray(record.questions)) {
    for (const question of record.questions) {
      if (!question || typeof question !== "object" || Array.isArray(question)) continue;
      for (const key of ["summary", "question", "text"]) {
        const value = (question as Record<string, unknown>)[key];
        if (typeof value === "string") values.push(value);
      }
    }
  }
  return values.join("\n");
}

function currentTaskId(envelope: CommandEnvelope): string {
  if (envelope.ok !== true || !envelope.data || typeof envelope.data !== "object" || Array.isArray(envelope.data)) {
    throw new Error("cockpit task current returned a malformed response envelope");
  }
  const data = envelope.data as Record<string, unknown>;
  const hasId = Object.prototype.hasOwnProperty.call(data, "id");
  const hasTaskId = Object.prototype.hasOwnProperty.call(data, "taskId");
  if (!hasId && !hasTaskId) throw new Error("cockpit task current did not return a task ID");
  const id = hasId ? askId(data.id, "cockpit task current id") : undefined;
  const taskId = hasTaskId ? askId(data.taskId, "cockpit task current taskId") : undefined;
  if (id && taskId && id !== taskId) throw new Error("cockpit task current returned conflicting task IDs");
  return id ?? taskId!;
}

function scopedTaskId(record: Record<string, unknown>, index: number, currentTask: string): void {
  const hasTaskId = Object.prototype.hasOwnProperty.call(record, "taskId");
  const hasSnakeTaskId = Object.prototype.hasOwnProperty.call(record, "task_id");
  if (!hasTaskId && !hasSnakeTaskId) return;
  const taskId = hasTaskId ? askId(record.taskId, `cockpit ask list entry ${index} taskId`) : undefined;
  const snakeTaskId = hasSnakeTaskId ? askId(record.task_id, `cockpit ask list entry ${index} task_id`) : undefined;
  if (taskId && snakeTaskId && taskId !== snakeTaskId) throw new Error(`cockpit ask list entry ${index} has conflicting task IDs`);
  if ((taskId ?? snakeTaskId) !== currentTask) throw new Error(`cockpit ask list entry ${index} is not bound to the current task`);
}

function openAskRecords(envelope: CommandEnvelope, currentTask: string): OpenAskRecord[] {
  if (envelope.ok !== true || !envelope.data || typeof envelope.data !== "object" || Array.isArray(envelope.data)) {
    throw new Error("cockpit ask list returned a malformed response envelope");
  }
  const data = envelope.data as Record<string, unknown>;
  const rawAsks = Array.isArray(data.asks) ? data.asks : undefined;
  if (!rawAsks) throw new Error("cockpit ask list did not return asks");
  return rawAsks.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`cockpit ask list entry ${index} is malformed`);
    }
    const record = raw as Record<string, unknown>;
    const id = record.askId ?? record.ask_id ?? record.id;
    scopedTaskId(record, index, currentTask);
    return { askId: askId(id, `cockpit ask list entry ${index}`), text: extractAskText(record) };
  });
}

async function findExistingAsk(
  runner: CockpitCommandRunner,
  projectDir: string,
  marker: string,
): Promise<string | null> {
  const currentResult = await runner(["task", "current"], { cwd: projectDir });
  const currentTask = currentTaskId(runResultOrThrow(currentResult, "cockpit task current"));
  const result = await runner(["ask", "list", "--task", currentTask], { cwd: projectDir });
  const records = openAskRecords(runResultOrThrow(result, "cockpit ask list"), currentTask);
  const matches = records.filter((record) => record.text.includes(marker));
  if (matches.length === 0) return null;
  if (matches.length > 1) throw new Error("cockpit ask list contains multiple matching review Asks");
  return matches[0]!.askId;
}

function parseCreateAsk(result: CockpitCommandResult): string {
  const envelope = runResultOrThrow(result, "cockpit ask");
  if (envelope.ok !== true || !envelope.data || typeof envelope.data !== "object" || Array.isArray(envelope.data)) {
    throw new Error("cockpit ask returned a malformed response envelope");
  }
  const data = envelope.data as CreateAskData;
  if (data.status !== "scheduled") throw new Error("cockpit ask did not schedule the Ask");
  return askId(data.askId, "cockpit ask");
}

export class CockpitReviewAskAdapter implements ReviewAskAdapter {
  private readonly projectDir: string;
  private readonly command: string;
  private readonly runner: CockpitCommandRunner;

  constructor(options: CockpitReviewAskAdapterOptions) {
    this.projectDir = projectRoot(options.projectDir);
    this.command = options.command ?? "cockpit";
    this.runner = options.runner ?? ((args, commandOptions) => runCockpitCommand(this.command, args, commandOptions));
  }

  async dispatch(request: { idempotencyKey: string; payload: ReviewAskPayload }): Promise<{ ask_id: string }> {
    if (request.idempotencyKey !== request.payload.review_identity || !SHA256.test(request.idempotencyKey)) {
      throw new Error("review Ask idempotency key is not bound to the review identity");
    }
    const mediaPath = resolveVerifiedReviewVideo(this.projectDir, request.payload);
    const summary = buildReviewAskSummary(request.payload);
    const marker = reviewIdentityMarker(request.payload.review_identity);
    const existing = await findExistingAsk(this.runner, this.projectDir, marker);
    if (existing) return { ask_id: existing };
    const result = await this.runner([
      "ask",
      "--stdin",
      "--choice",
      "approve",
      "--choice",
      "request_changes",
      "--media",
      mediaPath,
    ], { cwd: this.projectDir, stdin: summary });
    return { ask_id: parseCreateAsk(result) };
  }
}

function exactKeys(record: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(record).sort().join("\0");
  if (actual !== [...expected].sort().join("\0")) throw new Error(`${label} has unexpected or missing fields`);
}

function recordFromCockpitEvent(value: unknown): MappedReviewResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("resolved review event must be an object");
  }
  const record = value as Record<string, unknown>;
  exactKeys(record, ["event", "version", "ask_id", "outcome", "answered_by", "answers"], "resolved Cockpit Ask event");
  if (record.event !== "cockpit.ask.resolved" || record.version !== 1 || record.outcome !== "answered" || record.answered_by !== "user") {
    throw new Error("resolved Cockpit Ask event is not the exact v1 user answer contract");
  }
  if (typeof record.ask_id !== "string" || record.ask_id.length === 0 || !Array.isArray(record.answers) || record.answers.length !== 1) {
    throw new Error("resolved Cockpit Ask event does not contain one valid answer");
  }
  const answer = record.answers[0];
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) throw new Error("resolved Cockpit Ask answer is malformed");
  const answerRecord = answer as Record<string, unknown>;
  exactKeys(answerRecord, ["type", "value"], "resolved Cockpit Ask answer");
  if (answerRecord.type === "choice" && (answerRecord.value === "approve" || answerRecord.value === "request_changes")) {
    return { ask_id: record.ask_id, decision: answerRecord.value, text: null };
  }
  if (answerRecord.type === "input" && typeof answerRecord.value === "string" && answerRecord.value.trim().length > 0) {
    return { ask_id: record.ask_id, decision: "free_text", text: answerRecord.value };
  }
  throw new Error("resolved Cockpit Ask answer is not approve, request_changes, or nonblank free-form input");
}

/** Parse only the exact Cockpit v1 event; local explicit responses are not authority. */
export function mapReviewResponseEvent(value: unknown): MappedReviewResponse {
  return recordFromCockpitEvent(value);
}

export async function recordCockpitAskResolved(
  projectDirInput: string,
  event: unknown,
): Promise<ReviewResponseReceipt> {
  const mapped = mapReviewResponseEvent(event);
  const currentAsk: ReviewAskState = readCurrentReviewAsk(projectDirInput);
  if (currentAsk.status !== "dispatched" && currentAsk.status !== "responded") {
    throw new Error("resolved review event requires a current dispatched Ask");
  }
  if (currentAsk.ask_id !== mapped.ask_id) {
    throw new Error("resolved review event Ask ID does not match the current dispatched Ask");
  }
  return recordReviewResponse(projectDirInput, {
    review_identity: currentAsk.review_identity,
    generation_id: currentAsk.generation_id,
    video_sha256: currentAsk.video_sha256,
    timeline_sha256: currentAsk.timeline_sha256,
    ask_id: mapped.ask_id,
    decision: mapped.decision,
    text: mapped.text,
  });
}

export function parseReviewResponseJson(bytes: string): MappedReviewResponse {
  let value: unknown;
  try {
    value = JSON.parse(bytes);
  } catch {
    throw new Error("review response event is malformed JSON");
  }
  return mapReviewResponseEvent(value);
}
