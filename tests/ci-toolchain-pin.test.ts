import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

interface WorkflowStep {
  name?: string;
  uses?: string;
  with?: Record<string, unknown>;
  run?: string;
}

interface WorkflowJob {
  "runs-on"?: string;
  env?: Record<string, string>;
  needs?: string[];
  steps?: WorkflowStep[];
}

const workflow = parseYaml(
  fs.readFileSync(path.resolve(".github/workflows/ci.yml"), "utf8"),
) as { jobs?: Record<string, WorkflowJob> };
const packageJson = JSON.parse(
  fs.readFileSync(path.resolve("package.json"), "utf8"),
) as { packageManager?: string; scripts?: Record<string, string> };
const vitestConfig = fs.readFileSync(path.resolve("vitest.config.ts"), "utf8");
const verifySource = fs.readFileSync(path.resolve("scripts/verify.ts"), "utf8");
const pclConfig = parseYaml(fs.readFileSync(path.resolve("pcl.yaml"), "utf8")) as {
  permissions?: { agent_may_modify?: string[] };
};

const approvedSharedPaths = [
  ".github/",
  "Package.swift",
  "package.json",
  ".nvmrc",
  ".node-version",
  "vitest.config.ts",
  "vitest.integration.config.ts",
] as const;

describe("CI toolchain pin contract", () => {
  it("pins the local Node and npm selectors to exact versions", () => {
    expect(fs.readFileSync(path.resolve(".nvmrc"), "utf8").trim()).toBe("22.23.1");
    expect(fs.readFileSync(path.resolve(".node-version"), "utf8").trim()).toBe("22.23.1");
    expect(packageJson.packageManager).toBe("npm@10.9.8");
  });

  it("records the exact approved shared-file permission entries", () => {
    expect(pclConfig.permissions?.agent_may_modify).toEqual(
      expect.arrayContaining([...approvedSharedPaths]),
    );
  });

  it("pins every Linux job and every setup-node invocation", () => {
    const jobs = Object.entries(workflow.jobs ?? {});
    const setupNodeJobs = jobs.filter(([, job]) =>
      job.steps?.some((step) => step.uses === "actions/setup-node@v4")
    );

    for (const [jobName, job] of jobs.filter(([, job]) =>
      job["runs-on"]?.startsWith("ubuntu-")
    )) {
      expect(job["runs-on"], jobName).toBe("ubuntu-24.04");
    }
    expect(setupNodeJobs.length).toBeGreaterThan(0);

    for (const [jobName, job] of setupNodeJobs) {
      const setupNode = job.steps?.find((step) => step.uses === "actions/setup-node@v4");
      expect(setupNode?.with?.["node-version-file"], jobName).toBe(".node-version");
      expect(setupNode?.with?.["node-version"], jobName).toBeUndefined();

      const assertion = job.steps?.find((step) => step.name === "Assert Node and npm versions");
      expect(assertion?.run, jobName).toContain('test "$(node -v)" = "v22.23.1"');
      expect(assertion?.run, jobName).toContain('test "$(npm -v)" = "10.9.8"');
    }
  });

  it("applies the hash-guarded upstream Vitest worker RPC fix", () => {
    const patchStep = workflow.jobs?.["node-runtime"]?.steps?.find(
      (step) => step.name === "Backport Vitest worker RPC fix",
    );
    expect(patchStep?.run).toContain('vitestPackage.version !== "3.2.4"');
    expect(patchStep?.run).toContain(
      "de377d3f6766cc38394adf8886e92fa2d3aabf442f1313ed612f308c625ba8b4",
    );
    expect(patchStep?.run).toContain('source.replace(legacyTimeoutBlock, "\\t\\ttimeout: -1,")');
    expect(patchStep?.run).toContain(
      "9a3679f30dc623ddebdd2d2effb5bb537f849358b42d4009466f38a718bb6af0",
    );
  });

  it("bounds the required CI unit lane across two complete shards", () => {
    const unitStep = workflow.jobs?.["node-runtime"]?.steps?.find(
      (step) => step.name === "Run tests",
    );
    expect(packageJson.scripts?.test).toBe("vitest run --maxWorkers=4");
    expect(unitStep?.run?.match(/npm test --/g)).toHaveLength(2);
    expect(unitStep?.run?.match(/--shard(?:=|\s+)\d+\/\d+/g)).toEqual([
      "--shard=1/2",
      "--shard=2/2",
    ]);
    expect(unitStep?.run?.match(/--silent(?:=|\s+)\S+/g)).toEqual([
      "--silent=passed-only",
      "--silent=passed-only",
    ]);
    expect(unitStep?.run?.match(/--testTimeout(?:=|\s+)\d+/g)).toEqual([
      "--testTimeout=30000",
      "--testTimeout=30000",
    ]);
  });

  it("keeps split public-projection tests in default CI and full-verify discovery", () => {
    for (const testFile of [
      "tests/public-projection-stage-a-contract.test.ts",
      "tests/public-projection-stage-a-generation.test.ts",
      "tests/public-projection-stage-a-integrity.test.ts",
      "tests/public-projection-stage-b-approval-evidence.test.ts",
      "tests/public-projection-stage-b-git-ledger.test.ts",
      "tests/public-projection-stage-b-run-evidence.test.ts",
    ]) {
      expect(fs.existsSync(path.resolve(testFile)), testFile).toBe(true);
      expect(testFile).toMatch(/\.test\.ts$/);
    }
    expect(vitestConfig).not.toMatch(/\binclude\s*:/);
    expect(packageJson.scripts?.test).toBe("vitest run --maxWorkers=4");
    expect(verifySource).toContain('args: ["vitest", "run", "--maxWorkers=4"]');
  });

  it("fails closed unless macos-studio uses Xcode 15.4 and Apple Swift 5.10", () => {
    const macosStudio = workflow.jobs?.["macos-studio"];
    const assertion = macosStudio?.steps?.find(
      (step) => step.name === "Assert Xcode and Swift versions",
    );

    expect(fs.readFileSync(path.resolve("Package.swift"), "utf8"))
      .toMatch(/^\/\/ swift-tools-version: 5\.10/m);
    expect(macosStudio?.["runs-on"]).toBe("macos-14");
    expect(macosStudio?.env?.DEVELOPER_DIR)
      .toBe("/Applications/Xcode_15.4.app/Contents/Developer");
    expect(assertion?.run).toContain('test -d "${DEVELOPER_DIR}"');
    expect(assertion?.run).toContain("Xcode 15.4");
    expect(assertion?.run).toContain("Build version 15F31d");
    expect(assertion?.run).toContain("^Apple Swift version 5\\.10 ");
  });

  it("keeps Studio contract verification beneath product-gate", () => {
    const productGateNeeds = workflow.jobs?.["product-gate"]?.needs ?? [];
    const enforcingJobs = Object.entries(workflow.jobs ?? {})
      .filter(([, job]) =>
        job.steps?.some((step) => step.run === "npm run verify:studio-contracts")
      )
      .map(([jobName]) => jobName);

    expect(enforcingJobs).toHaveLength(1);
    expect(productGateNeeds).toEqual(expect.arrayContaining(enforcingJobs));
  });
});
