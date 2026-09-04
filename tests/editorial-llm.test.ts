import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  availableEditorialLlmRuntimes,
  classifyTransportError,
  completeEditorialJson,
  decisionRuntimeRecord,
  defaultExecutor,
  EditorialLlmError,
  parseCodexExecJsonl,
  nonLlmDecisionRuntime,
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

  it("bounds the built-in Gemini request by the shared stage deadline", async () => {
    const originalFetch = globalThis.fetch;
    const originalApiKey = process.env.GEMINI_API_KEY;
    let requestSignal: AbortSignal | undefined;
    process.env.GEMINI_API_KEY = "test-key";
    globalThis.fetch = (async (_input, init) => {
      requestSignal = init?.signal ?? undefined;
      return await new Promise<Response>(() => {});
    }) as typeof fetch;

    try {
      const startedAt = Date.now();
      const result = await completeEditorialJson({
        role: "triage-llm",
        prompt: "Return JSON.",
        timeoutMs: 60_000,
      }, {
        runtime: "gemini",
        commandExists: () => false,
        env: { GEMINI_API_KEY: "test-key" },
        stageTimeoutMs: 30,
      });

      expect(result.runtime).toBe("deterministic");
      expect(result.attempts).toEqual([
        {
          runtime: "gemini",
          status: "failed",
          message: "gemini: transport timeout",
          error_kind: "transport_timeout",
        },
        { runtime: "deterministic", status: "success" },
      ]);
      expect(Date.now() - startedAt).toBeLessThan(500);
      expect(requestSignal?.aborted).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalApiKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = originalApiKey;
    }
  }, 5_000);

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
      author: "llm",
      attempted_runtimes: [
        { runtime: "codex_exec", status: "failed", message: "bad json" },
        { runtime: "gemini", status: "success" },
      ],
      fallback_warnings: ["codex_exec: bad json"],
    });
  });

  it("marks deterministic completion records as deterministic fallback authorship", () => {
    const record = decisionRuntimeRecord({
      runtime: "deterministic",
      warnings: ["gemini: transport timeout"],
      attempts: [
        { runtime: "gemini", status: "failed", error_kind: "transport_timeout" },
        { runtime: "deterministic", status: "success" },
      ],
    }, "blueprint-llm");

    expect(record).toEqual({
      runtime: "deterministic",
      role: "blueprint-llm",
      author: "deterministic_fallback",
      attempted_runtimes: [
        { runtime: "gemini", status: "failed", error_kind: "transport_timeout" },
        { runtime: "deterministic", status: "success" },
      ],
      fallback_warnings: ["gemini: transport timeout"],
    });
  });

  it("marks non-LLM authored decisions with explicit provenance", () => {
    const human = nonLlmDecisionRuntime("triage", "human");
    expect(human.author).toBe("human");
    expect(human.runtime).toBe("human");

    const synthesized = nonLlmDecisionRuntime("triage", "agent_evidence_synthesis");
    expect(synthesized.author).toBe("agent_evidence_synthesis");
    expect(synthesized.attempted_runtimes[0]?.status).toBe("skipped");
  });

  it("extracts the last assistant message from codex JSONL stdout", () => {
    expect(parseCodexExecJsonl([
      JSON.stringify({ type: "session_started", id: "abc" }),
      JSON.stringify({ type: "agent_message", message: "first" }),
      JSON.stringify({ type: "agent_message", message: "{\"final\":true}" }),
    ].join("\n"))).toBe("{\"final\":true}");
  });
});

describe("editorial LLM error classification", () => {
  it("does not re-invoke the same runtime for JSON repair after a transport timeout", async () => {
    const codexCalls: EditorialLlmExecutorInput[] = [];
    const executor: EditorialLlmExecutor = async (input) => {
      if (input.command === "codex") {
        codexCalls.push(input);
        // Simulate a runtime that never returns within its budget.
        throw new Error(`${input.command} timed out after ${input.timeoutMs}ms`);
      }
      return {
        stdout: codexJsonl(JSON.stringify({ recovered: true })),
        stderr: "",
      };
    };

    const result = await completeEditorialJson({
      role: "test-role",
      prompt: "Return JSON.",
      timeoutMs: 50,
    }, {
      commandExists: (command) => command === "codex" || command === "claude",
      executor,
      env: {},
    });

    expect(result.runtime).toBe("claude_cli");
    // The timed-out runtime must not be re-invoked for repair purposes.
    expect(codexCalls).toHaveLength(1);
    const codexAttempt = result.attempts.find((attempt) => attempt.runtime === "codex_exec");
    expect(codexAttempt?.status).toBe("failed");
    expect(codexAttempt?.error_kind).toBe("transport_timeout");
  });

  it("does not re-invoke the same runtime for repair after a typed transport error", async () => {
    let codexInvocations = 0;
    const executor: EditorialLlmExecutor = async (input) => {
      if (input.command === "codex") {
        codexInvocations += 1;
        throw new EditorialLlmError("transport_error", "codex exited with 1: provider 502");
      }
      return { stdout: codexJsonl(JSON.stringify({ ok: true })), stderr: "" };
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

    expect(result.runtime).toBe("deterministic");
    expect(codexInvocations).toBe(1);
    expect(result.attempts).toEqual([
      { runtime: "codex_exec", status: "failed", message: expect.any(String), error_kind: "transport_error" },
      { runtime: "deterministic", status: "success" },
    ]);
  });

  it("classifies schema validation failures as repair-retryable and retries once", async () => {
    const inputs: string[] = [];
    const executor: EditorialLlmExecutor = async (input) => {
      inputs.push(input.input ?? "");
      return {
        stdout: inputs.length === 1
          ? codexJsonl(JSON.stringify({ candidates: [] }))
          : codexJsonl(JSON.stringify({ candidates: [{ segment_id: "s1" }] })),
        stderr: "",
      };
    };

    const result = await completeEditorialJson({
      role: "test-role",
      prompt: "Return JSON.",
      validateJson: (parsed) => {
        if (!Array.isArray(parsed.candidates) || parsed.candidates.length === 0) {
          throw new Error("candidates must not be empty");
        }
      },
    }, {
      runtime: "codex_exec",
      commandExists: (command) => command === "codex",
      executor,
      env: {},
    });

    expect(result.runtime).toBe("codex_exec");
    expect(inputs).toHaveLength(2);
    expect(inputs[1]).toContain("Schema validation failed:");
    expect(result.attempts[0]).toMatchObject({
      runtime: "codex_exec",
      status: "success",
      message: "succeeded after one JSON repair retry",
    });
  });

  it("records the retry failure kind when the repair attempt also times out", async () => {
    let invocations = 0;
    const executor: EditorialLlmExecutor = async () => {
      invocations += 1;
      if (invocations === 1) {
        return { stdout: codexJsonl("not json"), stderr: "" };
      }
      throw new Error("codex timed out after 50ms");
    };

    const result = await completeEditorialJson({
      role: "test-role",
      prompt: "Return JSON.",
      timeoutMs: 50,
    }, {
      runtime: "codex_exec",
      commandExists: (command) => command === "codex",
      executor,
      env: {},
    });

    expect(invocations).toBe(2);
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]).toMatchObject({ runtime: "codex_exec", status: "failed", error_kind: "transport_timeout" });
  });

  it("classifies plain timeout-looking errors as transport timeouts", () => {
    expect(classifyTransportError(new Error("claude timed out after 1000ms"))).toBe("transport_timeout");
    expect(classifyTransportError(new Error("connection reset"))).toBe("transport_error");
    expect(classifyTransportError(new EditorialLlmError("transport_timeout", "boom"))).toBe("transport_timeout");
  });
});

describe("editorial LLM stage deadline", () => {
  it("bounds the whole stage: late runtimes are skipped and deterministic fallback is reached in time", async () => {
    const invokedRuntimes: string[] = [];
    const executor: EditorialLlmExecutor = async (input) => {
      invokedRuntimes.push(input.command);
      // Each subprocess runtime burns most of the tiny stage budget.
      await new Promise((resolve) => setTimeout(resolve, 60));
      throw new Error(`${input.command} timed out after ${input.timeoutMs}ms`);
    };

    const startedAt = Date.now();
    const result = await completeEditorialJson({
      role: "test-role",
      prompt: "Return JSON.",
      timeoutMs: 60_000,
    }, {
      commandExists: (command) => command === "codex" || command === "claude",
      executor,
      env: { GEMINI_API_KEY: "test-key" },
      geminiText: async () => {
        throw new Error("gemini must not be invoked once the stage budget is spent");
      },
      stageTimeoutMs: 120,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(result.runtime).toBe("deterministic");
    // The stage deadline (plus scheduling slack), not the per-call timeout,
    // bounds total wall time.
    expect(elapsedMs).toBeLessThan(1_000);
    const skipped = result.attempts.filter((attempt) => attempt.status === "skipped");
    expect(skipped.map((attempt) => attempt.runtime)).toEqual(["gemini"]);
    expect(skipped[0].message).toContain("stage deadline exhausted");
    expect(skipped[0].error_kind).toBe("transport_timeout");
    expect(result.warnings.some((warning) => warning.includes("stage deadline exhausted"))).toBe(true);
  });

  it("hands the remaining stage budget to each runtime as its invocation timeout", async () => {
    const receivedBudgets: number[] = [];
    const executor: EditorialLlmExecutor = async (input) => {
      receivedBudgets.push(input.timeoutMs);
      await new Promise((resolve) => setTimeout(resolve, 50));
      throw new Error(`${input.command} timed out after ${input.timeoutMs}ms`);
    };

    const result = await completeEditorialJson({
      role: "test-role",
      prompt: "Return JSON.",
      timeoutMs: 10_000,
    }, {
      commandExists: (command) => command === "codex" || command === "claude",
      executor,
      env: { GEMINI_API_KEY: "test-key" },
      geminiText: async () => JSON.stringify({ provider: "gemini" }),
      stageTimeoutMs: 150,
    });

    expect(receivedBudgets.length).toBe(2);
    expect(receivedBudgets[0]).toBeLessThanOrEqual(10_000);
    // The remaining budget passed to the second runtime shrinks after the
    // first runtime consumed part of the 150ms stage budget.
    expect(receivedBudgets[1]).toBeLessThan(receivedBudgets[0]);
    expect(result.runtime).toBe("gemini");
    expect(result.attempts.every((attempt) => attempt.status !== "skipped")).toBe(true);
  });

  it("does not invoke any live runtime when the stage budget is already spent", async () => {
    const executor: EditorialLlmExecutor = async () => {
      throw new Error("executor must not be called");
    };

    const result = await completeEditorialJson({
      role: "test-role",
      prompt: "Return JSON.",
    }, {
      commandExists: (command) => command === "codex" || command === "claude",
      executor,
      env: {},
      stageTimeoutMs: 0,
    });

    expect(result.runtime).toBe("deterministic");
    const skippedKinds = result.attempts
      .filter((attempt) => attempt.status === "skipped")
      .map((attempt) => attempt.error_kind);
    expect(skippedKinds).toEqual(["transport_timeout", "transport_timeout"]);
  });

  it("reports available image-capable runtimes for appraiser gating", () => {
    const runtimes = availableEditorialLlmRuntimes({
      images: [{ data: Buffer.from("x").toString("base64"), mimeType: "image/png" }],
    }, {
      commandExists: (command) => command === "codex" || command === "claude",
      env: { GEMINI_API_KEY: "test-key" },
    });
    expect(runtimes).toEqual(["codex_exec", "gemini"]);
  });
});

describe("defaultExecutor subprocess termination", () => {
  const isPosix = process.platform !== "win32";

  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  async function waitForFile(filePath: string, timeoutMs = 5_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (fs.existsSync(filePath)) return fs.readFileSync(filePath, "utf-8").trim();
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`fixture file never appeared: ${filePath}`);
  }

  it("rejects with a typed transport timeout and kills the child after SIGTERM grace", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "editorial-executor-kill-"));
    const pidFile = path.join(workDir, "child.pid");
    // The child records its own pid, then hangs forever.
    const script =
      `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;

    try {
      await expect(defaultExecutor({
        command: process.execPath,
        args: ["-e", script],
        cwd: workDir,
        timeoutMs: 200,
        killGraceMs: 100,
      })).rejects.toMatchObject({ kind: "transport_timeout" });

      const pid = Number(await waitForFile(pidFile));
      expect(Number.isFinite(pid)).toBe(true);
      const deadline = Date.now() + 3_000;
      while (alive(pid) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(alive(pid)).toBe(false);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("escalates to SIGKILL and leaves no descendant processes behind", async () => {
    if (!isPosix) return;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "editorial-executor-group-"));
    const groupFile = path.join(workDir, "pgid");
    // The shell ignores SIGTERM ("trap '' TERM") so only the SIGKILL escalation
    // can stop it; the sleep grandchild shares the shell's process group.
    const script = `echo $$ > ${JSON.stringify(groupFile)}; trap '' TERM; sleep 30 & wait`;

    try {
      const startedAt = Date.now();
      await expect(defaultExecutor({
        command: "/bin/sh",
        args: ["-c", script],
        cwd: workDir,
        timeoutMs: 200,
        killGraceMs: 100,
      })).rejects.toMatchObject({ kind: "transport_timeout" });
      // Elapsed time must stay within timeout + grace + scheduling slack.
      expect(Date.now() - startedAt).toBeLessThan(5_000);

      // The detached child is its own process group leader: pgid == shell pid.
      const pgid = Number(await waitForFile(groupFile));
      expect(Number.isFinite(pgid)).toBe(true);

      // ESRCH from kill(-pgid, 0) proves no group survivors remain.
      const deadline = Date.now() + 3_000;
      let groupAlive = true;
      while (Date.now() < deadline) {
        try {
          process.kill(-pgid, 0);
          groupAlive = true;
        } catch (error) {
          groupAlive = (error as NodeJS.ErrnoException).code === "EPERM";
        }
        if (!groupAlive) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(groupAlive).toBe(false);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }, 15_000);
});
