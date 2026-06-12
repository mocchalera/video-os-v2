/**
 * Shared Video Filter Builder — Phase 2: Video Parity
 *
 * Generates ffmpeg -vf filter chains from RenderVideoClip transform specs.
 * Used by both preview-job-service (preview) and final render pipeline
 * to guarantee identical video composition.
 *
 * Transform order (fixed, per Section 9.1):
 *   1. trim          (handled by caller via -ss / -t)
 *   2. scale to cover / contain
 *   3. crop
 *   4. translate
 *   5. color / effect (future)
 *   6. format / setsar
 */

import type {
  RenderVideoClip,
  RenderTransition,
  RenderEffectSpec,
} from "./render-spec.js";

interface SequenceDimensions {
  width: number;
  height: number;
}

/**
 * Build an ffmpeg -vf filter string array for a single video clip.
 *
 * - zoom === 1.0: scale to fit within sequence dimensions, pad to fill
 * - zoom > 1.0: scale to (width*zoom)x(height*zoom), crop to center
 * - crop: applied after zoom (absolute pixel coords within sequence frame)
 * - position: translate after crop
 *
 * Returns an array of filter expressions to be joined with commas for -vf.
 */
export function buildVideoClipFilter(
  clip: RenderVideoClip,
  sequence: SequenceDimensions,
): string[] {
  const { width, height } = sequence;
  const { zoom, crop, position } = clip.transform;
  const filters: string[] = [];

  if (zoom <= 1.0) {
    // Scale to fit, pad to fill (letterbox/pillarbox)
    filters.push(
      `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
    );
  } else {
    // Scale to cover: zoom into the frame, then crop to sequence dimensions
    const scaledW = Math.round(width * zoom);
    const scaledH = Math.round(height * zoom);
    filters.push(
      `scale=${scaledW}:${scaledH}:force_original_aspect_ratio=increase`,
      `crop=${width}:${height}:(iw-${width})/2:(ih-${height})/2`,
    );
  }

  // Optional explicit crop (absolute coords within the sequence frame)
  // After crop, scale back to sequence dimensions so concat streams stay uniform.
  if (crop) {
    filters.push(
      `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`,
      `scale=${width}:${height}`,
    );
  }

  // Optional translate (position offset)
  if (position && (position.x !== 0 || position.y !== 0)) {
    // Shift the image on a black canvas via pad→crop.
    // Input is guaranteed WxH at this point (from zoom or crop+scale above).
    const padW = width + Math.abs(position.x) * 2;
    const padH = height + Math.abs(position.y) * 2;
    const padX = Math.abs(position.x) + position.x;
    const padY = Math.abs(position.y) + position.y;
    filters.push(
      `pad=${padW}:${padH}:${padX}:${padY}:black`,
      `crop=${width}:${height}:(iw-${width})/2:(ih-${height})/2`,
    );
  }

  // Phase 5: 5. color / effect
  // Apply effect chain in declared order — preview and final use the same
  // serialization (same builder, same input list).
  for (const effect of clip.effects) {
    const expr = buildEffectFilter(effect);
    if (expr) filters.push(expr);
  }

  // Format / setsar (always last) — guarantees uniform pixel format for concat
  filters.push("format=yuv420p", "setsar=1");

  return filters;
}

// ── Effect filter builder (Phase 5) ──────────────────────────────────

/**
 * Quote a curves preset/value if it contains characters that ffmpeg
 * filtergraph parsing dislikes (spaces, commas, colons, brackets).
 */
function quoteFilterValue(value: string): string {
  if (/^[A-Za-z0-9_./+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "\\'")}'`;
}

/**
 * Render a numeric param with deterministic precision.
 * Avoids locale-dependent formatting and trailing-zero noise.
 */
function fmtNum(n: number): string {
  // 6 significant digits, then strip trailing zeros and a trailing dot.
  if (!Number.isFinite(n)) return "0";
  const s = n.toFixed(6);
  return s.replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * Build a single ffmpeg filter expression for one effect.
 *
 * Returns an empty string when the effect is a no-op or has no producible
 * parameters. Both preview and final render call this so the serialized
 * graph is byte-identical.
 *
 * Phase 5 supported types:
 *   - eq:                 collapses any of brightness/contrast/saturation/gamma
 *                         into a single eq=... node
 *   - brightness:         eq=brightness=<v>
 *   - contrast:           eq=contrast=<v>
 *   - saturation:         eq=saturation=<v>
 *   - curves:             curves=preset=<name>  OR
 *                         curves=red='...':green='...':blue='...':all='...'
 *   - none:               returns "" (skipped by caller)
 *
 * Unknown types return "" — the spec builder is responsible for emitting a
 * warning before this point.
 */
export function buildEffectFilter(effect: RenderEffectSpec): string {
  switch (effect.type) {
    case "none":
      return "";

    case "eq": {
      const allowed: ReadonlyArray<string> = [
        "contrast",
        "brightness",
        "saturation",
        "gamma",
        "gamma_r",
        "gamma_g",
        "gamma_b",
        "gamma_weight",
      ];
      const parts: string[] = [];
      for (const key of allowed) {
        const v = effect.params[key];
        if (typeof v === "number") {
          parts.push(`${key}=${fmtNum(v)}`);
        }
      }
      if (parts.length === 0) return "";
      return `eq=${parts.join(":")}`;
    }

    case "brightness": {
      const v = effect.params.value ?? effect.params.brightness;
      if (typeof v !== "number") return "";
      return `eq=brightness=${fmtNum(v)}`;
    }

    case "contrast": {
      const v = effect.params.value ?? effect.params.contrast;
      if (typeof v !== "number") return "";
      return `eq=contrast=${fmtNum(v)}`;
    }

    case "saturation": {
      const v = effect.params.value ?? effect.params.saturation;
      if (typeof v !== "number") return "";
      return `eq=saturation=${fmtNum(v)}`;
    }

    case "curves": {
      const preset = effect.params.preset;
      if (typeof preset === "string" && preset.length > 0) {
        return `curves=preset=${quoteFilterValue(preset)}`;
      }
      const channels: ReadonlyArray<string> = ["all", "red", "green", "blue"];
      const parts: string[] = [];
      for (const ch of channels) {
        const v = effect.params[ch];
        if (typeof v === "string" && v.length > 0) {
          parts.push(`${ch}=${quoteFilterValue(v)}`);
        }
      }
      if (parts.length === 0) return "";
      return `curves=${parts.join(":")}`;
    }

    default:
      // Unknown / degraded effect — caller already warned via spec builder.
      return "";
  }
}

/**
 * Convenience: join filter array into a single -vf value string.
 */
export function buildVideoClipFilterString(
  clip: RenderVideoClip,
  sequence: SequenceDimensions,
): string {
  return buildVideoClipFilter(clip, sequence).join(",");
}

// ── Transition Video/Audio Specs (Phase 4) ─────────────────────────

/** Video component of a transition. */
export interface TransitionVideoSpec {
  /** How to join the two video streams. */
  method: "cut" | "xfade" | "fade_in_out";
  /** xfade duration in seconds (for crossfade). */
  xfadeDurationSec?: number;
  /** xfade transition name (ffmpeg xfade filter). */
  xfadeTransition?: string;
  /** fade-out duration on outgoing clip in seconds (for fade_to_black). */
  fadeOutDurationSec?: number;
  /** fade-in duration on incoming clip in seconds (for fade_to_black). */
  fadeInDurationSec?: number;
}

/** Audio component of a transition. */
export interface TransitionAudioSpec {
  method: "cut" | "acrossfade" | "audio_lead" | "audio_trail";
  /** acrossfade duration in seconds (for crossfade). */
  crossfadeDurationSec?: number;
  /** Incoming audio starts this many seconds before the video cut (j_cut). */
  audioLeadSec?: number;
  /** Outgoing audio continues this many seconds after the video cut (l_cut). */
  audioTrailSec?: number;
}

/** Combined transition spec for a single adjacency. */
export interface TransitionSpec {
  video: TransitionVideoSpec;
  audio: TransitionAudioSpec;
}

/**
 * Derive the video + audio spec for a single RenderTransition.
 *
 * Used by both preview-job-service and final render to ensure identical
 * transition handling.
 */
export function buildTransitionSpec(
  transition: RenderTransition,
  fps: number,
): TransitionSpec {
  const durSec = transition.durationFrames / fps;

  switch (transition.type) {
    case "crossfade":
      return {
        video: {
          method: "xfade",
          xfadeDurationSec: durSec,
          xfadeTransition: "fade",
        },
        audio: {
          method: "acrossfade",
          crossfadeDurationSec: durSec,
        },
      };

    case "fade_to_black": {
      const halfDur = durSec / 2;
      return {
        video: {
          method: "fade_in_out",
          fadeOutDurationSec: halfDur,
          fadeInDurationSec: halfDur,
        },
        audio: {
          method: "acrossfade",
          crossfadeDurationSec: durSec,
        },
      };
    }

    case "j_cut":
      return {
        video: { method: "cut" },
        audio: {
          method: "audio_lead",
          audioLeadSec: transition.audioLeadSec ?? durSec,
        },
      };

    case "l_cut":
      return {
        video: { method: "cut" },
        audio: {
          method: "audio_trail",
          audioTrailSec: transition.audioTrailSec ?? durSec,
        },
      };

    case "cut":
    default:
      return {
        video: { method: "cut" },
        audio: { method: "cut" },
      };
  }
}

/**
 * Build the video portion of a filter_complex for a sequence of clips
 * with transitions.
 *
 * Input labels: [v0], [v1], ... for each clip's video stream.
 * Returns the filter chain string and the final output label.
 */
export function buildVideoTransitionGraph(
  clipCount: number,
  clipDurationsSec: number[],
  transitions: Array<{ spec: TransitionSpec; fromIndex: number; toIndex: number }>,
): { filterChain: string; outputLabel: string } {
  if (clipCount <= 1 || transitions.length === 0) {
    return { filterChain: "", outputLabel: "[v0]" };
  }

  // Build a transition lookup: toIndex → spec
  const transMap = new Map<number, TransitionSpec>();
  for (const t of transitions) {
    transMap.set(t.toIndex, t.spec);
  }

  const parts: string[] = [];
  let prevLabel = "[v0]";
  let accumulatedOffset = clipDurationsSec[0];

  for (let i = 1; i < clipCount; i++) {
    const spec = transMap.get(i);
    const outLabel = i < clipCount - 1 ? `[vt${i}]` : "[vout]";

    if (spec?.video.method === "xfade" && spec.video.xfadeDurationSec) {
      const xfadeDur = spec.video.xfadeDurationSec;
      const offset = accumulatedOffset - xfadeDur;
      const transition = spec.video.xfadeTransition ?? "fade";
      parts.push(
        `${prevLabel}[v${i}]xfade=transition=${transition}:duration=${xfadeDur.toFixed(6)}:offset=${offset.toFixed(6)}${outLabel}`,
      );
      accumulatedOffset = offset + clipDurationsSec[i];
    } else if (spec?.video.method === "fade_in_out") {
      // fade_to_black: fade-out on previous, fade-in on current, then concat
      // We use xfade=transition=fadeblack which handles this natively
      const fadeOutDur = spec.video.fadeOutDurationSec ?? 0;
      const fadeInDur = spec.video.fadeInDurationSec ?? 0;
      const totalDur = fadeOutDur + fadeInDur;
      const offset = accumulatedOffset - totalDur;
      parts.push(
        `${prevLabel}[v${i}]xfade=transition=fadeblack:duration=${totalDur.toFixed(6)}:offset=${offset.toFixed(6)}${outLabel}`,
      );
      accumulatedOffset = offset + clipDurationsSec[i];
    } else {
      // cut: simple concat (no overlap)
      const concatLabel = outLabel;
      parts.push(
        `${prevLabel}[v${i}]concat=n=2:v=1:a=0${concatLabel}`,
      );
      accumulatedOffset += clipDurationsSec[i];
    }
    prevLabel = outLabel;
  }

  return {
    filterChain: parts.join(";"),
    outputLabel: prevLabel,
  };
}

/**
 * Build the audio portion of a filter_complex for a sequence of clips
 * with transitions.
 *
 * Input labels: [a0], [a1], ... for each clip's audio stream.
 * Returns the filter chain string and the final output label.
 */
export function buildAudioTransitionGraph(
  clipCount: number,
  clipDurationsSec: number[],
  transitions: Array<{ spec: TransitionSpec; fromIndex: number; toIndex: number }>,
): { filterChain: string; outputLabel: string } {
  if (clipCount <= 1 || transitions.length === 0) {
    return { filterChain: "", outputLabel: "[a0]" };
  }

  const transMap = new Map<number, TransitionSpec>();
  for (const t of transitions) {
    transMap.set(t.toIndex, t.spec);
  }

  const parts: string[] = [];
  let prevLabel = "[a0]";
  let accDurSec = clipDurationsSec[0];

  for (let i = 1; i < clipCount; i++) {
    const spec = transMap.get(i);
    const outLabel = i < clipCount - 1 ? `[at${i}]` : "[aout]";

    if (spec?.audio.method === "acrossfade" && spec.audio.crossfadeDurationSec) {
      const dur = spec.audio.crossfadeDurationSec;
      parts.push(
        `${prevLabel}[a${i}]acrossfade=d=${dur.toFixed(6)}:c1=tri:c2=tri${outLabel}`,
      );
      accDurSec = accDurSec - dur + clipDurationsSec[i];
    } else if (spec?.audio.method === "audio_lead" && spec.audio.audioLeadSec) {
      // j_cut: incoming audio starts leadSec before the video cut.
      // Use adelay + amix (both at full volume, no crossfade).
      const leadSec = spec.audio.audioLeadSec;
      const delayMs = Math.max(0, Math.round((accDurSec - leadSec) * 1000));
      parts.push(
        `[a${i}]adelay=${delayMs}|${delayMs}[a${i}d];` +
        `${prevLabel}[a${i}d]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0${outLabel}`,
      );
      accDurSec = accDurSec - leadSec + clipDurationsSec[i];
    } else if (spec?.audio.method === "audio_trail" && spec.audio.audioTrailSec) {
      // l_cut: outgoing audio continues trailSec after the video cut.
      // Use apad (hold outgoing) + adelay + amix.
      const trailSec = spec.audio.audioTrailSec;
      const delayMs = Math.round(accDurSec * 1000);
      parts.push(
        `${prevLabel}apad=pad_dur=${trailSec.toFixed(6)}[a${i}p];` +
        `[a${i}]adelay=${delayMs}|${delayMs}[a${i}d];` +
        `[a${i}p][a${i}d]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0${outLabel}`,
      );
      accDurSec = accDurSec + clipDurationsSec[i];
    } else {
      // cut: simple concat
      parts.push(
        `${prevLabel}[a${i}]concat=n=2:v=0:a=1${outLabel}`,
      );
      accDurSec += clipDurationsSec[i];
    }
    prevLabel = outLabel;
  }

  return {
    filterChain: parts.join(";"),
    outputLabel: prevLabel,
  };
}

// ── Single-generation transition chain (cross-path parity) ──────────

export interface TransitionChainInput {
  sourcePath: string;
  sourceInSec: number;
  durationSec: number;
  /** Per-clip video filter chain (from buildVideoClipFilterString). */
  videoFilter: string;
  /** Whether the source file carries an audio stream. */
  hasAudio: boolean;
  /** Optional nat-audio gain in dB. */
  gainDb?: number | null;
}

export interface TransitionChainOptions {
  inputs: TransitionChainInput[];
  clipDurationsSec: number[];
  transitions: Array<{
    spec: TransitionSpec;
    fromIndex: number;
    toIndex: number;
  }>;
  /** false → video-only output (-an); audio handled elsewhere. */
  includeAudio: boolean;
  /** Encoder args for the single video generation, e.g. x264Args(...). */
  videoEncodeArgs: string[];
  /** Audio codec args when includeAudio, e.g. ["-c:a","pcm_s16le",...]. */
  audioCodecArgs?: string[];
  outputPath: string;
}

/**
 * Build ONE ffmpeg invocation that trims every clip straight from its
 * source, applies the per-clip filter chain, and joins the clips through
 * the shared transition graphs — a single encode generation.
 *
 * Both the exact preview and the final assembler must render transitioned
 * timelines through this builder: if either path pre-encodes clips and
 * then re-encodes them through the graph, that extra lossy generation
 * alone pushes cross-path SSIM below the 0.999 acceptance bar.
 */
export function buildTransitionChainArgs(opts: TransitionChainOptions): string[] {
  const args: string[] = ["-y"];

  // Source inputs, trimmed at the demuxer (-ss/-t before -i).
  for (const input of opts.inputs) {
    args.push(
      "-ss", input.sourceInSec.toFixed(6),
      "-t", input.durationSec.toFixed(6),
      "-i", input.sourcePath,
    );
  }

  // Silent stand-ins for sources without audio, appended after the real
  // inputs so video stream indexes stay 0..N-1.
  const audioInputIndex: number[] = [];
  let nextExtraIndex = opts.inputs.length;
  if (opts.includeAudio) {
    for (const input of opts.inputs) {
      if (input.hasAudio) {
        audioInputIndex.push(-1); // own stream
      } else {
        audioInputIndex.push(nextExtraIndex);
        args.push(
          "-f", "lavfi",
          "-t", input.durationSec.toFixed(6),
          "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
        );
        nextExtraIndex += 1;
      }
    }
  }

  // Label bindings: [i:v] → per-clip filters → [vN]; audio → [aN].
  const parts: string[] = [];
  opts.inputs.forEach((input, i) => {
    parts.push(`[${i}:v]${input.videoFilter}[v${i}]`);
  });
  if (opts.includeAudio) {
    opts.inputs.forEach((input, i) => {
      const srcIndex = audioInputIndex[i] === -1 ? i : audioInputIndex[i];
      const gain =
        input.gainDb !== null && input.gainDb !== undefined && input.gainDb !== 0
          ? `volume=${input.gainDb}dB`
          : "anull";
      parts.push(`[${srcIndex}:a]${gain}[a${i}]`);
    });
  }

  const { filterChain: videoChain, outputLabel: videoOut } =
    buildVideoTransitionGraph(
      opts.inputs.length,
      opts.clipDurationsSec,
      opts.transitions,
    );
  if (videoChain) parts.push(videoChain);

  let audioOut: string | null = null;
  if (opts.includeAudio) {
    const audio = buildAudioTransitionGraph(
      opts.inputs.length,
      opts.clipDurationsSec,
      opts.transitions,
    );
    if (audio.filterChain) parts.push(audio.filterChain);
    audioOut = audio.outputLabel;
  }

  args.push("-filter_complex", parts.join(";"));
  args.push("-map", videoOut);
  if (opts.includeAudio && audioOut) {
    args.push("-map", audioOut);
  } else {
    args.push("-an");
  }
  args.push(...opts.videoEncodeArgs);
  if (opts.includeAudio && opts.audioCodecArgs) {
    args.push(...opts.audioCodecArgs);
  }
  args.push("-pix_fmt", "yuv420p", opts.outputPath);
  return args;
}
