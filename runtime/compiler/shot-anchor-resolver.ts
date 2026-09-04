import { createHash } from "node:crypto";
import type {
  Candidate,
  EditBlueprint,
  ResolvedShotAnchor,
  ShotAnchorResolutionProvenance,
  TimelineIR,
} from "./types.js";
import { getCandidateRef } from "./candidate-ref.js";

const HASH = /^sha256:[0-9a-f]{64}$/;

export interface ShotAnchorSourceIdentity {
  asset_id: string;
  source_content_hash: string;
  source_fingerprint?: string;
  evidence_source: "source_map" | "assets" | "provided";
}

export type ShotAnchorSourceIdentities =
  | ReadonlyMap<string, ShotAnchorSourceIdentity>
  | Record<string, ShotAnchorSourceIdentity>;

export interface ResolveShotAnchorsOptions {
  blueprint: EditBlueprint;
  candidates: Candidate[];
  sourceIdentities?: ShotAnchorSourceIdentities;
}

export interface ShotAnchorBinding {
  anchor: ResolvedShotAnchor;
  clip_id: string;
  timeline_in_frame: number;
}

export class ShotAnchorResolutionError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Shot Anchor resolution failed: ${issues.join("; ")}`);
    this.name = "ShotAnchorResolutionError";
  }
}

/**
 * Resolve explicit Blueprint v2 anchors against the selected source evidence.
 *
 * This function deliberately has no v1 fallback. A v1 blueprint returns
 * undefined so loading or recompiling a legacy project never invents a Hook,
 * an anchor, or a lock.
 */
export function resolveShotAnchors(
  options: ResolveShotAnchorsOptions,
): ShotAnchorResolutionProvenance | undefined {
  if (options.blueprint.version !== "2") return undefined;

  const issues: string[] = [];
  const anchors: ResolvedShotAnchor[] = [];
  const seenAnchorIds = new Set<string>();
  const candidateBySegment = new Map<string, Candidate[]>();
  for (const candidate of options.candidates) {
    const list = candidateBySegment.get(candidate.segment_id) ?? [];
    list.push(candidate);
    candidateBySegment.set(candidate.segment_id, list);
  }

  for (const [sequenceKind, sequence] of [
    ["hook", options.blueprint.hook_sequence ?? options.blueprint.hook],
    ["body", options.blueprint.body_sequence ?? options.blueprint.body],
  ] as const) {
    if (!sequence) continue;
    for (const shot of sequence.shots) {
      const anchor = shot.shot_anchor;
      if (!anchor) continue;
      const location = `${sequenceKind}.${sequence.sequence_id}.${shot.shot_id}`;
      if (seenAnchorIds.has(anchor.anchor_id)) {
        issues.push(`${location}.shot_anchor.anchor_id duplicates ${anchor.anchor_id}`);
      }
      seenAnchorIds.add(anchor.anchor_id);

      const sourceHash = normalizeHash(anchor.source_content_hash);
      if (!sourceHash) {
        issues.push(`${location}.shot_anchor.source_content_hash must be sha256:<64 lowercase hex characters>`);
        continue;
      }
      if (!isSafeRange(anchor.src_in_us, anchor.src_out_us)) {
        issues.push(`${location}.shot_anchor source range must be a non-empty safe integer range`);
        continue;
      }

      const candidates = candidateBySegment.get(anchor.segment_id) ?? [];
      if (candidates.length === 0) {
        issues.push(`${location}.shot_anchor segment_id ${anchor.segment_id} is missing from selects`);
        continue;
      }
      const candidate = candidates.find((item) => item.asset_id === anchor.asset_id);
      if (!candidate) {
        issues.push(`${location}.shot_anchor identity mismatch: segment ${anchor.segment_id} is not asset ${anchor.asset_id}`);
        continue;
      }
      if (candidate.src_in_us !== anchor.src_in_us || candidate.src_out_us !== anchor.src_out_us) {
        issues.push(
          `${location}.shot_anchor source range ${anchor.src_in_us}-${anchor.src_out_us} does not match selects `
          + `${candidate.src_in_us}-${candidate.src_out_us}`,
        );
        continue;
      }

      const identity = sourceIdentityFor(options.sourceIdentities, anchor.asset_id);
      if (!identity) {
        issues.push(`${location}.shot_anchor source identity is missing for asset ${anchor.asset_id}`);
        continue;
      }
      const identityHash = normalizeHash(identity.source_content_hash);
      if (!identityHash) {
        issues.push(`${location}.shot_anchor source identity hash is invalid for asset ${anchor.asset_id}`);
        continue;
      }
      if (identityHash !== sourceHash) {
        issues.push(
          `${location}.shot_anchor source hash mismatch for asset ${anchor.asset_id}: `
          + `expected ${sourceHash}, actual ${identityHash}`,
        );
        continue;
      }
      if (anchor.source_start_us !== undefined || anchor.source_end_us !== undefined) {
        if (
          anchor.source_start_us === undefined ||
          anchor.source_end_us === undefined ||
          !isSafeRange(anchor.source_start_us, anchor.source_end_us) ||
          anchor.source_start_us < anchor.src_in_us ||
          anchor.source_end_us > anchor.src_out_us
        ) {
          issues.push(`${location}.shot_anchor source evidence range is outside the anchor range`);
          continue;
        }
      }

      anchors.push({
        sequence_id: sequence.sequence_id,
        sequence_kind: sequenceKind,
        shot_id: shot.shot_id,
        ...(shot.beat_id ? { beat_id: shot.beat_id } : {}),
        ...(shot.scene_type ? { scene_type: shot.scene_type } : {}),
        anchor_id: anchor.anchor_id,
        asset_id: anchor.asset_id,
        segment_id: anchor.segment_id,
        source_content_hash: sourceHash,
        src_in_us: anchor.src_in_us,
        src_out_us: anchor.src_out_us,
        candidate_ref: getCandidateRef(candidate),
        evidence: {
          source_content_hash: sourceHash,
          source_range: {
            src_in_us: anchor.src_in_us,
            src_out_us: anchor.src_out_us,
          },
          source_identity: {
            asset_id: anchor.asset_id,
            segment_id: anchor.segment_id,
          },
          evidence_source: identity.evidence_source,
        },
      });
    }
  }

  if (issues.length > 0) throw new ShotAnchorResolutionError(issues);

  const normalizedAnchors = anchors.map((anchor) => ({
    ...anchor,
    evidence: {
      ...anchor.evidence,
      source_range: { ...anchor.evidence.source_range },
      source_identity: { ...anchor.evidence.source_identity },
    },
  }));
  return {
    policy: "shot-anchor-resolution/v1",
    fingerprint: fingerprint(normalizedAnchors),
    anchors: normalizedAnchors,
  };
}

/**
 * Bind resolved anchors to the clips actually emitted into timeline.json.
 * A valid source anchor that is silently omitted by assembly is an explicit
 * compile failure, not a degraded success.
 */
export function bindShotAnchorsToTimeline(
  resolution: ShotAnchorResolutionProvenance | undefined,
  timeline: TimelineIR,
): ShotAnchorBinding[] {
  if (!resolution || resolution.anchors.length === 0) return [];
  const clips = timeline.tracks.video.flatMap((track) => track.clips);
  const issues: string[] = [];
  const bindings: ShotAnchorBinding[] = [];
  for (const anchor of resolution.anchors) {
    const candidates = clips
      .filter((clip) =>
        clip.asset_id === anchor.asset_id &&
        clip.segment_id === anchor.segment_id &&
        clip.src_in_us <= anchor.src_in_us &&
        clip.src_out_us >= anchor.src_out_us,
      )
      .sort((left, right) =>
        left.timeline_in_frame - right.timeline_in_frame || left.clip_id.localeCompare(right.clip_id),
      );
    const clip = candidates[0];
    if (!clip) {
      issues.push(
        `anchor ${anchor.anchor_id} was not preserved in the canonical timeline `
        + `(asset=${anchor.asset_id}, segment=${anchor.segment_id}, range=${anchor.src_in_us}-${anchor.src_out_us})`,
      );
      continue;
    }
    bindings.push({ anchor, clip_id: clip.clip_id, timeline_in_frame: clip.timeline_in_frame });
  }
  if (issues.length > 0) throw new ShotAnchorResolutionError(issues);
  return bindings;
}

export function computeHookFingerprint(
  blueprint: EditBlueprint,
  resolution: ShotAnchorResolutionProvenance | undefined,
): string | undefined {
  if (blueprint.version !== "2") return undefined;
  const sequence = blueprint.hook_sequence ?? blueprint.hook;
  if (!sequence) return undefined;
  const byShot = new Map(
    (resolution?.anchors ?? [])
      .filter((anchor) => anchor.sequence_kind === "hook")
      .map((anchor) => [anchor.shot_id, anchor]),
  );
  const shots = sequence.shots.map((shot) => {
    const anchor = shot.shot_anchor ? byShot.get(shot.shot_id) : undefined;
    return {
      shot_id: shot.shot_id,
      ...(shot.beat_id ? { beat_id: shot.beat_id } : {}),
      ...(anchor
        ? {
            identity: anchor.evidence.source_identity,
            source_content_hash: anchor.source_content_hash,
            source_range: anchor.evidence.source_range,
          }
        : { candidate_ref: shot.candidate_ref }),
    };
  });
  return fingerprint({ sequence_id: sequence.sequence_id, shots });
}

export function sourceIdentityFor(
  identities: ShotAnchorSourceIdentities | undefined,
  assetId: string,
): ShotAnchorSourceIdentity | undefined {
  if (!identities) return undefined;
  return identities instanceof Map
    ? identities.get(assetId)
    : (identities as Record<string, ShotAnchorSourceIdentity>)[assetId];
}

function normalizeHash(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  if (HASH.test(trimmed)) return trimmed;
  if (/^[0-9a-f]{64}$/.test(trimmed)) return `sha256:${trimmed}`;
  return undefined;
}

function isSafeRange(start: unknown, end: unknown): start is number {
  return typeof start === "number" && Number.isSafeInteger(start) && start >= 0
    && typeof end === "number" && Number.isSafeInteger(end) && end > start;
}

function fingerprint(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
