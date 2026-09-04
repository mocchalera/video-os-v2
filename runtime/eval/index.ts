// Editorial agreement eval — orchestrator.
//
// Two modes:
//  - compare: candidate project dir vs golden project dir. Evaluates
//    whichever artifacts both sides have (selects, blueprint, timeline).
//  - self: recompile the golden's own brief+selects+blueprint with the
//    current compiler in a scratch copy and compare the resulting
//    timeline against the approved one. Detects compiler/policy
//    regressions with zero new data.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { runCanonicalCompile } from "../compiler/index.js";
import {
  loadBlueprint,
  loadSelects,
  loadTimeline,
} from "../artifacts/loaders.js";
import type { CreativeBrief, TimelineIR } from "../artifacts/types.js";
import { evaluateSelectsAgreement } from "./selects-agreement.js";
import { evaluateBlueprintAgreement } from "./blueprint-agreement.js";
import { evaluateTimelineAgreement } from "./timeline-agreement.js";
import { runLlmJudge } from "./llm-judge.js";
import type { LlmJudgeReport } from "./types.js";
import { composeEvalReport } from "./report.js";
import type { EvalReport, EvalStageScores } from "./types.js";
import { resolveReviewCutIdentity } from "../review/edit-identity.js";
import { computeArtifactSha256 } from "../review/edit-identity.js";

export { discoverGoldenProjects } from "./golden-registry.js";
export { composeEvalReport, renderMarkdownReport } from "./report.js";
export { evaluateSelectsAgreement } from "./selects-agreement.js";
export { evaluateBlueprintAgreement } from "./blueprint-agreement.js";
export { evaluateTimelineAgreement } from "./timeline-agreement.js";
export { analyzeSelectionCoverage } from "./selection-coverage.js";
export type { SelectionCoverageReport } from "./selection-coverage.js";
export { evaluateAssemblyLoss, ASSEMBLY_LOSS_EVALUATOR_VERSION } from "./assembly-loss.js";
export type {
  AssemblyLossInput,
  AssemblyLossReport,
  AssemblyLossTranscript,
  CausalEdgeRef,
  HumanStructuralReference,
} from "./assembly-loss.js";
export {
  ASSEMBLY_LOSS_HOLD_NOTE,
  ASSEMBLY_LOSS_REPORT_KIND,
  assertAssemblyLossReportIdentity,
  assemblyLossBasename,
  buildAssemblyLossProjectReport,
  loadProjectInputs,
  renderAssemblyLossMarkdown,
  reportVerdict,
  runAssemblyLossCli,
  writeAssemblyLossOutputs,
} from "./assembly-loss-project.js";
export type {
  AssemblyLossProjectReport,
  AssemblyLossSourceArtifact,
  LoadedProjectInputs,
} from "./assembly-loss-project.js";
export * from "./types.js";

const ARTIFACT_PATHS = {
  brief: "01_intent/creative_brief.yaml",
  selects: "04_plan/selects_candidates.yaml",
  blueprint: "04_plan/edit_blueprint.yaml",
  timeline: "05_timeline/timeline.json",
} as const;

export interface EvaluateOptions {
  /** Enable the optional Gemini judge (requires GEMINI_API_KEY). */
  judge?: boolean;
  minScore?: number | null;
  /** Injected for tests; defaults to wall clock. */
  now?: () => Date;
}

function artifactPath(projectDir: string, key: keyof typeof ARTIFACT_PATHS): string {
  return path.join(projectDir, ARTIFACT_PATHS[key]);
}

function readApprovedBy(projectDir: string): string | null {
  const statePath = path.join(projectDir, "project_state.yaml");
  if (!fs.existsSync(statePath)) return null;
  try {
    const state = parseYaml(fs.readFileSync(statePath, "utf-8")) as {
      approval_record?: { approved_by?: string | null };
    };
    return state?.approval_record?.approved_by ?? null;
  } catch {
    return null;
  }
}

/**
 * Judge failures (quota, network, malformed JSON) must never sink the
 * deterministic eval — degrade to structural-only scoring with a warning.
 */
async function runLlmJudgeSafely(
  input: Parameters<typeof runLlmJudge>[0],
): Promise<LlmJudgeReport | null> {
  try {
    return await runLlmJudge(input);
  } catch (err) {
    console.error(
      `  llm-judge: skipped (${(err as Error).message.split("\n")[0].slice(0, 160)})`,
    );
    return null;
  }
}

function readBriefIfPresent(projectDir: string): CreativeBrief | null {
  const briefPath = artifactPath(projectDir, "brief");
  if (!fs.existsSync(briefPath)) return null;
  try {
    return parseYaml(fs.readFileSync(briefPath, "utf-8")) as CreativeBrief;
  } catch {
    return null;
  }
}

/**
 * Compare a candidate project's artifacts against a golden project.
 * Stages are evaluated only when the artifact exists on both sides.
 */
export async function evaluateCandidateAgainstGolden(
  candidateDir: string,
  goldenDir: string,
  options: EvaluateOptions = {},
): Promise<EvalReport> {
  const stages: EvalStageScores = {};

  const bothHave = (key: keyof typeof ARTIFACT_PATHS): boolean =>
    fs.existsSync(artifactPath(goldenDir, key)) &&
    fs.existsSync(artifactPath(candidateDir, key));

  if (bothHave("selects")) {
    stages.selects = evaluateSelectsAgreement(
      loadSelects(artifactPath(goldenDir, "selects")),
      loadSelects(artifactPath(candidateDir, "selects")),
    );
  }
  if (bothHave("blueprint")) {
    stages.blueprint = evaluateBlueprintAgreement(
      loadBlueprint(artifactPath(goldenDir, "blueprint")),
      loadBlueprint(artifactPath(candidateDir, "blueprint")),
    );
  }

  let goldenTimeline: TimelineIR | null = null;
  let candidateTimeline: TimelineIR | null = null;
  if (bothHave("timeline")) {
    goldenTimeline = loadTimeline(artifactPath(goldenDir, "timeline"));
    candidateTimeline = loadTimeline(artifactPath(candidateDir, "timeline"));
    stages.timeline = evaluateTimelineAgreement(goldenTimeline, candidateTimeline);
  }

  if (Object.keys(stages).length === 0) {
    throw new Error(
      `No comparable artifacts between ${goldenDir} and ${candidateDir} (need selects, blueprint, or timeline on both sides)`,
    );
  }

  let llmJudge = null;
  if (options.judge && goldenTimeline && candidateTimeline) {
    llmJudge = await runLlmJudgeSafely({
      brief: readBriefIfPresent(goldenDir),
      golden: goldenTimeline,
      candidate: candidateTimeline,
    });
  }

  const now = options.now ?? (() => new Date());
  const candidateIdentity = candidateTimeline
    ? resolveReviewCutIdentity({ projectDir: candidateDir, timelinePath: artifactPath(candidateDir, "timeline") })
    : null;
  return composeEvalReport({
    mode: "compare",
    goldenProject: path.basename(path.resolve(goldenDir)),
    candidateProject: path.basename(path.resolve(candidateDir)),
    goldenApprovedBy: readApprovedBy(goldenDir),
    evaluatedAt: now().toISOString(),
    stages,
    llmJudge,
    minScore: options.minScore ?? null,
    ...(candidateIdentity && goldenTimeline ? { timelineIdentity: {
      golden_cut_identity: computeArtifactSha256(artifactPath(goldenDir, "timeline")),
      candidate_cut_identity: candidateIdentity.cut_identity,
      candidate_review_mode: candidateIdentity.mode,
    } } : {}),
  });
}

// ── Self mode ───────────────────────────────────────────────────────

const SELF_COPY_ENTRIES = [
  "01_intent",
  "03_analysis",
  "04_plan",
  "STYLE.md",
  "project_state.yaml",
];

/**
 * Recompile the golden project's inputs in a scratch directory (the
 * golden itself is never written to) and compare the freshly compiled
 * timeline against the approved timeline.
 */
export async function selfEvaluateGolden(
  goldenDir: string,
  options: EvaluateOptions = {},
): Promise<{ report: EvalReport; workdir: string }> {
  const resolvedGolden = path.resolve(goldenDir);
  const goldenTimelinePath = artifactPath(resolvedGolden, "timeline");
  if (!fs.existsSync(goldenTimelinePath)) {
    throw new Error(`Golden timeline not found: ${goldenTimelinePath}`);
  }
  const goldenTimeline = loadTimeline(goldenTimelinePath);

  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-eval-"));
  for (const entry of SELF_COPY_ENTRIES) {
    const src = path.join(resolvedGolden, entry);
    if (!fs.existsSync(src)) continue;
    fs.cpSync(src, path.join(workdir, entry), { recursive: true });
  }

  // The scratch dir lives under os.tmpdir, so repo-root discovery
  // from projectPath cannot work — resolve it from this module instead.
  const repoRoot = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "../..",
  );
  await runCanonicalCompile({
    projectPath: workdir,
    repoRoot,
    createdAt: goldenTimeline.created_at,
    fpsNum: goldenTimeline.sequence.fps_num,
  });

  const candidateTimeline = loadTimeline(artifactPath(workdir, "timeline"));
  const stages: EvalStageScores = {
    timeline: evaluateTimelineAgreement(goldenTimeline, candidateTimeline),
  };

  let llmJudge = null;
  if (options.judge) {
    llmJudge = await runLlmJudgeSafely({
      brief: readBriefIfPresent(resolvedGolden),
      golden: goldenTimeline,
      candidate: candidateTimeline,
    });
  }

  const now = options.now ?? (() => new Date());
  const report = composeEvalReport({
    mode: "self",
    goldenProject: path.basename(resolvedGolden),
    candidateProject: `${path.basename(resolvedGolden)} (recompiled)`,
    goldenApprovedBy: readApprovedBy(resolvedGolden),
    evaluatedAt: now().toISOString(),
    stages,
    llmJudge,
    minScore: options.minScore ?? null,
    timelineIdentity: {
      golden_cut_identity: computeArtifactSha256(goldenTimelinePath),
      candidate_cut_identity: computeArtifactSha256(artifactPath(workdir, "timeline")),
      candidate_review_mode: "legacy_canonical",
    },
  });
  return { report, workdir };
}
