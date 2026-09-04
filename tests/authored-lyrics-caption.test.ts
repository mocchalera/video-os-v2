import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  approveCaptions,
  captionCommand,
} from "../runtime/commands/caption.js";
import {
  buildAuthoredCaptionArtifacts,
  hashAuthoredTextAuthority,
  hashAuthoredTimingAuthority,
  readAuthoredCaptionIdentity,
  readAuthoredCaptionStatus,
  sha256Bytes,
} from "../runtime/caption/authored-lyrics.js";
import { runStatus } from "../runtime/commands/status.js";
import { validateAgainstSchema } from "../runtime/commands/shared.js";
import { parseCaptionArgs } from "../scripts/caption.js";
import { formatStatusResult } from "../scripts/status.js";
import { parseArgs as parseFullPipelineArgs } from "../scripts/full-pipeline.js";
import { runEditorialDownstream } from "../scripts/editorial-downstream.js";
import { runReview } from "../runtime/commands/review/index.js";
import { computeFileHash, snapshotArtifacts } from "../runtime/state/reconcile.js";

const tempDirs: string[] = [];

afterAll(() => {
  for (const directory of tempDirs) fs.rmSync(directory, { recursive: true, force: true });
});

function copyDir(source: string, target: string): void {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) copyDir(sourcePath, targetPath);
    else fs.copyFileSync(sourcePath, targetPath);
  }
}

function createProject(name: string, lines: string[]): { projectDir: string; lyricsPath: string; timingPath: string } {
  const projectDir = fs.mkdtempSync(path.join(path.resolve("tests"), `tmp-authored-${name}-`));
  tempDirs.push(projectDir);
  copyDir(path.resolve("projects/sample"), projectDir);
  const blueprintPath = path.join(projectDir, "04_plan/edit_blueprint.yaml");
  const blueprint = parseYaml(fs.readFileSync(blueprintPath, "utf8")) as Record<string, unknown>;
  blueprint.caption_policy = {
    language: "en",
    delivery_mode: "burn_in",
    source: "authored",
    styling_class: "default",
  };
  fs.writeFileSync(blueprintPath, stringifyYaml(blueprint), "utf8");

  const timelinePath = path.join(projectDir, "05_timeline/timeline.json");
  const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf8")) as any;
  // Give the deterministic fixture enough room for 68 visible lyric cues.
  const lastVideo = timeline.tracks.video[0].clips.at(-1);
  lastVideo.timeline_duration_frames = 2200;
  fs.writeFileSync(timelinePath, JSON.stringify(timeline, null, 2), "utf8");

  const lyricsPath = path.join(projectDir, "01_intent", "authored-lyrics.txt");
  fs.writeFileSync(lyricsPath, lines.join("\n"), "utf8");
  const timingPath = path.join(projectDir, "03_analysis", "authored-timing.json");
  fs.writeFileSync(timingPath, JSON.stringify({
    version: "test-timing/v1",
    cues: lines.map((_line, index) => ({
      line_number: index + 1,
      start_frame: index * 24,
      end_frame: index * 24 + 24,
      confidence: 1,
    })),
  }, null, 2), "utf8");
  fs.writeFileSync(path.join(projectDir, "project_state.yaml"), stringifyYaml({
    version: 1,
    project_id: "sample-mountain-reset",
    current_state: "approved",
    gates: { review_gate: "open", analysis_gate: "ready", compile_gate: "open", planning_gate: "open", timeline_gate: "open" },
    approval_record: { status: "clean", approved_by: "operator", approved_at: "2026-03-21T10:00:00Z" },
  }), "utf8");
  return { projectDir, lyricsPath, timingPath };
}

function runPublicCaption(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const tsxCli = path.resolve("node_modules/tsx/dist/cli.mjs");
  const result = spawnSync(process.execPath, [tsxCli, path.resolve("scripts/caption.ts"), ...args, "--json"], {
    cwd: path.resolve("."),
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function markCurrentReviewApproval(projectDir: string, status: "clean" | "creative_override"): void {
  const reviewDir = path.join(projectDir, "06_review");
  const reportPath = path.join(reviewDir, "review_report.yaml");
  const patchPath = path.join(reviewDir, "review_patch.json");
  fs.writeFileSync(reportPath, "version: review-report/v2\nproject_id: sample-mountain-reset\n", "utf8");
  fs.writeFileSync(patchPath, "{}", "utf8");
  const statePath = path.join(projectDir, "project_state.yaml");
  const state = parseYaml(fs.readFileSync(statePath, "utf8")) as Record<string, any>;
  state.current_state = "approved";
  state.artifact_hashes = snapshotArtifacts(projectDir).hashes;
  state.approval_record = {
    status,
    approved_by: "reviewer",
    approved_at: "2026-09-01T00:00:00.000Z",
    ...(status === "creative_override" ? { override_reason: "approved fixture override" } : {}),
    artifact_versions: {
      timeline_version: computeFileHash(path.join(projectDir, "05_timeline/timeline.json")),
      review_report_version: computeFileHash(reportPath),
      review_patch_hash: computeFileHash(patchPath),
    },
  };
  fs.writeFileSync(statePath, stringifyYaml(state), "utf8");
}

describe("Issue #41 authored lyrics caption MVP", () => {
  it("public CLI reaches draft and explicit approval with exact 68-line authored body", () => {
    const lines = Array.from({ length: 68 }, (_value, index) => `authored ${String(index + 1).padStart(2, "0")}`);
    const fixture = createProject("68-lines", lines);
    expect(parseCaptionArgs(["node", "scripts/caption.ts", "--project", fixture.projectDir, "--source", "authored", "--lyrics", fixture.lyricsPath, "--timing-plan", fixture.timingPath])).toMatchObject({ command: "draft" });

    const draftRun = runPublicCaption(["--project", fixture.projectDir, "--source", "authored", "--lyrics", fixture.lyricsPath, "--timing-plan", fixture.timingPath]);
    expect(draftRun.status, draftRun.stderr).toBe(0);
    const draftResult = JSON.parse(draftRun.stdout);
    expect(draftResult.success).toBe(true);
    expect(draftResult.captionDraft.draft_status).toBe("ready_for_human_approval");
    expect(draftResult.captionDraft.text_authority.line_count).toBe(68);
    expect(draftResult.captionDraft.text_authority.lines.map((line: { text: string }) => line.text)).toEqual(lines);
    expect(draftResult.captionDraft.speech_captions.map((caption: { text: string }) => caption.text)).toEqual(lines);
    expect(draftResult.captionDraft.speech_captions[0].line_id).toBe("AL_0001");
    expect(draftResult.captionDraft.speech_captions[67].cue_id).toBe("AC_0068");
    expect(draftResult.authoredPreview.changes).toEqual(expect.objectContaining({
      one_frame_gap_handling: expect.any(Object),
      minimum_display_duration: expect.any(Object),
      cps: expect.any(Array),
    }));
    expect(fs.existsSync(path.join(fixture.projectDir, "07_package/caption_approval.json"))).toBe(false);

    const approvalRun = runPublicCaption(["approve", "--project", fixture.projectDir, "--approved-by", "human-operator", "--approved-at", "2026-09-01T00:00:00.000Z"]);
    expect(approvalRun.status, approvalRun.stderr).toBe(0);
    const approvalResult = JSON.parse(approvalRun.stdout);
    expect(approvalResult.success).toBe(true);
    expect(approvalResult.captionApproval.approval.approved_by).toBe("human-operator");
    const timeline = JSON.parse(fs.readFileSync(path.join(fixture.projectDir, "05_timeline/timeline.json"), "utf8"));
    expect(timeline.tracks.caption.find((track: { track_id: string }) => track.track_id === "C1").clips).toHaveLength(68);
    const receipt = JSON.parse(fs.readFileSync(path.join(fixture.projectDir, "07_package/caption_projection_receipt.json"), "utf8"));
    expect(receipt.projected_timeline_hash).toBe(sha256Bytes(fs.readFileSync(path.join(fixture.projectDir, "05_timeline/timeline.json"))));
    expect(readAuthoredCaptionStatus(fixture.projectDir).status).toBe("ready");
    expect(readAuthoredCaptionIdentity(fixture.projectDir)?.timeline_sha256).toBe(receipt.projected_timeline_hash);
    for (const [schema, file] of [
      ["authored-caption-source.schema.json", "caption_source.json"],
      ["caption-draft.schema.json", "caption_draft.json"],
      ["authored-caption-preview.schema.json", "caption_preview.json"],
      ["caption-approval.schema.json", "caption_approval.json"],
      ["authored-caption-projection.schema.json", "caption_projection_receipt.json"],
    ] as const) {
      const value = JSON.parse(fs.readFileSync(path.join(fixture.projectDir, "07_package", file), "utf8"));
      expect(validateAgainstSchema(value, schema), `${schema}: ${file}`).toEqual({ valid: true, errors: [] });
    }
  });

  it("keeps hostile STT text out of the authored body and leaves the cue pending", () => {
    const fixture = createProject("hostile-stt", ["ORIGINAL AUTHOR TEXT", "SECOND ORIGINAL"]);
    fs.writeFileSync(fixture.timingPath, JSON.stringify({ words: [
      { id: "w1", word: "HOSTILE MISTRANSLATION", start_frame: 0, end_frame: 24, confidence: 1 },
      { id: "w2", word: "UNRELATED", start_frame: 24, end_frame: 48, confidence: 1 },
    ] }), "utf8");
    const result = captionCommand(fixture.projectDir, {
      source: "authored",
      lyricsPath: fixture.lyricsPath,
      timingPlanPath: fixture.timingPath,
      editorialEnabled: false,
    });
    expect(result.success).toBe(true);
    expect(result.captionDraft?.speech_captions.map((caption) => caption.text)).toEqual(["ORIGINAL AUTHOR TEXT", "SECOND ORIGINAL"]);
    expect(result.captionDraft?.timing_authority?.unmatched_count).toBe(2);
    expect(result.captionDraft?.draft_status).toBe("needs_operator_fix");
    expect(approveCaptions(fixture.projectDir, { approvedBy: "human" }).success).toBe(false);
    expect(fs.existsSync(path.join(fixture.projectDir, "07_package/caption_approval.json"))).toBe(false);
  });

  it("routes the full-pipeline boundary through caption approval and preserves approved C1", async () => {
    const fixture = createProject("full-pipeline-route", ["route body"]);
    expect(captionCommand(fixture.projectDir, {
      source: "authored",
      lyricsPath: fixture.lyricsPath,
      timingPlanPath: fixture.timingPath,
      editorialEnabled: false,
    }).success).toBe(true);
    const pipelineInputs = {
      brief: parseYaml(fs.readFileSync(path.join(fixture.projectDir, "01_intent/creative_brief.yaml"), "utf8")) as any,
      selects: parseYaml(fs.readFileSync(path.join(fixture.projectDir, "04_plan/selects_candidates.yaml"), "utf8")) as any,
      blueprint: parseYaml(fs.readFileSync(path.join(fixture.projectDir, "04_plan/edit_blueprint.yaml"), "utf8")) as any,
    };
    const calls: string[] = [];
    await expect(runEditorialDownstream({
      projectDir: fixture.projectDir,
      ...pipelineInputs,
      entrypoint: "editorial-pipeline",
      skipRender: false,
      skipQa: true,
      beforeRender: async () => {
        calls.push("caption_gate");
        const status = readAuthoredCaptionStatus(fixture.projectDir);
        if (status.status !== "ready") throw new Error(`caption gate pending: ${status.next_command}`);
      },
    }, {
      runCompile: async () => { calls.push("compile"); },
      runRender: async () => { calls.push("render"); },
    })).rejects.toThrow(/caption gate pending/i);
    expect(calls).toEqual(["compile", "caption_gate"]);

    expect(approveCaptions(fixture.projectDir, { approvedBy: "human" }).success).toBe(true);
    const projectedTimelineBytes = fs.readFileSync(path.join(fixture.projectDir, "05_timeline/timeline.json"), "utf8");
    calls.length = 0;
    await runEditorialDownstream({
      projectDir: fixture.projectDir,
      ...pipelineInputs,
      entrypoint: "editorial-pipeline",
      skipRender: true,
      skipQa: true,
      shouldSkipCompile: () => readAuthoredCaptionStatus(fixture.projectDir).status === "ready",
      beforeRender: async () => {
        calls.push("caption_gate");
        expect(readAuthoredCaptionStatus(fixture.projectDir).status).toBe("ready");
      },
    }, {
      runCompile: async () => { calls.push("compile"); },
    });
    expect(calls).toEqual(["caption_gate"]);
    expect(fs.readFileSync(path.join(fixture.projectDir, "05_timeline/timeline.json"), "utf8")).toBe(projectedTimelineBytes);
  });

  it("detects authored caption policy on a no-argument full-pipeline resume", async () => {
    const fixture = createProject("full-pipeline-no-args", ["resume body"]);
    const pipelineInputs = {
      brief: parseYaml(fs.readFileSync(path.join(fixture.projectDir, "01_intent/creative_brief.yaml"), "utf8")) as any,
      selects: parseYaml(fs.readFileSync(path.join(fixture.projectDir, "04_plan/selects_candidates.yaml"), "utf8")) as any,
      blueprint: parseYaml(fs.readFileSync(path.join(fixture.projectDir, "04_plan/edit_blueprint.yaml"), "utf8")) as any,
    };
    const calls: string[] = [];
    await expect(runEditorialDownstream({
      projectDir: fixture.projectDir,
      ...pipelineInputs,
      entrypoint: "editorial-pipeline",
      skipRender: false,
      skipQa: true,
    }, {
      runCompile: async () => { calls.push("compile"); },
      runRender: async () => { calls.push("render"); },
    })).rejects.toThrow(/caption gate pending/i);
    expect(calls).toEqual(["compile"]);

    expect(captionCommand(fixture.projectDir, {
      source: "authored",
      lyricsPath: fixture.lyricsPath,
      timingPlanPath: fixture.timingPath,
      editorialEnabled: false,
    }).success).toBe(true);
    expect(approveCaptions(fixture.projectDir, { approvedBy: "human" }).success).toBe(true);
    const projectedTimelineBytes = fs.readFileSync(path.join(fixture.projectDir, "05_timeline/timeline.json"), "utf8");
    calls.length = 0;
    await runEditorialDownstream({
      projectDir: fixture.projectDir,
      ...pipelineInputs,
      entrypoint: "editorial-pipeline",
      skipRender: false,
      skipQa: true,
    }, {
      runCompile: async () => { calls.push("compile"); },
      runRender: async () => { calls.push("render"); },
    });
    expect(calls).toEqual(["render"]);
    expect(fs.readFileSync(path.join(fixture.projectDir, "05_timeline/timeline.json"), "utf8")).toBe(projectedTimelineBytes);
  });

  it("marks onset-only low confidence for human confirmation and separates text/timing identity", () => {
    const fixture = createProject("low-confidence", ["first authored line", "second authored line"]);
    fs.writeFileSync(fixture.timingPath, JSON.stringify({ onsets: [
      { id: "onset-1", start_frame: 0, end_frame: 24, confidence: 0.4 },
      { id: "onset-2", start_frame: 24, end_frame: 48, confidence: 0.4 },
    ] }), "utf8");
    const result = captionCommand(fixture.projectDir, {
      source: "authored",
      lyricsPath: fixture.lyricsPath,
      timingPlanPath: fixture.timingPath,
      editorialEnabled: false,
    });
    expect(result.captionDraft?.timing_authority?.pending_count).toBe(2);
    expect(result.captionDraft?.timing_authority?.unmatched_count).toBe(0);
    expect(readAuthoredCaptionStatus(fixture.projectDir)).toMatchObject({ status: "stale", low_confidence_line_ids: ["AL_0001", "AL_0002"] });
    expect(approveCaptions(fixture.projectDir, { approvedBy: "human" }).success).toBe(false);
  });

  it("keeps authored text identity stable across timing-only reanalysis and stales after lyric edit", async () => {
    const fixture = createProject("authority-staleness", ["same authored body 1", "same authored body 2"]);
    const first = captionCommand(fixture.projectDir, { source: "authored", lyricsPath: fixture.lyricsPath, timingPlanPath: fixture.timingPath, editorialEnabled: false });
    expect(first.captionDraft).toBeDefined();
    const firstTextHash = hashAuthoredTextAuthority(first.captionDraft!.text_authority!);
    const firstTimingHash = hashAuthoredTimingAuthority(first.captionDraft!.timing_authority!);
    fs.writeFileSync(fixture.timingPath, JSON.stringify({ cues: [
      { line_number: 1, start_frame: 12, end_frame: 36, confidence: 1 },
      { line_number: 2, start_frame: 36, end_frame: 60, confidence: 1 },
    ] }), "utf8");
    const second = captionCommand(fixture.projectDir, { source: "authored", lyricsPath: fixture.lyricsPath, timingPlanPath: fixture.timingPath, editorialEnabled: false });
    expect(hashAuthoredTextAuthority(second.captionDraft!.text_authority!)).toBe(firstTextHash);
    expect(hashAuthoredTimingAuthority(second.captionDraft!.timing_authority!)).not.toBe(firstTimingHash);
    fs.writeFileSync(fixture.lyricsPath, "changed authored body 1\nsame authored body 2", "utf8");
    const staleStatus = runStatus(fixture.projectDir);
    expect(staleStatus.authoredLyrics).toMatchObject({ status: "stale" });
    expect(formatStatusResult(fixture.projectDir, staleStatus)).toContain("Authored lyrics: stale");
    expect(formatStatusResult(fixture.projectDir, staleStatus)).toContain("Next: npm run caption");

    expect(parseFullPipelineArgs([
      "node",
      "scripts/full-pipeline.ts",
      "--project",
      fixture.projectDir,
      "--lyrics",
      fixture.lyricsPath,
      "--timing-plan",
      fixture.timingPath,
    ])).toMatchObject({ lyricsPath: fixture.lyricsPath, timingPlanPath: fixture.timingPath });

    const reviewFirst = createProject("review-first", ["gate body"]);
    const reviewDraft = captionCommand(reviewFirst.projectDir, { source: "authored", lyricsPath: reviewFirst.lyricsPath, timingPlanPath: reviewFirst.timingPath, editorialEnabled: false });
    expect(reviewDraft.success).toBe(true);
    fs.writeFileSync(path.join(reviewFirst.projectDir, "06_review/review-ready-state.json"), JSON.stringify({
      status: "ready",
      artifacts: { preview: "CURRENT", qa_receipt: "CURRENT", unanswered_ask: "CURRENT" },
    }), "utf8");
    fs.writeFileSync(path.join(reviewFirst.projectDir, "project_state.yaml"), stringifyYaml({
      version: 1,
      project_id: "sample-mountain-reset",
      current_state: "approved",
      review_transaction: { status: "ready" },
    }), "utf8");
    const rejected = approveCaptions(reviewFirst.projectDir, { approvedBy: "human" });
    expect(rejected.success).toBe(false);
    expect(rejected.error?.message).toMatch(/review-ready artifacts would become stale/i);

    const reviewGate = await runReview(reviewFirst.projectDir, { run: async () => { throw new Error("agent must not run before caption gate"); } } as never, { skipPreview: true });
    expect(reviewGate.success).toBe(false);
    expect(reviewGate.error?.code).toBe("GATE_CHECK_FAILED");
  });

  it.each(["clean", "creative_override"] as const)(
    "rejects authored C1 projection when the current ordinary review approval is %s",
    (approvalStatus) => {
      const fixture = createProject(`ordinary-review-${approvalStatus}`, ["body"]);
      expect(captionCommand(fixture.projectDir, {
        source: "authored",
        lyricsPath: fixture.lyricsPath,
        timingPlanPath: fixture.timingPath,
        editorialEnabled: false,
      }).success).toBe(true);
      markCurrentReviewApproval(fixture.projectDir, approvalStatus);
      const timelinePath = path.join(fixture.projectDir, "05_timeline/timeline.json");
      const before = fs.readFileSync(timelinePath, "utf8");
      const result = approveCaptions(fixture.projectDir, { approvedBy: "human" });
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/current review approval/i);
      expect(fs.readFileSync(timelinePath, "utf8")).toBe(before);
      expect(fs.existsSync(path.join(fixture.projectDir, "07_package/caption_approval.json"))).toBe(false);
    },
  );
});
