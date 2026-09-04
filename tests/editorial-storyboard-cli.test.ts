import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  parseStoryboardArgs,
  runCheckStale,
} from "../scripts/render-editorial-storyboard.js";
import { generateEditorialStoryboard } from "../runtime/review/editorial-storyboard/generate.js";
import { validateAgainstSchema } from "../runtime/commands/shared.js";
import {
  createFixtureProject,
  type FixtureProjectOptions,
} from "./helpers/editorial-storyboard-fixtures.js";

const cleanup: string[] = [];

afterEach(() => {
  while (cleanup.length > 0) {
    const dir = cleanup.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeFixture(options: FixtureProjectOptions): string {
  const dir = createFixtureProject(options);
  cleanup.push(dir);
  return dir;
}

describe("CLI argument parsing", () => {
  it("parses positional projectDir with source and delivery flags", () => {
    const args = parseStoryboardArgs(["node", "script", "/tmp/p", "--source", "timeline", "--delivery", "all"]);
    expect(args.projectDir).toBe(path.resolve("/tmp/p"));
    expect(args.sourceMode).toBe("timeline");
    expect(args.delivery).toBe("all");
  });

  it("defaults to blueprint mode and all deliveries", () => {
    const args = parseStoryboardArgs(["node", "script", "/tmp/p"]);
    expect(args.sourceMode).toBe("blueprint");
    expect(args.delivery).toBe("all");
    expect(args.skipFrames).toBe(false);
  });

  it("accepts delivery none for source-aspect projections", () => {
    const args = parseStoryboardArgs(["node", "script", "/tmp/p", "--delivery", "none"]);
    expect(args.delivery).toBeNull();
  });

  it("rejects unknown flags and missing project dir", () => {
    expect(() => parseStoryboardArgs(["node", "script", "--bogus"])).toThrow(/Unknown argument/);
    expect(() => parseStoryboardArgs(["node", "script"])).toThrow(/projectDir is required/);
    expect(() => parseStoryboardArgs(["node", "script", "/tmp/p", "--source", "nope"])).toThrow(/--source must be/);
  });
});

describe("generate + check-stale end to end (offline)", () => {
  it("generates a projection and passes the stale check while artifacts are intact", async () => {
    const projectDir = makeFixture({
      beats: [{ id: "b01", label: "hook", frames: 96, primaryRef: "CAND_A" }],
      candidates: [{ candidateId: "CAND_A", segmentId: "SEG_0001", assetId: "AST_001" }],
      deliveryProfiles: [{ profileId: "DPROF_V", platform: "shorts", aspectRatio: "9:16", width: 1080, height: 1920 }],
    });

    const result = await generateEditorialStoryboard({
      projectDir,
      sourceMode: "blueprint",
      delivery: "DPROF_V",
      generatedAt: "2026-08-01T00:00:00.000Z",
      skipFrames: true,
    });
    expect(fs.existsSync(path.join(result.projectionDir, "index.html"))).toBe(true);
    expect(validateAgainstSchema(result.manifest, "editorial-storyboard-projection.schema.json").valid).toBe(true);
    expect(validateAgainstSchema({ ...result.manifest, surprise: true }, "editorial-storyboard-projection.schema.json").valid).toBe(false);
    expect(validateAgainstSchema({ ...result.manifest, inputs: result.manifest.inputs.map((input, index) => index === 0 ? { ...input, surprise: true } : input) }, "editorial-storyboard-projection.schema.json").valid).toBe(false);

    const outcome = runCheckStale(projectDir, result.projectionDir);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.report.status).toBe("CURRENT");
    expect(outcome.report.approval_allowed).toBe(true);
  }, 20000);

  it("exits STALE (code 2) after an artifact mutation and blocks approval", async () => {
    const projectDir = makeFixture({
      beats: [{ id: "b01", label: "hook", frames: 96, primaryRef: "CAND_A" }],
      candidates: [{ candidateId: "CAND_A", segmentId: "SEG_0001", assetId: "AST_001" }],
    });
    const result = await generateEditorialStoryboard({
      projectDir,
      sourceMode: "blueprint",
      delivery: "all",
      generatedAt: "2026-08-01T00:00:00.000Z",
      skipFrames: true,
    });

    const selectsPath = path.join(projectDir, "04_plan/selects_candidates.yaml");
    fs.writeFileSync(selectsPath, `${fs.readFileSync(selectsPath, "utf-8")}\n# edited\n`);

    const outcome = runCheckStale(projectDir, result.projectionDir);
    expect(outcome.exitCode).toBe(2);
    expect(outcome.report.status).toBe("STALE");
    expect(outcome.report.approval_allowed).toBe(false);
    expect(outcome.report.regenerate_command).toContain("--source blueprint");
  }, 20000);

  it("reports an error for a nonexistent projection directory", () => {
    const projectDir = makeFixture({
      beats: [{ id: "b01", label: "hook" }],
      candidates: [{ candidateId: "CAND_A", segmentId: "SEG_0001", assetId: "AST_001" }],
    });
    const outcome = runCheckStale(projectDir, path.join(projectDir, "04_plan/review-projections/nope"));
    expect(outcome.exitCode).toBe(1);
    expect(outcome.report.ok).toBe(false);
  });

  it("writes outputs only under review-projections and tracks inputs in the manifest", async () => {
    const projectDir = makeFixture({
      beats: [{ id: "b01", label: "hook", frames: 96, primaryRef: "CAND_A" }],
      candidates: [{ candidateId: "CAND_A", segmentId: "SEG_0001", assetId: "AST_001" }],
    });
    const before = new Set(fs.readdirSync(projectDir));
    const result = await generateEditorialStoryboard({
      projectDir,
      sourceMode: "blueprint",
      delivery: "all",
      generatedAt: "2026-08-01T00:00:00.000Z",
      skipFrames: true,
    });

    const after = new Set(fs.readdirSync(projectDir));
    const added = [...after].filter((entry) => !before.has(entry));
    // The fixture pre-creates 04_plan; generation must not add anything else.
    expect(added).toEqual([]);
    // Only the projection subtree is new inside 04_plan.
    const planEntries = fs.readdirSync(path.join(projectDir, "04_plan"));
    expect(planEntries.filter((entry) => entry !== "edit_blueprint.yaml" && entry !== "selects_candidates.yaml" && entry !== "uncertainty_register.yaml")).toEqual(["review-projections"]);

    const manifest = JSON.parse(fs.readFileSync(path.join(result.projectionDir, "manifest.json"), "utf-8")) as {
      inputs: Array<{ role: string; path: string; hash: string | null }>;
      approval_identity: { artifact_hashes: Record<string, string | null> };
    };
    const roles = manifest.inputs.map((input) => input.role);
    for (const role of ["brief", "selects", "blueprint", "uncertainty"]) {
      expect(roles).toContain(role);
    }
    for (const input of manifest.inputs) {
      if (["brief", "selects", "blueprint"].includes(input.role)) {
        expect(input.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(fs.existsSync(path.join(projectDir, input.path))).toBe(true);
      }
    }
    expect(manifest.approval_identity.artifact_hashes.blueprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  }, 20000);
});
