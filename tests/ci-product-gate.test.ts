import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";

const requiredJobs = [
  "node-runtime",
  "schema-contract",
  "speech-led-contract",
  "event-recap-contract",
  "repo-hygiene",
  "editor-server",
  "agent-definitions",
  "macos-studio",
] as const;

const resultEnvironment = [
  "NODE_RUNTIME",
  "SCHEMA_CONTRACT",
  "SPEECH_LED_CONTRACT",
  "EVENT_RECAP_CONTRACT",
  "REPO_HYGIENE",
  "EDITOR_SERVER",
  "AGENT_DEFINITIONS",
  "MACOS_STUDIO",
] as const;

interface ProductGateStep {
  name?: string;
  env?: Record<string, string>;
  run?: string;
}

interface ProductGateJob {
  if?: string;
  needs?: string[];
  steps?: ProductGateStep[];
}

const workflowPath = path.resolve(".github/workflows/ci.yml");
const workflow = parseYaml(fs.readFileSync(workflowPath, "utf8")) as {
  jobs?: Record<string, ProductGateJob>;
};
const productGate = workflow.jobs?.["product-gate"];
const gateStep = productGate?.steps?.find((step) => step.name === "Require every product boundary");

function runProductGate(overrides: Partial<Record<(typeof resultEnvironment)[number], string>> = {}) {
  if (!gateStep?.run) throw new Error("CI product-gate script is missing");

  const env = { ...process.env } as Record<string, string>;
  for (const key of resultEnvironment) env[key] = overrides[key] ?? "success";
  return spawnSync("bash", ["-c", gateStep.run], { env, encoding: "utf8" });
}

describe("CI product gate contract", () => {
  it("depends on every maintained product boundary and runs even after failures", () => {
    expect(productGate?.if).toBe("${{ always() }}");
    expect(productGate?.needs).toEqual(requiredJobs);
    expect(Object.keys(gateStep?.env ?? {})).toEqual(resultEnvironment);
  });

  it("passes only when every required boundary succeeds", () => {
    const result = runProductGate();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Product gate passed");
  });

  for (const nonSuccess of ["failure", "cancelled", "skipped"] as const) {
    it(`blocks every boundary when its result is ${nonSuccess}`, () => {
      for (const key of resultEnvironment) {
        const result = runProductGate({ [key]: nonSuccess });
        expect(result.status, `${key}=${nonSuccess}`).toBe(1);
        expect(result.stdout, `${key}=${nonSuccess}`).toContain("Product gate blocked");
      }
    });
  }
});
