import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { loadCreativeBrief, validateArtifact } from "../runtime/artifacts/loaders.js";
import type { CreativeBrief } from "../runtime/artifacts/types.js";
import type { MarlinEventsArtifact } from "../runtime/connectors/marlin-types.js";
import { applyMarlinEventsToSegments } from "../runtime/pipeline/stages/marlin.js";
import { runContextInterview } from "../scripts/context-interview.js";

const tempDirs: string[] = [];

function minimalBrief(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: "1",
    project_id: "context-test",
    created_at: "2026-06-18T00:00:00Z",
    project: {
      id: "context-test",
      title: "Context Test",
      strategy: "message-first",
      runtime_target_sec: 30,
    },
    message: {
      primary: "Show the real local product clearly.",
    },
    audience: {
      primary: "visitors",
    },
    emotion_curve: ["setup", "detail", "payoff"],
    must_have: ["local product"],
    must_avoid: ["misidentified subjects"],
    autonomy: {
      may_decide: ["clip order"],
      must_ask: ["change the product claim"],
    },
    resolved_assumptions: ["Context knowledge is optional and additive."],
    ...overrides,
  };
}

function contextKnowledge(): Record<string, unknown> {
  return {
    location: {
      primary_location: "Ena City, Gifu Prefecture, Japan",
      specific_places: [
        {
          name: "Ena Gorge",
          description: "Scenic gorge with rock formations",
        },
      ],
    },
    subjects: [
      {
        name: "Local artisans",
        role: "craftspeople",
        appearance: "working in workshops",
      },
    ],
    key_items: [
      {
        name: "Kuri kinton",
        description: "Chestnut confection",
        significance: "The small round objects handled with tongs are chestnuts.",
      },
    ],
    cultural_context: "Rural mountain town known for seasonal chestnut sweets.",
    terminology: [
      {
        term: "栗",
        meaning: "Chestnuts - the small round objects being handled are NOT insects",
      },
    ],
  };
}

function makeProject(brief: Record<string, unknown> = minimalBrief()): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-os-context-"));
  tempDirs.push(projectDir);
  fs.mkdirSync(path.join(projectDir, "01_intent"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, "03_analysis"), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, "01_intent", "creative_brief.yaml"),
    stringifyYaml(brief),
    "utf-8",
  );
  return projectDir;
}

function writeSegments(projectDir: string): void {
  fs.writeFileSync(
    path.join(projectDir, "03_analysis", "segments.json"),
    JSON.stringify({
      project_id: "context-test",
      artifact_version: "2.0.0",
      items: [
        {
          segment_id: "SEG_CHESTNUT_0001",
          asset_id: "AST_CHESTNUT",
          src_in_us: 0,
          src_out_us: 4_000_000,
          summary: "Uncorrected placeholder.",
          transcript_excerpt: "",
          quality_flags: [],
          tags: [],
        },
      ],
    }, null, 2),
    "utf-8",
  );
}

function marlinArtifact(scene: string): MarlinEventsArtifact {
  return {
    project_id: "context-test",
    artifact_version: "marlin-events-v1",
    model: {
      provider: "marlin",
      model_alias: "marlin-test",
      model_snapshot: "test",
      inference_mode: "mock",
    },
    items: [
      {
        asset_id: "AST_CHESTNUT",
        source_path: "media/chestnut.mp4",
        scene,
        events: [],
        find_results: [],
      },
    ],
  };
}

afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("context_knowledge", () => {
  it("validates creative briefs with optional context knowledge and keeps legacy briefs valid", () => {
    expect(() => validateArtifact<CreativeBrief>(minimalBrief(), "creative-brief.schema.json")).not.toThrow();

    expect(() => validateArtifact<CreativeBrief>({
      ...minimalBrief(),
      context_knowledge: contextKnowledge(),
    }, "creative-brief.schema.json")).not.toThrow();

    expect(() => validateArtifact<CreativeBrief>({
      ...minimalBrief(),
      context_knowledge: {
        ...contextKnowledge(),
        unknown_field: "closed schema should reject this",
      },
    }, "creative-brief.schema.json")).toThrow(/additional properties/);
  });

  it("writes headless context YAML into creative_brief.yaml and leaves it schema-valid", async () => {
    const projectDir = makeProject();
    const contextPath = path.join(projectDir, "context.yaml");
    fs.writeFileSync(
      contextPath,
      stringifyYaml({ context_knowledge: contextKnowledge() }),
      "utf-8",
    );
    let output = "";

    const briefPath = await runContextInterview(
      { projectDir, contextPath },
      { output: { write: (chunk: string) => { output += chunk; } } },
    );

    const loaded = loadCreativeBrief(briefPath) as CreativeBrief & {
      context_knowledge?: Record<string, unknown>;
    };
    expect(output).toContain("Wrote context_knowledge");
    expect(loaded.context_knowledge?.key_items).toEqual([
      {
        name: "Kuri kinton",
        description: "Chestnut confection",
        significance: "The small round objects handled with tongs are chestnuts.",
      },
    ]);
  });

  it("applies deterministic terminology corrections and appends location context to Marlin summaries", () => {
    const projectDir = makeProject({
      ...minimalBrief(),
      context_knowledge: contextKnowledge(),
    });
    writeSegments(projectDir);

    expect(applyMarlinEventsToSegments(
      projectDir,
      marlinArtifact("Tweezers grasping a caterpillar."),
    )).toBe(true);

    const segments = JSON.parse(fs.readFileSync(path.join(projectDir, "03_analysis", "segments.json"), "utf-8")) as {
      items: Array<{ summary: string }>;
    };
    expect(segments.items[0].summary).toContain("Tongs picking up chestnuts.");
    expect(segments.items[0].summary).toContain("Location context: Ena City, Gifu Prefecture, Japan.");
    expect(segments.items[0].summary).toContain("Ena Gorge (Scenic gorge with rock formations)");
  });

  it("leaves Marlin summaries unchanged when briefs have no context knowledge", () => {
    const projectDir = makeProject();
    writeSegments(projectDir);

    expect(applyMarlinEventsToSegments(
      projectDir,
      marlinArtifact("Tweezers grasping a caterpillar."),
    )).toBe(true);

    const segments = JSON.parse(fs.readFileSync(path.join(projectDir, "03_analysis", "segments.json"), "utf-8")) as {
      items: Array<{ summary: string }>;
    };
    expect(segments.items[0].summary).toBe("Tweezers grasping a caterpillar.");
  });
});
