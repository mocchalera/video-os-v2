import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cleanupAnalysisSourceArtifacts } from "../runtime/pipeline/analysis-artifact-cleanup.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vos-artifact-cleanup-${name}-`));
  tempDirs.push(dir);
  return dir;
}

function makeArtifactDirectory(root: string, name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "artifact.bin"), name);
  return dir;
}

describe("analysis source artifact cleanup", () => {
  it("is a no-op when both artifact roots are absent", () => {
    const projectDir = tempDir("absent");

    expect(() => cleanupAnalysisSourceArtifacts({
      projectDir,
      currentStillAssetIds: new Set(["AST_CURRENT"]),
      currentImageSequenceGroupIds: new Set(["SEQ_CURRENT"]),
    })).not.toThrow();
    expect(fs.existsSync(path.join(projectDir, "03_analysis"))).toBe(false);
  });

  it("removes only stale directories while preserving current directories, files, and symlinks", () => {
    const projectDir = tempDir("mixed");
    const outsideDir = tempDir("outside");
    const stillRoot = path.join(projectDir, "03_analysis", "still_frames");
    const sequenceRoot = path.join(projectDir, "03_analysis", "image_sequences");
    const currentStill = makeArtifactDirectory(stillRoot, "AST_CURRENT");
    const staleStill = makeArtifactDirectory(stillRoot, "AST_STALE");
    const currentSequence = makeArtifactDirectory(sequenceRoot, "SEQ_CURRENT");
    const staleSequence = makeArtifactDirectory(sequenceRoot, "SEQ_STALE");
    const outsideArtifact = makeArtifactDirectory(outsideDir, "outside-artifact");
    fs.writeFileSync(path.join(stillRoot, "README.txt"), "keep");
    fs.writeFileSync(path.join(sequenceRoot, "README.txt"), "keep");
    fs.symlinkSync(outsideArtifact, path.join(stillRoot, "AST_LINK"));
    fs.symlinkSync(outsideArtifact, path.join(sequenceRoot, "SEQ_LINK"));

    cleanupAnalysisSourceArtifacts({
      projectDir,
      currentStillAssetIds: new Set(["AST_CURRENT"]),
      currentImageSequenceGroupIds: new Set(["SEQ_CURRENT"]),
    });

    expect(fs.existsSync(currentStill)).toBe(true);
    expect(fs.existsSync(currentSequence)).toBe(true);
    expect(fs.existsSync(staleStill)).toBe(false);
    expect(fs.existsSync(staleSequence)).toBe(false);
    expect(fs.readFileSync(path.join(stillRoot, "README.txt"), "utf-8")).toBe("keep");
    expect(fs.readFileSync(path.join(sequenceRoot, "README.txt"), "utf-8")).toBe("keep");
    expect(fs.lstatSync(path.join(stillRoot, "AST_LINK")).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(sequenceRoot, "SEQ_LINK")).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(outsideArtifact, "artifact.bin"), "utf-8")).toBe("outside-artifact");
  });

  it("removes all generated directories for an empty current success set", () => {
    const projectDir = tempDir("empty-current");
    const stillRoot = path.join(projectDir, "03_analysis", "still_frames");
    const sequenceRoot = path.join(projectDir, "03_analysis", "image_sequences");
    makeArtifactDirectory(stillRoot, "AST_OLD_A");
    makeArtifactDirectory(stillRoot, "AST_OLD_B");
    makeArtifactDirectory(sequenceRoot, "SEQ_OLD_A");
    fs.writeFileSync(path.join(stillRoot, "keep.txt"), "keep");

    cleanupAnalysisSourceArtifacts({
      projectDir,
      currentStillAssetIds: new Set(),
      currentImageSequenceGroupIds: new Set(),
    });

    expect(fs.readdirSync(stillRoot)).toEqual(["keep.txt"]);
    expect(fs.readdirSync(sequenceRoot)).toEqual([]);
  });
});
