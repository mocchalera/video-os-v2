export type CraftVerdict = "accept" | "revise" | "block";

export interface CraftIssue {
  beat_id: string;
  issue: string;
  suggestion: string;
  severity: "critical" | "improvement" | "taste";
}

export interface CraftRevision {
  beat_id: string;
  field: string;
  old_value: unknown;
  new_value: unknown;
  rationale: string;
}

export interface CraftDecision {
  verdict: CraftVerdict;
  issues: CraftIssue[];
  revisions: CraftRevision[];
  summary: string;
}
