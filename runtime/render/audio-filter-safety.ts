/**
 * Reject a destructive FFmpeg filter order that removes silence inserted by
 * adelay. Source trimming belongs before adelay; whole-mix duration trimming
 * belongs after amix. A per-input `adelay=...,atrim=start=0` silently moves the
 * content back to t=0 while preserving the output duration.
 */
export function findDestructivePostDelayTrims(filterGraph: string): string[] {
  const violations: string[] = [];

  for (const rawBranch of filterGraph.split(";")) {
    const branch = rawBranch.trim();
    const delayIndex = branch.search(/adelay=/);
    if (delayIndex < 0) continue;

    const trimAfterDelay = branch.slice(delayIndex).search(
      /,atrim=[^,]*\bstart=0(?:\.0+)?(?=[: ,]|$)/,
    );
    if (trimAfterDelay < 0) continue;

    const absoluteTrimIndex = delayIndex + trimAfterDelay;
    const mixIndex = branch.indexOf("amix=", delayIndex);
    if (mixIndex >= 0 && mixIndex < absoluteTrimIndex) continue;

    violations.push(branch);
  }

  return violations;
}

export function assertSafeAudioDelayFilterOrder(filterGraph: string): void {
  const violations = findDestructivePostDelayTrims(filterGraph);
  if (violations.length === 0) return;

  throw new Error(
    "Unsafe audio filter order: atrim(start=0) after adelay removes the inserted lead-in. " +
    "Trim the source before adelay and trim only the final mixed output. " +
    `branch=${violations[0]}`,
  );
}
