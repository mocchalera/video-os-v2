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
});
