import type { PipelineTimingStage } from "../progress.js";

export const CANONICAL_PIPELINE_STAGES = [
  "ingest",
  "analyze",
  "stt",
  "marlin",
  "visualQuality",
  "peak",
  "embeddings",
  "footageDb",
  "triage",
  "blueprint",
  "compile",
  "review",
  "render",
  "qa",
  "package",
] as const;

export type CanonicalPipelineStage = typeof CANONICAL_PIPELINE_STAGES[number];

export const FULL_PIPELINE_RESUME_STAGE_ORDER = [
  "ingest",
  "stt",
  "marlin",
  "visual-quality",
  "peak",
  "embeddings",
  "triage",
  "blueprint",
  "compile",
  "render",
  "QA",
] as const satisfies readonly PipelineTimingStage[];

export type FullPipelineResumeStage = typeof FULL_PIPELINE_RESUME_STAGE_ORDER[number];

/**
 * Compatibility alias for callers that used the historical timing-stage name.
 * New resume/CLI code should use FULL_PIPELINE_RESUME_STAGE_ORDER instead.
 */
export const FULL_PIPELINE_TIMING_STAGE_ORDER = FULL_PIPELINE_RESUME_STAGE_ORDER;

export interface CanonicalStageObservability {
  timingStages: readonly PipelineTimingStage[];
  resumeStage: FullPipelineResumeStage | null;
}

/**
 * Canonical artifact stages and progress/resume stages intentionally differ.
 * Keep every fold explicit so observability and CLI vocabulary cannot drift
 * silently from the artifact-oriented pipeline model.
 */
export const CANONICAL_STAGE_OBSERVABILITY = {
  ingest: { timingStages: ["ingest"], resumeStage: "ingest" },
  analyze: {
    timingStages: ["ingest", "stt", "marlin", "visual-quality", "peak"],
    resumeStage: "ingest",
  },
  stt: { timingStages: ["stt"], resumeStage: "stt" },
  marlin: { timingStages: ["marlin"], resumeStage: "marlin" },
  visualQuality: { timingStages: ["visual-quality"], resumeStage: "visual-quality" },
  peak: { timingStages: ["peak"], resumeStage: "peak" },
  embeddings: { timingStages: ["embeddings"], resumeStage: "embeddings" },
  footageDb: { timingStages: ["embeddings"], resumeStage: "embeddings" },
  triage: { timingStages: ["triage"], resumeStage: "triage" },
  blueprint: { timingStages: ["blueprint"], resumeStage: "blueprint" },
  compile: { timingStages: ["compile"], resumeStage: "compile" },
  review: { timingStages: ["QA"], resumeStage: "QA" },
  render: { timingStages: ["render"], resumeStage: "render" },
  qa: { timingStages: ["QA"], resumeStage: "QA" },
  package: { timingStages: [], resumeStage: null },
} as const satisfies Record<CanonicalPipelineStage, CanonicalStageObservability>;

export const FULL_PIPELINE_PHASE_ORDER = [
  "analyze",
  "triage",
  "blueprint",
  "compile",
  "review",
  "render",
] as const;

export type FullPipelinePhase = typeof FULL_PIPELINE_PHASE_ORDER[number];
export type FullPipelineTarget = "roughcut" | "package";

export interface AnalyzeTimingStageOptions {
  skipStt?: boolean;
  skipMarlin?: boolean;
  skipPeak?: boolean;
}

export interface ScriptFullPipelinePlanOptions {
  from?: FullPipelineResumeStage;
  skipAnalyze?: boolean;
  skipFootageDb?: boolean;
  skipRender?: boolean;
  skipQa?: boolean;
}

export interface EditorialPipelinePlanOptions {
  skipRender?: boolean;
  skipQa?: boolean;
  qa?: boolean;
}

export interface FullPipelineCommandPlanOptions {
  from: FullPipelinePhase;
  target: FullPipelineTarget;
  analyze?: AnalyzeTimingStageOptions;
}

export function isFullPipelineResumeStage(value: string | undefined): value is FullPipelineResumeStage {
  return includesString(FULL_PIPELINE_RESUME_STAGE_ORDER, value);
}

/** @deprecated Use isFullPipelineResumeStage for public resume values. */
export function isFullPipelineTimingStage(value: string | undefined): value is PipelineTimingStage {
  return isFullPipelineResumeStage(value);
}

export function isFullPipelinePhase(value: string | undefined): value is FullPipelinePhase {
  return includesString(FULL_PIPELINE_PHASE_ORDER, value);
}

export function buildAnalyzeTimingStages(options?: AnalyzeTimingStageOptions): PipelineTimingStage[] {
  return [
    "ingest",
    ...(options?.skipStt ? [] : ["stt" as const]),
    ...(options?.skipMarlin ? [] : ["marlin" as const]),
    "visual-quality",
    ...(options?.skipPeak ? [] : ["peak" as const]),
  ];
}

export function buildScriptFullPipelineTimingStages(options: ScriptFullPipelinePlanOptions): PipelineTimingStage[] {
  const fromIndex = options.from ? FULL_PIPELINE_RESUME_STAGE_ORDER.indexOf(options.from) : 0;
  return FULL_PIPELINE_RESUME_STAGE_ORDER.filter((stage, index) => {
    if (index < fromIndex) return false;
    if (options.skipAnalyze && isAnalyzeTimingStage(stage)) return false;
    if (options.skipFootageDb && stage === "embeddings") return false;
    if (options.skipRender && stage === "render") return false;
    if (options.skipQa && stage === "QA") return false;
    return true;
  });
}

export function shouldRunScriptAnalyze(options: ScriptFullPipelinePlanOptions): boolean {
  if (options.skipAnalyze) return false;
  if (!options.from) return true;
  return stageIndex(options.from) <= stageIndex("peak");
}

export function shouldRunScriptFootageDb(options: ScriptFullPipelinePlanOptions): boolean {
  if (options.skipFootageDb) return false;
  if (!options.from) return true;
  return stageIndex(options.from) <= stageIndex("embeddings");
}

export function buildEditorialPipelineTimingStages(options: EditorialPipelinePlanOptions): PipelineTimingStage[] {
  const qaDisabled = options.skipQa === true || options.qa === false;
  return [
    "triage",
    "blueprint",
    "compile",
    ...(options.skipRender ? [] : ["render" as const]),
    ...(qaDisabled ? [] : ["QA" as const]),
  ];
}

export function buildFullPipelineCommandPhases(options: Pick<FullPipelineCommandPlanOptions, "from" | "target">): FullPipelinePhase[] {
  const startedAt = FULL_PIPELINE_PHASE_ORDER.indexOf(options.from);
  return FULL_PIPELINE_PHASE_ORDER.filter((phase, index) => {
    if (index < startedAt) return false;
    if (options.target === "roughcut" && phase === "render") return false;
    return true;
  });
}

export function buildFullPipelineCommandTimingStages(options: FullPipelineCommandPlanOptions): PipelineTimingStage[] {
  const stages: PipelineTimingStage[] = [];
  for (const phase of buildFullPipelineCommandPhases(options)) {
    if (phase === "analyze") {
      stages.push(...buildAnalyzeTimingStages(options.analyze));
      continue;
    }
    stages.push(commandPhaseToTimingStage(phase));
  }
  return stages;
}

function commandPhaseToTimingStage(phase: Exclude<FullPipelinePhase, "analyze">): PipelineTimingStage {
  if (phase === "review") return "QA";
  return phase;
}

function isAnalyzeTimingStage(stage: PipelineTimingStage): boolean {
  return stage === "ingest" ||
    stage === "stt" ||
    stage === "marlin" ||
    stage === "visual-quality" ||
    stage === "peak";
}

function stageIndex(stage: FullPipelineResumeStage): number {
  return FULL_PIPELINE_RESUME_STAGE_ORDER.indexOf(stage);
}

function includesString<TValue extends string>(
  values: readonly TValue[],
  value: string | undefined,
): value is TValue {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}
