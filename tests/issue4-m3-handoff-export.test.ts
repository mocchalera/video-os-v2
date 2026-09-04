import { afterEach, describe, expect, it, vi } from "vitest";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  HandoffExportCliError,
  runHandoffExportCli,
  type HandoffExportCliDependencies,
} from "../scripts/handoff-export.js";
import { computeFileHash } from "../runtime/state/reconcile.js";
import {
  buildHandoffManifest,
  loadCapabilityProfile,
  sha256,
  type ExportError,
  type HandoffExportInput,
  type HandoffExportResult,
} from "../runtime/handoff/export.js";
import type { BridgeFingerprint } from "../runtime/handoff/bridge-contract.js";
import type { TimelineIR } from "../runtime/compiler/types.js";

const tempRoots: string[] = [];
const PROFILE_TEMPLATE = path.resolve("runtime/nle-profiles/resolve-v1.yaml");
const BRIDGE_FINGERPRINT: BridgeFingerprint = {
  bridge_version: "1.0.0",
  python_version: "3.11.0",
  opentimelineio_version: "0.17.0",
  bridge_script_hash: `sha256:${"0".repeat(64)}`,
  loaded_adapter_modules: [],
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function writeJson(filePath: string, value: unknown): string {
  const raw = `${JSON.stringify(value, null, 2)}\n`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, raw, "utf8");
  return raw;
}

function writeYaml(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, stringifyYaml(value), "utf8");
}

function makeTimeline(projectId: string, version = "timeline-v1"): TimelineIR {
  return {
    version,
    project_id: projectId,
    created_at: "2026-09-02T00:00:00.000Z",
    sequence: {
      name: "Issue 4 M3 fixture",
      fps_num: 24,
      fps_den: 1,
      width: 1920,
      height: 1080,
      start_frame: 0,
    },
    tracks: {
      video: [{
        track_id: "V1",
        kind: "video",
        clips: [{
          clip_id: "CLP_001",
          segment_id: "SEG_001",
          asset_id: "AST_001",
          src_in_us: 0,
          src_out_us: 1_000_000,
          timeline_in_frame: 0,
          timeline_duration_frames: 24,
          role: "hero",
          motivation: "fixture",
          beat_id: "b01",
          fallback_segment_ids: [],
          confidence: 1,
          quality_flags: [],
        }],
      }],
      audio: [],
    },
    markers: [],
    provenance: {
      brief_path: "01_intent/creative_brief.yaml",
      blueprint_path: "04_plan/edit_blueprint.yaml",
      selects_path: "04_plan/selects_candidates.yaml",
      compiler_version: "issue4-m3-test",
    },
  };
}

function makeFixture(options: {
  projectId?: string;
  timeline?: TimelineIR;
  approvalStatus?: "clean" | "creative_override" | "pending";
} = {}): {
  projectDir: string;
  profilePath: string;
  timelinePath: string;
  statePath: string;
  sourceMapPath: string;
  sourcePath: string;
  timelineRaw: string;
} {
  const projectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "issue4-m3-handoff-export-")));
  tempRoots.push(projectDir);
  const projectId = options.projectId ?? "issue4-m3-project";
  const timeline = options.timeline ?? makeTimeline(projectId);
  const timelinePath = path.join(projectDir, "05_timeline", "timeline.json");
  const timelineRaw = writeJson(timelinePath, timeline);

  const statePath = path.join(projectDir, "project_state.yaml");
  const approvalTimelineHash = computeFileHash(timelinePath);
  writeYaml(statePath, {
    version: 1,
    project_id: projectId,
    current_state: "approved",
    approval_record: {
      status: options.approvalStatus ?? "clean",
      approved_by: "operator",
      approved_at: "2026-09-02T00:00:00Z",
      artifact_versions: {
        timeline_version: approvalTimelineHash,
        base_timeline_version: timeline.version,
        editorial_timeline_hash: approvalTimelineHash,
      },
    },
  });

  const externalMediaRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "issue4-m3-external-media-")));
  tempRoots.push(externalMediaRoot);
  const sourcePath = path.join(externalMediaRoot, "external-source.mov");
  fs.writeFileSync(sourcePath, "media-free readable source placeholder\n", "utf8");
  const sourceMapPath = path.join(projectDir, "02_media", "source_map.json");
  writeJson(sourceMapPath, {
    version: "1",
    project_id: projectId,
    media_dir: "02_media",
    generated_at: "2026-09-02T00:00:00Z",
    items: [{
      asset_id: "AST_001",
      source_locator: sourcePath,
      local_source_path: sourcePath,
      link_path: "02_media/CLP_001.mov",
      link_type: "direct",
      media_kind: "video",
    }],
  });

  const profilePath = path.join(projectDir, "resolve-v1.yaml");
  fs.copyFileSync(PROFILE_TEMPLATE, profilePath);
  return { projectDir, profilePath, timelinePath, statePath, sourceMapPath, sourcePath, timelineRaw };
}

function cliArgs(fixture: ReturnType<typeof makeFixture>, extra: string[] = []): string[] {
  return [
    "node",
    "scripts/handoff-export.ts",
    "--project",
    fixture.projectDir,
    "--profile",
    fixture.profilePath,
    ...extra,
  ];
}

function spawnPublicCli(fixture: ReturnType<typeof makeFixture>, extra: string[] = []) {
  const script = path.resolve("scripts/handoff-export.ts");
  return childProcess.spawnSync(process.execPath, [
    "--import",
    "tsx",
    script,
    "--project",
    fixture.projectDir,
    "--profile",
    fixture.profilePath,
    ...extra,
  ], {
    cwd: path.resolve("."),
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
  });
}

function expectCliError(run: () => unknown, code: string): HandoffExportCliError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(HandoffExportCliError);
    expect((error as HandoffExportCliError).code).toBe(code);
    return error as HandoffExportCliError;
  }
  throw new Error(`expected ${code} error`);
}

function successfulExport(
  fixture: ReturnType<typeof makeFixture>,
  overrides: { readbackValid?: boolean } = {},
): (input: HandoffExportInput) => HandoffExportResult {
  return (input) => {
    const handoffId = "HND_timeline-v1_20260902T000000Z";
    const sessionDir = path.join(fixture.projectDir, "exports", "handoffs", handoffId);
    fs.mkdirSync(sessionDir, { recursive: true });
    const profile = loadCapabilityProfile(input.profilePath);
    const manifest = buildHandoffManifest(
      input,
      handoffId,
      sha256(fixture.timelineRaw),
      BRIDGE_FINGERPRINT,
      profile,
      "2026-09-02T00:00:00.000Z",
    );
    const manifestPath = path.join(sessionDir, "handoff_manifest.yaml");
    const otioPath = path.join(sessionDir, "handoff_timeline.otio");
    fs.writeFileSync(manifestPath, stringifyYaml(manifest), "utf8");
    fs.writeFileSync(otioPath, "media-free OTIO bridge fixture\n", "utf8");
    return {
      handoffId,
      sessionDir,
      manifestPath,
      otioPath,
      manifest,
      bridgeFingerprint: BRIDGE_FINGERPRINT,
      readbackValid: overrides.readbackValid ?? true,
    };
  };
}

function dependency(executeExport: HandoffExportCliDependencies["executeExport"]): HandoffExportCliDependencies {
  return { executeExport };
}

describe("Issue #4 M3 handoff-export CLI", () => {
  it("composes canonical inputs into the existing export seam and reports the handoff files", () => {
    const fixture = makeFixture();
    const timelineBefore = fs.readFileSync(fixture.timelinePath);
    const executeExport = vi.fn(successfulExport(fixture));

    const result = runHandoffExportCli(cliArgs(fixture, ["--python", "/opt/python"]), dependency(executeExport));

    expect(executeExport).toHaveBeenCalledTimes(1);
    const input = executeExport.mock.calls[0]![0];
    expect(input).toMatchObject({
      projectPath: fixture.projectDir,
      projectId: "issue4-m3-project",
      timelineVersion: "timeline-v1",
      profilePath: fixture.profilePath,
      pythonPath: "/opt/python",
      approvalRecord: { status: "clean", approved_by: "operator" },
    });
    expect(input.sourceMap).toHaveLength(1);
    expect(input.sourceMap[0]?.asset_id).toBe("AST_001");
    expect(result).toMatchObject({
      ok: true,
      mode: "write",
      static_ready: true,
      bridge_execution: "executed",
      project_id: "issue4-m3-project",
      timeline_version: "timeline-v1",
      profile_id: "davinci_resolve_otio_v1",
      handoff_id: "HND_timeline-v1_20260902T000000Z",
      session_dir: "exports/handoffs/HND_timeline-v1_20260902T000000Z",
      manifest_path: "exports/handoffs/HND_timeline-v1_20260902T000000Z/handoff_manifest.yaml",
      otio_path: "exports/handoffs/HND_timeline-v1_20260902T000000Z/handoff_timeline.otio",
      readback_valid: true,
    });
    expect(fs.readFileSync(fixture.timelinePath)).toEqual(timelineBefore);
  });

  it("runs static check without invoking the bridge or creating project outputs", () => {
    const fixture = makeFixture();
    const executeExport = vi.fn(successfulExport(fixture));
    const result = runHandoffExportCli(cliArgs(fixture, ["--check", "--json"]), dependency(executeExport));

    expect(result).toMatchObject({
      mode: "check",
      static_ready: true,
      bridge_execution: "not_run",
      output_root: "exports/handoffs",
    });
    expect(executeExport).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(fixture.projectDir, "exports"))).toBe(false);
  });

  it("rejects an unapproved record before the exporter can write", () => {
    const fixture = makeFixture({ approvalStatus: "pending" });
    const executeExport = vi.fn(successfulExport(fixture));

    expectCliError(() => runHandoffExportCli(cliArgs(fixture), dependency(executeExport)), "NOT_APPROVED");
    expect(executeExport).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(fixture.projectDir, "exports"))).toBe(false);
  });

  it("rejects a project that is not in the approved state", () => {
    const fixture = makeFixture();
    const state = parseYaml(fs.readFileSync(fixture.statePath, "utf8")) as Record<string, unknown>;
    state.current_state = "review_ready";
    writeYaml(fixture.statePath, state);
    const executeExport = vi.fn(successfulExport(fixture));

    expectCliError(() => runHandoffExportCli(cliArgs(fixture), dependency(executeExport)), "NOT_APPROVED");
    expect(executeExport).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(fixture.projectDir, "exports"))).toBe(false);
  });

  it("rejects a stale approval before check mode reports readiness", () => {
    const fixture = makeFixture();
    const timeline = JSON.parse(fs.readFileSync(fixture.timelinePath, "utf8")) as TimelineIR;
    timeline.sequence.name = "changed after approval";
    writeJson(fixture.timelinePath, timeline);
    const executeExport = vi.fn(successfulExport(fixture));

    expectCliError(() => runHandoffExportCli(cliArgs(fixture, ["--check"]), dependency(executeExport)), "APPROVAL_STALE");
    expect(executeExport).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(fixture.projectDir, "exports"))).toBe(false);
  });

  it("passes the resolved regular media path for a project relink to external media", () => {
    const fixture = makeFixture();
    const relinkPath = path.join(fixture.projectDir, "02_media", "relinked.mov");
    fs.symlinkSync(fixture.sourcePath, relinkPath);
    const sourceMap = JSON.parse(fs.readFileSync(fixture.sourceMapPath, "utf8")) as { items: Array<Record<string, unknown>> };
    sourceMap.items[0]!.source_locator = "02_media/relinked.mov";
    writeJson(fixture.sourceMapPath, sourceMap);
    const sourceMapBefore = fs.readFileSync(fixture.sourceMapPath);
    const executeExport = vi.fn((input: HandoffExportInput) => {
      expect(input.sourceMap[0]?.source_locator).toBe(fs.realpathSync(fixture.sourcePath));
      return successfulExport(fixture)(input);
    });

    runHandoffExportCli(cliArgs(fixture), dependency(executeExport));
    expect(executeExport).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(fixture.sourceMapPath)).toEqual(sourceMapBefore);
  });

  it("rejects uncovered and unreadable source mappings before project writes", () => {
    const uncovered = makeFixture();
    writeJson(uncovered.sourceMapPath, {
      version: "1",
      project_id: "issue4-m3-project",
      media_dir: "02_media",
      generated_at: "2026-09-02T00:00:00Z",
      items: [],
    });
    const uncoveredExport = vi.fn(successfulExport(uncovered));
    expectCliError(() => runHandoffExportCli(cliArgs(uncovered), dependency(uncoveredExport)), "SOURCE_MAP_COVERAGE");
    expect(uncoveredExport).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(uncovered.projectDir, "exports"))).toBe(false);

    const unreadable = makeFixture();
    const sourceMap = JSON.parse(fs.readFileSync(unreadable.sourceMapPath, "utf8")) as { items: Array<Record<string, unknown>> };
    sourceMap.items[0]!.source_locator = path.join(unreadable.projectDir, "missing.mov");
    writeJson(unreadable.sourceMapPath, sourceMap);
    const unreadableExport = vi.fn(successfulExport(unreadable));
    expectCliError(() => runHandoffExportCli(cliArgs(unreadable), dependency(unreadableExport)), "SOURCE_NOT_READABLE");
    expect(unreadableExport).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(unreadable.projectDir, "exports"))).toBe(false);
  });

  it("rejects project identity drift before invoking export", () => {
    const fixture = makeFixture();
    writeYaml(fixture.statePath, {
      version: 1,
      project_id: "foreign-project",
      current_state: "approved",
      approval_record: {
        status: "clean",
        approved_by: "operator",
        approved_at: "2026-09-02T00:00:00Z",
      },
    });
    const executeExport = vi.fn(successfulExport(fixture));

    expectCliError(() => runHandoffExportCli(cliArgs(fixture), dependency(executeExport)), "PROJECT_MISMATCH");
    expect(executeExport).not.toHaveBeenCalled();
  });

  it("rejects Premiere profiles before invoking the Resolve OTIO exporter", () => {
    const fixture = makeFixture();
    const premiereProfilePath = path.join(fixture.projectDir, "premiere-v1.yaml");
    fs.copyFileSync(path.resolve("runtime/nle-profiles/premiere-v1.yaml"), premiereProfilePath);
    const executeExport = vi.fn(successfulExport(fixture));

    const error = expectCliError(
      () => runHandoffExportCli(cliArgs({ ...fixture, profilePath: premiereProfilePath }), dependency(executeExport)),
      "PROFILE_INVALID",
    );
    expect(error.message).toContain("Resolve OTIO profile");
    expect(executeExport).not.toHaveBeenCalled();
  });

  it("preserves the identity-bound human-correction approval in the handoff manifest", () => {
    const fixture = makeFixture();
    const hash = `sha256:${"a".repeat(64)}`;
    const binding = {
      version: "human-correction-approval/v1",
      approved_timeline: { path: "05_timeline/approved.timeline.json", version: "timeline-v1", sha256: hash },
      human_notes: { path: "06_review/human_notes.yaml", sha256: hash },
      review_generation: {
        generation_id: hash,
        review_identity: hash,
        output: { path: "06_review/review-ready.yaml", sha256: hash },
        review_ready_receipt: { path: "06_review/review-ready-receipt.yaml", sha256: hash },
      },
      review_round: { round_index: 1, round_identity: hash },
      human_revision_diff: { path: "06_review/human_revision_diff.yaml", sha256: hash, version: 2 },
    };
    const state = parseYaml(fs.readFileSync(fixture.statePath, "utf8")) as Record<string, unknown>;
    const approval = state.approval_record as Record<string, unknown>;
    const versions = approval.artifact_versions as Record<string, unknown>;
    versions.human_correction_approval = binding;
    writeYaml(fixture.statePath, state);
    const check = runHandoffExportCli(cliArgs(fixture, ["--check"]), dependency(vi.fn()));
    expect(check).toMatchObject({ mode: "check", static_ready: true, bridge_execution: "not_run" });
    const executeExport = vi.fn(successfulExport(fixture));

    const result = runHandoffExportCli(cliArgs(fixture), dependency(executeExport));
    const manifest = parseYaml(fs.readFileSync(path.join(fixture.projectDir, result.manifest_path!), "utf8")) as Record<string, any>;
    expect(manifest.approval_snapshot.artifact_versions.human_correction_approval).toEqual(binding);
  });

  it("turns an exporter error into a CLI failure", () => {
    const fixture = makeFixture();
    const exportError: ExportError = {
      code: "BRIDGE_FAILED",
      message: "bridge unavailable",
    };
    const executeExport = vi.fn(() => ({ error: exportError }));

    const error = expectCliError(() => runHandoffExportCli(cliArgs(fixture), dependency(executeExport)), "BRIDGE_FAILED");
    expect(error.message).toContain("Resolve this export gate and rerun");
  });

  it("turns readbackValid=false into a CLI failure", () => {
    const fixture = makeFixture();
    const executeExport = vi.fn(successfulExport(fixture, { readbackValid: false }));

    const error = expectCliError(() => runHandoffExportCli(cliArgs(fixture), dependency(executeExport)), "READBACK_FAILED");
    expect(error.message).toContain("readbackValid=false");
    expect(error.message).toContain("handoff_timeline.otio");
  });

  it("fails if the canonical timeline changes during export", () => {
    const fixture = makeFixture();
    const executeExport = vi.fn((input: HandoffExportInput) => {
      fs.writeFileSync(fixture.timelinePath, "tampered timeline\n", "utf8");
      return successfulExport(fixture)(input);
    });

    expectCliError(() => runHandoffExportCli(cliArgs(fixture), dependency(executeExport)), "INPUT_MUTATED");
  });

  it("exposes a zero exit help path and a structured unknown-option error", () => {
    const script = path.resolve("scripts/handoff-export.ts");
    const help = childProcess.spawnSync(process.execPath, ["--import", "tsx", script, "--help"], {
      cwd: path.resolve("."),
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Usage: npx tsx scripts/handoff-export.ts");

    const invalid = childProcess.spawnSync(process.execPath, ["--import", "tsx", script, "--unknown"], {
      cwd: path.resolve("."),
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("USAGE:");
    expect(invalid.stderr).toContain("unknown option --unknown");

    const jsonInvalid = childProcess.spawnSync(process.execPath, ["--import", "tsx", script, "--unknown", "--json"], {
      cwd: path.resolve("."),
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    expect(jsonInvalid.status).toBe(1);
    expect(JSON.parse(jsonInvalid.stderr)).toMatchObject({ ok: false, error: { code: "USAGE" } });
  });

  it("reports public check JSON for ready, stale, and non-Resolve profiles", () => {
    const readyFixture = makeFixture();
    const ready = spawnPublicCli(readyFixture, ["--check", "--json"]);
    expect(ready.status).toBe(0);
    expect(ready.stderr).toBe("");
    expect(JSON.parse(ready.stdout)).toMatchObject({
      ok: true,
      mode: "check",
      static_ready: true,
      bridge_execution: "not_run",
    });
    expect(fs.existsSync(path.join(readyFixture.projectDir, "exports"))).toBe(false);

    const staleFixture = makeFixture();
    const timeline = JSON.parse(fs.readFileSync(staleFixture.timelinePath, "utf8")) as TimelineIR;
    timeline.sequence.name = "changed after approval";
    writeJson(staleFixture.timelinePath, timeline);
    const stale = spawnPublicCli(staleFixture, ["--check", "--json"]);
    expect(stale.status).toBe(1);
    expect(stale.stdout).toBe("");
    expect(stale.stderr).not.toBe("");
    expect(JSON.parse(stale.stderr)).toMatchObject({ ok: false, error: { code: "APPROVAL_STALE" } });

    const profileFixture = makeFixture();
    const premiereProfilePath = path.join(profileFixture.projectDir, "premiere-v1.yaml");
    fs.copyFileSync(path.resolve("runtime/nle-profiles/premiere-v1.yaml"), premiereProfilePath);
    const profile = spawnPublicCli({ ...profileFixture, profilePath: premiereProfilePath }, ["--check", "--json"]);
    expect(profile.status).toBe(1);
    expect(profile.stdout).toBe("");
    expect(profile.stderr).not.toBe("");
    expect(JSON.parse(profile.stderr)).toMatchObject({ ok: false, error: { code: "PROFILE_INVALID" } });
  });

  it("keeps the persisted manifest identity bound to the guarded timeline", () => {
    const fixture = makeFixture();
    const executeExport = vi.fn(successfulExport(fixture));
    const result = runHandoffExportCli(cliArgs(fixture), dependency(executeExport));
    const manifest = parseYaml(fs.readFileSync(path.join(fixture.projectDir, result.manifest_path!), "utf8")) as Record<string, unknown>;

    expect(manifest).toMatchObject({
      project_id: "issue4-m3-project",
      handoff_id: result.handoff_id,
      base_timeline: { path: "05_timeline/timeline.json", version: "timeline-v1" },
      capability_profile: { profile_id: "davinci_resolve_otio_v1" },
    });
  });
});
