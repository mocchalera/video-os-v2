import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agglomerativeClusters,
  enrichSelectsFromAnalysis,
  parseFilmingTimestamp,
  refineClusters,
  type SegmentItem,
} from "../runtime/agents/triage-enrichment.js";
import { validateAgainstSchema } from "../runtime/commands/shared.js";
import type { Candidate, SelectsCandidates } from "../runtime/artifacts/types.js";

type CandidateWithRejection = Candidate & { rejection_reason?: string };

function mockSemanticEmbeddings(vectorsByText: Record<string, number[]>): void {
  vi.doMock("../runtime/eval/semantic-match.js", () => ({
    embedTexts: vi.fn(async (texts: string[], prefix: "query" | "passage" = "passage") => {
      expect(prefix).toBe("passage");
      return texts.map((text) => new Float32Array(vectorsByText[text] ?? [0, 0, 1]));
    }),
  }));
}

function mockSemanticEmbeddingFailure(): void {
  vi.doMock("../runtime/eval/semantic-match.js", () => ({
    embedTexts: vi.fn(async () => {
      throw new Error("embedding model unavailable");
    }),
  }));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("../runtime/eval/semantic-match.js");
});

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

  it("auto-rejects candidates whose source segment is below the technical quality threshold", () => {
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const enriched = enrichSelectsFromAnalysis(selects([
        candidate("SEG_BAD", {
          role: "support",
          editorial_signals: { semantic_cluster_id: "shared_cluster" },
        }),
        candidate("SEG_ALT", {
          role: "support",
          editorial_signals: { semantic_cluster_id: "shared_cluster" },
        }),
      ]), [
        segment("SEG_BAD", {
          tags: ["shared", "cluster"],
          visual_quality: {
            scores: {
              light_quality: 0.7,
              composition_score: 0.1,
              subject_prominence: 0.15,
            },
          },
        }),
        segment("SEG_ALT", {
          tags: ["shared", "cluster"],
          visual_quality: {
            scores: {
              light_quality: 0.7,
              composition_score: 0.8,
              subject_prominence: 0.8,
            },
          },
        }),
      ]);

      expect(enriched.candidates[0]).toMatchObject({
        role: "reject",
        quality_gate: {
          decision: "reject",
          confidence: "appraiser",
        },
      });
      expect((enriched.candidates[0] as CandidateWithRejection).rejection_reason).toContain(
        "appraiser_composition_and_subject_below_reject",
      );
      expect(logSpy).toHaveBeenCalledWith(
        "[triage:quality-gate] decisions reject=1 warn=0 pass=1 unmeasured=0",
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  it("does not auto-reject good clips or clips without visual quality scores", () => {
    const enriched = enrichSelectsFromAnalysis(
      selects([
        candidate("SEG_GOOD", { role: "hero" }),
        candidate("SEG_NO_VQ", { role: "support" }),
        candidate("SEG_PARTIAL", { role: "transition" }),
      ]),
      [
        segment("SEG_GOOD", {
          visual_quality: {
            scores: {
              light_quality: 0.7,
              composition_score: 0.8,
              subject_prominence: 0.75,
            },
          },
        }),
        segment("SEG_NO_VQ"),
        segment("SEG_PARTIAL", {
          visual_quality: {
            scores: {
              composition_score: 0.1,
            },
          },
        }),
      ],
    );

    expect(enriched.candidates.map((item) => item.role)).toEqual(["hero", "support", "transition"]);
    expect(enriched.candidates.map((item) => item.quality_gate?.decision)).toEqual([
      "pass",
      "unmeasured",
      "unmeasured",
    ]);
    expect(enriched.candidates.map((item) => (item as CandidateWithRejection).rejection_reason)).toEqual([
      undefined,
      undefined,
      undefined,
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

  it("derives story_role from eligible_beats without overwriting explicit values", () => {
    const enriched = enrichSelectsFromAnalysis(
      selects([
        candidate("SEG_HOOK", { eligible_beats: ["opening", "wonder"] }),
        candidate("SEG_SETUP", { eligible_beats: ["setup"] }),
        candidate("SEG_CLOSING", { eligible_beats: ["payoff", "release"] }),
        candidate("SEG_EXPERIENCE", { eligible_beats: ["middle", "immersion"] }),
        candidate("SEG_DEFAULT", { eligible_beats: ["quiet transition"] }),
        candidate("SEG_EXPLICIT", { eligible_beats: ["opening"], story_role: "reaction" }),
      ]),
      [
        segment("SEG_HOOK"),
        segment("SEG_SETUP"),
        segment("SEG_CLOSING"),
        segment("SEG_EXPERIENCE"),
        segment("SEG_DEFAULT"),
        segment("SEG_EXPLICIT"),
      ],
    );

    expect(enriched.candidates.map((item) => item.story_role)).toEqual([
      "hook",
      "setup",
      "closing",
      "experience",
      "experience",
      "reaction",
    ]);
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
    expect(enriched.candidates[1]).toMatchObject({
      ...original.candidates[1],
      quality_confidence: "low",
      quality_gate: {
        decision: "unmeasured",
        confidence: "low",
      },
    });
    expect(enriched.candidates[1].quality_flags).toContain("quality_confidence_low");
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

describe("refineClusters", () => {
  it("parses Blackmagic filename timestamps", () => {
    const timestamp = parseFilmingTimestamp("Blackmagic Pocket Cinema Camera_1_2015-07-25_0535_C0006.mov");

    expect(timestamp).toMatchObject({
      dateKey: "20150725",
      monthDayKey: "0725",
      timeKey: "0535",
      source: "filename",
    });
  });

  it("uses 10-minute filming sessions as the primary cluster signal", async () => {
    const refined = await refineClusters(
      selects([
        candidate("SEG_VINEYARD_1", {
          asset_id: "AST_C0006",
          motif_tags: ["wrong_motif_a"],
          editorial_signals: { semantic_cluster_id: "llm_cluster_a" },
        }),
        candidate("SEG_VINEYARD_2", {
          asset_id: "AST_C0009",
          motif_tags: ["wrong_motif_b"],
          editorial_signals: { semantic_cluster_id: "llm_cluster_b" },
        }),
        candidate("SEG_STREET", {
          asset_id: "AST_C0018",
          motif_tags: ["wrong_motif_c"],
        }),
      ]),
      [
        segment("SEG_VINEYARD_1", {
          asset_id: "AST_C0006",
          summary: "wide shot of a grape vineyard at sunrise",
          tags: ["outdoor", "vineyard"],
        }),
        segment("SEG_VINEYARD_2", {
          asset_id: "AST_C0009",
          summary: "close view of grape vines in the same vineyard",
          tags: ["outdoor", "vineyard"],
        }),
        segment("SEG_STREET", {
          asset_id: "AST_C0018",
          summary: "people crossing a city street",
          tags: ["street", "people"],
        }),
      ],
      {
        assets: [
          {
            asset_id: "AST_C0006",
            display_name: "Blackmagic Pocket Cinema Camera_1_2015-07-25_0535_C0006.mov",
          },
          {
            asset_id: "AST_C0009",
            display_name: "Blackmagic Pocket Cinema Camera_1_2015-07-25_0536_C0009.mov",
          },
          {
            asset_id: "AST_C0018",
            display_name: "Blackmagic Pocket Cinema Camera_1_2015-07-25_0600_C0018.mov",
          },
        ],
      },
    );

    const clusterIds = refined.candidates.map((item) => item.editorial_signals?.semantic_cluster_id);
    expect(clusterIds[0]).toBe("vineyard_0725_0535");
    expect(clusterIds[1]).toBe("vineyard_0725_0535");
    expect(clusterIds[2]).toBe("street_0725_0600");
  });

  it("uses file modification time for GoPro and DJI fallback session clustering", async () => {
    const refined = await refineClusters(
      selects([
        candidate("SEG_GOPRO", { asset_id: "AST_GOPR" }),
        candidate("SEG_DJI", { asset_id: "AST_DJI" }),
      ]),
      [
        segment("SEG_GOPRO", {
          asset_id: "AST_GOPR",
          summary: "riders moving along a forest trail",
          tags: ["trail", "forest"],
        }),
        segment("SEG_DJI", {
          asset_id: "AST_DJI",
          summary: "drone view above the same forest trail",
          tags: ["drone", "trail"],
        }),
      ],
      {
        assets: [
          {
            asset_id: "AST_GOPR",
            filename: "GOPR1234.MP4",
            mtime_ms: Date.UTC(2026, 0, 2, 3, 4),
          },
          {
            asset_id: "AST_DJI",
            filename: "DJI_0001.MP4",
            mtime_ms: Date.UTC(2026, 0, 2, 3, 8),
          },
        ],
      },
    );

    const clusterIds = refined.candidates.map((item) => item.editorial_signals?.semantic_cluster_id);
    expect(clusterIds[0]).toBe("forest_0102_0304");
    expect(clusterIds[1]).toBe("forest_0102_0304");
  });

  it("falls back to motif tags when no filming timestamp is available", async () => {
    const refined = await refineClusters(
      selects([
        candidate("SEG_001", { asset_id: "AST_001", motif_tags: ["campfire"] }),
        candidate("SEG_002", { asset_id: "AST_002", motif_tags: ["river"] }),
      ]),
      [
        segment("SEG_001", { asset_id: "AST_001", summary: "night fire", tags: ["outdoor"] }),
        segment("SEG_002", { asset_id: "AST_002", summary: "river walking", tags: ["outdoor"] }),
      ],
      {
        assets: [
          { asset_id: "AST_001", filename: "clip_a.mov" },
          { asset_id: "AST_002", filename: "clip_b.mov" },
        ],
      },
    );

    expect(refined.candidates.map((item) => item.editorial_signals?.semantic_cluster_id)).toEqual([
      "campfire",
      "river",
    ]);
  });

  it("assigns the same semantic_cluster_id to candidates with similar VLM summaries", async () => {
    mockSemanticEmbeddings({
      "person fishing by river": [1, 0, 0],
      "person casting fishing line": [0.96, 0.04, 0],
      "person walking in park": [0, 1, 0],
    });

    const refined = await refineClusters(
      selects([
        candidate("SEG_FISH_1", { editorial_signals: { semantic_cluster_id: "outdoor_people" } }),
        candidate("SEG_FISH_2", { editorial_signals: { semantic_cluster_id: "outdoor_people" } }),
        candidate("SEG_WALK", { editorial_signals: { semantic_cluster_id: "outdoor_people" } }),
      ]),
      [
        segment("SEG_FISH_1", { summary: "person fishing by river", tags: ["outdoor", "person", "river"] }),
        segment("SEG_FISH_2", { summary: "person casting fishing line", tags: ["outdoor", "person"] }),
        segment("SEG_WALK", { summary: "person walking in park", tags: ["outdoor", "person", "park"] }),
      ],
    );

    const clusterIds = refined.candidates.map((item) => item.editorial_signals?.semantic_cluster_id);
    expect(clusterIds[0]).toBe(clusterIds[1]);
    expect(clusterIds[0]).toContain("fishing");
    expect(clusterIds[2]).not.toBe(clusterIds[0]);
    expect(clusterIds[2]).toBe("park_walk");
  });

  it("keeps dissimilar summaries in different clusters", () => {
    const clusters = agglomerativeClusters(
      [new Float32Array([1, 0]), new Float32Array([0, 1])],
      ["person fishing by river", "person walking in park"],
      0.85,
    );

    expect(clusters.get(0)).not.toBe(clusters.get(1));
  });

  it("falls back to keyword-derived clusters when embeddings are unavailable", async () => {
    mockSemanticEmbeddingFailure();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const refined = await refineClusters(
      selects([
        candidate("SEG_001", { editorial_signals: { semantic_cluster_id: "outdoor_people" } }),
        candidate("SEG_002"),
      ]),
      [
        segment("SEG_001", {
          summary: "person fishing by river",
          tags: ["outdoor", "person", "river"],
        }),
        segment("SEG_002", {
          summary: "person walking in park",
          tags: ["outdoor", "person", "park"],
        }),
      ],
    );

    expect(refined.candidates[0].editorial_signals?.semantic_cluster_id).toBe("outdoor_people");
    expect(refined.candidates[1].editorial_signals?.semantic_cluster_id).toBe("outdoor_people");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("embedding refinement skipped"));
  });

  it("names clusters from distinctive non-generic summary terms", () => {
    const clusters = agglomerativeClusters(
      [new Float32Array([1, 0]), new Float32Array([0.99, 0.01])],
      [
        "wide shot of a person near campfire at night",
        "friends sit around campfire after sunset",
      ],
      0.85,
    );

    const clusterId = clusters.get(0);
    expect(clusterId).toBe(clusters.get(1));
    expect(clusterId).toContain("campfire");
    expect(clusterId).not.toContain("person");
    expect(clusterId).not.toContain("shot");
    expect(clusterId?.split("_").length).toBeLessThanOrEqual(3);
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
