import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";

interface WorkflowStep {
  name?: string;
  run?: string;
}

interface WorkflowJob {
  name?: string;
  "runs-on"?: string;
  if?: string;
  needs?: string[];
  steps?: WorkflowStep[];
}

const workflow = parseYaml(
  fs.readFileSync(path.resolve(".github/workflows/ci.yml"), "utf8"),
) as { jobs?: Record<string, WorkflowJob> };
const productGate = workflow.jobs?.["product-gate"];
const steps = productGate?.steps ?? [];

describe("PR fast product gate contract", () => {
  it("is a single direct required-check candidate with no skipped dependencies", () => {
    expect(Object.keys(workflow.jobs ?? {})).toEqual(["product-gate"]);
    expect(productGate?.if).toBeUndefined();
    expect(productGate?.needs).toBeUndefined();
    expect(productGate?.name).toBe("PR fast product gate");
    expect(productGate?.["runs-on"]).toBe("ubuntu-24.04");
  });

  it("uses one root install and keeps full-suite/render work out of PRs", () => {
    expect(steps.filter((step) => step.run === "npm ci")).toHaveLength(1);

    const runText = steps.map((step) => step.run ?? "").join("\n");
    expect(runText).toContain("npm run validate");
    expect(runText).toContain("npm run verify:skill-contracts");
    expect(runText).toContain("npm run test:schema-contract");
    expect(runText).toContain("npm run test:speech-led-contract");
    expect(runText).toContain("npm run test:event-recap-contract");
    expect(runText).toContain("npm run verify:studio-contracts");
    expect(runText).toContain("npm run verify:repo");
    expect(runText).toContain("npm run verify:agents");
    expect(runText).toContain("npm run build");
    expect(runText).not.toContain("--shard");
    expect(runText).not.toContain("test:render-integration");
    expect(runText).not.toContain("npm --prefix editor ci");
    expect(runText).not.toContain("swift test");
  });
});
