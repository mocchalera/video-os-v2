import { afterEach, describe, expect, it } from "vitest";
import * as childProcess from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  HandoffImportCliError,
  runHandoffImportCli,
  type HandoffImportCliDependencies,
} from "../scripts/handoff-import.js";
import {
  analyzeDiffs,
  type HumanRevisionDiffIdentity,
  type HumanRevisionDiffV2,
} from "../runtime/handoff/diff.js";
import type { ResolvedDiffRound } from "../runtime/eval/review-rounds.js";
import type {
  ClipMapping,
  HandoffImportResult,
  NormalizedClip,
  OneToManyResult,
  RoundtripImportReport,
} from "../runtime/handoff/import.js";
import type { NleCapabilityProfile } from "../runtime/handoff/bridge-contract.js";

const PROJECT_ID = "issue4-m2-project";
const TIMELINE_VERSION = "5";
const HANDOFF_ID = "HND_0004_20260902T120000Z";
const PROFILE_ID = "davinci_resolve_otio_v1";
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function sha256(value: string): string {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function makeProfile(): NleCapabilityProfile {
  return {
    version: 1,
    profile_id: PROFILE_ID,
    nle: { vendor: "Blackmagic Design", product: "DaVinci Resolve", version_range: ">=19" },
    otio: { interchange_format: "otio", metadata_namespace: "video_os" },
    stable_id: {
      primary_paths: {
        clip: "metadata.video_os.exchange_clip_id",
        track: "metadata.video_os.exchange_track_id",
      },
      require_exact_metadata: true,
    },
    surfaces: {
      trim: { mode: "verified_roundtrip", tolerance_frames: 1 },
    },
    import_policy: {
      provisional_mapping_requires_review: true,
      unmapped_edit_requires_review: true,
      one_to_many_requires_review: true,
    },
  };
}

function makeClip(id: string, overrides: Partial<NormalizedClip> = {}): NormalizedClip {
  return {
    exchange_clip_id: `${PROJECT_ID}:${TIMELINE_VERSION}:${id}`,
    clip_id: id,
    track_id: "V1",
    asset_id: `AST_${id}`,
    segment_id: `SEG_${id}`,
    src_in_us: 1_000_000,
    src_out_us: 2_000_000,
    timeline_in_frame: 0,
    timeline_duration_frames: 24,
    enabled: true,
    ...overrides,
  };
}

function emptyOneToMany(): OneToManyResult {
  return {
    oneToOne: [],
    splitEntries: [],
    duplicateEntries: [],
    ambiguousEntries: [],
  };
}

function makeIdentity(timelineHash: string): HumanRevisionDiffIdentity {
  const generationId = `sha256:${"a".repeat(64)}`;
  const generationPath = `09_output/social-review/generations/${generationId.slice(7)}`;
  return {
    base_timeline: {
      path: "05_timeline/timeline.json",
      version: TIMELINE_VERSION,
      sha256: timelineHash,
    },
    review_generation: {
      generation_id: generationId,
      review_identity: `sha256:${"b".repeat(64)}`,
      output: {
        path: `${generationPath}/review.mp4`,
        sha256: `sha256:${"c".repeat(64)}`,
      },
      review_ready_receipt: {
        path: `${generationPath}/review-ready-receipt.json`,
        sha256: `sha256:${"d".repeat(64)}`,
      },
    },
    review_round: {
      round_index: 1,
      round_identity: `sha256:${"e".repeat(64)}`,
    },
  };
}

function resolvedRound(identity: HumanRevisionDiffIdentity): ResolvedDiffRound {
  return {
    round_index: identity.review_round.round_index,
    round_identity: identity.review_round.round_identity,
    generation_id: identity.review_generation.generation_id,
    review_identity: identity.review_generation.review_identity,
    timeline: {
      path: identity.base_timeline.path,
      version: identity.base_timeline.version,
      hash: identity.base_timeline.sha256,
    },
    output: identity.review_generation.output,
    review_ready_receipt: identity.review_generation.review_ready_receipt,
  };
}

function makeReport(
  timelineHash: string,
  counts: Partial<RoundtripImportReport["mapping_summary"]> = {},
): RoundtripImportReport {
  return {
    version: 1,
    project_id: PROJECT_ID,
    handoff_id: HANDOFF_ID,
    imported_at: "2026-09-02T12:00:00.000Z",
    capability_profile_id: PROFILE_ID,
    status: "success",
    base_timeline: { version: TIMELINE_VERSION, hash: timelineHash },
    bridge: {
      bridge_version: "1.0.0",
      python_version: "3.11.0",
      opentimelineio_version: "0.17.0",
      bridge_script_hash: sha256("bridge"),
      loaded_adapter_modules: [],
    },
    mapping_summary: {
      exported_clip_count: 1,
      imported_clip_count: 1,
      exact_matches: 1,
      fallback_matches: 0,
      provisional_matches: 0,
      split_items: 0,
      duplicate_id_items: 0,
      ambiguous_one_to_many_items: 0,
      unmapped_items: 0,
      ...counts,
    },
  };
}

interface Fixture {
  root: string;
  sessionDir: string;
  manifestPath: string;
  importedPath: string;
  exportedPath: string;
  profilePath: string;
  identityPath: string;
  timelinePath: string;
  timelineBytes: string;
  identity: HumanRevisionDiffIdentity;
}

function makeFixture(): Fixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "issue4-m2-handoff-import-")));
  tempRoots.push(root);
  const sessionDir = path.join(root, "exports", "handoffs", HANDOFF_ID);
  const timelinePath = path.join(root, "05_timeline", "timeline.json");
  const manifestPath = path.join(sessionDir, "handoff_manifest.yaml");
  const importedPath = path.join(sessionDir, "imported_handoff.otio");
  const exportedPath = path.join(sessionDir, "handoff_timeline.otio");
  const profilePath = path.join(root, "profile.yaml");
  const identityPath = path.join(root, "identity.yaml");
  fs.mkdirSync(path.dirname(timelinePath), { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });

  const timelineBytes = `${JSON.stringify({
    version: TIMELINE_VERSION,
    project_id: PROJECT_ID,
    sequence: {
      name: "main",
      fps_num: 24,
      fps_den: 1,
      width: 1920,
      height: 1080,
      start_frame: 0,
    },
    tracks: {
      video: [],
      audio: [],
    },
    provenance: {
      brief_path: "01_intent/creative_brief.yaml",
      blueprint_path: "04_plan/edit_blueprint.yaml",
      selects_path: "04_plan/selects_candidates.yaml",
    },
  }, null, 2)}\n`;
  fs.writeFileSync(timelinePath, timelineBytes);
  const timelineHash = sha256(timelineBytes);
  const identity = makeIdentity(timelineHash);
  const manifest = {
    version: 1,
    project_id: PROJECT_ID,
    handoff_id: HANDOFF_ID,
    exported_at: "2026-09-02T12:00:00.000Z",
    base_timeline: {
      path: "05_timeline/timeline.json",
      version: TIMELINE_VERSION,
      hash: timelineHash,
      sequence: { fps_num: 24, fps_den: 1, width: 1920, height: 1080 },
    },
    approval_snapshot: {
      status: "clean",
      approved_by: "operator",
      approved_at: "2026-09-02T11:00:00.000Z",
    },
    capability_profile: { profile_id: PROFILE_ID, path: "profile.yaml" },
    bridge: {
      bridge_version: "1.0.0",
      python_version: "3.11.0",
      opentimelineio_version: "0.17.0",
      bridge_script_hash: sha256("bridge"),
      loaded_adapter_modules: [],
    },
    source_map: [],
  };
  fs.writeFileSync(manifestPath, stringifyYaml(manifest));
  fs.writeFileSync(profilePath, stringifyYaml(makeProfile()));
  fs.writeFileSync(identityPath, stringifyYaml(identity));
  fs.writeFileSync(importedPath, "media-free imported OTIO fixture\n");
  fs.writeFileSync(exportedPath, "media-free exported OTIO fixture\n");
  return {
    root,
    sessionDir,
    manifestPath,
    importedPath,
    exportedPath,
    profilePath,
    identityPath,
    timelinePath,
    timelineBytes,
    identity,
  };
}

function cliArgs(fixture: Fixture, extra: string[] = []): string[] {
  return [
    fixture.root,
    "--manifest", fixture.manifestPath,
    "--imported-otio", fixture.importedPath,
    "--exported-otio", fixture.exportedPath,
    "--profile", fixture.profilePath,
    "--identity", fixture.identityPath,
    ...extra,
  ];
}

type MappingMode = "exact" | "provisional" | "ambiguous" | "split" | "duplicate";

function makeDependencies(
  fixture: Fixture,
  options: { mapping?: MappingMode; mutateTimeline?: boolean; identityError?: string } = {},
): HandoffImportCliDependencies & { writerCalls: number; analyzeCalls: number; checkCalls: number } {
  const mode = options.mapping ?? "exact";
  let writerCalls = 0;
  let analyzeCalls = 0;
  let checkCalls = 0;
  const executeImport: NonNullable<HandoffImportCliDependencies["executeImport"]> = (input) => {
    const exported = makeClip("clip-1");
    const imported = makeClip("clip-1", { src_in_us: 1_100_000, timeline_duration_frames: 22 });
    const mapping: ClipMapping = {
      imported,
      exportedExchangeClipId: exported.exchange_clip_id,
      confidence: mode === "provisional" ? "provisional" : "exact",
    };
    let oneToMany = emptyOneToMany();
    let mappings = [mapping];
    let importedClips = [imported];
    let counts: Partial<RoundtripImportReport["mapping_summary"]> = {};
    if (mode === "ambiguous" || mode === "split" || mode === "duplicate") {
      const second = makeClip("clip-1", {
        src_in_us: mode === "split" ? 2_000_000 : 1_500_000,
        src_out_us: mode === "split" ? 2_500_000 : 2_500_000,
        timeline_in_frame: mode === "split" ? 22 : 24,
      });
      const secondMapping: ClipMapping = {
        imported: second,
        exportedExchangeClipId: exported.exchange_clip_id,
        confidence: "exact",
      };
      mappings = [mapping, secondMapping];
      importedClips = [imported, second];
      if (mode === "ambiguous") {
        oneToMany = {
          oneToOne: [],
          splitEntries: [],
          duplicateEntries: [],
          ambiguousEntries: [{
            parent_exchange_clip_id: exported.exchange_clip_id,
            candidates: [`${exported.exchange_clip_id}#A01`, `${exported.exchange_clip_id}#A02`],
            reason: "fixture ambiguity",
            review_required: true,
          }],
        };
        counts = {
          imported_clip_count: 2,
          exact_matches: 0,
          ambiguous_one_to_many_items: 1,
        };
      } else if (mode === "split") {
        oneToMany = {
          oneToOne: [],
          splitEntries: [{
            parent_exchange_clip_id: exported.exchange_clip_id,
            child_ids: [`${exported.exchange_clip_id}#S01`, `${exported.exchange_clip_id}#S02`],
            review_required: true,
          }],
          duplicateEntries: [],
          ambiguousEntries: [],
        };
        counts = {
          imported_clip_count: 2,
          exact_matches: 0,
          split_items: 1,
        };
      } else {
        oneToMany = {
          oneToOne: [],
          splitEntries: [],
          duplicateEntries: [{
            parent_exchange_clip_id: exported.exchange_clip_id,
            retained_exchange_clip_id: exported.exchange_clip_id,
            copy_ids: [`${exported.exchange_clip_id}#D01`],
            provenance: { basis: "duplicate_metadata_collision" },
            review_required: true,
          }],
          ambiguousEntries: [],
        };
        counts = {
          imported_clip_count: 2,
          exact_matches: 0,
          duplicate_id_items: 1,
        };
      }
    } else {
      oneToMany.oneToOne = mappings;
      counts = mode === "provisional"
        ? { provisional_matches: 1, exact_matches: 0 }
        : {};
    }
    const report = makeReport(sha256(fixture.timelineBytes), counts);
    fs.mkdirSync(input.outputDir, { recursive: true });
    const reportPath = path.join(input.outputDir, "roundtrip_import_report.yaml");
    fs.writeFileSync(reportPath, stringifyYaml(report));
    if (options.mutateTimeline) {
      fs.writeFileSync(fixture.timelinePath, `${fixture.timelineBytes}mutated\n`);
    }
    return {
      report,
      reportPath,
      reviewRequired: mode !== "exact",
      bridgeFingerprint: report.bridge,
      normalizedImport: {
        project_id: PROJECT_ID,
        handoff_id: HANDOFF_ID,
        timeline_version: TIMELINE_VERSION,
        clips: importedClips,
      },
      normalizedExport: {
        project_id: PROJECT_ID,
        handoff_id: HANDOFF_ID,
        timeline_version: TIMELINE_VERSION,
        clips: [exported],
      },
      mappedClips: mappings,
      oneToMany,
      unmappedClips: [],
    } satisfies HandoffImportResult;
  };
  const analyze: NonNullable<HandoffImportCliDependencies["analyze"]> = (input) => {
    analyzeCalls += 1;
    return analyzeDiffs(input);
  };
  const validateCanonicalIdentity: NonNullable<HandoffImportCliDependencies["validateCanonicalIdentity"]> = (_projectDir, _projectId, identity) => {
    if (options.identityError) throw new Error(options.identityError);
    if (JSON.stringify(identity) !== JSON.stringify(fixture.identity)) throw new Error("foreign identity");
    return resolvedRound(fixture.identity);
  };
  const writeCanonical: NonNullable<HandoffImportCliDependencies["writeCanonical"]> = (projectDir, input) => {
    writerCalls += 1;
    if (input.diff.version !== 2) throw new Error("test writer requires v2");
    const diff = input.diff as HumanRevisionDiffV2;
    const relativePath = `07_handoff/${input.handoffId}/human_revision_diff.yaml`;
    const absolutePath = path.join(projectDir, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, `${stringifyYaml(diff)}\n`);
    return { relativePath, identity: diff.identity, round: resolvedRound(diff.identity) };
  };
  const checkCanonical: NonNullable<HandoffImportCliDependencies["checkCanonical"]> = (projectDir, input) => {
    checkCalls += 1;
    const diff = input.diff as HumanRevisionDiffV2;
    const relativePath = `07_handoff/${input.handoffId}/human_revision_diff.yaml`;
    const absolutePath = path.join(projectDir, relativePath);
    if (fs.existsSync(absolutePath) && fs.readFileSync(absolutePath, "utf8") !== `${stringifyYaml(diff)}\n`) {
      throw new Error("canonical human_revision_diff target already exists with different content");
    }
    return { relativePath, identity: diff.identity, round: resolvedRound(diff.identity) };
  };
  return {
    executeImport,
    analyze,
    checkCanonical,
    validateCanonicalIdentity,
    writeCanonical,
    get writerCalls() {
      return writerCalls;
    },
    get analyzeCalls() {
      return analyzeCalls;
    },
    get checkCalls() {
      return checkCalls;
    },
  };
}

function expectCliError(action: () => unknown, code: string): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(HandoffImportCliError);
  expect((caught as HandoffImportCliError).code).toBe(code);
}

function snapshotFiles(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  function walk(directory: string): void {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else {
        files[path.relative(root, absolute).split(path.sep).join("/")] = fs.readFileSync(absolute).toString("base64");
      }
    }
  }
  walk(root);
  return files;
}

describe("Issue #4 M2 owner-operated handoff import", () => {
  it("composes import, typed normalization, diff analysis, and canonical publication", () => {
    const fixture = makeFixture();
    const dependencies = makeDependencies(fixture);
    const result = runHandoffImportCli(cliArgs(fixture), dependencies);

    expect(result).toMatchObject({
      ok: true,
      mode: "write",
      project_id: PROJECT_ID,
      handoff_id: HANDOFF_ID,
      report_path: `exports/handoffs/${HANDOFF_ID}/roundtrip_import_report.yaml`,
      canonical_diff_path: `07_handoff/${HANDOFF_ID}/human_revision_diff.yaml`,
      report_written: true,
      canonical_diff_written: true,
      import_status: "success",
    });
    expect(dependencies.writerCalls).toBe(1);
    expect(fs.readFileSync(fixture.timelinePath, "utf8")).toBe(fixture.timelineBytes);
    expect(fs.existsSync(path.join(fixture.sessionDir, "roundtrip_import_report.yaml"))).toBe(true);
    const canonicalPath = path.join(fixture.root, result.canonical_diff_path);
    const diff = parseYaml(fs.readFileSync(canonicalPath, "utf8")) as HumanRevisionDiffV2;
    expect(diff.version).toBe(2);
    expect(diff.identity).toEqual(fixture.identity);
    expect(diff.operations?.[0]?.type).toBe("trim");
  });

  it("check mode analyzes and reports the planned target without writing project files", () => {
    const fixture = makeFixture();
    const before = snapshotFiles(fixture.root);
    const dependencies = makeDependencies(fixture);
    const result = runHandoffImportCli(cliArgs(fixture, ["--check"]), dependencies);

    expect(result).toMatchObject({
      ok: true,
      mode: "check",
      report_written: false,
      canonical_diff_written: false,
      canonical_diff_path: `07_handoff/${HANDOFF_ID}/human_revision_diff.yaml`,
    });
    expect(dependencies.writerCalls).toBe(0);
    expect(snapshotFiles(fixture.root)).toEqual(before);
    expect(fs.existsSync(path.join(fixture.sessionDir, "roundtrip_import_report.yaml"))).toBe(false);
    expect(fs.existsSync(path.join(fixture.root, "07_handoff"))).toBe(false);
  });

  it("check mode rejects an incompatible existing canonical target without project writes", () => {
    const fixture = makeFixture();
    runHandoffImportCli(cliArgs(fixture), makeDependencies(fixture));
    const canonicalPath = path.join(fixture.root, "07_handoff", HANDOFF_ID, "human_revision_diff.yaml");
    const canonical = parseYaml(fs.readFileSync(canonicalPath, "utf8")) as HumanRevisionDiffV2;
    canonical.summary = { trim: 99 };
    fs.writeFileSync(canonicalPath, `${stringifyYaml(canonical)}\n`);
    const before = snapshotFiles(fixture.root);
    const dependencies = makeDependencies(fixture);

    expectCliError(() => runHandoffImportCli(cliArgs(fixture, ["--check"]), dependencies), "CANONICAL_WRITE_FAILED");
    expect(dependencies.checkCalls).toBe(1);
    expect(dependencies.writerCalls).toBe(0);
    expect(snapshotFiles(fixture.root)).toEqual(before);
  });

  it("check mode accepts a compatible existing canonical target without project writes", () => {
    const fixture = makeFixture();
    runHandoffImportCli(cliArgs(fixture), makeDependencies(fixture));
    const before = snapshotFiles(fixture.root);
    const dependencies = makeDependencies(fixture);
    const result = runHandoffImportCli(cliArgs(fixture, ["--check"]), dependencies);

    expect(result).toMatchObject({ ok: true, mode: "check", canonical_diff_written: false });
    expect(dependencies.checkCalls).toBe(1);
    expect(dependencies.writerCalls).toBe(0);
    expect(snapshotFiles(fixture.root)).toEqual(before);
  });

  it("fails closed on a stale or foreign identity before publication", () => {
    const fixture = makeFixture();
    const dependencies = makeDependencies(fixture, { identityError: "stale foreign review round" });

    expectCliError(() => runHandoffImportCli(cliArgs(fixture), dependencies), "IDENTITY_MISMATCH");
    expect(dependencies.writerCalls).toBe(0);
    expect(fs.existsSync(path.join(fixture.root, "07_handoff"))).toBe(false);
  });

  it.each(["provisional", "ambiguous"] as const)(
    "fails closed before publication on %s import mapping",
    (mapping: MappingMode) => {
      const fixture = makeFixture();
      const dependencies = makeDependencies(fixture, { mapping });

      expectCliError(() => runHandoffImportCli(cliArgs(fixture), dependencies), "IMPORT_MAPPING_REVIEW_REQUIRED");
      expect(dependencies.writerCalls).toBe(0);
      expect(fs.existsSync(path.join(fixture.root, "07_handoff"))).toBe(false);
    },
  );

  it.each(["split", "duplicate"] as const)(
    "publishes deterministic %s mapping through the analyzer and writer",
    (mapping: "split" | "duplicate") => {
      const fixture = makeFixture();
      const dependencies = makeDependencies(fixture, { mapping });
      const result = runHandoffImportCli(cliArgs(fixture), dependencies);

      expect(result).toMatchObject({ ok: true, mode: "write", diff_status: "review_required" });
      expect(dependencies.analyzeCalls).toBe(1);
      expect(dependencies.writerCalls).toBe(1);
      const canonicalPath = path.join(fixture.root, result.canonical_diff_path);
      const diff = parseYaml(fs.readFileSync(canonicalPath, "utf8")) as HumanRevisionDiffV2;
      expect(diff.unmapped_edits?.[0]?.classification).toBe(
        mapping === "split" ? "split_clip" : "duplicated_clip",
      );
    },
  );

  it("rejects a version 1 identity before import or publication", () => {
    const fixture = makeFixture();
    fs.writeFileSync(fixture.identityPath, stringifyYaml({ version: 1 }));
    const dependencies = makeDependencies(fixture);

    expectCliError(() => runHandoffImportCli(cliArgs(fixture), dependencies), "V1_IDENTITY");
    expect(dependencies.writerCalls).toBe(0);
  });

  it("rejects a schema-invalid manifest before import", () => {
    const fixture = makeFixture();
    const manifest = parseYaml(fs.readFileSync(fixture.manifestPath, "utf8")) as Record<string, unknown>;
    (manifest.approval_snapshot as Record<string, unknown>).status = "not-a-valid-status";
    fs.writeFileSync(fixture.manifestPath, stringifyYaml(manifest));
    const dependencies = makeDependencies(fixture);

    expectCliError(() => runHandoffImportCli(cliArgs(fixture), dependencies), "SCHEMA_INVALID");
    expect(dependencies.writerCalls).toBe(0);
  });

  it("rejects a schema-invalid canonical timeline before import", () => {
    const fixture = makeFixture();
    fs.writeFileSync(fixture.timelinePath, `${JSON.stringify({
      version: TIMELINE_VERSION,
      project_id: PROJECT_ID,
      tracks: [],
    })}\n`);
    const dependencies = makeDependencies(fixture);

    expectCliError(() => runHandoffImportCli(cliArgs(fixture), dependencies), "SCHEMA_INVALID");
    expect(dependencies.writerCalls).toBe(0);
  });

  it("detects timeline mutation before canonical diff publication", () => {
    const fixture = makeFixture();
    const dependencies = makeDependencies(fixture, { mutateTimeline: true });

    expectCliError(() => runHandoffImportCli(cliArgs(fixture), dependencies), "INPUT_MUTATED");
    expect(dependencies.writerCalls).toBe(0);
    expect(fs.existsSync(path.join(fixture.root, "07_handoff"))).toBe(false);
  });

  it("rejects multiple revision diff candidates", () => {
    const fixture = makeFixture();
    const current = path.join(fixture.root, "07_handoff", HANDOFF_ID, "human_revision_diff.yaml");
    const foreign = path.join(fixture.root, "exports", "handoffs", "HND_FOREIGN", "human_revision_diff.yaml");
    fs.mkdirSync(path.dirname(current), { recursive: true });
    fs.mkdirSync(path.dirname(foreign), { recursive: true });
    fs.writeFileSync(current, "not inspected because discovery is ambiguous\n");
    fs.writeFileSync(foreign, "not inspected because discovery is ambiguous\n");

    expectCliError(() => runHandoffImportCli(cliArgs(fixture), makeDependencies(fixture)), "MULTIPLE_DIFF_CANDIDATES");
  });

  it("produces deterministic canonical diff bytes for identical inputs", () => {
    const first = makeFixture();
    const second = makeFixture();
    const firstDependencies = makeDependencies(first);
    const secondDependencies = makeDependencies(second);
    runHandoffImportCli(cliArgs(first), firstDependencies);
    runHandoffImportCli(cliArgs(second), secondDependencies);

    const firstPath = path.join(first.root, "07_handoff", HANDOFF_ID, "human_revision_diff.yaml");
    const secondPath = path.join(second.root, "07_handoff", HANDOFF_ID, "human_revision_diff.yaml");
    expect(fs.readFileSync(firstPath, "utf8")).toBe(fs.readFileSync(secondPath, "utf8"));
  });

  it("returns non-zero CLI errors and exposes help without a media or NLE fixture", () => {
    const script = path.resolve("scripts/handoff-import.ts");
    const help = childProcess.spawnSync(process.execPath, ["--import", "tsx", script, "--help"], {
      cwd: path.resolve("."),
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Usage: npx tsx scripts/handoff-import.ts");

    const invalid = childProcess.spawnSync(process.execPath, ["--import", "tsx", script, "--unknown"], {
      cwd: path.resolve("."),
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("USAGE:");
  });
});
