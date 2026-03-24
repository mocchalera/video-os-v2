/**
 * Editor Job Worker — spawned by editor server to run AI pipeline phases.
 *
 * Usage:
 *   npx tsx scripts/editor-job-worker.ts <projectDir> <phase> [optionsJSON]
 *
 * Phases: compile | review | render
 *
 * Writes JSON result to stdout on completion. Exit code 0 = success, 1 = failure.
 * Progress is tracked via progress.json (written by ProgressTracker in runtime).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { runCompilePhase } from "../runtime/commands/compile.js";
import { runReview, type ReviewAgent, type ReviewAgentContext, type ReviewAgentResult } from "../runtime/commands/review/index.js";
import { runRender } from "../runtime/commands/render.js";

// ── Parse CLI args ──────────────────────────────────────────────

const [, , projectDir, phase, optionsJson] = process.argv;

if (!projectDir || !phase) {
  console.error("Usage: editor-job-worker.ts <projectDir> <phase> [optionsJSON]");
  process.exit(1);
}

const resolvedDir = path.resolve(projectDir);
if (!fs.existsSync(resolvedDir)) {
  writeResult({ success: false, error: `Project directory not found: ${resolvedDir}` });
  process.exit(1);
}

let options: Record<string, unknown> = {};
if (optionsJson) {
  try {
    options = JSON.parse(optionsJson);
  } catch {
    writeResult({ success: false, error: "Invalid options JSON" });
    process.exit(1);
  }
}

// ── Stub ReviewAgent for editor-initiated reviews ───────────────
// In production, this would delegate to an LLM-backed agent.
// The stub reads existing review artifacts if present, or produces
// a minimal "re-review needed" report.

class StubReviewAgent implements ReviewAgent {
  async run(ctx: ReviewAgentContext): Promise<ReviewAgentResult> {
    // Try to read existing review artifacts as base
    const reportPath = path.join(ctx.projectDir, "06_review/review_report.yaml");
    const patchPath = path.join(ctx.projectDir, "06_review/review_patch.json");

    let existingPatch = { timeline_version: ctx.timelineVersion, operations: [] as unknown[] };
    if (fs.existsSync(patchPath)) {
      try {
        existingPatch = JSON.parse(fs.readFileSync(patchPath, "utf-8"));
      } catch { /* use default */ }
    }

    // Generate a minimal review report
    const report = {
      version: "1",
      project_id: ctx.projectId,
      timeline_version: ctx.timelineVersion,
      created_at: new Date().toISOString(),
      summary_judgment: {
        status: "needs_revision" as const,
        rationale: "Editor-initiated review — stub agent. Replace with LLM-backed ReviewAgent for production reviews.",
        confidence: 0.5,
      },
      strengths: [
        { summary: "Timeline structure is valid and compilable." },
      ],
      weaknesses: [],
      fatal_issues: [],
      warnings: [
        {
          summary: "Stub review agent — no deep analysis performed",
          severity: "warning" as const,
        },
      ],
      mismatches_to_brief: [],
      mismatches_to_blueprint: [],
      recommended_next_pass: {
        goal: "Replace stub agent with LLM-backed review for meaningful analysis",
        actions: ["Configure REVIEW_AGENT_PROVIDER environment variable"],
      },
    };

    return {
      report,
      patch: {
        timeline_version: ctx.timelineVersion,
        operations: existingPatch.operations ?? [],
      },
    } as ReviewAgentResult;
  }
}

// ── Run phase ───────────────────────────────────────────────────

async function main(): Promise<void> {
  try {
    switch (phase) {
      case "compile": {
        const result = runCompilePhase(resolvedDir, {
          createdAt: options.created_at as string | undefined,
          fpsNum: options.fps_num as number | undefined,
        });
        writeResult({
          success: result.success,
          phase: "compile",
          error: result.error?.message,
          previousState: result.previousState,
          newState: result.newState,
          artifacts: result.compileResult
            ? [result.compileResult.outputPath]
            : [],
        });
        process.exit(result.success ? 0 : 1);
        break;
      }

      case "review": {
        if (process.env.EDITOR_STUB_REVIEW !== "1") {
          writeResult({
            success: false,
            phase: "review",
            error: "Review agent adapter is not configured. Set EDITOR_STUB_REVIEW=1 for development stub, or configure a production review agent.",
          });
          process.exit(1);
        }
        const agent = new StubReviewAgent();
        const result = await runReview(resolvedDir, agent, {
          requireCompiledTimeline: options.require_compiled_timeline !== false,
          skipPreview: options.skip_preview === true,
        });
        writeResult({
          success: result.success,
          phase: "review",
          error: result.error?.message,
          previousState: result.previousState,
          newState: result.newState,
          artifacts: result.promoted ?? [],
        });
        process.exit(result.success ? 0 : 1);
        break;
      }

      case "render": {
        const result = await runRender(resolvedDir);
        writeResult({
          success: result.success,
          phase: "render",
          error: result.error?.message,
          artifacts: [],
        });
        process.exit(result.success ? 0 : 1);
        break;
      }

      default:
        writeResult({ success: false, error: `Unknown phase: ${phase}` });
        process.exit(1);
    }
  } catch (err) {
    writeResult({
      success: false,
      phase,
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
}

function writeResult(result: Record<string, unknown>): void {
  // Write to stdout as a single JSON line prefixed with a marker
  // so the parent process can parse it reliably
  process.stdout.write(`\n__RESULT__${JSON.stringify(result)}__END__\n`);
}

void main();
