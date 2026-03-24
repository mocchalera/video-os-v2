import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tempDirs: string[] = [];
const repoRoot = path.resolve(import.meta.dirname, "..");

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function runCli(scriptPath: string, args: string[]): CliResult {
  const env = { ...process.env };
  delete env.FORCE_COLOR;
  delete env.NO_COLOR;

  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", path.join(repoRoot, scriptPath), ...args],
    {
      cwd: repoRoot,
      encoding: "utf-8",
      env,
    },
  );

  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

function createPreviewFixtureProject(): {
  projectDir: string;
  mediaPath: string;
  timelinePath: string;
  sourceMapPath: string;
} {
  const projectDir = createTempDir("video-os-cli-project-");
  const mediaPath = path.join(projectDir, "fixtures", "ast_001.mp4");
  const timelinePath = path.join(projectDir, "05_timeline", "timeline.json");
  const sourceMapPath = path.join(projectDir, "02_media", "source_map.json");

  fs.mkdirSync(path.dirname(mediaPath), { recursive: true });

  const ffmpeg = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=64x64:d=1",
      "-an",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      mediaPath,
    ],
    { encoding: "utf-8" },
  );
  if (ffmpeg.status !== 0) {
    throw new Error(`ffmpeg fixture generation failed: ${ffmpeg.stderr}`);
  }

  writeJson(timelinePath, {
    version: "1",
    project_id: "cli-smoke",
    created_at: "2026-03-24T00:00:00Z",
    sequence: {
      name: "CLI Smoke",
      fps_num: 24,
      fps_den: 1,
      width: 1920,
      height: 1080,
      start_frame: 0,
    },
    tracks: {
      video: [
        {
          track_id: "V1",
          kind: "video",
          clips: [
            {
              clip_id: "CLP_0001",
              segment_id: "SEG_0001",
              asset_id: "AST_001",
              src_in_us: 0,
              src_out_us: 800000,
              timeline_in_frame: 0,
              timeline_duration_frames: 19,
              role: "hero",
              motivation: "smoke test clip",
              beat_id: "b01",
              fallback_segment_ids: [],
              confidence: 0.99,
              quality_flags: [],
            },
          ],
        },
      ],
      audio: [
        {
          track_id: "A1",
          kind: "audio",
          clips: [],
        },
      ],
    },
    markers: [
      {
        frame: 0,
        kind: "beat",
        label: "b01: hook",
      },
    ],
    provenance: {
      brief_path: "01_intent/creative_brief.yaml",
      blueprint_path: "04_plan/edit_blueprint.yaml",
      selects_path: "04_plan/selects_candidates.yaml",
      compiler_version: "test",
    },
  });

  writeJson(sourceMapPath, {
    AST_001: mediaPath,
  });

  return { projectDir, mediaPath, timelinePath, sourceMapPath };
}

function createProgressFixtureProject(): string {
  const projectDir = createTempDir("video-os-progress-");
  writeJson(path.join(projectDir, "progress.json"), {
    project_id: "cli-progress",
    phase: "compile",
    gate: 4,
    status: "running",
    completed: 2,
    total: 5,
    eta_sec: 12,
    artifacts_created: ["timeline.json"],
    errors: [],
    started_at: "2026-03-24T00:00:00Z",
    updated_at: "2026-03-24T00:00:05Z",
  });
  return projectDir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("check-progress CLI", () => {
  it("supports --help", () => {
    const result = runCli("scripts/check-progress.ts", ["--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: npx tsx scripts/check-progress.ts");
  });

  it("rejects invalid arguments", () => {
    const result = runCli("scripts/check-progress.ts", ["--bad-flag"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unknown argument: --bad-flag");
  });

  it("emits JSON progress output", () => {
    const projectDir = createProgressFixtureProject();
    const result = runCli("scripts/check-progress.ts", [projectDir, "--json"]);

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      project_id: string;
      phase: string;
      artifacts_created: string[];
    };
    expect(parsed.project_id).toBe("cli-progress");
    expect(parsed.phase).toBe("compile");
    expect(parsed.artifacts_created).toContain("timeline.json");
  });
});

describe("demo CLI", () => {
  it("supports --help", () => {
    const result = runCli("scripts/demo.ts", ["--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: npx tsx scripts/demo.ts");
    expect(result.stdout).toContain("Runs the deterministic demo compile");
  });

  it("rejects invalid arguments", () => {
    const result = runCli("scripts/demo.ts", ["--bad-flag"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unknown argument: --bad-flag");
  });
});

describe("preview-segment CLI", () => {
  it("supports --help", () => {
    const result = runCli("scripts/preview-segment.ts", ["--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: npx tsx scripts/preview-segment.ts");
  });

  it("rejects invalid arguments", () => {
    const projectDir = createTempDir("video-os-preview-invalid-");
    const result = runCli("scripts/preview-segment.ts", [projectDir, "--first-n-sec", "0"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--first-n-sec must be a positive integer");
  });

  it("renders an overview-only preview and reports the output path", () => {
    const fixture = createPreviewFixtureProject();
    const result = runCli("scripts/preview-segment.ts", [fixture.projectDir, "--overview-only"]);
    const overviewPath = path.join(fixture.projectDir, "05_timeline", "timeline-overview.png");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Generating timeline overview...");
    expect(result.stdout).toContain("Timeline overview:");
    expect(result.stdout).toContain("Clips: 1");
    expect(fs.existsSync(overviewPath)).toBe(true);
  });
});

describe("export-premiere-xml CLI", () => {
  it("supports --help", () => {
    const result = runCli("scripts/export-premiere-xml.ts", ["--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: npx tsx scripts/export-premiere-xml.ts");
  });

  it("rejects invalid arguments", () => {
    const result = runCli("scripts/export-premiere-xml.ts", ["--bad-flag"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unknown argument: --bad-flag");
  });

  it("exports FCP7 XML and reports the output path", () => {
    const fixture = createPreviewFixtureProject();
    const result = runCli("scripts/export-premiere-xml.ts", [fixture.projectDir]);
    const outputPath = path.join(fixture.projectDir, "09_output", "cli-smoke_premiere.xml");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Timeline: CLI Smoke");
    expect(result.stdout).toContain("Source map: 1 entries");
    expect(result.stdout).toContain("Exported:");
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(fs.readFileSync(outputPath, "utf-8")).toContain('<xmeml version="5">');
  });
});

describe("import-premiere-xml CLI", () => {
  it("supports --help", () => {
    const result = runCli("scripts/import-premiere-xml.ts", ["--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: npx tsx scripts/import-premiere-xml.ts");
  });

  it("rejects invalid arguments", () => {
    const fixture = createPreviewFixtureProject();
    const result = runCli("scripts/import-premiere-xml.ts", [fixture.projectDir]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Error: <project-path> and --xml <edited.xml> are required");
  });

  it("reports dry-run diffs as JSON", () => {
    const fixture = createPreviewFixtureProject();
    const exportResult = runCli("scripts/export-premiere-xml.ts", [fixture.projectDir]);
    const xmlPath = path.join(fixture.projectDir, "09_output", "cli-smoke_premiere.xml");

    expect(exportResult.status).toBe(0);

    const importResult = runCli("scripts/import-premiere-xml.ts", [
      fixture.projectDir,
      "--xml",
      xmlPath,
      "--dry-run",
      "--json",
    ]);

    expect(importResult.status).toBe(0);
    const parsed = JSON.parse(importResult.stdout) as {
      sequence_name: string;
      total_diffs: number;
      mapped_clips: number;
    };
    expect(parsed.sequence_name).toBe("CLI Smoke");
    expect(parsed.total_diffs).toBe(0);
    expect(parsed.mapped_clips).toBe(1);
  });
});
