import { useCallback, useEffect, useRef, useState } from 'react';

// ── Types ───────────────────────────────────────────────────────

export type AiJobPhase = 'compile' | 'review' | 'render';
export type AiJobStatus = 'idle' | 'queued' | 'running' | 'succeeded' | 'failed';

export interface AiJobProgress {
  phase: string | null;
  status: string;
  completed: number;
  total: number;
  eta_sec: number | null;
  errors: Array<{ stage: string; message: string }>;
}

export interface AiJobInfo {
  job_id: string;
  phase: AiJobPhase;
  status: string;
  started_at: string;
  finished_at: string | null;
  error: string | null;
  timeline_revision_after: string | null;
  artifacts_updated: string[];
}

interface StartJobResponse {
  job_id: string;
  phase: string;
  status: string;
  progress_url: string;
  job_url: string;
}

// ── Hook ────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 2000;

export function useAiJob(
  projectId: string | null,
  callbacks?: {
    onCompileComplete?: () => void;
    onReviewComplete?: () => void;
    onRenderComplete?: () => void;
    onError?: (phase: AiJobPhase, error: string) => void;
  },
) {
  const [status, setStatus] = useState<AiJobStatus>('idle');
  const [phase, setPhase] = useState<AiJobPhase | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState<AiJobProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  // Stop polling
  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  // Clean up on unmount or project change
  useEffect(() => {
    return () => stopPolling();
  }, [projectId, stopPolling]);

  // Poll progress
  const pollProgress = useCallback(async (
    targetProjectId: string,
    targetJobId: string,
    targetPhase: AiJobPhase,
  ) => {
    try {
      // Poll progress.json for live progress
      const progressResp = await fetch(`/api/projects/${targetProjectId}/ai/progress`);
      if (progressResp.ok) {
        const progressData = await progressResp.json() as AiJobProgress;
        setProgress(progressData);
      }

      // Poll job status for terminal state detection
      const jobResp = await fetch(`/api/projects/${targetProjectId}/ai/jobs/${targetJobId}`);
      if (!jobResp.ok) return;

      const job = await jobResp.json() as AiJobInfo;

      if (job.status === 'succeeded') {
        stopPolling();
        setStatus('succeeded');
        setProgress((prev) => prev ? { ...prev, status: 'completed' } : prev);

        // Fire completion callback
        switch (targetPhase) {
          case 'compile':
            callbacksRef.current?.onCompileComplete?.();
            break;
          case 'review':
            callbacksRef.current?.onReviewComplete?.();
            break;
          case 'render':
            callbacksRef.current?.onRenderComplete?.();
            break;
        }
      } else if (job.status === 'failed' || job.status === 'blocked') {
        stopPolling();
        setStatus('failed');
        const errMsg = job.error ?? `Job ${job.status}`;
        setError(errMsg);
        callbacksRef.current?.onError?.(targetPhase, errMsg);
      }
    } catch {
      // Network errors during polling are non-fatal; retry next interval
    }
  }, [stopPolling]);

  // Restore in-progress job on mount / project change
  useEffect(() => {
    if (!projectId) return;

    let cancelled = false;
    const pid = projectId;

    async function restoreActiveJob(): Promise<void> {
      try {
        const resp = await fetch(`/api/projects/${pid}/ai/jobs/current`);
        if (!resp.ok || cancelled) return;

        const data = await resp.json() as { active: boolean; job: AiJobInfo | null };
        if (cancelled) return;

        // Project changed and no active job → reset to initial state
        if (!data.active || !data.job) {
          setStatus('idle');
          setPhase(null);
          setJobId(null);
          setProgress(null);
          setError(null);
          return;
        }

        const job = data.job;
        const jobPhase = job.phase as AiJobPhase;

        if (job.status !== 'queued' && job.status !== 'running') return;

        setJobId(job.job_id);
        setPhase(jobPhase);
        setStatus(job.status === 'queued' ? 'queued' : 'running');
        setError(null);

        // Start polling for the restored job
        stopPolling();
        pollTimerRef.current = setInterval(() => {
          void pollProgress(pid, job.job_id, jobPhase);
        }, POLL_INTERVAL_MS);

        void pollProgress(pid, job.job_id, jobPhase);
      } catch {
        // Non-fatal — stay idle
      }
    }

    void restoreActiveJob();

    return () => {
      cancelled = true;
    };
  }, [projectId, stopPolling, pollProgress]);

  // Start a new AI job
  const startJob = useCallback(async (
    jobPhase: AiJobPhase,
    baseRevision?: string | null,
    options?: Record<string, unknown>,
  ): Promise<boolean> => {
    if (!projectId) return false;

    // Reset state
    setError(null);
    setProgress(null);
    setPhase(jobPhase);
    setStatus('queued');

    try {
      const body: Record<string, unknown> = {
        phase: jobPhase,
        options: options ?? {},
      };
      if (baseRevision) {
        body.base_timeline_revision = baseRevision;
      }

      const resp = await fetch(`/api/projects/${projectId}/ai/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (resp.status === 409) {
        setStatus('failed');
        setError('Timeline was modified externally. Reload to get the latest version.');
        return false;
      }

      if (resp.status === 423) {
        const data = await resp.json().catch(() => ({})) as { lock_kind?: string; message?: string };
        setStatus('failed');
        setError(data.message ?? `Project is locked (${data.lock_kind ?? 'unknown'})`);
        return false;
      }

      if (resp.status === 422) {
        const data = await resp.json().catch(() => ({})) as { error?: string };
        setStatus('failed');
        setError(data.error ?? 'Invalid request');
        return false;
      }

      if (!resp.ok) {
        const data = await resp.json().catch(() => ({})) as { error?: string };
        setStatus('failed');
        setError(data.error ?? `Failed to start job (${resp.status})`);
        return false;
      }

      const result = await resp.json() as StartJobResponse;
      setJobId(result.job_id);
      setStatus('running');

      // Start polling
      stopPolling();
      const capturedProjectId = projectId;
      const capturedJobId = result.job_id;
      pollTimerRef.current = setInterval(() => {
        void pollProgress(capturedProjectId, capturedJobId, jobPhase);
      }, POLL_INTERVAL_MS);

      // Immediately poll once
      void pollProgress(capturedProjectId, capturedJobId, jobPhase);

      return true;
    } catch (err) {
      setStatus('failed');
      setError(err instanceof Error ? err.message : 'Failed to start job');
      return false;
    }
  }, [projectId, stopPolling, pollProgress]);

  // Reset to idle
  const reset = useCallback(() => {
    stopPolling();
    setStatus('idle');
    setPhase(null);
    setJobId(null);
    setProgress(null);
    setError(null);
  }, [stopPolling]);

  const isRunning = status === 'queued' || status === 'running';

  return {
    status,
    phase,
    jobId,
    progress,
    error,
    isRunning,
    startJob,
    reset,
  };
}
