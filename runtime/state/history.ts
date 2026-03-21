/**
 * State History — records and reads state transitions for project_state.yaml
 */

export interface HistoryEntry {
  from_state: string;
  to_state: string;
  trigger: string;
  actor: string;
  timestamp: string;
  note?: string;
}

export function createHistoryEntry(
  from: string,
  to: string,
  trigger: string,
  actor: string,
  note?: string,
): HistoryEntry {
  return {
    from_state: from,
    to_state: to,
    trigger,
    actor,
    timestamp: new Date().toISOString(),
    ...(note ? { note } : {}),
  };
}

export function appendHistory(
  history: HistoryEntry[],
  entry: HistoryEntry,
): HistoryEntry[] {
  return [...history, entry];
}
