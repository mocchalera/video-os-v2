import { useState } from 'react';
import type { SelectionState } from '../types';

export function useSelection() {
  const [selection, setSelection] = useState<SelectionState | null>(null);

  function selectClip(nextSelection: SelectionState): void {
    setSelection(nextSelection);
  }

  function clearSelection(): void {
    setSelection(null);
  }

  return {
    selection,
    selectClip,
    clearSelection,
  };
}
