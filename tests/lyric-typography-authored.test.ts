import { describe, expect, it } from "vitest";
import * as crypto from "node:crypto";
import type { CaptionApproval } from "../runtime/caption/approval.js";
import {
  hashLyricTypographyInput,
  planLyricTypography,
  resolveBottomCenterPosition,
  sanitizeLyricLine,
} from "../runtime/caption/lyric-typography.js";
import { loadApprovedAuthoredLyricLineInputs } from "../runtime/caption/lyric-delivery.js";
import { validateAgainstSchema } from "../runtime/commands/shared.js";

const HASH = (value: string) => `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;

function approvalFixture(): CaptionApproval {
  const lines = [
    { line_id: "AL_0001", line_number: 1, text: "長い夜の歌", text_sha256: HASH("1") },
    { line_id: "AL_0002", line_number: 2, text: "// 制作メモ", text_sha256: HASH("2") },
    { line_id: "AL_0003", line_number: 3, text: "（まだ歌う）", text_sha256: HASH("3") },
  ];
  const cues = lines.map((line, index) => ({
    cue_id: `AC_000${index + 1}`,
    line_id: line.line_id,
    line_number: line.line_number,
    status: "matched" as const,
    confidence: 1,
    source_kind: "direct_cue" as const,
    source_refs: [{ kind: "timing_plan_cue" as const, id: `T${index + 1}` }],
    raw_start_frame: index * 30,
    raw_end_frame: (index + 1) * 30,
    timeline_in_frame: index * 30,
    timeline_duration_frames: 30,
    one_frame_gap_applied: false,
    minimum_display_duration_applied: false,
    cps_before: 3,
    cps_after: 3,
  }));
  return {
    version: "caption-draft/v2",
    project_id: "authored-fixture",
    base_timeline_version: "1",
    caption_policy: { language: "ja", delivery_mode: "burn_in", source: "authored", styling_class: "default-ja" },
    speech_captions: lines.map((line, index) => ({
      caption_id: `SC_${line.line_id}`,
      asset_id: "__authored_lyrics__",
      segment_id: `LYRIC_${line.line_id}`,
      timeline_in_frame: index * 30,
      timeline_duration_frames: 30,
      text: line.text,
      transcript_ref: "authored:fixture",
      transcript_item_ids: [line.line_id],
      source: "authored" as const,
      styling_class: "default-ja",
      metrics: { cps: 3, dwell_ms: 1000 },
      line_id: line.line_id,
      cue_id: `AC_000${index + 1}`,
    })),
    text_overlays: [],
    text_authority: {
      authority: "authored",
      source_path: "01_intent/lyrics.txt",
      source_sha256: HASH("body"),
      source_hash: HASH("body"),
      declared_normalization: "preserve_bytes",
      line_ending_mode: "preserved",
      line_count: lines.length,
      body_sha256: HASH("body"),
      lines,
    },
    timing_authority: {
      authority: "timing_plan",
      source_path: "01_intent/timing.json",
      source_sha256: HASH("timing"),
      source_hash: HASH("timing"),
      declared_normalization: "preserve_values",
      plan_version: "fixture/v1",
      alignment_version: "authored-lyrics-align/v1",
      confidence_threshold: 0.75,
      cue_count: cues.length,
      matched_count: cues.length,
      pending_count: 0,
      unmatched_count: 0,
      cues,
    },
    approval: { status: "approved", approved_by: "human", approved_at: "2026-09-01T00:00:00Z" },
  };
}

describe("Issue 36 authored-caption typography adapter", () => {
  it("uses approved C1 timing/body identities without mutating authored text", () => {
    const result = loadApprovedAuthoredLyricLineInputs({
      approval: approvalFixture(),
      fps: 30,
      approvalSha256: HASH("approval"),
      timelineSha256: HASH("timeline"),
      sections: [
        { role: "chorus", startSec: 0, endSec: 1, glow_color: "amber" },
        { role: "punk", startSec: 1, endSec: 2 },
      ],
    });
    expect(result.lyrics.map((line) => ({ id: line.lineId, cue: line.cueId, start: line.startSec })))
      .toEqual([
        { id: "AL_0001", cue: "AC_0001", start: 0 },
        { id: "AL_0002", cue: "AC_0002", start: 1 },
        { id: "AL_0003", cue: "AC_0003", start: 2 },
      ]);
    expect(result.lyrics[1].text).toBe("// 制作メモ");
    expect(result.authority.kind).toBe("authored_caption_approval");
  });

  it("produces deterministic plan/cue IDs and a schema-valid plan with sanitizer audit", () => {
    const adapted = loadApprovedAuthoredLyricLineInputs({
      approval: approvalFixture(),
      fps: 30,
      approvalSha256: HASH("approval"),
      timelineSha256: HASH("timeline"),
      sections: [
        { role: "chorus", startSec: 0, endSec: 1, glow_color: "amber" },
        { role: "punk", startSec: 1, endSec: 3 },
      ],
    });
    const input = {
      lyrics: adapted.lyrics,
      sections: adapted.sections,
      authority: adapted.authority,
      probe: () => ({ capability: "unavailable" as const, detail: "fixture fallback" }),
    };
    const first = planLyricTypography(input);
    const second = planLyricTypography(input);
    expect(first.plan_id).toBe(second.plan_id);
    expect(first.input_hash).toBe(hashLyricTypographyInput(input));
    expect(first.cues.map((cue) => cue.plan_cue_id)).toEqual(second.cues.map((cue) => cue.plan_cue_id));
    expect(first.cues.map((cue) => cue.section_role)).toEqual(["chorus", "punk"]);
    expect(first.removed_metadata.some((entry) => entry.line.includes("制作メモ"))).toBe(true);
    expect(first.cues.some((cue) => cue.sanitized_text === "（まだ歌う）")).toBe(true);
    const validation = validateAgainstSchema(first, "lyric-typography-plan.schema.json");
    expect(validation.valid).toBe(true);
    expect(first.fonts.verse.fallback_used).toBe(true);
    expect(first.fonts.verse.reason).toContain("bundled");
  });

  it("keeps legitimate parenthetical lyric text and exposes the alternate placement", () => {
    expect(sanitizeLyricLine("夢の中（まだ歌う）").text).toBe("夢の中（まだ歌う）");
    const position = resolveBottomCenterPosition(100, 120);
    expect(position.margin_v_px).toBe(240);
    expect(position.crosses_boundary).toBe(false);
  });
});
