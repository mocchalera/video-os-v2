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

import type {
  TimelineIR,
  TrackOutput,
  ClipOutput,
  MarkerOutput,
  AudioPolicy,
  TimelineTransitionOutput,
} from "../compiler/types.js";
import { linearGainToDb } from "./fcp7-xml-export.js";

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
  /** file/@id reference */
  fileId: string;
  /** pathurl from file definition, if available */
  pathurl: string;
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
}

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
}

// ── Diff Types ───────────────────────────────────────────────────────

export type DiffKind =
  | "trim_changed"
  | "reordered"
  | "deleted"
  | "added_unmapped";

export interface ClipDiff {
  kind: DiffKind;
  clip_id: string;
  detail: string;
  /** Original values (for trim_changed) */
  original?: {
    src_in_us: number;
    src_out_us: number;
    timeline_in_frame: number;
    timeline_duration_frames: number;
  };
  /** New values from Premiere (for trim_changed) */
  updated?: {
    src_in_us: number;
    src_out_us: number;
    timeline_in_frame: number;
    timeline_duration_frames: number;
  };
}

export interface ImportDiffReport {
  sequenceName: string;
  totalClipsInXml: number;
  mappedClips: number;
  unmappedClips: number;
  diffs: ClipDiff[];
}

// ── XML Parsing ──────────────────────────────────────────────────────

/** Minimal XML element node for FCP7 parsing */
interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
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
  pos = skipWhitespace(s, pos);
  while (pos < s.length && s[pos] !== ">" && s[pos] !== "/") {
    const attrStart = pos;
    while (pos < s.length && s[pos] !== "=" && !/[\s/>]/.test(s[pos])) pos++;
    const attrName = s.slice(attrStart, pos);

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
    return [{ tag, attrs, children: [], text: "" }, pos];
  }

  pos++; // skip '>'

  // Parse children and text content
  const children: XmlNode[] = [];
  let text = "";

  while (pos < s.length) {
    pos = skipWhitespace(s, pos);

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
      text += s.slice(textStart, pos).trim();
    }
  }

  return [{ tag, attrs, children, text: unescapeXml(text) }, pos];
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

function childInt(node: XmlNode, tag: string, fallback = 0): number {
  const t = childText(node, tag);
  const n = parseInt(t, 10);
  return isNaN(n) ? fallback : n;
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
      const obj = JSON.parse(payload);
      const clip_id = obj.clip_id;
      const asset_id = obj.asset_id;
      const beat_id = obj.beat_id;
      if (!clip_id || !asset_id || !beat_id) return null;
      return {
        clip_id,
        asset_id,
        beat_id,
        motivation: obj.motivation ?? "",
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
  if (fileNode) {
    fileId = fileNode.attrs.id ?? "";
    if (fileNode.children.length > 0) {
      pathurl = childText(fileNode, "pathurl");
      if (pathurl) fileMap.set(fileId, pathurl);
    } else {
      pathurl = fileMap.get(fileId) ?? "";
    }
  }

  let videoOsMeta: VideoOsMarkerMeta | null = null;
  let editorialMarker: ParsedEditorialMarker | undefined;
  for (const marker of findChildren(clipitem, "marker")) {
    const comment = childText(marker, "comment");
    const meta = parseVideoOsMarker(comment);
    if (meta) {
      videoOsMeta = meta;
      continue;
    }

    const editorial = parseEditorialMarker(marker);
    if (editorial && !editorialMarker) {
      editorialMarker = editorial;
    }
  }

  // Audio level from filter
  let audioLevelDb: number | undefined;
  let audioGainLinear: number | undefined;
  let fadeInFrames: number | undefined;
  let fadeOutFrames: number | undefined;

  for (const filterNode of findChildren(clipitem, "filter")) {
    const effect = findChild(filterNode, "effect");
    if (effect && childText(effect, "effectid") === "audiolevels") {
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
    fileId,
    pathurl,
    audioLevelDb,
    audioGainLinear,
    fadeInFrames,
    fadeOutFrames,
    editorialMarker,
  };
}

function parseTransitionItem(transitionitem: XmlNode): ParsedFcp7Transition {
  const effect = findChild(transitionitem, "effect");
  return {
    startFrame: childInt(transitionitem, "start"),
    endFrame: childInt(transitionitem, "end"),
    alignment: childText(transitionitem, "alignment"),
    effectName: effect ? childText(effect, "name") : "",
    effectId: effect ? childText(effect, "effectid") : "",
    mediaType: effect ? childText(effect, "mediatype") : "",
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

  function collectFiles(trackNode: XmlNode): void {
    for (const clipitem of findChildren(trackNode, "clipitem")) {
      const fileNode = findChild(clipitem, "file");
      if (fileNode && fileNode.attrs.id && fileNode.children.length > 0) {
        const pathurl = childText(fileNode, "pathurl");
        if (pathurl) {
          fileMap.set(fileNode.attrs.id, pathurl);
        }
      }
    }
  }

  // Parse video tracks
  const videoTracks: ParsedFcp7Clip[][] = [];
  const videoTransitions: ParsedFcp7Transition[][] = [];
  if (videoNode) {
    for (const trackNode of findChildren(videoNode, "track")) {
      collectFiles(trackNode);
      const parsedTrack = parseTrackItems(trackNode, fileMap);
      videoTracks.push(parsedTrack.clips);
      videoTransitions.push(parsedTrack.transitions);
    }
  }

  // Parse audio tracks
  const audioTracks: ParsedFcp7Clip[][] = [];
  const audioTransitions: ParsedFcp7Transition[][] = [];
  if (audioNode) {
    for (const trackNode of findChildren(audioNode, "track")) {
      collectFiles(trackNode);
      const parsedTrack = parseTrackItems(trackNode, fileMap);
      audioTracks.push(parsedTrack.clips);
      audioTransitions.push(parsedTrack.transitions);
    }
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
  };
}

// ── Frame / Microsecond conversion ───────────────────────────────────

function framesToUs(frames: number, fps: number): number {
  return Math.round((frames / fps) * 1_000_000);
}

function inferTransitionType(
  transition: ParsedFcp7Transition,
): TimelineTransitionOutput["transition_type"] | undefined {
  const normalizedName = transition.effectName.trim().toLowerCase();
  const normalizedId = transition.effectId.trim().toLowerCase();

  if (
    normalizedName === "cross dissolve" ||
    normalizedId === "crossdissolve"
  ) {
    return "crossfade";
  }

  if (normalizedName === "dip to color" || normalizedId === "diptocolor") {
    return "match_cut";
  }

  return undefined;
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
        const inferredType = inferTransitionType(transition);
        const transitionFrames = Math.max(
          1,
          transition.endFrame - transition.startFrame,
        );

        const restored: TimelineTransitionOutput = {
          transition_id:
            originalTransition?.transition_id ?? `imported_tr_${i}_${index}`,
          from_clip_id: fromClipId,
          to_clip_id: toClipId,
          track_id: trackId,
          transition_type:
            originalTransition?.transition_type ??
            inferredType ??
            "crossfade",
          transition_frames: transitionFrames,
        };

        if (originalTransition?.transition_params) {
          restored.transition_params = {
            ...originalTransition.transition_params,
          };
        } else if (inferredType === "crossfade") {
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
 * Maps linear gain back to dB and assigns to the correct field based on clip role.
 */
function buildAudioPolicy(
  clip: ParsedFcp7Clip,
  role: string,
  origPolicy?: AudioPolicy,
): AudioPolicy | undefined {
  const isBgm = role === "bgm" || role === "music";
  const hasNewGain = clip.audioGainLinear !== undefined;
  const hasLegacyGain = clip.audioLevelDb !== undefined;
  const hasFadeIn = clip.fadeInFrames !== undefined && clip.fadeInFrames > 0;
  const hasFadeOut = clip.fadeOutFrames !== undefined && clip.fadeOutFrames > 0;

  if (!hasNewGain && !hasLegacyGain && !hasFadeIn && !hasFadeOut) {
    return origPolicy;
  }

  const policy: AudioPolicy = origPolicy ? { ...origPolicy } : {};

  if (hasNewGain) {
    const gainDb = Math.round(linearGainToDb(clip.audioGainLinear!) * 100) / 100;
    if (isBgm) {
      policy.bgm_gain = gainDb;
    } else {
      policy.nat_sound_gain = gainDb;
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

  return policy;
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

// ── Diff Detection ───────────────────────────────────────────────────

/**
 * Compare an imported FCP7 sequence against a reference TimelineIR
 * and return a diff report.
 */
export function detectDiffs(
  parsed: ParsedFcp7Sequence,
  reference: TimelineIR,
): ImportDiffReport {
  const fps = parsed.timebase;
  const diffs: ClipDiff[] = [];

  // Collect all parsed clips with their video_os metadata
  const allParsedClips: ParsedFcp7Clip[] = [
    ...parsed.videoTracks.flat(),
    ...parsed.audioTracks.flat(),
  ];

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

  for (const parsedClip of allParsedClips) {
    if (!parsedClip.videoOsMeta) {
      unmappedCount++;
      diffs.push({
        kind: "added_unmapped",
        clip_id: parsedClip.xmlClipId,
        detail: `New clip "${parsedClip.name}" added in Premiere (no video_os marker)`,
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

  return {
    sequenceName: parsed.name,
    totalClipsInXml: allParsedClips.length,
    mappedClips: mappedCount,
    unmappedClips: unmappedCount,
    diffs,
  };
}

// ── Apply diffs to TimelineIR ────────────────────────────────────────

/**
 * Apply detected diffs to a TimelineIR, returning a patched copy.
 * - trim_changed / reordered: update the clip's in/out/timeline position
 * - deleted: remove the clip from its track
 * - added_unmapped: ignored (warning only)
 */
export function applyDiffs(
  timeline: TimelineIR,
  diffs: ClipDiff[],
): TimelineIR {
  // Deep clone
  const patched: TimelineIR = JSON.parse(JSON.stringify(timeline));

  // Index diffs by clip_id
  const trimDiffs = new Map<string, ClipDiff>();
  const deletedIds = new Set<string>();

  for (const diff of diffs) {
    if (
      (diff.kind === "trim_changed" || diff.kind === "reordered") &&
      diff.updated
    ) {
      trimDiffs.set(diff.clip_id, diff);
    } else if (diff.kind === "deleted") {
      deletedIds.add(diff.clip_id);
    }
  }

  // Apply to each track
  for (const tracks of [patched.tracks.video, patched.tracks.audio]) {
    for (const track of tracks) {
      // Remove deleted clips
      track.clips = track.clips.filter((c) => !deletedIds.has(c.clip_id));

      // Apply trim/reorder changes
      for (const clip of track.clips) {
        const diff = trimDiffs.get(clip.clip_id);
        if (diff?.updated) {
          clip.src_in_us = diff.updated.src_in_us;
          clip.src_out_us = diff.updated.src_out_us;
          clip.timeline_in_frame = diff.updated.timeline_in_frame;
          clip.timeline_duration_frames = diff.updated.timeline_duration_frames;
        }
      }

      // Sort clips by timeline position after reorder
      track.clips.sort((a, b) => a.timeline_in_frame - b.timeline_in_frame);
    }
  }

  return patched;
}
