/**
 * FCP7 XML Importer — Premiere Pro XML → TimelineIR reverse conversion
 *
 * Parses FCP7 XML (xmeml v5) exported from Premiere Pro and converts it
 * back into a TimelineIR structure, using marker comments to identify
 * clips via video_os roundtrip metadata.
 *
 * Design:
 * - Marker comments embed roundtrip IDs: video_os:clip_id=X|asset_id=Y|beat_id=Z|motivation=M
 * - Clips without markers are flagged as "unmapped" (new clips added in Premiere)
 * - Diff detection compares imported clips against a reference timeline.json
 */

import { createHash } from "node:crypto";
import type {
  TimelineIR,
  TrackOutput,
  ClipOutput,
  MarkerOutput,
  AudioPolicy,
  TimelineTransitionOutput,
} from "../compiler/types.js";
import {
  linearGainToDb,
  resolveAudioGainWithFallback,
  saveAudioGainFieldAsDb,
} from "../../editor/shared/audio-gain.js";
import { fcp7TextGeneratorItemId } from "./fcp7-xml-export.js";
import type { PremiereTextOverlayManifestEntry } from "./premiere-roundtrip-receipt.js";

// ── Public Types ─────────────────────────────────────────────────────

/** Parsed clip from FCP7 XML */
export interface ParsedFcp7Clip {
  /** clipitem/@id attribute */
  xmlClipId: string;
  /** <name> element text */
  name: string;
  /** <start> in timeline frames */
  timelineInFrame: number;
  /** <end> in timeline frames */
  timelineEndFrame: number;
  /** <in> in source frames */
  srcInFrame: number;
  /** <out> in source frames */
  srcOutFrame: number;
  /** Extracted from marker comment, or null if no roundtrip marker */
  videoOsMeta: VideoOsMarkerMeta | null;
  /** Every parsed video_os marker on the clip, for session validation. */
  videoOsMarkers?: VideoOsMarkerMeta[];
  /** A video_os-prefixed marker was present but could not be parsed. */
  videoOsMarkerMalformed?: true;
  /** file/@id reference */
  fileId: string;
  /** pathurl from file definition, if available */
  pathurl: string;
  /** True only when this clipitem contains the inline file definition. */
  fileDefinitionInline: boolean;
  /** Audio level from filter — raw dB (legacy format without valuemin/valuemax) */
  audioLevelDb?: number;
  /** Audio gain — linear value (new format with valuemin/valuemax) */
  audioGainLinear?: number;
  /** Fade-in duration in frames (from keyframes) */
  fadeInFrames?: number;
  /** Fade-out duration in frames (from keyframes) */
  fadeOutFrames?: number;
  /** Human-readable editorial marker, if present */
  editorialMarker?: ParsedEditorialMarker;
  /** Direct clipitem structures used for bounded unsupported-edit detection. */
  unsupportedEditSignals?: ParsedUnsupportedEditSignal[];
  /** Raw, fail-closed eligibility evidence for markerless known-source video additions. */
  markerlessCandidateAudit?: ParsedMarkerlessCandidateAudit;
  /** Raw exporter-shape evidence required before accepting a mapped video move. */
  mappedMoveCandidateAudit?: ParsedMappedMoveCandidateAudit;
}

interface ParsedMarkerlessCandidateAudit {
  eligibleShape: boolean;
  duration?: number;
  start?: number;
  end?: number;
  inFrame?: number;
  outFrame?: number;
  rateNum?: number;
  rateDen?: number;
}

interface ParsedMappedMoveCandidateAudit extends ParsedMarkerlessCandidateAudit {
  exactExporterShape: boolean;
}

interface ParsedFileIdentity {
  valid: boolean;
  decodedPathurl?: string;
}

type ParsedUnsupportedEditSignal =
  | { kind: "speed"; speedIndex: number }
  | {
      kind: "rate";
      rateIndex: number;
      timebase: string;
      ntsc: string;
    }
  | { kind: "filter_missing_effect"; filterIndex: number }
  | {
      kind: "filter_effect";
      filterIndex: number;
      effectIndex: number;
      effectId: string;
      effectName: string;
      audioLevelsValidationReason?: AudioLevelsUnsupportedReason;
    };

type AudioLevelsUnsupportedReason =
  | "audiolevels_duplicate_effect"
  | "audiolevels_filter_shape_unsupported"
  | "audiolevels_effect_identity_invalid"
  | "audiolevels_parameter_missing"
  | "audiolevels_duplicate_parameter"
  | "audiolevels_extra_parameter"
  | "audiolevels_parameter_identity_invalid"
  | "audiolevels_value_non_finite"
  | "audiolevels_value_out_of_range"
  | "audiolevels_keyframe_time_invalid"
  | "audiolevels_keyframe_shape_unsupported"
  | "audiolevels_parameter_shape_unsupported";

export interface ParsedEditorialMarker {
  beat_id?: string;
  motivation?: string;
  role?: string;
  confidence?: number;
}

/** Metadata extracted from video_os marker comment */
export interface VideoOsMarkerMeta {
  clip_id: string;
  asset_id: string;
  beat_id: string;
  motivation: string;
  roundtrip_id?: string;
  /** Internal parse signal used by the apply gate. */
  roundtrip_id_malformed?: true;
  representation?: "baked_visual";
  bake_request_id?: string;
  derived_asset_id?: string;
  manifest_sha256?: string;
  output_sha256?: string;
  effect_editable?: false;
}

export interface ParsedFcp7Transition {
  startFrame: number;
  endFrame: number;
  alignment: string;
  effectName: string;
  effectId: string;
  mediaType: string;
  fromXmlClipId?: string;
  toXmlClipId?: string;
  fromClipId?: string;
  toClipId?: string;
  markerStatus: "exact" | "missing" | "malformed";
  transitionId?: string;
  markedTrackId?: string;
  markedFromClipId?: string;
  markedToClipId?: string;
}

/** Parsed sequence from FCP7 XML */
export interface ParsedFcp7Sequence {
  name: string;
  timebase: number;
  ntsc: boolean;
  width: number;
  height: number;
  duration: number;
  timecodeFormat: string;
  videoTracks: ParsedFcp7Clip[][];
  videoTransitions: ParsedFcp7Transition[][];
  audioTracks: ParsedFcp7Clip[][];
  audioTransitions: ParsedFcp7Transition[][];
  fileMap: Map<string, string>; // file-id → pathurl
  /** Exact decoded identities for all observed inline file definitions. */
  fileIdentities: Map<string, ParsedFileIdentity>;
  /** A malformed inline definition without a usable ID poisons candidate mapping. */
  malformedFileDefinition: boolean;
  textOverlayGenerators: ParsedTextOverlayGenerator[];
}

export interface ParsedTextOverlayGenerator {
  xmlGeneratorId: string;
  status: "exact" | "malformed_marker" | "malformed" | "unmapped";
  overlayId?: string;
  clipId?: string;
  roundtripId?: string;
  text?: string;
  startFrame?: number;
  endFrame?: number;
  durationFrames?: number;
  fontSize?: number;
  color?: [number, number, number];
  alpha?: number;
  origin?: [number, number];
  reason?: string;
  name?: string;
  rateNum?: number;
  rateDen?: number;
}

// ── Diff Types ───────────────────────────────────────────────────────

export type DiffKind =
  | "trim_changed"
  | "reordered"
  | "audio_policy_changed"
  | "deleted"
  | "track_moved"
  | "added_mapped"
  | "added_unmapped";

interface ClipDiffBase {
  clip_id: string;
  detail: string;
}

interface TimelinePositionDiff extends ClipDiffBase {
  kind: "trim_changed" | "reordered";
  original: {
    src_in_us: number;
    src_out_us: number;
    timeline_in_frame: number;
    timeline_duration_frames: number;
  };
  updated: {
    src_in_us: number;
    src_out_us: number;
    timeline_in_frame: number;
    timeline_duration_frames: number;
  };
}

interface AudioPolicyDiff extends ClipDiffBase {
  kind: "audio_policy_changed";
  original_audio_policy: AudioPolicy;
  updated_audio_policy: AudioPolicy;
}

interface PresenceDiff extends ClipDiffBase {
  kind: "deleted" | "added_unmapped";
}

interface AddedMappedDiff extends ClipDiffBase {
  kind: "added_mapped";
  target_track_id: string;
  after_clip_id: string;
  before_clip_id: string;
  source_identity: {
    file_id: string;
    decoded_pathurl: string;
  };
  added_clip: ClipOutput;
}

interface TrackMovedDiff extends ClipDiffBase {
  kind: "track_moved";
  source_track_id: string;
  target_track_id: string;
  after_clip_id: string;
  before_clip_id: string;
}

export type ClipDiff =
  | TimelinePositionDiff
  | AudioPolicyDiff
  | PresenceDiff
  | TrackMovedDiff
  | AddedMappedDiff;

interface ClipEvidenceBase {
  track_kind: "video" | "audio";
  track_index: number;
  clip_index: number;
  xml_clip_id: string;
}

export type UnsupportedEditEvidenceLocation =
  | (ClipEvidenceBase & {
      element: "clipitem";
      expected: "filter/effect[effectid=audiolevels]";
    })
  | (ClipEvidenceBase & {
      element: "clipitem/speed";
      speed_index: number;
    })
  | (ClipEvidenceBase & {
      element: "clipitem/rate";
      rate_index: number;
      expected_timebase: string;
      expected_ntsc: "TRUE" | "FALSE";
      observed_timebase: string;
      observed_ntsc: string;
    })
  | (ClipEvidenceBase & {
      element: "clipitem/filter";
      filter_index: number;
    })
  | (ClipEvidenceBase & {
      element: "clipitem/filter/effect";
      filter_index: number;
      effect_index: number;
      effect_id: string;
      effect_name: string;
    });

interface UnsupportedEditBase {
  kind: "unsupported_edit";
  clip_id: string;
  disposition: "non_applicable";
  detail: string;
}

export type UnsupportedEditEntry = UnsupportedEditBase & (
  | {
      surface: "speed_time_remap";
      reason: "direct_speed_element_present";
      evidence_location: Extract<
        UnsupportedEditEvidenceLocation,
        { element: "clipitem/speed" }
      >;
    }
  | {
      surface: "speed_time_remap";
      reason: "clip_rate_mismatch";
      evidence_location: Extract<
        UnsupportedEditEvidenceLocation,
        { element: "clipitem/rate" }
      >;
    }
  | {
      surface: "non_audio_level_clip_filter_effect";
      reason: "clip_filter_missing_effect";
      evidence_location: Extract<
        UnsupportedEditEvidenceLocation,
        { element: "clipitem/filter" }
      >;
    }
  | {
      surface: "audio_levels";
      reason: AudioLevelsUnsupportedReason;
      evidence_location: Extract<
        UnsupportedEditEvidenceLocation,
        { element: "clipitem/filter/effect" }
      >;
    }
  | {
      surface: "audio_levels";
      reason: "audiolevels_filter_missing";
      evidence_location: Extract<
        UnsupportedEditEvidenceLocation,
        { element: "clipitem" }
      >;
    }
  | {
      surface: "non_audio_level_clip_filter_effect";
      reason: "clip_effect_not_supported_audiolevels";
      evidence_location: Extract<
        UnsupportedEditEvidenceLocation,
        { element: "clipitem/filter/effect" }
      >;
    }
  | {
      surface: "video_cross_track_move";
      reason:
        | "duplicate_mapped_identity"
        | "unsafe_video_track_move"
        | "audio_track_move_not_supported"
        | "multiple_track_moves_not_supported";
      evidence_location: ClipEvidenceBase;
    }
);

export interface ImportDiffReport {
  sequenceName: string;
  totalClipsInXml: number;
  mappedClips: number;
  unmappedClips: number;
  diffs: ClipDiff[];
  unsupportedEdits: UnsupportedEditEntry[];
  textOverlayEdits: TextOverlayEditEntry[];
  transitionEdits: TransitionEditEntry[];
  transitionSourceHandleAuthority: "missing";
}

export type TransitionEditKind =
  | "added"
  | "deleted"
  | "effect_changed"
  | "duration_changed"
  | "window_changed"
  | "alignment_changed"
  | "identity_changed"
  | "orphan_endpoint"
  | "duplicate_edge"
  | "unknown_effect";

export interface TransitionEditEntry {
  kind: TransitionEditKind;
  surface: "simple_transition";
  disposition: "report_only";
  transition_id?: string;
  track_id?: string;
  from_clip_id?: string;
  to_clip_id?: string;
  detail: string;
  source_handle_authority: "missing";
}

export type TextOverlayEditKind =
  | "text_changed"
  | "timing_changed"
  | "style_changed"
  | "deleted"
  | "duplicate"
  | "malformed_marker"
  | "malformed"
  | "added_unmapped";

export interface TextOverlayEditEntry {
  kind: TextOverlayEditKind;
  surface: "text_overlay";
  disposition: "report_only";
  clip_id?: string;
  overlay_id?: string;
  xml_generator_id?: string;
  field?: string;
  detail: string;
}

// ── XML Parsing ──────────────────────────────────────────────────────

/** Minimal XML element node for FCP7 parsing */
interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  attributeNames: string[];
  children: XmlNode[];
  text: string;
  rawText: string;
}

/**
 * Simple recursive XML parser for FCP7 xmeml.
 * Handles the subset of XML features used in FCP7:
 * - Elements with attributes, text content, child elements
 * - Self-closing tags (e.g. <file id="file-1"/>)
 * - XML comments (<!-- ... -->) and processing instructions (<? ... ?>)
 *   are skipped both at pre-strip and structurally during parsing
 * - No CDATA, namespaces, or DTD entities
 */
export function parseFcp7Xml(xml: string): XmlNode {
  // Pre-strip XML declaration and DOCTYPE (not elements, so skip them early)
  let cleaned = xml.replace(/<\?xml[^?]*\?>/g, "");
  cleaned = cleaned.replace(/<!DOCTYPE[^>]*>/g, "");
  // Strip comments via regex as first pass (structural skip handles survivors)
  cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, "");
  cleaned = cleaned.trim();

  // Skip any remaining comments/PIs before the root element
  let pos = 0;
  pos = skipNonElements(cleaned, pos);

  const [node] = parseElement(cleaned, pos);
  return node;
}

function skipWhitespace(s: string, pos: number): number {
  while (pos < s.length && /\s/.test(s[pos])) pos++;
  return pos;
}

/** Skip XML comments (<!-- ... -->) and processing instructions (<? ... ?>) */
function skipNonElements(s: string, pos: number): number {
  pos = skipWhitespace(s, pos);
  while (pos < s.length) {
    // XML comment
    if (s.startsWith("<!--", pos)) {
      const end = s.indexOf("-->", pos + 4);
      if (end === -1) break; // malformed — let parseElement deal with it
      pos = end + 3;
      pos = skipWhitespace(s, pos);
      continue;
    }
    // Processing instruction
    if (s.startsWith("<?", pos)) {
      const end = s.indexOf("?>", pos + 2);
      if (end === -1) break;
      pos = end + 2;
      pos = skipWhitespace(s, pos);
      continue;
    }
    break;
  }
  return pos;
}

function parseElement(s: string, pos: number): [XmlNode, number] {
  pos = skipWhitespace(s, pos);

  if (s[pos] !== "<") {
    throw new Error(`Expected '<' at position ${pos}, got '${s[pos]}'`);
  }

  // Parse opening tag
  pos++; // skip '<'
  const tagStart = pos;
  while (pos < s.length && !/[\s/>]/.test(s[pos])) pos++;
  const tag = s.slice(tagStart, pos);

  // Parse attributes
  const attrs: Record<string, string> = {};
  const attributeNames: string[] = [];
  pos = skipWhitespace(s, pos);
  while (pos < s.length && s[pos] !== ">" && s[pos] !== "/") {
    const attrStart = pos;
    while (pos < s.length && s[pos] !== "=" && !/[\s/>]/.test(s[pos])) pos++;
    const attrName = s.slice(attrStart, pos);
    attributeNames.push(attrName);

    if (s[pos] === "=") {
      pos++; // skip '='
      const quote = s[pos];
      if (quote === '"' || quote === "'") {
        pos++; // skip opening quote
        const valStart = pos;
        while (pos < s.length && s[pos] !== quote) pos++;
        attrs[attrName] = unescapeXml(s.slice(valStart, pos));
        pos++; // skip closing quote
      }
    }
    pos = skipWhitespace(s, pos);
  }

  // Self-closing tag
  if (s[pos] === "/") {
    pos++; // skip '/'
    pos++; // skip '>'
    return [{ tag, attrs, attributeNames, children: [], text: "", rawText: "" }, pos];
  }

  pos++; // skip '>'

  // Parse children and text content
  const children: XmlNode[] = [];
  let text = "";
  let rawText = "";

  while (pos < s.length) {
    const whitespaceStart = pos;
    pos = skipWhitespace(s, pos);
    rawText += s.slice(whitespaceStart, pos);

    if (pos >= s.length) break;

    // Skip comments and processing instructions inside elements
    pos = skipNonElements(s, pos);
    if (pos >= s.length) break;

    // Check for closing tag
    if (s[pos] === "<" && s[pos + 1] === "/") {
      // Closing tag — skip it
      pos += 2;
      while (pos < s.length && s[pos] !== ">") pos++;
      pos++; // skip '>'
      break;
    }

    // Check for child element
    if (s[pos] === "<") {
      const [child, newPos] = parseElement(s, pos);
      children.push(child);
      pos = newPos;
    } else {
      // Text content
      const textStart = pos;
      while (pos < s.length && s[pos] !== "<") pos++;
      const textContent = s.slice(textStart, pos);
      rawText += textContent;
      text += textContent.trim();
    }
  }

  return [
    {
      tag,
      attrs,
      attributeNames,
      children,
      text: unescapeXml(text),
      rawText: unescapeXml(rawText),
    },
    pos,
  ];
}

function unescapeXml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

// ── XmlNode query helpers ────────────────────────────────────────────

function findChild(node: XmlNode, tag: string): XmlNode | undefined {
  return node.children.find((c) => c.tag === tag);
}

function findChildren(node: XmlNode, tag: string): XmlNode[] {
  return node.children.filter((c) => c.tag === tag);
}

function childText(node: XmlNode, tag: string): string {
  return findChild(node, tag)?.text ?? "";
}

function childRawText(node: XmlNode, tag: string): string {
  return findChild(node, tag)?.rawText ?? "";
}

function childInt(node: XmlNode, tag: string, fallback = 0): number {
  const t = childText(node, tag);
  const n = parseInt(t, 10);
  return isNaN(n) ? fallback : n;
}

function exactSafeInteger(node: XmlNode, tag: string): number | undefined {
  const matches = findChildren(node, tag);
  if (matches.length !== 1 || !isScalarNode(matches[0])) return undefined;
  const raw = matches[0].rawText.trim();
  if (!/^-?(?:0|[1-9]\d*)$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

function exactFiniteNumber(node: XmlNode, tag: string): number | undefined {
  const matches = findChildren(node, tag);
  if (matches.length !== 1 || !isScalarNode(matches[0])) return undefined;
  const raw = matches[0].rawText.trim();
  if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function parseTextOverlayMarker(marker: XmlNode):
  | { status: "exact"; overlayId: string; clipId: string; roundtripId: string }
  | { status: "malformed_marker"; reason: string }
  | { status: "unmapped" } {
  const commentNodes = findChildren(marker, "comment");
  if (commentNodes.length !== 1 || !isScalarNode(commentNodes[0])) {
    return { status: "malformed_marker", reason: "marker comment shape is invalid" };
  }
  const comment = commentNodes[0].text;
  if (!comment.startsWith("video_os:")) return { status: "unmapped" };
  try {
    const parsed: unknown = JSON.parse(comment.slice("video_os:".length));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { status: "malformed_marker", reason: "marker payload is not an object" };
    }
    const obj = parsed as Record<string, unknown>;
    if (
      Object.keys(obj).sort().join("|") !== "clip_id|overlay_id|roundtrip_id|surface" ||
      obj.surface !== "text_overlay" ||
      typeof obj.overlay_id !== "string" || obj.overlay_id.length === 0 ||
      typeof obj.clip_id !== "string" || obj.clip_id.length === 0 ||
      typeof obj.roundtrip_id !== "string" || !/^sha256:[0-9a-f]{64}$/.test(obj.roundtrip_id)
    ) {
      return { status: "malformed_marker", reason: "marker payload is not exact canonical text-overlay metadata" };
    }
    return {
      status: "exact",
      overlayId: obj.overlay_id,
      clipId: obj.clip_id,
      roundtripId: obj.roundtrip_id,
    };
  } catch {
    return { status: "malformed_marker", reason: "marker payload is not valid JSON" };
  }
}

function parseTextOverlayGenerator(generator: XmlNode): ParsedTextOverlayGenerator {
  const xmlGeneratorId = generator.attrs.id ?? "";
  const markers = findChildren(generator, "marker");
  if (markers.length === 0) {
    return { xmlGeneratorId, status: "unmapped", reason: "generator has no video_os text-overlay marker" };
  }
  if (markers.length !== 1) {
    return { xmlGeneratorId, status: "malformed_marker", reason: "generator must have exactly one marker" };
  }
  const marker = parseTextOverlayMarker(markers[0]);
  if (marker.status !== "exact") return { xmlGeneratorId, ...marker };

  const malformed = (reason: string): ParsedTextOverlayGenerator => ({
    xmlGeneratorId,
    status: "malformed",
    overlayId: marker.overlayId,
    clipId: marker.clipId,
    roundtripId: marker.roundtripId,
    reason,
  });
  if (!hasExactAttributes(generator, ["id"]) || !xmlGeneratorId) {
    return malformed("generator ID shape is invalid");
  }
  const markerChildren = ["name", "comment", "in", "out"];
  if (
    markers[0].attributeNames.length !== 0 ||
    markers[0].children.length !== markerChildren.length ||
    markerChildren.some((tag) => findChildren(markers[0], tag).length !== 1) ||
    childText(markers[0], "name") !== "video_os text overlay" ||
    exactSafeInteger(markers[0], "in") !== 0 || exactSafeInteger(markers[0], "out") !== -1
  ) return malformed("marker is not the exact exporter shape");
  const allowedChildren = ["name", "duration", "rate", "start", "end", "in", "out", "marker", "effect"];
  if (
    generator.children.length !== allowedChildren.length ||
    allowedChildren.some((tag) => findChildren(generator, tag).length !== 1) ||
    generator.children.some((child) => !allowedChildren.includes(child.tag))
  ) {
    return malformed("generator children are not the exact exporter shape");
  }
  const startFrame = exactSafeInteger(generator, "start");
  const endFrame = exactSafeInteger(generator, "end");
  const durationFrames = exactSafeInteger(generator, "duration");
  const inFrame = exactSafeInteger(generator, "in");
  const outFrame = exactSafeInteger(generator, "out");
  if (
    startFrame === undefined || startFrame < 0 ||
    endFrame === undefined || durationFrames === undefined || durationFrames <= 0 ||
    inFrame !== 0 || outFrame !== durationFrames ||
    endFrame !== startFrame + durationFrames || !Number.isSafeInteger(startFrame + durationFrames)
  ) return malformed("generator timing range is invalid");
  const rate = parseExactRateNode(findChild(generator, "rate"));
  const nameNode = findChild(generator, "name")!;
  if (!rate || !isScalarNode(nameNode) || nameNode.text.length === 0) {
    return malformed("generator name or rate shape is invalid");
  }

  const effect = findChild(generator, "effect")!;
  const effectTags = ["name", "effectid", "effectcategory", "effecttype", "mediatype", "parameter", "parameter", "parameter", "parameter"];
  if (
    effect.attributeNames.length !== 0 ||
    effect.children.map((child) => child.tag).sort().join("|") !== effectTags.sort().join("|") ||
    childText(effect, "name") !== "Outline Text" ||
    childText(effect, "effectid") !== "Outline Text" ||
    childText(effect, "effectcategory") !== "Generators" ||
    childText(effect, "effecttype") !== "generator" ||
    childText(effect, "mediatype") !== "video"
  ) return malformed("generator effect is not the exact Outline Text shape");

  const parameters = new Map<string, XmlNode>();
  for (const parameter of findChildren(effect, "parameter")) {
    const id = childText(parameter, "parameterid");
    if (
      parameter.attributeNames.length !== 0 ||
      parameter.children.length !== 3 ||
      ["parameterid", "name", "value"].some((tag) => findChildren(parameter, tag).length !== 1) ||
      !id || parameters.has(id)
    ) return malformed("generator parameter shape or IDs are invalid");
    parameters.set(id, parameter);
  }
  if ([...parameters.keys()].sort().join("|") !== "fontcolor|fontsize|origin|str") {
    return malformed("generator parameter set is not exact");
  }
  const scalarValue = (id: string): string | undefined => {
    const values = findChildren(parameters.get(id)!, "value");
    return values.length === 1 && isScalarNode(values[0]) && values[0].attributeNames.length === 0
      ? values[0].text
      : undefined;
  };
  const expectedNames: Record<string, string> = {
    str: "Text",
    fontsize: "Size",
    fontcolor: "Font Color",
    origin: "Origin",
  };
  if ([...parameters].some(([id, parameter]) => childText(parameter, "name") !== expectedNames[id])) {
    return malformed("generator parameter names are not exact");
  }
  const text = scalarValue("str");
  const fontSizeRaw = scalarValue("fontsize");
  const fontSize = fontSizeRaw && /^\d+$/.test(fontSizeRaw) ? Number(fontSizeRaw) : undefined;
  const colorValue = findChild(parameters.get("fontcolor")!, "value");
  const originValue = findChild(parameters.get("origin")!, "value");
  if (
    !colorValue || colorValue.attributeNames.length !== 0 ||
    !hasExactUniqueChildren(colorValue, ["red", "green", "blue", "alpha"]) ||
    !originValue || originValue.attributeNames.length !== 0 ||
    !hasExactUniqueChildren(originValue, ["horiz", "vert"])
  ) return malformed("generator compound style values are not exact");
  const red = colorValue ? exactSafeInteger(colorValue, "red") : undefined;
  const green = colorValue ? exactSafeInteger(colorValue, "green") : undefined;
  const blue = colorValue ? exactSafeInteger(colorValue, "blue") : undefined;
  const alpha = colorValue ? exactSafeInteger(colorValue, "alpha") : undefined;
  const horiz = originValue ? exactFiniteNumber(originValue, "horiz") : undefined;
  const vert = originValue ? exactFiniteNumber(originValue, "vert") : undefined;
  if (
    text === undefined || fontSize === undefined || !Number.isSafeInteger(fontSize) || fontSize <= 0 ||
    red === undefined || green === undefined || blue === undefined || alpha === undefined ||
    [red, green, blue, alpha].some((value) => value < 0 || value > 255) ||
    horiz === undefined || vert === undefined
  ) return malformed("generator supported style values are invalid");

  return {
    xmlGeneratorId,
    status: "exact",
    overlayId: marker.overlayId,
    clipId: marker.clipId,
    roundtripId: marker.roundtripId,
    text,
    startFrame,
    endFrame,
    durationFrames,
    fontSize,
    color: [red, green, blue],
    alpha,
    origin: [horiz, vert],
    name: nameNode.text,
    rateNum: rate[0],
    rateDen: rate[1],
  };
}

// ── Marker comment parsing ───────────────────────────────────────────

/**
 * Parse video_os roundtrip metadata from a marker comment.
 *
 * Supports two formats:
 * 1. JSON (current exporter): video_os:{"clip_id":"X","asset_id":"Y","beat_id":"Z","motivation":"M"}
 * 2. Pipe-delimited (legacy): video_os:clip_id=X|asset_id=Y|beat_id=Z|motivation=M
 */
export function parseVideoOsMarker(comment: string): VideoOsMarkerMeta | null {
  if (!comment.startsWith("video_os:")) return null;

  const payload = comment.slice("video_os:".length);

  // Try JSON format first (current exporter)
  if (payload.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(payload);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return null;
      }
      const obj = parsed as Record<string, unknown>;
      if (
        !Object.hasOwn(obj, "clip_id") ||
        !Object.hasOwn(obj, "asset_id") ||
        !Object.hasOwn(obj, "beat_id")
      ) return null;
      const clip_id = obj.clip_id;
      const asset_id = obj.asset_id;
      const beat_id = obj.beat_id;
      if (
        typeof clip_id !== "string" || !clip_id ||
        typeof asset_id !== "string" || !asset_id ||
        typeof beat_id !== "string" || !beat_id
      ) return null;
      const hasRoundtripId = Object.hasOwn(obj, "roundtrip_id");
      const roundtripId = obj.roundtrip_id;
      const motivation = Object.hasOwn(obj, "motivation") &&
        typeof obj.motivation === "string"
        ? obj.motivation
        : "";
      const baked = obj.representation === "baked_visual";
      if (baked) {
        const exact = ["asset_id", "bake_request_id", "beat_id", "clip_id", "derived_asset_id", "effect_editable", "manifest_sha256", "motivation", "output_sha256", "representation", "roundtrip_id"];
        if (Object.keys(obj).sort().join("|") !== exact.sort().join("|") ||
            typeof obj.bake_request_id !== "string" || typeof obj.derived_asset_id !== "string" ||
            typeof obj.manifest_sha256 !== "string" || typeof obj.output_sha256 !== "string" ||
            obj.effect_editable !== false || typeof roundtripId !== "string") return null;
      }
      return {
        clip_id,
        asset_id,
        beat_id,
        motivation,
        ...(typeof roundtripId === "string"
          ? { roundtrip_id: roundtripId }
          : {}),
        ...(hasRoundtripId && typeof roundtripId !== "string"
          ? { roundtrip_id_malformed: true as const }
          : {}),
        ...(baked ? {
          representation: "baked_visual" as const,
          bake_request_id: obj.bake_request_id as string,
          derived_asset_id: obj.derived_asset_id as string,
          manifest_sha256: obj.manifest_sha256 as string,
          output_sha256: obj.output_sha256 as string,
          effect_editable: false as const,
        } : {}),
      };
    } catch {
      return null;
    }
  }

  // Fallback: pipe-delimited format (legacy)
  const parts = payload.split("|");
  const map = new Map<string, string>();

  for (const part of parts) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) continue;
    map.set(part.slice(0, eqIdx), part.slice(eqIdx + 1));
  }

  const clip_id = map.get("clip_id");
  const asset_id = map.get("asset_id");
  const beat_id = map.get("beat_id");
  if (!clip_id || !asset_id || !beat_id) return null;

  return {
    clip_id,
    asset_id,
    beat_id,
    motivation: map.get("motivation") ?? "",
  };
}

function parseEditorialMarker(marker: XmlNode): ParsedEditorialMarker | null {
  const comment = childText(marker, "comment");
  if (parseVideoOsMarker(comment)) return null;

  const name = childText(marker, "name");
  const colonIndex = name.indexOf(":");
  if (colonIndex === -1) return null;

  const beat_id = name.slice(0, colonIndex).trim();
  const motivation = name.slice(colonIndex + 1).trim();
  if (!beat_id) return null;

  const parsed: ParsedEditorialMarker = {
    beat_id,
    motivation,
  };

  const match = comment.match(/^(.*?)\s*\|\s*confidence:\s*([0-9]*\.?[0-9]+)\s*$/);
  if (match) {
    parsed.role = match[1].trim() || undefined;
    const confidence = Number.parseFloat(match[2]);
    if (!Number.isNaN(confidence)) {
      parsed.confidence = confidence;
    }
  }

  return parsed;
}

function deriveClipIdFromXmlId(xmlClipId: string): string | undefined {
  if (xmlClipId.startsWith("cv-") || xmlClipId.startsWith("ca-")) {
    return xmlClipId.slice(3);
  }
  return xmlClipId || undefined;
}

const CANONICAL_INTEGER = /^(?:0|-?[1-9][0-9]*)$/;
const CANONICAL_POSITIVE_INTEGER = /^[1-9][0-9]*$/;

function hasExactAttributes(node: XmlNode, names: string[]): boolean {
  return node.attributeNames.length === names.length &&
    node.attributeNames.every((name, index) => name === names[index]);
}

function isScalarNode(node: XmlNode): boolean {
  return node.attributeNames.length === 0 && node.children.length === 0;
}

function parseCanonicalIntegerNode(
  node: XmlNode | undefined,
  positive = false,
): number | undefined {
  if (!node || !isScalarNode(node)) return undefined;
  const pattern = positive ? CANONICAL_POSITIVE_INTEGER : CANONICAL_INTEGER;
  if (!pattern.test(node.rawText)) return undefined;
  const value = Number(node.rawText);
  return Number.isSafeInteger(value) ? value : undefined;
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const remainder = x % y;
    x = y;
    y = remainder;
  }
  return x;
}

function reduceRate(num: number, den: number): [number, number] | undefined {
  if (
    !Number.isSafeInteger(num) ||
    !Number.isSafeInteger(den) ||
    num <= 0 ||
    den <= 0
  ) return undefined;
  const divisor = gcd(num, den);
  return [num / divisor, den / divisor];
}

function auditMarkerlessCandidate(
  clipitem: XmlNode,
): ParsedMarkerlessCandidateAudit {
  const invalid: ParsedMarkerlessCandidateAudit = { eligibleShape: false };
  if (
    !hasExactAttributes(clipitem, ["id"]) ||
    !clipitem.attrs.id
  ) return invalid;

  const requiredTags = [
    "name",
    "duration",
    "rate",
    "start",
    "end",
    "in",
    "out",
    "file",
  ];
  if (
    clipitem.children.length !== requiredTags.length ||
    requiredTags.some((tag) => findChildren(clipitem, tag).length !== 1) ||
    clipitem.children.some((child) => !requiredTags.includes(child.tag))
  ) return invalid;

  const nameNode = findChild(clipitem, "name");
  const durationNode = findChild(clipitem, "duration");
  const startNode = findChild(clipitem, "start");
  const endNode = findChild(clipitem, "end");
  const inNode = findChild(clipitem, "in");
  const outNode = findChild(clipitem, "out");
  if (!nameNode || !isScalarNode(nameNode)) return invalid;

  const duration = parseCanonicalIntegerNode(durationNode);
  const start = parseCanonicalIntegerNode(startNode);
  const end = parseCanonicalIntegerNode(endNode);
  const inFrame = parseCanonicalIntegerNode(inNode);
  const outFrame = parseCanonicalIntegerNode(outNode);
  if (
    duration === undefined ||
    start === undefined ||
    end === undefined ||
    inFrame === undefined ||
    outFrame === undefined ||
    duration !== outFrame ||
    start < 0 ||
    end <= start ||
    inFrame < 0 ||
    outFrame <= inFrame ||
    outFrame - inFrame !== end - start
  ) return invalid;

  const fileNode = findChild(clipitem, "file");
  if (
    !fileNode ||
    !hasExactAttributes(fileNode, ["id"]) ||
    !fileNode.attrs.id ||
    fileNode.children.length !== 0 ||
    fileNode.rawText !== ""
  ) return invalid;

  const rateNode = findChild(clipitem, "rate");
  if (
    !rateNode ||
    rateNode.attributeNames.length !== 0 ||
    rateNode.children.length !== 2 ||
    findChildren(rateNode, "timebase").length !== 1 ||
    findChildren(rateNode, "ntsc").length !== 1 ||
    rateNode.children.some((child) => !["timebase", "ntsc"].includes(child.tag))
  ) return invalid;
  const timebase = parseCanonicalIntegerNode(findChild(rateNode, "timebase"), true);
  const ntscNode = findChild(rateNode, "ntsc");
  if (timebase === undefined || !ntscNode || !isScalarNode(ntscNode)) return invalid;
  if (ntscNode.rawText !== "TRUE" && ntscNode.rawText !== "FALSE") return invalid;

  const rateNum = ntscNode.rawText === "TRUE" ? timebase * 1_000 : timebase;
  const rateDen = ntscNode.rawText === "TRUE" ? 1_001 : 1;
  if (!Number.isSafeInteger(rateNum)) return invalid;
  const reducedRate = reduceRate(rateNum, rateDen);
  if (!reducedRate) return invalid;

  return {
    eligibleShape: true,
    duration,
    start,
    end,
    inFrame,
    outFrame,
    rateNum: reducedRate[0],
    rateDen: reducedRate[1],
  };
}

function parseExactRateNode(rateNode: XmlNode | undefined): [number, number] | undefined {
  if (
    !rateNode ||
    rateNode.attributeNames.length !== 0 ||
    rateNode.children.length !== 2 ||
    findChildren(rateNode, "timebase").length !== 1 ||
    findChildren(rateNode, "ntsc").length !== 1 ||
    rateNode.children.some((child) => !["timebase", "ntsc"].includes(child.tag))
  ) return undefined;
  const timebase = parseCanonicalIntegerNode(findChild(rateNode, "timebase"), true);
  const ntscNode = findChild(rateNode, "ntsc");
  if (timebase === undefined || !ntscNode || !isScalarNode(ntscNode)) return undefined;
  if (ntscNode.rawText !== "TRUE" && ntscNode.rawText !== "FALSE") return undefined;
  const rateNum = ntscNode.rawText === "TRUE" ? timebase * 1_000 : timebase;
  const rateDen = ntscNode.rawText === "TRUE" ? 1_001 : 1;
  return Number.isSafeInteger(rateNum) ? reduceRate(rateNum, rateDen) : undefined;
}

function hasExactUniqueChildren(node: XmlNode, tags: string[]): boolean {
  return node.attributeNames.length === 0 &&
    node.children.length === tags.length &&
    tags.every((tag) => findChildren(node, tag).length === 1) &&
    node.children.every((child) => tags.includes(child.tag));
}

function auditExporterFileNode(fileNode: XmlNode | undefined): boolean {
  if (!fileNode || !hasExactAttributes(fileNode, ["id"]) || !fileNode.attrs.id) return false;
  if (fileNode.children.length === 0) return fileNode.rawText === "";
  if (!fileNode.children.every((child) =>
    ["name", "duration", "rate", "pathurl", "media"].includes(child.tag)
  )) return false;
  if (["name", "duration", "rate", "pathurl", "media"].some(
    (tag) => findChildren(fileNode, tag).length !== 1,
  )) return false;
  if (!isScalarNode(findChild(fileNode, "name")!) ||
    parseCanonicalIntegerNode(findChild(fileNode, "duration")) === undefined ||
    !parseExactRateNode(findChild(fileNode, "rate")) ||
    !isScalarNode(findChild(fileNode, "pathurl")!) ||
    childRawText(fileNode, "pathurl") === "") return false;

  const media = findChild(fileNode, "media")!;
  if (media.attributeNames.length !== 0 ||
    media.children.some((child) => !["video", "audio"].includes(child.tag)) ||
    findChildren(media, "video").length !== 1 ||
    findChildren(media, "audio").length > 1) return false;
  const video = findChild(media, "video")!;
  if (!hasExactUniqueChildren(video, ["samplecharacteristics"])) return false;
  const videoSample = findChild(video, "samplecharacteristics")!;
  if (!hasExactUniqueChildren(videoSample, ["rate", "width", "height"]) ||
    !parseExactRateNode(findChild(videoSample, "rate")) ||
    parseCanonicalIntegerNode(findChild(videoSample, "width"), true) === undefined ||
    parseCanonicalIntegerNode(findChild(videoSample, "height"), true) === undefined) return false;

  const audio = findChild(media, "audio");
  if (!audio) return true;
  if (!hasExactUniqueChildren(audio, ["samplecharacteristics", "channelcount"]) ||
    parseCanonicalIntegerNode(findChild(audio, "channelcount"), true) === undefined) return false;
  const audioSample = findChild(audio, "samplecharacteristics")!;
  return hasExactUniqueChildren(audioSample, ["samplerate", "depth"]) &&
    parseCanonicalIntegerNode(findChild(audioSample, "samplerate"), true) !== undefined &&
    parseCanonicalIntegerNode(findChild(audioSample, "depth"), true) !== undefined;
}

function auditExporterMarkerNode(
  marker: XmlNode,
  expectedIn: number,
  expectedOut: number,
  roundtrip: boolean,
): boolean {
  if (!hasExactUniqueChildren(marker, ["name", "comment", "in", "out"])) return false;
  const name = findChild(marker, "name");
  const comment = findChild(marker, "comment");
  if (!name || !comment || !isScalarNode(name) || !isScalarNode(comment)) return false;
  if (parseCanonicalIntegerNode(findChild(marker, "in")) !== expectedIn ||
    parseCanonicalIntegerNode(findChild(marker, "out")) !== expectedOut) return false;
  return roundtrip
    ? parseVideoOsMarker(comment.text) !== null
    : !comment.text.startsWith("video_os:");
}

function auditMappedMoveCandidate(clipitem: XmlNode): ParsedMappedMoveCandidateAudit {
  const invalid: ParsedMappedMoveCandidateAudit = {
    eligibleShape: false,
    exactExporterShape: false,
  };
  if (!hasExactAttributes(clipitem, ["id"]) || !clipitem.attrs.id) return invalid;
  const scalarTags = ["name", "duration", "rate", "start", "end", "in", "out", "file"];
  const allowedTags = [...scalarTags, "marker"];
  if (clipitem.children.some((child) => !allowedTags.includes(child.tag)) ||
    scalarTags.some((tag) => findChildren(clipitem, tag).length !== 1) ||
    findChildren(clipitem, "marker").length !== 2 ||
    clipitem.children.length !== scalarTags.length + 2) return invalid;
  const nameNode = findChild(clipitem, "name");
  if (!nameNode || !isScalarNode(nameNode)) return invalid;
  const duration = parseCanonicalIntegerNode(findChild(clipitem, "duration"));
  const start = parseCanonicalIntegerNode(findChild(clipitem, "start"));
  const end = parseCanonicalIntegerNode(findChild(clipitem, "end"));
  const inFrame = parseCanonicalIntegerNode(findChild(clipitem, "in"));
  const outFrame = parseCanonicalIntegerNode(findChild(clipitem, "out"));
  const rate = parseExactRateNode(findChild(clipitem, "rate"));
  if (duration === undefined || start === undefined || end === undefined ||
    inFrame === undefined || outFrame === undefined || !rate ||
    duration !== outFrame || start < 0 || end <= start || inFrame < 0 || outFrame <= inFrame ||
    outFrame - inFrame !== end - start || !auditExporterFileNode(findChild(clipitem, "file"))) {
    return invalid;
  }
  const markers = findChildren(clipitem, "marker");
  if (!auditExporterMarkerNode(markers[0], 0, -1, true) ||
    !auditExporterMarkerNode(markers[1], start, start + 1, false)) return invalid;
  return {
    eligibleShape: true,
    exactExporterShape: true,
    duration,
    start,
    end,
    inFrame,
    outFrame,
    rateNum: rate[0],
    rateDen: rate[1],
  };
}

function audioLevelsEffectValidationReason(
  filter: XmlNode,
  effect: XmlNode,
  clipDuration: number,
): AudioLevelsUnsupportedReason | undefined {
  if (
    filter.attributeNames.length !== 0 ||
    filter.children.length !== 1 ||
    filter.children[0] !== effect
  ) return "audiolevels_filter_shape_unsupported";
  if (
    effect.attributeNames.length !== 0 ||
    effect.children.some((child) => !["name", "effectid", "parameter"].includes(child.tag)) ||
    findChildren(effect, "name").length !== 1 ||
    findChildren(effect, "effectid").length !== 1 ||
    childRawText(effect, "name").trim() !== "Audio Levels" ||
    childRawText(effect, "effectid") !== "audiolevels"
  ) return "audiolevels_effect_identity_invalid";

  const parameters = findChildren(effect, "parameter");
  if (parameters.length === 0) return "audiolevels_parameter_missing";
  if (parameters.length > 1) {
    const levelCount = parameters.filter(
      (parameter) => childRawText(parameter, "parameterid") === "level",
    ).length;
    return levelCount > 1
      ? "audiolevels_duplicate_parameter"
      : "audiolevels_extra_parameter";
  }

  const parameter = parameters[0];
  if (childRawText(parameter, "parameterid") !== "level") {
    return "audiolevels_parameter_identity_invalid";
  }
  if (
    parameter.attributeNames.some(
      (name) => name !== "authoringApp" || parameter.attrs[name] !== "FinalCutPro",
    ) ||
    parameter.children.some((child) =>
      !["parameterid", "name", "valuemin", "valuemax", "value", "keyframe"].includes(child.tag)
    ) ||
    findChildren(parameter, "parameterid").length !== 1 ||
    findChildren(parameter, "name").length !== 1 ||
    childRawText(parameter, "name").trim() !== "Level" ||
    findChildren(parameter, "valuemin").length !== 1 ||
    findChildren(parameter, "valuemax").length !== 1 ||
    exactFiniteNumber(parameter, "valuemin") !== 0 ||
    exactFiniteNumber(parameter, "valuemax") !== 4
  ) return "audiolevels_parameter_shape_unsupported";

  const values = findChildren(parameter, "value");
  const keyframes = findChildren(parameter, "keyframe");
  if (keyframes.length === 0) {
    if (values.length !== 1) return "audiolevels_parameter_shape_unsupported";
    const value = exactFiniteNumber(parameter, "value");
    if (value === undefined) return "audiolevels_value_non_finite";
    return value >= 0 && value <= 4
      ? undefined
      : "audiolevels_value_out_of_range";
  }
  if (values.length !== 0 || keyframes.length < 2 || keyframes.length > 4) {
    return "audiolevels_keyframe_shape_unsupported";
  }

  const parsed = keyframes.map((keyframe) => {
    if (
      keyframe.attributeNames.length !== 0 ||
      keyframe.children.length !== 2 ||
      keyframe.children.some((child) => !["when", "value"].includes(child.tag)) ||
      findChildren(keyframe, "when").length !== 1 ||
      findChildren(keyframe, "value").length !== 1
    ) return undefined;
    const when = exactSafeInteger(keyframe, "when");
    const value = exactFiniteNumber(keyframe, "value");
    return when === undefined || value === undefined ? undefined : { when, value };
  });
  if (parsed.some((entry) => entry === undefined)) {
    const hasNonFiniteValue = keyframes.some(
      (keyframe) => exactFiniteNumber(keyframe, "value") === undefined,
    );
    return hasNonFiniteValue
      ? "audiolevels_value_non_finite"
      : "audiolevels_keyframe_time_invalid";
  }
  const points = parsed as Array<{ when: number; value: number }>;
  if (points.some(({ value }) => value < 0 || value > 4)) {
    return "audiolevels_value_out_of_range";
  }
  if (
    !Number.isSafeInteger(clipDuration) || clipDuration <= 0 ||
    points.some(({ when }) => when < 0 || when > clipDuration) ||
    points.some((point, index) => index > 0 && point.when <= points[index - 1].when)
  ) return "audiolevels_keyframe_time_invalid";

  const same = (a: number, b: number) => Math.abs(a - b) <= 1e-12;
  const startsAtZero = points[0].when === 0;
  const endsAtDuration = points.at(-1)!.when === clipDuration;
  const valuesOnly = points.map(({ value }) => value);
  const supported =
    (points.length === 2 && startsAtZero && (
      (same(valuesOnly[0], 0) && valuesOnly[1] > 0) ||
      (valuesOnly[0] > 0 && same(valuesOnly[1], 0) && endsAtDuration)
    )) ||
    (points.length === 3 && startsAtZero && endsAtDuration && (
      (same(valuesOnly[0], 0) && valuesOnly[1] > 0 && same(valuesOnly[2], 0)) ||
      (valuesOnly[0] > 0 && same(valuesOnly[0], valuesOnly[1]) && same(valuesOnly[2], 0))
    )) ||
    (points.length === 4 && startsAtZero && endsAtDuration &&
      same(valuesOnly[0], 0) && valuesOnly[1] > 0 &&
      same(valuesOnly[1], valuesOnly[2]) && same(valuesOnly[3], 0));
  return supported ? undefined : "audiolevels_keyframe_shape_unsupported";
}

function parseClipItem(
  clipitem: XmlNode,
  fileMap: Map<string, string>,
): ParsedFcp7Clip {
  const xmlClipId = clipitem.attrs.id ?? "";
  const clipName = childText(clipitem, "name");
  const start = childInt(clipitem, "start");
  const end = childInt(clipitem, "end");
  const inPt = childInt(clipitem, "in");
  const outPt = childInt(clipitem, "out");

  // File reference
  const fileNode = findChild(clipitem, "file");
  let fileId = "";
  let pathurl = "";
  let fileDefinitionInline = false;
  if (fileNode) {
    fileId = fileNode.attrs.id ?? "";
    if (fileNode.children.length > 0) {
      fileDefinitionInline = true;
      pathurl = childText(fileNode, "pathurl");
      if (pathurl) fileMap.set(fileId, pathurl);
    } else {
      pathurl = fileMap.get(fileId) ?? "";
    }
  }

  let videoOsMeta: VideoOsMarkerMeta | null = null;
  const videoOsMarkers: VideoOsMarkerMeta[] = [];
  let videoOsMarkerMalformed = false;
  let editorialMarker: ParsedEditorialMarker | undefined;
  for (const marker of findChildren(clipitem, "marker")) {
    const comment = childText(marker, "comment");
    const meta = parseVideoOsMarker(comment);
    if (meta) {
      videoOsMarkers.push(meta);
      videoOsMeta = meta;
      continue;
    }
    if (comment.startsWith("video_os:")) {
      videoOsMarkerMalformed = true;
      continue;
    }

    const editorial = parseEditorialMarker(marker);
    if (editorial && !editorialMarker) {
      editorialMarker = editorial;
    }
  }

  const unsupportedEditSignals: ParsedUnsupportedEditSignal[] = [];
  let speedIndex = 0;
  let rateIndex = 0;
  let filterIndex = 0;
  const audioLevelsSignals: Array<Extract<ParsedUnsupportedEditSignal, { kind: "filter_effect" }>> = [];
  for (const child of clipitem.children) {
    if (child.tag === "speed") {
      unsupportedEditSignals.push({ kind: "speed", speedIndex });
      speedIndex++;
      continue;
    }
    if (child.tag === "rate") {
      unsupportedEditSignals.push({
        kind: "rate",
        rateIndex,
        timebase: childRawText(child, "timebase"),
        ntsc: childRawText(child, "ntsc"),
      });
      rateIndex++;
      continue;
    }
    if (child.tag !== "filter") continue;

    const effects = findChildren(child, "effect");
    if (effects.length === 0) {
      unsupportedEditSignals.push({ kind: "filter_missing_effect", filterIndex });
    } else {
      for (const [effectIndex, effect] of effects.entries()) {
        const signal: Extract<ParsedUnsupportedEditSignal, { kind: "filter_effect" }> = {
          kind: "filter_effect",
          filterIndex,
          effectIndex,
          effectId: childRawText(effect, "effectid"),
          effectName: childRawText(effect, "name"),
        };
        if (signal.effectId === "audiolevels") {
          signal.audioLevelsValidationReason = audioLevelsEffectValidationReason(
            child,
            effect,
            end - start,
          );
          audioLevelsSignals.push(signal);
        }
        unsupportedEditSignals.push(signal);
      }
    }
    filterIndex++;
  }
  if (audioLevelsSignals.length > 1) {
    for (const signal of audioLevelsSignals) {
      signal.audioLevelsValidationReason = "audiolevels_duplicate_effect";
    }
  }

  // Audio level from filter
  let audioLevelDb: number | undefined;
  let audioGainLinear: number | undefined;
  let fadeInFrames: number | undefined;
  let fadeOutFrames: number | undefined;

  for (const filterNode of findChildren(clipitem, "filter")) {
    const effect = findChild(filterNode, "effect");
    if (
      effect &&
      childRawText(effect, "effectid") === "audiolevels" &&
      audioLevelsEffectValidationReason(filterNode, effect, end - start) === undefined &&
      audioLevelsSignals.length === 1
    ) {
      const param = findChildren(effect, "parameter").find(
        (p) => childText(p, "parameterid") === "level",
      );
      if (!param) continue;

      const hasValueRange = findChild(param, "valuemin") !== undefined;
      const keyframes = findChildren(param, "keyframe");

      if (keyframes.length > 0) {
        const kfs = keyframes
          .map((kf) => ({
            when: childInt(kf, "when"),
            value: parseFloat(childText(kf, "value")),
          }))
          .sort((a, b) => a.when - b.when);

        const bodyGain = Math.max(...kfs.map((kf) => kf.value));
        if (bodyGain > 0) {
          audioGainLinear = bodyGain;
        }

        if (kfs.length >= 2 && kfs[0].value === 0 && kfs[1].value > 0) {
          fadeInFrames = kfs[1].when - kfs[0].when;
        }

        if (
          kfs.length >= 2 &&
          kfs[kfs.length - 1].value === 0 &&
          kfs[kfs.length - 2].value > 0
        ) {
          fadeOutFrames =
            kfs[kfs.length - 1].when - kfs[kfs.length - 2].when;
        }
      } else if (hasValueRange) {
        const val = parseFloat(childText(param, "value"));
        if (!isNaN(val)) {
          audioGainLinear = val;
        }
      } else {
        const val = parseFloat(childText(param, "value"));
        if (!isNaN(val)) {
          audioLevelDb = val;
        }
      }
    }
  }

  return {
    xmlClipId,
    name: clipName,
    timelineInFrame: start,
    timelineEndFrame: end,
    srcInFrame: inPt,
    srcOutFrame: outPt,
    videoOsMeta,
    videoOsMarkers,
    ...(videoOsMarkerMalformed ? { videoOsMarkerMalformed: true as const } : {}),
    fileId,
    pathurl,
    fileDefinitionInline,
    audioLevelDb,
    audioGainLinear,
    fadeInFrames,
    fadeOutFrames,
    editorialMarker,
    unsupportedEditSignals,
    markerlessCandidateAudit: auditMarkerlessCandidate(clipitem),
    mappedMoveCandidateAudit: auditMappedMoveCandidate(clipitem),
  };
}

function parseTransitionItem(transitionitem: XmlNode): ParsedFcp7Transition {
  const effect = findChild(transitionitem, "effect");
  const comment = childText(transitionitem, "comment");
  const prefix = "video_os_transition:";
  let markerStatus: ParsedFcp7Transition["markerStatus"] = "missing";
  let marker: Record<string, unknown> | undefined;
  if (comment.startsWith(prefix)) {
    try {
      const parsed = JSON.parse(comment.slice(prefix.length));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        marker = parsed as Record<string, unknown>;
        markerStatus = ["transition_id", "track_id", "from_clip_id", "to_clip_id"].every(
          (field) => typeof marker![field] === "string" && (marker![field] as string).length > 0,
        ) ? "exact" : "malformed";
      } else {
        markerStatus = "malformed";
      }
    } catch {
      markerStatus = "malformed";
    }
  }
  return {
    startFrame: childInt(transitionitem, "start"),
    endFrame: childInt(transitionitem, "end"),
    alignment: childText(transitionitem, "alignment"),
    effectName: effect ? childText(effect, "name") : "",
    effectId: effect ? childText(effect, "effectid") : "",
    mediaType: effect ? childText(effect, "mediatype") : "",
    markerStatus,
    ...(markerStatus === "exact" ? {
      transitionId: marker!.transition_id as string,
      markedTrackId: marker!.track_id as string,
      markedFromClipId: marker!.from_clip_id as string,
      markedToClipId: marker!.to_clip_id as string,
    } : {}),
  };
}

function parseTrackItems(
  trackNode: XmlNode,
  fileMap: Map<string, string>,
): {
  clips: ParsedFcp7Clip[];
  transitions: ParsedFcp7Transition[];
} {
  const clips: ParsedFcp7Clip[] = [];
  const transitions: ParsedFcp7Transition[] = [];
  const pendingTransitions: ParsedFcp7Transition[] = [];
  let previousClip: ParsedFcp7Clip | undefined;

  for (const child of trackNode.children) {
    if (child.tag === "clipitem") {
      const clip = parseClipItem(child, fileMap);
      clips.push(clip);

      for (const transition of pendingTransitions) {
        transition.toXmlClipId = clip.xmlClipId;
        transition.toClipId =
          clip.videoOsMeta?.clip_id ?? deriveClipIdFromXmlId(clip.xmlClipId);
      }
      pendingTransitions.length = 0;
      previousClip = clip;
      continue;
    }

    if (child.tag === "transitionitem") {
      const transition = parseTransitionItem(child);
      if (previousClip) {
        transition.fromXmlClipId = previousClip.xmlClipId;
        transition.fromClipId =
          previousClip.videoOsMeta?.clip_id ??
          deriveClipIdFromXmlId(previousClip.xmlClipId);
      }
      transitions.push(transition);
      pendingTransitions.push(transition);
    }
  }

  return { clips, transitions };
}

// ── Sequence parsing ─────────────────────────────────────────────────

/**
 * Parse a complete FCP7 XML string into a ParsedFcp7Sequence.
 */
export function parseFcp7Sequence(xmlString: string): ParsedFcp7Sequence {
  const root = parseFcp7Xml(xmlString);

  // Navigate to <sequence>
  const sequence =
    root.tag === "sequence" ? root : findChild(root, "sequence");
  if (!sequence) {
    throw new Error("No <sequence> element found in XML");
  }

  const name = childText(sequence, "name");
  const duration = childInt(sequence, "duration");

  // Rate
  const rateNode = findChild(sequence, "rate");
  const timebase = rateNode ? childInt(rateNode, "timebase", 24) : 24;
  const ntsc =
    rateNode ? childText(rateNode, "ntsc").toUpperCase() === "TRUE" : false;

  // Timecode format
  const tcNode = findChild(sequence, "timecode");
  const timecodeFormat = tcNode ? childText(tcNode, "displayformat") : "NDF";

  // Media → Video / Audio
  const media = findChild(sequence, "media");
  const videoNode = media ? findChild(media, "video") : undefined;
  const audioNode = media ? findChild(media, "audio") : undefined;

  // Video format → width/height
  let width = 1920;
  let height = 1080;
  if (videoNode) {
    const format = findChild(videoNode, "format");
    if (format) {
      const sc = findChild(format, "samplecharacteristics");
      if (sc) {
        width = childInt(sc, "width", 1920);
        height = childInt(sc, "height", 1080);
      }
    }
  }

  // Collect file definitions across all tracks
  const fileMap = new Map<string, string>();
  const fileDefinitionObservations = new Map<string, Array<string | undefined>>();
  let malformedFileDefinition = false;

  function collectFiles(trackNode: XmlNode): void {
    for (const clipitem of findChildren(trackNode, "clipitem")) {
      for (const fileNode of findChildren(clipitem, "file")) {
        if (fileNode.children.length === 0 && fileNode.rawText === "") continue;
        const fileId = fileNode.attrs.id ?? "";
        if (!hasExactAttributes(fileNode, ["id"]) || !fileId) {
          malformedFileDefinition = true;
          continue;
        }
        const observations = fileDefinitionObservations.get(fileId) ?? [];
        const pathNodes = findChildren(fileNode, "pathurl");
        const pathNode = pathNodes[0];
        let decodedPathurl: string | undefined;
        if (
          pathNodes.length === 1 &&
          pathNode &&
          isScalarNode(pathNode) &&
          pathNode.rawText !== ""
        ) {
          try {
            decodedPathurl = decodeURIComponent(pathNode.rawText);
          } catch {
            decodedPathurl = undefined;
          }
        }
        observations.push(decodedPathurl);
        fileDefinitionObservations.set(fileId, observations);

        const pathurl = pathNode?.text ?? "";
        if (pathurl) {
          fileMap.set(fileId, pathurl);
        }
      }
    }
  }

  const videoTrackNodes = videoNode ? findChildren(videoNode, "track") : [];
  const audioTrackNodes = audioNode ? findChildren(audioNode, "track") : [];
  for (const trackNode of [...videoTrackNodes, ...audioTrackNodes]) {
    collectFiles(trackNode);
  }
  const expectedSequenceRate: [number, number] = ntsc
    ? [timebase * 1_000, 1_001]
    : [timebase, 1];
  const textOverlayGenerators = videoTrackNodes.flatMap((trackNode) =>
    findChildren(trackNode, "generatoritem").map(parseTextOverlayGenerator)
  ).map((generator): ParsedTextOverlayGenerator =>
    generator.status === "exact" && generator.endFrame! > duration
      ? { ...generator, status: "malformed", reason: "generator end exceeds sequence duration" }
      : generator.status === "exact" &&
          (generator.rateNum !== expectedSequenceRate[0] || generator.rateDen !== expectedSequenceRate[1])
        ? { ...generator, status: "malformed", reason: "generator rate differs from sequence rate" }
        : generator
  );

  const fileIdentities = new Map<string, ParsedFileIdentity>();
  for (const [fileId, observations] of fileDefinitionObservations) {
    const decodedPaths = new Set(observations.filter(
      (value): value is string => value !== undefined && value !== "",
    ));
    const valid =
      observations.length > 0 &&
      observations.every((value) => value !== undefined && value !== "") &&
      decodedPaths.size === 1;
    fileIdentities.set(fileId, {
      valid,
      ...(valid ? { decodedPathurl: [...decodedPaths][0] } : {}),
    });
  }

  // Parse video tracks
  const videoTracks: ParsedFcp7Clip[][] = [];
  const videoTransitions: ParsedFcp7Transition[][] = [];
  for (const trackNode of videoTrackNodes) {
    const parsedTrack = parseTrackItems(trackNode, fileMap);
    videoTracks.push(parsedTrack.clips);
    videoTransitions.push(parsedTrack.transitions);
  }

  // Parse audio tracks
  const audioTracks: ParsedFcp7Clip[][] = [];
  const audioTransitions: ParsedFcp7Transition[][] = [];
  for (const trackNode of audioTrackNodes) {
    const parsedTrack = parseTrackItems(trackNode, fileMap);
    audioTracks.push(parsedTrack.clips);
    audioTransitions.push(parsedTrack.transitions);
  }

  return {
    name,
    timebase,
    ntsc,
    width,
    height,
    duration,
    timecodeFormat,
    videoTracks,
    videoTransitions,
    audioTracks,
    audioTransitions,
    fileMap,
    fileIdentities,
    malformedFileDefinition,
    textOverlayGenerators,
  };
}

// ── Frame / Microsecond conversion ───────────────────────────────────

function framesToUs(frames: number, fps: number): number {
  return Math.round((frames / fps) * 1_000_000);
}

function findOriginalTransition(
  timeline: TimelineIR,
  trackId: string,
  fromClipId: string,
  toClipId: string,
): TimelineTransitionOutput | undefined {
  return timeline.transitions?.find(
    (transition) =>
      transition.track_id === trackId &&
      transition.from_clip_id === fromClipId &&
      transition.to_clip_id === toClipId,
  );
}

// ── Convert parsed FCP7 to TimelineIR ────────────────────────────────

/**
 * Convert a parsed FCP7 sequence to a TimelineIR.
 * Only clips with video_os markers are fully mapped; unmapped clips get
 * synthetic IDs prefixed with "unmapped_".
 */
export function parsedSequenceToTimelineIR(
  parsed: ParsedFcp7Sequence,
  referenceTimeline?: TimelineIR,
): TimelineIR {
  const fps = parsed.timebase;
  let unmappedCounter = 0;

  function convertClip(
    clip: ParsedFcp7Clip,
    trackKind: "video" | "audio",
  ): ClipOutput {
    const meta = clip.videoOsMeta;
    const marker = clip.editorialMarker;
    const srcInUs = framesToUs(clip.srcInFrame, fps);
    const srcOutUs = framesToUs(clip.srcOutFrame, fps);
    const timelineDuration = clip.timelineEndFrame - clip.timelineInFrame;

    if (meta) {
      // Look up original clip for preserved fields
      const origClip = referenceTimeline
        ? findOriginalClip(referenceTimeline, meta.clip_id)
        : undefined;

      const role =
        origClip?.role ??
        marker?.role ??
        (trackKind === "audio" ? "music" : "hero");

      // Build audio_policy from parsed audio data
      const audioPolicy = buildAudioPolicy(clip, role, origClip?.audio_policy);

      return {
        clip_id: meta.clip_id,
        segment_id: origClip?.segment_id ?? meta.clip_id,
        asset_id: meta.asset_id,
        src_in_us: srcInUs,
        src_out_us: srcOutUs,
        timeline_in_frame: clip.timelineInFrame,
        timeline_duration_frames: timelineDuration,
        role,
        motivation:
          marker?.motivation ??
          meta.motivation ??
          origClip?.motivation ??
          clip.name,
        beat_id: marker?.beat_id ?? meta.beat_id,
        fallback_segment_ids: origClip?.fallback_segment_ids ?? [],
        confidence: origClip?.confidence ?? marker?.confidence ?? 1.0,
        quality_flags: origClip?.quality_flags ?? [],
        audio_policy: audioPolicy,
        candidate_ref: origClip?.candidate_ref,
        fallback_candidate_refs: origClip?.fallback_candidate_refs,
        metadata: origClip?.metadata,
      };
    }

    // Unmapped clip (added in Premiere)
    unmappedCounter++;
    return {
      clip_id: `unmapped_${unmappedCounter}`,
      segment_id: `unmapped_seg_${unmappedCounter}`,
      asset_id: `unmapped_asset_${unmappedCounter}`,
      src_in_us: srcInUs,
      src_out_us: srcOutUs,
      timeline_in_frame: clip.timelineInFrame,
      timeline_duration_frames: timelineDuration,
      role: marker?.role ?? (trackKind === "audio" ? "music" : "hero"),
      motivation:
        marker?.motivation ?? clip.name ?? "Unmapped clip from Premiere",
      beat_id: marker?.beat_id ?? "unknown",
      fallback_segment_ids: [],
      confidence: marker?.confidence ?? 0,
      quality_flags: ["unmapped_premiere_clip"],
    };
  }

  const videoTracks: TrackOutput[] = parsed.videoTracks.map((clips, i) => ({
    track_id: referenceTimeline?.tracks.video[i]?.track_id ?? `V${i + 1}`,
    kind: "video" as const,
    clips: clips.map((c) => convertClip(c, "video")),
  }));

  const audioTracks: TrackOutput[] = parsed.audioTracks.map((clips, i) => ({
    track_id: referenceTimeline?.tracks.audio[i]?.track_id ?? `A${i + 1}`,
    kind: "audio" as const,
    clips: clips.map((c) => convertClip(c, "audio")),
  }));

  const importedTransitions: TimelineTransitionOutput[] = parsed.videoTransitions
    .flatMap((trackTransitions, i) => {
      const trackId =
        referenceTimeline?.tracks.video[i]?.track_id ?? `V${i + 1}`;
      return trackTransitions.flatMap((transition, index) => {
        const fromClipId =
          transition.fromClipId ??
          deriveClipIdFromXmlId(transition.fromXmlClipId ?? "");
        const toClipId =
          transition.toClipId ??
          deriveClipIdFromXmlId(transition.toXmlClipId ?? "");
        if (!fromClipId || !toClipId) return [];

        const originalTransition = referenceTimeline
          ? findOriginalTransition(
              referenceTimeline,
              trackId,
              fromClipId,
              toClipId,
            )
          : undefined;
        const parsedEffect = parsedSimpleTransitionEffect(transition);
        if (
          !parsedEffect ||
          transition.markerStatus !== "exact" ||
          transition.markedTrackId !== trackId ||
          transition.markedFromClipId !== fromClipId ||
          transition.markedToClipId !== toClipId ||
          (originalTransition && (
            transition.transitionId !== originalTransition.transition_id ||
            parsedEffect !== canonicalSimpleTransitionEffect(originalTransition)
          )) ||
          (referenceTimeline && !originalTransition)
        ) return [];
        const inferredType = parsedEffect === "dissolve" ? "crossfade" : "match_cut";
        const transitionFrames = Math.max(
          1,
          transition.endFrame - transition.startFrame,
        );

        const restored: TimelineTransitionOutput = {
          transition_id:
            originalTransition?.transition_id ?? transition.transitionId!,
          from_clip_id: fromClipId,
          to_clip_id: toClipId,
          track_id: trackId,
          transition_type:
            originalTransition?.transition_type ??
            inferredType,
          transition_frames: transitionFrames,
        };

        if (originalTransition?.transition_params) {
          restored.transition_params = {
            ...originalTransition.transition_params,
          };
        } else if (!originalTransition && inferredType === "crossfade") {
          restored.transition_params = {
            crossfade_sec: transitionFrames / fps,
          };
        }

        if (originalTransition?.applied_skill_id) {
          restored.applied_skill_id = originalTransition.applied_skill_id;
        }
        if (originalTransition?.degraded_from_skill_id !== undefined) {
          restored.degraded_from_skill_id =
            originalTransition.degraded_from_skill_id;
        }
        if (originalTransition?.confidence !== undefined) {
          restored.confidence = originalTransition.confidence;
        }

        return restored;
      });
    });

  const base = referenceTimeline ?? {
    version: "1.0.0",
    project_id: "imported",
    created_at: new Date().toISOString(),
    sequence: {
      name: parsed.name,
      fps_num: parsed.timebase,
      fps_den: 1,
      width: parsed.width,
      height: parsed.height,
      start_frame: 0,
      timecode_format: parsed.timecodeFormat as "NDF" | "DF" | "AUTO",
    },
    markers: [] as MarkerOutput[],
    provenance: {
      brief_path: "",
      blueprint_path: "",
      selects_path: "",
      compiler_version: "fcp7-import",
    },
  };

  const restoredTimeline: TimelineIR = {
    ...base,
    sequence: {
      ...base.sequence,
      name: parsed.name,
      fps_num: parsed.timebase,
      fps_den: 1,
      width: parsed.width,
      height: parsed.height,
      timecode_format: parsed.timecodeFormat as "NDF" | "DF" | "AUTO",
    },
    tracks: {
      video: videoTracks,
      audio: audioTracks,
    },
  };

  if (importedTransitions.length > 0) {
    restoredTimeline.transitions = importedTransitions;
  } else {
    delete restoredTimeline.transitions;
  }

  return restoredTimeline;
}

/**
 * Build an AudioPolicy from parsed FCP7 clip audio data.
 * Maps parsed gain into the reference policy's shared unit and assigns it to the
 * correct field based on clip role. Missing individual fades can be removed
 * when the remaining parsed audio-level metadata proves the filter still exists.
 */
function buildAudioPolicy(
  clip: ParsedFcp7Clip,
  role: string,
  origPolicy?: AudioPolicy,
  deletedFadeFields: FadePolicyField[] = [],
): AudioPolicy | undefined {
  const isBgm = role === "bgm" || role === "music";
  const hasNewGain = clip.audioGainLinear !== undefined;
  const hasLegacyGain = clip.audioLevelDb !== undefined;
  const hasFadeIn = clip.fadeInFrames !== undefined && clip.fadeInFrames > 0;
  const hasFadeOut = clip.fadeOutFrames !== undefined && clip.fadeOutFrames > 0;

  if (
    !hasNewGain && !hasLegacyGain && !hasFadeIn && !hasFadeOut &&
    deletedFadeFields.length === 0
  ) {
    return origPolicy;
  }

  let policy: AudioPolicy = origPolicy ? { ...origPolicy } : {};

  if (hasNewGain) {
    const gainDb = Math.round(linearGainToDb(clip.audioGainLinear!) * 100) / 100;
    const gainField = isBgm ? "bgm_gain" : "nat_sound_gain";
    if (origPolicy?.gain_unit === "linear") {
      policy[gainField] = clip.audioGainLinear!;
    } else if (origPolicy?.gain_unit === "db") {
      policy[gainField] = gainDb;
    } else {
      policy = saveAudioGainFieldAsDb(policy, gainField, gainDb);
    }
  } else if (hasLegacyGain) {
    // Legacy format: raw dB stored as duck_music_db
    policy.duck_music_db = clip.audioLevelDb;
  }

  if (hasFadeIn) {
    if (isBgm) {
      policy.bgm_fade_in_frames = clip.fadeInFrames;
    } else {
      policy.nat_sound_fade_in_frames = clip.fadeInFrames;
    }
  }

  if (hasFadeOut) {
    if (isBgm) {
      policy.bgm_fade_out_frames = clip.fadeOutFrames;
    } else {
      policy.nat_sound_fade_out_frames = clip.fadeOutFrames;
    }
  }

  for (const field of deletedFadeFields) delete policy[field];

  return policy;
}

const AUDIO_GAIN_DB_TOLERANCE = 0.05;

type FadePolicyField =
  | "fade_in_frames"
  | "fade_out_frames"
  | "nat_sound_fade_in_frames"
  | "nat_sound_fade_out_frames"
  | "bgm_fade_in_frames"
  | "bgm_fade_out_frames";

interface ReferenceFade {
  frames: number;
  policyField?: FadePolicyField;
}

interface AudioPolicyComparison {
  changed: boolean;
  deletedFadeFields: FadePolicyField[];
}

function referenceRequiresAudioLevels(
  clip: ClipOutput,
  reference: TimelineIR,
): boolean {
  const isBgm = clip.role === "bgm" || clip.role === "music";
  const gain = resolveAudioGainWithFallback(
    clip.audio_policy,
    reference.audio_mix,
    isBgm ? "bgm" : "nat_sound",
    { fallbackToDuckMusicDb: isBgm },
  );
  const fades = exporterExpectedFades(
    clip.audio_policy,
    reference,
    isBgm,
    clip.timeline_duration_frames,
  );
  return gain.sourceField !== null || fades.fadeIn.frames > 0 || fades.fadeOut.frames > 0;
}

function resolveReferenceFade(
  refPolicy: AudioPolicy | undefined,
  reference: TimelineIR,
  isBgm: boolean,
  direction: "in" | "out",
): ReferenceFade {
  const roleField: FadePolicyField = isBgm
    ? `bgm_fade_${direction}_frames`
    : `nat_sound_fade_${direction}_frames`;
  const genericField: FadePolicyField = `fade_${direction}_frames`;
  const policyRoleValue = refPolicy?.[roleField];
  if (policyRoleValue !== undefined) {
    return { frames: policyRoleValue, policyField: roleField };
  }
  const policyGenericValue = refPolicy?.[genericField];
  if (policyGenericValue !== undefined) {
    return { frames: policyGenericValue, policyField: genericField };
  }
  const mixRoleValue = reference.audio_mix?.[roleField];
  if (mixRoleValue !== undefined) return { frames: mixRoleValue };
  return { frames: reference.audio_mix?.[genericField] ?? 0 };
}

function exporterExpectedFades(
  refPolicy: AudioPolicy | undefined,
  reference: TimelineIR,
  isBgm: boolean,
  durationFrames: number,
): { fadeIn: ReferenceFade; fadeOut: ReferenceFade } {
  const fadeIn = resolveReferenceFade(refPolicy, reference, isBgm, "in");
  const fadeOut = resolveReferenceFade(refPolicy, reference, isBgm, "out");
  fadeIn.frames = fadeIn.frames > 0 ? fadeIn.frames : 0;
  fadeOut.frames = fadeOut.frames > 0 ? fadeOut.frames : 0;

  if (fadeIn.frames + fadeOut.frames > durationFrames) {
    const total = fadeIn.frames + fadeOut.frames;
    fadeIn.frames = Math.round((fadeIn.frames / total) * durationFrames);
    fadeOut.frames = durationFrames - fadeIn.frames;
  }
  return { fadeIn, fadeOut };
}

function compareParsedAudioPolicy(
  clip: ParsedFcp7Clip,
  role: string,
  reference: TimelineIR,
  refPolicy?: AudioPolicy,
): AudioPolicyComparison {
  const isBgm = role === "bgm" || role === "music";
  let gainChanged = false;

  if (clip.audioGainLinear !== undefined) {
    const parsedGainDb = linearGainToDb(clip.audioGainLinear);
    const referenceGain = resolveAudioGainWithFallback(
      refPolicy,
      reference.audio_mix,
      isBgm ? "bgm" : "nat_sound",
      { fallbackToDuckMusicDb: isBgm },
    );
    if (Math.abs(parsedGainDb - referenceGain.gainDb) > AUDIO_GAIN_DB_TOLERANCE) {
      gainChanged = true;
    }
  } else if (clip.audioLevelDb !== undefined) {
    const referenceLevel = refPolicy?.duck_music_db ?? reference.audio_mix?.duck_music_db ?? 0;
    if (Math.abs(clip.audioLevelDb - referenceLevel) > AUDIO_GAIN_DB_TOLERANCE) {
      gainChanged = true;
    }
  }

  const { fadeIn, fadeOut } = exporterExpectedFades(
    refPolicy,
    reference,
    isBgm,
    clip.timelineEndFrame - clip.timelineInFrame,
  );
  const hasAudioFilterEvidence =
    clip.audioGainLinear !== undefined || clip.audioLevelDb !== undefined ||
    clip.fadeInFrames !== undefined || clip.fadeOutFrames !== undefined;
  const deletedFadeFields: FadePolicyField[] = [];

  const fadeInChanged = clip.fadeInFrames !== undefined
    ? clip.fadeInFrames !== fadeIn.frames
    : hasAudioFilterEvidence && fadeIn.frames > 0 && fadeIn.policyField !== undefined;
  if (clip.fadeInFrames === undefined && fadeInChanged && fadeIn.policyField) {
    deletedFadeFields.push(fadeIn.policyField);
  }

  const fadeOutChanged = clip.fadeOutFrames !== undefined
    ? clip.fadeOutFrames !== fadeOut.frames
    : hasAudioFilterEvidence && fadeOut.frames > 0 && fadeOut.policyField !== undefined;
  if (clip.fadeOutFrames === undefined && fadeOutChanged && fadeOut.policyField) {
    deletedFadeFields.push(fadeOut.policyField);
  }

  return {
    changed: gainChanged || fadeInChanged || fadeOutChanged,
    deletedFadeFields,
  };
}

function findOriginalClip(
  timeline: TimelineIR,
  clipId: string,
): ClipOutput | undefined {
  for (const track of [...timeline.tracks.video, ...timeline.tracks.audio]) {
    for (const clip of track.clips) {
      if (clip.clip_id === clipId) return clip;
    }
  }
  return undefined;
}

function exactFramesToUs(
  frames: number,
  rateNum: number,
  rateDen: number,
): number | undefined {
  if (
    !Number.isSafeInteger(frames) ||
    !Number.isSafeInteger(rateNum) ||
    !Number.isSafeInteger(rateDen) ||
    frames < 0 ||
    rateNum <= 0 ||
    rateDen <= 0
  ) return undefined;
  const scaledFrames = frames * 1_000_000;
  if (!Number.isSafeInteger(scaledFrames)) return undefined;
  const numerator = scaledFrames * rateDen;
  if (!Number.isSafeInteger(numerator)) return undefined;
  const result = Math.round(numerator / rateNum);
  return Number.isSafeInteger(result) ? result : undefined;
}

function requiredTemplateKey(clip: ClipOutput): string {
  return JSON.stringify({
    segment_id: clip.segment_id,
    asset_id: clip.asset_id,
    src_in_us: clip.src_in_us,
    src_out_us: clip.src_out_us,
    role: clip.role,
    motivation: clip.motivation,
    beat_id: clip.beat_id,
    fallback_segment_ids: clip.fallback_segment_ids,
    confidence: clip.confidence,
    quality_flags: clip.quality_flags,
  });
}

function exportedClipItemId(prefix: "cv" | "ca", clipId: string): string {
  const safe = clipId.replace(/[^a-zA-Z0-9_-]/g, (character) => {
    const code = character.charCodeAt(0);
    return code > 127 ? `x${code.toString(16)}` : "_";
  });
  return `${prefix}-${safe}`;
}

function clipTimelineInterval(clip: ClipOutput): [number, number] | undefined {
  if (
    !Number.isSafeInteger(clip.timeline_in_frame) ||
    !Number.isSafeInteger(clip.timeline_duration_frames) ||
    clip.timeline_in_frame < 0 ||
    clip.timeline_duration_frames <= 0
  ) return undefined;
  const end = clip.timeline_in_frame + clip.timeline_duration_frames;
  return Number.isSafeInteger(end) ? [clip.timeline_in_frame, end] : undefined;
}

function intervalsOverlap(
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
): boolean {
  return leftStart < rightEnd && rightStart < leftEnd;
}

function detectTextOverlayEdits(
  parsed: ParsedFcp7Sequence,
  reference: TimelineIR,
  receiptManifest?: readonly PremiereTextOverlayManifestEntry[],
): TextOverlayEditEntry[] {
  const edits: TextOverlayEditEntry[] = [];
  const expected = receiptManifest
    ? receiptManifest.map((item) => ({
        clipId: item.clip_id,
        overlayId: item.overlay_id,
        generatorId: item.xml_generator_id,
        text: item.text,
        startFrame: item.start_frame,
        endFrame: item.end_frame,
        durationFrames: item.duration_frames,
        fontSize: item.font_size,
        color: item.color,
        alpha: item.alpha,
        origin: item.origin,
      }))
    : (reference.tracks.overlay ?? []).flatMap((track) => track.clips.flatMap((clip) => {
        const rawOverlay = clip.metadata?.overlay;
        if (!rawOverlay || typeof rawOverlay !== "object" || Array.isArray(rawOverlay)) return [];
        const overlay = rawOverlay as Record<string, unknown>;
        if (typeof overlay.overlay_id !== "string" || typeof overlay.text !== "string") return [];
        return [{
          clipId: clip.clip_id,
          overlayId: overlay.overlay_id,
          generatorId: fcp7TextGeneratorItemId(clip.clip_id, overlay.overlay_id),
          text: overlay.text,
          startFrame: clip.timeline_in_frame,
          endFrame: clip.timeline_in_frame + clip.timeline_duration_frames,
          durationFrames: clip.timeline_duration_frames,
          fontSize: undefined,
          color: undefined,
          alpha: undefined,
          origin: undefined,
        }];
      }));
  const expectedByIdentity = new Map(expected.map((item) => [
    `${item.clipId}\0${item.overlayId}`,
    item,
  ]));
  const observedByIdentity = new Map<string, ParsedTextOverlayGenerator[]>();

  const push = (
    kind: TextOverlayEditKind,
    generator: ParsedTextOverlayGenerator,
    detail: string,
    field?: string,
  ) => edits.push({
    kind,
    surface: "text_overlay",
    disposition: "report_only",
    ...(generator.clipId ? { clip_id: generator.clipId } : {}),
    ...(generator.overlayId ? { overlay_id: generator.overlayId } : {}),
    ...(generator.xmlGeneratorId ? { xml_generator_id: generator.xmlGeneratorId } : {}),
    ...(field ? { field } : {}),
    detail,
  });

  for (const generator of parsed.textOverlayGenerators) {
    if (generator.status === "unmapped") {
      push("added_unmapped", generator, generator.reason ?? "unmapped generator item");
      continue;
    }
    if (generator.status === "malformed_marker") {
      push("malformed_marker", generator, generator.reason ?? "malformed text-overlay marker", "marker");
      continue;
    }
    const identity = `${generator.clipId}\0${generator.overlayId}`;
    const group = observedByIdentity.get(identity) ?? [];
    group.push(generator);
    observedByIdentity.set(identity, group);
  }

  for (const [identity, generators] of observedByIdentity) {
    const base = expectedByIdentity.get(identity);
    if (!base) {
      for (const generator of generators) {
        push("added_unmapped", generator, "marked generator has no canonical overlay identity");
      }
      continue;
    }
    if (generators.length !== 1) {
      push("duplicate", generators[0], `canonical overlay identity occurs ${generators.length} times`);
      continue;
    }
    const generator = generators[0];
    if (generator.status === "malformed") {
      push("malformed", generator, generator.reason ?? "marked generator shape is malformed");
      continue;
    }
    if (generator.xmlGeneratorId !== base.generatorId) {
      push("malformed", generator, "generator ID differs from canonical projection", "generator_id");
      continue;
    }
    if (generator.name !== base.text.split("\n")[0]) {
      push("malformed", generator, "generator name differs from canonical projection", "name");
    }
    if (generator.text !== base.text) {
      push("text_changed", generator, "canonical overlay text changed", "text");
    }
    if (
      generator.startFrame !== base.startFrame ||
      generator.endFrame !== base.endFrame ||
      generator.durationFrames !== base.durationFrames
    ) {
      push("timing_changed", generator, "canonical overlay timing changed", "timing");
    }
    if (base.fontSize !== undefined && (
      generator.fontSize !== base.fontSize ||
      JSON.stringify(generator.color) !== JSON.stringify(base.color) ||
      generator.alpha !== base.alpha ||
      JSON.stringify(generator.origin) !== JSON.stringify(base.origin)
    )) {
      push("style_changed", generator, "canonical overlay supported style changed", "style");
    }
  }

  for (const item of expected) {
    const identity = `${item.clipId}\0${item.overlayId}`;
    if (!observedByIdentity.has(identity)) {
      edits.push({
        kind: "deleted",
        surface: "text_overlay",
        disposition: "report_only",
        clip_id: item.clipId,
        overlay_id: item.overlayId,
        detail: "canonical overlay generator is missing",
      });
    }
  }
  return edits;
}

type SimpleTransitionEffect = "dissolve" | "dip_to_color";

function canonicalSimpleTransitionEffect(
  transition: TimelineTransitionOutput,
): SimpleTransitionEffect | undefined {
  const skillId = transition.applied_skill_id ?? transition.degraded_from_skill_id ?? "";
  if (["crossfade_bridge", "silence_beat", "build_to_peak", "fallback.crossfade"].includes(skillId)) {
    return "dissolve";
  }
  if (skillId === "match_cut_bridge") return "dip_to_color";
  if (transition.transition_type === "crossfade") return "dissolve";
  if (transition.transition_type === "match_cut") return "dip_to_color";
  return undefined;
}

function parsedSimpleTransitionEffect(
  transition: ParsedFcp7Transition,
): SimpleTransitionEffect | undefined {
  if (transition.mediaType !== "video") return undefined;
  if (transition.effectName === "Cross Dissolve" && transition.effectId === "CrossDissolve") {
    return "dissolve";
  }
  if (transition.effectName === "Dip to Color" && transition.effectId === "DipToColor") {
    return "dip_to_color";
  }
  return undefined;
}

function detectTransitionEdits(
  parsed: ParsedFcp7Sequence,
  reference: TimelineIR,
): TransitionEditEntry[] {
  const edits: TransitionEditEntry[] = [];
  const expected = (reference.transitions ?? []).filter(
    (transition) => canonicalSimpleTransitionEffect(transition) !== undefined,
  );
  const expectedByEdge = new Map(expected.map((transition) => [
    JSON.stringify([transition.track_id, transition.from_clip_id, transition.to_clip_id]),
    transition,
  ]));
  const matchedEdges = new Set<string>();
  const observedEdgeCounts = new Map<string, number>();
  const observedClipIds = new Set(
    parsed.videoTracks.flat().flatMap((clip) => clip.videoOsMeta?.clip_id ? [clip.videoOsMeta.clip_id] : []),
  );
  const push = (
    kind: TransitionEditKind,
    transition: ParsedFcp7Transition | undefined,
    detail: string,
    original?: TimelineTransitionOutput,
  ): void => {
    edits.push({
      kind,
      surface: "simple_transition",
      disposition: "report_only",
      transition_id: transition?.transitionId ?? original?.transition_id,
      track_id: transition?.markedTrackId ?? original?.track_id,
      from_clip_id: transition?.markedFromClipId ?? original?.from_clip_id,
      to_clip_id: transition?.markedToClipId ?? original?.to_clip_id,
      detail,
      source_handle_authority: "missing",
    });
  };

  for (const [trackIndex, transitions] of parsed.videoTransitions.entries()) {
    const observedTrackId = reference.tracks.video[trackIndex]?.track_id ?? `V${trackIndex + 1}`;
    for (const transition of transitions) {
      if (transition.markerStatus !== "exact") {
        push("identity_changed", transition, "transition marker identity is missing or malformed");
        const positionalEdge = transition.fromClipId && transition.toClipId
          ? JSON.stringify([observedTrackId, transition.fromClipId, transition.toClipId])
          : undefined;
        if (!positionalEdge || !expectedByEdge.has(positionalEdge)) {
          push("added", transition, "unmarked transition edge is not present in the reference timeline");
        }
        if (!transition.fromClipId || !transition.toClipId) {
          push("orphan_endpoint", transition, "unmarked transition does not have both adjacent clip endpoints");
        }
        if (!parsedSimpleTransitionEffect(transition)) {
          push("unknown_effect", transition, "unmarked returned effect is not the exact Cross Dissolve or Dip to Color shape");
        }
        continue;
      }
      const edge = JSON.stringify([
        transition.markedTrackId,
        transition.markedFromClipId,
        transition.markedToClipId,
      ]);
      observedEdgeCounts.set(edge, (observedEdgeCounts.get(edge) ?? 0) + 1);
      const original = expectedByEdge.get(edge);
      if (
        transition.markedTrackId !== observedTrackId ||
        transition.markedFromClipId !== transition.fromClipId ||
        transition.markedToClipId !== transition.toClipId
      ) {
        push("identity_changed", transition, "marked transition identity does not match its track and adjacent XML endpoints", original);
      }
      if (
        !transition.fromClipId ||
        !transition.toClipId ||
        !observedClipIds.has(transition.markedFromClipId!) ||
        !observedClipIds.has(transition.markedToClipId!)
      ) {
        push("orphan_endpoint", transition, "transition does not have both adjacent clip endpoints", original);
      }
      if (!original) {
        push("added", transition, "transition edge is not present in the reference timeline");
      } else {
        matchedEdges.add(edge);
        if (transition.transitionId !== original.transition_id) {
          push("identity_changed", transition, "transition_id differs from the reference transition", original);
        }
        const observedEffect = parsedSimpleTransitionEffect(transition);
        if (!observedEffect) {
          push("unknown_effect", transition, "returned effect is not the exact Cross Dissolve or Dip to Color shape", original);
        } else if (observedEffect !== canonicalSimpleTransitionEffect(original)) {
          push("effect_changed", transition, "transition effect differs from the reference transition", original);
        }
        const duration = transition.endFrame - transition.startFrame;
        if (!Number.isSafeInteger(duration) || duration <= 0 || duration !== original.transition_frames) {
          push("duration_changed", transition, "transition duration differs from the positive reference duration", original);
        }
        const referenceTrack = reference.tracks.video.find(
          (track) => track.track_id === original.track_id,
        );
        const referenceToClip = referenceTrack?.clips.find(
          (clip) => clip.clip_id === original.to_clip_id,
        );
        if (referenceToClip && Number.isSafeInteger(original.transition_frames)) {
          const expectedStart = referenceToClip.timeline_in_frame - Math.floor(original.transition_frames! / 2);
          const expectedEnd = expectedStart + original.transition_frames!;
          if (transition.startFrame !== expectedStart || transition.endFrame !== expectedEnd) {
            push(
              "window_changed",
              transition,
              `transition window differs from centered reference window ${expectedStart}-${expectedEnd}`,
              original,
            );
          }
        }
        if (transition.alignment !== "center") {
          push("alignment_changed", transition, "transition alignment is not center", original);
        }
      }
    }
  }

  for (const [edge, count] of observedEdgeCounts) {
    if (count > 1) {
      const original = expectedByEdge.get(edge);
      push("duplicate_edge", undefined, "more than one transition uses the same marked endpoint pair", original);
    }
  }
  for (const transition of expected) {
    const edge = JSON.stringify([transition.track_id, transition.from_clip_id, transition.to_clip_id]);
    if (!matchedEdges.has(edge)) {
      push("deleted", undefined, "reference transition is missing from the returned XML", transition);
    }
  }
  return edits;
}

// ── Diff Detection ───────────────────────────────────────────────────

/**
 * Compare an imported FCP7 sequence against a reference TimelineIR
 * and return a diff report.
 */
export function detectDiffs(
  parsed: ParsedFcp7Sequence,
  reference: TimelineIR,
  textOverlayManifest?: readonly PremiereTextOverlayManifestEntry[],
): ImportDiffReport {
  const fps = parsed.timebase;
  const diffs: ClipDiff[] = [];
  const unsupportedEdits: UnsupportedEditEntry[] = [];
  const textOverlayEdits = detectTextOverlayEdits(parsed, reference, textOverlayManifest);
  const transitionEdits = detectTransitionEdits(parsed, reference);

  // Collect parsed clips with stable structural locations.
  const allParsedClips = [
    ...parsed.videoTracks.flatMap((clips, trackIndex) =>
      clips.map((clip, clipIndex) => ({
        clip,
        trackKind: "video" as const,
        trackIndex,
        clipIndex,
      })),
    ),
    ...parsed.audioTracks.flatMap((clips, trackIndex) =>
      clips.map((clip, clipIndex) => ({
        clip,
        trackKind: "audio" as const,
        trackIndex,
        clipIndex,
      })),
    ),
  ];
  const parsedAudioClips = new Set(parsed.audioTracks.flat());
  const markerlessCandidates: Array<{
    clip: ParsedFcp7Clip;
    trackKind: "video" | "audio";
    trackIndex: number;
    clipIndex: number;
  }> = [];

  // Collect all reference clips by clip_id
  const refClipMap = new Map<string, ClipOutput>();
  for (const track of [
    ...reference.tracks.video,
    ...reference.tracks.audio,
  ]) {
    for (const clip of track.clips) {
      refClipMap.set(clip.clip_id, clip);
    }
  }

  // Track which reference clips were seen
  const seenClipIds = new Set<string>();
  let mappedCount = 0;
  let unmappedCount = 0;

  for (const {
    clip: parsedClip,
    trackKind,
    trackIndex,
    clipIndex,
  } of allParsedClips) {
    if (!parsedClip.videoOsMeta) {
      unmappedCount++;
      markerlessCandidates.push({
        clip: parsedClip,
        trackKind,
        trackIndex,
        clipIndex,
      });
      continue;
    }

    mappedCount++;
    const clipId = parsedClip.videoOsMeta.clip_id;
    seenClipIds.add(clipId);

    const refClip = refClipMap.get(clipId);
    if (!refClip) {
      // Clip has video_os marker but not in reference — shouldn't normally happen
      diffs.push({
        kind: "added_unmapped",
        clip_id: clipId,
        detail: `Clip "${clipId}" has video_os marker but not found in reference timeline`,
      });
      continue;
    }

    const evidenceBase: ClipEvidenceBase = {
      track_kind: trackKind,
      track_index: trackIndex,
      clip_index: clipIndex,
      xml_clip_id: parsedClip.xmlClipId,
    };
    for (const signal of parsedClip.unsupportedEditSignals ?? []) {
      if (signal.kind === "speed") {
        unsupportedEdits.push({
          kind: "unsupported_edit",
          clip_id: clipId,
          surface: "speed_time_remap",
          reason: "direct_speed_element_present",
          disposition: "non_applicable",
          detail: `Direct clip speed element is not supported for "${clipId}"`,
          evidence_location: {
            ...evidenceBase,
            element: "clipitem/speed",
            speed_index: signal.speedIndex,
          },
        });
        continue;
      }
      if (signal.kind === "rate") {
        const expectedTimebase = String(parsed.timebase);
        const expectedNtsc = parsed.ntsc ? "TRUE" : "FALSE";
        if (
          signal.timebase !== expectedTimebase ||
          signal.ntsc !== expectedNtsc
        ) {
          unsupportedEdits.push({
            kind: "unsupported_edit",
            clip_id: clipId,
            surface: "speed_time_remap",
            reason: "clip_rate_mismatch",
            disposition: "non_applicable",
            detail: `Direct clip rate differs from the sequence rate for "${clipId}"`,
            evidence_location: {
              ...evidenceBase,
              element: "clipitem/rate",
              rate_index: signal.rateIndex,
              expected_timebase: expectedTimebase,
              expected_ntsc: expectedNtsc,
              observed_timebase: signal.timebase,
              observed_ntsc: signal.ntsc,
            },
          });
        }
        continue;
      }
      if (signal.kind === "filter_missing_effect") {
        unsupportedEdits.push({
          kind: "unsupported_edit",
          clip_id: clipId,
          surface: "non_audio_level_clip_filter_effect",
          reason: "clip_filter_missing_effect",
          disposition: "non_applicable",
          detail: `Direct clip filter has no effect element for "${clipId}"`,
          evidence_location: {
            ...evidenceBase,
            element: "clipitem/filter",
            filter_index: signal.filterIndex,
          },
        });
        continue;
      }
      if (trackKind === "audio" && signal.effectId === "audiolevels") {
        if (signal.audioLevelsValidationReason) {
          unsupportedEdits.push({
            kind: "unsupported_edit",
            clip_id: clipId,
            surface: "audio_levels",
            reason: signal.audioLevelsValidationReason,
            disposition: "non_applicable",
            detail: `Audio Levels filter is not an unambiguous supported shape for "${clipId}"`,
            evidence_location: {
              ...evidenceBase,
              element: "clipitem/filter/effect",
              filter_index: signal.filterIndex,
              effect_index: signal.effectIndex,
              effect_id: signal.effectId,
              effect_name: signal.effectName,
            },
          });
        }
        continue;
      }
      unsupportedEdits.push({
        kind: "unsupported_edit",
        clip_id: clipId,
        surface: "non_audio_level_clip_filter_effect",
        reason: "clip_effect_not_supported_audiolevels",
        disposition: "non_applicable",
        detail: `Direct clip effect is not a supported audio-level effect for "${clipId}"`,
        evidence_location: {
          ...evidenceBase,
          element: "clipitem/filter/effect",
          filter_index: signal.filterIndex,
          effect_index: signal.effectIndex,
          effect_id: signal.effectId,
          effect_name: signal.effectName,
        },
      });
    }

    if (
      trackKind === "audio" &&
      referenceRequiresAudioLevels(refClip, reference) &&
      !(parsedClip.unsupportedEditSignals ?? []).some(
        (signal) => signal.kind === "filter_effect" && signal.effectId === "audiolevels",
      )
    ) {
      unsupportedEdits.push({
        kind: "unsupported_edit",
        clip_id: clipId,
        surface: "audio_levels",
        reason: "audiolevels_filter_missing",
        disposition: "non_applicable",
        detail: `Reference audio policy requires an Audio Levels filter for "${clipId}"`,
        evidence_location: {
          ...evidenceBase,
          element: "clipitem",
          expected: "filter/effect[effectid=audiolevels]",
        },
      });
    }

    // Check trim changes (in/out points)
    const newSrcInUs = framesToUs(parsedClip.srcInFrame, fps);
    const newSrcOutUs = framesToUs(parsedClip.srcOutFrame, fps);
    const newTimelineInFrame = parsedClip.timelineInFrame;
    const newDurationFrames =
      parsedClip.timelineEndFrame - parsedClip.timelineInFrame;

    // Use a tolerance of 1 frame for floating-point conversion differences
    const toleranceUs = framesToUs(1, fps);
    const srcInChanged =
      Math.abs(newSrcInUs - refClip.src_in_us) > toleranceUs;
    const srcOutChanged =
      Math.abs(newSrcOutUs - refClip.src_out_us) > toleranceUs;
    const timelineInChanged =
      newTimelineInFrame !== refClip.timeline_in_frame;
    const durationChanged =
      newDurationFrames !== refClip.timeline_duration_frames;

    if (srcInChanged || srcOutChanged || durationChanged) {
      diffs.push({
        kind: "trim_changed",
        clip_id: clipId,
        detail: `Trim changed for "${clipId}"`,
        original: {
          src_in_us: refClip.src_in_us,
          src_out_us: refClip.src_out_us,
          timeline_in_frame: refClip.timeline_in_frame,
          timeline_duration_frames: refClip.timeline_duration_frames,
        },
        updated: {
          src_in_us: newSrcInUs,
          src_out_us: newSrcOutUs,
          timeline_in_frame: newTimelineInFrame,
          timeline_duration_frames: newDurationFrames,
        },
      });
    } else if (timelineInChanged) {
      diffs.push({
        kind: "reordered",
        clip_id: clipId,
        detail: `Clip "${clipId}" moved from frame ${refClip.timeline_in_frame} to ${newTimelineInFrame}`,
        original: {
          src_in_us: refClip.src_in_us,
          src_out_us: refClip.src_out_us,
          timeline_in_frame: refClip.timeline_in_frame,
          timeline_duration_frames: refClip.timeline_duration_frames,
        },
        updated: {
          src_in_us: newSrcInUs,
          src_out_us: newSrcOutUs,
          timeline_in_frame: newTimelineInFrame,
          timeline_duration_frames: newDurationFrames,
        },
      });
    }

    const audioPolicyComparison = parsedAudioClips.has(parsedClip)
      ? compareParsedAudioPolicy(parsedClip, refClip.role, reference, refClip.audio_policy)
      : undefined;
    if (audioPolicyComparison?.changed) {
      const updatedAudioPolicy = buildAudioPolicy(
        parsedClip,
        refClip.role,
        refClip.audio_policy,
        audioPolicyComparison.deletedFadeFields,
      );
      diffs.push({
        kind: "audio_policy_changed",
        clip_id: clipId,
        detail: `Audio policy changed for "${clipId}"`,
        original_audio_policy: { ...(refClip.audio_policy ?? {}) },
        updated_audio_policy: { ...(updatedAudioPolicy ?? {}) },
      });
    }
  }

  // Detect deleted clips (in reference but not in parsed)
  for (const [clipId] of refClipMap) {
    if (!seenClipIds.has(clipId)) {
      diffs.push({
        kind: "deleted",
        clip_id: clipId,
        detail: `Clip "${clipId}" was deleted in Premiere`,
      });
    }
  }

  type CanonicalLocation = {
    track: TrackOutput;
    trackIndex: number;
    clipIndex: number;
    kind: "video" | "audio";
  };
  const canonicalLocations = new Map<string, CanonicalLocation[]>();
  for (const [kind, tracks] of [
    ["video", reference.tracks.video],
    ["audio", reference.tracks.audio],
  ] as const) {
    for (const [trackIndex, track] of tracks.entries()) {
      for (const [clipIndex, clip] of track.clips.entries()) {
        const locations = canonicalLocations.get(clip.clip_id) ?? [];
        locations.push({ track, trackIndex, clipIndex, kind });
        canonicalLocations.set(clip.clip_id, locations);
      }
    }
  }
  const xmlIdCounts = new Map<string, number>();
  const markerIdCounts = new Map<string, number>();
  for (const { clip } of allParsedClips) {
    xmlIdCounts.set(clip.xmlClipId, (xmlIdCounts.get(clip.xmlClipId) ?? 0) + 1);
    for (const marker of clip.videoOsMarkers ?? []) {
      markerIdCounts.set(marker.clip_id, (markerIdCounts.get(marker.clip_id) ?? 0) + 1);
    }
  }

  type ObservableMove = {
    clip: ParsedFcp7Clip;
    parsedTrack: ParsedFcp7Clip[];
    parsedTrackIndex: number;
    parsedClipIndex: number;
    source: CanonicalLocation;
  };
  const observableVideoMoves = new Map<string, ObservableMove>();
  for (const [parsedTrackIndex, parsedTrack] of parsed.videoTracks.entries()) {
    const uniqueLocations = parsedTrack.map((clip) => {
      const clipId = clip.videoOsMeta?.clip_id;
      if (!clipId) return undefined;
      const locations = canonicalLocations.get(clipId) ?? [];
      return locations.length === 1 && locations[0].kind === "video"
        ? locations[0]
        : undefined;
    });
    const canonicalTracksOnParsedTrack = new Set(
      uniqueLocations
        .filter((location): location is CanonicalLocation => location !== undefined)
        .map((location) => location.track),
    );
    const canonicalTrackCounts = uniqueLocations.reduce((counts, location) => {
      if (location) counts.set(location.track, (counts.get(location.track) ?? 0) + 1);
      return counts;
    }, new Map<TrackOutput, number>());
    const groupedTwoCanonicalTracks = canonicalTrackCounts.size === 2 &&
      [...canonicalTrackCounts.values()].every((count) => count >= 2);
    for (const [parsedClipIndex, clip] of parsedTrack.entries()) {
      const clipId = clip.videoOsMeta?.clip_id;
      const source = uniqueLocations[parsedClipIndex];
      if (!clipId || !source) continue;
      const otherLocations = uniqueLocations.filter(
        (location, index): location is CanonicalLocation =>
          index !== parsedClipIndex && location !== undefined,
      );
      const unanimousOtherTrack = otherLocations.length > 0 &&
        otherLocations.every((location) => location.track === otherLocations[0].track) &&
        otherLocations[0].track !== source.track;
      const previous = uniqueLocations[parsedClipIndex - 1];
      const next = uniqueLocations[parsedClipIndex + 1];
      const bracketedByOtherTrack = previous !== undefined && next !== undefined &&
        previous.track === next.track && previous.track !== source.track;
      const ambiguousTwoClipTrack = parsedTrack.length === 2 &&
        otherLocations.length === 1 && otherLocations[0].track !== source.track;
      const mixedThreeCanonicalTracks = canonicalTracksOnParsedTrack.size >= 3;
      if (
        unanimousOtherTrack ||
        bracketedByOtherTrack ||
        ambiguousTwoClipTrack ||
        mixedThreeCanonicalTracks ||
        groupedTwoCanonicalTracks
      ) {
        observableVideoMoves.set(clipId, {
          clip,
          parsedTrack,
          parsedTrackIndex,
          parsedClipIndex,
          source,
        });
      }
    }
  }

  const moveEvidence = (move: ObservableMove): ClipEvidenceBase => ({
    track_kind: "video",
    track_index: move.parsedTrackIndex,
    clip_index: move.parsedClipIndex,
    xml_clip_id: move.clip.xmlClipId,
  });
  const addMoveUnsupported = (
    move: ObservableMove,
    reason: Extract<UnsupportedEditEntry, { surface: "video_cross_track_move" }>["reason"],
  ): void => {
    unsupportedEdits.push({
      kind: "unsupported_edit",
      clip_id: move.clip.videoOsMeta?.clip_id ?? move.clip.xmlClipId,
      surface: "video_cross_track_move",
      reason,
      disposition: "non_applicable",
      detail: `Cross-track edit is not safely applicable for "${move.clip.videoOsMeta?.clip_id ?? move.clip.xmlClipId}"`,
      evidence_location: moveEvidence(move),
    });
  };

  const markerlessVideoExists = parsed.videoTracks.some((track) =>
    track.some((clip) => !clip.videoOsMeta)
  );
  type ValidatedMove = ObservableMove & {
    target: CanonicalLocation;
    afterId: string;
    beforeId: string;
  };
  const validatedMoves: ValidatedMove[] = [];
  const unsafeMoveIds = new Set<string>();
  for (const [clipId, move] of observableVideoMoves) {
    const meta = move.clip.videoOsMeta!;
    const otherClips = move.parsedTrack.filter((_, index) => index !== move.parsedClipIndex);
    const otherLocations = otherClips.map((clip) => {
      const otherId = clip.videoOsMeta?.clip_id;
      const locations = otherId ? canonicalLocations.get(otherId) ?? [] : [];
      return locations.length === 1 && locations[0].kind === "video"
        ? locations[0]
        : undefined;
    });
    const previous = move.parsedTrack[move.parsedClipIndex - 1];
    const next = move.parsedTrack[move.parsedClipIndex + 1];
    const previousLocations = previous?.videoOsMeta
      ? canonicalLocations.get(previous.videoOsMeta.clip_id) ?? []
      : [];
    const nextLocations = next?.videoOsMeta
      ? canonicalLocations.get(next.videoOsMeta.clip_id) ?? []
      : [];
    const target = otherLocations[0];
    const audit = move.clip.mappedMoveCandidateAudit;
    const identity = parsed.fileIdentities.get(move.clip.fileId);
    let decodedPathurl: string | undefined;
    try {
      decodedPathurl = move.clip.pathurl ? decodeURIComponent(move.clip.pathurl) : undefined;
    } catch {
      decodedPathurl = undefined;
    }
    const independentFileAuthority = allParsedClips.some(({ clip }) =>
      clip !== move.clip &&
      clip.fileDefinitionInline &&
      clip.videoOsMeta?.asset_id === meta.asset_id &&
      clip.fileId === move.clip.fileId &&
      clip.pathurl === move.clip.pathurl &&
      (() => {
        const locations = canonicalLocations.get(clip.videoOsMeta!.clip_id) ?? [];
        return locations.length === 1 &&
          requiredTemplateKey(locations[0].track.clips[locations[0].clipIndex]) ===
            requiredTemplateKey(move.source.track.clips[move.source.clipIndex]);
      })()
    );
    const baseRate = reduceRate(reference.sequence.fps_num, reference.sequence.fps_den);
    const expectedSrcIn = Math.round(
      (move.source.track.clips[move.source.clipIndex].src_in_us / 1_000_000) *
      reference.sequence.fps_num / reference.sequence.fps_den,
    );
    const expectedSrcOut = Math.round(
      (move.source.track.clips[move.source.clipIndex].src_out_us / 1_000_000) *
      reference.sequence.fps_num / reference.sequence.fps_den,
    );
    const canonicalClip = move.source.track.clips[move.source.clipIndex];
    const rawSpecificUnsupported = unsupportedEdits.some(
      (entry) => entry.clip_id === clipId && entry.surface !== "video_cross_track_move",
    );
    const duplicateIdentity =
      (canonicalLocations.get(clipId) ?? []).length !== 1 ||
      markerIdCounts.get(clipId) !== 1 ||
      xmlIdCounts.get(move.clip.xmlClipId) !== 1;
    const exactIdentity =
      move.clip.xmlClipId === exportedClipItemId("cv", clipId) &&
      (move.clip.videoOsMarkers ?? []).length === 1 &&
      !move.clip.videoOsMarkerMalformed &&
      meta.asset_id === canonicalClip.asset_id &&
      meta.beat_id === canonicalClip.beat_id &&
      meta.motivation === canonicalClip.motivation;
    const targetAuthority =
      otherClips.length >= 2 &&
      otherClips.every((clip) => clip.videoOsMeta !== null) &&
      otherLocations.every((location) => location !== undefined && location.track === target?.track) &&
      target !== undefined && target.track !== move.source.track;
    const anchorsValid =
      previous !== undefined && next !== undefined &&
      previousLocations.length === 1 && nextLocations.length === 1 &&
      previousLocations[0].track === target?.track &&
      nextLocations[0].track === target?.track &&
      previousLocations[0].clipIndex + 1 === nextLocations[0].clipIndex;
    const exactProjection =
      audit?.exactExporterShape === true &&
      audit.start === canonicalClip.timeline_in_frame &&
      audit.end === canonicalClip.timeline_in_frame + canonicalClip.timeline_duration_frames &&
      audit.duration === expectedSrcOut &&
      audit.inFrame === expectedSrcIn &&
      audit.outFrame === expectedSrcOut &&
      baseRate !== undefined && audit.rateNum === baseRate[0] && audit.rateDen === baseRate[1];
    const fileAuthority =
      !parsed.malformedFileDefinition &&
      !move.clip.fileDefinitionInline &&
      !!move.clip.fileId && identity?.valid === true &&
      !!identity.decodedPathurl && decodedPathurl === identity.decodedPathurl &&
      independentFileAuthority;
    const targetIds = new Set(target?.track.clips.map((clip) => clip.clip_id) ?? []);
    const sourceIds = new Set(move.source.track.clips.map((clip) => clip.clip_id));
    const concurrentDiff = diffs.some((diff) =>
      (targetIds.has(diff.clip_id) || sourceIds.has(diff.clip_id)) &&
      diff.clip_id !== clipId
    ) || diffs.some((diff) => diff.clip_id === clipId);
    const parsedTransitions = parsed.videoTransitions[move.parsedTrackIndex] ?? [];
    const movedTransition = parsedTransitions.some((transition) =>
      transition.fromXmlClipId === move.clip.xmlClipId ||
      transition.toXmlClipId === move.clip.xmlClipId
    );
    const parsedGapTransition = previous && next && parsedTransitions.some((transition) =>
      transition.fromXmlClipId === previous.xmlClipId &&
      transition.toXmlClipId === next.xmlClipId
    );
    const baseMovedTransition = (reference.transitions ?? []).some((transition) =>
      transition.from_clip_id === clipId || transition.to_clip_id === clipId
    );
    const baseGapTransition = previous?.videoOsMeta && next?.videoOsMeta &&
      (reference.transitions ?? []).some((transition) =>
        transition.track_id === target?.track.track_id &&
        transition.from_clip_id === previous.videoOsMeta!.clip_id &&
        transition.to_clip_id === next.videoOsMeta!.clip_id
      );
    const movedInterval = clipTimelineInterval(canonicalClip);
    const overlapsTarget = !movedInterval || target?.track.clips.some((clip) => {
      const interval = clipTimelineInterval(clip);
      return !interval || intervalsOverlap(movedInterval[0], movedInterval[1], interval[0], interval[1]);
    });
    const bracketsTarget = movedInterval && previousLocations.length === 1 && nextLocations.length === 1 &&
      (() => {
        const previousInterval = clipTimelineInterval(previousLocations[0].track.clips[previousLocations[0].clipIndex]);
        const nextInterval = clipTimelineInterval(nextLocations[0].track.clips[nextLocations[0].clipIndex]);
        return !!previousInterval && !!nextInterval &&
          previousInterval[1] <= movedInterval[0] && movedInterval[1] <= nextInterval[0];
      })();

    diffs.splice(0, diffs.length, ...diffs.filter((diff) => diff.clip_id !== clipId));
    if (duplicateIdentity) {
      unsafeMoveIds.add(clipId);
      addMoveUnsupported(move, "duplicate_mapped_identity");
      continue;
    }
    if (rawSpecificUnsupported) {
      unsafeMoveIds.add(clipId);
      continue;
    }
    if (markerlessVideoExists || !exactIdentity || !targetAuthority || !anchorsValid ||
      !exactProjection || !fileAuthority || concurrentDiff || movedTransition ||
      parsedGapTransition || baseMovedTransition || baseGapTransition || overlapsTarget ||
      !bracketsTarget) {
      unsafeMoveIds.add(clipId);
      addMoveUnsupported(move, "unsafe_video_track_move");
      continue;
    }
    validatedMoves.push({
      ...move,
      target: target!,
      afterId: previous!.videoOsMeta!.clip_id,
      beforeId: next!.videoOsMeta!.clip_id,
    });
  }

  type ParsedAudioAuthority = {
    clip: ParsedFcp7Clip;
    trackIndex: number;
    clipIndex: number;
    canonicalTrack: TrackOutput;
  };
  const parsedAudioAuthorities: ParsedAudioAuthority[] = [];
  const canonicalAudioParsedTracks = new Map<TrackOutput, Set<number>>();
  const parsedAudioCanonicalTracks = new Map<number, Set<TrackOutput>>();
  for (const [trackIndex, track] of parsed.audioTracks.entries()) {
    for (const [clipIndex, clip] of track.entries()) {
      const clipId = clip.videoOsMeta?.clip_id;
      const locations = clipId ? canonicalLocations.get(clipId) ?? [] : [];
      if (locations.length !== 1 || locations[0].kind !== "audio") continue;
      const canonicalTrack = locations[0].track;
      parsedAudioAuthorities.push({ clip, trackIndex, clipIndex, canonicalTrack });
      const parsedTracks = canonicalAudioParsedTracks.get(canonicalTrack) ?? new Set<number>();
      parsedTracks.add(trackIndex);
      canonicalAudioParsedTracks.set(canonicalTrack, parsedTracks);
      const canonicalTracks = parsedAudioCanonicalTracks.get(trackIndex) ?? new Set<TrackOutput>();
      canonicalTracks.add(canonicalTrack);
      parsedAudioCanonicalTracks.set(trackIndex, canonicalTracks);
    }
  }
  for (const authority of parsedAudioAuthorities) {
    const mixedParsedTrack =
      (parsedAudioCanonicalTracks.get(authority.trackIndex)?.size ?? 0) > 1;
    const splitCanonicalTrack =
      (canonicalAudioParsedTracks.get(authority.canonicalTrack)?.size ?? 0) > 1;
    if (!mixedParsedTrack && !splitCanonicalTrack) continue;
    const { clip, trackIndex, clipIndex } = authority;
    if (clip.videoOsMeta) {
      unsupportedEdits.push({
        kind: "unsupported_edit",
        clip_id: clip.videoOsMeta.clip_id,
        surface: "video_cross_track_move",
        reason: "audio_track_move_not_supported",
        disposition: "non_applicable",
        detail: `Audio cross-track movement is not supported for "${clip.videoOsMeta.clip_id}"`,
        evidence_location: {
          track_kind: "audio",
          track_index: trackIndex,
          clip_index: clipIndex,
          xml_clip_id: clip.xmlClipId,
        },
      });
      diffs.splice(0, diffs.length, ...diffs.filter((diff) => diff.clip_id !== clip.videoOsMeta!.clip_id));
    }
  }

  if (validatedMoves.length > 1) {
    for (const move of validatedMoves) addMoveUnsupported(move, "multiple_track_moves_not_supported");
  } else if (validatedMoves.length === 1 && unsafeMoveIds.size === 0) {
    const move = validatedMoves[0];
    diffs.push({
      kind: "track_moved",
      clip_id: move.clip.videoOsMeta!.clip_id,
      detail: `Video clip "${move.clip.videoOsMeta!.clip_id}" moved between anchored tracks`,
      source_track_id: move.source.track.track_id,
      target_track_id: move.target.track.track_id,
      after_clip_id: move.afterId,
      before_clip_id: move.beforeId,
    });
  }

  const referenceVideoLocations = new Map<
    string,
    Array<{ track: TrackOutput; trackIndex: number; clipIndex: number }>
  >();
  for (const [trackIndex, track] of reference.tracks.video.entries()) {
    for (const [clipIndex, clip] of track.clips.entries()) {
      const locations = referenceVideoLocations.get(clip.clip_id) ?? [];
      locations.push({ track, trackIndex, clipIndex });
      referenceVideoLocations.set(clip.clip_id, locations);
    }
  }

  const sourceAuthorities = new Map<
    string,
    Array<{ assetId: string; template: ClipOutput }>
  >();
  if (!parsed.malformedFileDefinition) {
    for (const parsedTrack of parsed.videoTracks) {
      for (const parsedClip of parsedTrack) {
        const marker = parsedClip.videoOsMeta;
        if (!marker || !parsedClip.fileId) continue;
        const locations = referenceVideoLocations.get(marker.clip_id) ?? [];
        if (locations.length !== 1) continue;
        const template = locations[0].track.clips[locations[0].clipIndex];
        if (marker.asset_id !== template.asset_id) continue;
        const identity = parsed.fileIdentities.get(parsedClip.fileId);
        if (!identity?.valid || !identity.decodedPathurl || !parsedClip.pathurl) continue;
        let parsedDecodedPathurl: string;
        try {
          parsedDecodedPathurl = decodeURIComponent(parsedClip.pathurl);
        } catch {
          continue;
        }
        if (parsedDecodedPathurl !== identity.decodedPathurl) continue;
        const key = JSON.stringify([parsedClip.fileId, identity.decodedPathurl]);
        const authorities = sourceAuthorities.get(key) ?? [];
        authorities.push({ assetId: marker.asset_id, template });
        sourceAuthorities.set(key, authorities);
      }
    }
  }

  const allXmlIdCounts = new Map<string, number>();
  for (const { clip } of allParsedClips) {
    allXmlIdCounts.set(clip.xmlClipId, (allXmlIdCounts.get(clip.xmlClipId) ?? 0) + 1);
  }
  const baseXmlIds = new Set<string>();
  for (const track of reference.tracks.video) {
    for (const clip of track.clips) {
      baseXmlIds.add(exportedClipItemId("cv", clip.clip_id));
    }
  }
  for (const track of reference.tracks.audio) {
    for (const clip of track.clips) {
      baseXmlIds.add(exportedClipItemId("ca", clip.clip_id));
    }
  }

  type AnchorContext = {
    afterId: string;
    beforeId: string;
    targetTrack: TrackOutput;
  };
  const anchorContexts = new Map<ParsedFcp7Clip, AnchorContext>();
  const anchorPairCounts = new Map<string, number>();
  for (const candidate of markerlessCandidates) {
    if (candidate.trackKind !== "video") continue;
    const parsedTrack = parsed.videoTracks[candidate.trackIndex];
    const before = parsedTrack.slice(0, candidate.clipIndex).reverse().find(
      (clip) => clip.videoOsMeta,
    );
    const after = parsedTrack.slice(candidate.clipIndex + 1).find(
      (clip) => clip.videoOsMeta,
    );
    if (!before?.videoOsMeta || !after?.videoOsMeta) continue;
    const beforeLocations = referenceVideoLocations.get(before.videoOsMeta.clip_id) ?? [];
    const afterLocations = referenceVideoLocations.get(after.videoOsMeta.clip_id) ?? [];
    if (beforeLocations.length !== 1 || afterLocations.length !== 1) continue;
    const beforeLocation = beforeLocations[0];
    const afterLocation = afterLocations[0];
    if (
      beforeLocation.track !== afterLocation.track ||
      beforeLocation.clipIndex + 1 !== afterLocation.clipIndex
    ) continue;
    const markerLocations = parsedTrack
      .filter((clip) => clip.videoOsMeta)
      .map((clip) => referenceVideoLocations.get(clip.videoOsMeta!.clip_id) ?? []);
    if (
      markerLocations.some(
        (locations) => locations.length !== 1 || locations[0].track !== beforeLocation.track,
      )
    ) continue;
    const context: AnchorContext = {
      afterId: before.videoOsMeta.clip_id,
      beforeId: after.videoOsMeta.clip_id,
      targetTrack: beforeLocation.track,
    };
    anchorContexts.set(candidate.clip, context);
    const pairKey = JSON.stringify([
      context.targetTrack.track_id,
      context.afterId,
      context.beforeId,
    ]);
    anchorPairCounts.set(pairKey, (anchorPairCounts.get(pairKey) ?? 0) + 1);
  }

  const proposedIds = new Set<string>();
  const proposedIntervals = new Map<string, Array<[number, number]>>();
  for (const candidate of markerlessCandidates) {
    const parsedClip = candidate.clip;
    const unmapped = (): void => {
      diffs.push({
        kind: "added_unmapped",
        clip_id: parsedClip.xmlClipId,
        detail: `New clip "${parsedClip.name}" added in Premiere (no safe known-source mapping)`,
      });
    };
    if (candidate.trackKind !== "video") {
      unmapped();
      continue;
    }
    if (observableVideoMoves.size > 0) {
      unmapped();
      continue;
    }
    if (diffs.some((diff) => diff.kind === "deleted")) {
      unmapped();
      continue;
    }
    const audit = parsedClip.markerlessCandidateAudit;
    const context = anchorContexts.get(parsedClip);
    const identity = parsed.fileIdentities.get(parsedClip.fileId);
    if (
      !audit?.eligibleShape ||
      audit.start === undefined ||
      audit.end === undefined ||
      audit.inFrame === undefined ||
      audit.outFrame === undefined ||
      audit.rateNum === undefined ||
      audit.rateDen === undefined ||
      !context ||
      parsed.malformedFileDefinition ||
      !identity?.valid ||
      !identity.decodedPathurl ||
      !parsedClip.fileId ||
      !parsedClip.xmlClipId ||
      allXmlIdCounts.get(parsedClip.xmlClipId) !== 1 ||
      baseXmlIds.has(parsedClip.xmlClipId)
    ) {
      unmapped();
      continue;
    }

    const pairKey = JSON.stringify([
      context.targetTrack.track_id,
      context.afterId,
      context.beforeId,
    ]);
    if ((anchorPairCounts.get(pairKey) ?? 0) !== 1) {
      unmapped();
      continue;
    }

    const baseRate = reduceRate(
      reference.sequence.fps_num,
      reference.sequence.fps_den,
    );
    if (
      !baseRate ||
      audit.rateNum !== baseRate[0] ||
      audit.rateDen !== baseRate[1]
    ) {
      unmapped();
      continue;
    }

    const identityKey = JSON.stringify([
      parsedClip.fileId,
      identity.decodedPathurl,
    ]);
    const authorities = sourceAuthorities.get(identityKey) ?? [];
    const assetIds = new Set(authorities.map((authority) => authority.assetId));
    const templateKeys = new Set(
      authorities.map((authority) => requiredTemplateKey(authority.template)),
    );
    if (assetIds.size !== 1 || templateKeys.size !== 1 || authorities.length === 0) {
      unmapped();
      continue;
    }
    const template = authorities[0].template;

    const srcInUs = exactFramesToUs(audit.inFrame, audit.rateNum, audit.rateDen);
    const srcOutUs = exactFramesToUs(audit.outFrame, audit.rateNum, audit.rateDen);
    if (
      srcInUs === undefined ||
      srcOutUs === undefined ||
      srcOutUs <= srcInUs ||
      srcInUs < template.src_in_us ||
      srcOutUs > template.src_out_us
    ) {
      unmapped();
      continue;
    }

    const targetClipIds = new Set(context.targetTrack.clips.map((clip) => clip.clip_id));
    const concurrentTargetMutation = diffs.some(
      (diff) =>
        (diff.kind === "trim_changed" ||
          diff.kind === "reordered" ||
          diff.kind === "deleted") &&
        targetClipIds.has(diff.clip_id),
    );
    const candidateHasTransition =
      (parsed.videoTransitions[candidate.trackIndex] ?? []).some(
        (transition) =>
          transition.fromXmlClipId === parsedClip.xmlClipId ||
          transition.toXmlClipId === parsedClip.xmlClipId,
      );
    const anchorsHaveBaseTransition = (reference.transitions ?? []).some(
      (transition) =>
        transition.track_id === context.targetTrack.track_id &&
        transition.from_clip_id === context.afterId &&
        transition.to_clip_id === context.beforeId,
    );
    if (concurrentTargetMutation || candidateHasTransition || anchorsHaveBaseTransition) {
      unmapped();
      continue;
    }

    const overlapsExisting = context.targetTrack.clips.some((clip) => {
      const interval = clipTimelineInterval(clip);
      return !interval || intervalsOverlap(audit.start!, audit.end!, interval[0], interval[1]);
    });
    const acceptedIntervals = proposedIntervals.get(context.targetTrack.track_id) ?? [];
    const overlapsProposal = acceptedIntervals.some((interval) =>
      intervalsOverlap(audit.start!, audit.end!, interval[0], interval[1])
    );
    if (overlapsExisting || overlapsProposal) {
      unmapped();
      continue;
    }

    const seed = JSON.stringify([
      "premiere-known-source-add/v1",
      reference.project_id,
      context.targetTrack.track_id,
      context.afterId,
      context.beforeId,
      parsedClip.xmlClipId,
      parsedClip.fileId,
      identity.decodedPathurl,
      audit.rateNum,
      audit.rateDen,
      audit.start,
      audit.end,
      audit.inFrame,
      audit.outFrame,
    ]);
    const clipId = `premiere_add_${createHash("sha256").update(seed).digest("hex")}`;
    if (refClipMap.has(clipId) || proposedIds.has(clipId)) {
      unmapped();
      continue;
    }

    const addedClip: ClipOutput = {
      clip_id: clipId,
      segment_id: template.segment_id,
      asset_id: template.asset_id,
      src_in_us: srcInUs,
      src_out_us: srcOutUs,
      timeline_in_frame: audit.start,
      timeline_duration_frames: audit.end - audit.start,
      role: template.role,
      motivation: template.motivation,
      beat_id: template.beat_id,
      fallback_segment_ids: [...template.fallback_segment_ids],
      confidence: template.confidence,
      quality_flags: [...template.quality_flags],
    };
    diffs.push({
      kind: "added_mapped",
      clip_id: clipId,
      detail: `Known-source video clip "${parsedClip.xmlClipId}" added in Premiere`,
      target_track_id: context.targetTrack.track_id,
      after_clip_id: context.afterId,
      before_clip_id: context.beforeId,
      source_identity: {
        file_id: parsedClip.fileId,
        decoded_pathurl: identity.decodedPathurl,
      },
      added_clip: addedClip,
    });
    proposedIds.add(clipId);
    acceptedIntervals.push([audit.start, audit.end]);
    proposedIntervals.set(context.targetTrack.track_id, acceptedIntervals);
    unmappedCount--;
    mappedCount++;
  }

  return {
    sequenceName: parsed.name,
    totalClipsInXml: allParsedClips.length,
    mappedClips: mappedCount,
    unmappedClips: unmappedCount,
    diffs,
    unsupportedEdits,
    textOverlayEdits,
    transitionEdits,
    transitionSourceHandleAuthority: "missing",
  };
}

// ── Apply diffs to TimelineIR ────────────────────────────────────────

/**
 * Apply detected diffs to a TimelineIR, returning a patched copy.
 * - trim_changed / reordered: update the clip's in/out/timeline position
 * - audio_policy_changed: replace the matching audio clip's policy snapshot
 * - deleted: remove the clip from its track
 * - added_mapped: insert a fully revalidated known-source video clip
 * - added_unmapped: ignored (warning only)
 */
export function applyDiffs(
  timeline: TimelineIR,
  diffs: ClipDiff[],
): TimelineIR {
  const trimDiffs = new Map<string, TimelinePositionDiff>();
  const audioPolicyDiffs = new Map<string, AudioPolicyDiff>();
  const deletedIds = new Set<string>();
  const addedDiffs: AddedMappedDiff[] = [];
  const moveDiffs: TrackMovedDiff[] = [];
  const seenDiffKinds = new Set<string>();

  for (const diff of diffs) {
    if (diff.kind !== "added_unmapped") {
      const diffKey = `${diff.kind}\0${diff.clip_id}`;
      if (seenDiffKinds.has(diffKey)) {
        throw new Error(`Cannot apply duplicate ${diff.kind} diff for "${diff.clip_id}"`);
      }
      seenDiffKinds.add(diffKey);
    }
    if (diff.kind === "trim_changed" || diff.kind === "reordered") {
      trimDiffs.set(diff.clip_id, diff);
    } else if (diff.kind === "audio_policy_changed") {
      audioPolicyDiffs.set(diff.clip_id, diff);
    } else if (diff.kind === "deleted") {
      deletedIds.add(diff.clip_id);
    } else if (diff.kind === "added_mapped") {
      addedDiffs.push(diff);
    } else if (diff.kind === "track_moved") {
      moveDiffs.push(diff);
    }
  }
  if (moveDiffs.length > 1) {
    throw new Error("Cannot apply more than one video track move");
  }

  type ExistingLocation = {
    kind: "video" | "audio";
    trackIndex: number;
    clipIndex: number;
    track: TrackOutput;
    clip: ClipOutput;
  };
  const existingLocations = new Map<string, ExistingLocation[]>();
  for (const [kind, tracks] of [
    ["video", timeline.tracks.video],
    ["audio", timeline.tracks.audio],
  ] as const) {
    for (const [trackIndex, track] of tracks.entries()) {
      for (const [clipIndex, clip] of track.clips.entries()) {
        const locations = existingLocations.get(clip.clip_id) ?? [];
        locations.push({ kind, trackIndex, clipIndex, track, clip });
        existingLocations.set(clip.clip_id, locations);
      }
    }
  }
  for (const diff of diffs) {
    if (
      diff.kind === "added_unmapped" ||
      diff.kind === "added_mapped" ||
      diff.kind === "deleted"
    ) continue;
    const locations = existingLocations.get(diff.clip_id) ?? [];
    if (locations.length !== 1) {
      throw new Error(`Cannot apply ${diff.kind} for "${diff.clip_id}": clip is not unique`);
    }
    if (diff.kind === "audio_policy_changed" && locations[0].kind !== "audio") {
      throw new Error(`Cannot apply audio policy for "${diff.clip_id}": clip is not audio`);
    }
    if (diff.kind === "trim_changed" || diff.kind === "reordered") {
      const updated = diff.updated;
      if (!Number.isSafeInteger(updated.src_in_us) ||
        !Number.isSafeInteger(updated.src_out_us) ||
        !Number.isSafeInteger(updated.timeline_in_frame) ||
        !Number.isSafeInteger(updated.timeline_duration_frames) ||
        updated.src_in_us < 0 || updated.src_out_us <= updated.src_in_us ||
        updated.timeline_in_frame < 0 || updated.timeline_duration_frames <= 0) {
        throw new Error(`Cannot apply ${diff.kind} for "${diff.clip_id}": invalid timing`);
      }
    }
  }

  const existingIds = new Set(
    [...timeline.tracks.video, ...timeline.tracks.audio]
      .flatMap((track) => track.clips)
      .map((clip) => clip.clip_id),
  );
  const plannedIds = new Set<string>();
  const plannedAnchorPairs = new Set<string>();
  const plannedIntervals = new Map<string, Array<[number, number]>>();
  const additionPlans: Array<{
    diff: AddedMappedDiff;
    targetTrackIndex: number;
    beforeIndex: number;
  }> = [];
  for (const diff of addedDiffs) {
    const matchingTracks = timeline.tracks.video
      .map((track, trackIndex) => ({ track, trackIndex }))
      .filter(({ track }) => track.track_id === diff.target_track_id);
    if (matchingTracks.length !== 1) {
      throw new Error(`Cannot apply mapped addition "${diff.clip_id}": target track is not unique`);
    }
    const { track, trackIndex: targetTrackIndex } = matchingTracks[0];
    const afterIndex = track.clips.findIndex((clip) => clip.clip_id === diff.after_clip_id);
    const beforeIndex = track.clips.findIndex((clip) => clip.clip_id === diff.before_clip_id);
    if (afterIndex < 0 || beforeIndex !== afterIndex + 1) {
      throw new Error(`Cannot apply mapped addition "${diff.clip_id}": anchors are not consecutive`);
    }
    const targetIds = new Set(track.clips.map((clip) => clip.clip_id));
    if (
      diffs.some(
        (other) =>
          other !== diff &&
          (other.kind === "trim_changed" ||
            other.kind === "reordered" ||
            other.kind === "deleted" ||
            other.kind === "track_moved") &&
          (targetIds.has(other.clip_id) ||
            (other.kind === "track_moved" &&
              (other.source_track_id === track.track_id || other.target_track_id === track.track_id))),
      )
    ) {
      throw new Error(`Cannot apply mapped addition "${diff.clip_id}": target track also mutates`);
    }
    const anchorPair = JSON.stringify([
      diff.target_track_id,
      diff.after_clip_id,
      diff.before_clip_id,
    ]);
    if (plannedAnchorPairs.has(anchorPair)) {
      throw new Error(`Cannot apply mapped addition "${diff.clip_id}": anchor gap is shared`);
    }
    plannedAnchorPairs.add(anchorPair);

    const clip = diff.added_clip;
    const timelineEnd = clip.timeline_in_frame + clip.timeline_duration_frames;
    if (
      clip.clip_id !== diff.clip_id ||
      !diff.source_identity.file_id ||
      !diff.source_identity.decoded_pathurl ||
      !Number.isSafeInteger(clip.timeline_in_frame) ||
      !Number.isSafeInteger(clip.timeline_duration_frames) ||
      !Number.isSafeInteger(timelineEnd) ||
      !Number.isSafeInteger(clip.src_in_us) ||
      !Number.isSafeInteger(clip.src_out_us) ||
      clip.timeline_in_frame < 0 ||
      clip.timeline_duration_frames <= 0 ||
      clip.src_in_us < 0 ||
      clip.src_out_us <= clip.src_in_us
    ) {
      throw new Error(`Cannot apply mapped addition "${diff.clip_id}": invalid numeric interval`);
    }
    if (existingIds.has(diff.clip_id) || plannedIds.has(diff.clip_id)) {
      throw new Error(`Cannot apply mapped addition "${diff.clip_id}": clip ID collision`);
    }
    const overlapsExisting = track.clips.some((existingClip) => {
      const interval = clipTimelineInterval(existingClip);
      return !interval || intervalsOverlap(
        clip.timeline_in_frame,
        timelineEnd,
        interval[0],
        interval[1],
      );
    });
    const intervals = plannedIntervals.get(track.track_id) ?? [];
    const overlapsPlanned = intervals.some((interval) => intervalsOverlap(
      clip.timeline_in_frame,
      timelineEnd,
      interval[0],
      interval[1],
    ));
    if (overlapsExisting || overlapsPlanned) {
      throw new Error(`Cannot apply mapped addition "${diff.clip_id}": timeline overlap`);
    }
    plannedIds.add(diff.clip_id);
    intervals.push([clip.timeline_in_frame, timelineEnd]);
    plannedIntervals.set(track.track_id, intervals);
    additionPlans.push({ diff, targetTrackIndex, beforeIndex });
  }

  let movePlan: {
    sourceTrackIndex: number;
    targetTrackIndex: number;
    sourceClipIndex: number;
    beforeIndex: number;
  } | undefined;
  if (moveDiffs.length === 1) {
    const diff = moveDiffs[0];
    const sourceTracks = timeline.tracks.video
      .map((track, trackIndex) => ({ track, trackIndex }))
      .filter(({ track }) => track.track_id === diff.source_track_id);
    const targetTracks = timeline.tracks.video
      .map((track, trackIndex) => ({ track, trackIndex }))
      .filter(({ track }) => track.track_id === diff.target_track_id);
    if (sourceTracks.length !== 1 || targetTracks.length !== 1 ||
      diff.source_track_id === diff.target_track_id) {
      throw new Error(`Cannot apply track move "${diff.clip_id}": source or target is not unique`);
    }
    const source = sourceTracks[0];
    const target = targetTracks[0];
    const sourceIndexes = source.track.clips
      .map((clip, index) => clip.clip_id === diff.clip_id ? index : -1)
      .filter((index) => index >= 0);
    if (sourceIndexes.length !== 1 || target.track.clips.some((clip) => clip.clip_id === diff.clip_id)) {
      throw new Error(`Cannot apply track move "${diff.clip_id}": moved clip location is invalid`);
    }
    const afterIndexes = target.track.clips
      .map((clip, index) => clip.clip_id === diff.after_clip_id ? index : -1)
      .filter((index) => index >= 0);
    const beforeIndexes = target.track.clips
      .map((clip, index) => clip.clip_id === diff.before_clip_id ? index : -1)
      .filter((index) => index >= 0);
    if (afterIndexes.length !== 1 || beforeIndexes.length !== 1 ||
      beforeIndexes[0] !== afterIndexes[0] + 1) {
      throw new Error(`Cannot apply track move "${diff.clip_id}": anchors are not unique consecutive neighbors`);
    }
    const sourceIds = new Set(source.track.clips.map((clip) => clip.clip_id));
    const targetIds = new Set(target.track.clips.map((clip) => clip.clip_id));
    if (diff.clip_id === diff.after_clip_id || diff.clip_id === diff.before_clip_id ||
      diffs.some((other) => other !== diff && (
        sourceIds.has(other.clip_id) || targetIds.has(other.clip_id) ||
        (other.kind === "added_mapped" &&
          (other.target_track_id === source.track.track_id || other.target_track_id === target.track.track_id)) ||
        (other.kind === "track_moved" &&
          (other.source_track_id === source.track.track_id || other.target_track_id === target.track.track_id))
      ))) {
      throw new Error(`Cannot apply track move "${diff.clip_id}": participating track also mutates`);
    }
    const movedClip = source.track.clips[sourceIndexes[0]];
    const movedInterval = clipTimelineInterval(movedClip);
    const afterInterval = clipTimelineInterval(target.track.clips[afterIndexes[0]]);
    const beforeInterval = clipTimelineInterval(target.track.clips[beforeIndexes[0]]);
    const overlapsTarget = !movedInterval || target.track.clips.some((clip) => {
      const interval = clipTimelineInterval(clip);
      return !interval || intervalsOverlap(movedInterval[0], movedInterval[1], interval[0], interval[1]);
    });
    if (!movedInterval || !afterInterval || !beforeInterval || overlapsTarget ||
      afterInterval[1] > movedInterval[0] || movedInterval[1] > beforeInterval[0]) {
      throw new Error(`Cannot apply track move "${diff.clip_id}": timing or overlap is invalid`);
    }
    if ((timeline.transitions ?? []).some((transition) =>
      transition.from_clip_id === diff.clip_id || transition.to_clip_id === diff.clip_id ||
      (transition.track_id === target.track.track_id &&
        transition.from_clip_id === diff.after_clip_id &&
        transition.to_clip_id === diff.before_clip_id)
    )) {
      throw new Error(`Cannot apply track move "${diff.clip_id}": transition conflict`);
    }
    movePlan = {
      sourceTrackIndex: source.trackIndex,
      targetTrackIndex: target.trackIndex,
      sourceClipIndex: sourceIndexes[0],
      beforeIndex: beforeIndexes[0],
    };
  }

  // All validation is complete. Clone the input exactly once before mutation.
  const patched: TimelineIR = JSON.parse(JSON.stringify(timeline));

  if (patched.transitions !== undefined) {
    patched.transitions = patched.transitions.filter(
      (transition) =>
        !deletedIds.has(transition.from_clip_id) &&
        !deletedIds.has(transition.to_clip_id),
    );
  }

  // Apply to each track
  for (const tracks of [patched.tracks.video, patched.tracks.audio]) {
    for (const track of tracks) {
      // Remove deleted clips
      track.clips = track.clips.filter((c) => !deletedIds.has(c.clip_id));

      // Apply trim/reorder changes
      let timelinePositionChanged = false;
      for (const clip of track.clips) {
        const diff = trimDiffs.get(clip.clip_id);
        if (diff) {
          clip.src_in_us = diff.updated.src_in_us;
          clip.src_out_us = diff.updated.src_out_us;
          clip.timeline_in_frame = diff.updated.timeline_in_frame;
          clip.timeline_duration_frames = diff.updated.timeline_duration_frames;
          timelinePositionChanged = true;
        }
      }

      // Sort clips by timeline position after reorder
      if (timelinePositionChanged) {
        track.clips.sort((a, b) => a.timeline_in_frame - b.timeline_in_frame);
      }
    }
  }

  for (const track of patched.tracks.audio) {
    for (const clip of track.clips) {
      const diff = audioPolicyDiffs.get(clip.clip_id);
      if (diff) clip.audio_policy = { ...diff.updated_audio_policy };
    }
  }

  const sortedAdditionPlans = [...additionPlans].sort((left, right) =>
    left.targetTrackIndex === right.targetTrackIndex
      ? right.beforeIndex - left.beforeIndex
      : left.targetTrackIndex - right.targetTrackIndex
  );
  for (const plan of sortedAdditionPlans) {
    patched.tracks.video[plan.targetTrackIndex].clips.splice(
      plan.beforeIndex,
      0,
      JSON.parse(JSON.stringify(plan.diff.added_clip)) as ClipOutput,
    );
  }

  if (movePlan) {
    const sourceTrack = patched.tracks.video[movePlan.sourceTrackIndex];
    const targetTrack = patched.tracks.video[movePlan.targetTrackIndex];
    const movedClip = sourceTrack.clips.splice(movePlan.sourceClipIndex, 1)[0];
    targetTrack.clips.splice(movePlan.beforeIndex, 0, movedClip);
  }

  return patched;
}
