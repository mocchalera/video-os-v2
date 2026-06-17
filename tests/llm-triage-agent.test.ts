import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import {
  UNRELIABLE_TRANSCRIPT_TEXT,
  buildLlmTriagePrompt,
  compactSegmentEvidence,
  createLlmTriageAgent,
  loadCompactSegmentEvidence,
  selectsFromLlmResponse,
  type LlmImagePart,
  type LlmCompleter,
} from "../runtime/agents/llm-triage-agent.js";
import { callGeminiMultimodal } from "../runtime/connectors/gemini-json.js";
import type { TriageAgentContext } from "../runtime/commands/triage.js";
import { parseArgs } from "../scripts/triage-llm.js";

const tempDirs: string[] = [];

function createProject(name: string, segments: Array<Record<string, unknown>> = defaultSegments()): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `llm-triage-${name}-`));
  fs.mkdirSync(path.join(dir, "01_intent"), { recursive: true });
  fs.mkdirSync(path.join(dir, "03_analysis"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "01_intent/creative_brief.yaml"),
    stringifyYaml({
      version: "1",
      project_id: "test-project",
      created_at: "2026-06-15T00:00:00Z",
      project: {
        id: "test-project",
        title: "LLM triage fixture",
        strategy: "message-first",
        runtime_target_sec: 30,
      },
      message: {
        primary: "Show the growth moment without over-explaining it.",
        secondary: ["visual confidence", "warm ending"],
      },
      audience: {
        primary: "family",
      },
      emotion_curve: ["setup", "attempt", "payoff"],
      must_have: ["first ride", "family reaction"],
      must_avoid: ["generic filler"],
      autonomy: {
        may_decide: ["candidate order"],
        must_ask: ["change the message"],
      },
      resolved_assumptions: ["The edit should judge b-roll visually."],
    }),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(dir, "03_analysis/segments.json"),
    JSON.stringify({ project_id: "test-project", items: segments }, null, 2),
    "utf-8",
  );
  tempDirs.push(dir);
  return dir;
}

function defaultSegments(): Array<Record<string, unknown>> {
  return [
    {
      segment_id: "SEG_001",
      asset_id: "AST_001",
      src_in_us: 1000,
      src_out_us: 5000,
      summary: "Child starts riding with training wheels.",
      tags: ["bike", "attempt"],
      transcript_excerpt: "ご視聴ありがとうございました",
      peak_analysis: {
        peak_moments: [{ peak_ref: "MEV_001", type: "visual_peak" }],
      },
    },
    {
      segment_id: "SEG_002",
      asset_id: "AST_002",
      src_in_us: 6000,
      src_out_us: 12000,
      summary: "Family reacts and smiles after the ride.",
      tags: ["reaction", "payoff"],
      transcript_excerpt: "That was the first ride.",
    },
  ];
}

function segmentsWithFilmstrips(): Array<Record<string, unknown>> {
  return defaultSegments().map((segment) => ({
    ...segment,
    filmstrip_path: `filmstrips/${String(segment.segment_id)}.png`,
  }));
}

function writeFilmstrip(projectDir: string, relPath: string, content = "fake-png"): void {
  const targetPath = path.join(projectDir, "03_analysis", relPath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content, "utf-8");
}

function context(projectDir: string, overrides: Partial<TriageAgentContext> = {}): TriageAgentContext {
  return {
    projectDir,
    projectId: "test-project",
    currentState: "media_analyzed",
    analysisGate: "ready",
    ...overrides,
  };
}

function responseFor(segmentId = "SEG_001"): string {
  const assetId = segmentId === "SEG_001" ? "AST_001" : "AST_002";
  const srcInUs = segmentId === "SEG_001" ? 1000 : 6000;
  const srcOutUs = segmentId === "SEG_001" ? 5000 : 12000;
  return JSON.stringify({
    selection_notes: ["cover the first ride and reaction"],
    editorial_summary: {
      dominant_visual_mode: "event_broll",
      speaker_topology: "unknown",
      motion_profile: "medium",
      transcript_density: "sparse",
    },
    candidates: [
      {
        segment_id: segmentId,
        asset_id: assetId,
        src_in_us: srcInUs,
        src_out_us: srcOutUs,
        role: "hero",
        why_it_matches: "Matches the must-have first ride moment.",
        confidence: 0.91,
        semantic_rank: 1,
        evidence: ["first ride"],
      },
    ],
  });
}

afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("createLlmTriageAgent", () => {
  it("returns valid selects candidates from a mocked JSON response", async () => {
    const projectDir = createProject("valid");
    const agent = createLlmTriageAgent({ llm: async () => responseFor("SEG_001") });

    const result = await agent.run(context(projectDir));

    expect(result.confirmed).toBe(true);
    expect(result.selects.version).toBe("1");
    expect(result.selects.project_id).toBe("test-project");
    expect(result.selects.selection_notes).toEqual(["cover the first ride and reaction"]);
    expect(result.selects.candidates).toHaveLength(1);
    expect(result.selects.candidates[0]).toMatchObject({
      segment_id: "SEG_001",
      asset_id: "AST_001",
      src_in_us: 1000,
      src_out_us: 5000,
      role: "hero",
      risks: [],
      confidence: 0.91,
    });
  });

  it("replaces unreliable transcripts in the prompt with visual-first guidance", async () => {
    const projectDir = createProject("transcript");
    let prompt = "";
    const llm: LlmCompleter = async (nextPrompt) => {
      prompt = nextPrompt;
      return responseFor("SEG_001");
    };
    const agent = createLlmTriageAgent({ llm });

    await agent.run(context(projectDir));

    expect(prompt).toContain(UNRELIABLE_TRANSCRIPT_TEXT);
    expect(prompt).not.toContain("ご視聴ありがとうございました");
  });

  it("includes coverage feedback gaps and correction instructions in the prompt", async () => {
    const projectDir = createProject("feedback");
    let prompt = "";
    const agent = createLlmTriageAgent({
      llm: async (nextPrompt) => {
        prompt = nextPrompt;
        return responseFor("SEG_002");
      },
    });

    await agent.run(context(projectDir, {
      coverageFeedback: {
        round: 1,
        gaps: [
          "selection sparse: 1/8 segments (13%)",
          "dense cluster (5 similar shots) under-sampled: picked 1/5 -- montage candidate may be missing",
        ],
        brief_alignment_gaps: [
          {
            axis: "must_have_coverage",
            feedback: "must_have 'aerial/drone landscape shots' has no matching candidate evidence",
          },
        ],
        previous_selection_count: 1,
      },
    }));

    expect(prompt).toContain("前回の選定で以下の不足が出た。必ず是正せよ");
    expect(prompt).toContain("selection sparse: 1/8 segments");
    expect(prompt).toContain("under-sampled な montage クラスタを増やし");
    expect(prompt).toContain("brief-alignment の不足も必ず是正せよ");
    expect(prompt).toContain("aerial/drone landscape shots");
    expect(prompt).toContain("前回選定数=1");
  });

  it("parses fenced JSON with surrounding text", async () => {
    const projectDir = createProject("fenced");
    const agent = createLlmTriageAgent({
      llm: async () => `Here is the selection:\n\`\`\`json\n${responseFor("SEG_002")}\n\`\`\`\nDone.`,
    });

    const result = await agent.run(context(projectDir));

    expect(result.selects.candidates).toHaveLength(1);
    expect(result.selects.candidates[0].segment_id).toBe("SEG_002");
  });

  it("drops candidates whose segment_id is outside the evidence pool", async () => {
    const projectDir = createProject("pool-filter");
    const agent = createLlmTriageAgent({
      llm: async () =>
        JSON.stringify({
          candidates: [
            {
              segment_id: "SEG_missing",
              asset_id: "AST_missing",
              src_in_us: 0,
              src_out_us: 100,
              role: "hero",
              why_it_matches: "not in pool",
              confidence: 0.9,
            },
            {
              segment_id: "SEG_001",
              asset_id: "AST_001",
              src_in_us: 1000,
              src_out_us: 5000,
              why_it_matches: "valid in-pool fallback role",
              confidence: 0.8,
            },
          ],
        }),
    });

    const result = await agent.run(context(projectDir));

    expect(result.selects.candidates).toHaveLength(1);
    expect(result.selects.candidates[0]).toMatchObject({
      segment_id: "SEG_001",
      role: "support",
    });
  });

  it("resolves filmstrip paths relative to the project analysis directory", () => {
    const projectDir = createProject("filmstrip-resolve", segmentsWithFilmstrips());

    const segments = loadCompactSegmentEvidence(projectDir);

    expect(segments[0].filmstrip_path).toBe(path.join(projectDir, "03_analysis/filmstrips/SEG_001.png"));
    expect(segments[1].filmstrip_path).toBe(path.join(projectDir, "03_analysis/filmstrips/SEG_002.png"));
  });

  it("passes resolved filmstrip images to the LLM with image-to-segment prompt refs", async () => {
    const projectDir = createProject("filmstrip-images", segmentsWithFilmstrips());
    writeFilmstrip(projectDir, "filmstrips/SEG_001.png", "filmstrip-one");
    writeFilmstrip(projectDir, "filmstrips/SEG_002.png", "filmstrip-two");
    const preparedPaths: string[] = [];
    let prompt = "";
    let images: LlmImagePart[] | undefined;
    const agent = createLlmTriageAgent({
      imagePreparer: async (imagePath, mimeType) => {
        preparedPaths.push(imagePath);
        return { data: Buffer.from(path.basename(imagePath)).toString("base64"), mimeType };
      },
      llm: async (nextPrompt, nextImages) => {
        prompt = nextPrompt;
        images = nextImages;
        return responseFor("SEG_001");
      },
    });

    await agent.run(context(projectDir));

    expect(preparedPaths).toEqual([
      path.join(projectDir, "03_analysis/filmstrips/SEG_001.png"),
      path.join(projectDir, "03_analysis/filmstrips/SEG_002.png"),
    ]);
    expect(images).toHaveLength(2);
    expect(images?.[0]).toEqual({
      data: Buffer.from("SEG_001.png").toString("base64"),
      mimeType: "image/png",
    });
    expect(prompt).toContain("You can see filmstrip images for each segment");
    expect(prompt).toContain('"image_index": 1');
    expect(prompt).toContain('"segment_id": "SEG_001"');
    expect(prompt).toContain('"image_index": 2');
    expect(prompt).toContain('"segment_id": "SEG_002"');
  });

  it("falls back to text-only LLM calls when filmstrip files are missing", async () => {
    const projectDir = createProject("filmstrip-missing", segmentsWithFilmstrips());
    let prompt = "";
    let images: LlmImagePart[] | undefined;
    let imagePreparerCalls = 0;
    const agent = createLlmTriageAgent({
      imagePreparer: async () => {
        imagePreparerCalls += 1;
        return { data: "unused", mimeType: "image/png" };
      },
      llm: async (nextPrompt, nextImages) => {
        prompt = nextPrompt;
        images = nextImages;
        return responseFor("SEG_001");
      },
    });

    await agent.run(context(projectDir));

    expect(imagePreparerCalls).toBe(0);
    expect(images).toBeUndefined();
    expect(prompt).toContain("No filmstrip images are attached");
  });

  it("honors text-only triage even when filmstrip files exist", async () => {
    const projectDir = createProject("text-only", segmentsWithFilmstrips());
    writeFilmstrip(projectDir, "filmstrips/SEG_001.png");
    writeFilmstrip(projectDir, "filmstrips/SEG_002.png");
    let images: LlmImagePart[] | undefined;
    let imagePreparerCalls = 0;
    const agent = createLlmTriageAgent({
      textOnlyTriage: true,
      imagePreparer: async () => {
        imagePreparerCalls += 1;
        return { data: "unused", mimeType: "image/png" };
      },
      llm: async (_nextPrompt, nextImages) => {
        images = nextImages;
        return responseFor("SEG_001");
      },
    });

    await agent.run(context(projectDir));

    expect(imagePreparerCalls).toBe(0);
    expect(images).toBeUndefined();
  });

  it("batches multimodal triage and merges parsed candidates", async () => {
    const projectDir = createProject("filmstrip-batches", segmentsWithFilmstrips());
    writeFilmstrip(projectDir, "filmstrips/SEG_001.png");
    writeFilmstrip(projectDir, "filmstrips/SEG_002.png");
    const calls: Array<{ prompt: string; images?: LlmImagePart[] }> = [];
    const agent = createLlmTriageAgent({
      multimodalBatchSize: 1,
      imagePreparer: async (imagePath, mimeType) => ({ data: Buffer.from(imagePath).toString("base64"), mimeType }),
      llm: async (nextPrompt, nextImages) => {
        calls.push({ prompt: nextPrompt, images: nextImages });
        return responseFor(nextPrompt.includes('"segment_id": "SEG_002"') ? "SEG_002" : "SEG_001");
      },
    });

    const result = await agent.run(context(projectDir));

    expect(calls).toHaveLength(2);
    expect(calls[0].prompt).toContain("segment batch 1/2");
    expect(calls[1].prompt).toContain("segment batch 2/2");
    expect(calls[0].images).toHaveLength(1);
    expect(calls[1].images).toHaveLength(1);
    expect(result.selects.candidates.map((candidate) => candidate.segment_id)).toEqual(["SEG_001", "SEG_002"]);
  });
});

describe("selectsFromLlmResponse", () => {
  const segments = compactSegmentEvidence(defaultSegments());

  it("preserves valid rich optional candidate fields", () => {
    const result = selectsFromLlmResponse({
      candidates: [
        {
          segment_id: "SEG_001",
          asset_id: "AST_001",
          src_in_us: 1000,
          src_out_us: 5000,
          role: "hero",
          story_role: "payoff",
          why_it_matches: "The wobbling first ride anchors the setup-to-payoff arc.",
          confidence: 0.9,
          eligible_beats: ["setup", "payoff"],
          motif_tags: ["child_bike_attempt", "family_growth"],
          editorial_signals: {
            visual_tags: ["training_wheels", "outdoor_path"],
            peak_type: "visual_peak",
            peak_strength_score: 0.74,
            motion_energy_score: 0.62,
            audio_energy_score: 0.31,
            semantic_cluster_id: "first_ride",
            afterglow_score: 0.51,
            reaction_intensity_score: 0.66,
            surprise_signal: 0.2,
            hope_signal: 0.8,
            face_detected: true,
            ignored_field: "drop me",
          },
          peak_signals: {
            motion: 0.88,
            audio_rms: 0.42,
            speech_keyword: ["first ride"],
            ignored_field: "drop me",
          },
          trim_hint: {
            preferred_duration_us: 3_000_000,
            min_duration_us: 2_000_000,
            max_duration_us: 4_000_000,
            interest_point_label: "first independent push",
            source_center_us: 3_000_000,
          },
        },
      ],
    }, "test-project", segments);

    const candidate = result.candidates[0] as unknown as Record<string, unknown>;
    expect(candidate.story_role).toBe("payoff");
    expect(candidate.eligible_beats).toEqual(["setup", "payoff"]);
    expect(candidate.motif_tags).toEqual(["child_bike_attempt", "family_growth"]);
    expect(candidate.editorial_signals).toEqual({
      visual_tags: ["training_wheels", "outdoor_path"],
      peak_type: "visual_peak",
      peak_strength_score: 0.74,
      motion_energy_score: 0.62,
      audio_energy_score: 0.31,
      afterglow_score: 0.51,
      reaction_intensity_score: 0.66,
      surprise_signal: 0.2,
      hope_signal: 0.8,
      semantic_cluster_id: "first_ride",
      face_detected: true,
    });
    expect(candidate.peak_signals).toEqual({
      motion: 0.88,
      audio_rms: 0.42,
      speech_keyword: ["first ride"],
    });
    expect(candidate.trim_hint).toEqual({
      preferred_duration_us: 3_000_000,
      min_duration_us: 2_000_000,
      max_duration_us: 4_000_000,
      interest_point_label: "first independent push",
    });
  });

  it("drops invalid rich optional candidate fields without failing", () => {
    const result = selectsFromLlmResponse({
      candidates: [
        {
          segment_id: "SEG_001",
          asset_id: "AST_001",
          src_in_us: 1000,
          src_out_us: 5000,
          role: "support",
          story_role: "not_a_story_role",
          why_it_matches: "Still usable.",
          confidence: 0.8,
          eligible_beats: ["setup", 42, ""],
          motif_tags: [false, "child_bike"],
          editorial_signals: {
            visual_tags: ["bike", 1],
            peak_type: "not_a_peak",
            peak_strength_score: 1.4,
            motion_energy_score: -0.1,
            audio_energy_score: "loud",
            semantic_cluster_id: "",
            face_detected: "yes",
          },
          peak_signals: {
            motion: -1,
            audio_rms: 2,
            speech_keyword: ["cheer", ""],
          },
          trim_hint: {
            preferred_duration_us: 0,
            min_duration_us: -1,
            max_duration_us: "long",
            interest_point_label: "",
          },
        },
      ],
    }, "test-project", segments);

    const candidate = result.candidates[0] as unknown as Record<string, unknown>;
    expect(candidate.story_role).toBeUndefined();
    expect(candidate.eligible_beats).toEqual(["setup"]);
    expect(candidate.motif_tags).toEqual(["child_bike"]);
    expect(candidate.editorial_signals).toEqual({ visual_tags: ["bike"] });
    expect(candidate.peak_signals).toEqual({ speech_keyword: ["cheer"] });
    expect(candidate.trim_hint).toBeUndefined();
  });

  it("preserves valid story_role values and drops invalid ones", () => {
    const result = selectsFromLlmResponse({
      candidates: [
        {
          segment_id: "SEG_001",
          asset_id: "AST_001",
          src_in_us: 1000,
          src_out_us: 5000,
          role: "hero",
          story_role: "hook",
          why_it_matches: "Opening first-ride moment.",
          confidence: 0.9,
        },
        {
          segment_id: "SEG_002",
          asset_id: "AST_002",
          src_in_us: 6000,
          src_out_us: 12000,
          role: "support",
          story_role: "middle-ish",
          why_it_matches: "Reaction moment.",
          confidence: 0.8,
        },
      ],
    }, "test-project", segments);

    expect(result.candidates[0].story_role).toBe("hook");
    expect(result.candidates[1].story_role).toBeUndefined();
  });
});

describe("compactSegmentEvidence", () => {
  it("forwards compact visual quality and interest point labels when present", () => {
    const segments = compactSegmentEvidence([
      {
        segment_id: "SEG_VQ",
        asset_id: "AST_VQ",
        src_in_us: 0,
        src_out_us: 5_000_000,
        summary: "Wide golden-hour landscape.",
        tags: ["landscape"],
        visual_quality: {
          scores: {
            light_quality: 0.9,
            composition_score: 0.8,
            invalid_score: "high",
          },
          labels: {
            lighting_style: ["golden_hour"],
            composition_tags: ["wide_angle"],
            empty: [],
          },
        },
        interest_points: [
          { frame_us: 2_000_000, label: "sun breaks over ridge", confidence: 0.8 },
          { frame_us: 3_000_000, label: "", confidence: 0.5 },
          { frame_us: 4_000_000, label: "camera tilts to valley", confidence: 0.7 },
        ],
      },
    ]);

    expect(segments[0]).toMatchObject({
      visual_quality: {
        scores: {
          light_quality: 0.9,
          composition_score: 0.8,
        },
        labels: {
          lighting_style: ["golden_hour"],
          composition_tags: ["wide_angle"],
        },
      },
      interest_point_labels: ["sun breaks over ridge", "camera tilts to valley"],
    });
  });

  it("injects a technical quality tag into summaries for clearly poor visual quality", () => {
    const segments = compactSegmentEvidence([
      {
        segment_id: "SEG_POOR",
        asset_id: "AST_POOR",
        src_in_us: 0,
        src_out_us: 5_000_000,
        summary: "Dark empty handheld shot.",
        tags: ["interior"],
        visual_quality: {
          scores: {
            light_quality: 0.1,
            composition_score: 0.2,
            subject_prominence: 0.15,
          },
        },
      },
    ]);

    expect(segments[0].summary).toBe("[TECHNICALLY_POOR] Dark empty handheld shot.");
  });

  it("does not inject a technical quality tag when visual quality is acceptable or incomplete", () => {
    const segments = compactSegmentEvidence([
      {
        segment_id: "SEG_GOOD",
        asset_id: "AST_GOOD",
        src_in_us: 0,
        src_out_us: 5_000_000,
        summary: "Subject visible in a usable composition.",
        visual_quality: {
          scores: {
            light_quality: 0.8,
            composition_score: 0.7,
            subject_prominence: 0.6,
          },
        },
      },
      {
        segment_id: "SEG_INCOMPLETE",
        asset_id: "AST_INCOMPLETE",
        src_in_us: 5_000_000,
        src_out_us: 8_000_000,
        summary: "Scores do not include all quality fields.",
        visual_quality: {
          scores: {
            composition_score: 0.1,
            subject_prominence: 0.1,
          },
        },
      },
    ]);

    expect(segments[0].summary).toBe("Subject visible in a usable composition.");
    expect(segments[1].summary).toBe("Scores do not include all quality fields.");
  });
});

describe("buildLlmTriagePrompt", () => {
  it("includes rich optional selects output instructions", () => {
    const projectDir = createProject("prompt-shape");
    const segments = loadCompactSegmentEvidence(projectDir);
    const prompt = buildLlmTriagePrompt({
      brief: {
        version: "1",
        project_id: "test-project",
        created_at: "2026-06-15T00:00:00Z",
        project: {
          id: "test-project",
          title: "LLM triage fixture",
          strategy: "message-first",
          runtime_target_sec: 30,
        },
        message: {
          primary: "Show the growth moment without over-explaining it.",
          secondary: ["visual confidence", "warm ending"],
        },
        audience: {
          primary: "family",
        },
        emotion_curve: ["setup", "attempt", "payoff"],
        must_have: ["first ride", "family reaction"],
        must_avoid: ["generic filler"],
        autonomy: {
          may_decide: ["candidate order"],
          must_ask: ["change the message"],
        },
        resolved_assumptions: ["The edit should judge b-roll visually."],
      },
      segments,
    });

    expect(prompt).toContain('"eligible_beats":["opening","landscape_scale"]');
    expect(prompt).toContain('"story_role":"experience"');
    expect(prompt).toContain('"motif_tags":["mountain_landscape","aerial_scale"]');
    expect(prompt).toContain('"editorial_signals"');
    expect(prompt).toContain('"trim_hint":{"preferred_duration_us":3000000}');
    expect(prompt).toContain("Assign a `story_role` to each candidate");
    expect(prompt).toContain("For each candidate, include eligible_beats");
    expect(prompt).toContain("Evidence must include at least one specific visual observation");
    expect(prompt).toContain("selection_notes must include notes about intended emotional progression");
    expect(prompt).toContain("selection_notes must note the intended pacing approach");
    expect(prompt).toContain("Reject technically unusable footage");
    expect(prompt).toContain("composition_score < 0.3 AND subject_prominence < 0.3");
  });
});

describe("callGeminiMultimodal", () => {
  it("sends inline image data with header-based API key auth", async () => {
    const projectDir = createProject("gemini-multimodal");
    const imagePath = path.join(projectDir, "filmstrip.png");
    fs.writeFileSync(imagePath, "image-bytes", "utf-8");
    const originalFetch = globalThis.fetch;
    const originalApiKey = process.env.GEMINI_API_KEY;
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    globalThis.fetch = (async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }],
      }), { status: 200 });
    }) as typeof fetch;

    try {
      process.env.GEMINI_API_KEY = "test-key";
      const result = await callGeminiMultimodal(
        "choose clips",
        [{ path: imagePath, mimeType: "image/png" }],
        "gemini-2.5-flash-lite",
        { maxOutputTokens: 123, temperature: 0.2 },
      );

      expect(result).toBe('{"ok":true}');
      expect(calls).toHaveLength(1);
      expect(String(calls[0].input)).not.toContain("test-key");
      expect((calls[0].init?.headers as Record<string, string>)["x-goog-api-key"]).toBe("test-key");
      const body = JSON.parse(String(calls[0].init?.body)) as {
        contents: Array<{ parts: Array<Record<string, unknown>> }>;
        generationConfig: Record<string, unknown>;
      };
      expect(body.contents[0].parts).toEqual([
        {
          inline_data: {
            mime_type: "image/png",
            data: Buffer.from("image-bytes").toString("base64"),
          },
        },
        { text: "choose clips" },
      ]);
      expect(body.generationConfig).toMatchObject({
        maxOutputTokens: 123,
        temperature: 0.2,
        responseMimeType: "application/json",
      });
    } finally {
      globalThis.fetch = originalFetch;
      if (originalApiKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = originalApiKey;
    }
  });

  it("falls back to a text-only Gemini request when no images are provided", async () => {
    const originalFetch = globalThis.fetch;
    const originalApiKey = process.env.GEMINI_API_KEY;
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    globalThis.fetch = (async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: '{"textOnly":true}' }] } }],
      }), { status: 200 });
    }) as typeof fetch;

    try {
      process.env.GEMINI_API_KEY = "test-key";
      const result = await callGeminiMultimodal("text prompt", [], "gemini-2.5-flash-lite");

      expect(result).toBe('{"textOnly":true}');
      const body = JSON.parse(String(calls[0].init?.body)) as {
        contents: Array<{ parts: Array<Record<string, unknown>> }>;
      };
      expect(body.contents[0].parts).toEqual([{ text: "text prompt" }]);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalApiKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = originalApiKey;
    }
  });
});

describe("triage-llm CLI args", () => {
  it("parses --text-only-triage", () => {
    expect(parseArgs(["node", "triage-llm", "projects/demo", "--text-only-triage"])).toEqual({
      projectDir: "projects/demo",
      model: undefined,
      textOnlyTriage: true,
    });
  });
});
