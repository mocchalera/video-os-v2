import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  checkApiKeys,
  checkBinary,
  checkDiskSpace,
  checkShellCompat,
  checkSourceFolder,
  runPreflight,
} from "../scripts/preflight.js";

// ── Helpers ───────────────────────────────────────────────────────

const TMP_BASE = path.join("tests", `tmp_preflight_${Date.now()}`);

function mkTmpDir(name: string): string {
  const dir = path.join(TMP_BASE, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function createDummyFile(dir: string, name: string, sizeBytes: number): void {
  fs.writeFileSync(path.join(dir, name), Buffer.alloc(sizeBytes));
}

// ── Setup / Teardown ──────────────────────────────────────────────

beforeAll(() => {
  fs.mkdirSync(TMP_BASE, { recursive: true });
});

afterAll(() => {
  if (fs.existsSync(TMP_BASE)) {
    fs.rmSync(TMP_BASE, { recursive: true, force: true });
  }
});

// ── API key checks ────────────────────────────────────────────────

describe("checkApiKeys", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns pass when both keys are set", () => {
    process.env.GEMINI_API_KEY = "test-key";
    process.env.GROQ_API_KEY = "test-key";
    const results = checkApiKeys();
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === "pass")).toBe(true);
  });

  it("returns warn when GEMINI_API_KEY is missing", () => {
    delete process.env.GEMINI_API_KEY;
    process.env.GROQ_API_KEY = "test-key";
    const results = checkApiKeys();
    const gemini = results.find((r) => r.name === "GEMINI_API_KEY");
    expect(gemini?.status).toBe("warn");
  });

  it("returns warn when GROQ_API_KEY is missing", () => {
    process.env.GEMINI_API_KEY = "test-key";
    delete process.env.GROQ_API_KEY;
    const results = checkApiKeys();
    const groq = results.find((r) => r.name === "GROQ_API_KEY");
    expect(groq?.status).toBe("warn");
  });

  it("returns warn for both when neither is set", () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GROQ_API_KEY;
    const results = checkApiKeys();
    expect(results.every((r) => r.status === "warn")).toBe(true);
  });
});

// ── Binary checks ─────────────────────────────────────────────────

describe("checkBinary", () => {
  it("finds ffmpeg if installed", () => {
    const result = checkBinary("ffmpeg");
    // ffmpeg is expected to be installed in dev; if not, this test
    // simply documents the check behavior.
    expect(result.name).toBe("ffmpeg");
    expect(["pass", "fail"]).toContain(result.status);
  });

  it("fails for a nonexistent binary", () => {
    const result = checkBinary("__nonexistent_binary_xyz__");
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("not found");
  });
});

// ── Source folder checks ──────────────────────────────────────────

describe("checkSourceFolder", () => {
  it("passes when folder has video files", () => {
    const dir = mkTmpDir("with-videos");
    createDummyFile(dir, "clip1.mp4", 1024);
    createDummyFile(dir, "clip2.mov", 2048);

    const result = checkSourceFolder(dir);
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("2 video file(s)");
  });

  it("fails when folder does not exist", () => {
    const result = checkSourceFolder(path.join(TMP_BASE, "no-such-folder"));
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("not found");
  });

  it("fails when folder has no video files", () => {
    const dir = mkTmpDir("no-videos");
    createDummyFile(dir, "readme.txt", 100);
    createDummyFile(dir, "photo.jpg", 200);

    const result = checkSourceFolder(dir);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("no video files");
  });

  it("fails when path is a file, not a directory", () => {
    const dir = mkTmpDir("file-not-dir");
    const filePath = path.join(dir, "not-a-dir.mp4");
    createDummyFile(dir, "not-a-dir.mp4", 100);

    const result = checkSourceFolder(filePath);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("not a directory");
  });

  it("reports total size correctly", () => {
    const dir = mkTmpDir("size-check");
    createDummyFile(dir, "a.mp4", 1024 * 1024); // 1 MB
    createDummyFile(dir, "b.mov", 1024 * 1024); // 1 MB

    const result = checkSourceFolder(dir);
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("2.0 MB");
  });
});

// ── Disk space check ──────────────────────────────────────────────

describe("checkDiskSpace", () => {
  it("passes for a small temp folder (dev disk should have space)", () => {
    const dir = mkTmpDir("disk-check");
    createDummyFile(dir, "tiny.mp4", 1024);

    const result = checkDiskSpace(dir);
    // Dev machines should have enough space for 2 KB
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("available");
  });
});

// ── Shell compatibility ───────────────────────────────────────────

describe("checkShellCompat", () => {
  const originalShell = process.env.SHELL;

  afterEach(() => {
    if (originalShell !== undefined) {
      process.env.SHELL = originalShell;
    } else {
      delete process.env.SHELL;
    }
  });

  it("passes for non-zsh shell", () => {
    process.env.SHELL = "/bin/bash";
    const result = checkShellCompat();
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("bash");
  });

  it("checks zsh null_glob when shell is zsh", () => {
    process.env.SHELL = "/bin/zsh";
    const result = checkShellCompat();
    expect(result.name).toBe("shell_compat");
    // Either pass or warn is acceptable depending on the user's zsh config
    expect(["pass", "warn"]).toContain(result.status);
  });
});

// ── Full runPreflight ─────────────────────────────────────────────

describe("runPreflight", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns ok=true for a valid source folder with all deps", () => {
    process.env.GEMINI_API_KEY = "test";
    process.env.GROQ_API_KEY = "test";

    const dir = mkTmpDir("full-pass");
    createDummyFile(dir, "video.mp4", 1024);

    const result = runPreflight(dir);

    // ok should be true only if ffmpeg/ffprobe are installed
    const ffmpegCheck = result.checks.find((c) => c.name === "ffmpeg");
    const ffprobeCheck = result.checks.find((c) => c.name === "ffprobe");
    if (ffmpegCheck?.status === "pass" && ffprobeCheck?.status === "pass") {
      expect(result.ok).toBe(true);
    }

    // Structure check
    expect(result.checks.length).toBeGreaterThanOrEqual(6);
    expect(result.checks.every((c) => ["pass", "warn", "fail"].includes(c.status))).toBe(true);
  });

  it("returns ok=false when source folder is missing", () => {
    const result = runPreflight(path.join(TMP_BASE, "nonexistent"));
    expect(result.ok).toBe(false);
    const folderCheck = result.checks.find((c) => c.name === "source_folder");
    expect(folderCheck?.status).toBe("fail");
  });

  it("returns ok=false when source folder has no video files", () => {
    const dir = mkTmpDir("no-video-full");
    createDummyFile(dir, "notes.txt", 100);

    const result = runPreflight(dir);
    expect(result.ok).toBe(false);
  });

  it("skips disk_space check when source_folder fails", () => {
    const result = runPreflight(path.join(TMP_BASE, "nonexistent-skip"));
    const diskCheck = result.checks.find((c) => c.name === "disk_space");
    expect(diskCheck).toBeUndefined();
  });

  it("output conforms to expected JSON shape", () => {
    const dir = mkTmpDir("shape-check");
    createDummyFile(dir, "test.mp4", 512);

    const result = runPreflight(dir);

    // Validate shape
    expect(typeof result.ok).toBe("boolean");
    expect(Array.isArray(result.checks)).toBe(true);
    for (const check of result.checks) {
      expect(typeof check.name).toBe("string");
      expect(["pass", "warn", "fail"]).toContain(check.status);
      expect(typeof check.detail).toBe("string");
    }
  });

  it("warn status does not cause ok=false", () => {
    // Missing API keys produce warn, not fail
    delete process.env.GEMINI_API_KEY;
    delete process.env.GROQ_API_KEY;

    const dir = mkTmpDir("warn-ok");
    createDummyFile(dir, "clip.mp4", 256);

    const result = runPreflight(dir);
    const apiChecks = result.checks.filter(
      (c) => c.name === "GEMINI_API_KEY" || c.name === "GROQ_API_KEY"
    );
    expect(apiChecks.every((c) => c.status === "warn")).toBe(true);

    // ok depends on ffmpeg/ffprobe, not on API key warns
    const hasFail = result.checks.some((c) => c.status === "fail");
    expect(result.ok).toBe(!hasFail);
  });
});
