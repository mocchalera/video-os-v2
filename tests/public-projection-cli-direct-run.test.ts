import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("public projection release CLI direct-run detection", () => {
  it.each([
    ["generate-public-projection.ts", /--no-receipt is required/i],
    ["finalize-public-projection-receipt.ts", /Missing required argument: --source/i],
    ["verify-public-projection.ts", /Missing required argument: --source/i],
    ["verify-promotion-envelope.ts", /Missing required argument: --stage-a/i],
    ["public-promotion.ts", /never pushes/i],
    ["run-public-projection-secret-scan.ts", /Missing required argument: --staging/i],
    ["collect-public-ci-evidence.ts", /Missing required argument: --public-repository/i],
    ["prepare-public-promotion-approval.ts", /Usage: prepare-public-promotion-approval/i],
    ["record-public-promotion-approval.ts", /Missing required argument: --request/i],
    ["prepare-signed-public-promotion-approval.ts", /Missing required argument: --request/i],
    ["record-signed-public-promotion-approval.ts", /Missing required argument: --request/i],
  ])("fails closed through a symlinked repository path containing spaces: %s", (
    scriptName,
    expectedError,
  ) => {
    const repoRoot = path.resolve(".");
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "public projection cli with spaces-"));
    tempDirs.push(tempRoot);
    const repoAlias = path.join(tempRoot, "repository alias with spaces");
    fs.symlinkSync(repoRoot, repoAlias, "dir");
    const scriptPath = path.join(repoAlias, "scripts", scriptName);
    const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");

    const result = spawnSync(process.execPath, [tsxCli, scriptPath], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status, result.stderr || result.stdout).toBe(1);
    expect(result.stderr).toMatch(expectedError);
  });

  it.each([
    "generate-public-projection.ts",
    "finalize-public-projection-receipt.ts",
    "verify-public-projection.ts",
    "verify-promotion-envelope.ts",
    "public-promotion.ts",
    "run-public-projection-secret-scan.ts",
    "collect-public-ci-evidence.ts",
    "prepare-public-promotion-approval.ts",
    "record-public-promotion-approval.ts",
    "prepare-signed-public-promotion-approval.ts",
    "record-signed-public-promotion-approval.ts",
  ])("can be imported when the host entrypoint is not resolvable: %s", (scriptName) => {
    const repoRoot = path.resolve(".");
    const scriptUrl = pathToFileURL(path.join(repoRoot, "scripts", scriptName)).href;
    const tsxImport = path.join(repoRoot, "node_modules", "tsx", "dist", "loader.mjs");
    const result = spawnSync(process.execPath, [
      "--import",
      tsxImport,
      "--input-type=module",
      "--eval",
      `process.argv[1]="/missing/host-entrypoint"; await import(${JSON.stringify(scriptUrl)});`,
    ], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stderr).toBe("");
  });
});
