import { useEffect, useState } from 'react';
import type {
  PatchApplyRequest,
  PatchApplyResponse,
  ReviewPatchResponse,
  ReviewReportResponse,
} from '../types';

export function useReview(projectId: string) {
  const [report, setReport] = useState<ReviewReportResponse | null>(null);
  const [patch, setPatch] = useState<ReviewPatchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) {
      setReport(null);
      setPatch(null);
      return;
    }

    void fetchAll(projectId);
  }, [projectId]);

  async function fetchAll(id: string): Promise<void> {
    setLoading(true);
    setError(null);

    try {
      const [reportRes, patchRes] = await Promise.all([
        fetch(`/api/projects/${id}/ai/review-report`),
        fetch(`/api/projects/${id}/ai/review-patch`),
      ]);

      if (reportRes.ok) {
        setReport((await reportRes.json()) as ReviewReportResponse);
      } else {
        setReport({ exists: false, data: null });
      }

      if (patchRes.ok) {
        setPatch((await patchRes.json()) as ReviewPatchResponse);
      } else {
        setPatch({ exists: false, data: null });
      }
    } catch {
      setError('Failed to fetch review data');
      setReport({ exists: false, data: null });
      setPatch({ exists: false, data: null });
    } finally {
      setLoading(false);
    }
  }

  async function applyPatch(
    request: PatchApplyRequest,
  ): Promise<PatchApplyResponse | null> {
    try {
      const res = await fetch(`/api/projects/${projectId}/ai/patches/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });

      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        setError(body.error ?? `Patch apply failed (${res.status})`);
        return null;
      }

      const result = (await res.json()) as PatchApplyResponse;
      return result;
    } catch {
      setError('Failed to apply patch');
      return null;
    }
  }

  function reload(): void {
    if (projectId) {
      void fetchAll(projectId);
    }
  }

  return { report, patch, loading, error, applyPatch, reload };
}
