export * from "./review/index.js";

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  runReview as runReviewImpl,
  type ReviewAgent,
  type ReviewCommandOptions,
  type ReviewCommandResult,
  type ReviewReport,
} from "./review/index.js";
import {
  isP2AudioStoryGraphEnabled,
  readAudioStoryGraph,
} from "../artifacts/p2-audio-story-graph.js";
import {
  isP3ContinuityPreferenceEnabled,
  readContinuityGraph,
} from "../artifacts/p3-continuity-graph.js";

export async function runReview(
  projectDir: string,
  agent: ReviewAgent,
  options?: ReviewCommandOptions,
): Promise<ReviewCommandResult> {
  const result = await runReviewImpl(projectDir, agent, options);
  if (!result.success) return result;

  const absDir = path.resolve(projectDir);
  const changedP2 = isP2AudioStoryGraphEnabled() && appendAudioStoryGraphReviewWarnings(absDir, result.report);
  const changedP3 = isP3ContinuityPreferenceEnabled() && appendContinuityGraphReviewWarnings(absDir, result.report);
  if (!changedP2 && !changedP3) return result;

  const reportPath = path.join(absDir, "06_review/review_report.yaml");
  if (fs.existsSync(reportPath)) {
    const fileReport = parseYaml(fs.readFileSync(reportPath, "utf-8")) as ReviewReport;
    const fileChangedP2 = isP2AudioStoryGraphEnabled() && appendAudioStoryGraphReviewWarnings(absDir, fileReport);
    const fileChangedP3 = isP3ContinuityPreferenceEnabled() && appendContinuityGraphReviewWarnings(absDir, fileReport);
    if (fileChangedP2 || fileChangedP3) {
      fs.writeFileSync(reportPath, stringifyYaml(fileReport), "utf-8");
    }
  }
  return result;
}

function appendAudioStoryGraphReviewWarnings(projectDir: string, report?: ReviewReport): boolean {
  if (!report) return false;
  const graph = readAudioStoryGraph(projectDir);
  if (!graph) return false;
  let changed = false;
  const roles = new Set(graph.nodes.map((node) => node.story_role).filter(Boolean));
  if (roles.has("setup") && !roles.has("payoff") && !roles.has("closing")) {
    report.warnings.push({
      summary: "Audio story graph has setup nodes without payoff or closing nodes",
      severity: "warning",
      details: "Report-only P2 planning signal: review whether setup audio was dropped before payoff.",
      evidence: graph.nodes
        .filter((node) => node.story_role === "setup")
        .map((node) => `audio_story_node_ref:${node.node_id}`),
    });
    changed = true;
  }

  const awkwardTransitions = graph.edges.filter((edge) => edge.type === "contrasts_with" || edge.type === "silence_after");
  if (awkwardTransitions.length > 0) {
    report.warnings.push({
      summary: "Audio story graph flagged potentially awkward audio transitions",
      severity: "warning",
      details: "Report-only P2 planning signal from audio_story_graph edge types.",
      evidence: awkwardTransitions.map((edge) => `audio_story_edge_ref:${edge.edge_id}`),
    });
    changed = true;
  }
  return changed;
}

function appendContinuityGraphReviewWarnings(projectDir: string, report?: ReviewReport): boolean {
  if (!report) return false;
  const graph = readContinuityGraph(projectDir);
  if (!graph) return false;
  const continuityBreaks = graph.risks.filter((risk) => risk.type === "axis_break" || risk.type === "duplicate_content");
  if (continuityBreaks.length === 0) return false;
  report.warnings.push({
    summary: "Continuity graph flagged report-only continuity risks",
    severity: "warning",
    details: "Report-only P3 planning signal from continuity_graph risks.",
    evidence: continuityBreaks.map((risk) => `continuity_risk_ref:${risk.risk_id}`),
  });
  return true;
}
