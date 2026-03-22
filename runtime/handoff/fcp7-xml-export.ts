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
  MarkerOutput,
} from "../compiler/types.js";

// ── Public API ────────────────────────────────────────────────────

export interface Fcp7ExportOptions {
  /** Map asset_id → absolute file path on disk */
  sourceMap: Map<string, string>;
  /** Map asset_id → total asset duration in microseconds (for accurate <file> duration) */
  assetDurationMap?: Map<string, number>;
  /** Project ID for deriving exchange clip IDs */
  projectId?: string;
  /** Timeline version for deriving exchange clip IDs */
  timelineVersion?: string;
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
  }

  build(): string {
    const totalFrames = this.computeTotalFrames();
    const lines: string[] = [];

    lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
    lines.push(`<!DOCTYPE xmeml>`);
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
    if (this.opts.textOverlays && this.opts.textOverlays.length > 0) {
      this.appendTextOverlayTrack(lines, this.opts.textOverlays, 8);
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

  /** Derive an ASCII-safe id from an asset_id or clip_id */
  private toAsciiId(prefix: string, id: string): string {
    // Replace non-ASCII chars with hex encoding
    const safe = id.replace(/[^a-zA-Z0-9_-]/g, (ch) => {
      const code = ch.charCodeAt(0);
      return code > 127 ? `x${code.toString(16)}` : "_";
    });
    return `${prefix}-${safe}`;
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
  ): void {
    const d = this.indent(depth);
    const filePath = this.opts.sourceMap.get(assetId);
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
    if (ext !== "jpg" && ext !== "jpeg" && ext !== "png" && ext !== "tiff") {
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
    const d = this.indent(depth);

    // Derive exchange_clip_id for roundtrip identification
    const exchangeClipId =
      this.opts.projectId && this.opts.timelineVersion
        ? `${this.opts.projectId}:${this.opts.timelineVersion}:${clip.clip_id}`
        : clip.clip_id;

    // Embed video_os metadata as JSON-encoded marker comment
    const payload = JSON.stringify({
      exchange_clip_id: exchangeClipId,
      clip_id: clip.clip_id,
      asset_id: clip.asset_id,
      beat_id: clip.beat_id,
      motivation: clip.motivation || "",
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

  private appendVideoTrack(
    lines: string[],
    track: TrackOutput,
    depth: number,
  ): void {
    const d = this.indent(depth);
    lines.push(`${d}<track>`);
    lines.push(`${d}  <enabled>TRUE</enabled>`);
    lines.push(`${d}  <locked>FALSE</locked>`);

    for (const clip of track.clips) {
      const clipId = this.toAsciiId("cv", clip.clip_id);
      const fileId = this.getFileId(clip.asset_id);
      const alreadyDefined = this.isFileDefined(clip.asset_id);

      const srcInFrames = this.usToFrames(clip.src_in_us);
      const srcOutFrames = this.usToFrames(clip.src_out_us);

      lines.push(`${d}  <clipitem id="${clipId}">`);
      lines.push(
        `${d}    <name>${this.escXml(clip.motivation || clip.clip_id)}</name>`,
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
        // First use: emit full file definition, then mark as defined
        this.appendFileDefinition(
          lines,
          depth + 4,
          clip.asset_id,
          fileId,
          clip,
          false,
        );
        this.markFileDefined(clip.asset_id);
      } else {
        // Subsequent use: back-reference only
        lines.push(`${d}    <file id="${fileId}"/>`);
      }

      this.appendClipMarkers(lines, depth + 4, clip);
      lines.push(`${d}  </clipitem>`);
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
      const clipId = this.toAsciiId("ca", clip.clip_id);
      const fileId = this.getFileId(clip.asset_id);
      const alreadyDefined = this.isFileDefined(clip.asset_id);

      const srcInFrames = this.usToFrames(clip.src_in_us);
      const srcOutFrames = this.usToFrames(clip.src_out_us);

      lines.push(`${d}  <clipitem id="${clipId}">`);
      lines.push(
        `${d}    <name>${this.escXml(clip.motivation || clip.clip_id)}</name>`,
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

      // Audio level from metadata
      const audioPolicy = clip.audio_policy;
      if (audioPolicy?.duck_music_db !== undefined) {
        lines.push(`${d}    <filter>`);
        lines.push(`${d}      <effect>`);
        lines.push(`${d}        <name>Audio Levels</name>`);
        lines.push(`${d}        <effectid>audiolevels</effectid>`);
        lines.push(`${d}        <parameter>`);
        lines.push(`${d}          <name>Level</name>`);
        lines.push(`${d}          <parameterid>level</parameterid>`);
        lines.push(
          `${d}          <value>${audioPolicy.duck_music_db}</value>`,
        );
        lines.push(`${d}        </parameter>`);
        lines.push(`${d}      </effect>`);
        lines.push(`${d}    </filter>`);
      }

      this.appendClipMarkers(lines, depth + 4, clip);
      lines.push(`${d}  </clipitem>`);
    }

    lines.push(`${d}</track>`);
  }

  // ── Text Overlay Track ──

  private textOverlayCounter = 0;

  private appendTextOverlayTrack(
    lines: string[],
    overlays: TextOverlay[],
    depth: number,
  ): void {
    const d = this.indent(depth);
    lines.push(`${d}<track>`);
    lines.push(`${d}  <enabled>TRUE</enabled>`);
    lines.push(`${d}  <locked>FALSE</locked>`);

    for (const overlay of overlays) {
      this.textOverlayCounter++;
      this.appendTextGeneratorItem(lines, overlay, depth + 2);
    }

    lines.push(`${d}</track>`);
  }

  private appendTextGeneratorItem(
    lines: string[],
    overlay: TextOverlay,
    depth: number,
  ): void {
    const d = this.indent(depth);
    const id = `title-${this.textOverlayCounter}`;
    const label = overlay.label || overlay.text.split("\n")[0];
    const fontSize = overlay.fontSize ?? 48;
    const [r, g, b] = overlay.color ?? [255, 255, 255];
    const opacity = overlay.opacity ?? 100;
    const durFrames = overlay.durationFrames;

    // Compute vertical origin based on position
    // FCP7 origin: center of frame = (0, 0), range roughly -0.5 to 0.5
    let originY: number;
    switch (overlay.position ?? "lower-third") {
      case "top":
        originY = 0.35;
        break;
      case "center":
        originY = 0;
        break;
      case "lower-third":
      default:
        originY = -0.3;
        break;
    }

    lines.push(`${d}<generatoritem id="${id}">`);
    lines.push(`${d}  <name>${this.escXml(label)}</name>`);
    lines.push(`${d}  <duration>${durFrames}</duration>`);
    this.appendRate(lines, depth + 2);
    lines.push(`${d}  <start>${overlay.startFrame}</start>`);
    lines.push(`${d}  <end>${overlay.startFrame + durFrames}</end>`);
    lines.push(`${d}  <in>0</in>`);
    lines.push(`${d}  <out>${durFrames}</out>`);

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
    lines.push(`${d}        <horiz>0</horiz>`);
    lines.push(`${d}        <vert>${originY}</vert>`);
    lines.push(`${d}      </value>`);
    lines.push(`${d}    </parameter>`);

    lines.push(`${d}  </effect>`);
    lines.push(`${d}</generatoritem>`);
  }
}
