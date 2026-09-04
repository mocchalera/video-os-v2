/**
 * Orchestrator for the editorial storyboard review projection.
 *
 * Reads canonical artifacts read-only, builds the generic beat model,
 * extracts bounded representative frames with ffmpeg fail-open, computes
 * framing projections per delivery, and writes a deterministic offline
 * HTML projection + manifest + markdown fallback.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { buildBeatModel, timelineSpanFrames } from "./beats.js";
import { computeFramingPlan, resolveCanvas, selectSafeAreaOverlays } from "./framing.js";
import {
  extractFilmstrip,
  extractRepresentativeFrame,
  extractWaveform,
  frameFileName,
  importStillImage,
  probeFrameToolchain,
  probeSourceAspect,
  resolveSourceFilePath,
} from "./frames.js";
import { normalizedJsonHash } from "./hashes.js";
import {
  buildInputRecords,
  loadProjectDeliveryProfiles,
  loadStoryboardArtifacts,
} from "./load.js";
import { buildApprovalIdentity, deliveryIdentityHash, projectionDirPath } from "./manifest.js";
import { renderReviewSummaryMarkdown } from "./markdown.js";
import { renderStoryboardHtml } from "./html.js";
import type {
  FramingPlan,
  LoadedDeliveryProfileInfo,
  ProjectionManifest,
  ResolvedCandidateBinding,
  ResolvedCanvas,
  StoryboardBeat,
} from "./types.js";

export interface GenerateStoryboardOptions {
  projectDir: string;
  sourceMode: "blueprint" | "timeline" | "compare";
  /** Delivery profile id, "all", or null for no delivery profiles. */
  delivery: string | "all" | null;
  outputDir?: string;
  /** Deterministic timestamp override (tests). */
  generatedAt?: string;
  /** Skip all ffmpeg extraction (offline skeleton mode / tests). */
  skipFrames?: boolean;
}

export interface GenerateStoryboardResult {
  projectionId: string;
  projectionDir: string;
  manifest: ProjectionManifest;
  warnings: string[];
}

export class StoryboardGenerateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoryboardGenerateError";
  }
}

const RECEIPT_FILE = "review-receipt.json";

export async function generateEditorialStoryboard(
  options: GenerateStoryboardOptions,
): Promise<GenerateStoryboardResult> {
  const loaded = loadStoryboardArtifacts(options.projectDir, {
    requireTimeline: options.sourceMode !== "blueprint",
  });
  const projectionId = buildProjectionId(loaded, options);

  // ── Delivery scope ─────────────────────────────────────────────
  const { profiles: allProfiles, malformed } = loadProjectDeliveryProfiles(loaded.projectDir);
  const warnings: string[] = malformed.map(
    (entry) => `malformed delivery profile ${entry.path}: ${entry.error}`,
  );

  let selectedProfiles: LoadedDeliveryProfileInfo[] = [];
  let deliveryMode: "single" | "all" = "all";
  if (options.delivery === "all") {
    selectedProfiles = allProfiles;
    deliveryMode = "all";
  } else if (typeof options.delivery === "string") {
    const found = allProfiles.find((profile) => profile.profile_id === options.delivery);
    if (!found) {
      throw new StoryboardGenerateError(
        `Delivery profile "${options.delivery}" not found in 07_package/delivery_profiles; available: ${
          allProfiles.map((profile) => profile.profile_id).join(", ") || "(none)"
        }`,
      );
    }
    selectedProfiles = [found];
    deliveryMode = "single";
  }

  // ── Canvas resolution (never guessed) ──────────────────────────
  // The projection-level canvas reflects the single requested delivery when
  // there is one (including the first profile in "all" mode); per-beat
  // framing plans always carry their own per-delivery canvas.
  const canvas = resolveCanvas({
    profiles: selectedProfiles,
    requestedDeliveryId:
      typeof options.delivery === "string"
        ? options.delivery
        : (selectedProfiles[0]?.profile_id ?? null),
    timeline: loaded.timeline
      ? {
          fps_num: loaded.timeline.sequence.fps_num,
          fps_den: loaded.timeline.sequence.fps_den,
          width: loaded.timeline.sequence.width,
          height: loaded.timeline.sequence.height,
          output_aspect_ratio: loaded.timeline.sequence.output_aspect_ratio,
        }
      : null,
  });
  if (!selectedProfiles.length && !loaded.timeline) {
    warnings.push(
      "no delivery profile and no compiled timeline available; the source aspect is used as-is and no ratio is inferred",
    );
  }

  // ── Beat model ─────────────────────────────────────────────────
  const { beats, unassignedWarnings } = buildBeatModel(loaded, options.sourceMode);

  // ── Frame toolchain + extraction (fail-open) ───────────────────
  const toolchain = options.skipFrames
    ? { ffmpeg: false, ffmpegError: "frame extraction skipped by request (--skip-frames)" }
    : await probeFrameToolchain();
  if (!toolchain.ffmpeg) {
    warnings.push(`ffmpeg unavailable (${toolchain.ffmpegError}); frames are omitted and every affected card carries an explicit warning`);
  }

  const framesDir = path.join("frames");
  const primaryFrameByBeat = new Map<string, string | null>();
  const filmstripFileByBeat = new Map<string, string | null>();
  const waveformFileByBeat = new Map<string, string | null>();
  const fallbackFrameFilesByBeat = new Map<string, Array<{ ref: string; file: string | null }>>();
  const sourceAspectByBeat = new Map<string, number | null>();

  const candidateIndex = null;
  void candidateIndex;

  for (const beat of beats) {
    await populateBeatVisuals({
      beat,
      loaded,
      framesDirName: framesDir,
      outputRoot: options.outputDir ?? projectionDirPath(loaded.projectDir, projectionId),
      skip: options.skipFrames === true || !toolchain.ffmpeg,
      toolchainWarning: toolchain.ffmpeg ? null : `ffmpeg unavailable; no frames extracted`,
      primaryFrameByBeat,
      filmstripFileByBeat,
      waveformFileByBeat,
      fallbackFrameFilesByBeat,
      sourceAspectByBeat,
    });
  }

  // ── Framing plans per beat × delivery ──────────────────────────
  const safeAreaCache = new Map<string, ReturnType<typeof selectSafeAreaOverlays>>();
  const framingByBeat = new Map<string, FramingPlan[]>();
  for (const beat of beats) {
    const sourceAspect = sourceAspectByBeat.get(beat.beat_id) ?? null;
    const authoredCrop = findAuthoredCrop(loaded, beat);
    const plans: FramingPlan[] = [];
    const canvases: Array<{ label: string | null; canvas: ResolvedCanvas }> = [];
    if (selectedProfiles.length > 0) {
      for (const profile of selectedProfiles) {
        canvases.push({ label: profile.profile_id, canvas: resolveCanvasForProfile(profile) });
      }
    } else {
      canvases.push({ label: null, canvas });
    }
    for (const entry of canvases) {
      let plan = computeFramingPlan({ canvas: entry.canvas, sourceAspect, authoredCropRect: authoredCrop });
      plan.primary_frame_relative_path = primaryFrameByBeat.get(beat.beat_id) ?? null;
      const safeKey = entry.label ?? "__none__";
      let safe = safeAreaCache.get(safeKey);
      if (!safe) {
        safe = selectSafeAreaOverlays({
          rootDir: loaded.projectDir,
          delivery: selectedProfiles.find((profile) => profile.profile_id === entry.label) ?? null,
        });
        safeAreaCache.set(safeKey, safe);
      }
      plan.safe_overlays = safe.overlays;
      plan.safe_area_note = safe.note;
      plans.push(plan);
    }
    framingByBeat.set(beat.beat_id, plans);
  }

  // ── Totals ─────────────────────────────────────────────────────
  const totalPlanFrames = beats.reduce((sum, beat) => sum + beat.plan_duration_frames, 0);
  const compiledSpan = loaded.timeline && options.sourceMode !== "blueprint"
    ? timelineSpanFrames(loaded.timeline)
    : null;

  // ── Identity & paths ───────────────────────────────────────────
  const projectionDir = options.outputDir ?? projectionDirPath(loaded.projectDir, projectionId);

  const inputRecords = buildInputRecords(loaded);
  const artifactHashes: Record<string, string | null> = {};
  for (const record of inputRecords) {
    artifactHashes[record.role] = record.hash;
  }
  // Keep multiple policy hashes distinguishable in artifact_hashes.
  const policyEntries = inputRecords.filter((record) => record.role === "policy");
  if (policyEntries.length > 0) {
    artifactHashes.policies = normalizedJsonHash(policyEntries.map((entry) => ({ path: entry.path, hash: entry.hash })));
  }

  const regenerateCommand =
    `npx tsx scripts/render-editorial-storyboard.ts ${path.relative(process.cwd(), loaded.projectDir) || "."}` +
    ` --source ${options.sourceMode} --delivery ${options.delivery ?? "all"}`;

  const representativeFrames = beats.map((beat) => ({
    beat_id: beat.beat_id,
    binding_ref: beat.primary?.ref ?? null,
    timestamp_us: beat.representative.timestamp_us,
    basis: beat.representative.basis,
    asset_id: beat.representative.source_asset_id,
    asset_hash: beat.representative.source_asset_hash,
    frame_file: primaryFrameByBeat.get(beat.beat_id) ?? null,
  }));

  for (const warning of collectGlobalWarnings(beats, unassignedWarnings)) {
    warnings.push(warning);
  }

  const outputs = ["index.html", "manifest.json", "review-summary.md"];
  for (const [beatId, file] of primaryFrameByBeat) {
    if (file) outputs.push(`${framesDir}/${file}`);
    void beatId;
  }
  for (const [, files] of fallbackFrameFilesByBeat) {
    for (const { file } of files) {
      if (file) outputs.push(`${framesDir}/${file}`);
    }
  }
  for (const [, file] of filmstripFileByBeat) {
    if (file) outputs.push(`${framesDir}/${file}`);
  }
  for (const [, file] of waveformFileByBeat) {
    if (file) outputs.push(`${framesDir}/${file}`);
  }

  const invalidMessages = beats.flatMap((beat) =>
    beat.invalid_reasons.map((reason) => `${beat.beat_id}: ${reason}`),
  );
  if (unassignedWarnings.length > 0) {
    invalidMessages.push(
      ...unassignedWarnings.map(
        (warning) => `${warning.clip_id}: ${warning.reason}`,
      ),
    );
  }

  const fpsFromCanvasOrTimeline = loaded.timeline
    ? { num: loaded.timeline.sequence.fps_num, den: loaded.timeline.sequence.fps_den }
    : canvas.fps_num
      ? { num: canvas.fps_num, den: canvas.fps_den ?? 1 }
      : null;

  const reviewDiffSummary = {
    trims: beats.flatMap((beat) => (beat.compiled?.clips ?? [])
      .filter((clip) => clip.head_trim_us !== null || clip.tail_trim_us !== null)
      .map((clip) => `${clip.clip_id}:head_trim_us=${clip.head_trim_us ?? "none"};tail_trim_us=${clip.tail_trim_us ?? "none"}`)),
    crops: [...framingByBeat.entries()].flatMap(([beatId, plans]) => plans
      .filter((plan) => plan.crop_rect !== null)
      .map((plan) => `${beatId}:${plan.canvas.aspect_ratio_label}:${JSON.stringify(plan.crop_rect)}`)),
  };

  const baseManifest: Omit<ProjectionManifest, "approval_identity"> = {
    version: "editorial-storyboard-projection/v1",
    projection_id: projectionId,
    generated_at: options.generatedAt ?? new Date().toISOString(),
    source_mode: options.sourceMode,
    project_id: loaded.blueprint.project_id ?? loaded.brief?.project_id ?? path.basename(loaded.projectDir),
    project_title: loaded.brief?.project?.title ?? null,
    delivery: {
      mode: deliveryMode,
      ids: selectedProfiles.map((profile) => profile.profile_id),
      profiles: selectedProfiles,
    },
    inputs: inputRecords,
    artifact_hashes: artifactHashes,
    review_diff_summary: reviewDiffSummary,
    canvas,
    fps: fpsFromCanvasOrTimeline,
    policy_summaries: {
      music: summarizeMusicPolicy(loaded.blueprint.music_policy),
      dialogue: summarizeDialoguePolicy(loaded.blueprint.dialogue_policy),
      caption: summarizeCaptionPolicy(loaded.blueprint.caption_policy),
    },
    caption_policy_language:
      typeof loaded.blueprint.caption_policy?.language === "string"
        ? loaded.blueprint.caption_policy.language
        : null,
    beat_count: beats.length,
    total_frames: totalPlanFrames,
    total_frames_basis:
      options.sourceMode === "timeline" && compiledSpan !== null ? "timeline_span_frames" : "blueprint_target_frames",
    compiled_span_frames: compiledSpan,
    timeline_end_frame: compiledSpan !== null ? compiledSpan : null,
    representative_frames: representativeFrames,
    warnings,
    invalid: invalidMessages,
    outputs,
    regenerate_command: regenerateCommand,
    generator: "render-editorial-storyboard",
  };

  const manifest: ProjectionManifest = {
    ...baseManifest,
    approval_identity: buildApprovalIdentity(baseManifest),
  };

  // ── Write outputs (preserve any review receipt) ────────────────
  writeProjectionOutputs({
    projectionDir,
    receiptFile: RECEIPT_FILE,
    html: renderStoryboardHtml({
      manifest,
      beats,
      framingByBeat,
      primaryFrameByBeat,
      filmstripFileByBeat,
      waveformFileByBeat,
      fallbackFrameFilesByBeat,
      sourceAspectByBeat,
      unassignedWarnings,
    }),
    markdown: renderReviewSummaryMarkdown({
      manifest,
      beats,
      framingByBeat,
      unassignedWarnings,
      frameFileByBeat: primaryFrameByBeat,
    }),
    manifestJson: `${JSON.stringify(manifest, null, 2)}\n`,
  });

  return { projectionId, projectionDir, manifest, warnings };
}

// ── Output writing ──────────────────────────────────────────────────

interface WriteOutputsArgs {
  projectionDir: string;
  receiptFile: string;
  html: string;
  markdown: string;
  manifestJson: string;
}

/**
 * Replace the projection directory contents with the fresh generation while
 * preserving a human review receipt if one exists (P2 binding target).
 */
function writeProjectionOutputs(args: WriteOutputsArgs): void {
  const { projectionDir } = args;
  fs.mkdirSync(projectionDir, { recursive: true });

  // Stash any existing receipt so regeneration cannot destroy it.
  const receiptAbs = path.join(projectionDir, args.receiptFile);
  let preservedReceipt: Buffer | null = null;
  if (fs.existsSync(receiptAbs)) {
    preservedReceipt = fs.readFileSync(receiptAbs);
  }

  for (const entry of fs.readdirSync(projectionDir)) {
    fs.rmSync(path.join(projectionDir, entry), { recursive: true, force: true });
  }

  fs.writeFileSync(path.join(projectionDir, "index.html"), args.html, "utf-8");
  fs.writeFileSync(path.join(projectionDir, "review-summary.md"), args.markdown, "utf-8");
  fs.writeFileSync(path.join(projectionDir, "manifest.json"), args.manifestJson, "utf-8");
  fs.mkdirSync(path.join(projectionDir, "frames"), { recursive: true });

  if (preservedReceipt) {
    fs.writeFileSync(receiptAbs, preservedReceipt);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function buildProjectionId(
  loaded: ReturnType<typeof loadStoryboardArtifacts>,
  options: GenerateStoryboardOptions,
): string {
  const projectId = sanitizeId(
    loaded.blueprint.project_id ?? loaded.brief?.project?.id ?? path.basename(loaded.projectDir),
  );
  const identity = [
    loaded.briefHash ?? "",
    loaded.selectsHash ?? "",
    loaded.blueprintHash ?? "",
    ...(options.sourceMode !== "blueprint" ? [loaded.timelineHash ?? ""] : []),
  ]
    .join("|");
  const hash8 = normalizedJsonHash(identity).replace(/^sha256:/, "").slice(0, 12);
  const deliveryScope =
    options.delivery === "all" ? "all" : typeof options.delivery === "string" ? `d-${sanitizeId(options.delivery)}` : "source";
  return `sb-${options.sourceMode}-${projectId}-${hash8}-${deliveryScope}`;
}

function sanitizeId(value: string): string {
  return (
    value
      .toLowerCase()
      .normalize("NFKC")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "project"
  );
}

function resolveCanvasForProfile(profile: LoadedDeliveryProfileInfo): ResolvedCanvas {
  const fromRatio =
    profile.aspect_ratio && profile.aspect_ratio !== "custom"
      ? parseRatioLabel(profile.aspect_ratio)
      : null;
  const fromResolution =
    profile.resolution_width && profile.resolution_height
      ? profile.resolution_width / profile.resolution_height
      : null;
  const aspect = fromRatio?.aspect ?? fromResolution ?? null;
  const label = fromRatio?.label ?? (fromResolution ? String(Number(fromResolution.toFixed(4))) : "unspecified");
  const fpsMatch = /^cfr_(\d+(?:\.\d+)?)$/.exec(profile.fps_mode ?? "");
  return {
    aspect_ratio_label: label,
    aspect,
    width: profile.resolution_width,
    height: profile.resolution_height,
    fps_num: fpsMatch ? Number(fpsMatch[1]) : null,
    fps_den: fpsMatch ? 1 : null,
    basis: aspect !== null ? "delivery_profile" : "unspecified",
  };
}

function parseRatioLabel(label: string): { label: string; aspect: number } | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(label);
  if (!match) return null;
  const w = Number(match[1]);
  const h = Number(match[2]);
  if (!(w > 0) || !(h > 0)) return null;
  return { label: `${Number(w.toFixed(6))}:${Number(h.toFixed(6))}`, aspect: w / h };
}

/** Authored crop from blueprint visual_intents targeting this beat's clip/candidate. */
function findAuthoredCrop(
  loaded: ReturnType<typeof loadStoryboardArtifacts>,
  beat: StoryboardBeat,
): { x: number; y: number; width: number; height: number } | null {
  const intents = loaded.blueprint.visual_intents ?? [];
  const segmentId = beat.primary?.segment_id;
  for (const intent of intents) {
    const target = intent.target as { candidate_ref?: string; segment_id?: string; clip_id?: string } | undefined;
    const transform = intent.transform as
      | { crop?: { x: number; y: number; width: number; height: number } }
      | undefined;
    const crop = transform?.crop;
    if (!crop || !target) continue;
    const matches =
      (segmentId && target.segment_id === segmentId) ||
      (target.candidate_ref && beat.primary?.ref === target.candidate_ref);
    if (matches) return crop;
  }
  return null;
}

interface PopulateArgs {
  beat: StoryboardBeat;
  loaded: ReturnType<typeof loadStoryboardArtifacts>;
  framesDirName: string;
  outputRoot: string;
  skip: boolean;
  toolchainWarning: string | null;
  primaryFrameByBeat: Map<string, string | null>;
  filmstripFileByBeat: Map<string, string | null>;
  waveformFileByBeat: Map<string, string | null>;
  fallbackFrameFilesByBeat: Map<string, Array<{ ref: string; file: string | null }>>;
  sourceAspectByBeat: Map<string, number | null>;
}

async function populateBeatVisuals(args: PopulateArgs): Promise<void> {
  const { beat } = args;
  beat.index = beat.index;
  const framesOutDir = path.join(args.outputRoot, args.framesDirName);
  fs.mkdirSync(framesOutDir, { recursive: true });

  const primary = beat.primary;
  if (!primary || !primary.resolved) {
    args.primaryFrameByBeat.set(beat.beat_id, null);
    args.sourceAspectByBeat.set(beat.beat_id, null);
    return;
  }

  const entry = args.loaded.sourceMapEntries.get(primary.asset_id ?? "");
  const sourcePath = resolveSourceFilePath({
    sourceMapEntry: entry ? { local_source_path: entry.local_source_path, exists: entry.exists } : undefined,
  });
  const sourceInfo = args.skip
    ? { aspect: null as number | null, note: null as string | null }
    : await probeSourceAspect(sourcePath);
  args.sourceAspectByBeat.set(beat.beat_id, sourceInfo.aspect);
  if (sourceInfo.note) {
    beat.warnings.push(`source visual probe: ${sourceInfo.note}`);
  }

  if (args.skip) {
    args.primaryFrameByBeat.set(beat.beat_id, null);
    if (args.toolchainWarning) beat.warnings.push(args.toolchainWarning);
    return;
  }

  const mediaKind = primary.media_kind;
  const outPrimary = path.join(framesOutDir, frameFileName(beat.index, "primary", 0));

  if (mediaKind === "image") {
    if (sourcePath) {
      const still = await importStillImage({ sourcePath, outputPath: outPrimary });
      applyResult(args, beat, "primary", still.warning, () => args.primaryFrameByBeat.set(beat.beat_id, still.file));
    } else {
      args.primaryFrameByBeat.set(beat.beat_id, null);
      beat.warnings.push("still image asset is missing on disk; representative image cannot be embedded");
    }
    return;
  }

  if (mediaKind === "audio") {
    if (sourcePath) {
      const waveform = await extractWaveform({
        sourcePath,
        srcInUs: primary.src_in_us,
        srcOutUs: primary.src_out_us,
        outputPath: path.join(framesOutDir, frameFileName(beat.index, "waveform", 0)),
      });
      applyResult(args, beat, "waveform", waveform.warning, () => waveformFileByBeatSet(args, beat.beat_id, waveform.file));
    } else {
      args.waveformFileByBeat.set(beat.beat_id, null);
      beat.warnings.push("audio asset is missing on disk; waveform cannot be rendered — transcript representation is shown instead");
    }
    args.primaryFrameByBeat.set(beat.beat_id, null);
    return;
  }

  // video / sequence / unknown-with-video
  if (!sourcePath || beat.representative.timestamp_us === null) {
    args.primaryFrameByBeat.set(beat.beat_id, null);
    beat.warnings.push(
      !sourcePath
        ? "representative frame unavailable: source file missing"
        : "representative frame unavailable: no deterministic timestamp could be derived",
    );
  } else {
    const frame = await extractRepresentativeFrame({
      sourcePath,
      timestampUs: beat.representative.timestamp_us,
      outputPath: outPrimary,
    });
    applyResult(args, beat, "primary", frame.warning, () => args.primaryFrameByBeat.set(beat.beat_id, frame.file));
    if (frame.file && primary.src_in_us !== null && primary.src_out_us !== null) {
      const strip = await extractFilmstrip({
        sourcePath,
        srcInUs: primary.src_in_us,
        srcOutUs: primary.src_out_us,
        outputPath: path.join(framesOutDir, `beat-${String(beat.index).padStart(2, "0")}-filmstrip.webp`),
      });
      applyResult(args, beat, "filmstrip", strip.warning, () => args.filmstripFileByBeat.set(beat.beat_id, strip.file));
    }
  }

  // Fallback comparison frames
  const fallbackFiles: Array<{ ref: string; file: string | null }> = [];
  for (let i = 0; i < beat.fallbacks.length; i += 1) {
    const fallback = beat.fallbacks[i];
    if (!fallback.resolved) {
      fallbackFiles.push({ ref: fallback.ref, file: null });
      continue;
    }
    const fallbackEntry = args.loaded.sourceMapEntries.get(fallback.asset_id ?? "");
    const fallbackPath = resolveSourceFilePath({
      sourceMapEntry: fallbackEntry ? { local_source_path: fallbackEntry.local_source_path, exists: fallbackEntry.exists } : undefined,
    });
    if (!fallbackPath || fallback.media_kind === "image" || fallback.media_kind === "audio") {
      fallbackFiles.push({ ref: fallback.ref, file: null });
      continue;
    }
    const fallbackPlan = selectFallbackTimestamp(fallback);
    if (fallbackPlan.timestamp_us === null) {
      fallbackFiles.push({ ref: fallback.ref, file: null });
      continue;
    }
    const shot = await extractRepresentativeFrame({
      sourcePath: fallbackPath,
      timestampUs: fallbackPlan.timestamp_us,
      outputPath: path.join(framesOutDir, frameFileName(beat.index, "fallback", i + 1)),
    });
    fallbackFiles.push({ ref: fallback.ref, file: shot.file });
    if (shot.warning) beat.warnings.push(`fallback ${fallback.ref}: ${shot.warning}`);
  }
  args.fallbackFrameFilesByBeat.set(beat.beat_id, fallbackFiles);
}

function selectFallbackTimestamp(
  binding: ResolvedCandidateBinding | null,
): { timestamp_us: number | null } {
  if (!binding || !binding.resolved) return { timestamp_us: null };
  if (binding.trim_hint?.source_center_us != null) return { timestamp_us: binding.trim_hint.source_center_us };
  if (binding.src_in_us !== null && binding.src_out_us !== null) {
    return { timestamp_us: Math.round((binding.src_in_us + binding.src_out_us) / 2) };
  }
  return { timestamp_us: null };
}

function waveformFileByBeatSet(args: PopulateArgs, beatId: string, file: string | null): void {
  args.waveformFileByBeat.set(beatId, file);
}

function applyResult(
  args: PopulateArgs,
  beat: StoryboardBeat,
  kind: "primary" | "filmstrip" | "waveform",
  warning: string | null,
  apply: () => void,
): void {
  if (warning) {
    beat.warnings.push(warning);
    return;
  }
  apply();
  void kind;
  void args;
}

function collectGlobalWarnings(
  beats: StoryboardBeat[],
  unassigned: Array<{ clip_id: string; reason: string }>,
): string[] {
  const warnings: string[] = [];
  for (const beat of beats) {
    if (beat.invalid_reasons.length > 0) {
      warnings.push(`INVALID: ${beat.beat_id} has unresolved candidate references; approval is blocked`);
    }
  }
  for (const entry of unassigned) {
    warnings.push(`compiled clip ${entry.clip_id} could not be matched to a blueprint beat: ${entry.reason}`);
  }
  return warnings;
}

function summarizeMusicPolicy(policy: Record<string, unknown> | undefined): string {
  if (!policy) return "";
  const parts: string[] = [];
  if (policy.start_sparse === true) parts.push("sparse start");
  if (policy.allow_release_late === true) parts.push("late release allowed");
  if (policy.avoid_anthemic_lift === true) parts.push("no anthemic lift");
  if (typeof policy.entry_beat === "string") parts.push(`entry at ${policy.entry_beat}`);
  if (typeof policy.permitted_energy_curve === "string") parts.push(String(policy.permitted_energy_curve));
  return parts.join(", ");
}

function summarizeDialoguePolicy(policy: Record<string, unknown> | undefined): string {
  if (!policy) return "";
  const parts: string[] = [];
  if (policy.preserve_natural_breath === true) parts.push("natural breath preserved");
  if (policy.avoid_wall_to_wall_voiceover === true) parts.push("no wall-to-wall VO");
  if (Array.isArray(policy.prioritize_lines) && policy.prioritize_lines.length > 0) {
    parts.push(`${policy.prioritize_lines.length} priority line(s)`);
  }
  return parts.join(", ");
}

function summarizeCaptionPolicy(policy: Record<string, unknown> | undefined): string {
  if (!policy) return "";
  const parts: string[] = [];
  if (typeof policy.language === "string") parts.push(policy.language);
  if (typeof policy.delivery_mode === "string") parts.push(String(policy.delivery_mode));
  if (typeof policy.styling_class === "string") parts.push(String(policy.styling_class));
  return parts.join(", ");
}
