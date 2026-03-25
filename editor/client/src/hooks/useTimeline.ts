import { useEffect, useRef, useState } from 'react';
import { mockProjects, resolveMockTimeline } from '../mocks/mockData';
import type {
  Clip,
  HistoryOrigin,
  ProjectSummary,
  SessionBaseline,
  TimelineIR,
  TimelineSaveResult,
  TimelineValidationIssue,
  Track,
} from '../types';
import {
  getFps,
  getTimelineClipEndFrame,
  getTimelineDurationFrames,
} from '../utils/time';

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
          timeline_duration_frames: getTimelineDurationFrames(clip, fps),
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

function sortTrackClips(track: Track): Clip[] {
  return [...track.clips].sort((left, right) => {
    if (left.timeline_in_frame !== right.timeline_in_frame) {
      return left.timeline_in_frame - right.timeline_in_frame;
    }

    return left.clip_id.localeCompare(right.clip_id);
  });
}

function validateOverlaps(
  trackType: 'video' | 'audio',
  track: Track,
  fps: number,
): TimelineValidationIssue[] {
  const issues: TimelineValidationIssue[] = [];
  const sortedClips = sortTrackClips(track);
  let lastEndFrame = -1;

  for (let index = 0; index < sortedClips.length; ) {
    const groupStartFrame = sortedClips[index].timeline_in_frame;
    const groupStartIndex = index;
    let groupEndFrame = Number.POSITIVE_INFINITY;

    while (
      index < sortedClips.length &&
      sortedClips[index].timeline_in_frame === groupStartFrame
    ) {
      groupEndFrame = Math.min(
        groupEndFrame,
        getTimelineClipEndFrame(sortedClips[index], fps),
      );
      index += 1;
    }

    const basePath = `${trackType}.${track.track_id}.clips[${groupStartIndex}]`;

    if (lastEndFrame > groupStartFrame) {
      issues.push({
        path: `${basePath}.timeline_in_frame`,
        message: `Track ${track.track_id} has overlapping clips.`,
      });
    }

    // Legacy timelines can stack alternative candidates at the same start frame.
    // Use the earliest end in that stack as the linear boundary for the next group.
    lastEndFrame = Math.max(lastEndFrame, groupEndFrame);
  }

  return issues;
}

function validateTimeline(timeline: TimelineIR): TimelineValidationIssue[] {
  const issues: TimelineValidationIssue[] = [];
  const fps = getFps(timeline.sequence);

  function checkTrack(trackType: 'video' | 'audio', track: Track): void {
    sortTrackClips(track).forEach((clip, index) => {
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
    });

    issues.push(...validateOverlaps(trackType, track, fps));
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
  const [sessionBaseline, setSessionBaseline] = useState<SessionBaseline | null>(null);

  const timeline = history.present;
  const dragSnapshotRef = useRef<TimelineIR | null>(null);
  const dragDirtyRef = useRef(false);
  const saveRequestRef = useRef<Promise<TimelineSaveResult> | null>(null);

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
      let fetchedRevision: string | null = null;

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
          fetchedRevision = etag.replace(/^"|"$/g, '');
          setTimelineRevision(fetchedRevision);
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

      // Establish session baseline with the confirmed ETag value (not stale state)
      setSessionBaseline({
        timeline: structuredClone(normalized),
        baselineRevision: fetchedRevision ?? 'initial',
        establishedBy: 'initial_load',
      });

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

  function updateClipSilent(
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
    const normalized = normalizeTimeline(nextTimeline);
    setHistory((current) => ({
      ...current,
      present: normalized,
    }));
    setDirty(true);
    dragDirtyRef.current = true;
  }

  function beginDrag(): void {
    if (timeline) {
      dragSnapshotRef.current = structuredClone(timeline);
      dragDirtyRef.current = false;
    }
  }

  function endDrag(): void {
    const snapshot = dragSnapshotRef.current;
    const changed = dragDirtyRef.current;
    dragSnapshotRef.current = null;
    dragDirtyRef.current = false;

    if (!snapshot || !changed) return;

    setHistory((current) => {
      if (!current.present) return current;
      const entry: HistoryEntry = {
        timeline: snapshot,
        origin: 'manual_edit',
      };
      return {
        past: [...current.past, entry].slice(-HISTORY_LIMIT),
        present: current.present,
        future: [],
      };
    });
    setDirty(true);
  }

  /**
   * Swap a clip's source with an alternative candidate.
   * This is a manual edit (not an AI patch), tracked as 'manual_swap'.
   */
  function swapClip(
    trackKind: 'video' | 'audio',
    trackId: string,
    clipId: string,
    candidate: {
      segment_id: string;
      asset_id: string;
      src_in_us: number;
      src_out_us: number;
      confidence: number;
      quality_flags?: string[];
      candidate_ref?: string;
      why_it_matches?: string;
    },
  ): void {
    if (!timeline) return;

    const nextTimeline = structuredClone(timeline);
    const track = nextTimeline.tracks[trackKind].find(
      (t) => t.track_id === trackId,
    );
    const clip = track?.clips.find((c) => c.clip_id === clipId);
    if (!track || !clip) return;

    clip.segment_id = candidate.segment_id;
    clip.asset_id = candidate.asset_id;
    clip.src_in_us = candidate.src_in_us;
    clip.src_out_us = candidate.src_out_us;
    clip.confidence = candidate.confidence;
    clip.quality_flags = candidate.quality_flags ?? [];
    clip.candidate_ref = candidate.candidate_ref ?? candidate.segment_id;
    clip.motivation = `[Manual swap] ${candidate.why_it_matches ?? 'Alternative selected by editor'}`;

    pushTimeline(nextTimeline, 'manual_swap');
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
    if (saveRequestRef.current) {
      return saveRequestRef.current;
    }

    const saveTask = (async (): Promise<TimelineSaveResult> => {
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
        const overlapIssues = validationIssues.filter((i) =>
          i.message.includes('overlapping'),
        );
        const nextError =
          overlapIssues.length > 0
            ? `Save blocked: ${overlapIssues.length} track overlap(s) detected — ${overlapIssues.map((i) => i.path).join(', ')}`
            : `${validationIssues[0].path}: ${validationIssues[0].message}`;
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
        let nextRevision: string | null = null;
        if (result.timeline_revision) {
          nextRevision = result.timeline_revision;
          setTimelineRevision(nextRevision);
        } else {
          // Fallback: read ETag header
          const etag = response.headers.get('ETag');
          if (etag) {
            nextRevision = etag.replace(/^"|"$/g, '');
            setTimelineRevision(nextRevision);
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
          timelineRevision: nextRevision ?? undefined,
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
    })();

    let guardedSaveTask: Promise<TimelineSaveResult>;
    guardedSaveTask = saveTask.finally(() => {
      if (saveRequestRef.current === guardedSaveTask) {
        saveRequestRef.current = null;
      }
    });
    saveRequestRef.current = guardedSaveTask;
    return guardedSaveTask;
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

  // Expose history origins and snapshots for useDiff patch_apply detection
  const historyOrigins = history.past.map((entry) => entry.origin);
  const historySnapshots = history.past.map((entry) => entry.timeline);

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
    sessionBaseline,
    historyOrigins,
    historySnapshots,
    validationIssues: timeline ? validateTimeline(timeline) : [],
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    setProjectId,
    updateClip,
    updateClipSilent,
    beginDrag,
    endDrag,
    swapClip,
    undo,
    redo,
    save,
    reload,
    commitRemoteMutation,
  };
}
