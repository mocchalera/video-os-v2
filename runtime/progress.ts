/**
 * Structured progress tracking for Video OS v2 pipelines.
 *
 * Writes progress.json to projects/<id>/progress.json so master agents
 * can poll structured status instead of parsing terminal output.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ── Types ──────────────────────────────────────────────────────────

export type ProgressPhase =
  | "analysis"
  | "intent"
  | "triage"
  | "blueprint"
  | "compile"
  | "review"
  | "render"
  | "package";

export type ProgressStatus = "running" | "completed" | "failed" | "blocked";

export interface ProgressReport {
  project_id: string;
  phase: ProgressPhase;
  gate: number;
  status: ProgressStatus;
  completed: number;
  total: number;
  eta_sec: number | null;
  artifacts_created: string[];
  errors: ProgressError[];
  started_at: string;
  updated_at: string;
}

export interface ProgressError {
  stage: string;
  message: string;
  timestamp: string;
  retriable: boolean;
}

export type PipelineTimingStage =
  | "ingest"
  | "marlin"
  | "stt"
  | "embeddings"
  | "peak"
  | "visual-quality"
  | "triage"
  | "blueprint"
  | "compile"
  | "render"
  | "QA";

export type PipelineTimingStageStatus = "running" | "completed" | "failed" | "skipped";
export type PipelineTimingRunStatus = "completed" | "failed";

export interface PipelineStageTiming {
  stage: PipelineTimingStage;
  status: PipelineTimingStageStatus;
  started_at: string;
  ended_at?: string;
  duration_ms?: number;
  error?: string;
}

export interface PipelineTimingRun {
  run_id: string;
  project_id: string;
  entrypoint: string;
  started_at: string;
  completed_at?: string;
  status: PipelineTimingRunStatus;
  segment_count?: number;
  stages: PipelineStageTiming[];
}

export interface PipelineTimingsFile {
  version: 1;
  project_id: string;
  updated_at: string;
  runs: PipelineTimingRun[];
}

export interface PipelineStageProgressHandle {
  complete(): void;
  fail(error: unknown): void;
  skip(reason?: string): void;
}

export interface PipelineStageProgress {
  beginStage(stage: PipelineTimingStage): PipelineStageProgressHandle;
  track<T>(stage: PipelineTimingStage, fn: () => T | Promise<T>): Promise<T>;
}

interface OutputStream {
  isTTY?: boolean;
  write(chunk: string): unknown;
}

export interface PipelineStageProgressTrackerOptions {
  projectDir: string;
  entrypoint: string;
  stages: PipelineTimingStage[];
  segmentCount?: number;
  output?: OutputStream;
  enabled?: boolean;
  intervalMs?: number;
  now?: () => number;
  runId?: string;
}

export interface FormatPipelineProgressInput {
  stageIndex: number;
  totalStages: number;
  stage: PipelineTimingStage;
  status: PipelineTimingStageStatus;
  elapsedMs: number;
  estimatedRemainingMs: number | null;
  estimatedTotalMs: number | null;
}

export interface StageEstimate {
  estimatedMs: number | null;
  source: "history" | "segments" | "unknown";
}

// ── Phase → Gate mapping ───────────────────────────────────────────

const PHASE_GATE_MAP: Record<ProgressPhase, number> = {
  intent: 0,
  analysis: 1,
  triage: 2,
  blueprint: 3,
  compile: 4,
  review: 5,
  render: 6,
  package: 7,
};

const FALLBACK_STAGE_ESTIMATE: Record<PipelineTimingStage, { baseMs: number; perSegmentMs: number }> = {
  ingest: { baseMs: 15_000, perSegmentMs: 1_000 },
  marlin: { baseMs: 45_000, perSegmentMs: 12_000 },
  stt: { baseMs: 20_000, perSegmentMs: 7_500 },
  embeddings: { baseMs: 30_000, perSegmentMs: 4_000 },
  peak: { baseMs: 20_000, perSegmentMs: 3_000 },
  "visual-quality": { baseMs: 25_000, perSegmentMs: 5_000 },
  triage: { baseMs: 30_000, perSegmentMs: 2_000 },
  blueprint: { baseMs: 35_000, perSegmentMs: 1_000 },
  compile: { baseMs: 10_000, perSegmentMs: 300 },
  render: { baseMs: 30_000, perSegmentMs: 1_500 },
  QA: { baseMs: 45_000, perSegmentMs: 2_000 },
};

// ── ProgressTracker class ──────────────────────────────────────────

export class ProgressTracker {
  private projectDir: string;
  private projectId: string;
  private report: ProgressReport;
  private progressPath: string;
  private startTime: number;

  constructor(projectDir: string, phase: ProgressPhase, total: number) {
    this.projectDir = path.resolve(projectDir);
    this.projectId = path.basename(this.projectDir);
    this.progressPath = path.join(this.projectDir, "progress.json");
    this.startTime = Date.now();

    const now = new Date().toISOString();
    this.report = {
      project_id: this.projectId,
      phase,
      gate: PHASE_GATE_MAP[phase],
      status: "running",
      completed: 0,
      total,
      eta_sec: null,
      artifacts_created: [],
      errors: [],
      started_at: now,
      updated_at: now,
    };

    this.flush();
  }

  /** Advance completed count and optionally register a new artifact. */
  advance(artifact?: string): void {
    this.report.completed = Math.min(this.report.completed + 1, this.report.total);
    if (artifact) {
      this.report.artifacts_created.push(artifact);
    }
    this.report.eta_sec = this.estimateEta();
    this.report.updated_at = new Date().toISOString();
    this.flush();
  }

  /** Record an error without changing status to failed. */
  recordError(stage: string, message: string, retriable = false): void {
    this.report.errors.push({
      stage,
      message,
      timestamp: new Date().toISOString(),
      retriable,
    });
    this.report.updated_at = new Date().toISOString();
    this.flush();
  }

  /** Mark the phase as completed. */
  complete(finalArtifacts?: string[]): void {
    this.report.status = "completed";
    this.report.completed = this.report.total;
    this.report.eta_sec = 0;
    if (finalArtifacts) {
      for (const a of finalArtifacts) {
        if (!this.report.artifacts_created.includes(a)) {
          this.report.artifacts_created.push(a);
        }
      }
    }
    this.report.updated_at = new Date().toISOString();
    this.flush();
  }

  /** Mark the phase as failed. */
  fail(stage: string, message: string): void {
    this.report.status = "failed";
    this.recordError(stage, message, false);
  }

  /** Mark the phase as blocked. */
  block(stage: string, message: string): void {
    this.report.status = "blocked";
    this.recordError(stage, message, false);
  }

  /** Update total step count (useful when total isn't known upfront). */
  setTotal(total: number): void {
    this.report.total = total;
    this.report.updated_at = new Date().toISOString();
    this.flush();
  }

  /** Get a snapshot of the current report (for testing). */
  snapshot(): Readonly<ProgressReport> {
    return { ...this.report, errors: [...this.report.errors], artifacts_created: [...this.report.artifacts_created] };
  }

  /** Get the path to progress.json. */
  get filePath(): string {
    return this.progressPath;
  }

  // ── Private helpers ──────────────────────────────────────────────

  private estimateEta(): number | null {
    if (this.report.completed === 0) return null;
    const elapsed = (Date.now() - this.startTime) / 1000;
    const rate = this.report.completed / elapsed;
    const remaining = this.report.total - this.report.completed;
    return Math.round(remaining / rate);
  }

  private flush(): void {
    const dir = path.dirname(this.progressPath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = this.progressPath + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(this.report, null, 2));
    fs.renameSync(tmp, this.progressPath);
  }
}

// ── Staged pipeline timing + ETA ──────────────────────────────────

export class PipelineStageProgressTracker implements PipelineStageProgress {
  private readonly projectDir: string;
  private readonly projectId: string;
  private readonly entrypoint: string;
  private readonly stages: PipelineTimingStage[];
  private readonly output: OutputStream;
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly run: PipelineTimingRun;
  private estimates: Map<PipelineTimingStage, StageEstimate>;
  private timer: NodeJS.Timeout | null = null;
  private active: {
    stage: PipelineTimingStage;
    startedAtMs: number;
    timing: PipelineStageTiming;
  } | null = null;
  private closed = false;
  private lastLineLength = 0;

  constructor(options: PipelineStageProgressTrackerOptions) {
    this.projectDir = path.resolve(options.projectDir);
    this.projectId = path.basename(this.projectDir);
    this.entrypoint = options.entrypoint;
    this.stages = [...options.stages];
    this.output = options.output ?? process.stderr;
    this.enabled = options.enabled ?? process.env.VIDEO_OS_PROGRESS !== "0";
    this.intervalMs = options.intervalMs ?? 1000;
    this.now = options.now ?? Date.now;

    const startedAt = new Date(this.now()).toISOString();
    this.run = {
      run_id: options.runId ?? createRunId(this.now),
      project_id: this.projectId,
      entrypoint: this.entrypoint,
      started_at: startedAt,
      status: "completed",
      ...(options.segmentCount === undefined ? {} : { segment_count: options.segmentCount }),
      stages: [],
    };
    this.estimates = estimatePipelineStages(
      readPipelineTimings(this.projectDir),
      this.stages,
      { segmentCount: options.segmentCount },
    );
  }

  beginStage(stage: PipelineTimingStage): PipelineStageProgressHandle {
    if (this.closed) {
      return noopStageHandle();
    }
    if (this.active) {
      this.endActiveStage("completed");
    }

    const startedAtMs = this.now();
    const timing: PipelineStageTiming = {
      stage,
      status: "running",
      started_at: new Date(startedAtMs).toISOString(),
    };
    this.run.stages.push(timing);
    this.active = { stage, startedAtMs, timing };
    this.renderActiveStage("running");
    this.startTimer();

    let ended = false;
    return {
      complete: () => {
        if (ended) return;
        ended = true;
        this.endStage(stage, "completed");
      },
      fail: (error: unknown) => {
        if (ended) return;
        ended = true;
        this.endStage(stage, "failed", errorMessage(error));
        this.finish("failed");
      },
      skip: (reason?: string) => {
        if (ended) return;
        ended = true;
        this.endStage(stage, "skipped", reason);
      },
    };
  }

  async track<T>(stage: PipelineTimingStage, fn: () => T | Promise<T>): Promise<T> {
    const handle = this.beginStage(stage);
    try {
      const result = await fn();
      handle.complete();
      return result;
    } catch (error) {
      handle.fail(error);
      throw error;
    }
  }

  finish(status: PipelineTimingRunStatus = "completed"): void {
    if (this.closed) return;
    if (this.active) {
      this.endActiveStage(status === "completed" ? "completed" : "failed");
    }
    this.closed = true;
    this.stopTimer();
    this.run.status = status;
    this.run.completed_at = new Date(this.now()).toISOString();
    appendPipelineTimingRun(this.projectDir, this.run);
  }

  get latestStage(): PipelineTimingStage | null {
    return this.run.stages.at(-1)?.stage ?? null;
  }

  get timingsPath(): string {
    return pipelineTimingsPath(this.projectDir);
  }

  refreshEstimates(segmentCount?: number): void {
    this.estimates = estimatePipelineStages(
      readPipelineTimings(this.projectDir),
      this.stages,
      { segmentCount },
    );
    if (segmentCount !== undefined) {
      this.run.segment_count = segmentCount;
    }
  }

  private endStage(stage: PipelineTimingStage, status: PipelineTimingStageStatus, error?: string): void {
    if (!this.active || this.active.stage !== stage) return;
    this.endActiveStage(status, error);
  }

  private endActiveStage(status: PipelineTimingStageStatus, error?: string): void {
    if (!this.active) return;
    const endedAtMs = this.now();
    this.active.timing.status = status;
    this.active.timing.ended_at = new Date(endedAtMs).toISOString();
    this.active.timing.duration_ms = Math.max(0, endedAtMs - this.active.startedAtMs);
    if (error) this.active.timing.error = error;
    this.renderActiveStage(status);
    this.active = null;
    this.stopTimer();
  }

  private startTimer(): void {
    if (!this.enabled || !this.output.isTTY || this.intervalMs <= 0 || this.timer) return;
    this.timer = setInterval(() => this.renderActiveStage("running"), this.intervalMs);
  }

  private stopTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private renderActiveStage(status: PipelineTimingStageStatus): void {
    if (!this.enabled || !this.active) return;
    const line = formatPipelineProgress({
      stageIndex: stageDisplayIndex(this.stages, this.active.stage, this.run.stages.length),
      totalStages: Math.max(this.stages.length, this.run.stages.length),
      stage: this.active.stage,
      status,
      elapsedMs: this.active.timing.duration_ms ?? Math.max(0, this.now() - this.active.startedAtMs),
      ...this.estimateRemainder(this.active.stage, this.active.startedAtMs),
    });

    if (this.output.isTTY) {
      const padding = this.lastLineLength > line.length ? " ".repeat(this.lastLineLength - line.length) : "";
      this.output.write(`\r${line}${padding}`);
      if (status !== "running") this.output.write("\n");
      this.lastLineLength = line.length;
      return;
    }
    this.output.write(`${line}\n`);
  }

  private estimateRemainder(
    activeStage: PipelineTimingStage,
    activeStartedAtMs: number,
  ): Pick<FormatPipelineProgressInput, "estimatedRemainingMs" | "estimatedTotalMs"> {
    const activeIndex = stageDisplayIndex(this.stages, activeStage, this.run.stages.length) - 1;
    const elapsedMs = Math.max(0, this.now() - activeStartedAtMs);
    let totalMs = 0;
    let remainingMs = 0;
    let unknown = false;

    for (let index = 0; index < this.stages.length; index += 1) {
      const stage = this.stages[index];
      const finished = this.run.stages.find((item) => item.stage === stage && item.status !== "running");
      if (finished?.duration_ms !== undefined) {
        totalMs += finished.duration_ms;
        continue;
      }

      const estimate = this.estimates.get(stage)?.estimatedMs ?? null;
      if (stage === activeStage) {
        if (estimate === null) {
          unknown = true;
          totalMs += elapsedMs;
        } else {
          totalMs += Math.max(estimate, elapsedMs);
          remainingMs += Math.max(0, estimate - elapsedMs);
        }
        continue;
      }

      if (index > activeIndex) {
        if (estimate === null) {
          unknown = true;
        } else {
          totalMs += estimate;
          remainingMs += estimate;
        }
      } else if (estimate !== null) {
        totalMs += estimate;
      }
    }

    return {
      estimatedRemainingMs: unknown ? null : remainingMs,
      estimatedTotalMs: unknown ? null : totalMs,
    };
  }
}

export function pipelineTimingsPath(projectDir: string): string {
  return path.join(path.resolve(projectDir), "03_analysis", "pipeline-timings.json");
}

export function readPipelineTimings(projectDir: string): PipelineTimingsFile | null {
  const filePath = pipelineTimingsPath(projectDir);
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as PipelineTimingsFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.runs)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function appendPipelineTimingRun(projectDir: string, run: PipelineTimingRun): PipelineTimingsFile {
  const projectId = path.basename(path.resolve(projectDir));
  const existing = readPipelineTimings(projectDir);
  const doc: PipelineTimingsFile = existing ?? {
    version: 1,
    project_id: projectId,
    updated_at: new Date().toISOString(),
    runs: [],
  };
  doc.project_id = doc.project_id || projectId;
  doc.updated_at = new Date().toISOString();
  doc.runs.push(cloneTimingRun(run));

  const filePath = pipelineTimingsPath(projectDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, "utf-8");
  fs.renameSync(tmp, filePath);
  return doc;
}

export function estimatePipelineStages(
  timings: PipelineTimingsFile | null,
  stages: PipelineTimingStage[],
  options: { segmentCount?: number } = {},
): Map<PipelineTimingStage, StageEstimate> {
  const history = new Map<PipelineTimingStage, number[]>();
  for (const run of timings?.runs ?? []) {
    for (const stage of run.stages) {
      if (stage.status !== "completed" || stage.duration_ms === undefined) continue;
      if (!history.has(stage.stage)) history.set(stage.stage, []);
      history.get(stage.stage)!.push(stage.duration_ms);
    }
  }

  const estimates = new Map<PipelineTimingStage, StageEstimate>();
  for (const stage of stages) {
    const samples = history.get(stage) ?? [];
    if (samples.length > 0) {
      estimates.set(stage, {
        estimatedMs: Math.round(samples.reduce((sum, value) => sum + value, 0) / samples.length),
        source: "history",
      });
      continue;
    }
    if (options.segmentCount !== undefined) {
      const fallback = FALLBACK_STAGE_ESTIMATE[stage];
      estimates.set(stage, {
        estimatedMs: fallback.baseMs + fallback.perSegmentMs * Math.max(0, options.segmentCount),
        source: "segments",
      });
      continue;
    }
    estimates.set(stage, { estimatedMs: null, source: "unknown" });
  }
  return estimates;
}

export function formatPipelineProgress(input: FormatPipelineProgressInput): string {
  const statusText = input.status === "running"
    ? "実行中..."
    : input.status === "completed"
      ? "完了"
      : input.status === "skipped"
        ? "スキップ"
        : "失敗";
  const remaining = input.estimatedRemainingMs === null
    ? "計測中"
    : `~${formatApproxDuration(input.estimatedRemainingMs)}`;
  const total = input.estimatedTotalMs === null
    ? "計測中"
    : `~${formatApproxDuration(input.estimatedTotalMs)}`;
  return `[${input.stageIndex}/${input.totalStages}] ${input.stage} ${statusText} ` +
    `経過 ${formatDurationCompact(input.elapsedMs)} / 推定残り ${remaining} (全体 ${total})`;
}

export function formatStageFailureMessage(
  entrypoint: string,
  projectDir: string,
  stage: PipelineTimingStage | string,
  error: unknown,
): string {
  const message = errorMessage(error);
  const retry = suggestStageRetryCommand(entrypoint, projectDir, stage);
  return `${message}\nFailed stage: ${stage}\nNext try: ${retry}\nGuided recovery: use the troubleshoot-error skill with this error and the project path.`;
}

export function suggestStageRetryCommand(
  entrypoint: string,
  projectDir: string,
  stage: PipelineTimingStage | string,
): string {
  const project = path.relative(process.cwd(), path.resolve(projectDir)) || projectDir;
  if (entrypoint === "full-pipeline") {
    return `npm run full-pipeline -- --project ${project} --from ${stage}`;
  }
  if (stage === "compile") {
    return `npx tsx scripts/compile-timeline.ts ${project} --skip-preview --skip-confirmations true`;
  }
  if (stage === "render") {
    return `npx tsx scripts/render-rough-cut.ts --project ${project}`;
  }
  if (stage === "embeddings") {
    return `npx tsx scripts/build-footage-db.ts --project ${project} --embedding-policy auto --qwen3vl --clap-audio`;
  }
  if (stage === "ingest" || stage === "stt" || stage === "marlin" || stage === "peak" || stage === "visual-quality") {
    return `npx tsx scripts/analyze.ts ${project}/02_media/source/* --project ${project}`;
  }
  return `npx tsx scripts/editorial-pipeline.ts --project ${project} --qa`;
}

export function readSegmentCount(projectDir: string): number | undefined {
  const filePath = path.join(path.resolve(projectDir), "03_analysis", "segments.json");
  if (!fs.existsSync(filePath)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as { items?: unknown[] };
    return Array.isArray(parsed.items) ? parsed.items.length : undefined;
  } catch {
    return undefined;
  }
}

function cloneTimingRun(run: PipelineTimingRun): PipelineTimingRun {
  return {
    ...run,
    stages: run.stages.map((stage) => ({ ...stage })),
  };
}

function noopStageHandle(): PipelineStageProgressHandle {
  return {
    complete() {},
    fail() {},
    skip() {},
  };
}

function stageDisplayIndex(
  stages: PipelineTimingStage[],
  activeStage: PipelineTimingStage,
  fallbackIndex: number,
): number {
  const index = stages.indexOf(activeStage);
  return index >= 0 ? index + 1 : fallbackIndex;
}

function formatDurationCompact(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

function formatApproxDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 90) return `${totalSeconds}s`;
  const minutes = Math.max(1, Math.round(totalSeconds / 60));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h${rest}m`;
}

function createRunId(now: () => number): string {
  return `run_${new Date(now()).toISOString().replace(/[-:.]/g, "").replace("T", "_").replace("Z", "")}_${process.pid}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── Static helpers for reading progress ────────────────────────────

/**
 * Read progress.json from a project directory. Returns null if not found.
 */
export function readProgress(projectDir: string): ProgressReport | null {
  const p = path.join(path.resolve(projectDir), "progress.json");
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf-8")) as ProgressReport;
}
