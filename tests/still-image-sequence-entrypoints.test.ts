import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { compile } from "../runtime/compiler/index.js";
import { runEditorialPipeline } from "../scripts/editorial-pipeline.js";
import { ImageSequenceGroundingError } from "../runtime/artifacts/image-sequence-grounding.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function sequenceProject(): string {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "vos-sequence-gate-"));
  dirs.push(project);
  const analysis = path.join(project, "03_analysis");
  fs.mkdirSync(analysis, { recursive: true });
  fs.writeFileSync(path.join(analysis, "assets.json"), JSON.stringify({ items: [{
    asset_id: "AST_SEQUENCE", media_kind: "sequence",
  }] }));
  return project;
}

describe("sequence planning grounding gates", () => {
  it("keeps compile fail-closed for legacy ungrounded sequence assets", () => {
    expect(() => compile({
      projectPath: sequenceProject(), repoRoot: path.resolve("."), createdAt: "2026-01-01T00:00:00Z",
    })).toThrow(ImageSequenceGroundingError);
  });

  it("keeps editorial-pipeline direct entry fail-closed for legacy ungrounded sequence assets", async () => {
    await expect(runEditorialPipeline({
      projectDir: sequenceProject(), skipFine: true, skipRender: true, skipQa: true,
    })).rejects.toBeInstanceOf(ImageSequenceGroundingError);
  });
});
