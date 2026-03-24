import { useEffect, useState } from 'react';
import { mockProjects, resolveMockTimeline } from '../mocks/mockData';
import type {
  Clip,
  HistoryOrigin,
  ProjectSummary,
  TimelineIR,
  TimelineSaveResult,
  TimelineValidationIssue,
  Track,
} from '../types';
import { durationFramesFromSource, getFps } from '../utils/time';

const HISTORY_LIMIT = 50;
const SELECTED_PROJECT_KEY = 'video-os-editor.selected-project';
const TIMELINE_STORAGE_PREFIX = 'video-os-editor.timeline.';

type TimelineStatus = 'idle' | 'loading' | 'ready' | 'saving' | 'error';

interface HistoryEntry {
  timeline: TimelineIR;
  origin: HistoryOrigin;
}

interface TimelineHistory {
  past: HistoryEntry[];
  present: TimelineIR | null;
  future: HistoryEntry[];
}

function readStoredProjectId(): string {
  if (typeof window === 'undefined') {
    return '';
  }

  return window.localStorage.getItem(SELECTED_PROJECT_KEY) ?? '';
}

function readStoredTimeline(projectId: string): TimelineIR | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const raw = window.localStorage.getItem(`${TIMELINE_STORAGE_PREFIX}${projectId}`);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as TimelineIR;
  } catch {
    return null;
  }
}

function writeStoredTimeline(projectId: string, timeline: TimelineIR): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(
    `${TIMELINE_STORAGE_PREFIX}${projectId}`,
    JSON.stringify(timeline),
  );
}

function normalizeTimeline(timeline: TimelineIR): TimelineIR {
  const next = structuredClone(timeline);
  const fps = getFps(next.sequence);

  for (const group of [next.tracks.video, next.tracks.audio]) {
    group.forEach((track) => {
      track.clips = [...track.clips]
        .map((clip) => ({
          ...clip,
          timeline_duration_frames: durationFramesFromSource(
            clip.src_in_us,
            clip.src_out_us,
            fps,
          ),
        }))
        .sort((left, right) => {
          if (left.timeline_in_frame !== right.timeline_in_frame) {
            return left.timeline_in_frame - right.timeline_in_frame;
          }

          return left.clip_id.localeCompare(right.clip_id);
        });
    });
  }

  return next;
}

function validateTimeline(timeline: TimelineIR): TimelineValidationIssue[] {
  const issues: TimelineValidationIssue[] = [];
  const fps = getFps(timeline.sequence);

  function checkTrack(trackType: 'video' | 'audio', track: Track): void {
    let lastEndFrame = -1;
    [...track.clips]
      .sort((left, right) => left.timeline_in_frame - right.timeline_in_frame)
      .forEach((clip, index) => {
        const basePath = `${trackType}.${track.track_id}.clips[${index}]`;

        if (!clip.clip_id || !clip.segment_id || !clip.asset_id || !clip.motivation) {
          issues.push({
            path: basePath,
            message: 'clip_id, segment_id, asset_id, motivation are required.',
          });
        }

        if (clip.src_in_us >= clip.src_out_us) {
          issues.push({
            path: `${basePath}.src_in_us`,
            message: 'src_in_us must be less than src_out_us.',
          });
        }

        if (clip.timeline_duration_frames < 1) {
          issues.push({
            path: `${basePath}.timeline_duration_frames`,
            message: 'timeline_duration_frames must be at least 1.',
          });
        }

        const expectedDuration = durationFramesFromSource(
          clip.src_in_us,
          clip.src_out_us,
          fps,
        );
        if (Math.abs(expectedDuration - clip.timeline_duration_frames) > 1) {
          issues.push({
            path: `${basePath}.timeline_duration_frames`,
            message:
              'timeline_duration_frames must match src_in_us/src_out_us within +/-1 frame.',
          });
        }

        if (clip.timeline_in_frame < lastEndFrame) {
          issues.push({
            path: `${basePath}.timeline_in_frame`,
            message: `Track ${track.track_id} has overlapping clips.`,
          });
        }

        lastEndFrame = Math.max(
          lastEndFrame,
          clip.timeline_in_frame + clip.timeline_duration_frames,
        );
      });
  }

  timeline.tracks.video.forEach((track) => checkTrack('video', track));
  timeline.tracks.audio.forEach((track) => checkTrack('audio', track));

  return issues;
}

export function useTimeline() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectId, setProjectIdState] = useState<string>('');
  const [history, setHistory] = useState<TimelineHistory>({
    past: [],
    present: null,
    future: [],
  });
  const [status, setStatus] = useState<TimelineStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [connectionMode, setConnectionMode] = useState<'api' | 'mock'>('api');
  const [dirty, setDirty] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [timelineRevision, setTimelineRevision] = useState<string | null>(null);

  const timeline = history.present;

  useEffect(() => {
    void loadProjects();
  }, []);

  useEffect(() => {
    if (!projectId) {
      return;
    }

    void loadTimeline(projectId);
  }, [projectId]);

  async function loadProjects(): Promise<void> {
    setStatus('loading');
    setError(null);

    const storedProjectId = readStoredProjectId();

    try {
      const response = await fetch('/api/projects');
      if (!response.ok) {
        throw new Error(`Failed to fetch projects (${response.status})`);
      }

      const payload = (await response.json()) as { projects?: ProjectSummary[] };
      const nextProjects =
        Array.isArray(payload.projects) && payload.projects.length > 0
          ? payload.projects
          : mockProjects;

      setProjects(nextProjects);
      setConnectionMode('api');

      const validStoredId =
        storedProjectId && nextProjects.some((p) => p.id === storedProjectId)
          ? storedProjectId
          : '';
      const defaultId =
        nextProjects.find((p) => p.id === 'demo')?.id ?? nextProjects[0]?.id ?? '';
      setProjectIdState((current) => current || validStoredId || defaultId);
    } catch {
      setProjects(mockProjects);
      setConnectionMode('mock');

      const validStoredId =
        storedProjectId && mockProjects.some((p) => p.id === storedProjectId)
          ? storedProjectId
          : '';
      const defaultId =
        mockProjects.find((p) => p.id === 'demo')?.id ?? mockProjects[0]?.id ?? '';
      setProjectIdState((current) => current || validStoredId || defaultId);
    }
  }

  async function loadTimeline(nextProjectId: string): Promise<void> {
    setStatus('loading');
    setError(null);

    try {
      let nextTimeline: TimelineIR | null = null;

      try {
        const response = await fetch(`/api/projects/${nextProjectId}/timeline`);
        if (!response.ok) {
          throw new Error(`Failed to fetch timeline (${response.status})`);
        }

        nextTimeline = (await response.json()) as TimelineIR;
        setConnectionMode('api');

        // Capture timeline_revision from ETag header
        const etag = response.headers.get('ETag');
        if (etag) {
          setTimelineRevision(etag.replace(/^"|"$/g, ''));
        }
      } catch {
        nextTimeline =
          readStoredTimeline(nextProjectId) ?? resolveMockTimeline(nextProjectId);
        setConnectionMode('mock');
        setTimelineRevision(null);
      }

      const normalized = normalizeTimeline(nextTimeline);
      setHistory({
        past: [],
        present: normalized,
        future: [],
      });
      setDirty(false);
      setStatus('ready');

      if (typeof window !== 'undefined') {
        window.localStorage.setItem(SELECTED_PROJECT_KEY, nextProjectId);
      }
    } catch (loadError) {
      setHistory({
        past: [],
        present: null,
        future: [],
      });
      setStatus('error');
      setError(
        loadError instanceof Error ? loadError.message : 'Failed to load timeline.',
      );
    }
  }

  function pushTimeline(nextTimeline: TimelineIR, origin: HistoryOrigin = 'manual_edit'): void {
    const normalized = normalizeTimeline(nextTimeline);

    setHistory((current) => {
      if (!current.present) {
        return current;
      }

      const entry: HistoryEntry = {
        timeline: structuredClone(current.present),
        origin,
      };
      const nextPast = [...current.past, entry].slice(-HISTORY_LIMIT);
      return {
        past: nextPast,
        present: normalized,
        future: [],
      };
    });

    setDirty(true);
    setStatus('ready');
    setError(null);
  }

  function updateClip(
    trackKind: 'video' | 'audio',
    trackId: string,
    clipId: string,
    updater: (clip: Clip) => void,
  ): void {
    if (!timeline) {
      return;
    }

    const nextTimeline = structuredClone(timeline);
    const track = nextTimeline.tracks[trackKind].find(
      (candidate) => candidate.track_id === trackId,
    );
    const clip = track?.clips.find((candidate) => candidate.clip_id === clipId);

    if (!track || !clip) {
      return;
    }

    updater(clip);
    pushTimeline(nextTimeline);
  }

  function undo(): void {
    setHistory((current) => {
      if (!current.past.length || !current.present) {
        return current;
      }

      const past = [...current.past];
      const previousEntry = past.pop()!;
      const futureEntry: HistoryEntry = {
        timeline: structuredClone(current.present),
        origin: 'manual_edit',
      };
      return {
        past,
        present: previousEntry.timeline,
        future: [futureEntry, ...current.future].slice(0, HISTORY_LIMIT),
      };
    });
    setDirty(true);
  }

  function redo(): void {
    setHistory((current) => {
      if (!current.future.length || !current.present) {
        return current;
      }

      const [nextEntry, ...future] = current.future;
      const pastEntry: HistoryEntry = {
        timeline: structuredClone(current.present),
        origin: 'manual_edit',
      };
      return {
        past: [...current.past, pastEntry].slice(-HISTORY_LIMIT),
        present: nextEntry.timeline,
        future,
      };
    });
    setDirty(true);
  }

  async function save(): Promise<TimelineSaveResult> {
    if (!timeline || !projectId) {
      return {
        ok: false,
        mode: connectionMode,
        error: 'No timeline is loaded.',
      };
    }

    const nextTimeline = normalizeTimeline({
      ...timeline,
      provenance: {
        ...timeline.provenance,
        editor_version: '0.1.0',
        last_editor_save: new Date().toISOString(),
      },
    });

    const validationIssues = validateTimeline(nextTimeline);
    if (validationIssues.length > 0) {
      const firstIssue = validationIssues[0];
      const nextError = `${firstIssue.path}: ${firstIssue.message}`;
      setStatus('error');
      setError(nextError);
      return {
        ok: false,
        mode: connectionMode,
        error: nextError,
      };
    }

    setStatus('saving');
    setError(null);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (timelineRevision) {
        headers['If-Match'] = `"${timelineRevision}"`;
      }

      const response = await fetch(`/api/projects/${projectId}/timeline`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(nextTimeline),
      });

      if (response.status === 409) {
        setStatus('error');
        setError('Timeline was modified externally. Reload to get the latest version.');
        return { ok: false, mode: 'api' as const, error: 'Conflict: revision mismatch' };
      }

      if (response.status === 423) {
        setStatus('error');
        setError('Project is locked by another operation. Try again shortly.');
        return { ok: false, mode: 'api' as const, error: 'Project locked (423)' };
      }

      if (response.status === 422 || response.status === 428) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        const msg = body.error ?? `Validation failed (${response.status})`;
        setStatus('error');
        setError(msg);
        return { ok: false, mode: 'api' as const, error: msg };
      }

      if (!response.ok) {
        // Server returned an error — do NOT fall back to mock
        const body = await response.json().catch(() => ({})) as { error?: string };
        const msg = body.error ?? `Timeline save failed (${response.status})`;
        setStatus('error');
        setError(msg);
        return { ok: false, mode: 'api' as const, error: msg };
      }

      const result = (await response.json()) as { timeline_revision?: string };
      if (result.timeline_revision) {
        setTimelineRevision(result.timeline_revision);
      } else {
        // Fallback: read ETag header
        const etag = response.headers.get('ETag');
        if (etag) {
          setTimelineRevision(etag.replace(/^"|"$/g, ''));
        }
      }

      setHistory((current) => ({
        ...current,
        present: nextTimeline,
      }));
      setConnectionMode('api');
      setDirty(false);
      setStatus('ready');
      setLastSavedAt(nextTimeline.provenance.last_editor_save ?? new Date().toISOString());

      return {
        ok: true,
        mode: 'api',
      };
    } catch (saveError) {
      // Only fall back to mock on network failure (TypeError from fetch)
      if (!(saveError instanceof TypeError)) {
        // Server was reachable but something unexpected happened
        const msg = saveError instanceof Error ? saveError.message : 'Save failed';
        setStatus('error');
        setError(msg);
        return { ok: false, mode: 'api' as const, error: msg };
      }

      // Network unreachable — fall back to local mock storage
      writeStoredTimeline(projectId, nextTimeline);
      setHistory((current) => ({
        ...current,
        present: nextTimeline,
      }));
      setConnectionMode('mock');
      setDirty(false);
      setStatus('ready');
      setError('API unreachable. Saved timeline to local storage.');
      setLastSavedAt(nextTimeline.provenance.last_editor_save ?? new Date().toISOString());

      return {
        ok: true,
        mode: 'mock',
      };
    }
  }

  function setProjectId(nextProjectId: string): void {
    setProjectIdState(nextProjectId);
  }

  /**
   * Accept a timeline mutation that was applied server-side (e.g. patch apply).
   * Pushes current present onto undo stack and sets the new timeline + revision.
   */
  /**
   * Accept a timeline mutation that was applied server-side (e.g. patch apply).
   * Pushes current present onto undo stack with origin: patch_apply.
   */
  function commitRemoteMutation(
    nextTimeline: TimelineIR,
    newRevision: string,
  ): void {
    const normalized = normalizeTimeline(nextTimeline);

    setHistory((current) => {
      if (!current.present) {
        return { past: [], present: normalized, future: [] };
      }

      const entry: HistoryEntry = {
        timeline: structuredClone(current.present),
        origin: 'patch_apply',
      };
      const nextPast = [...current.past, entry].slice(-HISTORY_LIMIT);
      return {
        past: nextPast,
        present: normalized,
        future: [],
      };
    });

    setTimelineRevision(newRevision);
    setDirty(false);
    setStatus('ready');
    setError(null);
  }

  async function reload(): Promise<void> {
    if (!projectId) {
      return;
    }

    await loadTimeline(projectId);
  }

  return {
    projects,
    projectId,
    timeline,
    status,
    error,
    dirty,
    connectionMode,
    lastSavedAt,
    timelineRevision,
    validationIssues: timeline ? validateTimeline(timeline) : [],
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    setProjectId,
    updateClip,
    undo,
    redo,
    save,
    reload,
    commitRemoteMutation,
  };
}
