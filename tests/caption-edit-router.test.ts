import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertCaptionContentOwnerBoundary,
  inspectCaptionEditProject,
  routeCaptionEditInstruction,
} from "../runtime/caption/edit-router.js";
import { runCaptionEditRouter } from "../scripts/caption-edit-router.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("caption edit router", () => {
  it.each([
    ["通常字幕を一回り大きく", "caption_visual_treatment"],
    ["冒頭だけ二段特大", "caption_visual_treatment"],
    ["顔の下へ", "caption_visual_treatment"],
    ["字幕の誤字を修正", "caption_review_patch"],
    ["字幕タイミングを発話に同期", "caption_review_patch"],
    ["shot orderを変更", "timeline_review_patch"],
    ["冒頭をtrim", "timeline_review_patch"],
    ["cropを調整", "timeline_review_patch"],
    ["audioを下げる", "timeline_review_patch"],
  ] as const)("routes %s deterministically", (instruction, route) => {
    expect(routeCaptionEditInstruction(instruction).route).toBe(route);
  });

  it("holds mixed and unrepresentable instructions without choosing artifacts", () => {
    const mixed = routeCaptionEditInstruction("字幕を大きくしてショットも短く");
    expect(mixed).toMatchObject({ status: "hold", route: null });
    expect(mixed.reason_codes).toContain("mixed_artifact_routes");
    expect(mixed.artifacts_to_write).toEqual([]);

    const unknown = routeCaptionEditInstruction("もっといい感じにして");
    expect(unknown).toMatchObject({ status: "degraded", route: null });
    expect(unknown.reason_codes).toContain("instruction_not_representable");
    expect(unknown.artifacts_to_write).toEqual([]);
  });

  it("does not call face-relative placement verified without subject evidence", () => {
    const result = routeCaptionEditInstruction("顔の下へ", { subjectEvidence: false });
    expect(result).toMatchObject({
      status: "degraded",
      route: "caption_visual_treatment",
      evidence_status: "subject_evidence_required",
      verified: false,
      artifacts_to_write: [],
    });
  });

  it("returns a mechanical stop and writes only the degraded route note when subject evidence is missing", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "caption-router-subject-hold-"));
    temporaryDirectories.push(projectDir);
    fs.mkdirSync(path.join(projectDir, "05_timeline"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, "05_timeline/timeline.json"), JSON.stringify({ project_id: "subject-hold", version: "1" }));
    expect(runCaptionEditRouter([
      "node", "caption-edit-router.ts", "--project", projectDir,
      "--instruction", "顔の下へ", "--reviewer", "human-editor", "--write-receipt",
    ])).toBe(2);
    expect(fs.readdirSync(path.join(projectDir, "06_review"))).toEqual(["caption-edit-route.json"]);
    expect(fs.existsSync(path.join(projectDir, "07_package"))).toBe(false);
  });

  it("reports canonical initialization commands when caption draft and approval are absent", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "caption-router-init-"));
    temporaryDirectories.push(projectDir);
    fs.mkdirSync(path.join(projectDir, "05_timeline"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, "05_timeline/timeline.json"), JSON.stringify({ project_id: "router-init", version: "1" }));

    const state = inspectCaptionEditProject(projectDir, "human-editor");
    expect(state.caption_draft).toBe("missing");
    expect(state.caption_approval).toBe("missing");
    expect(state.initialize_commands).toEqual([
      `npx tsx scripts/caption-review.ts prepare --project ${projectDir}`,
      `npx tsx scripts/caption-review.ts init --project ${projectDir} --reviewer human-editor`,
      `npx tsx scripts/caption-review.ts approve --project ${projectDir} --reviewer human-editor`,
    ]);
    expect(state.project_local_script_count).toBe(0);
  });

  it("writes only one schema-valid degraded route note for ambiguous input", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "caption-router-hold-"));
    temporaryDirectories.push(projectDir);
    fs.mkdirSync(path.join(projectDir, "05_timeline"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, "05_timeline/timeline.json"), JSON.stringify({ project_id: "router-hold", version: "1" }));
    const output: string[] = [];
    expect(runCaptionEditRouter([
      "node", "caption-edit-router.ts",
      "--project", projectDir,
      "--instruction", "字幕を大きくしてショットも短く",
      "--reviewer", "human-editor",
      "--write-receipt",
    ], (message) => output.push(message))).toBe(2);
    const receiptPath = path.join(projectDir, "06_review/caption-edit-route.json");
    expect(JSON.parse(fs.readFileSync(receiptPath, "utf8"))).toMatchObject({
      status: "hold",
      route: null,
      reason_codes: ["mixed_artifact_routes"],
      artifacts_to_write: [],
    });
    expect(fs.readdirSync(path.join(projectDir, "06_review"))).toEqual(["caption-edit-route.json"]);
  });

  it("rejects overlapping speech and registered graphical content with the same semantic text", () => {
    expect(() => assertCaptionContentOwnerBoundary({
      captions: [{ caption_id: "SC_001", text: "走り続ける", start_frame: 10, end_frame: 40 }],
      content: [{
        element_id: "TITLE_001",
        template_ref: "vos:content.hook-title/v1",
        props: { title: "走り続ける" },
        start_frame: 0,
        end_frame: 30,
      }],
    })).toThrow(/duplicate semantic owner/i);
  });

  it("rejects graphical content outside the registered template registry", () => {
    expect(() => assertCaptionContentOwnerBoundary({
      captions: [],
      content: [{
        element_id: "TITLE_001",
        template_ref: "project:custom-title/v1",
        props: { title: "custom" },
        start_frame: 0,
        end_frame: 30,
      }],
    })).toThrow(/registered content template/i);
  });
});
