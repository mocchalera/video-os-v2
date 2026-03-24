import { useEffect, useState } from 'react';
import type { SelectsResponse } from '../types';

export function useSelects(projectId: string) {
  const [selects, setSelects] = useState<SelectsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) {
      setSelects(null);
      return;
    }

    void fetchSelects(projectId);
  }, [projectId]);

  async function fetchSelects(id: string): Promise<void> {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`/api/projects/${id}/selects`);
      if (res.ok) {
        setSelects((await res.json()) as SelectsResponse);
      } else {
        setSelects({ exists: false, data: null });
      }
    } catch {
      setError('Failed to fetch selects');
      setSelects({ exists: false, data: null });
    } finally {
      setLoading(false);
    }
  }

  function reload(): void {
    if (projectId) {
      void fetchSelects(projectId);
    }
  }

  return { selects, loading, error, reload };
}
