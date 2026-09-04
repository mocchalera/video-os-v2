import { describe, expect, it } from "vitest";
import {
  routeVideoReasoningDisagreement,
  type VideoReasoningDisagreementSignal,
} from "../runtime/analysis/video-reasoning-disagreement-router.js";

const HASH = "a".repeat(64);
const SOURCE = {
  asset_id: "AST_001",
  source_content_sha256: HASH,
  source_duration_us: 10_000_000,
  effective_source_range_us: [2_000_000, 8_000_000] as const,
};

function signal(
  source: VideoReasoningDisagreementSignal["source"],
  status: VideoReasoningDisagreementSignal["status"] = "supports",
  range: readonly [number, number] = [3_000_000, 5_000_000],
): VideoReasoningDisagreementSignal {
  return {
    source,
    claim_id: "clear_reveal",
    status,
    asset_id: SOURCE.asset_id,
    source_content_sha256: SOURCE.source_content_sha256,
    range_us: range,
  };
}

describe("M3b evidence disagreement router", () => {
  it("returns no disagreement for aligned provider/local/Marlin/static/transcript/audio evidence", () => {
    const routed = routeVideoReasoningDisagreement({
      source: SOURCE,
      signals: [
        signal("provider"),
        signal("local"),
        signal("marlin"),
        signal("static_vlm"),
        signal("transcript"),
        signal("audio"),
      ],
    });

    expect(routed).toMatchObject({
      decision: "no_disagreement",
      review_required: false,
      material_disagreement: false,
      selected_source: null,
      authority: "derived_evidence_only",
      timeline_authority: "none",
      confidence: 0.5,
      confidence_basis: "degraded",
      uncertainty: null,
    });
    expect(routed.contributing_sources).toEqual(["provider", "local", "marlin", "static_vlm", "transcript", "audio"]);
    expect(routed.evidence).toHaveLength(6);
  });

  it("routes material provider/local disagreement to high-impact uncertainty without a winner", () => {
    const routed = routeVideoReasoningDisagreement({
      source: SOURCE,
      signals: [signal("provider"), signal("local", "rejects")],
    });

    expect(routed.decision).toBe("review_required");
    expect(routed.review_required).toBe(true);
    expect(routed.material_disagreement).toBe(true);
    expect(routed.reason_codes).toContain("material_claim_disagreement");
    expect(routed.contributing_sources).toEqual(["provider", "local"]);
    expect(routed.selected_source).toBeNull();
    expect(routed.uncertainty).toMatchObject({ impact: "high", clarification_question: expect.any(Object) });
    expect(routed.confidence).toBeLessThanOrEqual(0.5);
  });

  it.each(["inconclusive", "rejects", "unavailable"] as const)(
    "routes local %s to review-required uncertainty",
    (status) => {
      const routed = routeVideoReasoningDisagreement({ source: SOURCE, signals: [signal("provider"), signal("local", status)] });
      expect(routed.review_required).toBe(true);
      expect(routed.reason_codes).toContain(status === "rejects" ? "local_verification_rejected" : `local_verification_${status}`);
      expect(routed.selected_source).toBeNull();
    },
  );

  it("routes a material range mismatch even when source claims agree", () => {
    const routed = routeVideoReasoningDisagreement({
      source: SOURCE,
      signals: [signal("provider", "supports", [3_000_000, 5_000_000]), signal("transcript", "supports", [6_000_000, 7_000_000])],
    });
    expect(routed.review_required).toBe(true);
    expect(routed.material_disagreement).toBe(true);
    expect(routed.reason_codes).toContain("material_range_disagreement");
  });

  it("routes same-source duplicate claims before cross-source comparison", () => {
    const routed = routeVideoReasoningDisagreement({
      source: SOURCE,
      signals: [
        signal("local", "supports", [3_000_000, 5_000_000]),
        signal("local", "rejects", [6_000_000, 7_000_000]),
      ],
    });

    expect(routed.decision).toBe("review_required");
    expect(routed.review_required).toBe(true);
    expect(routed.material_disagreement).toBe(true);
    expect(routed.reason_codes).toEqual(expect.arrayContaining([
      "duplicate_source_claim",
      "intra_source_claim_disagreement",
      "intra_source_range_disagreement",
    ]));
    expect(routed.contributing_sources).toEqual(["local"]);
    expect(routed.selected_source).toBeNull();
    expect(routed.timeline_authority).toBe("none");
    expect(routed.confidence).toBeLessThanOrEqual(0.5);
  });

  it("routes source identity and range violations without exposing a source winner", () => {
    const routed = routeVideoReasoningDisagreement({
      source: SOURCE,
      signals: [
        signal("provider"),
        { ...signal("local"), source_content_sha256: "b".repeat(64) },
        { ...signal("audio"), range_us: [8_000_000, 9_000_000] },
      ],
    });
    expect(routed.review_required).toBe(true);
    expect(routed.reason_codes).toContain("evidence_identity_mismatch");
    expect(routed.reason_codes).toContain("evidence_range_invalid");
    expect(routed.selected_source).toBeNull();
    expect(routed.timeline_authority).toBe("none");
  });
});
