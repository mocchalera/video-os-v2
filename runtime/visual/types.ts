/** Shared, source-grounded contracts for the Milestone 1C visual path. */

import type {
  FramingObservation,
  FramingOutput,
  FramingPolicyResult,
} from "./framing-policy.js";

export type FramingMode = "wide" | "punch" | "hold";

export type VisualIntentMode = "continuous_transform" | "discrete_cut";

export type VisualClimaxBasis = "person_size" | "composition" | "meaning";

export interface VisualTransform {
  zoom?: number;
  crop?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  /** Pixel-space position, matching the existing Studio/render contract. */
  position?: {
    x: number;
    y: number;
  };
}

export interface SourceRange {
  src_in_us: number;
  src_out_us: number;
}

/** Evidence identity that must travel with a visual candidate. */
export interface SourceEvidencePin {
  asset_id: string;
  segment_id: string;
  source_content_hash: string;
  source_range: SourceRange;
  source_fingerprint?: string;
}

export interface VisualIntentRef {
  clip_id?: string;
  candidate_ref?: string;
  segment_id?: string;
}

export interface VisualClimax {
  basis: VisualClimaxBasis;
  evidence_refs: string[];
}

/** Policy inputs are authored/pinned with an intent when no vision candidate is adopted. */
export interface VisualFramingInput {
  observations: FramingObservation[];
  output: FramingOutput;
}

/** A registered visual instruction authored in edit_blueprint.yaml. */
export interface RegisteredVisualIntent {
  intent_id: string;
  policy: "registered-visual-intent/v1";
  mode: VisualIntentMode;
  framing_mode?: FramingMode;
  reason: string;
  target?: VisualIntentRef;
  from?: VisualIntentRef;
  to?: VisualIntentRef;
  transform?: VisualTransform;
  source_evidence: SourceEvidencePin[];
  framing_input?: VisualFramingInput;
  /** Relative artifact ref and candidate_hash for an adopted vision result. */
  reframe_candidate_ref?: string;
  reframe_candidate_hash?: string;
  climax?: VisualClimax;
  confidence?: number;
  degraded?: boolean;
  degrade_reason?: string;
}

export interface AppliedVisualIntent {
  intent_id: string;
  mode: VisualIntentMode;
  clip_ids: string[];
  source_evidence: SourceEvidencePin[];
  framing_result: FramingPolicyResult;
  confidence?: number;
  degraded: boolean;
  reason: string;
  reframe_candidate_ref?: string;
  reframe_candidate_hash?: string;
  climax?: VisualClimax;
  transition_effect?: "implicit_hard_cut" | "existing_cut";
}

export interface VisualFramingProvenance {
  policy: "registered-visual-intents/v1";
  framing_policy_ref: string;
  framing_policy_id: string;
  applied_intents: AppliedVisualIntent[];
  source_av_preserved: true;
}
