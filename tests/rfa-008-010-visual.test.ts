import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateArtifact } from "../runtime/artifacts/loaders.js";
import { sanitizeBlueprint, BlueprintSanitizationError } from "../runtime/blueprint/sanitizer.js";
import {
  evaluateFramingPolicy,
  framingPolicyContentHash,
  loadFramingPolicy,
  type FramingObservation,
  type FramingPolicyDocument,
} from "../runtime/visual/framing-policy.js";
import {
  resolveVisionAssistedReframe,
  verifyReframeCandidateEvidence,
  type LocalVisionReframeAdapter,
} from "../runtime/visual/reframe.js";
import {
  projectRegisteredVisualIntents,
  VisualIntentProjectionError,
} from "../runtime/visual/jump-cut-policy.js";
import { extractClipTransform } from "../runtime/render/assembler.js";
import type { ClipOutput, TimelineIR } from "../runtime/compiler/types.js";
import type { RegisteredVisualIntent, SourceEvidencePin } from "../runtime/visual/types.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const POLICY_PATH = path.join(process.cwd(), "tests/fixtures/rfa-visual/framing_policy.json");

function policy(): FramingPolicyDocument {
  return loadFramingPolicy(POLICY_PATH);
}

function observation(overrides: Partial<FramingObservation> = {}): FramingObservation {
  const head = {
    x: 0.38,
    y: 0.20,
    width: 0.24,
    height: 0.28,
    eye_x: 0.50,
    eye_y: 0.45,
    yaw_radians: 0,
    confidence: 0.96,
  };
  return {
    time_us: 1_000_000,
    person: { ...head },
    head: { ...head },
    hands: [],
    ...overrides,
  };
}

function sourceEvidence(asset_id: string, segment_id: string, hash: string, start: number, end: number): SourceEvidencePin {
  return {
    asset_id,
    segment_id,
    source_content_hash: hash,
    source_range: { src_in_us: start, src_out_us: end },
  };
}

function framingInput() {
  return {
    observations: [observation()],
    output: { width: 1920, height: 1080 },
  };
}

function clip(overrides: Partial<ClipOutput> = {}): ClipOutput {
  return {
    clip_id: "CLP_A",
    segment_id: "SEG_A",
    asset_id: "AST_A",
    src_in_us: 0,
    src_out_us: 2_000_000,
    timeline_in_frame: 0,
    timeline_duration_frames: 48,
    role: "hero",
    motivation: "anonymous visual fixture",
    beat_id: "BEAT_A",
    fallback_segment_ids: [],
    confidence: 0.9,
    quality_flags: [],
    media_kind: "video",
    source_capabilities: { has_video: true, has_audio: true },
    candidate_ref: "CAND_A",
    ...overrides,
  };
}

function timeline(): TimelineIR {
  return {
    version: "1",
    project_id: "anonymous-rfa-visual",
    created_at: "2026-08-21T00:00:00.000Z",
    sequence: {
      name: "anonymous visual",
      fps_num: 24,
      fps_den: 1,
      width: 1920,
      height: 1080,
      start_frame: 0,
    },
    tracks: {
      video: [{
        track_id: "V1",
        kind: "video",
        clips: [
          clip(),
          clip({
            clip_id: "CLP_B",
            segment_id: "SEG_B",
            asset_id: "AST_B",
            timeline_in_frame: 48,
            candidate_ref: "CAND_B",
            src_out_us: 2_000_000,
          }),
        ],
      }],
      audio: [{
        track_id: "A1",
        kind: "audio",
        role: "dialogue",
        clips: [clip({ clip_id: "ACL_A", role: "dialogue" })],
      }],
    },
    markers: [],
    provenance: {
      brief_path: "01_intent/creative_brief.yaml",
      blueprint_path: "04_plan/edit_blueprint.yaml",
      selects_path: "04_plan/selects_candidates.yaml",
      compiler_version: "test",
    },
  };
}

function projectionOptions() {
  return {
    framing_policy: policy(),
    framing_policy_ref: "04_plan/framing_policy.json",
    source_identities: new Map([
      ["AST_A", { asset_id: "AST_A", source_content_hash: HASH_A, evidence_source: "provided" as const }],
      ["AST_B", { asset_id: "AST_B", source_content_hash: HASH_B, evidence_source: "provided" as const }],
    ]),
  };
}

function continuousIntent(): RegisteredVisualIntent {
  return {
    intent_id: "VIS_CONTINUOUS_001",
    policy: "registered-visual-intent/v1",
    mode: "continuous_transform",
    framing_mode: "punch",
    reason: "person size is stable across the registered hold",
    target: { candidate_ref: "CAND_A" },
    transform: { zoom: 1.2, position: { x: -12, y: 8 } },
    framing_input: framingInput(),
    source_evidence: [sourceEvidence("AST_A", "SEG_A", HASH_A, 0, 2_000_000)],
    confidence: 0.88,
  };
}

function discreteIntent(): RegisteredVisualIntent {
  return {
    intent_id: "VIS_DISCRETE_001",
    policy: "registered-visual-intent/v1",
    mode: "discrete_cut",
    framing_mode: "punch",
    reason: "the registered climax increases person size at the meaning beat",
    from: { clip_id: "CLP_A" },
    to: { clip_id: "CLP_B" },
    transform: { zoom: 1.3, position: { x: 0, y: 0 } },
    framing_input: framingInput(),
    source_evidence: [
      sourceEvidence("AST_A", "SEG_A", HASH_A, 0, 2_000_000),
      sourceEvidence("AST_B", "SEG_B", HASH_B, 0, 2_000_000),
    ],
    climax: { basis: "meaning", evidence_refs: ["meaning:anonymous-climax-001"] },
    confidence: 0.91,
  };
}

describe("RFA-008 generic framing policy", () => {
  it("keeps the visual intent in the v2 Blueprint schema/sanitizer path", () => {
    const blueprint = {
      version: "2",
      project_id: "anonymous-rfa-visual",
      sequence_goals: ["source-grounded visual framing"],
      beats: [{ id: "BEAT_A", label: "visual", target_duration_frames: 24, required_roles: ["hero"] }],
      pacing: { opening_cadence: "steady", middle_cadence: "steady", ending_cadence: "steady" },
      music_policy: { start_sparse: true, allow_release_late: true, entry_beat: "BEAT_A" },
      dialogue_policy: { preserve_natural_breath: true, avoid_wall_to_wall_voiceover: true },
      transition_policy: { prefer_match_texture_over_flashy_fx: true },
      ending_policy: { should_feel: "open" },
      rejection_rules: ["reject unsupported sources"],
      policy_refs: { composition_policy_ref: { ref: "04_plan/framing_policy.json", version: "framing-policy/v1" } },
      visual_intents: [continuousIntent()],
    };
    expect(() => validateArtifact(blueprint, "edit-blueprint.schema.json")).not.toThrow();
    expect(sanitizeBlueprint(blueprint).blueprint.visual_intents).toEqual(blueprint.visual_intents);
    expect(() => sanitizeBlueprint({ ...blueprint, visual_intents: [{ ...continuousIntent(), unexpected: true }] }))
      .toThrow(BlueprintSanitizationError);
  });

  it("validates the artifact and deterministically covers wide, punch, hold and all framing checks", () => {
    const artifact = JSON.parse(fs.readFileSync(POLICY_PATH, "utf8"));
    expect(() => validateArtifact(artifact, "framing-policy.schema.json")).not.toThrow();
    const input = {
      observations: [observation({ head: { ...observation().head!, yaw_radians: 0.35 }, person: { ...observation().person!, yaw_radians: 0.35 }, hands: [{ x: 0.12, y: 0.18, confidence: 0.8 }] })],
      output: { width: 1920, height: 1080 },
    };
    const results = (["wide", "punch", "hold"] as const).map((mode) => evaluateFramingPolicy({ ...input, mode }, policy()));
    expect(results.map((result) => result.requested_mode)).toEqual(["wide", "punch", "hold"]);
    expect(results[1].checks.person.status).toBe("pass");
    expect(results[1].checks.head.status).toBe("pass");
    expect(results[1].checks.hand.status).toBe("pass");
    expect(results[1].checks.look_room.status).toBe("pass");
    expect(results[1].checks.headroom.status).toBe("pass");
    expect(evaluateFramingPolicy({ ...input, mode: "punch" }, policy())).toEqual(results[1]);
  });

  it("degrades explicitly when head evidence is absent and can safe-degrade a failed punch to wide", () => {
    const missingHead = evaluateFramingPolicy({
      observations: [observation({ head: undefined })],
      output: { width: 1920, height: 1080 },
      mode: "punch",
    }, policy());
    expect(missingHead.status).toBe("manual_fallback");
    expect(missingHead.degrade_reason).toContain("person_or_head_evidence_missing");

    const safePolicy = structuredClone(policy());
    safePolicy.checks.hand.max_zoom = 1.3;
    const safe = evaluateFramingPolicy({
      observations: [observation({ hands: [{ x: 0.95, y: 0.5, confidence: 0.9 }] })],
      output: { width: 1920, height: 1080 },
      mode: "punch",
    }, safePolicy);
    expect(safe.status).toBe("degraded");
    expect(safe.applied_mode).toBe("wide");
    expect(safe.degraded).toBe(true);
    expect(safe.degrade_reason).toContain("safe_degrade");
  });
});

describe("RFA-009 optional local vision reframe", () => {
  const source = sourceEvidence("AST_A", "SEG_A", HASH_A, 1_000_000, 3_000_000);
  const request = {
    source,
    output: { width: 1920, height: 1080 },
    mode: "punch" as const,
    policy: policy(),
  };

  it("pins source, range, adapter, cache, model and deterministic result evidence", async () => {
    const adapter: LocalVisionReframeAdapter = {
      adapter_id: "anonymous-local-vision",
      adapter_version: "1.0.0",
      model: { id: "anonymous-detector", version: "weights-sha256:abc" },
      analyze: async () => ({
        status: "ready",
        observations: [observation()],
        model: { id: "anonymous-detector", version: `weights-sha256:${"c".repeat(64)}` },
        cache: { status: "hit", key: "cache-key-001" },
      }),
    };
    const first = await resolveVisionAssistedReframe(request, adapter);
    const second = await resolveVisionAssistedReframe(request, adapter);
    expect(first).toEqual(second);
    expect(first.source_identity).toEqual(source);
    expect(first.analyzed_range).toEqual(source.source_range);
    expect(first.model).toEqual({ id: "anonymous-detector", version: `weights-sha256:${"c".repeat(64)}` });
    expect(first.cache.status).toBe("hit");
    expect(first.framing_policy.content_hash).toBe(framingPolicyContentHash(request.policy));
    expect(first.result_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.candidate_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(() => validateArtifact(first, "reframe-candidate.schema.json")).not.toThrow();
    expect(verifyReframeCandidateEvidence(first)).toEqual(first);
    const tampered = structuredClone(first);
    tampered.source_identity.source_content_hash = HASH_B;
    expect(() => verifyReframeCandidateEvidence(tampered)).toThrow(/candidate_hash/);

    const recomputeCandidateHash = (value: typeof first): void => {
      const base = structuredClone(value) as unknown as Record<string, unknown>;
      delete base.candidate_hash;
      value.candidate_hash = `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(base))).digest("hex")}`;
    };
    const forgedModel = structuredClone(first);
    forgedModel.model.version = "v9";
    recomputeCandidateHash(forgedModel);
    expect(() => verifyReframeCandidateEvidence(forgedModel)).toThrow(/weights-sha256/);

    const reversedRange = structuredClone(first);
    reversedRange.source_identity.source_range = { src_in_us: 3_000_000, src_out_us: 1_000_000 };
    reversedRange.analyzed_range = { src_in_us: 3_000_000, src_out_us: 1_000_000 };
    recomputeCandidateHash(reversedRange);
    expect(() => verifyReframeCandidateEvidence(reversedRange)).toThrow(/non-empty non-negative range/);

    const manualUnavailable = structuredClone(first);
    (manualUnavailable.fallback as unknown as { manual_available: boolean }).manual_available = false;
    recomputeCandidateHash(manualUnavailable);
    expect(() => verifyReframeCandidateEvidence(manualUnavailable)).toThrow(/schema/);
  });

  it("fails open with an explicit manual fallback when the local model is unavailable", async () => {
    const adapter: LocalVisionReframeAdapter = {
      adapter_id: "anonymous-local-vision",
      adapter_version: "1.0.0",
      model: { id: "anonymous-detector", version: "weights-sha256:abc" },
      is_available: () => false,
      analyze: async () => {
        throw new Error("must not run");
      },
    };
    const candidate = await resolveVisionAssistedReframe(request, adapter);
    expect(candidate.result.status).toBe("manual_fallback");
    expect(candidate.fallback).toMatchObject({ manual_available: true, used: true });
    expect(candidate.result.degrade_reason).toContain("local_model_or_cache_unavailable");
    expect(candidate.model.version).toBe("weights-sha256:abc");
  });
});

describe("RFA-010 registered visual intent projection", () => {
  it("projects continuous transforms through the existing Studio/render transform consumer", () => {
    const result = projectRegisteredVisualIntents(timeline(), [continuousIntent()], projectionOptions());
    const target = result.tracks.video[0].clips[0];
    expect(extractClipTransform(target)).toMatchObject({ zoom: 1.2, position: { x: -12, y: 8 } });
    expect(target.metadata?.visual_framing).toMatchObject({
      policy: "registered-visual-intents/v1",
      mode: "continuous_transform",
      intent_id: "VIS_CONTINUOUS_001",
    });
    expect(result.provenance.visual_framing?.source_av_preserved).toBe(true);
    expect(result.transitions).toBeUndefined();
  });

  it("projects a registered discrete cut with climax/source A/V provenance and does not mutate audio", () => {
    const input = timeline();
    const audioBefore = JSON.stringify(input.tracks.audio);
    const result = projectRegisteredVisualIntents(input, [discreteIntent()], projectionOptions());
    expect(result.transitions).toBeUndefined();
    expect(result.tracks.video[0].clips[1].metadata?.zoom).toBe(1.3);
    expect(JSON.stringify(result.tracks.audio)).toBe(audioBefore);
    expect(result.provenance.visual_framing?.applied_intents[0].mode).toBe("discrete_cut");
    expect(result.provenance.visual_framing?.applied_intents[0].transition_effect).toBe("implicit_hard_cut");
    expect(() => validateArtifact(result, "timeline-ir.schema.json")).not.toThrow();
  });

  it("keeps an existing cut transition and its A/V parameters while appending intent metadata", () => {
    const input = timeline();
    input.transitions = [{
      transition_id: "TR_EXISTING_CUT",
      from_clip_id: "CLP_A",
      to_clip_id: "CLP_B",
      track_id: "V1",
      transition_type: "cut",
      transition_frames: 1,
      transition_params: { audio_lead_frames: 4, audio_lag_frames: 2 },
      metadata: { keep: "existing" },
    }];
    const result = projectRegisteredVisualIntents(input, [discreteIntent()], projectionOptions());
    expect(result.transitions).toEqual([expect.objectContaining({
      transition_id: "TR_EXISTING_CUT",
      transition_type: "cut",
      transition_params: { audio_lead_frames: 4, audio_lag_frames: 2 },
      metadata: expect.objectContaining({
        keep: "existing",
        visual_intent: expect.objectContaining({ mode: "discrete_cut" }),
      }),
    })]);
    expect(result.provenance.visual_framing?.applied_intents[0].transition_effect).toBe("existing_cut");
  });

  it.each(["j_cut", "l_cut", "crossfade"])("rejects non-cut transition %s without deleting it", (transitionType) => {
    const input = timeline();
    input.transitions = [{
      transition_id: `TR_${transitionType}`,
      from_clip_id: "CLP_A",
      to_clip_id: "CLP_B",
      track_id: "V1",
      transition_type: transitionType,
      transition_frames: 12,
      transition_params: { audio_lead_frames: 4, audio_lag_frames: 2 },
      metadata: { keep: transitionType },
    }];
    const before = structuredClone(input.transitions);
    expect(() => projectRegisteredVisualIntents(input, [discreteIntent()], projectionOptions())).toThrow(new RegExp(`existing transition ${transitionType}`));
    expect(input.transitions).toEqual(before);
  });

  it("safe-degrades a raw transform that exceeds the artifact policy bound", () => {
    const restrictive = structuredClone(policy());
    restrictive.modes.punch.max_zoom = 1.01;
    const result = projectRegisteredVisualIntents(timeline(), [{
      ...continuousIntent(),
      transform: { zoom: 8 },
    }], { ...projectionOptions(), framing_policy: restrictive });
    const applied = result.provenance.visual_framing?.applied_intents[0];
    expect(result.tracks.video[0].clips[0].metadata?.zoom).toBeLessThanOrEqual(1.01);
    expect(applied?.framing_result.status).toBe("degraded");
    expect(applied?.framing_result.requested_mode).toBe("punch");
    expect(applied?.framing_result.degrade_reason).toContain("safe_degrade");
    expect(result.tracks.video[0].clips[0].metadata?.visual_framing).toMatchObject({
      framing_result: { status: "degraded" },
    });
  });

  it("rejects unknown refs, stale source hashes, and non-adjacent arbitrary intervals", () => {
    expect(() => projectRegisteredVisualIntents(timeline(), [{
      ...continuousIntent(),
      target: { clip_id: "CLP_UNKNOWN" },
    }], projectionOptions())).toThrow(/unknown target reference/);

    expect(() => projectRegisteredVisualIntents(timeline(), [{
      ...continuousIntent(),
      source_evidence: [sourceEvidence("AST_A", "SEG_A", HASH_B, 0, 2_000_000)],
    }], projectionOptions())).toThrow(/source content hash mismatch/);

    const nonAdjacent = timeline();
    nonAdjacent.tracks.video[0].clips[1].timeline_in_frame = 60;
    expect(() => projectRegisteredVisualIntents(nonAdjacent, [discreteIntent()], projectionOptions()))
      .toThrow(VisualIntentProjectionError);
    expect(() => projectRegisteredVisualIntents(nonAdjacent, [discreteIntent()], projectionOptions()))
      .toThrow(/arbitrary intervals/);
  });

  it("is deterministic for sorted intent input", () => {
    const first = projectRegisteredVisualIntents(timeline(), [discreteIntent(), continuousIntent()], projectionOptions());
    const second = projectRegisteredVisualIntents(timeline(), [continuousIntent(), discreteIntent()], projectionOptions());
    expect(second).toEqual(first);
  });
});

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]));
  }
  return value;
}
