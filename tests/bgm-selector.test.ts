import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  BGM_SCORE_WEIGHTS,
  selectBgmDeterministically,
  type BgmSelectorCandidateInput,
  type BgmSelectorInput,
  type BgmSelectorRequirements,
} from "../runtime/music/selector.js";
import type { BgmPackManifest, BgmPackTrack, CatalogTrack } from "../runtime/music/pack-types.js";

const fixture = JSON.parse(fs.readFileSync(
  path.resolve("tests/fixtures/bgm_contracts/valid_two_track_pack.json"),
  "utf8",
)) as BgmPackManifest;

function catalogTrack(track: BgmPackTrack, overrides: Partial<CatalogTrack> = {}): CatalogTrack {
  return {
    pack_id: fixture.pack_id,
    pack_version: fixture.pack_version,
    pack_source: "project_override",
    manifest_hash: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    track,
    full_mix_path: `/private/library/${track.track_id}.wav`,
    preview_path: `/private/library/${track.track_id}.mp3`,
    ...overrides,
  };
}

function cloneTrack(index = 0): BgmPackTrack {
  return structuredClone(fixture.tracks[index]);
}

function requirements(overrides: Partial<BgmSelectorRequirements> = {}): BgmSelectorRequirements {
  return {
    families: ["trust_clarity"],
    intensities: ["low"],
    use_cases: ["interview"],
    minimum_speech_friendliness: 0.8,
    vocal_presence_allowed: ["none"],
    duration_us: 60_000_000,
    target_energy: 0.25,
    target_bpm: 84,
    speech_ratio: 0.85,
    required_rights_scopes: [],
    require_licensed_rights: false,
    require_verified_hash: false,
    explicit_exclusions: [],
    ...overrides,
  };
}

function candidate(
  index = 0,
  overrides: Partial<BgmSelectorCandidateInput> = {},
): BgmSelectorCandidateInput {
  const track = cloneTrack(index);
  return {
    track: catalogTrack(track),
    integrity_ok: true,
    installed: true,
    readable: true,
    codec_supported: true,
    rights_allowed: true,
    licensed_rights: true,
    rights_hash_verified: true,
    permitted_rights_scopes: ["preview_internal", "external", "public_redistribution", "commercial"],
    has_sufficient_authored_metadata: true,
    analysis: {
      status: "ready",
      input_content_hash: track.full_mix.content_hash,
      duration_us: track.duration_us,
      bpm: index === 0 ? 84 : 120,
      beat_confidence: index === 0 ? 0.9 : 0.8,
      downbeat_confidence: index === 0 ? 0.92 : 0.75,
      speech_band_masking_score: index === 0 ? 0.08 : 0.35,
      speech_friendliness: index === 0 ? 0.93 : 0.72,
      energy: index === 0 ? 0.28 : 0.82,
      ending_resolution: 0.88,
    },
    semantic_similarity: index === 0 ? 0.94 : 0.2,
    usage_count_90d: 0,
    usage_penalty: 0,
    ...overrides,
  };
}

function input(overrides: Partial<BgmSelectorInput> = {}): BgmSelectorInput {
  return {
    requirements: requirements(),
    candidates: [candidate(0), candidate(1)],
    semantic_channel: { status: "available", model_revision: "clap-test-v1", warnings: [] },
    selection_mode: "auto",
    ...overrides,
  };
}

describe("deterministic BGM selector", () => {
  it("ranks all passing candidates with seven explainable score components", () => {
    const result = selectBgmDeterministically(input());

    expect(result.ranked.map((entry) => entry.track_id)).toEqual([
      "synthetic-calm-low-01",
      "synthetic-progress-high-01",
    ]);
    expect(result.rejected).toEqual([]);
    expect(result.ranked[0].rank).toBe(1);
    expect(result.ranked[0].score_evidence).toHaveLength(7);
    expect(Object.keys(result.ranked[0].score_breakdown).sort()).toEqual(
      Object.keys(BGM_SCORE_WEIGHTS).sort(),
    );
    expect(result.ranked[0].hard_gate_evidence.every((gate) => gate.passed)).toBe(true);
    expect(result.ranked[0].explanation).toContain("strongest");
    expect(result.decision.mode).toBe("auto");
    expect(result.decision.selected?.track_id).toBe("synthetic-calm-low-01");
  });

  it.each([
    ["installed", { installed: false }],
    ["pack_integrity", { integrity_ok: false }],
    ["content_hash", { expected_content_hash: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" }],
    ["rights_permission", { rights_allowed: false }],
    ["codec_support", { codec_supported: false }],
    ["audio_readable", { readable: false }],
    ["brief_exclusion", { explicit_exclusion_matches: ["felt piano"] }],
    ["analysis_fallback", { analysis: { status: "failed" }, has_sufficient_authored_metadata: false }],
  ] satisfies Array<[string, Partial<BgmSelectorCandidateInput>]>)("rejects before scoring when the %s hard gate fails", (gate, override) => {
    const result = selectBgmDeterministically(input({ candidates: [candidate(0, override)] }));

    expect(result.ranked).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].hard_gate_evidence.find((item) => item.gate === gate)?.passed).toBe(false);
    expect(result.rejected[0].rejection_reasons[0]).toContain(gate);
    expect(result.rejected[0].total_score).toBeNull();
    expect(result.rejected[0].score_evidence).toEqual([]);
  });

  it("enforces licensed, hash-verified, scoped rights without inferring permission", () => {
    const required = requirements({
      required_rights_scopes: ["commercial", "public_redistribution"],
      require_licensed_rights: true,
      require_verified_hash: true,
    });
    const unsafe = candidate(0, {
      rights_allowed: undefined,
      licensed_rights: false,
      rights_hash_verified: false,
      permitted_rights_scopes: ["commercial"],
    });
    const result = selectBgmDeterministically(input({ requirements: required, candidates: [unsafe] }));
    const failed = result.rejected[0].hard_gate_evidence.filter((gate) => !gate.passed).map((gate) => gate.gate);

    expect(failed).toEqual(["rights_permission", "rights_license", "rights_hash"]);
  });

  it("rejects vocal conflicts and duration with no approved loop path", () => {
    const vocalTrack = cloneTrack(0);
    vocalTrack.vocal_presence = "lead";
    const shortTrack = cloneTrack(0);
    shortTrack.duration_us = 10_000_000;
    shortTrack.loop_windows = [];
    const vocal = candidate(0, { track: catalogTrack(vocalTrack) });
    const short = candidate(0, {
      track: catalogTrack(shortTrack),
      analysis: { status: "ready", input_content_hash: shortTrack.full_mix.content_hash },
    });

    const vocalResult = selectBgmDeterministically(input({ candidates: [vocal] }));
    const durationResult = selectBgmDeterministically(input({ candidates: [short] }));
    expect(vocalResult.rejected[0].rejection_reasons.join(" ")).toContain("vocal_policy");
    expect(durationResult.rejected[0].rejection_reasons.join(" ")).toContain("duration_fit");
  });

  it("redistributes unavailable semantic weight proportionally and records every awarded point", () => {
    const result = selectBgmDeterministically(input({
      candidates: [candidate(0, { semantic_similarity: null })],
      semantic_channel: { status: "unavailable", model_revision: null, warnings: ["model absent"] },
    }));
    const trace = result.redistribution_trace;
    const top = result.ranked[0];

    expect(trace.applied).toBe(true);
    expect(trace.allocations).toEqual([
      { component: "editorial_family_arc_fit", added_points: 9.2308 },
      { component: "speech_friendliness", added_points: 6.9231 },
      { component: "energy_tempo_fit", added_points: 6.9231 },
      { component: "duration_edit_ending_fit", added_points: 4.6154 },
      { component: "beat_downbeat_confidence", added_points: 2.3076 },
    ]);
    expect(trace.allocations.reduce((sum, item) => sum + item.added_points, 0)).toBe(30);
    expect(top.score_breakdown.semantic_fit).toBe(0);
    expect(top.total_score).toBeCloseTo(top.score_evidence.reduce(
      (sum, component) => sum + component.awarded_points + component.redistributed_points,
      0,
    ), 3);
    expect(result.decision.minimum_score).toBe(78);
    expect(result.decision.minimum_margin).toBe(12);
    expect(result.warnings).toContain("semantic channel unavailable; deterministic weights redistributed");
  });

  it("uses stricter thresholds for degraded semantics without claiming redistribution", () => {
    const result = selectBgmDeterministically(input({
      semantic_channel: { status: "degraded", model_revision: "clap-test-v1", warnings: ["partial"] },
    }));

    expect(result.redistribution_trace.applied).toBe(false);
    expect(result.decision.minimum_score).toBe(78);
    expect(result.decision.minimum_margin).toBe(12);
    expect(result.warnings).toContain("semantic channel degraded; stricter auto thresholds applied");
  });

  it("falls back to suggestions when the top-two margin misses the auto threshold", () => {
    const left = candidate(0);
    const rightTrack = cloneTrack(0);
    rightTrack.track_id = "synthetic-calm-low-02";
    rightTrack.full_mix.content_hash = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    const right = candidate(0, {
      track: catalogTrack(rightTrack),
      analysis: {
        ...candidate(0).analysis!,
        input_content_hash: rightTrack.full_mix.content_hash,
      },
    });
    const result = selectBgmDeterministically(input({ candidates: [right, left] }));

    expect(result.top_two_margin).toBe(0);
    expect(result.decision.mode).toBe("suggest");
    expect(result.decision.selected).toBeNull();
    expect(result.decision.reason).toContain("below 8");
  });

  it("honors explicit suggest mode even when the top candidate clears auto thresholds", () => {
    const result = selectBgmDeterministically(input({
      candidates: [candidate(0)],
      selection_mode: "suggest",
    }));

    expect(result.decision.mode).toBe("suggest");
    expect(result.decision.selected).toBeNull();
    expect(result.decision.suggestions).toHaveLength(1);
    expect(result.decision.reason).toBe("suggest mode requested");
  });

  it("does not auto-select a lone candidate because no top-two margin exists", () => {
    const result = selectBgmDeterministically(input({ candidates: [candidate(0)] }));

    expect(result.ranked[0].total_score).toBeGreaterThanOrEqual(70);
    expect(result.top_two_margin).toBeNull();
    expect(result.decision.mode).toBe("suggest");
    expect(result.decision.selected).toBeNull();
    expect(result.decision.reason).toContain("at least two ranked candidates");
  });

  it("is byte-stable across reruns and input ordering with a documented tie-break", () => {
    const firstTrack = cloneTrack(0);
    firstTrack.track_id = "tie-b";
    const secondTrack = cloneTrack(0);
    secondTrack.track_id = "tie-a";
    secondTrack.full_mix.content_hash = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    const first = candidate(0, {
      track: catalogTrack(firstTrack),
      analysis: { ...candidate(0).analysis!, input_content_hash: firstTrack.full_mix.content_hash },
    });
    const second = candidate(0, {
      track: catalogTrack(secondTrack),
      analysis: { ...candidate(0).analysis!, input_content_hash: secondTrack.full_mix.content_hash },
    });
    const forward = selectBgmDeterministically(input({ candidates: [first, second] }));
    const reversed = selectBgmDeterministically(input({ candidates: [second, first] }));

    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
    expect(forward.ranked.map((entry) => entry.track_id)).toEqual(["tie-a", "tie-b"]);
  });

  it("does not expose private catalog paths in score or gate evidence", () => {
    const result = selectBgmDeterministically(input({ candidates: [candidate(0)] }));
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain("/private/library");
    expect(serialized).not.toContain("full_mix_path");
    expect(serialized).not.toContain("preview_path");
  });

  it("rejects invalid selector duration instead of producing unstable math", () => {
    expect(() => selectBgmDeterministically(input({
      requirements: requirements({ duration_us: 0 }),
    }))).toThrow("duration_us must be a positive safe integer");
  });
});
