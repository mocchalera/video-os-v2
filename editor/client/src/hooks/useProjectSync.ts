import { useCallback, useMemo, useRef, useState } from 'react';
import { useWebSocket, type WebSocketStatus } from './useWebSocket';

// ── Sync event types (mirrors server/services/watch-hub.ts) ─────────

type ProjectSyncSource = 'external' | 'api-save' | 'patch-apply' | 'ai-job';

interface TimelineChangedEvent {
  type: 'timeline.changed';
  project_id: string;
  revision?: string;
  source: ProjectSyncSource;
  changed_at: string;
}

interface ReviewChangedEvent {
  type: 'review.changed';
  project_id: string;
  review_report_revision?: string;
  review_patch_revision?: string;
  source: ProjectSyncSource;
  changed_at: string;
}

interface ProjectStateChangedEvent {
  type: 'project-state.changed';
  project_id: string;
  source: ProjectSyncSource;
  changed_at: string;
}

interface RenderChangedEvent {
  type: 'render.changed';
  project_id: string;
  source: ProjectSyncSource;
  changed_at: string;
}

type ProjectSyncEvent =
  | TimelineChangedEvent
  | ReviewChangedEvent
  | ProjectStateChangedEvent
  | RenderChangedEvent
  | { type: 'connected'; project_id: string; timestamp: string };

// ── Hook options ────────────────────────────────────────────────────

interface UseProjectSyncOptions {
  projectId: string;
  /** Current local timeline revision (from useTimeline). */
  localRevision: string | null;
  /** Whether the client has unsaved local changes. */
  dirty: boolean;
  /** Callback to reload timeline from server. */
  onTimelineReload: () => Promise<void>;
  /** Callback to reload review artifacts. */
  onReviewReload: () => void;
}

/**
 * Manages WebSocket-driven sync between editor client and server.
 *
 * Handles:
 * - timeline.changed → re-fetch if not self-echo, merge banner if dirty
 * - review.changed → re-fetch review artifacts
 * - project-state.changed / render.changed → trigger status refresh
 * - Reconnect recovery: full re-fetch on reconnect
 */
export function useProjectSync({
  projectId,
  localRevision,
  dirty,
  onTimelineReload,
  onReviewReload,
}: UseProjectSyncOptions) {
  const [pendingRemoteRevision, setPendingRemoteRevision] = useState<string | null>(null);
  const [showMergeBanner, setShowMergeBanner] = useState(false);

  // Keep stable refs for values used in callbacks
  const localRevisionRef = useRef(localRevision);
  localRevisionRef.current = localRevision;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const onTimelineReloadRef = useRef(onTimelineReload);
  onTimelineReloadRef.current = onTimelineReload;
  const onReviewReloadRef = useRef(onReviewReload);
  onReviewReloadRef.current = onReviewReload;

  const handleMessage = useCallback((data: unknown) => {
    const event = data as ProjectSyncEvent;
    if (!event || typeof event !== 'object' || !('type' in event)) return;

    switch (event.type) {
      case 'timeline.changed': {
        // Skip self-echo: if the revision matches our local revision,
        // this was caused by our own save.
        if (event.revision && event.revision === localRevisionRef.current) {
          return;
        }

        if (dirtyRef.current) {
          // Don't auto-replace — show merge banner
          setPendingRemoteRevision(event.revision ?? null);
          setShowMergeBanner(true);
        } else {
          // Safe to auto-reload
          void onTimelineReloadRef.current();
        }
        break;
      }

      case 'review.changed': {
        onReviewReloadRef.current();
        break;
      }

      case 'project-state.changed':
      case 'render.changed': {
        // Trigger review reload which also fetches project status
        onReviewReloadRef.current();
        break;
      }

      case 'connected': {
        // Connection established — no action needed (onConnected handles recovery)
        break;
      }
    }
  }, []);

  const handleConnected = useCallback(() => {
    // Post-reconnect recovery: always re-fetch review artifacts
    onReviewReloadRef.current();

    // Timeline: only auto-reload if not dirty; otherwise show merge banner
    if (dirtyRef.current) {
      setPendingRemoteRevision(null);
      setShowMergeBanner(true);
    } else {
      void onTimelineReloadRef.current();
    }
  }, []);

  // Build WebSocket URL from projectId
  const wsUrl = useMemo(() => {
    if (!projectId) return null;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    return `${protocol}//${host}/api/ws?projectId=${encodeURIComponent(projectId)}`;
  }, [projectId]);

  const { status } = useWebSocket({
    url: wsUrl,
    onMessage: handleMessage,
    onConnected: handleConnected,
  });

  /** Dismiss the merge banner and reload remote state. */
  function acceptRemote(): void {
    setShowMergeBanner(false);
    setPendingRemoteRevision(null);
    void onTimelineReloadRef.current();
  }

  /** Dismiss the merge banner but keep local changes (stay dirty). */
  function keepLocal(): void {
    setShowMergeBanner(false);
    // pendingRemoteRevision stays for potential future reference
  }

  return {
    wsStatus: status,
    showMergeBanner,
    pendingRemoteRevision,
    acceptRemote,
    keepLocal,
  };
}
