/**
 * final-parity.test.ts — TRUE preview ⇄ final cross-path comparison.
 *
 * compare.test.ts verifies that the preview path is deterministic with
 * itself. This file closes the remaining gap in the parity design: it
 * renders the SAME timeline through BOTH paths —
 *
 *   preview: buildRenderSpec → PreviewJobService (editor exact preview)
 *   final:   runRenderPipeline with the ffmpeg assembly engine
 *            (assembly → demux → caption burn → audio master → mux)
 *
 * — and asserts the section 13.3 acceptance criteria across paths for
 * three scenarios: straight cuts, a crossfade transition, and a
 * caption burn from a canonical caption_approval.json:
 *   - video SSIM ≥ 0.999
 *   - duration delta ≤ 1 frame
 *   - integrated LUFS diff ≤ 0.1 LU
 *
 * Timelines mirror the canonical compiler output shape: A1 audio clips
 * mirror the V1 video clips, which is how the deterministic compiler
 * emits rough cuts.
 *
 * Gated behind PARITY=1 like compare.test.ts:
 *
 *   PARITY=1 npx vitest run editor/tests/parity/final-parity.test.ts
 *
 * Set KEEP_PARITY_ARTIFACTS=1 to keep rendered artifacts for debugging.
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

// ── Timeline fixtures ────────────────────────────────────────────────

function makeClip(
  id: string,
  srcInUs: number,
  srcOutUs: number,
  tlInFrame: number,
  durationFrames = 60,
) {
  return {
    clip_id: id,
    segment_id: `SEG_${id}`,
    asset_id: "fixture",
    src_in_us: srcInUs,
    src_out_us: srcOutUs,
    timeline_in_frame: tlInFrame,
    timeline_duration_frames: durationFrames,
    role: "hero",
    motivation: "final parity fixture",
    beat_id: "b01",
    fallback_segment_ids: [],
    confidence: 0.9,
    quality_flags: [],
  };
}

interface TimelineOptions {
  /** Overlap c1→c2 by this many frames and declare a crossfade. */
  crossfadeFrames?: number;
}

/** Canonical-shaped timeline: two V1 clips, A1 mirrors V1. */
function buildTimeline(opts: TimelineOptions = {}): Record<string, unknown> {
  const overlap = opts.crossfadeFrames ?? 0;
  const c2Start = 60 - overlap;
  const videoClips = [
    makeClip("c1", 0, 2_000_000, 0),
    makeClip("c2", 2_000_000, 4_000_000, c2Start),
  ];
  const audioClips = [
    makeClip("a1", 0, 2_000_000, 0),
    makeClip("a2", 2_000_000, 4_000_000, c2Start),
  ];
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
      video: [{ track_id: "V1", kind: "video", clips: videoClips }],
      audio: [{ track_id: "A1", kind: "audio", clips: audioClips }],
    },
    ...(overlap > 0
      ? {
          transitions: [
            {
              transition_id: "TR_0001",
              from_clip_id: "c1",
              to_clip_id: "c2",
              track_id: "V1",
              transition_type: "crossfade",
              transition_frames: overlap,
            },
          ],
        }
      : {}),
    markers: [],
    provenance: {
      brief_path: "test",
      blueprint_path: "test",
      selects_path: "test",
      compiler_version: "final-parity-test",
    },
  };
}

/** Canonical caption_approval.json (schemas/caption-approval.schema.json). */
function buildCaptionApproval(): Record<string, unknown> {
  return {
    version: "1",
    project_id: "final-parity",
    base_timeline_version: "test",
    speech_captions: [
      {
        caption_id: "SC_0001",
        asset_id: "fixture",
        segment_id: "SEG_c1",
        timeline_in_frame: 10,
        timeline_duration_frames: 40,
        text: "こんにちは世界",
        source: "authored",
        styling_class: "default",
        metrics: { chars_per_sec: 4.0, lines: 1 },
      },
      {
        caption_id: "SC_0002",
        asset_id: "fixture",
        segment_id: "SEG_c2",
        timeline_in_frame: 70,
        timeline_duration_frames: 40,
        text: "Parity holds across paths",
        source: "authored",
        styling_class: "default",
        metrics: { chars_per_sec: 5.0, lines: 1 },
      },
    ],
  };
}

// ── Render helpers ───────────────────────────────────────────────────

interface ScenarioArtifacts {
  finalPath: string;
  previewPath: string;
}

async function renderBothPaths(
  tmpDir: string,
  scenario: string,
  timeline: Record<string, unknown>,
  options: { captionApproval?: Record<string, unknown> } = {},
): Promise<ScenarioArtifacts> {
  // ── Final path: runRenderPipeline with the ffmpeg assembly engine ──
  const finalProjectDir = path.join(tmpDir, `${scenario}-final`);
  const timelineDir = path.join(finalProjectDir, "05_timeline");
  fs.mkdirSync(timelineDir, { recursive: true });
  const timelinePath = path.join(timelineDir, "timeline.json");
  fs.writeFileSync(timelinePath, JSON.stringify(timeline, null, 2));

  let captionApprovalPath: string | undefined;
  if (options.captionApproval) {
    captionApprovalPath = path.join(finalProjectDir, "caption_approval.json");
    fs.writeFileSync(
      captionApprovalPath,
      JSON.stringify(options.captionApproval, null, 2),
    );
  }

  const finalResult = await runRenderPipeline({
    projectDir: finalProjectDir,
    timelinePath,
    sourceMap: { fixture: FIXTURE_VIDEO },
    assemblyEngine: "ffmpeg",
    assemblyOutputPath: path.join(timelineDir, "assembly.mp4"),
    captionApprovalPath,
    captionPolicy: options.captionApproval
      ? {
          language: "ja",
          delivery_mode: "burn_in",
          source: "authored",
          styling_class: "default",
        }
      : {
          language: "ja",
          delivery_mode: "sidecar",
          source: "none",
          styling_class: "default",
        },
    outputDir: path.join(finalProjectDir, "07_package"),
    fps: FPS,
  });

  // ── Preview path: the editor's exact-preview artifact ──
  const previewProjectId = `${scenario}-preview`;
  const previewProjectDir = path.join(tmpDir, previewProjectId);
  fs.mkdirSync(path.join(previewProjectDir, "05_timeline", "previews"), {
    recursive: true,
  });
  const spec = buildRenderSpec(
    timeline as Parameters<typeof buildRenderSpec>[0],
    `rev-${scenario}`,
    () => FIXTURE_VIDEO,
    captionApprovalPath ? { captionApprovalPath } : undefined,
  );
  const previewPath = await new Promise<string>((resolve, reject) => {
    const svc = new PreviewJobService((id, state: PreviewJobState) => {
      if (id !== previewProjectId) return;
      if (state.status === "ready") {
        const file = state.previewUrl?.split("/").pop() ?? "";
        resolve(path.join(previewProjectDir, "05_timeline", "previews", file));
      } else if (state.status === "error") {
        reject(new Error(state.error ?? "preview failed"));
      }
    }, tmpDir);
    svc.request(previewProjectId, previewProjectDir, spec);
  });

  return { finalPath: finalResult.finalVideoPath, previewPath };
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

// ── Scenarios ────────────────────────────────────────────────────────

interface Scenario {
  name: string;
  timeline: () => Record<string, unknown>;
  captionApproval?: () => Record<string, unknown>;
}

const SCENARIOS: Scenario[] = [
  { name: "cuts", timeline: () => buildTimeline() },
  {
    name: "crossfade",
    timeline: () => buildTimeline({ crossfadeFrames: 15 }),
  },
  {
    name: "captions",
    timeline: () => buildTimeline(),
    captionApproval: buildCaptionApproval,
  },
];

describe("preview ⇄ final cross-path parity (gated by PARITY=1)", () => {
  let tmpDir: string;

  beforeAll(() => {
    if (!SHOULD_RUN) return;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-final-parity-"));
  });

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

  for (const scenario of SCENARIOS) {
    describe(`scenario: ${scenario.name}`, () => {
      let artifacts: ScenarioArtifacts;

      beforeAll(async () => {
        if (!SHOULD_RUN) return;
        artifacts = await renderBothPaths(
          tmpDir,
          scenario.name,
          scenario.timeline(),
          scenario.captionApproval
            ? { captionApproval: scenario.captionApproval() }
            : {},
        );
      }, 300_000);

      dxit("both paths produce a playable artifact", () => {
        expect(fs.existsSync(artifacts.finalPath)).toBe(true);
        expect(fs.existsSync(artifacts.previewPath)).toBe(true);
      });

      dxit(
        "duration differs by at most one frame",
        () => {
          const finalDur = videoDurationSec(artifacts.finalPath);
          const previewDur = videoDurationSec(artifacts.previewPath);
          expect(Math.abs(finalDur - previewDur)).toBeLessThanOrEqual(
            1 / FPS + 1e-3,
          );
        },
        60_000,
      );

      dxit(
        "video frames match across paths (SSIM ≥ 0.999)",
        async () => {
          const ssim = await computeSsim({
            referencePath: artifacts.previewPath,
            testPath: artifacts.finalPath,
          });
          expect(ssim.all).toBeGreaterThanOrEqual(0.999);
        },
        240_000,
      );

      dxit(
        "integrated loudness matches across paths (diff ≤ 0.1 LU)",
        async () => {
          const previewLufs = await measureLoudness({
            audioOrVideoPath: artifacts.previewPath,
          });
          const finalLufs = await measureLoudness({
            audioOrVideoPath: artifacts.finalPath,
          });
          expect(
            Math.abs(previewLufs.integratedLufs - finalLufs.integratedLufs),
          ).toBeLessThanOrEqual(0.1);
        },
        240_000,
      );
    });
  }
});
