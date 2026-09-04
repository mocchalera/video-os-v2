import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateFramingPolicy, loadFramingPolicy } from "../runtime/visual/framing-policy.js";
import { loadVerticalCompositionPolicy, resolveVerticalComposition } from "../runtime/visual/vertical-composition.js";

const root = process.cwd();

function sourceIdentity() {
  return {
    asset_id: "AS_fixture",
    segment_id: "SEG_fixture",
    source_content_hash: `sha256:${"a".repeat(64)}`,
    source_range: { src_in_us: 0, src_out_us: 1_000_000 },
  };
}

function observation() {
  return {
    person: { x: 0.2, y: 0.2, width: 0.35, height: 0.35, confidence: 0.9, yaw_radians: 0.05 },
    head: { x: 0.28, y: 0.1, width: 0.18, height: 0.2, confidence: 0.9, eye_y: 0.2 },
    hands: [{ x: 0.42, y: 0.58, confidence: 0.8 }],
  };
}

describe("RFA-017 vertical composition foundation", () => {
  it("resolves first/representative/last framing evidence without forcing a punch-in", () => {
    const policy = loadVerticalCompositionPolicy(path.join(root, "tests/fixtures/rfa-vertical/vertical-composition-policy.json"));
    const framingPolicy = loadFramingPolicy(path.join(root, "tests/fixtures/rfa-visual/framing_policy.json"));
    const framingResult = evaluateFramingPolicy({
      observations: [observation(), observation(), observation()],
      output: { width: 1080, height: 1920 },
      mode: "wide",
    }, framingPolicy);
    const result = resolveVerticalComposition({
      source_identity: sourceIdentity(),
      source_av_geometry: { video: { width: 1920, height: 1080, fps_num: 30, fps_den: 1 }, audio: { sample_rate: 48_000, channels: 2 } },
      frames: [
        { role: "first", observation: observation(), microphone: { present: true, confidence: 0.8 }, evidence: { present: true, confidence: 0.8 }, layout_anchor: "speech_lower" },
        { role: "representative", observation: observation(), microphone: { present: true, confidence: 0.8 }, evidence: { present: true, confidence: 0.8 }, layout_anchor: "speech_lower" },
        { role: "last", observation: observation(), microphone: { present: true, confidence: 0.8 }, evidence: { present: true, confidence: 0.8 }, layout_anchor: "speech_lower" },
      ],
      framing_result: framingResult,
      zoom_intent: "reset",
    }, policy);

    expect(result.status).toBe("ready");
    expect(result.frame_roles).toEqual({ first: 1, representative: 1, last: 1 });
    expect(result.zoom_intent).toBe("reset");
    expect(result.source_identity?.source_content_hash).toBe(sourceIdentity().source_content_hash);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ check: "person_occupancy", status: "pass" }),
      expect.objectContaining({ check: "headroom", status: "pass" }),
      expect.objectContaining({ check: "hands", status: "pass" }),
      expect.objectContaining({ check: "evidence", status: "pass" }),
    ]));
  });

  it("holds when source identity, A/V geometry, and required evidence are absent", () => {
    const policy = loadVerticalCompositionPolicy(path.join(root, "tests/fixtures/rfa-vertical/vertical-composition-policy.json"));
    const result = resolveVerticalComposition({ frames: [{ role: "first" }] }, policy);
    expect(result.status).toBe("human_hold");
    expect(result.safe_degrade?.mode).toBe("identity");
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ check: "source_identity", status: "unknown" }),
      expect.objectContaining({ check: "source_av_geometry", status: "unknown" }),
      expect.objectContaining({ check: "frame_roles", status: "unknown" }),
    ]));
  });
});
