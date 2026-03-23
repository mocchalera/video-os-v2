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

// ── Static helpers for reading progress ────────────────────────────

/**
 * Read progress.json from a project directory. Returns null if not found.
 */
export function readProgress(projectDir: string): ProgressReport | null {
  const p = path.join(path.resolve(projectDir), "progress.json");
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf-8")) as ProgressReport;
}
