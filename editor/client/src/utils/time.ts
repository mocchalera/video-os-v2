import type { Sequence } from '../types';

const MICROSECONDS_PER_SECOND = 1_000_000;

interface TimelineDurationSource {
  src_in_us: number;
  src_out_us: number;
  timeline_duration_frames?: number | null;
}

interface TimelineClipSource extends TimelineDurationSource {
  timeline_in_frame: number;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function getFps(sequence: Sequence): number {
  return sequence.fps_num / sequence.fps_den;
}

export function framesToSeconds(frames: number, fps: number): number {
  return frames / fps;
}

export function secondsToFrames(seconds: number, fps: number): number {
  return Math.round(seconds * fps);
}

export function framesToMicroseconds(frames: number, fps: number): number {
  return Math.round((frames / fps) * MICROSECONDS_PER_SECOND);
}

export function microsecondsToFrames(microseconds: number, fps: number): number {
  return Math.round((microseconds / MICROSECONDS_PER_SECOND) * fps);
}

export function durationFramesFromSource(
  srcInUs: number,
  srcOutUs: number,
  fps: number,
): number {
  return Math.max(1, microsecondsToFrames(srcOutUs - srcInUs, fps));
}

export function resolveTimelineDurationFrames(
  timelineDurationFrames: number | null | undefined,
  srcInUs: number,
  srcOutUs: number,
  fps: number,
): number {
  if (
    typeof timelineDurationFrames === 'number' &&
    Number.isFinite(timelineDurationFrames) &&
    timelineDurationFrames >= 1
  ) {
    return Math.round(timelineDurationFrames);
  }

  return durationFramesFromSource(srcInUs, srcOutUs, fps);
}

export function getTimelineDurationFrames(
  clip: TimelineDurationSource,
  fps: number,
): number {
  return resolveTimelineDurationFrames(
    clip.timeline_duration_frames,
    clip.src_in_us,
    clip.src_out_us,
    fps,
  );
}

export function getTimelineClipEndFrame(
  clip: TimelineClipSource,
  fps: number,
): number {
  return clip.timeline_in_frame + getTimelineDurationFrames(clip, fps);
}

export function formatClockFromFrames(frames: number, fps: number): string {
  const totalSeconds = framesToSeconds(frames, fps);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const milliseconds = Math.floor((totalSeconds % 1) * 1000);

  return [
    String(hours).padStart(2, '0'),
    String(minutes).padStart(2, '0'),
    String(seconds).padStart(2, '0'),
  ].join(':') + `.${String(milliseconds).padStart(3, '0')}`;
}

export function formatMicroseconds(microseconds: number, fps: number): string {
  return formatClockFromFrames(microsecondsToFrames(microseconds, fps), fps);
}

export function formatFrameLabel(frame: number, fps: number): string {
  const seconds = frame / fps;
  if (seconds < 1) {
    return `${frame}f`;
  }

  if (Number.isInteger(seconds)) {
    return `${seconds}s`;
  }

  return `${seconds.toFixed(1)}s`;
}

/**
 * Format frame number as SMPTE timecode: HH:MM:SS:FF
 * Supports drop-frame for 29.97fps (DF format).
 */
export function formatTimecode(
  frame: number,
  fps: number,
  dropFrame: boolean = false,
): string {
  if (frame < 0) frame = 0;

  if (dropFrame && Math.abs(fps - 29.97) < 0.02) {
    // Drop-frame timecode for 29.97fps
    const d = Math.floor(frame / 17982);
    const m = frame % 17982;
    const adjustedFrame =
      frame + 18 * d + 2 * Math.floor(Math.max(0, m - 2) / 1798);
    const fr = adjustedFrame % 30;
    const sec = Math.floor(adjustedFrame / 30) % 60;
    const min = Math.floor(adjustedFrame / 1800) % 60;
    const hr = Math.floor(adjustedFrame / 108000);
    return `${String(hr).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')};${String(fr).padStart(2, '0')}`;
  }

  // Non-drop-frame
  const roundedFps = Math.round(fps);
  const fr = frame % roundedFps;
  const totalSeconds = Math.floor(frame / roundedFps);
  const sec = totalSeconds % 60;
  const min = Math.floor(totalSeconds / 60) % 60;
  const hr = Math.floor(totalSeconds / 3600);
  return `${String(hr).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}:${String(fr).padStart(2, '0')}`;
}

/** Get the appropriate ruler tick step based on zoom level and fps */
export function getRulerTickStep(fps: number, pxPerFrame: number): {
  major: number;
  minor: number;
} {
  const candidates = [
    1,                        // 1 frame
    5,                        // 5 frames
    10,                       // 10 frames
    Math.round(fps),          // 1 second
    Math.round(fps * 5),      // 5 seconds
    Math.round(fps * 10),     // 10 seconds
    Math.round(fps * 30),     // 30 seconds
    Math.round(fps * 60),     // 1 minute
  ].filter((v, i, a) => v > 0 && a.indexOf(v) === i);

  const major = candidates.find((step) => step * pxPerFrame >= 96) ?? Math.round(fps * 120);
  const minor = Math.max(1, Math.round(major / 2));
  return { major, minor };
}
