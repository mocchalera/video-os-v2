import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { MarlinFn } from "../runtime/connectors/marlin-types.js";
import { runMarlinAnalysis } from "../runtime/pipeline/stages/marlin.js";

/**
 * Incremental evidence merge: partial Marlin evaluations must accumulate
 * in marlin_events.json rather than overwrite it, so representative
 * coverage can be built up across several bounded runs (real footage is
 * too slow to evaluate in one pass on local hardware).
 */

let projectDir: string;

const MODEL = {
  provider: "marlin",
  model_alias: "NemoStation/Marlin-2B",
  model_snapshot: "test",
} as const;

function stubMarlinFn(tag: string): MarlinFn {
  return {
    async caption() {
      return {
        scene: `scene-${tag}`,
        caption: `caption-${tag}`,
        events: [
          { start: 1, end: 2, description: `event-${tag}`, confidence: 0.7 },
        ],
      };
    },
    async find(_videoPath, event) {
      return { query: event, span: [1, 2], format_ok: true, confidence: 0.6 };
    },
  };
}

function writeAssets(assets: Array<{ id: string; file: string }>): void {
  fs.mkdirSync(path.join(projectDir, "03_analysis"), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, "03_analysis/assets.json"),
    JSON.stringify({
      project_id: "merge-fixture",
      artifact_version: "2.0.0",
      items: assets.map((a) => ({
        asset_id: a.id,
        filename: path.basename(a.file),
        source_locator: a.file,
      })),
    }),
  );
}

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "marlin-merge-"));
});

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
});

describe("marlin incremental artifact merge", () => {
  it("accumulates items across runs and replaces re-evaluated assets", async () => {
    writeAssets([
      { id: "AST_A", file: "media/a.mp4" },
      { id: "AST_B", file: "media/b.mp4" },
    ]);

    const run = (sources: string[], tag: string) =>
      runMarlinAnalysis({
        projectDir,
        projectId: "merge-fixture",
        sourceFiles: sources,
        marlinFn: stubMarlinFn(tag),
        model: MODEL,
        queries: ["q1"],
      });

    // Run 1: asset A only.
    const outputPath = await run(["media/a.mp4"], "run1");
    let artifact = JSON.parse(fs.readFileSync(outputPath, "utf-8"));
    expect(artifact.items.map((i: { asset_id: string }) => i.asset_id)).toEqual(["AST_A"]);

    // Run 2: asset B only — A must survive.
    await run(["media/b.mp4"], "run2");
    artifact = JSON.parse(fs.readFileSync(outputPath, "utf-8"));
    expect(artifact.items.map((i: { asset_id: string }) => i.asset_id).sort()).toEqual([
      "AST_A",
      "AST_B",
    ]);

    // Run 3: asset A again — replaced, not duplicated; B preserved.
    await run(["media/a.mp4"], "run3");
    artifact = JSON.parse(fs.readFileSync(outputPath, "utf-8"));
    const ids = artifact.items.map((i: { asset_id: string }) => i.asset_id);
    expect(ids.sort()).toEqual(["AST_A", "AST_B"]);
    const itemA = artifact.items.find((i: { asset_id: string }) => i.asset_id === "AST_A");
    expect(JSON.stringify(itemA)).toContain("run3");
    expect(JSON.stringify(itemA)).not.toContain("run1");
  });

  it("checkpoints completed assets before a later source fails", async () => {
    writeAssets([
      { id: "AST_A", file: "media/a.mp4" },
      { id: "AST_B", file: "media/b.mp4" },
    ]);

    let captionCount = 0;
    const failingMarlinFn: MarlinFn = {
      async caption() {
        captionCount += 1;
        if (captionCount === 2) {
          throw new Error("Marlin worker request timed out after 900000ms for caption");
        }
        return {
          scene: "scene-before-timeout",
          caption: "caption-before-timeout",
          events: [
            { start: 1, end: 2, description: "event-before-timeout", confidence: 0.7 },
          ],
        };
      },
      async find(_videoPath, event) {
        return { query: event, span: [1, 2], format_ok: true, confidence: 0.6 };
      },
    };

    await expect(
      runMarlinAnalysis({
        projectDir,
        projectId: "merge-fixture",
        sourceFiles: ["media/a.mp4", "media/b.mp4"],
        marlinFn: failingMarlinFn,
        model: MODEL,
        queries: ["q1"],
      }),
    ).rejects.toThrow("timed out");

    const artifact = JSON.parse(fs.readFileSync(path.join(projectDir, "03_analysis/marlin_events.json"), "utf-8"));
    expect(artifact.items.map((i: { asset_id: string }) => i.asset_id)).toEqual(["AST_A"]);
    expect(JSON.stringify(artifact.items[0])).toContain("before-timeout");
  });
});
