export interface PipelinePhaseFailure<TFailure> {
  success: false;
  failure: TFailure;
  phaseCompleted: boolean;
}

export interface PipelinePhaseStep<TPhase extends string, TFailure> {
  phase: TPhase;
  run(): Promise<void | PipelinePhaseFailure<TFailure>>;
}

export interface PipelinePhaseExecutionResult<TPhase extends string, TFailure> {
  success: boolean;
  completedPhases: TPhase[];
  failedPhase?: TPhase;
  failure?: TFailure;
}

export function failPipelinePhase<TFailure>(
  failure: TFailure,
  options: { phaseCompleted?: boolean } = {},
): PipelinePhaseFailure<TFailure> {
  return {
    success: false,
    failure,
    phaseCompleted: options.phaseCompleted === true,
  };
}

export async function executePipelinePhases<TPhase extends string, TFailure>(
  steps: readonly PipelinePhaseStep<TPhase, TFailure>[],
): Promise<PipelinePhaseExecutionResult<TPhase, TFailure>> {
  const completedPhases: TPhase[] = [];

  for (const step of steps) {
    const outcome = await step.run();
    if (outcome?.success === false) {
      if (outcome.phaseCompleted) completedPhases.push(step.phase);
      return {
        success: false,
        completedPhases,
        failedPhase: step.phase,
        failure: outcome.failure,
      };
    }
    completedPhases.push(step.phase);
  }

  return {
    success: true,
    completedPhases,
  };
}
