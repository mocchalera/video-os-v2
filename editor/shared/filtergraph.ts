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
import { canonicalLinearGainFilter } from "./audio-gain.js";

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
 * - position: pan inside zoom overscan when zoom > 1; otherwise translate
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
  let positionConsumedByZoomPan = false;

  if (zoom <= 1.0) {
    // Scale to fit, pad to fill (letterbox/pillarbox)
    filters.push(
      `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
    );
  } else {
    // Scale to cover: zoom into the frame, then crop to sequence dimensions.
    // A position offset pans the crop window inside the zoom overscan. The old
    // pad->crop translation happened after the center crop and exposed black
    // edges even when enough scaled source pixels were available.
    const scaledW = Math.round(width * zoom);
    const scaledH = Math.round(height * zoom);
    const positionX = crop ? 0 : Math.round(position?.x ?? 0);
    const positionY = crop ? 0 : Math.round(position?.y ?? 0);
    // `force_original_aspect_ratio=increase` can make the actual scaled frame
    // much wider or taller than scaledW/scaledH (notably 16:9 -> 9:16). The
    // previous numeric clamp used only scaledW/scaledH, so it cropped from the
    // left edge of the real frame and could push the subject out of portrait
    // output. Defer the centered/clamped crop calculation to ffmpeg, where
    // `iw`/`ih` are the true post-scale dimensions.
    const cropX = `max(0\\,min(iw-${width}\\,(iw-${width})/2-${positionX}))`;
    const cropY = `max(0\\,min(ih-${height}\\,(ih-${height})/2-${positionY}))`;
    filters.push(
      `scale=${scaledW}:${scaledH}:force_original_aspect_ratio=increase`,
      `crop=${width}:${height}:${cropX}:${cropY}`,
    );
    positionConsumedByZoomPan = !crop && position !== undefined;
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
  if (!positionConsumedByZoomPan && position && (position.x !== 0 || position.y !== 0)) {
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
  /**
   * Issue #34 preset styling applied on top of the xfade window:
   * - film_crossfade: standard linear dissolve (no extra styling)
   * - light_leak_flash: additive amber/cyan radial flare over the window
   * - dreamy_focus_blur: gaussian blur dissolve over the window
   */
  preset?: "film_crossfade" | "light_leak_flash" | "dreamy_focus_blur";
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
    // Issue #34 presets share the crossfade join mechanics (xfade=fade over
    // the physically overlapped A-tail/B-head window) and differ only in the
    // styling applied on top of that window.
    case "film_crossfade":
      return {
        video: {
          method: "xfade",
          xfadeDurationSec: durSec,
          xfadeTransition: "fade",
          preset: "film_crossfade",
        },
        audio: {
          method: "acrossfade",
          crossfadeDurationSec: durSec,
        },
      };

    case "light_leak_flash":
      return {
        video: {
          method: "xfade",
          xfadeDurationSec: durSec,
          xfadeTransition: "fade",
          preset: "light_leak_flash",
        },
        audio: {
          method: "acrossfade",
          crossfadeDurationSec: durSec,
        },
      };

    case "dreamy_focus_blur":
      return {
        video: {
          method: "xfade",
          xfadeDurationSec: durSec,
          xfadeTransition: "fade",
          preset: "dreamy_focus_blur",
        },
        audio: {
          method: "acrossfade",
          crossfadeDurationSec: durSec,
        },
      };

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

// ── Issue #34 preset styling (flash / blur windows) ─────────────────

/** Geometry context needed to style preset transition windows. */
export interface TransitionGraphContext {
  width: number;
  height: number;
  /** Exact fps as a number (fpsNum / fpsDen). */
  fps: number;
  /** Rational fps string (e.g. "30000/1001"); preferred for lavfi sources. */
  fpsRational?: string;
}

/** A styled transition window in output-timeline frame coordinates. */
interface StyledWindow {
  preset: "light_leak_flash" | "dreamy_focus_blur";
  startFrame: number;
  endFrame: number;
  durationSec: number;
}

/**
 * Frame-exact amber/cyan radial light-leak flare with a triangle envelope.
 *
 * Generated procedurally (geq on a black color source) and screen-blended
 * additively over an extended window. The envelope ramps up across the A/B
 * blend window, PEAKS exactly on the seam frame (the chorus head — the first
 * frame of the incoming clip's original content), and decays to zero one
 * window-length later, so the emission coincides with the musical hit and
 * neither boundary pops: intensity is 0 at window start and at window end +
 * decay. Implemented with two chained fades (in over the blend, out over the
 * tail), which are frame-exact.
 */
function buildFlashFlareWindowParts(
  window: StyledWindow,
  windowIndex: number,
  inputLabel: string,
  context: TransitionGraphContext,
): string[] {
  const { width, height } = context;
  const fpsR = context.fpsRational ?? String(context.fps);
  const a = `f${windowIndex}`;
  const blendFrames = window.endFrame - window.startFrame;
  const tailFrames = blendFrames;
  const flashEndFrame = window.endFrame + tailFrames;
  const blendSec = window.durationSec;
  // Normalized radial distance: 0 at frame center, 1 at ~0.35·diagonal.
  const dist = `hypot(X-W/2\\,Y-H/2)/(0.35*hypot(W\\,H))`;
  const core = `exp(-4*pow(${dist}\\,2))`;
  const rim = `exp(-10*pow(${dist}-1\\,2))`;
  const geq =
    `geq=r='240*${core}+30*${rim}':g='165*${core}+95*${rim}':b='55*${core}+130*${rim}'`;
  return [
    `${inputLabel}split=3[${a}0][${a}1][${a}2]`,
    `[${a}0]trim=end_frame=${window.startFrame},setpts=PTS-STARTPTS[${a}a]`,
    `[${a}1]trim=start_frame=${window.startFrame}:end_frame=${flashEndFrame},setpts=PTS-STARTPTS,format=rgb24[${a}b]`,
    `[${a}2]trim=start_frame=${flashEndFrame},setpts=PTS-STARTPTS[${a}c]`,
    `color=c=black:s=${width}x${height}:r=${fpsR}:d=${(blendSec * 2).toFixed(6)},format=rgb24,${geq},fade=t=in:st=0:d=${blendSec.toFixed(6)},fade=t=out:st=${blendSec.toFixed(6)}:d=${blendSec.toFixed(6)}[${a}f]`,
    `[${a}b][${a}f]blend=all_mode=screen:shortest=1,format=yuv420p[${a}w]`,
    `[${a}a][${a}w][${a}c]concat=n=3:v=1:a=0[vout${windowIndex + 1}]`,
  ];
}

/**
 * Frame-exact gaussian blur window with a smooth triangle envelope.
 *
 * The blended A/B melt goes sharp→soft→sharp: blur strength is 0 on the
 * first and last window frames (no boundary pops against the surrounding
 * shots) and peaks mid-window. Implemented by blending the sharp window with
 * a blurred copy using the animated mix factor 1-|2N/(D-1)-1| (N = window
 * frame index), which is exactly linear in and out.
 */
function buildBlurWindowParts(
  window: StyledWindow,
  windowIndex: number,
  inputLabel: string,
  context: TransitionGraphContext,
): string[] {
  const sigma = Math.max(2, Math.round((8 * context.height) / 1080 * 1000) / 1000);
  const a = `b${windowIndex}`;
  const blendFrames = window.endFrame - window.startFrame;
  // Triangle mix over the window frames: 0 at the first window frame, 1 at
  // mid-window, 0 at the last. ffmpeg's blend N variable starts at 1 (not
  // 0), so the index is offset by one: with N in [1, D], 2*(N-1)/(D-1)-1
  // spans [-1, 1] and the mix is exactly linear in and out. D is always
  // >= 2 (the caller rejects degenerate windows), so the divisor is >= 1.
  const triangle = `(1-abs(2*(N-1)/${blendFrames - 1}-1))`;
  return [
    `${inputLabel}split=3[${a}0][${a}1][${a}2]`,
    `[${a}0]trim=end_frame=${window.startFrame},setpts=PTS-STARTPTS[${a}a]`,
    `[${a}1]trim=start_frame=${window.startFrame}:end_frame=${window.endFrame},setpts=PTS-STARTPTS[${a}s]`,
    `[${a}2]trim=start_frame=${window.endFrame},setpts=PTS-STARTPTS[${a}c]`,
    `[${a}s]split=2[${a}k][${a}ks]`,
    `[${a}ks]gblur=sigma=${sigma.toFixed(3)}[${a}b]`,
    `[${a}k][${a}b]blend=all_expr='A*(1-${triangle})+B*${triangle}'[${a}w]`,
    `[${a}a][${a}w][${a}c]concat=n=3:v=1:a=0[vout${windowIndex + 1}]`,
  ];
}

/**
 * Build the video portion of a filter_complex for a sequence of clips
 * with transitions.
 *
 * Input labels: [v0], [v1], ... for each clip's video stream.
 * Returns the filter chain string and the final output label.
 *
 * When `context` is provided, Issue #34 preset windows (light_leak_flash /
 * dreamy_focus_blur) receive frame-exact styling passes appended after the
 * main transition chain. Context is REQUIRED when any transition declares
 * such a preset — the builder fails closed instead of silently dropping the
 * styling.
 */
export function buildVideoTransitionGraph(
  clipCount: number,
  clipDurationsSec: number[],
  transitions: Array<{ spec: TransitionSpec; fromIndex: number; toIndex: number }>,
  context?: TransitionGraphContext,
): { filterChain: string; outputLabel: string } {
  if (clipCount <= 1) {
    return { filterChain: "", outputLabel: "[v0]" };
  }

  // Build a transition lookup: toIndex → spec
  const transMap = new Map<number, TransitionSpec>();
  for (const t of transitions) {
    transMap.set(t.toIndex, t.spec);
  }

  const parts: string[] = [];
  const styledWindows: StyledWindow[] = [];
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
      if (spec.video.preset === "light_leak_flash" || spec.video.preset === "dreamy_focus_blur") {
        if (!context) {
          throw new Error(
            `transition graph context (width/height/fps) is required to render the ${spec.video.preset} preset window`,
          );
        }
        const startFrame = Math.round(offset * context.fps);
        const endFrame = startFrame + Math.round(xfadeDur * context.fps);
        if (startFrame < 0 || endFrame <= startFrame) {
          throw new Error(
            `invalid ${spec.video.preset} window [${startFrame}, ${endFrame}) — transition duration ${xfadeDur}s exceeds available overlap`,
          );
        }
        // Degenerate blur window (D < 2): the triangle ramp divides by
        // (D - 1), which is 0 here, and a single frame cannot ramp. Skip the
        // styling pass entirely — emitting the blend would produce a NaN mix
        // expression, which ffmpeg renders as BLACK FRAMES. The preset then
        // renders exactly like the plain linear crossfade. This matches
        // Remotion, whose D == 1 progress guard shows clip A on the single
        // window frame (xfade alpha is 0 there) with no blur filter, and
        // leaves compiler metadata and geometry untouched.
        const degenerateBlurWindow =
          spec.video.preset === "dreamy_focus_blur" && endFrame - startFrame < 2;
        if (!degenerateBlurWindow) {
          styledWindows.push({
            preset: spec.video.preset,
            startFrame,
            endFrame,
            durationSec: xfadeDur,
          });
        }
      }
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

  // Append frame-exact styling passes for the preset windows, chained over
  // the main transition output. Window frames derive from the same offsets
  // the xfade uses, so styling lands on the exact blend frames.
  let outputLabel = prevLabel;
  for (const [windowIndex, window] of styledWindows.entries()) {
    const inputLabel = outputLabel;
    const windowParts = window.preset === "light_leak_flash"
      ? buildFlashFlareWindowParts(window, windowIndex, inputLabel, context!)
      : buildBlurWindowParts(window, windowIndex, inputLabel, context!);
    parts.push(...windowParts);
    outputLabel = `[vout${windowIndex + 1}]`;
  }

  return {
    filterChain: parts.join(";"),
    outputLabel,
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
  if (clipCount <= 1) {
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
      // Use adelay + amix (both at full volume, no crossfade). Callers
      // extend the incoming audio input by leadSec so the mixed output keeps
      // the same duration as the hard-cut picture.
      const leadSec = spec.audio.audioLeadSec;
      const delayMs = Math.max(0, Math.round((accDurSec - leadSec) * 1000));
      parts.push(
        `[a${i}]adelay=${delayMs}|${delayMs}[a${i}d];` +
        `${prevLabel}[a${i}d]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0${outLabel}`,
      );
      accDurSec += clipDurationsSec[i];
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
  kind?: "source" | "gap";
  sourcePath?: string;
  sourceInSec?: number;
  durationSec: number;
  /** Per-clip video filter chain (from buildVideoClipFilterString). */
  videoFilter: string;
  /** Whether the source file carries an audio stream. */
  hasAudio: boolean;
  /** Canonical normalized still input. It is looped for exactly frameCount frames. */
  still?: { fps: string; frameCount: number };
  /** Optional nat-audio gain in dB. */
  gainDb?: number | null;
  /** Canonical amplitude multiplier. Preferred over gainDb when present. */
  gainLinear?: number | null;
  /** Audio role/track metadata, used by callers to decide speech-cut fades. */
  audioRole?: string;
  audioTrackId?: string;
  /** Optional per-input edge fades applied before transition graph joins. */
  audioFadeInSec?: number;
  audioFadeOutSec?: number;
  /** Audio-only source trim start. Defaults to sourceInSec. */
  audioSourceInSec?: number;
  /** Audio-only source duration. Defaults to durationSec. */
  audioDurationSec?: number;
  /** Gap input config. Used only when kind === "gap". */
  gap?: {
    width: number;
    height: number;
    fps: number | string;
  };
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
  /** Canonical output CFR, preferably the timeline numerator/denominator. */
  outputFps?: string;
  /**
   * Geometry context for Issue #34 preset styling (light_leak_flash /
   * dreamy_focus_blur windows). Required when any transition uses those
   * presets — the graph builder fails closed without it.
   */
  graphContext?: TransitionGraphContext;
  outputPath: string;
}

export interface TransitionAudioExtensionInput {
  sourceInSec: number;
  durationSec: number;
}

export interface TransitionAudioExtension {
  audioSourceInSec: number;
  audioDurationSec: number;
  timelineStartShiftSec: number;
}

export function computeTransitionAudioExtensions(
  inputs: TransitionAudioExtensionInput[],
  transitions: Array<{
    spec: TransitionSpec;
    fromIndex: number;
    toIndex: number;
  }>,
): Map<number, TransitionAudioExtension> {
  const extensions = new Map<number, TransitionAudioExtension>();

  const getExtension = (index: number): TransitionAudioExtension => {
    const existing = extensions.get(index);
    if (existing) return existing;
    const base = inputs[index];
    const created: TransitionAudioExtension = {
      audioSourceInSec: base.sourceInSec,
      audioDurationSec: base.durationSec,
      timelineStartShiftSec: 0,
    };
    extensions.set(index, created);
    return created;
  };

  for (const transition of transitions) {
    if (
      transition.spec.audio.method === "audio_lead" &&
      transition.spec.audio.audioLeadSec
    ) {
      const leadSec = Math.max(0, transition.spec.audio.audioLeadSec);
      const input = inputs[transition.toIndex];
      if (!input || leadSec <= 0) continue;
      const ext = getExtension(transition.toIndex);
      const nextSourceIn = Math.max(0, input.sourceInSec - leadSec);
      const actualLeadSec = input.sourceInSec - nextSourceIn;
      ext.audioSourceInSec = Math.min(ext.audioSourceInSec, nextSourceIn);
      ext.audioDurationSec = Math.max(
        ext.audioDurationSec,
        input.durationSec + actualLeadSec,
      );
      ext.timelineStartShiftSec = Math.min(
        ext.timelineStartShiftSec,
        -leadSec,
      );
    } else if (
      transition.spec.audio.method === "audio_trail" &&
      transition.spec.audio.audioTrailSec
    ) {
      const trailSec = Math.max(0, transition.spec.audio.audioTrailSec);
      const input = inputs[transition.fromIndex];
      if (!input || trailSec <= 0) continue;
      const ext = getExtension(transition.fromIndex);
      ext.audioDurationSec = Math.max(
        ext.audioDurationSec,
        input.durationSec + trailSec,
      );
    }
  }

  return extensions;
}

export function applyTransitionAudioExtensions<T extends TransitionChainInput>(
  inputs: T[],
  transitions: Array<{
    spec: TransitionSpec;
    fromIndex: number;
    toIndex: number;
  }>,
): T[] {
  const extensions = computeTransitionAudioExtensions(
    inputs.map((input) => ({
      sourceInSec: input.sourceInSec ?? 0,
      durationSec: input.durationSec,
    })),
    transitions,
  );

  return inputs.map((input, index) => {
    const ext = extensions.get(index);
    if (!ext) return input;
    return {
      ...input,
      audioSourceInSec: ext.audioSourceInSec,
      audioDurationSec: ext.audioDurationSec,
    };
  });
}

export interface TransitionChainTimelineInput extends TransitionChainInput {
  clipId: string;
  timelineInFrame: number;
  durationFrames: number;
}

export interface GapAwareTransitionChainPlan {
  inputs: TransitionChainInput[];
  clipDurationsSec: number[];
  clipIndexToChainIndex: Map<number, number>;
  hasGaps: boolean;
}

export function buildGapAwareTransitionChainInputs(
  clipInputs: TransitionChainTimelineInput[],
  opts: {
    fps: number;
    fpsRational?: string;
    width: number;
    height: number;
    startFrame?: number;
    totalFrames?: number;
  },
): GapAwareTransitionChainPlan {
  const ordered = clipInputs
    .map((input, originalIndex) => ({ input, originalIndex }))
    .sort((a, b) => {
      const byStart = a.input.timelineInFrame - b.input.timelineInFrame;
      return byStart !== 0 ? byStart : a.originalIndex - b.originalIndex;
    });

  const inputs: TransitionChainInput[] = [];
  const clipIndexToChainIndex = new Map<number, number>();
  let cursor = opts.startFrame ?? 0;
  let hasGaps = false;

  const pushGap = (durationFrames: number): void => {
    if (durationFrames <= 0) return;
    hasGaps = true;
    inputs.push({
      kind: "gap",
      durationSec: durationFrames / opts.fps,
      videoFilter: "format=yuv420p,setsar=1",
      hasAudio: false,
      gap: {
        width: opts.width,
        height: opts.height,
        fps: opts.fpsRational ?? opts.fps,
      },
    });
  };

  for (const { input, originalIndex } of ordered) {
    const start = input.timelineInFrame;
    if (start > cursor) {
      pushGap(start - cursor);
    }
    clipIndexToChainIndex.set(originalIndex, inputs.length);
    inputs.push({
      ...input,
      kind: input.kind ?? "source",
    });
    cursor = Math.max(cursor, input.timelineInFrame + input.durationFrames);
  }

  if (opts.totalFrames !== undefined && opts.totalFrames > cursor) {
    pushGap(opts.totalFrames - cursor);
  }

  return {
    inputs,
    clipDurationsSec: inputs.map((input) => input.durationSec),
    clipIndexToChainIndex,
    hasGaps,
  };
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

  // Source inputs, trimmed at the demuxer (-ss/-t before -i). Gap inputs are
  // black lavfi sources with the same dimensions and fps as buildGapVideoArgs.
  for (const input of opts.inputs) {
    if (input.kind === "gap") {
      if (!input.gap) {
        throw new Error("Transition chain gap input is missing dimensions");
      }
      args.push(
        "-f", "lavfi",
        "-t", input.durationSec.toFixed(6),
        "-i", `color=c=black:s=${input.gap.width}x${input.gap.height}:r=${input.gap.fps}`,
      );
    } else {
      if (!input.sourcePath) {
        throw new Error("Transition chain source input is missing sourcePath");
      }
      if (input.still) {
        args.push("-loop", "1", "-framerate", input.still.fps, "-i", input.sourcePath);
      } else {
        args.push(
          "-ss", (input.sourceInSec ?? 0).toFixed(6),
          "-t", input.durationSec.toFixed(6),
          "-i", input.sourcePath,
        );
      }
    }
  }

  // Silent stand-ins for sources without audio, appended after the real
  // inputs so video stream indexes stay 0..N-1. When audio needs a different
  // trim range from video (j_cut/l_cut), append an audio-only source input.
  const audioInputIndex: number[] = [];
  let nextExtraIndex = opts.inputs.length;
  if (opts.includeAudio) {
    for (const input of opts.inputs) {
      const audioDurationSec = input.audioDurationSec ?? input.durationSec;
      const needsSeparateAudioInput =
        input.kind !== "gap" &&
        input.hasAudio &&
        (
          input.audioSourceInSec !== undefined ||
          input.audioDurationSec !== undefined
        );

      if (needsSeparateAudioInput && input.sourcePath) {
        audioInputIndex.push(nextExtraIndex);
        args.push(
          "-ss", (input.audioSourceInSec ?? input.sourceInSec ?? 0).toFixed(6),
          "-t", audioDurationSec.toFixed(6),
          "-i", input.sourcePath,
        );
        nextExtraIndex += 1;
      } else if (input.kind !== "gap" && input.hasAudio) {
        audioInputIndex.push(-1); // own stream
      } else {
        audioInputIndex.push(nextExtraIndex);
        args.push(
          "-f", "lavfi",
          "-t", audioDurationSec.toFixed(6),
          "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
        );
        nextExtraIndex += 1;
      }
    }
  }

  // Label bindings: [i:v] → per-clip filters → [vN]; audio → [aN].
  const parts: string[] = [];
  opts.inputs.forEach((input, i) => {
    const exactStill = input.still ? `,trim=end_frame=${input.still.frameCount}` : "";
    parts.push(`[${i}:v]${input.videoFilter}${exactStill},settb=AVTB,setpts=PTS-STARTPTS[v${i}]`);
  });
  if (opts.includeAudio) {
    opts.inputs.forEach((input, i) => {
      const srcIndex = audioInputIndex[i] === -1 ? i : audioInputIndex[i];
      parts.push(`[${srcIndex}:a]${buildAudioInputFilter(input)}[a${i}]`);
    });
  }

  const { filterChain: videoChain, outputLabel: videoOut } =
    buildVideoTransitionGraph(
      opts.inputs.length,
      opts.clipDurationsSec,
      opts.transitions,
      opts.graphContext,
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
  if (opts.outputFps) {
    args.push("-r", opts.outputFps, "-fps_mode", "cfr");
  }
  args.push("-pix_fmt", "yuv420p", opts.outputPath);
  return args;
}

function buildAudioInputFilter(input: TransitionChainInput): string {
  const filters: string[] = [];
  if (input.gainLinear !== null && input.gainLinear !== undefined) {
    const gainFilter = canonicalLinearGainFilter(input.gainLinear);
    if (gainFilter) filters.push(gainFilter);
  } else if (
    input.gainDb !== null &&
    input.gainDb !== undefined &&
    input.gainDb !== 0
  ) {
    filters.push(`volume=${input.gainDb}dB`);
  }

  if (input.audioFadeInSec !== undefined && input.audioFadeInSec > 0) {
    filters.push(`afade=t=in:st=0:d=${input.audioFadeInSec.toFixed(6)}`);
  }
  if (input.audioFadeOutSec !== undefined && input.audioFadeOutSec > 0) {
    const durationSec = input.audioDurationSec ?? input.durationSec;
    const fadeStart = Math.max(0, durationSec - input.audioFadeOutSec);
    filters.push(
      `afade=t=out:st=${fadeStart.toFixed(6)}:d=${input.audioFadeOutSec.toFixed(6)}`,
    );
  }

  return filters.length > 0 ? filters.join(",") : "anull";
}
