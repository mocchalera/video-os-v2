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
  fs.readFileSync(path.resolve(".github/workflows/ci.yml"), "utf8"),
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
    const renderJob = workflow.jobs?.["render-integration"];
    const setupNode = renderJob?.steps?.find(
      (step) => step.uses === "actions/setup-node@v4",
    );
    const renderSteps = renderJob?.steps?.filter(
      (step) => step.run?.includes("test:render-integration"),
    );

    expect(renderJob?.["runs-on"]).toBe("ubuntu-24.04");
    expect(renderJob?.["timeout-minutes"]).toBe(10);
    expect(setupNode?.with?.["node-version-file"]).toBe(".node-version");
    expect(renderSteps).toEqual([
      expect.objectContaining({
        name: "Run real render integration test",
        run: "npm run test:render-integration",
      }),
    ]);
  });
});
