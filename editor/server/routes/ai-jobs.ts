/**
 * AI Jobs API routes (Phase 2b-3).
 *
 * POST /api/projects/:id/ai/jobs       — Start an AI job (compile/review/render)
 * GET  /api/projects/:id/ai/jobs/current — Current running job for the project
 * GET  /api/projects/:id/ai/jobs/:jobId — Specific job details
 * GET  /api/projects/:id/ai/progress    — Read progress.json (polling endpoint)
 */

import { Router } from "express";
import { spawn, type ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { computeTimelineRevision } from "./timeline.js";
import {
  safeProjectDir,
  acquireProjectLock,
  releaseProjectLock,
  getProjectLockKind,
} from "../utils.js";
import { getReconcileStatus, type ReconcileStatus } from "../services/reconcile-status.js";

// ── Types ────────────────────────────────────────────────────────

type JobPhase = "compile" | "review" | "render";
type JobStatus = "queued" | "running" | "succeeded" | "failed" | "blocked" | "obsolete";

interface AiJob {
  job_id: string;
  phase: JobPhase;
  status: JobStatus;
  started_at: string;
  finished_at: string | null;
  base_timeline_revision: string;
  timeline_revision_after: string | null;
  artifacts_updated: string[];
  error: string | null;
  child: ChildProcess | null;
}

// ── In-memory job store ─────────────────────────────────────────

/** Map<projectId, AiJob> — only one job per project at a time. */
const activeJobs = new Map<string, AiJob>();

/** Map<projectId, AiJob[]> — completed job history (keep last 10). */
const jobHistory = new Map<string, AiJob[]>();

function generateJobId(): string {
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const rand = crypto.randomBytes(3).toString("hex");
  return `job_${ts}_${rand}`;
}

function addToHistory(projectId: string, job: AiJob): void {
  const list = jobHistory.get(projectId) ?? [];
  list.push(job);
  if (list.length > 10) list.shift();
  jobHistory.set(projectId, list);
}

function serializeJob(job: AiJob): Record<string, unknown> {
  return {
    job_id: job.job_id,
    phase: job.phase,
    status: job.status,
    started_at: job.started_at,
    finished_at: job.finished_at,
    base_timeline_revision: job.base_timeline_revision,
    timeline_revision_after: job.timeline_revision_after,
    artifacts_updated: job.artifacts_updated,
    error: job.error,
  };
}

// ── Worker script path ──────────────────────────────────────────

const WORKER_SCRIPT = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "scripts",
  "editor-job-worker.ts",
);

// ── Lock kind mapping ───────────────────────────────────────────

function lockKindForPhase(phase: JobPhase): string {
  return `job:${phase}`;
}

// ── Spawn worker process ────────────────────────────────────────

function spawnJobWorker(
  projectId: string,
  projectDir: string,
  job: AiJob,
  options: Record<string, unknown>,
): void {
  job.status = "running";

  // Find tsx binary — try local node_modules first, then npx
  const projectRoot = path.resolve(import.meta.dirname, "..", "..", "..");
  const localTsx = path.join(projectRoot, "node_modules", ".bin", "tsx");
  const tsxBin = fs.existsSync(localTsx) ? localTsx : "npx";
  const args = tsxBin === "npx"
    ? ["tsx", WORKER_SCRIPT, projectDir, job.phase, JSON.stringify(options)]
    : [WORKER_SCRIPT, projectDir, job.phase, JSON.stringify(options)];

  const child = spawn(tsxBin, args, {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  job.child = child;

  let stdout = "";
  let stderr = "";

  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  child.on("close", (code) => {
    job.child = null;
    job.finished_at = new Date().toISOString();

    // Parse result from stdout
    let result: Record<string, unknown> = {};
    const resultMatch = stdout.match(/__RESULT__(.+?)__END__/);
    if (resultMatch) {
      try {
        result = JSON.parse(resultMatch[1]);
      } catch { /* ignore parse errors */ }
    }

    if (code === 0 && result.success) {
      job.status = "succeeded";
      job.artifacts_updated = (result.artifacts as string[]) ?? [];

      // Read new timeline revision if compile phase
      if (job.phase === "compile") {
        const timelinePath = path.join(projectDir, "05_timeline", "timeline.json");
        if (fs.existsSync(timelinePath)) {
          const content = fs.readFileSync(timelinePath, "utf-8");
          job.timeline_revision_after = computeTimelineRevision(content);
        }
      } else {
        job.timeline_revision_after = job.base_timeline_revision;
      }
    } else {
      job.status = "failed";
      job.error = (result.error as string)
        ?? (stderr.trim().slice(0, 500) || `Worker exited with code ${code}`);
    }

    // Release project lock
    releaseProjectLock(projectId, projectDir);

    // Move to history
    activeJobs.delete(projectId);
    addToHistory(projectId, job);
  });

  child.on("error", (err) => {
    job.child = null;
    job.status = "failed";
    job.finished_at = new Date().toISOString();
    job.error = `Worker spawn error: ${err.message}`;
    releaseProjectLock(projectId, projectDir);
    activeJobs.delete(projectId);
    addToHistory(projectId, job);
  });
}

// ── Router ───────────────────────────────────────────────────────

export function createAiJobsRouter(projectsDir: string): Router {
  const router = Router();

  // POST /api/projects/:id/ai/jobs — Start AI job
  router.post("/:id/ai/jobs", (req, res) => {
    const projectId = req.params.id;
    const projDir = safeProjectDir(projectsDir, projectId);
    if (!projDir) {
      res.status(400).json({ error: "Invalid project ID" });
      return;
    }

    const { phase, base_timeline_revision, options } = req.body as {
      phase?: string;
      base_timeline_revision?: string;
      options?: Record<string, unknown>;
    };

    // Validate phase
    const validPhases: JobPhase[] = ["compile", "review", "render"];
    if (!phase || !validPhases.includes(phase as JobPhase)) {
      res.status(422).json({
        error: "Invalid phase",
        valid_phases: validPhases,
      });
      return;
    }

    const jobPhase = phase as JobPhase;

    // Check timeline revision if provided
    const timelinePath = path.join(projDir, "05_timeline", "timeline.json");
    let currentRevision: string | null = null;

    if (fs.existsSync(timelinePath)) {
      const content = fs.readFileSync(timelinePath, "utf-8");
      currentRevision = computeTimelineRevision(content);
    }

    if (base_timeline_revision && currentRevision && base_timeline_revision !== currentRevision) {
      res.status(409).json({
        error: "Timeline revision mismatch",
        current_revision: currentRevision,
        client_revision: base_timeline_revision,
      });
      return;
    }

    // Check for existing lock (another job, save, or patch in progress)
    const existingLock = getProjectLockKind(projectId, projDir);
    if (existingLock) {
      res.status(423).json({
        error: "Project is locked",
        lock_kind: existingLock,
        message: `Another operation (${existingLock}) is in progress`,
      });
      return;
    }

    // Check for already-running job
    if (activeJobs.has(projectId)) {
      const existing = activeJobs.get(projectId)!;
      res.status(423).json({
        error: "A job is already running for this project",
        current_job: serializeJob(existing),
      });
      return;
    }

    // Review phase: requires adapter or explicit dev stub flag
    if (jobPhase === "review" && process.env.EDITOR_STUB_REVIEW !== "1") {
      res.status(503).json({
        error: "Review agent adapter is not configured",
        hint: "Set EDITOR_STUB_REVIEW=1 for development stub, or configure a production review agent.",
      });
      return;
    }

    // Render phase: only allowed if state is approved or packaged
    if (jobPhase === "render") {
      try {
        const status = getReconcileStatus(projDir);
        const state = status.currentState;
        if (state !== "approved" && state !== "packaged") {
          res.status(422).json({
            error: "Render is only allowed when project state is 'approved' or 'packaged'",
            current_state: state,
          });
          return;
        }
      } catch {
        // Non-fatal — allow render attempt
      }
    }

    // Acquire project lock
    const lockKind = lockKindForPhase(jobPhase);
    if (!acquireProjectLock(projectId, lockKind, projDir)) {
      res.status(423).json({ error: "Failed to acquire project lock" });
      return;
    }

    // Create job
    const job: AiJob = {
      job_id: generateJobId(),
      phase: jobPhase,
      status: "queued",
      started_at: new Date().toISOString(),
      finished_at: null,
      base_timeline_revision: currentRevision ?? "",
      timeline_revision_after: null,
      artifacts_updated: [],
      error: null,
      child: null,
    };

    activeJobs.set(projectId, job);

    // Spawn worker process
    spawnJobWorker(projectId, projDir, job, options ?? {});

    // Respond immediately with job info
    res.status(202).json({
      job_id: job.job_id,
      phase: job.phase,
      status: job.status,
      base_timeline_revision: job.base_timeline_revision,
      progress_url: `/api/projects/${projectId}/ai/progress`,
      job_url: `/api/projects/${projectId}/ai/jobs/${job.job_id}`,
    });
  });

  // GET /api/projects/:id/ai/jobs/current — Current running job
  router.get("/:id/ai/jobs/current", (req, res) => {
    const projectId = req.params.id;
    const projDir = safeProjectDir(projectsDir, projectId);
    if (!projDir) {
      res.status(400).json({ error: "Invalid project ID" });
      return;
    }

    const job = activeJobs.get(projectId);
    if (!job) {
      // Only return active jobs — do not surface history
      res.json({ active: false, job: null });
      return;
    }

    res.json({ active: true, job: serializeJob(job) });
  });

  // GET /api/projects/:id/ai/jobs/:jobId — Specific job details
  router.get("/:id/ai/jobs/:jobId", (req, res) => {
    const projectId = req.params.id;
    const projDir = safeProjectDir(projectsDir, projectId);
    if (!projDir) {
      res.status(400).json({ error: "Invalid project ID" });
      return;
    }

    const jobId = req.params.jobId;

    // Check active job
    const active = activeJobs.get(projectId);
    if (active && active.job_id === jobId) {
      // Build reconcile status summary
      let statusSummary: ReconcileStatus | undefined;
      try {
        statusSummary = getReconcileStatus(projDir);
      } catch { /* ignore */ }

      res.json({
        ...serializeJob(active),
        ...(statusSummary ? { status_summary: statusSummary } : {}),
      });
      return;
    }

    // Check history
    const history = jobHistory.get(projectId) ?? [];
    const found = history.find((j) => j.job_id === jobId);
    if (found) {
      let statusSummary: ReconcileStatus | undefined;
      try {
        statusSummary = getReconcileStatus(projDir);
      } catch { /* ignore */ }

      res.json({
        ...serializeJob(found),
        ...(statusSummary ? { status_summary: statusSummary } : {}),
      });
      return;
    }

    res.status(404).json({ error: "Job not found", job_id: jobId });
  });

  // GET /api/projects/:id/ai/progress — Read progress.json
  router.get("/:id/ai/progress", (req, res) => {
    const projDir = safeProjectDir(projectsDir, req.params.id);
    if (!projDir) {
      res.status(400).json({ error: "Invalid project ID" });
      return;
    }

    const progressPath = path.join(projDir, "progress.json");

    if (!fs.existsSync(progressPath)) {
      res.json({
        project_id: req.params.id,
        phase: null,
        status: "idle",
        completed: 0,
        total: 0,
        eta_sec: null,
        artifacts_created: [],
        errors: [],
      });
      return;
    }

    try {
      const content = fs.readFileSync(progressPath, "utf-8");
      const progress = JSON.parse(content);
      res.json(progress);
    } catch (err) {
      res.status(500).json({
        error: "Failed to read progress",
        details: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return router;
}
