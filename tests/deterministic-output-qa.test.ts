import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  deriveDeterministicAllowedRanges,
  detectFourSidedInsets,
  parseCropSamples,
  runDeterministicOutputQA,
  type DeterministicOutputQACommandResult,
} from "../runtime/review/deterministic-output-qa.js";

interface FixtureCase {
  id: string;
  width: number;
  height: number;
  log: string;
  expected_status: "verified" | "blocked";
}

const fixture = JSON.parse(fs.readFileSync(
  path.join("tests", "fixtures", "short-output-qa", "cases.json"),
  "utf-8",
)) as { cases: FixtureCase[] };

function successfulRunner(log: string) {
  return (command: string): DeterministicOutputQACommandResult => {
    if (command === "ffprobe") {
      return {
        status: 0,
        stdout: JSON.stringify({
          streams: [{ width: 1080, height: 1920, avg_frame_rate: "30/1" }],
          format: { duration: "30.0" },
        }),
        stderr: "",
      };
    }
    return {
      status: 0,
      stdout: "out_time_us=30000000\nprogress=end\n",
      stderr: log,
    };
  };
}

describe("deterministic full-output QA", () => {
  for (const item of fixture.cases) {
    it(`${item.id} matches the regression contract`, () => {
      const result = runDeterministicOutputQA("/tmp/final.mp4", {
        expectedWidth: item.width,
        expectedHeight: item.height,
        commandRunner: successfulRunner(item.log),
      });
      expect(result.status).toBe(item.expected_status);
    });
  }

  it("detects a persistent four-sided inset without flagging full-frame samples", () => {
    const insetCase = fixture.cases.find((item) =>
      item.id === "black-inset-550ms"
    )!;
    const regions = detectFourSidedInsets(
      parseCropSamples(insetCase.log),
      insetCase.width,
      insetCase.height,
    );
    expect(regions).toEqual([{ startSec: 7, endSec: 7.55 }]);
  });

  it("treats a failed scan as incomplete and therefore non-approval-grade", () => {
    const result = runDeterministicOutputQA("/tmp/final.mp4", {
      commandRunner: (command) => command === "ffprobe"
        ? successfulRunner("")("ffprobe")
        : {
          status: 1,
          stdout: "",
          stderr: "Error while decoding stream",
        },
    });
    expect(result.status).toBe("incomplete");
    expect(result.reason).toContain("ffmpeg_scan_failed");
  });

  it("fails closed when ffmpeg reports success before reaching the probed duration", () => {
    const result = runDeterministicOutputQA("/tmp/final.mp4", {
      commandRunner: (command) => command === "ffprobe"
        ? successfulRunner("")("ffprobe")
        : {
          status: 0,
          stdout: "out_time_us=1000000\nprogress=end\n",
          stderr: "",
        },
    });
    expect(result.status).toBe("incomplete");
    expect(result.reason).toContain("scanned 1.000s of 30.000s");
  });

  it("decodes video and optional audio with xerror and progress reporting", () => {
    let ffmpegArgs: string[] = [];
    const result = runDeterministicOutputQA("/tmp/final.mp4", {
      commandRunner: (command, args) => {
        if (command === "ffprobe") return successfulRunner("")("ffprobe");
        ffmpegArgs = args;
        return successfulRunner("")("ffmpeg");
      },
    });

    expect(result.status).toBe("verified");
    expect(result.scans?.black).toEqual({ status: "complete", detections: [] });
    expect(ffmpegArgs).toEqual(expect.arrayContaining([
      "-xerror",
      "0:v:0",
      "0:a?",
      "-progress",
      "pipe:1",
    ]));
    expect(ffmpegArgs).not.toContain("-an");
  });

  it("requires a reasoned exception to allow an intentional freeze range", () => {
    const result = runDeterministicOutputQA("/tmp/final.mp4", {
      commandRunner: successfulRunner(
        "freeze_start: 10.000\nfreeze_end: 10.800",
      ),
      allowedRanges: [{
        kind: "freeze",
        start_sec: 9.95,
        end_sec: 10.85,
        reason: "approved static CTA card",
      }],
    });
    expect(result.status).toBe("verified");
  });

  it("derives reasoned ranges only from canonical visual intent", () => {
    const ranges = deriveDeterministicAllowedRanges({
      sequence: { fps_num: 30, fps_den: 1 },
      tracks: {
        video: [{
          clips: [{
            clip_id: "CTA_CARD",
            media_kind: "image",
            timeline_in_frame: 300,
            timeline_duration_frames: 90,
            still_image: { fit_mode: "contain", background: "black" },
          }],
        }],
        overlay: [{
          clips: [{
            clip_id: "CTA",
            timeline_in_frame: 390,
            timeline_duration_frames: 60,
            metadata: {
              content_element: {
                template_ref: "vos:content.cta-card/v1",
              },
            },
          }],
        }],
      },
      transitions: [{
        transition_id: "TR_FREEZE",
        transition_type: "cut",
        start_frame: 120,
        duration_frames: 18,
        applied_skill_id: "fallback.freeze_hold",
      }],
    }, {
      video_fade_color: "black",
      video_fade_out_sec: 0.5,
    });

    expect(ranges).toEqual(expect.arrayContaining([
      {
        kind: "freeze",
        start_sec: 10,
        end_sec: 13,
        reason: "canonical still-image hold: CTA_CARD",
      },
      {
        kind: "inset",
        start_sec: 10,
        end_sec: 13,
        reason: "canonical contain-fit still image: CTA_CARD",
      },
      {
        kind: "freeze",
        start_sec: 4,
        end_sec: 4.6,
        reason: "canonical freeze-hold transition: TR_FREEZE",
      },
      {
        kind: "black",
        start_sec: 14.5,
        end_sec: 15,
        reason: "canonical ending_policy video fade to black",
      },
      {
        kind: "freeze",
        start_sec: 13,
        end_sec: 15,
        reason: "canonical full-frame CTA card: CTA",
      },
    ]));
  });

  it("does not derive detector exceptions from unlabeled video clips", () => {
    expect(deriveDeterministicAllowedRanges({
      sequence: { fps_num: 30, fps_den: 1 },
      tracks: {
        video: [{
          clips: [{
            clip_id: "TALKING_HEAD",
            media_kind: "video",
            timeline_in_frame: 0,
            timeline_duration_frames: 300,
          }],
        }],
      },
    })).toEqual([]);
  });

  it("allows a static black canvas only when canonical intent is audio-only", () => {
    expect(deriveDeterministicAllowedRanges({
      sequence: { fps_num: 24, fps_den: 1 },
      tracks: {
        video: [{ clips: [] }],
        audio: [{
          clips: [{
            clip_id: "DIALOGUE",
            timeline_in_frame: 0,
            timeline_duration_frames: 48,
          }],
        }],
      },
    })).toEqual([
      {
        kind: "black",
        start_sec: 0,
        end_sec: 2,
        reason: "canonical audio-only canvas",
      },
      {
        kind: "freeze",
        start_sec: 0,
        end_sec: 2,
        reason: "canonical audio-only canvas",
      },
    ]);
  });
});
