import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  completeEditorialJson,
  type EditorialLlmExecutor,
} from "../runtime/connectors/editorial-llm.js";
import {
  createFileEditorialAttemptJournal,
  editorialAttemptJournalPath,
  readEditorialAttemptJournal,
  sanitizeJournalNote,
} from "../runtime/connectors/editorial-llm-journal.js";

function codexJsonl(text: string): string {
  return `${JSON.stringify({ type: "agent_message", message: text })}\n`;
}

function tempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "editorial-journal-"));
}

describe("editorial attempt journal", () => {
  it("persists sanitized entries for timeout, parse failure, and success paths", async () => {
    const projectDir = tempProject();
    let claudeCalls = 0;
    const executor: EditorialLlmExecutor = async (input) => {
      if (input.command === "codex") {
        throw new Error(`${input.command} timed out after ${input.timeoutMs}ms`);
      }
      claudeCalls += 1;
      if (claudeCalls === 1) {
        // claude_cli returns raw stdout (no JSONL framing): unparseable text.
        return { stdout: "not json at all", stderr: "" };
      }
      return { stdout: JSON.stringify({ ok: true }), stderr: "" };
    };

    try {
      const result = await completeEditorialJson({
        role: "triage-llm",
        prompt: "SECRET-PROMPT-BODY select the best segments",
      }, {
        runtime: "codex_exec",
        commandExists: (command) => command === "codex" || command === "claude",
        executor,
        env: {},
        projectDir,
      });

      expect(result.runtime).toBe("claude_cli");
      const entries = readEditorialAttemptJournal(projectDir);

      // codex_exec first attempt: transport_timeout failure.
      // claude_cli first attempt: json_parse failure; repair retry: success.
      const codex = entries.filter((entry) => entry.transport_runtime === "codex_exec");
      expect(codex.length).toBeGreaterThanOrEqual(1);
      const codexFinished = codex.find((entry) => entry.status === "failed");
      expect(codexFinished).toMatchObject({
        role: "triage-llm",
        mode: "text",
        requested_provider: "codex",
        requested_model: "unknown",
        effective_provider: "codex_exec",
        effective_model: "unknown",
        model_confirmed: false,
        retry_index: 0,
        error_kind: "transport_timeout",
      });

      const claude = entries.filter((entry) => entry.transport_runtime === "claude_cli");
      expect(claude.map((entry) => `${entry.retry_index}:${entry.status}`)).toEqual([
        "0:running", "0:failed", "1:running", "1:success",
      ]);
      expect(claude[1].error_kind).toBe("json_parse");
      expect(claude[3].status).toBe("success");
      expect(typeof claude[3].elapsed_ms).toBe("number");
      expect(claude[3].started_at).toBeTruthy();
      expect(claude[3].ended_at).toBeTruthy();

      // A running line must exist from attempt start (interrupted runs leave evidence).
      expect(entries.some((entry) => entry.status === "running")).toBe(true);
      expect(claude[0].role).toBe("triage-llm");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("never records prompt bodies, API keys, tokens, or environment values", async () => {
    const projectDir = tempProject();
    const executor: EditorialLlmExecutor = async () => ({
      stdout: codexJsonl(JSON.stringify({ ok: true })),
      stderr: "",
    });

    try {
      await completeEditorialJson({
        role: "blueprint-llm",
        prompt: "TOP-SECRET-PROMPT-CONTENT do not leak me",
      }, {
        runtime: "gemini",
        geminiModel: "gemini-test-model",
        commandExists: () => false,
        executor: () => {
          throw new Error("executor must not run for gemini");
        },
        geminiText: async () => JSON.stringify({ provider: "gemini" }),
        env: {
          GEMINI_API_KEY: "test-gemini-api-key",
          EDITORIAL_LLM_GEMINI_MODEL: "gemini-test-model",
        },
        projectDir,
      });

      const raw = fs.readFileSync(editorialAttemptJournalPath(projectDir), "utf-8");
      expect(raw).not.toContain("TOP-SECRET-PROMPT-CONTENT");
      expect(raw).not.toContain("test-gemini-api-key");
      expect(raw.toLowerCase()).not.toContain("api_key=");

      const entries = readEditorialAttemptJournal(projectDir);
      const geminiEntry = entries.find((entry) =>
        entry.transport_runtime === "gemini" && entry.status === "success"
      );
      expect(geminiEntry).toMatchObject({
        requested_provider: "gemini",
        requested_model: "gemini-test-model",
        effective_provider: "gemini",
        effective_model: "gemini-test-model",
        model_confirmed: true,
        status: "success",
      });
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("records a stable failure detail without persisting provider error bodies", async () => {
    const projectDir = tempProject();
    const secretErrorBody = "TOP-SECRET-PROVIDER-BODY request_id=private-123";

    try {
      const result = await completeEditorialJson({
        role: "triage-llm",
        prompt: "TOP-SECRET-PROMPT-BODY do not persist me",
      }, {
        runtime: "codex_exec",
        commandExists: (command) => command === "codex",
        executor: async () => {
          throw new Error(`provider failed: ${secretErrorBody}`);
        },
        env: {},
        projectDir,
      });

      expect(result.runtime).toBe("deterministic");
      expect(result.warnings).toEqual(["codex_exec: transport_error"]);
      const raw = fs.readFileSync(editorialAttemptJournalPath(projectDir), "utf-8");
      expect(raw).not.toContain("TOP-SECRET-PROMPT-BODY");
      expect(raw).not.toContain(secretErrorBody);
      expect(raw).toContain('"note":"codex_exec: transport_error"');
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("keeps codex_exec effective model unknown even when a Gemini alias is configured", async () => {
    const projectDir = tempProject();
    const executor: EditorialLlmExecutor = async () => ({
      stdout: codexJsonl(JSON.stringify({ ok: true })),
      stderr: "",
    });

    try {
      await completeEditorialJson({
        role: "appraiser",
        prompt: "Return JSON.",
      }, {
        runtime: "codex_exec",
        commandExists: (command) => command === "codex",
        executor,
        geminiModel: "gemini-2.5-flash-lite",
        env: {},
        projectDir,
      });

      const entries = readEditorialAttemptJournal(projectDir);
      expect(entries.filter((entry) => entry.transport_runtime === "codex_exec"))
        .toEqual(expect.arrayContaining([
          expect.objectContaining({
            effective_model: "unknown",
            effective_provider: "codex_exec",
            model_confirmed: false,
          }),
        ]));
      const serialized = JSON.stringify(entries);
      expect(serialized).not.toContain("gemini-2.5-flash-lite");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("records skipped runtimes when the stage deadline is exhausted", async () => {
    const projectDir = tempProject();
    const executor: EditorialLlmExecutor = async () => {
      throw new Error("executor must not be called");
    };

    try {
      const result = await completeEditorialJson({
        role: "triage-llm",
        prompt: "Return JSON.",
      }, {
        commandExists: (command) => command === "codex" || command === "claude",
        executor,
        env: {},
        stageTimeoutMs: 0,
        projectDir,
      });

      expect(result.runtime).toBe("deterministic");
      const entries = readEditorialAttemptJournal(projectDir);
      const skipped = entries.filter((entry) => entry.status === "skipped");
      expect(skipped.map((entry) => entry.transport_runtime)).toEqual(["codex_exec", "claude_cli"]);
      expect(skipped[0].note).toContain("stage deadline exhausted");

      const fallback = entries.find((entry) =>
        entry.transport_runtime === "deterministic" && entry.status === "success"
      );
      expect(fallback?.status).toBe("success");
      expect(fallback?.note).toContain("deterministic fallback");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("redacts credential-shaped substrings from notes", () => {
    const note = sanitizeJournalNote(
      "codex exited with 1: Authorization: Bearer abcdefgh12345 and api_key=AIzaSyA1234567890abcdefghijk",
    );
    expect(note).not.toContain("abcdefgh12345");
    expect(note).not.toContain("AIzaSyA1234567890abcdefghijk");
    expect(note).toContain("[redacted]");
    expect(sanitizeJournalNote("plain failure without secrets")).toBe("plain failure without secrets");
  });

  it("writes running lines immediately so interrupted attempts still leave evidence", () => {
    const projectDir = tempProject();
    try {
      const journal = createFileEditorialAttemptJournal(projectDir);
      const attemptId = journal.start({
        role: "triage-llm",
        mode: "multimodal",
        transport_runtime: "codex_exec",
        requested_provider: "codex",
        requested_model: "unknown",
        effective_provider: "codex_exec",
        effective_model: "unknown",
        model_confirmed: false,
        retry_index: 0,
      });

      // Simulate an interruption: no finish() call ever happens.
      const entries = readEditorialAttemptJournal(projectDir);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        attempt_id: attemptId,
        status: "running",
        mode: "multimodal",
      });
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("tolerates torn trailing lines in the journal file", () => {
    const projectDir = tempProject();
    try {
      const journalPath = editorialAttemptJournalPath(projectDir);
      fs.mkdirSync(path.dirname(journalPath), { recursive: true });
      fs.writeFileSync(journalPath, [
        JSON.stringify({
          schema_version: "1",
          attempt_id: "attempt_ok",
          role: "r",
          mode: "text",
          transport_runtime: "gemini",
          requested_provider: "gemini",
          requested_model: "m",
          effective_provider: "gemini",
          effective_model: "m",
          model_confirmed: true,
          retry_index: 0,
          pid: 1,
          started_at: "2026-08-22T00:00:00.000Z",
          status: "success",
        }),
        '{"schema_version":"1","attempt_i', // torn write from a killed process
      ].join("\n"), "utf-8");

      const entries = readEditorialAttemptJournal(projectDir);
      expect(entries).toHaveLength(1);
      expect(entries[0].attempt_id).toBe("attempt_ok");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
