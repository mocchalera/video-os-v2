import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import type { TimelineIR } from "../runtime/compiler/types.js";
import { renderRemotionAssembly } from "../runtime/render/remotion/index.js";

const execFileAsync = promisify(execFile);
const runRemotionSmoke = process.env.VOS_REMOTION_RENDER === "1";
const describeIf = runRemotionSmoke ? describe : describe.skip;
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

async function probeVideo(outputPath: string): Promise<{
  codec_name: string;
  pix_fmt: string;
}> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=codec_name,pix_fmt",
    "-of",
    "json",
    outputPath,
  ]);

  const parsed = JSON.parse(stdout) as {
    streams?: Array<{ codec_name?: string; pix_fmt?: string }>;
  };
  const stream = parsed.streams?.[0];

  if (!stream?.codec_name || !stream.pix_fmt) {
    throw new Error(`ffprobe did not return video codec details for ${outputPath}`);
  }

  return {
    codec_name: stream.codec_name,
    pix_fmt: stream.pix_fmt,
  };
}

function writeTimeline(timelinePath: string): TimelineIR {
  const timeline: TimelineIR = {
    version: "1",
    project_id: "remotion-smoke",
    created_at: "2026-04-27T00:00:00.000Z",
    sequence: {
      name: "Remotion Smoke",
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
              motivation: "remotion smoke test",
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
      compiler_version: "remotion-smoke",
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

describeIf("Remotion renderer smoke", () => {
  it(
    "renders a non-empty h264/yuv420p MP4 from a minimal cuts-only timeline",
    async () => {
      const tempDir = createTempDir("vos-remotion-render-smoke-");
      const sourcePath = path.join(tempDir, "source.mp4");
      const timelinePath = path.join(tempDir, "timeline.json");
      const outputPath = path.join(tempDir, "assembly.mp4");

      await createBlackSource(sourcePath);
      const timeline = writeTimeline(timelinePath);

      const result = await renderRemotionAssembly({
        timelinePath,
        sourceMap: {
          AST_001: sourcePath,
        },
        outputPath,
      });

      expect(result).toMatchObject({
        assemblyPath: outputPath,
        durationInFrames: 24,
        fps: 24,
        width: timeline.sequence.width,
        height: timeline.sequence.height,
      });
      expect(fs.existsSync(outputPath)).toBe(true);
      expect(fs.statSync(outputPath).size).toBeGreaterThan(0);

      const stream = await probeVideo(outputPath);
      expect(stream.codec_name).toBe("h264");
      expect(stream.pix_fmt).toBe("yuv420p");
    },
    180_000,
  );
});
