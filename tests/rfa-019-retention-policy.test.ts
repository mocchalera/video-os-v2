import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateRetentionPolicy, loadRetentionPolicy, type RetentionEvidenceInput } from "../runtime/editorial/short-form-retention.js";

const policy = loadRetentionPolicy(path.join(process.cwd(), "tests/fixtures/rfa-retention/retention-policy.json"));

function evidence(overrides: Partial<RetentionEvidenceInput> = {}): RetentionEvidenceInput {
  return {
    requested_mode: "aggressive",
    promise: { present: true, truthful: true },
    source_evidence: { present: true, attributable: true },
    payoff: { present: true, proportional: true },
    readability: { pass: true },
    audibility: { pass: true },
    accessibility: { pass: true },
    fatigue: { pass: true },
    policy: { pass: true, clickbait: false, false_spoiler: false, fabricated_evidence: false },
    audio_boundaries: { phoneme_safe: true, word_onset_safe: true, conjunction_safe: true, causal_bridge_safe: true, offset_map_sync: true },
    tempo: { event_envelope: true, meaningful_visual_refresh: true, pause_or_silence_allowed: true, sfx_per_cut: false },
    ...overrides,
  };
}

describe("RFA-019 truth-bound retention policy", () => {
  it("passes only when promise, evidence, payoff, audio boundaries, tempo, and policy checks pass", () => {
    const receipt = evaluateRetentionPolicy(evidence(), policy);
    expect(receipt.status).toBe("pass");
    expect(receipt.resolved_mode).toBe("aggressive");
    expect(receipt.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "phoneme_boundary", status: "pass" }),
      expect.objectContaining({ id: "conjunction_boundary", status: "pass" }),
      expect.objectContaining({ id: "causal_bridge", status: "pass" }),
      expect.objectContaining({ id: "offset_map_sync", status: "pass" }),
      expect.objectContaining({ id: "tempo_envelope", status: "pass" }),
      expect.objectContaining({ id: "pause_or_silence", status: "pass" }),
    ]));
  });

  it("degrades deterministically when tempo evidence fails, without inventing a second planner", () => {
    const receipt = evaluateRetentionPolicy(evidence({ tempo: { event_envelope: false, meaningful_visual_refresh: true, pause_or_silence_allowed: true, sfx_per_cut: false } }), policy);
    expect(receipt.status).toBe("degraded");
    expect(receipt.resolved_mode).toBe("standard");
    expect(receipt.reasons[0]).toContain("degraded aggressive to standard");
  });

  it("keeps missing evidence unknown and truth violations degrade to off", () => {
    const unknown = evaluateRetentionPolicy(evidence({ source_evidence: undefined, audio_boundaries: undefined }), policy);
    expect(unknown.resolved_mode).toBe("off");
    expect(unknown.status).toBe("blocked");
    expect(unknown.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "source_evidence", status: "unknown" }),
      expect.objectContaining({ id: "phoneme_boundary", status: "unknown" }),
    ]));

    const falseSpoiler = evaluateRetentionPolicy(evidence({ policy: { pass: true, clickbait: false, false_spoiler: true, fabricated_evidence: false } }), policy);
    expect(falseSpoiler.resolved_mode).toBe("off");
    expect(falseSpoiler.status).toBe("blocked");
    expect(falseSpoiler.checks).toEqual(expect.arrayContaining([expect.objectContaining({ id: "policy", status: "fail" })]));
  });

  it("allows an explicit off mode without pretending that retention evidence passed", () => {
    const receipt = evaluateRetentionPolicy({ requested_mode: "off" }, policy);
    expect(receipt.status).toBe("pass");
    expect(receipt.resolved_mode).toBe("off");
    expect(receipt.checks.some((check) => check.status === "unknown")).toBe(true);
  });
});
