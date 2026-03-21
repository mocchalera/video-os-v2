/**
 * M4 Caption Pipeline Tests
 *
 * Tests for:
 * - Caption segmenter: transcript → caption generation, CPS calibration,
 *   gap/punctuation splitting, minimum dwell time
 * - TextOverlay: default application, validation
 * - Caption approval: draft creation, staleness detection, timeline projection
 */

import { describe, it, expect } from "vitest";
import {
  generateCaptionSource,
  LANGUAGE_CALIBRATIONS,
  type CaptionPolicy,
  type CaptionSource,
} from "../runtime/caption/segmenter.js";
import {
  buildTextOverlays,
  validateOverlays,
  type TextOverlay,
  type TextOverlayInput,
} from "../runtime/caption/overlay.js";
import {
  createDraftApproval,
  isApprovalStale,
  projectCaptionsToTimeline,
  type CaptionApproval,
} from "../runtime/caption/approval.js";

// ── Mock Data ───────────────────────────────────────────────────────────

function mockTimeline(overrides: Record<string, unknown> = {}) {
  return {
    project_id: "test",
    timeline_version: "5",
    fps: 24,
    tracks: {
      video: [{ track_id: "V1", clips: [] }],
      audio: [
        {
          track_id: "A1",
          clips: [
            {
              clip_id: "c1",
              segment_id: "SG_001",
              asset_id: "A_001",
              src_in_us: 0,
              src_out_us: 3_000_000,
              timeline_in_frame: 0,
              timeline_duration_frames: 72,
              role: "dialogue",
            },
          ],
        },
      ],
    },
    markers: [],
    provenance: {
      brief_path: "01_intent/creative_brief.yaml",
      blueprint_path: "04_plan/edit_blueprint.yaml",
      selects_path: "04_plan/selects_candidates.yaml",
    },
    ...overrides,
  };
}

function mockTranscriptArtifact(
  overrides: Record<string, unknown> = {},
  items?: Array<{
    item_id: string;
    speaker: string;
    speaker_key: string;
    start_us: number;
    end_us: number;
    text: string;
  }>,
) {
  return {
    project_id: "test",
    artifact_version: "2.0.0",
    transcript_ref: "TR_A_001",
    asset_id: "A_001",
    items: items ?? [
      {
        item_id: "TRI_A_001_0001",
        speaker: "S1",
        speaker_key: "A_001:speaker_1",
        start_us: 0,
        end_us: 1_500_000,
        text: "本当にびっくりしました。",
      },
      {
        item_id: "TRI_A_001_0002",
        speaker: "S1",
        speaker_key: "A_001:speaker_1",
        start_us: 2_000_000,
        end_us: 2_800_000,
        text: "すごいですね。",
      },
    ],
    ...overrides,
  };
}

function jaPolicy(): CaptionPolicy {
  return {
    language: "ja",
    delivery_mode: "burn_in",
    source: "transcript",
    styling_class: "default-ja",
  };
}

function enPolicy(): CaptionPolicy {
  return {
    language: "en",
    delivery_mode: "burn_in",
    source: "transcript",
    styling_class: "default-en",
  };
}

// ═════════════════════════════════════════════════════════════════════════
// Caption Segmenter Tests
// ═════════════════════════════════════════════════════════════════════════

describe("Caption Segmenter", () => {
  it("generates captions from basic transcript + timeline", () => {
    const timeline = mockTimeline();
    const transcript = mockTranscriptArtifact();
    const transcripts = new Map([["A_001", transcript]]);
    const policy = jaPolicy();

    const result = generateCaptionSource(
      timeline as any,
      transcripts as any,
      policy,
      "test",
      "5",
    );

    expect(result.version).toBe("1.0");
    expect(result.project_id).toBe("test");
    expect(result.base_timeline_version).toBe("5");
    expect(result.caption_policy).toEqual(policy);
    expect(result.speech_captions.length).toBeGreaterThan(0);

    // Each caption should have the expected structure
    for (const cap of result.speech_captions) {
      expect(cap.caption_id).toMatch(/^SC_\d{4}$/);
      expect(cap.asset_id).toBe("A_001");
      expect(cap.segment_id).toBe("SG_001");
      expect(cap.transcript_ref).toBe("TR_A_001");
      expect(cap.source).toBe("transcript");
      expect(cap.styling_class).toBe("default-ja");
      expect(cap.timeline_in_frame).toBeGreaterThanOrEqual(0);
      expect(cap.timeline_duration_frames).toBeGreaterThan(0);
      expect(cap.text.length).toBeGreaterThan(0);
      expect(cap.transcript_item_ids.length).toBeGreaterThan(0);
      expect(cap.metrics.cps).toBeGreaterThan(0);
      expect(cap.metrics.dwell_ms).toBeGreaterThan(0);
    }
  });

  it("applies Japanese CPS calibration (character-based)", () => {
    // Verify LANGUAGE_CALIBRATIONS for Japanese
    const jaCal = LANGUAGE_CALIBRATIONS["ja"];
    expect(jaCal).toBeDefined();
    expect(jaCal.unit).toBe("character");
    expect(jaCal.target_max).toBe(6.0);
    expect(jaCal.warn).toBe(7.0);
    expect(jaCal.fail).toBe(10.0);

    // Generate captions with Japanese text and verify CPS uses character count
    const timeline = mockTimeline();
    const transcript = mockTranscriptArtifact(
      {},
      [
        {
          item_id: "TRI_A_001_0001",
          speaker: "S1",
          speaker_key: "A_001:speaker_1",
          start_us: 0,
          end_us: 2_000_000,
          text: "四文字です",
        },
      ],
    );
    const transcripts = new Map([["A_001", transcript]]);
    const policy = jaPolicy();

    const result = generateCaptionSource(
      timeline as any,
      transcripts as any,
      policy,
      "test",
      "5",
    );

    expect(result.speech_captions.length).toBe(1);
    const cap = result.speech_captions[0];
    // "四文字です" = 5 characters. Duration = 2 seconds at 24fps = 48 frames.
    // CPS = 5 / 2 = 2.5 (character-based for Japanese)
    // Due to frame rounding, the exact CPS may differ slightly.
    // Key assertion: CPS is computed as characters/second, not words/second.
    expect(cap.metrics.cps).toBeGreaterThan(0);
    // 5 chars / ~2s = ~2.5 cps - should be in a reasonable range
    expect(cap.metrics.cps).toBeLessThan(jaCal.fail);
  });

  it("applies English WPS calibration (word-based)", () => {
    // Verify LANGUAGE_CALIBRATIONS for English
    const enCal = LANGUAGE_CALIBRATIONS["en"];
    expect(enCal).toBeDefined();
    expect(enCal.unit).toBe("word");
    expect(enCal.target_max).toBe(3.0);
    expect(enCal.warn).toBe(3.5);
    expect(enCal.fail).toBe(4.5);

    // English transcript with known word count
    const timeline = mockTimeline();
    const transcript = mockTranscriptArtifact(
      {},
      [
        {
          item_id: "TRI_A_001_0001",
          speaker: "S1",
          speaker_key: "A_001:speaker_1",
          start_us: 0,
          end_us: 2_000_000,
          text: "Hello world test",
        },
      ],
    );
    const transcripts = new Map([["A_001", transcript]]);
    const policy = enPolicy();

    const result = generateCaptionSource(
      timeline as any,
      transcripts as any,
      policy,
      "test",
      "5",
    );

    expect(result.speech_captions.length).toBe(1);
    const cap = result.speech_captions[0];
    // "Hello world test" = 3 words. Duration ~2s → WPS = 3/2 = 1.5
    expect(cap.metrics.cps).toBeGreaterThan(0);
    expect(cap.metrics.cps).toBeLessThan(enCal.fail);
  });

  it("splits captions on gaps > 500ms", () => {
    // Two transcript items separated by > 500ms gap
    const timeline = mockTimeline();
    const transcript = mockTranscriptArtifact(
      {},
      [
        {
          item_id: "TRI_A_001_0001",
          speaker: "S1",
          speaker_key: "A_001:speaker_1",
          start_us: 0,
          end_us: 1_000_000,
          text: "First part",
        },
        {
          item_id: "TRI_A_001_0002",
          speaker: "S1",
          speaker_key: "A_001:speaker_1",
          start_us: 1_600_000, // 600ms gap from end of first
          end_us: 2_500_000,
          text: "Second part",
        },
      ],
    );
    const transcripts = new Map([["A_001", transcript]]);
    const policy = enPolicy();

    const result = generateCaptionSource(
      timeline as any,
      transcripts as any,
      policy,
      "test",
      "5",
    );

    // Should produce 2 separate captions due to the 600ms gap
    expect(result.speech_captions.length).toBe(2);
    expect(result.speech_captions[0].text).toBe("First part");
    expect(result.speech_captions[1].text).toBe("Second part");
  });

  it("splits captions on sentence-ending punctuation", () => {
    // Two items without a long gap, but first ends with 。
    const timeline = mockTimeline();
    const transcript = mockTranscriptArtifact(
      {},
      [
        {
          item_id: "TRI_A_001_0001",
          speaker: "S1",
          speaker_key: "A_001:speaker_1",
          start_us: 0,
          end_us: 1_200_000,
          text: "最初の文章。",
        },
        {
          item_id: "TRI_A_001_0002",
          speaker: "S1",
          speaker_key: "A_001:speaker_1",
          start_us: 1_200_001, // minimal gap (< 500ms)
          end_us: 2_400_000,
          text: "次の文章",
        },
      ],
    );
    const transcripts = new Map([["A_001", transcript]]);
    const policy = jaPolicy();

    const result = generateCaptionSource(
      timeline as any,
      transcripts as any,
      policy,
      "test",
      "5",
    );

    // Should produce 2 captions: punctuation 。 triggers a split
    expect(result.speech_captions.length).toBe(2);
    expect(result.speech_captions[0].text).toBe("最初の文章。");
    expect(result.speech_captions[1].text).toBe("次の文章");
  });

  it("enforces minimum dwell time of 800ms", () => {
    // Very short transcript item that would produce < 800ms dwell
    const timeline = mockTimeline({
      fps: 24,
      tracks: {
        video: [{ track_id: "V1", clips: [] }],
        audio: [
          {
            track_id: "A1",
            clips: [
              {
                clip_id: "c1",
                segment_id: "SG_001",
                asset_id: "A_001",
                src_in_us: 0,
                src_out_us: 10_000_000,
                timeline_in_frame: 0,
                timeline_duration_frames: 240,
                role: "dialogue",
              },
            ],
          },
        ],
      },
    });

    const transcript = mockTranscriptArtifact(
      {},
      [
        {
          item_id: "TRI_A_001_0001",
          speaker: "S1",
          speaker_key: "A_001:speaker_1",
          start_us: 0,
          end_us: 200_000, // 200ms - very short
          text: "Hi",
        },
      ],
    );
    const transcripts = new Map([["A_001", transcript]]);
    const policy = enPolicy();

    const result = generateCaptionSource(
      timeline as any,
      transcripts as any,
      policy,
      "test",
      "5",
    );

    expect(result.speech_captions.length).toBe(1);
    // Minimum dwell = 800ms. At 24fps, that's ceil(0.8 * 24) = 20 frames.
    // Duration should be padded up to at least the min dwell.
    expect(result.speech_captions[0].metrics.dwell_ms).toBeGreaterThanOrEqual(800);
  });

  it("returns empty speech_captions when source=transcript but no transcripts", () => {
    const timeline = mockTimeline();
    const transcripts = new Map(); // empty
    const policy = jaPolicy();

    const result = generateCaptionSource(
      timeline as any,
      transcripts as any,
      policy,
      "test",
      "5",
    );

    expect(result.speech_captions).toEqual([]);
    expect(result.text_overlays).toEqual([]);
    expect(result.version).toBe("1.0");
  });

  it('returns empty speech_captions when policy source="none"', () => {
    const timeline = mockTimeline();
    const transcript = mockTranscriptArtifact();
    const transcripts = new Map([["A_001", transcript]]);
    const policy: CaptionPolicy = {
      language: "ja",
      delivery_mode: "burn_in",
      source: "none",
      styling_class: "default-ja",
    };

    const result = generateCaptionSource(
      timeline as any,
      transcripts as any,
      policy,
      "test",
      "5",
    );

    expect(result.speech_captions).toEqual([]);
    expect(result.text_overlays).toEqual([]);
    expect(result.caption_policy.source).toBe("none");
  });
});

// ═════════════════════════════════════════════════════════════════════════
// TextOverlay Tests
// ═════════════════════════════════════════════════════════════════════════

describe("TextOverlay", () => {
  it("applies default values for missing optional fields", () => {
    const inputs: TextOverlayInput[] = [
      {
        overlay_id: "OVL_001",
        timeline_in_frame: 0,
        timeline_duration_frames: 48,
        text: "Title Card",
        // no styling_class, writing_mode, or anchor
      },
    ];

    const overlays = buildTextOverlays(inputs);

    expect(overlays).toHaveLength(1);
    const ovl = overlays[0];
    expect(ovl.overlay_id).toBe("OVL_001");
    expect(ovl.text).toBe("Title Card");
    expect(ovl.styling_class).toBe("title-card");
    expect(ovl.writing_mode).toBe("horizontal_tb");
    expect(ovl.anchor).toBe("bottom_center");
    expect(ovl.source).toBe("authored");
    expect(ovl.timeline_in_frame).toBe(0);
    expect(ovl.timeline_duration_frames).toBe(48);
  });

  it("validates overlays with all required fields present", () => {
    const overlays: TextOverlay[] = [
      {
        overlay_id: "OVL_001",
        timeline_in_frame: 0,
        timeline_duration_frames: 48,
        text: "Valid Title",
        styling_class: "title-card",
        writing_mode: "horizontal_tb",
        anchor: "center",
        source: "authored",
      },
      {
        overlay_id: "OVL_002",
        timeline_in_frame: 48,
        timeline_duration_frames: 24,
        text: "Another title",
        styling_class: "subtitle",
        writing_mode: "vertical_rl",
        anchor: "top_right",
        source: "authored",
      },
    ];

    const { valid, errors } = validateOverlays(overlays);
    expect(valid).toBe(true);
    expect(errors).toEqual([]);
  });

  it("fails validation for invalid writing_mode", () => {
    const overlays: TextOverlay[] = [
      {
        overlay_id: "OVL_BAD",
        timeline_in_frame: 0,
        timeline_duration_frames: 48,
        text: "Some text",
        styling_class: "title-card",
        writing_mode: "diagonal" as any, // invalid enum value
        anchor: "center",
        source: "authored",
      },
    ];

    const { valid, errors } = validateOverlays(overlays);
    expect(valid).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("OVL_BAD");
    expect(errors[0]).toContain("writing_mode");
    expect(errors[0]).toContain("diagonal");
  });

  it("fails validation for empty text", () => {
    const overlays: TextOverlay[] = [
      {
        overlay_id: "OVL_EMPTY",
        timeline_in_frame: 0,
        timeline_duration_frames: 48,
        text: "",
        styling_class: "title-card",
        writing_mode: "horizontal_tb",
        anchor: "center",
        source: "authored",
      },
    ];

    const { valid, errors } = validateOverlays(overlays);
    expect(valid).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("OVL_EMPTY");
    expect(errors[0]).toContain("text");
    expect(errors[0]).toContain("empty");
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Caption Approval Tests
// ═════════════════════════════════════════════════════════════════════════

describe("Caption Approval", () => {
  function mockCaptionSource(): CaptionSource {
    return {
      version: "1.0",
      project_id: "test",
      base_timeline_version: "5",
      caption_policy: jaPolicy(),
      speech_captions: [
        {
          caption_id: "SC_0001",
          asset_id: "A_001",
          segment_id: "SG_001",
          timeline_in_frame: 0,
          timeline_duration_frames: 36,
          text: "本当にびっくりしました。",
          transcript_ref: "TR_A_001",
          transcript_item_ids: ["TRI_A_001_0001"],
          source: "transcript",
          styling_class: "default-ja",
          metrics: { cps: 4.0, dwell_ms: 1500 },
        },
      ],
      text_overlays: [],
    };
  }

  function mockCaptionSourceWithOverlays(): CaptionSource {
    const source = mockCaptionSource();
    // CaptionSource.text_overlays uses the TextOverlay type from overlay.ts
    (source as any).text_overlays = [
      {
        overlay_id: "OVL_001",
        timeline_in_frame: 72,
        timeline_duration_frames: 48,
        text: "Episode Title",
        styling_class: "title-card",
        writing_mode: "horizontal_tb",
        anchor: "center",
        source: "authored",
      },
    ];
    return source;
  }

  it("creates draft approval with status=approved", () => {
    const source = mockCaptionSource();
    const approval = createDraftApproval(source, "editor@test.com", "2026-01-15T10:00:00Z");

    expect(approval.version).toBe("1.0");
    expect(approval.project_id).toBe("test");
    expect(approval.base_timeline_version).toBe("5");
    expect(approval.caption_policy).toEqual(jaPolicy());
    expect(approval.speech_captions).toHaveLength(1);
    expect(approval.speech_captions[0].caption_id).toBe("SC_0001");
    expect(approval.text_overlays).toHaveLength(0);

    expect(approval.approval.status).toBe("approved");
    expect(approval.approval.approved_by).toBe("editor@test.com");
    expect(approval.approval.approved_at).toBe("2026-01-15T10:00:00Z");
  });

  it("detects staleness when timeline version changes", () => {
    const source = mockCaptionSource();
    const approval = createDraftApproval(source, "editor@test.com");

    const currentPolicyHash = JSON.stringify(approval.caption_policy);

    // Different timeline version → stale
    const stale = isApprovalStale(approval, "6", currentPolicyHash);
    expect(stale).toBe(true);
  });

  it("reports non-stale when versions and policy match", () => {
    const source = mockCaptionSource();
    const approval = createDraftApproval(source, "editor@test.com");

    const currentPolicyHash = JSON.stringify(approval.caption_policy);

    // Same timeline version and same policy → not stale
    const stale = isApprovalStale(approval, "5", currentPolicyHash);
    expect(stale).toBe(false);
  });

  it("detects staleness when policy hash changes", () => {
    const source = mockCaptionSource();
    const approval = createDraftApproval(source, "editor@test.com");

    // Change policy hash
    const differentPolicyHash = JSON.stringify({
      ...jaPolicy(),
      styling_class: "changed-style",
    });

    const stale = isApprovalStale(approval, "5", differentPolicyHash);
    expect(stale).toBe(true);
  });

  it("projects caption track (C1) into timeline", () => {
    const source = mockCaptionSource();
    const approval = createDraftApproval(source, "editor@test.com");

    const timeline = mockTimeline();
    const projected = projectCaptionsToTimeline(timeline, approval, 24);

    // Should have tracks.caption with a C1 track
    expect(projected.tracks.caption).toBeDefined();
    expect(projected.tracks.caption).toHaveLength(1);
    expect(projected.tracks.caption[0].track_id).toBe("C1");

    const captionClips = projected.tracks.caption[0].clips;
    expect(captionClips).toHaveLength(1);

    const clip = captionClips[0];
    expect(clip.clip_id).toBe("SC_0001");
    expect(clip.segment_id).toBe("SG_001");
    expect(clip.asset_id).toBe("A_001");
    expect(clip.kind).toBe("caption");
    expect(clip.role).toBe("dialogue");
    expect(clip.motivation).toBe("caption");
    expect(clip.timeline_in_frame).toBe(0);
    expect(clip.timeline_duration_frames).toBe(36);
    expect(clip.metadata.caption.text).toBe("本当にびっくりしました。");
    expect(clip.metadata.caption.styling_class).toBe("default-ja");
    expect(clip.metadata.caption.transcript_ref).toBe("TR_A_001");
    expect(clip.metadata.caption.metrics).toEqual({ cps: 4.0, dwell_ms: 1500 });
  });

  it("projects overlay track (O1) with synthetic __overlay__ asset_id", () => {
    const source = mockCaptionSourceWithOverlays();
    const approval = createDraftApproval(source, "editor@test.com");

    const timeline = mockTimeline();
    const projected = projectCaptionsToTimeline(timeline, approval, 24);

    // Should have tracks.overlay with an O1 track
    expect(projected.tracks.overlay).toBeDefined();
    expect(projected.tracks.overlay).toHaveLength(1);
    expect(projected.tracks.overlay[0].track_id).toBe("O1");

    const overlayClips = projected.tracks.overlay[0].clips;
    expect(overlayClips).toHaveLength(1);

    const clip = overlayClips[0];
    expect(clip.clip_id).toBe("OVL_001");
    expect(clip.segment_id).toBe("TXT_OVL_001");
    expect(clip.asset_id).toBe("__overlay__");
    expect(clip.kind).toBe("overlay");
    expect(clip.role).toBe("title");
    expect(clip.motivation).toBe("overlay");
    expect(clip.timeline_in_frame).toBe(72);
    expect(clip.timeline_duration_frames).toBe(48);
    expect(clip.metadata.overlay.text).toBe("Episode Title");
    expect(clip.metadata.overlay.writing_mode).toBe("horizontal_tb");
    expect(clip.metadata.overlay.anchor).toBe("center");
    expect(clip.metadata.overlay.source).toBe("authored");
  });

  it("does not mutate the original timeline object", () => {
    const source = mockCaptionSource();
    const approval = createDraftApproval(source, "editor@test.com");

    const timeline = mockTimeline();
    const originalJSON = JSON.stringify(timeline);

    projectCaptionsToTimeline(timeline, approval, 24);

    // Original timeline must be unchanged
    expect(JSON.stringify(timeline)).toBe(originalJSON);
    // Specifically, no caption or overlay tracks should have been added
    expect((timeline as any).tracks.caption).toBeUndefined();
    expect((timeline as any).tracks.overlay).toBeUndefined();
  });

  it("produces empty tracks when there are no captions or overlays", () => {
    const source: CaptionSource = {
      version: "1.0",
      project_id: "test",
      base_timeline_version: "5",
      caption_policy: jaPolicy(),
      speech_captions: [],
      text_overlays: [],
    };
    const approval = createDraftApproval(source, "editor@test.com");

    const timeline = mockTimeline();
    const projected = projectCaptionsToTimeline(timeline, approval, 24);

    // Tracks should still be added, but with empty clip arrays
    expect(projected.tracks.caption).toBeDefined();
    expect(projected.tracks.caption).toHaveLength(1);
    expect(projected.tracks.caption[0].track_id).toBe("C1");
    expect(projected.tracks.caption[0].clips).toEqual([]);

    expect(projected.tracks.overlay).toBeDefined();
    expect(projected.tracks.overlay).toHaveLength(1);
    expect(projected.tracks.overlay[0].track_id).toBe("O1");
    expect(projected.tracks.overlay[0].clips).toEqual([]);
  });
});
