import { describe, expect, it } from "vitest";
import {
  buildTimelineOffsetMap,
  projectSourceRange,
  rational,
  roundRational,
} from "../runtime/compiler/timeline-offset-engine.js";
import { applyCaptionWordTiming } from "../runtime/commands/caption.js";
import type { CaptionDraft } from "../runtime/caption/editorial.js";
import { generateCaptionSource } from "../runtime/caption/segmenter.js";
import type { TranscriptArtifact } from "../runtime/caption/segmenter.js";
import { validateAgainstSchema } from "../runtime/commands/shared.js";

describe("Timeline Offset Engine", () => {
  it("uses A1 as the caption authority for J/L placement", () => {
    const map = buildTimelineOffsetMap({
      fps_num: 30,
      clips: [
        { clip_id: "V1-1", asset_id: "asset", segment_id: "seg", src_in_us: 0, src_out_us: 1_000_000, timeline_in_frame: 0, timeline_duration_frames: 30, track_id: "V1", track_kind: "video" },
        { clip_id: "A1-1", asset_id: "asset", segment_id: "seg", src_in_us: 0, src_out_us: 1_000_000, timeline_in_frame: 12, timeline_duration_frames: 30, track_id: "A1", track_kind: "audio" },
      ],
    });
    const projection = projectSourceRange(map, {
      asset_id: "asset",
      segment_id: "seg",
      source_start_us: 500_000,
      source_end_us: 700_000,
    });
    expect(projection.authority).toBe("A1");
    expect(projection.timeline_in_frame).toBe(27);
    expect(projection.clip_map_refs).toEqual(["A1-1"]);
  });

  it("maps speed, preserves gaps, and rounds only at the frame boundary", () => {
    const map = buildTimelineOffsetMap({
      fps_num: 30,
      fps_den: 1,
      clips: [
        { clip_id: "A1-1", asset_id: "asset", segment_id: "seg", src_in_us: 0, src_out_us: 500_000, timeline_in_frame: 0, timeline_duration_frames: 15, track_id: "A1", speed: 2 },
        { clip_id: "A1-2", asset_id: "asset", segment_id: "seg", src_in_us: 500_000, src_out_us: 1_000_000, timeline_in_frame: 25, timeline_duration_frames: 15, track_id: "A1", speed: 1 },
      ],
    });
    const projection = projectSourceRange(map, { asset_id: "asset", segment_id: "seg", source_start_us: 0, source_end_us: 1_000_000 });
    expect(projection.segments.map((segment) => segment.timeline_start_frame)).toEqual([0, 25]);
    expect(projection.timeline_duration_frames).toBe(8);
    expect(projection.status).toBe("blocked");
    expect(projection.occurrence_refs).toEqual(["A1-1", "A1-2"]);
    expect(projection.fallback_reason).toContain("separated timeline occurrences");
    expect(roundRational(rational(30000, 1001))).toBe(30n);
  });

  it("clamps source projection to each canonical clip duration", () => {
    const map = buildTimelineOffsetMap({
      fps_num: 30,
      clips: [{ clip_id: "A1-short", asset_id: "asset", segment_id: "seg", src_in_us: 0, src_out_us: 1_000_000, timeline_in_frame: 12, timeline_duration_frames: 10, track_id: "A1" }],
    });
    const projection = projectSourceRange(map, { asset_id: "asset", segment_id: "seg", source_start_us: 0, source_end_us: 1_000_000 });
    expect(projection.timeline_in_frame).toBe(12);
    expect(projection.timeline_duration_frames).toBe(10);
    expect(projection.segments[0]).toMatchObject({ occurrence_id: "A1-short", timeline_start_frame: 12, timeline_end_frame: 22 });
  });

  it("fails closed for missing source evidence without changing timeline truth", () => {
    const map = buildTimelineOffsetMap({ fps_num: 24, clips: [] });
    const projection = projectSourceRange(map, { asset_id: "missing", source_start_us: 0, source_end_us: 100_000 });
    expect(projection.status).toBe("fallback");
    expect(projection.confidence).toBe(0.25);
    expect(projection.clip_map_refs).toEqual([]);
    expect(map.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("wires the command word-remap path to the same A1 offset map", () => {
    const timeline = {
      sequence: { fps_num: 30, fps_den: 1 },
      tracks: {
        video: [{ track_id: "V1", kind: "video", clips: [{ clip_id: "V1-1", asset_id: "asset", segment_id: "seg", src_in_us: 0, src_out_us: 1_000_000, timeline_in_frame: 0, timeline_duration_frames: 30 }] }],
        audio: [{ track_id: "A1", kind: "audio", clips: [{ clip_id: "A1-1", asset_id: "asset", segment_id: "seg", src_in_us: 0, src_out_us: 1_000_000, timeline_in_frame: 12, timeline_duration_frames: 30 }] }],
      },
    };
    const draft: CaptionDraft = {
      version: "1.0",
      project_id: "p",
      base_timeline_version: "1",
      caption_policy: { language: "ja", delivery_mode: "both", source: "transcript", styling_class: "clean-lower-third" },
      speech_captions: [{
        caption_id: "SC_0001", asset_id: "asset", segment_id: "seg", timeline_in_frame: 12,
        timeline_duration_frames: 10, text: "答え", transcript_ref: "TR", transcript_item_ids: ["item"],
        source: "transcript", styling_class: "clean-lower-third", metrics: { cps: 1, dwell_ms: 333 },
      }],
      text_overlays: [], draft_status: "ready_for_human_approval", degraded_count: 0,
    };
    const transcript: TranscriptArtifact = {
      project_id: "p", artifact_version: "1", transcript_ref: "TR", asset_id: "asset",
      items: [{ item_id: "item", speaker: "S1", speaker_key: "S1", start_us: 500_000, end_us: 700_000, text: "答え", words: [{ word: "答え", start_us: 500_000, end_us: 700_000 }], word_timing_mode: "word" }],
    };
    const result = applyCaptionWordTiming(draft, draft.caption_policy, timeline as never, new Map([["asset", transcript]]));
    expect(result.speech_captions[0]).toMatchObject({ timeline_in_frame: 27, timing: {
      authority: "A1", source: "word_remap", triggeredFallback: false,
    } });
    expect(result.speech_captions[0].timing?.offsetMapFingerprint).toMatch(/^sha256:/);
  });

  it("keeps stable source roots when a preceding caption is inserted", () => {
    const policy = { language: "ja", delivery_mode: "burn_in" as const, source: "transcript" as const, styling_class: "default" };
    const transcript: TranscriptArtifact = {
      project_id: "p", artifact_version: "1", transcript_ref: "TR-existing", asset_id: "existing",
      items: [{ item_id: "item-existing", speaker: "S1", speaker_key: "S1", start_us: 0, end_us: 400_000, text: "既存字幕" }],
    };
    const baseTimeline = {
      sequence: { fps_num: 30, fps_den: 1 },
      tracks: { video: [], audio: [{ track_id: "A1", kind: "audio", clips: [{ clip_id: "existing-clip", asset_id: "existing", segment_id: "existing-seg", src_in_us: 0, src_out_us: 1_000_000, timeline_in_frame: 30, timeline_duration_frames: 30, role: "dialogue" }] }] },
    };
    const withPreceding = {
      ...baseTimeline,
      tracks: { ...baseTimeline.tracks, audio: [{ track_id: "A1", kind: "audio", clips: [
        { clip_id: "preceding-clip", asset_id: "preceding", segment_id: "preceding-seg", src_in_us: 0, src_out_us: 1_000_000, timeline_in_frame: 0, timeline_duration_frames: 30, role: "dialogue" },
        baseTimeline.tracks.audio[0].clips[0],
      ] }] },
    };
    const precedingTranscript: TranscriptArtifact = {
      project_id: "p", artifact_version: "1", transcript_ref: "TR-preceding", asset_id: "preceding",
      items: [{ item_id: "item-preceding", speaker: "S1", speaker_key: "S1", start_us: 0, end_us: 400_000, text: "先行字幕" }],
    };
    const transcripts = new Map([["existing", transcript], ["preceding", precedingTranscript]]);
    const first = generateCaptionSource(baseTimeline as never, transcripts, policy, "p", "1", {
      timelineOffsetMap: buildTimelineOffsetMap({ fps_num: 30, clips: [{ ...baseTimeline.tracks.audio[0].clips[0], track_id: "A1", track_kind: "audio" }] }),
    });
    const second = generateCaptionSource(withPreceding as never, transcripts, policy, "p", "1", {
      timelineOffsetMap: buildTimelineOffsetMap({ fps_num: 30, clips: [
        { ...withPreceding.tracks.audio[0].clips[0], track_id: "A1", track_kind: "audio" },
        { ...withPreceding.tracks.audio[0].clips[1], track_id: "A1", track_kind: "audio" },
      ] }),
    });
    const firstExisting = first.speech_captions.find((caption) => caption.asset_id === "existing")!;
    const secondExisting = second.speech_captions.find((caption) => caption.asset_id === "existing")!;
    expect(firstExisting.root_id).toBe(secondExisting.root_id);
    expect(firstExisting.lineage_hash).toBe(secondExisting.lineage_hash);
    expect(firstExisting.caption_id).not.toBe(secondExisting.caption_id);
  });

  it("blocks a clamped projection that rounds to a non-positive frame range", () => {
    const map = buildTimelineOffsetMap({
      fps_num: 30,
      clips: [{ clip_id: "A1-ten", asset_id: "asset", segment_id: "seg", src_in_us: 0, src_out_us: 1_000_000, timeline_in_frame: 12, timeline_duration_frames: 10, track_id: "A1" }],
    });
    const projection = projectSourceRange(map, {
      asset_id: "asset",
      segment_id: "seg",
      source_start_us: 999_000,
      source_end_us: 1_000_000,
    });
    expect(projection.status).toBe("blocked");
    expect(projection.timeline_duration_frames).toBe(0);
    expect(projection.fallback_reason).toContain("non-positive frame range");
  });

  it("does not concatenate adjacent distinct occurrences with no timeline gap", () => {
    const map = buildTimelineOffsetMap({
      fps_num: 30,
      clips: [
        { clip_id: "A1-occurrence-1", asset_id: "asset", segment_id: "seg", src_in_us: 0, src_out_us: 500_000, timeline_in_frame: 0, timeline_duration_frames: 6, track_id: "A1" },
        { clip_id: "A1-occurrence-2", asset_id: "asset", segment_id: "seg", src_in_us: 500_000, src_out_us: 1_000_000, timeline_in_frame: 6, timeline_duration_frames: 6, track_id: "A1" },
      ],
    });
    const projection = projectSourceRange(map, {
      asset_id: "asset",
      segment_id: "seg",
      source_start_us: 0,
      source_end_us: 1_000_000,
    });
    expect(projection.status).toBe("blocked");
    expect(projection.timeline_duration_frames).toBe(6);
    expect(projection.occurrence_refs).toEqual(["A1-occurrence-1", "A1-occurrence-2"]);
    expect(projection.fallback_reason).toContain("distinct timeline occurrences");
  });

  it("validates v2 caption timing provenance while preserving the v1 branch", () => {
    const timing = {
      source: "offset_map",
      confidence: 1,
      triggeredFallback: false,
      timelineInFrame: 12,
      timelineDurationFrames: 10,
      offsetMapFingerprint: "sha256:" + "a".repeat(64),
      authority: "A1",
    };
    const draft = {
      version: "caption-draft/v2",
      project_id: "p",
      base_timeline_version: "1",
      caption_policy: { language: "ja", delivery_mode: "burn_in", source: "transcript", styling_class: "default" },
      speech_captions: [{
        caption_id: "SC_0001", root_id: "SC_stable", parent_ids: [], lineage_hash: "sha256:" + "b".repeat(64),
        asset_id: "asset", segment_id: "seg", timeline_in_frame: 12, timeline_duration_frames: 10,
        text: "字幕", transcript_ref: "TR", transcript_item_ids: ["item"], source: "transcript", styling_class: "default",
        metrics: { cps: 1, dwell_ms: 333 }, timing,
      }],
      text_overlays: [], draft_status: "ready_for_human_approval", degraded_count: 0,
    };
    expect(validateAgainstSchema(draft, "caption-draft.schema.json").valid).toBe(true);
    expect(validateAgainstSchema({ ...draft, speech_captions: [{ ...draft.speech_captions[0], timing: { ...timing, authority: "garbage" } }] }, "caption-draft.schema.json").valid).toBe(false);
    expect(validateAgainstSchema({
      ...draft,
      version: "1.0",
      speech_captions: [{ ...draft.speech_captions[0], timing: { arbitrary: "legacy" } }],
    }, "caption-draft.schema.json").valid).toBe(true);

    const report = {
      version: "caption-timing-report/v2", mode: "speech_sync", checked_caption_count: 1,
      protected_caption_count: 0, split_count: 0, adjusted_lead_count: 0,
      question_caption_count: 0, question_adjusted_count: 0, previous_speech_guard_count: 0,
      gap_tail_hold_count: 0, unresolved_count: 0, issues: [],
      offset_map_fingerprint: timing.offsetMapFingerprint, dialogue_authority: "A1",
    };
    expect(validateAgainstSchema(report, "caption-timing-report.schema.json").valid).toBe(true);
    expect(validateAgainstSchema({ ...report, offset_map_fingerprint: undefined }, "caption-timing-report.schema.json").valid).toBe(false);
    expect(validateAgainstSchema({ ...report, version: "caption-timing-report/v1", offset_map_fingerprint: undefined, dialogue_authority: undefined }, "caption-timing-report.schema.json").valid).toBe(true);

    const approval = {
      version: "caption-draft/v2",
      project_id: draft.project_id,
      base_timeline_version: draft.base_timeline_version,
      caption_policy: draft.caption_policy,
      speech_captions: draft.speech_captions,
      text_overlays: [],
      approval: { status: "approved" },
    };
    expect(validateAgainstSchema(approval, "caption-approval.schema.json").valid).toBe(true);
    expect(validateAgainstSchema({ ...approval, speech_captions: [{ ...draft.speech_captions[0], lineage_hash: "garbage" }] }, "caption-approval.schema.json").valid).toBe(false);
  });
});
