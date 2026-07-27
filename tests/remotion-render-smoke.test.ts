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
    "color=c=black:s=320x568:d=1.5",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=48000:cl=stereo",
    "-shortest",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    outputPath,
  ]);
}

async function probeVideo(outputPath: string): Promise<{
  codec_name: string;
  pix_fmt: string;
  r_frame_rate: string;
  avg_frame_rate: string;
}> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=codec_name,pix_fmt,r_frame_rate,avg_frame_rate",
    "-of",
    "json",
    outputPath,
  ]);

  const parsed = JSON.parse(stdout) as {
    streams?: Array<{
      codec_name?: string;
      pix_fmt?: string;
      r_frame_rate?: string;
      avg_frame_rate?: string;
    }>;
  };
  const stream = parsed.streams?.[0];

  if (!stream?.codec_name || !stream.pix_fmt || !stream.r_frame_rate || !stream.avg_frame_rate) {
    throw new Error(`ffprobe did not return video codec details for ${outputPath}`);
  }

  return {
    codec_name: stream.codec_name,
    pix_fmt: stream.pix_fmt,
    r_frame_rate: stream.r_frame_rate,
    avg_frame_rate: stream.avg_frame_rate,
  };
}

async function probeAudioCodec(outputPath: string): Promise<string | undefined> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "a:0",
    "-show_entries",
    "stream=codec_name",
    "-of",
    "json",
    outputPath,
  ]);
  const parsed = JSON.parse(stdout) as { streams?: Array<{ codec_name?: string }> };
  return parsed.streams?.[0]?.codec_name;
}

async function probeFrameLuma(outputPath: string, frame: number): Promise<number> {
  const { stderr } = await execFileAsync("ffmpeg", [
    "-v",
    "info",
    "-i",
    outputPath,
    "-vf",
    `select=eq(n\\,${frame}),signalstats,metadata=print`,
    "-frames:v",
    "1",
    "-f",
    "null",
    "-",
  ]);
  const match = stderr.match(/lavfi\.signalstats\.YAVG=([0-9.]+)/);
  if (!match) throw new Error(`ffmpeg did not report YAVG for frame ${frame}`);
  return Number(match[1]);
}

function writeTimeline(timelinePath: string): TimelineIR {
  const timeline: TimelineIR = {
    version: "1",
    project_id: "remotion-smoke",
    created_at: "2026-04-27T00:00:00.000Z",
    sequence: {
      name: "Remotion Smoke",
      fps_num: 30_000,
      fps_den: 1_001,
      width: 320,
      height: 568,
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
              src_out_us: 1_500_000,
              timeline_in_frame: 0,
              timeline_duration_frames: 36,
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

  (timeline.tracks as TimelineIR["tracks"] & { overlay: TimelineIR["tracks"]["video"] }).overlay = [{
    track_id: "OV1",
    kind: "overlay",
    clips: [{
      clip_id: "OVL_0001",
      segment_id: "OVL_0001",
      asset_id: "__overlay__",
      src_in_us: 0,
      src_out_us: 1_000_000,
      timeline_in_frame: 0,
      timeline_duration_frames: 12,
      role: "title",
      motivation: "verify Japanese subset font loading",
      beat_id: "b01",
      fallback_segment_ids: [],
      confidence: 1,
      quality_flags: [],
      metadata: {
        content_element: {
          version: "content-element/v1",
          element_id: "remotion_title",
          kind: "template",
          template_ref: "vos:content.title-card/v1",
          template_version: "1.0.0",
          props: { title: "経営者本人がAIを使う意味" },
          layout: {
            anchor: "center",
            x: 0,
            y: 0,
            scale: 1,
            rotation_deg: 0,
            opacity: 1,
            safe_area: true,
            z_index: 100,
          },
          renderer_hint: "auto",
        },
      },
    }, {
      clip_id: "OVL_0002",
      segment_id: "OVL_0002",
      asset_id: "__overlay__",
      src_in_us: 0,
      src_out_us: 500_000,
      timeline_in_frame: 12,
      timeline_duration_frames: 12,
      role: "title",
      motivation: "verify non-zero overlay timing",
      beat_id: "b01",
      fallback_segment_ids: [],
      confidence: 1,
      quality_flags: [],
      metadata: {
        content_element: {
          version: "content-element/v1",
          element_id: "remotion_emphasis",
          kind: "template",
          template_ref: "vos:content.emphasis-word/v1",
          template_version: "1.0.0",
          props: { text: "後半字幕" },
          layout: {
            anchor: "center",
            x: 0,
            y: 0,
            scale: 1,
            rotation_deg: 0,
            opacity: 1,
            safe_area: true,
            z_index: 110,
          },
          renderer_hint: "auto",
        },
      },
    }, {
      clip_id: "OVL_0003",
      segment_id: "OVL_0003",
      asset_id: "__overlay__",
      src_in_us: 0,
      src_out_us: 500_000,
      timeline_in_frame: 24,
      timeline_duration_frames: 12,
      role: "title",
      motivation: "verify full-frame CTA treatment",
      beat_id: "b01",
      fallback_segment_ids: [],
      confidence: 1,
      quality_flags: [],
      metadata: {
        content_element: {
          version: "content-element/v1",
          element_id: "remotion_cta",
          kind: "template",
          template_ref: "vos:content.cta-card/v1",
          template_version: "1.0.0",
          props: { headline: "次の一歩を始める", action: "詳しく見る", brand: "VIDEO OS" },
          layout: {
            anchor: "center",
            x: 0,
            y: 0,
            scale: 1,
            rotation_deg: 0,
            opacity: 1,
            safe_area: true,
            z_index: 120,
          },
          renderer_hint: "auto",
        },
      },
    }],
  }];

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
        durationInFrames: 36,
        fps: 30_000 / 1_001,
        fpsNum: 30_000,
        fpsDen: 1_001,
        width: timeline.sequence.width,
        height: timeline.sequence.height,
        font: {
          mode: "subset",
          format: "woff2",
          sourceSha256: "c2f3b4d463500a2ddcd3849cded1fceeb9fd6d1c32e6cbecd568453ba50fc68f",
        },
      });
      expect(result.font.sizeBytes).toBeLessThan(250_000);
      expect(fs.existsSync(outputPath)).toBe(true);
      expect(fs.statSync(outputPath).size).toBeGreaterThan(0);

      const stream = await probeVideo(outputPath);
      expect(stream.codec_name).toBe("h264");
      expect(stream.pix_fmt).toBe("yuv420p");
      expect(stream.r_frame_rate).toBe("30000/1001");
      expect(stream.avg_frame_rate).toBe("30000/1001");
      expect(await probeAudioCodec(outputPath)).toBe("aac");
      expect(await probeFrameLuma(outputPath, 18)).toBeGreaterThan(16.1);
      expect(await probeFrameLuma(outputPath, 30)).toBeGreaterThan(16.1);
    },
    180_000,
  );
});
