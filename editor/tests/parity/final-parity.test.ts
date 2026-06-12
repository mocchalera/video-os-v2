/**
 * final-parity.test.ts — TRUE preview ⇄ final cross-path comparison.
 *
 * compare.test.ts verifies that the preview path is deterministic with
 * itself. This file closes the remaining gap in the parity design: it
 * renders the SAME timeline through BOTH paths —
 *
 *   preview: buildRenderSpec → PreviewJobService (editor exact preview)
 *   final:   runRenderPipeline with the ffmpeg assembly engine
 *            (assembly → demux → audio master → final mux)
 *
 * — and asserts the section 13.3 acceptance criteria across paths:
 *   - video SSIM ≥ 0.999
 *   - duration delta ≤ 1 frame
 *   - integrated LUFS diff ≤ 0.1 LU
 *
 * The timeline mirrors the canonical compiler output shape: A1 audio
 * clips mirror the V1 video clips (same asset, ranges, placement), which
 * is how the deterministic compiler emits rough cuts.
 *
 * Gated behind PARITY=1 like compare.test.ts:
 *
 *   PARITY=1 npx vitest run editor/tests/parity/final-parity.test.ts
 */

import { describe, expect, beforeAll, afterAll, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PreviewJobService,
  type PreviewJobState,
} from "../../server/services/preview-job-service.js";
import { buildRenderSpec } from "../../shared/render-spec.js";
import { runRenderPipeline } from "../../../runtime/render/pipeline.js";
import { computeSsim } from "./ssim.js";
import { measureLoudness } from "./lufs.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_VIDEO = path.resolve(
  HERE,
  "../../../tests/fixtures/media/test-clip-5s.mp4",
);

function ffmpegAvailable(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const SHOULD_RUN =
  process.env.PARITY === "1" &&
  fs.existsSync(FIXTURE_VIDEO) &&
  ffmpegAvailable();

const dxit = SHOULD_RUN ? it : it.skip;

const FPS = 30;
const REVISION = "rev-final-parity";

/** Canonical-shaped timeline: two contiguous V1 clips, A1 mirrors V1. */
function buildTimeline(): Record<string, unknown> {
  const clip = (
    id: string,
    srcInUs: number,
    srcOutUs: number,
    tlInFrame: number,
  ) => ({
    clip_id: id,
    segment_id: `SEG_${id}`,
    asset_id: "fixture",
    src_in_us: srcInUs,
    src_out_us: srcOutUs,
    timeline_in_frame: tlInFrame,
    timeline_duration_frames: 60,
    role: "hero",
    motivation: "final parity fixture",
    beat_id: "b01",
    fallback_segment_ids: [],
    confidence: 0.9,
    quality_flags: [],
  });
  return {
    version: "1",
    project_id: "final-parity",
    created_at: "2026-06-12T00:00:00.000Z",
    sequence: {
      name: "final parity",
      fps_num: FPS,
      fps_den: 1,
      width: 640,
      height: 360,
      start_frame: 0,
    },
    tracks: {
      video: [
        {
          track_id: "V1",
          kind: "video",
          clips: [clip("c1", 0, 2_000_000, 0), clip("c2", 2_000_000, 4_000_000, 60)],
        },
      ],
      audio: [
        {
          track_id: "A1",
          kind: "audio",
          clips: [clip("a1", 0, 2_000_000, 0), clip("a2", 2_000_000, 4_000_000, 60)],
        },
      ],
    },
    markers: [],
    provenance: {
      brief_path: "test",
      blueprint_path: "test",
      selects_path: "test",
      compiler_version: "final-parity-test",
    },
  };
}

function videoDurationSec(videoPath: string): number {
  // Video stream duration, not container duration — AAC end padding makes
  // the container slightly longer and is irrelevant to frame parity.
  const out = execFileSync("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=duration",
    "-of", "csv=p=0",
    videoPath,
  ]).toString().trim();
  return Number(out);
}

describe("preview ⇄ final cross-path parity (gated by PARITY=1)", () => {
  let tmpDir: string;
  let previewPath: string;
  let finalPath: string;

  beforeAll(async () => {
    if (!SHOULD_RUN) return;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-final-parity-"));

    const timeline = buildTimeline();

    // ── Final path: runRenderPipeline with the ffmpeg assembly engine ──
    const finalProjectDir = path.join(tmpDir, "final-project");
    const timelineDir = path.join(finalProjectDir, "05_timeline");
    fs.mkdirSync(timelineDir, { recursive: true });
    const timelinePath = path.join(timelineDir, "timeline.json");
    fs.writeFileSync(timelinePath, JSON.stringify(timeline, null, 2));

    const finalResult = await runRenderPipeline({
      projectDir: finalProjectDir,
      timelinePath,
      sourceMap: { fixture: FIXTURE_VIDEO },
      assemblyEngine: "ffmpeg",
      assemblyOutputPath: path.join(timelineDir, "assembly.mp4"),
      captionPolicy: {
        language: "ja",
        delivery_mode: "sidecar",
        source: "none",
        styling_class: "default",
      },
      outputDir: path.join(finalProjectDir, "07_package"),
      fps: FPS,
    });
    finalPath = finalResult.finalVideoPath;

    // ── Preview path: the editor's exact-preview artifact ──
    const previewProjectDir = path.join(tmpDir, "preview-project");
    fs.mkdirSync(path.join(previewProjectDir, "05_timeline", "previews"), {
      recursive: true,
    });
    const spec = buildRenderSpec(
      timeline as Parameters<typeof buildRenderSpec>[0],
      REVISION,
      () => FIXTURE_VIDEO,
    );
    previewPath = await new Promise<string>((resolve, reject) => {
      const svc = new PreviewJobService((id, state: PreviewJobState) => {
        if (id !== "preview-project") return;
        if (state.status === "ready") {
          const file = state.previewUrl?.split("/").pop() ?? "";
          resolve(path.join(previewProjectDir, "05_timeline", "previews", file));
        } else if (state.status === "error") {
          reject(new Error(state.error ?? "preview failed"));
        }
      }, tmpDir);
      svc.request("preview-project", previewProjectDir, spec);
    });
  }, 300_000);

  afterAll(() => {
    if (!SHOULD_RUN) return;
    if (process.env.KEEP_PARITY_ARTIFACTS === "1") {
      console.log(`[final-parity] artifacts kept at ${tmpDir}`);
      return;
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  dxit(
    "both paths produce a playable artifact",
    () => {
      expect(fs.existsSync(finalPath)).toBe(true);
      expect(fs.existsSync(previewPath)).toBe(true);
    },
    30_000,
  );

  dxit(
    "duration differs by at most one frame",
    () => {
      const finalDur = videoDurationSec(finalPath);
      const previewDur = videoDurationSec(previewPath);
      expect(Math.abs(finalDur - previewDur)).toBeLessThanOrEqual(1 / FPS + 1e-3);
    },
    60_000,
  );

  dxit(
    "video frames match across paths (SSIM ≥ 0.999)",
    async () => {
      const ssim = await computeSsim({
        referencePath: previewPath,
        testPath: finalPath,
      });
      expect(ssim.all).toBeGreaterThanOrEqual(0.999);
    },
    240_000,
  );

  dxit(
    "integrated loudness matches across paths (diff ≤ 0.1 LU)",
    async () => {
      const previewLufs = await measureLoudness({ audioOrVideoPath: previewPath });
      const finalLufs = await measureLoudness({ audioOrVideoPath: finalPath });
      expect(
        Math.abs(previewLufs.integratedLufs - finalLufs.integratedLufs),
      ).toBeLessThanOrEqual(0.1);
    },
    240_000,
  );
});
