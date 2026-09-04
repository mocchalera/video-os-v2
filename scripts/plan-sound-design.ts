#!/usr/bin/env npx tsx

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { validateArtifact } from "../runtime/artifacts/loaders.js";
import type { TimelineIR } from "../runtime/compiler/types.js";
import {
  assertSfxAssetSelectable,
  getSfxLibraryHoldReason,
} from "../runtime/audio/sfx-library.js";
import {
  hashFile,
  resolveSfxLibraryPin,
  type SfxCuesDoc,
} from "../runtime/audio/sfx-cues.js";
import {
  planSoundDesign,
  projectSoundDesignDecisionToSfxCues,
  type SoundDesignDecision,
  type SoundDesignRequest,
} from "../runtime/audio/sound-design-solver.js";

export interface PlanSoundDesignArgs {
  projectDir: string;
  repoSfxRoot?: string;
  timelinePath: string;
  requestPath: string;
  decisionOutputPath: string;
  cuesOutputPath: string;
  dryRun: boolean;
}

const USAGE = `Usage:
  npm run sound-design:plan -- --project <dir> --timeline <timeline.json> --request <sound-design-request.json> --decision-output <new-decision.json> --cues-output <new-sfx-cues.json> [--repo-sfx-root <repo/resources/sfx>] [--dry-run] [--help]

Validates project/timeline identity, SFX rights/provenance and content pins,
then runs the semantic-first, tempo-secondary solver and projects only adopted
decisions into formal A3 SFX cues. --dry-run writes nothing. Output paths must
be new, distinct files contained by the project; existing files are never
overwritten. Beat frames are consumed only from verified analysis evidence.`;

function required(values: string[], index: number, flag: string): string {
  const value = values[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parsePlanSoundDesignArgs(
  argv: string[],
): PlanSoundDesignArgs {
  const values = argv.slice(2);
  let projectDir: string | undefined;
  let repoSfxRoot: string | undefined;
  let timelinePath: string | undefined;
  let requestPath: string | undefined;
  let decisionOutputPath: string | undefined;
  let cuesOutputPath: string | undefined;
  let dryRun = false;
  for (let index = 0; index < values.length; index += 1) {
    const arg = values[index];
    if (arg === "--help" || arg === "-h") throw new Error(USAGE);
    if (arg === "--project") projectDir = required(values, ++index, arg);
    else if (arg === "--repo-sfx-root") repoSfxRoot = required(values, ++index, arg);
    else if (arg === "--timeline") timelinePath = required(values, ++index, arg);
    else if (arg === "--request") requestPath = required(values, ++index, arg);
    else if (arg === "--decision-output") {
      decisionOutputPath = required(values, ++index, arg);
    } else if (arg === "--cues-output") {
      cuesOutputPath = required(values, ++index, arg);
    } else if (arg === "--dry-run") dryRun = true;
    else throw new Error(`Unknown argument: ${arg}\n${USAGE}`);
  }
  if (
    !projectDir
    || !timelinePath
    || !requestPath
    || !decisionOutputPath
    || !cuesOutputPath
  ) {
    throw new Error(USAGE);
  }
  return {
    projectDir: path.resolve(projectDir),
    ...(repoSfxRoot ? { repoSfxRoot: path.resolve(repoSfxRoot) } : {}),
    timelinePath: path.resolve(timelinePath),
    requestPath: path.resolve(requestPath),
    decisionOutputPath: path.resolve(decisionOutputPath),
    cuesOutputPath: path.resolve(cuesOutputPath),
    dryRun,
  };
}

function isContained(parentPath: string, childPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function assertInputFile(filePath: string, label: string): void {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`${label} is missing: ${filePath}`);
  }
}

function assertNewSafeOutputs(args: PlanSoundDesignArgs): void {
  const projectRoot = path.resolve(args.projectDir);
  const realProjectRoot = fs.realpathSync(projectRoot);
  for (const [label, outputPath] of [
    ["decision output", args.decisionOutputPath],
    ["SFX cues output", args.cuesOutputPath],
  ] as const) {
    if (!isContained(projectRoot, outputPath)) {
      throw new Error(`${label} must be contained by the project directory`);
    }
    let existingAncestor = path.dirname(outputPath);
    while (!fs.existsSync(existingAncestor)) {
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) break;
      existingAncestor = parent;
    }
    const realAncestor = fs.realpathSync(existingAncestor);
    const ancestorRelative = path.relative(realProjectRoot, realAncestor);
    if (
      ancestorRelative === ".."
      || ancestorRelative.startsWith(`..${path.sep}`)
      || path.isAbsolute(ancestorRelative)
    ) {
      throw new Error(`${label} resolves outside the project directory`);
    }
    if (fs.existsSync(outputPath)) {
      throw new Error(`${label} already exists; refusing to overwrite: ${outputPath}`);
    }
  }
  if (args.decisionOutputPath === args.cuesOutputPath) {
    throw new Error("decision and SFX cue outputs must be distinct files");
  }
}

function timelineDurationFrames(timeline: TimelineIR): number {
  return [...timeline.tracks.video, ...timeline.tracks.audio]
    .flatMap((track) => track.clips)
    .reduce(
      (tail, clip) =>
        Math.max(tail, clip.timeline_in_frame + clip.timeline_duration_frames),
      0,
    );
}

function assertEqual(label: string, expected: unknown, actual: unknown): void {
  if (expected !== actual) {
    throw new Error(
      `${label} drift expected=${String(expected)} actual=${String(actual)}`,
    );
  }
}

function validateRequestPins(
  args: PlanSoundDesignArgs,
  request: SoundDesignRequest,
  timeline: TimelineIR,
): void {
  assertEqual("project_id", timeline.project_id, request.project_id);
  assertEqual(
    "base_timeline_version",
    timeline.version,
    request.base_timeline_version,
  );
  assertEqual("timeline_fps.num", timeline.sequence.fps_num, request.timeline_fps.num);
  assertEqual("timeline_fps.den", timeline.sequence.fps_den, request.timeline_fps.den);
  assertEqual(
    "timeline_duration_frames",
    timelineDurationFrames(timeline),
    request.timeline_duration_frames,
  );
  assertEqual("timeline_ref.path", args.timelinePath, path.resolve(
    path.isAbsolute(request.timeline_ref.path)
      ? request.timeline_ref.path
      : path.join(args.projectDir, request.timeline_ref.path),
  ));
  assertEqual(
    "timeline_ref.content_hash",
    hashFile(args.timelinePath),
    request.timeline_ref.content_hash,
  );

  const library = resolveSfxLibraryPin(args.projectDir, request.library, { repoSfxRoot: args.repoSfxRoot });
  const libraryHold = getSfxLibraryHoldReason(library.manifest);
  if (libraryHold) throw new Error(`SFX library cannot be selected: ${libraryHold}`);
  if (request.library.scope !== undefined && request.library.scope !== library.scope) {
    throw new Error("sound-design request library scope does not match the manifest");
  }
  for (const candidate of request.candidates) {
    const resolved = library.assets.get(candidate.asset_id);
    if (!resolved) {
      throw new Error(
        `${candidate.candidate_id} references unknown SFX asset ${candidate.asset_id}`,
      );
    }
    const { asset } = resolved;
    try {
      assertSfxAssetSelectable(asset, new Date(), "formal_render");
    } catch (error) {
      throw new Error(
        `${candidate.candidate_id} cannot select SFX asset: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!asset.semantic_roles.includes(candidate.semantic_role)) {
      throw new Error(
        `${candidate.asset_id} does not permit ${candidate.semantic_role}`,
      );
    }
    for (const [label, expected, actual] of [
      ["library_id", library.library_id, candidate.asset_pin.library_id],
      ["library_version", library.library_version, candidate.asset_pin.library_version],
      [
        "library_manifest_hash",
        library.manifest_hash,
        candidate.asset_pin.library_manifest_hash,
      ],
      ["asset_content_hash", asset.content_hash, candidate.asset_pin.asset_content_hash],
      ["asset_size_bytes", asset.size_bytes, candidate.asset_pin.asset_size_bytes],
      [
        "rights_evidence_ref",
        asset.rights.evidence_ref,
        candidate.asset_pin.rights_evidence_ref,
      ],
      [
        "provenance_ref",
        asset.provenance.source_ref,
        candidate.asset_pin.provenance_ref,
      ],
      ["asset_path", asset.path, candidate.asset_pin.asset_path],
      ["rights_status", asset.rights.status, candidate.asset_pin.rights_status],
      ["provenance_status", asset.provenance.status, candidate.asset_pin.provenance_status],
      ["review_status", asset.review_status, candidate.asset_pin.review_status],
      ["rights_expires_at", asset.rights.expires_at, candidate.asset_pin.rights_expires_at],
      ["permitted_derivatives", asset.rights.permitted_derivatives, candidate.asset_pin.permitted_derivatives],
    ] as Array<[string, unknown, unknown]>) {
      if (actual === undefined) continue;
      const equal = Array.isArray(expected)
        ? JSON.stringify(expected) === JSON.stringify(actual)
        : expected === actual;
      if (!equal) assertEqual(`${candidate.candidate_id}.${label}`, expected, actual);
    }
    if (
      candidate.audio.source_range.out_us
        <= candidate.audio.source_range.in_us
        || candidate.audio.source_range.out_us > asset.duration_us!
    ) {
      throw new Error(
        `${candidate.candidate_id} source range exceeds the pinned SFX asset`,
      );
    }
    if (candidate.audio.ducking.duck_gain_db > candidate.audio.gain_db) {
      throw new Error(
        `${candidate.candidate_id} duck_gain_db must be <= gain_db`,
      );
    }
  }

  const beat = request.beat_evidence;
  if (beat.analysis_path !== null || beat.content_hash !== null) {
    if (!beat.analysis_path || !beat.content_hash) {
      throw new Error("beat analysis path and content hash must be pinned together");
    }
    const analysisPath = path.resolve(
      path.isAbsolute(beat.analysis_path)
        ? beat.analysis_path
        : path.join(args.projectDir, beat.analysis_path),
    );
    assertInputFile(analysisPath, "beat analysis");
    assertEqual(
      "beat_evidence.content_hash",
      hashFile(analysisPath),
      beat.content_hash,
    );
  }
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function relativeProjectPath(projectDir: string, filePath: string): string {
  return path.relative(projectDir, filePath).split(path.sep).join("/");
}

export function runPlanSoundDesign(
  args: PlanSoundDesignArgs,
): Record<string, unknown> {
  assertInputFile(args.timelinePath, "timeline");
  assertInputFile(args.requestPath, "sound-design request");
  assertNewSafeOutputs(args);
  const timeline = validateArtifact<TimelineIR>(
    JSON.parse(fs.readFileSync(args.timelinePath, "utf8")),
    "timeline-ir.schema.json",
  );
  const request = validateArtifact<SoundDesignRequest>(
    JSON.parse(fs.readFileSync(args.requestPath, "utf8")),
    "sound-design-request.schema.json",
  );
  validateRequestPins(args, request, timeline);
  const decision = validateArtifact<SoundDesignDecision>(
    planSoundDesign(request),
    "sound-design-decision.schema.json",
  );
  const decisionContent = serialize(decision);
  const decisionContentHash = hashFileFromBytes(decisionContent);
  const cues = validateArtifact<SfxCuesDoc>(
    projectSoundDesignDecisionToSfxCues(request, decision, {
      path: relativeProjectPath(args.projectDir, args.decisionOutputPath),
      content_hash: decisionContentHash,
    }),
    "sfx-cues.schema.json",
  );
  const cuesContent = serialize(cues);
  const result = {
    version: "plan-sound-design/v1",
    dry_run: args.dryRun,
    project_id: request.project_id,
    request_file_hash: hashFile(args.requestPath),
    request_semantic_hash: decision.input_hashes.request,
    decision_hash: decision.decision_hash,
    decision_content_hash: decisionContentHash,
    beat_evidence: decision.beat_evidence,
    adopted: decision.decisions
      .filter((item) => item.status === "adopted")
      .map((item) => ({
        candidate_id: item.candidate_id,
        resolved_frame: item.resolved_frame,
        snap: item.snap,
      })),
    rejected: decision.decisions
      .filter((item) => item.status === "rejected")
      .map((item) => ({
        candidate_id: item.candidate_id,
        reasons: item.reasons,
        conflicts: item.conflicts,
      })),
    cue_ids: cues.cues.map((cue) => cue.cue_id),
    wrote_files: !args.dryRun,
    decision: args.dryRun ? decision : undefined,
    sfx_cues: args.dryRun ? cues : undefined,
  };
  if (args.dryRun) return result;

  fs.mkdirSync(path.dirname(args.decisionOutputPath), { recursive: true });
  fs.mkdirSync(path.dirname(args.cuesOutputPath), { recursive: true });
  let decisionWritten = false;
  try {
    fs.writeFileSync(args.decisionOutputPath, decisionContent, {
      encoding: "utf8",
      flag: "wx",
    });
    decisionWritten = true;
    fs.writeFileSync(args.cuesOutputPath, cuesContent, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    if (decisionWritten && !fs.existsSync(args.cuesOutputPath)) {
      fs.unlinkSync(args.decisionOutputPath);
    }
    throw error;
  }
  return {
    ...result,
    decision_output_path: args.decisionOutputPath,
    sfx_cues_output_path: args.cuesOutputPath,
  };
}

function hashFileFromBytes(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function main(): Promise<void> {
  try {
    const result = runPlanSoundDesign(parsePlanSoundDesignArgs(process.argv));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (isMain) void main();
