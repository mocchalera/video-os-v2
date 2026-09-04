import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { MarlinWorkerClient } from "../runtime/connectors/marlin-local.js";
import { normalizeMarlinAssetEvents } from "../runtime/connectors/marlin-normalize.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const WORKER_PATH = path.join(REPO_ROOT, "python/marlin_worker.py");

describe("Marlin local worker connector", () => {
  it("preserves the request id when worker inference raises", () => {
    const result = spawnSync(
      process.env.VOS_MARLIN_PYTHON ?? "python3",
      [WORKER_PATH, "--mock"],
      {
        cwd: REPO_ROOT,
        encoding: "utf-8",
        input: `${JSON.stringify({ id: 7, method: "caption", params: "invalid" })}\n`,
      },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toMatchObject({
      id: 7,
      ok: false,
      error: expect.stringContaining("has no attribute 'get'"),
    });
  });

  it("runs caption and find through the JSONL worker contract", async () => {
    const client = new MarlinWorkerClient({
      workerPath: WORKER_PATH,
      cwd: REPO_ROOT,
      mock: true,
    });

    try {
      const caption = await client.caption("fixtures/bicycle.mp4");
      const found = await client.find("fixtures/bicycle.mp4", "strongest visible action");

      expect(caption.scene).toContain("bicycle.mp4");
      expect(caption.events).toHaveLength(2);
      expect(found.query).toBe("strongest visible action");
      expect(found.span).toEqual([4.0, 6.25]);

      const normalized = normalizeMarlinAssetEvents({
        projectId: "demo",
        assetId: "AST_BICYCLE",
        sourcePath: "02_media/source/bicycle.mp4",
        model: {
          provider: "marlin",
          model_alias: "NemoStation/Marlin-2B",
          model_snapshot: "mock",
        },
        caption,
        findResults: [found],
      });

      expect(normalized.events[1]).toMatchObject({
        event_id: "MEV_AST_BICYCLE_0002",
        start_us: 4_000_000,
        end_us: 6_250_000,
      });
      expect(normalized.find_results[0].span_start_us).toBe(4_000_000);
    } finally {
      await client.close();
    }
  });

  it("sends the typed caption token bound through the connector", async () => {
    const client = new MarlinWorkerClient({
      workerPath: WORKER_PATH,
      cwd: REPO_ROOT,
      mock: true,
    });

    try {
      const caption = await client.caption("fixtures/bicycle.mp4", { maxNewTokens: 128 });
      expect(caption.scene).toContain("bicycle.mp4");
    } finally {
      await client.close();
    }
  });

  describe("worker JSONL contract", () => {
    function runWorkerRequest(params: unknown): { ok: boolean } {
      const result = spawnSync(
        process.env.VOS_MARLIN_PYTHON ?? "python3",
        [WORKER_PATH, "--mock"],
        {
          cwd: REPO_ROOT,
          encoding: "utf-8",
          input: `${JSON.stringify({ id: 1, method: "caption", params })}\n`,
        },
      );
      expect(result.status).toBe(0);
      return JSON.parse(result.stdout.trim());
    }

    it("accepts an explicit max_new_tokens bound", () => {
      expect(runWorkerRequest({ video_path: "fixtures/bicycle.mp4", max_new_tokens: 256 })).toMatchObject({ ok: true });
    });

    it("falls back to the safe hard default for invalid bounds instead of unbounded generation", () => {
      for (const invalid of [0, -5, "abc", null]) {
        expect(
          runWorkerRequest({ video_path: "fixtures/bicycle.mp4", max_new_tokens: invalid }),
        ).toMatchObject({ ok: true });
      }
    });
  });

  describe("device=auto MPS preference", () => {
    function resolveAutoDevice(platform: string, mpsAvailable: boolean): string | null {
      const script = [
        "import json, sys",
        `sys.path.insert(0, ${JSON.stringify(path.join(REPO_ROOT, "python"))})`,
        "from marlin_worker import resolve_auto_device",
        "args = json.loads(sys.argv[1])",
        "print(json.dumps(resolve_auto_device(args[\"platform\"], args[\"mps\"])))",
      ].join("\n");
      const result = spawnSync(
        process.env.VOS_MARLIN_PYTHON ?? "python3",
        ["-c", script, JSON.stringify({ platform, mps: mpsAvailable })],
        { encoding: "utf-8" },
      );
      expect(result.status).toBe(0);
      return JSON.parse(result.stdout.trim());
    }

    it("selects mps explicitly only on macOS when MPS is available", () => {
      expect(resolveAutoDevice("darwin", true)).toBe("mps");
      expect(resolveAutoDevice("darwin", false)).toBeNull();
      expect(resolveAutoDevice("linux", true)).toBeNull();
      expect(resolveAutoDevice("win32", true)).toBeNull();
    });
  });

  describe("caption token bound resolution", () => {
    function runPythonJson(script: string, argv?: string[]): any {
      const result = spawnSync(
        process.env.VOS_MARLIN_PYTHON ?? "python3",
        ["-c", script, ...(argv ?? [])],
        { encoding: "utf-8" },
      );
      expect(result.status).toBe(0);
      return JSON.parse(result.stdout.trim());
    }

    function effectiveBound(requested: unknown, configValue: number | null, ceiling: number | null): number {
      const script = [
        "import json, sys",
        `sys.path.insert(0, ${JSON.stringify(path.join(REPO_ROOT, "python"))})`,
        "from marlin_worker import effective_caption_max_new_tokens",
        "args = json.loads(sys.argv[1])",
        "print(json.dumps(effective_caption_max_new_tokens(args[\"requested\"], args[\"config\"], args[\"ceiling\"])))",
      ].join("\n");
      return runPythonJson(script, [JSON.stringify({ requested, config: configValue, ceiling })]);
    }

    it("clamps request and configured bounds to the policy ceiling", () => {
      expect(effectiveBound(999_999, null, 2048)).toBe(2048);
      expect(effectiveBound(null, 999_999, 1024)).toBe(1024);
      expect(effectiveBound(null, null, 512)).toBe(512);
      expect(effectiveBound(64, null, 2048)).toBe(64);
      expect(effectiveBound(64, null, null)).toBe(64);
    });

    it("falls back to the hard-default ceiling when the ceiling is missing or invalid", () => {
      // Direct worker launch without --caption-max-new-tokens-max.
      expect(effectiveBound(1_000_000_000_000, null, null)).toBe(2048);
      // Invalid ceilings must never let a huge bound through.
      expect(effectiveBound(1_000_000_000_000, null, 0)).toBe(2048);
      expect(effectiveBound(1_000_000_000_000, null, -7)).toBe(2048);
      // A malformed string ceiling can still arrive over the wire.
      expect(effectiveBound(1_000_000_000_000, null, "abc" as unknown as number)).toBe(2048);
      expect(effectiveBound(null, 1_000_000_000_000, null)).toBe(2048);
    });

    it("does not retry caption when the model rejects max_new_tokens with TypeError", () => {
      const script = [
        "import json, sys",
        `sys.path.insert(0, ${JSON.stringify(path.join(REPO_ROOT, "python"))})`,
        "from marlin_worker import handle_request, WorkerConfig",
        "calls = []",
        "class M:",
        "    def caption(self, video_path, max_new_tokens=None):",
        "        calls.append(1)",
        "        raise TypeError('unexpected keyword argument')",
        "request = {'id': 1, 'method': 'caption', 'params': {'video_path': 'v', 'max_new_tokens': 10}}",
        "config = WorkerConfig('m', 'auto', False)",
        "try:",
        "    handle_request(M(), request, config)",
        "    outcome = {'ok': True}",
        "except TypeError as exc:",
        "    # Mirrors the worker main loop: the error becomes a request error.",
        "    outcome = {'ok': False, 'error': str(exc)}",
        "print(json.dumps({**outcome, 'calls': len(calls)}))",
      ].join("\n");
      expect(runPythonJson(script)).toEqual({
        ok: false,
        error: expect.stringContaining("unexpected keyword argument"),
        calls: 1,
      });
    });
  });
});
