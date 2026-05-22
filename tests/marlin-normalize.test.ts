import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import {
  createMarlinEventsArtifact,
  normalizeMarlinAssetEvents,
  normalizeMarlinEvent,
  normalizeMarlinFindResult,
  secondsToMicroseconds,
} from "../runtime/connectors/marlin-normalize.js";

const require_ = createRequire(import.meta.url);
const Ajv2020 = require_("ajv/dist/2020") as new (opts: Record<string, unknown>) => {
  compile(schema: object): {
    (data: unknown): boolean;
    errors?: Array<{ instancePath: string; message?: string }> | null;
  };
};

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

function createMarlinEventsValidator() {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const schema = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "schemas/marlin-events.schema.json"), "utf-8"));
  return ajv.compile(schema);
}

const model = {
  provider: "marlin" as const,
  model_alias: "NemoStation/Marlin-2B",
  model_snapshot: "test-snapshot",
  inference_mode: "live" as const,
};

describe("Marlin event normalization", () => {
  it("converts seconds to microseconds with chunk offset", () => {
    expect(secondsToMicroseconds(5.125, 2_000_000)).toBe(7_125_000);
  });

  it("normalizes caption events into stable timestamped event ids", () => {
    const event = normalizeMarlinEvent(
      {
        start: 1.2,
        end: 4.2,
        description: "The child prepares on the bicycle.",
        confidence: 1.2,
      },
      "AST 001",
      0,
    );

    expect(event).toEqual({
      event_id: "MEV_AST_001_0001",
      start_us: 1_200_000,
      end_us: 4_200_000,
      description: "The child prepares on the bicycle.",
      confidence: 1,
      source_pass: "marlin_caption",
    });
  });

  it("drops malformed caption events that cannot affect editing safely", () => {
    expect(normalizeMarlinEvent({ start: 5, end: 4, description: "bad range" }, "AST_001", 0)).toBeNull();
    expect(normalizeMarlinEvent({ start: 1, end: 2 }, "AST_001", 0)).toBeNull();
  });

  it("normalizes find spans and preserves failed format checks", () => {
    expect(
      normalizeMarlinFindResult({
        query: "moment of success",
        span: [5.1, 6.9],
        confidence: -1,
      }),
    ).toEqual({
      query: "moment of success",
      span_start_us: 5_100_000,
      span_end_us: 6_900_000,
      format_ok: true,
      confidence: 0,
    });

    expect(
      normalizeMarlinFindResult({
        query: "unclear moment",
        span: null,
        format_ok: false,
        raw: "not found",
      }),
    ).toEqual({
      query: "unclear moment",
      span_start_us: null,
      span_end_us: null,
      format_ok: false,
      raw: "not found",
    });
  });

  it("creates a schema-valid marlin_events artifact", () => {
    const item = normalizeMarlinAssetEvents({
      projectId: "demo",
      assetId: "AST_001",
      sourcePath: "02_media/source/a001.mp4",
      model,
      caption: {
        scene: "A child practices riding a bicycle while an adult watches.",
        events: [
          {
            start: 4.3,
            end: 6.8,
            description: "The child starts pedaling and keeps balance.",
            confidence: 0.82,
          },
        ],
      },
      findResults: [
        {
          query: "child successfully rides the bicycle",
          span: [5.1, 6.9],
          format_ok: true,
        },
      ],
    });
    const artifact = createMarlinEventsArtifact({ projectId: "demo", model, items: [item] });
    const validate = createMarlinEventsValidator();

    expect(validate(artifact), JSON.stringify(validate.errors, null, 2)).toBe(true);
    expect(artifact.items[0].events[0].event_id).toBe("MEV_AST_001_0001");
    expect(artifact.items[0].find_results[0].span_start_us).toBe(5_100_000);
  });
});
