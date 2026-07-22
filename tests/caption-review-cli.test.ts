import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyCaptionReview,
  approveCaptionReview,
  captionReviewUndoDepth,
  editCaptionReview,
  initializeCaptionReviewPatch,
  mergeCaptionReview,
  proposeCaptionGlossaryTerm,
  queueCaptionReview,
  splitCaptionReview,
  undoCaptionReview,
  validateCaptionReview,
} from "../runtime/caption/review-service.js";
import {
  computeCaptionTextHash,
} from "../runtime/caption/review-core.js";
import {
  parseCaptionReviewArgs,
  runCaptionReviewCli,
} from "../scripts/caption-review.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("caption review CLI workflow", () => {
  it("initializes a hash-bound patch without overwriting human work", () => {
    const projectDir = createProject(["聞きたいことがあります"]);
    const result = initializeCaptionReviewPatch(projectDir, "editor", {
      now: "2026-07-14T10:00:00.000Z",
    });

    expect(result.patch.base_caption_draft_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.patch.base_timeline_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.patch.session.reviewer).toBe("editor");
    expect(() => initializeCaptionReviewPatch(projectDir, "other-editor")).toThrow(
      /already exists/,
    );
  });

  it("exports the Japanese phrase-break error in the risk queue", () => {
    const projectDir = createProject(["まだまだ聞きた\nいことがあります"]);
    const queue = queueCaptionReview(projectDir);

    expect(queue).toHaveLength(1);
    expect(queue[0].issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "unnatural_line_break", severity: "block" }),
    ]));

    const output: string[] = [];
    const exitCode = runCaptionReviewCli([
      "node",
      "caption-review.ts",
      "queue",
      "--project",
      projectDir,
      "--format",
      "csv",
      "--severity",
      "block",
    ], (message) => output.push(message));
    expect(exitCode).toBe(0);
    expect(output.join("\n")).toContain("unnatural_line_break");
    expect(output.join("\n")).toContain("まだまだ聞きた");
  });

  it("applies corrections, validates every caption, and records approval provenance", () => {
    const projectDir = createProject([
      "まだまだ聞きた\nいことがあります",
      "今日はよろしくお願いします",
    ]);
    const { patch, patchPath } = initializeCaptionReviewPatch(projectDir, "editor", {
      now: "2026-07-14T10:00:00.000Z",
    });
    patch.operations = [
      {
        op: "set_line_break",
        caption_id: "SC_001",
        base_text_hash: computeCaptionTextHash("まだまだ聞きた\nいことがあります"),
        lines: ["まだまだ聞きたいことが", "あります"],
      },
      { op: "set_review_state", caption_id: "SC_001", state: "verified" },
      { op: "set_review_state", caption_id: "SC_002", state: "verified" },
    ];
    patch.session.updated_at = "2026-07-14T10:05:00.000Z";
    fs.writeFileSync(patchPath, JSON.stringify(patch, null, 2));

    const applied = applyCaptionReview(projectDir);
    expect(applied.preview.validation).toMatchObject({
      valid: true,
      blocking_issue_count: 0,
      unreviewed_count: 0,
      verified_count: 2,
    });
    expect(fs.existsSync(applied.previewPath)).toBe(true);
    expect(validateCaptionReview(projectDir).valid).toBe(true);

    const approved = approveCaptionReview(projectDir, "human-editor", {
      approvedAt: "2026-07-14T10:06:00.000Z",
    });
    expect(approved.approval.approval).toMatchObject({
      status: "approved",
      approved_by: "human-editor",
      base_caption_draft_hash: patch.base_caption_draft_hash,
      caption_review_patch_hash: approved.patchHash,
      validation_hash: approved.validationHash,
    });
    expect(approved.approval.speech_captions[0].text).toBe("まだまだ聞きたいことが\nあります");
    expect(approved.approval.speech_captions[0]).not.toHaveProperty("review");
    expect(fs.existsSync(approved.approvalPath)).toBe(true);
  });

  it("refuses approval while captions are unreviewed", () => {
    const projectDir = createProject(["聞きたいことがあります"]);
    initializeCaptionReviewPatch(projectDir, "editor");

    expect(() => approveCaptionReview(projectDir, "human-editor")).toThrow(
      /1 caption\(s\) are unreviewed/,
    );
    expect(fs.existsSync(path.join(projectDir, "07_package/caption_approval.json"))).toBe(false);
  });

  it("edits through the shared adapter and returns the patched queue state", () => {
    const projectDir = createProject(["聞きた\nいことがあります"]);
    initializeCaptionReviewPatch(projectDir, "Studio editor");

    const result = editCaptionReview(projectDir, {
      captionID: "SC_001",
      text: "聞きたいことが\nあります",
      state: "verified",
      category: "stt",
      updatedAt: "2026-07-14T11:00:00.000Z",
    });
    expect(result.preview.speech_captions[0]).toMatchObject({
      text: "聞きたいことが\nあります",
      review: { state: "verified", edited: true },
    });
    expect(result.preview.speech_captions[0].text_hash).toMatch(/^sha256:[a-f0-9]{64}$/);

    const queue = queueCaptionReview(projectDir);
    expect(queue[0]).toMatchObject({
      caption_id: "SC_001",
      text: "聞きたいことが\nあります",
      source_text: "聞きたいことがあります",
      review_state: "verified",
    });
    expect(queue[0].issues.map((issue) => issue.code)).not.toContain("unnatural_line_break");
  });

  it("adjusts timing with stale-edit protection and multi-level action undo", () => {
    const projectDir = createProject(["聞きたいことがあります"]);
    initializeCaptionReviewPatch(projectDir, "Studio editor");
    const initial = queueCaptionReview(projectDir)[0];

    const edited = editCaptionReview(projectDir, {
      captionID: initial.caption_id,
      text: "まだ聞きたいことがあります",
      state: "unreviewed",
      startFrame: 6,
      endFrame: 78,
      expectedTextHash: initial.text_hash,
      updatedAt: "2026-07-14T11:10:00.000Z",
    });
    expect(edited.patch.session.last_action_operation_count).toBe(3);
    expect(edited.patch.session.action_operation_counts).toEqual([3]);
    expect(edited.preview.speech_captions[0]).toMatchObject({
      timeline_in_frame: 6,
      timeline_duration_frames: 72,
      text: "まだ聞きたいことがあります",
    });
    expect(() => editCaptionReview(projectDir, {
      captionID: initial.caption_id,
      text: "古い画面から上書き",
      expectedTextHash: initial.text_hash,
    })).toThrow(/changed since it was loaded/);

    const current = edited.preview.speech_captions[0];
    editCaptionReview(projectDir, {
      captionID: current.caption_id,
      text: "さらに聞きたいことがあります",
      expectedTextHash: current.text_hash,
      updatedAt: "2026-07-14T11:10:30.000Z",
    });
    expect(captionReviewUndoDepth(projectDir)).toBe(2);

    const firstUndo = undoCaptionReview(projectDir, "2026-07-14T11:11:00.000Z");
    expect(firstUndo.preview.speech_captions[0]).toMatchObject({
      timeline_in_frame: 6,
      timeline_duration_frames: 72,
      text: "まだ聞きたいことがあります",
    });
    expect(firstUndo.patch.session.action_operation_counts).toEqual([3]);
    expect(captionReviewUndoDepth(projectDir)).toBe(1);

    const secondUndo = undoCaptionReview(projectDir, "2026-07-14T11:12:00.000Z");
    expect(secondUndo.preview.speech_captions[0]).toMatchObject({
      timeline_in_frame: 0,
      timeline_duration_frames: 72,
      text: "聞きたいことがあります",
    });
    expect(secondUndo.patch.session.action_operation_counts).toEqual([]);
    expect(secondUndo.patch.session.last_action_operation_count).toBe(0);
    expect(captionReviewUndoDepth(projectDir)).toBe(0);
  });

  it("promotes a human correction to a reversible glossary proposal", () => {
    const projectDir = createProject(["富井のイベントです"]);
    initializeCaptionReviewPatch(projectDir, "Studio editor");

    const proposed = proposeCaptionGlossaryTerm(projectDir, {
      canonical: "Tomy",
      variants: ["富井", " 富井 "],
      sourceCaptionIDs: ["SC_001"],
      updatedAt: "2026-07-14T11:20:00.000Z",
    });
    expect(proposed.preview.glossary_proposals).toEqual([{
      canonical: "Tomy",
      variants: ["富井"],
      source_caption_ids: ["SC_001"],
    }]);
    expect(captionReviewUndoDepth(projectDir)).toBe(1);

    const output: string[] = [];
    expect(runCaptionReviewCli([
      "node", "caption-review.ts", "queue",
      "--project", projectDir,
      "--format", "json",
      "--severity", "all",
    ], (message) => output.push(message))).toBe(0);
    expect(JSON.parse(output.join("\n"))).toMatchObject({
      undo_depth: 1,
      glossary_proposals: [{ canonical: "Tomy", variants: ["富井"] }],
      caption_style: {
        preset_id: "longform-event",
        font_id: "noto-sans-jp",
        font_family: "Noto Sans JP",
        font_size_px_1080: 56,
        line_height_px_1080: 70,
        outline_px_1080: 4,
        margin_v_1080: 48,
        max_width_ratio: 0.9,
        alignment: "bottom_center",
      },
    });

    const undone = undoCaptionReview(projectDir);
    expect(undone.preview.glossary_proposals).toEqual([]);
  });

  it("splits and merges adjacent captions through canonical operations", () => {
    const projectDir = createProject(["前半です。後半です", "次の字幕です"]);
    initializeCaptionReviewPatch(projectDir, "Studio editor");
    const initial = queueCaptionReview(projectDir);

    const split = splitCaptionReview(projectDir, {
      captionID: "SC_001",
      splitFrame: 36,
      expectedTextHash: initial[0].text_hash,
    });
    expect(split.preview.speech_captions.slice(0, 2)).toMatchObject([
      { caption_id: "SC_001_A", text: "前半です。", timeline_in_frame: 0, timeline_duration_frames: 36 },
      { caption_id: "SC_001_B", text: "後半です", timeline_in_frame: 36, timeline_duration_frames: 36 },
    ]);

    const splitQueue = queueCaptionReview(projectDir)
      .sort((a, b) => a.timeline_in_frame - b.timeline_in_frame);
    const merged = mergeCaptionReview(projectDir, {
      firstCaptionID: "SC_001_A",
      secondCaptionID: "SC_001_B",
      expectedFirstTextHash: splitQueue[0].text_hash,
      expectedSecondTextHash: splitQueue[1].text_hash,
    });
    expect(merged.preview.speech_captions[0]).toMatchObject({
      caption_id: "SC_001_A",
      text: "前半です。後半です",
      timeline_in_frame: 0,
      timeline_duration_frames: 72,
    });
  });

  it("rejects a stale patch after the timeline changes", () => {
    const projectDir = createProject(["聞きたいことがあります"]);
    initializeCaptionReviewPatch(projectDir, "editor");
    const timelinePath = path.join(projectDir, "05_timeline/timeline.json");
    const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf-8"));
    timeline.sequence.name = "changed after review started";
    fs.writeFileSync(timelinePath, JSON.stringify(timeline, null, 2));

    const result = validateCaptionReview(projectDir);
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toMatch(/base_timeline_hash/);
  });

  it("parses the explicit headless commands", () => {
    const args = parseCaptionReviewArgs([
      "node",
      "caption-review.ts",
      "approve",
      "--project",
      "/tmp/project",
      "--reviewer",
      "Sakamoto",
    ]);
    expect(args.command).toBe("approve");
    expect(args.reviewer).toBe("Sakamoto");
    expect(() => parseCaptionReviewArgs([
      "node",
      "caption-review.ts",
      "approve",
      "--project",
      "/tmp/project",
    ])).toThrow(/--reviewer is required/);

    const edit = parseCaptionReviewArgs([
      "node",
      "caption-review.ts",
      "edit",
      "--project",
      "/tmp/project",
      "--caption-id",
      "SC_001",
      "--text",
      "修正文",
      "--state",
      "verified",
    ]);
    expect(edit).toMatchObject({
      command: "edit",
      captionID: "SC_001",
      text: "修正文",
      state: "verified",
    });

    const glossary = parseCaptionReviewArgs([
      "node", "caption-review.ts", "glossary-propose",
      "--project", "/tmp/project",
      "--caption-id", "SC_001",
      "--canonical", "Tomy",
      "--variant", "富井",
    ]);
    expect(glossary).toMatchObject({
      command: "glossary-propose",
      captionID: "SC_001",
      canonical: "Tomy",
      variants: ["富井"],
    });
  });
});

function createProject(texts: string[]): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "caption-review-cli-"));
  temporaryDirectories.push(projectDir);
  fs.mkdirSync(path.join(projectDir, "05_timeline"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, "07_package"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "05_timeline/timeline.json"), JSON.stringify({
    version: "1",
    project_id: "caption-review-test",
    sequence: {
      name: "Caption review test",
      fps_num: 24,
      fps_den: 1,
      width: 1920,
      height: 1080,
      start_frame: 0,
      output_aspect_ratio: "16:9",
    },
    tracks: { video: [], audio: [] },
  }, null, 2));
  fs.writeFileSync(path.join(projectDir, "07_package/caption_draft.json"), JSON.stringify({
    version: "1.0",
    project_id: "caption-review-test",
    base_timeline_version: "1",
    caption_policy: {
      language: "ja",
      delivery_mode: "both",
      source: "transcript",
      styling_class: "longform-event",
    },
    speech_captions: texts.map((text, index) => ({
      caption_id: `SC_${String(index + 1).padStart(3, "0")}`,
      asset_id: "AST_001",
      segment_id: `SEG_${String(index + 1).padStart(3, "0")}`,
      timeline_in_frame: index * 72,
      timeline_duration_frames: 72,
      text,
      transcript_ref: "TR_001",
      transcript_item_ids: [`TI_${index + 1}`],
      source: "transcript",
      styling_class: "longform-event",
      metrics: { cps: 4, dwell_ms: 3000 },
      editorial: {
        sourceText: text.replace(/\n/g, ""),
        operations: [],
        glossaryHits: [],
        confidence: 1,
        status: "clean",
      },
      timing: {
        source: "clip_item_remap",
        confidence: 1,
        triggeredFallback: false,
        timelineInFrame: index * 72,
        timelineDurationFrames: 72,
      },
    })),
    text_overlays: [],
    draft_status: "ready_for_human_approval",
    degraded_count: 0,
  }, null, 2));
  return projectDir;
}
