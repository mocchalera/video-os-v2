import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CreativeBrief } from "../runtime/artifacts/types.js";
import type { MarlinFn } from "../runtime/connectors/marlin-types.js";
import {
  assessEmotionArc,
  detectContinuityIssues,
  runMarlinQA,
} from "../runtime/eval/marlin-qa.js";
import type { MarlinQAReport } from "../runtime/eval/marlin-qa-types.js";

function tempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "video-os-marlin-qa-"));
  fs.mkdirSync(path.join(dir, "09_output"), { recursive: true });
  fs.writeFileSync(path.join(dir, "09_output", "rough-cut.mp4"), "");
  return dir;
}

function brief(): CreativeBrief {
  return {
    version: "1",
    project_id: "marlin-qa-fixture",
    project: {
      id: "marlin-qa-fixture",
      title: "Practice story",
      strategy: "uncertain practice resolves into confidence",
      runtime_target_sec: 20,
    },
    message: { primary: "practice creates confidence" },
    emotion_curve: ["uncertain", "practice", "confidence"],
  } as CreativeBrief;
}

function mockMarlin(events: Array<{ start: number; end: number; description: string }>): MarlinFn {
  return {
    async caption() {
      return {
        scene: "Rendered rough cut",
        events,
      };
    },
    async find() {
      throw new Error("QA should use caption only");
    },
  };
}

function expectValidReportShape(report: MarlinQAReport): void {
  expect(report.version).toBe("1");
  expect(report.project_id).toBe("marlin-qa-fixture");
  expect(typeof report.video_path).toBe("string");
  expect(report.video_duration_sec).toBeGreaterThanOrEqual(0);
  expect(typeof report.overall_assessment).toBe("string");
  expect(Array.isArray(report.scene_descriptions)).toBe(true);
  expect(Array.isArray(report.issues)).toBe(true);
  expect(typeof report.pacing_assessment.too_fast).toBe("boolean");
  expect(typeof report.pacing_assessment.too_slow).toBe("boolean");
  expect(typeof report.emotion_arc_assessment.follows_brief).toBe("boolean");
  expect(report.score).toBeGreaterThanOrEqual(0);
  expect(report.score).toBeLessThanOrEqual(100);
}

describe("Marlin output QA", () => {
  it("detects camera shake, exposure, weak content, and fast pacing from mock Marlin events", async () => {
    const projectDir = tempProject();
    const calls: string[] = [];
    const marlinFn: MarlinFn = {
      async caption(videoPath) {
        calls.push(path.basename(videoPath));
        return {
          scene: "Rendered rough cut",
          events: [
            { start: 0, end: 0.4, description: "Uncertain opening as the camera moves and becomes shaky." },
            { start: 0.5, end: 0.9, description: "Practice section is dimly lit and dark." },
            { start: 1.0, end: 1.4, description: "Confidence ending but it is a static shot where nothing happens." },
          ],
        };
      },
      async find() {
        throw new Error("QA should use caption only");
      },
    };

    const report = await runMarlinQA(
      projectDir,
      "09_output/rough-cut.mp4",
      brief(),
      { marlinFn, durationSec: 2, writeReport: false },
    );

    expect(calls).toEqual(["rough-cut.mp4"]);
    expect(report.issues.map((issue) => issue.category)).toEqual(expect.arrayContaining([
      "camera_shake",
      "dark_exposure",
      "weak_content",
      "pacing",
    ]));
    expect(report.pacing_assessment.too_fast).toBe(true);
    expect(report.pacing_assessment.too_slow).toBe(false);
    expect(report.emotion_arc_assessment.follows_brief).toBe(true);
    expectValidReportShape(report);
  });

  it("detects non-adjacent repeated scene descriptions as continuity issues", () => {
    const issues = detectContinuityIssues([
      { start_sec: 0, end_sec: 3, description: "Workbench process with hands preparing tea" },
      { start_sec: 3, end_sec: 6, description: "Outdoor family reaction in the garden" },
      { start_sec: 6, end_sec: 9, description: "Workbench process with hands preparing tea" },
    ]);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      category: "continuity",
      severity: "warning",
      timestamp_sec: 6,
    });
  });

  it("keeps adjacent repeated scene descriptions out of continuity warnings", () => {
    const issues = detectContinuityIssues([
      { start_sec: 0, end_sec: 3, description: "Workbench process with hands preparing tea" },
      { start_sec: 3, end_sec: 6, description: "Workbench process with hands preparing tea" },
      { start_sec: 6, end_sec: 9, description: "Outdoor family reaction in the garden" },
    ]);

    expect(issues).toHaveLength(0);
  });

  it("reports emotion curve mismatch when Marlin scenes do not follow the brief progression", () => {
    const result = assessEmotionArc(brief(), [
      { start_sec: 0, end_sec: 4, description: "Practice drills continue in the middle." },
      { start_sec: 4, end_sec: 8, description: "Confidence ending smile appears early." },
    ]);

    expect(result.follows_brief).toBe(false);
    expect(result.notes).toContain("uncertain");
  });

  it("writes a structured report when report output is enabled", async () => {
    const projectDir = tempProject();
    let reportPath = "";

    const report = await runMarlinQA(
      projectDir,
      "09_output/rough-cut.mp4",
      brief(),
      {
        marlinFn: mockMarlin([
          { start: 0, end: 4, description: "Uncertain start near the trail." },
          { start: 4, end: 8, description: "Practice creates visible progress." },
          { start: 8, end: 12, description: "Confidence resolves in a smile." },
        ]),
        durationSec: 12,
        reportDir: path.join(projectDir, "reports"),
        now: () => new Date("2026-06-18T00:00:00.000Z"),
        onReportPath: (writtenPath) => {
          reportPath = writtenPath;
        },
      },
    );

    expectValidReportShape(report);
    expect(reportPath).toBe(path.join(projectDir, "reports", "marlin-qa-marlin-qa-fixture_2026-06-18T00-00-00-000Z.json"));
    expect(fs.existsSync(reportPath)).toBe(true);
    const written = JSON.parse(fs.readFileSync(reportPath, "utf-8")) as MarlinQAReport;
    expect(written).toEqual(report);
  });
});
