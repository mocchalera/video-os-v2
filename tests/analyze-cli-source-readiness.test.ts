import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { main as runAnalyzeCli } from "../scripts/analyze.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("analyze CLI source readiness", () => {
  it("persists canonical failure artifacts before returning from corrupt audio and missing preflight", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vos-analyze-cli-"));
    tempDirs.push(root);
    const projectDir = path.join(root, "project-directory");
    const sourceDir = path.join(root, "sources");
    fs.mkdirSync(projectDir);
    fs.mkdirSync(sourceDir);
    fs.writeFileSync(
      path.join(projectDir, "project_state.yaml"),
      "version: 1\nproject_id: cli-canonical-id\ncurrent_state: initialized\nhistory: []\n",
    );
    const audio = path.join(sourceDir, "voice.WAV");
    const missing = path.join(sourceDir, "missing.mp4");
    fs.writeFileSync(audio, "not-probed-because-unsupported");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await runAnalyzeCli([
      process.execPath,
      "scripts/analyze.ts",
      audio,
      missing,
      "--project",
      projectDir,
      "--skip-marlin",
    ]);

    expect(code).toBe(1);
    const ledger = JSON.parse(fs.readFileSync(path.join(projectDir, "03_analysis/source_ledger.json"), "utf-8")) as {
      project_id: string;
      summary: { requested: number; ready: number; unsupported: number; failed: number };
    };
    expect(ledger.project_id).toBe("cli-canonical-id");
    expect(ledger.summary).toEqual({ requested: 2, ready: 0, unsupported: 0, failed: 2 });
    for (const relativePath of [
      "02_media/source_media_manifest.json",
      "03_analysis/analysis_coverage_report.json",
      "03_analysis/assets.json",
      "03_analysis/segments.json",
      "03_analysis/gap_report.yaml",
    ]) {
      expect(fs.existsSync(path.join(projectDir, relativePath)), relativePath).toBe(true);
    }
  });
});
