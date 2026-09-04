import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEGRADED_OUTPUT_WRITER_TOOL,
  DEGRADED_REPLACED_CAPABILITY,
  DEGRADED_REPLACED_COMMAND,
  type DegradedRouteReceipt,
} from "../runtime/artifacts/project-writer-guard.js";
import { runProjectOutputWriter } from "../scripts/project-output-writer.js";

const temporaryDirectories: string[] = [];
const NOW = "2026-08-24T09:00:00.000Z";

function hash(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "degraded-writer-"));
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "degraded-writer-source-"));
  temporaryDirectories.push(projectDir, sourceDir);
  fs.mkdirSync(path.join(projectDir, "05_timeline"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, "06_review"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, "07_package"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "05_timeline/timeline.json"), "timeline\n");
  const projectID = path.basename(projectDir);
  const approval = {
    version: "1.0",
    project_id: projectID,
    base_timeline_version: "1",
    caption_policy: { language: "ja", delivery_mode: "burn_in", source: "authored", styling_class: "clean-lower-third" },
    speech_captions: [],
    text_overlays: [],
    approval: { status: "approved", approved_by: "human-editor", approved_at: "2026-08-24T08:50:00.000Z" },
  };
  const approvalPath = path.join(projectDir, "07_package/caption_approval.json");
  fs.writeFileSync(approvalPath, `${JSON.stringify(approval)}\n`);
  const sourcePath = path.join(sourceDir, "review-only.mp4");
  fs.writeFileSync(sourcePath, "preview\n");
  return {
    projectDir,
    sourcePath,
    outputPath: path.join(projectDir, "09_output/review-only.mp4"),
    receiptPath: path.join(projectDir, "06_review/degraded-route-receipt.json"),
    approvalPath,
  };
}

function receipt(f: ReturnType<typeof fixture>, overrides: Partial<DegradedRouteReceipt> = {}): DegradedRouteReceipt {
  return {
    version: "degraded-route-receipt/v1",
    project_id: path.basename(f.projectDir),
    replaced_canonical: { command: DEGRADED_REPLACED_COMMAND, capability: DEGRADED_REPLACED_CAPABILITY },
    reason: "canonical renderer is unavailable for the requested review-only treatment",
    input: { path: "05_timeline/timeline.json", sha256: hash("timeline\n") },
    output: { path: "09_output/review-only.mp4", sha256: hash("preview\n") },
    actor: { name: "human-editor", tool: DEGRADED_OUTPUT_WRITER_TOOL },
    created_at: "2026-08-24T08:55:00.000Z",
    scope: "review_only_degraded",
    production_approval: {
      status: "unchanged",
      path: "07_package/caption_approval.json",
      sha256: hash(fs.readFileSync(f.approvalPath)),
    },
    ...overrides,
  };
}

function argv(f: ReturnType<typeof fixture>): string[] {
  return ["node", "project-output-writer.ts", "--project", f.projectDir, "--source", f.sourcePath, "--output", f.outputPath, "--degraded-route-receipt", f.receiptPath];
}

describe("production degraded project-output writer", () => {
  it("rejects missing receipt before creating 09_output", () => {
    const f = fixture();
    expect(() => runProjectOutputWriter(argv(f), NOW)).toThrow(/receipt is required|ENOENT/i);
    expect(fs.existsSync(f.outputPath)).toBe(false);
  });

  it.each([
    ["unknown command", (base: DegradedRouteReceipt) => ({ ...base, replaced_canonical: { ...base.replaced_canonical, command: "not-a-canonical-command --unsafe" } })],
    ["unknown capability", (base: DegradedRouteReceipt) => ({ ...base, replaced_canonical: { ...base.replaced_canonical, capability: "invented-capability/v999" } })],
    ["unknown tool", (base: DegradedRouteReceipt) => ({ ...base, actor: { ...base.actor, tool: "unknown-tool/v999" } })],
    ["unknown actor", (base: DegradedRouteReceipt) => ({ ...base, actor: { ...base.actor, name: "unknown-actor" } })],
    ["old timestamp", (base: DegradedRouteReceipt) => ({ ...base, created_at: "2000-01-01T00:00:00.000Z" })],
    ["future timestamp", (base: DegradedRouteReceipt) => ({ ...base, created_at: "2026-08-24T10:00:00.000Z" })],
  ])("rejects forged %s metadata before writing", (_label, mutate) => {
    const f = fixture();
    fs.writeFileSync(f.receiptPath, JSON.stringify(mutate(receipt(f))));
    expect(() => runProjectOutputWriter(argv(f), NOW)).toThrow(/schema|registered|actor|timestamp/i);
    expect(fs.existsSync(f.outputPath)).toBe(false);
  });

  it("rejects stale input/output/approval hashes before writing", () => {
    for (const mutate of [
      (base: DegradedRouteReceipt) => ({ ...base, input: { ...base.input, sha256: hash("stale") } }),
      (base: DegradedRouteReceipt) => ({ ...base, output: { ...base.output, sha256: hash("stale") } }),
      (base: DegradedRouteReceipt) => ({ ...base, production_approval: { ...base.production_approval, sha256: hash("stale") } }),
    ]) {
      const f = fixture();
      fs.writeFileSync(f.receiptPath, JSON.stringify(mutate(receipt(f))));
      expect(() => runProjectOutputWriter(argv(f), NOW)).toThrow(/hash is stale/i);
      expect(fs.existsSync(f.outputPath)).toBe(false);
    }
  });

  it("rejects traversal and symlink output paths before writing", () => {
    const escaped = fixture();
    fs.writeFileSync(escaped.receiptPath, JSON.stringify(receipt(escaped)));
    const escapedArgv = argv(escaped);
    escapedArgv[escapedArgv.indexOf("--output") + 1] = path.join(escaped.projectDir, "../escaped.mp4");
    expect(() => runProjectOutputWriter(escapedArgv, NOW)).toThrow(/09_output|contained/i);

    const linked = fixture();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "degraded-writer-outside-"));
    temporaryDirectories.push(outside);
    fs.symlinkSync(outside, path.join(linked.projectDir, "09_output"), "dir");
    fs.writeFileSync(linked.receiptPath, JSON.stringify(receipt(linked)));
    expect(() => runProjectOutputWriter(argv(linked), NOW)).toThrow(/symlink/i);
    expect(fs.existsSync(path.join(outside, "review-only.mp4"))).toBe(false);
  });

  it("publishes only a review-only output and leaves production approval byte-identical", () => {
    const f = fixture();
    const approvalBefore = fs.readFileSync(f.approvalPath);
    fs.writeFileSync(f.receiptPath, JSON.stringify(receipt(f)));
    const result = runProjectOutputWriter(argv(f), NOW);
    expect(result.status).toBe("review_only_degraded");
    expect(fs.readFileSync(f.outputPath, "utf8")).toBe("preview\n");
    expect(fs.readFileSync(f.approvalPath)).toEqual(approvalBefore);
  });
});
