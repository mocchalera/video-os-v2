import { describe, expect, it } from "vitest";
import * as crypto from "node:crypto";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  canonicalPreferenceMemoryPath,
  readPreferenceEntries,
  redactEditorialPreference,
  rememberEditorialPreference,
  resolveActivePreference,
  stablePreferenceEntryId,
  validatePreferenceSupersessionGraph,
  type EditorialPreferenceMemoryEntry,
  type RememberEditorialPreferenceInput,
} from "../runtime/artifacts/p3-preference-memory.js";
import { preloadProjectPreferences } from "../runtime/commands/intent.js";
import { projectP3ContinuityPreferenceSignals } from "../runtime/commands/blueprint.js";
import {
  main as preferenceCliMain,
  parseEditorialPreferenceMemoryArgs,
  runEditorialPreferenceMemoryCli,
} from "../scripts/editorial-preference-memory.js";

function makeProject(projectId = "eye-writer"): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "eye-pref-writer-"));
  fs.mkdirSync(path.join(projectDir, "04_plan"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, "06_review", "patch_history"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "project_state.yaml"), `version: 1\nproject_id: ${projectId}\ncurrent_state: blueprint_ready\n`);
  fs.writeFileSync(path.join(projectDir, "04_plan/edit_blueprint.yaml"), JSON.stringify({
    version: "1.1.0",
    project_id: projectId,
    sequence_goals: ["Clear story"],
    beats: [{ id: "B01", label: "Opening", target_duration_frames: 72, required_roles: ["hero"] }],
    pacing: { opening_cadence: "quick", middle_cadence: "steady", ending_cadence: "held" },
    music_policy: { start_sparse: true, allow_release_late: true, entry_beat: "B01" },
    dialogue_policy: { preserve_natural_breath: true, avoid_wall_to_wall_voiceover: true },
    transition_policy: { prefer_match_texture_over_flashy_fx: true },
    ending_policy: { should_feel: "resolved" },
    rejection_rules: ["No duplicates"],
  }));
  fs.writeFileSync(path.join(projectDir, "06_review/review_patch.json"), JSON.stringify({ timeline_version: "1", operations: [] }));
  return projectDir;
}

function rememberInput(projectDir: string, overrides: Partial<RememberEditorialPreferenceInput> = {}): RememberEditorialPreferenceInput {
  return {
    projectDir,
    projectId: "eye-writer",
    actionId: "action-1",
    actorId: "operator-1",
    sourceEvent: "blueprint_acceptance",
    sourceArtifactPath: "04_plan/edit_blueprint.yaml",
    preferenceType: "pacing",
    value: { kind: "enum", data: "tight" },
    scope: "project",
    scopeRef: "eye-writer",
    ...overrides,
  };
}

function memoryBytes(projectDir: string): Buffer | null {
  const file = canonicalPreferenceMemoryPath(projectDir);
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}

function entries(projectDir: string): EditorialPreferenceMemoryEntry[] {
  return readPreferenceEntries(canonicalPreferenceMemoryPath(projectDir)).entries.map((record) => record.entry);
}

function entryFixture(overrides: Partial<EditorialPreferenceMemoryEntry> = {}): EditorialPreferenceMemoryEntry {
  return {
    version: "1.1.0",
    project_id: "eye-writer",
    entry_id: "EPM_fixture",
    created_at: "2026-07-20T00:00:00.000Z",
    actor: { type: "human", id: "operator" },
    source_event: { event_type: "blueprint_acceptance", event_ref: "fixture" },
    preference_type: "pacing",
    value: { kind: "enum", data: "tight" },
    scope: "project",
    scope_ref: "eye-writer",
    confidence: { score: 1, source: "human", status: "confirmed" },
    status: "active",
    supersedes_entry_id: null,
    expires_at: null,
    provenance: { producer: "blueprint", inputs: [], hash_policy: {} },
    ...overrides,
  };
}

describe("EYE-060B1 explicit preference writer", () => {
  const execFileAsync = promisify(execFile);
  it("writes only explicit accept/reject feature primitives with human attribution and raw source hash", () => {
    const projectDir = makeProject();
    const accepted = rememberEditorialPreference(rememberInput(projectDir));
    const rejected = rememberEditorialPreference(rememberInput(projectDir, {
      actionId: "negative-action",
      sourceEvent: "review_patch_rejection",
      sourceArtifactPath: "06_review/review_patch.json",
      preferenceType: "transition_style",
      value: { kind: "enum", data: "no_flash" },
    }));

    expect(accepted.status).toBe("appended");
    expect(rejected.entry).toMatchObject({
      actor: { type: "human", id: "operator-1" },
      source_event: { event_type: "review_patch_rejection" },
      preference_type: "transition_style",
      value: { kind: "enum", data: "no_flash" },
      status: "active",
      scope_ref: "eye-writer",
    });
    const reviewRaw = fs.readFileSync(path.join(projectDir, "06_review/review_patch.json"));
    expect(rejected.entry.provenance.inputs).toEqual([{
      path: "06_review/review_patch.json",
      raw_sha256: `sha256:${crypto.createHash("sha256").update(reviewRaw).digest("hex")}`,
    }]);
    expect(rejected.entry.source_event.event_ref).toContain("negative-action");
    expect(JSON.stringify(rejected.entry.value)).not.toContain("operations");
  });

  it.each([
    ["pacing", { kind: "number", data: 0.5 }],
    ["chronology", { kind: "string", data: "strict" }],
    ["repetition_tolerance", { kind: "number", data: 1.1 }],
    ["bgm_loudness", { kind: "number", data: -61 }],
    ["caption_density", { kind: "number", data: Number.NaN }],
    ["delivery_preference", { kind: "boolean", data: true }],
    ["pacing", { kind: "enum", data: "bad value" }],
  ])("rejects invalid type-kind-data semantics for %s", (preferenceType, value) => {
    const projectDir = makeProject();
    expect(() => rememberEditorialPreference(rememberInput(projectDir, {
      preferenceType: preferenceType as RememberEditorialPreferenceInput["preferenceType"],
      value: value as RememberEditorialPreferenceInput["value"],
    }))).toThrow();
    expect(memoryBytes(projectDir)).toBeNull();
  });

  it("enforces scope_ref and keeps profile/series entries out of context-free consumers", () => {
    const invalid = makeProject();
    expect(() => rememberEditorialPreference(rememberInput(invalid, { scopeRef: "other-project" }))).toThrow("scope_ref");
    expect(memoryBytes(invalid)).toBeNull();

    for (const [scope, scopeRef] of [["profile", "PROFILE_documentary"], ["series", "SERIES_launch"]] as const) {
      const projectDir = makeProject();
      expect(rememberEditorialPreference(rememberInput(projectDir, { scope, scopeRef })).status).toBe("appended");
      const beforeReads = memoryBytes(projectDir);
      const blueprint = { version: "1.0.0", project_id: "eye-writer", beats: [{ id: "B01", label: "Opening" }] } as any;
      expect(preloadProjectPreferences(projectDir, "eye-writer")?.activeProjectPreferences).toEqual([]);
      expect(projectP3ContinuityPreferenceSignals(projectDir, blueprint)).toBe(false);
      expect(blueprint.beats[0].applied_preferences).toBeUndefined();
      expect(memoryBytes(projectDir)).toEqual(beforeReads);
    }
  });

  it("rejects source traversal, symlink escape, wrong kind, and cross-project blueprint without mutation", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "eye-pref-outside-"));
    const outsidePatch = path.join(outside, "review_patch.json");
    fs.writeFileSync(outsidePatch, JSON.stringify({ timeline_version: "1", operations: [] }));
    for (const sourceArtifactPath of [outsidePatch, "../review_patch.json"]) {
      const projectDir = makeProject();
      expect(() => rememberEditorialPreference(rememberInput(projectDir, {
        sourceEvent: "review_patch_acceptance",
        sourceArtifactPath,
      }))).toThrow("inside the project");
      expect(memoryBytes(projectDir)).toBeNull();
    }

    const symlinkProject = makeProject();
    const linkPath = path.join(symlinkProject, "06_review/review_patch.json");
    fs.unlinkSync(linkPath);
    fs.symlinkSync(outsidePatch, linkPath);
    expect(() => rememberEditorialPreference(rememberInput(symlinkProject, {
      sourceEvent: "review_patch_acceptance", sourceArtifactPath: "06_review/review_patch.json",
    }))).toThrow("symlink");
    expect(memoryBytes(symlinkProject)).toBeNull();

    const wrongKind = makeProject();
    fs.writeFileSync(path.join(wrongKind, "06_review/review_patch.json"), "{}\n");
    expect(() => rememberEditorialPreference(rememberInput(wrongKind, {
      sourceEvent: "review_patch_acceptance", sourceArtifactPath: "06_review/review_patch.json",
    }))).toThrow("schema");
    expect(memoryBytes(wrongKind)).toBeNull();

    const crossProject = makeProject();
    const blueprint = JSON.parse(fs.readFileSync(path.join(crossProject, "04_plan/edit_blueprint.yaml"), "utf-8"));
    blueprint.project_id = "other-project";
    fs.writeFileSync(path.join(crossProject, "04_plan/edit_blueprint.yaml"), JSON.stringify(blueprint));
    expect(() => rememberEditorialPreference(rememberInput(crossProject))).toThrow("cross-project");
    expect(memoryBytes(crossProject)).toBeNull();
  });

  it("validates registered direct/enveloped Studio patches and their project identity", () => {
    const directProject = makeProject();
    const directPath = path.join(directProject, "06_review/studio_patch_direct.json");
    fs.writeFileSync(directPath, JSON.stringify({ timeline_version: "1", operations: [] }));
    fs.writeFileSync(path.join(directProject, "06_review/patch_history/index.json"), JSON.stringify({
      version: "1", project_id: "eye-writer", records: [{ patch_path: "06_review/studio_patch_direct.json" }],
    }));
    expect(rememberEditorialPreference(rememberInput(directProject, {
      sourceEvent: "review_patch_acceptance", sourceArtifactPath: directPath,
    })).status).toBe("appended");

    const envelopeProject = makeProject();
    const envelopePath = path.join(envelopeProject, "06_review/studio_patch_envelope.json");
    fs.writeFileSync(envelopePath, JSON.stringify({
      project_id: "eye-writer",
      patch: { timeline_version: "1", operations: [] },
      studio_version: "1",
    }));
    fs.writeFileSync(path.join(envelopeProject, "06_review/patch_history/index.json"), JSON.stringify({
      version: "1", project_id: "eye-writer", records: [{ patch_path: "06_review/studio_patch_envelope.json" }],
    }));
    expect(rememberEditorialPreference(rememberInput(envelopeProject, {
      sourceEvent: "review_patch_acceptance", sourceArtifactPath: envelopePath,
    })).status).toBe("appended");

    for (const document of [
      { project_id: "other-project", patch: { timeline_version: "1", operations: [] } },
      { project_id: "eye-writer", patch: { arbitrary: true } },
      { arbitrary: true },
    ]) {
      const projectDir = makeProject();
      const studioPath = path.join(projectDir, "06_review/studio_patch_envelope.json");
      fs.writeFileSync(studioPath, JSON.stringify(document));
      fs.writeFileSync(path.join(projectDir, "06_review/patch_history/index.json"), JSON.stringify({
        version: "1", project_id: "eye-writer", records: [{ patch_path: "06_review/studio_patch_envelope.json" }],
      }));
      expect(() => rememberEditorialPreference(rememberInput(projectDir, {
        sourceEvent: "review_patch_acceptance", sourceArtifactPath: studioPath,
      }))).toThrow();
      expect(memoryBytes(projectDir)).toBeNull();
    }

    const malformedProject = makeProject();
    const malformedPath = path.join(malformedProject, "06_review/studio_patch_bad.json");
    fs.writeFileSync(malformedPath, "not-json\n");
    fs.writeFileSync(path.join(malformedProject, "06_review/patch_history/index.json"), JSON.stringify({
      version: "1", project_id: "eye-writer", records: [{ patch_path: "06_review/studio_patch_bad.json" }],
    }));
    expect(() => rememberEditorialPreference(rememberInput(malformedProject, {
      sourceEvent: "review_patch_acceptance", sourceArtifactPath: malformedPath,
    }))).toThrow("valid JSON");
    expect(memoryBytes(malformedProject)).toBeNull();

    const escapeProject = makeProject();
    const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "eye-studio-patch-outside-")), "patch.json");
    fs.writeFileSync(outside, JSON.stringify({ timeline_version: "1", operations: [] }));
    const escapePath = path.join(escapeProject, "06_review/studio_patch_escape.json");
    fs.symlinkSync(outside, escapePath);
    fs.writeFileSync(path.join(escapeProject, "06_review/patch_history/index.json"), JSON.stringify({
      version: "1", project_id: "eye-writer", records: [{ patch_path: "06_review/studio_patch_escape.json" }],
    }));
    expect(() => rememberEditorialPreference(rememberInput(escapeProject, {
      sourceEvent: "review_patch_acceptance", sourceArtifactPath: escapePath,
    }))).toThrow("symlink");
    expect(memoryBytes(escapeProject)).toBeNull();
  });

  it("rejects a canonical ledger symlink before reading or replacing external bytes", () => {
    const projectDir = makeProject();
    const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "eye-pref-ledger-outside-")), "memory.jsonl");
    fs.writeFileSync(outside, "external-bytes\n");
    fs.mkdirSync(path.dirname(canonicalPreferenceMemoryPath(projectDir)), { recursive: true });
    fs.symlinkSync(outside, canonicalPreferenceMemoryPath(projectDir));
    expect(() => rememberEditorialPreference(rememberInput(projectDir))).toThrow("symlink");
    expect(fs.readFileSync(outside, "utf-8")).toBe("external-bytes\n");
  });

  it("makes action retries idempotent across generated timestamps and conflicts on semantic/source changes", () => {
    const projectDir = makeProject();
    const first = rememberEditorialPreference(rememberInput(projectDir));
    const before = memoryBytes(projectDir);
    const retry = rememberEditorialPreference(rememberInput(projectDir, { createdAt: "2030-01-01T00:00:00.000Z" }));
    expect(retry.status).toBe("idempotent");
    expect(retry.entry.created_at).toBe(first.entry.created_at);
    expect(memoryBytes(projectDir)).toEqual(before);
    expect(() => rememberEditorialPreference(rememberInput(projectDir, { value: { kind: "enum", data: "slow" } }))).toThrow("conflict");
    expect(memoryBytes(projectDir)).toEqual(before);
  });

  it("rejects legacy-only, malformed, cross-project, duplicate, and graph-invalid ledgers without mutation", () => {
    const cases: Array<(projectDir: string) => void> = [
      (projectDir) => {
        fs.mkdirSync(path.join(projectDir, "03_analysis"), { recursive: true });
        fs.writeFileSync(path.join(projectDir, "03_analysis/editorial_preference_memory.jsonl"), `${JSON.stringify(entryFixture())}\n`);
      },
      (projectDir) => {
        fs.mkdirSync(path.dirname(canonicalPreferenceMemoryPath(projectDir)), { recursive: true });
        fs.writeFileSync(canonicalPreferenceMemoryPath(projectDir), "not-json\n");
      },
      (projectDir) => fs.writeFileSync(canonicalPreferenceMemoryPath(projectDir), `${JSON.stringify(entryFixture({ project_id: "other" }))}\n`),
      (projectDir) => fs.writeFileSync(canonicalPreferenceMemoryPath(projectDir), `${JSON.stringify(entryFixture())}\n${JSON.stringify(entryFixture())}\n`),
      (projectDir) => fs.writeFileSync(canonicalPreferenceMemoryPath(projectDir), `${JSON.stringify(entryFixture({ supersedes_entry_id: "EPM_missing" }))}\n`),
    ];
    for (const arrange of cases) {
      const projectDir = makeProject();
      fs.mkdirSync(path.dirname(canonicalPreferenceMemoryPath(projectDir)), { recursive: true });
      arrange(projectDir);
      const before = fs.readdirSync(projectDir, { recursive: true }).map(String).sort();
      const ledgerBefore = memoryBytes(projectDir);
      expect(() => rememberEditorialPreference(rememberInput(projectDir))).toThrow();
      expect(memoryBytes(projectDir)).toEqual(ledgerBefore);
      expect(fs.readdirSync(projectDir, { recursive: true }).map(String).sort()).toEqual(before);
    }
  });

  it("preserves exact bytes and cleans owned lock/temp files on injected write, promote, and post-verify failures", () => {
    for (const mode of ["write", "promote", "post-verify"] as const) {
      const projectDir = makeProject();
      rememberEditorialPreference(rememberInput(projectDir, { actionId: `seed-${mode}` }));
      const before = memoryBytes(projectDir)!;
      const options = mode === "write"
        ? { fsOps: { writeFileSync: (() => { throw new Error("injected write failure"); }) as typeof fs.writeFileSync } }
        : mode === "promote"
          ? { fsOps: { beforePromote: () => { throw new Error("injected promote failure"); } } }
          : { fsOps: { renameSync: ((temporaryPath: fs.PathLike, canonicalPath: fs.PathLike) => {
              fs.writeFileSync(canonicalPath, "corrupt\n");
              fs.unlinkSync(temporaryPath);
            }) as typeof fs.renameSync } };
      expect(() => rememberEditorialPreference(rememberInput(projectDir, { actionId: `failure-${mode}` }), options)).toThrow();
      expect(memoryBytes(projectDir)).toEqual(before);
      expect(fs.readdirSync(path.dirname(canonicalPreferenceMemoryPath(projectDir))).filter((name) => /\.(lock|append-|rollback-)/.test(name))).toEqual([]);
    }
  });

  it("times out on a foreign bounded lock without changing it or the ledger", () => {
    const projectDir = makeProject();
    fs.mkdirSync(path.dirname(canonicalPreferenceMemoryPath(projectDir)), { recursive: true });
    const lockPath = `${canonicalPreferenceMemoryPath(projectDir)}.lock`;
    fs.writeFileSync(lockPath, "other-writer\n");
    expect(() => rememberEditorialPreference(rememberInput(projectDir), { lockTimeoutMs: 0 })).toThrow("lock timeout");
    expect(memoryBytes(projectDir)).toBeNull();
    expect(fs.readFileSync(lockPath, "utf-8")).toBe("other-writer\n");
  });

  it("cleans the descriptor-owned lock when lock initialization fails", () => {
    const projectDir = makeProject();
    const lockPath = `${canonicalPreferenceMemoryPath(projectDir)}.lock`;
    expect(() => rememberEditorialPreference(rememberInput(projectDir), {
      fsOps: { initializeLock: () => { throw new Error("injected lock initialization failure"); } },
    })).toThrow("lock initialization");
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(memoryBytes(projectDir)).toBeNull();
  });

  it("serializes concurrent explicit and project/Premiere-level writers without losing either line", async () => {
    const projectDir = makeProject();
    const moduleCode = "import { rememberEditorialPreference } from './runtime/artifacts/p3-preference-memory.ts'; import { appendConfirmedImportLesson } from './runtime/handoff/import/index.ts'; const payload=JSON.parse(process.env.ENTRY); if (process.env.MODE === 'explicit') rememberEditorialPreference(payload); else appendConfirmedImportLesson(payload.input, payload.report);";
    const explicit = rememberInput(projectDir, { actionId: "concurrent-explicit" });
    const premiere = {
      input: {
        manifestPath: "unused", importedOtioPath: "unused", profilePath: "unused", outputDir: "unused",
        confirmedPreferenceLesson: "preserve the confirmed trim", preferenceMemoryProjectDir: projectDir,
      },
      report: {
        project_id: "eye-writer", handoff_id: "HND_concurrent", imported_at: "2026-07-20T00:00:00.000Z",
        base_timeline: { version: "1", hash: `sha256:${"a".repeat(64)}` },
      },
    };
    await Promise.all([explicit, premiere].map((entry, index) => execFileAsync(process.execPath, [
      "--import", "tsx", "--input-type=module", "--eval", moduleCode,
    ], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        ENABLE_P3_CONTINUITY_PREFERENCE: "true",
        PROJECT_DIR: projectDir,
        ENTRY: JSON.stringify(entry),
        MODE: index === 0 ? "explicit" : "premiere",
      },
    })));
    const stored = entries(projectDir);
    expect(stored).toHaveLength(2);
    expect(stored.map((entry) => entry.entry_id)).toContain(stablePreferenceEntryId("concurrent-explicit"));
    expect(stored.find((entry) => entry.actor.type === "import_premiere")?.value).toEqual({
      kind: "string", data: "preserve the confirmed trim",
    });
  });

  it("implements append-only supersession, branch rejection, redaction, and missing/cross-type target rejection", () => {
    const projectDir = makeProject();
    const first = rememberEditorialPreference(rememberInput(projectDir, { actionId: "old" }));
    const second = rememberEditorialPreference(rememberInput(projectDir, {
      actionId: "new", value: { kind: "enum", data: "relaxed" }, supersedesEntryId: first.entry.entry_id,
    }));
    expect(entries(projectDir)).toHaveLength(2);
    expect(resolveActivePreference(entries(projectDir), "pacing").active?.entry_id).toBe(second.entry.entry_id);
    expect(() => rememberEditorialPreference(rememberInput(projectDir, {
      actionId: "branch", supersedesEntryId: first.entry.entry_id,
    }))).toThrow("active leaf");
    expect(() => rememberEditorialPreference(rememberInput(projectDir, {
      actionId: "missing", supersedesEntryId: "EPM_missing",
    }))).toThrow("missing");
    expect(() => rememberEditorialPreference(rememberInput(projectDir, {
      actionId: "cross", preferenceType: "transition_style", value: { kind: "enum", data: "cut" }, supersedesEntryId: second.entry.entry_id,
    }))).toThrow("cross-type");

    const redaction = redactEditorialPreference({
      projectDir, projectId: "eye-writer", actionId: "redact-new", actorId: "operator", targetEntryId: second.entry.entry_id, reason: "forget it",
    });
    expect(redaction.status).toBe("appended");
    expect(entries(projectDir)).toHaveLength(3);
    expect(resolveActivePreference(entries(projectDir), "pacing").active).toBeNull();
    expect(() => redactEditorialPreference({
      projectDir, projectId: "eye-writer", actionId: "redact-missing", actorId: "operator", targetEntryId: "EPM_missing", reason: "forget",
    })).toThrow("missing");
  });

  it("treats only authoritative successors as masks and fails closed on graph poison", () => {
    const old = entryFixture({ entry_id: "EPM_old" });
    for (const status of ["rejected", "expired"] as const) {
      const successor = entryFixture({ entry_id: `EPM_${status}`, status, supersedes_entry_id: old.entry_id });
      expect(resolveActivePreference([old, successor], "pacing").active?.entry_id).toBe(old.entry_id);
    }
    for (const status of ["active", "superseded", "redacted"] as const) {
      const successor = entryFixture({
        entry_id: `EPM_${status}`,
        status,
        supersedes_entry_id: old.entry_id,
        ...(status === "redacted" ? { preference_type: "redaction" as const } : {}),
      });
      expect(resolveActivePreference([old, successor], "pacing").active?.entry_id ?? null).toBe(status === "active" ? successor.entry_id : null);
    }
    const poisoned = [old, entryFixture({ entry_id: "EPM_bad", supersedes_entry_id: "EPM_missing" })];
    expect(validatePreferenceSupersessionGraph(poisoned)).not.toEqual([]);
    expect(resolveActivePreference(poisoned, "pacing")).toMatchObject({ active: null, conflicts: [] });

    const projectDir = makeProject();
    fs.mkdirSync(path.dirname(canonicalPreferenceMemoryPath(projectDir)), { recursive: true });
    fs.writeFileSync(canonicalPreferenceMemoryPath(projectDir), poisoned.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const blueprint = { version: "1", project_id: "eye-writer", beats: [{ id: "B01", label: "Opening" }] } as any;
    expect(preloadProjectPreferences(projectDir, "eye-writer")?.activeProjectPreferences).toEqual([]);
    expect(projectP3ContinuityPreferenceSignals(projectDir, blueprint)).toBe(false);
    expect(blueprint.beats[0].applied_preferences).toBeUndefined();
  });

  it("detects supersession branches, cycles, cross-type edges, and duplicate IDs", () => {
    const old = entryFixture({ entry_id: "EPM_old" });
    const branch = [
      old,
      entryFixture({ entry_id: "EPM_child_a", supersedes_entry_id: old.entry_id }),
      entryFixture({ entry_id: "EPM_child_b", supersedes_entry_id: old.entry_id }),
    ];
    expect(validatePreferenceSupersessionGraph(branch).join("\n")).toContain("branch");
    const cycleA = entryFixture({ entry_id: "EPM_cycle_a", supersedes_entry_id: "EPM_cycle_b" });
    const cycleB = entryFixture({ entry_id: "EPM_cycle_b", supersedes_entry_id: "EPM_cycle_a" });
    expect(validatePreferenceSupersessionGraph([cycleA, cycleB]).join("\n")).toContain("cycle");
    const crossType = entryFixture({ entry_id: "EPM_transition", preference_type: "transition_style", supersedes_entry_id: old.entry_id });
    expect(validatePreferenceSupersessionGraph([old, crossType]).join("\n")).toContain("cross-type");
    expect(validatePreferenceSupersessionGraph([old, old]).join("\n")).toContain("duplicate");
  });

  it("feeds only the superseding project value to the next intent/blueprint and none after redaction", () => {
    const previous = process.env.ENABLE_P3_CONTINUITY_PREFERENCE;
    process.env.ENABLE_P3_CONTINUITY_PREFERENCE = "true";
    try {
      const projectDir = makeProject();
      const old = rememberEditorialPreference(rememberInput(projectDir, { actionId: "consume-old" }));
      const latest = rememberEditorialPreference(rememberInput(projectDir, {
        actionId: "consume-new", value: { kind: "enum", data: "measured" }, supersedesEntryId: old.entry.entry_id,
      }));
      expect(preloadProjectPreferences(projectDir, "eye-writer")?.activeProjectPreferences.map((entry) => entry.entry_id)).toEqual([latest.entry.entry_id]);
      const blueprint = { version: "1.0.0", project_id: "eye-writer", beats: [{ id: "B01", label: "Opening" }] } as any;
      expect(projectP3ContinuityPreferenceSignals(projectDir, blueprint)).toBe(true);
      expect(blueprint.beats[0].applied_preferences.map((entry: any) => entry.entry_id)).toEqual([latest.entry.entry_id]);

      redactEditorialPreference({
        projectDir, projectId: "eye-writer", actionId: "consume-redact", actorId: "operator", targetEntryId: latest.entry.entry_id, reason: "remove",
      });
      expect(preloadProjectPreferences(projectDir, "eye-writer")?.activeProjectPreferences).toEqual([]);
      const after = { version: "1.0.0", project_id: "eye-writer", beats: [{ id: "B01", label: "Opening" }] } as any;
      expect(projectP3ContinuityPreferenceSignals(projectDir, after)).toBe(false);
      expect(after.beats[0].applied_preferences).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.ENABLE_P3_CONTINUITY_PREFERENCE;
      else process.env.ENABLE_P3_CONTINUITY_PREFERENCE = previous;
    }
  });

  it("keeps parse/help/invalid/read paths write-free and exposes truthful CLI exit codes", () => {
    const projectDir = makeProject();
    const before = memoryBytes(projectDir);
    expect(parseEditorialPreferenceMemoryArgs(["--help"])).toMatchObject({ command: "help" });
    expect(runEditorialPreferenceMemoryCli({ command: "help", json: true })).toHaveProperty("usage");
    expect(() => parseEditorialPreferenceMemoryArgs(["remember", "--project", projectDir])).toThrow();
    expect(preferenceCliMain(["remember", "--project", projectDir], { log() {}, error() {} })).toBe(2);
    preloadProjectPreferences(projectDir, "eye-writer");
    projectP3ContinuityPreferenceSignals(projectDir, { version: "1", project_id: "eye-writer", beats: [] } as any);
    expect(memoryBytes(projectDir)).toEqual(before);

    expect(preferenceCliMain(["migrate", "--project", projectDir, "--project-id", "eye-writer", "--json"], { log() {}, error() {} })).toBe(0);
    fs.mkdirSync(path.join(projectDir, "03_analysis"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, "03_analysis/editorial_preference_memory.jsonl"), "not-json\n");
    expect(preferenceCliMain(["migrate", "--project", projectDir, "--project-id", "eye-writer", "--json"], { log() {}, error() {} })).toBe(1);
  });

  it("returns nonzero CLI exits for migration conflict and remember/redact failures, but zero for idempotent retry", () => {
    const projectDir = makeProject();
    const common = [
      "remember", "--project", projectDir, "--project-id", "eye-writer", "--action-id", "cli-action",
      "--actor-id", "operator", "--source-event", "blueprint_acceptance", "--source", "04_plan/edit_blueprint.yaml",
      "--type", "pacing", "--kind", "enum", "--value", "tight", "--scope", "project", "--scope-ref", "eye-writer", "--json",
    ];
    const io = { log() {}, error() {} };
    expect(preferenceCliMain(common, io)).toBe(0);
    expect(preferenceCliMain(common, io)).toBe(0);
    const changed = [...common];
    changed[changed.indexOf("tight")] = "slow";
    expect(preferenceCliMain(changed, io)).toBe(2);
    expect(preferenceCliMain([
      "redact", "--project", projectDir, "--project-id", "eye-writer", "--action-id", "valid-redact",
      "--actor-id", "operator", "--target", stablePreferenceEntryId("cli-action"), "--reason", "forget", "--json",
    ], io)).toBe(0);
    expect(preferenceCliMain([
      "redact", "--project", projectDir, "--project-id", "eye-writer", "--action-id", "missing-redact",
      "--actor-id", "operator", "--target", "EPM_missing", "--reason", "forget", "--json",
    ], io)).toBe(2);

    const conflictProject = makeProject();
    fs.mkdirSync(path.join(conflictProject, "00_project"), { recursive: true });
    fs.mkdirSync(path.join(conflictProject, "03_analysis"), { recursive: true });
    fs.writeFileSync(canonicalPreferenceMemoryPath(conflictProject), `${JSON.stringify(entryFixture({ entry_id: "EPM_canonical" }))}\n`);
    fs.writeFileSync(path.join(conflictProject, "03_analysis/editorial_preference_memory.jsonl"), `${JSON.stringify(entryFixture({ entry_id: "EPM_legacy" }))}\n`);
    expect(preferenceCliMain(["migrate", "--project", conflictProject, "--project-id", "eye-writer", "--json"], io)).toBe(1);
  });

  it("derives stable, valid entry IDs from action IDs", () => {
    expect(stablePreferenceEntryId("same-action")).toBe(stablePreferenceEntryId("same-action"));
    expect(stablePreferenceEntryId("same-action")).toMatch(/^EPM_[a-f0-9]{24}$/);
  });
});
