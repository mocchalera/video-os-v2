#!/usr/bin/env npx tsx

import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import {
  ASS_HEAVY_VIDEO_FONT,
} from "../editor/shared/font-contract.js";
import { readProjectCaptionStylingClass } from "../editor/shared/project-caption-settings.js";
import { validateArtifact } from "../runtime/artifacts/loaders.js";
import { executeAudioRenderPlan } from "../runtime/audio/render-executor.js";
import { resolveSharedAudioRenderPlan } from "../runtime/audio/render-route.js";
import { DEFAULT_MASTERING } from "../runtime/audio/mastering.js";
import {
  hashAudioRenderPlan,
  resolveAudioRenderPlan,
  type AudioRenderPlan,
} from "../runtime/audio/render-plan.js";
import type { CaptionApproval } from "../runtime/caption/approval.js";
import type { CaptionVisualTreatmentInput } from "../runtime/caption/visual-treatment.js";
import { assertCaptionContentOwnerBoundary } from "../runtime/caption/edit-router.js";
import type { CaptionOverlay, TimelineIR } from "../runtime/compiler/types.js";
import {
  loadContentRenderPlan,
  type ContentRenderPlan,
} from "../runtime/content/render-plan.js";
import { renderHyperFramesContentLayer } from "../runtime/content/hyperframes-renderer.js";
import type {
  ContentRendererId,
  CreativeCompositeStage,
} from "../runtime/content/types.js";
import { verifyBundledFont } from "../runtime/fonts/bundled-font.js";
import {
  getTimelineFps,
  readTimeline,
} from "../runtime/render/assembler.js";
import { composeFinalVisuals, type FinalVisualLayer } from "../runtime/render/final-visual-compositor.js";
import { buildAssSubtitleFile } from "../runtime/render/promo-finisher.js";
import { resolveProjectSocialReviewCaptionStyle } from "../runtime/render/review-caption-style.js";
import {
  REMOTION_RENDERER_VERSION,
  renderRemotionContentLayer,
} from "../runtime/render/remotion/render-remotion.js";
import { remotionCapabilityIdentityHash } from "../runtime/render/remotion/overlay-capability.js";
import { renderRoughCut } from "./render-rough-cut.js";
import { loadSourceMap } from "../runtime/media/source-map.js";
import { resolveCanonicalRenderInputs } from "../runtime/render/canonical-render-input.js";
import { createSourceInputAttestation } from "../runtime/render/source-input-attestation.js";
import type { SourceInputAttestation } from "../runtime/render/source-input-attestation.js";
import { resolveReviewCutIdentity, type ReviewEditIdentityReceipt } from "../runtime/review/edit-identity.js";
import {
  deriveDeterministicAllowedRanges,
  runDeterministicOutputQA,
  type DeterministicEndingIntent,
} from "../runtime/review/deterministic-output-qa.js";
import { evaluateDeterministicLayoutQA } from "../runtime/review/deterministic-layout-qa.js";
import { buildRenderLayoutSnapshot } from "../runtime/review/render-layout-snapshot.js";
import {
  parseSubjectOccupancyTrack,
  subjectOccupancyPayloadHash,
  type SubjectOccupancyTrack,
} from "../runtime/review/subject-occupancy.js";
import {
  loadVerticalCompositionPolicy,
  verticalCompositionPolicyContentHash,
} from "../runtime/visual/vertical-composition.js";
import {
  assertGenerationInputsUnchanged,
  bindGenerationArtifact,
  buildReviewReadyReceipt,
  captureSocialReviewGeneration,
  hashCanonical,
  prepareImmutableGeneration,
  promoteLatestGeneration,
  sha256File,
  writeReviewReadyReceipt,
  type GenerationInputSource,
} from "../runtime/review/social-review-generation.js";
import {
  audioReportFromReceipt,
  buildSocialReviewAudioReceipt,
  deriveSocialReviewAudioPlanIdentity,
  musicMasterIdentityFromPlan,
} from "../runtime/review/social-review-audio.js";

export {
  resolveProjectSocialReviewCaptionStyle,
  resolveSocialReviewCaptionStyle,
  socialReviewCaptionStyle,
} from "../runtime/render/review-caption-style.js";

const execFileAsync = promisify(execFile);

export function deriveSocialReviewGenerationAudioPlanHash(
  sharedAudioPlan: AudioRenderPlan | undefined,
): string {
  return deriveSocialReviewAudioPlanIdentity({
    state: sharedAudioPlan ? "mastered" : "not_applicable",
    sharedAudioPlanHash: sharedAudioPlan ? hashAudioRenderPlan(sharedAudioPlan) : null,
    policy: sharedAudioPlan?.final_mastering ?? DEFAULT_MASTERING,
    policyProfileHash: sharedAudioPlan?.audio_delivery_profile?.profile_hash ?? null,
    ...(sharedAudioPlan?.music_master
      ? { musicMaster: musicMasterIdentityFromPlan(sharedAudioPlan.music_master) }
      : {}),
  });
}

export function assertSocialReviewAudioPlan(
  plan: Pick<AudioRenderPlan, "strategy" | "final_mastering" | "music_master">,
): void {
  if (plan.strategy === "legacy_embedded_bgm") {
    throw new Error("mixed audio input cannot enter social-review mastering; provide canonical shared audio cues");
  }
  if (plan.strategy === "original_passthrough") {
    throw new Error("already-mastered/original-passthrough input cannot enter social-review mastering");
  }
  if (plan.strategy === "music_master") {
    if (plan.music_master?.audio_decision === "preserve" && plan.final_mastering.count === 0) return;
    if (plan.music_master?.audio_decision !== "mastering" || plan.final_mastering.count !== 1) {
      throw new Error("music_master social-review audio must use preserve with zero mastering or explicit mastering exactly once");
    }
  }
  if (plan.final_mastering.count !== 1) {
    throw new Error("social-review shared mastering must run exactly once");
  }
}

interface CaptionPlanV1 {
  version?: string;
  base_timeline_hash?: string;
  derived_mapping_sha256?: string;
  captions: CaptionOverlay[];
}

interface CaptionPlanV2Cue {
  text: string;
  timeline_in_frame: number;
  timeline_out_frame: number;
  style?: CaptionOverlay["style"];
}

interface CaptionPlanV2 {
  schema_version: "private-caption-plan/v2";
  base_timeline_hash?: string;
  derived_mapping_sha256?: string;
  cues: CaptionPlanV2Cue[];
}

type CaptionPlan = CaptionPlanV1 | CaptionPlanV2;

export interface SocialReviewArgs {
  projectDir: string;
  repoSfxRoot?: string;
  timelinePath?: string;
  outputPath?: string;
  workDir?: string;
  captionPlanPath: string;
  musicCuesPath?: string;
  sfxCuesPath?: string;
  subjectOccupancyPath?: string;
  verticalCompositionPolicyPath?: string;
}

export interface SocialVisualLayerRequest {
  renderer: Exclude<ContentRendererId, "ffmpeg">;
  compositeStage: CreativeCompositeStage;
  zIndex: number;
  elementIds: string[];
}

interface SocialVisualLayerRenderers {
  hyperframes: typeof renderHyperFramesContentLayer;
  remotion: typeof renderRemotionContentLayer;
}

interface RenderedSocialVisualLayers {
  layers: FinalVisualLayer[];
  receipts: Array<{
    renderer: SocialVisualLayerRequest["renderer"];
    composite_stage: CreativeCompositeStage;
    receipt_path: string;
    element_ids: string[];
  }>;
}

const USAGE = `Usage:
  npm run social-review -- --project <dir> --captions <plan.json> [--repo-sfx-root <directory>] [--timeline <timeline.json>] [--music-cues <music_cues.json>] [--sfx-cues <sfx_cues.json>] [--subject-occupancy <track.json>] [--vertical-composition-policy <policy.json>] [--output <mp4>] [--work-dir <dir>]

Renders a review-only social preview from canonical timeline cuts, registered
content elements, authored captions, and dialogue audio. It does not approve or
package a final deliverable.`;

export function parseSocialReviewArgs(argv: string[]): SocialReviewArgs {
  const values = argv.slice(2);
  let projectDir: string | undefined;
  let repoSfxRoot: string | undefined;
  let timelinePath: string | undefined;
  let outputPath: string | undefined;
  let workDir: string | undefined;
  let captionPlanPath: string | undefined;
  let musicCuesPath: string | undefined;
  let sfxCuesPath: string | undefined;
  let subjectOccupancyPath: string | undefined;
  let verticalCompositionPolicyPath: string | undefined;
  for (let index = 0; index < values.length; index += 1) {
    const arg = values[index];
    if (arg === "--help" || arg === "-h") throw new Error(USAGE);
    if (arg === "--project") projectDir = required(values, ++index, arg);
    else if (arg === "--repo-sfx-root") repoSfxRoot = required(values, ++index, arg);
    else if (arg === "--timeline") timelinePath = required(values, ++index, arg);
    else if (arg === "--output") outputPath = required(values, ++index, arg);
    else if (arg === "--work-dir") workDir = required(values, ++index, arg);
    else if (arg === "--captions") captionPlanPath = required(values, ++index, arg);
    else if (arg === "--music-cues") musicCuesPath = required(values, ++index, arg);
    else if (arg === "--sfx-cues") sfxCuesPath = required(values, ++index, arg);
    else if (arg === "--subject-occupancy") subjectOccupancyPath = required(values, ++index, arg);
    else if (arg === "--vertical-composition-policy") verticalCompositionPolicyPath = required(values, ++index, arg);
    else throw new Error(`Unknown argument: ${arg}\n${USAGE}`);
  }
  if (!projectDir || !captionPlanPath) throw new Error(USAGE);
  return {
    projectDir: path.resolve(projectDir),
    ...(repoSfxRoot ? { repoSfxRoot: path.resolve(repoSfxRoot) } : {}),
    timelinePath: timelinePath ? path.resolve(timelinePath) : undefined,
    outputPath: outputPath ? path.resolve(outputPath) : undefined,
    workDir: workDir ? path.resolve(workDir) : undefined,
    captionPlanPath: path.resolve(captionPlanPath),
    musicCuesPath: musicCuesPath ? path.resolve(musicCuesPath) : undefined,
    sfxCuesPath: sfxCuesPath ? path.resolve(sfxCuesPath) : undefined,
    subjectOccupancyPath: subjectOccupancyPath ? path.resolve(subjectOccupancyPath) : undefined,
    verticalCompositionPolicyPath: verticalCompositionPolicyPath
      ? path.resolve(verticalCompositionPolicyPath)
      : undefined,
  };
}

function required(values: string[], index: number, flag: string): string {
  const value = values[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

export function timelineVisualDurationFrames(timeline: TimelineIR): number {
  const tracks = timeline.tracks as TimelineIR["tracks"] & {
    overlay?: TimelineIR["tracks"]["video"];
  };
  return Math.max(
    1,
    ...[...timeline.tracks.video, ...(tracks.overlay ?? [])]
      .flatMap((track) => track.clips)
      .map((clip) => clip.timeline_in_frame + clip.timeline_duration_frames),
  );
}

export function normalizeCaptionPlan(plan: unknown): CaptionOverlay[] {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    throw new Error("Caption plan must be an object");
  }
  const value = plan as Partial<CaptionPlanV1 & CaptionPlanV2>;
  if (value.schema_version === "private-caption-plan/v2") {
    if (!Array.isArray(value.cues) || value.cues.length === 0) {
      throw new Error("private-caption-plan/v2 must contain at least one cue");
    }
    return value.cues.map((cue) => ({
      text: cue.text,
      in_frame: cue.timeline_in_frame,
      out_frame: cue.timeline_out_frame,
      style: cue.style ?? "simple-shadow",
    }));
  }
  if (Array.isArray(value.captions)) return value.captions;
  throw new Error("Caption plan must contain at least one caption");
}

export function validateCaptionPlan(plan: unknown, durationFrames: number): CaptionOverlay[] {
  const normalized = normalizeCaptionPlan(plan);
  if (normalized.length === 0) {
    throw new Error("Caption plan must contain at least one caption");
  }
  const captions = [...normalized].sort((left, right) =>
    left.in_frame - right.in_frame || left.out_frame - right.out_frame
  );
  let previousOut = 0;
  for (const [index, caption] of captions.entries()) {
    if (!caption.text?.trim()) throw new Error(`Caption ${index} has empty text`);
    if (!Number.isInteger(caption.in_frame) || !Number.isInteger(caption.out_frame)) {
      throw new Error(`Caption ${index} frame bounds must be integers`);
    }
    if (caption.in_frame < previousOut || caption.out_frame <= caption.in_frame) {
      throw new Error(`Caption ${index} overlaps or has an invalid range`);
    }
    if (caption.out_frame > durationFrames) {
      throw new Error(`Caption ${index} exceeds timeline duration ${durationFrames}`);
    }
    previousOut = caption.out_frame;
  }
  return captions;
}

export function resolveSocialCaptionCollisionIdentity(
  captions: CaptionOverlay[],
  visualTreatment?: CaptionVisualTreatmentInput,
): Array<{ caption_id: string; role: "baseline" | "emphasis" | "title" }> {
  return captions.map((caption, index) => {
    const matches = visualTreatment?.caption_identity.filter((identity) =>
      identity.text === caption.text &&
      identity.timeline_in_frame === caption.in_frame &&
      identity.timeline_duration_frames === caption.out_frame - caption.in_frame
    ) ?? [];
    const identity = matches.length === 1 ? matches[0] : undefined;
    const treatment = identity?.treatment;
    const role = treatment?.hierarchy_role === "keyword" ||
        Boolean(treatment?.emphasis_ref)
      ? "emphasis" as const
      : treatment?.hierarchy_role === "annotation" ||
          treatment?.hierarchy_role === "cta"
      ? "title" as const
      : "baseline" as const;
    return {
      caption_id: identity?.caption_id ??
        `social-caption-${String(index + 1).padStart(4, "0")}`,
      role,
    };
  });
}

export function assertSubjectOccupancySourceBinding(
  track: SubjectOccupancyTrack,
  timeline: TimelineIR,
  attestation: SourceInputAttestation,
): void {
  const source = track.source_identity;
  const attested = attestation.source_inputs.find((entry) =>
    entry.asset_id === source.asset_id
  );
  if (!attested ||
    `sha256:${attested.content_sha256}` !== source.source_content_hash) {
    throw new Error(
      "subject occupancy source asset/hash is stale or absent from the generation source attestation",
    );
  }
  const clip = timeline.tracks.video.flatMap((track) => track.clips).find(
    (candidate) =>
      candidate.asset_id === source.asset_id &&
      candidate.segment_id === source.segment_id &&
      candidate.src_in_us <= source.source_range.src_in_us &&
      candidate.src_out_us >= source.source_range.src_out_us,
  );
  if (!clip) {
    throw new Error(
      "subject occupancy source segment/range is stale or absent from the generation timeline",
    );
  }
}

export function planSocialVisualLayers(
  plan: ContentRenderPlan,
): SocialVisualLayerRequest[] {
  const groups = new Map<string, SocialVisualLayerRequest>();
  for (const element of plan.visual_elements ?? []) {
    if (element.renderer === "ffmpeg" || element.requires_base_frame) continue;
    const key = `${element.renderer}:${element.composite_stage}`;
    const existing = groups.get(key);
    if (existing) {
      existing.zIndex = Math.min(existing.zIndex, element.z_index);
      existing.elementIds.push(element.element_id);
      continue;
    }
    groups.set(key, {
      renderer: element.renderer,
      compositeStage: element.composite_stage,
      zIndex: element.z_index,
      elementIds: [element.element_id],
    });
  }
  return [...groups.values()]
    .map((request) => ({
      ...request,
      elementIds: [...request.elementIds].sort((left, right) => left.localeCompare(right, "en")),
    }))
    .sort((left, right) =>
      (left.compositeStage === right.compositeStage
        ? left.zIndex - right.zIndex
        : left.compositeStage === "under_caption" ? -1 : 1) ||
      left.renderer.localeCompare(right.renderer, "en")
    );
}

export async function renderSocialVisualLayers(
  timelinePath: string,
  outputDir: string,
  renderers: SocialVisualLayerRenderers = {
    hyperframes: renderHyperFramesContentLayer,
    remotion: renderRemotionContentLayer,
  },
  options: {
    generationId?: string;
    remotionMediaCacheDir?: string;
    remotionBundleCacheDir?: string;
  } = {},
): Promise<RenderedSocialVisualLayers> {
  const plan = loadContentRenderPlan(timelinePath);
  if (plan.issues.length > 0) {
    throw new Error(
      `Social content plan is invalid: ${plan.issues.map((issue) => `${issue.clip_id}: ${issue.message}`).join("; ")}`,
    );
  }
  const layers: FinalVisualLayer[] = [];
  const receipts: RenderedSocialVisualLayers["receipts"] = [];
  for (const request of planSocialVisualLayers(plan)) {
    const rendered = request.renderer === "hyperframes"
      ? await renderers.hyperframes({
          timelinePath,
          outputDir,
          compositeStage: request.compositeStage,
        })
      : await renderers.remotion({
          timelinePath,
          outputDir,
          compositeStage: request.compositeStage,
          elementIds: request.elementIds,
          generationId: options.generationId,
          mediaCacheDir: options.remotionMediaCacheDir,
          bundleCacheDir: options.remotionBundleCacheDir,
        });
    if (!rendered) {
      throw new Error(
        `${request.renderer} returned no layer for ${request.elementIds.join(", ")}`,
      );
    }
    layers.push({
      path: rendered.overlayPath,
      renderer: request.renderer,
      compositeStage: request.compositeStage,
      zIndex: request.zIndex,
      elementIds: request.elementIds,
    });
    receipts.push({
      renderer: request.renderer,
      composite_stage: request.compositeStage,
      receipt_path: rendered.receiptPath,
      element_ids: request.elementIds,
    });
  }
  return { layers, receipts };
}

function sha256(filePath: string): string {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

async function hasAudio(filePath: string): Promise<boolean> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-select_streams", "a:0",
    "-show_entries", "stream=index",
    "-of", "csv=p=0",
    filePath,
  ]);
  return stdout.trim().length > 0;
}

async function muxReviewAudio(
  visualPath: string,
  audioSourcePath: string,
  outputPath: string,
  durationSec: number,
): Promise<void> {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  if (!(await hasAudio(audioSourcePath))) {
    fs.copyFileSync(visualPath, outputPath);
    return;
  }
  await execFileAsync("ffmpeg", [
    "-y",
    "-i", visualPath,
    "-i", audioSourcePath,
    "-filter_complex", `[1:a]apad,atrim=duration=${durationSec.toFixed(9)}[a]`,
    "-map", "0:v:0",
    "-map", "[a]",
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "192k",
    "-movflags", "+faststart",
    outputPath,
  ], { maxBuffer: 100 * 1024 * 1024 });
}

function containedProjectFile(projectDir: string, candidate: string): string {
  const root = fs.realpathSync(projectDir);
  const resolved = path.resolve(candidate);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`social-review evidence path escapes project: ${candidate}`);
  }
  const real = fs.realpathSync(resolved);
  if (!real.startsWith(`${root}${path.sep}`) || !fs.statSync(real).isFile()) {
    throw new Error(`social-review evidence path is not a project file: ${candidate}`);
  }
  return real;
}

function resolveVerticalCompositionPolicyPath(
  projectDir: string,
  explicitPath?: string,
): { path: string; expectedHash?: string } | undefined {
  if (explicitPath) {
    return { path: containedProjectFile(projectDir, explicitPath) };
  }
  const blueprintPath = path.join(projectDir, "04_plan", "edit_blueprint.yaml");
  if (!fs.existsSync(blueprintPath)) return undefined;
  const blueprint = parseYaml(fs.readFileSync(blueprintPath, "utf8")) as {
    policy_refs?: {
      vertical_composition_policy_ref?: string | {
        ref?: string;
        source_hash?: string;
      };
    };
  };
  const value = blueprint.policy_refs?.vertical_composition_policy_ref;
  const ref = typeof value === "string" ? value : value?.ref;
  if (!ref) return undefined;
  return {
    path: containedProjectFile(projectDir, path.resolve(projectDir, ref)),
    ...(typeof value === "object" && value.source_hash
      ? { expectedHash: value.source_hash }
      : {}),
  };
}

function writeGenerationJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

function captureCanonicalSocialReviewAudioPlan(
  projectDir: string,
  plan: AudioRenderPlan,
): string {
  const planPath = path.join(projectDir, "07_package", "audio-render-plan.json");
  const bytes = `${JSON.stringify(plan, null, 2)}\n`;
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  if (fs.existsSync(planPath)) {
    const stat = fs.lstatSync(planPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("canonical social-review audio plan must be a regular project file");
    }
    if (fs.readFileSync(planPath, "utf8") === bytes) return planPath;
  }
  const temporary = `${planPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    fs.writeFileSync(temporary, bytes, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporary, planPath);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return planPath;
}

export async function renderSocialReview(args: SocialReviewArgs): Promise<Record<string, unknown>> {
  if (args.outputPath || args.workDir) {
    throw new Error("immutable social-review generations do not accept --output or --work-dir overrides");
  }
  const timelinePath = args.timelinePath
    ?? path.join(args.projectDir, "05_timeline", "timeline.json");
  const musicCuesPath = args.musicCuesPath
    ?? path.join(args.projectDir, "07_package", "music_cues.json");
  const sfxCuesPath = args.sfxCuesPath
    ?? path.join(args.projectDir, "07_package", "sfx_cues.json");
  const timeline = readTimeline(timelinePath);
  const reviewCutIdentity = preflightSocialReviewEditIdentity(args);
  if (!reviewCutIdentity.receipt) {
    throw new Error("social-review generation requires an accepted #21 canonical review derivation receipt");
  }
  const timelineHasAudio = timeline.tracks.audio.some((track) => track.clips.length > 0)
    || typeof timeline.audio_mix?.bgm_asset_id === "string"
    || timeline.provenance?.audio_policy?.mode === "music_master"
    || Boolean((timeline.provenance?.audio_policy as Record<string, unknown> | undefined)?.music_master)
    || Boolean((timeline.provenance as Record<string, unknown> | undefined)?.music_master)
    || Boolean((timeline.metadata as Record<string, unknown> | undefined)?.music_master);
  let sharedAudioPlan = resolveSharedAudioRenderPlan({
    projectDir: args.projectDir,
    ...(args.repoSfxRoot ? { repoSfxRoot: args.repoSfxRoot } : {}),
    timelinePath,
    musicCuesPath,
    sfxCuesPath,
  });
  if (!sharedAudioPlan && timelineHasAudio) {
    sharedAudioPlan = resolveAudioRenderPlan({
      projectDir: args.projectDir,
      ...(args.repoSfxRoot ? { repoSfxRoot: args.repoSfxRoot } : {}),
      timelinePath,
    });
  }
  if (timelineHasAudio && !sharedAudioPlan) {
    throw new Error("review audio is present or requested but no identity-bound AudioRenderPlan was resolved");
  }
  if (sharedAudioPlan) assertSocialReviewAudioPlan(sharedAudioPlan);
  const fps = getTimelineFps(timeline);
  const durationFrames = timelineVisualDurationFrames(timeline);
  const durationSec = durationFrames / fps;
  const plan = JSON.parse(fs.readFileSync(args.captionPlanPath, "utf8")) as CaptionPlan;
  const captions = validateCaptionPlan(plan, durationFrames);
  assertCaptionPlanCanonicalFreshness(plan, reviewCutIdentity.receipt.canonical_timeline.sha256);
  assertCaptionPlanDerivedMapping(plan, reviewCutIdentity.receipt, args.projectDir);
  const captionVisualTreatmentInputPath = path.join(
    args.projectDir,
    "07_package",
    "caption-visual-treatment-input.json",
  );
  const captionVisualTreatmentInput = fs.existsSync(captionVisualTreatmentInputPath)
    ? validateArtifact<CaptionVisualTreatmentInput>(
      JSON.parse(fs.readFileSync(captionVisualTreatmentInputPath, "utf8")),
      "caption-visual-treatment-input.schema.json",
    )
    : undefined;
  const captionCollisionIdentities = resolveSocialCaptionCollisionIdentity(
    captions,
    captionVisualTreatmentInput,
  );
  const defaultSubjectOccupancyPath = path.join(
    args.projectDir,
    "06_review",
    "subject-occupancy-track.json",
  );
  const subjectOccupancyPath = args.subjectOccupancyPath
    ? containedProjectFile(args.projectDir, args.subjectOccupancyPath)
    : fs.existsSync(defaultSubjectOccupancyPath)
    ? containedProjectFile(args.projectDir, defaultSubjectOccupancyPath)
    : undefined;
  const subjectOccupancy = subjectOccupancyPath
    ? parseSubjectOccupancyTrack(
      JSON.parse(fs.readFileSync(subjectOccupancyPath, "utf8")),
    )
    : undefined;
  const verticalCompositionPolicyResolution = resolveVerticalCompositionPolicyPath(
    args.projectDir,
    args.verticalCompositionPolicyPath,
  );
  const verticalCompositionPolicyPath = verticalCompositionPolicyResolution?.path;
  const verticalCompositionPolicy = verticalCompositionPolicyPath
    ? loadVerticalCompositionPolicy(verticalCompositionPolicyPath)
    : undefined;
  if (verticalCompositionPolicy &&
    verticalCompositionPolicyResolution?.expectedHash &&
    verticalCompositionPolicyContentHash(verticalCompositionPolicy) !==
      verticalCompositionPolicyResolution.expectedHash) {
    throw new Error("vertical composition policy source hash is stale");
  }
  const verticalCompositionPolicyRef = verticalCompositionPolicyPath
    ? relativeProjectPath(args.projectDir, verticalCompositionPolicyPath)
    : undefined;
  const contentPlan = loadContentRenderPlan(timelinePath);
  if (contentPlan.issues.length > 0) {
    throw new Error(`Social content plan is invalid: ${contentPlan.issues.map((issue) => `${issue.clip_id}: ${issue.message}`).join("; ")}`);
  }
  assertCaptionContentOwnerBoundary({
    captions: captions.map((caption, index) => ({
      caption_id: `SC_SOCIAL_${String(index + 1).padStart(4, "0")}`,
      text: caption.text,
      start_frame: caption.in_frame,
      end_frame: caption.out_frame,
    })),
    content: [...contentPlan.hyperframes_elements, ...contentPlan.remotion_elements].map((timed) => ({
      element_id: timed.element.element_id,
      template_ref: timed.element.template_ref ?? "",
      props: timed.element.props,
      start_frame: timed.start_frame,
      end_frame: timed.start_frame + timed.duration_frames,
    })),
  });
  const fontPaths = verifyBundledFont();
  // The bundled font lives outside the project; copy it to a canonical,
  // immutable project evidence path so no machine-root path enters hashed
  // generation/report material and the font ref is project-relative.
  const projectFontDir = path.join(args.projectDir, "06_review", "renderer-fonts");
  fs.mkdirSync(projectFontDir, { recursive: true });
  const projectFontPath = path.join(projectFontDir, path.basename(fontPaths.assHeavyFontPath));
  if (!fs.existsSync(projectFontPath)) {
    const fontCopyTmp = `${projectFontPath}.tmp-${process.pid}`;
    fs.copyFileSync(fontPaths.assHeavyFontPath, fontCopyTmp);
    fs.renameSync(fontCopyTmp, projectFontPath);
  }
  const fontEvidence = {
    assHeavyFontPath: projectFontPath,
    fontsDir: projectFontDir,
  };
  if (sha256File(projectFontPath) !== sha256File(fontPaths.assHeavyFontPath)) {
    throw new Error("copied renderer font does not match the bundled font bytes");
  }
  const captionStyle = resolveProjectSocialReviewCaptionStyle(
    args.projectDir,
    timeline.sequence.width,
    timeline.sequence.height,
  );
  const captionStylingClass = readProjectCaptionStylingClass(args.projectDir) ?? "sns-vertical";
  const identityReceiptPath = path.join(args.projectDir, "05_timeline", "review-edit-identity.json");
  const inputFiles: Array<string | GenerationInputSource> = [
    relativeProjectPath(args.projectDir, timelinePath),
    reviewCutIdentity.receipt.canonical_timeline.path,
    reviewCutIdentity.receipt.accepted_patch.path,
    reviewCutIdentity.receipt.derived_mapping.path,
    relativeProjectPath(args.projectDir, identityReceiptPath),
    relativeProjectPath(args.projectDir, args.captionPlanPath),
  ];
  if (verticalCompositionPolicyPath) {
    inputFiles.push({
      logicalPath: "policy/vertical-composition",
      filePath: verticalCompositionPolicyPath,
    });
  }
  for (const optional of [
    path.join(args.projectDir, "04_plan", "edit_blueprint.yaml"),
    musicCuesPath,
    sfxCuesPath,
    captionVisualTreatmentInputPath,
  ]) {
    if (fs.existsSync(optional) && fs.statSync(optional).isFile()) inputFiles.push(relativeProjectPath(args.projectDir, optional));
  }
  const deliveryProfilesDir = path.join(args.projectDir, "07_package", "delivery_profiles");
  if (fs.existsSync(deliveryProfilesDir)) {
    for (const fileName of fs.readdirSync(deliveryProfilesDir).sort((left, right) => left.localeCompare(right, "en"))) {
      const profilePath = path.join(deliveryProfilesDir, fileName);
      if (fs.statSync(profilePath).isFile()) inputFiles.push(relativeProjectPath(args.projectDir, profilePath));
    }
  }
  const storyboardRoot = path.join(args.projectDir, "04_plan", "review-projections");
  if (fs.existsSync(storyboardRoot)) {
    for (const projectionId of fs.readdirSync(storyboardRoot).sort((left, right) => left.localeCompare(right, "en"))) {
      const manifestPath = path.join(storyboardRoot, projectionId, "manifest.json");
      if (fs.existsSync(manifestPath) && fs.statSync(manifestPath).isFile()) {
        inputFiles.push({ logicalPath: `storyboard/${projectionId}/manifest`, filePath: manifestPath });
      }
    }
  }
  const sourceInputAttestation = createSourceInputAttestation(args.projectDir, {
    timelinePath,
    includeVideo: true,
    includeAudio: true,
  });
  if (subjectOccupancy) {
    assertSubjectOccupancySourceBinding(
      subjectOccupancy,
      timeline,
      sourceInputAttestation,
    );
  }
  const sourceMap = loadSourceMap(args.projectDir);
  const canonicalRenderInputs = resolveCanonicalRenderInputs(timeline, {
    projectDir: args.projectDir,
    timelinePath,
    includeVideo: true,
    includeAudio: true,
  });
  const addResolvedInput = (logicalPath: string, filePath: string | undefined) => {
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return;
    inputFiles.push({ logicalPath, filePath });
  };
  addResolvedInput("source-map", sourceMap.filePath);
  addResolvedInput("analysis/assets", path.join(args.projectDir, "03_analysis", "assets.json"));
  const sourceAssetIds = new Set<string>();
  for (const tracks of [timeline.tracks.video, timeline.tracks.audio]) {
    for (const track of tracks) for (const clip of track.clips) sourceAssetIds.add(clip.asset_id);
  }
  for (const assetId of [...sourceAssetIds].sort((left, right) => left.localeCompare(right, "en"))) {
    const canonical = canonicalRenderInputs.byAssetId.get(assetId);
    const safeAssetId = assetId.replace(/[^A-Za-z0-9._-]/g, "_");
    if (canonical) {
      addResolvedInput(`source-media/${safeAssetId}/render`, canonical.renderInputPath);
      addResolvedInput(`source-media/${safeAssetId}/original`, canonical.originalSourcePath);
      canonical.originalFramePaths?.forEach((framePath, index) =>
        addResolvedInput(`source-media/${safeAssetId}/frame-${String(index).padStart(6, "0")}`, framePath));
    } else {
      addResolvedInput(`source-media/${safeAssetId}/render`, sourceMap.entryMap.get(assetId)?.source_locator);
    }
  }
  if (sharedAudioPlan) {
    addResolvedInput(
      "audio/shared-render-plan",
      captureCanonicalSocialReviewAudioPlan(args.projectDir, sharedAudioPlan),
    );
    addResolvedInput("audio/delivery-profile", sharedAudioPlan.audio_delivery_profile?.path);
    for (const clip of sharedAudioPlan.dialogue.clips) addResolvedInput(`audio/dialogue/${clip.clip_id}`, clip.source_path);
    for (const cue of sharedAudioPlan.music.cues) addResolvedInput(`audio/music/${cue.cue_id}`, cue.source_path);
    for (const cue of sharedAudioPlan.sfx?.cues ?? []) addResolvedInput(`audio/sfx/${cue.cue_id}`, cue.source_path);
    for (const clip of sharedAudioPlan.ambient?.clips ?? []) addResolvedInput(`audio/ambient/${clip.clip_id}`, clip.source_path);
  }
  addResolvedInput("renderer/font/ass-heavy", fontEvidence.assHeavyFontPath);
  const rendererCapabilityHash = hashCanonical({
    version: "social-review-renderer-capability/v1",
    render_contract: "social-review-render/v3",
    output_qa: "deterministic-output-qa/v1",
    layout_qa: "deterministic-layout-qa/v2",
    subject_collision: "subject-occupancy-track/v1",
    remotion_renderer_version: REMOTION_RENDERER_VERSION,
    remotion_overlay_capability_sha256: remotionCapabilityIdentityHash(),
    font_sha256: sha256File(fontPaths.assHeavyFontPath),
  });
  const generation = captureSocialReviewGeneration({
    projectDir: args.projectDir,
    projectId: timeline.project_id,
    canonicalTimelineHash: reviewCutIdentity.receipt.canonical_timeline.sha256,
    acceptedPatchHash: reviewCutIdentity.receipt.accepted_patch.sha256,
    derivedMappingReceiptHash: reviewCutIdentity.receipt.derived_mapping.sha256,
    reviewTimelineHash: reviewCutIdentity.receipt.review_timeline.sha256,
    captionTextTimingHash: hashCanonical(captions.map((caption) => ({ text: caption.text, in_frame: caption.in_frame, out_frame: caption.out_frame }))),
    visualTreatmentHash: hashCanonical({ caption_style: captionStyle }),
    contentPlanHash: hashCanonical(contentPlan),
    audioPlanHash: deriveSocialReviewGenerationAudioPlanHash(sharedAudioPlan),
    rendererCapabilityHash,
    subjectOccupancyPayloadHash: subjectOccupancy
      ? subjectOccupancyPayloadHash(subjectOccupancy)
      : undefined,
    verticalCompositionPolicyHash: verticalCompositionPolicy
      ? verticalCompositionPolicyContentHash(verticalCompositionPolicy)
      : undefined,
    sourceInputAttestation,
    files: inputFiles,
  });
  const prepared = prepareImmutableGeneration(generation);
  if (prepared.status === "reused") return prepared.receipt! as unknown as Record<string, unknown>;
  const subjectOccupancyEvidencePath = subjectOccupancy
    ? path.join(generation.generation_dir, "subject-occupancy-track.json")
    : undefined;
  const verticalCompositionPolicyEvidencePath = verticalCompositionPolicy
    ? path.join(generation.generation_dir, "vertical-composition-policy.json")
    : undefined;
  if (subjectOccupancyEvidencePath) {
    writeGenerationJson(subjectOccupancyEvidencePath, subjectOccupancy);
  }
  if (verticalCompositionPolicyEvidencePath) {
    writeGenerationJson(
      verticalCompositionPolicyEvidencePath,
      verticalCompositionPolicy,
    );
  }
  const workDir = path.join(generation.generation_dir, "work");
  const outputPath = generation.output_path;
  const basePath = path.join(workDir, "base-dialogue.mp4");
  const assPath = path.join(workDir, "captions.ass");
  const visualPath = path.join(workDir, "visual.mp4");
  const sharedAudioDir = path.join(workDir, "audio");
  const layerDir = path.join(workDir, "layers");
  fs.mkdirSync(workDir, { recursive: true });

  await renderRoughCut({
    projectPath: args.projectDir,
    timelinePath,
    outputPath: basePath,
    noAudio: true,
    deferEndingFade: true,
  });
  const sharedAudioResult = sharedAudioPlan
    ? await executeAudioRenderPlan({
        plan: sharedAudioPlan,
        outputDir: sharedAudioDir,
        replaceExisting: true,
        workDirRoot: workDir,
      })
    : undefined;
  // Blueprint styling_class is canonical. Caption-plan presentation metadata
  // may be stale; only cue text/timing are adapted above.
  fs.writeFileSync(
    assPath,
    buildAssSubtitleFile(captions, fps, captionStyle),
    "utf8",
  );

  const remotionCacheRoot = path.join(args.projectDir, "09_output", "social-review", "cache", "remotion");
  const renderedLayers = await renderSocialVisualLayers(
    timelinePath,
    layerDir,
    undefined,
    {
      generationId: generation.generation_id,
      remotionMediaCacheDir: path.join(remotionCacheRoot, "media"),
      remotionBundleCacheDir: path.join(remotionCacheRoot, "bundles"),
    },
  );
  await composeFinalVisuals({
    baseVideoPath: basePath,
    layers: renderedLayers.layers,
    assPath,
    fontsDir: fontEvidence.fontsDir,
    outputPath: visualPath,
    width: timeline.sequence.width,
    height: timeline.sequence.height,
    fpsNum: timeline.sequence.fps_num,
    fpsDen: timeline.sequence.fps_den,
    durationFrames,
  });
  await muxReviewAudio(
    visualPath,
    sharedAudioResult?.finalMixPath ?? visualPath,
    outputPath,
    durationSec,
  );

  assertGenerationInputsUnchanged(generation);
  const outputQa = runDeterministicOutputQA(outputPath, {
    expectedWidth: timeline.sequence.width,
    expectedHeight: timeline.sequence.height,
    allowedRanges: deriveDeterministicAllowedRanges(
      timeline,
      timeline.metadata?.ending_policy as DeterministicEndingIntent | undefined,
    ),
  });
  const captionApproval: CaptionApproval = {
    version: "social-review-layout-evidence/v1",
    project_id: timeline.project_id,
    base_timeline_version: reviewCutIdentity.receipt.canonical_timeline.sha256,
    caption_policy: { language: "und", delivery_mode: "burn_in", source: "authored", styling_class: captionStylingClass },
    speech_captions: captions.map((caption, index) => ({
      caption_id: captionCollisionIdentities[index].caption_id,
      asset_id: "__caption__",
      segment_id: `SOCIAL_CAPTION_${index + 1}`,
      timeline_in_frame: caption.in_frame,
      timeline_duration_frames: caption.out_frame - caption.in_frame,
      text: caption.text,
      transcript_ref: "social-review-caption-plan",
      transcript_item_ids: [],
      source: "authored",
      styling_class: captionStylingClass,
      metrics: { cps: 0, dwell_ms: Math.round((caption.out_frame - caption.in_frame) / fps * 1000) },
    })),
    text_overlays: [],
    approval: { status: "approved", base_timeline_hash: reviewCutIdentity.receipt.canonical_timeline.sha256 },
  };
  const layoutSnapshot = buildRenderLayoutSnapshot(timeline, captionApproval, {
    generationBinding: {
      generation_id: generation.generation_id,
      renderer_capability_sha256: rendererCapabilityHash,
    },
    captionRoles: Object.fromEntries(
      captionCollisionIdentities.map((identity) => [
        identity.caption_id,
        identity.role,
      ]),
    ),
  });
  const layoutQa = evaluateDeterministicLayoutQA(layoutSnapshot, {
    subjectCollision: {
      generationId: generation.generation_id,
      rendererCapabilityHash,
      subjectOccupancy,
      verticalCompositionPolicy,
      policyRef: verticalCompositionPolicyRef,
      policyHash: verticalCompositionPolicy
        ? verticalCompositionPolicyContentHash(verticalCompositionPolicy)
        : undefined,
    },
  });
  const layoutSnapshotPath = path.join(generation.generation_dir, "layout-snapshot.json");
  writeGenerationJson(layoutSnapshotPath, layoutSnapshot);
  const audioPresent = await hasAudio(outputPath);
  if (Boolean(sharedAudioResult) !== audioPresent) {
    throw new Error("social-review audio stream presence does not match the shared audio plan result");
  }
  const audioMasteringReceipt = sharedAudioResult && sharedAudioPlan
    ? buildSocialReviewAudioReceipt({
        state: "mastered",
        generationId: generation.generation_id,
        sharedAudioPlanHash: sharedAudioResult.planHash,
        projectDir: generation.project_dir,
        inputAudioPath: sharedAudioResult.premasterMixPath,
        outputAudioPath: sharedAudioResult.finalMixPath,
        reviewVideoPath: outputPath,
        policy: sharedAudioPlan.final_mastering,
        policyProfileHash: sharedAudioPlan.audio_delivery_profile?.profile_hash ?? null,
        masteringCount: sharedAudioResult.report.mastering_count ?? 0,
        inputKind: "premaster",
        ...(sharedAudioPlan.music_master ? { musicMaster: sharedAudioPlan.music_master } : {}),
      })
    : buildSocialReviewAudioReceipt({
        state: "not_applicable",
        reason: "review_video_has_no_audio_stream",
        generationId: generation.generation_id,
        projectDir: generation.project_dir,
        reviewVideoPath: outputPath,
        policy: DEFAULT_MASTERING,
      });
  const audioReceiptPath = path.join(generation.generation_dir, "audio-mastering-receipt.json");
  writeGenerationJson(audioReceiptPath, audioMasteringReceipt);
  let layerEvidence = renderedLayers.receipts.map((receipt) => bindGenerationArtifact(generation, receipt.receipt_path));
  if (layerEvidence.length === 0) {
    const layerSummaryPath = path.join(generation.generation_dir, "layer-qa-receipt.json");
    fs.writeFileSync(layerSummaryPath, `${JSON.stringify({
      version: "social-review-layer-qa/v1",
      status: "verified",
      receipts: [],
    }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    layerEvidence = [bindGenerationArtifact(generation, layerSummaryPath)];
  }
  const qa = {
    output: outputQa,
    layout: layoutQa,
    audio: { status: "verified" as const, evidence: bindGenerationArtifact(generation, audioReceiptPath) },
    layers: { status: "verified" as const, evidence: layerEvidence },
    layout_evidence: {
      snapshot: bindGenerationArtifact(generation, layoutSnapshotPath),
      subject_occupancy: subjectOccupancyEvidencePath
        ? bindGenerationArtifact(generation, subjectOccupancyEvidencePath)
        : null,
      vertical_composition_policy: verticalCompositionPolicyEvidencePath
        ? bindGenerationArtifact(
          generation,
          verticalCompositionPolicyEvidencePath,
        )
        : null,
    },
  };

  const report = assembleSocialReviewRenderReport({
    projectDir: args.projectDir,
    timelinePath,
    timelineVersion: timeline.version,
    cutIdentity: reviewCutIdentity.cut_identity,
    reviewEditIdentity: reviewCutIdentity.receipt,
    captionPlanPath: args.captionPlanPath,
    captionPlanIsV2: "schema_version" in plan && plan.schema_version === "private-caption-plan/v2",
    captions,
    durationFrames,
    durationSec,
    fpsNum: timeline.sequence.fps_num,
    fpsDen: timeline.sequence.fps_den,
    width: timeline.sequence.width,
    height: timeline.sequence.height,
    audioPresent,
    bgmPresent: Boolean(timeline.audio_mix?.bgm_asset_id),
    gapFree: outputQa.status === "verified" && outputQa.issues.length === 0,
    renderedLayers,
    fontPath: fontEvidence.assHeavyFontPath,
    sharedAudioResult: sharedAudioResult ? {
      planHash: sharedAudioResult.planHash,
      reportPath: sharedAudioResult.reportPath,
      reportSha256: sha256(sharedAudioResult.reportPath),
      dialogueFinishScope: sharedAudioResult.report.dialogue_finish_scope,
      masteringCount: sharedAudioResult.report.mastering_count,
    } : null,
    audioMastering: audioReportFromReceipt(audioMasteringReceipt),
    outputPath,
    outputSha256: sha256(outputPath),
    generationId: generation.generation_id,
    generationInputs: generation.inputs,
    outputQa,
    layoutQa,
  });
  fs.writeFileSync(
    path.join(generation.generation_dir, "social-review-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  const receipt = buildReviewReadyReceipt(generation, outputPath, qa, path.join(generation.generation_dir, "social-review-report.json"));
  writeReviewReadyReceipt(generation, receipt);
  promoteLatestGeneration(generation, receipt);
  return receipt as unknown as Record<string, unknown>;
}

/** Pure assembly of the hashed production report bytes; location refs are canonical project-relative identities. */
export function assembleSocialReviewRenderReport(inputs: {
  projectDir: string;
  timelinePath: string;
  timelineVersion: unknown;
  cutIdentity: unknown;
  reviewEditIdentity: unknown;
  captionPlanPath: string;
  captionPlanIsV2: boolean;
  captions: Array<{ text: string; in_frame: number; out_frame: number; style: string }>;
  durationFrames: number;
  durationSec: number;
  fpsNum: number;
  fpsDen: number;
  width: number;
  height: number;
  audioPresent: boolean;
  bgmPresent: boolean;
  gapFree: boolean;
  renderedLayers: { layers: unknown[]; receipts: Array<{ renderer: unknown; composite_stage: unknown; receipt_path: string; element_ids: string[] }> };
  fontPath: string;
  sharedAudioResult: { planHash: string; reportPath: string; reportSha256: string; dialogueFinishScope: unknown; masteringCount: number | undefined } | null;
  audioMastering: unknown;
  outputPath: string;
  outputSha256: string;
  generationId: string;
  generationInputs: unknown;
  outputQa: unknown;
  layoutQa: unknown;
}): Record<string, unknown> {
  return {
    version: "social-review-render/v3",
    project: relativeProjectPath(inputs.projectDir, inputs.projectDir),
    timeline_path: relativeProjectPath(inputs.projectDir, inputs.timelinePath),
    timeline_version: inputs.timelineVersion,
    cut_identity: inputs.cutIdentity,
    review_edit_identity: inputs.reviewEditIdentity,
    caption_plan_path: relativeProjectPath(inputs.projectDir, inputs.captionPlanPath),
    caption_count: inputs.captions.length,
    caption_adapter: {
      source_schema: inputs.captionPlanIsV2 ? "private-caption-plan/v2" : "captions/v1-compatible",
      display_bounds_source: inputs.captionPlanIsV2 ? "cues[].timeline_in_frame/timeline_out_frame" : "captions[].in_frame/out_frame",
      rendered_cues: inputs.captions.map((caption) => ({
        text: caption.text,
        in_frame: caption.in_frame,
        out_frame: caption.out_frame,
        style: caption.style,
      })),
    },
    duration_frames: inputs.durationFrames,
    duration_sec: inputs.durationSec,
    fps_num: inputs.fpsNum,
    fps_den: inputs.fpsDen,
    width: inputs.width,
    height: inputs.height,
    audio_present: inputs.audioPresent,
    bgm_present: inputs.bgmPresent,
    gap_free: inputs.gapFree,
    layer_count: inputs.renderedLayers.layers.length,
    visual_layer_receipts: inputs.renderedLayers.receipts.map((receipt) => ({
      ...receipt,
      receipt_path: relativeProjectPath(inputs.projectDir, receipt.receipt_path),
    })),
    caption_font: {
      family: ASS_HEAVY_VIDEO_FONT.family,
      weight: ASS_HEAVY_VIDEO_FONT.weight,
      path: relativeProjectPath(inputs.projectDir, inputs.fontPath),
      sha256: sha256(inputs.fontPath),
    },
    audio_render_plan: inputs.sharedAudioResult ? {
      plan_hash: inputs.sharedAudioResult.planHash,
      report_path: relativeProjectPath(inputs.projectDir, inputs.sharedAudioResult.reportPath),
      report_sha256: inputs.sharedAudioResult.reportSha256,
      dialogue_finish_scope: inputs.sharedAudioResult.dialogueFinishScope,
      mastering_count: inputs.sharedAudioResult.masteringCount,
    } : null,
    audio_mastering: inputs.audioMastering,
    output_path: relativeProjectPath(inputs.projectDir, inputs.outputPath),
    output_sha256: inputs.outputSha256,
    generation_id: inputs.generationId,
    generation_inputs: inputs.generationInputs,
    deterministic_output_qa: inputs.outputQa,
    deterministic_layout_qa: inputs.layoutQa,
    review_only: true,
  };
}

export function assertCaptionPlanCanonicalFreshness(plan: CaptionPlan, canonicalTimelineHash: string): void {
  if (plan.base_timeline_hash !== canonicalTimelineHash) {
    throw new Error("caption/edit plan is stale: base_timeline_hash does not match the canonical timeline hash");
  }
}

export function assertCaptionPlanDerivedMapping(
  plan: CaptionPlan,
  identity: Pick<ReviewEditIdentityReceipt, "derived_mapping">,
  projectDir: string,
): void {
  const projectRoot = path.resolve(projectDir);
  const mappingPath = path.resolve(projectRoot, identity.derived_mapping.path);
  if (mappingPath !== projectRoot && !mappingPath.startsWith(`${projectRoot}${path.sep}`)) {
    throw new Error("caption/edit plan projection mapping must be project-local");
  }
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(mappingPath);
  } catch {
    throw new Error("caption/edit plan projection mapping is missing");
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("caption/edit plan projection mapping must be a regular project file");
  }
  let mapping: { operations?: Array<{ ripple?: unknown }> };
  try {
    mapping = JSON.parse(fs.readFileSync(mappingPath, "utf8")) as { operations?: Array<{ ripple?: unknown }> };
  } catch {
    throw new Error("caption/edit plan projection mapping is invalid");
  }
  if (!Array.isArray(mapping.operations) || mapping.operations.some((operation) => typeof operation?.ripple !== "boolean")) {
    throw new Error("caption/edit plan projection mapping is invalid");
  }
  const hasRipple = mapping.operations.some((operation) => operation.ripple === true);
  if (!hasRipple) return;
  if (plan.derived_mapping_sha256 !== identity.derived_mapping.sha256) {
    throw new Error("caption/edit plan is unprojected for ripple-derived timeline: derived_mapping_sha256 must match the derived frame mapping receipt");
  }
}

export function relativeProjectPath(projectDir: string, filePath: string): string {
  const root = fs.realpathSync(path.resolve(projectDir));
  const resolved = fs.realpathSync(path.resolve(filePath));
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error(`generation input must be project-local: ${filePath}`);
  const relative = path.relative(root, resolved);
  return relative.length === 0 ? "." : relative.split(path.sep).join("/");
}

export function preflightSocialReviewEditIdentity(args: Pick<SocialReviewArgs, "projectDir" | "timelinePath">) {
  const timelinePath = args.timelinePath ?? path.join(args.projectDir, "05_timeline", "timeline.json");
  return resolveReviewCutIdentity({
    projectDir: args.projectDir,
    timelinePath,
    variantRequested: args.timelinePath !== undefined,
  });
}

async function main(): Promise<void> {
  try {
    const report = await renderSocialReview(parseSocialReviewArgs(process.argv));
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (isMain) void main();
