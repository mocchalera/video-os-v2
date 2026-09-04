import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { validateArtifact } from "../artifacts/loaders.js";
import type { ClipOutput, TimelineIR } from "../compiler/types.js";
import {
  assertSfxAssetSelectable,
  assertSfxScopeAuthority,
  getSfxLibraryHoldReason,
  loadSfxLibraryManifest,
  resolveSfxAssetSource,
  SfxLibraryContractError,
  type SfxLibraryAsset,
  type SfxLibraryManifest,
  type SfxSemanticRole,
} from "./sfx-library.js";
import {
  hashSoundDesignDecision,
  type SoundDesignDecision,
} from "./sound-design-solver.js";

export type {
  SfxLibraryAsset,
  SfxLibraryManifest,
  SfxSemanticRole,
} from "./sfx-library.js";

export function hashFile(filePath: string): string {
  const hash = createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }
  return `sha256:${hash.digest("hex")}`;
}

export interface ResolvedSfxLibrary {
  manifest_path: string;
  manifest_hash: string;
  library_id: string;
  library_version: string;
  scope?: "repo_common" | "project_local";
  manifest: SfxLibraryManifest;
  assets: Map<string, {
    asset: SfxLibraryAsset;
    sourcePath?: string;
  }>;
}

export interface SfxCueAssetPin {
  library_id: string;
  library_version: string;
  library_manifest_hash: string;
  asset_content_hash: string;
  asset_size_bytes: number;
  rights_evidence_ref: string;
  provenance_ref: string;
  asset_path?: string;
  rights_status?: SfxLibraryAsset["rights"]["status"];
  provenance_status?: SfxLibraryAsset["provenance"]["status"];
  review_status?: SfxLibraryAsset["review_status"];
  rights_expires_at?: string | null;
  permitted_derivatives?: string[];
}

export interface SfxCue {
  cue_id: string;
  semantic_role: SfxSemanticRole;
  asset_id: string;
  trigger_frame: number;
  duration_frames: number;
  source_range: { in_us: number; out_us: number };
  gain_db: number;
  fade_in_ms: number;
  fade_out_ms: number;
  tail: {
    max_frames: number;
    policy: "trim_or_pad_to_limit";
  };
  duck_group: "dialogue" | "none";
  ducking: {
    duck_gain_db: number;
    attack_ms: number;
    release_ms: number;
  };
  asset_pin: SfxCueAssetPin;
  intent: string;
  decision_pin?: {
    candidate_id: string;
    decision_hash: string;
    resolved_frame: number;
    semantic_role: SfxSemanticRole;
    asset_id: string;
  };
}

export interface SfxCuesDoc {
  version: "sfx-cues/v1";
  project_id: string;
  base_timeline_version: string;
  timeline_fps: { num: number; den: number };
  required: boolean;
  library: {
    manifest_path: string;
    library_id: string;
    library_version: string;
    manifest_hash: string;
    scope?: "repo_common" | "project_local";
  };
  decision_ref?: {
    path: string;
    content_hash: string;
    decision_hash: string;
    solver_id: "semantic-first-tempo-secondary";
    solver_version: "1.0.0";
  };
  cues: SfxCue[];
}

export interface ResolvedSfxCue {
  cue_id: string;
  semantic_role: SfxSemanticRole;
  asset_id: string;
  source_path: string;
  source_range_us: { in_us: number; out_us: number };
  timeline_range: { in_frame: number; out_frame: number };
  trigger_frame: number;
  duration_frames: number;
  gain_db: number;
  fade_in_ms: number;
  fade_out_ms: number;
  duck_group: "dialogue" | "none";
  ducking: SfxCue["ducking"];
  tail_processing: {
    requested_tail_frames: number;
    applied_tail_frames: number;
    timeline_action: "kept" | "trimmed_to_timeline";
    source_action: "exact" | "trimmed" | "padded";
    render_duration_frames: number;
    render_duration_us: number;
  };
  asset_pin: SfxCueAssetPin & {
    rights_basis: SfxLibraryAsset["rights"]["basis"];
    rights_usage_scope: SfxLibraryAsset["rights"]["usage_scope"];
    provenance_origin: SfxLibraryAsset["provenance"]["origin"];
    generated_at: string | null;
    generation_id?: string | null;
    asset_path?: string;
    rights_status?: SfxLibraryAsset["rights"]["status"];
    provenance_status?: SfxLibraryAsset["provenance"]["status"];
    review_status?: SfxLibraryAsset["review_status"];
    rights_expires_at?: string | null;
    permitted_derivatives?: string[];
  };
  intent: string;
  decision_pin?: NonNullable<SfxCue["decision_pin"]>;
}

export interface ResolvedSfxCuePlan {
  version: "resolved-sfx-cues/v1";
  project_id: string;
  base_timeline_version: string;
  timeline_fps: { num: number; den: number };
  required: boolean;
  cues_path: string;
  cues_content_hash: string;
  library: {
    manifest_path: string;
    manifest_hash: string;
    library_id: string;
    library_version: string;
    scope?: "repo_common" | "project_local";
  };
  decision_ref?: SfxCuesDoc["decision_ref"] & {
    resolved_path: string;
  };
  cues: ResolvedSfxCue[];
}

export interface ResolveSfxCuePlanOptions {
  projectDir: string;
  repoSfxRoot?: string;
  timeline: TimelineIR;
  cuesPath: string;
}

export class SfxCueContractError extends Error {
  constructor(
    readonly code:
      | "SFX_CUE_INVALID"
      | "SFX_LIBRARY_INVALID"
      | "SFX_LIBRARY_MISSING"
      | "SFX_LIBRARY_UNSAFE_PATH"
      | "SFX_LIBRARY_DRIFT"
      | "SFX_LIBRARY_AMBIGUOUS"
      | "SFX_ASSET_MISSING"
      | "SFX_ASSET_UNSELECTABLE"
      | "SFX_RIGHTS_HOLD"
      | "SFX_DECISION_UNSAFE_PATH"
      | "SFX_DECISION_DRIFT",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "SfxCueContractError";
  }
}

function isContained(parentPath: string, childPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative === ""
    || (
      relative !== ".."
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative)
    );
}

function requiredFile(filePath: string, label: string): string {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new SfxCueContractError(
      "SFX_LIBRARY_MISSING",
      `${label} is missing: ${resolved}`,
    );
  }
  return resolved;
}

function timelineTailFrame(timeline: TimelineIR): number {
  return [
    ...timeline.tracks.video,
    ...timeline.tracks.audio.filter((track) => track.track_id !== "A3"),
    ...timeline.tracks.audio
      .filter((track) => track.track_id === "A3")
      .map((track) => ({
        ...track,
        clips: track.clips.filter((clip) => !sfxCueIdFromClip(clip)),
      })),
  ]
    .flatMap((track) => track.clips)
    .reduce(
      (tail, clip) =>
        Math.max(tail, clip.timeline_in_frame + clip.timeline_duration_frames),
      0,
    );
}

function sfxCueIdFromClip(clip: ClipOutput): string | undefined {
  const cue = (clip.metadata as Record<string, unknown> | undefined)?.sfx_cue;
  return cue && typeof cue === "object" && !Array.isArray(cue)
    && typeof (cue as Record<string, unknown>).cue_id === "string"
    ? (cue as Record<string, unknown>).cue_id as string
    : undefined;
}

function hasFormalSfxCue(clip: ClipOutput): boolean {
  return Object.prototype.hasOwnProperty.call(clip.metadata ?? {}, "sfx_cue");
}

function assertEqual(label: string, expected: unknown, actual: unknown): void {
  if (expected !== actual) {
    throw new SfxCueContractError(
      "SFX_LIBRARY_DRIFT",
      `${label} expected=${String(expected)} actual=${String(actual)}`,
    );
  }
}

function assertDecisionEqual(
  label: string,
  expected: unknown,
  actual: unknown,
): void {
  if (expected !== actual) {
    throw new SfxCueContractError(
      "SFX_DECISION_DRIFT",
      `${label} expected=${String(expected)} actual=${String(actual)}`,
    );
  }
}

function resolvePinnedDecision(
  projectDir: string,
  doc: SfxCuesDoc,
  timeline: TimelineIR,
): ResolvedSfxCuePlan["decision_ref"] | undefined {
  const hasCuePins = doc.cues.some((cue) => cue.decision_pin !== undefined);
  if (!doc.decision_ref) {
    if (hasCuePins) {
      throw new SfxCueContractError(
        "SFX_DECISION_DRIFT",
        "SFX cue decision_pin requires a root decision_ref.",
      );
    }
    return undefined;
  }
  if (doc.cues.some((cue) => cue.decision_pin === undefined)) {
    throw new SfxCueContractError(
      "SFX_DECISION_DRIFT",
      "Every cue must carry decision_pin when decision_ref is present.",
    );
  }
  const projectRoot = fs.realpathSync(projectDir);
  const candidate = path.resolve(
    path.isAbsolute(doc.decision_ref.path)
      ? doc.decision_ref.path
      : path.join(projectRoot, doc.decision_ref.path),
  );
  if (!isContained(projectRoot, candidate)) {
    throw new SfxCueContractError(
      "SFX_DECISION_UNSAFE_PATH",
      "sound-design decision must be contained by the project directory.",
    );
  }
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    throw new SfxCueContractError(
      "SFX_DECISION_DRIFT",
      `sound-design decision is missing: ${candidate}`,
    );
  }
  const resolvedPath = fs.realpathSync(candidate);
  if (!isContained(projectRoot, resolvedPath)) {
    throw new SfxCueContractError(
      "SFX_DECISION_UNSAFE_PATH",
      "sound-design decision resolves through a symlink outside the project.",
    );
  }
  assertDecisionEqual(
    "decision_ref.content_hash",
    doc.decision_ref.content_hash,
    hashFile(resolvedPath),
  );
  const decision = validateArtifact<SoundDesignDecision>(
    JSON.parse(fs.readFileSync(resolvedPath, "utf8")),
    "sound-design-decision.schema.json",
  );
  assertDecisionEqual(
    "decision_ref.decision_hash",
    doc.decision_ref.decision_hash,
    decision.decision_hash,
  );
  assertDecisionEqual(
    "decision semantic hash",
    decision.decision_hash,
    hashSoundDesignDecision(decision),
  );
  assertDecisionEqual(
    "decision_ref.solver_id",
    doc.decision_ref.solver_id,
    decision.solver.id,
  );
  assertDecisionEqual(
    "decision_ref.solver_version",
    doc.decision_ref.solver_version,
    decision.solver.version,
  );
  assertDecisionEqual("decision.project_id", timeline.project_id, decision.project_id);
  assertDecisionEqual(
    "decision.base_timeline_version",
    timeline.version,
    decision.base_timeline_version,
  );
  assertDecisionEqual(
    "decision.timeline_fps.num",
    timeline.sequence.fps_num,
    decision.timeline_fps.num,
  );
  assertDecisionEqual(
    "decision.timeline_fps.den",
    timeline.sequence.fps_den,
    decision.timeline_fps.den,
  );

  const adopted = new Map(
    decision.decisions
      .filter((item) => item.status === "adopted")
      .map((item) => [item.candidate_id, item]),
  );
  if (adopted.size !== doc.cues.length) {
    throw new SfxCueContractError(
      "SFX_DECISION_DRIFT",
      `adopted decision count ${adopted.size} does not match cue count ${doc.cues.length}.`,
    );
  }
  const cueCandidates = new Set<string>();
  for (const cue of doc.cues) {
    const pin = cue.decision_pin!;
    if (cueCandidates.has(pin.candidate_id)) {
      throw new SfxCueContractError(
        "SFX_DECISION_DRIFT",
        `decision candidate is projected more than once: ${pin.candidate_id}`,
      );
    }
    cueCandidates.add(pin.candidate_id);
    const item = adopted.get(pin.candidate_id);
    if (!item || item.resolved_frame === null) {
      throw new SfxCueContractError(
        "SFX_DECISION_DRIFT",
        `${pin.candidate_id} is not an adopted sound-design decision.`,
      );
    }
    for (const [label, expected, actual] of [
      ["decision_hash", decision.decision_hash, pin.decision_hash],
      ["resolved_frame", item.resolved_frame, pin.resolved_frame],
      ["cue.trigger_frame", item.resolved_frame, cue.trigger_frame],
      ["semantic_role", item.semantic_role, pin.semantic_role],
      ["cue.semantic_role", item.semantic_role, cue.semantic_role],
      ["asset_id", item.asset_id, pin.asset_id],
      ["cue.asset_id", item.asset_id, cue.asset_id],
    ] as Array<[string, unknown, unknown]>) {
      assertDecisionEqual(`${cue.cue_id}.decision_pin.${label}`, expected, actual);
    }
  }
  return {
    ...doc.decision_ref,
    resolved_path: resolvedPath,
  };
}

export function resolveSfxLibraryPin(
  projectDir: string,
  pin: SfxCuesDoc["library"],
  options: { repoSfxRoot?: string } = {},
): ResolvedSfxLibrary {
  const manifestPath = requiredFile(
    path.isAbsolute(pin.manifest_path)
      ? pin.manifest_path
      : path.resolve(projectDir, pin.manifest_path),
    "SFX library manifest",
  );
  assertEqual("library.manifest_hash", pin.manifest_hash, hashFile(manifestPath));
  let loaded: ReturnType<typeof loadSfxLibraryManifest>;
  try {
    loaded = loadSfxLibraryManifest(manifestPath, { verifyAssets: true });
  } catch (error) {
    if (error instanceof SfxLibraryContractError) {
      throw new SfxCueContractError(error.code, error.message);
    }
    throw error;
  }
  const manifest = loaded.manifest;
  assertEqual("library_id", pin.library_id, manifest.library_id);
  assertEqual("library_version", pin.library_version, manifest.library_version);
  if (!pin.scope) {
    throw new SfxCueContractError("SFX_RIGHTS_HOLD", "library.scope is required for formal SFX selection");
  }
  assertEqual("library.scope", pin.scope, manifest.scope);
  try {
    assertSfxScopeAuthority(loaded, pin.scope, {
      projectRoot: path.resolve(projectDir),
      ...(options.repoSfxRoot ? { repoSfxRoot: options.repoSfxRoot } : {}),
    });
  } catch (error) {
    if (error instanceof SfxLibraryContractError) {
      throw new SfxCueContractError(error.code, error.message);
    }
    throw error;
  }
  const assets: ResolvedSfxLibrary["assets"] = new Map();
  for (const asset of manifest.assets) {
    if (assets.has(asset.asset_id)) {
      throw new SfxCueContractError(
        "SFX_CUE_INVALID",
        `SFX library asset_id must be unique: ${asset.asset_id}`,
      );
    }
    let sourcePath: string | undefined;
    try {
      sourcePath = resolveSfxAssetSource(loaded, asset, { allowMissing: true });
    } catch (error) {
      if (error instanceof SfxLibraryContractError) {
        throw new SfxCueContractError(error.code, error.message);
      }
      throw error;
    }
    assets.set(asset.asset_id, {
      asset,
      ...(sourcePath ? { sourcePath } : {}),
    });
  }
  return {
    manifest_path: manifestPath,
    manifest_hash: pin.manifest_hash,
    library_id: pin.library_id,
    library_version: pin.library_version,
    manifest,
    ...(manifest.scope ? { scope: manifest.scope } : {}),
    assets,
  };
}

function frameDurationUs(
  frames: number,
  fps: { num: number; den: number },
): number {
  return Math.round(frames * 1_000_000 * fps.den / fps.num);
}

export function resolveSfxCuePlan(
  options: ResolveSfxCuePlanOptions,
): ResolvedSfxCuePlan {
  const projectDir = path.resolve(options.projectDir);
  const cuesPath = requiredFile(options.cuesPath, "sfx_cues");
  const doc = validateArtifact<SfxCuesDoc>(
    JSON.parse(fs.readFileSync(cuesPath, "utf8")),
    "sfx-cues.schema.json",
  );
  const timeline = options.timeline;
  if (doc.project_id !== timeline.project_id) {
    throw new SfxCueContractError(
      "SFX_CUE_INVALID",
      "sfx_cues project_id does not match timeline project_id.",
    );
  }
  if (doc.base_timeline_version !== timeline.version) {
    throw new SfxCueContractError(
      "SFX_CUE_INVALID",
      "sfx_cues base_timeline_version is stale.",
    );
  }
  if (
    doc.timeline_fps.num !== timeline.sequence.fps_num
    || doc.timeline_fps.den !== timeline.sequence.fps_den
  ) {
    throw new SfxCueContractError(
      "SFX_CUE_INVALID",
      "sfx_cues rational fps does not match timeline.",
    );
  }
  const decisionRef = resolvePinnedDecision(projectDir, doc, timeline);

  const library = resolveSfxLibraryPin(projectDir, doc.library, { repoSfxRoot: options.repoSfxRoot });
  const assets = library.assets;
  const libraryHold = getSfxLibraryHoldReason(library.manifest);
  if (libraryHold) {
    throw new SfxCueContractError(
      "SFX_RIGHTS_HOLD",
      "SFX library cannot be selected: " + libraryHold,
    );
  }

  const timelineTail = timelineTailFrame(timeline);
  const cueIds = new Set<string>();
  const cues = doc.cues.map((cue): ResolvedSfxCue => {
    if (cueIds.has(cue.cue_id)) {
      throw new SfxCueContractError(
        "SFX_CUE_INVALID",
        `SFX cue_id must be unique: ${cue.cue_id}`,
      );
    }
    cueIds.add(cue.cue_id);
    const resolvedAsset = assets.get(cue.asset_id);
    if (!resolvedAsset) {
      throw new SfxCueContractError(
        "SFX_LIBRARY_MISSING",
        `unknown SFX asset: ${cue.asset_id}`,
      );
    }
    const { asset } = resolvedAsset;
    try {
      assertSfxAssetSelectable(asset, new Date(), "formal_render");
    } catch (error) {
      if (error instanceof SfxLibraryContractError) {
        throw new SfxCueContractError(error.code, error.message);
      }
      throw error;
    }
    const sourcePath = resolvedAsset.sourcePath;
    if (!sourcePath) {
      throw new SfxCueContractError(
        "SFX_ASSET_MISSING",
        "selected SFX asset has no readable local media: " + asset.asset_id,
      );
    }
    if (!asset.semantic_roles.includes(cue.semantic_role)) {
      throw new SfxCueContractError(
        "SFX_CUE_INVALID",
        `${cue.asset_id} does not permit semantic role ${cue.semantic_role}.`,
      );
    }
    if (
      cue.source_range.out_us <= cue.source_range.in_us
      || cue.source_range.out_us > asset.duration_us!
    ) {
      throw new SfxCueContractError(
        "SFX_CUE_INVALID",
        `${cue.cue_id} source range exceeds the verified asset duration.`,
      );
    }
    if (cue.ducking.duck_gain_db > cue.gain_db) {
      throw new SfxCueContractError(
        "SFX_CUE_INVALID",
        `${cue.cue_id} duck_gain_db must be <= gain_db.`,
      );
    }
    const coreOut = cue.trigger_frame + cue.duration_frames;
    if (coreOut > timelineTail) {
      throw new SfxCueContractError(
        "SFX_CUE_INVALID",
        `${cue.cue_id} core duration exceeds the timeline tail.`,
      );
    }
    const requestedOut = coreOut + cue.tail.max_frames;
    const appliedOut = Math.min(requestedOut, timelineTail);
    const appliedTail = appliedOut - coreOut;
    const renderFrames = appliedOut - cue.trigger_frame;
    const renderUs = frameDurationUs(renderFrames, doc.timeline_fps);
    const sourceUs = cue.source_range.out_us - cue.source_range.in_us;
    const sourceAction = sourceUs === renderUs
      ? "exact" as const
      : sourceUs > renderUs
        ? "trimmed" as const
        : "padded" as const;
    const renderMs = renderUs / 1000;
    if (cue.fade_in_ms > renderMs || cue.fade_out_ms > renderMs) {
      throw new SfxCueContractError(
        "SFX_CUE_INVALID",
        `${cue.cue_id} fade exceeds the rendered cue duration.`,
      );
    }
    const pin = cue.asset_pin;
    for (const [label, expected, actual] of [
      ["library_id", doc.library.library_id, pin.library_id],
      ["library_version", doc.library.library_version, pin.library_version],
      ["library_manifest_hash", doc.library.manifest_hash, pin.library_manifest_hash],
      ["asset_content_hash", asset.content_hash, pin.asset_content_hash],
      ["asset_size_bytes", asset.size_bytes, pin.asset_size_bytes],
      ["rights_evidence_ref", asset.rights.evidence_ref, pin.rights_evidence_ref],
      ["provenance_ref", asset.provenance.source_ref, pin.provenance_ref],
      ["asset_path", asset.path, pin.asset_path],
      ["rights_status", asset.rights.status, pin.rights_status],
      ["provenance_status", asset.provenance.status, pin.provenance_status],
      ["review_status", asset.review_status, pin.review_status],
      ["rights_expires_at", asset.rights.expires_at ?? null, pin.rights_expires_at],
      ["permitted_derivatives", asset.rights.permitted_derivatives, pin.permitted_derivatives],
    ] as Array<[string, unknown, unknown]>) {
      if (actual !== undefined) {
        const equal = Array.isArray(expected)
          ? JSON.stringify(expected) === JSON.stringify(actual)
          : expected === actual;
        if (!equal) {
          assertEqual(`${cue.cue_id}.${label}`, expected, actual);
        }
      }
    }
    return {
      cue_id: cue.cue_id,
      semantic_role: cue.semantic_role,
      asset_id: cue.asset_id,
      source_path: sourcePath,
      source_range_us: { ...cue.source_range },
      timeline_range: {
        in_frame: cue.trigger_frame,
        out_frame: appliedOut,
      },
      trigger_frame: cue.trigger_frame,
      duration_frames: cue.duration_frames,
      gain_db: cue.gain_db,
      fade_in_ms: cue.fade_in_ms,
      fade_out_ms: cue.fade_out_ms,
      duck_group: cue.duck_group,
      ducking: { ...cue.ducking },
      tail_processing: {
        requested_tail_frames: cue.tail.max_frames,
        applied_tail_frames: appliedTail,
        timeline_action: appliedOut === requestedOut
          ? "kept"
          : "trimmed_to_timeline",
        source_action: sourceAction,
        render_duration_frames: renderFrames,
        render_duration_us: renderUs,
      },
      asset_pin: {
        ...pin,
        rights_basis: asset.rights.basis,
        rights_usage_scope: asset.rights.usage_scope,
        provenance_origin: asset.provenance.origin,
        generated_at: asset.provenance.generated_at,
        ...(asset.path ? { asset_path: asset.path } : {}),
        rights_status: asset.rights.status,
        ...(asset.provenance.status
          ? { provenance_status: asset.provenance.status }
          : {}),
        ...(asset.review_status ? { review_status: asset.review_status } : {}),
        ...(asset.rights.expires_at !== undefined
          ? { rights_expires_at: asset.rights.expires_at }
          : {}),
        ...(asset.rights.permitted_derivatives
          ? { permitted_derivatives: [...asset.rights.permitted_derivatives] }
          : {}),
        ...(asset.provenance.generation_id !== undefined
          ? { generation_id: asset.provenance.generation_id }
          : {}),
      },
      intent: cue.intent,
      ...(cue.decision_pin
        ? { decision_pin: structuredClone(cue.decision_pin) }
        : {}),
    };
  }).sort((left, right) =>
    left.trigger_frame - right.trigger_frame
    || left.cue_id.localeCompare(right.cue_id, "en")
  );

  return {
    version: "resolved-sfx-cues/v1",
    project_id: doc.project_id,
    base_timeline_version: doc.base_timeline_version,
    timeline_fps: { ...doc.timeline_fps },
    required: doc.required,
    cues_path: cuesPath,
    cues_content_hash: hashFile(cuesPath),
    library: {
      manifest_path: library.manifest_path,
      manifest_hash: doc.library.manifest_hash,
      library_id: doc.library.library_id,
      library_version: doc.library.library_version,
      ...(library.scope ? { scope: library.scope } : {}),
    },
    ...(decisionRef ? { decision_ref: decisionRef } : {}),
    cues,
  };
}

export function projectSfxToTimeline(
  timeline: TimelineIR,
  plan: ResolvedSfxCuePlan,
): TimelineIR {
  if (timeline.project_id !== plan.project_id) {
    throw new SfxCueContractError(
      "SFX_CUE_INVALID",
      "resolved SFX plan project_id does not match timeline.",
    );
  }
  const result = JSON.parse(JSON.stringify(timeline)) as TimelineIR;
  const existingIndex = result.tracks.audio.findIndex(
    (track) => track.track_id === "A3",
  );
  const existing = existingIndex >= 0
    ? result.tracks.audio[existingIndex]
    : undefined;
  const retained = (existing?.clips ?? []).filter(
    (clip) => !hasFormalSfxCue(clip),
  );
  const projected: ClipOutput[] = plan.cues.map((cue) => ({
    clip_id: `A3_${cue.cue_id}`,
    segment_id: cue.cue_id,
    asset_id: cue.asset_id,
    src_in_us: cue.source_range_us.in_us,
    src_out_us: cue.source_range_us.out_us,
    timeline_in_frame: cue.timeline_range.in_frame,
    timeline_duration_frames:
      cue.timeline_range.out_frame - cue.timeline_range.in_frame,
    role: "sfx",
    motivation: cue.intent,
    beat_id: "",
    fallback_segment_ids: [],
    confidence: 1,
    quality_flags: [],
    media_kind: "audio",
    source_capabilities: { has_video: false, has_audio: true },
    audio_role: "sfx",
    metadata: {
      sfx_cue: {
        cue_id: cue.cue_id,
        semantic_role: cue.semantic_role,
        trigger_frame: cue.trigger_frame,
        duration_frames: cue.duration_frames,
        timeline_range: cue.timeline_range,
        source_range_us: cue.source_range_us,
        gain_db: cue.gain_db,
        fade_in_ms: cue.fade_in_ms,
        fade_out_ms: cue.fade_out_ms,
        duck_group: cue.duck_group,
        ducking: cue.ducking,
        tail_processing: cue.tail_processing,
        dialogue_finish_applied: false,
        intent: cue.intent,
        ...(cue.decision_pin
          ? { decision_pin: structuredClone(cue.decision_pin) }
          : {}),
      },
      sfx_asset: {
        asset_id: cue.asset_id,
        source_path: cue.source_path,
        library_id: plan.library.library_id,
        library_version: plan.library.library_version,
        library_manifest_hash: plan.library.manifest_hash,
        ...(plan.library.scope ? { library_scope: plan.library.scope } : {}),
        asset_content_hash: cue.asset_pin.asset_content_hash,
        asset_size_bytes: cue.asset_pin.asset_size_bytes,
        ...(cue.asset_pin.asset_path
          ? { asset_path: cue.asset_pin.asset_path }
          : {}),
        rights_evidence_ref: cue.asset_pin.rights_evidence_ref,
        ...(cue.asset_pin.rights_status
          ? { rights_status: cue.asset_pin.rights_status }
          : {}),
        rights_basis: cue.asset_pin.rights_basis,
        rights_usage_scope: cue.asset_pin.rights_usage_scope,
        provenance_ref: cue.asset_pin.provenance_ref,
        ...(cue.asset_pin.provenance_status
          ? { provenance_status: cue.asset_pin.provenance_status }
          : {}),
        provenance_origin: cue.asset_pin.provenance_origin,
        ...(cue.asset_pin.review_status
          ? { review_status: cue.asset_pin.review_status }
          : {}),
        ...(cue.asset_pin.rights_expires_at !== undefined
          ? { rights_expires_at: cue.asset_pin.rights_expires_at }
          : {}),
        ...(cue.asset_pin.permitted_derivatives
          ? { permitted_derivatives: [...cue.asset_pin.permitted_derivatives] }
          : {}),
        generated_at: cue.asset_pin.generated_at,
        ...(cue.asset_pin.generation_id !== undefined
          ? { generation_id: cue.asset_pin.generation_id }
          : {}),
      },
    },
  }));
  const a3 = {
    ...(existing ?? {}),
    track_id: "A3",
    kind: "audio" as const,
    role: "sfx" as const,
    clips: [...retained, ...projected].sort((left, right) =>
      left.timeline_in_frame - right.timeline_in_frame
      || left.clip_id.localeCompare(right.clip_id, "en")
    ),
  };
  if (existingIndex >= 0) {
    result.tracks.audio[existingIndex] = a3;
  } else {
    result.tracks.audio.push(a3);
  }
  return result;
}
