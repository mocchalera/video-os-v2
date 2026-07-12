import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TimelineIR } from "../runtime/compiler/types.js";
import {
  produceAssembly,
  resolveAssemblyEngine,
} from "../runtime/render/assembly-orchestrator.js";

const execFileAsync = promisify(execFile);
const originalVosRenderEngine = process.env.VOS_RENDER_ENGINE;
const runRemotionRender = process.env.VOS_REMOTION_RENDER === "1";
const remotionIt = runRemotionRender ? it : it.skip;
const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function createBlackSource(outputPath: string): Promise<void> {
  await execFileAsync("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=black:s=128x128:d=1",
    "-an",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    outputPath,
  ]);
}

function writeTimeline(timelinePath: string): TimelineIR {
  const timeline: TimelineIR = {
    version: "1",
    project_id: "assembly-orchestrator-test",
    created_at: "2026-04-27T00:00:00.000Z",
    sequence: {
      name: "Assembly Orchestrator Test",
      fps_num: 24,
      fps_den: 1,
      width: 128,
      height: 128,
      start_frame: 0,
      letterbox_policy: "none",
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
              src_out_us: 1_000_000,
              timeline_in_frame: 0,
              timeline_duration_frames: 24,
              role: "hero",
              motivation: "assembly orchestrator test",
              beat_id: "b01",
              fallback_segment_ids: [],
              confidence: 1,
              quality_flags: [],
            },
          ],
        },
      ],
      audio: [],
    },
    markers: [],
    provenance: {
      brief_path: "01_intent/creative_brief.yaml",
      blueprint_path: "04_plan/edit_blueprint.yaml",
      selects_path: "04_plan/selects_candidates.yaml",
      compiler_version: "assembly-orchestrator-test",
    },
  };

  fs.writeFileSync(timelinePath, JSON.stringify(timeline, null, 2), "utf-8");
  return timeline;
}

beforeEach(() => {
  delete process.env.VOS_RENDER_ENGINE;
});

afterEach(() => {
  if (originalVosRenderEngine === undefined) {
    delete process.env.VOS_RENDER_ENGINE;
  } else {
    process.env.VOS_RENDER_ENGINE = originalVosRenderEngine;
  }
});

afterAll(() => {
  for (const dir of tempDirs) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("resolveAssemblyEngine", () => {
  it("returns explicit remotion engine", () => {
    expect(resolveAssemblyEngine("remotion")).toBe("remotion");
  });

  it("returns explicit ffmpeg engine", () => {
    expect(resolveAssemblyEngine("ffmpeg")).toBe("ffmpeg");
  });

  it("returns VOS_RENDER_ENGINE=remotion when no option is provided", () => {
    process.env.VOS_RENDER_ENGINE = "remotion";
    expect(resolveAssemblyEngine(undefined)).toBe("remotion");
  });

  it("returns null when no option or env is provided", () => {
    expect(resolveAssemblyEngine(undefined)).toBeNull();
  });

  it("treats invalid option values as unresolved", () => {
    expect(resolveAssemblyEngine("invalid" as never)).toBeNull();
  });
});

describe("produceAssembly", () => {
  const baseOpts = {
    timelinePath: "/tmp/timeline.json",
    sourceMap: {},
    outputPath: "/tmp/assembly.mp4",
  };

  it("routes the ffmpeg engine to the deterministic assembler", async () => {
    // The ffmpeg engine is wired (cross-path parity work): the orchestrator
    // must dispatch to assembleTimelineToMp4, which fails on the missing
    // timeline file rather than rejecting the engine choice.
    await expect(
      produceAssembly({ ...baseOpts, engine: "ffmpeg" }),
    ).rejects.toThrow(/ENOENT|timeline/);
  });

  it("throws when no engine resolves", async () => {
    await expect(
      produceAssembly({ ...baseOpts, engine: undefined }),
    ).rejects.toThrow("No assembly engine resolved");
  });

  remotionIt(
    "renders through the Remotion engine when VOS_REMOTION_RENDER=1",
    async () => {
      const tempDir = createTempDir("vos-assembly-orchestrator-");
      const sourcePath = path.join(tempDir, "source.mp4");
      const timelinePath = path.join(tempDir, "timeline.json");
      const outputPath = path.join(tempDir, "assembly.mp4");

      await createBlackSource(sourcePath);
      writeTimeline(timelinePath);

      const result = await produceAssembly({
        timelinePath,
        sourceMap: { AST_001: sourcePath },
        outputPath,
        engine: "remotion",
      });

      expect(result).toEqual({ assemblyPath: outputPath, engine: "remotion" });
      expect(fs.existsSync(outputPath)).toBe(true);
      expect(fs.statSync(outputPath).size).toBeGreaterThan(0);
    },
    180_000,
  );
});
