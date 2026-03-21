/**
 * 2-stage caption approval workflow: draft -> editorial approval.
 * Handles staleness detection and projection of approved captions
 * into timeline tracks.
 */

import type {
  CaptionPolicy,
  SpeechCaption,
  CaptionSource,
} from "./segmenter.js";
import type { TextOverlay } from "./overlay.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CaptionApproval {
  version: string;
  project_id: string;
  base_timeline_version: string;
  caption_policy: CaptionPolicy;
  speech_captions: SpeechCaption[];
  text_overlays: TextOverlay[];
  approval: {
    status: "approved" | "stale";
    approved_by?: string;
    approved_at?: string;
  };
}

// ---------------------------------------------------------------------------
// Draft creation
// ---------------------------------------------------------------------------

/**
 * Creates a draft approval from a CaptionSource. Stamps the approval with
 * the given `approvedBy` identity and optional timestamp (defaults to now).
 */
export function createDraftApproval(
  source: CaptionSource,
  approvedBy: string,
  approvedAt?: string,
): CaptionApproval {
  return {
    version: source.version,
    project_id: source.project_id,
    base_timeline_version: source.base_timeline_version,
    caption_policy: { ...source.caption_policy },
    speech_captions: source.speech_captions.map((sc) => ({ ...sc })),
    text_overlays: source.text_overlays.map((to) => ({ ...to })),
    approval: {
      status: "approved",
      approved_by: approvedBy,
      approved_at: approvedAt ?? new Date().toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// Staleness detection
// ---------------------------------------------------------------------------

/**
 * An approval becomes stale when the underlying timeline version or caption
 * policy has changed since the approval was created.
 *
 * @param approval        The existing approval record
 * @param currentTimelineVersion  Current editorial_timeline_hash / version
 * @param currentPolicyHash       Hash or serialised string of the current caption policy
 */
export function isApprovalStale(
  approval: CaptionApproval,
  currentTimelineVersion: string,
  currentPolicyHash: string,
): boolean {
  // Timeline version changed
  if (approval.base_timeline_version !== currentTimelineVersion) {
    return true;
  }

  // Policy changed (compare serialised policy against provided hash)
  const approvalPolicyHash = JSON.stringify(approval.caption_policy);
  if (approvalPolicyHash !== currentPolicyHash) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Timeline projection
// ---------------------------------------------------------------------------

/**
 * Projects approved captions and overlays into a timeline by adding
 * `tracks.caption` (C1) and `tracks.overlay` (O1) track entries.
 *
 * Returns a NEW timeline object - the input is not mutated.
 *
 * - SpeechCaption -> clip with kind:"caption", role:"dialogue",
 *   metadata.caption = { caption_id, text, styling_class, metrics, ... }
 * - TextOverlay -> clip with kind:"overlay", role:"title",
 *   asset_id:"__overlay__", segment_id:"TXT_<overlay_id>",
 *   src_in_us:0, src_out_us:<duration_us>, metadata.overlay = { ... }
 */
export function projectCaptionsToTimeline(
  timeline: any,
  approval: CaptionApproval,
  fps: number,
): any {
  // Deep clone the timeline to avoid mutation
  const result = JSON.parse(JSON.stringify(timeline));

  if (!result.tracks) {
    result.tracks = {};
  }

  // Build caption track (C1) from speech captions
  const captionClips = approval.speech_captions.map((sc) => {
    const durationUs = Math.round(
      (sc.timeline_duration_frames / fps) * 1_000_000,
    );

    return {
      clip_id: sc.caption_id,
      segment_id: sc.segment_id,
      asset_id: sc.asset_id,
      src_in_us: 0,
      src_out_us: durationUs,
      timeline_in_frame: sc.timeline_in_frame,
      timeline_duration_frames: sc.timeline_duration_frames,
      role: "dialogue",
      kind: "caption",
      motivation: "caption",
      confidence: 1.0,
      quality_flags: [],
      fallback_segment_ids: [],
      metadata: {
        caption: {
          caption_id: sc.caption_id,
          text: sc.text,
          styling_class: sc.styling_class,
          transcript_ref: sc.transcript_ref,
          transcript_item_ids: sc.transcript_item_ids,
          source: sc.source,
          metrics: sc.metrics,
        },
      },
    };
  });

  // Build overlay track (O1) from text overlays
  const overlayClips = approval.text_overlays.map((to) => {
    const durationUs = Math.round(
      (to.timeline_duration_frames / fps) * 1_000_000,
    );

    return {
      clip_id: to.overlay_id,
      segment_id: `TXT_${to.overlay_id}`,
      asset_id: "__overlay__",
      src_in_us: 0,
      src_out_us: durationUs,
      timeline_in_frame: to.timeline_in_frame,
      timeline_duration_frames: to.timeline_duration_frames,
      role: "title",
      kind: "overlay",
      motivation: "overlay",
      confidence: 1.0,
      quality_flags: [],
      fallback_segment_ids: [],
      metadata: {
        overlay: {
          overlay_id: to.overlay_id,
          text: to.text,
          styling_class: to.styling_class,
          writing_mode: to.writing_mode,
          anchor: to.anchor,
          ...(to.safe_area ? { safe_area: to.safe_area } : {}),
          source: to.source,
        },
      },
    };
  });

  // Add caption track (C1)
  if (!result.tracks.caption) {
    result.tracks.caption = [];
  }
  result.tracks.caption.push({
    track_id: "C1",
    clips: captionClips,
  });

  // Add overlay track (O1)
  if (!result.tracks.overlay) {
    result.tracks.overlay = [];
  }
  result.tracks.overlay.push({
    track_id: "O1",
    clips: overlayClips,
  });

  return result;
}
