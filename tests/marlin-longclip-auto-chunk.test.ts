import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import type { MarlinEvent, MarlinFn } from "../runtime/connectors/marlin-types.js";
import {
  classifyMarlinFailure,
  dedupeIncomingChunkEvents,
  marlinAutoChunkConfigFromPolicy,
  marlinCheckpointSignature,
  runMarlinAnalysis,
} from "../runtime/pipeline/stages/marlin.js";

/**
 * Issue #5 M2: long footage is auto-chunked from the existing analysis
 * policy (marlin.chunk_target_us) without an explicit flag, keeps an
 * asset-level checkpoint bound to its inputs in marlin_events.json, and
 * completes explicitly degraded (successful chunks preserved, non-secret
 * failure records only) when a chunk fails. Live models and real footage
 * are never used here.
 */

const require_ = createRequire(import.meta.url);
const Ajv2020 = require_("ajv/dist/2020") as new (opts: Record<string, unknown>) => {
  addSchema(schema: object): unknown;
  compile(schema: object): {
    (data: unknown): boolean;
    errors?: Array<{ instancePath: string; message?: string }> | null;
  };
};

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const MODEL = {
  provider: "marlin",
  model_alias: "NemoStation/Marlin-2B",
  model_snapshot: "test",
} as const;

function createMarlinEventsValidator() {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const schema = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "schemas/marlin-events.schema.json"), "utf-8"));
  return ajv.compile(schema);
}

function makeTempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "video-os-marlin-longclip-"));
}

function ffmpegAvailable(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const fxit = ffmpegAvailable() ? it : it.skip;

function makeVideo(filePath: string, seconds: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  execFileSync("ffmpeg", [
    "-y", "-f", "lavfi",
    "-i", `testsrc2=d=${seconds}:s=160x90:r=10`,
    "-pix_fmt", "yuv420p",
    filePath,
  ], { stdio: "ignore" });
}

/** 31s-class fixture clip + policy that treats >10s as long (4 chunks, no overlap). */
function longClipProject(projectDir: string): void {
  makeVideo(path.join(projectDir, "media/long.mp4"), 31);
  fs.writeFileSync(path.join(projectDir, "analysis_policy.yaml"), [
    "marlin:",
    "  chunk_target_us: 10000000",
    "  chunk_overlap_us: 0",
  ].join("\n"));
  fs.mkdirSync(path.join(projectDir, "03_analysis"), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, "03_analysis/assets.json"),
    JSON.stringify({
      project_id: "marlin-longclip-fixture",
      artifact_version: "2.0.0",
      items: [
        {
          asset_id: "AST_LONG_CLIP",
          filename: "long.mp4",
          source_locator: "media/long.mp4",
        },
      ],
    }),
  );
}

interface StubOptions {
  /** Substring of the range-proxy path whose caption call should fail. */
  failCaptionRange?: string;
  failFind?: boolean;
  /** Caption returns zero events (successful but empty chunks). */
  zeroEvents?: boolean;
  scene?: string;
}

function captionStub(log: string[], options: StubOptions = {}): MarlinFn {
  return {
    async caption(videoPath) {
      log.push(videoPath);
      if (options.failCaptionRange && videoPath.includes(options.failCaptionRange)) {
        throw new Error("Marlin worker request timed out after 900000ms for caption");
      }
      return {
        scene: options.scene ?? "A documentary long take.",
        caption: "The camera follows the subject.",
        events: options.zeroEvents
          ? []
          : [{ start: 0.1, end: 0.5, description: "key moment", confidence: 0.7 }],
      };
    },
    async find(_videoPath, query) {
      if (options.failFind) {
        throw new Error("Marlin worker request timed out after 900000ms for find");
      }
      return { query, span: [0.1, 0.5], format_ok: true, confidence: 0.5 };
    },
  };
}

interface ArtifactFailure {
  stage: string;
  chunk_index?: number;
  query_index?: number;
  reason_class: string;
}

function readArtifact(projectDir: string): {
  items: Array<{
    asset_id: string;
    scene: string;
    events: MarlinEvent[];
    find_results: Array<{ query: string; span_start_us: number | null }>;
    evaluation_status?: string;
    failures?: ArtifactFailure[];
    completed_chunks?: number[];
    checkpoint_signature?: string;
  }>;
} {
  return JSON.parse(fs.readFileSync(path.join(projectDir, "03_analysis/marlin_events.json"), "utf-8"));
}

const run = (projectDir: string, marlinFn: MarlinFn, extra: Record<string, unknown> = {}) =>
  runMarlinAnalysis({
    projectDir,
    projectId: "marlin-longclip-fixture",
    sourceFiles: ["media/long.mp4"],
    marlinFn,
    model: MODEL,
    queries: ["q1"],
    repoRoot: REPO_ROOT,
    ...extra,
  });

let projectDir: string;

beforeEach(() => {
  projectDir = makeTempProject();
});

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
});

describe("marlin long-clip auto chunking", () => {
  fxit("auto-chunks a 31s policy-long clip into bounded per-chunk events", async () => {
    longClipProject(projectDir);
    const captionLog: string[] = [];

    await run(projectDir, captionStub(captionLog), { captionOnly: true });

    // 31s at a 10s target -> 4 deterministic chunks through range proxies.
    expect(captionLog).toHaveLength(4);
    for (const input of captionLog) {
      expect(input).toContain(path.join(".marlin-proxy-cache", "ranges"));
    }

    const artifact = readArtifact(projectDir);
    const item = artifact.items[0];
    expect(item.evaluation_status).toBe("complete");
    expect(item.failures).toBeUndefined();
    expect(item.completed_chunks).toEqual([0, 1, 2, 3]);
    expect(item.checkpoint_signature).toMatch(/^[0-9a-f]{16}$/);
    expect(item.events).toHaveLength(4);
    for (let index = 0; index < 4; index += 1) {
      const event = item.events[index];
      const offsetUs = index * 10_000_000;
      expect(event.chunk_index).toBe(index);
      // Offset 0 is omitted by the existing normalization rule.
      if (offsetUs > 0) expect(event.chunk_offset_us).toBe(offsetUs);
      else expect(event.chunk_offset_us).toBeUndefined();
      // Chunk-relative model times are offset into asset time and stay bounded.
      expect(event.start_us).toBe(offsetUs + 100_000);
      expect(event.end_us).toBe(offsetUs + 500_000);
      expect(event.end_us).toBeLessThanOrEqual(31_000_000);
    }

    const validate = createMarlinEventsValidator();
    expect(validate(readArtifact(projectDir)), JSON.stringify(validate.errors)).toBe(true);
  }, 120_000);

  fxit("resume with skip-existing does not re-run completed chunks", async () => {
    longClipProject(projectDir);
    const captionLog: string[] = [];

    await run(projectDir, captionStub(captionLog), { captionOnly: true });
    expect(captionLog).toHaveLength(4);

    await run(projectDir, captionStub(captionLog), { captionOnly: true, skipExisting: true });

    // The completed asset is skipped entirely on resume.
    expect(captionLog).toHaveLength(4);
    const item = readArtifact(projectDir).items[0];
    expect(item.evaluation_status).toBe("complete");
    expect(item.events).toHaveLength(4);
  }, 120_000);

  fxit("completes degraded when one chunk fails and keeps successful chunks", async () => {
    longClipProject(projectDir);
    const captionLog: string[] = [];

    await run(projectDir, captionStub(captionLog, { failCaptionRange: "20.000-30.000" }), { captionOnly: true });

    const artifact = readArtifact(projectDir);
    const item = artifact.items[0];
    expect(item.evaluation_status).toBe("degraded");
    expect(item.events.map((event) => event.chunk_index)).toEqual([0, 1, 3]);
    expect(item.failures).toEqual([
      { stage: "caption", chunk_index: 2, reason_class: "marlin_worker_timeout" },
    ]);
    const validate = createMarlinEventsValidator();
    expect(validate(artifact), JSON.stringify(validate.errors)).toBe(true);

    // Resume retries only the failed chunk and restores a complete asset.
    await run(projectDir, captionStub(captionLog), { captionOnly: true, skipExisting: true });
    // 4 first-run calls (incl. the failed chunk) + 1 retried chunk.
    expect(captionLog).toHaveLength(5);
    const resumed = readArtifact(projectDir).items[0];
    expect(resumed.evaluation_status).toBe("complete");
    expect(resumed.failures).toBeUndefined();
    expect(resumed.events.map((event) => event.chunk_index)).toEqual([0, 1, 2, 3]);
  }, 120_000);

  fxit("keeps chunk caption events when only the find pass fails", async () => {
    longClipProject(projectDir);
    const captionLog: string[] = [];

    await run(projectDir, captionStub(captionLog, { failFind: true }));

    const item = readArtifact(projectDir).items[0];
    expect(item.evaluation_status).toBe("degraded");
    expect(item.events).toHaveLength(4);
    expect(item.failures).toHaveLength(4);
    for (let index = 0; index < 4; index += 1) {
      expect(item.failures?.[index]).toEqual({
        stage: "find",
        chunk_index: index,
        query_index: 0,
        reason_class: "marlin_worker_timeout",
      });
    }
    const validate = createMarlinEventsValidator();
    expect(validate(readArtifact(projectDir)), JSON.stringify(validate.errors)).toBe(true);
  }, 120_000);

  it("keeps unknown-duration sources on the whole-asset path without a flag", async () => {
    fs.mkdirSync(path.join(projectDir, "03_analysis"), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "03_analysis/assets.json"),
      JSON.stringify({
        project_id: "marlin-longclip-fixture",
        artifact_version: "2.0.0",
        items: [
          { asset_id: "AST_SHORT", filename: "short.mp4", source_locator: "media/short.mp4" },
        ],
      }),
    );
    const captionLog: string[] = [];

    await run(projectDir, captionStub(captionLog), { captionOnly: true });

    // Probe fails open -> single whole-asset caption, no chunk metadata.
    expect(captionLog).toHaveLength(1);
    expect(captionLog[0].endsWith("short.mp4")).toBe(true);
    const item = readArtifact(projectDir).items[0];
    expect(item.evaluation_status).toBe("complete");
    expect(item.events.every((event) => event.chunk_index === undefined)).toBe(true);
  });
});

describe("marlin long-clip checkpoint counterexamples", () => {
  fxit("zero-event successful chunks are checkpointed and skipped on resume", async () => {
    longClipProject(projectDir);
    const captionLog: string[] = [];

    await run(projectDir, captionStub(captionLog, { zeroEvents: true }), { captionOnly: true });

    const item = readArtifact(projectDir).items[0];
    expect(captionLog).toHaveLength(4);
    expect(item.events).toEqual([]);
    // The explicit completed-chunk marker keeps 0-event successes done.
    expect(item.completed_chunks).toEqual([0, 1, 2, 3]);
    expect(item.evaluation_status).toBe("complete");

    await run(projectDir, captionStub(captionLog, { zeroEvents: true }), { captionOnly: true, skipExisting: true });
    expect(captionLog).toHaveLength(4);
  }, 120_000);

  fxit("resume retries only outstanding find failures without re-running captions", async () => {
    longClipProject(projectDir);
    const captionLog: string[] = [];
    const findLog: string[] = [];
    const failingFind = captionStub(captionLog, { failFind: true });
    const workingFind: MarlinFn = {
      ...failingFind,
      async find(_videoPath, query) {
        findLog.push(query);
        return { query, span: [0.1, 0.5], format_ok: true, confidence: 0.5 };
      },
    };

    await run(projectDir, failingFind);
    const degraded = readArtifact(projectDir).items[0];
    expect(degraded.evaluation_status).toBe("degraded");
    expect(degraded.find_results).toEqual([]);
    const captionsAfterFirstRun = captionLog.length;
    expect(captionsAfterFirstRun).toBe(4);

    await run(projectDir, workingFind, { skipExisting: true });

    // Saved captions/events are reused; only the 4 outstanding finds ran.
    expect(captionLog).toHaveLength(captionsAfterFirstRun);
    expect(findLog).toHaveLength(4);
    const resumed = readArtifact(projectDir).items[0];
    expect(resumed.evaluation_status).toBe("complete");
    expect(resumed.failures).toBeUndefined();
    expect(resumed.find_results).toHaveLength(4);
    expect(resumed.events).toHaveLength(4);
  }, 120_000);

  fxit("find-only retry preserves successful query results and retries only the failed query", async () => {
    longClipProject(projectDir);
    const captionLog: string[] = [];
    const findLog: string[] = [];
    const queries = ["q-success", "q-retry"];
    const firstRun: MarlinFn = {
      async caption(videoPath) {
        captionLog.push(videoPath);
        return {
          scene: "A documentary long take.",
          events: [{ start: 0.1, end: 0.5, description: "key moment" }],
        };
      },
      async find(_videoPath, query) {
        findLog.push(query);
        if (query === "q-retry") {
          throw new Error("Marlin worker request timed out after 900000ms for find");
        }
        return { query, span: [0.1, 0.5], format_ok: true, confidence: 0.5 };
      },
    };

    await run(projectDir, firstRun, { queries });
    const first = readArtifact(projectDir).items[0];
    expect(first.evaluation_status).toBe("degraded");
    // q-success stored one result per chunk; q-retry failed everywhere.
    expect(first.find_results).toHaveLength(4);
    expect(first.find_results.every((result) => result.query === "q-success")).toBe(true);
    const captionsAfterFirstRun = captionLog.length;
    const findsAfterFirstRun = findLog.length;
    expect(captionsAfterFirstRun).toBe(4);
    expect(findsAfterFirstRun).toBe(8);

    // Resume must not re-run captions at all — a caption call is a failure.
    const resumeFn: MarlinFn = {
      async caption(videoPath) {
        captionLog.push(videoPath);
        throw new Error("caption must not re-run during find-only retry");
      },
      async find(_videoPath, query) {
        findLog.push(query);
        return { query, span: [0.1, 0.5], format_ok: true, confidence: 0.5 };
      },
    };
    await run(projectDir, resumeFn, { queries, skipExisting: true });

    expect(captionLog).toHaveLength(captionsAfterFirstRun);
    // Only the failed query was retried, once per chunk.
    expect(findLog.filter((query) => query === "q-success")).toHaveLength(4);
    expect(findLog.filter((query) => query === "q-retry")).toHaveLength(8);
    const resumed = readArtifact(projectDir).items[0];
    expect(resumed.evaluation_status).toBe("complete");
    expect(resumed.failures).toBeUndefined();
    // Previously successful q-success results survive alongside the retried ones.
    expect(resumed.find_results.filter((result) => result.query === "q-success")).toHaveLength(4);
    expect(resumed.find_results.filter((result) => result.query === "q-retry")).toHaveLength(4);
  }, 120_000);

  fxit("failure records never contain raw error text or raw query strings", async () => {
    longClipProject(projectDir);
    const captionLog: string[] = [];
    const SECRET_SENTINEL = "TOP-SECRET-TOKEN";
    const secretQueries = ["find-the-secret-q1-marker"];

    const failing: MarlinFn = {
      async caption(videoPath) {
        captionLog.push(videoPath);
        if (videoPath.includes("20.000-30.000")) {
          throw new Error(`worker timeout for /Users/operator/${SECRET_SENTINEL}/prompt.mov`);
        }
        return {
          scene: "A documentary long take.",
          events: [{ start: 0.1, end: 0.5, description: "key moment" }],
        };
      },
      async find() {
        throw new Error(`find timed out near ${SECRET_SENTINEL}`);
      },
    };

    await run(projectDir, failing, { queries: secretQueries });

    const artifactText = fs.readFileSync(path.join(projectDir, "03_analysis/marlin_events.json"), "utf-8");
    expect(artifactText).not.toContain(SECRET_SENTINEL);
    expect(artifactText).not.toContain(secretQueries[0]);
    const item = readArtifact(projectDir).items[0];
    expect(item.evaluation_status).toBe("degraded");
    // Only location + stable class (+ non-secret ordinal) are stored.
    expect(item.failures?.some((failure) =>
      failure.stage === "caption" && failure.chunk_index === 2 && failure.reason_class === "marlin_worker_timeout"
    )).toBe(true);
    expect(item.failures?.every((failure) =>
      Object.keys(failure).every((key) => ["stage", "chunk_index", "query_index", "reason_class"].includes(key))
    )).toBe(true);
    const validate = createMarlinEventsValidator();
    expect(validate(readArtifact(projectDir)), JSON.stringify(validate.errors)).toBe(true);
  }, 120_000);

  fxit("cross-chunk dedupe collapses only real duplicates inside the overlap window", async () => {
    // Policy overlap: 10s chunks with 2s overlap -> [0,10],[8,18],[16,26],[24,31].
    makeVideo(path.join(projectDir, "media/long.mp4"), 31);
    fs.writeFileSync(path.join(projectDir, "analysis_policy.yaml"), [
      "marlin:",
      "  chunk_target_us: 10000000",
      "  chunk_overlap_us: 2000000",
    ].join("\n"));
    fs.mkdirSync(path.join(projectDir, "03_analysis"), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "03_analysis/assets.json"),
      JSON.stringify({
        project_id: "marlin-longclip-fixture",
        artifact_version: "2.0.0",
        items: [
          { asset_id: "AST_LONG_CLIP", filename: "long.mp4", source_locator: "media/long.mp4" },
        ],
      }),
    );

    const rangeStartSec = (videoPath: string): number | null => {
      const match = videoPath.match(/-(\d+\.\d{3})-(\d+\.\d{3})\.mp4$/);
      return match ? parseFloat(match[1]) : null;
    };
    const marlinFn: MarlinFn = {
      async caption(videoPath) {
        const start = rangeStartSec(videoPath);
        if (start === 0) {
          // 7s sits OUTSIDE the [8,10) overlap window; 9s sits inside it.
          return {
            scene: "Overlap fixture.",
            events: [
              { start: 7, end: 7.4, description: "early-moment" },
              { start: 9, end: 9.4, description: "overlap-dup" },
            ],
          };
        }
        if (start === 8) {
          // Same description as chunk0's 9s event, inside the window.
          return { scene: "Overlap fixture.", events: [{ start: 0.5, end: 0.9, description: "overlap-dup" }] };
        }
        if (start === 16) {
          return { scene: "Overlap fixture.", events: [{ start: 0.5, end: 0.9, description: "mid-a-moment" }] };
        }
        return { scene: "Overlap fixture.", events: [{ start: 0.5, end: 0.9, description: "mid-b-moment" }] };
      },
      async find() {
        throw new Error("caption-only test should not call find");
      },
    };

    await run(projectDir, marlinFn, { captionOnly: true });

    const item = readArtifact(projectDir).items[0];
    expect(item.evaluation_status).toBe("complete");
    // The 9s chunk0 duplicate collapsed into the earlier 8.5s chunk1 event;
    // the 7s event survived even though it is only 1.5s away (outside the window).
    expect(item.events.map((event) => [event.description, event.start_us])).toEqual([
      ["early-moment", 7_000_000],
      ["overlap-dup", 8_500_000],
      ["mid-a-moment", 16_500_000],
      ["mid-b-moment", 24_500_000],
    ]);
    const validate = createMarlinEventsValidator();
    expect(validate(readArtifact(projectDir)), JSON.stringify(validate.errors)).toBe(true);
  }, 120_000);

  fxit("re-evaluates only the stale asset after its source changes", async () => {
    longClipProject(projectDir);
    const captionLog: string[] = [];

    await run(projectDir, captionStub(captionLog, { scene: "first-generation scene" }), { captionOnly: true });
    const before = readArtifact(projectDir).items[0];
    expect(before.checkpoint_signature).toMatch(/^[0-9a-f]{16}$/);
    expect(captionLog).toHaveLength(4);

    // Replace the source content (new identity: size/mtime change).
    makeVideo(path.join(projectDir, "media/long.mp4"), 31);

    await run(projectDir, captionStub(captionLog, { scene: "second-generation scene" }), { captionOnly: true, skipExisting: true });

    // The stale checkpoint must not be reused: all 4 chunks re-ran.
    expect(captionLog).toHaveLength(8);
    const after = readArtifact(projectDir).items[0];
    expect(after.checkpoint_signature).not.toBe(before.checkpoint_signature);
    expect(after.scene).toContain("second-generation scene");
    expect(after.scene).not.toContain("first-generation scene");
    expect(after.evaluation_status).toBe("complete");
  }, 120_000);
});

describe("marlin auto-chunk policy resolution", () => {
  it("resolves chunk config from existing policy fields and fails open to disabled", () => {
    expect(marlinAutoChunkConfigFromPolicy(undefined)).toEqual({});
    expect(marlinAutoChunkConfigFromPolicy({ chunk_target_us: 0 })).toEqual({});
    expect(marlinAutoChunkConfigFromPolicy({ chunk_target_us: 120_000_000, chunk_overlap_us: 5_000_000 })).toEqual({
      chunkSeconds: 120,
      chunkOverlapSeconds: 5,
    });
    // Overlap is clamped below the chunk length.
    expect(marlinAutoChunkConfigFromPolicy({ chunk_target_us: 10_000_000, chunk_overlap_us: 9_000_000 })).toEqual({
      chunkSeconds: 10,
      chunkOverlapSeconds: 5,
    });
  });

  it("classifies failures into the shared readiness reason classes", () => {
    expect(classifyMarlinFailure(new Error("request timed out after 900000ms"))).toBe("marlin_worker_timeout");
    expect(classifyMarlinFailure(new Error("model_not_found: Marlin-2B"))).toBe("marlin_model_unavailable");
    expect(classifyMarlinFailure(new Error("spawn ENOENT python3"))).toBe("marlin_worker_unavailable");
    expect(classifyMarlinFailure(new Error("something else"))).toBe("marlin_worker_failure");
  });
});

describe("marlin boundary-overlap dedupe", () => {
  // chunk0 [0,10s], chunk1 [8,18s], real overlap window [8s,10s).
  const WINDOW = { incomingChunkIndex: 1, overlapStartUs: 8_000_000, overlapEndUs: 10_000_000 };
  const base = (startUs: number, description: string, id: string, chunkIndex?: number): MarlinEvent => ({
    event_id: id,
    start_us: startUs,
    end_us: startUs + 400_000,
    description,
    ...(chunkIndex !== undefined ? { chunk_index: chunkIndex } : {}),
  });

  it("keeps distinct same-description events inside one chunk", () => {
    const incoming = [
      base(8_500_000, "key moment", "MEV_C1_A", 1),
      base(8_700_000, "key moment", "MEV_C1_B", 1),
    ];
    const merged = dedupeIncomingChunkEvents([], incoming, WINDOW);
    expect(merged.map((event) => event.event_id)).toEqual(["MEV_C1_A", "MEV_C1_B"]);
  });

  it("keeps cross-chunk same-description events outside the overlap window", () => {
    // Counterexample: chunk0 @7s is outside [8,10); the 1.5s distance to
    // chunk1's @8.5s event must not collapse them.
    const existing = [base(7_000_000, "key moment", "MEV_C0_A", 0)];
    const incoming = [base(8_500_000, "key moment", "MEV_C1_A", 1)];
    expect(dedupeIncomingChunkEvents(existing, incoming, WINDOW)).toEqual([
      base(7_000_000, "key moment", "MEV_C0_A", 0),
      base(8_500_000, "key moment", "MEV_C1_A", 1),
    ]);
  });

  it("collapses genuine cross-chunk duplicates fully inside the window into one event", () => {
    const existing = [base(9_000_000, "overlap-dup", "MEV_C0_B", 0)];
    const incoming = [base(8_500_000, "overlap-dup", "MEV_C1_A", 1)];
    // Earliest wins.
    expect(dedupeIncomingChunkEvents(existing, incoming, WINDOW)).toEqual([
      base(8_500_000, "overlap-dup", "MEV_C1_A", 1),
    ]);
  });

  it("is deterministic regardless of input order and inert without a window", () => {
    const existing = [base(9_000_000, "overlap-dup", "MEV_C0_B", 0)];
    const incoming = [base(8_500_000, "overlap-dup", "MEV_C1_A", 1)];
    const forward = dedupeIncomingChunkEvents(existing, incoming, WINDOW);
    const backward = dedupeIncomingChunkEvents([...existing].reverse(), [...incoming].reverse(), WINDOW);
    expect(forward).toEqual(backward);
    // No window (zero overlap) -> pure sorted merge, nothing collapses.
    expect(dedupeIncomingChunkEvents(existing, incoming, { incomingChunkIndex: 1 })).toHaveLength(2);
  });
});

describe("marlin checkpoint binding signature", () => {
  const args = {
    sourcePath: "/tmp/clip.mp4",
    durationSec: 31,
    chunkSeconds: 10,
    chunkOverlapSeconds: 0,
    modelSnapshot: "snapshot-a",
  };

  it("is stable for identical inputs and sensitive to every binding input", () => {
    const baseline = marlinCheckpointSignature(args);
    expect(marlinCheckpointSignature({ ...args })).toBe(baseline);
    expect(marlinCheckpointSignature({ ...args, durationSec: 30 })).not.toBe(baseline);
    expect(marlinCheckpointSignature({ ...args, chunkSeconds: 15 })).not.toBe(baseline);
    expect(marlinCheckpointSignature({ ...args, chunkOverlapSeconds: 2 })).not.toBe(baseline);
    expect(marlinCheckpointSignature({ ...args, modelSnapshot: "snapshot-b" })).not.toBe(baseline);
    expect(marlinCheckpointSignature({ ...args, sourcePath: "/tmp/other.mp4" })).not.toBe(baseline);
  });
});
