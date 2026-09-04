import * as fs from "node:fs";
import { execFile } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { LoadedSourceMap } from "../media/source-map.js";
import { loadContentRenderPlan } from "../content/render-plan.js";
import { resolveRenderRoute, type RenderRouteEvidence } from "../render/route-resolver.js";
import { runRenderPipeline } from "../render/pipeline.js";
import {
  resolveAndVerifyCanonicalCaptionVisualTreatmentInput,
  shouldPreflightCanonicalCaptionVisualTreatment,
} from "../render/canonical-render-input.js";
import { captionVisualTreatmentReceiptSummary, type CaptionVisualTreatmentInput } from "../caption/visual-treatment.js";
import { computeSha256 } from "../packaging/manifest.js";
import {
  extractVideoClips,
  filterByBeat,
  filterByDuration,
  resolveSourcePath,
  type PreviewClip,
  type PreviewSegmentOptions,
  type PreviewSegmentResult,
} from "./segment-renderer.js";

type RenderScopeState = "canonical_render" | "applied" | "partial" | "not_applied" | "not_requested" | "unverified";
type LayerParityStatus = "verified" | "partial" | "not_applied" | "not_requested";

export interface BaselineFastPreviewContract {
  version: "baseline-fast-preview/v1";
  preview_mode: "baseline_fast";
  approval_status: "not_final_approval";
  route: {
    source: "canonical_timeline";
    assembly_engine: "ffmpeg" | "remotion";
    caption_layer_engine: "ffmpeg-libass" | "none";
    content_renderer_ownership: Array<{
      renderer: "ffmpeg" | "remotion" | "hyperframes";
      clip_ids: string[];
    }>;
    reasons: string[];
  };
  inputs: {
    timeline: { path: string; sha256: string };
    caption_draft: { path: string; sha256: string; kind: "approval" | "draft" } | null;
    content: { source: "canonical_timeline"; sha256: string; element_count: number };
    audio: {
      source: "canonical_timeline" | "audio_render_plan";
      sha256: string;
      path: string | null;
      clip_ids: string[];
    };
    source_assets: Array<{
      asset_id: string;
      source_content_sha256: string | null;
      status: "pinned" | "missing";
    }>;
    caption_visual_treatment?: {
      path: string;
      sha256: string;
      input_hash: string;
      approval_hash: string;
      visual_treatment_patch_hash: string | null;
      typography_policy_hash: string;
      platform_safe_zone_profile_id: string | null;
      platform_safe_zone_profile_path: string | null;
      platform_safe_zone_profile_hash: string | null;
      accessibility: CaptionVisualTreatmentInput["accessibility"] | null;
      text_timing_hash: string;
      capability_hash: string;
      status: CaptionVisualTreatmentInput["status"];
      applied_caption_ids: string[];
      degraded_reasons: Array<{ caption_id: string; reason: string }>;
      blocked_reasons: Array<{ caption_id: string; reason: string }>;
    };
  };
  render_scope: {
    video: "canonical_render";
    captions: RenderScopeState;
    content_overlays: RenderScopeState;
    audio: RenderScopeState;
    note: string;
  };
  render_range: {
    start_frame: number;
    end_frame: number;
    expected_frames: number;
  };
  canonical_route_receipt: { path: string; sha256: string } | null;
  canonical_route_evidence: RenderRouteEvidence | null;
  actual_output: {
    path: string;
    sha256: string;
    size_bytes: number;
    ffprobe: {
      width: number;
      height: number;
      fps_num: number;
      fps_den: number;
      duration_sec: number;
      video_frame_count: number;
      video_stream_count: number;
      audio_stream_count: number;
    };
  } | null;
  applied_layers: {
    captions: {
      expected_clip_ids: string[];
      applied_clip_ids: string[];
      status: LayerParityStatus;
      evidence: string;
    };
    audio: {
      expected_clip_ids: string[];
      applied_clip_ids: string[];
      status: LayerParityStatus;
      evidence: string;
    };
    content_overlays: {
      expected_clip_ids: string[];
      applied_clip_ids: string[];
      unapplied_clip_ids: string[];
      status: LayerParityStatus;
      evidence: string;
    };
  };
  parity: {
    status: "unverified" | "partial" | "verified";
    compared_with: "canonical_timeline";
    frame_geometry: {
      expected_width: number;
      expected_height: number;
      rendered_width: number | null;
      rendered_height: number | null;
      fps_num: number;
      fps_den: number;
      rendered_fps_num: number | null;
      rendered_fps_den: number | null;
      matches: boolean;
    };
    duration: {
      canonical_video_frames: number;
      selected_video_frames: number;
      rendered_frames: number | null;
      matches: boolean | null;
    };
    captions: {
      expected_clip_ids: string[];
      applied_clip_ids: string[];
      matches: boolean | null;
      verification: "render_layer_receipt" | "not_applied" | "not_requested";
    };
    audio: {
      expected_clip_ids: string[];
      applied_clip_ids: string[];
      matches: boolean | null;
      verification: "render_layer_receipt" | "not_applied" | "not_requested";
    };
    major_overlays: {
      expected_clip_ids: string[];
      resolved_clip_ids: string[];
      unapplied_clip_ids: string[];
      matches: boolean | null;
      verification: "render_layer_receipt" | "not_applied" | "not_requested";
    };
    caption_visual_treatment?: {
      resolved_input_hash: string;
      text_timing_hash: string;
      platform_safe_zone_profile_id: string | null;
      platform_safe_zone_profile_path: string | null;
      platform_safe_zone_profile_hash: string | null;
      accessibility: CaptionVisualTreatmentInput["accessibility"] | null;
      status: CaptionVisualTreatmentInput["status"];
      route: "ffmpeg-libass" | "none";
      matches: boolean | null;
      verification: "route_receipt" | "not_requested" | "not_applied";
    };
  };
}

interface TimelineClipLike {
  clip_id: string;
  asset_id: string;
  timeline_in_frame: number;
  timeline_duration_frames: number;
  beat_id?: string;
}

interface TimelineLike {
  sequence: {
    fps_num: number;
    fps_den: number;
    width: number;
    height: number;
  };
  tracks: {
    video: Array<{ clips: TimelineClipLike[] }>;
    audio: Array<{ clips: TimelineClipLike[] }>;
    overlay?: Array<{ clips: TimelineClipLike[] }>;
    caption?: Array<{ clips: TimelineClipLike[] }>;
  };
}

export interface BuildBaselineFastPreviewOptions {
  projectDir: string;
  timelinePath: string;
  sourceMap: LoadedSourceMap;
  beatId?: string;
  firstNSec?: number;
  captionVisualTreatmentInput?: CaptionVisualTreatmentInput;
  captionVisualTreatmentReviewOnlyPreapproval?: boolean;
}

interface BaselinePreviewRange {
  startFrame: number;
  endFrame: number;
}

interface TimelineProbe {
  streams?: Array<{
    codec_type?: unknown;
    width?: unknown;
    height?: unknown;
    r_frame_rate?: unknown;
    avg_frame_rate?: unknown;
    duration?: unknown;
    nb_read_frames?: unknown;
    nb_frames?: unknown;
  }>;
  format?: { duration?: unknown };
}

interface BaselineOutputProbe {
  width: number;
  height: number;
  fpsNum: number;
  fpsDen: number;
  durationSec: number;
  videoFrameCount: number;
  videoStreamCount: number;
  audioStreamCount: number;
}

interface AudioMixReceipt {
  strategy?: unknown;
  input_hashes?: {
    dialogue_sources?: Array<{ clip_id?: unknown }>;
  };
  execution_strategy?: {
    deterministic_input_order?: unknown[];
  };
  cues?: Array<{ cue_id?: unknown }>;
  sfx_cues?: Array<{ cue_id?: unknown }>;
}

interface CaptionInputDocument {
  caption_policy?: {
    language?: unknown;
    delivery_mode?: unknown;
    source?: unknown;
    styling_class?: unknown;
  };
  speech_captions?: Array<{ caption_id?: unknown }>;
}

function hashJson(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function allTrackClips(timeline: TimelineLike): TimelineClipLike[] {
  return [
    ...timeline.tracks.video,
    ...timeline.tracks.audio,
    ...(timeline.tracks.overlay ?? []),
    ...(timeline.tracks.caption ?? []),
  ].flatMap((track) => track.clips);
}

function canonicalDurationFrames(timeline: TimelineLike): number {
  return allTrackClips(timeline).reduce(
    (maxFrame, clip) => Math.max(maxFrame, clip.timeline_in_frame + clip.timeline_duration_frames),
    0,
  );
}

function sourceContentHash(value: string | undefined): string | null {
  if (!value) return null;
  if (/^sha256:[0-9a-f]{64}$/u.test(value)) return value;
  if (/^[0-9a-f]{64}$/u.test(value)) return `sha256:${value}`;
  return null;
}

function findCaptionInput(projectDir: string): BaselineFastPreviewContract["inputs"]["caption_draft"] {
  const candidates: Array<{ relative: string; kind: "approval" | "draft" }> = [
    { relative: "07_package/caption_approval.json", kind: "approval" },
    { relative: "07_package/caption_draft.json", kind: "draft" },
    { relative: "06_review/caption_approval.json", kind: "approval" },
    { relative: "06_review/caption_draft.json", kind: "draft" },
  ];
  for (const candidate of candidates) {
    const absolute = path.join(projectDir, candidate.relative);
    if (fs.existsSync(absolute)) {
      return { path: candidate.relative, sha256: computeSha256(absolute), kind: candidate.kind };
    }
  }
  return null;
}

function readCaptionInputDocument(
  projectDir: string,
  input: BaselineFastPreviewContract["inputs"]["caption_draft"],
): CaptionInputDocument | null {
  if (!input) return null;
  const absolute = path.join(projectDir, input.path);
  try {
    return JSON.parse(fs.readFileSync(absolute, "utf8")) as CaptionInputDocument;
  } catch (error) {
    throw new Error(`Baseline caption input is unreadable: ${absolute}: ${String(error)}`);
  }
}

function captionIDs(document: CaptionInputDocument | null): string[] {
  return (document?.speech_captions ?? [])
    .map((caption) => caption.caption_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .sort();
}

function baselineCaptionPolicy(document: CaptionInputDocument | null): {
  language: string;
  delivery_mode: "burn_in";
  source: "authored" | "none";
  styling_class: string;
} {
  const policy = document?.caption_policy;
  const hasCaptions = captionIDs(document).length > 0;
  return {
    language: typeof policy?.language === "string" && policy.language.length > 0
      ? policy.language
      : "ja",
    delivery_mode: "burn_in",
    source: hasCaptions ? "authored" : "none",
    styling_class: typeof policy?.styling_class === "string" && policy.styling_class.length > 0
      ? policy.styling_class
      : "clean-lower-third",
  };
}

function findAudioPlan(projectDir: string): { path: string; sha256: string } | undefined {
  for (const relative of [
    "07_package/audio-render-plan.json",
    "07_package/audio_render_plan.json",
    "08_audio/audio-render-plan.json",
  ]) {
    const absolute = path.join(projectDir, relative);
    if (fs.existsSync(absolute)) return { path: relative, sha256: computeSha256(absolute) };
  }
  return undefined;
}

function selectedVideoClips(
  timeline: TimelineLike,
  options: Pick<BuildBaselineFastPreviewOptions, "beatId" | "firstNSec">,
): PreviewClip[] {
  let clips = extractVideoClips(timeline as never);
  if (options.beatId) clips = filterByBeat(clips, options.beatId);
  if (options.firstNSec) {
    clips = filterByDuration(
      clips,
      options.firstNSec,
      timeline.sequence.fps_num,
      timeline.sequence.fps_den,
    );
  }
  return clips;
}

function resolvePreviewRange(
  timeline: TimelineLike,
  selected: PreviewClip[],
  options: Pick<BuildBaselineFastPreviewOptions, "beatId" | "firstNSec">,
): BaselinePreviewRange {
  const canonicalEndFrame = canonicalDurationFrames(timeline);
  if (options.beatId) {
    if (selected.length === 0) throw new Error(`No clips found for beat: ${options.beatId}`);
    return {
      startFrame: Math.min(...selected.map((clip) => clip.timeline_in_frame)),
      endFrame: Math.max(...selected.map((clip) => clip.timeline_in_frame + clip.timeline_duration_frames)),
    };
  }
  if (options.firstNSec) {
    const endFrame = Math.min(
      canonicalEndFrame,
      Math.ceil(options.firstNSec * timeline.sequence.fps_num / timeline.sequence.fps_den),
    );
    if (selected.length === 0 || endFrame <= 0) {
      throw new Error(`No clips within the first ${options.firstNSec} seconds`);
    }
    return { startFrame: 0, endFrame };
  }
  return { startFrame: 0, endFrame: canonicalEndFrame };
}

function sourceOverridesFromLoadedMap(
  sourceMap: LoadedSourceMap,
  projectDir: string,
): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const entry of sourceMap.entries) {
    const candidate = entry.local_source_path ?? entry.source_locator ?? entry.link_path;
    if (!candidate) continue;
    overrides[entry.asset_id] = path.isAbsolute(candidate)
      ? candidate
      : path.resolve(projectDir, candidate);
  }
  return overrides;
}

function execFilePromise(
  command: string,
  args: string[],
  execFileImpl: typeof execFile = execFile,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFileImpl(command, args, { maxBuffer: 100 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${command} failed: ${stderr || error.message}`));
        return;
      }
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

function parseFrameRate(value: unknown): { num: number; den: number } | null {
  if (typeof value !== "string") return null;
  const [numText, denText] = value.split("/");
  const num = Number(numText);
  const den = Number(denText ?? 1);
  if (!Number.isInteger(num) || !Number.isInteger(den) || num <= 0 || den <= 0) return null;
  return { num, den };
}

function readProbeNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function probeBaselineOutput(
  outputPath: string,
  execFileImpl?: typeof execFile,
): Promise<BaselineOutputProbe> {
  const result = await execFilePromise("ffprobe", [
    "-v", "error",
    "-count_frames",
    "-show_entries", "stream=codec_type,width,height,r_frame_rate,avg_frame_rate,duration,nb_read_frames,nb_frames",
    "-show_entries", "format=duration",
    "-of", "json",
    outputPath,
  ], execFileImpl);
  let probe: TimelineProbe;
  try {
    probe = JSON.parse(result.stdout) as TimelineProbe;
  } catch (error) {
    throw new Error(`Baseline fast preview ffprobe returned invalid JSON: ${String(error)}`);
  }
  const videoStreams = (probe.streams ?? []).filter((stream) => stream.codec_type === "video");
  const audioStreams = (probe.streams ?? []).filter((stream) => stream.codec_type === "audio");
  const video = videoStreams[0];
  const width = readProbeNumber(video?.width);
  const height = readProbeNumber(video?.height);
  const frameRate = parseFrameRate(video?.r_frame_rate) ?? parseFrameRate(video?.avg_frame_rate);
  const duration = readProbeNumber(video?.duration)
    ?? readProbeNumber(probe.format?.duration);
  if (!video || width === null || height === null || frameRate === null || duration === null) {
    throw new Error(`Baseline fast preview ffprobe is missing video geometry/fps/duration: ${outputPath}`);
  }
  const frameCountValue = video.nb_read_frames ?? video.nb_frames;
  const frameCount = readProbeNumber(frameCountValue);
  return {
    width,
    height,
    fpsNum: frameRate.num,
    fpsDen: frameRate.den,
    durationSec: duration,
    videoFrameCount: frameCount !== null
      ? Math.round(frameCount)
      : Math.round(duration * frameRate.num / frameRate.den),
    videoStreamCount: videoStreams.length,
    audioStreamCount: audioStreams.length,
  };
}

function renderRouteReceiptAppliedOverlayIDs(
  routeReceiptPath: string,
  expectedOverlayIDs: string[],
  routeVisualLayers: Array<{ renderer: string; element_ids: string[]; embedded_in_base: boolean }>,
  contentPlan: ReturnType<typeof loadContentRenderPlan>,
): { applied: string[]; unapplied: string[] } {
  const appliedElementIDs = new Set<string>();
  for (const layer of routeVisualLayers) {
    if (layer.embedded_in_base) {
      for (const elementID of layer.element_ids) appliedElementIDs.add(elementID);
    }
  }
  const routeReceipt = JSON.parse(fs.readFileSync(routeReceiptPath, "utf8")) as {
    visual_layer_receipt_paths?: string[];
  };
  for (const receiptPath of routeReceipt.visual_layer_receipt_paths ?? []) {
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as { element_ids?: unknown };
    for (const elementID of Array.isArray(receipt.element_ids) ? receipt.element_ids : []) {
      if (typeof elementID === "string") appliedElementIDs.add(elementID);
    }
  }
  const applied = expectedOverlayIDs.filter((clipID) => {
    const element = (contentPlan.visual_elements ?? []).find((candidate) => candidate.clip_id === clipID);
    return appliedElementIDs.has(element?.element_id ?? clipID);
  });
  return {
    applied,
    unapplied: expectedOverlayIDs.filter((clipID) => !applied.includes(clipID)),
  };
}

function audioReceiptAppliedClipIDs(
  audioMixReportPath: string,
  expectedAudioIDs: string[],
  audioStreamCount: number,
): { applied: string[]; status: LayerParityStatus; evidence: string } {
  if (audioStreamCount === 0) {
    return {
      applied: [],
      status: "not_applied",
      evidence: "ffprobe.audio_stream_missing",
    };
  }
  if (!audioMixReportPath || !fs.existsSync(audioMixReportPath)) {
    return {
      applied: [],
      status: "not_applied",
      evidence: "canonical_render_pipeline.audio_mix_report_missing",
    };
  }
  let report: AudioMixReceipt;
  try {
    report = JSON.parse(fs.readFileSync(audioMixReportPath, "utf8")) as AudioMixReceipt;
  } catch (error) {
    throw new Error(`Baseline fast preview audio mix receipt is unreadable: ${audioMixReportPath}: ${String(error)}`);
  }
  const reportedClipIDs = new Set<string>();
  for (const source of report.input_hashes?.dialogue_sources ?? []) {
    if (typeof source.clip_id === "string") reportedClipIDs.add(source.clip_id);
  }
  for (const entry of report.execution_strategy?.deterministic_input_order ?? []) {
    if (typeof entry !== "string") continue;
    const separator = entry.indexOf(":");
    if (separator > 0) reportedClipIDs.add(entry.slice(separator + 1));
  }
  for (const cue of [...(report.cues ?? []), ...(report.sfx_cues ?? [])]) {
    if (typeof cue.cue_id === "string") reportedClipIDs.add(cue.cue_id);
  }
  const applied = expectedAudioIDs.filter((clipID) => reportedClipIDs.has(clipID));
  return {
    applied,
    status: applied.length === expectedAudioIDs.length ? "verified" : "partial",
    evidence: applied.length === expectedAudioIDs.length
      ? "ffprobe.audio_stream_and_canonical_render_pipeline.audio_mix_report"
      : `ffprobe.audio_stream_and_canonical_render_pipeline.audio_mix_report_without_all_clip_ids${report.strategy ? `:${String(report.strategy)}` : ""}`,
  };
}

function resolveBaselineCaptionVisualTreatment(
  projectDir: string,
  captionDraft: BaselineFastPreviewContract["inputs"]["caption_draft"],
  provided?: CaptionVisualTreatmentInput,
  reviewOnlyPreapproval = false,
): CaptionVisualTreatmentInput | undefined {
  const suppliedContext = provided ? {
    platformSafeZoneProfileHash: provided.platform_safe_zone_profile_hash,
    platformSafeZoneProfileId: provided.platform_safe_zone_profile_id,
    platformSafeZoneProfilePath: provided.platform_safe_zone_profile_path,
    accessibility: provided.accessibility,
    requireApprovalBinding: !reviewOnlyPreapproval,
  } : {};
  if (!captionDraft || captionDraft.kind !== "approval") {
    if (provided) {
      return resolveAndVerifyCanonicalCaptionVisualTreatmentInput(projectDir, {
        typographyPolicyPath: "04_plan/typography_policy.json",
        providedInput: provided,
        ...suppliedContext,
      });
    }
    return undefined;
  }
  if (!shouldPreflightCanonicalCaptionVisualTreatment(projectDir) && !provided) return undefined;
  return resolveAndVerifyCanonicalCaptionVisualTreatmentInput(projectDir, {
    typographyPolicyPath: "04_plan/typography_policy.json",
    providedInput: provided,
    ...suppliedContext,
  });
}

function captionVisualTreatmentSummary(
  projectDir: string,
  input: CaptionVisualTreatmentInput,
): BaselineFastPreviewContract["inputs"]["caption_visual_treatment"] {
  const approvalPath = path.join(projectDir, "07_package/caption_approval.json");
  const patchPath = path.join(projectDir, "07_package/caption_visual_treatment_patch.json");
  const inputPath = path.join(projectDir, "07_package/caption_visual_treatment_input.json");
  const pathForHash = fs.existsSync(inputPath) ? inputPath : fs.existsSync(patchPath) ? patchPath : approvalPath;
  const summary = captionVisualTreatmentReceiptSummary(input);
  return {
    path: path.relative(projectDir, pathForHash),
    sha256: computeSha256(pathForHash),
    input_hash: summary.input_hash,
    approval_hash: summary.approval_hash,
    visual_treatment_patch_hash: summary.visual_treatment_patch_hash,
    typography_policy_hash: summary.typography_policy_hash,
    platform_safe_zone_profile_id: summary.platform_safe_zone_profile_id,
    platform_safe_zone_profile_path: summary.platform_safe_zone_profile_path,
    platform_safe_zone_profile_hash: summary.platform_safe_zone_profile_hash,
    accessibility: summary.accessibility,
    text_timing_hash: summary.text_timing_hash,
    capability_hash: summary.capability_hash,
    status: summary.status,
    applied_caption_ids: summary.applied_caption_ids,
    degraded_reasons: summary.degraded_reasons,
    blocked_reasons: summary.blocked_reasons,
  };
}

export function buildBaselineFastPreviewContract(
  options: BuildBaselineFastPreviewOptions,
): BaselineFastPreviewContract {
  const timeline = JSON.parse(fs.readFileSync(options.timelinePath, "utf8")) as TimelineLike;
  const contentPlan = loadContentRenderPlan(options.timelinePath);
  const captionDraft = findCaptionInput(options.projectDir);
  const captionDocument = readCaptionInputDocument(options.projectDir, captionDraft);
  const captionVisualTreatmentInput = resolveBaselineCaptionVisualTreatment(
    options.projectDir,
    captionDraft,
    options.captionVisualTreatmentInput,
    options.captionVisualTreatmentReviewOnlyPreapproval,
  );
  const captionClipIDs = captionIDs(captionDocument);
  const audioPlan = findAudioPlan(options.projectDir);
  const audioClips = timeline.tracks.audio.flatMap((track) => track.clips);
  const allClips = allTrackClips(timeline);
  const assetIds = [...new Set(allClips.map((clip) => clip.asset_id))].sort();
  const sourceAssets = assetIds.map((assetId) => {
    const entry = options.sourceMap.entryMap.get(assetId);
    const hash = sourceContentHash(entry?.source_content_sha256);
    return {
      asset_id: assetId,
      source_content_sha256: hash,
      status: hash ? "pinned" as const : "missing" as const,
    };
  });
  const route = resolveRenderRoute({
    requestedEngine: "auto",
    contentPlan,
    aspectRatio: timeline.sequence.width === timeline.sequence.height
      ? "1:1"
      : timeline.sequence.width > timeline.sequence.height ? "16:9" : "9:16",
    captionsEnabled: Boolean(captionDraft) || (timeline.tracks.caption?.some((track) => track.clips.length > 0) ?? false),
  });
  const rendererOwnership = route.visual_layers.map((layer) => ({
    renderer: layer.renderer,
    clip_ids: [...layer.element_ids].sort(),
  }));
  const selected = selectedVideoClips(timeline, options);
  const previewRange = resolvePreviewRange(timeline, selected, options);
  const selectedFrames = previewRange.endFrame - previewRange.startFrame;
  const overlayIds = (timeline.tracks.overlay ?? []).flatMap((track) => track.clips.map((clip) => clip.clip_id)).sort();
  const audioProjection = {
    tracks: timeline.tracks.audio,
    audio_mix: (timeline as TimelineLike & { audio_mix?: unknown }).audio_mix ?? null,
  };

  return {
    version: "baseline-fast-preview/v1",
    preview_mode: "baseline_fast",
    approval_status: "not_final_approval",
    route: {
      source: "canonical_timeline",
      assembly_engine: route.assembly_engine,
      caption_layer_engine: route.caption_layer.engine,
      content_renderer_ownership: rendererOwnership,
      reasons: route.reasons,
    },
    inputs: {
      timeline: { path: path.relative(options.projectDir, options.timelinePath), sha256: computeSha256(options.timelinePath) },
      caption_draft: captionDraft,
      content: {
        source: "canonical_timeline",
        sha256: hashJson(contentPlan),
        element_count: contentPlan.visual_elements?.length ?? 0,
      },
      audio: {
        source: audioPlan ? "audio_render_plan" : "canonical_timeline",
        sha256: audioPlan?.sha256 ?? hashJson(audioProjection),
        path: audioPlan?.path ?? null,
        clip_ids: audioClips.map((clip) => clip.clip_id).sort(),
      },
      source_assets: sourceAssets,
      ...(captionVisualTreatmentInput ? { caption_visual_treatment: captionVisualTreatmentSummary(options.projectDir, captionVisualTreatmentInput) } : {}),
    },
    render_scope: {
      video: "canonical_render",
      captions: captionClipIDs.length > 0 ? "unverified" : "not_requested",
      content_overlays: overlayIds.length > 0 ? "unverified" : "not_requested",
      audio: audioClips.length > 0 ? "unverified" : "not_requested",
      note: "Baseline fast preview reuses the canonical render route and applies only the declared range/fast encode; it is not final approval.",
    },
    render_range: {
      start_frame: previewRange.startFrame,
      end_frame: previewRange.endFrame,
      expected_frames: selectedFrames,
    },
    canonical_route_receipt: null,
    canonical_route_evidence: null,
    actual_output: null,
    applied_layers: {
      captions: {
        expected_clip_ids: captionClipIDs,
        applied_clip_ids: [],
        status: captionClipIDs.length > 0 ? "not_applied" : "not_requested",
        evidence: captionClipIDs.length > 0 ? "canonical_route_not_run" : "no_caption_input",
      },
      audio: {
        expected_clip_ids: audioClips.map((clip) => clip.clip_id).sort(),
        applied_clip_ids: [],
        status: audioClips.length > 0 ? "not_applied" : "not_requested",
        evidence: audioClips.length > 0 ? "canonical_route_not_run" : "timeline_has_no_audio_clips",
      },
      content_overlays: {
        expected_clip_ids: overlayIds,
        applied_clip_ids: [],
        unapplied_clip_ids: overlayIds,
        status: overlayIds.length > 0 ? "not_applied" : "not_requested",
        evidence: overlayIds.length > 0 ? "canonical_route_not_run" : "timeline_has_no_content_overlays",
      },
    },
    parity: {
      status: "unverified",
      compared_with: "canonical_timeline",
      frame_geometry: {
        expected_width: timeline.sequence.width,
        expected_height: timeline.sequence.height,
        rendered_width: null,
        rendered_height: null,
        fps_num: timeline.sequence.fps_num,
        fps_den: timeline.sequence.fps_den,
        rendered_fps_num: null,
        rendered_fps_den: null,
        matches: true,
      },
      duration: {
        canonical_video_frames: Math.max(
          0,
          timeline.tracks.video.flatMap((track) => track.clips).reduce(
            (maxFrame, clip) => Math.max(maxFrame, clip.timeline_in_frame + clip.timeline_duration_frames),
            0,
          ),
        ),
        selected_video_frames: selectedFrames,
        rendered_frames: null,
        matches: null,
      },
      captions: {
        expected_clip_ids: captionClipIDs,
        applied_clip_ids: [],
        matches: captionClipIDs.length === 0 ? true : null,
        verification: captionClipIDs.length === 0 ? "not_requested" : "not_applied",
      },
      audio: {
        expected_clip_ids: audioClips.map((clip) => clip.clip_id).sort(),
        applied_clip_ids: [],
        matches: audioClips.length === 0 ? true : null,
        verification: audioClips.length === 0 ? "not_requested" : "not_applied",
      },
      major_overlays: {
        expected_clip_ids: overlayIds,
        resolved_clip_ids: [],
        unapplied_clip_ids: overlayIds,
        matches: overlayIds.length === 0 ? true : null,
        verification: overlayIds.length === 0 ? "not_requested" : "not_applied",
      },
      ...(captionVisualTreatmentInput ? {
        caption_visual_treatment: {
          resolved_input_hash: captionVisualTreatmentInput.input_hash,
          text_timing_hash: captionVisualTreatmentInput.text_timing_hash,
          platform_safe_zone_profile_id: captionVisualTreatmentInput.platform_safe_zone_profile_id ?? null,
          platform_safe_zone_profile_path: captionVisualTreatmentInput.platform_safe_zone_profile_path ?? null,
          platform_safe_zone_profile_hash: captionVisualTreatmentInput.platform_safe_zone_profile_hash ?? null,
          accessibility: captionVisualTreatmentInput.accessibility ?? null,
          status: captionVisualTreatmentInput.status,
          route: "ffmpeg-libass" as const,
          matches: null,
          verification: "not_applied" as const,
        },
      } : {}),
    },
  };
}

export function defaultBaselineFastOutputPath(
  projectDir: string,
  beatId?: string,
  firstNSec?: number,
): string {
  const suffix = beatId ? `-${beatId}` : firstNSec ? `-first${firstNSec}s` : "-full";
  return path.join(projectDir, "05_timeline", `preview-baseline-fast${suffix}.mp4`);
}

export async function renderBaselineFastPreview(
  options: PreviewSegmentOptions,
): Promise<PreviewSegmentResult> {
  const visualTreatmentInput = resolveBaselineCaptionVisualTreatment(
    options.projectDir,
    findCaptionInput(options.projectDir),
    options.captionVisualTreatmentInput,
    options.captionVisualTreatmentReviewOnlyPreapproval,
  );
  const contract = buildBaselineFastPreviewContract({
    ...options,
    captionVisualTreatmentInput: visualTreatmentInput,
  });
  const timeline = JSON.parse(fs.readFileSync(options.timelinePath, "utf8")) as TimelineLike;
  const selected = selectedVideoClips(timeline, options);
  const previewRange = {
    startFrame: contract.render_range.start_frame,
    endFrame: contract.render_range.end_frame,
  };
  for (const clip of selected) {
    if (!resolveSourcePath(options.sourceMap, clip.asset_id)) {
      throw new Error(
        `Source file not found for asset ${clip.asset_id}. `
        + "Ensure source_map.json exists in 02_media/ with valid paths.",
      );
    }
  }
  const outputPath = options.outputPath ?? defaultBaselineFastOutputPath(options.projectDir, options.beatId, options.firstNSec);
  const captionDocument = readCaptionInputDocument(options.projectDir, contract.inputs.caption_draft);
  const captionClipIDs = captionIDs(captionDocument);
  const contentPlan = loadContentRenderPlan(options.timelinePath);
  const routeDecision = resolveRenderRoute({
    requestedEngine: "auto",
    contentPlan,
    aspectRatio: timeline.sequence.width === timeline.sequence.height
      ? "1:1"
      : timeline.sequence.width > timeline.sequence.height ? "16:9" : "9:16",
    captionsEnabled: Boolean(contract.inputs.caption_draft)
      || (timeline.tracks.caption?.some((track) => track.clips.length > 0) ?? false),
  });
  const routeWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-baseline-canonical-"));
  const routeReceiptPath = `${outputPath}.render-route.json`;
  try {
    const pipelineResult = await runRenderPipeline({
      projectDir: options.projectDir,
      timelinePath: options.timelinePath,
      captionApprovalPath: contract.inputs.caption_draft
        ? path.join(options.projectDir, contract.inputs.caption_draft.path)
        : undefined,
      ...(visualTreatmentInput ? {
        typographyPolicyPath: "04_plan/typography_policy.json",
        visualTreatmentPatchPath: "07_package/caption_visual_treatment_patch.json",
        captionVisualTreatmentInput: visualTreatmentInput,
        captionVisualTreatmentReviewOnlyPreapproval: options.captionVisualTreatmentReviewOnlyPreapproval,
      } : {}),
      captionPolicy: baselineCaptionPolicy(captionDocument),
      outputDir: routeWorkDir,
      fps: timeline.sequence.fps_num / timeline.sequence.fps_den,
      assemblyEngine: routeDecision.assembly_engine,
      assemblyOutputPath: path.join(routeWorkDir, "assembly.mp4"),
      sourceMap: sourceOverridesFromLoadedMap(options.sourceMap, options.projectDir),
      renderRouteDecision: routeDecision,
      assertMediaWriteReadyImpl: options.assertMediaWriteReadyImpl,
    });
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const rangeDurationSec = (previewRange.endFrame - previewRange.startFrame)
      * timeline.sequence.fps_den / timeline.sequence.fps_num;
    await execFilePromise("ffmpeg", [
      "-y",
      "-ss", (previewRange.startFrame * timeline.sequence.fps_den / timeline.sequence.fps_num).toFixed(6),
      "-i", pipelineResult.finalVideoPath,
      "-t", rangeDurationSec.toFixed(6),
      "-map", "0:v:0",
      "-map", "0:a?",
      "-r", `${timeline.sequence.fps_num}/${timeline.sequence.fps_den}`,
      "-fps_mode", "cfr",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "28",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "128k",
      outputPath,
    ], options.execFileImpl);

    const probe = await probeBaselineOutput(outputPath, options.execFileImpl);
    const expectedWidth = timeline.sequence.width;
    const expectedHeight = timeline.sequence.height;
    const geometryMatches = probe.width === expectedWidth
      && probe.height === expectedHeight
      && probe.fpsNum * timeline.sequence.fps_den === timeline.sequence.fps_num * probe.fpsDen;
    const durationMatches = probe.videoFrameCount === contract.render_range.expected_frames;

    const appliedCaptionIDs = captionClipIDs.length > 0 && Boolean(pipelineResult.logs.caption_burn)
      ? captionClipIDs
      : [];
    const expectedAudioIDs = contract.inputs.audio.clip_ids;
    const audioReceipt = expectedAudioIDs.length > 0
      ? audioReceiptAppliedClipIDs(pipelineResult.audioMixReportPath, expectedAudioIDs, probe.audioStreamCount)
      : { applied: [], status: "not_requested" as const, evidence: "timeline_has_no_audio_clips" };
    const appliedAudioIDs = audioReceipt.applied;
    const overlayResult = renderRouteReceiptAppliedOverlayIDs(
      pipelineResult.renderRouteReceiptPath,
      contract.parity.major_overlays.expected_clip_ids,
      routeDecision.visual_layers,
      contentPlan,
    );
    const appliedLayers: BaselineFastPreviewContract["applied_layers"] = {
      captions: {
        expected_clip_ids: captionClipIDs,
        applied_clip_ids: appliedCaptionIDs,
        status: captionClipIDs.length === 0
          ? "not_requested"
          : appliedCaptionIDs.length === captionClipIDs.length ? "verified" : "not_applied",
        evidence: appliedCaptionIDs.length > 0
          ? "canonical_render_pipeline.caption_burn"
          : "canonical_render_pipeline.did_not_apply_caption_layer",
      },
      audio: {
        expected_clip_ids: expectedAudioIDs,
        applied_clip_ids: appliedAudioIDs,
        status: audioReceipt.status,
        evidence: audioReceipt.evidence,
      },
      content_overlays: {
        expected_clip_ids: contract.parity.major_overlays.expected_clip_ids,
        applied_clip_ids: overlayResult.applied,
        unapplied_clip_ids: overlayResult.unapplied,
        status: overlayResult.applied.length === 0 && overlayResult.unapplied.length === 0
          ? "not_requested"
          : overlayResult.unapplied.length === 0 ? "verified" : overlayResult.applied.length > 0 ? "partial" : "not_applied",
        evidence: overlayResult.applied.length > 0
          ? "canonical_render_pipeline.render_layer_receipts"
          : "canonical_render_pipeline.did_not_apply_overlay_layer",
      },
    };
    const captionMatches = captionClipIDs.length === 0
      ? true
      : appliedCaptionIDs.length === captionClipIDs.length;
    const audioMatches = expectedAudioIDs.length === 0
      ? true
      : audioReceipt.status === "verified";
    const overlayMatches = overlayResult.unapplied.length === 0;
    const allLayersMatch = captionMatches && audioMatches && overlayMatches;
    const sourceInputsPinned = contract.inputs.source_assets.every((asset) => asset.status === "pinned");
    const parityStatus: BaselineFastPreviewContract["parity"]["status"] = geometryMatches && durationMatches && allLayersMatch && sourceInputsPinned
      ? "verified"
      : geometryMatches && durationMatches && (captionClipIDs.length > 0 || expectedAudioIDs.length > 0 || contract.parity.major_overlays.expected_clip_ids.length > 0)
        ? "partial"
        : "unverified";

    fs.copyFileSync(pipelineResult.renderRouteReceiptPath, routeReceiptPath);
    const previewVisualInputPath = `${outputPath}.caption-visual-treatment-input.json`;
    if (pipelineResult.captionVisualTreatmentInputPath) {
      fs.copyFileSync(pipelineResult.captionVisualTreatmentInputPath, previewVisualInputPath);
    }
    const outputStat = fs.statSync(outputPath);
    const actualOutput: NonNullable<BaselineFastPreviewContract["actual_output"]> = {
      path: path.relative(options.projectDir, outputPath),
      sha256: computeSha256(outputPath),
      size_bytes: outputStat.size,
      ffprobe: {
        width: probe.width,
        height: probe.height,
        fps_num: probe.fpsNum,
        fps_den: probe.fpsDen,
        duration_sec: probe.durationSec,
        video_frame_count: probe.videoFrameCount,
        video_stream_count: probe.videoStreamCount,
        audio_stream_count: probe.audioStreamCount,
      },
    };
    const routeReceiptDocument = JSON.parse(fs.readFileSync(routeReceiptPath, "utf8")) as {
      caption_visual_treatment?: { input_hash?: string; status?: CaptionVisualTreatmentInput["status"] };
      route_evidence?: RenderRouteEvidence;
    };
    const visualTreatmentMatches = visualTreatmentInput
      ? routeReceiptDocument.caption_visual_treatment?.input_hash === visualTreatmentInput.input_hash
      : true;
    const enriched: BaselineFastPreviewContract & Record<string, unknown> = {
      ...contract,
      render_scope: {
        ...contract.render_scope,
        captions: appliedLayers.captions.status === "verified" ? "applied" : appliedLayers.captions.status === "not_requested" ? "not_requested" : "not_applied",
        content_overlays: appliedLayers.content_overlays.status === "verified" ? "applied" : appliedLayers.content_overlays.status,
        audio: appliedLayers.audio.status === "verified" ? "applied" : appliedLayers.audio.status === "not_requested" ? "not_requested" : "not_applied",
      },
      canonical_route_receipt: {
        path: path.relative(options.projectDir, routeReceiptPath),
        sha256: computeSha256(routeReceiptPath),
      },
      canonical_route_evidence: routeReceiptDocument.route_evidence ?? null,
      actual_output: actualOutput,
      applied_layers: appliedLayers,
      parity: {
        ...contract.parity,
        status: parityStatus,
        frame_geometry: {
          ...contract.parity.frame_geometry,
          rendered_width: probe.width,
          rendered_height: probe.height,
          rendered_fps_num: probe.fpsNum,
          rendered_fps_den: probe.fpsDen,
          matches: geometryMatches,
        },
        duration: {
          ...contract.parity.duration,
          rendered_frames: probe.videoFrameCount,
          matches: durationMatches,
        },
        captions: {
          expected_clip_ids: captionClipIDs,
          applied_clip_ids: appliedCaptionIDs,
          matches: captionMatches,
          verification: captionClipIDs.length === 0 ? "not_requested" : appliedCaptionIDs.length > 0 ? "render_layer_receipt" : "not_applied",
        },
        audio: {
          expected_clip_ids: expectedAudioIDs,
          applied_clip_ids: appliedAudioIDs,
          matches: audioMatches,
          verification: expectedAudioIDs.length === 0 ? "not_requested" : audioReceipt.status === "not_applied" ? "not_applied" : "render_layer_receipt",
        },
        major_overlays: {
          expected_clip_ids: contract.parity.major_overlays.expected_clip_ids,
          resolved_clip_ids: overlayResult.applied,
          unapplied_clip_ids: overlayResult.unapplied,
          matches: overlayMatches,
          verification: contract.parity.major_overlays.expected_clip_ids.length === 0
            ? "not_requested"
            : overlayResult.applied.length > 0 ? "render_layer_receipt" : "not_applied",
        },
        ...(visualTreatmentInput ? {
          caption_visual_treatment: {
            resolved_input_hash: visualTreatmentInput.input_hash,
            text_timing_hash: visualTreatmentInput.text_timing_hash,
            platform_safe_zone_profile_id: visualTreatmentInput.platform_safe_zone_profile_id ?? null,
            platform_safe_zone_profile_path: visualTreatmentInput.platform_safe_zone_profile_path ?? null,
            platform_safe_zone_profile_hash: visualTreatmentInput.platform_safe_zone_profile_hash ?? null,
            accessibility: visualTreatmentInput.accessibility ?? null,
            status: routeReceiptDocument.caption_visual_treatment?.status ?? visualTreatmentInput.status,
            route: routeDecision.caption_layer.engine,
            matches: visualTreatmentMatches,
            verification: visualTreatmentMatches ? "route_receipt" as const : "not_applied" as const,
          },
        } : {}),
      },
    };
    const receiptPath = `${outputPath}.receipt.json`;
    const temporaryReceiptPath = `${receiptPath}.tmp-${process.pid}`;
    fs.writeFileSync(temporaryReceiptPath, `${JSON.stringify({
      preview_path: path.relative(options.projectDir, outputPath),
      preview_sha256: actualOutput.sha256,
      preview_size_bytes: outputStat.size,
      preview_mtime_ms: Math.round(outputStat.mtimeMs),
      timeline_path: path.relative(options.projectDir, options.timelinePath),
      timeline_sha256: computeSha256(options.timelinePath),
      caption_input: contract.inputs.caption_draft
        ? { path: contract.inputs.caption_draft.path, sha256: contract.inputs.caption_draft.sha256 }
        : null,
      created_at: new Date().toISOString(),
      ...enriched,
      version: "timeline-preview-receipt/v1",
    }, null, 2)}\n`, "utf8");
    fs.renameSync(temporaryReceiptPath, receiptPath);
    return {
      outputPath,
      clipCount: selected.length,
      durationSec: probe.durationSec,
      receiptPath,
    };
  } finally {
    fs.rmSync(routeWorkDir, { recursive: true, force: true });
  }
}
