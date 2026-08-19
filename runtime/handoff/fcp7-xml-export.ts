/**
 * FCP7 XML Exporter — TimelineIR → Premiere Pro compatible XML
 *
 * Generates xmeml v5 (Final Cut Pro 7 XML) that Adobe Premiere Pro
 * can import via File → Import. This is the most reliable interchange
 * format for Premiere Pro across versions.
 *
 * Key design decisions (from premiere-v1.yaml known_quirks):
 * - ASCII-only id attributes (CJK chars cause import failure)
 * - Percent-encoded pathurl for non-ASCII file paths
 * - file elements defined inline on first use, then back-referenced by id
 * - Gaps represented by absence (no clipitem in time range)
 * - generatoritem with Slug for black/placeholder segments
 * - Audio samplecharacteristics with samplerate + depth
 * - Sequence-level timecode element required
 */

import type {
  TimelineIR,
  TrackOutput,
  ClipOutput,
  TimelineTransitionOutput,
} from "../compiler/types.js";
import {
  dbToLinearGain,
  linearGainToDb,
  resolveAudioGainWithFallback,
} from "../../editor/shared/audio-gain.js";
import {
  assertPremiereVideoRepresentations,
  type PremiereBakedRepresentation,
} from "./premiere-effect-bake.js";

export { dbToLinearGain, linearGainToDb } from "../../editor/shared/audio-gain.js";

// ── Public API ────────────────────────────────────────────────────

export interface Fcp7ExportOptions {
  /** Map asset_id → absolute file path on disk */
  sourceMap: Map<string, string>;
  /** Map asset_id → total asset duration in microseconds (for accurate <file> duration) */
  assetDurationMap?: Map<string, number>;
  /** Map asset_id → human-readable display name (used for clip names in XML) */
  assetDisplayNameMap?: Map<string, string>;
  /** Project ID for deriving exchange clip IDs */
  projectId?: string;
  /** Timeline version for deriving exchange clip IDs */
  timelineVersion?: string;
  /** Receipt-bound Premiere roundtrip session ID */
  roundtripId?: string;
  /** Sample rate for audio (default: 48000) */
  sampleRate?: number;
  /** Audio bit depth (default: 16) */
  audioBitDepth?: number;
  /** Additional markers to embed (e.g. section labels) */
  extraMarkers?: ExtraMarker[];
  /**
   * Text overlays rendered as Outline Text generators on a dedicated V-Title track.
   * Each overlay becomes a visible text element in the Premiere timeline.
   */
  textOverlays?: TextOverlay[];
  /** True when --titles or --auto-titles was explicitly requested, even if it resolved empty. */
  legacyTitlesRequested?: boolean;
  /** Verified, provenance-bound video-only replacements for treated clips. */
  videoRepresentations?: Map<string, PremiereBakedRepresentation>;
}

export function resolveFcp7AudioLevelsEmissionDecision(
  clip: ClipOutput,
  mix: TimelineIR["audio_mix"],
) {
  const ap = clip.audio_policy;
  if (!ap && !mix) return null;

  const isBgm = clip.role === "bgm" || clip.role === "music";
  const gain = resolveAudioGainWithFallback(ap, mix, isBgm ? "bgm" : "nat_sound", {
    fallbackToDuckMusicDb: isBgm,
  });
  const fadeInFrames: number | undefined = isBgm
    ? (ap?.bgm_fade_in_frames ?? ap?.fade_in_frames ?? mix?.bgm_fade_in_frames ?? mix?.fade_in_frames)
    : (ap?.nat_sound_fade_in_frames ?? ap?.fade_in_frames ?? mix?.nat_sound_fade_in_frames ?? mix?.fade_in_frames);
  const fadeOutFrames: number | undefined = isBgm
    ? (ap?.bgm_fade_out_frames ?? ap?.fade_out_frames ?? mix?.bgm_fade_out_frames ?? mix?.fade_out_frames)
    : (ap?.nat_sound_fade_out_frames ?? ap?.fade_out_frames ?? mix?.nat_sound_fade_out_frames ?? mix?.fade_out_frames);
  const hasFadeIn = fadeInFrames !== undefined && fadeInFrames > 0;
  const hasFadeOut = fadeOutFrames !== undefined && fadeOutFrames > 0;

  if (gain.sourceField === null && !hasFadeIn && !hasFadeOut) return null;

  return {
    linearGain: gain.sourceField !== null ? gain.gainLinear : 1.0,
    fadeInFrames,
    fadeOutFrames,
    hasFadeIn,
    hasFadeOut,
  };
}

export interface TextOverlay {
  /** Timeline start frame */
  startFrame: number;
  /** Duration in frames */
  durationFrames: number;
  /** Text content (supports \n for line breaks) */
  text: string;
  /** Font size in points (default: 48) */
  fontSize?: number;
  /** Text color as [r, g, b] 0-255 (default: [255, 255, 255] white) */
  color?: [number, number, number];
  /** Opacity 0-100 (default: 100) */
  opacity?: number;
  /** Vertical position: top, center, lower-third (default: "lower-third") */
  position?: "top" | "center" | "lower-third";
  /** Optional label shown in Premiere's clip name (defaults to text) */
  label?: string;
}

export interface CanonicalTextOverlayExportIssue {
  track_id: string;
  clip_id: string;
  overlay_id?: string;
  field: string;
  reason: string;
  disposition: "blocked";
}

export class CanonicalTextOverlayExportError extends Error {
  readonly issues: CanonicalTextOverlayExportIssue[];

  constructor(issues: CanonicalTextOverlayExportIssue[]) {
    super(`canonical text-overlay export blocked: ${JSON.stringify(issues)}`);
    this.name = "CanonicalTextOverlayExportError";
    this.issues = issues;
  }
}

export interface SimpleTransitionExportIssue {
  transition_id: string;
  field: string;
  reason: string;
  disposition: "blocked";
}

export class SimpleTransitionExportError extends Error {
  readonly issues: SimpleTransitionExportIssue[];

  constructor(issues: SimpleTransitionExportIssue[]) {
    super(`simple-transition export blocked: ${JSON.stringify(issues)}`);
    this.name = "SimpleTransitionExportError";
    this.issues = issues;
  }
}

interface ResolvedTextOverlay extends TextOverlay {
  generatorId: string;
  anchor: CanonicalAnchor;
  canonical?: {
    trackId: string;
    clipId: string;
    overlayId: string;
    roundtripId: string;
  };
}

type CanonicalAnchor =
  | "top_left"
  | "top_center"
  | "top_right"
  | "center"
  | "bottom_left"
  | "bottom_center"
  | "bottom_right";

const UNREPRESENTABLE_CANONICAL_PRESETS: Record<string, readonly string[]> = {
  "vos:overlay.title-card": ["font_family", "font_weight", "line_height", "text_shadow", "safe_area", "fade", "translate"],
  "vos:overlay.hook-title": ["font_family", "font_weight", "letter_spacing", "text_stroke", "text_shadow", "safe_area", "fade", "scale", "rotate", "flash", "accent"],
  "vos:overlay.cta-card": ["font_family", "font_weight", "text_shadow", "safe_area", "fade", "translate", "background", "action", "brand"],
  "vos:overlay.lower-third": ["font_family", "font_weight", "line_height", "text_shadow", "safe_area", "fade", "translate", "panel", "accent_border"],
  "vos:overlay.chapter-kicker": ["font_family", "font_weight", "line_height", "text_shadow", "safe_area", "fade"],
  "vos:overlay.location-tag": ["font_family", "font_weight", "line_height", "text_shadow", "safe_area", "fade", "panel", "uppercase"],
  "vos:overlay.credit": ["font_family", "font_weight", "line_height", "text_shadow", "safe_area", "fade"],
  "vos:overlay.emphasis-word": ["font_family", "font_weight", "text_stroke", "text_shadow", "safe_area", "fade", "scale", "accent_color"],
};

const CANONICAL_ANCHORS = new Set<CanonicalAnchor>([
  "top_left", "top_center", "top_right", "center",
  "bottom_left", "bottom_center", "bottom_right",
]);

const CANONICAL_ANCHOR_ORIGINS: Record<CanonicalAnchor, [number, number]> = {
  top_left: [-0.35, 0.35],
  top_center: [0, 0.35],
  top_right: [0.35, 0.35],
  center: [0, 0],
  bottom_left: [-0.35, -0.3],
  bottom_center: [0, -0.3],
  bottom_right: [0.35, -0.3],
};

function safeGeneratorIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => {
    const code = ch.charCodeAt(0);
    return code > 127 ? `x${code.toString(16)}` : "_";
  });
}

/** Stable ID used by the historical marked-generator parser and receipt manifest. */
export function fcp7TextGeneratorItemId(clipId: string, overlayId: string): string {
  return `title-${safeGeneratorIdPart(clipId)}-${safeGeneratorIdPart(overlayId)}`;
}

function canonicalIssue(
  trackId: string,
  clip: ClipOutput,
  field: string,
  reason: string,
  overlayId?: string,
): CanonicalTextOverlayExportIssue {
  return {
    track_id: trackId,
    clip_id: typeof clip.clip_id === "string" ? clip.clip_id : "",
    ...(overlayId ? { overlay_id: overlayId } : {}),
    field,
    reason,
    disposition: "blocked",
  };
}

function resolveCanonicalTextOverlays(
  timeline: TimelineIR,
  roundtripId: string | undefined,
): ResolvedTextOverlay[] {
  const resolved: ResolvedTextOverlay[] = [];
  const clipIds = new Set<string>();
  const overlayIds = new Set<string>();
  const generatorIds = new Set<string>();
  const unrepresentableStyleIssues: CanonicalTextOverlayExportIssue[] = [];

  for (const track of timeline.tracks.overlay ?? []) {
    for (const clip of track.clips) {
      const metadata = clip.metadata;
      const rawOverlay = metadata && typeof metadata === "object"
        ? metadata.overlay
        : undefined;
      const overlay = rawOverlay && typeof rawOverlay === "object" && !Array.isArray(rawOverlay)
        ? rawOverlay as Record<string, unknown>
        : undefined;
      const overlayId = typeof overlay?.overlay_id === "string" ? overlay.overlay_id : undefined;
      const fail = (field: string, reason: string): never => {
        throw new CanonicalTextOverlayExportError([
          canonicalIssue(track.track_id, clip, field, reason, overlayId),
        ]);
      };

      if (track.kind !== "overlay") fail("kind", "track kind must be overlay");
      if (clip.role !== "title") fail("role", "overlay clip role must be title");
      if (!overlay) fail("metadata.overlay", "canonical overlay metadata object is required");
      const canonicalOverlay = overlay!;
      if (typeof clip.clip_id !== "string" || clip.clip_id.trim() === "") {
        fail("clip_id", "clip_id must be non-empty");
      }
      if (!overlayId || overlayId.trim() === "") {
        fail("metadata.overlay.overlay_id", "overlay_id must be non-empty");
      }
      if (typeof canonicalOverlay.text !== "string" || canonicalOverlay.text.trim() === "") {
        fail("metadata.overlay.text", "text must be non-empty");
      }
      if (canonicalOverlay.source !== "authored") {
        fail("metadata.overlay.source", "canonical title source must be authored");
      }
      if (canonicalOverlay.writing_mode !== "horizontal_tb") {
        fail("metadata.overlay.writing_mode", "only horizontal_tb is exactly representable");
      }
      if (typeof canonicalOverlay.anchor !== "string" || !CANONICAL_ANCHORS.has(canonicalOverlay.anchor as CanonicalAnchor)) {
        fail("metadata.overlay.anchor", "anchor is not one of the seven canonical anchors");
      }
      if (Object.hasOwn(canonicalOverlay, "safe_area")) {
        fail("metadata.overlay.safe_area", "safe-area behavior is not represented by Outline Text");
      }
      for (const field of ["background", "outline", "animation"] as const) {
        if (Object.hasOwn(canonicalOverlay, field)) {
          fail(`metadata.overlay.${field}`, `${field} behavior is not represented by Outline Text`);
        }
      }
      const canonicalFields = new Set([
        "overlay_id", "text", "styling_class", "writing_mode", "anchor", "source",
        "safe_area", "background", "outline", "animation",
      ]);
      const unsupportedField = Object.keys(canonicalOverlay).find((field) => !canonicalFields.has(field));
      if (unsupportedField) {
        fail(`metadata.overlay.${unsupportedField}`, "overlay field has no exact Outline Text projection");
      }
      const start = clip.timeline_in_frame;
      const duration = clip.timeline_duration_frames;
      const end = start + duration;
      if (!Number.isSafeInteger(start) || start < 0) {
        fail("timeline_in_frame", "start must be a non-negative safe integer");
      }
      if (!Number.isSafeInteger(duration) || duration <= 0) {
        fail("timeline_duration_frames", "duration must be a positive safe integer");
      }
      if (!Number.isSafeInteger(end) || end <= start) {
        fail("timeline_range", "generator end is invalid or exceeds safe integer range");
      }
      if (clipIds.has(clip.clip_id)) fail("clip_id", "duplicate canonical clip_id");
      if (overlayIds.has(overlayId!)) {
        fail("metadata.overlay.overlay_id", "duplicate canonical overlay_id");
      }
      const generatorId = fcp7TextGeneratorItemId(clip.clip_id, overlayId!);
      if (generatorIds.has(generatorId)) fail("generator_id", "canonical generator ID collision");
      clipIds.add(clip.clip_id);
      overlayIds.add(overlayId!);
      generatorIds.add(generatorId);
      if (!roundtripId) fail("roundtrip_id", "canonical overlays require a roundtrip_id");
      const stylingClass = typeof canonicalOverlay.styling_class === "string"
        ? canonicalOverlay.styling_class
        : "";
      const requiredSemantics = UNREPRESENTABLE_CANONICAL_PRESETS[stylingClass];
      unrepresentableStyleIssues.push(
        canonicalIssue(
          track.track_id,
          clip,
          "metadata.overlay.styling_class",
          requiredSemantics
            ? `canonical preset ${stylingClass} requires unrepresentable semantics: ${requiredSemantics.join(", ")}`
            : `styling_class ${stylingClass || "<missing>"} has no exact Outline Text projection`,
          overlayId,
        ),
      );
    }
  }
  if (unrepresentableStyleIssues.length > 0) {
    throw new CanonicalTextOverlayExportError(unrepresentableStyleIssues);
  }
  return resolved;
}

function resolveLegacyTextOverlays(overlays: TextOverlay[]): ResolvedTextOverlay[] {
  return overlays.map((overlay, index) => {
    const start = overlay.startFrame;
    const duration = overlay.durationFrames;
    const end = start + duration;
    if (
      !Number.isSafeInteger(start) || start < 0 ||
      !Number.isSafeInteger(duration) || duration <= 0 ||
      !Number.isSafeInteger(end) || end <= start
    ) {
      throw new Error(`invalid legacy title range at index ${index}`);
    }
    const anchor: CanonicalAnchor = overlay.position === "top"
      ? "top_center"
      : overlay.position === "center" ? "center" : "bottom_center";
    return { ...overlay, anchor, generatorId: `legacy-title-${index + 1}` };
  });
}

export interface ExtraMarker {
  /** Timeline frame where marker appears */
  timelineFrame: number;
  /** Duration in frames (0 = point marker) */
  durationFrames?: number;
  /** Marker label */
  name: string;
  /** Marker comment */
  comment?: string;
  /** FCP7 marker color: red, orange, yellow, green, cyan, blue, purple, pink */
  color?: string;
}

/**
 * Convert a TimelineIR to FCP7 XML string.
 * Returns valid xmeml v5 XML ready for Premiere Pro import.
 */
export function timelineToFcp7Xml(
  timeline: TimelineIR,
  options: Fcp7ExportOptions,
): string {
  const ctx = new ExportContext(timeline, options);
  return ctx.build();
}

/** Derive the exact ASCII-safe clipitem ID emitted by this exporter. */
export function fcp7ClipItemId(prefix: "cv" | "ca", id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, (ch) => {
    const code = ch.charCodeAt(0);
    return code > 127 ? `x${code.toString(16)}` : "_";
  });
  return `${prefix}-${safe}`;
}

// ── Internal Implementation ───────────────────────────────────────

class ExportContext {
  private timeline: TimelineIR;
  private opts: Fcp7ExportOptions;
  private fileIdMap = new Map<string, string>(); // asset_id → file-N
  private definedFiles = new Set<string>(); // asset_ids whose <file> has been emitted inline
  private fileCounter = 0;
  private fps: number;
  private fpsNum: number;
  private fpsDen: number;
  private isNtsc: boolean;
  private timebase: number;
  private sampleRate: number;
  private audioBitDepth: number;
  private textOverlays: ResolvedTextOverlay[];

  constructor(timeline: TimelineIR, opts: Fcp7ExportOptions) {
    this.timeline = timeline;
    this.opts = opts;
    this.fpsNum = timeline.sequence.fps_num;
    this.fpsDen = timeline.sequence.fps_den || 1;
    this.fps = this.fpsNum / this.fpsDen;

    // NTSC detection: 29.97 (30000/1001), 23.976 (24000/1001), 59.94 (60000/1001)
    this.isNtsc = this.fpsDen === 1001;
    // For NTSC, timebase is the rounded-up integer (30, 24, 60)
    // For non-NTSC, timebase equals the integer fps
    this.timebase = this.isNtsc
      ? Math.round(this.fpsNum / 1000)
      : this.fpsNum;

    this.sampleRate = opts.sampleRate ?? 48000;
    this.audioBitDepth = opts.audioBitDepth ?? 16;
    assertPremiereVideoRepresentations(timeline, opts.videoRepresentations);
    this.validateSimpleTransitions();
    const canonical = resolveCanonicalTextOverlays(timeline, opts.roundtripId);
    const legacy = resolveLegacyTextOverlays(opts.textOverlays ?? []);
    if (canonical.length > 0 && (opts.legacyTitlesRequested || legacy.length > 0)) {
      throw new CanonicalTextOverlayExportError([{
        track_id: canonical[0].canonical!.trackId,
        clip_id: canonical[0].canonical!.clipId,
        overlay_id: canonical[0].canonical!.overlayId,
        field: "legacy_titles",
        reason: "canonical overlays cannot be combined with legacy titles",
        disposition: "blocked",
      }]);
    }
    this.textOverlays = canonical.length > 0 ? canonical : legacy;
  }

  private validateSimpleTransitions(): void {
    const issues: SimpleTransitionExportIssue[] = [];
    const transitionIds = new Set<string>();
    const endpointPairs = new Set<string>();
    const fail = (transition: TimelineTransitionOutput, field: string, reason: string): void => {
      issues.push({
        transition_id: typeof transition.transition_id === "string" ? transition.transition_id : "",
        field,
        reason,
        disposition: "blocked",
      });
    };

    for (const transition of this.timeline.transitions ?? []) {
      if (!transition.transition_id || transitionIds.has(transition.transition_id)) {
        fail(transition, "transition_id", "transition_id must be non-empty and unique");
      } else {
        transitionIds.add(transition.transition_id);
      }
      const edgeKey = JSON.stringify([
        transition.track_id,
        transition.from_clip_id,
        transition.to_clip_id,
      ]);
      if (endpointPairs.has(edgeKey)) {
        fail(transition, "endpoints", "only one transition is allowed per track endpoint pair");
      } else {
        endpointPairs.add(edgeKey);
      }

      const matchingTracks = this.timeline.tracks.video.filter(
        (track) => track.track_id === transition.track_id,
      );
      if (matchingTracks.length !== 1) {
        fail(transition, "track_id", "named video track must exist exactly once");
        continue;
      }
      const track = matchingTracks[0];
      const fromIndexes = track.clips.flatMap((clip, index) =>
        clip.clip_id === transition.from_clip_id ? [index] : [],
      );
      const toIndexes = track.clips.flatMap((clip, index) =>
        clip.clip_id === transition.to_clip_id ? [index] : [],
      );
      if (fromIndexes.length !== 1 || toIndexes.length !== 1) {
        fail(transition, "endpoints", "both endpoints must occur exactly once on the named video track");
        continue;
      }
      if (toIndexes[0] !== fromIndexes[0] + 1) {
        fail(transition, "endpoints", "transition endpoints must be adjacent in from/to order");
        continue;
      }
      if (!this.resolveTransitionEffect(transition)) {
        fail(transition, "transition_type", "only crossfade and match_cut_bridge/match_cut are supported");
      }
      const frames = transition.transition_frames;
      if (!Number.isSafeInteger(frames) || frames! <= 0) {
        fail(transition, "transition_frames", "duration must be an explicit positive integer");
        continue;
      }
      const fromClip = track.clips[fromIndexes[0]];
      const toClip = track.clips[toIndexes[0]];
      const fromEnd = fromClip.timeline_in_frame + fromClip.timeline_duration_frames;
      if (fromEnd !== toClip.timeline_in_frame) {
        fail(transition, "adjacency", "endpoint timeline intervals must meet at one cut frame");
        continue;
      }
      const start = toClip.timeline_in_frame - Math.floor(frames! / 2);
      const end = start + frames!;
      if (
        start < fromClip.timeline_in_frame ||
        start > fromEnd ||
        end < toClip.timeline_in_frame ||
        end > toClip.timeline_in_frame + toClip.timeline_duration_frames
      ) {
        fail(transition, "window", "centered transition window must stay inside the neighboring timeline intervals");
      }
    }

    if (issues.length > 0) throw new SimpleTransitionExportError(issues);
  }

  build(): string {
    const totalFrames = this.computeTotalFrames();
    const lines: string[] = [];

    lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
    lines.push(`<!DOCTYPE xmeml>`);
    // Metadata comment for roundtrip identification
    const projectId = this.opts.projectId || this.timeline.project_id;
    const generatedAt = this.timeline.created_at;
    lines.push(`<!-- Video OS v2 | project: ${this.escXml(projectId)} | generated: ${generatedAt} | compiler: ${this.escXml(this.timeline.provenance?.compiler_version ?? "unknown")} -->`);
    lines.push(`<xmeml version="5">`);
    lines.push(`  <sequence>`);
    lines.push(`    <name>${this.escXml(this.timeline.sequence.name)}</name>`);
    lines.push(`    <duration>${totalFrames}</duration>`);
    this.appendRate(lines, 4);
    this.appendTimecode(lines, 4, totalFrames);

    lines.push(`    <media>`);
    // Video section
    lines.push(`      <video>`);
    this.appendVideoFormat(lines, 8);
    for (const track of this.timeline.tracks.video) {
      this.appendVideoTrack(lines, track, 8);
    }
    // Text overlay track (V-Title) — rendered as Outline Text generators
    if (this.textOverlays.length > 0) {
      this.appendTextOverlayTrack(lines, this.textOverlays, 8);
    }
    lines.push(`      </video>`);

    // Audio section
    if (this.timeline.tracks.audio.length > 0) {
      lines.push(`      <audio>`);
      for (const track of this.timeline.tracks.audio) {
        this.appendAudioTrack(lines, track, 8);
      }
      lines.push(`      </audio>`);
    }

    lines.push(`    </media>`);
    lines.push(`  </sequence>`);
    lines.push(`</xmeml>`);
    lines.push(``);

    return lines.join("\n");
  }

  // ── Frames / Time Helpers ──

  private usToFrames(us: number): number {
    return Math.round((us / 1_000_000) * this.fps);
  }

  private computeTotalFrames(): number {
    let maxFrame = 0;
    for (const track of [
      ...this.timeline.tracks.video,
      ...this.timeline.tracks.audio,
    ]) {
      for (const clip of track.clips) {
        const end = clip.timeline_in_frame + clip.timeline_duration_frames;
        if (end > maxFrame) maxFrame = end;
      }
    }
    for (const overlay of this.textOverlays) {
      const end = overlay.startFrame + overlay.durationFrames;
      if (end > maxFrame) maxFrame = end;
    }
    return maxFrame;
  }

  // ── XML Building Helpers ──

  private indent(depth: number): string {
    return " ".repeat(depth);
  }

  private escXml(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  /** Convert an absolute file path to percent-encoded file:// URL */
  private pathToUrl(absPath: string): string {
    // Split path into segments and percent-encode each
    const segments = absPath.split("/");
    const encoded = segments
      .map((seg) =>
        seg
          .split("")
          .map((ch) => {
            const code = ch.charCodeAt(0);
            // Keep ASCII alphanumeric, hyphen, underscore, dot
            if (
              (code >= 0x30 && code <= 0x39) || // 0-9
              (code >= 0x41 && code <= 0x5a) || // A-Z
              (code >= 0x61 && code <= 0x7a) || // a-z
              ch === "-" ||
              ch === "_" ||
              ch === "."
            ) {
              return ch;
            }
            // Percent-encode everything else
            const bytes = new TextEncoder().encode(ch);
            return Array.from(bytes)
              .map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`)
              .join("");
          })
          .join(""),
      )
      .join("/");
    return `file://localhost${encoded}`;
  }

  /** Get or create a file id for an asset_id */
  private getFileId(assetId: string): string {
    const existing = this.fileIdMap.get(assetId);
    if (existing) return existing;
    this.fileCounter++;
    const id = `file-${this.fileCounter}`;
    this.fileIdMap.set(assetId, id);
    return id;
  }

  /** Check if file definition has been emitted already */
  private isFileDefined(assetId: string): boolean {
    return this.definedFiles.has(assetId);
  }

  /** Mark a file as having been emitted inline */
  private markFileDefined(assetId: string): void {
    this.definedFiles.add(assetId);
  }

  /** Resolve the best display name for a clip in the XML <name> element */
  private resolveClipDisplayName(clip: ClipOutput): string {
    if (this.opts.videoRepresentations?.has(clip.clip_id)) {
      return `[BAKED] ${this.opts.assetDisplayNameMap?.get(clip.asset_id) ?? clip.motivation ?? clip.clip_id}`;
    }
    // Priority: assetDisplayNameMap → motivation → clip_id
    const displayName = this.opts.assetDisplayNameMap?.get(clip.asset_id);
    if (displayName) return displayName;
    return clip.motivation || clip.clip_id;
  }

  // ── Structure Emitters ──

  private appendRate(lines: string[], depth: number): void {
    const d = this.indent(depth);
    lines.push(`${d}<rate>`);
    lines.push(`${d}  <timebase>${this.timebase}</timebase>`);
    lines.push(`${d}  <ntsc>${this.isNtsc ? "TRUE" : "FALSE"}</ntsc>`);
    lines.push(`${d}</rate>`);
  }

  private appendTimecode(
    lines: string[],
    depth: number,
    _totalFrames: number,
  ): void {
    const d = this.indent(depth);
    const fmt =
      this.timeline.sequence.timecode_format === "DF" ? "DF" : "NDF";
    lines.push(`${d}<timecode>`);
    this.appendRate(lines, depth + 2);
    lines.push(`${d}  <string>00:00:00:00</string>`);
    lines.push(`${d}  <frame>0</frame>`);
    lines.push(`${d}  <displayformat>${fmt}</displayformat>`);
    lines.push(`${d}</timecode>`);
  }

  private appendVideoFormat(lines: string[], depth: number): void {
    const d = this.indent(depth);
    const seq = this.timeline.sequence;
    lines.push(`${d}<format>`);
    lines.push(`${d}  <samplecharacteristics>`);
    this.appendRate(lines, depth + 4);
    lines.push(`${d}    <width>${seq.width}</width>`);
    lines.push(`${d}    <height>${seq.height}</height>`);
    lines.push(`${d}    <anamorphic>FALSE</anamorphic>`);
    lines.push(`${d}    <pixelaspectratio>square</pixelaspectratio>`);
    lines.push(`${d}    <fielddominance>none</fielddominance>`);
    lines.push(`${d}  </samplecharacteristics>`);
    lines.push(`${d}</format>`);
  }

  private appendFileDefinition(
    lines: string[],
    depth: number,
    assetId: string,
    fileId: string,
    clip: ClipOutput,
    isAudioOnly: boolean,
    filePathOverride?: string,
    videoOnly = false,
  ): void {
    const d = this.indent(depth);
    const filePath = filePathOverride ?? this.opts.sourceMap.get(assetId);
    if (!filePath) {
      lines.push(`${d}<file id="${fileId}"/>`);
      return;
    }

    // Prefer asset_duration from the duration map; fall back to src_out_us
    const totalDurUs =
      this.opts.assetDurationMap?.get(assetId) ?? clip.src_out_us;
    const totalFrames = this.usToFrames(totalDurUs);
    const fileName = filePath.split("/").pop() ?? assetId;

    lines.push(`${d}<file id="${fileId}">`);
    lines.push(`${d}  <name>${this.escXml(fileName)}</name>`);
    lines.push(`${d}  <duration>${totalFrames}</duration>`);
    this.appendRate(lines, depth + 2);
    lines.push(`${d}  <pathurl>${this.pathToUrl(filePath)}</pathurl>`);
    lines.push(`${d}  <media>`);

    if (!isAudioOnly) {
      lines.push(`${d}    <video>`);
      lines.push(`${d}      <samplecharacteristics>`);
      this.appendRate(lines, depth + 8);
      lines.push(
        `${d}        <width>${this.timeline.sequence.width}</width>`,
      );
      lines.push(
        `${d}        <height>${this.timeline.sequence.height}</height>`,
      );
      lines.push(`${d}      </samplecharacteristics>`);
      lines.push(`${d}    </video>`);
    }

    // Always include audio for MOV files
    const ext = (filePath.split(".").pop() ?? "").toLowerCase();
    if (!videoOnly && ext !== "jpg" && ext !== "jpeg" && ext !== "png" && ext !== "tiff") {
      lines.push(`${d}    <audio>`);
      lines.push(`${d}      <samplecharacteristics>`);
      lines.push(`${d}        <samplerate>${this.sampleRate}</samplerate>`);
      lines.push(`${d}        <depth>${this.audioBitDepth}</depth>`);
      lines.push(`${d}      </samplecharacteristics>`);
      lines.push(`${d}      <channelcount>2</channelcount>`);
      lines.push(`${d}    </audio>`);
    }

    lines.push(`${d}  </media>`);
    lines.push(`${d}</file>`);
  }

  private appendClipMarkers(
    lines: string[],
    depth: number,
    clip: ClipOutput,
  ): void {
    this.appendRoundtripMarker(lines, depth, clip);
    this.appendEditorialMarker(lines, depth, clip);
  }

  private appendRoundtripMarker(
    lines: string[],
    depth: number,
    clip: ClipOutput,
  ): void {
    const d = this.indent(depth);

    // Derive exchange_clip_id for roundtrip identification
    const exchangeClipId =
      this.opts.projectId && this.opts.timelineVersion
        ? `${this.opts.projectId}:${this.opts.timelineVersion}:${clip.clip_id}`
        : clip.clip_id;

    // Embed video_os metadata as JSON-encoded marker comment
    const baked = this.opts.videoRepresentations?.get(clip.clip_id);
    const payload = JSON.stringify(baked ? {
      clip_id: clip.clip_id,
      asset_id: clip.asset_id,
      beat_id: clip.beat_id,
      motivation: clip.motivation || "",
      roundtrip_id: this.opts.roundtripId,
        representation: "baked_visual",
        bake_request_id: baked.bake_request_id,
        derived_asset_id: baked.derived_asset_id,
        manifest_sha256: baked.manifest_sha256,
        output_sha256: baked.media_sha256,
        effect_editable: false,
    } : {
      exchange_clip_id: exchangeClipId,
      clip_id: clip.clip_id,
      asset_id: clip.asset_id,
      beat_id: clip.beat_id,
      motivation: clip.motivation || "",
      ...(this.opts.roundtripId ? { roundtrip_id: this.opts.roundtripId } : {}),
    });

    lines.push(`${d}<marker>`);
    lines.push(
      `${d}  <name>${this.escXml(clip.role || clip.clip_id)}</name>`,
    );
    lines.push(
      `${d}  <comment>${this.escXml(`video_os:${payload}`)}</comment>`,
    );
    lines.push(`${d}  <in>0</in>`);
    lines.push(`${d}  <out>-1</out>`);
    lines.push(`${d}</marker>`);
  }

  private appendEditorialMarker(
    lines: string[],
    depth: number,
    clip: ClipOutput,
  ): void {
    const d = this.indent(depth);
    lines.push(`${d}<marker>`);
    lines.push(
      `${d}  <name>${this.escXml(`${clip.beat_id}: ${clip.motivation}`)}</name>`,
    );
    lines.push(
      `${d}  <comment>${this.escXml(`${clip.role} | confidence: ${clip.confidence}`)}</comment>`,
    );
    lines.push(`${d}  <in>${clip.timeline_in_frame}</in>`);
    lines.push(`${d}  <out>${clip.timeline_in_frame + 1}</out>`);
    lines.push(`${d}</marker>`);
  }

  private getTrackTransitions(trackId: string): TimelineTransitionOutput[] {
    return (this.timeline.transitions ?? []).filter(
      (transition) => transition.track_id === trackId,
    );
  }

  private resolveTransitionEffect(
    transition: TimelineTransitionOutput,
  ): { name: string; effectId: string } | null {
    if (transition.transition_type === "fade_to_black") return null;
    const skillId =
      transition.applied_skill_id ?? transition.degraded_from_skill_id ?? "";

    switch (skillId) {
      case "crossfade_bridge":
      case "silence_beat":
      case "build_to_peak":
      case "fallback.crossfade":
        return { name: "Cross Dissolve", effectId: "CrossDissolve" };
      case "match_cut_bridge":
        return { name: "Dip to Color", effectId: "DipToColor" };
      case "smash_cut_energy":
      case "fallback.hard_cut":
        return null;
      default:
        break;
    }

    switch (transition.transition_type) {
      case "crossfade":
        return { name: "Cross Dissolve", effectId: "CrossDissolve" };
      case "match_cut":
        return { name: "Dip to Color", effectId: "DipToColor" };
      default:
        return null;
    }
  }

  private appendTransitionItem(
    lines: string[],
    depth: number,
    transition: TimelineTransitionOutput,
    fromClip: ClipOutput,
    toClip: ClipOutput,
  ): void {
    const effect = this.resolveTransitionEffect(transition);
    if (!effect) return;

    const d = this.indent(depth);
    const transitionFrames = transition.transition_frames!;
    const cutFrame = toClip.timeline_in_frame;
    const startFrame = cutFrame - Math.floor(transitionFrames / 2);
    const endFrame = startFrame + transitionFrames;

    lines.push(`${d}<transitionitem>`);
    lines.push(`${d}  <start>${startFrame}</start>`);
    lines.push(`${d}  <end>${endFrame}</end>`);
    lines.push(`${d}  <alignment>center</alignment>`);
    lines.push(`${d}  <comment>${this.escXml(`video_os_transition:${JSON.stringify({
      transition_id: transition.transition_id,
      track_id: transition.track_id,
      from_clip_id: fromClip.clip_id,
      to_clip_id: toClip.clip_id,
    })}`)}</comment>`);
    lines.push(`${d}  <effect>`);
    lines.push(`${d}    <name>${effect.name}</name>`);
    lines.push(`${d}    <effectid>${effect.effectId}</effectid>`);
    lines.push(`${d}    <effecttype>transition</effecttype>`);
    lines.push(`${d}    <mediatype>video</mediatype>`);
    lines.push(`${d}  </effect>`);
    lines.push(`${d}</transitionitem>`);
  }

  private appendVideoTrack(
    lines: string[],
    track: TrackOutput,
    depth: number,
  ): void {
    const d = this.indent(depth);
    const trackTransitions = new Map(
      this.getTrackTransitions(track.track_id).map((transition) => [
        transition.from_clip_id,
        transition,
      ]),
    );

    lines.push(`${d}<track>`);
    lines.push(`${d}  <enabled>TRUE</enabled>`);
    lines.push(`${d}  <locked>FALSE</locked>`);

    for (const [index, clip] of track.clips.entries()) {
      const clipId = fcp7ClipItemId("cv", clip.clip_id);
      const baked = this.opts.videoRepresentations?.get(clip.clip_id);
      const representedAssetId = baked?.derived_asset_id ?? clip.asset_id;
      const fileId = this.getFileId(representedAssetId);
      const alreadyDefined = this.isFileDefined(representedAssetId);

      const srcInFrames = baked ? 0 : this.usToFrames(clip.src_in_us);
      const srcOutFrames = baked ? clip.timeline_duration_frames : this.usToFrames(clip.src_out_us);

      lines.push(`${d}  <clipitem id="${clipId}">`);
      lines.push(
        `${d}    <name>${this.escXml(this.resolveClipDisplayName(clip))}</name>`,
      );
      lines.push(`${d}    <duration>${baked ? clip.timeline_duration_frames : srcOutFrames}</duration>`);
      this.appendRate(lines, depth + 4);
      lines.push(`${d}    <start>${clip.timeline_in_frame}</start>`);
      lines.push(
        `${d}    <end>${clip.timeline_in_frame + clip.timeline_duration_frames}</end>`,
      );
      lines.push(`${d}    <in>${srcInFrames}</in>`);
      lines.push(`${d}    <out>${srcOutFrames}</out>`);

      if (!alreadyDefined) {
        // First use: emit full file definition, then mark as defined
        this.appendFileDefinition(
          lines,
          depth + 4,
          representedAssetId,
          fileId,
          clip,
          false,
          baked?.absolute_media_path,
          Boolean(baked),
        );
        this.markFileDefined(representedAssetId);
      } else {
        // Subsequent use: back-reference only
        lines.push(`${d}    <file id="${fileId}"/>`);
      }

      this.appendClipMarkers(lines, depth + 4, clip);
      lines.push(`${d}  </clipitem>`);

      const nextClip = track.clips[index + 1];
      const transition = trackTransitions.get(clip.clip_id);
      if (transition && nextClip && transition.to_clip_id === nextClip.clip_id) {
        this.appendTransitionItem(lines, depth + 2, transition, clip, nextClip);
      }
    }

    lines.push(`${d}</track>`);
  }

  private appendAudioTrack(
    lines: string[],
    track: TrackOutput,
    depth: number,
  ): void {
    const d = this.indent(depth);
    lines.push(`${d}<track>`);
    lines.push(`${d}  <enabled>TRUE</enabled>`);
    lines.push(`${d}  <locked>FALSE</locked>`);

    for (const clip of track.clips) {
      const clipId = fcp7ClipItemId("ca", clip.clip_id);
      const fileId = this.getFileId(clip.asset_id);
      const alreadyDefined = this.isFileDefined(clip.asset_id);

      const srcInFrames = this.usToFrames(clip.src_in_us);
      const srcOutFrames = this.usToFrames(clip.src_out_us);

      lines.push(`${d}  <clipitem id="${clipId}">`);
      lines.push(
        `${d}    <name>${this.escXml(this.resolveClipDisplayName(clip))}</name>`,
      );
      lines.push(`${d}    <duration>${srcOutFrames}</duration>`);
      this.appendRate(lines, depth + 4);
      lines.push(`${d}    <start>${clip.timeline_in_frame}</start>`);
      lines.push(
        `${d}    <end>${clip.timeline_in_frame + clip.timeline_duration_frames}</end>`,
      );
      lines.push(`${d}    <in>${srcInFrames}</in>`);
      lines.push(`${d}    <out>${srcOutFrames}</out>`);

      if (!alreadyDefined) {
        this.appendFileDefinition(
          lines,
          depth + 4,
          clip.asset_id,
          fileId,
          clip,
          true,
        );
        this.markFileDefined(clip.asset_id);
      } else {
        lines.push(`${d}    <file id="${fileId}"/>`);
      }

      // Audio level filter (gain + optional fade keyframes)
      this.appendAudioLevelFilter(lines, depth + 4, clip);

      this.appendClipMarkers(lines, depth + 4, clip);
      lines.push(`${d}  </clipitem>`);
    }

    lines.push(`${d}</track>`);
  }

  // ── Audio Level Filter ──

  /**
   * Emit an Audio Levels filter for an audio clip.
   * Resolves the gain dB from audio_policy based on clip role,
   * converts to linear gain (10^(dB/20)), and optionally adds
   * fade-in / fade-out keyframes.
   */
  private appendAudioLevelFilter(
    lines: string[],
    depth: number,
    clip: ClipOutput,
  ): void {
    const decision = resolveFcp7AudioLevelsEmissionDecision(clip, this.timeline.audio_mix);
    if (!decision) return;
    const { linearGain, fadeInFrames, fadeOutFrames, hasFadeIn, hasFadeOut } = decision;
    const d = this.indent(depth);

    lines.push(`${d}<filter>`);
    lines.push(`${d}  <effect>`);
    lines.push(`${d}    <name>Audio Levels</name>`);
    lines.push(`${d}    <effectid>audiolevels</effectid>`);
    lines.push(`${d}    <parameter authoringApp="FinalCutPro">`);
    lines.push(`${d}      <parameterid>level</parameterid>`);
    lines.push(`${d}      <name>Level</name>`);
    lines.push(`${d}      <valuemin>0</valuemin>`);
    lines.push(`${d}      <valuemax>4</valuemax>`);

    if (hasFadeIn || hasFadeOut) {
      // Keyframe-based gain with fades
      const clipDur = clip.timeline_duration_frames;

      // Guard: clamp fade durations so they don't exceed the clip
      let effFadeIn = hasFadeIn ? fadeInFrames! : 0;
      let effFadeOut = hasFadeOut ? fadeOutFrames! : 0;

      if (effFadeIn + effFadeOut > clipDur) {
        // Proportionally shrink both fades to fit within clip duration
        const total = effFadeIn + effFadeOut;
        effFadeIn = Math.round((effFadeIn / total) * clipDur);
        effFadeOut = clipDur - effFadeIn;
      }

      const fadeOutStart = Math.max(effFadeIn, clipDur - effFadeOut);

      if (effFadeIn > 0) {
        // 0 → gain over fadeInFrames
        lines.push(`${d}      <keyframe>`);
        lines.push(`${d}        <when>0</when>`);
        lines.push(`${d}        <value>0</value>`);
        lines.push(`${d}      </keyframe>`);
        lines.push(`${d}      <keyframe>`);
        lines.push(`${d}        <when>${effFadeIn}</when>`);
        lines.push(`${d}        <value>${linearGain}</value>`);
        lines.push(`${d}      </keyframe>`);
      }

      if (effFadeOut > 0) {
        // If no fade in, emit a hold keyframe at the start
        if (effFadeIn <= 0) {
          lines.push(`${d}      <keyframe>`);
          lines.push(`${d}        <when>0</when>`);
          lines.push(`${d}        <value>${linearGain}</value>`);
          lines.push(`${d}      </keyframe>`);
        }
        // Hold at gain until fade-out starts (if there's a gap)
        if (fadeOutStart > effFadeIn) {
          lines.push(`${d}      <keyframe>`);
          lines.push(`${d}        <when>${fadeOutStart}</when>`);
          lines.push(`${d}        <value>${linearGain}</value>`);
          lines.push(`${d}      </keyframe>`);
        }
        // gain → 0 over fadeOutFrames
        lines.push(`${d}      <keyframe>`);
        lines.push(`${d}        <when>${clipDur}</when>`);
        lines.push(`${d}        <value>0</value>`);
        lines.push(`${d}      </keyframe>`);
      }
    } else {
      // Static gain (no fades)
      lines.push(`${d}      <value>${linearGain}</value>`);
    }

    lines.push(`${d}    </parameter>`);
    lines.push(`${d}  </effect>`);
    lines.push(`${d}</filter>`);
  }

  // ── Text Overlay Track ──

  private appendTextOverlayTrack(
    lines: string[],
    overlays: ResolvedTextOverlay[],
    depth: number,
  ): void {
    const d = this.indent(depth);
    lines.push(`${d}<track>`);
    lines.push(`${d}  <enabled>TRUE</enabled>`);
    lines.push(`${d}  <locked>FALSE</locked>`);

    for (const overlay of overlays) {
      this.appendTextGeneratorItem(lines, overlay, depth + 2);
    }

    lines.push(`${d}</track>`);
  }

  private appendTextGeneratorItem(
    lines: string[],
    overlay: ResolvedTextOverlay,
    depth: number,
  ): void {
    const d = this.indent(depth);
    const id = overlay.generatorId;
    const label = overlay.label || overlay.text.split("\n")[0];
    const fontSize = overlay.fontSize ?? 48;
    const [r, g, b] = overlay.color ?? [255, 255, 255];
    const opacity = overlay.opacity ?? 100;
    const durFrames = overlay.durationFrames;

    const [originX, originY] = CANONICAL_ANCHOR_ORIGINS[overlay.anchor];

    lines.push(`${d}<generatoritem id="${id}">`);
    lines.push(`${d}  <name>${this.escXml(label)}</name>`);
    lines.push(`${d}  <duration>${durFrames}</duration>`);
    this.appendRate(lines, depth + 2);
    lines.push(`${d}  <start>${overlay.startFrame}</start>`);
    lines.push(`${d}  <end>${overlay.startFrame + durFrames}</end>`);
    lines.push(`${d}  <in>0</in>`);
    lines.push(`${d}  <out>${durFrames}</out>`);

    if (overlay.canonical) {
      const marker = {
        surface: "text_overlay",
        overlay_id: overlay.canonical.overlayId,
        clip_id: overlay.canonical.clipId,
        roundtrip_id: overlay.canonical.roundtripId,
      };
      lines.push(`${d}  <marker>`);
      lines.push(`${d}    <name>video_os text overlay</name>`);
      lines.push(`${d}    <comment>${this.escXml(`video_os:${JSON.stringify(marker)}`)}</comment>`);
      lines.push(`${d}    <in>0</in>`);
      lines.push(`${d}    <out>-1</out>`);
      lines.push(`${d}  </marker>`);
    }

    // Outline Text generator — reliable in Premiere Pro import
    lines.push(`${d}  <effect>`);
    lines.push(`${d}    <name>Outline Text</name>`);
    lines.push(`${d}    <effectid>Outline Text</effectid>`);
    lines.push(`${d}    <effectcategory>Generators</effectcategory>`);
    lines.push(`${d}    <effecttype>generator</effecttype>`);
    lines.push(`${d}    <mediatype>video</mediatype>`);

    // Text content
    lines.push(`${d}    <parameter>`);
    lines.push(`${d}      <parameterid>str</parameterid>`);
    lines.push(`${d}      <name>Text</name>`);
    lines.push(`${d}      <value>${this.escXml(overlay.text)}</value>`);
    lines.push(`${d}    </parameter>`);

    // Font size
    lines.push(`${d}    <parameter>`);
    lines.push(`${d}      <parameterid>fontsize</parameterid>`);
    lines.push(`${d}      <name>Size</name>`);
    lines.push(`${d}      <value>${fontSize}</value>`);
    lines.push(`${d}    </parameter>`);

    // Font color (RGBA)
    lines.push(`${d}    <parameter>`);
    lines.push(`${d}      <parameterid>fontcolor</parameterid>`);
    lines.push(`${d}      <name>Font Color</name>`);
    lines.push(`${d}      <value>`);
    lines.push(`${d}        <red>${r}</red>`);
    lines.push(`${d}        <green>${g}</green>`);
    lines.push(`${d}        <blue>${b}</blue>`);
    lines.push(`${d}        <alpha>${Math.round((opacity / 100) * 255)}</alpha>`);
    lines.push(`${d}      </value>`);
    lines.push(`${d}    </parameter>`);

    // Origin (position)
    lines.push(`${d}    <parameter>`);
    lines.push(`${d}      <parameterid>origin</parameterid>`);
    lines.push(`${d}      <name>Origin</name>`);
    lines.push(`${d}      <value>`);
    lines.push(`${d}        <horiz>${originX}</horiz>`);
    lines.push(`${d}        <vert>${originY}</vert>`);
    lines.push(`${d}      </value>`);
    lines.push(`${d}    </parameter>`);

    lines.push(`${d}  </effect>`);
    lines.push(`${d}</generatoritem>`);
  }
}
