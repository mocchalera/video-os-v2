import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import {
  appendPreferenceEntry,
  appendProjectPreferenceEntry,
  canonicalPreferenceMemoryPath,
  computePreferenceMemoryHash,
  EDITORIAL_PREFERENCE_MEMORY_CANONICAL_REL_PATH,
  EDITORIAL_PREFERENCE_MEMORY_LEGACY_REL_PATH,
  migrateLegacyPreferenceMemory,
  readPreferenceEntries,
  readResolvedPreferenceEntries,
  readPreferenceEntriesWithConsumedOffset,
  resolvePreferenceMemoryPath,
  resolveActivePreference,
} from "../runtime/artifacts/p3-preference-memory.js";
import { projectP3ContinuityPreferenceSignals } from "../runtime/commands/blueprint.js";
import { preloadProjectPreferences } from "../runtime/commands/intent.js";
import {
  appendConfirmedImportLesson,
  resolveHandoffPreferenceMemoryProjectDir,
} from "../runtime/handoff/import/index.js";

const require_ = createRequire(import.meta.url);
const Ajv2020 = require_("ajv/dist/2020") as new (opts: Record<string, unknown>) => {
  addSchema(schema: object): void;
  compile(schema: object): { (data: unknown): boolean; errors?: unknown[] | null };
};
const addFormats = require_("ajv-formats") as (ajv: unknown) => void;

const FIXTURE_DIR = path.resolve("tests/fixtures/editorial_preference_memory");
const SCHEMA_PATH = path.resolve("schemas/editorial-preference-memory-entry.schema.json");
const COMMON_SCHEMA_PATH = path.resolve("schemas/analysis-common.schema.json");

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function schemaValidator(): ReturnType<InstanceType<typeof Ajv2020>["compile"]> {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(readJson(COMMON_SCHEMA_PATH) as object);
  return ajv.compile(readJson(SCHEMA_PATH) as object);
}

function writeProjectPreference(projectDir: string, relativePath: string, raw: string): string {
  const filePath = path.join(projectDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, raw, "utf-8");
  return filePath;
}

function pacingFixture(overrides: Record<string, unknown> = {}): string {
  const entry = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, "valid_active_pacing.jsonl"), "utf-8")) as Record<string, unknown>;
  return `${JSON.stringify({ ...entry, ...overrides })}\n`;
}

function treeSnapshot(root: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  if (!fs.existsSync(root)) return snapshot;
  const visit = (dir: string) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const itemPath = path.join(dir, item.name);
      const relative = path.relative(root, itemPath);
      if (item.isDirectory()) visit(itemPath);
      else snapshot[relative] = fs.readFileSync(itemPath).toString("base64");
    }
  };
  visit(root);
  return snapshot;
}

describe("P3 editorial_preference_memory", () => {
  it("resolves absent, canonical, legacy-only, and both without writing or merging", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "p3-pref-resolver-"));
    const beforeAbsent = treeSnapshot(projectDir);
    expect(resolvePreferenceMemoryPath(projectDir)).toMatchObject({
      source: "absent",
      relativePath: EDITORIAL_PREFERENCE_MEMORY_CANONICAL_REL_PATH,
      canonicalExists: false,
      legacyExists: false,
    });
    expect(treeSnapshot(projectDir)).toEqual(beforeAbsent);

    const legacyRaw = pacingFixture({ entry_id: "EPM_legacy" });
    writeProjectPreference(projectDir, EDITORIAL_PREFERENCE_MEMORY_LEGACY_REL_PATH, legacyRaw);
    expect(resolvePreferenceMemoryPath(projectDir)).toMatchObject({ source: "legacy", legacyExists: true });
    expect(readResolvedPreferenceEntries(projectDir).entries.map((item) => item.entry.entry_id)).toEqual(["EPM_legacy"]);

    const canonicalRaw = pacingFixture({ entry_id: "EPM_canonical" });
    writeProjectPreference(projectDir, EDITORIAL_PREFERENCE_MEMORY_CANONICAL_REL_PATH, canonicalRaw);
    const beforeBoth = treeSnapshot(projectDir);
    expect(resolvePreferenceMemoryPath(projectDir)).toMatchObject({
      source: "canonical",
      canonicalExists: true,
      legacyExists: true,
    });
    expect(readResolvedPreferenceEntries(projectDir).entries.map((item) => item.entry.entry_id)).toEqual(["EPM_canonical"]);
    expect(treeSnapshot(projectDir)).toEqual(beforeBoth);
  });

  it("migrates valid legacy JSONL atomically and leaves the legacy bytes intact", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "p3-pref-migrate-"));
    const legacyRaw = `${pacingFixture().trim()}\n`;
    const legacyPath = writeProjectPreference(projectDir, EDITORIAL_PREFERENCE_MEMORY_LEGACY_REL_PATH, legacyRaw);

    const result = migrateLegacyPreferenceMemory(projectDir, "p3-fixture");

    expect(result.status).toBe("migrated");
    expect(fs.readFileSync(legacyPath, "utf-8")).toBe(legacyRaw);
    const canonicalRaw = fs.readFileSync(canonicalPreferenceMemoryPath(projectDir), "utf-8");
    expect(computePreferenceMemoryHash(canonicalRaw)).toBe(computePreferenceMemoryHash(pacingFixture()));
    expect(JSON.parse(canonicalRaw)).toEqual(JSON.parse(pacingFixture()));
    expect(fs.readdirSync(path.dirname(canonicalPreferenceMemoryPath(projectDir))).some((name) => name.includes(".migration-"))).toBe(false);
  });

  it("keeps migration idempotent for equal content and conflicts without changes for different content", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "p3-pref-migrate-existing-"));
    writeProjectPreference(projectDir, EDITORIAL_PREFERENCE_MEMORY_LEGACY_REL_PATH, pacingFixture());
    writeProjectPreference(projectDir, EDITORIAL_PREFERENCE_MEMORY_CANONICAL_REL_PATH, pacingFixture());
    const sameBefore = treeSnapshot(projectDir);
    expect(migrateLegacyPreferenceMemory(projectDir, "p3-fixture")).toMatchObject({ status: "noop", reason: "already_migrated" });
    expect(treeSnapshot(projectDir)).toEqual(sameBefore);

    writeProjectPreference(projectDir, EDITORIAL_PREFERENCE_MEMORY_CANONICAL_REL_PATH, pacingFixture({ entry_id: "EPM_different" }));
    const conflictBefore = treeSnapshot(projectDir);
    expect(migrateLegacyPreferenceMemory(projectDir, "p3-fixture")).toMatchObject({ status: "conflict", reason: "canonical_content_differs" });
    expect(treeSnapshot(projectDir)).toEqual(conflictBefore);
  });

  it.each([
    ["malformed", "invalid_malformed_line.jsonl", "malformed"],
    ["schema invalid", "invalid_missing_status.jsonl", "schema_invalid"],
  ])("rejects %s legacy migration without changing project state", (_label, fixture, reason) => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "p3-pref-migrate-reject-"));
    writeProjectPreference(projectDir, EDITORIAL_PREFERENCE_MEMORY_LEGACY_REL_PATH, fs.readFileSync(path.join(FIXTURE_DIR, fixture), "utf-8"));
    const before = treeSnapshot(projectDir);

    expect(migrateLegacyPreferenceMemory(projectDir, "p3-fixture")).toMatchObject({ status: "rejected", reason });
    expect(treeSnapshot(projectDir)).toEqual(before);
  });

  it("rejects cross-project migration and invalid canonical without a legacy file", () => {
    const crossProject = fs.mkdtempSync(path.join(os.tmpdir(), "p3-pref-cross-project-"));
    writeProjectPreference(crossProject, EDITORIAL_PREFERENCE_MEMORY_LEGACY_REL_PATH, pacingFixture());
    const crossBefore = treeSnapshot(crossProject);
    expect(migrateLegacyPreferenceMemory(crossProject, "another-project")).toMatchObject({ status: "rejected", reason: "project_mismatch" });
    expect(treeSnapshot(crossProject)).toEqual(crossBefore);

    const invalidCanonical = fs.mkdtempSync(path.join(os.tmpdir(), "p3-pref-invalid-canonical-"));
    writeProjectPreference(invalidCanonical, EDITORIAL_PREFERENCE_MEMORY_CANONICAL_REL_PATH, "not-json\n");
    const canonicalBefore = treeSnapshot(invalidCanonical);
    expect(migrateLegacyPreferenceMemory(invalidCanonical, "p3-fixture")).toMatchObject({ status: "rejected", reason: "malformed" });
    expect(treeSnapshot(invalidCanonical)).toEqual(canonicalBefore);
  });

  it("migrates an empty legacy file and cleans temporary files on promote failure or TOCTOU conflict", () => {
    const emptyProject = fs.mkdtempSync(path.join(os.tmpdir(), "p3-pref-empty-"));
    writeProjectPreference(emptyProject, EDITORIAL_PREFERENCE_MEMORY_LEGACY_REL_PATH, "");
    expect(migrateLegacyPreferenceMemory(emptyProject, "p3-fixture")).toMatchObject({ status: "migrated", entryCount: 0 });
    expect(fs.readFileSync(canonicalPreferenceMemoryPath(emptyProject), "utf-8")).toBe("");

    const failureProject = fs.mkdtempSync(path.join(os.tmpdir(), "p3-pref-promote-failure-"));
    writeProjectPreference(failureProject, EDITORIAL_PREFERENCE_MEMORY_LEGACY_REL_PATH, pacingFixture());
    expect(() => migrateLegacyPreferenceMemory(failureProject, "p3-fixture", {
      fsOps: { linkSync: () => { throw new Error("injected promote failure"); } },
    })).toThrow("injected promote failure");
    expect(fs.existsSync(canonicalPreferenceMemoryPath(failureProject))).toBe(false);
    expect(fs.readdirSync(path.dirname(canonicalPreferenceMemoryPath(failureProject))).some((name) => name.includes(".migration-"))).toBe(false);

    const raceProject = fs.mkdtempSync(path.join(os.tmpdir(), "p3-pref-race-"));
    writeProjectPreference(raceProject, EDITORIAL_PREFERENCE_MEMORY_LEGACY_REL_PATH, pacingFixture());
    expect(migrateLegacyPreferenceMemory(raceProject, "p3-fixture", {
      fsOps: { beforePromote: () => writeProjectPreference(raceProject, EDITORIAL_PREFERENCE_MEMORY_CANONICAL_REL_PATH, pacingFixture({ entry_id: "EPM_race" })) },
    })).toMatchObject({ status: "conflict" });
    expect(fs.readFileSync(canonicalPreferenceMemoryPath(raceProject), "utf-8")).toContain("EPM_race");
    expect(fs.readdirSync(path.dirname(canonicalPreferenceMemoryPath(raceProject))).some((name) => name.includes(".migration-"))).toBe(false);
  });

  it("handles atomic no-clobber EEXIST as same-content no-op or different-content conflict", () => {
    const sameProject = fs.mkdtempSync(path.join(os.tmpdir(), "p3-pref-link-eexist-same-"));
    writeProjectPreference(sameProject, EDITORIAL_PREFERENCE_MEMORY_LEGACY_REL_PATH, pacingFixture());
    const sameResult = migrateLegacyPreferenceMemory(sameProject, "p3-fixture", {
      fsOps: {
        linkSync: (temporaryPath, canonicalPath) => {
          fs.writeFileSync(canonicalPath, fs.readFileSync(temporaryPath));
          fs.linkSync(temporaryPath, canonicalPath);
        },
      },
    });
    expect(sameResult).toMatchObject({ status: "noop", reason: "already_migrated" });
    expect(computePreferenceMemoryHash(fs.readFileSync(canonicalPreferenceMemoryPath(sameProject), "utf-8"))).toBe(
      computePreferenceMemoryHash(pacingFixture()),
    );

    const differentProject = fs.mkdtempSync(path.join(os.tmpdir(), "p3-pref-link-eexist-different-"));
    writeProjectPreference(differentProject, EDITORIAL_PREFERENCE_MEMORY_LEGACY_REL_PATH, pacingFixture());
    const competingRaw = pacingFixture({ entry_id: "EPM_competing_writer" });
    const differentResult = migrateLegacyPreferenceMemory(differentProject, "p3-fixture", {
      fsOps: {
        linkSync: (temporaryPath, canonicalPath) => {
          fs.writeFileSync(canonicalPath, competingRaw);
          fs.linkSync(temporaryPath, canonicalPath);
        },
      },
    });
    expect(differentResult).toMatchObject({ status: "conflict", reason: "canonical_content_differs" });
    expect(fs.readFileSync(canonicalPreferenceMemoryPath(differentProject), "utf-8")).toBe(competingRaw);
    expect(fs.readdirSync(path.dirname(canonicalPreferenceMemoryPath(differentProject))).some((name) => name.includes(".migration-"))).toBe(false);
  });

  it("preserves lastKnownGoodOffset byte semantics with and without a final newline", () => {
    for (const hasFinalNewline of [false, true]) {
      const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "p3-pref-offset-"));
      const raw = pacingFixture().trimEnd() + (hasFinalNewline ? "\n" : "");
      writeProjectPreference(projectDir, EDITORIAL_PREFERENCE_MEMORY_CANONICAL_REL_PATH, raw);
      const generic = readPreferenceEntries(canonicalPreferenceMemoryPath(projectDir), { validateEntry: schemaValidator() });
      const resolved = readResolvedPreferenceEntries(projectDir, "p3-fixture");
      expect(resolved.lastKnownGoodOffset).toBe(Buffer.byteLength(raw, "utf-8"));
      expect(resolved.lastKnownGoodOffset).toBe(generic.lastKnownGoodOffset);
    }
  });

  it("keeps the Premiere import path field additive and rejects legacy or arbitrary write targets", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "p3-pref-handoff-"));
    const canonicalPath = canonicalPreferenceMemoryPath(projectDir);
    expect(resolveHandoffPreferenceMemoryProjectDir({ preferenceMemoryProjectDir: projectDir })).toBe(projectDir);
    expect(resolveHandoffPreferenceMemoryProjectDir({ preferenceMemoryPath: canonicalPath })).toBe(projectDir);
    expect(() => resolveHandoffPreferenceMemoryProjectDir({
      preferenceMemoryPath: path.join(projectDir, EDITORIAL_PREFERENCE_MEMORY_LEGACY_REL_PATH),
    })).toThrow("exact canonical");
    expect(() => resolveHandoffPreferenceMemoryProjectDir({ preferenceMemoryPath: path.join(projectDir, "memory.jsonl") })).toThrow("exact canonical");
  });

  it("refuses project and Premiere appends in legacy-only state without hiding legacy history", () => {
    const validate = schemaValidator();
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "p3-pref-legacy-append-"));
    const entry = readPreferenceEntries(path.join(FIXTURE_DIR, "valid_active_pacing.jsonl"), { validateEntry: validate }).entries[0].entry;
    writeProjectPreference(projectDir, EDITORIAL_PREFERENCE_MEMORY_LEGACY_REL_PATH, pacingFixture());
    const beforeProjectAppend = treeSnapshot(projectDir);
    expect(() => appendProjectPreferenceEntry(projectDir, entry, { validateEntry: validate })).toThrow("migration_required");
    expect(treeSnapshot(projectDir)).toEqual(beforeProjectAppend);

    const previousFlag = process.env.ENABLE_P3_CONTINUITY_PREFERENCE;
    process.env.ENABLE_P3_CONTINUITY_PREFERENCE = "true";
    try {
      expect(() => appendConfirmedImportLesson({
        manifestPath: "unused",
        importedOtioPath: "unused",
        profilePath: "unused",
        outputDir: "unused",
        confirmedPreferenceLesson: "preserve the manual trim",
        preferenceMemoryProjectDir: projectDir,
      }, {
        project_id: "p3-fixture",
        handoff_id: "HND_test",
        imported_at: "2026-04-26T00:00:00Z",
        base_timeline: { version: "TL_1", hash: `sha256:${"a".repeat(64)}` },
      } as any)).toThrow("migration_required");
    } finally {
      if (previousFlag === undefined) delete process.env.ENABLE_P3_CONTINUITY_PREFERENCE;
      else process.env.ENABLE_P3_CONTINUITY_PREFERENCE = previousFlag;
    }
    expect(treeSnapshot(projectDir)).toEqual(beforeProjectAppend);
  });

  it("creates canonical memory when absent and appends canonical when legacy also coexists", () => {
    const validate = schemaValidator();
    const entry = readPreferenceEntries(path.join(FIXTURE_DIR, "valid_active_pacing.jsonl"), { validateEntry: validate }).entries[0].entry;
    const absentProject = fs.mkdtempSync(path.join(os.tmpdir(), "p3-pref-append-absent-"));
    expect(appendProjectPreferenceEntry(absentProject, entry, { validateEntry: validate }).path).toBe(canonicalPreferenceMemoryPath(absentProject));

    const bothProject = fs.mkdtempSync(path.join(os.tmpdir(), "p3-pref-append-both-"));
    const canonicalRaw = pacingFixture({ entry_id: "EPM_existing" });
    const legacyRaw = pacingFixture({ entry_id: "EPM_legacy_history" });
    writeProjectPreference(bothProject, EDITORIAL_PREFERENCE_MEMORY_CANONICAL_REL_PATH, canonicalRaw);
    const legacyPath = writeProjectPreference(bothProject, EDITORIAL_PREFERENCE_MEMORY_LEGACY_REL_PATH, legacyRaw);
    appendProjectPreferenceEntry(bothProject, { ...entry, entry_id: "EPM_appended" }, { validateEntry: validate });
    expect(fs.readFileSync(canonicalPreferenceMemoryPath(bothProject), "utf-8")).toContain("EPM_appended");
    expect(fs.readFileSync(legacyPath, "utf-8")).toBe(legacyRaw);
  });
  it.each([
    "valid_active_pacing.jsonl",
    "valid_superseded_transition_style.jsonl",
    "valid_redaction_entry.jsonl",
  ])("accepts %s line-by-line", (fixture) => {
    const validate = schemaValidator();
    const result = readPreferenceEntries(path.join(FIXTURE_DIR, fixture), { validateEntry: validate });

    expect(result.malformedLines).toEqual([]);
    expect(result.entries.length).toBeGreaterThan(0);
    for (const item of result.entries) {
      expect(validate(item.entry), JSON.stringify(validate.errors, null, 2)).toBe(true);
      expect(item.lineNumber).toBeGreaterThan(0);
      expect(item.byteOffset).toBeGreaterThanOrEqual(0);
    }
  });

  it("keeps legacy entries compatible while validating optional scope_ref", () => {
    const validate = schemaValidator();
    const legacy = JSON.parse(pacingFixture()) as Record<string, unknown>;
    expect(validate(legacy)).toBe(true);
    expect(validate({ ...legacy, scope_ref: "p3-fixture" })).toBe(true);
    expect(validate({ ...legacy, scope_ref: "" })).toBe(false);
  });

  it("reports malformed JSON lines with last-known-good offset", () => {
    const result = readPreferenceEntries(path.join(FIXTURE_DIR, "invalid_malformed_line.jsonl"));

    expect(result.entries).toHaveLength(1);
    expect(result.malformedLines).toHaveLength(1);
    expect(result.malformedLines[0]).toMatchObject({ lineNumber: 2 });
    expect(result.lastKnownGoodOffset).toBeGreaterThan(result.entries[0].byteOffset);
  });

  it("rejects schema-invalid lines", () => {
    const validate = schemaValidator();
    const result = readPreferenceEntries(path.join(FIXTURE_DIR, "invalid_missing_status.jsonl"), { validateEntry: validate });

    expect(result.entries).toHaveLength(0);
    expect(result.malformedLines).toHaveLength(1);
    expect(result.malformedLines[0].error).toContain("schema");
  });

  it("returns unresolved blocker for conflicting active preferences without priority", () => {
    const validate = schemaValidator();
    const result = readPreferenceEntries(path.join(FIXTURE_DIR, "edge_conflicting_active_preferences.jsonl"), { validateEntry: validate });
    const resolved = resolveActivePreference(result.entries.map((item) => item.entry), "pacing");

    expect(resolved.active).toBeNull();
    expect(resolved.conflicts.map((entry) => entry.entry_id).sort()).toEqual(["EPM_pacing_fast", "EPM_pacing_slow"]);
    expect(resolved.errors).toContain("unresolved active preference conflict for pacing");
  });

  it("classifies malformed consumed ranges as errors before offset and warnings after offset", () => {
    const filePath = path.join(FIXTURE_DIR, "edge_consumed_range_malformed.jsonl");
    const raw = fs.readFileSync(filePath, "utf-8");
    const line2Offset = Buffer.byteLength(raw.split("\n")[0] + "\n", "utf-8");
    const line3Offset = line2Offset + Buffer.byteLength(raw.split("\n")[1] + "\n", "utf-8");

    const afterBadLine = readPreferenceEntriesWithConsumedOffset(filePath, line3Offset);
    expect(afterBadLine.errorsInConsumed).toHaveLength(1);
    expect(afterBadLine.warningsAfterConsumed).toHaveLength(0);

    const beforeBadLine = readPreferenceEntriesWithConsumedOffset(filePath, line2Offset);
    expect(beforeBadLine.errorsInConsumed).toHaveLength(0);
    expect(beforeBadLine.warningsAfterConsumed).toHaveLength(1);
  });

  it("resolves supersession chains and detects cycles", () => {
    const validate = schemaValidator();
    const result = readPreferenceEntries(path.join(FIXTURE_DIR, "valid_superseded_transition_style.jsonl"), { validateEntry: validate });
    const resolved = resolveActivePreference(result.entries.map((item) => item.entry), "transition_style");

    expect(resolved.active?.entry_id).toBe("EPM_transition_new");
    expect(resolved.errors).toEqual([]);

    const cycleEntries = result.entries.map((item) => item.entry);
    cycleEntries[0].supersedes_entry_id = "EPM_transition_new";
    const cycle = resolveActivePreference(cycleEntries, "transition_style");
    expect(cycle.errors.join("\n")).toContain("cycle");
  });

  it("appends validated JSONL entries without array wrapping", () => {
    const validate = schemaValidator();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p3-pref-"));
    const filePath = path.join(tmpDir, "editorial_preference_memory.jsonl");
    const entry = readPreferenceEntries(path.join(FIXTURE_DIR, "valid_active_pacing.jsonl"), { validateEntry: validate }).entries[0].entry;

    const metadata = appendPreferenceEntry(filePath, entry, { validateEntry: validate });
    appendPreferenceEntry(filePath, { ...entry, entry_id: "EPM_pacing_active_2" }, { validateEntry: validate });

    const raw = fs.readFileSync(filePath, "utf-8");
    expect(raw.startsWith("[")).toBe(false);
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.trim().split("\n")).toHaveLength(2);
    expect(metadata.consumedOffset).toBeGreaterThan(0);
    expect(metadata.consumedHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("keeps redaction as append-only status entry", () => {
    const validate = schemaValidator();
    const result = readPreferenceEntries(path.join(FIXTURE_DIR, "valid_redaction_entry.jsonl"), { validateEntry: validate });

    expect(result.entries[0].entry.status).toBe("redacted");
    expect(result.entries[0].entry.preference_type).toBe("redaction");
  });

  it("computes canonical jsonl-records-v1 hash with line order preserved", () => {
    const rawPath = path.join(FIXTURE_DIR, "valid_superseded_transition_style.jsonl");
    const hash = computePreferenceMemoryHash(fs.readFileSync(rawPath, "utf-8"));
    const reversed = fs.readFileSync(rawPath, "utf-8").trim().split("\n").reverse().join("\n") + "\n";

    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(hash).not.toBe(computePreferenceMemoryHash(reversed));
  });

  it("projects active preferences into first-class blueprint fields without notes wrappers", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p3-pref-first-class-"));
    fs.mkdirSync(path.join(tmpDir, "00_project"), { recursive: true });
    fs.copyFileSync(
      path.join(FIXTURE_DIR, "valid_active_pacing.jsonl"),
      path.join(tmpDir, "00_project/editorial_preference_memory.jsonl"),
    );
    const raw = fs.readFileSync(path.join(tmpDir, "00_project/editorial_preference_memory.jsonl"), "utf-8");
    const blueprint: any = {
      version: "1.0.0",
      project_id: "p3-fixture",
      sequence_goals: ["test"],
      beats: [{ id: "B01", label: "opening", target_duration_frames: 24, required_roles: ["hero"] }],
      pacing: { opening_cadence: "a", middle_cadence: "b", ending_cadence: "c" },
      music_policy: { start_sparse: true, allow_release_late: true, entry_beat: "B01" },
      dialogue_policy: { preserve_natural_breath: true, avoid_wall_to_wall_voiceover: true },
      transition_policy: { prefer_match_texture_over_flashy_fx: true },
      ending_policy: { should_feel: "resolved" },
      rejection_rules: ["none"],
    };

    expect(projectP3ContinuityPreferenceSignals(tmpDir, blueprint)).toBe(true);
    expect(blueprint.beats[0].applied_preferences).toEqual([
      expect.objectContaining({
        entry_id: "EPM_pacing_active",
        preference_type: "pacing",
        consumed_offset: Buffer.byteLength(raw, "utf-8"),
        consumed_hash: computePreferenceMemoryHash(raw),
      }),
    ]);
    expect(blueprint.beats[0].notes).toBeUndefined();
  });

  it("lets intent and blueprint read legacy-only memory, then gives canonical memory precedence", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "p3-pref-consumers-"));
    writeProjectPreference(projectDir, EDITORIAL_PREFERENCE_MEMORY_LEGACY_REL_PATH, pacingFixture({ entry_id: "EPM_legacy_consumer" }));
    const blueprint = {
      version: "1.0.0",
      project_id: "p3-fixture",
      beats: [{ id: "B01", label: "opening" }],
    } as any;

    expect(preloadProjectPreferences(projectDir, "p3-fixture")?.activeProjectPreferences.map((entry) => entry.entry_id)).toEqual(["EPM_legacy_consumer"]);
    expect(projectP3ContinuityPreferenceSignals(projectDir, blueprint)).toBe(true);
    expect(blueprint.beats[0].applied_preferences[0].entry_id).toBe("EPM_legacy_consumer");

    writeProjectPreference(projectDir, EDITORIAL_PREFERENCE_MEMORY_CANONICAL_REL_PATH, pacingFixture({ entry_id: "EPM_canonical_consumer" }));
    const canonicalBlueprint = { version: "1.0.0", project_id: "p3-fixture", beats: [{ id: "B01", label: "opening" }] } as any;
    expect(preloadProjectPreferences(projectDir, "p3-fixture")?.activeProjectPreferences.map((entry) => entry.entry_id)).toEqual(["EPM_canonical_consumer"]);
    expect(projectP3ContinuityPreferenceSignals(projectDir, canonicalBlueprint)).toBe(true);
    expect(canonicalBlueprint.beats[0].applied_preferences.map((entry: any) => entry.entry_id)).toEqual(["EPM_canonical_consumer"]);
  });

  it("does not authorize cross-project preference entries in intent or blueprint", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "p3-pref-poison-"));
    writeProjectPreference(projectDir, EDITORIAL_PREFERENCE_MEMORY_CANONICAL_REL_PATH, pacingFixture());
    const read = readResolvedPreferenceEntries(projectDir, "different-project");
    const blueprint = { version: "1.0.0", project_id: "different-project", beats: [{ id: "B01", label: "opening" }] } as any;

    expect(read.entries).toEqual([]);
    expect(read.malformedLines[0].error).toContain("does not match different-project");
    expect(preloadProjectPreferences(projectDir, "different-project")?.activeProjectPreferences).toEqual([]);
    expect(projectP3ContinuityPreferenceSignals(projectDir, blueprint)).toBe(false);
    expect(blueprint.beats[0].applied_preferences).toBeUndefined();
  });
});
