import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import type { TimelineIR } from "../runtime/compiler/types.js";
import { produceAssembly } from "../runtime/render/assembly-orchestrator.js";

const execFileAsync = promisify(execFile);
const runRemotionAcceptance = process.env.VOS_REMOTION_RENDER === "1";
const describeIf = runRemotionAcceptance ? describe : describe.skip;
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
    "color=c=black:s=64x64:d=1",
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
    project_id: "remotion-engine-acceptance",
    created_at: "2026-04-27T00:00:00.000Z",
    sequence: {
      name: "Remotion Engine Acceptance",
      fps_num: 30,
      fps_den: 1,
      width: 64,
      height: 64,
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
              asset_id: "AST_BLACK",
              src_in_us: 0,
              src_out_us: 1_000_000,
              timeline_in_frame: 0,
              timeline_duration_frames: 30,
              role: "hero",
              motivation: "remotion engine acceptance",
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
      compiler_version: "remotion-engine-acceptance",
    },
  };

  fs.writeFileSync(timelinePath, JSON.stringify(timeline, null, 2), "utf-8");
  return timeline;
}

afterAll(() => {
  for (const dir of tempDirs) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describeIf("Remotion engine acceptance", () => {
  it(
    "produces a non-empty MP4 through produceAssembly with engine=remotion",
    async () => {
      const tempDir = createTempDir("vos-remotion-engine-acceptance-");
      const sourcePath = path.join(tempDir, "02_media/source.mp4");
      const timelinePath = path.join(tempDir, "05_timeline/timeline.json");
      const outputPath = path.join(tempDir, "05_timeline/assembly.mp4");

      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.mkdirSync(path.dirname(timelinePath), { recursive: true });
      await createBlackSource(sourcePath);
      writeTimeline(timelinePath);
      fs.writeFileSync(path.join(tempDir, "02_media/source_map.json"), JSON.stringify({
        version: "1",
        project_id: "remotion-engine-acceptance",
        media_dir: "02_media",
        generated_at: "2026-07-20T00:00:00.000Z",
        items: [{
          asset_id: "AST_BLACK",
          source_locator: sourcePath,
          local_source_path: sourcePath,
          link_path: "02_media/source.mp4",
        }],
      }));

      const result = await produceAssembly({
        engine: "remotion",
        timelinePath,
        sourceMap: {
          AST_BLACK: sourcePath,
        },
        outputPath,
      });

      expect(result).toEqual({ assemblyPath: outputPath, engine: "remotion" });
      expect(fs.existsSync(result.assemblyPath)).toBe(true);
      expect(fs.statSync(result.assemblyPath).size).toBeGreaterThan(0);
    },
    180_000,
  );
});
