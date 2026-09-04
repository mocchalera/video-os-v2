import { describe, expect, it } from "vitest";

import {
  buildEditorialPipelineStatus,
} from "../scripts/editorial-pipeline.js";
import { validateArtifact } from "../runtime/artifacts/loaders.js";
import {
  loadEditorialPlanningContext,
  loadMarlinEvents,
} from "../runtime/pipeline/editorial-context.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("editorial pipeline optional Marlin evidence", () => {
  it("continues with an empty evidence set when marlin_events.json is absent", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "editorial-no-marlin-"));

    const events = loadMarlinEvents(projectDir);

    expect(events).toEqual({
      project_id: path.basename(projectDir),
      artifact_version: "1.0.0",
      model: {
        provider: "marlin",
        model_alias: "optional-unavailable",
        model_snapshot: "not-generated",
      },
      items: [],
    });
    validateArtifact(events, "marlin-events.schema.json");
  });

  it("applies the shared media-kind preflight before either planning entrypoint runs", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "editorial-guarded-context-"));
    const analysisDir = path.join(projectDir, "03_analysis");
    fs.mkdirSync(analysisDir, { recursive: true });
    fs.writeFileSync(path.join(analysisDir, "assets.json"), JSON.stringify({
      items: [{ asset_id: "AST-unsupported", media_kind: "unknown" }],
    }));

    expect(() => loadEditorialPlanningContext(projectDir)).toThrow(
      "Planning is not supported for asset(s): AST-unsupported",
    );
  });

  it("rejects a creative brief whose identity belongs to another project", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "editorial-foreign-brief-"));
    try {
      fs.cpSync(path.resolve("projects/sample"), projectDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectDir, "project_state.yaml"),
        "version: 1\nproject_id: target-project\ncurrent_state: intent_locked\nhistory: []\n",
      );
      fs.rmSync(path.join(projectDir, "04_plan"), { recursive: true, force: true });

      expect(() => loadEditorialPlanningContext(projectDir)).toThrow(
        "creative_brief.yaml project_id mismatch: expected target-project, got sample-mountain-reset",
      );
      expect(fs.existsSync(path.join(projectDir, "04_plan/selects_candidates.yaml"))).toBe(false);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

describe("editorial pipeline status artifact", () => {
  it("marks QA failure as preview-available but final/package blocked", () => {
    const status = buildEditorialPipelineStatus({
      projectId: "demo",
      createdAt: "2026-07-09T00:00:00.000Z",
      renderSkipped: false,
      roughRenderExists: true,
      qaStatus: "failed",
      qaMessage: "QA loop failed during visual review",
    });

    validateArtifact(status, "editorial-pipeline-status.schema.json");

    expect(status.preview).toEqual({
      status: "available",
      artifact_path: "09_output/rough-cut.mp4",
      render_skipped: false,
    });
    expect(status.qa.status).toBe("failed");
    expect(status.final_render).toEqual({
      status: "blocked",
      reason: "QA_LOOP_FAILED",
    });
    expect(status.package).toEqual({
      status: "blocked",
      reason: "QA_LOOP_FAILED",
    });
    expect(status.blocking_issues).toEqual([
      {
        code: "QA_LOOP_FAILED",
        severity: "fatal",
        stage: "QA",
        message: "QA loop failed during visual review",
      },
    ]);
  });

  it("marks skipped QA as blocking final/package output", () => {
    const status = buildEditorialPipelineStatus({
      projectId: "demo",
      createdAt: "2026-07-09T00:00:00.000Z",
      renderSkipped: true,
      roughRenderExists: false,
      qaStatus: "skipped",
    });

    validateArtifact(status, "editorial-pipeline-status.schema.json");

    expect(status.preview.status).toBe("skipped");
    expect(status.final_render.status).toBe("blocked");
    expect(status.final_render.reason).toBe("QA_SKIPPED");
    expect(status.package.status).toBe("blocked");
    expect(status.package.reason).toBe("QA_SKIPPED");
    expect(status.blocking_issues.map((issue) => issue.code)).toEqual(["QA_SKIPPED"]);
  });

  it("keeps successful QA separate from final approval", () => {
    const status = buildEditorialPipelineStatus({
      projectId: "demo",
      createdAt: "2026-07-09T00:00:00.000Z",
      renderSkipped: false,
      roughRenderExists: true,
      qaStatus: "passed",
      qaResult: {
        iterations: 2,
        fixes_applied_total: 1,
        initial_score: 0.72,
        final_score: 0.86,
        warnings: ["marlin unavailable"],
        visual_qa: { status: "not_applicable", reason: "audio_only_timeline" },
      },
    });

    validateArtifact(status, "editorial-pipeline-status.schema.json");

    expect(status.qa).toMatchObject({
      status: "passed",
      iterations: 2,
      fixes_applied_total: 1,
      initial_score: 0.72,
      final_score: 0.86,
      warnings_count: 1,
      visual_qa: { status: "not_applicable", reason: "audio_only_timeline" },
    });
    expect(status.final_render.status).toBe("not_requested");
    expect(status.package.status).toBe("not_requested");
    expect(status.blocking_issues).toEqual([]);
  });

  it("identifies status written by interactive completion", () => {
    const status = buildEditorialPipelineStatus({
      projectId: "demo",
      entrypoint: "editorial-agent-task",
      createdAt: "2026-07-22T00:00:00.000Z",
      renderSkipped: false,
      roughRenderExists: true,
      qaStatus: "passed",
    });

    validateArtifact(status, "editorial-pipeline-status.schema.json");
    expect(status.entrypoint).toBe("editorial-agent-task");
  });
});
