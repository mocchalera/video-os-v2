// Issue #11 Phase 2 M2B — assembly-loss project adapter + CLI tests.
//
// Contract under test: connect the accepted pure core (M2A
// evaluateAssemblyLoss) to real project artifacts via the existing
// validated loaders, and produce a hash-pinned NON-canonical diagnostic
// report (assembly-loss-report/v1) plus a practical CLI.
//
// Key invariants:
//  - Required inputs: brief/selects/blueprint/timeline via validated loaders.
//  - Transcripts: TR_*.json filename-sorted, lossless map of
//    transcript_ref/asset_id/items -> transcript_id/asset_id/utterances.
//    Directory absent / 0 files => fail-open; present-but-malformed =>
//    fail-closed.
//  - source_artifacts: raw-byte SHA256 + project-relative path, sorted,
//    envelope head; absolute paths never appear in the report.
//  - Determinism: same input + policy => identical JSON/MD bytes and paths;
//    basename derives from sanitized project id + input/policy hash prefixes.
//  - Writes: JSON + MD + detached .sha256 sidecars, atomic temp+rename,
//    no self-hash inside the report. --no-write creates nothing.
//  - HOLD is a valid diagnostic: exit 0 with the explicit grounding note.
//    Only input/IO/validation errors exit 1.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ASSEMBLY_LOSS_HOLD_NOTE,
  ASSEMBLY_LOSS_REPORT_KIND,
  assemblyLossBasename,
  buildAssemblyLossProjectReport,
  ensureOutputDirOutsideProject,
  loadProjectInputs,
  main,
  parseAssemblyLossProjectArgs,
  renderAssemblyLossMarkdown,
  reportVerdict,
  runAssemblyLossCli,
  writeAssemblyLossOutputs,
} from "../runtime/eval/assembly-loss-project.js";
import { vi } from "vitest";

const PROJECT_ID = "fixture-p1";
const CANONICAL_TEMP_ROOT = fs.realpathSync(os.tmpdir());

let root: string;
let projectDir: string;

function sha256(bytes: Buffer | string): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** Directory listing without macOS AppleDouble ("._*") metadata entries. */
function listFiles(dir: string): string[] {
  return fs.readdirSync(dir).filter((name) => !name.startsWith("._"));
}

function writeBytes(relPath: string, content: string): void {
  const abs = path.join(projectDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function briefYaml(): string {
  return [
    'version: "1"',
    `project_id: ${PROJECT_ID}`,
    "project:",
    `  id: ${PROJECT_ID}`,
    "  title: Fixture",
    "  strategy: s",
    "  client: c",
    "  format: vertical",
    "  runtime_target_sec: 30",
    "  duration_mode: guide",
    "message:",
    "  primary: m",
    "audience:",
    "  primary: a",
    'emotion_curve: ["opening", "middle", "closing"]',
    'must_have: ["x"]',
    'must_avoid: ["y"]',
    "autonomy:",
    "  may_decide: []",
    "  must_ask: []",
    'resolved_assumptions: ["assumed for fixture"]',
    "",
  ].join("\n");
}

function selectsYaml(coverageStatus: "met" | "failed" = "met"): string {
  return [
    'version: "1"',
    `project_id: ${PROJECT_ID}`,
    "candidates:",
    "  - segment_id: seg1",
    "    candidate_id: CAND1",
    "    asset_id: A",
    "    src_in_us: 0",
    "    src_out_us: 2000000",
    "    role: hero",
    '    why_it_matches: "fixture"',
    "    risks: []",
    "    confidence: 1",
    "coverage:",
    '  version: "1"',
    "  policy: test",
    `  status: ${coverageStatus}`,
    "  config:",
    "    min_candidates_per_cluster: 1",
    "    cluster_sampling_scale: none",
    "    max_candidates_per_cluster: 5",
    "  clusters: []",
    "  must_have: []",
    "  unmet: []",
    "",
  ].join("\n");
}

function blueprintYaml(): string {
  return [
    'version: "1"',
    `project_id: ${PROJECT_ID}`,
    "sequence_goals: []",
    "beats:",
    "  - id: b1",
    "    label: main",
    "    target_duration_frames: 60",
    '    required_roles: ["hero"]',
    "    story_role: experience",
    "pacing:",
    "  opening_cadence: a",
    "  middle_cadence: b",
    "  ending_cadence: c",
    "music_policy:",
    "  start_sparse: true",
    "  allow_release_late: false",
    "  entry_beat: x",
    "dialogue_policy:",
    "  preserve_natural_breath: true",
    "  avoid_wall_to_wall_voiceover: true",
    "",
  ].join("\n");
}

function timelineJson(): string {
  return `${JSON.stringify(
    {
      version: "1",
      project_id: PROJECT_ID,
      created_at: "2026-01-01T00:00:00Z",
      sequence: {
        name: "seq",
        fps_num: 30,
        fps_den: 1,
        width: 1080,
        height: 1920,
        start_frame: 0,
      },
      tracks: {
        video: [
          {
            track_id: "V1",
            kind: "video",
            clips: [
              {
                clip_id: "c1",
                segment_id: "seg1",
                asset_id: "A",
                src_in_us: 0,
                src_out_us: 2000000,
                timeline_in_frame: 0,
                timeline_duration_frames: 60,
                role: "hero",
                motivation: "fixture",
                beat_id: "b1",
                fallback_segment_ids: [],
                confidence: 1,
                quality_flags: [],
              },
            ],
          },
        ],
        audio: [],
      },
      markers: [],
      provenance: {
        brief_path: "01_intent/creative_brief.yaml",
        blueprint_path: "04_plan/edit_blueprint.yaml",
        selects_path: "04_plan/selects_candidates.yaml",
        compiler_version: "test",
      },
    },
    null,
    2,
  )}\n`;
}

function transcriptJson(): string {
  return `${JSON.stringify({
    project_id: PROJECT_ID,
    artifact_version: "1",
    transcript_ref: "TR_A",
    asset_id: "A",
    items: [
      {
        item_id: "i1",
        speaker: "s0",
        speaker_key: "s0",
        start_us: 0,
        end_us: 1000000,
        text: "hello world",
      },
    ],
    analysis_status: "ok",
    word_timing_mode: "word",
    provenance: {
      stage: "stt",
      method: "openai",
      connector_version: "1",
      policy_hash: "h",
      request_hash: "r",
      model_alias: "m",
    },
  })}\n`;
}

/** Schema-valid analysis-coverage-report instance (analysis-coverage-report.schema.json). */
function coverageReportJson(summaryStatus: "ready" | "partial_override" | "blocked"): string {
  return `${JSON.stringify({
    version: "1.0.0",
    project_id: PROJECT_ID,
    artifact_version: "analysis-v1",
    created_at: "2026-01-01T00:00:00Z",
    source_media_manifest_hash: `sha256:${"a".repeat(64)}`,
    summary: {
      status: summaryStatus,
      required_lane_count: 1,
      ready_lane_count: summaryStatus === "ready" ? 1 : 0,
      blocked_lane_count: 0,
      partial_lane_count: 0,
    },
    lanes: [],
    assets: [],
    blockers: [],
    overrides: [],
    provenance: {
      producer: "analysis-pipeline",
      inputs: [],
      hash_policy: {},
    },
  })}\n`;
}

/** Write a complete valid fixture project. Returns nothing; uses module state. */
function writeFullProject(options?: { coverageStatus?: "met" | "failed"; withTranscripts?: boolean }): void {
  writeBytes("01_intent/creative_brief.yaml", briefYaml());
  writeBytes("04_plan/selects_candidates.yaml", selectsYaml(options?.coverageStatus ?? "met"));
  writeBytes("04_plan/edit_blueprint.yaml", blueprintYaml());
  writeBytes("05_timeline/timeline.json", timelineJson());
  if (options?.withTranscripts !== false) {
    writeBytes("03_analysis/transcripts/TR_A.json", transcriptJson());
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(CANONICAL_TEMP_ROOT, "assembly-loss-m2b-"));
  projectDir = path.join(root, "project");
  fs.mkdirSync(projectDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("assembly-loss project loader", () => {
  it("loads required artifacts via validated loaders and maps transcripts losslessly", () => {
    writeFullProject();
    const inputs = loadProjectInputs(projectDir);

    expect(inputs.brief.project_id).toBe(PROJECT_ID);
    expect(inputs.selects.candidates[0]?.segment_id).toBe("seg1");
    expect(inputs.blueprint.beats[0]?.id).toBe("b1");
    expect(inputs.timeline.sequence.fps_num).toBe(30);

    expect(inputs.transcripts).toHaveLength(1);
    expect(inputs.transcripts[0]).toEqual({
      transcript_id: "TR_A",
      asset_id: "A",
      utterances: [{ speaker: "s0", start_us: 0, end_us: 1000000, text: "hello world" }],
    });
  });

  it("records sorted raw-byte source artifact hashes with project-relative paths", () => {
    writeFullProject();
    const inputs = loadProjectInputs(projectDir);

    const paths = inputs.sourceArtifacts.map((a) => a.path);
    expect(paths).toEqual([
      "01_intent/creative_brief.yaml",
      "03_analysis/transcripts/TR_A.json",
      "04_plan/edit_blueprint.yaml",
      "04_plan/selects_candidates.yaml",
      "05_timeline/timeline.json",
    ]);
    for (const artifact of inputs.sourceArtifacts) {
      const raw = fs.readFileSync(path.join(projectDir, artifact.path));
      expect(artifact.sha256).toBe(sha256(raw));
      expect(path.isAbsolute(artifact.path)).toBe(false);
    }
  });

  it("fails open when transcripts dir is absent or empty (optional absent)", () => {
    writeFullProject({ withTranscripts: false });
    const inputs = loadProjectInputs(projectDir);
    expect(inputs.transcripts).toEqual([]);
    expect(inputs.analysisCoverage).toBeNull();

    // Empty transcripts directory also fails open.
    fs.mkdirSync(path.join(projectDir, "03_analysis/transcripts"), { recursive: true });
    const empty = loadProjectInputs(projectDir);
    expect(empty.transcripts).toEqual([]);
  });

  it("validates the default coverage report against the schema and normalizes summary.status to top-level status", () => {
    writeFullProject({ withTranscripts: false });
    writeBytes("03_analysis/analysis_coverage_report.json", coverageReportJson("ready"));
    const inputs = loadProjectInputs(projectDir);
    expect(inputs.analysisCoverage?.status).toBe("ready");
    expect(inputs.analysisCoverage?.summary).toEqual(
      (JSON.parse(coverageReportJson("ready")) as { summary: unknown }).summary,
    );
    const coverage = inputs.sourceArtifacts.find(
      (a) => a.path === "03_analysis/analysis_coverage_report.json",
    );
    expect(coverage?.sha256).toBe(sha256(fs.readFileSync(path.join(projectDir, "03_analysis/analysis_coverage_report.json"))));
  });

  it("fails closed when the present coverage report misses the required shape or enum", () => {
    writeFullProject({ withTranscripts: false });
    // Missing required fields entirely.
    writeBytes("03_analysis/analysis_coverage_report.json", '{"status":"ready"}\n');
    expect(() => loadProjectInputs(projectDir)).toThrow();

    // summary.status outside the schema enum.
    writeBytes("03_analysis/analysis_coverage_report.json", coverageReportJson("ready").replace('"status":"ready"', '"status":"bogus"'));
    expect(() => loadProjectInputs(projectDir)).toThrow();
  });

  it("goes HOLD when the analysis coverage summary.status is not ready", () => {
    writeFullProject();
    writeBytes("03_analysis/analysis_coverage_report.json", coverageReportJson("blocked"));
    const report = buildAssemblyLossProjectReport(loadProjectInputs(projectDir));
    expect(reportVerdict(report)).toBe("HOLD");
    expect(report.note).toBe(ASSEMBLY_LOSS_HOLD_NOTE);
  });

  it("uses the fixed logical locator @external/analysis-coverage for out-of-project overrides", () => {
    writeFullProject({ withTranscripts: false });
    const externalDir = path.join(root, "elsewhere");
    fs.mkdirSync(externalDir, { recursive: true });
    const override = path.join(externalDir, "cov.json");
    fs.writeFileSync(override, coverageReportJson("ready"));

    const inputs = loadProjectInputs(projectDir, { analysisCoverageOverride: override });
    expect(inputs.analysisCoverage?.status).toBe("ready");
    const entry = inputs.sourceArtifacts.find((a) => a.path === "@external/analysis-coverage");
    expect(entry?.sha256).toBe(sha256(fs.readFileSync(override)));
    const serialized = JSON.stringify(inputs.sourceArtifacts);
    expect(serialized).not.toContain("..");
    expect(serialized).not.toContain(root);

    // In-project overrides keep their real project-relative locator.
    const inside = path.join(projectDir, "cov-override.json");
    fs.writeFileSync(inside, coverageReportJson("ready"));
    const inInputs = loadProjectInputs(projectDir, { analysisCoverageOverride: inside });
    expect(inInputs.sourceArtifacts.map((a) => a.path)).toContain("cov-override.json");
  });

  it("reads every input file exactly once (hash and parse share one Buffer)", () => {
    writeFullProject();
    writeBytes("03_analysis/analysis_coverage_report.json", coverageReportJson("ready"));
    const counts = new Map<string, number>();
    const readFile = (filePath: string): Buffer => {
      const key = path.relative(projectDir, filePath);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return fs.readFileSync(filePath);
    };
    loadProjectInputs(projectDir, { readFile });
    expect([...counts.entries()].sort()).toEqual([
      ["01_intent/creative_brief.yaml", 1],
      ["03_analysis/analysis_coverage_report.json", 1],
      ["03_analysis/transcripts/TR_A.json", 1],
      ["04_plan/edit_blueprint.yaml", 1],
      ["04_plan/selects_candidates.yaml", 1],
      ["05_timeline/timeline.json", 1],
    ]);
  });

  it("fails closed on malformed present transcripts (bad JSON, bad shape, bad item)", () => {
    writeFullProject();
    writeBytes("03_analysis/transcripts/TR_A.json", "{not json");

    expect(() => loadProjectInputs(projectDir)).toThrow(/TR_A\.json/);

    // Missing asset_id.
    const bad = JSON.parse(transcriptJson()) as Record<string, unknown>;
    delete bad.asset_id;
    writeBytes("03_analysis/transcripts/TR_A.json", JSON.stringify(bad));
    expect(() => loadProjectInputs(projectDir)).toThrow(/TR_A\.json/);

    // Non-finite utterance timing.
    const badItem = JSON.parse(transcriptJson()) as { items: Array<Record<string, unknown>> };
    badItem.items[0].start_us = "zero";
    writeBytes("03_analysis/transcripts/TR_A.json", JSON.stringify(badItem));
    expect(() => loadProjectInputs(projectDir)).toThrow(/TR_A\.json/);
  });

  it("rejects transcript symlinks and project-artifact ancestor symlink escapes", () => {
    writeFullProject();
    const transcriptPath = path.join(projectDir, "03_analysis/transcripts/TR_A.json");
    const externalTranscript = path.join(root, "external-transcript.json");
    fs.writeFileSync(externalTranscript, transcriptJson());
    fs.unlinkSync(transcriptPath);
    fs.symlinkSync(externalTranscript, transcriptPath);
    expect(() => loadProjectInputs(projectDir)).toThrow(/symlink|escape/);

    fs.unlinkSync(transcriptPath);
    fs.writeFileSync(transcriptPath, transcriptJson());
    const planDir = path.join(projectDir, "04_plan");
    const escapedPlanDir = path.join(root, "escaped-plan");
    fs.renameSync(planDir, escapedPlanDir);
    fs.symlinkSync(escapedPlanDir, planDir);
    expect(() => loadProjectInputs(projectDir)).toThrow(/symlink|escape/);
  });

  it("rejects an input path swap after the single Buffer read", () => {
    writeFullProject();
    const transcriptPath = path.join(projectDir, "03_analysis/transcripts/TR_A.json");
    const replacement = path.join(root, "replacement-transcript.json");
    fs.writeFileSync(replacement, transcriptJson());

    const readFile = (filePath: string): Buffer => {
      const bytes = fs.readFileSync(filePath);
      if (filePath === transcriptPath) {
        fs.unlinkSync(filePath);
        fs.symlinkSync(replacement, filePath);
      }
      return bytes;
    };
    expect(() => loadProjectInputs(projectDir, { readFile })).toThrow(/symlink|identity changed/);
  });

  it("fails closed when a required artifact is missing or malformed", () => {
    writeFullProject();
    fs.rmSync(path.join(projectDir, "05_timeline/timeline.json"));
    expect(() => loadProjectInputs(projectDir)).toThrow();

    writeBytes("05_timeline/timeline.json", "{}\n");
    expect(() => loadProjectInputs(projectDir)).toThrow();
  });

  it("fails closed on an explicitly supplied malformed coverage override", () => {
    writeFullProject({ withTranscripts: false });
    const override = path.join(root, "override-coverage.json");
    fs.writeFileSync(override, "{broken");
    expect(() => loadProjectInputs(projectDir, { analysisCoverageOverride: override })).toThrow();
  });

  it("fails closed on a missing explicitly supplied coverage override", () => {
    writeFullProject({ withTranscripts: false });
    const override = path.join(root, "does-not-exist.json");
    expect(() => loadProjectInputs(projectDir, { analysisCoverageOverride: override })).toThrow();
  });
});

describe("assembly-loss project report envelope", () => {
  it("wraps the accepted core report as a noncanonical v1 diagnostic with envelope-head source artifacts", () => {
    writeFullProject();
    const inputs = loadProjectInputs(projectDir);
    const report = buildAssemblyLossProjectReport(inputs);

    expect(report.report_kind).toBe(ASSEMBLY_LOSS_REPORT_KIND);
    expect(report.canonical).toBe(false);
    expect(report.project_id).toBe(PROJECT_ID);
    expect(report.accepted_core_report.evaluator_version).toBe("assembly-loss/v1");
    expect(reportVerdict(report)).toBe("READY");
    // Envelope head: source artifacts come first in the serialized form.
    const serialized = JSON.stringify(report);
    expect(serialized.indexOf("source_artifacts")).toBeLessThan(
      serialized.indexOf("accepted_core_report"),
    );
    expect(report.note).toBeUndefined();
  });

  it("rejects tampered input, policy, or evaluator identity before rendering or writing", () => {
    writeFullProject();
    const original = buildAssemblyLossProjectReport(loadProjectInputs(projectDir));
    const mutations: Array<(report: typeof original) => void> = [
      (report) => { report.accepted_core_report.input_hash = "0".repeat(64); },
      (report) => { report.accepted_core_report.policy_hash = "0".repeat(64); },
      (report) => {
        (report.accepted_core_report as { evaluator_version: string }).evaluator_version = "assembly-loss/tampered";
      },
    ];

    for (const mutate of mutations) {
      const report = structuredClone(original);
      mutate(report);
      expect(() => renderAssemblyLossMarkdown(report)).toThrow(/report identity mismatch/);
      expect(() => writeAssemblyLossOutputs(report, path.join(root, "tamper-out"))).toThrow(
        /report identity mismatch/,
      );
    }
    expect(fs.existsSync(path.join(root, "tamper-out"))).toBe(false);
  });

  it("rejects double-sided core, source-ledger, and metric tampering", () => {
    writeFullProject();
    const original = buildAssemblyLossProjectReport(loadProjectInputs(projectDir));
    const mutations: Array<(report: typeof original) => void> = [
      (report) => {
        report.report_identity.input_hash = "0".repeat(64);
        report.accepted_core_report.input_hash = "0".repeat(64);
      },
      (report) => {
        report.source_artifacts[0].sha256 = "0".repeat(64);
      },
      (report) => {
        report.accepted_core_report.measurements.story_role_order.observed_order.push("tampered");
      },
      (report) => {
        report.report_identity.input_hash = "f".repeat(64);
        report.accepted_core_report.input_hash = "f".repeat(64);
        report.source_artifacts[0].sha256 = "f".repeat(64);
        report.accepted_core_report.measurements.story_role_order.observed_order.push("tampered");
      },
    ];

    for (const mutate of mutations) {
      const report = structuredClone(original);
      mutate(report);
      expect(() => renderAssemblyLossMarkdown(report)).toThrow(/report identity mismatch/);
      expect(() => writeAssemblyLossOutputs(report, path.join(root, "double-tamper"))).toThrow(
        /report identity mismatch/,
      );
    }
    expect(fs.existsSync(path.join(root, "double-tamper"))).toBe(false);
  });

  it("emits the exact grounding-failure note on HOLD and keeps it a valid diagnostic", () => {
    writeFullProject({ coverageStatus: "failed" });
    const inputs = loadProjectInputs(projectDir);
    const report = buildAssemblyLossProjectReport(inputs);
    expect(reportVerdict(report)).toBe("HOLD");
    expect(report.note).toBe(ASSEMBLY_LOSS_HOLD_NOTE);
    expect(report.note).toContain("接地失敗下の観測であり");
    expect(report.note).toContain("auto assemblyの評価としては未確定");
  });

  it("never embeds wall-clock time, RNG values, or absolute paths", () => {
    writeFullProject();
    const inputs = loadProjectInputs(projectDir);
    const report = buildAssemblyLossProjectReport(inputs);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain(projectDir);
    expect(serialized).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  it("passes through causal refs, human reference, wall clock, and tolerance policy", () => {
    writeFullProject();
    const inputs = loadProjectInputs(projectDir);
    const report = buildAssemblyLossProjectReport(inputs, {
      causalRefs: [{ from_beat_id: "b1", to_beat_id: "b2" }],
      humanReference: { label: "human", clips: [{ segment_id: "seg1" }] },
      wallClock: { select: 12.5 },
      asrToleranceUs: 100000,
    });
    expect(report.accepted_core_report.policy.asr_tolerance_us).toBe(100000);
    expect(report.accepted_core_report.measurements.wall_clock_breakdown).toEqual({ select: 12.5 });
    expect(report.accepted_core_report.measurements.human_structural_change.available).toBe(true);
    expect(report.accepted_core_report.measurements.setup_payoff.causal_edge_evidence).toBe("absent");
  });
});

describe("assembly-loss deterministic output", () => {
  it("derives the basename from sanitized project id + input/policy hash prefixes", () => {
    writeFullProject();
    const inputs = loadProjectInputs(projectDir);
    const report = buildAssemblyLossProjectReport(inputs);
    const base = assemblyLossBasename(report);
    expect(base).toBe(
      `assembly-loss-${PROJECT_ID}-${report.accepted_core_report.input_hash.slice(0, 12)}-${report.accepted_core_report.policy_hash.slice(0, 12)}`,
    );
  });

  it("changes the basename when the input changes (input prefix)", () => {
    writeFullProject();
    const first = buildAssemblyLossProjectReport(loadProjectInputs(projectDir));
    writeBytes("05_timeline/timeline.json", timelineJson().replace('"timeline_duration_frames": 60', '"timeline_duration_frames": 90'));
    const second = buildAssemblyLossProjectReport(loadProjectInputs(projectDir));
    expect(assemblyLossBasename(second)).not.toBe(assemblyLossBasename(first));
    expect(second.accepted_core_report.input_hash).not.toBe(first.accepted_core_report.input_hash);
    expect(second.accepted_core_report.policy_hash).toBe(first.accepted_core_report.policy_hash);
  });

  it("changes the basename when the tolerance policy changes (policy prefix)", () => {
    writeFullProject();
    const first = buildAssemblyLossProjectReport(loadProjectInputs(projectDir));
    const second = buildAssemblyLossProjectReport(loadProjectInputs(projectDir), { asrToleranceUs: 100000 });
    expect(assemblyLossBasename(second)).not.toBe(assemblyLossBasename(first));
    expect(second.accepted_core_report.input_hash).toBe(first.accepted_core_report.input_hash);
    expect(second.accepted_core_report.policy_hash).not.toBe(first.accepted_core_report.policy_hash);
  });

  it("writes JSON + MD + two detached sidecars atomically with verifiable raw hashes and no self-hash", () => {
    writeFullProject();
    const outDir = path.join(root, "out");
    const report = buildAssemblyLossProjectReport(loadProjectInputs(projectDir));
    const base = assemblyLossBasename(report);
    const written = writeAssemblyLossOutputs(report, outDir);

    const files = listFiles(outDir).sort();
    expect(files).toHaveLength(4);
    expect(files).toEqual([
      `${base}.json`,
      `${base}.json.sha256`,
      `${base}.md`,
      `${base}.md.sha256`,
    ]);

    // Sidecar format: "<hex>  <basename>\n" and hashes match raw bytes.
    const jsonBytes = fs.readFileSync(written.jsonPath);
    const mdBytes = fs.readFileSync(written.mdPath);
    expect(fs.readFileSync(written.jsonSha256Path, "utf-8")).toBe(`${sha256(jsonBytes)}  ${base}.json\n`);
    expect(fs.readFileSync(written.mdSha256Path, "utf-8")).toBe(`${sha256(mdBytes)}  ${base}.md\n`);

    // No self-hash anywhere inside the report payload.
    const jsonText = jsonBytes.toString("utf-8");
    expect(jsonText).not.toContain(sha256(jsonBytes));
    expect(jsonText).not.toContain(sha256(mdBytes));

    // Markdown renders deterministically from the same report.
    expect(mdBytes.toString("utf-8")).toBe(renderAssemblyLossMarkdown(report));
  });

  it("is byte-identical across reruns with the same input and writes to the same paths", () => {
    writeFullProject();
    const outA = path.join(root, "out-a");
    const outB = path.join(root, "out-b");
    const a = writeAssemblyLossOutputs(buildAssemblyLossProjectReport(loadProjectInputs(projectDir)), outA);
    const b = writeAssemblyLossOutputs(buildAssemblyLossProjectReport(loadProjectInputs(projectDir)), outB);

    expect(a.jsonPath).toBe(path.join(outA, `${path.basename(b.jsonPath)}`));
    expect(fs.readFileSync(a.jsonPath)).toEqual(fs.readFileSync(b.jsonPath));
    expect(fs.readFileSync(a.mdPath)).toEqual(fs.readFileSync(b.mdPath));
  });

  it("leaves no temp files behind after writing", () => {
    writeFullProject();
    const outDir = path.join(root, "out");
    writeAssemblyLossOutputs(buildAssemblyLossProjectReport(loadProjectInputs(projectDir)), outDir);
    const entries = listFiles(outDir);
    expect(entries.every((name) => !name.includes(".tmp"))).toBe(true);
  });

  it("rejects output symlinks, symlinked parents, and a pre-install path swap", () => {
    writeFullProject();
    const report = buildAssemblyLossProjectReport(loadProjectInputs(projectDir));
    const reviewDir = path.join(projectDir, "06_review");
    fs.mkdirSync(reviewDir, { recursive: true });

    const volumeRootLike = path.join(root, "volume-root-like-output");
    const volumeRootParent = path.dirname(path.resolve(volumeRootLike));
    const realStat = fs.statSync.bind(fs);
    const statSync = (filePath: string): Pick<fs.Stats, "dev"> => {
      const stat = realStat(filePath);
      return path.resolve(filePath) === volumeRootParent ? { dev: stat.dev + 1 } : stat;
    };
    expect(() => writeAssemblyLossOutputs(report, volumeRootLike, { statSync })).toThrow(
      /subdirectory on the same volume|volume root/,
    );
    expect(listFiles(volumeRootLike)).toEqual([]);

    const outputLink = path.join(root, "output-link");
    fs.symlinkSync(reviewDir, outputLink);
    expect(() => ensureOutputDirOutsideProject(outputLink, projectDir)).toThrow(/symlink|project/);
    expect(listFiles(reviewDir)).toEqual([]);

    const safeOutput = path.join(root, "safe-output");
    fs.mkdirSync(safeOutput);
    const parentLink = path.join(root, "parent-link");
    fs.symlinkSync(safeOutput, parentLink);
    expect(() => ensureOutputDirOutsideProject(path.join(parentLink, "nested"), projectDir)).toThrow(/symlink/);

    const swappedOutput = path.join(root, "swapped-output");
    let hookCalled = false;
    expect(() => writeAssemblyLossOutputs(report, swappedOutput, {
      projectDir,
      beforeInstall: () => {
        hookCalled = true;
        fs.renameSync(swappedOutput, `${swappedOutput}-staged`);
        fs.symlinkSync(reviewDir, swappedOutput);
      },
    })).toThrow(/symlink|project|changed/);
    expect(hookCalled).toBe(true);
    expect(listFiles(`${swappedOutput}-staged`).filter((name) => name.includes(".tmp"))).toEqual([]);
    expect(listFiles(reviewDir)).toEqual([]);
  });

  it("restores all previous outputs and removes new installs when an install stage fails", () => {
    writeFullProject();
    const outDir = path.join(root, "out-tx");
    const report = buildAssemblyLossProjectReport(loadProjectInputs(projectDir));
    const base = assemblyLossBasename(report);

    // Pre-existing outputs from a previous run.
    fs.mkdirSync(outDir, { recursive: true });
    const targets = [`${base}.json`, `${base}.md`, `${base}.json.sha256`, `${base}.md.sha256`];
    for (const name of targets) {
      fs.writeFileSync(path.join(outDir, name), `OLD-${name}`);
    }

    let calls = 0;
    const realRename = fs.renameSync.bind(fs);
    const failingRename = (from: string, to: string): void => {
      calls += 1;
      if (calls === 3) throw new Error("boom: install failed mid-transaction");
      realRename(from, to);
    };

    expect(() => writeAssemblyLossOutputs(report, outDir, { renameSync: failingRename })).toThrow(
      /install failed mid-transaction/,
    );

    // All four previous files restored byte-identically; no partial installs.
    for (const name of targets) {
      expect(fs.readFileSync(path.join(outDir, name), "utf-8")).toBe(`OLD-${name}`);
    }
    // No temp files survive.
    expect(listFiles(outDir).every((name) => !name.includes(".tmp"))).toBe(true);
  });
});

describe("assembly-loss CLI", () => {
  function cliArgs(extra: string[] = []): string[] {
    return [projectDir, ...extra];
  }

  it("parses args with defaults", () => {
    const args = parseAssemblyLossProjectArgs(cliArgs());
    expect(args.projectDir).toBe(projectDir);
    expect(args.outputDir).toBe("reports/eval");
    expect(args.noWrite).toBe(false);
  });

  it("loads file-backed human-reference and wall-clock evidence with raw-byte provenance", () => {
    writeFullProject();
    const humanPath = path.join(root, "human.json");
    const wallPath = path.join(root, "wall.json");
    const humanBytes = `${JSON.stringify({ label: "operator", clips: [{ segment_id: "seg1" }] })}\n`;
    const wallBytes = `${JSON.stringify({ compile_sec: 1.25 })}\n`;
    fs.writeFileSync(humanPath, humanBytes);
    fs.writeFileSync(wallPath, wallBytes);

    const args = parseAssemblyLossProjectArgs(cliArgs([
      "--human-reference-file", humanPath,
      "--wall-clock-file", wallPath,
    ]));
    expect(args.humanReferenceFile).toBe(humanPath);
    expect(args.wallClockFile).toBe(wallPath);

    const inputs = loadProjectInputs(projectDir, {
      humanReferenceFile: humanPath,
      wallClockFile: wallPath,
    });
    expect(inputs.humanReference).toEqual({
      label: "operator",
      clips: [{ segment_id: "seg1" }],
    });
    expect(inputs.wallClock).toEqual({ compile_sec: 1.25 });
    expect(inputs.sourceArtifacts).toContainEqual({
      path: "cli-inputs/human-reference.json",
      sha256: sha256(humanBytes),
    });
    expect(inputs.sourceArtifacts).toContainEqual({
      path: "cli-inputs/wall-clock.json",
      sha256: sha256(wallBytes),
    });
  });

  it("enforces inline/file mutual exclusion for optional evidence", () => {
    expect(() => parseAssemblyLossProjectArgs(cliArgs([
      "--human-reference", '{"clips":[]}',
      "--human-reference-file", "/tmp/human.json",
    ]))).toThrow(/mutually exclusive|supplied twice/);
    expect(() => parseAssemblyLossProjectArgs(cliArgs([
      "--wall-clock", '{}',
      "--wall-clock-file", "/tmp/wall.json",
    ]))).toThrow(/mutually exclusive|supplied twice/);
  });

  it("rejects invalid args", () => {
    expect(() => parseAssemblyLossProjectArgs([])).toThrow(); // no project dir
    expect(() => parseAssemblyLossProjectArgs(cliArgs(["--unknown-flag"]))).toThrow();
    expect(() => parseAssemblyLossProjectArgs(cliArgs(["--causal-refs", "{not json"]))).toThrow();
    expect(() => parseAssemblyLossProjectArgs(cliArgs(["--asr-tolerance-us", "-5"]))).toThrow();
    expect(() => parseAssemblyLossProjectArgs(cliArgs(["--wall-clock", '{"a":"fast"}']))).toThrow();
  });

  it("--no-write evaluates without creating any file or directory and leaves canonical bytes unchanged", async () => {
    writeFullProject();
    const before = new Map<string, string>();
    for (const rel of [
      "01_intent/creative_brief.yaml",
      "04_plan/selects_candidates.yaml",
      "04_plan/edit_blueprint.yaml",
      "05_timeline/timeline.json",
      "03_analysis/transcripts/TR_A.json",
    ]) {
      before.set(rel, sha256(fs.readFileSync(path.join(projectDir, rel))));
    }

    const outDir = path.join(root, "must-not-exist");
    const code = await runAssemblyLossCli(cliArgs(["--no-write", "--output-dir", outDir]));
    expect(code).toBe(0);
    expect(fs.existsSync(outDir)).toBe(false);

    for (const [rel, hash] of before) {
      expect(sha256(fs.readFileSync(path.join(projectDir, rel)))).toBe(hash);
    }
  });

  it("writes four files by default and exits 0 on READY", async () => {
    writeFullProject();
    const outDir = path.join(root, "out-cli");
    const code = await runAssemblyLossCli(cliArgs(["--output-dir", outDir]));
    expect(code).toBe(0);
    expect(listFiles(outDir)).toHaveLength(4);
  });

  it("exits 0 with the explicit note on HOLD (valid diagnostic)", async () => {
    writeFullProject({ coverageStatus: "failed" });
    const outDir = path.join(root, "out-hold");
    const code = await runAssemblyLossCli(cliArgs(["--output-dir", outDir]));
    expect(code).toBe(0);
    const jsonText = listFiles(outDir).filter((f) => f.endsWith(".json") && !f.endsWith(".sha256"))[0];
    expect(fs.readFileSync(path.join(outDir, jsonText), "utf-8")).toContain("接地失敗下の観測であり");
  });

  it("exits 1 on input errors (missing required artifact, bad explicit option file)", async () => {
    writeFullProject();
    fs.rmSync(path.join(projectDir, "04_plan/edit_blueprint.yaml"));
    expect(await runAssemblyLossCli(cliArgs(["--no-write"]))).toBe(1);

    writeFullProject();
    expect(await runAssemblyLossCli(cliArgs(["--no-write", "--causal-refs", "{nope"]))).toBe(1);
  });

  it("rejects a resolved output dir inside the project root before writing", async () => {
    writeFullProject();
    const insideReports = path.join(projectDir, "reports");
    expect(await runAssemblyLossCli(cliArgs(["--output-dir", insideReports]))).toBe(1);
    expect(fs.existsSync(insideReports)).toBe(false);

    // Canonical subtree is also rejected.
    const insideCanonical = path.join(projectDir, "04_plan", "eval-out");
    expect(await runAssemblyLossCli(cliArgs(["--output-dir", insideCanonical]))).toBe(1);
    expect(fs.existsSync(insideCanonical)).toBe(false);

    expect(() => ensureOutputDirOutsideProject(path.join(projectDir, "x"), projectDir)).toThrow();
    expect(() => ensureOutputDirOutsideProject(projectDir, projectDir)).toThrow();
    expect(() => ensureOutputDirOutsideProject(path.join(root, "outside"), projectDir)).not.toThrow();
  });

  it("validates causal-ref and human-reference shapes fail-closed at the CLI boundary", () => {
    // causal refs: not an array / item not object / missing or empty ids / bad kind.
    expect(() => parseAssemblyLossProjectArgs(cliArgs(["--causal-refs", '{"a":1}']))).toThrow();
    expect(() => parseAssemblyLossProjectArgs(cliArgs(["--causal-refs", '["x"']))).toThrow(/array/);
    expect(() => parseAssemblyLossProjectArgs(cliArgs(["--causal-refs", '[{"from_beat_id":"a"}]']))).toThrow();
    expect(() => parseAssemblyLossProjectArgs(cliArgs(["--causal-refs", '[{"from_beat_id":"","to_beat_id":"b"}]']))).toThrow();
    expect(() => parseAssemblyLossProjectArgs(cliArgs(["--causal-refs", '[{"from_beat_id":"a","to_beat_id":"b","kind":7}]']))).toThrow();

    // human reference: clips array required; segment_id nonempty string; duration_us finite nonneg; label string.
    expect(() => parseAssemblyLossProjectArgs(cliArgs(["--human-reference", '{}']))).toThrow();
    expect(() => parseAssemblyLossProjectArgs(cliArgs(["--human-reference", '{"clips":"x"}']))).toThrow();
    expect(() => parseAssemblyLossProjectArgs(cliArgs(["--human-reference", '{"clips":[{}]}']))).toThrow();
    expect(() => parseAssemblyLossProjectArgs(cliArgs(["--human-reference", '{"clips":[{"segment_id":""}]}']))).toThrow();
    expect(() => parseAssemblyLossProjectArgs(cliArgs(["--human-reference", '{"clips":[{"segment_id":"s","duration_us":-1}]}']))).toThrow();
    expect(() => parseAssemblyLossProjectArgs(cliArgs(["--human-reference", '{"clips":[{"segment_id":"s","duration_us":"x"}]}']))).toThrow();
    expect(() => parseAssemblyLossProjectArgs(cliArgs(["--human-reference", '{"label":5,"clips":[]}']))).toThrow();

    // Valid shapes pass parsing.
    expect(
      parseAssemblyLossProjectArgs(
        cliArgs(['--causal-refs', '[{"from_beat_id":"a","to_beat_id":"b","kind":"cause"}]', "--human-reference", '{"label":"l","clips":[{"segment_id":"s","duration_us":10}]}']),
      ),
    ).toBeTruthy();
  });

  it("does not execute the CLI when imported as a module and main returns the exit code", async () => {
    writeFullProject();
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
      logs.push(parts.map(String).join(" "));
    });
    try {
      await import("../scripts/eval-assembly-loss.js");
    } finally {
      logSpy.mockRestore();
    }
    expect(logs.join("\n")).not.toContain("assembly-loss:");

    // main resolves with the CLI exit code instead of calling process.exit.
    writeFullProject({ coverageStatus: "failed" });
    await expect(main([projectDir, "--no-write"])).resolves.toBe(0);
    fs.rmSync(path.join(projectDir, "01_intent/creative_brief.yaml"));
    await expect(main([projectDir, "--no-write"])).resolves.toBe(1);
  });

  it("accepts --analysis-coverage override and --asr-tolerance-us", async () => {
    writeFullProject({ withTranscripts: false });
    const override = path.join(root, "cov.json");
    fs.writeFileSync(override, coverageReportJson("ready"));
    const outDir = path.join(root, "out-cov");
    const code = await runAssemblyLossCli(
      cliArgs(["--no-write", "--output-dir", outDir, "--analysis-coverage", override, "--asr-tolerance-us", "100000"]),
    );
    expect(code).toBe(0);
  });
});
