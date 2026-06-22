import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("footage-search-cli", () => {
  it("requires --project and --json", () => {
    const missingProject = runCli(["--mode", "text", "--query", "chestnut", "--json"]);
    expect(missingProject.status).toBe(1);
    expect(missingProject.stderr).toContain("--project is required");

    const projectDir = makeProject();
    const missingJson = runCli(["--project", projectDir, "--mode", "text", "--query", "chestnut"]);
    expect(missingJson.status).toBe(1);
    expect(missingJson.stderr).toContain("--json is required");
  });

  it("prints FootageSearchResponse JSON for text search", () => {
    const projectDir = makeProject();
    const result = runCli([
      "--project",
      projectDir,
      "--mode",
      "text",
      "--query",
      "chestnut",
      "--limit",
      "5",
      "--json",
    ]);

    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout) as {
      query: { query: string; mode: string; limit: number };
      db_status: string;
      mode_used: string;
      results: Array<{
        segment_id: string;
        asset_id: string;
        src_in_us: number;
        src_out_us: number;
        score: number;
        scores: Record<string, unknown>;
        key_frame_path?: string;
        tags: string[];
        quality_flags: string[];
        summary: string;
        metadata?: Record<string, unknown>;
      }>;
      warnings: string[];
    };

    expect(json.query).toMatchObject({ query: "chestnut", mode: "text", limit: 5 });
    expect(json.db_status).toBe("fallback");
    expect(json.mode_used).toBe("text");
    expect(Array.isArray(json.results)).toBe(true);
    expect(Array.isArray(json.warnings)).toBe(true);
    expect(json.results[0]).toMatchObject({
      segment_id: "SEG_food",
      asset_id: "AST_food",
      src_in_us: 0,
      src_out_us: 4_000_000,
      tags: ["chestnut", "food"],
      quality_flags: [],
      summary: "warm closeup of chestnut preparation",
    });
    expect(typeof json.results[0].score).toBe("number");
    expect(typeof json.results[0].scores.lexical).toBe("number");
  });

  it("resolves relative --image-query-path from the project directory", () => {
    const projectDir = makeProject();
    writeBinary(projectDir, "03_analysis/query.jpg", Buffer.from("not-a-real-jpeg"));

    const result = runCli([
      "--project",
      projectDir,
      "--mode",
      "visual",
      "--image-query-path",
      "03_analysis/query.jpg",
      "--json",
    ]);

    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout) as {
      query: { image_query_path?: string };
      warnings: string[];
    };

    expect(json.query.image_query_path).toBe(path.resolve(projectDir, "03_analysis/query.jpg"));
    expect(json.warnings).not.toContain("image_query_path must be an absolute path");
  });

  it("returns a runtime validation error when --image-query-path resolves outside the project", () => {
    const projectDir = makeProject();
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "footage-search-cli-outside-"));
    tempDirs.push(outsideDir);
    const outsideImagePath = path.join(outsideDir, "query.jpg");
    fs.writeFileSync(outsideImagePath, "not-a-real-jpeg");

    const result = runCli([
      "--project",
      projectDir,
      "--mode",
      "visual",
      "--image-query-path",
      outsideImagePath,
      "--json",
    ]);

    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout) as {
      results: unknown[];
      warnings: string[];
    };

    expect(json.results).toEqual([]);
    expect(json.warnings).toContain(
      `image_query_path must resolve under the project root or approved frame cache directories: ${outsideImagePath}`,
    );
  });

  it("exits with an error for invalid mode", () => {
    const projectDir = makeProject();
    const result = runCli(["--project", projectDir, "--mode", "semantic", "--query", "chestnut", "--json"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--mode must be text, visual, audio, hybrid, or multimodal");
  });
});

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("npx", ["tsx", "runtime/tools/footage-search-cli.ts", ...args], {
    cwd: path.resolve("."),
    encoding: "utf-8",
    env: {
      ...process.env,
      VOS_QWEN3VL_MOCK: "1",
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function makeProject(): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "footage-search-cli-"));
  tempDirs.push(projectDir);
  fs.mkdirSync(path.join(projectDir, "03_analysis"), { recursive: true });
  writeJson(projectDir, "03_analysis/assets.json", {
    project_id: "footage-search-cli-fixture",
    artifact_version: "assets-v1",
    items: [
      {
        asset_id: "AST_food",
        filename: "food.mov",
        duration_us: 8_000_000,
        has_transcript: false,
        tags: ["food"],
        quality_flags: [],
        source_locator: "02_media/food.mov",
        source_fingerprint: "sha256:food",
      },
      {
        asset_id: "AST_river",
        filename: "river.mov",
        duration_us: 12_000_000,
        has_transcript: false,
        tags: ["river"],
        quality_flags: [],
        source_locator: "02_media/river.mov",
        source_fingerprint: "sha256:river",
      },
    ],
  });
  writeJson(projectDir, "03_analysis/segments.json", {
    project_id: "footage-search-cli-fixture",
    artifact_version: "segments-v1",
    items: [
      {
        segment_id: "SEG_food",
        asset_id: "AST_food",
        src_in_us: 0,
        src_out_us: 4_000_000,
        rep_frame_us: 2_000_000,
        segment_type: "action",
        summary: "warm closeup of chestnut preparation",
        transcript_excerpt: "",
        tags: ["chestnut", "food"],
        quality_flags: [],
        visual_quality: {
          scores: {
            light_quality: 0.9,
            subject_prominence: 0.85,
            emotional_expression: 0.5,
            composition_score: 0.92,
            motion_quality: 0.8,
          },
        },
      },
      {
        segment_id: "SEG_river",
        asset_id: "AST_river",
        src_in_us: 0,
        src_out_us: 6_000_000,
        rep_frame_us: 3_000_000,
        segment_type: "static",
        summary: "quiet river water in the mountain",
        transcript_excerpt: "",
        tags: ["river", "water", "mountain"],
        quality_flags: [],
      },
    ],
  });
  return projectDir;
}

function writeJson(projectDir: string, relPath: string, value: unknown): void {
  const filePath = path.join(projectDir, relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeBinary(projectDir: string, relPath: string, value: Buffer): void {
  const filePath = path.join(projectDir, relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value);
}
