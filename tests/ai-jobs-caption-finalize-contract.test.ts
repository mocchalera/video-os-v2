import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  AI_JOB_PHASES,
  sanitizeAiJobOptions,
} from "../editor/shared/ai-job-contract.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("AI job caption-finalize route contract", () => {
  it("accepts the explicit phase and keeps only its typed options", () => {
    expect(AI_JOB_PHASES).toContain("caption-finalize");
    expect(sanitizeAiJobOptions("caption-finalize", {
      approval_path: "/tmp/approval.json",
      supplied_final_path: "/tmp/final.mp4",
      supplied_final_receipt_path: "/tmp/receipt.json",
      assembly_path: "/tmp/assembly.mp4",
      skip_render: true,
      created_at: "2026-07-23T00:00:00Z",
      render: true,
      untrusted_extra: "drop-me",
    })).toEqual({
      ok: true,
      options: {
        approval_path: "/tmp/approval.json",
        supplied_final_path: "/tmp/final.mp4",
        supplied_final_receipt_path: "/tmp/receipt.json",
        assembly_path: "/tmp/assembly.mp4",
        skip_render: true,
        created_at: "2026-07-23T00:00:00Z",
      },
    });
  });

  it("rejects malformed phase-owned options and isolates render options", () => {
    expect(sanitizeAiJobOptions("caption-finalize", { skip_render: "yes" }))
      .toEqual({ ok: false, error: "options.skip_render must be boolean" });
    expect(sanitizeAiJobOptions("caption-finalize", { created_at: "not-a-date" }))
      .toEqual({ ok: false, error: "options.created_at must be an ISO date-time" });
    expect(sanitizeAiJobOptions("render", {
      skip_render: false,
      approval_path: "/must/not/reach/render",
    })).toEqual({ ok: true, options: { skip_render: false } });
  });
});

describe("editor job worker phase contract", () => {
  it("keeps render behavior independent when caption approval exists", () => {
    const projectDir = createWorkerFixture();

    const render = runWorker(projectDir, "render");
    expect(render.status).toBe(1);
    expect(render.result).toMatchObject({ phase: "render", success: false });
    expect(render.result.error).toMatch(/requires state.*intent_pending/);
    expect(render.result.error).not.toContain("timeline not found");
  });

  it("routes caption-finalize independently when caption approval exists", () => {
    const projectDir = createWorkerFixture();
    const finalize = runWorker(projectDir, "caption-finalize");
    expect(finalize.status).toBe(1);
    expect(finalize.result).toMatchObject({ phase: "caption-finalize", success: false });
    expect(finalize.result.error).toContain("timeline not found");
  });
});

function createWorkerFixture(): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "caption-finalize-worker-"));
  tempDirs.push(projectDir);
  const approvalPath = path.join(projectDir, "07_package", "caption_approval.json");
  fs.mkdirSync(path.dirname(approvalPath), { recursive: true });
  fs.writeFileSync(approvalPath, "{}\n", "utf8");
  return projectDir;
}

function runWorker(
  projectDir: string,
  phase: "render" | "caption-finalize",
): { status: number | null; result: Record<string, unknown> } {
  const tsxCli = path.resolve("node_modules", "tsx", "dist", "cli.mjs");
  const worker = path.resolve("scripts", "editor-job-worker.ts");
  const child = spawnSync(process.execPath, [tsxCli, worker, projectDir, phase, "{}"], {
    cwd: path.resolve("."),
    encoding: "utf8",
    timeout: 20_000,
  });
  const match = child.stdout.match(/__RESULT__(.+?)__END__/);
  if (!match) {
    throw new Error(`worker result missing: status=${child.status} stdout=${child.stdout} stderr=${child.stderr}`);
  }
  return { status: child.status, result: JSON.parse(match[1]) as Record<string, unknown> };
}
