import { useEffect, useEffectEvent, useRef } from 'react';
import type { Clip, SelectionState, TimelineIR, TrimMode, TrimTarget } from '../types';

/** Find a clip within the timeline for edit-point detection */
function findClipForSel(
  timeline: TimelineIR | null,
  sel: SelectionState,
): Clip | null {
  if (!timeline) return null;
  const track = timeline.tracks[sel.trackKind]?.find((t) => t.track_id === sel.trackId);
  return track?.clips.find((c) => c.clip_id === sel.clipId) ?? null;
}

// ── Playback channel interface (shared shape for Program / Source) ────

interface PlaybackChannel {
  togglePlayback: () => void | Promise<void>;
  playheadFrame: number;
  shuttleSpeed: number;
  setShuttleSpeed: (speed: number) => void;
  stepFrame: (delta: number) => void;
  setMarkIn: () => void;
  setMarkOut: () => void;
  clearMarkIn: () => void;
  clearMarkOut: () => void;
}

interface UseEditorKeyboardOptions {
  /** Which monitor currently receives transport commands */
  activeMonitor: 'source' | 'program';
  onSetActiveMonitor: (monitor: 'source' | 'program') => void;
  /** Current editor mode — in AI mode, Source Monitor is hidden */
  editorMode: 'nle' | 'ai';

  /** Program monitor playback (always needed for legacy compat) */
  programPlayback: PlaybackChannel;
  /** Source monitor playback */
  sourcePlayback: PlaybackChannel | null;

  timelineState: {
    timeline: TimelineIR | null;
    save: () => Promise<unknown>;
    undo: () => void;
    redo: () => void;
  };
  selectionState: {
    clearSelection: () => void;
    toggleLinkedSelection: () => void;
    selection: SelectionState | null;
  };
  trimState: {
    activeTrimTarget: TrimTarget | null;
    isDragging: boolean;
    cancelTrim: () => void;
    keyboardTrimStep: (step: number, fallbackTarget?: TrimTarget) => void;
    setTrimMode: (mode: TrimMode) => void;
  };
  aiJobIsRunning: boolean;
  /** Whether the command palette is currently open */
  paletteOpen?: boolean;
  /** Whether any modal dialog (MergeDialog) is open */
  dialogOpen?: boolean;
  onExportRender: () => Promise<void>;
  onToggleSnap?: () => void;
  onLinkToggle?: () => void;
  onRippleDelete?: () => void;
  onLift?: () => void;
  onInsert?: () => void;
  onOverwrite?: () => void;
  onMatchFrame?: () => void;
  onToggleLoop?: () => void;
  onCompile?: () => void;
  onReview?: () => void;
  onRender?: () => void;
  onApplySelectedPatch?: () => void;
  onOpenDiff?: () => void;
}

export function useEditorKeyboard({
  activeMonitor,
  onSetActiveMonitor,
  editorMode,
  programPlayback,
  sourcePlayback,
  timelineState,
  selectionState,
  trimState,
  aiJobIsRunning,
  paletteOpen,
  dialogOpen,
  onExportRender,
  onToggleSnap,
  onLinkToggle,
  onRippleDelete,
  onLift,
  onInsert,
  onOverwrite,
  onMatchFrame,
  onToggleLoop,
  onCompile,
  onReview,
  onRender,
  onApplySelectedPatch,
  onOpenDiff,
}: UseEditorKeyboardOptions): void {
  // K-held state for slow shuttle
  const kHeldRef = useRef(false);

  /** Get the active playback channel */
  function getActiveChannel(): PlaybackChannel {
    if (activeMonitor === 'source' && sourcePlayback) return sourcePlayback;
    return programPlayback;
  }

  const handleKeyDown = useEffectEvent(async (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    const isTextInput = Boolean(
      target?.closest('input, textarea, select, [contenteditable="true"]'),
    );

    // ── Escape priority chain: palette → dialog → trim → selection → no-op
    if (event.key === 'Escape') {
      // 1. Command palette (handled by its own keydown in AppShell, skip here)
      if (paletteOpen) return;
      // 2. Dialog (MergeDialog handles its own Escape via onKeyDown, skip here)
      if (dialogOpen) return;
      // 3. Active trim
      if (trimState.isDragging) {
        trimState.cancelTrim();
        return;
      }
      // 4. Selection
      if (selectionState.selection) {
        selectionState.clearSelection();
        return;
      }
      // 5. No-op
      return;
    }

    // ── Dialog open: block everything except Escape (handled above) ──
    if (dialogOpen) return;

    // ── Space: toggle playback ──────────────────────────────────────
    if (event.key === ' ' && !isTextInput) {
      event.preventDefault();
      const ch = getActiveChannel();
      await ch.togglePlayback();
      return;
    }

    // ── Cmd/Ctrl+S: save ────────────────────────────────────────────
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (!aiJobIsRunning) await timelineState.save();
      return;
    }

    // ── Cmd/Ctrl+Enter: export render ───────────────────────────────
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      await onExportRender();
      return;
    }

    // ── Cmd/Ctrl+Z / Cmd/Ctrl+Shift+Z: undo / redo ─────────────────
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (aiJobIsRunning) return;
      if (event.shiftKey) {
        timelineState.redo();
        return;
      }
      timelineState.undo();
      return;
    }

    // ── Ctrl+Y: redo (Windows) ──────────────────────────────────────
    if (event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      if (aiJobIsRunning) return;
      timelineState.redo();
      return;
    }

    // ── Tab: cycle active monitor ───────────────────────────────────
    if (event.key === 'Tab' && !isTextInput && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      // In AI mode Source Monitor is hidden — stay on Program
      if (editorMode === 'ai') return;
      onSetActiveMonitor(activeMonitor === 'source' ? 'program' : 'source');
      return;
    }

    // ── JKL Shuttle (active monitor) ────────────────────────────────
    if (!isTextInput && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
      const key = event.key.toLowerCase();
      const ch = getActiveChannel();

      // K: stop + mark as held
      if (key === 'k') {
        event.preventDefault();
        kHeldRef.current = true;
        ch.setShuttleSpeed(0);
        return;
      }

      // L: forward shuttle
      if (key === 'l' && !event.shiftKey) {
        event.preventDefault();
        if (kHeldRef.current) {
          // K+L: slow forward
          ch.setShuttleSpeed(0.25);
        } else {
          const current = ch.shuttleSpeed;
          if (current <= 0) {
            // Switching direction or starting: 1x
            ch.setShuttleSpeed(1);
          } else {
            // Consecutive L: double speed (max 8x)
            ch.setShuttleSpeed(Math.min(current * 2, 8));
          }
        }
        return;
      }

      // J: reverse shuttle
      if (key === 'j') {
        event.preventDefault();
        if (kHeldRef.current) {
          // K+J: slow reverse
          ch.setShuttleSpeed(-0.25);
        } else {
          const current = ch.shuttleSpeed;
          if (current >= 0) {
            // Switching direction or starting: -1x
            ch.setShuttleSpeed(-1);
          } else {
            // Consecutive J: double reverse speed (max -8x)
            ch.setShuttleSpeed(Math.max(current * 2, -8));
          }
        }
        return;
      }
    }

    // ── I / O: Mark In / Out (active monitor) ───────────────────────
    if (!isTextInput && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
      const key = event.key.toLowerCase();
      const ch = getActiveChannel();

      if (key === 'i') {
        event.preventDefault();
        if (event.altKey) {
          ch.clearMarkIn();
        } else {
          ch.setMarkIn();
        }
        return;
      }

      if (key === 'o') {
        event.preventDefault();
        if (event.altKey) {
          ch.clearMarkOut();
        } else {
          ch.setMarkOut();
        }
        return;
      }
    }

    // ── Option+I / Option+O: clear marks ────────────────────────────
    if (event.altKey && !event.metaKey && !event.ctrlKey && !isTextInput) {
      const key = event.key.toLowerCase();
      const ch = getActiveChannel();
      if (key === 'i') { event.preventDefault(); ch.clearMarkIn(); return; }
      if (key === 'o') { event.preventDefault(); ch.clearMarkOut(); return; }
    }

    // ── Left/Right: Frame step or Trim step ─────────────────────────
    if (!isTextInput && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault();
      const direction = event.key === 'ArrowLeft' ? -1 : 1;
      const magnitude = event.shiftKey ? 10 : 1;
      const step = direction * magnitude;

      // Only enter trim step when an explicit trim target is active
      if (trimState.activeTrimTarget) {
        trimState.keyboardTrimStep(step);
        return;
      }

      // Otherwise, frame step on active monitor
      const ch = getActiveChannel();
      ch.stepFrame(step);
      return;
    }

    // ── F9: Insert ──────────────────────────────────────────────────
    if (event.key === 'F9' && !isTextInput) {
      event.preventDefault();
      onInsert?.();
      return;
    }

    // ── F10: Overwrite ──────────────────────────────────────────────
    if (event.key === 'F10' && !isTextInput) {
      event.preventDefault();
      onOverwrite?.();
      return;
    }

    // ── Trim mode shortcuts (A/B/N/Y/U) ────────────────────────────
    if (!isTextInput && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      const key = event.key.toLowerCase();
      if (key === 'a') { trimState.setTrimMode('selection'); return; }
      if (key === 'b') { trimState.setTrimMode('ripple'); return; }
      if (key === 'n') { trimState.setTrimMode('roll'); return; }
      if (key === 'y') { trimState.setTrimMode('slip'); return; }
      if (key === 'u') { trimState.setTrimMode('slide'); return; }
    }

    // ── Keyboard trim: comma/period ─────────────────────────────────
    if (!isTextInput && (event.key === ',' || event.key === '.')) {
      const trimTarget = trimState.activeTrimTarget;
      const sel = selectionState.selection;
      if (trimTarget || sel) {
        event.preventDefault();
        const step = event.key === ',' ? (event.shiftKey ? -10 : -1) : (event.shiftKey ? 10 : 1);
        let fallback: TrimTarget | undefined;
        if (!trimTarget && sel) {
          let side: 'head' | 'tail' = 'tail';
          const clip = findClipForSel(timelineState.timeline, sel);
          if (clip) {
            const headDist = Math.abs(programPlayback.playheadFrame - clip.timeline_in_frame);
            const tailDist = Math.abs(
              programPlayback.playheadFrame - (clip.timeline_in_frame + clip.timeline_duration_frames),
            );
            side = headDist <= tailDist ? 'head' : 'tail';
          }
          fallback = { clipId: sel.clipId, trackId: sel.trackId, trackKind: sel.trackKind, side };
        }
        trimState.keyboardTrimStep(step, fallback);
        return;
      }
    }

    // ── Cmd/Ctrl+L: link/unlink ─────────────────────────────────────
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'l') {
      event.preventDefault();
      onLinkToggle?.();
      return;
    }

    // ── Shift+L: linked selection toggle ────────────────────────────
    if (event.shiftKey && !event.metaKey && !event.ctrlKey && event.key === 'L') {
      event.preventDefault();
      selectionState.toggleLinkedSelection();
      return;
    }

    // ── Delete: Lift (gap remains) ─────────────────────────────────
    if (!event.shiftKey && (event.key === 'Delete' || event.key === 'Backspace') && !isTextInput) {
      event.preventDefault();
      onLift?.();
      return;
    }

    // ── Shift+Delete: Ripple delete ─────────────────────────────────
    if (event.shiftKey && (event.key === 'Delete' || event.key === 'Backspace') && !isTextInput) {
      event.preventDefault();
      onRippleDelete?.();
      return;
    }

    // ── F: Match frame (show source at same frame as program) ────
    if (!isTextInput && event.key.toLowerCase() === 'f' && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      onMatchFrame?.();
      return;
    }

    // ── Cmd/Ctrl+Shift+B: Compile ────────────────────────────────
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'b') {
      event.preventDefault();
      onCompile?.();
      return;
    }

    // ── Cmd/Ctrl+Shift+R: Review ─────────────────────────────────
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'r') {
      event.preventDefault();
      onReview?.();
      return;
    }

    // ── Cmd/Ctrl+Shift+E: Render ─────────────────────────────────
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'e') {
      event.preventDefault();
      onRender?.();
      return;
    }

    // ── Option+Enter: Apply selected patch ───────────────────────
    if (event.altKey && event.key === 'Enter' && !isTextInput) {
      event.preventDefault();
      onApplySelectedPatch?.();
      return;
    }

    // ── Shift+D: Open Diff panel ─────────────────────────────────
    if (event.shiftKey && event.key === 'D' && !event.metaKey && !event.ctrlKey && !isTextInput) {
      event.preventDefault();
      onOpenDiff?.();
      return;
    }

    // ── Shift+/: Toggle loop ──────────────────────────────────────────
    if (event.shiftKey && event.key === '?' && !event.metaKey && !event.ctrlKey && !isTextInput) {
      event.preventDefault();
      onToggleLoop?.();
      return;
    }

    // S key: toggle snap (only when no modifier)
    if (event.key.toLowerCase() === 's' && !isTextInput && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      onToggleSnap?.();
    }
  });

  const handleKeyUp = useEffectEvent((event: KeyboardEvent) => {
    // K release: pause at current frame
    if (event.key.toLowerCase() === 'k') {
      kHeldRef.current = false;
      const ch = activeMonitor === 'source' && sourcePlayback ? sourcePlayback : programPlayback;
      // If slow shuttle was active via K-hold, stop
      const speed = ch.shuttleSpeed;
      if (speed === 0.25 || speed === -0.25) {
        ch.setShuttleSpeed(0);
      }
    }
  });

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      void handleKeyDown(event);
    }
    function onKeyUp(event: KeyboardEvent): void {
      handleKeyUp(event);
    }
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
    };
  }, []);
}
