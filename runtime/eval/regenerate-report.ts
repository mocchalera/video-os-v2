// Creative regeneration report — turns the scalar selects-agreement score into
// an actionable divergence narrative: which human-selected moments the AI MISSED
// (especially must-haves), which it ADDED, and the role/rank/beat agreement. The
// routine eval only recompiles approved plans (compiler regression); this is for
// the candidate-vs-golden mode where a freshly regenerated selection is scored
// against a human-approved golden, so we can see WHERE the AI's judgement
// diverges from a human's, not just by how much.

import type { Candidate, CreativeBrief, SelectsCandidates } from "../artifacts/types.js";
import { evaluateSelectsAgreement } from "./selects-agreement.js";
import {
  analyzeSelectionCoverage,
  type SelectionCoverageReport,
} from "./selection-coverage.js";
import type { SelectsAgreementReport } from "./types.js";

export interface SegmentEvidence {
  segment_id: string;
  summary?: string;
  transcript_excerpt?: string;
  tags?: string[];
}

export interface RegenerationReport {
  agreement: SelectsAgreementReport;
  coverage?: SelectionCoverageReport;
  missed: Candidate[];
  missedCritical: Candidate[];
  extra: Candidate[];
  markdown: string;
}

/** A human-selected moment is "must-have" when the brief flagged it or the
 * operator was near-certain. */
export function isMustHave(c: Candidate): boolean {
  const evidence = (c.evidence ?? []) as string[];
  if (evidence.some((e) => /must[_-]?have/i.test(String(e)))) return true;
  return (c.confidence ?? 0) >= 0.95;
}

/** A miss is "critical" when the human treated the moment as essential —
 * a must-have, OR a hero-role moment that carries a beat. Dropping either
 * clearly hurts the cut, so these are the highest-priority selection errors. */
export function isCritical(c: Candidate): boolean {
  return isMustHave(c) || c.role === "hero";
}

function pct(value: number | null | undefined): string {
  return value === null || value === undefined ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function describeMoment(c: Candidate, seg: SegmentEvidence | undefined): string {
  const quote = seg?.transcript_excerpt?.trim();
  const summary = seg?.summary?.trim();
  const detail = quote ? `“${quote}”` : summary ?? "(no transcript/summary)";
  const why = c.why_it_matches ? ` — why: ${c.why_it_matches}` : "";
  const role = c.role ? ` [${c.role}]` : "";
  const conf = c.confidence !== undefined ? ` (conf ${c.confidence})` : "";
  return `${c.segment_id}${role}${conf}: ${detail}${why}`;
}

function renderCoverageLines(coverage: SelectionCoverageReport): string[] {
  const runtime = coverage.runtime_coverage;
  const roles = coverage.role_distribution;
  const density = coverage.density;
  const lines: string[] = [];
  lines.push(`## Coverage`);
  lines.push(`- **score: ${(coverage.score * 100).toFixed(1)} / 100**`);
  lines.push(
    `- runtime selected/target: ${runtime.selected_sec.toFixed(1)}s / ${runtime.target_sec.toFixed(
      1,
    )}s (${(runtime.ratio * 100).toFixed(1)}%)`,
  );
  lines.push(
    `- roles: hero ${roles.hero}, support ${roles.support}, texture ${roles.texture}, transition ${roles.transition}, dialogue ${roles.dialogue}`,
  );
  lines.push(
    `- density: ${density.selected_count}/${density.segment_pool_size} (${(
      density.value * 100
    ).toFixed(1)}%)`,
  );
  const sampledClusters = coverage.cluster_coverage.filter((cluster) => cluster.under_sampled);
  lines.push(`- dense clusters under-sampled: ${sampledClusters.length}`);
  if (coverage.gaps.length === 0) {
    lines.push(`- gaps: none`);
  } else {
    lines.push(`- gaps:`);
    for (const gap of coverage.gaps) lines.push(`  - ${gap}`);
  }
  lines.push("");
  return lines;
}

/**
 * Score a regenerated selection against a human-approved golden and render an
 * actionable markdown report. `segments` supplies transcript/summary evidence so
 * missed/added moments read as content, not bare IDs.
 */
export function buildSelectsRegenerationReport(
  goldenSelects: SelectsCandidates,
  candidateSelects: SelectsCandidates,
  segments: SegmentEvidence[],
  meta: { goldenProject: string; candidateProject: string; evaluatedAt: string },
  brief?: CreativeBrief,
): RegenerationReport {
  const agreement = evaluateSelectsAgreement(goldenSelects, candidateSelects);
  const coverage = brief ? analyzeSelectionCoverage(candidateSelects, brief, segments) : undefined;
  const segById = new Map(segments.map((s) => [s.segment_id, s]));
  const goldenBySeg = new Map(goldenSelects.candidates.map((c) => [c.segment_id, c]));
  const candidateBySeg = new Map(candidateSelects.candidates.map((c) => [c.segment_id, c]));

  const missed = agreement.missing_from_candidate
    .map((id) => goldenBySeg.get(id))
    .filter((c): c is Candidate => Boolean(c));
  const extra = agreement.extra_in_candidate
    .map((id) => candidateBySeg.get(id))
    .filter((c): c is Candidate => Boolean(c));
  const missedCritical = missed.filter(isCritical);

  const lines: string[] = [];
  lines.push(`# Creative regeneration — selects agreement`);
  lines.push("");
  lines.push(`- golden (human): \`${meta.goldenProject}\``);
  lines.push(`- candidate (regenerated): \`${meta.candidateProject}\``);
  lines.push(`- evaluated_at: ${meta.evaluatedAt}`);
  lines.push("");
  lines.push(`## Scores`);
  lines.push(`- **composite: ${(agreement.score * 100).toFixed(1)} / 100**`);
  lines.push(`- selection F1: ${pct(agreement.f1)} (precision ${pct(agreement.precision)}, recall ${pct(agreement.recall)})`);
  lines.push(`- role agreement (matched): ${pct(agreement.role_agreement)}`);
  lines.push(`- rank correlation: ${agreement.rank_correlation === null ? "n/a" : agreement.rank_correlation.toFixed(3)}`);
  lines.push(`- beat-eligibility overlap: ${pct(agreement.beat_eligibility_overlap)}`);
  lines.push(`- counts: golden ${agreement.golden_count}, candidate ${agreement.candidate_count}, matched ${agreement.matched_count}`);
  lines.push("");

  if (coverage) {
    lines.push(...renderCoverageLines(coverage));
  }

  lines.push(`## ❗ Missed critical moments (${missedCritical.length})`);
  lines.push(`Human treated these as essential (must-have or hero-role); the AI did not select them. Highest-priority gap.`);
  if (missedCritical.length === 0) {
    lines.push(`- none — the AI covered every critical moment.`);
  } else {
    for (const c of missedCritical) {
      const tag = isMustHave(c) ? " «must-have»" : " «hero»";
      lines.push(`- ${describeMoment(c, segById.get(c.segment_id))}${tag}`);
    }
  }
  lines.push("");

  const otherMissed = missed.filter((c) => !isCritical(c));
  lines.push(`## Missed moments (${otherMissed.length})`);
  lines.push(`Human selected, AI omitted (supporting/texture).`);
  if (otherMissed.length === 0) lines.push(`- none.`);
  else for (const c of otherMissed) lines.push(`- ${describeMoment(c, segById.get(c.segment_id))}`);
  lines.push("");

  lines.push(`## Added moments (${extra.length})`);
  lines.push(`AI selected, human did not. Could be a defensible alternative or noise.`);
  if (extra.length === 0) lines.push(`- none.`);
  else for (const c of extra) lines.push(`- ${describeMoment(c, segById.get(c.segment_id))}`);
  lines.push("");

  return { agreement, coverage, missed, missedCritical, extra, markdown: lines.join("\n") };
}
