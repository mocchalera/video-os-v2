import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Test-local wrapper module seam: node:fs is wrapped in a passthrough whose
// public filesystem operations are reconfigurable per test. Production code
// exposes no hook, option, or global for this — the seam lives only in this
// test module.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  // The real module is stashed for the test-local seam; production code
  // never reads this key.
  (globalThis as Record<string, unknown>).__realFsModule = actual;
  return {
    ...actual,
    default: actual,
    renameSync: vi.fn(((from: fs.PathLike, to: fs.PathLike) =>
      ((globalThis as Record<string, unknown>).__realFsModule as typeof fs).renameSync(from, to)) as typeof fs.renameSync),
    linkSync: vi.fn(((from: fs.PathLike, to: fs.PathLike) =>
      ((globalThis as Record<string, unknown>).__realFsModule as typeof fs).linkSync(from, to)) as typeof fs.linkSync),
    unlinkSync: vi.fn(((path: fs.PathLike) =>
      ((globalThis as Record<string, unknown>).__realFsModule as typeof fs).unlinkSync(path)) as typeof fs.unlinkSync),
    copyFileSync: vi.fn(((from: fs.PathLike, to: fs.PathLike) =>
      ((globalThis as Record<string, unknown>).__realFsModule as typeof fs).copyFileSync(from, to)) as typeof fs.copyFileSync),
    writeFileSync: vi.fn(((file: fs.PathLike, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) =>
      ((globalThis as Record<string, unknown>).__realFsModule as typeof fs).writeFileSync(file, data, options)) as typeof fs.writeFileSync),
    openSync: vi.fn(((path: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode | null) =>
      ((globalThis as Record<string, unknown>).__realFsModule as typeof fs).openSync(path, flags, mode)) as typeof fs.openSync),
  };
});
function realFs(): typeof fs {
  return (globalThis as Record<string, unknown>).__realFsModule as typeof fs;
}
function resetFsSeam(): void {
  vi.mocked(fs.renameSync).mockImplementation((from: fs.PathLike, to: fs.PathLike) => realFs().renameSync(from, to));
  vi.mocked(fs.linkSync).mockImplementation((from: fs.PathLike, to: fs.PathLike) => realFs().linkSync(from, to));
  vi.mocked(fs.unlinkSync).mockImplementation((path: fs.PathLike) => realFs().unlinkSync(path));
  vi.mocked(fs.copyFileSync).mockImplementation((from: fs.PathLike, to: fs.PathLike) => realFs().copyFileSync(from, to));
  vi.mocked(fs.writeFileSync).mockImplementation(((file, data, options) => realFs().writeFileSync(file, data, options)) as typeof fs.writeFileSync);
  vi.mocked(fs.openSync).mockImplementation((path: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode | null) => realFs().openSync(path, flags, mode));
}
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { ReviewReport, ReviewAgent } from "../runtime/commands/review/index.js";
import { runReview } from "../runtime/commands/review/index.js";
import { executeRecompileLoop, resolveReentryEvidenceIdentity } from "../runtime/handoff/reentry.js";
import { draftAndPromote, recoverPromoteTransaction } from "../runtime/commands/shared.js";
import * as childProcess from "node:child_process";
import { computeFileHash, snapshotArtifacts, writeProjectState } from "../runtime/state/reconcile.js";
import {
  HIGH_CONFIDENCE_THRESHOLD,
  DEGRADED_CONFIDENCE_CEILING,
  UNSUPPORTED_CONFIDENCE_CEILING,
} from "../runtime/eval/brief-alignment-types.js";
import {
  enforceReviewJudgmentIntegrity,
  enforceCanonicalReviewReportGate,
  migrateReviewReport,
  validateSourceEvidenceRefs,
  type EditorialJudgment,
} from "../runtime/commands/review/index.js";
import { validateAgainstSchema } from "../runtime/commands/shared.js";

beforeEach(() => {
  resetFsSeam();
});

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020") as new (opts: Record<string, unknown>) => {
  compile(schema: object): { (data: unknown): boolean; errors?: Array<{ instancePath: string; message?: string }> | null };
  addSchema(schema: object): void;
};
const addFormats = require("ajv-formats") as (ajv: unknown) => void;

function createValidator(schemaFile: string) {
  const schemaPath = path.resolve("schemas", schemaFile);
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  if (schemaFile === "review-report.schema.json") {
    ajv.addSchema(JSON.parse(fs.readFileSync(path.resolve("schemas/whole-cut-semantic-review.schema.json"), "utf-8")));
  }
  return ajv.compile(schema);
}

const BRIEF_SHA256 = "a".repeat(64);

interface EvidenceFixture {
  dir: string;
  identity: Record<string, string>;
  briefSha256: string;
}

/**
 * Generic evidence fixture project: canonical artifacts that judgments may
 * bind to. `identity` mirrors what the system records in project_state
 * (doc.artifact_hashes) after a reconcile. No genre/event-specific knowledge.
 */
function makeEvidenceProject(): EvidenceFixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-judgment-evidence-"));
  fs.mkdirSync(path.join(dir, "01_intent"), { recursive: true });
  fs.mkdirSync(path.join(dir, "02_media"), { recursive: true });
  fs.mkdirSync(path.join(dir, "03_analysis"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "01_intent/creative_brief.yaml"),
    'version: "1"\nproject_id: fixture-project\n',
  );
  fs.writeFileSync(
    path.join(dir, "03_analysis/segments.json"),
    JSON.stringify({ items: [{ segment_id: "seg_0010", summary: "fixture segment" }] }),
  );
  fs.writeFileSync(path.join(dir, "02_media/source_a.mp4"), Buffer.from("fixture-media-bytes"));
  // A file that exists but lives outside the canonical artifact allowlist:
  // existence alone must not make it valid evidence.
  fs.mkdirSync(path.join(dir, "notes"), { recursive: true });
  fs.writeFileSync(path.join(dir, "notes/scratch.txt"), "not canonical");
  const identity = { brief_hash: computeFileHash(path.join(dir, "01_intent/creative_brief.yaml")) };
  const briefSha256 = crypto.createHash("sha256")
    .update(fs.readFileSync(path.join(dir, "01_intent/creative_brief.yaml")))
    .digest("hex");
  return { dir, identity, briefSha256 };
}

function buildJudgment(overrides: Partial<EditorialJudgment> = {}): EditorialJudgment {
  return {
    observation: "A person in a dark jacket walks from the left edge toward the center of the frame.",
    inference: "This person is likely the protagonist the brief centers on.",
    editorial_intent: "Establish the protagonist early so the audience follows their goal.",
    evidence: [
      { kind: "artifact_ref", ref: "01_intent/creative_brief.yaml" },
    ],
    confidence: 0.6,
    confidence_basis: "measured",
    ...overrides,
  };
}

function buildReport(overrides: Partial<ReviewReport> = {}): ReviewReport {
  return {
    version: "2",
    project_id: "fixture-project",
    timeline_version: "timeline-fixture-1",
    summary_judgment: {
      status: "needs_revision",
      rationale: "Fixture baseline.",
    },
    strengths: [],
    weaknesses: [],
    fatal_issues: [],
    warnings: [],
    mismatches_to_brief: [],
    mismatches_to_blueprint: [],
    recommended_next_pass: {
      goal: "Fixture goal.",
      actions: ["Fixture action."],
    },
    editorial_judgments: [buildJudgment()],
    ...overrides,
  };
}

// ── Evidence binding (audit amendment 2) ──────────────────────────

describe("source evidence binding (authoritative allowlist, identity, exact ids)", () => {
  it("verifies tracked artifacts against recorded identity and marks the rest contextual", () => {
    const { dir, identity, briefSha256 } = makeEvidenceProject();
    const { verified, contextual, invalid } = validateSourceEvidenceRefs([
      { kind: "artifact_ref", ref: "01_intent/creative_brief.yaml" },
      { kind: "artifact_ref", ref: "01_intent/creative_brief.yaml", sha256: briefSha256 },
      { kind: "transcript_span", ref: "03_analysis/segments.json#seg_0010" },
      { kind: "source_range", ref: "02_media/source_a.mp4#t=4.2,6.8" },
    ], dir, identity);
    expect(invalid).toHaveLength(0);
    expect(verified).toHaveLength(2);
    expect(contextual.map((item) => item.ref)).toEqual([
      "03_analysis/segments.json#seg_0010",
      "02_media/source_a.mp4#t=4.2,6.8",
    ]);
  });

  it("rejects fabricated artifacts that are not on the canonical allowlist", () => {
    const { dir, identity } = makeEvidenceProject();
    const { invalid } = validateSourceEvidenceRefs([
      { kind: "artifact_ref", ref: "03_analysis/nonexistent-artifact.json" },
      { kind: "artifact_ref", ref: "notes/scratch.txt" },
    ], dir, identity);
    expect(invalid).toHaveLength(2);
    expect(invalid[0].reason).toContain("canonical artifact allowlist");
    expect(invalid[1].reason).toContain("canonical artifact allowlist");
  });

  it("rejects foreign paths: absolute, escaping, and symlinked", () => {
    const { dir, identity } = makeEvidenceProject();
    const { invalid } = validateSourceEvidenceRefs([
      { kind: "artifact_ref", ref: "/etc/passwd" },
      { kind: "artifact_ref", ref: "../outside/secret.txt" },
      { kind: "artifact_ref", ref: "01_intent/../../etc/passwd" },
    ], dir, identity);
    expect(invalid).toHaveLength(3);
    expect(invalid[0].reason).toContain("absolute path");
    expect(invalid[1].reason).toContain("escapes the project");
    expect(invalid[2].reason).toContain("escapes the project");
  });

  it("rejects symlinks even when they point inside the project (lstat)", () => {
    const { dir, identity } = makeEvidenceProject();
    // Replace the tracked brief with a symlink to another in-project file.
    fs.rmSync(path.join(dir, "01_intent/creative_brief.yaml"));
    fs.symlinkSync(
      path.join(dir, "03_analysis/segments.json"),
      path.join(dir, "01_intent/creative_brief.yaml"),
    );
    const { invalid } = validateSourceEvidenceRefs([
      { kind: "artifact_ref", ref: "01_intent/creative_brief.yaml" },
    ], dir, identity);
    expect(invalid).toHaveLength(1);
    expect(invalid[0].reason).toContain("symlinked evidence is not allowed");
  });

  it("rejects refs whose resolved target leaves the project through symlinked directories", () => {
    const { dir, identity } = makeEvidenceProject();
    // 03_analysis becomes a symlink to a directory outside the project that
    // legitimately contains a segments.json: containment must fail on realpath.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-project-"));
    fs.writeFileSync(path.join(outside, "segments.json"), JSON.stringify({ items: [{ segment_id: "seg_0010" }] }));
    fs.rmSync(path.join(dir, "03_analysis"), { recursive: true });
    fs.symlinkSync(outside, path.join(dir, "03_analysis"));
    const { invalid } = validateSourceEvidenceRefs([
      { kind: "transcript_span", ref: "03_analysis/segments.json#seg_0010" },
    ], dir, identity);
    fs.rmSync(outside, { recursive: true, force: true });
    expect(invalid).toHaveLength(1);
    expect(invalid[0].reason).toContain("resolved target is outside the project");
  });

  it("rejects stale self-hashed copies via recorded project identity, not the declared hash", () => {
    const { dir, identity } = makeEvidenceProject();
    // Overwrite the tracked artifact AND declare a sha256 that matches the
    // overwritten file: the recorded project identity still exposes it.
    fs.writeFileSync(
      path.join(dir, "01_intent/creative_brief.yaml"),
      'version: "1"\nproject_id: attacker-project\n',
    );
    const selfHash = crypto.createHash("sha256")
      .update(fs.readFileSync(path.join(dir, "01_intent/creative_brief.yaml")))
      .digest("hex");
    const { invalid } = validateSourceEvidenceRefs([
      { kind: "artifact_ref", ref: "01_intent/creative_brief.yaml", sha256: selfHash },
    ], dir, identity);
    expect(invalid).toHaveLength(1);
    expect(invalid[0].reason).toContain("artifact identity mismatch");
  });

  it("rejects declared sha256 mismatches on verified tracked artifacts", () => {
    const { dir, identity } = makeEvidenceProject();
    const { invalid } = validateSourceEvidenceRefs([
      { kind: "artifact_ref", ref: "01_intent/creative_brief.yaml", sha256: BRIEF_SHA256 },
    ], dir, identity);
    expect(invalid).toHaveLength(1);
    expect(invalid[0].reason).toContain("sha256 mismatch");
  });

  it("requires exact fragment id equality, never substring (seg_001 vs seg_0010)", () => {
    const { dir, identity } = makeEvidenceProject();
    const result = validateSourceEvidenceRefs([
      { kind: "transcript_span", ref: "03_analysis/segments.json#seg_001" },
      { kind: "transcript_span", ref: "03_analysis/segments.json#seg_0010" },
    ], dir, identity);
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0].ref).toContain("#seg_001");
    expect(result.invalid[0].reason).toContain("not exactly bound");
    expect(result.contextual).toHaveLength(1);
    expect(result.contextual[0].ref).toContain("#seg_0010");
  });

  it("rejects fragments on artifacts without machine-readable ids", () => {
    const { dir, identity } = makeEvidenceProject();
    const { invalid } = validateSourceEvidenceRefs([
      { kind: "artifact_ref", ref: "01_intent/creative_brief.yaml#no_ids_in_yaml_without_id_keys" },
    ], dir, identity);
    expect(invalid).toHaveLength(1);
    expect(invalid[0].reason).toContain("not exactly bound");
  });

  it("rejects non-time fragments on media evidence", () => {
    const { dir, identity } = makeEvidenceProject();
    const { invalid } = validateSourceEvidenceRefs([
      { kind: "source_range", ref: "02_media/source_a.mp4#seg_0010" },
    ], dir, identity);
    expect(invalid).toHaveLength(1);
    expect(invalid[0].reason).toContain("time ranges");
  });

  it("validates media fragments by kind: frame indexes stay valid while ranges stay time-bound", () => {
    const { dir, identity } = makeEvidenceProject();
    const result = validateSourceEvidenceRefs([
      { kind: "frame", ref: "02_media/source_a.mp4#frame=12" },
      { kind: "source_range", ref: "02_media/source_a.mp4#t=4.2,6.8" },
      { kind: "frame", ref: "02_media/source_a.mp4#t=4.2,6.8" },
      { kind: "source_range", ref: "02_media/source_a.mp4#frame=12" },
    ], dir, identity);
    expect(result.invalid).toHaveLength(2);
    expect(result.invalid.map((item) => item.ref)).toEqual([
      "02_media/source_a.mp4#t=4.2,6.8",
      "02_media/source_a.mp4#frame=12",
    ]);
    expect(result.contextual.map((item) => item.ref)).toEqual([
      "02_media/source_a.mp4#frame=12",
      "02_media/source_a.mp4#t=4.2,6.8",
    ]);
  });
});

// ── Runtime judgment integrity ────────────────────────────────────

describe("review judgment integrity (Issue #32 M0 runtime contract)", () => {
  it("demotes judgments that conflate observation, inference, and editorial intent", () => {
    const { dir, identity } = makeEvidenceProject();
    const report = buildReport({
      editorial_judgments: [
        buildJudgment({
          observation: "The subject moves toward the camera while the narration mentions a departure.",
          inference: "The subject moves toward the camera while the narration mentions a departure.",
          confidence: 0.85,
          confidence_basis: "measured",
        }),
      ],
    });

    enforceReviewJudgmentIntegrity(report, dir, identity);

    const judgment = report.editorial_judgments![0];
    expect(judgment.confidence).toBeLessThanOrEqual(UNSUPPORTED_CONFIDENCE_CEILING);
    expect(judgment.confidence_basis).toBe("unmeasured");
    expect(report.warnings.some((item) => item.summary.includes("conflates observation, inference"))).toBe(true);
    expect(report.fatal_issues).toHaveLength(0);
  });

  it("blocks approval when high-impact uncertainty has no clarification question", () => {
    const { dir, identity } = makeEvidenceProject();
    const report = buildReport({
      editorial_judgments: [
        buildJudgment({
          uncertainty: {
            description: "Whether the walking subject is the protagonist is unconfirmed.",
            impact: "high",
          },
        }),
      ],
    });

    enforceReviewJudgmentIntegrity(report, dir, identity);

    expect(report.fatal_issues).toHaveLength(1);
    expect(report.fatal_issues[0].summary).toContain("high-impact uncertainty without an actionable clarification question");
    expect(report.fatal_issues[0].evidence).toContain("Whether the walking subject is the protagonist is unconfirmed.");
    expect(report.editorial_judgments![0].confidence_basis).toBe("unmeasured");
  });

  it("blocks approval when a clarification question lacks observation or hypothesis", () => {
    const { dir, identity } = makeEvidenceProject();
    const report = buildReport({
      editorial_judgments: [
        buildJudgment({
          uncertainty: {
            description: "Whether the walking subject is the protagonist is unconfirmed.",
            impact: "high",
            clarification_question: {
              question: "May I use this subject as the protagonist?",
              observation: "",
              hypothesis: "The subject is the protagonist.",
            },
          },
        }),
        buildJudgment({
          uncertainty: {
            description: "Whether the closing gesture reads as farewell.",
            impact: "high",
            clarification_question: {
              question: "Does the closing gesture read as farewell?",
              observation: "The subject raises one hand as the shot ends.",
              hypothesis: "",
            },
          },
        }),
      ],
    });

    enforceReviewJudgmentIntegrity(report, dir, identity);

    expect(report.fatal_issues).toHaveLength(2);
  });

  it("keeps low-impact uncertainty non-blocking", () => {
    const { dir, identity } = makeEvidenceProject();
    const report = buildReport({
      editorial_judgments: [
        buildJudgment({
          uncertainty: {
            description: "Whether a tighter crop would read better.",
            impact: "low",
          },
        }),
      ],
    });

    enforceReviewJudgmentIntegrity(report, dir, identity);

    expect(report.fatal_issues).toHaveLength(0);
    expect(report.warnings).toHaveLength(0);
  });

  it("accepts high-impact uncertainty backed by a full observation-and-hypothesis question", () => {
    const { dir, identity } = makeEvidenceProject();
    const report = buildReport({
      editorial_judgments: [
        buildJudgment({
          uncertainty: {
            description: "Whether the walking subject is the protagonist is unconfirmed.",
            impact: "high",
            clarification_question: {
              question: "This subject wears a dark jacket with no visible face detail. May this segment be used as the protagonist's establishing shot?",
              observation: "A person in a dark jacket walks toward the camera; the face is not identifiable.",
              hypothesis: "This person is the protagonist the brief centers on.",
            },
          },
        }),
      ],
    });

    enforceReviewJudgmentIntegrity(report, dir, identity);

    expect(report.fatal_issues).toHaveLength(0);
    expect(report.warnings).toHaveLength(0);
  });

  it("demotes measured claims resting on fabricated, foreign, or stale evidence", () => {
    const { dir, identity } = makeEvidenceProject();
    const report = buildReport({
      editorial_judgments: [
        buildJudgment({
          confidence: 0.9,
          evidence: [{ kind: "artifact_ref", ref: "03_analysis/nonexistent-artifact.json" }],
        }),
        buildJudgment({
          confidence: 0.9,
          evidence: [{ kind: "artifact_ref", ref: "../outside/secret.txt" }],
        }),
        buildJudgment({
          confidence: 0.9,
          evidence: [{ kind: "artifact_ref", ref: "01_intent/creative_brief.yaml", sha256: BRIEF_SHA256 }],
        }),
      ],
    });

    enforceReviewJudgmentIntegrity(report, dir, identity);

    for (const judgment of report.editorial_judgments!) {
      expect(judgment.confidence).toBeLessThanOrEqual(DEGRADED_CONFIDENCE_CEILING);
      expect(judgment.confidence_basis).toBe("unmeasured");
    }
    expect(report.warnings.some((item) => item.summary.includes("could not be verified in the project"))).toBe(true);
    expect(report.fatal_issues).toHaveLength(0);
  });

  it("demotes measured claims that rest on context-only (untracked identity) evidence", () => {
    const { dir, identity } = makeEvidenceProject();
    const report = buildReport({
      editorial_judgments: [
        buildJudgment({
          confidence: 0.85,
          evidence: [{ kind: "transcript_span", ref: "03_analysis/segments.json#seg_0010" }],
        }),
      ],
    });

    enforceReviewJudgmentIntegrity(report, dir, identity);

    const judgment = report.editorial_judgments![0];
    expect(judgment.confidence).toBeLessThanOrEqual(DEGRADED_CONFIDENCE_CEILING);
    expect(judgment.confidence_basis).toBe("degraded");
    expect(report.warnings.some((item) => item.summary.includes("not bound to recorded project artifact identity"))).toBe(true);
    expect(report.fatal_issues).toHaveLength(0);
  });

  it("caps degraded and unmeasured claims at 0.5, even 0.99, and keeps 0.70 boundary high-confidence", () => {
    const { dir, identity } = makeEvidenceProject();
    const report = buildReport({
      editorial_judgments: [
        buildJudgment({
          confidence: 0.99,
          confidence_basis: "degraded",
          evidence: [{ kind: "artifact_ref", ref: "01_intent/creative_brief.yaml" }],
        }),
        buildJudgment({
          confidence: HIGH_CONFIDENCE_THRESHOLD,
          confidence_basis: "measured",
          evidence: [{ kind: "artifact_ref", ref: "01_intent/creative_brief.yaml" }],
        }),
        buildJudgment({
          confidence: 0.75,
          confidence_basis: "measured",
          evidence: [],
        }),
      ],
    });

    enforceReviewJudgmentIntegrity(report, dir, identity);

    expect(report.editorial_judgments![0].confidence).toBe(DEGRADED_CONFIDENCE_CEILING);
    expect(report.editorial_judgments![1].confidence).toBe(HIGH_CONFIDENCE_THRESHOLD);
    expect(report.editorial_judgments![1].confidence_basis).toBe("measured");
    expect(report.editorial_judgments![2].confidence).toBeLessThanOrEqual(UNSUPPORTED_CONFIDENCE_CEILING);
    expect(report.editorial_judgments![2].confidence_basis).toBe("unmeasured");
  });

  it("drops alternatives that lack grounds or risks and keeps grounded ones", () => {
    const { dir, identity } = makeEvidenceProject();
    const report = buildReport({
      editorial_judgments: [
        buildJudgment({
          alternatives: [
            {
              description: "Hold the wide shot longer.",
              grounds: ["The wide frame keeps both subjects visible."],
              risks: ["Slows the opening pace."],
            },
            {
              description: "Cut to the close-up earlier.",
              grounds: [],
              risks: ["Loses the establishing geography."],
            },
            {
              description: "Drop the insert shot entirely.",
              grounds: ["Shortens the runtime."],
              risks: [],
            },
          ],
        }),
      ],
    });

    enforceReviewJudgmentIntegrity(report, dir, identity);

    expect(report.editorial_judgments![0].alternatives).toHaveLength(1);
    expect(report.editorial_judgments![0].alternatives![0].description).toBe("Hold the wide shot longer.");
    expect(report.warnings.some((item) => item.summary.includes("without grounds and risks"))).toBe(true);
    expect(report.fatal_issues).toHaveLength(0);
  });

  it("caps summary confidence at 0.5 without verified evidence, even at 0.70", () => {
    for (const confidence of [0.9, 0.75, HIGH_CONFIDENCE_THRESHOLD]) {
      const { dir, identity } = makeEvidenceProject();
      const report = buildReport({
        summary_judgment: {
          status: "needs_revision",
          rationale: "Fixture baseline.",
          confidence,
        },
        editorial_judgments: [
          buildJudgment({ confidence_basis: "degraded", confidence: 0.4 }),
        ],
      });

      enforceReviewJudgmentIntegrity(report, dir, identity);

      expect(report.summary_judgment.confidence).toBe(DEGRADED_CONFIDENCE_CEILING);
      expect(report.summary_judgment.rationale).toContain("Summary confidence capped at 0.50");
    }
  });

  it("lets summary confidence rise only on identity-verified measured judgments", () => {
    const { dir, identity } = makeEvidenceProject();
    const verified = buildReport({
      summary_judgment: {
        status: "needs_revision",
        rationale: "Fixture baseline.",
        confidence: 0.9,
      },
    });
    enforceReviewJudgmentIntegrity(verified, dir, identity);
    expect(verified.summary_judgment.confidence).toBe(0.9);

    const contextOnly = buildReport({
      summary_judgment: {
        status: "needs_revision",
        rationale: "Fixture baseline.",
        confidence: 0.9,
      },
      editorial_judgments: [
        buildJudgment({
          confidence: 0.85,
          evidence: [{ kind: "transcript_span", ref: "03_analysis/segments.json#seg_0010" }],
        }),
      ],
    });
    enforceReviewJudgmentIntegrity(contextOnly, dir, identity);
    expect(contextOnly.summary_judgment.confidence).toBe(DEGRADED_CONFIDENCE_CEILING);
  });

  it("never allows high summary confidence on an explicitly unmeasured basis", () => {
    const { dir, identity } = makeEvidenceProject();
    const report = buildReport({
      summary_judgment: {
        status: "needs_revision",
        rationale: "Fixture baseline.",
        confidence: 0.95,
        confidence_basis: "unmeasured",
      },
      visual_qa: {
        status: "verified",
        min_score: 80,
        issues: { total: 0, critical: 0, warning: 0, info: 0 },
        issue_summaries: [],
      },
    });

    enforceReviewJudgmentIntegrity(report, dir, identity);

    expect(report.summary_judgment.confidence).toBe(DEGRADED_CONFIDENCE_CEILING);
    expect(report.summary_judgment.confidence_basis).toBe("unmeasured");
  });

  it("leaves a fully compliant judgment envelope untouched", () => {
    const { dir, identity } = makeEvidenceProject();
    const judgment = buildJudgment({
      confidence: 0.85,
      uncertainty: {
        description: "Whether the walking subject is the protagonist is unconfirmed.",
        impact: "high",
        clarification_question: {
          question: "The subject's face is not identifiable. May this segment be used as the protagonist's establishing shot?",
          observation: "A person in a dark jacket walks toward the camera; the face is not identifiable.",
          hypothesis: "This person is the protagonist the brief centers on.",
        },
      },
      alternatives: [
        {
          label: "Wider coverage",
          description: "Use the wider take instead.",
          grounds: ["The wider take keeps the subject identifiable."],
          risks: ["Weakens the intimate tone requested by the brief."],
        },
      ],
    });
    const report = buildReport({ editorial_judgments: [judgment] });
    const before = JSON.parse(JSON.stringify(report));

    enforceReviewJudgmentIntegrity(report, dir, identity);

    expect(report).toEqual(before);
  });
});

// ── Public runReview hostile contract ─────────────────────────────

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(srcPath, destPath);
    else fs.copyFileSync(srcPath, destPath);
  }
}

// Fixture projects must live inside the repo so runReview's preflight can
// resolve the repo root (directory containing schemas/) by walking up.
const hostileFixtureDirs: string[] = [];

function makeReviewReadyProject(name: string): string {
  const tmpDir = path.resolve(`test-fixtures-review-hostile-${name}-${Date.now()}-${hostileFixtureDirs.length}`);
  hostileFixtureDirs.push(tmpDir);
  copyDirSync(path.resolve("projects/sample"), tmpDir);
  // Seed the persisted artifact identity the way a real reconcile does.
  writeProjectState(tmpDir, {
    version: 1,
    project_id: "sample-mountain-reset",
    current_state: "blueprint_ready",
    history: [],
    artifact_hashes: snapshotArtifacts(tmpDir).hashes,
  });
  return tmpDir;
}

afterAll(() => {
  for (const dir of hostileFixtureDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The agent output is passed through exactly as produced: the canonical
// identity gate must judge untrusted reports, never pre-sanitized ones.
function hostileAgent(report: ReviewReport): ReviewAgent {
  return {
    async run() {
      return {
        report,
        patch: { timeline_version: report.timeline_version, operations: [] },
      };
    },
  };
}

const FIXTURE_PROJECT_ID = "sample-mountain-reset";
const FIXTURE_TIMELINE_VERSION = "1";

function validIdentityReport(overrides: Partial<ReviewReport> = {}): ReviewReport {
  return buildReport({
    project_id: FIXTURE_PROJECT_ID,
    timeline_version: FIXTURE_TIMELINE_VERSION,
    ...overrides,
  });
}

function hostileJudgment(overrides: Partial<EditorialJudgment> = {}): EditorialJudgment {
  return buildJudgment({
    observation: "The opening beat holds a wide view before the subject enters the frame.",
    inference: "The delay before the subject appears weakens the opening engagement.",
    editorial_intent: "Trim the opening so the subject arrives earlier in the hook.",
    evidence: [{ kind: "artifact_ref", ref: "01_intent/creative_brief.yaml" }],
    confidence: 0.6,
    ...overrides,
  });
}

describe("public runReview canonical gate (Issue #32 M0 audit amendment)", () => {
  it("rejects report roots backed by a prototype, accessor, or proxy", () => {
    const identity = {
      project_id: FIXTURE_PROJECT_ID,
      timeline_version: FIXTURE_TIMELINE_VERSION,
    };
    const inherited = Object.create(validIdentityReport()) as ReviewReport;
    const accessor = validIdentityReport();
    Object.defineProperty(accessor, "project_id", {
      enumerable: true,
      configurable: true,
      get: () => FIXTURE_PROJECT_ID,
    });
    const proxied = new Proxy(validIdentityReport(), {});

    for (const hostile of [inherited, accessor, proxied]) {
      expect(() => enforceCanonicalReviewReportGate(hostile, identity)).toThrow(/plain own-property data/);
      expect(migrateReviewReport(hostile, identity)).toBeNull();
    }
  });

  it("rejects an inherited report root before canonical promotion", async () => {
    const tmpDir = makeReviewReadyProject("inherited-report-root");
    const reportPath = path.join(tmpDir, "06_review/review_report.yaml");
    const before = fs.readFileSync(reportPath, "utf-8");
    const inherited = Object.create(validIdentityReport()) as ReviewReport;

    const result = await runReview(tmpDir, hostileAgent(inherited), { createdAt: "2026-03-21T05:00:00Z" });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("VALIDATION_FAILED");
    expect(result.error?.message).toContain("plain own-property data");
    expect(fs.readFileSync(reportPath, "utf-8")).toBe(before);
  });

  it("reparses serialized report bytes and reapplies the v2 gate before promotion", async () => {
    const tmpDir = makeReviewReadyProject("serialized-report-gate");
    const reportPath = path.join(tmpDir, "06_review/review_report.yaml");
    const before = fs.readFileSync(reportPath, "utf-8");
    let tampered = false;
    vi.mocked(fs.writeFileSync).mockImplementation(((file, data, options) => {
      realFs().writeFileSync(file, data, options);
      if (!tampered && String(file).includes("06_review/review_report.draft-")) {
        tampered = true;
        const reparsed = parseYaml(realFs().readFileSync(String(file), "utf-8")) as Record<string, unknown>;
        reparsed.project_id = "foreign-project";
        realFs().writeFileSync(String(file), stringifyYaml(reparsed), "utf-8");
      }
    }) as typeof fs.writeFileSync);

    const result = await runReview(
      tmpDir,
      hostileAgent(validIdentityReport()),
      { createdAt: "2026-03-21T05:00:00Z" },
    );

    expect(tampered).toBe(true);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("VALIDATION_FAILED");
    expect(result.error?.message).toContain("project_id");
    expect(fs.readFileSync(reportPath, "utf-8")).toBe(before);
  });

  it("rejects a report without editorial_judgments", async () => {
    const tmpDir = makeReviewReadyProject("missing-judgments");
    const report = validIdentityReport();
    delete (report as unknown as Record<string, unknown>).editorial_judgments;

    const result = await runReview(tmpDir, hostileAgent(report), { createdAt: "2026-03-21T05:00:00Z" });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("VALIDATION_FAILED");
    expect(result.error?.message).toContain("editorial_judgments");
    // The legacy sample report must remain untouched: nothing was promoted.
    const promoted = parseYaml(
      fs.readFileSync(path.join(tmpDir, "06_review/review_report.yaml"), "utf-8"),
    ) as ReviewReport;
    expect(promoted.version).not.toBe("2");
  });

  it("rejects a report with an empty editorial_judgments array", async () => {
    const tmpDir = makeReviewReadyProject("empty-judgments");
    const result = await runReview(tmpDir, hostileAgent(validIdentityReport({ editorial_judgments: [] })), {
      createdAt: "2026-03-21T05:00:00Z",
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("VALIDATION_FAILED");
    const promoted = parseYaml(
      fs.readFileSync(path.join(tmpDir, "06_review/review_report.yaml"), "utf-8"),
    ) as ReviewReport;
    expect(promoted.version).not.toBe("2");
  });

  it("promotes compliant reports as canonical version 2 with identity-verified judgments", async () => {
    const tmpDir = makeReviewReadyProject("canonical-v2");
    const result = await runReview(tmpDir, hostileAgent(validIdentityReport()), {
      createdAt: "2026-03-21T05:00:00Z",
    });

    expect(result.success).toBe(true);
    expect(result.report?.version).toBe("2");
    const judgment = result.report!.editorial_judgments![0];
    expect(judgment.confidence_basis).toBe("measured");
    const promoted = parseYaml(
      fs.readFileSync(path.join(tmpDir, "06_review/review_report.yaml"), "utf-8"),
    ) as ReviewReport;
    expect(promoted.version).toBe("2");
    expect(promoted.editorial_judgments?.length).toBeGreaterThan(0);
  });

  it("demotes judgments with fabricated artifact evidence instead of trusting them", async () => {
    const tmpDir = makeReviewReadyProject("fabricated");
    const result = await runReview(
      tmpDir,
      hostileAgent(validIdentityReport({
        editorial_judgments: [
          hostileJudgment({
            confidence: 0.9,
            evidence: [{ kind: "artifact_ref", ref: "03_analysis/nonexistent-artifact.json" }],
          }),
        ],
      })),
      { createdAt: "2026-03-21T05:00:00Z" },
    );

    expect(result.success).toBe(true);
    const judgment = result.report!.editorial_judgments![0];
    expect(judgment.confidence).toBeLessThanOrEqual(DEGRADED_CONFIDENCE_CEILING);
    expect(judgment.confidence_basis).toBe("unmeasured");
    expect(result.report!.warnings.some((item) => item.summary.includes("could not be verified in the project"))).toBe(true);
    expect(result.report!.warnings.flatMap((item) => item.evidence ?? []).some((item) => item.includes("canonical artifact allowlist"))).toBe(true);
  });

  it("demotes foreign and hash-mismatched (stale) evidence through runReview", async () => {
    const tmpDir = makeReviewReadyProject("foreign-stale");
    const result = await runReview(
      tmpDir,
      hostileAgent(validIdentityReport({
        editorial_judgments: [
          hostileJudgment({
            confidence: 0.9,
            evidence: [{ kind: "artifact_ref", ref: "notes/scratch.txt" }],
          }),
          hostileJudgment({
            confidence: 0.9,
            evidence: [{ kind: "artifact_ref", ref: "01_intent/creative_brief.yaml", sha256: BRIEF_SHA256 }],
          }),
        ],
      })),
      { createdAt: "2026-03-21T05:00:00Z" },
    );

    expect(result.success).toBe(true);
    const [foreign, stale] = result.report!.editorial_judgments!;
    expect(foreign.confidence).toBeLessThanOrEqual(DEGRADED_CONFIDENCE_CEILING);
    expect(foreign.confidence_basis).toBe("unmeasured");
    expect(stale.confidence).toBeLessThanOrEqual(DEGRADED_CONFIDENCE_CEILING);
    expect(stale.confidence_basis).toBe("unmeasured");
    const joined = result.report!.warnings
      .map((item) => `${item.summary} ${item.details ?? ""} ${(item.evidence ?? []).join(" ")}`)
      .join(" ");
    expect(joined).toContain("canonical artifact allowlist");
    expect(joined).toContain("sha256 mismatch");
  });

  it("fails closed when a tracked artifact was overwritten before review (stale self-hashed copy)", async () => {
    const tmpDir = makeReviewReadyProject("self-hashed-stale");
    // Overwrite the tracked artifact after identity snapshot, and declare a
    // sha256 consistent with the overwritten file. Reconcile detects the
    // identity mismatch and blocks the review before any promotion.
    fs.writeFileSync(
      path.join(tmpDir, "01_intent/creative_brief.yaml"),
      'version: "1"\nproject_id: attacker-project\n',
    );
    const selfHash = crypto.createHash("sha256")
      .update(fs.readFileSync(path.join(tmpDir, "01_intent/creative_brief.yaml")))
      .digest("hex");
    const result = await runReview(
      tmpDir,
      hostileAgent(buildReport({
        editorial_judgments: [
          hostileJudgment({
            confidence: 0.9,
            evidence: [{ kind: "artifact_ref", ref: "01_intent/creative_brief.yaml", sha256: selfHash }],
          }),
        ],
      })),
      { createdAt: "2026-03-21T05:00:00Z" },
    );

    // Fail closed: no canonical version 2 report may be promoted from a
    // project whose recorded artifact identity no longer matches the files.
    expect(result.success).toBe(false);
    const promoted = parseYaml(
      fs.readFileSync(path.join(tmpDir, "06_review/review_report.yaml"), "utf-8"),
    ) as ReviewReport;
    expect(promoted.version).not.toBe("2");
  });

  it("rejects a report with a foreign project_id and fails closed without promotion", async () => {
    const tmpDir = makeReviewReadyProject("foreign-project-id");
    const result = await runReview(
      tmpDir,
      hostileAgent(validIdentityReport({ project_id: "attacker-project" })),
      { createdAt: "2026-03-21T05:00:00Z" },
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("VALIDATION_FAILED");
    expect(result.error?.message).toContain("project_id");
    const promoted = parseYaml(
      fs.readFileSync(path.join(tmpDir, "06_review/review_report.yaml"), "utf-8"),
    ) as ReviewReport;
    expect(promoted.version).not.toBe("2");
  });

  it("rejects a report with a missing project_id", async () => {
    const tmpDir = makeReviewReadyProject("missing-project-id");
    const result = await runReview(
      tmpDir,
      hostileAgent(validIdentityReport({ project_id: "" })),
      { createdAt: "2026-03-21T05:00:00Z" },
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("VALIDATION_FAILED");
    const promoted = parseYaml(
      fs.readFileSync(path.join(tmpDir, "06_review/review_report.yaml"), "utf-8"),
    ) as ReviewReport;
    expect(promoted.version).not.toBe("2");
  });

  it("rejects a report with a foreign timeline_version", async () => {
    const tmpDir = makeReviewReadyProject("foreign-timeline-version");
    const result = await runReview(
      tmpDir,
      hostileAgent(validIdentityReport({ timeline_version: "999" })),
      { createdAt: "2026-03-21T05:00:00Z" },
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("VALIDATION_FAILED");
    expect(result.error?.message).toContain("timeline_version");
    const promoted = parseYaml(
      fs.readFileSync(path.join(tmpDir, "06_review/review_report.yaml"), "utf-8"),
    ) as ReviewReport;
    expect(promoted.version).not.toBe("2");
  });

  it("rejects a report claiming a stale timeline version", async () => {
    const tmpDir = makeReviewReadyProject("stale-timeline");
    const result = await runReview(
      tmpDir,
      hostileAgent(validIdentityReport({ timeline_version: "0" })),
      { createdAt: "2026-03-21T05:00:00Z" },
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("VALIDATION_FAILED");
    expect(result.error?.message).toContain("timeline_version");
  });

  it("caps provider-absent summary confidence at 0.5 for 0.90, 0.75, and 0.70", async () => {
    for (const confidence of [0.9, 0.75, HIGH_CONFIDENCE_THRESHOLD]) {
      const tmpDir = makeReviewReadyProject(`provider-absent-${confidence}`);
      const result = await runReview(
        tmpDir,
        hostileAgent(validIdentityReport({
          summary_judgment: {
            status: "needs_revision",
            rationale: "Fixture baseline.",
            confidence,
          },
          editorial_judgments: [
            hostileJudgment({ confidence_basis: "degraded", confidence: 0.4 }),
          ],
        })),
        { createdAt: "2026-03-21T05:00:00Z" },
      );

      expect(result.success).toBe(true);
      expect(result.report!.summary_judgment.confidence).toBe(DEGRADED_CONFIDENCE_CEILING);
      expect(result.report!.summary_judgment.rationale).toContain("Summary confidence capped at 0.50");
    }
  });
});

// ── Schema contract ───────────────────────────────────────────────

describe("review-report schema judgment envelope (Issue #32 M0 schema contract)", () => {
  const validate = createValidator("review-report.schema.json");

  function schemaReport(judgments: unknown[] | undefined, version = "2"): Record<string, unknown> {
    const report: Record<string, unknown> = {
      version,
      project_id: "fixture-project",
      timeline_version: "timeline-fixture-1",
      summary_judgment: { status: "needs_revision", rationale: "Fixture baseline." },
      strengths: [],
      weaknesses: [],
      fatal_issues: [],
      warnings: [],
      mismatches_to_brief: [],
      mismatches_to_blueprint: [],
      recommended_next_pass: { goal: "Fixture goal.", actions: ["Fixture action."] },
    };
    if (judgments !== undefined) report.editorial_judgments = judgments;
    return report;
  }

  const canonicalJudgment = {
    observation: "A person in a dark jacket walks toward the camera.",
    inference: "This person is likely the protagonist.",
    editorial_intent: "Establish the protagonist early.",
    evidence: [{ kind: "source_range", ref: "02_media/source_a.mp4#t=4.2,6.8" }],
    confidence: 0.6,
    confidence_basis: "measured",
  };

  it("accepts a version 2 report with a well-formed judgment envelope", () => {
    expect(validate(schemaReport([
      {
        ...canonicalJudgment,
        uncertainty: {
          description: "Protagonist identity is unconfirmed.",
          impact: "high",
          clarification_question: {
            question: "May this subject be used as the protagonist?",
            observation: "The face is not identifiable in this segment.",
            hypothesis: "This person is the protagonist.",
          },
        },
        alternatives: [
          { description: "Use the wider take.", grounds: ["Keeps the subject identifiable."], risks: ["Weakens the intimate tone."] },
        ],
      },
    ]))).toBe(true);
  });

  it("rejects version 2 without the judgment envelope or with an empty one", () => {
    expect(validate(schemaReport(undefined))).toBe(false);
    expect(validate(schemaReport([]))).toBe(false);
  });

  it("keeps the explicit legacy path: version 1 without judgments still validates", () => {
    expect(validate(schemaReport(undefined, "1"))).toBe(true);
  });

  it("restricts version to supported values (unknown versions rejected)", () => {
    expect(validate(schemaReport(undefined, "3"))).toBe(false);
    expect(validate(schemaReport(undefined, "0"))).toBe(false);
  });

  it("encodes degraded/unmeasured confidence max 0.5 for judgments and summary", () => {
    expect(validate(schemaReport([
      { ...canonicalJudgment, confidence: 0.99, confidence_basis: "degraded" },
    ]))).toBe(false);
    expect(validate(schemaReport([
      { ...canonicalJudgment, confidence: 0.99, confidence_basis: "unmeasured" },
    ]))).toBe(false);
    expect(validate(schemaReport([
      { ...canonicalJudgment, confidence: 0.5, confidence_basis: "degraded" },
    ]))).toBe(true);
    const summaryCapped = schemaReport([canonicalJudgment]);
    summaryCapped.summary_judgment = {
      status: "needs_revision",
      rationale: "Fixture baseline.",
      confidence: 0.99,
      confidence_basis: "unmeasured",
    };
    expect(validate(summaryCapped)).toBe(false);
  });

  it("rejects high-impact uncertainty without a clarification question", () => {
    expect(validate(schemaReport([
      { ...canonicalJudgment, uncertainty: { description: "Protagonist identity is unconfirmed.", impact: "high" } },
    ]))).toBe(false);
  });

  it("rejects a clarification question without observation or hypothesis", () => {
    expect(validate(schemaReport([
      {
        ...canonicalJudgment,
        uncertainty: {
          description: "Protagonist identity is unconfirmed.",
          impact: "high",
          clarification_question: { question: "May this subject be used as the protagonist?" },
        },
      },
    ]))).toBe(false);
  });

  it("accepts low-impact uncertainty without a clarification question", () => {
    expect(validate(schemaReport([
      { ...canonicalJudgment, uncertainty: { description: "Crop choice is cosmetic.", impact: "low" } },
    ]))).toBe(true);
  });

  it("rejects alternatives without grounds or risks", () => {
    expect(validate(schemaReport([
      { ...canonicalJudgment, alternatives: [{ description: "Use the wider take.", grounds: [], risks: ["Weaker tone."] }] },
    ]))).toBe(false);
    expect(validate(schemaReport([
      { ...canonicalJudgment, alternatives: [{ description: "Use the wider take.", grounds: ["Identifiable."], risks: [] }] },
    ]))).toBe(false);
  });

  it("rejects judgments missing the separated fields or evidence", () => {
    expect(validate(schemaReport([
      {
        observation: "A person walks toward the camera.",
        inference: "This person is likely the protagonist.",
        evidence: [{ kind: "source_range", ref: "02_media/source_a.mp4#t=4.2,6.8" }],
        confidence: 0.6,
        confidence_basis: "measured",
      },
    ]))).toBe(false);
    expect(validate(schemaReport([
      {
        ...canonicalJudgment,
        evidence: [],
      },
    ]))).toBe(false);
    expect(validate(schemaReport([
      { ...canonicalJudgment, confidence_basis: "high" },
    ]))).toBe(false);
  });

  it("rejects evidence entries without a kind or ref and malformed sha256", () => {
    expect(validate(schemaReport([
      { ...canonicalJudgment, evidence: [{ ref: "02_media/source_a.mp4" }] },
    ]))).toBe(false);
    expect(validate(schemaReport([
      { ...canonicalJudgment, evidence: [{ kind: "source_range" }] },
    ]))).toBe(false);
    expect(validate(schemaReport([
      { ...canonicalJudgment, evidence: [{ kind: "artifact_ref", ref: "x", sha256: "abc123" }] },
    ]))).toBe(false);
  });

  it("requires each evidence kind to use its matching reference grammar", () => {
    expect(validate(schemaReport([
      {
        ...canonicalJudgment,
        evidence: [{ kind: "frame", ref: "05_timeline/timeline.json#CLP_0001" }],
      },
    ]))).toBe(false);
    expect(validate(schemaReport([
      {
        ...canonicalJudgment,
        evidence: [{ kind: "frame", ref: "02_media/source_a.mp4#frame=12" }],
      },
    ]))).toBe(true);
    expect(validate(schemaReport([
      {
        ...canonicalJudgment,
        evidence: [{ kind: "transcript_span", ref: "03_analysis/segments.json#seg_0010" }],
      },
    ]))).toBe(true);
  });
});

// ── Legacy migration route (fail closed) ──────────────────────────

describe("explicit legacy migration route (fail closed)", () => {
  it("accepts only schema-valid explicit version 1 legacy reports", () => {
    const legacy = buildReport({ version: "1" });
    delete (legacy as unknown as Record<string, unknown>).editorial_judgments;
    const result = migrateReviewReport(legacy);
    expect(result).not.toBeNull();
    expect(result!.legacy).toBe(true);
    expect(result!.report.version).toBe("1");
    expect(result!.report.editorial_judgments).toBeUndefined();
  });

  it("accepts version 2 only when fully schema-valid including the nonempty envelope", () => {
    const canonical = buildReport();
    const result = migrateReviewReport(canonical);
    expect(result).not.toBeNull();
    expect(result!.legacy).toBe(false);
    expect(result!.report).toBe(canonical);

    const emptyEnvelope = migrateReviewReport(buildReport({ editorial_judgments: [] }));
    expect(emptyEnvelope).toBeNull();

    const missingRationale = buildReport();
    (missingRationale.summary_judgment as Record<string, unknown>).rationale = "";
    expect(migrateReviewReport(missingRationale)).toBeNull();
  });

  it("applies the authoritative identity gate to canonical v2 migration", () => {
    const identity = { project_id: "fixture-project", timeline_version: "timeline-fixture-1" };
    expect(migrateReviewReport(buildReport(), identity)).not.toBeNull();
    expect(migrateReviewReport(buildReport({ project_id: "attacker-project" }), identity)).toBeNull();
    expect(migrateReviewReport(buildReport({ timeline_version: "stale" }), identity)).toBeNull();

    const missingProjectId = buildReport();
    missingProjectId.project_id = "";
    expect(migrateReviewReport(missingProjectId, identity)).toBeNull();

    const missingTimeline = buildReport();
    missingTimeline.timeline_version = "";
    expect(migrateReviewReport(missingTimeline, identity)).toBeNull();

    // The identity gate applies to legacy reads too: a foreign v1 report is
    // not this project's artifact.
    const legacyForeign = buildReport({ version: "1", project_id: "attacker-project" });
    delete (legacyForeign as unknown as Record<string, unknown>).editorial_judgments;
    expect(migrateReviewReport(legacyForeign, identity)).toBeNull();
  });

  it("rejects unknown versions and empty or malformed objects", () => {
    expect(migrateReviewReport(buildReport({ version: "3" }))).toBeNull();
    expect(migrateReviewReport({})).toBeNull();
    expect(migrateReviewReport(null)).toBeNull();
    expect(migrateReviewReport("report")).toBeNull();
    expect(migrateReviewReport([1, 2])).toBeNull();
    const malformed = buildReport();
    (malformed as unknown as Record<string, unknown>).unexpected_field = true;
    expect(migrateReviewReport(malformed)).toBeNull();
  });
});


// ── Route equivalence: both canonical doors share one truth contract ──

function reentryMarkerDiff(): Record<string, unknown> {
  return {
    version: 1,
    project_id: "sample-mountain-reset",
    handoff_id: "HND_0001_20260321T100000Z",
    base_timeline_version: "1",
    capability_profile_id: "davinci_resolve_otio_v1",
    status: "clean",
    summary: { timeline_marker_add: 1 },
    operations: [
      {
        operation_id: "OP_001",
        type: "timeline_marker_add",
        target: { exchange_clip_id: "EXC_0001" },
        marker_frame: 12,
        marker_label: "route-equivalence",
      },
    ],
  };
}

function reentryAgentFor(report: ReviewReport) {
  return {
    applyCriticEvidence: async () => ({
      reviewReport: report,
      reviewPatch: { timeline_version: "1", operations: [] },
    }),
  };
}

function currentTimelineJudgment(overrides: Partial<EditorialJudgment> = {}): EditorialJudgment {
  return hostileJudgment({
    observation: "The compiled timeline holds the hook beat on the first video track.",
    inference: "The hook arrives late relative to the brief's opening intent.",
    editorial_intent: "Trim the opening beat so the hook lands earlier.",
    evidence: [{ kind: "artifact_ref", ref: "05_timeline/timeline.json#CLP_0001" }],
    confidence: 0.8,
    ...overrides,
  });
}

describe("route equivalence: runReview and executeRecompileLoop share one truth contract", () => {
  it("keeps canonical frame media evidence valid without overstating its measurement", async () => {
    const tmpDir = makeReviewReadyProject("route-frame-evidence");
    fs.mkdirSync(path.join(tmpDir, "02_media"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "02_media/source_a.mp4"), "fixture-media-bytes");
    const result = await runReview(
      tmpDir,
      hostileAgent(validIdentityReport({
        editorial_judgments: [hostileJudgment({
          evidence: [{ kind: "frame", ref: "02_media/source_a.mp4#frame=12" }],
          confidence: 0.8,
          confidence_basis: "measured",
        })],
      })),
      { createdAt: "2026-03-21T05:00:00Z" },
    );

    expect(result.success).toBe(true);
    const judgment = result.report!.editorial_judgments![0];
    // The frame grammar is valid and the source file is inside the project;
    // absent recorded media identity still correctly prevents measured
    // confidence under the provider-absence contract.
    expect(judgment.confidence_basis).toBe("degraded");
    expect(judgment.confidence).toBeLessThanOrEqual(DEGRADED_CONFIDENCE_CEILING);
    expect(result.report!.warnings.some((item) => item.summary.includes("not bound to recorded project artifact identity"))).toBe(true);
    expect(result.report!.warnings.some((item) => item.summary.includes("could not be verified"))).toBe(false);
  });

  it("demotes paraphrase-equivalent claims and kind-mismatched evidence on the public route", async () => {
    const tmpDir = makeReviewReadyProject("semantic-kind-mismatch");
    const result = await runReview(
      tmpDir,
      hostileAgent(validIdentityReport({
        editorial_judgments: [hostileJudgment({
          observation: "The identified person is the speaker.",
          inference: "The footage identifies the speaker.",
          editorial_intent: "Use the speaker as the opening subject.",
          evidence: [{ kind: "artifact_ref", ref: "02_media/nonexistent.mp4#frame=12" }],
          confidence: 0.9,
          confidence_basis: "measured",
        })],
      })),
      { createdAt: "2026-03-21T05:00:00Z" },
    );

    expect(result.success).toBe(true);
    const judgment = result.report!.editorial_judgments![0];
    expect(judgment.confidence).toBeLessThanOrEqual(DEGRADED_CONFIDENCE_CEILING);
    expect(judgment.confidence_basis).toBe("unmeasured");
    expect(result.report!.warnings.some((item) => item.summary.includes("conflates observation, inference"))).toBe(true);
    expect(result.report!.warnings.some((item) => item.summary.includes("could not be verified"))).toBe(true);
  });

  it("runReview normalizes conflated fields and never promotes unchanged", async () => {
    const tmpDir = makeReviewReadyProject("route-conflated");
    const result = await runReview(
      tmpDir,
      hostileAgent(validIdentityReport({
        editorial_judgments: [
          hostileJudgment({
            observation: "The hook beat and its interpretation are described the same way.",
            inference: "The hook beat and its interpretation are described the same way.",
            confidence: 0.9,
            confidence_basis: "measured",
          }),
        ],
      })),
      { createdAt: "2026-03-21T05:00:00Z" },
    );
    expect(result.success).toBe(true);
    const judgment = result.report!.editorial_judgments![0];
    expect(judgment.confidence).toBeLessThanOrEqual(DEGRADED_CONFIDENCE_CEILING);
    expect(judgment.confidence_basis).toBe("unmeasured");
    expect(result.report!.warnings.length).toBeGreaterThan(0);
  });

  it("runReview caps absolute (1.0) measured confidence and flags it", async () => {
    const tmpDir = makeReviewReadyProject("route-absolute");
    const result = await runReview(
      tmpDir,
      hostileAgent(validIdentityReport({
        editorial_judgments: [currentTimelineJudgment({ confidence: 1 })],
      })),
      { createdAt: "2026-03-21T05:00:00Z" },
    );
    expect(result.success).toBe(true);
    const judgment = result.report!.editorial_judgments![0];
    expect(judgment.confidence).toBe(0.99);
    expect(judgment.confidence_basis).toBe("measured");
    expect(result.report!.warnings.some((item) => item.summary.includes("absolute confidence"))).toBe(true);
  });

  it("runReview replaces forged agent-supplied visual QA and caps a forged summary", async () => {
    const tmpDir = makeReviewReadyProject("route-forged-visual");
    const report = validIdentityReport({
      summary_judgment: {
        status: "needs_revision",
        rationale: "Fixture baseline.",
        confidence: 0.95,
        confidence_basis: "measured",
      },
      editorial_judgments: [hostileJudgment({ confidence_basis: "degraded", confidence: 0.4 })],
    });
    // Forge provider-grade visual QA straight into the agent output.
    (report as unknown as Record<string, unknown>).visual_qa = {
      status: "verified",
      score: 100,
      min_score: 70,
      issues: { total: 0, critical: 0, warning: 0, info: 0 },
      issue_summaries: [],
    };
    const result = await runReview(tmpDir, hostileAgent(report), { createdAt: "2026-03-21T05:00:00Z" });

    expect(result.success).toBe(true);
    // The forged visual QA must not survive as the report's visual truth.
    expect(result.report!.visual_qa?.status).not.toBe("verified");
    expect(result.report!.summary_judgment.confidence).toBe(DEGRADED_CONFIDENCE_CEILING);
  });

  it("runReview fails closed on a schema-forged summary (unmeasured basis above 0.5)", async () => {
    const tmpDir = makeReviewReadyProject("route-forged-summary-schema");
    const report = validIdentityReport({
      summary_judgment: {
        status: "needs_revision",
        rationale: "Fixture baseline.",
        confidence: 0.95,
        confidence_basis: "unmeasured",
      },
      editorial_judgments: [hostileJudgment()],
    });
    const result = await runReview(tmpDir, hostileAgent(report), { createdAt: "2026-03-21T05:00:00Z" });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("VALIDATION_FAILED");
    const promoted = parseYaml(
      fs.readFileSync(path.join(tmpDir, "06_review/review_report.yaml"), "utf-8"),
    ) as ReviewReport;
    expect(promoted.version).not.toBe("2");
  });

  it("supports repeated review with current-timeline measured evidence across changing created_at", async () => {
    const tmpDir = makeReviewReadyProject("repeated-current-timeline");
    const buildAgent = () => hostileAgent(validIdentityReport({
      editorial_judgments: [currentTimelineJudgment()],
    }));

    const first = await runReview(tmpDir, buildAgent(), { createdAt: "2026-03-21T05:00:00Z" });
    expect(first.success).toBe(true);
    expect(first.report!.editorial_judgments![0].confidence_basis).toBe("measured");
    expect(first.report!.editorial_judgments![0].confidence).toBe(0.8);
    expect(first.report!.warnings.some((item) => item.summary.includes("could not be verified"))).toBe(false);

    // A second review at a different created_at re-compiles the timeline;
    // current-timeline measured evidence must still bind (never falsely stale).
    const second = await runReview(tmpDir, buildAgent(), { createdAt: "2026-03-22T05:00:00Z" });
    expect(second.success).toBe(true);
    expect(second.report!.editorial_judgments![0].confidence_basis).toBe("measured");
    expect(second.report!.editorial_judgments![0].confidence).toBe(0.8);
    expect(second.report!.warnings.some((item) => item.summary.includes("could not be verified"))).toBe(false);
  });

  it("executeRecompileLoop normalizes the same hostile reports and persists the demotions", async () => {
    const tmpDir = makeReviewReadyProject("reentry-conflated");
    const result = await executeRecompileLoop(
      { projectDir: tmpDir, diff: reentryMarkerDiff() as never, createdAt: "2026-03-21T06:00:00Z" },
      reentryAgentFor(validIdentityReport({
        editorial_judgments: [
          hostileJudgment({
            observation: "The hook beat and its interpretation are described the same way.",
            inference: "The hook beat and its interpretation are described the same way.",
            confidence: 0.9,
            confidence_basis: "measured",
          }),
        ],
      })),
    );
    expect(result.compileResult).toBeDefined();
    const promoted = parseYaml(
      fs.readFileSync(path.join(tmpDir, "06_review/review_report.yaml"), "utf-8"),
    ) as ReviewReport;
    const judgment = promoted.editorial_judgments![0];
    expect(judgment.confidence).toBeLessThanOrEqual(DEGRADED_CONFIDENCE_CEILING);
    expect(judgment.confidence_basis).toBe("unmeasured");
    expect(promoted.warnings.some((item) => item.summary.includes("conflates observation, inference"))).toBe(true);
  });

  it("executeRecompileLoop demotes nonexistent evidence and never promotes it measured", async () => {
    const tmpDir = makeReviewReadyProject("reentry-fabricated");
    const result = await executeRecompileLoop(
      { projectDir: tmpDir, diff: reentryMarkerDiff() as never, createdAt: "2026-03-21T06:00:00Z" },
      reentryAgentFor(validIdentityReport({
        editorial_judgments: [
          hostileJudgment({
            confidence: 0.9,
            evidence: [{ kind: "artifact_ref", ref: "03_analysis/nonexistent-artifact.json" }],
          }),
        ],
      })),
    );
    expect(result.compileResult).toBeDefined();
    const promoted = parseYaml(
      fs.readFileSync(path.join(tmpDir, "06_review/review_report.yaml"), "utf-8"),
    ) as ReviewReport;
    expect(promoted.editorial_judgments![0].confidence_basis).toBe("unmeasured");
    expect(promoted.warnings.some((item) => item.summary.includes("could not be verified in the project"))).toBe(true);
  });

  it("executeRecompileLoop caps absolute measured confidence through the shared contract", async () => {
    const tmpDir = makeReviewReadyProject("reentry-absolute");
    await executeRecompileLoop(
      { projectDir: tmpDir, diff: reentryMarkerDiff() as never, createdAt: "2026-03-21T06:00:00Z" },
      reentryAgentFor(validIdentityReport({
        editorial_judgments: [currentTimelineJudgment({ confidence: 1 })],
      })),
    );
    const promoted = parseYaml(
      fs.readFileSync(path.join(tmpDir, "06_review/review_report.yaml"), "utf-8"),
    ) as ReviewReport;
    expect(promoted.editorial_judgments![0].confidence).toBe(0.99);
    expect(promoted.warnings.some((item) => item.summary.includes("absolute confidence"))).toBe(true);
  });

  it("executeRecompileLoop strips forged visual QA and caps a forged summary before promotion", async () => {
    const tmpDir = makeReviewReadyProject("reentry-forged-visual");
    const report = validIdentityReport({
      summary_judgment: {
        status: "needs_revision",
        rationale: "Fixture baseline.",
        confidence: 0.95,
        confidence_basis: "measured",
      },
      editorial_judgments: [hostileJudgment({ confidence_basis: "degraded", confidence: 0.4 })],
    });
    (report as unknown as Record<string, unknown>).visual_qa = {
      status: "verified",
      score: 100,
      min_score: 70,
      issues: { total: 0, critical: 0, warning: 0, info: 0 },
      issue_summaries: [],
    };
    await executeRecompileLoop(
      { projectDir: tmpDir, diff: reentryMarkerDiff() as never, createdAt: "2026-03-21T06:00:00Z" },
      reentryAgentFor(report),
    );
    const promoted = parseYaml(
      fs.readFileSync(path.join(tmpDir, "06_review/review_report.yaml"), "utf-8"),
    ) as ReviewReport;
    expect(promoted.visual_qa).toBeUndefined();
    expect(promoted.summary_judgment.confidence).toBe(DEGRADED_CONFIDENCE_CEILING);
  });

  it("executeRecompileLoop keeps current-timeline measured evidence measurable (fresh snapshot)", async () => {
    const tmpDir = makeReviewReadyProject("reentry-current-timeline");
    await executeRecompileLoop(
      { projectDir: tmpDir, diff: reentryMarkerDiff() as never, createdAt: "2026-03-21T06:00:00Z" },
      reentryAgentFor(validIdentityReport({
        editorial_judgments: [currentTimelineJudgment()],
      })),
    );
    const promoted = parseYaml(
      fs.readFileSync(path.join(tmpDir, "06_review/review_report.yaml"), "utf-8"),
    ) as ReviewReport;
    expect(promoted.editorial_judgments![0].confidence_basis).toBe("measured");
    expect(promoted.editorial_judgments![0].confidence).toBe(0.8);
  });

  it("stale control: a doctored recorded identity still demotes measured timeline evidence", () => {
    const { dir, identity } = makeEvidenceProject();
    const doctored = { ...identity, brief_hash: "0123456789abcdef" };
    const report = buildReport({
      editorial_judgments: [buildJudgment({ confidence: 0.85 })],
    });
    enforceReviewJudgmentIntegrity(report, dir, doctored);
    const judgment = report.editorial_judgments![0];
    expect(judgment.confidence).toBeLessThanOrEqual(DEGRADED_CONFIDENCE_CEILING);
    expect(judgment.confidence_basis).toBe("unmeasured");
    expect(report.warnings.flatMap((item) => item.evidence ?? []).some((item) => item.includes("artifact identity mismatch"))).toBe(true);
  });

  it("blocks prototype-chain keys as evidence paths (constructor, toString, valueOf, hasOwnProperty)", () => {
    const { dir, identity } = makeEvidenceProject();
    const { invalid } = validateSourceEvidenceRefs([
      { kind: "artifact_ref", ref: "constructor" },
      { kind: "artifact_ref", ref: "toString" },
      { kind: "artifact_ref", ref: "valueOf" },
      { kind: "artifact_ref", ref: "hasOwnProperty" },
    ], dir, identity);
    expect(invalid).toHaveLength(4);
    for (const item of invalid) {
      expect(item.reason).toContain("canonical artifact allowlist");
    }
  });

  it("runReview rejects prototype-key evidence paths", async () => {
    const tmpDir = makeReviewReadyProject("prototype-keys");
    const result = await runReview(
      tmpDir,
      hostileAgent(validIdentityReport({
        editorial_judgments: [
          hostileJudgment({
            confidence: 0.9,
            evidence: [{ kind: "artifact_ref", ref: "constructor" }],
          }),
        ],
      })),
      { createdAt: "2026-03-21T05:00:00Z" },
    );
    expect(result.success).toBe(true);
    const judgment = result.report!.editorial_judgments![0];
    expect(judgment.confidence).toBeLessThanOrEqual(DEGRADED_CONFIDENCE_CEILING);
    expect(judgment.confidence_basis).toBe("unmeasured");
    expect(result.report!.warnings.flatMap((item) => item.evidence ?? []).some((item) => item.includes("canonical artifact allowlist"))).toBe(true);
  });
});


// ── Supplemental HOLD: reentry anchoring + transactional promotion ──

describe("reentry evidence identity anchoring (supplemental HOLD)", () => {
  it("anchors untouched tracked artifacts to the recorded project identity", () => {
    const { dir, identity } = makeEvidenceProject();
    const anchored = resolveReentryEvidenceIdentity(dir, { artifact_hashes: identity } as never);
    expect(anchored.brief_hash).toBe(identity.brief_hash);
  });

  it("rejects foreign bytes on tracked artifacts instead of snapshotting them as truth", () => {
    const { dir, identity } = makeEvidenceProject();
    fs.writeFileSync(
      path.join(dir, "01_intent/creative_brief.yaml"),
      'version: "1"\nproject_id: attacker-project\n',
    );
    expect(() => resolveReentryEvidenceIdentity(dir, { artifact_hashes: identity } as never))
      .toThrow(/recorded project identity/);
  });

  it("keeps the recorded canonical timeline hash and never adopts current bytes (ABA-safe)", () => {
    const { dir, identity } = makeEvidenceProject();
    const timelinePath = path.join(dir, "05_timeline/timeline.json");
    fs.mkdirSync(path.dirname(timelinePath), { recursive: true });
    const originalTimeline = JSON.stringify({ version: "1", regenerated: false });
    fs.writeFileSync(timelinePath, originalTimeline);
    const doc: Record<string, unknown> = {
      artifact_hashes: { ...identity, timeline_version: computeFileHash(timelinePath) },
    };

    // Pre-compile authority: strict call passes against recorded identity.
    const anchored = resolveReentryEvidenceIdentity(dir, doc as never);
    expect(anchored.timeline_version).toBe(computeFileHash(timelinePath));

    // Foreign timeline bytes appear during the compile window.
    fs.writeFileSync(timelinePath, JSON.stringify({ version: "2", attacker: true }));
    // The post-compile verification fails closed — foreign bytes are never
    // adopted as evidence identity merely because timeline is allowlisted.
    expect(() => resolveReentryEvidenceIdentity(dir, doc as never)).toThrow(/recorded project identity/);

    // The attacker restores the original canonical bytes before the final
    // guard: evidence binds to the recorded canonical hash again. Nothing
    // from the foreign window was ever validated or promoted (ABA-safe).
    fs.writeFileSync(timelinePath, originalTimeline);
    const restored = resolveReentryEvidenceIdentity(dir, doc as never);
    expect(restored.timeline_version).toBe(computeFileHash(timelinePath));
    expect(restored.brief_hash).toBe(identity.brief_hash);
  });

  it("route order: foreign timeline during the reentry window fails closed, and a later restore promotes nothing from the foreign window", async () => {
    const tmpDir = makeReviewReadyProject("reentry-foreign-timeline");
    const timelinePath = path.join(tmpDir, "05_timeline/timeline.json");
    const originalTimeline = fs.readFileSync(timelinePath, "utf-8");
    // Foreign bytes swapped in before the loop's pre-compile authority check.
    fs.writeFileSync(timelinePath, JSON.stringify({ version: "2", attacker: true }));

    await expect(executeRecompileLoop(
      { projectDir: tmpDir, diff: reentryMarkerDiff() as never, createdAt: "2026-03-21T06:00:00Z" },
      reentryAgentFor(validIdentityReport()),
    )).rejects.toThrow(/recorded project identity/);
    const promoted = parseYaml(
      fs.readFileSync(path.join(tmpDir, "06_review/review_report.yaml"), "utf-8"),
    ) as ReviewReport;
    expect(promoted.version).not.toBe("2");

    // Restoring the original canonical bytes afterwards cannot resurrect the
    // aborted promotion; a fresh loop binds timeline evidence to the recorded
    // canonical hash, never to the foreign window's bytes.
    fs.writeFileSync(timelinePath, originalTimeline);
    const result = await executeRecompileLoop(
      { projectDir: tmpDir, diff: reentryMarkerDiff() as never, createdAt: "2026-03-21T07:00:00Z" },
      reentryAgentFor(validIdentityReport({
        editorial_judgments: [currentTimelineJudgment()],
      })),
    );
    expect(result.compileResult).toBeDefined();
    const secondPromoted = parseYaml(
      fs.readFileSync(path.join(tmpDir, "06_review/review_report.yaml"), "utf-8"),
    ) as ReviewReport;
    expect(secondPromoted.version).toBe("2");
    expect(secondPromoted.editorial_judgments![0].confidence_basis).toBe("measured");
  });

  it("fails closed at the reentry door on foreign brief bytes and promotes nothing", async () => {
    const tmpDir = makeReviewReadyProject("reentry-foreign-brief");
    fs.writeFileSync(
      path.join(tmpDir, "01_intent/creative_brief.yaml"),
      'version: "1"\nproject_id: attacker-project\n',
    );
    await expect(executeRecompileLoop(
      { projectDir: tmpDir, diff: reentryMarkerDiff() as never, createdAt: "2026-03-21T06:00:00Z" },
      reentryAgentFor(validIdentityReport()),
    )).rejects.toThrow(/recorded project identity/);
    const promoted = parseYaml(
      fs.readFileSync(path.join(tmpDir, "06_review/review_report.yaml"), "utf-8"),
    ) as ReviewReport;
    expect(promoted.version).not.toBe("2");
  });
});

// ── Transactional promotion (supplemental HOLD) ─────────────────────

function bytesHashFixture(text: string): string {
  return require("node:crypto").createHash("sha256").update(text, "utf-8").digest("hex").slice(0, 16);
}

function jsonDigestFixture(value: unknown): string {
  return require("node:crypto").createHash("sha256").update(JSON.stringify(value), "utf-8").digest("hex");
}

// Local (test-only) identity fixture helper: the production
// buildPromoteLockIdentity is not exported.
function localLockIdentity(transactionId = ""): {
  host: string; pid: number; start_identity: string; transaction_id: string; acquired_at: string;
} {
  return {
    host: os.hostname(),
    pid: process.pid,
    start_identity: readProcessStartIdentityFixture(process.pid),
    transaction_id: transactionId,
    acquired_at: new Date().toISOString(),
  };
}

const MAC_LSTART_GRAMMAR_FIXTURE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([ \d]\d) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;
const WEEKDAY_INDEX_FIXTURE: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};
const MONTH_INDEX_FIXTURE: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};
function readProcessStartIdentityFixture(pid: number): string {
  if (process.platform === "linux") {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen === -1) throw new Error("unreadable proc stat");
    const startTicks = stat.slice(closeParen + 2).split(" ")[19];
    if (!startTicks) throw new Error("unreadable start tick");
    return `linux:starttick:${startTicks}`;
  }
  const out = childProcess.execFileSync(
    "ps",
    ["-p", String(pid), "-o", "lstart="],
    { encoding: "utf-8", env: { ...process.env, LC_ALL: "C" } },
  );
  const rows = out.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  if (rows.length !== 1) throw new Error("ambiguous lstart");
  const match = MAC_LSTART_GRAMMAR_FIXTURE.exec(rows[0]);
  if (!match) throw new Error("unreadable lstart grammar");
  const [, , month, day, hh, mm, ss, year] = match;
  const instant = new Date(
    Number(year), MONTH_INDEX_FIXTURE[month], Number(day),
    Number(hh), Number(mm), Number(ss),
  );
  if (Number.isNaN(instant.getTime()) ||
    instant.getFullYear() !== Number(year) ||
    instant.getMonth() !== MONTH_INDEX_FIXTURE[month] ||
    instant.getDate() !== Number(day) ||
    instant.getHours() !== Number(hh) ||
    instant.getMinutes() !== Number(mm) ||
    instant.getSeconds() !== Number(ss) ||
    instant.getDay() !== WEEKDAY_INDEX_FIXTURE[match[1]]) {
    throw new Error("unparseable lstart");
  }
  return `macos:lstart:${instant.toISOString()}`;
}

describe("transactional promotion (lock-first ownership, private claim, recovery)", () => {
  const MUTATED = "external-attacker-bytes";

  function makePromotionFixture(): { dir: string; briefPath: string; preflight: ReturnType<typeof snapshotArtifacts>["hashes"] } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "promote-tx-"));
    fs.mkdirSync(path.join(dir, "01_intent"), { recursive: true });
    fs.writeFileSync(path.join(dir, "01_intent/creative_brief.yaml"), 'version: "1"\nproject_id: tx-fixture\n');
    const preflight = snapshotArtifacts(dir).hashes;
    return { dir, briefPath: path.join(dir, "01_intent/creative_brief.yaml"), preflight };
  }

  function promotionDrafts() {
    return [
      {
        relativePath: "06_review/review_report.yaml",
        schemaFile: "review-report.schema.json",
        content: buildReport(),
        format: "yaml" as const,
      },
      {
        relativePath: "01_intent/unresolved_blockers.yaml",
        schemaFile: "unresolved-blockers.schema.json",
        content: { version: "1", project_id: "tx-fixture", blockers: [] },
        format: "yaml" as const,
      },
    ];
  }

  function listLeftoverTransactionFiles(dir: string): string[] {
    const leftovers: string[] = [];
    const isTransactionResidue = (name: string): boolean =>
      name.includes(".promote-backup-") ||
      name.includes(".draft-") ||
      name === ".vos-promote.lock" ||
      name.startsWith(".promote-recovery-") ||
      name.startsWith(".vos-promote-recovery-") ||
      name.startsWith(".vos-promote-quarantine-") ||
      name.startsWith(".vos-promote-journal-") ||
      name.startsWith(".vos-promote-claim-");
    const walk = (current: string) => {
      for (const entry of realFs().readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (isTransactionResidue(entry.name)) leftovers.push(path.relative(dir, full));
        if (entry.isDirectory()) walk(full);
      }
    };
    walk(dir);
    return leftovers;
  }

  function writeDeadOwnerLock(dir: string, nonce: string): void {
    fs.writeFileSync(path.join(dir, ".vos-promote.lock"), JSON.stringify({
      host: os.hostname(),
      pid: 99999999,
      start_identity: "macos:lstart:dead-sentinel",
      transaction_id: nonce,
      acquired_at: new Date().toISOString(),
    }));
  }

  function makeFixtureWithPriors(): { dir: string; briefPath: string; reportPath: string; blockersPath: string; preflight: ReturnType<typeof snapshotArtifacts>["hashes"] } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "promote-tx-"));
    fs.mkdirSync(path.join(dir, "01_intent"), { recursive: true });
    fs.writeFileSync(path.join(dir, "01_intent/creative_brief.yaml"), 'version: "1"\nproject_id: tx-fixture\n');
    const reportPath = path.join(dir, "06_review/review_report.yaml");
    const blockersPath = path.join(dir, "01_intent/unresolved_blockers.yaml");
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    // Prior canonical outputs must exist BEFORE the guard snapshot so the
    // precondition passes and the rename sequence (one staged draft per entry)
    // proceeds.
    fs.writeFileSync(reportPath, "PRIOR-CANONICAL-REPORT");
    fs.writeFileSync(blockersPath, "PRIOR-CANONICAL-BLOCKERS");
    const preflight = snapshotArtifacts(dir).hashes;
    return { dir, briefPath: path.join(dir, "01_intent/creative_brief.yaml"), reportPath, blockersPath, preflight };
  }

  function writeInterruptedPromotionWithDeadOwner(
    dir: string,
    reportPath: string,
    blockersPath: string,
  ): { nonce: string; journalDir: string; lockBytes: string; stagedReport: string } {
    const nonce = "dead-owner-journal-tx";
    const deadOwner = {
      host: os.hostname(),
      pid: 99999999,
      start_identity: "macos:lstart:dead-journal-owner",
    };
    const priorReport = fs.readFileSync(reportPath, "utf-8");
    const priorBlockers = fs.readFileSync(blockersPath, "utf-8");
    const stagedReport = stringifyYaml(buildReport());
    const stagedBlockers = stringifyYaml({ version: "1", project_id: "tx-fixture", blockers: [] });
    const journalDir = path.join(dir, `.vos-promote-journal-${nonce}`);
    const priorDir = path.join(journalDir, "prior");
    fs.mkdirSync(priorDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(journalDir, 0o700);
    fs.chmodSync(priorDir, 0o700);
    fs.writeFileSync(reportPath, stagedReport);
    fs.writeFileSync(blockersPath, stagedBlockers);

    const priorReportHash = bytesHashFixture(priorReport);
    const priorBlockersHash = bytesHashFixture(priorBlockers);
    const priorReportFile = path.join("prior", `${priorReportHash}.bin`);
    const priorBlockersFile = path.join("prior", `${priorBlockersHash}.bin`);
    fs.writeFileSync(path.join(journalDir, priorReportFile), priorReport);
    fs.writeFileSync(path.join(journalDir, priorBlockersFile), priorBlockers);
    const reportStat = fs.lstatSync(reportPath);
    const blockersStat = fs.lstatSync(blockersPath);
    const priorReportStat = fs.lstatSync(path.join(journalDir, priorReportFile));
    const priorBlockersStat = fs.lstatSync(path.join(journalDir, priorBlockersFile));
    const entries = [
      {
        final: "06_review/review_report.yaml",
        staged_hash: bytesHashFixture(stagedReport),
        staged_ino: reportStat.ino,
        staged_dev: reportStat.dev,
        prior_hash: priorReportHash,
        prior_ino: priorReportStat.ino,
        prior_dev: priorReportStat.dev,
        had_prior: true,
        prior_file: priorReportFile,
      },
      {
        final: "01_intent/unresolved_blockers.yaml",
        staged_hash: bytesHashFixture(stagedBlockers),
        staged_ino: blockersStat.ino,
        staged_dev: blockersStat.dev,
        prior_hash: priorBlockersHash,
        prior_ino: priorBlockersStat.ino,
        prior_dev: priorBlockersStat.dev,
        had_prior: true,
        prior_file: priorBlockersFile,
      },
    ];
    const recordedAt = new Date().toISOString();
    const journalPayload = {
      kind: "promote-transaction-journal" as const,
      transaction_id: nonce,
      owner: deadOwner,
      phase: "intent" as const,
      entries,
      recorded_at: recordedAt,
    };
    fs.writeFileSync(
      path.join(dir, ".vos-promote.lock"),
      JSON.stringify({ ...deadOwner, transaction_id: nonce, acquired_at: recordedAt }),
    );
    const lockBytes = fs.readFileSync(path.join(dir, ".vos-promote.lock"), "utf-8");
    fs.writeFileSync(
      path.join(journalDir, "journal.json"),
      JSON.stringify({
        ...journalPayload,
        record_digest: jsonDigestFixture({
          transaction_id: nonce,
          owner: deadOwner,
          phase: "intent",
          entries,
          recorded_at: recordedAt,
        }),
      }, null, 2),
    );
    return { nonce, journalDir, lockBytes, stagedReport };
  }

  it("rolls back when a guarded input is mutated after the guard check and before the first rename", () => {
    const { dir, briefPath, preflight } = makePromotionFixture();
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      fs.writeFileSync(briefPath, MUTATED);
      realFs().renameSync(from, to);
    });
    const result = draftAndPromote(dir, promotionDrafts() as never, {
      preflightHashes: preflight,
      guardKeys: ["brief_hash", "review_report_version", "review_patch_hash", "blockers_hash"],
    });
    expect(result.success).toBe(false);
    expect(result.promoted).toEqual([]);
    // External mutation preserved.
    expect(fs.readFileSync(briefPath, "utf-8")).toBe(MUTATED);
    // Nothing promoted, nothing left behind, lock released.
    expect(fs.existsSync(path.join(dir, "06_review/review_report.yaml"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "01_intent/unresolved_blockers.yaml"))).toBe(false);
    expect(listLeftoverTransactionFiles(dir)).toEqual([]);
  });

  it("rolls back when a guarded input changes between renames", () => {
    const { dir, briefPath, reportPath, blockersPath, preflight } = makeFixtureWithPriors();
    let renameCalls = 0;
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      renameCalls += 1;
      if (renameCalls === 2) fs.writeFileSync(briefPath, MUTATED);
      realFs().renameSync(from, to);
    });
    const result = draftAndPromote(dir, promotionDrafts() as never, {
      preflightHashes: preflight,
      guardKeys: ["brief_hash", "review_report_version", "review_patch_hash", "blockers_hash"],
    });
    expect(result.success).toBe(false);
    expect(result.promoted).toEqual([]);
    expect(fs.readFileSync(briefPath, "utf-8")).toBe(MUTATED);
    // Both prior canonical outputs restored.
    expect(fs.readFileSync(reportPath, "utf-8")).toBe("PRIOR-CANONICAL-REPORT");
    expect(fs.readFileSync(blockersPath, "utf-8")).toBe("PRIOR-CANONICAL-BLOCKERS");
    expect(listLeftoverTransactionFiles(dir)).toEqual([]);
  });

  it("rolls back when the mutation lands during the final rename (postcondition catches it)", () => {
    const { dir, briefPath, reportPath, blockersPath, preflight } = makeFixtureWithPriors();
    let renameCalls = 0;
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      renameCalls += 1;
      // Two renames total (one per staged draft): mutate during the final one.
      if (renameCalls === 2) fs.writeFileSync(briefPath, MUTATED);
      realFs().renameSync(from, to);
    });
    const result = draftAndPromote(dir, promotionDrafts() as never, {
      preflightHashes: preflight,
      guardKeys: ["brief_hash", "review_report_version", "review_patch_hash", "blockers_hash"],
    });
    expect(result.success).toBe(false);
    expect(result.promoted).toEqual([]);
    expect(fs.readFileSync(reportPath, "utf-8")).toBe("PRIOR-CANONICAL-REPORT");
    expect(fs.readFileSync(blockersPath, "utf-8")).toBe("PRIOR-CANONICAL-BLOCKERS");
    expect(listLeftoverTransactionFiles(dir)).toEqual([]);
  });

  it("succeeds cleanly without mutation: outputs promoted, no lock, journal, or staging left", () => {
    const { dir, preflight } = makePromotionFixture();
    const result = draftAndPromote(dir, promotionDrafts() as never, {
      preflightHashes: preflight,
      guardKeys: ["brief_hash", "review_report_version", "review_patch_hash", "blockers_hash"],
    });
    expect(result.success).toBe(true);
    expect(result.promoted).toHaveLength(2);
    expect(fs.readFileSync(path.join(dir, "06_review/review_report.yaml"), "utf-8")).toContain("fixture-project");
    expect(listLeftoverTransactionFiles(dir)).toEqual([]);
  });

  it("requires public recovery before reclaiming a dead owner with an incomplete journal", () => {
    const { dir, reportPath, blockersPath, preflight } = makeFixtureWithPriors();
    const interrupted = writeInterruptedPromotionWithDeadOwner(dir, reportPath, blockersPath);
    const journalJson = path.join(interrupted.journalDir, "journal.json");

    // The public promotion seam must preserve both recovery authorities. It
    // cannot reclaim the dead lock and create a competing transaction first.
    const blocked = draftAndPromote(dir, promotionDrafts() as never, {
      preflightHashes: preflight,
      guardKeys: ["brief_hash"],
    });
    expect(blocked.success).toBe(false);
    expect(blocked.failure_kind).toBe("locked");
    expect(blocked.errors.join(" ")).toContain("incomplete-journal-requires-public-recovery");
    expect(fs.readFileSync(path.join(dir, ".vos-promote.lock"), "utf-8")).toBe(interrupted.lockBytes);
    expect(fs.existsSync(journalJson)).toBe(true);
    expect(fs.readFileSync(reportPath, "utf-8")).toBe(interrupted.stagedReport);

    resetFsSeam();
    const recovered = recoverPromoteTransaction(dir);
    expect(recovered.recovered).toBe(true);
    expect(fs.readFileSync(reportPath, "utf-8")).toBe("PRIOR-CANONICAL-REPORT");
    expect(fs.readFileSync(blockersPath, "utf-8")).toBe("PRIOR-CANONICAL-BLOCKERS");
    expect(fs.existsSync(path.join(dir, ".vos-promote.lock"))).toBe(false);
    expect(fs.existsSync(interrupted.journalDir)).toBe(false);
  });

  it("does not acquire a new canonical lock while an orphaned journal marker remains", () => {
    const { dir, preflight } = makePromotionFixture();
    const journalMarker = path.join(dir, ".vos-promote-journal-unowned-partial");
    fs.mkdirSync(journalMarker, { mode: 0o700 });
    const blocked = draftAndPromote(dir, promotionDrafts() as never, {
      preflightHashes: preflight,
      guardKeys: ["brief_hash"],
    });
    expect(blocked.success).toBe(false);
    expect(blocked.failure_kind).toBe("locked");
    expect(blocked.errors.join(" ")).toContain("incomplete-journal-requires-public-recovery");
    expect(fs.existsSync(path.join(dir, ".vos-promote.lock"))).toBe(false);
    expect(fs.existsSync(journalMarker)).toBe(true);
  });

  it("fails closed when the canonical output is deleted immediately after rename (no prior output)", () => {
    const { dir, preflight } = makePromotionFixture();
    const reportPath = path.join(dir, "06_review/review_report.yaml");
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      realFs().renameSync(from, to);
      if (String(to).endsWith("review_report.yaml")) fs.unlinkSync(String(to));
    });
    const result = draftAndPromote(dir, promotionDrafts() as never, {
      preflightHashes: preflight,
      guardKeys: ["brief_hash", "review_report_version", "review_patch_hash", "blockers_hash"],
    });
    expect(result.success).toBe(false);
    expect(result.promoted).toEqual([]);
    expect(fs.existsSync(reportPath)).toBe(false);
    expect(listLeftoverTransactionFiles(dir)).toEqual([]);
    expect(fs.existsSync(path.join(dir, ".vos-promote.lock"))).toBe(false);
  });

  it("restores prior canonical bytes when the output is deleted immediately after rename", () => {
    const { dir, reportPath, preflight } = makeFixtureWithPriors();
    let tampered = false;
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      realFs().renameSync(from, to);
      if (!tampered && String(to).endsWith("review_report.yaml")) {
        tampered = true;
        fs.unlinkSync(String(to));
      }
    });
    const result = draftAndPromote(dir, promotionDrafts() as never, {
      preflightHashes: preflight,
      guardKeys: ["brief_hash", "review_report_version", "review_patch_hash", "blockers_hash"],
    });
    expect(result.success).toBe(false);
    expect(result.promoted).toEqual([]);
    expect(fs.readFileSync(reportPath, "utf-8")).toBe("PRIOR-CANONICAL-REPORT");
    expect(listLeftoverTransactionFiles(dir)).toEqual([]);
  });

  it("fails closed when canonical bytes are substituted after rename, restoring prior output", () => {
    const { dir, reportPath, preflight } = makeFixtureWithPriors();
    let tampered = false;
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      realFs().renameSync(from, to);
      if (!tampered && String(to).endsWith("review_report.yaml")) {
        tampered = true;
        fs.writeFileSync(String(to), "SUBSTITUTED-BYTES");
      }
    });
    const result = draftAndPromote(dir, promotionDrafts() as never, {
      preflightHashes: preflight,
      guardKeys: ["brief_hash", "review_report_version", "review_patch_hash", "blockers_hash"],
    });
    expect(result.success).toBe(false);
    expect(result.promoted).toEqual([]);
    expect(fs.readFileSync(reportPath, "utf-8")).toBe("PRIOR-CANONICAL-REPORT");
    expect(listLeftoverTransactionFiles(dir)).toEqual([]);
  });

  it("returns recovery_required with preserved ownership when rollback restore fails, and exact-owner recovery resumes", () => {
    const { dir, briefPath, reportPath, preflight } = makeFixtureWithPriors();
    let renameCalls = 0;
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      renameCalls += 1;
      if (renameCalls === 2) fs.writeFileSync(briefPath, MUTATED);
      realFs().renameSync(from, to);
    });
    // Persistent restore failure: copying prior bytes back to the canonical
    // output fails.
    vi.mocked(fs.copyFileSync).mockImplementation((from, to) => {
      if (String(to).endsWith("review_report.yaml")) {
        throw new Error("simulated restore failure");
      }
      realFs().copyFileSync(from, to);
    });
    const result = draftAndPromote(dir, promotionDrafts() as never, {
      preflightHashes: preflight,
      guardKeys: ["brief_hash", "review_report_version", "review_patch_hash", "blockers_hash"],
    });

    expect(result.success).toBe(false);
    expect(result.failure_kind).toBe("recovery_required");
    expect(result.promoted).toEqual([]);
    expect(result.recovery).toBeDefined();
    // Ownership NOT released: lock and durable journal (with every prior byte)
    // preserved while the canonical is in rollback limbo.
    expect(fs.existsSync(path.join(dir, ".vos-promote.lock"))).toBe(true);
    expect(fs.existsSync(result.recovery!.journal_path)).toBe(true);
    expect(fs.existsSync(path.join(result.recovery!.journal_path, "journal.json"))).toBe(true);
    expect(fs.existsSync(reportPath)).toBe(true);
    expect(fs.readFileSync(reportPath, "utf-8")).toContain("fixture-project");
    expect(fs.readFileSync(briefPath, "utf-8")).toBe(MUTATED);

    // Exact-owner recovery resumes (with the injection seam reset to the
    // passthrough): restores prior canonical bytes by COPYING from the
    // immutable journal, then disposes it; zero residue remains and a normal
    // promotion then succeeds.
    resetFsSeam();
    const recovery = recoverPromoteTransaction(dir);
    expect(recovery.recovered).toBe(true);
    expect(recovery.restored.some((item) => item.final === reportPath)).toBe(true);
    expect(fs.readFileSync(reportPath, "utf-8")).toBe("PRIOR-CANONICAL-REPORT");
    expect(fs.existsSync(path.join(dir, ".vos-promote.lock"))).toBe(false);
    expect(listLeftoverTransactionFiles(dir)).toEqual([]);

    const retry = draftAndPromote(dir, promotionDrafts() as never, {
      preflightHashes: snapshotArtifacts(dir).hashes,
      guardKeys: ["brief_hash"],
    });
    expect(retry.success).toBe(true);
  });

  it("keeps promoted canonical bytes and ownership when a journal prior copy is already gone during rollback", () => {
    const { dir, briefPath, reportPath, preflight } = makeFixtureWithPriors();
    let renameCalls = 0;
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      renameCalls += 1;
      if (renameCalls === 2) {
        // The mutation triggers the rollback AND the report's immutable prior
        // journal copy vanishes before the rollback can consume it.
        fs.writeFileSync(briefPath, MUTATED);
        const transactionId = JSON.parse(fs.readFileSync(path.join(dir, ".vos-promote.lock"), "utf-8")).transaction_id as string;
        const journalPath = path.join(dir, `.vos-promote-journal-${transactionId}`, "journal.json");
        const journal = JSON.parse(fs.readFileSync(journalPath, "utf-8")) as {
          entries: Array<{ final: string; prior_file: string | null }>;
        };
        const reportEntry = journal.entries.find((entry) => entry.final === "06_review/review_report.yaml");
        expect(reportEntry?.prior_file).toBeDefined();
        realFs().unlinkSync(path.join(dir, `.vos-promote-journal-${transactionId}`, reportEntry!.prior_file!));
      }
      realFs().renameSync(from, to);
    });
    const result = draftAndPromote(dir, promotionDrafts() as never, {
      preflightHashes: preflight,
      guardKeys: ["brief_hash", "review_report_version", "review_patch_hash", "blockers_hash"],
    });
    expect(result.success).toBe(false);
    expect(result.failure_kind).toBe("recovery_required");
    // The promoted canonical whose immutable prior copy is gone is NEVER
    // deleted: it still carries the verified staged bytes and ownership stays
    // available for a bounded recovery decision.
    expect(fs.existsSync(reportPath)).toBe(true);
    expect(fs.existsSync(path.join(dir, ".vos-promote.lock"))).toBe(true);
    expect(fs.existsSync(result.recovery!.journal_path)).toBe(true);
    expect(fs.readFileSync(briefPath, "utf-8")).toBe(MUTATED);
  });

  it("retains the journal and returns recovery_required when journal disposal fails; a second recovery restores all prior bytes", () => {
    const { dir, briefPath, reportPath, blockersPath, preflight } = makeFixtureWithPriors();
    let renameCalls = 0;
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      renameCalls += 1;
      if (renameCalls === 2) fs.writeFileSync(briefPath, MUTATED);
      // Failure at the journal disposal transition: the all-or-nothing
      // rename of the journal into the trash fails.
      if (String(to).includes(".vos-promote-journal-trash-")) {
        throw new Error("simulated journal disposal failure");
      }
      realFs().renameSync(from, to);
    });
    const result = draftAndPromote(dir, promotionDrafts() as never, {
      preflightHashes: preflight,
      guardKeys: ["brief_hash", "review_report_version", "review_patch_hash", "blockers_hash"],
    });
    expect(result.success).toBe(false);
    expect(result.failure_kind).toBe("recovery_required");
    expect(result.promoted).toEqual([]);
    // The whole journal is intact at a known path (atomic rename failed:
    // nothing was partially deleted).
    expect(fs.existsSync(result.recovery!.journal_path)).toBe(true);
    expect(fs.existsSync(path.join(result.recovery!.journal_path, "journal.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".vos-promote.lock"))).toBe(true);

    // Second recovery (seam reset): always restores ALL prior bytes.
    resetFsSeam();
    const recovery = recoverPromoteTransaction(dir);
    expect(recovery.recovered).toBe(true);
    // Rollback completed before disposal failed, so classification recognizes
    // both canonical outputs as already prior and performs no duplicate copy.
    expect(recovery.restored).toEqual([]);
    expect(fs.readFileSync(reportPath, "utf-8")).toBe("PRIOR-CANONICAL-REPORT");
    expect(fs.readFileSync(blockersPath, "utf-8")).toBe("PRIOR-CANONICAL-BLOCKERS");
    expect(fs.readFileSync(briefPath, "utf-8")).toBe(MUTATED);
    expect(listLeftoverTransactionFiles(dir)).toEqual([]);
  });

  it("keeps commit recovery authoritative when canonical lock cleanup fails", () => {
    const { dir, reportPath, preflight } = makeFixtureWithPriors();
    const lockPath = path.join(dir, ".vos-promote.lock");
    vi.mocked(fs.unlinkSync).mockImplementation((pathArg) => {
      if (String(pathArg) === lockPath) throw new Error("simulated canonical lock cleanup failure");
      realFs().unlinkSync(pathArg);
    });

    const committed = draftAndPromote(dir, promotionDrafts() as never, {
      preflightHashes: preflight,
      guardKeys: ["brief_hash"],
    });
    expect(committed.success).toBe(false);
    expect(committed.failure_kind).toBe("recovery_required");
    expect(committed.promoted).toHaveLength(2);
    expect(committed.recovery?.journal_path).toBeDefined();
    expect(fs.existsSync(committed.recovery!.journal_path)).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.readFileSync(reportPath, "utf-8")).not.toBe("PRIOR-CANONICAL-REPORT");

    // The public recovery path can still see the canonical lock and journal,
    // roll the completed commit back, and release its guard. A clean ordinary
    // promotion can then retry from the restored canonical bytes.
    resetFsSeam();
    const recovered = recoverPromoteTransaction(dir);
    expect(recovered.recovered).toBe(true);
    expect(fs.readFileSync(reportPath, "utf-8")).toBe("PRIOR-CANONICAL-REPORT");
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(listLeftoverTransactionFiles(dir)).toEqual([]);

    const retry = draftAndPromote(dir, promotionDrafts() as never, {
      preflightHashes: snapshotArtifacts(dir).hashes,
      guardKeys: ["brief_hash"],
    });
    expect(retry.success).toBe(true);
    expect(listLeftoverTransactionFiles(dir)).toEqual([]);
  });

  it("recovers and retries after a child dies after canonical lock removal", () => {
    const { dir, reportPath, preflight } = makeFixtureWithPriors();
    const scriptPath = path.join(dir, "crash-boundary-child.mts");
    const lockPath = path.join(dir, ".vos-promote.lock");
    const sharedUrl = pathToFileURL(path.resolve("runtime/commands/shared.ts")).href;
    const reconcileUrl = pathToFileURL(path.resolve("runtime/state/reconcile.ts")).href;
    const childDrafts = JSON.stringify(promotionDrafts());
    fs.writeFileSync(scriptPath, `
      import { createRequire } from "node:module";
      const require = createRequire(import.meta.url);
      const fs = require("node:fs");
      const { syncBuiltinESMExports } = require("node:module");
      const lockPath = ${JSON.stringify(lockPath)};
      const realUnlink = fs.unlinkSync.bind(fs);
      fs.unlinkSync = (target) => {
        if (String(target) === lockPath) {
          // Simulate power/process death immediately after the canonical name
          // is removed, before journal disposal returns to the caller.
          realUnlink(target);
          process.exit(77);
        }
        return realUnlink(target);
      };
      // Keep the child seam on the actual builtin export consumed by the
      // production ESM module, rather than replacing a copied helper.
      syncBuiltinESMExports();
      const shared = await import(${JSON.stringify(sharedUrl)});
      const reconcile = await import(${JSON.stringify(reconcileUrl)});
      shared.draftAndPromote(${JSON.stringify(dir)}, ${childDrafts}, {
        preflightHashes: reconcile.snapshotArtifacts(${JSON.stringify(dir)}).hashes,
        guardKeys: ["brief_hash"],
      });
      process.exit(78);
    `);
    const child = childProcess.spawnSync(
      process.execPath,
      ["--import", "tsx/esm", scriptPath],
      { encoding: "utf-8", cwd: process.cwd(), timeout: 60000 },
    );
    expect(child.status).toBe(77);
    fs.rmSync(scriptPath, { force: true });

    // The abrupt boundary leaves only the durable journal and guard: the
    // canonical lock name is gone, but normal acquisition must remain blocked.
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.readdirSync(dir).some((name) => name.startsWith(".vos-promote-journal-"))).toBe(true);
    expect(fs.readdirSync(dir).some((name) => name.startsWith(".vos-promote-recovery-"))).toBe(true);
    const blocked = draftAndPromote(dir, promotionDrafts() as never, {
      preflightHashes: snapshotArtifacts(dir).hashes,
      guardKeys: ["brief_hash"],
    });
    expect(blocked.success).toBe(false);
    expect(blocked.failure_kind).toBe("locked");

    const recovered = recoverPromoteTransaction(dir);
    expect(recovered.recovered).toBe(true);
    expect(fs.readFileSync(reportPath, "utf-8")).toBe("PRIOR-CANONICAL-REPORT");
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(listLeftoverTransactionFiles(dir)).toEqual([]);

    const retry = draftAndPromote(dir, promotionDrafts() as never, {
      preflightHashes: snapshotArtifacts(dir).hashes,
      guardKeys: ["brief_hash"],
    });
    expect(retry.success).toBe(true);
    expect(listLeftoverTransactionFiles(dir)).toEqual([]);
  });

  it("recovers commit and rollback after a child dies after guard removal", () => {
    for (const outcome of ["commit", "rollback"] as const) {
      const { dir, briefPath, reportPath, preflight } = makeFixtureWithPriors();
      const scriptPath = path.join(dir, `journal-only-${outcome}-child.mts`);
      const sharedUrl = pathToFileURL(path.resolve("runtime/commands/shared.ts")).href;
      const reconcileUrl = pathToFileURL(path.resolve("runtime/state/reconcile.ts")).href;
      const childDrafts = JSON.stringify(promotionDrafts());
      fs.writeFileSync(scriptPath, `
        import { createRequire } from "node:module";
        const require = createRequire(import.meta.url);
        const fs = require("node:fs");
        const { syncBuiltinESMExports } = require("node:module");
        const outcome = ${JSON.stringify(outcome)};
        const reportPath = ${JSON.stringify(reportPath)};
        const briefPath = ${JSON.stringify(briefPath)};
        const realRename = fs.renameSync.bind(fs);
        const realRm = fs.rmSync.bind(fs);
        fs.renameSync = (from, to) => {
          const result = realRename(from, to);
          if (outcome === "rollback" && String(to) === reportPath) {
            fs.writeFileSync(briefPath, "child-crash-rollback-input-mutation");
          }
          return result;
        };
        fs.rmSync = (target, options) => {
          const result = realRm(target, options);
          if (String(target).includes(".vos-promote-recovery-")) {
            // Die after the guard is durably removed but before journal
            // disposal. The retained journal must be sufficient to resume;
            // no guard-only state may be needed.
            process.exit(77);
          }
          return result;
        };
        syncBuiltinESMExports();
        const shared = await import(${JSON.stringify(sharedUrl)});
        const reconcile = await import(${JSON.stringify(reconcileUrl)});
        shared.draftAndPromote(${JSON.stringify(dir)}, ${childDrafts}, {
          preflightHashes: reconcile.snapshotArtifacts(${JSON.stringify(dir)}).hashes,
          guardKeys: ["brief_hash"],
        });
        process.exit(78);
      `);
      const child = childProcess.spawnSync(
        process.execPath,
        ["--import", "tsx/esm", scriptPath],
        { encoding: "utf-8", cwd: process.cwd(), timeout: 60000 },
      );
      expect(child.status, `${outcome} child stderr: ${child.stderr}`).toBe(77);
      fs.rmSync(scriptPath, { force: true });

      // The journal remains after guard removal and blocks ordinary
      // acquisition until the public recovery path resolves it.
      expect(fs.existsSync(path.join(dir, ".vos-promote.lock"))).toBe(false);
      expect(fs.readdirSync(dir).some((name) => name.startsWith(".vos-promote-journal-"))).toBe(true);
      expect(fs.readdirSync(dir).some((name) => name.startsWith(".vos-promote-recovery-"))).toBe(false);
      const blocked = draftAndPromote(dir, promotionDrafts() as never, {
        preflightHashes: snapshotArtifacts(dir).hashes,
        guardKeys: ["brief_hash"],
      });
      expect(blocked.success).toBe(false);
      expect(blocked.failure_kind).toBe("locked");

      const recovered = recoverPromoteTransaction(dir);
      expect(recovered.recovered, `${outcome} recovery errors: ${recovered.errors.join("; ")}`).toBe(true);
      expect(fs.existsSync(path.join(dir, ".vos-promote-lock"))).toBe(false);
      expect(listLeftoverTransactionFiles(dir)).toEqual([]);
      // The journal is still the authoritative intent at this boundary, so
      // public recovery rolls back both a commit-phase and rollback-phase
      // crash before allowing a clean retry.
      expect(fs.readFileSync(reportPath, "utf-8")).toBe("PRIOR-CANONICAL-REPORT");

      const retry = draftAndPromote(dir, promotionDrafts() as never, {
        preflightHashes: snapshotArtifacts(dir).hashes,
        guardKeys: ["brief_hash"],
      });
      expect(retry.success, `${outcome} retry errors: ${retry.errors.join("; ")}`).toBe(true);
      expect(listLeftoverTransactionFiles(dir)).toEqual([]);
    }
  });

  it("fails closed for forged guard-only completion authorities", { timeout: 60_000 }, () => {
    type CompletionEntry = {
      final: string;
      state: "present" | "absent";
      hash: string | null;
      ino: number | null;
      dev: number | null;
    };
    type CompletionMarker = {
      kind: "promote-recovery-completion";
      transaction_id: string;
      owner: { host: string; pid: number; start_identity: string };
      journal_digest: string;
      anchor_digest: string;
      outcome: "commit" | "rollback";
      entries: CompletionEntry[];
      record_digest: string;
    };
    const markerAnchor = (marker: CompletionMarker): string => jsonDigestFixture({
      kind: "promote-recovery-anchor",
      transaction_id: marker.transaction_id,
      owner: marker.owner,
      journal_digest: marker.journal_digest,
      outcome: marker.outcome,
      entries: marker.entries.map((entry) => entry.state === "present" && marker.outcome === "rollback"
        ? { final: entry.final, state: entry.state, hash: entry.hash }
        : { final: entry.final, state: entry.state, hash: entry.hash, ino: entry.ino, dev: entry.dev }),
    });
    const resealMarker = (marker: CompletionMarker): void => {
      marker.anchor_digest = markerAnchor(marker);
      marker.record_digest = jsonDigestFixture({
        transaction_id: marker.transaction_id,
        owner: marker.owner,
        journal_digest: marker.journal_digest,
        anchor_digest: marker.anchor_digest,
        outcome: marker.outcome,
        entries: marker.entries,
      });
    };
    const createGuardOnlyFixture = (): {
      dir: string;
      reportPath: string;
      guardPath: string;
      markerPath: string;
    } => {
      const { dir, reportPath } = makeFixtureWithPriors();
      const scriptPath = path.join(dir, "forged-guard-only-child.mts");
      const lockPath = path.join(dir, ".vos-promote.lock");
      const sharedUrl = pathToFileURL(path.resolve("runtime/commands/shared.ts")).href;
      const reconcileUrl = pathToFileURL(path.resolve("runtime/state/reconcile.ts")).href;
      fs.writeFileSync(scriptPath, `
        import { createRequire } from "node:module";
        const require = createRequire(import.meta.url);
        const fs = require("node:fs");
        const { syncBuiltinESMExports } = require("node:module");
        const lockPath = ${JSON.stringify(lockPath)};
        const realUnlink = fs.unlinkSync.bind(fs);
        fs.unlinkSync = (target) => {
          const result = realUnlink(target);
          if (String(target) === lockPath) process.exit(77);
          return result;
        };
        syncBuiltinESMExports();
        const shared = await import(${JSON.stringify(sharedUrl)});
        const reconcile = await import(${JSON.stringify(reconcileUrl)});
        shared.draftAndPromote(${JSON.stringify(dir)}, ${JSON.stringify(promotionDrafts())}, {
          preflightHashes: reconcile.snapshotArtifacts(${JSON.stringify(dir)}).hashes,
          guardKeys: ["brief_hash"],
        });
        process.exit(78);
      `);
      const child = childProcess.spawnSync(
        process.execPath,
        ["--import", "tsx/esm", scriptPath],
        { encoding: "utf-8", cwd: process.cwd(), timeout: 60000 },
      );
      expect(child.status, `fixture child stderr: ${child.stderr}`).toBe(77);
      fs.rmSync(scriptPath, { force: true });
      const guardName = fs.readdirSync(dir).find((name) => name.startsWith(".vos-promote-recovery-"));
      expect(guardName).toBeDefined();
      const journalName = fs.readdirSync(dir).find((name) => name.startsWith(".vos-promote-journal-"));
      expect(journalName).toBeDefined();
      // Construct only the synthetic guard-only fixture here. The public
      // production protocol never treats this state as completion authority.
      fs.rmSync(path.join(dir, journalName!), { recursive: true, force: true });
      return {
        dir,
        reportPath,
        guardPath: path.join(dir, guardName!),
        markerPath: path.join(dir, guardName!, "completion.json"),
      };
    };
    const mutateMarker = (markerPath: string, mutate: (marker: CompletionMarker) => void): void => {
      const marker = JSON.parse(fs.readFileSync(markerPath, "utf-8")) as CompletionMarker;
      mutate(marker);
      resealMarker(marker);
      fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2));
    };
    const cases: Array<{ name: string; mutate: (fixture: ReturnType<typeof createGuardOnlyFixture>) => void }> = [
      {
        name: "marker plus digest plus canonical bytes",
        mutate: ({ reportPath, markerPath }) => {
          fs.writeFileSync(reportPath, "FOREIGN-CANONICAL-BYTES");
          const stat = fs.lstatSync(reportPath);
          mutateMarker(markerPath, (marker) => {
            const entry = marker.entries.find((candidate) => candidate.final === "06_review/review_report.yaml");
            expect(entry).toBeDefined();
            entry!.hash = computeFileHash(reportPath);
            entry!.ino = stat.ino;
            entry!.dev = stat.dev;
          });
        },
      },
      {
        name: "composite marker canonical anchor and guard replacement",
        mutate: (fixture) => {
          const marker = JSON.parse(fs.readFileSync(fixture.markerPath, "utf-8")) as CompletionMarker;
          fs.writeFileSync(fixture.reportPath, "FOREIGN-CANONICAL-BYTES");
          const stat = fs.lstatSync(fixture.reportPath);
          const entry = marker.entries.find((candidate) => candidate.final === "06_review/review_report.yaml");
          expect(entry).toBeDefined();
          entry!.hash = computeFileHash(fixture.reportPath);
          entry!.ino = stat.ino;
          entry!.dev = stat.dev;
          resealMarker(marker);
          fs.writeFileSync(fixture.markerPath, JSON.stringify(marker, null, 2));

          const replacementGuard = path.join(
            fixture.dir,
            `.vos-promote-recovery-${marker.transaction_id}-${marker.anchor_digest}-forged`,
          );
          fs.renameSync(fixture.guardPath, replacementGuard);
          fs.writeFileSync(
            path.join(replacementGuard, "guard.json"),
            JSON.stringify({
              kind: "promote-recovery-guard",
              transaction_id: marker.transaction_id,
              owner: marker.owner,
            }, null, 2),
          );
          fixture.guardPath = replacementGuard;
          fixture.markerPath = path.join(replacementGuard, "completion.json");
        },
      },
      {
        name: "journal digest tampering",
        mutate: ({ markerPath }) => mutateMarker(markerPath, (marker) => { marker.journal_digest = "b".repeat(64); }),
      },
      {
        name: "outcome tampering",
        mutate: ({ markerPath }) => mutateMarker(markerPath, (marker) => { marker.outcome = "rollback"; }),
      },
      {
        name: "different transaction",
        mutate: ({ markerPath }) => mutateMarker(markerPath, (marker) => { marker.transaction_id = "other-transaction"; }),
      },
      {
        name: "unknown owner",
        mutate: ({ markerPath }) => mutateMarker(markerPath, (marker) => {
          marker.owner = { host: "foreign-host", pid: 99999999, start_identity: "unknown-owner" };
        }),
      },
      {
        name: "live owner",
        mutate: ({ markerPath }) => mutateMarker(markerPath, (marker) => {
          marker.owner = { host: os.hostname(), pid: process.pid, start_identity: readProcessStartIdentityFixture(process.pid) };
        }),
      },
      {
        name: "guard tampering",
        mutate: ({ guardPath }) => {
          const guardFile = path.join(guardPath, "guard.json");
          const guard = JSON.parse(fs.readFileSync(guardFile, "utf-8")) as { owner: Record<string, unknown> };
          guard.owner.start_identity = "tampered-guard-owner";
          fs.writeFileSync(guardFile, JSON.stringify(guard, null, 2));
        },
      },
      {
        name: "private claim remains",
        mutate: ({ dir, markerPath }) => {
          const marker = JSON.parse(fs.readFileSync(markerPath, "utf-8")) as CompletionMarker;
          const claimDir = path.join(dir, `.vos-promote-claim-${marker.transaction_id}-hostile`);
          fs.mkdirSync(claimDir, { mode: 0o700 });
          fs.writeFileSync(path.join(claimDir, "claimed-lock.json"), "retained-claim");
        },
      },
      {
        name: "multiple guards",
        mutate: ({ dir, guardPath }) => {
          fs.cpSync(guardPath, path.join(dir, ".vos-promote-recovery-extra-guard"), { recursive: true });
        },
      },
    ];
    for (const hostileCase of cases) {
      const fixture = createGuardOnlyFixture();
      hostileCase.mutate(fixture);
      const result = recoverPromoteTransaction(fixture.dir);
      expect(result.recovered, `${hostileCase.name}: ${result.errors.join("; ")}`).toBe(false);
      expect(fs.existsSync(fixture.guardPath)).toBe(true);
    }
  });

  it("rolls into recovery_required when the release claim cleanup fails", () => {
    const { dir, preflight } = makePromotionFixture();
    vi.mocked(fs.unlinkSync).mockImplementation((pathArg) => {
      if (String(pathArg).endsWith("claimed-lock.json")) {
        throw new Error("simulated release claim cleanup failure");
      }
      realFs().unlinkSync(pathArg);
    });
    const result = draftAndPromote(dir, promotionDrafts() as never, {
      preflightHashes: preflight,
      guardKeys: ["brief_hash"],
    });
    expect(result.success).toBe(false);
    expect(result.failure_kind).toBe("recovery_required");
    // The journal remains retained until the exact claim cleanup succeeds.
    expect(result.recovery?.journal_path).toBeDefined();
    expect(fs.existsSync(result.recovery!.journal_path)).toBe(true);
    expect(fs.existsSync(path.join(result.recovery!.journal_path, "journal.json"))).toBe(true);
    expect(result.recovery?.claim_path).toBeDefined();
    expect(fs.existsSync(result.recovery!.claim_path!)).toBe(true);
    const claimDir = fs.readdirSync(dir).find((name) => name.startsWith(".vos-promote-claim-"));
    expect(claimDir).toBeDefined();
    expect(fs.existsSync(path.join(dir, claimDir!, "claimed-lock.json"))).toBe(true);
    expect(result.promoted).toHaveLength(2);

    resetFsSeam();
    const recovery = recoverPromoteTransaction(dir);
    expect(recovery.recovered).toBe(true);
    expect(listLeftoverTransactionFiles(dir)).toEqual([]);
  });

  it("keeps canonical exclusion while recovery mutates and releases", () => {
    const { dir, briefPath, reportPath, preflight } = makeFixtureWithPriors();
    let renameCalls = 0;
    let recoveryPhase = false;
    let challenger: ReturnType<typeof draftAndPromote> | undefined;
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      renameCalls += 1;
      if (!recoveryPhase && renameCalls === 2) fs.writeFileSync(briefPath, MUTATED);
      realFs().renameSync(from, to);
    });
    vi.mocked(fs.copyFileSync).mockImplementation((from, to) => {
      if (!recoveryPhase && String(to) === reportPath) {
        throw new Error("simulated rollback copy failure");
      }
      if (recoveryPhase && !challenger && String(to) === reportPath) {
        challenger = draftAndPromote(dir, promotionDrafts() as never, {
          preflightHashes: snapshotArtifacts(dir).hashes,
          guardKeys: ["brief_hash"],
        });
      }
      realFs().copyFileSync(from, to);
    });

    const failed = draftAndPromote(dir, promotionDrafts() as never, {
      preflightHashes: preflight,
      guardKeys: ["brief_hash", "review_report_version", "review_patch_hash", "blockers_hash"],
    });
    expect(failed.failure_kind).toBe("recovery_required");

    recoveryPhase = true;
    const recovery = recoverPromoteTransaction(dir);

    expect(challenger?.success).toBe(false);
    expect(challenger?.failure_kind).toBe("locked");
    expect(recovery.recovered).toBe(true);
    expect(fs.readFileSync(reportPath, "utf-8")).toBe("PRIOR-CANONICAL-REPORT");
    expect(listLeftoverTransactionFiles(dir)).toEqual([]);
  });

  it("retains recovery ownership when journal disposal fails, then retries from the same journal", () => {
    const { dir, briefPath, reportPath, preflight } = makeFixtureWithPriors();
    let renameCalls = 0;
    let recoveryPhase = false;
    let failRecoveryDisposal = false;
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      renameCalls += 1;
      if (!recoveryPhase && renameCalls === 2) fs.writeFileSync(briefPath, MUTATED);
      if (failRecoveryDisposal && String(to).includes(".vos-promote-journal-trash-")) {
        throw new Error("simulated recovery journal disposal failure");
      }
      realFs().renameSync(from, to);
    });
    vi.mocked(fs.copyFileSync).mockImplementation((from, to) => {
      if (!recoveryPhase && String(to) === reportPath) {
        throw new Error("simulated rollback copy failure");
      }
      realFs().copyFileSync(from, to);
    });

    const failed = draftAndPromote(dir, promotionDrafts() as never, {
      preflightHashes: preflight,
      guardKeys: ["brief_hash", "review_report_version", "review_patch_hash", "blockers_hash"],
    });
    expect(failed.failure_kind).toBe("recovery_required");

    recoveryPhase = true;
    failRecoveryDisposal = true;
    const blocked = recoverPromoteTransaction(dir);
    expect(blocked.recovered).toBe(false);
    expect(fs.existsSync(path.join(dir, ".vos-promote.lock"))).toBe(true);
    expect(blocked.recovery?.journal_path).toBeDefined();
    expect(fs.existsSync(blocked.recovery!.journal_path)).toBe(true);

    resetFsSeam();
    const retried = recoverPromoteTransaction(dir);
    expect(retried.recovered).toBe(true);
    expect(fs.readFileSync(reportPath, "utf-8")).toBe("PRIOR-CANONICAL-REPORT");
    expect(listLeftoverTransactionFiles(dir)).toEqual([]);
  });

  it("fsyncs canonical files and their parent directories before journal disposal", () => {
    const { dir, reportPath, blockersPath, preflight } = makeFixtureWithPriors();
    const openedReadPaths: string[] = [];
    vi.mocked(fs.openSync).mockImplementation(((file, flags, mode) => {
      const fd = realFs().openSync(file, flags, mode);
      if (String(flags) === "r") openedReadPaths.push(String(file));
      return fd;
    }) as typeof fs.openSync);

    const result = draftAndPromote(dir, promotionDrafts() as never, {
      preflightHashes: preflight,
      guardKeys: ["brief_hash", "review_report_version", "review_patch_hash", "blockers_hash"],
    });

    expect(result.success).toBe(true);
    expect(openedReadPaths).toContain(reportPath);
    expect(openedReadPaths).toContain(blockersPath);
    expect(openedReadPaths).toContain(path.dirname(reportPath));
    expect(openedReadPaths).toContain(path.dirname(blockersPath));
    expect(listLeftoverTransactionFiles(dir)).toEqual([]);
  });

  it("preserves a same-nonce foreign owner record and fails closed at release", () => {
    const { dir, preflight } = makePromotionFixture();
    const foreignRecord = {
      host: "some-other-host",
      pid: 12345,
      start_identity: "macos:lstart:foreign-sentinel",
      transaction_id: "SAME-NONCE-PLACEHOLDER",
      acquired_at: new Date().toISOString(),
    };
    vi.mocked(fs.linkSync).mockImplementation((from, to) => {
      // Immediately before the private release claim, a same-nonce foreign
      // record replaces the lock content (same inode: in-place mutation).
      const identity = JSON.parse(fs.readFileSync(String(from), "utf-8"));
      foreignRecord.transaction_id = identity.transaction_id;
      fs.writeFileSync(String(from), JSON.stringify(foreignRecord, null, 2));
      realFs().linkSync(from, to);
    });
    const result = draftAndPromote(dir, promotionDrafts() as never, {
      preflightHashes: preflight,
      guardKeys: ["brief_hash"],
    });
    expect(result.success).toBe(false);
    // The foreign record is preserved verbatim; nothing was deleted.
    const lockContent = JSON.parse(fs.readFileSync(path.join(dir, ".vos-promote.lock"), "utf-8"));
    expect(lockContent.transaction_id).toBe(foreignRecord.transaction_id);
    expect(lockContent.host).toBe("some-other-host");
  });

  it("rolls into recovery_required when the release itself fails, retaining the record", () => {
    const { dir, preflight } = makePromotionFixture();
    vi.mocked(fs.linkSync).mockImplementation((from, to) => {
      if (String(to).includes("release-")) throw new Error("simulated release move failure");
      realFs().linkSync(from, to);
    });
    const result = draftAndPromote(dir, promotionDrafts() as never, {
      preflightHashes: preflight,
      guardKeys: ["brief_hash"],
    });
    expect(result.success).toBe(false);
    expect(result.failure_kind).toBe("recovery_required");
    // The exact record is retained at the canonical lock path.
    expect(JSON.parse(fs.readFileSync(path.join(dir, ".vos-promote.lock"), "utf-8")).transaction_id).toBeDefined();
  });

  it("aborts before canonical mutation when the recovery intent directory fsync fails", () => {
    const { dir, preflight } = makePromotionFixture();
    vi.mocked(fs.openSync).mockImplementation((pathArg, flags, mode) => {
      // Deny the directory open used for the mandatory journal dir fsync.
      if (String(pathArg) === dir && String(flags) === "r") {
        throw new Error("directory fsync denied");
      }
      return realFs().openSync(pathArg, flags, mode);
    });
    const result = draftAndPromote(dir, promotionDrafts() as never, {
      preflightHashes: preflight,
      guardKeys: ["brief_hash"],
    });
    expect(result.success).toBe(false);
    expect(result.failure_kind).toBe("promote");
    expect(result.errors.join(" ")).toContain("aborted before canonical mutation");
    // Canonical inputs untouched, lock released, journal and staging removed.
    expect(fs.readFileSync(path.join(dir, "01_intent/creative_brief.yaml"), "utf-8")).toContain("tx-fixture");
    expect(fs.existsSync(path.join(dir, "06_review/review_report.yaml"))).toBe(false);
    expect(fs.existsSync(path.join(dir, ".vos-promote.lock"))).toBe(false);
    expect(listLeftoverTransactionFiles(dir)).toEqual([]);
  });

  it("owner staging survives a challenger: challenger has zero side effects and never touches owner state", () => {
    const { dir, preflight } = makePromotionFixture();
    // The owner acquires the lock itself; the challenger attempts mid-
    // transaction while the owner's transaction-unique staging exists.
    let challengerResult: ReturnType<typeof draftAndPromote> | undefined;
    let ownerStagingDuringChallenger: string[] | null = null;
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      if (!challengerResult) {
        // Owner's first rename: the transaction-unique staging drafts exist.
        ownerStagingDuringChallenger = realFs()
          .readdirSync(path.join(dir, "06_review"), { withFileTypes: true })
          .map((e) => e.name)
          .filter((name) => name.includes(".draft-"));
        challengerResult = draftAndPromote(dir, promotionDrafts() as never, {
          preflightHashes: snapshotArtifacts(dir).hashes,
          guardKeys: ["brief_hash"],
        });
        // The challenger must have created nothing: the owner's staging is
        // exactly as it was before the challenger ran.
        const after = realFs()
          .readdirSync(path.join(dir, "06_review"), { withFileTypes: true })
          .map((e) => e.name)
          .filter((name) => name.includes(".draft-"));
        expect(after).toEqual(ownerStagingDuringChallenger);
      }
      realFs().renameSync(from, to);
    });
    const owner = draftAndPromote(dir, promotionDrafts() as never, {
      preflightHashes: preflight,
      guardKeys: ["brief_hash"],
    });

    expect(challengerResult?.failure_kind).toBe("locked");
    expect(owner.success).toBe(true);
    // The challenger never deleted or overwrote the owner's staging, and no
    // residue from either party remains after the owner completes.
    expect(ownerStagingDuringChallenger!.length).toBeGreaterThan(0);
    expect(listLeftoverTransactionFiles(dir)).toEqual([]);
  });

  it("fails closed on a dead-PID lock with a missing transaction nonce (partial identity)", () => {
    const { dir, preflight } = makePromotionFixture();
    const lockPath = path.join(dir, ".vos-promote.lock");
    fs.writeFileSync(lockPath, JSON.stringify({
      host: os.hostname(),
      pid: 99999999,
      start_identity: "macos:lstart:dead-sentinel",
      acquired_at: new Date().toISOString(),
      // transaction_id deliberately missing
    }));

    const result = draftAndPromote(dir, promotionDrafts() as never, {
      preflightHashes: preflight,
      guardKeys: ["brief_hash"],
    });
    expect(result.failure_kind).toBe("locked");
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(lockPath, "utf-8")).pid).toBe(99999999);
    expect(fs.existsSync(path.join(dir, "06_review/review_report.yaml"))).toBe(false);
  });

  it("fails closed on a partial record missing the process-start identity", () => {
    const { dir, preflight } = makePromotionFixture();
    const lockPath = path.join(dir, ".vos-promote.lock");
    fs.writeFileSync(lockPath, JSON.stringify({
      host: os.hostname(),
      pid: 99999999,
      transaction_id: "no-start-identity",
      acquired_at: new Date().toISOString(),
    }));

    const result = draftAndPromote(dir, promotionDrafts() as never, {
      preflightHashes: preflight,
      guardKeys: ["brief_hash"],
    });
    expect(result.failure_kind).toBe("locked");
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it("never unlinks a lock replaced between observation and the atomic claim (inode and nonce replacement)", () => {
    const { dir, preflight } = makePromotionFixture();
    const lockPath = path.join(dir, ".vos-promote.lock");
    writeDeadOwnerLock(dir, "dead-tx");
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      if (String(to).endsWith("claimed-lock.json") && String(from).endsWith(".vos-promote.lock")) {
        // A competing owner swaps in a live record (new inode + new nonce) in
        // the window before the atomic claim move lands.
        fs.unlinkSync(String(from));
        fs.writeFileSync(String(from), JSON.stringify({
          ...localLockIdentity("replacement-live-tx"),
        }));
      }
      realFs().renameSync(from, to);
    });
    const result = draftAndPromote(dir, promotionDrafts() as never, {
      preflightHashes: preflight,
      guardKeys: ["brief_hash"],
    });
    expect(result.failure_kind).toBe("locked");
    expect(result.errors.join(" ")).toContain("lock-replaced-during-recovery");
    const replacement = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
    expect(replacement.transaction_id).toBe("replacement-live-tx");
    expect(replacement.pid).toBe(process.pid);
    expect(listLeftoverTransactionFiles(dir).filter((f) => f.includes(".vos-promote-claim-"))).toEqual([]);
  });

  it("keeps a moved dead record in a private claim directory and fails closed when the canonical path is re-acquired", () => {
    const { dir, preflight } = makePromotionFixture();
    const lockPath = path.join(dir, ".vos-promote.lock");
    writeDeadOwnerLock(dir, "dead-tx");
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      realFs().renameSync(from, to);
      if (String(to).includes("claimed-lock.json")) {
        // Another owner acquires the canonical path right after the claim.
        fs.writeFileSync(String(from), JSON.stringify({
          ...localLockIdentity("third-party-live-tx"),
        }));
      }
    });
    const result = draftAndPromote(dir, promotionDrafts() as never, {
      preflightHashes: preflight,
      guardKeys: ["brief_hash"],
    });
    expect(result.failure_kind).toBe("locked");
    expect(result.errors.join(" ")).toContain("canonical-reacquired-by-another-owner");
    expect(JSON.parse(fs.readFileSync(lockPath, "utf-8")).transaction_id).toBe("third-party-live-tx");
    // The claimed dead record is retained in the clearly-owned private claim
    // directory, which carries mode 0700.
    const claimDir = fs.readdirSync(dir).find((name) => name.startsWith(".vos-promote-claim-"));
    expect(claimDir).toBeDefined();
    const claimStat = fs.statSync(path.join(dir, claimDir!));
    expect(claimStat.mode & 0o777).toBe(0o700);
    expect(JSON.parse(fs.readFileSync(path.join(dir, claimDir!, "claimed-lock.json"), "utf-8")).transaction_id).toBe("dead-tx");
  });

  it("preserves pre-existing recovery evidence instead of overwriting it", () => {
    const { dir, preflight } = makePromotionFixture();
    const lockPath = path.join(dir, ".vos-promote.lock");
    writeDeadOwnerLock(dir, "dead-tx");
    // Pre-existing evidence at previously-predictable locations must never be
    // overwritten by the claim.
    const oldEvidence = path.join(dir, ".vos-promote-quarantine-dead-tx.lock");
    fs.writeFileSync(oldEvidence, "OLD-EVIDENCE-BYTES");
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      expect(fs.existsSync(to)).toBe(false); // claim destination proven absent
      realFs().renameSync(from, to);
    });
    const result = draftAndPromote(dir, promotionDrafts() as never, {
      preflightHashes: preflight,
      guardKeys: ["brief_hash"],
    });
    expect(result.success).toBe(true);
    expect(fs.readFileSync(oldEvidence, "utf-8")).toBe("OLD-EVIDENCE-BYTES");
  });

  it("recovers a lock whose exact recorded owner identity is provably dead", async () => {
    const { dir, preflight } = makePromotionFixture();
    const lockPath = path.join(dir, ".vos-promote.lock");
    const child = childProcess.spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    const childPid: number = child.pid as number;
    let childStartIdentity: string | null = null;
    for (let i = 0; i < 20 && childStartIdentity === null; i++) {
      try {
        childStartIdentity = readProcessStartIdentityFixture(childPid);
      } catch {
        childProcess.execSync("sleep 0.2");
      }
    }
    expect(childStartIdentity).not.toBeNull();
    fs.writeFileSync(lockPath, JSON.stringify({
      host: os.hostname(),
      pid: childPid,
      start_identity: childStartIdentity,
      transaction_id: "dead-owner-tx",
      acquired_at: new Date().toISOString(),
    }));
    child.kill();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5000);
      child.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });

    const recovered = draftAndPromote(dir, promotionDrafts() as never, {
      preflightHashes: snapshotArtifacts(dir).hashes,
      guardKeys: ["brief_hash"],
    });
    expect(recovered.success).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("keeps a spawned live owner authoritative, then recovers only after it is reaped", async () => {
    const { dir, preflight } = makePromotionFixture();
    const lockPath = path.join(dir, ".vos-promote.lock");
    const child = childProcess.spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    const childPid: number = child.pid as number;
    let childStartIdentity: string | null = null;
    for (let i = 0; i < 20 && childStartIdentity === null; i++) {
      try {
        childStartIdentity = readProcessStartIdentityFixture(childPid);
      } catch {
        childProcess.execSync("sleep 0.2");
      }
    }
    expect(childStartIdentity).not.toBeNull();
    fs.writeFileSync(lockPath, JSON.stringify({
      host: os.hostname(),
      pid: childPid,
      start_identity: childStartIdentity,
      transaction_id: "spawned-live-tx",
      acquired_at: new Date().toISOString(),
    }));

    const whileAlive = draftAndPromote(dir, promotionDrafts() as never, {
      preflightHashes: preflight,
      guardKeys: ["brief_hash"],
    });
    expect(whileAlive.failure_kind).toBe("locked");
    expect(fs.existsSync(lockPath)).toBe(true);

    child.kill();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5000);
      child.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    const afterDeath = draftAndPromote(dir, promotionDrafts() as never, {
      preflightHashes: snapshotArtifacts(dir).hashes,
      guardKeys: ["brief_hash"],
    });
    expect(afterDeath.success).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("does not let a PID-reused or different-start-identity process impersonate the recorded owner", () => {
    const { dir, preflight } = makePromotionFixture();
    const lockPath = path.join(dir, ".vos-promote.lock");
    // Records this live process's PID with a start identity that cannot be
    // ours: the recorded owner is a dead predecessor, so recovery proceeds.
    fs.writeFileSync(lockPath, JSON.stringify({
      host: os.hostname(),
      pid: process.pid,
      start_identity: "macos:lstart:predecessor-sentinel",
      transaction_id: "reused-pid-tx",
      acquired_at: new Date().toISOString(),
    }));

    const result = draftAndPromote(dir, promotionDrafts() as never, {
      preflightHashes: preflight,
      guardKeys: ["brief_hash"],
    });
    // A self-PID record with a foreign start identity is UNKNOWN (never dead
    // or stealable): the challenger fails closed and the lock is preserved.
    expect(result.success).toBe(false);
    expect(result.failure_kind).toBe("locked");
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(lockPath, "utf-8")).transaction_id).toBe("reused-pid-tx");
  });

  it("keeps a live owner authoritative across immutable-identity checks and old mtime", () => {
    const { dir, preflight } = makePromotionFixture();
    const lockPath = path.join(dir, ".vos-promote.lock");
    const identity = localLockIdentity();
    fs.writeFileSync(lockPath, JSON.stringify({
      ...identity,
      transaction_id: "live-owner-tx",
    }));
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, old, old);
    // The start identity is immutable: elapsed time and file age are never
    // positive proof of death.
    childProcess.execSync("sleep 1.1");

    const challenger = draftAndPromote(dir, promotionDrafts() as never, {
      preflightHashes: preflight,
      guardKeys: ["brief_hash"],
    });
    expect(challenger.failure_kind).toBe("locked");
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.readFileSync(lockPath, "utf-8")).toContain("live-owner-tx");
  });

  it("recovers across processes: a spawned child claims the dead-owner lock and completes the rollback", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "promote-tx-"));
    fs.mkdirSync(path.join(dir, "01_intent"), { recursive: true });
    fs.writeFileSync(path.join(dir, "01_intent/creative_brief.yaml"), 'version: "1"\nproject_id: tx-fixture\n');
    const reportPath = path.join(dir, "06_review/review_report.yaml");
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    const nonce = "cross-process-recovery-tx";
    const deadPid = 99999999;
    const deadOwner = {
      host: os.hostname(),
      pid: deadPid,
      start_identity: "macos:lstart:cross-process-dead-sentinel",
    };
    const stagedContent = "STAGED-REPORT";
    const priorContent = "PRIOR-REPORT";
    fs.writeFileSync(reportPath, stagedContent);
    const stagedStat = fs.lstatSync(reportPath);
    const journalDir = path.join(dir, `.vos-promote-journal-${nonce}`);
    const priorDir = path.join(journalDir, "prior");
    fs.mkdirSync(priorDir, { recursive: true, mode: 0o700 });
    const priorHash = bytesHashFixture(priorContent);
    const priorFile = path.join("prior", `${priorHash}.bin`);
    const priorPath = path.join(journalDir, priorFile);
    fs.writeFileSync(priorPath, priorContent);
    const priorStat = fs.lstatSync(priorPath);
    const entries = [{
      final: "06_review/review_report.yaml",
      staged_hash: bytesHashFixture(stagedContent),
      staged_ino: stagedStat.ino,
      staged_dev: stagedStat.dev,
      prior_hash: priorHash,
      prior_ino: priorStat.ino,
      prior_dev: priorStat.dev,
      had_prior: true,
      prior_file: priorFile,
    }];
    const recordedAt = new Date().toISOString();
    const journalPayload = {
      kind: "promote-transaction-journal",
      transaction_id: nonce,
      owner: deadOwner,
      phase: "intent",
      entries,
      recorded_at: recordedAt,
    };
    fs.writeFileSync(path.join(dir, ".vos-promote.lock"), JSON.stringify({
      ...deadOwner,
      transaction_id: nonce, acquired_at: new Date().toISOString(),
    }));
    fs.writeFileSync(path.join(journalDir, "journal.json"), JSON.stringify({
      ...journalPayload,
      record_digest: jsonDigestFixture({
        transaction_id: nonce,
        owner: deadOwner,
        phase: "intent",
        entries,
        recorded_at: recordedAt,
      }),
    }));
    // Crash state: the canonical path still contains the staged bytes and the
    // content-addressed prior copy is the only rollback source.

    // A NEW process performs the recovery: it proves the recorded owner dead,
    // claims the lock, verifies the journal, and restores the prior bytes.
    const scriptPath = path.join(dir, "recover-child.mts");
    fs.writeFileSync(scriptPath, `
      import { recoverPromoteTransaction } from "${path.resolve("runtime/commands/shared.ts").replace(/\\/g, "\\")}";
      const result = recoverPromoteTransaction(${JSON.stringify(dir)});
      process.stdout.write("CHILD-RESULT:" + JSON.stringify(result));
    `);
    const child = childProcess.spawnSync(
      process.execPath,
      ["--import", "tsx/esm", scriptPath],
      { encoding: "utf-8", cwd: process.cwd(), timeout: 60000 },
    );
    expect(child.status).toBe(0);
    const output = child.stdout.split("\n").find((line) => line.startsWith("CHILD-RESULT:"));
    expect(output).toBeDefined();
    const childResult = JSON.parse(output!.slice("CHILD-RESULT:".length)) as { recovered: boolean };
    expect(childResult.recovered).toBe(true);
    expect(fs.readFileSync(reportPath, "utf-8")).toBe("PRIOR-REPORT");
    expect(fs.existsSync(path.join(dir, ".vos-promote.lock"))).toBe(false);
    expect(fs.existsSync(journalDir)).toBe(false);
    fs.rmSync(scriptPath, { force: true });
  });

  it("uses the platform process identity source and fails closed for ambiguous ps output", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "promote-tx-"));
    fs.mkdirSync(path.join(dir, "01_intent"), { recursive: true });
    fs.writeFileSync(path.join(dir, "01_intent/creative_brief.yaml"), 'version: "1"\nproject_id: tx-fixture\n');
    // A fake `ps` that prints ambiguous multiline output for every query.
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "fake-ps-bin-"));
    const fakePs = path.join(fakeBin, "ps");
    fs.writeFileSync(fakePs, "#!/bin/sh\necho 'Mon Aug 30 10:00:00 2026'\necho 'Tue Aug 31 11:00:00 2026'\n");
    fs.chmodSync(fakePs, 0o755);
    const scriptPath = path.join(dir, "acquire-child.mts");
    fs.writeFileSync(scriptPath, `
      import { draftAndPromote } from "${path.resolve("runtime/commands/shared.ts").replace(/\\/g, "\\")}";
      import { snapshotArtifacts } from "${path.resolve("runtime/state/reconcile.ts").replace(/\\/g, "\\")}";
      const preflight = snapshotArtifacts(${JSON.stringify(dir)}).hashes;
      const result = draftAndPromote(${JSON.stringify(dir)}, [
        { relativePath: "01_intent/unresolved_blockers.yaml", schemaFile: "unresolved-blockers.schema.json", content: { version: "1", project_id: "tx-fixture", blockers: [] }, format: "yaml" },
      ], { preflightHashes: preflight, guardKeys: ["brief_hash"] });
      process.stdout.write("CHILD-RESULT:" + JSON.stringify({ success: result.success, kind: result.failure_kind, errors: result.errors }));
    `);
    const child = childProcess.spawnSync(
      process.execPath,
      ["--import", "tsx/esm", scriptPath],
      {
        encoding: "utf-8",
        cwd: process.cwd(),
        timeout: 60000,
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
      },
    );
    const output = child.stdout.split("\n").find((line) => line.startsWith("CHILD-RESULT:"));
    expect(output).toBeDefined();
    const childResult = JSON.parse(output!.slice("CHILD-RESULT:".length)) as { success: boolean; kind?: string; errors: string[] };
    if (process.platform === "linux") {
      // Linux uses the kernel start tick from /proc, so a fake ps must not
      // affect promotion or weaken the native identity path.
      expect(childResult.success).toBe(true);
      expect(childResult.errors).toEqual([]);
    } else {
      // Darwin (and the ps fallback) treats ambiguous self identity as
      // unknown and fails closed without writing a placeholder lock record.
      expect(childResult.success).toBe(false);
      expect(childResult.errors.join(" ")).toContain("process-start identity");
    }
    expect(fs.existsSync(path.join(dir, ".vos-promote.lock"))).toBe(false);
    fs.rmSync(fakeBin, { recursive: true, force: true });
    fs.rmSync(scriptPath, { force: true });
  });

  it("stably closes every observed descriptor across repeated refusal attempts", () => {
    const { dir, preflight } = makePromotionFixture();
    const lockPath = path.join(dir, ".vos-promote.lock");
    const partial = JSON.stringify({
      host: os.hostname(),
      pid: 99999999,
      start_identity: "macos:lstart:dead-sentinel",
      acquired_at: new Date().toISOString(),
      // transaction_id deliberately missing -> unknown, fail closed
    });
    const liveOther = childProcess.spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    const liveOtherPid: number = liveOther.pid as number;
    let liveOtherIdentity: string | null = null;
    for (let i = 0; i < 20 && liveOtherIdentity === null; i++) {
      try {
        liveOtherIdentity = readProcessStartIdentityFixture(liveOtherPid);
      } catch {
        childProcess.execSync("sleep 0.2");
      }
    }
    expect(liveOtherIdentity).not.toBeNull();

    const countFds = (): number => {
      return childProcess.execFileSync("lsof", ["-p", String(process.pid)], { encoding: "utf-8" })
        .split("\n").filter((line) => line.trim().length > 0).length;
    };
    const attempts: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 12; i++) {
      attempts.push({ partial: true });
    }
    let fdCountBefore: number | null = null;
    let fdCountAfter: number | null = null;
    try {
      for (let i = 0; i < 25; i++) {
        if (i < 13) {
          fs.writeFileSync(lockPath, partial);
        } else {
          // Live non-self owner refusals interleave with partial refusals.
          fs.writeFileSync(lockPath, JSON.stringify({
            host: os.hostname(),
            pid: liveOtherPid,
            start_identity: liveOtherIdentity,
            transaction_id: `live-other-${i}`,
            acquired_at: new Date().toISOString(),
          }));
        }
        if (i === 0) fdCountBefore = countFds();
        const result = draftAndPromote(dir, promotionDrafts() as never, {
          preflightHashes: preflight,
          guardKeys: ["brief_hash"],
        });
        expect(result.failure_kind).toBe("locked");
        if (i === 24) fdCountAfter = countFds();
      }
      expect(fdCountAfter).toBe(fdCountBefore);
    } finally {
      liveOther.kill();
    }
  });

});
