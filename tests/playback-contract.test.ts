import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  computeFileHash16,
  evaluatePlaybackContract,
} from "../runtime/preview/playback-contract.js";
import { compile } from "../runtime/compiler/index.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const demoDir = path.join(repoRoot, "projects/demo");

let workdir: string;

beforeEach(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), "playback-contract-"));
});

afterEach(() => {
  fs.rmSync(workdir, { recursive: true, force: true });
});

function writeProject(files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const filePath = path.join(workdir, rel);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
}

describe("computeFileHash16", () => {
  it("matches the canonical sha256-16 definition", () => {
    const p = path.join(workdir, "f.txt");
    fs.writeFileSync(p, "hello");
    // sha256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
    expect(computeFileHash16(p)).toBe("2cf24dba5fb0a30e");
  });
});

describe("evaluatePlaybackContract", () => {
  it("reports missing_timeline when nothing exists", () => {
    expect(evaluatePlaybackContract(workdir).state).toBe("missing_timeline");
  });

  it("reports missing_manifest when only the timeline exists", () => {
    writeProject({ "05_timeline/timeline.json": "{}" });
    const status = evaluatePlaybackContract(workdir);
    expect(status.state).toBe("missing_manifest");
    expect(status.timeline_hash).not.toBeNull();
  });

  it("reports legacy_manifest when the manifest carries no hash", () => {
    writeProject({
      "05_timeline/timeline.json": "{}",
      "05_timeline/preview-manifest.json": JSON.stringify({ version: "1" }),
    });
    expect(evaluatePlaybackContract(workdir).state).toBe("legacy_manifest");
  });

  it("reports exact when the manifest hash matches the timeline", () => {
    writeProject({ "05_timeline/timeline.json": '{"v":1}' });
    const hash = computeFileHash16(path.join(workdir, "05_timeline/timeline.json"));
    writeProject({
      "05_timeline/preview-manifest.json": JSON.stringify({
        version: "1",
        base_timeline_hash: hash,
      }),
    });
    const status = evaluatePlaybackContract(workdir);
    expect(status.state).toBe("exact");
    expect(status.manifest_base_timeline_hash).toBe(status.timeline_hash);
  });

  it("reports stale after the timeline changes", () => {
    writeProject({ "05_timeline/timeline.json": '{"v":1}' });
    const hash = computeFileHash16(path.join(workdir, "05_timeline/timeline.json"));
    writeProject({
      "05_timeline/preview-manifest.json": JSON.stringify({
        version: "1",
        base_timeline_hash: hash,
      }),
      "05_timeline/timeline.json": '{"v":2}',
    });
    expect(evaluatePlaybackContract(workdir).state).toBe("stale");
  });
});

describe("compiler stamps the contract", () => {
  it("compile() produces an exact playback contract", () => {
    for (const rel of ["01_intent", "03_analysis", "04_plan"]) {
      fs.cpSync(path.join(demoDir, rel), path.join(workdir, rel), { recursive: true });
    }
    compile({
      projectPath: workdir,
      repoRoot,
      createdAt: "2026-06-12T00:00:00.000Z",
    });

    const status = evaluatePlaybackContract(workdir);
    expect(status.state).toBe("exact");

    // Editing the timeline afterwards must flip the contract to stale.
    const timelinePath = path.join(workdir, "05_timeline/timeline.json");
    const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf-8"));
    timeline.tracks.video[0].clips[0].timeline_duration_frames += 1;
    fs.writeFileSync(timelinePath, JSON.stringify(timeline, null, 2));
    expect(evaluatePlaybackContract(workdir).state).toBe("stale");
  });
});
