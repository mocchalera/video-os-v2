import { describe, expect, it } from "vitest";
import { applyPatch } from "../runtime/compiler/patch.js";
import {
  assertHookPatchOperationAllowed,
  assertHookRecompileAllowed,
  assertHookTimelineMutationAllowed,
  buildHookLockProvenance,
  HookLockViolationError,
} from "../runtime/compiler/hook-lock.js";
import {
  bindShotAnchorsToTimeline,
  computeHookFingerprint,
  resolveShotAnchors,
  ShotAnchorResolutionError,
} from "../runtime/compiler/shot-anchor-resolver.js";
import { sanitizeBlueprint, BlueprintSanitizationError } from "../runtime/blueprint/sanitizer.js";
import type {
  Candidate,
  EditBlueprint,
  TimelineIR,
  ClipOutput,
} from "../runtime/compiler/types.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    segment_id: "SEG_ANON_001",
    asset_id: "AST_ANON_001",
    src_in_us: 1_000_000,
    src_out_us: 3_000_000,
    role: "hero",
    why_it_matches: "anonymous fixture source",
    risks: [],
    confidence: 1,
    ...overrides,
  };
}

function blueprint(overrides: Record<string, unknown> = {}): EditBlueprint {
  return {
    version: "2",
    project_id: "anonymous-rfa-fixture",
    sequence_goals: ["test explicit source grounding"],
    beats: [],
    pacing: {},
    music_policy: {},
    dialogue_policy: {},
    transition_policy: {},
    ending_policy: {},
    rejection_rules: [],
    hook_sequence: {
      sequence_id: "hook-anon",
      locked: true,
      lock_revision: 3,
      shots: [{
        shot_id: "shot-hook-1",
        beat_id: "beat-hook",
        shot_anchor: {
          anchor_id: "anchor-hook-1",
          asset_id: "AST_ANON_001",
          source_content_hash: HASH_A,
          segment_id: "SEG_ANON_001",
          src_in_us: 1_000_000,
          src_out_us: 3_000_000,
        },
      }],
    },
    ...overrides,
  } as unknown as EditBlueprint;
}

function clip(overrides: Partial<ClipOutput> = {}): ClipOutput {
  return {
    clip_id: "CLP_HOOK_001",
    segment_id: "SEG_ANON_001",
    asset_id: "AST_ANON_001",
    src_in_us: 1_000_000,
    src_out_us: 3_000_000,
    timeline_in_frame: 0,
    timeline_duration_frames: 48,
    role: "hero",
    motivation: "anonymous fixture",
    beat_id: "beat-hook",
    fallback_segment_ids: [],
    confidence: 1,
    quality_flags: [],
    candidate_ref: "legacy:SEG_ANON_001:1000000:3000000",
    ...overrides,
  };
}

function timeline(withLock?: TimelineIR["provenance"]["hook_lock"]): TimelineIR {
  return {
    version: "1",
    project_id: "anonymous-rfa-fixture",
    created_at: "2026-08-21T00:00:00.000Z",
    sequence: {
      name: "anonymous",
      fps_num: 24,
      fps_den: 1,
      width: 1920,
      height: 1080,
      start_frame: 0,
    },
    tracks: {
      video: [{ track_id: "V1", kind: "video", clips: [clip(), clip({
        clip_id: "CLP_BODY_001",
        segment_id: "SEG_BODY_001",
        asset_id: "AST_BODY_001",
        beat_id: "beat-body",
        candidate_ref: "legacy:SEG_BODY_001:0:2000000",
        timeline_in_frame: 48,
      })] }],
      audio: [{ track_id: "A1", kind: "audio", role: "dialogue", clips: [clip({
        clip_id: "ACL_HOOK_001",
        role: "dialogue",
      })] }],
    },
    markers: [],
    provenance: {
      compiler_version: "test",
      brief_path: "brief.yaml",
      blueprint_path: "blueprint.yaml",
      selects_path: "selects.yaml",
      ...(withLock ? { hook_lock: withLock } : {}),
    },
  };
}

describe("RFA-003 Shot Anchor resolver", () => {
  it("resolves source evidence, binds the canonical clip, and fingerprints deterministically", () => {
    const bp = blueprint();
    const candidates = [candidate()];
    const first = resolveShotAnchors({
      blueprint: bp,
      candidates,
      sourceIdentities: new Map([[
        "AST_ANON_001",
        { asset_id: "AST_ANON_001", source_content_hash: HASH_A, evidence_source: "provided" },
      ]]),
    });
    const second = resolveShotAnchors({
      blueprint: bp,
      candidates,
      sourceIdentities: { AST_ANON_001: { asset_id: "AST_ANON_001", source_content_hash: HASH_A, evidence_source: "provided" } },
    });

    expect(first).toMatchObject({ policy: "shot-anchor-resolution/v1", anchors: [{
      anchor_id: "anchor-hook-1",
      candidate_ref: "legacy:SEG_ANON_001:1000000:3000000",
      evidence: {
        source_content_hash: HASH_A,
        source_identity: { asset_id: "AST_ANON_001", segment_id: "SEG_ANON_001" },
        evidence_source: "provided",
      },
    }] });
    expect(first?.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first?.fingerprint).toBe(second?.fingerprint);
    expect(bindShotAnchorsToTimeline(first, timeline())).toEqual([{
      anchor: first!.anchors[0],
      clip_id: "CLP_HOOK_001",
      timeline_in_frame: 0,
    }]);
  });

  it("fails closed for missing identity, hash mismatch, range mismatch, and omitted canonical binding", () => {
    const bp = blueprint();
    expect(() => resolveShotAnchors({ blueprint: bp, candidates: [candidate()] }))
      .toThrow(/source identity is missing/);
    expect(() => resolveShotAnchors({
      blueprint: bp,
      candidates: [candidate()],
      sourceIdentities: { AST_ANON_001: { asset_id: "AST_ANON_001", source_content_hash: HASH_B, evidence_source: "assets" } },
    })).toThrow(/source hash mismatch/);
    expect(() => resolveShotAnchors({
      blueprint: blueprint({
        hook_sequence: {
          ...bp.hook_sequence,
          shots: [{
            ...bp.hook_sequence!.shots[0],
            shot_anchor: { ...bp.hook_sequence!.shots[0].shot_anchor!, src_out_us: 4_000_000 },
          }],
        },
      }),
      candidates: [candidate()],
      sourceIdentities: { AST_ANON_001: { asset_id: "AST_ANON_001", source_content_hash: HASH_A, evidence_source: "provided" } },
    })).toThrow(/does not match selects/);
    expect(() => bindShotAnchorsToTimeline(
      resolveShotAnchors({
        blueprint: bp,
        candidates: [candidate()],
        sourceIdentities: { AST_ANON_001: { asset_id: "AST_ANON_001", source_content_hash: HASH_A, evidence_source: "provided" } },
      }),
      timeline(),
    )).not.toThrow();
    expect(() => bindShotAnchorsToTimeline(
      resolveShotAnchors({
        blueprint: bp,
        candidates: [candidate()],
        sourceIdentities: { AST_ANON_001: { asset_id: "AST_ANON_001", source_content_hash: HASH_A, evidence_source: "provided" } },
      }),
      timelineWithClips([]),
    )).toThrow(/not preserved in the canonical timeline/);
  });

  it("keeps v1 compatible without inventing a Hook or anchor", () => {
    const v1 = { ...blueprint(), version: "1", hook_sequence: undefined } as EditBlueprint;
    expect(resolveShotAnchors({ blueprint: v1, candidates: [candidate()] })).toBeUndefined();
    expect(computeHookFingerprint(v1, undefined)).toBeUndefined();
  });
});

describe("RFA-004 Hook lock guard", () => {
  it("creates an explicit lock, preserves its fingerprint, and allows body/marker edits", () => {
    const bp = blueprint();
    const resolution = resolveShotAnchors({
      blueprint: bp,
      candidates: [candidate()],
      sourceIdentities: { AST_ANON_001: { asset_id: "AST_ANON_001", source_content_hash: HASH_A, evidence_source: "provided" } },
    });
    const locked = buildHookLockProvenance({ blueprint: bp, resolution, timeline: timeline() });
    expect(locked).toMatchObject({
      policy: "hook-lock/v1",
      locked: true,
      sequence_id: "hook-anon",
      lock_revision: 3,
      anchor_ids: ["anchor-hook-1"],
      protected_clip_ids: ["ACL_HOOK_001", "CLP_HOOK_001"],
      protected_beat_ids: ["beat-hook"],
      reason: "explicit_blueprint_lock",
    });
    const lockedTimeline = timeline(locked);
    expect(() => assertHookRecompileAllowed(lockedTimeline, locked!.fingerprint)).not.toThrow();
    expect(() => assertHookRecompileAllowed(lockedTimeline, `sha256:${"c".repeat(64)}`)).toThrow(/fingerprint mismatch/);
    expect(() => assertHookPatchOperationAllowed(lockedTimeline, { op: "trim_segment", target_clip_id: "CLP_HOOK_001", reason: "re-edit" })).toThrow(/protected clip/);
    expect(() => assertHookPatchOperationAllowed(lockedTimeline, { op: "trim_segment", target_clip_id: "ACL_HOOK_001", reason: "A1 re-edit" })).toThrow(/protected clip/);
    expect(() => assertHookPatchOperationAllowed(lockedTimeline, { op: "trim_segment", target_clip_id: "CLP_BODY_001", reason: "body re-edit" })).not.toThrow();
    expect(() => assertHookPatchOperationAllowed(lockedTimeline, { op: "add_marker", target_clip_id: "CLP_HOOK_001", reason: "review" })).not.toThrow();
  });

  it("rejects protected patch changes through the real patch applicator and preserves unrelated edits", () => {
    const bp = blueprint();
    const resolution = resolveShotAnchors({
      blueprint: bp,
      candidates: [candidate()],
      sourceIdentities: { AST_ANON_001: { asset_id: "AST_ANON_001", source_content_hash: HASH_A, evidence_source: "provided" } },
    });
    const lock = buildHookLockProvenance({ blueprint: bp, resolution, timeline: timeline() })!;
    const lockedTimeline = timeline(lock);
    const result = applyPatch(lockedTimeline, {
      timeline_version: "1",
      operations: [
        { op: "trim_segment", target_clip_id: "CLP_HOOK_001", new_src_in_us: 1_100_000, new_src_out_us: 2_900_000, reason: "protected attempt" },
        { op: "add_marker", reason: "body review", label: "body marker", beat_id: "beat-body", new_timeline_in_frame: 48 },
      ],
    }, [], undefined, undefined, 24, 1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/Hook is locked/);
    expect(result.appliedOps).toBe(1);
    expect(result.timeline.markers).toEqual([{ frame: 48, kind: "review", label: "body marker" }]);
  });

  it("rejects Studio timeline saves that change protected clips but permits body-only changes", () => {
    const bp = blueprint();
    const resolution = resolveShotAnchors({
      blueprint: bp,
      candidates: [candidate()],
      sourceIdentities: { AST_ANON_001: { asset_id: "AST_ANON_001", source_content_hash: HASH_A, evidence_source: "provided" } },
    });
    const lock = buildHookLockProvenance({ blueprint: bp, resolution, timeline: timeline() })!;
    const current = timeline(lock);
    const changedHook = structuredClone(current);
    changedHook.tracks.video[0].clips[0].src_out_us = 2_900_000;
    expect(() => assertHookTimelineMutationAllowed(current, changedHook)).toThrow(/changed protected clip/);

    const changedBody = structuredClone(current);
    changedBody.tracks.video[0].clips[1].motivation = "body-only Studio edit";
    expect(() => assertHookTimelineMutationAllowed(current, changedBody)).not.toThrow();

    const changedLock = structuredClone(current);
    changedLock.provenance.hook_lock!.protected_clip_ids = ["CLP_HOOK_001"];
    expect(() => assertHookTimelineMutationAllowed(current, changedLock)).toThrow(/authoritative Hook lock projection/);

    const trimmedA1 = structuredClone(current);
    trimmedA1.tracks.audio[0].clips[0].src_out_us = 2_900_000;
    expect(() => assertHookTimelineMutationAllowed(current, trimmedA1)).toThrow(/changed protected clip ACL_HOOK_001/);

    const removedA1 = structuredClone(current);
    removedA1.tracks.audio[0].clips = [];
    expect(() => assertHookTimelineMutationAllowed(current, removedA1)).toThrow(/removed or renamed protected clip ACL_HOOK_001/);
  });

  it("does not lock a v1 timeline", () => {
    const v1 = { ...blueprint(), version: "1", hook_sequence: undefined } as EditBlueprint;
    expect(buildHookLockProvenance({ blueprint: v1, timeline: timeline() })).toBeUndefined();
  });
});

describe("Blueprint v2 anchor sanitizer contract", () => {
  it("reports unknown anchor fields and invalid source evidence ranges", () => {
    const invalid = {
      ...blueprint(),
      hook_sequence: {
        ...blueprint().hook_sequence,
        shots: [{
          shot_id: "shot-hook-1",
          shot_anchor: {
            ...blueprint().hook_sequence!.shots[0].shot_anchor,
            source_end_us: 500_000,
            unsupported: true,
          },
        }],
      },
    };
    expect(() => sanitizeBlueprint(invalid)).toThrow(BlueprintSanitizationError);
    expect(() => sanitizeBlueprint(invalid)).toThrow(/unsupported|within the shot range/);
  });
});

function timelineWithClips(clips: ClipOutput[]): TimelineIR {
  const value = timeline();
  value.tracks.video[0].clips = clips;
  return value;
}

void ShotAnchorResolutionError;
void HookLockViolationError;
