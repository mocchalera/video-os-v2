import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureMarlinWorker,
  MARLIN_TOOL_CACHE_DIRNAME,
  marlinAnalyzeRange,
  marlinExtractFrame,
  marlinFindMoment,
  shutdownMarlinWorker,
} from "../runtime/tools/marlin-tools.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SOURCE_VIDEO = path.join(REPO_ROOT, "tests/fixtures/media/test-clip-5s.mp4");

function ffmpegAvailable(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const ffit = ffmpegAvailable() ? it : it.skip;

let projectDir: string;
let previousMock: string | undefined;
let previousProxyDisable: string | undefined;

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "marlin-tools-"));
  previousMock = process.env.VOS_MARLIN_MOCK;
  previousProxyDisable = process.env.VOS_MARLIN_PROXY_DISABLE;
  process.env.VOS_MARLIN_MOCK = "1";
  process.env.VOS_MARLIN_PROXY_DISABLE = "1";
});

afterEach(async () => {
  await shutdownMarlinWorker();
  fs.rmSync(projectDir, { recursive: true, force: true });
  if (previousMock === undefined) {
    delete process.env.VOS_MARLIN_MOCK;
  } else {
    process.env.VOS_MARLIN_MOCK = previousMock;
  }
  if (previousProxyDisable === undefined) {
    delete process.env.VOS_MARLIN_PROXY_DISABLE;
  } else {
    process.env.VOS_MARLIN_PROXY_DISABLE = previousProxyDisable;
  }
});

describe("Marlin editorial tools", () => {
  ffit("marlinAnalyzeRange creates a trimmed proxy and returns adjusted events", async () => {
    await ensureMarlinWorker(projectDir);

    const result = await marlinAnalyzeRange(SOURCE_VIDEO, 1, 3);

    expect(result.scene).toContain("Mock Marlin scene");
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      start_us: 2_000_000,
      end_us: 3_000_000,
      source_pass: "marlin_caption",
    });

    const rangeDir = path.join(projectDir, MARLIN_TOOL_CACHE_DIRNAME, "ranges");
    const proxies = fs.readdirSync(rangeDir).filter((file) => file.endsWith(".mp4"));
    expect(proxies.length).toBeGreaterThan(0);
  }, 30_000);

  it("marlinFindMoment calls Marlin find and returns a normalized span", async () => {
    await ensureMarlinWorker(projectDir);

    const result = await marlinFindMoment(SOURCE_VIDEO, "camera stabilizes");

    expect(result.span).toEqual([4, 6.25]);
    expect(result.confidence).toBe(0.8);
    expect(result.description).toContain("camera stabilizes");
  });

  ffit("marlinExtractFrame extracts a source frame", async () => {
    const outputPath = path.join(projectDir, "frames", "frame.jpg");

    const framePath = await marlinExtractFrame(SOURCE_VIDEO, 1.2, outputPath);

    expect(framePath).toBe(outputPath);
    expect(fs.existsSync(framePath)).toBe(true);
    expect(fs.statSync(framePath).size).toBeGreaterThan(0);
  }, 30_000);
});
