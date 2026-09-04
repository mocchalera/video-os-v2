import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import {
  MARLIN_CAMERA_MOTION_CONFIDENCE_PENALTY,
  MARLIN_CAMERA_MOTION_START_FLAG,
} from "../runtime/analysis/camera-motion.js";
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

function segmentsWithMarlinProvenance(segments: Array<Record<string, unknown>> = defaultSegments()): Array<Record<string, unknown>> {
  return segments.map((segment) => ({
    ...segment,
    provenance: {
      ...(segment.provenance as Record<string, unknown> | undefined),
      summary: {
        method: "marlin_reporter",
        stage: "marlin",
        prompt_template_id: "marlin-caption-v1",
      },
    },
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

function codexJsonl(text: string): string {
  return `${JSON.stringify({ type: "agent_message", message: text })}\n`;
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

  it("records decision_runtime when using the default editorial connector", async () => {
    const projectDir = createProject("decision-runtime");
    const agent = createLlmTriageAgent({
      editorialLlm: {
        runtime: "codex_exec",
        commandExists: (command) => command === "codex",
        executor: async () => ({
          stdout: codexJsonl(responseFor("SEG_001")),
          stderr: "",
        }),
        env: {},
      },
    });

    const result = await agent.run(context(projectDir));

    expect(result.selects.decision_runtime).toMatchObject({
      runtime: "codex_exec",
      role: "triage-llm",
      author: "llm",
    });
    expect(result.selects.decision_runtime?.attempted_runtimes?.[0]).toMatchObject({
      runtime: "codex_exec",
      status: "success",
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
      textOnlyTriage: false, // explicit multimodal opt-in
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

  it("defaults to text-only triage when segments have Marlin scene provenance", async () => {
    const projectDir = createProject("marlin-text-default", segmentsWithMarlinProvenance(segmentsWithFilmstrips()));
    writeFilmstrip(projectDir, "filmstrips/SEG_001.png");
    writeFilmstrip(projectDir, "filmstrips/SEG_002.png");
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
    expect(prompt).toContain('"scene_report": "Child starts riding with training wheels."');
  });

  it("batches multimodal triage and merges parsed candidates", async () => {
    const projectDir = createProject("filmstrip-batches", segmentsWithFilmstrips());
    writeFilmstrip(projectDir, "filmstrips/SEG_001.png");
    writeFilmstrip(projectDir, "filmstrips/SEG_002.png");
    const calls: Array<{ prompt: string; images?: LlmImagePart[] }> = [];
    const agent = createLlmTriageAgent({
      textOnlyTriage: false, // explicit multimodal opt-in
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

  it("preserves an authored freeze at source frame zero for video", () => {
    const videoSegments = [{
      ...segments[0],
      src_in_us: 0,
      media_kind: "video" as const,
      source_capabilities: { has_video: true, has_audio: true },
    }];
    const result = selectsFromLlmResponse({
      candidates: [{
        segment_id: "SEG_001",
        asset_id: "AST_001",
        src_in_us: 0,
        src_out_us: 5000,
        role: "hero",
        why_it_matches: "Hold the authored apex.",
        confidence: 0.9,
        freeze_frame_hold: { source_time_us: 0, hold_frames: 33 },
      }],
    }, "test-project", videoSegments);

    expect(result.candidates[0].freeze_frame_hold).toEqual({
      source_time_us: 0,
      hold_frames: 33,
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

  it("applies segment confidence penalties from camera-motion quality gates", () => {
    const segments = compactSegmentEvidence(defaultSegments());
    segments[0].quality_flags = [MARLIN_CAMERA_MOTION_START_FLAG];
    segments[0].confidence_penalty = MARLIN_CAMERA_MOTION_CONFIDENCE_PENALTY;

    const result = selectsFromLlmResponse({
      candidates: [
        {
          segment_id: "SEG_001",
          asset_id: "AST_001",
          src_in_us: 1000,
          src_out_us: 5000,
          role: "hero",
          why_it_matches: "Opening first-ride moment.",
          confidence: 0.9,
        },
      ],
    }, "test-project", segments);

    expect(result.candidates[0].confidence).toBeCloseTo(0.72);
    expect(result.candidates[0].risks).toContain(MARLIN_CAMERA_MOTION_START_FLAG);
  });
});

describe("compactSegmentEvidence", () => {
  it("forwards Marlin scene report and Gemini appraisal fields when present", () => {
    const segments = compactSegmentEvidence(segmentsWithMarlinProvenance([
      {
        segment_id: "SEG_APPRAISAL",
        asset_id: "AST_APPRAISAL",
        src_in_us: 0,
        src_out_us: 5_000_000,
        summary: "Soba shop frontage with a hand-written menu board.",
        visual_appraisal: {
          extracted_text: [
            { text: "戸隠そば", confidence: 0.93 },
            { text: "季節の天ぷら", confidence: 0.87 },
            { text: "", confidence: 0.99 },
          ],
          place_hint: {
            name: "Togakushi soba restaurant",
            confidence: 0.76,
          },
          aesthetic_notes: ["warm window light", "layered signage depth", ""],
        },
      },
    ]));

    expect(segments[0]).toMatchObject({
      scene_report: "Soba shop frontage with a hand-written menu board.",
      extracted_text: ["戸隠そば", "季節の天ぷら"],
      place_hint: "Togakushi soba restaurant",
      aesthetic_notes: ["warm window light", "layered signage depth"],
    });
  });

  it("keeps compact evidence backward compatible without visual_appraisal", () => {
    const segments = compactSegmentEvidence([
      {
        segment_id: "SEG_LEGACY",
        asset_id: "AST_LEGACY",
        src_in_us: 0,
        src_out_us: 5_000_000,
        summary: "Legacy VLM-only segment.",
      },
    ]);

    expect(segments[0]).not.toHaveProperty("extracted_text");
    expect(segments[0]).not.toHaveProperty("place_hint");
    expect(segments[0]).not.toHaveProperty("aesthetic_notes");
  });

  it("adds a camera-motion confidence penalty from Marlin first-event evidence", () => {
    const projectDir = createProject("marlin-camera-motion", [
      {
        segment_id: "SEG_CAMERA",
        asset_id: "AST_CAMERA",
        src_in_us: 0,
        src_out_us: 5_000_000,
        summary: "Handheld opening shot before the view settles.",
      },
    ]);
    fs.writeFileSync(
      path.join(projectDir, "03_analysis/marlin_events.json"),
      JSON.stringify({
        project_id: "test-project",
        artifact_version: "marlin-events-v1",
        model: {
          provider: "marlin",
          model_alias: "test",
          model_snapshot: "test",
        },
        items: [
          {
            asset_id: "AST_CAMERA",
            source_path: "media/camera.mp4",
            scene: "camera opening",
            events: [
              {
                event_id: "MEV_CAMERA_001",
                start_us: 0,
                end_us: 1_500_000,
                description: "camera stabilizes after recording starts",
                confidence: 0.9,
                source_pass: "marlin_caption",
              },
            ],
            find_results: [],
          },
        ],
      }, null, 2),
      "utf-8",
    );

    const segments = loadCompactSegmentEvidence(projectDir);

    expect(segments[0].quality_flags).toContain(MARLIN_CAMERA_MOTION_START_FLAG);
    expect(segments[0].confidence_penalty).toBe(MARLIN_CAMERA_MOTION_CONFIDENCE_PENALTY);
    expect(segments[0].aesthetic_notes?.[0]).toContain("camera setup/motion");
  });

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
        context_knowledge: {
          key_items: [
            {
              name: "栗きんとん",
              description: "Chestnut confection",
              significance: "Small round objects handled with tongs are chestnuts, not insects.",
            },
          ],
          terminology: [
            {
              term: "栗",
              meaning: "Chestnuts - the small round objects being handled are NOT insects",
            },
          ],
        },
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
    expect(prompt).toContain("Use `place_hint` to identify location-specific content for the brief");
    expect(prompt).toContain("Use `extracted_text` to identify signage, menus, or labels relevant to the brief");
    expect(prompt).toContain("Use `aesthetic_notes` to prefer visually strong clips");
    expect(prompt).toContain('"context_knowledge"');
    expect(prompt).toContain("Chestnuts - the small round objects being handled are NOT insects");
    expect(prompt).toContain("Use `context_knowledge` to correct likely subject");
    expect(prompt).toContain("focus_sharpness` < 0.3");
    expect(prompt).toContain("subject_prominence` < 0.2");
    expect(prompt).toContain("lower confidence significantly");
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

  it("parses --multimodal as an explicit filmstrip opt-in", () => {
    expect(parseArgs(["node", "triage-llm", "projects/demo", "--multimodal"])).toEqual({
      projectDir: "projects/demo",
      model: undefined,
      textOnlyTriage: false,
    });
  });
});

function imageSegments(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_unused, index) => {
    const n = String(index + 1).padStart(3, "0");
    return {
      segment_id: `SEG_${n}`,
      asset_id: `AST_${n}`,
      src_in_us: (index + 1) * 1000,
      src_out_us: (index + 1) * 1000 + 4000,
      summary: `Segment ${n} summary.`,
      tags: ["batch-fixture"],
      transcript_excerpt: "",
      filmstrip_path: `filmstrips/SEG_${n}.png`,
    };
  });
}

interface BatchCall {
  prompt: string;
  images?: LlmImagePart[];
}

/** Responds with one valid candidate for the first segment in each batch. */
function batchResponder(): { llm: LlmCompleter; calls: BatchCall[] } {
  const calls: BatchCall[] = [];
  const llm: LlmCompleter = async (prompt, images) => {
    calls.push({ prompt, images });
    const match = prompt.match(/"segment_id": "(SEG_\d+)"/);
    const segmentId = match?.[1] ?? "SEG_001";
    return JSON.stringify({
      candidates: [
        {
          segment_id: segmentId,
          asset_id: segmentId.replace("SEG", "AST"),
          role: "support",
          why_it_matches: "bounded batch responder candidate",
          confidence: 0.8,
        },
      ],
    });
  };
  return { llm, calls };
}

describe("bounded triage batching (Issue #5 M3)", () => {
  const originalBatchDelay = process.env.VOS_TRIAGE_BATCH_DELAY_MS;

  beforeAll(() => {
    process.env.VOS_TRIAGE_BATCH_DELAY_MS = "0";
  });

  afterAll(() => {
    if (originalBatchDelay === undefined) delete process.env.VOS_TRIAGE_BATCH_DELAY_MS;
    else process.env.VOS_TRIAGE_BATCH_DELAY_MS = originalBatchDelay;
  });

  it("splits a 13-image pool into multiple bounded batches by default", async () => {
    const projectDir = createProject("batch-13-images", imageSegments(13));
    for (let i = 1; i <= 13; i += 1) {
      writeFilmstrip(projectDir, `filmstrips/SEG_${String(i).padStart(3, "0")}.png`);
    }
    const { llm, calls } = batchResponder();
    const agent = createLlmTriageAgent({
      textOnlyTriage: false, // explicit multimodal opt-in
      imagePreparer: async (imagePath, mimeType) => ({
        data: Buffer.from(path.basename(imagePath)).toString("base64"),
        mimeType,
      }),
      llm,
    });

    const result = await agent.run(context(projectDir));

    expect(calls).toHaveLength(2); // default bound 8 -> batches of 8 + 5
    expect(calls[0].images).toHaveLength(8);
    expect(calls[1].images).toHaveLength(5);
    expect(calls[0].prompt).toContain("segment batch 1/2");
    expect(calls[1].prompt).toContain("segment batch 2/2");
    expect(result.selects.candidates.map((candidate) => candidate.segment_id)).toEqual([
      "SEG_001",
      "SEG_009",
    ]);
  });

  it("resumes from the batch checkpoint without re-calling completed batches", async () => {
    const projectDir = createProject("batch-resume", imageSegments(4));
    for (let i = 1; i <= 4; i += 1) {
      writeFilmstrip(projectDir, `filmstrips/SEG_${String(i).padStart(3, "0")}.png`);
    }
    const first = batchResponder();
    const firstAgent = createLlmTriageAgent({
      textOnlyTriage: false, // explicit multimodal opt-in
      multimodalBatchSize: 2,
      imagePreparer: async () => null,
      llm: first.llm,
    });
    const firstResult = await firstAgent.run(context(projectDir));

    expect(first.calls).toHaveLength(2);
    expect(fs.existsSync(path.join(projectDir, "03_analysis/llm-triage-batches.json"))).toBe(true);

    const second = batchResponder();
    const secondAgent = createLlmTriageAgent({
      textOnlyTriage: false, // explicit multimodal opt-in
      multimodalBatchSize: 2,
      imagePreparer: async () => null,
      llm: second.llm,
    });
    const secondResult = await secondAgent.run(context(projectDir));

    expect(second.calls).toHaveLength(0);
    expect(secondResult.selects.candidates.map((candidate) => candidate.segment_id)).toEqual(
      firstResult.selects.candidates.map((candidate) => candidate.segment_id),
    );
  });

  it("avoids stale checkpoint reuse when segment input changes", async () => {
    const segments = imageSegments(2);
    const projectDir = createProject("batch-stale-input", segments);
    const first = batchResponder();
    await createLlmTriageAgent({ multimodalBatchSize: 1, llm: first.llm }).run(context(projectDir));
    expect(first.calls).toHaveLength(2);

    segments[0].summary = "Segment 001 summary changed.";
    fs.writeFileSync(
      path.join(projectDir, "03_analysis/segments.json"),
      JSON.stringify({ project_id: "test-project", items: segments }, null, 2),
      "utf-8",
    );

    const second = batchResponder();
    await createLlmTriageAgent({ multimodalBatchSize: 1, llm: second.llm }).run(context(projectDir));
    expect(second.calls).toHaveLength(2); // stale plan signature -> re-run all batches
  });

  it("re-calls batches when coverage feedback changes the prompt input", async () => {
    const projectDir = createProject("batch-coverage-feedback", imageSegments(2));
    const first = batchResponder();
    await createLlmTriageAgent({ multimodalBatchSize: 1, llm: first.llm }).run(context(projectDir));
    expect(first.calls).toHaveLength(2);

    const second = batchResponder();
    await createLlmTriageAgent({ multimodalBatchSize: 1, llm: second.llm }).run(context(projectDir, {
      coverageFeedback: {
        round: 1,
        gaps: ["selection sparse: 1/2 segments (50%)"],
        previous_selection_count: 2,
      },
    }));
    expect(second.calls).toHaveLength(2); // different signatures -> no stale reuse
  });

  it("keeps successful batches and records stable failure reasons on partial failure", async () => {
    const projectDir = createProject("batch-partial", imageSegments(2));
    const calls: string[] = [];
    const agent = createLlmTriageAgent({
      multimodalBatchSize: 1,
      llm: async (prompt) => {
        calls.push(prompt);
        if (prompt.includes('"segment_id": "SEG_002"')) {
          throw new Error("LLM triage response was not valid JSON after retry: boom");
        }
        return JSON.stringify({
          candidates: [
            {
              segment_id: "SEG_001",
              asset_id: "AST_001",
              role: "support",
              why_it_matches: "surviving batch candidate",
              confidence: 0.8,
            },
          ],
        });
      },
    });

    const result = await agent.run(context(projectDir));

    expect(result.confirmed).toBe(true);
    expect(result.selects.candidates.map((candidate) => candidate.segment_id)).toEqual(["SEG_001"]);
    const batchAttempt = result.selects.decision_runtime?.attempted_runtimes?.find(
      (attempt) => attempt.runtime === "triage_batch",
    );
    expect(batchAttempt?.status).toBe("failed");
    expect(batchAttempt?.message).toContain("json_parse");
    expect(result.selects.decision_runtime?.fallback_warnings?.join("\n")).toContain("failed: json_parse");
    expect(result.selects.selection_notes?.join("\n")).toContain("partial triage: 1/2");
    const provenance = (result.selects as { provenance?: { triage_batches?: { failed_batches?: Array<{ reason: string }> } } }).provenance;
    expect(provenance?.triage_batches?.failed_batches?.[0]?.reason).toBe("json_parse");
  });

  it("makes no LLM call after the stage deadline and returns a schema-valid deterministic fallback", async () => {
    const projectDir = createProject("batch-deadline", imageSegments(13));
    const { llm, calls } = batchResponder();
    const agent = createLlmTriageAgent({ stageTimeoutMs: 0, llm });

    const result = await agent.run(context(projectDir));

    expect(calls).toHaveLength(0);
    expect(result.confirmed).toBe(true);
    // Deterministic fallback covers every valid segment so the artifact keeps
    // its schema-valid non-empty candidates array.
    expect(result.selects.candidates).toHaveLength(13);
    expect((result.selects.decision_runtime as { author?: string } | undefined)?.author).toBe(
      "deterministic_fallback",
    );
    expect(result.selects.decision_runtime?.fallback_warnings?.join("\n")).toContain(
      "skipped after stage deadline",
    );
  });

  it("keeps standard triage text-only on Marlin evidence while bounding batch size", async () => {
    const marlinSegments = segmentsWithMarlinProvenance(imageSegments(13)).map((segment) => {
      const { filmstrip_path: _filmstrip_path, ...rest } = segment;
      return rest;
    });
    const projectDir = createProject("batch-marlin-text", marlinSegments);
    const { llm, calls } = batchResponder();
    let imagePreparerCalls = 0;
    const agent = createLlmTriageAgent({
      imagePreparer: async () => {
        imagePreparerCalls += 1;
        return null;
      },
      llm,
    });

    const result = await agent.run(context(projectDir));

    expect(imagePreparerCalls).toBe(0);
    expect(calls).toHaveLength(2); // text-only still bounded to 8 per call
    expect(calls.every((call) => call.images === undefined)).toBe(true);
    expect(calls[0].prompt).toContain('"scene_report":');
    expect(result.selects.candidates.map((candidate) => candidate.segment_id)).toEqual([
      "SEG_001",
      "SEG_009",
    ]);
  });
});

describe("bounded triage batching guardrails (Issue #5 M3 review fixtures)", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    savedEnv.delay = process.env.VOS_TRIAGE_BATCH_DELAY_MS;
    process.env.VOS_TRIAGE_BATCH_DELAY_MS = "0";
  });

  afterAll(() => {
    if (savedEnv.delay === undefined) delete process.env.VOS_TRIAGE_BATCH_DELAY_MS;
    else process.env.VOS_TRIAGE_BATCH_DELAY_MS = savedEnv.delay;
  });

  it("clamps an oversized batch override so 13 images still split into multiple bounded batches", async () => {
    const projectDir = createProject("batch-clamp-override", imageSegments(13));
    for (let i = 1; i <= 13; i += 1) {
      writeFilmstrip(projectDir, `filmstrips/SEG_${String(i).padStart(3, "0")}.png`);
    }
    const { llm, calls } = batchResponder();
    const agent = createLlmTriageAgent({
      textOnlyTriage: false, // explicit multimodal opt-in
      multimodalBatchSize: 1000, // oversized override must be clamped
      imagePreparer: async (imagePath, mimeType) => ({
        data: Buffer.from(path.basename(imagePath)).toString("base64"),
        mimeType,
      }),
      llm,
    });

    await agent.run(context(projectDir));

    expect(calls.length).toBeGreaterThanOrEqual(2); // never a single bulk call
    expect(calls[0].images!.length).toBeLessThanOrEqual(12);
    expect(calls[0].images!.length + calls[1].images!.length).toBe(13);
  });

  it("never regenerates an exhausted stage deadline across coverage retries", async () => {
    const projectDir = createProject("batch-deadline-retry", imageSegments(2));
    const calls: string[] = [];
    const slowLlm: LlmCompleter = async (prompt) => {
      calls.push(prompt);
      await new Promise((resolve) => setTimeout(resolve, 150));
      return JSON.stringify({
        candidates: [
          {
            segment_id: "SEG_001",
            asset_id: "AST_001",
            role: "support",
            why_it_matches: "slow responder candidate",
            confidence: 0.8,
          },
        ],
      });
    };
    const agent = createLlmTriageAgent({ multimodalBatchSize: 1, stageTimeoutMs: 50, llm: slowLlm });

    // Initial run: the first batch call exhausts the budget, later batches are
    // skipped without a call.
    await agent.run(context(projectDir));
    expect(calls).toHaveLength(1);

    // Coverage retry on the SAME agent instance must reuse the exhausted
    // deadline: no fresh budget, no new LLM calls.
    await agent.run(context(projectDir, {
      coverageFeedback: {
        round: 1,
        gaps: ["selection sparse: 1/2 segments (50%)"],
        previous_selection_count: 1,
      },
    }));
    expect(calls).toHaveLength(1);
  });

  it("normalizes checkpoint payloads and never repersists raw provider fields", async () => {
    const projectDir = createProject("batch-checkpoint-purity", imageSegments(2));
    const first = batchResponder();
    await createLlmTriageAgent({ multimodalBatchSize: 1, llm: first.llm }).run(context(projectDir));
    expect(first.calls).toHaveLength(2);

    // Tamper with the persisted checkpoint: inject raw provider payload,
    // prompt, and error text at top level and inside a candidate; make the
    // second batch invalid.
    const checkpointPath = path.join(projectDir, "03_analysis/llm-triage-batches.json");
    const tampered = JSON.parse(fs.readFileSync(checkpointPath, "utf-8")) as {
      batches: Array<{ index: number; parsed: Record<string, unknown> }>;
    };
    tampered.batches[0].parsed.raw_response = "SECRET-RAW-RESPONSE";
    tampered.batches[0].parsed.prompt = "SECRET-PROMPT";
    tampered.batches[0].parsed.error = "SECRET-ERROR";
    (tampered.batches[0].parsed.candidates as Array<Record<string, unknown>>)[0].raw_response =
      "SECRET-CANDIDATE-RAW";
    tampered.batches[1].parsed = { candidates: [] }; // invalid: no canonical candidate
    fs.writeFileSync(checkpointPath, JSON.stringify(tampered, null, 2), "utf-8");

    const second = batchResponder();
    const result = await createLlmTriageAgent({ multimodalBatchSize: 1, llm: second.llm }).run(
      context(projectDir),
    );

    // Batch 1 reused after sanitization (no re-call); batch 2 invalid -> called.
    expect(second.calls).toHaveLength(1);
    const serialized = JSON.stringify(result.selects);
    expect(serialized).not.toContain("SECRET-RAW-RESPONSE");
    expect(serialized).not.toContain("SECRET-PROMPT");
    expect(serialized).not.toContain("SECRET-ERROR");
    expect(serialized).not.toContain("SECRET-CANDIDATE-RAW");

    // The rewritten checkpoint is clean too.
    const rewritten = fs.readFileSync(checkpointPath, "utf-8");
    expect(rewritten).not.toContain("SECRET-RAW-RESPONSE");
    expect(rewritten).not.toContain("SECRET-PROMPT");
    expect(rewritten).not.toContain("SECRET-CANDIDATE-RAW");
    expect(result.selects.candidates.map((candidate) => candidate.segment_id)).toEqual([
      "SEG_001",
      "SEG_002",
    ]);
  });

  it("never attaches images in standard triage even when filmstrips exist", async () => {
    const projectDir = createProject("batch-default-no-images", imageSegments(2));
    for (let i = 1; i <= 2; i += 1) {
      writeFilmstrip(projectDir, `filmstrips/SEG_${String(i).padStart(3, "0")}.png`);
    }
    let imagePreparerCalls = 0;
    const { llm, calls } = batchResponder();
    const agent = createLlmTriageAgent({
      imagePreparer: async () => {
        imagePreparerCalls += 1;
        return null;
      },
      llm,
    });

    const result = await agent.run(context(projectDir));

    expect(imagePreparerCalls).toBe(0);
    expect(calls.every((call) => call.images === undefined)).toBe(true);
    // Single bounded batch (2 <= default 8): one call, one candidate.
    expect(calls).toHaveLength(1);
    expect(result.selects.candidates.map((candidate) => candidate.segment_id)).toEqual(["SEG_001"]);
  });
});

describe("bounded triage batching runtime binding (Issue #5 M3)", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    savedEnv.delay = process.env.VOS_TRIAGE_BATCH_DELAY_MS;
    savedEnv.triageModel = process.env.TRIAGE_MODEL;
    process.env.VOS_TRIAGE_BATCH_DELAY_MS = "0";
    delete process.env.TRIAGE_MODEL;
  });

  afterAll(() => {
    if (savedEnv.delay === undefined) delete process.env.VOS_TRIAGE_BATCH_DELAY_MS;
    else process.env.VOS_TRIAGE_BATCH_DELAY_MS = savedEnv.delay;
    if (savedEnv.triageModel === undefined) delete process.env.TRIAGE_MODEL;
    else process.env.TRIAGE_MODEL = savedEnv.triageModel;
  });

  it("avoids checkpoint reuse when the resolved runtime/model configuration changes", async () => {
    const projectDir = createProject("batch-runtime-snapshot", imageSegments(2));
    const first = batchResponder();
    await createLlmTriageAgent({ multimodalBatchSize: 1, llm: first.llm }).run(context(projectDir));
    expect(first.calls).toHaveLength(2);

    // Same project/input, different effective model configuration: the plan
    // signature must change so saved batches are never reused across it.
    process.env.TRIAGE_MODEL = "gemini-2.5-flash";
    const second = batchResponder();
    await createLlmTriageAgent({ multimodalBatchSize: 1, llm: second.llm }).run(context(projectDir));
    expect(second.calls).toHaveLength(2);
  });
});

describe("triage batching review fixes (review 3962110b seq1)", () => {
  const savedEnv: Record<string, string | undefined> = {};

  function candidateResponse(segmentId: string): string {
    return JSON.stringify({
      candidates: [
        {
          segment_id: segmentId,
          asset_id: segmentId.replace("SEG", "AST"),
          role: "support",
          why_it_matches: "review fixture candidate",
          confidence: 0.8,
        },
      ],
    });
  }

  beforeAll(() => {
    savedEnv.delay = process.env.VOS_TRIAGE_BATCH_DELAY_MS;
    process.env.VOS_TRIAGE_BATCH_DELAY_MS = "0";
  });

  afterAll(() => {
    if (savedEnv.delay === undefined) delete process.env.VOS_TRIAGE_BATCH_DELAY_MS;
    else process.env.VOS_TRIAGE_BATCH_DELAY_MS = savedEnv.delay;
  });

  it("never starts an injected JSON repair call after the stage deadline", async () => {
    const projectDir = createProject("review-deadline-repair-injected", imageSegments(2));
    const calls: Array<{ prompt: string }> = [];
    const agent = createLlmTriageAgent({
      stageTimeoutMs: 20,
      llm: async (prompt) => {
        calls.push({ prompt });
        await new Promise((resolve) => setTimeout(resolve, 35));
        return "{not valid json"; // forces the repair path
      },
    });

    const result = await agent.run(context(projectDir));

    expect(calls).toHaveLength(1); // initial call only; repair never started
    expect(result.selects.decision_runtime?.fallback_warnings?.join("\n")).toContain(
      "failed: transport_timeout",
    );
  });

  it("never starts a connector JSON repair call after the stage deadline", async () => {
    const projectDir = createProject("review-deadline-repair-connector", imageSegments(2));
    let executorCalls = 0;
    const agent = createLlmTriageAgent({
      editorialLlm: {
        stageTimeoutMs: 20,
        env: {},
        commandExists: (command) => command === "codex",
        executor: async () => {
          executorCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 35));
          return { stdout: "NOT JSON", stderr: "" }; // forces the repair path
        },
      },
    });

    const result = await agent.run(context(projectDir));

    expect(executorCalls).toBe(1); // initial executor call; repair skipped
    expect(result.confirmed).toBe(true);
  });

  it("honors a nested editorialLlm stage timeout of zero with zero executor calls", async () => {
    const projectDir = createProject("review-nested-timeout-zero", imageSegments(2));
    let executorCalls = 0;
    const agent = createLlmTriageAgent({
      editorialLlm: {
        stageTimeoutMs: 0,
        env: {},
        commandExists: () => false,
        executor: async () => {
          executorCalls += 1;
          return { stdout: "", stderr: "" };
        },
      },
    });

    const result = await agent.run(context(projectDir));

    expect(executorCalls).toBe(0);
    expect(result.selects.decision_runtime?.fallback_warnings?.join("\n")).toContain(
      "skipped after stage deadline",
    );
  });

  it("keeps the remaining shared budget authoritative over a larger nested stage timeout", async () => {
    const projectDir = createProject("review-nested-timeout-spread", imageSegments(1));
    const seenTimeouts: number[] = [];
    const agent = createLlmTriageAgent({
      stageTimeoutMs: 50,
      editorialLlm: {
        stageTimeoutMs: 999_999,
        env: {},
        commandExists: (command) => command === "codex",
        executor: async (execInput) => {
          seenTimeouts.push(execInput.timeoutMs);
          return { stdout: "", stderr: "" };
        },
      },
    });

    await agent.run(context(projectDir));

    // Every executor invocation (initial + repair) receives only the shared
    // remaining budget, never the larger nested 999_999 value.
    expect(seenTimeouts.length).toBeGreaterThanOrEqual(1);
    expect(Math.max(...seenTimeouts)).toBeLessThanOrEqual(50);
  });

  it("preserves previously completed checkpoint entries when other batches fail or succeed later", async () => {
    const projectDir = createProject("review-checkpoint-union", imageSegments(2));
    let failSeg001 = true;
    const flaky: LlmCompleter = async (prompt) => {
      if (prompt.includes('"segment_id": "SEG_001"') && failFirst()) return Promise.reject(new Error("flaky batch"));
      const match = prompt.match(/"segment_id": "(SEG_\d+)"/);
      return candidateResponse(match?.[1] ?? "SEG_001");
      function failFirst(): boolean {
        return failSeg001;
      }
    };

    // Run A: batch 1 (SEG_001) fails; only batch 2 reaches the checkpoint.
    await createLlmTriageAgent({ multimodalBatchSize: 1, llm: flaky }).run(context(projectDir));
    const afterA = JSON.parse(
      fs.readFileSync(path.join(projectDir, "03_analysis/llm-triage-batches.json"), "utf-8"),
    ) as { batches: Array<{ index: number }> };
    expect(afterA.batches.map((batch) => batch.index)).toEqual([1]);

    // Run B: batch 1 succeeds now; batch 2 resumes. Both must be persisted.
    failSeg001 = false;
    await createLlmTriageAgent({ multimodalBatchSize: 1, llm: flaky }).run(context(projectDir));
    const afterB = JSON.parse(
      fs.readFileSync(path.join(projectDir, "03_analysis/llm-triage-batches.json"), "utf-8"),
    ) as { batches: Array<{ index: number }> };
    expect(afterB.batches.map((batch) => batch.index)).toEqual([0, 1]);

    // Run C: fully covered -> zero LLM calls, both candidates present.
    const thirdCalls: string[] = [];
    const result = await createLlmTriageAgent({
      multimodalBatchSize: 1,
      llm: async (prompt) => {
        thirdCalls.push(prompt);
        return candidateResponse("SEG_001");
      },
    }).run(context(projectDir));
    expect(thirdCalls).toHaveLength(0);
    expect(result.selects.candidates.map((candidate) => candidate.segment_id)).toEqual([
      "SEG_001",
      "SEG_002",
    ]);
  });

  it("re-calls every batch when the completion path switches from injected to connector", async () => {
    const projectDir = createProject("review-path-switch", imageSegments(2));
    const injected = batchResponder();
    await createLlmTriageAgent({ multimodalBatchSize: 1, llm: injected.llm }).run(context(projectDir));
    expect(injected.calls).toHaveLength(2);

    const geminiTextCalls: string[] = [];
    const result = await createLlmTriageAgent({
      multimodalBatchSize: 1,
      editorialLlm: {
        env: { GEMINI_API_KEY: "test-key" },
        commandExists: () => false,
        geminiText: async (prompt) => {
          geminiTextCalls.push(prompt);
          const match = prompt.match(/"segment_id": "(SEG_\d+)"/);
          return candidateResponse(match?.[1] ?? "SEG_001");
        },
      },
    }).run(context(projectDir));

    expect(geminiTextCalls).toHaveLength(2); // completion_path mismatch -> no stale reuse
    expect(result.selects.decision_runtime?.runtime).toBe("gemini");
  });

  it("keeps codex_exec runtime identity across a fully-resumed connector run", async () => {
    const projectDir = createProject("review-codex-resume", imageSegments(2));
    let executorCalls = 0;
    const codexExecutor = async (execInput: { input?: string }) => {
      executorCalls += 1;
      const match = (execInput.input ?? "").match(/"segment_id": "(SEG_\d+)"/);
      return {
        stdout: `${JSON.stringify({ type: "item.completed", message: candidateResponse(match?.[1] ?? "SEG_001") })}\n`,
        stderr: "",
      };
    };
    const connectorOpts = {
      env: {},
      commandExists: (command: string) => command === "codex",
      executor: codexExecutor,
    };

    await createLlmTriageAgent({ multimodalBatchSize: 1, editorialLlm: connectorOpts }).run(context(projectDir));
    expect(executorCalls).toBe(2);

    const result = await createLlmTriageAgent({ multimodalBatchSize: 1, editorialLlm: connectorOpts }).run(
      context(projectDir),
    );

    expect(executorCalls).toBe(2); // full resume: zero new calls
    expect(result.selects.candidates.map((candidate) => candidate.segment_id)).toEqual([
      "SEG_001",
      "SEG_002",
    ]);
    expect(result.selects.decision_runtime).toEqual({
      runtime: "codex_exec",
      role: "triage-llm",
      author: "llm",
      attempted_runtimes: [{
        runtime: "codex_exec",
        status: "success",
        message: "resumed from triage batch checkpoint",
      }],
    });
  });

  it("keeps deterministic and injected triage provenance distinct from connector resume", async () => {
    const deterministicProject = createProject("review-resume-negative-deterministic", imageSegments(2));
    const deterministic = await createLlmTriageAgent({
      multimodalBatchSize: 1,
      editorialLlm: { runtime: "deterministic", env: {} },
    }).run(context(deterministicProject));

    expect(deterministic.selects.decision_runtime).toMatchObject({
      runtime: "deterministic",
      role: "triage-llm",
      author: "deterministic_fallback",
    });

    const injectedProject = createProject("review-resume-negative-injected", imageSegments(2));
    const injectedResponder = batchResponder();
    const injected = await createLlmTriageAgent({
      multimodalBatchSize: 1,
      llm: injectedResponder.llm,
    }).run(context(injectedProject));

    expect(injectedResponder.calls).toHaveLength(2);
    expect(injected.selects.decision_runtime).toEqual({
      runtime: "injected",
      role: "triage-llm",
      attempted_runtimes: [{
        runtime: "deterministic",
        status: "skipped",
        message: "injected test/runtime completer",
      }],
    });
  });
});

describe("triage batching nested-env runtime binding (review follow-up)", () => {
  const savedEnv: Record<string, string | undefined> = {};

  function nestedCandidate(segmentId: string): string {
    return JSON.stringify({
      candidates: [
        {
          segment_id: segmentId,
          asset_id: segmentId.replace("SEG", "AST"),
          role: "support",
          why_it_matches: "nested env binding candidate",
          confidence: 0.8,
        },
      ],
    });
  }

  beforeAll(() => {
    savedEnv.delay = process.env.VOS_TRIAGE_BATCH_DELAY_MS;
    process.env.VOS_TRIAGE_BATCH_DELAY_MS = "0";
    delete process.env.TRIAGE_MODEL;
    delete process.env.GEMINI_API_KEY;
  });

  afterAll(() => {
    if (savedEnv.delay === undefined) delete process.env.VOS_TRIAGE_BATCH_DELAY_MS;
    else process.env.VOS_TRIAGE_BATCH_DELAY_MS = savedEnv.delay;
  });

  it("re-calls every batch when the nested connector env model changes", async () => {
    const projectDir = createProject("review-nested-env-model-change", imageSegments(2));
    let geminiTextCalls = 0;
    const geminiOpts = (triageModel: string) => ({
      env: { TRIAGE_MODEL: triageModel, GEMINI_API_KEY: "test-key" },
      commandExists: () => false,
      geminiText: async (prompt: string) => {
        geminiTextCalls += 1;
        const match = prompt.match(/"segment_id": "(SEG_\d+)"/);
        return nestedCandidate(match?.[1] ?? "SEG_001");
      },
    });

    // Run A completes all batches under model-a.
    await createLlmTriageAgent({ multimodalBatchSize: 1, editorialLlm: geminiOpts("model-a") }).run(
      context(projectDir),
    );
    expect(geminiTextCalls).toBe(2);

    // Run B with the same project/input but nested env model-b must never
    // stale-resume the model-a results.
    await createLlmTriageAgent({ multimodalBatchSize: 1, editorialLlm: geminiOpts("model-b") }).run(
      context(projectDir),
    );
    expect(geminiTextCalls).toBe(4);
  });
});

describe("triage batch wait deadline", () => {
  it("caps the multimodal inter-batch wait at the remaining stage budget", async () => {
    const projectDir = createProject("batch-delay-deadline", imageSegments(2));
    const originalDelay = process.env.VOS_TRIAGE_BATCH_DELAY_MS;
    process.env.VOS_TRIAGE_BATCH_DELAY_MS = "1000";
    const { llm, calls } = batchResponder();

    try {
      const startedAt = Date.now();
      const result = await createLlmTriageAgent({
        textOnlyTriage: false,
        multimodalBatchSize: 1,
        stageTimeoutMs: 120,
        llm,
      }).run(context(projectDir));

      expect(calls).toHaveLength(1);
      expect(result.selects.decision_runtime?.fallback_warnings?.join("\n")).toContain(
        "batch 2/2 skipped after stage deadline",
      );
      expect(Date.now() - startedAt).toBeLessThan(500);
    } finally {
      if (originalDelay === undefined) delete process.env.VOS_TRIAGE_BATCH_DELAY_MS;
      else process.env.VOS_TRIAGE_BATCH_DELAY_MS = originalDelay;
    }
  });
});
