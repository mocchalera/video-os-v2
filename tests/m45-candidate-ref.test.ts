import { describe, it, expect } from "vitest";
import {
  generateCandidateId,
  legacyCandidateId,
  getCandidateRef,
  buildCandidateRefMap,
  ensureCandidateIds,
} from "../runtime/compiler/candidate-ref.js";
import type { Candidate } from "../runtime/compiler/types.js";

const makeCandidate = (overrides: Partial<Candidate> = {}): Candidate => ({
  segment_id: "SEG_001",
  asset_id: "AST_001",
  src_in_us: 1_000_000,
  src_out_us: 5_000_000,
  role: "hero",
  why_it_matches: "test",
  risks: [],
  confidence: 0.9,
  ...overrides,
});

describe("candidate_id generation", () => {
  it("produces deterministic ids", () => {
    const c = makeCandidate();
    const id1 = generateCandidateId("proj-1", c);
    const id2 = generateCandidateId("proj-1", c);
    expect(id1).toBe(id2);
  });

  it("starts with cand_ prefix", () => {
    const id = generateCandidateId("proj-1", makeCandidate());
    expect(id).toMatch(/^cand_[A-Za-z0-9_-]+$/);
  });

  it("differs for different inputs", () => {
    const c1 = makeCandidate({ segment_id: "SEG_001" });
    const c2 = makeCandidate({ segment_id: "SEG_002" });
    const id1 = generateCandidateId("proj-1", c1);
    const id2 = generateCandidateId("proj-1", c2);
    expect(id1).not.toBe(id2);
  });

  it("differs for different projects", () => {
    const c = makeCandidate();
    const id1 = generateCandidateId("proj-1", c);
    const id2 = generateCandidateId("proj-2", c);
    expect(id1).not.toBe(id2);
  });

  it("differs for different roles", () => {
    const c1 = makeCandidate({ role: "hero" });
    const c2 = makeCandidate({ role: "support" });
    const id1 = generateCandidateId("proj-1", c1);
    const id2 = generateCandidateId("proj-1", c2);
    expect(id1).not.toBe(id2);
  });
});

describe("legacy shim", () => {
  it("produces expected format", () => {
    const c = makeCandidate();
    const id = legacyCandidateId(c);
    expect(id).toBe("legacy:SEG_001:1000000:5000000");
  });
});

describe("getCandidateRef", () => {
  it("prefers candidate_id when present", () => {
    const c = makeCandidate({ candidate_id: "cand_abc123" });
    expect(getCandidateRef(c)).toBe("cand_abc123");
  });

  it("falls back to legacy shim", () => {
    const c = makeCandidate();
    expect(getCandidateRef(c)).toBe("legacy:SEG_001:1000000:5000000");
  });
});

describe("buildCandidateRefMap", () => {
  it("indexes by candidate_id and segment_id", () => {
    const c = makeCandidate({ candidate_id: "cand_x" });
    const map = buildCandidateRefMap([c]);
    expect(map.get("cand_x")).toBe(c);
    expect(map.get("SEG_001")).toBe(c);
  });
});

describe("ensureCandidateIds", () => {
  it("assigns ids to candidates without them", () => {
    const c = makeCandidate();
    expect(c.candidate_id).toBeUndefined();
    ensureCandidateIds("proj-1", [c]);
    expect(c.candidate_id).toBeDefined();
    expect(c.candidate_id).toMatch(/^cand_/);
  });

  it("preserves existing ids", () => {
    const c = makeCandidate({ candidate_id: "cand_existing" });
    ensureCandidateIds("proj-1", [c]);
    expect(c.candidate_id).toBe("cand_existing");
  });
});

describe("backward compatibility", () => {
  it("old candidates without M4.5 fields work with getCandidateRef", () => {
    // Simulate M4 candidate (no candidate_id, no editorial_signals, no trim_hint)
    const c: Candidate = {
      segment_id: "SEG_OLD",
      asset_id: "AST_OLD",
      src_in_us: 0,
      src_out_us: 3_000_000,
      role: "hero",
      why_it_matches: "old candidate",
      risks: [],
      confidence: 0.8,
    };
    const ref = getCandidateRef(c);
    expect(ref).toBe("legacy:SEG_OLD:0:3000000");
  });
});
