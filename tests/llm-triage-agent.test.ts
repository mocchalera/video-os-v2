import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import {
  UNRELIABLE_TRANSCRIPT_TEXT,
  createLlmTriageAgent,
  type LlmCompleter,
} from "../runtime/agents/llm-triage-agent.js";
import type { TriageAgentContext } from "../runtime/commands/triage.js";

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
        previous_selection_count: 1,
      },
    }));

    expect(prompt).toContain("前回の選定で以下の不足が出た。必ず是正せよ");
    expect(prompt).toContain("selection sparse: 1/8 segments");
    expect(prompt).toContain("under-sampled な montage クラスタを増やし");
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
});
