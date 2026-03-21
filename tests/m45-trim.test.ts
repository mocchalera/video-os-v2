import { describe, it, expect } from "vitest";
import { resolveTrim, type ResolvedTrim, type TrimContext } from "../runtime/compiler/trim.js";
import type { Candidate } from "../runtime/compiler/types.js";

const US_PER_FRAME = 1_000_000 / 24; // ~41667us

const makeCandidate = (overrides: Partial<Candidate> = {}): Candidate => ({
  segment_id: "SEG_001",
  asset_id: "AST_001",
  src_in_us: 0,
  src_out_us: 10_000_000, // 10 seconds
  role: "hero",
  why_it_matches: "test",
  risks: [],
  confidence: 0.9,
  ...overrides,
});

const defaultCtx: TrimContext = {
  beatTargetDurationUs: 3_000_000, // 3 seconds
  usPerFrame: US_PER_FRAME,
};

describe("Adaptive Trim", () => {
  it("returns fixed_authored when no hint and no policy", () => {
    const c = makeCandidate();
    const result = resolveTrim(c, defaultCtx);
    expect(result.mode).toBe("fixed_authored");
    expect(result.src_in_us).toBe(0);
    expect(result.src_out_us).toBe(10_000_000);
  });

  it("returns fixed_authored when policy mode is fixed", () => {
    const c = makeCandidate({
      trim_hint: { source_center_us: 5_000_000, preferred_duration_us: 2_000_000 },
    });
    const result = resolveTrim(c, {
      ...defaultCtx,
      trimPolicy: { mode: "fixed" },
    });
    expect(result.mode).toBe("fixed_authored");
  });

  it("uses center from trim_hint when available", () => {
    const c = makeCandidate({
      trim_hint: { source_center_us: 5_000_000, preferred_duration_us: 2_000_000 },
    });
    const result = resolveTrim(c, {
      ...defaultCtx,
      trimPolicy: { mode: "adaptive" },
    });
    expect(result.mode).toBe("adaptive_center");
    expect(result.source_center_us).toBe(5_000_000);
    // With 2s preferred duration centered at 5s: in=4s, out=6s
    expect(result.src_in_us).toBe(4_000_000);
    expect(result.src_out_us).toBe(6_000_000);
  });

  it("falls back to midpoint when no center hint", () => {
    const c = makeCandidate({
      trim_hint: { preferred_duration_us: 2_000_000 },
    });
    const result = resolveTrim(c, {
      ...defaultCtx,
      trimPolicy: { mode: "adaptive" },
    });
    expect(result.mode).toBe("fixed_midpoint");
    expect(result.source_center_us).toBe(5_000_000); // midpoint of 0-10s
  });

  it("clamps to authored window", () => {
    const c = makeCandidate({
      src_in_us: 2_000_000,
      src_out_us: 4_000_000, // only 2s window
      trim_hint: {
        source_center_us: 3_000_000,
        preferred_duration_us: 5_000_000, // requests 5s but only 2s available
      },
    });
    const result = resolveTrim(c, {
      ...defaultCtx,
      trimPolicy: { mode: "adaptive" },
    });
    // Should be clamped to authored range
    expect(result.src_in_us).toBeGreaterThanOrEqual(2_000_000);
    expect(result.src_out_us).toBeLessThanOrEqual(4_000_000);
  });

  it("respects min/max duration from hint", () => {
    const c = makeCandidate({
      trim_hint: {
        source_center_us: 5_000_000,
        preferred_duration_us: 500_000, // 0.5s - below min
        min_duration_us: 1_000_000, // 1s min
        max_duration_us: 3_000_000, // 3s max
      },
    });
    const result = resolveTrim(c, {
      ...defaultCtx,
      trimPolicy: { mode: "adaptive" },
    });
    const duration = result.src_out_us - result.src_in_us;
    expect(duration).toBeGreaterThanOrEqual(1_000_000);
    expect(duration).toBeLessThanOrEqual(3_000_000);
  });

  it("applies skill trim bias (positive = extend post-roll)", () => {
    const c = makeCandidate({
      trim_hint: { source_center_us: 5_000_000, preferred_duration_us: 2_000_000 },
    });
    const result = resolveTrim(c, {
      ...defaultCtx,
      trimPolicy: { mode: "adaptive" },
      skillTrimBias: 0.2, // extend post-roll
    });
    // Center should shift earlier (more post-roll)
    expect(result.src_in_us).toBeGreaterThan(4_000_000); // pre-roll reduced
  });

  it("preserves interest_point_label in result", () => {
    const c = makeCandidate({
      trim_hint: {
        source_center_us: 5_000_000,
        preferred_duration_us: 2_000_000,
        interest_point_label: "emotional_peak",
        interest_point_confidence: 0.95,
      },
    });
    const result = resolveTrim(c, {
      ...defaultCtx,
      trimPolicy: { mode: "adaptive" },
    });
    expect(result.interest_point_label).toBe("emotional_peak");
  });

  it("respects window_start_us and window_end_us", () => {
    const c = makeCandidate({
      trim_hint: {
        source_center_us: 3_000_000,
        preferred_duration_us: 4_000_000,
        window_start_us: 2_000_000,
        window_end_us: 6_000_000,
      },
    });
    const result = resolveTrim(c, {
      ...defaultCtx,
      trimPolicy: { mode: "adaptive" },
    });
    expect(result.src_in_us).toBeGreaterThanOrEqual(2_000_000);
    expect(result.src_out_us).toBeLessThanOrEqual(6_000_000);
  });
});
