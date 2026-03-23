import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  compareAndWriteProjectTimelines,
  compareProjectTimelines,
  type FlattenedClip,
} from "../runtime/compare/timelines.js";
import { main, parseArgs } from "../scripts/compare-timelines.js";

const SAMPLE_PROJECT = path.resolve("projects/sample");
const tempDirs: string[] = [];

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function createTempProject(name: string): string {
  const dir = path.resolve("projects", `compare-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  copyDirSync(SAMPLE_PROJECT, dir);
  tempDirs.push(dir);
  return dir;
}

function readTimeline(projectDir: string) {
  return JSON.parse(
    fs.readFileSync(path.join(projectDir, "05_timeline", "timeline.json"), "utf-8"),
  ) as Record<string, unknown>;
}

function writeTimeline(projectDir: string, timeline: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(projectDir, "05_timeline", "timeline.json"),
    JSON.stringify(timeline, null, 2),
    "utf-8",
  );
}

function findClipById(clips: FlattenedClip[], clipId: string): FlattenedClip | undefined {
  return clips.find((clip) => clip.clip_id === clipId);
}

afterAll(() => {
  for (const dir of tempDirs) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("compare-timelines", () => {
  it("compares timelines and writes JSON + HTML artifacts", () => {
    const projectA = createTempProject("a");
    const projectB = createTempProject("b");

    const timelineB = readTimeline(projectB) as {
      tracks: {
        video: Array<{ track_id: string; clips: Array<Record<string, unknown>> }>;
        audio: Array<{ track_id: string; clips: Array<Record<string, unknown>> }>;
      };
      markers: Array<Record<string, unknown>>;
    };

    const heroClip = timelineB.tracks.video[0].clips.find((clip) => clip.clip_id === "CLP_0006");
    heroClip!.src_in_us = 8_500_000;
    heroClip!.src_out_us = 14_300_000;

    const replacedClip = timelineB.tracks.video[1].clips.find((clip) => clip.clip_id === "CLP_0005");
    replacedClip!.asset_id = "AST_999";
    replacedClip!.segment_id = "SEG_999";

    const movedAudioClip = timelineB.tracks.audio[0].clips.find((clip) => clip.clip_id === "CLP_0011");
    movedAudioClip!.beat_id = "b05";
    movedAudioClip!.timeline_in_frame = 706;

    timelineB.markers.push({
      frame: 706,
      kind: "beat",
      label: "b05: coda",
    });

    writeTimeline(projectB, timelineB);

    const result = compareAndWriteProjectTimelines(path.basename(projectA), path.basename(projectB));

    expect(result.report.summary.shared_asset_count).toBe(5);
    expect(result.report.summary.common_clip_count).toBe(11);
    expect(result.report.summary.exact_common_clip_count).toBe(9);
    expect(result.report.summary.variant_common_clip_count).toBe(2);
    expect(result.report.summary.unique_clip_count_a).toBe(1);
    expect(result.report.summary.unique_clip_count_b).toBe(1);
    expect(result.report.summary.beat_count_a).toBe(4);
    expect(result.report.summary.beat_count_b).toBe(5);
    expect(result.report.summary.shared_beat_count).toBe(4);
    expect(result.report.summary.unique_beat_count_b).toBe(1);
    expect(result.report.summary.clip_selection_match_rate).toBeCloseTo(5 / 7, 8);

    const clipPair = result.report.common_clips.find((clip) => clip.clip_a.clip_id === "CLP_0006");
    expect(clipPair).toBeDefined();
    expect(clipPair!.status).toBe("variant_match");
    expect(clipPair!.src_in_delta_us).toBe(500_000);
    expect(clipPair!.src_out_delta_us).toBe(500_000);

    const uniqueAClip = findClipById(result.report.unique_clips.project_a, "CLP_0005");
    const uniqueBClip = findClipById(result.report.unique_clips.project_b, "CLP_0005");
    expect(uniqueAClip?.asset_id).toBe("AST_002");
    expect(uniqueBClip?.asset_id).toBe("AST_999");

    const b05 = result.report.beats.only_in_b.find((beat) => beat.beat_id === "b05");
    expect(b05).toBeDefined();
    expect(b05?.start_frame_b).toBe(706);
    expect(b05?.duration_frames_b).toBe(154);

    expect(fs.existsSync(result.json_path)).toBe(true);
    expect(fs.existsSync(result.html_path)).toBe(true);

    const writtenJson = JSON.parse(fs.readFileSync(result.json_path, "utf-8")) as {
      summary: { common_clip_count: number };
    };
    expect(writtenJson.summary.common_clip_count).toBe(11);

    const html = fs.readFileSync(result.html_path, "utf-8");
    expect(html).toContain("Timeline Comparison");
    expect(html).toContain("status-match");
    expect(html).toContain("status-variant");
    expect(html).toContain("status-unique");
    expect(html).toContain("Only in");
  });

  it("supports --stdout and prints pure JSON", () => {
    const projectA = createTempProject("stdout-a");
    const projectB = createTempProject("stdout-b");

    let captured = "";
    const originalWrite = process.stdout.write.bind(process.stdout);
    const writeSpy = ((chunk: string | Uint8Array) => {
      captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
      return true;
    }) as typeof process.stdout.write;

    process.stdout.write = writeSpy;
    try {
      main([
        "node",
        "scripts/compare-timelines.ts",
        path.basename(projectA),
        path.basename(projectB),
        "--stdout",
      ]);
    } finally {
      process.stdout.write = originalWrite;
    }

    const parsed = JSON.parse(captured) as {
      project_a: { name: string };
      project_b: { name: string };
      summary: { common_clip_count: number };
    };

    expect(parsed.project_a.name).toBe(path.basename(projectA));
    expect(parsed.project_b.name).toBe(path.basename(projectB));
    expect(parsed.summary.common_clip_count).toBeGreaterThan(0);
  });

  it("accepts project ids or direct paths", () => {
    const projectA = createTempProject("path-a");
    const projectB = createTempProject("path-b");

    const byName = compareProjectTimelines(path.basename(projectA), path.basename(projectB));
    const byPath = compareProjectTimelines(projectA, projectB);

    expect(byPath.summary.common_clip_count).toBe(byName.summary.common_clip_count);
    expect(byPath.project_a.project_dir).toBe(projectA);
    expect(byPath.project_b.project_dir).toBe(projectB);
  });

  it("parses CLI arguments with --stdout", () => {
    expect(
      parseArgs(["node", "compare", "project-a", "project-b", "--stdout"]),
    ).toEqual({
      projectA: "project-a",
      projectB: "project-b",
      stdout: true,
    });
  });
});
