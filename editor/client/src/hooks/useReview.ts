import { useEffect, useState } from 'react';
import type {
  PatchApplyRequest,
  PatchApplyResponse,
  ReviewPatchResponse,
  ReviewReportResponse,
} from '../types';

export interface BlueprintBeat {
  beat_id: string;
  beat_label?: string;
  purpose?: string;
  duration_target_sec?: number;
}

export interface BlueprintResponse {
  exists: boolean;
  revision?: string;
  data: { beats?: BlueprintBeat[] } | null;
}

export interface AiContextResponse {
  project_id: string;
  timeline_revision: string | null;
  timeline_version: string | null;
  artifacts: {
    blueprint: BlueprintResponse;
    review_report: ReviewReportResponse;
    review_patch: ReviewPatchResponse;
  };
  status?: {
    currentState: string;
    staleArtifacts: string[];
    gates: Record<string, string>;
  };
}

export function useReview(projectId: string) {
  const [report, setReport] = useState<ReviewReportResponse | null>(null);
  const [patch, setPatch] = useState<ReviewPatchResponse | null>(null);
  const [blueprint, setBlueprint] = useState<BlueprintResponse | null>(null);
  const [projectStatus, setProjectStatus] = useState<AiContextResponse['status'] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) {
      setReport(null);
      setPatch(null);
      setBlueprint(null);
      setProjectStatus(null);
      return;
    }

    void fetchAll(projectId);
  }, [projectId]);

  async function fetchAll(id: string): Promise<void> {
    setLoading(true);
    setError(null);

    try {
      // Fetch combined context endpoint (includes blueprint, report, patch, status)
      const contextRes = await fetch(`/api/projects/${id}/ai/context`);

      if (contextRes.ok) {
        const ctx = (await contextRes.json()) as AiContextResponse;

        // Use context data for report and patch
        setReport(ctx.artifacts.review_report ?? { exists: false, data: null });
        setPatch(ctx.artifacts.review_patch ?? { exists: false, data: null });
        setBlueprint(ctx.artifacts.blueprint ?? { exists: false, data: null });
        if (ctx.status) setProjectStatus(ctx.status);
      } else {
        // Fallback: fetch individually
        const [reportRes, patchRes, blueprintRes] = await Promise.all([
          fetch(`/api/projects/${id}/ai/review-report`),
          fetch(`/api/projects/${id}/ai/review-patch`),
          fetch(`/api/projects/${id}/ai/blueprint`),
        ]);

        setReport(
          reportRes.ok
            ? ((await reportRes.json()) as ReviewReportResponse)
            : { exists: false, data: null },
        );
        setPatch(
          patchRes.ok
            ? ((await patchRes.json()) as ReviewPatchResponse)
            : { exists: false, data: null },
        );
        setBlueprint(
          blueprintRes.ok
            ? ((await blueprintRes.json()) as BlueprintResponse)
            : { exists: false, data: null },
        );
      }
    } catch {
      setError('Failed to fetch review data');
      setReport({ exists: false, data: null });
      setPatch({ exists: false, data: null });
      setBlueprint({ exists: false, data: null });
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

  return { report, patch, blueprint, projectStatus, loading, error, applyPatch, reload };
}
