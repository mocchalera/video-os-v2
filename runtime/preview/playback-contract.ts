// Playback contract — is the preview manifest still derived from the
// current timeline.json?
//
// The GUI review loop must not present a cut as approval-grade when the
// manifest it plays from no longer matches the timeline on disk
// (editor-preview-render-parity-design.md, success condition 4). The
// compiler stamps `base_timeline_hash` into preview-manifest.json;
// this module re-derives the hash and classifies the contract state.
//
// The Swift studio mirrors this exact computation in
// ProjectPlaybackContractStatusReader — keep the two in sync.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Canonical artifact hash: sha256 of the raw file bytes, first 16 hex
 * chars. Same definition as state/reconcile.computeFileHash.
 */
export function computeFileHash16(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export type PlaybackContractState =
  /** Manifest was generated from the current timeline — approval-grade. */
  | "exact"
  /** Manifest predates the current timeline — playback is approximate. */
  | "stale"
  /** Manifest has no base_timeline_hash (compiled before stamping existed). */
  | "legacy_manifest"
  | "missing_manifest"
  | "missing_timeline";

export interface PlaybackContractStatus {
  state: PlaybackContractState;
  timeline_hash: string | null;
  manifest_base_timeline_hash: string | null;
  /** Human-readable operator guidance. */
  recommendation: string;
}

const RECOMMENDATIONS: Record<PlaybackContractState, string> = {
  exact: "Preview manifest matches the current timeline. Playback is approval-grade.",
  stale: "Timeline changed after the preview manifest was generated. Recompile before approving.",
  legacy_manifest: "Preview manifest predates contract stamping. Recompile to make playback approval-grade.",
  missing_manifest: "No preview manifest. Compile the timeline to generate one.",
  missing_timeline: "No timeline.json. Compile the rough cut first.",
};

export function evaluatePlaybackContract(projectPath: string): PlaybackContractStatus {
  const timelinePath = path.join(projectPath, "05_timeline/timeline.json");
  const manifestPath = path.join(projectPath, "05_timeline/preview-manifest.json");

  const build = (
    state: PlaybackContractState,
    timelineHash: string | null = null,
    manifestHash: string | null = null,
  ): PlaybackContractStatus => ({
    state,
    timeline_hash: timelineHash,
    manifest_base_timeline_hash: manifestHash,
    recommendation: RECOMMENDATIONS[state],
  });

  if (!fs.existsSync(timelinePath)) {
    return build("missing_timeline");
  }
  const timelineHash = computeFileHash16(timelinePath);

  if (!fs.existsSync(manifestPath)) {
    return build("missing_manifest", timelineHash);
  }

  let manifestHash: string | null = null;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as {
      base_timeline_hash?: string;
    };
    manifestHash = manifest.base_timeline_hash ?? null;
  } catch {
    return build("legacy_manifest", timelineHash);
  }

  if (!manifestHash) {
    return build("legacy_manifest", timelineHash);
  }
  return build(
    manifestHash === timelineHash ? "exact" : "stale",
    timelineHash,
    manifestHash,
  );
}
