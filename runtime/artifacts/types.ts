// Canonical artifact type definitions for Video OS v2.
// Single source of truth — all modules should import artifact types from here.
// Re-exports compiler/types.ts for backward compatibility.

export type {
  // Duration
  DurationMode,
  CaptionPolicySource,
  DurationPolicy,
  // Creative Brief
  CreativeBriefEditorial,
  CreativeBrief,
  // Blueprint
  ConfirmedPreferences,
  TransitionPolicy,
  EndingPolicy,
  CandidatePlan,
  Beat,
  StoryArcStrategy,
  StoryArc,
  ResolvedRef,
  DedupeRules,
  QualityTargets,
  TrimPolicy,
  EditBlueprint,
  // Selects
  Role,
  ClipRole,
  TrimHint,
  EditorialSignals,
  EditorialSummary,
  Candidate,
  SelectsCandidates,
  // Scoring / Compiler
  ScoringParams,
  SkillEffect,
  SkillDefinition,
  ProfileDefaults,
  ProfileDefinition,
  PolicyDefinition,
  CompilerDefaults,
  // Normalized (Phase 1)
  NormalizedBeat,
  RoleQuotas,
  NormalizedData,
  // Scoring (Phase 2)
  ScoredCandidate,
  RankedCandidateTable,
  // Assembly (Phase 3)
  TimelineClip,
  Track,
  AssembledTimeline,
  Marker,
  // Final output (Phase 5)
  TimelineTransitionOutput,
  TimelineIR,
  TrackOutput,
  ClipOutput,
  MarkerOutput,
  AudioPolicy,
  // Compiler options
  CompileOptions,
} from "../compiler/types.js";
