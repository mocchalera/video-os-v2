import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  ReviewPatchOperatorError,
  runReviewPatchOperator,
} from "../runtime/commands/review-patch.js";
import { runReviewPatchCli } from "../scripts/review-patch.js";
import { computeFileHash } from "../runtime/state/reconcile.js";
import type { TimelineIR } from "../runtime/compiler/types.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  (globalThis as Record<string, unknown>).__issue4RealFs = actual;
  return {
    ...actual,
    default: actual,
    renameSync: vi.fn(((from: fs.PathLike, to: fs.PathLike) => actual.renameSync(from, to)) as typeof fs.renameSync),
  };
});

function realFs(): typeof fs {
  return (globalThis as Record<string, unknown>).__issue4RealFs as typeof fs;
}

function resetFsSeam(): void {
  vi.mocked(fs.renameSync).mockImplementation((from, to) => realFs().renameSync(from, to));
}

const temporaryRoots: string[] = [];

afterEach(() => {
  resetFsSeam();
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function writeJson(filePath: string, value: unknown): string {
  const raw = JSON.stringify(value, null, 2) + "\n";
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, raw, "utf8");
  return raw;
}

function writeYaml(filePath: string, value: unknown): string {
  const raw = stringifyYaml(value);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, raw, "utf8");
  return raw;
}

function makeTimeline(projectId: string): TimelineIR {
  return {
    version: "timeline-v1",
    project_id: projectId,
    created_at: "2026-09-02T00:00:00.000Z",
    sequence: {
      name: "Issue 4 M4 fixture",
      fps_num: 24,
      fps_den: 1,
      width: 1920,
      height: 1080,
      start_frame: 0,
    },
    tracks: {
      video: [{
        track_id: "V1",
        kind: "video",
        clips: [{
          clip_id: "CLP_001",
          segment_id: "SEG_001",
          asset_id: "AST_001",
          src_in_us: 0,
          src_out_us: 1_000_000,
          timeline_in_frame: 0,
          timeline_duration_frames: 24,
          role: "hero",
          motivation: "fixture",
          beat_id: "b01",
          fallback_segment_ids: [],
          confidence: 1,
          quality_flags: [],
        }],
      }],
      audio: [],
    },
    markers: [],
    provenance: {
      brief_path: "01_intent/creative_brief.yaml",
      blueprint_path: "04_plan/edit_blueprint.yaml",
      selects_path: "04_plan/selects_candidates.yaml",
      compiler_version: "issue4-m4-test",
    },
  };
}

function makeFixture(): {
  projectDir: string;
  timelinePath: string;
  statePath: string;
  timelineRaw: string;
  proposalPath: string;
} {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "issue4-m4-review-patch-")));
  temporaryRoots.push(root);
  const projectDir = path.join(root, "project");
  const projectId = "issue4-m4-project";
  const timelinePath = path.join(projectDir, "05_timeline", "timeline.json");
  const timelineRaw = writeJson(timelinePath, makeTimeline(projectId));
  const timelineHash = computeFileHash(timelinePath);
  const statePath = path.join(projectDir, "project_state.yaml");
  writeYaml(statePath, {
    version: 1,
    project_id: projectId,
    current_state: "approved",
    approval_record: {
      status: "clean",
      approved_by: "operator",
      approved_at: "2026-09-02T00:00:00.000Z",
      artifact_versions: {
        timeline_version: timelineHash,
        base_timeline_version: "timeline-v1",
        editorial_timeline_hash: timelineHash,
      },
    },
  });
  const proposalPath = path.join(root, "review-proposal.json");
  writeJson(proposalPath, {
    timeline_version: "timeline-v1",
    operations: [],
  });
  return { projectDir, timelinePath, statePath, timelineRaw, proposalPath };
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("expected " + code);
  } catch (error) {
    expect(error).toBeInstanceOf(ReviewPatchOperatorError);
    expect((error as ReviewPatchOperatorError).code).toBe(code);
  }
}

function runPublicReviewPatch(argv: string[]) {
  const npmExecPath = process.env.npm_execpath;
  return spawnSync(
    npmExecPath ? process.execPath : "npm",
    npmExecPath
      ? [npmExecPath, "run", "--silent", "review-patch", "--", ...argv]
      : ["run", "--silent", "review-patch", "--", ...argv],
    { cwd: process.cwd(), encoding: "utf8" },
  );
}

describe("Issue 4 M4 review-patch/v2 operator boundary", () => {
  it("prepares and checks without project writes, then installs only after explicit acceptance", () => {
    const fixture = makeFixture();
    const outputPath = path.join(path.dirname(fixture.projectDir), "prepared-review-patch.json");
    const beforeTimeline = fs.readFileSync(fixture.timelinePath, "utf8");
    const beforeState = fs.readFileSync(fixture.statePath, "utf8");

    const prepared = runReviewPatchCli([
      "prepare",
      "--project",
      fixture.projectDir,
      "--input",
      fixture.proposalPath,
      "--output",
      outputPath,
      "--json",
    ]);
    expect(prepared.mode).toBe("prepare");
    expect(prepared.status).toBe("proposed");
    expect(prepared.patch.patch_version).toBe("review-patch/v2");
    expect(prepared.patch.base_timeline_sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(prepared.project_writes).toEqual([]);
    expect(fs.existsSync(path.join(fixture.projectDir, "06_review"))).toBe(false);
    expect(fs.readFileSync(fixture.timelinePath, "utf8")).toBe(beforeTimeline);
    expect(fs.readFileSync(fixture.statePath, "utf8")).toBe(beforeState);

    const checked = runReviewPatchCli([
      "check",
      "--project",
      fixture.projectDir,
      "--input",
      outputPath,
      "--json",
    ]);
    expect(checked.mode).toBe("check");
    expect(checked.static_ready).toBe(true);
    expect(checked.project_writes).toEqual([]);
    expect(fs.existsSync(path.join(fixture.projectDir, "06_review"))).toBe(false);

    expectCode(() => runReviewPatchCli([
      "install",
      "--project",
      fixture.projectDir,
      "--input",
      outputPath,
    ]), "ACCEPTANCE_REQUIRED");
    expect(fs.existsSync(path.join(fixture.projectDir, "06_review"))).toBe(false);

    const installed = runReviewPatchCli([
      "install",
      "--project",
      fixture.projectDir,
      "--input",
      outputPath,
      "--accept",
      "--approved-by",
      "operator",
      "--json",
    ]);
    expect(installed.mode).toBe("install");
    expect(installed.status).toBe("accepted");
    expect(installed.accepted_by).toBe("operator");
    expect(installed.project_writes).toEqual(["06_review/review_patch.json", "project_state.yaml"]);
    expect(installed.canonical_timeline_unchanged).toBe(true);
    expect(fs.readFileSync(fixture.timelinePath, "utf8")).toBe(beforeTimeline);
    expect(fs.readFileSync(fixture.statePath, "utf8")).not.toBe(beforeState);
    const persistedPatch = JSON.parse(
      fs.readFileSync(path.join(fixture.projectDir, "06_review/review_patch.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(persistedPatch.patch_version).toBe("review-patch/v2");
    expect(persistedPatch.status).toBe("accepted");
    expect(fs.existsSync(path.join(fixture.projectDir, "05_timeline", "approved.timeline.json"))).toBe(false);
    const persistedState = parseYaml(fs.readFileSync(fixture.statePath, "utf8")) as {
      approval_record: {
        approved_by: string;
        approved_at: string;
        artifact_versions: Record<string, unknown>;
      };
    };
    expect(persistedState.approval_record.approved_by).toBe("operator");
    expect(persistedState.approval_record.approved_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(persistedState.approval_record.artifact_versions.review_patch_hash)
      .toBe(computeFileHash(path.join(fixture.projectDir, "06_review", "review_patch.json")));
    expect(installed.current_artifact_hashes.review_patch_hash)
      .toBe(persistedState.approval_record.artifact_versions.review_patch_hash);
    expect(runReviewPatchCli([
      "check",
      "--project",
      fixture.projectDir,
      "--input",
      outputPath,
    ]).mode).toBe("check");
  });

  it("rejects stale approval identity and a patch bound to another timeline", () => {
    const fixture = makeFixture();
    fs.writeFileSync(fixture.timelinePath, fixture.timelineRaw.replace("Issue 4 M4 fixture", "changed timeline"), "utf8");
    expectCode(() => runReviewPatchCli([
      "check",
      "--project",
      fixture.projectDir,
      "--input",
      fixture.proposalPath,
    ]), "APPROVAL_STALE");

    const fresh = makeFixture();
    const stalePatchPath = path.join(path.dirname(fresh.projectDir), "stale.json");
    writeJson(stalePatchPath, {
      patch_version: "review-patch/v2",
      timeline_version: "timeline-v1",
      base_timeline_sha256: "sha256:" + "0".repeat(64),
      status: "proposed",
      operations: [],
    });
    expectCode(() => runReviewPatchCli([
      "check",
      "--project",
      fresh.projectDir,
      "--input",
      stalePatchPath,
    ]), "TIMELINE_MISMATCH");

    const bound = makeFixture();
    const reportPath = path.join(bound.projectDir, "06_review", "review_report.yaml");
    const reportRaw = writeYaml(reportPath, { version: "fixture-review-report" });
    const state = parseYaml(fs.readFileSync(bound.statePath, "utf8")) as {
      approval_record: { artifact_versions: Record<string, unknown> };
    };
    state.approval_record.artifact_versions.review_report_version = computeFileHash(reportPath);
    writeYaml(bound.statePath, state);
    expect(runReviewPatchCli([
      "check",
      "--project",
      bound.projectDir,
      "--input",
      bound.proposalPath,
    ]).mode).toBe("check");
    fs.writeFileSync(reportPath, reportRaw + "changed\n", "utf8");
    expectCode(() => runReviewPatchCli([
      "check",
      "--project",
      bound.projectDir,
      "--input",
      bound.proposalPath,
    ]), "APPROVAL_STALE");
  });

  it("rejects unsafe replacement operations before any artifact is written", () => {
    const fixture = makeFixture();
    const unsafePath = path.join(path.dirname(fixture.projectDir), "unsafe.json");
    writeJson(unsafePath, {
      timeline_version: "timeline-v1",
      operations: [{
        op: "replace_segment",
        target_clip_id: "CLP_001",
        with_segment_id: "SEG_NOT_APPROVED",
        reason: "fixture unsafe replacement",
      }],
    });
    expectCode(() => runReviewPatchOperator({
      mode: "prepare",
      projectDir: fixture.projectDir,
      inputPath: unsafePath,
    }), "PATCH_UNSAFE");
    expect(fs.existsSync(path.join(fixture.projectDir, "06_review"))).toBe(false);
  });

  it("rejects every project-internal prepare output, including the canonical patch, without writes", () => {
    const fixture = makeFixture();
    const beforeTimeline = fs.readFileSync(fixture.timelinePath, "utf8");
    const beforeState = fs.readFileSync(fixture.statePath, "utf8");
    const internalOutputs = [
      path.join(fixture.projectDir, "prepared.json"),
      path.join(fixture.projectDir, "06_review"),
      path.join(fixture.projectDir, "06_review", "review_patch.json"),
    ];
    for (const outputPath of internalOutputs) {
      expectCode(() => runReviewPatchCli([
        "prepare",
        "--project",
        fixture.projectDir,
        "--input",
        fixture.proposalPath,
        "--output",
        outputPath,
      ]), "PATH_INVALID");
      expect(fs.readFileSync(fixture.timelinePath, "utf8")).toBe(beforeTimeline);
      expect(fs.readFileSync(fixture.statePath, "utf8")).toBe(beforeState);
    }
    expect(fs.existsSync(path.join(fixture.projectDir, "06_review"))).toBe(false);
  });

  it("rejects symlinked or foreign-project human notes without project writes", () => {
    const symlinked = makeFixture();
    const externalNotesPath = path.join(path.dirname(symlinked.projectDir), "external-human-notes.yaml");
    const externalNotesRaw = writeYaml(externalNotesPath, {
      version: 1,
      project_id: "issue4-m4-project",
      notes: [],
    });
    const notesPath = path.join(symlinked.projectDir, "06_review", "human_notes.yaml");
    fs.mkdirSync(path.dirname(notesPath), { recursive: true });
    fs.symlinkSync(externalNotesPath, notesPath);
    const beforeTimeline = fs.readFileSync(symlinked.timelinePath, "utf8");
    const beforeState = fs.readFileSync(symlinked.statePath, "utf8");
    expectCode(() => runReviewPatchCli([
      "prepare",
      "--project",
      symlinked.projectDir,
      "--input",
      symlinked.proposalPath,
    ]), "INPUT_INVALID");
    expect(fs.readFileSync(symlinked.timelinePath, "utf8")).toBe(beforeTimeline);
    expect(fs.readFileSync(symlinked.statePath, "utf8")).toBe(beforeState);
    expect(fs.readFileSync(externalNotesPath, "utf8")).toBe(externalNotesRaw);

    const foreign = makeFixture();
    const foreignNotesPath = path.join(foreign.projectDir, "06_review", "human_notes.yaml");
    writeYaml(foreignNotesPath, { version: 1, project_id: "foreign-project", notes: [] });
    const beforeForeignNotes = fs.readFileSync(foreignNotesPath, "utf8");
    expectCode(() => runReviewPatchCli([
      "check",
      "--project",
      foreign.projectDir,
      "--input",
      foreign.proposalPath,
    ]), "INPUT_INVALID");
    expect(fs.readFileSync(foreignNotesPath, "utf8")).toBe(beforeForeignNotes);
    expect(fs.existsSync(path.join(foreign.projectDir, "06_review", "review_patch.json"))).toBe(false);
  });

  it("requires a prepared v2 candidate, a real approval timestamp, and the established actor", () => {
    const legacy = makeFixture();
    expectCode(() => runReviewPatchCli([
      "install",
      "--project",
      legacy.projectDir,
      "--input",
      legacy.proposalPath,
      "--accept",
      "--approved-by",
      "operator",
    ]), "PREPARED_INPUT_REQUIRED");
    expect(fs.existsSync(path.join(legacy.projectDir, "06_review"))).toBe(false);

    const invalidTimestamp = makeFixture();
    const invalidState = parseYaml(fs.readFileSync(invalidTimestamp.statePath, "utf8")) as {
      approval_record: { approved_at: string };
    };
    invalidState.approval_record.approved_at = "not-an-iso-date";
    writeYaml(invalidTimestamp.statePath, invalidState);
    expectCode(() => runReviewPatchCli([
      "check",
      "--project",
      invalidTimestamp.projectDir,
      "--input",
      invalidTimestamp.proposalPath,
    ]), "NOT_APPROVED");

    const actor = makeFixture();
    const preparedPath = path.join(path.dirname(actor.projectDir), "prepared-for-actor.json");
    runReviewPatchCli([
      "prepare",
      "--project",
      actor.projectDir,
      "--input",
      actor.proposalPath,
      "--output",
      preparedPath,
    ]);
    const beforeTimeline = fs.readFileSync(actor.timelinePath, "utf8");
    const beforeState = fs.readFileSync(actor.statePath, "utf8");
    expectCode(() => runReviewPatchCli([
      "install",
      "--project",
      actor.projectDir,
      "--input",
      preparedPath,
      "--accept",
      "--approved-by",
      "different-operator",
    ]), "APPROVAL_ACTOR_MISMATCH");
    expect(fs.readFileSync(actor.timelinePath, "utf8")).toBe(beforeTimeline);
    expect(fs.readFileSync(actor.statePath, "utf8")).toBe(beforeState);
    expect(fs.existsSync(path.join(actor.projectDir, "06_review", "review_patch.json"))).toBe(false);
  });

  it("keeps the public subprocess prepare/check contract external and read-only", () => {
    const fixture = makeFixture();
    const outputPath = path.join(path.dirname(fixture.projectDir), "public-prepared-review-patch.json");
    const beforeTimeline = fs.readFileSync(fixture.timelinePath, "utf8");
    const beforeState = fs.readFileSync(fixture.statePath, "utf8");
    const prepared = runPublicReviewPatch([
      "prepare",
      "--project",
      fixture.projectDir,
      "--input",
      fixture.proposalPath,
      "--output",
      outputPath,
      "--json",
    ]);
    expect(prepared.status).toBe(0);
    expect(prepared.stderr).toBe("");
    expect(JSON.parse(prepared.stdout)).toMatchObject({
      ok: true,
      mode: "prepare",
      project_writes: [],
    });
    const checked = runPublicReviewPatch([
      "check",
      "--project",
      fixture.projectDir,
      "--input",
      outputPath,
      "--json",
    ]);
    expect(checked.status).toBe(0);
    expect(checked.stderr).toBe("");
    expect(JSON.parse(checked.stdout)).toMatchObject({
      ok: true,
      mode: "check",
      project_writes: [],
      canonical_timeline_unchanged: true,
    });
    expect(fs.readFileSync(fixture.timelinePath, "utf8")).toBe(beforeTimeline);
    expect(fs.readFileSync(fixture.statePath, "utf8")).toBe(beforeState);
    expect(fs.existsSync(path.join(fixture.projectDir, "06_review"))).toBe(false);
  });

  it("rolls back patch and approval state together when state promotion fails, then permits retry", () => {
    const fixture = makeFixture();
    const priorPatchPath = path.join(fixture.projectDir, "06_review", "review_patch.json");
    const priorPatchRaw = writeJson(priorPatchPath, {
      patch_version: "review-patch/v2",
      timeline_version: "timeline-v1",
      base_timeline_sha256: "sha256:" + "0".repeat(64),
      status: "accepted",
      operations: [],
    });
    const state = parseYaml(fs.readFileSync(fixture.statePath, "utf8")) as {
      approval_record: { artifact_versions: Record<string, unknown> };
    };
    state.approval_record.artifact_versions.review_patch_hash = computeFileHash(priorPatchPath);
    writeYaml(fixture.statePath, state);
    const preparedPath = path.join(path.dirname(fixture.projectDir), "prepared-transaction-review-patch.json");
    runReviewPatchCli([
      "prepare",
      "--project",
      fixture.projectDir,
      "--input",
      fixture.proposalPath,
      "--output",
      preparedPath,
    ]);
    const beforeTimeline = fs.readFileSync(fixture.timelinePath, "utf8");
    const beforeState = fs.readFileSync(fixture.statePath, "utf8");
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      if (String(to) === fixture.statePath && String(from).includes(".draft-")) {
        throw new Error("injected project_state atomic rename failure");
      }
      return realFs().renameSync(from, to);
    });
    try {
      expectCode(() => runReviewPatchCli([
        "install",
        "--project",
        fixture.projectDir,
        "--input",
        preparedPath,
        "--accept",
        "--approved-by",
        "operator",
      ]), "PROMOTE_FAILED");
    } finally {
      resetFsSeam();
    }
    expect(fs.readFileSync(priorPatchPath, "utf8")).toBe(priorPatchRaw);
    expect(fs.readFileSync(fixture.statePath, "utf8")).toBe(beforeState);
    expect(fs.readFileSync(fixture.timelinePath, "utf8")).toBe(beforeTimeline);
    expect(fs.existsSync(path.join(fixture.projectDir, ".vos-promote-lock"))).toBe(false);
    expect(runReviewPatchCli([
      "check",
      "--project",
      fixture.projectDir,
      "--input",
      preparedPath,
    ]).mode).toBe("check");

    const retry = runReviewPatchCli([
      "install",
      "--project",
      fixture.projectDir,
      "--input",
      preparedPath,
      "--accept",
      "--approved-by",
      "operator",
    ]);
    expect(retry.status).toBe("accepted");
    expect(retry.project_writes).toEqual(["06_review/review_patch.json", "project_state.yaml"]);
    expect(fs.readFileSync(fixture.timelinePath, "utf8")).toBe(beforeTimeline);
    expect(runReviewPatchCli([
      "check",
      "--project",
      fixture.projectDir,
      "--input",
      preparedPath,
    ]).mode).toBe("check");
  });
});
