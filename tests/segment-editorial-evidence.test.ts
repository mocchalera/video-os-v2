import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  adaptSegmentEditorialEvidence,
  loadSegmentEditorialEvidence,
} from "../runtime/artifacts/segment-editorial-evidence.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeProject(): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "segment-editorial-evidence-"));
  tempDirs.push(projectDir);
  fs.mkdirSync(path.join(projectDir, "03_analysis"), { recursive: true });
  return projectDir;
}

describe("segment editorial evidence adapter", () => {
  it("maps canonical observations losslessly, ignores snapshots, and lifts peak evidence", () => {
    const input = {
      items: [{
        segment_id: "SEG_1",
        tags: ["legacy_should_not_win"],
        editorial_observation: {
          visual_tags: ["person", "window"],
          motion_type: "continuous",
          camera_motion_direction: "toward_camera",
          subject_motion_direction: "screen_left_should_be_rejected",
          shot_scale: "close_up",
          composition_anchor: "balanced",
          screen_side: "multiple",
          gaze_direction: "screen_left",
          camera_axis: "axis_left",
          dominant_subject_type: "person",
          avg_luma: 0.37,
          dominant_colors: ["navy", "amber"],
          text_presence: "absent",
          confidence: {
            tags: { score: 0.91, evidence_refs: ["vlm:tags"] },
            motion: { score: 0.82, evidence_refs: ["vlm:motion"] },
            framing: { score: 0.88, evidence_refs: ["vlm:framing"] },
            direction: { score: 0.57, evidence_refs: ["vlm:direction"] },
            appearance: { score: 1, evidence_refs: ["measurement:luma"] },
            text: { score: 0.93, evidence_refs: ["vlm:text"] },
          },
          producer_snapshots: {
            grounded_vlm: { values: { motion_type: "static", camera_axis: "axis_right" } },
          },
        },
        peak_analysis: {
          peak_moments: [{ peak_ref: "peak:1", timestamp_us: 42, type: "visual_peak", confidence: 0.8, description: "turn", source_pass: "refine" }],
          support_signals: { fused_peak_score: 0.81, motion_support_score: 0.7, audio_support_score: 0.2 },
        },
      }],
    };
    const before = JSON.stringify(input);

    const evidence = adaptSegmentEditorialEvidence(input).get("SEG_1");

    expect(evidence?.adjacency_features).toEqual({
      visual_tags: ["person", "window"],
      motion_type: "continuous",
      camera_motion_direction: "toward_camera",
      shot_scale: "close_up",
      composition_anchor: "balanced",
      screen_side: "multiple",
      gaze_direction: "screen_left",
      camera_axis: "axis_left",
      dominant_subject_type: "person",
      avg_luma: 0.37,
      dominant_colors: ["navy", "amber"],
      text_presence: "absent",
    });
    expect(evidence?.peak_moments).toEqual(input.items[0].peak_analysis.peak_moments);
    expect(evidence?.support_signals).toEqual(input.items[0].peak_analysis.support_signals);
    expect(evidence?.coverage).toMatchObject({
      motion_type: "known",
      camera_axis: "known",
      camera_motion_direction: "known",
      subject_motion_direction: "missing",
      dominant_subject_type: "known",
      avg_luma: "known",
      dominant_colors: "known",
      text_presence: "known",
    });
    expect(evidence?.confidence).toEqual(input.items[0].editorial_observation.confidence);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("uses old segment tags with explicit unknown motion fallback", () => {
    const evidence = adaptSegmentEditorialEvidence({
      items: [{ segment_id: "SEG_OLD", tags: ["legacy", "local"] }],
    }).get("SEG_OLD");

    expect(evidence?.adjacency_features).toEqual({ visual_tags: ["legacy", "local"], motion_type: "unknown" });
    expect(evidence?.coverage).toMatchObject({ visual_tags: "known", motion_type: "unknown", camera_axis: "missing" });
  });

  it("retains unknown and not_applicable as coverage rather than fabricated values", () => {
    const evidence = adaptSegmentEditorialEvidence({
      items: [{
        segment_id: "SEG_STATUS",
        editorial_observation: {
          motion_type: "unknown",
          shot_scale: "not_applicable",
          composition_anchor: "unknown",
          camera_axis: "not_applicable",
        },
      }],
    }).get("SEG_STATUS");

    expect(evidence?.adjacency_features).toMatchObject({
      motion_type: "unknown",
      shot_scale: "not_applicable",
      composition_anchor: "unknown",
      camera_axis: "not_applicable",
    });
    expect(evidence?.coverage).toMatchObject({
      motion_type: "unknown",
      shot_scale: "not_applicable",
      composition_anchor: "unknown",
      camera_axis: "not_applicable",
      screen_side: "missing",
    });
  });

  it("is deterministic and does not promote asset-wide summaries", () => {
    const input = {
      asset_summary: { motion_type: "rapid", visual_tags: ["asset_wide"] },
      items: [{ segment_id: "SEG_1", tags: ["segment_local"] }],
    };
    const first = [...adaptSegmentEditorialEvidence(input).entries()];
    const second = [...adaptSegmentEditorialEvidence(input).entries()];

    expect(second).toEqual(first);
    expect(first[0][1].adjacency_features.visual_tags).toEqual(["segment_local"]);
    expect(first[0][1].adjacency_features.motion_type).toBe("unknown");
  });
});

describe("segment editorial evidence loader", () => {
  it("fails open with diagnostics for missing and malformed artifacts", () => {
    const projectDir = makeProject();
    const messages: string[] = [];
    expect(loadSegmentEditorialEvidence(projectDir, (message) => messages.push(message)).size).toBe(0);
    expect(messages.join("\n")).toContain("unavailable");

    fs.writeFileSync(path.join(projectDir, "03_analysis", "segments.json"), "{bad json", "utf-8");
    expect(loadSegmentEditorialEvidence(projectDir, (message) => messages.push(message)).size).toBe(0);
    expect(messages.join("\n")).toContain("malformed");
  });
});
