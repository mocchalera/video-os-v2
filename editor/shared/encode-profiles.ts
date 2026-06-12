/**
 * Shared x264 encode profiles for the preview/final parity contract
 * (editor-preview-render-parity-design.md §6.1, §11.2).
 *
 * The parity guarantee requires that preview and final differ ONLY in the
 * delivery encode. That only holds when every intermediate generation
 * (per-clip segment encodes, transition composites) is near-lossless AND
 * uses identical encoder settings on both paths — otherwise cross-path
 * SSIM degrades with each lossy generation.
 *
 * Used by editor/server/services/preview-job-service.ts and
 * runtime/render/assembler.ts. Change both consumers together.
 */

export interface X264Profile {
  preset: string;
  crf: number;
}

/**
 * Near-lossless intermediate generation (segments, gaps, transition
 * composites). crf 14 is visually transparent; veryfast keeps clip-level
 * encodes cheap without the quality cliff of ultrafast.
 */
export const INTERMEDIATE_X264: X264Profile = {
  preset: "veryfast",
  crf: 14,
};

/** Args fragment for ffmpeg: ["-c:v", "libx264", "-preset", ..., "-crf", ...] */
export function x264Args(profile: X264Profile): string[] {
  return ["-c:v", "libx264", "-preset", profile.preset, "-crf", String(profile.crf)];
}
