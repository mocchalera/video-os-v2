import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

type EventName = "pull_request" | "push" | "workflow_dispatch";

interface TriggerConfig {
  branches?: string[];
  paths?: string[];
}

interface WorkflowStep {
  name?: string;
  run?: string;
}

interface WorkflowJob {
  "runs-on"?: string;
  if?: string;
  needs?: string[];
  steps?: WorkflowStep[];
}

interface Workflow {
  on?: Partial<Record<EventName, TriggerConfig | null>>;
  concurrency?: {
    group?: string;
    "cancel-in-progress"?: boolean;
  };
  jobs?: Record<string, WorkflowJob>;
}

interface EventCase {
  name: string;
  event: EventName;
  workflowTarget?: "full" | "studio";
  branch?: string;
  changedPaths?: string[];
  expectedWorkflows: string[];
}

const workflowRoot = path.resolve(".github/workflows");

function readWorkflow(fileName: string): Workflow {
  return parseYaml(fs.readFileSync(path.join(workflowRoot, fileName), "utf8")) as Workflow;
}

const workflows = {
  fast: readWorkflow("ci.yml"),
  full: readWorkflow("full-integration.yml"),
  studio: readWorkflow("macos-studio.yml"),
  speechLedRealMedia: readWorkflow("speech-led-real-media.yml"),
};

const studioPaths = [
  "Package.swift",
  "Package.resolved",
  "apps/macos-studio/**",
  ".github/workflows/macos-studio.yml",
];

function matchesPath(pattern: string, candidate: string): boolean {
  if (pattern.endsWith("/**")) return candidate.startsWith(pattern.slice(0, -2));
  return pattern === candidate;
}

function branchMatches(pattern: string, branch: string): boolean {
  if (pattern.endsWith("/**")) return branch.startsWith(pattern.slice(0, -2));
  return pattern === branch;
}

function workflowRunsFor(workflow: Workflow, workflowName: string, event: EventCase): boolean {
  const trigger = workflow.on?.[event.event];
  if (trigger === undefined) return false;
  if (event.event === "workflow_dispatch") {
    return event.workflowTarget === undefined || event.workflowTarget === workflowName;
  }

  const config = trigger ?? {};
  if (event.event === "push" && config.branches &&
    (!event.branch || !config.branches.some((pattern) => branchMatches(pattern, event.branch!)))) {
    return false;
  }
  if (config.paths &&
    (!event.changedPaths || !event.changedPaths.some((candidate) =>
      config.paths!.some((pattern) => matchesPath(pattern, candidate))))) {
    return false;
  }
  return true;
}

function runText(job: WorkflowJob | undefined): string {
  return (job?.steps ?? []).map((step) => step.run ?? "").join("\n");
}

function assertConcurrencyContract(workflow: Workflow, name: string): void {
  expect(workflow.concurrency?.["cancel-in-progress"], name).toBe(true);
  expect(workflow.concurrency?.group, name).toContain(
    "github.event.pull_request.number || github.ref",
  );
}

function runFullProductGate(eventName: string, fullResult: string, studioResult: string) {
  const gate = workflows.full.jobs?.["full-product-gate"]?.steps?.find(
    (step) => step.name === "Require full integration boundaries",
  );
  if (!gate?.run) throw new Error("full product-gate script is missing");
  return spawnSync("bash", ["-c", gate.run], {
    env: {
      ...process.env,
      EVENT_NAME: eventName,
      FULL_INTEGRATION_RESULT: fullResult,
      MACOS_STUDIO_RESULT: studioResult,
    },
    encoding: "utf8",
  });
}

describe("GitHub Actions workflow modes", () => {
  it("keeps ordinary PRs on one fast Ubuntu product gate", () => {
    expect(Object.keys(workflows.fast.jobs ?? {})).toEqual(["product-gate"]);
    expect(Object.keys(workflows.fast.on ?? {})).toEqual(["pull_request"]);
    expect(workflows.fast.jobs?.["product-gate"]?.["runs-on"]).toBe("ubuntu-24.04");

    const fastJob = workflows.fast.jobs?.["product-gate"];
    expect(fastJob?.steps?.filter((step) => step.run === "npm ci")).toHaveLength(1);
    expect(runText(fastJob)).not.toContain("--shard");
    expect(runText(fastJob)).not.toContain("test:render-integration");
    expect(runText(fastJob)).not.toContain("swift test");
  });

  it("uses the protected-push/manual full workflow without a paid schedule", () => {
    const trigger = workflows.full.on ?? {};
    expect(Object.keys(trigger)).toEqual(["push", "workflow_dispatch"]);
    expect(trigger.push?.branches).toEqual(["main", "Dev", "public-candidate/**"]);
    expect(trigger).not.toHaveProperty("schedule");

    const fullJob = workflows.full.jobs?.["full-integration"];
    const fullRunText = runText(fullJob);
    expect(fullJob?.steps?.filter((step) => step.run === "npm ci")).toHaveLength(1);
    expect(fullRunText.match(/npm test --/g)).toHaveLength(2);
    expect(fullRunText).toContain("--shard=1/2");
    expect(fullRunText).toContain("--shard=2/2");
    expect(fullRunText).toContain("npm run test:render-integration");
    expect(fullRunText).not.toContain("npm run test:schema-contract");
    expect(fullRunText).not.toContain("npm run test:speech-led-contract");
    expect(fullRunText).not.toContain("npm run test:event-recap-contract");
  });

  it("uses native Studio path filters and no third-party filter action", () => {
    const trigger = workflows.studio.on ?? {};
    expect(Object.keys(trigger)).toEqual(["pull_request", "push", "workflow_dispatch"]);
    expect(trigger.pull_request?.paths).toEqual(studioPaths);
    expect(trigger.push?.branches).toEqual(["main", "Dev", "public-candidate/**"]);
    expect(trigger.push?.paths).toEqual(studioPaths);
    expect(JSON.stringify(workflows.studio)).not.toContain("paths-filter");
    expect(JSON.stringify(workflows.studio)).not.toContain("dorny/");
  });

  it("cancels superseded runs for every repository workflow", () => {
    for (const [name, workflow] of Object.entries(workflows)) {
      assertConcurrencyContract(workflow, name);
    }
  });

  it("rejects the legacy static/false speech-led concurrency form", () => {
    const legacySpeechLedWorkflow: Workflow = {
      ...workflows.speechLedRealMedia,
      concurrency: {
        group: "speech-led-real-media",
        "cancel-in-progress": false,
      },
    };

    expect(() => assertConcurrencyContract(legacySpeechLedWorkflow, "legacy speech-led")).toThrow();
  });

  it.each<EventCase>([
    {
      name: "docs PR",
      event: "pull_request",
      changedPaths: ["README.md"],
      expectedWorkflows: ["fast"],
    },
    {
      name: "runtime PR",
      event: "pull_request",
      changedPaths: ["runtime/compiler/index.ts"],
      expectedWorkflows: ["fast"],
    },
    {
      name: "Studio source PR",
      event: "pull_request",
      changedPaths: ["apps/macos-studio/Sources/VideoOSStudioCore/TimelineDocument.swift"],
      expectedWorkflows: ["fast", "studio"],
    },
    {
      name: "Dev docs push",
      event: "push",
      branch: "Dev",
      changedPaths: ["docs/ci-workflow-modes.md"],
      expectedWorkflows: ["full"],
    },
    {
      name: "main Package.swift push",
      event: "push",
      branch: "main",
      changedPaths: ["Package.swift"],
      expectedWorkflows: ["full", "studio"],
    },
    {
      name: "public candidate Studio push",
      event: "push",
      branch: "public-candidate/abc123",
      changedPaths: ["apps/macos-studio/Tests/VideoOSStudioCoreTests/HookLockTests.swift"],
      expectedWorkflows: ["full", "studio"],
    },
    {
      name: "manual full integration",
      event: "workflow_dispatch",
      workflowTarget: "full",
      expectedWorkflows: ["full"],
    },
    {
      name: "manual Studio-only check",
      event: "workflow_dispatch",
      workflowTarget: "studio",
      expectedWorkflows: ["studio"],
    },
  ])("matches the approved trigger truth table: $name", (event) => {
    const active = Object.entries(workflows)
      .filter(([name, workflow]) => workflowRunsFor(workflow, name, event))
      .map(([name]) => name);
    expect(active).toEqual(event.expectedWorkflows);
  });

  it("makes manual dispatch require Studio while push accepts the intentional skip", () => {
    const gate = workflows.full.jobs?.["full-product-gate"];
    expect(gate?.if).toBe("${{ always() }}");
    expect(gate?.needs).toEqual(["full-integration", "macos-studio"]);

    const cases: Array<[string, string, string, boolean]> = [
      ["push", "success", "skipped", true],
      ["push", "success", "success", false],
      ["push", "success", "failure", false],
      ["workflow_dispatch", "success", "success", true],
      ["workflow_dispatch", "success", "skipped", false],
      ["workflow_dispatch", "failure", "success", false],
      ["unexpected", "success", "skipped", false],
    ];
    for (const [eventName, fullResult, studioResult, expectedSuccess] of cases) {
      const result = runFullProductGate(eventName, fullResult, studioResult);
      expect(result.status, `${eventName} full=${fullResult} studio=${studioResult}`)
        .toBe(expectedSuccess ? 0 : 1);
    }
  });

  it("runs the macOS job in the full workflow only for manual dispatch", () => {
    const manualStudio = workflows.full.jobs?.["macos-studio"];
    expect(manualStudio?.if).toBe("${{ github.event_name == 'workflow_dispatch' }}");
    expect(runText(manualStudio)).toContain("swift build --target VideoOSStudio");
    expect(runText(manualStudio)).toContain("swift test");
    expect(runText(manualStudio)).toContain("swift run videoos-studio-cli doctor");
  });
});
