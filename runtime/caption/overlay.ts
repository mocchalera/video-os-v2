/**
 * TextOverlay generation for titles, credits, and other authored text elements.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TextOverlay {
  overlay_id: string;
  timeline_in_frame: number;
  timeline_duration_frames: number;
  text: string;
  styling_class: string;
  writing_mode: "horizontal_tb" | "vertical_rl";
  anchor:
    | "top_left"
    | "top_center"
    | "top_right"
    | "center"
    | "bottom_left"
    | "bottom_center"
    | "bottom_right";
  safe_area?: { top: number; right: number; bottom: number; left: number };
  source: "authored";
}

export interface TextOverlayInput {
  overlay_id: string;
  timeline_in_frame: number;
  timeline_duration_frames: number;
  text: string;
  styling_class?: string;
  writing_mode?: "horizontal_tb" | "vertical_rl";
  anchor?:
    | "top_left"
    | "top_center"
    | "top_right"
    | "center"
    | "bottom_left"
    | "bottom_center"
    | "bottom_right";
  safe_area?: { top: number; right: number; bottom: number; left: number };
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_STYLING_CLASS = "title-card";
const DEFAULT_WRITING_MODE: TextOverlay["writing_mode"] = "horizontal_tb";
const DEFAULT_ANCHOR: TextOverlay["anchor"] = "bottom_center";

const VALID_WRITING_MODES = new Set<string>(["horizontal_tb", "vertical_rl"]);
const VALID_ANCHORS = new Set<string>([
  "top_left",
  "top_center",
  "top_right",
  "center",
  "bottom_left",
  "bottom_center",
  "bottom_right",
]);

// ---------------------------------------------------------------------------
// Build overlays from input
// ---------------------------------------------------------------------------

/**
 * Builds fully-resolved TextOverlay objects from partial input, applying
 * defaults for styling_class, writing_mode, and anchor.
 */
export function buildTextOverlays(inputs: TextOverlayInput[]): TextOverlay[] {
  return inputs.map((input) => ({
    overlay_id: input.overlay_id,
    timeline_in_frame: input.timeline_in_frame,
    timeline_duration_frames: input.timeline_duration_frames,
    text: input.text,
    styling_class: input.styling_class ?? DEFAULT_STYLING_CLASS,
    writing_mode: input.writing_mode ?? DEFAULT_WRITING_MODE,
    anchor: input.anchor ?? DEFAULT_ANCHOR,
    ...(input.safe_area ? { safe_area: input.safe_area } : {}),
    source: "authored" as const,
  }));
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validates an array of TextOverlay objects, checking:
 * - valid writing_mode
 * - valid anchor
 * - positive duration (timeline_duration_frames > 0)
 * - non-empty text
 */
export function validateOverlays(
  overlays: TextOverlay[],
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  for (const overlay of overlays) {
    if (!VALID_WRITING_MODES.has(overlay.writing_mode)) {
      errors.push(
        `Overlay ${overlay.overlay_id}: invalid writing_mode "${overlay.writing_mode}"`,
      );
    }

    if (!VALID_ANCHORS.has(overlay.anchor)) {
      errors.push(
        `Overlay ${overlay.overlay_id}: invalid anchor "${overlay.anchor}"`,
      );
    }

    if (overlay.timeline_duration_frames <= 0) {
      errors.push(
        `Overlay ${overlay.overlay_id}: duration must be positive, got ${overlay.timeline_duration_frames}`,
      );
    }

    if (!overlay.text || overlay.text.trim().length === 0) {
      errors.push(
        `Overlay ${overlay.overlay_id}: text must not be empty`,
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
