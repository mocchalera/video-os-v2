import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import {
  approveFinalRenderChecklist,
  finalRenderApprovalPath,
  inspectFinalRenderApproval,
} from "../runtime/packaging/final-render-approval.js";
import { validateAgainstSchema } from "../runtime/commands/shared.js";
import { writeValidFinalRenderReviewPack } from "./helpers/final-render-review.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("final render approval", () => {
  it("fails closed when the human checklist has not been approved", () => {
    const projectDir = createProject();

    expect(inspectFinalRenderApproval(projectDir)).toMatchObject({
      status: "missing",
      ready: false,
      issues: ["final render approval is missing"],
    });
  });

  it("binds every approved checklist item to the current render inputs", () => {
    const projectDir = createProject();
    setAudioFinish(projectDir, "dialogue-clean");
    const previewPath = path.join(projectDir, "06_review", "audio-preview.json");
    fs.mkdirSync(path.dirname(previewPath), { recursive: true });
    fs.writeFileSync(previewPath, "approved preview");
    const approval = approveFinalRenderChecklist(projectDir, {
      approvedBy: "mocchalera",
      approvedAt: "2026-07-23T05:30:00Z",
      checklist: {
        captions: "approved",
        caption_typography: "approved",
        section_titles: "approved",
        visual_preview: writeValidFinalRenderReviewPack(projectDir),
        audio: {
          decision: "dialogue-clean",
          preview_reviewed: true,
          preview_path: "06_review/audio-preview.json",
          preview_sha256: sha256("approved preview"),
          bgm: "none",
        },
        output_spec: "approved",
      },
    });

    expect(approval.approval_key).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(validateAgainstSchema(
      approval,
      "final-render-approval.schema.json",
    )).toMatchObject({ valid: true, errors: [] });
    expect(inspectFinalRenderApproval(projectDir)).toMatchObject({
      status: "ready",
      ready: true,
      approval: {
        project_id: "final-render-test",
        checklist: {
          audio: {
            decision: "dialogue-clean",
            preview_reviewed: true,
          },
        },
      },
    });
    expect(fs.existsSync(finalRenderApprovalPath(projectDir))).toBe(true);
  });

  it("invalidates approval when any bound input changes", () => {
    const projectDir = createProject();
    approveFinalRenderChecklist(projectDir, {
      approvedBy: "mocchalera",
      checklist: {
        captions: "approved",
        caption_typography: "approved",
        section_titles: "approved",
        visual_preview: writeValidFinalRenderReviewPack(projectDir),
        audio: {
          decision: "preserve",
          preview_reviewed: false,
          bgm: "none",
        },
        output_spec: "approved",
      },
    });
    const timelinePath = path.join(projectDir, "05_timeline", "timeline.json");
    const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf8"));
    timeline.sequence.width = 1280;
    fs.writeFileSync(timelinePath, `${JSON.stringify(timeline, null, 2)}\n`);

    expect(inspectFinalRenderApproval(projectDir)).toMatchObject({
      status: "stale",
      ready: false,
    });
    expect(inspectFinalRenderApproval(projectDir).issues.join("\n"))
      .toContain("timeline_sha256");
  });

  it("requires a reviewed preview hash before approving dialogue processing", () => {
    const projectDir = createProject();

    expect(() => approveFinalRenderChecklist(projectDir, {
      approvedBy: "mocchalera",
      checklist: {
        captions: "approved",
        caption_typography: "approved",
        section_titles: "approved",
        visual_preview: writeValidFinalRenderReviewPack(projectDir),
        audio: {
          decision: "dialogue-clean",
          preview_reviewed: false,
          bgm: "none",
        },
        output_spec: "approved",
      },
    })).toThrow("audio preview must be reviewed");
  });
});

function createProject(): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "final-render-approval-"));
  tempDirs.push(projectDir);
  writeJson(path.join(projectDir, "05_timeline", "timeline.json"), {
    version: "1",
    project_id: "final-render-test",
    sequence: {
      fps_num: 30_000,
      fps_den: 1_001,
      width: 1920,
      height: 1080,
      start_frame: 0,
    },
    tracks: { video: [], audio: [] },
    markers: [],
    provenance: {
      brief_path: "01_intent/creative_brief.yaml",
      blueprint_path: "04_plan/edit_blueprint.yaml",
      selects_path: "04_plan/selects_candidates.yaml",
    },
  });
  writeYaml(path.join(projectDir, "01_intent", "creative_brief.yaml"), {
    version: "1",
    project_id: "final-render-test",
    autonomy: { mode: "collaborative" },
  });
  writeJson(path.join(projectDir, "07_package", "caption_approval.json"), {
    version: "1",
    project_id: "final-render-test",
    caption_policy: {
      language: "ja",
      delivery_mode: "both",
      source: "transcript",
      styling_class: "clean-lower-third",
    },
    approval: { status: "approved" },
  });
  return projectDir;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeYaml(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, stringifyYaml(value));
}

function setAudioFinish(projectDir: string, preset: "dialogue-clean" | "loudness-only"): void {
  const timelinePath = path.join(projectDir, "05_timeline", "timeline.json");
  const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf8"));
  timeline.metadata = { ...(timeline.metadata ?? {}), audio_finish: { preset } };
  fs.writeFileSync(timelinePath, `${JSON.stringify(timeline, null, 2)}\n`);
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
