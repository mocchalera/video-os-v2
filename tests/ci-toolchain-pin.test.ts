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

interface Workflow {
  jobs?: Record<string, WorkflowJob>;
}

function readWorkflow(relativePath: string): Workflow {
  return parseYaml(fs.readFileSync(path.resolve(relativePath), "utf8")) as Workflow;
}

const fastWorkflow = readWorkflow(".github/workflows/ci.yml");
const fullWorkflow = readWorkflow(".github/workflows/full-integration.yml");
const studioWorkflow = readWorkflow(".github/workflows/macos-studio.yml");
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
    const workflowEntries: Array<[string, Workflow]> = [
      ["fast", fastWorkflow],
      ["full", fullWorkflow],
    ];
    const jobs = workflowEntries.flatMap(([workflowName, workflow]) =>
      Object.entries(workflow.jobs ?? {}).map(([jobName, job]) => [
        `${workflowName}:${jobName}`,
        job,
      ] as const),
    );
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

  it("applies the hash-guarded upstream Vitest worker RPC fix in full integration", () => {
    const patchStep = fullWorkflow.jobs?.["full-integration"]?.steps?.find(
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

  it("bounds the full Node unit lane across two complete shards", () => {
    const unitStep = fullWorkflow.jobs?.["full-integration"]?.steps?.find(
      (step) => step.name === "Run full Node test suite",
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

    const editorServerSpawnTests = [
      "tests/editor-server-hook-lock.test.ts",
      "tests/editor-server-project-health-redaction.test.ts",
      "tests/editor-server-source-map-route-redaction.test.ts",
    ];
    const expectedExcludes = editorServerSpawnTests.map(
      (testFile) => `--exclude ${testFile}`,
    );
    expect(unitStep?.run?.match(/--exclude \S+/g)).toEqual([
      ...expectedExcludes,
      ...expectedExcludes,
    ]);

    for (const testFile of editorServerSpawnTests) {
      expect(fs.existsSync(path.resolve(testFile)), testFile).toBe(true);
    }
    expect(packageJson.scripts?.["test:editor-server-integration"]).toBe(
      `vitest run ${editorServerSpawnTests.join(" ")}`,
    );
    const integrationStep = fullWorkflow.jobs?.["full-integration"]?.steps?.find(
      (step) => step.name === "Run editor-server integration tests",
    );
    expect(integrationStep?.run).toBe("npm run test:editor-server-integration");
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
    const macosStudio = fullWorkflow.jobs?.["macos-studio"];
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

    const filteredStudio = studioWorkflow.jobs?.["studio-product-gate"];
    expect(filteredStudio?.["runs-on"]).toBe("macos-14");
    expect(filteredStudio?.env?.DEVELOPER_DIR)
      .toBe("/Applications/Xcode_15.4.app/Contents/Developer");
  });

  it("pins the fail-closed ffmpeg/ffprobe source in the consolidated full job", () => {
    const resolverPath = path.resolve("scripts/ci-resolve-media-toolchain.sh");
    const resolver = fs.readFileSync(resolverPath, "utf8");
    const lockfile = JSON.parse(
      fs.readFileSync(path.resolve("package-lock.json"), "utf8"),
    ) as {
      packages?: Record<string, { version?: string; integrity?: string }>;
    };
    const compositor = lockfile.packages?.["node_modules/@remotion/compositor-linux-x64-gnu"];
    const job = fullWorkflow.jobs?.["full-integration"];
    const npmCiIndex = job?.steps?.findIndex((step) => step.run === "npm ci") ?? -1;
    const resolveIndex = job?.steps?.findIndex(
      (step) => step.name === "Resolve pinned media toolchain",
    ) ?? -1;
    const step = job?.steps?.[resolveIndex];

    expect(step?.run).toBe("bash scripts/ci-resolve-media-toolchain.sh");
    expect(npmCiIndex).toBeGreaterThanOrEqual(0);
    expect(resolveIndex).toBeGreaterThan(npmCiIndex);
    expect(JSON.stringify(job)).not.toContain("apt-get");
    expect(JSON.stringify(job)).not.toContain("Using preinstalled ffmpeg/ffprobe");
    expect(compositor?.version).toBe("4.0.452");
    expect(compositor?.integrity).toBe(
      "sha512-W/obco3o/vqdqtbXlAm3m6m9ZjA9LGGeJkEjT3+6ar2jkOSLi2S6qIhz9Y/ewi5cN2hKaFV1rlEwVGNqfEia+w==",
    );
    expect(resolver).toContain("PINNED_COMPOSITOR_VERSION='4.0.452'");
    expect(resolver).toContain(
      "PINNED_COMPOSITOR_INTEGRITY='sha512-W/obco3o/vqdqtbXlAm3m6m9ZjA9LGGeJkEjT3+6ar2jkOSLi2S6qIhz9Y/ewi5cN2hKaFV1rlEwVGNqfEia+w=='",
    );
    expect(resolver).toContain(
      "PINNED_COMPOSITOR_PATH='node_modules/@remotion/compositor-linux-x64-gnu'",
    );
    expect(resolver).toContain("PINNED_FFMPEG_VERSION='6.0.1'");
    expect(resolver).toContain(
      "PINNED_FFMPEG_URL='https://johnvansickle.com/ffmpeg/old-releases/ffmpeg-6.0.1-amd64-static.tar.xz'",
    );
    expect(resolver).toContain(
      "PINNED_FFMPEG_SHA256='28268bf402f1083833ea269331587f60a242848880073be8016501d864bd07a5'",
    );
    expect(resolver).toContain(
      'expected_banner="$(basename "${dest}") version ${PINNED_FFMPEG_VERSION}-static "',
    );
    const brokerSource = fs.readFileSync(
      path.resolve("runtime/handoff/premiere-preflight-process-broker.ts"),
      "utf8",
    );
    const defaultPath = brokerSource.match(/const DEFAULT_PATH = "([^"]+)"/)?.[1];
    expect(defaultPath).toBe("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
    expect(defaultPath?.split(":")).toContain("/usr/local/bin");
    expect(resolver).toContain(`BROKER_SEARCH_PATH='${defaultPath}'`);
    expect(resolver).toContain("BROKER_INSTALL_DIR='/usr/local/bin'");
    expect(resolver).toContain('sudo rm -f "${dest}"');
    expect(resolver).toContain('sudo cp "${src}" "${dest}"');
    expect(resolver).toContain('installed ${dest} digest ${dest_sha} != verified tarball bytes ${src_sha}');
    expect(resolver).toContain("broker which path discovered");
    expect(resolver).toContain('PATH="${BROKER_SEARCH_PATH}" /usr/bin/which');
    expect(resolver).toContain("fail_closed");
    expect(resolver).toContain("actual_sha256");
    expect(resolver).not.toContain("BtbN");
    expect(resolver).not.toContain("autobuild-");
    expect(resolver).not.toContain("n8.1.2");
    expect(resolver).not.toContain("apt-get");
    expect(resolver).not.toContain("Using preinstalled ffmpeg/ffprobe");
    expect(resolver).not.toMatch(/command -v ffmpeg && command -v ffprobe/);
  });

  it("keeps Studio contract verification in both product lanes", () => {
    const lanes: Array<[string, Workflow]> = [
      ["fast", fastWorkflow],
      ["full", fullWorkflow],
    ];
    const enforcement = lanes.flatMap(([workflowName, workflow]) =>
      Object.entries(workflow.jobs ?? {})
        .filter(([, job]) => job.steps?.some((step) => step.run === "npm run verify:studio-contracts"))
        .map(([jobName]) => `${workflowName}:${jobName}`),
    );

    expect(enforcement).toEqual(["fast:product-gate", "full:full-integration"]);
  });
});
