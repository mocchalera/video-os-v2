import { describe, expect, it } from "vitest";
import { enrichSelectsFromAnalysis, type SegmentItem } from "../runtime/agents/triage-enrichment.js";
import { validateAgainstSchema } from "../runtime/commands/shared.js";
import type { Candidate, SelectsCandidates } from "../runtime/artifacts/types.js";

describe("enrichSelectsFromAnalysis", () => {
  it("copies peak_analysis fields into editorial and peak signals", () => {
    const enriched = enrichSelectsFromAnalysis(selects([candidate("SEG_001")]), [
      segment("SEG_001", {
        peak_analysis: {
          peak_moments: [
            {
              peak_ref: "peak:001",
              timestamp_us: 1_500_000,
              type: "emotional_peak",
              confidence: 0.82,
              description: "subject smiles after arriving",
              source_pass: "refine_filmstrip",
            },
          ],
          visual_energy_curve: [],
          support_signals: {
            motion_support_score: 0.44,
            audio_support_score: 0.31,
            fused_peak_score: 0.91,
          },
          provenance: peakProvenance(),
        },
      }),
    ]);

    expect(enriched.candidates[0].editorial_signals).toMatchObject({
      peak_type: "emotional_peak",
      peak_strength_score: 0.82,
      peak_ref: "peak:001",
    });
    expect(enriched.candidates[0].peak_signals).toMatchObject({
      motion: 0.44,
      audio_rms: 0.31,
    });
  });

  it("maps visual_quality scores and merges visual tags", () => {
    const enriched = enrichSelectsFromAnalysis(
      selects([
        candidate("SEG_001", {
          editorial_signals: { visual_tags: ["existing_tag"] },
        }),
      ]),
      [
        segment("SEG_001", {
          visual_quality: {
            scores: {
              light_quality: 0.7,
              subject_prominence: 0.8,
              emotional_expression: 0.76,
              composition_score: 0.9,
              motion_quality: 0.63,
            },
            labels: {
              lighting_style: ["Soft Morning"],
              composition_tags: ["wide landscape"],
              expression_tags: ["quiet smile"],
              motion_tags: ["slow walking"],
            },
          },
        }),
      ],
    );

    expect(enriched.candidates[0].editorial_signals).toMatchObject({
      motion_energy_score: 0.63,
      reaction_intensity_score: 0.76,
    });
    expect(enriched.candidates[0].editorial_signals?.visual_tags).toEqual([
      "existing_tag",
      "soft_morning",
      "wide_landscape",
      "quiet_smile",
      "slow_walking",
    ]);
  });

  it("derives semantic_cluster_id and motif_tags from segment metadata", () => {
    const enriched = enrichSelectsFromAnalysis(selects([candidate("SEG_001")]), [
      segment("SEG_001", {
        asset_id: "ena-outdoor-001",
        tags: ["outdoor", "mountain", "trees"],
      }),
    ]);

    expect(enriched.candidates[0].editorial_signals?.semantic_cluster_id).toBe("outdoor_landscape");
    expect(enriched.candidates[0].motif_tags).toEqual(["outdoor", "mountain", "trees"]);
  });

  it("does not overwrite LLM-populated scalar fields or motif tags", () => {
    const enriched = enrichSelectsFromAnalysis(
      selects([
        candidate("SEG_001", {
          motif_tags: ["llm_motif"],
          editorial_signals: {
            peak_type: "action_peak",
            peak_strength_score: 0.2,
            peak_ref: "llm-peak",
            motion_energy_score: 0.1,
            reaction_intensity_score: 0.3,
            semantic_cluster_id: "llm_cluster",
          },
          peak_signals: {
            motion: 0.9,
            audio_rms: 0.8,
          },
        }),
      ]),
      [
        segment("SEG_001", {
          tags: ["indoor", "craft"],
          peak_analysis: {
            peak_moments: [
              {
                peak_ref: "analysis-peak",
                timestamp_us: 2_000_000,
                type: "visual_peak",
                confidence: 0.95,
                description: "hands shaping wood",
                source_pass: "precision_dense_frames",
              },
            ],
            visual_energy_curve: [],
            support_signals: {
              motion_support_score: 0.4,
              audio_support_score: 0.5,
              fused_peak_score: 0.6,
            },
            provenance: peakProvenance(),
          },
          visual_quality: {
            scores: {
              light_quality: 0.7,
              subject_prominence: 0.8,
              emotional_expression: 0.88,
              composition_score: 0.9,
              motion_quality: 0.77,
            },
            labels: {
              lighting_style: [],
              composition_tags: [],
              expression_tags: [],
              motion_tags: [],
            },
          },
        }),
      ],
    );

    expect(enriched.candidates[0]).toMatchObject({
      motif_tags: ["llm_motif"],
      editorial_signals: {
        peak_type: "action_peak",
        peak_strength_score: 0.2,
        peak_ref: "llm-peak",
        motion_energy_score: 0.1,
        reaction_intensity_score: 0.3,
        semantic_cluster_id: "llm_cluster",
      },
      peak_signals: {
        motion: 0.9,
        audio_rms: 0.8,
      },
    });
  });

  it("handles missing segments and missing analysis fields gracefully", () => {
    const original = selects([candidate("SEG_001"), candidate("SEG_404")]);
    const enriched = enrichSelectsFromAnalysis(original, [segment("SEG_001", { tags: [] })]);

    expect(enriched).not.toBe(original);
    expect(enriched.candidates[1]).toEqual(original.candidates[1]);
    expect(enriched.candidates[0].editorial_signals?.semantic_cluster_id).toBe("asset_general");
  });

  it("produces selects that validate against the selects schema", () => {
    const enriched = enrichSelectsFromAnalysis(selects([candidate("SEG_001")]), [
      segment("SEG_001", {
        tags: ["aerial", "river"],
        peak_analysis: {
          peak_moments: [
            {
              peak_ref: "peak:001",
              timestamp_us: 1_000_000,
              type: "visual_peak",
              confidence: 1.2,
              description: "drone reveal",
              source_pass: "refine_filmstrip",
            },
          ],
          visual_energy_curve: [],
          support_signals: {
            motion_support_score: -0.1,
            audio_support_score: 1.1,
            fused_peak_score: 0.7,
          },
          provenance: peakProvenance(),
        },
        visual_quality: {
          scores: {
            light_quality: 0.7,
            subject_prominence: 0.8,
            emotional_expression: 0.4,
            composition_score: 0.9,
            motion_quality: 0.6,
          },
          labels: {
            lighting_style: ["bright daylight"],
            composition_tags: ["aerial view"],
            expression_tags: [],
            motion_tags: ["smooth glide"],
          },
        },
      }),
    ]);

    const validation = validateAgainstSchema(enriched, "selects-candidates.schema.json");
    expect(validation.valid, validation.errors.join("; ")).toBe(true);
  });
});

function selects(candidates: Candidate[]): SelectsCandidates {
  return {
    version: "1",
    project_id: "p",
    candidates,
  };
}

function candidate(segmentId: string, overrides: Partial<Candidate> = {}): Candidate {
  return {
    segment_id: segmentId,
    asset_id: "asset-001",
    src_in_us: 0,
    src_out_us: 5_000_000,
    role: "support",
    why_it_matches: `matches ${segmentId}`,
    risks: [],
    confidence: 0.8,
    ...overrides,
  };
}

function segment(segmentId: string, overrides: Partial<SegmentItem> = {}): SegmentItem {
  return {
    segment_id: segmentId,
    asset_id: "asset-001",
    src_in_us: 0,
    src_out_us: 5_000_000,
    duration_us: 5_000_000,
    rep_frame_us: 2_500_000,
    summary: "test segment",
    transcript_excerpt: "",
    quality_flags: [],
    tags: ["outdoor"],
    segment_type: "general",
    transcript_ref: null,
    confidence: {
      boundary: { score: 1, source: "test", status: "ok" },
    },
    provenance: {
      boundary: {
        stage: "test",
        method: "fixture",
        connector_version: "test",
        policy_hash: "test",
        request_hash: "test",
      },
    },
    ...overrides,
  };
}

function peakProvenance() {
  return {
    coarse_prompt_template_id: "test",
    refine_prompt_template_id: "test",
    precision_mode: "test",
    fusion_version: "test",
    support_signal_version: "test",
  };
}
