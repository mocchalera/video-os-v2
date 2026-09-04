import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { MarlinFn } from "../runtime/connectors/marlin-types.js";
import {
  MARLIN_CAPTION_TOKEN_BUDGET_DEFAULTS,
  marlinCaptionMaxNewTokens,
  normalizeMarlinCaptionTokenBudget,
} from "../runtime/pipeline/stages/marlin.js";

// Deterministic stage wiring: no ffprobe dependency on the test host.
vi.mock("../runtime/pipeline/stages/marlin-proxy.js", () => ({
  prepareMarlinProxy: async (_projectDir: string, sourcePath: string) =>
    ({ evaluationPath: sourcePath, proxied: false }),
  createMarlinRangeProxy: async (
    _projectDir: string,
    _sourcePath: string,
    startSec: number,
    endSec: number,
  ) => ({ rangePath: "range", startSec, endSec }),
  probeVideoDurationSeconds: async (sourcePath: string) =>
    sourcePath.includes("does-not-exist") ? null : 5,
}));

const { runMarlinAnalysis } = await import("../runtime/pipeline/stages/marlin.js");

describe("Marlin bounded caption token budget", () => {
  describe("normalizeMarlinCaptionTokenBudget", () => {
    it("keeps valid policy values", () => {
      const budget = normalizeMarlinCaptionTokenBudget({
        caption_max_new_tokens_short: 256,
        caption_max_new_tokens_max: 4096,
        caption_short_source_max_seconds: 90,
      });
      expect(budget).toEqual({
        shortSourceMaxNewTokens: 256,
        longSourceMaxNewTokens: 4096,
        shortSourceMaxSeconds: 90,
      });
    });

    it("falls back per-field to safe defaults on missing, zero, negative, or non-numeric values", () => {
      const budget = normalizeMarlinCaptionTokenBudget({
        caption_max_new_tokens_short: 0,
        caption_max_new_tokens_max: -5,
        // Simulates a malformed policy document reaching the normalizer.
        caption_short_source_max_seconds: "invalid",
      } as unknown as Parameters<typeof normalizeMarlinCaptionTokenBudget>[0]);
      expect(budget).toEqual(MARLIN_CAPTION_TOKEN_BUDGET_DEFAULTS);
    });
  });

  describe("marlinCaptionMaxNewTokens", () => {
    const budget = normalizeMarlinCaptionTokenBudget(undefined);

    it("uses the short cap at or below the threshold", () => {
      expect(marlinCaptionMaxNewTokens(budget, 120)).toBe(
        MARLIN_CAPTION_TOKEN_BUDGET_DEFAULTS.shortSourceMaxNewTokens,
      );
      expect(marlinCaptionMaxNewTokens(budget, 5)).toBe(512);
    });

    it("uses the hard max above the threshold", () => {
      expect(marlinCaptionMaxNewTokens(budget, 120.01)).toBe(2048);
      expect(marlinCaptionMaxNewTokens(budget, 3600)).toBe(2048);
    });

    it("uses the hard max for unknown durations (conservative bound)", () => {
      expect(marlinCaptionMaxNewTokens(budget, null)).toBe(2048);
      expect(marlinCaptionMaxNewTokens(budget, undefined)).toBe(2048);
      expect(marlinCaptionMaxNewTokens(budget, Number.NaN)).toBe(2048);
    });
  });

  describe("stage wiring", () => {
    it("passes a positive integer maxNewTokens to caption requests", async () => {
      const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "marlin-budget-"));
      try {
        fs.mkdirSync(path.join(projectDir, "03_analysis"), { recursive: true });
        fs.writeFileSync(
          path.join(projectDir, "03_analysis/assets.json"),
          JSON.stringify({
            items: [
              {
                asset_id: "AST_SHORT",
                source_locator: path.join(import.meta.dirname, "fixtures/media/test-clip-5s.mp4"),
              },
              { asset_id: "AST_PROBELESS", source_locator: "media/does-not-exist.mp4" },
            ],
          }),
        );

        const seen: Array<number | undefined> = [];
        const marlinFn: MarlinFn = {
          async caption(_videoPath, options) {
            seen.push(options?.maxNewTokens);
            return { scene: "scene", events: [] };
          },
          async find(_videoPath, query) {
            return { query, span: null, format_ok: false };
          },
        };

        await runMarlinAnalysis({
          projectDir,
          projectId: "marlin-budget",
          sourceFiles: [],
          marlinFn,
          queries: [],
        });

        // 5s fixture → short cap; unprobeable source → conservative hard max.
        expect(seen).toEqual([MARLIN_CAPTION_TOKEN_BUDGET_DEFAULTS.shortSourceMaxNewTokens, MARLIN_CAPTION_TOKEN_BUDGET_DEFAULTS.longSourceMaxNewTokens]);
        for (const value of seen) {
          expect(Number.isInteger(value)).toBe(true);
          expect(value ?? 0).toBeGreaterThan(0);
        }
      } finally {
        fs.rmSync(projectDir, { recursive: true, force: true });
      }
    });

    it("applies an external project's policy override when repoRoot is provided", async () => {
      const REPO_ROOT = path.resolve(import.meta.dirname, "..");
      const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "marlin-budget-override-"));
      try {
        fs.mkdirSync(path.join(projectDir, "03_analysis"), { recursive: true });
        fs.writeFileSync(
          path.join(projectDir, "analysis_policy.yaml"),
          [
            "marlin:",
            "  caption_max_new_tokens_short: 77",
            "  caption_max_new_tokens_max: 4321",
          ].join("\n"),
        );
        fs.writeFileSync(
          path.join(projectDir, "03_analysis/assets.json"),
          JSON.stringify({
            items: [
              {
                asset_id: "AST_SHORT",
                source_locator: path.join(import.meta.dirname, "fixtures/media/test-clip-5s.mp4"),
              },
              { asset_id: "AST_PROBELESS", source_locator: "media/does-not-exist.mp4" },
            ],
          }),
        );

        const seen: Array<number | undefined> = [];
        const marlinFn: MarlinFn = {
          async caption(_videoPath, options) {
            seen.push(options?.maxNewTokens);
            return { scene: "scene", events: [] };
          },
          async find(_videoPath, query) {
            return { query, span: null, format_ok: false };
          },
        };

        await runMarlinAnalysis({
          projectDir,
          projectId: "marlin-budget-override",
          sourceFiles: [],
          marlinFn,
          queries: [],
          repoRoot: REPO_ROOT,
        });

        // Override flows through repoRoot instead of falling back to defaults.
        expect(seen).toEqual([77, 4321]);
      } finally {
        fs.rmSync(projectDir, { recursive: true, force: true });
      }
    });
  });
});
