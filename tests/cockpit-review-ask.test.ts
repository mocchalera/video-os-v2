import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildReviewAskSummary,
  CockpitReviewAskAdapter,
  type CockpitCommandResult,
} from "../runtime/review/cockpit-review-ask.js";
import type { ReviewAskPayload } from "../runtime/review/review-ready-transaction.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function sha(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function fixture(): { root: string; payload: ReviewAskPayload; mediaPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-review-ask-"));
  roots.push(root);
  const generationId = sha("generation");
  const mediaPath = path.join(root, "09_output/social-review/generations", generationId.slice(7), "review.mp4");
  fs.mkdirSync(path.dirname(mediaPath), { recursive: true });
  fs.writeFileSync(mediaPath, "verified review video bytes");
  const payload: ReviewAskPayload = {
    review_identity: sha("review identity"),
    generation_id: generationId,
    media: { locator: `project:09_output/social-review/generations/${generationId.slice(7)}/review.mp4`, sha256: sha("verified review video bytes") },
    duration_seconds: 54,
    bgm: "absent",
    caption_count: 2,
    qa_warnings: ["platform geometry not measured"],
    unresolved_items: ["confirm editorial pacing"],
    choices: ["approve", "request_changes", "free_text"],
    storyboard: {
      projection_id: "p1",
      manifest: { path: "04_plan/review-projections/p1/manifest.json", sha256: sha("manifest") },
      diff_summary: { trims: ["intro +1 frame"], crops: ["6 sampled crops"], captions: ["2 review-only cues"] },
    },
  };
  return { root: fs.realpathSync(root), payload, mediaPath: fs.realpathSync(mediaPath) };
}

function result(stdout: string, status = 0): CockpitCommandResult {
  return { status, stdout, stderr: "" };
}

describe("CockpitReviewAskAdapter", () => {
  it("uses argv, exact summary stdin, and an absolute verified media path", async () => {
    const { root, payload, mediaPath } = fixture();
    const calls: Array<{ args: string[]; cwd: string; stdin?: string }> = [];
    const responses = [
      result(JSON.stringify({ ok: true, data: { id: "task-current" } })),
      result(JSON.stringify({ ok: true, data: { asks: [] } })),
      result(JSON.stringify({ ok: true, data: { askId: "ask-real", status: "scheduled" } })),
    ];
    const adapter = new CockpitReviewAskAdapter({
      projectDir: root,
      runner: async (args, options) => {
        calls.push({ args: [...args], cwd: options.cwd, stdin: options.stdin });
        return responses.shift()!;
      },
    });

    await expect(adapter.dispatch({ idempotencyKey: payload.review_identity, payload })).resolves.toEqual({ ask_id: "ask-real" });
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({ args: ["task", "current"], cwd: root });
    expect(calls[1]).toMatchObject({ args: ["ask", "list", "--task", "task-current"], cwd: root });
    expect(calls[2]).toMatchObject({
      args: ["ask", "--stdin", "--choice", "approve", "--choice", "request_changes", "--media", mediaPath],
      cwd: root,
      stdin: buildReviewAskSummary(payload),
    });
    expect(calls[2]!.args.join(" ")).not.toContain(payload.review_identity);
  });

  it("ignores unrelated open Asks, adopts one matching Ask, and rejects duplicate matching markers", async () => {
    const { root, payload } = fixture();
    const marker = buildReviewAskSummary(payload).split("\n")[1]!;
    const calls: string[][] = [];
    const responses = [
      result(JSON.stringify({ ok: true, data: { id: "task-current" } })),
      result(JSON.stringify({ ok: true, data: { asks: [{ askId: "other", summary: "review_identity=sha256:other" }] } })),
      result(JSON.stringify({ ok: true, data: { askId: "ask-created", status: "scheduled" } })),
      result(JSON.stringify({ ok: true, data: { id: "task-current" } })),
      result(JSON.stringify({ ok: true, data: { asks: [{ askId: "ask-existing", taskId: "task-current", summary: marker }] } })),
      result(JSON.stringify({ ok: true, data: { id: "task-current" } })),
      result(JSON.stringify({ ok: true, data: { asks: [{ askId: "ask-one", taskId: "task-current", summary: marker }, { askId: "ask-two", taskId: "task-current", summary: marker }] } })),
    ];
    const adapter = new CockpitReviewAskAdapter({
      projectDir: root,
      runner: async (args) => {
        calls.push([...args]);
        return responses.shift()!;
      },
    });

    await expect(adapter.dispatch({ idempotencyKey: payload.review_identity, payload })).resolves.toEqual({ ask_id: "ask-created" });
    await expect(adapter.dispatch({ idempotencyKey: payload.review_identity, payload })).resolves.toEqual({ ask_id: "ask-existing" });
    await expect(adapter.dispatch({ idempotencyKey: payload.review_identity, payload })).rejects.toThrow(/multiple matching/i);
    expect(calls.filter((args) => args[0] === "ask" && args[1] === "--stdin")).toHaveLength(1);
    expect(calls.filter((args) => args[0] === "ask" && args[1] === "list").every((args) => args.slice(-2).join(" ") === "--task task-current")).toBe(true);
  });

  it("does not adopt a same-marker Ask reported for a foreign task", async () => {
    const { root, payload } = fixture();
    const marker = buildReviewAskSummary(payload).split("\n")[1]!;
    const calls: string[][] = [];
    const adapter = new CockpitReviewAskAdapter({
      projectDir: root,
      runner: async (args) => {
        calls.push([...args]);
        if (args[0] === "task") return result(JSON.stringify({ ok: true, data: { taskId: "task-current" } }));
        return result(JSON.stringify({ ok: true, data: { asks: [{ askId: "foreign-ask", taskId: "task-foreign", summary: marker }] } }));
      },
    });

    await expect(adapter.dispatch({ idempotencyKey: payload.review_identity, payload })).rejects.toThrow(/current task/i);
    expect(calls).toEqual([["task", "current"], ["ask", "list", "--task", "task-current"]]);
  });

  it("adopts an Ask after create output loss and rejects malformed create output", async () => {
    const { root, payload } = fixture();
    const marker = buildReviewAskSummary(payload).split("\n")[1]!;
    let call = 0;
    const adapter = new CockpitReviewAskAdapter({
      projectDir: root,
      runner: async () => {
        call += 1;
        if (call === 1 || call === 4) return result(JSON.stringify({ ok: true, data: { id: "task-current" } }));
        if (call === 2) return result(JSON.stringify({ ok: true, data: { asks: [] } }));
        if (call === 3) return result("not-json");
        return result(JSON.stringify({ ok: true, data: { asks: [{ askId: "ask-after-output-loss", taskId: "task-current", summary: marker }] } }));
      },
    });

    await expect(adapter.dispatch({ idempotencyKey: payload.review_identity, payload })).rejects.toThrow(/malformed JSON/i);
    await expect(adapter.dispatch({ idempotencyKey: payload.review_identity, payload })).resolves.toEqual({ ask_id: "ask-after-output-loss" });
    expect(call).toBe(5);

    const malformed = new CockpitReviewAskAdapter({
      projectDir: root,
      runner: async (args) => args[0] === "task"
        ? result(JSON.stringify({ ok: true, data: { id: "task-current" } }))
        : args[1] === "list"
        ? result(JSON.stringify({ ok: true, data: { asks: [] } }))
        : result(JSON.stringify({ ok: true, data: { askId: "ask-wrong-status", status: "pending" } })),
    });
    await expect(malformed.dispatch({ idempotencyKey: payload.review_identity, payload })).rejects.toThrow(/did not schedule/i);
  });

  it("fails closed when current-task, scoped-list, or create output fails", async () => {
    const cases: Array<{ name: string; responses: CockpitCommandResult[]; error: RegExp }> = [
      { name: "current task failure", responses: [result("", 1)], error: /task current failed/i },
      { name: "current task malformed", responses: [result(JSON.stringify({ ok: true, data: {} }))], error: /task ID/i },
      { name: "scoped list failure", responses: [result(JSON.stringify({ ok: true, data: { id: "task-current" } })), result("", 1)], error: /ask list failed/i },
      { name: "scoped list malformed", responses: [result(JSON.stringify({ ok: true, data: { id: "task-current" } })), result(JSON.stringify({ ok: true, data: {} }))], error: /did not return asks/i },
      { name: "create failure", responses: [result(JSON.stringify({ ok: true, data: { id: "task-current" } })), result(JSON.stringify({ ok: true, data: { asks: [] } })), result("", 1)], error: /cockpit ask failed/i },
    ];

    for (const testCase of cases) {
      const { root, payload } = fixture();
      const responses = [...testCase.responses];
      const adapter = new CockpitReviewAskAdapter({
        projectDir: root,
        runner: async () => responses.shift()!,
      });
      await expect(adapter.dispatch({ idempotencyKey: payload.review_identity, payload }), testCase.name).rejects.toThrow(testCase.error);
    }
  });
});
