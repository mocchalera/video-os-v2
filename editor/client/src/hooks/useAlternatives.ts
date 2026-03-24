import { useEffect, useState } from 'react';

export interface AlternativeCandidate {
  segment_id: string;
  asset_id: string;
  src_in_us: number;
  src_out_us: number;
  role: string;
  why_it_matches?: string;
  risks?: string[];
  confidence: number;
  semantic_rank?: number;
  quality_flags?: string[];
  eligible_beats?: string[];
  trim_hint?: { source_center_us: number; preferred_duration_us: number };
  rank_reason: string;
  rank_priority: number;
  thumbnail_url: string;
}

export interface AlternativesResponse {
  clip_id: string;
  current_segment_id: string;
  alternatives: AlternativeCandidate[];
}

export function useAlternatives(projectId: string, clipId: string | null) {
  const [alternatives, setAlternatives] = useState<AlternativeCandidate[]>([]);
  const [currentSegmentId, setCurrentSegmentId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId || !clipId) {
      setAlternatives([]);
      setCurrentSegmentId(null);
      return;
    }

    void fetchAlternatives(projectId, clipId);
  }, [projectId, clipId]);

  async function fetchAlternatives(pid: string, cid: string): Promise<void> {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`/api/projects/${pid}/ai/alternatives/${cid}`);
      if (!res.ok) {
        setAlternatives([]);
        setCurrentSegmentId(null);
        return;
      }

      const data = (await res.json()) as AlternativesResponse;
      setAlternatives(data.alternatives);
      setCurrentSegmentId(data.current_segment_id);
    } catch {
      setError('Failed to fetch alternatives');
      setAlternatives([]);
    } finally {
      setLoading(false);
    }
  }

  return { alternatives, currentSegmentId, loading, error };
}
