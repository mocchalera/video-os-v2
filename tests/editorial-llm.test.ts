import { describe, expect, it } from "vitest";
import {
  completeEditorialJson,
  decisionRuntimeRecord,
  parseCodexExecJsonl,
  type EditorialLlmExecutor,
  type EditorialLlmExecutorInput,
} from "../runtime/connectors/editorial-llm.js";

function codexJsonl(text: string): string {
  return `${JSON.stringify({ type: "agent_message", message: text })}\n`;
}

describe("editorial LLM connector", () => {
  it("selects codex_exec first in auto mode when codex is available", async () => {
    const calls: EditorialLlmExecutorInput[] = [];
    const executor: EditorialLlmExecutor = async (input) => {
      calls.push(input);
      return {
        stdout: codexJsonl(JSON.stringify({ ok: true })),
        stderr: "",
      };
    };

    const result = await completeEditorialJson({
      role: "test-role",
      prompt: "Return JSON.",
    }, {
      commandExists: (command) => command === "codex",
      executor,
      env: {},
    });

    expect(result.runtime).toBe("codex_exec");
    expect(result.parsed).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("codex");
    expect(calls[0].args).toEqual(expect.arrayContaining(["exec", "-s", "read-only", "--json"]));
    expect(calls[0].input).toBe("Return JSON.");
  });

  it("attaches request images to codex exec via -i flags", async () => {
    const calls: EditorialLlmExecutorInput[] = [];
    const executor: EditorialLlmExecutor = async (input) => {
      calls.push(input);
      return {
        stdout: codexJsonl(JSON.stringify({ ok: true })),
        stderr: "",
      };
    };

    const result = await completeEditorialJson({
      role: "test-role",
      prompt: "Judge the attached filmstrips.",
      images: [
        { data: Buffer.from("fake-image").toString("base64"), mimeType: "image/jpeg" },
        { path: "/tmp/vos-fixture-keyframe.png", mimeType: "image/png" },
      ],
    }, {
      commandExists: (command) => command === "codex",
      executor,
      env: {},
    });

    expect(result.runtime).toBe("codex_exec");
    expect(calls).toHaveLength(1);
    const args = calls[0].args;
    const imageFlags = args.filter((value) => value === "-i");
    expect(imageFlags).toHaveLength(2);
    const inlinePath = args[args.indexOf("-i") + 1];
    expect(inlinePath.endsWith(".jpg")).toBe(true);
    expect(args).toContain("/tmp/vos-fixture-keyframe.png");
  });

  it("skips claude_cli for image requests and falls through to Gemini", async () => {
    const executorCommands: string[] = [];
    const executor: EditorialLlmExecutor = async (input) => {
      executorCommands.push(input.command);
      throw new Error("claude should not execute for image requests");
    };
    const geminiCalls: string[] = [];

    const result = await completeEditorialJson({
      role: "test-role",
      prompt: "Judge the attached filmstrips.",
      images: [{ data: Buffer.from("fake-image").toString("base64"), mimeType: "image/png" }],
    }, {
      commandExists: (command) => command === "claude",
      executor,
      geminiMultimodal: async (prompt) => {
        geminiCalls.push(prompt);
        return JSON.stringify({ ok: true });
      },
      env: { GEMINI_API_KEY: "test-key" },
    });

    expect(result.runtime).toBe("gemini");
    expect(result.parsed).toEqual({ ok: true });
    expect(executorCommands).toHaveLength(0);
    expect(geminiCalls).toHaveLength(1);
    expect(result.warnings.some((warning) => warning.includes("image"))).toBe(true);
  });

  it("retries the same runtime once with the JSON error before succeeding", async () => {
    const inputs: string[] = [];
    const executor: EditorialLlmExecutor = async (input) => {
      inputs.push(input.input ?? "");
      return {
        stdout: inputs.length === 1
          ? codexJsonl("not json")
          : codexJsonl(JSON.stringify({ repaired: true })),
        stderr: "",
      };
    };

    const result = await completeEditorialJson({
      role: "test-role",
      prompt: "Return JSON.",
    }, {
      runtime: "codex_exec",
      commandExists: (command) => command === "codex",
      executor,
      env: {},
    });

    expect(result.runtime).toBe("codex_exec");
    expect(result.parsed).toEqual({ repaired: true });
    expect(inputs).toHaveLength(2);
    expect(inputs[1]).toContain("Schema/parse error:");
    expect(result.warnings[0]).toContain("No JSON object found");
  });

  it("falls through codex and claude failures to Gemini", async () => {
    const executor: EditorialLlmExecutor = async (input) => {
      if (input.command === "codex") {
        return { stdout: codexJsonl("not json"), stderr: "" };
      }
      throw new Error("claude unavailable");
    };

    const result = await completeEditorialJson({
      role: "test-role",
      prompt: "Return JSON.",
    }, {
      commandExists: (command) => command === "codex" || command === "claude",
      executor,
      env: { GEMINI_API_KEY: "test-key" },
      geminiText: async () => JSON.stringify({ provider: "gemini" }),
    });

    expect(result.runtime).toBe("gemini");
    expect(result.parsed).toEqual({ provider: "gemini" });
    expect(result.attempts.map((attempt) => `${attempt.runtime}:${attempt.status}`)).toEqual([
      "codex_exec:failed",
      "claude_cli:failed",
      "gemini:success",
    ]);
    expect(result.warnings.some((warning) => warning.includes("codex_exec"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("claude_cli"))).toBe(true);
  });

  it("returns deterministic when no local CLI or Gemini key is available", async () => {
    const result = await completeEditorialJson({
      role: "test-role",
      prompt: "Return JSON.",
    }, {
      commandExists: () => false,
      env: {},
    });

    expect(result.runtime).toBe("deterministic");
    expect(result.parsed).toEqual({});
    expect(result.attempts).toEqual([{ runtime: "deterministic", status: "success" }]);
  });

  it("builds additive decision_runtime metadata", () => {
    const record = decisionRuntimeRecord({
      runtime: "gemini",
      warnings: ["codex_exec: bad json"],
      attempts: [
        { runtime: "codex_exec", status: "failed", message: "bad json" },
        { runtime: "gemini", status: "success" },
      ],
    }, "blueprint-llm");

    expect(record).toEqual({
      runtime: "gemini",
      role: "blueprint-llm",
      attempted_runtimes: [
        { runtime: "codex_exec", status: "failed", message: "bad json" },
        { runtime: "gemini", status: "success" },
      ],
      fallback_warnings: ["codex_exec: bad json"],
    });
  });

  it("extracts the last assistant message from codex JSONL stdout", () => {
    expect(parseCodexExecJsonl([
      JSON.stringify({ type: "session_started", id: "abc" }),
      JSON.stringify({ type: "agent_message", message: "first" }),
      JSON.stringify({ type: "agent_message", message: "{\"final\":true}" }),
    ].join("\n"))).toBe("{\"final\":true}");
  });
});
