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
  "timeout-minutes"?: number;
  steps?: WorkflowStep[];
}

const packageJson = JSON.parse(
  fs.readFileSync(path.resolve("package.json"), "utf8"),
) as { scripts?: Record<string, string> };
const workflow = parseYaml(
  fs.readFileSync(path.resolve(".github/workflows/full-integration.yml"), "utf8"),
) as { jobs?: Record<string, WorkflowJob> };

describe("render integration CI contract", () => {
  it("excludes integration tests from the default Vitest suite", () => {
    const defaultConfig = fs.readFileSync(path.resolve("vitest.config.ts"), "utf8");

    expect(defaultConfig).toContain('"tests/integration/**"');
  });

  it("runs exactly one real-render test with the integration timeout", () => {
    const integrationConfig = fs.readFileSync(
      path.resolve("vitest.integration.config.ts"),
      "utf8",
    );

    expect(integrationConfig).toContain(
      'include: ["tests/integration/final-render-review-pack.real.test.ts"]',
    );
    expect(integrationConfig).toContain("testTimeout: 120_000");
    expect(integrationConfig.match(/tests\/integration\/[^"]+\.test\.ts/g))
      .toEqual(["tests/integration/final-render-review-pack.real.test.ts"]);
    expect(packageJson.scripts?.["test:render-integration"])
      .toBe("vitest run --config vitest.integration.config.ts");
  });

  it("runs the real-render script in a bounded pinned CI job", () => {
    const renderJob = workflow.jobs?.["full-integration"];
    const setupNode = renderJob?.steps?.find(
      (step) => step.uses === "actions/setup-node@v4",
    );
    const renderSteps = renderJob?.steps?.filter(
      (step) => step.run?.includes("test:render-integration"),
    );

    expect(renderJob?.["runs-on"]).toBe("ubuntu-24.04");
    expect(renderJob?.["timeout-minutes"]).toBe(60);
    expect(setupNode?.with?.["node-version-file"]).toBe(".node-version");
    const mediaStep = renderJob?.steps?.find(
      (step) => step.name === "Resolve pinned media toolchain",
    );
    const npmCiIndex = renderJob?.steps?.findIndex((step) => step.run === "npm ci") ?? -1;
    const resolveIndex = renderJob?.steps?.findIndex(
      (step) => step.name === "Resolve pinned media toolchain",
    ) ?? -1;
    expect(mediaStep?.run).toBe("bash scripts/ci-resolve-media-toolchain.sh");
    expect(resolveIndex).toBeGreaterThan(npmCiIndex);
    expect(JSON.stringify(renderJob)).not.toContain("apt-get");
    expect(JSON.stringify(renderJob)).not.toContain("Using preinstalled ffmpeg/ffprobe");
    const resolver = fs.readFileSync(path.resolve("scripts/ci-resolve-media-toolchain.sh"), "utf8");
    const brokerSource = fs.readFileSync(
      path.resolve("runtime/handoff/premiere-preflight-process-broker.ts"),
      "utf8",
    );
    const defaultPath = brokerSource.match(/const DEFAULT_PATH = "([^"]+)"/)?.[1];
    expect(defaultPath).toBe("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
    expect(resolver).toContain(`BROKER_SEARCH_PATH='${defaultPath}'`);
    expect(resolver).toContain("BROKER_INSTALL_DIR='/usr/local/bin'");
    expect(resolver).toContain('sudo rm -f "${dest}"');
    expect(resolver).toContain('installed ${dest} digest ${dest_sha} != verified tarball bytes ${src_sha}');
    expect(resolver).toContain('PATH="${BROKER_SEARCH_PATH}" /usr/bin/which');
    expect(renderSteps).toEqual([
      expect.objectContaining({
        name: "Run real render integration test",
        run: "npm run test:render-integration",
      }),
    ]);
  });
});
