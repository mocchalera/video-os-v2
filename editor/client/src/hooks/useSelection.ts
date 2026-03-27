import { useCallback, useRef, useState } from 'react';
import type { Clip, SelectionState, TimelineIR } from '../types';

export interface MultiSelection {
  /** All selected items. First item is the "primary" (most recently clicked). */
  items: SelectionState[];
}

const EMPTY: MultiSelection = { items: [] };
const EMPTY_SET = new Set<string>();

/** Find all clips sharing the same link_group_id across a timeline */
function findLinkedClips(
  timeline: TimelineIR | null,
  clipId: string,
): SelectionState[] {
  if (!timeline) return [];

  let linkGroupId: string | undefined;
  // Find the clip's link_group_id
  for (const kind of ['video', 'audio'] as const) {
    for (const track of timeline.tracks[kind]) {
      const clip = track.clips.find((c) => c.clip_id === clipId);
      if (clip?.metadata?.link_group_id) {
        linkGroupId = clip.metadata.link_group_id as string;
        break;
      }
    }
    if (linkGroupId) break;
  }

  if (!linkGroupId) return [];

  const linked: SelectionState[] = [];
  for (const kind of ['video', 'audio'] as const) {
    for (const track of timeline.tracks[kind]) {
      for (const clip of track.clips) {
        if (
          clip.clip_id !== clipId &&
          clip.metadata?.link_group_id === linkGroupId
        ) {
          linked.push({
            trackKind: kind,
            trackId: track.track_id,
            clipId: clip.clip_id,
          });
        }
      }
    }
  }
  return linked;
}

export function useSelection() {
  const [multi, setMulti] = useState<MultiSelection>(EMPTY);
  const [linkedSelectionEnabled, setLinkedSelectionEnabled] = useState(true);
  const selectedClipIdsRef = useRef<Set<string>>(EMPTY_SET);
  /** Timeline ref for linked selection — set from App.tsx */
  const timelineRef = useRef<TimelineIR | null>(null);

  /** Primary selection (backward compat) */
  const selection: SelectionState | null = multi.items[0] ?? null;

  /** Set of all selected clip IDs for fast lookup — stable reference when contents unchanged */
  const nextIds = multi.items.map((s) => s.clipId);
  const prevSet = selectedClipIdsRef.current;
  const changed = nextIds.length !== prevSet.size || nextIds.some((id) => !prevSet.has(id));
  if (changed) {
    selectedClipIdsRef.current = new Set(nextIds);
  }
  const selectedClipIds = selectedClipIdsRef.current;

  /** Expand a selection array with linked clips when linked selection is enabled */
  const expandLinked = useCallback(
    (items: SelectionState[]): SelectionState[] => {
      if (!linkedSelectionEnabled) return items;
      const expanded = [...items];
      const seen = new Set(items.map((s) => s.clipId));
      for (const item of items) {
        const linked = findLinkedClips(timelineRef.current, item.clipId);
        for (const l of linked) {
          if (!seen.has(l.clipId)) {
            seen.add(l.clipId);
            expanded.push(l);
          }
        }
      }
      return expanded;
    },
    [linkedSelectionEnabled],
  );

  /** Simple click — replace selection with single item */
  const selectClip = useCallback(
    (next: SelectionState) => {
      setMulti({ items: expandLinked([next]) });
    },
    [expandLinked],
  );

  /** Shift+click — add to selection (if not already selected) */
  const addToSelection = useCallback(
    (next: SelectionState) => {
      setMulti((prev) => {
        const exists = prev.items.some((s) => s.clipId === next.clipId);
        if (exists) return prev;
        const toAdd = expandLinked([next]);
        const existing = new Set(prev.items.map((s) => s.clipId));
        const newItems = toAdd.filter((s) => !existing.has(s.clipId));
        return { items: [...newItems, ...prev.items] };
      });
    },
    [expandLinked],
  );

  /** Cmd/Ctrl+click — toggle selection */
  const toggleSelection = useCallback(
    (next: SelectionState) => {
      setMulti((prev) => {
        const exists = prev.items.some((s) => s.clipId === next.clipId);
        if (exists) {
          // Remove clip and its linked partners
          const toRemove = new Set([
            next.clipId,
            ...findLinkedClips(timelineRef.current, next.clipId).map(
              (l) => l.clipId,
            ),
          ]);
          const filtered = prev.items.filter(
            (s) => !toRemove.has(s.clipId),
          );
          return { items: filtered };
        }
        const toAdd = expandLinked([next]);
        const existing = new Set(prev.items.map((s) => s.clipId));
        const newItems = toAdd.filter((s) => !existing.has(s.clipId));
        return { items: [...newItems, ...prev.items] };
      });
    },
    [expandLinked],
  );

  /** Marquee select — replace selection with multiple items */
  const selectMultiple = useCallback(
    (items: SelectionState[]) => {
      setMulti({ items: expandLinked(items) });
    },
    [expandLinked],
  );

  /** Clear all selection */
  const clearSelection = useCallback(() => {
    setMulti(EMPTY);
  }, []);

  /** Check if a specific clip is selected */
  const isSelected = useCallback(
    (clipId: string) => selectedClipIds.has(clipId),
    [selectedClipIds],
  );

  /** Toggle linked selection on/off */
  const toggleLinkedSelection = useCallback(() => {
    setLinkedSelectionEnabled((prev) => !prev);
  }, []);

  /** Set the timeline reference for linked selection resolution */
  const setTimelineForLinks = useCallback((tl: TimelineIR | null) => {
    timelineRef.current = tl;
  }, []);

  return {
    /** Primary selection (first item or null) — backward compat */
    selection,
    /** All selected items */
    selectedItems: multi.items,
    /** Set of selected clip IDs */
    selectedClipIds,
    /** Whether linked selection is enabled */
    linkedSelectionEnabled,
    /** Simple click select */
    selectClip,
    /** Shift+click add */
    addToSelection,
    /** Cmd/Ctrl+click toggle */
    toggleSelection,
    /** Marquee batch select */
    selectMultiple,
    /** Clear all */
    clearSelection,
    /** Check single */
    isSelected,
    /** Toggle linked selection */
    toggleLinkedSelection,
    /** Set timeline for link resolution */
    setTimelineForLinks,
  };
}
