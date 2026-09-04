import { createHash } from "node:crypto";
import { validateArtifact } from "../artifacts/loaders.js";
import { canonicalJson } from "../visual/framing-policy.js";

export const SUBJECT_OCCUPANCY_TRACK_VERSION =
  "subject-occupancy-track/v1" as const;

export interface SubjectOccupancyTrack {
  version: typeof SUBJECT_OCCUPANCY_TRACK_VERSION;
  generation_id: string;
  source_identity: {
    asset_id: string;
    segment_id: string;
    source_content_hash: string;
    source_range: { src_in_us: number; src_out_us: number };
  };
  source_av_geometry: {
    video: { width: number; height: number; fps_num: number; fps_den: number };
    audio: { sample_rate: number; channels: number };
  };
  provenance: {
    source: "manual_annotation" | "analyzer";
    producer: string;
    producer_version: string;
    confidence: number;
  };
  coverage: { start_frame: number; end_frame: number };
  tracks: SubjectOccupancySubjectTrack[];
}

export interface SubjectOccupancySubjectTrack {
  track_id: string;
  subject_id: string;
  /** This stable label joins samples only; it never identifies a person. */
  identity_scope: "track_only_not_person_identity";
  motion: "static" | "moving";
  confidence: number;
  samples: Array<{
    start_frame: number;
    end_frame: number;
    bounds: { x: number; y: number; width: number; height: number };
    evidence_roles: Array<"first" | "representative" | "last">;
  }>;
}

export class SubjectOccupancyTrackError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Subject occupancy track is invalid: ${issues.join("; ")}`);
    this.name = "SubjectOccupancyTrackError";
  }
}

export function parseSubjectOccupancyTrack(
  input: unknown,
): SubjectOccupancyTrack {
  let track: SubjectOccupancyTrack;
  try {
    track = structuredClone(validateArtifact<SubjectOccupancyTrack>(
      input,
      "subject-occupancy-track.schema.json",
    ));
  } catch (error) {
    throw new SubjectOccupancyTrackError([
      error instanceof Error ? error.message : String(error),
    ]);
  }
  const issues: string[] = [];
  if (track.source_identity.source_range.src_out_us <=
    track.source_identity.source_range.src_in_us) {
    issues.push("source_range.src_out_us must be greater than src_in_us");
  }
  if (track.coverage.end_frame <= track.coverage.start_frame) {
    issues.push("coverage.end_frame must be greater than start_frame");
  }
  const ids = new Set<string>();
  for (const subject of track.tracks) {
    if (ids.has(subject.track_id)) {
      issues.push(`track_id is duplicated: ${subject.track_id}`);
    }
    ids.add(subject.track_id);
    const roles = new Set<string>();
    let previousEnd = track.coverage.start_frame;
    for (const sample of subject.samples) {
      if (sample.end_frame <= sample.start_frame) {
        issues.push(`${subject.track_id} has an empty or reversed frame range`);
      }
      if (sample.start_frame < track.coverage.start_frame ||
        sample.end_frame > track.coverage.end_frame) {
        issues.push(`${subject.track_id} sample exceeds declared coverage`);
      }
      if (sample.start_frame < previousEnd) {
        issues.push(`${subject.track_id} samples overlap or are unsorted`);
      }
      previousEnd = sample.end_frame;
      if (sample.bounds.x + sample.bounds.width > 1 ||
        sample.bounds.y + sample.bounds.height > 1) {
        issues.push(`${subject.track_id} normalized bounds overflow the frame`);
      }
      for (const role of sample.evidence_roles) roles.add(role);
    }
    for (const role of ["first", "representative", "last"] as const) {
      if (!roles.has(role)) issues.push(`${subject.track_id} is missing ${role} evidence`);
    }
    if (subject.motion === "static") {
      const first = canonicalJson(subject.samples[0]?.bounds);
      if (subject.samples.some((sample) => canonicalJson(sample.bounds) !== first)) {
        issues.push(`${subject.track_id} declares static motion with changing bounds`);
      }
    }
  }
  if (issues.length > 0) throw new SubjectOccupancyTrackError(issues);
  return track;
}

/**
 * Hashes evidence content without its final generation binding. The payload
 * hash may therefore participate in generation derivation without a circular
 * self-hash; the full artifact is subsequently required to name that exact
 * generation and is hash-bound in the review receipt.
 */
export function subjectOccupancyPayloadHash(
  track: SubjectOccupancyTrack,
): string {
  const payload = structuredClone(track) as Partial<SubjectOccupancyTrack>;
  delete payload.generation_id;
  return `sha256:${createHash("sha256").update(canonicalJson(payload)).digest("hex")}`;
}

export function subjectOccupancyArtifactHash(
  track: SubjectOccupancyTrack,
): string {
  return `sha256:${createHash("sha256").update(canonicalJson(track)).digest("hex")}`;
}
